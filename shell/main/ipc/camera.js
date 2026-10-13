'use strict';
// Camera backend (renderer/apps/camera): writes a video recording to disk while it is being recorded, then gives the
// WebM file a duration so players can seek in it.
//
// MediaRecorder's WebM has no Duration (the length is unknown while recording): players show no length and cannot
// seek. The recording is streamed to a hidden "<dir>/.<name>.part" file (no big buffer in memory, nothing lost if
// the window crashes mid-way), and camera:finish writes the final file: the Segment Info element gets a Duration
// (EBML float64, in TimecodeScale units), the rest of the file is copied as is.
//
//   camera:begin(path)            -> { id, path }   path: the final .webm path (the renderer picks a unique name)
//   camera:append(id, bytes)      -> bytes written so far (ArrayBuffer / Uint8Array); calls are serialized per id
//   camera:finish(id, durationMs) -> { path, size, duration: bool }   (duration false: the file is kept without one)
//   camera:abort(id)              -> true   (the partial file is removed)
//
// Exported for test/camera.unit.mjs: patchWebmDuration(head, durationMs) -> { head, cut } | null
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pipeline } = require('node:stream/promises');

// ------------------------------------------------------------------ EBML (WebM) helpers
const ID_EBML = 0x1a45dfa3;
const ID_SEGMENT = 0x18538067;
const ID_INFO = 0x1549a966;
const ID_TIMECODE_SCALE = 0x2ad7b1;
const ID_DURATION = 0x4489;

function vlen(b) {
  for (let i = 0; i < 8; i++) if (b & (0x80 >> i)) return i + 1;
  return 0;
}
/** Element ID at `pos` (marker bits kept) -> { id, len } | null */
function readId(buf, pos) {
  if (pos >= buf.length) return null;
  const len = vlen(buf[pos]);
  if (!len || len > 4 || pos + len > buf.length) return null;
  let id = 0;
  for (let i = 0; i < len; i++) id = id * 256 + buf[pos + i];
  return { id, len };
}
/** Size vint at `pos` -> { size, len, unknown } | null */
function readSize(buf, pos) {
  if (pos >= buf.length) return null;
  const len = vlen(buf[pos]);
  if (!len || pos + len > buf.length) return null;
  let v = buf[pos] & (0xff >> len);
  let allOnes = v === 0xff >> len;
  for (let i = 1; i < len; i++) {
    v = v * 256 + buf[pos + i];
    if (buf[pos + i] !== 0xff) allOnes = false;
  }
  return { size: v, len, unknown: allOnes };
}
/** A size vint, `len` bytes (or the shortest that fits). */
function sizeVint(value, len = 0) {
  let n = len || 1;
  while (!len && n < 8 && value >= 2 ** (7 * n) - 1) n++;
  if (value >= 2 ** (7 * n) - 1) return null;
  const out = Buffer.alloc(n);
  let v = value;
  for (let i = n - 1; i >= 0; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  out[0] |= 0x80 >> (n - 1);
  return out;
}
function readUint(buf, pos, len) {
  let v = 0;
  for (let i = 0; i < len; i++) v = v * 256 + buf[pos + i];
  return v;
}

/**
 * Adds (or overwrites) the Duration of a WebM file, given its first bytes (EBML header, Segment start, Info…).
 * Returns { head, cut }: the new file is `head` followed by the original bytes from offset `cut`; null when the
 * bytes are not a WebM file this function understands (the file is then kept as it is).
 */
function patchWebmDuration(buf, durationMs) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (!(durationMs > 0)) return null;
  let pos = 0;
  const e = readId(buf, pos);
  if (!e || e.id !== ID_EBML) return null;
  const es = readSize(buf, pos + e.len);
  if (!es || es.unknown) return null;
  pos += e.len + es.len + es.size;
  const s = readId(buf, pos);
  if (!s || s.id !== ID_SEGMENT) return null;
  const segSizePos = pos + s.len;
  const ss = readSize(buf, segSizePos);
  if (!ss) return null;
  pos = segSizePos + ss.len;
  // the Segment's children: find Info (it comes before the first Cluster in MediaRecorder files)
  while (pos < buf.length) {
    const c = readId(buf, pos);
    const cs = c && readSize(buf, pos + c.len);
    if (!c || !cs || cs.unknown) return null;
    const dataStart = pos + c.len + cs.len;
    const end = dataStart + cs.size;
    if (c.id !== ID_INFO) {
      pos = end;
      continue;
    }
    if (end > buf.length) return null;
    let scale = 1e6;
    let durPos = -1;
    let durLen = 0;
    for (let p = dataStart; p < end; ) {
      const k = readId(buf, p);
      const ks = k && readSize(buf, p + k.len);
      if (!k || !ks || ks.unknown) return null;
      const d = p + k.len + ks.len;
      if (k.id === ID_TIMECODE_SCALE && ks.size >= 1 && ks.size <= 8) scale = readUint(buf, d, ks.size) || 1e6;
      if (k.id === ID_DURATION && (ks.size === 4 || ks.size === 8)) (durPos = d), (durLen = ks.size);
      p = d + ks.size;
    }
    const value = (durationMs * 1e6) / scale;
    if (durPos >= 0) {
      // already there: overwrite in place
      const head = Buffer.from(buf.subarray(0, end));
      if (durLen === 8) head.writeDoubleBE(value, durPos);
      else head.writeFloatBE(value, durPos);
      return { head, cut: end };
    }
    const dur = Buffer.alloc(11);
    dur.writeUInt16BE(ID_DURATION, 0);
    dur[2] = 0x88; // size 8
    dur.writeDoubleBE(value, 3);
    const infoSize = sizeVint(cs.size + dur.length, cs.len) || sizeVint(cs.size + dur.length);
    if (!infoSize) return null;
    const grow = dur.length + (infoSize.length - cs.len);
    let segPart = buf.subarray(0, pos);
    if (!ss.unknown) {
      const seg = sizeVint(ss.size + grow, ss.len);
      if (!seg) return null;
      segPart = Buffer.concat([buf.subarray(0, segSizePos), seg, buf.subarray(segSizePos + ss.len, pos)]);
    }
    const head = Buffer.concat([segPart, buf.subarray(pos, pos + c.len), infoSize, buf.subarray(dataStart, end), dur]);
    return { head, cut: end };
  }
  return null;
}

// ------------------------------------------------------------------ recordings
const recs = new Map(); // id -> { final, part, fd, written, queue }
let seq = 0;

function register(api) {
  api.handle('camera:begin', async (finalPath) => {
    const p = String(finalPath || '');
    if (!path.isAbsolute(p) || !/\.webm$/i.test(p) || /\0/.test(p)) throw api.error('Invalid recording path', 'EINVAL');
    // recordings only go inside the home folder (the Camera Roll), like screenrec:open
    const home = path.resolve(os.homedir());
    if (!path.resolve(p).startsWith(home + path.sep)) throw api.error('The folder must be in your home folder', 'EPERM');
    await fsp.mkdir(path.dirname(p), { recursive: true });
    const part = path.join(path.dirname(p), `.${path.basename(p)}.part`);
    const fd = await fsp.open(part, 'w');
    const id = `rec${++seq}`;
    recs.set(id, { final: p, part, fd, written: 0, queue: Promise.resolve() });
    return { id, path: p };
  });

  api.handle('camera:append', (id, data) => {
    const r = recs.get(id);
    if (!r) throw api.error('Unknown recording', 'ENOENT');
    const buf = data instanceof ArrayBuffer ? Buffer.from(new Uint8Array(data)) : Buffer.from(data);
    r.queue = r.queue.then(async () => {
      await r.fd.write(buf, 0, buf.length, r.written);
      r.written += buf.length;
    });
    return r.queue.then(() => r.written);
  });

  api.handle('camera:finish', async (id, durationMs) => {
    const r = recs.get(id);
    if (!r) throw api.error('Unknown recording', 'ENOENT');
    recs.delete(id);
    await r.queue.catch(() => {});
    await r.fd.close().catch(() => {});
    let patched = null;
    try {
      const fh = await fsp.open(r.part, 'r');
      const head = Buffer.alloc(Math.min(r.written, 256 * 1024));
      await fh.read(head, 0, head.length, 0);
      await fh.close();
      patched = patchWebmDuration(head, Number(durationMs));
    } catch {
      patched = null;
    }
    if (patched) {
      const tmp = `${r.part}.fix`;
      try {
        const out = fs.createWriteStream(tmp);
        out.write(patched.head);
        await pipeline(fs.createReadStream(r.part, { start: patched.cut }), out);
        await fsp.rename(tmp, r.final);
        await fsp.unlink(r.part).catch(() => {});
      } catch {
        await fsp.unlink(tmp).catch(() => {});
        patched = null;
      }
    }
    if (!patched) await fsp.rename(r.part, r.final);
    const st = await fsp.stat(r.final);
    return { path: r.final, size: st.size, duration: !!patched };
  });

  api.handle('camera:abort', async (id) => {
    const r = recs.get(id);
    if (!r) return true;
    recs.delete(id);
    await r.queue.catch(() => {});
    await r.fd.close().catch(() => {});
    await fsp.unlink(r.part).catch(() => {});
    return true;
  });
}

module.exports = register;
module.exports.patchWebmDuration = patchWebmDuration;
