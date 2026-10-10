// To Do window: layout (nav | main | detail / suggestions), view routing, selection, task actions shared by
// every pane (complete with animation + chime, star, My Day, move, delete, reminders), list actions,
// keyboard shortcuts, relaunch arguments (notification clicks) and the shell.reminders synchronisation.
//
// Views: 'myday' 'important' 'planned' 'assigned' 'all' 'completed' 'list:<id>' 'search' 'settings'.
// Test / automation hook: the window element exposes this object as `el.__todo`.
import * as D from '../lib/dates.js';
import { TodoStore, DEFAULT_LIST, DEFAULT_THEMES, reminderPlan, viewTasks, splitEmoji } from '../lib/store.js';
import { seed } from '../lib/seed.js';
import { Fmt } from './fmt.js';
import { Nav } from './nav.js';
import { ListView } from './listview.js';
import { Detail } from './detail.js';
import { Suggest } from './suggest.js';
import { SettingsView } from './settings.js';
import { pickDate, pickDateTime, customRepeat, themePicker, emojiPicker, shortcutsHelp, closePopover, popoverOpen } from './pickers.js';
import { isDragging } from './drag.js';

const CHIME = [
  { freq: 1318.5, dur: 0.11, gain: 0.07, type: 'sine' },
  { freq: 1975.5, start: 0.075, dur: 0.42, gain: 0.06, type: 'sine' },
  { freq: 2637, start: 0.075, dur: 0.18, gain: 0.015, type: 'sine' },
];
export const SMART_ICONS = { myday: 'weather_sunny', important: 'star', planned: 'calendar_ltr', assigned: 'person', all: 'infinity', completed: 'checkmark_circle', 'list:tasks': 'home' };
// One store for every To Do window (a second window opened with "newWindow" must not keep its own copy of
// the data and overwrite the first one's changes): created by the first window, dropped with the last one.
let shared = null; // { ready: Promise<TodoStore>, refs }
const NARROW = 720;
const DOCK = 1060;
const COMPLETE_DELAY = 420;

export class TodoApp {
  constructor(ctx) {
    this.ctx = ctx;
    this.h = ctx.h;
    this.t = ctx.t;
    // icons are cloned from a cache (parsing the SVG markup for every row is the costly part of a render)
    const iconCache = new Map();
    this.icon = (name, o = {}) => {
      const key = `${name}|${o.filled ? 1 : 0}|${o.size || ''}|${o.class || ''}`;
      let proto = iconCache.get(key);
      if (!proto) {
        proto = name === 'infinity' ? infinityIcon(ctx.h, o) : ctx.icon(name, o);
        iconCache.set(key, proto);
      }
      return proto.cloneNode(true);
    };
    this.ui = ctx.ui;
    this.win = ctx.win;
    this.shell = ctx.shell;
    this.i18n = ctx.i18n;
    this.fmt = new Fmt(this);
    this.view = 'myday';
    this.prevView = 'myday';
    this.query = '';
    this.openId = null;
    this.sel = new Set();
    this.anchorId = null;
    this.focusId = null;
    this.suggestOpen = false;
    this.completing = new Map(); // task id -> timer (completion animation in flight)
    this.timeOffset = 0;
    this.fakeNow = null;
    this.offs = [];
    this.closed = false;
    this.lastChime = 0;
  }

  // ---------------------------------------------------------------- clock (tests can move it)
  now() {
    return this.fakeNow ?? Date.now() + this.timeOffset;
  }
  today() {
    return D.ymd(this.now());
  }
  setNow(ms) {
    this.fakeNow = ms == null ? null : Number(ms);
    this._dayChanged(true);
  }
  get weekStart() {
    try {
      const wi = new Intl.Locale(this.i18n.locale).weekInfo || new Intl.Locale(this.i18n.locale).getWeekInfo?.();
      if (wi?.firstDay) return wi.firstDay % 7;
    } catch {}
    return this.i18n.lang === 'fr' ? 1 : 0;
  }
  get h12() {
    const s = this.ctx.settings.get('clock24h');
    if (s === true) return false;
    if (s === false) return true;
    return !!this.fmt.dtf({ hour: 'numeric' }).resolvedOptions().hour12;
  }

  // ---------------------------------------------------------------- init
  async init() {
    const { ctx } = this;
    if (shared) {
      shared.refs++;
      shared.apps.add(this);
      this.store = await shared.ready;
    } else {
      const apps = new Set([this]);
      // the store's clock follows a live window (tests move it with setNow)
      const store = new TodoStore({
        load: () => this._load(),
        save: (data) => ctx.storage.set('data', data),
        now: () => (apps.values().next().value || this).now(),
        weekStart: this.weekStart,
      });
      const ready = store.init((st) => seed(st, ctx.lang)).then(
        () => store,
        (err) => {
          shared = null;
          throw err;
        },
      );
      shared = { refs: 1, ready, apps };
      this.ownsStore = true;
      this.store = await ready;
    }
    this.view = this._validView(this.store.data.prefs.lastView) || 'myday';
    this._build();
    this.win.el.__todo = this;
    this.offs.push(
      this.store.on((kind, info) => this._onStore(kind, info)),
      this.shell.reminders?.on?.('fire', (r) => r?.appId === 'todo' && this.render()) || (() => {}),
      ctx.settings.on('clock24h', () => this.render()),
    );
    ctx.onLangChange(() => {
      this.store.weekStart = this.weekStart;
      this.rebuild();
      this.syncReminders();
    });
    ctx.onClose(() => this._dispose());
    this.win.on('focus', () => this._dayChanged());
    this._lastDay = this.today();
    this._tick = setInterval(() => this._dayChanged(), 20000);
    this.syncReminders();
    this.render({ animate: false });
    this._applyArgs(ctx.args || {});
    if (!this.ownsStore) {
      // a second window: nothing to report again
    } else if (this.store.loadError) this.ui.alert(this.t('errors.load', { msg: this.store.loadError.message || String(this.store.loadError) }), { title: this.t('errors.title'), parent: this.win });
    else if (this.recoveredFrom) this.ui.alert(this.t('errors.damaged', { file: this.recoveredFrom.split('/').pop() }), { title: this.t('errors.title'), parent: this.win });
    return this;
  }

  /** Read ~/.config/aurora/apps/todo/data.json. Missing -> null (first run). A damaged file is never
   *  overwritten: it is renamed to data.damaged-<time>.json and To Do starts from an empty list. */
  async _load() {
    const { api } = this.ctx;
    let file = null;
    try {
      file = `${await api.invoke('storage:dir', 'todo')}/data.json`;
    } catch {
      return this.ctx.storage.get('data', null);
    }
    if (!(await api.invoke('fs:exists', file))) return null;
    const text = await api.invoke('fs:readText', file);
    try {
      return JSON.parse(text);
    } catch {
      const backup = file.replace(/data\.json$/, `data.damaged-${Date.now()}.json`);
      await api.invoke('fs:rename', file, backup).catch(() => {});
      this.recoveredFrom = backup;
      return {};
    }
  }

  _build() {
    const { h } = this;
    this.live = h('div', { class: 'td-live', 'aria-live': 'polite', role: 'status' });
    this.nav = new Nav(this);
    this.list = new ListView(this);
    this.detail = new Detail(this);
    this.suggest = new Suggest(this);
    this.settingsView = new SettingsView(this);
    this.scrim = h('div', { class: 'td-scrim', onclick: () => this.closeOverlays() });
    this.root = h('div', { class: 'td', tabindex: '-1' }, this.nav.el, this.list.el, this.settingsView.el, this.scrim, this.detail.el, this.suggest.el, this.live);
    this.win.body.appendChild(this.root);
    // keys typed anywhere in the window (the window body itself may hold the focus)
    if (!this._keysBound) {
      this._keysBound = true;
      this.win.body.addEventListener('keydown', (e) => this._keys(e));
    }
    this.ro = new ResizeObserver(() => this._layout());
    this.ro.observe(this.root);
    this._layout();
  }

  rebuild() {
    if (this.closed) return;
    closePopover();
    this.ro?.disconnect();
    this.root?.remove();
    this._build();
    this.render({ animate: false });
  }

  _layout() {
    const w = this.root.clientWidth;
    if (!w) return;
    const narrow = w < NARROW;
    this.root.classList.toggle('narrow', narrow);
    this.root.classList.toggle('overlay-detail', w < DOCK);
    this.root.classList.toggle('tight', w < 540);
    if (!narrow) this.root.classList.remove('nav-open');
    this._syncScrim();
  }

  _syncScrim() {
    const navOverlay = this.root.classList.contains('narrow') && this.root.classList.contains('nav-open');
    const paneOverlay = this.root.classList.contains('overlay-detail') && (this.openId || this.suggestOpen);
    this.root.classList.toggle('scrim-on', !!(navOverlay || paneOverlay));
  }

  toggleNav(force) {
    const open = force ?? !this.root.classList.contains('nav-open');
    this.root.classList.toggle('nav-open', open);
    this._syncScrim();
    if (open) setTimeout(() => this.nav.focusCurrent(), 30);
  }

  closeOverlays() {
    if (this.root.classList.contains('nav-open')) this.toggleNav(false);
    else if (this.openId) this.closeDetail();
    else if (this.suggestOpen) this.toggleSuggestions(false);
  }

  _dispose() {
    // finish what the user started: completions still animating, text being typed in the details pane
    for (const [id, timer] of this.completing) {
      clearTimeout(timer);
      this._finishComplete(id, { force: true });
    }
    this.completing.clear();
    this.detail.commitFocused();
    this.detail.flush();
    this.closed = true;
    clearInterval(this._tick);
    clearTimeout(this._syncT);
    for (const off of this.offs) off?.();
    this.ro?.disconnect();
    this.store.flush();
    if (shared) {
      shared.apps.delete(this);
      if (--shared.refs <= 0) shared = null;
    }
  }

  _dayChanged(force = false) {
    const day = this.today();
    if (!force && day === this._lastDay) return;
    this._lastDay = day;
    this.render();
  }

  // ---------------------------------------------------------------- store events / rendering
  _onStore(kind, info) {
    if (this.closed) return;
    if (kind === 'save-error' || kind === 'saved') return this.list.renderBanner();
    if (kind === 'tasks' || kind === 'lists') {
      for (const id of [...this.sel]) if (!this.store.task(id)) this.sel.delete(id);
      if (this.openId && !this.store.task(this.openId)) this.closeDetail({ focus: false });
      if (this.view.startsWith('list:') && !this.store.list(this.view.slice(5))) this.go(`list:${DEFAULT_LIST}`);
      this.syncSoon();
    }
    this.render();
  }

  render({ animate = true } = {}) {
    if (this.closed) return;
    if (this._raf) return;
    this._rafAnimate = (this._rafAnimate ?? false) || animate;
    this._raf = requestAnimationFrame(() => {
      const anim = this._rafAnimate;
      this._raf = null;
      this._rafAnimate = null;
      if (this.closed) return;
      if (isDragging()) {
        // never rebuild the rows under a drag in progress: try again when it is over
        setTimeout(() => this.render({ animate: anim }), 150);
        return;
      }
      this.nav.render();
      if (this.view === 'settings') this.settingsView.render();
      else this.list.render({ animate: anim });
      this.detail.render();
      this.suggest.render();
    });
  }
  /** Synchronous render (tests, keyboard flows that need the new DOM at once). */
  renderNow() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
    this._rafAnimate = null;
    this.nav.render();
    if (this.view === 'settings') this.settingsView.render();
    else this.list.render({ animate: false });
    this.detail.render();
    this.suggest.render();
  }

  /** ui.menu that gives the keyboard focus back to the app when the menu closes (it would land on <body>). */
  menu(at, items, opts) {
    const back = this.root.contains(document.activeElement) && document.activeElement !== this.root ? document.activeElement : null;
    return this.ui.menu(at, items, opts).then((v) => {
      setTimeout(() => {
        if (this.closed || this.root.contains(document.activeElement) || document.querySelector('.menu') || this.win.el.querySelector('.dialog-layer, .td-pop')) return;
        if (back?.isConnected) back.focus({ preventScroll: true });
        else this.list.focusList();
      }, 0);
      return v;
    });
  }

  announce(msg) {
    this.live.textContent = '';
    setTimeout(() => (this.live.textContent = msg), 30);
  }

  // ---------------------------------------------------------------- views
  _validView(v) {
    if (typeof v !== 'string') return null;
    if (v === 'settings') return v;
    if (['myday', 'important', 'planned', 'assigned', 'all', 'completed'].includes(v)) return v === 'myday' || this.store.data.prefs.smart[v] !== false ? v : null;
    if (v.startsWith('list:') && this.store.list(v.slice(5))) return v;
    return null;
  }

  go(view, { focus = false, keepSearch = false } = {}) {
    const v = view === 'search' ? 'search' : this._validView(view) || `list:${DEFAULT_LIST}`;
    if (v !== 'search' && !keepSearch && this.query) {
      this.query = '';
      this.nav.clearSearch();
    }
    if (v !== this.view && this.view !== 'search' && this.view !== 'settings') this.prevView = this.view;
    const changed = v !== this.view;
    this.view = v;
    if (changed) {
      this.sel.clear();
      this.anchorId = null;
      this.focusId = null;
      if (v !== 'myday') this.suggestOpen = false;
      if (this.openId) {
        // like To Do: switching lists closes the details pane
        this.detail.flush();
        this.openId = null;
      }
      closePopover();
    }
    if (v !== 'search' && v !== 'settings' && this.store.data.prefs.lastView !== v) {
      this.store.data.prefs.lastView = v;
      this.store._schedule();
    }
    this.root.dataset.view = v.startsWith('list:') ? 'list' : v;
    if (this.root.classList.contains('narrow')) this.toggleNav(false);
    this._syncScrim();
    this.list.viewChanged(changed);
    this.renderNow();
    if (focus) this.list.focusAdd();
  }

  setSearch(q) {
    this.query = q;
    if (q.trim()) {
      if (this.view !== 'search') this.go('search', { keepSearch: true });
      else this.render();
    } else if (this.view === 'search') this.go(this.prevView || 'myday', { keepSearch: true });
  }

  themeOf(view) {
    if (view?.startsWith('list:')) return this.store.list(view.slice(5))?.theme || DEFAULT_THEMES.tasks;
    return this.store.data.views[view]?.theme || { color: 'accent', bg: null };
  }

  listName(l) {
    if (!l) return '';
    return l.id === DEFAULT_LIST ? this.t('nav.tasks') : l.name;
  }
  viewTitle(view) {
    if (view === 'search') return this.t('search.title', { q: this.query.trim() });
    if (view === 'settings') return this.t('settings.title');
    if (view.startsWith('list:')) return this.listName(this.store.list(view.slice(5)));
    return this.t(`nav.${view}`);
  }

  // ---------------------------------------------------------------- selection & detail
  select(id, { add = false, range = false, open = true } = {}) {
    const ids = this.list.visibleIds();
    if (range && this.anchorId && ids.includes(this.anchorId) && ids.includes(id)) {
      const [a, b] = [ids.indexOf(this.anchorId), ids.indexOf(id)].sort((x, y) => x - y);
      if (!add) this.sel.clear();
      for (const x of ids.slice(a, b + 1)) this.sel.add(x);
    } else if (add) {
      if (this.sel.has(id)) this.sel.delete(id);
      else this.sel.add(id);
      this.anchorId = id;
    } else {
      this.sel = new Set([id]);
      this.anchorId = id;
    }
    this.focusId = id;
    if (this.sel.size === 1 && open && !add && !range) this.openTask(id, { focus: false });
    else if (this.sel.size !== 1 && this.openId) this.closeDetail({ focus: false });
    this.list.paintSelection();
  }

  openTask(id, { focus = false, field = null } = {}) {
    const t = this.store.task(id);
    if (!t) return;
    this.detail.flush();
    this.openId = id;
    this.suggestOpen = false;
    if (!this.sel.has(id) || this.sel.size !== 1) {
      this.sel = new Set([id]);
      this.anchorId = id;
    }
    this.focusId = id;
    this._syncScrim();
    this.detail.render({ force: true });
    this.suggest.render();
    this.list.paintSelection();
    if (focus) this.detail.focus(field);
  }

  closeDetail({ focus = true } = {}) {
    if (!this.openId) return;
    this.detail.flush();
    const id = this.openId;
    this.openId = null;
    this._syncScrim();
    this.detail.render();
    this.list.paintSelection();
    if (focus) this.list.focusRow(id) || this.list.focusList();
  }

  toggleSuggestions(force) {
    this.suggestOpen = force ?? !this.suggestOpen;
    if (this.suggestOpen) {
      this.detail.flush();
      this.openId = null;
      this.detail.render();
    }
    this._syncScrim();
    this.suggest.render();
    this.list.renderHeader();
    if (this.suggestOpen) this.suggest.focus();
  }

  /** Ids an action applies to: the selection, else the focused row, else the open task. */
  targets(id) {
    if (id && !this.sel.has(id)) return [id];
    const focused = document.activeElement?.closest?.('.td-task')?.dataset.id;
    if (focused && this.root.contains(document.activeElement) && !this.sel.has(focused) && this.store.task(focused)) return [focused];
    if (this.sel.size) return [...this.sel].filter((x) => this.store.task(x));
    if (this.focusId && this.store.task(this.focusId)) return [this.focusId];
    if (this.openId) return [this.openId];
    return [];
  }

  // ---------------------------------------------------------------- task actions
  addTask(fields, opts) {
    const t = this.store.addTask(fields, opts);
    if (!t) return null;
    if (Number.isFinite(t.remindAt)) this.applyReminder(t.id);
    this.announce(this.t('a11y.added', { title: t.title }));
    return t;
  }

  /** Complete with the check + strike animation and chime, then let the row fly to Completed. */
  complete(ids, done = true, { animate = true } = {}) {
    const list = [].concat(ids).filter((id) => this.store.task(id));
    if (!list.length) return;
    if (done) {
      const fresh = list.filter((id) => !this.store.task(id).done);
      if (!fresh.length) return;
      this.chime();
      for (const id of fresh) {
        if (this.completing.has(id)) continue;
        const delay = animate && !this.reduceMotion() ? COMPLETE_DELAY : 0;
        this.list.markCompleting(id, true);
        this.detail.markCompleting(id, true);
        const timer = setTimeout(() => {
          this.completing.delete(id);
          this._finishComplete(id);
        }, delay);
        this.completing.set(id, timer);
      }
    } else {
      for (const id of list) {
        if (this.completing.has(id)) {
          clearTimeout(this.completing.get(id));
          this.completing.delete(id);
          this.list.markCompleting(id, false);
          this.detail.markCompleting(id, false);
          continue;
        }
        this.store.setDone(id, false);
        this.applyReminder(id);
      }
    }
  }

  _finishComplete(id, { force = false } = {}) {
    if ((this.closed && !force) || !this.store.task(id)) return;
    const { next } = this.store.setDone(id, true);
    this.applyReminder(id);
    if (next) {
      this.applyReminder(next.id);
      this.announce(this.t('a11y.completedRepeat', { title: next.title, date: this.fmt.dueLong(next.due) }));
    } else this.announce(this.t('a11y.completed', { title: this.store.task(id)?.title || '' }));
  }

  reduceMotion() {
    return document.documentElement.dataset.animations === 'off';
  }

  chime() {
    if (!this.store.data.prefs.sound) return;
    this.lastChime = Date.now();
    try {
      this.shell.sounds?.play?.(CHIME);
    } catch {}
  }

  toggleImportant(ids, value) {
    const list = [].concat(ids).map((id) => this.store.task(id)).filter(Boolean);
    if (!list.length) return;
    const v = value ?? !list.every((t) => t.important);
    for (const t of list) if (t.important !== v) this.store.update(t.id, { important: v });
  }

  toggleMyDay(ids, value) {
    const list = [].concat(ids).map((id) => this.store.task(id)).filter(Boolean);
    if (!list.length) return;
    const today = this.today();
    const v = value ?? !list.every((t) => t.myDay === today);
    this.store.setMyDay(list.map((t) => t.id), v);
    this.announce(this.t(v ? 'a11y.addedMyDay' : 'a11y.removedMyDay', { count: list.length }));
  }

  setDue(ids, due) {
    for (const id of [].concat(ids)) {
      this.store.update(id, { due });
      this.applyReminder(id);
    }
  }

  setRepeat(id, repeat) {
    this.store.update(id, { repeat });
    this.applyReminder(id);
  }

  remind(id, at) {
    this.store.update(id, { remindAt: at });
    this.applyReminder(id, { reset: true });
  }

  async deleteTasks(ids, { confirm = this.store.data.prefs.confirmDelete } = {}) {
    const list = [].concat(ids).map((id) => this.store.task(id)).filter(Boolean);
    if (!list.length) return false;
    if (confirm) {
      const msg = list.length === 1 ? this.t('confirm.deleteTask', { title: list[0].title }) : this.t('confirm.deleteTasks', { count: list.length });
      const ok = await this.ui.confirm(msg, { title: this.t(list.length === 1 ? 'confirm.deleteTaskTitle' : 'confirm.deleteTasksTitle', { count: list.length }), okLabel: this.t('menu.deleteTask'), danger: true, parent: this.win });
      if (!ok) return false;
    }
    const ids2 = list.map((t) => t.id);
    const neighbor = this.list.neighborOf(ids2);
    for (const id of ids2) {
      clearTimeout(this.completing.get(id));
      this.completing.delete(id);
      this._removeReminder(id);
    }
    if (ids2.includes(this.openId)) this.closeDetail({ focus: false });
    this.store.remove(ids2);
    this.sel.clear();
    this.announce(this.t('a11y.deleted', { count: ids2.length }));
    if (neighbor) {
      this.focusId = neighbor;
      this.renderNow();
      this.list.focusRow(neighbor);
    } else {
      this.renderNow();
      this.list.focusList();
    }
    return true;
  }

  moveTasks(ids, listId) {
    const moved = this.store.move(ids, listId);
    if (moved.length) {
      const l = this.store.list(listId);
      this.announce(this.t('a11y.moved', { count: moved.length, list: this.listName(l) }));
      for (const id of moved) this.applyReminder(id);
    }
    return moved;
  }

  // ---------------------------------------------------------------- reminders
  reminderBody(t) {
    const l = this.store.list(t.listId);
    const parts = [this.listName(l)];
    if (t.due) parts.push(this.fmt.dueLong(t.due));
    return parts.filter(Boolean).join(' · ');
  }

  /** Mirror one task's reminder into shell.reminders. reset: the user picked a new time (drop snoozes). */
  applyReminder(id, { reset = false } = {}) {
    const R = this.shell.reminders;
    if (!R) return;
    const t = this.store.task(id);
    const rid = `task-${id}`;
    try {
      if (!t || t.done || !Number.isFinite(t.remindAt)) {
        this._removeReminder(id);
        return;
      }
      if (reset) R.remove(`${rid}~snooze`, 'todo');
      const existing = R.get(rid, 'todo');
      const at = !reset && existing && existing.at > this.now() ? existing.at : t.remindAt;
      if (at <= Date.now()) {
        if (reset) R.remove(rid, 'todo');
        return;
      }
      R.set({ id: rid, appId: 'todo', at, title: t.title, body: this.reminderBody(t), repeat: null, kind: 'reminder', data: { taskId: t.id } });
    } catch (err) {
      console.error('[todo] reminder failed', err);
    }
  }

  _removeReminder(id) {
    const R = this.shell.reminders;
    if (!R) return;
    try {
      R.remove(`task-${id}`, 'todo');
      R.remove(`task-${id}~snooze`, 'todo');
    } catch {}
  }

  syncSoon() {
    clearTimeout(this._syncT);
    this._syncT = setTimeout(() => this.syncReminders(), 60);
  }

  /** Launch / after changes: add missing reminders, refresh their text, remove orphans. */
  syncReminders() {
    const R = this.shell.reminders;
    if (!R || this.closed) return;
    try {
      const existing = R.list('todo');
      const plan = reminderPlan(this.store.data, existing, Date.now(), {
        refreshText: (t, r) => r.title !== t.title || r.body !== this.reminderBody(t),
      });
      for (const id of plan.remove) R.remove(id, 'todo');
      for (const t of plan.set) this.applyReminder(t.id);
    } catch (err) {
      console.error('[todo] reminder sync failed', err);
    }
  }

  // ---------------------------------------------------------------- lists
  async newList() {
    const l = this.store.addList(this.t('list.untitled'));
    this.go(`list:${l.id}`);
    setTimeout(() => this.list.editTitle(true), 30);
    return l;
  }

  async renameList(id) {
    const l = this.store.list(id);
    if (!l || id === DEFAULT_LIST) return;
    if (this.view === `list:${id}`) return this.list.editTitle(true);
    const v = await this.ui.prompt({
      title: this.t('list.renameTitle'),
      label: this.t('list.name'),
      value: `${l.emoji ? `${l.emoji} ` : ''}${l.name}`,
      parent: this.win,
      validate: (s) => (splitEmoji(s).name || splitEmoji(s).emoji ? null : this.t('list.nameRequired')),
    });
    if (v != null) this.store.renameList(id, v);
  }

  async deleteList(id) {
    const l = this.store.list(id);
    if (!l || id === DEFAULT_LIST) return;
    const ok = await this.ui.confirm(this.t('confirm.deleteList', { name: this.listName(l) }), { title: this.t('confirm.deleteListTitle'), okLabel: this.t('menu.deleteList'), danger: true, parent: this.win });
    if (!ok) return;
    const removed = this.store.deleteList(id);
    for (const tid of removed) this._removeReminder(tid);
    if (this.view === `list:${id}`) this.go(`list:${DEFAULT_LIST}`);
    this.announce(this.t('a11y.listDeleted', { name: this.listName(l) }));
  }

  duplicateList(id) {
    const c = this.store.duplicateList(id, (l) => this.t('list.copyName', { name: l.name || this.t('nav.tasks') }));
    if (c) this.go(`list:${c.id}`);
    return c;
  }

  async copyListText(view) {
    const { open, done } = viewTasks(this.store.data, view, this.now());
    const lines = [this.viewTitle(view), ''];
    for (const t of this.list.sorted(open, view)) {
      lines.push(`☐ ${t.title}${t.due ? ` (${this.fmt.dueShort(t.due)})` : ''}`);
      for (const s of t.steps) lines.push(`    ${s.done ? '☑' : '☐'} ${s.title}`);
    }
    for (const t of done) lines.push(`☑ ${t.title}`);
    try {
      await this.ctx.api.invoke('clipboard:writeText', lines.join('\n'));
      this.announce(this.t('a11y.copied'));
      this.shell.notify?.({ title: this.t('list.copiedTitle'), body: this.t('list.copiedBody', { name: this.viewTitle(view) }), appId: 'todo', timeout: 3000 });
    } catch (err) {
      this.ui.alert(this.t('errors.copy', { msg: err?.message || String(err) }), { title: this.t('errors.title'), parent: this.win });
    }
  }

  async changeTheme(anchor, view) {
    await themePicker(this, anchor, view);
  }

  async changeEmoji(anchor, listId) {
    const l = this.store.list(listId);
    if (!l) return;
    const e = await emojiPicker(this, anchor, l.emoji);
    if (e == null) return;
    this.store.setListEmoji(listId, e || null);
  }

  /** Context menu of a list (nav right-click or the header "…" button). */
  listMenu(at, view) {
    const { t } = this;
    const isList = view.startsWith('list:');
    const id = isList ? view.slice(5) : null;
    const isUser = isList && id !== DEFAULT_LIST;
    const prefs = this.store.viewPrefs(view);
    const groups = [...this.store.data.groups].sort((a, b) => a.order - b.order);
    const l = isList ? this.store.list(id) : null;
    const anchor = at?.currentTarget instanceof Element ? at.currentTarget : at?.target instanceof Element ? at.target.closest('[data-view], button') || at.target : null;
    const items = [
      isUser ? { label: t('menu.renameList'), icon: 'rename', shortcut: 'F2', action: () => this.renameList(id) } : null,
      isUser ? { label: t('menu.changeIcon'), icon: 'emoji', action: () => this.changeEmoji(this._menuAnchor(view, anchor), id) } : null,
      view !== 'search' ? { label: t('menu.theme'), icon: 'color', action: () => this.changeTheme(this._menuAnchor(view, anchor), view) } : null,
      ['completed', 'assigned', 'search'].includes(view) ? null : { label: t(prefs.showCompleted ? 'menu.hideCompleted' : 'menu.showCompleted'), icon: prefs.showCompleted ? 'eye_off' : 'eye', action: () => this.store.setViewPref(view, { showCompleted: !prefs.showCompleted }) },
      isUser && groups.length
        ? {
            label: t('menu.moveToGroup'),
            icon: 'folder_arrow_right',
            submenu: [
              ...groups.map((g) => ({ label: g.name, checked: l.groupId === g.id, action: () => this.store.moveListToGroup(id, g.id) })),
              '-',
              { label: t('menu.noGroup'), checked: !l.groupId, action: () => this.store.moveListToGroup(id, null) },
            ],
          }
        : null,
      isList ? { label: t('menu.duplicateList'), icon: 'copy', action: () => this.duplicateList(id) } : null,
      view !== 'search' ? { label: t('menu.copyText'), icon: 'clipboard_text_ltr', action: () => this.copyListText(view) } : null,
      !isList && view !== 'myday' && view !== 'search' ? '-' : null,
      !isList && view !== 'myday' && view !== 'search' ? { label: t('menu.hideList'), icon: 'eye_off', action: () => this.hideSmartList(view) } : null,
      isUser ? '-' : null,
      isUser ? { label: t('menu.deleteList'), icon: 'delete', danger: true, action: () => this.deleteList(id) } : null,
    ].filter(Boolean);
    return this.menu(at, items);
  }

  _menuAnchor(view, fallback) {
    if (view === this.view) return this.list.moreBtn || fallback;
    return this.nav.itemFor(view) || fallback || this.list.moreBtn;
  }

  hideSmartList(view) {
    this.store.setPref(`smart.${view}`, false);
    if (this.view === view) this.go(`list:${DEFAULT_LIST}`);
  }

  groupMenu(at, gid) {
    const { t } = this;
    const g = this.store.group(gid);
    if (!g) return;
    return this.menu(at, [
      { label: t('menu.renameGroup'), icon: 'rename', action: () => this.nav.editGroup(gid) },
      { label: t('menu.newListInGroup'), icon: 'add', action: async () => {
        const l = this.store.addList(this.t('list.untitled'), { groupId: gid });
        this.store.setGroupCollapsed(gid, false);
        this.go(`list:${l.id}`);
        setTimeout(() => this.list.editTitle(true), 30);
      } },
      '-',
      { label: t('menu.ungroup'), icon: 'folder_arrow_up', action: () => this.store.ungroup(gid) },
    ]);
  }

  newGroup() {
    const g = this.store.addGroup(this.t('list.untitledGroup'));
    this.renderNow();
    this.nav.editGroup(g.id);
    return g;
  }

  /** Context menu of a task row (applies to the whole selection when the row is selected). */
  taskMenu(at, id) {
    const { t } = this;
    const ids = this.targets(id);
    const tasks = ids.map((x) => this.store.task(x)).filter(Boolean);
    if (!tasks.length) return;
    const today = this.today();
    const allMyDay = tasks.every((x) => x.myDay === today);
    const allImportant = tasks.every((x) => x.important);
    const allDone = tasks.every((x) => x.done);
    const presets = D.duePresets(this.now());
    const listItems = (fn, exclude) =>
      this.store
        .lists()
        .filter((l) => l.id !== exclude)
        .map((l) => ({ label: `${l.emoji ? `${l.emoji}  ` : ''}${this.listName(l)}`, icon: l.emoji ? null : l.id === DEFAULT_LIST ? 'home' : 'text_bullet_list_ltr', action: () => fn(l.id) }));
    const sameList = tasks.every((x) => x.listId === tasks[0].listId) ? tasks[0].listId : null;
    const anchor = at?.currentTarget instanceof Element ? at.currentTarget : this.list.rowEl(tasks[0].id);
    const items = [
      tasks.length > 1 ? { header: t('menu.selected', { count: tasks.length }) } : null,
      { label: t(allMyDay ? 'menu.removeMyDay' : 'menu.addMyDay'), icon: 'weather_sunny', shortcut: this.fmt.keys('Ctrl+T'), action: () => this.toggleMyDay(ids) },
      { label: t(allImportant ? 'menu.removeImportant' : 'menu.markImportant'), icon: 'star', iconFilled: allImportant, shortcut: this.fmt.keys('Ctrl+Shift+S'), action: () => this.toggleImportant(ids) },
      { label: t(allDone ? 'menu.markNotCompleted' : 'menu.markCompleted'), icon: allDone ? 'circle' : 'checkmark_circle', shortcut: this.fmt.keys('Ctrl+D'), action: () => this.complete(ids, !allDone) },
      '-',
      { label: t('menu.dueToday'), icon: 'calendar_today', action: () => this.setDue(ids, presets.today) },
      { label: t('menu.dueTomorrow'), icon: 'calendar_arrow_right', action: () => this.setDue(ids, presets.tomorrow) },
      { label: t('menu.pickDate'), icon: 'calendar_ltr', action: async () => {
        const d = await pickDate(this, anchor || this.list.moreBtn, { value: tasks[0].due, title: t('due.pick') });
        if (d) this.setDue(ids, d);
      } },
      tasks.some((x) => x.due) ? { label: t('menu.removeDue'), icon: 'calendar_cancel', action: () => this.setDue(ids, null) } : null,
      '-',
      tasks.length === 1 ? { label: t('menu.newListFromTask'), icon: 'text_bullet_list_add', action: () => this.newListFromTask(tasks[0].id) } : null,
      { label: t('menu.moveTo'), icon: 'arrow_right', submenu: listItems((lid) => this.moveTasks(ids, lid), sameList) },
      tasks.length === 1 ? { label: t('menu.copyTo'), icon: 'copy', submenu: listItems((lid) => this.store.copy(tasks[0].id, lid)) } : null,
      '-',
      { label: t(tasks.length > 1 ? 'menu.deleteTasks' : 'menu.deleteTask'), icon: 'delete', danger: true, shortcut: t('kbd.Delete'), action: () => this.deleteTasks(ids) },
    ].filter(Boolean);
    return this.menu(at, items);
  }

  newListFromTask(id) {
    const task = this.store.task(id);
    if (!task) return;
    const l = this.store.addList(task.title);
    this.store.remove([id]);
    for (const s of task.steps) {
      const n = this.store.addTask({ title: s.title, listId: l.id }, { top: false });
      if (n && s.done) this.store.setDone(n.id, true);
    }
    this._removeReminder(id);
    this.go(`list:${l.id}`);
  }

  // ---------------------------------------------------------------- pickers used by the detail pane & add bar
  pickDue(anchor, value) {
    return pickDate(this, anchor, { value, title: this.t('due.pick') });
  }
  pickReminder(anchor, value) {
    return pickDateTime(this, anchor, { value, title: this.t('remind.pick') });
  }
  customRepeat(repeat, due) {
    return customRepeat(this, { repeat, due });
  }

  /** Menu of due presets -> Promise<'YYYY-MM-DD' | null | undefined (dismissed)> */
  dueMenu(anchor, current) {
    const { t } = this;
    const p = D.duePresets(this.now());
    return new Promise((resolve) => {
      let picked;
      this
        .menu(anchor, [
          { label: t('due.today'), icon: 'calendar_today', shortcut: this.fmt.weekday(p.today), action: () => (picked = p.today) },
          { label: t('due.tomorrow'), icon: 'calendar_arrow_right', shortcut: this.fmt.weekday(p.tomorrow), action: () => (picked = p.tomorrow) },
          { label: t('due.nextWeek'), icon: 'calendar_week_start', shortcut: this.fmt.weekday(p.nextWeek), action: () => (picked = p.nextWeek) },
          '-',
          { label: t('due.pick'), icon: 'calendar_ltr', action: () => (picked = 'pick') },
          current ? '-' : null,
          current ? { label: t('due.remove'), icon: 'delete', danger: true, action: () => (picked = null) } : null,
        ].filter(Boolean))
        .then(async () => {
          if (picked === 'pick') resolve((await this.pickDue(anchor, current)) ?? undefined);
          else resolve(picked);
        });
    });
  }

  /** Menu of reminder presets -> Promise<ms | null (remove) | undefined (dismissed)> */
  reminderMenu(anchor, current) {
    const { t } = this;
    const p = D.reminderPresets(this.now());
    return new Promise((resolve) => {
      let picked;
      this
        .menu(anchor, [
          p.laterToday ? { label: t('remind.laterToday'), icon: 'clock_arrow_download', shortcut: this.fmt.time(p.laterToday), action: () => (picked = p.laterToday) } : null,
          { label: t('remind.tomorrow'), icon: 'arrow_clockwise', shortcut: `${this.fmt.weekday(D.ymd(p.tomorrow))}, ${this.fmt.time(p.tomorrow)}`, action: () => (picked = p.tomorrow) },
          { label: t('remind.nextWeek'), icon: 'calendar_week_start', shortcut: `${this.fmt.weekday(D.ymd(p.nextWeek))}, ${this.fmt.time(p.nextWeek)}`, action: () => (picked = p.nextWeek) },
          '-',
          { label: t('remind.pick'), icon: 'calendar_clock', action: () => (picked = 'pick') },
          current ? '-' : null,
          current ? { label: t('remind.remove'), icon: 'delete', danger: true, action: () => (picked = null) } : null,
        ].filter(Boolean))
        .then(async () => {
          if (picked === 'pick') resolve((await this.pickReminder(anchor, current)) ?? undefined);
          else resolve(picked);
        });
    });
  }

  /** Menu of repeat presets -> Promise<rule | null (remove) | undefined (dismissed)> */
  repeatMenu(anchor, current, due) {
    const { t } = this;
    const day = due || this.today();
    const key = D.repeatKey(current);
    return new Promise((resolve) => {
      let picked;
      this
        .menu(anchor, [
          ...['daily', 'weekdays', 'weekly', 'monthly', 'yearly'].map((k) => ({ label: t(`repeat.${k}`), icon: { daily: 'calendar_day', weekdays: 'calendar_work_week', weekly: 'calendar_week_start', monthly: 'calendar_month', yearly: 'calendar_ltr' }[k], checked: current ? key === k : undefined, action: () => (picked = D.makeRepeat(k, day)) })),
          '-',
          { label: t('repeat.custom'), icon: 'calendar_settings', checked: current ? key === 'custom' : undefined, action: () => (picked = 'custom') },
          current ? '-' : null,
          current ? { label: t('repeat.never'), icon: 'delete', danger: true, action: () => (picked = null) } : null,
        ].filter(Boolean))
        .then(async () => {
          if (picked === 'custom') resolve((await this.customRepeat(current, day)) ?? undefined);
          else resolve(picked);
        });
    });
  }

  // ---------------------------------------------------------------- relaunch / args
  _applyArgs(args) {
    const id = args?.reminder?.data?.taskId || args?.taskId;
    if (id && this.store.task(id)) {
      const t = this.store.task(id);
      const view = t.done ? `list:${t.listId}` : this.view.startsWith('list:') && this.view !== `list:${t.listId}` ? `list:${t.listId}` : this.list.contains(id) ? this.view : `list:${t.listId}`;
      if (view !== this.view) this.go(view);
      this.renderNow();
      this.select(id);
      this.list.scrollToRow(id);
      this.list.focusRow(id);
    } else if (args?.reminder) {
      this.ui.alert(this.t('errors.taskGone'), { title: this.t('app'), parent: this.win });
    }
    if (typeof args?.view === 'string' && this._validView(args.view)) this.go(args.view);
  }

  onRelaunch(args) {
    this._applyArgs(args || {});
  }

  // ---------------------------------------------------------------- keyboard
  _keys(e) {
    if (e.defaultPrevented || isDragging()) return;
    const k = e.key;
    const ctrl = e.ctrlKey || e.metaKey;
    const inField = e.target.closest?.('input, textarea, select, [contenteditable="true"]');
    if (ctrl && !e.altKey && (k === '?' || (e.shiftKey && (e.code === 'Slash' || k === '/')))) {
      e.preventDefault();
      shortcutsHelp(this);
      return;
    }
    if (ctrl && !e.shiftKey && !e.altKey) {
      const lk = k.toLowerCase();
      if (lk === 'n') {
        e.preventDefault();
        if (this.list.canAdd()) this.list.focusAdd();
        else this.go(`list:${DEFAULT_LIST}`, { focus: true });
        return;
      }
      if (lk === 'l') {
        e.preventDefault();
        this.newList();
        return;
      }
      if (lk === 'f') {
        e.preventDefault();
        if (this.root.classList.contains('narrow')) this.toggleNav(true);
        this.nav.focusSearch();
        return;
      }
      if (lk === 'd' || lk === 't') {
        // (in the "Add a task" box these keys belong to the text being typed)
        const ids = e.target.closest('.td-add, .td-search') ? [] : this.targets();
        if (!ids.length) return;
        e.preventDefault();
        if (lk === 't') this.toggleMyDay(ids);
        else this.complete(ids, !ids.every((id) => this.store.task(id)?.done));
        return;
      }
      if (lk === 'a' && !inField) {
        e.preventDefault();
        this.sel = new Set(this.list.visibleIds());
        if (this.openId && this.sel.size > 1) this.closeDetail({ focus: false });
        this.list.paintSelection();
        return;
      }
    }
    if (ctrl && e.shiftKey && !e.altKey && k.toLowerCase() === 's') {
      const ids = this.targets();
      if (ids.length) {
        e.preventDefault();
        this.toggleImportant(ids);
      }
      return;
    }
    if (k === 'Escape') {
      if (popoverOpen()) return;
      if (e.target.closest?.('.td-search') && this.query) {
        e.preventDefault();
        this.nav.clearSearch();
        this.setSearch('');
        this.list.focusList();
        return;
      }
      if (this.root.classList.contains('nav-open')) {
        e.preventDefault();
        this.toggleNav(false);
        return;
      }
      if (this.openId) {
        e.preventDefault();
        this.closeDetail();
        return;
      }
      if (this.suggestOpen) {
        e.preventDefault();
        this.toggleSuggestions(false);
        this.list.focusList();
        return;
      }
      if (this.sel.size > 1) {
        e.preventDefault();
        this.sel = new Set(this.focusId ? [this.focusId] : []);
        this.list.paintSelection();
      }
      return;
    }
    if (inField) return;
    if (k === 'Delete' && !ctrl && !e.altKey) {
      const ids = this.targets();
      if (ids.length) {
        e.preventDefault();
        this.deleteTasks(ids);
      }
      return;
    }
    if (k === 'F2' && this.view.startsWith('list:') && e.target.closest('.td-nav, .td-head')) {
      e.preventDefault();
      this.renameList(this.view.slice(5));
    }
  }
}

function infinityIcon(h, opts = {}) {
  const span = h('span', { class: `icon${opts.class ? ` ${opts.class}` : ''}`, dataset: { icon: 'infinity' } });
  if (opts.size) Object.assign(span.style, { width: `${opts.size}px`, height: `${opts.size}px` });
  span.innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" aria-hidden="true"><path d="M5.6 6.2c1.6 0 2.8 1 4.4 2.9 1.6-1.9 2.8-2.9 4.4-2.9a3.8 3.8 0 0 1 0 7.6c-1.6 0-2.8-1-4.4-2.9-1.6 1.9-2.8 2.9-4.4 2.9a3.8 3.8 0 0 1 0-7.6zm0 1a2.8 2.8 0 0 0 0 5.6c1.2 0 2.2-.8 3.7-2.8-1.5-2-2.5-2.8-3.7-2.8zm8.8 0c-1.2 0-2.2.8-3.7 2.8 1.5 2 2.5 2.8 3.7 2.8a2.8 2.8 0 0 0 0-5.6z" fill="currentColor"/></svg>';
  return span;
}
