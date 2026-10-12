// Mini month navigator (left pane and date picker): month name, then previous / next chevrons.
//   miniMonth(app, { month, selected, range: [startDate, endDateExclusive], onPick(date), onMonth(newMonth), compact })
//   -> element with .setState({ month, selected, range }) and .focusGrid()
// Keyboard: arrows move the focused day (roving tabindex), PageUp/PageDown change month, Enter/Space pick,
// Home/End go to the start/end of the week.
// The header ("October 2026") switches to the year view (12 months, like CalendarView); picking a month
// goes back to its days. Esc in the year view goes back too.
import { addDays, sameDay, startOfWeek, weekNumber, localKey } from '../lib/dates.mjs';

export function miniMonth(app, opts) {
  const { h, icon, t } = app.ctx;
  let month = new Date(opts.month.getFullYear(), opts.month.getMonth(), 1);
  let selected = opts.selected || null;
  let range = opts.range || null;
  let focusDate = selected && sameDay(new Date(selected.getFullYear(), selected.getMonth(), 1), month) ? selected : month;
  const root = h('div', { class: ['ac-mini', opts.compact && 'compact'] });
  let mode = 'days'; // 'days' | 'months' (year view)
  const title = h('button', { class: 'ac-mini-title', type: 'button', 'aria-label': '', onclick: () => showMonths() });
  const prev = h('button', { class: 'ac-mini-nav', type: 'button', 'aria-label': t('prevMonth'), 'data-tip': t('prevMonth'), onclick: () => change(-1) }, icon('caret-left', { size: 14 }));
  const next = h('button', { class: 'ac-mini-nav', type: 'button', 'aria-label': t('nextMonth'), 'data-tip': t('nextMonth'), onclick: () => change(1) }, icon('caret-right', { size: 14 }));
  const head = h('div', { class: 'ac-mini-head' }, title, prev, next);
  const wk = h('div', { class: 'ac-mini-wk' });
  const viewport = h('div', { class: 'ac-mini-vp' });
  root.append(head, wk, viewport);

  function change(delta, focus = false) {
    if (mode === 'months') {
      // the arrows change the year in the year view
      month = new Date(month.getFullYear() + delta, month.getMonth(), 1);
      render(delta);
      return;
    }
    month = new Date(month.getFullYear(), month.getMonth() + delta, 1);
    if (!focus) focusDate = month;
    render(delta);
    opts.onMonth?.(month);
  }

  function showMonths() {
    if (mode === 'months') return;
    const hadFocus = root.contains(document.activeElement);
    mode = 'months';
    render(0, 'out');
    if (hadFocus) viewport.querySelector('.ac-mini-month[tabindex="0"]')?.focus();
  }

  function showDays(m, focus = false) {
    month = new Date(month.getFullYear(), m, 1);
    mode = 'days';
    focusDate = selected && sameDay(new Date(selected.getFullYear(), selected.getMonth(), 1), month) ? selected : month;
    render(0, 'in');
    opts.onMonth?.(month);
    if (focus) root.focusGrid();
  }

  // year view: the 12 months of the shown year, 4 per row
  function monthsGrid() {
    const y = month.getFullYear();
    const today = new Date();
    const g = h('div', { class: 'ac-mini-months', role: 'grid', 'aria-label': String(y) });
    for (let r = 0; r < 3; r++) {
      const row = h('div', { class: 'ac-mini-mrow', role: 'row' });
      for (let c = 0; c < 4; c++) {
        const m = r * 4 + c;
        const d = new Date(y, m, 1);
        const isToday = today.getFullYear() === y && today.getMonth() === m;
        const isSel = !!selected && selected.getFullYear() === y && selected.getMonth() === m;
        row.appendChild(
          h(
            'button',
            {
              type: 'button',
              class: ['ac-mini-month', isToday && 'today', isSel && 'selected'],
              role: 'gridcell',
              tabindex: m === month.getMonth() ? '0' : '-1',
              'aria-label': app.fmt.monthYear(d),
              'aria-selected': String(isSel),
              'aria-current': isToday ? 'date' : null,
              dataset: { month: String(m) },
              onclick: (e) => showDays(m, e.detail === 0),
            },
            h('span', null, app.fmt.monthShort(d).replace(/\.$/, '')),
          ),
        );
      }
      g.appendChild(row);
    }
    return g;
  }

  function grid() {
    const first = app.firstDay();
    const start = startOfWeek(month, first);
    const today = new Date();
    const showWeeks = app.prefs.weekNumbers;
    const g = h('div', { class: ['ac-mini-grid', showWeeks && 'weeks'], role: 'grid', 'aria-label': app.fmt.monthYear(month) });
    for (let w = 0; w < 6; w++) {
      const row = h('div', { class: 'ac-mini-row', role: 'row' });
      const ws = addDays(start, w * 7);
      if (showWeeks) row.appendChild(h('span', { class: 'ac-mini-wn', 'aria-hidden': 'true' }, String(weekNumber(ws, first === 1 ? 1 : first))));
      for (let i = 0; i < 7; i++) {
        const d = addDays(ws, i);
        const other = d.getMonth() !== month.getMonth();
        const inRange = range && d >= range[0] && d < range[1];
        const prevIn = range && i > 0 && addDays(d, -1) >= range[0];
        const nextIn = range && i < 6 && addDays(d, 1) < range[1];
        const isFocus = sameDay(d, focusDate);
        row.appendChild(
          h(
            'button',
            {
              type: 'button',
              class: ['ac-mini-day', other && 'other', sameDay(d, today) && 'today', selected && sameDay(d, selected) && 'selected', inRange && 'in-range', inRange && !prevIn && 'range-start', inRange && !nextIn && 'range-end'],
              role: 'gridcell',
              tabindex: isFocus ? '0' : '-1',
              'aria-label': app.fmt.dayLong(d),
              'aria-selected': selected && sameDay(d, selected) ? 'true' : 'false',
              'aria-current': sameDay(d, today) ? 'date' : null,
              dataset: { date: localKey(d) },
              onclick: () => {
                focusDate = d;
                opts.onPick?.(d);
              },
            },
            h('span', null, String(d.getDate())),
          ),
        );
      }
      g.appendChild(row);
    }
    if (!g.querySelector('[tabindex="0"]')) {
      const first1 = g.querySelector('.ac-mini-day:not(.other)');
      if (first1) first1.tabIndex = 0;
    }
    return g;
  }

  function render(slide = 0, zoom = null) {
    const months = mode === 'months';
    title.textContent = months ? String(month.getFullYear()) : app.fmt.monthYear(month);
    title.setAttribute('aria-live', 'polite');
    title.setAttribute('aria-label', months ? String(month.getFullYear()) : `${app.fmt.monthYear(month)}. ${t('pickMonth')}`);
    title.classList.toggle('static', months);
    title.tabIndex = months ? -1 : 0;
    prev.setAttribute('aria-label', months ? t('prevYear') : t('prevMonth'));
    prev.dataset.tip = months ? t('prevYear') : t('prevMonth');
    next.setAttribute('aria-label', months ? t('nextYear') : t('nextMonth'));
    next.dataset.tip = months ? t('nextYear') : t('nextMonth');
    root.classList.toggle('year-view', months);
    app.ctx.ui.clear(wk);
    const first = app.firstDay();
    if (!months) {
      if (app.prefs.weekNumbers) wk.appendChild(h('span', { class: 'ac-mini-wn' }));
      wk.classList.toggle('weeks', !!app.prefs.weekNumbers);
      for (let i = 0; i < 7; i++) {
        const d = new Date(2026, 0, 4 + ((first + i) % 7));
        wk.appendChild(h('span', { 'aria-hidden': 'true' }, app.fmt.weekdayShort(d).slice(0, 2)));
      }
    }
    const old = viewport.firstElementChild;
    const g = months ? monthsGrid() : grid();
    if (zoom && !app.reduceMotion()) {
      // year view <-> days: a short zoom, like CalendarView
      app.ctx.ui.clear(viewport);
      viewport.appendChild(g);
      const from = zoom === 'out' ? 'scale(1.12)' : 'scale(0.88)';
      g.animate([{ transform: from, opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 220, easing: 'cubic-bezier(0.1,0.9,0.2,1)' });
    } else if (old && slide && !app.reduceMotion()) {
      old.classList.add('ac-mini-out');
      old.animate([{ transform: 'none', opacity: 1 }, { transform: `translateY(${slide > 0 ? -24 : 24}px)`, opacity: 0 }], { duration: 160, easing: 'cubic-bezier(0.7,0,1,0.5)', fill: 'forwards' }).finished.then(
        () => old.remove(),
        () => old.remove(),
      );
      viewport.appendChild(g);
      g.animate([{ transform: `translateY(${slide > 0 ? 24 : -24}px)`, opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 260, easing: 'cubic-bezier(0.1,0.9,0.2,1)' });
    } else {
      app.ctx.ui.clear(viewport);
      viewport.appendChild(g);
    }
  }

  viewport.addEventListener('keydown', (e) => {
    const mbtn = e.target.closest?.('.ac-mini-month');
    if (mbtn) {
      const m = Number(mbtn.dataset.month);
      const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -4, ArrowDown: 4 }[e.key];
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        showDays(m, true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        showDays(month.getMonth(), true);
      } else if (step || e.key === 'PageUp' || e.key === 'PageDown') {
        e.preventDefault();
        e.stopPropagation();
        const target = step ? new Date(month.getFullYear(), m + step, 1) : new Date(month.getFullYear() + (e.key === 'PageUp' ? -1 : 1), m, 1);
        const yearDelta = target.getFullYear() - month.getFullYear();
        month = target;
        if (yearDelta) render(yearDelta);
        else for (const b of viewport.querySelectorAll('.ac-mini-month')) b.tabIndex = Number(b.dataset.month) === target.getMonth() ? 0 : -1;
        viewport.lastElementChild?.querySelector(`.ac-mini-month[data-month="${target.getMonth()}"]`)?.focus();
      }
      return;
    }
    const btn = e.target.closest?.('.ac-mini-day');
    if (!btn) return;
    const [y, m, d] = btn.dataset.date.split('-').map(Number);
    const cur = new Date(y, m - 1, d);
    let next = null;
    const first = app.firstDay();
    switch (e.key) {
      case 'ArrowLeft':
        next = addDays(cur, -1);
        break;
      case 'ArrowRight':
        next = addDays(cur, 1);
        break;
      case 'ArrowUp':
        next = addDays(cur, -7);
        break;
      case 'ArrowDown':
        next = addDays(cur, 7);
        break;
      case 'Home':
        next = startOfWeek(cur, first);
        break;
      case 'End':
        next = addDays(startOfWeek(cur, first), 6);
        break;
      case 'PageUp':
        next = new Date(cur.getFullYear(), cur.getMonth() - 1, Math.min(cur.getDate(), 28));
        break;
      case 'PageDown':
        next = new Date(cur.getFullYear(), cur.getMonth() + 1, Math.min(cur.getDate(), 28));
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        e.stopPropagation();
        btn.click();
        return;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    focusDate = next;
    const delta = next.getMonth() - month.getMonth() + 12 * (next.getFullYear() - month.getFullYear());
    if (delta) {
      month = new Date(next.getFullYear(), next.getMonth(), 1);
      render(delta);
      opts.onMonth?.(month);
    } else {
      for (const b of viewport.querySelectorAll('.ac-mini-day')) b.tabIndex = -1;
    }
    const target = viewport.lastElementChild?.querySelector(`.ac-mini-day[data-date="${localKey(next)}"]`);
    if (target) {
      target.tabIndex = 0;
      target.focus();
    }
  });

  viewport.addEventListener(
    'wheel',
    (e) => {
      if (Math.abs(e.deltaY) < 4) return;
      e.preventDefault();
      if (viewport._lock) return;
      viewport._lock = true;
      setTimeout(() => (viewport._lock = false), 250);
      change(e.deltaY > 0 ? 1 : -1);
    },
    { passive: false },
  );

  root.setState = (s = {}) => {
    if (s.selected !== undefined) selected = s.selected;
    if (s.range !== undefined) range = s.range;
    let slide = 0;
    if (s.month) {
      const m = new Date(s.month.getFullYear(), s.month.getMonth(), 1);
      slide = m.getTime() === month.getTime() ? 0 : m > month ? 1 : -1;
      month = m;
      // the main view moved to another month: show its days again
      if (slide) mode = 'days';
    }
    if (selected && sameDay(new Date(selected.getFullYear(), selected.getMonth(), 1), month)) focusDate = selected;
    else if (slide) focusDate = month;
    render(slide);
  };
  root.focusGrid = () => (viewport.lastElementChild?.querySelector('.ac-mini-day[tabindex="0"], .ac-mini-month[tabindex="0"]') || viewport.querySelector('.ac-mini-day, .ac-mini-month'))?.focus();
  render();
  return root;
}
