// Calendar data shared by the app and the shell (taskbar flyout): stored calendars + events + prefs,
// holiday occurrences, visible occurrences in a range, and shell.reminders synchronisation.
// No DOM; storage goes through the `api` bridge passed in (api.invoke('storage:get', 'calendar', …)).
//
//   loadData(api) -> { calendars, events, prefs }
//   visibleOccurrences(data, from, to, lang) -> occurrences (holidays included) with .color resolved
//   syncReminders({ reminders, events, lang, hour12, now, limit }) -> { set, removed }   (idempotent; the
//       `limit` soonest reminders only — the next ones are planned when one of them fires, so a big calendar
//       never floods the shell scheduler)
//   reminderText(occ, lang, hour12) -> { title, body }
//   dueReminder(ev, now) -> occurrence whose reminder time has passed but that has not started yet | null
import { sanitizeEvent, expandAll, expandEvent, planReminders, occurrenceAt } from './events.mjs';
import { holidaysInRange } from './holidays.mjs';
import { keyFromDayNum, dayNumFromKey, keyToLocalMs, localKey, DAY_MS } from './dates.mjs';

export const APP_ID = 'calendar';

// Calendar colours: a muted lunar palette (slate blue, mist teal, sage, moss, sand, clay, dusty rose, mauve,
// lavender, night indigo, moon grey, haze blue). They are user data (saved, exported to .ics), so they are
// hex values; each one is a mid tone that stays >= 3:1 against the dark and the light surfaces of every
// ambiance, and the views tint them against --card-solid.
export const PALETTE = ['#6e86b8', '#5b9399', '#74966a', '#8f9156', '#b08d55', '#b37a62', '#b5707f', '#9b78aa', '#8579b8', '#6b72ad', '#7d8796', '#5d8db3'];

// The first palette (saturated Outlook colours) maps onto the new one, index for index, so calendars and
// events saved before the redesign take the new colours.
const LEGACY_PALETTE = ['#0078d4', '#038387', '#107c10', '#8cbd18', '#c19c00', '#ca5010', '#d13438', '#e3008c', '#8764b8', '#5c2e91', '#69797e', '#4f6bed'];
export function migrateColor(c) {
  if (typeof c !== 'string') return c;
  const i = LEGACY_PALETTE.indexOf(c.toLowerCase());
  return i < 0 ? c : PALETTE[i];
}

export const BUILTIN = {
  personal: { color: PALETTE[0] },
  work: { color: PALETTE[4] },
  birthdays: { color: PALETTE[6] },
  'holidays-fr': { color: PALETTE[2], country: 'FR' },
  'holidays-us': { color: PALETTE[8], country: 'US' },
};

export function defaultCalendars(lang = 'en') {
  return [
    { id: 'personal', name: null, color: BUILTIN.personal.color, visible: true, kind: 'user' },
    { id: 'work', name: null, color: BUILTIN.work.color, visible: true, kind: 'user' },
    { id: 'birthdays', name: null, color: BUILTIN.birthdays.color, visible: true, kind: 'user' },
    { id: 'holidays-fr', name: null, color: BUILTIN['holidays-fr'].color, visible: lang === 'fr', kind: 'holidays', country: 'FR' },
    { id: 'holidays-us', name: null, color: BUILTIN['holidays-us'].color, visible: lang !== 'fr', kind: 'holidays', country: 'US' },
  ];
}

const isColor = (c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c);

export function sanitizeCalendars(list, lang = 'en') {
  const defs = defaultCalendars(lang);
  if (!Array.isArray(list) || !list.length) return defs;
  const out = [];
  const seen = new Set();
  for (const c of list) {
    if (!c || typeof c !== 'object' || typeof c.id !== 'string' || !c.id || seen.has(c.id)) continue;
    seen.add(c.id);
    const holidays = c.kind === 'holidays' && (c.country === 'FR' || c.country === 'US');
    out.push({
      id: c.id.slice(0, 100),
      name: typeof c.name === 'string' && c.name.trim() ? c.name.slice(0, 200) : null,
      color: isColor(c.color) ? migrateColor(c.color) : PALETTE[out.length % PALETTE.length],
      visible: c.visible !== false,
      kind: holidays ? 'holidays' : 'user',
      ...(holidays ? { country: c.country } : {}),
    });
  }
  // the holiday calendars always exist (they can be hidden, not deleted)
  for (const d of defs) if (d.kind === 'holidays' && !seen.has(d.id)) out.push(d);
  if (!out.some((c) => c.kind === 'user')) out.unshift(defs[0]);
  return out;
}

export const DEFAULT_PREFS = {
  firstDay: 'auto', // 'auto' (language) | 0 Sunday | 1 Monday | 6 Saturday
  weekNumbers: false,
  workDays: [1, 2, 3, 4, 5],
  workStart: 8,
  workEnd: 17,
  defaultReminder: 15,
  defaultCalendar: 'personal',
  defaultDuration: 30,
  view: 'month',
  paneOpen: true,
};

export function sanitizePrefs(p) {
  const out = { ...DEFAULT_PREFS };
  if (!p || typeof p !== 'object') return out;
  if (p.firstDay === 'auto' || [0, 1, 6].includes(p.firstDay)) out.firstDay = p.firstDay;
  out.weekNumbers = !!p.weekNumbers;
  if (Array.isArray(p.workDays)) {
    const wd = [...new Set(p.workDays.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
    if (wd.length) out.workDays = wd;
  }
  if (Number.isInteger(p.workStart) && p.workStart >= 0 && p.workStart <= 23) out.workStart = p.workStart;
  if (Number.isInteger(p.workEnd) && p.workEnd > out.workStart && p.workEnd <= 24) out.workEnd = p.workEnd;
  if (p.defaultReminder === null || (Number.isFinite(p.defaultReminder) && p.defaultReminder >= 0)) out.defaultReminder = p.defaultReminder;
  if (typeof p.defaultCalendar === 'string') out.defaultCalendar = p.defaultCalendar;
  if ([15, 30, 45, 60, 90, 120].includes(p.defaultDuration)) out.defaultDuration = p.defaultDuration;
  if (['day', 'workweek', 'week', 'month', 'agenda'].includes(p.view)) out.view = p.view;
  if (typeof p.paneOpen === 'boolean') out.paneOpen = p.paneOpen;
  return out;
}

export function sanitizeEvents(list, calendars) {
  if (!Array.isArray(list)) return [];
  const ids = new Set(calendars.filter((c) => c.kind === 'user').map((c) => c.id));
  const fallback = calendars.find((c) => c.kind === 'user')?.id || 'personal';
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const ev = sanitizeEvent(raw);
    if (!ev || seen.has(ev.id)) continue;
    seen.add(ev.id);
    if (!ids.has(ev.calendarId)) ev.calendarId = fallback;
    out.push(ev);
  }
  return out;
}

export async function loadData(api, lang = 'en') {
  const get = (name, fb) => api.invoke('storage:get', APP_ID, name, fb).catch(() => fb);
  const [cals, evs, prefs] = await Promise.all([get('calendars', null), get('events', []), get('prefs', null)]);
  const calendars = sanitizeCalendars(cals, lang);
  return { calendars, events: sanitizeEvents(evs, calendars), prefs: sanitizePrefs(prefs) };
}

export function holidayOccurrences(cal, from, to, lang = 'en') {
  const fromKey = localKey(from - DAY_MS);
  const toKey = localKey(to);
  const out = [];
  for (const h of holidaysInRange(cal.country, fromKey, toKey)) {
    const endKey = keyFromDayNum(dayNumFromKey(h.date) + 1);
    const start = keyToLocalMs(h.date);
    const end = keyToLocalMs(endKey);
    if (!(start < to && end > from)) continue;
    out.push({
      eventId: `hol-${cal.country.toLowerCase()}-${h.date}-${h.id}`,
      key: h.date,
      allDay: true,
      startKey: h.date,
      endKey,
      start,
      end,
      title: h.name[lang] || h.name.en,
      location: '',
      description: '',
      calendarId: cal.id,
      color: null,
      reminder: null,
      recurring: false,
      exception: false,
      readOnly: true,
      holiday: { country: cal.country, kind: h.kind, id: h.id },
      ev: null,
    });
  }
  return out;
}

export function visibleOccurrences(data, from, to, lang = 'en', { includeHidden = false } = {}) {
  const cals = new Map(data.calendars.map((c) => [c.id, c]));
  const shown = (id) => includeHidden || cals.get(id)?.visible !== false;
  const out = expandAll(data.events, from, to, (ev, occ) => shown(occ ? occ.calendarId : ev.calendarId) || (!occ && Object.values(ev.overrides || {}).some((o) => o.calendarId && shown(o.calendarId))));
  for (const c of data.calendars) if (c.kind === 'holidays' && (includeHidden || c.visible)) out.push(...holidayOccurrences(c, from, to, lang));
  for (const o of out) o.color = migrateColor(o.color) || cals.get(o.calendarId)?.color || PALETTE[0];
  return out.sort((a, b) => (b.allDay ? 1 : 0) - (a.allDay ? 1 : 0) || a.start - b.start || b.end - a.end || String(a.title).localeCompare(String(b.title)));
}

// ------------------------------------------------------------------ reminders
const TEXT = {
  en: { allDay: 'All day', noTitle: '(No title)' },
  fr: { allDay: 'Toute la journée', noTitle: '(Sans titre)' },
};
const LOCALE = { en: 'en-US', fr: 'fr-FR' };

export function reminderText(occ, lang = 'en', hour12 = null) {
  const tx = TEXT[lang] || TEXT.en;
  const locale = LOCALE[lang] || 'en-US';
  const h12 = hour12 != null ? hour12 : lang !== 'fr';
  const topt = { hour: h12 ? 'numeric' : '2-digit', minute: '2-digit', hour12: h12 };
  const tf = new Intl.DateTimeFormat(locale, topt);
  const df = new Intl.DateTimeFormat(locale, { weekday: 'short', month: 'short', day: 'numeric' });
  let when;
  if (occ.allDay) when = `${df.format(occ.start)} · ${tx.allDay}`;
  else when = `${df.format(occ.start)} · ${tf.format(occ.start)} – ${tf.format(occ.end)}`;
  return { title: occ.title?.trim() || tx.noTitle, body: occ.location ? `${when} · ${occ.location}` : when };
}

let syncChain = Promise.resolve();

// The next occurrence of `ev` whose reminder time is already past although it has not started yet (an
// event created 10 minutes before it starts, with a 15-minute reminder). Reminders are at most 28 days.
export function dueReminder(ev, now = Date.now()) {
  if (!ev || ev.readOnly) return null;
  try {
    for (const o of expandEvent(ev, now, now + 29 * DAY_MS)) {
      if (o.start <= now || o.reminder == null || o.reminder <= 0) continue;
      if (o.start - o.reminder * 60000 <= now) return o;
    }
  } catch {}
  return null;
}

// A reminder still scheduled after its planned time: a snoozed one (snoozing a one-shot reminder sets it
// again under the same id) or one shown late. Kept while its occurrence still exists with a reminder.
function isLateCopy(r, byId, now) {
  const ev = byId.get(r.data?.eventId);
  if (!ev || r.data?.key == null || !(r.at > now)) return false;
  try {
    const occ = occurrenceAt(ev, r.data.key);
    return !!occ && occ.reminder != null && occ.start - occ.reminder * 60000 <= now;
  } catch {
    return false;
  }
}

// Make shell.reminders hold exactly the next reminders of every event (3 occurrences per event, the
// `limit` soonest in all).
export function syncReminders({ reminders, events, lang = 'en', hour12 = null, now = Date.now(), perEvent = 3, limit = 64 }) {
  const run = async () => {
    if (!reminders?.list) return { set: 0, removed: 0 };
    const plan = planReminders(events, now, { perEvent }).slice(0, limit);
    const want = new Map();
    for (const p of plan) {
      const { title, body } = reminderText(p.occ, lang, hour12);
      want.set(p.id, { id: p.id, appId: APP_ID, at: p.at, title, body, kind: 'reminder', snoozeMinutes: 5, data: { eventId: p.eventId, key: p.key } });
    }
    let set = 0;
    let removed = 0;
    const byId = new Map(events.map((e) => [e.id, e]));
    for (const r of reminders.list(APP_ID)) {
      if (!String(r.id).startsWith('evt-') || String(r.id).includes('~')) continue; // keep snoozed copies
      const w = want.get(r.id);
      if (!w) {
        if (isLateCopy(r, byId, now)) continue;
        reminders.remove(r.id, APP_ID);
        removed++;
      } else if (w.at === r.at && w.title === r.title && w.body === r.body) want.delete(r.id);
    }
    for (const w of want.values()) {
      reminders.set(w);
      set++;
    }
    return { set, removed };
  };
  syncChain = syncChain.then(run, run);
  return syncChain;
}
