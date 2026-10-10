// Agenda (upcoming events grouped by day) and search results.
import { addDays, sameDay, startOfDay, localKey, localDayNum } from '../lib/dates.mjs';
import { matches } from '../lib/events.mjs';
import { css } from './util.js';

// Accessible one-line description of an occurrence (chips, tooltips).
export function chipLabel(app, o) {
  const parts = [o.title || app.t('noTitle'), app.fmt.occRange(o)];
  if (o.location) parts.push(o.location);
  if (o.recurring) parts.push(app.t('recurringEvent'));
  if (o.holiday) parts.push(app.calName(app.calendar(o.calendarId)));
  return parts.join(', ');
}

function dayTitle(app, d) {
  const today = startOfDay(new Date());
  const diff = localDayNum(d) - localDayNum(today);
  const sameYear = d.getFullYear() === today.getFullYear();
  const date = sameYear ? app.fmt.dayLongNoYear(d) : app.fmt.dayLong(d);
  if (diff === 0) return { lead: app.t('today'), date };
  if (diff === 1) return { lead: app.t('tomorrow'), date };
  if (diff === -1) return { lead: app.t('yesterday'), date };
  return { lead: null, date };
}

function row(app, o, d, { highlight } = {}) {
  const { h, icon } = app.ctx;
  const t = app.t;
  let when;
  if (o.allDay) when = t('allDay');
  else if (sameDay(o.start, d)) when = app.fmt.time(o.start);
  else if (o.end < addDays(d, 1).getTime()) when = t('untilTime', { time: app.fmt.time(o.end) });
  else when = t('allDay');
  const sub = [];
  if (!o.allDay) sub.push(app.fmt.occRange(o));
  else if (o.end - o.start > 86400000 + 3600000) sub.push(app.fmt.occRange(o));
  if (o.holiday) sub.push(t(`holidayKind.${o.holiday.kind}`));
  if (o.location) sub.push(o.location);
  const cal = app.calendar(o.calendarId);
  const titleEl = h('div', { class: 'ac-ag-title ellipsis' });
  appendHighlighted(titleEl, o.title || t('noTitle'), highlight);
  const el = h(
    'div',
    {
      class: ['ac-ag-row', app.isSelected(o) && 'selected'],
      role: 'button',
      tabindex: '0',
      style: css({ '--ev': o.color }),
      'aria-label': chipLabel(app, o),
      dataset: { eventId: o.eventId, key: String(o.key) },
    },
    h('div', { class: 'ac-ag-when' }, when),
    h('div', { class: 'ac-ag-bar' }),
    h(
      'div',
      { class: 'ac-ag-main' },
      titleEl,
      h('div', { class: 'ac-ag-sub caption ellipsis' }, sub.join(' · ')),
    ),
    h(
      'div',
      { class: 'ac-ag-icons' },
      o.recurring ? icon('arrow_repeat_all', { size: 14 }) : null,
      o.reminder != null ? icon('alert', { size: 14 }) : null,
      h('span', { class: 'ac-ag-cal caption ellipsis' }, app.calName(cal)),
    ),
  );
  el.addEventListener('click', () => app.select(o, el));
  el.addEventListener('dblclick', () => app.edit(o));
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
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      const all = [...app.viewEl.querySelectorAll('.ac-ag-row')];
      const i = all.indexOf(el) + (e.key === 'ArrowDown' ? 1 : -1);
      if (i >= 0 && i < all.length) all[i].focus();
      else if (i < 0 && app.state.search) app.searchInput.focus();
    } else if (e.key === 'Delete' && !o.readOnly) {
      e.preventDefault();
      e.stopPropagation();
      app.deleteOcc(o);
    }
  });
  el.addEventListener('focus', () => app.select(o, el, { peek: false }));
  return el;
}

function appendHighlighted(el, text, q) {
  if (!q) {
    el.textContent = text;
    return;
  }
  const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  // map normalized indexes back to the original string (NFD may expand accented letters)
  const words = norm(q).split(/\s+/).filter(Boolean);
  const chars = [...text];
  const normChars = chars.map((c) => norm(c));
  const flat = normChars.join('');
  const mark = new Array(chars.length).fill(false);
  const starts = [];
  let pos = 0;
  for (const nc of normChars) {
    starts.push(pos);
    pos += nc.length;
  }
  for (const w of words) {
    let i = flat.indexOf(w);
    while (i >= 0) {
      for (let k = 0; k < chars.length; k++) if (starts[k] < i + w.length && starts[k] + normChars[k].length > i) mark[k] = true;
      i = flat.indexOf(w, i + w.length);
    }
  }
  let buf = '';
  let on = false;
  const flush = () => {
    if (!buf) return;
    el.appendChild(on ? Object.assign(document.createElement('mark'), { textContent: buf }) : document.createTextNode(buf));
    buf = '';
  };
  chars.forEach((c, k) => {
    if (mark[k] !== on) {
      flush();
      on = mark[k];
    }
    buf += c;
  });
  flush();
}

function groupByDay(occs, from, to) {
  const groups = new Map();
  for (const o of occs) {
    // an event appears under every day it covers (within the range)
    let d = startOfDay(new Date(Math.max(o.start, from.getTime())));
    const last = o.end > o.start ? o.end - 1 : o.start;
    for (let guard = 0; d.getTime() <= last && d < to && guard < 400; guard++, d = addDays(d, 1)) {
      const k = localKey(d);
      if (!groups.has(k)) groups.set(k, { d: new Date(d), items: [] });
      groups.get(k).items.push(o);
    }
  }
  return [...groups.values()].sort((a, b) => a.d - b.d);
}

function dayGroup(app, g, opts) {
  const { h } = app.ctx;
  const title = dayTitle(app, g.d);
  return h(
    'section',
    { class: ['ac-ag-day', sameDay(g.d, new Date()) && 'today'], dataset: { date: localKey(g.d) } },
    h('h3', { class: 'ac-ag-head' }, title.lead ? h('span', { class: 'ac-ag-lead' }, title.lead) : null, h('span', null, title.date)),
    g.items.map((o) => row(app, o, g.d, opts)),
  );
}

export function renderAgenda(app) {
  const { h, icon } = app.ctx;
  const t = app.t;
  const from = startOfDay(app.state.date);
  const to = addDays(from, app.agendaDays);
  const occs = app.occurrences(from, to);
  const groups = groupByDay(occs, from, to);
  const list = h('div', { class: 'ac-ag-list' });
  if (!groups.length) {
    list.appendChild(
      h(
        'div',
        { class: 'empty ac-ag-empty' },
        icon('calendar_empty', { size: 48 }),
        h('div', { class: 'subtitle' }, t('agendaEmpty')),
        h('div', { class: 'text-2' }, t('agendaEmptyHint', { count: app.agendaDays })),
        h('button', { class: 'btn primary', type: 'button', onclick: () => app.newEvent() }, t('newEvent')),
      ),
    );
  } else for (const g of groups) list.appendChild(dayGroup(app, g));
  const more = h(
    'button',
    {
      class: 'btn ac-ag-more',
      type: 'button',
      onclick: () => {
        app.agendaDays += 30;
        app.render({ animate: false, keepScroll: true });
        app.viewEl.querySelector('.ac-ag-scroll').scrollTop = sc;
      },
    },
    t('showMoreDays', { count: 30 }),
  );
  let sc = 0;
  const scroll = h('div', { class: 'ac-ag-scroll', onscroll: (e) => (sc = e.target.scrollTop) }, list, groups.length ? h('div', { class: 'ac-ag-footer' }, h('span', { class: 'caption text-2' }, t('showingUntil', { date: app.fmt.dayMed(addDays(to, -1)) })), more) : null);
  const root = h('div', { class: 'ac-agenda' }, scroll);
  return { el: root };
}

export function renderSearch(app, query) {
  const { h, icon } = app.ctx;
  const t = app.t;
  const today = startOfDay(new Date());
  const from = addDays(today, -366);
  const to = addDays(today, 731);
  const all = app.occurrences(from, to).filter((o) => matches(o, query));
  const upcoming = all.filter((o) => o.end > Date.now() || o.start >= today.getTime());
  const past = all.filter((o) => !upcoming.includes(o)).reverse();
  const shownUp = upcoming.slice(0, 200);
  const shownPast = past.slice(0, 100);
  const root = h('div', { class: 'ac-agenda ac-search-results' });
  const scroll = h('div', { class: 'ac-ag-scroll' });
  root.appendChild(scroll);
  scroll.appendChild(h('div', { class: 'ac-sr-head' }, h('div', { class: 'subtitle' }, t('resultsFor', { query })), h('div', { class: 'caption text-2' }, t('resultCount', { count: all.length }))));
  if (!all.length) {
    scroll.appendChild(h('div', { class: 'empty' }, icon('search', { size: 48 }), h('div', null, t('noResults')), h('div', { class: 'caption text-2' }, t('noResultsHint'))));
    return { el: root };
  }
  const section = (label, occs) => {
    if (!occs.length) return;
    scroll.appendChild(h('h2', { class: 'ac-sr-section caption' }, label));
    // results show each occurrence once, under its start day
    const groups = new Map();
    for (const o of occs) {
      const d = startOfDay(new Date(o.start));
      const k = localKey(d);
      if (!groups.has(k)) groups.set(k, { d, items: [] });
      groups.get(k).items.push(o);
    }
    for (const g of groups.values()) scroll.appendChild(dayGroup(app, g, { highlight: query }));
  };
  section(t('upcoming'), shownUp);
  section(t('past'), shownPast);
  return { el: root };
}
