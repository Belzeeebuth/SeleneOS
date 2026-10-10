// Pure date math for To Do (local time, no DOM). Calendar dates are 'YYYY-MM-DD' strings, so they
// compare lexicographically and never drift with time zones / DST; reminders are epoch ms.
//
//   ymd(dateOrMs) -> 'YYYY-MM-DD'          parseYmd(s) -> Date (local midnight) | null
//   addDays(s, n)  addMonths(s, n, anchorDay)  diffDays(a, b)  weekday(s)  startOfWeek(s, weekStart)
//   dueState(due, now)        -> null | 'overdue' | 'today' | 'tomorrow' | 'future'
//   plannedBucket(due, now, weekStart) -> 'earlier' | 'today' | 'tomorrow' | 'thisWeek' | 'later'
//   nextDue(due, repeat, weekStart)    -> next due date of a repeating task
//   alignDue(day, repeat, weekStart)   -> first valid due date on/after `day` for a repeat rule
//   shiftReminder(remindAt, oldDue, newDue) -> same wall-clock time, moved by the due-date delta
//   reminderPresets(now) -> { laterToday | null, tomorrow, nextWeek }   duePresets(now) -> { today, tomorrow, nextWeek }
//   makeRepeat(kind, due, extra) -> repeat rule   repeatKey(repeat) -> preset kind or 'custom'
//
// A repeat rule is { kind, freq: 'day'|'week'|'month'|'year', interval >= 1, days?: [0..6] (week),
// anchorDay?: 1..31 (month / year: the day of month to come back to, e.g. 31 -> Jan 31, Feb 28, Mar 31) }.
export const DAY = 86400000;
const pad = (n) => String(n).padStart(2, '0');

export function ymd(d) {
  const x = d instanceof Date ? d : new Date(d);
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
}

export function parseYmd(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof s === 'string' ? s : '');
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]) ? d : null;
}

export const isYmd = (s) => parseYmd(s) !== null;

export function addDays(s, n) {
  const d = parseYmd(s);
  d.setDate(d.getDate() + n);
  return ymd(d);
}

export function daysInMonth(y, m0) {
  return new Date(y, m0 + 1, 0).getDate();
}

/** Add n months; the day is `anchorDay` (default: the day of s) clamped to the month length. */
export function addMonths(s, n, anchorDay) {
  const d = parseYmd(s);
  const day = anchorDay || d.getDate();
  let m = d.getMonth() + n;
  const y = d.getFullYear() + Math.floor(m / 12);
  m = ((m % 12) + 12) % 12;
  return ymd(new Date(y, m, Math.min(day, daysInMonth(y, m))));
}

/** Calendar days from a to b (b - a). */
export function diffDays(a, b) {
  return Math.round((parseYmd(b) - parseYmd(a)) / DAY);
}

export function weekday(s) {
  return parseYmd(s).getDay();
}

export function startOfWeek(s, weekStart = 0) {
  return addDays(s, -((weekday(s) - weekStart + 7) % 7));
}

export function dueState(due, now = Date.now()) {
  if (!isYmd(due)) return null;
  const today = ymd(now);
  if (due < today) return 'overdue';
  if (due === today) return 'today';
  if (due === addDays(today, 1)) return 'tomorrow';
  return 'future';
}

export function plannedBucket(due, now = Date.now(), weekStart = 0) {
  const today = ymd(now);
  if (due < today) return 'earlier';
  if (due === today) return 'today';
  if (due === addDays(today, 1)) return 'tomorrow';
  if (due <= addDays(startOfWeek(today, weekStart), 6)) return 'thisWeek';
  return 'later';
}
export const PLANNED_BUCKETS = ['earlier', 'today', 'tomorrow', 'thisWeek', 'later'];

// ------------------------------------------------------------------ repeat rules
export const REPEAT_KINDS = ['daily', 'weekdays', 'weekly', 'monthly', 'yearly'];
const WEEKDAYS = [1, 2, 3, 4, 5];

export function makeRepeat(kind, due, extra = {}) {
  const day = isYmd(due) ? parseYmd(due) : new Date();
  switch (kind) {
    case 'daily':
      return { kind, freq: 'day', interval: 1 };
    case 'weekdays':
      return { kind, freq: 'week', interval: 1, days: [...WEEKDAYS] };
    case 'weekly':
      return { kind, freq: 'week', interval: 1, days: [day.getDay()] };
    case 'monthly':
      return { kind, freq: 'month', interval: 1, anchorDay: day.getDate() };
    case 'yearly':
      return { kind, freq: 'year', interval: 1, anchorDay: day.getDate() };
    default:
      return normalizeRepeat({ kind: 'custom', ...extra, anchorDay: extra.anchorDay || day.getDate() });
  }
}

export function normalizeRepeat(r) {
  if (!r || typeof r !== 'object') return null;
  const freq = ['day', 'week', 'month', 'year'].includes(r.freq) ? r.freq : null;
  if (!freq) return null;
  const out = { kind: [...REPEAT_KINDS, 'custom'].includes(r.kind) ? r.kind : 'custom', freq, interval: Math.max(1, Math.min(999, Math.floor(Number(r.interval)) || 1)) };
  if (freq === 'week') {
    const days = [...new Set((Array.isArray(r.days) ? r.days : []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
    if (days.length) out.days = days;
  }
  if ((freq === 'month' || freq === 'year') && Number.isInteger(Number(r.anchorDay)) && r.anchorDay >= 1 && r.anchorDay <= 31) out.anchorDay = Number(r.anchorDay);
  return out;
}

/** The preset a rule corresponds to ('daily', 'weekdays', …) or 'custom'. */
export function repeatKey(r) {
  if (!r) return null;
  if (r.interval === 1) {
    if (r.freq === 'day') return 'daily';
    if (r.freq === 'week' && r.days?.join(',') === WEEKDAYS.join(',')) return 'weekdays';
    if (r.freq === 'week' && (!r.days || r.days.length === 1)) return 'weekly';
    if (r.freq === 'month') return 'monthly';
    if (r.freq === 'year') return 'yearly';
  }
  return 'custom';
}

export function nextDue(due, r, weekStart = 0) {
  if (!isYmd(due) || !r) return null;
  const n = Math.max(1, r.interval || 1);
  switch (r.freq) {
    case 'day':
      return addDays(due, n);
    case 'week': {
      const order = (d) => (d - weekStart + 7) % 7;
      const days = (r.days?.length ? r.days : [weekday(due)]).map(order).sort((a, b) => a - b);
      const cur = order(weekday(due));
      const later = days.find((o) => o > cur);
      if (later !== undefined) return addDays(due, later - cur);
      return addDays(startOfWeek(due, weekStart), 7 * n + days[0]);
    }
    case 'month':
      return addMonths(due, n, r.anchorDay || parseYmd(due).getDate());
    case 'year':
      return addMonths(due, 12 * n, r.anchorDay || parseYmd(due).getDate());
    default:
      return null;
  }
}

/** First due date on or after `day` that matches the rule (weekly rules on specific days). */
export function alignDue(day, r, weekStart = 0) {
  if (!r || r.freq !== 'week' || !r.days?.length) return day;
  if (r.days.includes(weekday(day))) return day;
  for (let i = 1; i <= 7; i++) {
    const d = addDays(day, i);
    if (r.days.includes(weekday(d))) return d;
  }
  return day;
}

/** Move a reminder by the same number of calendar days as the due date, keeping its local time. */
export function shiftReminder(remindAt, oldDue, newDue) {
  if (!Number.isFinite(remindAt)) return null;
  const d = new Date(remindAt);
  if (isYmd(oldDue) && isYmd(newDue)) d.setDate(d.getDate() + diffDays(oldDue, newDue));
  return d.getTime();
}

// ------------------------------------------------------------------ presets
function atHour(base, days, hour) {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

/** Days until next Monday (1..7). */
function toNextMonday(now) {
  const w = new Date(now).getDay();
  return ((1 - w + 7) % 7) || 7;
}

export function reminderPresets(now = Date.now()) {
  const d = new Date(now);
  // "Later today": 4 hours after the start of the current hour, offered until 22:00.
  const later = new Date(d);
  later.setMinutes(0, 0, 0);
  later.setHours(later.getHours() + 4);
  const laterToday = ymd(later) === ymd(d) && later.getHours() <= 22 ? later.getTime() : null;
  return { laterToday, tomorrow: atHour(now, 1, 9), nextWeek: atHour(now, toNextMonday(now), 9) };
}

export function duePresets(now = Date.now()) {
  const today = ymd(now);
  return { today, tomorrow: addDays(today, 1), nextWeek: addDays(today, toNextMonday(now)) };
}

/** Default reminder time on a picked day: 9:00, or the next full hour when that day is today. */
export function defaultReminderOn(day, now = Date.now()) {
  const d = parseYmd(day) || new Date(now);
  d.setHours(9, 0, 0, 0);
  if (d.getTime() <= now) {
    const n = new Date(now);
    n.setMinutes(0, 0, 0);
    n.setHours(n.getHours() + 1);
    return n.getTime();
  }
  return d.getTime();
}

/** Month grid for a date picker: 6 weeks of 'YYYY-MM-DD' starting on weekStart. */
export function monthGrid(year, month0, weekStart = 0) {
  const first = ymd(new Date(year, month0, 1));
  const start = startOfWeek(first, weekStart);
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}
