'use strict';
// Remote Desktop backend: a raw TCP pipe for the app's VNC (RFB) client, FreeRDP sessions for RDP, and the saved
// connections. The renderer's CSP has no network access: the RFB protocol runs in apps/remote/lib/rfb.js and its bytes
// go through here. Nothing else is reachable from this module: one TCP socket to the host and port the user typed, or
// one FreeRDP process (main/lib/freerdp.js builds its arguments) for that host and port.
//
// Channels:
//   remote:connect (host, port, { key, timeoutMs }) -> { id, remoteAddress }
//        host: hostname, IPv4 or IPv6 (validated, no URL, no spaces); port: integer 1..65535.
//        key: identifies the app window: a new connect with the same key closes that window's previous connection
//        (one connection per window). Rejects with code EINVAL, ECONNREFUSED, ETIMEDOUT, ENOTFOUND, EHOSTUNREACH,
//        ENETUNREACH, ELIMIT (too many connections) or EOFFLINE (dev/tests: only loopback hosts, no real network).
//   remote:close (id) -> true
//   remote:list () -> [{ id, protocol: 'vnc'|'rdp', name, host, port, remember, clipboard (vnc) | user, domain, options (rdp) }]
//        (saved connections, never with the password)
//   remote:save ({ id?, protocol?, name, host, port, password?, remember, clipboard?, user?, domain?, options? }) -> entry
//        (password kept only when remember is true; remember with no password keeps the stored one).
//        RDP options: { display: 'fit'|'fullscreen'|'fixed', size: 'WxH', multimon, clipboard, audio, drive: path|null }
//   remote:rdp-status () -> { available, program, version }   (FreeRDP 3: xfreerdp3, or xfreerdp when it is 3.x)
//   remote:rdp-start ({ entryId?, host, port, user, domain, password?, name, options, screen: { width, height } })
//        -> { id, pid, title }. Password: the one given, else the one remembered for entryId. FreeRDP gets every
//        argument on stdin (never in argv). Rejects EINVAL (bad host, port, user, domain, password with a line break,
//        folder with a comma), EDRIVE (shared folder missing), ENOFREERDP, EOFFLINE (dev: loopback only), ELIMIT.
//   remote:rdp-stop (id) -> true          remote:rdp-list () -> [{ id, pid, host, port, title, startedAt }]
//   remote:rdp-trust (host, port, sha256hex) -> true   (the person accepted this certificate in Selene's dialog)
// Event remote:rdp { id, state: 'ended', code, ended, fingerprint?, previous? (sha256 Selene trusted before), detail,
//   host, port } when a FreeRDP process exits (classification: main/lib/freerdp.js classifyExit).
//   remote:remove (id) -> true
//   remote:secret (id) -> string ('' when none is stored)
//   remote:storage () -> { file, secure }
// Fire-and-forget (api.send):
//   remote:resume (id)          start receiving: the socket is paused until then (no data before the connect reply)
//   remote:write (id, Uint8Array)
// Events (only to the window that owns the connection):
//   remote:data   { id, data: Uint8Array }
//   remote:closed { id, error: null | { code, message } }
//
// Saved connections: ~/.local/share/aurora/remote.json ($XDG_DATA_HOME). Passwords are sealed like Mail's: Electron
// safeStorage with a real keyring, else AES-256-GCM with a per-machine key (obfuscation, not secrecy).
// Timeouts: AURORA_REMOTE_TIMEOUT (ms, default 10000) for the TCP connect; idle sockets close after 2 hours.
// Certificates Selene trusted for RDP: "certs": { "host:port": { sha256, at } } in the same file.
// FreeRDP sessions are not tied to the app window (the session is its own X11 window, closing it ends the session);
// they end with the shell (killed on exit).
const net = require('net');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const rdp = require('../lib/freerdp');

const MAX_PER_SENDER = 8;
const IDLE_MS = 2 * 3600000;
const MAX_WRITE = 1 << 20;

function hostKind(s) {
  if (typeof s !== 'string' || !s || s.length > 253) return null;
  if (/^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(s)) return 'ipv4';
  if (s.includes(':')) return net.isIPv6(s) ? 'ipv6' : null;
  if (/^[\d.]+$/.test(s)) return null;
  return s.split('.').every((l) => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(l)) ? 'hostname' : null;
}
function validPort(p) {
  const n = typeof p === 'string' && /^\d{1,5}$/.test(p.trim()) ? Number(p) : p;
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}
function isLoopback(host) {
  const h = String(host).toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost') || /^127\.\d+\.\d+\.\d+$/.test(h) || h === '::1';
}

function dataDir() {
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'aurora');
}
const storeFile = () => path.join(dataDir(), 'remote.json');

// ------------------------------------------------------------------ secrets (same scheme as mail.js)
function safeStorage() {
  try {
    const s = require('electron').safeStorage;
    if (!s?.isEncryptionAvailable?.()) return null;
    const backend = typeof s.getSelectedStorageBackend === 'function' ? s.getSelectedStorageBackend() : 'unknown';
    return process.platform !== 'linux' || !['basic_text', 'unknown'].includes(backend) ? s : null;
  } catch {
    return null;
  }
}
let obfKey = null;
function obfuscationKey() {
  if (obfKey) return obfKey;
  let machine = '';
  for (const f of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try {
      machine = fs.readFileSync(f, 'utf8').trim();
      if (machine) break;
    } catch {}
  }
  obfKey = crypto.createHash('sha256').update(`aurora-remote\0${machine}\0${os.userInfo().username}\0${os.homedir()}`).digest();
  return obfKey;
}
function sealSecret(plain) {
  if (plain == null || plain === '') return null;
  const ss = safeStorage();
  if (ss) return { m: 'safe', v: ss.encryptString(String(plain)).toString('base64') };
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', obfuscationKey(), iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return { m: 'obf', v: Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64') };
}
function openSecret(sealed) {
  if (!sealed?.v) return '';
  try {
    const buf = Buffer.from(sealed.v, 'base64');
    if (sealed.m === 'safe') return require('electron').safeStorage.decryptString(buf);
    const d = crypto.createDecipheriv('aes-256-gcm', obfuscationKey(), buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
  } catch {
    return '';
  }
}

// ------------------------------------------------------------------ saved connections
async function readDoc() {
  try {
    const j = JSON.parse(await fsp.readFile(storeFile(), 'utf8'));
    return { connections: Array.isArray(j?.connections) ? j.connections.filter((c) => c && typeof c.id === 'string' && hostKind(c.host) && validPort(c.port)) : [], certs: j?.certs && typeof j.certs === 'object' ? j.certs : {} };
  } catch {
    return { connections: [], certs: {} };
  }
}
async function readStore() {
  return (await readDoc()).connections;
}
let writing = Promise.resolve();
function writeDoc(doc) {
  writing = writing.catch(() => {}).then(async () => {
    await fsp.mkdir(dataDir(), { recursive: true, mode: 0o700 });
    const tmp = `${storeFile()}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify({ version: 2, connections: doc.connections, certs: doc.certs || {} }, null, 2), { mode: 0o600 });
    await fsp.rename(tmp, storeFile());
  });
  return writing;
}
async function writeStore(list) {
  const doc = await readDoc();
  await writeDoc({ connections: list, certs: doc.certs });
}
const publicEntry = (c) => ({
  id: c.id,
  protocol: c.protocol === 'rdp' ? 'rdp' : 'vnc',
  name: typeof c.name === 'string' && c.name ? c.name : c.host,
  host: c.host,
  port: validPort(c.port),
  remember: !!c.secret,
  ...(c.protocol === 'rdp' ? { user: c.user || '', domain: c.domain || '', options: rdp.cleanOptions(c.options) } : { clipboard: c.clipboard !== false }),
});
function err(message, code) {
  const e = new Error(message);
  e.code = code;
  e.quiet = true;
  return e;
}

module.exports = function register(api) {
  const MOCK = !!api.DEV && process.env.AURORA_REAL_BACKENDS !== '1';
  const conns = new Map(); // id -> { socket, sender, key }
  let seq = 0;
  const watched = new WeakSet();

  function closeConn(id, error) {
    const c = conns.get(id);
    if (!c) return;
    conns.delete(id);
    try {
      c.socket.destroy();
    } catch {}
    api.sendTo(c.sender, 'remote:closed', { id, error: error || null });
  }

  api.handle('remote:connect', async (...args) => {
    const event = args.pop(); // the IPC event is always the last argument
    let [host, port, opts] = args;
    const sender = event?.sender;
    host = typeof host === 'string' ? host.trim() : host;
    if (typeof host === 'string' && /^\[.*\]$/.test(host)) host = host.slice(1, -1);
    if (!hostKind(host)) throw err('Invalid host name or address.', 'EINVAL');
    const p = validPort(port);
    if (!p) throw err('Invalid port (1-65535).', 'EINVAL');
    if (MOCK && !isLoopback(host)) throw err('Network access is disabled in development mode (only this computer can be reached).', 'EOFFLINE');
    const key = typeof opts?.key === 'string' ? opts.key.slice(0, 100) : '';
    const mine = [...conns.entries()].filter(([, c]) => c.sender === sender);
    for (const [id, c] of mine) if (key && c.key === key) closeConn(id, null);
    if ([...conns.values()].filter((c) => c.sender === sender).length >= MAX_PER_SENDER) throw err('Too many open connections.', 'ELIMIT');
    const timeout = Math.max(200, Math.min(60000, Number(opts?.timeoutMs) || Number(process.env.AURORA_REMOTE_TIMEOUT) || 10000));

    const socket = await new Promise((resolve, reject) => {
      const s = net.connect({ host, port: p });
      const timer = setTimeout(() => {
        s.destroy();
        reject(err('The connection timed out.', 'ETIMEDOUT'));
      }, timeout);
      s.once('connect', () => {
        clearTimeout(timer);
        s.removeAllListeners('error');
        resolve(s);
      });
      s.once('error', (e) => {
        clearTimeout(timer);
        s.destroy();
        reject(err(e.message, e.code || 'EFAIL'));
      });
    });
    if (sender?.isDestroyed?.()) {
      socket.destroy();
      throw err('The window was closed.', 'ECLOSED');
    }
    const id = `r${++seq}`;
    conns.set(id, { socket, sender, key });
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30000);
    socket.setTimeout(IDLE_MS, () => closeConn(id, { code: 'ETIMEDOUT', message: 'idle' }));
    // The socket stays paused (bytes buffered by Node) until the window knows the id and sends remote:resume,
    // so no data event can reach the renderer before the remote:connect reply.
    conns.get(id).start = () => {
      socket.on('data', (buf) => {
        if (conns.has(id)) api.sendTo(sender, 'remote:data', { id, data: new Uint8Array(buf.buffer, buf.byteOffset, buf.length) });
      });
    };
    socket.on('error', (e) => closeConn(id, { code: e.code || 'EFAIL', message: e.message }));
    socket.on('close', () => closeConn(id, null));
    if (sender && !watched.has(sender)) {
      watched.add(sender);
      const dropAll = () => {
        for (const [cid, c] of [...conns]) if (c.sender === sender) closeConn(cid, null);
      };
      sender.once('destroyed', dropAll);
      // A reload or a renderer crash keeps the same webContents: its connections belong to the old page.
      sender.on?.('did-navigate', dropAll);
      sender.on?.('render-process-gone', dropAll);
    }
    return { id, remoteAddress: socket.remoteAddress || host };
  });

  api.on('remote:resume', (id, event) => {
    const c = conns.get(id);
    if (!c || c.sender !== event?.sender || !c.start) return;
    const start = c.start;
    c.start = null;
    start();
  });

  api.on('remote:write', (id, data, event) => {
    const c = conns.get(id);
    if (!c || c.sender !== event?.sender) return;
    if (!(data instanceof Uint8Array) || data.length > MAX_WRITE) return;
    if (!c.socket.destroyed) c.socket.write(Buffer.from(data.buffer, data.byteOffset, data.length));
  });

  api.handle('remote:close', async (...args) => {
    const event = args.pop();
    const c = conns.get(args[0]);
    if (c && c.sender === event?.sender) closeConn(args[0], null);
    return true;
  });

  api.handle('remote:storage', async () => ({ file: storeFile(), secure: !!safeStorage() }));
  api.handle('remote:list', async () => (await readStore()).map(publicEntry));
  api.handle('remote:save', async (entry) => {
    if (!entry || typeof entry !== 'object') throw err('Invalid connection.', 'EINVAL');
    const host = typeof entry.host === 'string' ? entry.host.trim() : '';
    if (!hostKind(host)) throw err('Invalid host name or address.', 'EINVAL');
    const port = validPort(entry.port);
    if (!port) throw err('Invalid port (1-65535).', 'EINVAL');
    const name = (typeof entry.name === 'string' ? entry.name.trim() : '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 80) || host;
    const protocol = entry.protocol === 'rdp' ? 'rdp' : 'vnc';
    let extra;
    if (protocol === 'rdp') {
      const user = rdp.validText(typeof entry.user === 'string' ? entry.user.trim() : '', 256);
      const domain = rdp.validText(typeof entry.domain === 'string' ? entry.domain.trim() : '', 256);
      if (user == null) throw err('Invalid user name.', 'EINVAL');
      if (domain == null) throw err('Invalid domain.', 'EINVAL');
      extra = { protocol, user, domain, options: rdp.cleanOptions(entry.options) };
    } else extra = { protocol, clipboard: entry.clipboard !== false };
    if (typeof entry.password === 'string' && entry.password && rdp.validText(entry.password, 512) == null) throw err('Invalid password.', 'EINVAL');
    const list = await readStore();
    let c = typeof entry.id === 'string' ? list.find((x) => x.id === entry.id) : null;
    if (!c) {
      c = { id: crypto.randomBytes(6).toString('hex') };
      list.push(c);
    }
    const oldSecret = c.secret || null;
    for (const k of ['protocol', 'user', 'domain', 'options', 'clipboard']) delete c[k];
    Object.assign(c, { name, host, port }, extra);
    if (!entry.remember) delete c.secret;
    else if (typeof entry.password === 'string' && entry.password !== '') c.secret = sealSecret(entry.password.slice(0, 256));
    else if (oldSecret) c.secret = oldSecret;
    else delete c.secret;
    await writeStore(list);
    return publicEntry(c);
  });
  api.handle('remote:remove', async (id) => {
    const list = await readStore();
    const next = list.filter((c) => c.id !== id);
    if (next.length !== list.length) await writeStore(next);
    return true;
  });
  api.handle('remote:secret', async (id) => {
    const c = (await readStore()).find((x) => x.id === id);
    return c ? openSecret(c.secret) : '';
  });

  // ---------------------------------------------------------------- RDP through FreeRDP
  const sessions = new Map(); // id -> { child, pid, host, port, title, startedAt, log, stopped, sender, secret }
  let rseq = 0;
  const versions = new Map(); // program path -> major version (xfreerdp)

  function inPath(name) {
    for (const d of (process.env.PATH || '/usr/local/bin:/usr/bin:/bin').split(':')) {
      if (!d) continue;
      const p = path.join(d, name);
      try {
        fs.accessSync(p, fs.constants.X_OK);
        if (fs.statSync(p).isFile()) return p;
      } catch {}
    }
    return null;
  }
  function majorVersion(prog) {
    if (versions.has(prog)) return Promise.resolve(versions.get(prog));
    return new Promise((resolve) => {
      execFile(prog, ['--version'], { timeout: 4000, env: { ...process.env, LC_ALL: 'C' } }, (e, out) => {
        const m = /version\s+(\d+)\./i.exec(String(out || ''));
        const v = m ? Number(m[1]) : 0;
        versions.set(prog, v);
        resolve(v);
      });
    });
  }
  /** FreeRDP 3 X11 client: xfreerdp3 (Ubuntu / Debian name), else xfreerdp when it is version 3 (other distros). */
  async function freerdp() {
    // AURORA_REMOTE_FREERDP: 'none' (tests: FreeRDP missing) or the absolute path of a FreeRDP 3 X11 client
    const forced = process.env.AURORA_REMOTE_FREERDP;
    if (forced === 'none') return null;
    if (forced) {
      try {
        fs.accessSync(forced, fs.constants.X_OK);
        return path.isAbsolute(forced) ? { program: forced, version: 3 } : null;
      } catch {
        return null;
      }
    }
    const p3 = inPath('xfreerdp3');
    if (p3) return { program: p3, version: 3 };
    const p = inPath('xfreerdp');
    if (p && (await majorVersion(p)) === 3) return { program: p, version: 3 };
    return null;
  }

  api.handle('remote:rdp-status', async () => {
    const f = await freerdp();
    return { available: !!f, program: f ? path.basename(f.program) : null, version: f?.version || null };
  });

  api.handle('remote:rdp-start', async (...args) => {
    const event = args.pop();
    const c = args[0] && typeof args[0] === 'object' ? args[0] : {};
    const bad = (field, message) => err(message, 'EINVAL');
    let host = typeof c.host === 'string' ? c.host.trim() : '';
    if (/^\[.*\]$/.test(host)) host = host.slice(1, -1);
    const kind = hostKind(host);
    if (!kind) throw bad('host', 'Invalid host name or address.');
    const port = validPort(c.port);
    if (!port) throw bad('port', 'Invalid port (1-65535).');
    const user = rdp.validText(typeof c.user === 'string' ? c.user.trim() : '', 256);
    if (user == null) throw bad('user', 'Invalid user name.');
    const domain = rdp.validText(typeof c.domain === 'string' ? c.domain.trim() : '', 256);
    if (domain == null) throw bad('domain', 'Invalid domain.');
    let password = typeof c.password === 'string' ? c.password : '';
    if (!password && typeof c.entryId === 'string') {
      const saved = (await readStore()).find((x) => x.id === c.entryId);
      if (saved?.secret) password = openSecret(saved.secret);
    }
    if (rdp.validText(password, 512) == null) throw bad('password', 'The password contains a line break or another control character.');
    const options = rdp.cleanOptions(c.options);
    if (options.drive) {
      const p = rdp.driveProblem(options.drive);
      if (p) throw err('The shared folder cannot be used.', p === 'EDRIVECHARS' ? 'EINVAL' : 'EDRIVE');
    }
    const title = String(rdp.validText(typeof c.name === 'string' ? c.name.trim().slice(0, 120) : '', 120) || host);
    if (MOCK && !isLoopback(host)) throw err('Network access is disabled in development mode (only this computer can be reached).', 'EOFFLINE');
    if (sessions.size >= MAX_PER_SENDER) throw err('Too many open sessions.', 'ELIMIT');
    const f = await freerdp();
    if (!f) throw err('FreeRDP 3 (xfreerdp3) is not installed.', 'ENOFREERDP');
    const doc = await readDoc();
    const trusted = doc.certs[`${host}:${port}`]?.sha256 || null;
    const lines = rdp.buildArgs({ host, kind, port, user, domain, password, title, options, fingerprint: trusted, screen: c.screen });
    const env = { ...process.env };
    delete env.FREERDP_ASKPASS; // never pop up a separate password program
    const child = spawn(f.program, ['/args-from:stdin'], { stdio: ['pipe', 'pipe', 'pipe'], detached: true, env, cwd: os.homedir() });
    const id = `rdp${++rseq}`;
    const s = { id, child, pid: child.pid, host, port, title, startedAt: Date.now(), log: '', stopped: false, sender: event?.sender || null, secret: password, trusted };
    sessions.set(id, s);
    const keep = (d) => {
      s.log += d.toString('utf8');
      if (s.log.length > 65536) s.log = s.log.slice(-49152);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.stdin.on('error', () => {});
    child.on('error', (e) => keep(Buffer.from(`\nspawn error: ${e.message}\n`)));
    child.on('close', (code, signal) => {
      clearTimeout(s.killTimer);
      sessions.delete(id);
      const r = rdp.classifyExit(code, signal, s.log, { stopped: s.stopped });
      const msg = { id, state: 'ended', host, port, code: r.code, ended: !!r.ended, exitCode: code, detail: r.ended ? '' : rdp.logExcerpt(s.log, [password]) };
      if (r.fingerprint) msg.fingerprint = r.fingerprint;
      if (r.code === 'ECERTNEW' && s.trusted && r.fingerprint && r.fingerprint !== s.trusted) msg.code = 'ECERTCHANGED';
      if (msg.code === 'ECERTCHANGED' && s.trusted) msg.previous = s.trusted;
      s.secret = '';
      const to = s.sender && !s.sender.isDestroyed?.() ? s.sender : null;
      if (to) api.sendTo(to, 'remote:rdp', msg);
      else api.broadcast?.('remote:rdp', msg);
    });
    child.stdin.end(rdp.stdinText(lines));
    return { id, pid: child.pid, title };
  });

  function stopSession(s) {
    if (!s || s.stopped) return;
    s.stopped = true;
    const sig = (name) => {
      try {
        process.kill(-s.pid, name); // its own process group (detached)
      } catch {
        try {
          s.child.kill(name);
        } catch {}
      }
    };
    sig('SIGTERM');
    s.killTimer = setTimeout(() => sig('SIGKILL'), 3000);
  }
  api.handle('remote:rdp-stop', async (id) => {
    stopSession(sessions.get(id));
    return true;
  });
  api.handle('remote:rdp-list', async () => [...sessions.values()].map((s) => ({ id: s.id, pid: s.pid, host: s.host, port: s.port, title: s.title, startedAt: s.startedAt })));
  api.handle('remote:rdp-trust', async (host, port, fp) => {
    host = typeof host === 'string' ? host.trim() : '';
    if (/^\[.*\]$/.test(host)) host = host.slice(1, -1);
    const p = validPort(port);
    if (!hostKind(host) || !p || typeof fp !== 'string' || !/^[0-9a-f]{64}$/.test(fp)) throw err('Invalid certificate.', 'EINVAL');
    const doc = await readDoc();
    doc.certs[`${host}:${p}`] = { sha256: fp, at: new Date().toISOString() };
    await writeDoc(doc);
    return true;
  });
  // FreeRDP runs in its own process group: end the sessions with the shell.
  process.once('exit', () => {
    for (const s of sessions.values()) {
      try {
        process.kill(-s.pid, 'SIGTERM');
      } catch {}
    }
  });
};

module.exports.__test = { hostKind, validPort, isLoopback, sealSecret, openSecret };
