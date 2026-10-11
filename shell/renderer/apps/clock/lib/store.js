// Clock — state + background service. One instance per shell session (module singleton): it outlives
// the Clock window, so timers, the stopwatch and focus sessions keep running when the app is closed,
// and it mirrors alarms / running timers / focus sessions into shell.reminders so they fire from the
// shell even when the app was never opened since boot.
//
// Storage (~/.config/aurora/apps/clock/*.json): alarms, timers, stopwatch, cities, focus, prefs.
// focus.json is the integration point for a future shell-wide "Focus mode":
//   { status: { active, state: 'running'|'paused'|null, phase: 'focus'|'break'|null, phaseEndsAt, endsAt,
//               startedAt, minutes, breaks, updatedAt },
//     session: {...internal...}, history: { 'YYYY-MM-DD': focusMinutes }, log: [...] }
import { nextAlarmOccurrence, wallTime, uses12h, dayKey, addDays, durationName, localZone, MIN } from './time.js';
import { TONES, toneById, FOCUS_CUE } from './tones.js';

export const APP = 'clock';
export const SNOOZE_CHOICES = [0, 5, 10, 20, 30];
export const FOCUS_MIN = 15;
export const FOCUS_MAX = 240;
// Upper bounds (a damaged or hostile alarms.json with thousands of entries must not freeze the shell:
// every enabled alarm is one shell.reminders entry, written to disk on each change)
export const MAX_ALARMS = 100;
export const MAX_TIMERS = 100;

const DEFAULT_PREFS = {
  page: 'timer',
  navCollapsed: false,
  sound: 'chimes',
  timerSound: 'chimes',
  snooze: 10,
  focus: { minutes: 30, chunk: 30, brk: 5, goal: 60, skipBreaks: false, dnd: 'ask', sound: true },
};

const uid = (p) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const int = (v, min, max, def) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};
/** First item of each id (stored lists are untrusted: two cards with one id would share one DOM node). */
const uniqueById = (list) => {
  const seen = new Set();
  return list.filter((x) => x && !seen.has(x.id) && seen.add(x.id));
};

// ------------------------------------------------------------------ sanitizers (stored data is untrusted)
function cleanAlarm(a) {
  if (!isObj(a) || typeof a.id !== 'string' || !a.id) return null;
  const days = Array.isArray(a.days) ? [...new Set(a.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort() : [];
  return {
    id: a.id.slice(0, 40),
    hour: int(a.hour, 0, 23, 7),
    minute: int(a.minute, 0, 59, 0),
    name: typeof a.name === 'string' ? a.name.slice(0, 64) : '',
    days,
    sound: TONES.some((x) => x.id === a.sound) ? a.sound : 'chimes',
    snooze: SNOOZE_CHOICES.includes(Number(a.snooze)) ? Number(a.snooze) : 10,
    enabled: a.enabled === true,
    at: Number.isFinite(a.at) ? a.at : null,
    created: Number.isFinite(a.created) ? a.created : Date.now(),
  };
}

function cleanTimer(x) {
  if (!isObj(x) || typeof x.id !== 'string' || !x.id) return null;
  const duration = int(x.duration, 1000, 100 * 3600 * 1000 - 1000, 5 * MIN);
  const state = ['idle', 'running', 'paused', 'done'].includes(x.state) ? x.state : 'idle';
  const t = {
    id: x.id.slice(0, 40),
    name: typeof x.name === 'string' ? x.name.slice(0, 64) : '',
    duration,
    state,
    runTotal: int(x.runTotal, 1000, 200 * 3600 * 1000, duration),
    endAt: Number.isFinite(x.endAt) ? x.endAt : null,
    remaining: Number.isFinite(x.remaining) ? Math.max(0, x.remaining) : duration,
    doneAt: Number.isFinite(x.doneAt) ? x.doneAt : null,
  };
  if (t.state === 'running' && !t.endAt) t.state = 'idle';
  return t;
}

function cleanStopwatch(s) {
  const o = isObj(s) ? s : {};
  return {
    running: o.running === true && Number.isFinite(o.startedAt),
    startedAt: Number.isFinite(o.startedAt) ? o.startedAt : 0,
    base: Number.isFinite(o.base) ? Math.max(0, o.base) : 0,
    laps: Array.isArray(o.laps) ? o.laps.filter((n) => Number.isFinite(n) && n >= 0).slice(-999) : [],
  };
}

function cleanFocus(f) {
  const o = isObj(f) ? f : {};
  const history = {};
  if (isObj(o.history)) for (const [k, v] of Object.entries(o.history)) if (/^\d{4}-\d{2}-\d{2}$/.test(k) && Number.isFinite(v) && v >= 0) history[k] = Math.round(v);
  let session = null;
  const s = o.session;
  if (isObj(s) && Array.isArray(s.segs) && s.segs.length && Number.isFinite(s.startedAt)) {
    const segs = s.segs.filter((g) => isObj(g) && (g.type === 'focus' || g.type === 'break') && Number.isFinite(g.ms) && g.ms > 0).map((g) => ({ type: g.type, ms: g.ms }));
    if (segs.length) {
      session = {
        id: String(s.id || uid('f')),
        minutes: int(s.minutes, 1, FOCUS_MAX, 30),
        segs,
        startedAt: s.startedAt,
        state: s.state === 'paused' ? 'paused' : 'running',
        pausedAt: Number.isFinite(s.pausedAt) ? s.pausedAt : null,
        pausedTotal: Number.isFinite(s.pausedTotal) ? Math.max(0, s.pausedTotal) : 0,
        // [from, to] of each finished pause, so focus time can be split exactly at midnight
        pauses: Array.isArray(s.pauses) ? s.pauses.filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) && p[1] >= p[0]).map((p) => [p[0], p[1]]).slice(-500) : [],
        dndChanged: s.dndChanged === true,
      };
      if (session.state === 'paused' && !session.pausedAt) session.pausedAt = Date.now();
    }
  }
  const log = Array.isArray(o.log) ? o.log.filter((e) => isObj(e) && Number.isFinite(e.start) && Number.isFinite(e.focusMin)).slice(-200) : [];
  const last = isObj(o.last) && Number.isFinite(o.last.endedAt) ? { completed: !!o.last.completed, focusMin: int(o.last.focusMin, 0, 10000, 0), endedAt: o.last.endedAt, seen: !!o.last.seen } : null;
  return { session, history, log, last };
}

function cleanPrefs(p) {
  const o = isObj(p) ? p : {};
  const f = isObj(o.focus) ? o.focus : {};
  const df = DEFAULT_PREFS.focus;
  return {
    page: ['focus', 'timer', 'alarm', 'stopwatch', 'world', 'settings'].includes(o.page) ? o.page : DEFAULT_PREFS.page,
    navCollapsed: o.navCollapsed === true,
    sound: TONES.some((x) => x.id === o.sound) ? o.sound : DEFAULT_PREFS.sound,
    timerSound: TONES.some((x) => x.id === o.timerSound) ? o.timerSound : DEFAULT_PREFS.timerSound,
    snooze: SNOOZE_CHOICES.includes(Number(o.snooze)) ? Number(o.snooze) : DEFAULT_PREFS.snooze,
    focus: {
      // the duration picker steps by 5 minutes: keep the stored value on that grid
      minutes: Math.round(int(f.minutes, FOCUS_MIN, FOCUS_MAX, df.minutes) / 5) * 5,
      chunk: [25, 30, 45, 60].includes(Number(f.chunk)) ? Number(f.chunk) : df.chunk,
      brk: [5, 10, 15].includes(Number(f.brk)) ? Number(f.brk) : df.brk,
      goal: int(f.goal, 15, 600, df.goal),
      skipBreaks: f.skipBreaks === true,
      dnd: ['ask', 'always', 'never'].includes(f.dnd) ? f.dnd : df.dnd,
      sound: f.sound !== false,
    },
  };
}

/** Focus plan: focus periods of `chunk` minutes separated by `brk`-minute breaks (no tiny last period). */
export function planSegments(minutes, chunk = 30, brk = 5, skipBreaks = false) {
  minutes = Math.max(1, Math.round(minutes));
  if (skipBreaks || minutes <= chunk) return [{ type: 'focus', ms: minutes * MIN }];
  const segs = [];
  let rem = minutes;
  while (rem > 0) {
    let f = Math.min(chunk, rem);
    if (rem - f > 0 && rem - f < 10) f = rem; // fold a short tail into this period
    segs.push({ type: 'focus', ms: f * MIN });
    rem -= f;
    if (rem > 0) segs.push({ type: 'break', ms: brk * MIN });
  }
  return segs;
}

// ------------------------------------------------------------------ store
let instance = null;
export function getStore(ctx) {
  if (!instance) instance = new ClockStore(ctx);
  return instance;
}

class ClockStore {
  constructor(ctx) {
    this.ctx = ctx;
    this.t = ctx.t;
    this.shell = ctx.shell;
    this.settings = ctx.settings;
    this.i18n = ctx.i18n;
    this.subs = new Set();
    this.saveTimers = {};
    this.focusTimers = [];
    this.alarms = [];
    this.timers = [];
    this.stopwatch = cleanStopwatch(null);
    this.cities = [];
    this.focus = cleanFocus(null);
    this.prefs = cleanPrefs(null);
    this.saveError = null;
    this.ready = this._load();
  }

  get rem() {
    return this.shell.reminders;
  }
  get locale() {
    return this.i18n?.locale || 'en-US';
  }
  get h12() {
    return uses12h(this.locale, this.settings.get('clock24h') ?? null);
  }

  on(fn) {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }
  emit(kind, extra) {
    for (const fn of [...this.subs]) {
      try {
        fn(kind, extra);
      } catch (err) {
        console.error('[clock] listener failed', err);
      }
    }
  }

  async _load() {
    const st = this.ctx.storage;
    const get = (n, d) => st.get(n, d).catch((err) => (console.error(`[clock] reading ${n} failed`, err), d));
    const [alarms, timers, sw, cities, focus, prefs] = await Promise.all([get('alarms', null), get('timers', null), get('stopwatch', null), get('cities', null), get('focus', null), get('prefs', null)]);
    // storage.get answers the fallback both for a missing file and for one that can't be read or parsed:
    // a damaged file is set aside (never silently replaced by the first-run defaults) and reported
    const shapes = { alarms: [alarms, Array.isArray], timers: [timers, Array.isArray], stopwatch: [sw, isObj], cities: [cities, Array.isArray], focus: [focus, isObj], prefs: [prefs, isObj] };
    const suspect = Object.entries(shapes).filter(([, [v, ok]]) => !ok(v)).map(([k]) => k);
    this.loadErrors = suspect.length ? await this._setAsideUnreadable(suspect) : [];
    const damaged = new Set(this.loadErrors.map((e) => e.name));
    this.prefs = cleanPrefs(prefs);
    const firstRun = (k, v) => !Array.isArray(v) && !damaged.has(k);
    this.alarms = Array.isArray(alarms)
      ? uniqueById(alarms.slice(0, MAX_ALARMS * 4).map(cleanAlarm).filter(Boolean)).slice(0, MAX_ALARMS)
      : firstRun('alarms', alarms)
        ? [cleanAlarm({ id: uid('a'), hour: 7, minute: 0, name: this.t('alarm.goodMorning'), days: [1, 2, 3, 4, 5], enabled: false })]
        : [];
    this.timers = Array.isArray(timers)
      ? uniqueById(timers.slice(0, MAX_TIMERS * 4).map(cleanTimer).filter(Boolean)).slice(0, MAX_TIMERS)
      : firstRun('timers', timers)
        ? [1, 3, 5].map((m) => cleanTimer({ id: uid('t'), name: '', duration: m * MIN }))
        : [];
    this.stopwatch = cleanStopwatch(sw);
    this.cities = Array.isArray(cities) ? [...new Set(cities.filter((c) => typeof c === 'string' && c.length <= 80))].slice(0, 60) : [];
    this.focus = cleanFocus(focus);
    if (firstRun('alarms', alarms)) this.persist('alarms');
    if (firstRun('timers', timers)) this.persist('timers');
    this.reconcile();
    this.zone = localZone();
    this.rem.on('fire', (r) => this._onFire(r));
    let langT = null;
    this.i18n.on('change', () => {
      clearTimeout(langT);
      langT = setTimeout(() => this.resyncAll(), 50);
    });
    this.settings.on('clock24h', () => this.resyncAll());
  }

  /**
   * Of the stored files that came back empty or malformed, find those that exist on disk (so they are
   * damaged, not missing) and rename each to <name>.unreadable-<date>.json next to it.
   * -> [{ name, backup: 'alarms.unreadable-….json' | null (could not be renamed) }]
   */
  async _setAsideUnreadable(names) {
    const api = this.ctx.api;
    let dir;
    try {
      dir = await api.invoke('storage:dir', APP);
    } catch {
      return [];
    }
    const out = [];
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    for (const name of names) {
      const file = `${dir}/${name}.json`;
      let exists = false;
      try {
        exists = await api.invoke('fs:exists', file);
      } catch {}
      if (!exists) continue;
      let backup = `${name}.unreadable-${stamp}.json`;
      try {
        await api.invoke('fs:rename', file, backup);
      } catch (err) {
        console.error(`[clock] could not set aside the unreadable ${name}.json`, err);
        backup = null;
      }
      out.push({ name, backup });
    }
    return out;
  }

  dismissLoadErrors() {
    this.loadErrors = [];
    this.emit('save-error');
  }

  /** Drop stored city ids that are not in the bundled list (called once the list has loaded). */
  pruneCities(known) {
    const kept = this.cities.filter((id) => known(id));
    if (kept.length === this.cities.length) return false;
    this.cities = kept;
    this.persist('cities');
    this.emit('cities');
    return true;
  }

  persist(kind) {
    clearTimeout(this.saveTimers[kind]);
    this.saveTimers[kind] = setTimeout(() => {
      const data =
        kind === 'alarms' ? this.alarms : kind === 'timers' ? this.timers : kind === 'stopwatch' ? this.stopwatch : kind === 'cities' ? this.cities : kind === 'focus' ? { ...this.focus, status: this.focusStatus() } : this.prefs;
      this.ctx.storage.set(kind, data).then(
        () => {
          if (this.saveError) {
            this.saveError = null;
            this.emit('save-error');
          }
        },
        (err) => {
          console.error(`[clock] saving ${kind} failed`, err);
          this.saveError = err?.message || String(err);
          this.emit('save-error');
        },
      );
    }, 120);
  }

  /** Write everything now (tests, window close). */
  async flush() {
    const kinds = Object.keys(this.saveTimers);
    for (const k of kinds) clearTimeout(this.saveTimers[k]);
    await Promise.all(['alarms', 'timers', 'stopwatch', 'cities', 'focus', 'prefs'].map((k) => {
      const data = k === 'alarms' ? this.alarms : k === 'timers' ? this.timers : k === 'stopwatch' ? this.stopwatch : k === 'cities' ? this.cities : k === 'focus' ? { ...this.focus, status: this.focusStatus() } : this.prefs;
      return this.ctx.storage.set(k, data).catch(() => {});
    }));
  }

  setPref(key, value) {
    if (key.startsWith('focus.')) this.prefs.focus = cleanPrefs({ ...this.prefs, focus: { ...this.prefs.focus, [key.slice(6)]: value } }).focus;
    else this.prefs = cleanPrefs({ ...this.prefs, [key]: value });
    this.persist('prefs');
    if (key === 'timerSound') this.timers.filter((x) => x.state === 'running').forEach((x) => this._syncTimer(x));
    this.emit('prefs', key);
  }

  // Bring the stored state in line with shell.reminders (things that fired while the app was closed).
  reconcile(now = Date.now()) {
    const live = new Map(this.rem.list(APP).map((r) => [r.id, r]));
    let a1 = false;
    for (const a of this.alarms) {
      const rid = `alarm-${a.id}`;
      // (a disabled one-shot alarm may still have a live reminder: the snoozed ring from its notification)
      if (!a.enabled) continue;
      if (a.at && a.at <= now) {
        const r = live.get(rid);
        if (r && r.at <= now + 1000) continue; // about to fire right now
        if (!a.days.length) {
          // a one-shot alarm that rang (or was missed) while Clock was closed turns itself off; if it was
          // snoozed from its notification, the shell re-registered it later under the same id: keep that ring
          a.enabled = false;
          a.at = null;
          if (!(r && r.at > now)) this.rem.remove(rid, APP);
          a1 = true;
          continue;
        }
      }
      this._syncAlarm(a);
      a1 = true;
    }
    // orphaned reminders (deleted alarms / timers)
    for (const id of live.keys()) {
      const base = id.replace(/~snooze$/, '');
      if (base.startsWith('alarm-') && !this.alarms.some((a) => `alarm-${a.id}` === base)) this.rem.remove(id, APP);
      if (base.startsWith('timer-') && !this.timers.some((x) => `timer-${x.id}` === base && x.state === 'running')) this.rem.remove(id, APP);
    }
    let t1 = false;
    for (const x of this.timers) {
      if (x.state !== 'running') continue;
      if (x.endAt <= now) {
        x.state = 'done';
        x.doneAt = x.endAt;
        this.rem.remove(`timer-${x.id}`, APP);
      } else this._syncTimer(x);
      t1 = true;
    }
    if (a1) this.persist('alarms');
    if (t1) this.persist('timers');
    this._reconcileFocus(now);
  }

  /** The system time zone changed (Settings > Time): alarms keep their wall time in the new zone. */
  checkZone() {
    const z = localZone();
    if (!this.zone || z === this.zone) return false;
    this.zone = z;
    this.resyncAll();
    return true;
  }

  resyncAll() {
    for (const a of this.alarms) if (a.enabled) this._syncAlarm(a);
    for (const x of this.timers) if (x.state === 'running') this._syncTimer(x);
    if (this.focus.session?.state === 'running') this._syncFocusReminders();
    this.emit('all');
  }

  _onFire(r) {
    if (!r || r.appId !== APP) return;
    const id = String(r.id);
    const snoozed = id.endsWith('~snooze');
    const base = id.replace(/~snooze$/, '');
    if (base.startsWith('alarm-')) {
      const a = this.alarms.find((x) => `alarm-${x.id}` === base);
      if (!a) return;
      a.lastRang = Date.now();
      if (!snoozed) {
        if (!a.days.length) {
          a.enabled = false;
          a.at = null;
        } else {
          // the scheduler moved it to the next day; re-register after it is done so the wall time stays exact
          setTimeout(() => a.enabled && this._syncAlarm(a) && this.emit('alarms'), 0);
        }
      }
      this.persist('alarms');
      this.emit('alarms', { fired: a.id });
    } else if (base.startsWith('timer-')) {
      const x = this.timers.find((tm) => `timer-${tm.id}` === base);
      if (x && x.state === 'running') {
        x.state = 'done';
        x.doneAt = Date.now();
        this.persist('timers');
        this.emit('timers', { fired: x.id });
      }
    } else if (base.startsWith('focus-')) {
      this._focusCheck();
    }
  }

  // ================================================================== alarms
  alarmTitle(a) {
    return a.name || this.t('alarm.defaultName');
  }
  alarmTime(a) {
    return wallTime(a.hour, a.minute, { locale: this.locale, h12: this.h12 });
  }
  /**
   * When a ring snoozed from the notification is pending: its time, else null. The shell keeps a snoozed
   * repeating alarm as `alarm-<id>~snooze`, and re-registers a snoozed one-shot alarm (which turned itself
   * off when it rang) under `alarm-<id>`.
   */
  snoozedUntil(a, now = Date.now()) {
    const r = this.rem.get(`alarm-${a.id}~snooze`, APP) || (!a.enabled ? this.rem.get(`alarm-${a.id}`, APP) : null);
    return r && r.at > now ? r.at : null;
  }

  _syncAlarm(a) {
    const rid = `alarm-${a.id}`;
    if (!a.enabled) {
      a.at = null;
      this.rem.remove(rid, APP);
      this.rem.remove(`${rid}~snooze`, APP);
      return false;
    }
    a.at = nextAlarmOccurrence(a, Date.now());
    if (!a.at) return false;
    try {
      this.rem.set({
        id: rid,
        appId: APP,
        kind: 'alarm',
        at: a.at,
        repeat: a.days.length ? { days: [...a.days] } : null,
        title: this.alarmTitle(a),
        body: this.alarmTime(a).full,
        snoozeMinutes: a.snooze,
        sound: toneById(a.sound).pattern || undefined,
        data: { alarmId: a.id },
      });
    } catch (err) {
      console.error('[clock] could not schedule alarm', err);
      this.emit('error', err);
      return false;
    }
    return true;
  }

  /** -> the new alarm, or null when there are already MAX_ALARMS */
  addAlarm(fields) {
    if (this.alarms.length >= MAX_ALARMS) return null;
    const a = cleanAlarm({ id: uid('a'), enabled: true, sound: this.prefs.sound, snooze: this.prefs.snooze, ...fields });
    this.alarms.push(a);
    this._syncAlarm(a);
    this.persist('alarms');
    this.emit('alarms', { added: a.id });
    return a;
  }

  updateAlarm(id, fields) {
    const i = this.alarms.findIndex((x) => x.id === id);
    if (i < 0) return null;
    const a = cleanAlarm({ ...this.alarms[i], ...fields, id });
    this.alarms[i] = a;
    this.rem.remove(`alarm-${id}~snooze`, APP);
    this._syncAlarm(a);
    this.persist('alarms');
    this.emit('alarms', { updated: id });
    return a;
  }

  setAlarmEnabled(id, on) {
    const a = this.alarms.find((x) => x.id === id);
    if (!a) return;
    a.enabled = !!on;
    if (!on) this.rem.remove(`alarm-${id}~snooze`, APP);
    this._syncAlarm(a);
    this.persist('alarms');
    this.emit('alarms', { toggled: id });
  }

  deleteAlarm(id) {
    const a = this.alarms.find((x) => x.id === id);
    if (!a) return;
    a.enabled = false;
    this._syncAlarm(a);
    this.alarms = this.alarms.filter((x) => x !== a);
    this.persist('alarms');
    this.emit('alarms', { deleted: id });
  }

  // ================================================================== timers
  timerTitle(x) {
    return x.name || durationName(this.t, x.duration);
  }
  remainingOf(x, now = Date.now()) {
    if (x.state === 'running') return Math.max(0, x.endAt - now);
    if (x.state === 'paused') return x.remaining;
    if (x.state === 'done') return 0;
    return x.duration;
  }
  progressOf(x, now = Date.now()) {
    if (x.state === 'idle') return 1;
    if (x.state === 'done') return 0;
    return Math.max(0, Math.min(1, this.remainingOf(x, now) / (x.runTotal || x.duration)));
  }

  _syncTimer(x) {
    const rid = `timer-${x.id}`;
    if (x.state !== 'running') {
      this.rem.remove(rid, APP);
      return;
    }
    try {
      this.rem.set({
        id: rid,
        appId: APP,
        kind: 'alarm',
        at: x.endAt,
        repeat: null,
        title: this.timerTitle(x),
        body: this.t('timer.doneBody'),
        snoozeMinutes: 0,
        sound: toneById(this.prefs.timerSound).pattern || undefined,
        data: { timerId: x.id },
      });
    } catch (err) {
      console.error('[clock] could not schedule timer', err);
      this.emit('error', err);
    }
  }

  /** -> the new timer, or null when there are already MAX_TIMERS */
  addTimer({ name = '', duration }) {
    if (this.timers.length >= MAX_TIMERS) return null;
    const x = cleanTimer({ id: uid('t'), name, duration });
    this.timers.push(x);
    this.persist('timers');
    this.emit('timers', { added: x.id });
    return x;
  }

  updateTimer(id, { name, duration }) {
    const x = this.timers.find((tm) => tm.id === id);
    if (!x) return null;
    if (typeof name === 'string') x.name = name.slice(0, 64);
    if (Number.isFinite(duration) && duration >= 1000 && duration !== x.duration) {
      x.duration = Math.min(duration, 100 * 3600 * 1000 - 1000);
      if (x.state !== 'running') {
        // a new length resets a paused / finished timer
        x.state = 'idle';
        x.remaining = x.duration;
        x.runTotal = x.duration;
      }
    }
    this._syncTimer(x);
    this.persist('timers');
    this.emit('timers', { updated: id });
    return x;
  }

  startTimer(id, now = Date.now()) {
    const x = this.timers.find((tm) => tm.id === id);
    if (!x || x.state === 'running') return;
    if (x.state === 'paused') x.endAt = now + x.remaining;
    else {
      if (x.state === 'done') this.rem.stopRinging?.();
      x.runTotal = x.duration;
      x.endAt = now + x.duration;
    }
    x.state = 'running';
    x.doneAt = null;
    this._syncTimer(x);
    this.persist('timers');
    this.emit('timers', { started: id });
  }

  pauseTimer(id, now = Date.now()) {
    const x = this.timers.find((tm) => tm.id === id);
    if (!x || x.state !== 'running') return;
    x.remaining = Math.max(0, x.endAt - now);
    x.state = x.remaining > 0 ? 'paused' : 'done';
    this._syncTimer(x);
    this.persist('timers');
    this.emit('timers', { paused: id });
  }

  resetTimer(id) {
    const x = this.timers.find((tm) => tm.id === id);
    if (!x) return;
    if (x.state === 'done') this.rem.stopRinging?.();
    x.state = 'idle';
    x.remaining = x.duration;
    x.runTotal = x.duration;
    x.endAt = null;
    x.doneAt = null;
    this._syncTimer(x);
    this.persist('timers');
    this.emit('timers', { reset: id });
  }

  addMinute(id, now = Date.now()) {
    const x = this.timers.find((tm) => tm.id === id);
    if (!x) return;
    if (x.state === 'running') {
      x.endAt += MIN;
      x.runTotal += MIN;
    } else if (x.state === 'paused') {
      x.remaining += MIN;
      x.runTotal += MIN;
    } else if (x.state === 'done') {
      this.rem.stopRinging?.();
      x.state = 'running';
      x.runTotal = MIN;
      x.endAt = now + MIN;
      x.doneAt = null;
    } else {
      x.duration = Math.min(x.duration + MIN, 100 * 3600 * 1000 - 1000);
      x.remaining = x.duration;
      x.runTotal = x.duration;
    }
    this._syncTimer(x);
    this.persist('timers');
    this.emit('timers', { plus: id });
  }

  deleteTimer(id) {
    const x = this.timers.find((tm) => tm.id === id);
    if (!x) return;
    if (x.state === 'done') this.rem.stopRinging?.();
    x.state = 'idle';
    this._syncTimer(x);
    this.timers = this.timers.filter((tm) => tm !== x);
    this.persist('timers');
    this.emit('timers', { deleted: id });
  }

  /** UI tick: a running timer whose end passed (the reminder fires at the same moment) shows as done. */
  tickTimers(now = Date.now()) {
    let changed = false;
    for (const x of this.timers) {
      if (x.state === 'running' && x.endAt <= now - 1500) {
        // the shell scheduler normally reports this through 'fire'; this is only a safety net
        x.state = 'done';
        x.doneAt = x.endAt;
        changed = true;
      }
    }
    if (changed) {
      this.persist('timers');
      this.emit('timers');
    }
  }

  // ================================================================== stopwatch
  swElapsed(now = Date.now()) {
    const s = this.stopwatch;
    return s.base + (s.running ? Math.max(0, now - s.startedAt) : 0);
  }
  swStart(now = Date.now()) {
    const s = this.stopwatch;
    if (s.running) return;
    s.running = true;
    s.startedAt = now;
    this.persist('stopwatch');
    this.emit('stopwatch');
  }
  swPause(now = Date.now()) {
    const s = this.stopwatch;
    if (!s.running) return;
    s.base = this.swElapsed(now);
    s.running = false;
    this.persist('stopwatch');
    this.emit('stopwatch');
  }
  swToggle(now = Date.now()) {
    if (this.stopwatch.running) this.swPause(now);
    else this.swStart(now);
  }
  swLap(now = Date.now()) {
    const s = this.stopwatch;
    if (!s.running) return false;
    s.laps.push(this.swElapsed(now));
    this.persist('stopwatch');
    this.emit('stopwatch', { lap: s.laps.length });
    return true;
  }
  swReset() {
    this.stopwatch = cleanStopwatch(null);
    this.persist('stopwatch');
    this.emit('stopwatch', { reset: true });
  }

  // ================================================================== world clock
  addCity(id) {
    if (this.cities.includes(id) || this.cities.length >= 60) return false;
    this.cities.push(id);
    this.persist('cities');
    this.emit('cities', { added: id });
    return true;
  }
  removeCity(id) {
    this.cities = this.cities.filter((c) => c !== id);
    this.persist('cities');
    this.emit('cities', { removed: id });
  }
  moveCity(id, to) {
    const from = this.cities.indexOf(id);
    if (from < 0) return;
    to = Math.max(0, Math.min(this.cities.length - 1, to));
    if (to === from) return;
    this.cities.splice(from, 1);
    this.cities.splice(to, 0, id);
    this.persist('cities');
    this.emit('cities', { moved: id });
  }

  // ================================================================== focus sessions
  focusTotal(s = this.focus.session) {
    return s ? s.segs.reduce((n, g) => n + g.ms, 0) : 0;
  }
  focusElapsed(now = Date.now(), s = this.focus.session) {
    if (!s) return 0;
    const ref = s.state === 'paused' ? s.pausedAt : now;
    return Math.max(0, Math.min(this.focusTotal(s), ref - s.startedAt - s.pausedTotal));
  }
  /** Where the session is: { index, seg, offset, left, focusDone (ms), total, elapsed, periods, period } */
  focusPhase(now = Date.now()) {
    const s = this.focus.session;
    if (!s) return null;
    const elapsed = this.focusElapsed(now);
    let acc = 0;
    let focusDone = 0;
    let period = 0;
    const periods = s.segs.filter((g) => g.type === 'focus').length;
    for (let i = 0; i < s.segs.length; i++) {
      const g = s.segs[i];
      if (g.type === 'focus') period++;
      if (elapsed < acc + g.ms || i === s.segs.length - 1) {
        const offset = Math.min(g.ms, elapsed - acc);
        if (g.type === 'focus') focusDone += offset;
        return { index: i, seg: g, offset, left: g.ms - offset, focusDone, total: this.focusTotal(), elapsed, periods, period, breaks: s.segs.length - periods };
      }
      if (g.type === 'focus') focusDone += g.ms;
      acc += g.ms;
    }
    return null;
  }
  focusEndsAt(now = Date.now()) {
    const s = this.focus.session;
    if (!s) return null;
    return now + (this.focusTotal() - this.focusElapsed(now));
  }
  focusStatus(now = Date.now()) {
    const s = this.focus.session;
    if (!s) return { active: false, state: null, phase: null, phaseEndsAt: null, endsAt: null, startedAt: null, minutes: 0, breaks: 0, updatedAt: now };
    const p = this.focusPhase(now);
    return {
      active: true,
      state: s.state,
      phase: p?.seg.type || 'focus',
      phaseEndsAt: s.state === 'running' && p ? now + p.left : null,
      endsAt: s.state === 'running' ? this.focusEndsAt(now) : null,
      startedAt: s.startedAt,
      minutes: s.minutes,
      breaks: s.segs.filter((g) => g.type === 'break').length,
      updatedAt: now,
    };
  }

  /** Session time elapsed (pauses excluded) at wall-clock moment t. */
  _elapsedAt(t, s = this.focus.session) {
    if (!s) return 0;
    let paused = 0;
    for (const [a, b] of s.pauses || []) if (a < t) paused += Math.min(b, t) - a;
    // pauses recorded before `pauses` existed are only known as a total: count them from the start
    paused += Math.max(0, s.pausedTotal - (s.pauses || []).reduce((n, [a, b]) => n + (b - a), 0));
    if (s.state === 'paused' && s.pausedAt != null && s.pausedAt < t) paused += t - s.pausedAt;
    return Math.max(0, Math.min(this.focusTotal(s), t - s.startedAt - paused));
  }
  /** Focus (not break) milliseconds contained in the first `elapsed` ms of a session plan. */
  _focusIn(elapsed, s = this.focus.session) {
    let acc = 0;
    let done = 0;
    for (const g of s?.segs || []) {
      if (elapsed <= acc) break;
      if (g.type === 'focus') done += Math.min(g.ms, elapsed - acc);
      acc += g.ms;
    }
    return done;
  }
  /** Whole focus minutes done by moment t (rounded the same way for every day boundary). */
  _focusMinAt(t, s = this.focus.session, round = Math.floor) {
    return round(this._focusIn(this._elapsedAt(t, s), s) / MIN);
  }
  /** { 'YYYY-MM-DD': minutes } of a session between its start and `end`, split at local midnight. */
  _focusByDay(s, end, round = Math.floor) {
    const out = {};
    let from = s.startedAt;
    let prev = 0;
    while (from < end) {
      const d = new Date(from);
      const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
      const to = Math.min(next, end);
      const cum = this._focusMinAt(to, s, round);
      if (cum > prev) out[dayKey(from)] = (out[dayKey(from)] || 0) + cum - prev;
      prev = cum;
      from = to;
    }
    return out;
  }

  todayMinutes(now = Date.now()) {
    const today = dayKey(now);
    let m = this.focus.history[today] || 0;
    const s = this.focus.session;
    if (s) m += this._focusByDay(s, now)[today] || 0;
    return m;
  }
  dayMinutes(key) {
    return this.focus.history[key] || 0;
  }
  streak(now = Date.now()) {
    const goal = this.prefs.focus.goal;
    let key = dayKey(now);
    let n = 0;
    if (this.todayMinutes(now) >= goal) n = 1;
    key = addDays(key, -1);
    for (let i = 0; i < 3650; i++) {
      if ((this.focus.history[key] || 0) >= goal) n++;
      else break;
      key = addDays(key, -1);
    }
    return n;
  }

  async startFocus({ minutes, skipBreaks, dnd } = {}, now = Date.now()) {
    if (this.focus.session || this._focusStarting) return;
    this._focusStarting = true;
    try {
      await this._startFocus({ minutes, skipBreaks, dnd }, now);
    } finally {
      this._focusStarting = false;
    }
  }

  async _startFocus({ minutes, skipBreaks, dnd }, now) {
    const f = this.prefs.focus;
    minutes = Math.max(FOCUS_MIN, Math.min(FOCUS_MAX, Math.round(minutes || f.minutes)));
    const s = {
      id: uid('f'),
      minutes,
      segs: planSegments(minutes, f.chunk, f.brk, skipBreaks ?? f.skipBreaks),
      startedAt: now,
      state: 'running',
      pausedAt: null,
      pausedTotal: 0,
      pauses: [],
      dndChanged: false,
    };
    if (dnd && !this.settings.get('notifications.dnd')) {
      try {
        await this.settings.set('notifications.dnd', true);
        s.dndChanged = true;
      } catch (err) {
        console.error('[clock] could not turn on do not disturb', err);
      }
    }
    this.focus.session = s;
    this.focus.last = null;
    this._syncFocusReminders();
    this.persist('focus');
    this.emit('focus', { started: true });
  }

  pauseFocus(now = Date.now()) {
    const s = this.focus.session;
    if (!s || s.state !== 'running') return;
    s.state = 'paused';
    s.pausedAt = now;
    this._syncFocusReminders();
    this.persist('focus');
    this.emit('focus', { paused: true });
  }

  resumeFocus(now = Date.now()) {
    const s = this.focus.session;
    if (!s || s.state !== 'paused') return;
    s.pausedTotal += Math.max(0, now - s.pausedAt);
    s.pauses = [...(s.pauses || []), [s.pausedAt, Math.max(s.pausedAt, now)]].slice(-500);
    s.pausedAt = null;
    s.state = 'running';
    this._syncFocusReminders();
    this.persist('focus');
    this.emit('focus', { resumed: true });
  }

  /** End the current break now and go back to focus. */
  skipBreak(now = Date.now()) {
    const s = this.focus.session;
    const p = this.focusPhase(now);
    if (!s || !p || p.seg.type !== 'break') return;
    s.segs[p.index] = { type: 'break', ms: Math.max(1000, p.offset) };
    if (p.offset < 1000) s.segs.splice(p.index, 1);
    this._syncFocusReminders();
    this.persist('focus');
    this.emit('focus', { skipped: true });
  }

  async stopFocus({ completed = false } = {}, now = Date.now()) {
    const s = this.focus.session;
    if (!s) return;
    // a completed session ends exactly when its plan ends (even if the check ran a little later)
    const end = completed ? s.startedAt + s.pausedTotal + this.focusTotal(s) : now;
    const focusMin = this._focusMinAt(end, s, Math.round);
    // a session that runs past midnight counts on each day for the part done that day
    for (const [day, m] of Object.entries(this._focusByDay(s, end, Math.round))) this.focus.history[day] = (this.focus.history[day] || 0) + m;
    this.focus.log.push({ start: s.startedAt, end, focusMin, planned: s.minutes, completed });
    if (this.focus.log.length > 200) this.focus.log.splice(0, this.focus.log.length - 200);
    this.focus.last = { completed, focusMin, endedAt: now, seen: false };
    this.focus.session = null;
    this._syncFocusReminders();
    if (s.dndChanged) await this._restoreDnd();
    this.persist('focus');
    this.emit('focus', { ended: true, completed });
  }

  dismissFocusSummary() {
    if (!this.focus.last) return;
    this.focus.last.seen = true;
    this.persist('focus');
    this.emit('focus');
  }

  async _restoreDnd() {
    try {
      // The shell's Focus mode (core/features/focus.js) started while this session had Do not disturb on:
      // it saved that "on" as the value to put back when it ends. Leave Do not disturb on for Focus mode
      // and hand it the value from before this session instead, or DND would go off under Focus mode now
      // and stay on for good once Focus mode ends.
      const fm = this.settings.get('focusMode');
      if (fm?.active && fm.prevDnd != null) {
        if (fm.prevDnd !== false) await this.settings.set('focusMode.prevDnd', false);
        return;
      }
      if (this.settings.get('notifications.dnd')) await this.settings.set('notifications.dnd', false);
    } catch (err) {
      console.error('[clock] could not restore do not disturb', err);
    }
  }

  _focusReminderIds() {
    return this.rem.list(APP).filter((r) => r.id.startsWith('focus-')).map((r) => r.id);
  }

  _syncFocusReminders(now = Date.now()) {
    for (const id of this._focusReminderIds()) this.rem.remove(id, APP);
    for (const t of this.focusTimers) clearTimeout(t);
    this.focusTimers = [];
    const s = this.focus.session;
    if (!s || s.state !== 'running') return;
    const t = this.t;
    let at = s.startedAt + s.pausedTotal;
    s.segs.forEach((g, i) => {
      at += g.ms;
      if (at <= now) return;
      const last = i === s.segs.length - 1;
      const next = s.segs[i + 1];
      const r = last
        ? { id: 'focus-end', title: t('focus.doneTitle'), body: t('focus.doneBody', { time: this._minText(s.segs.filter((x) => x.type === 'focus').reduce((n, x) => n + x.ms, 0) / MIN) }) }
        : next.type === 'break'
          ? { id: `focus-${i + 1}`, title: t('focus.breakTitle'), body: t('focus.breakBody', { n: Math.round(next.ms / MIN) }) }
          : { id: `focus-${i + 1}`, title: t('focus.backTitle'), body: t('focus.backBody') };
      try {
        this.rem.set({ ...r, appId: APP, at, kind: 'reminder', repeat: null, snoozeMinutes: 0, data: { focus: s.id } });
      } catch (err) {
        console.error('[clock] could not schedule focus reminder', err);
      }
      // While the shell runs: play the focus cue when do not disturb hides the toast, and switch the
      // phase on time; turn do not disturb back off just before the end so "session complete" shows.
      const wait = at - now;
      this.focusTimers.push(setTimeout(() => this._focusBoundary(last), wait + 30));
      if (last && s.dndChanged) this.focusTimers.push(setTimeout(() => this.focus.session === s && this._restoreDnd(), Math.max(0, wait - 1500)));
    });
  }

  _minText(m) {
    m = Math.round(m);
    const h = Math.floor(m / 60);
    const r = m % 60;
    if (h && r) return this.t('units.hMin', { h, m: r });
    if (h) return this.t('units.hOnly', { h });
    return this.t('units.mOnly', { m: r });
  }

  _focusBoundary() {
    if (!this.focus.session || this.focus.session.state !== 'running') return;
    if (this.prefs.focus.sound && this.settings.get('notifications.dnd')) this.shell.sounds?.play?.(FOCUS_CUE);
    this._focusCheck();
  }

  _focusCheck(now = Date.now()) {
    const s = this.focus.session;
    if (!s) return;
    if (s.state === 'running' && this.focusElapsed(now) >= this.focusTotal(s) - 50) this.stopFocus({ completed: true }, now);
    else {
      this.persist('focus');
      this.emit('focus', { phase: true });
    }
  }

  _reconcileFocus(now = Date.now()) {
    const s = this.focus.session;
    if (!s) {
      // leftovers of a session that no longer exists (deleted / corrupt storage) must not ring
      for (const id of this._focusReminderIds()) this.rem.remove(id, APP);
      return;
    }
    if (s.state === 'running' && this.focusElapsed(now) >= this.focusTotal(s)) {
      this.stopFocus({ completed: true }, s.startedAt + s.pausedTotal + this.focusTotal(s));
      return;
    }
    this._syncFocusReminders(now);
  }
}
