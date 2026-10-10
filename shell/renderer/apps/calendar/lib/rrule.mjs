// RFC 5545 recurrence rules (the subset calendars actually use). Pure module (shell + Node).
//
// Rule object (what events store):
//   { freq: 'DAILY'|'WEEKLY'|'MONTHLY'|'YEARLY', interval: 1, count: null|n,
//     until: null | epoch ms (timed events) | 'YYYY-MM-DD' (all-day events),
//     byday: null | ['MO', '2TU', '-1FR'], bymonthday: null | [1, -1], bymonth: null | [1..12],
//     bysetpos: null | [1, -1], wkst: 'MO' }
//
//   parseRRule('FREQ=WEEKLY;BYDAY=MO,WE', { allDay, tz }) -> rule | null
//   formatRRule(rule, { allDay }) -> 'FREQ=WEEKLY;BYDAY=MO,WE'
//   ruleDays(rule, startDay, jumpTo) -> generator of day numbers (see dates.mjs), ascending, >= startDay,
//       DTSTART excluded from nothing: callers add DTSTART themselves (it always counts as an occurrence).
//       `jumpTo` (a day number) lets rules without COUNT skip periods that end before it.
import { dayNum, fromDayNum, weekdayOf, daysInMonth, WEEKDAYS, dateKey, parseDateKey } from './dates.mjs';
import { zonedToUtc } from './tz.mjs';

export const FREQS = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'];
const WD = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const MAX_DAY = dayNum(2999, 11, 31);

export function parseByday(s) {
  const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/i.exec(String(s).trim());
  if (!m) return null;
  const n = m[1] ? Number(m[1]) : 0;
  if (Math.abs(n) > 53) return null;
  return { n, wd: WD[m[2].toUpperCase()] };
}

export function formatByday({ n, wd }) {
  return `${n ? n : ''}${WEEKDAYS[wd]}`;
}

const intList = (v, min, max, allowNeg = false) =>
  String(v)
    .split(',')
    .map((x) => Number(x.trim()))
    .filter((x) => Number.isInteger(x) && x !== 0 && (allowNeg ? Math.abs(x) >= min && Math.abs(x) <= max : x >= min && x <= max));

// iCalendar DATE / DATE-TIME text -> { date: {y,m,d}, time: {hh,mi,ss} | null, utc: bool }
export function parseIcsDateTime(v) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(String(v || '').trim());
  if (!m) return null;
  const date = { y: Number(m[1]), m: Number(m[2]) - 1, d: Number(m[3]) };
  if (date.m < 0 || date.m > 11 || date.d < 1 || date.d > daysInMonth(date.y, date.m)) return null;
  if (m[4] === undefined) return { date, time: null, utc: false };
  const time = { hh: Number(m[4]), mi: Number(m[5]), ss: Number(m[6] || 0) };
  if (time.hh > 23 || time.mi > 59 || time.ss > 60) return null;
  return { date, time, utc: !!m[7] };
}

export function parseRRule(str, { allDay = false, tz = 'UTC' } = {}) {
  if (!str) return null;
  const parts = {};
  for (const seg of String(str).replace(/^RRULE:/i, '').split(';')) {
    const i = seg.indexOf('=');
    if (i < 0) continue;
    parts[seg.slice(0, i).trim().toUpperCase()] = seg.slice(i + 1).trim();
  }
  const freq = (parts.FREQ || '').toUpperCase();
  if (!FREQS.includes(freq)) return null;
  const rule = { freq, interval: 1, count: null, until: null, byday: null, bymonthday: null, bymonth: null, bysetpos: null, wkst: 'MO' };
  const interval = Number(parts.INTERVAL || 1);
  rule.interval = Number.isInteger(interval) && interval > 0 ? Math.min(interval, 999) : 1;
  if (parts.COUNT) {
    const c = Number(parts.COUNT);
    if (Number.isInteger(c) && c > 0) rule.count = Math.min(c, 5000);
  }
  if (parts.UNTIL) {
    const u = parseIcsDateTime(parts.UNTIL);
    if (u) {
      if (allDay) rule.until = dateKey(u.date);
      else if (!u.time) rule.until = zonedToUtc(u.date.y, u.date.m, u.date.d, 23, 59, 59, tz);
      else if (u.utc) rule.until = Date.UTC(u.date.y, u.date.m, u.date.d, u.time.hh, u.time.mi, u.time.ss);
      else rule.until = zonedToUtc(u.date.y, u.date.m, u.date.d, u.time.hh, u.time.mi, u.time.ss, tz);
    }
  }
  if (parts.BYDAY) {
    const list = parts.BYDAY.split(',').map(parseByday).filter(Boolean);
    if (list.length) rule.byday = [...new Set(list.map(formatByday))];
  }
  if (parts.BYMONTHDAY) {
    const l = intList(parts.BYMONTHDAY, 1, 31, true);
    if (l.length) rule.bymonthday = [...new Set(l)];
  }
  if (parts.BYMONTH) {
    const l = intList(parts.BYMONTH, 1, 12);
    if (l.length) rule.bymonth = [...new Set(l)].sort((a, b) => a - b);
  }
  if (parts.BYSETPOS) {
    const l = intList(parts.BYSETPOS, 1, 366, true);
    if (l.length) rule.bysetpos = [...new Set(l)];
  }
  if (parts.WKST && WD[parts.WKST.toUpperCase()] !== undefined) rule.wkst = parts.WKST.toUpperCase();
  return rule;
}

function icsUtc(ms) {
  const t = new Date(ms);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(t.getUTCFullYear(), 4)}${p(t.getUTCMonth() + 1)}${p(t.getUTCDate())}T${p(t.getUTCHours())}${p(t.getUTCMinutes())}${p(t.getUTCSeconds())}Z`;
}

export function formatRRule(rule, { allDay = false } = {}) {
  if (!rule || !FREQS.includes(rule.freq)) return '';
  const out = [`FREQ=${rule.freq}`];
  if (rule.interval > 1) out.push(`INTERVAL=${rule.interval}`);
  if (rule.count) out.push(`COUNT=${rule.count}`);
  else if (rule.until != null) {
    if (typeof rule.until === 'string') {
      const p = parseDateKey(rule.until);
      if (p) out.push(`UNTIL=${rule.until.replace(/-/g, '')}${allDay ? '' : 'T235959Z'}`);
    } else if (Number.isFinite(rule.until)) out.push(`UNTIL=${allDay ? icsUtc(rule.until).slice(0, 8) : icsUtc(rule.until)}`);
  }
  if (rule.byday?.length) out.push(`BYDAY=${rule.byday.join(',')}`);
  if (rule.bymonthday?.length) out.push(`BYMONTHDAY=${rule.bymonthday.join(',')}`);
  if (rule.bymonth?.length) out.push(`BYMONTH=${rule.bymonth.join(',')}`);
  if (rule.bysetpos?.length) out.push(`BYSETPOS=${rule.bysetpos.join(',')}`);
  if (rule.wkst && rule.wkst !== 'MO') out.push(`WKST=${rule.wkst}`);
  return out.join(';');
}

// Clean up a rule coming from storage or the editor. Returns null when unusable.
export function sanitizeRule(r) {
  if (!r || typeof r !== 'object' || !FREQS.includes(r.freq)) return null;
  const ints = (v, min, max, neg) =>
    Array.isArray(v) ? [...new Set(v.map(Number).filter((x) => Number.isInteger(x) && x !== 0 && (neg ? Math.abs(x) >= min && Math.abs(x) <= max : x >= min && x <= max)))] : [];
  const interval = Math.floor(Number(r.interval));
  const out = {
    freq: r.freq,
    interval: interval >= 1 ? Math.min(interval, 999) : 1,
    count: null,
    until: null,
    byday: null,
    bymonthday: null,
    bymonth: null,
    bysetpos: null,
    wkst: WD[r.wkst] !== undefined ? r.wkst : 'MO',
  };
  const count = Number(r.count);
  if (r.count != null && Number.isInteger(count) && count > 0) out.count = Math.min(count, 5000);
  else if (typeof r.until === 'string' && parseDateKey(r.until)) out.until = r.until;
  else if (typeof r.until === 'number' && Number.isFinite(r.until)) out.until = r.until;
  if (Array.isArray(r.byday)) {
    const l = [...new Set(r.byday.map(parseByday).filter(Boolean).map(formatByday))];
    if (l.length) out.byday = l;
  }
  const md = ints(r.bymonthday, 1, 31, true);
  if (md.length) out.bymonthday = md;
  const mo = ints(r.bymonth, 1, 12, false).sort((a, b) => a - b);
  if (mo.length) out.bymonth = mo;
  const sp = ints(r.bysetpos, 1, 366, true);
  if (sp.length) out.bysetpos = sp;
  return out;
}

function applySetPos(sorted, setpos) {
  if (!setpos) return sorted;
  const out = [];
  for (const p of setpos) {
    const v = p > 0 ? sorted[p - 1] : sorted[sorted.length + p];
    if (v !== undefined) out.push(v);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

function daysOfMonth(y, m, ctx) {
  const dim = daysInMonth(y, m);
  let set = null;
  if (ctx.bymonthday) {
    set = ctx.bymonthday.map((d) => (d > 0 ? d : dim + d + 1)).filter((d) => d >= 1 && d <= dim);
  }
  if (ctx.byday) {
    const first = weekdayOf(dayNum(y, m, 1));
    const days = [];
    for (const { n, wd } of ctx.byday) {
      const firstWd = 1 + ((wd - first + 7) % 7);
      if (n === 0) for (let d = firstWd; d <= dim; d += 7) days.push(d);
      else if (n > 0) {
        const d = firstWd + (n - 1) * 7;
        if (d <= dim) days.push(d);
      } else {
        const lastWd = firstWd + Math.floor((dim - firstWd) / 7) * 7;
        const d = lastWd + (n + 1) * 7;
        if (d >= 1) days.push(d);
      }
    }
    set = set ? set.filter((d) => days.includes(d)) : days;
  }
  if (!set) set = ctx.start.d <= dim ? [ctx.start.d] : [];
  return [...new Set(set)].sort((a, b) => a - b).map((d) => dayNum(y, m, d));
}

function daysOfYear(y, ctx) {
  // BYDAY without BYMONTH in a yearly rule counts weekdays across the whole year.
  const first = dayNum(y, 0, 1);
  const last = dayNum(y, 11, 31);
  const out = [];
  for (const { n, wd } of ctx.byday) {
    const firstWd = first + ((wd - weekdayOf(first) + 7) % 7);
    if (n === 0) for (let d = firstWd; d <= last; d += 7) out.push(d);
    else if (n > 0) {
      const d = firstWd + (n - 1) * 7;
      if (d <= last) out.push(d);
    } else {
      const lastWd = last - ((weekdayOf(last) - wd + 7) % 7);
      const d = lastWd + (n + 1) * 7;
      if (d >= first) out.push(d);
    }
  }
  return out;
}

export function* ruleDays(rule, startDay, jumpTo = null) {
  if (!rule || !FREQS.includes(rule.freq)) return;
  const interval = Math.max(1, Math.floor(rule.interval) || 1);
  const start = fromDayNum(startDay);
  const ctx = {
    start,
    byday: rule.byday?.length ? rule.byday.map(parseByday).filter(Boolean) : null,
    bymonthday: rule.bymonthday?.length ? rule.bymonthday : null,
  };
  if (ctx.byday && !ctx.byday.length) ctx.byday = null;
  const bymonth = rule.bymonth?.length ? rule.bymonth : null;
  const bysetpos = rule.bysetpos?.length ? rule.bysetpos : null;
  const wkst = WD[rule.wkst] ?? 1;
  const canJump = jumpTo != null && !rule.count && jumpTo > startDay;
  let empty = 0;
  const MAX_EMPTY = 2000;

  if (rule.freq === 'DAILY') {
    const wds = ctx.byday ? new Set(ctx.byday.map((b) => b.wd)) : null;
    let k = canJump ? Math.max(0, Math.floor((jumpTo - startDay) / interval) - 1) : 0;
    for (; ; k++) {
      const n = startDay + k * interval;
      if (n > MAX_DAY) return;
      const p = fromDayNum(n);
      let ok = true;
      if (bymonth && !bymonth.includes(p.m + 1)) ok = false;
      if (ok && wds && !wds.has(p.wd)) ok = false;
      if (ok && ctx.bymonthday) {
        const dim = daysInMonth(p.y, p.m);
        ok = ctx.bymonthday.some((d) => (d > 0 ? d : dim + d + 1) === p.d);
      }
      if (ok) {
        empty = 0;
        yield n;
      } else if (++empty > MAX_EMPTY * 4) return;
    }
  }

  if (rule.freq === 'WEEKLY') {
    const week0 = startDay - ((weekdayOf(startDay) - wkst + 7) % 7);
    const wds = ctx.byday ? [...new Set(ctx.byday.map((b) => b.wd))] : [weekdayOf(startDay)];
    const offsets = wds.map((wd) => (wd - wkst + 7) % 7).sort((a, b) => a - b);
    let k = canJump ? Math.max(0, Math.floor((jumpTo - week0) / (7 * interval)) - 1) : 0;
    for (; ; k++) {
      const ws = week0 + k * 7 * interval;
      if (ws > MAX_DAY) return;
      let days = offsets.map((o) => ws + o);
      if (bymonth) days = days.filter((n) => bymonth.includes(fromDayNum(n).m + 1));
      days = applySetPos(days, bysetpos);
      let any = false;
      for (const n of days) {
        if (n < startDay) continue;
        any = true;
        yield n;
      }
      if (any) empty = 0;
      else if (++empty > MAX_EMPTY) return;
    }
  }

  if (rule.freq === 'MONTHLY') {
    let k = 0;
    if (canJump) {
      const j = fromDayNum(jumpTo);
      const months = (j.y - start.y) * 12 + (j.m - start.m);
      k = Math.max(0, Math.floor(months / interval) - 1);
    }
    for (; ; k++) {
      const mi = start.m + k * interval;
      const y = start.y + Math.floor(mi / 12);
      const m = mi % 12;
      if (y > 2999) return;
      let days = [];
      if (!bymonth || bymonth.includes(m + 1)) days = applySetPos(daysOfMonth(y, m, ctx), bysetpos);
      let any = false;
      for (const n of days) {
        if (n < startDay) continue;
        any = true;
        yield n;
      }
      if (any) empty = 0;
      else if (++empty > MAX_EMPTY) return;
    }
  }

  if (rule.freq === 'YEARLY') {
    let k = 0;
    if (canJump) k = Math.max(0, Math.floor((fromDayNum(jumpTo).y - start.y) / interval) - 1);
    for (; ; k++) {
      const y = start.y + k * interval;
      if (y > 2999) return;
      let days;
      if (bymonth) days = bymonth.flatMap((mo) => daysOfMonth(y, mo - 1, ctx));
      else if (ctx.byday && !ctx.bymonthday) days = daysOfYear(y, ctx);
      else if (ctx.bymonthday || ctx.byday) days = Array.from({ length: 12 }, (_, mo) => daysOfMonth(y, mo, ctx)).flat();
      else days = start.d <= daysInMonth(y, start.m) ? [dayNum(y, start.m, start.d)] : [];
      days = applySetPos([...new Set(days)].sort((a, b) => a - b), bysetpos);
      let any = false;
      for (const n of days) {
        if (n < startDay) continue;
        any = true;
        yield n;
      }
      if (any) empty = 0;
      else if (++empty > 400) return;
    }
  }
}
