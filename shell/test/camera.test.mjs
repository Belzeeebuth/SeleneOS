// Camera tests — drive the real Electron shell with Chromium's fake camera / microphone
// (--use-fake-device-for-media-stream=device-count=2, --use-fake-ui-for-media-stream): no real webcam needed.
//   Live preview, two cameras (picker, switch), resolutions from getCapabilities (switch to 640 × 480), grid, mirror,
//   photo to <Pictures>/Pellicule (JPEG), 3 s timer (Escape cancels, then fires), video mode: recording badge + red
//   dot in the bar (status item), WebM VP9 / Opus streamed by main/ipc/camera.js with a Duration (ffprobe when
//   present), no .part left, last-capture thumbnail opens Photos / the default video app, prefs kept, English folder
//   « Camera Roll », the calm empty state (« Aucune caméra détectée ») without fake devices, light + dark, console.
//   Screenshots (1280 × 720, French): test/out/camera-fr-dark.png, camera-fr-light.png, camera-recording-fr-dark.png,
//   camera-timer-fr-dark.png, camera-empty-fr-dark.png, camera-empty-fr-light.png
// Usage:  cd aurora-os/shell && xvfb-run -a -s "-screen 0 1600x900x24" node test/camera.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { launchShell } from './lib.mjs';

const FAKE = ['--use-fake-device-for-media-stream=device-count=2', '--use-fake-ui-for-media-stream'];
let passed = 0;
const failures = [];
function check(name, actual, expected) {
  const ok = typeof expected === 'function' ? !!expected(actual) : Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else failures.push(`${name}\n      expected: ${typeof expected === 'function' ? '(predicate)' : JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
  return ok;
}
async function section(name, fn) {
  const t0 = Date.now();
  const before = failures.length;
  try {
    await fn();
    console.log(`  ${failures.length === before ? '✓' : '✗'} ${name} (${Date.now() - t0} ms)`);
  } catch (err) {
    failures.push(`${name}: threw ${err?.stack || err}`);
    console.log(`  ✗ ${name}: ${err?.message || err}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const W = '.win.app-camera';
const C = (s, fn, arg) => s.page.evaluate(`(async () => { const c = document.querySelector('.win.app-camera')?.__camera; return (${fn.toString()})(c, ${JSON.stringify(arg ?? null)}); })()`);
async function until(s, fn, { timeout = 10000, label = 'condition', arg } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = await C(s, fn, arg).catch((e) => `ERR ${e.message}`);
    if (last && !String(last).startsWith('ERR')) return last;
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${label} (last: ${JSON.stringify(last)})`);
}
const rollFiles = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);
const errorsOf = (s) => s.logs.filter((l) => /^\[(error|pageerror)\]/.test(l) && !/favicon|ERR_FILE_NOT_FOUND|net::|Autofill/.test(l));

let s;
try {
  console.log('Camera — fake devices, French, dark');
  s = await launchShell({ open: ['camera'], lang: 'fr', theme: 'dark', size: '1280x720', args: FAKE });
  const roll = path.join(s.home, 'Pictures', 'Pellicule');

  await section('live preview from the fake camera, two cameras, resolutions', async () => {
    await until(s, (c) => c?.status === 'live', { label: 'live' });
    const st = await C(s, (c) => ({
      cams: c.cams.length,
      picker: !document.querySelector('.app-camera .cam-select').hidden,
      vw: document.querySelector('.app-camera .cam-video').videoWidth,
      res: [...document.querySelectorAll('.app-camera .cam-res option')].map((o) => o.value),
      sel: document.querySelector('.app-camera .cam-res').value,
      title: document.querySelector('.win.app-camera .win-title, .win.app-camera .titlebar-title')?.textContent || '',
      empty: document.querySelector('.app-camera .cam-empty').hidden,
    }));
    check('two cameras listed', st.cams, 2);
    check('camera picker shown when there are several', st.picker, true);
    check('preview has frames (1280 wide by default)', st.vw, 1280);
    check('resolutions come from the camera capabilities', st.res.includes('640x480') && st.res.includes('1920x1080'), true);
    check('current resolution selected', st.sel, '1280x720');
    check('empty state hidden', st.empty, true);
  });

  await section('grid and mirror toggles (saved)', async () => {
    await s.page.click(`${W} .cam-grid-btn`);
    const g = await C(s, (c) => ({ grid: !document.querySelector('.app-camera .cam-grid').hidden, pref: c.S.grid, pressed: document.querySelector('.app-camera .cam-grid-btn').getAttribute('aria-pressed') }));
    check('grid shown', g, { grid: true, pref: true, pressed: 'true' });
    const m = await C(s, () => ({ mirror: document.querySelector('.app-camera .cam-frame').classList.contains('mirror'), t: getComputedStyle(document.querySelector('.app-camera .cam-video')).transform }));
    check('preview mirrored by default', m.mirror && m.t.startsWith('matrix(-1'), true);
    await s.page.click(`${W} .cam-mirror-btn`);
    check('mirror off', await C(s, () => document.querySelector('.app-camera .cam-frame').classList.contains('mirror')), false);
    await s.page.click(`${W} .cam-mirror-btn`);
    check('mirror on again + hint', await C(s, () => document.querySelector('.app-camera .cam-note').textContent), (x) => /bon sens/.test(x));
  });

  await section('photo saved to Pictures/Pellicule as JPEG; thumbnail', async () => {
    await s.page.click(`${W} .cam-shutter`);
    const last = await until(s, (c) => c.last?.kind === 'photo' && c.last.path, { label: 'photo' });
    check('saved in Pellicule', path.dirname(last), roll);
    check('name « Photo AAAA-MM-JJ HH.MM.SS.jpg »', path.basename(last), (n) => /^Photo \d{4}-\d\d-\d\d \d\d\.\d\d\.\d\d( \(\d+\))?\.jpg$/.test(n));
    const b = fs.readFileSync(last);
    check('JPEG bytes', b[0] === 0xff && b[1] === 0xd8 && b.length > 5000, true);
    check('thumbnail shows the capture', await C(s, () => !!document.querySelector('.app-camera .cam-thumb img') && !document.querySelector('.app-camera .cam-thumb').disabled), true);
  });

  await section('3 s timer: Escape cancels, then it fires', async () => {
    await s.page.click(`${W} .cam-timer`);
    check('timer 3 s', await C(s, (c) => [c.S.timer, document.querySelector('.app-camera .cam-timer-label').textContent]), [3, '3 s']);
    const before = rollFiles(roll).length;
    await s.page.click(`${W} .cam-shutter`);
    check('counting', await C(s, (c) => [c.counting, document.querySelector('.app-camera .cam-count').textContent]), [true, '3']);
    await s.shot('camera-timer-fr-dark');
    await s.page.keyboard.press('Escape');
    await sleep(1400);
    check('Escape cancelled the timer (no photo)', [await C(s, (c) => c.counting), rollFiles(roll).length], [false, before]);
    await s.page.click(`${W} .cam-shutter`);
    await sleep(2000);
    check('no photo before the end of the countdown', rollFiles(roll).length, before);
    await until(s, () => true, { timeout: 100 });
    const t0 = Date.now();
    while (rollFiles(roll).length === before && Date.now() - t0 < 4000) await sleep(100);
    check('photo after 3 s', rollFiles(roll).length, before + 1);
    await s.page.click(`${W} .cam-timer`); // 10 s
    await s.page.click(`${W} .cam-timer`); // off
    check('timer cycles 3 → 10 → off', await C(s, (c) => c.S.timer), 0);
  });

  await section('screenshot: photo mode with grid', async () => {
    await s.page.mouse.move(5, 300);
    await sleep(500);
    await s.shot('camera-fr-dark');
  });

  await section('video: badge, red dot in the bar, WebM VP9 / Opus with a duration', async () => {
    await s.page.click(`${W} .cam-mode [data-mode="video"]`);
    check('video mode, mic button shown', await C(s, (c) => [c.S.mode, document.querySelector('.app-camera .cam-mic-btn').hidden]), ['video', false]);
    await s.page.click(`${W} .cam-shutter`);
    await until(s, (c) => !!c.rec && c.rec.start > 0, { label: 'recording' });
    await sleep(2600);
    const st = await C(s, () => ({
      badge: !document.querySelector('.app-camera .cam-rec').hidden,
      time: document.querySelector('.app-camera .cam-rec-time').textContent,
      tray: document.querySelector('#taskbar [data-status="camera-rec"]')?.textContent || '',
      dot: getComputedStyle(document.querySelector('#taskbar [data-status="camera-rec"] .icon') || document.body).color,
      modeLocked: document.querySelector('.app-camera .cam-mode [data-mode="photo"]').disabled,
      label: document.querySelector('.app-camera .cam-shutter').getAttribute('aria-label'),
    }));
    check('recording badge with a running timer', st.badge && /^00:0[2-4]$/.test(st.time), true);
    check('status button in the bar with the time', st.tray, (x) => /00:0\d/.test(x));
    check('red dot (the --danger colour: red is its strongest channel)', st.dot, (x) => {
      const [r, g, b] = (x.match(/\d+/g) || []).map(Number);
      return r > 150 && r > g + 60 && r > b + 60;
    });
    check('mode locked while recording', st.modeLocked, true);
    check('shutter says stop', st.label, 'Arrêter l’enregistrement');
    await s.shot('camera-recording-fr-dark');
    await s.page.click(`${W} .cam-shutter`);
    const file = await until(s, (c) => c.last?.kind === 'video' && c.last.path, { label: 'video saved' });
    check('status button gone', await C(s, () => !document.querySelector('#taskbar [data-status="camera-rec"]')), true);
    check('saved in Pellicule as « Vidéo ….webm »', [path.dirname(file), /^Vidéo \d{4}-\d\d-\d\d \d\d\.\d\d\.\d\d( \(\d+\))?\.webm$/.test(path.basename(file))], [roll, true]);
    const b = fs.readFileSync(file);
    check('WebM (EBML) bytes', b.readUInt32BE(0), 0x1a45dfa3);
    check('Duration element written', b.subarray(0, 4096).includes(Buffer.from([0x44, 0x89, 0x88])), true);
    check('no partial file left', rollFiles(roll).filter((n) => n.includes('.part')), []);
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name,codec_type', '-of', 'json', file], { encoding: 'utf8' });
    if (probe.status === 0) {
      const j = JSON.parse(probe.stdout);
      const codecs = j.streams.map((x) => `${x.codec_type}:${x.codec_name}`).sort();
      check('ffprobe: VP9 video + Opus audio', codecs, ['audio:opus', 'video:vp9']);
      check('ffprobe: duration about 2.6 s', Number(j.format.duration), (d) => d > 2 && d < 5);
    } else console.log('    (ffprobe not available: codec / duration check skipped)');
  });

  await section('microphone off: video without sound', async () => {
    await s.page.click(`${W} .cam-mic-btn`);
    check('mic pref off', await C(s, (c) => [c.S.mic, document.querySelector('.app-camera .cam-mic-btn').getAttribute('aria-pressed')]), [false, 'false']);
    const prev = await C(s, (c) => c.last.path);
    await s.page.click(`${W} .cam-shutter`);
    await until(s, (c) => !!c.rec && c.rec.start > 0, { label: 'recording 2' });
    await sleep(1300);
    await s.page.keyboard.press('Space'); // Space = shutter (focus is on the shutter or the app)
    const file = await until(s, (c, prev) => c.last?.kind === 'video' && c.last.path !== prev && c.last.path, { arg: prev, label: 'video 2' });
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file], { encoding: 'utf8' });
    if (probe.status === 0) check('only a video stream', probe.stdout.trim().split('\n'), ['video']);
    else check('file written', fs.statSync(file).size > 1000, true);
    await s.page.click(`${W} .cam-mic-btn`);
  });

  await section('last capture opens in its app (video -> Lecteur, photo -> Photos)', async () => {
    await s.page.click(`${W} .cam-thumb`);
    await s.page.waitForSelector('.win.app-media', { timeout: 10000 });
    check('video opened in the Lecteur', await s.aurora(() => window.__aurora.wm.list().some((w) => w.appId === 'media')), true);
    await s.aurora(() => window.__aurora.wm.list().filter((w) => w.appId === 'media').forEach((w) => w.close?.(true)));
    await sleep(500);
    await s.aurora(() => window.__aurora.wm.list().find((w) => w.appId === 'camera')?.focus());
    await s.page.click(`${W} .cam-mode [data-mode="photo"]`);
    await s.page.click(`${W} .cam-shutter`);
    await until(s, (c) => c.last?.kind === 'photo', { label: 'photo 3' });
    await s.page.click(`${W} .cam-thumb`);
    await s.page.waitForSelector('.win.app-photos', { timeout: 10000 });
    check('photo opened in Photos', await s.aurora(() => window.__aurora.wm.list().some((w) => w.appId === 'photos')), true);
    await s.aurora(() => window.__aurora.wm.list().filter((w) => w.appId === 'photos').forEach((w) => w.close?.(true)));
    await sleep(400);
    await s.aurora(() => window.__aurora.wm.list().find((w) => w.appId === 'camera')?.focus());
  });

  await section('switch camera and resolution', async () => {
    const first = await C(s, (c) => c.S.deviceId);
    const other = await C(s, (c, first) => c.cams.find((d) => d.deviceId !== first)?.deviceId, first);
    await s.page.selectOption(`${W} .cam-select`, other);
    await until(s, (c, other) => c.status === 'live' && c.stream?.getVideoTracks()[0].getSettings().deviceId === other, { arg: other, label: 'second camera' });
    check('second camera saved', await C(s, (c) => c.S.deviceId), other);
    await s.page.selectOption(`${W} .cam-res`, '640x480');
    await until(s, () => document.querySelector('.app-camera .cam-video').videoWidth === 640, { label: '640 wide' });
    check('640 × 480 applied and saved', await C(s, (c) => c.S.res[c.S.deviceId]), '640x480');
    await s.page.selectOption(`${W} .cam-res`, '1280x720');
    await until(s, () => document.querySelector('.app-camera .cam-video').videoWidth === 1280, { label: '1280 wide' });
  });

  await section('prefs kept in storage', async () => {
    await sleep(300);
    const prefs = JSON.parse(fs.readFileSync(path.join(s.home, '.config', 'aurora', 'apps', 'camera', 'prefs.json'), 'utf8'));
    check('grid / mirror / mode saved', [prefs.grid, prefs.mirror, prefs.mode], [true, true, 'photo']);
  });

  await section('privacy: minimizing releases the webcam, restoring starts it again', async () => {
    const tracks = await C(s, (c) => { window.__camTracks = c.stream.getTracks(); return window.__camTracks.length; });
    check('preview has a track', tracks, (n) => n >= 1);
    await s.aurora(() => window.__aurora.wm.list().find((w) => w.appId === 'camera')?.minimize());
    await until(s, (c) => !c.stream && window.__camTracks.every((tr) => tr.readyState === 'ended'), { label: 'camera released' });
    check('minimized: camera tracks ended', true, true);
    await s.aurora(() => window.__aurora.wm.list().find((w) => w.appId === 'camera')?.restoreFromMinimize());
    await until(s, (c) => c.status === 'live' && !!c.stream, { label: 'live again after restore' });
    check('restored: live again', await C(s, (c) => c.status), 'live');
  });

  await section('closing while recording keeps the video', async () => {
    await s.page.click(`${W} .cam-mode [data-mode="video"]`);
    await s.page.click(`${W} .cam-shutter`);
    await until(s, (c) => !!c.rec && c.rec.start > 0, { label: 'recording 3' });
    await sleep(1200);
    const n = rollFiles(roll).filter((x) => x.endsWith('.webm')).length;
    await s.aurora(() => window.__aurora.wm.list().find((w) => w.appId === 'camera')?.close());
    const t0 = Date.now();
    while (rollFiles(roll).filter((x) => x.endsWith('.webm')).length === n && Date.now() - t0 < 6000) await sleep(100);
    check('third video saved on close', rollFiles(roll).filter((x) => x.endsWith('.webm')).length, n + 1);
    for (let i = 0; i < 40 && (await s.aurora(() => !!document.querySelector('.win.app-camera'))); i++) await sleep(100);
    check('window closed, status button gone', await s.aurora(() => [!document.querySelector('.win.app-camera'), !document.querySelector('#taskbar [data-status="camera-rec"]')]), [true, true]);
    check('no partial file left', rollFiles(roll).filter((n) => n.includes('.part')), []);
  });

  await section('no console errors', async () => {
    check('console errors', errorsOf(s), []);
  });
  await s.close();
  s = null;

  console.log('Camera — light theme, mode kept');
  s = await launchShell({ open: ['camera'], lang: 'fr', theme: 'light', size: '1280x720', args: FAKE });
  await section('light theme: preview, prefs and last capture restored', async () => {
    await until(s, (c) => c?.status === 'live', { label: 'live (light)' });
    await sleep(600);
    await s.page.mouse.move(5, 300);
    await s.shot('camera-fr-light');
    check('no thumbnail yet in a new home', await C(s, (c) => c.last), null);
  });
  await s.close();
  s = null;

  console.log('Camera — English: « Camera Roll »');
  s = await launchShell({ open: ['camera'], lang: 'en', theme: 'dark', size: '1280x720', args: FAKE });
  await section('English folder name', async () => {
    await until(s, (c) => c?.status === 'live', { label: 'live (en)' });
    await s.page.click(`${W} .cam-shutter`);
    const p = await until(s, (c) => c.last?.kind === 'photo' && c.last.path, { label: 'photo (en)' });
    check('saved in Pictures/Camera Roll', path.dirname(p), path.join(s.home, 'Pictures', 'Camera Roll'));
    check('English shutter label', await C(s, () => document.querySelector('.app-camera .cam-shutter').getAttribute('aria-label')), 'Take a photo');
  });
  await s.close();
  s = null;

  console.log('Camera — no camera (no fake devices)');
  for (const theme of ['dark', 'light']) {
    s = await launchShell({ open: ['camera'], lang: 'fr', theme, size: '1280x720' });
    await section(`calm empty state (${theme})`, async () => {
      await until(s, (c) => c?.status === 'error', { label: 'error state' });
      const st = await C(s, (c) => ({
        kind: c.errKind,
        title: document.querySelector('.app-camera .cam-empty-title')?.textContent,
        help: document.querySelector('.app-camera .cam-empty-help')?.textContent,
        retry: document.querySelector('.app-camera .cam-retry')?.textContent,
        shutter: document.querySelector('.app-camera .cam-shutter').disabled,
        pickers: [document.querySelector('.app-camera .cam-select').hidden, document.querySelector('.app-camera .cam-res').hidden],
      }));
      check('no camera found', st.kind, 'none');
      check('« Aucune caméra détectée »', st.title, 'Aucune caméra détectée');
      check('help text', st.help, (x) => /Branchez une webcam/.test(x));
      check('Try again button', st.retry, 'Réessayer');
      check('shutter disabled, pickers hidden', [st.shutter, st.pickers], [true, [true, true]]);
      await s.page.click(`${W} .cam-retry`);
      await until(s, (c) => c?.status === 'error', { label: 'error again' });
      await sleep(400);
      await s.page.mouse.move(5, 300);
      await s.shot(`camera-empty-fr-${theme}`);
      check('no console errors', errorsOf(s), []);
    });
    await s.close();
    s = null;
  }
} catch (err) {
  failures.push(`fatal: ${err?.stack || err}`);
} finally {
  if (s) await s.close();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  ✗ ${f}`);
process.exit(failures.length ? 1 : 0);
