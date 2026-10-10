// Notification center + calendar flyout (Win+N / click on the taskbar clock), Windows 11 style.
//   Top card: notifications grouped by app (dismiss one, clear an app, Clear all), Do not disturb
//   toggle, empty state. Bottom card: full date header, collapsible month view (locale aware: weeks
//   start on Monday in French), today highlighted, month navigation with a vertical slide.
//   Opening marks notifications as read. Opens on shell 'calendar:toggle' / 'calendar:open'.
import { createFlyout } from '../taskbar.js';

let ctx;
let fly;
let root;
let notifCard;
let calCard;
let viewMonth; // Date (1st of the displayed month)
let selected = null; // Date
let collapsed = false;
let refocusIndex = null; // notification list position to focus after a keyboard dismiss

const STRINGS = {
  en: {
    cal: {
      notifications: 'Notifications',
      clearAll: 'Clear all',
      clearApp: 'Clear notifications from {app}',
      dismiss: 'Dismiss',
      empty: 'No new notifications',
      dnd: 'Do not disturb',
      dndOnHint: 'Do not disturb is on. You’ll only see notifications here.',
      prevMonth: 'Previous month',
      nextMonth: 'Next month',
      collapse: 'Collapse calendar',
      expand: 'Expand calendar',
      today: 'Today',
      title: 'Notification center and calendar',
      week: 'Week {n}',
      notifSettings: 'Notification settings',
      justNow: 'Just now',
    },
    notif: { system: 'System' },
  },
  fr: {
    cal: {
      notifications: 'Notifications',
      clearAll: 'Tout effacer',
      clearApp: 'Effacer les notifications de {app}',
      dismiss: 'Ignorer',
      empty: 'Aucune nouvelle notification',
      dnd: 'Ne pas déranger',
      dndOnHint: 'Le mode Ne pas déranger est activé. Les notifications n’apparaissent qu’ici.',
      prevMonth: 'Mois précédent',
      nextMonth: 'Mois suivant',
      collapse: 'Réduire le calendrier',
      expand: 'Développer le calendrier',
      today: 'Aujourd’hui',
      title: 'Centre de notifications et calendrier',
      week: 'Semaine {n}',
      notifSettings: 'Paramètres de notification',
      justNow: 'À l’instant',
    },
    notif: { system: 'Système' },
  },
};

const reduceMotion = () => document.documentElement.dataset.animations === 'off';
const sameDay = (a, b) => a && b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const firstDayOfWeek = () => (ctx.i18n.lang === 'fr' ? 1 : 0);
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

function relTime(ms) {
  if (Date.now() - ms < 60000) return ctx.t('cal.justNow');
  return ctx.i18n.relativeTime(ms);
}

// ---------------------------------------------------------------- notifications card
function renderNotifs() {
  const { h, t, icon, notifications, settings } = ctx;
  const groups = notifications.groups();
  const dnd = !!settings.get('notifications.dnd');
  const dndBtn = h(
    'button',
    {
      class: ['nc-dnd', dnd && 'on'],
      'aria-pressed': String(dnd),
      'aria-label': t('cal.dnd'),
      'data-tip': t('cal.dnd'),
      onclick: () => settings.set('notifications.dnd', !dnd),
    },
    icon(dnd ? 'alert_snooze' : 'alert', { size: 16, filled: dnd }),
  );
  const head = h(
    'div',
    { class: 'nc-head' },
    h('div', { class: 'nc-title' }, t('cal.notifications')),
    groups.length ? h('button', { class: 'btn small nc-clear', onclick: () => clearAll() }, t('cal.clearAll')) : null,
    dndBtn,
  );
  const list = h('div', { class: 'nc-list' });
  if (dnd) list.appendChild(h('div', { class: 'nc-hint caption' }, icon('alert_snooze', { size: 14 }), h('span', null, t('cal.dndOnHint'))));
  if (!groups.length) {
    list.appendChild(h('div', { class: 'nc-empty' }, t('cal.empty')));
  }
  for (const g of groups) {
    const items = h('div', { class: 'nc-items' });
    for (const n of g.items) items.appendChild(notifItem(n));
    list.appendChild(
      h(
        'section',
        { class: 'nc-group', dataset: { app: g.appId } },
        h(
          'div',
          { class: 'nc-group-head caption' },
          g.icon ? h('img', { src: g.icon, alt: '', width: 16, height: 16 }) : icon('alert', { size: 16 }),
          h('span', { class: 'grow ellipsis' }, g.appName === 'system' ? t('notif.system') : g.appName),
          h(
            'button',
            { class: 'nc-x', 'aria-label': t('cal.clearApp', { app: g.appName }), 'data-tip': t('cal.clearApp', { app: g.appName }), onclick: () => animateOut([...items.children], () => notifications.clearApp(g.appId)) },
            icon('dismiss', { size: 12 }),
          ),
        ),
        items,
      ),
    );
  }
  const prevScroll = notifCard.querySelector('.nc-list')?.scrollTop || 0;
  // Remember what had keyboard focus so a re-render never drops it on the floor.
  const act = notifCard.contains(document.activeElement) ? document.activeElement : null;
  const oldItems = [...notifCard.querySelectorAll('.nc-item')];
  const focusItem = act?.closest('.nc-item');
  const was = act ? (act.classList.contains('nc-dnd') ? 'dnd' : act.classList.contains('nc-clear') ? 'clear' : focusItem ? 'item' : 'other') : null;
  if (focusItem && refocusIndex == null) refocusIndex = oldItems.indexOf(focusItem);
  notifCard.replaceChildren(head, list);
  list.scrollTop = prevScroll;
  if (was || refocusIndex != null) {
    const items = [...list.querySelectorAll('.nc-item')];
    let target = null;
    if (was === 'item' && focusItem) target = list.querySelector(`.nc-item[data-id="${focusItem.dataset.id}"]`);
    if (!target && refocusIndex != null && items.length) target = items[Math.min(refocusIndex, items.length - 1)];
    if (!target) target = was === 'dnd' ? dndBtn : head.querySelector('.nc-clear') || dndBtn;
    target.focus({ preventScroll: true });
    refocusIndex = null;
  }
}

// Relative times ("5 min ago") are refreshed in place, so a re-render never steals focus or hover.
function refreshTimes() {
  const byId = new Map(ctx.notifications.list().map((n) => [String(n.id), n]));
  for (const el of notifCard.querySelectorAll('.nc-item')) {
    const n = byId.get(el.dataset.id);
    const time = el.querySelector('.nc-time');
    if (n && time) time.textContent = relTime(n.time);
  }
}

function notifItem(n) {
  const { h, t, icon, notifications } = ctx;
  const el = h(
    'div',
    {
      class: 'nc-item',
      tabindex: '0',
      role: 'button',
      dataset: { id: String(n.id) },
      onclick: (e) => {
        if (e.target.closest('button')) return;
        fly.close('launch');
        notifications.activate(n.id);
      },
      onkeydown: (e) => {
        if (e.target !== el) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          fly.close('launch');
          notifications.activate(n.id);
        } else if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault();
          refocusIndex = [...notifCard.querySelectorAll('.nc-item')].indexOf(el);
          animateOut([el], () => notifications.dismiss(n.id));
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const all = [...notifCard.querySelectorAll('.nc-item')];
          all[all.indexOf(el) + (e.key === 'ArrowDown' ? 1 : -1)]?.focus();
        }
      },
    },
    h(
      'div',
      { class: 'nc-item-top' },
      h('div', { class: 'nc-item-title body-strong ellipsis' }, n.title),
      h('span', { class: 'nc-time caption' }, relTime(n.time)),
      h(
        'button',
        {
          class: 'nc-x nc-item-x',
          'aria-label': t('cal.dismiss'),
          'data-tip': t('cal.dismiss'),
          onclick: (e) => {
            if (e.detail === 0) refocusIndex = [...notifCard.querySelectorAll('.nc-item')].indexOf(el); // keyboard activation
            animateOut([el], () => notifications.dismiss(n.id));
          },
        },
        icon('dismiss', { size: 12 }),
      ),
    ),
    n.body ? h('div', { class: 'nc-body' }, n.body) : null,
    n.actions?.length
      ? h(
          'div',
          { class: 'nc-actions' },
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
                  notifications.dismiss(n.id);
                },
              },
              a.label,
            ),
          ),
        )
      : null,
  );
  return el;
}

// Slide items out to the right, then run `done` (which triggers a re-render).
function animateOut(els, done) {
  if (reduceMotion() || !els.length) return done();
  let left = els.length;
  els.forEach((el, i) => {
    el.animate([{ transform: 'none', opacity: 1 }, { transform: 'translateX(110%)', opacity: 0 }], { duration: 220, delay: i * 30, easing: 'cubic-bezier(0.7,0,1,0.5)', fill: 'forwards' }).finished.then(() => --left === 0 && done(), () => --left === 0 && done());
  });
}

function clearAll() {
  animateOut([...notifCard.querySelectorAll('.nc-item')], () => ctx.notifications.clear());
}

// ---------------------------------------------------------------- calendar card
function weekdayLabels() {
  const { i18n } = ctx;
  const fmt = new Intl.DateTimeFormat(i18n.locale, { weekday: 'short' });
  const base = new Date(2024, 0, 7); // a Sunday
  const out = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(base);
    d.setDate(base.getDate() + ((i + firstDayOfWeek()) % 7));
    const s = fmt.format(d).replace('.', '');
    out.push(i18n.lang === 'fr' ? s.slice(0, 2) : s.slice(0, 2));
  }
  return out;
}

function monthGrid(month) {
  const { h, i18n } = ctx;
  const today = new Date();
  const start = new Date(month.getFullYear(), month.getMonth(), 1);
  const offset = (start.getDay() - firstDayOfWeek() + 7) % 7;
  const first = new Date(start);
  first.setDate(1 - offset);
  const grid = h('div', { class: 'cal-grid', role: 'grid' });
  const dayFmt = new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'full' });
  for (let i = 0; i < 42; i++) {
    const d = new Date(first);
    d.setDate(first.getDate() + i);
    const other = d.getMonth() !== month.getMonth();
    grid.appendChild(
      h(
        'button',
        {
          class: ['cal-day', other && 'other', sameDay(d, today) && 'today', sameDay(d, selected) && 'selected'],
          role: 'gridcell',
          tabindex: sameDay(d, selected || today) && !other ? '0' : '-1',
          'aria-label': dayFmt.format(d),
          'aria-current': sameDay(d, today) ? 'date' : null,
          dataset: { date: `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}` },
          onclick: () => {
            selected = d;
            if (other) changeMonth(d.getMonth() - month.getMonth() + 12 * (d.getFullYear() - month.getFullYear()));
            else renderCalendar();
          },
        },
        h('span', null, String(d.getDate())),
      ),
    );
  }
  return grid;
}

function renderCalendar(slide = 0) {
  const { h, t, icon, i18n } = ctx;
  const now = new Date();
  const headDate = cap(i18n.formatDate(now, { weekday: 'long', month: 'long', day: 'numeric' }));
  const monthLabel = i18n.formatDate(viewMonth, { month: 'long', year: 'numeric' });
  const head = h(
    'div',
    { class: 'cal-head' },
    h('button', { class: 'cal-date', onclick: () => goToday() }, headDate),
    h(
      'button',
      {
        class: 'cal-icon-btn cal-collapse',
        'aria-label': collapsed ? t('cal.expand') : t('cal.collapse'),
        'aria-expanded': String(!collapsed),
        'data-tip': collapsed ? t('cal.expand') : t('cal.collapse'),
        onclick: () => toggleCollapsed(),
      },
      icon(collapsed ? 'chevron_up' : 'chevron_down', { size: 14 }),
    ),
  );
  const body = h('div', { class: 'cal-body' });
  if (!collapsed) {
    const nav = h(
      'div',
      { class: 'cal-nav' },
      h('div', { class: 'cal-month', 'aria-live': 'polite' }, cap(monthLabel)),
      h('button', { class: 'cal-icon-btn', 'aria-label': t('cal.prevMonth'), 'data-tip': t('cal.prevMonth'), onclick: () => changeMonth(-1) }, icon('arrow_up', { size: 14, filled: true })),
      h('button', { class: 'cal-icon-btn', 'aria-label': t('cal.nextMonth'), 'data-tip': t('cal.nextMonth'), onclick: () => changeMonth(1) }, icon('arrow_down', { size: 14, filled: true })),
    );
    const wk = h('div', { class: 'cal-weekdays' }, weekdayLabels().map((l) => h('span', null, l)));
    const viewport = h('div', { class: 'cal-viewport' }, monthGrid(viewMonth));
    viewport.addEventListener(
      'wheel',
      (e) => {
        if (Math.abs(e.deltaY) < 4) return;
        e.preventDefault();
        if (viewport._lock) return;
        viewport._lock = true;
        setTimeout(() => (viewport._lock = false), 280);
        changeMonth(e.deltaY > 0 ? 1 : -1);
      },
      { passive: false },
    );
    viewport.addEventListener('keydown', onGridKey);
    body.append(nav, wk, viewport);
    mountDayEvents(body);
    if (slide && !reduceMotion()) {
      viewport.firstElementChild.animate([{ transform: `translateY(${slide > 0 ? 36 : -36}px)`, opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 280, easing: 'cubic-bezier(0.1,0.9,0.2,1)' });
    }
  }
  calCard.classList.toggle('collapsed', collapsed);
  calCard.replaceChildren(head, body);
}

// Events of the selected day, from the Calendar app (apps/calendar/flyout.js). Optional: loaded lazily;
// the flyout works the same when the module is missing or fails.
let dayEventsMod = null;
const dayEvents = () => (dayEventsMod = dayEventsMod || import('../../apps/calendar/flyout.js').catch(() => null));
function mountDayEvents(body) {
  const slot = ctx.h('div', { class: 'cal-day-events' });
  body.appendChild(slot);
  dayEvents()
    .then((m) => m?.renderAgenda?.(slot, { ctx, date: selected || new Date(), close: () => fly?.close('launch') }))
    .catch(() => {});
}

function changeMonth(delta) {
  if (!delta) return renderCalendar();
  viewMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + delta, 1);
  const old = calCard.querySelector('.cal-grid');
  if (old && !reduceMotion()) {
    // Old month slides out while the new one slides in (Windows 11 calendar).
    const vp = old.parentElement;
    const clone = old.cloneNode(true);
    renderCalendar(delta);
    const nvp = calCard.querySelector('.cal-viewport');
    clone.classList.add('cal-grid-out');
    nvp.appendChild(clone);
    clone.animate([{ transform: 'none', opacity: 1 }, { transform: `translateY(${delta > 0 ? -36 : 36}px)`, opacity: 0 }], { duration: 180, easing: 'cubic-bezier(0.7,0,1,0.5)', fill: 'forwards' }).finished.then(
      () => clone.remove(),
      () => clone.remove(),
    );
    void vp;
  } else renderCalendar();
}

function goToday() {
  const now = new Date();
  selected = now;
  const delta = now.getMonth() - viewMonth.getMonth() + 12 * (now.getFullYear() - viewMonth.getFullYear());
  if (collapsed) toggleCollapsed();
  else changeMonth(delta);
}

function onGridKey(e) {
  const btn = e.target.closest('.cal-day');
  if (!btn) return;
  const [y, m, d] = btn.dataset.date.split('-').map(Number);
  const cur = new Date(y, m - 1, d);
  const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
  if (!step && e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault();
  if (!step) return btn.click();
  const next = new Date(cur);
  next.setDate(cur.getDate() + step);
  selected = next;
  const delta = next.getMonth() - viewMonth.getMonth() + 12 * (next.getFullYear() - viewMonth.getFullYear());
  if (delta) changeMonth(delta);
  else renderCalendar();
  calCard.querySelector(`.cal-day[data-date="${next.getFullYear()}-${next.getMonth() + 1}-${next.getDate()}"]`)?.focus();
}

function toggleCollapsed() {
  collapsed = !collapsed;
  try {
    localStorage.setItem('aurora.calendar.collapsed', collapsed ? '1' : '0');
  } catch {}
  const h0 = calCard.offsetHeight;
  renderCalendar();
  if (!reduceMotion()) {
    const h1 = calCard.offsetHeight;
    calCard.animate([{ height: `${h0}px` }, { height: `${h1}px` }], { duration: 260, easing: 'cubic-bezier(0.1,0.9,0.2,1)' });
  }
  calCard.querySelector('.cal-collapse')?.focus({ preventScroll: true });
}

// ---------------------------------------------------------------- mount
export function mount(c) {
  ctx = Object.create(c);
  ctx.icon = c.ui.icon;
  ctx.i18n.extend(STRINGS);
  ctx.ui.loadCss('app://shell/core/features/calendar.css');
  try {
    collapsed = localStorage.getItem('aurora.calendar.collapsed') === '1';
  } catch {}
  const { h } = ctx;
  notifCard = h('div', { class: 'nc-card' });
  calCard = h('div', { class: 'cal-card' });
  root = h('div', { id: 'calendar-center', class: 'cal-flyout', role: 'dialog', 'aria-label': ctx.t('cal.title') }, notifCard, calCard);
  document.getElementById('flyouts').appendChild(root);
  const now = new Date();
  viewMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  fly = createFlyout({
    id: 'calendar',
    el: root,
    button: '.tb-clock',
    onOpen: () => {
      const n = new Date();
      viewMonth = new Date(n.getFullYear(), n.getMonth(), 1);
      selected = null;
      renderNotifs();
      renderCalendar();
      // Opening the center marks everything as read (badge disappears).
      setTimeout(() => fly.isOpen && ctx.notifications.markAllRead(), 400);
    },
    focus: () => root.querySelector('.cal-day.today') || root.querySelector('.cal-date'),
  });
  ctx.shell.on('calendar:toggle', () => fly.toggle());
  ctx.shell.on('calendar:open', () => fly.open());
  ctx.notifications.on('change', () => {
    if (!fly.isOpen) return;
    renderNotifs();
    if (ctx.notifications.unread()) setTimeout(() => fly.isOpen && ctx.notifications.markAllRead(), 1200);
  });
  ctx.settings.on('notifications', () => fly.isOpen && renderNotifs());
  ctx.i18n.on('change', () => {
    root.setAttribute('aria-label', ctx.t('cal.title'));
    if (fly.isOpen) (renderNotifs(), renderCalendar());
  });
  // A Calendar reminder fired while the app may be closed: schedule its next occurrences (optional).
  ctx.shell.reminders?.on?.('fire', (r) => {
    if (r?.appId === 'calendar') setTimeout(() => dayEvents().then((m) => m?.resync?.(ctx)).catch(() => {}), 1000);
  });
  // Refresh relative times while open.
  setInterval(() => fly.isOpen && refreshTimes(), 30000);
  renderNotifs();
  renderCalendar();
  c.calendar = {
    open: () => fly.open(),
    close: () => fly.close('api'),
    changeMonth,
    get isOpen() {
      return fly.isOpen;
    },
  };
}
