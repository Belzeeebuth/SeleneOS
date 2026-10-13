// Camera backend, no Electron: main/ipc/camera.js patchWebmDuration (the Duration MediaRecorder leaves out) on
// synthetic WebM heads: unknown Segment size (MediaRecorder), known Segment size (grown by the added bytes), an
// existing Duration (overwritten in place), TimecodeScale other than 1 ms, and files it must leave alone.
// Then the camera:* handlers on a fake ipc: streamed chunks, finish -> final file with a Duration, abort.
// Usage:  cd aurora-os/shell && node test/camera.unit.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const camera = require('../main/ipc/camera.js');
const { patchWebmDuration } = camera;

let passed = 0;
const failures = [];
function check(name, actual, expected) {
  const ok = typeof expected === 'function' ? !!expected(actual) : JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else failures.push(`${name}\n      expected: ${typeof expected === 'function' ? '(predicate)' : JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
}

// ------------------------------------------------------------------ tiny EBML writer / reader
const idBytes = (id) => {
  const out = [];
  let v = id;
  while (v > 0) {
    out.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return Buffer.from(out);
};
const size = (n, len = 0) => {
  let l = len || 1;
  while (!len && n >= 2 ** (7 * l) - 1) l++;
  const b = Buffer.alloc(l);
  let v = n;
  for (let i = l - 1; i >= 0; i--) (b[i] = v % 256), (v = Math.floor(v / 256));
  b[0] |= 0x80 >> (l - 1);
  return b;
};
const el = (id, data, len = 0) => Buffer.concat([idBytes(id), size(data.length, len), data]);
const uint = (n, bytes) => {
  const b = Buffer.alloc(bytes);
  b.writeUIntBE(n, 0, bytes);
  return b;
};
const UNKNOWN = Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
const EBML = el(0x1a45dfa3, Buffer.concat([el(0x4282, Buffer.from('webm')), el(0x4287, uint(4, 1))]));
const TRACKS = el(0x1654ae6b, Buffer.alloc(40, 0x11));
const CLUSTER = el(0x1f43b675, Buffer.concat([el(0xe7, uint(0, 1)), el(0xa3, Buffer.alloc(300, 0x22))]));
const info = (scale = 1000000, extra = Buffer.alloc(0), sizeLen = 8) => el(0x1549a966, Buffer.concat([el(0x2ad7b1, uint(scale, 3)), el(0x4d80, Buffer.from('Chrome')), el(0x5741, Buffer.from('Chrome')), extra]), sizeLen);

/** Parse the Info element of a whole file -> { duration, scale, segKnown, segSize, fileLen, rest } */
function readInfo(buf) {
  const vlen = (b) => [...Array(8).keys()].find((i) => b & (0x80 >> i)) + 1;
  const rid = (p) => {
    const l = vlen(buf[p]);
    return { id: buf.readUIntBE(p, l), len: l };
  };
  const rsz = (p) => {
    const l = vlen(buf[p]);
    let v = buf[p] & (0xff >> l);
    for (let i = 1; i < l; i++) v = v * 256 + buf[p + i];
    return { v, len: l, unknown: buf.subarray(p, p + l).equals(UNKNOWN.subarray(0, l)) && l === 8 };
  };
  let p = 0;
  let a = rid(p);
  let z = rsz(p + a.len);
  p += a.len + z.len + z.v;
  a = rid(p);
  const seg = rsz(p + a.len);
  p += a.len + seg.len;
  const segStart = p;
  const out = { segKnown: !seg.unknown, segSize: seg.v, segData: buf.length - segStart };
  while (p < buf.length) {
    a = rid(p);
    z = rsz(p + a.len);
    const d = p + a.len + z.len;
    if (a.id === 0x1549a966) {
      for (let q = d; q < d + z.v; ) {
        const k = rid(q);
        const ks = rsz(q + k.len);
        const kd = q + k.len + ks.len;
        if (k.id === 0x4489) out.duration = ks.v === 8 ? buf.readDoubleBE(kd) : buf.readFloatBE(kd);
        if (k.id === 0x2ad7b1) out.scale = buf.readUIntBE(kd, ks.v);
        q = kd + ks.v;
      }
    }
    if (a.id === 0x1f43b675) out.cluster = buf.subarray(p).equals(CLUSTER);
    p = d + z.v;
  }
  return out;
}
const apply = (file, ms) => {
  const r = patchWebmDuration(file.subarray(0, Math.min(file.length, 4096)), ms);
  return r && Buffer.concat([r.head, file.subarray(r.cut)]);
};

// ------------------------------------------------------------------ patchWebmDuration
{
  const file = Buffer.concat([EBML, idBytes(0x18538067), UNKNOWN, info(), TRACKS, CLUSTER]);
  const out = apply(file, 2600);
  const r = readInfo(out);
  check('MediaRecorder head: Duration added (ms, scale 1e6)', r.duration, 2600);
  check('grows by the 11-byte Duration element', out.length - file.length, 11);
  check('Segment size stays unknown', r.segKnown, false);
  check('the cluster after Info is intact', r.cluster, true);
}
{
  const body = Buffer.concat([info(), TRACKS, CLUSTER]);
  const file = Buffer.concat([EBML, idBytes(0x18538067), size(body.length, 8), body]);
  const out = apply(file, 1234.5);
  const r = readInfo(out);
  check('known Segment size: Duration added', r.duration, 1234.5);
  check('known Segment size grows with it', [r.segKnown, r.segSize === r.segData], [true, true]);
}
{
  const file = Buffer.concat([EBML, idBytes(0x18538067), UNKNOWN, info(1000000, el(0x4489, Buffer.alloc(8))), TRACKS, CLUSTER]);
  const out = apply(file, 5000);
  check('existing Duration overwritten in place', [readInfo(out).duration, out.length], [5000, file.length]);
}
{
  const file = Buffer.concat([EBML, idBytes(0x18538067), UNKNOWN, info(500000), TRACKS, CLUSTER]);
  check('TimecodeScale 0.5 ms -> value in scale units', readInfo(apply(file, 1000)).duration, 2000);
}
{
  // a one-byte Info size field that must grow (127 bytes of payload + 11 does not fit in 1 byte)
  const big = el(0x1549a966, Buffer.concat([el(0x2ad7b1, uint(1000000, 3)), el(0x4d80, Buffer.alloc(116, 0x41))]), 1);
  const file = Buffer.concat([EBML, idBytes(0x18538067), UNKNOWN, big, TRACKS, CLUSTER]);
  const out = apply(file, 777);
  check('Info size field widened when needed', [readInfo(out).duration, readInfo(out).cluster], [777, true]);
}
check('not WebM -> null', patchWebmDuration(Buffer.from('RIFF....WAVEfmt '), 1000), null);
check('zero duration -> null', patchWebmDuration(Buffer.concat([EBML, idBytes(0x18538067), UNKNOWN, info()]), 0), null);
check('truncated head -> null', patchWebmDuration(Buffer.concat([EBML, idBytes(0x18538067), UNKNOWN, info()]).subarray(0, 30), 1000), null);

// ------------------------------------------------------------------ handlers on a fake ipc
const handlers = {};
camera({ handle: (ch, fn) => (handlers[ch] = fn), error: (m, c) => Object.assign(new Error(m), { code: c }) });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'camera-unit-'));
try {
  const target = path.join(dir, 'Pellicule', 'Vidéo 2026-10-13 10.00.00.webm');
  const { id } = await handlers['camera:begin'](target);
  const file = Buffer.concat([EBML, idBytes(0x18538067), UNKNOWN, info(), TRACKS, CLUSTER]);
  const parts = [file.subarray(0, 50), file.subarray(50, 120), file.subarray(120)];
  const sizes = await Promise.all(parts.map((p) => handlers['camera:append'](id, new Uint8Array(p))));
  check('appends are serialized', sizes[2], file.length);
  check('partial file is hidden while recording', fs.readdirSync(path.dirname(target)), ['.Vidéo 2026-10-13 10.00.00.webm.part']);
  const res = await handlers['camera:finish'](id, 3000);
  check('finish -> final file with a duration', [res.path, res.duration, readInfo(fs.readFileSync(target)).duration], [target, true, 3000]);
  check('no partial file left', fs.readdirSync(path.dirname(target)), [path.basename(target)]);
  // abort removes the partial file
  const b = await handlers['camera:begin'](path.join(dir, 'Pellicule', 'x.webm'));
  await handlers['camera:append'](b.id, new Uint8Array(file));
  await handlers['camera:abort'](b.id);
  check('abort removes the partial file', fs.readdirSync(path.dirname(target)), [path.basename(target)]);
  // a file that is not WebM is kept as is
  const c = await handlers['camera:begin'](path.join(dir, 'Pellicule', 'y.webm'));
  await handlers['camera:append'](c.id, new Uint8Array(Buffer.from('not a webm file')));
  const rc = await handlers['camera:finish'](c.id, 1000);
  check('not WebM: kept unchanged, duration false', [rc.duration, fs.readFileSync(rc.path, 'utf8')], [false, 'not a webm file']);
  // bad paths refused
  let err = null;
  await handlers['camera:begin']('relative/x.webm').catch((e) => (err = e.code));
  check('relative path refused', err, 'EINVAL');
  err = null;
  await handlers['camera:begin'](path.join(dir, 'x.sh')).catch((e) => (err = e.code));
  check('non-.webm path refused', err, 'EINVAL');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  ✗ ${f}`);
process.exit(failures.length ? 1 : 0);
