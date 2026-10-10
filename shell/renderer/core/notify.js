// Notifications: toasts (bottom-right, above the taskbar) + history for the notification center.
//   notify({ title, body, icon, appId, appName, timeout = 6000, silent, onClick, actions: [{ label, onClick }] }) -> id
//   notifications.list() / notifications.unread() / notifications.markAllRead()
//   notifications.dismiss(id) / notifications.clear(id?) / notifications.clearApp(appId)
//   notifications.groups() -> [{ appId, appName, icon, items: [...] }]  (newest first)
//   notifications.activate(id)  -> runs the notification's onClick and removes it
//   notifications.on('change', fn)
// Icon may be a Fluent icon name or a URL. If no icon is given, the app icon is used.
// Do not disturb (settings.notifications.dnd) and notifications.enabled === false keep history but
// suppress toasts and sounds.
import { Emitter } from './api.js';
import { h, icon } from './ui.js';
import { i18n, t } from './i18n.js';
import { settings } from './settings.js';
import { sounds } from './sounds.js';

const emitter = new Emitter();
const history = [];
const toasts = new Map(); // id -> close()
let seq = 0;
let host = null;
let iconFor = () => null;
let nameFor = (appId) => appId;

const MAX_TOASTS = 3;

export const notifications = {
  mount(el, appIconResolver, appNameResolver) {
    host = el;
    if (appIconResolver) iconFor = appIconResolver;
    if (appNameResolver) nameFor = appNameResolver;
  },
  /** Optional: resolve app ids to display names (the boot passes only the icon resolver). */
  setNameResolver(fn) {
    if (typeof fn === 'function') nameFor = fn;
  },
  list: () => [...history],
  unread: () => history.filter((n) => !n.read).length,
  markAllRead() {
    if (!history.some((n) => !n.read)) return;
    history.forEach((n) => (n.read = true));
    emitter.emit('change');
  },
  dismiss(id) {
    const i = history.findIndex((n) => n.id === id);
    if (i >= 0) history.splice(i, 1);
    toasts.get(id)?.();
    emitter.emit('change');
  },
  clear(id) {
    if (id == null) {
      history.splice(0);
      for (const close of [...toasts.values()]) close();
    } else return notifications.dismiss(id);
    emitter.emit('change');
  },
  clearApp(appId) {
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].appId === appId) {
        toasts.get(history[i].id)?.();
        history.splice(i, 1);
      }
    }
    emitter.emit('change');
  },
  activate(id) {
    const n = history.find((x) => x.id === id);
    if (!n) return;
    try {
      n.onClick?.();
    } catch (err) {
      console.error('[notify] onClick failed', err);
    }
    notifications.dismiss(id);
  },
  groups() {
    const map = new Map();
    for (const n of history) {
      if (!map.has(n.appId)) map.set(n.appId, { appId: n.appId, appName: n.appName || nameFor(n.appId) || n.appId, icon: iconFor(n.appId), items: [] });
      map.get(n.appId).items.push(n);
    }
    return [...map.values()];
  },
  appName: (n) => n.appName || nameFor(n.appId) || n.appId,
  iconNode: (n, size) => iconNode(n, size),
  on: (ev, fn) => emitter.on(ev, fn),
};

function iconNode(n, size = 16) {
  const src = n.icon || iconFor(n.appId);
  if (!src) return icon('alert', { size });
  if (/^(app|media|https?|data|blob):|\//.test(src)) return h('img', { class: 'toast-img', src, alt: '', width: size, height: size });
  return icon(src, { size });
}

export function notify(opts = {}) {
  const n = {
    id: ++seq,
    title: opts.title || '',
    body: opts.body || '',
    icon: opts.icon,
    appId: opts.appId || 'system',
    appName: opts.appName,
    time: Date.now(),
    read: false,
    actions: opts.actions || [],
    onClick: opts.onClick,
  };
  history.unshift(n);
  if (history.length > 100) history.pop();
  emitter.emit('change');
  const prefs = settings.get('notifications') || {};
  if (prefs.enabled === false || prefs.dnd) return n.id;
  if (!opts.silent && prefs.sounds !== false) sounds.play('notify');
  if (!host) return n.id;

  let closed = false;
  let timer = null;
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    toasts.delete(n.id);
    toast.classList.add('leaving');
    setTimeout(() => toast.remove(), 260);
  };
  const toast = h(
    'div',
    {
      class: 'toast',
      role: 'status',
      'aria-live': 'polite',
      dataset: { id: String(n.id) },
      onclick: (e) => {
        if (e.target.closest('button')) return;
        close();
        notifications.activate(n.id);
      },
    },
    h(
      'div',
      { class: 'toast-head caption' },
      iconNode(n),
      h('span', { class: 'grow ellipsis' }, notifications.appName(n)),
      h(
        'button',
        {
          class: 'btn subtle icon-btn small toast-x',
          'aria-label': t('common.close'),
          onclick: () => {
            n.read = true;
            emitter.emit('change');
            close();
          },
        },
        icon('dismiss', { size: 12 }),
      ),
    ),
    h('div', { class: 'toast-title body-strong' }, n.title),
    n.body ? h('div', { class: 'toast-body' }, n.body) : null,
    n.actions.length
      ? h(
          'div',
          { class: 'toast-actions' },
          n.actions.map((a) =>
            h(
              'button',
              {
                class: 'btn',
                onclick: () => {
                  try {
                    a.onClick?.();
                  } catch (err) {
                    console.error(err);
                  }
                  close();
                  notifications.dismiss(n.id);
                },
              },
              a.label,
            ),
          ),
        )
      : null,
  );
  toasts.set(n.id, close);
  host.appendChild(toast);
  // Never stack more than a few toasts: the oldest go to the notification center.
  const live = [...host.querySelectorAll('.toast:not(.leaving)')];
  for (const old of live.slice(0, Math.max(0, live.length - MAX_TOASTS))) toasts.get(Number(old.dataset.id))?.();
  const timeout = opts.timeout ?? 6000;
  if (timeout > 0) {
    timer = setTimeout(close, timeout);
    toast.addEventListener('mouseenter', () => clearTimeout(timer));
    toast.addEventListener('mouseleave', () => (timer = setTimeout(close, 2500)));
  }
  return n.id;
}

// Hide toasts as soon as Do not disturb turns on.
settings.on('notifications', (v) => {
  if (v?.dnd) for (const close of [...toasts.values()]) close();
});

export { i18n };
