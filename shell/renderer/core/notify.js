// Notifications: toasts (bottom-right, above the taskbar) + history for the notification center.
//   notify({ title, body, icon, appId, timeout = 6000, silent, onClick, actions: [{ label, onClick }] }) -> id
//   notifications.list() / notifications.clear(id?) / notifications.on('change', fn)
// Icon may be a Fluent icon name or a URL. If no icon is given, the app icon is used.
import { Emitter } from './api.js';
import { h, icon } from './ui.js';
import { i18n, t } from './i18n.js';
import { settings } from './settings.js';
import { sounds } from './sounds.js';

const emitter = new Emitter();
const history = [];
let seq = 0;
let host = null;
let iconFor = () => null;

export const notifications = {
  mount(el, appIconResolver) {
    host = el;
    if (appIconResolver) iconFor = appIconResolver;
  },
  list: () => [...history],
  unread: () => history.filter((n) => !n.read).length,
  markAllRead() {
    history.forEach((n) => (n.read = true));
    emitter.emit('change');
  },
  clear(id) {
    if (id == null) history.splice(0);
    else {
      const i = history.findIndex((n) => n.id === id);
      if (i >= 0) history.splice(i, 1);
    }
    emitter.emit('change');
  },
  on: (ev, fn) => emitter.on(ev, fn),
};

function iconNode(n) {
  const src = n.icon || iconFor(n.appId);
  if (!src) return icon('alert', { size: 20 });
  if (/^(app|media|https?|data|blob):|\//.test(src)) return h('img', { class: 'toast-img', src, alt: '' });
  return icon(src, { size: 20 });
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

  const close = () => {
    toast.classList.add('leaving');
    setTimeout(() => toast.remove(), 260);
  };
  const toast = h(
    'div',
    {
      class: 'toast',
      role: 'status',
      onclick: (e) => {
        if (e.target.closest('button')) return;
        n.read = true;
        emitter.emit('change');
        n.onClick?.();
        close();
      },
    },
    h(
      'div',
      { class: 'toast-head caption' },
      iconNode(n),
      h('span', { class: 'grow ellipsis' }, n.appName || n.appId),
      h('button', { class: 'btn subtle icon-btn small toast-x', 'aria-label': t('common.close'), onclick: close }, icon('dismiss', { size: 12 })),
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
                  a.onClick?.();
                  close();
                },
              },
              a.label,
            ),
          ),
        )
      : null,
  );
  host.appendChild(toast);
  const timeout = opts.timeout ?? 6000;
  if (timeout > 0) {
    let timer = setTimeout(close, timeout);
    toast.addEventListener('mouseenter', () => clearTimeout(timer));
    toast.addEventListener('mouseleave', () => (timer = setTimeout(close, 2500)));
  }
  return n.id;
}

export { i18n };
