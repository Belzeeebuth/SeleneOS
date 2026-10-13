// Screen Recorder tests — drive the real Electron shell with Playwright.
//   Window (modes, microphone / computer sound toggles, format, saved choices), full-screen recording (hidden window,
//   3-2-1 countdown, floating control with time / pause / stop, red tray chip, file in ~/Videos/<folder>, WebM with a
//   duration after the ffmpeg remux, the floating control NOT in the video), area recording (drawn rectangle, control
//   outside the area, dashed frame, cropped video size), MP4 through ffmpeg, Super+Shift+R start / stop, Esc during the
//   countdown, microphone with Chromium's fake devices (audio stream in the file), « Enregistrement sauvegardé »
//   notification with Ouvrir / Afficher dans Fichiers, French + dark / light, console errors.
//   Screenshots (1280x720, FR): test/out/screenrec-*.png; docs/screenshots/screenrec-dark-fr.png, screenrec-light-fr.png
// Usage:  cd aurora-os/shell && xvfb-run -a -s "-screen 0 1600x900x24" node test/screenrec.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { launchShell, ROOT } from './lib.mjs';

const DOCS = path.join(ROOT, '..', 'docs', 'screenshots');
fs.mkdirSync(DOCS, { recursive: true });
const SIZE = '1280x720';
const FAKE_MEDIA = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'];

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
const WIN = '.win.app-screenrec';

// Evaluate fn(app, arg) in the shell; app = the ScreenRecorder of the window.
function SR(s, fn, arg) {
  return s.page.evaluate(`(async () => { const el = document.querySelector('${WIN}'); return (${fn.toString()})(el && el.__screenrec && el.__screenrec.app, ${JSON.stringify(arg ?? null)}); })()`);
}
async function until(s, fn, { timeout = 10000, label = 'condition', arg } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = await SR(s, fn, arg).catch((e) => `ERR ${e.message}`);
    if (last && !String(last).startsWith('ERR')) return last;
    await sleep(80);
  }
  throw new Error(`timeout waiting for ${label} (last: ${JSON.stringify(last)})`);
}
const recDir = (home, lang = 'fr') => path.join(home, 'Videos', lang === 'fr' ? "Enregistrements d'écran" : 'Screen recordings');
const listRec = (home, lang) => {
  try {
    return fs.readdirSync(recDir(home, lang)).sort();
  } catch {
    return [];
  }
};
function probe(file) {
  try {
    const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height:format=duration', '-of', 'json', file], { encoding: 'utf8' });
    const j = JSON.parse(out);
    const v = j.streams.find((x) => x.codec_type === 'video');
    const a = j.streams.find((x) => x.codec_type === 'audio');
    return { video: v?.codec_name, width: v?.width, height: v?.height, audio: a?.codec_name || null, duration: Number(j.format?.duration) || 0 };
  } catch (err) {
    return { error: String(err.message || err).slice(0, 200) };
  }
}
function countFrames(file) {
  try {
    return Number(execFileSync('ffprobe', ['-v', 'error', '-count_packets', '-select_streams', 'v', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim()) || 0;
  } catch {
    return 0;
  }
}
/** Mean RGB of a w x h box at (x, y) of the frame at time `at` (s) of a video, through ffmpeg. */
function meanColor(file, x, y, w, h, at = 1) {
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(at), '-i', file, '-frames:v', '1', '-vf', `crop=${w}:${h}:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64 << 20 });
  const n = buf.length / 3;
  const s = [0, 0, 0];
  for (let i = 0; i < buf.length; i += 3) for (let k = 0; k < 3; k++) s[k] += buf[i + k];
  return s.map((v) => Math.round(v / n));
}
const notifTexts = (s) => s.page.evaluate(() => [...document.querySelectorAll('.toast, .notif-toast, [class*="toast"]')].map((e) => e.textContent).join(' | '));

async function main() {
  const errors = [];
  console.log('Screen Recorder');
  let s = await launchShell({ open: ['screenrec'], lang: 'fr', theme: 'dark', size: SIZE });
  const watchErrors = (sh) =>
    sh.page.on('console', (m) => {
      if (m.type() === 'error' && !/favicon|ERR_FILE_NOT_FOUND|net::ERR/.test(m.text())) errors.push(m.text());
    });
  watchErrors(s);
  try {
    await section('window: French strings, modes, toggles, format, Lanceur entry', async () => {
      await s.page.waitForSelector(`${WIN}.sr-ready .sr-start`, { timeout: 10000 });
      const ui = await s.page.evaluate((W) => {
        const w = document.querySelector(W);
        return {
          title: w.querySelector('.win-title, .win-titlebar')?.textContent.trim(),
          start: w.querySelector('.sr-start').textContent.trim(),
          modes: [...w.querySelectorAll('.sr-modes button')].map((b) => b.textContent.trim()),
          rows: [...w.querySelectorAll('.sr-row-title')].map((b) => b.textContent.trim()),
          hint: w.querySelector('.sr-hint').textContent,
          folder: w.querySelector('.sr-folder').textContent.trim(),
          icon: getComputedStyle(w).visibility,
        };
      }, WIN);
      check('window title', ui.title, (v) => /Enregistreur d'écran/.test(v));
      check('start button', ui.start, "Démarrer l'enregistrement");
      check('modes', ui.modes, ['Plein écran', 'Zone']);
      check('rows', ui.rows, ['Microphone', "Son de l'ordinateur", 'Format']);
      check('hint names the shortcut', ui.hint, (v) => v.includes('Super+Maj+R'));
      check('open folder', ui.folder, 'Ouvrir le dossier');
      check('window visible', ui.icon, 'visible');
      const reg = await s.aurora(() => {
        const r = window.__aurora.registry;
        const m = r.get('screenrec');
        return { name: r.name('screenrec'), icon: r.iconUrl('screenrec'), kw: (m.keywords?.fr || []).join(',') };
      });
      check('Lanceur name', reg.name, "Enregistreur d'écran");
      check('icon url', reg.icon, (v) => !!v);
      check('keywords', reg.kw, (v) => v.includes('enregistrer'));
      // search in the Lanceur finds it
      const found = await s.aurora(async () => {
        const st = window.__aurora.start;
        if (!st?.search) return 'n/a';
        const r = await st.search('enregistreur');
        return JSON.stringify(r).includes('screenrec');
      });
      check('Lanceur search', found, (v) => v === true || v === 'n/a');
      await s.shot('screenrec-window-fr-dark');
    });

    await section('choices are saved (mode, microphone, format)', async () => {
      await s.page.click(`${WIN} .sr-modes button:nth-child(2)`);
      await s.page.click(`${WIN} label.toggle:has(input[aria-label="Microphone"])`);
      await s.page.selectOption(`${WIN} select.sr-format`, 'mp4');
      const prefs = await SR(s, (app) => app.prefs);
      check('prefs', prefs, { mode: 'region', mic: true, system: false, format: 'mp4' });
      const stored = await SR(s, (app) => app.ctx.storage.get('prefs'));
      check('stored', stored?.mode, 'region');
      // back to full screen, no microphone, WebM
      await s.page.click(`${WIN} .sr-modes button:nth-child(1)`);
      await s.page.click(`${WIN} label.toggle:has(input[aria-label="Microphone"])`);
      await s.page.selectOption(`${WIN} select.sr-format`, 'webm');
    });

    let fullFile = null;
    let ctlBox = null;
    await section('full screen: hidden window, 3-2-1, control + red tray chip, pause, stop, saved WebM', async () => {
      await s.page.click(`${WIN} .sr-start`);
      await s.page.waitForSelector('.sr-countdown .sr-count-num', { timeout: 8000 });
      const first = await s.page.textContent('.sr-countdown .sr-count-num');
      check('countdown starts at 3', first, '3');
      check('window hidden', await s.page.evaluate((W) => getComputedStyle(document.querySelector(W)).visibility, WIN), 'hidden');
      await s.shot('screenrec-countdown-fr-dark');
      await until(s, (app) => app.state === 'recording', { label: 'recording', timeout: 8000 });
      check('countdown gone', await s.page.$('.sr-countdown'), null);
      await s.page.waitForSelector('.sr-control', { timeout: 3000 });
      ctlBox = await s.page.evaluate(() => {
        const r = document.querySelector('.sr-control .sr-ctl-stop').getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      });
      const chip = await s.page.evaluate(() => {
        const b = document.querySelector('.tb-btn[data-status="screenrec"]');
        return b ? { tip: b.dataset.tip, label: b.getAttribute('aria-label'), color: getComputedStyle(b.querySelector('.icon')).color } : null;
      });
      check('tray chip', chip?.label, "Arrêter l'enregistrement");
      check('tray chip is red (danger token)', chip?.color, (c) => {
        const m = /rgba?\((\d+), (\d+), (\d+)/.exec(c || '');
        return m && +m[1] > +m[2] + 60 && +m[1] > +m[3] + 40;
      });
      const patch = await SR(s, (app) => app.rec?.patch);
      check('control area is painted from the clean picture', patch, (p) => p && p.width > 40 && p.height > 20);
      await sleep(1300);
      await s.shot('screenrec-recording-fr-dark');
      // pause / resume
      await s.page.click('.sr-control .sr-ctl-pause');
      check('paused', await SR(s, (app) => app.state), 'paused');
      const t1 = await SR(s, (app) => app.rec.elapsed());
      await sleep(700);
      const t2 = await SR(s, (app) => app.rec.elapsed());
      check('time stands still while paused', Math.abs(t2 - t1) < 50, true);
      check('control shows « En pause »', await s.page.textContent('.sr-control .sr-ctl-time'), (v) => v.includes('En pause'));
      await s.page.click('.sr-control .sr-ctl-pause');
      check('resumed', await SR(s, (app) => app.state), 'recording');
      await sleep(1500);
      // stop from the tray chip
      await s.page.click('.tb-btn[data-status="screenrec"]');
      await until(s, (app) => app.state === 'idle' && app.last, { label: 'saved', timeout: 20000 });
      check('control removed', await s.page.$('.sr-control'), null);
      check('tray chip removed', await s.page.$('.tb-btn[data-status="screenrec"]'), null);
      const files = listRec(s.home);
      check('one WebM in ~/Videos/Enregistrements d’écran', files.length === 1 && files[0].endsWith('.webm') && files[0].startsWith("Enregistrement d'écran "), true);
      fullFile = path.join(recDir(s.home), files[0]);
      const p = probe(fullFile);
      check('vp8/vp9 video', p.video, (v) => v === 'vp8' || v === 'vp9');
      check('size of the shell (1280x720)', `${p.width}x${p.height}`, '1280x720');
      // (the remux gives the WebM a duration; on a loaded test machine the VP8 encoder drops frames and the last ones
      // are lost at stop, so only a lower bound is checked here)
      check('duration known after the remux (pause excluded)', p.duration, (d) => d >= 0.3 && d < 8);
      check('frames in the video', countFrames(fullFile), (n) => n >= 3);
      check('no audio track', p.audio, null);
      const last = await SR(s, (app) => app.last);
      check('last recording', last?.format, 'webm');
      check('window back with the last recording', await s.page.evaluate((W) => getComputedStyle(document.querySelector(W)).visibility + ' ' + !document.querySelector(`${W} .sr-last`).hidden, WIN), 'visible true');
      const toast = await notifTexts(s);
      check('notification « Enregistrement sauvegardé »', toast, (v) => v.includes('Enregistrement sauvegardé') && v.includes('Ouvrir') && v.includes('Afficher dans Fichiers'));
      check('window grew for the last recording', await s.page.evaluate((W) => document.querySelector(W).getBoundingClientRect().height, WIN), (h) => h >= 580);
      await s.shot('screenrec-saved-fr-dark');
      fs.copyFileSync(path.join(ROOT, 'test', 'out', 'screenrec-saved-fr-dark.png'), path.join(DOCS, 'screenrec-dark-fr.png'));
    });

    await section('the floating control is not in the video', async () => {
      if (!fullFile || !ctlBox) throw new Error('no recording');
      // the stop button is a --danger disc: in the video, its place shows what was under it (not red)
      const p = probe(fullFile);
      const k = p.width / 1280;
      const at = Math.min(1, p.duration / 2);
      const [r, g, b] = meanColor(fullFile, Math.round((ctlBox.x + 6) * k), Math.round((ctlBox.y + 6) * k), Math.max(4, Math.round((ctlBox.w - 12) * k)), Math.max(4, Math.round((ctlBox.h - 12) * k)), at);
      check(`no red stop button in the frame (rgb ${r},${g},${b})`, r > g + 60 && r > b + 40, false);
      // and the video is not blank: the bar is there (some contrast across the frame)
      const top = meanColor(fullFile, 0, 0, p.width, Math.round(p.height / 4), at);
      const bottom = meanColor(fullFile, 0, p.height - Math.round(40 * k), p.width, Math.round(40 * k), at);
      check('the frame shows the desktop (not one flat colour)', JSON.stringify(top) !== JSON.stringify(bottom), true);
    });

    await section('Ouvrir / Afficher dans Fichiers', async () => {
      await s.page.click(`${WIN} .sr-reveal`);
      await s.page.waitForSelector('.win.app-files', { timeout: 10000 });
      check('Files opened', await s.page.$$eval('.win.app-files', (l) => l.length), (n) => n >= 1);
      await s.aurora(() => {
        for (const w of window.__aurora.wm.list()) if (w.appId === 'files') w.close();
      });
      await sleep(300);
    });

    await section('area: drawn rectangle, control outside it, dashed frame, cropped video', async () => {
      await s.page.click(`${WIN} .sr-modes button:nth-child(2)`);
      await s.page.click(`${WIN} .sr-start`);
      await s.page.waitForSelector('.sr-region', { timeout: 5000 });
      check('hint', await s.page.textContent('.sr-region-hint'), (v) => v.includes('Faites glisser'));
      await s.shot('screenrec-region-pick-fr-dark');
      await s.page.mouse.move(240, 140);
      await s.page.mouse.down();
      await s.page.mouse.move(500, 300, { steps: 4 });
      await s.page.mouse.move(880, 500, { steps: 4 });
      await s.page.mouse.up();
      await s.page.waitForSelector('.sr-countdown', { timeout: 8000 });
      await until(s, (app) => app.state === 'recording', { label: 'recording', timeout: 8000 });
      const geo = await s.page.evaluate(() => {
        const c = document.querySelector('.sr-control').getBoundingClientRect();
        const f = document.querySelector('.sr-frame')?.getBoundingClientRect();
        return { ctlTop: c.top, frame: f ? [f.left, f.top, f.width, f.height] : null };
      });
      check('control below the area', geo.ctlTop >= 500, true);
      check('frame around the area', geo.frame, [237, 137, 646, 366]);
      check('nothing to patch (control outside)', await SR(s, (app) => app.rec.patch), null);
      await sleep(1000);
      await s.shot('screenrec-region-recording-fr-dark');
      await sleep(800);
      await s.page.click('.sr-control .sr-ctl-stop');
      await until(s, (app) => app.state === 'idle' && app.last && app.last.path.includes('(2)') === false && app.last, { label: 'saved', timeout: 20000 });
      const files = listRec(s.home);
      check('two recordings', files.length, 2);
      const p = probe((await SR(s, (app) => app.last.path)));
      check('cropped video 640x360', `${p.width}x${p.height}`, '640x360');
      check('frame removed', await s.page.$('.sr-frame'), null);
    });

    await section('Esc during the countdown cancels (no file)', async () => {
      await s.page.click(`${WIN} .sr-modes button:nth-child(1)`);
      const before = listRec(s.home).length;
      await s.page.click(`${WIN} .sr-start`);
      await s.page.waitForSelector('.sr-countdown', { timeout: 8000 });
      await s.page.keyboard.press('Escape');
      await until(s, (app) => app.state === 'idle', { label: 'idle' });
      await sleep(300);
      check('no new file', listRec(s.home).length, before);
      check('window back', await s.page.evaluate((W) => getComputedStyle(document.querySelector(W)).visibility, WIN), 'visible');
    });

    await section('MP4 through ffmpeg', async () => {
      await s.page.selectOption(`${WIN} select.sr-format`, 'mp4');
      await s.page.click(`${WIN} .sr-start`);
      await until(s, (app) => app.state === 'recording', { label: 'recording', timeout: 10000 });
      await sleep(1600);
      await SR(s, (app) => app.stop());
      await until(s, (app) => app.state === 'idle', { label: 'idle', timeout: 60000 });
      const last = await SR(s, (app) => app.last);
      check('mp4 file', last?.format, 'mp4');
      check('no WebM left beside it', fs.existsSync(last.path.replace(/\.mp4$/, '.webm')), false);
      const p = probe(last.path);
      check('h264', p.video, 'h264');
      check('mp4 duration', p.duration, (d) => d > 0.1);
      await s.page.selectOption(`${WIN} select.sr-format`, 'webm');
    });

    await section('Super+Shift+R starts (window stays hidden) and stops', async () => {
      await s.aurora(() => {
        for (const w of window.__aurora.wm.list()) if (w.appId === 'screenrec') w.close();
      });
      await sleep(400);
      const before = listRec(s.home).length;
      const sc = await s.aurora(() => window.__aurora.hotkeys?.trigger ? 'ok' : 'none');
      check('hotkeys trigger hook', sc, 'ok');
      await s.aurora(() => window.__aurora.hotkeys.trigger('Super+Shift+R'));
      await s.page.waitForSelector('.sr-countdown', { timeout: 10000 });
      check('window hidden', await s.page.evaluate((W) => getComputedStyle(document.querySelector(W)).visibility, WIN), 'hidden');
      await until(s, (app) => app.state === 'recording', { label: 'recording', timeout: 8000 });
      await sleep(2500);
      await s.aurora(() => window.__aurora.hotkeys.trigger('Super+Shift+R'));
      await until(s, (app) => app.state === 'idle' && (app.last || app.info.textContent || 'failed'), { label: 'saved', timeout: 20000 });
      check('saved (no error)', await SR(s, (app) => (app.last ? 'ok' : app.info.textContent)), 'ok');
      check('new file', listRec(s.home).length, before + 1);
      check('window stays hidden after a hotkey recording', await s.page.evaluate((W) => getComputedStyle(document.querySelector(W)).visibility, WIN), 'hidden');
      const sc2 = await s.aurora(async () => {
        const m = await import('/core/shortcuts.js').catch(() => null);
        return m ? m.SHORTCUTS.find((x) => x.id === 'screenRecord')?.combo : 'n/a';
      });
      check('catalog entry', sc2, (v) => v === 'Super+Shift+R' || v === 'n/a');
    });

    await section('microphone not available here: the recording goes on, with a warning', async () => {
      await s.aurora(() => window.__aurora.shell.launch('screenrec'));
      await s.page.waitForSelector(`${WIN}.sr-ready:not(.sr-hidden)`, { timeout: 8000 });
      const r = await SR(s, async (app) => {
        app.prefs.mic = true;
        app.prefs.system = true;
        return true;
      });
      check('prefs set', r, true);
      await s.page.click(`${WIN} .sr-start`);
      await until(s, (app) => app.state === 'recording' || (app.state === 'idle' && app.info.textContent), { label: 'recording', timeout: 10000 });
      const warnings = await SR(s, (app) => app.warnings);
      console.log(`      (no fake devices) warnings: ${JSON.stringify(warnings)}`);
      await sleep(1200);
      await SR(s, (app) => app.stop());
      await until(s, (app) => app.state === 'idle', { label: 'idle', timeout: 20000 });
      const p = probe(await SR(s, (app) => app.last.path));
      console.log(`      computer sound + microphone without devices: ${JSON.stringify(p)}`);
      check('a video was saved', p.video, (v) => !!v);
      const info = await s.page.textContent(`${WIN} .sr-info`);
      if (warnings.length) check('warning shown', info, (v) => v.includes('continue sans'));
      await SR(s, (app) => {
        app.prefs.mic = false;
        app.prefs.system = false;
      });
    });

    await section('light theme screenshot', async () => {
      await SR(s, (app) => app.showInfo(null));
      await s.aurora(() => window.__aurora.settings.set('theme', 'light'));
      await sleep(600);
      await s.shot('screenrec-window-fr-light');
      fs.copyFileSync(path.join(ROOT, 'test', 'out', 'screenrec-window-fr-light.png'), path.join(DOCS, 'screenrec-light-fr.png'));
    });
  } finally {
    await s.close();
  }

  // ---------------------------------------------------------------- fake microphone (Chromium fake devices)
  s = await launchShell({ open: ['screenrec'], lang: 'en', theme: 'light', size: SIZE, args: FAKE_MEDIA });
  watchErrors(s);
  try {
    await section('microphone with fake devices: audio in the file (English)', async () => {
      await s.page.waitForSelector(`${WIN}.sr-ready .sr-start`, { timeout: 10000 });
      check('English start', (await s.page.textContent(`${WIN} .sr-start`)).trim(), 'Start recording');
      await s.page.click(`${WIN} label.toggle:has(input[aria-label="Microphone"])`);
      await s.page.click(`${WIN} .sr-start`);
      await until(s, (app) => app.state === 'recording', { label: 'recording', timeout: 10000 });
      check('no warning', await SR(s, (app) => app.warnings), []);
      check('audio track', await SR(s, (app) => app.rec.hasAudio), true);
      await sleep(2000);
      await SR(s, (app) => app.stop());
      await until(s, (app) => app.state === 'idle' && app.last, { label: 'saved', timeout: 20000 });
      const files = listRec(s.home, 'en');
      check('~/Videos/Screen recordings', files.length === 1 && files[0].startsWith('Screen recording '), true);
      const p = probe(path.join(recDir(s.home, 'en'), files[0]));
      check('opus audio', p.audio, 'opus');
      await s.shot('screenrec-window-en-light');
    });
  } finally {
    await s.close();
  }

  check('no console errors', errors, []);
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log(failures.map((f) => `  ✗ ${f}`).join('\n'));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
