// Day / Work week / Week views: time grid with half-hour lines, working hours, the current-time line,
// an all-day row, overlapping events side by side. Drag on empty space to select a time range (quick
// create), drag an event to move it (other days too), drag its bottom edge to resize. Snaps to 15 min.
import { addDays, sameDay, localKey, localDayNum, weekNumber, minutesOfDay } from '../lib/dates.mjs';
import { layoutColumns, packLanes } from '../lib/layout.mjs';
import { track, autoScroller } from './drag.js';
import { gridPointerAllowed } from './pickers.js';
import { chipLabel } from './agenda.js';
import { css } from './util.js';

const HOUR_H = 48;
const PX_MIN = HOUR_H / 60;
const SNAP = 15;
const DAY_MS = 86400000;
const AD_LANES = 3;

const snapMin = (m, step = SNAP) => Math.round(m / step) * step;
const atMinutes = (day, min) => {
  const d = new Date(day);
  d.setHours(0, 0, 0, 0);
  d.setMinutes(min);
  return d.getTime();
};

// Wall-clock minute of `ms` inside a segment's day column (0 at the start of the column, 24 h at its end).
function segMinute(seg, ms) {
  const m = minutesOfDay(ms);
  // an end at midnight belongs to the bottom of the column
  return ms > seg.start && m === 0 ? 24 * 60 : m;
}

export function renderTimeGrid(app, days) {
  const { h, icon } = app.ctx;
  const t = app.t;
  const n = days.length;
  const from = days[0];
  const to = addDays(days[n - 1], 1);
  const today = new Date();
  const first = app.firstDay();
  const occs = app.occurrences(from, to);
  const isAllDayItem = (o) => o.allDay || o.end - o.start >= DAY_MS;
  const allDayOccs = occs.filter(isAllDayItem);
  const timedOccs = occs.filter((o) => !isAllDayItem(o));
  const dayIdx = new Map(days.map((d, i) => [localDayNum(d), i]));

  // ---------------------------------------------------------------- header
  const wn = weekNumber(days[0], first === 1 ? 1 : first);
  const corner = h('div', { class: 'ac-tg-corner caption' }, app.prefs.weekNumbers ? h('span', { 'data-tip': t('weekN', { n: wn }) }, t('weekShort', { n: wn })) : null);
  const head = h(
    'div',
    { class: 'ac-tg-head', role: 'row' },
    corner,
    days.map((d) =>
      h(
        'button',
        {
          type: 'button',
          class: ['ac-tg-dh', sameDay(d, today) && 'today', sameDay(d, app.state.date) && 'selected', !app.prefs.workDays.includes(d.getDay()) && 'weekend'],
          role: 'columnheader',
          tabindex: '-1',
          'aria-label': app.fmt.dayLong(d),
          'aria-current': sameDay(d, today) ? 'date' : null,
          dataset: { date: localKey(d) },
          onclick: () => {
            if (n === 1) return;
            app.state.date = d;
            app.setView('day');
          },
        },
        h('span', { class: 'ac-tg-dh-num' }, String(d.getDate())),
        h('span', { class: 'ac-tg-dh-wd' }, n === 1 ? app.fmt.weekdayLong(d) : app.fmt.weekdayShort(d)),
      ),
    ),
  );

  // ---------------------------------------------------------------- all-day row
  let adExpanded = !!app._adExpanded;
  const adGrid = h('div', { class: 'ac-tg-adgrid' });
  const adToggle = h('button', { class: 'ac-tg-adtoggle', type: 'button', hidden: true, onclick: () => ((adExpanded = !adExpanded), (app._adExpanded = adExpanded), layoutAllDay()) });
  const adCells = days.map((d) => h('div', { class: ['ac-tg-adcell', !app.prefs.workDays.includes(d.getDay()) && 'weekend'], dataset: { date: localKey(d) } }));
  adGrid.appendChild(h('div', { class: 'ac-tg-adcells', 'aria-hidden': 'true' }, adCells));
  const allday = h('div', { class: 'ac-tg-allday' }, h('div', { class: 'ac-tg-adlabel caption' }, h('span', null, t('allDay')), adToggle), adGrid);

  function allDayItems() {
    const items = [];
    allDayOccs.forEach((o, order) => {
      const sd = localDayNum(o.start);
      const ed = o.allDay ? localDayNum(o.end) : localDayNum(o.end - 1) + 1;
      // map onto visible columns (work week may skip days)
      let a = -1;
      let b = -1;
      days.forEach((d, i) => {
        const dn = localDayNum(d);
        if (dn >= sd && dn < ed) {
          if (a < 0) a = i;
          b = i;
        }
      });
      if (a < 0) return;
      items.push({ o, order, startDay: a, endDay: b + 1, contL: sd < localDayNum(days[a]), contR: ed > localDayNum(days[b]) + 1 });
    });
    return packLanes(items);
  }

  function layoutAllDay() {
    for (const el of [...adGrid.querySelectorAll('.ac-chip, .ac-tg-admore')]) el.remove();
    const items = allDayItems();
    const lanesUsed = items.reduce((m, it) => Math.max(m, it.lane + 1), 0);
    const overflow = lanesUsed > AD_LANES;
    const shown = overflow && !adExpanded ? AD_LANES - 1 : lanesUsed;
    const hidden = new Array(n).fill(0);
    for (const it of items) {
      if (it.lane >= shown) {
        for (let d = it.startDay; d < it.endDay; d++) hidden[d]++;
        continue;
      }
      adGrid.appendChild(allDayChip(it));
    }
    hidden.forEach((c, d) => {
      if (!c) return;
      adGrid.appendChild(
        h('button', { class: 'ac-tg-admore', type: 'button', style: { gridColumn: String(d + 1), gridRow: String(shown + 1) }, onclick: () => ((adExpanded = true), (app._adExpanded = true), layoutAllDay()) }, t('moreN', { count: c })),
      );
    });
    adGrid.style.setProperty('--lanes', String(Math.max(1, overflow && !adExpanded ? AD_LANES : lanesUsed)));
    adToggle.hidden = !overflow;
    app.ctx.ui.clear(adToggle);
    adToggle.appendChild(icon(adExpanded ? 'chevron_up' : 'chevron_down', { size: 12 }));
    adToggle.setAttribute('aria-label', adExpanded ? t('collapseAllDay') : t('expandAllDay'));
    adToggle.dataset.tip = adExpanded ? t('collapseAllDay') : t('expandAllDay');
  }

  function allDayChip(it) {
    const { o } = it;
    const label = chipLabel(app, o);
    const el = h(
      'div',
      {
        class: ['ac-chip', 'bar', it.contL && 'cont-l', it.contR && 'cont-r', app.isSelected(o) && 'selected', o.readOnly && 'readonly', o.holiday && 'holiday'],
        style: css({ gridColumn: `${it.startDay + 1} / ${it.endDay + 1}`, gridRow: String(it.lane + 1), '--ev': o.color }),
        role: 'button',
        tabindex: '0',
        'aria-label': label,
        title: label,
        dataset: { eventId: o.eventId, key: String(o.key) },
      },
      !o.allDay ? h('span', { class: 'ac-chip-time' }, app.fmt.chipTime(o.start)) : null,
      o.recurring ? icon('arrow_repeat_all', { size: 12, class: 'ac-rec' }) : null,
      h('span', { class: 'ac-chip-title' }, o.title || t('noTitle')),
    );
    wireEvent(el, o, { allDayRow: true });
    return el;
  }

  // ---------------------------------------------------------------- time grid
  const gutter = h('div', { class: 'ac-tg-gutter', 'aria-hidden': 'true' });
  for (let hr = 1; hr < 24; hr++) gutter.appendChild(h('div', { class: 'ac-tg-hour', style: { top: `${hr * HOUR_H}px` } }, app.fmt.hourLabel(hr)));
  const lines = h('div', { class: 'ac-tg-lines', 'aria-hidden': 'true' });
  for (let i = 1; i < 48; i++) lines.appendChild(h('div', { class: ['ac-tg-line', i % 2 && 'half'], style: { top: `${i * (HOUR_H / 2)}px` } }));
  const ws = Math.max(0, app.prefs.workStart) * HOUR_H;
  const we = Math.min(24, app.prefs.workEnd) * HOUR_H;
  const cols = days.map((d) => {
    const work = app.prefs.workDays.includes(d.getDay());
    const evs = h('div', { class: 'ac-tg-evs' });
    const col = h('div', { class: ['ac-tg-col', sameDay(d, today) && 'today', !work && 'weekend'], style: work ? css({ '--ws': `${ws}px`, '--we': `${we}px` }) : null, role: 'gridcell', 'aria-label': app.fmt.dayLong(d), dataset: { date: localKey(d) } }, evs);
    let downs = [];
    col.addEventListener('pointerdown', (e) => {
      downs = [...downs.filter((ts) => e.timeStamp - ts < 700), e.timeStamp];
      onColDown(e, d, col);
    });
    col.addEventListener('dblclick', (e) => {
      // both clicks must land on the grid (not a click on a flyout button that closed just before)
      if (e.target.closest('.ac-ev') || downs.filter((ts) => e.timeStamp - ts < 700).length < 2) return;
      const min = snapMin(minuteAt(e.clientY) - 15, 30);
      app.newEvent({ start: atMinutes(d, min), end: atMinutes(d, min + (app.prefs.defaultDuration || 30)) });
    });
    return { d, col, evs };
  });
  const nowLine = h('div', { class: 'ac-tg-now', 'aria-hidden': 'true' });
  const nowAll = h('div', { class: 'ac-tg-now-all', 'aria-hidden': 'true' });
  const colsEl = h('div', { class: 'ac-tg-cols' }, lines, cols.map((c) => c.col), nowAll, nowLine);
  const bodyEl = h('div', { class: 'ac-tg-body', style: { height: `${24 * HOUR_H}px` } }, gutter, colsEl);
  const scroll = h('div', { class: 'ac-tg-scroll' }, bodyEl);
  const root = h('div', { class: ['ac-tg', n === 1 && 'single'], style: css({ '--cols': String(n) }), role: 'grid', 'aria-label': app.fmt.rangeTitle(days[0], days[n - 1]) }, head, allday, scroll);

  function segments(o) {
    const out = [];
    cols.forEach((c, i) => {
      const ds = c.d.getTime();
      const de = addDays(c.d, 1).getTime();
      const s = Math.max(o.start, ds);
      const e = Math.min(o.end, de);
      if (o.start < de && (o.end > ds || (o.end === o.start && o.start >= ds))) {
        if (e <= s && o.end !== o.start) return;
        out.push({ o, day: i, start: s, end: Math.max(e, s), first: o.start >= ds, last: o.end <= de });
      }
    });
    return out;
  }

  function layoutTimed() {
    for (const c of cols) app.ctx.ui.clear(c.evs);
    const perCol = cols.map(() => []);
    for (const o of timedOccs) for (const s of segments(o)) perCol[s.day].push(s);
    perCol.forEach((segs, i) => {
      const laid = layoutColumns(segs, { minDuration: 22 * 60000 });
      for (const s of laid) cols[i].evs.appendChild(eventBlock(s));
    });
    fitInline();
  }

  // Short events show "Title, 9:00 AM" on one line: drop the time when it would be cut.
  function fitInline() {
    for (const el of root.querySelectorAll('.ac-ev.short .ac-ev-inline')) {
      el.hidden = false;
      if (el.scrollWidth > el.clientWidth + 1) el.hidden = true;
    }
  }

  function eventBlock(s) {
    const { o } = s;
    // wall-clock positions (a 09:00 event sits on the 9:00 line on daylight-saving change days too)
    const topMin = segMinute(s, s.start);
    const bottomMin = s.last ? segMinute(s, s.end) : 24 * 60;
    const top = topMin * PX_MIN;
    const hgt = Math.max(20, Math.max(0, bottomMin - topMin) * PX_MIN - 2);
    const short = hgt < 38;
    const label = chipLabel(app, o);
    const el = h(
      'div',
      {
        class: ['ac-ev', short && 'short', hgt < 26 && 'tiny', app.isSelected(o) && 'selected', o.readOnly && 'readonly', !s.first && 'cont-top', !s.last && 'cont-bottom'],
        style: css({ top: `${top}px`, height: `${hgt}px`, '--ev': o.color }),
        role: 'button',
        tabindex: '0',
        'aria-label': label,
        dataset: { eventId: o.eventId, key: String(o.key) },
      },
      h(
        'div',
        { class: 'ac-ev-in' },
        h('div', { class: 'ac-ev-title' }, o.recurring ? icon('arrow_repeat_all', { size: 12, class: 'ac-rec' }) : null, h('span', null, o.title || t('noTitle')), short ? h('span', { class: 'ac-ev-inline' }, `, ${app.fmt.time(o.start)}`) : null),
        short ? null : h('div', { class: 'ac-ev-meta' }, `${app.fmt.time(o.start)} – ${app.fmt.time(o.end)}`),
        !short && o.location ? h('div', { class: 'ac-ev-loc' }, o.location) : null,
      ),
      s.last && !o.readOnly ? h('div', { class: 'ac-ev-resize', 'aria-hidden': 'true' }) : null,
    );
    // horizontal placement from the overlap layout
    const left = (s.col ?? 0) / (s.cols || 1);
    el.style.left = `calc(${(left * 100).toFixed(4)}% + 1px)`;
    el.style.width = `calc(${(((s.span || 1) / (s.cols || 1)) * 100).toFixed(4)}% - 3px)`;
    el.title = label;
    wireEvent(el, o, { seg: s });
    return el;
  }

  // ---------------------------------------------------------------- now line
  function placeNow() {
    const now = new Date();
    const i = cols.findIndex((c) => sameDay(c.d, now));
    if (i < 0) {
      nowLine.hidden = true;
      nowAll.hidden = true;
      return;
    }
    const y = minutesOfDay(now) * PX_MIN;
    nowLine.hidden = false;
    nowAll.hidden = false;
    nowLine.style.top = `${y}px`;
    nowLine.style.left = `calc(${(i / n) * 100}% - 1px)`;
    nowLine.style.width = `calc(${100 / n}% + 1px)`;
    nowAll.style.top = `${y}px`;
  }

  // ---------------------------------------------------------------- geometry
  const colsRect = () => colsEl.getBoundingClientRect();
  const minuteAt = (clientY) => Math.max(0, Math.min(24 * 60, (clientY - colsRect().top) / PX_MIN));
  const colAt = (clientX) => {
    const r = colsRect();
    return Math.max(0, Math.min(n - 1, Math.floor(((clientX - r.left) / r.width) * n)));
  };
  const adColAt = (clientX) => {
    const r = adGrid.getBoundingClientRect();
    return Math.max(0, Math.min(n - 1, Math.floor(((clientX - r.left) / r.width) * n)));
  };

  // ---------------------------------------------------------------- interactions
  function wireEvent(el, o, { seg, allDayRow } = {}) {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      if (e.target.classList.contains('ac-ev-resize')) return onResizeDown(e, o, el, seg);
      if (allDayRow) return onAllDayDrag(e, o, el);
      onMoveDown(e, o, el);
    });
    el.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      app.edit(o);
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        if (o.readOnly) app.select(o, el);
        else app.edit(o);
      } else if (e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        app.select(o, el);
      } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && e.altKey && !o.readOnly && !o.allDay) {
        // Alt+Up/Down nudges the event by 15 minutes
        e.preventDefault();
        e.stopPropagation();
        const d = (e.key === 'ArrowUp' ? -SNAP : SNAP) * 60000;
        app.moveOcc(o, o.start + d, o.end + d).then(() => app.viewEl.querySelector(`.ac-ev[data-event-id="${CSS.escape(o.eventId)}"]`)?.focus());
      }
    });
    el.addEventListener('focus', () => app.select(o, el, { peek: false }));
  }

  function onMoveDown(e, o, el) {
    const col0 = colAt(e.clientX);
    const min0 = minuteAt(e.clientY);
    const dur = o.end - o.start;
    let ghost = null;
    let result = null;
    const auto = autoScroller(scroll, () => update(lastEv));
    let lastEv = e;
    const update = (ev) => {
      lastEv = ev;
      const c = colAt(ev.clientX);
      const dayDelta = localDayNum(cols[c].d) - localDayNum(cols[col0].d);
      const s = new Date(o.start);
      s.setDate(s.getDate() + dayDelta);
      let m = s.getHours() * 60 + s.getMinutes() + (minuteAt(ev.clientY) - min0);
      m = Math.max(0, Math.min(24 * 60 - SNAP, snapMin(m)));
      const start = atMinutes(s, m);
      result = { start, end: start + dur };
      // ghost in the target column (first day of the event)
      const gc = cols.findIndex((cc) => sameDay(cc.d, start));
      if (gc < 0) {
        ghost.hidden = true;
        return;
      }
      ghost.hidden = false;
      if (ghost.parentElement !== cols[gc].evs) cols[gc].evs.appendChild(ghost);
      const top = minutesOfDay(start) * PX_MIN;
      const hgt = Math.max(20, Math.min(24 * 60 * PX_MIN - top, (dur / 60000) * PX_MIN - 2));
      ghost.style.top = `${top}px`;
      ghost.style.height = `${hgt}px`;
      ghost.querySelector('.ac-ghost-time').textContent = `${app.fmt.time(start)} – ${app.fmt.time(start + dur)}`;
    };
    track(e, {
      onStart: () => {
        if (o.readOnly) return;
        el.classList.add('dragging');
        for (const x of root.querySelectorAll(`.ac-ev[data-event-id="${CSS.escape(o.eventId)}"][data-key="${CSS.escape(String(o.key))}"]`)) x.classList.add('dragging');
        ghost = h('div', { class: 'ac-ev ac-ev-ghost', style: css({ '--ev': o.color, left: '1px', width: 'calc(100% - 3px)' }) }, h('div', { class: 'ac-ev-in' }, h('div', { class: 'ac-ev-title' }, h('span', null, o.title || t('noTitle'))), h('div', { class: 'ac-ev-meta ac-ghost-time' })));
      },
      onMove: (ev) => {
        if (!ghost) return;
        auto.update(ev.clientY);
        update(ev);
      },
      onEnd: () => {
        auto.stop();
        ghost?.remove();
        for (const x of root.querySelectorAll('.ac-ev.dragging')) x.classList.remove('dragging');
        if (ghost && result) app.moveOcc(o, result.start, result.end);
      },
      onCancel: () => {
        auto.stop();
        ghost?.remove();
        for (const x of root.querySelectorAll('.ac-ev.dragging')) x.classList.remove('dragging');
      },
      onClick: () => {
        el.focus({ preventScroll: true });
        app.select(o, el);
      },
    });
  }

  function onResizeDown(e, o, el, seg) {
    if (o.readOnly) return;
    const dayStart = cols[seg.day].d;
    const startMinInCol = segMinute(seg, seg.start);
    let result = null;
    const auto = autoScroller(scroll, () => update(lastEv));
    let lastEv = e;
    const label = h('div', { class: 'ac-ev-meta ac-resize-label' });
    const update = (ev) => {
      lastEv = ev;
      let m = snapMin(minuteAt(ev.clientY));
      m = Math.max(startMinInCol + SNAP, Math.min(24 * 60, m));
      const end = atMinutes(dayStart, m);
      result = Math.max(o.start + SNAP * 60000, end);
      el.style.height = `${Math.max(20, (m - startMinInCol) * PX_MIN - 2)}px`;
      label.textContent = `${app.fmt.time(o.start)} – ${app.fmt.time(result)}`;
    };
    track(e, {
      cursor: 'ns-resize',
      threshold: 2,
      onStart: () => {
        el.classList.add('resizing');
        // the live "9:00 AM – 10:30 AM" label takes the place of the time line under the title
        el.querySelector('.ac-ev-title').after(label);
      },
      onMove: (ev) => {
        auto.update(ev.clientY);
        update(ev);
      },
      onEnd: () => {
        auto.stop();
        el.classList.remove('resizing');
        label.remove();
        if (result != null && result !== o.end) app.moveOcc(o, o.start, result);
        else layoutTimed();
      },
      onCancel: () => {
        auto.stop();
        el.classList.remove('resizing');
        label.remove();
        layoutTimed();
      },
      onClick: () => app.select(o, el),
    });
  }

  function onColDown(e, d, col) {
    if (e.button !== 0 || e.target.closest('.ac-ev') || !gridPointerAllowed()) return;
    e.preventDefault();
    app.viewEl.focus({ preventScroll: true });
    const a = Math.floor(minuteAt(e.clientY) / SNAP) * SNAP;
    let range = [a, a + SNAP];
    const sel = h('div', { class: 'ac-tg-sel' }, h('span', { class: 'ac-tg-sel-label' }));
    const paint = () => {
      sel.style.top = `${range[0] * PX_MIN}px`;
      sel.style.height = `${(range[1] - range[0]) * PX_MIN}px`;
      sel.firstChild.textContent = `${app.fmt.time(atMinutes(d, range[0]))} – ${app.fmt.time(atMinutes(d, range[1]))}`;
    };
    const auto = autoScroller(scroll, () => update(lastEv));
    let lastEv = e;
    const update = (ev) => {
      lastEv = ev;
      const cur = Math.min(24 * 60 - SNAP, Math.floor(minuteAt(ev.clientY) / SNAP) * SNAP);
      range = [Math.min(a, cur), Math.max(a, cur) + SNAP];
      paint();
    };
    const finish = () => {
      auto.stop();
      app.state.date = d;
      app.mini.setState({ selected: d });
      for (const x of root.querySelectorAll('.ac-tg-dh')) x.classList.toggle('selected', x.dataset.date === localKey(d));
      app.newEvent({ start: atMinutes(d, range[0]), end: atMinutes(d, range[1]), quick: true, anchor: sel, onClose: () => sel.remove() });
    };
    track(e, {
      cursor: 'default',
      onStart: () => {
        col.appendChild(sel);
        paint();
      },
      onMove: (ev) => {
        auto.update(ev.clientY);
        update(ev);
      },
      onEnd: () => finish(),
      onClick: () => {
        // a click selects the half hour under the pointer
        const s = Math.floor(minuteAt(e.clientY) / 30) * 30;
        range = [s, Math.min(24 * 60, s + 30)];
        col.appendChild(sel);
        paint();
        finish();
      },
      onCancel: () => {
        auto.stop();
        sel.remove();
      },
    });
  }

  // all-day row: select days (quick create) and move bars between days
  adGrid.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.ac-chip, .ac-tg-admore') || !gridPointerAllowed()) return;
    e.preventDefault();
    const a = adColAt(e.clientX);
    let b = a;
    const paint = () => adCells.forEach((c, i) => c.classList.toggle('in-sel', i >= Math.min(a, b) && i <= Math.max(a, b)));
    const clear = () => adCells.forEach((c) => c.classList.remove('in-sel'));
    const finish = () => {
      const s = days[Math.min(a, b)];
      const en = addDays(days[Math.max(a, b)], 1);
      app.newEvent({ start: s.getTime(), end: en.getTime(), allDay: true, quick: true, anchor: adCells[Math.max(a, b)], onClose: clear });
    };
    paint();
    track(e, {
      cursor: 'default',
      onMove: (ev) => {
        b = adColAt(ev.clientX);
        paint();
      },
      onEnd: finish,
      onClick: finish,
      onCancel: clear,
    });
  });

  function onAllDayDrag(e, o, el) {
    const c0 = adColAt(e.clientX);
    let delta = 0;
    let ghost = null;
    track(e, {
      onStart: () => {
        if (o.readOnly) return;
        el.classList.add('dragging');
        ghost = el.cloneNode(true);
        ghost.classList.add('ac-ghost-inline');
        ghost.classList.remove('dragging', 'selected');
        adGrid.appendChild(ghost);
      },
      onMove: (ev) => {
        if (!ghost) return;
        const c = adColAt(ev.clientX);
        delta = localDayNum(days[c]) - localDayNum(days[c0]);
        const [sc, ec] = el.style.gridColumn.split('/').map((x) => Number(x.trim()));
        const len = ec - sc;
        const ns = Math.max(1, Math.min(n, sc + (c - c0)));
        ghost.style.gridColumn = `${ns} / ${Math.min(n + 1, ns + len)}`;
      },
      onEnd: () => {
        ghost?.remove();
        el.classList.remove('dragging');
        if (!ghost || !delta) return;
        const s = new Date(o.start);
        s.setDate(s.getDate() + delta);
        const en = new Date(o.end);
        en.setDate(en.getDate() + delta);
        app.moveOcc(o, o.allDay ? s : s.getTime(), o.allDay ? en : en.getTime());
      },
      onCancel: () => {
        ghost?.remove();
        el.classList.remove('dragging');
      },
      onClick: () => {
        el.focus({ preventScroll: true });
        app.select(o, el);
      },
    });
  }

  // ---------------------------------------------------------------- scroll position
  function initialScroll() {
    if (app.tgScroll != null) {
      scroll.scrollTop = app.tgScroll;
      return;
    }
    const now = new Date();
    const showsToday = cols.some((c) => sameDay(c.d, now));
    const target = showsToday ? Math.max(0, minutesOfDay(now) - 120) : Math.max(0, app.prefs.workStart * 60 - 30);
    scroll.scrollTop = target * PX_MIN;
  }

  return {
    el: root,
    mounted() {
      layoutAllDay();
      layoutTimed();
      placeNow();
      initialScroll();
    },
    resize() {
      fitInline();
    },
    tick: placeNow,
    scrollTop: () => scroll.scrollTop,
    scrollToNow() {
      const now = new Date();
      if (!cols.some((c) => sameDay(c.d, now))) return;
      scroll.scrollTo({ top: Math.max(0, minutesOfDay(now) - 120) * PX_MIN, behavior: app.reduceMotion() ? 'auto' : 'smooth' });
    },
    destroy() {},
  };
}
