// Time zone helpers built on Intl (no tz database of our own). Pure module: runs in the shell and in Node.
//   tzOffset(ms, tz)                -> offset of `tz` at instant `ms`, in ms (local - UTC)
//   zonedToUtc(y, m, d, hh, mi, ss, tz) -> epoch ms of that wall-clock time in `tz` (m is 0-based)
//       RFC 5545 rules: a time inside a DST gap uses the offset before the gap (02:30 -> 03:30),
//       an ambiguous time (fall back) is the first occurrence.
//   utcToZoned(ms, tz)              -> { y, m, d, hh, mi, ss, wd }  (wd: 0 = Sunday)
//   systemTz()  isValidTz(tz)  normalizeTzid(tzid) (IANA, Windows names, "/mozilla.org/.../Europe/Paris")
const fmtCache = new Map();
const validCache = new Map();
const DAY = 86400000;

function formatter(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      era: 'short',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function systemTz() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function isValidTz(tz) {
  if (!tz || typeof tz !== 'string') return false;
  if (validCache.has(tz)) return validCache.get(tz);
  let ok = false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    ok = true;
  } catch {
    ok = false;
  }
  validCache.set(tz, ok);
  return ok;
}

export function tzOffset(ms, tz) {
  if (!tz || tz === 'UTC' || tz === 'Etc/UTC') return 0;
  const secMs = Math.floor(ms / 1000) * 1000;
  const parts = formatter(tz).formatToParts(new Date(secMs));
  let y = 0;
  let mo = 0;
  let d = 0;
  let hh = 0;
  let mi = 0;
  let ss = 0;
  let bc = false;
  for (const p of parts) {
    switch (p.type) {
      case 'year':
        y = Number(p.value);
        break;
      case 'month':
        mo = Number(p.value);
        break;
      case 'day':
        d = Number(p.value);
        break;
      case 'hour':
        hh = Number(p.value) % 24;
        break;
      case 'minute':
        mi = Number(p.value);
        break;
      case 'second':
        ss = Number(p.value);
        break;
      case 'era':
        bc = /^B/i.test(p.value);
        break;
      default:
    }
  }
  if (bc) y = 1 - y;
  const asUtc = Date.UTC(y, mo - 1, d, hh, mi, ss);
  const yFix = new Date(asUtc);
  if (y >= 0 && y < 100) yFix.setUTCFullYear(y); // Date.UTC maps years 0..99 to 1900..1999
  return yFix.getTime() - secMs;
}

function wallMs(y, m, d, hh = 0, mi = 0, ss = 0) {
  const t = new Date(Date.UTC(2000, 0, 1, 0, 0, 0));
  t.setUTCFullYear(y, m, d);
  t.setUTCHours(hh, mi, ss, 0);
  return t.getTime();
}

export function zonedToUtc(y, m, d, hh = 0, mi = 0, ss = 0, tz = 'UTC') {
  const local = wallMs(y, m, d, hh, mi, ss);
  if (!tz || tz === 'UTC' || tz === 'Etc/UTC') return local;
  const before = tzOffset(local - DAY, tz);
  const after = tzOffset(local + DAY, tz);
  const c1 = local - before;
  if (before === after) {
    // No transition nearby (common case), but double check the exact instant.
    const off = tzOffset(c1, tz);
    return off === before ? c1 : local - off;
  }
  const c2 = local - after;
  const v1 = tzOffset(c1, tz) === before;
  const v2 = tzOffset(c2, tz) === after;
  if (v1 && v2) return Math.min(c1, c2); // ambiguous: first occurrence
  if (v1) return c1;
  if (v2) return c2;
  return c1; // inside the gap: use the offset before the gap
}

export function utcToZoned(ms, tz = 'UTC') {
  const t = new Date(ms + tzOffset(ms, tz));
  return {
    y: t.getUTCFullYear(),
    m: t.getUTCMonth(),
    d: t.getUTCDate(),
    hh: t.getUTCHours(),
    mi: t.getUTCMinutes(),
    ss: t.getUTCSeconds(),
    wd: t.getUTCDay(),
  };
}

// Windows time zone names found in .ics files exported by Outlook / Exchange (most common ones).
const WINDOWS = {
  'Romance Standard Time': 'Europe/Paris',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Central European Standard Time': 'Europe/Warsaw',
  'GMT Standard Time': 'Europe/London',
  'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'GTB Standard Time': 'Europe/Bucharest',
  'FLE Standard Time': 'Europe/Kiev',
  'E. Europe Standard Time': 'Europe/Chisinau',
  'Russian Standard Time': 'Europe/Moscow',
  'Turkey Standard Time': 'Europe/Istanbul',
  'Israel Standard Time': 'Asia/Jerusalem',
  'Arabian Standard Time': 'Asia/Dubai',
  'India Standard Time': 'Asia/Kolkata',
  'China Standard Time': 'Asia/Shanghai',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'Korea Standard Time': 'Asia/Seoul',
  'Singapore Standard Time': 'Asia/Singapore',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'New Zealand Standard Time': 'Pacific/Auckland',
  'Eastern Standard Time': 'America/New_York',
  'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver',
  'US Mountain Standard Time': 'America/Phoenix',
  'Pacific Standard Time': 'America/Los_Angeles',
  'Alaskan Standard Time': 'America/Anchorage',
  'Hawaiian Standard Time': 'Pacific/Honolulu',
  'Atlantic Standard Time': 'America/Halifax',
  'Canada Central Standard Time': 'America/Regina',
  'Eastern Standard Time (Mexico)': 'America/Cancun',
  'Central Standard Time (Mexico)': 'America/Mexico_City',
  'E. South America Standard Time': 'America/Sao_Paulo',
  'Argentina Standard Time': 'America/Buenos_Aires',
  'South Africa Standard Time': 'Africa/Johannesburg',
  'Morocco Standard Time': 'Africa/Casablanca',
  'UTC': 'UTC',
  'Coordinated Universal Time': 'UTC',
};

// Best-effort mapping of an iCalendar TZID to an IANA zone. Returns null when unknown.
export function normalizeTzid(tzid) {
  if (!tzid) return null;
  let s = String(tzid).trim().replace(/^"|"$/g, '');
  if (isValidTz(s)) return s;
  if (WINDOWS[s]) return WINDOWS[s];
  const m = /([A-Za-z]+\/[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)?)$/.exec(s);
  if (m && isValidTz(m[1])) return m[1];
  s = s.replace(/^\(UTC[^)]*\)\s*/i, '');
  if (WINDOWS[s]) return WINDOWS[s];
  if (/^(GMT|UTC|Z)$/i.test(s)) return 'UTC';
  return null;
}

// Short "UTC+02:00" label for a zone at an instant.
export function offsetLabel(ms, tz) {
  const off = Math.round(tzOffset(ms, tz) / 60000);
  const sign = off < 0 ? '-' : '+';
  const a = Math.abs(off);
  return `UTC${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}
