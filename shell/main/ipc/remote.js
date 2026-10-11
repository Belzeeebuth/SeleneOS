'use strict';
// Remote Desktop backend: a raw TCP pipe for the app's VNC (RFB) client, plus the saved connections.
// The renderer's CSP has no network access: the RFB protocol runs in apps/remote/lib/rfb.js and its bytes go through here.
// Nothing else is reachable from this module: one TCP socket to the host and port the user typed.
//
// Channels:
//   remote:connect (host, port, { key, timeoutMs }) -> { id, remoteAddress }
//        host: hostname, IPv4 or IPv6 (validated, no URL, no spaces); port: integer 1..65535.
//        key: identifies the app window: a new connect with the same key closes that window's previous connection
//        (one connection per window). Rejects with code EINVAL, ECONNREFUSED, ETIMEDOUT, ENOTFOUND, EHOSTUNREACH,
//        ENETUNREACH, ELIMIT (too many connections) or EOFFLINE (dev/tests: only loopback hosts, no real network).
//   remote:close (id) -> true
//   remote:list () -> [{ id, name, host, port, remember }]   (saved connections, never with the password)
//   remote:save ({ id?, name, host, port, password?, remember }) -> entry   (password kept only when remember is true;
//        remember with no password keeps the stored one)
//   remote:remove (id) -> true
//   remote:secret (id) -> string ('' when none is stored)
//   remote:storage () -> { file, secure }
// Fire-and-forget (api.send):
//   remote:write (id, Uint8Array)
// Events (only to the window that owns the connection):
//   remote:data   { id, data: Uint8Array }
//   remote:closed { id, error: null | { code, message } }
//
// Saved connections: ~/.local/share/aurora/remote.json ($XDG_DATA_HOME). Passwords are sealed like Mail's: Electron
// safeStorage with a real keyring, else AES-256-GCM with a per-machine key (obfuscation, not secrecy).
// Timeouts: AURORA_REMOTE_TIMEOUT (ms, default 10000) for the TCP connect; idle sockets close after 2 hours.
const net = require('net');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');

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
async function readStore() {
  try {
    const j = JSON.parse(await fsp.readFile(storeFile(), 'utf8'));
    return Array.isArray(j?.connections) ? j.connections.filter((c) => c && typeof c.id === 'string' && hostKind(c.host) && validPort(c.port)) : [];
  } catch {
    return [];
  }
}
async function writeStore(list) {
  await fsp.mkdir(dataDir(), { recursive: true, mode: 0o700 });
  const tmp = `${storeFile()}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify({ version: 1, connections: list }, null, 2), { mode: 0o600 });
  await fsp.rename(tmp, storeFile());
}
const publicEntry = (c) => ({ id: c.id, name: c.name, host: c.host, port: c.port, remember: !!c.secret });
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
    const id = `r${++seq}`;
    conns.set(id, { socket, sender, key });
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30000);
    socket.setTimeout(IDLE_MS, () => closeConn(id, { code: 'ETIMEDOUT', message: 'idle' }));
    socket.on('data', (buf) => {
      if (conns.has(id)) api.sendTo(sender, 'remote:data', { id, data: new Uint8Array(buf.buffer, buf.byteOffset, buf.length) });
    });
    socket.on('error', (e) => closeConn(id, { code: e.code || 'EFAIL', message: e.message }));
    socket.on('close', () => closeConn(id, null));
    if (sender && !watched.has(sender)) {
      watched.add(sender);
      sender.once('destroyed', () => {
        for (const [cid, c] of [...conns]) if (c.sender === sender) closeConn(cid, null);
      });
    }
    return { id, remoteAddress: socket.remoteAddress || host };
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
    const name = (typeof entry.name === 'string' ? entry.name.trim() : '').slice(0, 80) || host;
    const list = await readStore();
    let c = typeof entry.id === 'string' ? list.find((x) => x.id === entry.id) : null;
    if (!c) {
      c = { id: crypto.randomBytes(6).toString('hex') };
      list.push(c);
    }
    const oldSecret = c.secret || null;
    Object.assign(c, { name, host, port });
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
};

module.exports.__test = { hostKind, validPort, isLoopback, sealSecret, openSecret };
