// Video Editor tests — drive the real Electron shell with Playwright.
//   Import (file picker opens; files probed with ffprobe), media bin (kinds, durations), add to the timeline (double
//   click, "+" button, HTML5 drag from the bin onto the video track), split at the playhead (S), trim handles, reorder by
//   drag, delete (Delete) with undo / redo (Ctrl+Z / Ctrl+Y), title cards and text over a clip (size, position, colour
//   from the theme tokens), fades (preview opacity), per-clip volume, music fade in / out, preview synced with the
//   timeline (seek, Space / K / J / L, the <video> element follows), zoom, save as JSON in ~/Videos/Projets and reopen,
//   export dialog, a real MP4 export (H.264 + AAC, 720p, checked with ffprobe) with progress, export cancel (partial
//   file removed), unsaved-changes prompt, French + dark / light, console errors.
//   Documentation screenshots: aurora-os/docs/screenshots/videoeditor-dark-fr.png, videoeditor-light-fr.png,
//   videoeditor-export-fr.png
// Usage:  cd aurora-os/shell && xvfb-run -a -s "-screen 0 1600x900x24" node test/videoeditor.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { launchShell, ROOT } from './lib.mjs';
import { makeMedia } from './fixtures/videoeditor/make-media.mjs';

const DOCS = path.join(ROOT, '..', 'docs', 'screenshots');
fs.mkdirSync(DOCS, { recursive: true });

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
const W = '.win.app-videoeditor';
/** Evaluate fn(app, arg) in the shell; app = the Video Editor object. */
function VE(s, fn, arg) {
  return s.page.evaluate(`(async () => { const el = document.querySelector('${W}'); return (${fn.toString()})(el && el.__videoeditor, ${JSON.stringify(arg ?? null)}); })()`);
}
async function until(s, fn, { timeout = 10000, label = 'condition', arg } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = await VE(s, fn, arg).catch((e) => `ERR ${e.message}`);
    if (last && !String(last).startsWith('ERR')) return last;
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${label} (last: ${JSON.stringify(last)})`);
}
const state = (s) => VE(s, (a) => ({ video: a.p.video.map((c) => ({ type: c.type, mediaId: c.mediaId, in: c.in, out: c.out, duration: c.duration, fade: c.fade, text: c.text })), music: a.p.music.map((c) => ({ in: c.in, out: c.out, fadeIn: c.fadeIn, fadeOut: c.fadeOut, volume: c.volume })), media: a.p.media.map((m) => [m.name, m.kind, Math.round(m.duration * 10) / 10]), sel: a.sel, time: a.time, dirty: a.dirty }));
const clipBox = (s, i, track = 'video') => s.page.locator(`${W} .ve-lane-${track} .ve-clip`).nth(i).boundingBox();

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-home-ve-'));
const media = makeMedia(path.join(home, 'Videos'));
if (!media) {
  console.log('videoeditor: ffmpeg is missing on this machine, cannot make the test media');
  process.exit(1);
}

const s = await launchShell({ home, open: ['videoeditor'], lang: 'fr', theme: 'dark', size: '1280x720' });
const page = s.page;
await page.waitForSelector(`${W} .ve-root`, { timeout: 20000 });

await section('opens empty, French, maximized', async () => {
  await VE(s, (a) => a.win.maximize());
  await sleep(300);
  const t = await page.textContent(`${W} .ve-bin`);
  check('bin title FR', t.includes('Médias') && t.includes('Importer'), true);
  check('empty bin hint', t.includes('Déposez ici'), true);
  check('empty preview hint', await page.isVisible(`${W} .ve-stage-empty`), true);
  check('inspector hint', (await page.textContent(`${W} .ve-inspector`)).includes('Sélectionnez un clip'), true);
  check('export primary', (await page.textContent(`${W} .ve-export`)).trim(), 'Exporter');
});

await section('import: file picker and probing', async () => {
  await page.click(`${W} .ve-import`);
  await page.waitForSelector('.dialog', { timeout: 5000 });
  check('file picker opens', await page.isVisible('.dialog'), true);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.dialog', { state: 'detached', timeout: 5000 }).catch(() => {});
  await VE(s, (a, m) => a.importPaths([m.video, m.video2, m.image, m.music]), media);
  const st = await state(s);
  check('bin kinds', st.media.map((m) => m[1]), ['video', 'video', 'image', 'audio']);
  check('durations probed', st.media.map((m) => m[2]), [4, 3, 0, 8]);
  check('4 bin items', await page.locator(`${W} .ve-media`).count(), 4);
  const bad = path.join(home, 'Videos', 'notes.txt');
  fs.writeFileSync(bad, 'x');
  await VE(s, (a, f) => a.importPaths([f]), bad);
  check('non-media refused with a message', await page.textContent(`${W} .ve-toast`), (t) => t.includes('notes.txt'));
});

await section('add to the timeline: double click, + button, drag from the bin', async () => {
  await page.dblclick(`${W} .ve-media[data-kind="video"] >> nth=0`);
  await page.hover(`${W} .ve-media[data-kind="image"]`);
  await page.click(`${W} .ve-media[data-kind="image"] .ve-media-add`);
  await page.hover(`${W} .ve-media[data-kind="audio"]`);
  await page.click(`${W} .ve-media[data-kind="audio"] .ve-media-add`);
  // HTML5 drag of the second video between clip 1 and the photo
  const b1 = await clipBox(s, 0);
  await page.dragAndDrop(`${W} .ve-media[data-kind="video"] >> nth=1`, `${W} .ve-lane-video`, { targetPosition: { x: b1.width + 4, y: 30 } });
  await sleep(200);
  let st = await state(s);
  if (st.video.length !== 3) {
    // fall back to a synthetic drop (some xvfb setups drop HTML5 drags)
    await VE(s, (a) => {
      const id = a.p.media[1].id;
      const dt = new DataTransfer();
      dt.setData('application/x-videoeditor-media', id);
      const r = a.laneV.getBoundingClientRect();
      const x = r.left + 4 * a.pps + 4;
      a.laneV.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, clientX: x, clientY: r.top + 20 }));
      a.laneV.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true, clientX: x, clientY: r.top + 20 }));
    });
    await sleep(200);
    st = await state(s);
  }
  check('video track order', st.video.map((c) => c.mediaId), await VE(s, (a) => [a.p.media[0].id, a.p.media[1].id, a.p.media[2].id]));
  check('photo default 4 s', st.video[2].out - st.video[2].in, 4);
  check('music on the music track', st.music.length, 1);
  check('total 11 s', await VE(s, (a) => a.timeLabel.textContent), (t) => t.endsWith('0:11.0'));
  check('preview visible', await page.isVisible(`${W} .ve-picture`), true);
});

await section('split at the playhead (S), trim handle, reorder by drag', async () => {
  await VE(s, (a) => (a.sel = null, a.seek(2), a.root.focus()));
  await page.keyboard.press('s');
  let st = await state(s);
  check('split → 4 clips', st.video.length, 4);
  check('split point', [st.video[0].out, st.video[1].in, st.video[1].out], [2, 2, 4]);
  // trim the end of the first clip by 0.5 s
  const pps = await VE(s, (a) => a.pps);
  const b = await clipBox(s, 0);
  await page.mouse.move(b.x + b.width - 3, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width - 3 - pps * 0.25, b.y + b.height / 2, { steps: 3 });
  await page.mouse.move(b.x + b.width - 3 - pps * 0.5, b.y + b.height / 2, { steps: 3 });
  await page.mouse.up();
  st = await state(s);
  check('trim end', Math.round(st.video[0].out * 10) / 10, 1.5);
  // drag the photo (last) to the start
  const bp = await clipBox(s, 3);
  await page.mouse.move(bp.x + bp.width / 2, bp.y + bp.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(bp.x + bp.width / 2 - (i / 6) * (bp.x - 10), bp.y + bp.height / 2);
  await page.mouse.up();
  st = await state(s);
  check('photo moved first', st.video[0].mediaId, await VE(s, (a) => a.p.media[2].id));
});

await section('delete with undo / redo', async () => {
  const n0 = (await state(s)).video.length;
  const b = await clipBox(s, 1);
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await page.keyboard.press('Delete');
  check('deleted', (await state(s)).video.length, n0 - 1);
  await page.keyboard.press('Control+z');
  check('undo', (await state(s)).video.length, n0);
  await page.keyboard.press('Control+y');
  check('redo', (await state(s)).video.length, n0 - 1);
  await page.keyboard.press('Control+z');
  check('undo again', (await state(s)).video.length, n0);
  check('undo button enabled', await page.isEnabled(`${W} .ve-toolbar button[aria-label^="Annuler"]`), true);
});

await section('title card and text over a clip', async () => {
  // a title card after the first clip
  await VE(s, (a) => (a.sel = a.p.video[0].id));
  await page.click(`${W} .ve-addtitle`);
  let st = await state(s);
  check('title inserted second', st.video[1].type, 'title');
  check('title default text', st.video[1].text.value, 'Titre');
  const ta = page.locator(`${W} .ve-inspector textarea`);
  await ta.fill('Nos vacances');
  await ta.dispatchEvent('change');
  await page.click(`${W} .ve-inspector .segmented button:has-text("Haut")`);
  await page.click(`${W} .ve-inspector .ve-field:has-text("Couleur du texte") .ve-swatch[title="Ambre"]`);
  st = await state(s);
  check('title text', st.video[1].text.value, 'Nos vacances');
  check('title position', st.video[1].text.pos, 'top');
  check('colour from the tokens', st.video[1].text.color, (c) => /^#[0-9a-f]{6}$/.test(c) && c !== '#ffffff');
  const start = await VE(s, (a) => a.p.video[0].out - a.p.video[0].in);
  await VE(s, (a, t) => a.seek(t + 1), start);
  check('overlay shows the title', await page.textContent(`${W} .ve-overlay`), 'Nos vacances');
  check('overlay at the top', await page.getAttribute(`${W} .ve-overlay`, 'data-pos'), 'top');
  check('title background shown', await page.isVisible(`${W} .ve-titlebg`), true);
  // text over the video clip after the title
  const vb = await clipBox(s, 2);
  await page.mouse.click(vb.x + 10, vb.y + vb.height / 2);
  await page.locator(`${W} .ve-inspector textarea`).fill('Au bord de la mer');
  await page.locator(`${W} .ve-inspector textarea`).dispatchEvent('change');
  st = await state(s);
  check('text over clip', [st.video[2].text?.value, st.video[2].text?.pos], ['Au bord de la mer', 'bottom']);
  check('overlay over video', await page.textContent(`${W} .ve-overlay`), 'Au bord de la mer');
  check('video element shown', await page.isVisible(`${W} .ve-vid`), true);
});

await section('fade, volume, music fades', async () => {
  await VE(s, (a) => (a.sel = a.p.video[2].id, a.render()));
  await page.click(`${W} .ve-inspector .segmented button:has-text("1 s")`);
  let st = await state(s);
  check('fade 1 s', st.video[2].fade, 1);
  const end = await VE(s, (a) => a.p.video.slice(0, 3).reduce((t, c) => t + (c.type === 'title' ? c.duration : c.out - c.in), 0));
  await VE(s, (a, t) => a.seek(t - 0.25), end);
  check('picture fades near the cut', Number(await page.evaluate(() => document.querySelector('.app-videoeditor .ve-picture').style.opacity)), (o) => o > 0 && o < 0.7);
  // volume slider
  await VE(s, () => {
    const sl = document.querySelector('.app-videoeditor .ve-inspector .ve-field .slider');
    sl.value = '50';
    sl.dispatchEvent(new Event('input'));
    sl.dispatchEvent(new Event('change'));
  });
  check('volume 50 %', (await VE(s, (a) => a.p.video[2].volume)), 0.5);
  // music fades
  const mb = await clipBox(s, 0, 'music');
  await page.mouse.click(mb.x + 30, mb.y + mb.height / 2);
  check('music panel', (await page.textContent(`${W} .ve-inspector`)).includes("Fondu d'entrée"), true);
  await VE(s, () => {
    const sl = [...document.querySelectorAll('.app-videoeditor .ve-inspector .slider')];
    sl[1].value = '2';
    sl[1].dispatchEvent(new Event('input'));
    sl[1].dispatchEvent(new Event('change'));
    sl[2].value = '3';
    sl[2].dispatchEvent(new Event('input'));
    sl[2].dispatchEvent(new Event('change'));
  });
  st = await state(s);
  check('music fade in / out', [st.music[0].fadeIn, st.music[0].fadeOut], [2, 3]);
  check('music fade marks drawn', await page.locator(`${W} .ve-mfade`).count(), 2);
});

await section('preview follows the timeline; Space, K, J, L', async () => {
  // seek inside the first video clip (after the photo and title)
  const first = await VE(s, (a) => {
    const i = a.p.video.findIndex((c) => c.type === 'media' && a.p.media.find((m) => m.id === c.mediaId).kind === 'video');
    let t = 0;
    for (let k = 0; k < i; k++) t += a.p.video[k].type === 'title' ? a.p.video[k].duration : a.p.video[k].out - a.p.video[k].in;
    return { t, in: a.p.video[i].in };
  });
  await VE(s, (a, t) => a.seek(t + 0.5), first.t);
  const ct = await until(s, (a, w) => Math.abs(a.vid.currentTime - w) < 0.06 && a.vid.readyState >= 2 && a.vid.currentTime, { arg: first.in + 0.5, label: 'video seek' });
  check('video element at clip in + offset', Math.round(ct * 10) / 10, Math.round((first.in + 0.5) * 10) / 10);
  await VE(s, (a) => a.root.focus());
  const t0 = await VE(s, (a) => a.time);
  await page.keyboard.press(' ');
  await sleep(700);
  const playing = await VE(s, (a) => ({ playing: a.playing, time: a.time, paused: a.vid.paused }));
  check('Space plays', playing.playing, true);
  check('time advances', playing.time - t0, (d) => d > 0.3);
  check('video plays along', playing.paused, false);
  await page.keyboard.press('k');
  check('K pauses', await VE(s, (a) => a.playing || !a.vid.paused), false);
  const t1 = await VE(s, (a) => a.time);
  await page.keyboard.press('l');
  check('L +5 s', Math.round(((await VE(s, (a) => a.time)) - t1) * 10) / 10, 5);
  await page.keyboard.press('j');
  check('J -5 s', Math.round(((await VE(s, (a) => a.time)) - t1) * 10) / 10, 0);
  // scrub on the ruler
  const r = await page.locator(`${W} .ve-ruler`).boundingBox();
  const pps = await VE(s, (a) => a.pps);
  const sl = await VE(s, (a) => a.tlScroll.scrollLeft);
  await page.mouse.click(r.x + 1 * pps - sl + 1, r.y + 10);
  check('ruler click seeks', Math.round(await VE(s, (a) => a.time)), 1);
});

await section('zoom', async () => {
  const w0 = (await clipBox(s, 0)).width;
  await page.click(`${W} button[aria-label="Zoom avant"]`);
  const w1 = (await clipBox(s, 0)).width;
  check('zoom in widens clips', w1 / w0, (r) => r > 1.3);
  await page.click(`${W} button[aria-label="Zoom arrière"]`);
  check('zoom out', Math.round((await clipBox(s, 0)).width), Math.round(w0));
});

let saved;
await section('save as JSON in ~/Videos/Projets and reopen', async () => {
  await page.fill(`${W} .ve-name`, 'Vacances 2026');
  await page.press(`${W} .ve-name`, 'Enter');
  await VE(s, (a) => a.root.focus());
  await page.keyboard.press('Control+s');
  saved = path.join(home, 'Videos', 'Projets', 'Vacances 2026.json');
  await until(s, () => true);
  await sleep(300);
  check('project file', fs.existsSync(saved), true);
  const j = JSON.parse(fs.readFileSync(saved, 'utf8'));
  check('JSON format', [j.format, j.name, j.video.length, j.music.length], ['selene-video', 'Vacances 2026', 5, 1]);
  check('not dirty', (await state(s)).dirty, false);
  check('saved message', await page.textContent(`${W} .ve-toast`), (t) => t.includes('Projets'));
  await page.keyboard.press('Control+n');
  await sleep(200);
  check('new project empty', (await state(s)).video.length, 0);
  check('reopen', await VE(s, (a, f) => a.openPath(f), saved), true);
  const st = await state(s);
  check('reopened clips', [st.video.length, st.music.length, st.video[1].text.value], [5, 1, 'Nos vacances']);
  check('open dialog lists the projects folder', await (async () => {
    await page.keyboard.press('Control+o');
    await page.waitForSelector('.dialog', { timeout: 5000 });
    const t = await page.textContent('.dialog');
    await page.keyboard.press('Escape');
    await sleep(200);
    return t.includes('Vacances 2026');
  })(), true);
});

await section('screenshots FR dark', async () => {
  await VE(s, (a) => {
    a.sel = a.p.video[1].id;
    a.render();
    a.seek((a.p.video[0].out - a.p.video[0].in) + 1.2);
  });
  await sleep(500);
  const f = await s.shot('videoeditor-dark-fr');
  fs.copyFileSync(f, path.join(DOCS, 'videoeditor-dark-fr.png'));
  await page.click(`${W} .ve-export`);
  await page.waitForSelector('.ve-export-dialog', { timeout: 5000 });
  check('export dialog qualities', await page.textContent('.ve-export-dialog'), (t) => t.includes('720p') && t.includes('1080p') && t.includes('~/Videos'));
  check('export file name', await page.inputValue('.ve-export-dialog .ve-out-name'), 'Vacances 2026.mp4');
  await sleep(200);
  const f2 = await s.shot('videoeditor-export-fr');
  fs.copyFileSync(f2, path.join(DOCS, 'videoeditor-export-fr.png'));
  await page.click('.ve-export-dialog button:has-text("Annuler")');
  await sleep(200);
});

await section('export MP4 720p with progress (ffmpeg)', async () => {
  const out = path.join(home, 'Videos', 'Vacances 2026.mp4');
  const res = VE(s, (a, o) => {
    window.__veProgress = [];
    a.api.on('videoeditor:progress', (e) => window.__veProgress.push(e.percent));
    return a.startExport(o, 720);
  }, out);
  await sleep(300);
  check('progress banner', await page.textContent(`${W} .ve-banner`), (t) => t.includes('Exportation de Vacances 2026.mp4'));
  check('export result', await res, 'done');
  check('done banner', await page.textContent(`${W} .ve-banner`), (t) => t.includes('Vidéo exportée') && t.includes('Ouvrir'));
  check('progress events', await page.evaluate(() => window.__veProgress.at(-1)), 100);
  const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', out], { encoding: 'utf8' }));
  const vs = info.streams.find((x) => x.codec_type === 'video');
  const as = info.streams.find((x) => x.codec_type === 'audio');
  check('h264 1280x720', [vs?.codec_name, vs?.width, vs?.height], ['h264', 1280, 720]);
  check('aac audio', as?.codec_name, 'aac');
  const total = await VE(s, (a) => a.p.video.reduce((t, c) => t + (c.type === 'title' ? c.duration : c.out - c.in), 0));
  check('duration = timeline', Number(info.format.duration), (d) => Math.abs(d - total) < 0.2);
  // a frame of the title card (text drawn by drawtext)
  const png = path.join(home, 'frame.png');
  const tTitle = await VE(s, (a) => a.p.video[0].out - a.p.video[0].in + 1);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(tTitle), '-i', out, '-frames:v', '1', png]);
  check('title frame extracted', fs.statSync(png).size > 2000, true);
  fs.copyFileSync(png, path.join(s.page ? path.join(ROOT, 'test', 'out') : home, 'videoeditor-export-frame.png'));
});

await section('export cancel removes the partial file', async () => {
  const out = path.join(home, 'Videos', 'Annulé.mp4');
  // make the job long enough to cancel: a 60 s photo at 1080p
  await VE(s, (a) => {
    a.hist.commit(a.p);
    a.p.video.push({ id: 'long', type: 'media', mediaId: a.p.media[2].id, in: 0, out: 120, fade: 0, text: null });
  });
  const res = VE(s, (a, o) => a.startExport(o, 1080), out);
  await until(s, (a) => !!a.job, { label: 'job id' });
  await sleep(400);
  await page.click(`${W} .ve-cancel`);
  check('canceled', await res, 'canceled');
  await sleep(300);
  check('partial file removed', fs.existsSync(out), false);
  check('cancel banner', await page.textContent(`${W} .ve-banner`), (t) => t.includes('Exportation annulée'));
  await VE(s, (a) => a.undo());
});

await section('light theme screenshot', async () => {
  await page.evaluate(() => window.__aurora.settings.set('theme', 'light'));
  await sleep(700);
  await VE(s, (a) => {
    a.banner.hidden = true;
    a.sel = a.p.video[2].id;
    a.render();
    a.seek(a.p.video[0].out - a.p.video[0].in + a.p.video[1].duration + 1);
  });
  await sleep(600);
  const f = await s.shot('videoeditor-light-fr');
  fs.copyFileSync(f, path.join(DOCS, 'videoeditor-light-fr.png'));
});

await section('unsaved changes prompt on close', async () => {
  await page.click(`${W} .ve-addtitle`);
  check('dirty', (await state(s)).dirty, true);
  const closing = VE(s, (a) => a.win.close());
  await page.waitForSelector('.dialog:has-text("Enregistrer les modifications")', { timeout: 5000 });
  check('prompt shown', await page.isVisible('.dialog:has-text("Ne pas enregistrer")'), true);
  await page.click('.dialog button:has-text("Annuler")');
  await closing.catch(() => {});
  await sleep(300);
  check('still open after Cancel', await page.locator(W).count(), 1);
});

await section('no console errors', async () => {
  const errs = s.logs.filter((l) => (l.startsWith('[error]') || l.startsWith('[pageerror]')) && !/media:\/\/|Failed to load resource|ERR_ABORTED|net::/.test(l));
  check('console errors', errs, []);
});

await s.close();
fs.rmSync(home, { recursive: true, force: true });
console.log(`videoeditor: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  ✗ ${f}`);
process.exit(failures.length ? 1 : 0);
