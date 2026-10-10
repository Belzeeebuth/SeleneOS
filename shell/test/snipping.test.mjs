// Functional tests for the Snipping Tool (renderer/apps/snipping).
// Run: cd aurora-os/shell && xvfb-run -a -s "-screen 0 1600x900x24" node test/snipping.test.mjs [--only=name]
// Drives the real shell with Playwright (mouse / keyboard on the real overlay and editor), reads
// pixels back from the editor and from the PNG files written to ~/Pictures/Screenshots, and writes
// screenshots to test/out/ and docs/screenshots/snipping-*.png.
import { launchShell } from './lib.mjs';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DOCS = path.join(here, '..', '..', 'docs', 'screenshots');
fs.mkdirSync(DOCS, { recursive: true });
const ONLY = process.argv.find((a) => a.startsWith('--only='))?.slice(7);

const results = [];
let current = null;
async function test(name, fn) {
  if (ONLY && !name.includes(ONLY)) return;
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name} (${Date.now() - t0} ms)`);
  } catch (err) {
    results.push({ name, ok: false, err });
    const where = String(err?.stack || '').split('\n').find((l) => l.includes('snipping.test.mjs')) || '';
    console.log(`FAIL  ${name}\n      ${String(err?.message || err).split('\n').slice(0, 20).join('\n      ')}\n      ${where.trim()}`);
    if (current) await cleanup(current).catch(() => {});
  }
}

// ------------------------------------------------------------------ helpers
const WIN = '.win.app-snipping';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Evaluate fn(app, winEl, arg) against the snipping controller (win.el.__snip).
function S(s, fn, arg) {
  const expr = `(() => { const el = [...document.querySelectorAll(${JSON.stringify(WIN)})].pop(); return (${fn.toString()})(el && el.__snip, el, ${JSON.stringify(arg ?? null)}); })()`;
  return s.page.evaluate(expr);
}
const A = (s, fn, arg) => s.page.evaluate(fn, arg);
async function waitFor(s, fn, arg, { timeout = 15000, what } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await A(s, fn, arg).catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timeout waiting for ${what || fn}`);
    await sleep(50);
  }
}
const waitSnip = (s, fn, arg, opts) =>
  waitFor(
    s,
    new Function('arg', `const el = [...document.querySelectorAll(${JSON.stringify(WIN)})].pop(); return (${fn.toString()})(el && el.__snip, el, arg);`),
    arg,
    opts,
  );
const overlayUp = (s) => waitFor(s, () => !!document.querySelector('.snip-overlay') && document.activeElement?.closest?.('.snip-overlay'), null, { what: 'overlay' });
const overlayGone = (s) => waitFor(s, () => !document.querySelector('.snip-overlay'), null, { what: 'overlay gone' });
const editorShown = (s) => waitSnip(s, (app, el) => app && app.view === 'editor' && !app.hidden && el.classList.contains('active') && !app.session, null, { what: 'editor shown' });
const near = (a, b, tol = 6) => a.length >= b.length && b.every((v, i) => Math.abs(a[i] - v) <= tol);
function pngSize(file) {
  const b = fs.readFileSync(file);
  assert.equal(b.toString('latin1', 1, 4), 'PNG', `PNG signature of ${file}`);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}
function pngBytesSize(bytes) {
  const b = Buffer.from(bytes);
  assert.equal(b.toString('latin1', 1, 4), 'PNG', 'clipboard holds a PNG');
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}
// Pixel of a saved image file, decoded in the shell.
function filePixel(s, file, x, y) {
  return A(
    s,
    async ([file, x, y]) => {
      const blob = await (await fetch(window.__aurora.api.mediaUrl(file))).blob();
      const bmp = await createImageBitmap(blob);
      const c = document.createElement('canvas');
      c.width = bmp.width;
      c.height = bmp.height;
      const g = c.getContext('2d');
      g.drawImage(bmp, 0, 0);
      return [...g.getImageData(x, y, 1, 1).data];
    },
    [file, x, y],
  );
}
async function clipboardImage(s) {
  const bytes = await A(s, () => window.__aurora.api.invoke('snipping:clipboardReadImage').then((b) => (b ? [...b] : null)));
  return bytes ? pngBytesSize(bytes) : null;
}
function shots(home) {
  const dir = path.join(home, 'Pictures', 'Screenshots');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.png')).sort() : [];
}
function errorsOf(s) {
  return s.logs.filter((l) => l.startsWith('[pageerror]') || (l.startsWith('[error]') && !/Failed to load resource/.test(l)) || /\[warning\] \[icons\]/.test(l));
}
// A solid-colour probe window (the body is painted `color`) at a known place.
function probeWindow(s, { x, y, width, height, color, title = 'Probe' }) {
  return A(
    s,
    ({ x, y, width, height, color, title }) => {
      const w = window.__aurora.wm.create({ appId: 'probe', title, x, y, width, height, background: 'solid' });
      w.body.style.background = color;
      return w.id;
    },
    { x, y, width, height, color, title },
  );
}
async function drag(s, pts, { steps = 10 } = {}) {
  const m = s.page.mouse;
  await m.move(pts[0][0], pts[0][1]);
  await m.down();
  for (let i = 1; i < pts.length; i++) await m.move(pts[i][0], pts[i][1], { steps });
  await m.up();
}
// Client position of an image pixel in the editor.
function imgClient(s, x, y) {
  return S(
    s,
    (app, el, [x, y]) => {
      const r = app.editor.wrap.getBoundingClientRect();
      return [r.left + ((x + 0.5) * r.width) / app.editor.W, r.top + ((y + 0.5) * r.height) / app.editor.H];
    },
    [x, y],
  );
}
async function cleanup(s) {
  await s.page.keyboard.press('Escape').catch(() => {});
  await A(s, () => {
    for (const w of window.__aurora.wm.byApp('snipping')) w.el.__snip?.session?.cancel();
    document.querySelectorAll('.menu, .snip-flyout, .snip-overlay, .snip-countdown').forEach((e) => e.remove());
    for (const l of document.querySelectorAll('.dialog-layer')) l.remove();
  }).catch(() => {});
}
async function closeSnipping(s) {
  await A(s, async () => {
    for (const w of window.__aurora.wm.byApp('snipping')) await w.close(true);
  });
  // A window is listed until its close animation ends (a relaunch before that would only focus it).
  await waitFor(s, () => window.__aurora.wm.byApp('snipping').length === 0, null, { what: 'snipping closed' });
}
async function openSnipping(s, args) {
  await A(s, (args) => {
    window.__aurora.shell.launch('snipping', args || {});
  }, args || null);
  await waitSnip(s, (app) => !!app && !!app.btnNew, null, { what: 'snipping launched' });
  await sleep(150);
}
async function chooseMode(s, mode) {
  await S(s, (app, el, m) => app.setMode(m), mode);
}
async function newSnip(s) {
  await s.page.click(`${WIN} .snip-new`);
}
async function savePicker(s, name) {
  await s.page.waitForSelector('.fp-dialog', { timeout: 5000 });
  const input = s.page.locator('.fp-dialog .fp-bottom input');
  await input.fill(name);
  await s.page.click('.fp-dialog .dialog-footer .btn.primary');
}

// Probe geometry: a red window body; the title bar is 32 px tall.
const PROBE = { x: 300, y: 160, width: 520, height: 360, color: 'rgb(255, 0, 0)' };
const PROBE2 = { x: 900, y: 220, width: 400, height: 300, color: 'rgb(0, 0, 255)', title: 'Probe 2' };

// ================================================================== session 1: English, light
{
  const s = await launchShell({ open: [], lang: 'en', theme: 'light' });
  current = s;
  const home = s.home;
  const pics = path.join(home, 'Pictures', 'Screenshots');

  await test('launches as the compact Windows 11 toolbar window (not resizable)', async () => {
    await s.page.mouse.click(1500, 400); // a pointer interaction first, as a real user would (no focus ring)
    await openSnipping(s);
    const info = await S(s, (app, el) => ({
      rect: app.win.rect(),
      view: app.view,
      resizable: app.win.opts.resizable,
      maximizable: app.win.opts.maximizable,
      handles: [...el.querySelectorAll('.win-resize')].filter((r) => getComputedStyle(r).display !== 'none').length,
      maxBtn: getComputedStyle(el.querySelector('.win-max')).display,
      newText: el.querySelector('.snip-new').textContent,
      delay: el.querySelector('.snip-delay').textContent,
      hint: el.querySelector('.snip-hint').textContent,
      title: app.win.title,
      visible: getComputedStyle(el).visibility,
    }));
    assert.equal(info.view, 'compact');
    assert.equal(info.rect.width, 548);
    assert.equal(info.rect.height, 178);
    assert.equal(info.resizable, false);
    assert.equal(info.maximizable, false);
    assert.equal(info.handles, 0, 'no resize handles in compact mode');
    assert.equal(info.maxBtn, 'none');
    assert.equal(info.newText, 'New');
    assert.match(info.delay, /No delay/);
    assert.match(info.hint, /Print Screen/);
    assert.equal(info.title, 'Snipping Tool');
    assert.equal(info.visible, 'visible');
    await s.shot('snipping-compact-light-en');
    fs.copyFileSync(path.join(here, 'out', 'snipping-compact-light-en.png'), path.join(DOCS, 'snipping-compact.png'));
  });

  await test('mode and delay dropdowns update the toolbar and are remembered', async () => {
    await s.page.click(`${WIN} .snip-mode`);
    await s.page.waitForSelector('.menu .menu-item');
    const items = await A(s, () => [...document.querySelectorAll('.menu .menu-item .label')].map((e) => e.textContent));
    assert.deepEqual(items, ['Rectangle', 'Window', 'Full screen', 'Free-form']);
    await s.page.locator('.menu .menu-item', { hasText: 'Free-form' }).click();
    await sleep(100);
    assert.equal(await S(s, (app) => app.prefs.mode), 'free');
    assert.equal(await S(s, (app, el) => el.querySelector('.snip-mode .snip-dd-icon .icon').dataset.icon), 'lasso');
    await s.page.click(`${WIN} .snip-delay`);
    await s.page.waitForSelector('.menu .menu-item');
    const delays = await A(s, () => [...document.querySelectorAll('.menu .menu-item .label')].map((e) => e.textContent));
    assert.deepEqual(delays, ['No delay', '3 seconds', '5 seconds', '10 seconds']);
    await s.page.locator('.menu .menu-item', { hasText: '5 seconds' }).click();
    await sleep(400);
    assert.match(await S(s, (app, el) => el.querySelector('.snip-delay').textContent), /5 s/);
    const stored = await A(s, () => window.__aurora.api.invoke('storage:get', 'snipping', 'prefs', null));
    assert.equal(stored?.mode, 'free');
    assert.equal(stored?.delay, 5);
    await S(s, (app) => (app.setMode('rect'), app.setDelay(0)));
  });

  await test('full-screen snip: PNG of the whole screen, auto-saved, on the clipboard, app window not captured', async () => {
    await chooseMode(s, 'full');
    const before = shots(home).length;
    await newSnip(s);
    await editorShown(s);
    const info = await S(s, (app) => ({ W: app.editor.W, H: app.editor.H, path: app.snip.savedPath, rect: app.win.rect(), dirty: app.editor.isDirty() }));
    assert.equal(info.W, 1600);
    assert.equal(info.H, 900);
    assert.equal(info.dirty, false, 'auto-saved snip is clean');
    assert.ok(info.rect.width <= 1600 * 0.8 + 1 && info.rect.height <= 900 * 0.8 + 1, `editor window within 80% of the screen (${JSON.stringify(info.rect)})`);
    assert.ok(info.rect.width >= 900, 'editor window grew');
    const list = shots(home);
    assert.equal(list.length, before + 1, 'one screenshot file written');
    assert.match(list[list.length - 1], /^Screenshot \d{4}-\d\d-\d\d \d{6}\.png$/);
    assert.equal(info.path, path.join(pics, list[list.length - 1]));
    assert.deepEqual(pngSize(info.path), { w: 1600, h: 900 });
    assert.deepEqual(await clipboardImage(s), { w: 1600, h: 900 });
    // The compact window was centred around (716, 362): the capture shows the wallpaper there, not the app.
    const px = await S(s, (app) => app.editor.pixel(700, 300));
    const ui = await S(s, (app) => app.editor.pixel(475, 296));
    assert.ok(!near(ui, [0, 95, 184, 255], 30), `the accent "New" button is not in the capture (${ui})`);
    assert.ok(px[3] === 255);
  });

  await test('rectangle snip: dragging on the overlay crops exactly the selected pixels', async () => {
    await probeWindow(s, PROBE);
    await sleep(350);
    await openSnipping(s);
    await chooseMode(s, 'rect');
    await newSnip(s);
    await overlayUp(s);
    // No app window in the frozen screen, the overlay covers everything incl. the taskbar.
    const ov = await A(s, () => {
      const o = document.querySelector('.snip-overlay');
      const r = o.getBoundingClientRect();
      const tb = document.getElementById('taskbar');
      return { w: r.width, h: r.height, z: getComputedStyle(o).zIndex, mode: o.dataset.mode, hit: document.elementFromPoint(800, 880)?.closest('.snip-overlay') != null, tbVisible: !!tb };
    });
    assert.equal(ov.w, 1600);
    assert.equal(ov.h, 900);
    assert.equal(ov.mode, 'rect');
    assert.ok(ov.hit, 'overlay is on top of the taskbar');
    const x0 = PROBE.x + 100;
    const y0 = PROBE.y + 120;
    await s.page.mouse.move(x0, y0);
    await s.page.mouse.down();
    await s.page.mouse.move(x0 + 160, y0 + 90, { steps: 8 });
    const label = await A(s, () => document.querySelector('.snip-overlay .snip-size').textContent);
    assert.equal(label, '160 × 90');
    await s.shot('snipping-overlay-region-light-en');
    fs.copyFileSync(path.join(here, 'out', 'snipping-overlay-region-light-en.png'), path.join(DOCS, 'snipping-overlay-region.png'));
    await s.page.mouse.move(x0 + 240, y0 + 150, { steps: 6 });
    await s.page.mouse.up();
    await overlayGone(s);
    await editorShown(s);
    const info = await S(s, (app) => ({ W: app.editor.W, H: app.editor.H, c: app.editor.pixel(120, 75), tl: app.editor.pixel(0, 0), br: app.editor.pixel(239, 149) }));
    assert.equal(info.W, 240);
    assert.equal(info.H, 150);
    for (const p of [info.c, info.tl, info.br]) assert.ok(near(p, [255, 0, 0, 255], 3), `snip is the red probe body (${p})`);
    const file = await S(s, (app) => app.snip.savedPath);
    assert.deepEqual(pngSize(file), { w: 240, h: 150 });
    assert.ok(near(await filePixel(s, file, 5, 5), [255, 0, 0, 255], 3));
    assert.deepEqual(await clipboardImage(s), { w: 240, h: 150 });
  });

  await test('window snip: hovering highlights a window and clicking captures exactly its rectangle', async () => {
    await probeWindow(s, PROBE2);
    await sleep(350);
    const rect = await A(s, () => window.__aurora.wm.list().find((x) => x.title === 'Probe 2').rect());
    await chooseMode(s, 'window');
    await newSnip(s);
    await overlayUp(s);
    await s.page.mouse.move(rect.x + 200, rect.y + 150, { steps: 4 });
    await sleep(80);
    const target = await A(s, () => document.querySelector('.snip-overlay').__snip.state.target);
    assert.equal(target.kind, 'window');
    assert.equal(target.title, 'Probe 2');
    assert.deepEqual(target.rect, rect);
    const outline = await A(s, () => getComputedStyle(document.querySelector('.snip-overlay .snip-win-outline')).display);
    assert.notEqual(outline, 'none');
    await s.shot('snipping-overlay-window-light-en');
    fs.copyFileSync(path.join(here, 'out', 'snipping-overlay-window-light-en.png'), path.join(DOCS, 'snipping-overlay-window.png'));
    // Moving over the other probe highlights that one instead (top-most window under the pointer).
    await s.page.mouse.move(PROBE.x + 60, PROBE.y + 200, { steps: 4 });
    assert.equal(await A(s, () => document.querySelector('.snip-overlay').__snip.state.target.title), 'Probe');
    await s.page.mouse.move(rect.x + 200, rect.y + 150, { steps: 4 });
    await s.page.mouse.click(rect.x + 200, rect.y + 150);
    await overlayGone(s);
    await editorShown(s);
    const info = await S(s, (app) => ({ W: app.editor.W, H: app.editor.H, body: app.editor.pixel(200, 160) }));
    assert.equal(info.W, rect.width);
    assert.equal(info.H, rect.height);
    assert.ok(near(info.body, [0, 0, 255, 255], 3), `window body is blue (${info.body})`);
  });

  await test('Esc cancels a snip and restores the app window as it was', async () => {
    const before = shots(home).length;
    const prev = await S(s, (app) => ({ view: app.view, W: app.editor.W, rect: app.win.rect() }));
    await chooseMode(s, 'rect');
    await newSnip(s);
    await overlayUp(s);
    assert.equal(await S(s, (app, el) => getComputedStyle(el).visibility), 'hidden', 'app window hidden while snipping');
    await s.page.mouse.move(200, 200);
    await s.page.mouse.down();
    await s.page.mouse.move(400, 300, { steps: 4 });
    await s.page.keyboard.press('Escape');
    await s.page.mouse.up();
    await overlayGone(s);
    await editorShown(s);
    const now = await S(s, (app, el) => ({ view: app.view, W: app.editor.W, rect: app.win.rect(), vis: getComputedStyle(el).visibility }));
    assert.equal(now.view, prev.view);
    assert.equal(now.W, prev.W, 'previous snip still in the editor');
    assert.deepEqual(now.rect, prev.rect);
    assert.equal(now.vis, 'visible');
    assert.equal(shots(home).length, before, 'nothing saved');
    // The X button of the overlay toolbar cancels too.
    await newSnip(s);
    await overlayUp(s);
    await s.page.click('.snip-overlay .snip-bar-close');
    await overlayGone(s);
    await editorShown(s);
  });

  await test('free-form snip masks everything outside the lasso as transparent', async () => {
    await chooseMode(s, 'free');
    await newSnip(s);
    await overlayUp(s);
    const cx = PROBE.x + 200;
    const cy = PROBE.y + 200;
    const pts = [];
    for (let i = 0; i <= 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      pts.push([Math.round(cx + Math.cos(a) * 90), Math.round(cy + Math.sin(a) * 90)]);
    }
    await drag(s, pts, { steps: 2 });
    await overlayGone(s);
    await editorShown(s);
    const info = await S(s, (app) => ({ W: app.editor.W, H: app.editor.H, corner: app.editor.pixel(2, 2), center: app.editor.pixel(Math.floor(app.editor.W / 2), Math.floor(app.editor.H / 2)) }));
    assert.ok(Math.abs(info.W - 180) <= 2 && Math.abs(info.H - 180) <= 2, `bounding box of the lasso (${info.W}×${info.H})`);
    assert.equal(info.corner[3], 0, 'outside the lasso is transparent');
    assert.ok(near(info.center, [255, 0, 0, 255], 3), `inside is the red probe (${info.center})`);
    const file = await S(s, (app) => app.snip.savedPath);
    assert.equal((await filePixel(s, file, 1, 1))[3], 0, 'saved PNG keeps the transparency');
    await chooseMode(s, 'rect');
  });

  await test('annotation: pen, highlighter (multiply), stroke eraser, undo / redo', async () => {
    // A fresh white + red snip: half probe body, half white area of a second probe window.
    // Body: red top half, white bottom half (body spans y 553..839 on screen, red down to 696).
    await A(s, () => {
      const w = window.__aurora.wm.create({ appId: 'probe', title: 'Half', x: 1100, y: 520, width: 460, height: 320, background: 'solid' });
      w.body.style.background = 'linear-gradient(#ff0000 50%, #ffffff 50%)';
    });
    await sleep(400);
    await chooseMode(s, 'rect');
    await newSnip(s);
    await overlayUp(s);
    // 400×240 snip: rows 0..119 red, 120..239 white.
    await drag(s, [[1130, 576], [1530, 816]]);
    await editorShown(s);
    const size = await S(s, (app) => [app.editor.W, app.editor.H]);
    assert.deepEqual(size, [400, 240]);
    assert.ok(near(await S(s, (app) => app.editor.pixel(200, 20)), [255, 0, 0, 255], 3));
    assert.ok(near(await S(s, (app) => app.editor.pixel(200, 200)), [255, 255, 255, 255], 3));
    // Pen (default red #e81224): pick blue from its flyout first.
    await s.page.click(`${WIN} .snip-tool[data-tool="pen"]`);
    assert.equal(await S(s, (app) => app.editor.tool), 'pen');
    await s.page.click(`${WIN} .snip-tool[data-tool="pen"]`);
    await s.page.waitForSelector('.snip-flyout .snip-swatch');
    await s.page.click('.snip-flyout .snip-swatch[data-color="#0078d4"]');
    assert.equal(await S(s, (app) => app.editor.pen.color), '#0078d4');
    await s.shot('snipping-pen-flyout-light-en');
    await s.page.keyboard.press('Escape');
    assert.equal(await A(s, () => !!document.querySelector('.snip-flyout:not(.closing)')), false);
    const a = await imgClient(s, 40, 200);
    const b = await imgClient(s, 360, 200);
    await drag(s, [a, b], { steps: 16 });
    await sleep(80);
    const onLine = await S(s, (app) => app.editor.pixel(200, 200));
    assert.ok(near(onLine, [0, 120, 212, 255], 12), `pen ink on the white area (${onLine})`);
    assert.equal(await S(s, (app) => app.editor.strokes.length), 1);
    assert.equal(await S(s, (app) => app.editor.isDirty()), true);
    // Highlighter over red and white: multiply keeps the dark/red content readable.
    await s.page.click(`${WIN} .snip-tool[data-tool="hl"]`);
    const c = await imgClient(s, 200, 10);
    const d = await imgClient(s, 200, 230);
    await drag(s, [c, d], { steps: 16 });
    await sleep(80);
    const hlWhite = await S(s, (app) => app.editor.pixel(200, 150));
    const hlRed = await S(s, (app) => app.editor.pixel(200, 30));
    // white × yellow at 50 % -> (255, 255, 128) ; red × yellow -> stays red
    assert.ok(near(hlWhite, [255, 247, 128, 255], 10), `highlighter on white is translucent yellow (${hlWhite})`);
    assert.ok(near(hlRed, [255, 0, 0, 255], 4), `highlighter multiplies over red (${hlRed})`);
    assert.equal(await S(s, (app) => app.editor.strokes.length), 2);
    await s.shot('snipping-editor-annotated-light-en');
    fs.copyFileSync(path.join(here, 'out', 'snipping-editor-annotated-light-en.png'), path.join(DOCS, 'snipping-editor.png'));
    // Undo / redo (keyboard and buttons).
    await s.page.keyboard.press('Control+z');
    assert.equal(await S(s, (app) => app.editor.strokes.length), 1);
    assert.ok(near(await S(s, (app) => app.editor.pixel(200, 150)), [255, 255, 255, 255], 3), 'highlighter undone');
    await s.page.click(`${WIN} .snip-undo`);
    assert.equal(await S(s, (app) => app.editor.strokes.length), 0);
    assert.ok(near(await S(s, (app) => app.editor.pixel(200, 200)), [255, 255, 255, 255], 3), 'pen undone');
    assert.equal(await S(s, (app) => app.editor.isDirty()), false, 'back to the saved state');
    assert.equal(await S(s, (app, el) => el.querySelector('.snip-undo').disabled), true);
    await s.page.keyboard.press('Control+y');
    await s.page.click(`${WIN} .snip-redo`);
    assert.equal(await S(s, (app) => app.editor.strokes.length), 2);
    assert.ok(near(await S(s, (app) => app.editor.pixel(250, 200)), [0, 120, 212, 255], 12), 'pen redone');
    // Stroke eraser: touching the pen line removes the whole stroke (undoable).
    await s.page.click(`${WIN} .snip-tool[data-tool="eraser"]`);
    const e1 = await imgClient(s, 100, 190);
    const e2 = await imgClient(s, 100, 212);
    await drag(s, [e1, e2], { steps: 6 });
    await sleep(60);
    const left = await S(s, (app) => app.editor.strokes.map((x) => x.tool));
    assert.deepEqual(left, ['hl'], 'pen stroke erased, highlighter kept');
    assert.ok(near(await S(s, (app) => app.editor.pixel(300, 200)), [255, 255, 255, 255], 3), 'erased ink is gone');
    await s.page.keyboard.press('Control+z');
    assert.equal(await S(s, (app) => app.editor.strokes.length), 2);
    // "Erase all ink" from the eraser flyout.
    await s.page.click(`${WIN} .snip-tool[data-tool="eraser"]`);
    await s.page.waitForSelector('.snip-flyout .snip-erase-all');
    await s.page.click('.snip-flyout .snip-erase-all');
    assert.equal(await S(s, (app) => app.editor.strokes.length), 0);
    await s.page.keyboard.press('Control+z');
    assert.equal(await S(s, (app) => app.editor.strokes.length), 2);
  });

  await test('auto-copy keeps the clipboard in sync with edits; Ctrl+C copies the annotated snip', async () => {
    await sleep(900); // debounce
    const clip = await A(s, async () => {
      const b = await window.__aurora.api.invoke('snipping:clipboardReadImage');
      const bmp = await createImageBitmap(new Blob([b], { type: 'image/png' }));
      const c = document.createElement('canvas');
      c.width = bmp.width;
      c.height = bmp.height;
      c.getContext('2d').drawImage(bmp, 0, 0);
      return { w: bmp.width, h: bmp.height, px: [...c.getContext('2d').getImageData(250, 200, 1, 1).data] };
    });
    assert.equal(clip.w, 400);
    assert.ok(near(clip.px, [0, 120, 212, 255], 14), `clipboard holds the annotated image (${clip.px})`);
    await A(s, () => window.__aurora.api.invoke('clipboard:writeText', 'x'));
    await S(s, (app) => app.editor.el.focus());
    await s.page.keyboard.press('Control+c');
    await waitSnip(s, (app, el) => el.querySelector('.snip-flash.show'), null, { what: 'copied feedback' });
    assert.match(await S(s, (app, el) => el.querySelector('.snip-flash').textContent), /Copied/);
    assert.deepEqual(await clipboardImage(s), { w: 400, h: 240 });
  });

  await test('crop with handles, apply, undo', async () => {
    await s.page.click(`${WIN} .snip-tool[data-tool="crop"]`);
    assert.equal(await S(s, (app) => !!app.editor.crop), true);
    assert.equal(await S(s, (app, el) => el.querySelector('.snip-tools-crop').hidden), false, 'crop actions shown');
    // Drag the bottom-right handle up-left by 100×40 image px and the top-left one by 20×10.
    const se = await S(s, (app, el) => {
      const r = el.querySelector('.snip-ch-se').getBoundingClientRect();
      return [r.right - 4, r.bottom - 4];
    });
    const k = await S(s, (app) => app.editor.wrap.getBoundingClientRect().width / app.editor.W);
    await drag(s, [se, [se[0] - 100 * k, se[1] - 20 * k]], { steps: 6 });
    const nw = await S(s, (app, el) => {
      const r = el.querySelector('.snip-ch-nw').getBoundingClientRect();
      return [r.left + 4, r.top + 4];
    });
    await drag(s, [nw, [nw[0] + 20 * k, nw[1] + 10 * k]], { steps: 6 });
    const cr = await S(s, (app) => app.editor.cropRect);
    assert.deepEqual(cr, { x: 20, y: 10, w: 280, h: 210 });
    assert.match(await S(s, (app, el) => el.querySelector('.snip-crop-size').textContent), /280 × 210/);
    await s.shot('snipping-crop-light-en');
    fs.copyFileSync(path.join(here, 'out', 'snipping-crop-light-en.png'), path.join(DOCS, 'snipping-crop.png'));
    await s.page.keyboard.press('Enter');
    const after = await S(s, (app) => ({ W: app.editor.W, H: app.editor.H, crop: app.editor.crop, tool: app.editor.tool, strokes: app.editor.strokes.length, px: app.editor.pixel(230, 190) }));
    assert.equal(after.W, 280);
    assert.equal(after.H, 210);
    assert.equal(after.crop, null);
    assert.equal(after.tool, null);
    assert.equal(after.strokes, 2, 'ink survives the crop');
    assert.ok(near(after.px, [0, 120, 212, 255], 14), `pen line moved with the crop (${after.px})`);
    await s.page.keyboard.press('Control+z');
    assert.deepEqual(await S(s, (app) => [app.editor.W, app.editor.H]), [400, 240]);
    await s.page.keyboard.press('Control+y');
    assert.deepEqual(await S(s, (app) => [app.editor.W, app.editor.H]), [280, 210]);
    // Keyboard crop: arrows move the box, Shift+arrows resize it; Esc cancels a crop in progress.
    await s.page.click(`${WIN} .snip-tool[data-tool="crop"]`);
    await s.page.keyboard.press('Shift+ArrowLeft');
    await s.page.keyboard.press('Control+Shift+ArrowUp');
    assert.deepEqual(await S(s, (app) => app.editor.cropRect), { x: 0, y: 0, w: 279, h: 200 });
    await s.page.keyboard.press('ArrowRight');
    assert.deepEqual(await S(s, (app) => app.editor.cropRect), { x: 1, y: 0, w: 279, h: 200 });
    await s.page.keyboard.press('Escape');
    assert.equal(await S(s, (app) => app.editor.crop), null);
    assert.deepEqual(await S(s, (app) => [app.editor.W, app.editor.H]), [280, 210]);
  });

  await test('zoom: Ctrl+plus / minus / 0 and the zoom menu', async () => {
    await S(s, (app) => app.editor.el.focus());
    await s.page.keyboard.press('Control+0');
    assert.equal(await S(s, (app) => app.editor.zoom), 1);
    await s.page.keyboard.press('Control+=');
    assert.equal(await S(s, (app) => app.editor.zoom), 1.25);
    assert.equal(await S(s, (app) => Math.round(app.editor.wrap.getBoundingClientRect().width)), 350);
    await s.page.keyboard.press('Control+-');
    await s.page.keyboard.press('Control+-');
    assert.equal(await S(s, (app) => app.editor.zoom), 0.75);
    await s.page.click(`${WIN} .snip-zoom`);
    await s.page.locator('.menu .menu-item', { hasText: 'Fit to window' }).click();
    assert.equal(await S(s, (app) => app.editor.fitMode), true);
    assert.match(await S(s, (app, el) => el.querySelector('.snip-zoom-label').textContent), /^100%$/);
  });

  await test('ruler: drag, rotate, and pen strokes drawn straight along its edge', async () => {
    await s.page.click(`${WIN} .snip-ruler-btn`);
    assert.equal(await S(s, (app, el) => el.querySelector('.snip-ruler-btn').getAttribute('aria-pressed')), 'true');
    const r0 = await S(s, (app) => ({ ...app.editor.ruler }));
    assert.equal(r0.angle, 0);
    // Drag it by (+30, -20) image px (zoom is 100 %).
    const c0 = await imgClient(s, r0.cx, r0.cy);
    await drag(s, [[c0[0] + 120, c0[1]], [c0[0] + 150, c0[1] - 20]], { steps: 6 });
    const r1 = await S(s, (app) => ({ ...app.editor.ruler }));
    assert.ok(Math.abs(r1.cx - r0.cx - 30) < 1.5 && Math.abs(r1.cy - r0.cy + 20) < 1.5, `ruler moved (${JSON.stringify(r1)})`);
    // Wheel over it rotates by 1° per notch; the arrows rotate too.
    await s.page.mouse.move(c0[0] + 150, c0[1] - 20);
    for (let i = 0; i < 4; i++) await s.page.mouse.wheel(0, 100);
    await sleep(100);
    assert.equal(await S(s, (app) => app.editor.ruler.angle), 4);
    assert.equal(await S(s, (app, el) => el.querySelector('.snip-ruler-angle').textContent), '4°');
    await s.page.keyboard.press('Home');
    assert.equal(await S(s, (app) => app.editor.ruler.angle), 0);
    await S(s, (app) => {
      app.editor.ruler.cx = 140;
      app.editor.ruler.cy = 120;
      app.editor._layoutRuler();
    });
    await s.shot('snipping-ruler-light-en');
    // A wobbly pen stroke started just above the top edge (y = 120 - 32) is drawn as a straight line.
    await s.page.click(`${WIN} .snip-tool[data-tool="pen"]`);
    const n = await S(s, (app) => app.editor.strokes.length);
    const p = await imgClient(s, 40, 80);
    await drag(s, [p, [p[0] + 50, p[1] - 9], [p[0] + 100, p[1] + 4], [p[0] + 160, p[1] - 6]], { steps: 5 });
    const st = await S(s, (app) => app.editor.strokes[app.editor.strokes.length - 1]);
    assert.equal(await S(s, (app) => app.editor.strokes.length), n + 1);
    const ys = st.points.map((q) => q[1]);
    assert.ok(Math.max(...ys) - Math.min(...ys) < 0.01, `straight along the ruler (${Math.min(...ys)}..${Math.max(...ys)})`);
    assert.ok(Math.abs(ys[0] - (120 - 32 - st.size / 2 - 1)) < 0.6, `against the edge (${ys[0]})`);
    await s.page.keyboard.press('Control+z');
    await s.page.click(`${WIN} .snip-ruler-btn`);
    assert.equal(await S(s, (app, el) => !app.editor.ruler && el.querySelector('.snip-ruler-layer').hidden), true);
  });

  await test('Save as (Ctrl+S): PNG and JPEG through the file picker', async () => {
    await s.page.keyboard.press('Control+s');
    await savePicker(s, 'annotated');
    const png = path.join(home, 'Pictures', 'Screenshots', 'annotated.png');
    await waitSnip(s, (app, el, p) => app.snip.savedPath === p, png, { what: 'PNG saved' });
    assert.ok(fs.existsSync(png), 'annotated.png written next to the screenshot');
    assert.deepEqual(pngSize(png), { w: 280, h: 210 });
    assert.ok(near(await filePixel(s, png, 230, 190), [0, 120, 212, 255], 14), 'saved file contains the ink');
    assert.equal(await S(s, (app) => app.editor.isDirty()), false);
    assert.equal(await S(s, (app) => app.snip.savedPath), png);
    // JPEG: choose the JPEG filter, the extension is added.
    await S(s, (app) => {
      app.saveAs();
    });
    await s.page.waitForSelector('.fp-dialog');
    await s.page.selectOption('.fp-dialog .fp-bottom select', '1');
    await savePicker(s, 'annotated-jpeg');
    const jpg = path.join(home, 'Pictures', 'Screenshots', 'annotated-jpeg.jpg');
    await waitSnip(s, (app, el, p) => app.snip.savedPath === p, jpg, { what: 'JPEG saved' });
    const head = fs.readFileSync(jpg).subarray(0, 3);
    assert.deepEqual([...head], [0xff, 0xd8, 0xff], 'JPEG magic');
  });

  await test('unsaved edits: closing asks Save / Don\'t save / Cancel', async () => {
    const p = await imgClient(s, 30, 30);
    await s.page.click(`${WIN} .snip-tool[data-tool="pen"]`);
    await drag(s, [p, [p[0] + 60, p[1] + 30]]);
    assert.equal(await S(s, (app) => app.needsSave()), true);
    await S(s, (app) => {
      app.win.close();
    });
    await s.page.waitForSelector(`${WIN} .dialog`);
    const btns = await A(s, () => [...document.querySelectorAll('.win.app-snipping .dialog .dialog-footer .btn')].map((b) => b.textContent));
    assert.deepEqual(btns, ['Save', "Don't save", 'Cancel']);
    await s.page.locator(`${WIN} .dialog .btn`, { hasText: 'Cancel' }).click();
    await sleep(250);
    assert.equal(await A(s, () => window.__aurora.wm.byApp('snipping').length), 1, 'Cancel keeps the window');
    await S(s, (app) => {
      app.win.close();
    });
    await s.page.waitForSelector(`${WIN} .dialog`);
    await s.page.locator(`${WIN} .dialog .btn`, { hasText: "Don't save" }).click();
    await waitFor(s, () => window.__aurora.wm.byApp('snipping').length === 0, null, { what: 'closed' });
  });

  await test('PrintScreen / immediate args: overlay without the window, then editor + toast', async () => {
    await A(s, () => window.__aurora.notifications.clear());
    const before = shots(home).length;
    await A(s, () => {
      window.__aurora.hotkeys.trigger('PrintScreen');
    });
    await overlayUp(s);
    const hidden = await S(s, (app, el) => ({ vis: getComputedStyle(el).visibility, skip: app.win.opts.skipTaskbar, view: app.view, focused: window.__aurora.wm.focused() === app.win }));
    assert.equal(hidden.vis, 'hidden');
    assert.equal(hidden.skip, true, 'no taskbar button while snipping');
    assert.equal(hidden.focused, false, 'the previously active window keeps the focus');
    assert.equal(await A(s, () => document.querySelector('.snip-overlay').dataset.mode), 'rect');
    await drag(s, [[PROBE2.x + 50, PROBE2.y + 80], [PROBE2.x + 250, PROBE2.y + 180]]);
    await editorShown(s);
    const info = await S(s, (app) => ({ W: app.editor.W, H: app.editor.H, skip: app.win.opts.skipTaskbar }));
    assert.deepEqual([info.W, info.H], [200, 100]);
    assert.equal(info.skip, false);
    assert.equal(shots(home).length, before + 1);
    const toast = await waitFor(s, () => {
      const t = [...document.querySelectorAll('#toasts .toast')].pop();
      return t && { title: t.querySelector('.toast-title')?.textContent, body: t.querySelector('.toast-body')?.textContent, app: t.querySelector('.toast-head')?.textContent };
    });
    assert.equal(toast.title, 'Snip copied to clipboard');
    assert.equal(toast.body, 'Select here to mark up and share the image');
    assert.match(toast.app, /Snipping Tool/);
    await s.shot('snipping-toast-light-en');
    fs.copyFileSync(path.join(here, 'out', 'snipping-toast-light-en.png'), path.join(DOCS, 'snipping-toast.png'));
    // A second snip (Super+Shift+S path), then clicking the first toast reopens the first snip.
    const firstId = await S(s, (app) => app.snip.id);
    await A(s, () => {
      window.__aurora.hotkeys.trigger('Super+Shift+S');
    });
    await overlayUp(s);
    await drag(s, [[PROBE.x + 50, PROBE.y + 80], [PROBE.x + 130, PROBE.y + 130]]);
    await editorShown(s);
    assert.deepEqual(await S(s, (app) => [app.editor.W, app.editor.H]), [80, 50]);
    await A(s, () => {
      window.__aurora.wm.focusTop();
    });
    const toastEl = s.page.locator('#toasts .toast', { hasText: 'Snip copied' }).first();
    await toastEl.click({ position: { x: 60, y: 60 } });
    await waitSnip(s, (app, el, id) => app.snip.id === id && app.win.isFocused(), firstId, { what: 'first snip reopened' });
    assert.deepEqual(await S(s, (app) => [app.editor.W, app.editor.H]), [200, 100]);
  });

  await test('immediate snip while the app is closed: Esc closes the app again', async () => {
    await closeSnipping(s);
    await A(s, () => {
      window.__aurora.shell.launch('snipping', { mode: 'region', immediate: true });
    });
    await overlayUp(s);
    assert.equal(await A(s, () => window.__aurora.wm.byApp('snipping').length), 1);
    assert.equal(await A(s, () => window.__aurora.taskbar ? [...document.querySelectorAll('#taskbar [data-app="snipping"].running, #taskbar [data-app="snipping"] .running')].length : 0), 0);
    await s.page.keyboard.press('Escape');
    await overlayGone(s);
    await waitFor(s, () => window.__aurora.wm.byApp('snipping').length === 0, null, { what: 'app closed after cancel' });
    // Full-screen mode via args captures without any overlay.
    await A(s, () => {
      window.__aurora.shell.launch('snipping', { mode: 'full', immediate: true });
    });
    await editorShown(s);
    assert.deepEqual(await S(s, (app) => [app.editor.W, app.editor.H]), [1600, 900]);
    assert.equal(await A(s, () => !!document.querySelector('.snip-overlay')), false);
    // Its toast still works after the app was closed: the snip reopens in a new window.
    await closeSnipping(s);
    // (same path as clicking the toast or its entry in the notification centre)
    await A(s, () => {
      const n = window.__aurora.notifications.list().find((x) => x.appId === 'snipping');
      window.__aurora.notifications.activate(n.id);
    });
    await editorShown(s);
    assert.deepEqual(await S(s, (app) => [app.editor.W, app.editor.H]), [1600, 900]);
  });

  await test('onRelaunch with immediate args while the editor is open', async () => {
    const prevRect = await S(s, (app) => app.win.rect());
    await A(s, () => {
      window.__aurora.shell.launch('snipping', { mode: 'window', immediate: true });
    });
    await overlayUp(s);
    assert.equal(await A(s, () => document.querySelector('.snip-overlay').dataset.mode), 'window');
    assert.equal(await S(s, (app, el) => getComputedStyle(el).visibility), 'hidden');
    // Keyboard: arrows cycle the targets, Enter captures.
    await s.page.keyboard.press('ArrowDown');
    const tg = await A(s, () => document.querySelector('.snip-overlay').__snip.state.target);
    assert.ok(tg, 'keyboard picks a target');
    await s.page.keyboard.press('Escape');
    await overlayGone(s);
    await editorShown(s);
    assert.deepEqual(await S(s, (app) => app.win.rect()), prevRect);
  });

  await test('delay: countdown pill, then the overlay', async () => {
    await S(s, (app) => app.setDelay(3));
    await chooseMode(s, 'rect');
    const t0 = Date.now();
    await newSnip(s);
    await s.page.waitForSelector('.snip-countdown');
    const pill = await A(s, () => document.querySelector('.snip-countdown').textContent);
    assert.match(pill, /Snipping in 3/);
    await s.shot('snipping-countdown-light-en');
    await overlayUp(s);
    const dt = Date.now() - t0;
    assert.ok(dt >= 2800, `overlay after the delay (${dt} ms)`);
    assert.equal(await A(s, () => !!document.querySelector('.snip-countdown')), false, 'pill gone before the capture');
    await s.page.keyboard.press('Escape');
    await editorShown(s);
    // The countdown can be cancelled with its X button.
    await newSnip(s);
    await s.page.waitForSelector('.snip-countdown .snip-cd-x');
    await s.page.click('.snip-countdown .snip-cd-x');
    await editorShown(s);
    assert.equal(await A(s, () => !!document.querySelector('.snip-countdown, .snip-overlay')), false);
    await S(s, (app) => app.setDelay(0));
  });

  await test('locking the screen during a countdown cancels the snip', async () => {
    await S(s, (app) => app.setDelay(5));
    await newSnip(s);
    await s.page.waitForSelector('.snip-countdown');
    await A(s, () => {
      window.__aurora.shell.emit('lock');
    });
    await sleep(300);
    assert.equal(await A(s, () => !!document.querySelector('.snip-countdown, .snip-overlay')), false);
    await A(s, () => {
      window.__aurora.shell.emit('unlock');
    });
    await S(s, (app) => app.setDelay(0));
    await waitFor(s, () => !document.body.classList.contains('aurora-locked') && !document.querySelector('#windows[inert]'), null, { what: 'unlocked' });
    await sleep(600);
    // The cancelled snip gives the window back.
    await editorShown(s);
  });

  await test('settings page: toggles persist, border option, back', async () => {
    await s.page.click(`${WIN} .snip-more`);
    await s.page.locator('.menu .menu-item', { hasText: 'Settings' }).click();
    await waitSnip(s, (app) => app.view === 'settings');
    const rows = await S(s, (app, el) => [...el.querySelectorAll('.snip-set-row')].map((r) => ({ key: r.dataset.key, on: r.querySelector('input').checked })));
    assert.deepEqual(rows, [
      { key: 'autoCopy', on: true },
      { key: 'autoSave', on: true },
      { key: 'askSave', on: true },
      { key: 'border', on: false },
    ]);
    await s.page.click(`${WIN} .snip-set-row[data-key="border"] .toggle`);
    assert.equal(await S(s, (app, el) => el.querySelector('.snip-set-sub').hidden), false);
    await s.page.click(`${WIN} .snip-set-sub .snip-swatch[aria-label="Red"]`);
    await s.shot('snipping-settings-light-en');
    fs.copyFileSync(path.join(here, 'out', 'snipping-settings-light-en.png'), path.join(DOCS, 'snipping-settings.png'));
    await s.page.click(`${WIN} .snip-set-row[data-key="autoSave"] .toggle`);
    await sleep(400);
    const stored = await A(s, () => window.__aurora.api.invoke('storage:get', 'snipping', 'settings', null));
    assert.equal(stored.autoSave, false);
    assert.equal(stored.border, true);
    assert.equal(stored.borderColor, '#e81224');
    await s.page.click(`${WIN} .snip-back`);
    await waitSnip(s, (app) => app.view === 'editor');
    // Border + no auto-save: a 100×60 snip becomes 104×64 with a red frame; nothing is written.
    const before = shots(home).length;
    await newSnip(s);
    await overlayUp(s);
    await drag(s, [[PROBE2.x + 40, PROBE2.y + 80], [PROBE2.x + 140, PROBE2.y + 140]]);
    await editorShown(s);
    const info = await S(s, (app) => ({ W: app.editor.W, H: app.editor.H, edge: app.editor.pixel(0, 30), inner: app.editor.pixel(50, 30), path: app.snip.savedPath }));
    assert.deepEqual([info.W, info.H], [104, 64]);
    assert.ok(near(info.edge, [232, 18, 36, 255], 3), `border colour (${info.edge})`);
    assert.ok(near(info.inner, [0, 0, 255, 255], 3));
    assert.equal(info.path, null);
    assert.equal(shots(home).length, before);
    // Restore the defaults.
    await S(s, (app) => {
      app.setSetting('border', false);
      app.setSetting('autoSave', true);
    });
  });

  await test('Edit in Paint opens the snip in Paint', async () => {
    const hasPaint = await A(s, () => !!window.__aurora.registry.get('paint'));
    if (!hasPaint) return;
    await s.page.click(`${WIN} .snip-paint`);
    await waitFor(s, () => window.__aurora.wm.byApp('paint').length > 0, null, { what: 'paint opened', timeout: 15000 });
    const p = await S(s, (app) => app.snip.savedPath);
    assert.ok(p && fs.existsSync(p), 'the edited snip was saved for Paint');
    await sleep(1500);
    const title = await A(s, () => window.__aurora.wm.byApp('paint')[0].title);
    assert.ok(title.includes(path.basename(p).replace(/\.png$/, '')), `Paint shows the file (${title})`);
    await A(s, async () => {
      for (const w of window.__aurora.wm.byApp('paint')) await w.close(true);
    });
  });

  await test('editor at minimum size moves the tools to a second row; maximized keeps one row', async () => {
    await S(s, (app) => {
      if (app.win.isMaximized()) app.win.restore();
      app.win.setRect({ x: 200, y: 100, width: 200, height: 100 });
    });
    await sleep(300);
    const small = await S(s, (app, el) => ({ rect: app.win.rect(), row: app.root.classList.contains('has-toolrow'), inRow: !!el.querySelector('.snip-toolrow .snip-tools'), overflow: [...el.querySelectorAll('.snip-tb > *')].some((c) => c.getBoundingClientRect().right > el.querySelector('.win-controls').getBoundingClientRect().left + 1) }));
    assert.deepEqual([small.rect.width, small.rect.height], [560, 400], 'clamped to the editor minimum');
    assert.equal(small.row, true);
    assert.equal(small.inRow, true);
    assert.equal(small.overflow, false, 'title bar content does not run under the caption buttons');
    await s.shot('snipping-minsize-light-en');
    await S(s, (app) => app.win.maximize());
    await sleep(400);
    const big = await S(s, (app, el) => ({ row: app.root.classList.contains('has-toolrow'), inTb: !!el.querySelector('.snip-tb .snip-tools') }));
    assert.equal(big.row, false);
    assert.equal(big.inTb, true);
    await s.shot('snipping-maximized-light-en');
    fs.copyFileSync(path.join(here, 'out', 'snipping-maximized-light-en.png'), path.join(DOCS, 'snipping-maximized.png'));
    await S(s, (app) => app.win.restore());
  });

  await test('Open file loads an image into the editor', async () => {
    const file = shots(home)[0];
    await S(s, (app, el, p) => app.openPath(p), path.join(home, 'Pictures', 'Screenshots', file));
    await sleep(300);
    const info = await S(s, (app) => ({ view: app.view, W: app.editor.W, path: app.snip.savedPath }));
    assert.equal(info.view, 'editor');
    assert.equal(info.path, path.join(home, 'Pictures', 'Screenshots', file));
    // A broken file shows an error dialog instead of failing silently.
    fs.writeFileSync(path.join(home, 'Pictures', 'broken.png'), 'not a png');
    await S(s, (app, el, p) => {
      app.openPath(p);
    }, path.join(home, 'Pictures', 'broken.png'));
    await s.page.waitForSelector('.dialog', { timeout: 4000 });
    assert.match(await A(s, () => document.querySelector('.dialog').textContent), /Couldn't open this image/);
    await s.page.locator('.dialog .btn.primary').click();
  });

  await test('About dialog and live language switch', async () => {
    await s.page.click(`${WIN} .snip-more`);
    await s.page.locator('.menu .menu-item', { hasText: 'About' }).click();
    await s.page.waitForSelector('.snip-about-dialog');
    assert.match(await A(s, () => document.querySelector('.snip-about-dialog').textContent), /About Snipping Tool.*Version/s);
    await s.page.locator('.snip-about-dialog .btn.primary').click();
    await A(s, () => window.__aurora.settings.set('lang', 'fr'));
    await waitSnip(s, (app, el) => el.querySelector('.snip-new')?.textContent === 'Nouveau', null, { what: 'French labels' });
    assert.equal(await S(s, (app, el) => el.querySelector('.snip-save').getAttribute('aria-label')), 'Enregistrer sous (Ctrl+S)');
    assert.equal(await S(s, (app) => app.editor.hasImage && app.view), 'editor', 'the snip survives the language switch');
    await A(s, () => window.__aurora.settings.set('lang', 'en'));
    await waitSnip(s, (app, el) => el.querySelector('.snip-new')?.textContent === 'New', null, { what: 'English labels' });
  });

  await test('no console errors (light / English session)', async () => {
    const errs = errorsOf(s);
    assert.deepEqual(errs, []);
  });
  await s.close();
}

// ================================================================== session 2: French, dark (+ webview composition)
{
  // A local page with a solid colour, for the <webview> composition check.
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><html><body style="margin:0;background:#00c853;height:100vh"></body></html>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const s = await launchShell({ open: [], lang: 'fr', theme: 'dark' });
  current = s;
  const home = s.home;

  await test('FR / dark: compact window strings fit', async () => {
    await s.page.mouse.click(1500, 400);
    await openSnipping(s);
    const info = await S(s, (app, el) => ({
      newText: el.querySelector('.snip-new').textContent,
      delay: el.querySelector('.snip-delay').textContent,
      hint: el.querySelector('.snip-hint').textContent,
      title: app.win.title,
      clipped: [...el.querySelectorAll('.snip-tb button, .snip-hint')].filter((e) => e.scrollWidth > e.clientWidth + 1).length,
      hintBox: el.querySelector('.snip-hint').getBoundingClientRect().bottom <= el.getBoundingClientRect().bottom,
    }));
    assert.equal(info.newText, 'Nouveau');
    assert.match(info.delay, /Aucun délai/);
    assert.match(info.hint, /Impr\. écran/);
    assert.equal(info.title, 'Outil Capture');
    assert.equal(info.clipped, 0, 'no clipped text');
    assert.ok(info.hintBox, 'hint inside the window');
    await s.shot('snipping-compact-dark-fr');
    fs.copyFileSync(path.join(here, 'out', 'snipping-compact-dark-fr.png'), path.join(DOCS, 'snipping-compact-dark-fr.png'));
  });

  await test('FR: localized file name and toast', async () => {
    await A(s, () => {
      window.__aurora.hotkeys.trigger('PrintScreen');
    });
    await overlayUp(s);
    const tips = await A(s, () => [...document.querySelectorAll('.snip-overlay .snip-bar-btn')].map((b) => b.getAttribute('aria-label')));
    assert.deepEqual(tips, ['Mode Rectangle', 'Mode Fenêtre', 'Mode Plein écran', 'Mode Forme libre', 'Fermer (Échap)']);
    await s.page.mouse.move(300, 200);
    await s.page.mouse.down();
    await s.page.mouse.move(700, 450, { steps: 6 });
    await s.shot('snipping-overlay-dark-fr');
    fs.copyFileSync(path.join(here, 'out', 'snipping-overlay-dark-fr.png'), path.join(DOCS, 'snipping-overlay-dark-fr.png'));
    await s.page.mouse.up();
    await editorShown(s);
    const files = shots(home);
    assert.equal(files.length, 1);
    assert.match(files[0], /^Capture d'écran \d{4}-\d\d-\d\d \d{6}\.png$/);
    const toast = await waitFor(s, () => [...document.querySelectorAll('#toasts .toast .toast-title')].pop()?.textContent);
    assert.equal(toast, 'Capture copiée dans le Presse-papiers');
  });

  await test('FR / dark: editor with ink, tooltips and flyout', async () => {
    await s.page.click(`${WIN} .snip-tool[data-tool="hl"]`);
    let a = await imgClient(s, 40, 60);
    await drag(s, [a, [a[0] + 260, a[1] + 10]], { steps: 12 });
    await s.page.click(`${WIN} .snip-tool[data-tool="pen"]`);
    a = await imgClient(s, 60, 150);
    const pts = [];
    for (let i = 0; i <= 30; i++) pts.push([a[0] + i * 9, a[1] + Math.sin(i / 3) * 30]);
    await drag(s, pts, { steps: 2 });
    await s.page.click(`${WIN} .snip-tool[data-tool="pen"]`);
    await s.page.waitForSelector('.snip-flyout');
    const labels = await A(s, () => [...document.querySelectorAll('.snip-flyout .snip-fl-label')].map((e) => e.textContent));
    assert.deepEqual(labels, ['Couleurs', 'Taille']);
    await s.shot('snipping-editor-dark-fr');
    fs.copyFileSync(path.join(here, 'out', 'snipping-editor-dark-fr.png'), path.join(DOCS, 'snipping-editor-dark-fr.png'));
    await s.page.keyboard.press('Escape');
    const tips = await S(s, (app, el) => ['.snip-save', '.snip-copy', '.snip-undo', '.snip-tool[data-tool="crop"]'].map((q) => el.querySelector(q).getAttribute('aria-label')));
    assert.deepEqual(tips, ['Enregistrer sous (Ctrl+S)', 'Copier (Ctrl+C)', 'Annuler (Ctrl+Z)', "Rogner l'image"]);
  });

  await test('FR / dark: settings page and min size', async () => {
    await S(s, (app) => {
      app.openSettings();
    });
    await sleep(400);
    const clipped = await S(s, (app, el) => [...el.querySelectorAll('.snip-set-title, .snip-settings .caption')].filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent));
    assert.deepEqual(clipped, []);
    await s.shot('snipping-settings-dark-fr');
    await S(s, (app) => {
      app.closeSettings();
    });
    await sleep(300);
    await S(s, (app) => app.win.setRect({ x: 100, y: 80, width: 100, height: 100 }));
    await sleep(300);
    const over = await S(s, (app, el) => [...el.querySelectorAll('.snip-tb > *:not([hidden])')].some((c) => c.getBoundingClientRect().right > el.querySelector('.win-controls').getBoundingClientRect().left + 1));
    assert.equal(over, false, 'FR title bar fits at the minimum size');
    await s.shot('snipping-minsize-dark-fr');
    fs.copyFileSync(path.join(here, 'out', 'snipping-minsize-dark-fr.png'), path.join(DOCS, 'snipping-minsize-dark-fr.png'));
  });

  await test('browser tabs (<webview>) are composited into the capture', async () => {
    const hasBrowser = await A(s, () => !!window.__aurora.registry.get('browser'));
    if (!hasBrowser) return;
    await closeSnipping(s); // (its edited snip would otherwise ask to be saved first)
    await A(s, (url) => {
      window.__aurora.shell.openUrl(url);
    }, url);
    const rect = await waitFor(
      s,
      () => {
        const w = window.__aurora.wm.byApp('browser')[0];
        const v = w && [...w.el.querySelectorAll('webview')].find((x) => x.offsetParent);
        if (!v) return null;
        const r = v.getBoundingClientRect();
        return r.width > 100 ? { x: r.left, y: r.top, w: r.width, h: r.height } : null;
      },
      null,
      { timeout: 15000, what: 'browser webview' },
    );
    await sleep(2500);
    await A(s, () => {
      window.__aurora.shell.launch('snipping', { mode: 'full', immediate: true });
    });
    await waitSnip(s, (app) => app.view === 'editor' && app.editor.W === 1600 && !app.session, null, { what: 'full snip' });
    const px = await S(s, (app, el, r) => app.editor.pixel(r.x + r.w / 2, r.y + r.h / 2), rect);
    assert.ok(near(px, [0, 200, 83, 255], 6), `webview content is in the snip (${px})`);
    await s.shot('snipping-webview-dark-fr');
  });

  await test('no console errors (dark / French session)', async () => {
    assert.deepEqual(errorsOf(s), []);
  });
  await s.close();
  server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
