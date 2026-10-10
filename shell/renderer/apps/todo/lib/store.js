// To Do data model: schema + migrations, normalisation, mutations, persistence (debounced, through
// ctx.storage 'data'), and the reminder plan used to keep shell.reminders in sync. No DOM here.
//
//   const store = new TodoStore({ load, save, now, weekStart });  await store.init(seedFn)
//   store.data = { version, lists, groups, tasks, views, prefs }
//   store.on((kind, info) => …)   kinds: 'tasks' | 'lists' | 'prefs' | 'views' | 'save-error' | 'saved'
//
// Task:  { id, listId, title, done, completedAt, important, myDay ('YYYY-MM-DD' | null), myDayAt, myDayOrder,
//          due ('YYYY-MM-DD' | null), remindAt (ms | null), repeat (see dates.js | null), steps: [{ id, title, done }],
//          note, created, modified, order, spawnedId?, seed? }
// List:  { id, name, emoji, theme: { color, bg }, created, order, groupId, seed? }   ('tasks' is the built-in default list)
// Group: { id, name, collapsed, order }
import * as D from './dates.js';

export const SCHEMA = 2;
export const DEFAULT_LIST = 'tasks';
export const SMART_VIEWS = ['myday', 'important', 'planned', 'assigned', 'all', 'completed'];
export const COLORS = ['accent', 'blue', 'purple', 'rose', 'red', 'orange', 'green', 'teal', 'slate'];
export const BACKGROUNDS = ['dawn', 'ocean', 'forest', 'dusk', 'aurora', 'sunset', 'mist', 'night'];
export const SORTS = ['importance', 'due', 'myDay', 'alpha', 'created'];
export const DEFAULT_THEMES = {
  myday: { color: 'accent', bg: 'dawn' },
  important: { color: 'rose', bg: null },
  planned: { color: 'teal', bg: null },
  assigned: { color: 'green', bg: null },
  all: { color: 'slate', bg: null },
  completed: { color: 'purple', bg: null },
  tasks: { color: 'accent', bg: null },
};
export const DEFAULT_PREFS = {
  sound: true,
  confirmDelete: true,
  addOnTop: true,
  starToTop: true,
  dueTodayInMyDay: false,
  smart: { important: true, planned: true, assigned: false, all: true, completed: true },
  autoHideEmpty: false,
  seedBanner: true,
  lastView: 'myday',
};

const MAX_TITLE = 400;
const MAX_NOTE = 20000;
const str = (v, max = MAX_TITLE) => (typeof v === 'string' ? v : v == null ? '' : String(v)).replace(/[\r\n]+/g, ' ').slice(0, max);
const num = (v, def = null) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : def);
const bool = (v) => v === true;

let idSeq = 0;
export function uid(prefix = '') {
  idSeq = (idSeq + 1) % 1296;
  return `${prefix}${Date.now().toString(36)}${idSeq.toString(36).padStart(2, '0')}${Math.random().toString(36).slice(2, 6)}`;
}

// ------------------------------------------------------------------ emoji prefix of list names
const PICTO = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
/** "🛒 Groceries" -> { emoji: '🛒', name: 'Groceries' } (like Microsoft To Do: a leading emoji becomes the list icon). */
export function splitEmoji(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { emoji: null, name: '' };
  let first = s;
  try {
    first = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)[Symbol.iterator]().next().value?.segment || s;
  } catch {
    first = [...s][0];
  }
  if (PICTO.test(first)) return { emoji: first, name: s.slice(first.length).trim() };
  return { emoji: null, name: s };
}

// ------------------------------------------------------------------ migrations
// v0: prototype format (no version): a bare array of tasks, or { tasks, lists } with `text` titles.
// v1: { version: 1, lists, tasks } where tasks had `dueDate` (epoch ms), `reminder` (epoch ms), `steps` as
//     strings or { text, checked }, `inMyDay` boolean + `myDayDate`, `completed` boolean, `starred`.
// v2: current (see header).
const MIGRATIONS = {
  0(d) {
    const tasks = Array.isArray(d) ? d : Array.isArray(d?.tasks) ? d.tasks : [];
    return {
      version: 1,
      lists: Array.isArray(d?.lists) ? d.lists : [],
      tasks: tasks.map((t) => ({ ...t, title: t?.title ?? t?.text ?? '' })),
    };
  },
  1(d) {
    const tasks = (Array.isArray(d.tasks) ? d.tasks : []).map((t) => {
      if (!t || typeof t !== 'object') return t;
      const out = { ...t };
      if (out.due == null && Number.isFinite(t.dueDate)) out.due = D.ymd(t.dueDate);
      if (out.remindAt == null && Number.isFinite(t.reminder)) out.remindAt = t.reminder;
      if (out.done == null && typeof t.completed === 'boolean') out.done = t.completed;
      if (out.important == null && typeof t.starred === 'boolean') out.important = t.starred;
      if (out.myDay == null && t.inMyDay && t.myDayDate) out.myDay = D.ymd(t.myDayDate);
      if (Array.isArray(t.steps)) out.steps = t.steps.map((s) => (typeof s === 'string' ? { title: s, done: false } : { ...s, title: s?.title ?? s?.text, done: s?.done ?? !!s?.checked }));
      for (const k of ['dueDate', 'reminder', 'completed', 'starred', 'inMyDay', 'myDayDate']) delete out[k];
      return out;
    });
    return { ...d, version: 2, tasks, groups: Array.isArray(d.groups) ? d.groups : [] };
  },
};

export function migrate(raw) {
  let d = raw;
  let v = d && typeof d === 'object' && !Array.isArray(d) && Number.isInteger(d.version) ? d.version : 0;
  let guard = 0;
  while (v < SCHEMA && MIGRATIONS[v] && guard++ < 10) {
    d = MIGRATIONS[v](d);
    v = d.version;
  }
  return d;
}

function normTheme(th, def) {
  const color = COLORS.includes(th?.color) ? th.color : def?.color || 'accent';
  const bg = BACKGROUNDS.includes(th?.bg) ? th.bg : th && 'bg' in th ? null : def?.bg || null;
  return { color, bg };
}

function normSort(s) {
  if (!s || !SORTS.includes(s.by)) return null;
  return { by: s.by, dir: s.dir === 'desc' ? 'desc' : 'asc' };
}

/** Fill defaults, drop invalid records, keep unknown fields (forward compatibility). */
export function normalize(raw, now = Date.now()) {
  const d = raw && typeof raw === 'object' ? raw : {};
  const out = { ...d, version: SCHEMA };
  const seen = new Set();
  const groups = [];
  for (const g of Array.isArray(d.groups) ? d.groups : []) {
    if (!g || typeof g !== 'object') continue;
    const id = str(g.id, 64) || uid('g');
    if (seen.has(id)) continue;
    seen.add(id);
    groups.push({ ...g, id, name: str(g.name, 255) || 'Group', collapsed: bool(g.collapsed), order: num(g.order, groups.length) });
  }
  out.groups = groups;
  const groupIds = new Set(groups.map((g) => g.id));
  const lists = [];
  for (const l of Array.isArray(d.lists) ? d.lists : []) {
    if (!l || typeof l !== 'object') continue;
    const id = str(l.id, 64) || uid('l');
    if (seen.has(id)) continue;
    seen.add(id);
    const isDefault = id === DEFAULT_LIST;
    lists.push({
      ...l,
      id,
      name: isDefault ? null : str(l.name, 255) || 'Untitled list',
      emoji: isDefault ? null : typeof l.emoji === 'string' && l.emoji ? l.emoji.slice(0, 16) : null,
      theme: normTheme(l.theme, isDefault ? DEFAULT_THEMES.tasks : null),
      created: num(l.created, now),
      order: num(l.order, lists.length),
      groupId: !isDefault && groupIds.has(l.groupId) ? l.groupId : null,
      sort: normSort(l.sort),
      groupBy: ['none', 'due'].includes(l.groupBy) ? l.groupBy : 'none',
      showCompleted: l.showCompleted !== false,
      completedOpen: l.completedOpen !== false,
    });
  }
  if (!lists.some((l) => l.id === DEFAULT_LIST)) {
    lists.unshift({ id: DEFAULT_LIST, name: null, emoji: null, theme: { ...DEFAULT_THEMES.tasks }, created: now, order: -1, groupId: null, sort: null, groupBy: 'none', showCompleted: true, completedOpen: true });
  }
  out.lists = lists;
  const listIds = new Set(lists.map((l) => l.id));
  const tasks = [];
  const taskIds = new Set();
  for (const t of Array.isArray(d.tasks) ? d.tasks : []) {
    if (!t || typeof t !== 'object') continue;
    const title = str(t.title).trim();
    if (!title) continue;
    let id = str(t.id, 64) || uid('t');
    if (taskIds.has(id)) id = uid('t');
    taskIds.add(id);
    const created = num(t.created, now);
    const done = bool(t.done);
    tasks.push({
      ...t,
      id,
      listId: listIds.has(t.listId) ? t.listId : DEFAULT_LIST,
      title,
      done,
      completedAt: done ? num(t.completedAt, now) : null,
      important: bool(t.important),
      myDay: D.isYmd(t.myDay) ? t.myDay : null,
      myDayAt: num(t.myDayAt, null),
      myDayOrder: num(t.myDayOrder, 0),
      due: D.isYmd(t.due) ? t.due : null,
      remindAt: num(t.remindAt, null),
      repeat: D.normalizeRepeat(t.repeat),
      steps: (Array.isArray(t.steps) ? t.steps : [])
        .filter((s) => s && typeof s === 'object' && str(s.title).trim())
        .slice(0, 200)
        .map((s) => ({ id: str(s.id, 64) || uid('s'), title: str(s.title).trim(), done: bool(s.done) })),
      note: typeof t.note === 'string' ? t.note.slice(0, MAX_NOTE) : '',
      created,
      modified: num(t.modified, created),
      order: num(t.order, tasks.length),
    });
  }
  out.tasks = tasks;
  const views = {};
  const rawViews = d.views && typeof d.views === 'object' ? d.views : {};
  for (const v of SMART_VIEWS) {
    const rv = rawViews[v] && typeof rawViews[v] === 'object' ? rawViews[v] : {};
    views[v] = {
      ...rv,
      theme: normTheme(rv.theme, DEFAULT_THEMES[v]),
      sort: normSort(rv.sort),
      groupBy: ['none', 'list'].includes(rv.groupBy) ? rv.groupBy : v === 'all' || v === 'completed' ? 'list' : 'none',
      showCompleted: typeof rv.showCompleted === 'boolean' ? rv.showCompleted : v === 'myday' || v === 'important',
      completedOpen: rv.completedOpen !== false,
    };
  }
  out.views = views;
  const p = d.prefs && typeof d.prefs === 'object' ? d.prefs : {};
  out.prefs = { ...DEFAULT_PREFS, ...p, smart: { ...DEFAULT_PREFS.smart, ...(p.smart && typeof p.smart === 'object' ? p.smart : {}) } };
  for (const k of ['sound', 'confirmDelete', 'addOnTop', 'starToTop', 'dueTodayInMyDay', 'autoHideEmpty', 'seedBanner']) {
    if (typeof out.prefs[k] !== 'boolean') out.prefs[k] = DEFAULT_PREFS[k];
  }
  return out;
}

// ------------------------------------------------------------------ queries (pure)
export function inMyDay(t, today, prefs) {
  return t.myDay === today || (!!prefs?.dueTodayInMyDay && !t.done && t.due === today);
}

/** Tasks of a view before sorting: { open, done } (done = completed tasks shown in the Completed section). */
export function viewTasks(data, view, now = Date.now()) {
  const today = D.ymd(now);
  const all = data.tasks;
  let pick;
  if (view === 'myday') pick = (t) => inMyDay(t, today, data.prefs);
  else if (view === 'important') pick = (t) => t.important;
  else if (view === 'planned') pick = (t) => !!t.due || Number.isFinite(t.remindAt);
  else if (view === 'assigned') pick = () => false;
  else if (view === 'all') pick = () => true;
  else if (view === 'completed') return { open: [], done: all.filter((t) => t.done) };
  else if (view?.startsWith('list:')) {
    const id = view.slice(5);
    pick = (t) => t.listId === id;
  } else pick = () => false;
  const open = [];
  const done = [];
  for (const t of all) if (pick(t)) (t.done ? done : open).push(t);
  return { open, done };
}

const byNum = (k) => (a, b) => (a[k] ?? 0) - (b[k] ?? 0);

/** Sort open tasks. sort = { by, dir } | null (manual order). */
export function sortTasks(tasks, sort, { view, starToTop = true, locale } = {}) {
  const manual = view === 'myday' ? (a, b) => a.myDayOrder - b.myDayOrder || (b.myDayAt ?? 0) - (a.myDayAt ?? 0) : byNum('order');
  const arr = [...tasks];
  if (!sort) {
    arr.sort(manual);
    if (starToTop) arr.sort((a, b) => Number(b.important) - Number(a.important));
    return arr;
  }
  const coll = new Intl.Collator(locale || undefined, { sensitivity: 'base', numeric: true });
  const cmp = {
    importance: (a, b) => Number(b.important) - Number(a.important),
    due: (a, b) => (a.due ? (b.due ? (a.due < b.due ? -1 : a.due > b.due ? 1 : 0) : -1) : b.due ? 1 : 0),
    myDay: (a, b) => (b.myDayAt ?? -Infinity) - (a.myDayAt ?? -Infinity) || 0,
    alpha: (a, b) => coll.compare(a.title, b.title),
    created: (a, b) => b.created - a.created,
  }[sort.by];
  arr.sort(manual);
  arr.sort((a, b) => {
    const c = cmp(a, b);
    return sort.dir === 'desc' ? -c : c;
  });
  return arr;
}

export function sortDone(tasks) {
  return [...tasks].sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
}

/** Planned view: [{ key, tasks }] for the non-empty buckets in order. */
export function plannedGroups(tasks, now = Date.now(), weekStart = 0) {
  const map = new Map(D.PLANNED_BUCKETS.map((k) => [k, []]));
  for (const t of tasks) {
    const day = t.due || (Number.isFinite(t.remindAt) ? D.ymd(t.remindAt) : null);
    if (!day) continue;
    map.get(D.plannedBucket(day, now, weekStart)).push(t);
  }
  const keyOf = (t) => t.due || D.ymd(t.remindAt);
  return D.PLANNED_BUCKETS.filter((k) => map.get(k).length).map((k) => ({
    key: k,
    tasks: map.get(k).sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : (a.remindAt ?? 0) - (b.remindAt ?? 0) || a.order - b.order)),
  }));
}

/** Group tasks by list, keeping the nav order of lists. */
export function groupByList(tasks, lists) {
  const order = new Map(orderedLists(lists).map((l, i) => [l.id, i]));
  const map = new Map();
  for (const t of tasks) {
    if (!map.has(t.listId)) map.set(t.listId, []);
    map.get(t.listId).push(t);
  }
  return [...map.entries()].sort((a, b) => (order.get(a[0]) ?? 0) - (order.get(b[0]) ?? 0)).map(([key, ts]) => ({ key, tasks: ts }));
}

export function groupByDue(tasks, now, weekStart) {
  const groups = plannedGroups(tasks.filter((t) => t.due), now, weekStart);
  const none = tasks.filter((t) => !t.due);
  if (none.length) groups.push({ key: 'noDate', tasks: none });
  return groups;
}

/** Lists in nav order: the default list first, then by order. */
export function orderedLists(lists) {
  return [...lists].sort((a, b) => (a.id === DEFAULT_LIST ? -1 : b.id === DEFAULT_LIST ? 1 : a.order - b.order));
}

export function counts(data, now = Date.now()) {
  const out = {};
  for (const v of SMART_VIEWS) out[v] = v === 'completed' ? data.tasks.filter((t) => t.done).length : viewTasks(data, v, now).open.length;
  for (const l of data.lists) out[`list:${l.id}`] = 0;
  for (const t of data.tasks) if (!t.done) out[`list:${t.listId}`] = (out[`list:${t.listId}`] || 0) + 1;
  return out;
}

const fold = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** Search title, steps and note (accent / case insensitive). -> [{ task, where: 'title'|'step'|'note', text }] */
export function search(data, query) {
  const q = fold(String(query || '').trim());
  if (!q) return [];
  const out = [];
  for (const t of data.tasks) {
    if (fold(t.title).includes(q)) out.push({ task: t, where: 'title', text: t.title });
    else {
      const st = t.steps.find((s) => fold(s.title).includes(q));
      if (st) out.push({ task: t, where: 'step', text: st.title });
      else if (fold(t.note).includes(q)) out.push({ task: t, where: 'note', text: snippet(t.note, q) });
    }
  }
  return out;
}

function snippet(text, q) {
  const flat = text.replace(/\s+/g, ' ');
  const i = fold(flat).indexOf(q);
  if (i < 0) return flat.slice(0, 80);
  const start = Math.max(0, i - 30);
  return `${start > 0 ? '…' : ''}${flat.slice(start, i + q.length + 50)}${i + q.length + 50 < flat.length ? '…' : ''}`;
}

/** Ranges of `query` inside `text` (for highlighting), accent / case insensitive. */
export function matchRanges(text, query) {
  const q = fold(String(query || '').trim());
  if (!q) return [];
  // fold() keeps one char per base char only for precomposed strings; map positions through per-char folding
  const map = [];
  let folded = '';
  for (let i = 0; i < text.length; i++) {
    const f = fold(text[i]);
    for (let k = 0; k < f.length; k++) map.push(i);
    folded += f;
  }
  const out = [];
  let from = 0;
  for (;;) {
    const i = folded.indexOf(q, from);
    if (i < 0) break;
    out.push([map[i], map[i + q.length - 1] + 1]);
    from = i + q.length;
  }
  return out;
}

/** My Day suggestions: each task appears in the first matching section only. */
export function suggestions(data, now = Date.now()) {
  const today = D.ymd(now);
  const yesterday = D.addDays(today, -1);
  const soon = D.addDays(today, 7);
  const recentSince = now - 3 * D.DAY;
  const out = { yesterday: [], earlier: [], overdue: [], today: [], upcoming: [], recent: [] };
  for (const t of data.tasks) {
    if (t.done || inMyDay(t, today, data.prefs)) continue;
    if (t.myDay === yesterday) out.yesterday.push(t);
    else if (t.myDay && t.myDay < yesterday) out.earlier.push(t);
    else if (t.due && t.due < today) out.overdue.push(t);
    else if (t.due === today) out.today.push(t);
    else if (t.due && t.due <= soon) out.upcoming.push(t);
    else if (t.created >= recentSince) out.recent.push(t);
  }
  out.earlier.sort((a, b) => (a.myDay < b.myDay ? 1 : -1));
  out.overdue.sort((a, b) => (a.due < b.due ? -1 : 1));
  out.upcoming.sort((a, b) => (a.due < b.due ? -1 : 1));
  out.recent.sort((a, b) => b.created - a.created);
  out.recent = out.recent.slice(0, 10);
  return out;
}

/** Diff between the tasks' reminders and shell.reminders: { set: [task], remove: [reminderId] }.
 *  Existing reminders of valid tasks are kept (they may be snoozed: `at` differs); only their text is refreshed. */
export function reminderPlan(data, existing, now = Date.now(), { refreshText = null } = {}) {
  const byId = new Map(data.tasks.map((t) => [t.id, t]));
  const want = new Map();
  for (const t of data.tasks) if (!t.done && Number.isFinite(t.remindAt) && t.remindAt > now) want.set(`task-${t.id}`, t);
  const set = [];
  const remove = [];
  const have = new Set();
  for (const r of existing) {
    const m = /^task-(.+?)(~snooze)?$/.exec(r.id);
    const t = m ? byId.get(m[1]) : null;
    const valid = t && !t.done && Number.isFinite(t.remindAt);
    if (!valid) {
      remove.push(r.id);
      continue;
    }
    if (!m[2]) {
      have.add(r.id);
      if (refreshText && refreshText(t, r)) set.push(t);
    }
  }
  for (const [id, t] of want) if (!have.has(id)) set.push(t);
  return { set, remove };
}

// ------------------------------------------------------------------ store
export class TodoStore {
  constructor({ load, save, now = () => Date.now(), weekStart = 0, debounce = 200 } = {}) {
    this._load = load;
    this._save = save;
    this._now = now;
    this.weekStart = weekStart;
    this.debounce = debounce;
    this.subs = new Set();
    this.data = normalize({});
    this.firstRun = false;
    this.saveError = null;
    this._timer = null;
    this._pending = null;
  }

  now() {
    return this._now();
  }
  today() {
    return D.ymd(this.now());
  }

  async init(seed) {
    let raw = null;
    try {
      raw = await this._load();
    } catch (err) {
      this.loadError = err;
    }
    if (raw == null) {
      this.firstRun = true;
      this.data = normalize({}, this.now());
      seed?.(this);
      this._schedule();
    } else {
      const before = raw?.version;
      this.data = normalize(migrate(raw), this.now());
      if (before !== SCHEMA) this._schedule(); // write the migrated copy back
    }
    return this;
  }

  on(fn) {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }
  emit(kind, info) {
    for (const fn of [...this.subs]) {
      try {
        fn(kind, info);
      } catch (err) {
        console.error('[todo] listener failed', err);
      }
    }
  }
  commit(kind, info) {
    this._schedule();
    this.emit(kind, info);
  }
  _schedule() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), this.debounce);
  }
  async flush() {
    clearTimeout(this._timer);
    this._timer = null;
    const snapshot = JSON.parse(JSON.stringify(this.data));
    try {
      await this._save(snapshot);
      if (this.saveError) {
        this.saveError = null;
        this.emit('save-error', null);
      }
      this.emit('saved');
    } catch (err) {
      this.saveError = err?.message || String(err);
      this.emit('save-error', this.saveError);
    }
  }

  // ---------------------------------------------------------------- lookups
  task(id) {
    return this.data.tasks.find((t) => t.id === id) || null;
  }
  list(id) {
    return this.data.lists.find((l) => l.id === id) || null;
  }
  group(id) {
    return this.data.groups.find((g) => g.id === id) || null;
  }
  lists() {
    return orderedLists(this.data.lists);
  }
  userLists() {
    return this.lists().filter((l) => l.id !== DEFAULT_LIST);
  }
  viewPrefs(view) {
    if (view?.startsWith('list:')) return this.list(view.slice(5)) || {};
    return this.data.views[view] || {};
  }

  // ---------------------------------------------------------------- tasks
  addTask(fields = {}, { top = this.data.prefs.addOnTop } = {}) {
    const title = str(fields.title).trim();
    if (!title) return null;
    const now = this.now();
    const listId = this.list(fields.listId) ? fields.listId : DEFAULT_LIST;
    const siblings = this.data.tasks.filter((t) => t.listId === listId);
    const orders = siblings.map((t) => t.order);
    const order = siblings.length ? (top ? Math.min(...orders) - 1 : Math.max(...orders) + 1) : 0;
    const t = {
      id: uid('t'),
      listId,
      title,
      done: false,
      completedAt: null,
      important: !!fields.important,
      myDay: fields.myDay ? this.today() : null,
      myDayAt: fields.myDay ? now : null,
      myDayOrder: 0,
      due: D.isYmd(fields.due) ? fields.due : null,
      remindAt: Number.isFinite(fields.remindAt) ? fields.remindAt : null,
      repeat: D.normalizeRepeat(fields.repeat),
      steps: (fields.steps || []).map((s) => ({ id: uid('s'), title: str(s.title ?? s).trim(), done: !!s.done })).filter((s) => s.title),
      note: typeof fields.note === 'string' ? fields.note : '',
      created: now,
      modified: now,
      order,
    };
    if (t.myDay) t.myDayOrder = this._myDayEdge(top);
    if (t.repeat && !t.due) t.due = D.alignDue(this.today(), t.repeat, this.weekStart);
    if (fields.seed) t.seed = true;
    this.data.tasks.push(t);
    this.commit('tasks', { added: [t.id] });
    return t;
  }

  _myDayEdge(top) {
    const today = this.today();
    const o = this.data.tasks.filter((t) => t.myDay === today).map((t) => t.myDayOrder);
    if (!o.length) return 0;
    return top ? Math.min(...o) - 1 : Math.max(...o) + 1;
  }

  update(id, patch, { silent = false } = {}) {
    const t = this.task(id);
    if (!t) return null;
    const p = { ...patch };
    if ('title' in p) {
      p.title = str(p.title).trim();
      if (!p.title) delete p.title;
    }
    if ('note' in p) p.note = String(p.note ?? '').slice(0, MAX_NOTE);
    if ('due' in p && !D.isYmd(p.due)) p.due = null;
    if ('remindAt' in p && !Number.isFinite(p.remindAt)) p.remindAt = null;
    if ('repeat' in p) {
      p.repeat = D.normalizeRepeat(p.repeat);
      if (p.repeat && !(p.due ?? t.due)) p.due = D.alignDue(this.today(), p.repeat, this.weekStart);
    }
    if ('due' in p && !p.due && t.repeat && !('repeat' in p)) p.repeat = null; // no due date -> no repeat
    if ('myDay' in p) {
      const on = !!p.myDay;
      p.myDay = on ? this.today() : null;
      p.myDayAt = on ? this.now() : null;
      if (on && t.myDay !== this.today()) p.myDayOrder = this._myDayEdge(this.data.prefs.addOnTop);
    }
    Object.assign(t, p, { modified: this.now() });
    if (silent) this._schedule();
    else this.commit('tasks', { changed: [id] });
    return t;
  }

  /** Complete / uncomplete. Completing a repeating task creates its next instance. -> { task, next, removedNext } */
  setDone(id, done) {
    const t = this.task(id);
    if (!t || t.done === !!done) return { task: t, next: null };
    const now = this.now();
    t.done = !!done;
    t.completedAt = done ? now : null;
    t.modified = now;
    let next = null;
    let removedNext = null;
    if (done && t.repeat && !(t.spawnedId && this.task(t.spawnedId))) {
      const base = t.due || this.today();
      const due = D.nextDue(base, t.repeat, this.weekStart);
      if (due) {
        next = {
          ...JSON.parse(JSON.stringify(t)),
          id: uid('t'),
          done: false,
          completedAt: null,
          due,
          remindAt: Number.isFinite(t.remindAt) ? D.shiftReminder(t.remindAt, base, due) : null,
          myDay: null,
          myDayAt: null,
          steps: t.steps.map((s) => ({ ...s, id: uid('s'), done: false })),
          created: now,
          modified: now,
        };
        delete next.spawnedId;
        delete next.seed;
        t.spawnedId = next.id;
        this.data.tasks.push(next);
      }
    } else if (!done && t.spawnedId) {
      // unchecking right after completing: take back the untouched next instance
      const n = this.task(t.spawnedId);
      if (n && !n.done && n.modified === n.created) {
        this.data.tasks = this.data.tasks.filter((x) => x !== n);
        removedNext = n.id;
      }
      delete t.spawnedId;
    }
    this.commit('tasks', { changed: [id], added: next ? [next.id] : [], removed: removedNext ? [removedNext] : [] });
    return { task: t, next, removedNext };
  }

  remove(ids) {
    const set = new Set([].concat(ids));
    const removed = this.data.tasks.filter((t) => set.has(t.id)).map((t) => t.id);
    if (!removed.length) return [];
    this.data.tasks = this.data.tasks.filter((t) => !set.has(t.id));
    this.commit('tasks', { removed });
    return removed;
  }

  move(ids, listId) {
    if (!this.list(listId)) return [];
    const moved = [];
    let max = Math.max(-1, ...this.data.tasks.filter((t) => t.listId === listId).map((t) => t.order));
    let min = Math.min(1, ...this.data.tasks.filter((t) => t.listId === listId).map((t) => t.order));
    for (const id of [].concat(ids)) {
      const t = this.task(id);
      if (!t || t.listId === listId) continue;
      t.listId = listId;
      t.order = this.data.prefs.addOnTop ? --min : ++max;
      t.modified = this.now();
      moved.push(id);
    }
    if (moved.length) this.commit('tasks', { changed: moved });
    return moved;
  }

  copy(id, listId) {
    const t = this.task(id);
    if (!t || !this.list(listId)) return null;
    const c = this.addTask({ ...t, listId, myDay: false, steps: t.steps, remindAt: null }, { top: this.data.prefs.addOnTop });
    if (c && t.done) this.setDone(c.id, true);
    return c;
  }

  /** Manual reorder: `ids` is the full new order of the visible open tasks of a view. */
  reorder(ids, view) {
    const field = view === 'myday' ? 'myDayOrder' : 'order';
    ids.forEach((id, i) => {
      const t = this.task(id);
      if (t) t[field] = i;
    });
    this.commit('tasks', { reordered: ids });
  }

  setMyDay(ids, on) {
    const changed = [];
    for (const id of [].concat(ids)) {
      const t = this.task(id);
      if (!t) continue;
      const today = this.today();
      if (on && t.myDay !== today) {
        t.myDay = today;
        t.myDayAt = this.now();
        t.myDayOrder = this._myDayEdge(this.data.prefs.addOnTop);
      } else if (!on && t.myDay) {
        t.myDay = null;
        t.myDayAt = null;
      } else continue;
      t.modified = this.now();
      changed.push(id);
    }
    if (changed.length) this.commit('tasks', { changed });
    return changed;
  }

  // ---------------------------------------------------------------- steps
  addStep(taskId, title) {
    const t = this.task(taskId);
    const s = str(title).trim();
    if (!t || !s) return null;
    const step = { id: uid('s'), title: s, done: false };
    t.steps.push(step);
    t.modified = this.now();
    this.commit('tasks', { changed: [taskId] });
    return step;
  }
  updateStep(taskId, stepId, patch) {
    const t = this.task(taskId);
    const s = t?.steps.find((x) => x.id === stepId);
    if (!s) return null;
    if ('title' in patch) {
      const v = str(patch.title).trim();
      if (v) s.title = v;
    }
    if ('done' in patch) s.done = !!patch.done;
    t.modified = this.now();
    this.commit('tasks', { changed: [taskId] });
    return s;
  }
  removeStep(taskId, stepId) {
    const t = this.task(taskId);
    if (!t) return;
    t.steps = t.steps.filter((s) => s.id !== stepId);
    t.modified = this.now();
    this.commit('tasks', { changed: [taskId] });
  }
  moveStep(taskId, stepId, index) {
    const t = this.task(taskId);
    const i = t?.steps.findIndex((s) => s.id === stepId);
    if (i == null || i < 0) return;
    const [s] = t.steps.splice(i, 1);
    t.steps.splice(Math.max(0, Math.min(t.steps.length, index)), 0, s);
    t.modified = this.now();
    this.commit('tasks', { changed: [taskId] });
  }
  /** Turn a step into a task of the same list, placed right after its parent. */
  promoteStep(taskId, stepId) {
    const t = this.task(taskId);
    const s = t?.steps.find((x) => x.id === stepId);
    if (!s) return null;
    t.steps = t.steps.filter((x) => x !== s);
    const n = this.addTask({ title: s.title, listId: t.listId }, { top: false });
    if (n) {
      for (const x of this.data.tasks) if (x.listId === t.listId && x.order > t.order && x !== n) x.order += 1;
      n.order = t.order + 1;
      if (s.done) this.setDone(n.id, true);
    }
    this.commit('tasks', { changed: [taskId] });
    return n;
  }

  // ---------------------------------------------------------------- lists & groups
  /** Lists and groups share one ordering space (top-level entries of the nav are sorted together). */
  _nextOrder() {
    return Math.max(0, ...this.data.lists.map((l) => l.order), ...this.data.groups.map((g) => g.order)) + 1;
  }
  addList(rawName, { groupId = null, theme } = {}) {
    const { emoji, name } = splitEmoji(rawName);
    const order = this._nextOrder();
    const l = { id: uid('l'), name: str(name, 255) || 'Untitled list', emoji, theme: normTheme(theme, { color: 'accent' }), created: this.now(), order, groupId: this.group(groupId) ? groupId : null, sort: null, groupBy: 'none', showCompleted: true, completedOpen: true };
    this.data.lists.push(l);
    this.commit('lists', { added: l.id });
    return l;
  }
  renameList(id, rawName) {
    const l = this.list(id);
    if (!l || id === DEFAULT_LIST) return null;
    const { emoji, name } = splitEmoji(rawName);
    if (!name && !emoji) return l;
    l.emoji = emoji;
    l.name = str(name, 255) || l.name;
    this.commit('lists', { changed: id });
    return l;
  }
  setListEmoji(id, emoji) {
    const l = this.list(id);
    if (!l || id === DEFAULT_LIST) return;
    l.emoji = emoji || null;
    this.commit('lists', { changed: id });
  }
  setTheme(view, theme) {
    const target = view.startsWith('list:') ? this.list(view.slice(5)) : this.data.views[view];
    if (!target) return;
    target.theme = normTheme({ ...target.theme, ...theme }, target.theme);
    this.commit('lists', { changed: view });
  }
  setViewPref(view, patch) {
    const target = view.startsWith('list:') ? this.list(view.slice(5)) : this.data.views[view];
    if (!target) return;
    if ('sort' in patch) patch = { ...patch, sort: normSort(patch.sort) };
    Object.assign(target, patch);
    this.commit('views', { changed: view });
  }
  duplicateList(id, nameFor) {
    const src = this.list(id);
    if (!src) return null;
    const copy = this.addList(`${src.emoji ? `${src.emoji} ` : ''}${nameFor(src)}`, { groupId: src.groupId, theme: src.theme });
    // place right after the source
    for (const l of this.data.lists) if (l !== copy && l.order > src.order) l.order += 1;
    copy.order = src.order + 1;
    const open = this.data.tasks.filter((t) => t.listId === id && !t.done).sort(byNum('order'));
    for (const t of open) {
      this.data.tasks.push({
        ...JSON.parse(JSON.stringify(t)),
        id: uid('t'),
        listId: copy.id,
        remindAt: null,
        myDay: null,
        myDayAt: null,
        steps: t.steps.map((s) => ({ ...s, id: uid('s') })),
        created: this.now(),
        modified: this.now(),
        spawnedId: undefined,
        seed: undefined,
      });
    }
    this.commit('lists', { added: copy.id });
    return copy;
  }
  /** -> ids of the deleted tasks */
  deleteList(id) {
    if (id === DEFAULT_LIST || !this.list(id)) return [];
    const removed = this.data.tasks.filter((t) => t.listId === id).map((t) => t.id);
    this.data.tasks = this.data.tasks.filter((t) => t.listId !== id);
    this.data.lists = this.data.lists.filter((l) => l.id !== id);
    this.commit('lists', { removed: id, removedTasks: removed });
    return removed;
  }
  /** Reorder user lists: `ids` in their new order (and optional group per id). */
  reorderLists(ids, groupOf = {}) {
    ids.forEach((id, i) => {
      const l = this.list(id);
      if (!l || id === DEFAULT_LIST) return;
      l.order = i + 1;
      if (id in groupOf) l.groupId = this.group(groupOf[id]) ? groupOf[id] : null;
    });
    this.commit('lists', { reordered: ids });
  }
  addGroup(name) {
    const g = { id: uid('g'), name: str(name, 255) || 'Untitled group', collapsed: false, order: this._nextOrder() };
    this.data.groups.push(g);
    this.commit('lists', { addedGroup: g.id });
    return g;
  }
  renameGroup(id, name) {
    const g = this.group(id);
    const n = str(name, 255).trim();
    if (!g || !n) return;
    g.name = n;
    this.commit('lists', { changedGroup: id });
  }
  setGroupCollapsed(id, collapsed) {
    const g = this.group(id);
    if (!g) return;
    g.collapsed = !!collapsed;
    this.commit('lists', { changedGroup: id });
  }
  /** Remove a group; its lists stay (moved out of the group). */
  ungroup(id) {
    if (!this.group(id)) return;
    for (const l of this.data.lists) if (l.groupId === id) l.groupId = null;
    this.data.groups = this.data.groups.filter((g) => g.id !== id);
    this.commit('lists', { removedGroup: id });
  }
  moveListToGroup(listId, groupId) {
    const l = this.list(listId);
    if (!l || listId === DEFAULT_LIST) return;
    l.groupId = this.group(groupId) ? groupId : null;
    l.order = this._nextOrder();
    this.commit('lists', { changed: listId });
  }

  // ---------------------------------------------------------------- prefs / seed
  setPref(key, value) {
    if (key.startsWith('smart.')) this.data.prefs.smart[key.slice(6)] = !!value;
    else this.data.prefs[key] = value;
    this.commit('prefs', { key });
  }
  hasSeed() {
    return this.data.tasks.some((t) => t.seed) || this.data.lists.some((l) => l.seed);
  }
  /** Remove the example tasks (and example lists left empty). -> removed task ids */
  removeSeed() {
    const removed = this.data.tasks.filter((t) => t.seed).map((t) => t.id);
    this.data.tasks = this.data.tasks.filter((t) => !t.seed);
    const used = new Set(this.data.tasks.map((t) => t.listId));
    this.data.lists = this.data.lists.filter((l) => !l.seed || used.has(l.id));
    for (const l of this.data.lists) delete l.seed;
    this.data.prefs.seedBanner = false;
    this.commit('lists', { removedTasks: removed });
    return removed;
  }
}
