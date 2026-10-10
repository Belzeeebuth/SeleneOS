// Mini month navigator (left pane and date picker), Windows 11 CalendarView look.
//   miniMonth(app, { month, selected, range: [startDate, endDateExclusive], onPick(date), onMonth(newMonth), compact })
//   -> element with .setState({ month, selected, range }) and .focusGrid()
// Keyboard: arrows move the focused day (roving tabindex), PageUp/PageDown change month, Enter/Space pick,
// Home/End go to the start/end of the week.
import { addDays, sameDay, startOfWeek, weekNumber, localKey } from '../lib/dates.mjs';

export function miniMonth(app, opts) {
  const { h, icon, t } = app.ctx;
  let month = new Date(opts.month.getFullYear(), opts.month.getMonth(), 1);
  let selected = opts.selected || null;
  let range = opts.range || null;
  let focusDate = selected && sameDay(new Date(selected.getFullYear(), selected.getMonth(), 1), month) ? selected : month;
  const root = h('div', { class: ['ac-mini', opts.compact && 'compact'] });
  const title = h('button', { class: 'ac-mini-title', type: 'button', onclick: () => opts.onTitle?.(month) });
  const prev = h('button', { class: 'ac-mini-nav', type: 'button', 'aria-label': t('prevMonth'), 'data-tip': t('prevMonth'), onclick: () => change(-1) }, icon('arrow_up', { size: 14, filled: true }));
  const next = h('button', { class: 'ac-mini-nav', type: 'button', 'aria-label': t('nextMonth'), 'data-tip': t('nextMonth'), onclick: () => change(1) }, icon('arrow_down', { size: 14, filled: true }));
  const head = h('div', { class: 'ac-mini-head' }, title, prev, next);
  const wk = h('div', { class: 'ac-mini-wk' });
  const viewport = h('div', { class: 'ac-mini-vp' });
  root.append(head, wk, viewport);

  function change(delta, focus = false) {
    month = new Date(month.getFullYear(), month.getMonth() + delta, 1);
    if (!focus) focusDate = month;
    render(delta);
    opts.onMonth?.(month);
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

  function render(slide = 0) {
    title.textContent = app.fmt.monthYear(month);
    title.setAttribute('aria-live', 'polite');
    app.ctx.ui.clear(wk);
    const first = app.firstDay();
    if (app.prefs.weekNumbers) wk.appendChild(h('span', { class: 'ac-mini-wn' }));
    wk.classList.toggle('weeks', !!app.prefs.weekNumbers);
    for (let i = 0; i < 7; i++) {
      const d = new Date(2026, 0, 4 + ((first + i) % 7));
      wk.appendChild(h('span', { 'aria-hidden': 'true' }, app.fmt.weekdayShort(d).slice(0, 2)));
    }
    const old = viewport.firstElementChild;
    const g = grid();
    if (old && slide && !app.reduceMotion()) {
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
    }
    if (selected && sameDay(new Date(selected.getFullYear(), selected.getMonth(), 1), month)) focusDate = selected;
    else if (slide) focusDate = month;
    render(slide);
  };
  root.focusGrid = () => (viewport.lastElementChild?.querySelector('.ac-mini-day[tabindex="0"]') || viewport.querySelector('.ac-mini-day'))?.focus();
  render();
  return root;
}
