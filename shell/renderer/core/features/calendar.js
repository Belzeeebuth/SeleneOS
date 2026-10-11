// Two panels at the right end of the bar (Selene layout, not a stacked notification center):
//   « Aujourd'hui » (click on the clock, Super+N, 'calendar:toggle' / 'calendar:open'): a landscape card with the
//     date in Manrope and the agenda of the selected day (apps/calendar/flyout.js) on the left, and a month grid
//     that keeps its size on the right (locale aware: weeks start on Monday in French; today highlighted;
//     horizontal month navigation, wheel, arrow keys). A link at the bottom opens the notifications.
//   « Notifications » (click on the bell, 'notifications:toggle' / 'notifications:open'): Concentration and
//     Ne pas déranger at the top, then one card per app (clear the app, dismiss one, Delete key), Clear all.
//     Opening it marks the notifications as read.
import { createFlyout } from '../taskbar.js';

let ctx;
let fly; // Aujourd'hui
let nfly; // Notifications
let root;
let nroot;
let notifCard;
let calCard;
let monthCol;
let viewMonth; // Date (1st of the displayed month)
let selected = null; // Date
let refocusIndex = null; // notification list position to focus after a keyboard dismiss

const STRINGS = {
  en: {
    cal: {
      notifications: 'Notifications',
      clearAll: 'Clear all',
      clearApp: 'Clear notifications from {app}',
      clearGroup: 'Clear',
      dismiss: 'Dismiss',
      empty: 'No new notifications',
      emptyHint: 'Messages from your apps will appear here.',
      dnd: 'Do not disturb',
      dndSub: 'Notifications arrive here without a banner.',
      focus: 'Focus',
      focusSub: 'Hides notifications and dims the desktop.',
      dndOnHint: 'Do not disturb is on. You’ll only see notifications here.',
      prevMonth: 'Previous month',
      nextMonth: 'Next month',
      today: 'Today',
      backToday: 'Back to today',
      title: 'Today',
      notifTitle: 'Notifications',
      week: 'Week {n}',
      openNotifs: 'Show notifications',
      notifCount_one: '{count} notification',
      notifCount_other: '{count} notifications',
      notifNone: 'No notifications',
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
      clearGroup: 'Effacer',
      dismiss: 'Ignorer',
      empty: 'Aucune nouvelle notification',
      emptyHint: 'Les messages de vos applications s’afficheront ici.',
      dnd: 'Ne pas déranger',
      dndSub: 'Les notifications arrivent ici, sans bannière.',
      focus: 'Concentration',
      focusSub: 'Masque les notifications et assombrit le bureau.',
      dndOnHint: 'Le mode Ne pas déranger est activé. Les notifications n’apparaissent qu’ici.',
      prevMonth: 'Mois précédent',
      nextMonth: 'Mois suivant',
      today: 'Aujourd’hui',
      backToday: 'Revenir à aujourd’hui',
      title: 'Aujourd’hui',
      notifTitle: 'Notifications',
      week: 'Semaine {n}',
      openNotifs: 'Afficher les notifications',
      notifCount_one: '{count} notification',
      notifCount_other: '{count} notifications',
      notifNone: 'Aucune notification',
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

function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t - y0) / 86400000 + 1) / 7);
}

function relTime(ms) {
  if (Date.now() - ms < 60000) return ctx.t('cal.justNow');
  return ctx.i18n.relativeTime(ms);
}

// ---------------------------------------------------------------- notifications panel
function switchRow({ cls, on, label, sub, iconName, onToggle }) {
  const { h, icon } = ctx;
  return h(
    'button',
    { class: ['nc-mode', cls, on && 'on'], role: 'switch', 'aria-checked': String(!!on), onclick: () => onToggle(!on) },
    h('span', { class: 'nc-mode-ico' }, icon(iconName, { size: 18, filled: !!on })),
    h('span', { class: 'nc-mode-text' }, h('span', { class: 'nc-mode-label' }, label), h('span', { class: 'nc-mode-sub' }, sub)),
    h('span', { class: 'nc-switch', 'aria-hidden': 'true' }, h('span', { class: 'nc-switch-knob' })),
  );
}

function renderNotifs() {
  const { h, t, icon, notifications, settings, shell } = ctx;
  const groups = notifications.groups();
  const dnd = !!settings.get('notifications.dnd');
  const focusOn = !!settings.get('focusMode')?.active;
  const focusBtn = switchRow({ cls: 'nc-focus', on: focusOn, label: t('cal.focus'), sub: t('cal.focusSub'), iconName: 'target', onToggle: (v) => shell.emit(v ? 'focus:start' : 'focus:stop') });
  const dndBtn = switchRow({ cls: 'nc-dnd', on: dnd, label: t('cal.dnd'), sub: t('cal.dndSub'), iconName: 'bell-slash', onToggle: (v) => settings.set('notifications.dnd', v) });
  const head = h(
    'div',
    { class: 'nc-head' },
    h('h2', { class: 'nc-title' }, t('cal.notifTitle')),
    groups.length ? h('button', { class: 'nc-clear', onclick: () => clearAll() }, t('cal.clearAll')) : null,
    h(
      'button',
      { class: 'nc-icon-btn nc-settings', 'aria-label': t('cal.notifSettings'), 'data-tip': t('cal.notifSettings'), onclick: () => (nfly.close('launch'), shell.launch('settings', { page: 'notifications' })) },
      icon('gear-six', { size: 16 }),
    ),
  );
  const modes = h('div', { class: 'nc-modes' }, focusBtn, dndBtn);
  const list = h('div', { class: 'nc-list' });
  if (!groups.length) {
    list.appendChild(h('div', { class: 'nc-empty' }, icon('bell', { size: 28 }), h('div', { class: 'nc-empty-title' }, t('cal.empty')), h('div', { class: 'nc-empty-sub' }, t('cal.emptyHint'))));
  }
  for (const g of groups) {
    const items = h('div', { class: 'nc-items' });
    for (const n of g.items) items.appendChild(notifItem(n));
    const appName = g.appName === 'system' ? t('notif.system') : g.appName;
    list.appendChild(
      h(
        'section',
        { class: 'nc-group', dataset: { app: g.appId } },
        h(
          'div',
          { class: 'nc-group-head' },
          g.icon ? h('img', { src: g.icon, alt: '', width: 20, height: 20 }) : h('span', { class: 'nc-group-ico' }, icon('bell', { size: 14 })),
          h('span', { class: 'nc-group-name ellipsis' }, appName),
          h('span', { class: 'nc-group-count' }, String(g.items.length)),
          h(
            'button',
            { class: 'nc-group-clear', 'aria-label': t('cal.clearApp', { app: appName }), onclick: () => animateOut([...items.children], () => notifications.clearApp(g.appId)) },
            t('cal.clearGroup'),
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
  const was = act ? (act.classList.contains('nc-dnd') ? 'dnd' : act.classList.contains('nc-focus') ? 'focus' : act.classList.contains('nc-clear') ? 'clear' : focusItem ? 'item' : 'other') : null;
  if (focusItem && refocusIndex == null) refocusIndex = oldItems.indexOf(focusItem);
  notifCard.replaceChildren(head, modes, list);
  list.scrollTop = prevScroll;
  if (was || refocusIndex != null) {
    const all = [...list.querySelectorAll('.nc-item')];
    let target = null;
    if (was === 'item' && focusItem) target = list.querySelector(`.nc-item[data-id="${focusItem.dataset.id}"]`);
    if (!target && refocusIndex != null && all.length) target = all[Math.min(refocusIndex, all.length - 1)];
    if (!target) target = was === 'dnd' ? dndBtn : was === 'focus' ? focusBtn : head.querySelector('.nc-clear') || focusBtn;
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
        nfly.close('launch');
        notifications.activate(n.id);
      },
      onkeydown: (e) => {
        if (e.target !== el) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          nfly.close('launch');
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
      h('div', { class: 'nc-item-title ellipsis' }, n.title),
      h('span', { class: 'nc-time' }, relTime(n.time)),
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
        icon('x', { size: 12 }),
      ),
    ),
    n.body ? h('div', { class: 'nc-body' }, n.body) : null,
    n.actions?.length
      ? h(
          'div',
          { class: 'nc-actions' },
          n.actions.map((a, i) =>
            h(
              'button',
              {
                class: ['btn', 'small', i === 0 && n.actions.length > 1 && 'primary'],
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

// Fade items out to the right, then run `done` (which triggers a re-render).
function animateOut(els, done) {
  if (reduceMotion() || !els.length) return done();
  let left = els.length;
  els.forEach((el, i) => {
    el.animate([{ transform: 'none', opacity: 1 }, { transform: 'translateX(16px)', opacity: 0 }], { duration: 150, delay: i * 20, easing: 'cubic-bezier(0.4,0,1,1)', fill: 'forwards' }).finished.then(
      () => --left === 0 && done(),
      () => --left === 0 && done(),
    );
  });
}

function clearAll() {
  animateOut([...notifCard.querySelectorAll('.nc-item')], () => ctx.notifications.clear());
}

// ---------------------------------------------------------------- Aujourd'hui panel
function weekdayLabels() {
  const { i18n } = ctx;
  const fmt = new Intl.DateTimeFormat(i18n.locale, { weekday: 'short' });
  const base = new Date(2024, 0, 7); // a Sunday
  const out = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(base);
    d.setDate(base.getDate() + ((i + firstDayOfWeek()) % 7));
    out.push(fmt.format(d).replace('.', '').slice(0, 2));
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
          'aria-selected': sameDay(d, selected || today) ? 'true' : null,
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

function notifSummary() {
  const { h, t, icon, notifications } = ctx;
  const n = notifications.list().length;
  const unread = notifications.unread();
  return h(
    'button',
    { class: ['td-notifs', unread && 'unread'], 'aria-label': `${t('cal.openNotifs')} (${n ? t('cal.notifCount', { count: n }) : t('cal.notifNone')})`, onclick: () => nfly.open() },
    icon(unread ? 'bell-ringing' : 'bell', { size: 16, filled: !!unread }),
    h('span', { class: 'grow' }, n ? t('cal.notifCount', { count: n }) : t('cal.notifNone')),
    icon('caret-right', { size: 14 }),
  );
}

function renderCalendar(slide = 0) {
  const { h, t, icon, i18n } = ctx;
  const now = new Date();
  const monthLabel = i18n.formatDate(viewMonth, { month: 'long', year: 'numeric' });
  // left: the date, the agenda of the selected day, the way to the notifications
  const showingToday = !selected || sameDay(selected, now);
  const head = h(
    'div',
    { class: 'td-head' },
    h('div', { class: 'td-weekday' }, cap(i18n.formatDate(now, { weekday: 'long' }))),
    h(
      'button',
      { class: 'cal-date td-date', 'aria-label': showingToday ? null : t('cal.backToday'), 'data-tip': showingToday ? null : t('cal.backToday'), onclick: () => goToday() },
      i18n.formatDate(now, { day: 'numeric', month: 'long' }),
    ),
    h('div', { class: 'td-week' }, `${t('cal.week', { n: isoWeek(now) })} · ${now.getFullYear()}`),
  );
  const agenda = h('div', { class: 'td-agenda' });
  const main = h('div', { class: 'td-main' }, head, agenda, notifSummary());
  // right: the month, at a fixed size
  const nav = h(
    'div',
    { class: 'cal-nav' },
    h('div', { class: 'cal-month', 'aria-live': 'polite' }, cap(monthLabel)),
    h('button', { class: 'cal-icon-btn', 'aria-label': t('cal.prevMonth'), 'data-tip': t('cal.prevMonth'), onclick: () => changeMonth(-1) }, icon('caret-left', { size: 16 })),
    h('button', { class: 'cal-icon-btn', 'aria-label': t('cal.nextMonth'), 'data-tip': t('cal.nextMonth'), onclick: () => changeMonth(1) }, icon('caret-right', { size: 16 })),
  );
  const wk = h('div', { class: 'cal-weekdays', 'aria-hidden': 'true' }, weekdayLabels().map((l) => h('span', null, l)));
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
  monthCol = h('div', { class: 'td-month' }, nav, wk, viewport);
  if (slide && !reduceMotion()) {
    viewport.firstElementChild.animate([{ transform: `translateX(${slide > 0 ? 24 : -24}px)`, opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 180, easing: 'cubic-bezier(0.2,0.8,0.2,1)' });
  }
  calCard.replaceChildren(main, monthCol);
  mountDayEvents(agenda);
}

// Events of the selected day, from the Calendar app (apps/calendar/flyout.js). Optional: loaded lazily;
// the panel works the same when the module is missing or fails.
let dayEventsMod = null;
const dayEvents = () => (dayEventsMod = dayEventsMod || import('../../apps/calendar/flyout.js').catch(() => null));
function mountDayEvents(agenda) {
  const slot = ctx.h('div', { class: 'cal-day-events' });
  agenda.appendChild(slot);
  dayEvents()
    .then((m) => m?.renderAgenda?.(slot, { ctx, date: selected || new Date(), close: () => fly?.close('launch') }))
    .catch(() => {});
}

function changeMonth(delta) {
  if (!delta) return renderCalendar();
  viewMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + delta, 1);
  const old = calCard.querySelector('.cal-grid');
  if (old && !reduceMotion()) {
    // The old month slides out sideways while the new one comes in.
    const clone = old.cloneNode(true);
    renderCalendar(delta);
    const nvp = calCard.querySelector('.cal-viewport');
    clone.classList.add('cal-grid-out');
    nvp.appendChild(clone);
    clone.animate([{ transform: 'none', opacity: 1 }, { transform: `translateX(${delta > 0 ? -24 : 24}px)`, opacity: 0 }], { duration: 150, easing: 'cubic-bezier(0.4,0,1,1)', fill: 'forwards' }).finished.then(
      () => clone.remove(),
      () => clone.remove(),
    );
  } else renderCalendar();
}

function goToday() {
  const now = new Date();
  selected = now;
  const delta = now.getMonth() - viewMonth.getMonth() + 12 * (now.getFullYear() - viewMonth.getFullYear());
  changeMonth(delta);
  calCard.querySelector('.cal-day.today')?.focus({ preventScroll: true });
}

function onGridKey(e) {
  const btn = e.target.closest('.cal-day');
  if (!btn) return;
  const [y, m, d] = btn.dataset.date.split('-').map(Number);
  const cur = new Date(y, m - 1, d);
  const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
  if (!step && e.key !== 'Enter' && e.key !== ' ' && e.key !== 'PageUp' && e.key !== 'PageDown') return;
  e.preventDefault();
  if (e.key === 'PageUp' || e.key === 'PageDown') {
    const next = new Date(cur.getFullYear(), cur.getMonth() + (e.key === 'PageDown' ? 1 : -1), 1);
    next.setDate(Math.min(cur.getDate(), new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate()));
    selected = next;
    changeMonth(e.key === 'PageDown' ? 1 : -1);
    calCard.querySelector(`.cal-day[data-date="${next.getFullYear()}-${next.getMonth() + 1}-${next.getDate()}"]`)?.focus();
    return;
  }
  if (!step) return btn.click();
  const next = new Date(cur);
  next.setDate(cur.getDate() + step);
  selected = next;
  const delta = next.getMonth() - viewMonth.getMonth() + 12 * (next.getFullYear() - viewMonth.getFullYear());
  if (delta) changeMonth(delta);
  else renderCalendar();
  calCard.querySelector(`.cal-day[data-date="${next.getFullYear()}-${next.getMonth() + 1}-${next.getDate()}"]`)?.focus();
}

// The bell sits inside the clock button (core/taskbar.js): a click on it opens the notifications instead.
function onBellClick(e) {
  const bell = e.target?.closest?.('#taskbar .tb-bell');
  if (!bell) return;
  e.stopPropagation();
  e.preventDefault();
  nfly.toggle();
}

// ---------------------------------------------------------------- mount
export function mount(c) {
  ctx = Object.create(c);
  ctx.icon = c.ui.icon;
  ctx.i18n.extend(STRINGS);
  ctx.ui.loadCss('app://shell/core/features/calendar.css');
  try {
    localStorage.removeItem('aurora.calendar.collapsed'); // the collapsible month of the old layout
  } catch {}
  const { h } = ctx;
  calCard = h('div', { class: 'cal-card td-card' });
  root = h('div', { id: 'calendar-center', class: 'cal-flyout', role: 'dialog', 'aria-label': ctx.t('cal.title') }, calCard);
  notifCard = h('div', { class: 'nc-card' });
  nroot = h('div', { id: 'notif-center', class: 'nc-flyout', role: 'dialog', 'aria-label': ctx.t('cal.notifTitle') }, notifCard);
  document.getElementById('flyouts').append(root, nroot);
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
      renderCalendar();
    },
    focus: () => root.querySelector('.cal-day.today') || root.querySelector('.cal-date'),
  });
  nfly = createFlyout({
    id: 'notifications',
    el: nroot,
    button: '#taskbar .tb-bell',
    onOpen: () => {
      renderNotifs();
      // Opening the notifications marks them as read (the badge disappears).
      setTimeout(() => nfly.isOpen && ctx.notifications.markAllRead(), 400);
    },
    onClose: (reason) => {
      // Escape gives the focus back to the clock button (the bell is not focusable on its own).
      if (reason === 'escape') setTimeout(() => document.querySelector('#taskbar .tb-clock')?.focus({ preventScroll: true }), 0);
    },
    focus: () => nroot.querySelector('.nc-item') || nroot.querySelector('.nc-focus'),
  });
  document.addEventListener('click', onBellClick, true);
  ctx.shell.on('calendar:toggle', () => fly.toggle());
  ctx.shell.on('calendar:open', () => fly.open());
  ctx.shell.on('notifications:toggle', () => nfly.toggle());
  ctx.shell.on('notifications:open', () => nfly.open());
  ctx.notifications.on('change', () => {
    if (fly.isOpen) calCard.querySelector('.td-notifs')?.replaceWith(notifSummary());
    if (!nfly.isOpen) return;
    renderNotifs();
    if (ctx.notifications.unread()) setTimeout(() => nfly.isOpen && ctx.notifications.markAllRead(), 1200);
  });
  ctx.settings.on('notifications', () => nfly.isOpen && renderNotifs());
  ctx.settings.on('focusMode', () => nfly.isOpen && renderNotifs());
  ctx.i18n.on('change', () => {
    root.setAttribute('aria-label', ctx.t('cal.title'));
    nroot.setAttribute('aria-label', ctx.t('cal.notifTitle'));
    if (fly.isOpen) renderCalendar();
    if (nfly.isOpen) renderNotifs();
  });
  // A Calendar reminder fired while the app may be closed: schedule its next occurrences (optional).
  ctx.shell.reminders?.on?.('fire', (r) => {
    if (r?.appId === 'calendar') setTimeout(() => dayEvents().then((m) => m?.resync?.(ctx)).catch(() => {}), 1000);
  });
  // ...and once after startup, so reminders dropped while the computer was off are planned again.
  setTimeout(() => dayEvents().then((m) => m?.resync?.(ctx)).catch(() => {}), 8000);
  // Refresh relative times while open.
  setInterval(() => nfly.isOpen && refreshTimes(), 30000);
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
  c.notificationCenter = {
    open: () => nfly.open(),
    close: () => nfly.close('api'),
    get isOpen() {
      return nfly.isOpen;
    },
  };
}
