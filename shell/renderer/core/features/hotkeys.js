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
//   Super+V  clipboard history flyout (Windows 11 style; off until turned on, setting 'clipboard.history';
//            text only, pinned items persist in storage 'shell' / 'clipboard-pins')
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
import { h, icon, ui } from '../ui.js';
import { i18n, t } from '../i18n.js';
import { alttab } from './alttab.js';

i18n.extend({
  en: {
    cliphist: {
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
]);
function isSystemEvent(e) {
  const c = comboOfEvent(e);
  return !!c && (systemCombos.has(c) || (e.metaKey && c.startsWith('Super+')));
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
  'Super+V': () => clip.toggle(),
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
        h('span', { class: 'body-strong' }, t('cliphist.title')),
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

function trigger(combo, { repeat = false } = {}) {
  const c = normalize(combo);
  if (repeat && !REPEATABLE.has(c)) return false;
  // While the lock screen or the Ctrl+Alt+Del screen is up only the hardware keys keep working.
  if ((locked || document.querySelector('.sec-screen:not(.closing)')) && !/^(Audio|Brightness)/.test(c)) return false;
  const fn = ACTIONS[c];
  if (!fn) return false;
  try {
    fn();
  } catch (err) {
    console.error(`[hotkeys] ${c} failed`, err);
  }
  return true;
}

export const hotkeys = { trigger, normalize, actions: ACTIONS, snapKey, comboOfEvent, isSystemEvent };

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
    .catch(() => {});
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
  ui.loadCss('app://shell/core/features/hotkeys.css');
  clip.load().then(() => clip.start());
  settings.on('clipboard', () => (settings.get('clipboard.history') === true ? clip.start() : clip.stop()));
  shell.on('flyouts:close', () => clip.close(false));
  shell.on('lock', () => clip.close(false));
  ctx.clipboardHistory = clip;
}
