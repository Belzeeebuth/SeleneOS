// Date calculation (Windows "Date calculation" mode): difference between two dates and
// adding/subtracting years, months and days. All dates are calendar dates handled in UTC.

export const MIN_YEAR = 1;
export const MAX_YEAR = 9999;

/** A calendar date as a UTC midnight Date. */
export function ymd(y, m, d) {
  // setUTCFullYear(y, m, d) resolves day/month overflow in the target year and supports years < 100
  const dt = new Date(Date.UTC(2000, 0, 1));
  dt.setUTCFullYear(y, m - 1, d);
  return dt;
}

export function fromLocal(date) {
  return ymd(date.getFullYear(), date.getMonth() + 1, date.getDate());
}

export function today() {
  return fromLocal(new Date());
}

export function daysInMonth(y, m) {
  return ymd(y, m + 1, 0).getUTCDate();
}

export function sameDay(a, b) {
  return a.getTime() === b.getTime();
}

/** Add months, clamping the day to the end of the target month (Jan 31 + 1 month = Feb 28/29). */
export function addMonths(date, months) {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + months;
  const ty = y + Math.floor(m / 12);
  const tm = ((m % 12) + 12) % 12;
  const day = Math.min(date.getUTCDate(), daysInMonth(ty, tm + 1));
  return ymd(ty, tm + 1, day);
}

export function addDays(date, days) {
  return new Date(date.getTime() + days * 86400000);
}

export function inRange(date) {
  const y = date.getUTCFullYear();
  return y >= MIN_YEAR && y <= MAX_YEAR;
}

/**
 * Windows-style difference: { years, months, weeks, days, totalDays }.
 * Dates are ordered automatically.
 */
export function diff(a, b) {
  if (a > b) [a, b] = [b, a];
  const totalDays = Math.round((b - a) / 86400000);
  let months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  if (addMonths(a, months) > b) months -= 1;
  // month-end clamping can still overshoot (e.g. Jan 31 -> Feb 28 counted as a full month)
  while (months > 0 && addMonths(a, months) > b) months -= 1;
  const mid = addMonths(a, months);
  let days = Math.round((b - mid) / 86400000);
  const years = Math.floor(months / 12);
  months %= 12;
  const weeks = Math.floor(days / 7);
  days %= 7;
  return { years, months, weeks, days, totalDays };
}

/** Add (sign = 1) or subtract (sign = -1) years, months and days. Returns null when out of range. */
export function shift(date, { years = 0, months = 0, days = 0 }, sign = 1) {
  let r = addMonths(date, sign * (years * 12 + months));
  r = addDays(r, sign * days);
  return inRange(r) ? r : null;
}
