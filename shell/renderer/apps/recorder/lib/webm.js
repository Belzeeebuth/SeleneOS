// Minimal WebM (Matroska / EBML) helpers for the Voice Recorder, with no dependency (works in the renderer and in Node).
//
//   import { fixDuration, readInfo, muxOpus, opusHead } from './webm.js';
//   fixDuration(bytes, ms)       -> Uint8Array   MediaRecorder writes no Duration: add it (or overwrite it) in Segment > Info
//   readInfo(bytes)              -> { duration: ms | null, timecodeScale, codec, channels, sampleRate, blocks } | null
//   muxOpus({ frames, sampleRate, channels, description, durationMs }) -> Uint8Array
//                                   an audio-only WebM from WebCodecs AudioEncoder output
//                                   (frames: [{ data: Uint8Array, timestamp: µs }]; description: OpusHead or null)
//   opusHead(channels, sampleRate, preSkip = 312) -> Uint8Array  the CodecPrivate of an Opus track
//
// Only what MediaRecorder (Chromium) and muxOpus produce has to be understood: EBML header, one Segment (known or
// unknown size) holding Info, Tracks and Clusters. Elements of unknown size other than the Segment and Clusters are
// not expected.

const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  MuxingApp: 0x4d80,
  WritingApp: 0x5741,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackUID: 0x73c5,
  TrackType: 0x83,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  SeekPreRoll: 0x56bb,
  Audio: 0xe1,
  SamplingFrequency: 0xb5,
  Channels: 0x9f,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Cues: 0x1c53bb6b,
};
const MASTER = new Set([ID.Segment, ID.Info, ID.Tracks, ID.TrackEntry, ID.Audio, ID.Cluster]);

// ------------------------------------------------------------------ reading
/** Element id at `pos`: { id, len } (the id keeps its length marker, as in the spec tables). */
function readId(b, pos) {
  const first = b[pos];
  let len = 1;
  while (len <= 4 && !(first & (0x80 >> (len - 1)))) len++;
  if (len > 4 || pos + len > b.length) return null;
  let id = 0;
  for (let i = 0; i < len; i++) id = id * 256 + b[pos + i];
  return { id, len };
}
/** Size vint at `pos`: { size (-1 = unknown), len }. */
function readSize(b, pos) {
  const first = b[pos];
  let len = 1;
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
  if (len > 8 || pos + len > b.length) return null;
  let v = first & (0xff >> len);
  let allOnes = v === 0xff >> len;
  for (let i = 1; i < len; i++) {
    v = v * 256 + b[pos + i];
    if (b[pos + i] !== 0xff) allOnes = false;
  }
  return { size: allOnes ? -1 : v, len };
}
/** The children of b[start..end): [{ id, start, dataStart, size, end }] (unknown sizes run to `end`). */
function children(b, start, end) {
  const out = [];
  let pos = start;
  while (pos < end) {
    const id = readId(b, pos);
    if (!id) break;
    const sz = readSize(b, pos + id.len);
    if (!sz) break;
    const dataStart = pos + id.len + sz.len;
    let stop = sz.size < 0 ? end : Math.min(end, dataStart + sz.size);
    // An unknown-size Cluster ends where the next top-level element starts.
    if (sz.size < 0 && id.id === ID.Cluster) {
      let p = dataStart;
      while (p < end) {
        const cid = readId(b, p);
        if (!cid || cid.id === ID.Cluster || cid.id === ID.Cues) break;
        const cs = readSize(b, p + cid.len);
        if (!cs || cs.size < 0) break;
        p += cid.len + cs.len + cs.size;
      }
      stop = Math.min(end, p);
    }
    out.push({ id: id.id, start: pos, dataStart, size: sz.size, end: stop });
    if (stop <= pos) break;
    pos = stop;
  }
  return out;
}
const uintOf = (b, s, e) => {
  let v = 0;
  for (let i = s; i < e; i++) v = v * 256 + b[i];
  return v;
};
const floatOf = (b, s, e) => {
  const dv = new DataView(b.buffer, b.byteOffset + s, e - s);
  return e - s === 4 ? dv.getFloat32(0) : e - s === 8 ? dv.getFloat64(0) : NaN;
};
const strOf = (b, s, e) => String.fromCharCode(...b.subarray(s, e)).replace(/\0+$/, '');

function segmentOf(b) {
  const top = children(b, 0, b.length);
  if (!top.length || top[0].id !== ID.EBML) return null;
  return top.find((e) => e.id === ID.Segment) || null;
}

/** Basic facts of a WebM file (null when it is not one). */
export function readInfo(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const seg = segmentOf(b);
  if (!seg) return null;
  const out = { duration: null, timecodeScale: 1000000, codec: null, channels: null, sampleRate: null, blocks: 0 };
  for (const el of children(b, seg.dataStart, seg.end)) {
    if (el.id === ID.Info) {
      let dur = null;
      for (const c of children(b, el.dataStart, el.end)) {
        if (c.id === ID.TimecodeScale) out.timecodeScale = uintOf(b, c.dataStart, c.end);
        if (c.id === ID.Duration) dur = floatOf(b, c.dataStart, c.end);
      }
      if (dur != null && Number.isFinite(dur)) out.duration = (dur * out.timecodeScale) / 1e6;
    } else if (el.id === ID.Tracks) {
      const tr = children(b, el.dataStart, el.end).find((c) => c.id === ID.TrackEntry);
      if (tr)
        for (const c of children(b, tr.dataStart, tr.end)) {
          if (c.id === ID.CodecID) out.codec = strOf(b, c.dataStart, c.end);
          if (c.id === ID.Audio)
            for (const a of children(b, c.dataStart, c.end)) {
              if (a.id === ID.Channels) out.channels = uintOf(b, a.dataStart, a.end);
              if (a.id === ID.SamplingFrequency) out.sampleRate = floatOf(b, a.dataStart, a.end);
            }
        }
    } else if (el.id === ID.Cluster) {
      for (const c of children(b, el.dataStart, el.end)) if (c.id === ID.SimpleBlock || c.id === ID.BlockGroup) out.blocks++;
    }
  }
  return out;
}

// ------------------------------------------------------------------ writing
function idBytes(id) {
  const out = [];
  let v = id;
  while (v > 0) {
    out.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return out;
}
function sizeBytes(n) {
  let len = 1;
  while (len < 8 && n >= 2 ** (7 * len) - 1) len++;
  const out = new Array(len);
  let v = n;
  for (let i = len - 1; i >= 0; i--) {
    out[i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  out[0] |= 0x80 >> (len - 1);
  return out;
}
function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
const el = (id, data) => concat([Uint8Array.from(idBytes(id)), Uint8Array.from(sizeBytes(data.length)), data]);
const master = (id, kids) => el(id, concat(kids));
function uint(id, v) {
  const bytes = [];
  let x = v;
  do {
    bytes.unshift(x & 0xff);
    x = Math.floor(x / 256);
  } while (x > 0);
  return el(id, Uint8Array.from(bytes));
}
function float64(id, v) {
  const d = new Uint8Array(8);
  new DataView(d.buffer).setFloat64(0, v);
  return el(id, d);
}
const str = (id, s) => el(id, Uint8Array.from([...s].map((c) => c.charCodeAt(0) & 0xff)));

/** Adds (or overwrites) Segment > Info > Duration. Returns the input unchanged when it is not a WebM file. */
export function fixDuration(bytes, ms) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const seg = segmentOf(b);
  if (!seg || !(ms >= 0)) return b;
  const info = children(b, seg.dataStart, seg.end).find((e) => e.id === ID.Info);
  if (!info || info.size < 0) return b;
  const kids = children(b, info.dataStart, info.end);
  let scale = 1000000;
  for (const c of kids) if (c.id === ID.TimecodeScale) scale = uintOf(b, c.dataStart, c.end) || 1000000;
  const value = (ms * 1e6) / scale;
  const dur = kids.find((c) => c.id === ID.Duration);
  if (dur && (dur.end - dur.dataStart === 8 || dur.end - dur.dataStart === 4)) {
    const out = b.slice();
    const dv = new DataView(out.buffer, out.byteOffset + dur.dataStart, dur.end - dur.dataStart);
    if (dur.end - dur.dataStart === 8) dv.setFloat64(0, value);
    else dv.setFloat32(0, value);
    return out;
  }
  const newInfo = master(ID.Info, [b.subarray(info.dataStart, info.end), float64(ID.Duration, value)]);
  const delta = newInfo.length - (info.end - info.start);
  let head = b.subarray(0, info.start);
  if (seg.size >= 0) {
    // a Segment of known size: rewrite its size with the same vint length
    const id = readId(b, seg.start);
    const old = readSize(b, seg.start + id.len);
    const size = seg.size + delta;
    head = b.slice(0, info.start);
    let v = size;
    for (let i = old.len - 1; i >= 0; i--) {
      head[seg.start + id.len + i] = v & 0xff;
      v = Math.floor(v / 256);
    }
    head[seg.start + id.len] |= 0x80 >> (old.len - 1);
  }
  return concat([head, newInfo, b.subarray(info.end)]);
}

/** The OpusHead identification header (RFC 7845), the CodecPrivate of an A_OPUS track. */
export function opusHead(channels, sampleRate, preSkip = 312) {
  const h = new Uint8Array(19);
  h.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64]); // "OpusHead"
  const dv = new DataView(h.buffer);
  h[8] = 1;
  h[9] = channels;
  dv.setUint16(10, preSkip, true);
  dv.setUint32(12, sampleRate, true);
  dv.setInt16(16, 0, true);
  h[18] = 0;
  return h;
}

/** An audio-only WebM holding the Opus packets of a WebCodecs AudioEncoder. */
export function muxOpus({ frames, sampleRate = 48000, channels = 1, description = null, durationMs = null }) {
  const head = el(
    ID.EBML,
    concat([uint(0x4286, 1), uint(0x42f7, 1), uint(0x42f2, 4), uint(0x42f3, 8), str(0x4282, 'webm'), uint(0x4287, 4), uint(0x4285, 2)]),
  );
  const last = frames.length ? frames[frames.length - 1] : null;
  const dur = durationMs ?? (last ? last.timestamp / 1000 + 20 : 0);
  const info = master(ID.Info, [uint(ID.TimecodeScale, 1000000), str(ID.MuxingApp, 'Selene'), str(ID.WritingApp, 'Selene Voice Recorder'), float64(ID.Duration, dur)]);
  const priv = description && description.byteLength ? new Uint8Array(description.buffer ? description.buffer.slice(description.byteOffset || 0, (description.byteOffset || 0) + description.byteLength) : description) : opusHead(channels, sampleRate);
  const tracks = master(ID.Tracks, [
    master(ID.TrackEntry, [
      uint(ID.TrackNumber, 1),
      uint(ID.TrackUID, 1),
      uint(ID.TrackType, 2),
      str(ID.CodecID, 'A_OPUS'),
      el(ID.CodecPrivate, priv),
      uint(ID.SeekPreRoll, 80000000),
      master(ID.Audio, [float64(ID.SamplingFrequency, sampleRate), uint(ID.Channels, channels)]),
    ]),
  ]);
  const clusters = [];
  let i = 0;
  while (i < frames.length) {
    const base = Math.round(frames[i].timestamp / 1000);
    const blocks = [uint(ID.Timecode, base)];
    while (i < frames.length) {
      const rel = Math.round(frames[i].timestamp / 1000) - base;
      if (rel > 5000 || rel > 32767) break;
      const f = frames[i];
      const hdr = new Uint8Array(4);
      hdr[0] = 0x81; // track 1
      new DataView(hdr.buffer).setInt16(1, rel);
      hdr[3] = 0x80; // keyframe
      blocks.push(el(ID.SimpleBlock, concat([hdr, f.data])));
      i++;
    }
    clusters.push(master(ID.Cluster, blocks));
  }
  return concat([head, master(ID.Segment, [info, tracks, ...clusters])]);
}

export const _internals = { children, readId, readSize, ID, MASTER };
