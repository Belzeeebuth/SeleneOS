// iCalendar (.ics, RFC 5545) import / export. Pure module (shell + Node).
//
//   parseIcs(text, { defaultTz }) -> { name, color, events: [event-like objects without id/calendarId], warnings }
//     VEVENT: UID, SUMMARY, LOCATION, DESCRIPTION, DTSTART/DTEND/DURATION (DATE, UTC, TZID, floating),
//     RRULE (FREQ/INTERVAL/COUNT/UNTIL/BYDAY/BYMONTHDAY/BYMONTH/BYSETPOS/WKST), EXDATE, RECURRENCE-ID
//     instances (moved / edited / cancelled occurrences), STATUS:CANCELLED, VALARM TRIGGER (relative,
//     RELATED=END, absolute). Lines are unfolded, text is unescaped, unknown properties are ignored.
//   serializeIcs({ name, events, now }) -> text (CRLF, folded at 75 octets, VTIMEZONE for each zone used)
//   escapeText / unescapeText / unfold / foldLine / parseDuration are exported for tests.
import { parseRRule, formatRRule, parseIcsDateTime } from './rrule.mjs';
import { zonedToUtc, utcToZoned, tzOffset, normalizeTzid, isValidTz, systemTz } from './tz.mjs';
import { dateKey, dayNumFromKey, keyFromDayNum, keyToLocalMs, daysInMonth, WEEKDAYS, DAY_MS } from './dates.mjs';
import { sanitizeEvent, baseOccurrence } from './events.mjs';

export function unfold(text) {
  return String(text || '')
    .replace(/^﻿/, '')
    .replace(/\r\n|\r/g, '\n')
    .replace(/\n[ \t]/g, '');
}

export function unescapeText(v) {
  return String(v || '').replace(/\\([\\;,nN:"])/g, (m, c) => (c === 'n' || c === 'N' ? '\n' : c));
}

export function escapeText(v) {
  return String(v ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

// "NAME;P1=a,b;P2="x:y":value" -> { name, params: { P1: 'a,b', P2: 'x:y' }, value }
export function parseLine(line) {
  let i = 0;
  const n = line.length;
  while (i < n && line[i] !== ';' && line[i] !== ':') i++;
  const name = line.slice(0, i).trim().toUpperCase();
  if (!name || i >= n) return null;
  const params = {};
  while (line[i] === ';') {
    i++;
    const ps = i;
    while (i < n && line[i] !== '=' && line[i] !== ':' && line[i] !== ';') i++;
    const pname = line.slice(ps, i).trim().toUpperCase();
    let pval = '';
    if (line[i] === '=') {
      i++;
      const vals = [];
      for (;;) {
        if (line[i] === '"') {
          const q = line.indexOf('"', i + 1);
          if (q < 0) {
            vals.push(line.slice(i + 1));
            i = n;
          } else {
            vals.push(line.slice(i + 1, q));
            i = q + 1;
          }
        } else {
          const vs = i;
          while (i < n && line[i] !== ',' && line[i] !== ';' && line[i] !== ':') i++;
          vals.push(line.slice(vs, i));
        }
        if (line[i] === ',') {
          i++;
          continue;
        }
        break;
      }
      pval = vals.join(',');
    }
    if (pname) params[pname] = pval;
  }
  if (line[i] !== ':') return null;
  return { name, params, value: line.slice(i + 1) };
}

function parseComponents(text) {
  const root = { name: 'ROOT', props: [], children: [] };
  const stack = [root];
  for (const raw of unfold(text).split('\n')) {
    if (!raw.trim()) continue;
    const p = parseLine(raw);
    if (!p) continue;
    const top = stack[stack.length - 1];
    if (p.name === 'BEGIN') {
      const comp = { name: p.value.trim().toUpperCase(), props: [], children: [] };
      top.children.push(comp);
      stack.push(comp);
    } else if (p.name === 'END') {
      const nm = p.value.trim().toUpperCase();
      const idx = stack.map((c) => c.name).lastIndexOf(nm);
      if (idx > 0) stack.length = idx;
    } else top.props.push(p);
  }
  return root;
}

const prop = (c, name) => c.props.find((p) => p.name === name) || null;
const propsOf = (c, name) => c.props.filter((p) => p.name === name);
const findAll = (c, name, out = []) => {
  for (const ch of c.children) {
    if (ch.name === name) out.push(ch);
    findAll(ch, name, out);
  }
  return out;
};

export function parseDuration(v) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(String(v || '').trim());
  if (!m || v.trim().replace(/^[+-]/, '') === 'P') return null;
  const ms = ((Number(m[2] || 0) * 7 + Number(m[3] || 0)) * 86400 + Number(m[4] || 0) * 3600 + Number(m[5] || 0) * 60 + Number(m[6] || 0)) * 1000;
  return m[1] === '-' ? -ms : ms;
}

// DATE / DATE-TIME property -> { allDay, key } | { allDay: false, ms, tz, utc, floating }
function parseDateValue(value, params, ctx) {
  const dt = parseIcsDateTime(value);
  if (!dt) return null;
  if (!dt.time || (params.VALUE || '').toUpperCase() === 'DATE') return { allDay: true, key: dateKey(dt.date), date: dt.date };
  if (dt.utc) return { allDay: false, ms: Date.UTC(dt.date.y, dt.date.m, dt.date.d, dt.time.hh, dt.time.mi, dt.time.ss), tz: 'UTC', utc: true };
  let tz = null;
  if (params.TZID) {
    tz = ctx.tzMap.get(params.TZID) || normalizeTzid(params.TZID);
    if (!tz) {
      ctx.warn(`unknown-tz:${params.TZID}`);
      tz = ctx.defaultTz;
    }
  } else tz = ctx.defaultTz;
  return { allDay: false, ms: zonedToUtc(dt.date.y, dt.date.m, dt.date.d, dt.time.hh, dt.time.mi, dt.time.ss, tz), tz, floating: !params.TZID };
}

function textOf(c, name) {
  const p = prop(c, name);
  return p ? unescapeText(p.value) : '';
}

// Map custom TZIDs (with a VTIMEZONE block) to an IANA zone: by name first, then X-LIC-LOCATION.
function buildTzMap(root) {
  const map = new Map();
  for (const vt of findAll(root, 'VTIMEZONE')) {
    const id = prop(vt, 'TZID')?.value;
    if (!id) continue;
    const loc = prop(vt, 'X-LIC-LOCATION')?.value;
    const tz = normalizeTzid(id) || (loc && normalizeTzid(loc));
    if (tz) map.set(id, tz);
  }
  return map;
}

function parseAlarm(ve, startMs, endMs) {
  for (const al of ve.children.filter((c) => c.name === 'VALARM')) {
    const tr = prop(al, 'TRIGGER');
    if (!tr) continue;
    let minutes = null;
    const v = tr.value.trim();
    if ((tr.params.VALUE || '').toUpperCase() === 'DATE-TIME' || /^\d{8}T/.test(v)) {
      const dt = parseIcsDateTime(v);
      if (dt?.time) minutes = Math.round((startMs - Date.UTC(dt.date.y, dt.date.m, dt.date.d, dt.time.hh, dt.time.mi, dt.time.ss)) / 60000);
    } else {
      const d = parseDuration(v);
      if (d != null) {
        const rel = (tr.params.RELATED || 'START').toUpperCase() === 'END' ? endMs - startMs : 0;
        minutes = Math.round(-(d + rel) / 60000);
      }
    }
    if (minutes != null && Number.isFinite(minutes)) return Math.max(-1440, Math.min(minutes, 40320));
  }
  return null;
}

function eventFromComponent(ve, ctx) {
  const ds = prop(ve, 'DTSTART');
  if (!ds) {
    ctx.warn('no-dtstart');
    return null;
  }
  const start = parseDateValue(ds.value, ds.params, ctx);
  if (!start) {
    ctx.warn('bad-dtstart');
    return null;
  }
  const ev = {
    uid: prop(ve, 'UID')?.value?.trim() || '',
    title: textOf(ve, 'SUMMARY'),
    location: textOf(ve, 'LOCATION'),
    description: textOf(ve, 'DESCRIPTION'),
    allDay: start.allDay,
    cancelled: (prop(ve, 'STATUS')?.value || '').trim().toUpperCase() === 'CANCELLED',
  };
  const color = (prop(ve, 'X-AURORA-COLOR') || prop(ve, 'COLOR'))?.value?.trim();
  if (color && /^#[0-9a-f]{6}$/i.test(color)) ev.color = color;
  const de = prop(ve, 'DTEND');
  const du = prop(ve, 'DURATION');
  if (start.allDay) {
    ev.start = start.key;
    let endKey = null;
    if (de) {
      const e = parseDateValue(de.value, de.params, ctx);
      if (e?.allDay) endKey = e.key;
      else if (e) endKey = keyFromDayNum(dayNumFromKey(dateKey(utcToZoned(e.ms, e.tz))) + 1);
    } else if (du) {
      const d = parseDuration(du.value);
      if (d != null) endKey = keyFromDayNum(dayNumFromKey(start.key) + Math.max(1, Math.round(d / DAY_MS)));
    }
    ev.end = endKey && endKey > start.key ? endKey : keyFromDayNum(dayNumFromKey(start.key) + 1);
    ev.tz = ctx.defaultTz;
  } else {
    ev.start = start.ms;
    ev.tz = start.tz;
    let end = start.ms;
    if (de) {
      const e = parseDateValue(de.value, de.params, ctx);
      if (e && !e.allDay) end = e.ms;
      else if (e?.allDay) end = zonedToUtc(e.date.y, e.date.m, e.date.d, 0, 0, 0, start.tz);
    } else if (du) {
      const d = parseDuration(du.value);
      if (d != null) end = start.ms + d;
    }
    ev.end = end >= start.ms ? end : start.ms;
  }
  const rr = prop(ve, 'RRULE');
  if (rr) {
    ev.rrule = parseRRule(rr.value, { allDay: ev.allDay, tz: ev.tz });
    if (!ev.rrule) ctx.warn('bad-rrule');
    // A recurring event whose times are in UTC keeps UTC as its recurrence zone (RFC 5545); a single UTC
    // event simply follows the system zone afterwards.
  } else if (!ev.allDay && ev.tz === 'UTC') ev.tz = ctx.defaultTz;
  if (prop(ve, 'RDATE')) ctx.warn('rdate-ignored');
  ev.exdates = [];
  for (const ex of propsOf(ve, 'EXDATE')) {
    for (const part of ex.value.split(',')) {
      const k = occurrenceKeyFrom(part.trim(), ex.params, ev, ctx);
      if (k != null) ev.exdates.push(k);
    }
  }
  const rid = prop(ve, 'RECURRENCE-ID');
  if (rid) ev.recurrenceId = rid;
  const startMs = ev.allDay ? keyToLocalMs(ev.start) : ev.start;
  const endMs = ev.allDay ? keyToLocalMs(ev.end) : ev.end;
  ev.reminder = parseAlarm(ve, startMs, endMs);
  return ev;
}

// EXDATE / RECURRENCE-ID value -> occurrence key of `ev` (see events.mjs).
function occurrenceKeyFrom(value, params, ev, ctx) {
  const v = parseDateValue(value, params, ctx);
  if (!v) return null;
  if (ev.allDay) return v.allDay ? v.key : dateKey(utcToZoned(v.ms, v.tz));
  if (v.allDay) {
    const w = utcToZoned(ev.start, ev.tz);
    return String(zonedToUtc(v.date.y, v.date.m, v.date.d, w.hh, w.mi, w.ss, ev.tz));
  }
  return String(v.ms);
}

export function parseIcs(text, { defaultTz } = {}) {
  const warnings = [];
  const ctx = {
    defaultTz: isValidTz(defaultTz) ? defaultTz : systemTz(),
    tzMap: new Map(),
    warn: (w) => warnings.includes(w) || warnings.push(w),
  };
  const root = parseComponents(text);
  ctx.tzMap = buildTzMap(root);
  const cals = findAll(root, 'VCALENDAR');
  const calProps = cals[0] || root;
  const name = textOf(calProps, 'X-WR-CALNAME') || textOf(calProps, 'NAME');
  const colorRaw = (prop(calProps, 'X-APPLE-CALENDAR-COLOR') || prop(calProps, 'X-AURORA-COLOR'))?.value?.trim() || '';
  const color = /^#[0-9a-f]{6}/i.test(colorRaw) ? colorRaw.slice(0, 7) : null;
  if (!cals.length && !findAll(root, 'VEVENT').length) return { name: '', color: null, events: [], warnings: ['not-icalendar'] };

  const masters = new Map();
  const instances = [];
  const out = [];
  for (const ve of findAll(root, 'VEVENT')) {
    let ev;
    try {
      ev = eventFromComponent(ve, ctx);
    } catch (err) {
      ctx.warn('bad-event');
      continue;
    }
    if (!ev) continue;
    if (ev.recurrenceId) instances.push(ev);
    else {
      if (ev.cancelled) continue;
      if (ev.uid && masters.has(ev.uid)) ctx.warn('duplicate-uid');
      if (ev.uid) masters.set(ev.uid, ev);
      out.push(ev);
    }
  }
  for (const inst of instances) {
    const master = inst.uid ? masters.get(inst.uid) : null;
    if (!master || !master.rrule) {
      if (inst.cancelled) continue;
      // An orphan instance becomes a standalone event.
      delete inst.recurrenceId;
      if (master && !master.rrule) continue;
      out.push(inst);
      continue;
    }
    const key = occurrenceKeyFrom(inst.recurrenceId.value, inst.recurrenceId.params, master, ctx);
    if (key == null) continue;
    if (inst.cancelled) {
      master.exdates.push(key);
      continue;
    }
    const base = baseOccurrence(master, key);
    const o = {};
    if (inst.allDay === master.allDay) {
      if (inst.start !== base.start) o.start = inst.start;
      if (inst.end !== base.end) o.end = inst.end;
      if (o.start !== undefined || o.end !== undefined) {
        o.start = inst.start;
        o.end = inst.end;
      }
    }
    for (const f of ['title', 'location', 'description']) if (inst[f] !== master[f]) o[f] = inst[f];
    if (inst.reminder !== master.reminder) o.reminder = inst.reminder;
    master.overrides = master.overrides || {};
    master.overrides[key] = o;
  }
  for (const ev of out) {
    delete ev.cancelled;
    delete ev.recurrenceId;
    ev.exdates = [...new Set(ev.exdates || [])];
  }
  return { name, color, events: out, warnings };
}

// ------------------------------------------------------------------ export
const p2 = (n) => String(n).padStart(2, '0');
const p4 = (n) => String(n).padStart(4, '0');
function utcStamp(ms) {
  const t = new Date(ms);
  return `${p4(t.getUTCFullYear())}${p2(t.getUTCMonth() + 1)}${p2(t.getUTCDate())}T${p2(t.getUTCHours())}${p2(t.getUTCMinutes())}${p2(t.getUTCSeconds())}Z`;
}
function wallStamp(ms, tz) {
  const w = utcToZoned(ms, tz);
  return `${p4(w.y)}${p2(w.m + 1)}${p2(w.d)}T${p2(w.hh)}${p2(w.mi)}${p2(w.ss)}`;
}
const dateStamp = (key) => key.replace(/-/g, '');

const encoder = new TextEncoder();
export function foldLine(line) {
  if (encoder.encode(line).length <= 75) return line;
  const out = [];
  let cur = '';
  let len = 0;
  let limit = 75;
  for (const ch of line) {
    const l = encoder.encode(ch).length;
    if (len + l > limit) {
      out.push(cur);
      cur = '';
      len = 0;
      limit = 74;
    }
    cur += ch;
    len += l;
  }
  out.push(cur);
  return out.join('\r\n ');
}

function fmtOffset(ms) {
  const m = Math.round(ms / 60000);
  const s = m < 0 ? '-' : '+';
  const a = Math.abs(m);
  return `${s}${p2(Math.floor(a / 60))}${p2(a % 60)}`;
}

// VTIMEZONE built from what Intl knows about the zone: the transitions of `year`, expressed as yearly
// rules (last/nth weekday of the month), which is how every common zone is defined.
export function vtimezone(tz, year) {
  const lines = ['BEGIN:VTIMEZONE', `TZID:${tz}`];
  const startOfYear = Date.UTC(year, 0, 1);
  let off = tzOffset(startOfYear, tz);
  const trans = [];
  for (let t = startOfYear + DAY_MS; t <= Date.UTC(year + 1, 0, 1); t += DAY_MS) {
    const o = tzOffset(t, tz);
    if (o === off) continue;
    let lo = t - DAY_MS;
    let hi = t;
    while (hi - lo > 60000) {
      const mid = Math.floor((lo + hi) / 2 / 60000) * 60000;
      if (tzOffset(mid, tz) === off) lo = mid;
      else hi = mid;
    }
    trans.push({ at: hi, from: off, to: o });
    off = o;
  }
  if (!trans.length) {
    lines.push('BEGIN:STANDARD', 'DTSTART:19700101T000000', `TZOFFSETFROM:${fmtOffset(off)}`, `TZOFFSETTO:${fmtOffset(off)}`, 'END:STANDARD');
  } else {
    for (const tr of trans) {
      const w = new Date(tr.at + tr.from);
      const y = w.getUTCFullYear();
      const m = w.getUTCMonth();
      const d = w.getUTCDate();
      const nth = d + 7 > daysInMonth(y, m) ? -1 : Math.ceil(d / 7);
      const kind = tr.to > tr.from ? 'DAYLIGHT' : 'STANDARD';
      lines.push(
        `BEGIN:${kind}`,
        `DTSTART:${p4(y)}${p2(m + 1)}${p2(d)}T${p2(w.getUTCHours())}${p2(w.getUTCMinutes())}00`,
        `RRULE:FREQ=YEARLY;BYMONTH=${m + 1};BYDAY=${nth}${WEEKDAYS[w.getUTCDay()]}`,
        `TZOFFSETFROM:${fmtOffset(tr.from)}`,
        `TZOFFSETTO:${fmtOffset(tr.to)}`,
        `END:${kind}`,
      );
    }
  }
  lines.push('END:VTIMEZONE');
  return lines;
}

function dtLines(name, value, ev) {
  if (ev.allDay) return `${name};VALUE=DATE:${dateStamp(value)}`;
  if (ev.tz === 'UTC') return `${name}:${utcStamp(value)}`;
  return `${name};TZID=${ev.tz}:${wallStamp(value, ev.tz)}`;
}

function alarmLines(minutes, title) {
  if (minutes == null) return [];
  const a = Math.abs(minutes);
  const dur = a === 0 ? 'PT0S' : a % 1440 === 0 ? `P${a / 1440}D` : `PT${a % 60 === 0 ? `${a / 60}H` : `${a}M`}`;
  return ['BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escapeText(title || 'Reminder')}`, `TRIGGER:${minutes > 0 ? '-' : ''}${dur}`, 'END:VALARM'];
}

export function serializeIcs({ name = '', events = [], now = Date.now(), color = null } = {}) {
  const evs = events.map(sanitizeEvent).filter(Boolean);
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Selene OS//Calendar 1.0//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  if (name) lines.push(`X-WR-CALNAME:${escapeText(name)}`);
  if (color) lines.push(`X-APPLE-CALENDAR-COLOR:${color}`);
  lines.push(`X-WR-TIMEZONE:${systemTz()}`);
  const zones = new Map();
  for (const ev of evs) {
    if (ev.allDay || ev.tz === 'UTC') continue;
    const y = new Date(ev.start).getUTCFullYear();
    zones.set(ev.tz, Math.min(zones.get(ev.tz) ?? y, y));
  }
  for (const [tz, y] of zones) lines.push(...vtimezone(tz, y));
  for (const ev of evs) {
    const common = (start, end, f, extra = []) => {
      const out = ['BEGIN:VEVENT', `UID:${ev.uid}`, `DTSTAMP:${utcStamp(now)}`, ...extra, dtLines('DTSTART', start, ev), dtLines('DTEND', end, ev)];
      out.push(`SUMMARY:${escapeText(f.title)}`);
      if (f.location) out.push(`LOCATION:${escapeText(f.location)}`);
      if (f.description) out.push(`DESCRIPTION:${escapeText(f.description)}`);
      if (f.color) out.push(`X-AURORA-COLOR:${f.color}`);
      return out;
    };
    const main = common(ev.start, ev.end, ev, [`CREATED:${utcStamp(ev.created || now)}`, `LAST-MODIFIED:${utcStamp(ev.updated || now)}`]);
    if (ev.rrule) {
      main.push(`RRULE:${formatRRule(ev.rrule, { allDay: ev.allDay })}`);
      if (ev.exdates?.length) {
        if (ev.allDay) main.push(`EXDATE;VALUE=DATE:${ev.exdates.map(dateStamp).join(',')}`);
        else if (ev.tz === 'UTC') main.push(`EXDATE:${ev.exdates.map((k) => utcStamp(Number(k))).join(',')}`);
        else main.push(`EXDATE;TZID=${ev.tz}:${ev.exdates.map((k) => wallStamp(Number(k), ev.tz)).join(',')}`);
      }
    }
    main.push(...alarmLines(ev.reminder, ev.title), 'END:VEVENT');
    lines.push(...main);
    if (ev.rrule) {
      for (const [key, o] of Object.entries(ev.overrides || {})) {
        if (ev.exdates?.includes(key)) continue;
        const base = baseOccurrence(ev, key);
        const f = { ...ev, ...o };
        const rid = ev.allDay ? `RECURRENCE-ID;VALUE=DATE:${dateStamp(key)}` : ev.tz === 'UTC' ? `RECURRENCE-ID:${utcStamp(Number(key))}` : `RECURRENCE-ID;TZID=${ev.tz}:${wallStamp(Number(key), ev.tz)}`;
        const inst = common(o.start ?? base.start, o.end ?? base.end, f, [rid]);
        inst.push(...alarmLines(o.reminder !== undefined ? o.reminder : ev.reminder, f.title), 'END:VEVENT');
        lines.push(...inst);
      }
    }
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}
