'use strict';
// Cloud app backend: WebDAV / Nextcloud accounts and file transfers (deliberately light: no sync, no Explorer
// integration, no Google Drive / OneDrive yet).
//
// Channels:
//   cloud:accounts () -> [{ id, kind: 'nextcloud'|'webdav', label, server, user, davUrl }]   (never the password)
//   cloud:addAccount ({ kind, server, user, password, label }) -> account
//        Checks the URL (https only, plain http only for localhost / 127.0.0.1 / ::1 → else EINSECURE / EURL),
//        then tries a PROPFIND on the root (EAUTH on 401/403, ENET / EHTTP otherwise) before saving.
//   cloud:removeAccount (id) -> true
//   cloud:list (id, path) -> { path, entries: [{ name, path, dir, size, mtime (ms), type }] }  folders first, by name
//   cloud:mkdir (id, parentPath, name) -> path            (EEXIST when taken, ENAME for an invalid name)
//   cloud:delete (id, path) -> true                       (the renderer asks for confirmation first)
//   cloud:download (id, path, { opId, overwrite, keepBoth }) -> { file }
//        Saves to the Downloads folder. An existing file is never replaced unless overwrite: true; keepBoth: true
//        picks "name (2).ext". Otherwise rejects EEXIST. Written to a .part file, then renamed.
//   cloud:upload (id, localPath, remoteDir, { opId, overwrite }) -> { path }   (EEXIST when the name is taken)
//   cloud:downloadsDir () -> path
// Event (to the asking window only):
//   cloud:progress { opId, done, total, phase: 'download'|'upload' }
//
// Storage: ~/.config/aurora/cloud/accounts.json (dir 0700, file 0600). App passwords are encrypted with Electron
// safeStorage when a real keyring backs it, otherwise obfuscated with AES-256-GCM and a per-machine key (like Mail).
//
// Dev / tests (api.DEV unless AURORA_REAL_BACKENDS=1): an in-memory mock WebDAV server per account (seeded with a few
// folders and files). It answers PROPFIND with a real multistatus XML document so the parser is exercised too.
// Mock credentials: the password "wrong" is rejected (EAUTH); a server host containing "offline" fails with ENET.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const http = require('http');
const https = require('https');

let safeStorage = null;
try {
  ({ safeStorage } = require('electron'));
} catch {}

const HOME = os.homedir();
const DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'aurora', 'cloud');
const FILE = path.join(DIR, 'accounts.json');

const err = (message, code) => Object.assign(new Error(message), { code, quiet: true });

// ------------------------------------------------------------------ secrets (same scheme as mail.js)
let storageMode = null;
function secretMode() {
  if (storageMode) return storageMode;
  let secure = false;
  try {
    if (safeStorage?.isEncryptionAvailable()) {
      const backend = typeof safeStorage.getSelectedStorageBackend === 'function' ? safeStorage.getSelectedStorageBackend() : 'unknown';
      secure = process.platform !== 'linux' || !['basic_text', 'unknown'].includes(backend);
    }
  } catch {}
  storageMode = { secure };
  return storageMode;
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
  obfKey = crypto.createHash('sha256').update(`aurora-cloud\0${machine}\0${os.userInfo().username}\0${HOME}`).digest();
  return obfKey;
}
function sealSecret(plain) {
  if (plain == null || plain === '') return null;
  if (secretMode().secure) return { m: 'safe', v: safeStorage.encryptString(String(plain)).toString('base64') };
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', obfuscationKey(), iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return { m: 'obf', v: Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64') };
}
function openSecret(sealed) {
  if (!sealed?.v) return '';
  try {
    const buf = Buffer.from(sealed.v, 'base64');
    if (sealed.m === 'safe') return safeStorage.decryptString(buf);
    const d = crypto.createDecipheriv('aes-256-gcm', obfuscationKey(), buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
  } catch {
    return '';
  }
}

// ------------------------------------------------------------------ accounts file
async function readAccounts() {
  try {
    const data = JSON.parse(await fsp.readFile(FILE, 'utf8'));
    return Array.isArray(data?.accounts) ? data.accounts.filter((a) => a && typeof a.id === 'string') : [];
  } catch {
    return [];
  }
}
async function writeAccounts(list) {
  await fsp.mkdir(DIR, { recursive: true, mode: 0o700 });
  const tmp = `${FILE}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify({ version: 1, accounts: list }, null, 2), { mode: 0o600 });
  await fsp.rename(tmp, FILE);
}
const publicAccount = (a) => ({ id: a.id, kind: a.kind, label: a.label, server: a.server, user: a.user, davUrl: a.davUrl });

// ------------------------------------------------------------------ URLs and paths
function checkServer(raw) {
  let s = String(raw || '').trim();
  if (!s) throw err('Enter the server address', 'EURL');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try {
    u = new URL(s);
  } catch {
    throw err('This server address is not valid', 'EURL');
  }
  const local = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(u.hostname.toLowerCase());
  if (u.protocol === 'http:' && !local) throw err('Only secure (https) servers are allowed, except on this computer', 'EINSECURE');
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw err('This server address is not valid', 'EURL');
  if (u.username || u.password) throw err('Do not put the user name in the address', 'EURL');
  u.search = '';
  u.hash = '';
  return u;
}
function davBase(kind, server, user) {
  const u = new URL(server.href);
  let p = u.pathname.replace(/\/+$/, '');
  if (kind === 'nextcloud' && !/\/remote\.php\//.test(p)) p += `/remote.php/dav/files/${encodeURIComponent(user)}`;
  u.pathname = `${p}/`;
  return u.href;
}
/** "/a/b/" style clean remote path, rejecting "..". */
function cleanPath(p) {
  const parts = String(p || '/').split('/').filter((x) => x && x !== '.');
  if (parts.some((x) => x === '..' || x.includes('\0'))) throw err('Invalid path', 'EPATH');
  return `/${parts.join('/')}`;
}
function checkName(name) {
  const n = String(name || '').trim();
  if (!n || n === '.' || n === '..' || /[/\\\0]/.test(n) || n.length > 250) throw err('Invalid name', 'ENAME');
  return n;
}
const joinRemote = (dir, name) => cleanPath(`${dir}/${name}`);
const encPath = (p) => cleanPath(p).split('/').map(encodeURIComponent).join('/');

// ------------------------------------------------------------------ PROPFIND parsing
function xmlText(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
    .trim();
}
function tag(block, name) {
  const m = new RegExp(`<(?:[\\w.-]+:)?${name}\\b[^>]*?(?:/>|>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}>)`, 'i').exec(block);
  return m ? (m[1] ?? '') : null;
}
/** Parses a 207 multistatus body; basePath is the URL pathname of the DAV root. Skips the listed folder itself. */
function parseMultistatus(xml, basePath, dirPath) {
  const out = [];
  const re = /<(?:[\w.-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?response>/gi;
  let m;
  const base = basePath.replace(/\/+$/, '');
  while ((m = re.exec(xml))) {
    const block = m[1];
    let href = xmlText(tag(block, 'href') || '');
    try {
      href = new URL(href, 'http://x').pathname;
    } catch {}
    let rel;
    try {
      rel = decodeURIComponent(href);
    } catch {
      rel = href;
    }
    const decBase = (() => {
      try {
        return decodeURIComponent(base);
      } catch {
        return base;
      }
    })();
    if (rel.startsWith(decBase)) rel = rel.slice(decBase.length);
    let p;
    try {
      p = cleanPath(rel);
    } catch {
      continue;
    }
    if (p === cleanPath(dirPath)) continue;
    const rt = tag(block, 'resourcetype') || '';
    const dir = /<(?:[\w.-]+:)?collection\b/i.test(rt);
    const size = Number(xmlText(tag(block, 'getcontentlength') || '0')) || 0;
    const lm = Date.parse(xmlText(tag(block, 'getlastmodified') || ''));
    out.push({ name: p.split('/').pop(), path: p, dir, size: dir ? 0 : size, mtime: Number.isFinite(lm) ? lm : 0, type: dir ? '' : xmlText(tag(block, 'getcontenttype') || '') });
  }
  return sortEntries(out);
}
const sortEntries = (list) => list.sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })));
const escXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ------------------------------------------------------------------ mock WebDAV server (dev / tests)
const mocks = new Map(); // account id -> Map(path -> { dir, data: Buffer, mtime })
function mockStore(id) {
  if (!mocks.has(id)) {
    const t = Date.UTC(2026, 8, 14, 9, 30);
    const fsMap = new Map();
    const add = (p, data) => fsMap.set(p, data == null ? { dir: true, mtime: t } : { dir: false, data: Buffer.from(data), mtime: t });
    add('/');
    add('/Documents');
    add('/Photos');
    add('/Shared with me');
    add('/Documents/Budget 2026.csv', 'Month,Income,Expenses\nJanuary,3200,2100\nFebruary,3200,1980\n');
    add('/Documents/Meeting notes.md', '# Meeting notes\n\n- Ship the Cloud app\n- Plan the next release\n');
    add('/Photos/Lake.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#38f"/></svg>');
    add('/Readme.md', `# Welcome to Nextcloud\n\n${'This is a sample file stored on your mock server. '.repeat(40)}\n`);
    add('/Nextcloud intro.txt', 'Nextcloud keeps your files, contacts and calendars on a server you trust.\n'.repeat(400));
    mocks.set(id, fsMap);
  }
  return mocks.get(id);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function mockAuth(acc, password) {
  if (/offline/i.test(acc.server)) throw err('The server cannot be reached', 'ENET');
  if (password === 'wrong') throw err('The user name or app password is wrong', 'EAUTH');
}
const mockClient = (acc, password) => ({
  async propfind(dir) {
    mockAuth(acc, password);
    const store = mockStore(acc.id);
    const d = cleanPath(dir);
    const node = store.get(d);
    if (!node) throw err('This folder does not exist', 'ENOENT');
    if (!node.dir) throw err('Not a folder', 'ENOTDIR');
    const base = new URL(acc.davUrl).pathname;
    const responses = [];
    for (const [p, n] of store) {
      if (p !== d && path.posix.dirname(p) !== d) continue;
      const href = base.replace(/\/$/, '') + encPath(p) + (n.dir && p !== '/' ? '/' : '');
      responses.push(
        `<d:response><d:href>${escXml(href)}</d:href><d:propstat><d:prop>` +
          `<d:getlastmodified>${new Date(n.mtime).toUTCString()}</d:getlastmodified>` +
          (n.dir ? '<d:resourcetype><d:collection/></d:resourcetype>' : `<d:resourcetype/><d:getcontentlength>${n.data.length}</d:getcontentlength><d:getcontenttype>application/octet-stream</d:getcontenttype>`) +
          '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>',
      );
    }
    await sleep(40);
    return parseMultistatus(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">${responses.join('')}</d:multistatus>`, base, d);
  },
  async exists(p) {
    mockAuth(acc, password);
    return mockStore(acc.id).has(cleanPath(p));
  },
  async get(p, onChunk) {
    mockAuth(acc, password);
    const n = mockStore(acc.id).get(cleanPath(p));
    if (!n || n.dir) throw err('This file does not exist', 'ENOENT');
    const chunk = Math.max(1, Math.ceil(n.data.length / 8));
    for (let i = 0; i < n.data.length; i += chunk) {
      await sleep(25);
      onChunk(n.data.subarray(i, i + chunk), n.data.length);
    }
    if (!n.data.length) onChunk(Buffer.alloc(0), 0);
  },
  async put(p, file, size, onProgress) {
    mockAuth(acc, password);
    const store = mockStore(acc.id);
    const target = cleanPath(p);
    const parent = store.get(path.posix.dirname(target));
    if (!parent?.dir) throw err('This folder does not exist', 'ENOENT');
    const parts = [];
    let done = 0;
    for await (const c of fs.createReadStream(file, { highWaterMark: Math.max(1024, Math.ceil(size / 8)) })) {
      parts.push(c);
      done += c.length;
      onProgress(done, size);
      await sleep(25);
    }
    store.set(target, { dir: false, data: Buffer.concat(parts), mtime: Date.now() });
  },
  async mkcol(p) {
    mockAuth(acc, password);
    const store = mockStore(acc.id);
    const target = cleanPath(p);
    if (store.has(target)) throw err('This name is already taken', 'EEXIST');
    if (!store.get(path.posix.dirname(target))?.dir) throw err('This folder does not exist', 'ENOENT');
    store.set(target, { dir: true, mtime: Date.now() });
  },
  async remove(p) {
    mockAuth(acc, password);
    const store = mockStore(acc.id);
    const target = cleanPath(p);
    if (target === '/') throw err('Invalid path', 'EPATH');
    if (!store.has(target)) throw err('This item does not exist', 'ENOENT');
    for (const k of [...store.keys()]) if (k === target || k.startsWith(`${target}/`)) store.delete(k);
  },
});

// ------------------------------------------------------------------ real WebDAV client (Node http/https)
function request(acc, password, method, p, { headers = {}, body = null, bodyFile = null, size = 0, onData, onUpload, timeout = 30000 } = {}) {
  const u = new URL(acc.davUrl);
  u.pathname = u.pathname.replace(/\/$/, '') + encPath(p) + (method === 'PROPFIND' || method === 'MKCOL' ? '/' : '');
  if (u.pathname.endsWith('//')) u.pathname = u.pathname.slice(0, -1);
  const lib = u.protocol === 'https:' ? https : http;
  const auth = Buffer.from(`${acc.user}:${password}`).toString('base64');
  return new Promise((resolve, reject) => {
    const req = lib.request(u, { method, headers: { Authorization: `Basic ${auth}`, 'User-Agent': 'AuroraCloud/1.0', ...headers }, timeout }, (res) => {
      const chunks = [];
      const total = Number(res.headers['content-length']) || 0;
      res.on('data', (c) => (onData && res.statusCode < 300 ? onData(c, total) : chunks.push(c)));
      res.on('end', () => {
        const status = res.statusCode;
        const text = Buffer.concat(chunks).toString('utf8');
        if (status === 401 || status === 403) return reject(err('The user name or app password is wrong', 'EAUTH'));
        if (status === 404) return reject(err('This item does not exist', 'ENOENT'));
        if (status === 405 && method === 'MKCOL') return reject(err('This name is already taken', 'EEXIST'));
        if (status >= 400) return reject(err(`The server answered ${status}`, 'EHTTP'));
        // Redirects are not followed: a GET would otherwise "succeed" with an empty body (empty file saved).
        // HEAD keeps its answer (a 3xx there still means the name exists).
        if (status >= 300 && method !== 'HEAD') return reject(err(`The server answered ${status}`, 'EHTTP'));
        resolve({ status, text });
      });
      res.on('error', (e) => reject(err(e.message, 'ENET')));
    });
    req.on('timeout', () => req.destroy(err('The server did not answer in time', 'ENET')));
    req.on('error', (e) => reject(e.code === 'ENET' ? e : err(e.message || 'The server cannot be reached', 'ENET')));
    if (bodyFile) {
      let done = 0;
      const rs = fs.createReadStream(bodyFile);
      rs.on('data', (c) => {
        done += c.length;
        onUpload?.(done, size);
      });
      rs.on('error', (e) => req.destroy(err(e.message, 'EREAD')));
      rs.pipe(req);
    } else req.end(body);
  });
}
const realClient = (acc, password) => ({
  async propfind(dir) {
    const body = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/><d:getcontenttype/></d:prop></d:propfind>';
    const res = await request(acc, password, 'PROPFIND', dir, { headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' }, body });
    return parseMultistatus(res.text, new URL(acc.davUrl).pathname, dir);
  },
  async exists(p) {
    try {
      await request(acc, password, 'HEAD', p);
      return true;
    } catch (e) {
      if (e.code === 'ENOENT') return false;
      throw e;
    }
  },
  async get(p, onChunk) {
    await request(acc, password, 'GET', p, { onData: onChunk, timeout: 120000 });
  },
  async put(p, file, size, onProgress) {
    await request(acc, password, 'PUT', p, { headers: { 'Content-Length': String(size), 'Content-Type': 'application/octet-stream' }, bodyFile: file, size, onUpload: onProgress, timeout: 120000 });
  },
  async mkcol(p) {
    await request(acc, password, 'MKCOL', p);
  },
  async remove(p) {
    if (cleanPath(p) === '/') throw err('Invalid path', 'EPATH');
    await request(acc, password, 'DELETE', p);
  },
});

// ------------------------------------------------------------------ helpers
function downloadsDir() {
  try {
    const txt = fs.readFileSync(path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'user-dirs.dirs'), 'utf8');
    const m = /^XDG_DOWNLOAD_DIR="([^"]+)"/m.exec(txt);
    if (m) {
      const d = m[1].replace(/^\$HOME/, HOME);
      if (d !== HOME) return d;
    }
  } catch {}
  return path.join(HOME, 'Downloads');
}
async function exists(p) {
  try {
    await fsp.lstat(p);
    return true;
  } catch {
    return false;
  }
}
async function uniqueLocal(dir, name) {
  const ext = path.extname(name);
  const base = ext && ext !== name ? name.slice(0, -ext.length) : name;
  for (let i = 2; i < 10000; i++) {
    const cand = path.join(dir, `${base} (${i})${ext && ext !== name ? ext : ''}`);
    if (!(await exists(cand))) return cand;
  }
  throw err('Too many files with this name', 'EEXIST');
}

module.exports = function register(api) {
  const useMock = api.DEV && process.env.AURORA_REAL_BACKENDS !== '1';
  const clientFor = (acc) => (useMock ? mockClient : realClient)(acc, openSecret(acc.secret));
  async function account(id) {
    const acc = (await readAccounts()).find((a) => a.id === id);
    if (!acc) throw err('This account does not exist', 'ENOACCOUNT');
    return acc;
  }
  const progress = (event, opId, phase) => {
    let last = 0;
    return (done, total, force) => {
      const now = Date.now();
      if (!force && now - last < 60 && done < total) return;
      last = now;
      api.sendTo(event?.sender, 'cloud:progress', { opId, phase, done, total });
    };
  };

  api.handle('cloud:accounts', async () => (await readAccounts()).map(publicAccount));
  api.handle('cloud:downloadsDir', () => downloadsDir());

  api.handle('cloud:addAccount', async (opts = {}) => {
    const kind = opts.kind === 'webdav' ? 'webdav' : 'nextcloud';
    const server = checkServer(opts.server);
    const user = String(opts.user || '').trim();
    const password = String(opts.password || '');
    if (!user) throw err('Enter your user name', 'EUSER');
    if (!password) throw err('Enter your app password', 'EPASS');
    const acc = {
      id: crypto.randomUUID(),
      kind,
      label: String(opts.label || '').trim().slice(0, 80) || `${user}@${server.host}`,
      server: server.href.replace(/\/$/, ''),
      user,
      davUrl: davBase(kind, server, user),
    };
    await (useMock ? mockClient : realClient)(acc, password).propfind('/');
    acc.secret = sealSecret(password);
    const list = await readAccounts();
    list.push(acc);
    await writeAccounts(list);
    return publicAccount(acc);
  });

  api.handle('cloud:removeAccount', async (id) => {
    const list = await readAccounts();
    await writeAccounts(list.filter((a) => a.id !== id));
    mocks.delete(id);
    return true;
  });

  api.handle('cloud:list', async (id, p) => {
    const acc = await account(id);
    const dir = cleanPath(p);
    return { path: dir, entries: await clientFor(acc).propfind(dir) };
  });

  api.handle('cloud:mkdir', async (id, parent, name) => {
    const acc = await account(id);
    const target = joinRemote(cleanPath(parent), checkName(name));
    await clientFor(acc).mkcol(target);
    return target;
  });

  api.handle('cloud:delete', async (id, p) => {
    const acc = await account(id);
    await clientFor(acc).remove(cleanPath(p));
    return true;
  });

  // The IPC event is always the last argument: when the renderer omits opts, it lands in opts.
  const split = (opts, event) => (opts && typeof opts.sender === 'object' && !event ? [{}, opts] : [opts || {}, event]);

  api.handle('cloud:download', async (id, p, rawOpts, rawEvent) => {
    const [opts, event] = split(rawOpts, rawEvent);
    const acc = await account(id);
    const remote = cleanPath(p);
    const name = checkName(remote.split('/').pop()).replace(/^\.+/, '_');
    const dir = downloadsDir();
    await fsp.mkdir(dir, { recursive: true });
    let dest = path.join(dir, name);
    if (await exists(dest)) {
      if (opts.keepBoth) dest = await uniqueLocal(dir, name);
      else if (!opts.overwrite) throw err(`"${name}" is already in Downloads`, 'EEXIST');
    }
    // Unique temp name + 'wx': two downloads of the same file at once must not share (and corrupt) one .part file.
    const part = path.join(dir, `.${path.basename(dest)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.part`);
    const fh = await fsp.open(part, 'wx', 0o644);
    const tick = progress(event, opts.opId, 'download');
    let done = 0;
    let writing = Promise.resolve();
    try {
      await clientFor(acc).get(remote, (chunk, total) => {
        done += chunk.length;
        writing = writing.then(() => fh.write(chunk));
        tick(done, total || done);
      });
      await writing;
      await fh.close();
      await fsp.rename(part, dest);
      tick(done, done, true);
      return { file: dest };
    } catch (e) {
      await fh.close().catch(() => {});
      await fsp.rm(part, { force: true }).catch(() => {});
      throw e;
    }
  });

  api.handle('cloud:upload', async (id, localPath, remoteDir, rawOpts, rawEvent) => {
    const [opts, event] = split(rawOpts, rawEvent);
    const acc = await account(id);
    const st = await fsp.stat(String(localPath)).catch(() => null);
    if (!st || !st.isFile()) throw err('This file cannot be read', 'EREAD');
    const target = joinRemote(cleanPath(remoteDir), checkName(path.basename(localPath)));
    const client = clientFor(acc);
    if (!opts.overwrite && (await client.exists(target))) throw err(`"${path.basename(localPath)}" is already in this folder`, 'EEXIST');
    const tick = progress(event, opts.opId, 'upload');
    tick(0, st.size, true);
    await client.put(target, String(localPath), st.size, (d, t) => tick(d, t));
    tick(st.size, st.size, true);
    return { path: target };
  });
};
module.exports.parseMultistatus = parseMultistatus;
module.exports.checkServer = checkServer;
