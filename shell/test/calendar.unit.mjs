// Calendar unit tests (pure modules, run in Node): time zones, recurrence engine (DST in Europe/Paris and
// America/New_York, monthly on the 31st, last Friday, leap years, exceptions), holidays, iCalendar parser
// and serializer (roundtrip), layout. Imported by calendar.test.mjs; also runnable alone:
//   node test/calendar.unit.mjs
import { zonedToUtc, utcToZoned, tzOffset, normalizeTzid } from '../renderer/apps/calendar/lib/tz.mjs';
import { dayNum, keyFromDayNum, weekNumber, nthWeekday, dayNumFromKey } from '../renderer/apps/calendar/lib/dates.mjs';
import { parseRRule, formatRRule, ruleDays } from '../renderer/apps/calendar/lib/rrule.mjs';
import { holidays, easter } from '../renderer/apps/calendar/lib/holidays.mjs';
import {
  sanitizeEvent,
  expandEvent,
  updateOccurrence,
  deleteOccurrence,
  truncateSeries,
  updateSeries,
  planReminders,
  occurrenceAt,
  moveOccurrence,
} from '../renderer/apps/calendar/lib/events.mjs';
import { parseIcs, serializeIcs, unfold, escapeText, unescapeText, foldLine, parseDuration } from '../renderer/apps/calendar/lib/ics.mjs';
import { layoutColumns, packLanes } from '../renderer/apps/calendar/lib/layout.mjs';
import { dueReminder } from '../renderer/apps/calendar/lib/store.mjs';
import { fileURLToPath } from 'node:url';

const iso = (ms) => new Date(ms).toISOString().replace('.000', '');
const Y = 365 * 86400000;

export function runUnitTests(check) {
  let section = '';
  const c = (name, actual, expected) => check(`[unit:${section}] ${name}`, actual, expected);

  // ---------------------------------------------------------------- tz
  section = 'tz';
  c('Paris winter offset', tzOffset(Date.UTC(2026, 0, 15), 'Europe/Paris'), 3600000);
  c('Paris summer offset', tzOffset(Date.UTC(2026, 6, 15), 'Europe/Paris'), 7200000);
  c('NY winter offset', tzOffset(Date.UTC(2026, 0, 15), 'America/New_York'), -5 * 3600000);
  c('Paris 09:00 winter', iso(zonedToUtc(2026, 2, 16, 9, 0, 0, 'Europe/Paris')), '2026-03-16T08:00:00Z');
  c('Paris gap 02:30 -> 03:30 CEST', iso(zonedToUtc(2026, 2, 29, 2, 30, 0, 'Europe/Paris')), '2026-03-29T01:30:00Z');
  c('Paris ambiguous 02:30 -> first (CEST)', iso(zonedToUtc(2026, 9, 25, 2, 30, 0, 'Europe/Paris')), '2026-10-25T00:30:00Z');
  c('NY gap 02:30 -> 03:30 EDT', iso(zonedToUtc(2026, 2, 8, 2, 30, 0, 'America/New_York')), '2026-03-08T07:30:00Z');
  c('NY ambiguous 01:30 -> EDT', iso(zonedToUtc(2026, 10, 1, 1, 30, 0, 'America/New_York')), '2026-11-01T05:30:00Z');
  c('utcToZoned Paris', utcToZoned(Date.UTC(2026, 9, 25, 1, 30), 'Europe/Paris'), { y: 2026, m: 9, d: 25, hh: 2, mi: 30, ss: 0, wd: 0 });
  c('normalize Windows tz', normalizeTzid('Romance Standard Time'), 'Europe/Paris');
  c('normalize mozilla tz', normalizeTzid('/mozilla.org/20050126_1/America/New_York'), 'America/New_York');
  c('normalize unknown tz', normalizeTzid('Mars/Olympus'), null);

  // ---------------------------------------------------------------- dates
  section = 'dates';
  c('ISO week 2026-10-10', weekNumber(new Date(2026, 9, 10), 1), 41);
  c('ISO week 2027-01-01 (week 53 of 2026)', weekNumber(new Date(2027, 0, 1), 1), 53);
  c('US week 2026-10-10', weekNumber(new Date(2026, 9, 10), 0), 41);
  c('US week 2026-12-31 -> week 1', weekNumber(new Date(2026, 11, 31), 0), 1);
  c('last Friday Oct 2026', nthWeekday(2026, 9, 5, -1), 30);
  c('4th Thursday Nov 2026', nthWeekday(2026, 10, 4, 4), 26);

  // ---------------------------------------------------------------- rrule
  section = 'rrule';
  const take = (rule, startKey, n) => {
    const out = [];
    for (const d of ruleDays(rule, dayNumFromKey(startKey))) {
      out.push(keyFromDayNum(d));
      if (out.length >= n) break;
    }
    return out;
  };
  const r1 = parseRRule('FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;COUNT=5');
  c('parse weekly', [r1.freq, r1.interval, r1.byday, r1.count], ['WEEKLY', 2, ['TU', 'TH'], 5]);
  c('format roundtrip', formatRRule(r1), 'FREQ=WEEKLY;INTERVAL=2;COUNT=5;BYDAY=TU,TH');
  c('parse UNTIL utc', parseRRule('FREQ=DAILY;UNTIL=20261005T070000Z', { tz: 'Europe/Paris' }).until, Date.UTC(2026, 9, 5, 7));
  c('parse UNTIL date (all-day)', parseRRule('FREQ=DAILY;UNTIL=20261005', { allDay: true }).until, '2026-10-05');
  c('parse bad freq', parseRRule('FREQ=HOURLY'), null);
  c('monthly on the 31st skips short months', take({ freq: 'MONTHLY', interval: 1 }, '2026-01-31', 7), ['2026-01-31', '2026-03-31', '2026-05-31', '2026-07-31', '2026-08-31', '2026-10-31', '2026-12-31']);
  c('last Friday of the month', take(parseRRule('FREQ=MONTHLY;BYDAY=-1FR'), '2026-01-30', 12), [
    '2026-01-30', '2026-02-27', '2026-03-27', '2026-04-24', '2026-05-29', '2026-06-26', '2026-07-31', '2026-08-28', '2026-09-25', '2026-10-30', '2026-11-27', '2026-12-25',
  ]);
  c('last day of month (BYMONTHDAY=-1) incl. leap Feb', take(parseRRule('FREQ=MONTHLY;BYMONTHDAY=-1'), '2027-12-31', 3), ['2027-12-31', '2028-01-31', '2028-02-29']);
  c('yearly Feb 29 only in leap years', take({ freq: 'YEARLY', interval: 1 }, '2024-02-29', 3), ['2024-02-29', '2028-02-29', '2032-02-29']);
  c('2nd Tuesday monthly', take(parseRRule('FREQ=MONTHLY;BYDAY=2TU'), '2026-10-13', 3), ['2026-10-13', '2026-11-10', '2026-12-08']);
  c('Thanksgiving rule', take(parseRRule('FREQ=YEARLY;BYMONTH=11;BYDAY=4TH'), '2026-11-26', 2), ['2026-11-26', '2027-11-25']);
  c('weekdays', take(parseRRule('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'), '2026-10-09', 3), ['2026-10-09', '2026-10-12', '2026-10-13']);
  c('last weekday of month (BYSETPOS)', take(parseRRule('FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1'), '2026-10-30', 3), ['2026-10-30', '2026-11-30', '2026-12-31']);
  c('every 2 weeks TU,TH', take(r1, '2026-10-06', 5), ['2026-10-06', '2026-10-08', '2026-10-20', '2026-10-22', '2026-11-03']);
  c('yearly 20th Monday', take(parseRRule('FREQ=YEARLY;BYDAY=20MO'), '2026-05-18', 2), ['2026-05-18', '2027-05-17']);
  c('impossible rule terminates', take(parseRRule('FREQ=MONTHLY;BYMONTH=2;BYMONTHDAY=30'), '2026-01-01', 3), []);

  // ---------------------------------------------------------------- recurrence expansion with time zones
  section = 'expand';
  const paris = (y, m, d, hh, mi = 0) => zonedToUtc(y, m, d, hh, mi, 0, 'Europe/Paris');
  const weekly = sanitizeEvent({ id: 'w', title: 'Standup', start: paris(2026, 2, 16, 9), end: paris(2026, 2, 16, 9, 30), tz: 'Europe/Paris', rrule: { freq: 'WEEKLY', interval: 1, byday: ['MO'] } });
  c('Paris weekly keeps 09:00 across spring DST', expandEvent(weekly, Date.UTC(2026, 2, 15), Date.UTC(2026, 3, 1)).map((o) => iso(o.start)), ['2026-03-16T08:00:00Z', '2026-03-23T08:00:00Z', '2026-03-30T07:00:00Z']);
  c('Paris weekly keeps 09:00 across autumn DST', expandEvent(weekly, Date.UTC(2026, 9, 18), Date.UTC(2026, 10, 3)).map((o) => iso(o.start)), ['2026-10-19T07:00:00Z', '2026-10-26T08:00:00Z', '2026-11-02T08:00:00Z']);
  c('duration preserved', expandEvent(weekly, Date.UTC(2026, 2, 29), Date.UTC(2026, 3, 1)).map((o) => o.end - o.start), [30 * 60000]);
  const ny = sanitizeEvent({ id: 'n', title: 'NY', start: zonedToUtc(2026, 2, 6, 9, 0, 0, 'America/New_York'), end: zonedToUtc(2026, 2, 6, 10, 0, 0, 'America/New_York'), tz: 'America/New_York', rrule: { freq: 'DAILY', interval: 1, count: 4 } });
  c('New York daily across DST (COUNT=4)', expandEvent(ny, 0, Date.UTC(2030, 0, 1)).map((o) => iso(o.start)), ['2026-03-06T14:00:00Z', '2026-03-07T14:00:00Z', '2026-03-08T13:00:00Z', '2026-03-09T13:00:00Z']);
  const nyFall = sanitizeEvent({ id: 'nf', start: zonedToUtc(2026, 9, 30, 9, 0, 0, 'America/New_York'), end: zonedToUtc(2026, 9, 30, 9, 0, 0, 'America/New_York') + 3600000, tz: 'America/New_York', rrule: { freq: 'DAILY', count: 4 } });
  c('New York daily across fall DST', expandEvent(nyFall, 0, Date.UTC(2030, 0, 1)).map((o) => iso(o.start)), ['2026-10-30T13:00:00Z', '2026-10-31T13:00:00Z', '2026-11-01T14:00:00Z', '2026-11-02T14:00:00Z']);
  const gap = sanitizeEvent({ id: 'g', start: paris(2026, 2, 27, 2, 30), end: paris(2026, 2, 27, 3, 0), tz: 'Europe/Paris', rrule: { freq: 'DAILY', count: 4 } });
  c('daily 02:30 Paris through the spring gap', expandEvent(gap, 0, Date.UTC(2030, 0, 1)).map((o) => iso(o.start)), ['2026-03-27T01:30:00Z', '2026-03-28T01:30:00Z', '2026-03-29T01:30:00Z', '2026-03-30T00:30:00Z']);
  const until = sanitizeEvent({ id: 'u', start: paris(2026, 9, 1, 9), end: paris(2026, 9, 1, 10), tz: 'Europe/Paris', rrule: { freq: 'DAILY', until: Date.UTC(2026, 9, 5, 7) } });
  c('UNTIL is inclusive', expandEvent(until, 0, Date.UTC(2030, 0, 1)).length, 5);
  const m31 = sanitizeEvent({ id: 'm', start: paris(2026, 0, 31, 18), end: paris(2026, 0, 31, 19), tz: 'Europe/Paris', rrule: { freq: 'MONTHLY', count: 4 } });
  c('monthly 31st with COUNT', expandEvent(m31, 0, Date.UTC(2030, 0, 1)).map((o) => iso(o.start).slice(0, 10)), ['2026-01-31', '2026-03-31', '2026-05-31', '2026-07-31']);
  const allday = sanitizeEvent({ id: 'a', allDay: true, start: '2026-10-12', end: '2026-10-14', rrule: { freq: 'WEEKLY', count: 3 } });
  c('all-day weekly 2-day event', expandEvent(allday, 0, 8e15).map((o) => [o.startKey, o.endKey]), [['2026-10-12', '2026-10-14'], ['2026-10-19', '2026-10-21'], ['2026-10-26', '2026-10-28']]);
  c('all-day overlaps range by its second day', expandEvent(allday, new Date(2026, 9, 13).getTime(), new Date(2026, 9, 14).getTime()).length, 1);
  // Jump-ahead: a daily series started 10 years ago still expands fast and correctly.
  const old = sanitizeEvent({ id: 'o', start: paris(2016, 0, 4, 8), end: paris(2016, 0, 4, 8, 15), tz: 'Europe/Paris', rrule: { freq: 'DAILY' } });
  const t0 = Date.now();
  const oldOcc = expandEvent(old, Date.UTC(2026, 9, 12), Date.UTC(2026, 9, 14));
  c('old daily series jumps ahead', [oldOcc.map((o) => iso(o.start)), Date.now() - t0 < 200], [['2026-10-12T06:00:00Z', '2026-10-13T06:00:00Z'], true]);

  // ---------------------------------------------------------------- exceptions
  section = 'exceptions';
  const occs = expandEvent(weekly, Date.UTC(2026, 9, 1), Date.UTC(2026, 10, 1));
  const k2 = occs[1].key; // Oct 12
  let ev = deleteOccurrence(weekly, k2);
  c('deleted occurrence gone', expandEvent(ev, Date.UTC(2026, 9, 1), Date.UTC(2026, 10, 1)).map((o) => iso(o.start).slice(0, 10)), ['2026-10-05', '2026-10-19', '2026-10-26']);
  c('occurrenceAt(deleted) is null', occurrenceAt(ev, k2), null);
  const k3 = occs[2].key; // Oct 19
  ev = moveOccurrence(ev, k3, paris(2026, 9, 20, 14), paris(2026, 9, 20, 15));
  ev = updateOccurrence(ev, k3, { title: 'Moved standup', location: 'Room 2' });
  const after = expandEvent(ev, Date.UTC(2026, 9, 1), Date.UTC(2026, 10, 1));
  c('moved occurrence', after.map((o) => [iso(o.start), o.title, o.exception]), [
    ['2026-10-05T07:00:00Z', 'Standup', false],
    ['2026-10-20T12:00:00Z', 'Moved standup', true],
    ['2026-10-26T08:00:00Z', 'Standup', false],
  ]);
  c('override stores only differences', Object.keys(ev.overrides[k3]).sort(), ['end', 'location', 'start', 'title']);
  c('moved occurrence found from far range', expandEvent(ev, Date.UTC(2026, 9, 20), Date.UTC(2026, 9, 21)).map((o) => o.key), [k3]);
  const renamed = updateSeries(ev, { title: 'Daily sync' });
  c('series rename keeps exceptions', expandEvent(renamed, Date.UTC(2026, 9, 1), Date.UTC(2026, 10, 1)).map((o) => o.title), ['Daily sync', 'Moved standup', 'Daily sync']);
  const retimed = updateSeries(ev, { start: paris(2026, 2, 16, 10), end: paris(2026, 2, 16, 10, 30) });
  c('series retime drops exceptions', [retimed.exdates.length, Object.keys(retimed.overrides).length], [0, 0]);
  const truncated = truncateSeries(weekly, occs[2].key);
  c('this and following', expandEvent(truncated, Date.UTC(2026, 9, 1), Date.UTC(2027, 0, 1)).map((o) => iso(o.start).slice(0, 10)), ['2026-10-05', '2026-10-12']);
  c('truncate at first occurrence deletes', truncateSeries(weekly, String(weekly.start)), null);
  const single = sanitizeEvent({ id: 's', start: paris(2026, 9, 12, 9), end: paris(2026, 9, 12, 10) });
  c('single event: delete occurrence -> null', deleteOccurrence(single, String(single.start)), null);
  const one = sanitizeEvent({ id: 'one', start: paris(2026, 9, 12, 9), end: paris(2026, 9, 12, 10), tz: 'Europe/Paris', rrule: { freq: 'DAILY', count: 1 } });
  c('deleting the only occurrence deletes the series', deleteOccurrence(one, String(one.start)), null);

  // ---------------------------------------------------------------- reminders
  section = 'reminders';
  const now = Date.UTC(2026, 9, 10, 12);
  const remEv = sanitizeEvent({ ...weekly, id: 'r', reminder: 15 });
  const plan = planReminders([remEv], now);
  c('next 3 occurrences planned', plan.map((p) => [p.id, iso(p.at)]), [
    [`evt-r-${Date.UTC(2026, 9, 12, 7)}`, '2026-10-12T06:45:00Z'],
    [`evt-r-${Date.UTC(2026, 9, 19, 7)}`, '2026-10-19T06:45:00Z'],
    [`evt-r-${Date.UTC(2026, 9, 26, 8)}`, '2026-10-26T07:45:00Z'],
  ]);
  const noRem = planReminders([sanitizeEvent({ ...weekly, id: 'x', reminder: null })], now);
  c('no reminder -> nothing planned', noRem.length, 0);
  const past = planReminders([sanitizeEvent({ id: 'p', start: now - 3600000, end: now, reminder: 0 })], now);
  c('past event -> nothing planned', past.length, 0);
  const dayRem = planReminders([sanitizeEvent({ id: 'd', allDay: true, start: '2026-10-14', end: '2026-10-15', reminder: -540 })], now);
  c('all-day reminder at 09:00 local', dayRem.map((p) => p.at), [new Date(2026, 9, 14, 9).getTime()]);
  const exRem = planReminders([updateOccurrence(remEv, String(Date.UTC(2026, 9, 12, 7)), { reminder: null })], now);
  c('override can drop one reminder', exRem.length, 3);
  c('override drop skips that occurrence', exRem[0].id, `evt-r-${Date.UTC(2026, 9, 19, 7)}`);
  // reminders whose time has passed although the event has not started (shown at once by the app)
  const soon = sanitizeEvent({ id: 's1', start: now + 10 * 60000, end: now + 40 * 60000, reminder: 15 });
  c('due: starts in 10 min, 15-min reminder', dueReminder(soon, now)?.key, String(now + 10 * 60000));
  c('due: planReminders skips it (time passed)', planReminders([soon], now).length, 0);
  c('due: 2 hours away -> not due yet', dueReminder(sanitizeEvent({ id: 's2', start: now + 2 * 3600000, end: now + 3 * 3600000, reminder: 15 }), now), null);
  c('due: already started -> no', dueReminder(sanitizeEvent({ id: 's3', start: now - 60000, end: now + 3600000, reminder: 15 }), now), null);
  c('due: reminder after the start -> no', dueReminder(sanitizeEvent({ id: 's4', start: now + 60000, end: now + 3600000, reminder: -15 }), now), null);
  c('due: no reminder -> no', dueReminder(sanitizeEvent({ id: 's5', start: now + 60000, end: now + 3600000, reminder: null }), now), null);
  const dueSeries = sanitizeEvent({ id: 's6', start: now - 7 * 86400000 + 5 * 60000, end: now - 7 * 86400000 + 35 * 60000, reminder: 30, tz: 'UTC', rrule: { freq: 'WEEKLY' } });
  c('due: weekly series -> this week’s occurrence', dueReminder(dueSeries, now)?.start, now + 5 * 60000);

  // ---------------------------------------------------------------- sanity limits
  section = 'limits';
  const huge = sanitizeEvent({ id: 'h', start: Date.UTC(2026, 9, 21, 8), end: 60481791363600000 });
  c('absurd end limited to 10 years', huge.end - huge.start, 3660 * 86400000);
  c('year 9999 start dropped', sanitizeEvent({ id: 'f', start: Date.UTC(9999, 11, 31), end: Date.UTC(9999, 11, 31, 1) }), null);
  c('year 1800 start dropped', sanitizeEvent({ id: 'o', start: Date.UTC(1800, 0, 1), end: Date.UTC(1800, 0, 1, 1) }), null);
  c('all-day in year 2600 dropped', sanitizeEvent({ id: 'a', allDay: true, start: '2600-01-01', end: '2600-01-02' }), null);
  c('all-day end limited to 10 years', sanitizeEvent({ id: 'b', allDay: true, start: '2026-01-01', end: '2099-01-01' }).end, keyFromDayNum(dayNumFromKey('2026-01-01') + 3660));
  const badOv = sanitizeEvent({ id: 'w', start: Date.UTC(2026, 0, 5, 9), end: Date.UTC(2026, 0, 5, 10), rrule: { freq: 'WEEKLY' }, overrides: { [String(Date.UTC(2026, 0, 12, 9))]: { start: 1e20, title: 'x' } } });
  c('override with an invalid start keeps only the valid fields', badOv.overrides[String(Date.UTC(2026, 0, 12, 9))], { title: 'x' });

  // ---------------------------------------------------------------- holidays
  section = 'holidays';
  const find = (cc, y, id) => holidays(cc, y).find((h) => h.id === id)?.date;
  c('Easter 2026', easter(2026), { y: 2026, m: 3, d: 5 });
  c('Easter 2027', easter(2027), { y: 2027, m: 2, d: 28 });
  c('Lundi de Pâques 2026', find('FR', 2026, 'easterMonday'), '2026-04-06');
  c('Ascension 2026', find('FR', 2026, 'ascension'), '2026-05-14');
  c('Lundi de Pentecôte 2026', find('FR', 2026, 'whitMonday'), '2026-05-25');
  c('Lundi de Pâques 2027', find('FR', 2027, 'easterMonday'), '2027-03-29');
  c('Ascension 2027', find('FR', 2027, 'ascension'), '2027-05-06');
  c('Lundi de Pentecôte 2027', find('FR', 2027, 'whitMonday'), '2027-05-17');
  c('FR fixed holidays 2026', holidays('FR', 2026).filter((h) => h.kind === 'public').map((h) => h.date), [
    '2026-01-01', '2026-04-06', '2026-05-01', '2026-05-08', '2026-05-14', '2026-05-25', '2026-07-14', '2026-08-15', '2026-11-01', '2026-11-11', '2026-12-25',
  ]);
  c('FR names', holidays('FR', 2026).find((h) => h.id === 'easterMonday').name, { en: 'Easter Monday', fr: 'Lundi de Pâques' });
  c('MLK 2026', find('US', 2026, 'mlkDay'), '2026-01-19');
  c('Presidents Day 2026', find('US', 2026, 'presidentsDay'), '2026-02-16');
  c('Memorial Day 2026', find('US', 2026, 'memorialDay'), '2026-05-25');
  c('Labor Day 2026', find('US', 2026, 'laborDay'), '2026-09-07');
  c('Thanksgiving 2026', find('US', 2026, 'thanksgiving'), '2026-11-26');
  c('Independence Day 2026 observed Friday', find('US', 2026, 'independenceDayObserved'), '2026-07-03');
  c('MLK 2027', find('US', 2027, 'mlkDay'), '2027-01-18');
  c('Presidents Day 2027', find('US', 2027, 'presidentsDay'), '2027-02-15');
  c('Memorial Day 2027', find('US', 2027, 'memorialDay'), '2027-05-31');
  c('Labor Day 2027', find('US', 2027, 'laborDay'), '2027-09-06');
  c('Thanksgiving 2027', find('US', 2027, 'thanksgiving'), '2027-11-25');
  c('Christmas 2027 observed Friday', find('US', 2027, 'christmasObserved'), '2027-12-24');
  c('New Year 2028 observed on 2027-12-31', find('US', 2027, 'newYearObserved'), '2027-12-31');
  c('no observed New Year in 2028 list', find('US', 2028, 'newYearObserved'), undefined);

  // ---------------------------------------------------------------- ics
  section = 'ics';
  c('unfold', unfold('DESCRIPTION:Hello\r\n  world\r\n\t again'), 'DESCRIPTION:Hello world again');
  c('unescape', unescapeText('a\\, b\\; c\\nd\\\\e'), 'a, b; c\nd\\e');
  c('escape', escapeText('a, b; c\nd\\e'), 'a\\, b\\; c\\nd\\\\e');
  c('duration', [parseDuration('PT1H30M'), parseDuration('-P1D'), parseDuration('P1W'), parseDuration('P')], [5400000, -86400000, 604800000, null]);
  const longLine = `DESCRIPTION:${'é'.repeat(60)}`;
  const folded = foldLine(longLine);
  c('fold at 75 octets (UTF-8 safe)', folded.split('\r\n ').every((l, i) => new TextEncoder().encode(l).length <= (i ? 74 : 75)) && folded.replace(/\r\n /g, '') === longLine, true);
  const sample = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Test//EN',
    'X-WR-CALNAME:Team\\, Paris',
    'BEGIN:VTIMEZONE',
    'TZID:Custom Paris',
    'X-LIC-LOCATION:Europe/Paris',
    'END:VTIMEZONE',
    'BEGIN:VEVENT',
    'UID:weekly-1@test',
    'DTSTART;TZID=Europe/Paris:20261005T090000',
    'DTEND;TZID=Europe/Paris:20261005T093000',
    'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=4',
    'EXDATE;TZID=Europe/Paris:20261012T090000',
    'SUMMARY:Stand-up\\, team',
    'DESCRIPTION:Line 1\\nLine 2 with a very long text that is folded across several physical lines in',
    '  the file',
    'LOCATION:Room 1\\; floor 2',
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    'TRIGGER:-PT15M',
    'END:VALARM',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:weekly-1@test',
    'RECURRENCE-ID;TZID=Europe/Paris:20261019T090000',
    'DTSTART;TZID=Europe/Paris:20261019T110000',
    'DTEND;TZID=Europe/Paris:20261019T113000',
    'SUMMARY:Stand-up (moved)',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:weekly-1@test',
    'RECURRENCE-ID;TZID=Europe/Paris:20261026T090000',
    'DTSTART;TZID=Europe/Paris:20261026T090000',
    'STATUS:CANCELLED',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:allday@test',
    'DTSTART;VALUE=DATE:20261224',
    'DTEND;VALUE=DATE:20261227',
    'SUMMARY:Holidays',
    'BEGIN:VALARM',
    'TRIGGER;RELATED=START:-P1D',
    'END:VALARM',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:utc@test',
    'DTSTART:20261015T130000Z',
    'DURATION:PT1H30M',
    'SUMMARY:UTC meeting',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:custom@test',
    'DTSTART;TZID="Custom Paris":20261016T080000',
    'DTEND;TZID=Custom Paris:20261016T083000',
    'SUMMARY:Custom zone',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:win@test',
    'DTSTART;TZID=Eastern Standard Time:20261016T080000',
    'DTEND;TZID=Eastern Standard Time:20261016T090000',
    'SUMMARY:Windows zone',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'SUMMARY:No start',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const parsed = parseIcs(sample, { defaultTz: 'Europe/Paris' });
  c('calendar name', parsed.name, 'Team, Paris');
  c('event count (bad one skipped)', parsed.events.length, 5);
  c('warning for missing DTSTART', parsed.warnings.includes('no-dtstart'), true);
  const pw = sanitizeEvent({ ...parsed.events.find((e) => e.uid === 'weekly-1@test'), id: 'pw' });
  c('text unescaped', [pw.title, pw.location, pw.description.split('\n')[0]], ['Stand-up, team', 'Room 1; floor 2', 'Line 1']);
  c('folded description', pw.description.endsWith('lines in the file'), true);
  c('reminder from VALARM', pw.reminder, 15);
  c('rrule parsed', [pw.rrule.freq, pw.rrule.count, pw.rrule.byday], ['WEEKLY', 4, ['MO']]);
  const pocc = expandEvent(pw, Date.UTC(2026, 9, 1), Date.UTC(2026, 11, 1));
  c('expanded with EXDATE, override and cancelled instance', pocc.map((o) => [iso(o.start), o.title]), [
    ['2026-10-05T07:00:00Z', 'Stand-up, team'],
    ['2026-10-19T09:00:00Z', 'Stand-up (moved)'],
  ]);
  const pad = parsed.events.find((e) => e.uid === 'allday@test');
  c('all-day parsed', [pad.allDay, pad.start, pad.end, pad.reminder], [true, '2026-12-24', '2026-12-27', 1440]);
  const putc = parsed.events.find((e) => e.uid === 'utc@test');
  c('UTC + DURATION', [iso(putc.start), putc.end - putc.start], ['2026-10-15T13:00:00Z', 5400000]);
  c('custom TZID via X-LIC-LOCATION', iso(parsed.events.find((e) => e.uid === 'custom@test').start), '2026-10-16T06:00:00Z');
  c('Windows TZID', iso(parsed.events.find((e) => e.uid === 'win@test').start), '2026-10-16T12:00:00Z');
  c('not an ics file', parseIcs('hello world').warnings, ['not-icalendar']);

  // roundtrip
  const evs = parsed.events.map((e, i) => sanitizeEvent({ ...e, id: `rt${i}` }));
  const text = serializeIcs({ name: 'Round, trip', events: evs, now: Date.UTC(2026, 9, 10) });
  c('serialized uses CRLF + fold', text.split('\r\n').every((l) => new TextEncoder().encode(l).length <= 75), true);
  c('serialized has VTIMEZONE with rules', /BEGIN:VTIMEZONE\r\nTZID:Europe\/Paris[\s\S]*RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU[\s\S]*RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU/.test(text), true);
  const back = parseIcs(text, { defaultTz: 'Europe/Paris' });
  c('roundtrip name', back.name, 'Round, trip');
  c('roundtrip count', back.events.length, evs.length);
  const strip = (e) => {
    const s = sanitizeEvent({ ...e, id: 'x' });
    return { title: s.title, location: s.location, description: s.description, allDay: s.allDay, start: s.start, end: s.end, rrule: s.rrule, exdates: [...s.exdates].sort(), overrides: s.overrides, reminder: s.reminder };
  };
  for (const e of evs) {
    const b = back.events.find((x) => x.uid === e.uid);
    c(`roundtrip ${e.uid}`, b && strip(b), strip(e));
  }
  const nyEvent = sanitizeEvent({ id: 'nyx', title: 'NY recurring', start: zonedToUtc(2026, 2, 2, 9, 0, 0, 'America/New_York'), end: zonedToUtc(2026, 2, 2, 10, 0, 0, 'America/New_York'), tz: 'America/New_York', rrule: { freq: 'WEEKLY', count: 3 }, reminder: 60 });
  const nyBack = parseIcs(serializeIcs({ events: [nyEvent] })).events[0];
  c('NY roundtrip keeps wall time over DST', expandEvent(sanitizeEvent({ ...nyBack, id: 'nyb' }), 0, 8e15).map((o) => iso(o.start)), ['2026-03-02T14:00:00Z', '2026-03-09T13:00:00Z', '2026-03-16T13:00:00Z']);
  c('NY roundtrip alarm', nyBack.reminder, 60);

  // ---------------------------------------------------------------- layout
  section = 'layout';
  const H = 3600000;
  const lay = layoutColumns([
    { id: 'a', start: 9 * H, end: 11 * H },
    { id: 'b', start: 9 * H, end: 10 * H },
    { id: 'c', start: 10 * H, end: 12 * H },
    { id: 'd', start: 13 * H, end: 14 * H },
  ]);
  const byId = Object.fromEntries(lay.map((e) => [e.id, [e.col, e.cols, e.span]]));
  c('overlap columns', byId, { a: [0, 2, 1], b: [1, 2, 1], c: [1, 2, 1], d: [0, 1, 1] });
  const many = layoutColumns(Array.from({ length: 12 }, (_, i) => ({ id: i, start: 9 * H, end: 10 * H + i * 60000 })));
  c('12 simultaneous events -> 12 columns', [...new Set(many.map((e) => e.cols))], [12]);
  const lanes = packLanes([
    { id: 'long', startDay: 0, endDay: 5 },
    { id: 's1', startDay: 1, endDay: 2 },
    { id: 's2', startDay: 1, endDay: 2 },
    { id: 's3', startDay: 5, endDay: 6 },
  ]);
  c('lane packing', Object.fromEntries(lanes.map((l) => [l.id, l.lane])), { long: 0, s1: 1, s2: 2, s3: 0 });
}

// Standalone run
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let passed = 0;
  const failures = [];
  runUnitTests((name, actual, expected) => {
    const ok = typeof expected === 'function' ? !!expected(actual) : JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) passed++;
    else failures.push(`${name}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
  });
  for (const f of failures) console.log(`  ✗ ${f}`);
  console.log(`${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
}
