// Calendar date helpers. Pure module (shell + Node).
// Two kinds of values are used across the calendar:
//   - "day numbers": whole days since 1970-01-01 (time-zone free), for date-only maths (all-day events,
//     recurrence candidates, holidays). dayNum(y, m, d) <-> fromDayNum(n); dateKey 'YYYY-MM-DD'.
//   - local Date objects / epoch ms in the system time zone, for what is displayed.
export const DAY_MS = 86400000;
export const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

export function dayNum(y, m, d) {
  const t = new Date(Date.UTC(2000, 0, 1));
  t.setUTCFullYear(y, m, d);
  return Math.round(t.getTime() / DAY_MS);
}

export function fromDayNum(n) {
  const t = new Date(n * DAY_MS);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth(), d: t.getUTCDate(), wd: t.getUTCDay() };
}

export const weekdayOf = (n) => (((n + 4) % 7) + 7) % 7; // 1970-01-01 was a Thursday

export function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
}

export function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

export function dateKey(y, m, d) {
  if (typeof y === 'object' && y) return dateKey(y.y, y.m, y.d);
  return `${pad(y, 4)}-${pad(m + 1)}-${pad(d)}`;
}

export function keyFromDayNum(n) {
  return dateKey(fromDayNum(n));
}

export function parseDateKey(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  if (mo < 0 || mo > 11 || d < 1 || d > daysInMonth(y, mo)) return null;
  return { y, m: mo, d };
}

export function dayNumFromKey(s) {
  const p = parseDateKey(s);
  return p ? dayNum(p.y, p.m, p.d) : null;
}

export function isDateKey(s) {
  return !!parseDateKey(s);
}

// ---- local (system time zone) helpers ----
export function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

export function addMonths(d, n) {
  const x = new Date(d);
  const day = x.getDate();
  x.setDate(1);
  x.setMonth(x.getMonth() + n);
  x.setDate(Math.min(day, daysInMonth(x.getFullYear(), x.getMonth())));
  return x;
}

export function sameDay(a, b) {
  if (!a || !b) return false;
  a = new Date(a);
  b = new Date(b);
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function startOfWeek(d, firstDay = 0) {
  const x = startOfDay(d);
  const diff = (x.getDay() - firstDay + 7) % 7;
  return addDays(x, -diff);
}

export function localDayNum(d) {
  const x = new Date(d);
  return dayNum(x.getFullYear(), x.getMonth(), x.getDate());
}

export function localFromDayNum(n) {
  const p = fromDayNum(n);
  return new Date(p.y, p.m, p.d);
}

export function localKey(d) {
  const x = new Date(d);
  return dateKey(x.getFullYear(), x.getMonth(), x.getDate());
}

export function localFromKey(s) {
  const p = parseDateKey(s);
  return p ? new Date(p.y, p.m, p.d) : null;
}

// Local midnight ms of a date key (start of an all-day event in the system time zone).
export function keyToLocalMs(s) {
  const d = localFromKey(s);
  return d ? d.getTime() : NaN;
}

export function minutesOfDay(ms) {
  const d = new Date(ms);
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
}

// Week numbers: ISO 8601 when weeks start on Monday, otherwise the North American rule
// (the week containing January 1st is week 1, weeks start on `firstDay`).
export function weekNumber(d, firstDay = 1) {
  const x = startOfDay(d);
  if (firstDay === 1) {
    const n = localDayNum(x);
    const wd = (weekdayOf(n) + 6) % 7; // Monday = 0
    const thursday = n - wd + 3;
    const ty = fromDayNum(thursday).y;
    const jan4 = dayNum(ty, 0, 4);
    const jan4wd = (weekdayOf(jan4) + 6) % 7;
    const week1Monday = jan4 - jan4wd;
    return Math.floor((thursday - 3 - week1Monday) / 7) + 1;
  }
  const ws = startOfWeek(x, firstDay);
  const we = addDays(ws, 6);
  // A week that contains Jan 1st of the next year is week 1 of that year.
  const y = we.getFullYear() !== ws.getFullYear() ? we.getFullYear() : ws.getFullYear();
  const firstWeekStart = startOfWeek(new Date(y, 0, 1), firstDay);
  return Math.round((localDayNum(ws) - localDayNum(firstWeekStart)) / 7) + 1;
}

// nth weekday of a month: nth(y, m, wd, 3) = 3rd Monday...; n = -1 -> last.
export function nthWeekday(y, m, wd, n) {
  const dim = daysInMonth(y, m);
  if (n > 0) {
    const first = weekdayOf(dayNum(y, m, 1));
    const d = 1 + ((wd - first + 7) % 7) + (n - 1) * 7;
    return d <= dim ? d : null;
  }
  const last = weekdayOf(dayNum(y, m, dim));
  const d = dim - ((last - wd + 7) % 7) + (n + 1) * 7;
  return d >= 1 ? d : null;
}

// Which occurrence of its weekday a date is in its month: { n: 1..5, last: bool }
export function weekdayPosition(y, m, d) {
  return { n: Math.floor((d - 1) / 7) + 1, last: d + 7 > daysInMonth(y, m) };
}
