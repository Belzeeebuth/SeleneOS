'use strict';
// Sign-in screen backend (greeter mode) + session hand-off helpers (shell mode).
//
// Greeter mode (--mode=greeter, started by greetd through /usr/lib/aurora/aurora-greeter):
//   greeter:info                    -> { hostname, lang, live (= isLive), dev, version, lastUser, lastLang, mock }
//   greeter:users                   -> [{ name, fullName, uid, avatar (data:/app: URL | null), passwordless, last }]
//   greeter:login (user, password, { lang }) -> { ok: true }  then the app quits so greetd starts the session.
//                                      errors: EAUTH (wrong password; message = PAM text when PAM gave one),
//                                      EEXPIRED (PAM wants a new password), EBUSY, EGREETD (greetd refused / not reachable)
//   greeter:power (action)          -> 'shutdown'|'restart'|'sleep' through systemctl (polkit: org.freedesktop.login1.*
//                                      for the _greetd user, see /etc/polkit-1/rules.d/50-aurora.rules)
//   greeter:keyboard                -> { layout, variant, id, layouts: [{ id, layout, variant }] }
//   greeter:setKeyboard (id)        -> sets the greeter's X keyboard layout (setxkbmap; allow-listed ids)
//   greeter:a11y                    -> { largeText, animations, osk } (remembered; applies the zoom factor; osk = the
//                                      on-screen keyboard « Clavier visuel », core/features/osk/greeter.js)
//   greeter:setA11y ({ largeText?, animations?, osk? }) -> the same, after saving the change
// Shell mode:
//   session:welcome                 -> true once per login session (marker in $XDG_RUNTIME_DIR; dev: only with
//                                      AURORA_WELCOME=1, { show, hold } with AURORA_WELCOME_HOLD=<ms>): the shell shows
//                                      its "Welcome" transition only on the first start, not after a crash restart.
//
// greetd IPC (https://man.sr.ht/~kennylevinsen/greetd/): a unix socket at $GREETD_SOCK; every message is a
// native-endian uint32 length followed by that many bytes of UTF-8 JSON. Requests: create_session {username},
// post_auth_message_response {response}, start_session {cmd, env}, cancel_session. Each request gets exactly one
// response: success | error {error_type: auth_error|error, description} | auth_message {auth_message_type:
// visible|secret|info|error, auth_message}.
//
// Dev mode (--dev without $GREETD_SOCK): a mock greetd with a few fake users; the password is "aurora".
// With $GREETD_SOCK set the real client is used even in dev mode (the test suite runs a fake greetd server).
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { run } = require('../lib/exec');

const SESSION_CMD = ['/usr/bin/aurora-session'];
const LITTLE = os.endianness() === 'LE';
const MAX_FRAME = 1 << 20;

// ------------------------------------------------------------------ framing (unit-tested)
function encodeFrame(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(4);
  if (LITTLE) head.writeUInt32LE(body.length, 0);
  else head.writeUInt32BE(body.length, 0);
  return Buffer.concat([head, body]);
}

/** Incremental decoder: push(chunk) -> array of decoded messages (frames may span or share chunks). */
class FrameDecoder {
  constructor() {
    this.buf = Buffer.alloc(0);
  }
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk);
    const out = [];
    while (this.buf.length >= 4) {
      const len = LITTLE ? this.buf.readUInt32LE(0) : this.buf.readUInt32BE(0);
      if (len > MAX_FRAME) {
        const e = new Error(`greetd frame too large (${len} bytes)`);
        e.code = 'EGREETD';
        throw e;
      }
      if (this.buf.length < 4 + len) break;
      const body = this.buf.subarray(4, 4 + len).toString('utf8');
      this.buf = this.buf.subarray(4 + len);
      out.push(JSON.parse(body));
    }
    return out;
  }
}

function gerr(message, code, extra) {
  const e = new Error(message);
  e.code = code;
  if (extra) Object.assign(e, extra);
  return e;
}

// ------------------------------------------------------------------ greetd client
class GreetdClient {
  constructor(sockPath, { timeout = 60000 } = {}) {
    this.sockPath = sockPath;
    this.timeout = timeout;
    this.sock = null;
    this.waiters = [];
    this.decoder = null;
  }

  connect() {
    if (this.sock && !this.sock.destroyed) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(this.sockPath);
      const fail = (err) => {
        sock.destroy();
        reject(gerr(`Cannot reach greetd: ${err.message}`, 'EGREETD'));
      };
      sock.once('error', fail);
      sock.once('connect', () => {
        sock.off('error', fail);
        this.sock = sock;
        this.decoder = new FrameDecoder();
        sock.on('data', (chunk) => {
          let msgs;
          try {
            msgs = this.decoder.push(chunk);
          } catch (err) {
            this._fail(err);
            return;
          }
          for (const m of msgs) {
            const w = this.waiters.shift();
            if (w) w.resolve(m);
          }
        });
        sock.on('error', (err) => this._fail(gerr(`greetd connection failed: ${err.message}`, 'EGREETD')));
        sock.on('close', () => this._fail(gerr('greetd closed the connection', 'EGREETD')));
        resolve();
      });
    });
  }

  _fail(err) {
    const ws = this.waiters.splice(0);
    for (const w of ws) w.reject(err);
    if (this.sock) {
      this.sock.destroy();
      this.sock = null;
    }
  }

  /** Send one request and wait for its response. */
  async request(obj) {
    await this.connect();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this._fail(gerr('greetd did not answer', 'ETIMEDOUT')), this.timeout);
      this.waiters.push({
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.sock.write(encodeFrame(obj));
    });
  }

  async cancel() {
    try {
      return await this.request({ type: 'cancel_session' });
    } catch {
      return null;
    }
  }

  close() {
    if (this.sock) this.sock.end();
    this.sock = null;
  }

  /**
   * Full sign-in: create_session -> answer PAM prompts -> start_session.
   * Resolves { ok: true, messages } once greetd accepted start_session (the caller must then exit).
   */
  async login(username, password, { cmd = SESSION_CMD, env = [] } = {}) {
    let res = await this.request({ type: 'create_session', username });
    // A previous attempt left a half-configured session (e.g. the greeter was reloaded): cancel it once and retry.
    if (res.type === 'error' && res.error_type !== 'auth_error') {
      await this.cancel();
      res = await this.request({ type: 'create_session', username });
    }
    const messages = [];
    let secretAnswered = false;
    for (let guard = 0; guard < 32; guard++) {
      if (res.type === 'success') break;
      if (res.type === 'error') {
        await this.cancel();
        const pam = messages.filter((m) => m.kind === 'error').map((m) => m.text).join(' ');
        if (res.error_type === 'auth_error') throw gerr(pam || 'Authentication failed', 'EAUTH', { messages });
        throw gerr(res.description || 'greetd error', 'EGREETD', { messages });
      }
      if (res.type !== 'auth_message') {
        await this.cancel();
        throw gerr(`Unexpected greetd response: ${res.type}`, 'EGREETD');
      }
      const kind = res.auth_message_type;
      const text = String(res.auth_message || '').trim();
      let response = null;
      if (kind === 'secret') {
        if (secretAnswered) {
          // A second hidden prompt means PAM wants something we cannot give here (new password, OTP…).
          await this.cancel();
          throw gerr(text || 'Password change required', 'EEXPIRED', { messages });
        }
        secretAnswered = true;
        response = String(password ?? '');
      } else if (kind === 'visible') {
        response = /login|user|utilisateur|identifiant/i.test(text) ? username : '';
      } else {
        if (text) messages.push({ kind: kind === 'error' ? 'error' : 'info', text });
      }
      res = await this.request({ type: 'post_auth_message_response', response });
    }
    if (res.type !== 'success') {
      await this.cancel();
      throw gerr('greetd authentication did not finish', 'EGREETD');
    }
    const started = await this.request({ type: 'start_session', cmd, env });
    if (started.type !== 'success') {
      await this.cancel();
      throw gerr(started.description || 'greetd could not start the session', 'EGREETD');
    }
    return { ok: true, messages };
  }
}

// ------------------------------------------------------------------ users (unit-tested)
const BAD_SHELL = /(^|\/)(nologin|false|sync|halt|shutdown)$/;

/** Human users from /etc/passwd text: uid in [minUid, maxUid] with a login shell (+ the live user). */
function parsePasswd(text, { minUid = 1000, maxUid = 59999, shells = null, liveUser = null } = {}) {
  const out = [];
  const seen = new Set();
  for (const line of String(text || '').split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const f = line.split(':');
    if (f.length < 7) continue;
    const [name, , uidS, , gecos, home, shell] = f;
    const uid = Number(uidS);
    if (!name || !Number.isInteger(uid) || seen.has(name)) continue;
    seen.add(name); // like getpwnam(): the first entry of a name wins
    const isLive = !!liveUser && name === liveUser;
    if (!isLive && (uid < minUid || uid > maxUid)) continue;
    if (!shell || BAD_SHELL.test(shell)) continue;
    if (shells && shells.size && !shells.has(shell) && !isLive) continue;
    const fullName = (gecos || '').split(',')[0].trim() || name;
    out.push({ name, fullName, uid, home, shell, live: isLive });
  }
  return out;
}

function parseShells(text) {
  return new Set(
    String(text || '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#')),
  );
}

/** UID_MIN / UID_MAX from /etc/login.defs text (defaults 1000 / 60000). */
function parseLoginDefs(text) {
  const get = (k, d) => {
    const m = new RegExp(`^\\s*${k}\\s+(\\d+)`, 'm').exec(String(text || ''));
    return m ? Number(m[1]) : d;
  };
  return { minUid: get('UID_MIN', 1000), maxUid: get('UID_MAX', 60000) };
}

function liveUserName() {
  try {
    const m = /USERNAME="?([a-z_][a-z0-9_-]*)"?/.exec(fs.readFileSync('/etc/casper.conf', 'utf8'));
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function sniffImage(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 6 && buf.subarray(0, 6).toString('latin1').startsWith('GIF8')) return 'image/gif';
  if (buf.length > 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  const head = buf.subarray(0, 256).toString('utf8');
  if (/<svg[\s>]/i.test(head) || (/^\s*<\?xml/.test(head) && /<svg/i.test(buf.subarray(0, 2048).toString('utf8')))) return 'image/svg+xml';
  return null;
}

// Account pictures. Home folders are private (0750), so the sign-in screen (user _greetd) cannot read ~/.face:
// the desktop session publishes a copy in FACES_DIR (sticky, world-writable like /tmp; created by tmpfiles.d)
// and the greeter only accepts a file there when its owner is the account itself. AccountsService icons
// (/var/lib/AccountsService/icons/<user>) are used too when present.
const FACES_DIR = process.env.AURORA_FACES_DIR || '/var/lib/aurora/faces';
const MAX_FACE = 2 * 1024 * 1024;

/** Read a regular file without following symlinks; null when unreadable, too big or owned by someone else. */
function readFileSafe(file, { uid = null, max = MAX_FACE } = {}) {
  let fd = -1;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (fs.constants.O_NONBLOCK || 0));
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > max || st.size < 16) return null;
    if (uid != null && st.uid !== uid) return null;
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = fs.readSync(fd, buf, off, st.size - off, off);
      if (n <= 0) break;
      off += n;
    }
    return buf.subarray(0, off);
  } catch {
    return null;
  } finally {
    if (fd >= 0) fs.closeSync(fd);
  }
}

/** Account picture as a data: URL, or null. */
function readAvatar(user, { facesDir = FACES_DIR } = {}) {
  const files = [
    user.home && { file: path.join(user.home, '.face') },
    user.home && { file: path.join(user.home, '.face.icon') },
    { file: path.join(facesDir, user.name), uid: user.uid },
    { file: `/var/lib/AccountsService/icons/${user.name}` },
  ].filter(Boolean);
  for (const { file, uid } of files) {
    const buf = readFileSafe(file, { uid: uid ?? null });
    const mime = buf && sniffImage(buf);
    if (mime && mime !== 'image/svg+xml') return `data:${mime};base64,${buf.toString('base64')}`;
  }
  return null;
}

/** Desktop session side: copy ~/.face to FACES_DIR/<user> for the sign-in screen (or remove the copy). */
function publishFace({ home = os.homedir(), name = os.userInfo().username, facesDir = FACES_DIR } = {}) {
  try {
    if (!fs.statSync(facesDir).isDirectory()) return false;
  } catch {
    return false;
  }
  const dst = path.join(facesDir, name);
  const mine = (f) => {
    try {
      return fs.lstatSync(f).uid === process.getuid();
    } catch {
      return false;
    }
  };
  let buf = null;
  for (const f of ['.face', '.face.icon']) {
    buf = readFileSafe(path.join(home, f));
    if (buf && sniffImage(buf) && sniffImage(buf) !== 'image/svg+xml') break;
    buf = null;
  }
  if (!buf) {
    if (mine(dst)) {
      try {
        fs.unlinkSync(dst);
      } catch {}
    }
    return false;
  }
  const cur = readFileSafe(dst, { uid: process.getuid() });
  if (cur && cur.equals(buf)) return true;
  // Never follow a planted symlink: fresh, exclusive temporary file, then an atomic rename (the sticky bit
  // makes the rename fail if someone else owns <user> there).
  const tmp = path.join(facesDir, `.${name}.${process.pid}.${Math.random().toString(36).slice(2)}`);
  let fd = -1;
  try {
    fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o644);
    fs.writeSync(fd, buf);
    fs.fchmodSync(fd, 0o644);
    fs.closeSync(fd);
    fd = -1;
    fs.renameSync(tmp, dst);
    return true;
  } catch {
    if (fd >= 0) fs.closeSync(fd);
    try {
      fs.unlinkSync(tmp);
    } catch {}
    return false;
  }
}

// ------------------------------------------------------------------ keyboard layouts (unit-tested)
const LAYOUTS = [
  { id: 'us', layout: 'us', variant: '' },
  { id: 'gb', layout: 'gb', variant: '' },
  { id: 'fr', layout: 'fr', variant: '' },
  { id: 'be', layout: 'be', variant: '' },
  { id: 'ca', layout: 'ca', variant: '' },
  { id: 'ch:fr', layout: 'ch', variant: 'fr' },
  { id: 'de', layout: 'de', variant: '' },
];

/** `setxkbmap -query` output -> { layout, variant, model, options } (first layout of a group list). */
function parseXkbQuery(text) {
  const out = { layout: '', variant: '', model: '', options: '' };
  for (const line of String(text || '').split('\n')) {
    const m = /^(\w+):\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const v = m[2].trim();
    if (m[1] === 'layout') out.layout = v.split(',')[0];
    else if (m[1] === 'variant') out.variant = v.split(',')[0];
    else if (m[1] === 'model') out.model = v;
    else if (m[1] === 'options') out.options = v;
  }
  return out;
}

function layoutId(layout, variant) {
  const hit = LAYOUTS.find((l) => l.layout === layout && (l.variant || '') === (variant || ''));
  if (hit) return hit.id;
  return variant ? `${layout}:${variant}` : layout || 'us';
}

// ------------------------------------------------------------------ greeter state (last user, language)
function stateDirs(api) {
  const dirs = [];
  if (process.env.AURORA_GREETER_STATE) dirs.push(process.env.AURORA_GREETER_STATE);
  if (!api.DEV) dirs.push('/var/lib/aurora-greeter', '/var/cache/aurora-greeter');
  try {
    dirs.push(require('electron').app.getPath('userData'));
  } catch {}
  dirs.push(path.join(os.tmpdir(), `aurora-greeter-${process.getuid?.() ?? 0}`));
  return dirs;
}

function createState(api) {
  const dirs = stateDirs(api);
  const fileIn = (d) => path.join(d, 'greeter-state.json');
  const load = () => {
    for (const d of dirs) {
      try {
        return JSON.parse(fs.readFileSync(fileIn(d), 'utf8')) || {};
      } catch {}
    }
    return {};
  };
  let state = load();
  return {
    get: () => state,
    set(patch) {
      state = { ...state, ...patch };
      for (const d of dirs) {
        try {
          // Only create the per-app dirs (userData / tmp); system dirs must already exist (tmpfiles.d).
          if (!d.startsWith('/var/')) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
          fs.accessSync(d, fs.constants.W_OK);
          const f = fileIn(d);
          fs.writeFileSync(`${f}.tmp`, JSON.stringify(state));
          fs.renameSync(`${f}.tmp`, f);
          return true;
        } catch {}
      }
      return false;
    },
  };
}

// ------------------------------------------------------------------ dev mock
const MOCK_USERS = [
  { name: 'alex', fullName: 'Alex Morgan', uid: 1000 },
  { name: 'camille', fullName: 'Camille Laurent', uid: 1001, avatar: 'app://shell/assets/wallpapers/clairdelune-light.jpg' },
  { name: 'sam', fullName: 'Sam Rivera', uid: 1002 },
];

function mockUsers() {
  const n = Number(process.env.AURORA_MOCK_USERS);
  let list = MOCK_USERS.map((u) => ({ ...u, avatar: u.avatar || null, passwordless: false, live: false }));
  if (process.env.AURORA_LIVE === '1') list.unshift({ name: 'aurora', fullName: 'Selene Live', uid: 999, avatar: null, passwordless: true, live: true });
  if (Number.isInteger(n) && n >= 0) list = list.slice(0, n);
  return list;
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ registration
function sessionEnv(lang) {
  const env = ['XDG_SESSION_TYPE=x11', 'XDG_SESSION_DESKTOP=aurora', 'XDG_CURRENT_DESKTOP=Aurora'];
  if (lang === 'fr') env.push('LANG=fr_FR.UTF-8', 'AURORA_LANG=fr');
  else if (lang === 'en') env.push('LANG=en_US.UTF-8', 'AURORA_LANG=en');
  return env;
}

function registerShell(api) {
  let shownInProcess = false;
  // Keep the sign-in screen's copy of the account picture up to date (never in dev: system directory).
  if (!api.DEV || process.env.AURORA_FACES_DIR) {
    publishFace();
    for (const f of ['.face', '.face.icon']) {
      try {
        fs.watchFile(path.join(os.homedir(), f), { interval: 10000, persistent: false }, () => publishFace());
      } catch {}
    }
  }
  api.handle('session:welcome', () => {
    if (api.DEV) {
      // Dev runs (and other areas' tests) never show it unless asked; AURORA_WELCOME_HOLD=<ms> keeps it up
      // longer for screenshots.
      if (process.env.AURORA_WELCOME !== '1' || shownInProcess) return false;
      shownInProcess = true;
      const hold = Number(process.env.AURORA_WELCOME_HOLD) || 0;
      return hold > 0 ? { show: true, hold: Math.min(hold, 20000) } : true;
    }
    const dir = process.env.XDG_RUNTIME_DIR;
    const id = String(process.env.XDG_SESSION_ID || 'session').replace(/[^\w.-]/g, '_');
    if (!dir) {
      if (shownInProcess) return false;
      shownInProcess = true;
      return true;
    }
    try {
      fs.writeFileSync(path.join(dir, `aurora-welcome-${id}`), String(Date.now()), { flag: 'wx', mode: 0o600 });
      return true;
    } catch (err) {
      if (err.code === 'EEXIST') return false;
      if (shownInProcess) return false;
      shownInProcess = true;
      return true;
    }
  });
}

function registerGreeter(api) {
  const { env, DEV } = api;
  const sock = process.env.GREETD_SOCK || '';
  const mock = DEV && !sock;
  const state = createState(api);
  const client = sock ? new GreetdClient(sock) : null;
  if (!sock && !DEV) console.error('[greetd] GREETD_SOCK is not set: sign-in will not work');
  let busy = false;
  let done = false;
  let devLayout = state.get().keyboard || 'us';
  // Tests: a fixture passwd file (dev mode only).
  const passwdFile = (DEV && process.env.AURORA_GREETER_PASSWD) || '/etc/passwd';

  const quitSoon = (ms) => {
    const { app } = require('electron');
    setTimeout(() => {
      app.quit();
      // Never leave greetd waiting on a stuck greeter.
      setTimeout(() => app.exit(0), 3000).unref?.();
    }, ms);
  };

  api.handle('greeter:info', () => {
    const st = state.get();
    return {
      hostname: os.hostname(),
      lang: env.lang,
      live: !!env.live,
      isLive: !!env.live,
      dev: !!DEV,
      mock,
      version: env.version,
      lastUser: st.lastUser || null,
      lastLang: st.lang || null,
    };
  });

  api.handle('greeter:users', () => {
    const last = state.get().lastUser || null;
    let users;
    if (mock) {
      users = mockUsers();
    } else {
      let shells = null;
      try {
        shells = parseShells(fs.readFileSync('/etc/shells', 'utf8'));
      } catch {}
      const liveUser = env.live ? liveUserName() : null;
      let defs = { minUid: 1000, maxUid: 60000 };
      try {
        defs = parseLoginDefs(fs.readFileSync('/etc/login.defs', 'utf8'));
      } catch {}
      let text = '';
      try {
        text = fs.readFileSync(passwdFile, 'utf8');
      } catch {}
      users = parsePasswd(text, { shells, liveUser, ...defs }).map((u) => ({
        name: u.name,
        fullName: u.fullName,
        uid: u.uid,
        avatar: readAvatar(u),
        // casper's live user has an empty password: sign in with a button instead of a password box.
        passwordless: !!u.live,
        live: !!u.live,
      }));
    }
    // Live user first, then by name ("User 2" before "User 10").
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    users.sort((a, b) => (b.live ? 1 : 0) - (a.live ? 1 : 0) || collator.compare(a.fullName, b.fullName) || collator.compare(a.name, b.name));
    return users.map((u) => ({ ...u, last: u.name === last }));
  });

  api.handle('greeter:login', async (username, password, opts = {}) => {
    username = String(username || '').trim();
    if (!/^[a-z_][a-z0-9_.-]*\$?$/i.test(username) || username.length > 64) throw api.error('Invalid user name', 'EINVAL');
    if (typeof password !== 'string' || password.length > 4096) throw api.error('Invalid password', 'EINVAL');
    if (done) return { ok: true };
    if (busy) throw api.error('A sign-in is already in progress', 'EBUSY');
    busy = true;
    const lang = opts?.lang === 'fr' || opts?.lang === 'en' ? opts.lang : null;
    try {
      if (mock) {
        await delay(650);
        const u = mockUsers().find((x) => x.name === username);
        if (!u || (!u.passwordless && password !== 'aurora')) {
          const e = api.error('Authentication failed', 'EAUTH');
          e.quiet = true;
          throw e;
        }
        console.log(`[greetd] (dev) start_session ${JSON.stringify({ cmd: SESSION_CMD, env: sessionEnv(lang) })} for ${username}`);
      } else {
        if (!client) throw api.error('greetd is not available (GREETD_SOCK is not set)', 'EGREETD');
        try {
          await client.login(username, password, { env: sessionEnv(lang) });
        } catch (err) {
          const e = api.error(err.message, err.code || 'EGREETD');
          e.quiet = err.code === 'EAUTH';
          throw e;
        }
      }
      done = true;
      state.set({ lastUser: username, ...(lang ? { lang } : {}) });
      quitSoon(mock ? 1200 : 450);
      return { ok: true };
    } finally {
      busy = false;
    }
  });

  api.handle('greeter:power', async (action) => {
    const verb = { shutdown: 'poweroff', poweroff: 'poweroff', restart: 'reboot', reboot: 'reboot', sleep: 'suspend', suspend: 'suspend' }[action];
    if (!verb) throw api.error(`Unknown power action ${action}`, 'EINVAL');
    if (DEV) {
      console.log(`[greetd] (dev) systemctl ${verb}`);
      return true;
    }
    // Allowed for the _greetd user by polkit (org.freedesktop.login1.power-off / reboot / suspend).
    const r = await run('systemctl', ['--no-ask-password', verb], { timeout: 20000 });
    if (r.code !== 0) throw api.error((r.stderr || r.stdout).trim() || `systemctl ${verb} failed`, 'EPOWER');
    return true;
  });

  // Accessibility options of the sign-in screen (tray menu), remembered like the last user. Larger text is the
  // window's zoom factor: Chromium also remembers a per-origin zoom in the profile, so the factor is always set
  // explicitly from the saved choice (the menu's check mark then matches what is on screen).
  const ZOOM_LARGE = 1.25;
  const a11yPrefs = () => ({ largeText: false, animations: true, osk: false, ...(state.get().a11y || {}) });
  const applyZoom = (large) => {
    try {
      const w = api.getMainWindow();
      if (w && !w.isDestroyed()) w.webContents.setZoomFactor(large ? ZOOM_LARGE : 1);
    } catch {}
  };
  api.handle('greeter:a11y', () => {
    const a = a11yPrefs();
    applyZoom(a.largeText);
    return a;
  });
  api.handle('greeter:setA11y', (patch) => {
    const a = a11yPrefs();
    if (patch && typeof patch === 'object') {
      if (typeof patch.largeText === 'boolean') a.largeText = patch.largeText;
      if (typeof patch.animations === 'boolean') a.animations = patch.animations;
      if (typeof patch.osk === 'boolean') a.osk = patch.osk;
    }
    applyZoom(a.largeText);
    state.set({ a11y: { largeText: a.largeText, animations: a.animations, osk: !!a.osk } });
    return a;
  });

  // Re-apply the layout chosen last time (the greeter's X server starts with the system default).
  const saved = LAYOUTS.find((l) => l.id === state.get().keyboard);
  const reapplied = saved && !DEV ? run('setxkbmap', ['-layout', saved.layout, '-variant', saved.variant || ''], { timeout: 5000 }).catch(() => null) : Promise.resolve();

  api.handle('greeter:keyboard', async () => {
    await reapplied;
    let layout = 'us';
    let variant = '';
    if (DEV) {
      const l = LAYOUTS.find((x) => x.id === devLayout) || LAYOUTS[0];
      layout = l.layout;
      variant = l.variant;
    } else {
      try {
        const q = parseXkbQuery((await run('setxkbmap', ['-query'], { timeout: 5000 })).stdout);
        if (q.layout) {
          layout = q.layout;
          variant = q.variant;
        }
      } catch {}
    }
    return { layout, variant, id: layoutId(layout, variant), layouts: LAYOUTS };
  });

  api.handle('greeter:setKeyboard', async (id) => {
    const l = LAYOUTS.find((x) => x.id === id);
    if (!l) throw api.error(`Unknown keyboard layout ${id}`, 'EINVAL');
    if (DEV) {
      devLayout = l.id;
    } else {
      const args = ['-layout', l.layout, ...(l.variant ? ['-variant', l.variant] : ['-variant', ''])];
      const r = await run('setxkbmap', args, { timeout: 5000 });
      if (r.code !== 0) throw api.error(r.stderr.trim() || 'setxkbmap failed', 'EKEYBOARD');
    }
    state.set({ keyboard: l.id });
    return { id: l.id, layout: l.layout, variant: l.variant };
  });

}

module.exports = function register(api) {
  if (api.env?.mode === 'greeter') registerGreeter(api);
  else registerShell(api);
};

module.exports.GreetdClient = GreetdClient;
module.exports.FrameDecoder = FrameDecoder;
module.exports.encodeFrame = encodeFrame;
module.exports.parsePasswd = parsePasswd;
module.exports.parseShells = parseShells;
module.exports.parseLoginDefs = parseLoginDefs;
module.exports.parseXkbQuery = parseXkbQuery;
module.exports.layoutId = layoutId;
module.exports.sniffImage = sniffImage;
module.exports.readAvatar = readAvatar;
module.exports.publishFace = publishFace;
module.exports.sessionEnv = sessionEnv;
module.exports.LAYOUTS = LAYOUTS;
module.exports.SESSION_CMD = SESSION_CMD;
