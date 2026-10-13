// Screen Recorder unit tests (plain Node, no UI):
//   1. lib/capture.js pure helpers: fmtTime, controlPlace (control below / above the area, inside at the top for the
//      whole screen, clamped to the screen).
//   2. backend main/ipc/screenrec.js with a fake IPC registry and a throwaway HOME: open (unique names, folder must be
//      in $HOME), append in order, abort deletes, finish refuses an empty file, finish with ffmpeg remuxes a real WebM
//      and converts it to MP4 (when ffmpeg is installed), unknown ids.
// Run:  cd aurora-os/shell && node test/screenrec.unit.mjs     Prints "N passed, M failed"; exit code 1 on failure.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SHELL = path.join(here, '..');
let passed = 0;
const failures = [];
function check(name, actual, expected) {
  const ok = typeof expected === 'function' ? !!expected(actual) : JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else failures.push(`${name}\n      expected: ${typeof expected === 'function' ? '(predicate)' : JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
}

// ---------------------------------------------------------------- 1. pure helpers
globalThis.window = { innerWidth: 1280, innerHeight: 720 };
const { fmtTime, controlPlace } = await import(pathToFileURL(path.join(SHELL, 'renderer/apps/screenrec/lib/capture.js')).href);
check('fmtTime 0', fmtTime(0), '0:00');
check('fmtTime 59.9 s', fmtTime(59900), '0:59');
check('fmtTime 61 s', fmtTime(61000), '1:01');
check('fmtTime 1 h 2 min 3 s', fmtTime(3723000), '1:02:03');
check('fmtTime negative', fmtTime(-5), '0:00');
const size = { width: 160, height: 40 };
check('below the area', controlPlace({ x: 200, y: 100, width: 400, height: 300 }, size), { left: 320, top: 412, inside: false });
check('above when no room below', controlPlace({ x: 200, y: 300, width: 400, height: 400 }, size), { left: 320, top: 248, inside: false });
check('inside at the top for the whole screen', controlPlace({ x: 0, y: 0, width: 1280, height: 720 }, size), { left: 560, top: 12, inside: true });
check('clamped to the left edge', controlPlace({ x: 0, y: 100, width: 60, height: 100 }, size).left, 8);
check('clamped to the right edge', controlPlace({ x: 1230, y: 100, width: 50, height: 100 }, size).left, 1280 - 160 - 8);
check('inside when the area fills the height', controlPlace({ x: 100, y: 0, width: 300, height: 720 }, size).inside, true);

// ---------------------------------------------------------------- 2. backend
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'screenrec-unit-'));
process.env.HOME = HOME;
const require = createRequire(import.meta.url);
const Module = require('node:module');
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'electron') return { desktopCapturer: { getSources: async () => [] }, screen: { getPrimaryDisplay: () => ({ id: 1 }) } };
  return origLoad.call(this, req, ...rest);
};
const handlers = {};
const api = {
  DEV: true,
  handle: (ch, fn) => (handlers[ch] = fn),
  error: (msg, code) => Object.assign(new Error(msg), { code }),
  getMainWindow: () => null,
};
require(path.join(SHELL, 'main/ipc/screenrec.js'))(api);
const call = (ch, ...a) => Promise.resolve().then(() => handlers[ch](...a));
const errCode = (p) => p.then(() => 'ok', (e) => e.code || e.message);

const dir = path.join(HOME, 'Videos', 'Screen recordings');
check('no screen in plain Node: null', await call('screenrec:source'), null);
check('tools', typeof (await call('screenrec:tools')).ffmpeg, 'boolean');
check('folder outside $HOME refused', await errCode(call('screenrec:open', '/tmp', 'x')), 'EPERM');
check('traversal refused', await errCode(call('screenrec:open', path.join(HOME, '..', '..', 'etc'), 'x')), 'EPERM');
const a = await call('screenrec:open', dir, 'Rec');
const b = await call('screenrec:open', dir, 'Rec');
check('unique names', [path.basename(a.path), path.basename(b.path)], ['Rec.webm', 'Rec (2).webm']);
check('slashes in the name stay in the folder', path.dirname((await call('screenrec:open', dir, '../evil/x')).path), dir);
await call('screenrec:append', a.id, new Uint8Array([1, 2, 3]));
check('append returns the size', await call('screenrec:append', a.id, new Uint8Array([4, 5])), 5);
check('written in order', [...fs.readFileSync(a.path)], [1, 2, 3, 4, 5]);
check('empty / tiny recording refused', await errCode(call('screenrec:finish', a.id, {})), 'ENODATA');
check('…and deleted', fs.existsSync(a.path), false);
await call('screenrec:abort', b.id);
check('abort deletes', fs.existsSync(b.path), false);
check('unknown id', await errCode(call('screenrec:append', 'r999', new Uint8Array([1]))), 'ENOENT');
check('abort of an unknown id is fine', await call('screenrec:abort', 'nope'), true);

let ffmpeg = false;
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  ffmpeg = true;
} catch {}
if (ffmpeg) {
  // a real 1 s VP8 WebM from ffmpeg's test source, written in chunks like MediaRecorder does
  const src = path.join(HOME, 'src.webm');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15', '-t', '1', '-c:v', 'libvpx', '-b:v', '300k', '-f', 'webm', src]);
  const bytes = fs.readFileSync(src);
  for (const mp4 of [false, true]) {
    const f = await call('screenrec:open', dir, mp4 ? 'Clip mp4' : 'Clip');
    for (let i = 0; i < bytes.length; i += 4096) await call('screenrec:append', f.id, new Uint8Array(bytes.subarray(i, i + 4096)));
    const res = await call('screenrec:finish', f.id, { mp4 });
    check(`finish (${mp4 ? 'mp4' : 'webm'}) format`, res.format, mp4 ? 'mp4' : 'webm');
    check(`finish (${mp4 ? 'mp4' : 'webm'}) warning`, res.warning, null);
    check(`finish (${mp4 ? 'mp4' : 'webm'}) size`, res.size, (n) => n > 1000 && n === fs.statSync(res.path).size);
    const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', res.path], { encoding: 'utf8' }).trim());
    check(`finish (${mp4 ? 'mp4' : 'webm'}) has a duration`, dur, (d) => d > 0.8 && d < 1.5);
    if (mp4) check('the WebM is removed after the MP4', fs.existsSync(f.path), false);
  }
  check('no temporary files left', fs.readdirSync(dir).filter((n) => n.includes('.part')), []);
} else console.log('  (ffmpeg not installed: remux / MP4 checks skipped)');

fs.rmSync(HOME, { recursive: true, force: true });
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  ✗ ${f}`).join('\n'));
  process.exit(1);
}
