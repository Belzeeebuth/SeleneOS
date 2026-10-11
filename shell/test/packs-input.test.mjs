// Personalization area B3 — cursor packs, icon packs, sound packs (notification / startup / shutdown sounds), snap
// layout presets and customizable keyboard shortcuts (docs/PERSONALIZATION.md §11, §12). Drives the real shell.
//
//   xvfb-run -a -s "-screen 0 1600x900x24" node test/packs-input.test.mjs [--no-shots] [--only=ui,cursors,icons,sounds,snap,shortcuts,profiles,i18n,perf,styles,restart]
//
// Screenshots: docs/screenshots/packs-*.png, shortcuts-*.png, snap-presets-*.png
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
const S = (sel) => `.app-settings ${sel}`;
async function docShot(s, name) {
  if (NO_SHOTS) return;
  const f = await s.shot(name);
  fs.mkdirSync(DOCS, { recursive: true });
  fs.copyFileSync(f, path.join(DOCS, `${name}.png`));
}
const errorsOf = (s) => s.logs.filter((l) => /^\[(error|pageerror)\]/.test(l) && !/Failed to load resource/.test(l));

// ------------------------------------------------------------------ helpers
const get = (s, key) => s.aurora((k) => window.__aurora.settings.get(k), key);
const set = (s, key, v) => s.aurora(([k, x]) => window.__aurora.settings.set(k, x), [key, v]);
const setMany = (s, patch, reset) => s.aurora(([p, r]) => window.__aurora.api.invoke('settings:setMany', p, r ? { reset: r } : {}), [patch, reset || null]);
async function go(s, page, { maximize = true } = {}) {
  await s.aurora((p) => window.__aurora.registry.launch('settings', { page: p }), page);
  await s.page.waitForSelector(S(`.st-page[data-page="${page}"]`), { timeout: 10000 });
  await s.aurora((max) => {
    const w = window.__aurora.wm.byApp('settings')[0];
    w.focus();
    if (max && w.state !== 'maximized') w.maximize();
  }, maximize);
  await sleep(500);
}
async function closeApps(s, ids) {
  await s.aurora((list) => list.forEach((id) => window.__aurora.wm.byApp(id).forEach((w) => w.close(true))), ids);
  await sleep(400);
}
// Real key presses through main/lib/hotkeys.js (before-input-event): Playwright's CDP key events never reach it.
const MODS = { Super: 'meta', Ctrl: 'control', Alt: 'alt', Shift: 'shift' };
async function press(s, combo, { up = true } = {}) {
  const parts = combo.split('+');
  const key = parts.pop();
  const mods = parts.map((p) => MODS[p]);
  await s.app.evaluate(({ BrowserWindow }, [k, m, u]) => {
    const wc = BrowserWindow.getAllWindows()[0].webContents;
    wc.sendInputEvent({ type: 'keyDown', keyCode: k, modifiers: m });
    if (u) wc.sendInputEvent({ type: 'keyUp', keyCode: k, modifiers: m });
  }, [key, mods, up]);
  await sleep(300);
}
async function keyUp(s, key, mods = []) {
  await s.app.evaluate(({ BrowserWindow }, [k, m]) => BrowserWindow.getAllWindows()[0].webContents.sendInputEvent({ type: 'keyUp', keyCode: k, modifiers: m }), [key, mods]);
  await sleep(200);
}
// WebAudio spy: oscillators (frequency, type) and gain peaks of every tone the shell plays.
async function spyAudio(s) {
  await s.aurora(() => {
    if (window.__osc) return;
    window.__osc = [];
    window.__peaks = [];
    const orig = AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator = function () {
      const o = orig.call(this);
      const setF = o.frequency.setValueAtTime.bind(o.frequency);
      const rec = { type: () => o.type, freq: null };
      o.frequency.setValueAtTime = (v, t) => {
        if (rec.freq == null) rec.freq = v;
        return setF(v, t);
      };
      window.__osc.push(rec);
      return o;
    };
    const ramp = AudioParam.prototype.exponentialRampToValueAtTime;
    AudioParam.prototype.exponentialRampToValueAtTime = function (v, t) {
      if (v > 0.0002) window.__peaks.push(v);
      return ramp.call(this, v, t);
    };
  });
}
const audioOf = async (s, fn, wait = 150) => {
  await s.aurora(() => {
    window.__osc.length = 0;
    window.__peaks.length = 0;
  });
  await fn();
  await sleep(wait);
  return s.aurora(() => ({ n: window.__osc.length, types: [...new Set(window.__osc.map((o) => o.type()))], freqs: window.__osc.map((o) => o.freq), peak: Math.max(0, ...window.__peaks) }));
};
const imgSize = (s, url) =>
  s.aurora(
    (u) =>
      new Promise((res) => {
        const i = new Image();
        i.onload = () => res({ w: i.naturalWidth, h: i.naturalHeight });
        i.onerror = () => res(null);
        i.src = u;
      }),
    url,
  );

// =====================================================================================================================
async function cursorsPart() {
  console.log('\n# Cursor packs');
  const s = await launchShell({ theme: 'light', lang: 'en', open: ['notepad'] });
  const A = (fn, a) => s.aurora(fn, a);
  try {
    const packIds = await A(() => import('app://shell/core/packs.js').then((m) => m.CURSOR_PACKS.map((p) => p.id)));
    check(packIds.length >= 5 && ['default', 'classic', 'midnight', 'large', 'retro', 'accent'].every((p) => packIds.includes(p)), `cursor packs: ${packIds.join(', ')}`);
    await go(s, 'cursors', { maximize: false });
    // representative elements: body (arrow), button (hand), text field (I-beam), window edge (resize), link (hand)
    await A(() => {
      const a = document.createElement('a');
      a.href = '#';
      a.id = 'cur-probe-link';
      a.textContent = 'link';
      const g = document.createElement('div');
      g.id = 'cur-probe-inline';
      g.style.cursor = 'grab';
      g.textContent = 'grab';
      document.getElementById('overlays').append(a, g);
    });
    const read = () =>
      A(() => {
        const cur = (sel) => {
          const e = document.querySelector(sel);
          return e ? getComputedStyle(e).cursor : null;
        };
        return {
          body: cur('body'),
          button: cur('#taskbar .tb-app, #taskbar button'),
          input: cur('.app-settings input.input'),
          resize: cur('.win[data-app="notepad"] .win-resize.r-e'),
          resizeNW: cur('.win[data-app="notepad"] .win-resize.r-nw') || cur('.win[data-app="notepad"] .win-resize.r-tl'),
          link: cur('#cur-probe-link'),
          inline: cur('#cur-probe-inline'),
          vars: document.getElementById('aurora-cursor-vars')?.textContent.length || 0,
          attr: document.documentElement.dataset.cursorPack,
        };
      });
    const urls = {};
    for (const id of packIds) {
      await s.page.locator(S(`.pzs-card[data-pack="${id}"]`)).click();
      await sleep(350);
      const c = await read();
      const isUrl = (v) => typeof v === 'string' && v.startsWith('url("data:image/png');
      if (id === 'default') check(!isUrl(c.body) && !isUrl(c.input) && !c.vars && c.attr === 'default', `System pack: no variables, plain cursors (${c.body}, ${c.input}, ${c.resize})`);
      else {
        const notUrl = ['body', 'button', 'input', 'resize', 'link', 'inline'].filter((k) => !isUrl(c[k])).map((k) => `${k}=${String(c[k]).slice(0, 40)}`);
        check(!notUrl.length && c.attr === id, `${id}: arrow, hand, I-beam, window resize, link and inline (el.style.cursor = 'grab') cursors are the pack's images (${notUrl.join('; ') || 'ok'})`);
        check(/, ew-resize$/.test(c.resize) && /, text$/.test(c.input) && /, grab$/.test(c.inline), `${id}: each image falls back to its keyword (${c.resize.slice(-12)}, ${c.inline.slice(-6)})`);
        urls[id] = c.body;
      }
    }
    check(new Set(Object.values(urls)).size === Object.keys(urls).length, `every pack draws its own arrow (${Object.keys(urls).length} distinct images)`);
    // every pack defines every shape with a hot spot inside the image
    const shapes = await A(() =>
      import('app://shell/core/packs.js').then((m) => {
        const bad = [];
        for (const p of m.CURSOR_PACKS.filter((x) => x.id !== 'default')) for (const sh of m.CURSOR_SHAPES) {
          const c = window.__aurora.packs.cursorInfo(p.id, sh);
          if (!c || !c.url.startsWith('data:image/png') || c.x < 0 || c.y < 0 || c.x >= c.size || c.y >= c.size) bad.push(`${p.id}/${sh}`);
        }
        return { n: m.CURSOR_SHAPES.length, bad, kw: m.CURSOR_KEYWORDS.length };
      }),
    );
    check(!shapes.bad.length && shapes.n >= 16 && shapes.kw >= 28, `every pack draws ${shapes.n} shapes for ${shapes.kw} CSS cursor keywords with hot spots inside the image (bad: ${shapes.bad.join(',') || 'none'})`);
    const hot = await A(() => ({ arrow: window.__aurora.packs.cursorInfo('classic', 'arrow'), text: window.__aurora.packs.cursorInfo('classic', 'text'), hand: window.__aurora.packs.cursorInfo('classic', 'hand') }));
    check(hot.arrow.x <= 5 && hot.arrow.y <= 3 && Math.abs(hot.text.x - hot.text.size / 2) <= 1 && hot.hand.y <= 3, `hot spots: arrow tip ${hot.arrow.x},${hot.arrow.y}; I-beam centre ${hot.text.x},${hot.text.y}; finger tip ${hot.hand.x},${hot.hand.y}`);
    // coverage: no plain cursor keyword left in the shell's style sheets while a pack is on
    const audit = await A(() => {
      const KW = /^(default|pointer|text|move|grab|grabbing|crosshair|not-allowed|wait|progress|help|[a-z]+-resize|cell|all-scroll|no-drop|vertical-text)$/;
      const left = [];
      const walk = (rules, href) => {
        for (const r of rules) {
          if (r.style && KW.test(r.style.getPropertyValue('cursor').trim())) left.push(`${href.split('/').slice(-2).join('/')}: ${r.selectorText}`);
          if (r.cssRules) walk(r.cssRules, href);
        }
      };
      let sheets = 0;
      for (const sh of document.styleSheets) {
        if (sh.href && !sh.href.startsWith('app://shell/')) continue;
        try {
          walk(sh.cssRules, sh.href || 'inline');
          sheets++;
        } catch {}
      }
      return { sheets, left: left.slice(0, 8), n: left.length };
    });
    check(audit.n === 0 && audit.sheets > 10, `all ${audit.sheets} shell + app style sheets use the cursor variables (plain keywords left: ${audit.n} ${audit.left.join(' | ')})`);
    // an app style sheet loaded after the pack follows too
    await A(() => window.__aurora.registry.launch('calculator'));
    await sleep(1200);
    const late = await A(() => [...document.querySelectorAll('.app-calculator button')].slice(0, 3).map((b) => getComputedStyle(b).cursor.slice(0, 16)));
    check(late.length && late.every((c) => c.startsWith('url(') || c === 'default' || c === 'auto'), `an app opened later (Calculator) gets the pack too (${late.join(' | ')})`);
    await closeApps(s, ['calculator']);

    // size
    await s.page.locator(S('.pzs-card[data-pack="classic"]')).click();
    const before = await imgSize(s, await A(() => window.__aurora.packs.cursorInfo('classic', 'arrow').url));
    const sl = s.page.locator(S('[data-section="cursorSize"] input.slider')).first();
    await sl.scrollIntoViewIfNeeded();
    await sl.focus();
    for (let i = 0; i < 4; i++) await s.page.keyboard.press('ArrowRight');
    await sleep(600);
    const sz = await A(() => ({ v: window.__aurora.settings.get('cursorSize'), css: getComputedStyle(document.body).cursor }));
    const big = await imgSize(s, sz.css.match(/url\("([^"]+)"\)/)[1]);
    check(sz.v === 200 && before?.w === 24 && big?.w === 48, `size slider: cursorSize ${sz.v}% → arrow ${before?.w}px → ${big?.w}px, live`);
    // the system pack cannot grow: it is drawn as Aurora light when bigger
    await s.page.locator(S('.pzs-card[data-pack="default"]')).click();
    await sleep(400);
    const sys = await A(() => ({ body: getComputedStyle(document.body).cursor.slice(0, 26), drawn: window.__aurora.packs.cursorDrawn, attr: document.documentElement.dataset.cursorPack }));
    check(sys.body.startsWith('url("data:image/png') && sys.drawn === 'classic' && sys.attr === 'default', `System pack at 200 % is drawn as Aurora light (${JSON.stringify(sys)})`);
    // the preview grid shows every pointer and is hoverable
    const grid = await A(() => ({ n: document.querySelectorAll('.app-settings .pzb-cursor-cell').length, imgs: document.querySelectorAll('.app-settings .pzb-cursor-cell img').length, cur: getComputedStyle(document.querySelector('.app-settings .pzb-cursor-cell[data-kw="wait"]')).cursor.slice(0, 20) }));
    check(grid.n >= 16 && grid.imgs === grid.n && grid.cur.startsWith('url('), `preview grid: ${grid.n} pointers with names; hovering "Busy" shows it (${grid.cur})`);
    await set(s, 'cursorSize', 100);
    await s.page.locator(S('.pzs-card[data-pack="accent"]')).click();
    await sleep(300);
    const a1 = await A(() => getComputedStyle(document.body).cursor);
    await set(s, 'accent', '#e81123');
    await sleep(400);
    const a2 = await A(() => getComputedStyle(document.body).cursor);
    check(a1 !== a2, 'Accent color pack is redrawn when the accent changes');
    // (the probe elements are hidden for the picture, they are read again below)
    await A(() => document.querySelectorAll('#cur-probe-link, #cur-probe-inline').forEach((e) => (e.style.visibility = 'hidden')));
    await docShot(s, 'packs-cursors');
    // keyboard: the pack cards are a radio group (arrows move and select)
    await s.page.locator(S('.pzs-card[data-pack="accent"]')).focus();
    await s.page.keyboard.press('ArrowRight');
    await s.page.keyboard.press('Enter');
    await sleep(300);
    check((await get(s, 'cursorPack')) === 'large', `arrow keys + Enter pick the next pack (${await get(s, 'cursorPack')})`);
    await set(s, 'cursorPack', 'default');
    await sleep(300);
    const off = await A(() => ({ body: getComputedStyle(document.body).cursor, inline: getComputedStyle(document.getElementById('cur-probe-inline')).cursor }));
    check(!off.body.startsWith('url(') && off.inline === 'grab', `back to System: plain cursors (${off.body}, inline ${off.inline})`);
    check(!errorsOf(s).length, `no console errors (${errorsOf(s).join(' | ')})`);
  } finally {
    await s.close();
  }
}

// =====================================================================================================================
async function iconsPart() {
  console.log('\n# Icon packs');
  const s = await launchShell({ theme: 'light', lang: 'en', open: ['notepad', 'files'] });
  const A = (fn, a) => s.aurora(fn, a);
  try {
    const ids = await A(() => import('app://shell/core/packs.js').then((m) => m.ICON_PACKS.map((p) => p.id)));
    check(['fluent', 'mono', 'glass', 'retro', 'graphite', 'tiles'].every((x) => ids.includes(x)), `icon packs: ${ids.join(', ')}`);
    await A(() => window.__aurora.notify({ title: 'Icon test', body: 'toast', appId: 'notepad' }));
    await sleep(300);
    const where = () =>
      A(() => {
        const src = (sel) => document.querySelector(sel)?.getAttribute('src') || null;
        const content = (sel) => {
          const e = document.querySelector(sel);
          return e ? getComputedStyle(e).content : null;
        };
        return {
          taskbar: src('#taskbar .tb-app[data-app="notepad"] img'),
          title: window.__aurora.wm.byApp('notepad')[0]?.iconEl?.getAttribute('src'),
          toast: src('#toasts img'),
          pack: document.documentElement.dataset.iconPack,
          thisPc: content('#desktop [data-special="thispc"] img'),
          trash: content('#desktop [data-special="trash"] img'),
          filesThisPc: content('.app-files img[src$="this-pc.svg"]'),
        };
      });
    const f0 = await where();
    check(f0.taskbar?.startsWith('app://shell/apps/notepad/') && f0.title?.startsWith('app://shell/apps/notepad/') && f0.pack === 'fluent' && (f0.thisPc === 'normal' || f0.thisPc === 'none' || !f0.thisPc?.startsWith('url')), `Fluent color: the apps' own icons (${f0.taskbar})`);
    await go(s, 'iconPacks', { maximize: false });
    const seen = {};
    for (const id of ids.filter((x) => x !== 'fluent')) {
      await s.page.locator(S(`.pzs-card[data-pack="${id}"]`)).click();
      // (a toast only lives a few seconds: post a fresh one for every pack)
      await A(() => window.__aurora.notify({ title: 'Icon test', body: 'toast', appId: 'notepad' }));
      await sleep(500);
      const w = await where();
      const want = id === 'retro' ? 'data:image/png' : 'data:image/svg+xml';
      // open Start, Alt+Tab and Task view to read their icons too
      await A(() => window.__aurora.shell.emit('start:toggle'));
      await sleep(500);
      const start = await A(() => document.querySelector('#start .start-pinned img, #start img')?.getAttribute('src') || '');
      await A(() => window.__aurora.shell.emit('start:close'));
      await sleep(300);
      await A(() => window.__aurora.hotkeys.trigger('Alt+Tab'));
      await sleep(500);
      const alt = await A(() => document.querySelector('.alttab img')?.getAttribute('src') || '');
      await A(() => window.__aurora.hotkeys.trigger('Alt:up'));
      await sleep(400);
      await A(() => window.__aurora.wm.byApp('settings')[0].focus());
      await sleep(200);
      seen[id] = w.taskbar;
      check(
        w.taskbar?.startsWith(want) && w.title?.startsWith(want) && w.toast?.startsWith(want) && start.startsWith(want) && alt.startsWith(want) && w.pack === id && w.thisPc?.startsWith('url("data:') && w.trash?.startsWith('url("data:'),
        `${id}: taskbar, title bar, notification, Start, Alt+Tab, desktop This PC / Recycle Bin all in the pack (${Object.entries({ ...w, start, alt }).filter(([k, v]) => k !== 'filesThisPc' && !(k === 'pack' ? v === id : String(v).startsWith(k === 'thisPc' || k === 'trash' ? 'url("data:' : want))).map(([k, v]) => `${k}=${String(v).slice(0, 30)}`).join('; ') || 'ok'})`,
      );
      if (id === 'retro') check(w.filesThisPc == null || w.filesThisPc.startsWith('url("data:'), `File Explorer's This PC picture follows the pack too (${(w.filesThisPc || 'not shown').slice(0, 24)})`);
      if (id === 'retro' || id === 'glass' || id === 'mono') await docShot(s, `packs-icons-${id}`);
    }
    check(new Set(Object.values(seen)).size === Object.keys(seen).length, `each pack has its own picture (${Object.keys(seen).length} distinct)`);
    // retro icons are crisp 48 px pixel art
    const retro = await A(() => window.__aurora.packs.appIcon('retro', 'files'));
    const rs = await imgSize(s, retro);
    check(rs?.w === 48 && rs?.h === 48, `retro icon is a 48 px PNG (${JSON.stringify(rs)})`);
    // monochrome follows the mode; in a window of the other mode it is inverted
    await s.page.locator(S('.pzs-card[data-pack="mono"]')).click();
    await sleep(400);
    const m1 = await A(() => document.querySelector('#taskbar .tb-app[data-app="notepad"] img').getAttribute('src'));
    await set(s, 'theme', 'dark');
    await sleep(700);
    const m2 = await A(() => document.querySelector('#taskbar .tb-app[data-app="notepad"] img').getAttribute('src'));
    check(m1 !== m2 && decodeURIComponent(m1).includes('#1f1f1f') && decodeURIComponent(m2).includes('#f3f3f3'), 'Monochrome icons are redrawn for dark mode (dark glyphs → light glyphs)');
    await setMany(s, { appThemes: { notepad: { theme: 'light', accent: null } } });
    await sleep(600);
    const inv = await A(() => getComputedStyle(window.__aurora.wm.byApp('notepad')[0].iconEl).filter);
    check(/invert/.test(inv), `a light-themed window in dark mode inverts its monochrome icon (${inv})`);
    await setMany(s, { appThemes: {}, theme: 'light' });
    // accent tiles follow the accent
    await s.page.locator(S('.pzs-card[data-pack="accent"]')).click();
    await sleep(300);
    const ac1 = await A(() => document.querySelector('#taskbar .tb-app[data-app="notepad"] img').getAttribute('src'));
    await set(s, 'accent', '#107c10');
    await sleep(500);
    const ac2 = await A(() => document.querySelector('#taskbar .tb-app[data-app="notepad"] img').getAttribute('src'));
    check(ac1 !== ac2 && decodeURIComponent(ac2).includes('#107c10'), 'Accent tiles are redrawn when the accent changes');
    // back to Fluent: everything back to the apps' own files, the CSS hook removed
    await s.page.locator(S('.pzs-card[data-pack="fluent"]')).click();
    await A(() => window.__aurora.notify({ title: 'Icon test', body: 'toast', appId: 'notepad' }));
    await sleep(500);
    const f1 = await where();
    check(f1.taskbar?.startsWith('app://') && f1.title?.startsWith('app://') && f1.toast?.startsWith('app://') && !(await A(() => !!document.getElementById('aurora-iconpack-css'))), `back to Fluent: the apps’ own icons everywhere, no icon style sheet (${f1.taskbar?.slice(0, 30)}, ${f1.title?.slice(0, 30)}, ${f1.toast?.slice(0, 30)})`);
    // the Settings previews never swap
    const fixed = await A(() => [...document.querySelectorAll('.app-settings .pzs-card[data-pack="glass"] img')].every((i) => i.getAttribute('src').startsWith('data:image/svg')));
    check(fixed, 'pack previews keep their own pictures (data-icon-fixed)');
    check(!errorsOf(s).length, `no console errors (${errorsOf(s).join(' | ')})`);
  } finally {
    await s.close();
  }
}

// =====================================================================================================================
async function soundsPart() {
  console.log('\n# Sound packs and event sounds');
  const s = await launchShell({ theme: 'light', lang: 'en' });
  const A = (fn, a) => s.aurora(fn, a);
  try {
    await spyAudio(s);
    // every pack defines every system sound (unit)
    const unit = await A(() =>
      import('app://shell/core/sounds.js').then((m) => {
        const missing = [];
        for (const p of m.SOUND_PACKS) {
          const pat = m.sounds.packSounds(p.id);
          for (const n of m.SOUND_NAMES) if (p.id !== 'silent' && !(Array.isArray(pat[n.id]) && pat[n.id].length)) missing.push(`${p.id}.${n.id}`);
          if (!pat.alarm) missing.push(`${p.id}.alarm`);
        }
        return { packs: m.SOUND_PACKS.map((p) => p.id), names: m.SOUND_NAMES.map((n) => n.id), missing };
      }),
    );
    check(unit.packs.length >= 5 && ['notify', 'startup', 'shutdown', 'logon', 'unlock', 'error', 'click', 'screenshot', 'alarm', 'deviceConnect', 'deviceDisconnect', 'emptyTrash'].every((n) => unit.names.includes(n)) && !unit.missing.length, `${unit.packs.length} packs × ${unit.names.length} sounds, all defined (missing ${unit.missing.join(',') || 'none'})`);
    const types = {};
    for (const p of ['aurora', 'chimes', 'retro', 'soft']) {
      await set(s, 'soundPack', p);
      types[p] = await audioOf(s, () => A(() => window.__aurora.sounds.play('notify')));
    }
    check(types.retro.types.includes('square') && types.soft.types.includes('triangle') && types.chimes.n >= 4 && types.aurora.types.includes('sine'), `packs sound different: ${Object.entries(types).map(([k, v]) => `${k} ${v.n}×${v.types}`).join('; ')}`);
    await set(s, 'soundPack', 'silent');
    const silent = await audioOf(s, () => A(() => window.__aurora.notify({ title: 'x', body: 'y' })));
    const alarm = await audioOf(s, () => A(() => window.__aurora.sounds.play('alarm')));
    check(silent.n === 0 && alarm.n > 0, `Silent pack: notification ${silent.n} tones, alarm still rings (${alarm.n})`);
    await set(s, 'soundPack', 'aurora');
    // per-event: any sound of any pack, routed by notify()
    await set(s, 'soundEvents.notification', 'retro.logon');
    const routed = await audioOf(s, () => A(() => window.__aurora.notify({ title: 'a', body: 'b' })));
    check(routed.types.join() === 'square' && Math.abs(routed.freqs[0] - 783.99) < 0.1, `notification = Retro "Sign in": square tones from 783.99 Hz (${routed.freqs.map((f) => Math.round(f))})`);
    await set(s, 'soundEvents.notification', 'none');
    const none = await audioOf(s, () => A(() => window.__aurora.notify({ title: 'a', body: 'b' })));
    check(none.n === 0, 'notification = None: silent');
    await set(s, 'soundEvents.notification', null);
    // volume
    const v100 = await audioOf(s, () => A(() => window.__aurora.sounds.play('notify')));
    await set(s, 'soundVolume', 50);
    const v50 = await audioOf(s, () => A(() => window.__aurora.sounds.play('notify')));
    await set(s, 'soundVolume', 0);
    const v0 = await audioOf(s, () => A(() => window.__aurora.sounds.play('notify')));
    check(Math.abs(v50.peak - v100.peak / 2) < 0.002 && v0.n === 0, `volume: peak ${v100.peak.toFixed(3)} at 100 %, ${v50.peak.toFixed(3)} at 50 %, ${v0.n} tones at 0 %`);
    await set(s, 'soundVolume', 100);
    // startup switch
    await set(s, 'startupSound', false);
    const su0 = await audioOf(s, () => A(() => window.__aurora.sounds.play('startup')));
    const suPrev = await audioOf(s, () => A(() => window.__aurora.sounds.preview(null, 'startup')));
    await set(s, 'startupSound', true);
    const su1 = await audioOf(s, () => A(() => window.__aurora.sounds.play('startup')));
    check(su0.n === 0 && su1.n > 0 && suPrev.n > 0, `"Play the startup sound" off: ${su0.n} tones (preview still plays ${suPrev.n}); on: ${su1.n}`);
    // master switch
    await set(s, 'sounds', false);
    const off = await audioOf(s, () => A(() => window.__aurora.sounds.play('notify')));
    const prev = await audioOf(s, () => A(() => window.__aurora.sounds.preview('chimes', 'notify')));
    await set(s, 'sounds', true);
    check(off.n === 0 && prev.n > 0, `system sounds off: nothing plays (${off.n}), Settings previews still do (${prev.n})`);
    // system hooks: empty the recycle bin, plug / unplug a drive
    const trash = await audioOf(
      s,
      () =>
        A(async () => {
          const home = await window.__aurora.api.invoke('fs:home');
          await window.__aurora.api.invoke('fs:writeText', `${home}/Documents/trash-me.txt`, 'x');
          await window.__aurora.api.invoke('fs:trash', [`${home}/Documents/trash-me.txt`]);
          await new Promise((r) => setTimeout(r, 200));
          window.__osc.length = 0;
          await window.__aurora.api.invoke('fs:trashEmpty');
        }),
      400,
    );
    check(trash.n > 0 && trash.types.includes('sawtooth'), `emptying the Recycle Bin plays its sound (${trash.n} tones, ${trash.types})`);
    const dev = await A(() => {
      const d = window.__aurora.sounds.drivesChanged;
      d([{ id: 'root' }]);
      return [d([{ id: 'root' }, { id: 'sdb1' }]), d([{ id: 'root' }, { id: 'sdb1' }]), d([{ id: 'root' }])];
    });
    check(dev[0] === 'deviceConnect' && dev[1] === null && dev[2] === 'deviceDisconnect', `drives plugged / unplugged → ${dev.join(', ')}`);

    // shutdown / restart / sign out wait for the shutdown sound (~0.8–1 s) before the power call
    await A(() => {
      const api = window.__aurora.api;
      if (api.__orig) return;
      api.__orig = api.invoke;
      window.__power = [];
      api.invoke = (ch, ...args) => {
        if (/^(power:(shutdown|reboot)|session:logout)$/.test(ch)) {
          window.__power.push({ ch, at: performance.now() });
          return Promise.resolve(true);
        }
        return api.__orig.call(api, ch, ...args);
      };
    });
    const timed = async (fn) =>
      A(async (f) => {
        window.__power.length = 0;
        const t0 = performance.now();
        await window.__aurora.shell[f]();
        const p = window.__power[0];
        return p ? { ch: p.ch, ms: Math.round(p.at - t0) } : null;
      }, fn);
    const sd = await timed('shutdown');
    const rb = await timed('reboot');
    const lo = await timed('logout');
    await set(s, 'soundEvents.shutdown', 'none');
    const sdNone = await timed('shutdown');
    await set(s, 'soundEvents.shutdown', null);
    check(sd?.ch === 'power:shutdown' && sd.ms >= 700 && sd.ms <= 1300 && rb?.ms >= 700 && lo?.ms >= 700 && sdNone.ms < 150, `power calls wait for the shutdown sound: shut down ${sd?.ms} ms, restart ${rb?.ms} ms, sign out ${lo?.ms} ms; with no sound ${sdNone.ms} ms`);
    // through the Start menu power button
    await A(() => window.__aurora.shell.emit('start:toggle'));
    await sleep(600);
    await s.page.locator('#start .start-power, #start [data-action="power"], #start button[aria-label*="Power"]').first().click();
    await sleep(300);
    const t0 = Date.now();
    const sdAudio = audioOf(s, async () => {
      await s.page.locator('.menu .menu-item', { hasText: 'Shut down' }).first().click();
    }, 1400);
    const r = await sdAudio;
    const viaStart = await A(() => window.__power[0] || null);
    check(viaStart?.ch === 'power:shutdown' && r.n > 0, `Start › Power › Shut down plays the sound (${r.n} tones) then shuts down (${Date.now() - t0} ms)`);

    // Settings page: pack cards, event combos, "Another sound…" dialog, volume, startup switch
    await go(s, 'soundPacks');
    await s.page.locator(S('.pzs-card[data-pack="chimes"]')).click();
    await sleep(300);
    check((await get(s, 'soundPack')) === 'chimes', 'pack card applies the pack');
    const combo = s.page.locator(S('[data-section="ev-notification"] .st-combo')).first();
    await combo.scrollIntoViewIfNeeded();
    await combo.click();
    await sleep(200);
    await s.page.locator('.menu.st-combo-menu .menu-item', { hasText: 'Another sound' }).click();
    await s.page.waitForSelector('.pzb-sound-dialog', { timeout: 5000 });
    const groups = await A(() => [...document.querySelectorAll('.pzb-sound-group')].map((g) => g.querySelectorAll('.pzb-sound-item').length));
    await docShot(s, 'packs-sounds-choose');
    await s.page.locator('.pzb-sound-dialog input[value="soft.deviceConnect"]').check();
    const pv = await audioOf(s, () => s.page.locator('.pzb-sound-dialog .pzb-sound-item:has(input[value="soft.deviceConnect"]) button').click());
    await s.page.locator('.dialog.pzb-sound-dialog .btn.primary').click();
    await sleep(400);
    const shown = await A(() => document.querySelector('.app-settings [data-section="ev-notification"] .st-combo-text')?.textContent);
    check(groups.length === 4 && groups.every((n) => n >= 12) && (await get(s, 'soundEvents.notification')) === 'soft.deviceConnect' && /Soft/.test(shown) && pv.n > 0, `"Another sound…": ${groups.length} packs × ${groups[0]} sounds with previews; chose "${shown}"`);
    const viaNotify = await audioOf(s, () => A(() => window.__aurora.notify({ title: 'z', body: 'z' })));
    check(viaNotify.types.includes('triangle') && Math.abs(viaNotify.freqs[0] - 523.25) < 0.1, `the chosen sound plays for notifications (${viaNotify.freqs.map(Math.round)})`);
    // volume slider + startup switch in the page
    const vol = s.page.locator(S('[data-section="soundVolume"] input.slider')).first();
    await vol.scrollIntoViewIfNeeded();
    await vol.focus();
    await s.page.keyboard.press('Home');
    await s.page.keyboard.press('ArrowRight');
    await sleep(500);
    const st = s.page.locator(S('[data-section="startupSound"] .toggle input')).first();
    await st.click();
    await sleep(300);
    check((await get(s, 'soundVolume')) === 5 && (await get(s, 'startupSound')) === false, `page: volume slider → ${await get(s, 'soundVolume')} %, startup switch → ${await get(s, 'startupSound')}`);
    await setMany(s, {}, ['soundVolume', 'startupSound']);
    // listen to the pack
    await s.page.locator(S('[data-section="packSounds"]')).first().click();
    await sleep(300);
    const btns = await A(() => document.querySelectorAll('.app-settings .pzb-pack-sound').length);
    const one = await audioOf(s, () => s.page.locator(S('.pzb-pack-sound[data-sound="emptyTrash"]')).click());
    check(btns >= 12 && one.n > 0, `"Listen to the pack": ${btns} sounds, each plays (${one.n} tones)`);
    await docShot(s, 'packs-sounds');
    await setMany(s, {}, ['soundPack', 'soundEvents']);
    check(!errorsOf(s).length, `no console errors (${errorsOf(s).join(' | ')})`);
  } finally {
    await s.close();
  }
}

// =====================================================================================================================
async function snapPart() {
  console.log('\n# Snap layout presets');
  const s = await launchShell({ theme: 'light', lang: 'en', open: ['notepad'] });
  const A = (fn, a) => s.aurora(fn, a);
  try {
    const def = await A(() => window.__aurora.snap.shownLayouts().map((l) => l.id));
    check(def.join() === 'halves,twoThirds,thirds,mainStack,quad,wideCenter', `default flyout: the six Windows 11 layouts (${def})`);
    const builtins = await A(() => window.__aurora.snap.builtins.map((l) => l.id));
    check(['seventyThirty', 'fourColumns', 'threeRows', 'wideCenter'].every((x) => builtins.includes(x)) && builtins.length >= 12, `built-in catalog: ${builtins.join(', ')}`);
    await go(s, 'snapPresets');
    // hide / show / reorder built-in layouts
    const row = (id) => S(`.pzb-layout-row[data-id="${id}"]`);
    await s.page.locator(`${row('seventyThirty')} .toggle input`).click();
    await sleep(300);
    await s.page.locator(`${row('fourColumns')} .toggle input`).click();
    await sleep(300);
    await s.page.locator(`${row('threeRows')} .toggle input`).click();
    await sleep(300);
    await s.page.locator(`${row('thirds')} .toggle input`).click();
    await sleep(300);
    await s.page.locator(`${row('seventyThirty')} .pzb-up`).click();
    await sleep(300);
    const order = await get(s, 'snapLayouts');
    check(JSON.stringify(order) === JSON.stringify(['halves', 'twoThirds', 'mainStack', 'quad', 'seventyThirty', 'wideCenter', 'fourColumns', 'threeRows']), `show 70/30, 4 columns, 3 rows, hide Three columns, move 70/30 up → ${order}`);
    // a custom layout from the split editor: split the screen, then split the right half top / bottom
    await s.page.locator(S('.pzs-snap-new-btn')).click();
    await s.page.waitForSelector('.pzs-snap-editor', { timeout: 5000 });
    await s.page.locator('.pzs-snap-editor .segmented button', { hasText: 'Split' }).click();
    await sleep(200);
    await s.page.locator('.pzs-snap-editor input.input').fill('Main + two');
    await s.page.locator('.pzb-split-zone[data-path="b"]').click();
    await s.page.locator('.pzb-split-h').click();
    await sleep(200);
    // move the first divider to 60 %
    await s.page.locator('.pzb-split-zone[data-path="a"]').click();
    const pos = s.page.locator('.pzs-snap-editor input.slider').first();
    await pos.focus();
    await s.page.keyboard.press('ArrowRight');
    await s.page.keyboard.press('ArrowRight');
    await sleep(200);
    const zonesShown = await A(() => document.querySelectorAll('.pzb-split-zone').length);
    await docShot(s, 'snap-presets-editor');
    await s.page.locator('.dialog.pzs-snap-dialog .btn.primary').click();
    await sleep(500);
    const presets = await get(s, 'snapPresets');
    const p = presets[0];
    const z = (p?.zones || []).map((q) => [q.x, q.y, q.w, q.h].map((n) => Math.round(n * 100)).join(','));
    check(zonesShown === 3 && presets.length === 1 && p.name === 'Main + two' && z.join(' ') === '0,0,60,100 60,0,40,50 60,50,40,50' && p.spec?.kind === 'custom', `split editor: ${p?.name} → zones ${z.join(' | ')}`);
    const order2 = await get(s, 'snapLayouts');
    check(order2.at(-1) === p.id, 'a new layout is added at the end of the flyout');
    await docShot(s, 'snap-presets-page');
    // the flyout shows the chosen layouts in order; a custom zone snaps the window to its rect
    await A(() => window.__aurora.snap.open(window.__aurora.wm.byApp('notepad')[0]));
    await sleep(500);
    const fly = await A(() => [...document.querySelectorAll('.snapl-fly .snapl-layout')].map((t) => `${t.dataset.id}:${t.querySelectorAll('.snapl-zone').length}`));
    check(fly.join(' ') === ['halves:2', 'twoThirds:2', 'mainStack:3', 'quad:4', 'seventyThirty:2', 'wideCenter:3', 'fourColumns:4', 'threeRows:3', `${p.id}:3`].join(' '), `flyout: ${fly.join(' ')}`);
    await docShot(s, 'snap-presets-flyout');
    await s.page.locator(`.snapl-fly .snapl-layout[data-id="${p.id}"] .snapl-zone`).nth(2).click();
    await sleep(800);
    const snapped = await A(() => {
      const w = window.__aurora.wm.byApp('notepad')[0];
      const wa = window.__aurora.wm.workarea();
      return { state: w.state, snap: w.snap, rect: [w.x, w.y, w.w, w.h], want: [Math.round(wa.x + 0.6 * wa.width), Math.round(wa.y + 0.5 * wa.height), Math.round(0.4 * wa.width), Math.round(0.5 * wa.height)] };
    });
    check(snapped.state === 'snapped' && snapped.rect.every((v, i) => Math.abs(v - snapped.want[i]) <= 2), `custom zone 3 snaps Notepad to ${snapped.rect} (want ${snapped.want})`);
    // 70/30 from the flyout
    await A(() => window.__aurora.wm.byApp('notepad')[0].restore());
    await sleep(400);
    await A(() => window.__aurora.snap.open(window.__aurora.wm.byApp('notepad')[0]));
    await sleep(400);
    await s.page.locator('.snapl-fly .snapl-layout[data-id="seventyThirty"] .snapl-zone').first().click();
    await sleep(800);
    const s73 = await A(() => {
      const w = window.__aurora.wm.byApp('notepad')[0];
      const wa = window.__aurora.wm.workarea();
      return { w: w.w, want: Math.round(0.7 * wa.width), assist: !!document.querySelector('.snapa') };
    });
    check(Math.abs(s73.w - s73.want) <= 2, `70/30: Notepad ${s73.w}px wide (want ${s73.want})`);
    await A(() => window.__aurora.snap.endAssist?.());
    // Win+Z: keyboard numbers the layouts in the new order
    await A(() => window.__aurora.wm.byApp('notepad')[0].restore());
    await A(() => window.__aurora.wm.byApp('notepad')[0].focus());
    await sleep(300);
    await A(() => window.__aurora.hotkeys.trigger('Super+Z'));
    await sleep(400);
    await s.page.keyboard.press('5');
    await s.page.keyboard.press('2');
    await sleep(800);
    const kz = await A(() => {
      const w = window.__aurora.wm.byApp('notepad')[0];
      const wa = window.__aurora.wm.workarea();
      return { x: w.x, want: Math.round(wa.x + 0.7 * wa.width), state: w.state };
    });
    check(kz.state === 'snapped' && Math.abs(kz.x - kz.want) <= 2, `Win+Z, 5, 2 → layout 5 (70/30) zone 2 at x=${kz.x} (want ${kz.want})`);
    await A(() => window.__aurora.snap.endAssist?.());
    // snap options: Snap Assist off → no suggestions; drag bar off → no bar when dragging to the top
    await A(() => {
      window.__aurora.wm.byApp('notepad')[0].restore();
      window.__aurora.registry.launch('calculator');
    });
    await sleep(1200);
    const toggle = (sec) => s.page.locator(S(`[data-section="${sec}"] .toggle input`)).first();
    await A(() => window.__aurora.wm.byApp('settings')[0].focus());
    await toggle('snapAssist').scrollIntoViewIfNeeded();
    await toggle('snapAssist').click();
    await sleep(300);
    await A(() => {
      const w = window.__aurora.wm.byApp('notepad')[0];
      w.focus();
    });
    await A(() => window.__aurora.hotkeys.trigger('Super+ArrowLeft'));
    await sleep(900);
    const noAssist = await A(() => ({ assist: !!document.querySelector('.snapa:not(.closing)'), v: window.__aurora.settings.get('multitasking.snapAssist') }));
    await A(() => window.__aurora.settings.set('multitasking.snapAssist', true));
    await A(() => window.__aurora.wm.byApp('notepad')[0].restore());
    await sleep(300);
    await A(() => window.__aurora.hotkeys.trigger('Super+ArrowLeft'));
    await sleep(900);
    const withAssist = await A(() => !!document.querySelector('.snapa:not(.closing)'));
    await s.page.keyboard.press('Escape');
    check(noAssist.v === false && !noAssist.assist && withAssist, `Snap Assist switch: off → no suggestions; on → suggestions (${withAssist})`);
    const dragTop = async () => {
      await A(() => {
        const w = window.__aurora.wm.byApp('notepad')[0];
        w.restore();
        w.focus();
      });
      await sleep(400);
      // a free spot of the title bar (Notepad puts its tabs there: they are no-drag)
      const r = await A(() => {
        const t = window.__aurora.wm.byApp('notepad')[0].el.querySelector('.win-titlebar, .titlebar, .win-title');
        const b = t.getBoundingClientRect();
        const y = b.top + 12;
        for (let x = b.right - 160; x > b.left + 8; x -= 8) {
          const e = document.elementFromPoint(x, y);
          if (e && t.contains(e) && !e.closest('.no-drag, button, input, [role="tab"], .win-controls')) return { x, y };
        }
        return { x: b.left + 120, y };
      });
      await s.page.mouse.move(r.x, r.y);
      await s.page.mouse.down();
      await s.page.mouse.move(r.x + 40, r.y + 20, { steps: 4 });
      const cx = await A(() => window.innerWidth / 2);
      await s.page.mouse.move(cx, 30, { steps: 10 });
      await sleep(400);
      const bar = await A(() => !!document.querySelector('.snapl-bar:not(.closing)'));
      await s.page.mouse.move(cx, 400, { steps: 5 });
      await s.page.mouse.up();
      await sleep(400);
      return bar;
    };
    const barOn = await dragTop();
    await set(s, 'multitasking.snapBar', false);
    const barOff = await dragTop();
    await set(s, 'multitasking.snapBar', true);
    check(barOn && !barOff, `"Show snap layouts when I drag a window to the top": on → bar ${barOn}; off → bar ${barOff}`);
    // hover switch
    await set(s, 'multitasking.snapLayouts', false);
    await A(() => window.__aurora.wm.byApp('notepad')[0].focus());
    const btnMax = await A(() => {
      const b = window.__aurora.wm.byApp('notepad')[0].btnMax.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    });
    await s.page.mouse.move(btnMax.x, btnMax.y, { steps: 3 });
    await sleep(900);
    const hoverOff = await A(() => !!document.querySelector('.snapl-fly:not(.closing)'));
    await s.page.mouse.move(800, 600);
    await set(s, 'multitasking.snapLayouts', true);
    await sleep(300);
    await s.page.mouse.move(btnMax.x, btnMax.y, { steps: 3 });
    await sleep(900);
    const hoverOn = await A(() => !!document.querySelector('.snapl-fly:not(.closing)'));
    await s.page.mouse.move(800, 600);
    await sleep(500);
    check(!hoverOff && hoverOn, `hover switch: off → no flyout; on → flyout (${hoverOn})`);
    // delete the custom layout: it leaves the flyout order too; restore defaults
    await A(() => window.__aurora.wm.byApp('settings')[0].focus());
    await s.page.locator(`${row(p.id)} .pzb-delete`).click();
    await sleep(400);
    check(!(await get(s, 'snapPresets')).length && !(await get(s, 'snapLayouts')).includes(p.id), 'deleting a layout removes it from the flyout order');
    await s.page.locator(S('.pzb-snap-reset')).click();
    await sleep(300);
    check((await get(s, 'snapLayouts')) === null, 'Restore the default layouts');
    await closeApps(s, ['calculator']);
    check(!errorsOf(s).length, `no console errors (${errorsOf(s).join(' | ')})`);
  } finally {
    await s.close();
  }
}

// =====================================================================================================================
async function recordIn(s, sec, combo, { save = true } = {}) {
  await s.page.locator(S(`[data-section="${sec}"] .pzs-sc-change`)).click();
  await s.page.waitForSelector('.pzs-rec', { timeout: 5000 });
  await sleep(150);
  if (combo) await press(s, combo);
  const st = await s.aurora(() => ({ keys: document.querySelector('.pzs-rec-keys')?.textContent, msg: document.querySelector('.pzs-rec-msg')?.textContent, cls: document.querySelector('.pzs-rec-msg')?.className, saveOff: document.querySelector('.dialog.pzs-rec-dialog .btn.primary')?.disabled }));
  if (save === true) await s.page.locator('.dialog.pzs-rec-dialog .btn.primary').click();
  else if (save === 'reset') await s.page.locator('.dialog.pzs-rec-dialog .dialog-footer .btn').nth(1).click();
  else await s.page.locator('.dialog.pzs-rec-dialog .dialog-footer .btn').last().click();
  await sleep(400);
  return st;
}

async function shortcutsPart() {
  console.log('\n# Keyboard shortcuts');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-b3-sc-'));
  let s = await launchShell({ theme: 'light', lang: 'en', home });
  const A = (fn, a) => s.aurora(fn, a);
  try {
    // rules (unit): typing combos are never accepted
    const rules = await A(() =>
      import('app://shell/core/shortcuts.js').then((m) => Object.fromEntries(['Ctrl+C', 'Ctrl+V', 'Alt+F', 'Shift+A', 'Ctrl+Shift+K', 'Ctrl+Alt+K', 'Super+K', 'Super+Shift+C', 'F13', 'Shift+F14', 'Ctrl+Alt+F2', 'Ctrl+Alt+Backspace', 'Alt+Tab', 'Ctrl+Alt+Delete', 'Alt+F4', 'Ctrl+Shift+Escape', 'Super+1', 'Super', 'Ctrl+Alt+', 'Super+Super+K'].map((c) => [c, m.comboProblem(c) || 'ok']))),
    );
    check(
      ['Ctrl+C', 'Ctrl+V', 'Alt+F', 'Shift+A', 'Ctrl+Shift+K'].every((c) => rules[c] === 'modifier') && ['Ctrl+Alt+K', 'Super+K', 'Super+Shift+C', 'F13', 'Shift+F14', 'Alt+F4', 'Ctrl+Shift+Escape', 'Super+1', 'Super'].every((c) => rules[c] === 'ok') && rules['Ctrl+Alt+F2'] === 'reserved' && rules['Ctrl+Alt+Backspace'] === 'reserved' && rules['Alt+Tab'] === 'fixed' && rules['Ctrl+Alt+Delete'] === 'fixed' && rules['Ctrl+Alt+'] === 'format' && rules['Super+Super+K'] === 'format',
      `bindable combos need Win, Ctrl+Alt or F13–F24: ${JSON.stringify(rules)}`,
    );
    const main = await A(() => window.__aurora.api.invoke('hotkeys:setCustom', ['Ctrl+C', 'Alt+F', 'Ctrl+Shift+K', 'Ctrl+Alt+K', 'F13', 'Shift+F14', 'Ctrl+Alt+Tab']));
    check(JSON.stringify(main) === JSON.stringify(['Ctrl+Alt+K', 'F13', 'Shift+F14']), `main process accepts only safe combos to capture: ${JSON.stringify(main)}`);
    await A(() => window.__aurora.api.invoke('hotkeys:setCustom', []));
    const catalog = await A(() => import('app://shell/core/shortcuts.js').then((m) => m.SHORTCUTS.map((x) => x.id)));
    check(['start', 'search', 'taskView', 'files', 'settings', 'lock', 'quickSettings', 'notifications', 'run', 'snapLeft', 'snapRight', 'maximize', 'minimize', 'prevDesktop', 'nextDesktop', 'newDesktop', 'screenshot', 'taskManager', 'focusMode', 'showDesktop', 'taskbarApp1', 'taskbarApp9'].every((x) => catalog.includes(x)), `${catalog.length} actions, incl. launch taskbar app 1–9`);

    await go(s, 'shortcuts');
    // Ctrl+Alt+N for Notepad, recorded with real key presses; then pressed with focus in an app
    const r1 = await recordIn(s, 'sc-notepad', 'Ctrl+Alt+N');
    check(/Ctrl.*Alt.*N/.test(r1.keys) && !r1.saveOff && (await get(s, 'shortcuts.notepad')) === 'Ctrl+Alt+N', `record Ctrl+Alt+N for Notepad ("${r1.keys}")`);
    await A(() => window.__aurora.wm.byApp('settings')[0].minimize());
    await sleep(300);
    await press(s, 'Ctrl+Alt+N');
    await sleep(1200);
    const np = await A(() => window.__aurora.wm.byApp('notepad').length);
    check(np === 1, `Ctrl+Alt+N opens Notepad (${np} window)`);
    // typing shortcuts keep working inside the app (Ctrl+A, Ctrl+C are not captured)
    await s.page.keyboard.type('hello b3');
    await press(s, 'Ctrl+A');
    await press(s, 'Ctrl+C');
    await sleep(300);
    const clip = await A(() => window.__aurora.api.invoke('clipboard:readText'));
    check(clip === 'hello b3', `Ctrl+A / Ctrl+C still reach Notepad (clipboard "${clip}")`);
    await closeApps(s, ['notepad']);
    // conflict: Win+E for Run turns File Explorer's shortcut off
    await go(s, 'shortcuts');
    const r2 = await recordIn(s, 'sc-run', 'Super+E');
    const sc2 = await get(s, 'shortcuts');
    check(/File Explorer/.test(r2.msg) && /warn/.test(r2.cls) && sc2.run === 'Super+E' && sc2.files === null, `conflict shown ("${r2.msg}") and resolved: run ${sc2.run}, files ${sc2.files}`);
    const tr = await A(() => ({ b: window.__aurora.hotkeys.bindings['Super+E'] }));
    check(tr.b === 'run', `Win+E now runs "${tr.b}"`);
    // reserved and typing combos are refused in the recorder
    const r3 = await recordIn(s, 'sc-files', 'Ctrl+Alt+F3', { save: false });
    const r4 = await recordIn(s, 'sc-files', 'Ctrl+S', { save: false });
    check(r3.saveOff && /display server/.test(r3.msg) && r4.saveOff && /Ctrl \+ Alt/.test(r4.msg), `refused: Ctrl+Alt+F3 ("${r3.msg}"), Ctrl+S ("${r4.msg}")`);
    // keys shown live while modifiers are held
    await s.page.locator(S('[data-section="sc-files"] .pzs-sc-change')).click();
    await s.page.waitForSelector('.pzs-rec', { timeout: 5000 });
    await press(s, 'Ctrl+Control', { up: false });
    await s.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Alt', modifiers: ['control', 'alt'] }));
    await sleep(250);
    const live = await A(() => ({ keys: document.querySelector('.pzs-rec-keys')?.textContent, msg: document.querySelector('.pzs-rec-msg')?.textContent }));
    await keyUp(s, 'Alt', ['control']);
    await keyUp(s, 'Control');
    await docShot(s, 'shortcuts-record');
    // Reset in the dialog brings the default back
    await s.page.locator('.dialog.pzs-rec-dialog .dialog-footer .btn').nth(1).click();
    await sleep(400);
    check(/Ctrl.*Alt.*…/.test(live.keys) && /press a key/i.test(live.msg) && (await get(s, 'shortcuts.files')) === undefined, `held keys shown live ("${live.keys}"); Reset → File Explorer back to Win+E (${(await A(() => window.__aurora.hotkeys.combos().files))})`);
    const afterReset = await A(() => ({ files: window.__aurora.hotkeys.combos().files, run: window.__aurora.hotkeys.combos().run }));
    check(afterReset.files === 'Super+E' && afterReset.run === null, `Win+E belongs to File Explorer again and Run is off (${JSON.stringify(afterReset)})`);
    // "launch taskbar app N" rebinding
    await A(() => window.__aurora.settings.set('shortcuts.taskbarApp1', 'Ctrl+Alt+1'));
    await sleep(400);
    const first = await A(() => document.querySelector('#taskbar .tb-app[data-app]')?.dataset.app);
    const n1 = await A(() => window.__aurora.hotkeys.trigger('Super+1'));
    await press(s, 'Ctrl+Alt+1');
    await sleep(1200);
    const opened = await A((id) => window.__aurora.wm.byApp(id).length, first);
    check(n1 === false && opened >= 1, `taskbar app 1 moved to Ctrl+Alt+1: Win+1 unbound (${n1}), Ctrl+Alt+1 opened ${first} (${opened})`);
    await closeApps(s, [first]);
    // app shortcuts: add one for Calculator with Win+Shift+C
    await go(s, 'shortcuts');
    await s.page.locator(S('.pzb-sc-add')).scrollIntoViewIfNeeded();
    await s.page.locator(S('.pzb-sc-add')).click();
    await s.page.waitForSelector('.pzb-app-dialog', { timeout: 5000 });
    await docShot(s, 'shortcuts-pick-app');
    await s.page.locator('.pzb-app-item[data-app="calculator"]').click();
    await s.page.waitForSelector('.pzs-rec', { timeout: 5000 });
    await press(s, 'Super+Shift+C');
    await s.page.locator('.dialog.pzs-rec-dialog .btn.primary').click();
    await sleep(500);
    check((await get(s, 'shortcuts'))['app:calculator'] === 'Super+Shift+C' && (await A(() => !!document.querySelector('.app-settings [data-section="sc-app-calculator"]'))), 'app shortcut saved and listed (Open Calculator — Win+Shift+C)');
    await docShot(s, 'shortcuts-page');
    await A(() => window.__aurora.wm.byApp('settings')[0].minimize());
    await press(s, 'Super+Shift+C');
    await sleep(1400);
    await press(s, 'Super+Shift+C');
    await sleep(800);
    const calc = await A(() => ({ n: window.__aurora.wm.byApp('calculator').length, focused: window.__aurora.wm.focused()?.appId }));
    check(calc.n === 1 && calc.focused === 'calculator', `Win+Shift+C opens Calculator, pressed again switches to it (${JSON.stringify(calc)})`);
    // persistence across a restart: overrides and the main-process capture list come back
    await A(() => window.__aurora.settings.set('shortcuts.notepad', 'Ctrl+Alt+N'));
    await sleep(300);
    await s.close();
    s = await launchShell({ home, keepHome: true });
    const A2 = (fn, a) => s.aurora(fn, a);
    await sleep(800);
    const back = await A2(() => ({ sc: window.__aurora.settings.get('shortcuts'), b: window.__aurora.hotkeys.bindings }));
    await press(s, 'Ctrl+Alt+N');
    await sleep(1400);
    const np2 = await A2(() => window.__aurora.wm.byApp('notepad').length);
    check(back.sc['app:calculator'] === 'Super+Shift+C' && back.b['Super+Shift+C'] === 'app:calculator' && back.b['Ctrl+Alt+1'] === 'taskbarApp1' && np2 === 1, `after a restart: ${JSON.stringify(back.sc)}; Ctrl+Alt+N opens Notepad (${np2})`);
    // Restore all
    await go(s, 'shortcuts');
    await s.page.locator(S('.pzs-sc-reset-all')).click();
    await s.page.locator('.dialog .btn.primary').last().click();
    await sleep(400);
    const reset = await A2(() => ({ sc: window.__aurora.settings.get('shortcuts'), b: window.__aurora.hotkeys.bindings['Super+1'] }));
    check(JSON.stringify(reset.sc) === '{}' && reset.b === 'taskbarApp1', 'Restore all shortcuts: everything back to the defaults');
    check(!errorsOf(s).length, `no console errors (${errorsOf(s).join(' | ')})`);
  } finally {
    await s.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// =====================================================================================================================
async function profilesPart() {
  console.log('\n# Profiles and import validation (B3 keys)');
  const s = await launchShell({ theme: 'light', lang: 'en' });
  const A = (fn, a) => s.aurora(fn, a);
  try {
    const keys = await A(() => import('app://shell/core/profiles.js').then((m) => m.PROFILE_KEYS));
    const mine = ['cursorPack', 'cursorSize', 'iconPack', 'soundPack', 'soundEvents', 'soundVolume', 'startupSound', 'snapPresets', 'snapLayouts', 'multitasking.snapLayouts', 'multitasking.snapBar', 'multitasking.snapAssist', 'shortcuts'];
    check(mine.every((k) => keys.includes(k)), `PROFILE_KEYS has every B3 key (${mine.filter((k) => !keys.includes(k)).join(',') || 'all'})`);
    const defs = await A(() => window.__aurora.api.invoke('settings:defaults'));
    const getPath = (o, k) => k.split('.').reduce((x, p) => (x == null ? undefined : x[p]), o);
    check(mine.every((k) => getPath(defs, k) !== undefined), 'every B3 key has a default in main/ipc/settings.js');
    const values = {
      cursorPack: 'retro', cursorSize: 150, iconPack: 'glass', soundPack: 'soft', soundEvents: { notification: 'chimes.logon', startup: 'none', shutdown: null }, soundVolume: 40, startupSound: false,
      snapPresets: [{ id: 's-x1', name: 'Split', zones: [{ x: 0, y: 0, w: 0.5, h: 1 }, { x: 0.5, y: 0, w: 0.5, h: 1 }], spec: { kind: 'custom', tree: { s: 'v', r: 0.5, a: null, b: null } } }],
      snapLayouts: ['quad', 's-x1'], 'multitasking.snapLayouts': false, 'multitasking.snapBar': false, 'multitasking.snapAssist': false,
      shortcuts: { files: 'Ctrl+Alt+E', lock: null, 'app:photos': 'Super+Shift+P', taskbarApp2: 'Ctrl+Alt+2' },
    };
    await setMany(s, values);
    await sleep(800);
    const live = await A(() => ({ cur: document.documentElement.dataset.cursorPack, ic: document.documentElement.dataset.iconPack, fly: window.__aurora.snap.shownLayouts().map((l) => l.id), b: window.__aurora.hotkeys.bindings }));
    check(live.cur === 'retro' && live.ic === 'glass' && live.fly.join() === 'quad,s-x1' && live.b['Super+Shift+P'] === 'app:photos' && live.b['Ctrl+Alt+2'] === 'taskbarApp2', `one settings:setMany applies every B3 key live (${JSON.stringify({ cur: live.cur, ic: live.ic, fly: live.fly })})`);
    const id = await A(() => window.__aurora.theme.profiles.saveCurrent('B3 test').then((p) => p.id));
    await setMany(s, {}, mine);
    await sleep(600);
    await A((x) => window.__aurora.theme.profiles.apply(x), id);
    await sleep(1200);
    const got = await A((ks) => Object.fromEntries(ks.map((k) => [k, window.__aurora.settings.get(k)])), mine);
    const diff = mine.filter((k) => JSON.stringify(got[k]) !== JSON.stringify(values[k]));
    check(!diff.length, `save → reset → apply restores every B3 key (${diff.map((k) => `${k}=${JSON.stringify(got[k])}`).join('; ') || 'identical'})`);
    // import validation: injection attempts are dropped
    const evil = {
      format: 'aurora-profile', version: 1, name: 'Evil <b>',
      values: {
        cursorPack: 'retro"; } body { background: red', cursorSize: 9999, iconPack: 'url(javascript:alert(1))', soundVolume: -5, startupSound: 'yes',
        soundEvents: { notification: '../../etc/passwd.ogg', startup: 'chimes.notify', shutdown: '/home/u/a.wav' },
        snapLayouts: ['quad', 'x"); body{', '__proto__'],
        snapPresets: [
          { id: 's-ok', name: 'OK<script>', zones: [{ x: 0, y: 0, w: 1, h: 1 }] },
          { id: 's-bad', zones: [{ x: 0.8, y: 0, w: 0.5, h: 1 }] },
          { id: 's-deep', zones: [{ x: 0, y: 0, w: 1, h: 1 }], spec: { kind: 'custom', tree: JSON.parse('{"s":"v","r":0.5,"a":{"s":"v","r":0.5,"a":{"s":"v","r":0.5,"a":{"s":"v","r":0.5,"a":{"s":"v","r":0.5,"a":{"s":"v","r":0.5,"a":{"s":"v","r":0.5,"a":null,"b":null},"b":null},"b":null},"b":null},"b":null},"b":null},"b":null}') } },
        ],
        shortcuts: { files: 'Ctrl+C', run: 'Super+R', evil: 'Super+K', __proto__: { polluted: 1 }, 'app:x"y': 'Super+J', 'app:photos': 'Alt+F', lock: null },
      },
    };
    const imp = await A((txt) => window.__aurora.theme.profiles.importJson(txt).then((p) => p.values), JSON.stringify(evil));
    const okSe = imp.soundEvents && imp.soundEvents.notification === undefined && imp.soundEvents.startup === 'chimes.notify' && imp.soundEvents.shutdown === '/home/u/a.wav';
    check(
      imp.cursorPack === undefined && imp.cursorSize === undefined && imp.iconPack === undefined && imp.soundVolume === undefined && imp.startupSound === undefined && okSe &&
        JSON.stringify(imp.snapLayouts) === '["quad"]' && imp.snapPresets.length === 2 && imp.snapPresets[0].name === 'OK script' && imp.snapPresets[1].spec?.tree === undefined &&
        JSON.stringify(imp.shortcuts) === JSON.stringify({ run: 'Super+R', lock: null }) && ({}).polluted === undefined,
      `imported profile sanitised: ${JSON.stringify(imp)}`,
    );
    await setMany(s, {}, mine);
    check(!errorsOf(s).length, `no console errors (${errorsOf(s).join(' | ')})`);
  } finally {
    await s.close();
  }
}

// =====================================================================================================================
const PAGES_B3 = ['cursors', 'iconPacks', 'soundPacks', 'shortcuts', 'snapPresets'];
async function i18nPart() {
  console.log('\n# French + dark, 1280×720 and 1920×1080');
  for (const [theme, lang, size] of [['dark', 'fr', '1280x720'], ['light', 'fr', '1920x1080'], ['dark', 'en', '1920x1080'], ['light', 'en', '1280x720']]) {
    const s = await launchShell({ theme, lang, size, open: ['notepad'] });
    const A = (fn, a) => s.aurora(fn, a);
    try {
      for (const page of PAGES_B3) {
        await go(s, page);
        // expand the expanders so their text is checked too
        await A(() => document.querySelectorAll('.app-settings .st-expander:not(.open) .st-expander-head, .app-settings [data-section="packSounds"] .st-row').forEach((e) => e.click?.()));
        await sleep(300);
        const r = await A((lg) => {
          const root = document.querySelector('.app-settings .st-page');
          const text = root.innerText;
          // English words that must not appear in French (and vice versa)
          const en = /\b(the|Choose|Show|Change|Every|Pointer|Size|Sound|Layouts?|Shortcuts?|Restore|Turn off|Play|Add|Split|Merge|When|Built-in|Yours)\b/;
          const fr = /\b(le|la|les|Choisissez|Afficher|Modifier|Taille|Dispositions?|Raccourcis?|Restaurer|Écouter|Ajouter|Diviser|Fusionner|Intégrée)\b/;
          const bad = lg === 'fr' ? (text.match(en) || [])[0] : (text.match(fr) || [])[0];
          const over = [...root.querySelectorAll('*')].filter((e) => {
            const r = e.getBoundingClientRect();
            const p = root.getBoundingClientRect();
            return r.width > 0 && r.right > p.right + 2 && getComputedStyle(e).position !== 'fixed';
          }).map((e) => e.className).slice(0, 4);
          const hScroll = root.scrollWidth > root.clientWidth + 1;
          return { bad: bad || null, over, hScroll, keysRaw: (text.match(/\bp(zs|zx)\.\w+/g) || []).slice(0, 3) };
        }, lang);
        check(!r.bad && !r.over.length && !r.hScroll && !r.keysRaw.length, `${lang} ${theme} ${size} ${page}: translated, no overflow (${JSON.stringify(r)})`);
        if (size === '1280x720' || page === 'snapPresets' || page === 'cursors') await docShot(s, `${page === 'shortcuts' ? 'shortcuts' : page === 'snapPresets' ? 'snap-presets' : `packs-${page}`}-${lang}-${theme}-${size}`);
      }
      // dialogs: recorder and editor fit and are translated
      await go(s, 'shortcuts');
      await s.page.locator(S('[data-section="sc-files"] .pzs-sc-change')).click();
      await s.page.waitForSelector('.pzs-rec', { timeout: 5000 });
      await press(s, 'Ctrl+K');
      const dl = await A(() => {
        const d = document.querySelector('.dialog.pzs-rec-dialog');
        const r = d.getBoundingClientRect();
        return { fits: r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, text: d.innerText.replace(/\s+/g, ' ').slice(0, 220), over: d.scrollWidth > d.clientWidth + 1 };
      });
      check(dl.fits && !dl.over && (lang === 'fr' ? /Ajoutez Win/.test(dl.text) : /Add Win/.test(dl.text)), `${lang} recorder dialog fits (${dl.text})`);
      if (lang === 'fr' && theme === 'dark') await docShot(s, `shortcuts-record-${lang}-${theme}`);
      await s.page.keyboard.press('Escape');
      await go(s, 'snapPresets');
      await s.page.locator(S('.pzs-snap-new-btn')).click();
      await s.page.waitForSelector('.pzs-snap-editor', { timeout: 5000 });
      await s.page.locator('.pzs-snap-editor .segmented button').last().click();
      await sleep(300);
      const ed = await A(() => {
        const d = document.querySelector('.dialog.pzs-snap-dialog');
        const r = d.getBoundingClientRect();
        const body = d.querySelector('.dialog-body');
        return { fits: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight + 1, over: body.scrollWidth > body.clientWidth + 1, text: d.innerText.replace(/\s+/g, ' ').slice(0, 160) };
      });
      check(ed.fits && !ed.over, `${lang} ${size} snap editor fits (${ed.text})`);
      if (theme === 'dark') await docShot(s, `snap-presets-editor-${lang}-${theme}-${size}`);
      await s.page.keyboard.press('Escape');
      check(!errorsOf(s).length, `no console errors (${errorsOf(s).join(' | ')})`);
    } finally {
      await s.close();
    }
  }
}

// =====================================================================================================================
async function perfPart() {
  console.log('\n# Performance and leaks');
  const s = await launchShell({ theme: 'light', lang: 'en', open: ['notepad', 'files'] });
  const A = (fn, a) => s.aurora(fn, a);
  try {
    await A(() => window.__aurora.shell.emit('start:toggle'));
    await sleep(500);
    await A(() => window.__aurora.shell.emit('start:close'));
    const base = await A(() => ({ head: document.head.children.length, nodes: document.getElementsByTagName('*').length }));
    const cur = await A(async () => {
      const packs = ['classic', 'midnight', 'accent', 'large', 'highvis', 'retro', 'default'];
      const t0 = performance.now();
      for (let i = 0; i < 21; i++) {
        await window.__aurora.settings.set('cursorPack', packs[i % packs.length]);
      }
      return Math.round((performance.now() - t0) / 21);
    });
    const ic = await A(async () => {
      const packs = ['tiles', 'accent', 'glass', 'graphite', 'mono', 'outline', 'retro', 'fluent'];
      const t0 = performance.now();
      for (let i = 0; i < 24; i++) await window.__aurora.settings.set('iconPack', packs[i % packs.length]);
      return Math.round((performance.now() - t0) / 24);
    });
    await sleep(800);
    const after = await A(() => ({ head: document.head.children.length, nodes: document.getElementsByTagName('*').length, styles: document.querySelectorAll('#aurora-cursor-vars, #aurora-iconpack-css').length }));
    // (generous bounds: the CI machine runs several Electron suites at once; an idle run measures ~30 ms)
    check(cur < 250 && ic < 300, `switching packs is cheap: cursors ${cur} ms, icons ${ic} ms per switch (incl. settings round trip)`);
    check(after.head <= base.head + 1 && Math.abs(after.nodes - base.nodes) < 40 && after.styles <= 1, `no leak after 45 switches: <head> ${base.head} → ${after.head} children, ${base.nodes} → ${after.nodes} elements`);
    // a window drag with a pack on: the inline-cursor observer costs nothing measurable
    await set(s, 'cursorPack', 'classic');
    const drag = await A(async () => {
      const w = window.__aurora.wm.byApp('notepad')[0];
      const t0 = performance.now();
      for (let i = 0; i < 300; i++) w.el.style.left = `${100 + (i % 50)}px`;
      await new Promise((r) => setTimeout(r, 0));
      return performance.now() - t0;
    });
    // (an idle machine measures ~7 ms; several Electron suites at once can take 10×)
    check(drag < 150, `300 style changes with a cursor pack: ${drag.toFixed(1)} ms`);
    await set(s, 'cursorPack', 'default');
    check(!errorsOf(s).length, `no console errors (${errorsOf(s).join(' | ')})`);
  } finally {
    await s.close();
  }
}

// =====================================================================================================================
async function stylesPart() {
  console.log('\n# Packs × visual styles × taskbar edges');
  const s = await launchShell({ theme: 'light', lang: 'en', open: ['notepad', 'files'] });
  const A = (fn, a) => s.aurora(fn, a);
  try {
    const combos = [
      { style: 'retro', iconPack: 'retro', cursorPack: 'retro', 'taskbar.position': 'left', textScale: 130, theme: 'light' },
      { style: 'glass', iconPack: 'glass', cursorPack: 'accent', 'taskbar.position': 'bottom', blur: 90, theme: 'dark' },
      { style: 'contrast', iconPack: 'mono', cursorPack: 'highvis', 'taskbar.position': 'top', theme: 'dark' },
      { style: 'minimal', iconPack: 'graphite', cursorPack: 'midnight', 'taskbar.position': 'right', theme: 'light', appThemes: { notepad: { theme: 'dark', accent: null } } },
      { style: 'win11', iconPack: 'tiles', cursorPack: 'large', 'taskbar.position': 'bottom', cursorSize: 150, theme: 'light' },
    ];
    for (const c of combos) {
      await setMany(s, c);
      await sleep(1200);
      await A(() => window.__aurora.shell.emit('start:toggle'));
      await sleep(700);
      const read = () => A(() => {
        const imgs = [...document.querySelectorAll('#taskbar img, #start img')].filter((i) => i.offsetParent);
        const broken = imgs.filter((i) => i.complete && !i.naturalWidth).length;
        const sp = document.querySelector('#start');
        const sr = sp.getBoundingClientRect();
        return { n: imgs.length, broken, start: sr.width > 0 && sr.left >= 0 && sr.right <= innerWidth + 1 && sr.bottom <= innerHeight + 1, cur: getComputedStyle(document.body).cursor.slice(0, 10) };
      });
      // Poll (up to ~3 s): on a loaded machine Start may still be sliding in, or a pack icon still loading.
      let r = await read();
      for (let i = 0; i < 15 && !(r.n > 4 && !r.broken && r.start && r.cur.startsWith('url(')); i++) {
        await sleep(200);
        r = await read();
      }
      check(r.n > 4 && !r.broken && r.start && r.cur.startsWith('url('), `${c.style} + ${c.iconPack} icons + ${c.cursorPack} cursors + ${c['taskbar.position']} taskbar (${c.theme}): ${r.n} icons drawn, Start on screen${r.n > 4 && !r.broken && r.start && r.cur.startsWith('url(') ? '' : ` ${JSON.stringify(r)}`}`);
      await docShot(s, `packs-style-${c.style}-${c.iconPack}`);
      await A(() => window.__aurora.shell.emit('start:close'));
      await sleep(300);
    }
    await setMany(s, {}, ['style', 'iconPack', 'cursorPack', 'taskbar.position', 'textScale', 'blur', 'appThemes', 'cursorSize', 'theme']);
    check(!errorsOf(s).length, `no console errors (${errorsOf(s).join(' | ')})`);
  } finally {
    await s.close();
  }
}

// =====================================================================================================================
async function restartPart() {
  console.log('\n# Persistence across a restart');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-b3-rs-'));
  let s = await launchShell({ theme: 'light', lang: 'en', home });
  try {
    await setMany(s, { cursorPack: 'midnight', cursorSize: 125, iconPack: 'retro', soundPack: 'retro', soundVolume: 70, startupSound: false, snapLayouts: ['quad', 'fourColumns'], 'multitasking.snapBar': false });
    await sleep(500);
    await s.close();
    s = await launchShell({ home, keepHome: true });
    await sleep(600);
    const r = await s.aurora(() => ({
      cur: document.documentElement.dataset.cursorPack,
      body: getComputedStyle(document.body).cursor.slice(0, 20),
      ic: document.querySelector('#taskbar .tb-app img')?.getAttribute('src').slice(0, 14),
      fly: window.__aurora.snap.shownLayouts().map((l) => l.id).join(),
      v: window.__aurora.settings.get('soundVolume'),
      bar: window.__aurora.settings.get('multitasking.snapBar'),
    }));
    check(r.cur === 'midnight' && r.body.startsWith('url(') && r.ic?.startsWith('data:image/png') && r.fly === 'quad,fourColumns' && r.v === 70 && r.bar === false, `restored after restart: ${JSON.stringify(r)}`);
    check(!errorsOf(s).length, `no console errors (${errorsOf(s).join(' | ')})`);
  } finally {
    await s.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// =====================================================================================================================
// Core controls (core/ui.css) in every visual style × light / dark: .btn.danger text contrast ≥ 4.5:1, the .select
// arrow kept (and room for it) on focus, long menu labels cut with an ellipsis, infinite animations played once when
// animations are off or motion is reduced.
async function uiPart() {
  console.log('\n# Core controls: danger button contrast, select arrow, menu ellipsis, animations off');
  const s = await launchShell({ theme: 'light', lang: 'en', size: '1280x720' });
  const A = (fn, a) => s.aurora(fn, a);
  try {
    await A(() => {
      const box = document.createElement('div');
      box.id = 'ui-probe';
      box.style.cssText = 'position:fixed;left:20px;top:20px;z-index:99999;display:flex;gap:8px;padding:8px';
      // No transitions on the probe: on a loaded machine the colours would be read mid-way from the previous style/theme.
      box.innerHTML = '<button class="btn danger" style="transition:none">Delete</button><select class="select" style="transition:none"><option>One</option><option>Two</option></select>';
      document.body.append(box);
    });
    const bad = [];
    for (const style of ['win11', 'minimal', 'glass', 'retro', 'contrast']) {
      for (const theme of ['light', 'dark']) {
        await setMany(s, { style, theme });
        await sleep(300);
        const r = await A(() => {
          const lum = (c) => {
            const m = c.match(/[\d.]+/g).map(Number);
            const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
            return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]);
          };
          const b = getComputedStyle(document.querySelector('#ui-probe .btn.danger'));
          const x = lum(b.color);
          const y = lum(b.backgroundColor);
          const sel = document.querySelector('#ui-probe .select');
          sel.focus();
          const cs = getComputedStyle(sel);
          const out = { ratio: (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05), arrow: cs.backgroundImage.startsWith('url('), pad: parseFloat(cs.paddingRight) };
          sel.blur();
          return out;
        });
        if (r.ratio < 4.5 || !r.arrow || r.pad < 28) bad.push(`${style}/${theme}: ${JSON.stringify(r)}`);
      }
    }
    check(!bad.length, `5 styles × light/dark: danger button ≥ 4.5:1, select arrow visible with room on focus (${bad.join('; ') || 'ok'})`);
    await A(() => void window.__aurora.ui.menu({ x: 200, y: 200 }, [{ label: 'A very long menu label '.repeat(12), action: () => {} }, { label: 'Short', action: () => {} }]));
    await sleep(300);
    const m = await A(() => {
      const l = document.querySelector('body > .menu .menu-item .label');
      const cs = getComputedStyle(l);
      return { w: Math.round(l.getBoundingClientRect().width), ov: cs.textOverflow, ws: cs.whiteSpace, cut: l.scrollWidth > l.clientWidth, h: Math.round(l.getBoundingClientRect().height) };
    });
    await A(() => window.__aurora.ui.closeMenus?.());
    check(m.ov === 'ellipsis' && m.ws === 'nowrap' && m.cut && m.w <= 360 && m.h < 30, `a long menu label is one line cut with an ellipsis (${JSON.stringify(m)})`);
    const once = [];
    for (const p of [{ animations: false, reducedMotion: false }, { animations: true, reducedMotion: true }]) {
      await setMany(s, p);
      await sleep(250);
      once.push(
        await A(() => {
          const e = document.createElement('div');
          e.style.animation = 'spin 1s linear infinite';
          document.body.append(e);
          const v = getComputedStyle(e).animationIterationCount;
          e.remove();
          return v;
        }),
      );
    }
    check(once.every((v) => v === '1'), `animations off / reduced motion: an infinite spinner plays once (${once.join(', ')})`);
    await setMany(s, {}, ['style', 'theme', 'animations', 'reducedMotion']);
    check(!errorsOf(s).length, `no console errors (${errorsOf(s).join(' | ')})`);
  } finally {
    await s.close();
  }
}

// =====================================================================================================================
const PARTS = { ui: uiPart, cursors: cursorsPart, icons: iconsPart, sounds: soundsPart, snap: snapPart, shortcuts: shortcutsPart, profiles: profilesPart, i18n: i18nPart, perf: perfPart, styles: stylesPart, restart: restartPart };
for (const [name, fn] of Object.entries(PARTS)) {
  if (!run(name)) continue;
  try {
    await fn();
  } catch (err) {
    failures.push(`${name}: ${err.stack || err}`);
    console.log(`  FAIL ${name} threw: ${err.stack || err}`);
  }
}
console.log(`\n${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  - ${f}`);
process.exit(failures.length ? 1 : 0);
