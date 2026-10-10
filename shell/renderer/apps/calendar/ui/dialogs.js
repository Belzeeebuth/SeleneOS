// Calendar dialogs: settings, add/edit calendar, .ics import / export, keyboard shortcuts.
import { PALETTE } from '../lib/store.mjs';
import { parseIcs, serializeIcs } from '../lib/ics.mjs';
import { sanitizeEvent, newId, expandEvent, firstOccurrence } from '../lib/events.mjs';
import { systemTz, offsetLabel } from '../lib/tz.mjs';
import { css } from './util.js';

// ------------------------------------------------------------------ settings
export async function settingsDialog(app) {
  const { h, ui } = app.ctx;
  const t = app.t;
  const p = JSON.parse(JSON.stringify(app.prefs));
  const row = (label, hint, control) => h('div', { class: 'ac-set-row' }, h('div', { class: 'ac-set-text' }, h('div', null, label), hint ? h('div', { class: 'caption text-2' }, hint) : null), h('div', { class: 'ac-set-ctl' }, control));
  const firstSel = ui.select({
    options: [
      { value: 'auto', label: t('firstDayAuto') },
      { value: '0', label: app.fmt.weekdayLong(new Date(2026, 0, 4)) },
      { value: '1', label: app.fmt.weekdayLong(new Date(2026, 0, 5)) },
      { value: '6', label: app.fmt.weekdayLong(new Date(2026, 0, 10)) },
    ],
    value: String(p.firstDay),
    onchange: (v) => (p.firstDay = v === 'auto' ? 'auto' : Number(v)),
  });
  const days = h('div', { class: 'ac-ed-days ac-set-days', role: 'group', 'aria-label': t('workWeek') });
  const first = app.firstDay();
  for (let i = 0; i < 7; i++) {
    const wd = (first + i) % 7;
    const d = new Date(2026, 0, 4 + wd);
    const on = () => p.workDays.includes(wd);
    days.appendChild(
      h(
        'button',
        {
          type: 'button',
          class: ['ac-ed-day', on() && 'on'],
          'aria-pressed': String(on()),
          'aria-label': app.fmt.weekdayLong(d),
          'data-tip': app.fmt.weekdayLong(d),
          onclick: (e) => {
            if (on()) {
              if (p.workDays.length > 1) p.workDays = p.workDays.filter((x) => x !== wd);
            } else p.workDays = [...p.workDays, wd].sort();
            e.currentTarget.classList.toggle('on', on());
            e.currentTarget.setAttribute('aria-pressed', String(on()));
          },
        },
        app.fmt.weekdayNarrow(d),
      ),
    );
  }
  const hourOpt = (hr) => ({ value: String(hr), label: hr === 24 ? app.fmt.hourLabel(0) : app.fmt.hourLabel(hr) });
  const startSel = ui.select({ options: Array.from({ length: 24 }, (_, i) => hourOpt(i)), value: String(p.workStart), onchange: (v) => ((p.workStart = Number(v)), check()) });
  const endSel = ui.select({ options: Array.from({ length: 24 }, (_, i) => hourOpt(i + 1)), value: String(p.workEnd), onchange: (v) => ((p.workEnd = Number(v)), check()) });
  const hoursErr = h('div', { class: 'caption ac-ed-error' });
  const check = () => {
    const bad = p.workEnd <= p.workStart;
    hoursErr.textContent = bad ? t('errWorkHours') : '';
    return !bad;
  };
  const wn = ui.toggle({ checked: !!p.weekNumbers, onchange: (v) => (p.weekNumbers = v) });
  const calSel = ui.select({ options: app.userCalendars().map((c) => ({ value: c.id, label: app.calName(c) })), value: app.defaultCalendarId(), onchange: (v) => (p.defaultCalendar = v) });
  const durSel = ui.select({ options: [15, 30, 45, 60, 90, 120].map((m) => ({ value: String(m), label: app.fmt.duration(m) })), value: String(p.defaultDuration), onchange: (v) => (p.defaultDuration = Number(v)) });
  const remSel = ui.select({
    options: [null, 0, 5, 15, 30, 60, 1440].map((m) => ({ value: m == null ? '' : String(m), label: app.fmt.reminder(m, false) })),
    value: p.defaultReminder == null ? '' : String(p.defaultReminder),
    onchange: (v) => (p.defaultReminder = v === '' ? null : Number(v)),
  });
  const tz = systemTz();
  const body = h(
    'div',
    { class: 'ac-settings' },
    h('h3', { class: 'ac-set-head' }, t('setCalendar')),
    row(t('firstDay'), null, firstSel),
    row(t('workWeek'), t('workWeekHint'), days),
    row(t('workHours'), null, h('div', { class: 'row' }, startSel, h('span', { class: 'text-2' }, '–'), endSel)),
    hoursErr,
    row(t('weekNumbers'), t('weekNumbersHint'), wn),
    h('h3', { class: 'ac-set-head' }, t('setNewEvents')),
    row(t('defaultCalendar'), null, calSel),
    row(t('defaultDuration'), null, durSel),
    row(t('defaultReminder'), null, remSel),
    h('h3', { class: 'ac-set-head' }, t('timeZone')),
    h('div', { class: 'ac-set-row' }, h('div', { class: 'ac-set-text' }, h('div', { class: 'selectable' }, `${tz} (${offsetLabel(Date.now(), tz)})`), h('div', { class: 'caption text-2' }, t('timeZoneHint')))),
  );
  const v = await ui.dialog({
    title: t('settings'),
    body,
    parent: app.win,
    width: 620,
    className: 'ac-settings-dialog',
    buttons: [
      { label: t('save'), value: 'save', primary: true },
      { label: t('cancel'), value: null },
    ],
    onOpen: (dlg) => {
      dlg._validate = (val) => (val === 'save' ? check() : true);
    },
  });
  if (v !== 'save') return false;
  Object.assign(app.data.prefs, p);
  app.mini.setState({});
  app.render({ animate: false, keepScroll: true });
  await app.savePrefs();
  return true;
}

// ------------------------------------------------------------------ calendar add / edit
export async function calendarDialog(app, cal) {
  const { h, ui } = app.ctx;
  const t = app.t;
  const isNew = !cal;
  const editableName = isNew || cal.kind === 'user';
  let color = cal?.color || PALETTE.find((c) => !app.data.calendars.some((x) => x.color === c)) || PALETTE[0];
  const name = h('input', { class: 'input ac-calname', type: 'text', value: cal ? app.calName(cal) : '', placeholder: t('calendarNamePlaceholder'), maxlength: 100, disabled: !editableName, 'aria-label': t('calendarName') });
  const err = h('div', { class: 'caption ac-ed-error' });
  const swatches = h(
    'div',
    { class: 'ac-color-grid big', role: 'radiogroup', 'aria-label': t('color') },
    PALETTE.map((c) =>
      h('button', {
        type: 'button',
        class: ['ac-color', c === color && 'on'],
        role: 'radio',
        'aria-checked': String(c === color),
        'aria-label': c,
        style: css({ '--ev': c }),
        onclick: (e) => {
          color = c;
          for (const b of swatches.children) {
            b.classList.toggle('on', b === e.currentTarget);
            b.setAttribute('aria-checked', String(b === e.currentTarget));
          }
        },
      }),
    ),
  );
  const body = h('div', { class: 'ac-caldlg' }, h('div', { class: 'field' }, h('label', null, t('calendarName')), name, err), h('div', { class: 'field' }, h('label', null, t('color')), swatches));
  const v = await ui.dialog({
    title: isNew ? t('addCalendar') : t('editCalendar'),
    body,
    parent: app.win,
    width: 420,
    className: 'ac-cal-dialog',
    buttons: [
      { label: isNew ? t('add') : t('save'), value: 'ok', primary: true },
      { label: t('cancel'), value: null },
    ],
    onOpen: (dlg) => {
      dlg._validate = (val) => {
        if (val !== 'ok' || !editableName) return true;
        const n = name.value.trim();
        if (!n) {
          err.textContent = t('errCalendarName');
          name.classList.add('invalid');
          name.focus();
          return false;
        }
        if (app.data.calendars.some((c) => c !== cal && app.calName(c).toLowerCase() === n.toLowerCase())) {
          err.textContent = t('errCalendarExists');
          name.classList.add('invalid');
          return false;
        }
        return true;
      };
      setTimeout(() => (editableName ? name.focus() : swatches.querySelector('.on')?.focus()), 40);
    },
  });
  if (v !== 'ok') return null;
  return { name: editableName ? name.value.trim() : cal.name, color };
}

// ------------------------------------------------------------------ import
const baseName = (p) => String(p).split('/').pop();

export async function importFlow(app, path = null, calendarId = null) {
  const { h, ui, api } = app.ctx;
  const t = app.t;
  if (!path) {
    path = await ui.filePicker({ mode: 'open', title: t('importTitle'), filters: [{ name: t('icsFiles'), ext: ['.ics'] }], parent: app.win });
    if (!path) return false;
  }
  let text;
  try {
    text = await api.invoke('fs:readText', path, { maxBytes: 20 * 1024 * 1024 });
  } catch (err) {
    await ui.alert(t('importReadError', { name: baseName(path), msg: err?.message || String(err) }), { title: t('importTitle'), parent: app.win });
    return false;
  }
  let parsed;
  try {
    parsed = parseIcs(text, { defaultTz: systemTz() });
  } catch (err) {
    parsed = { events: [], warnings: ['not-icalendar'] };
  }
  if (!parsed.events.length) {
    await ui.alert(parsed.warnings.includes('not-icalendar') ? t('importNotIcs', { name: baseName(path) }) : t('importNoEvents', { name: baseName(path) }), { title: t('importTitle'), parent: app.win });
    return false;
  }
  const newName = parsed.name || baseName(path).replace(/\.ics$/i, '');
  const NEW = '__new__';
  const target = calendarId && app.calendar(calendarId)?.kind === 'user' ? calendarId : parsed.name ? NEW : app.defaultCalendarId();
  const sel = ui.select({
    options: [{ value: NEW, label: t('newCalendarNamed', { name: newName }) }, ...app.userCalendars().map((c) => ({ value: c.id, label: app.calName(c) }))],
    value: target,
  });
  const notes = [];
  if (parsed.warnings.some((w) => w.startsWith('unknown-tz'))) notes.push(t('importWarnTz'));
  if (parsed.warnings.includes('rdate-ignored')) notes.push(t('importWarnRdate'));
  if (parsed.warnings.includes('bad-rrule')) notes.push(t('importWarnRrule'));
  const body = h(
    'div',
    { class: 'ac-import' },
    h('p', null, t('importFound', { count: parsed.events.length, name: baseName(path) })),
    h('div', { class: 'field' }, h('label', null, t('importTarget')), sel),
    notes.length ? h('div', { class: 'infobar warning' }, app.ctx.icon('warning', { size: 16 }), h('div', { class: 'caption' }, notes.join(' '))) : null,
  );
  const v = await ui.dialog({
    title: t('importTitle'),
    body,
    parent: app.win,
    width: 460,
    className: 'ac-import-dialog',
    buttons: [
      { label: t('import'), value: 'ok', primary: true },
      { label: t('cancel'), value: null },
    ],
  });
  if (v !== 'ok') return false;
  const before = app.snapshot();
  let calId = sel.value;
  if (calId === NEW) {
    calId = newId('c');
    const used = new Set(app.data.calendars.map((c) => c.color));
    app.data.calendars.splice(app.userCalendars().length, 0, { id: calId, name: newName.slice(0, 100), color: parsed.color || PALETTE.find((c) => !used.has(c)) || PALETTE[3], visible: true, kind: 'user' });
    app.renderCalendars();
    await app.saveCalendars();
  } else {
    const c = app.calendar(calId);
    if (c && !c.visible) {
      c.visible = true;
      app.renderCalendars();
      await app.saveCalendars();
    }
  }
  const list = [...app.data.events];
  let added = 0;
  let updated = 0;
  const imported = [];
  for (const pe of parsed.events) {
    const idx = pe.uid ? list.findIndex((e) => e.uid === pe.uid && e.calendarId === calId) : -1;
    const ev = sanitizeEvent({ ...pe, id: idx >= 0 ? list[idx].id : newId('e'), calendarId: calId, created: idx >= 0 ? list[idx].created : Date.now(), updated: Date.now() });
    if (!ev) continue;
    if (idx >= 0) {
      list[idx] = ev;
      updated++;
    } else {
      list.push(ev);
      added++;
    }
    imported.push(ev);
  }
  await app.commit(list, { select: null, before, undoLabel: t('importDone', { count: added + updated }) });
  // show the first upcoming imported event (or the latest one)
  const now = Date.now();
  let best = null;
  for (const ev of imported) {
    const next = expandEvent(ev, now, now + 366 * 86400000)[0] || null;
    if (next && (!best || next.start < best.start)) best = next;
  }
  if (!best) best = imported.map((e) => firstOccurrence(e)).filter(Boolean).sort((a, b) => b.start - a.start)[0];
  if (best) app.goTo(new Date(best.start));
  return { added, updated, calendarId: calId };
}

// ------------------------------------------------------------------ export
export async function exportFlow(app, calendarId = null) {
  const { ui, api } = app.ctx;
  const t = app.t;
  const cal = calendarId ? app.calendar(calendarId) : null;
  const events = app.data.events.filter((e) => !calendarId || e.calendarId === calendarId);
  if (!events.length) {
    await ui.alert(t('exportEmpty'), { title: t('exportCalendar'), parent: app.win });
    return false;
  }
  const name = cal ? app.calName(cal) : t('appName');
  const safe = name.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'calendar';
  const path = await ui.filePicker({ mode: 'save', title: t('exportCalendar'), name: `${safe}.ics`, filters: [{ name: t('icsFiles'), ext: ['.ics'] }], parent: app.win });
  if (!path) return false;
  try {
    await api.invoke('fs:writeText', path, serializeIcs({ name, events, color: cal?.color || null }));
  } catch (err) {
    await ui.alert(t('exportError', { msg: err?.message || String(err) }), { title: t('exportCalendar'), parent: app.win });
    return false;
  }
  app.toast(t('exportDone', { count: events.length, name: baseName(path) }));
  return path;
}

// ------------------------------------------------------------------ shortcuts
export function shortcutsDialog(app) {
  const { h, ui } = app.ctx;
  const t = app.t;
  const rows = [
    ['N', t('ks.new')],
    ['T', t('ks.today')],
    ['1 – 5', t('ks.views')],
    ['← → ↑ ↓', t('ks.arrows')],
    ['Page Up / Page Down', t('ks.period')],
    ['Enter', t('ks.open')],
    ['Delete', t('ks.delete')],
    ['Alt + ↑ / ↓', t('ks.nudge')],
    ['Ctrl + F, /', t('ks.search')],
    ['Ctrl + S', t('ks.save')],
    ['Esc', t('ks.escape')],
  ];
  return ui.dialog({
    title: t('shortcuts'),
    parent: app.win,
    width: 480,
    className: 'ac-keys-dialog',
    body: h(
      'table',
      { class: 'ac-keys' },
      rows.map(([k, label]) => h('tr', null, h('td', null, k.split(/(\s\+\s|,\s|\s\/\s|\s–\s)/).map((part) => (/^\s|^,/.test(part) ? part : h('kbd', null, part)))), h('td', null, label))),
    ),
    buttons: [{ label: t('close'), value: true, primary: true }],
  });
}

