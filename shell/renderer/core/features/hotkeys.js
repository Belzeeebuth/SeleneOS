// System hotkeys. The main process captures system combos in the shell document and in every webview
// (main/lib/hotkeys.js) and forwards them as api.on('shell:hotkey', ({combo, repeat})); each press
// arrives exactly once whatever has keyboard focus, and is swallowed so apps never also see it.
//
//   Super                 Start                       Super+Tab / Super+Ctrl+D/F4/←/→   Task View / desktops
//   Super+D / M / Shift+M  show desktop / minimise all / restore all                 Super+Home  minimise others
//   Super+E files   Super+I settings   Super+L lock   Super+A quick settings   Super+N notifications
//   Super+S / Q search   Super+W widgets   Super+R Run   Super+X power menu   Super+Z snap layouts
//   Super+←/→/↑/↓  snap / maximise / restore / minimise (cycles like Windows)   Super+Shift+↑ vertical maximise
//   Super+1..9  activate / launch the nth taskbar app   Super+Shift+S, PrintScreen  screen snip
//   Alt+Tab, Alt+Shift+Tab, Ctrl+Alt+Tab  switcher ("Alt:up" commits)   Alt+F4  close window / shut down dialog
//   Alt+Space  window menu   Ctrl+Shift+Esc  Task Manager   Ctrl+Alt+Del  security screen
//   AudioVolumeUp/Down/Mute, BrightnessUp/Down  -> audio:* / display:* + shell.emit('osd', …)
//
// Events this module emits on the shell bus (handled by the other wm-nav features):
//   'run:open'  'winx:toggle'  'security:open'  'shutdown:dialog'  'sysmenu:open' (win)
//   'snaplayouts:open' (win)  'taskview:toggle'
// Test hook: window.__aurora.hotkeys.trigger('Super+D') runs exactly what the IPC event runs;
//   hotkeys.normalize(combo) gives the canonical form (modifiers ordered Super, Ctrl, Alt, Shift).
import { api } from '../api.js';
import { wm } from '../wm.js';
import { shell } from '../services.js';
import { registry } from '../registry.js';
import { settings } from '../settings.js';
import { ui } from '../ui.js';
import { alttab } from './alttab.js';

const MODS = ['Super', 'Ctrl', 'Alt', 'Shift'];
const KEY_ALIASES = { Left: 'ArrowLeft', Right: 'ArrowRight', Up: 'ArrowUp', Down: 'ArrowDown', Esc: 'Escape', Del: 'Delete', Win: 'Super', Meta: 'Super', Control: 'Ctrl' };
// Only these keep acting while a key is held down.
const REPEATABLE = new Set(['Alt+Tab', 'Alt+Shift+Tab', 'AudioVolumeUp', 'AudioVolumeDown', 'BrightnessUp', 'BrightnessDown']);

export function normalize(combo) {
  const raw = String(combo || '');
  if (raw.endsWith(':up')) return raw;
  const parts = raw.split('+');
  let key = parts.pop();
  if (key === '' && parts.length) key = '+';
  key = KEY_ALIASES[key] || key;
  const mods = new Set(parts.map((p) => KEY_ALIASES[p] || p));
  if (MODS.includes(key)) {
    mods.add(key);
    return MODS.filter((m) => mods.has(m)).join('+');
  }
  if (key.length === 1) key = key.toUpperCase();
  return [...MODS.filter((m) => mods.has(m)), key].join('+');
}

const warned = new Set();
function warnOnce(tag, err) {
  if (warned.has(tag)) return;
  warned.add(tag);
  console.warn(`[hotkeys] ${tag} unavailable: ${err?.message || err}`);
}

function launch(id, args) {
  if (!registry.get(id)) {
    warnOnce(`app ${id}`, 'not installed');
    return null;
  }
  shell.emit('start:close');
  shell.emit('flyouts:close');
  return shell.launch(id, args);
}

function closeTransient() {
  shell.emit('start:close');
  shell.emit('flyouts:close');
  ui.closeMenus();
}

// ------------------------------------------------------------------ Super+arrows (Windows semantics)
const LEFT_SIDE = { left: 'right', tl: 'tr', bl: 'br' };
const RIGHT_SIDE = { right: 'left', tr: 'tl', br: 'bl' };

function snapKey(dir) {
  const w = wm.focused();
  if (!w || w.minimized || w.fullscreen) return;
  const canSnap = w.opts.resizable;
  const z = w.state === 'snapped' ? w.snap : w.state;
  if (dir === 'left' || dir === 'right') {
    if (!canSnap) return;
    const same = dir === 'left' ? LEFT_SIDE : RIGHT_SIDE;
    const other = dir === 'left' ? RIGHT_SIDE : LEFT_SIDE;
    if (z in same) w.snapTo(same[z], { source: 'keyboard' }); // left half + Super+Right… see below
    else if (z in other) w.restore(); // right-snapped + Super+Left -> restore
    else w.snapTo(dir, { source: 'keyboard' });
    return;
  }
  if (dir === 'up') {
    const up = { left: 'tl', right: 'tr', bl: 'left', br: 'right' };
    if (canSnap && z in up) w.snapTo(up[z], { source: 'keyboard' });
    else if (w.state !== 'maximized' && w.opts.maximizable && canSnap) w.maximize();
    return;
  }
  // down
  const down = { left: 'bl', right: 'br', tl: 'left', tr: 'right' };
  if (canSnap && z in down) w.snapTo(down[z], { source: 'keyboard' });
  else if (w.state === 'maximized' || w.state === 'snapped') w.restore();
  else w.minimize();
}
// Note on the cycle: pressing Super+Left on a left-snapped window throws it to the right half (Windows on a
// single display wraps to the other side), and Super+Left on a right-snapped window restores it.

// ------------------------------------------------------------------ Super+1..9
function taskbarApps() {
  const btns = [...document.querySelectorAll('#taskbar .tb-app[data-app]')].filter((b) => !b.classList.contains('leaving') && b.offsetParent !== null);
  if (btns.length) return btns.map((b) => b.dataset.app);
  const pinned = (settings.get('pinned') || []).filter((id) => registry.get(id));
  const running = [];
  for (const w of wm.listDesktop().sort((a, b) => a.createdAt - b.createdAt)) if (!pinned.includes(w.appId) && !running.includes(w.appId)) running.push(w.appId);
  return [...pinned, ...running];
}

function activateNth(n) {
  const id = taskbarApps()[n - 1];
  if (!id) return;
  closeTransient();
  const wins = wm.listDesktop().filter((w) => w.appId === id);
  if (!wins.length) return launch(id);
  if (wins.length === 1) {
    const w = wins[0];
    if (w.isFocused()) w.minimize();
    else w.focus();
    return;
  }
  const byAge = wins.sort((a, b) => a.createdAt - b.createdAt);
  const f = wm.focused();
  const i = byAge.indexOf(f);
  if (i >= 0) byAge[(i + 1) % byAge.length].focus();
  else wm.mru().find((w) => w.appId === id)?.focus();
}

// ------------------------------------------------------------------ volume / brightness
let volQueue = Promise.resolve();
let volCache = null;
let volCacheTimer = 0;
function volume(kind) {
  volQueue = volQueue.then(async () => {
    try {
      const st = volCache || (await api.invoke('audio:status'));
      let volume = Math.round(Number(st?.volume) || 0);
      let muted = !!st?.muted;
      if (kind === 'mute') {
        muted = !muted;
        await api.invoke('audio:setMuted', muted);
      } else {
        volume = Math.max(0, Math.min(100, volume + (kind === 'up' ? 2 : -2)));
        if (muted) {
          muted = false;
          await api.invoke('audio:setMuted', false);
        }
        await api.invoke('audio:setVolume', volume);
      }
      volCache = { volume, muted };
      clearTimeout(volCacheTimer);
      volCacheTimer = setTimeout(() => (volCache = null), 1500);
      shell.emit('osd', { kind: 'volume', value: volume, muted });
    } catch (err) {
      volCache = null;
      warnOnce('audio', err);
    }
  });
  return volQueue;
}

let briQueue = Promise.resolve();
function brightness(delta) {
  briQueue = briQueue.then(async () => {
    try {
      const st = await api.invoke('display:status');
      if (st?.brightness == null) return;
      const value = Math.max(0, Math.min(100, Math.round(st.brightness / 10) * 10 + delta));
      await api.invoke('display:setBrightness', value);
      shell.emit('osd', { kind: 'brightness', value });
    } catch (err) {
      warnOnce('brightness', err);
    }
  });
  return briQueue;
}

// ------------------------------------------------------------------ desktops
function switchDesktopBy(delta) {
  const i = wm.desktopIndex(wm.currentDesktop) + delta;
  const d = wm.desktops[i];
  if (d) wm.switchDesktop(d.id);
  else shell.emit('desktop:bump', delta);
}

// ------------------------------------------------------------------ map
function altF4() {
  if (alttab.isOpen) {
    alttab.selected?.close();
    return;
  }
  const dlg = [...document.querySelectorAll('#overlays > .dialog-layer.global')].pop();
  if (dlg) {
    dlg.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return;
  }
  const w = wm.focused();
  if (w && !w.minimized) w.close();
  else {
    closeTransient();
    shell.emit('shutdown:dialog');
  }
}

const ACTIONS = {
  Super: () => shell.emit('start:toggle'),
  'Super+D': () => {
    closeTransient();
    wm.toggleDesktop();
  },
  'Super+M': () => {
    closeTransient();
    wm.minimizeAll();
  },
  'Super+Shift+M': () => {
    for (const w of wm.listDesktop()) if (w.minimized) w.restoreFromMinimize();
  },
  'Super+Home': () => {
    const f = wm.focused();
    for (const w of wm.listDesktop()) if (w !== f) w.minimize();
  },
  'Super+E': () => launch('files'),
  'Super+I': () => launch('settings'),
  'Super+U': () => launch('settings', { page: 'accessibility' }),
  'Super+P': () => launch('settings', { page: 'display' }),
  'Super+Pause': () => launch('settings', { page: 'about' }),
  'Super+L': () => {
    closeTransient();
    alttab.cancel();
    shell.lock();
  },
  'Super+A': () => shell.emit('quick:toggle'),
  'Super+N': () => shell.emit('calendar:toggle'),
  'Super+S': () => shell.emit('search:toggle'),
  'Super+Q': () => shell.emit('search:toggle'),
  'Super+W': () => shell.emit('widgets:toggle'),
  'Super+Tab': () => shell.emit('taskview:toggle'),
  'Super+R': () => {
    closeTransient();
    shell.emit('run:open');
  },
  'Super+X': () => shell.emit('winx:toggle'),
  'Super+Z': () => {
    const w = wm.focused();
    if (w) shell.emit('snaplayouts:open', w);
  },
  'Super+ArrowLeft': () => snapKey('left'),
  'Super+ArrowRight': () => snapKey('right'),
  'Super+ArrowUp': () => snapKey('up'),
  'Super+ArrowDown': () => snapKey('down'),
  'Super+Shift+ArrowUp': () => wm.focused()?.maximizeVertically(),
  'Super+Ctrl+ArrowLeft': () => switchDesktopBy(-1),
  'Super+Ctrl+ArrowRight': () => switchDesktopBy(1),
  'Super+Ctrl+D': () => {
    const d = wm.createDesktop();
    wm.switchDesktop(d.id);
  },
  'Super+Ctrl+F4': () => wm.removeDesktop(wm.currentDesktop),
  'Super+Shift+S': () => launch('snipping', { mode: 'region', immediate: true }),
  PrintScreen: () => launch('snipping', { mode: 'region', immediate: true }),
  'Alt+Tab': () => alttab.open(1),
  'Alt+Shift+Tab': () => alttab.open(-1),
  'Ctrl+Alt+Tab': () => alttab.open(1, { sticky: true }),
  'Alt:up': () => alttab.altUp(),
  'Alt+F4': altF4,
  'Alt+Space': () => {
    const w = wm.focused();
    if (w) shell.emit('sysmenu:open', w);
  },
  'Ctrl+Shift+Escape': () => launch('taskmgr'),
  'Ctrl+Alt+Delete': () => {
    alttab.cancel();
    closeTransient();
    shell.emit('security:open');
  },
  AudioVolumeUp: () => volume('up'),
  AudioVolumeDown: () => volume('down'),
  AudioVolumeMute: () => volume('mute'),
  BrightnessUp: () => brightness(10),
  BrightnessDown: () => brightness(-10),
};
for (let n = 1; n <= 9; n++) ACTIONS[`Super+${n}`] = () => activateNth(n);

let locked = false;

function trigger(combo, { repeat = false } = {}) {
  const c = normalize(combo);
  if (repeat && !REPEATABLE.has(c)) return false;
  // While the lock screen is up only the hardware keys keep working.
  if (locked && !/^(Audio|Brightness)/.test(c)) return false;
  const fn = ACTIONS[c];
  if (!fn) return false;
  try {
    fn();
  } catch (err) {
    console.error(`[hotkeys] ${c} failed`, err);
  }
  return true;
}

export const hotkeys = { trigger, normalize, actions: ACTIONS, snapKey };

export function mount(ctx) {
  api.on('shell:hotkey', (p) => trigger(p?.combo, { repeat: !!p?.repeat }));
  // Main forwards Alt+Tab from the shell page without swallowing it (see main/lib/hotkeys.js), so the
  // DOM event still arrives here: cancel it before anything (focus navigation, app handlers) sees it.
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Tab' && e.altKey) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    true,
  );
  api.on('audio:changed', () => (volCache = null));
  shell.on('lock', () => {
    locked = true;
    alttab.cancel();
    // If no lock screen actually came up (feature missing or failed), don't leave hotkeys disabled.
    setTimeout(() => {
      if (locked && !document.querySelector('#overlays > *')) locked = false;
    }, 1500);
  });
  shell.on('unlock', () => (locked = false));
  ctx.hotkeys = hotkeys;
}
