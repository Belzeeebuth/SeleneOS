// Event flyouts and editor:
//   showPeek(app, occ, anchor)          event card (Edit / Delete) next to the clicked event
//   quickCreate(app, draft, anchor)     "Add a title" flyout after selecting a slot (Save / More options)
//   openEditor(app, { ev, occ, mode, draft })   full editor dialog (series, single occurrence or new)
//   askSeries(app, 'edit')  -> 'occurrence' | 'series' | null
//   askDeleteSeries(app, occ) -> 'one' | 'following' | 'all' | null
import { openPopover, dateField, timeField, closeAllPopovers } from './pickers.js';
import { recurrencePresets, presetOf } from './fmt.js';
import { PALETTE } from '../lib/store.mjs';
import { newId, sanitizeEvent } from '../lib/events.mjs';
import { addDays, startOfDay, localKey, localFromKey, sameDay, weekdayPosition } from '../lib/dates.mjs';
import { systemTz } from '../lib/tz.mjs';
import { parseByday, formatByday } from '../lib/rrule.mjs';
import { css } from './util.js';

const WD = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

const seriesStart = (ev) => (ev.allDay ? localFromKey(ev.start) : new Date(ev.start));

function anchorFor(anchor) {
  if (!anchor) return { left: window.innerWidth / 2 - 10, right: window.innerWidth / 2 + 10, top: window.innerHeight / 3, bottom: window.innerHeight / 3 + 10, width: 20, height: 10 };
  const r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : anchor;
  if (r.width > 520 || r.height > 400) {
    const cx = r.left + r.width / 2;
    const cy = r.top + Math.min(r.height / 3, 200);
    return { left: cx - 10, right: cx + 10, top: cy, bottom: cy + 10, width: 20, height: 10 };
  }
  // keep the anchor inside the visible part of a scrolled grid
  const sc = anchor.closest?.('.ac-tg-scroll, .ac-ag-scroll');
  if (sc) {
    const s = sc.getBoundingClientRect();
    const top = Math.max(r.top, s.top);
    const bottom = Math.min(r.bottom, s.bottom);
    if (bottom > top) return { left: r.left, right: r.right, top, bottom, width: r.width, height: bottom - top };
  }
  return r;
}

// ------------------------------------------------------------------ peek
export function showPeek(app, o, anchor) {
  const { h, icon } = app.ctx;
  const t = app.t;
  closeAllPopovers('peek');
  const cal = app.calendar(o.calendarId);
  const line = (ic, content, cls) => h('div', { class: ['ac-peek-row', cls] }, icon(ic, { size: 16 }), h('div', { class: 'ac-peek-text' }, content));
  const rows = [line('clock', app.fmt.occWhen(o))];
  if (o.recurring && o.ev) rows.push(line('arrow_repeat_all', `${app.fmt.recurrence(o.ev.rrule, seriesStart(o.ev))}${o.exception ? ` · ${t('occurrenceChanged')}` : ''}`));
  if (o.location) rows.push(line('location', o.location, 'selectable'));
  if (o.reminder != null) rows.push(line('alert', app.fmt.reminder(o.reminder, o.allDay)));
  rows.push(h('div', { class: 'ac-peek-row' }, h('span', { class: 'ac-dot', style: css({ '--ev': cal?.color || o.color }) }), h('div', { class: 'ac-peek-text' }, app.calName(cal))));
  if (o.holiday) rows.push(line('flag', t(`holidayKind.${o.holiday.kind}`)));
  const desc = o.description ? h('div', { class: 'ac-peek-desc selectable' }, o.description) : null;
  let pop;
  const actions = o.readOnly
    ? null
    : h(
        'div',
        { class: 'ac-peek-actions' },
        h('button', { class: 'btn ac-peek-edit', type: 'button', onclick: () => (pop.close('edit'), app.edit(o)) }, icon('edit', { size: 16 }), t('edit')),
        h('button', { class: 'btn subtle ac-peek-delete', type: 'button', onclick: () => (pop.close('delete'), app.deleteOcc(o)) }, icon('delete', { size: 16 }), t('delete')),
      );
  const content = h(
    'div',
    { class: 'ac-peek', style: css({ '--ev': o.color }) },
    h('div', { class: 'ac-peek-head' }, h('div', { class: 'ac-peek-title selectable' }, o.title || t('noTitle'))),
    h('div', { class: 'ac-peek-body' }, rows, desc),
    actions,
  );
  content.addEventListener('keydown', (e) => {
    if (e.key === 'Delete' && !o.readOnly) {
      e.preventDefault();
      pop.close('delete');
      app.deleteOcc(o);
    }
  });
  pop = openPopover({
    anchor: anchorFor(anchor),
    content,
    className: 'ac-pop-peek',
    placement: 'side',
    owner: app.win,
    label: o.title || t('noTitle'),
    focus: () => content.querySelector('.ac-peek-edit') || content,
  });
  app.peek = pop;
  return pop;
}

// ------------------------------------------------------------------ quick create
export function quickCreate(app, draft, anchor, onClose) {
  const { h, icon } = app.ctx;
  const t = app.t;
  closeAllPopovers('quick');
  const title = h('input', { class: 'input ac-quick-title', type: 'text', placeholder: t('addTitle'), 'aria-label': t('title'), maxlength: 2000 });
  const allDay = !!draft.allDay;
  const s = new Date(draft.start);
  const lastDay = addDays(new Date(draft.end), -1);
  let when;
  if (allDay) when = sameDay(s, lastDay) ? `${app.fmt.dayMed(s)} · ${t('allDay')}` : `${app.fmt.dayMed(s)} – ${app.fmt.dayMed(lastDay)}`;
  else when = `${app.fmt.dayMed(s)} · ${app.fmt.time(draft.start)} – ${app.fmt.time(draft.end)}`;
  const calSel = calendarSelect(app, draft.calendarId);
  const loc = h('input', { class: 'input ac-quick-loc', type: 'text', placeholder: t('addLocation'), 'aria-label': t('location') });
  let pop;
  const save = async () => {
    const ev = buildNew(app, { ...draft, title: title.value.trim(), location: loc.value.trim(), calendarId: calSel.value });
    pop.close('save');
    await app.upsert(ev);
    app.toast(t('eventCreated', { title: ev.title || t('noTitle') }));
  };
  const more = () => {
    pop.close('more');
    openEditor(app, { draft: { ...draft, title: title.value.trim(), location: loc.value.trim(), calendarId: calSel.value } });
  };
  const content = h(
    'form',
    {
      class: 'ac-quick',
      onsubmit: (e) => {
        e.preventDefault();
        save();
      },
    },
    h('div', { class: 'ac-quick-head' }, h('span', { class: 'ac-dot', style: css({ '--ev': app.calendar(calSel.value)?.color }) }), title),
    h('div', { class: 'ac-quick-row' }, icon('clock', { size: 16 }), h('span', { class: 'ac-quick-when' }, when)),
    h('div', { class: 'ac-quick-row' }, icon('location', { size: 16 }), loc),
    h('div', { class: 'ac-quick-row' }, icon('calendar', { size: 16 }), calSel),
    h(
      'div',
      { class: 'ac-quick-actions' },
      h('button', { class: 'btn', type: 'button', onclick: more }, t('moreOptions')),
      h('button', { class: 'btn primary', type: 'submit' }, t('save')),
    ),
  );
  calSel.addEventListener('change', () => content.querySelector('.ac-quick-head .ac-dot').style.setProperty('--ev', app.calendar(calSel.value)?.color));
  pop = openPopover({ anchor: anchorFor(anchor), content, className: 'ac-pop-quick', placement: 'side', owner: app.win, label: t('newEvent'), focus: () => title, onClose: (r) => onClose?.(r) });
  return pop;
}

function calendarSelect(app, value) {
  const { h } = app.ctx;
  const sel = h(
    'select',
    { class: 'select ac-cal-select', 'aria-label': app.t('calendar') },
    app.userCalendars().map((c) => h('option', { value: c.id, selected: c.id === value }, app.calName(c))),
  );
  return sel;
}

function buildNew(app, d) {
  const allDay = !!d.allDay;
  const defRem = app.prefs.defaultReminder;
  const ev = {
    id: newId('e'),
    calendarId: d.calendarId || app.defaultCalendarId(),
    title: d.title || '',
    location: d.location || '',
    description: d.description || '',
    color: null,
    allDay,
    start: allDay ? localKey(d.start) : d.start,
    end: allDay ? localKey(d.end) : d.end,
    tz: systemTz(),
    rrule: null,
    reminder: allDay ? (defRem == null ? null : 900) : defRem,
    created: Date.now(),
    updated: Date.now(),
  };
  if (allDay && ev.end <= ev.start) ev.end = localKey(addDays(localFromKey(ev.start), 1));
  return sanitizeEvent(ev);
}

// ------------------------------------------------------------------ prompts
export async function askSeries(app) {
  const t = app.t;
  const v = await app.ctx.ui.dialog({
    title: t('recurringTitle'),
    body: t('recurringOpenQuestion'),
    parent: app.win,
    buttons: [
      { label: t('openOccurrence'), value: 'occurrence', primary: true },
      { label: t('openSeries'), value: 'series' },
      { label: t('cancel'), value: null },
    ],
    className: 'ac-series-dialog',
  });
  return v;
}

export async function askDeleteSeries(app, o) {
  const { h, ui } = app.ctx;
  const t = app.t;
  let choice = 'one';
  const opt = (value, label) =>
    h('label', { class: 'radio ac-radio' }, h('input', { type: 'radio', name: 'ac-del', value, checked: value === choice, onchange: () => (choice = value) }), h('span', null, label));
  const body = h(
    'div',
    { class: 'ac-del-body' },
    h('p', { class: 'ac-del-q' }, t('deleteRecurringQuestion', { title: o.title || t('noTitle') })),
    opt('one', t('deleteThis')),
    opt('following', t('deleteFollowing')),
    opt('all', t('deleteAll')),
  );
  const v = await ui.dialog({
    title: t('deleteRecurringTitle'),
    body,
    parent: app.win,
    buttons: [
      { label: t('delete'), value: 'ok', primary: true },
      { label: t('cancel'), value: null },
    ],
    className: 'ac-del-dialog',
  });
  return v === 'ok' ? choice : null;
}

// ------------------------------------------------------------------ full editor
const REMINDERS_TIMED = [null, 0, 5, 15, 30, 60, 120, 1440];
const REMINDERS_ALLDAY = [null, -540, 900, 9540];

export function openEditor(app, { ev = null, occ = null, mode = 'series', draft = null } = {}) {
  const { h, icon, ui } = app.ctx;
  const t = app.t;
  closeAllPopovers('editor');
  const isNew = !ev;
  const single = !isNew && mode === 'occurrence' && !!ev.rrule;
  // ---- initial values
  let f;
  if (isNew) {
    f = {
      title: draft.title || '',
      location: draft.location || '',
      description: '',
      calendarId: draft.calendarId,
      color: null,
      allDay: !!draft.allDay,
      start: new Date(draft.start),
      end: new Date(draft.end),
      rule: null,
      reminder: draft.allDay ? (app.prefs.defaultReminder == null ? null : 900) : app.prefs.defaultReminder,
    };
  } else {
    const src = single ? occ : ev;
    const allDay = ev.allDay;
    // views resolve occurrence colours from their calendar: read the event's own colour instead
    const ov = single ? ev.overrides?.[occ.key] : null;
    f = {
      title: src.title,
      location: src.location,
      description: src.description,
      calendarId: src.calendarId,
      color: (ov && ov.color !== undefined ? ov.color : ev.color) ?? null,
      allDay,
      start: single ? new Date(occ.start) : allDay ? localFromKey(ev.start) : new Date(ev.start),
      end: single ? new Date(occ.end) : allDay ? localFromKey(ev.end) : new Date(ev.end),
      rule: ev.rrule ? JSON.parse(JSON.stringify(ev.rrule)) : null,
      reminder: src.reminder,
    };
  }
  // all-day events show an inclusive end date
  if (f.allDay) f.end = addDays(startOfDay(f.end), -1);
  if (f.allDay && f.end < f.start) f.end = new Date(f.start);
  if (!f.allDay && f.end < f.start) f.end = new Date(f.start);
  const initial = JSON.stringify(f);

  // ---- recurrence state
  const rs = {
    preset: presetOf(f.rule, f.start),
    freq: f.rule?.freq || 'WEEKLY',
    interval: f.rule?.interval || 1,
    days: new Set((f.rule?.byday || []).map(parseByday).filter((b) => b && !b.n).map((b) => b.wd)),
    monthMode: 'day',
    end: f.rule?.count ? 'count' : f.rule?.until != null ? 'until' : 'never',
    count: f.rule?.count || 10,
    until: f.rule?.until != null ? (typeof f.rule.until === 'string' ? localFromKey(f.rule.until) : startOfDay(new Date(f.rule.until))) : addDays(f.start, 90),
  };
  if (!rs.days.size) rs.days.add(f.start.getDay());
  if (f.rule?.freq === 'MONTHLY') {
    const b = f.rule.byday?.length === 1 ? parseByday(f.rule.byday[0]) : null;
    rs.monthMode = b?.n === -1 ? 'last' : b?.n ? 'nth' : f.rule.bymonthday?.[0] === -1 ? 'lastDay' : 'day';
  }

  // ---- controls
  const title = h('input', { class: 'input ac-ed-title', type: 'text', value: f.title, placeholder: t('addTitle'), 'aria-label': t('title'), maxlength: 2000 });
  const swatch = h('button', { class: 'ac-ed-swatch', type: 'button', 'aria-label': t('eventColor'), 'data-tip': t('eventColor'), onclick: () => pickColor() });
  const calSel = calendarSelect(app, f.calendarId);
  const sDate = dateField(app, { value: f.start, label: t('startDate'), onChange: (d) => onStartDate(d) });
  const eDate = dateField(app, { value: f.end, label: t('endDate'), onChange: (d) => ((f.end = setDate(f.end, d)), validate()) });
  const minOf = (d) => d.getHours() * 60 + d.getMinutes();
  const sTime = timeField(app, { value: minOf(f.start), label: t('startTime'), onChange: (m) => onStartTime(m) });
  const eTime = timeField(app, { value: minOf(f.end), label: t('endTime'), from: () => (sameDay(f.start, f.end) ? minOf(f.start) : null), onChange: (m) => ((f.end = setMinutes(f.end, m)), validate()) });
  const allDayToggle = ui.toggle({ checked: f.allDay, label: t('allDay'), disabled: single, onchange: (v) => onAllDay(v) });
  allDayToggle.classList.add('ac-ed-allday');
  const repeatSel = h('select', { class: 'select ac-ed-repeat', 'aria-label': t('repeat'), disabled: single, onchange: () => onRepeat() });
  const custom = h('div', { class: 'ac-ed-custom' });
  const endsRow = h('div', { class: 'ac-ed-ends' });
  const remSel = h('select', { class: 'select ac-ed-reminder', 'aria-label': t('reminder'), onchange: () => (f.reminder = remSel.value === '' ? null : Number(remSel.value)) });
  const loc = h('input', { class: 'input ac-ed-loc', type: 'text', value: f.location, placeholder: t('addLocation'), 'aria-label': t('location'), maxlength: 2000 });
  const desc = h('textarea', { class: 'textarea ac-ed-desc', placeholder: t('addDescription'), 'aria-label': t('description'), rows: 4 });
  desc.value = f.description || '';
  const err = h('div', { class: 'ac-ed-error caption', role: 'alert' });
  const seriesNote = single ? h('div', { class: 'ac-ed-note caption' }, icon('info', { size: 14 }), h('span', null, t('editingOccurrence'))) : null;

  const field = (ic, label, ...content) => h('div', { class: 'ac-ed-field' }, h('span', { class: 'ac-ed-ic', 'aria-hidden': 'true', 'data-tip': label }, icon(ic, { size: 16 })), h('div', { class: 'ac-ed-ctl' }, ...content));
  const timeRow = h(
    'div',
    { class: 'ac-ed-when' },
    h('div', { class: 'ac-ed-dt' }, h('span', { class: 'ac-ed-dtlabel' }, t('start')), sDate, sTime),
    h('div', { class: 'ac-ed-dt' }, h('span', { class: 'ac-ed-dtlabel' }, t('end')), eDate, eTime),
  );
  const body = h(
    'div',
    { class: 'ac-editor' },
    seriesNote,
    h('div', { class: 'ac-ed-head' }, swatch, title),
    field('calendar', t('calendar'), calSel),
    field('clock', t('when'), timeRow, allDayToggle),
    field('arrow_repeat_all', t('repeat'), repeatSel, custom, endsRow),
    field('alert', t('reminder'), remSel),
    field('location', t('location'), loc),
    field('text_description', t('description'), desc),
    err,
  );

  // ---- behaviour
  function setDate(target, d) {
    const x = new Date(target);
    x.setFullYear(d.getFullYear(), d.getMonth(), d.getDate());
    return x;
  }
  function setMinutes(target, m) {
    const x = new Date(target);
    x.setHours(Math.floor(m / 60), m % 60, 0, 0);
    return x;
  }
  function onStartDate(d) {
    const dur = f.end - f.start;
    f.start = setDate(f.start, d);
    f.end = f.allDay ? addDays(f.start, Math.round(dur / 86400000)) : new Date(f.start.getTime() + dur);
    if (f.allDay) f.end = startOfDay(f.end);
    eDate.setValue(f.end);
    eTime.setValue(minOf(f.end));
    if (rs.preset !== 'custom' && rs.preset !== 'none') syncPresetFromStart();
    if (rs.preset === 'custom' && rs.freq === 'WEEKLY' && rs.days.size === 1) rs.days = new Set([f.start.getDay()]);
    renderRepeat();
    validate();
  }
  function onStartTime(m) {
    const dur = f.end - f.start;
    f.start = setMinutes(f.start, m);
    f.end = new Date(f.start.getTime() + dur);
    eDate.setValue(f.end);
    eTime.setValue(minOf(f.end));
    validate();
  }
  function onAllDay(v) {
    f.allDay = v;
    if (v) {
      f.start = startOfDay(f.start);
      f.end = startOfDay(f.end);
      if (f.end < f.start) f.end = new Date(f.start);
      if (f.reminder != null && !REMINDERS_ALLDAY.includes(f.reminder)) f.reminder = 900;
    } else {
      const base = app.defaultSlot(f.start);
      const s = new Date(base.start);
      f.start = setMinutes(f.start, s.getHours() * 60 + s.getMinutes());
      f.end = sameDay(f.start, f.end) ? new Date(f.start.getTime() + (app.prefs.defaultDuration || 30) * 60000) : setMinutes(f.end, minOf(f.start) + 30);
      if (f.reminder != null && !REMINDERS_TIMED.includes(f.reminder)) f.reminder = app.prefs.defaultReminder;
      sTime.setValue(minOf(f.start));
      eTime.setValue(minOf(f.end));
      eDate.setValue(f.end);
    }
    body.classList.toggle('all-day', v);
    renderReminders();
    validate();
  }
  function syncPresetFromStart() {
    // keep "every week on <weekday>" etc. in line with the new start date
    const p = recurrencePresets(f.start).find((x) => x.id === rs.preset);
    if (!p) rs.preset = rs.preset.startsWith('monthly') ? 'monthlyDay' : rs.preset;
  }
  function presetLabel(p) {
    const s = f.start;
    const wdName = app.fmt.weekdayLong(s);
    switch (p.id) {
      case 'none':
        return t('rep.none');
      case 'daily':
        return t('rep.daily');
      case 'weekdays':
        return t('rep.weekdaysLong');
      case 'weekly':
        return t('rep.weeklyOn', { days: wdName });
      case 'monthlyDay':
        return t('rep.monthly', { what: t('rep.onDay', { d: s.getDate() }) });
      case 'monthlyNth':
        return t('rep.monthly', { what: t('rep.onNth', { nth: app.fmt.ordinal(weekdayPosition(s.getFullYear(), s.getMonth(), s.getDate()).n), day: wdName }) });
      case 'monthlyLast':
        return t('rep.monthly', { what: t('rep.onNth', { nth: app.fmt.ordinal(-1), day: wdName }) });
      case 'monthlyLastDay':
        return t('rep.monthly', { what: t('rep.onLastDay') });
      case 'yearly':
        return t('rep.yearly', { what: t('rep.onDate', { date: app.fmt.monthDay(s) }) });
      default:
        return t('rep.custom');
    }
  }
  function renderRepeatOptions() {
    ui.clear(repeatSel);
    for (const p of [...recurrencePresets(f.start), { id: 'custom' }]) repeatSel.appendChild(h('option', { value: p.id, selected: p.id === rs.preset }, presetLabel(p)));
    if (single) {
      ui.clear(repeatSel);
      repeatSel.appendChild(h('option', { value: 'series' }, app.fmt.recurrence(ev.rrule, seriesStart(ev))));
    }
  }
  function onRepeat() {
    rs.preset = repeatSel.value;
    if (rs.preset === 'custom') {
      const cur = currentRule();
      if (cur) {
        rs.freq = cur.freq;
        rs.interval = cur.interval || 1;
      }
    }
    renderRepeat();
  }
  function renderRepeat() {
    renderRepeatOptions();
    ui.clear(custom);
    ui.clear(endsRow);
    custom.hidden = rs.preset !== 'custom' || single;
    endsRow.hidden = rs.preset === 'none' || single;
    if (!custom.hidden) {
      const unitSel = h(
        'select',
        { class: 'select ac-ed-unit', 'aria-label': t('repeatUnit'), onchange: () => ((rs.freq = unitSel.value), renderRepeat()) },
        ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].map((u) => h('option', { value: u, selected: u === rs.freq }, t(`unit.${u}`, { count: rs.interval }))),
      );
      const num = h('input', {
        class: 'input ac-ed-interval',
        type: 'number',
        min: 1,
        max: 99,
        value: rs.interval,
        'aria-label': t('repeatEvery'),
        oninput: () => {
          const v = Math.max(1, Math.min(99, Math.floor(Number(num.value) || 1)));
          rs.interval = v;
          for (const [i, u] of ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].entries()) unitSel.options[i].textContent = t(`unit.${u}`, { count: v });
        },
      });
      custom.appendChild(h('div', { class: 'ac-ed-every' }, h('span', null, t('repeatEvery')), num, unitSel));
      if (rs.freq === 'WEEKLY') {
        const first = app.firstDay();
        const daysRow = h('div', { class: 'ac-ed-days', role: 'group', 'aria-label': t('repeatOn') });
        for (let i = 0; i < 7; i++) {
          const wd = (first + i) % 7;
          const d = new Date(2026, 0, 4 + wd);
          const on = rs.days.has(wd);
          daysRow.appendChild(
            h(
              'button',
              {
                type: 'button',
                class: ['ac-ed-day', on && 'on'],
                'aria-pressed': String(on),
                'aria-label': app.fmt.weekdayLong(d),
                'data-tip': app.fmt.weekdayLong(d),
                onclick: (e) => {
                  if (rs.days.has(wd) && rs.days.size > 1) rs.days.delete(wd);
                  else rs.days.add(wd);
                  e.currentTarget.classList.toggle('on', rs.days.has(wd));
                  e.currentTarget.setAttribute('aria-pressed', String(rs.days.has(wd)));
                },
              },
              app.fmt.weekdayNarrow(d),
            ),
          );
        }
        custom.appendChild(daysRow);
      } else if (rs.freq === 'MONTHLY') {
        const s = f.start;
        const pos = weekdayPosition(s.getFullYear(), s.getMonth(), s.getDate());
        const wdName = app.fmt.weekdayLong(s);
        const opts = [['day', t('rep.onDay', { d: s.getDate() })]];
        if (pos.n <= 4) opts.push(['nth', t('rep.onNth', { nth: app.fmt.ordinal(pos.n), day: wdName })]);
        if (pos.last) opts.push(['last', t('rep.onNth', { nth: app.fmt.ordinal(-1), day: wdName })]);
        opts.push(['lastDay', t('rep.onLastDay')]);
        if (!opts.some((o) => o[0] === rs.monthMode)) rs.monthMode = 'day';
        custom.appendChild(
          h(
            'div',
            { class: 'ac-ed-month', role: 'radiogroup' },
            opts.map(([v, label]) =>
              h('label', { class: 'radio ac-radio' }, h('input', { type: 'radio', name: 'ac-month-mode', value: v, checked: rs.monthMode === v, onchange: () => (rs.monthMode = v) }), h('span', null, label)),
            ),
          ),
        );
      }
    }
    if (!endsRow.hidden) {
      const endSel = h(
        'select',
        { class: 'select ac-ed-endmode', 'aria-label': t('ends'), onchange: () => ((rs.end = endSel.value), renderRepeat()) },
        [
          ['never', t('endsNever')],
          ['until', t('endsOn')],
          ['count', t('endsAfter')],
        ].map(([v, l]) => h('option', { value: v, selected: rs.end === v }, l)),
      );
      endsRow.append(h('span', { class: 'ac-ed-ends-label' }, t('ends')), endSel);
      if (rs.end === 'until') endsRow.appendChild(dateField(app, { value: rs.until, label: t('endsOn'), onChange: (d) => ((rs.until = d), validate()) }));
      if (rs.end === 'count') {
        const cnt = h('input', { class: 'input ac-ed-count', type: 'number', min: 1, max: 999, value: rs.count, 'aria-label': t('occurrences'), oninput: () => (rs.count = Math.max(1, Math.min(999, Math.floor(Number(cnt.value) || 1)))) });
        endsRow.append(cnt, h('span', { class: 'text-2' }, t('occurrencesLabel')));
      }
    }
    validate();
  }
  function renderReminders() {
    ui.clear(remSel);
    const list = [...(f.allDay ? REMINDERS_ALLDAY : REMINDERS_TIMED)];
    if (f.reminder != null && !list.includes(f.reminder)) list.push(f.reminder);
    for (const m of list) remSel.appendChild(h('option', { value: m == null ? '' : String(m), selected: m === f.reminder }, app.fmt.reminder(m, f.allDay)));
  }
  function currentRule() {
    if (rs.preset === 'none') return null;
    let rule;
    if (rs.preset !== 'custom') {
      const p = recurrencePresets(f.start).find((x) => x.id === rs.preset);
      rule = p?.rule ? { ...p.rule } : null;
      // an untouched preset that came from the event keeps its exact original shape
      if (!isNew && !single && ev.rrule && presetOf(ev.rrule, f.start) === rs.preset) rule = { ...ev.rrule, count: null, until: null };
    } else {
      rule = { freq: rs.freq, interval: rs.interval };
      const wd = WD[f.start.getDay()];
      if (rs.freq === 'WEEKLY') rule.byday = [...rs.days].sort((a, b) => ((a - app.firstDay() + 7) % 7) - ((b - app.firstDay() + 7) % 7)).map((d) => WD[d]);
      else if (rs.freq === 'MONTHLY') {
        const pos = weekdayPosition(f.start.getFullYear(), f.start.getMonth(), f.start.getDate());
        if (rs.monthMode === 'nth') rule.byday = [formatByday({ n: pos.n, wd: f.start.getDay() })];
        else if (rs.monthMode === 'last') rule.byday = [`-1${wd}`];
        else if (rs.monthMode === 'lastDay') rule.bymonthday = [-1];
        else rule.bymonthday = [f.start.getDate()];
      }
    }
    if (!rule) return null;
    rule.count = null;
    rule.until = null;
    if (rs.end === 'count') rule.count = rs.count;
    else if (rs.end === 'until') rule.until = f.allDay ? localKey(rs.until) : new Date(rs.until.getFullYear(), rs.until.getMonth(), rs.until.getDate(), 23, 59, 59).getTime();
    return rule;
  }
  function validate() {
    let msg = '';
    if (f.allDay ? startOfDay(f.end) < startOfDay(f.start) : f.end < f.start) msg = t('errEndBeforeStart');
    else if (rs.preset !== 'none' && !single && rs.end === 'until' && startOfDay(rs.until) < startOfDay(f.start)) msg = t('errUntilBeforeStart');
    err.textContent = msg;
    body.classList.toggle('invalid', !!msg);
    const saveBtn = body.closest('.dialog')?.querySelector('.dialog-footer .btn.primary');
    if (saveBtn) saveBtn.disabled = !!msg;
    return !msg;
  }
  function paintSwatch() {
    const c = f.color || app.calendar(calSel.value)?.color || PALETTE[0];
    swatch.style.setProperty('--ev', c);
    swatch.classList.toggle('custom', !!f.color);
  }
  function pickColor() {
    const grid = h(
      'div',
      { class: 'ac-colors', role: 'radiogroup', 'aria-label': t('eventColor') },
      h(
        'button',
        { type: 'button', class: ['ac-color-auto', !f.color && 'on'], role: 'radio', 'aria-checked': String(!f.color), onclick: () => ((f.color = null), paintSwatch(), pop.close('pick')) },
        h('span', { class: 'ac-dot', style: css({ '--ev': app.calendar(calSel.value)?.color }) }),
        t('calendarColor'),
      ),
      h(
        'div',
        { class: 'ac-color-grid' },
        PALETTE.map((c) =>
          h('button', {
            type: 'button',
            class: ['ac-color', f.color === c && 'on'],
            role: 'radio',
            'aria-checked': String(f.color === c),
            'aria-label': c,
            style: css({ '--ev': c }),
            onclick: () => ((f.color = c), paintSwatch(), pop.close('pick')),
          }),
        ),
      ),
    );
    const pop = openPopover({ anchor: swatch, content: grid, className: 'ac-pop-colors', owner: app.win, label: t('eventColor') });
  }
  calSel.addEventListener('change', () => {
    f.calendarId = calSel.value;
    paintSwatch();
  });
  title.addEventListener('input', () => (f.title = title.value));
  loc.addEventListener('input', () => (f.location = loc.value));
  desc.addEventListener('input', () => (f.description = desc.value));

  body.classList.toggle('all-day', f.allDay);
  paintSwatch();
  renderRepeat();
  renderReminders();

  const dirty = () => JSON.stringify(f) !== initial || (rs.preset !== presetOf(f.rule, f.start) && !single);

  // ---- save
  async function save() {
    if (!validate()) return false;
    sTime.commit?.();
    eTime.commit?.();
    let start = new Date(f.start);
    let end = new Date(f.end);
    let rule = single ? undefined : currentRule();
    // weekly rules that skip the start day move the start to the first matching day (Outlook)
    if (rule?.freq === 'WEEKLY' && rule.byday?.length) {
      const wds = rule.byday.map((b) => WD.indexOf(b));
      let guard = 0;
      while (!wds.includes(start.getDay()) && guard++ < 7) {
        start = addDays(start, 1);
        end = addDays(end, 1);
      }
    }
    const base = {
      title: f.title.trim(),
      location: f.location.trim(),
      description: f.description,
      calendarId: calSel.value,
      color: f.color,
      reminder: f.reminder,
    };
    let timing;
    if (f.allDay) timing = { allDay: true, start: localKey(start), end: localKey(addDays(startOfDay(end), 1)) };
    else timing = { allDay: false, start: start.getTime(), end: end.getTime() };
    if (isNew) {
      const created = sanitizeEvent({ id: newId('e'), ...base, ...timing, tz: systemTz(), rrule: rule, created: Date.now(), updated: Date.now() });
      await app.upsert(created);
      app.toast(t('eventCreated', { title: created.title || t('noTitle') }));
    } else if (single) {
      await app.applyOccurrenceEdit(occ, { ...base, start: timing.start, end: timing.end });
      app.toast(t('eventSaved'));
    } else {
      const changes = { ...base, ...timing, rrule: rule };
      const timingChanged = timing.allDay !== ev.allDay || timing.start !== ev.start || timing.end !== ev.end;
      if (timingChanged) changes.tz = systemTz();
      if (timingChanged || JSON.stringify(rule) !== JSON.stringify(ev.rrule)) {
        const hasExceptions = ev.exdates?.length || Object.keys(ev.overrides || {}).length;
        if (hasExceptions && ev.rrule) {
          const ok = await ui.confirm(t('exceptionsWillBeLost'), { title: t('recurringTitle'), okLabel: t('save'), parent: app.win });
          if (!ok) return false;
        }
      }
      await app.applySeriesEdit(ev, changes);
      app.toast(t('eventSaved'));
    }
    return true;
  }

  const buttons = [{ label: t('save'), value: 'save', primary: true }];
  if (!isNew) buttons.push({ label: single ? t('deleteOccurrence') : t('delete'), value: 'delete' });
  buttons.push({ label: t('cancel'), value: 'cancel' });

  let busy = false;
  const state = { dirty, saving: false };
  app.editorState = state;
  const promise = ui.dialog({
    title: isNew ? t('newEvent') : single ? t('editOccurrence') : t('editEvent'),
    body,
    parent: app.win,
    className: 'ac-editor-dialog',
    closeOnEsc: false,
    buttons,
    onOpen: (dlg, done) => {
      state.done = done;
      // fit the window (a dialog lives inside it): 640 px, less in a small window
      const fit = () => (dlg.style.width = `${Math.max(300, Math.min(640, (app.win.body.clientWidth || 640) - 24))}px`);
      fit();
      const offResize = app.win.on('resize', fit);
      state.offResize = offResize;
      dlg._validate = (v) => {
        if (v === 'save') {
          if (busy) return false;
          if (!validate()) return false;
          busy = true;
          save().then(
            (ok) => {
              busy = false;
              if (ok) {
                dlg._validate = null;
                done('saved');
              }
            },
            (e) => {
              busy = false;
              ui.alert(t('saveFailed', { msg: e?.message || String(e) }), { parent: app.win });
            },
          );
          return false;
        }
        if ((v === 'cancel' || v === 'esc') && dirty()) {
          ui.confirm(t('discardQuestion'), { title: t('discardTitle'), okLabel: t('discard'), cancelLabel: t('keepEditing'), parent: app.win }).then((ok) => {
            if (ok) {
              dlg._validate = null;
              done('cancel');
            }
          });
          return false;
        }
        return true;
      };
      dlg.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !e.defaultPrevented) {
          e.preventDefault();
          e.stopPropagation();
          done('esc');
        } else if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'Enter')) {
          e.preventDefault();
          e.stopPropagation();
          done('save');
        }
      });
      setTimeout(() => {
        validate();
        title.focus();
        title.select();
      }, 40);
    },
  });
  return promise.then(async (v) => {
    state.offResize?.();
    app.editorState = null;
    closeAllPopovers('editor-closed');
    if (v === 'delete') {
      if (single) await app.deleteOcc(occ);
      else if (ev.rrule) {
        const ok = await ui.confirm(t('deleteSeriesConfirm', { title: ev.title || t('noTitle') }), { title: t('deleteRecurringTitle'), okLabel: t('delete'), danger: true, parent: app.win });
        if (ok) {
          const before = app.snapshot();
          await app.commit(
            app.data.events.filter((e) => e.id !== ev.id),
            { select: null, undoLabel: t('eventDeleted'), before },
          );
        }
      } else await app.deleteOcc(occ || { eventId: ev.id, key: String(ev.start), readOnly: false });
    }
    app.focusView();
    return v;
  });
}
