'use strict';
// Notes backend: crash-safe storage for the Notes app (renderer/apps/notes).
//
// Layout (inside the user's Documents folder, so notes are visible in File Explorer and get backed up):
//   ~/Documents/Notes/notes.json          index: { version, notebooks: [...], notes: { id: meta } } (+ notes.json.bak)
//   ~/Documents/Notes/<id>/note.html      one self-contained HTML page per note. The body sits between
//                                         <!--aurora:body--> markers and the note's metadata is repeated in
//                                         <meta name="aurora-note">, so the index can always be rebuilt.
//   ~/Documents/Notes/<id>/att-*.png      attachments (pasted / dropped / inserted pictures), referenced from
//                                         the body by relative src (the page also opens fine in a browser)
// Every write goes to a temporary file that is fsync'ed then renamed over the target (atomic on POSIX), and
// writes to one file are serialized, so a crash or power loss leaves either the old or the new version.
//
// Channels:
//   notes:open()                         -> { root, index|null, notes: [{ id, meta|null, html, mtime }], firstRun }
//   notes:writeNote(id, { html, meta, title, lang }) -> { mtime }
//   notes:writeIndex(index)              -> true
//   notes:remove(ids)                    -> count of note folders deleted for good
//   notes:duplicate(srcId, dstId)        -> true   (copies the folder: attachments included)
//   notes:attach(id, src)                -> { name, path, size, mime }
//        src = { bytes: Uint8Array, name? } | { dataUrl } | { path } | { url }  (pictures only; url = http(s))
//   notes:gc(id, keepNames)              -> number of unreferenced attachments removed
//   notes:exportAssets(id, names, destDir) -> number of files copied (Markdown export "<name>_files")
//   notes:dataUrl(path)                  -> 'data:image/png;base64,…' (HTML export, path inside the notes folder)
//   notes:clipboard()                    -> { html, text, image: Uint8Array|null }  (menu "Paste")
//   notes:clipboardWriteImage(bytes)     -> true   (picture menu "Copy"; PNG / JPEG bytes)
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const HOME = os.homedir();
const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
const ATT_RE = /^att-[a-z0-9]{8}(?:-[a-z0-9-]{1,40})?\.[a-z0-9]{2,5}$/;
const MAX_ATTACHMENT = 50 * 1024 * 1024;
const MAX_NOTE = 32 * 1024 * 1024;
const MAX_INDEX = 64 * 1024 * 1024;
const MAX_IDS = 10000;
const BODY_START = '<!--aurora:body-->';
const BODY_END = '<!--/aurora:body-->';

const IMAGE_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  ico: 'image/x-icon',
};
const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp', 'image/svg+xml': 'svg', 'image/avif': 'avif', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico' };

function documentsDir() {
  let dir = path.join(HOME, 'Documents');
  try {
    const txt = fs.readFileSync(path.join(HOME, '.config', 'user-dirs.dirs'), 'utf8');
    const m = /^XDG_DOCUMENTS_DIR="(.*)"/m.exec(txt);
    if (m) dir = m[1].replace('$HOME', HOME);
  } catch {}
  return dir;
}

function rootDir() {
  return path.join(documentsDir(), 'Notes');
}

function err(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function noteDir(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw err('Invalid note id', 'EINVAL');
  return path.join(rootDir(), id);
}

// The note's folder, refusing one that was replaced by a symlink or a file: writes, collections and exports
// must never follow a link out of the notes folder. (The Notes folder itself may be a link: that's the user's.)
async function safeNoteDir(id) {
  const dir = noteDir(id);
  const st = await fsp.lstat(dir).catch(() => null);
  if (st && !st.isDirectory()) throw err('The note folder is not a folder', 'EACCES');
  return dir;
}

// ---------------------------------------------------------------- atomic, serialized writes
const queues = new Map();
function serialize(key, fn) {
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  queues.set(key, next);
  next.finally(() => {
    if (queues.get(key) === next) queues.delete(key);
  }).catch(() => {});
  return next;
}

async function atomicWrite(file, data) {
  const dir = path.dirname(file);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  const fh = await fsp.open(tmp, 'w', 0o644);
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await fsp.rename(tmp, file);
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
  try {
    const d = await fsp.open(dir, 'r');
    await d.sync().catch(() => {});
    await d.close();
  } catch {}
}

// ---------------------------------------------------------------- note.html
function escAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function unescAttr(s) {
  return String(s)
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

// Standalone styles: the page looks right when opened in a browser (colours match the app's palette).
const PAGE_CSS = `
body{font:16px/1.55 "Segoe UI","Inter","Noto Sans",system-ui,sans-serif;color:#1b1b1b;background:#fff;max-width:820px;margin:40px auto;padding:0 24px}
h1.aurora-title{font-size:30px;line-height:1.25;margin:0 0 24px}
img{max-width:100%;height:auto;border-radius:6px}
pre{font:14px/1.5 "Cascadia Code","DejaVu Sans Mono",monospace;background:#f3f3f3;border-radius:6px;padding:12px 14px;white-space:pre-wrap}
code{font-family:"Cascadia Code","DejaVu Sans Mono",monospace;background:#f0f0f0;border-radius:4px;padding:1px 4px}
blockquote{margin:8px 0;padding:2px 14px;border-left:3px solid #0067c0;color:#444}
table{border-collapse:collapse;margin:8px 0}td,th{border:1px solid #ccc;padding:6px 10px;min-width:48px;vertical-align:top}
ul[data-type=checklist]{list-style:none;padding-left:4px}ul[data-type=checklist]>li::before{content:"\\2610";margin-right:8px}
ul[data-type=checklist]>li[data-checked=true]::before{content:"\\2611"}ul[data-type=checklist]>li[data-checked=true]{color:#777;text-decoration:line-through}
mark{background:#fff3a3;color:inherit}mark[data-hl=green]{background:#c9f2c4}mark[data-hl=blue]{background:#c7e0ff}mark[data-hl=pink]{background:#ffd0e6}mark[data-hl=orange]{background:#ffdcb8}mark[data-hl=purple]{background:#e2d4ff}
[data-color=red]{color:#c42b1c}[data-color=orange]{color:#ca5010}[data-color=green]{color:#0f7b0f}[data-color=blue]{color:#0063b1}[data-color=purple]{color:#8764b8}[data-color=gray]{color:#69797e}
`.trim();

function buildPage({ html, meta, title, lang }) {
  const t = String(title || '').slice(0, 500);
  return [
    '<!doctype html>',
    `<html lang="${escAttr(lang === 'fr' ? 'fr' : 'en')}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="generator" content="Selene Notes">',
    `<meta name="aurora-note" content="${escAttr(JSON.stringify(meta || {}))}">`,
    `<title>${escAttr(t || 'Note')}</title>`,
    `<style>${PAGE_CSS}</style>`,
    '</head>',
    '<body>',
    t ? `<h1 class="aurora-title">${escAttr(t)}</h1>` : '',
    BODY_START,
    String(html || ''),
    BODY_END,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

function parsePage(text) {
  let meta = null;
  const m = /<meta\s+name="aurora-note"\s+content="([^"]*)"\s*\/?>/i.exec(text);
  if (m) {
    try {
      meta = JSON.parse(unescAttr(m[1]));
      if (!meta || typeof meta !== 'object' || Array.isArray(meta)) meta = null;
    } catch {
      meta = null;
    }
  }
  let html = '';
  const a = text.indexOf(BODY_START);
  const b = text.lastIndexOf(BODY_END);
  if (a >= 0 && b > a) html = text.slice(a + BODY_START.length, b);
  else if (a >= 0) {
    // truncated file (disk full / copied while being written elsewhere): keep everything after the marker
    html = text.slice(a + BODY_START.length).replace(/<\/body>\s*(<\/html>\s*)?$/i, '');
  } else {
    // edited by hand / another program: take the <body> (the renderer sanitizes it anyway)
    const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(text);
    html = body ? body[1] : text;
    html = html.replace(/<h1 class="aurora-title">[\s\S]*?<\/h1>/i, '');
  }
  if (!meta) {
    const tt = /<title>([\s\S]*?)<\/title>/i.exec(text);
    if (tt) meta = { title: unescAttr(tt[1]).trim() };
  }
  return { meta, html: html.trim() };
}

// ---------------------------------------------------------------- pictures
function sniff(buf) {
  if (!buf || buf.length < 4) return null;
  const b = buf;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif';
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'bmp';
  if (b.length >= 12 && b.toString('ascii', 4, 8) === 'ftyp' && /avi[fs]/.test(b.toString('ascii', 8, 12))) return 'avif';
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return 'ico';
  const head = b.toString('utf8', 0, Math.min(b.length, 512)).trimStart().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'svg';
  return null;
}

// An SVG is a document that can carry scripts: they never run inside <img> (how notes show pictures), but the
// file could be opened on its own later (File Explorer -> browser). Refuse anything active.
function unsafeSvg(buf) {
  const s = buf.toString('utf8');
  // (the negative look-aheads also exclude quotes / spaces, so backtracking can't skip the opening quote)
  return /<\s*(script|foreignobject|iframe|embed|object|handler|use\b[^>]*href\s*=\s*["']?\s*(?![\s#"']))|\son[a-z]+\s*=|(java|vb)script\s*:|data\s*:\s*text\/html|<!entity|xlink:href\s*=\s*["']?\s*(?![\s#"']|data:image\/)/i.test(s);
}

function slugOf(name) {
  return String(name || '')
    .replace(/\.[^.]*$/, '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '');
}

async function freeAttachmentName(dir, base, ext) {
  for (let i = 0; i < 20; i++) {
    const rand = crypto.randomBytes(6).toString('base64').replace(/[^a-z0-9]/gi, '').toLowerCase().padEnd(8, '0').slice(0, 8);
    const name = `att-${rand}${base ? `-${base}` : ''}.${ext}`;
    try {
      await fsp.lstat(path.join(dir, name));
    } catch {
      return name;
    }
  }
  throw err('Could not find a free file name', 'EEXIST');
}

async function fetchImage(url) {
  if (!/^https?:\/\//i.test(String(url))) throw err('Only http(s) pictures can be downloaded', 'EINVAL');
  const { net } = require('electron');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const res = await net.fetch(url, { signal: ctl.signal, redirect: 'follow' });
    if (!res.ok) throw err(`HTTP ${res.status}`, 'EHTTP');
    const len = Number(res.headers.get('content-length') || 0);
    if (len > MAX_ATTACHMENT) throw err('Picture is too large', 'ETOOBIG');
    // read with a cap (a server can lie about / omit Content-Length)
    const chunks = [];
    let total = 0;
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > MAX_ATTACHMENT) {
          ctl.abort();
          throw err('Picture is too large', 'ETOOBIG');
        }
        chunks.push(Buffer.from(value));
      }
    } else chunks.push(Buffer.from(await res.arrayBuffer()));
    const buf = Buffer.concat(chunks);
    if (buf.length > MAX_ATTACHMENT) throw err('Picture is too large', 'ETOOBIG');
    let fileName = '';
    try {
      fileName = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    } catch {}
    return { buf, mime: String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase(), name: fileName };
  } finally {
    clearTimeout(timer);
  }
}

async function attach(id, src) {
  const dir = noteDir(id);
  if (!src || typeof src !== 'object') throw err('Nothing to attach', 'EINVAL');
  let buf = null;
  let name = typeof src.name === 'string' ? src.name : '';
  let mime = '';
  if (src.bytes) {
    if (!(src.bytes instanceof Uint8Array || src.bytes instanceof ArrayBuffer || Array.isArray(src.bytes))) throw err('Invalid picture data', 'EINVAL');
    if ((src.bytes.byteLength ?? src.bytes.length) > MAX_ATTACHMENT) throw err('Picture is too large', 'ETOOBIG');
    buf = Buffer.from(src.bytes instanceof ArrayBuffer ? new Uint8Array(src.bytes) : src.bytes);
  } else if (typeof src.dataUrl === 'string') {
    if (src.dataUrl.length > MAX_ATTACHMENT * 1.4) throw err('Picture is too large', 'ETOOBIG');
    const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(src.dataUrl);
    if (!m) throw err('Invalid data URL', 'EINVAL');
    mime = (m[1] || '').toLowerCase();
    try {
      buf = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8');
    } catch {
      throw err('Invalid data URL', 'EINVAL');
    }
  } else if (typeof src.path === 'string' && path.isAbsolute(src.path)) {
    const st = await fsp.stat(src.path);
    if (!st.isFile()) throw err('Not a file', 'EISDIR');
    if (st.size > MAX_ATTACHMENT) throw err('Picture is too large', 'ETOOBIG');
    buf = await fsp.readFile(src.path);
    name = name || path.basename(src.path);
  } else if (typeof src.url === 'string') {
    const r = await fetchImage(src.url);
    buf = r.buf;
    mime = r.mime;
    name = name || r.name;
  } else throw err('Nothing to attach', 'EINVAL');
  if (buf.length > MAX_ATTACHMENT) throw err('Picture is too large', 'ETOOBIG');
  // the bytes decide the type (a declared MIME type / extension is never trusted)
  const ext = sniff(buf);
  if (!ext) throw err(mime && !MIME_EXT[mime] ? `Unsupported picture type (${mime})` : 'This file is not a supported picture', 'ENOTIMAGE');
  if (ext === 'svg' && unsafeSvg(buf)) throw err('This SVG picture contains scripts or external content', 'ENOTIMAGE');
  // serialized with notes:gc of the same note: a collection never runs while a picture is being written
  return serialize(attKey(id), async () => {
    await safeNoteDir(id);
    await fsp.mkdir(dir, { recursive: true });
    const file = await freeAttachmentName(dir, slugOf(name), ext);
    await atomicWrite(path.join(dir, file), buf);
    return { name: file, path: path.join(dir, file), size: buf.length, mime: IMAGE_TYPES[ext] };
  });
}

function attKey(id) {
  return `${noteDir(id)}#attachments`;
}

// ---------------------------------------------------------------- open
async function cleanTemps(dir) {
  let names = [];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return;
  }
  for (const n of names) {
    if (!/^\..+\.tmp$/.test(n)) continue;
    try {
      const st = await fsp.stat(path.join(dir, n));
      if (Date.now() - st.mtimeMs > 60000) await fsp.rm(path.join(dir, n), { force: true });
    } catch {}
  }
}

async function readJson(file) {
  try {
    const v = JSON.parse(await fsp.readFile(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

async function open() {
  const root = rootDir();
  await fsp.mkdir(root, { recursive: true });
  await cleanTemps(root);
  const indexFile = path.join(root, 'notes.json');
  const hadIndex = fs.existsSync(indexFile) || fs.existsSync(`${indexFile}.bak`);
  let index = await readJson(indexFile);
  let indexSource = index ? 'main' : 'none';
  if (!index) {
    index = await readJson(`${indexFile}.bak`);
    if (index) indexSource = 'backup';
  }
  const notes = [];
  let entries = [];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {}
  for (const e of entries) {
    if (!e.isDirectory() || !ID_RE.test(e.name)) continue;
    const file = path.join(root, e.name, 'note.html');
    try {
      const st = await fsp.lstat(file); // a symlinked note.html is not followed
      if (!st.isFile()) continue;
      await cleanTemps(path.join(root, e.name));
      if (st.size > MAX_NOTE) {
        notes.push({ id: e.name, meta: null, html: '', mtime: st.mtimeMs, tooBig: true });
        continue;
      }
      const parsed = parsePage(await fsp.readFile(file, 'utf8'));
      notes.push({ id: e.name, meta: parsed.meta, html: parsed.html, mtime: st.mtimeMs });
    } catch {}
  }
  return { root, index, indexSource, notes, firstRun: !hadIndex && notes.length === 0 };
}

async function removeDirs(ids) {
  const list = Array.isArray(ids) ? ids : [ids];
  if (list.length > MAX_IDS) throw err('Too many notes', 'EINVAL');
  const dirs = list.map(noteDir); // validate every id before deleting anything
  let n = 0;
  for (let i = 0; i < dirs.length; i++) {
    const dir = dirs[i];
    // after pending writes of the note file and of its pictures
    await serialize(path.join(dir, 'note.html'), () =>
      serialize(attKey(list[i]), async () => {
        await fsp.rm(dir, { recursive: true, force: true });
      }),
    );
    n++;
  }
  return n;
}

async function copyDir(src, dest) {
  await fsp.mkdir(dest, { recursive: true });
  for (const e of await fsp.readdir(src, { withFileTypes: true })) {
    if (e.name.endsWith('.tmp')) continue;
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) await copyDir(s, d);
    else if (e.isFile()) await fsp.copyFile(s, d);
  }
}

// Clipboard: classic Electron API (readHTML / readImage / writeImage) with a fallback to the asynchronous
// W3C-style clipboard.read / write of newer releases.
async function readClipboard() {
  const { clipboard } = require('electron');
  let html = '';
  let text = '';
  let image = null;
  try {
    if (typeof clipboard.readHTML === 'function') html = clipboard.readHTML() || '';
    if (typeof clipboard.readText === 'function') text = clipboard.readText() || '';
    if (typeof clipboard.readImage === 'function') {
      const img = clipboard.readImage();
      if (img && !img.isEmpty()) image = new Uint8Array(img.toPNG());
    }
  } catch {}
  if ((!html && !text && !image) || typeof clipboard.readImage !== 'function') {
    try {
      for (const item of (typeof clipboard.read === 'function' ? await clipboard.read() : []) || []) {
        const types = item.types || [];
        if (!html && types.includes('text/html')) html = await (await item.getType('text/html')).text();
        if (!text && types.includes('text/plain')) text = await (await item.getType('text/plain')).text();
        const it = types.includes('image/png') ? 'image/png' : types.find((x) => /^image\//.test(x));
        if (!image && it) image = new Uint8Array(await (await item.getType(it)).arrayBuffer());
      }
    } catch {}
  }
  return { html, text, image };
}

async function writeClipboardImage(bytes) {
  const electron = require('electron');
  const { clipboard, nativeImage } = electron;
  if (!bytes || !bytes.length) throw err('No image data', 'EINVAL');
  const buf = Buffer.from(bytes);
  if (typeof clipboard.writeImage === 'function' && nativeImage) {
    const img = nativeImage.createFromBuffer(buf);
    if (img.isEmpty()) throw err('Invalid image data', 'EINVAL');
    clipboard.writeImage(img);
    return true;
  }
  if (!electron.ClipboardItem || typeof clipboard.write !== 'function') throw err('Clipboard pictures are not supported', 'ENOTSUP');
  await clipboard.write([new electron.ClipboardItem({ 'image/png': new Blob([buf], { type: 'image/png' }) })]);
  return true;
}

function insideRoot(p) {
  const root = rootDir();
  const abs = path.resolve(String(p || ''));
  return abs === root || abs.startsWith(root + path.sep);
}

// Real path (symlinks resolved) of an attachment inside the notes folder, or null.
async function realAttachment(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p) || !insideRoot(p)) return null;
  try {
    const [real, root] = await Promise.all([fsp.realpath(p), fsp.realpath(rootDir())]);
    if (!real.startsWith(root + path.sep)) return null;
    const st = await fsp.stat(real);
    return st.isFile() ? { real, size: st.size } : null;
  } catch {
    return null;
  }
}

module.exports = function register(api) {
  api.handle('notes:open', () => open());

  api.handle('notes:writeNote', async (id, data) => {
    // everything up to serialize() is synchronous: writes / removals of a note run in the order they were asked
    const file = path.join(noteDir(id), 'note.html');
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw api.error('Invalid note', 'EINVAL');
    if (data.html != null && typeof data.html !== 'string') throw api.error('Invalid note', 'EINVAL');
    if (typeof data.html === 'string' && data.html.length > MAX_NOTE) throw api.error('This note is too large to be saved', 'ETOOBIG');
    const text = buildPage(data);
    if (Buffer.byteLength(text) > MAX_NOTE) throw api.error('This note is too large to be saved', 'ETOOBIG');
    return serialize(file, async () => {
      await safeNoteDir(id);
      await atomicWrite(file, text);
      const st = await fsp.stat(file);
      return { mtime: st.mtimeMs };
    });
  });

  api.handle('notes:writeIndex', async (index) => {
    if (!index || typeof index !== 'object' || Array.isArray(index)) throw api.error('Invalid index', 'EINVAL');
    if (index.notes != null && (typeof index.notes !== 'object' || Array.isArray(index.notes))) throw api.error('Invalid index', 'EINVAL');
    if (index.notebooks != null && !Array.isArray(index.notebooks)) throw api.error('Invalid index', 'EINVAL');
    const file = path.join(rootDir(), 'notes.json');
    const text = JSON.stringify(index, null, 1);
    if (Buffer.byteLength(text) > MAX_INDEX) throw api.error('The notes index is too large', 'ETOOBIG');
    return serialize(file, async () => {
      // keep the previous good version as a backup (used when notes.json is unreadable). Only a readable
      // index is copied: a damaged notes.json must never replace the good backup it is recovered from.
      try {
        const prev = await fsp.readFile(file, 'utf8');
        const v = JSON.parse(prev);
        if (v && typeof v === 'object' && !Array.isArray(v)) await atomicWrite(`${file}.bak`, prev);
      } catch {}
      await atomicWrite(file, text);
      return true;
    });
  });

  api.handle('notes:remove', (ids) => removeDirs(ids));

  api.handle('notes:duplicate', async (srcId, dstId) => {
    const src = await safeNoteDir(srcId);
    const dst = noteDir(dstId);
    if (src === dst) throw api.error('Same note', 'EINVAL');
    const st = await fsp.lstat(src).catch(() => null);
    if (!st || !st.isDirectory()) throw api.error('Note not found', 'ENOENT');
    if (await fsp.lstat(dst).then(() => true, () => false)) throw api.error('Target exists', 'EEXIST');
    // wait for pending writes of the source (its note file and pictures)
    await serialize(path.join(src, 'note.html'), () => serialize(attKey(srcId), () => copyDir(src, dst))).catch(async (e) => {
      await fsp.rm(dst, { recursive: true, force: true }).catch(() => {});
      throw e;
    });
    return true;
  });

  api.handle('notes:attach', (id, src) => attach(id, src));

  api.handle('notes:gc', async (id, keep) => {
    const dir = noteDir(id);
    if (keep != null && !Array.isArray(keep)) throw api.error('Invalid list', 'EINVAL');
    const keepSet = new Set((keep || []).filter((k) => typeof k === 'string'));
    return serialize(attKey(id), async () => {
      await safeNoteDir(id);
      let n = 0;
      let entries = [];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return 0;
      }
      for (const e of entries) {
        if (!ATT_RE.test(e.name) || keepSet.has(e.name) || e.isDirectory()) continue;
        try {
          await fsp.rm(path.join(dir, e.name), { force: true });
          n++;
        } catch {}
      }
      return n;
    });
  });

  api.handle('notes:exportAssets', async (id, names, destDir) => {
    const dir = await safeNoteDir(id);
    if (typeof destDir !== 'string' || !path.isAbsolute(destDir) || destDir.includes('\0')) throw api.error('Invalid folder', 'EINVAL');
    if (!Array.isArray(names) || names.length > MAX_IDS) throw api.error('Invalid list', 'EINVAL');
    let n = 0;
    for (const name of new Set(names)) {
      // attachment names only (no path separators, no dot files, no note.html): and never through a symlink
      if (typeof name !== 'string' || !ATT_RE.test(name)) continue;
      const src = path.join(dir, name);
      const st = await fsp.lstat(src).catch(() => null);
      if (!st || !st.isFile()) continue;
      await fsp.mkdir(destDir, { recursive: true });
      await fsp.copyFile(src, path.join(destDir, name));
      n++;
    }
    return n;
  });

  api.handle('notes:dataUrl', async (p) => {
    const at = await realAttachment(p);
    if (!at) throw api.error('Not a notes attachment', 'EACCES');
    if (at.size > MAX_ATTACHMENT) throw api.error('Picture is too large', 'ETOOBIG');
    const buf = await fsp.readFile(at.real);
    const ext = sniff(buf);
    if (!ext) throw api.error('Not a picture', 'ENOTIMAGE');
    return `data:${IMAGE_TYPES[ext]};base64,${buf.toString('base64')}`;
  });

  api.handle('notes:clipboard', () => readClipboard());
  api.handle('notes:clipboardWriteImage', (bytes) => writeClipboardImage(bytes));

  api.handle('notes:root', () => rootDir());
};

// exported for unit tests (node)
module.exports.parsePage = parsePage;
module.exports.buildPage = buildPage;
module.exports.sniff = sniff;
module.exports.unsafeSvg = unsafeSvg;
