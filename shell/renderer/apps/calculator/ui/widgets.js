// Small UI building blocks for the calculator: anchored flyouts, auto-shrinking text and a
// Fluent CalendarDatePicker (month / year / decade views, full keyboard support).
import { ymd, today, daysInMonth, sameDay } from '../lib/dates.js';

const reduceMotion = () => document.documentElement.dataset.animations === 'off';

/**
 * Open a flyout anchored to `anchor`, inside `host` (position: relative container).
 * Closes on outside click, Escape, or when close() is called. Returns { el, close }.
 */
export function openFlyout({ h, anchor, host, content, className, placement = 'below', align = 'start', onClose, focus = true }) {
  const el = h('div', { class: ['calc-flyout', className], role: 'dialog', tabindex: '-1' }, content);
  host.appendChild(el);
  function place() {
    const hr = host.getBoundingClientRect();
    const ar = anchor.getBoundingClientRect();
    const fr = { width: el.offsetWidth, height: el.offsetHeight };
    let left = align === 'end' ? ar.right - hr.left - fr.width : ar.left - hr.left;
    left = Math.max(4, Math.min(left, hr.width - fr.width - 4));
    let top = placement === 'above' ? ar.top - hr.top - fr.height - 4 : ar.bottom - hr.top + 4;
    el.classList.remove('up');
    if (placement !== 'above' && top + fr.height > hr.height - 4) {
      const above = ar.top - hr.top - fr.height - 4;
      if (above >= 4) {
        top = above;
        el.classList.add('up');
      } else top = Math.max(4, hr.height - fr.height - 4);
    } else if (placement === 'above') el.classList.add('up');
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
  }
  place();
  let closed = false;
  const outside = (e) => {
    if (!el.contains(e.target) && !anchor.contains(e.target)) close();
  };
  const keys = (e) => {
    if (e.key === 'Escape' && !e.defaultPrevented) {
      e.preventDefault();
      e.stopPropagation();
      close();
      anchor.focus?.();
    }
  };
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('pointerdown', outside, true);
    el.removeEventListener('keydown', keys);
    anchor.setAttribute?.('aria-expanded', 'false');
    anchor.classList?.remove('open');
    if (reduceMotion()) el.remove();
    else {
      el.classList.add('closing');
      setTimeout(() => el.remove(), 120);
    }
    onClose?.();
  }
  setTimeout(() => document.addEventListener('pointerdown', outside, true));
  el.addEventListener('keydown', keys);
  anchor.setAttribute?.('aria-expanded', 'true');
  anchor.classList?.add('open');
  if (focus) setTimeout(() => (el.querySelector('[autofocus], button:not(:disabled)') || el).focus({ preventScroll: true }), 0);
  return {
    el,
    close,
    place,
    get closed() {
      return closed;
    },
  };
}

/**
 * Shrink an element's font-size so its text fits on one line (Windows result display).
 * Returns the applied size.
 */
export function fitText(el, maxPx, minPx = 16) {
  el.style.fontSize = `${maxPx}px`;
  const avail = el.clientWidth;
  const need = el.scrollWidth;
  if (!avail || need <= avail) return maxPx;
  const size = Math.max(minPx, Math.floor(((maxPx * avail) / need) * 0.98));
  el.style.fontSize = `${size}px`;
  return size;
}

// ---------------------------------------------------------------- CalendarDatePicker

/**
 * Fluent CalendarDatePicker: a button showing the date; click opens a calendar flyout.
 *   const dp = datePicker({ ctx, host, value, onChange, label });   dp.el, dp.set(date), dp.value
 */
export function datePicker({ ctx, host, value, onChange, label }) {
  const { h, icon } = ctx;
  let current = value || today();
  const text = h('span', { class: 'calc-dp-text' });
  const btn = h(
    'button',
    { class: 'btn calc-dp', 'aria-haspopup': 'dialog', 'aria-label': label, onclick: () => open() },
    text,
    icon('calendar_ltr', { size: 16 }),
  );
  const locale = () => (ctx.lang === 'fr' ? 'fr-FR' : 'en-US');
  const fmtShort = (d) => new Intl.DateTimeFormat(locale(), { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const paint = () => {
    text.textContent = fmtShort(current);
    btn.setAttribute('aria-label', `${label}: ${new Intl.DateTimeFormat(locale(), { timeZone: 'UTC', dateStyle: 'full' }).format(current)}`);
  };
  paint();

  function open() {
    let view = 'month';
    let cursor = new Date(current); // focused date (month view) / month (year view) / year (decade view)
    const title = h('button', { class: 'calc-cal-title', onclick: () => zoomOut() });
    const prev = h('button', { class: 'calc-cal-nav', 'aria-label': ctx.t('date.previous'), onclick: () => step(-1) }, icon('chevron_up', { size: 16 }));
    const next = h('button', { class: 'calc-cal-nav', 'aria-label': ctx.t('date.next'), onclick: () => step(1) }, icon('chevron_down', { size: 16 }));
    const grid = h('div', { class: 'calc-cal-grid', role: 'grid' });
    const body = h('div', { class: 'calc-cal' }, h('div', { class: 'calc-cal-head' }, title, h('div', { class: 'grow' }), prev, next), grid);
    const fl = openFlyout({ h, anchor: btn, host, content: body, className: 'calc-cal-flyout', focus: false });

    function step(dir) {
      if (view === 'month') cursor = addMonthsKeep(cursor, dir);
      else if (view === 'year') cursor = ymd(clampYear(cursor.getUTCFullYear() + dir), cursor.getUTCMonth() + 1, 1);
      else cursor = ymd(clampYear(cursor.getUTCFullYear() + 10 * dir), 1, 1);
      render(dir);
    }
    function zoomOut() {
      if (view === 'month') view = 'year';
      else if (view === 'year') view = 'decade';
      render(0, 'out');
    }
    function pick(d) {
      current = d;
      paint();
      fl.close();
      btn.focus();
      onChange?.(d);
    }
    function render(dir = 0, zoom = null) {
      grid.textContent = '';
      grid.className = `calc-cal-grid view-${view}`;
      const y = cursor.getUTCFullYear();
      const m = cursor.getUTCMonth() + 1;
      const fmt = (o) => new Intl.DateTimeFormat(locale(), { timeZone: 'UTC', ...o });
      const now = today();
      let focusEl = null;
      if (view === 'month') {
        title.textContent = capitalize(fmt({ month: 'long', year: 'numeric' }).format(ymd(y, m, 1)));
        const firstDow = ctx.lang === 'fr' ? 1 : 0;
        for (let i = 0; i < 7; i++) {
          const d = ymd(2023, 1, 1 + ((firstDow + i) % 7)); // 2023-01-01 is a Sunday
          grid.appendChild(h('div', { class: 'calc-cal-dow', role: 'columnheader' }, capitalize(fmt({ weekday: 'short' }).format(d).replace('.', '').slice(0, 2))));
        }
        const start = ymd(y, m, 1);
        const lead = (start.getUTCDay() - firstDow + 7) % 7;
        for (let i = 0; i < 42; i++) {
          const d = new Date(start.getTime() + (i - lead) * 86400000);
          const inMonth = d.getUTCMonth() + 1 === m;
          const cell = h(
            'button',
            {
              class: ['calc-cal-day', !inMonth && 'other', sameDay(d, now) && 'today', sameDay(d, current) && 'selected'],
              role: 'gridcell',
              tabindex: sameDay(d, cursor) ? '0' : '-1',
              'aria-label': fmt({ dateStyle: 'full' }).format(d),
              'aria-selected': sameDay(d, current) ? 'true' : 'false',
              onclick: () => pick(d),
            },
            String(d.getUTCDate()),
          );
          if (sameDay(d, cursor)) focusEl = cell;
          grid.appendChild(cell);
        }
      } else if (view === 'year') {
        title.textContent = String(y);
        for (let i = 1; i <= 12; i++) {
          const d = ymd(y, i, 1);
          const cell = h(
            'button',
            {
              class: ['calc-cal-cell', now.getUTCFullYear() === y && now.getUTCMonth() + 1 === i && 'today', current.getUTCFullYear() === y && current.getUTCMonth() + 1 === i && 'selected'],
              tabindex: i === m ? '0' : '-1',
              onclick: () => {
                cursor = ymd(y, i, Math.min(cursor.getUTCDate(), daysInMonth(y, i)));
                view = 'month';
                render(0, 'in');
              },
            },
            capitalize(fmt({ month: 'short' }).format(d).replace('.', '')),
          );
          if (i === m) focusEl = cell;
          grid.appendChild(cell);
        }
      } else {
        const base = Math.floor(y / 10) * 10;
        title.textContent = `${base} – ${base + 9}`;
        for (let i = -1; i < 15; i++) {
          const yy = base + i;
          if (yy < 1 || yy > 9999) {
            grid.appendChild(h('span'));
            continue;
          }
          const cell = h(
            'button',
            {
              class: ['calc-cal-cell', (i < 0 || i > 9) && 'other', now.getUTCFullYear() === yy && 'today', current.getUTCFullYear() === yy && 'selected'],
              tabindex: yy === y ? '0' : '-1',
              onclick: () => {
                cursor = ymd(yy, cursor.getUTCMonth() + 1, 1);
                view = 'year';
                render(0, 'in');
              },
            },
            String(yy),
          );
          if (yy === y) focusEl = cell;
          grid.appendChild(cell);
        }
      }
      if (!reduceMotion() && (dir || zoom)) {
        const kf = zoom
          ? [{ opacity: 0, transform: `scale(${zoom === 'out' ? 1.08 : 0.92})` }, { opacity: 1, transform: 'none' }]
          : [{ opacity: 0, transform: `translateY(${dir > 0 ? 24 : -24}px)` }, { opacity: 1, transform: 'none' }];
        grid.animate(kf, { duration: 220, easing: 'cubic-bezier(0.1, 0.9, 0.2, 1)' });
      }
      fl.place();
      (focusEl || grid.querySelector("button"))?.focus({ preventScroll: true });
    }
    grid.addEventListener('keydown', (e) => {
      const deltas = view === 'month' ? { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 } : { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -4, ArrowDown: 4 };
      if (e.key in deltas) {
        e.preventDefault();
        const dlt = deltas[e.key];
        if (view === 'month') {
          const nd = new Date(cursor.getTime() + dlt * 86400000);
          const monthChanged = nd.getUTCMonth() !== cursor.getUTCMonth();
          cursor = nd;
          render(monthChanged ? Math.sign(dlt) : 0);
        } else if (view === 'year') {
          const mm = cursor.getUTCMonth() + dlt;
          cursor = ymd(clampYear(cursor.getUTCFullYear() + Math.floor(mm / 12)), (((mm % 12) + 12) % 12) + 1, 1);
          render();
        } else {
          cursor = ymd(clampYear(cursor.getUTCFullYear() + dlt), 1, 1);
          render();
        }
      } else if (e.key === 'PageUp' || e.key === 'PageDown') {
        e.preventDefault();
        step(e.key === 'PageUp' ? -1 : 1);
      } else if (e.key === 'Home' && view === 'month') {
        e.preventDefault();
        cursor = ymd(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1);
        render();
      } else if (e.key === 'End' && view === 'month') {
        e.preventDefault();
        cursor = ymd(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, daysInMonth(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1));
        render();
      }
    });
    render();
    fl.place();
  }

  return {
    el: btn,
    get value() {
      return current;
    },
    set(d) {
      current = d;
      paint();
    },
    repaint: paint,
  };
}

function clampYear(y) {
  return Math.max(1, Math.min(9999, y));
}

function addMonthsKeep(d, n) {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + n;
  const ty = clampYear(y + Math.floor(m / 12));
  const tm = (((m % 12) + 12) % 12) + 1;
  return ymd(ty, tm, Math.min(d.getUTCDate(), daysInMonth(ty, tm)));
}

export function capitalize(s) {
  return s ? s[0].toLocaleUpperCase() + s.slice(1) : s;
}
