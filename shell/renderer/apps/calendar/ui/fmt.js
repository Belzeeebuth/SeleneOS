// Locale-aware formatting for the calendar (dates, times, ranges, recurrence descriptions).
// 12/24-hour follows the shell setting 'clock24h' (null = language default: EN 12 h, FR 24 h).
import { sameDay, addDays, parseDateKey, weekdayPosition, daysInMonth } from '../lib/dates.mjs';
import { parseByday } from '../lib/rrule.mjs';

const cache = new Map();

export function createFmt(ctx) {
  const locale = () => ctx.i18n.locale;
  const hour12 = () => {
    const v = ctx.settings.get('clock24h');
    return v == null ? ctx.lang !== 'fr' && !/^fr/.test(locale()) : !v;
  };
  const df = (opts) => {
    const k = `${locale()}|${hour12()}|${JSON.stringify(opts)}`;
    let f = cache.get(k);
    if (!f) {
      const o = { ...opts };
      if ('hour' in o) o.hour12 = hour12();
      f = new Intl.DateTimeFormat(locale(), o);
      cache.set(k, f);
    }
    return f;
  };
  const t = ctx.t;
  const fmt = {
    hour12,
    // "9:00 AM" / "09:00" (24-hour clocks pad the hour, like Windows)
    time: (ms) => df({ hour: hour12() ? 'numeric' : '2-digit', minute: '2-digit' }).format(ms),
    // gutter labels: "9 AM" / "09:00"
    hourLabel(h) {
      const d = new Date(2026, 0, 5, h, 0);
      return hour12() ? df({ hour: 'numeric' }).format(d) : df({ hour: '2-digit', minute: '2-digit' }).format(d);
    },
    // compact time in month chips: "9 AM" / "9:30 AM" / "09:00"
    chipTime(ms) {
      const d = new Date(ms);
      if (hour12() && d.getMinutes() === 0) return df({ hour: 'numeric' }).format(d);
      return fmt.time(ms);
    },
    monthYear: (d) => df({ month: 'long', year: 'numeric' }).format(d),
    month: (d) => df({ month: 'long' }).format(d),
    monthShortYear: (d) => df({ month: 'short', year: 'numeric' }).format(d),
    monthShort: (d) => df({ month: 'short' }).format(d),
    dayLong: (d) => df({ weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(d),
    dayLongNoYear: (d) => df({ weekday: 'long', month: 'long', day: 'numeric' }).format(d),
    dayMed: (d) => df({ weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).format(d),
    dayMedNoYear: (d) => df({ weekday: 'short', month: 'short', day: 'numeric' }).format(d),
    monthDay: (d) => df({ month: 'long', day: 'numeric' }).format(d),
    monthDayYear: (d) => df({ month: 'long', day: 'numeric', year: 'numeric' }).format(d),
    monthDayShort: (d) => df({ month: 'short', day: 'numeric' }).format(d),
    weekdayLong: (d) => df({ weekday: 'long' }).format(d),
    weekdayShort: (d) => df({ weekday: 'short' }).format(d).replace(/\.$/, ''),
    weekdayNarrow: (d) => df({ weekday: 'narrow' }).format(d),
    number: (n) => new Intl.NumberFormat(locale()).format(n),

    // "Oct 5 – 11, 2026" style title for a week; "Sep 28 – Oct 4, 2026" across months.
    rangeTitle(a, b) {
      if (a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth()) return fmt.monthYear(a);
      if (a.getFullYear() === b.getFullYear()) return `${df({ month: 'short' }).format(a)} – ${df({ month: 'short', year: 'numeric' }).format(b)}`;
      return `${fmt.monthShortYear(a)} – ${fmt.monthShortYear(b)}`;
    },

    // What an occurrence's time looks like in lists and peeks.
    occRange(o) {
      if (o.allDay) {
        const last = addDays(new Date(o.end), -1);
        if (sameDay(o.start, last)) return t('allDay');
        return `${fmt.dayMedNoYear(o.start)} – ${fmt.dayMedNoYear(last)}`;
      }
      if (sameDay(o.start, o.end) || o.end - o.start <= 0 || (new Date(o.end).getHours() === 0 && new Date(o.end).getMinutes() === 0 && o.end - o.start <= 86400000)) {
        return o.end > o.start ? `${fmt.time(o.start)} – ${fmt.time(o.end)}` : fmt.time(o.start);
      }
      return `${fmt.dayMedNoYear(o.start)} ${fmt.time(o.start)} – ${fmt.dayMedNoYear(o.end)} ${fmt.time(o.end)}`;
    },
    // Full sentence for the peek card: "Saturday, October 10, 2026 · 9:00 AM – 10:00 AM"
    occWhen(o) {
      if (o.allDay) {
        const last = addDays(new Date(o.end), -1);
        if (sameDay(o.start, last)) return `${fmt.dayLong(new Date(o.start))} · ${t('allDay')}`;
        return `${fmt.dayMed(new Date(o.start))} – ${fmt.dayMed(last)}`;
      }
      if (sameDay(o.start, o.end) || o.end <= o.start) return `${fmt.dayLong(new Date(o.start))} · ${fmt.occRange(o)}`;
      return `${fmt.dayMed(new Date(o.start))} ${fmt.time(o.start)} – ${fmt.dayMed(new Date(o.end))} ${fmt.time(o.end)}`;
    },
    duration(min) {
      if (min < 60) return t('durMin', { n: min });
      if (min % 60 === 0) return t('durHour', { count: min / 60 });
      return t('durHourMin', { h: Math.floor(min / 60), m: min % 60 });
    },
    reminder(min, allDay) {
      if (min == null) return t('rem.none');
      if (allDay) {
        if (min === -540) return t('rem.dayOf');
        if (min === 900) return t('rem.dayBefore9');
        if (min === 9540) return t('rem.weekBefore9');
      }
      if (min === 0) return t('rem.atTime');
      if (min < 0) return t('rem.afterMin', { n: -min });
      if (min % 1440 === 0) return t('rem.days', { count: min / 1440 });
      if (min % 60 === 0) return t('rem.hours', { count: min / 60 });
      return t('rem.minutes', { count: min });
    },
    ordinal(n) {
      return t(`nth.${n === -1 ? 'last' : n}`);
    },
    // Human description of a recurrence rule. `start` = Date of the series start (local).
    recurrence(rule, start) {
      if (!rule) return t('rep.none');
      const n = rule.interval || 1;
      const wdName = (wd) => fmt.weekdayLong(new Date(2026, 0, 4 + wd));
      let base;
      const custom = () => t('rep.customRule');
      switch (rule.freq) {
        case 'DAILY':
          if (rule.byday?.length || rule.bymonthday?.length || rule.bymonth?.length) return custom();
          base = n === 1 ? t('rep.daily') : t('rep.everyNDays', { n });
          break;
        case 'WEEKLY': {
          if (rule.bymonthday?.length || rule.bysetpos?.length) return custom();
          const days = (rule.byday?.length ? rule.byday.map(parseByday) : [{ n: 0, wd: start.getDay() }]).filter(Boolean);
          if (days.some((d) => d.n)) return custom();
          const wds = [...new Set(days.map((d) => d.wd))].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
          if (n === 1 && wds.join() === '1,2,3,4,5') base = t('rep.weekdays');
          else {
            const list = new Intl.ListFormat(ctx.i18n.locale, { style: 'long', type: 'conjunction' }).format(wds.map(wdName));
            base = n === 1 ? t('rep.weeklyOn', { days: list }) : t('rep.everyNWeeksOn', { n, days: list });
          }
          break;
        }
        case 'MONTHLY': {
          let what;
          if (rule.bymonthday?.length === 1 && !rule.byday) {
            const d = rule.bymonthday[0];
            what = d === -1 ? t('rep.onLastDay') : d > 0 ? t('rep.onDay', { d }) : null;
          } else if (rule.byday?.length === 1 && !rule.bymonthday && !rule.bysetpos) {
            const b = parseByday(rule.byday[0]);
            if (b && b.n && (b.n === -1 || (b.n >= 1 && b.n <= 4))) what = t('rep.onNth', { nth: fmt.ordinal(b.n), day: wdName(b.wd) });
          } else if (!rule.byday && !rule.bymonthday) what = t('rep.onDay', { d: start.getDate() });
          if (!what || rule.bymonth?.length) return custom();
          base = n === 1 ? t('rep.monthly', { what }) : t('rep.everyNMonths', { n, what });
          break;
        }
        case 'YEARLY': {
          if (rule.bysetpos?.length || (rule.bymonth?.length || 0) > 1) return custom();
          const month = rule.bymonth?.[0] ? rule.bymonth[0] - 1 : start.getMonth();
          let what;
          if (rule.byday?.length === 1 && !rule.bymonthday) {
            const b = parseByday(rule.byday[0]);
            if (!b?.n || !rule.bymonth) return custom();
            what = t('rep.onNthOfMonth', { nth: fmt.ordinal(b.n), day: wdName(b.wd), month: fmt.month(new Date(2026, month, 1)) });
          } else if (!rule.byday) {
            const d = rule.bymonthday?.length === 1 ? rule.bymonthday[0] : start.getDate();
            if (d < 1) return custom();
            what = t('rep.onDate', { date: fmt.monthDay(new Date(2024, month, d)) });
          } else return custom();
          base = n === 1 ? t('rep.yearly', { what }) : t('rep.everyNYears', { n, what });
          break;
        }
        default:
          return custom();
      }
      if (rule.count) base += t('rep.countSuffix', { count: rule.count });
      else if (rule.until != null) {
        const u = typeof rule.until === 'string' ? (() => { const p = parseDateKey(rule.until); return new Date(p.y, p.m, p.d); })() : new Date(rule.until);
        base += t('rep.untilSuffix', { date: fmt.dayMed(u) });
      }
      return base;
    },
  };
  return fmt;
}

// Preset recurrence choices offered for a start date (Outlook "Repeat" dropdown).
export function recurrencePresets(start) {
  const wd = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][start.getDay()];
  const pos = weekdayPosition(start.getFullYear(), start.getMonth(), start.getDate());
  const out = [
    { id: 'none', rule: null },
    { id: 'daily', rule: { freq: 'DAILY', interval: 1 } },
    { id: 'weekdays', rule: { freq: 'WEEKLY', interval: 1, byday: ['MO', 'TU', 'WE', 'TH', 'FR'] } },
    { id: 'weekly', rule: { freq: 'WEEKLY', interval: 1, byday: [wd] } },
    { id: 'monthlyDay', rule: { freq: 'MONTHLY', interval: 1, bymonthday: [start.getDate()] } },
  ];
  if (pos.n <= 4) out.push({ id: 'monthlyNth', rule: { freq: 'MONTHLY', interval: 1, byday: [`${pos.n}${wd}`] } });
  if (pos.last) out.push({ id: 'monthlyLast', rule: { freq: 'MONTHLY', interval: 1, byday: [`-1${wd}`] } });
  if (start.getDate() === daysInMonth(start.getFullYear(), start.getMonth())) out.push({ id: 'monthlyLastDay', rule: { freq: 'MONTHLY', interval: 1, bymonthday: [-1] } });
  out.push({ id: 'yearly', rule: { freq: 'YEARLY', interval: 1 } });
  return out;
}

// Which preset (if any) a rule is, ignoring its end (count / until).
export function presetOf(rule, start) {
  if (!rule) return 'none';
  const strip = (r) => JSON.stringify({ f: r.freq, i: r.interval || 1, d: r.byday || null, m: r.bymonthday || null, mo: r.bymonth || null, s: r.bysetpos || null });
  const s = strip(rule);
  for (const p of recurrencePresets(start)) if (p.rule && strip(p.rule) === s) return p.id;
  // yearly rules written with explicit BYMONTH/BYMONTHDAY equal to the start date are the yearly preset
  if (rule.freq === 'YEARLY' && (rule.interval || 1) === 1 && !rule.byday && (!rule.bymonth || (rule.bymonth.length === 1 && rule.bymonth[0] === start.getMonth() + 1)) && (!rule.bymonthday || (rule.bymonthday.length === 1 && rule.bymonthday[0] === start.getDate()))) return 'yearly';
  return 'custom';
}
