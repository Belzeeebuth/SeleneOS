'use strict';
// Photos app backend: library scanning, image metadata (dimensions + EXIF), thumbnail disk cache,
// lossless JPEG rotation (EXIF orientation rewrite), atomic image writes and folder watching.
//
//   photos:scan (roots[], {prune})    -> { items: [Item], errors: [{path, message}], thumbDir }
//   photos:folder (dir)               -> { items: [Item], dirs: [{name, path}] }   (non-recursive)
//   photos:items (paths[])            -> [Item | null]   metadata for given files (same order)
//   photos:meta (path)                -> { w, h, o, taken, make, model, lens, exposure, fnumber, iso, focal,
//                                          flash, software, gps: {lat, lon} | null, size, mtime, ctime }
//   photos:thumbDir                   -> absolute dir of the thumbnail cache
//   photos:thumbPut (key, bytes)      -> absolute path of the written thumbnail (<key>.webp)
//   photos:rotate (path, steps)       -> { done: true, orientation } (JPEG: lossless EXIF rewrite) | { done: false }
//   photos:write (path, bytes)        -> Entry   atomic write (tmp + rename), creates parent dirs
//   photos:copyFile (src, dest)       -> Entry   byte copy, overwrites dest (the save picker already confirmed)
//   photos:watch (roots[])            -> watchId ; event 'photos:changed' { watchId } (debounced) ; photos:unwatch (id)
//
// Item = { path, name, dir, ext, size, mtime, w, h, o, taken, key, thumb }
//   w/h are display dimensions (EXIF orientation applied), o = EXIF orientation (1..8),
//   taken = EXIF DateTimeOriginal in ms (local time) or null, key = thumbnail cache key
//   (sha1 of path|mtime|size), thumb = a cached thumbnail exists.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.avif', '.ico']);
const APP_DIR = path.join(os.homedir(), '.config', 'aurora', 'apps', 'photos');
const THUMB_DIR = path.join(APP_DIR, 'thumbs');
const INDEX_FILE = path.join(APP_DIR, 'index.json');
const INDEX_VERSION = 2;
const MAX_ITEMS = 100000;
const MAX_DEPTH = 16;
const SKIP_DIRS = new Set(['node_modules', '__pycache__', 'lost+found']);

// Orientation composition: rotating the displayed image 90° clockwise / counter-clockwise.
const ROT_CW = { 1: 6, 6: 3, 3: 8, 8: 1, 2: 7, 7: 4, 4: 5, 5: 2 };
const ROT_CCW = { 6: 1, 3: 6, 8: 3, 1: 8, 7: 2, 4: 7, 5: 4, 2: 5 };

function isImage(name) {
  return IMAGE_EXT.has(path.extname(name).toLowerCase());
}

function thumbKey(p, mtime, size) {
  return crypto.createHash('sha1').update(`${p}|${Math.round(mtime)}|${size}`).digest('hex').slice(0, 24);
}

// ------------------------------------------------------------------ file reading helpers
async function readAt(fh, pos, len) {
  const buf = Buffer.alloc(len);
  const { bytesRead } = await fh.read(buf, 0, len, pos);
  return bytesRead < len ? buf.subarray(0, bytesRead) : buf;
}

// ------------------------------------------------------------------ TIFF / EXIF
function tiffReader(buf, start) {
  const le = buf.toString('latin1', start, start + 2) === 'II';
  if (!le && buf.toString('latin1', start, start + 2) !== 'MM') return null;
  const u16 = (o) => (o + 2 <= buf.length ? (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o)) : 0);
  const u32 = (o) => (o + 4 <= buf.length ? (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o)) : 0);
  const i32 = (o) => (o + 4 <= buf.length ? (le ? buf.readInt32LE(o) : buf.readInt32BE(o)) : 0);
  if (u16(start + 2) !== 42) return null;
  const SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
  // Read one IFD -> Map(tag -> { type, count, valueOffset (absolute), value })
  function ifd(off) {
    const tags = new Map();
    const at = start + off;
    if (!off || at + 2 > buf.length) return tags;
    const n = Math.min(u16(at), 512);
    for (let i = 0; i < n; i++) {
      const e = at + 2 + i * 12;
      if (e + 12 > buf.length) break;
      const tag = u16(e);
      const type = u16(e + 2);
      const count = u32(e + 4);
      const size = (SIZES[type] || 1) * count;
      const vo = size <= 4 ? e + 8 : start + u32(e + 8);
      if (vo + Math.min(size, 4096) > buf.length) {
        tags.set(tag, { type, count, entry: e, valueOffset: vo, value: null });
        continue;
      }
      let value = null;
      if (type === 2) value = buf.toString('latin1', vo, vo + Math.min(count, 4096)).replace(/\0[\s\S]*$/, '').trim();
      else if (type === 3) value = count === 1 ? u16(vo) : Array.from({ length: Math.min(count, 64) }, (_, k) => u16(vo + k * 2));
      else if (type === 4) value = count === 1 ? u32(vo) : Array.from({ length: Math.min(count, 64) }, (_, k) => u32(vo + k * 4));
      else if (type === 9) value = i32(vo);
      else if (type === 5 || type === 10) {
        const rat = (k) => {
          const a = type === 5 ? u32(vo + k * 8) : i32(vo + k * 8);
          const b = type === 5 ? u32(vo + k * 8 + 4) : i32(vo + k * 8 + 4);
          return b ? a / b : 0;
        };
        value = count === 1 ? rat(0) : Array.from({ length: Math.min(count, 16) }, (_, k) => rat(k));
      } else if (type === 1 || type === 7) value = count >= 1 ? buf[vo] : null;
      tags.set(tag, { type, count, entry: e, valueOffset: vo, value });
    }
    return tags;
  }
  return { le, u16, u32, ifd, ifd0: u32(start + 4) };
}

function exifDate(s) {
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(s || ''));
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  const t = d.getTime();
  return Number.isFinite(t) && +m[1] > 1900 ? t : null;
}

// Parse an EXIF TIFF block. `full` adds the camera details used by the info pane.
function parseExif(buf, start, full = false) {
  const r = tiffReader(buf, start);
  if (!r) return null;
  const ifd0 = r.ifd(r.ifd0);
  const v = (map, tag) => map.get(tag)?.value ?? null;
  const out = { o: 1, oOffset: null, le: r.le, taken: null };
  const ot = ifd0.get(0x0112);
  // Only a well-formed tag (one SHORT, stored inline in its entry) is used — and may be rewritten in place by
  // a lossless rotation; a malformed one is ignored rather than trusted to point somewhere in the file.
  if (ot && ot.type === 3 && ot.count === 1 && ot.valueOffset === ot.entry + 8) {
    const o = ot.value;
    if (o >= 1 && o <= 8) out.o = o;
    out.oOffset = ot.valueOffset - start; // relative to the TIFF header
  }
  const exifPtr = v(ifd0, 0x8769);
  const exif = exifPtr ? r.ifd(exifPtr) : new Map();
  out.taken = exifDate(v(exif, 0x9003)) || exifDate(v(exif, 0x9004)) || null;
  if (full) {
    out.make = v(ifd0, 0x010f);
    out.model = v(ifd0, 0x0110);
    out.software = v(ifd0, 0x0131);
    out.modified = exifDate(v(ifd0, 0x0132));
    out.exposure = v(exif, 0x829a);
    out.fnumber = v(exif, 0x829d);
    const iso = v(exif, 0x8827);
    out.iso = Array.isArray(iso) ? iso[0] : iso;
    out.focal = v(exif, 0x920a);
    out.focal35 = v(exif, 0xa405);
    out.flash = v(exif, 0x9209);
    out.lens = v(exif, 0xa434);
    out.pixelW = v(exif, 0xa002);
    out.pixelH = v(exif, 0xa003);
    const gpsPtr = v(ifd0, 0x8825);
    if (gpsPtr) {
      const g = r.ifd(gpsPtr);
      const lat = v(g, 2);
      const lon = v(g, 4);
      if (Array.isArray(lat) && Array.isArray(lon) && lat.length >= 3 && lon.length >= 3) {
        const dms = (a) => a[0] + a[1] / 60 + a[2] / 3600;
        let la = dms(lat);
        let lo = dms(lon);
        if (String(v(g, 1)).toUpperCase().startsWith('S')) la = -la;
        if (String(v(g, 3)).toUpperCase().startsWith('W')) lo = -lo;
        if (Number.isFinite(la) && Number.isFinite(lo) && (la || lo)) out.gps = { lat: la, lon: lo };
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ format headers
// JPEG: walk the marker segments with small positioned reads (ICC/XMP segments can be large).
async function jpegInfo(fh, full) {
  const head = await readAt(fh, 0, 4);
  if (head.length < 4 || head[0] !== 0xff || head[1] !== 0xd8) return null;
  let pos = 2;
  let w = 0;
  let h = 0;
  let exif = null;
  let exifPos = null;
  let guard = 0;
  while (guard++ < 400) {
    const hdr = await readAt(fh, pos, 4);
    if (hdr.length < 2) break;
    if (hdr[0] !== 0xff) break;
    let marker = hdr[1];
    if (marker === 0xff) {
      pos += 1; // fill byte
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      pos += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break;
    if (hdr.length < 4) break;
    const len = hdr.readUInt16BE(2);
    if (len < 2) break;
    if (marker === 0xe1 && !exif && len > 14) {
      const seg = await readAt(fh, pos + 4, len - 2);
      if (seg.toString('latin1', 0, 6) === 'Exif\0\0') {
        exif = parseExif(seg, 6, full);
        exifPos = pos + 4 + 6; // absolute offset of the TIFF header
      }
    } else if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const sof = await readAt(fh, pos + 4, 5);
      if (sof.length === 5) {
        h = sof.readUInt16BE(1);
        w = sof.readUInt16BE(3);
      }
      break;
    }
    pos += 2 + len;
  }
  return { w, h, exif, exifPos };
}

function pngInfo(b) {
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47) return null;
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}
function gifInfo(b) {
  if (b.length < 10 || b.toString('latin1', 0, 4) !== 'GIF8') return null;
  return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
}
function bmpInfo(b) {
  if (b.length < 26 || b.toString('latin1', 0, 2) !== 'BM') return null;
  const dib = b.readUInt32LE(14);
  if (dib === 12) return { w: b.readUInt16LE(18), h: b.readUInt16LE(20) };
  return { w: Math.abs(b.readInt32LE(18)), h: Math.abs(b.readInt32LE(22)) };
}
function webpInfo(b) {
  if (b.length < 30 || b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WEBP') return null;
  const kind = b.toString('latin1', 12, 16);
  if (kind === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
  if (kind === 'VP8L') {
    const b0 = b[21];
    const b1 = b[22];
    const b2 = b[23];
    const b3 = b[24];
    return { w: 1 + (((b1 & 0x3f) << 8) | b0), h: 1 + (((b3 & 0xf) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) };
  }
  if (kind === 'VP8X') return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
  return null;
}
function icoInfo(b) {
  if (b.length < 22 || b.readUInt16LE(0) !== 0 || b.readUInt16LE(2) !== 1) return null;
  const n = b.readUInt16LE(4);
  let best = { w: 0, h: 0 };
  for (let i = 0; i < Math.min(n, 64); i++) {
    const o = 6 + i * 16;
    if (o + 16 > b.length) break;
    const w = b[o] || 256;
    const h = b[o + 1] || 256;
    if (w * h > best.w * best.h) best = { w, h };
  }
  return best.w ? best : null;
}
function avifInfo(b) {
  const i = b.indexOf('ispe', 0, 'latin1');
  if (i < 0 || i + 16 > b.length) return null;
  let w = b.readUInt32BE(i + 8);
  let h = b.readUInt32BE(i + 12);
  const r = b.indexOf('irot', 0, 'latin1');
  if (r > 0 && r + 5 <= b.length && (b[r + 4] & 3) % 2 === 1) [w, h] = [h, w];
  return { w, h };
}
function svgInfo(b) {
  const s = b.toString('utf8');
  const m = /<svg\b[^>]*>/i.exec(s);
  if (!m) return null;
  const tag = m[0];
  const attr = (n) => new RegExp(`\\s${n}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag)?.[1];
  const num = (v) => {
    if (!v || /%/.test(v)) return 0;
    const x = parseFloat(v);
    if (!Number.isFinite(x) || x <= 0) return 0;
    const unit = /(px|pt|pc|mm|cm|in|em|ex)?\s*$/i.exec(v)?.[1]?.toLowerCase();
    const k = { pt: 4 / 3, pc: 16, mm: 3.7795, cm: 37.795, in: 96, em: 16, ex: 8 }[unit] || 1;
    return x * k;
  };
  let w = num(attr('width'));
  let h = num(attr('height'));
  const vb = (attr('viewBox') || '').split(/[\s,]+/).map(Number);
  if ((!w || !h) && vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
    if (w && !h) h = (w * vb[3]) / vb[2];
    else if (h && !w) w = (h * vb[2]) / vb[3];
    else {
      w = vb[2];
      h = vb[3];
    }
  }
  if (!w || !h) return { w: 300, h: 150 };
  return { w: Math.round(w), h: Math.round(h) };
}

// Display dimensions + orientation + date taken of one image (fast: header bytes only).
async function imageInfo(p, ext, full = false) {
  let fh;
  try {
    fh = await fsp.open(p, 'r');
    if (ext === '.jpg' || ext === '.jpeg') {
      const j = await jpegInfo(fh, full);
      if (!j) return { w: 0, h: 0, o: 1, taken: null };
      const o = j.exif?.o || 1;
      const swap = o >= 5;
      return { w: swap ? j.h : j.w, h: swap ? j.w : j.h, o, taken: j.exif?.taken || null, exif: j.exif, exifPos: j.exifPos };
    }
    const b = await readAt(fh, 0, ext === '.svg' || ext === '.avif' ? 65536 : 64);
    const info =
      ext === '.png'
        ? pngInfo(b)
        : ext === '.gif'
          ? gifInfo(b)
          : ext === '.bmp'
            ? bmpInfo(b)
            : ext === '.webp'
              ? webpInfo(b)
              : ext === '.ico'
                ? icoInfo(b)
                : ext === '.avif'
                  ? avifInfo(b)
                  : ext === '.svg'
                    ? svgInfo(b)
                    : null;
    // Sniff the real format when the extension lies (a PNG saved as .jpg, …).
    const sniff = info || pngInfo(b) || gifInfo(b) || webpInfo(b) || bmpInfo(b);
    return { w: sniff?.w || 0, h: sniff?.h || 0, o: 1, taken: null };
  } catch {
    return { w: 0, h: 0, o: 1, taken: null };
  } finally {
    await fh?.close().catch(() => {});
  }
}

// ------------------------------------------------------------------ index (metadata cache)
let index = null; // Map path -> [mtime, size, w, h, o, taken]
let indexDirty = false;
let indexTimer = null;
function loadIndex() {
  if (index) return index;
  index = new Map();
  try {
    const j = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    if (j?.v === INDEX_VERSION && j.e && typeof j.e === 'object') for (const [k, v] of Object.entries(j.e)) if (Array.isArray(v)) index.set(k, v);
  } catch {}
  return index;
}
function saveIndexSoon() {
  indexDirty = true;
  clearTimeout(indexTimer);
  indexTimer = setTimeout(async () => {
    if (!indexDirty) return;
    indexDirty = false;
    try {
      await fsp.mkdir(APP_DIR, { recursive: true });
      const tmp = `${INDEX_FILE}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify({ v: INDEX_VERSION, e: Object.fromEntries(index) }));
      await fsp.rename(tmp, INDEX_FILE);
    } catch (err) {
      console.error('[photos] index save failed', err.message);
    }
  }, 800);
}

async function thumbSet() {
  try {
    return new Set((await fsp.readdir(THUMB_DIR)).filter((n) => n.endsWith('.webp')).map((n) => n.slice(0, -5)));
  } catch {
    return new Set();
  }
}

// Build Items for files (with stats), using the index for unchanged files. Bounded concurrency.
async function buildItems(files, thumbs) {
  const idx = loadIndex();
  const out = new Array(files.length);
  let next = 0;
  async function worker() {
    while (next < files.length) {
      const i = next++;
      const f = files[i];
      const ext = path.extname(f.path).toLowerCase();
      let meta = idx.get(f.path);
      if (!meta || meta[0] !== f.mtime || meta[1] !== f.size) {
        const info = await imageInfo(f.path, ext);
        meta = [f.mtime, f.size, info.w, info.h, info.o, info.taken];
        idx.set(f.path, meta);
        indexDirty = true;
      }
      const key = thumbKey(f.path, f.mtime, f.size);
      out[i] = {
        path: f.path,
        name: path.basename(f.path),
        dir: path.dirname(f.path),
        ext,
        size: f.size,
        mtime: f.mtime,
        w: meta[2],
        h: meta[3],
        o: meta[4],
        taken: meta[5],
        key,
        thumb: thumbs.has(key),
      };
    }
  }
  await Promise.all(Array.from({ length: Math.min(24, files.length || 1) }, worker));
  if (indexDirty) saveIndexSoon();
  return out;
}

// Recursive walk collecting image files (skips hidden folders and symlink loops).
async function walk(root, files, errors, seen, depth = 0) {
  if (files.length >= MAX_ITEMS || depth > MAX_DEPTH) return;
  let real;
  try {
    real = await fsp.realpath(root);
  } catch (err) {
    errors.push({ path: root, message: err.message, code: err.code });
    return;
  }
  if (seen.has(real)) return;
  seen.add(real);
  let ents;
  try {
    ents = await fsp.readdir(root, { withFileTypes: true });
  } catch (err) {
    if (depth === 0) errors.push({ path: root, message: err.message, code: err.code });
    return;
  }
  const subdirs = [];
  await Promise.all(
    ents.map(async (e) => {
      if (e.name.startsWith('.')) return;
      const p = path.join(root, e.name);
      let isDir = e.isDirectory();
      let isFile = e.isFile();
      if (e.isSymbolicLink()) {
        try {
          const st = await fsp.stat(p);
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch {
          return;
        }
      }
      if (isDir) {
        if (!SKIP_DIRS.has(e.name) && path.resolve(p) !== APP_DIR) subdirs.push(p);
      } else if (isFile && isImage(e.name)) {
        try {
          const st = await fsp.stat(p);
          if (st.size > 0 && files.length < MAX_ITEMS) files.push({ path: p, size: st.size, mtime: Math.round(st.mtimeMs) });
        } catch {}
      }
    }),
  );
  for (const d of subdirs) await walk(d, files, errors, seen, depth + 1);
}

async function pruneThumbs(keep) {
  let names;
  try {
    names = await fsp.readdir(THUMB_DIR);
  } catch {
    return 0;
  }
  if (names.length < keep.size * 1.2 + 200) return 0;
  const old = Date.now() - 30 * 86400000;
  let n = 0;
  for (const name of names) {
    const k = name.replace(/\.webp$/, '');
    if (keep.has(k)) continue;
    const p = path.join(THUMB_DIR, name);
    try {
      const st = await fsp.stat(p);
      if (st.mtimeMs < old) {
        await fsp.unlink(p);
        n++;
      }
    } catch {}
  }
  return n;
}

async function statEntry(p) {
  const st = await fsp.stat(p);
  return { name: path.basename(p), path: p, dir: st.isDirectory(), size: st.size, mtime: st.mtimeMs, ctime: st.ctimeMs, ext: path.extname(p).toLowerCase() };
}

async function atomicWrite(p, buf) {
  await fsp.mkdir(path.dirname(p), { recursive: true });
  const tmp = path.join(path.dirname(p), `.${path.basename(p)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await fsp.writeFile(tmp, buf);
    // Keep the original permissions when overwriting.
    try {
      const st = await fsp.stat(p);
      await fsp.chmod(tmp, st.mode & 0o7777);
    } catch {}
    await fsp.rename(tmp, p);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

function toBuffer(data) {
  if (data == null) return null;
  if (typeof data === 'string') {
    const m = /^data:[^;,]*(;base64)?,(.*)$/s.exec(data);
    return m ? Buffer.from(m[2], m[1] ? 'base64' : 'utf8') : null;
  }
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data));
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

// Minimal big-endian EXIF APP1 segment holding only an orientation tag.
function orientationApp1(o) {
  const tiff = Buffer.alloc(8 + 2 + 12 + 4);
  tiff.write('MM', 0, 'latin1');
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(1, 8);
  tiff.writeUInt16BE(0x0112, 10);
  tiff.writeUInt16BE(3, 12);
  tiff.writeUInt32BE(1, 14);
  tiff.writeUInt16BE(o, 18);
  tiff.writeUInt32BE(0, 22);
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const head = Buffer.alloc(4);
  head[0] = 0xff;
  head[1] = 0xe1;
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([head, body]);
}

async function rotateJpeg(p, steps, api) {
  const fh = await fsp.open(p, 'r');
  let j;
  try {
    j = await jpegInfo(fh, false);
  } finally {
    await fh.close().catch(() => {});
  }
  if (!j || !j.w) throw api.error('This file isn’t a valid JPEG image.', 'EINVAL');
  let o = j.exif?.o || 1;
  const n = ((steps % 4) + 4) % 4;
  for (let i = 0; i < n; i++) o = ROT_CW[o];
  if (j.exif && j.exif.oOffset != null) {
    // Lossless in-place rewrite of the orientation SHORT.
    const w = await fsp.open(p, 'r+');
    try {
      const b = Buffer.alloc(2);
      if (j.exif.le) b.writeUInt16LE(o, 0);
      else b.writeUInt16BE(o, 0);
      await w.write(b, 0, 2, j.exifPos + j.exif.oOffset);
    } finally {
      await w.close();
    }
    return { done: true, orientation: o };
  }
  if (j.exif) return { done: false }; // EXIF without an orientation tag: let the renderer re-encode
  // No EXIF at all: insert a tiny APP1 after SOI (+ JFIF APP0 when present).
  const buf = await fsp.readFile(p);
  let at = 2;
  if (buf[2] === 0xff && buf[3] === 0xe0) at = 4 + buf.readUInt16BE(4);
  const out = Buffer.concat([buf.subarray(0, at), orientationApp1(o), buf.subarray(at)]);
  await atomicWrite(p, out);
  return { done: true, orientation: o };
}

module.exports = function register(api) {
  api.handle('photos:thumbDir', async () => {
    await fsp.mkdir(THUMB_DIR, { recursive: true });
    return THUMB_DIR;
  });

  api.handle('photos:scan', async (roots, opts = {}) => {
    const list = (Array.isArray(roots) ? roots : [roots]).filter((r) => typeof r === 'string' && path.isAbsolute(r));
    const files = [];
    const errors = [];
    const seen = new Set();
    for (const r of list) await walk(path.resolve(r), files, errors, seen);
    // Same file reachable from two roots (nested user folders): keep it once.
    const uniq = [...new Map(files.map((f) => [f.path, f])).values()];
    const thumbs = await thumbSet();
    const items = await buildItems(uniq, thumbs);
    // Forget index entries of files that disappeared from the scanned folders.
    const found = new Set(uniq.map((f) => f.path));
    const prefixes = list.map((r) => `${path.resolve(r)}${path.sep}`);
    let dropped = 0;
    for (const k of loadIndex().keys()) {
      if (!found.has(k) && prefixes.some((pre) => k.startsWith(pre))) {
        index.delete(k);
        dropped++;
      }
    }
    if (dropped) saveIndexSoon();
    if (opts?.prune) pruneThumbs(new Set(items.map((i) => i.key))).catch(() => {});
    await fsp.mkdir(THUMB_DIR, { recursive: true }).catch(() => {});
    return { items, errors, thumbDir: THUMB_DIR };
  });

  api.handle('photos:folder', async (dir) => {
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw api.error('Invalid folder', 'EINVAL');
    const ents = await fsp.readdir(dir, { withFileTypes: true });
    const files = [];
    const dirs = [];
    await Promise.all(
      ents.map(async (e) => {
        if (e.name.startsWith('.')) return;
        const p = path.join(dir, e.name);
        try {
          const st = e.isSymbolicLink() ? await fsp.stat(p) : null;
          const isDir = st ? st.isDirectory() : e.isDirectory();
          const isFile = st ? st.isFile() : e.isFile();
          if (isDir) dirs.push({ name: e.name, path: p });
          else if (isFile && isImage(e.name)) {
            const s = st || (await fsp.stat(p));
            if (s.size > 0) files.push({ path: p, size: s.size, mtime: Math.round(s.mtimeMs) });
          }
        } catch {}
      }),
    );
    dirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    return { items: await buildItems(files, await thumbSet()), dirs };
  });

  api.handle('photos:items', async (paths) => {
    const list = (Array.isArray(paths) ? paths : []).filter((p) => typeof p === 'string');
    const files = [];
    const pos = [];
    for (let i = 0; i < list.length; i++) {
      try {
        const st = await fsp.stat(list[i]);
        if (st.isFile()) {
          files.push({ path: list[i], size: st.size, mtime: Math.round(st.mtimeMs) });
          pos.push(i);
        }
      } catch {}
    }
    const items = await buildItems(files, await thumbSet());
    const out = list.map(() => null);
    pos.forEach((p, k) => (out[p] = items[k]));
    return out;
  });

  api.handle('photos:meta', async (p) => {
    if (typeof p !== 'string' || !path.isAbsolute(p)) throw api.error('Invalid path', 'EINVAL');
    const st = await fsp.stat(p);
    const ext = path.extname(p).toLowerCase();
    const info = await imageInfo(p, ext, true);
    const e = info.exif || {};
    return {
      w: info.w,
      h: info.h,
      o: info.o,
      taken: info.taken,
      make: e.make || null,
      model: e.model || null,
      lens: e.lens || null,
      software: e.software || null,
      exposure: e.exposure ?? null,
      fnumber: e.fnumber ?? null,
      iso: e.iso ?? null,
      focal: e.focal ?? null,
      focal35: e.focal35 ?? null,
      flash: e.flash ?? null,
      gps: e.gps || null,
      size: st.size,
      mtime: st.mtimeMs,
      ctime: st.ctimeMs,
    };
  });

  api.handle('photos:thumbPut', async (key, bytes) => {
    if (typeof key !== 'string' || !/^[0-9a-f]{8,40}$/.test(key)) throw api.error('Invalid thumbnail key', 'EINVAL');
    const buf = toBuffer(bytes);
    if (!buf || !buf.length || buf.length > 4 * 1024 * 1024) throw api.error('Invalid thumbnail data', 'EINVAL');
    await fsp.mkdir(THUMB_DIR, { recursive: true });
    const p = path.join(THUMB_DIR, `${key}.webp`);
    await atomicWrite(p, buf);
    return p;
  });

  api.handle('photos:rotate', async (p, steps = 1) => {
    if (typeof p !== 'string' || !path.isAbsolute(p)) throw api.error('Invalid path', 'EINVAL');
    const ext = path.extname(p).toLowerCase();
    if (ext !== '.jpg' && ext !== '.jpeg') return { done: false };
    const res = await rotateJpeg(p, Number(steps) || 1, api);
    if (res.done) {
      const st = await fsp.stat(p);
      index?.delete(p);
      return { ...res, mtime: Math.round(st.mtimeMs), size: st.size };
    }
    return res;
  });

  api.handle('photos:write', async (p, bytes) => {
    if (typeof p !== 'string' || !path.isAbsolute(p) || p.includes('\0')) throw api.error('Invalid path', 'EINVAL');
    const buf = toBuffer(bytes);
    if (!buf || !buf.length) throw api.error('Nothing to write', 'EINVAL');
    await atomicWrite(p, buf);
    index?.delete(p);
    return statEntry(p);
  });

  api.handle('photos:copyFile', async (src, dest) => {
    if (![src, dest].every((x) => typeof x === 'string' && path.isAbsolute(x) && !x.includes('\0'))) throw api.error('Invalid path', 'EINVAL');
    if (path.resolve(src) === path.resolve(dest)) return statEntry(dest);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(src, dest);
    return statEntry(dest);
  });

  const watchers = new Map();
  let wseq = 0;
  api.handle('photos:watch', (roots, event) => {
    const id = `pw${++wseq}`;
    const list = (Array.isArray(roots) ? roots : [roots]).filter((r) => typeof r === 'string' && path.isAbsolute(r));
    const ws = [];
    let timer = null;
    const fire = (name) => {
      // Only image files and (extension-less) folder changes matter.
      if (name && /\.[a-z0-9]+$/i.test(name) && !isImage(name)) return;
      if (name && /(^|\/)\./.test(name)) return;
      clearTimeout(timer);
      timer = setTimeout(() => api.sendTo(event?.sender, 'photos:changed', { watchId: id }), 400);
    };
    for (const r of list) {
      try {
        const w = fs.watch(r, { persistent: false, recursive: true }, (_type, name) => fire(name ? String(name) : ''));
        w.on('error', () => {});
        ws.push(w);
      } catch {
        try {
          const w = fs.watch(r, { persistent: false }, (_type, name) => fire(name ? String(name) : ''));
          w.on('error', () => {});
          ws.push(w);
        } catch {}
      }
    }
    watchers.set(id, { ws, clear: () => clearTimeout(timer) });
    return id;
  });
  api.handle('photos:unwatch', (id) => {
    const w = watchers.get(id);
    if (w) {
      w.clear();
      for (const x of w.ws) x.close();
      watchers.delete(id);
    }
    return true;
  });
};

// Exposed for unit tests.
module.exports.ROT_CW = ROT_CW;
module.exports.ROT_CCW = ROT_CCW;
module.exports.parseExif = parseExif;
module.exports.svgInfo = svgInfo;
module.exports.webpInfo = webpInfo;
module.exports.imageInfo = imageInfo;
module.exports.orientationApp1 = orientationApp1;
