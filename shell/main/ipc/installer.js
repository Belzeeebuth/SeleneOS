'use strict';
// Installer backend (live session): disks, keyboard layouts, time zones and the installation itself.
// The installation runs the root helper /usr/lib/aurora/helpers/aurora-install through `sudo -n`
// (casper gives the live user passwordless sudo: /etc/sudoers.d/casper). The account password is
// written to the helper's stdin (--password-stdin), never on a command line.
//
//   installer:status               -> { live, dev, dryRun, minSize, running, finished, helper }
//   installer:disks                -> [{ path, name, model, vendor, size, transport, removable, tooSmall,
//                                        partitions: [{ path, size, fstype, label, mountpoints }] }]
//                                     whole disks only: no live medium, loop, zram, sr, read-only or in-use disk
//   installer:keyboards            -> [{ id: 'fr(oss)', layout: 'fr', variant: 'oss', name: { en, fr } }]
//   installer:timezones            -> ['Africa/Abidjan', …, 'UTC']
//   installer:applyKeyboard (id)   -> true when the layout was applied to the live X session (setxkbmap)
//   installer:gpu                  -> { gpus, nvidia, current, available, recommended, online, secureBoot }
//                                     graphics cards (lspci -nn -mm, main/lib/gpu-drivers.js); for an NVIDIA card the
//                                     NVIDIA drivers the archive offers (`ubuntu-drivers devices`: empty while the live
//                                     system has no package lists, the helper then picks the recommended one itself),
//                                     whether the computer is online (NetworkManager) and the Secure Boot state.
//                                     No root needed. Dev: AURORA_GPU_FIXTURE=<test/fixtures/gpu/NAME> (default: no
//                                     graphics card offered a driver), AURORA_GPU_ONLINE=0 (offline).
//   installer:start (opts)         -> { dryRun }   opts: { disk, user, fullname, password, hostname, lang,
//                                                          keyboard, timezone, autologin, nvidiaDriver, gaming }
//                                     nvidiaDriver: 'nvidia-driver-NNN[-open|-server|-server-open]' or 'recommended'
//                                     (downloaded from the Ubuntu archive during the installation; optional)
//                                     gaming: Flathub ids from GAMING_APPS (optional; nothing is downloaded during the
//                                     installation: the helper writes <home>/.config/aurora/first-login/gaming.json and
//                                     the session installs them per user at the first sign-in)
//       events 'installer:progress' (to the window that started it):
//         { type: 'progress', stage, progress, message }   stage: partition|format|copy|configure|drivers|bootloader|
//                                                                 cleanup|done
//         { type: 'driver', status: 'installed'|'failed', pkg, message }   (graphics driver; never an error)
//         { type: 'gaming', status: 'saved'|'failed', apps, message }      (gaming apps request; never an error)
//         { type: 'log', line }      { type: 'error', message, stage, code }      { type: 'done' }
//                                    code: EAUTH (sudo wants a password), ENOTADMIN (sudo refuses this account), exit code
//         { type: 'exit', code, cancelled }
//   installer:cancel               -> true when a running installation was signalled (SIGTERM; the helper cleans up)
//   installer:log                  -> last lines of the installation log (string)
//   installer:reboot               -> { simulated }   restarts the computer (systemctl reboot)
//
// Outside the live session, and always in --dev mode, the helper runs with --dry-run (it only simulates
// the stages: nothing is written) and the disk list is simulated (AURORA_REAL_BACKENDS=1: real lsblk).
// Test hooks (dev only): AURORA_INSTALLER_DRYRUN_DELAY=<seconds per step>, AURORA_INSTALLER_FAIL_AT=<stage>
// (or 'notadmin': sudo refuses the account, as for a standard user; error code ENOTADMIN).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { run, which, helperPath } = require('../lib/exec');
const gpu = require('../lib/gpu-drivers');

const MIN_SIZE = 12e9; // bytes, same as the helper
const HELPER = 'aurora-install';
const STAGES = ['partition', 'format', 'copy', 'configure', 'drivers', 'bootloader', 'cleanup', 'done'];
const GPU_FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures', 'gpu');
const RE = {
  disk: /^\/dev\/[A-Za-z0-9/_.:-]+$/,
  user: /^[a-z_][a-z0-9_-]{0,31}$/,
  fullName: /^[^\x00-\x1f\x7f:,=\\]{0,128}$/,
  hostname: /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/,
  keyboard: /^[a-z]{2,3}(\([a-z0-9_-]{1,32}\))?$/,
  timezone: /^[A-Za-z0-9_+-]+(\/[A-Za-z0-9_+-]+){0,2}$/,
};
// Names the helper refuses (system accounts); the UI checks them as you type.
const RESERVED_USERS = new Set(
  ('root daemon bin sys sync games man lp mail news uucp proxy www-data backup list irc gnats nobody systemd-network ' +
    'systemd-resolve systemd-timesync systemd-coredump messagebus syslog _apt tss uuidd tcpdump sshd polkitd _greetd ' +
    'greeter aurora-greeter admin sudo adm users wheel staff operator ubuntu').split(' '),
);
// Gaming apps the installer may ask the first sign-in to install (Flathub, per user): the « Jeux » step. The helper
// accepts exactly these ids (--gaming), nothing else.
const GAMING_APPS = Object.freeze(['com.valvesoftware.Steam', 'com.heroicgameslauncher.hgl', 'net.lutris.Lutris', 'net.davidotek.pupgui2', 'com.usebottles.bottles', 'com.discordapp.Discord']);
// Mount points that mark a disk as the running system or the live medium (never offered).
const SYSTEM_MOUNTS = new Set(['/', '/cdrom', '/rofs', '/isodevice', '/run/live/medium', '/media/cdrom', '/run/initramfs/live', '/boot', '/boot/efi', '/usr', '/home', '/var']);

const KEYBOARDS = [
  ['us', 'English (US)', 'Anglais (États-Unis)'],
  ['us(intl)', 'English (US, international with dead keys)', 'Anglais (États-Unis, international avec touches mortes)'],
  ['gb', 'English (UK)', 'Anglais (Royaume-Uni)'],
  ['fr', 'French (AZERTY)', 'Français (AZERTY)'],
  ['fr(oss)', 'French (alternative)', 'Français (variante)'],
  ['fr(afnor)', 'French (AZERTY, AFNOR)', 'Français (AZERTY, AFNOR)'],
  ['fr(bepo)', 'French (BÉPO)', 'Français (BÉPO)'],
  ['fr(mac)', 'French (Macintosh)', 'Français (Macintosh)'],
  ['be', 'Belgian', 'Belge'],
  ['ch(fr)', 'French (Switzerland)', 'Français (Suisse)'],
  ['ch', 'German (Switzerland)', 'Allemand (Suisse)'],
  ['ca(fr)', 'French (Canada)', 'Français (Canada)'],
  ['ca(multix)', 'Canadian (multilingual)', 'Canadien (multilingue)'],
  ['de', 'German', 'Allemand'],
  ['es', 'Spanish', 'Espagnol'],
  ['latam', 'Spanish (Latin American)', 'Espagnol (Amérique latine)'],
  ['it', 'Italian', 'Italien'],
  ['pt', 'Portuguese', 'Portugais'],
  ['br', 'Portuguese (Brazil)', 'Portugais (Brésil)'],
  ['nl', 'Dutch', 'Néerlandais'],
  ['us(dvorak)', 'English (Dvorak)', 'Anglais (Dvorak)'],
].map(([id, en, fr]) => {
  const m = /^([a-z]+)(?:\(([^)]+)\))?$/.exec(id);
  return { id, layout: m[1], variant: m[2] || '', name: { en, fr } };
});

// Simulated disks (dev mode): an empty VM disk, a laptop SSD with Windows, a USB stick that is too small.
const MOCK_DISKS = [
  { path: '/dev/vda', name: 'vda', model: 'QEMU HARDDISK', vendor: '', size: 34359738368, transport: 'virtio', removable: false, partitions: [] },
  {
    path: '/dev/nvme0n1', name: 'nvme0n1', model: 'Samsung SSD 980 PRO 512GB', vendor: '', size: 512110190592, transport: 'nvme', removable: false,
    partitions: [
      { path: '/dev/nvme0n1p1', size: 104857600, fstype: 'vfat', label: 'SYSTEM', mountpoints: [] },
      { path: '/dev/nvme0n1p2', size: 16777216, fstype: '', label: '', mountpoints: [] },
      { path: '/dev/nvme0n1p3', size: 510942756864, fstype: 'ntfs', label: 'Windows', mountpoints: [] },
      { path: '/dev/nvme0n1p4', size: 1046478848, fstype: 'ntfs', label: 'Recovery', mountpoints: [] },
    ],
  },
  { path: '/dev/sdb', name: 'sdb', model: 'SanDisk Ultra', vendor: 'SanDisk', size: 8004304896, transport: 'usb', removable: true, partitions: [{ path: '/dev/sdb1', size: 8003256320, fstype: 'exfat', label: 'USB', mountpoints: [] }] },
];

const bool = (v) => v === true || v === 1 || v === '1' || v === 'true';
const clean = (s) => String(s ?? '').trim();

/** lsblk -J -b -p output -> installable disks (unit-tested). opts: { minSize } */
function parseLsblk(json, { minSize = MIN_SIZE } = {}) {
  let data;
  try {
    data = typeof json === 'string' ? JSON.parse(json) : json;
  } catch {
    return [];
  }
  const out = [];
  const mountsOf = (d) => (Array.isArray(d.mountpoints) ? d.mountpoints : [d.mountpoint]).filter((m) => typeof m === 'string' && m);
  const walk = (d, acc = []) => {
    acc.push(d);
    for (const c of d.children || []) walk(c, acc);
    return acc;
  };
  for (const d of data?.blockdevices || []) {
    const name = path.basename(String(d.name || d.kname || ''));
    if (d.type !== 'disk') continue;
    if (/^(loop|zram|sr|ram|fd|md|dm-)/.test(name)) continue;
    if (bool(d.ro)) continue;
    const size = Number(d.size) || 0;
    if (size <= 0) continue;
    const all = walk(d);
    // The running system or the live medium lives on this disk: never offer it.
    if (all.some((n) => mountsOf(n).some((m) => SYSTEM_MOUNTS.has(m) || m.startsWith('/rofs') || m.startsWith('/cdrom')))) continue;
    if (all.some((n) => n.type === 'rom' || (n.fstype === 'iso9660' && mountsOf(n).length))) continue;
    // Members of LVM/RAID/encrypted volumes are in use.
    if (all.some((n) => ['lvm', 'crypt', 'raid0', 'raid1', 'raid5', 'raid6', 'raid10', 'md'].includes(n.type))) continue;
    out.push({
      path: d.path || `/dev/${name}`,
      name,
      model: clean(d.model) || clean(d.vendor) || '',
      vendor: clean(d.vendor),
      size,
      transport: clean(d.tran),
      removable: bool(d.rm) || bool(d.hotplug),
      tooSmall: size < minSize,
      partitions: (d.children || [])
        .filter((c) => c.type === 'part')
        .map((c) => ({ path: c.path || `/dev/${path.basename(String(c.name))}`, size: Number(c.size) || 0, fstype: clean(c.fstype), label: clean(c.label || c.partlabel), mountpoints: mountsOf(c) })),
    });
  }
  return out;
}

/** zone1970.tab / zone.tab text -> sorted unique zone names + UTC (unit-tested) */
function parseZoneTab(text) {
  const set = new Set();
  for (const line of String(text || '').split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const z = line.split('\t')[2];
    if (z && RE.timezone.test(z)) set.add(z);
  }
  set.add('UTC');
  return [...set].sort();
}

const FALLBACK_ZONES = [
  'Africa/Abidjan', 'Africa/Algiers', 'Africa/Cairo', 'Africa/Casablanca', 'Africa/Dakar', 'Africa/Johannesburg', 'Africa/Lagos', 'Africa/Nairobi', 'Africa/Tunis',
  'America/Anchorage', 'America/Argentina/Buenos_Aires', 'America/Bogota', 'America/Chicago', 'America/Denver', 'America/Halifax', 'America/Los_Angeles',
  'America/Mexico_City', 'America/Montreal', 'America/New_York', 'America/Phoenix', 'America/Sao_Paulo', 'America/Toronto', 'America/Vancouver',
  'Asia/Bangkok', 'Asia/Dubai', 'Asia/Hong_Kong', 'Asia/Jakarta', 'Asia/Kolkata', 'Asia/Seoul', 'Asia/Shanghai', 'Asia/Singapore', 'Asia/Tokyo',
  'Atlantic/Reykjavik', 'Australia/Melbourne', 'Australia/Perth', 'Australia/Sydney', 'Europe/Amsterdam', 'Europe/Athens', 'Europe/Berlin', 'Europe/Brussels',
  'Europe/Dublin', 'Europe/Helsinki', 'Europe/Istanbul', 'Europe/Lisbon', 'Europe/London', 'Europe/Luxembourg', 'Europe/Madrid', 'Europe/Monaco', 'Europe/Moscow',
  'Europe/Oslo', 'Europe/Paris', 'Europe/Prague', 'Europe/Rome', 'Europe/Stockholm', 'Europe/Vienna', 'Europe/Warsaw', 'Europe/Zurich', 'Indian/Reunion',
  'Pacific/Auckland', 'Pacific/Honolulu', 'Pacific/Noumea', 'Pacific/Tahiti', 'America/Guadeloupe', 'America/Martinique', 'America/Cayenne', 'UTC',
].sort();

/** Validate installer:start options -> helper argv (without the password). Throws EINVAL. (unit-tested) */
function buildArgs(opts, { dryRun = false, delay, failAt } = {}) {
  const o = opts || {};
  const bad = (field) => {
    const e = new Error(`Invalid ${field}`);
    e.code = 'EINVAL';
    e.field = field;
    throw e;
  };
  const disk = String(o.disk || '');
  if (!RE.disk.test(disk) || disk.includes('..')) bad('disk');
  const user = String(o.user || '');
  if (!RE.user.test(user) || RESERVED_USERS.has(user)) bad('user');
  const fullname = String(o.fullname ?? '').trim();
  if (!RE.fullName.test(fullname)) bad('fullname');
  const hostname = String(o.hostname || `${user}-pc`);
  if (!RE.hostname.test(hostname)) bad('hostname');
  const lang = o.lang === 'fr' ? 'fr' : o.lang === 'en' || o.lang == null ? 'en' : bad('lang');
  const keyboard = String(o.keyboard || (lang === 'fr' ? 'fr' : 'us'));
  if (!RE.keyboard.test(keyboard)) bad('keyboard');
  const timezone = String(o.timezone || 'UTC');
  if (!RE.timezone.test(timezone) || timezone.includes('..')) bad('timezone');
  const password = o.password;
  if (typeof password !== 'string' || !password.length || password.length > 256 || /[\x00-\x1f\x7f]/.test(password)) bad('password');
  const args = ['--json', '--password-stdin', '--disk', disk, '--user', user, '--fullname', fullname, '--hostname', hostname, '--lang', lang, '--keyboard', keyboard, '--timezone', timezone];
  if (bool(o.autologin)) args.push('--autologin');
  if (o.nvidiaDriver != null && o.nvidiaDriver !== false && o.nvidiaDriver !== '') {
    const drv = String(o.nvidiaDriver);
    if (drv !== 'recommended' && !gpu.validDriverPkg(drv)) bad('nvidiaDriver');
    args.push('--nvidia-driver', drv);
  }
  if (o.gaming != null && o.gaming !== false && o.gaming !== '') {
    // An array of ids (or 'id,id'); each one must be in the allow-list. Duplicates are dropped, catalog order kept.
    const list = Array.isArray(o.gaming) ? o.gaming : typeof o.gaming === 'string' ? o.gaming.split(',') : bad('gaming');
    if (list.length > GAMING_APPS.length * 2 || !list.every((id) => typeof id === 'string' && GAMING_APPS.includes(id))) bad('gaming');
    const ids = GAMING_APPS.filter((id) => list.includes(id));
    if (ids.length) args.push('--gaming', ids.join(','));
  }
  if (dryRun) {
    args.push('--dry-run');
    if (delay != null && /^[0-9]{1,2}(\.[0-9]{1,3})?$/.test(String(delay))) args.push('--dry-run-delay', String(delay));
  }
  if (failAt && STAGES.includes(failAt) && failAt !== 'done') args.push('--fail-at', failAt);
  return args;
}

/** Split a stream into lines (keeps a partial trailing line). */
function lineSplitter(onLine) {
  let buf = '';
  return {
    push(chunk) {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        onLine(line);
      }
    },
    flush() {
      if (buf) onLine(buf);
      buf = '';
    },
  };
}

function register(api) {
  const DEV = !!api.DEV;
  const live = !!api.env?.live;
  const dryRun = DEV || !live;
  const useMockDisks = DEV && process.env.AURORA_REAL_BACKENDS !== '1';
  const LOG_MAX = 2000;
  let job = null; // { child, sender, cancelled }
  let finished = false;
  const logLines = [];
  const pushLog = (line) => {
    logLines.push(line);
    if (logLines.length > LOG_MAX) logLines.splice(0, logLines.length - LOG_MAX);
  };

  api.handle('installer:status', () => ({
    live,
    dev: DEV,
    dryRun,
    minSize: MIN_SIZE,
    running: !!job,
    finished,
    helper: dryRun ? helperPath(HELPER) : path.join('/usr/lib/aurora/helpers', HELPER),
  }));

  api.handle('installer:disks', async () => {
    if (useMockDisks) return MOCK_DISKS.map((d) => ({ ...d, tooSmall: d.size < MIN_SIZE, partitions: d.partitions.map((p) => ({ ...p })) }));
    const r = await run('lsblk', ['-J', '-b', '-p', '-o', 'NAME,KNAME,PATH,TYPE,SIZE,MODEL,VENDOR,TRAN,RM,RO,HOTPLUG,FSTYPE,LABEL,PARTLABEL,MOUNTPOINTS'], { timeout: 10000 }).catch(
      (e) => ({ code: 1, stdout: '', stderr: e.message }),
    );
    if (r.code !== 0) throw api.error(`lsblk failed: ${r.stderr.trim()}`, 'ECMD');
    return parseLsblk(r.stdout);
  });

  api.handle('installer:keyboards', () => KEYBOARDS.map((k) => ({ ...k, name: { ...k.name } })));

  api.handle('installer:timezones', async () => {
    for (const f of ['/usr/share/zoneinfo/zone1970.tab', '/usr/share/zoneinfo/zone.tab']) {
      try {
        const zones = parseZoneTab(await fs.promises.readFile(f, 'utf8'));
        if (zones.length > 10) return zones;
      } catch {}
    }
    return FALLBACK_ZONES;
  });

  // ---- graphics card + NVIDIA driver offer (no root; cached for the session, `refresh` probes again)
  let gpuCache = null;
  const readText = (f) => fs.promises.readFile(f, 'utf8').catch(() => '');
  const cmdOut = (cmd, args, timeout = 10000) =>
    run(cmd, args, { timeout })
      .then((r) => r.stdout || '')
      .catch(() => '');
  async function isOnline() {
    // NetworkManager: CONNECTIVITY full (or unknown, when the connectivity check is off, while connected).
    const nm = (await cmdOut('nmcli', ['-t', '-f', 'CONNECTIVITY,STATE', 'general'], 5000)).trim();
    if (nm) {
      const [conn, st] = nm.split('\n')[0].split(':');
      if (conn === 'full') return true;
      if (conn === 'unknown') return /^connected/.test(st || '');
      return false;
    }
    // No NetworkManager: a default route.
    return /^\S+\t00000000\t/m.test(await readText('/proc/net/route'));
  }
  async function probeGpu() {
    const fixture = DEV && process.env.AURORA_REAL_BACKENDS !== '1' ? String(process.env.AURORA_GPU_FIXTURE || '') : null;
    let lspci;
    let drivers;
    let mods;
    let sb;
    let online;
    if (fixture != null) {
      const dir = /^[a-z0-9-]+$/.test(fixture) ? path.join(GPU_FIXTURES, fixture) : null;
      const rd = (f) => (dir ? readText(path.join(dir, f)) : Promise.resolve(''));
      [lspci, drivers, sb] = await Promise.all([rd('lspci.txt'), rd('ubuntu-drivers.txt'), rd('sb-state.txt')]);
      mods = (await rd('nvidia-version.txt')) || (await rd('lsmod.txt'));
      online = process.env.AURORA_GPU_ONLINE !== '0';
      const delay = Number(process.env.AURORA_GPU_DELAY) || 0;
      if (delay > 0) await new Promise((r) => setTimeout(r, Math.min(delay, 10000)));
    } else {
      lspci = await cmdOut('lspci', ['-nn', '-mm'], 8000);
    }
    const gpus = gpu.detectGpus(lspci);
    const nvidia = gpus.filter((g) => g.vendor === 'nvidia');
    const res = { gpus, nvidia, current: { module: null, version: null, open: null }, available: [], recommended: null, online: false, secureBoot: null };
    if (!nvidia.length) return res; // nothing to offer: AMD / Intel / virtual machines
    if (fixture == null) {
      [drivers, sb, online] = await Promise.all([cmdOut('ubuntu-drivers', ['devices'], 60000), cmdOut('mokutil', ['--sb-state'], 5000), isOnline()]);
      mods = (await readText('/proc/driver/nvidia/version')) || (await readText('/proc/modules'));
    }
    res.current = gpu.currentDriver(mods);
    res.available = gpu.parseUbuntuDrivers(drivers);
    res.recommended = gpu.recommendedDriver(res.available);
    res.online = !!online;
    res.secureBoot = gpu.parseSecureBoot(sb);
    return res;
  }
  api.handle('installer:gpu', async (opts) => {
    if (!gpuCache || opts?.refresh) gpuCache = probeGpu().catch(() => ({ gpus: [], nvidia: [], current: { module: null, version: null, open: null }, available: [], recommended: null, online: false, secureBoot: null }));
    const r = await gpuCache;
    return JSON.parse(JSON.stringify(r));
  });

  api.handle('installer:applyKeyboard', async (id) => {
    const k = KEYBOARDS.find((x) => x.id === id);
    if (!k) throw api.error('Unknown keyboard layout', 'EINVAL');
    if (DEV || !live || !process.env.DISPLAY || !which('setxkbmap')) return false;
    const args = ['-layout', k.layout];
    if (k.variant) args.push('-variant', k.variant);
    const r = await run('setxkbmap', args, { timeout: 5000 }).catch(() => ({ code: 1 }));
    return r.code === 0;
  });

  api.handle('installer:log', () => logLines.join('\n'));

  api.handle('installer:start', async (opts, event) => {
    if (job) throw api.error('An installation is already running', 'EBUSY');
    const delay = DEV ? process.env.AURORA_INSTALLER_DRYRUN_DELAY : undefined;
    const failAt = DEV ? process.env.AURORA_INSTALLER_FAIL_AT : undefined;
    const args = buildArgs(opts, { dryRun, delay, failAt });
    const helper = dryRun ? helperPath(HELPER) : path.join('/usr/lib/aurora/helpers', HELPER);
    if (!fs.existsSync(helper)) throw api.error(`The installer helper is missing (${helper})`, 'ENOENT');
    let cmd;
    let argv;
    if (DEV && failAt === 'notadmin') {
      // Simulates sudo refusing a standard account (same stderr as the real sudo; nothing runs).
      cmd = which('bash') || '/bin/bash';
      argv = ['-c', 'echo "sudo: $1 is not in the sudoers file." >&2; exit 1', 'sudo', String(opts?.user || 'user')];
    } else if (dryRun) {
      cmd = which('bash') || '/bin/bash';
      argv = [helper, ...args];
    } else {
      cmd = which('sudo');
      if (!cmd) throw api.error('sudo is not available', 'ENOENT');
      argv = ['-n', '--', helper, ...args];
    }
    const sender = event?.sender;
    const send = (payload) => api.sendTo(sender, 'installer:progress', payload);
    logLines.length = 0;
    finished = false;
    const child = spawn(cmd, argv, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, LC_ALL: 'C' } });
    job = { child, cancelled: false };
    let sawDone = false;
    let sawError = false;
    let authError = false;
    let notAdmin = false;
    const out = lineSplitter((line) => {
      if (!line.trim()) return;
      let ev = null;
      try {
        ev = JSON.parse(line);
      } catch {}
      if (ev && typeof ev === 'object' && typeof ev.driver === 'string') {
        // Graphics driver result: never fails the installation.
        const status = ev.driver === 'installed' ? 'installed' : 'failed';
        send({ type: 'driver', status, pkg: gpu.validDriverPkg(ev.package) ? ev.package : null, message: String(ev.message || '') });
      } else if (ev && typeof ev === 'object' && typeof ev.gaming === 'string') {
        // Gaming apps request for the first sign-in: never fails the installation either.
        const apps = String(ev.apps || '').split(',').filter((id) => GAMING_APPS.includes(id));
        send({ type: 'gaming', status: ev.gaming === 'saved' ? 'saved' : 'failed', apps, message: String(ev.message || '') });
      } else if (ev && typeof ev === 'object' && ev.error) {
        sawError = true;
        send({ type: 'error', message: String(ev.error), stage: ev.stage || null, code: ev.code ?? null });
      } else if (ev && typeof ev === 'object' && typeof ev.stage === 'string') {
        const progress = Math.max(0, Math.min(100, Number(ev.progress) || 0));
        send({ type: 'progress', stage: ev.stage, progress, message: String(ev.message || '') });
        if (ev.stage === 'done') {
          sawDone = true;
          send({ type: 'done' });
        }
      } else {
        pushLog(line);
        send({ type: 'log', line });
      }
    });
    const err = lineSplitter((line) => {
      if (/^sudo: .*(not allowed|not in the sudoers|may not run sudo)/i.test(line)) notAdmin = true;
      else if (/^sudo: .*(password is required|a terminal is required)/i.test(line)) authError = true;
      pushLog(line);
      send({ type: 'log', line });
    });
    child.stdout.on('data', (d) => out.push(String(d)));
    child.stderr.on('data', (d) => err.push(String(d)));
    child.stdin.on('error', () => {});
    child.stdin.end(`${opts.password}\n`);
    child.on('error', (e) => {
      pushLog(`aurora-install: ${e.message}`);
      if (!sawError) send({ type: 'error', message: e.message, stage: null, code: null });
      sawError = true;
    });
    child.on('close', (code, signal) => {
      out.flush();
      err.flush();
      const cancelled = job?.cancelled || false;
      job = null;
      const rc = code ?? (signal ? 128 : 1);
      if (rc === 0 && sawDone) finished = true;
      else if (!sawError) {
        const message = notAdmin
          ? 'This account is not allowed to make administrator changes (sudo refused it)'
          : authError
            ? 'Administrator rights are required to install (sudo refused the request)'
            : cancelled
              ? 'installation cancelled'
              : `the installer stopped unexpectedly (exit ${rc})`;
        send({ type: 'error', message, stage: null, code: notAdmin ? 'ENOTADMIN' : authError ? 'EAUTH' : rc });
      }
      send({ type: 'exit', code: rc, cancelled });
    });
    return { dryRun };
  });

  api.handle('installer:cancel', () => {
    if (!job) return false;
    job.cancelled = true;
    // sudo relays SIGTERM to the helper, which stops the current step and unmounts everything.
    try {
      job.child.kill('SIGTERM');
    } catch {}
    return true;
  });

  api.handle('installer:reboot', async () => {
    if (dryRun) return { simulated: true };
    const r = await run('systemctl', ['reboot'], { timeout: 15000 }).catch((e) => ({ code: 1, stderr: e.message }));
    if (r.code !== 0) {
      const s = await run('sudo', ['-n', 'systemctl', 'reboot'], { timeout: 15000 }).catch((e) => ({ code: 1, stderr: e.message }));
      if (s.code !== 0) throw api.error(`Restart failed: ${(r.stderr || s.stderr || '').trim()}`, 'ECMD');
    }
    return { simulated: false };
  });
}

module.exports = register;
module.exports.register = register;
module.exports.parseLsblk = parseLsblk;
module.exports.parseZoneTab = parseZoneTab;
module.exports.buildArgs = buildArgs;
module.exports.KEYBOARDS = KEYBOARDS;
module.exports.RESERVED_USERS = RESERVED_USERS;
module.exports.MIN_SIZE = MIN_SIZE;
module.exports.STAGES = STAGES;
module.exports.GAMING_APPS = GAMING_APPS;
