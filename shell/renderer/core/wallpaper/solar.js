// Sun position maths for the dynamic (time of day) wallpaper — no network, no DOM (unit-testable in Node).
//
//   sunTimes(date, lat, lon) -> { sunrise, sunset, dawn, dusk, noon, polar }
//       Dates (absolute instants) of the solar day containing `date` (local calendar day of the machine):
//       sunrise / sunset (upper limb on the horizon, −0.833°), civil dawn / dusk (−6°), solar noon.
//       polar: null | 'day' (the sun never sets: sunrise/sunset null) | 'night' (never rises).
//   phaseAt(date, location | null) -> { phase: 'dawn'|'day'|'dusk'|'night', next: Date, sunrise, sunset, source: 'sun'|'fixed' }
//       Without a location the fixed day 07:00 → 19:00 is used (same default as the "Auto" theme times).
//   daylightAt(date, location | null) -> true between sunrise and sunset (the "theme follows the sun" switch)
//   PHASES, FIXED
//
// Phases around sunrise / sunset (shortened when days are short so they never overlap):
//   dawn  = [sunrise − 40 min, sunrise + 80 min)      day  = [sunrise + 80 min, sunset − 80 min)
//   dusk  = [sunset − 80 min,  sunset + 40 min)       night = the rest
// Algorithm: NOAA's solar calculator (declination + equation of time from the Julian century, refraction-corrected
// horizon at −0.833°), each event refined once at its own instant — within a minute of published tables.

const RAD = Math.PI / 180;
const DAY_MS = 86400000;

export const PHASES = ['dawn', 'day', 'dusk', 'night'];
/** Sunrise / sunset used when no location is set (local clock time). */
export const FIXED = { sunrise: '07:00', sunset: '19:00' };
const BEFORE = 40 * 60000; // dawn starts 40 min before sunrise; dusk ends 40 min after sunset
const AFTER = 80 * 60000; // the day phase starts 80 min after sunrise; dusk starts 80 min before sunset

const validCoord = (lat, lon) => Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

/** Declination (rad) and equation of time (minutes) at an instant — NOAA solar calculator formulas. */
function sunAt(ms) {
  const jc = (ms / DAY_MS + 2440587.5 - 2451545) / 36525; // Julian centuries since J2000
  const L0 = (((280.46646 + jc * (36000.76983 + jc * 0.0003032)) % 360) + 360) % 360; // geometric mean longitude
  const M = 357.52911 + jc * (35999.05029 - 0.0001537 * jc); // mean anomaly
  const e = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc); // orbit eccentricity
  const C = Math.sin(RAD * M) * (1.914602 - jc * (0.004817 + 0.000014 * jc)) + Math.sin(RAD * 2 * M) * (0.019993 - 0.000101 * jc) + Math.sin(RAD * 3 * M) * 0.000289;
  const omega = 125.04 - 1934.136 * jc;
  const lambda = L0 + C - 0.00569 - 0.00478 * Math.sin(RAD * omega); // apparent longitude
  const eps0 = 23 + (26 + (21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(RAD * omega); // corrected obliquity
  const dec = Math.asin(Math.sin(RAD * eps) * Math.sin(RAD * lambda));
  const y = Math.tan((RAD * eps) / 2) ** 2;
  const l0 = RAD * L0;
  const m = RAD * M;
  const eot = (4 / RAD) * (y * Math.sin(2 * l0) - 2 * e * Math.sin(m) + 4 * e * y * Math.sin(m) * Math.cos(2 * l0) - 0.5 * y * y * Math.sin(4 * l0) - 1.25 * e * e * Math.sin(2 * m));
  return { dec, eot };
}

/** Hour angle (degrees) at which the sun's centre is at `alt` degrees; NaN-free: { ha } or { never: 'rise'|'set' }. */
function hourAngle(alt, phi, dec) {
  const x = (Math.cos(RAD * (90 - alt)) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec));
  if (x > 1) return { never: 'rise' };
  if (x < -1) return { never: 'set' };
  return { ha: Math.acos(x) / RAD };
}

/** Sunrise, sunset, civil dawn / dusk and solar noon of the local calendar day of `date`. */
export function sunTimes(date, lat, lon) {
  lat = Number(lat);
  lon = Number(lon);
  if (!validCoord(lat, lon)) return null;
  const base = new Date(date);
  const noonLocal = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 12, 0, 0, 0).getTime();
  // UTC date of the local mean solar day at that longitude (its transit is the one nearest to local noon)
  const day0 = Math.floor((noonLocal + (lon / 360) * DAY_MS) / DAY_MS) * DAY_MS;
  const phi = RAD * Math.max(-89.99, Math.min(89.99, lat));
  const transit = (ms) => day0 + (720 - 4 * lon - sunAt(ms).eot) * 60000;
  const noon = transit(transit(day0 + 12 * 3600000));
  // an event (sign −1 = morning, +1 = evening) at altitude `alt`, refined once at the event's own instant
  const event = (alt, sign) => {
    let t = noon;
    for (let i = 0; i < 2; i++) {
      const { dec } = sunAt(t);
      const h = hourAngle(alt, phi, dec);
      if (h.never) return h;
      t = transit(t) + sign * h.ha * 4 * 60000;
    }
    return { t: new Date(Math.round(t)) };
  };
  const rise = event(-0.833, -1);
  const set = event(-0.833, 1);
  const dawn = event(-6, -1);
  const dusk = event(-6, 1);
  const never = rise.never || set.never;
  return {
    noon: new Date(Math.round(noon)),
    sunrise: rise.t || null,
    sunset: set.t || null,
    dawn: dawn.t || null,
    dusk: dusk.t || null,
    polar: never === 'rise' ? 'night' : never === 'set' ? 'day' : null,
  };
}

function clockOn(date, hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  const d = new Date(date);
  d.setHours(m ? Number(m[1]) % 24 : 0, m ? Number(m[2]) % 60 : 0, 0, 0);
  return d;
}

/** Sunrise / sunset of the local calendar day of `date` (sun maths with a location, the fixed hours without). */
function dayOf(date, loc) {
  const lat = Number(loc?.lat);
  const lon = Number(loc?.lon);
  if (loc && validCoord(lat, lon)) {
    const st = sunTimes(date, lat, lon);
    return { sunrise: st.sunrise, sunset: st.sunset, polar: st.polar, source: 'sun' };
  }
  return { sunrise: clockOn(date, FIXED.sunrise), sunset: clockOn(date, FIXED.sunset), polar: null, source: 'fixed' };
}

/** The four phase windows of one calendar day: [{ phase, from, to }] (ms), in order, gaps are night. */
function windows(day) {
  if (day.polar || !day.sunrise || !day.sunset) return [];
  const rise = day.sunrise.getTime();
  const set = day.sunset.getTime();
  let dawnEnd = rise + AFTER;
  let duskStart = set - AFTER;
  if (dawnEnd > duskStart) dawnEnd = duskStart = Math.round((rise + set) / 2); // short winter days: no "day"
  return [
    { phase: 'dawn', from: rise - BEFORE, to: dawnEnd },
    { phase: 'day', from: dawnEnd, to: duskStart },
    { phase: 'dusk', from: duskStart, to: set + BEFORE },
  ].filter((w) => w.to > w.from);
}

/** Time-of-day phase at `date` for a location ({ lat, lon } or null → fixed 07:00–19:00), and when it changes next. */
export function phaseAt(date = new Date(), loc = null) {
  const now = new Date(date).getTime();
  const today = dayOf(now, loc);
  if (today.polar) {
    // polar day / night: check again at the next local midnight
    const next = new Date(now);
    next.setHours(24, 0, 0, 0);
    return { phase: today.polar === 'day' ? 'day' : 'night', next, sunrise: null, sunset: null, polar: today.polar, source: today.source };
  }
  const list = windows(today);
  let phase = 'night';
  for (const w of list) if (now >= w.from && now < w.to) phase = w.phase;
  // next boundary: today's remaining ones, else tomorrow's first
  const bounds = list.flatMap((w) => [w.from, w.to]).filter((t) => t > now);
  let next = bounds.length ? Math.min(...bounds) : null;
  if (next == null) {
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(12, 0, 0, 0);
    const tw = windows(dayOf(tomorrow, loc));
    next = tw.length ? tw[0].from : new Date(tomorrow).setHours(24, 0, 0, 0);
  }
  return { phase, next: new Date(next), sunrise: today.sunrise, sunset: today.sunset, polar: null, source: today.source };
}

/** True between sunrise and sunset (or all day long in a polar day). */
export function daylightAt(date = new Date(), loc = null) {
  const now = new Date(date).getTime();
  const d = dayOf(now, loc);
  if (d.polar) return d.polar === 'day';
  return now >= d.sunrise.getTime() && now < d.sunset.getTime();
}
