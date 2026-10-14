// « Loupe » — full-screen magnifier (core/features/magnifier.js, main/ipc/magnifier.js, the X11 parts in
// core/features/xwin.js, main/ipc/xwin.js and helpers/aurora-xwm).
//   PATH=…/xvfb/pkg/usr/bin:$PATH xvfb-run -a -s "-screen 0 1600x900x24" node test/magnifier.test.mjs
//
// Part 1 (always): shortcuts, zoom levels, proportional pointer tracking, clicks / drags / menus at the right place
// at 300 %, Ctrl+Alt+wheel, toolbar, focus and caret following, reduced motion, lock screen, Settings and Réglages
// rapides round trips, start at sign-in, exact restore, screenshots en / fr × light / dark.
// Part 2 (when python3-xlib is importable, from the system or $AURORA_PYLIB / ~/.cache/selene-dev/pylib): the real
// aurora-xwm with a python-xlib test client (test/fixtures/magnifier/xclient.py: a known colour grid, logs its
// clicks) and XTest (fixtures/magnifier/xctl.py): live copy, a click at 300 % reaching the right pixel of the X
// window, no pointer input while the view follows the focus or the lock screen is up, Ctrl+Alt+wheel and Super+=
// through the helper's grabs, minimise / restore / close while magnified, exact restore of the cut and input shape.
//
// The shell is forced onto X11 (Xvfb): with WAYLAND_DISPLAY set, Electron would open on the host's Wayland session.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { launchShell, ROOT } from './lib.mjs';

const require = createRequire(import.meta.url);
let passed = 0;
let failed = 0;
function check(ok, name, extra = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && extra ? ` — ${extra}` : ''}`);
  return !!ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 4000, step = 50) {
  const end = Date.now() + ms;
  for (;;) {
    let v;
    try {
      v = await fn();
    } catch {
      v = null;
    }
    if (v) return v;
    if (Date.now() > end) return v;
    await sleep(step);
  }
}
const near = (a, b, tol = 1.5) => Math.abs(a - b) <= tol;
const ENV = { ELECTRON_OZONE_PLATFORM_HINT: 'x11', XDG_SESSION_TYPE: 'x11' };
const ARGS = ['--ozone-platform=x11'];

// ------------------------------------------------------------------ unit: key names and the catalog
{
  const hk = require('../main/lib/hotkeys.js');
  const combos = {
    'Super+=': { meta: true, key: '=', code: 'Equal' },
    'Super++': { meta: true, key: '+', code: 'NumpadAdd' },
    'Super+Shift++': { meta: true, shift: true, key: '+', code: 'Equal' },
    'Super+-': { meta: true, key: '-', code: 'Minus' },
    'Super+Escape': { meta: true, key: 'Escape', code: 'Escape' },
    'Super+Ctrl+M': { meta: true, control: true, key: 'm', code: 'KeyM' },
  };
  const got = Object.entries(combos).map(([want, input]) => [want, hk.comboOf(input), hk.isSystem(hk.comboOf(input), input)]);
  check(got.every(([w, c, sys]) => w === c && sys), 'main/lib/hotkeys.js names and forwards Super+= / Super++ (keypad) / Super+Shift++ / Super+- / Super+Escape / Super+Ctrl+M', JSON.stringify(got));
  const sc = await import('../renderer/core/shortcuts.js');
  const ids = { magnifierZoomIn: 'Super+=', magnifierZoomOut: 'Super+-', magnifierStop: 'Super+Escape', magnifierSettings: 'Super+Ctrl+M' };
  const entries = Object.keys(ids).map((id) => sc.SHORTCUTS.find((s) => s.id === id));
  check(entries.every((s, i) => s && s.combo === Object.values(ids)[i] && sc.validCombo(s.combo) && s.name.fr && s.name.en), 'catalog: the four Loupe shortcuts with their default combos, valid, named in en + fr');
  const defaults = sc.SHORTCUTS.map((s) => s.combo).filter(Boolean);
  check(defaults.length === new Set(defaults).size, 'catalog: no default combo is used twice', defaults.filter((c, i) => defaults.indexOf(c) !== i).join(', '));
  check(sc.comboKeys('Super+Escape', 'fr').join(' + ') === 'Super + Échap', 'catalog: Super + Échap in French');
}

// ------------------------------------------------------------------ part 1
const s = await launchShell({ open: ['calculator'], env: ENV, args: ARGS, settings: { theme: 'dark', lang: 'en' } });
const { page } = s;
const A = (fn, arg) => s.aurora(fn, arg);
const view = () => A(() => window.__aurora.magnifier.view());
const zoom = () => A(() => window.__aurora.magnifier.zoom);
const mag = () => A(() => window.__aurora.settings.get('magnifier') || {});
const hotkey = (combo) => A((c) => window.__aurora.hotkeys.trigger(c), combo);
// a combo as main sends it (shell:hotkey), e.g. while locked
const fromMain = (combo) =>
  s.app.evaluate(({ BrowserWindow }, c) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('aurora:event', 'shell:hotkey', { combo: c, repeat: false });
  }, combo);
const settle = async () => {
  await sleep(60);
  await waitFor(async () => {
    const v = await view();
    return !v.magnified || Math.abs(v.z - (await zoom()) / 100) < 1e-6;
  }, 2000);
};
const rectOf = (sel) => A((q) => document.querySelector(q)?.getBoundingClientRect().toJSON() || null, sel);
const center = (r) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
const CALC = '.app-calculator';
const result = async () => (await page.textContent(`${CALC} .calc-result`)).trim();

try {
  await page.waitForSelector(`${CALC} [data-key="7"]`, { timeout: 20000 });
  check(await A(() => !!window.__aurora.magnifier && !window.__aurora.magnifier.active), 'feature mounted, off at start');

  // what « stop restores everything » is compared with
  const snapshot = () =>
    A(() => {
      const d = (o, n) => Object.getOwnPropertyDescriptor(o, n);
      const html = document.documentElement;
      const cs = getComputedStyle(html);
      const bs = getComputedStyle(document.body);
      return {
        htmlTransform: html.style.transform,
        htmlWill: html.style.willChange,
        bodyStyle: document.body.getAttribute('style'),
        htmlClass: html.className,
        computed: [cs.transform, cs.willChange, bs.transform, bs.filter, bs.imageRendering].join('|'),
        protos: [d(MouseEvent.prototype, 'clientX').get, d(MouseEvent.prototype, 'pageY').get, d(MouseEvent.prototype, 'screenX').get, Element.prototype.getBoundingClientRect, Element.prototype.getClientRects, Range.prototype.getBoundingClientRect, Document.prototype.elementFromPoint, SVGGraphicsElement.prototype.getScreenCTM].map((f) => f?.toString().slice(0, 60)),
        native: [d(MouseEvent.prototype, 'clientX').get, Element.prototype.getBoundingClientRect, Document.prototype.elementFromPoint].every((f) => /\[native code\]/.test(Function.prototype.toString.call(f))),
      };
    });
  const before = await snapshot();
  check(before.native, 'DOM accessors are native before the magnifier starts');

  // bindings, incl. the keypad and Shift aliases
  const bind = await A(() => window.__aurora.hotkeys.bindings);
  const wantBind = { 'Super+=': 'magnifierZoomIn', 'Super++': 'magnifierZoomIn', 'Super+Shift++': 'magnifierZoomIn', 'Super+Shift+=': 'magnifierZoomIn', 'Super+-': 'magnifierZoomOut', 'Super+Shift+_': 'magnifierZoomOut', 'Super+Shift+-': 'magnifierZoomOut', 'Super+Escape': 'magnifierStop', 'Super+Ctrl+M': 'magnifierSettings' };
  check(Object.entries(wantBind).every(([c, id]) => bind[c] === id), 'hotkeys: Super+= / keypad + / Shift+= zoom in, Super+- / keypad - / Shift+- zoom out, Super+Escape stops, Super+Ctrl+M settings', JSON.stringify(Object.fromEntries(Object.keys(wantBind).map((c) => [c, bind[c]]))));

  // ---- start with the shortcut (the real keys through the X server and main/lib/hotkeys.js: part 2, XTest)
  await page.mouse.move(800, 450);
  await hotkey('Super+=');
  await waitFor(() => A(() => window.__aurora.magnifier.active));
  await settle();
  let v = await view();
  check(v.magnified && near(v.z, 2), `Super+= starts the magnifier at the saved level (200 %): z=${v.z}`);
  check((await mag()).enabled === true, 'settings.magnifier.enabled follows (true)');
  const st = await A(() => ({ html: document.documentElement.style.transform, body: document.body.style.transform, pos: getComputedStyle(document.body).position, tb: window.__aurora.magnifier.toolbar.matches(':popover-open'), live: document.querySelector('.mag-live')?.textContent }));
  check(st.html === '' && st.body === `translate(${v.tx}px, ${v.ty}px) scale(2)` && st.pos === 'fixed', `<body> fixed, translated and scaled (${st.body})`);
  check(st.tb, 'the toolbar shows when the magnifier starts');
  check(await waitFor(() => A(() => /Magnifier on, 200\s?%/.test(document.querySelector('.mag-live')?.textContent || ''))), 'announced to screen readers: « Magnifier on, 200% »');

  // ---- zoom levels (step 100 by default; keypad keys through main)
  await hotkey('Super+=');
  await settle();
  check((await zoom()) === 300, `Super+= -> 300 % (${await zoom()})`);
  await hotkey('Super++');
  await settle();
  check((await zoom()) === 400, `Super + keypad + -> 400 % (${await zoom()})`);
  await hotkey('Super+-');
  await settle();
  check((await zoom()) === 300, `Super+- -> 300 % (${await zoom()})`);
  await hotkey('Super+Shift+_');
  await settle();
  check((await zoom()) === 200, `Super+Shift+- (QWERTY « _ ») -> 200 % (${await zoom()})`);
  await A(() => window.__aurora.settings.set('magnifier.step', 50));
  await hotkey('Super+=');
  await settle();
  check((await zoom()) === 250, `increment 50 %: 200 -> 250 % (${await zoom()})`);
  await A(() => window.__aurora.settings.set('magnifier.step', 25));
  await hotkey('Super+Shift++');
  await settle();
  check((await zoom()) === 275, `increment 25 %: Super+Shift++ -> 275 % (${await zoom()})`);
  check(await waitFor(async () => (await mag()).zoom === 275, 2000), 'the level is saved (settings.magnifier.zoom = 275)');
  await A(() => window.__aurora.magnifier.setZoom(1600));
  await settle();
  await hotkey('Super+=');
  await settle();
  check((await zoom()) === 1600 && near((await view()).z, 16), 'at most 1600 %');
  check(await A(() => window.__aurora.magnifier.toolbar.querySelector('[data-act="in"]').disabled), 'toolbar: zoom in disabled at 1600 %');
  await A(() => window.__aurora.magnifier.setZoom(125));
  await settle();
  await hotkey('Super+-');
  await settle();
  await hotkey('Super+-');
  await settle();
  v = await view();
  check((await zoom()) === 100 && v.z === 1 && (await A(() => window.__aurora.magnifier.active)), 'down to 100 % (still on, like Windows)');
  check((await A(() => document.documentElement.style.transform + document.body.style.transform)) === '', 'at 100 % nothing is transformed');
  await A(() => window.__aurora.settings.set('magnifier.step', 100));

  // ---- reduced motion: zoom steps are instant; with animations they take a few frames
  await A(() => window.__aurora.magnifier.setZoom(200));
  await settle();
  await A(() => window.__aurora.settings.set('animations', false));
  await waitFor(() => A(() => document.documentElement.dataset.animations === 'off'));
  const inst = await A(() => {
    window.__aurora.hotkeys.trigger('Super+=');
    return window.__aurora.magnifier.view().z;
  });
  check(near(inst, 3, 1e-6), `reduced motion: the zoom changes at once (z=${inst})`);
  await A(() => window.__aurora.settings.set('animations', true));
  await waitFor(() => A(() => document.documentElement.dataset.animations !== 'off'));
  const anim = await A(() => {
    window.__aurora.hotkeys.trigger('Super+-');
    return window.__aurora.magnifier.view().z;
  });
  await settle();
  check(anim > 2.01 && near((await view()).z, 2, 1e-6), `with animations the zoom eases (z=${anim} right after, then 2)`);

  // ---- pointer tracking (proportional): the point under the pointer is drawn where it is
  await A(() => window.__aurora.magnifier.setZoom(300));
  await settle();
  await page.mouse.move(1200, 200, { steps: 4 });
  await sleep(80);
  v = await view();
  const under = await A(() => window.__aurora.magnifier.toScreen(new DOMRect(1200, 200, 0, 0)).toJSON());
  check(near(v.x, 1200 * (2 / 3), 0.5) && near(v.y, 200 * (2 / 3), 0.5) && v.mode === 'pointer' && v.exact, `view origin = P × (1 − 1/z) (${v.x.toFixed(1)}, ${v.y.toFixed(1)})`);
  check(near(under.x, 1200, 1) && near(under.y, 200, 1), `the page point under the pointer is drawn at the pointer (${under.x}, ${under.y})`);
  await page.mouse.move(10, 880, { steps: 4 });
  await sleep(80);
  v = await view();
  check(near(v.x, 10 * (2 / 3), 0.5) && near(v.y, 880 * (2 / 3), 0.5), 'the view follows to the bottom-left corner');

  // ---- clicks at 300 %: the button under the pointer is the one activated
  await A(() => document.querySelector('.app-calculator [data-key="clear"]')?.click());
  const r7 = await rectOf(`${CALC} [data-key="7"]`);
  const c7 = center(r7);
  await A(() => {
    window.__magDown = null;
    document.querySelector('.app-calculator [data-key="7"]').addEventListener('pointerdown', (e) => (window.__magDown = { x: e.clientX, y: e.clientY, sx: e.screenX }), { once: true });
  });
  await page.mouse.move(c7.x - 30, c7.y - 30, { steps: 3 });
  await page.mouse.click(c7.x, c7.y);
  await sleep(120);
  check((await result()) === '7', `at 300 % a click on the « 7 » key types 7 (${await result()})`);
  const down = await A(() => window.__magDown);
  check(down && near(down.x, c7.x, 1.5) && near(down.y, c7.y, 1.5), `events give page coordinates (clientX ${down?.x?.toFixed(1)} ≈ ${c7.x.toFixed(1)})`);
  const shown7 = await A((r) => window.__aurora.magnifier.toScreen(new DOMRect(r.x, r.y, r.width, r.height)).toJSON(), r7);
  check(near(shown7.width, r7.width * 3, 1) && near(shown7.height, r7.height * 3, 1), `the key is drawn 3 × larger (${shown7.width.toFixed(0)} × ${shown7.height.toFixed(0)} px)`);
  const c8 = center(await rectOf(`${CALC} [data-key="8"]`));
  await page.mouse.click(c8.x, c8.y);
  await sleep(120);
  check((await result()) === '78', `then « 8 » (${await result()})`);
  // elementFromPoint takes page coordinates too
  const hit = await A((p) => document.elementFromPoint(p.x, p.y)?.closest('[data-key]')?.dataset.key, c8);
  check(hit === '8', `document.elementFromPoint(page point) finds the key (${hit})`);
  // pointer following off: the view stays; clicking where the key is drawn still types it
  await A(() => window.__aurora.settings.set('magnifier.followPointer', false));
  await sleep(100);
  const v0 = await view();
  const r9 = await rectOf(`${CALC} [data-key="9"]`);
  const s9 = await A((r) => window.__aurora.magnifier.toScreen(new DOMRect(r.x, r.y, r.width, r.height)).toJSON(), r9);
  const p9 = center(s9);
  check(p9.x > 0 && p9.y > 0 && p9.x < 1600 && p9.y < 900, `pointer following off: the « 9 » key is on screen at (${p9.x.toFixed(0)}, ${p9.y.toFixed(0)})`);
  await page.mouse.click(p9.x, p9.y);
  await sleep(120);
  const v1 = await view();
  check((await result()) === '789' && v1.x === v0.x && v1.y === v0.y && v1.mode === 'static' && !v1.exact, `… a click where it is drawn types 9, the view did not move (${await result()})`);
  await A(() => window.__aurora.settings.set('magnifier.followPointer', true));

  // ---- drag a window at 300 %: the title bar stays under the pointer
  const win0 = await A(() => {
    const w = window.__aurora.wm.list().find((x) => x.appId === 'calculator');
    return { x: w.x, y: w.y };
  });
  const tb = await rectOf(`.win[data-app="calculator"] .win-title, ${CALC}`);
  const tr = await A(() => {
    const w = window.__aurora.wm.list().find((x) => x.appId === 'calculator');
    return w.titleEl.getBoundingClientRect().toJSON();
  });
  const g = { x: tr.x + Math.min(30, tr.width / 2), y: tr.y + tr.height / 2 };
  await page.mouse.move(g.x, g.y, { steps: 3 });
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(g.x + i * 10, g.y + i * 7);
  await page.mouse.up();
  await sleep(150);
  const win1 = await A(() => {
    const w = window.__aurora.wm.list().find((x) => x.appId === 'calculator');
    return { x: w.x, y: w.y };
  });
  check(tb && near(win1.x - win0.x, 60, 3) && near(win1.y - win0.y, 42, 3), `drag at 300 %: the window moves with the pointer (Δ ${win1.x - win0.x}, ${win1.y - win0.y} for 60, 42)`);

  // ---- a context menu opens at the pointer
  const dpt = { x: 140, y: 300 };
  await page.mouse.move(dpt.x, dpt.y, { steps: 2 });
  await page.mouse.click(dpt.x, dpt.y, { button: 'right' });
  const menu = await waitFor(() => rectOf('body > .menu'), 2000);
  check(menu && near(menu.x, dpt.x, 6) && near(menu.y, dpt.y, 6), `right click at 300 %: the menu opens at the pointer (${menu?.x?.toFixed(0)}, ${menu?.y?.toFixed(0)})`);
  await page.keyboard.press('Escape');
  await sleep(150);

  // ---- Ctrl+Alt+wheel
  await page.mouse.move(700, 400, { steps: 2 });
  await page.keyboard.down('Control');
  await page.keyboard.down('Alt');
  await page.mouse.wheel(0, -120);
  await sleep(60);
  await page.keyboard.up('Alt');
  await page.keyboard.up('Control');
  await settle();
  check((await zoom()) === 400, `Ctrl+Alt+wheel up: 400 % (${await zoom()})`);
  await page.keyboard.down('Control');
  await page.keyboard.down('Alt');
  await page.mouse.wheel(0, 120);
  await sleep(60);
  await page.keyboard.up('Alt');
  await page.keyboard.up('Control');
  await settle();
  check((await zoom()) === 300, `Ctrl+Alt+wheel down: 300 % (${await zoom()})`);
  await page.mouse.wheel(0, -120);
  await settle();
  check((await zoom()) === 300, 'the wheel alone does not zoom');

  // ---- toolbar
  const tbr = await A(() => window.__aurora.magnifier.toolbar.getBoundingClientRect().toJSON());
  check(tbr.width > 150 && tbr.width < 420 && tbr.y >= 4 && tbr.y < 30 && near(tbr.x + tbr.width / 2, 800, 2), `toolbar: unmagnified, top centre (${tbr.width.toFixed(0)} × ${tbr.height.toFixed(0)} at ${tbr.x.toFixed(0)}, ${tbr.y.toFixed(0)})`);
  const labels = await A(() => [...window.__aurora.magnifier.toolbar.querySelectorAll('.mag-btn')].map((b) => b.getAttribute('aria-label')));
  check(labels.join('|') === 'Zoom out (Super + -)|Zoom in (Super + =)|Magnifier settings (Super + Ctrl + M)|Hide the toolbar|Turn off the magnifier (Super + Esc)', `toolbar buttons named with their shortcuts: ${labels.join(' | ')}`);
  const btnAt = (act) => A((a) => window.__aurora.magnifier.toolbar.querySelector(`[data-act="${a}"]`).getBoundingClientRect().toJSON(), act);
  let b = center(await btnAt('in'));
  await page.mouse.click(b.x, b.y);
  await settle();
  check((await zoom()) === 400, `toolbar + -> 400 % (${await zoom()})`);
  check(/400\s?%/.test(await A(() => window.__aurora.magnifier.toolbar.querySelector('.mag-level').textContent)), 'toolbar shows the level');
  b = center(await btnAt('out'));
  await page.mouse.click(b.x, b.y);
  await settle();
  check((await zoom()) === 300, `toolbar − -> 300 % (${await zoom()})`);
  check(await A(() => !window.__aurora.magnifier.toolbar.contains(document.activeElement)), 'a click on the toolbar does not take the keyboard focus');
  // keyboard in the toolbar
  const kb = await A(() => {
    const t = window.__aurora.magnifier.toolbar;
    t.querySelector('[data-act="in"]').focus();
    t.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    const a = document.activeElement?.dataset.act;
    t.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    const e = document.activeElement?.dataset.act;
    t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return [a, e, t.contains(document.activeElement)];
  });
  check(kb[0] === 'settings' && kb[1] === 'close' && kb[2] === false, `toolbar keys: → moves, End goes to the last, Escape leaves (${kb})`);
  await page.screenshot({ path: path.join(ROOT, 'test', 'out', 'magnifier-en-dark.png') });
  // hide
  b = center(await btnAt('hide'));
  await page.mouse.click(b.x, b.y);
  check(await waitFor(async () => (await mag()).toolbar === false && !(await A(() => window.__aurora.magnifier.toolbar.matches(':popover-open')))), 'hide: settings.magnifier.toolbar = false, toolbar gone');
  await hotkey('Super+=');
  check(await waitFor(() => A(() => document.querySelector('.mag-pill')?.matches(':popover-open') && /400/.test(document.querySelector('.mag-pill').textContent))), 'toolbar hidden: zoom changes show a small pill (400 %)');
  await page.screenshot({ path: path.join(ROOT, 'test', 'out', 'magnifier-pill-en-dark.png') });
  await A(() => window.__aurora.settings.set('magnifier.toolbar', true));
  check(await waitFor(() => A(() => window.__aurora.magnifier.toolbar.matches(':popover-open'))), 'toolbar back from the settings key');
  await hotkey('Super+-');
  await settle();
  // settings button and Super+Ctrl+M
  b = center(await btnAt('settings'));
  await page.mouse.click(b.x, b.y);
  check(await waitFor(() => A(() => !!document.querySelector('.app-settings .st-magnifier')), 8000), 'toolbar settings button: Paramètres open on Loupe');
  await A(() => window.__aurora.wm.list().filter((w) => w.appId === 'settings').forEach((w) => w.close(true)));
  await sleep(400);
  await hotkey('Super+Ctrl+M');
  check(await waitFor(() => A(() => !!document.querySelector('.app-settings .st-magnifier')), 8000), 'Super+Ctrl+M opens the same page');
  await A(() => window.__aurora.wm.list().filter((w) => w.appId === 'settings').forEach((w) => w.close(true)));
  await sleep(400);

  // ---- keyboard focus and text caret
  await A(() => window.__aurora.magnifier.setZoom(400));
  await page.mouse.move(60, 60, { steps: 3 });
  await sleep(650); // older than the last click: a keyboard focus change
  const eq = await A(async () => {
    const el = document.querySelector('.app-calculator [data-key="equals"]');
    el.focus();
    await new Promise((r) => setTimeout(r, 120));
    const r = el.getBoundingClientRect();
    const m = window.__aurora.magnifier.view();
    const vw = innerWidth / m.z;
    const vh = innerHeight / m.z;
    return { key: el.dataset.key, inside: r.left >= m.x && r.right <= m.x + vw && r.top >= m.y && r.bottom <= m.y + vh, mode: m.mode, exact: m.exact };
  });
  check(eq.inside && eq.mode === 'focus' && !eq.exact, `focus following: the focused key (${eq.key}) is brought into view (mode ${eq.mode})`);
  await page.mouse.move(62, 61);
  await sleep(60);
  check((await view()).mode === 'focus', 'a 2 px pointer jitter keeps the focus in view');
  await page.mouse.move(90, 90, { steps: 2 });
  await sleep(60);
  v = await view();
  check(v.mode === 'pointer' && v.exact && near(v.x, 90 * 0.75, 0.5), 'moving the pointer brings the view back to it');
  // caret: type a long line in the Text Editor
  await A(() => window.__aurora.registry.launch('notepad'));
  const ta = await waitFor(() => A(() => !!document.querySelector('.app-notepad textarea')), 8000);
  await sleep(500);
  await A(() => {
    const t = document.querySelector('.app-notepad textarea');
    t.focus();
  });
  await sleep(700);
  const vx0 = (await view()).x;
  await page.keyboard.type('Selene magnifier follows the text caret while you type a long line of text ', { delay: 4 });
  await sleep(200);
  const caret = await A(() => {
    const t = document.querySelector('.app-notepad textarea');
    const m = window.__aurora.magnifier.view();
    const r = t.getBoundingClientRect();
    const vw = innerWidth / m.z;
    // the caret is near the end of the typed text: somewhere right of the field's start, inside the view
    return { mode: m.mode, x: m.x, vw, left: r.left, len: t.value.length };
  });
  check(ta && caret.len > 60 && caret.mode === 'focus', `caret following: the view follows the typing (mode ${caret.mode}, ${caret.len} characters)`);
  check(caret.x > vx0 + 40 && caret.x > caret.left, `… and has moved right along the line (view x ${vx0.toFixed(0)} -> ${caret.x.toFixed(0)}; field starts at ${caret.left.toFixed(0)})`);
  await A(() => window.__aurora.wm.list().filter((w) => w.appId === 'notepad').forEach((w) => w.close(true)));
  await sleep(400);
  await page.mouse.move(500, 400, { steps: 2 });

  // ---- lock screen: stays magnified, toolbar hidden, zoom keys work, nothing else
  await A(() => window.__aurora.magnifier.setZoom(300));
  await settle();
  const nSettings = await A(() => window.__aurora.wm.list().filter((w) => w.appId === 'settings').length);
  await A(() => window.__aurora.shell.lock());
  await waitFor(() => A(() => document.body.classList.contains('aurora-locked')));
  await sleep(500);
  const lk = await A(() => ({ mag: window.__aurora.magnifier.view().magnified, tb: window.__aurora.magnifier.toolbar.matches(':popover-open'), tr: document.body.style.transform }));
  check(lk.mag && !lk.tb && !!lk.tr, `locked: still magnified, toolbar hidden (${lk.tr})`);
  await fromMain('Super+=');
  await settle();
  check((await zoom()) === 400, `locked: Super+= still zooms (${await zoom()})`);
  await fromMain('Super+Ctrl+M');
  await sleep(600);
  check((await A(() => window.__aurora.wm.list().filter((w) => w.appId === 'settings').length)) === nSettings, 'locked: Super+Ctrl+M opens nothing');
  const clock = await rectOf('.lk-time');
  if (clock) await page.mouse.move(clock.x + clock.width / 2, clock.y + clock.height / 2, { steps: 3 });
  await sleep(200);
  await page.screenshot({ path: path.join(ROOT, 'test', 'out', 'magnifier-lock-en-dark.png') });
  await fromMain('Super+Escape');
  check(await waitFor(async () => !(await A(() => window.__aurora.magnifier.active))), 'locked: Super+Escape turns it off');
  // the lock screen's accessibility menu turns it on (plain clicks: not magnified now)
  await page.mouse.click(800, 450); // the picture gives way to the sign-in view and its tray
  await waitFor(() => A(() => !document.querySelector('.lockui')?.classList.contains('stage-curtain')), 3000);
  await sleep(400);
  await page.click('.lk-a11y');
  const item = page.locator('.menu.lk-menu .menu-item', { hasText: 'Magnifier' });
  await item.first().waitFor({ timeout: 3000 });
  await item.first().click();
  check(await waitFor(() => A(() => window.__aurora.magnifier.active && document.body.classList.contains('aurora-locked'))), 'locked: the lock screen\'s Accessibility menu has « Magnifier » and starts it');
  check(!(await A(() => window.__aurora.magnifier.toolbar.matches(':popover-open'))), 'locked: still no toolbar');
  await A(() => window.__aurora.shell.emit('unlock'));
  check(await waitFor(() => A(() => window.__aurora.magnifier.toolbar.matches(':popover-open'))), 'unlocked: the toolbar is back');

  // ---- invert colours, smoothing (live)
  await A(() => window.__aurora.settings.set('magnifier.invert', true));
  await A(() => window.__aurora.settings.set('magnifier.smoothing', false));
  await sleep(150);
  const look = await A(() => ({ f: getComputedStyle(document.body).filter, ir: getComputedStyle(document.body).imageRendering }));
  check(look.f === 'invert(1)' && look.ir === 'pixelated', `invert colours and pixelated images apply live (${look.f}, ${look.ir})`);
  await page.screenshot({ path: path.join(ROOT, 'test', 'out', 'magnifier-invert-en-dark.png') });

  // ---- stop: everything back exactly
  await hotkey('Super+Escape');
  await sleep(200);
  const after = await snapshot();
  check(!(await A(() => window.__aurora.magnifier.active)) && (await mag()).enabled === false, 'Super+Escape stops it (settings.magnifier.enabled = false)');
  check(JSON.stringify(after) === JSON.stringify(before), 'stop restores everything exactly: styles, classes, computed transform / filter / image rendering, native DOM accessors', JSON.stringify({ before, after }));
  check(await A(() => !window.__aurora.magnifier.toolbar.matches(':popover-open') && !document.querySelector('.mag-mirror')), 'toolbar and copies gone');
  check(await waitFor(() => A(() => /Magnifier off/.test(document.querySelector('.mag-live')?.textContent || ''))), 'announced: « Magnifier off »');
  await A(() => Promise.all([window.__aurora.settings.set('magnifier.invert', false), window.__aurora.settings.set('magnifier.smoothing', true)]));

  // ---- Settings > Accessibility > Magnifier (the magnifier off: plain clicks)
  await A(() => window.__aurora.registry.launch('settings', { page: 'accessibility' }));
  await page.waitForSelector('.app-settings .st-row', { timeout: 15000 });
  await sleep(400);
  const a11yRow = await A(() => [...document.querySelectorAll('.app-settings .st-row')].some((r) => /^Magnifier/.test(r.textContent.trim()) && /Enlarge/.test(r.textContent)));
  check(a11yRow, 'Accessibility lists « Magnifier »');
  await A(() => window.__aurora.registry.launch('settings', { page: 'magnifier' }));
  await page.waitForSelector('.app-settings .st-magnifier', { timeout: 15000 });
  await sleep(400);
  const S = (sec) => `.app-settings .st-magnifier .st-row[data-section="${sec}"]`;
  for (const [sec, def] of [['followPointer', true], ['followFocus', true], ['followCaret', true], ['smoothing', true], ['invert', false], ['toolbar', true], ['startAtLogin', false]]) {
    const cur0 = await page.isChecked(`${S(sec)} input[role="switch"]`);
    await page.locator(`${S(sec)} .st-toggle`).click();
    const got1 = await waitFor(async () => (await mag())[sec] === !def && (await mag())[sec], 1500).then(async () => (await mag())[sec]);
    await page.locator(`${S(sec)} .st-toggle`).click();
    const got2 = await waitFor(async () => (await mag())[sec] === def, 1500).then(async () => (await mag())[sec]);
    check(cur0 === def && got1 === !def && got2 === def, `Settings: « ${sec} » switch round-trips (${def} -> ${got1} -> ${got2})`);
  }
  await page.locator(`${S('step')} .st-combo`).click();
  await page.locator('.st-combo-menu .menu-item', { hasText: '50' }).first().click();
  check(await waitFor(async () => (await mag()).step === 50), 'Settings: increment 50 % saved');
  const z0 = (await mag()).zoom ?? 200;
  await page.locator(`${S('zoom')} .st-mag-plus`).click();
  check(await waitFor(async () => (await mag()).zoom === z0 + 50), `Settings: + raises the saved level by the increment (${z0} -> ${(await mag()).zoom})`);
  await page.locator(`${S('zoom')} .st-mag-minus`).click();
  check(await waitFor(async () => (await mag()).zoom === z0), 'Settings: − lowers it back');
  check(/Super \+ =/.test(await page.textContent(S('shortcut'))) && /Ctrl \+ Alt/.test(await page.textContent(S('shortcut'))), 'Settings: the shortcuts are listed');
  await A(() => window.__aurora.settings.set('lang', 'en'));
  await page.screenshot({ path: path.join(ROOT, 'test', 'out', 'magnifier-settings-en-dark.png') });
  await page.locator(`${S('toggle')} .st-toggle`).click();
  check(await waitFor(() => A(() => window.__aurora.magnifier.active)), 'Settings: the main switch starts the magnifier');
  await hotkey('Super+Escape');
  check(await waitFor(async () => !(await A(() => window.__aurora.magnifier.active)) && !(await page.isChecked(`${S('toggle')} input[role="switch"]`))), 'stopping it turns the switch off');
  await A(() => window.__aurora.settings.set('magnifier.step', 100));
  const searchFr = (await import('../renderer/apps/settings/lib/index.js')).searchIndex('loupe', 'fr', 3).map((e) => e.page);
  check(searchFr[0] === 'magnifier', `Settings search « loupe » finds it (${searchFr})`);

  // ---- Réglages rapides > Accessibilité
  await A(() => window.__aurora.wm.list().filter((w) => w.appId === 'settings').forEach((w) => w.close(true)));
  await sleep(300);
  await A(() => window.__aurora.shell.emit('quick:toggle'));
  await page.waitForSelector('.qs-tile[data-key="accessibility"], [data-key="accessibility"]', { timeout: 5000 });
  await page.locator('[data-key="accessibility"] .qs-more, [data-key="accessibility"] button').last().click();
  await page.waitForSelector('.qs-a11y-row', { timeout: 5000 });
  const qrow = page.locator('.qs-a11y-row', { hasText: 'Magnifier' });
  check((await qrow.count()) === 1, 'Quick settings > Accessibility has a « Magnifier » switch');
  await qrow.locator('.toggle').click();
  check(await waitFor(() => A(() => window.__aurora.magnifier.active)), 'that switch starts it');
  await hotkey('Super+Escape');
  await waitFor(async () => !(await A(() => window.__aurora.magnifier.active)));
  await A(() => window.__aurora.shell.emit('flyouts:close'));
  await sleep(300);

  // ---- screenshots: light / dark × en / fr (magnified desktop with the toolbar, and the settings page)
  for (const [lang, theme] of [['en', 'light'], ['fr', 'light'], ['fr', 'dark']]) {
    await A((p) => Promise.all([window.__aurora.settings.set('lang', p.lang), window.__aurora.settings.set('theme', p.theme), window.__aurora.settings.set('magnifier.zoom', 200)]), { lang, theme });
    await sleep(500);
    await A(() => window.__aurora.registry.launch('settings', { page: 'magnifier' }));
    await page.waitForSelector('.app-settings .st-magnifier', { timeout: 15000 });
    await sleep(600);
    await page.screenshot({ path: path.join(ROOT, 'test', 'out', `magnifier-settings-${lang}-${theme}.png`) });
    await page.mouse.move(700, 300, { steps: 2 });
    await hotkey('Super+=');
    await settle();
    await hotkey('Super+=');
    await settle();
    await sleep(300);
    await page.screenshot({ path: path.join(ROOT, 'test', 'out', `magnifier-${lang}-${theme}.png`) });
    if (lang === 'fr' && theme === 'dark') {
      const fr = await A(() => [...window.__aurora.magnifier.toolbar.querySelectorAll('.mag-btn')].map((b) => b.getAttribute('aria-label')));
      check(fr.join('|') === 'Zoom arrière (Super + -)|Zoom avant (Super + =)|Paramètres de la loupe (Super + Ctrl + M)|Masquer la barre d’outils|Désactiver la loupe (Super + Échap)', `French toolbar: ${fr.join(' | ')}`);
      check(/300\s%/.test(await A(() => window.__aurora.magnifier.toolbar.querySelector('.mag-level').textContent)), 'French level « 300 % »');
    }
    await hotkey('Super+Escape');
    await sleep(200);
    await A(() => window.__aurora.wm.list().filter((w) => w.appId === 'settings').forEach((w) => w.close(true)));
    await sleep(300);
  }
  const errs = s.logs.filter((l) => /\[pageerror\]|\[error\].*magnifier/i.test(l));
  check(!errs.length, 'no page errors', errs.slice(0, 3).join(' / '));
} catch (err) {
  check(false, 'part 1 ran to the end', err.stack || String(err));
} finally {
  await s.close();
}

// ------------------------------------------------------------------ start at sign-in
{
  const s2 = await launchShell({ env: ENV, args: ARGS, settings: { magnifier: { enabled: true, startAtLogin: false } } });
  try {
    check(!(await s2.aurora(() => window.__aurora.magnifier.active)) && (await s2.aurora(() => window.__aurora.settings.get('magnifier.enabled'))) === false, 'a new session: on only when « Start at sign-in » is on (left on last time: off now)');
  } finally {
    await s2.close();
  }
  const s3 = await launchShell({ env: ENV, args: ARGS, settings: { magnifier: { startAtLogin: true, zoom: 300 } } });
  try {
    await waitFor(() => s3.aurora(() => window.__aurora.magnifier.view().z === 3), 4000);
    const v3 = await s3.aurora(() => ({ a: window.__aurora.magnifier.active, z: window.__aurora.magnifier.view().z, en: window.__aurora.settings.get('magnifier.enabled') }));
    check(v3.a && v3.z === 3 && v3.en === true, `« Start at sign-in »: on at 300 % when the session starts (${JSON.stringify(v3)})`);
    // a renderer reload in the same session (crash recovery) keeps it on
    await s3.page.reload();
    await s3.page.waitForSelector('body.ready', { timeout: 30000 });
    await waitFor(() => s3.aurora(() => window.__aurora.magnifier?.active), 4000);
    check(await s3.aurora(() => window.__aurora.magnifier.active), 'after a reload of the shell (same session) it is still on');
  } finally {
    await s3.close();
  }
}

// ------------------------------------------------------------------ part 2: Linux (X11) windows
const pylibCandidates = [process.env.AURORA_PYLIB, path.join(os.homedir(), '.cache', 'selene-dev', 'pylib')].filter(Boolean);
const hasXlib = (pp) => spawnSync('python3', ['-c', 'import Xlib.ext.xtest, Xlib.ext.shape'], { env: { ...process.env, ...(pp ? { PYTHONPATH: pp } : {}) } }).status === 0;
const PYLIB = hasXlib(null) ? null : pylibCandidates.find((p) => hasXlib(p));
const HELPER = path.join(ROOT, '..', 'rootfs', 'usr', 'lib', 'aurora', 'helpers', 'aurora-xwm');
if (!process.env.DISPLAY || (!PYLIB && !hasXlib(null)) || !fs.existsSync(HELPER)) {
  console.log('SKIP part 2 (Linux windows): no DISPLAY, python3-xlib or aurora-xwm');
} else {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-mag-'));
  const PYENV = { ...process.env, ...(PYLIB ? { PYTHONPATH: PYLIB } : {}) };
  // the helper runs `python3 -I` (ignores PYTHONPATH): a wrapper gives it the test copy of python3-xlib
  const wrap = path.join(tmp, 'aurora-xwm');
  fs.writeFileSync(wrap, `#!/bin/sh\n${PYLIB ? `PYTHONPATH='${PYLIB}' ` : ''}exec python3 '${HELPER}' "$@"\n`, { mode: 0o755 });
  const LOG = path.join(tmp, 'clicks.log');
  fs.writeFileSync(LOG, '');
  const XCTL = path.join(ROOT, 'test', 'fixtures', 'magnifier', 'xctl.py');
  const xctl = (...a) => execFileSync('python3', [XCTL, ...a.map(String)], { env: PYENV }).toString().trim();
  const presses = () =>
    fs
      .readFileSync(LOG, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  const x = await launchShell({ env: { ...ENV, AURORA_XWM: '1', AURORA_XWM_HELPER: wrap }, args: ARGS, settings: { magnifier: { zoom: 300 } } });
  let exited = null;
  x.app.process().on('exit', (code, sig) => (exited = `${code ?? sig}`));
  let client = null;
  try {
    const XA = (fn, arg) => x.aurora(fn, arg);
    check(await waitFor(() => XA(() => window.__aurora.api.invoke('xwin:status').then((st) => st.ready)), 8000), 'X11: aurora-xwm is managing (real helper, python3-xlib)');
    const shellXid = await x.app.evaluate(({ BrowserWindow }) => {
      const hnd = BrowserWindow.getAllWindows()[0].getNativeWindowHandle();
      return String(hnd.length >= 8 ? hnd.readBigUInt64LE(0) : hnd.readUInt32LE(0));
    });
    client = spawn('python3', [path.join(ROOT, 'test', 'fixtures', 'magnifier', 'xclient.py'), '--log', LOG, '--size', '400x300'], { env: PYENV, stdio: ['ignore', 'pipe', 'inherit'] });
    const xid = await waitFor(() => XA(() => [...window.__aurora.xwin.frames.keys()][0]), 8000);
    check(!!xid, 'X11: the test client gets a frame');
    await sleep(600);
    const content = await XA((id) => window.__aurora.xwin.frames.get(id).win.body.getBoundingClientRect().toJSON(), xid);
    const debug0 = await XA(() => window.__aurora.api.invoke('xwin:debug'));
    check(debug0.holes.length > 0, 'X11: not magnified, the shell is cut where the client is');
    // a point of cell (col 1, row 2) of the client's grid: rgb(90, 140, 200)
    const Q = { x: Math.round(content.x + content.width * 0.375), y: Math.round(content.y + content.height * 0.625) };
    const local = { x: Q.x - Math.round(content.x), y: Q.y - Math.round(content.y) };

    // magnify with the keyboard through the X server (the shell has focus): Super+=
    xctl('move', 700, 120);
    await sleep(200);
    xctl('key', 'Super_L', 'equal');
    check(await waitFor(() => XA(() => window.__aurora.magnifier.active && Math.abs(window.__aurora.magnifier.view().z - 3) < 1e-6), 3000), 'X11: Super+= (XTest) starts the magnifier at 300 %');
    xctl('key', 'Super_L', 'KP_Add');
    check(await waitFor(() => XA(() => window.__aurora.magnifier.zoom === 400), 3000), 'X11: Super + keypad + (XTest, the shell focused: Chromium -> main/lib/hotkeys.js) zooms in to 400 %');
    xctl('key', 'Super_L', 'minus');
    check(await waitFor(() => XA(() => window.__aurora.magnifier.zoom === 300), 3000), 'X11: Super+- (XTest) zooms out to 300 %');
    const m1 = await waitFor(() => XA(() => window.__aurora.magnifier.mirrors().find((m) => m.playing && m.width >= 380)), 6000);
    check(!!m1, `X11: a live copy of the client plays in its frame (${m1?.width}×${m1?.height})`);
    const debug1 = await XA(() => window.__aurora.api.invoke('xwin:debug'));
    check(Array.isArray(debug1.shape) && debug1.shape.length === 0 && debug1.holes.length === 0, 'X11: magnified, the shell is not cut any more');
    const bounding = JSON.parse(xctl('bounding', shellXid));
    // (Chromium's setShape leaves out the last column and row: 1599 × 899, as before the magnifier)
    check(bounding.length === 1 && bounding[0][2] >= 1599 && bounding[0][3] >= 899, `X11: the shell window's bounding shape is the whole window (${JSON.stringify(bounding)})`);

    // the pointer (real X pointer) over the copy: the view follows (main polls the pointer), the input shape lets it through
    xctl('move', Q.x, Q.y);
    const vq = await waitFor(async () => {
      const vv = await XA(() => window.__aurora.magnifier.view());
      return vv.pointer && near(vv.pointer.x, Q.x, 1) && near(vv.pointer.y, Q.y, 1) && vv.exact ? vv : null;
    }, 3000);
    check(!!vq, `X11: the view follows the real pointer over the Linux window (${JSON.stringify(vq?.pointer)})`);
    await sleep(400);
    const input = JSON.parse(xctl('input', shellXid));
    const inRects = (pt) => input.some(([rx, ry, rw, rh]) => pt.x >= rx && pt.x < rx + rw && pt.y >= ry && pt.y < ry + rh);
    check(!inRects(Q) && inRects({ x: 5, y: 5 }), 'X11: the input shape has a hole where the client really is, the shell keeps the rest');
    // what is drawn under the pointer is the client's pixel there
    const shot = path.join(tmp, 'q.png');
    await x.page.screenshot({ path: shot });
    const px = await XA(async (p) => {
      const img = new Image();
      img.src = p.url;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      return p.pts.map(([px0, py0]) => [...g.getImageData(px0, py0, 1, 1).data]);
    }, { url: `data:image/png;base64,${fs.readFileSync(shot).toString('base64')}`, pts: [[Q.x + 60, Q.y], [Q.x - 120, Q.y - 150]] });
    // (Chromium draws the client's own pointer into the copy, enlarged, right under the real one: sample beside it.)
    // screen point Q + d shows page point Q + d/3: Q + (20, 0) is in cell (1, 2), Q + (-40, -50) in cell (1, 1)
    const okPx = (p, rgb) => p && p.every((c, i) => i > 2 || Math.abs(c - rgb[i]) < 25);
    check(okPx(px[0], [90, 140, 200]) && okPx(px[1], [90, 90, 200]), `X11: at 300 % the copy shows the client's pixels where they belong around the pointer (rgb ${px[0]?.slice(0, 3)} / ${px[1]?.slice(0, 3)} for 90,140,200 / 90,90,200)`);
    await x.page.screenshot({ path: path.join(ROOT, 'test', 'out', 'magnifier-x11-300.png') });
    // a click at that place reaches the client at the same point
    fs.writeFileSync(LOG, '');
    xctl('click', Q.x, Q.y);
    const p1 = await waitFor(() => presses().find((p) => p.button === 1), 3000);
    check(p1 && near(p1.x, local.x, 2) && near(p1.y, local.y, 2), `X11: the click at 300 % lands on that point of the Linux window (${p1?.x}, ${p1?.y} for ${local.x}, ${local.y})`);

    // the view follows the keyboard focus: the client gets no pointer input until the pointer moves
    await sleep(700);
    await XA(async () => {
      const b = window.__aurora.xwin.frames.values().next().value.win;
      // a DOM control far from the pointer: the frame's close button
      b.el.querySelector('.win-controls button:last-child, .win-controls button')?.focus();
      await new Promise((r) => setTimeout(r, 50));
    });
    const vf = await waitFor(() => XA(() => (window.__aurora.magnifier.view().mode === 'focus' ? window.__aurora.magnifier.view() : null)), 2000);
    await sleep(300);
    const inputF = JSON.parse(xctl('input', shellXid));
    const holeF = !inputF.some(([rx, ry, rw, rh]) => Q.x >= rx && Q.x < rx + rw && Q.y >= ry && Q.y < ry + rh);
    check(vf && !vf.exact && !holeF, `X11: view following the focus: no input hole any more (mode ${vf?.mode})`);
    fs.writeFileSync(LOG, '');
    xctl('click', Q.x, Q.y); // no movement: the view is still on the focus
    await sleep(400);
    check(presses().length === 0, 'X11: … a click there does not reach the client (the shell takes it)');
    xctl('move', Q.x + 12, Q.y + 9);
    check(await waitFor(() => XA(() => window.__aurora.magnifier.view().exact), 3000), 'X11: moving the pointer makes the view exact again');
    await sleep(400);
    fs.writeFileSync(LOG, '');
    xctl('click', Q.x + 12, Q.y + 9);
    const p2 = await waitFor(() => presses().find((p) => p.button === 1), 3000);
    check(p2 && near(p2.x, local.x + 12, 2) && near(p2.y, local.y + 9, 2), `X11: … and clicks reach it again at the right point (${p2?.x}, ${p2?.y})`);

    // Ctrl+Alt+wheel over the client: zooms (helper grab), the client sees no wheel
    fs.writeFileSync(LOG, '');
    const zb = await XA(() => window.__aurora.magnifier.zoom);
    xctl('wheel', Q.x, Q.y, 'up', 'Control_L', 'Alt_L');
    check(await waitFor(async () => (await XA(() => window.__aurora.magnifier.zoom)) === zb + 100, 3000), `X11: Ctrl+Alt+wheel over the Linux window zooms (${zb} -> ${await XA(() => window.__aurora.magnifier.zoom)})`);
    await sleep(300);
    check(!presses().some((p) => p.button === 4 || p.button === 5), 'X11: … and the client does not get that wheel step');
    // Super+keypad - while the client has the X focus (helper's key grab)
    const focusedX = await waitFor(() => XA(() => window.__aurora.xwin.xFocus), 2000);
    xctl('key', 'Super_L', 'KP_Subtract');
    check(focusedX && (await waitFor(async () => (await XA(() => window.__aurora.magnifier.zoom)) === zb, 3000)), `X11: Super + keypad - with the client focused zooms out (helper grab; ${await XA(() => window.__aurora.magnifier.zoom)})`);

    // minimise / restore while magnified: the copy stops and comes back, the shell lives on
    await XA(() => window.__aurora.xwin.frames.values().next().value.win.minimize());
    check(await waitFor(() => XA(() => window.__aurora.magnifier.mirrors().length === 0), 3000), 'X11: minimised: its copy stops');
    await sleep(500);
    await XA(() => window.__aurora.xwin.frames.values().next().value.win.restoreFromMinimize());
    check(await waitFor(() => XA(() => window.__aurora.magnifier.mirrors().some((m) => m.playing)), 6000), 'X11: restored: the copy plays again');
    check(exited === null, 'X11: the shell is still running');

    // lock screen: no input reaches the client
    await XA(() => window.__aurora.shell.lock());
    await waitFor(() => XA(() => document.body.classList.contains('aurora-locked')));
    await sleep(600);
    const inputL = JSON.parse(xctl('input', shellXid));
    const holeL = !inputL.some(([rx, ry, rw, rh]) => Q.x >= rx && Q.x < rx + rw && Q.y >= ry && Q.y < ry + rh);
    fs.writeFileSync(LOG, '');
    xctl('click', Q.x, Q.y);
    await sleep(400);
    check(!holeL && presses().length === 0 && (await XA(() => window.__aurora.magnifier.mirrors().length)) === 0, 'X11: locked: no input hole, no click reaches the client, no copy');
    await XA(() => window.__aurora.shell.emit('unlock'));
    await sleep(600);

    // stop: the cut and the input shape are back to normal, clicks reach the client unmagnified
    xctl('key', 'Super_L', 'Escape');
    check(await waitFor(() => XA(() => !window.__aurora.magnifier.active), 3000), 'X11: Super+Escape stops the magnifier');
    await sleep(600);
    const debug2 = await XA(() => window.__aurora.api.invoke('xwin:debug'));
    const content2 = await XA((id) => window.__aurora.xwin.frames.get(id).win.body.getBoundingClientRect().toJSON(), xid);
    check(debug2.holes.length > 0 && (await XA(() => !document.querySelector('.mag-mirror'))), 'X11: stopped: the shell is cut again, no copy left');
    // an input shape that was never set (or reset) reads as the whole window; the cut alone decides then
    const inputS = JSON.parse(xctl('input', shellXid));
    check(inputS.length === 1 && inputS[0][0] === 0 && inputS[0][1] === 0 && inputS[0][2] >= 1599 && inputS[0][3] >= 899, `X11: no input holes left: the input shape is the default again (${JSON.stringify(inputS)})`);
    fs.writeFileSync(LOG, '');
    const Q2 = { x: Math.round(content2.x + 50), y: Math.round(content2.y + 40) };
    xctl('click', Q2.x, Q2.y);
    const p3 = await waitFor(() => presses().find((p) => p.button === 1), 3000);
    check(p3 && near(p3.x, 50, 2) && near(p3.y, 40, 2), `X11: unmagnified clicks reach the client as before (${p3?.x}, ${p3?.y})`);

    // the client closes while magnified
    xctl('key', 'Super_L', 'equal');
    await waitFor(() => XA(() => window.__aurora.magnifier.mirrors().some((m) => m.playing)), 6000);
    client.kill();
    client = null;
    check(await waitFor(() => XA(() => window.__aurora.xwin.frames.size === 0 && window.__aurora.magnifier.mirrors().length === 0), 5000), 'X11: the client quits while magnified: frame and copy go away');
    await sleep(500);
    check(exited === null && (await XA(() => window.__aurora.magnifier.active)), 'X11: the shell and the magnifier keep running');
    xctl('key', 'Super_L', 'Escape');
    await sleep(300);
  } catch (err) {
    check(false, 'part 2 ran to the end', err.stack || String(err));
  } finally {
    client?.kill();
    await x.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log(`\nmagnifier: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
