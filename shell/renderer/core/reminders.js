// Shared reminder / alarm scheduler, used by Clock (alarms), To Do (reminders) and Calendar (events).
// Lives in the shell, so reminders fire while the owning app is closed. Persisted in
// ~/.config/aurora/apps/shell/reminders.json.
//
//   shell.reminders.set({
//     id,                 // unique per app, e.g. 'alarm-3' (required; setting an existing id replaces it)
//     appId,              // owner app ('clock', 'todo', 'calendar') — required
//     at,                 // epoch ms of the next occurrence (required)
//     title, body,        // notification text (already localized by the app)
//     repeat,             // null | 'daily' | 'weekdays' | 'weekly' | { days: [0..6] } (0 = Sunday)
//     kind,               // 'reminder' (default: notification + chime) | 'alarm' (rings until dismissed, max 1 min)
//     snoozeMinutes,      // snooze length offered on the notification (default 10, 0 = no snooze button)
//     data,               // any JSON the app wants back (launch args)
//   }) -> reminder
//   shell.reminders.remove(id, appId)    shell.reminders.list(appId?) -> [reminder]
//   shell.reminders.get(id, appId)       shell.reminders.snooze(id, appId, minutes)
//   shell.reminders.on('fire' | 'change', fn)   ('fire' gets the reminder that just fired)
// Clicking the notification launches the app with args { reminder: { id, data } }.
// Missed reminders (shell not running, machine asleep) fire on the next start if they are less than
// 6 hours late; older one-shot reminders are dropped, repeating ones jump to their next occurrence.
import { api, Emitter } from './api.js';
import { notify, notifications } from './notify.js';
import { sounds } from './sounds.js';
import { t, i18n } from './i18n.js';

i18n.extend({
  en: { reminders: { snooze: 'Snooze {n} min', dismiss: 'Dismiss', missed: 'Missed' } },
  fr: { reminders: { snooze: 'Répéter dans {n} min', dismiss: 'Ignorer', missed: 'Manqué' } },
});

const emitter = new Emitter();
const MISSED_WINDOW = 6 * 3600 * 1000;
let items = [];
let timer = null;
let registryRef = null;
let ringing = null;

const key = (r) => `${r.appId}::${r.id}`;

function save() {
  api.invoke('storage:set', 'shell', 'reminders', items).catch((err) => console.error('[reminders] save failed', err));
  emitter.emit('change');
}

function repeatDays(repeat) {
  if (!repeat) return null;
  if (repeat === 'daily') return [0, 1, 2, 3, 4, 5, 6];
  if (repeat === 'weekdays') return [1, 2, 3, 4, 5];
  if (repeat === 'weekly') return 'weekly';
  if (Array.isArray(repeat?.days) && repeat.days.length) return repeat.days.map(Number).filter((d) => d >= 0 && d <= 6);
  return null;
}

// Next occurrence strictly after `after`, keeping the original time of day.
export function nextOccurrence(r, after = Date.now()) {
  const days = repeatDays(r.repeat);
  if (!days) return null;
  const base = new Date(r.at);
  const d = new Date(after);
  d.setHours(base.getHours(), base.getMinutes(), base.getSeconds(), 0);
  for (let i = 0; i < 400; i++) {
    const cand = new Date(d);
    cand.setDate(d.getDate() + i);
    if (cand.getTime() <= after) continue;
    if (days === 'weekly' ? cand.getDay() === base.getDay() : days.includes(cand.getDay())) return cand.getTime();
  }
  return null;
}

function stopRinging() {
  if (!ringing) return;
  clearInterval(ringing.loop);
  clearTimeout(ringing.stop);
  ringing = null;
}

function ring() {
  stopRinging();
  sounds.play('alarm');
  ringing = {
    loop: setInterval(() => sounds.play('alarm'), 1600),
    stop: setTimeout(stopRinging, 60000),
  };
}

function fire(r, late = false) {
  const appName = registryRef?.name?.(r.appId) || r.appId;
  const snooze = r.snoozeMinutes ?? 10;
  if (r.kind === 'alarm') ring();
  const actions = [];
  if (snooze > 0) {
    actions.push({ label: t('reminders.snooze', { n: snooze }), onClick: () => (stopRinging(), reminders.snooze(r.id, r.appId, snooze)) });
  }
  actions.push({ label: t('reminders.dismiss'), onClick: () => stopRinging() });
  notify({
    title: r.title || appName,
    body: late ? `${t('reminders.missed')} · ${r.body || ''}`.trim() : r.body || '',
    appId: r.appId,
    appName,
    timeout: r.kind === 'alarm' ? 0 : 15000,
    silent: r.kind === 'alarm',
    actions,
    onClick: () => {
      stopRinging();
      registryRef?.launch?.(r.appId, { reminder: { id: r.id, data: r.data ?? null } });
    },
  });
  emitter.emit('fire', { ...r });
}

function schedule() {
  clearTimeout(timer);
  const now = Date.now();
  let changed = false;
  for (const r of [...items]) {
    if (r.at > now) continue;
    const late = now - r.at > 90 * 1000;
    if (now - r.at <= MISSED_WINDOW) fire(r, late);
    const next = nextOccurrence(r, now);
    if (next) r.at = next;
    else items = items.filter((x) => x !== r);
    changed = true;
  }
  if (changed) save();
  const soonest = items.reduce((m, r) => Math.min(m, r.at), Infinity);
  // Re-check at least every 30 s so clock changes and suspend/resume are caught.
  const wait = Math.max(250, Math.min(30000, soonest - Date.now()));
  timer = setTimeout(schedule, wait);
}

export const reminders = {
  async init(registry) {
    registryRef = registry;
    try {
      const saved = await api.invoke('storage:get', 'shell', 'reminders', []);
      items = Array.isArray(saved) ? saved.filter((r) => r && r.id != null && r.appId && Number.isFinite(r.at)) : [];
    } catch {
      items = [];
    }
    schedule();
    notifications.on?.('change', () => {});
  },
  set(r) {
    if (!r || r.id == null || !r.appId || !Number.isFinite(Number(r.at))) throw new Error('reminders.set needs id, appId and at');
    const item = {
      id: String(r.id),
      appId: String(r.appId),
      at: Number(r.at),
      title: String(r.title ?? ''),
      body: String(r.body ?? ''),
      repeat: r.repeat ?? null,
      kind: r.kind === 'alarm' ? 'alarm' : 'reminder',
      snoozeMinutes: r.snoozeMinutes ?? 10,
      data: r.data ?? null,
    };
    items = items.filter((x) => key(x) !== key(item));
    items.push(item);
    save();
    schedule();
    return { ...item };
  },
  remove(id, appId) {
    const before = items.length;
    items = items.filter((x) => !(x.id === String(id) && (appId == null || x.appId === appId)));
    if (items.length !== before) {
      save();
      schedule();
    }
  },
  get(id, appId) {
    const r = items.find((x) => x.id === String(id) && (appId == null || x.appId === appId));
    return r ? { ...r } : null;
  },
  list(appId) {
    return items.filter((x) => !appId || x.appId === appId).map((x) => ({ ...x }));
  },
  snooze(id, appId, minutes = 10) {
    const r = items.find((x) => x.id === String(id) && x.appId === appId);
    const at = Date.now() + Math.max(1, minutes) * 60000;
    if (r && !r.repeat) {
      r.at = at;
      save();
      schedule();
    } else if (r) {
      // keep the repeating reminder and add a one-off snoozed copy
      reminders.set({ ...r, id: `${r.id}~snooze`, at, repeat: null });
    }
  },
  stopRinging,
  on: (ev, fn) => emitter.on(ev, fn),
};
