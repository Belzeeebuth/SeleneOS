// Taskbar: Start, Search, Task view, Widgets, pinned + running apps, system tray, clock.
//   taskbar.mount(el)   taskbar.anchorFor(appId) -> DOMRect of the app's button (for animations)
//   taskbar.reveal()    show the taskbar when it is auto-hidden
//   Emits through the shell event bus: 'start:toggle', 'search:toggle', 'taskview:toggle',
//   'widgets:toggle', 'quick:toggle', 'calendar:toggle', 'osd'.
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

// ---------------------------------------------------------------- tray glyphs (Windows 11 style)
const ARC = (r) => {
  const k = r * Math.SQRT1_2;
  return `M${(10 - k).toFixed(2)} ${(16.5 - k).toFixed(2)}A${r} ${r} 0 0 1 ${(10 + k).toFixed(2)} ${(16.5 - k).toFixed(2)}`;
};
function wifiSvg(level) {
  // level 0..4 : number of lit arcs (0 = only the dot)
  const arcs = [4.6, 8.2, 11.8]
    .map((r, i) => `<path d="${ARC(r)}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" opacity="${i < level - 1 ? 1 : 0.32}"/>`)
    .join('');
  return `<svg viewBox="0 0 20 20" aria-hidden="true">${arcs}<circle cx="10" cy="16.4" r="1.35" fill="currentColor"/></svg>`;
}
const ETHERNET_SVG =
  '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="4.3" y="3.3" width="13.4" height="9.4" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8.5 16.5h5M11 12.8v3.6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M1.8 9.5h2.6M3.1 9.5v6.5h2.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
function batterySvg(pct, charging) {
  const w = Math.max(1, Math.round((12.4 * Math.max(0, Math.min(100, pct))) / 100 * 10) / 10);
  const low = pct <= 10 && !charging;
  return `<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="1.7" y="5.7" width="15" height="8.6" rx="2" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="17.4" y="8.2" width="1.4" height="3.6" rx=".6" fill="currentColor"/><rect x="3.3" y="7.3" width="${w}" height="5.4" rx="1" fill="${low ? '#e81123' : 'currentColor'}"/>${
    charging ? '<path d="M10.6 4.2 7.4 10.4h2.7l-.9 5.4 3.4-6.6H9.9z" fill="currentColor" stroke="var(--taskbar-solid, #eee)" stroke-width=".9" stroke-linejoin="round"/>' : ''
  }</svg>`;
}
function glyph(svg, size = 16) {
  return h('span', { class: 'icon', style: { width: `${size}px`, height: `${size}px` }, html: svg });
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
const buttons = new Map(); // appId -> button
const thumbs = new Map(); // winId -> blob URL
const status = { net: undefined, audio: undefined, battery: undefined };
let suppressClick = false;
let bulk = false; // true while the whole taskbar is rebuilt (no per-button entrance animation)

function visibleWins(appId) {
  const list = wm.listDesktop ? wm.listDesktop() : wm.list();
  return list.filter((w) => (!appId || w.appId === appId) && !w._closing && !w.opts?.skipTaskbar);
}

function appOrder() {
  const pinned = (settings.get('pinned') || []).filter((id) => registry.get(id));
  const running = [];
  for (const w of [...visibleWins()].sort((a, b) => a.createdAt - b.createdAt)) {
    if (!pinned.includes(w.appId) && !running.includes(w.appId)) running.push(w.appId);
  }
  return [...pinned, ...running];
}

function setPinned(appId, pin) {
  const list = (settings.get('pinned') || []).filter((x) => x !== appId);
  if (pin) list.push(appId);
  return settings.set('pinned', list);
}

// FLIP: animate taskbar buttons from their old to their new positions (smooth re-centering).
function flip(mutate) {
  if (reduceMotion() || !centerEl) return mutate();
  const els = [...centerEl.querySelectorAll(':scope > .tb-btn, .tb-apps > .tb-btn:not(.leaving)')];
  const before = new Map(els.map((e) => [e, e.getBoundingClientRect().left]));
  mutate();
  for (const [e, left] of before) {
    if (!e.isConnected || e.classList.contains('dragging')) continue;
    const dx = left - e.getBoundingClientRect().left;
    if (Math.abs(dx) > 0.5) e.animate([{ transform: `translateX(${dx}px)` }, { transform: 'none' }], { duration: 320, easing: EASE });
  }
}

// ---------------------------------------------------------------- app buttons
function appMenu(e, appId) {
  e.preventDefault();
  hidePreview(true);
  const wins = visibleWins(appId);
  const pinned = (settings.get('pinned') || []).includes(appId);
  const m = registry.get(appId);
  const anchor = buttons.get(appId) || e.currentTarget;
  const p = ui.menu(
    anchor,
    [
      { label: registry.name(appId), icon: 'app_generic', action: () => registry.launch(appId, { newWindow: true }) },
      m ? { label: pinned ? t('taskbar.unpin') : t('taskbar.pin'), icon: pinned ? 'pin_off' : 'pin', action: () => setPinned(appId, !pinned) } : null,
      wins.length ? { label: wins.length > 1 ? t('taskbar.closeAll') : t('taskbar.closeWindow'), icon: 'dismiss', action: () => wins.forEach((w) => w.close()) } : null,
    ].filter(Boolean),
    { above: true, class: 'tb-jump' },
  );
  // Centre the jump list over the button and show the real app icon (Windows 11 style).
  const menu = [...document.querySelectorAll('.menu.tb-jump')].pop();
  if (menu) {
    const r = anchor.getBoundingClientRect();
    const mr = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(window.innerWidth - mr.width - 8, r.left + r.width / 2 - mr.width / 2))}px`;
    const first = menu.querySelector('.menu-item .icon');
    if (first) first.replaceWith(h('img', { class: 'icon', src: registry.iconUrl(appId), alt: '', draggable: false }));
  }
  return p;
}

async function captureThumb(win) {
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
    const bytes = await Promise.race([api.invoke('shell:capture', { x: r.left, y: r.top, width: r.width, height: r.height }), new Promise((res) => setTimeout(() => res(null), 400))]);
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
function showPreview(appId, pinned = false) {
  const wins = visibleWins(appId);
  const btn = buttons.get(appId);
  if (!wins.length || !btn || document.querySelector('.menu.tb-jump')) return hidePreview(true);
  hidePreview(true);
  previewApp = appId;
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
  const r = btn.getBoundingClientRect();
  const pr = previewEl.getBoundingClientRect();
  previewEl.style.left = `${Math.max(8, Math.min(window.innerWidth - pr.width - 8, r.left + r.width / 2 - pr.width / 2))}px`;
}

// Close the picker when clicking elsewhere.
document.addEventListener(
  'pointerdown',
  (e) => {
    if (previewEl && !previewEl.contains(e.target) && !e.target.closest?.('.tb-app')) hidePreview(true);
  },
  true,
);

async function clickApp(appId, btn) {
  if (suppressClick) {
    suppressClick = false;
    return;
  }
  const wins = visibleWins(appId);
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
      await captureThumb(w);
      w.minimize();
    } else w.focus();
    return;
  }
  // Several windows: show the window picker (or close it when it is already pinned open).
  if (previewEl && previewApp === appId && previewPinned) hidePreview(true);
  else showPreview(appId, true);
}

function startDrag(e, appId, btn) {
  if (e.button !== 0) return;
  const pinned = (settings.get('pinned') || []).filter((id) => registry.get(id));
  const from = pinned.indexOf(appId);
  if (from < 0) return;
  const sx = e.clientX;
  let dragging = false;
  let slots = [];
  let to = from;
  const step = () => btn.getBoundingClientRect().width + 4;
  const move = (ev) => {
    const dx = ev.clientX - sx;
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
    btn.style.transform = `translateX(${Math.max(-from * w, Math.min((pinned.length - 1 - from) * w, dx))}px)`;
    slots.forEach((b, i) => {
      if (!b || b === btn) return;
      let shift = 0;
      if (from < to && i > from && i <= to) shift = -w;
      if (from > to && i < from && i >= to) shift = w;
      b.style.transform = shift ? `translateX(${shift}px)` : '';
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

function makeAppButton(id) {
  let dragTimer = null;
  const b = h(
    'button',
    {
      class: 'tb-btn tb-app',
      dataset: { app: id },
      'aria-label': registry.name(id),
      onclick: () => clickApp(id, b),
      oncontextmenu: (e) => appMenu(e, id),
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
        if (visibleWins(id).length) schedulePreview(id);
      },
      onauxclick: (e) => {
        if (e.button === 1) registry.launch(id, { newWindow: true });
      },
      // Dragging files over a button brings that app forward (like Windows).
      ondragenter: () => {
        clearTimeout(dragTimer);
        dragTimer = setTimeout(() => visibleWins(id)[0]?.focus(), 650);
      },
      ondragleave: () => clearTimeout(dragTimer),
      ondrop: () => clearTimeout(dragTimer),
    },
    h('img', { src: registry.iconUrl(id), alt: '', draggable: false }),
    h('span', { class: 'tb-ind' }),
    h('span', { class: 'tb-progress' }),
  );
  return b;
}

function renderApps() {
  if (!appsBox) return;
  const order = appOrder();
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
  };
  if (changed) flip(apply);
  else apply();
  const focused = wm.focused();
  for (const [id, b] of buttons) {
    const wins = visibleWins(id);
    b.classList.toggle('running', wins.length > 0);
    b.classList.toggle('active', wins.some((w) => w === focused && !w.minimized));
    b.classList.toggle('multi', wins.length > 1);
    const flashing = wins.some((w) => w.flashing);
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
    b.setAttribute('aria-label', wins.length === 1 ? wins[0].title || registry.name(id) : registry.name(id));
  }
  if (previewEl && previewApp && !visibleWins(previewApp).length) hidePreview(true);
}

// ---------------------------------------------------------------- tray
function renderClock() {
  if (!clockEl) return;
  const now = new Date();
  const h24 = settings.get('clock24h');
  const timeOpts = { hour: 'numeric', minute: '2-digit' };
  if (h24 != null) timeOpts.hour12 = !h24;
  if (settings.get('showSeconds')) timeOpts.second = '2-digit';
  clockEl.querySelector('.tb-time').textContent = i18n.formatTime(now, timeOpts);
  clockEl.querySelector('.tb-date').textContent = i18n.formatDate(now, { day: '2-digit', month: '2-digit', year: 'numeric' });
  const full = i18n.formatDate(now, { dateStyle: 'full' });
  clockEl.dataset.tip = full.charAt(0).toUpperCase() + full.slice(1);
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
  const dnd = !!settings.get('notifications.dnd');
  clear(bell);
  if (n > 0 && !dnd) {
    bell.append(h('span', { class: 'tb-count' }, n > 99 ? '99+' : String(n)));
    clockEl.setAttribute('aria-label', t('taskbar.notifications', { count: n }));
  } else {
    bell.append(icon(dnd ? 'alert_snooze' : 'alert', { size: 16 }));
    clockEl.setAttribute('aria-label', dnd ? t('taskbar.dndOn') : t('taskbar.noNotifications'));
  }
  bell.classList.toggle('dnd', dnd);
}

function netGlyph(st) {
  if (!st) return null;
  if (st.airplane) return { node: icon('airplane', { size: 16 }), tip: t('tray.airplane') };
  const p = st.primary || {};
  const limited = st.connectivity !== 'full';
  if (p.type === 'wifi') {
    const s = Number(p.strength ?? 100);
    const level = s >= 75 ? 4 : s >= 50 ? 3 : s >= 25 ? 2 : 1;
    const node = limited ? icon('wifi_warning', { size: 16 }) : glyph(wifiSvg(level));
    return { node, tip: t(limited ? 'tray.wifiLimited' : 'tray.wifi', { name: p.name || 'Wi-Fi' }) };
  }
  if (p.type === 'ethernet') return { node: glyph(ETHERNET_SVG), tip: t(limited ? 'tray.ethernetLimited' : 'tray.ethernet'), limited };
  return { node: icon('globe_prohibited', { size: 16 }), tip: t('tray.disconnected') };
}

function renderTray() {
  if (!trayEl) return;
  const net = trayEl.querySelector('.tb-net');
  const vol = trayEl.querySelector('.tb-vol');
  const bat = trayEl.querySelector('.tb-bat');
  const ng = netGlyph(status.net);
  net.hidden = !ng;
  if (ng) {
    net.replaceChildren(ng.node);
    net.dataset.tip = ng.tip;
  }
  const a = status.audio;
  vol.hidden = !a;
  if (a) {
    const v = Math.round(a.volume ?? 0);
    const name = a.muted ? 'speaker_mute' : v === 0 ? 'speaker_0' : v < 34 ? 'speaker_1' : 'speaker_2';
    vol.replaceChildren(icon(name, { size: 16 }));
    vol.dataset.tip = a.muted ? t('tray.muted') : t('tray.volume', { value: v });
  }
  const b = status.battery;
  bat.hidden = !b;
  if (b) {
    const pct = Math.round(b.percent ?? 0);
    bat.replaceChildren(glyph(batterySvg(pct, b.charging)));
    const time = b.timeLeftMin > 0 && !b.charging ? t('tray.hours', { h: Math.floor(b.timeLeftMin / 60), m: b.timeLeftMin % 60 }) : null;
    bat.dataset.tip = b.charging ? t('tray.charging', { percent: pct }) : time ? t('tray.batteryTime', { percent: pct, time }) : t('tray.battery', { percent: pct });
  }
  // Never leave the quick-settings button empty.
  const fallback = trayEl.querySelector('.tb-qs-fallback');
  fallback.hidden = !!(ng || a || b);
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
  ui.menu(e, [
    registry.get('taskmgr') ? { label: t('taskbar.taskManager'), icon: 'data_histogram', action: () => shell.launch('taskmgr') } : null,
    '-',
    { label: t('taskbar.settings'), icon: 'settings', action: () => shell.launch('settings', { page: 'taskbar' }) },
  ].filter((x, i, arr) => x && !(x === '-' && (i === 0 || !arr[i - 1]))), { above: true });
}

function onKeyNav(e) {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
  const all = [...root.querySelectorAll('.tb-btn:not([hidden]):not(.leaving)')].filter((b) => b.offsetParent);
  const i = all.indexOf(document.activeElement);
  if (i < 0) return;
  e.preventDefault();
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + all.length) % all.length;
  all[next].focus();
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
function scheduleHide(ms = 600) {
  clearTimeout(hideTimer);
  if (!autohideOn()) return;
  hideTimer = setTimeout(() => {
    const busy = isFlyoutOpen() || root.matches(':hover') || root.contains(document.activeElement) || document.querySelector('.menu') || previewEl;
    if (busy) return scheduleHide(ms);
    root.classList.add('hidden');
  }, ms);
}
function applyAutohide() {
  const on = autohideOn();
  root.classList.toggle('autohide', on);
  document.body.classList.toggle('tb-autohide', on);
  hotzone.hidden = !on;
  wm.setInsets({ bottom: on ? 0 : 48 });
  if (on) scheduleHide(900);
  else reveal();
}

// ---------------------------------------------------------------- static layout
function renderStatic() {
  hidePreview(true);
  clear(root);
  buttons.clear();
  const tb = settings.get('taskbar') || {};
  const align = tb.align === 'left' ? 'left' : 'center';
  root.classList.toggle('left', align === 'left');
  document.body.classList.toggle('tb-left', align === 'left');
  const searchMode = tb.search || (tb.showSearch === false ? 'hidden' : 'icon');
  const widgetsBtn = (withLabel) =>
    h(
      'button',
      { class: ['tb-btn tb-widgets', withLabel && 'with-label'], 'data-tip': t('taskbar.widgets'), 'aria-label': t('taskbar.widgets'), onclick: () => shell.emit('widgets:toggle') },
      icon('board', { size: 20 }),
      withLabel ? h('span', { class: 'tb-label' }, t('taskbar.widgets')) : null,
    );
  leftEl = h('div', { class: 'tb-left' }, tb.showWidgets && align === 'center' ? widgetsBtn(true) : null);
  centerEl = h(
    'div',
    { class: 'tb-center' },
    h(
      'button',
      { class: 'tb-btn tb-start', 'data-tip': t('taskbar.start'), 'aria-label': t('taskbar.start'), onclick: () => shell.emit('start:toggle') },
      h('img', { src: 'app://shell/assets/aurora-logo.svg', alt: '', draggable: false }),
    ),
    searchMode === 'box'
      ? h('button', { class: 'tb-btn tb-search tb-searchbox', 'aria-label': t('taskbar.search'), onclick: () => shell.emit('search:toggle') }, icon('search', { size: 16 }), h('span', null, t('taskbar.searchBox')))
      : searchMode !== 'hidden'
        ? h('button', { class: 'tb-btn tb-search', 'data-tip': t('taskbar.search'), 'aria-label': t('taskbar.search'), onclick: () => shell.emit('search:toggle') }, icon('search', { size: 20 }))
        : null,
    tb.showTaskView !== false
      ? h('button', { class: 'tb-btn tb-taskview', 'data-tip': t('taskbar.taskView'), 'aria-label': t('taskbar.taskView'), onclick: () => shell.emit('taskview:toggle') }, icon('task_list_square_ltr', { size: 20 }))
      : null,
    tb.showWidgets && align === 'left' ? widgetsBtn(false) : null,
    (appsBox = h('div', { class: 'tb-apps' })),
  );
  trayEl = h(
    'div',
    { class: 'tb-tray' },
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
      h('span', { class: 'tb-clock-text' }, h('span', { class: 'tb-time' }), h('span', { class: 'tb-date' })),
      h('span', { class: 'tb-bell' }),
    )),
    h('div', { class: 'tb-showdesk', 'data-tip': t('taskbar.showDesktop'), role: 'button', 'aria-label': t('taskbar.showDesktop'), onclick: () => wm.toggleDesktop() }),
  );
  root.append(leftEl, centerEl, trayEl);
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
  if (wantLeft === root.classList.contains('left') || !centerEl || reduceMotion()) return renderStatic();
  // Glide the whole group to its new home instead of jumping.
  const before = centerEl.getBoundingClientRect().left;
  renderStatic();
  const after = centerEl.getBoundingClientRect().left;
  centerEl.animate([{ transform: `translateX(${before - after}px)` }, { transform: 'none' }], { duration: 420, easing: EASE, composite: 'add' });
}

export const taskbar = {
  mount(el) {
    root = el;
    i18n.extend(STRINGS);
    root.setAttribute('role', 'toolbar');
    notifications.setNameResolver?.((id) => (registry.get(id) ? registry.name(id) : id === 'system' ? t('notif.system') : id));
    renderStatic();
    hotzone = h('div', { class: 'tb-hotzone', hidden: true, onpointerenter: () => (reveal(), scheduleHide(1600)) });
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
    settings.on('taskbar', () => {
      applyAlign();
      applyAutohide();
    });
    settings.on('clock24h', tickClock);
    settings.on('showSeconds', tickClock);
    settings.on('notifications', renderBell);
    i18n.on('change', () => {
      renderStatic();
      tickClock();
    });
    notifications.on('change', renderBell);
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
    window.addEventListener('resize', () => hidePreview(true));

    wm.anchorProvider = (win) => buttons.get(win.appId)?.getBoundingClientRect() || null;
  },
  anchorFor(appId) {
    return buttons.get(appId)?.getBoundingClientRect() || null;
  },
  setTrayIcon(kind, iconName) {
    const span = trayEl?.querySelector(kind === 'net' ? '.tb-net' : '.tb-vol');
    if (span) {
      span.hidden = false;
      span.replaceChildren(icon(iconName, { size: 16 }));
    }
  },
  /** Latest system status seen by the tray: { net, audio, battery } (null = backend unavailable). */
  status() {
    return { ...status };
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
