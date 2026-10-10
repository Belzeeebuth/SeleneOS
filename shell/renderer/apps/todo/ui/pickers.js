// Flyouts and dialogs: popover host, calendar date picker, date + time picker, custom repeat dialog,
// list theme picker, emoji picker and the keyboard shortcuts sheet.
import * as D from '../lib/dates.js';
import { COLORS, BACKGROUNDS } from '../lib/store.js';
import { EASE, reduceMotion } from './anim.js';

// ------------------------------------------------------------------ popover
let openPop = null;
export const popoverOpen = () => !!openPop;

/** A flyout inside the app (so it keeps the window's theme), anchored under (or above) `anchor`. */
export function popover(app, anchor, content, { className = '', onClose, width, focus = true } = {}) {
  openPop?.close(null);
  const { h } = app;
  const el = h('div', { class: ['td-pop', className], role: 'dialog', tabindex: '-1' }, content);
  if (width) el.style.width = `${width}px`;
  el.style.visibility = 'hidden';
  app.root.appendChild(el);
  const host = app.root.getBoundingClientRect();
  const a = anchor.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  let x = a.left - host.left;
  let y = a.bottom - host.top + 4;
  let up = false;
  if (y + r.height > host.height - 8 && a.top - host.top - r.height - 4 > 8) {
    y = a.top - host.top - r.height - 4;
    up = true;
  }
  x = Math.max(8, Math.min(host.width - r.width - 8, x));
  y = Math.max(8, Math.min(host.height - r.height - 8, y));
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.style.visibility = '';
  if (!reduceMotion()) el.animate([{ opacity: 0, transform: `translateY(${up ? 10 : -10}px)` }, { opacity: 1, transform: 'none' }], { duration: 200, easing: EASE });
  let resolveFn;
  const done = new Promise((res) => (resolveFn = res));
  const outside = (e) => {
    if (!el.contains(e.target) && !e.target.closest?.('.menu')) handle.close(null);
  };
  const keys = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      handle.close(null);
    }
  };
  const handle = {
    el,
    done,
    closed: false,
    close(v) {
      if (handle.closed) return;
      handle.closed = true;
      if (openPop === handle) openPop = null;
      document.removeEventListener('pointerdown', outside, true);
      el.removeEventListener('keydown', keys);
      if (reduceMotion()) el.remove();
      else el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 100 }).finished.then(() => el.remove(), () => el.remove());
      onClose?.(v);
      resolveFn(v);
      if (anchor.isConnected && app.root.contains(document.activeElement) === false) anchor.focus?.({ preventScroll: true });
      else if (anchor.isConnected && (!document.activeElement || document.activeElement === document.body || el.contains(document.activeElement))) anchor.focus?.({ preventScroll: true });
    },
  };
  setTimeout(() => !handle.closed && document.addEventListener('pointerdown', outside, true));
  el.addEventListener('keydown', keys);
  openPop = handle;
  if (focus) setTimeout(() => (el.querySelector('[autofocus], .selected, button, input') || el).focus({ preventScroll: true }), 20);
  return handle;
}

export function closePopover() {
  openPop?.close(null);
}

// ------------------------------------------------------------------ calendar grid
function calendar(app, { value, onPick, onCommit }) {
  const { h, icon, t } = app;
  const today = app.today();
  const sel = D.isYmd(value) ? value : null;
  let cur = D.parseYmd(sel || today);
  let focusDay = sel || today;
  let picked = sel;
  const title = h('div', { class: 'td-cal-title' });
  const grid = h('div', { class: 'td-cal-grid', role: 'grid' });
  const names = app.fmt.weekdayNames('narrow');
  const ws = app.weekStart;
  const head = h('div', { class: 'td-cal-head' }, Array.from({ length: 7 }, (_, i) => h('span', null, names[(ws + i) % 7])));
  const render = () => {
    title.textContent = new Intl.DateTimeFormat(app.i18n.locale, { month: 'long', year: 'numeric' }).format(cur);
    app.ui.clear(grid);
    const days = D.monthGrid(cur.getFullYear(), cur.getMonth(), ws);
    for (const d of days) {
      const dt = D.parseYmd(d);
      const b = h(
        'button',
        {
          type: 'button',
          class: ['td-cal-day', dt.getMonth() !== cur.getMonth() && 'other', d === today && 'today', d === picked && 'selected'],
          tabindex: d === focusDay ? '0' : '-1',
          dataset: { day: d },
          'aria-label': app.fmt.date(d, { weekday: 'long', month: 'long', withYear: true }),
          'aria-pressed': String(d === picked),
          onclick: () => {
            picked = d;
            focusDay = d;
            onPick?.(d);
            render();
            grid.querySelector(`[data-day="${d}"]`)?.focus();
          },
          ondblclick: () => onCommit?.(d),
        },
        String(dt.getDate()),
      );
      grid.appendChild(b);
    }
  };
  const shift = (n) => {
    cur = new Date(cur.getFullYear(), cur.getMonth() + n, 1);
    render();
  };
  grid.addEventListener('keydown', (e) => {
    const steps = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (e.key in steps || e.key === 'PageUp' || e.key === 'PageDown') {
      e.preventDefault();
      focusDay = e.key in steps ? D.addDays(focusDay, steps[e.key]) : D.addMonths(focusDay, e.key === 'PageUp' ? -1 : 1);
      const f = D.parseYmd(focusDay);
      if (f.getMonth() !== cur.getMonth() || f.getFullYear() !== cur.getFullYear()) cur = new Date(f.getFullYear(), f.getMonth(), 1);
      render();
      grid.querySelector(`[data-day="${focusDay}"]`)?.focus();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const d = e.target.dataset?.day;
      if (d) {
        picked = d;
        onPick?.(d);
        onCommit?.(d);
      }
    }
  });
  render();
  const el = h(
    'div',
    { class: 'td-cal' },
    h(
      'div',
      { class: 'td-cal-bar' },
      title,
      h('button', { type: 'button', class: 'btn subtle icon-btn', 'aria-label': t('picker.prevMonth'), 'data-tip': t('picker.prevMonth'), onclick: () => shift(-1) }, icon('chevron_up')),
      h('button', { type: 'button', class: 'btn subtle icon-btn', 'aria-label': t('picker.nextMonth'), 'data-tip': t('picker.nextMonth'), onclick: () => shift(1) }, icon('chevron_down')),
    ),
    head,
    grid,
  );
  el.get = () => picked;
  return el;
}

/** Calendar flyout -> 'YYYY-MM-DD' | null */
export function pickDate(app, anchor, { value, title } = {}) {
  const { h, t } = app;
  let chosen = D.isYmd(value) ? value : null;
  let pop;
  const save = h('button', { type: 'button', class: 'btn primary td-pop-save', disabled: !chosen, onclick: () => pop.close(chosen) }, t('common.save'));
  const cal = calendar(app, {
    value,
    onPick: (d) => {
      chosen = d;
      save.disabled = false;
    },
    onCommit: (d) => pop.close(d),
  });
  pop = popover(
    app,
    anchor,
    h('div', { class: 'td-picker' }, title ? h('div', { class: 'td-pop-title' }, title) : null, cal, h('div', { class: 'td-pop-foot' }, save, h('button', { type: 'button', class: 'btn', onclick: () => pop.close(null) }, t('common.cancel')))),
    { className: 'td-pop-date' },
  );
  return pop.done;
}

/** Calendar + time flyout -> epoch ms | null */
export function pickDateTime(app, anchor, { value, title } = {}) {
  const { h, t } = app;
  const now = app.now();
  const init = Number.isFinite(value) ? value : D.defaultReminderOn(D.ymd(now), now);
  let day = D.ymd(init);
  const d0 = new Date(init);
  const h12 = app.h12;
  const hours = h12 ? Array.from({ length: 12 }, (_, i) => (i === 0 ? 12 : i)) : Array.from({ length: 24 }, (_, i) => i);
  const hourSel = h(
    'select',
    { class: 'select td-time-h', 'aria-label': t('picker.hour') },
    hours.map((x) => h('option', { value: String(x) }, h12 ? String(x) : String(x).padStart(2, '0'))),
  );
  const minSel = h(
    'select',
    { class: 'select td-time-m', 'aria-label': t('picker.minute') },
    Array.from({ length: 12 }, (_, i) => h('option', { value: String(i * 5) }, String(i * 5).padStart(2, '0'))),
  );
  const ampm = h12
    ? h('select', { class: 'select td-time-ap', 'aria-label': t('picker.ampm') }, h('option', { value: 'am' }, t('picker.am')), h('option', { value: 'pm' }, t('picker.pm')))
    : null;
  const H = d0.getHours();
  hourSel.value = String(h12 ? H % 12 || 12 : H);
  const mins = d0.getMinutes();
  if (mins % 5) minSel.appendChild(h('option', { value: String(mins) }, String(mins).padStart(2, '0')));
  minSel.value = String(mins);
  if (ampm) ampm.value = H >= 12 ? 'pm' : 'am';
  const value24 = () => {
    let hh = Number(hourSel.value);
    if (h12) hh = (hh % 12) + (ampm.value === 'pm' ? 12 : 0);
    const d = D.parseYmd(day);
    d.setHours(hh, Number(minSel.value), 0, 0);
    return d.getTime();
  };
  const err = h('div', { class: 'td-pop-err caption', role: 'alert' });
  let pop;
  const commit = () => {
    const v = value24();
    if (v <= app.now()) {
      err.textContent = t('picker.inPast');
      return;
    }
    pop.close(v);
  };
  const cal = calendar(app, { value: day, onPick: (d) => ((day = d), (err.textContent = '')), onCommit: (d) => ((day = d), commit()) });
  pop = popover(
    app,
    anchor,
    h(
      'div',
      { class: 'td-picker' },
      title ? h('div', { class: 'td-pop-title' }, title) : null,
      cal,
      h('div', { class: 'td-time' }, app.icon('clock'), hourSel, h('span', { class: 'td-time-sep' }, ':'), minSel, ampm),
      err,
      h('div', { class: 'td-pop-foot' }, h('button', { type: 'button', class: 'btn primary td-pop-save', onclick: commit }, t('common.save')), h('button', { type: 'button', class: 'btn', onclick: () => pop.close(null) }, t('common.cancel'))),
    ),
    { className: 'td-pop-date' },
  );
  for (const s of [hourSel, minSel, ampm]) s?.addEventListener('change', () => (err.textContent = ''));
  return pop.done;
}

// ------------------------------------------------------------------ custom repeat
export async function customRepeat(app, { repeat, due }) {
  const { h, t, ui } = app;
  const r = repeat || D.makeRepeat('weekly', due || app.today());
  const n = h('input', { class: 'input td-rep-n', type: 'number', min: '1', max: '999', value: String(r.interval || 1), 'aria-label': t('repeat.interval') });
  const freq = h(
    'select',
    { class: 'select td-rep-f', 'aria-label': t('repeat.frequency') },
    ['day', 'week', 'month', 'year'].map((f) => h('option', { value: f, selected: f === r.freq }, t(`repeat.unit.${f}`, { count: 2 }))),
  );
  const days = new Set(r.freq === 'week' && r.days?.length ? r.days : [D.weekday(due || app.today())]);
  const names = app.fmt.weekdayNames('short');
  const long = app.fmt.weekdayNames('long');
  const dayRow = h('div', { class: 'td-rep-days', role: 'group', 'aria-label': t('repeat.onDays') });
  const renderDays = () => {
    ui.clear(dayRow);
    for (let i = 0; i < 7; i++) {
      const d = (app.weekStart + i) % 7;
      dayRow.appendChild(
        h(
          'button',
          {
            type: 'button',
            class: ['td-rep-day', days.has(d) && 'on'],
            'aria-pressed': String(days.has(d)),
            'aria-label': long[d],
            onclick: () => {
              if (days.has(d) && days.size > 1) days.delete(d);
              else days.add(d);
              renderDays();
              dayRow.querySelectorAll('button')[i]?.focus();
            },
          },
          names[d],
        ),
      );
    }
  };
  renderDays();
  const syncDays = () => (dayRow.hidden = freq.value !== 'week');
  freq.addEventListener('change', syncDays);
  syncDays();
  const body = h('div', { class: 'td-rep' }, h('div', { class: 'td-rep-line' }, h('span', null, t('repeat.every')), n, freq), dayRow);
  const v = await ui.dialog({
    title: t('repeat.customTitle'),
    body,
    parent: app.win,
    className: 'td-dialog',
    buttons: [
      { label: t('common.save'), value: 'ok', primary: true },
      { label: t('common.cancel'), value: null },
    ],
  });
  if (v !== 'ok') return null;
  return D.normalizeRepeat({ kind: 'custom', freq: freq.value, interval: Number(n.value) || 1, days: freq.value === 'week' ? [...days] : undefined, anchorDay: D.parseYmd(due || app.today()).getDate() });
}

// ------------------------------------------------------------------ list theme
export function themePicker(app, anchor, view) {
  const { h, t } = app;
  const cur = () => app.themeOf(view);
  const colors = h('div', { class: 'td-swatches', role: 'radiogroup', 'aria-label': t('theme.color') });
  const bgs = h('div', { class: 'td-bgs', role: 'radiogroup', 'aria-label': t('theme.background') });
  const render = () => {
    const th = cur();
    app.ui.clear(colors);
    app.ui.clear(bgs);
    for (const c of COLORS) {
      colors.appendChild(
        h(
          'button',
          {
            type: 'button',
            role: 'radio',
            class: ['td-swatch', `td-c-${c}`, th.color === c && !th.bg && 'selected'],
            'aria-checked': String(th.color === c && !th.bg),
            'aria-label': t(`theme.colors.${c}`),
            'data-tip': t(`theme.colors.${c}`),
            onclick: () => {
              app.store.setTheme(view, { color: c, bg: null });
              render();
            },
          },
          h('span'),
        ),
      );
    }
    for (const b of BACKGROUNDS) {
      bgs.appendChild(
        h(
          'button',
          {
            type: 'button',
            role: 'radio',
            class: ['td-bgthumb', `td-bg-${b}`, th.bg === b && 'selected'],
            'aria-checked': String(th.bg === b),
            'aria-label': t(`theme.bgs.${b}`),
            'data-tip': t(`theme.bgs.${b}`),
            onclick: () => {
              app.store.setTheme(view, { bg: b });
              render();
            },
          },
          th.bg === b ? app.icon('checkmark', { size: 16 }) : null,
        ),
      );
    }
  };
  render();
  return popover(app, anchor, h('div', { class: 'td-theme' }, h('div', { class: 'td-pop-title' }, t('theme.title')), h('div', { class: 'td-pop-sub caption' }, t('theme.color')), colors, h('div', { class: 'td-pop-sub caption' }, t('theme.background')), bgs), { className: 'td-pop-theme' }).done;
}

// ------------------------------------------------------------------ emoji
const EMOJI = ['📋', '✅', '⭐', '📌', '🏠', '💼', '🛒', '🍎', '🥦', '☕', '🍽️', '🎂', '🎁', '🎉', '📚', '✏️', '🎓', '💡', '💻', '📱', '📷', '🎵', '🎮', '⚽', '🏃', '🧘', '💪', '❤️', '🌱', '🌸', '🐶', '🐱', '✈️', '🚗', '🏖️', '⛺', '🗺️', '💰', '💳', '📈', '🔧', '🧹', '🧺', '💊', '🩺', '👶', '👪', '📅'];

export function emojiPicker(app, anchor, current) {
  const { h, t } = app;
  let pop;
  const grid = h(
    'div',
    { class: 'td-emoji-grid', role: 'listbox', 'aria-label': t('emoji.title') },
    EMOJI.map((e) => h('button', { type: 'button', class: ['td-emoji', e === current && 'selected'], role: 'option', 'aria-selected': String(e === current), onclick: () => pop.close(e) }, e)),
  );
  grid.addEventListener('keydown', (e) => {
    const all = [...grid.children];
    const i = all.indexOf(document.activeElement);
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -8, ArrowDown: 8 }[e.key];
    if (step && i >= 0) {
      e.preventDefault();
      all[Math.max(0, Math.min(all.length - 1, i + step))].focus();
    }
  });
  pop = popover(
    app,
    anchor,
    h(
      'div',
      { class: 'td-emoji-pop' },
      h('div', { class: 'td-pop-title' }, t('emoji.title')),
      grid,
      h('div', { class: 'td-pop-foot' }, h('button', { type: 'button', class: 'btn', disabled: !current, onclick: () => pop.close('') }, app.icon('dismiss'), t('emoji.remove'))),
    ),
    { className: 'td-pop-emoji' },
  );
  return pop.done;
}

// ------------------------------------------------------------------ shortcuts
export function shortcutsHelp(app) {
  const { h, t, ui } = app;
  const rows = [
    ['Ctrl+N', 'keys.newTask'],
    ['Enter', 'keys.addTask'],
    ['Ctrl+L', 'keys.newList'],
    ['Ctrl+F', 'keys.search'],
    ['Ctrl+D', 'keys.complete'],
    ['Ctrl+T', 'keys.myDay'],
    ['Ctrl+Shift+S', 'keys.star'],
    ['↑ / ↓', 'keys.navigate'],
    ['Shift+↑ / ↓', 'keys.extend'],
    ['Alt+↑ / ↓', 'keys.reorder'],
    ['F2', 'keys.rename'],
    ['Space', 'keys.toggle'],
    ['Enter', 'keys.open'],
    ['Delete', 'keys.delete'],
    ['Ctrl+A', 'keys.selectAll'],
    ['Esc', 'keys.close'],
    ['Ctrl+Shift+?', 'keys.help'],
  ];
  const body = h(
    'div',
    { class: 'td-keys' },
    rows.map(([k, label]) => h('div', { class: 'td-keys-row' }, h('span', null, t(label)), h('span', { class: 'td-kbd' }, app.fmt.keys(k).split('+').map((x, i) => [i ? h('span', { class: 'td-kbd-plus' }, '+') : null, h('kbd', null, x)])))),
  );
  return ui.dialog({ title: t('keys.title'), body, parent: app.win, className: 'td-dialog td-keys-dialog', buttons: [{ label: t('common.close'), value: true, primary: true }] });
}
