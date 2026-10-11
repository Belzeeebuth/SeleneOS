// Personalization — integration and completeness (docs/PERSONALIZATION.md). Every bullet of the user's request is
// driven through the Settings app in the real shell (clicks, combos, sliders, dialogs, keys) and its effect is checked
// on the desktop; then the profile round trip over every PROFILE_KEYS key, a stress run of every built-in profile ×
// visual style × taskbar edge, French + dark at 1280×720 / 1920×1080, and a restart.
//
//   xvfb-run -a -s "-screen 0 1600x900x24" node test/personalization-shell.test.mjs [--no-shots] [--only=checklist,profiles,stress,i18n,restart]
//
// The checklist (PASS / FAIL + evidence) is printed at the end and written to test/out/personalization-checklist.json.
// Screenshots: docs/screenshots/pzs-*.png
import { launchShell, ROOT, OUT } from './lib.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ARGS = process.argv.slice(2);
const NO_SHOTS = ARGS.includes('--no-shots');
const ONLY = (ARGS.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const run = (part) => !ONLY.length || ONLY.includes(part);
const DOCS = path.join(ROOT, '..', 'docs', 'screenshots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const failures = [];
function check(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  ok  ${msg}`);
  } else {
    failures.push(msg);
    console.log(`  FAIL ${msg}`);
  }
}
const checklist = [];
function item(area, name, pass, evidence) {
  checklist.push({ area, item: name, pass: !!pass, evidence: String(evidence ?? '') });
  check(pass, `[${area}] ${name} — ${evidence}`);
}
const S = (sel) => `.app-settings ${sel}`;
async function docShot(s, name) {
  if (NO_SHOTS) return;
  const f = await s.shot(name);
  fs.mkdirSync(DOCS, { recursive: true });
  fs.copyFileSync(f, path.join(DOCS, `${name}.png`));
}
const errorsOf = (s) => s.logs.filter((l) => /^\[(error|pageerror)\]/.test(l) && !/Failed to load resource/.test(l));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-pzs-test-'));
const MOCK = path.join(tmp, 'weather-mock.json');
fs.writeFileSync(MOCK, JSON.stringify({ current: { weather_code: 61, is_day: 1, temperature_2m: 12.4, time: '2026-10-10T14:00' } }));
const ENV = { AURORA_WEATHER_MOCK: MOCK, AURORA_WEATHER_TIMEOUT: '1500' };

// ------------------------------------------------------------------ helpers
const get = (s, key) => s.aurora((k) => window.__aurora.settings.get(k), key);
const setMany = (s, patch, reset) => s.aurora(([p, r]) => window.__aurora.api.invoke('settings:setMany', p, r ? { reset: r } : {}), [patch, reset || null]);
async function go(s, page) {
  await s.aurora((p) => window.__aurora.registry.launch('settings', { page: p }), page);
  await s.page.waitForSelector(S(`.st-page[data-page="${page}"]`), { timeout: 10000 });
  await s.aurora(() => {
    const w = window.__aurora.wm.byApp('settings')[0];
    w.focus();
    if (w.state !== 'maximized') w.maximize();
  });
  await sleep(500);
}
/** Open the combo inside `sel` and pick the menu item whose text is `text` (exact, trimmed). */
async function pick(s, sel, text) {
  const combo = s.page.locator(S(`${sel} .st-combo`)).first();
  await combo.scrollIntoViewIfNeeded();
  await combo.click();
  await sleep(200);
  const items = s.page.locator('.menu.st-combo-menu .menu-item');
  const n = await items.count();
  for (let i = 0; i < n; i++) {
    const tx = (await items.nth(i).innerText()).trim();
    if (tx === text) {
      await items.nth(i).click();
      await sleep(400);
      return true;
    }
  }
  await s.page.keyboard.press('Escape');
  console.log(`    (no "${text}" in ${sel}: ${(await items.allInnerTexts()).join(' | ')})`);
  return false;
}
async function clickToggle(s, sel) {
  const t = s.page.locator(S(`${sel} .toggle input`)).first();
  await t.scrollIntoViewIfNeeded();
  await t.click();
  await sleep(350);
}
async function sliderKey(s, sel, key, times = 1) {
  const sl = s.page.locator(S(`${sel} input.slider`)).first();
  await sl.scrollIntoViewIfNeeded();
  await sl.focus();
  for (let i = 0; i < times; i++) await s.page.keyboard.press(key);
  await sleep(450);
}
async function closeSettings(s) {
  await s.aurora(() => window.__aurora.wm.byApp('settings').forEach((w) => w.close(true)));
  await sleep(400);
}
const rect = (s, sel) => s.aurora((q) => {
  const e = document.querySelector(q);
  if (!e) return null;
  const r = e.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), r: Math.round(r.right), b: Math.round(r.bottom) };
}, sel);
// Real key presses through main/lib/hotkeys.js (before-input-event): Playwright's CDP key events never reach it.
const MODS = { Super: 'meta', Ctrl: 'control', Alt: 'alt', Shift: 'shift' };
async function press(s, combo) {
  const parts = combo.split('+');
  const key = parts.pop();
  const mods = parts.map((p) => MODS[p]);
  await s.app.evaluate(({ BrowserWindow }, [k, m]) => {
    const wc = BrowserWindow.getAllWindows()[0].webContents;
    wc.sendInputEvent({ type: 'keyDown', keyCode: k, modifiers: m });
    wc.sendInputEvent({ type: 'keyUp', keyCode: k, modifiers: m });
  }, [key, mods]);
  await sleep(300);
}
// Oscillators created by WebAudio (sound packs are synthesised): installs a spy once per launch.
async function spyAudio(s) {
  await s.aurora(() => {
    if (window.__osc) return;
    window.__osc = [];
    const orig = AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator = function () {
      const o = orig.call(this);
      window.__osc.push(o);
      return o;
    };
  });
}
const oscCount = async (s, fn) => {
  await s.aurora(() => (window.__osc.length = 0));
  await fn();
  await sleep(150);
  return s.aurora(() => ({ n: window.__osc.length, types: [...new Set(window.__osc.map((o) => o.type))] }));
};

// =====================================================================================================================
async function checklistPart() {
  console.log('\n# Checklist through the Settings UI (light, en, 1600x900)');
  const s = await launchShell({ theme: 'light', lang: 'en', env: ENV, open: ['notepad'] });
  const A = (fn, a) => s.aurora(fn, a);
  try {
    await spyAudio(s);
    // ---------------- 1. Theme designer
    await go(s, 'themeDesigner');
    const sw = s.page.locator(S('[data-section="accent"] .pz-swatch')).nth(4);
    const swColor = await sw.getAttribute('aria-label');
    await sw.click();
    await sleep(500);
    const acc = await A(() => ({ set: window.__aurora.settings.get('accent'), css: document.documentElement.style.getPropertyValue('--accent-base') || getComputedStyle(document.documentElement).getPropertyValue('--accent') }));
    item('Theme designer', 'custom accent color', acc.set === swColor, `swatch ${swColor} → accent ${acc.set}, --accent ${acc.css.trim()}`);
    await pick(s, '[data-section="taskbarColor"]', 'Accent color');
    const tbc = await A(() => ({ c: window.__aurora.settings.get('taskbar.color'), rgb: document.getElementById('taskbar').style.getPropertyValue('--taskbar-rgb'), scope: document.getElementById('taskbar').hasAttribute('data-theme-scope') }));
    item('Theme designer', 'taskbar color', tbc.c === 'accent' && !!tbc.rgb && tbc.scope, `taskbar.color=${tbc.c}, --taskbar-rgb=${tbc.rgb}`);
    const tp0 = await A(() => getComputedStyle(document.documentElement).getPropertyValue('--tp').trim());
    await sliderKey(s, '[data-section="transparencyLevel"]', 'End');
    const tp1 = await A(() => ({ v: window.__aurora.settings.get('transparencyLevel'), tp: getComputedStyle(document.documentElement).getPropertyValue('--tp').trim(), win: getComputedStyle(document.querySelector('.win[data-app="notepad"]') || document.body).getPropertyValue('--a-mica').trim() }));
    item('Theme designer', 'window transparency', tp1.v === 100 && tp1.tp !== tp0, `transparencyLevel ${tp1.v}, --tp ${tp0} → ${tp1.tp}, window --a-mica ${tp1.win}`);
    await sliderKey(s, '[data-section="blur"]', 'Home');
    const bl = await A(() => ({ v: window.__aurora.settings.get('blur'), f: getComputedStyle(document.getElementById('taskbar')).backdropFilter }));
    item('Theme designer', 'blur intensity', bl.v === 0 && /blur\(0px\)/.test(bl.f), `blur ${bl.v}, taskbar backdrop-filter ${bl.f}`);
    await sliderKey(s, '[data-section="blur"]', 'End');
    const bl2 = await A(() => getComputedStyle(document.getElementById('taskbar')).backdropFilter);
    check(/blur\((?!0px)/.test(bl2), `blur at 100: ${bl2}`);
    // wallpaper + lock screen (Background / Lock screen pages, linked from the designer)
    await s.page.locator(S('[data-section="wallpaper"] .btn')).click();
    await s.page.waitForSelector(S('.st-page[data-page="background"] .st-wall'), { timeout: 8000 });
    const before = await get(s, 'wallpaper');
    await s.page.locator(S('.st-wall')).nth(2).click();
    await sleep(700);
    const wp = await A(() => ({ v: window.__aurora.settings.get('wallpaper'), url: window.__aurora.theme.wallpaperUrl }));
    item('Theme designer', 'wallpaper', wp.v !== before && !!wp.url, `${before} → ${wp.v}`);
    await go(s, 'lockscreen');
    await s.page.waitForSelector(S('.st-wall'), { timeout: 8000 });
    await s.page.locator(S('.st-wall')).nth(3).click();
    await sleep(500);
    const lw = await get(s, 'lockWallpaper');
    item('Theme designer', 'lock screen', !!lw, `lockWallpaper = ${String(lw).slice(0, 60)}`);

    // ---------------- 2. Visual styles
    await go(s, 'visualStyle');
    const styles = {};
    for (const id of ['minimal', 'glass', 'retro', 'contrast', 'win11']) {
      await s.page.locator(S(`.pz-style-card[data-style-id="${id}"]`)).first().click();
      await sleep(500);
      styles[id] = await A(() => document.documentElement.dataset.style);
    }
    item('Visual styles', 'Windows 11-like, minimal, glassmorphism, retro, high contrast', Object.entries(styles).every(([k, v]) => k === v), JSON.stringify(styles));

    // ---------------- 3. Animated + dynamic wallpapers
    await go(s, 'background');
    await pick(s, '[data-section="mode"]', 'Animated');
    await sleep(1200);
    const an = await A(() => window.__aurora.wallpaperEngine.state);
    item('Wallpapers', 'animated wallpaper', an.mode === 'animated' && !!an.effect, `mode ${an.mode}, effect ${an.effect}, paused [${an.paused}]`);
    await pick(s, '[data-section="mode"]', 'Dynamic (time of day)');
    await sleep(1200);
    const dy = await A(() => window.__aurora.wallpaperEngine.state);
    item('Wallpapers', 'dynamic wallpaper (time of day)', dy.mode === 'dynamic' && !!dy.dynamic?.phase, `mode ${dy.mode}, phase ${dy.dynamic?.phase}, ${String(dy.dynamic?.url || '').split('/').pop()}`);
    await setMany(s, { 'dynamicWallpaper.location': { name: 'Paris', lat: 48.8566, lon: 2.3522 } });
    await go(s, 'wallpaperEffects');
    await s.page.locator(S('.wp-source button'), { hasText: 'Time of day and weather' }).click();
    await s.page.waitForFunction(() => !!window.__aurora.wallpaperEngine.state.weather, null, { timeout: 8000 }).catch(() => {});
    const wx = await A(() => window.__aurora.wallpaperEngine.state);
    item('Wallpapers', 'dynamic wallpaper (weather)', wx.dynamicWallpaper !== null && wx.weather?.kind === 'rain' && !!wx.weatherFx, `source ${await get(s, 'dynamicWallpaper.source')}, weather ${wx.weather?.kind}, overlay ${JSON.stringify(wx.weatherFx?.kind)}`);
    await setMany(s, {}, ['wallpaperMode', 'dynamicWallpaper']);

    // ---------------- 4. Taskbar
    await go(s, 'taskbar');
    await docShot(s, 'pzs-taskbar-page-light-en');
    await s.page.locator(S('[data-section="size"] .segmented button[data-value="large"]')).click();
    await sleep(600);
    const tl = await A(() => ({ size: document.documentElement.dataset.tbSize, h: Math.round(document.getElementById('taskbar').getBoundingClientRect().height), wa: window.__aurora.wm.workarea() }));
    item('Taskbar', 'size', tl.size === 'large' && tl.h === 56 && tl.wa.height === 900 - 56, `data-tb-size ${tl.size}, height ${tl.h}px, work area ${tl.wa.height}px`);
    await pick(s, '[data-section="position"]', 'Left');
    await sleep(800);
    const tp = await A(() => {
      const r = document.getElementById('taskbar').getBoundingClientRect();
      return { pos: document.documentElement.dataset.tbPos, x: r.x, w: Math.round(r.width), h: Math.round(r.height), wa: window.__aurora.wm.workarea() };
    });
    await A(() => window.__aurora.shell.emit('start:open'));
    await sleep(700);
    const st = await rect(s, '#start');
    await docShot(s, 'pzs-taskbar-left-large-start');
    await A(() => window.__aurora.shell.emit('start:close'));
    item('Taskbar', 'position (left edge, Start beside it)', tp.pos === 'left' && tp.x === 0 && tp.h === 900 && tp.wa.x === tp.w && st && st.x >= tp.w, `taskbar ${tp.w}×${tp.h} at x=${tp.x}, work area x=${tp.wa.x}, Start at x=${st?.x}`);
    for (const [label, pos] of [['Top', 'top'], ['Right', 'right'], ['Bottom', 'bottom']]) {
      await pick(s, '[data-section="position"]', label);
      await sleep(500);
      const r = await A(() => {
        const b = document.getElementById('taskbar').getBoundingClientRect();
        return { pos: document.documentElement.dataset.tbPos, b: [b.left, b.top, b.right, b.bottom].map(Math.round), wa: window.__aurora.wm.workarea() };
      });
      const ok = pos === 'top' ? r.b[1] === 0 && r.wa.y === r.b[3] : pos === 'right' ? r.b[2] === 1600 && r.wa.x + r.wa.width === r.b[0] : r.b[3] === 900 && r.wa.y + r.wa.height === r.b[1];
      check(r.pos === pos && ok, `taskbar on the ${pos} edge: rect ${r.b}, work area ${JSON.stringify(r.wa)}`);
    }
    await s.page.locator(S('[data-section="size"] .segmented button[data-value="medium"]')).click();
    await sleep(300);
    // icons: search box, task view, pinned apps
    await pick(s, '[data-section="items"]', 'Search box');
    const sb = await A(() => !!document.querySelector('#taskbar .tb-searchbox'));
    await clickToggle(s, '[data-section="taskView"]');
    const tv = await A(() => !document.querySelector('#taskbar .tb-taskview'));
    await s.page.locator(S('.pzs-pin-add')).first().click();
    await sleep(250);
    await s.page.locator('.menu .menu-item', { hasText: 'Calculator' }).first().click();
    await sleep(500);
    const pinned1 = await A(() => ({ list: window.__aurora.settings.get('pinned'), btn: !!document.querySelector('#taskbar .tb-app[data-app="calculator"]') }));
    await s.page.locator(S('.pzs-pinned .pzs-list-row[data-id="files"] button')).nth(1).click();
    await sleep(400);
    const order = await A(() => [...document.querySelectorAll('#taskbar .tb-app')].map((b) => b.dataset.app).slice(0, 2).join(','));
    await s.page.locator(S('.pzs-pinned .pzs-list-row[data-id="calculator"] .pzs-remove')).click();
    await sleep(400);
    const pinned2 = await A(() => !document.querySelector('#taskbar .tb-app[data-app="calculator"]'));
    item('Taskbar', 'icons (search box, task view, pin / move / unpin apps)', sb && tv && pinned1.btn && order.startsWith('browser,files') && pinned2, `search box ${sb}, task view hidden ${tv}, calculator pinned ${pinned1.btn}, order after ↓ ${order}, unpinned ${pinned2}`);
    await clickToggle(s, '[data-section="taskView"]');
    await pick(s, '[data-section="items"]', 'Search icon only');
    // widgets: board button + tray mini widgets (the weather one uses the place of the dynamic wallpaper)
    await setMany(s, { 'dynamicWallpaper.location': { name: 'Paris', lat: 48.8566, lon: 2.3522 } });
    await clickToggle(s, '[data-section="widgetsButton"]');
    const wb = await A(() => !!document.querySelector('#taskbar .tb-widgets'));
    const miniToggles = s.page.locator(S('[data-section="widgets"] .st-sub .toggle input'));
    await miniToggles.nth(1).click(); // processor
    await miniToggles.nth(2).click(); // memory
    await miniToggles.nth(0).click(); // weather
    await sleep(500);
    await A(() => window.__aurora.taskbar.refreshWidgets());
    await sleep(800);
    const mw = await A(() => ({ ids: [...document.querySelectorAll('#taskbar .tb-mini')].map((b) => b.dataset.mini), cpu: document.querySelector('#taskbar .tb-mini-cpu .tb-mini-val')?.textContent, mem: document.querySelector('#taskbar .tb-mini-memory .tb-mini-val')?.textContent, wx: document.querySelector('#taskbar .tb-mini-weather')?.dataset.tip, set: window.__aurora.settings.get('taskbar.widgets') }));
    item('Taskbar', 'widgets (board button + tray widgets)', wb && mw.ids.join() === 'weather,cpu,memory' && /%$/.test(mw.cpu || '') && /%$/.test(mw.mem || '') && /12/.test(mw.wx || ''), `widgets button ${wb}; tray ${mw.ids} (cpu ${mw.cpu}, ram ${mw.mem}, weather "${(mw.wx || '').replace(/\n/g, ' / ')}")`);
    await docShot(s, 'pzs-taskbar-widgets');
    await setMany(s, { 'taskbar.widgets': [], 'taskbar.showWidgets': false });
    // transparency of the taskbar (shared control with the designer)
    await clickToggle(s, '[data-section="taskbarOpacity"]');
    await sliderKey(s, '[data-section="taskbarOpacity"]', 'Home');
    const op = await A(() => ({ v: window.__aurora.settings.get('taskbar.opacity'), a: getComputedStyle(document.getElementById('taskbar')).backgroundColor }));
    item('Taskbar', 'transparency', op.v === 0, `taskbar.opacity ${op.v}, background ${op.a}`);
    await setMany(s, {}, ['taskbar.opacity', 'taskbar.color']);
    // labels + combine
    await clickToggle(s, '[data-section="labels"]');
    await pick(s, '[data-section="combine"]', 'Never');
    await A(() => window.__aurora.registry.launch('notepad', { newWindow: true }));
    await sleep(900);
    const lc = await A(() => ({ labels: document.documentElement.dataset.tbLabels, notepads: [...document.querySelectorAll('#taskbar .tb-app[data-app="notepad"]')].map((b) => ({ win: b.dataset.win, label: b.querySelector('.tb-label')?.textContent, w: Math.round(b.getBoundingClientRect().width) })) }));
    item('Taskbar', 'app names + combine buttons (never)', lc.labels === 'on' && lc.notepads.length === 2 && lc.notepads.every((n) => n.win && n.label && n.w > 100), JSON.stringify(lc));
    await docShot(s, 'pzs-taskbar-labels-never-combine');
    await clickToggle(s, '[data-section="labels"]');
    await pick(s, '[data-section="combine"]', 'Always');
    // auto-hide
    await clickToggle(s, '[data-section="autohide"]');
    await s.page.mouse.move(800, 300);
    await sleep(1800);
    const ah = await A(() => ({ on: window.__aurora.settings.get('taskbar.autohide'), hidden: document.getElementById('taskbar').classList.contains('hidden'), ins: window.__aurora.wm.insets }));
    item('Taskbar', 'auto-hide', ah.on === true && ah.hidden && ah.ins.bottom === 0, `autohide ${ah.on}, hidden class ${ah.hidden}, insets ${JSON.stringify(ah.ins)}`);
    await clickToggle(s, '[data-section="autohide"]');

    // ---------------- 5. Start menu
    await go(s, 'start');
    await pick(s, '[data-section="layout"]', 'More pins');
    await A(() => window.__aurora.shell.emit('start:open'));
    await sleep(700);
    const sl1 = await A(() => document.querySelector('#start .start-grid')?.style.gridTemplateRows);
    await A(() => window.__aurora.shell.emit('start:close'));
    await pick(s, '[data-section="layout"]', 'List of all apps');
    await A(() => window.__aurora.shell.emit('start:open'));
    await sleep(700);
    const sl2 = await A(() => !!document.querySelector('#start .start-view-list .start-all .start-row'));
    await docShot(s, 'pzs-start-list-layout');
    await A(() => window.__aurora.shell.emit('start:close'));
    item('Start', 'layout', sl1 === 'repeat(4, 84px)' && sl2, `More pins → ${sl1}; List → A–Z list ${sl2}`);
    await pick(s, '[data-section="layout"]', 'Default');
    // pinned apps
    await s.page.locator(S('.pzs-pin-add')).first().click();
    await sleep(250);
    await s.page.locator('.menu .menu-item', { hasText: 'Winver' }).first().click().catch(async () => {
      await s.page.locator('.menu .menu-item').last().click();
    });
    await sleep(400);
    const sp = await get(s, 'startPinned');
    const added = sp[sp.length - 1];
    await s.page.locator(S(`.pzs-pinned .pzs-list-row[data-id="${added}"] button`)).first().click(); // ↑
    await sleep(400);
    const sp2 = await get(s, 'startPinned');
    item('Start', 'pinned apps (pin, reorder)', sp2.indexOf(added) === sp2.length - 2, `pinned ${added}, moved up → position ${sp2.indexOf(added) + 1}/${sp2.length}`);
    // app folders
    await s.page.locator(S('.pzs-new-folder')).click();
    await s.page.waitForSelector('.pzs-group-dialog', { timeout: 5000 });
    await s.page.locator('.pzs-group-dialog input.input').fill('Games');
    for (const n of ['Chess', 'Snake', 'Solitaire']) await s.page.locator('.pzs-group-dialog .pzs-check', { hasText: n }).first().locator('input').check();
    await s.page.locator('.dialog .btn.primary').last().click();
    await sleep(500);
    const groups = await get(s, 'start.groups');
    await A(() => window.__aurora.shell.emit('start:open'));
    await sleep(700);
    const gtile = await A(() => document.querySelector('#start .start-group')?.textContent);
    await s.page.locator('#start .start-group').first().click();
    await sleep(500);
    const gapps = await A(() => [...document.querySelectorAll('#start .start-folder .start-tile')].map((x) => x.dataset.app).join(','));
    // the open folder is a popup over the dimmed, inert Start page (core/taskbar-start.css)
    check(await A(() => [...document.querySelectorAll('#start .start-body > .start-view')].every((el) => el.inert && Number(getComputedStyle(el).opacity) < 0.5)), 'open folder dims the Start page under it and keeps the keyboard in the popup');
    await docShot(s, 'pzs-start-app-folder');
    await A(() => window.__aurora.shell.emit('start:close'));
    item('Start', 'folders of apps', groups?.length === 1 && gtile === 'Games' && gapps === 'chess,snake,solitaire', `start.groups ${JSON.stringify(groups?.map((g) => g.name))}, tile "${gtile}", opens ${gapps}`);
    // folder shortcuts next to power
    const ftg = s.page.locator(S('[data-section="folders"] .st-sub .toggle input'));
    await ftg.nth(0).click(); // documents
    await ftg.nth(6).click(); // settings
    await sleep(400);
    await A(() => window.__aurora.shell.emit('start:open'));
    await sleep(600);
    const fb = await A(() => [...document.querySelectorAll('#start .start-folder-btn')].map((b) => b.dataset.folder).join(','));
    await s.page.locator('#start .start-folder-btn[data-folder="documents"]').click();
    await sleep(1200);
    const filesOpen = await A(() => window.__aurora.wm.byApp('files').length > 0);
    item('Start', 'folders next to the power button', fb === 'documents,settings' && filesOpen, `buttons ${fb}; Documents opens File Explorer ${filesOpen}`);
    await A(() => window.__aurora.wm.byApp('files').forEach((w) => w.close(true)));
    await go(s, 'start');
    // recommended files
    await clickToggle(s, '[data-section="recent"]');
    await A(() => window.__aurora.shell.emit('start:open'));
    await sleep(600);
    const recOff = await A(() => !document.querySelector('#start .start-recs'));
    await A(() => window.__aurora.shell.emit('start:close'));
    await clickToggle(s, '[data-section="recent"]');
    await s.page.locator(S('[data-section="clearRecent"] .btn')).click();
    await sleep(400);
    item('Start', 'recommended files (show / hide / clear)', recOff && (await get(s, 'startShowRecent')) !== false, `hidden when off ${recOff}, back on ${(await get(s, 'startShowRecent')) !== false}`);
    // background style
    const bgs = {};
    for (const [label, v] of [['Solid', 'solid'], ['Accent color', 'accent'], ['Wallpaper', 'wallpaper'], ['Acrylic (translucent)', 'acrylic']]) {
      await pick(s, '[data-section="background"]', label);
      bgs[v] = await A(() => ({ bg: document.getElementById('start').dataset.bg || 'acrylic', css: getComputedStyle(document.getElementById('start')).backgroundColor }));
    }
    item('Start', 'background style', bgs.solid.bg === 'solid' && bgs.accent.bg === 'accent' && bgs.wallpaper.bg === 'wallpaper' && bgs.acrylic.bg === 'acrylic' && bgs.solid.css !== bgs.accent.css, Object.entries(bgs).map(([k, v]) => `${k}: ${v.css}`).join('; '));

    // ---------------- 6. Packs
    await go(s, 'cursors');
    await s.page.locator(S('.pzs-card[data-pack="highvis"]')).click();
    await sleep(500);
    const cur = await A(() => ({ body: getComputedStyle(document.body).cursor.slice(0, 26), resize: getComputedStyle(document.querySelector('.win .win-resize.r-e') || document.body).cursor.slice(0, 26), input: getComputedStyle(document.querySelector('.app-settings input.input') || document.body).cursor.slice(0, 26) }));
    item('Packs', 'cursor packs', cur.body.startsWith('url("data:image/png') && cur.resize.startsWith('url("data:image/png') && cur.input.startsWith('url("data:image/png'), JSON.stringify(cur));
    await docShot(s, 'pzs-cursors-page');
    await s.page.locator(S('.pzs-card[data-pack="default"]')).click();
    await sleep(300);
    check((await A(() => getComputedStyle(document.body).cursor)) === 'auto' || (await A(() => getComputedStyle(document.body).cursor)) === 'default', 'cursor pack back to the system cursors');
    await go(s, 'iconPacks');
    await s.page.locator(S('.pzs-card[data-pack="tiles"]')).click();
    await sleep(600);
    const ic = await A(() => ({ tb: document.querySelector('#taskbar .tb-app img')?.getAttribute('src').slice(0, 26), win: window.__aurora.wm.byApp('notepad')[0]?.iconEl?.getAttribute('src').slice(0, 26), pack: document.documentElement.dataset.iconPack, fluentCard: document.querySelector('.app-settings .pzs-card[data-pack="fluent"] img')?.getAttribute('src').slice(0, 12) }));
    item('Packs', 'icon packs', ic.tb?.startsWith('data:image/svg+xml,%3Csvg') && ic.win?.startsWith('data:image/svg+xml,%3Csvg') && ic.pack === 'tiles' && ic.fluentCard === 'app://shell/', JSON.stringify(ic));
    await docShot(s, 'pzs-icon-packs-tiles');
    await s.page.locator(S('.pzs-card[data-pack="fluent"]')).click();
    await sleep(400);
    await go(s, 'soundPacks');
    await s.page.locator(S('.pzs-card[data-pack="retro"]')).click();
    await sleep(300);
    const sp1 = await oscCount(s, () => A(() => window.__aurora.sounds.play('error')));
    item('Packs', 'sound packs', (await get(s, 'soundPack')) === 'retro' && sp1.n > 0 && sp1.types.includes('square'), `soundPack retro → error sound ${sp1.n} oscillators (${sp1.types})`);
    await pick(s, '[data-section="ev-notification"]', 'None');
    const n0 = await oscCount(s, () => A(() => window.__aurora.notify({ title: 'Quiet', body: 'no sound' })));
    await pick(s, '[data-section="ev-notification"]', 'Chimes');
    const n1 = await oscCount(s, () => A(() => window.__aurora.notify({ title: 'Chime', body: 'bell' })));
    item('Packs', 'notification sounds', n0.n === 0 && n1.n >= 4 && (await get(s, 'soundEvents.notification')) === 'chimes.notify', `None → ${n0.n} oscillators; Chimes → ${n1.n} (${n1.types})`);
    await pick(s, '[data-section="ev-startup"]', 'Soft');
    const su = await oscCount(s, () => A(() => window.__aurora.sounds.play('startup')));
    await pick(s, '[data-section="ev-shutdown"]', 'None');
    const t0 = Date.now();
    const sd0 = await oscCount(s, () => A(() => window.__aurora.shell.shutdown()));
    const quick = Date.now() - t0;
    await pick(s, '[data-section="ev-shutdown"]', "The pack's sound");
    const sd1 = await oscCount(s, () => A(() => window.__aurora.shell.shutdown()));
    item('Packs', 'startup / shutdown sounds', su.n > 0 && su.types.includes('triangle') && sd0.n === 0 && sd1.n > 0, `startup (Soft) ${su.n} osc ${su.types}; shutdown None ${sd0.n} osc (${quick} ms), pack ${sd1.n} osc`);
    await docShot(s, 'pzs-sound-packs');
    await setMany(s, {}, ['soundPack', 'soundEvents']);

    // ---------------- 7. Typography, shape, scale, motion
    await go(s, 'themeDesigner');
    const fonts = await A(() => [...document.querySelectorAll('.app-settings [data-section="font"] .st-combo')].length);
    await pick(s, '[data-section="font"]', 'DejaVu Sans');
    const fnt = await A(() => ({ v: window.__aurora.settings.get('fontFamily'), f: getComputedStyle(document.body).fontFamily }));
    await sliderKey(s, '[data-section="textScale"]', 'End');
    const ts = await A(() => ({ v: window.__aurora.settings.get('textScale'), fs: getComputedStyle(document.querySelector('.app-settings .st-row-title') || document.body).fontSize }));
    item('Text', 'font and text size', fonts === 1 && fnt.v === 'dejavu-sans' && /DejaVu/.test(fnt.f) && ts.v === 150, `font ${fnt.v} (${fnt.f.split(',')[0]}), text size ${ts.v}% (row title ${ts.fs})`);
    await sliderKey(s, '[data-section="textScale"]', 'Home');
    await setMany(s, {}, ['textScale', 'fontFamily']);
    await sliderKey(s, '[data-section="corners"]', 'Home');
    const cr = await A(() => ({ v: window.__aurora.settings.get('cornerRadius'), r: getComputedStyle(document.querySelector('.win[data-app="notepad"]')).borderTopLeftRadius }));
    await sliderKey(s, '[data-section="corners"]', 'End');
    const cr2 = await A(() => getComputedStyle(document.querySelector('.win[data-app="notepad"]')).borderTopLeftRadius);
    item('Shape', 'rounded-corner intensity', cr.v === 0 && cr.r === '0px' && parseFloat(cr2) >= 14, `0 % → ${cr.r}; 200 % → ${cr2}`);
    await setMany(s, {}, ['cornerRadius']);
    const dpr0 = await A(() => window.devicePixelRatio);
    await sliderKey(s, '[data-section="scale"]', 'ArrowRight');
    await s.page.locator(S('[data-section="scale"] input.slider')).dispatchEvent('change');
    await sleep(1200);
    const sc = await A(() => ({ v: window.__aurora.settings.get('scale'), dpr: window.devicePixelRatio }));
    item('Scale', 'UI scale', sc.v === 105 && sc.dpr > dpr0, `scale ${sc.v}%, devicePixelRatio ${dpr0} → ${sc.dpr}`);
    await setMany(s, {}, ['scale']);
    await sleep(1200);
    await go(s, 'themeDesigner');
    await clickToggle(s, '[data-section="reducedMotion"]');
    const rm = await A(() => ({ rm: document.documentElement.dataset.reducedMotion, an: document.documentElement.dataset.animations }));
    item('Motion', 'reduced-motion mode', rm.rm === 'on' && rm.an === 'off', JSON.stringify(rm));
    await clickToggle(s, '[data-section="reducedMotion"]');

    // ---------------- 8. Per-app themes
    await go(s, 'appThemes');
    const row = s.page.locator(S('.pz-app-row[data-app="notepad"]'));
    await row.scrollIntoViewIfNeeded();
    await row.locator('.st-combo').click();
    await sleep(200);
    await s.page.locator('.menu.st-combo-menu .menu-item', { hasText: 'Dark' }).first().click();
    await sleep(500);
    await row.locator('.pz-app-accent').click();
    await s.page.waitForSelector('.dialog .pz-color-dialog', { timeout: 5000 });
    await s.page.locator('.dialog .pz-color-dialog .pz-swatch').nth(7).click();
    await s.page.locator('.dialog .btn.primary').last().click();
    await sleep(500);
    const pa = await A(() => {
      const w = document.querySelector('.win[data-app="notepad"]');
      return { theme: w.dataset.theme, acc: w.style.getPropertyValue('--accent').trim(), sys: document.documentElement.dataset.theme, cfg: window.__aurora.settings.get('appThemes').notepad };
    });
    item('Per-app themes', 'light, dark, system or custom accent per app', pa.theme === 'dark' && pa.sys === 'light' && !!pa.acc && pa.cfg?.theme === 'dark' && !!pa.cfg?.accent, JSON.stringify(pa));
    await setMany(s, { appThemes: {} });

    // ---------------- 9. Snap layout presets
    await go(s, 'snapPresets');
    await s.page.locator(S('.pzs-snap-new-btn')).click();
    await s.page.waitForSelector('.pzs-snap-editor', { timeout: 5000 });
    await s.page.locator('.pzs-snap-editor .segmented button', { hasText: 'Main + side' }).click();
    await sleep(200);
    await s.page.locator('.pzs-snap-editor input.input').fill('Coding');
    check(await A(() => [...document.querySelectorAll('.dialog.pzs-snap-dialog .dialog-body')].every((b) => b.scrollWidth <= b.clientWidth + 1 && b.scrollLeft === 0)), 'snap layout editor fits its dialog (no horizontal scroll)');
    await docShot(s, 'pzs-snap-editor');
    await s.page.locator('.dialog .btn.primary').last().click();
    await sleep(500);
    const presets = await get(s, 'snapPresets');
    await s.page.locator(S('.pzs-page .btn'), { hasText: 'Show snap layouts' }).click();
    await sleep(600);
    const customTiles = await A(() => document.querySelectorAll('.snapl-fly .snapl-layout.custom').length);
    await docShot(s, 'pzs-snap-flyout-custom');
    await s.page.locator('.snapl-fly .snapl-layout.custom .snapl-zone').first().click();
    await sleep(700);
    const sn = await A(() => {
      const w = window.__aurora.wm.byApp('settings')[0];
      return { state: w.state, snap: w.snap, rect: [w.x, w.y, w.w, w.h] };
    });
    item('Snap', 'snap layout presets', presets?.length === 1 && presets[0].name === 'Coding' && presets[0].zones.length === 3 && customTiles === 1 && sn.state === 'snapped' && /^z:/.test(sn.snap), `preset ${presets?.[0]?.name} (${presets?.[0]?.zones.length} zones), flyout custom tiles ${customTiles}, settings window ${sn.state} ${sn.snap} ${sn.rect}`);

    // ---------------- 10. Keyboard shortcuts
    await go(s, 'shortcuts');
    await s.page.locator(S('[data-section="sc-files"] .pzs-sc-change')).click();
    await s.page.waitForSelector('.pzs-rec', { timeout: 5000 });
    await press(s, 'Ctrl+Alt+E');
    const shown = await A(() => document.querySelector('.pzs-rec-keys')?.textContent);
    await s.page.locator('.dialog.pzs-rec-dialog .btn.primary').click();
    await sleep(500);
    await closeSettings(s);
    await s.page.mouse.click(800, 450);
    await press(s, 'Ctrl+Alt+E');
    await sleep(1200);
    const viaKey = await A(() => window.__aurora.wm.byApp('files').length);
    const superE = await A(() => window.__aurora.hotkeys.trigger('Super+E'));
    item('Shortcuts', 'customizable keyboard shortcuts (record, apply live)', shown?.includes('Ctrl') && (await get(s, 'shortcuts.files')) === 'Ctrl+Alt+E' && viaKey === 1 && superE === false, `recorded "${shown}", Ctrl+Alt+E opened ${viaKey} File Explorer window, Win+E now unbound (${superE})`);
    await A(() => window.__aurora.wm.byApp('files').forEach((w) => w.close(true)));
    await go(s, 'shortcuts');
    await s.page.locator(S('[data-section="sc-run"] .pzs-sc-change')).click();
    await s.page.waitForSelector('.pzs-rec', { timeout: 5000 });
    await press(s, 'Super+K');
    const sk = await A(() => document.querySelector('.pzs-rec-keys')?.textContent);
    await s.page.locator('.dialog.pzs-rec-dialog .btn.primary').click();
    await sleep(400);
    await s.page.locator(S('[data-section="sc-search"] .pzs-sc-change')).click();
    await s.page.waitForSelector('.pzs-rec', { timeout: 5000 });
    await press(s, 'Super+K');
    const conflict = await A(() => document.querySelector('.pzs-rec-msg')?.textContent);
    await s.page.locator('.dialog.pzs-rec-dialog .btn.primary').click();
    await sleep(400);
    const sc2 = await A(() => window.__aurora.settings.get('shortcuts'));
    await s.page.locator(S('[data-section="sc-lock"] .btn.icon-btn')).click();
    await s.page.locator('.menu .menu-item', { hasText: 'Turn off' }).click();
    await sleep(400);
    const lockOff = await A(() => ({ v: window.__aurora.settings.get('shortcuts').lock, t: window.__aurora.hotkeys.trigger('Super+L') }));
    check(sk?.includes('Win') && sc2.search === 'Super+K' && sc2.run === null && /Run/.test(conflict || '') && lockOff.v === null && lockOff.t === false, `Win+K recorded ("${sk}"), conflict "${conflict}" resolved (search ${sc2.search}, run ${sc2.run}); Lock turned off (${JSON.stringify(lockOff)})`);
    await docShot(s, 'pzs-shortcuts-page');
    await s.page.locator(S('.pzs-sc-reset-all')).click();
    await s.page.locator('.dialog .btn.primary').last().click();
    await sleep(400);
    check(JSON.stringify(await get(s, 'shortcuts')) === '{}', 'restore all shortcuts');

    // ---------------- 11. Focus mode
    await go(s, 'focus');
    await pick(s, '[data-section="duration"]', '25 minutes');
    await s.page.locator(S('.pzs-focus-btn')).click();
    await sleep(900);
    const fm = await A(() => {
      const d = document.documentElement.dataset;
      return {
        focus: d.focus, quiet: d.focusQuiet, dim: d.focusDim, simple: d.focusSimple,
        veil: Number(getComputedStyle(document.querySelector('.focus-dim')).opacity),
        search: !!document.querySelector('#taskbar .tb-search')?.offsetParent,
        pinnedIdle: [...document.querySelectorAll('#taskbar .tb-app')].filter((b) => !b.classList.contains('running')).length,
        pill: document.querySelector('#taskbar .tb-focus-pill')?.textContent,
      };
    });
    const toasts0 = await A(() => document.querySelectorAll('#toasts .toast').length);
    await A(() => window.__aurora.notify({ title: 'During focus', body: 'hidden' }));
    await sleep(300);
    const toasts1 = await A(() => document.querySelectorAll('#toasts .toast').length);
    await docShot(s, 'pzs-focus-mode-on');
    item('Focus mode', 'hides notifications, dims desktop, simplifies the taskbar', fm.focus === 'on' && fm.quiet === 'on' && fm.dim === 'on' && fm.simple === 'on' && fm.veil > 0.3 && !fm.search && fm.pinnedIdle === 0 && toasts1 === toasts0 && fm.pill === '25 min', JSON.stringify({ ...fm, toastsDuring: toasts1 - toasts0 }));
    await s.page.locator(S('.pzs-focus-btn')).click();
    await sleep(600);
    const off = await A(() => !document.documentElement.dataset.focus && Number(getComputedStyle(document.querySelector('.focus-dim')).opacity) < 0.05);
    await closeSettings(s);
    await A(() => window.__aurora.shell.emit('quick:toggle'));
    await sleep(600);
    await s.page.locator('[data-key="focus"] .qs-tile-main').click();
    await sleep(500);
    const qsOn = await A(() => document.documentElement.dataset.focus === 'on');
    await A(() => window.__aurora.shell.emit('flyouts:close'));
    await A(() => window.__aurora.hotkeys.trigger('Super+Shift+F'));
    await sleep(500);
    const hkOff = await A(() => !document.documentElement.dataset.focus);
    check(off && qsOn && hkOff, `Focus mode: off from Settings ${off}, on from quick settings ${qsOn}, off with Win+Shift+F ${hkOff}`);

    // ---------------- 12. Profiles (one click)
    await go(s, 'profiles');
    const saveBtn = s.page.locator(S('.btn'), { hasText: 'Save current look' }).first();
    if (await saveBtn.count()) {
      await saveBtn.click();
    } else await A(() => window.__aurora.theme.profiles.saveCurrent('UI profile'));
    const dlg = await s.page.waitForSelector('.dialog input.input', { timeout: 3000 }).catch(() => null);
    if (dlg) {
      await s.page.locator('.dialog input.input').fill('My setup');
      await s.page.locator('.dialog .btn.primary').last().click();
    }
    await sleep(600);
    const list = await A(() => window.__aurora.theme.profiles.list().then((l) => l.filter((p) => !p.builtin).map((p) => ({ id: p.id, name: p.name }))));
    item('Profiles', 'save the current look', list.length >= 1, `user profiles: ${list.map((p) => p.name).join(', ')}`);
    console.log(`  (errors so far: ${errorsOf(s).length})`);
    const errs = errorsOf(s);
    check(!errs.length, `no console errors in the checklist run${errs.length ? `: ${errs.slice(0, 4).join(' | ')}` : ''}`);
  } finally {
    await s.close();
  }
}

// =====================================================================================================================
// Every PROFILE_KEYS key changed, saved, reset, re-applied with one click → identical settings.
const NONDEFAULT = {
  style: 'retro', theme: 'dark', autoTheme: { enabled: true, light: '06:30', dark: '20:15' }, accent: '#c239b3', accentFromWallpaper: true,
  transparency: false, transparencyLevel: 80, blur: 25, cornerRadius: 150, fontFamily: 'dejavu-sans', textScale: 115, scale: 100, reducedMotion: true, animations: false,
  'taskbar.color': '#123456', 'taskbar.opacity': 70, appThemes: { notepad: { theme: 'dark', accent: '#ff8c00' } },
  wallpaper: 'builtin:glow', wallpaperFit: 'fit', lockWallpaper: 'builtin:flow', wallpaperMode: 'animated',
  animatedWallpaper: { id: 'waves', speed: 70, intensity: 60, fps: 15, pauseOnMaximized: false }, dynamicWallpaper: { source: 'weather', set: 'dunes', location: { name: 'Lyon', lat: 45.75, lon: 4.85 }, followTheme: true },
  slideshow: { folder: '/tmp', interval: 10, shuffle: false }, lockScreen: { mode: 'animated', effect: 'starfield' },
  'taskbar.align': 'left', 'taskbar.autohide': true, 'taskbar.showSearch': false, 'taskbar.showTaskView': false, 'taskbar.showWidgets': true,
  'taskbar.size': 'small', 'taskbar.position': 'top', 'taskbar.showLabels': true, 'taskbar.combine': 'whenFull', 'taskbar.widgets': ['cpu', 'network'], 'taskbar.search': 'box',
  'start.layout': 'moreRecommended', 'start.background': 'accent', 'start.folders': ['downloads', 'music'], 'start.groups': [{ id: 'g-tools1', name: 'Tools', apps: ['calculator', 'notepad'] }],
  startShowRecent: false, focusMode: { hideNotifications: false, dimDesktop: true, dimLevel: 65, hideIcons: true, simplifyTaskbar: false, duration: 45 },
  'taskbar.tray': { network: false, volume: true, battery: false }, 'taskbar.badges': false, 'taskbar.widgetsPos': 'end', 'taskbar.hideDelay': 1200, showSeconds: true,
  'start.showRecentApps': false, 'start.showMostUsed': true,
  cursorPack: 'large', iconPack: 'graphite', soundPack: 'chimes', soundEvents: { notification: 'retro.notify', startup: 'none', shutdown: 'soft.shutdown' },
  snapPresets: [{ id: 's-p1', name: 'Wide', zones: [{ x: 0, y: 0, w: 0.7, h: 1 }, { x: 0.7, y: 0, w: 0.3, h: 1 }] }],
  shortcuts: { files: 'Ctrl+Alt+E', lock: null }, desktopIconSize: 'large',
  // B3 (test/packs-input.test.mjs checks them in depth)
  cursorSize: 150, soundVolume: 60, startupSound: false, snapLayouts: ['quad', 's-p1', 'halves'],
  'multitasking.snapLayouts': false, 'multitasking.snapBar': false, 'multitasking.snapAssist': false,
};
async function profilesPart() {
  console.log('\n# Profiles: every key saved and restored');
  const s = await launchShell({ theme: 'light', lang: 'en' });
  const A = (fn, a) => s.aurora(fn, a);
  try {
    const keys = await A(() => import('app://shell/core/profiles.js').then((m) => m.PROFILE_KEYS));
    const missing = Object.keys(NONDEFAULT).filter((k) => !keys.includes(k));
    const untested = keys.filter((k) => !(k in NONDEFAULT));
    check(!missing.length && !untested.length, `PROFILE_KEYS (${keys.length}) covers every personalization key (missing ${missing.join(',') || 'none'}; not exercised ${untested.join(',') || 'none'})`);
    // every new key of areas A, B1, B2, B3 has a default in main/ipc/settings.js
    const defs = await A(() => window.__aurora.api.invoke('settings:defaults'));
    const getPath = (o, k) => k.split('.').reduce((x, p) => (x == null ? undefined : x[p]), o);
    const noDefault = keys.filter((k) => getPath(defs, k) === undefined);
    check(!noDefault.length, `every PROFILE_KEYS key has a default (${noDefault.join(',') || 'all'})`);
    await setMany(s, NONDEFAULT);
    await sleep(1500);
    const snap = (k) => A((list) => Object.fromEntries(list.map((x) => [x, window.__aurora.settings.get(x)])), k);
    const want = await snap(keys);
    const p = await A(() => window.__aurora.theme.profiles.saveCurrent('Everything').then((x) => x.id));
    await setMany(s, {}, keys);
    await sleep(1200);
    const reset = await snap(keys);
    const changedByReset = keys.filter((k) => JSON.stringify(reset[k]) !== JSON.stringify(want[k]));
    check(changedByReset.length >= keys.length - 2, `resetting changed ${changedByReset.length}/${keys.length} keys`);
    await A((id) => window.__aurora.theme.profiles.apply(id), p);
    await sleep(1500);
    const got = await snap(keys);
    const strip = (k, v) => (k === 'focusMode' && v ? { ...v, active: undefined } : v);
    const diff = keys.filter((k) => JSON.stringify(strip(k, got[k])) !== JSON.stringify(strip(k, want[k])));
    item('Profiles', 'save and switch between complete UI themes with one click (every key)', !diff.length, diff.length ? `different after apply: ${diff.map((k) => `${k}=${JSON.stringify(got[k])} vs ${JSON.stringify(want[k])}`).join('; ')}` : `${keys.length} keys identical after save → reset → apply`);
    // the look really follows: taskbar on top, small, retro style, large cursors, graphite icons
    const live = await A(() => ({ pos: document.documentElement.dataset.tbPos, size: document.documentElement.dataset.tbSize, style: document.documentElement.dataset.style, cur: document.documentElement.dataset.cursorPack, ic: document.documentElement.dataset.iconPack, startBg: document.getElementById('start').dataset.bg }));
    check(live.pos === 'top' && live.size === 'small' && live.style === 'retro' && live.cur === 'large' && live.ic === 'graphite' && live.startBg === 'accent', `profile applied live: ${JSON.stringify(live)}`);
    // export → import round trip keeps the B2/B3 keys
    const rt = await A(async (id) => {
      const pr = window.__aurora.theme.profiles;
      const json = pr.exportJson(await pr.get(id));
      const imp = await pr.importJson(json);
      return { n: Object.keys(imp.values).length, tb: imp.values['taskbar.position'], sc: imp.values.shortcuts, sp: imp.values.snapPresets?.length, se: imp.values.soundEvents };
    }, p);
    check(rt.tb === 'top' && rt.sc?.files === 'Ctrl+Alt+E' && rt.sp === 1 && rt.se?.notification === 'retro.notify', `export → import keeps taskbar, shortcuts, snap layouts and sounds (${JSON.stringify(rt)})`);
    // focusMode.active is runtime state: never saved
    await A(() => window.__aurora.shell.emit('focus:start', { minutes: 0 }));
    await sleep(400);
    const p2 = await A(() => window.__aurora.theme.profiles.saveCurrent('Focus on').then((x) => x.values.focusMode));
    check(p2 && !('active' in p2), `focusMode.active is not saved in profiles (${JSON.stringify(p2)})`);
    await A(() => window.__aurora.shell.emit('focus:stop'));
    const errs = errorsOf(s);
    check(!errs.length, `no console errors (profiles)${errs.length ? `: ${errs.slice(0, 3).join(' | ')}` : ''}`);
  } finally {
    await s.close();
  }
}

// =====================================================================================================================
// Every built-in profile × visual style × taskbar edge: the taskbar sits on its edge, the work area excludes it, Start
// and quick settings open on screen beside it, no console errors.
async function stressPart() {
  console.log('\n# Stress: built-in profiles × visual styles × taskbar edges');
  const s = await launchShell({ theme: 'light', lang: 'en', open: ['notepad', 'calculator'] });
  const A = (fn, a) => s.aurora(fn, a);
  try {
    const builtins = await A(() => window.__aurora.theme.profiles.list().then((l) => l.filter((p) => p.builtin).map((p) => p.id)));
    let combos = 0;
    let bad = [];
    for (const id of builtins) {
      await A((x) => window.__aurora.theme.profiles.apply(x), id);
      await sleep(450);
      for (const style of ['win11', 'minimal', 'glass', 'retro', 'contrast']) {
        await setMany(s, { style });
        for (const pos of ['bottom', 'top', 'left', 'right']) {
          await setMany(s, { 'taskbar.position': pos });
          await sleep(120);
          const r = await A(() => {
            const b = document.getElementById('taskbar').getBoundingClientRect();
            const wa = window.__aurora.wm.workarea();
            return { b: [b.left, b.top, b.right, b.bottom].map(Math.round), wa, pos: document.documentElement.dataset.tbPos, style: document.documentElement.dataset.style };
          });
          const ok =
            r.pos === pos &&
            r.style === style &&
            (pos === 'bottom' ? r.b[3] === 900 && r.wa.y + r.wa.height === r.b[1] : pos === 'top' ? r.b[1] === 0 && r.wa.y === r.b[3] : pos === 'left' ? r.b[0] === 0 && r.wa.x === r.b[2] : r.b[2] === 1600 && r.wa.x + r.wa.width === r.b[0]);
          combos++;
          if (!ok) bad.push(`${id}/${style}/${pos}: ${JSON.stringify(r)}`);
        }
      }
    }
    check(!bad.length, `${combos} combinations: taskbar on its edge, work area beside it${bad.length ? ` — ${bad.slice(0, 3).join(' ; ')}` : ''}`);
    // flyouts on every edge, for two looks; screenshots
    bad = [];
    for (const [pid, style] of [['aurora-dark', 'glass'], ['retro', 'retro'], ['contrast', 'contrast'], ['aurora-light', 'win11']]) {
      await A((x) => window.__aurora.theme.profiles.apply(x), pid);
      await setMany(s, { style });
      for (const pos of ['bottom', 'top', 'left', 'right']) {
        await setMany(s, { 'taskbar.position': pos });
        await sleep(300);
        for (const [ev, sel] of [['start:open', '#start'], ['quick:toggle', '#quick-settings'], ['calendar:toggle', '#calendar-center']]) {
          await A((e) => window.__aurora.shell.emit(e), ev);
          await sleep(450);
          const r = await A((q) => {
            const f = document.querySelector(q).getBoundingClientRect();
            const t = document.getElementById('taskbar').getBoundingClientRect();
            const overlap = f.left < t.right && f.right > t.left && f.top < t.bottom && f.bottom > t.top;
            return { f: [f.left, f.top, f.right, f.bottom].map(Math.round), overlap, inside: f.left >= 0 && f.top >= 0 && f.right <= innerWidth && f.bottom <= innerHeight };
          }, sel);
          if (r.overlap || !r.inside) bad.push(`${pid}/${pos}/${sel}: ${JSON.stringify(r)}`);
          if (ev === 'start:open' && (pos === 'left' || pos === 'top')) await docShot(s, `pzs-stress-${pid}-${pos}-start`);
          await A(() => window.__aurora.shell.emit('flyouts:close'));
          await sleep(150);
        }
      }
    }
    check(!bad.length, `Start, quick settings and the calendar open on screen beside the taskbar on every edge${bad.length ? ` — ${bad.slice(0, 3).join(' ; ')}` : ''}`);
    const errs = errorsOf(s);
    item('Stress', 'every built-in profile × style × taskbar edge without errors', !errs.length && !bad.length, errs.length ? errs.slice(0, 3).join(' | ') : `${combos} combinations, 0 console errors`);
  } finally {
    await s.close();
  }
}

// =====================================================================================================================
async function i18nPart() {
  for (const [theme, lang, size] of [['dark', 'fr', '1280x720'], ['light', 'en', '1920x1080'], ['dark', 'fr', '1920x1080']]) {
    console.log(`\n# Pages in ${lang} / ${theme} at ${size}`);
    const s = await launchShell({ theme, lang, size });
    const A = (fn, a) => s.aurora(fn, a);
    try {
      for (const page of ['taskbar', 'start', 'focus', 'cursors', 'iconPacks', 'soundPacks', 'shortcuts', 'snapPresets']) {
        await go(s, page);
        await sleep(400);
        const ov = await A(() => {
          const sc = document.querySelector('.app-settings .st-scroll');
          const text = document.querySelector('.app-settings .st-content').innerText;
          const wide = [...document.querySelectorAll('.app-settings .st-content *')].filter((e) => e.getBoundingClientRect().right > sc.getBoundingClientRect().right + 1 && e.offsetParent).map((e) => e.className).slice(0, 3);
          return { x: sc.scrollWidth - sc.clientWidth, raw: (text.match(/\b(pzs|pers|pz|wp|tbmini|focus|start)\.[a-zA-Z_]+/g) || []).slice(0, 4), wide, nul: /\bnull\b|undefined/.test(text) };
        });
        check(ov.x <= 1 && !ov.raw.length && !ov.wide.length && !ov.nul, `${page}: no overflow, no untranslated keys (${JSON.stringify(ov)})`);
        if (page === 'taskbar' || page === 'shortcuts' || page === 'focus') await docShot(s, `pzs-${page}-${theme}-${lang}-${size}`);
      }
      if (lang === 'fr') {
        const tb = await A(async () => {
          await window.__aurora.api.invoke('settings:setMany', { 'taskbar.widgets': ['cpu', 'memory'], 'focusMode.duration': 30 });
          await new Promise((r) => setTimeout(r, 400));
          const cpu = document.querySelector('#taskbar .tb-mini-cpu .tb-mini-lbl')?.textContent;
          window.__aurora.shell.emit('focus:start');
          await new Promise((r) => setTimeout(r, 600));
          const out = { cpu, pill: document.querySelector('#taskbar .tb-focus-pill')?.dataset.tip, minisHidden: !document.querySelector('#taskbar .tb-mini') };
          window.__aurora.shell.emit('focus:stop');
          return out;
        });
        check(tb.cpu === 'Proc.' && /concentration/i.test(tb.pill || '') && tb.minisHidden, `taskbar widgets and the focus pill in French; the simplified taskbar hides the widgets (${JSON.stringify(tb)})`);
      }
      const errs = errorsOf(s);
      check(!errs.length, `no console errors (${lang}/${theme}/${size})${errs.length ? `: ${errs.slice(0, 3).join(' | ')}` : ''}`);
    } finally {
      await s.close();
    }
  }
}

// =====================================================================================================================
async function restartPart() {
  console.log('\n# Restart: everything comes back at boot');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-pzs-home-'));
  let s = await launchShell({ theme: 'light', lang: 'en', home, keepHome: true });
  await setMany(s, { 'taskbar.position': 'right', 'taskbar.size': 'large', 'start.layout': 'morePins', 'start.background': 'solid', cursorPack: 'midnight', iconPack: 'accent', soundPack: 'retro', snapPresets: [{ id: 's-r', name: 'R', zones: [{ x: 0, y: 0, w: 0.5, h: 1 }, { x: 0.5, y: 0, w: 0.5, h: 1 }] }], shortcuts: { terminal: 'Ctrl+Alt+K' }, 'focusMode.dimLevel': 55 });
  await s.aurora(() => window.__aurora.shell.emit('focus:start'));
  await sleep(800);
  await s.close();
  s = await launchShell({ home, keepHome: true });
  const A = (fn, a) => s.aurora(fn, a);
  try {
    await sleep(800);
    const st = await A(() => ({
      pos: document.documentElement.dataset.tbPos,
      size: document.documentElement.dataset.tbSize,
      wa: window.__aurora.wm.workarea(),
      bg: document.getElementById('start').dataset.bg,
      cur: getComputedStyle(document.body).cursor.slice(0, 20),
      // (Focus mode survives the restart and hides pinned apps that are not running: read a Start tile then)
      icon: document.querySelector('#taskbar .tb-app img, #start .start-tile img')?.getAttribute('src').slice(0, 19),
      sc: window.__aurora.hotkeys.effective['Ctrl+Alt+K'] ? 'bound' : 'unbound',
      focus: !!document.documentElement.dataset.focus,
      focusActive: window.__aurora.settings.get('focusMode.active'),
    }));
    // (a Focus session survives a restart of the shell — docs/PERSONALIZATION.md §10.3)
    item('Persistence', 'every setting restored after a restart', st.pos === 'right' && st.size === 'large' && st.wa.width === 1600 - 72 && st.bg === 'solid' && st.cur.startsWith('url(') && st.icon?.startsWith('data:image/svg+xml') && st.sc === 'bound' && st.focus && st.focusActive === true, JSON.stringify(st));
    const errs = errorsOf(s);
    check(!errs.length, `no console errors after the restart${errs.length ? `: ${errs.slice(0, 3).join(' | ')}` : ''}`);
  } finally {
    await s.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// =====================================================================================================================
try {
  if (run('checklist')) await checklistPart();
  if (run('profiles')) await profilesPart();
  if (run('stress')) await stressPart();
  if (run('i18n')) await i18nPart();
  if (run('restart')) await restartPart();
} catch (err) {
  failures.push(`crash: ${err.stack || err.message}`);
  console.error(err);
}
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'personalization-checklist.json'), JSON.stringify(checklist, null, 2));
console.log('\n# Checklist');
for (const c of checklist) console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.area} — ${c.item}`);
console.log(`\n${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  - ${f}`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failures.length ? 1 : 0);
