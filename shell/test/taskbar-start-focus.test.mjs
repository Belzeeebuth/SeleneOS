// Area B2 — customizable taskbar, custom Start menu, Focus mode (docs/PERSONALIZATION.md §10), in the real shell.
//
//   xvfb-run -a -s "-screen 0 1920x1080x24" node test/taskbar-start-focus.test.mjs [--no-shots] [--only=geometry,taskbar,autohide,start,folders,focus,restart,styles,i18n,security,perf]
//
// geometry  every size × edge at 1280×720 and 1920×1080: thickness, work area, a maximized window never under the bar,
//           buttons inside the bar, every flyout (Start, Search, Quick settings, Calendar, Widgets) and the window
//           picker open beside the bar's edge and on screen
// taskbar   labels / combine, badges, tray icons, clock seconds, widgets button place, search modes, colour + opacity,
//           right-click → Taskbar settings
// autohide  every edge: hides after the delay, the work area takes the screen, the edge hot zone brings it back
// start     layouts (rows / recommended), Recommended apps (recently added, most used), background styles (glass honours
//           the blur intensity), Start follows the taskbar's alignment and edge, folders next to the power button
// folders   drag an app onto another → folder (2×2 preview) at its place; open (popup), rename inline, reorder, drag out,
//           a folder with one app dissolves, drop onto a folder, keyboard path, Settings editor
// focus     quick settings tile, Settings page, shell events: DND on + restored, veil, icons hidden, simplified taskbar,
//           tray chip + banner, timed session end notification
// restart   a running session survives a restart; an expired one ends at start-up and restores Do not disturb
// styles    every visual style × vertical large taskbar + Start with a folder open (+ retro/glass/large text/app theme mix)
// i18n      French + dark: Settings pages Taskbar / Start / Focus mode have no raw keys and nothing overflows
// security  an imported profile with hostile values for the B2 keys is cleaned (no CSS / HTML injection)
// perf      20 × focus on/off and 20 × edge change: no leaked nodes or listeners, one veil, one hot zone
// Screenshots → docs/screenshots/taskbar-*.png, start-*.png, focus-*.png
import { launchShell, ROOT } from './lib.mjs';
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
async function docShot(s, name) {
  if (NO_SHOTS) return;
  const f = await s.shot(name);
  fs.mkdirSync(DOCS, { recursive: true });
  fs.copyFileSync(f, path.join(DOCS, `${name}.png`));
}
const errorsOf = (s) => s.logs.filter((l) => /^\[(error|pageerror)\]/.test(l) && !/Failed to load resource/.test(l));
const S = (sel) => `.app-settings ${sel}`;
const setMany = (s, patch, reset) => s.aurora(([p, r]) => window.__aurora.api.invoke('settings:setMany', p, r ? { reset: r } : {}), [patch, reset || null]);
const get = (s, key) => s.aurora((k) => window.__aurora.settings.get(k), key);
const rect = (s, sel) =>
  s.aurora((q) => {
    const e = typeof q === 'string' ? document.querySelector(q) : null;
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), r: Math.round(r.right), b: Math.round(r.bottom), cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) };
  }, sel);
const overlap = (a, b) => !!a && !!b && a.x < b.r - 0.5 && a.r > b.x + 0.5 && a.y < b.b - 0.5 && a.b > b.y + 0.5;
async function go(s, page) {
  await s.aurora((p) => window.__aurora.registry.launch('settings', { page: p }), page);
  await s.page.waitForSelector(S(`.st-page[data-page="${page}"]`), { timeout: 15000 });
  await s.aurora(() => {
    const w = window.__aurora.wm.byApp('settings')[0];
    w.focus();
    if (w.state !== 'maximized') w.maximize();
  });
  await sleep(600);
}
async function closeApps(s, id) {
  await s.aurora((a) => window.__aurora.wm.list().filter((w) => !a || w.appId === a).forEach((w) => w.close(true)), id || null);
  await sleep(500);
}
async function pick(s, sel, text) {
  const combo = s.page.locator(S(`${sel} .st-combo`)).first();
  await combo.scrollIntoViewIfNeeded();
  await combo.click();
  await sleep(250);
  const items = s.page.locator('.menu.st-combo-menu .menu-item');
  const n = await items.count();
  for (let i = 0; i < n; i++) {
    if ((await items.nth(i).innerText()).trim() === text) {
      await items.nth(i).click();
      await sleep(450);
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
  await sleep(400);
}
const FLY = { start: 'start', search: 'search-panel', quick: 'quick-settings', calendar: 'calendar-center', widgets: 'widgets-board' };
async function openFly(s, f) {
  await s.aurora(() => window.__aurora.shell.emit('flyouts:close', {}));
  await sleep(150);
  await s.aurora((x) => window.__aurora.shell.emit(`${x}:toggle`), f);
  await sleep(550);
  return rect(s, `#${FLY[f]}`);
}
const closeFly = async (s) => {
  await s.aurora(() => window.__aurora.shell.emit('flyouts:close', {}));
  await sleep(300);
};
// A real drag with the mouse: hold over the target for `dwell` ms before dropping (Start folders need a dwell).
async function drag(s, from, to, { dwell = 0, steps = 8, at = 'center' } = {}) {
  await s.page.mouse.move(from.cx, from.cy);
  await s.page.mouse.down();
  await s.page.mouse.move(from.cx + 12, from.cy + 4, { steps: 3 });
  const tx = at === 'left' ? to.x + Math.round(to.w * 0.1) : to.cx;
  await s.page.mouse.move(tx, to.cy, { steps });
  if (dwell) await sleep(dwell);
  await s.page.mouse.move(tx + 1, to.cy, { steps: 1 });
  await s.page.mouse.up();
  await sleep(700);
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-b2-test-'));

// =====================================================================================================================
async function geometryPart(size) {
  console.log(`\n# Taskbar geometry ${size}: every size × edge, maximized window, flyouts, window picker`);
  const [W, H] = size.split('x').map(Number);
  const s = await launchShell({ size, open: ['notepad', 'calculator'], settle: 1500 });
  const A = (fn, a) => s.aurora(fn, a);
  try {
    const THICK = { small: 40, medium: 48, large: 56 };
    const THICK_V = { small: 52, medium: 60, large: 72 };
    for (const pos of ['bottom', 'top', 'left', 'right']) {
      for (const sz of ['small', 'medium', 'large']) {
        await setMany(s, { 'taskbar.position': pos, 'taskbar.size': sz });
        await sleep(450);
        const vertical = pos === 'left' || pos === 'right';
        const want = (vertical ? THICK_V : THICK)[sz];
        const g = await A(() => {
          const tb = document.getElementById('taskbar').getBoundingClientRect();
          const w = window.__aurora.wm.byApp('notepad')[0];
          w.maximize();
          return { tb: { x: tb.x, y: tb.y, w: tb.width, h: tb.height, r: tb.right, b: tb.bottom }, wa: window.__aurora.wm.workarea(), layout: window.__aurora.taskbar.layout() };
        });
        await sleep(450);
        const m = await A(() => {
          const w = window.__aurora.wm.byApp('notepad')[0];
          const r = w.el.getBoundingClientRect();
          const tb = document.getElementById('taskbar').getBoundingClientRect();
          const out = [...document.querySelectorAll('#taskbar .tb-btn:not([hidden])')]
            .filter((b) => b.offsetParent)
            .map((b) => b.getBoundingClientRect())
            .filter((q) => q.left < tb.left - 1 || q.top < tb.top - 1 || q.right > tb.right + 1 || q.bottom > tb.bottom + 1).length;
          const icon = document.querySelector('#taskbar .tb-app img')?.getBoundingClientRect().width;
          const clock = document.querySelector('#taskbar .tb-clock');
          const clockFits = clock.scrollWidth <= clock.clientWidth + 1 && clock.getBoundingClientRect().right <= tb.right + 1;
          w.restore();
          return { win: { x: r.x, y: r.y, w: r.width, h: r.height, r: r.right, b: r.bottom }, out, icon, clockFits };
        });
        const tb = g.tb;
        const edgeOk = pos === 'bottom' ? Math.round(tb.b) === H && Math.round(tb.h) === want : pos === 'top' ? tb.y === 0 && Math.round(tb.h) === want : pos === 'left' ? tb.x === 0 && Math.round(tb.w) === want && Math.round(tb.h) === H : Math.round(tb.r) === W && Math.round(tb.w) === want;
        const waOk = pos === 'bottom' ? g.wa.height === H - want && g.wa.y === 0 : pos === 'top' ? g.wa.y === want && g.wa.height === H - want : pos === 'left' ? g.wa.x === want && g.wa.width === W - want : g.wa.x === 0 && g.wa.width === W - want;
        check(edgeOk && waOk && g.layout.thickness === want, `[${size}] ${pos}/${sz}: bar ${Math.round(tb.w)}×${Math.round(tb.h)} at (${Math.round(tb.x)},${Math.round(tb.y)}), thickness ${want}, work area ${JSON.stringify(g.wa)}`);
        check(!overlap({ ...m.win }, { x: tb.x, y: tb.y, r: tb.r, b: tb.b }) && Math.abs(m.win.w * m.win.h - g.wa.width * g.wa.height) < 4 * (W + H), `[${size}] ${pos}/${sz}: a maximized window fills the rest (${Math.round(m.win.w)}×${Math.round(m.win.h)} at ${Math.round(m.win.x)},${Math.round(m.win.y)}) and never goes under the bar`);
        check(m.out === 0 && m.clockFits, `[${size}] ${pos}/${sz}: every button inside the bar (${m.out} outside), clock fits, app icon ${m.icon}px`);
        if (size === '1920x1080' && sz !== 'small' && !NO_SHOTS) {
          if (pos !== 'bottom' || sz === 'large') await docShot(s, `taskbar-${pos}-${sz}`);
        }
      }
      // flyouts beside the bar's edge
      await setMany(s, { 'taskbar.size': 'medium' });
      await sleep(400);
      const tb = await rect(s, '#taskbar');
      for (const f of Object.keys(FLY)) {
        const r = await openFly(s, f);
        const onScreen = r && r.x >= 0 && r.y >= 0 && r.r <= W && r.b <= H;
        const beside = !r ? false : pos === 'bottom' ? r.b <= tb.y : pos === 'top' ? r.y >= tb.b : pos === 'left' ? r.x >= tb.r : r.r <= tb.x || f === 'widgets';
        // Start / Search open next to the Start button: at the top of a vertical bar
        const anchored = !r ? false : (f === 'start' || f === 'search') && (pos === 'left' || pos === 'right') ? r.y <= 16 : f === 'quick' || f === 'calendar' ? (pos === 'top' ? r.y <= tb.b + 16 : r.b >= H - (pos === 'bottom' ? tb.h : 0) - 16) : true;
        check(onScreen && beside && anchored && !overlap(r, tb), `[${size}] ${pos}: ${f} opens beside the bar (${r ? `${r.x},${r.y} ${r.w}×${r.h}` : 'missing'})`);
        if (size === '1920x1080' && f === 'start' && (pos === 'left' || pos === 'top')) await docShot(s, `taskbar-${pos}-start-open`);
      }
      await closeFly(s);
      // multi-window picker (two Notepad windows)
      await A(() => window.__aurora.registry.launch('notepad', { newWindow: true }));
      await sleep(900);
      await s.page.locator('#taskbar .tb-app[data-app="notepad"]').first().click();
      await sleep(700);
      const pv = await rect(s, '.tb-preview');
      const items = await A(() => document.querySelectorAll('.tb-preview .tb-pv-item').length);
      check(pv && items === 2 && pv.x >= 0 && pv.y >= 0 && pv.r <= W && pv.b <= H && !overlap(pv, tb), `[${size}] ${pos}: the window picker shows both windows beside the bar (${pv ? `${pv.x},${pv.y} ${pv.w}×${pv.h}` : 'missing'}, ${items} items)`);
      if (size === '1920x1080' && (pos === 'right' || pos === 'top')) await docShot(s, `taskbar-${pos}-window-picker`);
      await s.page.mouse.click(Math.round(W / 2), Math.round(H / 2));
      await sleep(300);
      await A(() => window.__aurora.wm.byApp('notepad').slice(1).forEach((w) => w.close(true)));
      await sleep(400);
    }
    await setMany(s, {}, ['taskbar.position', 'taskbar.size']);
    check(!errorsOf(s).length, `[${size}] no console errors (${errorsOf(s).slice(0, 3).join(' | ')})`);
  } finally {
    await s.close();
  }
}

// =====================================================================================================================
async function taskbarPart() {
  console.log('\n# Taskbar items: labels / combine, badges, tray, seconds, widgets place, search, colour, context menu');
  const s = await launchShell({ size: '1920x1080', open: ['notepad'], settle: 1500 });
  const A = (fn, a) => s.aurora(fn, a);
  try {
    await A(() => window.__aurora.registry.launch('notepad', { newWindow: true }));
    await sleep(900);
    // combine never + labels: one labelled button per window (Windows 11 23H2 "Never combine")
    await setMany(s, { 'taskbar.combine': 'never', 'taskbar.showLabels': true });
    await sleep(600);
    const nv = await A(() => [...document.querySelectorAll('#taskbar .tb-app[data-app="notepad"]')].map((b) => ({ win: b.dataset.win, label: b.querySelector('.tb-label')?.textContent, shown: getComputedStyle(b.querySelector('.tb-label')).display !== 'none', w: Math.round(b.getBoundingClientRect().width) })));
    check(nv.length === 2 && nv.every((b) => b.win && b.label && b.shown && b.w >= 120), `never combine + labels: one labelled button per window ${JSON.stringify(nv)}`);
    await docShot(s, 'taskbar-labels-never-combine');
    await setMany(s, { 'taskbar.combine': 'always' });
    await sleep(500);
    check((await A(() => document.querySelectorAll('#taskbar .tb-app[data-app="notepad"]').length)) === 1, 'combine always: one button for the two windows');
    await setMany(s, { 'taskbar.combine': 'whenFull' });
    await sleep(500);
    check((await A(() => document.querySelectorAll('#taskbar .tb-app[data-app="notepad"]').length)) === 2, 'combine when full: one button per window while they fit');
    await setMany(s, { 'taskbar.showLabels': false, 'taskbar.position': 'left' });
    await sleep(500);
    check((await A(() => [...document.querySelectorAll('#taskbar .tb-app .tb-label')].every((l) => getComputedStyle(l).display === 'none'))), 'a vertical taskbar shows icons only');
    await setMany(s, {}, ['taskbar.combine', 'taskbar.showLabels', 'taskbar.position']);
    await A(() => window.__aurora.wm.byApp('notepad').slice(1).forEach((w) => w.close(true)));
    await sleep(500);

    // badges: unread notifications of an app on its button
    await A(() => {
      window.__aurora.notify({ title: 'One', body: 'a', appId: 'notepad' });
      window.__aurora.notify({ title: 'Two', body: 'b', appId: 'notepad' });
    });
    await sleep(400);
    const bd = await A(() => {
      const b = document.querySelector('#taskbar .tb-app[data-app="notepad"]');
      const e = b.querySelector('.tb-badge');
      return { text: e.textContent, hidden: e.hidden, label: b.getAttribute('aria-label') };
    });
    check(bd.text === '2' && !bd.hidden && /2/.test(bd.label), `badge shows the unread count (${JSON.stringify(bd)})`);
    await setMany(s, { 'taskbar.badges': false });
    await sleep(400);
    check(await A(() => document.querySelector('#taskbar .tb-app[data-app="notepad"] .tb-badge').hidden), 'badges can be turned off');
    await setMany(s, {}, ['taskbar.badges']);
    await A(() => window.__aurora.notifications.markAllRead());
    await sleep(300);
    check(await A(() => document.querySelector('#taskbar .tb-app[data-app="notepad"] .tb-badge').hidden), 'reading the notifications clears the badge');

    // tray icons + seconds
    const tray0 = await A(() => ['net', 'vol', 'bat'].map((k) => !document.querySelector(`#taskbar .tb-${k}`).hidden));
    await setMany(s, { 'taskbar.tray': { network: false, volume: true, battery: false }, showSeconds: true });
    await sleep(1300);
    const tray1 = await A(() => ({ icons: ['net', 'vol', 'bat'].map((k) => !document.querySelector(`#taskbar .tb-${k}`).hidden), time: document.querySelector('.tb-time').textContent }));
    // (the dev backend may report no battery: the battery icon is then hidden anyway)
    check(tray0[0] && tray0[1] && !tray1.icons[0] && tray1.icons[1] && !tray1.icons[2], `tray icons follow taskbar.tray (${tray0} → ${tray1.icons})`);
    check(/\d{1,2}:\d{2}:\d{2}/.test(tray1.time), `clock seconds (${tray1.time})`);
    await setMany(s, { 'taskbar.tray': { network: false, volume: false, battery: false } });
    await sleep(400);
    check(await A(() => !document.querySelector('#taskbar .tb-qs-fallback').hidden), 'with every tray icon hidden, the Quick settings button keeps a glyph');
    await setMany(s, {}, ['taskbar.tray', 'showSeconds']);

    // widgets button place
    const place = async () => A(() => {
      const b = document.querySelector('#taskbar .tb-widgets');
      return !b ? 'none' : b.closest('#taskbar > .tb-left') ? 'start' : b.closest('#taskbar > .tb-tray') ? 'end' : b.closest('#taskbar > .tb-center') ? 'inline' : '?';
    });
    await setMany(s, { 'taskbar.showWidgets': true });
    await sleep(400);
    const p1 = await place();
    await setMany(s, { 'taskbar.align': 'left' });
    await sleep(400);
    const p2 = await place();
    await setMany(s, { 'taskbar.widgetsPos': 'inline', 'taskbar.align': 'center' });
    await sleep(400);
    const p3 = await place();
    await setMany(s, { 'taskbar.widgetsPos': 'end' });
    await sleep(400);
    const p4 = await place();
    check(p1 === 'start' && p2 === 'end' && p3 === 'inline' && p4 === 'end', `widgets button place: auto centred ${p1}, auto left-aligned ${p2}, inline ${p3}, end ${p4}`);
    await s.page.locator('#taskbar .tb-widgets').click();
    await sleep(900);
    check(await A(() => document.getElementById('widgets-board')?.classList.contains('open')), 'the widgets button at the end of the bar opens the board');
    await A(() => window.__aurora.shell.emit('flyouts:close', {}));
    await setMany(s, {}, ['taskbar.showWidgets', 'taskbar.widgetsPos', 'taskbar.align']);
    await sleep(300);

    // search modes, task view
    for (const [mode, sel] of [['box', '.tb-searchbox'], ['icon', '.tb-search:not(.tb-searchbox)'], ['hidden', null]]) {
      await setMany(s, { 'taskbar.search': mode, 'taskbar.showSearch': mode !== 'hidden' });
      await sleep(350);
      const has = await A((q) => (q ? !!document.querySelector(`#taskbar ${q}`) : !document.querySelector('#taskbar .tb-search')), sel);
      check(has, `search: ${mode}`);
    }
    await setMany(s, { 'taskbar.showTaskView': false });
    await sleep(300);
    check(await A(() => !document.querySelector('#taskbar .tb-taskview')), 'task view button can be hidden');
    await setMany(s, {}, ['taskbar.search', 'taskbar.showSearch', 'taskbar.showTaskView']);

    // colour + opacity (tokens of the theme engine)
    await setMany(s, { 'taskbar.color': '#123456', 'taskbar.opacity': 30 });
    await sleep(500);
    const col = await A(() => getComputedStyle(document.getElementById('taskbar')).backgroundColor);
    const m = col.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/);
    check(m && +m[1] === 18 && +m[2] === 52 && +m[3] === 86 && m[4] && Math.abs(+m[4] - 0.3) < 0.08, `taskbar colour and opacity (${col})`);
    await setMany(s, {}, ['taskbar.color', 'taskbar.opacity']);

    // right-click on an empty part of the bar → Taskbar settings
    const tb = await rect(s, '#taskbar');
    await s.page.mouse.click(tb.x + 300, tb.cy, { button: 'right' });
    await sleep(400);
    const items = await A(() => [...document.querySelectorAll('body > .menu .menu-item')].map((x) => x.textContent.trim()));
    check(items.includes('Taskbar settings'), `context menu of the bar: ${items.join(' | ')}`);
    await s.page.locator('body > .menu .menu-item', { hasText: 'Taskbar settings' }).click();
    await s.page.waitForSelector(S('.st-page[data-page="taskbar"]'), { timeout: 15000 });
    check(true, 'Taskbar settings opens Settings > Personalization > Taskbar');
    // the Settings page drives the new keys
    await A(() => window.__aurora.wm.byApp('settings')[0].maximize());
    await sleep(500);
    await clickToggle(s, '[data-section="badges"]');
    check((await get(s, 'taskbar.badges')) === false, 'Settings: badges switch');
    await clickToggle(s, '[data-section="badges"]');
    const trayToggle = s.page.locator(S('[data-section="tray"] .st-sub-row .toggle input, [data-section="tray"] .toggle input')).first();
    await trayToggle.scrollIntoViewIfNeeded();
    await trayToggle.click();
    await sleep(400);
    check((await get(s, 'taskbar.tray.network')) === false, 'Settings: tray icon switches (network)');
    await trayToggle.click();
    await sleep(300);
    check(await pick(s, '[data-section="widgetsPos"]', 'Next to the system tray'), 'Settings: widgets button position combo');
    check((await get(s, 'taskbar.widgetsPos')) === 'end', 'widgetsPos saved');
    await s.page.locator(S('[data-section="size"] [data-value="large"]')).click();
    await sleep(500);
    check((await get(s, 'taskbar.size')) === 'large' && (await rect(s, '#taskbar')).h === 56, 'Settings: size Large → 56 px bar');
    await clickToggle(s, '[data-section="autohide"]');
    const delayEnabled = await A(() => !document.querySelector('.app-settings [data-section="hideDelay"] .st-combo').disabled);
    check(delayEnabled && (await pick(s, '[data-section="hideDelay"]', '1.2 s')), 'Settings: hide delay (enabled with auto-hide)');
    check((await get(s, 'taskbar.hideDelay')) === 1200, 'hideDelay saved');
    await docShot(s, 'taskbar-settings-page');
    await setMany(s, {}, ['taskbar.size', 'taskbar.autohide', 'taskbar.hideDelay', 'taskbar.widgetsPos']);
    check(!errorsOf(s).length, `no console errors (${errorsOf(s).slice(0, 3).join(' | ')})`);
  } finally {
    await s.close();
  }
}

// =====================================================================================================================
async function autohidePart() {
  console.log('\n# Auto-hide on every edge');
  const s = await launchShell({ size: '1280x720', open: ['calculator'], settle: 1200 });
  const A = (fn, a) => s.aurora(fn, a);
  try {
    for (const pos of ['bottom', 'top', 'left', 'right']) {
      await s.page.mouse.move(640, 360);
      await setMany(s, { 'taskbar.position': pos, 'taskbar.autohide': true, 'taskbar.hideDelay': 300 });
      await sleep(1700);
      const hid = await A(() => {
        const tb = document.getElementById('taskbar');
        const r = tb.getBoundingClientRect();
        return { hidden: tb.classList.contains('hidden'), r: { x: r.x, y: r.y, r: r.right, b: r.bottom }, wa: window.__aurora.wm.workarea(), hz: (() => { const z = document.querySelector('.tb-hotzone'); const q = z.getBoundingClientRect(); return { hidden: z.hidden, x: q.x, y: q.y, w: q.width, h: q.height }; })() };
      });
      const offscreen = pos === 'bottom' ? hid.r.y >= 719 : pos === 'top' ? hid.r.b <= 1 : pos === 'left' ? hid.r.r <= 1 : hid.r.x >= 1279;
      check(hid.hidden && offscreen && hid.wa.width === 1280 && hid.wa.height === 720, `${pos}: hides off screen, work area = whole screen (${JSON.stringify(hid.wa)})`);
      const hz = hid.hz;
      const hzOk = !hz.hidden && (pos === 'bottom' ? hz.y >= 716 && hz.w >= 1279 : pos === 'top' ? hz.y === 0 && hz.w >= 1279 : pos === 'left' ? hz.x === 0 && hz.h >= 719 : hz.x >= 1276 && hz.h >= 719);
      check(hzOk, `${pos}: hot zone on that edge (${JSON.stringify(hz)})`);
      const pt = pos === 'bottom' ? [640, 719] : pos === 'top' ? [640, 0] : pos === 'left' ? [0, 360] : [1279, 360];
      await s.page.mouse.move(pt[0], pt[1], { steps: 4 });
      await sleep(600);
      check(!(await A(() => document.getElementById('taskbar').classList.contains('hidden'))), `${pos}: the edge brings it back`);
      if (pos === 'left') await docShot(s, 'taskbar-autohide-left-revealed');
      await s.page.mouse.move(640, 360, { steps: 4 });
      await sleep(1900);
      check(await A(() => document.getElementById('taskbar').classList.contains('hidden')), `${pos}: hides again after the delay`);
      // a flyout keeps it visible
      await A(() => window.__aurora.shell.emit('start:open'));
      await sleep(1200);
      check(!(await A(() => document.getElementById('taskbar').classList.contains('hidden'))), `${pos}: stays visible while Start is open`);
      await A(() => window.__aurora.shell.emit('start:close'));
      await sleep(300);
    }
    await setMany(s, {}, ['taskbar.position', 'taskbar.autohide', 'taskbar.hideDelay']);
    await sleep(500);
    const back = await A(() => ({ hidden: document.getElementById('taskbar').classList.contains('hidden'), wa: window.__aurora.wm.workarea(), hz: document.querySelector('.tb-hotzone').hidden }));
    check(!back.hidden && back.wa.height === 672 && back.hz, `auto-hide off: bar back, work area ${JSON.stringify(back.wa)}`);
    check(!errorsOf(s).length, `no console errors (${errorsOf(s).slice(0, 3).join(' | ')})`);
  } finally {
    await s.close();
  }
}

// =====================================================================================================================
async function startPart() {
  console.log('\n# Start: layouts, recommended apps, background styles, position, folders next to power');
  const s = await launchShell({ size: '1920x1080', settle: 1500 });
  const A = (fn, a) => s.aurora(fn, a);
  try {
    const startOpen = async () => {
      await A(() => window.__aurora.shell.emit('start:close'));
      await sleep(200);
      await A(() => window.__aurora.shell.emit('start:open'));
      await sleep(800);
    };
    // layouts (every app pinned, so the rows really limit the grid)
    const allPins = await A(() => window.__aurora.registry.list().map((m) => m.id));
    await setMany(s, { startPinned: allPins });
    const L = {};
    for (const layout of ['default', 'morePins', 'moreRecommended', 'list']) {
      await setMany(s, { 'start.layout': layout });
      await startOpen();
      L[layout] = await A(() => ({
        rows: (document.querySelector('#start .start-grid')?.style.gridTemplateRows.match(/repeat\((\d+)/) || [])[1],
        recRows: (document.querySelector('#start .start-recs')?.style.gridTemplateRows.match(/repeat\((\d+)/) || [])[1] || null,
        list: !!document.querySelector('#start .start-view-list .start-all .start-row'),
        tiles: document.querySelectorAll('#start .start-view:not(.leaving) .start-grid > .start-tile').length,
      }));
      if (layout === 'morePins') await docShot(s, 'start-layout-more-pins');
    }
    check(L.default.rows === '3' && L.default.recRows === '3' && L.morePins.rows === '4' && L.morePins.recRows === '1' && L.moreRecommended.rows === '2' && L.moreRecommended.recRows === '4' && L.list.rows === '1' && L.list.list, `layouts: ${JSON.stringify(L)}`);
    check(L.morePins.tiles > L.default.tiles && L.default.tiles > L.moreRecommended.tiles, `columns × rows adapt (${L.moreRecommended.tiles} < ${L.default.tiles} < ${L.morePins.tiles} tiles)`);
    await setMany(s, {}, ['start.layout', 'startPinned']);

    // recommended apps: recently added (tracked first-seen time) and most used (launch counts)
    await A(() => window.__aurora.start.close());
    const recentlyAdded = await A(async () => {
      const { recent } = await import('app://shell/core/start.js');
      recent.markAdded('paint');
      return recent.addedApps();
    });
    for (let i = 0; i < 3; i++) {
      await A(() => window.__aurora.registry.launch('calculator'));
      await sleep(600);
      await A(() => window.__aurora.wm.byApp('calculator').forEach((w) => w.close(true)));
      await sleep(300);
    }
    await setMany(s, { 'start.showMostUsed': true });
    await startOpen();
    const rec = await A(() => [...document.querySelectorAll('#start .start-recs .start-rec-app')].map((x) => `${x.dataset.app}:${x.classList.contains('start-rec-new') ? 'new' : 'used'}`));
    check(recentlyAdded.includes('paint') && rec.includes('paint:new') && rec.includes('calculator:used'), `Recommended shows recently added + most used apps (${rec.join(', ')})`);
    await docShot(s, 'start-recommended-apps');
    await s.page.locator('#start .start-view-pinned .start-head-btn').click();
    await sleep(700);
    check(await A(() => !!document.querySelector('#start .start-row[data-app="paint"] .start-new-pill')), 'All apps marks the recently added app "New"');
    await setMany(s, { 'start.showRecentApps': false, 'start.showMostUsed': false, startShowRecent: false });
    await startOpen();
    const none = await A(() => ({ recs: !!document.querySelector('#start .start-recs'), rows: document.querySelector('#start .start-grid')?.style.gridTemplateRows }));
    check(!none.recs && /repeat\(6/.test(none.rows), `all three Recommended switches off: no Recommended section, more pins (${JSON.stringify(none)})`);
    await setMany(s, {}, ['start.showRecentApps', 'start.showMostUsed', 'startShowRecent']);

    // background styles
    const bgs = {};
    for (const bg of ['acrylic', 'glass', 'solid', 'accent', 'wallpaper']) {
      await setMany(s, { 'start.background': bg });
      await startOpen();
      bgs[bg] = await A(() => {
        const st = getComputedStyle(document.getElementById('start'));
        return { attr: document.getElementById('start').dataset.bg || 'acrylic', bg: st.backgroundColor, img: st.backgroundImage.slice(0, 24), filter: st.backdropFilter };
      });
      if (bg === 'glass') await docShot(s, 'start-background-glass');
    }
    const distinct = new Set(Object.values(bgs).map((b) => `${b.bg}|${b.img}|${b.filter}`)).size;
    check(Object.entries(bgs).every(([k, v]) => v.attr === k) && distinct === 5, `5 distinct background styles ${JSON.stringify(bgs)}`);
    check(/blur\((\d+)px\)/.test(bgs.glass.filter) && /blur\((\d+)px\)/.test(bgs.acrylic.filter) && bgs.solid.filter === 'none', `glass and acrylic blur, solid does not (${bgs.glass.filter} / ${bgs.acrylic.filter} / ${bgs.solid.filter})`);
    await setMany(s, { 'start.background': 'glass', blur: 0 });
    await startOpen();
    const g0 = await A(() => getComputedStyle(document.getElementById('start')).backdropFilter);
    await setMany(s, { blur: 100 });
    await sleep(300);
    const g1 = await A(() => getComputedStyle(document.getElementById('start')).backdropFilter);
    check(/blur\(0px\)/.test(g0) && /blur\((\d+)px\)/.test(g1) && +g1.match(/blur\((\d+)px\)/)[1] >= 80, `glass honours the blur intensity (blur 0 → ${g0}; blur 100 → ${g1})`);
    await setMany(s, { transparency: false });
    await sleep(300);
    const g2 = await A(() => getComputedStyle(document.getElementById('start')).backdropFilter);
    check(g2 === 'none', `glass with transparency off is opaque (${g2})`);
    await setMany(s, {}, ['start.background', 'blur', 'transparency']);

    // position follows alignment and edge
    const pos = {};
    for (const [k, patch] of [['center', {}], ['left', { 'taskbar.align': 'left' }], ['top', { 'taskbar.position': 'top' }], ['left-edge', { 'taskbar.position': 'left' }], ['right-edge', { 'taskbar.position': 'right' }]]) {
      await setMany(s, { 'taskbar.align': 'center', 'taskbar.position': 'bottom', ...patch });
      await startOpen();
      pos[k] = { start: await rect(s, '#start'), btn: await rect(s, '#taskbar .tb-start') };
    }
    check(Math.abs(pos.center.start.cx - 960) < 4, `centred taskbar: Start centred (${pos.center.start.cx})`);
    check(pos.left.start.x <= 16, `left-aligned taskbar: Start at the left (${pos.left.start.x})`);
    check(pos.top.start.y >= 48 && pos.top.start.y <= 64, `top taskbar: Start drops from it (${pos.top.start.y})`);
    check(pos['left-edge'].start.x >= 60 && pos['left-edge'].start.y <= 16, `left taskbar: Start beside it, at the top next to the Start button (${pos['left-edge'].start.x},${pos['left-edge'].start.y})`);
    check(pos['right-edge'].start.r <= 1920 - 60 && pos['right-edge'].start.y <= 16, `right taskbar: Start beside it (${pos['right-edge'].start.r},${pos['right-edge'].start.y})`);
    await setMany(s, {}, ['taskbar.align', 'taskbar.position']);

    // folders next to the power button
    await setMany(s, { 'start.folders': ['settings', 'files', 'documents', 'downloads', 'music', 'pictures', 'videos'] });
    await startOpen();
    const fb = await A(() => [...document.querySelectorAll('#start .start-folder-btn')].map((b) => b.dataset.folder));
    check(fb.join() === 'settings,files,documents,downloads,music,pictures,videos', `folders next to the power button (${fb})`);
    await docShot(s, 'start-power-folders');
    await s.page.locator('#start .start-folder-btn[data-folder="downloads"]').click();
    await sleep(1500);
    const fpath = await A(() => window.__aurora.wm.byApp('files')[0]?.title || '');
    check(/Download|Téléchargement/i.test(fpath), `Downloads opens File Explorer there (${fpath})`);
    await setMany(s, {}, ['start.folders']);
    check(!errorsOf(s).length, `no console errors (${errorsOf(s).slice(0, 3).join(' | ')})`);
  } finally {
    await s.close();
  }
}

// =====================================================================================================================
async function foldersPart() {
  console.log('\n# Start folders: drag to create, open, rename, reorder, drag out, dissolve, keyboard, Settings');
  const s = await launchShell({ size: '1920x1080', settle: 1500 });
  const A = (fn, a) => s.aurora(fn, a);
  const P = s.page;
  try {
    await A(() => window.__aurora.shell.emit('start:open'));
    await sleep(900);
    const keys = () => A(() => [...document.querySelectorAll('#start .start-view:not(.leaving) .start-grid > .start-tile')].map((t) => t.dataset.app || t.dataset.group));
    const k0 = await keys();
    // a quick drop on the edge of a tile only reorders (no folder)
    const calc = await rect(s, '#start .start-tile[data-app="calculator"]');
    const browser = await rect(s, '#start .start-tile[data-app="browser"]');
    await drag(s, calc, browser, { dwell: 300, at: 'left' });
    const k1 = await keys();
    check(k1[0] === 'calculator' && !(await get(s, 'start.groups'))?.length, `drop on the edge of a tile reorders (${k0.slice(0, 5)} → ${k1.slice(0, 5)})`);
    // hold an app over the middle of another: a folder of the two takes the target's place
    const paint = await rect(s, '#start .start-tile[data-app="paint"]');
    const notepad = await rect(s, '#start .start-tile[data-app="notepad"]');
    const at = k1.indexOf('notepad');
    await drag(s, paint, notepad, { dwell: 900 });
    let groups = await get(s, 'start.groups');
    const k2 = await keys();
    const gid = groups?.[0]?.id;
    check(groups?.length === 1 && groups[0].apps.join() === 'notepad,paint' && k2[at - (k1.indexOf('paint') < at ? 1 : 0)] === gid && !k2.includes('paint') && !k2.includes('notepad'), `held over the middle of Notepad, Paint makes a folder at Notepad's place (${JSON.stringify(groups)} ; ${k2.slice(0, 10)})`);
    if (!gid) throw new Error('no folder: the rest of the folder checks cannot run');
    const preview = await A((g) => document.querySelectorAll(`#start .start-group[data-group="${g}"] .start-group-icons img`).length, gid);
    check(preview === 2, `the folder tile shows a mini grid of its apps (${preview} icons)`);
    // drop a third and a fourth app on the folder: inside at once; the mini grid shows up to 4
    for (const app of ['terminal', 'media', 'snipping']) {
      const a = await rect(s, `#start .start-tile[data-app="${app}"]`);
      const f = await rect(s, `#start .start-group[data-group="${gid}"]`);
      await drag(s, a, f, { dwell: 200 });
    }
    groups = await get(s, 'start.groups');
    const pv4 = await A((g) => document.querySelectorAll(`#start .start-group[data-group="${g}"] .start-group-icons img`).length, gid);
    check(groups[0].apps.length === 5 && pv4 === 4, `dropping apps on a folder puts them inside (${groups[0].apps}), 2×2 preview (${pv4})`);
    await docShot(s, 'start-folder-tile');
    // open: a popup growing from the tile, the Pinned page dimmed and inert
    await P.locator(`#start .start-group[data-group="${gid}"]`).click();
    await sleep(700);
    const op = await A(() => ({
      popup: !!document.querySelector('#start .start-folder-layer .start-folder'),
      apps: [...document.querySelectorAll('#start .start-folder .start-tile')].map((t) => t.dataset.app),
      inert: [...document.querySelectorAll('#start .start-body > .start-view')].every((v) => v.inert),
      dim: Number(getComputedStyle(document.querySelector('#start .start-body > .start-view')).opacity),
      name: document.querySelector('#start .start-folder-name')?.value,
      focus: document.activeElement?.closest('.start-folder') ? 'in popup' : document.activeElement?.className,
    }));
    check(op.popup && op.apps.length === 5 && op.inert && op.dim < 0.5 && op.name === 'Folder' && op.focus === 'in popup', `click opens the folder popup over the dimmed Pinned page ${JSON.stringify(op)}`);
    await docShot(s, 'start-folder-open');
    // rename inline
    await P.locator('#start .start-folder-name').click();
    await P.keyboard.press('Control+A');
    await P.keyboard.type('Creative <b>tools</b>');
    await P.keyboard.press('Enter');
    await sleep(600);
    groups = await get(s, 'start.groups');
    const tileLabel = await A((g) => document.querySelector(`#start .start-group[data-group="${g}"] .start-tile-label`)?.textContent, gid);
    check(groups[0].name === 'Creative  b tools /b' || (groups[0].name.includes('Creative') && !/[<>]/.test(groups[0].name)), `rename inline (markup stripped): "${groups[0].name}"`);
    check(!!(await A(() => document.querySelector('#start .start-folder'))) && tileLabel === groups[0].name, `the popup stays open while renaming; tile label follows ("${tileLabel}")`);
    // Esc in the name field restores it and keeps Start open
    await P.locator('#start .start-folder-name').click();
    await P.keyboard.type('zzz');
    await P.keyboard.press('Escape');
    await sleep(300);
    check((await get(s, 'start.groups'))[0].name === groups[0].name && (await A(() => window.__aurora.start.isOpen)), 'Esc in the name field cancels the rename (Start stays open)');
    // typing letters in the name field never jumps to the Start search box
    check(await A(() => document.querySelector('#start .start-search').value === ''), 'typing in the folder name stays there');
    // drag an app out of the popup: back to Pinned, right after the folder
    const inTile = await rect(s, '#start .start-folder .start-tile[data-app="media"]');
    const fr = await rect(s, '#start .start-folder');
    await drag(s, inTile, { cx: fr.x + 20, cy: fr.b + 60, x: fr.x, w: 40 }, { dwell: 300 });
    groups = await get(s, 'start.groups');
    const k3 = await keys();
    check(!groups[0].apps.includes('media') && k3[k3.indexOf(gid) + 1] === 'media', `dragging an app out of the folder takes it out, next to the folder (${groups[0].apps}; ${k3.slice(0, 12)})`);
    // keyboard: Esc closes the popup, focus back on the folder tile
    await P.keyboard.press('Escape');
    await sleep(400);
    const afterEsc = await A((g) => ({ popup: !!document.querySelector('#start .start-folder-layer:not(.leaving)'), focus: document.activeElement?.dataset?.group === g, start: window.__aurora.start.isOpen }), gid);
    check(!afterEsc.popup && afterEsc.focus && afterEsc.start, `Esc closes the folder, focus back on its tile ${JSON.stringify(afterEsc)}`);
    // F2 on the folder tile renames
    await P.keyboard.press('F2');
    await sleep(500);
    check(await A(() => document.activeElement?.classList.contains('start-folder-name')), 'F2 on a folder opens it with the name field focused');
    await P.keyboard.press('Escape');
    await P.keyboard.press('Escape');
    await sleep(300);
    // dissolve: take apps out until one is left
    for (const app of ['paint', 'terminal', 'snipping']) await A(([g, a]) => window.__aurora.start.folders.take(g, a), [gid, app]);
    await sleep(500);
    groups = await get(s, 'start.groups');
    const k4 = await keys();
    check(!groups.length && k4.includes('notepad') && !k4.some((k) => k.startsWith('g-')) && (await get(s, 'startPinned')).every((k) => !k.startsWith('g-')), `a folder with one app left dissolves; the app takes its place (${k4.slice(0, 12)})`);
    // keyboard path: context menu → Add to folder → New folder with → app
    await A(() => window.__aurora.shell.emit('start:close'));
    await sleep(200);
    await A(() => window.__aurora.shell.emit('start:open'));
    await sleep(800);
    await P.locator('#start .start-tile[data-app="calculator"]').click({ button: 'right' });
    await sleep(300);
    await P.locator('.menu .menu-item', { hasText: 'Add to folder' }).hover();
    await sleep(300);
    await P.locator('.menu .menu-item', { hasText: 'New folder with' }).hover();
    await sleep(300);
    await P.locator('.menu .menu-item', { hasText: 'Notepad' }).last().click();
    await sleep(900);
    groups = await get(s, 'start.groups');
    const renaming = await A(() => document.activeElement?.classList.contains('start-folder-name'));
    check(groups.length === 1 && groups[0].apps.join() === 'calculator,notepad' && renaming, `menu "Add to folder › New folder with › Notepad" makes a folder and opens it to name it (${JSON.stringify(groups)})`);
    await P.keyboard.type('Utilities');
    await P.keyboard.press('Enter');
    await sleep(500);
    check((await get(s, 'start.groups'))[0].name === 'Utilities', 'named from the keyboard');
    await P.keyboard.press('Escape');
    await sleep(300);
    // unpin an app that sits in a folder: out of the folder (and the folder dissolves)
    await A(() => window.__aurora.shell.emit('start:close'));
    await sleep(200);
    // Settings editor: new folder (2+ apps), delete folder → apps back in Pinned, nothing lost
    const pins0 = (await get(s, 'startPinned')).filter((k) => !k.startsWith('g-')).sort().join();
    await A(() => window.__aurora.start.folders.remove(window.__aurora.settings.get('start.groups')[0].id));
    await sleep(400);
    const pins1 = (await get(s, 'startPinned')).filter((k) => !k.startsWith('g-')).sort().join();
    check(pins0 === pins1 && !(await get(s, 'start.groups')).length, 'removing a folder puts its apps back in Pinned (no pin lost)');
    await s.aurora(() => window.__aurora.registry.launch('settings', { page: 'start' }));
    await s.page.waitForSelector(S('.st-page[data-page="start"]'), { timeout: 15000 });
    await A(() => window.__aurora.wm.byApp('settings')[0].maximize());
    await sleep(600);
    await P.locator(S('.pzs-new-folder')).scrollIntoViewIfNeeded();
    await P.locator(S('.pzs-new-folder')).click();
    await sleep(500);
    await P.locator('.dialog .pzs-check', { hasText: 'Chess' }).locator('input').check();
    await P.locator('.dialog .pzs-group-dialog .input').fill('Board games');
    await P.locator('.dialog .btn.primary').click();
    await sleep(600);
    check(!(await get(s, 'start.groups'))?.length && (await A(() => !!document.querySelector('.toast, .st-toast, .app-settings .infobar'))) !== undefined, 'Settings: a folder of one app is refused');
    await P.locator(S('.pzs-new-folder')).click();
    await sleep(500);
    for (const app of ['Chess', 'Solitaire']) await P.locator('.dialog .pzs-check', { hasText: app }).locator('input').check();
    await P.locator('.dialog .pzs-group-dialog .input').fill('Board games');
    await P.locator('.dialog .btn.primary').click();
    await sleep(700);
    groups = await get(s, 'start.groups');
    const sp = await get(s, 'startPinned');
    check(groups.length === 1 && groups[0].name === 'Board games' && groups[0].apps.join() === 'chess,solitaire' && sp.includes(groups[0].id), `Settings: new folder placed in Pinned (${JSON.stringify(groups)})`);
    // moving a pinned app in Settings keeps the folder's slot
    const slot0 = sp.indexOf(groups[0].id);
    await P.locator(S('[data-section="pinned"] .pzs-list-row[data-id="mail"] button')).nth(1).click();
    await sleep(500);
    const sp2 = await get(s, 'startPinned');
    check(sp2.indexOf(groups[0].id) === slot0 && sp2.indexOf('mail') === sp.indexOf('mail') + 1, `Settings ↓ on Mail keeps the folder where it was (slot ${slot0} → ${sp2.indexOf(groups[0].id)})`);
    await docShot(s, 'start-settings-page');
    check(!errorsOf(s).length, `no console errors (${errorsOf(s).slice(0, 3).join(' | ')})`);
  } finally {
    await s.close();
  }
}

// =====================================================================================================================
async function focusPart() {
  console.log('\n# Focus mode');
  const s = await launchShell({ size: '1920x1080', open: ['notepad'], settle: 1500 });
  const A = (fn, a) => s.aurora(fn, a);
  try {
    const state = () =>
      A(() => {
        const d = document.documentElement.dataset;
        const tb = document.getElementById('taskbar');
        return {
          ...window.__aurora.focus.state,
          dnd: !!window.__aurora.settings.get('notifications.dnd'),
          attrs: { focus: d.focus, quiet: d.focusQuiet, dim: d.focusDim, simple: d.focusSimple, noicons: d.focusNoicons },
          veil: Number(getComputedStyle(document.querySelector('.focus-dim')).opacity),
          icons: Number(getComputedStyle(document.querySelector('.desk-icons')).opacity),
          search: !!tb.querySelector('.tb-search') && getComputedStyle(tb.querySelector('.tb-search')).display !== 'none',
          taskview: !!tb.querySelector('.tb-taskview') && getComputedStyle(tb.querySelector('.tb-taskview')).display !== 'none',
          apps: [...tb.querySelectorAll('.tb-app')].map((b) => b.dataset.app),
          pill: tb.querySelector('.tb-focus-pill')?.textContent || null,
          banner: document.querySelector('.focus-banner')?.textContent || null,
        };
      });
    await setMany(s, { 'taskbar.showWidgets': true, 'taskbar.widgets': ['cpu'] });
    await sleep(500);
    const s0 = await state();
    // the Quick settings tile
    await A(() => window.__aurora.shell.emit('quick:toggle'));
    await sleep(700);
    await s.page.locator('#quick-settings [data-key="focus"] button').first().click();
    await sleep(1000);
    const s1 = await state();
    check(s1.active && s1.dnd && s1.attrs.quiet === 'on' && s1.attrs.dim === 'on' && s1.attrs.simple === 'on', `Quick settings tile starts Focus mode: DND on, quiet, dim, simple ${JSON.stringify(s1.attrs)}`);
    check(Math.abs(s1.veil - 0.4) < 0.05 && !s1.search && !s1.taskview && s1.apps.join() === 'notepad' && s0.apps.length > 1, `desktop dimmed (${s1.veil}), taskbar simplified: running apps only (${s1.apps}), no search / task view`);
    check(!!s1.pill && /Focus|min/.test(s1.pill) && /Focus session started/.test(s1.banner || ''), `tray chip "${s1.pill}" and banner "${s1.banner}"`);
    await A(() => window.__aurora.shell.emit('flyouts:close', {}));
    await sleep(450);
    await docShot(s, 'focus-mode-on');
    // a notification during focus: no banner, kept in the center
    await A(() => window.__aurora.notify({ title: 'Quiet please', body: 'x', appId: 'notepad' }));
    await sleep(400);
    check(await A(() => !document.querySelector('.toast') && window.__aurora.notifications.list().some((n) => n.title === 'Quiet please')), 'notifications are hidden (kept in the notification center)');
    // the options apply live during a session
    await setMany(s, { 'focusMode.dimLevel': 70, 'focusMode.hideIcons': true });
    await sleep(900);
    const s2 = await state();
    check(Math.abs(s2.veil - 0.7) < 0.05 && s2.icons < 0.05 && s2.attrs.noicons === 'on', `dim level and hidden icons apply live (veil ${s2.veil}, icons ${s2.icons})`);
    await setMany(s, { 'focusMode.hideNotifications': false });
    await sleep(500);
    check(!(await state()).dnd, 'turning "hide notifications" off during a session gives Do not disturb back');
    await setMany(s, { 'focusMode.hideNotifications': true });
    await sleep(500);
    check((await state()).dnd, '…and on again');
    // Do not disturb switched off by hand (Quick settings) during a session lets notifications through
    await setMany(s, { 'notifications.dnd': false });
    await sleep(400);
    const q = await state();
    check(q.active && !q.attrs.quiet, `DND turned off by hand during a session: notifications come through (quiet ${q.attrs.quiet})`);
    await setMany(s, { 'notifications.dnd': true });
    await sleep(300);
    // stop: everything restored
    await A(() => window.__aurora.shell.emit('focus:stop'));
    await sleep(1000);
    const s3 = await state();
    check(!s3.active && !s3.dnd && !s3.attrs.focus && !s3.attrs.quiet && s3.veil < 0.05 && s3.icons > 0.95 && s3.search && s3.taskview && s3.apps.join() === s0.apps.join() && !s3.pill, `ending restores everything (DND ${s3.dnd}, veil ${s3.veil}, icons ${s3.icons}, apps ${s3.apps})`);
    // DND that was already on stays on afterwards
    await setMany(s, { 'notifications.dnd': true });
    await A(() => window.__aurora.focus.start(25));
    await sleep(600);
    await A(() => window.__aurora.focus.stop());
    await sleep(600);
    check((await get(s, 'notifications.dnd')) === true, 'Do not disturb that was on before stays on after');
    await setMany(s, { 'notifications.dnd': false });
    // the Settings page: start a 50-minute session
    await A(() => window.__aurora.registry.launch('settings', { page: 'focus' }));
    await s.page.waitForSelector(S('.st-page[data-page="focus"]'), { timeout: 15000 });
    await A(() => window.__aurora.wm.byApp('settings')[0].maximize());
    await sleep(500);
    const durOk = await pick(s, '[data-section="duration"]', '50 minutes');
    await s.page.locator(S('.pzs-focus-btn')).click();
    await sleep(1000);
    const s4 = await state();
    const left = Math.round((s4.endsAt - Date.now()) / 60000);
    check(durOk && s4.active && left >= 48 && left <= 50 && /50|49/.test(s4.pill), `Settings page: 50-minute session (${left} min left, chip "${s4.pill}")`);
    const pageText = await A(() => document.querySelector('.app-settings .pzs-focus-sub')?.textContent);
    check(/left/.test(pageText) && /Ends at/.test(pageText), `the page shows the time left and the end time ("${pageText}")`);
    check(await A(() => !!document.querySelector('.app-settings [data-section="hideIcons"] .toggle') && !!document.querySelector('.app-settings [data-section="clock"]')), 'page: hide desktop icons switch + Clock focus sessions row');
    await docShot(s, 'focus-settings-page');
    await A(() => window.__aurora.focus.stop());
    await sleep(500);
    // timed session ends by itself with a notification
    await A(() => window.__aurora.focus.start(0.05));
    await sleep(4500);
    const s5 = await state();
    const ended = await A(() => window.__aurora.notifications.list().some((n) => /Focus session complete/.test(n.title)));
    check(!s5.active && !s5.dnd && ended, `a timed session ends by itself, DND back, "Focus session complete" (${ended})`);
    // Super+Shift+F (customizable action)
    const combo = await A(() => window.__aurora.shell.hotkeys?.combos?.().focusMode);
    check(combo === 'Super+Shift+F', `shortcut for Focus mode: ${combo}`);
    // a real key press through the main process (before-input-event)
    const press = async () => {
      await s.app.evaluate(({ BrowserWindow }) => {
        const wc = BrowserWindow.getAllWindows()[0].webContents;
        wc.sendInputEvent({ type: 'keyDown', keyCode: 'F', modifiers: ['meta', 'shift'] });
        wc.sendInputEvent({ type: 'keyUp', keyCode: 'F', modifiers: ['meta', 'shift'] });
      });
      await sleep(900);
    };
    await press();
    const k1 = (await state()).active;
    await press();
    const k2 = (await state()).active;
    check(k1 && !k2, `Super+Shift+F toggles Focus mode (${k1} → ${k2})`);
    await setMany(s, {}, ['taskbar.showWidgets', 'taskbar.widgets', 'focusMode']);
    check(!errorsOf(s).length, `no console errors (${errorsOf(s).slice(0, 3).join(' | ')})`);
  } finally {
    await s.close();
  }
}

// =====================================================================================================================
async function restartPart() {
  console.log('\n# Restarts: a session survives, an expired one is closed; Start folders and taskbar persist');
  const home = fs.mkdtempSync(path.join(tmp, 'home-'));
  let s = await launchShell({ size: '1280x720', home, settle: 1200 });
  try {
    await s.aurora(() => window.__aurora.focus.start(30));
    await sleep(700);
    await setMany(s, { 'taskbar.position': 'right', 'taskbar.size': 'large', 'start.background': 'glass', 'focusMode.hideIcons': true });
    await s.aurora(() => window.__aurora.start.folders.create('Games', ['chess', 'snake']));
    await sleep(500);
  } finally {
    await s.close();
  }
  s = await launchShell({ size: '1280x720', home, settle: 1800 });
  try {
    const st = await s.aurora(() => ({ ...window.__aurora.focus.state, dnd: window.__aurora.settings.get('notifications.dnd'), pill: document.querySelector('.tb-focus-pill')?.textContent, pos: document.documentElement.dataset.tbPos, w: Math.round(document.getElementById('taskbar').getBoundingClientRect().width) }));
    const left = Math.round((st.endsAt - Date.now()) / 60000);
    check(st.active && st.dnd && st.quiet && st.noIcons && left >= 28 && left <= 30 && /min/.test(st.pill || ''), `after a restart the session goes on (${left} min left, chip "${st.pill}", DND ${st.dnd})`);
    check(st.pos === 'right' && st.w === 72, `taskbar edge and size persist (${st.pos}, ${st.w}px)`);
    await s.aurora(() => window.__aurora.shell.emit('start:open'));
    await sleep(800);
    check(await s.aurora(() => !!document.querySelector('#start .start-group') && document.getElementById('start').dataset.bg === 'glass'), 'Start folder and background persist');
    await docShot(s, 'focus-after-restart');
    await sleep(800); // (settings are saved with a short debounce)
  } finally {
    await s.close();
  }
  // the session's end time passes while the shell is not running
  const file = path.join(home, '.config', 'aurora', 'settings.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  check(saved.focusMode?.active === true && saved.focusMode?.prevDnd === false && saved.notifications?.dnd === true, `the running session is saved (${JSON.stringify(saved.focusMode)})`);
  saved.focusMode.endsAt = Date.now() - 60000;
  fs.writeFileSync(file, JSON.stringify(saved));
  s = await launchShell({ size: '1280x720', home, settle: 1800 });
  try {
    await sleep(800);
    const st = await s.aurora(() => ({ ...window.__aurora.focus.state, dnd: window.__aurora.settings.get('notifications.dnd'), ended: window.__aurora.notifications.list().some((n) => /Focus session complete/.test(n.title)) }));
    check(!st.active && !st.dnd && !st.quiet && st.ended, `a session that expired meanwhile is closed at start-up, DND restored ${JSON.stringify(st)}`);
    check(!errorsOf(s).length, `no console errors (${errorsOf(s).slice(0, 3).join(' | ')})`);
  } finally {
    await s.close();
  }
}

// =====================================================================================================================
async function stylesPart() {
  console.log('\n# Visual styles × vertical large taskbar × Start with an open folder; tricky combinations');
  const s = await launchShell({ size: '1920x1080', open: ['notepad'], settle: 1500 });
  const A = (fn, a) => s.aurora(fn, a);
  try {
    const gid = await A(() => window.__aurora.start.folders.create('Games', ['chess', 'snake', 'solitaire', 'minesweeper']));
    await sleep(400);
    for (const [style, theme] of [['win11', 'light'], ['minimal', 'light'], ['glass', 'dark'], ['retro', 'light'], ['contrast', 'dark']]) {
      await setMany(s, { style, theme, 'taskbar.position': style === 'retro' ? 'right' : 'left', 'taskbar.size': 'large', 'taskbar.widgets': ['cpu'], 'taskbar.showWidgets': true });
      await sleep(700);
      await A(() => window.__aurora.shell.emit('start:open'));
      await sleep(700);
      await A((g) => window.__aurora.start.folders.open(g), gid);
      await sleep(700);
      const v = await A(() => {
        const tb = document.getElementById('taskbar').getBoundingClientRect();
        const out = [...document.querySelectorAll('#taskbar .tb-btn:not([hidden])')].filter((b) => b.offsetParent).map((b) => b.getBoundingClientRect()).filter((q) => q.left < tb.left - 1 || q.right > tb.right + 1 || q.top < tb.top - 1 || q.bottom > tb.bottom + 1).length;
        const tray = document.querySelector('#taskbar .tb-tray').getBoundingClientRect();
        const st = document.getElementById('start').getBoundingClientRect();
        const folder = document.querySelector('#start .start-folder')?.getBoundingClientRect();
        return { out, trayInside: tray.top >= tb.top - 1 && tray.bottom <= tb.bottom + 1, startOk: st.left >= 0 && st.right <= innerWidth && st.top >= 0 && st.bottom <= innerHeight, folderOk: !!folder && folder.left >= st.left && folder.right <= st.right };
      });
      check(v.out === 0 && v.trayInside && v.startOk && v.folderOk, `${style}/${theme}: vertical large bar, Start and the folder popup lay out ${JSON.stringify(v)}`);
      await docShot(s, `start-folder-${style}-${theme}`);
      await A(() => window.__aurora.shell.emit('start:close'));
      await sleep(300);
    }
    // retro + glass blur + vertical + large text + per-app dark theme
    await setMany(s, { style: 'retro', theme: 'light', blur: 100, 'start.background': 'glass', textScale: 150, 'taskbar.position': 'left', 'taskbar.size': 'small', appThemes: { notepad: { theme: 'dark', accent: null } } });
    await A(() => window.__aurora.focus.start(25));
    await sleep(1200);
    const mix = await A(() => {
      const tb = document.getElementById('taskbar').getBoundingClientRect();
      const clock = document.querySelector('#taskbar .tb-clock').getBoundingClientRect();
      const pill = document.querySelector('#taskbar .tb-focus-pill')?.getBoundingClientRect();
      return { clockIn: clock.left >= tb.left - 1 && clock.right <= tb.right + 1, pillIn: !!pill && pill.left >= tb.left - 1 && pill.right <= tb.right + 1, theme: window.__aurora.wm.byApp('notepad')[0].el.dataset.theme };
    });
    check(mix.clockIn && mix.pillIn && mix.theme === 'dark', `retro + glass Start + 150 % text + small left bar + dark Notepad + focus: clock and chip fit ${JSON.stringify(mix)}`);
    await docShot(s, 'focus-retro-mix');
    await A(() => window.__aurora.focus.stop());
    await setMany(s, {}, ['style', 'blur', 'start.background', 'textScale', 'taskbar.position', 'taskbar.size', 'appThemes', 'taskbar.widgets', 'taskbar.showWidgets']);
    check(!errorsOf(s).length, `no console errors (${errorsOf(s).slice(0, 3).join(' | ')})`);
  } finally {
    await s.close();
  }
}

// =====================================================================================================================
async function i18nPart() {
  console.log('\n# French + dark: Settings pages, Start, focus banner');
  for (const [lang, theme, size] of [['fr', 'dark', '1280x720'], ['en', 'light', '1920x1080']]) {
    const s = await launchShell({ size, lang, theme, settle: 1500 });
    const A = (fn, a) => s.aurora(fn, a);
    try {
      for (const page of ['taskbar', 'start', 'focus']) {
        await go(s, page);
        const scan = await A(() => {
          const root = document.querySelector('.app-settings .st-page');
          const text = root.innerText;
          const raw = text.match(/\b(pzs|pers|start|focus|taskbar)\.[a-zA-Z_]+\b/g) || [];
          const over = [...root.querySelectorAll('.st-row-title, .st-row-desc, .st-combo-text, .btn, .st-group-title')].filter((e) => e.scrollWidth > e.clientWidth + 2 && getComputedStyle(e).textOverflow !== 'ellipsis' && getComputedStyle(e).overflow !== 'visible').map((e) => e.textContent.slice(0, 40));
          const page = root.getBoundingClientRect();
          const wide = [...root.querySelectorAll('.st-row')].filter((r) => r.getBoundingClientRect().right > page.right + 2).length;
          return { raw, over, wide };
        });
        check(!scan.raw.length && !scan.over.length && !scan.wide, `[${lang}/${theme}] Settings > ${page}: no raw keys ${scan.raw.slice(0, 3)}, no clipped text ${scan.over.slice(0, 3)}, rows fit (${scan.wide})`);
        if (lang === 'fr') await docShot(s, `${page === 'focus' ? 'focus' : page}-settings-${lang}-${theme}`);
      }
      await closeApps(s, 'settings');
      if (lang === 'fr') {
        await A(() => window.__aurora.start.folders.create(undefined, ['chess', 'snake']));
        await A(() => window.__aurora.focus.start(25));
        await sleep(700);
        const fr = await A(() => ({ banner: document.querySelector('.focus-banner')?.textContent, pill: document.querySelector('.tb-focus-pill')?.dataset.tip, folder: window.__aurora.settings.get('start.groups')[0]?.name }));
        check(/Session de concentration démarrée/.test(fr.banner || '') && /restantes/.test(fr.pill || '') && fr.folder === 'Dossier', `French banner / chip / default folder name ${JSON.stringify(fr)}`);
        await A(() => window.__aurora.shell.emit('start:open'));
        await sleep(800);
        await docShot(s, 'focus-start-fr-dark');
        await A(() => window.__aurora.focus.stop());
      }
      check(!errorsOf(s).length, `[${lang}] no console errors (${errorsOf(s).slice(0, 3).join(' | ')})`);
    } finally {
      await s.close();
    }
  }
}

// =====================================================================================================================
async function securityPart() {
  console.log('\n# Security: hostile profile values for the B2 keys');
  const s = await launchShell({ size: '1280x720', settle: 1200 });
  const A = (fn, a) => s.aurora(fn, a);
  try {
    const res = await A(async () => {
      const { profiles } = await import('app://shell/core/profiles.js');
      const evil = {
        format: 'aurora-profile',
        version: 1,
        name: 'Evil <img src=x onerror=alert(1)>',
        values: {
          'taskbar.widgetsPos': 'end;}body{display:none',
          'taskbar.tray': { network: 'x', volume: false, battery: true, '__proto__': { polluted: 1 } },
          'taskbar.hideDelay': '600);background:url(http://evil',
          'taskbar.badges': 'yes',
          'start.background': 'url(javascript:alert(1))',
          'start.showMostUsed': 1,
          'start.groups': [{ id: 'g-evil1', name: '<img src=x onerror="window.__pwned=1">', apps: ['notepad', 'calculator', '../../etc'] }, { id: 'x"><script>', name: 'bad', apps: ['a', 'b'] }],
          focusMode: { dimLevel: '1;background:red', duration: 99999, endsAt: 'soon', prevDnd: 'x', hideIcons: true },
          showSeconds: 'true',
        },
      };
      const p = await profiles.importJson(JSON.stringify(evil));
      await profiles.apply(p.id);
      await new Promise((r) => setTimeout(r, 900));
      const S = window.__aurora.settings;
      window.__aurora.shell.emit('start:open');
      await new Promise((r) => setTimeout(r, 900));
      return {
        values: p.values,
        widgetsPos: S.get('taskbar.widgetsPos'),
        tray: S.get('taskbar.tray'),
        hideDelay: S.get('taskbar.hideDelay'),
        bg: S.get('start.background'),
        groups: S.get('start.groups'),
        focus: S.get('focusMode'),
        pwned: !!window.__pwned || !!document.querySelector('#start img[src="x"]'),
        polluted: ({}).polluted,
        startBg: document.getElementById('start').dataset.bg || null,
        dim: getComputedStyle(document.documentElement).getPropertyValue('--focus-dim'),
      };
    });
    check(res.widgetsPos === 'auto' && res.tray.network === true && res.hideDelay === 600 && res.bg === 'acrylic' && !res.startBg, `invalid taskbar / Start values are dropped (${JSON.stringify({ w: res.widgetsPos, t: res.tray, d: res.hideDelay, bg: res.bg })})`);
    check(res.groups.length === 1 && res.groups[0].id === 'g-evil1' && !/[<>]/.test(res.groups[0].name) && !res.groups[0].apps.includes('../../etc'), `folder names are stripped of markup, bad ids refused ${JSON.stringify(res.groups)}`);
    check(!res.pwned && res.polluted === undefined, 'no HTML injection, no prototype pollution');
    check(res.focus.dimLevel === 40 && res.focus.duration === 0 && res.focus.hideIcons === true && res.focus.endsAt === 0 && res.focus.prevDnd === null, `focusMode: bad numbers dropped, runtime state never imported ${JSON.stringify(res.focus)}`);
    check(!errorsOf(s).length, `no console errors (${errorsOf(s).slice(0, 3).join(' | ')})`);
  } finally {
    await s.close();
  }
}

// =====================================================================================================================
async function perfPart() {
  console.log('\n# Leaks: 20 × focus on/off, 20 × edge change');
  const s = await launchShell({ size: '1280x720', open: ['notepad'], settle: 1200 });
  const A = (fn, a) => s.aurora(fn, a);
  try {
    const snap = () => A(() => ({ nodes: document.getElementsByTagName('*').length, veils: document.querySelectorAll('.focus-dim').length, hot: document.querySelectorAll('.tb-hotzone').length, banners: document.querySelectorAll('.focus-banner').length, heap: performance.memory?.usedJSHeapSize || 0 }));
    await A(() => window.__aurora.focus.start(25));
    await sleep(500);
    await A(() => window.__aurora.focus.stop());
    await sleep(800);
    const before = await snap();
    const t0 = Date.now();
    for (let i = 0; i < 20; i++) {
      await A(() => window.__aurora.focus.start(25));
      await A(() => window.__aurora.focus.stop());
    }
    const focusMs = Date.now() - t0;
    const t1 = Date.now();
    for (let i = 0; i < 20; i++) await setMany(s, { 'taskbar.position': ['top', 'left', 'right', 'bottom'][i % 4], 'taskbar.size': ['small', 'large'][i % 2] });
    const edgeMs = Date.now() - t1;
    await setMany(s, {}, ['taskbar.position', 'taskbar.size']);
    await sleep(4500);
    const after = await snap();
    check(after.veils === 1 && after.hot === 1 && after.banners === 0, `one veil, one hot zone, no banner left ${JSON.stringify(after)}`);
    check(Math.abs(after.nodes - before.nodes) < 40, `DOM size stable (${before.nodes} → ${after.nodes})`);
    check(focusMs / 20 < 400 && edgeMs / 20 < 600, `fast enough in software rendering: focus on+off ${Math.round(focusMs / 20)} ms, edge change ${Math.round(edgeMs / 20)} ms`);
    // no extra timers / listeners: the taskbar re-lays only when taskbar.* changes
    const relay = await A(async () => {
      let n = 0;
      const mo = new MutationObserver(() => n++);
      mo.observe(document.getElementById('taskbar'), { childList: true });
      await window.__aurora.api.invoke('settings:setMany', { accent: '#c239b3' });
      await new Promise((r) => setTimeout(r, 300));
      await window.__aurora.api.invoke('settings:setMany', { accent: '#0078d4' });
      await new Promise((r) => setTimeout(r, 300));
      mo.disconnect();
      return n;
    });
    check(relay === 0, `a change of another key does not rebuild the taskbar (${relay} rebuilds)`);
    check(!errorsOf(s).length, `no console errors (${errorsOf(s).slice(0, 3).join(' | ')})`);
  } finally {
    await s.close();
  }
}

// =====================================================================================================================
const parts = [
  ['geometry', async () => (await geometryPart('1280x720'), await geometryPart('1920x1080'))],
  ['taskbar', taskbarPart],
  ['autohide', autohidePart],
  ['start', startPart],
  ['folders', foldersPart],
  ['focus', focusPart],
  ['restart', restartPart],
  ['styles', stylesPart],
  ['i18n', i18nPart],
  ['security', securityPart],
  ['perf', perfPart],
];
for (const [name, fn] of parts) {
  if (!run(name)) continue;
  try {
    await fn();
  } catch (err) {
    check(false, `${name}: ${err.stack || err.message}`);
  }
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  ✗ ${f}`);
process.exit(failures.length ? 1 : 0);
