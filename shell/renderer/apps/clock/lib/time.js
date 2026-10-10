// Clock — pure time helpers (no DOM): alarm next occurrence, time zone offsets, locale formatting,
// durations. Everything goes through Intl so time zones, DST and 12/24 h follow the locale.
// Unit-tested from shell/test/clock.test.mjs (imported in the page with import()).

export const SEC = 1000;
export const MIN = 60 * SEC;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

/**
 * Next time an alarm rings, strictly after `after` (epoch ms), in the *local* time zone.
 *   alarm: { hour 0..23, minute 0..59, days: [0..6] (0 = Sunday; empty/null = only once) }
 * Wall-clock semantics: 07:00 stays 07:00 across DST changes. A time that does not exist on a
 * spring-forward day (02:30) rings when the clock jumps (03:30), like Windows.
 */
export function nextAlarmOccurrence(alarm, after = Date.now()) {
  const hour = clampInt(alarm?.hour, 0, 23);
  const minute = clampInt(alarm?.minute, 0, 59);
  const days = Array.isArray(alarm?.days) ? alarm.days.map(Number).filter((d) => d >= 0 && d <= 6) : [];
  const base = new Date(after);
  for (let i = 0; i <= 8; i++) {
    // Build each candidate from the calendar date (not by adding 24 h) so DST days keep the wall time.
    const c = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i, hour, minute, 0, 0);
    if (c.getTime() <= after) continue;
    if (!days.length || days.includes(c.getDay())) return c.getTime();
  }
  return null;
}

function clampInt(v, min, max) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
}

/** Split a duration into whole days / hours / minutes, rounding up to the next minute (Windows style). */
export function splitUntil(ms) {
  const mins = Math.max(0, Math.ceil(ms / MIN));
  return { days: Math.floor(mins / 1440), hours: Math.floor((mins % 1440) / 60), minutes: mins % 60, total: mins };
}

/** "Rings in 7 hours, 15 minutes" — t is the app translator. */
export function ringsIn(t, ms) {
  if (ms < MIN) return t('alarm.ringsSoon');
  const { days, hours, minutes } = splitUntil(ms);
  const parts = [];
  if (days) parts.push(t('units.days', { count: days }));
  if (hours) parts.push(t('units.hours', { count: hours }));
  if (minutes && !days) parts.push(t('units.minutes', { count: minutes }));
  return t('alarm.ringsIn', { when: joinParts(t, parts) });
}

export function joinParts(t, parts) {
  if (parts.length <= 1) return parts[0] || '';
  return parts.slice(0, -1).join(t('units.sep')) + t('units.and') + parts[parts.length - 1];
}

// ------------------------------------------------------------------ time zones
const offFmt = new Map();
const partFmt = new Map();

export function isValidZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// CLDR (what Intl may report) still uses a few old names; the city list uses the current IANA ones.
const ALIASES = {
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Asia/Rangoon': 'Asia/Yangon',
  'Asia/Ulan_Bator': 'Asia/Ulaanbaatar',
  'Europe/Kiev': 'Europe/Kyiv',
  'America/Godthab': 'America/Nuuk',
  'Atlantic/Faeroe': 'Atlantic/Faroe',
  'Pacific/Ponape': 'Pacific/Pohnpei',
  'Pacific/Truk': 'Pacific/Chuuk',
  'America/Buenos_Aires': 'America/Argentina/Buenos_Aires',
  'America/Indianapolis': 'America/Indiana/Indianapolis',
  'Etc/UTC': 'UTC',
  'Etc/GMT': 'UTC',
};
export const canonicalZone = (tz) => ALIASES[tz] || tz;

export function localZone() {
  try {
    return canonicalZone(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  } catch {
    return 'UTC';
  }
}

/** UTC offset of a zone at a moment, in minutes (east positive): Asia/Kolkata -> 330. */
export function zoneOffset(tz, at = Date.now()) {
  let f = offFmt.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset', year: 'numeric' });
    offFmt.set(tz, f);
  }
  const name = f.formatToParts(new Date(at)).find((p) => p.type === 'timeZoneName')?.value || 'GMT';
  const m = /GMT([+-−])(\d{1,2})(?::?(\d{2}))?/.exec(name);
  if (!m) return 0;
  const sign = m[1] === '+' ? 1 : -1;
  return sign * (Number(m[2]) * 60 + Number(m[3] || 0));
}

/** Calendar fields of a moment in a zone: { y, mo, d, h, mi, s, wd } */
export function zoneParts(tz, at = Date.now()) {
  let f = partFmt.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short' });
    partFmt.set(tz, f);
  }
  const o = {};
  for (const p of f.formatToParts(new Date(at))) o[p.type] = p.value;
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(o.weekday);
  return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second, wd };
}

/** Difference between a zone and the local zone, in minutes, at a moment. */
export function offsetFromLocal(tz, at = Date.now(), local = localZone()) {
  return zoneOffset(tz, at) - zoneOffset(local, at);
}

/** "+6 h", "−5 h 30", "+0 h" */
export function shortOffset(t, mins) {
  if (!mins) return t('world.sameShort');
  const sign = mins > 0 ? '+' : '−';
  const a = Math.abs(mins);
  const h = Math.floor(a / 60);
  const m = a % 60;
  return m ? t('world.offsetShortMin', { sign, h, m: String(m).padStart(2, '0') }) : t('world.offsetShort', { sign, h });
}

/** "6 hours ahead", "5 hours 30 minutes behind", "Same time" */
export function longOffset(t, mins) {
  if (!mins) return t('world.sameTime');
  const a = Math.abs(mins);
  const parts = [];
  if (Math.floor(a / 60)) parts.push(t('units.hours', { count: Math.floor(a / 60) }));
  if (a % 60) parts.push(t('units.minutes', { count: a % 60 }));
  return t(mins > 0 ? 'world.ahead' : 'world.behind', { d: parts.join(' ') });
}

/** -1 yesterday, 0 today, 1 tomorrow: the zone's calendar day compared with the local one. */
export function dayDelta(tz, at = Date.now(), local = localZone()) {
  const a = zoneParts(tz, at);
  const b = zoneParts(local, at);
  const da = Date.UTC(a.y, a.mo - 1, a.d);
  const db = Date.UTC(b.y, b.mo - 1, b.d);
  return Math.round((da - db) / DAY);
}

// ------------------------------------------------------------------ formatting
/** 12-hour clock? clock24h setting: true/false, or null = locale default. */
export function uses12h(locale, clock24h) {
  if (clock24h === true) return false;
  if (clock24h === false) return true;
  try {
    const hc = new Intl.DateTimeFormat(locale, { hour: 'numeric' }).resolvedOptions().hourCycle;
    return hc === 'h11' || hc === 'h12';
  } catch {
    return !String(locale).startsWith('fr');
  }
}

const fmtCache = new Map();
function fmt(locale, opts) {
  const k = locale + JSON.stringify(opts);
  let f = fmtCache.get(k);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, opts);
    fmtCache.set(k, f);
  }
  return f;
}

/** Time of day split for display: { main: '7:05', period: 'AM' | '' , full: '7:05 AM' } */
export function timeParts(at, { locale = 'en-US', h12 = false, tz, seconds = false } = {}) {
  const opts = { hour: 'numeric', minute: '2-digit', hourCycle: h12 ? 'h12' : 'h23' };
  if (!h12) opts.hour = '2-digit';
  if (seconds) opts.second = '2-digit';
  if (tz) opts.timeZone = tz;
  const parts = fmt(locale, opts).formatToParts(new Date(at));
  let main = '';
  let period = '';
  for (const p of parts) {
    if (p.type === 'dayPeriod') period = p.value;
    else main += p.value;
  }
  main = main.trim();
  return { main, period, full: period ? `${main} ${period}` : main };
}

/** Wall time (hour, minute) for display, independent of any date: 07:00 / 7:00 AM */
export function wallTime(hour, minute, o) {
  return timeParts(new Date(2024, 0, 1, hour, minute), o);
}

export function formatDate(at, locale, opts) {
  return fmt(locale, opts).format(new Date(at));
}

/** Weekday short names indexed by JS day (0 = Sunday), without trailing dots: Sun / dim */
export function weekdayNames(locale, style = 'short') {
  const f = fmt(locale, { weekday: style, timeZone: 'UTC' });
  // 2024-01-07 was a Sunday
  return Array.from({ length: 7 }, (_, i) => {
    const s = f.format(new Date(Date.UTC(2024, 0, 7 + i, 12))).replace(/\.$/, '');
    return s.charAt(0).toLocaleUpperCase(locale) + s.slice(1);
  });
}

/** Days in display order, starting with the locale's first day of the week. */
export function weekOrder(locale) {
  let first = String(locale).startsWith('en-US') ? 0 : 1;
  try {
    const loc = new Intl.Locale(locale);
    const info = loc.getWeekInfo?.() || loc.weekInfo;
    if (info?.firstDay) first = info.firstDay % 7;
  } catch {}
  return Array.from({ length: 7 }, (_, i) => (first + i) % 7);
}

/** hh:mm:ss (always 2-digit groups, Windows Timer style) */
export function hms(ms, { forceHours = true } = {}) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const p = (n) => String(n).padStart(2, '0');
  return forceHours || h ? `${p(h)}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}

/** Stopwatch: { h, m, s, cs } with hundredths, floor-based */
export function swParts(ms) {
  const v = Math.max(0, Math.floor(ms / 10));
  const cs = v % 100;
  const total = Math.floor(v / 100);
  return { h: Math.floor(total / 3600), m: Math.floor((total % 3600) / 60), s: total % 60, cs };
}

export function swText(ms, locale = 'en-US') {
  const { h, m, s, cs } = swParts(ms);
  const p = (n) => String(n).padStart(2, '0');
  const dec = String(locale).startsWith('fr') ? ',' : '.';
  return `${p(h)}:${p(m)}:${p(s)}${dec}${p(cs)}`;
}

/** Local calendar key 'YYYY-MM-DD' */
export function dayKey(at = Date.now()) {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function addDays(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  return dayKey(new Date(y, m - 1, d + n, 12));
}

/** Name for a timer without a name: "5 min", "1 hr 30 min", "45 sec", "2 min 30 sec" */
export function durationName(t, ms) {
  const total = Math.round(ms / 1000);
  const s = total % 60;
  const m = Math.floor(total / 60);
  if (!m) return t('units.sOnly', { s });
  if (s) return t('units.mSec', { m, s });
  return minutesText(t, m);
}

/** Short duration text: "1 hr 30 min" / "45 min" */
export function minutesText(t, mins) {
  mins = Math.max(0, Math.round(mins));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h && m) return t('units.hMin', { h, m });
  if (h) return t('units.hOnly', { h });
  return t('units.mOnly', { m });
}
