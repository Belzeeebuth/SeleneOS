// Functional tests for the Paint app (renderer/apps/paint).
// Run: cd aurora-os/shell && xvfb-run -a -s "-screen 0 1600x900x24" node test/paint.test.mjs
// Drives the real shell with Playwright (mouse/keyboard), checks pixels through the app's
// test hook (win.el.__paint), saves/reopens files, and writes screenshots to test/out/ and
// docs/screenshots/paint-*.png.
import { launchShell, OUT } from './lib.mjs';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DOCS = path.join(here, '..', '..', 'docs', 'screenshots');
fs.mkdirSync(DOCS, { recursive: true });
const ONLY = process.argv.find((a) => a.startsWith('--only='))?.slice(7);

const results = [];
async function test(name, fn) {
  if (ONLY && !name.includes(ONLY)) return;
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name} (${Date.now() - t0} ms)`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`FAIL  ${name}\n      ${String(err?.stack || err).split('\n').slice(0, 4).join('\n      ')}`);
  }
}

// ------------------------------------------------------------------ helpers
const WIN = '.win.app-paint';
// Evaluate fn(p, el, arg) in the shell, where el is the (last) Paint window element and p its test hook.
// (Built as an expression string: the shell's CSP forbids eval/new Function inside the page.)
function P(s, fn, arg, sel = WIN) {
  const expr = `(() => { const el = [...document.querySelectorAll(${JSON.stringify(sel)})].pop(); return (${fn.toString()})(el.__paint, el, ${JSON.stringify(arg ?? null)}); })()`;
  return s.page.evaluate(expr);
}
const px = (s, x, y, sel) => P(s, (p, el, a) => p.pixel(a[0], a[1]), [x, y], sel);
const hash = (s, sel) => P(s, (p) => p.hash(), null, sel);
const wait = (s, ms = 120) => s.page.waitForTimeout(ms);

async function client(s, x, y, sel) {
  return P(s, (p, el, a) => p.clientPoint(a[0], a[1]), [x, y], sel);
}
async function drag(s, pts, { button = 'left', steps = 10, sel, shift = false } = {}) {
  await P(s, (p, el, a) => p.reveal(a), pts, sel);
  const cps = [];
  for (const [x, y] of pts) cps.push(await client(s, x, y, sel));
  const m = s.page.mouse;
  if (shift) await s.page.keyboard.down('Shift');
  await m.move(cps[0].x, cps[0].y);
  await m.down({ button });
  for (let i = 1; i < cps.length; i++) await m.move(cps[i].x, cps[i].y, { steps });
  await m.up({ button });
  if (shift) await s.page.keyboard.up('Shift');
  await wait(s, 60);
}
async function click(s, x, y, opts = {}) {
  await P(s, (p, el, a) => p.reveal(a), [[x, y]], opts.sel);
  const c = await client(s, x, y, opts.sel);
  await s.page.mouse.click(c.x, c.y, { button: opts.button || 'left', clickCount: opts.clickCount || 1 });
  await wait(s, 60);
}
const near = (a, b, tol = 8) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
const isWhite = (p) => near(p, [255, 255, 255, 255], 2);
async function nonWhite(s, x, y, w, h, sel) {
  return P(
    s,
    (p, el, a) => {
      const cv = el.querySelector('.pt-doc');
      const d = cv.getContext('2d').getImageData(a[0], a[1], a[2], a[3]).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] < 245 || d[i + 1] < 245 || d[i + 2] < 245) n++;
      return n;
    },
    [x, y, w, h],
    sel,
  );
}
function pngSize(file) {
  const b = fs.readFileSync(file);
  assert.equal(b.toString('latin1', 1, 4), 'PNG', 'PNG signature');
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}
async function waitFor(s, fn, arg, { timeout = 5000, sel } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await P(s, fn, arg, sel).catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timeout waiting for ${fn}`);
    await wait(s, 50);
  }
}
async function errorsOf(s) {
  return s.logs.filter((l) => l.startsWith('[pageerror]') || (l.startsWith('[error]') && !/Failed to load resource/.test(l)) || /\[warning\] \[icons\]/.test(l));
}
async function tool(s, id) {
  await s.page.click(`${WIN} .pt-tools [data-tool="${id}"]`);
  await wait(s, 40);
}
async function shape(s, id) {
  await s.page.click(`${WIN} .pt-gallery [data-shape="${id}"]`);
  await wait(s, 40);
}
async function setZoom100(s) {
  await P(s, (p) => p.setZoom(1));
  await wait(s, 80);
}
async function savePicker(s, file) {
  await s.page.waitForSelector(`${WIN} .fp-dialog`, { timeout: 5000 });
  const input = s.page.locator(`${WIN} .fp-dialog .fp-bottom input`);
  await input.fill(file);
  await s.page.click(`${WIN} .fp-dialog .dialog-footer .btn.primary`);
}
async function menu(s, top, ...labels) {
  await s.page.click(`${WIN} .pt-menu-btn:nth-child(${{ file: 1, edit: 2, view: 3 }[top]})`);
  for (const l of labels) {
    const item = s.page.locator('.menu .menu-item', { hasText: l }).last();
    await item.hover();
    await wait(s, 260);
    await item.click();
  }
  await wait(s, 120);
}

// ================================================================== main session (en, light)
const s = await launchShell({ open: ['paint'], lang: 'en', theme: 'light' });
await s.page.waitForSelector(`${WIN} .pt-doc`, { timeout: 30000 });
await wait(s, 600);
const home = s.home;
const pics = path.join(home, 'Pictures');

await test('boots with an untitled 1152×648 white canvas and the Windows 11 command bar', async () => {
  const info = await P(s, (p, el) => ({
    size: p.size,
    title: el.querySelector('.pt-doctitle').textContent,
    groups: [...el.querySelectorAll('.pt-g-label')].map((x) => x.textContent),
    shapes: el.querySelectorAll('.pt-gallery [data-shape]').length,
    swatches: [...el.querySelectorAll('.pt-palette:not(.custom) .pt-sw')].map((b) => getComputedStyle(b).backgroundColor),
    status: el.querySelector('.pt-st-item.size').textContent,
    dirty: p.dirty(),
  }));
  assert.deepEqual(info.size, { w: 1152, h: 648 });
  assert.equal(info.title, 'Untitled - Paint');
  assert.deepEqual(info.groups, ['Clipboard', 'Image', 'Tools', 'Brushes', 'Shapes', 'Size', 'Colors']);
  assert.ok(info.shapes >= 23, 'at least 23 shapes');
  assert.equal(info.swatches.length, 20);
  assert.equal(info.swatches[3], 'rgb(237, 28, 36)', 'palette red');
  assert.equal(info.status, '1152 × 648px');
  assert.equal(info.dirty, false);
  assert.ok(isWhite(await px(s, 10, 10)));
  const title = await s.aurora(() => window.__aurora.wm.list().find((w) => w.appId === 'paint').title);
  assert.equal(title, 'Untitled - Paint');
});

await test('pencil draws aliased pixels in color 1; title gets a *', async () => {
  await setZoom100(s);
  await tool(s, 'pencil');
  await drag(s, [[100, 100], [300, 100]]);
  assert.deepEqual(await px(s, 200, 100), [0, 0, 0, 255]);
  assert.ok(isWhite(await px(s, 200, 103)));
  const t = await P(s, (p, el) => el.querySelector('.pt-doctitle').textContent);
  assert.equal(t, '*Untitled - Paint');
  assert.equal((await P(s, (p) => p.history)).undo, 1);
});

await test('right-button brush stroke uses color 2 (set by right-clicking a swatch)', async () => {
  await s.page.click(`${WIN} .pt-palette .pt-sw[data-color="#ed1c24"]`, { button: 'right' });
  assert.equal(await P(s, (p) => p.S.secondary), '#ed1c24');
  await s.page.click(`${WIN} .pt-g[data-g="brushes"] .pt-b`);
  await s.page.waitForSelector(`${WIN} .pt-fly-brushes`);
  await s.page.click(`${WIN} .pt-fly-brushes .pt-brush-item:nth-child(1)`);
  assert.equal(await P(s, (p) => `${p.S.tool}/${p.S.brush}`), 'brush/brush');
  await drag(s, [[100, 160], [200, 170], [300, 160]], { button: 'right' });
  const c = await px(s, 200, 168);
  assert.ok(c[0] > 200 && c[1] < 80 && c[2] < 80, `red stroke, got ${c}`);
});

await test('rectangle shape: live preview, editable handles, commits on click outside', async () => {
  await shape(s, 'rect');
  await drag(s, [[400, 200], [600, 350]]);
  const handles = await P(s, (p, el) => el.querySelectorAll('.pt-handles .pt-h[data-kind="shape"]').length);
  assert.equal(handles, 8, 'eight resize handles while pending');
  assert.ok(isWhite(await px(s, 401, 275)), 'not committed yet');
  assert.equal(await P(s, (p) => p.pending), true);
  // drag the east handle to widen the box before committing
  const e = await P(s, (p, el) => {
    const r = el.querySelector('.pt-h[data-h="e"]').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await s.page.mouse.move(e.x, e.y);
  await s.page.mouse.down();
  await s.page.mouse.move(e.x + 50, e.y, { steps: 5 });
  await s.page.mouse.up();
  await click(s, 900, 600);
  assert.equal(await P(s, (p) => p.pending), false);
  assert.deepEqual(await px(s, 401, 275), [0, 0, 0, 255], 'left outline');
  assert.deepEqual(await px(s, 648, 275), [0, 0, 0, 255], 'right outline moved by the handle');
  assert.ok(isWhite(await px(s, 500, 275)), 'no fill');
});

await test('fill bucket floods the inside of the rectangle with color 1', async () => {
  await s.page.click(`${WIN} .pt-palette .pt-sw[data-color="#3f48cc"]`);
  assert.equal(await P(s, (p) => p.S.primary), '#3f48cc');
  await tool(s, 'fill');
  assert.equal(await P(s, (p, el) => !el.querySelector('.pt-ctxbar').hidden), true, 'tolerance bar shown');
  await click(s, 500, 275);
  assert.deepEqual(await px(s, 500, 275), [63, 72, 204, 255]);
  assert.deepEqual(await px(s, 420, 210), [63, 72, 204, 255]);
  assert.ok(isWhite(await px(s, 700, 275)), 'outside untouched');
});

await test('text tool: editable box, font options, committed to pixels on click outside', async () => {
  await P(s, (p) => p.app.setColor('primary', '#000000'));
  await tool(s, 'text');
  assert.equal(await P(s, (p, el) => !el.querySelector('.pt-ctx-row[data-for="text"]').hidden), true, 'text bar shown');
  await click(s, 100, 420);
  await s.page.waitForSelector(`${WIN} .pt-ta`);
  await s.page.keyboard.type('Hello Paint');
  await s.page.click(`${WIN} [data-opt="bold"]`);
  assert.equal(await P(s, (p) => p.S.text.bold), true);
  assert.ok((await nonWhite(s, 100, 420, 300, 40)) === 0, 'still only a preview');
  await click(s, 900, 620);
  assert.equal(await P(s, (p, el) => !!el.querySelector('.pt-ta')), false);
  const n = await nonWhite(s, 100, 420, 300, 50);
  assert.ok(n > 150, `text pixels drawn (${n})`);
  await P(s, (p) => p.app.setTextOpt('bold', false));
});

await test('eraser paints color 2 and undo/redo restore exact pixels', async () => {
  await P(s, (p) => p.app.setColor('secondary', '#ffffff'));
  const before = await hash(s);
  await tool(s, 'eraser');
  await drag(s, [[150, 100], [250, 100]]);
  assert.ok(isWhite(await px(s, 200, 100)), 'erased to white');
  assert.deepEqual(await px(s, 120, 100), [0, 0, 0, 255], 'outside the eraser path');
  const after = await hash(s);
  assert.notEqual(before, after);
  await s.page.keyboard.press('Control+z');
  await wait(s, 150);
  assert.equal(await hash(s), before, 'undo restores');
  await s.page.keyboard.press('Control+y');
  await wait(s, 150);
  assert.equal(await hash(s), after, 'redo re-applies');
  const st = await P(s, (p, el) => ({ undo: !el.querySelector('.pt-qa[aria-label="Undo"]').disabled, redo: el.querySelector('.pt-qa[aria-label="Redo"]').disabled }));
  assert.deepEqual(st, { undo: true, redo: true });
});

await test('undo history keeps at least 50 steps', async () => {
  await tool(s, 'pencil');
  const start = await hash(s);
  const before = (await P(s, (p) => p.history)).undo;
  for (let i = 0; i < 55; i++) {
    const x = 700 + (i % 11) * 30;
    const y = 400 + Math.floor(i / 11) * 30;
    await drag(s, [[x, y], [x + 20, y + 10]], { steps: 2 });
  }
  const mid = await P(s, (p) => p.history);
  assert.ok(mid.undo >= before + 55, `${mid.undo} steps recorded`);
  for (let i = 0; i < 55; i++) await P(s, (p) => p.app.cmd('undo'));
  await wait(s, 200);
  assert.equal(await hash(s), start, '55 undos restore the start');
  for (let i = 0; i < 55; i++) await P(s, (p) => p.app.cmd('redo'));
  for (let i = 0; i < 55; i++) await P(s, (p) => p.app.cmd('undo'));
  await wait(s, 200);
  assert.equal(await hash(s), start);
});

await test('every brush style leaves a distinctive stroke', async () => {
  await P(s, (p) => p.app.setColor('primary', '#22b14c'));
  const brushes = ['brush', 'calli1', 'calli2', 'airbrush', 'oil', 'crayon', 'marker', 'natural', 'watercolor'];
  const sigs = [];
  for (let i = 0; i < brushes.length; i++) {
    await P(s, (p, el, b) => {
      p.app.setBrush(b);
      p.app.setSize(12);
    }, brushes[i]);
    const y = 480 + i * 18;
    const h0 = await hash(s);
    await drag(s, [[720, y], [800, y - 6], [880, y + 4], [960, y]], { steps: 6 });
    assert.notEqual(await hash(s), h0, `${brushes[i]} drew`);
    sigs.push(await nonWhite(s, 700, y - 12, 280, 24));
  }
  assert.ok(new Set(sigs).size >= 7, `different coverage per brush: ${sigs}`);
});

await test('all shapes render, Shift constrains, outline/fill styles apply', async () => {
  const shapes = await P(s, (p, el) => [...el.querySelectorAll('.pt-gallery [data-shape]')].map((b) => b.dataset.shape));
  await P(s, (p) => {
    p.app.setColor('primary', '#000000');
    p.app.setColor('secondary', '#ffc90e');
    p.app.setFillStyle('solid');
  });
  await P(s, (p) => p.app.cmd('new'));
  await wait(s, 150);
  // the drawing above is dirty: "new" asks to save -> Don't save
  await s.page.waitForSelector(`${WIN} .pt-ask`);
  await s.page.click(`${WIN} .pt-ask .dialog-footer .btn:nth-child(2)`);
  await wait(s, 250);
  assert.equal(await P(s, (p) => p.dirty()), false);
  for (let i = 0; i < shapes.length; i++) {
    if (shapes[i] === 'polygon') continue;
    await shape(s, shapes[i]);
    const x = 40 + (i % 8) * 130;
    const y = 40 + Math.floor(i / 8) * 150;
    await drag(s, [[x, y], [x + 100, y + 110]], { steps: 4 });
    await P(s, (p) => p.commitPending());
    const n = await nonWhite(s, x - 4, y - 4, 110, 120);
    assert.ok(n > 60, `${shapes[i]} drew ${n} px`);
  }
  // polygon: click points, double-click to close
  await shape(s, 'polygon');
  await drag(s, [[900, 360], [1000, 380]]);
  await click(s, 1060, 470);
  await click(s, 930, 480, { clickCount: 2 });
  await P(s, (p) => p.commitPending());
  assert.ok((await nonWhite(s, 890, 350, 180, 140)) > 200, 'polygon drawn');
  // Shift: ellipse becomes a circle
  await shape(s, 'ellipse');
  await drag(s, [[60, 500], [200, 560]], { shift: true });
  const sel = await P(s, (p, el) => el.querySelector('.pt-st-item.sel').textContent);
  assert.equal(sel, '140 × 140px', 'constrained to a circle');
  await P(s, (p) => p.commitPending());
  // outline/fill styles through the menus
  await s.page.click(`${WIN} .pt-g[data-g="shapes"] .pt-col .pt-b:nth-child(1)`);
  await s.page.locator('.menu .menu-item', { hasText: 'Crayon' }).click();
  assert.equal(await P(s, (p) => p.S.outline), 'crayon');
  await s.page.click(`${WIN} .pt-g[data-g="shapes"] .pt-col .pt-b:nth-child(2)`);
  await s.page.locator('.menu .menu-item', { hasText: 'Watercolor' }).click();
  assert.equal(await P(s, (p) => p.S.fill), 'watercolor');
  await shape(s, 'heart');
  await drag(s, [[300, 480], [420, 600]]);
  await P(s, (p) => p.commitPending());
  assert.ok((await nonWhite(s, 290, 470, 140, 140)) > 400);
  await P(s, (p) => {
    p.app.setOutline('solid');
    p.app.setFillStyle('none');
  });
});

await test('color picker sets color 1 and returns to the previous tool', async () => {
  await tool(s, 'pencil');
  await tool(s, 'picker');
  const c = await px(s, 100, 100);
  await click(s, 100, 100);
  const hex = await P(s, (p) => p.S.primary);
  assert.equal(hex, `#${c.slice(0, 3).map((v) => v.toString(16).padStart(2, '0')).join('')}`);
  assert.equal(await P(s, (p) => p.S.tool), 'pencil');
});

await test('rectangle selection: move with the mouse, Delete, undo', async () => {
  await P(s, (p) => p.app.cmd('new'));
  await s.page.waitForSelector(`${WIN} .pt-ask`);
  await s.page.click(`${WIN} .pt-ask .dialog-footer .btn:nth-child(2)`);
  await wait(s, 250);
  await P(s, (p) => p.app.setColor('primary', '#ed1c24'));
  await shape(s, 'rect');
  await P(s, (p) => p.app.setFillStyle('solid'));
  await P(s, (p) => p.app.setColor('secondary', '#ed1c24'));
  await drag(s, [[100, 100], [200, 200]]);
  await P(s, (p) => {
    p.commitPending();
    p.app.setColor('secondary', '#ffffff');
    p.app.setFillStyle('none');
  });
  const h0 = await hash(s);
  await s.page.click(`${WIN} .pt-split .pt-split-main[aria-label="Select"]`);
  await drag(s, [[90, 90], [210, 210]]);
  assert.deepEqual(await P(s, (p) => p.sel), { x: 90, y: 90, w: 120, h: 120, floating: false });
  assert.equal(await P(s, (p, el) => el.querySelector('.pt-st-item.sel').textContent), '120 × 120px');
  await drag(s, [[150, 150], [450, 250]]);
  assert.equal((await P(s, (p) => p.sel)).floating, true);
  assert.ok(isWhite(await px(s, 150, 150)), 'hole filled with color 2');
  await s.page.keyboard.press('Escape');
  await wait(s, 80);
  assert.deepEqual(await px(s, 450, 250), [237, 28, 36, 255], 'moved content committed');
  await s.page.keyboard.press('Control+z');
  await wait(s, 150);
  assert.equal(await hash(s), h0, 'one undo restores the move');
  // Ctrl+A + Delete clears to color 2, undo brings it back
  await s.page.keyboard.press('Control+a');
  await s.page.keyboard.press('Delete');
  await wait(s, 80);
  assert.ok(isWhite(await px(s, 150, 150)));
  await s.page.keyboard.press('Control+z');
  await wait(s, 150);
  assert.equal(await hash(s), h0);
});

await test('free-form selection, invert, crop to selection', async () => {
  await P(s, (p) => p.app.setSelMode('free'));
  await drag(s, [[80, 80], [240, 80], [240, 240], [80, 240], [80, 82]], { steps: 6 });
  const sel = await P(s, (p) => p.sel);
  assert.ok(sel && sel.w > 150 && sel.h > 150, 'lasso selection');
  await P(s, (p) => p.app.cmd('invertSel'));
  assert.deepEqual(await P(s, (p) => p.sel), { x: 0, y: 0, w: 1152, h: 648, floating: false });
  await P(s, (p) => p.app.cmd('undo')); // drop selection
  await P(s, (p) => p.app.setSelMode('rect'));
  const h0 = await hash(s);
  await drag(s, [[100, 100], [200, 160]]);
  await s.page.keyboard.press('Control+Shift+X');
  await wait(s, 120);
  assert.deepEqual(await P(s, (p) => p.size), { w: 100, h: 60 });
  assert.deepEqual(await px(s, 50, 30), [237, 28, 36, 255]);
  await s.page.keyboard.press('Control+z');
  await wait(s, 150);
  assert.equal(await hash(s), h0, 'crop undone');
});

let savedPng = '';
let savedHash = '';
await test('Save as PNG through the File menu, then reopen from args with identical pixels', async () => {
  savedPng = path.join(pics, 'paint-test.png');
  await menu(s, 'file', 'Save as', 'PNG picture');
  await savePicker(s, savedPng);
  await waitFor(s, (p) => !p.dirty());
  assert.ok(fs.existsSync(savedPng), 'file written');
  assert.deepEqual(pngSize(savedPng), { w: 1152, h: 648 });
  savedHash = await hash(s);
  const t = await P(s, (p, el) => el.querySelector('.pt-doctitle').textContent);
  assert.equal(t, 'paint-test.png - Paint');
  const status = await P(s, (p, el) => el.querySelector('.pt-st-item.file').textContent);
  assert.match(status, /^Size: \d/);
  // open from args in a second window
  await s.aurora((f) => window.__aurora.registry.launch('paint', { file: f }), savedPng);
  await s.page.waitForFunction(() => document.querySelectorAll('.win.app-paint').length === 2);
  const second = '.win.app-paint:last-of-type';
  await waitFor(s, (p) => p.file.path, null, { sel: second });
  assert.equal(await hash(s, second), savedHash, 'pixel-identical after reopen');
  assert.equal(await P(s, (p) => p.dirty(), null, second), false);
  await P(s, (p, el) => window.__aurora.wm.get(el.dataset.id).close(), null, second);
  await s.page.waitForFunction(() => document.querySelectorAll('.win.app-paint').length === 1);
});

await test('Ctrl+S saves in place; JPEG, BMP, GIF and WebP round-trip with the right size', async () => {
  await tool(s, 'pencil');
  await drag(s, [[600, 500], [700, 520]]);
  await s.page.keyboard.press('Control+s');
  await waitFor(s, (p) => !p.dirty());
  assert.equal(fs.statSync(savedPng).size > 100, true);
  savedHash = await hash(s);
  for (const [fmt, ext, magic] of [
    ['jpeg', 'jpg', 'ffd8ff'],
    ['bmp', 'bmp', '424d'],
    ['gif', 'gif', '474946383961'],
    ['webp', 'webp', '52494646'],
  ]) {
    const f = path.join(pics, `paint-test.${ext}`);
    const ok = await P(s, (p, el, a) => p.writeFile(a[0], a[1]), [f, fmt]);
    assert.equal(ok, true, `${fmt} saved`);
    const head = fs.readFileSync(f).subarray(0, magic.length / 2).toString('hex');
    assert.equal(head, magic, `${fmt} signature`);
    await P(s, (p, el, a) => p.openPath(a), f);
    assert.deepEqual(await P(s, (p) => p.size), { w: 1152, h: 648 }, `${fmt} size`);
    if (fmt === 'bmp') assert.equal(await hash(s), savedHash, 'BMP is lossless');
    if (fmt === 'jpeg') {
      const c = await px(s, 150, 150);
      assert.ok(near(c, [237, 28, 36, 255], 12), `JPEG keeps colours (${c})`);
    }
  }
  // JPEG through the menu
  await P(s, (p, el, a) => p.openPath(a), savedPng);
  const jpg = path.join(pics, 'menu-save.jpg');
  await menu(s, 'file', 'Save as', 'JPEG picture');
  await savePicker(s, jpg);
  await waitFor(s, (p) => p.file.format === 'jpeg');
  assert.equal(fs.readFileSync(jpg).subarray(0, 3).toString('hex'), 'ffd8ff');
});

await test('clipboard: copy all, new image, paste gives identical pixels', async () => {
  await P(s, (p, el, a) => p.openPath(a), savedPng);
  const h0 = await hash(s);
  await s.page.click(`${WIN} .pt-scroll`, { position: { x: 5, y: 5 } });
  await s.page.keyboard.press('Control+a');
  await s.page.keyboard.press('Control+c');
  await wait(s, 300);
  const img = await s.app.evaluate(({ clipboard }) => clipboard.readImage().getSize());
  assert.deepEqual(img, { width: 1152, height: 648 }, 'system clipboard holds the picture');
  await P(s, (p) => p.app.cmd('new'));
  await waitFor(s, (p) => !p.file.path);
  assert.notEqual(await hash(s), h0);
  await s.page.keyboard.press('Control+v');
  await waitFor(s, (p) => p.sel && p.sel.floating);
  assert.equal(await P(s, (p) => p.S.tool), 'select');
  await s.page.keyboard.press('Enter');
  await s.page.keyboard.press('Escape');
  await wait(s, 100);
  assert.equal(await hash(s), h0, 'pasted pixels identical');
  // cut part of it and paste back
  await drag(s, [[90, 90], [210, 210]]);
  await s.page.keyboard.press('Control+x');
  await wait(s, 250);
  assert.ok(isWhite(await px(s, 150, 150)), 'cut clears to color 2');
  await s.page.keyboard.press('Control+v');
  await waitFor(s, (p) => p.sel && p.sel.floating);
  assert.equal((await P(s, (p) => p.sel)).w, 120);
});

await test('resize & skew dialog, rotate and flip transform pixels correctly', async () => {
  await P(s, (p, el, a) => p.openPath(a), savedPng);
  const red = [237, 28, 36, 255];
  assert.deepEqual(await px(s, 110, 105), red);
  await s.page.keyboard.press('Control+w');
  await s.page.waitForSelector(`${WIN} .pt-resize-dlg`);
  await s.page.locator(`${WIN} .pt-resize-dlg input[type=number]`).first().fill('50');
  await s.page.locator(`${WIN} .pt-resize-dlg input[type=number]`).first().dispatchEvent('input');
  assert.equal(await s.page.locator(`${WIN} .pt-resize-dlg input[type=number]`).nth(1).inputValue(), '50', 'aspect ratio kept');
  await s.page.click(`${WIN} .dialog-footer .btn.primary`);
  await wait(s, 200);
  assert.deepEqual(await P(s, (p) => p.size), { w: 576, h: 324 });
  await s.page.keyboard.press('Control+z');
  await wait(s, 150);
  assert.deepEqual(await P(s, (p) => p.size), { w: 1152, h: 648 });
  // rotate right 90°: (x, y) -> (H - 1 - y, x)
  await s.page.click(`${WIN} .pt-b[aria-label="Rotate"]`);
  await s.page.locator('.menu .menu-item', { hasText: 'Rotate right 90°' }).click();
  await wait(s, 150);
  assert.deepEqual(await P(s, (p) => p.size), { w: 648, h: 1152 });
  assert.deepEqual(await px(s, 648 - 1 - 105, 110), red);
  await P(s, (p) => p.app.cmd('rotL'));
  assert.deepEqual(await P(s, (p) => p.size), { w: 1152, h: 648 });
  assert.deepEqual(await px(s, 110, 105), red);
  // flip horizontal: (x, y) -> (W - 1 - x, y)
  await s.page.click(`${WIN} .pt-b[aria-label="Flip"]`);
  await s.page.locator('.menu .menu-item', { hasText: 'Flip horizontal' }).click();
  await wait(s, 150);
  assert.deepEqual(await px(s, 1152 - 1 - 110, 105), red);
  assert.ok(isWhite(await px(s, 110, 105)));
  await P(s, (p) => p.app.cmd('flipV'));
  assert.deepEqual(await px(s, 1152 - 1 - 110, 648 - 1 - 105), red);
  await P(s, (p) => p.app.cmd('rot180'));
  assert.deepEqual(await px(s, 110, 105), red, '180° after both flips = identity');
});

await test('image properties and canvas resize grip change the canvas size (undoable)', async () => {
  await s.page.keyboard.press('Control+e');
  await s.page.waitForSelector(`${WIN} .pt-props-dlg`);
  await s.page.locator(`${WIN} .pt-props-dlg input[type=number]`).first().fill('800');
  await s.page.locator(`${WIN} .pt-props-dlg input[type=number]`).first().dispatchEvent('input');
  await s.page.click(`${WIN} .pt-anchor [data-a="c"]`);
  await s.page.click(`${WIN} .dialog-footer .btn.primary`);
  await wait(s, 150);
  assert.deepEqual(await P(s, (p) => p.size), { w: 800, h: 648 });
  await P(s, (p) => p.app.cmd('undo'));
  const g = await P(s, (p, el) => {
    const r = el.querySelector('.pt-cvh-se').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, z: p.zoom() };
  });
  await s.page.mouse.move(g.x, g.y);
  await s.page.mouse.down();
  await s.page.mouse.move(g.x + 40, g.y + 30, { steps: 5 });
  assert.equal(await P(s, (p, el) => !!el.querySelector('.pt-dash-b').getAttribute('d')), true, 'ghost outline');
  await s.page.mouse.up();
  await wait(s, 120);
  const sz = await P(s, (p) => p.size);
  assert.ok(sz.w > 1152 && sz.h > 648, `grown to ${sz.w}×${sz.h}`);
  assert.ok(isWhite(await px(s, sz.w - 2, sz.h - 2)), 'new area filled with color 2');
});

await test('zoom: Ctrl+wheel, Ctrl+plus/minus, slider, fit to window, magnifier', async () => {
  await setZoom100(s);
  await s.page.keyboard.press('Control+Equal');
  assert.equal(await P(s, (p) => p.zoom()), 1.5);
  await s.page.keyboard.press('Control+Minus');
  assert.equal(await P(s, (p) => p.zoom()), 1);
  const c = await client(s, 300, 300);
  await s.page.mouse.move(c.x, c.y);
  await s.page.keyboard.down('Control');
  await s.page.mouse.wheel(0, -300);
  await s.page.keyboard.up('Control');
  await wait(s, 150);
  const z = await P(s, (p) => p.zoom());
  assert.ok(z > 1.2, `wheel zoomed in (${z})`);
  const c2 = await client(s, 300, 300);
  assert.ok(Math.abs(c2.x - c.x) < 3 && Math.abs(c2.y - c.y) < 3, 'zoom anchored at the cursor');
  await s.page.click(`${WIN} .pt-status .pt-b[aria-label="Fit to window"]`);
  const fit = await P(s, (p) => p.zoom());
  assert.ok(fit < 1, `fit (${fit})`);
  assert.equal(await P(s, (p, el) => el.querySelector('.pt-zoom-txt').textContent), `${Math.round(fit * 1000) / 10}%`);
  await tool(s, 'zoom');
  await click(s, 500, 300);
  assert.ok((await P(s, (p) => p.zoom())) > fit, 'magnifier zooms in');
  await click(s, 500, 300, { button: 'right' });
  assert.ok(Math.abs((await P(s, (p) => p.zoom())) - fit) < 0.3, 'right click zooms out');
  await setZoom100(s);
});

await test('Edit colors dialog (HSV + hex) sets color 1 and fills a custom slot', async () => {
  await s.page.click(`${WIN} .pt-edit-colors`);
  await s.page.waitForSelector(`${WIN} .pt-colors-dlg`);
  const hex = s.page.locator(`${WIN} .pt-hex`);
  await hex.fill('#12AB34');
  await hex.dispatchEvent('input');
  assert.equal(await s.page.locator(`${WIN} .pt-colors-dlg input[type=number]`).nth(1).inputValue(), '171', 'green channel');
  // drag in the saturation/value square changes the colour
  const r = await s.page.locator(`${WIN} .pt-sv`).boundingBox();
  await s.page.mouse.click(r.x + r.width * 0.99, r.y + 2);
  const after = await hex.inputValue();
  assert.notEqual(after, '#12AB34');
  await hex.fill('#12AB34');
  await hex.dispatchEvent('input');
  await s.page.click(`${WIN} .dialog-footer .btn.primary`);
  await wait(s, 150);
  assert.equal(await P(s, (p) => p.S.primary), '#12ab34');
  assert.equal(await P(s, (p, el) => el.querySelector('.pt-palette.custom .pt-sw').dataset.color), '#12ab34');
});

await test('keyboard shortcuts select tools; tooltips show them', async () => {
  await s.page.click(`${WIN} .pt-scroll`, { position: { x: 4, y: 4 } });
  for (const [k, id] of [['b', 'brush'], ['e', 'eraser'], ['f', 'fill'], ['t', 'text'], ['s', 'select'], ['i', 'picker'], ['p', 'pencil']]) {
    await s.page.keyboard.press(k);
    assert.equal(await P(s, (p) => p.S.tool), id, `key ${k}`);
  }
  const tip = await P(s, (p, el) => el.querySelector('[data-tool="pencil"]').dataset.tip);
  assert.equal(tip, 'Pencil (P)');
});

await test('drag & drop of an image file opens it', async () => {
  const dropped = await P(s, async (p, el) => {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 48;
    const g = c.getContext('2d');
    g.fillStyle = '#ff7f27';
    g.fillRect(0, 0, 64, 48);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'dropped.png', { type: 'image/png' }));
    const main = el.querySelector('.pt-main');
    main.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }));
    const over = main.classList.contains('dropping');
    main.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    return over;
  });
  assert.equal(dropped, true, 'drop highlight');
  const ask = await s.page.waitForSelector(`${WIN} .pt-ask`, { timeout: 1500 }).catch(() => null);
  if (ask) await s.page.click(`${WIN} .pt-ask .dialog-footer .btn:nth-child(2)`);
  await waitFor(s, (p) => p.size.w === 64);
  assert.deepEqual(await px(s, 10, 10), [255, 127, 39, 255]);
  assert.equal(await P(s, (p) => p.file.name), 'dropped.png');
});

await test('closing with unsaved changes asks Save / Don\'t save / Cancel', async () => {
  await tool(s, 'pencil');
  await drag(s, [[5, 5], [40, 30]]);
  assert.equal(await P(s, (p) => p.dirty()), true);
  await s.page.click(`${WIN} .win-close`);
  await s.page.waitForSelector(`${WIN} .pt-ask`);
  const btns = await s.page.locator(`${WIN} .pt-ask .dialog-footer .btn`).allTextContents();
  assert.deepEqual(btns, ['Save', "Don't save", 'Cancel']);
  await s.page.click(`${WIN} .pt-ask .dialog-footer .btn:nth-child(3)`);
  await wait(s, 250);
  assert.equal(await s.page.locator(WIN).count(), 1, 'cancel keeps the window');
  await s.page.click(`${WIN} .win-close`);
  await s.page.waitForSelector(`${WIN} .pt-ask`);
  await s.page.click(`${WIN} .pt-ask .dialog-footer .btn:nth-child(2)`);
  await s.page.waitForFunction(() => !document.querySelector('.win.app-paint'), null, { timeout: 3000 });
});

await test('demo drawing + screenshots (light, en)', async () => {
  await s.aurora(() => window.__aurora.registry.launch('paint'));
  await s.page.waitForSelector(`${WIN} .pt-doc`);
  await wait(s, 500);
  await P(s, (p, el) => window.__aurora.wm.get(el.dataset.id).maximize());
  await wait(s, 500);
  await demo(s);
  await wait(s, 300);
  await s.shot('paint-light-en');
  fs.copyFileSync(path.join(OUT, 'paint-light-en.png'), path.join(DOCS, 'paint-light.png'));
  // brushes flyout
  await s.page.click(`${WIN} .pt-g[data-g="brushes"] .pt-b`);
  await s.page.waitForSelector(`${WIN} .pt-fly-brushes`);
  await wait(s, 400);
  await s.shot('paint-brushes');
  fs.copyFileSync(path.join(OUT, 'paint-brushes.png'), path.join(DOCS, 'paint-brushes.png'));
  await s.page.keyboard.press('Escape');
  await wait(s, 200);
});

await test('small (minimum size) and maximized windows keep the command bar usable', async () => {
  const id = await P(s, (p, el) => el.dataset.id);
  await s.aurora((wid) => {
    const w = window.__aurora.wm.get(wid);
    w.setRect({ width: 560, height: 420 });
  }, id);
  await wait(s, 400);
  const st = await P(s, (p, el) => {
    const bar = el.querySelector('.pt-cmdbar');
    return { overflow: bar.scrollWidth - bar.clientWidth, compact: [...el.querySelectorAll('.pt-g.compact')].map((g) => g.dataset.g), w: el.getBoundingClientRect().width };
  });
  assert.ok(st.overflow <= 1, `no clipped commands (${st.overflow})`);
  assert.ok(st.compact.length >= 3, `groups collapsed: ${st.compact}`);
  await s.shot('paint-min');
  // compact group opens as a flyout with the full group
  await s.page.click(`${WIN} .pt-g.compact[data-g="${st.compact[0]}"] .pt-g-compact`);
  await s.page.waitForSelector(`${WIN} .pt-fly-group`);
  await s.page.keyboard.press('Escape');
  await wait(s, 200);
  await s.aurora((wid) => window.__aurora.wm.get(wid).maximize(), id);
  await wait(s, 500);
  const max = await P(s, (p, el) => ({ compact: el.querySelectorAll('.pt-g.compact').length, overflow: el.querySelector('.pt-cmdbar').scrollWidth - el.querySelector('.pt-cmdbar').clientWidth }));
  assert.equal(max.compact, 0, 'everything expanded when maximized');
  assert.ok(max.overflow <= 1);
  await s.shot('paint-max');
});

await test('no renderer errors in the English/light session', async () => {
  const errs = await errorsOf(s);
  assert.deepEqual(errs, []);
});
await s.close();

// ================================================================== French + dark
const f = await launchShell({ open: ['paint'], lang: 'fr', theme: 'dark' });
await f.page.waitForSelector(`${WIN} .pt-doc`, { timeout: 30000 });
await wait(f, 600);
await test('French UI strings and dark theme', async () => {
  const info = await P(f, (p, el) => ({
    title: el.querySelector('.pt-doctitle').textContent,
    groups: [...el.querySelectorAll('.pt-g-label')].map((x) => x.textContent),
    menus: [...el.querySelectorAll('.pt-menu-btn')].map((x) => x.textContent),
    tip: el.querySelector('[data-tool="fill"]').dataset.tip,
    ws: getComputedStyle(el.querySelector('.pt-main')).backgroundColor,
    text: getComputedStyle(el).color,
  }));
  assert.equal(info.title, 'Sans titre - Paint');
  assert.deepEqual(info.groups, ['Presse-papiers', 'Image', 'Outils', 'Pinceaux', 'Formes', 'Taille', 'Couleurs']);
  assert.deepEqual(info.menus, ['Fichier', 'Modifier', 'Affichage']);
  assert.equal(info.tip, 'Remplissage (F)');
  assert.equal(info.ws, 'rgb(27, 27, 27)', 'dark workspace');
  assert.equal(info.text, 'rgb(255, 255, 255)');
});
await test('demo drawing + screenshots (dark, fr) and dialogs in French', async () => {
  await P(f, (p, el) => window.__aurora.wm.get(el.dataset.id).maximize());
  await wait(f, 500);
  await demo(f);
  await wait(f, 300);
  await f.shot('paint-dark-fr');
  fs.copyFileSync(path.join(OUT, 'paint-dark-fr.png'), path.join(DOCS, 'paint-dark-fr.png'));
  await f.page.click(`${WIN} .pt-edit-colors`);
  await f.page.waitForSelector(`${WIN} .pt-colors-dlg`);
  await wait(f, 400);
  assert.equal(await f.page.locator(`${WIN} .dialog-title`).textContent(), 'Modifier les couleurs');
  await f.shot('paint-colors-fr');
  fs.copyFileSync(path.join(OUT, 'paint-colors-fr.png'), path.join(DOCS, 'paint-edit-colors.png'));
  await f.page.keyboard.press('Escape');
  await wait(f, 200);
  await f.page.click(`${WIN} .pt-menu-btn:nth-child(1)`);
  await wait(f, 350);
  const items = await f.page.locator('.menu .menu-item .label').allTextContents();
  assert.ok(items.includes('Enregistrer sous') && items.includes("Propriétés de l'image"), items.join('|'));
  await f.shot('paint-file-menu-fr');
  await f.page.keyboard.press('Escape');
  // text tool bar in French + dark
  await tool(f, 'text');
  await wait(f, 300);
  await f.shot('paint-text-fr');
  const errs = await errorsOf(f);
  assert.deepEqual(errs, []);
});
await f.close();

// ------------------------------------------------------------------ demo drawing
async function demo(sx) {
  const set = (fn, a) => P(sx, fn, a);
  await set((p) => p.app.cmd('zoomFit'));
  await wait(sx, 150);
  // sky: fill with light blue, ground: crayon green strokes
  await set((p) => p.app.setColor('primary', '#99d9ea'));
  await tool(sx, 'fill');
  await click(sx, 600, 100);
  await set((p) => {
    p.app.setColor('primary', '#22b14c');
    p.app.setColor('secondary', '#b5e61d');
  });
  await shape(sx, 'rect');
  await set((p) => {
    p.app.setFillStyle('solid');
    p.app.setOutline('none');
  });
  await drag(sx, [[-5, 470], [1160, 660]]);
  await set((p) => p.commitPending());
  // hills
  await set((p) => {
    p.app.setColor('secondary', '#7ec850');
    p.app.setOutline('none');
  });
  await shape(sx, 'ellipse');
  await drag(sx, [[-120, 400], [520, 620]]);
  await set((p) => p.commitPending());
  await set((p) => p.app.setColor('secondary', '#5fb33c'));
  await drag(sx, [[600, 420], [1300, 640]]);
  await set((p) => p.commitPending());
  // sun with watercolor rays
  await set((p) => {
    p.app.setColor('secondary', '#ffc90e');
    p.app.setColor('primary', '#ff7f27');
    p.app.setOutline('solid');
    p.app.setSize(4);
  });
  await shape(sx, 'ellipse');
  await drag(sx, [[930, 50], [1060, 180]]);
  await set((p) => p.commitPending());
  await set((p) => {
    p.app.setBrush('watercolor');
    p.app.setSize(18);
    p.app.setColor('primary', '#fff200');
  });
  for (const [x0, y0, x1, y1] of [[995, 30, 995, -10], [1085, 115, 1135, 115], [905, 115, 860, 115], [1060, 50, 1095, 15], [930, 50, 895, 15], [1060, 180, 1095, 215], [930, 180, 895, 215]]) await drag(sx, [[x0, y0], [x1, y1]], { steps: 6 });
  // house: rectangle + triangle roof + door + window
  await set((p) => {
    p.app.setColor('primary', '#3f2a1e');
    p.app.setColor('secondary', '#efe4b0');
    p.app.setFillStyle('solid');
    p.app.setOutline('solid');
    p.app.setSize(3);
  });
  await shape(sx, 'rect');
  await drag(sx, [[160, 300], [400, 480]]);
  await set((p) => p.commitPending());
  await set((p) => p.app.setColor('secondary', '#c0392b'));
  await shape(sx, 'triangle');
  await drag(sx, [[130, 170], [430, 302]]);
  await set((p) => p.commitPending());
  await set((p) => p.app.setColor('secondary', '#b97a57'));
  await shape(sx, 'roundrect');
  await drag(sx, [[250, 380], [310, 480]]);
  await set((p) => p.commitPending());
  await set((p) => p.app.setColor('secondary', '#99d9ea'));
  await shape(sx, 'rect');
  await drag(sx, [[185, 330], [235, 375]]);
  await drag(sx, [[330, 330], [380, 375]]);
  await set((p) => p.commitPending());
  // tree: oil-brush trunk + cloud-shaped crown with crayon texture
  await set((p) => {
    p.app.setBrush('oil');
    p.app.setSize(22);
    p.app.setColor('primary', '#7a4a26');
  });
  await drag(sx, [[560, 470], [562, 400], [560, 330]], { steps: 8 });
  await set((p) => {
    p.app.setColor('primary', '#1e7a35');
    p.app.setColor('secondary', '#34a853');
    p.app.setFillStyle('crayon');
    p.app.setOutline('solid');
    p.app.setSize(3);
  });
  await shape(sx, 'calloutCloud');
  await drag(sx, [[470, 200], [660, 380]]);
  await set((p) => p.commitPending());
  // clouds
  await set((p) => {
    p.app.setColor('primary', '#ffffff');
    p.app.setColor('secondary', '#ffffff');
    p.app.setFillStyle('solid');
    p.app.setOutline('none');
  });
  await shape(sx, 'ellipse');
  for (const [x, y, w, h] of [[640, 70, 120, 50], [700, 50, 110, 60], [760, 75, 100, 45], [150, 60, 110, 44], [210, 45, 100, 54]]) {
    await drag(sx, [[x, y], [x + w, y + h]]);
    await set((p) => p.commitPending());
  }
  // flowers: hearts and stars
  await set((p) => {
    p.app.setColor('primary', '#a349a4');
    p.app.setColor('secondary', '#ffaec9');
    p.app.setOutline('solid');
    p.app.setSize(2);
  });
  await shape(sx, 'heart');
  for (const x of [720, 820, 920]) {
    await drag(sx, [[x, 540], [x + 40, 580]]);
    await set((p) => p.commitPending());
  }
  await set((p) => p.app.setColor('secondary', '#fff200'));
  await shape(sx, 'star5');
  for (const x of [770, 870, 1010]) {
    await drag(sx, [[x, 590], [x + 34, 624]]);
    await set((p) => p.commitPending());
  }
  // grass blades with the calligraphy brush, a marker path
  await set((p) => {
    p.app.setBrush('calli1');
    p.app.setSize(6);
    p.app.setColor('primary', '#0f6b2a');
  });
  for (let i = 0; i < 14; i++) {
    const x = 30 + i * 46;
    await drag(sx, [[x, 640], [x + 6, 612], [x + 14, 598]], { steps: 3 });
  }
  await set((p) => {
    p.app.setBrush('marker');
    p.app.setSize(26);
    p.app.setColor('primary', '#c3c3c3');
  });
  await drag(sx, [[280, 486], [300, 540], [360, 600], [460, 650]], { steps: 8 });
  // title text
  await set((p) => {
    p.app.setColor('primary', '#1f2a44');
    p.app.setTextOpt('sizePt', 30);
    p.app.setTextOpt('bold', true);
    p.app.setTextOpt('family', 'Inter');
  });
  await tool(sx, 'text');
  await click(sx, 40, 16);
  await sx.page.waitForSelector(`${WIN} .pt-ta`);
  await sx.page.keyboard.type('Hello, Aurora!');
  await click(sx, 600, 640);
  await set((p) => {
    p.app.setTextOpt('bold', false);
    p.app.setTextOpt('sizePt', 24);
  });
  // leave a pending, editable shape so handles show in the screenshot
  await set((p) => {
    p.app.setColor('primary', '#ed1c24');
    p.app.setColor('secondary', '#ffc90e');
    p.app.setFillStyle('solid');
    p.app.setSize(3);
  });
  await shape(sx, 'lightning');
  await drag(sx, [[1040, 300], [1110, 420]]);
}

// ------------------------------------------------------------------ summary
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} tests passed`);
if (failed.length) {
  for (const r of failed) console.log(`  FAILED: ${r.name}`);
  process.exit(1);
}
