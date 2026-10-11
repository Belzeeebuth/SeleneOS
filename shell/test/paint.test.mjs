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
import zlib from 'node:zlib';
import os from 'node:os';

const here = path.dirname(fileURLToPath(import.meta.url));
const DOCS = path.join(here, '..', '..', 'docs', 'screenshots');
fs.mkdirSync(DOCS, { recursive: true });
const ONLY = process.argv.find((a) => a.startsWith('--only='))?.slice(7);

const results = [];
let current = null; // session used for cleanup after a failure
async function test(name, fn) {
  if (ONLY && !name.includes(ONLY)) return;
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name} (${Date.now() - t0} ms)`);
  } catch (err) {
    results.push({ name, ok: false, err });
    const where = String(err?.stack || '').split('\n').find((l) => l.includes('paint.test.mjs')) || '';
    if (current) {
      // Don't let one failure cascade: dismiss dialogs, menus and flyouts left open.
      await current.page.keyboard.press('Escape').catch(() => {});
      await current.page
        .evaluate(() => {
          document.querySelectorAll('.dialog-layer, .menu, .pt-flyout').forEach((e) => e.remove());
          [...document.querySelectorAll('.win.app-paint .pt-scroll')].pop()?.focus();
        })
        .catch(() => {});
    }
    console.log(`FAIL  ${name}\n      ${String(err?.message || err).split('\n').slice(0, 24).join('\n      ')}\n      ${where.trim()}`);
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
  // (a picker that was just accepted may still be fading out: only use the live one)
  const live = `${WIN} .dialog-layer:not(.closing) .fp-dialog`;
  await s.page.waitForSelector(live, { timeout: 5000 });
  const input = s.page.locator(`${live} .fp-bottom input`);
  await input.fill(file);
  await s.page.click(`${live} .dialog-footer .btn.primary`);
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

// Minimal PNG / ICO writers (solid colour) for files the tests need on disk.
const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function makePng(w, h, rgba = [255, 0, 0, 255]) {
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const row = Buffer.alloc(w * 4 + 1);
  for (let x = 0; x < w; x++) row.set(rgba, 1 + x * 4);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function makeIco(w, h, rgba) {
  const png = makePng(w, h, rgba);
  const head = Buffer.alloc(22);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(1, 4);
  head[6] = w;
  head[7] = h;
  head.writeUInt16LE(1, 10);
  head.writeUInt16LE(32, 12);
  head.writeUInt32LE(png.length, 14);
  head.writeUInt32LE(22, 18);
  return Buffer.concat([head, png]);
}
// Text of the dialogs currently open in the Paint window(s).
const dialogTexts = (s) => s.page.evaluate(() => [...document.querySelectorAll('.win.app-paint .dialog-layer:not(.closing) .dialog')].map((d) => d.innerText.replace(/\s+/g, ' ').trim()));
async function waitDialog(s, timeout = 4000) {
  const t0 = Date.now();
  for (;;) {
    const d = await dialogTexts(s);
    if (d.length) return d;
    if (Date.now() - t0 > timeout) throw new Error('no dialog appeared');
    await wait(s, 50);
  }
}
async function dismissDialogs(s) {
  for (let i = 0; i < 8; i++) {
    const n = await s.page.evaluate(() => {
      const l = [...document.querySelectorAll('.win.app-paint .dialog-layer:not(.closing)')].pop();
      l?.querySelector('.dialog').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return l ? 1 : 0;
    });
    if (!n) return;
    await wait(s, 220);
  }
}

// ================================================================== main session (en, light)
const s = await launchShell({ open: ['paint'], lang: 'en', theme: 'light' });
current = s;
await s.page.waitForSelector(`${WIN} .pt-doc`, { timeout: 30000 });
await wait(s, 600);
const home = s.home;
const pics = path.join(home, 'Pictures');

await test('boots with an untitled 1152×648 white canvas and the command bar', async () => {
  const info = await P(s, (p, el) => ({
    size: p.size,
    title: el.querySelector('.pt-doctitle').textContent,
    groups: [...el.querySelectorAll('.pt-g')].map((x) => x.getAttribute('aria-label')),
    captions: el.querySelectorAll('.pt-g-label, .pt-rainbow').length,
    palette: (() => {
      const box = el.querySelector('.pt-toolbox').getBoundingClientRect();
      const main = el.querySelector('.pt-main').getBoundingClientRect();
      const bar = el.querySelector('.pt-cmdbar').getBoundingClientRect();
      return { left: box.right <= main.left + 1 && box.height > box.width, tools: el.querySelectorAll('.pt-toolbox [data-tool]').length, barH: bar.height };
    })(),
    shapes: el.querySelectorAll('.pt-gallery [data-shape]').length,
    swatches: [...el.querySelectorAll('.pt-palette:not(.custom) .pt-sw')].map((b) => getComputedStyle(b).backgroundColor),
    status: el.querySelector('.pt-st-item.size').textContent,
    dirty: p.dirty(),
  }));
  assert.deepEqual(info.size, { w: 1152, h: 648 });
  assert.equal(info.title, 'Untitled - Draw');
  // Options bar along the top (no captions), then the tool palette on the left.
  assert.deepEqual(info.groups, ['Clipboard', 'Image', 'Outline and fill', 'Size', 'Colors', 'Tools', 'Brushes', 'Shapes']);
  assert.equal(info.captions, 0, 'no group captions, no rainbow colour wheel');
  assert.ok(info.palette.left && info.palette.tools === 6 && info.palette.barH <= 56, `left tool palette + slim options bar: ${JSON.stringify(info.palette)}`);
  assert.ok(info.shapes >= 23, 'at least 23 shapes');
  assert.equal(info.swatches.length, 20);
  assert.equal(info.swatches[3], 'rgb(237, 28, 36)', 'palette red');
  assert.equal(info.status, '1152 × 648px');
  assert.equal(info.dirty, false);
  assert.ok(isWhite(await px(s, 10, 10)));
  // status items (empty ones included) stay inside the 32px status bar, unaffected by shell classes
  const st = await P(s, (p, el) => [...el.querySelectorAll('.pt-st-item')].map((x) => Math.round(x.getBoundingClientRect().height)));
  assert.ok(st.every((hgt) => hgt <= 24), `status item heights ${st}`);
  const title = await s.aurora(() => window.__aurora.wm.list().find((w) => w.appId === 'paint').title);
  assert.equal(title, 'Untitled - Draw');
});

await test('pencil draws aliased pixels in color 1; title gets a *', async () => {
  await setZoom100(s);
  await tool(s, 'pencil');
  await drag(s, [[100, 100], [300, 100]]);
  assert.deepEqual(await px(s, 200, 100), [0, 0, 0, 255]);
  assert.ok(isWhite(await px(s, 200, 103)));
  const t = await P(s, (p, el) => el.querySelector('.pt-doctitle').textContent);
  assert.equal(t, '*Untitled - Draw');
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
  await P(s, (p) => { p.app.cmd('new'); });
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
  assert.equal(sel, '141 × 141px', 'constrained to a circle (cells 60…200 inclusive)');
  await P(s, (p) => p.commitPending());
  // outline/fill styles through the menus
  await s.page.click(`${WIN} .pt-g[data-g="shapeopts"] .pt-col .pt-b:nth-child(1)`);
  await s.page.locator('.menu .menu-item', { hasText: 'Crayon' }).click();
  assert.equal(await P(s, (p) => p.S.outline), 'crayon');
  await s.page.click(`${WIN} .pt-g[data-g="shapeopts"] .pt-col .pt-b:nth-child(2)`);
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
  await P(s, (p) => { p.app.cmd('new'); });
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
  assert.deepEqual(await P(s, (p) => p.sel), { x: 90, y: 90, w: 121, h: 121, floating: false });
  assert.equal(await P(s, (p, el) => el.querySelector('.pt-st-item.sel').textContent), '121 × 121px');
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
  await s.page.keyboard.press('Escape'); // drop the selection
  await wait(s, 60);
  assert.equal(await P(s, (p) => p.sel), null);
  await P(s, (p) => p.app.setSelMode('rect'));
  const h0 = await hash(s);
  await drag(s, [[100, 100], [200, 160]]);
  await s.page.keyboard.press('Control+Shift+X');
  await wait(s, 120);
  assert.deepEqual(await P(s, (p) => p.size), { w: 101, h: 61 });
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
  assert.equal(t, 'paint-test.png - Draw');
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
    await P(s, (p, el, a) => p.openPath(a), savedPng);
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
  const img = await s.page.evaluate(async () => {
    const bytes = await window.aurora.invoke('paint:clipboardReadImage');
    const bmp = await createImageBitmap(new Blob([bytes]));
    return { width: bmp.width, height: bmp.height };
  });
  assert.deepEqual(img, { width: 1152, height: 648 }, 'system clipboard holds the picture');
  await P(s, (p) => { p.app.cmd('new'); });
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
  assert.equal((await P(s, (p) => p.sel)).w, 121);
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
  await P(s, (p) => p.reveal([[p.size.w, p.size.h]]));
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
  await P(s, (p) => p.reveal([[300, 300]]));
  const c = await client(s, 300, 300);
  await s.page.mouse.move(c.x, c.y);
  await s.page.keyboard.down('Control');
  await s.page.mouse.wheel(0, -300);
  await s.page.keyboard.up('Control');
  await wait(s, 150);
  const z = await P(s, (p) => p.zoom());
  assert.ok(z > 1.2, `wheel zoomed in (${z})`);
  const c2 = await client(s, 300, 300);
  assert.ok(Math.abs(c2.x - c.x) < 3 && Math.abs(c2.y - c.y) < 3, `zoom anchored at the cursor: ${JSON.stringify({ c, c2, z, size: await P(s, (p) => p.size) })}`);
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

await test('View menu: rulers, gridlines, status bar and full screen', async () => {
  await menu(s, 'view', 'Rulers');
  await menu(s, 'view', 'Gridlines');
  const v = await P(s, (p, el) => ({
    rulers: el.querySelector('.pt-main').classList.contains('rulers'),
    rulerW: el.querySelector('.pt-ruler-h').getBoundingClientRect().width,
    grid: !el.querySelector('.pt-grid').hidden,
    scrollTop: getComputedStyle(el.querySelector('.pt-scroll')).top,
  }));
  assert.deepEqual([v.rulers, v.grid, v.scrollTop], [true, true, '20px']);
  assert.ok(v.rulerW > 300, 'ruler drawn across the workspace');
  await s.shot('paint-rulers-grid');
  await s.page.keyboard.press('Control+r');
  await s.page.keyboard.press('Control+g');
  assert.deepEqual(await P(s, (p) => [p.S.rulers, p.S.grid]), [false, false]);
  await menu(s, 'view', 'Status bar');
  assert.equal(await P(s, (p, el) => el.querySelector('.pt-status').hidden), true);
  await menu(s, 'view', 'Status bar');
  assert.equal(await P(s, (p, el) => el.querySelector('.pt-status').hidden), false);
  await s.page.keyboard.press('F11');
  await wait(s, 300);
  const fs1 = await P(s, (p, el) => ({ win: el.classList.contains('fullscreen'), bar: getComputedStyle(el.querySelector('.pt-cmdbar')).display }));
  assert.deepEqual(fs1, { win: true, bar: 'none' });
  await s.page.keyboard.press('Escape');
  await wait(s, 300);
  assert.equal(await P(s, (p, el) => el.classList.contains('fullscreen')), false);
});

await test('curve control handles bend the line; transparent selection drops color 2', async () => {
  await P(s, (p) => {
    p.app.setColor('primary', '#000000');
    p.app.setColor('secondary', '#ffffff');
  });
  await shape(s, 'curve');
  await drag(s, [[100, 300], [400, 300]]);
  const c1 = await P(s, (p, el) => {
    const r = el.querySelector('.pt-h[data-h="c1"]').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await s.page.mouse.move(c1.x, c1.y);
  await s.page.mouse.down();
  await s.page.mouse.move(c1.x, c1.y - 120, { steps: 6 });
  await s.page.mouse.up();
  await P(s, (p) => p.commitPending());
  assert.ok((await nonWhite(s, 120, 200, 120, 80)) > 20, 'curve bent upwards');
  // transparent selection: white pixels of the moved selection don't cover what's below
  await P(s, (p) => p.app.setColor('primary', '#22b14c'));
  await shape(s, 'rect');
  await P(s, (p) => {
    p.app.setFillStyle('solid');
    p.app.setColor('secondary', '#22b14c');
  });
  await drag(s, [[500, 100], [700, 200]]);
  await P(s, (p) => {
    p.commitPending();
    p.app.setFillStyle('none');
    p.app.setColor('secondary', '#ffffff');
    p.app.setColor('primary', '#000000');
  });
  await P(s, (p) => p.app.setTool('select'));
  await drag(s, [[90, 260], [420, 320]]);
  await P(s, (p) => p.app.cmd('transparentSel'));
  assert.equal(await P(s, (p) => p.S.transparentSel), true);
  await drag(s, [[250, 300], [610, 140]]);
  await s.page.keyboard.press('Escape');
  await wait(s, 80);
  const under = await px(s, 690, 190);
  assert.deepEqual(under, [34, 177, 76, 255], 'green still visible through the transparent selection');
  await P(s, (p) => p.app.cmd('transparentSel'));
});

await test('pasting a picture larger than the canvas enlarges it (undoable)', async () => {
  await P(s, async (p) => {
    const c = document.createElement('canvas');
    c.width = 1500;
    c.height = 700;
    const g = c.getContext('2d');
    g.fillStyle = '#ff7f27';
    g.fillRect(0, 0, 1500, 700);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    await window.aurora.invoke('paint:clipboardWriteImage', new Uint8Array(await blob.arrayBuffer()));
  });
  const before = await P(s, (p) => p.size);
  await P(s, (p) => p.app.cmd('paste'));
  await waitFor(s, (p) => p.sel && p.sel.floating);
  assert.deepEqual(await P(s, (p) => p.size), { w: 1500, h: 700 });
  await s.page.keyboard.press('Escape');
  assert.deepEqual(await px(s, 1400, 650), [255, 127, 39, 255]);
  await P(s, (p) => p.app.cmd('undo'));
  await P(s, (p) => p.app.cmd('undo'));
  assert.deepEqual(await P(s, (p) => p.size), before);
});

await test('Set as desktop background stores the saved picture in settings', async () => {
  const f = path.join(pics, 'wallpaper.png');
  assert.equal(await P(s, (p, el, a) => p.writeFile(a, 'png'), f), true);
  await P(s, (p) => {
    p.app.cmd('wallpaper', 'center');
  });
  await s.page.waitForFunction((file) => window.__aurora.settings.get('wallpaper') === file, f, { timeout: 5000 });
  assert.equal(await s.aurora(() => window.__aurora.settings.get('wallpaperFit')), 'center');
  await s.aurora(() => window.__aurora.settings.reset('wallpaper'));
});

await test('selection handles scale, rotate applies to the selection, arrows nudge', async () => {
  await P(s, (p) => {
    p.app.cmd('new');
  });
  const ask = await s.page.waitForSelector(`${WIN} .pt-ask`, { timeout: 1500 }).catch(() => null);
  if (ask) await s.page.click(`${WIN} .pt-ask .dialog-footer .btn:nth-child(2)`);
  await waitFor(s, (p) => !p.dirty() && p.size.w === 1152);
  await P(s, (p) => {
    p.app.setColor('primary', '#3f48cc');
    p.app.setColor('secondary', '#3f48cc');
    p.app.setFillStyle('solid');
  });
  await shape(s, 'rect');
  await drag(s, [[100, 100], [199, 149]]);
  await P(s, (p) => {
    p.commitPending();
    p.app.setFillStyle('none');
    p.app.setColor('secondary', '#ffffff');
    p.app.setTool('select');
  });
  await drag(s, [[100, 100], [199, 149]]);
  assert.deepEqual(await P(s, (p) => p.sel), { x: 100, y: 100, w: 100, h: 50, floating: false });
  // drag the south-east handle: the selection is lifted and stretched
  const se = await P(s, (p, el) => {
    const r = el.querySelector('.pt-h[data-kind="sel"][data-h="se"]').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, z: p.zoom() };
  });
  await s.page.mouse.move(se.x, se.y);
  await s.page.mouse.down();
  await s.page.mouse.move(se.x + 100 * se.z, se.y + 50 * se.z, { steps: 6 });
  await s.page.mouse.up();
  assert.deepEqual(await P(s, (p) => p.sel), { x: 100, y: 100, w: 200, h: 100, floating: true });
  // rotate right applies to the floating selection only
  await P(s, (p) => p.app.cmd('rotR'));
  assert.deepEqual(await P(s, (p) => p.sel), { x: 100, y: 100, w: 100, h: 200, floating: true });
  assert.deepEqual(await P(s, (p) => p.size), { w: 1152, h: 648 });
  // arrow keys nudge (Shift = 10 px)
  await s.page.keyboard.press('ArrowRight');
  await s.page.keyboard.press('Shift+ArrowDown');
  assert.deepEqual(await P(s, (p) => p.sel), { x: 101, y: 110, w: 100, h: 200, floating: true });
  await s.page.keyboard.press('Enter');
  await s.page.keyboard.press('Escape');
  await wait(s, 60);
  assert.deepEqual(await px(s, 150, 300), [63, 72, 204, 255], 'stretched + rotated content committed');
  assert.ok(isWhite(await px(s, 150, 105)), 'original area cleared');
});

await test('right-drag eraser only replaces color 1 (color eraser)', async () => {
  await P(s, (p) => {
    p.app.setColor('primary', '#3f48cc');
    p.app.setColor('secondary', '#fff200');
  });
  await tool(s, 'eraser');
  await drag(s, [[90, 250], [260, 250]], { button: 'right' });
  assert.deepEqual(await px(s, 150, 250), [255, 242, 0, 255], 'blue replaced by yellow');
  assert.ok(isWhite(await px(s, 95, 250)), 'white left alone');
  await P(s, (p) => p.app.cmd('undo'));
  assert.deepEqual(await px(s, 150, 250), [63, 72, 204, 255]);
  await P(s, (p) => p.app.setColor('secondary', '#ffffff'));
});

await test('polygon vertices stay editable; text box can be resized before committing', async () => {
  await P(s, (p) => {
    p.app.setColor('primary', '#000000');
    p.app.setFillStyle('none');
    p.app.setSize(3);
  });
  await shape(s, 'polygon');
  await drag(s, [[500, 100], [700, 100]]);
  await click(s, 700, 250);
  await click(s, 500, 250, { clickCount: 2 });
  const handles = await P(s, (p, el) => [...el.querySelectorAll('.pt-h[data-kind="shape"]')].map((x) => x.dataset.h));
  assert.deepEqual(handles, ['v0', 'v1', 'v2', 'v3']);
  const v2 = await P(s, (p, el) => {
    const r = el.querySelector('.pt-h[data-h="v2"]').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, z: p.zoom() };
  });
  await s.page.mouse.move(v2.x, v2.y);
  await s.page.mouse.down();
  await s.page.mouse.move(v2.x + 60 * v2.z, v2.y + 60 * v2.z, { steps: 5 });
  await s.page.mouse.up();
  await P(s, (p) => p.commitPending());
  assert.ok((await nonWhite(s, 700, 255, 60, 60)) > 20, 'moved vertex drawn');
  await tool(s, 'text');
  await click(s, 300, 400);
  await s.page.waitForSelector(`${WIN} .pt-ta`);
  await s.page.keyboard.type('Resizable text box that wraps over several lines');
  const before = await P(s, (p, el) => el.querySelector('.pt-textbox').getBoundingClientRect().height);
  const e = await P(s, (p, el) => {
    const r = el.querySelector('.pt-textbox .pt-h-e').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await s.page.mouse.move(e.x, e.y);
  await s.page.mouse.down();
  await s.page.mouse.move(e.x - 120, e.y, { steps: 5 });
  await s.page.mouse.up();
  const after = await P(s, (p, el) => el.querySelector('.pt-textbox').getBoundingClientRect().height);
  assert.ok(after > before, `narrower box grows taller (${before} -> ${after})`);
  await s.page.keyboard.press('Escape');
  await wait(s, 80);
  assert.ok((await nonWhite(s, 300, 400, 300, 120)) > 200, 'wrapped text committed');
});

await test('About dialog, recent files menu, zoom slider, middle-button pan, inches in properties', async () => {
  await menu(s, 'file', 'About Draw');
  await s.page.waitForSelector(`${WIN} .pt-about`);
  assert.match(await s.page.locator(`${WIN} .pt-about`).textContent(), /Draw/);
  await s.page.click(`${WIN} .dialog-footer .btn.primary`);
  await wait(s, 250);
  await s.page.click(`${WIN} .pt-menu-btn:nth-child(1)`);
  await s.page.locator('.menu .menu-item', { hasText: 'Recent' }).hover();
  await wait(s, 350);
  const rec = await s.page.locator('.menu .menu-item .label').allTextContents();
  assert.ok(rec.includes('paint-test.png'), `recent list: ${rec.join('|')}`);
  await s.page.keyboard.press('Escape');
  await wait(s, 100);
  // zoom slider
  const sl = await s.page.locator(`${WIN} .pt-zoom-slider`).boundingBox();
  await s.page.mouse.click(sl.x + sl.width * 0.9, sl.y + sl.height / 2);
  const z = await P(s, (p) => p.zoom());
  assert.ok(z > 3, `slider zoomed to ${z}`);
  // middle-button drag pans the view
  const sc0 = await P(s, (p, el) => [el.querySelector('.pt-scroll').scrollLeft, el.querySelector('.pt-scroll').scrollTop]);
  const mid = await P(s, (p, el) => {
    const r = el.querySelector('.pt-scroll').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await s.page.mouse.move(mid.x, mid.y);
  await s.page.mouse.down({ button: 'middle' });
  await s.page.mouse.move(mid.x - 150, mid.y - 80, { steps: 5 });
  await s.page.mouse.up({ button: 'middle' });
  const sc1 = await P(s, (p, el) => [el.querySelector('.pt-scroll').scrollLeft, el.querySelector('.pt-scroll').scrollTop]);
  assert.deepEqual([sc1[0] - sc0[0], sc1[1] - sc0[1]], [150, 80]);
  await setZoom100(s);
  // image properties in inches
  await s.page.keyboard.press('Control+e');
  await s.page.waitForSelector(`${WIN} .pt-props-dlg`);
  await s.page.locator(`${WIN} .pt-props-dlg .segmented button`, { hasText: 'Inches' }).click();
  assert.equal(await s.page.locator(`${WIN} .pt-props-dlg input[type=number]`).first().inputValue(), '12');
  await s.page.locator(`${WIN} .pt-props-dlg input[type=number]`).first().fill('10');
  await s.page.click(`${WIN} .dialog-footer .btn.primary`);
  await wait(s, 200);
  assert.equal((await P(s, (p) => p.size)).w, 960, '10 in = 960 px');
  await s.page.keyboard.press('Control+z');
  // Undo restores the canvas asynchronously (~60 ms fresh, longer with a long history): wait for it.
  for (let i = 0; i < 60 && (await P(s, (p) => p.size)).w !== 1152; i++) await wait(s, 50);
  assert.equal((await P(s, (p) => p.size)).w, 1152);
});

await test('older undo steps are compressed to PNG in the background and still restore exactly', async () => {
  await P(s, (p) => {
    p.app.cmd('new');
  });
  const ask = await s.page.waitForSelector(`${WIN} .pt-ask`, { timeout: 1500 }).catch(() => null);
  if (ask) await s.page.click(`${WIN} .pt-ask .dialog-footer .btn:nth-child(2)`);
  await waitFor(s, (p) => !p.dirty() && p.history.undo === 0);
  await P(s, (p) => {
    p.historyInternals.budget = 2 * 1024 * 1024;
    p.historyInternals.keepRaw = 2;
    p.app.setTolerance(0);
  });
  const start = await hash(s);
  await tool(s, 'fill');
  const colors = ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#00ffff', '#ff00ff', '#000000', '#7f7f7f'];
  for (const c of colors) {
    await P(s, (p, el, col) => p.app.setColor('primary', col), c);
    await click(s, 300, 300);
  }
  const end = await hash(s);
  const st = await waitFor(
    s,
    (p) => {
      const h = p.historyInternals;
      const blobs = h.undoStack.filter((e) => e.blob).length;
      return blobs >= 5 ? { blobs, raw: h.rawBytes() } : null;
    },
    null,
    { timeout: 15000 },
  );
  assert.ok(st.raw <= 4 * 1152 * 648 * 4, `raw bytes kept low (${st.raw})`);
  for (let i = 0; i < colors.length; i++) await P(s, (p) => p.app.cmd('undo'));
  assert.equal(await hash(s), start, 'undo through compressed steps');
  for (let i = 0; i < colors.length; i++) await P(s, (p) => p.app.cmd('redo'));
  assert.equal(await hash(s), end, 'redo through compressed steps');
  await P(s, (p) => {
    p.historyInternals.budget = 160 * 1024 * 1024;
    p.historyInternals.keepRaw = 4;
    p.app.setTolerance(12);
  });
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

// ------------------------------------------------------------------ QA regressions (en, light)
async function freshDirty(sx) {
  P(sx, (p) => {
    p.app.cmd('new');
  });
  const ask = await sx.page.waitForSelector(`${WIN} .pt-ask`, { timeout: 800 }).catch(() => null);
  if (ask) await sx.page.click(`${WIN} .pt-ask .dialog-footer .btn:nth-child(2)`);
  await waitFor(sx, (p) => !p.file.path && !p.dirty());
  await wait(sx, 250);
  await tool(sx, 'pencil');
  await drag(sx, [[20, 20], [80, 60]]);
  assert.equal(await P(sx, (p) => p.dirty()), true);
}

await test('repeated Ctrl+S / Ctrl+O and double clicks open a single dialog; closing points at it', async () => {
  await freshDirty(s);
  await s.page.locator(`${WIN} .pt-scroll`).focus();
  await s.page.keyboard.press('Control+s');
  await s.page.keyboard.press('Control+s');
  await wait(s, 800);
  assert.equal(await s.page.locator(`${WIN} .fp-dialog`).count(), 1, 'one save picker for two Ctrl+S');
  // Alt+F4 / taskbar close while the picker is open: no second prompt, window stays
  const closed = await P(s, (p, el) => window.__aurora.wm.get(el.dataset.id).close());
  assert.equal(closed, false, 'close is refused while a dialog is open');
  assert.equal(await s.page.locator(`${WIN} .pt-ask`).count(), 0, 'no save prompt stacked on the picker');
  await dismissDialogs(s);
  await waitFor(s, () => !document.querySelector('.win.app-paint .dialog-layer:not(.closing)'));
  // double click on the title-bar Save button
  await s.page.click(`${WIN} .pt-qa[data-tip^="Save"]`, { clickCount: 2 });
  await wait(s, 800);
  assert.equal(await s.page.locator(`${WIN} .fp-dialog`).count(), 1, 'one picker for a double click');
  await dismissDialogs(s);
  await wait(s, 250);
  // Ctrl+O twice on a dirty picture: a single "save changes?" prompt
  await s.page.locator(`${WIN} .pt-scroll`).focus();
  await s.page.keyboard.press('Control+o');
  await s.page.keyboard.press('Control+o');
  await wait(s, 600);
  assert.equal((await dialogTexts(s)).length, 1, 'one prompt for two Ctrl+O');
  await dismissDialogs(s);
  await wait(s, 300);
  // keyboard shortcuts work again once the dialogs are gone
  await s.page.keyboard.press('b');
  assert.equal(await P(s, (p) => p.S.tool), 'brush', 'focus returned to the canvas');
  await s.page.keyboard.press('p');
});

await test('Ctrl+Z in the middle of a stroke only cancels that stroke', async () => {
  await tool(s, 'pencil');
  const before = (await P(s, (p) => p.history)).undo;
  const h0 = await hash(s);
  await P(s, (p) => p.reveal([[300, 300], [400, 330]]));
  const a = await client(s, 300, 300);
  const b = await client(s, 400, 330);
  await s.page.mouse.move(a.x, a.y);
  await s.page.mouse.down();
  await s.page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
  await s.page.keyboard.press('Control+z');
  await s.page.mouse.move(b.x, b.y, { steps: 4 });
  await s.page.mouse.up();
  await wait(s, 150);
  assert.equal((await P(s, (p) => p.history)).undo, before, 'earlier steps untouched');
  assert.equal(await hash(s), h0, 'the cancelled stroke left no pixels');
});

await test('error paths show localized explanations (undecodable, empty, folder, missing, bad save folder)', async () => {
  fs.writeFileSync(path.join(pics, 'garbage.png'), 'this is not a picture');
  fs.writeFileSync(path.join(pics, 'empty.png'), '');
  fs.mkdirSync(path.join(pics, 'folder.png'), { recursive: true });
  const cases = [
    ['garbage.png', "Draw can't open garbage.png.", "The file isn't a picture, or it is damaged."],
    ['empty.png', "Draw can't open empty.png.", "The file isn't a picture, or it is damaged."],
    ['folder.png', "Draw can't open folder.png.", 'This is a folder, not a picture.'],
    ['missing.png', "Draw can't open missing.png.", "The file doesn't exist anymore."],
  ];
  const h0 = await hash(s);
  for (const [name, first, why] of cases) {
    P(s, (p, el, a) => {
      p.openPath(a);
    }, path.join(pics, name));
    const [d] = await waitDialog(s);
    assert.ok(d.includes(first) && d.includes(why), `${name}: ${d}`);
    assert.ok(!/EISDIR|ENOENT|source image|InvalidState/.test(d), `no raw system text: ${d}`);
    await dismissDialogs(s);
  }
  assert.equal(await hash(s), h0, 'picture untouched by failed opens');
  // saving below a regular file -> the folder can't be created
  P(s, (p, el, a) => {
    p.writeFile(a, 'png');
  }, path.join(pics, 'garbage.png', 'x.png'));
  let [d] = await waitDialog(s);
  assert.ok(d.includes("Draw can't save x.png.") && d.includes("The folder doesn't exist and can't be created there."), d);
  await dismissDialogs(s);
  P(s, (p) => {
    p.writeFile('/proc/aurora-paint-test.png', 'png');
  });
  [d] = await waitDialog(s);
  assert.ok(d.includes("The folder doesn't exist and can't be created there.") || d.includes("You don't have permission"), d);
  await dismissDialogs(s);
  assert.notEqual(await P(s, (p) => p.file.path), '/proc/aurora-paint-test.png', 'failed save keeps the old file name');
  // a recent file that disappeared is dropped from the Recent list
  const gone = path.join(pics, 'gone.png');
  fs.writeFileSync(gone, makePng(12, 8, [0, 128, 255, 255]));
  await P(s, (p, el, a) => p.openPath(a), gone);
  assert.ok((await P(s, (p) => p.app.recent())).includes(gone));
  fs.unlinkSync(gone);
  P(s, (p, el, a) => {
    p.app.cmd('openRecent', a);
  }, gone);
  [d] = await waitDialog(s);
  assert.ok(d.includes("The file doesn't exist anymore."), d);
  await dismissDialogs(s);
  assert.ok(!(await P(s, (p) => p.app.recent())).includes(gone), 'missing file removed from Recent');
});

await test('file names are shown as text, never as HTML (title, Recent menu, error message)', async () => {
  const evil = '<img src=x onerror="window.__pxss=1">.png';
  const file = path.join(pics, evil);
  fs.writeFileSync(file, makePng(30, 20, [10, 200, 30, 255]));
  await P(s, (p, el, a) => p.openPath(a), file);
  const t = await P(s, (p, el) => el.querySelector('.pt-doctitle').textContent);
  assert.equal(t, `${evil} - Draw`);
  await s.page.click(`${WIN} .pt-menu-btn:nth-child(1)`);
  await wait(s, 250);
  await s.page.locator('.menu .menu-item', { hasText: 'Recent' }).hover();
  await wait(s, 400);
  const labels = await s.page.locator('.menu .menu-item .label').allTextContents();
  assert.ok(labels.includes(evil), 'literal name in the Recent menu');
  await s.page.keyboard.press('Escape');
  await s.page.keyboard.press('Escape');
  const bad = path.join(pics, '<b onmouseover=alert(1)>bad<b>.png');
  fs.writeFileSync(bad, 'nope');
  P(s, (p, el, a) => {
    p.openPath(a);
  }, bad);
  const [d] = await waitDialog(s);
  assert.ok(d.includes("can't open <b onmouseover=alert(1)>bad<b>.png"), d);
  await dismissDialogs(s);
  const injected = await s.page.evaluate(() => ({ imgs: document.querySelectorAll('img[src="x"]').length, bold: document.querySelectorAll('.win.app-paint b, .menu b, .dialog b').length, xss: window.__pxss }));
  assert.deepEqual(injected, { imgs: 0, bold: 0, xss: undefined });
});

await test('canvas grip and pasting respect the 16000 px / 50 megapixel limits', async () => {
  await P(s, (p) => p.app.cmd('new'));
  await dismissDialogs(s);
  await waitFor(s, (p) => p.size.w === 1152);
  await P(s, (p) => p.setZoom(0.02));
  await wait(s, 300);
  const g = await s.page.locator(`${WIN} .pt-cvh-se`).boundingBox();
  await s.page.mouse.move(g.x + 4, g.y + 4);
  await s.page.mouse.down();
  await s.page.mouse.move(g.x + 420, g.y + 330, { steps: 6 });
  await s.page.mouse.up();
  await wait(s, 600);
  const sz = await P(s, (p) => p.size);
  assert.ok(sz.w > 1152 && sz.h > 648, `canvas grew: ${sz.w}x${sz.h}`);
  assert.ok(sz.w * sz.h <= 50e6 && sz.w <= 16000 && sz.h <= 16000, `within limits: ${sz.w}x${sz.h}`);
  await P(s, (p) => p.app.cmd('undo'));
  await waitFor(s, (p) => p.size.w === 1152 && p.size.h === 648);
  await P(s, (p) => p.setZoom(1));
  // a 16001-pixel-wide picture can't be pasted
  const wide = path.join(pics, 'too-wide.png');
  fs.writeFileSync(wide, makePng(16001, 4, [0, 0, 0, 255]));
  P(s, (p, el, a) => {
    p.pasteFromPath(a);
  }, wide);
  const [d] = await waitDialog(s, 8000);
  assert.ok(d.includes('too large to paste'), d);
  await dismissDialogs(s);
  assert.deepEqual(await P(s, (p) => p.size), { w: 1152, h: 648 });
  assert.equal(await P(s, (p) => p.sel), null);
});

await test('Save as honours a typed picture extension; .ico pictures are not overwritten with PNG data', async () => {
  await P(s, (p) => p.app.setTool('pencil'));
  P(s, (p) => {
    p.app.cmd('saveAs');
  });
  await savePicker(s, 'typed.jpg');
  await waitFor(s, (p) => p.file.name === 'typed.jpg');
  const jpg = fs.readFileSync(path.join(pics, 'typed.jpg'));
  assert.deepEqual([...jpg.subarray(0, 3)], [0xff, 0xd8, 0xff], 'JPEG data in typed.jpg');
  assert.equal(await P(s, (p) => p.file.format), 'jpeg');
  assert.ok(!fs.existsSync(path.join(pics, 'typed.jpg.png')));
  P(s, (p) => {
    p.app.cmd('saveAs', 'png');
  });
  await savePicker(s, 'plain');
  await waitFor(s, (p) => p.file.name === 'plain.png');
  assert.deepEqual(pngSize(path.join(pics, 'plain.png')), { w: 1152, h: 648 });
  // .ico: opens, but Ctrl+S asks for a name and format
  const ico = path.join(pics, 'app.ico');
  const icoBytes = makeIco(32, 32, [255, 0, 255, 255]);
  fs.writeFileSync(ico, icoBytes);
  await P(s, (p, el, a) => p.openPath(a), ico);
  assert.deepEqual(await P(s, (p) => p.size), { w: 32, h: 32 });
  assert.deepEqual(await px(s, 3, 3), [255, 0, 255, 255]);
  await tool(s, 'pencil');
  await drag(s, [[2, 2], [20, 20]]);
  await s.page.locator(`${WIN} .pt-scroll`).focus();
  await s.page.keyboard.press('Control+s');
  await s.page.waitForSelector(`${WIN} .fp-dialog`, { timeout: 4000 });
  await dismissDialogs(s);
  assert.ok(fs.readFileSync(ico).equals(icoBytes), 'the .ico file is unchanged');
});

await test('shell launch arguments: wrong types ignored, relative paths refused, launch never waits for a message', async () => {
  const count = () => s.page.locator(WIN).count();
  const n0 = await count();
  const keep = await s.aurora(() => window.__aurora.wm.list().filter((w) => w.appId === 'paint').map((w) => w.id));
  try {
    await s.aurora(() => window.__aurora.registry.launch('paint', { file: { evil: 1 } }));
    await s.page.waitForFunction((n) => document.querySelectorAll('.win.app-paint').length === n + 1, n0);
    await wait(s, 400);
    assert.deepEqual(await dialogTexts(s), [], 'no message for a non-string argument');
    const resolved = await s.aurora(() => Promise.race([window.__aurora.registry.launch('paint', { file: '../../etc/x.png' }).then(() => 'resolved'), new Promise((r) => setTimeout(() => r('blocked'), 4000))]));
    assert.equal(resolved, 'resolved', 'launch() returns while the error message is shown');
    const d = await waitDialog(s);
    assert.ok(d.some((x) => x.includes("Draw can't open x.png.")), d.join('|'));
  } finally {
    await dismissDialogs(s);
    await s.aurora((ids) => {
      window.__aurora.wm
        .list()
        .filter((w) => w.appId === 'paint' && !ids.includes(w.id))
        .forEach((w) => w.close(true));
    }, keep);
    await s.page.waitForFunction((n) => document.querySelectorAll('.win.app-paint').length === n, n0);
    await wait(s, 300);
  }
});

await test('keyboard: the tools grid, shape gallery and palette are single Tab stops with arrow keys inside', async () => {
  await tool(s, 'fill');
  const stops = await P(s, (p, el) => ({
    tools: [...el.querySelectorAll('.pt-tools button')].filter((b) => b.tabIndex === 0).map((b) => b.dataset.tool),
    shapes: [...el.querySelectorAll('.pt-gallery button')].filter((b) => b.tabIndex === 0).length,
    palette: [...el.querySelectorAll('.pt-pal-wrap button')].filter((b) => b.tabIndex === 0).length,
  }));
  assert.deepEqual(stops, { tools: ['fill'], shapes: 1, palette: 1 });
  await s.page.focus(`${WIN} .pt-tools [data-tool="fill"]`);
  await s.page.keyboard.press('ArrowRight');
  assert.equal(await s.page.evaluate(() => document.activeElement.dataset.tool), 'text');
  await s.page.keyboard.press('Tab');
  const next = await s.page.evaluate(() => document.activeElement.getAttribute('aria-label'));
  assert.equal(next, 'Brushes', 'Tab leaves the tools grid');
  await s.page.keyboard.press('Shift+Tab');
  assert.equal(await s.page.evaluate(() => document.activeElement.dataset.tool), 'text', 'Shift+Tab returns to the last focused tool');
  await s.page.keyboard.press('Enter');
  assert.equal(await P(s, (p) => p.S.tool), 'text');
  await tool(s, 'pencil');
});

await test('picking a colour with the mouse while typing keeps the text box active', async () => {
  P(s, (p) => {
    p.app.cmd('new');
  });
  const ask = await s.page.waitForSelector(`${WIN} .pt-ask`, { timeout: 800 }).catch(() => null);
  if (ask) await s.page.click(`${WIN} .pt-ask .dialog-footer .btn:nth-child(2)`);
  await waitFor(s, (p) => p.size.w === 1152 && !p.dirty());
  await setZoom100(s);
  await tool(s, 'text');
  await click(s, 300, 300);
  await s.page.waitForSelector(`${WIN} .pt-ta`);
  await s.page.keyboard.type('ab');
  await s.page.click(`${WIN} .pt-palette .pt-sw[data-color="#ed1c24"]`);
  await s.page.keyboard.type('c');
  assert.equal(await P(s, (p, el) => el.querySelector('.pt-ta').value), 'abc');
  assert.equal(await P(s, (p) => p.S.primary), '#ed1c24');
  await s.page.keyboard.press('Escape');
  await waitFor(s, (p) => !p.pending);
  assert.ok((await nonWhite(s, 295, 295, 120, 60)) > 20, 'red text committed');
  await P(s, (p) => p.app.setColor('primary', '#000000'));
  await tool(s, 'pencil');
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
    w.restore();
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

await test('opening and closing Paint 15 times leaks no listeners or DOM nodes', async () => {
  const cdp = await s.page.context().newCDPSession(s.page);
  const counts = async () => {
    await cdp.send('HeapProfiler.collectGarbage');
    const out = {};
    for (const [k, expr] of [['window', 'window'], ['document', 'document'], ['body', 'document.body']]) {
      const { result } = await cdp.send('Runtime.evaluate', { expression: expr });
      const { listeners } = await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId });
      out[k] = listeners.length;
    }
    out.nodes = await s.page.evaluate(() => document.getElementsByTagName('*').length);
    return out;
  };
  const closeAll = async () => {
    await s.aurora(() => window.__aurora.wm.list().filter((w) => w.appId === 'paint').forEach((w) => w.close(true)));
    await s.page.waitForFunction(() => !document.querySelector('.win.app-paint'), null, { timeout: 5000 });
    await wait(s, 300);
  };
  await closeAll();
  const before = await counts();
  for (let i = 0; i < 15; i++) {
    await s.aurora(() => window.__aurora.registry.launch('paint'));
    await s.page.waitForSelector(`${WIN} .pt-doc`);
    await wait(s, 150);
    await tool(s, 'pencil');
    await drag(s, [[30, 30], [90, 60]], { steps: 3 });
    await s.page.click(`${WIN} .pt-g[data-g="size"] .pt-b:not(.pt-g-compact)`);
    await wait(s, 60);
    await s.page.keyboard.press('Escape');
    await s.page.click(`${WIN} .pt-menu-btn:nth-child(3)`);
    await wait(s, 60);
    await s.page.keyboard.press('Escape');
    await P(s, (p) => p.app.setTool('text'));
    await closeAll();
  }
  const after = await counts();
  assert.deepEqual(after, before, `listeners/nodes before ${JSON.stringify(before)} after ${JSON.stringify(after)}`);
  await cdp.detach();
});

await test('no renderer errors in the English/light session', async () => {
  const errs = await errorsOf(s);
  assert.deepEqual(errs, []);
});
await s.close();

// ================================================================== French + dark
const f = await launchShell({ open: ['paint'], lang: 'fr', theme: 'dark' });
current = f;
await f.page.waitForSelector(`${WIN} .pt-doc`, { timeout: 30000 });
await wait(f, 600);
await test('French UI strings and dark theme', async () => {
  const info = await P(f, (p, el) => ({
    title: el.querySelector('.pt-doctitle').textContent,
    groups: [...el.querySelectorAll('.pt-g')].map((x) => x.getAttribute('aria-label')),
    menus: [...el.querySelectorAll('.pt-menu-btn')].map((x) => x.textContent),
    tip: el.querySelector('[data-tool="fill"]').dataset.tip,
    ws: getComputedStyle(el.querySelector('.pt-main')).backgroundColor,
    text: getComputedStyle(el).color,
  }));
  assert.equal(info.title, 'Sans titre - Dessin');
  assert.deepEqual(info.groups, ['Presse-papiers', 'Image', 'Contour et remplissage', 'Taille', 'Couleurs', 'Outils', 'Pinceaux', 'Formes']);
  assert.deepEqual(info.menus, ['Fichier', 'Modifier', 'Affichage']);
  assert.equal(info.tip, 'Remplissage (F)');
  assert.equal(info.ws, 'rgb(14, 19, 31)', 'dark workspace (--bg-alt, cold ambiance)');
  assert.equal(info.text, 'rgb(230, 234, 242)');
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
  await f.page.mouse.move(800, 600); // no tooltip in the docs screenshot
  await wait(f, 500);
  await f.shot('paint-text-fr');
  fs.copyFileSync(path.join(OUT, 'paint-text-fr.png'), path.join(DOCS, 'paint-text-fr.png'));
  const errs = await errorsOf(f);
  assert.deepEqual(errs, []);
});
await test('French: menus, submenus, flyouts, context menus, messages and dialogs have no English left', async () => {
  const flat = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (typeof v === 'object' ? flat(v, `${p}${k}.`) : [[p + k, v]]));
  const read = (f) => JSON.parse(fs.readFileSync(path.join(here, '..', 'renderer', f), 'utf8'));
  const app = read('apps/paint/i18n.json');
  const frVals = new Set([...flat(app.fr), ...flat(read('core/i18n/fr.json'))].map((x) => x[1]));
  const english = new Set([...flat(app.en), ...flat(read('core/i18n/en.json'))].map((x) => x[1]).filter((v) => typeof v === 'string' && !frVals.has(v) && /[a-z]{3}/i.test(v) && !v.includes('{')));
  const found = new Map();
  const scan = async (where) => {
    const texts = await f.page.evaluate(() => {
      const out = [];
      for (const r of document.querySelectorAll('.win.app-paint, .menu')) {
        const walker = document.createTreeWalker(r, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          if (n.parentElement?.closest('[hidden], option')) continue;
          const v = n.textContent.trim();
          if (v) out.push(v);
        }
        for (const el of r.querySelectorAll('[data-tip],[aria-label],[title],[placeholder]')) for (const a of ['data-tip', 'aria-label', 'title', 'placeholder']) if (el.getAttribute(a)) out.push(el.getAttribute(a));
      }
      return out;
    });
    // strings from the English dictionaries, and English sentences that come from nowhere
    // (raw system or decoder messages)
    const words = /\b(the|cannot|can't|doesn't|isn't|couldn't|failed|error|invalid|denied|permission|please|with|from|this|your)\b/i;
    for (const raw of texts) {
      for (const line of raw.split('\n')) {
        const v = line.replace(/\s*(\(.*\)|—.*)$/, '').trim();
        if (english.has(v) || english.has(line.trim()) || words.test(line)) found.set(v, where);
      }
    }
  };
  const esc = async () => {
    await f.page.keyboard.press('Escape');
    await wait(f, 200);
  };
  await P(f, (p) => p.app.setTool('pencil'));
  await scan('window');
  for (const i of [1, 2, 3]) {
    await f.page.click(`${WIN} .pt-menu-btn:nth-child(${i})`);
    await wait(f, 300);
    await scan(`menu ${i}`);
    const items = f.page.locator('.menu').first().locator('.menu-item:not(.disabled)');
    const n = await items.count();
    for (let k = 0; k < n; k++) {
      await items.nth(k).hover();
      await wait(f, 280);
      await scan(`menu ${i} item ${k}`);
    }
    await esc();
    await esc();
  }
  for (const sel of ['.pt-split-arrow', '.pt-b.sm.wide', '.pt-zoom-pct']) {
    const n = await f.page.locator(`${WIN} ${sel}`).count();
    for (let k = 0; k < n; k++) {
      await f.page.locator(`${WIN} ${sel}`).nth(k).click();
      await wait(f, 280);
      await scan(`${sel} ${k}`);
      await esc();
    }
  }
  for (const g of ['brushes', 'size']) {
    await P(f, (p) => p.app.setTool('pencil'));
    await f.page.click(`${WIN} .pt-g[data-g="${g}"] .pt-b:not(.pt-g-compact)`);
    await wait(f, 300);
    await scan(`flyout ${g}`);
    await esc();
  }
  for (const id of ['text', 'fill']) {
    await P(f, (p, el, a) => p.app.setTool(a), id);
    await wait(f, 200);
    await scan(`context bar ${id}`);
  }
  await P(f, (p) => p.app.setTool('select'));
  await click(f, 200, 200, { button: 'right' });
  await wait(f, 300);
  await scan('selection context menu');
  await esc();
  for (const c of ['resize', 'props', 'editColors', 'about']) {
    P(f, (p, el, a) => {
      p.app.cmd(a);
    }, c);
    await wait(f, 450);
    await scan(`dialog ${c}`);
    await dismissDialogs(f);
  }
  await P(f, (p) => p.app.setTool('pencil'));
  await drag(f, [[40, 40], [90, 80]]);
  P(f, (p) => {
    p.app.cmd('new');
  });
  await wait(f, 450);
  await scan('save changes prompt');
  await dismissDialogs(f);
  P(f, (p) => {
    p.app.cmd('wallpaper', 'fill');
  });
  await wait(f, 450);
  await scan('wallpaper prompt');
  await dismissDialogs(f);
  P(f, (p) => {
    p.app.cmd('saveAs');
  });
  await wait(f, 900);
  await scan('save as picker');
  await dismissDialogs(f);
  fs.writeFileSync(path.join(f.home, 'Pictures', 'abime.png'), 'xx');
  P(f, (p, el, a) => {
    p.openPath(a);
  }, path.join(f.home, 'Pictures', 'abime.png'));
  const [d] = await waitDialog(f);
  assert.ok(d.includes("Ce fichier n'est pas une image, ou il est endommagé."), d);
  await scan('error message');
  await dismissDialogs(f);
  assert.deepEqual([...found].map(([v, w]) => `${w}: ${v}`), [], 'English strings in the French UI');
});

await test('minimum window size in French: text/fill options, status bar and title fit without clipping', async () => {
  const id = await P(f, (p, el) => el.dataset.id);
  await f.aurora((wid) => {
    const w = window.__aurora.wm.get(wid);
    w.restore();
    w.setRect({ width: 300, height: 200 });
  }, id);
  await wait(f, 500);
  const rect = await f.aurora((wid) => window.__aurora.wm.get(wid).rect(), id);
  assert.deepEqual([rect.width, rect.height], [560, 380], 'manifest minimum size');
  const check = () =>
    P(f, (p, el) => {
      const wr = el.getBoundingClientRect();
      const out = [];
      for (const sel of ['.pt-ctxbar', '.pt-status', '.pt-cmdbar']) {
        const bar = el.querySelector(sel);
        if (!bar || bar.hidden) continue;
        const br = bar.getBoundingClientRect();
        if (bar.scrollWidth > bar.clientWidth + 1) out.push(`${sel} overflows by ${bar.scrollWidth - bar.clientWidth}px`);
        for (const x of bar.querySelectorAll('button, input, select, .segmented, span')) {
          if (x.offsetParent === null || x.closest('[hidden]') || x.closest('.pt-g.compact .pt-g-body')) continue;
          const r = x.getBoundingClientRect();
          if (!r.width) continue;
          if (r.right > Math.min(br.right, wr.right) + 1 || r.left < br.left - 1) out.push(`${sel} ${x.className || x.tagName} "${x.textContent.trim().slice(0, 20)}" cut off`);
        }
      }
      const tt = el.querySelector('.pt-doctitle');
      if (!tt.classList.contains('tiny') && tt.scrollWidth > tt.clientWidth + 1 && tt.clientWidth < 72) out.push('title cut to a few letters');
      return out;
    });
  for (const t of ['text', 'fill', 'pencil']) {
    await P(f, (p, el, a) => p.app.setTool(a), t);
    await wait(f, 350);
    assert.deepEqual(await check(), [], `tool ${t}`);
    if (t === 'text') await f.shot('paint-min-fr-text');
  }
  // every text option is still reachable
  await P(f, (p) => p.app.setTool('text'));
  await wait(f, 300);
  const seg = await f.page.locator(`${WIN} .pt-ctxbar .segmented button`).last().boundingBox();
  const win = await f.page.locator(WIN).boundingBox();
  assert.ok(seg && seg.x + seg.width <= win.x + win.width, 'background option inside the window');
  await f.page.locator(`${WIN} .pt-ctxbar .segmented button`).last().click();
  assert.equal(await P(f, (p) => p.S.text.opaque), true);
  await f.page.locator(`${WIN} .pt-ctxbar .segmented button`).first().click();
  await P(f, (p) => p.app.setTool('pencil'));
  await f.aurora((wid) => window.__aurora.wm.get(wid).maximize(), id);
  await wait(f, 500);
  assert.deepEqual(await check(), [], 'maximized');
  assert.equal(await P(f, (p, el) => el.querySelector('.pt-doctitle').classList.contains('tiny')), false, 'title visible when maximized');
  assert.deepEqual(await errorsOf(f), []);
});

await f.close();

// ================================================================== high-DPI (shell scale 200 %)
const hd = await launchShell({ open: ['paint'], lang: 'en', theme: 'light', settings: { scale: 200 } });
current = hd;
await hd.page.waitForSelector(`${WIN} .pt-doc`, { timeout: 30000 });
await wait(hd, 800);
await test('high-DPI: at 100 % one image pixel is one device pixel, and strokes land on the right pixels', async () => {
  await P(hd, (p, el) => window.__aurora.wm.get(el.dataset.id).maximize());
  await wait(hd, 400);
  const info = await P(hd, (p, el) => {
    p.setZoom(1);
    const r = el.querySelector('.pt-doc').getBoundingClientRect();
    return { dpr: devicePixelRatio, cssW: r.width, zoomTxt: el.querySelector('.pt-zoom-txt').textContent };
  });
  assert.equal(info.dpr, 2);
  assert.equal(info.cssW, 576, '1152 image px = 576 CSS px = 1152 device px');
  assert.equal(info.zoomTxt, '100%');
  await tool(hd, 'pencil');
  await drag(hd, [[50, 60], [150, 60]]);
  assert.deepEqual(await px(hd, 100, 60), [0, 0, 0, 255]);
  assert.ok(isWhite(await px(hd, 100, 62)));
  await hd.shot('paint-hidpi');
  assert.deepEqual(await errorsOf(hd), []);
});
await hd.close();

// ================================================================== damaged preferences
{
  const prefHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-paint-prefs-'));
  const dir = path.join(prefHome, '.config', 'aurora', 'apps', 'paint');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'prefs.json'),
    JSON.stringify({ tool: 'shape', shape: 'bogus<script>', outline: 'bogus', fill: { x: 1 }, sizes: { shape: 'abc', brush: 1e9 }, primary: 'red', secondary: '#12345', custom: ['#zzzzzz', 7], text: { family: 'x'.repeat(500), sizePt: -5, bold: 'yes' }, tolerance: 'lots' }),
  );
  fs.writeFileSync(path.join(dir, 'recent.json'), JSON.stringify(['/nope.png', 42, { a: 1 }, null]));
  const pr = await launchShell({ open: ['paint'], lang: 'en', theme: 'light', home: prefHome });
  current = pr;
  await pr.page.waitForSelector(`${WIN} .pt-doc`, { timeout: 30000 });
  await wait(pr, 600);
  await test('damaged stored preferences fall back to defaults and drawing still works', async () => {
    const st = await P(pr, (p) => ({ tool: p.S.tool, shape: p.S.shape, outline: p.S.outline, fill: p.S.fill, sizes: p.S.sizes, primary: p.S.primary, secondary: p.S.secondary, family: p.S.text.family, sizePt: p.S.text.sizePt, tol: p.S.tolerance, recent: p.app.recent() }));
    assert.equal(st.tool, 'shape');
    assert.equal(st.shape, 'rect');
    assert.equal(st.outline, 'solid');
    assert.equal(st.fill, 'none');
    assert.deepEqual(st.sizes, { pencil: 1, brush: 50, eraser: 10, shape: 3 });
    assert.equal(st.primary, '#000000');
    assert.equal(st.secondary, '#ffffff');
    assert.ok(st.family.length < 120);
    assert.equal(st.sizePt, 24);
    assert.equal(st.tol, 12);
    assert.deepEqual(st.recent, ['/nope.png']);
    await drag(pr, [[100, 100], [220, 180]]);
    await P(pr, (p) => p.commitPending());
    assert.ok((await nonWhite(pr, 95, 95, 130, 90)) > 100, 'rectangle drawn');
    assert.deepEqual(await errorsOf(pr), []);
  });
  await pr.close();
  fs.rmSync(prefHome, { recursive: true, force: true });
}

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
