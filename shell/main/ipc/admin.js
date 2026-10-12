'use strict';
// Elevation (UAC) backend: runs allow-listed actions of the root helper
// /usr/lib/aurora/helpers/aurora-admin through sudo.
//
//   admin:needsPassword          -> bool  (false when sudo needs no password, e.g. the live user)
//   admin:status                 -> { isAdmin, needsPassword, live, user }
//   admin:run (password, action, args[])  -> { stdout }     errors: EAUTH (wrong password), ENOTADMIN (sudo
//                                    refuses this account), EINVAL (rejected arguments), ENOTFOUND, EPERM
//                                    (refused by policy), ECMD
//       Used through shell.runAdmin(action, args, { reason, appId }), which shows the UAC prompt.
//       Secrets: for user-add and set-password the LAST element of args is the new password; it is
//       sent to the helper on stdin (never on a command line) — see the helper's header.
//       apt-upgrade streams its progress: event admin:progress { action, line } to the calling window.
//   admin:securityStatus         -> { firewall: { available, enabled }, apparmor: { available, enabled },
//                                     autologin: user|null, uefi, secureBoot, tpm, hostname }   (no privileges needed)
//
// Actions (validated here AND in the helper): see ACTIONS below.
// Dev mode (--dev): nothing runs as root; actions are simulated against an in-memory system
// (exported as `dev`, shared with users.js and locale.js). The password "wrong" fails with EAUTH.
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { run, sudoRun, helperPath } = require('../lib/exec');

const RE = {
  user: /^[a-z_][a-z0-9_-]{0,31}$/,
  bool: /^[01]$/,
  fullName: /^[^\x00-\x1f\x7f:,=\\]{0,128}$/,
  hostname: /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/,
  timezone: /^[A-Za-z0-9_+-]+(\/[A-Za-z0-9_+-]+){0,2}$/,
  locale: /^(en_US|en_GB|fr_FR|fr_CA|fr_BE|fr_CH)\.UTF-8$/,
  layout: /^[a-z]{2,3}$/,
  variant: /^[a-z0-9_-]{0,32}$/,
  pid: /^[1-9][0-9]{0,9}$/,
  signal: /^(TERM|KILL|HUP|INT|QUIT|STOP|CONT|USR1|USR2)$/,
  unit: /^[A-Za-z0-9][A-Za-z0-9@._:-]{0,120}$/,
};
const oneOf = (...v) => new RegExp(`^(${v.join('|')})$`);

// action -> { args: [regex…], optional: n trailing optional args, secret: bool, timeout ms, stream }
const ACTIONS = {
  ping: { args: [] },
  'user-add': { args: [RE.user, RE.fullName, RE.bool], secret: true },
  'user-delete': { args: [RE.user, RE.bool] },
  'user-set-admin': { args: [RE.user, RE.bool] },
  'user-set-fullname': { args: [RE.user, RE.fullName] },
  'set-password': { args: [RE.user], secret: true },
  'set-hostname': { args: [RE.hostname] },
  'set-timezone': { args: [RE.timezone] },
  'set-ntp': { args: [RE.bool] },
  'set-locale': { args: [RE.locale] },
  'set-keyboard': { args: [RE.layout, RE.variant], optional: 1 },
  firewall: { args: [oneOf('enable', 'disable', 'status')] },
  'set-autologin': { args: [/^([a-z_][a-z0-9_-]{0,31}|none)$/] },
  'kill-process': { args: [RE.pid, RE.signal] },
  service: { args: [oneOf('start', 'stop', 'restart'), RE.unit] },
  'apt-check': { args: [], timeout: 15 * 60 * 1000 },
  'apt-upgrade': { args: [], timeout: 0, stream: true },
};

// ---- BEGIN disks (Disks app: renderer/apps/disks, main/ipc/disks.js) ----
// format-removable <whole removable disk> <vfat|exfat|ext4> <label>: one msdos partition + mkfs (helper re-checks
// that the disk is removable, not the system / live medium, and unmounts its partitions).
ACTIONS['format-removable'] = { args: [/^\/dev\/(sd[a-z]{1,2}|mmcblk[0-9]{1,2})$/, oneOf('vfat', 'exfat', 'ext4'), /^[A-Za-z0-9_ -]{0,16}$/], timeout: 15 * 60 * 1000 };
// ---- END disks ----

// ---- BEGIN drivers (Settings > Graphics drivers: renderer/apps/settings/pages/drivers.js, main/ipc/drivers.js) ----
// drivers-install <nvidia-driver-NNN[-open|-server|-server-open]> / drivers-remove: the helper re-checks the package
// against `ubuntu-drivers devices`; APT progress streamed (admin:progress). Dev: simulated in drivers.js (devRun).
ACTIONS['drivers-install'] = { args: [/^nvidia-driver-\d{3}(-open|-server|-server-open)?$/], timeout: 0, stream: true };
ACTIONS['drivers-remove'] = { args: [], timeout: 0, stream: true };
// ---- END drivers ----

function err(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/** Validate an action + args. Returns { spec, args, secret }. Throws EINVAL. (unit-tested) */
function validate(action, args) {
  const spec = Object.prototype.hasOwnProperty.call(ACTIONS, action) ? ACTIONS[action] : null;
  if (!spec) throw err(`Action not allowed: ${action}`, 'EINVAL');
  if (!Array.isArray(args)) args = [];
  args = args.map((a) => (typeof a === 'number' || typeof a === 'boolean' ? String(Number(a)) : a));
  let secret = null;
  if (spec.secret) {
    secret = args[args.length - 1];
    args = args.slice(0, -1);
    if (typeof secret !== 'string' || !secret.length) throw err('A password is required', 'EINVAL');
    if (/[\r\n\0]/.test(secret) || secret.length > 256) throw err('The password contains characters that are not allowed', 'EINVAL');
  }
  const min = spec.args.length - (spec.optional || 0);
  if (args.length < min || args.length > spec.args.length) throw err(`${action}: wrong number of arguments`, 'EINVAL');
  args.forEach((a, i) => {
    if (typeof a !== 'string' || !spec.args[i].test(a)) throw err(`${action}: invalid argument ${i + 1}`, 'EINVAL');
  });
  if (action === 'set-timezone' && /(^|\/)\.\.(\/|$)|^(posix|right)\//.test(args[0])) throw err('Invalid time zone', 'EINVAL');
  return { spec, args, secret };
}

/** Map a helper failure (exit code + stderr) to an error code. */
function helperError(e) {
  // The password was right but sudo refuses this account (not an administrator): asking again
  // for the password would never help, so this is not EAUTH (shell.runAdmin retries on EAUTH).
  if (/is not in the sudoers file|is not allowed to execute|may not run sudo/i.test(String(e.result?.stderr || ''))) {
    const out = err('This account is not allowed to make administrator changes', 'ENOTADMIN');
    out.result = e.result;
    return out;
  }
  if (e.code === 'EAUTH') return e;
  const code = e.result?.code;
  const msg = String(e.result?.stderr || e.message || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('aurora-admin:'))
    .pop();
  const out = err(msg ? msg.replace(/^aurora-admin:\s*/, '') : e.message, { 2: 'EINVAL', 3: 'ENOTFOUND', 4: 'EPERM', 5: 'ECMD' }[code] || 'ECMD');
  out.result = e.result;
  return out;
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** greetd config -> user of [initial_session] (automatic sign-in) or null (unit-tested) */
function parseGreetdAutologin(text) {
  let inInitial = false;
  for (const line of String(text || '').split('\n')) {
    const sec = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (sec) {
      inInitial = sec[1].trim() === 'initial_session';
      continue;
    }
    const m = inInitial && /^\s*user\s*=\s*"([^"]*)"/.exec(line);
    if (m) return m[1];
  }
  return null;
}

function groupMembers(name) {
  const g = (readText('/etc/group') || '').split('\n').find((l) => l.startsWith(`${name}:`));
  return g ? g.split(':')[3].split(',').filter(Boolean) : [];
}

// ------------------------------------------------------------------ dev simulation
// Shared in-memory "system" for dev mode (users.js and locale.js read it too).
const dev = {
  hostname: 'selene',
  timezone: 'Europe/Paris',
  ntp: true,
  locale: 'en_US.UTF-8',
  keyboard: { layout: 'us', variant: '' },
  firewall: false,
  autologin: null,
  users: null, // filled by users.js on first use
  passwords: {},
  upgradable: [
    ['firefox', '1:1esr', '131.0.2+build1-0ubuntu0.24.04.1', '131.0.3+build1-0ubuntu0.24.04.1', 'Ubuntu:24.04/noble-updates [amd64]'],
    ['libssl3t64', '', '3.0.13-0ubuntu3.3', '3.0.13-0ubuntu3.4', 'Ubuntu:24.04/noble-security [amd64]'],
    ['openssl', '', '3.0.13-0ubuntu3.3', '3.0.13-0ubuntu3.4', 'Ubuntu:24.04/noble-security [amd64]'],
    ['linux-firmware', '', '20240318.git3b128b60-0ubuntu2.3', '20240318.git3b128b60-0ubuntu2.4', 'Ubuntu:24.04/noble-updates [all]'],
    ['tzdata', '', '2024a-3ubuntu1.1', '2024b-0ubuntu0.24.04', 'Ubuntu:24.04/noble-updates [all]'],
  ],
  updated: false,
  listeners: new Set(),
  changed(what) {
    for (const fn of dev.listeners) {
      try {
        fn(what);
      } catch {}
    }
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ BEGIN store actions (Store app)
// store-install <pkg> / store-remove <pkg>: apt install/remove of a package listed in the root-owned
// catalog /usr/share/aurora/store/catalog.json (the helper checks the list; streams APT status lines).
// Dev: simulated against dev.storeState() (read by main/ipc/store.js); AURORA_STORE_DEV_FAIL=<pkg> makes it fail.
const STORE_PKG = /^[a-z0-9][a-z0-9+.-]{1,62}$/;
Object.assign(ACTIONS, {
  'store-install': { args: [STORE_PKG], timeout: 0, stream: true },
  'store-remove': { args: [STORE_PKG], timeout: 0, stream: true },
});
function storeCatalogFile() {
  const sys = '/usr/share/aurora/store/catalog.json';
  if (fs.existsSync(sys)) return sys;
  return require('path').join(__dirname, '..', '..', '..', 'rootfs', 'usr', 'share', 'aurora', 'store', 'catalog.json');
}
dev.storeState = () => {
  if (!dev.store) {
    dev.store = { installed: new Map([['git', '1:2.43.0-1ubuntu7.1'], ['curl', '8.5.0-2ubuntu10.4'], ['wget', '1.21.4-1ubuntu4.1'], ['rsync', '3.2.7-1ubuntu1'], ['unzip', '6.0-28ubuntu4']]) };
  }
  return dev.store;
};
async function devStoreRun(action, args, onLine) {
  const pkg = args[0];
  let items = [];
  try {
    items = (JSON.parse(fs.readFileSync(storeCatalogFile(), 'utf8')).items || []).filter((i) => i && typeof i === 'object');
  } catch {}
  let entry = items.find((i) => i.apt === pkg);
  // Like the helper's DEP-11 check: desktop applications of the Ubuntu catalogue (dev: its fixture) are accepted too.
  if (!entry) {
    let ubuntu = new Set();
    try {
      ubuntu = require('../lib/sources/ubuntu').devPackages();
    } catch {}
    if (ubuntu.has(pkg)) entry = { apt: pkg, removable: true };
  }
  if (!entry) throw err(`this package is not in the store catalog: ${pkg}`, 'EPERM');
  // Like the helper: tools shipped with Selene OS ("removable": false) cannot be removed from the Store.
  if (action === 'store-remove' && entry.removable === false) throw err(`${pkg} is part of Selene OS and cannot be removed from the Store`, 'EPERM');
  const st = dev.storeState();
  const emit = (l) => onLine?.(`${l}\n`);
  const install = action === 'store-install';
  if (install) {
    for (let i = 1; i <= 3; i++) {
      emit(`dlstatus:${i}:${((i / 3) * 100).toFixed(4)}:Retrieving file ${i} of 3`);
      await sleep(150);
    }
  }
  const steps = install ? ['Preparing', 'Unpacking', 'Configuring', 'Installed'] : ['Preparing for removal of', 'Removing', 'Removed'];
  for (let k = 0; k < steps.length; k++) {
    if (process.env.AURORA_STORE_DEV_FAIL === pkg && k === 1) throw err(`could not ${install ? 'install' : 'remove'} ${pkg} (see the system journal)`, 'ECMD');
    emit(`pmstatus:${pkg}:${(((k + 1) / steps.length) * 100).toFixed(4)}:${steps[k]} ${pkg}`);
    await sleep(150);
  }
  if (install) st.installed.set(pkg, '1.0.0-1ubuntu1');
  else st.installed.delete(pkg);
  dev.changed('store');
  return 'done\n';
}
dev.storeRun = devStoreRun; // main/lib/sources/ubuntu.js: simulated install / remove in dev
// ------------------------------------------------------------------ END store actions

async function devRun(action, args, secret, onLine) {
  if (action.startsWith('store-')) return devStoreRun(action, args, onLine); // store actions (Store app)
  if (action === 'format-removable') return require('./disks').devFormat(args); // disks (Disks app): simulated in disks.js
  if (action.startsWith('drivers-')) return require('./drivers').devRun(action, args, onLine); // graphics drivers: simulated in drivers.js
  const users = dev.users || [];
  const find = (n) => users.find((u) => u.name === n);
  const need = (n) => {
    const u = find(n);
    if (!u) throw err(`no such user account: ${n}`, 'ENOTFOUND');
    return u;
  };
  await sleep(action.startsWith('apt') ? 400 : 250);
  switch (action) {
    case 'ping':
      return 'pong\n';
    case 'user-add': {
      const [name, fullName, admin] = args;
      if (find(name)) throw err(`the user name ${name} is already in use`, 'EPERM');
      const uid = Math.max(1000, ...users.map((u) => u.uid)) + 1;
      users.push({ name, fullName: fullName || name, uid, admin: admin === '1', current: false, home: `/home/${name}` });
      dev.passwords[name] = secret;
      dev.changed('users');
      return `created ${name}\n`;
    }
    case 'user-delete': {
      const u = need(args[0]);
      if (u.current) throw err("you can't remove the account you are signed in with", 'EPERM');
      users.splice(users.indexOf(u), 1);
      if (dev.autologin === u.name) dev.autologin = null;
      dev.changed('users');
      return `removed ${u.name}\n`;
    }
    case 'user-set-admin': {
      const u = need(args[0]);
      if (args[1] === '0' && !users.some((x) => x !== u && x.admin)) throw err('at least one administrator account is required', 'EPERM');
      u.admin = args[1] === '1';
      dev.changed('users');
      return 'ok\n';
    }
    case 'user-set-fullname':
      need(args[0]).fullName = args[1];
      dev.changed('users');
      return 'ok\n';
    case 'set-password':
      need(args[0]);
      dev.passwords[args[0]] = secret;
      return 'ok\n';
    case 'set-hostname':
      dev.hostname = args[0];
      dev.changed('hostname');
      return 'ok\n';
    case 'set-timezone':
      dev.timezone = args[0];
      dev.changed('locale');
      return 'ok\n';
    case 'set-ntp':
      dev.ntp = args[0] === '1';
      dev.changed('locale');
      return 'ok\n';
    case 'set-locale':
      dev.locale = args[0];
      dev.changed('locale');
      return 'ok\n';
    case 'set-keyboard':
      dev.keyboard = { layout: args[0], variant: args[1] || '' };
      dev.changed('locale');
      return 'ok\n';
    case 'firewall':
      if (args[0] === 'status') return dev.firewall ? 'Status: active\nLogging: on (low)\nDefault: deny (incoming), allow (outgoing), disabled (routed)\n' : 'Status: inactive\n';
      dev.firewall = args[0] === 'enable';
      dev.changed('security');
      return dev.firewall ? 'Firewall is active and enabled on system startup\n' : 'Firewall stopped and disabled on system startup\n';
    case 'set-autologin':
      if (args[0] !== 'none') need(args[0]);
      dev.autologin = args[0] === 'none' ? null : args[0];
      dev.changed('security');
      return 'ok\n';
    case 'kill-process':
      return 'ok\n';
    case 'service':
      return 'ok\n';
    case 'apt-check':
      await sleep(1600);
      dev.aptListsFetched = true; // package lists downloaded (drivers.js: ubuntu-drivers now lists the NVIDIA drivers)
      if (dev.updated) return '';
      return `${dev.upgradable.map(([n, epoch, from, to, origin]) => `Inst ${n} [${epoch ? `${epoch}:` : ''}${from}] (${to} ${origin})`).join('\n')}\n`;
    case 'apt-upgrade': {
      const pkgs = dev.updated ? [] : dev.upgradable.map((p) => p[0]);
      const emit = (l) => onLine?.(`${l}\n`);
      for (let i = 0; i < pkgs.length; i++) {
        emit(`dlstatus:${i + 1}:${(((i + 1) / pkgs.length) * 100).toFixed(4)}:Retrieving file ${i + 1} of ${pkgs.length}`);
        await sleep(220);
      }
      const steps = ['Preparing', 'Unpacking', 'Preparing to configure', 'Configuring', 'Installed'];
      let k = 0;
      for (const p of pkgs) {
        for (const s of steps) {
          k++;
          emit(`pmstatus:${p}:${((k / (pkgs.length * steps.length)) * 100).toFixed(4)}:${s} ${p}`);
          await sleep(90);
        }
      }
      dev.updated = true;
      return 'done\n';
    }
    default:
      throw err(`Action not allowed: ${action}`, 'EINVAL');
  }
}

// ------------------------------------------------------------------ registration
function register(api) {
  const useMock = api.DEV && process.env.AURORA_REAL_BACKENDS !== '1';
  const live = !!api.env?.live;

  async function needsPassword() {
    if (useMock) return process.env.AURORA_DEV_NOPASSWD !== '1';
    if (process.getuid?.() === 0) return false;
    // -k ignores cached credentials: exit 0 only when sudo needs no password at all (NOPASSWD).
    const r = await run('sudo', ['-n', '-k', 'true'], { timeout: 5000 }).catch(() => ({ code: 1 }));
    return r.code !== 0;
  }

  function isAdmin() {
    if (useMock) return (dev.users || []).find((u) => u.current)?.admin ?? true;
    if (process.getuid?.() === 0) return true;
    const me = os.userInfo().username;
    return ['sudo', 'admin', 'wheel'].some((g) => groupMembers(g).includes(me));
  }

  api.handle('admin:needsPassword', needsPassword);
  api.handle('admin:status', async () => ({
    isAdmin: isAdmin(),
    needsPassword: await needsPassword(),
    live,
    user: useMock ? (dev.users || []).find((u) => u.current)?.name || os.userInfo().username : os.userInfo().username,
    simulated: useMock,
  }));

  api.handle('admin:run', async (password, action, args, event) => {
    // The renderer may omit args: event then arrives in its place.
    if (args && !Array.isArray(args) && args.sender) {
      event = args;
      args = [];
    }
    const { spec, args: clean, secret } = validate(String(action), args || []);
    const onLine = spec.stream
      ? (() => {
          let buf = '';
          return (chunk) => {
            buf += chunk;
            let i;
            while ((i = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, i);
              buf = buf.slice(i + 1);
              if (line) api.sendTo(event?.sender, 'admin:progress', { action, line });
            }
          };
        })()
      : null;
    if (useMock) {
      // Simulation: any password works except "wrong" (lets tests exercise the retry path); a
      // standard (non-administrator) current user is refused like sudo refuses it.
      if (password === 'wrong') throw err('Authentication failed', 'EAUTH');
      if (!isAdmin()) throw err('This account is not allowed to make administrator changes', 'ENOTADMIN');
      const stdout = await devRun(action, clean, secret, onLine);
      return { stdout };
    }
    const argv = [action, ...clean];
    let input = '';
    if (secret != null) {
      const nonce = crypto.randomBytes(16).toString('hex');
      argv.push(nonce);
      input = `${nonce}:${Buffer.from(secret, 'utf8').toString('base64')}\n`;
    }
    try {
      const res = await sudoRun(String(password ?? ''), helperPath('aurora-admin'), argv, {
        input,
        timeout: spec.timeout === 0 ? undefined : spec.timeout || 120000,
        onStdout: onLine || undefined,
      });
      return { stdout: res.stdout };
    } catch (e) {
      throw helperError(e);
    }
  });

  api.handle('admin:securityStatus', async () => {
    if (useMock) {
      return { firewall: { available: true, enabled: dev.firewall }, apparmor: { available: true, enabled: true }, autologin: dev.autologin, uefi: true, secureBoot: false, tpm: false, hostname: dev.hostname, simulated: true };
    }
    const ufwConf = readText('/etc/ufw/ufw.conf');
    const aa = (readText('/sys/module/apparmor/parameters/enabled') || '').trim();
    let secureBoot = null;
    try {
      const dir = '/sys/firmware/efi/efivars';
      const f = fs.readdirSync(dir).find((n) => n.startsWith('SecureBoot-'));
      if (f) secureBoot = fs.readFileSync(`${dir}/${f}`).at(-1) === 1;
    } catch {}
    return {
      firewall: { available: !!ufwConf || fs.existsSync('/usr/sbin/ufw'), enabled: /^\s*ENABLED\s*=\s*yes/m.test(ufwConf || '') },
      apparmor: { available: aa !== '', enabled: aa === 'Y' },
      autologin: parseGreetdAutologin(readText('/etc/greetd/config.toml')),
      uefi: fs.existsSync('/sys/firmware/efi'),
      secureBoot,
      tpm: fs.existsSync('/sys/class/tpm/tpm0'),
      hostname: os.hostname(),
    };
  });

  // Dev: keep the simulated system in sync with the windows (e.g. Settings refreshes on a change).
  if (useMock) dev.listeners.add((what) => api.broadcast('admin:devChanged', { what }));
}

module.exports = register;
module.exports.dev = dev;
module.exports.parsers = { validate, parseGreetdAutologin, helperError, ACTIONS };
