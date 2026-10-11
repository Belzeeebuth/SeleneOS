// Event model: validation, recurrence expansion (with exceptions), edits of single occurrences or whole
// series, reminder planning and search. Pure module (shell + Node) — no DOM, no storage.
//
// Stored event:
//   { id, uid, calendarId, title, location, description, color: null|'#rrggbb',
//     allDay: bool,
//     start, end,          // timed: epoch ms ; all-day: 'YYYY-MM-DD' (end exclusive)
//     tz,                  // IANA zone whose wall clock the recurrence follows (timed events)
//     rrule: null | rule (see rrule.mjs),
//     exdates: [key],      // deleted occurrences
//     overrides: { key: { start?, end?, title?, location?, description?, calendarId?, color?, reminder? } },
//     reminder: null | minutes before the start (negative = after; all-day events: relative to 00:00),
//     created, updated }
// An occurrence key is the original start of that occurrence: String(epoch ms) for timed events, the
// date key for all-day events.
//
// Occurrence (what views draw):
//   { eventId, key, start, end (local epoch ms), allDay, startKey, endKey (all-day), title, location,
//     description, calendarId, color, reminder, recurring, exception, readOnly, ev }
import { ruleDays, sanitizeRule } from './rrule.mjs';
import { zonedToUtc, utcToZoned, isValidTz, systemTz } from './tz.mjs';
import { dayNum, fromDayNum, keyFromDayNum, dayNumFromKey, isDateKey, keyToLocalMs, localDayNum, DAY_MS } from './dates.mjs';

export const REMINDER_FIELDS = ['title', 'location', 'description', 'calendarId', 'color', 'reminder'];
const MAX_ITER = 50000;

export function newId(prefix = '') {
  const rnd = Math.random().toString(36).slice(2, 10);
  return `${prefix}${Date.now().toString(36)}${rnd}`;
}

// Dates the views, reminders and .ics export can handle: events outside 1900–2499 are dropped, and no
// event lasts more than 10 years (a broken DURATION in an imported file would make the dates invalid).
const MIN_MS = Date.UTC(1900, 0, 1);
const MAX_MS = Date.UTC(2500, 0, 1);
const MAX_SPAN_DAYS = 3660;
const inRange = (ms) => Number.isFinite(ms) && ms >= MIN_MS && ms < MAX_MS;
const keyInRange = (k) => isDateKey(k) && Number(k.slice(0, 4)) >= 1900 && Number(k.slice(0, 4)) < 2500;

const str = (v, max = 10000) => (typeof v === 'string' ? v.slice(0, max) : v == null ? '' : String(v).slice(0, max));
const isColor = (c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c);

function sanitizeOverride(o, allDay) {
  if (!o || typeof o !== 'object') return null;
  const out = {};
  if (allDay) {
    if (keyInRange(o.start)) out.start = o.start;
    if (keyInRange(o.end)) out.end = o.end;
  } else {
    if (inRange(o.start)) out.start = o.start;
    if (inRange(o.end)) out.end = o.end;
  }
  for (const f of ['title', 'location', 'description']) if (typeof o[f] === 'string') out[f] = str(o[f]);
  if (typeof o.calendarId === 'string') out.calendarId = o.calendarId;
  if (o.color === null || isColor(o.color)) out.color = o.color;
  if (o.reminder === null || Number.isFinite(o.reminder)) out.reminder = o.reminder;
  return Object.keys(out).length ? out : null;
}

export function sanitizeEvent(e) {
  if (!e || typeof e !== 'object') return null;
  const allDay = !!e.allDay;
  let start;
  let end;
  if (allDay) {
    if (!keyInRange(e.start)) return null;
    start = e.start;
    end = isDateKey(e.end) && e.end > start ? e.end : keyFromDayNum(dayNumFromKey(start) + 1);
    if (dayNumFromKey(end) - dayNumFromKey(start) > MAX_SPAN_DAYS) end = keyFromDayNum(dayNumFromKey(start) + MAX_SPAN_DAYS);
  } else {
    start = Number(e.start);
    if (!inRange(start)) return null;
    end = Number(e.end);
    if (!Number.isFinite(end) || end < start) end = start;
    end = Math.min(end, start + MAX_SPAN_DAYS * DAY_MS);
  }
  const out = {
    id: typeof e.id === 'string' && e.id ? e.id.slice(0, 200) : newId('e'),
    uid: typeof e.uid === 'string' && e.uid ? e.uid.slice(0, 500) : '',
    calendarId: typeof e.calendarId === 'string' && e.calendarId ? e.calendarId : 'personal',
    title: str(e.title, 2000),
    location: str(e.location, 2000),
    description: str(e.description, 100000),
    color: isColor(e.color) ? e.color : null,
    allDay,
    start,
    end,
    tz: isValidTz(e.tz) ? e.tz : systemTz(),
    rrule: sanitizeRule(e.rrule),
    exdates: [],
    overrides: {},
    reminder: Number.isFinite(e.reminder) ? Math.max(-1440, Math.min(e.reminder, 60 * 24 * 28)) : null,
    created: Number.isFinite(e.created) ? e.created : Date.now(),
    updated: Number.isFinite(e.updated) ? e.updated : Date.now(),
  };
  if (!out.uid) out.uid = `${out.id}@aurora-calendar`;
  if (out.rrule && allDay && typeof out.rrule.until === 'number') out.rrule.until = keyFromDayNum(localDayNum(out.rrule.until));
  if (out.rrule && !allDay && typeof out.rrule.until === 'string') out.rrule.until = untilEndOfDay(out.rrule.until, out.tz);
  if (out.rrule) {
    if (Array.isArray(e.exdates)) out.exdates = [...new Set(e.exdates.filter((k) => (allDay ? isDateKey(k) : /^-?\d+$/.test(String(k)))).map(String))];
    if (e.overrides && typeof e.overrides === 'object') {
      for (const [k, o] of Object.entries(e.overrides)) {
        if (allDay ? !isDateKey(k) : !/^-?\d+$/.test(k)) continue;
        const so = sanitizeOverride(o, allDay);
        if (so) out.overrides[k] = so;
      }
    }
  }
  return out;
}

function untilEndOfDay(key, tz) {
  const n = dayNumFromKey(key);
  const p = fromDayNum(n);
  return zonedToUtc(p.y, p.m, p.d, 23, 59, 59, tz);
}

export const occurrenceKey = (ev, start) => (ev.allDay ? String(start) : String(start));

export function durationOf(ev) {
  return ev.allDay ? Math.max(1, dayNumFromKey(ev.end) - dayNumFromKey(ev.start)) : Math.max(0, ev.end - ev.start);
}

function makeOcc(ev, key, start, end, override, extra = {}) {
  const o = override || {};
  const allDay = ev.allDay;
  const occ = {
    eventId: ev.id,
    key: String(key),
    allDay,
    title: o.title ?? ev.title,
    location: o.location ?? ev.location,
    description: o.description ?? ev.description,
    calendarId: o.calendarId ?? ev.calendarId,
    color: o.color !== undefined ? o.color : ev.color,
    reminder: o.reminder !== undefined ? o.reminder : ev.reminder,
    recurring: !!ev.rrule,
    exception: !!override,
    readOnly: !!ev.readOnly,
    ev,
    ...extra,
  };
  if (allDay) {
    occ.startKey = o.start ?? start;
    occ.endKey = o.end ?? end;
    if (occ.endKey <= occ.startKey) occ.endKey = keyFromDayNum(dayNumFromKey(occ.startKey) + 1);
    occ.start = keyToLocalMs(occ.startKey);
    occ.end = keyToLocalMs(occ.endKey);
  } else {
    occ.start = o.start ?? start;
    occ.end = o.end ?? end;
    if (occ.end < occ.start) occ.end = occ.start;
  }
  return occ;
}

// Original (un-overridden) start/end of the occurrence with that key.
export function baseOccurrence(ev, key) {
  if (ev.allDay) {
    const n = dayNumFromKey(key);
    return { start: key, end: keyFromDayNum(n + durationOf(ev)) };
  }
  const s = Number(key);
  return { start: s, end: s + durationOf(ev) };
}

// Raw occurrence starts of a series in ascending order: { key, start, end } (start/end in the event's
// own representation). `fromMs` lets rules without COUNT skip ahead.
function* seriesStarts(ev, fromMs = null) {
  const rule = ev.rrule;
  if (ev.allDay) {
    const s0 = dayNumFromKey(ev.start);
    const dur = durationOf(ev);
    const untilDay = typeof rule?.until === 'string' ? dayNumFromKey(rule.until) : null;
    const jump = fromMs != null ? localDayNum(fromMs) - dur - 1 : null;
    yield { key: ev.start, start: ev.start, end: ev.end, index: 0 };
    if (!rule) return;
    let count = 1;
    let iter = 0;
    for (const n of ruleDays(rule, s0, jump)) {
      if (++iter > MAX_ITER) return;
      if (n === s0) continue;
      if (untilDay != null && n > untilDay) return;
      if (rule.count && count >= rule.count) return;
      count++;
      const k = keyFromDayNum(n);
      yield { key: k, start: k, end: keyFromDayNum(n + dur), index: count - 1 };
    }
    return;
  }
  const tz = ev.tz || 'UTC';
  const w = utcToZoned(ev.start, tz);
  const s0 = dayNum(w.y, w.m, w.d);
  const dur = durationOf(ev);
  yield { key: String(ev.start), start: ev.start, end: ev.end, index: 0 };
  if (!rule) return;
  const until = typeof rule.until === 'number' ? rule.until : null;
  let jump = null;
  if (fromMs != null) {
    const f = utcToZoned(fromMs - dur, tz);
    jump = dayNum(f.y, f.m, f.d) - 1;
  }
  let count = 1;
  let iter = 0;
  for (const n of ruleDays(rule, s0, jump)) {
    if (++iter > MAX_ITER) return;
    if (n === s0) continue;
    const p = fromDayNum(n);
    const start = zonedToUtc(p.y, p.m, p.d, w.hh, w.mi, w.ss, tz);
    if (until != null && start > until) return;
    if (rule.count && count >= rule.count) return;
    count++;
    yield { key: String(start), start, end: start + dur, index: count - 1 };
  }
}

const overlaps = (s, e, from, to) => (e > s ? s < to && e > from : s >= from && s < to);

// All occurrences of an event that overlap [from, to) (local epoch ms), sorted by start.
export function expandEvent(ev, from, to) {
  const out = [];
  const ex = ev.exdates?.length ? new Set(ev.exdates) : null;
  const ov = ev.overrides || {};
  const hasOv = Object.keys(ov).length > 0;
  for (const s of seriesStarts(ev, ev.rrule ? from : null)) {
    const occStart = ev.allDay ? keyToLocalMs(s.start) : s.start;
    const occEnd = ev.allDay ? keyToLocalMs(s.end) : s.end;
    if (occStart >= to) break;
    if (ex?.has(s.key) || (hasOv && ov[s.key])) continue;
    if (overlaps(occStart, occEnd, from, to)) out.push(makeOcc(ev, s.key, s.start, s.end, null, { index: s.index }));
  }
  if (hasOv) {
    for (const [key, o] of Object.entries(ov)) {
      if (ex?.has(key)) continue;
      const base = baseOccurrence(ev, key);
      const occ = makeOcc(ev, key, base.start, base.end, o);
      if (overlaps(occ.start, occ.end, from, to)) out.push(occ);
    }
  }
  return out.sort((a, b) => a.start - b.start || b.end - a.end);
}

export function expandAll(events, from, to, filter) {
  const out = [];
  for (const ev of events) {
    if (filter && !filter(ev)) continue;
    try {
      for (const o of expandEvent(ev, from, to)) if (!filter || filter(ev, o)) out.push(o);
    } catch (err) {
      // a broken event must never break the whole view
      if (typeof console !== 'undefined') console.error('[calendar] expand failed', ev?.id, err);
    }
  }
  return out.sort((a, b) => a.start - b.start || b.end - a.end || (a.title < b.title ? -1 : 1));
}

// Does this key name a real occurrence of the series (ignoring exceptions)?
export function isOccurrenceKey(ev, key) {
  if (!ev.rrule) return String(key) === String(ev.start);
  const target = ev.allDay ? keyToLocalMs(key) : Number(key);
  if (!Number.isFinite(target)) return false;
  for (const s of seriesStarts(ev, target - DAY_MS)) {
    if (s.key === String(key)) return true;
    const st = ev.allDay ? keyToLocalMs(s.start) : s.start;
    if (st > target) return false;
  }
  return false;
}

// The (possibly overridden) occurrence with this key, or null if deleted / unknown.
export function occurrenceAt(ev, key) {
  key = String(key);
  if (ev.exdates?.includes(key)) return null;
  if (!isOccurrenceKey(ev, key)) return null;
  const base = baseOccurrence(ev, key);
  return makeOcc(ev, key, base.start, base.end, ev.overrides?.[key] || null);
}

export function firstOccurrence(ev) {
  for (const s of seriesStarts(ev)) {
    if (ev.exdates?.includes(s.key)) continue;
    return makeOcc(ev, s.key, s.start, s.end, ev.overrides?.[s.key] || null);
  }
  return null;
}

// ------------------------------------------------------------------ edits (return new objects)
const clone = (ev) => JSON.parse(JSON.stringify(ev));

const TIMING = ['allDay', 'start', 'end', 'rrule', 'tz'];

// Whole-series update. Changing the timing or the recurrence drops the exceptions (like Outlook).
export function updateSeries(ev, changes) {
  const next = { ...clone(ev), ...clone(changes), updated: Date.now() };
  const timingChanged = TIMING.some((k) => k in changes && JSON.stringify(changes[k]) !== JSON.stringify(ev[k]));
  if (timingChanged) {
    next.exdates = [];
    next.overrides = {};
  } else if (next.overrides) {
    // fields now equal to the master no longer need to be overridden
    for (const [k, o] of Object.entries(next.overrides)) {
      for (const f of REMINDER_FIELDS) if (f in o && JSON.stringify(o[f]) === JSON.stringify(next[f])) delete o[f];
      if (!Object.keys(o).length) delete next.overrides[k];
    }
  }
  return sanitizeEvent(next);
}

// Change one occurrence (time and/or fields). Only differences from the series are stored.
export function updateOccurrence(ev, key, changes) {
  key = String(key);
  if (!ev.rrule) return updateSeries(ev, changes);
  const next = clone(ev);
  next.overrides = next.overrides || {};
  const base = baseOccurrence(ev, key);
  const o = { ...(next.overrides[key] || {}), ...clone(changes) };
  delete o.allDay;
  delete o.rrule;
  delete o.tz;
  for (const f of REMINDER_FIELDS) if (f in o && JSON.stringify(o[f]) === JSON.stringify(ev[f])) delete o[f];
  if ('start' in o || 'end' in o) {
    const s = o.start ?? base.start;
    const e = o.end ?? base.end;
    if (s === base.start && e === base.end) {
      delete o.start;
      delete o.end;
    } else {
      o.start = s;
      o.end = e;
    }
  }
  if (Object.keys(o).length) next.overrides[key] = o;
  else delete next.overrides[key];
  next.updated = Date.now();
  return sanitizeEvent(next);
}

export function deleteOccurrence(ev, key) {
  key = String(key);
  if (!ev.rrule) return null;
  const next = clone(ev);
  next.exdates = [...new Set([...(next.exdates || []), key])];
  if (next.overrides) delete next.overrides[key];
  next.updated = Date.now();
  // Nothing left? The whole event goes.
  return firstOccurrence(sanitizeEvent(next)) ? sanitizeEvent(next) : null;
}

// "This and following": end the series before the occurrence `key`. Returns null if nothing remains.
export function truncateSeries(ev, key) {
  key = String(key);
  if (!ev.rrule) return null;
  const next = clone(ev);
  if (ev.allDay) {
    if (key <= ev.start) return null;
    next.rrule.until = keyFromDayNum(dayNumFromKey(key) - 1);
  } else {
    const k = Number(key);
    if (k <= ev.start) return null;
    next.rrule.until = k - 1000;
  }
  next.rrule.count = null;
  next.exdates = (next.exdates || []).filter((x) => (ev.allDay ? x < key : Number(x) < Number(key)));
  for (const k of Object.keys(next.overrides || {})) if (ev.allDay ? k >= key : Number(k) >= Number(key)) delete next.overrides[k];
  next.updated = Date.now();
  return sanitizeEvent(next);
}

// Move / resize an occurrence (or a single event) to a new start/end in its own representation.
export function moveOccurrence(ev, key, start, end) {
  if (!ev.rrule) return updateSeries(ev, { start, end });
  return updateOccurrence(ev, key, { start, end });
}

// ------------------------------------------------------------------ reminders
// Next occurrences (after `afterMs`) whose reminder is due later than `now`.
export function upcomingReminders(ev, now, perEvent = 3, horizonMs = 400 * DAY_MS) {
  const out = [];
  const anyReminder = ev.reminder != null || Object.values(ev.overrides || {}).some((o) => o.reminder != null);
  if (!anyReminder) return out;
  const windows = ev.rrule ? [14 * DAY_MS, 120 * DAY_MS, horizonMs] : [Infinity];
  for (const span of windows) {
    out.length = 0;
    const from = ev.rrule ? now - 30 * DAY_MS : -Infinity;
    const to = ev.rrule ? now + span : Infinity;
    const occs = ev.rrule ? expandEvent(ev, from, to) : expandEvent(ev, -8.64e15, 8.64e15);
    for (const o of occs) {
      if (o.reminder == null) continue;
      const at = o.start - o.reminder * 60000;
      if (at <= now) continue;
      out.push({ occ: o, at });
      if (out.length >= perEvent) break;
    }
    if (out.length >= perEvent || !ev.rrule) break;
  }
  return out.sort((a, b) => a.at - b.at).slice(0, perEvent);
}

// Plan the shell reminders for every event: [{ id, at, eventId, key, occ }]
export function planReminders(events, now = Date.now(), { perEvent = 3, skip } = {}) {
  const out = [];
  for (const ev of events) {
    if (ev.readOnly || (skip && skip(ev))) continue;
    try {
      for (const { occ, at } of upcomingReminders(ev, now, perEvent)) {
        out.push({ id: `evt-${ev.id}-${occ.key}`, at, eventId: ev.id, key: occ.key, occ });
      }
    } catch (err) {
      if (typeof console !== 'undefined') console.error('[calendar] reminder planning failed', ev?.id, err);
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

// ------------------------------------------------------------------ search
export function normalizeText(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

export function matches(occ, query) {
  const q = normalizeText(query).trim();
  if (!q) return false;
  const hay = normalizeText(`${occ.title}\n${occ.location}\n${occ.description}`);
  return q.split(/\s+/).every((w) => hay.includes(w));
}
