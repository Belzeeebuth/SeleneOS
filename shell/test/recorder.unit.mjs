// Voice Recorder unit tests (no Electron): the WebM helpers of renderer/apps/recorder/lib/webm.js and fmtTime.
//   fixDuration on a MediaRecorder-like file (unknown-size Segment and Clusters, no Duration), on a known-size
//   Segment, on a file that already has a Duration; muxOpus round trip (readInfo), OpusHead layout, garbage input.
//   Backend main/ipc/recorder.js on a fake IPC with a throwaway HOME: recorder:export refuses files outside $HOME,
//   also through a symlink inside $HOME (to a file, or to a folder, outside), and unknown formats.
// Usage:  cd aurora-os/shell && node test/recorder.unit.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { ROOT } from './lib.mjs';

const webm = await import(pathToFileURL(path.join(ROOT, 'renderer/apps/recorder/lib/webm.js')).href);
const { fmtTime } = await import(pathToFileURL(path.join(ROOT, 'renderer/apps/recorder/lib/audio.js')).href);

let passed = 0;
const failures = [];
function check(name, actual, expected) {
  const ok = typeof expected === 'function' ? !!expected(actual) : JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else failures.push(`${name}\n      expected: ${typeof expected === 'function' ? '(predicate)' : JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
}

// --- a tiny EBML writer for fixtures (independent of the module under test)
const vint = (n, len) => {
  const out = [];
  let v = n;
  for (let i = 0; i < len; i++) {
    out.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  out[0] |= 0x80 >> (len - 1);
  return out;
};
const ids = (id) => {
  const o = [];
  for (let v = id; v > 0; v = Math.floor(v / 256)) o.unshift(v & 0xff);
  return o;
};
const E = (id, data, len = 4) => [...ids(id), ...vint(data.length, len), ...data];
const U = (id, v) => E(id, [v & 0xff], 1);
const S = (id, s) => E(id, [...s].map((c) => c.charCodeAt(0)), 1);
const UNKNOWN = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];

const header = E(0x1a45dfa3, [...U(0x4286, 1), ...S(0x4282, 'webm')]);
const info = E(0x1549a966, [...E(0x2ad7b1, [0x0f, 0x42, 0x40], 1), ...S(0x4d80, 'Chrome'), ...S(0x5741, 'Chrome')]);
const tracks = E(0x1654ae6b, E(0xae, [...U(0xd7, 1), ...S(0x86, 'A_OPUS'), ...E(0xe1, [...U(0x9f, 1)])]));
const block = (rel) => E(0xa3, [0x81, 0, rel, 0x80, 1, 2, 3, 4], 1);
// MediaRecorder style: Segment and Cluster of unknown size
const cluster = [...ids(0x1f43b675), 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, ...U(0xe7, 0), ...block(0), ...block(20), ...block(40)];
const cluster2 = [...ids(0x1f43b675), 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, ...E(0xe7, [0x03, 0xe8], 1), ...block(0)];
const recorded = Uint8Array.from([...header, ...ids(0x18538067), ...UNKNOWN, ...info, ...tracks, ...cluster, ...cluster2]);

{
  const before = webm.readInfo(recorded);
  check('readInfo: MediaRecorder file has no duration', before?.duration, null);
  check('readInfo: codec and channels', [before?.codec, before?.channels], ['A_OPUS', 1]);
  check('readInfo: blocks in unknown-size clusters', before?.blocks, 4);
  const fixed = webm.fixDuration(recorded, 12345.5);
  const after = webm.readInfo(fixed);
  check('fixDuration: duration added (ms)', after?.duration, 12345.5);
  check('fixDuration: tracks and clusters kept', [after?.codec, after?.blocks], ['A_OPUS', 4]);
  check('fixDuration: file grew by the Duration element (11 bytes; the Info size vint is rewritten on 1 byte instead of 4)', fixed.length - recorded.length, 8);
  const again = webm.fixDuration(fixed, 2000);
  check('fixDuration: an existing Duration is overwritten in place', [again.length, webm.readInfo(again)?.duration], [fixed.length, 2000]);
}
{
  // known-size Segment: its size is rewritten
  const body = [...info, ...tracks, ...E(0x1f43b675, [...U(0xe7, 0), ...block(0)])];
  const known = Uint8Array.from([...header, ...E(0x18538067, body, 8)]);
  const fixed = webm.fixDuration(known, 500);
  const r = webm.readInfo(fixed);
  check('fixDuration (known-size Segment): duration and blocks', [r?.duration, r?.blocks, r?.codec], [500, 1, 'A_OPUS']);
  const { children, readId, readSize } = webm._internals;
  const top = children(fixed, 0, fixed.length);
  check('fixDuration (known-size Segment): Segment ends at the end of the file', top[1]?.end, fixed.length);
  check('helpers: readId / readSize', [readId(Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3]), 0)?.id, readSize(Uint8Array.from(UNKNOWN), 0)?.size], [0x1a45dfa3, -1]);
}
{
  const head = webm.opusHead(2, 48000, 312);
  check('opusHead: magic, version, channels, pre-skip, rate', [String.fromCharCode(...head.subarray(0, 8)), head[8], head[9], head[10] | (head[11] << 8), new DataView(head.buffer).getUint32(12, true)], ['OpusHead', 1, 2, 312, 48000]);
  const frames = Array.from({ length: 400 }, (_, i) => ({ data: Uint8Array.from([0xfc, i & 0xff, 1]), timestamp: i * 20000 }));
  const out = webm.muxOpus({ frames, sampleRate: 48000, channels: 1, durationMs: 8000 });
  const r = webm.readInfo(out);
  check('muxOpus: readable WebM with duration, codec, rate, channels', [r?.duration, r?.codec, r?.sampleRate, r?.channels], [8000, 'A_OPUS', 48000, 1]);
  check('muxOpus: every frame is a block (several clusters)', r?.blocks, 400);
  check('muxOpus: no frames still makes a valid file', webm.readInfo(webm.muxOpus({ frames: [], durationMs: 0 }))?.codec, 'A_OPUS');
}
{
  check('readInfo: garbage is not WebM', webm.readInfo(Uint8Array.from([1, 2, 3, 4, 5])), null);
  const junk = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0]);
  check('fixDuration: non-WebM bytes are returned unchanged', webm.fixDuration(junk, 100), junk);
}
{
  check('fmtTime', [fmtTime(0), fmtTime(65.4), fmtTime(3725), fmtTime(5.37, { tenths: true }), fmtTime(5.37, { tenths: true, sep: ',' }), fmtTime(-3)], ['0:00', '1:05', '1:02:05', '0:05.3', '0:05,3', '0:00']);
}

{
  // backend: "inside home" resolves symlinks
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'recorder-unit-home-'));
  const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'recorder-unit-out-'));
  const realHome = process.env.HOME;
  process.env.HOME = HOME;
  try {
    const handlers = {};
    createRequire(import.meta.url)(path.join(ROOT, 'main/ipc/recorder.js'))({ handle: (ch, fn) => (handlers[ch] = fn), error: (m, c) => Object.assign(new Error(m), { code: c }) });
    const code = (...a) => Promise.resolve().then(() => handlers['recorder:export'](...a)).then(() => 'ok', (e) => e.code);
    fs.writeFileSync(path.join(OUT, 'secret.webm'), 'x');
    fs.mkdirSync(path.join(HOME, 'Docs'));
    fs.writeFileSync(path.join(HOME, 'Docs', 'a.webm'), 'x');
    fs.symlinkSync(path.join(OUT, 'secret.webm'), path.join(HOME, 'Docs', 'link.webm'));
    fs.symlinkSync(OUT, path.join(HOME, 'Out'));
    fs.symlinkSync(path.join(OUT, 'gone.webm'), path.join(HOME, 'Docs', 'dangling.webm'));
    check('export: a file outside home refused', await code(path.join(OUT, 'secret.webm'), 'mp3'), 'EACCES');
    check('export: a link in home to a file outside refused', await code(path.join(HOME, 'Docs', 'link.webm'), 'mp3'), 'EACCES');
    check('export: a file in a linked folder outside refused', await code(path.join(HOME, 'Out', 'secret.webm'), 'mp3'), 'EACCES');
    check('export: a dangling link refused', await code(path.join(HOME, 'Docs', 'dangling.webm'), 'mp3'), 'EACCES');
    check('export: the home folder itself refused', await code(HOME, 'mp3'), 'EACCES');
    check('export: unknown format refused', await code(path.join(HOME, 'Docs', 'a.webm'), 'exe'), 'EINVAL');
    check('export: a file in home passes the path check', await code(path.join(HOME, 'Docs', 'a.webm'), 'mp3'), (c) => c !== 'EACCES' && c !== 'EINVAL');
    check('export: nothing written outside home', fs.readdirSync(OUT), ['secret.webm']);
  } finally {
    process.env.HOME = realHome;
    fs.rmSync(HOME, { recursive: true, force: true });
    fs.rmSync(OUT, { recursive: true, force: true });
  }
}

console.log(`recorder.unit: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
