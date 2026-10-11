'use strict';
// Sticky Notes backend (renderer/apps/sticky): one small JSON file, written atomically.
//
// File: ~/.local/share/aurora/sticky.json  (XDG_DATA_HOME respected)  { version: 1, notes: [...], hub: {...} }
//   note = { id, html (sanitized in the renderer), color, created, modified, open, onTop, x, y, w, h }
// Every write goes to a temporary file that is fsync'ed then renamed over the target (atomic on POSIX), and
// writes are serialized; the previous good file is kept as sticky.json.bak and used when the main file is damaged.
//
// Channels:
//   sticky:load()       -> { data: object|null, path, recovered: bool }   (data null on first run)
//   sticky:save(data)   -> true          (throws EINVAL on a malformed document, ETOOBIG over 16 MB)
//   sticky:path()       -> absolute path of the data file
// No network is involved, so the same code runs in dev / tests and in the real session.
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_NOTES = 5000;

function dataFile() {
  const base = process.env.XDG_DATA_HOME && path.isAbsolute(process.env.XDG_DATA_HOME) ? process.env.XDG_DATA_HOME : path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'aurora', 'sticky.json');
}

async function atomicWrite(file, text) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.tmp`;
  let fh;
  try {
    fh = await fsp.open(tmp, 'w', 0o600);
    await fh.writeFile(text, 'utf8');
    await fh.sync();
    await fh.close();
    fh = null;
    await fsp.rename(tmp, file);
  } catch (err) {
    if (fh) await fh.close().catch(() => {});
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

async function readJson(file) {
  try {
    const st = await fsp.stat(file);
    if (!st.isFile() || st.size > MAX_BYTES) return { ok: false, exists: true }; // unusable but present: never overwrite silently
    const v = JSON.parse(await fsp.readFile(file, 'utf8'));
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, exists: true };
    return { ok: true, value: v };
  } catch (err) {
    return { ok: false, exists: err?.code !== 'ENOENT' };
  }
}

function valid(data) {
  return data && typeof data === 'object' && !Array.isArray(data) && Array.isArray(data.notes) && data.notes.length <= MAX_NOTES && data.notes.every((n) => n && typeof n === 'object' && typeof n.id === 'string' && n.id.length <= 64 && (n.html == null || typeof n.html === 'string'));
}

let chain = Promise.resolve();
function serialize(fn) {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}

module.exports = function register(api) {
  api.handle('sticky:path', () => dataFile());

  api.handle('sticky:load', () =>
    serialize(async () => {
      const file = dataFile();
      const main = await readJson(file);
      if (main.ok && valid(main.value)) return { data: main.value, path: file, recovered: false };
      const bak = await readJson(`${file}.bak`);
      if (bak.ok && valid(bak.value)) return { data: bak.value, path: file, recovered: true };
      if (main.exists) {
        // damaged and no backup: keep the broken file aside so the next save never destroys it silently
        await fsp.copyFile(file, `${file}.damaged`).catch(() => {});
      }
      return { data: null, path: file, recovered: !!main.exists };
    }),
  );

  api.handle('sticky:save', (data) => {
    if (!valid(data)) throw api.error('Invalid sticky notes data', 'EINVAL');
    const text = JSON.stringify(data);
    if (Buffer.byteLength(text) > MAX_BYTES) throw api.error('Too much data', 'ETOOBIG');
    return serialize(async () => {
      const file = dataFile();
      try {
        const prev = await fsp.readFile(file, 'utf8');
        if (valid(JSON.parse(prev))) await atomicWrite(`${file}.bak`, prev);
      } catch {}
      await atomicWrite(file, text);
      return true;
    });
  });
};

module.exports.dataFile = dataFile;
