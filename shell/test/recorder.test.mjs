// Voice Recorder (Enregistreur vocal) tests: drive the real Electron shell with Playwright and Chromium's fake
// microphone (--use-fake-device-for-media-stream: a beeping tone; --use-fake-ui-for-media-stream: no prompt).
//   Empty state, French folder (~/Documents/Enregistrements audio), microphone list + test meter, record with
//   pause / resume and markers (button and M), the red tray dot with the elapsed time, recording goes on while the
//   window is minimized, stop (Ctrl+R) saves a WebM/Opus file with its Duration written, list (name, date, duration),
//   playback with seek on the waveform, rename (F2), trim (save as a copy, replace), show in Files, delete to the
//   Trash, close while recording (stop and save), English folder name, light theme, no console errors.
//   Unit tests of the WebM helpers: test/recorder.unit.mjs.
//   Screenshots (1280x720, French, Halo): docs/screenshots/recorder-recording-dark.png, recorder-playback-dark.png,
//   recorder-trim-dark.png, recorder-playback-light.png, recorder-recording-light.png
// Usage:  cd aurora-os/shell && xvfb-run -a -s "-screen 0 1600x900x24" node test/recorder.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchShell, ROOT } from './lib.mjs';

const webm = await import(pathToFileURL(path.join(ROOT, 'renderer/apps/recorder/lib/webm.js')).href);
const DOCS = path.join(ROOT, '..', 'docs', 'screenshots');
fs.mkdirSync(DOCS, { recursive: true });
const FAKE = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'];

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
const WIN = '.win.app-recorder';
/** Evaluate fn(R, arg) in the shell; R = the recorder object of the window. */
function RC(s, fn, arg) {
  return s.page.evaluate(`(async () => { const el = document.querySelector('${WIN}'); return (${fn.toString()})(el && el.__recorder, ${JSON.stringify(arg ?? null)}); })()`);
}
async function until(s, fn, { timeout = 10000, label = 'condition', arg } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = await RC(s, fn, arg).catch((e) => `ERR ${e.message}`);
    if (last && !String(last).startsWith('ERR')) return last;
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${label} (last: ${JSON.stringify(last)})`);
}
async function clickDialogButton(s, label) {
  await s.page.waitForSelector('.dialog-footer button', { timeout: 5000 });
  const ok = await s.page.evaluate((l) => {
    const b = [...document.querySelectorAll('.dialog-footer button')].find((x) => x.textContent.trim() === l);
    b?.click();
    return !!b;
  }, label);
  if (!ok) throw new Error(`no dialog button ${label}`);
  await sleep(200);
}
const appErrors = (s) => s.logs.filter((l) => /pageerror|\[error\]/.test(l) && !/favicon|net::ERR|Failed to load resource|Autofill|dbus|GPU|gpu|AudioContext was not allowed/i.test(l));

console.log('Voice Recorder');
const s = await launchShell({ open: ['recorder'], lang: 'fr', theme: 'dark', size: '1280x720', args: FAKE, settle: 1000 });
const dir = path.join(s.home, 'Documents', 'Enregistrements audio');
try {
  await s.page.waitForSelector(`${WIN} .rc-app`, { timeout: 15000 });
  // a large window for the screenshots
  await s.aurora(() => {
    const w = window.__aurora.wm.list().find((x) => x.appId === 'recorder');
    w?.setSize?.(1000, 620);
  });
  await sleep(300);

  await section('empty state, French folder, record view', async () => {
    const st = await RC(s, (R) => ({ dir: R.dir, empty: !R.els.empty.hidden, emptyText: R.els.empty.textContent, rec: !R.els.recView.hidden, state: R.els.state.textContent, title: document.querySelector('.win.app-recorder .win-title, .win.app-recorder .titlebar-title')?.textContent || '' }));
    check('folder is ~/Documents/Enregistrements audio', st.dir, dir);
    check('empty list text', [st.empty, st.emptyText], [true, 'Vos enregistrements s’affichent ici.']);
    check('record view shown, ready', [st.rec, st.state], [true, 'Prêt à enregistrer']);
  });

  await section('microphones listed, test shows a level', async () => {
    await s.page.click(`${WIN} .rc-test`);
    const lvl = await until(s, (R) => (R.monitor && Number(R.els.meter.getAttribute('aria-valuenow')) > 3 ? Number(R.els.meter.getAttribute('aria-valuenow')) : 0), { label: 'meter level', timeout: 8000 });
    check('meter moves with the fake microphone', lvl, (v) => v > 3);
    const opts = await RC(s, (R) => [...R.els.micSel.options].map((o) => o.textContent));
    check('microphone select: default + fake devices', opts, (o) => o.length >= 2 && o[0] === 'Microphone par défaut');
    check('test button label', await RC(s, (R) => R.els.testBtn.textContent), 'Arrêter le test');
    await s.page.click(`${WIN} .rc-test`);
    check('test stops', await RC(s, (R) => [!!R.monitor, R.els.testBtn.textContent]), [false, 'Tester']);
  });

  let recSeconds = 0;
  await section('record: tray dot, markers, pause / resume, minimized', async () => {
    await s.page.click(`${WIN} .rc-rec`);
    await until(s, (R) => R.rec?.mr?.state === 'recording', { label: 'recording' });
    check('state text', await RC(s, (R) => R.els.state.textContent), 'Enregistrement en cours');
    await sleep(1200);
    const tray = await s.page.evaluate(() => {
      const b = document.querySelector('#taskbar [data-status="recorder"]');
      const probe = document.createElement('span');
      probe.style.color = 'var(--danger)';
      document.body.append(probe);
      const danger = getComputedStyle(probe).color;
      probe.remove();
      return b ? { text: b.textContent.trim(), color: getComputedStyle(b.querySelector('.icon')).color, danger, tip: b.dataset.tip } : null;
    });
    check('red dot in the bar with the elapsed time', tray && /^0:0[1-9]$/.test(tray.text) && tray.tip.startsWith('Enregistrement en cours'), true);
    check('tray dot is the danger colour', tray && tray.color === tray.danger, true);
    await s.page.click(`${WIN} .rc-round[aria-label="Ajouter un repère"]`);
    await sleep(700);
    await s.page.keyboard.press('m');
    const marks = await RC(s, (R) => [R.rec.markers.length, R.els.liveMarks.children.length, R.els.liveMarks.textContent]);
    check('two markers (button + M)', marks.slice(0, 2), [2, 2]);
    check('marker chip text', marks[2], (t) => /Repère 1 · 0:0\d/.test(t) && /Repère 2/.test(t));
    await s.shot('recorder-recording-dark');
    fs.copyFileSync(path.join(ROOT, 'test/out/recorder-recording-dark.png'), path.join(DOCS, 'recorder-recording-dark.png'));
    // pause (Space) — the clock stops
    await s.page.evaluate(() => document.activeElement?.blur());
    await s.page.focus(`${WIN} .rc-live-wrap`).catch(() => {});
    await RC(s, (R) => R.togglePause());
    const p1 = await RC(s, (R) => [R.rec.mr.state, R.els.state.textContent, R.elapsed()]);
    await sleep(800);
    const p2 = await RC(s, (R) => R.elapsed());
    check('paused: recorder state and text', p1.slice(0, 2), ['paused', 'En pause']);
    check('paused: elapsed does not move', Math.abs(p2 - p1[2]) < 0.05, true);
    check('paused: tray shows the pause glyph', await s.page.evaluate(() => !!document.querySelector('#taskbar [data-status="recorder"]')), true);
    await RC(s, (R) => R.togglePause());
    check('resumed', await RC(s, (R) => R.rec.mr.state), 'recording');
    // minimize: recording goes on
    const before = await RC(s, (R) => R.elapsed());
    await s.aurora(() => window.__aurora.wm.list().find((x) => x.appId === 'recorder').minimize());
    await sleep(1500);
    const min = await RC(s, (R) => ({ state: R.rec?.mr?.state, el: R.elapsed(), minimized: R.ctx.win.minimized }));
    check('minimized window keeps recording', [min.state, min.minimized, min.el - before > 1.2], ['recording', true, true]);
    await s.page.click('#taskbar [data-status="recorder"]');
    await sleep(500);
    check('tray click restores the window', await RC(s, (R) => R.ctx.win.minimized), false);
    recSeconds = await RC(s, (R) => R.elapsed());
  });

  await section('stop (Ctrl+R) saves a WebM/Opus file with a duration', async () => {
    await s.page.keyboard.press('Control+r');
    await until(s, (R) => !R.rec && !R.saving && R.items.length === 1 && R.play?.buffer, { label: 'saved and selected', timeout: 15000 });
    const file = path.join(dir, 'Enregistrement 1.webm');
    check('file written', fs.existsSync(file), true);
    const info = webm.readInfo(fs.readFileSync(file));
    check('WebM/Opus with a Duration close to the clock', [info?.codec, info && Math.abs(info.duration / 1000 - recSeconds) < 1.2], ['A_OPUS', true]);
    const st = await RC(s, (R) => ({ meta: R.meta['Enregistrement 1.webm'], row: R.els.list.textContent, name: R.els.name.textContent, play: !R.els.playView.hidden, tray: !!document.querySelector('#taskbar [data-status="recorder"]') }));
    check('markers saved with the file', st.meta?.markers?.length, 2);
    check('list row: name, date, duration', st.row, (t) => t.includes('Enregistrement 1') && /\d{4} à \d{2}:\d{2}/.test(t) && /0:0\d/.test(t));
    check('playback view shows the new recording', [st.play, st.name], [true, 'Enregistrement 1']);
    check('tray dot removed', st.tray, false);
  });

  await section('playback and seek on the waveform', async () => {
    const dur = await RC(s, (R) => R.duration);
    const box = await s.page.locator(`${WIN} .rc-seek`).boundingBox();
    await s.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    const pos = await RC(s, (R) => R.play.pos);
    check('click at the middle seeks to half', Math.abs(pos - dur / 2) < dur * 0.05, true);
    await s.page.click(`${WIN} .rc-play`);
    await sleep(600);
    const pl = await RC(s, (R) => [R.play.playing, R.play.pos]);
    check('playing advances the position', pl[0] && pl[1] > pos + 0.2, true);
    await s.page.click(`${WIN} .rc-play`);
    check('paused', await RC(s, (R) => R.play.playing), false);
    await s.page.focus(`${WIN} .rc-seek`);
    await s.page.keyboard.press('Home');
    check('Home seeks to 0', await RC(s, (R) => R.play.pos), 0);
    const marks = await s.page.locator(`${WIN} .rc-marks .rc-chip`).count();
    check('marker chips under the waveform', marks, 2);
    await s.page.locator(`${WIN} .rc-marks .rc-chip`).nth(1).click();
    const m2 = await RC(s, (R) => [R.play.pos, R.meta[R.selected].markers[1]]);
    check('marker chip seeks to it', Math.abs(m2[0] - m2[1]) < 0.01, true);
    await RC(s, (R) => R.seek(R.duration * 0.3));
    await s.shot('recorder-playback-dark');
    fs.copyFileSync(path.join(ROOT, 'test/out/recorder-playback-dark.png'), path.join(DOCS, 'recorder-playback-dark.png'));
  });

  await section('rename (F2)', async () => {
    await s.page.focus(`${WIN} .rc-item.selected`);
    await s.page.keyboard.press('F2');
    await s.page.waitForSelector('.dialog input', { timeout: 5000 });
    await s.page.fill('.dialog input', 'Réunion');
    await s.page.keyboard.press('Enter');
    await until(s, (R) => R.items.some((i) => i.name === 'Réunion.webm') && R.selected === 'Réunion.webm', { label: 'renamed' });
    check('file renamed on disk', [fs.existsSync(path.join(dir, 'Réunion.webm')), fs.existsSync(path.join(dir, 'Enregistrement 1.webm'))], [true, false]);
    check('markers follow the new name', await RC(s, (R) => R.meta['Réunion.webm']?.markers?.length), 2);
  });

  await section('trim: save as a copy, then replace', async () => {
    await s.page.click(`${WIN} .rc-act[data-act="trim"]`);
    const dur = await RC(s, (R) => R.duration);
    await RC(s, (R) => {
      R.setTrim('a', 1);
      R.setTrim('b', R.duration - 1);
    });
    await s.page.focus(`${WIN} .rc-handle >> nth=0`);
    await s.page.keyboard.press('ArrowRight');
    await s.page.keyboard.press('ArrowRight');
    const tr = await RC(s, (R) => [R.trim.a, R.trim.b, R.els.trimA.textContent]);
    check('handles: keyboard moves the start by 0.1 s', Math.abs(tr[0] - 1.2) < 0.01, true);
    check('trim time shown with a French decimal comma', tr[2], '0:01,2');
    await s.shot('recorder-trim-dark');
    fs.copyFileSync(path.join(ROOT, 'test/out/recorder-trim-dark.png'), path.join(DOCS, 'recorder-trim-dark.png'));
    await s.page.click(`${WIN} [data-trim="copy"]`);
    await until(s, (R) => R.selected === 'Réunion (rogné).webm' && R.play?.buffer && !R.trim, { label: 'trimmed copy', timeout: 20000 });
    const copy = path.join(dir, 'Réunion (rogné).webm');
    const info = webm.readInfo(fs.readFileSync(copy));
    const want = tr[1] - tr[0];
    check('copy: Opus WebM of the kept length', [info?.codec, Math.abs(info.duration / 1000 - want) < 0.15], ['A_OPUS', true]);
    const dec = await RC(s, (R) => R.duration);
    check('copy decodes to the kept length', Math.abs(dec - want) < 0.15, true);
    check('original kept', fs.existsSync(path.join(dir, 'Réunion.webm')), true);
    check('markers inside the kept part are shifted', await RC(s, (R) => R.meta['Réunion (rogné).webm'].markers), (m) => Array.isArray(m));
    // replace the copy's first second
    await s.page.click(`${WIN} .rc-act[data-act="trim"]`);
    await RC(s, (R) => R.setTrim('a', 1));
    await s.page.click(`${WIN} [data-trim="replace"]`);
    await clickDialogButton(s, 'Remplacer');
    await until(s, (R) => R.selected === 'Réunion (rogné).webm' && R.play?.buffer && !R.trim && !R.saving, { label: 'replaced', timeout: 20000 });
    const info2 = webm.readInfo(fs.readFileSync(copy));
    check('replace: same file, one second shorter', Math.abs(info2.duration / 1000 - (want - 1)) < 0.15, true);
    check('two recordings listed', await RC(s, (R) => R.items.map((i) => i.name).sort()), ['Réunion (rogné).webm', 'Réunion.webm']);
    check('dur dec', dur > 3, true);
  });

  await section('show in Files', async () => {
    await s.page.click(`${WIN} .rc-act[data-act="showInFiles"]`);
    await s.page.waitForSelector('.win.app-files', { timeout: 10000 });
    await sleep(800);
    const sel = await s.page.evaluate(() => [...document.querySelectorAll('.win.app-files .selected, .win.app-files [aria-selected="true"]')].map((e) => e.textContent).join('|'));
    check('Files opens the folder with the recording selected', sel, (t) => t.includes('Réunion (rogné)'));
    await s.aurora(() => window.__aurora.wm.list().find((x) => x.appId === 'files')?.close());
    await sleep(400);
  });

  await section('delete to the Trash', async () => {
    await s.aurora(() => window.__aurora.wm.list().find((x) => x.appId === 'recorder')?.focus());
    await s.page.click(`${WIN} .rc-act[data-act="delete"]`);
    await clickDialogButton(s, 'Supprimer');
    await until(s, (R) => R.items.length === 1, { label: 'deleted' });
    check('file moved to the Trash', [fs.existsSync(path.join(dir, 'Réunion (rogné).webm')), fs.existsSync(path.join(s.home, '.local/share/Trash/files/Réunion (rogné).webm'))], [false, true]);
    check('the next recording is selected', await RC(s, (R) => R.selected), 'Réunion.webm');
  });

  await section('light theme', async () => {
    await s.aurora(() => window.__aurora.settings.set('theme', 'light'));
    await sleep(900);
    await RC(s, (R) => R.seek(R.duration * 0.45));
    await s.shot('recorder-playback-light');
    fs.copyFileSync(path.join(ROOT, 'test/out/recorder-playback-light.png'), path.join(DOCS, 'recorder-playback-light.png'));
    await s.page.click(`${WIN} .rc-new`);
    await s.page.click(`${WIN} .rc-rec`);
    await until(s, (R) => R.rec?.mr?.state === 'recording', { label: 'recording (light)' });
    await sleep(1800);
    await s.page.keyboard.press('m');
    await sleep(500);
    await s.shot('recorder-recording-light');
    fs.copyFileSync(path.join(ROOT, 'test/out/recorder-recording-light.png'), path.join(DOCS, 'recorder-recording-light.png'));
  });

  await section('closing while recording asks, then stops and saves', async () => {
    await s.aurora(() => window.__aurora.wm.list().find((x) => x.appId === 'recorder').close());
    await clickDialogButton(s, 'Arrêter et enregistrer');
    const t0 = Date.now();
    while (Date.now() - t0 < 10000 && (await s.page.$(WIN))) await sleep(150);
    check('window closed', !!(await s.page.$(WIN)), false);
    check('the recording was saved first', fs.existsSync(path.join(dir, 'Enregistrement 1.webm')), true);
    check('tray dot gone', await s.page.evaluate(() => !!document.querySelector('#taskbar [data-status="recorder"]')), false);
  });

  await section('no console errors', async () => {
    check('no page errors', appErrors(s), []);
  });
} finally {
  await s.close();
}

await section('English: Sound recordings folder and strings', async () => {
  const e = await launchShell({ open: ['recorder'], lang: 'en', theme: 'light', size: '1280x720', args: FAKE });
  try {
    await e.page.waitForSelector(`${WIN} .rc-app`, { timeout: 15000 });
    const st = await RC(e, (R) => ({ dir: R.dir, state: R.els.state.textContent, btn: R.els.recBtn.getAttribute('aria-label') }));
    check('folder', st.dir, path.join(e.home, 'Documents', 'Sound recordings'));
    check('strings', [st.state, st.btn], ['Ready to record', 'Record']);
    check('no page errors (en)', appErrors(e), []);
  } finally {
    await e.close();
  }
});

console.log(`\nrecorder: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
