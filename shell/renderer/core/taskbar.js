// Taskbar: Start, Search, Task view, Widgets, pinned + running apps, system tray, clock.
//   taskbar.mount(el)   taskbar.anchorFor(appId) -> DOMRect of the app's button (for animations)
//   taskbar.reveal()    show the taskbar when it is auto-hidden
//   taskbar.layout()    -> { position: 'bottom'|'top'|'left'|'right', size, vertical, thickness, combine }
//   taskbar.setStatusItem(id, { icon, text, tip, onClick } | null)   extra tray button (Focus mode)
//   Emits through the shell event bus: 'start:toggle', 'search:toggle', 'taskview:toggle',
//   'widgets:toggle', 'quick:toggle', 'calendar:toggle', 'osd', 'taskbar:layout' (layout()).
//
// Personalization (docs/PERSONALIZATION.md §10), all live: taskbar.size (small | medium | large),
// taskbar.position (bottom | top | left | right: wm insets, flyouts and menus follow the edge),
// taskbar.showLabels (app names), taskbar.combine (always | whenFull | never: one button per window),
// taskbar.widgets (tray mini widgets: weather, cpu, memory, network), taskbar.search (hidden | icon | box),
// taskbar.autohide (+ taskbar.hideDelay ms), taskbar.tray ({ network, volume, battery }: tray icons shown),
// taskbar.badges (unread-notification count on app buttons), taskbar.widgetsPos (auto | start | inline | end),
// Focus mode's simplified taskbar (<html data-focus-simple="on">: running apps only).
// Layout CSS: core/shell-personalize.css + core/taskbar-start.css.
//
// Flyout manager (shared by Start, Search, Quick settings, Calendar and Widgets):
//   const fly = createFlyout({ id: 'quick', el, button: '.tb-quick', onOpen, onClose, onKey, onEscape, focus });
//   (onEscape returning true keeps the flyout open, e.g. to leave a sub-page first)
//   fly.open() / fly.close() / fly.toggle() / fly.isOpen
//   Opening a flyout emits 'flyouts:close' {except: id}, so flyouts are mutually exclusive; each one
//   closes on 'flyouts:close', 'lock', Esc and clicks outside it, and marks its taskbar button `.open`.
//   isFlyoutOpen(id?) tells whether a given (or any) flyout is open.
import { h, icon, ui, clear } from './ui.js';
import { wm } from './wm.js';
import { registry } from './registry.js';
import { settings } from './settings.js';
import { i18n, t } from './i18n.js';
import { shell } from './services.js';
import { notifications } from './notify.js';
import { api, Emitter } from './api.js';
import { LOGO } from './app-glyphs.js';
import { theme } from './theme.js';

// ---------------------------------------------------------------- strings
const STRINGS = {
  en: {
    taskbar: {
      newWindow: 'New window',
      searchBox: 'Search',
      notifications_one: '{count} new notification',
      notifications_other: '{count} new notifications',
      noNotifications: 'No new notifications',
      dndOn: 'Do not disturb is on',
      closeWindowTip: 'Close',
      moreApps: 'Show more apps',
      closeThisWindow: 'Close window',
    },
    tbmini: {
      cpu: 'CPU',
      memory: 'RAM',
      cpuTip: 'Processor: {value}%',
      memoryTip: 'Memory: {used} of {total} in use ({value}%)',
      netTip: 'Network\nDownload: {down}/s\nUpload: {up}/s',
      weatherTip: '{place}\n{temp} — {describe}',
      weatherNoPlace: 'Weather\nChoose a location in Settings > Personalization > Animated & dynamic wallpapers',
      weatherOffline: 'Weather\nNo connection',
      w_clear: 'Clear', w_mainlyClear: 'Mostly clear', w_partlyCloudy: 'Partly cloudy', w_overcast: 'Overcast', w_fog: 'Fog',
      w_drizzle: 'Drizzle', w_freezingDrizzle: 'Freezing drizzle', w_rain: 'Rain', w_freezingRain: 'Freezing rain', w_snow: 'Snow',
      w_snowGrains: 'Snow grains', w_showers: 'Showers', w_snowShowers: 'Snow showers', w_thunderstorm: 'Thunderstorm', w_hail: 'Hail',
    },
    notif: { system: 'System' },
    tray: {
      wifi: '{name}\nInternet access',
      wifiLimited: '{name}\nNo internet access',
      ethernet: 'Ethernet\nInternet access',
      ethernetLimited: 'Ethernet\nNo internet access',
      disconnected: 'Not connected\nNo connections available',
      airplane: 'Airplane mode',
      volume: 'Speakers: {value}%',
      muted: 'Speakers: muted',
      battery: '{percent}% remaining',
      batteryTime: '{percent}% remaining ({time})',
      charging: '{percent}% available (plugged in)',
      hours: '{h} h {m} min',
    },
  },
  fr: {
    taskbar: {
      newWindow: 'Nouvelle fenêtre',
      searchBox: 'Rechercher',
      notifications_one: '{count} nouvelle notification',
      notifications_other: '{count} nouvelles notifications',
      noNotifications: 'Aucune nouvelle notification',
      dndOn: 'Ne pas déranger est activé',
      closeWindowTip: 'Fermer',
      moreApps: 'Afficher plus d’applications',
      closeThisWindow: 'Fermer la fenêtre',
    },
    tbmini: {
      cpu: 'Proc.',
      memory: 'RAM',
      cpuTip: 'Processeur : {value} %',
      memoryTip: 'Mémoire : {used} sur {total} utilisés ({value} %)',
      netTip: 'Réseau\nRéception : {down}/s\nEnvoi : {up}/s',
      weatherTip: '{place}\n{temp} — {describe}',
      weatherNoPlace: 'Météo\nChoisissez un lieu dans Paramètres > Personnalisation > Fonds d’écran animés et dynamiques',
      weatherOffline: 'Météo\nPas de connexion',
      w_clear: 'Ciel dégagé', w_mainlyClear: 'Plutôt dégagé', w_partlyCloudy: 'Partiellement nuageux', w_overcast: 'Couvert', w_fog: 'Brouillard',
      w_drizzle: 'Bruine', w_freezingDrizzle: 'Bruine verglaçante', w_rain: 'Pluie', w_freezingRain: 'Pluie verglaçante', w_snow: 'Neige',
      w_snowGrains: 'Neige en grains', w_showers: 'Averses', w_snowShowers: 'Averses de neige', w_thunderstorm: 'Orage', w_hail: 'Grêle',
    },
    notif: { system: 'Système' },
    tray: {
      wifi: '{name}\nAccès Internet',
      wifiLimited: '{name}\nPas d’accès Internet',
      ethernet: 'Ethernet\nAccès Internet',
      ethernetLimited: 'Ethernet\nPas d’accès Internet',
      disconnected: 'Non connecté\nAucune connexion disponible',
      airplane: 'Mode Avion',
      volume: 'Haut-parleurs : {value} %',
      muted: 'Haut-parleurs : son coupé',
      battery: '{percent} % restant',
      batteryTime: '{percent} % restant ({time})',
      charging: '{percent} % disponible (branché)',
      hours: '{h} h {m} min',
    },
  },
};

const reduceMotion = () => document.documentElement.dataset.animations === 'off';
const EASE = 'cubic-bezier(0.1, 0.9, 0.2, 1)';

// ---------------------------------------------------------------- flyout manager
const openFlyouts = new Set();
const flyEvents = new Emitter();

export function isFlyoutOpen(id) {
  return id ? openFlyouts.has(id) : openFlyouts.size > 0;
}

export function createFlyout({ id, el, button, onOpen, onClose, onKey, onEscape, focus } = {}) {
  let isOpen = false;
  const btn = () => (typeof button === 'function' ? button() : button ? document.querySelector(button) : null);
  el.classList.add('flyout');
  el.dataset.flyout = id;
  el.setAttribute('aria-hidden', 'true');
  const outside = (e) => {
    if (!isOpen) return;
    const target = e.target;
    if (el.contains(target)) return;
    const b = btn();
    if (b && b.contains(target)) return; // the toggle button handles itself
    if (target.closest?.('.menu, .dialog-layer, .tooltip, .tb-hotzone, .tb-preview')) return;
    fly.close('outside');
  };
  const keys = (e) => {
    if (!isOpen) return;
    if (e.key === 'Escape') {
      if (e.defaultPrevented) return;
      e.preventDefault();
      if (onEscape?.(e) === true) return; // handled inside (e.g. back from a sub-page)
      const hadFocus = el.contains(document.activeElement);
      fly.close('escape');
      if (hadFocus) btn()?.focus?.({ preventScroll: true });
      return;
    }
    onKey?.(e);
    // Tab cycles inside the flyout (like Windows 11 flyouts) instead of escaping to the desktop.
    if (e.key === 'Tab' && !e.defaultPrevented && !e.ctrlKey && !e.altKey && el.contains(document.activeElement)) {
      const list = [...el.querySelectorAll('button, input, textarea, select, a[href], [tabindex]')].filter(
        (x) => x.tabIndex >= 0 && !x.disabled && !x.closest('[hidden], .leaving, [inert]') && x.getClientRects().length && getComputedStyle(x).visibility !== 'hidden',
      );
      if (!list.length) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };
  const fly = {
    id,
    el,
    get isOpen() {
      return isOpen;
    },
    open(...args) {
      if (isOpen) return;
      shell.emit('flyouts:close', { except: id });
      isOpen = true;
      openFlyouts.add(id);
      el.classList.add('open');
      el.removeAttribute('aria-hidden');
      btn()?.classList.add('open');
      for (const tip of document.querySelectorAll('body > .tooltip')) tip.remove(); // never float over the flyout
      document.addEventListener('pointerdown', outside, true);
      document.addEventListener('keydown', keys);
      flyEvents.emit('change');
      try {
        onOpen?.(...args);
      } catch (err) {
        console.error(`[flyout ${id}] open failed`, err);
      }
      if (focus) setTimeout(() => isOpen && (typeof focus === 'function' ? focus() : el.querySelector(focus))?.focus?.({ preventScroll: true }), 40);
    },
    close(reason) {
      if (!isOpen) return;
      isOpen = false;
      openFlyouts.delete(id);
      el.classList.remove('open');
      el.setAttribute('aria-hidden', 'true');
      btn()?.classList.remove('open');
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', keys);
      if (el.contains(document.activeElement)) document.activeElement.blur();
      flyEvents.emit('change');
      try {
        onClose?.(reason);
      } catch (err) {
        console.error(`[flyout ${id}] close failed`, err);
      }
    },
    toggle(...args) {
      if (isOpen) fly.close('toggle');
      else fly.open(...args);
    },
  };
  shell.on('flyouts:close', (arg) => {
    if (arg?.except !== id) fly.close('flyouts');
  });
  shell.on('lock', () => fly.close('lock'));
  return fly;
}

// ---------------------------------------------------------------- tray glyphs (Phosphor, core/icons.js)
const WIFI_GLYPH = ['wifi-none', 'wifi-low', 'wifi-medium', 'wifi-high', 'wifi-high'];
function batteryGlyph(pct, charging) {
  if (charging) return 'battery-charging';
  return pct >= 90 ? 'battery-full' : pct >= 60 ? 'battery-high' : pct >= 30 ? 'battery-medium' : pct > 10 ? 'battery-low' : 'battery-empty';
}
// The Lanceur button: the Selene crescent + dot-star (LOGO, 48 grid), drawn in currentColor.
function logoSvg() {
  return `<svg viewBox="0 0 48 48" aria-hidden="true"><path d="${LOGO.crescent}" fill="currentColor"/><path d="${LOGO.dotPath}" fill="currentColor"/></svg>`;
}

// ---------------------------------------------------------------- state
let root;
let centerEl;
let appsBox;
let clockEl;
let trayEl;
let leftEl;
let hotzone;
let previewEl = null;
let minisEl = null;
// The widths of the left part and the tray feed the islands' layout (--tb-left-w / --tb-tray-w, core/taskbar-start.css).
const trayObserver = new ResizeObserver(() => {
  if (!root || !trayEl) return;
  root.style.setProperty('--tb-tray-w', `${Math.round(trayEl.getBoundingClientRect().width)}px`);
  if (leftEl) root.style.setProperty('--tb-left-w', `${Math.round(leftEl.getBoundingClientRect().width)}px`);
});
const buttons = new Map(); // key -> button (key = appId, or appId::winId for a window of its own: combine never / whenFull)
const thumbs = new Map(); // winId -> blob URL
const status = { net: undefined, audio: undefined, battery: undefined };
const statusItems = new Map(); // id -> { icon, text, tip, onClick } (extra tray buttons, e.g. Focus mode)
let sniRender = null; // draws the app tray icons (StatusNotifierItem) into .tb-sni: taskbar.setTrayRenderer
let suppressClick = false;
let bulk = false; // true while the whole taskbar is rebuilt (no per-button entrance animation)

// ---------------------------------------------------------------- layout (personalization)
const THICK = { small: 40, medium: 48, large: 56 }; // height of a horizontal taskbar
const THICK_V = { small: 52, medium: 60, large: 72 }; // width of a vertical one (room for the clock)
// Floating islands (--bar-mode: islands, Nocturne): each island is the button height + 12 px, and floats 12 px above
// the screen edge, so the reserved band is taller (52 px islands + 12 px margin at the medium size).
const THICK_ISLANDS = { small: 56, medium: 64, large: 72 };
/** The bar layout of the current style (docs/design/SYSTEM.md §3): 'islands' | 'full' | 'pills'. */
const barMode = () => getComputedStyle(document.documentElement).getPropertyValue('--bar-mode').trim() || 'islands';
const BTN = { small: 32, medium: 40, large: 48 };
const tbCfg = () => settings.get('taskbar') || {};
function tbPos() {
  const p = tbCfg().position;
  return p === 'top' || p === 'left' || p === 'right' ? p : 'bottom';
}
const isVertical = () => tbPos() === 'left' || tbPos() === 'right';
function tbSize() {
  const s = tbCfg().size;
  return THICK[s] ? s : 'medium';
}
const thickness = () => (isVertical() ? THICK_V : barMode() === 'islands' ? THICK_ISLANDS : THICK)[tbSize()];
function combineMode() {
  const c = tbCfg().combine;
  return c === 'never' || c === 'whenFull' ? c : 'always';
}
const labelsOn = () => !!tbCfg().showLabels && !isVertical();
// A docked full-width bar (Éclipse) names its running apps beside their icon, whatever taskbar.showLabels says.
const runningLabels = () => labelsOn() || (!isVertical() && barMode() === 'full');
// Tray items (taskbar.tray: { network, volume, battery }), app badges (taskbar.badges), widgets button place
// (taskbar.widgetsPos: auto | start | inline | end) and the auto-hide delay (taskbar.hideDelay, ms).
const trayCfg = () => {
  const t = tbCfg().tray;
  return t && typeof t === 'object' ? t : {};
};
const badgesOn = () => tbCfg().badges !== false;
function widgetsPos() {
  const v = tbCfg().widgetsPos;
  const left = tbCfg().align === 'left';
  let pos = v === 'start' || v === 'inline' || v === 'end' ? v : left ? 'end' : 'start';
  if (pos === 'start' && (left || isVertical())) pos = 'inline'; // the left end of the bar is taken by Start
  return pos;
}
function hideDelay() {
  const d = Number(tbCfg().hideDelay);
  return Number.isFinite(d) ? Math.max(0, Math.min(5000, d)) : 600;
}
const focusSimple = () => document.documentElement.dataset.focusSimple === 'on';
// Focus mode with "hide notifications" (<html data-focus-quiet="on">): no badges and no flashing buttons, like the
// "hide badges / hide flashing on taskbar apps" options of a Windows 11 focus session.
const focusQuiet = () => document.documentElement.dataset.focusQuiet === 'on';

function visibleWins(appId) {
  const list = wm.listDesktop ? wm.listDesktop() : wm.list();
  return list.filter((w) => (!appId || w.appId === appId) && !w._closing && !w.opts?.skipTaskbar);
}

function appOrder() {
  // Focus mode's simplified taskbar keeps only the apps that are running.
  const pinned = focusSimple() ? [] : (settings.get('pinned') || []).filter((id) => registry.get(id));
  const running = [];
  const wins = [...visibleWins()].sort((a, b) => a.createdAt - b.createdAt);
  if (focusSimple()) {
    for (const id of (settings.get('pinned') || []).filter((x) => registry.get(x))) if (wins.some((w) => w.appId === id)) pinned.push(id);
  }
  for (const w of wins) {
    if (!pinned.includes(w.appId) && !running.includes(w.appId)) running.push(w.appId);
  }
  return [...pinned, ...running];
}

// Buttons: one per app ("combine always"), or one per window ("never", or "when the taskbar is full" while they fit).
const keyOf = (appId, win) => (win ? `${appId}::${win.id}` : appId);
function parseKey(key) {
  const i = String(key).indexOf('::');
  return i < 0 ? { appId: key, winId: null } : { appId: key.slice(0, i), winId: key.slice(i + 2) };
}
function winsOfKey(key) {
  const { appId, winId } = parseKey(key);
  const all = visibleWins(appId);
  return winId ? all.filter((w) => String(w.id) === winId) : all;
}
function entries() {
  const order = appOrder();
  const mode = combineMode();
  if (mode === 'always') return order;
  const out = [];
  for (const id of order) {
    const wins = visibleWins(id).sort((a, b) => a.createdAt - b.createdAt);
    if (!wins.length) out.push(id);
    else for (const w of wins) out.push(keyOf(id, w));
  }
  if (mode === 'whenFull' && out.length > order.length && out.length > capacity(out)) return order;
  return out;
}

function setPinned(appId, pin) {
  const list = (settings.get('pinned') || []).filter((x) => x !== appId);
  if (pin) list.push(appId);
  return settings.set('pinned', list);
}

// FLIP: animate taskbar buttons from their old to their new positions (smooth re-centering).
function flip(mutate) {
  if (reduceMotion() || !centerEl) return mutate();
  const v = isVertical();
  const at = (e) => (v ? e.getBoundingClientRect().top : e.getBoundingClientRect().left);
  const els = [...centerEl.querySelectorAll(':scope > .tb-btn, .tb-apps > .tb-btn:not(.leaving)')];
  const before = new Map(els.filter((e) => !e.hidden).map((e) => [e, at(e)]));
  mutate();
  for (const [e, was] of before) {
    if (!e.isConnected || e.hidden || e.classList.contains('dragging')) continue;
    const d = was - at(e);
    if (Math.abs(d) > 0.5) e.animate([{ transform: v ? `translateY(${d}px)` : `translateX(${d}px)` }, { transform: 'none' }], { duration: 320, easing: EASE });
  }
}

// Where a menu / picker opens next to a taskbar element (above it, below it, or beside a vertical taskbar).
function menuPointFor(el) {
  const r = el.getBoundingClientRect();
  const p = tbPos();
  if (p === 'top') return { at: { x: r.left, y: r.bottom + 4, anchor: r }, above: false };
  if (p === 'left') return { at: { x: r.right + 8, y: r.top }, above: false };
  if (p === 'right') return { at: { x: r.left - 8, y: r.top, sub: new DOMRect(r.left - 4, r.top, 1, 1) }, above: false };
  return { at: el, above: true };
}
// A popup (window picker, overflow) beside the button on a vertical taskbar, centred on it otherwise.
function placePopup(pop, btn) {
  const r = btn.getBoundingClientRect();
  const pr = pop.getBoundingClientRect();
  const p = tbPos();
  if (p === 'left' || p === 'right') {
    const th = thickness();
    pop.style.left = `${p === 'left' ? th + 8 : Math.max(8, window.innerWidth - th - 8 - pr.width)}px`;
    pop.style.top = `${Math.max(8, Math.min(window.innerHeight - pr.height - 8, r.top + r.height / 2 - pr.height / 2))}px`;
    return;
  }
  pop.style.left = `${Math.max(8, Math.min(window.innerWidth - pr.width - 8, r.left + r.width / 2 - pr.width / 2))}px`;
}

// ---------------------------------------------------------------- app buttons
function appMenu(e, key) {
  e.preventDefault();
  hidePreview(true);
  const { appId, winId } = parseKey(key);
  const wins = winsOfKey(key);
  const pinned = (settings.get('pinned') || []).includes(appId);
  const m = registry.get(appId);
  const anchor = visibleButton(key) || e.currentTarget;
  const place = menuPointFor(anchor);
  const closeLabel = winId ? t('taskbar.closeThisWindow') : wins.length > 1 ? t('taskbar.closeAll') : t('taskbar.closeWindow');
  const p = ui.menu(
    place.at,
    [
      { label: registry.name(appId), icon: 'app_generic', action: () => registry.launch(appId, { newWindow: true }) },
      m ? { label: pinned ? t('taskbar.unpin') : t('taskbar.pin'), icon: pinned ? 'pin_off' : 'pin', action: () => setPinned(appId, !pinned) } : null,
      wins.length ? { label: closeLabel, icon: 'dismiss', action: () => wins.forEach((w) => w.close()) } : null,
    ].filter(Boolean),
    { above: place.above, class: 'tb-jump' },
  );
  // Centre the jump list over (or under) the button and show the real app icon (Windows 11 style).
  const menu = [...document.querySelectorAll('.menu.tb-jump')].pop();
  if (menu) {
    if (!isVertical()) {
      const r = anchor.getBoundingClientRect();
      const mr = menu.getBoundingClientRect();
      menu.style.left = `${Math.max(8, Math.min(window.innerWidth - mr.width - 8, r.left + r.width / 2 - mr.width / 2))}px`;
    }
    const first = menu.querySelector('.menu-item .icon');
    if (first) first.replaceWith(h('img', { class: 'icon', src: registry.iconUrl(appId), alt: '', draggable: false }));
  }
  return p;
}

async function captureThumb(win, maxWait = 400) {
  if (!win || win.minimized || win._closing || !win.el.isConnected) return null;
  // Only capture windows that are not covered by another window.
  const r = win.el.getBoundingClientRect();
  if (r.width < 40 || r.height < 40) return null;
  const z = Number(win.el.style.zIndex || 0);
  const covered = visibleWins().some((o) => {
    if (o === win || o.minimized || Number(o.el.style.zIndex || 0) <= z) return false;
    const q = o.el.getBoundingClientRect();
    return q.right > r.left && q.left < r.right && q.bottom > r.top && q.top < r.bottom;
  });
  if (covered && thumbs.has(win.id)) return thumbs.get(win.id);
  if (covered) return null;
  try {
    const bytes = await Promise.race([api.invoke('shell:capture', { x: r.left, y: r.top, width: r.width, height: r.height }), new Promise((res) => setTimeout(() => res(null), maxWait))]);
    if (!bytes) return thumbs.get(win.id) || null;
    const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
    if (thumbs.has(win.id)) URL.revokeObjectURL(thumbs.get(win.id));
    thumbs.set(win.id, url);
    return url;
  } catch {
    return thumbs.get(win.id) || null;
  }
}

let previewTimer = null;
let previewApp = null;
let previewPinned = false;
function hidePreview(now = false) {
  clearTimeout(previewTimer);
  if (!previewEl) return;
  if (now) {
    previewEl.remove();
    previewEl = null;
    previewApp = null;
    previewPinned = false;
    return;
  }
  previewTimer = setTimeout(() => hidePreview(true), 260);
}
function schedulePreview(appId) {
  clearTimeout(previewTimer);
  if (previewEl && previewApp === appId) return;
  const delay = previewEl ? 60 : 480;
  previewTimer = setTimeout(() => showPreview(appId), delay);
}
function showPreview(key, pinned = false) {
  const { appId } = parseKey(key);
  const wins = winsOfKey(key);
  const btn = buttons.get(key);
  if (!wins.length || !btn || document.querySelector('.menu.tb-jump')) return hidePreview(true);
  hidePreview(true);
  previewApp = key;
  previewPinned = pinned;
  const items = wins.map((w) => {
    const img = h('div', { class: 'tb-pv-thumb' }, h('img', { class: 'tb-pv-ph', src: registry.iconUrl(appId), alt: '', draggable: false }));
    const cached = thumbs.get(w.id);
    if (cached) img.replaceChildren(h('img', { class: 'tb-pv-shot', src: cached, alt: '', draggable: false }));
    const item = h(
      'div',
      {
        class: ['tb-pv-item', w.isFocused() && 'active'],
        role: 'option',
        tabindex: '0',
        onclick: (e) => {
          if (e.target.closest('.tb-pv-close')) return;
          hidePreview(true);
          w.focus();
        },
        onauxclick: (e) => e.button === 1 && w.close(),
        onkeydown: (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            hidePreview(true);
            w.focus();
          } else if (e.key === 'Delete') w.close();
          else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
            e.preventDefault();
            const sib = e.key === 'ArrowRight' ? item.nextElementSibling : item.previousElementSibling;
            sib?.focus();
          } else if (e.key === 'Escape') {
            hidePreview(true);
            btn.focus();
          }
        },
      },
      h(
        'div',
        { class: 'tb-pv-head' },
        h('img', { src: w.iconUrl || registry.iconUrl(appId), alt: '', draggable: false }),
        h('span', { class: 'ellipsis grow' }, w.title || registry.name(appId)),
        h(
          'button',
          {
            class: 'tb-pv-close',
            'aria-label': t('taskbar.closeWindowTip'),
            onclick: async (e) => {
              e.stopPropagation();
              const ok = await w.close();
              if (ok !== false) {
                item.remove();
                if (!previewEl?.querySelector('.tb-pv-item')) hidePreview(true);
                else placePreview();
              }
            },
          },
          icon('dismiss', { size: 12 }),
        ),
      ),
      img,
    );
    captureThumb(w).then((url) => {
      if (url && item.isConnected) img.replaceChildren(h('img', { class: 'tb-pv-shot', src: url, alt: '', draggable: false }));
    });
    return item;
  });
  previewEl = h(
    'div',
    {
      class: 'tb-preview',
      role: 'listbox',
      onpointerenter: () => clearTimeout(previewTimer),
      onpointerleave: () => !previewPinned && hidePreview(),
    },
    items,
  );
  document.getElementById('flyouts').appendChild(previewEl);
  placePreview();
  if (pinned) setTimeout(() => previewEl?.querySelector('.tb-pv-item.active, .tb-pv-item')?.focus({ preventScroll: true }), 30);
}
function placePreview() {
  const btn = buttons.get(previewApp);
  if (!previewEl || !btn) return;
  placePopup(previewEl, btn);
}

// Close the picker when clicking elsewhere.
document.addEventListener(
  'pointerdown',
  (e) => {
    if (previewEl && !previewEl.contains(e.target) && !e.target.closest?.('.tb-app')) hidePreview(true);
  },
  true,
);

async function clickApp(key, btn) {
  if (suppressClick) {
    suppressClick = false;
    return;
  }
  const { appId } = parseKey(key);
  const wins = winsOfKey(key);
  if (!wins.length) {
    if (!reduceMotion()) btn.querySelector('img')?.animate([{ transform: 'none' }, { transform: 'translateY(-6px)' }, { transform: 'none' }], { duration: 420, easing: 'ease-out' });
    hidePreview(true);
    registry.launch(appId);
    return;
  }
  if (wins.length === 1) {
    hidePreview(true);
    const w = wins[0];
    if (w.isFocused()) {
      await captureThumb(w, 150); // never make minimizing feel sluggish on a slow VM
      w.minimize();
    } else w.focus();
    return;
  }
  // Several windows: show the window picker (or close it when it is already pinned open).
  if (previewEl && previewApp === key && previewPinned) hidePreview(true);
  else showPreview(key, true);
}

function startDrag(e, appId, btn) {
  // Pinned buttons are reordered by dragging them along the taskbar (one button per app only).
  if (e.button !== 0 || combineMode() !== 'always' || focusSimple() || btn.dataset.key !== appId) return;
  const pinned = (settings.get('pinned') || []).filter((id) => registry.get(id));
  const from = pinned.indexOf(appId);
  if (from < 0) return;
  const v = isVertical();
  const TR = v ? 'translateY' : 'translateX';
  const sx = v ? e.clientY : e.clientX;
  let dragging = false;
  let slots = [];
  let to = from;
  const step = () => (v ? btn.getBoundingClientRect().height : btn.getBoundingClientRect().width) + 4;
  const move = (ev) => {
    const dx = (v ? ev.clientY : ev.clientX) - sx;
    if (!dragging) {
      if (Math.abs(dx) < 6) return;
      dragging = true;
      hidePreview(true);
      btn.setPointerCapture?.(ev.pointerId);
      btn.classList.add('dragging');
      slots = pinned.map((id) => buttons.get(id));
    }
    const w = step();
    to = Math.max(0, Math.min(pinned.length - 1, from + Math.round(dx / w)));
    btn.style.transform = `${TR}(${Math.max(-from * w, Math.min((pinned.length - 1 - from) * w, dx))}px)`;
    slots.forEach((b, i) => {
      if (!b || b === btn) return;
      let shift = 0;
      if (from < to && i > from && i <= to) shift = -w;
      if (from > to && i < from && i >= to) shift = w;
      b.style.transform = shift ? `${TR}(${shift}px)` : '';
    });
  };
  const up = () => {
    btn.removeEventListener('pointermove', move);
    btn.removeEventListener('pointerup', up);
    btn.removeEventListener('pointercancel', up);
    if (!dragging) return;
    suppressClick = true;
    setTimeout(() => (suppressClick = false), 50);
    btn.classList.remove('dragging');
    for (const b of slots) if (b) b.style.transform = '';
    if (to !== from) {
      const next = [...pinned];
      next.splice(to, 0, next.splice(from, 1)[0]);
      const others = (settings.get('pinned') || []).filter((id) => !next.includes(id));
      settings.set('pinned', [...next, ...others]);
    }
  };
  btn.addEventListener('pointermove', move);
  btn.addEventListener('pointerup', up);
  btn.addEventListener('pointercancel', up);
}

function makeAppButton(key) {
  const { appId: id, winId } = parseKey(key);
  let dragTimer = null;
  const b = h(
    'button',
    {
      class: 'tb-btn tb-app',
      dataset: winId ? { app: id, key, win: winId } : { app: id, key },
      'aria-label': registry.name(id),
      onclick: () => clickApp(key, b),
      oncontextmenu: (e) => appMenu(e, key),
      onpointerdown: (e) => {
        b.classList.add('pressed');
        startDrag(e, id, b);
      },
      onpointerup: () => b.classList.remove('pressed'),
      onpointerleave: () => {
        b.classList.remove('pressed');
        if (!previewPinned) hidePreview();
      },
      onpointerenter: () => {
        if (winsOfKey(key).length) schedulePreview(key);
      },
      onauxclick: (e) => {
        if (e.button === 1) registry.launch(id, { newWindow: true });
      },
      // Dragging files over a button brings that app forward (like Windows).
      ondragenter: () => {
        clearTimeout(dragTimer);
        dragTimer = setTimeout(() => winsOfKey(key)[0]?.focus(), 650);
      },
      ondragleave: () => clearTimeout(dragTimer),
      ondrop: () => clearTimeout(dragTimer),
    },
    h('img', { src: registry.iconUrl(id), alt: '', draggable: false }),
    h('span', { class: 'tb-label' }, registry.name(id)),
    h('span', { class: 'tb-badge', hidden: true, 'aria-hidden': 'true' }),
    h('span', { class: 'tb-ind' }),
    h('span', { class: 'tb-progress' }),
  );
  return b;
}

function renderApps() {
  if (!appsBox) return;
  const order = entries();
  const ids = [...buttons.keys()];
  const changed = order.length !== ids.length || order.some((id, i) => ids[i] !== id);
  const apply = () => {
    const seen = new Set();
    for (const id of order) {
      seen.add(id);
      let b = buttons.get(id);
      if (!b) {
        b = makeAppButton(id);
        if (!reduceMotion() && !bulk && root.classList.contains('ready')) {
          b.animate([{ opacity: 0, transform: 'translateY(16px) scale(.8)' }, { opacity: 1, transform: 'none' }], { duration: 300, easing: EASE });
        }
        buttons.set(id, b);
      }
      appsBox.appendChild(b);
    }
    for (const [id, b] of buttons) {
      if (seen.has(id)) continue;
      buttons.delete(id);
      if (reduceMotion()) {
        b.remove();
        continue;
      }
      // Take it out of the flow at its current spot so the others can glide into place.
      const r = b.getBoundingClientRect();
      const pr = appsBox.getBoundingClientRect();
      b.classList.add('leaving');
      Object.assign(b.style, { position: 'absolute', left: `${r.left - pr.left}px`, top: `${r.top - pr.top}px` });
      b.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.6)' }], { duration: 160, easing: 'cubic-bezier(0.7,0,1,0.5)', fill: 'forwards' }).finished.then(
        () => b.remove(),
        () => b.remove(),
      );
    }
    fitApps();
  };
  if (changed) flip(apply);
  else apply();
  const focused = wm.focused();
  for (const [key, b] of buttons) {
    const id = parseKey(key).appId;
    const wins = winsOfKey(key);
    b.classList.toggle('running', wins.length > 0);
    b.classList.toggle('active', wins.some((w) => w === focused && !w.minimized));
    b.classList.toggle('multi', wins.length > 1);
    const flashing = !focusQuiet() && wins.some((w) => w.flashing);
    if (flashing && !b.classList.contains('flashing')) {
      b.classList.remove('flashing');
      void b.offsetWidth;
    }
    b.classList.toggle('flashing', flashing);
    const prog = wins.map((w) => w.progress).find((p) => p != null);
    b.classList.toggle('has-progress', prog != null);
    b.querySelector('.tb-progress').style.setProperty('--p', `${(prog ?? 0) * 100}%`);
    // Running apps show the window picker instead of a tooltip.
    if (wins.length) delete b.dataset.tip;
    else b.dataset.tip = registry.name(id);
    const label = wins.length === 1 ? wins[0].title || registry.name(id) : registry.name(id);
    b.dataset.name = label;
    const lab = b.querySelector('.tb-label');
    if (lab && lab.textContent !== label) lab.textContent = label;
  }
  paintBadges();
  if (previewEl && previewApp && !winsOfKey(previewApp).length) hidePreview(true);
  if (overflowBtn && !overflowBtn.hidden) {
    overflowBtn.classList.toggle('running', hiddenApps.some((k) => winsOfKey(k).length));
    overflowBtn.classList.toggle('flashing', !focusQuiet() && hiddenApps.some((k) => winsOfKey(k).some((w) => w.flashing)));
  }
}

// Badges: the number of unread notifications of an app on its (first) taskbar button.
function paintBadges() {
  if (!appsBox) return;
  const counts = new Map();
  if (badgesOn() && !focusQuiet()) for (const n of notifications.list?.() || []) if (!n.read && n.appId) counts.set(n.appId, (counts.get(n.appId) || 0) + 1);
  const seen = new Set();
  for (const b of appsBox.querySelectorAll(':scope > .tb-app')) {
    const id = b.dataset.app;
    const n = seen.has(id) ? 0 : counts.get(id) || 0;
    seen.add(id);
    const el = b.querySelector('.tb-badge');
    if (el) {
      el.hidden = !n;
      el.textContent = n > 9 ? '9+' : n ? String(n) : '';
    }
    const name = b.dataset.name || registry.name(id);
    b.setAttribute('aria-label', n ? `${name}, ${t('taskbar.notifications', { count: n })}` : name);
  }
}

// ---------------------------------------------------------------- overflow (too many apps for the bar)
// Windows 11 style: buttons that do not fit between the left area and the tray go into an overflow
// flyout opened by a "…" button at the end of the app list (the focused app always stays visible).
let overflowBtn = null;
let hiddenApps = [];
let ovfEl = null;
const visibleButton = (key) => {
  const b = buttons.get(key);
  return b && !b.hidden ? b : overflowBtn && !overflowBtn.hidden && hiddenApps.includes(key) ? overflowBtn : b;
};
/** The button that stands for a window (its own button, else its app's), for anchors and animations. */
function buttonFor(appId, win) {
  if (win && buttons.has(keyOf(appId, win))) return visibleButton(keyOf(appId, win));
  if (buttons.has(appId)) return visibleButton(appId);
  const first = [...buttons.keys()].find((k) => parseKey(k).appId === appId);
  return first ? visibleButton(first) : null;
}
// Room left for app buttons along the taskbar (px), or null before the first layout.
function availSpace() {
  if (!root?.isConnected || !trayEl || !centerEl) return null;
  const v = isVertical();
  const W = v ? root.clientHeight : root.clientWidth;
  if (!W) return null;
  const tr = trayEl.getBoundingClientRect();
  const trayW = v ? tr.height : tr.width;
  const lr = leftEl?.children.length ? leftEl.getBoundingClientRect() : null;
  const leftW = lr ? (v ? lr.height : lr.width) + 12 : 0;
  const gaps = 24 + 2 * (parseFloat(getComputedStyle(root).getPropertyValue('--tb-part-gap')) || 0);
  const avail = v || root.classList.contains('left') ? W - trayW - leftW - gaps : W - 2 * (Math.max(trayW, leftW) + 12) - gaps;
  const fixed = [...centerEl.children]
    .filter((c) => c !== appsBox)
    .reduce((sum, c) => {
      const r = c.getBoundingClientRect();
      return sum + (v ? r.height : r.width) + 4;
    }, 0);
  return avail - fixed;
}
// Length a button takes along the bar: a labelled running button is wider (Windows 10 style).
const slotOf = (key) => (runningLabels() && winsOfKey(key).length ? 172 : BTN[tbSize()] + 4);
function capacity(keys) {
  const space = availSpace();
  if (space == null) return Infinity;
  let used = 0;
  let n = 0;
  for (const k of keys) {
    used += slotOf(k);
    if (used > space) break;
    n++;
  }
  return n;
}
function fitApps() {
  if (!appsBox || !root?.isConnected) return;
  const btns = [...appsBox.querySelectorAll(':scope > .tb-app:not(.leaving)')];
  if (availSpace() == null) return;
  const keys = btns.map((b) => b.dataset.key);
  const cap = Math.max(1, capacity(keys));
  let visible = keys;
  if (btns.length > cap) {
    visible = visible.slice(0, Math.max(1, cap - 1)); // one slot for the overflow button
    const focused = wm.focused();
    const activeKey = focused && !focused.minimized ? (buttons.has(keyOf(focused.appId, focused)) ? keyOf(focused.appId, focused) : focused.appId) : null;
    if (activeKey && buttons.has(activeKey) && !visible.includes(activeKey)) visible[visible.length - 1] = activeKey;
  }
  const keep = new Set(visible);
  hiddenApps = keys.filter((k) => !keep.has(k));
  for (const b of btns) b.hidden = !keep.has(b.dataset.key);
  if (hiddenApps.length) {
    if (!overflowBtn) {
      overflowBtn = h(
        'button',
        { class: 'tb-btn tb-overflow', 'aria-haspopup': 'menu', onclick: () => toggleOverflow() },
        icon('more_horizontal', { size: 20 }),
        h('span', { class: 'tb-ind' }),
      );
    }
    overflowBtn.dataset.tip = t('taskbar.moreApps');
    overflowBtn.setAttribute('aria-label', t('taskbar.moreApps'));
    overflowBtn.classList.toggle('running', hiddenApps.some((k) => winsOfKey(k).length));
    overflowBtn.classList.toggle('flashing', hiddenApps.some((k) => winsOfKey(k).some((w) => w.flashing)));
    if (overflowBtn.parentElement !== appsBox || appsBox.lastElementChild !== overflowBtn) appsBox.appendChild(overflowBtn);
    overflowBtn.hidden = false;
    if (ovfEl) renderOverflow();
  } else {
    if (overflowBtn) overflowBtn.hidden = true;
    closeOverflow();
  }
}

function activateApp(key) {
  const wins = winsOfKey(key);
  if (!wins.length) return registry.launch(parseKey(key).appId);
  const w = wins.find((x) => x.isFocused()) || wins[wins.length - 1];
  if (w.isFocused() && !w.minimized && wins.length === 1) w.minimize();
  else w.focus();
}
function ovfOutside(e) {
  if (ovfEl && !ovfEl.contains(e.target) && !overflowBtn?.contains(e.target)) closeOverflow();
}
function ovfKeys(e) {
  if (!ovfEl) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeOverflow();
    overflowBtn?.focus();
    return;
  }
  const items = [...ovfEl.querySelectorAll('.tb-ovf-item')];
  const i = items.indexOf(document.activeElement);
  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
  if (step && items.length) {
    e.preventDefault();
    items[(i + step + items.length) % items.length].focus();
  }
}
function closeOverflow() {
  if (!ovfEl) return;
  ovfEl.remove();
  ovfEl = null;
  overflowBtn?.classList.remove('open');
  document.removeEventListener('pointerdown', ovfOutside, true);
  document.removeEventListener('keydown', ovfKeys, true);
}
function renderOverflow() {
  const focused = wm.focused();
  ovfEl.replaceChildren(
    ...hiddenApps.map((key) => {
      const id = parseKey(key).appId;
      const wins = winsOfKey(key);
      const name = parseKey(key).winId && wins[0]?.title ? wins[0].title : registry.name(id);
      return h(
        'button',
        {
          class: ['tb-ovf-item', wins.length && 'running', wins.some((w) => w === focused && !w.minimized) && 'active'],
          role: 'menuitem',
          dataset: { app: id, key, tip: name },
          'aria-label': name,
          onclick: () => {
            closeOverflow();
            activateApp(key);
          },
          oncontextmenu: (e) => {
            closeOverflow();
            appMenu(e, key);
          },
        },
        h('img', { src: registry.iconUrl(id), alt: '', draggable: false }),
        h('span', { class: 'tb-ind' }),
      );
    }),
  );
  ovfEl.style.setProperty('--cols', String(Math.max(1, Math.min(isVertical() ? 3 : 6, hiddenApps.length))));
  placePopup(ovfEl, overflowBtn);
}
function toggleOverflow() {
  if (ovfEl) return closeOverflow();
  if (!hiddenApps.length) return;
  hidePreview(true);
  ovfEl = h('div', { class: 'tb-ovf', role: 'menu', 'aria-label': t('taskbar.moreApps') });
  document.getElementById('flyouts').appendChild(ovfEl);
  overflowBtn.classList.add('open');
  renderOverflow();
  document.addEventListener('pointerdown', ovfOutside, true);
  document.addEventListener('keydown', ovfKeys, true);
  setTimeout(() => ovfEl?.querySelector('.tb-ovf-item')?.focus({ preventScroll: true }), 30);
}

// ---------------------------------------------------------------- tray
function renderClock() {
  if (!clockEl) return;
  const now = new Date();
  const h24 = settings.get('clock24h');
  const timeOpts = { hour: 'numeric', minute: '2-digit' };
  if (h24 != null) timeOpts.hour12 = !h24;
  // A 24-hour clock always shows two-digit hours ("00:55", like Windows in French); 12-hour keeps "9:05 AM".
  if (h24 != null ? !!h24 : is24h()) timeOpts.hour = '2-digit';
  if (settings.get('showSeconds')) timeOpts.second = '2-digit';
  let time = i18n.formatTime(now, timeOpts);
  // A vertical bar is narrow: the seconds may wrap onto their own line ("07:22" / ":39"), like AM/PM does.
  if (isVertical() && timeOpts.second) time = time.replace(/([:.]\d{2})(\D*)$/, '\u200b$1$2');
  clockEl.querySelector('.tb-time').textContent = time;
  // "dim. 11 oct." beside the time; a vertical bar (narrow) keeps the short numeric date.
  clockEl.querySelector('.tb-date-short').textContent = isVertical() ? i18n.formatDate(now, { day: '2-digit', month: '2-digit' }) : i18n.formatDate(now, { weekday: 'short', day: 'numeric', month: 'short' });
  // The docked bar (Éclipse) shows the date on two lines beside a larger clock: "dimanche" / "11 octobre".
  clockEl.querySelector('.tb-date-wd').textContent = i18n.formatDate(now, { weekday: 'long' });
  clockEl.querySelector('.tb-date-dm').textContent = i18n.formatDate(now, { day: 'numeric', month: 'long' });
  const full = i18n.formatDate(now, { dateStyle: 'full' });
  clockEl.dataset.tip = full.charAt(0).toUpperCase() + full.slice(1);
}
function is24h() {
  try {
    const hc = new Intl.DateTimeFormat(i18n.locale, { hour: 'numeric' }).resolvedOptions().hourCycle;
    return hc === 'h23' || hc === 'h24';
  } catch {
    return false;
  }
}
let clockTimer = null;
function tickClock() {
  renderClock();
  clearTimeout(clockTimer);
  const now = Date.now();
  const next = settings.get('showSeconds') ? 1000 - (now % 1000) : 60000 - (now % 60000);
  clockTimer = setTimeout(tickClock, next + 20);
}

function renderBell() {
  const bell = clockEl?.querySelector('.tb-bell');
  if (!bell) return;
  const n = notifications.unread();
  const dnd = !!settings.get('notifications.dnd') || document.documentElement.dataset.focusQuiet === 'on';
  clear(bell);
  // The bell is always there; the unread count follows it as a small accent pill (the floating bars show the count in
  // place of the bell, core/taskbar-start.css).
  bell.append(icon(dnd ? 'bell-slash' : 'bell', { size: 16 }));
  if (n > 0 && !dnd) {
    bell.append(h('span', { class: 'tb-count' }, n > 99 ? '99+' : String(n)));
    clockEl.setAttribute('aria-label', t('taskbar.notifications', { count: n }));
  } else {
    clockEl.setAttribute('aria-label', dnd ? t('taskbar.dndOn') : t('taskbar.noNotifications'));
  }
  bell.classList.toggle('dnd', dnd);
}

function netGlyph(st) {
  if (!st) return null;
  if (st.airplane) return { key: 'airplane', node: () => icon('airplane', { size: 16 }), tip: t('tray.airplane') };
  const p = st.primary || {};
  const limited = st.connectivity !== 'full';
  if (p.type === 'wifi') {
    const s = Number(p.strength ?? 100);
    const level = s >= 75 ? 4 : s >= 50 ? 3 : s >= 25 ? 2 : 1;
    return { key: limited ? 'wifi-limited' : `wifi${level}`, node: () => icon(limited ? 'wifi-x' : WIFI_GLYPH[level], { size: 16 }), tip: t(limited ? 'tray.wifiLimited' : 'tray.wifi', { name: p.name || 'Wi-Fi' }) };
  }
  if (p.type === 'ethernet') return { key: 'ethernet', node: () => icon(limited ? 'network-slash' : 'network', { size: 16 }), tip: t(limited ? 'tray.ethernetLimited' : 'tray.ethernet'), limited };
  return { key: 'none', node: () => icon('wifi-slash', { size: 16 }), tip: t('tray.disconnected') };
}

// Replace a tray glyph only when it actually changes: re-creating the node under the pointer would
// re-trigger its tooltip (e.g. over an open quick settings flyout) and cost a re-layout every push.
function setGlyph(el, key, make) {
  if (el.dataset.glyph === key && el.firstChild) return;
  el.dataset.glyph = key;
  el.replaceChildren(make());
}

function renderTray() {
  if (!trayEl) return;
  const net = trayEl.querySelector('.tb-net');
  const vol = trayEl.querySelector('.tb-vol');
  const bat = trayEl.querySelector('.tb-bat');
  const ng = netGlyph(status.net);
  const want = trayCfg();
  net.hidden = !ng || want.network === false;
  if (ng) {
    setGlyph(net, ng.key, ng.node);
    net.dataset.tip = ng.tip;
  }
  const a = status.audio;
  vol.hidden = !a || want.volume === false;
  if (a) {
    const v = Math.round(a.volume ?? 0);
    const name = a.muted ? 'speaker-slash' : v === 0 ? 'speaker-none' : v < 50 ? 'speaker-low' : 'speaker-high';
    setGlyph(vol, name, () => icon(name, { size: 16 }));
    vol.dataset.tip = a.muted ? t('tray.muted') : t('tray.volume', { value: v });
  }
  const b = status.battery;
  bat.hidden = !b || want.battery === false;
  if (b) {
    const pct = Math.round(b.percent ?? 0);
    setGlyph(bat, `${pct}|${!!b.charging}`, () => {
      const g = icon(batteryGlyph(pct, b.charging), { size: 16 });
      if (pct <= 10 && !b.charging) g.classList.add('tb-bat-low');
      const f = document.createDocumentFragment();
      f.append(g, h('span', { class: 'tb-bat-pct' }, i18n.formatNumber ? `${i18n.formatNumber(pct)}\u202f%` : `${pct}\u202f%`));
      return f;
    });
    const time = b.timeLeftMin > 0 && !b.charging ? t('tray.hours', { h: Math.floor(b.timeLeftMin / 60), m: b.timeLeftMin % 60 }) : null;
    bat.dataset.tip = b.charging ? t('tray.charging', { percent: pct }) : time ? t('tray.batteryTime', { percent: pct, time }) : t('tray.battery', { percent: pct });
  }
  // Never leave the quick-settings button empty.
  const fallback = trayEl.querySelector('.tb-qs-fallback');
  fallback.hidden = !(net.hidden && vol.hidden && bat.hidden);
  fitApps(); // the tray's width changed: re-check how many app buttons fit
}

async function refreshStatus(kind) {
  const ch = { net: 'net:status', audio: 'audio:status', battery: 'power:battery' }[kind];
  try {
    status[kind] = (await api.invoke(ch)) || null;
  } catch {
    status[kind] = null; // backend missing (ENOHANDLER) or failing: hide the icon
  }
  renderTray();
}
// Status fetched by someone else (quick settings) is shared with the tray: a backend only pushes
// *changes* ('net:changed'/'audio:changed'), so a status read elsewhere can swallow that push.
function applyStatus(kind, st) {
  if (!(kind in status)) return;
  status[kind] = st ?? null;
  renderTray();
}

let wheelBusy = Promise.resolve();
function onVolumeWheel(e) {
  if (!status.audio) return;
  e.preventDefault();
  const delta = e.deltaY < 0 ? 2 : -2;
  const next = Math.max(0, Math.min(100, Math.round((status.audio.volume ?? 0) + delta)));
  const unmute = !!status.audio.muted && delta > 0;
  status.audio = { ...status.audio, volume: next, muted: unmute ? false : !!status.audio.muted };
  renderTray();
  shell.emit('osd', { kind: 'volume', value: next, muted: status.audio.muted });
  wheelBusy = wheelBusy
    .then(async () => {
      await api.invoke('audio:setVolume', next);
      if (unmute) await api.invoke('audio:setMuted', false);
    })
    .catch(() => {});
}

// ---------------------------------------------------------------- taskbar menu & keyboard
function taskbarMenu(e) {
  if (e.target.closest('.tb-app, .tb-preview')) return;
  e.preventDefault();
  e.stopPropagation();
  // Opens just above the taskbar, like Windows (a point with an anchor rect = the taskbar's top edge);
  // under a top taskbar, beside a vertical one.
  const tr = root.getBoundingClientRect();
  const p = tbPos();
  const point = e.clientX || e.clientY;
  let at = e;
  if (point && p === 'bottom') at = { x: e.clientX, y: e.clientY, anchor: { left: e.clientX, right: e.clientX, top: tr.top, bottom: tr.top } };
  else if (point && p === 'top') at = { x: e.clientX, y: tr.bottom + 4 };
  else if (point && p === 'left') at = { x: tr.right + 4, y: e.clientY };
  else if (point && p === 'right') at = { x: tr.left - 4, y: e.clientY, sub: new DOMRect(tr.left - 4, e.clientY, 1, 1) };
  ui.menu(at, [
    registry.get('taskmgr') ? { label: t('taskbar.taskManager'), icon: 'data_histogram', action: () => shell.launch('taskmgr') } : null,
    '-',
    { label: t('taskbar.settings'), icon: 'settings', action: () => shell.launch('settings', { page: 'taskbar' }) },
  ].filter((x, i, arr) => x && !(x === '-' && (i === 0 || !arr[i - 1]))), { above: p === 'bottom' });
}

function onKeyNav(e) {
  const v = isVertical();
  const fwd = v ? 'ArrowDown' : 'ArrowRight';
  const back = v ? 'ArrowUp' : 'ArrowLeft';
  if (e.key !== fwd && e.key !== back && e.key !== 'Home' && e.key !== 'End') return;
  const all = [...root.querySelectorAll('.tb-btn:not([hidden]):not(.leaving)')].filter((b) => b.offsetParent);
  const i = all.indexOf(document.activeElement);
  if (i < 0) return;
  e.preventDefault();
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1 : (i + (e.key === fwd ? 1 : -1) + all.length) % all.length;
  all[next].focus();
}

// ---------------------------------------------------------------- tray: status items + mini widgets
function renderStatusItems() {
  const box = trayEl?.querySelector('.tb-status');
  if (!box) return;
  box.replaceChildren(
    ...[...statusItems].map(([id, it]) =>
      h(
        'button',
        { class: 'tb-btn tb-focus-pill', dataset: { status: id, tip: it.tip || it.text || '' }, 'aria-label': it.tip || it.text || id, onclick: (e) => it.onClick?.(e) },
        icon(it.icon || 'target', { size: 16 }),
        it.text ? h('span', { class: 'tb-status-text' }, it.text) : null,
      ),
    ),
  );
}

// Mini widgets (taskbar.widgets): live values in the tray, refreshed every 3 s while visible.
export const MINI_WIDGETS = ['weather', 'cpu', 'memory', 'network'];
const mini = { timer: 0, net: null, weather: null, weatherAt: 0, weatherErr: null, busy: false };
function miniIds() {
  return (tbCfg().widgets || []).filter((x, i, a) => MINI_WIDGETS.includes(x) && a.indexOf(x) === i);
}
const fmtRate = (bps) => {
  const n = Math.max(0, Number(bps) || 0);
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
};
const WEATHER_ICON = { clear: 'weather_sunny', clouds: 'weather_cloudy', fog: 'weather_fog', rain: 'weather_rain', snow: 'weather_snow', storm: 'weather_thunderstorm' };
function renderMinis() {
  if (!minisEl) return;
  const ids = focusSimple() ? [] : miniIds();
  minisEl.hidden = !ids.length;
  const open = (id) => (id === 'weather' ? shell.emit('widgets:toggle') : registry.get('taskmgr') ? shell.launch('taskmgr', { page: 'performance' }) : shell.emit('widgets:toggle'));
  minisEl.replaceChildren(
    ...ids.map((id) =>
      h(
        'button',
        { class: ['tb-btn tb-mini', `tb-mini-${id}`], dataset: { mini: id }, 'aria-label': id, onclick: () => open(id) },
        id === 'weather'
          ? [icon('weather_partly_cloudy_day', { size: 16 }), h('span', { class: 'tb-mini-val' }, '—')]
          : id === 'network'
            ? [h('span', { class: 'tb-mini-val tb-mini-down' }, '↓ —'), h('span', { class: 'tb-mini-val tb-mini-up' }, '↑ —')]
            : [h('span', { class: 'tb-meter' }, h('i')), h('span', { class: 'tb-mini-lbl' }, t(`tbmini.${id}`)), h('span', { class: 'tb-mini-val' }, '—')],
      ),
    ),
  );
  for (const b of minisEl.querySelectorAll('.tb-mini-network')) b.classList.add('tb-mini-net');
  clearInterval(mini.timer);
  mini.timer = 0;
  if (ids.length) {
    paintMinis();
    pollMinis();
    mini.timer = setInterval(pollMinis, 3000);
  }
}
async function pollMinis() {
  if (mini.busy || document.hidden || !minisEl || minisEl.hidden) return;
  const ids = miniIds();
  mini.busy = true;
  try {
    if (ids.some((x) => x !== 'weather')) {
      const st = await api.invoke('sys:stats').catch(() => null);
      if (st) {
        const now = Date.now();
        const prev = mini.net;
        mini.stats = st;
        if (st.net && prev && now > prev.at) {
          const dt = (now - prev.at) / 1000;
          mini.rate = { down: Math.max(0, (st.net.rx - prev.rx) / dt), up: Math.max(0, (st.net.tx - prev.tx) / dt) };
        }
        if (st.net) mini.net = { rx: st.net.rx, tx: st.net.tx, at: now };
      }
    }
    if (ids.includes('weather') && Date.now() - mini.weatherAt > 15 * 60000) {
      mini.weatherAt = Date.now();
      try {
        mini.weather = await api.invoke('weather:current');
        mini.weatherErr = null;
      } catch (err) {
        mini.weatherErr = err?.code || 'ERR';
      }
    }
  } finally {
    mini.busy = false;
  }
  paintMinis();
}
function paintMinis() {
  if (!minisEl) return;
  const st = mini.stats;
  for (const b of minisEl.querySelectorAll('.tb-mini')) {
    const id = b.dataset.mini;
    if (id === 'cpu' || id === 'memory') {
      let v = null;
      let tip = '';
      if (st && id === 'cpu') {
        v = Math.round(st.cpu || 0);
        tip = t('tbmini.cpuTip', { value: v });
      } else if (st?.mem?.total) {
        const used = st.mem.used ?? st.mem.total - (st.mem.available || 0);
        v = Math.round((used / st.mem.total) * 100);
        tip = t('tbmini.memoryTip', { value: v, used: i18n.formatSize(used), total: i18n.formatSize(st.mem.total) });
      }
      b.querySelector('.tb-mini-val').textContent = v == null ? '—' : `${v}%`;
      b.querySelector('.tb-meter > i')?.style.setProperty('--v', `${v ?? 0}%`);
      b.dataset.level = v >= 90 ? 'max' : v >= 70 ? 'high' : 'ok';
      b.dataset.tip = tip || t(`tbmini.${id}`);
      b.setAttribute('aria-label', b.dataset.tip);
    } else if (id === 'network') {
      const r = mini.rate;
      b.querySelector('.tb-mini-down').textContent = `↓ ${r ? fmtRate(r.down) : '—'}`;
      b.querySelector('.tb-mini-up').textContent = `↑ ${r ? fmtRate(r.up) : '—'}`;
      b.dataset.tip = t('tbmini.netTip', { down: r ? fmtRate(r.down) : '—', up: r ? fmtRate(r.up) : '—' });
      b.setAttribute('aria-label', b.dataset.tip);
    } else if (id === 'weather') {
      const w = mini.weather;
      const val = b.querySelector('.tb-mini-val');
      if (w && Number.isFinite(w.temperature)) {
        const name = WEATHER_ICON[w.kind] || 'weather_partly_cloudy_day';
        const ic = b.querySelector('.icon');
        if (ic?.dataset.icon !== name) ic?.replaceWith(icon(w.isDay === false && w.kind === 'clear' ? 'weather_moon' : name, { size: 16 }));
        val.textContent = `${Math.round(w.temperature)}°`;
        const dk = `tbmini.w_${w.describe}`;
        const describe = t(dk);
        b.dataset.tip = t('tbmini.weatherTip', { place: w.location?.name || '', temp: `${Math.round(w.temperature)} ${w.unit || '°C'}`, describe: describe === dk ? w.kind : describe });
      } else {
        val.textContent = '—';
        b.dataset.tip = mini.weatherErr === 'ENOLOCATION' || !mini.weatherErr ? t('tbmini.weatherNoPlace') : t('tbmini.weatherOffline');
      }
      b.setAttribute('aria-label', b.dataset.tip);
    }
  }
}

// ---------------------------------------------------------------- auto-hide
let hideTimer = null;
function autohideOn() {
  return !!settings.get('taskbar.autohide');
}
function reveal() {
  clearTimeout(hideTimer);
  root?.classList.remove('hidden');
}
function scheduleHide(ms = hideDelay()) {
  clearTimeout(hideTimer);
  if (!autohideOn()) return;
  hideTimer = setTimeout(() => {
    // (only open popup menus count: Settings keeps hidden `.menu` elements, e.g. its search suggestions)
    const busy = isFlyoutOpen() || root.matches(':hover') || root.contains(document.activeElement) || document.querySelector('body > .menu') || previewEl;
    if (busy) return scheduleHide(ms);
    root.classList.add('hidden');
  }, ms);
}
function applyAutohide() {
  const on = autohideOn();
  root.classList.toggle('autohide', on);
  document.body.classList.toggle('tb-autohide', on);
  hotzone.hidden = !on;
  // The work area loses the taskbar's thickness on the edge it stands on (nothing when it auto-hides).
  const insets = { top: 0, bottom: 0, left: 0, right: 0 };
  if (!on) insets[tbPos()] = thickness();
  const cur = wm.insets || {};
  if (['top', 'bottom', 'left', 'right'].some((k) => cur[k] !== insets[k])) wm.setInsets(insets);
  if (on) scheduleHide(Math.max(900, hideDelay()));
  else reveal();
}

// Size, edge and labels: <html data-tb-pos / data-tb-size / data-tb-labels> + --taskbar-h (core/shell-personalize.css).
let layoutKey = '';
function applyLayout() {
  const de = document.documentElement;
  const p = tbPos();
  const key = `${p}|${tbSize()}|${labelsOn()}|${barMode()}`;
  de.dataset.tbPos = p;
  de.dataset.tbSize = tbSize();
  de.dataset.tbLabels = labelsOn() ? 'on' : 'off';
  de.style.setProperty('--taskbar-h', `${thickness()}px`);
  root.classList.toggle('vertical', isVertical());
  root.setAttribute('aria-orientation', isVertical() ? 'vertical' : 'horizontal');
  const changed = key !== layoutKey;
  layoutKey = key;
  return changed;
}

// ---------------------------------------------------------------- static layout
function renderStatic() {
  hidePreview(true);
  closeOverflow();
  clear(root);
  buttons.clear();
  const tb = settings.get('taskbar') || {};
  const align = tb.align === 'left' ? 'left' : 'center';
  const vertical = isVertical();
  root.classList.toggle('left', align === 'left');
  document.body.classList.toggle('tb-left', align === 'left');
  let searchMode = ['hidden', 'icon', 'box'].includes(tb.search) ? tb.search : tb.showSearch === false ? 'hidden' : 'icon';
  if (vertical && searchMode === 'box') searchMode = 'icon';
  const wpos = widgetsPos();
  const widgetsBtn = (withLabel) =>
    h(
      'button',
      { class: ['tb-btn tb-widgets', withLabel && 'with-label'], 'data-tip': t('taskbar.widgets'), 'aria-label': t('taskbar.widgets'), onclick: () => shell.emit('widgets:toggle') },
      icon('cloud-sun', { size: 20 }),
      withLabel ? h('span', { class: 'tb-label' }, t('taskbar.widgets')) : null,
    );
  // Left: the Lanceur and its search (+ Overview, Dashboard at the start). Centre: the apps (centred on the screen in
  // every style; taskbar.align = left puts them right after the left part). Right: status, clock, notifications.
  // The Lanceur and its search form one control (.tb-launch): the crescent, then the search button. The docked bar
  // (Éclipse) draws it as a single field « Rechercher … Super »; the floating bars as two round buttons.
  const searchBtn =
    searchMode === 'hidden'
      ? null
      : h(
          'button',
          {
            class: ['tb-btn tb-search', searchMode === 'box' && 'tb-searchbox'],
            'data-tip': searchMode === 'box' ? null : t('taskbar.search'),
            'aria-label': t('taskbar.search'),
            onclick: () => shell.emit('search:toggle'),
          },
          icon('magnifying-glass', { size: searchMode === 'box' ? 16 : 20 }),
          h('span', { class: 'tb-search-text' }, t('taskbar.searchBox')),
          h('kbd', { class: 'tb-search-key', 'aria-hidden': 'true' }, 'Super'),
        );
  leftEl = h(
    'div',
    { class: 'tb-left tb-part' },
    h(
      'div',
      { class: ['tb-launch', searchBtn && 'with-search'], role: 'group', 'aria-label': t('taskbar.start') },
      h(
        'button',
        { class: 'tb-btn tb-start', 'data-tip': t('taskbar.start'), 'aria-label': t('taskbar.start'), onclick: () => shell.emit('start:toggle') },
        h('span', { class: 'icon tb-logo', html: logoSvg() }),
      ),
      searchBtn,
    ),
    tb.showTaskView !== false
      ? h('button', { class: 'tb-btn tb-taskview', 'data-tip': t('taskbar.taskView'), 'aria-label': t('taskbar.taskView'), onclick: () => shell.emit('taskview:toggle') }, icon('rows', { size: 20 }))
      : null,
    tb.showWidgets && wpos === 'start' ? widgetsBtn(true) : null,
  );
  centerEl = h('div', { class: 'tb-center tb-part' }, tb.showWidgets && wpos === 'inline' ? widgetsBtn(false) : null, (appsBox = h('div', { class: 'tb-apps' })));
  trayEl = h(
    'div',
    { class: 'tb-tray tb-part' },
    tb.showWidgets && wpos === 'end' ? widgetsBtn(!vertical) : null,
    h('div', { class: 'tb-status' }),
    h('div', { class: 'tb-sni', hidden: true }), // app tray icons (StatusNotifierItem): core/features/tray.js
    (minisEl = h('div', { class: 'tb-minis', hidden: true })),
    h(
      'button',
      { class: 'tb-btn tb-quick', 'aria-label': t('taskbar.quickSettings'), onclick: () => shell.emit('quick:toggle') },
      h('span', { class: 'tb-net', hidden: true }),
      h('span', { class: 'tb-vol', hidden: true, onwheel: onVolumeWheel }),
      h('span', { class: 'tb-bat', hidden: true }),
      h('span', { class: 'tb-qs-fallback', 'data-tip': t('taskbar.quickSettings') }, icon('options', { size: 16 })),
    ),
    (clockEl = h(
      'button',
      { class: 'tb-btn tb-clock', onclick: () => shell.emit('calendar:toggle') },
      h('span', { class: 'tb-clock-text' }, h('span', { class: 'tb-time' }), h('span', { class: 'tb-date' }, h('span', { class: 'tb-date-short' }), h('span', { class: 'tb-date-long', 'aria-hidden': 'true' }, h('span', { class: 'tb-date-wd' }), h('span', { class: 'tb-date-dm' })))),
      h('span', { class: 'tb-bell' }),
    )),
    h('div', { class: 'tb-showdesk', 'data-tip': t('taskbar.showDesktop'), role: 'button', 'aria-label': t('taskbar.showDesktop'), onclick: () => wm.toggleDesktop() }),
  );
  root.append(leftEl, centerEl, trayEl);
  trayObserver.disconnect();
  trayObserver.observe(trayEl);
  trayObserver.observe(leftEl);
  renderStatusItems();
  sniRender?.(trayEl.querySelector('.tb-sni'));
  renderMinis();
  bulk = true;
  renderApps();
  bulk = false;
  renderClock();
  renderBell();
  renderTray();
}

function applyAlign() {
  const tb = settings.get('taskbar') || {};
  const wantLeft = tb.align === 'left';
  const layoutChanged = applyLayout();
  if (layoutChanged) shell.emit('taskbar:layout', taskbar.layout());
  if (layoutChanged || wantLeft === root.classList.contains('left') || !centerEl || reduceMotion()) return renderStatic();
  // Glide the whole group to its new home instead of jumping.
  const v = isVertical();
  const at = () => (v ? centerEl.getBoundingClientRect().top : centerEl.getBoundingClientRect().left);
  const before = at();
  renderStatic();
  const after = at();
  centerEl.animate([{ transform: `${v ? 'translateY' : 'translateX'}(${before - after}px)` }, { transform: 'none' }], { duration: 420, easing: EASE, composite: 'add' });
}

// Apps reach the tray through shell.setStatusItem (core/services.js), e.g. the Navigateur's screen sharing button.
shell.on('status-item', (id, item) => taskbar.setStatusItem(id, item));

export const taskbar = {
  mount(el) {
    root = el;
    i18n.extend(STRINGS);
    ui.loadCss('app://shell/core/taskbar-start.css');
    root.setAttribute('role', 'toolbar');
    notifications.setNameResolver?.((id) => (registry.get(id) ? registry.name(id) : id === 'system' ? t('notif.system') : id));
    applyLayout();
    renderStatic();
    hotzone = h('div', { class: 'tb-hotzone', hidden: true, onpointerenter: () => (reveal(), scheduleHide(Math.max(1600, hideDelay()))) });
    document.body.appendChild(hotzone);
    root.addEventListener('pointerenter', reveal);
    root.addEventListener('pointerleave', () => scheduleHide());
    root.addEventListener('focusin', reveal);
    root.addEventListener('focusout', () => scheduleHide());
    root.addEventListener('contextmenu', taskbarMenu);
    // Dropping an app (e.g. a Start tile) on the taskbar pins it.
    root.addEventListener('dragover', (e) => {
      if (![...(e.dataTransfer?.types || [])].includes('application/x-aurora-app')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      root.classList.add('drop-pin');
    });
    root.addEventListener('dragleave', (e) => !root.contains(e.relatedTarget) && root.classList.remove('drop-pin'));
    root.addEventListener('drop', (e) => {
      root.classList.remove('drop-pin');
      const id = e.dataTransfer?.getData('application/x-aurora-app');
      if (!id || !registry.get(id)) return;
      e.preventDefault();
      if (!(settings.get('pinned') || []).includes(id)) setPinned(id, true);
    });
    root.addEventListener('keydown', onKeyNav);
    flyEvents.on('change', () => {
      // A flyout also brings the taskbar back over a fullscreen window (like Start in Windows).
      root.classList.toggle('fly-open', isFlyoutOpen());
      if (isFlyoutOpen()) reveal();
      else scheduleHide();
    });
    applyAutohide();
    requestAnimationFrame(() => root.classList.add('ready'));

    for (const ev of ['change', 'open', 'close', 'desktop']) wm.on(ev, () => renderApps());
    wm.on('close', (w) => {
      const u = thumbs.get(w?.id);
      if (u) URL.revokeObjectURL(u);
      thumbs.delete(w?.id);
    });
    // Hide the taskbar while a window is fullscreen.
    wm.on('change', () => {
      const f = wm.focused();
      document.body.classList.toggle('has-fullscreen', !!(f && f.fullscreen && !f.minimized));
    });
    settings.on('pinned', () => renderApps());
    // A new visual style can change the bar mode: the band's thickness (work area), the labels and the fit follow.
    theme.on?.('style', () =>
      requestAnimationFrame(() => {
        applyAlign();
        applyAutohide();
        fitApps();
      }),
    );
    // (settings:setMany of other keys reaches every listener: only a real change of taskbar.* re-lays the bar)
    let tbSig = JSON.stringify(settings.get('taskbar') || {});
    settings.on('taskbar', () => {
      const now = JSON.stringify(settings.get('taskbar') || {});
      if (now === tbSig) return;
      tbSig = now;
      applyAlign();
      applyAutohide();
    });
    // Focus mode (features/focus.js) toggles <html data-focus-simple>: running apps only, no extras.
    new MutationObserver((recs) => {
      if (recs.some((r) => r.attributeName === 'data-focus-quiet')) {
        renderBell();
        renderApps(); // badges + flashing
      }
      if (recs.some((r) => r.attributeName === 'data-focus-simple')) {
        renderMinis();
        renderApps();
      }
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-focus-simple', 'data-focus-quiet'] });
    document.addEventListener('visibilitychange', () => !document.hidden && minisEl && !minisEl.hidden && pollMinis());
    settings.on('clock24h', tickClock);
    settings.on('showSeconds', tickClock);
    settings.on('notifications', renderBell);
    // Volume changed by the hotkeys / quick settings: reflect it right away in the tray icon.
    shell.on('osd', (o) => {
      if (o?.kind !== 'volume' || !status.audio || o.value == null) return;
      status.audio = { ...status.audio, volume: Math.round(Number(o.value) || 0), muted: !!o.muted };
      renderTray();
    });
    i18n.on('change', () => {
      renderStatic();
      tickClock();
    });
    notifications.on('change', () => {
      renderBell();
      paintBadges();
    });
    tickClock();

    // System status (owned by the system backend; icons hide when a channel is missing).
    refreshStatus('net');
    refreshStatus('audio');
    refreshStatus('battery');
    api.on('net:changed', (st) => {
      status.net = st || null;
      renderTray();
    });
    api.on('audio:changed', (st) => {
      status.audio = st || null;
      renderTray();
    });
    api.on('power:changed', (st) => {
      status.battery = st || null;
      renderTray();
    });
    setInterval(() => refreshStatus('battery'), 60000);
    // Safety net: backends only push changes, and a status read by another component can swallow a
    // push — re-sync the tray now and then so it can never stay wrong for long.
    setInterval(() => {
      refreshStatus('net');
      refreshStatus('audio');
    }, 30000);
    window.addEventListener('resize', () => {
      hidePreview(true);
      closeOverflow();
      fitApps();
    });

    wm.anchorProvider = (win) => buttonFor(win.appId, win)?.getBoundingClientRect() || null;
  },
  anchorFor(appId) {
    return buttonFor(appId)?.getBoundingClientRect() || null;
  },
  /** { position, size, vertical, thickness, combine, labels } of the current taskbar layout. */
  layout() {
    return { position: tbPos(), size: tbSize(), vertical: isVertical(), thickness: thickness(), combine: combineMode(), labels: labelsOn() };
  },
  /** Extra tray button (e.g. the Focus mode timer): { icon, text, tip, onClick }, or null to remove it. */
  setStatusItem(id, item) {
    if (item) statusItems.set(id, item);
    else statusItems.delete(id);
    renderStatusItems();
    fitApps();
  },
  /** App tray icons (core/features/tray.js): fn(host) draws them into the tray's .tb-sni box, again after each rebuild. */
  setTrayRenderer(fn) {
    sniRender = typeof fn === 'function' ? fn : null;
    const host = trayEl?.querySelector('.tb-sni');
    if (host && sniRender) sniRender(host);
    fitApps();
  },
  /** The app tray icons changed (their number): re-check how many app buttons fit. */
  trayChanged() {
    fitApps();
  },
  /** Mini widget values (tests / Settings): refresh now. */
  refreshWidgets() {
    mini.weatherAt = 0;
    return pollMinis();
  },
  setTrayIcon(kind, iconName) {
    const span = trayEl?.querySelector(kind === 'net' ? '.tb-net' : '.tb-vol');
    if (span) {
      span.hidden = false;
      setGlyph(span, `custom:${iconName}`, () => icon(iconName, { size: 16 }));
    }
  },
  /** Latest system status seen by the tray: { net, audio, battery } (null = backend unavailable). */
  status() {
    return { ...status };
  },
  /** Share a status read elsewhere (quick settings) with the tray: kind = 'net' | 'audio' | 'battery'. */
  applyStatus(kind, st) {
    applyStatus(kind, st);
  },
  /** Re-query network / audio / battery status (e.g. after resume). */
  refresh() {
    return Promise.all(['net', 'audio', 'battery'].map(refreshStatus));
  },
  reveal() {
    reveal();
    scheduleHide(2000);
  },
  get el() {
    return root;
  },
};
