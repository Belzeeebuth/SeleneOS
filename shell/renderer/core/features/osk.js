// « Clavier visuel » — the on-screen keyboard of the desktop (accessibility: typing with a mouse, a touch screen, a
// head pointer or a switch). The panel is osk/keyboard.js (shared with the sign-in screen); this module decides where
// its keys go and follows the settings.
//
//   settings.osk = {
//     enabled: false,          // shown (Paramètres > Accessibilité > Clavier visuel, Super+Ctrl+O, the bar button)
//     layout: 'auto',          // 'auto' (follows settings.keyboardLayout / the system keyboard) | 'fr' | 'fr-oss' | 'us' | 'ch-fr'
//     size: 'medium',          // small | medium | large
//     mode: 'docked',          // docked (bottom of the screen, above the bar) | floating (moved / resized by hand)
//     float: null,             // { x, y, width } of the floating keyboard (CSS px)
//     sound: false,            // a click on each key (never in a password field)
//     autoShow: false,         // show it when a text field gets the focus, hide it after (touch screens)
//     trayButton: false,       // a keyboard button in the bar's tray
//   }
//
// Where the keys go (the panel never takes the focus: see osk/keyboard.js):
//   - Selene apps (the shell document, its <webview>s): real key events from the main process (main/ipc/osk.js,
//     webContents.sendInputEvent keyDown / char / keyUp), so inputs, textareas, contenteditable (Notes), CodeMirror
//     (Éditeur de code), xterm.js (Terminal) and the system shortcuts (Alt+Tab, Super…) all react as to a keyboard;
//   - a Linux application window (X11, docs/XWINDOWS.md) that has the X focus: aurora-xwm types it with XTest
//     ('osk-key' through main/ipc/xwin.js), from the keysym of each character on the server's keymap (a spare keycode
//     is borrowed for characters the keymap lacks). The keyboard's area (and the bar button) is sent as 'osk-area', so
//     a press there never moves the X focus away from the application.
// Modifiers: Shift, Ctrl, Alt, AltGr are sticky (one tap: the next key; two taps: locked); Super twice opens the
// Lanceur; a locked Ctrl / Alt is held down on the target (Alt+Tab, Tab, Tab… then Alt again commits the switcher).
//
//   shell.emit('osk:toggle')   ctx.osk = { toggle(), show(), hide(), visible(), keyboard (the OnScreenKeyboard),
//                                         target() -> { kind: 'dom' | 'x', id?, webview? }, layout() }
import { OnScreenKeyboard, OSK_CSS, cssReady } from './osk/keyboard.js';
import { layoutFor, LAYOUTS } from './osk/layouts.js';

const STRINGS = {
  en: { osk: { tray: 'On-screen keyboard' } },
  fr: { osk: { tray: 'Clavier visuel' } },
};
const SIZES = ['small', 'medium', 'large'];
const TEXT_INPUTS = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number', '']);
// OSK key -> Electron sendInputEvent keyCode / X keysym name
const DOM_KEYS = { Enter: 'Enter', Backspace: 'Backspace', Tab: 'Tab', Escape: 'Escape', Delete: 'Delete', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down' };
const X_KEYS = { Enter: 'Return', Backspace: 'BackSpace', Tab: 'Tab', Escape: 'Escape', Delete: 'Delete', Home: 'Home', End: 'End', PageUp: 'Prior', PageDown: 'Next', ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down' };
const DOM_MOD = { ctrl: ['Control', 'control'], alt: ['Alt', 'alt'], super: ['Meta', 'meta'], shift: ['Shift', 'shift'] };
const X_MOD = { ctrl: 'Control_L', alt: 'Alt_L', super: 'Super_L', shift: 'Shift_L' };
const MOD_ORDER = ['ctrl', 'alt', 'super', 'shift'];

let ctx = null;
let kb = null;
let autoShown = false;
let sysLayout = null; // the session's XKB layout when settings.keyboardLayout is not set ('fr', 'ch(fr)'…)
let locked = { ctrl: false, alt: false };
const heldDom = new Set();
let heldDomTarget = null;
const heldX = new Set();
let heldXId = null;
let areaKey = '';
let areaTimer = 0;
let reservedH = -1;
let styled = Promise.resolve(); // osk.css applied (the keyboard is never shown unstyled)
let wanted = false;

function conf() {
  const o = ctx.settings.get('osk') || {};
  const f = o.float && typeof o.float === 'object' && [o.float.x, o.float.y, o.float.width].every(Number.isFinite) ? { x: o.float.x, y: o.float.y, width: o.float.width } : null;
  return {
    enabled: o.enabled === true,
    layout: typeof o.layout === 'string' && (o.layout === 'auto' || LAYOUTS[o.layout]) ? o.layout : 'auto',
    size: SIZES.includes(o.size) ? o.size : 'medium',
    mode: o.mode === 'floating' ? 'floating' : 'docked',
    float: f,
    sound: o.sound === true,
    autoShow: o.autoShow === true,
    trayButton: o.trayButton === true,
  };
}
const isLocked = () => document.body.classList.contains('aurora-locked');

/** The LAYOUTS id in effect. */
function layout() {
  const c = conf();
  if (c.layout !== 'auto') return c.layout;
  return layoutFor(ctx.settings.get('keyboardLayout') || sysLayout || 'us');
}

function isEditable(el) {
  if (!el || el === document.body) return false;
  if (el.tagName === 'TEXTAREA') return !el.readOnly && !el.disabled;
  if (el.tagName === 'INPUT') return TEXT_INPUTS.has((el.getAttribute('type') || '').toLowerCase()) && !el.readOnly && !el.disabled;
  return !!el.isContentEditable;
}
function isSecret() {
  if (isLocked()) return true;
  const a = document.activeElement;
  return a?.tagName === 'INPUT' && a.type === 'password';
}

/** Where a key goes now. */
function target() {
  if (!isLocked()) {
    const xs = ctx.xwin;
    const fw = ctx.wm.focused?.();
    if (xs?.xFocus != null && fw && fw.xwin === xs.xFocus) return { kind: 'x', id: xs.xFocus };
    const a = document.activeElement;
    if (a?.tagName === 'WEBVIEW') {
      try {
        const id = a.getWebContentsId();
        if (Number.isInteger(id)) return { kind: 'dom', webview: id };
      } catch {}
    }
    // no element has the DOM focus (a press on the keyboard can take it from a <webview>): the main process sends the
    // keys to the <webview> page that still has Chromium's focus, else to the shell page
    if (!a || a === document.body) return { kind: 'dom', auto: true };
  }
  return { kind: 'dom' };
}

// ---------------------------------------------------------------- delivery
// osk:input target: a <webview> page, the shell page (a focused element, or the lock screen), or null = 'auto'
const domTarget = (tg) => (tg?.webview != null ? { webview: tg.webview } : tg?.auto ? null : { shell: true });
const flagsOf = (set) => MOD_ORDER.filter((m) => set.has(m)).map((m) => DOM_MOD[m][1]);
function sendDom(tg, events) {
  for (let i = 0; i < events.length; i += 24) ctx.api.send('osk:input', domTarget(tg), events.slice(i, i + 24));
}
function xcmd(cmd) {
  ctx.api.send('xwin:cmd', { cmd: 'osk-key', ...cmd });
}

// Locked Ctrl / Alt are held down on the target: pressed there before the next key, released everywhere when
// unlocked (Alt+Tab to an X application then Tab in the shell's switcher: Alt is down in both until it is released).
function syncHeld(tg) {
  for (const m of [...heldDom]) {
    if (locked[m]) continue;
    heldDom.delete(m);
    sendDom(heldDomTarget, [{ type: 'keyUp', keyCode: DOM_MOD[m][0], modifiers: flagsOf(heldDom) }]);
  }
  for (const m of [...heldX]) {
    if (locked[m]) continue;
    heldX.delete(m);
    xcmd({ id: heldXId, name: X_MOD[m], action: 'release' });
  }
  if (!tg) return;
  for (const m of ['ctrl', 'alt']) {
    if (!locked[m]) continue;
    if (tg.kind === 'x') {
      if (heldX.has(m) && heldXId === tg.id) continue;
      heldX.add(m);
      heldXId = tg.id;
      xcmd({ id: tg.id, name: X_MOD[m], action: 'press' });
    } else if (!heldDom.has(m) || JSON.stringify(domTarget(heldDomTarget)) !== JSON.stringify(domTarget(tg))) {
      heldDom.add(m);
      heldDomTarget = tg;
      sendDom(tg, [{ type: 'keyDown', keyCode: DOM_MOD[m][0], modifiers: flagsOf(heldDom) }]);
    }
  }
}

function deliverDom(tg, ev) {
  const transient = MOD_ORDER.filter((m) => m !== 'shift' && ev.mods?.[m] && !heldDom.has(m));
  if (ev.type === 'key' && ev.mods?.shift) transient.push('shift');
  const all = new Set([...heldDom, ...transient]);
  const flags = flagsOf(all);
  const combo = all.has('ctrl') || all.has('alt') || all.has('super');
  const out = [];
  const on = new Set(heldDom);
  for (const m of transient) {
    on.add(m);
    out.push({ type: 'keyDown', keyCode: DOM_MOD[m][0], modifiers: flagsOf(on) });
  }
  const press = (code, f, text) => {
    out.push({ type: 'keyDown', keyCode: code, modifiers: f });
    if (text != null) out.push({ type: 'char', keyCode: text, modifiers: f });
    out.push({ type: 'keyUp', keyCode: code, modifiers: f });
  };
  if (ev.type === 'super') {
    out.push({ type: 'keyDown', keyCode: 'Meta', modifiers: flags }, { type: 'keyUp', keyCode: 'Meta', modifiers: flags });
  } else if (ev.type === 'key') {
    const code = DOM_KEYS[ev.key];
    if (!code) return;
    press(code, flags, code === 'Enter' && !combo ? '\r' : null);
  } else if (ev.type === 'text') {
    for (const ch of [...String(ev.text || '')]) {
      if (ch === ' ') press('Space', flags, combo ? null : ' ');
      else if (/^[\x21-\x7e]$/.test(ch)) {
        // ASCII: a key Chromium knows (key / code / keyCode as on a US keyboard); capitals with Shift
        const f = /^[A-Z]$/.test(ch) && !flags.includes('shift') ? [...flags, 'shift'] : flags;
        press(ch, f, combo ? null : ch);
      } else if (!combo) out.push({ type: 'char', keyCode: ch, modifiers: [] }); // é € ê…: the character itself
    }
  }
  for (const m of [...transient].reverse()) {
    on.delete(m);
    out.push({ type: 'keyUp', keyCode: DOM_MOD[m][0], modifiers: flagsOf(on) });
  }
  sendDom(tg, out);
}

function deliverX(tg, ev) {
  const mods = ['ctrl', 'alt', 'super'].filter((m) => ev.mods?.[m] && !heldX.has(m));
  if (ev.type === 'super') xcmd({ id: tg.id, name: 'Super_L' });
  else if (ev.type === 'key') {
    if (X_KEYS[ev.key]) xcmd({ id: tg.id, name: X_KEYS[ev.key], mods: ev.mods?.shift ? [...mods, 'shift'] : mods });
  } else if (ev.type === 'text') {
    for (const ch of [...String(ev.text || '')]) {
      if (ch === ' ') xcmd({ id: tg.id, name: 'space', mods });
      else xcmd({ id: tg.id, char: ch, mods });
    }
  }
}

function deliver(ev) {
  if (ev.type === 'hold') {
    locked = { ctrl: !!ev.mods?.ctrl, alt: !!ev.mods?.alt };
    syncHeld(locked.ctrl || locked.alt ? target() : null);
    return;
  }
  const tg = target();
  syncHeld(tg);
  if (tg.kind === 'x') deliverX(tg, ev);
  else deliverDom(tg, ev);
}

// ---------------------------------------------------------------- X11: keep the X focus on the application
function updateArea() {
  if (!ctx.xwin?.status?.enabled) return;
  const rects = [];
  const add = (el) => {
    const r = el?.getBoundingClientRect?.();
    if (r && r.width > 1 && r.height > 1) rects.push({ x: Math.floor(r.left), y: Math.floor(r.top), width: Math.ceil(r.width), height: Math.ceil(r.height) });
  };
  if (kb?.visible) add(kb.el);
  add(document.querySelector('#taskbar [data-status="osk"]'));
  const key = JSON.stringify(rects);
  if (key === areaKey) return;
  areaKey = key;
  ctx.api.send('xwin:cmd', { cmd: 'osk-area', rects });
}
function areaWatch() {
  updateArea();
  const need = !!(kb?.visible || conf().trayButton);
  if (need && !areaTimer && ctx.xwin?.status?.enabled) areaTimer = setInterval(updateArea, 1000);
  if (!need && areaTimer) {
    clearInterval(areaTimer);
    areaTimer = 0;
  }
}

// ---------------------------------------------------------------- showing
function ensure() {
  if (kb) return kb;
  const c = conf();
  kb = new OnScreenKeyboard({
    layout: layout(),
    mode: c.mode,
    size: c.size,
    rect: c.float,
    deliver,
    sound: () => conf().sound && !isSecret(),
    bottom: () => (ctx.wm.baseInsets ? ctx.wm.baseInsets().bottom : ctx.wm.insets?.bottom) ?? 0,
    chrome: {
      close: () => close(),
      settings: () => {
        if (isLocked()) return;
        ctx.shell.launch('settings', { page: 'onScreenKeyboard' });
      },
      dock: (opts) => {
        if (isLocked()) return;
        const floating = opts?.rect ? true : conf().mode !== 'floating';
        const patch = { 'osk.mode': floating ? 'floating' : 'docked' };
        if (opts?.rect) patch['osk.float'] = { x: Math.round(opts.rect.x), y: Math.round(opts.rect.y), width: Math.round(opts.rect.width) };
        ctx.api.invoke('settings:setMany', patch).catch(() => {});
      },
    },
    onGeometry: (r) => {
      ctx.settings.set('osk.float', r).catch(() => {});
      moved();
    },
    onMove: () => moved(),
  });
  // in #overlays (above windows and panels; xwin.js cuts it out of the X11 holes); usable on the lock screen
  kb.el.setAttribute('data-above-lock', '');
  (document.getElementById('overlays') || document.body).appendChild(kb.el);
  try {
    new ResizeObserver(() => reserve()).observe(kb.el);
  } catch {}
  return kb;
}
function moved() {
  updateArea();
  reserve();
  ctx.xwin?.refresh?.();
}
// Docked, the keyboard keeps its height at the bottom of the work area (wm.reserve): maximized and snapped windows,
// dialogs and the Super+X menu stay above it, like the bar. Floating, it reserves nothing.
function reserve() {
  const h = kb?.visible && kb.mode === 'docked' ? Math.ceil(kb.el.offsetHeight) + 6 : 0; // (offset*: not moved by the slide-in)
  // the lock screen's card stays above the docked keyboard (osk.css)
  document.body.classList.toggle('osk-open', !!h);
  if (h) document.body.style.setProperty('--osk-reserve', `${Math.max(0, Math.round(window.innerHeight - kb.el.offsetTop))}px`);
  if (h === reservedH) return;
  reservedH = h;
  ctx.wm.reserve?.('osk', h ? { bottom: h } : null);
}

function show() {
  wanted = true;
  styled.then(() => {
    if (!wanted || kb?.visible) return;
    ensure().show();
    reserve();
    areaWatch();
    ctx.xwin?.refresh?.();
  });
}
function hide() {
  wanted = false;
  if (!kb?.visible) return;
  kb.hide(); // releases locked modifiers through deliver({ type: 'hold' })
  locked = { ctrl: false, alt: false };
  syncHeld(null);
  reserve();
  areaWatch();
  ctx.xwin?.refresh?.();
}
function apply() {
  if (conf().enabled || autoShown) show();
  else hide();
}
function close() {
  autoShown = false;
  if (conf().enabled) ctx.settings.set('osk.enabled', false).catch(() => {});
  hide();
}
function toggle() {
  if (kb?.visible) return close();
  return ctx.settings.set('osk.enabled', true).then(() => apply());
}

function applySettings() {
  const c = conf();
  if (kb) {
    kb.setLayout(layout());
    if (kb.mode !== c.mode) kb.setMode(c.mode);
    if (kb.size !== c.size) kb.setSize(c.size);
    if (c.mode === 'floating' && c.float && JSON.stringify(c.float) !== JSON.stringify(kb.rect)) kb.setRect(c.float);
    reserve();
  }
  ctx.taskbar?.setStatusItem?.('osk', c.trayButton ? { icon: 'keyboard', tip: ctx.t('osk.tray'), onClick: () => toggle() } : null);
  apply();
  areaWatch();
}

// The bar button toggles the keyboard without taking the focus from the field (nor closing the Lanceur).
function guardTray(e) {
  const btn = e.target?.closest?.('#taskbar [data-status="osk"]');
  if (!btn) return;
  e.stopPropagation();
  if (e.cancelable) e.preventDefault();
}

export async function mount(c) {
  ctx = c;
  ctx.i18n.extend?.(STRINGS);
  ctx.ui.loadCss(OSK_CSS);
  styled = cssReady();
  ctx.api
    .invoke('locale:status')
    .then((st) => {
      sysLayout = st?.keyboard || null;
      if (kb) kb.setLayout(layout());
    })
    .catch(() => {});
  ctx.settings.on('osk', applySettings);
  ctx.settings.on('keyboardLayout', () => kb?.setLayout(layout()));
  ctx.settings.on('lang', () => setTimeout(applySettings, 0));
  ctx.shell.on('osk:toggle', () => toggle());
  for (const type of ['pointerdown', 'mousedown']) window.addEventListener(type, guardTray, true);
  // auto-show: a text field got the focus (touch screens); hidden again when the focus leaves text fields
  document.addEventListener(
    'focusin',
    (e) => {
      if (!conf().autoShow || !isEditable(e.target) || kb?.visible) return;
      autoShown = true;
      apply();
    },
    true,
  );
  document.addEventListener(
    'focusout',
    () =>
      setTimeout(() => {
        if (!autoShown || conf().enabled) return;
        if (isEditable(document.activeElement) || document.activeElement?.tagName === 'WEBVIEW') return;
        autoShown = false;
        apply();
      }, 250),
    true,
  );
  window.addEventListener('resize', () => kb?.visible && setTimeout(moved, 50));
  // the bar moved / changed size: the docked keyboard follows it
  ctx.shell.on?.('taskbar:layout', () => kb?.visible && setTimeout(() => (kb.setSize(kb.size), moved()), 0));
  ctx.osk = {
    toggle,
    show: () => ctx.settings.set('osk.enabled', true).then(apply),
    hide: close,
    visible: () => !!kb?.visible,
    get keyboard() {
      return kb;
    },
    target,
    layout,
  };
  applySettings();
}
