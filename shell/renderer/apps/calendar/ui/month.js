// Month view (Outlook style): 4–6 week rows, all-day / multi-day events as bars spanning days, timed
// events as "● 9:00 AM Title" lines, "+N more" when a day overflows. Click a day to quick-create an
// all-day event, drag across days for a multi-day one, drag an event to another day to move it.
import { addDays, sameDay, localKey, localDayNum, weekNumber, localFromKey } from '../lib/dates.mjs';
import { packLanes } from '../lib/layout.mjs';
import { track } from './drag.js';
import { openPopover } from './pickers.js';
import { chipLabel } from './agenda.js';
import { css } from './util.js';

const LANE_H = 22;
const LANE_GAP = 2;
const HEAD_H = 30;

export function renderMonth(app) {
  const { h } = app.ctx;
  const t = app.t;
  const [gs, ge] = app.visibleRange('month');
  const weeks = Math.round((localDayNum(ge) - localDayNum(gs)) / 7);
  const month = app.state.date.getMonth();
  const today = new Date();
  const first = app.firstDay();
  const showWn = !!app.prefs.weekNumbers;
  const occs = app.occurrences(gs, ge);

  const head = h(
    'div',
    { class: 'ac-mo-head', role: 'row' },
    showWn ? h('div', { class: 'ac-mo-wnh', 'aria-hidden': 'true' }) : null,
    Array.from({ length: 7 }, (_, i) => {
      const d = addDays(gs, i);
      return h('div', { class: 'ac-mo-wd', role: 'columnheader', 'aria-label': app.fmt.weekdayLong(d) }, h('span', { class: 'long' }, app.fmt.weekdayLong(d)), h('span', { class: 'short' }, app.fmt.weekdayShort(d)));
    }),
  );
  const body = h('div', { class: 'ac-mo-body' });
  const root = h('div', { class: ['ac-month', showWn && 'weeks'], role: 'grid', 'aria-label': app.fmt.monthYear(app.state.date), style: css({ '--weeks': String(weeks) }) }, head, body);
  const rows = [];
  for (let w = 0; w < weeks; w++) {
    const ws = addDays(gs, 7 * w);
    const cells = [];
    const row = h('div', { class: 'ac-mo-week', role: 'row', dataset: { week: localKey(ws) } });
    if (showWn) {
      const wn = weekNumber(ws, first === 1 ? 1 : first);
      row.appendChild(
        h(
          'button',
          {
            class: 'ac-mo-wn',
            type: 'button',
            'aria-label': t('weekN', { n: wn }),
            'data-tip': t('weekN', { n: wn }),
            onclick: () => {
              app.state.date = ws;
              app.setView('week');
            },
          },
          String(wn),
        ),
      );
    }
    for (let i = 0; i < 7; i++) {
      const d = addDays(ws, i);
      const isToday = sameDay(d, today);
      const label = d.getDate() === 1 ? app.fmt.monthDayShort(d) : String(d.getDate());
      const cell = h(
        'div',
        {
          class: ['ac-mo-cell', d.getMonth() !== month && 'other', isToday && 'today', sameDay(d, app.state.date) && 'selected', !app.prefs.workDays.includes(d.getDay()) && 'weekend'],
          role: 'gridcell',
          'aria-label': app.fmt.dayLong(d),
          'aria-current': isToday ? 'date' : null,
          dataset: { date: localKey(d) },
        },
        h(
          'button',
          {
            class: 'ac-mo-num',
            type: 'button',
            tabindex: '-1',
            'aria-label': t('openDay', { date: app.fmt.dayLong(d) }),
            onclick: (e) => {
              e.stopPropagation();
              app.state.date = d;
              app.setView('day');
            },
          },
          label,
        ),
      );
      cell.addEventListener('pointerdown', (e) => onCellDown(e, d));
      cells.push(cell);
      row.appendChild(cell);
    }
    const layer = h('div', { class: 'ac-mo-items' });
    row.appendChild(layer);
    rows.push({ ws, row, cells, layer });
    body.appendChild(row);
  }

  // ---------------------------------------------------------------- events layout
  function weekItems(ws) {
    const we = addDays(ws, 7);
    const wsN = localDayNum(ws);
    const items = [];
    occs.forEach((o, order) => {
      if (!(o.start < we.getTime() && (o.end > ws.getTime() || (o.end === o.start && o.start >= ws.getTime())))) return;
      const sd = localDayNum(o.start);
      const ed = o.allDay ? localDayNum(o.end) : o.end > o.start ? localDayNum(o.end - 1) + 1 : sd + 1;
      const bar = o.allDay || ed - sd > 1;
      items.push({ o, order, bar, startDay: Math.max(sd, wsN) - wsN, endDay: Math.min(ed, wsN + 7) - wsN, contL: sd < wsN, contR: ed > wsN + 7 });
    });
    return packLanes(items);
  }

  function layout() {
    for (const r of rows) {
      app.ctx.ui.clear(r.layer);
      const rowH = r.row.clientHeight || 100;
      const lanes = Math.max(1, Math.floor((rowH - HEAD_H - 4 + LANE_GAP) / (LANE_H + LANE_GAP)));
      const items = weekItems(r.ws);
      const count = new Array(7).fill(0);
      for (const it of items) for (let d = it.startDay; d < it.endDay; d++) count[d]++;
      const limit = count.map((c) => (c > lanes ? lanes - 1 : lanes));
      const hidden = new Array(7).fill(0);
      for (const it of items) {
        let lim = Infinity;
        for (let d = it.startDay; d < it.endDay; d++) lim = Math.min(lim, limit[d]);
        if (it.lane >= lim) {
          for (let d = it.startDay; d < it.endDay; d++) hidden[d]++;
          continue;
        }
        r.layer.appendChild(chip(it));
      }
      const narrowCells = (r.cells[0]?.clientWidth || 100) < 92;
      hidden.forEach((n, d) => {
        if (!n) return;
        const date = addDays(r.ws, d);
        r.layer.appendChild(
          h(
            'button',
            {
              class: 'ac-more-btn',
              type: 'button',
              style: { gridColumn: String(d + 1), gridRow: String(Math.max(1, lanes)) },
              'aria-label': t('moreEventsOn', { count: n, date: app.fmt.dayLong(date) }),
              onpointerdown: (e) => e.stopPropagation(),
              onclick: (e) => dayPopover(date, e.currentTarget),
            },
            narrowCells ? `+${app.fmt.number(n)}` : t('moreN', { count: n }),
          ),
        );
      });
    }
  }

  function chip(it) {
    const { o } = it;
    const label = chipLabel(app, o);
    const el = h(
      'div',
      {
        class: ['ac-chip', it.bar ? 'bar' : 'timed', it.contL && 'cont-l', it.contR && 'cont-r', app.isSelected(o) && 'selected', o.readOnly && 'readonly', o.holiday && 'holiday'],
        style: css({ gridColumn: `${it.startDay + 1} / ${it.endDay + 1}`, gridRow: String(it.lane + 1), '--ev': o.color }),
        role: 'button',
        tabindex: '0',
        'aria-label': label,
        title: label,
        dataset: { eventId: o.eventId, key: String(o.key) },
      },
      it.bar
        ? [!o.allDay && !it.contL ? h('span', { class: 'ac-chip-time' }, app.fmt.chipTime(o.start)) : null, o.recurring ? app.ctx.icon('arrow_repeat_all', { size: 12, class: 'ac-rec' }) : null, h('span', { class: 'ac-chip-title' }, o.title || t('noTitle'))]
        : [h('span', { class: 'ac-chip-dot' }), h('span', { class: 'ac-chip-time' }, app.fmt.chipTime(o.start)), h('span', { class: 'ac-chip-title' }, o.title || t('noTitle'))],
    );
    el.addEventListener('pointerdown', (e) => onChipDown(e, o, el));
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
      }
    });
    el.addEventListener('focus', () => app.select(o, el, { peek: false }));
    return el;
  }

  // ---------------------------------------------------------------- interactions
  const cellAt = (x, y) => document.elementsFromPoint(x, y).find((n) => n.classList?.contains('ac-mo-cell') && root.contains(n));
  const dateOfCell = (c) => localFromKey(c.dataset.date);

  function onCellDown(e, d) {
    if (e.button !== 0 || e.target.closest('.ac-chip, .ac-more-btn, .ac-mo-num')) return;
    e.preventDefault();
    app.viewEl.focus({ preventScroll: true });
    let from = d;
    let to = d;
    const paint = () => {
      const a = from < to ? from : to;
      const b = from < to ? to : from;
      for (const r of rows) for (const c of r.cells) {
        const cd = dateOfCell(c);
        c.classList.toggle('in-sel', cd >= a && cd <= b);
      }
    };
    const finish = (anchorEl) => {
      const a = from < to ? from : to;
      const b = from < to ? to : from;
      app.state.date = a;
      for (const r of rows) for (const c of r.cells) c.classList.toggle('selected', sameDay(dateOfCell(c), a));
      app.mini.setState({ selected: a });
      app.newEvent({ start: a.getTime(), end: addDays(b, 1).getTime(), allDay: true, quick: true, anchor: anchorEl, onClose: () => clearSel() });
    };
    const clearSel = () => {
      for (const r of rows) for (const c of r.cells) c.classList.remove('in-sel');
    };
    paint();
    track(e, {
      cursor: 'default',
      onMove: (ev) => {
        const c = cellAt(ev.clientX, ev.clientY);
        if (c) {
          to = dateOfCell(c);
          paint();
        }
      },
      onEnd: (ev) => finish(cellAt(ev.clientX, ev.clientY) || e.target.closest('.ac-mo-cell')),
      onClick: () => finish(e.target.closest('.ac-mo-cell')),
      onCancel: () => clearSel(),
    });
  }

  function onChipDown(e, o, el) {
    if (e.button !== 0) return;
    e.stopPropagation();
    const startCell = cellAt(e.clientX, e.clientY);
    const grabDay = startCell ? dateOfCell(startCell) : new Date(o.start);
    let ghost = null;
    let target = null;
    track(e, {
      onStart: () => {
        if (o.readOnly) return;
        app.ctx.ui.closeMenus?.();
        ghost = h('div', { class: 'app-calendar ac-ghost' }, el.cloneNode(true));
        ghost.firstChild.classList.remove('selected');
        ghost.style.width = `${Math.min(el.getBoundingClientRect().width, 220)}px`;
        document.body.appendChild(ghost);
        el.classList.add('dragging');
      },
      onMove: (ev) => {
        if (!ghost) return;
        ghost.style.transform = `translate(${ev.clientX + 8}px, ${ev.clientY + 6}px)`;
        const c = cellAt(ev.clientX, ev.clientY);
        if (c !== target) {
          target?.classList.remove('drop-target');
          target = c;
          target?.classList.add('drop-target');
        }
      },
      onEnd: () => {
        ghost?.remove();
        el.classList.remove('dragging');
        target?.classList.remove('drop-target');
        if (!ghost || !target) return;
        const delta = localDayNum(dateOfCell(target)) - localDayNum(grabDay);
        if (!delta) return;
        const s = new Date(o.start);
        s.setDate(s.getDate() + delta);
        const en = new Date(o.end);
        en.setDate(en.getDate() + delta);
        app.moveOcc(o, o.allDay ? s : s.getTime(), o.allDay ? en : en.getTime());
      },
      onCancel: () => {
        ghost?.remove();
        el.classList.remove('dragging');
        target?.classList.remove('drop-target');
      },
      onClick: () => {
        el.focus({ preventScroll: true });
        app.select(o, el);
      },
    });
  }

  function dayPopover(date, anchor) {
    const next = addDays(date, 1);
    const list = occs.filter((o) => o.start < next.getTime() && (o.end > date.getTime() || (o.end === o.start && o.start >= date.getTime())));
    const content = h(
      'div',
      { class: 'ac-daypop' },
      h('div', { class: 'ac-daypop-head' }, h('div', { class: 'ac-daypop-wd caption' }, app.fmt.weekdayLong(date)), h('button', { class: 'ac-daypop-num', type: 'button', onclick: () => (pop.close('nav'), (app.state.date = date), app.setView('day')) }, String(date.getDate()))),
      h(
        'div',
        { class: 'ac-daypop-list' },
        list.map((o) => {
          const el = h(
            'button',
            { class: ['ac-chip', o.allDay ? 'bar' : 'timed', 'in-pop'], type: 'button', style: css({ '--ev': o.color }), dataset: { eventId: o.eventId, key: String(o.key) }, title: chipLabel(app, o) },
            o.allDay ? null : h('span', { class: 'ac-chip-dot' }),
            o.allDay ? null : h('span', { class: 'ac-chip-time' }, app.fmt.chipTime(o.start)),
            h('span', { class: 'ac-chip-title' }, o.title || t('noTitle')),
          );
          el.addEventListener('click', () => app.select(o, el));
          el.addEventListener('dblclick', () => app.edit(o));
          return el;
        }),
      ),
    );
    const pop = openPopover({ anchor, content, className: 'ac-pop-day', owner: app.win, label: app.fmt.dayLong(date) });
  }

  return {
    el: root,
    mounted: () => layout(),
    resize: () => layout(),
  };
}
