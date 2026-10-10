// Window management & navigation: hotkeys, Alt+Tab, Task View + virtual desktops, Snap layouts / Snap
// Assist, Ctrl+Alt+Del screen, Run dialog, Win+X menu, window menu, WM behaviour.
//
//   xvfb-run -a -s "-screen 0 1600x900x24" node test/wm-nav.test.mjs [--only=alttab,taskview] [--quick]
//
// Hotkeys are driven two ways:
//   * press(): webContents.sendInputEvent from the main process -> main/lib/hotkeys.js
//     before-input-event -> 'shell:hotkey' IPC -> renderer (the real path; Playwright's CDP key events
//     never reach before-input-event, so page.keyboard cannot be used for system combos);
//   * hk(): the documented test hook window.__aurora.hotkeys.trigger(combo) (same handler as the IPC event).
// Screenshots: test/out/wm-*.png, and the reference set in docs/screenshots/wm-*.png.
import { launchShell, ROOT } from './lib.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const DOCS = path.join(ROOT, '..', 'docs', 'screenshots');
fs.mkdirSync(DOCS, { recursive: true });
const argv = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=')[1];
const ONLY = (argv('only') || '').split(',').filter(Boolean);
const want = (name) => !ONLY.length || ONLY.includes(name);

let failed = 0;
let passed = 0;
function check(name, cond, extra = '') {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  — ${extra}` : ''}`);
  return cond;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ pure unit tests (no Electron)
function unitTests() {
  const { comboOf, SYSTEM } = require('../main/lib/hotkeys.js');
  check('main comboOf: Super+Shift+S order', comboOf({ meta: true, shift: true, key: 'S' }) === 'Super+Shift+S');
  check('main comboOf: Super+Ctrl+ArrowLeft', comboOf({ meta: true, control: true, key: 'ArrowLeft' }) === 'Super+Ctrl+ArrowLeft');
  check('main comboOf: Ctrl+Alt+Delete', comboOf({ control: true, alt: true, key: 'Delete' }) === 'Ctrl+Alt+Delete');
  check('main comboOf: Alt+Shift+Tab', comboOf({ alt: true, shift: true, key: 'Tab' }) === 'Alt+Shift+Tab');
  check('main comboOf: Alt+Space', comboOf({ alt: true, key: ' ' }) === 'Alt+Space');
  check('main comboOf: volume key', comboOf({ key: 'AudioVolumeUp' }) === 'AudioVolumeUp' && SYSTEM.has('AudioVolumeUp'));
  check('main comboOf: lone modifier', comboOf({ alt: true, key: 'Alt' }) === 'Alt');
  check('main SYSTEM has Ctrl+Alt+Tab / Alt+Space', SYSTEM.has('Ctrl+Alt+Tab') && SYSTEM.has('Alt+Space'));
  const { isSystem } = require('../main/lib/hotkeys.js');
  check('main isSystem: any Super combo, not plain keys', isSystem('Super+K', { meta: true }) && isSystem('Alt+Tab', {}) && !isSystem('Ctrl+S', { control: true }) && !isSystem('Tab', {}));
}

// ------------------------------------------------------------------ helpers bound to a shell
function helpers(s) {
  const { page, app } = s;
  const errors = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const loc = m.location()?.url || '';
    errors.push({ text: m.text(), url: loc });
  });
  page.on('pageerror', (e) => errors.push({ text: e.message, url: e.stack || '' }));
  const MINE = /core\/(wm\.js|features\/(hotkeys|alttab|taskview|snaplayouts|security|run|winx)\.js)/;
  const myErrors = () => errors.filter((e) => MINE.test(e.url) || MINE.test(e.text));

  const MODS = { Super: 'meta', Ctrl: 'control', Alt: 'alt', Shift: 'shift' };
  const KEYS = { ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', AudioVolumeUp: 'VolumeUp', AudioVolumeDown: 'VolumeDown', AudioVolumeMute: 'VolumeMute' };
  async function send(seq) {
    await app.evaluate(({ BrowserWindow }, seq) => {
      const wc = BrowserWindow.getAllWindows()[0].webContents;
      for (const [type, keyCode, modifiers] of seq) wc.sendInputEvent({ type, keyCode, modifiers });
    }, seq);
  }
  // Real path through main/lib/hotkeys.js.
  async function press(combo, wait = 160) {
    if (combo === 'Super') await send([['keyDown', 'Meta', ['meta']], ['keyUp', 'Meta', []]]);
    else {
      const parts = combo.split('+');
      const key = parts.pop();
      const mods = parts.map((p) => MODS[p]);
      await send([['keyDown', KEYS[key] || key, mods], ['keyUp', KEYS[key] || key, mods]]);
    }
    await sleep(wait);
  }
  // Test hook (same handler as the IPC event).
  const hk = (combo) => page.evaluate((c) => window.__aurora.hotkeys.trigger(c), combo);
  const A = (fn, arg) => page.evaluate(fn, arg);
  async function newWin(title, opts = {}) {
    return A(
      ([title, opts]) => {
        const { wm } = window.__aurora;
        const w = wm.create({ appId: opts.appId || 'test', title, width: opts.width || 640, height: opts.height || 420, ...opts });
        w.body.innerHTML = `<div style="padding:24px;display:flex;flex-direction:column;gap:12px"><div class="title">${title}</div><input class="input" placeholder="Type here" style="width:260px"><div class="text-2">Window body for ${title}</div></div>`;
        return w.id;
      },
      [title, opts],
    );
  }
  // Launch an app if it is installed (other agents' apps may be missing or mid-development).
  async function launchIf(id) {
    const ok = await A((id) => !!window.__aurora.registry.get(id) && (window.__aurora.shell.launch(id), true), id);
    if (ok) await page.waitForFunction((id) => window.__aurora.wm.byApp(id).length > 0, id, { timeout: 8000 }).catch(() => {});
    return ok;
  }
  const focusedTitle = () => A(() => window.__aurora.wm.focused()?.title || null);
  const winState = (id) =>
    A((id) => {
      const w = window.__aurora.wm.get(id);
      return w ? { state: w.state, snap: w.snap, min: w.minimized, rect: w.rect(), desktop: w.desktop, focused: w.isFocused() } : null;
    }, id);
  async function shot(name, docs = false) {
    const f = await s.shot(name);
    if (docs) fs.copyFileSync(f, path.join(DOCS, `${name}.png`));
    return f;
  }
  async function closeAll() {
    await A(async () => {
      const { wm } = window.__aurora;
      for (const w of wm.list()) await w.close(true);
      while (wm.desktops.length > 1) wm.removeDesktop(wm.desktops[wm.desktops.length - 1].id, { animate: false });
    });
    await sleep(250);
  }
  // Elements whose text is cut off (for the French / long-string checks).
  const clipped = (sel) =>
    A((sel) => [...document.querySelectorAll(sel)].filter((e) => e.offsetParent && e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent.trim()), sel);
  return { errors, myErrors, press, send, hk, A, newWin, launchIf, focusedTitle, winState, shot, closeAll, clipped };
}

// ------------------------------------------------------------------ main scenario (English, light)
async function mainRun() {
  const s = await launchShell({ lang: 'en', theme: 'light' });
  const T = helpers(s);
  const { page } = s;
  const { press, hk, A, newWin, launchIf, focusedTitle, winState, shot, closeAll } = T;
  try {
    check('features mounted', await A(() => ['hotkeys', 'alttab', 'taskview', 'snap', 'security', 'run', 'winx'].every((k) => window.__aurora[k])));
    check('renderer cancels forwarded combos in the shell page, not app shortcuts', await A(() => {
      const { isSystemEvent } = window.__aurora.hotkeys;
      const ev = (o) => new KeyboardEvent('keydown', o);
      return isSystemEvent(ev({ key: 'd', metaKey: true })) && isSystemEvent(ev({ key: 'Tab', altKey: true })) && isSystemEvent(ev({ key: 'Delete', ctrlKey: true, altKey: true })) && !isSystemEvent(ev({ key: 's', ctrlKey: true })) && !isSystemEvent(ev({ key: 'Tab' }));
    }));
    check('a forwarded combo never reaches app key handlers in the shell page', await A(async () => {
      let seen = 0;
      const f = () => seen++;
      document.addEventListener('keydown', f);
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', altKey: true, bubbles: true }));
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }));
      document.removeEventListener('keydown', f);
      return seen === 1;
    }));
    check('renderer normalize()', await A(() => {
      const n = window.__aurora.hotkeys.normalize;
      return n('Ctrl+Super+Left') === 'Super+Ctrl+ArrowLeft' && n('Shift+Super+s') === 'Super+Shift+S' && n('Alt+Shift+Tab') === 'Alt+Shift+Tab' && n('Alt:up') === 'Alt:up';
    }));

    // -------------------------------------------------------- hotkeys that drive other shell surfaces
    if (want('shellkeys')) {
      await A(() => {
        window.__ev = [];
        for (const e of ['start:toggle', 'quick:toggle', 'calendar:toggle', 'search:toggle', 'widgets:toggle', 'taskview:toggle', 'lock', 'run:open', 'winx:toggle', 'security:open'])
          window.__aurora.shell.on(e, () => window.__ev.push(e));
      });
      await press('Super', 250);
      check('Super alone toggles Start (real key path)', (await A(() => window.__ev.join())) === 'start:toggle');
      await A(() => window.__aurora.shell.emit('start:close'));
      for (const [combo, ev] of [['Super+A', 'quick:toggle'], ['Super+N', 'calendar:toggle'], ['Super+S', 'search:toggle'], ['Super+W', 'widgets:toggle']]) {
        await A(() => (window.__ev = []));
        await press(combo, 150);
        check(`${combo} -> ${ev} (real key path)`, (await A(() => window.__ev.join())) === ev, await A(() => window.__ev.join()));
        await A(() => window.__aurora.shell.emit('flyouts:close'));
      }
      await A(() => (window.__ev = []));
      check('auto-repeat of a one-shot combo is ignored', (await A(() => window.__aurora.hotkeys.trigger('Super+A', { repeat: true }))) === false);
      // Super+L locks (stub the lock screen: just record the event, then unlock).
      await A(() => (window.__ev = []));
      await hk('Super+L');
      check('Super+L -> shell.lock()', (await A(() => window.__ev.join())).includes('lock'));
      await A(() => window.__aurora.shell.emit('unlock'));
      await sleep(100);
      await A(() => document.querySelectorAll('#overlays > *').forEach((e) => !e.classList.contains('osd') && !e.classList.contains('alttab-sink') && e.remove()));
      // App launchers (only when the app is installed; otherwise the key is a silent no-op).
      for (const [combo, app] of [['Super+E', 'files'], ['Super+I', 'settings'], ['Ctrl+Shift+Escape', 'taskmgr'], ['PrintScreen', 'snipping'], ['Super+Shift+S', 'snipping']]) {
        const has = await A((a) => !!window.__aurora.registry.get(a), app);
        await press(combo, 200);
        if (has) {
          await page.waitForFunction((a) => window.__aurora.wm.byApp(a).length > 0, app, { timeout: 8000 }).catch(() => {});
          check(`${combo} launches ${app} (real key path)`, (await A((a) => window.__aurora.wm.byApp(a).length, app)) > 0);
        } else check(`${combo}: ${app} not installed -> no-op, no error`, (await A((a) => window.__aurora.wm.byApp(a).length, app)) === 0);
      }
      await closeAll();
    }

    // -------------------------------------------------------- Super+D / Super+M / Win+Home
    if (want('desktop')) {
      const a = await newWin('Alpha');
      const b = await newWin('Bravo');
      await sleep(350);
      await press('Super+D', 450);
      check('Super+D minimises all (real key path)', (await A(() => window.__aurora.wm.list().every((w) => w.minimized))));
      await press('Super+D', 450);
      check('Super+D again restores them', (await A(() => window.__aurora.wm.list().every((w) => !w.minimized))) && (await focusedTitle()) === 'Bravo');
      await hk('Super+M');
      await sleep(350);
      check('Super+M minimises all', await A(() => window.__aurora.wm.list().every((w) => w.minimized)));
      await hk('Super+Shift+M');
      await sleep(350);
      check('Super+Shift+M restores', await A(() => window.__aurora.wm.list().every((w) => !w.minimized)));
      await A((id) => window.__aurora.wm.get(id).focus(), a);
      await hk('Super+Home');
      await sleep(350);
      check('Super+Home minimises the others', (await winState(b)).min && !(await winState(a)).min);
      await closeAll();
    }

    // -------------------------------------------------------- Super+arrows
    if (want('snapkeys')) {
      const id = await newWin('Snappy', { width: 700, height: 460 });
      await sleep(300);
      const wa = await A(() => window.__aurora.wm.workarea());
      await press('Super+ArrowLeft', 350);
      let st = await winState(id);
      check('Super+Left snaps left half', st.snap === 'left' && st.rect.x === wa.x && st.rect.width === Math.round(wa.width / 2) && st.rect.height === wa.height);
      await hk('Super+ArrowUp');
      st = await winState(id);
      check('Super+Up on left half -> top-left quarter', st.snap === 'tl');
      await hk('Super+ArrowDown');
      st = await winState(id);
      check('Super+Down on top-left -> left half', st.snap === 'left');
      await hk('Super+ArrowLeft');
      st = await winState(id);
      check('Super+Left on left half cycles to right half', st.snap === 'right');
      await hk('Super+ArrowLeft');
      st = await winState(id);
      check('Super+Left on right half restores', st.state === 'normal' && st.rect.width === 700);
      await hk('Super+ArrowUp');
      st = await winState(id);
      check('Super+Up maximises', st.state === 'maximized');
      await hk('Super+ArrowDown');
      st = await winState(id);
      check('Super+Down on maximised restores', st.state === 'normal' && st.rect.width === 700);
      await hk('Super+ArrowDown');
      await sleep(320);
      st = await winState(id);
      check('Super+Down on normal minimises', st.min);
      await A((id) => window.__aurora.wm.get(id).focus(), id);
      await hk('Super+Shift+ArrowUp');
      st = await winState(id);
      check('Super+Shift+Up maximises vertically', st.snap === 'vmax' && st.rect.height === wa.height && st.rect.width === 700);
      await A((id) => window.__aurora.wm.get(id).restore(), id);
      await closeAll();
    }

    // -------------------------------------------------------- Super+1..9
    if (want('taskbarnum')) {
      const n = await A(() => [...document.querySelectorAll('#taskbar .tb-app[data-app]')].map((b) => b.dataset.app));
      const calcIdx = n.indexOf('calculator');
      const idx = calcIdx >= 0 ? calcIdx + 1 : null;
      if (idx) {
        await hk(`Super+${idx}`);
        await page.waitForFunction(() => window.__aurora.wm.byApp('calculator').length === 1, null, { timeout: 8000 }).catch(() => {});
        check(`Super+${idx} launches the pinned calculator`, (await A(() => window.__aurora.wm.byApp('calculator').length)) === 1);
      } else {
        // Calculator not pinned: launch it, then use its (running) slot.
        await A(() => window.__aurora.shell.launch('calculator'));
        await page.waitForFunction(() => window.__aurora.wm.byApp('calculator').length === 1, null, { timeout: 8000 }).catch(() => {});
      }
      await sleep(400);
      const slots = await A(() => [...document.querySelectorAll('#taskbar .tb-app[data-app]')].filter((b) => !b.classList.contains('leaving')).map((b) => b.dataset.app));
      const k = slots.indexOf('calculator') + 1;
      check('calculator has a taskbar slot', k > 0, slots.join(','));
      if (k > 0) {
        await hk(`Super+${k}`);
        await sleep(350);
        check(`Super+${k} on the focused app minimises it`, await A(() => window.__aurora.wm.byApp('calculator')[0]?.minimized));
        await hk(`Super+${k}`);
        await sleep(350);
        check(`Super+${k} again restores + focuses it`, await A(() => window.__aurora.wm.byApp('calculator')[0]?.isFocused()));
      }
      await closeAll();
    }

    // -------------------------------------------------------- Alt+Tab
    if (want('alttab')) {
      if (!(await launchIf('calculator'))) await newWin('Calculator', { width: 360, height: 540 });
      if (!(await launchIf('winver'))) await newWin('About Aurora', { width: 460, height: 420 });
      await sleep(400);
      await newWin('Report.txt — Notes', { width: 720, height: 480 });
      await newWin('Budget 2026', { width: 760, height: 500 });
      await sleep(1300); // let the focus capture run
      const before = await focusedTitle();
      // Quick tap: switches to the previous window without showing the panel.
      await T.send([['keyDown', 'Alt', []], ['keyDown', 'Tab', ['alt']], ['keyUp', 'Tab', ['alt']], ['keyUp', 'Alt', []]]);
      await sleep(500);
      check('quick Alt+Tab switches to the previous window', (await focusedTitle()) === 'Report.txt — Notes', `was ${before}`);
      check('quick Alt+Tab never showed the panel', await A(() => !document.querySelector('.alttab-layer')));
      // Hold Alt: panel appears, Tab twice, release.
      await T.send([['keyDown', 'Alt', []], ['keyDown', 'Tab', ['alt']], ['keyUp', 'Tab', ['alt']]]);
      await page.waitForSelector('.alttab', { timeout: 3000 }).catch(() => {});
      await sleep(350);
      const cards = await A(() => [...document.querySelectorAll('.alttab-card .alttab-title')].map((e) => e.textContent));
      check('Alt+Tab panel lists windows in MRU order', cards[0] === 'Report.txt — Notes' && cards[1] === 'Budget 2026' && cards.length === 4, cards.join(' | '));
      check('Alt+Tab selects the 2nd card', await A(() => document.querySelectorAll('.alttab-card')[1]?.classList.contains('sel')));
      check('Alt+Tab thumbnails are real content (canvas/clone), not placeholders', await A(() => document.querySelectorAll('.alttab-thumb .wthumb-ph').length === 0));
      await T.send([['keyDown', 'Tab', ['alt']], ['keyUp', 'Tab', ['alt']]]);
      await sleep(250);
      await shot('wm-alttab', true);
      await T.send([['keyDown', 'Tab', ['alt', 'shift']], ['keyUp', 'Tab', ['alt', 'shift']]]);
      await sleep(120);
      await T.send([['keyDown', 'Tab', ['alt']], ['keyUp', 'Tab', ['alt']]]);
      await sleep(120);
      await T.send([['keyUp', 'Alt', []]]);
      await sleep(400);
      check('releasing Alt switches to the selected window', (await focusedTitle()) !== 'Report.txt — Notes' && !(await A(() => window.__aurora.alttab.isOpen)), await focusedTitle());
      // Esc cancels.
      const f0 = await focusedTitle();
      await hk('Alt+Tab');
      await sleep(600);
      await A(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
      await sleep(250);
      check('Esc cancels Alt+Tab', (await focusedTitle()) === f0 && !(await A(() => window.__aurora.alttab.isOpen)));
      // Arrow keys + mouse click.
      await hk('Alt+Tab');
      await page.waitForSelector('.alttab-card', { timeout: 3000 });
      await sleep(300);
      await A(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
      check('ArrowRight moves the selection', await A(() => document.querySelectorAll('.alttab-card')[2]?.classList.contains('sel')));
      const target = await A(() => document.querySelectorAll('.alttab-card .alttab-title')[3].textContent);
      await page.click('.alttab-card:nth-child(4)');
      await sleep(350);
      check('clicking a card switches to it', (await focusedTitle()) === target, target);
      // Close button on a card.
      await hk('Ctrl+Alt+Tab');
      await page.waitForSelector('.alttab-card', { timeout: 3000 });
      await sleep(300);
      const n0 = await A(() => window.__aurora.wm.list().length);
      await page.hover('.alttab-card:nth-child(2)');
      await page.click('.alttab-card:nth-child(2) .alttab-x');
      await sleep(400);
      check('X on a card closes that window (sticky switcher stays open)', (await A(() => window.__aurora.wm.list().length)) === n0 - 1 && (await A(() => window.__aurora.alttab.isOpen)));
      await A(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
      await sleep(250);
      check('Enter commits the sticky switcher', !(await A(() => window.__aurora.alttab.isOpen)));
    }

    // -------------------------------------------------------- keyboard focus follows activation
    if (want('focus')) {
      await closeAll();
      const a = await newWin('Focus A');
      await sleep(200);
      await A((id) => window.__aurora.wm.get(id).body.querySelector('input').focus(), a);
      await A((id) => (window.__aurora.wm.get(id).body.querySelector('input').value = 'hello'), a);
      const b = await newWin('Focus B');
      await sleep(250);
      check('new window takes keyboard focus', await A((id) => window.__aurora.wm.get(id).el.contains(document.activeElement), b));
      await hk('Alt+Tab');
      await sleep(50);
      await hk('Alt:up');
      await sleep(250);
      check('switching back restores focus to the last focused control', await A((id) => document.activeElement === window.__aurora.wm.get(id).body.querySelector('input'), a));
      // Showing the panel and coming back to the same window keeps the caret where it was.
      await hk('Ctrl+Alt+Tab');
      await page.waitForSelector('.alttab-card', { timeout: 3000 });
      await A(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
      await sleep(250);
      check('Esc from the switcher gives the keyboard back to the same control', await A((id) => document.activeElement === window.__aurora.wm.get(id).body.querySelector('input'), a));
      await hk('Super+Tab');
      await sleep(450);
      await A(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
      await sleep(450);
      check('leaving Task View gives the keyboard back to the active window', await A((id) => document.activeElement === window.__aurora.wm.get(id).body.querySelector('input'), a));
      // One key press = exactly one hotkey event, whether the shell page or a webview has focus.
      await A(() => {
        window.__hkCount = 0;
        window.__aurora.api.on('shell:hotkey', (p) => p.combo === 'Super+K' && window.__hkCount++);
      });
      await press('Super+K', 200);
      check('no double handling: one IPC event per press (shell page)', (await A(() => window.__hkCount)) === 1);
      // Webview focus: clicking inside a <webview> activates its window.
      const wv = await A(() => {
        const { wm } = window.__aurora;
        const w = wm.create({ appId: 'webtest', title: 'Web content', width: 560, height: 360, x: 80, y: 80 });
        const v = document.createElement('webview');
        v.setAttribute('partition', 'persist:web-wmtest');
        v.setAttribute('src', 'data:text/html,<body style="font:20px sans-serif"><input autofocus> web page</body>');
        v.style.flex = '1';
        w.body.appendChild(v);
        return w.id;
      });
      await sleep(1500);
      await A((id) => window.__aurora.wm.get(id).focus(), b);
      await sleep(200);
      check('precondition: other window focused', (await focusedTitle()) === 'Focus B');
      // Move B away so the webview is not covered.
      await A((id) => window.__aurora.wm.get(id).setRect({ x: 900, y: 300 }), b);
      await page.mouse.click(300, 250);
      await sleep(400);
      check('clicking inside a <webview> focuses its window', (await focusedTitle()) === 'Web content', await focusedTitle());
      await s.app.evaluate(({ webContents }) => {
        const g = webContents.getAllWebContents().find((w) => w.getType() === 'webview');
        g.sendInputEvent({ type: 'keyDown', keyCode: 'K', modifiers: ['meta'] });
        g.sendInputEvent({ type: 'keyUp', keyCode: 'K', modifiers: ['meta'] });
      });
      await sleep(200);
      check('no double handling: one IPC event per press (webview)', (await A(() => window.__hkCount)) === 2);
      // Alt+Tab pressed while a webview has the keyboard: the guest swallows the combo, the shell pulls
      // focus into its own page at once, so the Alt release (sent where the OS would send it: the
      // now-focused shell page) still commits the switch.
      await A(() => (window.__wvTarget = window.__aurora.wm.mru()[1]?.title));
      await s.app.evaluate(({ webContents }) => {
        const g = webContents.getAllWebContents().find((w) => w.getType() === 'webview');
        g.sendInputEvent({ type: 'keyDown', keyCode: 'Alt', modifiers: [] });
        g.sendInputEvent({ type: 'keyDown', keyCode: 'Tab', modifiers: ['alt'] });
      });
      await sleep(150);
      check('Alt+Tab from inside a webview opens the switcher and takes the keyboard', await A(() => window.__aurora.alttab.isOpen && document.activeElement?.classList.contains('alttab-sink')));
      await T.send([['keyUp', 'Alt', []]]);
      await sleep(300);
      check('… and releasing Alt switches', !(await A(() => window.__aurora.alttab.isOpen)) && (await focusedTitle()) === (await A(() => window.__wvTarget)));
      await A((id) => window.__aurora.wm.get(id).close(true), wv);
      await closeAll();
    }

    // -------------------------------------------------------- Task View + virtual desktops
    if (want('taskview')) {
      await closeAll();
      if (!(await launchIf('calculator'))) await newWin('Calculator', { width: 360, height: 540 });
      if (!(await launchIf('files'))) await launchIf('paint') || (await newWin('Photos', { width: 900, height: 600 }));
      await sleep(400);
      await newWin('Project plan', { width: 820, height: 520 });
      await newWin('Inbox — 3 unread', { width: 700, height: 480 });
      await A(() => window.__aurora.wm.list().find((w) => w.title === 'Inbox — 3 unread').minimize());
      await sleep(400);
      await press('Super+Tab', 600);
      check('Super+Tab opens Task View (real key path)', await A(() => window.__aurora.taskview.isOpen));
      const nCards = await A(() => document.querySelectorAll('.tv-card').length);
      const nWins = await A(() => window.__aurora.wm.listDesktop().length);
      check('Task View shows every window (incl. minimised)', nCards === nWins && nCards >= 4, `${nCards}/${nWins}`);
      const overlap = await A(() => {
        const r = [...document.querySelectorAll('.tv-card')].map((c) => c.getBoundingClientRect());
        for (let i = 0; i < r.length; i++)
          for (let j = i + 1; j < r.length; j++) if (r[i].left < r[j].right - 1 && r[j].left < r[i].right - 1 && r[i].top < r[j].bottom - 1 && r[j].top < r[i].bottom - 1) return true;
        return r.some((x) => x.left < 0 || x.right > innerWidth || x.top < 0);
      });
      check('Task View cards do not overlap and stay on screen', !overlap);
      check('Task View animates the real window elements', await A(() => window.__aurora.wm.list().every((w) => w.el.classList.contains('tv-win') && w.el.style.transform.includes('scale'))));
      await sleep(250);
      await shot('wm-taskview', true);
      // Click a card -> focus it and leave.
      const tgt = await A(() => {
        const c = [...document.querySelectorAll('.tv-card')].find((c) => c.getAttribute('aria-label') === 'Project plan');
        const r = c.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      await page.mouse.click(tgt.x, tgt.y);
      await sleep(500);
      check('clicking a card focuses that window and exits', (await focusedTitle()) === 'Project plan' && !(await A(() => window.__aurora.taskview.isOpen)));
      check('windows are back in place (no transforms left)', await A(() => window.__aurora.wm.list().every((w) => !w.el.style.transform && !w.el.classList.contains('tv-win'))));
      check('minimised window is minimised again', await A(() => window.__aurora.wm.list().find((w) => w.title === 'Inbox — 3 unread').minimized));
      // Esc exits; Super+Tab toggles.
      await hk('Super+Tab');
      await sleep(400);
      await A(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
      await sleep(450);
      check('Esc leaves Task View', !(await A(() => window.__aurora.taskview.isOpen)));
      // Close button on a card.
      await hk('Super+Tab');
      await sleep(450);
      const before = await A(() => window.__aurora.wm.list().length);
      const card = '.tv-card[aria-label="Inbox — 3 unread"]';
      await page.hover(card);
      await page.click(`${card} .tv-x`);
      await sleep(500);
      check('X on a Task View card closes the window', (await A(() => window.__aurora.wm.list().length)) === before - 1 && (await A(() => document.querySelectorAll('.tv-card').length)) === before - 1);
      // New desktop from the strip.
      await page.click('.tv-new');
      await sleep(300);
      check('"New desktop" adds a desktop tile', (await A(() => window.__aurora.wm.desktops.length)) === 2 && (await A(() => document.querySelectorAll('.tv-desk:not(.tv-new)').length)) === 2);
      // Drag a window card onto Desktop 2.
      const drag = await A(() => {
        const c = document.querySelector('.tv-card[aria-label="Project plan"]').getBoundingClientRect();
        const d = document.querySelectorAll('.tv-desk:not(.tv-new)')[1].getBoundingClientRect();
        return { sx: c.left + c.width / 2, sy: c.top + c.height / 2, dx: d.left + d.width / 2, dy: d.top + d.height / 2 };
      });
      await page.mouse.move(drag.sx, drag.sy);
      await page.mouse.down();
      for (let i = 1; i <= 12; i++) await page.mouse.move(drag.sx + ((drag.dx - drag.sx) * i) / 12, drag.sy + ((drag.dy - drag.sy) * i) / 12);
      await sleep(120);
      check('dragging a card highlights the desktop tile', await A(() => !!document.querySelector('.tv-desk.drop')));
      await shot('wm-taskview-drag');
      await page.mouse.up();
      await page.mouse.move(drag.sx, 120, { steps: 3 }); // off the strip: back to the current desktop
      await sleep(700);
      const moved = await A(() => window.__aurora.wm.list().find((w) => w.title === 'Project plan')?.desktop);
      const d2 = await A(() => window.__aurora.wm.desktops[1].id);
      check('dropping a card on Desktop 2 moves the window there', moved === d2);
      check('moved window left the current grid', (await A(() => document.querySelectorAll('.tv-card[aria-label="Project plan"]').length)) === 0);
      // Rename desktop 2: clicking its name edits it (Windows 11).
      await page.click('.tv-desk:nth-child(2) .tv-desk-name');
      await sleep(150);
      await page.keyboard.press('Control+A');
      await page.keyboard.type('Work');
      await page.keyboard.press('Enter');
      await sleep(200);
      check('desktop rename (click on the name)', (await A(() => window.__aurora.wm.desktopName(window.__aurora.wm.desktops[1].id))) === 'Work');
      await page.hover('.tv-desk:nth-child(2)');
      await sleep(600);
      check('hovering a desktop tile previews its windows', (await A(() => [...document.querySelectorAll('.tv-card')].map((c) => c.getAttribute('aria-label')).join('|'))) === 'Project plan');
      await shot('wm-desktops', true);
      await page.click('.tv-desk:nth-child(2) .tv-desk-thumb');
      await sleep(600);
      check('clicking a desktop tile switches to it', (await A(() => window.__aurora.wm.currentDesktop)) === d2 && !(await A(() => window.__aurora.taskview.isOpen)));
      check('only the current desktop’s windows are visible', await A(() => window.__aurora.wm.list().every((w) => (w.desktop === window.__aurora.wm.currentDesktop) !== w.el.classList.contains('off-desktop'))));
      check('the window on that desktop is focused', (await focusedTitle()) === 'Project plan');
      // Keyboard desktop switching.
      await press('Super+Ctrl+ArrowLeft', 500);
      check('Super+Ctrl+Left switches to Desktop 1 (real key path)', (await A(() => window.__aurora.wm.desktopIndex(window.__aurora.wm.currentDesktop))) === 0);
      check('desktop switch shows the name pill', await A(() => !!document.querySelector('.tv-pill')));
      await shot('wm-desktop-pill');
      await hk('Super+Ctrl+ArrowRight');
      await sleep(450);
      check('Super+Ctrl+Right switches to Desktop 2', (await A(() => window.__aurora.wm.desktopIndex(window.__aurora.wm.currentDesktop))) === 1);
      await hk('Super+Ctrl+D');
      await sleep(450);
      check('Super+Ctrl+D creates and switches to a new desktop', (await A(() => [window.__aurora.wm.desktops.length, window.__aurora.wm.desktopIndex(window.__aurora.wm.currentDesktop)].join())) === '3,2');
      await hk('Super+Ctrl+F4');
      await sleep(450);
      check('Super+Ctrl+F4 closes the current desktop', (await A(() => window.__aurora.wm.desktops.length)) === 2);
      const saved = await A(() => window.__aurora.api.invoke('storage:get', 'shell', 'desktops', null));
      check('desktop names persist', Array.isArray(saved) && saved[1]?.name === 'Work', JSON.stringify(saved));
      // Removing desktop 2 merges its windows into desktop 1.
      await A(() => window.__aurora.wm.removeDesktop(window.__aurora.wm.desktops[1].id));
      await sleep(450);
      check('closing a desktop moves its windows to the neighbour', await A(() => window.__aurora.wm.list().every((w) => w.desktop === window.__aurora.wm.desktops[0].id && !w.el.classList.contains('off-desktop'))));
      await closeAll();
    }

    // -------------------------------------------------------- Snap layouts, drag bar, Snap Assist
    if (want('snap')) {
      await closeAll();
      const other1 = await newWin('Spreadsheet', { width: 600, height: 400, x: 700, y: 300 });
      const other2 = await newWin('Music', { width: 500, height: 360, x: 900, y: 120 });
      const id = await newWin('Article draft', { width: 760, height: 500, x: 220, y: 120 });
      await sleep(1100);
      const max = await A((id) => {
        const r = window.__aurora.wm.get(id).btnMax.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }, id);
      await page.mouse.move(max.x - 60, max.y);
      await page.mouse.move(max.x, max.y, { steps: 4 });
      await page.waitForSelector('.snapl-fly', { timeout: 3000 }).catch(() => {});
      check('hovering maximize shows the snap layouts flyout', await A(() => !!document.querySelector('.snapl-fly')));
      const zoneSel = '.snapl-fly .snapl-layout[data-layout="2"] .snapl-zone[data-zone="third-l"]';
      const z = await A((sel) => {
        const r = document.querySelector(sel).getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }, zoneSel);
      await page.mouse.move(max.x, max.y + 30, { steps: 3 });
      await page.mouse.move(z.x, z.y, { steps: 6 });
      await sleep(250);
      check('flyout stays open while moving into it; zone highlights', await A((sel) => document.querySelector(sel)?.matches(':hover'), zoneSel));
      await shot('wm-snaplayouts', true);
      await page.mouse.click(z.x, z.y);
      await sleep(250);
      let st = await winState(id);
      const wa = await A(() => window.__aurora.wm.workarea());
      check('clicking a zone snaps the window there', st.snap === 'third-l' && st.rect.width === Math.round(wa.width / 3));
      await page.waitForSelector('.snapa .snapa-card', { timeout: 3000 }).catch(() => {});
      await sleep(250);
      check('Snap Assist offers the other windows in the next zone', (await A(() => document.querySelectorAll('.snapa-card').length)) === 2);
      await shot('wm-snapassist', true);
      await page.click('.snapa-card[data-id="' + other1 + '"]');
      await sleep(350);
      check('choosing a window in Snap Assist snaps it to that zone', (await winState(other1)).snap === 'third-c');
      check('Snap Assist moves on to the last zone', await A(() => document.querySelectorAll('.snapa-card').length === 1));
      await page.click('.snapa-card');
      await sleep(350);
      check('… and fills it', (await winState(other2)).snap === 'third-r' && !(await A(() => window.__aurora.snap.assistOpen)));
      // Drag to the top centre: layouts bar.
      await A((id) => window.__aurora.wm.get(id).restore(), id);
      await sleep(300);
      const tb = await A((id) => {
        const r = window.__aurora.wm.get(id).titlebar.getBoundingClientRect();
        return { x: r.left + 200, y: r.top + 14 };
      }, id);
      await page.mouse.move(tb.x, tb.y);
      await page.mouse.down();
      await page.mouse.move(tb.x + 100, tb.y + 40, { steps: 4 });
      await page.mouse.move(800, 30, { steps: 8 });
      await sleep(250);
      check('dragging to the top centre shows the layouts bar', await A(() => !!document.querySelector('.snapl-bar')));
      const bz = await A(() => {
        const r = document.querySelector('.snapl-bar .snapl-layout[data-layout="0"] .snapl-zone[data-zone="right"]').getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      await page.mouse.move(bz.x, bz.y, { steps: 5 });
      await sleep(250);
      check('hovering a bar zone previews it', await A(() => window.__aurora.wm.dragSnapOverride === 'right' && document.querySelector('.snap-preview').classList.contains('show')));
      await shot('wm-snapbar');
      await page.mouse.up();
      await sleep(400);
      check('dropping on a bar zone snaps there', (await winState(id)).snap === 'right' && !(await A(() => !!document.querySelector('.snapl-bar:not(.closing)'))));
      await A(() => window.__aurora.snap.endAssist());
      // Classic edge snapping still works.
      await A((id) => window.__aurora.wm.get(id).restore(), id);
      await sleep(300);
      const tb2 = await A((id) => {
        const r = window.__aurora.wm.get(id).titlebar.getBoundingClientRect();
        return { x: r.left + 150, y: r.top + 14 };
      }, id);
      await page.mouse.move(tb2.x, tb2.y);
      await page.mouse.down();
      await page.mouse.move(300, 400, { steps: 5 });
      await page.mouse.move(1, 400, { steps: 5 });
      await sleep(150);
      check('edge drag shows the snap preview', await A(() => document.querySelector('.snap-preview').classList.contains('show')));
      await page.mouse.up();
      await sleep(400);
      check('edge drag snaps left', (await winState(id)).snap === 'left');
      await A(() => window.__aurora.snap.endAssist());
      // Super+Z keyboard flyout.
      await hk('Super+Z');
      await sleep(250);
      check('Super+Z opens the flyout with layout numbers', await A(() => !!document.querySelector('.snapl-fly.kbd .snapl-num')));
      await A(() => {
        for (const k of ['5', '4']) document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
      });
      await sleep(300);
      check('Super+Z then 5,4 snaps to the bottom-right quarter', (await winState(id)).snap === 'br');
      await A(() => window.__aurora.snap.endAssist());
      await closeAll();
    }

    // -------------------------------------------------------- Ctrl+Alt+Del
    if (want('security')) {
      await newWin('Behind the screen');
      await sleep(300);
      await press('Ctrl+Alt+Delete', 600);
      check('Ctrl+Alt+Del shows the security screen (real key path)', await A(() => window.__aurora.security.isOpen && !!document.querySelector('.sec-screen')));
      const opts = await A(() => [...document.querySelectorAll('.sec-opt')].map((b) => b.textContent));
      check('security options', ['Lock', 'Switch user', 'Sign out'].every((x) => opts.includes(x)), opts.join(', '));
      check('first option has keyboard focus', await A(() => document.activeElement?.classList.contains('sec-opt')));
      await shot('wm-security', true);
      await A(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
      await sleep(350);
      check('Esc cancels the security screen', await A(() => !window.__aurora.security.isOpen && !document.querySelector('.sec-screen')));
      let locked = false;
      await A(() => window.__aurora.shell.on('lock', () => (window.__lockedOnce = true)));
      await hk('Ctrl+Alt+Delete');
      await sleep(400);
      await page.click('.sec-opt[data-key="lock"]');
      await sleep(400);
      locked = await A(() => !!window.__lockedOnce);
      check('"Lock" locks the session', locked);
      await A(() => window.__aurora.shell.emit('unlock'));
      await A(() => document.querySelectorAll('#overlays > *').forEach((e) => e.classList.contains('sec-screen') && e.remove()));
      await closeAll();
    }

    // -------------------------------------------------------- Run
    if (want('run')) {
      await closeAll();
      await A(() => window.__aurora.api.invoke('storage:set', 'shell', 'run-history', []));
      await press('Super+R', 700);
      check('Super+R opens Run (real key path)', await A(() => !!document.querySelector('.wm-run .run-input')));
      const geo = await A(() => {
        const w = window.__aurora.wm.list().find((x) => x.appId === 'run');
        return { x: w.x, bottom: w.y + w.h, wa: window.__aurora.wm.workarea(), focused: document.activeElement?.classList.contains('run-input') };
      });
      check('Run sits bottom-left above the taskbar with the input focused', geo.x <= 16 && geo.bottom >= geo.wa.height - 16 && geo.focused);
      check('resolve: "calc" -> calculator', (await A(() => window.__aurora.run.resolve('calc')))?.appId === 'calculator');
      check('resolve: "explorer" -> files', (await A(() => window.__aurora.run.resolve('explorer')))?.appId === 'files');
      check('resolve: "minesw" (prefix) -> minesweeper', (await A(() => window.__aurora.run.resolve('minesw')))?.appId === 'minesweeper');
      check('resolve: URL', (await A(() => window.__aurora.run.resolve('https://example.org/a')))?.kind === 'url');
      check('resolve: www.*', (await A(() => window.__aurora.run.resolve('www.example.org')))?.url === 'https://www.example.org');
      check('resolve: ~/Documents -> folder', (await A(() => window.__aurora.run.resolve('~/Documents')))?.dir === true);
      check('resolve: ms-settings:display', JSON.stringify((await A(() => window.__aurora.run.resolve('ms-settings:display')))?.args) === '{"page":"display"}');
      check('resolve: unknown -> null', (await A(() => window.__aurora.run.resolve('qwertyzzz'))) === null);
      check('resolve: app + file argument', await A(async () => {
        const home = window.__aurora.env.home;
        await window.__aurora.api.invoke('fs:writeText', `${home}/Documents/run test.txt`, 'x');
        const app = ['notepad', 'paint', 'calculator'].find((id) => window.__aurora.registry.get(id));
        const r = await window.__aurora.run.resolve(`${app} "~/Documents/run test.txt"`);
        return r?.appId === app && r.args.file === `${home}/Documents/run test.txt`;
      }));
      await page.fill('.run-input', 'calc');
      await sleep(250);
      check('typing shows app suggestions', await A(() => [...document.querySelectorAll('.run-opt')].some((o) => o.dataset.value === 'calculator')));
      await shot('wm-run-suggest');
      await page.keyboard.press('Escape');
      await sleep(80);
      check('Esc closes the suggestions first (Run stays open)', await A(() => !document.querySelector('.run-drop') && !!document.querySelector('.wm-run')));
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => window.__aurora.wm.byApp('calculator').length === 1, null, { timeout: 8000 }).catch(() => {});
      await sleep(300);
      check('Enter runs it (calculator opened, Run closed)', (await A(() => window.__aurora.wm.byApp('calculator').length)) === 1 && !(await A(() => !!document.querySelector('.wm-run'))));
      check('history persisted', JSON.stringify(await A(() => window.__aurora.api.invoke('storage:get', 'shell', 'run-history', []))) === '["calc"]');
      await hk('Super+R');
      await sleep(500);
      check('Run reopens with the last command preselected', (await A(() => document.querySelector('.run-input').value)) === 'calc');
      await page.click('.run-dd');
      await sleep(250);
      check('history dropdown', (await A(() => [...document.querySelectorAll('.run-opt')].map((o) => o.dataset.value).join())) === 'calc');
      await page.click('.run-dd');
      await page.fill('.run-input', 'nonexistent-thing');
      await sleep(150);
      await shot('wm-run', true);
      await page.click('.wm-run .run-foot .btn.primary');
      await sleep(400);
      check('unknown command shows an error dialog', await A(() => !!document.querySelector('.dialog-layer.global')));
      await shot('wm-run-error');
      await page.keyboard.press('Enter');
      await sleep(300);
      check('error dismissed, focus back in Run', await A(() => document.activeElement?.classList.contains('run-input')));
      await A(() => window.__aurora.wm.list().find((w) => w.appId === 'run')?.close());
      await closeAll();
    }

    // -------------------------------------------------------- Win+X
    if (want('winx')) {
      await newWin('Under the menu');
      await sleep(200);
      await press('Super+X', 400);
      check('Super+X opens the power-user menu (real key path)', await A(() => window.__aurora.winx.isOpen && !!document.querySelector('.menu.wm-accel-menu')));
      const pos = await A(() => {
        const m = document.querySelector('.menu.wm-accel-menu').getBoundingClientRect();
        const s = document.querySelector('#taskbar .tb-start').getBoundingClientRect();
        return { above: m.bottom <= s.top + 1, left: Math.abs(m.left - s.left) < 8 };
      });
      check('Win+X menu sits above the Start button', pos.above && pos.left, JSON.stringify(pos));
      await shot('wm-winx', true);
      await A(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'u', bubbles: true })));
      await sleep(350);
      check('accelerator opens "Shut down or sign out" submenu', await A(() => document.querySelectorAll('body > .menu').length === 2));
      await A(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
      await A(() => window.__aurora.ui.closeMenus());
      await sleep(200);
      await hk('Super+X');
      await sleep(250);
      await A(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true })));
      await sleep(600);
      check('accelerator R opens Run', await A(() => !!document.querySelector('.wm-run')) && !(await A(() => window.__aurora.winx.isOpen)));
      await A(() => window.__aurora.wm.list().find((w) => w.appId === 'run')?.close());
      await hk('Super+X');
      await sleep(200);
      await hk('Super+X');
      await sleep(200);
      check('Super+X again closes it', !(await A(() => window.__aurora.winx.isOpen)));
      await page.click('#taskbar .tb-start', { button: 'right' });
      await sleep(300);
      check('right-click on Start opens it too', await A(() => window.__aurora.winx.isOpen));
      await A(() => window.__aurora.ui.closeMenus());
      await closeAll();
    }

    // -------------------------------------------------------- window menu, keyboard move/size
    if (want('sysmenu')) {
      const id = await newWin('Movable', { width: 600, height: 400, x: 300, y: 150 });
      await sleep(300);
      await page.click(`.win[data-id="${id}"] .win-titlebar`, { button: 'right', position: { x: 220, y: 14 } });
      await sleep(250);
      const items = await A(() => [...document.querySelectorAll('.menu.wm-accel-menu .menu-item')].map((r) => [r.textContent.replace('Alt+F4', '').trim(), r.classList.contains('disabled')]));
      check('title bar menu items + disabled states', JSON.stringify(items) === JSON.stringify([['Restore', true], ['Move', false], ['Size', false], ['Minimize', false], ['Maximize', false], ['Close', false]]), JSON.stringify(items));
      await shot('wm-sysmenu', true);
      await A(() => window.__aurora.ui.closeMenus());
      await press('Alt+Space', 300);
      check('Alt+Space opens it for the focused window (real key path)', await A(() => !!document.querySelector('.menu.wm-accel-menu.kbd')));
      await A(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', bubbles: true })));
      await sleep(200);
      check('M starts keyboard move', await A(() => document.body.classList.contains('wm-kb-moving')));
      for (let i = 0; i < 3; i++) await A(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
      await A(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
      await A(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
      let st = await winState(id);
      check('arrows move the window, Enter commits', st.rect.x === 330 && st.rect.y === 160 && !(await A(() => document.body.classList.contains('wm-kb-moving'))));
      await A((id) => window.__aurora.wm.get(id).startKeyboardMove('size'), id);
      for (const k of ['ArrowRight', 'ArrowRight', 'ArrowRight']) await A((k) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })), k);
      await A(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
      await sleep(300);
      st = await winState(id);
      check('keyboard size + Esc restores the original size', st.rect.width === 600);
      await A((id) => window.__aurora.wm.get(id).startKeyboardMove('size'), id);
      for (const k of ['ArrowRight', 'ArrowRight', 'ArrowRight', 'Enter']) await A((k) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })), k);
      st = await winState(id);
      check('keyboard size (right edge) grows the window', st.rect.width === 620);
      await closeAll();
    }

    // -------------------------------------------------------- Alt+F4 / Shut Down dialog
    if (want('altf4')) {
      const id = await newWin('Closable');
      await sleep(250);
      await press('Alt+F4', 450);
      check('Alt+F4 closes the focused window (real key path)', !(await winState(id)));
      await A(() => window.__aurora.wm.focusTop());
      await press('Alt+F4', 500);
      check('Alt+F4 with no window shows "Shut Down Aurora"', await A(() => !!document.querySelector('.sd-dialog')));
      check('default action is Shut down', (await A(() => document.querySelector('.sd-select').value)) === 'shutdown');
      await A(() => {
        const s = document.querySelector('.sd-select');
        s.value = 'restart';
        s.dispatchEvent(new Event('change'));
      });
      check('description follows the selection', (await A(() => document.querySelector('.sd-desc').textContent)).includes('turns it on again'));
      await A(() => {
        const s = document.querySelector('.sd-select');
        s.value = 'shutdown';
        s.dispatchEvent(new Event('change'));
      });
      await shot('wm-shutdown', true);
      await hk('Alt+F4');
      await sleep(300);
      check('Alt+F4 on the dialog cancels it', await A(() => !document.querySelector('.sd-dialog')));
    }

    // -------------------------------------------------------- volume keys / OSD
    if (want('volume')) {
      await A(() => {
        window.__osd = [];
        window.__aurora.shell.on('osd', (o) => window.__osd.push(o));
      });
      const hasAudio = await A(() => window.__aurora.api.invoke('audio:status').then(() => true, () => false));
      await press('AudioVolumeUp', 400);
      if (hasAudio) {
        const osd = await A(() => window.__osd);
        check('volume key -> audio:setVolume + osd event (real key path)', osd.length === 1 && osd[0].kind === 'volume' && typeof osd[0].value === 'number', JSON.stringify(osd));
        const v0 = osd[0]?.value;
        await press('AudioVolumeDown', 400);
        check('volume down steps by 2', (await A(() => window.__osd[1]?.value)) === v0 - 2);
        await press('AudioVolumeMute', 400);
        check('mute toggles', (await A(() => window.__osd[2]?.muted)) === true);
        await press('AudioVolumeMute', 400);
      } else check('volume key without audio backend: no osd, no error', (await A(() => window.__osd.length)) === 0);
    }

    // -------------------------------------------------------- multitasking settings
    if (want('settings')) {
      await A(() => window.__aurora.settings.set('multitasking', { snap: false, shake: true }));
      await sleep(200);
      const id = await newWin('No snapping', { width: 600, height: 400, x: 300, y: 200 });
      await sleep(300);
      await hk('Super+ArrowLeft');
      check('multitasking.snap=false: Super+Left does not snap', (await winState(id)).state === 'normal');
      check('multitasking.shake=true enables title bar shake', await A(() => window.__aurora.wm.shakeToMinimize === true && window.__aurora.wm.snapEnabled === false));
      await A(() => window.__aurora.settings.set('multitasking', {}));
      await sleep(200);
      check('defaults restored', await A(() => window.__aurora.wm.shakeToMinimize === false && window.__aurora.wm.snapEnabled === true));
      await closeAll();
    }

    // -------------------------------------------------------- WM polish
    if (want('wm')) {
      await closeAll();
      const id = await newWin('Polish', { width: 640, height: 420, x: 400, y: 200 });
      await sleep(300);
      await A((id) => window.__aurora.wm.get(id).maximize(), id);
      check('maximize animates', await A((id) => window.__aurora.wm.get(id).el.getAnimations().length > 0, id));
      await sleep(320);
      await A((id) => window.__aurora.wm.get(id).restore(), id);
      check('restore animates too', await A((id) => window.__aurora.wm.get(id).el.getAnimations().length > 0, id));
      await sleep(320);
      check('restore returns to the previous rect', JSON.stringify((await winState(id)).rect) === JSON.stringify({ x: 400, y: 200, width: 640, height: 420 }));
      // Double-click the top border: vertical maximise and back.
      await page.dblclick(`.win[data-id="${id}"] .r-n`);
      await sleep(300);
      let st = await winState(id);
      const wa = await A(() => window.__aurora.wm.workarea());
      check('double-click on the top border maximises vertically', st.snap === 'vmax' && st.rect.y === wa.y && st.rect.height === wa.height && st.rect.x === 400);
      await page.dblclick(`.win[data-id="${id}"] .r-n`);
      await sleep(300);
      st = await winState(id);
      check('double-click again restores', st.state === 'normal' && st.rect.height === 420);
      // Windows never end up off-screen after a resolution change.
      await A((id) => window.__aurora.wm.get(id).setRect({ x: 1450, y: 700 }), id);
      await page.setViewportSize({ width: 1024, height: 700 }).catch(() => {});
      await A(() => window.dispatchEvent(new Event('resize')));
      await sleep(300);
      st = await winState(id);
      const wa2 = await A(() => window.__aurora.wm.workarea());
      check('window pulled back on screen after a resolution change', st.rect.x + 64 <= wa2.x + wa2.width && st.rect.y + 32 <= wa2.y + wa2.height && st.rect.width <= wa2.width, JSON.stringify(st.rect));
      await page.setViewportSize({ width: 1600, height: 900 }).catch(() => {});
      await A(() => window.dispatchEvent(new Event('resize')));
      await sleep(200);
      // Non-maximizable windows hide their maximize button.
      await A(() => window.__aurora.shell.launch('winver'));
      await sleep(500);
      check('maximize button hidden for non-resizable windows', await A(() => getComputedStyle(window.__aurora.wm.byApp('winver')[0].btnMax).display === 'none'));
      // z-order: focusing a fullscreen window keeps it above everything.
      const fs1 = await newWin('Fullscreen');
      await A((id) => window.__aurora.wm.get(id).setFullscreen(true), fs1);
      await A((id) => window.__aurora.wm.get(id).focus(), id);
      await A((id) => window.__aurora.wm.get(id).focus(), fs1);
      check('fullscreen window stays on top after refocus', await A((id) => Number(window.__aurora.wm.get(id).el.style.zIndex) > 200000, fs1));
      await closeAll();
    }
  } finally {
    const mine = T.myErrors();
    check('no renderer errors from wm-nav code', mine.length === 0, mine.map((e) => e.text).join(' | '));
    const other = T.errors.filter((e) => !mine.includes(e));
    if (other.length) console.log(`note: ${other.length} renderer error(s) from other areas:\n  ${[...new Set(other.map((e) => `${e.text} @ ${e.url}`))].slice(0, 8).join('\n  ')}`);
    await s.close();
  }
}

// ------------------------------------------------------------------ French + dark: visuals and overflow
async function frenchDarkRun() {
  const s = await launchShell({ lang: 'fr', theme: 'dark' });
  const T = helpers(s);
  const { page } = s;
  const { hk, A, newWin, launchIf, shot, clipped } = T;
  try {
    await launchIf('calculator');
    if (!(await launchIf('files'))) await launchIf('paint');
    await sleep(400);
    await newWin('Rapport trimestriel — brouillon', { width: 760, height: 480 });
    await newWin('Budget 2026', { width: 680, height: 460 });
    await sleep(1200);
    await hk('Alt+Tab');
    await page.waitForSelector('.alttab-card', { timeout: 3000 });
    await sleep(300);
    await shot('wm-alttab-fr-dark', true);
    await hk('Alt:up');
    await sleep(300);
    await hk('Super+Tab');
    await sleep(600);
    await A(() => window.__aurora.wm.createDesktop());
    await sleep(300);
    check('fr: Task View strings localized', (await A(() => document.querySelector('.tv-new .tv-desk-name').textContent)) === 'Nouveau bureau' && (await A(() => document.querySelector('.tv-desk .tv-desk-name').textContent)) === 'Bureau 1');
    await shot('wm-taskview-fr-dark', true);
    await A(() => window.__aurora.taskview.close());
    await sleep(400);
    const w = await A(() => window.__aurora.wm.focused().id);
    await A((id) => window.__aurora.snap.open(window.__aurora.wm.get(id)), w);
    await sleep(300);
    await shot('wm-snaplayouts-fr-dark');
    await A(() => window.__aurora.snap.close());
    await hk('Ctrl+Alt+Delete');
    await sleep(500);
    const opts = await A(() => [...document.querySelectorAll('.sec-opt')].map((b) => b.textContent));
    check('fr: security screen localized', opts.includes('Verrouiller') && opts.includes("Changer d'utilisateur") && opts.includes('Se déconnecter'), opts.join(', '));
    check('fr: security options not clipped', (await clipped('.sec-opt, .sec-cancel')).length === 0);
    await shot('wm-security-fr-dark', true);
    await A(() => window.__aurora.security.close());
    await sleep(300);
    await hk('Super+R');
    await sleep(600);
    check('fr: Run localized', (await A(() => document.querySelector('.wm-run .win-title').textContent)) === 'Exécuter' && (await A(() => document.querySelector('.run-label').textContent)) === 'Ouvrir :');
    const runOverflow = await A(() => {
      const b = document.querySelector('.wm-run .win-body');
      const run = document.querySelector('.run');
      return run.scrollHeight > b.clientHeight + 1 || [...document.querySelectorAll('.run-foot .btn')].some((x) => x.scrollWidth > x.clientWidth + 1);
    });
    check('fr: Run dialog content fits (no clipping)', !runOverflow);
    await shot('wm-run-fr-dark', true);
    await A(() => window.__aurora.wm.list().find((x) => x.appId === 'run')?.close());
    await sleep(300);
    await hk('Super+X');
    await sleep(300);
    const winx = await A(() => [...document.querySelectorAll('.menu.wm-accel-menu .menu-item .label')].map((l) => l.textContent));
    const hasTm = await A(() => !!window.__aurora.registry.get('taskmgr'));
    check('fr: Win+X localized', (!hasTm || winx.includes('Gestionnaire des tâches')) && winx.includes('Exécuter') && winx.includes('Bureau') && winx.includes('Arrêter ou se déconnecter'), winx.join(', '));
    check('fr: Win+X labels not clipped', (await clipped('.menu.wm-accel-menu .menu-item .label')).length === 0);
    await shot('wm-winx-fr-dark', true);
    await A(() => window.__aurora.ui.closeMenus());
    const id = await A(() => window.__aurora.wm.focused().id);
    await A((id) => window.__aurora.shell.emit('sysmenu:open', window.__aurora.wm.get(id)), id);
    await sleep(250);
    const sys = await A(() => [...document.querySelectorAll('.menu.wm-accel-menu .menu-item .label')].map((l) => l.textContent));
    check('fr: window menu localized', JSON.stringify(sys) === JSON.stringify(['Restaurer', 'Déplacer', 'Taille', 'Réduire', 'Agrandir', 'Fermer']), sys.join(', '));
    await shot('wm-sysmenu-fr-dark');
    await A(() => window.__aurora.ui.closeMenus());
    await A(async () => {
      for (const w of window.__aurora.wm.list()) await w.close(true);
    });
    await sleep(300);
    await hk('Alt+F4');
    await page.waitForSelector('.sd-dialog', { timeout: 2000 }).catch(() => {});
    await sleep(300);
    check('fr: Shut Down dialog localized', (await A(() => document.querySelector('.sd-hero span')?.textContent)) === 'Arrêter Aurora');
    check('fr: Shut Down dialog not clipped', (await clipped('.sd-dialog .btn, .sd-select')).length === 0);
    await shot('wm-shutdown-fr-dark', true);
    await hk('Alt+F4');
    await sleep(300);
    await A(() => window.__aurora.wm.switchDesktop(window.__aurora.wm.desktops[1].id));
    await sleep(500);
    await shot('wm-desktop-pill-fr-dark');
    check('fr: desktop pill localized', (await A(() => document.querySelector('.tv-pill-name')?.textContent)) === 'Bureau 2');
  } finally {
    const mine = T.myErrors();
    check('fr/dark: no renderer errors from wm-nav code', mine.length === 0, mine.map((e) => e.text).join(' | '));
    await s.close();
  }
}

// ------------------------------------------------------------------ light theme, transparency + animations off
async function reducedRun() {
  const s = await launchShell({ lang: 'en', theme: 'light', settings: { transparency: false, animations: false } });
  const T = helpers(s);
  const { A, hk, newWin, shot, page } = T;
  try {
    await newWin('One');
    await newWin('Two');
    await sleep(300);
    await hk('Super+Tab');
    await sleep(100);
    check('animations off: Task View lays out instantly', await A(() => window.__aurora.wm.list().every((w) => w.el.style.transition === 'none' || w.el.style.transition === '')));
    check('transparency off: Task View backdrop is opaque', await A(() => getComputedStyle(document.querySelector('.tv-backdrop')).backdropFilter === 'none'));
    await A(() => window.__aurora.taskview.close());
    await sleep(50);
    check('animations off: Task View exits immediately', await A(() => !window.__aurora.taskview.isOpen));
    await hk('Super+Ctrl+D');
    check('animations off: desktop switch is instant (no WAAPI slide)', await A(() => window.__aurora.wm.list().every((w) => w.el.getAnimations().filter((a) => !(a instanceof CSSTransition) && !(a instanceof CSSAnimation)).length === 0)));
    await hk('Alt+Tab');
    await sleep(500);
    await shot('wm-alttab-reduced');
    await hk('Alt:up');
    void page;
  } finally {
    const mine = T.myErrors();
    check('reduced: no renderer errors from wm-nav code', mine.length === 0, mine.map((e) => e.text).join(' | '));
    await s.close();
  }
}

unitTests();
await mainRun();
if (!process.argv.includes('--quick')) {
  if (!ONLY.length || ONLY.includes('fr')) await frenchDarkRun();
  if (!ONLY.length || ONLY.includes('reduced')) await reducedRun();
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
