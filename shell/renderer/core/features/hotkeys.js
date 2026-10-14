// System hotkeys. The main process captures system combos in the shell document and in every webview
// (main/lib/hotkeys.js) and forwards them as api.on('shell:hotkey', ({combo, repeat})); each press
// arrives exactly once whatever has keyboard focus, and is swallowed so apps never also see it.
//
//   Super                 Start                       Super+Tab / Super+Ctrl+D/F4/←/→   Task View / desktops
//   Super+D / M / Shift+M  show desktop / minimise all / restore all                 Super+Home  minimise others
//   Super+E files   Super+I settings   Super+L lock   Super+A quick settings   Super+N notifications (drawer)
//   Super+S / Q search   Super+W widgets   Super+R Run   Super+X power menu   Super+Z snap layouts
//   Super+←/→/↑/↓  snap / maximise / restore / minimise (cycles like Windows)   Super+Shift+↑ vertical maximise
//   Super+1..9  activate / launch the nth taskbar app   Super+Shift+S, PrintScreen  screen snip
//   Alt+Tab, Alt+Shift+Tab, Ctrl+Alt+Tab  switcher ("Alt:up" commits)   Alt+F4  close window / shut down dialog
//   Alt+Space  window menu   Ctrl+Shift+Esc  Task Manager   Ctrl+Alt+Del  security screen
//   AudioVolumeUp/Down/Mute, BrightnessUp/Down  -> audio:* / display:* + shell.emit('osd', …)
//   MediaPlayPause/Play/Pause/Stop/TrackNext/TrackPrevious  -> shell.emit('media:key', 'playpause'|'pause'|'stop'|'next'|
//            'previous') for the active media player (features/mediactl.js; also while locked, like the volume keys)
//   Super+V  clipboard history flyout (Windows 11 style; off until turned on, setting 'clipboard.history';
//            text only, pinned items persist in storage 'shell' / 'clipboard-pins')
//   Super+. / Super+;  emoji and symbols panel (features/emoji.js, shell event 'emoji:toggle')
//   Super+= (keypad +) / Super+- / Super+Escape / Super+Ctrl+M  Loupe: start or zoom in, zoom out, stop, settings
//            (features/magnifier.js, shell events 'magnifier:zoomIn' 'magnifier:zoomOut' 'magnifier:stop' 'magnifier:settings')
//
// Events this module emits on the shell bus (handled by the other wm-nav features):
//   'run:open'  'winx:toggle'  'security:open'  'shutdown:dialog'  'sysmenu:open' (win)
//   'snaplayouts:open' (win)  'taskview:toggle'
// Test hook: window.__aurora.hotkeys.trigger('Super+D') runs exactly what the IPC event runs;
//   hotkeys.normalize(combo) gives the canonical form (modifiers ordered Super, Ctrl, Alt, Shift).
// Customizable shortcuts (settings.shortcuts, catalog in core/shortcuts.js, docs/PERSONALIZATION.md §12.1): the live
//   combo -> action map is rebuilt when they change; non-Super combos are sent to main (hotkeys:setCustom) so they
//   are captured everywhere. hotkeys.capture(fn) -> stop(): Settings records a new combo (no action runs meanwhile).
//   hotkeys.combos() -> { [actionId]: combo | null } in effect.
import { api } from '../api.js';
import { wm } from '../wm.js';
import { shell } from '../services.js';
import { registry } from '../registry.js';
import { settings } from '../settings.js';
import { h, icon, ui } from '../ui.js';
import { i18n, t } from '../i18n.js';
import { alttab } from './alttab.js';
import { exit as exitTaskView, isOpen as taskViewOpen } from './taskview.js';
import { isFlyoutOpen } from '../taskbar.js';
import { SHORTCUTS, effectiveShortcuts, FIXED_COMBOS, appOfAction } from '../shortcuts.js';

i18n.extend({
  en: {
    cliphist: {
      header: 'Clipboard',
      title: 'Clipboard history',
      clearAll: 'Clear all',
      offTitle: 'Clipboard history',
      offBody: 'You can see the history of the things you copied. Turn it on to start.',
      turnOn: 'Turn on',
      empty: "You'll see your clipboard history here once you've copied something.",
      pin: 'Pin',
      unpin: 'Unpin',
      delete: 'Delete',
      more: 'See more',
    },
  },
  fr: {
    cliphist: {
      header: 'Presse-papiers',
      title: 'Historique du Presse-papiers',
      clearAll: 'Tout effacer',
      offTitle: 'Historique du Presse-papiers',
      offBody: "Vous pouvez voir l'historique des éléments que vous avez copiés. Activez-le pour commencer.",
      turnOn: 'Activer',
      empty: "L'historique de votre Presse-papiers s'affichera ici dès que vous aurez copié quelque chose.",
      pin: 'Épingler',
      unpin: 'Détacher',
      delete: 'Supprimer',
      more: 'Voir plus',
    },
  },
});

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

// Same normalisation as main/lib/hotkeys.js comboOf(), from a DOM KeyboardEvent.
export function comboOfEvent(e) {
  const parts = [];
  if (e.metaKey) parts.push('Super');
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  let key = e.key;
  const map = { ' ': 'Space', Del: 'Delete', Esc: 'Escape', '.': 'Period', ',': 'Comma', VolumeUp: 'AudioVolumeUp', VolumeDown: 'AudioVolumeDown', VolumeMute: 'AudioVolumeMute', MonBrightnessUp: 'BrightnessUp', MonBrightnessDown: 'BrightnessDown' };
  key = map[key] || key;
  if (key && key.length === 1) key = key.toUpperCase();
  if (e.metaKey && /^Digit[0-9]$/.test(e.code || '') && !/^[0-9]$/.test(key)) key = e.code.slice(5);
  if (['Control', 'Alt', 'Shift', 'Meta', 'OS', 'Super', 'Hyper'].includes(key)) return parts.join('+');
  return [...parts, key].join('+');
}

// Combos main forwards (fetched from main at mount; this copy is only a fallback).
let systemCombos = new Set([
  'Alt+Tab', 'Alt+Shift+Tab', 'Ctrl+Alt+Tab', 'Alt+F4', 'Alt+Space', 'Ctrl+Alt+Delete', 'Ctrl+Shift+Escape', 'PrintScreen',
  'AudioVolumeUp', 'AudioVolumeDown', 'AudioVolumeMute', 'BrightnessUp', 'BrightnessDown',
  'MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop', 'MediaTrackNext', 'MediaTrackPrevious',
]);
let customCombos = new Set(); // the user's own non-Super shortcuts, also captured by main (hotkeys:setCustom)
function isSystemEvent(e) {
  const c = comboOfEvent(e);
  return !!c && (systemCombos.has(c) || customCombos.has(c) || (e.metaKey && c.startsWith('Super+')));
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
  exitTaskView(null, { instant: true }); // the window must be back in place before it moves
  const w = wm.focused();
  if (!w || w.minimized || w.fullscreen) return;
  const canSnap = w.opts.resizable && settings.get('multitasking.snap') !== false;
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
    else if (w.state !== 'maximized' && w.opts.maximizable && w.opts.resizable) w.maximize();
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
  // (one button per window when the taskbar does not combine them: Super+n counts apps, not windows)
  if (btns.length) return [...new Set(btns.map((b) => b.dataset.app))];
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
  // In Task View the overview itself shows the switch (no slide of the scaled windows).
  if (d) wm.switchDesktop(d.id, { animate: !taskViewOpen() });
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
  // Like Windows, Alt+F4 first dismisses the shell surface that has the keyboard (Start, a flyout, Task View).
  if (taskViewOpen()) {
    exitTaskView(null);
    return;
  }
  if (isFlyoutOpen?.() || clip.isOpen) {
    closeTransient();
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
    exitTaskView(null, { instant: true });
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
  'Super+N': () => shell.emit('notifications:toggle'),
  'Super+S': () => shell.emit('search:toggle'),
  'Super+Q': () => shell.emit('search:toggle'),
  'Super+W': () => shell.emit('widgets:toggle'),
  'Super+Tab': () => shell.emit('taskview:toggle'),
  'Super+R': () => {
    closeTransient();
    shell.emit('run:open');
  },
  'Super+X': () => shell.emit('winx:toggle'),
  'Super+V': () => clip.toggle(),
  'Super+Z': () => {
    exitTaskView(null, { instant: true });
    const w = wm.focused();
    if (w) shell.emit('snaplayouts:open', w);
  },
  'Super+ArrowLeft': () => snapKey('left'),
  'Super+ArrowRight': () => snapKey('right'),
  'Super+ArrowUp': () => snapKey('up'),
  'Super+ArrowDown': () => snapKey('down'),
  'Super+Shift+ArrowUp': () => {
    exitTaskView(null, { instant: true });
    wm.focused()?.maximizeVertically();
  },
  'Super+Ctrl+ArrowLeft': () => switchDesktopBy(-1),
  'Super+Ctrl+ArrowRight': () => switchDesktopBy(1),
  'Super+Ctrl+D': () => {
    const d = wm.createDesktop();
    wm.switchDesktop(d.id, { animate: !taskViewOpen() });
  },
  'Super+Ctrl+F4': () => wm.removeDesktop(wm.currentDesktop, { animate: !taskViewOpen() }),
  'Super+Shift+S': () => launch('snipping', { mode: 'region', immediate: true }),
  PrintScreen: () => launch('snipping', { mode: 'region', immediate: true }),
  'Super+Shift+R': () => launch('screenrec', { toggle: true }), // Enregistreur d'écran: start or stop (apps/screenrec)
  'Alt+Tab': () => alttab.open(1),
  'Alt+Shift+Tab': () => alttab.open(-1),
  'Ctrl+Alt+Tab': () => alttab.open(1, { sticky: true }),
  'Alt:up': () => alttab.altUp(),
  'Alt+F4': altF4,
  'Alt+Space': () => {
    exitTaskView(null, { instant: true });
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
  // media keys: X's XF86AudioPlay is a play / pause toggle (as in GNOME), XF86AudioPause only pauses
  MediaPlayPause: () => shell.emit('media:key', 'playpause'),
  MediaPlay: () => shell.emit('media:key', 'playpause'),
  MediaPause: () => shell.emit('media:key', 'pause'),
  MediaStop: () => shell.emit('media:key', 'stop'),
  MediaTrackNext: () => shell.emit('media:key', 'next'),
  MediaTrackPrevious: () => shell.emit('media:key', 'previous'),
};
for (let n = 1; n <= 9; n++) ACTIONS[`Super+${n}`] = () => activateNth(n);

// ------------------------------------------------------------------ customizable shortcuts
// Action of each catalog entry: the default combo's action above, or one of these (no default binding).
const EXTRA_ACTIONS = {
  focusMode: () => shell.emit('focus:toggle'),
  terminal: () => launch('terminal'),
  browser: () => launch('browser'),
  notepad: () => launch('notepad'),
  calculator: () => launch('calculator'),
  help: () => launch('help'), // Aide (apps/help)
  screenReader: () => shell.emit('screenreader:toggle', { source: 'hotkey' }), // features/screenreader.js
  onScreenKeyboard: () => shell.emit('osk:toggle', { source: 'hotkey' }), // features/osk.js (Super+Ctrl+O)
  emoji: () => shell.emit('emoji:toggle'), // features/emoji.js (Super+.)
  emojiAlt: () => shell.emit('emoji:toggle'), // (Super+;)
  // features/magnifier.js (« Loupe »)
  magnifierZoomIn: () => shell.emit('magnifier:zoomIn'),
  magnifierZoomOut: () => shell.emit('magnifier:zoomOut'),
  magnifierStop: () => shell.emit('magnifier:stop'),
  magnifierSettings: () => shell.emit('magnifier:settings'),
};
for (let n = 1; n <= 9; n++) EXTRA_ACTIONS[`taskbarApp${n}`] = () => activateNth(n);
const actionOf = (s) => EXTRA_ACTIONS[s.id] || (s.combo ? ACTIONS[normalize(s.combo)] : null);
// The user's "open this app" shortcuts ('app:<appId>'): switch to the app's latest window on this desktop (restored
// if minimized), or open it.
function openApp(appId) {
  if (!registry.get(appId)) return warnOnce(`app ${appId}`, 'not installed');
  closeTransient();
  const w = wm.mru().find((x) => x.appId === appId && wm.listDesktop().includes(x) && !x._closing);
  if (!w) return launch(appId);
  if (w.minimized) w.restoreFromMinimize();
  w.focus();
}
let effective = { ...ACTIONS }; // combo -> fn in effect
let effectiveIds = {}; // combo -> action id (catalog id or 'app:<id>'), for tests and Settings
let customSent = '';
function rebuild() {
  const combos = effectiveShortcuts(settings.get('shortcuts') || {});
  const map = { ...ACTIONS };
  const ids = {};
  // free the default combos of every catalog action first (another action may take them over)…
  // (ACTIONS may hold its own closure for that combo, e.g. Super+1 → activateNth(1) for 'taskbarApp1': not identical
  // to actionOf(), yet the same action, so the default combo is freed whenever the action exists)
  for (const s of SHORTCUTS) if (s.combo && actionOf(s)) delete map[normalize(s.combo)];
  // …then bind each action to its combo in effect
  for (const s of SHORTCUTS) {
    const c = combos[s.id];
    const fn = actionOf(s);
    if (c && fn && !FIXED_COMBOS.has(normalize(c))) {
      map[normalize(c)] = fn;
      ids[normalize(c)] = s.id;
    }
  }
  // Loupe: its zoom keys also answer on the keypad (Super++ / Super+-) and with Shift (the « = + » key gives « + »
  // with Shift on QWERTY and AZERTY; aurora-xwm names keys without Shift: Super+Shift+=, Super+Shift+-)
  for (const [id, key, twins] of [['magnifierZoomIn', '=', ['+', 'Shift++', 'Shift+=']], ['magnifierZoomOut', '-', ['Shift+_', 'Shift+-']]]) {
    const c = combos[id];
    const fn = c && map[normalize(c)];
    if (!fn || !c.endsWith(`+${key}`)) continue;
    for (const twin of twins) {
      const alias = normalize(`${c.slice(0, -key.length)}${twin}`);
      if (!(alias in map)) {
        map[alias] = fn;
        ids[alias] = id;
      }
    }
  }
  // …and the user's app shortcuts last (Settings turned off whatever else used their combo)
  for (const [id, c] of Object.entries(combos)) {
    const appId = appOfAction(id);
    if (!appId || !c || FIXED_COMBOS.has(normalize(c))) continue;
    map[normalize(c)] = () => openApp(appId);
    ids[normalize(c)] = id;
  }
  effective = map;
  effectiveIds = ids;
  // main only forwards Super+… and its built-in system combos: tell it about the others (e.g. Ctrl+Alt+T)
  const extra = Object.keys(map).filter((c) => !c.startsWith('Super') && !systemCombos.has(c) && c !== 'Alt:up').sort();
  const key = extra.join('|');
  if (key !== customSent) {
    customSent = key;
    api
      .invoke('hotkeys:setCustom', extra)
      .then((r) => (customCombos = new Set(Array.isArray(r) ? r : [])))
      .catch(() => {});
  }
}
let capturing = null; // fn(combo) while Settings records a shortcut

// ------------------------------------------------------------------ Super+V clipboard history
const clip = (() => {
  let items = []; // [{ text, pinned, at }]
  let pins = [];
  let timer = 0;
  let last = null;
  let el = null;
  let target = null; // element (or webview) to paste into
  const enabled = () => settings.get('clipboard.history') === true;

  async function poll() {
    try {
      const txt = await api.invoke('clipboard:readText');
      if (typeof txt === 'string' && txt.trim() && txt !== last) {
        last = txt;
        add(txt.slice(0, 20000));
      } else if (typeof txt === 'string') last = txt;
    } catch {
      stop();
    }
  }
  function add(text) {
    const pinned = items.find((i) => i.text === text)?.pinned || false;
    items = [{ text, pinned, at: Date.now() }, ...items.filter((i) => i.text !== text)];
    const unpinned = items.filter((i) => !i.pinned);
    if (unpinned.length > 25) items = items.filter((i) => i.pinned || unpinned.indexOf(i) < 25);
    if (el) render();
  }
  function start() {
    if (timer || !enabled()) return;
    poll();
    timer = setInterval(poll, 1200);
  }
  function stop() {
    clearInterval(timer);
    timer = 0;
  }
  function savePins() {
    pins = items.filter((i) => i.pinned).map((i) => i.text);
    api.invoke('storage:set', 'shell', 'clipboard-pins', pins).catch(() => {});
  }
  async function load() {
    try {
      pins = (await api.invoke('storage:get', 'shell', 'clipboard-pins', [])) || [];
      for (const p of [...pins].reverse()) if (typeof p === 'string') items.push({ text: p, pinned: true, at: 0 });
    } catch {}
  }

  async function pasteItem(it) {
    const tgt = target;
    close(false);
    try {
      await api.invoke('clipboard:writeText', it.text);
      last = it.text;
    } catch {}
    if (!tgt?.isConnected) return;
    tgt.focus();
    if (tgt.tagName === 'WEBVIEW') {
      try {
        tgt.paste();
      } catch {}
    } else if (tgt.matches?.('input, textarea, [contenteditable="true"], [contenteditable=""]')) {
      document.execCommand('insertText', false, it.text);
    }
  }

  function render() {
    if (!el) return;
    const body = h('div', { class: 'cliph-body' });
    if (!enabled()) {
      body.append(
        h('div', { class: 'cliph-off' },
          icon('clipboard_text_ltr', { size: 32 }),
          h('div', { class: 'body-strong' }, t('cliphist.offTitle')),
          h('div', { class: 'caption text-2' }, t('cliphist.offBody')),
          h('button', { class: 'btn primary', onclick: async () => {
            await settings.set('clipboard.history', true);
            start();
            render();
          } }, t('cliphist.turnOn'))),
      );
    } else if (!items.length) {
      body.append(h('div', { class: 'cliph-empty caption text-2' }, t('cliphist.empty')));
    } else {
      for (const it of items) {
        const card = h(
          'div',
          { class: ['cliph-item', it.pinned && 'pinned'], role: 'option', tabindex: '0', onclick: (e) => !e.target.closest('.cliph-more') && pasteItem(it), onkeydown: (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), pasteItem(it)) },
          h('div', { class: 'cliph-text' }, it.text.length > 400 ? `${it.text.slice(0, 400)}…` : it.text),
          h('button', {
            class: 'btn subtle icon-btn cliph-more',
            'aria-label': t('cliphist.more'),
            onclick: (e) =>
              ui.menu(e, [
                { label: it.pinned ? t('cliphist.unpin') : t('cliphist.pin'), icon: it.pinned ? 'pin_off' : 'pin', action: () => { it.pinned = !it.pinned; savePins(); render(); } },
                { label: t('cliphist.delete'), icon: 'delete', action: () => { items = items.filter((x) => x !== it); savePins(); render(); } },
              ]),
          }, icon('more_horizontal', { size: 16 })),
          it.pinned ? icon('pin', { size: 12, class: 'cliph-pin' }) : null,
        );
        body.append(card);
      }
    }
    el.replaceChildren(
      h('div', { class: 'cliph-head' },
        h('span', { class: 'body-strong' }, t('cliphist.header')),
        enabled() && items.some((i) => !i.pinned) ? h('button', { class: 'btn subtle small', onclick: () => { items = items.filter((i) => i.pinned); render(); } }, t('cliphist.clearAll')) : null),
      body,
    );
  }

  function onKey(e) {
    if (!el) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const list = [...el.querySelectorAll('.cliph-item')];
      if (!list.length) return;
      e.preventDefault();
      const i = list.indexOf(document.activeElement);
      list[(i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length].focus();
    }
  }
  function onOutside(e) {
    if (el && !el.contains(e.target) && !e.target.closest?.('.menu')) close();
  }
  async function open() {
    if (el) return;
    shell.emit('start:close');
    shell.emit('flyouts:close');
    target = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
    if (enabled()) await poll();
    el = h('div', { class: 'cliph', role: 'dialog', 'aria-label': t('cliphist.title'), tabindex: '-1' });
    render();
    document.getElementById('overlays').appendChild(el);
    // Near the caret's element when there is one (like Windows), else bottom centre.
    const r = el.getBoundingClientRect();
    const tr = target?.getBoundingClientRect?.();
    let x = window.innerWidth / 2 - r.width / 2;
    let y = window.innerHeight - 48 - 12 - r.height;
    if (tr && tr.width) {
      x = Math.min(Math.max(8, tr.left), window.innerWidth - r.width - 8);
      y = tr.bottom + 8 + r.height < window.innerHeight - 56 ? tr.bottom + 8 : Math.max(8, tr.top - r.height - 8);
    }
    el.style.left = `${Math.round(x)}px`;
    el.style.top = `${Math.round(y)}px`;
    (el.querySelector('.cliph-item, .btn.primary') || el).focus({ preventScroll: true });
    document.addEventListener('keydown', onKey, true);
    setTimeout(() => document.addEventListener('pointerdown', onOutside, true));
  }
  function close(restore = true) {
    if (!el) return;
    const e = el;
    el = null;
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointerdown', onOutside, true);
    e.classList.add('closing');
    setTimeout(() => e.remove(), 150);
    if (restore && target?.isConnected) target.focus();
  }
  return {
    load,
    start,
    stop,
    open,
    close,
    toggle: () => (el ? close() : open()),
    get items() {
      return items;
    },
    get isOpen() {
      return !!el;
    },
  };
})();

let locked = false;
// The lock screen (features/lock.js) marks <body> while it is up; `locked` covers the moment between
// shell.emit('lock') and the lock screen appearing, and setups without a lock screen.
const isLocked = () => locked || document.body.classList.contains('aurora-locked');

function trigger(combo, { repeat = false } = {}) {
  const c = normalize(combo);
  if (capturing) {
    if (!repeat && c !== 'Alt:up') capturing(c);
    return true;
  }
  if (repeat && !REPEATABLE.has(c)) return false;
  // While the lock screen or the Ctrl+Alt+Del screen is up only the hardware keys keep working.
  if ((isLocked() || document.querySelector('.sec-screen:not(.closing)')) && !/^(Audio|Brightness|Media)/.test(c)) return false;
  const fn = effective[c];
  if (!fn) return false;
  try {
    fn();
  } catch (err) {
    console.error(`[hotkeys] ${c} failed`, err);
  }
  return true;
}

/**
 * Record the next key combination (Settings > Keyboard shortcuts): fn(combo) for each one; returns stop().
 * onModifiers(['Ctrl', 'Alt']) (optional) follows the modifier keys held right now, so the recorder can show them
 * while the user is still building the combination.
 */
function capture(fn, { onModifiers } = {}) {
  capturing = typeof fn === 'function' ? fn : null;
  let held = '';
  const mods = (e) => {
    if (typeof onModifiers !== 'function') return;
    const list = [e.metaKey && 'Super', e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean);
    // a modifier's own keydown / keyup does not yet / no longer report itself in the flags
    const self = { Meta: 'Super', OS: 'Super', Control: 'Ctrl', Alt: 'Alt', Shift: 'Shift' }[e.key];
    if (self && e.type === 'keydown' && !list.includes(self)) list.push(self);
    const out = self && e.type === 'keyup' ? list.filter((m) => m !== self) : list;
    const sorted = MODS.filter((m) => out.includes(m));
    if (sorted.join('+') === held) return;
    held = sorted.join('+');
    onModifiers(sorted);
  };
  const onUp = (e) => capturing && mods(e);
  const onBlur = () => {
    held = '';
    if (typeof onModifiers === 'function') onModifiers([]);
  };
  const onKey = (e) => {
    if (!capturing) return;
    mods(e);
    // system combos also come through IPC (trigger); others only as DOM events
    if (isSystemEvent(e)) return;
    const c = comboOfEvent(e);
    if (!c || c.split('+').every((p) => ['Super', 'Ctrl', 'Alt', 'Shift'].includes(p))) return;
    // keys without Ctrl / Alt / Win keep working in the dialog (Tab, Enter, Esc…); F13–F24 may stand alone
    if (!e.ctrlKey && !e.altKey && !e.metaKey && !/^F(1[3-9]|2[0-4])$/.test(e.key)) {
      if (e.key.length === 1 || /^F\d+$/.test(e.key)) capturing(normalize(c)); // shown with "add Ctrl, Alt or Win"
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (!e.repeat) capturing(normalize(c));
  };
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', onUp, true);
  window.addEventListener('blur', onBlur);
  return () => {
    capturing = null;
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('keyup', onUp, true);
    window.removeEventListener('blur', onBlur);
  };
}

export const hotkeys = {
  trigger,
  normalize,
  actions: ACTIONS,
  snapKey,
  comboOfEvent,
  isSystemEvent,
  capture,
  combos: () => effectiveShortcuts(settings.get('shortcuts') || {}),
  /** combo -> action id in effect ('files', 'taskbarApp1', 'app:photos'…); built-in combos outside the catalog are absent */
  get bindings() {
    return { ...effectiveIds };
  },
  get effective() {
    return effective;
  },
};

export function mount(ctx) {
  api.on('shell:hotkey', (p) => trigger(p?.combo, { repeat: !!p?.repeat }));
  // Main forwards system combos from the shell page without swallowing them (see main/lib/hotkeys.js),
  // so the DOM event still arrives here: cancel it before apps or focus navigation see it.
  window.addEventListener(
    'keydown',
    (e) => {
      if (isSystemEvent(e)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    true,
  );
  api
    .invoke('hotkeys:rules')
    .then((r) => {
      if (Array.isArray(r?.system)) systemCombos = new Set(r.system);
    })
    .catch(() => {})
    .finally(rebuild);
  settings.on('shortcuts', rebuild);
  shell.hotkeys = hotkeys;
  api.on('audio:changed', () => (volCache = null));
  shell.on('lock', () => {
    locked = true;
    alttab.cancel();
    // If no lock screen actually came up (feature missing or failed), don't leave hotkeys disabled.
    setTimeout(() => {
      if (locked && !document.body.classList.contains('aurora-locked')) locked = false;
    }, 1500);
  });
  shell.on('unlock', () => (locked = false));
  ctx.hotkeys = hotkeys;
  ui.loadCss('app://shell/core/features/hotkeys.css');
  clip.load().then(() => clip.start());
  settings.on('clipboard', () => (settings.get('clipboard.history') === true ? clip.start() : clip.stop()));
  shell.on('flyouts:close', () => clip.close(false));
  shell.on('lock', () => clip.close(false));
  ctx.clipboardHistory = clip;
}
