// Screen Recorder unit tests (plain Node, no UI):
//   1. lib/capture.js pure helpers: fmtTime, controlPlace (control below / above the area, inside at the top for the
//      whole screen, clamped to the screen).
//   2. backend main/ipc/screenrec.js with a fake IPC registry and a throwaway HOME: open (unique names, folder must be
//      in $HOME), append in order, abort deletes, finish refuses an empty file, finish with ffmpeg remuxes a real WebM
//      and converts it to MP4 (when ffmpeg is installed), unknown ids; symlinks resolved (a link in $HOME to a folder
//      outside refused, a dangling link is not reused as a name); files of a renderer that goes away
//      (render-process-gone, reload, destroyed) are closed and dropped (data kept, empty file removed).
// Run:  cd aurora-os/shell && node test/screenrec.unit.mjs     Prints "N passed, M failed"; exit code 1 on failure.
import fs from 'node:fs';
import os from 'node:os';
import { EventEmitter } from 'node:events';
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

// symlinks: "inside home" is checked on the real path
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'screenrec-unit-out-'));
fs.symlinkSync(OUT, path.join(HOME, 'Out'));
check('a link in home to a folder outside refused', await errCode(call('screenrec:open', path.join(HOME, 'Out'), 'x')), 'EPERM');
check('…a folder below that link too', await errCode(call('screenrec:open', path.join(HOME, 'Out', 'sub'), 'x')), 'EPERM');
check('…and nothing created outside', fs.readdirSync(OUT), []);
fs.symlinkSync(path.join(OUT, 'nowhere'), path.join(HOME, 'Dangling'));
check('a dangling link as the folder refused', await errCode(call('screenrec:open', path.join(HOME, 'Dangling', 'x'), 'x')), 'EPERM');
fs.symlinkSync(dir, path.join(HOME, 'Rec link'));
const viaLink = await call('screenrec:open', path.join(HOME, 'Rec link'), 'Via link');
check('a link in home to a folder in home is fine (real path)', viaLink.path, path.join(dir, 'Via link.webm'));
await call('screenrec:abort', viaLink.id);
fs.symlinkSync(path.join(OUT, 'x.webm'), path.join(dir, 'Taken.webm'));
const taken = await call('screenrec:open', dir, 'Taken');
check('a dangling link counts as a taken name', path.basename(taken.path), 'Taken (2).webm');
await call('screenrec:abort', taken.id);
fs.rmSync(path.join(dir, 'Taken.webm'));
check('nothing written outside home', fs.readdirSync(OUT), []);
fs.rmSync(OUT, { recursive: true, force: true });

// files belong to the renderer that opened them: closed and dropped when it goes away
const fdCount = () => (fs.existsSync('/proc/self/fd') ? fs.readdirSync('/proc/self/fd').length : 0);
const waitFor = async (fn, ms = 3000) => {
  const t0 = Date.now();
  while (!(await fn()) && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 20));
  return fn();
};
const fakeSender = (id) => Object.assign(new EventEmitter(), { id, isDestroyed: () => false });
for (const evName of ['render-process-gone', 'did-navigate', 'destroyed']) {
  const sender = fakeSender(100 + evName.length);
  const fds = fdCount();
  const full = await call('screenrec:open', dir, `Owned ${evName}`, { sender });
  const empty = await call('screenrec:open', dir, `Owned empty ${evName}`, { sender });
  await call('screenrec:append', full.id, new Uint8Array(200).fill(7), { sender });
  sender.emit(evName);
  const gone = await waitFor(async () => (await errCode(call('screenrec:append', full.id, new Uint8Array([1])))) === 'ENOENT' && (await errCode(call('screenrec:append', empty.id, new Uint8Array([1])))) === 'ENOENT');
  check(`${evName}: the renderer's files are dropped`, gone, true);
  check(`${evName}: their handles are closed`, await waitFor(() => fdCount() <= fds), true);
  check(`${evName}: what was written is kept, an empty file removed`, [fs.existsSync(full.path) && fs.statSync(full.path).size, fs.existsSync(empty.path)], [200, false]);
  fs.rmSync(full.path, { force: true });
}
{
  // a file finished before its renderer goes away is not touched again; another renderer's files stay open
  const a1 = fakeSender(201);
  const a2 = fakeSender(202);
  const f1 = await call('screenrec:open', dir, 'Mine', { sender: a1 });
  const f2 = await call('screenrec:open', dir, 'Theirs', { sender: a2 });
  await call('screenrec:append', f1.id, new Uint8Array(100), { sender: a1 });
  await call('screenrec:abort', f1.id, { sender: a1 });
  a1.emit('destroyed');
  await new Promise((r) => setTimeout(r, 50));
  check('another renderer keeps its file open', await call('screenrec:append', f2.id, new Uint8Array([1, 2]), { sender: a2 }), 2);
  await call('screenrec:abort', f2.id, { sender: a2 });
  check('both removed by abort', [fs.existsSync(f1.path), fs.existsSync(f2.path)], [false, false]);
}

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
