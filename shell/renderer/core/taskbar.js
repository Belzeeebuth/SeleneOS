// Taskbar: Start, Search, Task view, pinned + running apps, system tray and clock.
//   taskbar.mount(el)   taskbar.anchorFor(appId) -> DOMRect of the app's button (for animations)
//   Emits through the shell event bus: 'start:toggle', 'search:toggle', 'taskview:toggle',
//   'quick:toggle', 'calendar:toggle' (core modules subscribe to these).
import { h, icon, ui, clear } from './ui.js';
import { wm } from './wm.js';
import { registry } from './registry.js';
import { settings } from './settings.js';
import { i18n, t } from './i18n.js';
import { shell } from './services.js';
import { notifications } from './notify.js';

let root;
let appsBox;
let clockEl;
let trayEl;
const buttons = new Map(); // appId -> button

function appOrder() {
  const pinned = (settings.get('pinned') || []).filter((id) => registry.get(id));
  const running = [];
  for (const w of [...wm.list()].sort((a, b) => a.createdAt - b.createdAt)) {
    if (!pinned.includes(w.appId) && !running.includes(w.appId)) running.push(w.appId);
  }
  return [...pinned, ...running];
}

function appMenu(e, appId) {
  const wins = wm.byApp(appId);
  const pinned = (settings.get('pinned') || []).includes(appId);
  ui.menu(
    e.currentTarget,
    [
      ...wins.map((w) => ({ label: w.title || registry.name(appId), icon: 'window', action: () => w.focus() })),
      wins.length ? '-' : null,
      { label: registry.name(appId), icon: null, action: () => registry.launch(appId) },
      {
        label: pinned ? t('taskbar.unpin') : t('taskbar.pin'),
        icon: pinned ? 'pin_off' : 'pin',
        action: () => {
          const list = (settings.get('pinned') || []).filter((x) => x !== appId);
          if (!pinned) list.push(appId);
          settings.set('pinned', list);
        },
      },
      wins.length ? { label: wins.length > 1 ? t('taskbar.closeAll') : t('taskbar.closeWindow'), icon: 'dismiss', action: () => wins.forEach((w) => w.close()) } : null,
    ].filter(Boolean),
    { above: true },
  );
}

function clickApp(appId) {
  const wins = wm.byApp(appId);
  if (!wins.length) {
    registry.launch(appId);
    return;
  }
  if (wins.length === 1) {
    const w = wins[0];
    if (w.isFocused()) w.minimize();
    else w.focus();
    return;
  }
  // Several windows: cycle, or show a picker.
  const focused = wm.focused();
  const idx = wins.indexOf(focused);
  if (idx >= 0) wins[(idx + 1) % wins.length].focus();
  else wins.sort((a, b) => Number(b.el.style.zIndex) - Number(a.el.style.zIndex))[0].focus();
}

function renderApps() {
  const order = appOrder();
  const seen = new Set();
  for (const id of order) {
    seen.add(id);
    let b = buttons.get(id);
    if (!b) {
      b = h(
        'button',
        {
          class: 'tb-btn tb-app',
          dataset: { app: id },
          onclick: () => clickApp(id),
          oncontextmenu: (e) => appMenu(e, id),
          onpointerdown: (e) => e.currentTarget.classList.add('pressed'),
          onpointerup: (e) => e.currentTarget.classList.remove('pressed'),
          onpointerleave: (e) => e.currentTarget.classList.remove('pressed'),
        },
        h('img', { src: registry.iconUrl(id), alt: '', draggable: false }),
        h('span', { class: 'tb-ind' }),
        h('span', { class: 'tb-progress' }),
      );
      b.classList.add('entering');
      setTimeout(() => b.classList.remove('entering'), 300);
      buttons.set(id, b);
    }
    const wins = wm.byApp(id);
    const focused = wins.some((w) => w.isFocused());
    b.classList.toggle('running', wins.length > 0);
    b.classList.toggle('active', focused);
    b.classList.toggle('multi', wins.length > 1);
    b.classList.toggle('flashing', wins.some((w) => w.flashing));
    const prog = wins.map((w) => w.progress).find((p) => p != null);
    b.classList.toggle('has-progress', prog != null);
    b.querySelector('.tb-progress').style.setProperty('--p', `${(prog ?? 0) * 100}%`);
    b.dataset.tip = wins.length === 1 ? wins[0].title || registry.name(id) : registry.name(id);
    appsBox.appendChild(b);
  }
  for (const [id, b] of buttons) {
    if (!seen.has(id)) {
      buttons.delete(id);
      b.classList.add('leaving');
      setTimeout(() => b.remove(), 200);
    }
  }
}

function renderClock() {
  const now = new Date();
  const h24 = settings.get('clock24h');
  const timeOpts = { hour: 'numeric', minute: '2-digit' };
  if (h24 != null) timeOpts.hour12 = !h24;
  if (settings.get('showSeconds')) timeOpts.second = '2-digit';
  clockEl.querySelector('.tb-time').textContent = i18n.formatTime(now, timeOpts);
  clockEl.querySelector('.tb-date').textContent = i18n.formatDate(now, { day: 'numeric', month: 'numeric', year: 'numeric' });
  clockEl.dataset.tip = i18n.formatDate(now, { dateStyle: 'full' });
}

function renderStatic() {
  clear(root);
  const align = settings.get('taskbar.align') || 'center';
  root.classList.toggle('left', align === 'left');
  const tb = settings.get('taskbar') || {};
  const center = h(
    'div',
    { class: 'tb-center' },
    h(
      'button',
      { class: 'tb-btn tb-start', 'data-tip': t('taskbar.start'), onclick: () => shell.emit('start:toggle') },
      h('img', { src: 'app://shell/assets/aurora-logo.svg', alt: '', draggable: false }),
    ),
    tb.showSearch !== false ? h('button', { class: 'tb-btn tb-search', 'data-tip': t('taskbar.search'), onclick: () => shell.emit('search:toggle') }, icon('search', { size: 22 })) : null,
    tb.showTaskView !== false ? h('button', { class: 'tb-btn tb-taskview', 'data-tip': t('taskbar.taskView'), onclick: () => shell.emit('taskview:toggle') }, icon('task_list_square_ltr', { size: 22 })) : null,
    tb.showWidgets ? h('button', { class: 'tb-btn tb-widgets', 'data-tip': t('taskbar.widgets'), onclick: () => shell.emit('widgets:toggle') }, icon('board', { size: 22 })) : null,
    (appsBox = h('div', { class: 'tb-apps' })),
  );
  buttons.clear();
  trayEl = h(
    'div',
    { class: 'tb-tray' },
    h(
      'button',
      { class: 'tb-btn tb-quick', 'data-tip': t('taskbar.quickSettings'), onclick: () => shell.emit('quick:toggle') },
      h('span', { class: 'tb-net' }, icon('wifi_1', { size: 16 })),
      h('span', { class: 'tb-vol' }, icon('speaker_2', { size: 16 })),
    ),
    (clockEl = h(
      'button',
      { class: 'tb-btn tb-clock', onclick: () => shell.emit('calendar:toggle') },
      h('span', { class: 'tb-time' }),
      h('span', { class: 'tb-date' }),
      h('span', { class: 'tb-badge', hidden: true }),
    )),
    h('div', { class: 'tb-showdesk', 'data-tip': t('taskbar.showDesktop'), onclick: () => wm.toggleDesktop() }),
  );
  root.append(center, trayEl);
  renderApps();
  renderClock();
}

export const taskbar = {
  mount(el) {
    root = el;
    renderStatic();
    wm.on('change', () => renderApps());
    wm.on('open', () => renderApps());
    wm.on('close', () => renderApps());
    settings.on('pinned', renderApps);
    settings.on('taskbar', renderStatic);
    settings.on('clock24h', renderClock);
    settings.on('showSeconds', renderClock);
    i18n.on('change', renderStatic);
    setInterval(renderClock, 1000);
    notifications.on('change', () => {
      const n = notifications.unread();
      const b = clockEl.querySelector('.tb-badge');
      b.hidden = n === 0;
      b.textContent = n > 9 ? '9+' : String(n);
    });
    wm.anchorProvider = (win) => buttons.get(win.appId)?.getBoundingClientRect() || null;
  },
  anchorFor(appId) {
    return buttons.get(appId)?.getBoundingClientRect() || null;
  },
  setTrayIcon(kind, iconName) {
    const span = trayEl?.querySelector(kind === 'net' ? '.tb-net' : '.tb-vol');
    if (span) span.replaceChildren(icon(iconName, { size: 16 }));
  },
  get el() {
    return root;
  },
};
