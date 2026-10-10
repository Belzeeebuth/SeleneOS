// Calendar app controller: state, persistence, toolbar, left pane, keyboard, and the operations the
// views call (select, create, edit, move, delete, import, export). Views live in month.js,
// timegrid.js and agenda.js; the editor / peek / quick-create flyouts in editor.js; dialogs in dialogs.js.
import { createFmt } from './fmt.js';
import { miniMonth } from './minical.js';
import { openPopover, closeAllPopovers } from './pickers.js';
import { renderMonth } from './month.js';
import { renderTimeGrid } from './timegrid.js';
import { renderAgenda, renderSearch } from './agenda.js';
import { showPeek, quickCreate, openEditor, askSeries, askDeleteSeries } from './editor.js';
import { settingsDialog, calendarDialog, importFlow, exportFlow, shortcutsDialog } from './dialogs.js';
import { loadData, visibleOccurrences, syncReminders, sanitizeCalendars, sanitizePrefs, PALETTE, APP_ID } from '../lib/store.mjs';
import { sanitizeEvent, occurrenceAt, updateOccurrence, updateSeries, deleteOccurrence, truncateSeries, moveOccurrence, newId, firstOccurrence } from '../lib/events.mjs';
import { addDays, addMonths, startOfDay, startOfWeek, sameDay, localFromKey, localKey, isDateKey, keyFromDayNum, localDayNum } from '../lib/dates.mjs';
import { css } from './util.js';

const VIEWS = ['day', 'workweek', 'week', 'month', 'agenda'];
const VIEW_ICONS = { day: 'calendar_day', workweek: 'calendar_work_week', week: 'calendar_week_numbers', month: 'calendar_month', agenda: 'calendar_agenda' };

export class CalendarApp {
  constructor(ctx) {
    this.ctx = ctx;
    this.win = ctx.win;
    this.t = ctx.t;
    this.h = ctx.h;
    this.fmt = createFmt(ctx);
    this.data = { calendars: [], events: [], prefs: sanitizePrefs(null) };
    this.state = { view: 'month', date: startOfDay(new Date()), selected: null, search: '' };
    this.agendaDays = 30;
    this.tgScroll = null;
    this.saveChain = Promise.resolve();
    this.offs = [];
    this.viewHandle = null;
  }

  get prefs() {
    return this.data.prefs;
  }

  reduceMotion() {
    return document.documentElement.dataset.animations === 'off';
  }

  firstDay() {
    const f = this.prefs.firstDay;
    if (f === 'auto') return this.ctx.lang === 'fr' ? 1 : 0;
    return f;
  }

  // ------------------------------------------------------------------ boot
  async init() {
    const { ctx } = this;
    try {
      this.data = await loadData(ctx.api, ctx.lang);
    } catch (err) {
      console.error('[calendar] load failed', err);
    }
    this.state.view = this.prefs.view;
    this.build();
    this.render({ animate: false });
    this.syncReminders();
    // keep "now" fresh: red line every 30 s, today highlight after midnight
    let lastDay = localKey(new Date());
    const tick = setInterval(() => {
      const k = localKey(new Date());
      if (k !== lastDay) {
        lastDay = k;
        this.render({ animate: false, keepScroll: true });
      } else this.viewHandle?.tick?.();
    }, 30000);
    this.offs.push(() => clearInterval(tick));
    this.offs.push(ctx.settings.on('clock24h', () => this.render({ animate: false, keepScroll: true })));
    ctx.onLangChange(() => {
      this.fmt = createFmt(ctx);
      this.build();
      this.render({ animate: false, keepScroll: true });
      this.syncReminders();
    });
    this.offs.push(
      ctx.shell?.reminders?.on?.('fire', (r) => {
        if (r?.appId === APP_ID) setTimeout(() => this.syncReminders(), 500);
      }),
    );
    // shortcuts work wherever the focus is in the window body (not in dialogs, which live beside it)
    this.win.body.addEventListener('keydown', (e) => this.onKey(e));
    const ro = new ResizeObserver(() => this.onResize());
    ro.observe(this.win.body);
    this.offs.push(() => ro.disconnect());
    ctx.onClose(() => {
      closeAllPopovers('close');
      for (const off of this.offs) {
        try {
          off?.();
        } catch {}
      }
    });
    await this.handleArgs(ctx.args || {});
    if (!this.win.el.contains(document.activeElement) || document.activeElement === this.win.body) this.viewEl.focus({ preventScroll: true });
  }

  async handleArgs(args = {}) {
    try {
      if (args.file) await importFlow(this, args.file);
      const target = args.reminder?.data || args.open;
      if (target?.eventId) this.openFromReminder(target);
      if (args.date && isDateKey(args.date)) {
        this.goTo(localFromKey(args.date));
        if (args.newEvent) this.newEvent({ date: localFromKey(args.date) });
      }
    } catch (err) {
      console.error('[calendar] args failed', err);
    }
  }

  openFromReminder({ eventId, key }) {
    const ev = this.data.events.find((e) => e.id === eventId);
    const occ = ev && (key != null ? occurrenceAt(ev, key) : firstOccurrence(ev));
    if (!occ) {
      this.toast(this.t('eventGone'));
      return;
    }
    this.state.selected = { eventId, key: occ.key };
    this.goTo(new Date(occ.start), { keepSelection: true });
    setTimeout(() => this.peekSelected(), 60);
  }

  // ------------------------------------------------------------------ DOM
  build() {
    const { h, icon, ui } = this.ctx;
    const t = this.t;
    ui.clear(this.win.body);
    ui.clear(this.win.titlebarSlot);
    // search box in the (tall) title bar, like the new Outlook
    this.searchInput = h('input', {
      class: 'input',
      type: 'search',
      placeholder: t('searchPlaceholder'),
      'aria-label': t('search'),
      value: this.state.search,
      spellcheck: false,
      oninput: () => {
        clearTimeout(this._searchT);
        this._searchT = setTimeout(() => this.setSearch(this.searchInput.value), 180);
      },
      onkeydown: (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          if (this.searchInput.value) {
            this.searchInput.value = '';
            this.setSearch('');
          } else this.focusView();
        } else if (e.key === 'Enter') {
          e.preventDefault();
          this.setSearch(this.searchInput.value);
          this.viewEl?.querySelector('.ac-ag-row')?.focus();
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          this.viewEl?.querySelector('.ac-ag-row')?.focus();
        }
      },
    });
    this.searchClear = h(
      'button',
      {
        class: 'ac-search-clear',
        type: 'button',
        'aria-label': t('clearSearch'),
        'data-tip': t('clearSearch'),
        onclick: () => {
          this.searchInput.value = '';
          this.setSearch('');
          this.searchInput.focus();
        },
      },
      icon('dismiss', { size: 12 }),
    );
    this.win.titlebarSlot.appendChild(h('div', { class: 'ac-tb-search' }, h('div', { class: 'ac-search' }, icon('search', { size: 16 }), this.searchInput, this.searchClear)));

    // toolbar
    this.paneBtn = h('button', { class: 'btn subtle icon-btn ac-pane-toggle', type: 'button', 'aria-label': t('togglePane'), 'data-tip': t('togglePane'), onclick: () => this.togglePane() }, icon('navigation', { size: 16 }));
    this.newBtn = h('button', { class: 'btn primary ac-new', type: 'button', 'aria-label': t('newEvent'), 'data-tip': this.tipWithKey(t('newEvent'), 'N'), onclick: () => this.newEvent() }, icon('calendar_add', { size: 16 }), h('span', { class: 'ac-new-label' }, t('newEvent')));
    this.todayBtn = h('button', { class: 'btn ac-today', type: 'button', 'aria-label': t('goToday'), 'data-tip': this.tipWithKey(t('goToday'), 'T'), onclick: () => this.goToday() }, icon('calendar_today', { size: 16 }), h('span', { class: 'ac-today-label' }, t('today')));
    const prev = h('button', { class: 'btn subtle icon-btn ac-prev', type: 'button', 'aria-label': t('previous'), 'data-tip': t('previous'), onclick: () => this.step(-1) }, icon('chevron_left', { size: 16 }));
    const next = h('button', { class: 'btn subtle icon-btn ac-next', type: 'button', 'aria-label': t('next'), 'data-tip': t('next'), onclick: () => this.step(1) }, icon('chevron_right', { size: 16 }));
    this.titleText = h('span', { class: 'ac-title-text ellipsis' });
    this.titleBtn = h('button', { class: 'ac-title', type: 'button', 'aria-haspopup': 'dialog', onclick: () => this.pickMonth() }, this.titleText, icon('chevron_down', { size: 12 }));
    this.viewSeg = h(
      'div',
      { class: 'segmented ac-views', role: 'tablist', 'aria-label': t('viewLabel') },
      VIEWS.map((v, i) =>
        h(
          'button',
          {
            type: 'button',
            role: 'tab',
            dataset: { view: v },
            'data-tip': this.tipWithKey(t(`view.${v}`), String(i + 1)),
            onclick: () => this.setView(v),
          },
          icon(VIEW_ICONS[v], { size: 16 }),
          h('span', { class: 'ac-view-label' }, t(`view.${v}`)),
        ),
      ),
    );
    this.viewMenuBtn = h('button', { class: 'btn ac-view-menu', type: 'button', 'aria-haspopup': 'menu', onclick: (e) => this.viewMenu(e) });
    const more = h('button', { class: 'btn subtle icon-btn ac-more', type: 'button', 'aria-label': t('moreOptions'), 'data-tip': t('moreOptions'), onclick: (e) => this.moreMenu(e) }, icon('more_horizontal', { size: 16 }));
    this.toolbar = h(
      'div',
      { class: 'ac-toolbar', role: 'toolbar', 'aria-label': t('toolbarLabel') },
      this.paneBtn,
      this.newBtn,
      h('div', { class: 'vsep' }),
      this.todayBtn,
      h('div', { class: 'ac-nav' }, prev, next),
      this.titleBtn,
      h('div', { class: 'grow' }),
      this.viewSeg,
      this.viewMenuBtn,
      more,
    );

    // left pane
    this.mini = miniMonth(this, {
      month: this.state.date,
      selected: this.state.date,
      range: this.miniRange(),
      onPick: (d) => {
        this.goTo(d);
        if (this.root.classList.contains('pane-overlay')) this.togglePane(false);
      },
      onTitle: () => this.setView('month'),
    });
    this.calList = h('div', { class: 'ac-cals' });
    this.pane = h(
      'aside',
      { class: 'ac-pane', 'aria-label': t('paneLabel') },
      h('div', { class: 'ac-pane-mini' }, this.mini),
      this.calList,
      h('button', { class: 'btn subtle ac-add-cal', type: 'button', onclick: () => this.addCalendar() }, icon('add', { size: 16 }), h('span', null, t('addCalendar'))),
    );
    this.viewEl = h('div', { class: 'ac-view', tabindex: '-1' });
    this.snack = h('div', { class: 'ac-snack', role: 'status', 'aria-live': 'polite' });
    this.scrim = h('div', { class: 'ac-scrim', onclick: () => this.togglePane(false) });
    this.main = h('div', { class: 'ac-main' }, this.pane, this.scrim, h('main', { class: 'ac-content' }, this.viewEl));
    this.root = h('div', { class: 'ac-root', tabindex: '-1' }, this.toolbar, this.main, this.snack);
    this.win.body.appendChild(this.root);
    this.renderCalendars();
    this.onResize(true);
  }

  tipWithKey(label, key) {
    return `${label} (${key})`;
  }

  onResize(initial = false) {
    const w = this.win.body.clientWidth || 1000;
    const narrow = w < 900;
    const tiny = w < 700;
    const was = this.root.classList.contains('pane-overlay');
    this.root.classList.toggle('pane-overlay', narrow);
    this.root.classList.toggle('compact', tiny);
    this.root.classList.toggle('mini', w < 560);
    if (narrow && !was) this.root.classList.remove('pane-open-overlay');
    this.root.classList.toggle('pane-hidden', !narrow && !this.prefs.paneOpen);
    this.paneBtn.setAttribute('aria-expanded', String(narrow ? this.root.classList.contains('pane-open-overlay') : this.prefs.paneOpen));
    this.fitToolbar();
    if (!initial) this.viewHandle?.resize?.();
  }

  // Progressive toolbar compaction (French labels are longer): drop the view icons, then turn the view
  // switcher into a drop-down, then icon-only buttons, until the title is no longer cut.
  fitToolbar() {
    const levels = ['tb-noicons', 'tb-dropdown', 'tb-compact', 'tb-mini'];
    const root = this.root;
    if (!root || !this.titleText) return;
    for (const c of levels) root.classList.remove(c);
    this.updateTitle();
    if (!root.isConnected || !this.toolbar.clientWidth) return;
    const fits = () => this.toolbar.scrollWidth <= this.toolbar.clientWidth + 1 && this.titleText.scrollWidth <= this.titleText.clientWidth + 1;
    for (const c of levels) {
      if (fits()) break;
      root.classList.add(c);
      this.updateTitle();
    }
  }

  togglePane(force) {
    if (this.root.classList.contains('pane-overlay')) {
      const open = force ?? !this.root.classList.contains('pane-open-overlay');
      this.root.classList.toggle('pane-open-overlay', open);
      this.paneBtn.setAttribute('aria-expanded', String(open));
      if (open) setTimeout(() => this.mini.focusGrid(), 50);
      return;
    }
    this.prefs.paneOpen = force ?? !this.prefs.paneOpen;
    this.root.classList.toggle('pane-hidden', !this.prefs.paneOpen);
    this.paneBtn.setAttribute('aria-expanded', String(this.prefs.paneOpen));
    this.savePrefs();
    setTimeout(() => this.viewHandle?.resize?.(), 260);
  }

  calName(cal) {
    if (!cal) return '';
    if (cal.name) return cal.name;
    return this.t(`cal.${cal.id}`) || cal.id;
  }

  calendar(id) {
    return this.data.calendars.find((c) => c.id === id) || null;
  }

  userCalendars() {
    return this.data.calendars.filter((c) => c.kind === 'user');
  }

  renderCalendars() {
    const { h, icon, ui } = this.ctx;
    const t = this.t;
    ui.clear(this.calList);
    const group = (key, title, cals) => {
      const collapsed = !!this._collapsed?.[key];
      const list = h('div', { class: 'ac-cal-list', role: 'group', 'aria-label': title, hidden: collapsed });
      for (const c of cals) list.appendChild(this.calendarRow(c));
      return h(
        'section',
        { class: 'ac-cal-group', dataset: { group: key } },
        h(
          'button',
          {
            class: 'ac-cal-head',
            type: 'button',
            'aria-expanded': String(!collapsed),
            onclick: () => {
              this._collapsed = { ...(this._collapsed || {}), [key]: !collapsed };
              this.renderCalendars();
            },
          },
          icon(collapsed ? 'chevron_right' : 'chevron_down', { size: 12 }),
          h('span', { class: 'grow ellipsis' }, title),
        ),
        list,
      );
    };
    this.calList.append(group('mine', t('myCalendars'), this.userCalendars()), group('other', t('otherCalendars'), this.data.calendars.filter((c) => c.kind === 'holidays')));
  }

  calendarRow(c) {
    const { h, icon } = this.ctx;
    const t = this.t;
    const name = this.calName(c);
    const cb = h('input', {
      type: 'checkbox',
      checked: c.visible,
      'aria-label': t('showCalendar', { name }),
      onchange: () => this.setCalendarVisible(c.id, cb.checked),
    });
    const row = h(
      'div',
      { class: ['ac-cal-row', !c.visible && 'off'], style: css({ '--cal': c.color }), dataset: { cal: c.id }, oncontextmenu: (e) => this.calendarMenu(e, c) },
      h('label', { class: 'ac-cal-check' }, cb, h('span', { class: 'ac-cal-name ellipsis', title: name }, name)),
      h('button', { class: 'ac-cal-more', type: 'button', 'aria-label': t('calendarOptions', { name }), 'data-tip': t('calendarOptions', { name }), onclick: (e) => this.calendarMenu(e, c) }, icon('more_horizontal', { size: 16 })),
    );
    return row;
  }

  async calendarMenu(e, c) {
    const t = this.t;
    const user = c.kind === 'user';
    const n = this.data.events.filter((ev) => ev.calendarId === c.id).length;
    await this.ctx.ui.menu(e, [
      { label: t('editCalendar'), icon: 'edit', action: () => this.editCalendar(c) },
      { label: t('showOnly'), icon: 'eye', action: () => this.showOnly(c.id) },
      user ? { label: t('newEventIn'), icon: 'calendar_add', action: () => this.newEvent({ calendarId: c.id }) } : null,
      '-',
      user ? { label: t('importInto'), icon: 'arrow_import', action: () => importFlow(this, null, c.id) } : null,
      user ? { label: t('exportCalendar'), icon: 'arrow_export_ltr', disabled: !n, action: () => exportFlow(this, c.id) } : null,
      user ? '-' : null,
      user ? { label: t('deleteCalendar'), icon: 'delete', danger: true, disabled: this.userCalendars().length <= 1, action: () => this.deleteCalendar(c) } : null,
    ].filter(Boolean));
  }

  async setCalendarVisible(id, visible) {
    const c = this.calendar(id);
    if (!c) return;
    c.visible = visible;
    this.renderCalendars();
    this.render({ animate: false, keepScroll: true });
    await this.saveCalendars();
  }

  async showOnly(id) {
    for (const c of this.data.calendars) c.visible = c.id === id;
    this.renderCalendars();
    this.render({ animate: false, keepScroll: true });
    await this.saveCalendars();
  }

  async addCalendar() {
    const res = await calendarDialog(this, null);
    if (!res) return;
    const id = newId('c');
    this.data.calendars.splice(this.userCalendars().length, 0, { id, name: res.name, color: res.color, visible: true, kind: 'user' });
    this.renderCalendars();
    await this.saveCalendars();
    this.toast(this.t('calendarAdded', { name: res.name }));
    return id;
  }

  async editCalendar(c) {
    const res = await calendarDialog(this, c);
    if (!res) return;
    if (c.kind === 'user') c.name = res.name;
    c.color = res.color;
    this.renderCalendars();
    this.render({ animate: false, keepScroll: true });
    await this.saveCalendars();
  }

  async deleteCalendar(c) {
    const n = this.data.events.filter((ev) => ev.calendarId === c.id).length;
    const ok = await this.ctx.ui.confirm(n ? this.t('deleteCalendarConfirmN', { name: this.calName(c), count: n }) : this.t('deleteCalendarConfirm', { name: this.calName(c) }), {
      title: this.t('deleteCalendar'),
      okLabel: this.t('delete'),
      danger: true,
      parent: this.win,
    });
    if (!ok) return;
    this.data.calendars = this.data.calendars.filter((x) => x.id !== c.id);
    this.data.events = this.data.events.filter((ev) => ev.calendarId !== c.id);
    if (this.prefs.defaultCalendar === c.id) this.prefs.defaultCalendar = this.userCalendars()[0]?.id || 'personal';
    this.state.selected = null;
    this.renderCalendars();
    this.render({ animate: false, keepScroll: true });
    await Promise.all([this.saveCalendars(), this.saveEvents(), this.savePrefs()]);
  }

  // ------------------------------------------------------------------ menus
  viewMenu(e) {
    const t = this.t;
    this.ctx.ui.menu(
      e,
      VIEWS.map((v, i) => ({ label: t(`view.${v}`), icon: VIEW_ICONS[v], shortcut: String(i + 1), checked: this.state.view === v, action: () => this.setView(v) })),
    );
  }

  moreMenu(e) {
    const t = this.t;
    this.ctx.ui.menu(e, [
      { label: t('importIcs'), icon: 'arrow_import', action: () => importFlow(this) },
      { label: t('exportAll'), icon: 'arrow_export_ltr', disabled: !this.data.events.length, action: () => exportFlow(this, null) },
      '-',
      { label: t('weekNumbers'), checked: !!this.prefs.weekNumbers, action: () => this.setPref('weekNumbers', !this.prefs.weekNumbers) },
      { label: t('shortcuts'), icon: 'keyboard', shortcut: '?', action: () => shortcutsDialog(this) },
      { label: t('settings'), icon: 'settings', action: () => settingsDialog(this) },
    ]);
  }

  async setPref(key, value) {
    this.prefs[key] = value;
    this.mini.setState({});
    this.render({ animate: false, keepScroll: true });
    await this.savePrefs();
  }

  pickMonth() {
    const mm = miniMonth(this, {
      month: this.state.date,
      selected: this.state.date,
      range: this.miniRange(),
      onPick: (d) => {
        pop.close('pick');
        this.goTo(d);
      },
    });
    const pop = openPopover({ anchor: this.titleBtn, content: mm, className: 'ac-pop-date', owner: this.win, label: this.t('pickDate'), focus: () => mm.querySelector('.ac-mini-day.selected') });
  }

  // ------------------------------------------------------------------ navigation
  visibleRange(view = this.state.view, date = this.state.date) {
    const d = startOfDay(date);
    switch (view) {
      case 'day':
        return [d, addDays(d, 1)];
      case 'workweek': {
        const ws = startOfWeek(d, 1);
        const days = this.workDays(ws);
        return [days[0], addDays(days[days.length - 1], 1)];
      }
      case 'week': {
        const ws = startOfWeek(d, this.firstDay());
        return [ws, addDays(ws, 7)];
      }
      case 'month': {
        const ms = new Date(d.getFullYear(), d.getMonth(), 1);
        const gs = startOfWeek(ms, this.firstDay());
        const dim = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
        const weeks = Math.ceil((localDayNum(ms) - localDayNum(gs) + dim) / 7);
        return [gs, addDays(gs, weeks * 7)];
      }
      case 'agenda':
      default:
        return [d, addDays(d, this.agendaDays)];
    }
  }

  // The days highlighted in the mini month: the visible week(s) in Day / Week views only.
  miniRange() {
    if (this.state.search || this.state.view === 'month' || this.state.view === 'agenda' || this.state.view === 'day') return null;
    return this.visibleRange();
  }

  // Work week days starting at the Monday-based week of `ws`, in display order from the first day.
  workDays(ws) {
    const wd = this.prefs.workDays.length ? this.prefs.workDays : [1, 2, 3, 4, 5];
    const first = this.firstDay();
    const order = [...wd].sort((a, b) => ((a - first + 7) % 7) - ((b - first + 7) % 7));
    const base = startOfWeek(ws, first);
    return order.map((w) => addDays(base, (w - first + 7) % 7));
  }

  setView(v) {
    if (!VIEWS.includes(v)) return;
    if (this.state.search) {
      this.searchInput.value = '';
      this.state.search = '';
    }
    if (v === this.state.view) {
      this.render({ animate: false, keepScroll: true });
      return;
    }
    this.state.view = v;
    this.prefs.view = v;
    this.savePrefs();
    this.render({ animate: 'view' });
  }

  step(dir) {
    const d = this.state.date;
    let next;
    switch (this.state.view) {
      case 'day':
        next = addDays(d, dir);
        break;
      case 'workweek':
      case 'week':
        next = addDays(d, 7 * dir);
        break;
      case 'month':
        next = addMonths(new Date(d.getFullYear(), d.getMonth(), 1), dir);
        // landing on the current month selects today (Outlook)
        if (next.getMonth() === new Date().getMonth() && next.getFullYear() === new Date().getFullYear()) next = new Date();
        break;
      default:
        next = addDays(d, this.agendaDays * dir);
    }
    this.state.date = startOfDay(next);
    this.render({ animate: dir > 0 ? 'next' : 'prev' });
  }

  goTo(date, { keepSelection = false } = {}) {
    const d = startOfDay(date);
    const [a, b] = this.visibleRange();
    const dir = d < a ? 'prev' : d >= b ? 'next' : false;
    this.state.date = d;
    if (!keepSelection) this.state.selected = null;
    if (this.state.search) {
      this.state.search = '';
      this.searchInput.value = '';
    }
    this.render({ animate: dir, keepScroll: !dir });
  }

  goToday() {
    this.goTo(new Date());
    this.viewHandle?.scrollToNow?.();
  }

  setSearch(q) {
    q = String(q || '').trim();
    if (q === this.state.search) return;
    this.state.search = q;
    this.render({ animate: false });
  }

  focusView() {
    const el = this.viewEl.querySelector('.ac-ev.selected, .ac-chip.selected, [data-focus-target]') || this.viewEl;
    el.focus({ preventScroll: true });
  }

  // ------------------------------------------------------------------ rendering
  updateTitle() {
    if (!this.titleText) return;
    const [a, b] = this.visibleRange();
    const last = addDays(b, -1);
    const compact = this.root?.classList.contains('tb-compact');
    let text;
    if (this.state.search) text = this.t('searchResults');
    else if (this.state.view === 'day') text = compact ? this.fmt.monthDayShort(a) : this.fmt.monthDayYear(a);
    else if (this.state.view === 'month') text = compact ? this.fmt.monthShortYear(this.state.date) : this.fmt.monthYear(this.state.date);
    else if (this.state.view === 'agenda') text = compact ? this.fmt.monthDayShort(a) : this.t('agendaFrom', { date: this.fmt.dayLongNoYear(a) });
    else text = this.fmt.rangeTitle(a, last);
    this.titleText.textContent = text;
    this.titleBtn.setAttribute('aria-label', `${text}. ${this.t('pickDate')}`);
    this.titleBtn.title = this.state.view === 'month' || this.state.search ? '' : `${this.fmt.dayMed(a)} – ${this.fmt.dayMed(last)}`;
  }

  render({ animate = false, keepScroll = false } = {}) {
    const { ui } = this.ctx;
    // flyouts point at elements of the old view
    closeAllPopovers('render');
    const view = this.state.view;
    for (const b of this.viewSeg.children) {
      const on = b.dataset.view === view && !this.state.search;
      b.classList.toggle('selected', on);
      b.setAttribute('aria-selected', String(on));
    }
    this.ctx.ui.clear(this.viewMenuBtn);
    this.viewMenuBtn.append(this.ctx.icon(VIEW_ICONS[view], { size: 16 }), this.h('span', { class: 'ac-view-menu-label' }, this.t(`view.${view}`)), this.ctx.icon('chevron_down', { size: 12 }));
    this.viewMenuBtn.setAttribute('aria-label', `${this.t('viewLabel')}: ${this.t(`view.${view}`)}`);
    this.searchClear.hidden = !this.searchInput.value;
    this.root.classList.toggle('searching', !!this.state.search);
    this.fitToolbar();
    this.mini?.setState({ month: this.state.date, selected: this.state.date, range: this.miniRange() });

    if (!keepScroll) this.tgScroll = null;
    else if (this.viewHandle?.scrollTop != null) this.tgScroll = this.viewHandle.scrollTop();
    const hadFocus = this.viewEl.contains(document.activeElement);
    this.viewHandle?.destroy?.();
    let handle;
    try {
      if (this.state.search) handle = renderSearch(this, this.state.search);
      else if (view === 'month') handle = renderMonth(this);
      else if (view === 'agenda') handle = renderAgenda(this);
      else {
        const [a, b] = this.visibleRange();
        const days = view === 'workweek' ? this.workDays(a) : [];
        if (!days.length) for (let d = a; d < b; d = addDays(d, 1)) days.push(d);
        handle = renderTimeGrid(this, days);
      }
    } catch (err) {
      console.error('[calendar] render failed', err);
      handle = { el: this.h('div', { class: 'empty' }, this.ctx.icon('error_circle', { size: 48 }), this.h('div', null, this.t('renderError')), this.h('div', { class: 'caption mono selectable' }, String(err?.message || err))) };
    }
    ui.clear(this.viewEl);
    this.viewEl.appendChild(handle.el);
    this.viewHandle = handle;
    this.viewEl.dataset.view = this.state.search ? 'search' : view;
    handle.mounted?.();
    if (hadFocus) this.focusView();
    if (animate && !this.reduceMotion()) {
      const frames =
        animate === 'next'
          ? [{ transform: 'translateX(40px)', opacity: 0 }, { transform: 'none', opacity: 1 }]
          : animate === 'prev'
            ? [{ transform: 'translateX(-40px)', opacity: 0 }, { transform: 'none', opacity: 1 }]
            : [{ transform: 'translateY(12px) scale(0.99)', opacity: 0 }, { transform: 'none', opacity: 1 }];
      handle.el.animate(frames, { duration: animate === 'view' ? 260 : 300, easing: 'cubic-bezier(0.1,0.9,0.2,1)' });
    }
  }

  occurrences(from, to) {
    return visibleOccurrences(this.data, from.getTime?.() ?? from, to.getTime?.() ?? to, this.ctx.lang);
  }

  isSelected(o) {
    const s = this.state.selected;
    return !!s && s.eventId === o.eventId && String(s.key) === String(o.key);
  }

  // ------------------------------------------------------------------ selection & flyouts
  select(o, anchor, { peek = true } = {}) {
    this.state.selected = o ? { eventId: o.eventId, key: o.key } : null;
    for (const el of this.viewEl.querySelectorAll('.selected[data-event-id]')) el.classList.remove('selected');
    if (o) for (const el of this.viewEl.querySelectorAll(`[data-event-id="${CSS.escape(o.eventId)}"][data-key="${CSS.escape(String(o.key))}"]`)) el.classList.add('selected');
    if (o && peek) showPeek(this, o, anchor);
  }

  selectedOccurrence() {
    const s = this.state.selected;
    if (!s) return null;
    if (s.eventId.startsWith('hol-')) {
      const d = localFromKey(s.key);
      return d ? this.occurrences(d, addDays(d, 1)).find((o) => o.eventId === s.eventId) || null : null;
    }
    const ev = this.data.events.find((e) => e.id === s.eventId);
    if (!ev) return null;
    const o = occurrenceAt(ev, s.key);
    if (o) o.color = o.color || this.calendar(o.calendarId)?.color || PALETTE[0];
    return o;
  }

  peekSelected() {
    const o = this.selectedOccurrence();
    if (!o) return;
    const el = this.viewEl.querySelector(`[data-event-id="${CSS.escape(o.eventId)}"][data-key="${CSS.escape(String(o.key))}"]`);
    el?.scrollIntoView?.({ block: 'nearest' });
    showPeek(this, o, el || this.viewEl);
  }

  // Start a new event: full editor (from the toolbar / N key) or quick create (from the grid).
  newEvent({ start, end, allDay, date, calendarId, quick = false, anchor, onClose } = {}) {
    closeAllPopovers('new');
    const def = this.defaultSlot(date);
    const draft = {
      start: start ?? def.start,
      end: end ?? def.end,
      allDay: !!allDay,
      calendarId: this.calendar(calendarId)?.kind === 'user' ? calendarId : this.defaultCalendarId(),
    };
    if (quick && anchor) return quickCreate(this, draft, anchor, onClose);
    onClose?.();
    return openEditor(this, { draft });
  }

  defaultCalendarId() {
    const c = this.calendar(this.prefs.defaultCalendar);
    if (c?.kind === 'user') return c.id;
    return this.userCalendars()[0]?.id || 'personal';
  }

  // Next half hour today, or the start of the working day on another selected date.
  defaultSlot(date) {
    const d = startOfDay(date || this.state.date);
    const now = new Date();
    let s;
    if (sameDay(d, now)) {
      s = new Date(now);
      s.setSeconds(0, 0);
      s.setMinutes(Math.ceil((s.getMinutes() + 1) / 30) * 30);
    } else {
      s = new Date(d);
      s.setHours(this.prefs.workStart || 9, 0, 0, 0);
    }
    return { start: s.getTime(), end: s.getTime() + (this.prefs.defaultDuration || 30) * 60000 };
  }

  async edit(o) {
    if (!o || o.readOnly) return;
    const ev = this.data.events.find((e) => e.id === o.eventId);
    if (!ev) return;
    closeAllPopovers('edit');
    let mode = 'series';
    if (ev.rrule) {
      mode = await askSeries(this, 'edit');
      if (!mode) return;
    }
    return openEditor(this, { ev, occ: o, mode });
  }

  // ------------------------------------------------------------------ mutations
  snapshot() {
    return JSON.parse(JSON.stringify(this.data.events));
  }

  async commit(events, { undoLabel = null, before = null, select = undefined, render = true } = {}) {
    this.data.events = events;
    if (select !== undefined) this.state.selected = select;
    if (render) this.render({ animate: false, keepScroll: true });
    if (undoLabel && before) {
      this.toast(undoLabel, async () => {
        await this.commit(before, { render: true });
      });
    }
    await this.saveEvents();
  }

  // Create or replace an event (from the editor or quick create).
  async upsert(ev, { toastLabel } = {}) {
    const clean = sanitizeEvent(ev);
    if (!clean) return null;
    const before = this.snapshot();
    const list = this.data.events.filter((e) => e.id !== clean.id);
    list.push(clean);
    const first = firstOccurrence(clean);
    await this.commit(list, { select: first ? { eventId: clean.id, key: first.key } : null, undoLabel: toastLabel || null, before });
    return clean;
  }

  async applyOccurrenceEdit(o, changes) {
    const ev = this.data.events.find((e) => e.id === o.eventId);
    if (!ev) return;
    const before = this.snapshot();
    const next = updateOccurrence(ev, o.key, changes);
    const list = this.data.events.map((e) => (e.id === ev.id ? next : e));
    await this.commit(list, { select: { eventId: ev.id, key: o.key }, before });
  }

  async applySeriesEdit(ev, changes) {
    const before = this.snapshot();
    const next = updateSeries(ev, changes);
    if (!next) return;
    const list = this.data.events.map((e) => (e.id === ev.id ? next : e));
    const first = firstOccurrence(next);
    await this.commit(list, { select: first ? { eventId: next.id, key: first.key } : null, before });
  }

  // Drag & drop / resize result. newStart/newEnd are local epoch ms (timed) or Date (all-day: day granularity).
  async moveOcc(o, newStart, newEnd) {
    if (o.readOnly) return;
    const ev = this.data.events.find((e) => e.id === o.eventId);
    if (!ev) return;
    let s;
    let e;
    if (ev.allDay) {
      s = localKey(newStart);
      e = localKey(newEnd);
      if (e <= s) e = keyFromDayNum(localDayNum(newStart) + 1);
    } else {
      s = Math.round(newStart);
      e = Math.max(s, Math.round(newEnd));
    }
    if (ev.allDay ? s === o.startKey && e === o.endKey : s === o.start && e === o.end) return;
    const before = this.snapshot();
    const next = moveOccurrence(ev, o.key, s, e);
    if (!next) return;
    // moving a single event keeps it selected (its key is its new start)
    const key = ev.rrule ? o.key : String(next.start);
    const list = this.data.events.map((x) => (x.id === ev.id ? next : x));
    await this.commit(list, { select: { eventId: ev.id, key }, undoLabel: this.t('eventMoved'), before });
  }

  async deleteOcc(o) {
    if (!o || o.readOnly) return;
    const ev = this.data.events.find((e) => e.id === o.eventId);
    if (!ev) return;
    closeAllPopovers('delete');
    const before = this.snapshot();
    let list;
    if (!ev.rrule) list = this.data.events.filter((e) => e.id !== ev.id);
    else {
      const choice = await askDeleteSeries(this, o);
      if (!choice) return;
      let next = null;
      if (choice === 'one') next = deleteOccurrence(ev, o.key);
      else if (choice === 'following') next = truncateSeries(ev, o.key);
      list = next ? this.data.events.map((e) => (e.id === ev.id ? next : e)) : this.data.events.filter((e) => e.id !== ev.id);
    }
    await this.commit(list, { select: null, undoLabel: this.t('eventDeleted'), before });
    this.focusView();
  }

  // ------------------------------------------------------------------ persistence
  persist(name, value) {
    const run = () =>
      this.ctx.storage.set(name, value).catch((err) => {
        console.error('[calendar] save failed', err);
        this.ctx.ui.alert(this.t('saveFailed', { msg: err?.message || String(err) }), { title: this.t('appName'), parent: this.win });
      });
    this.saveChain = this.saveChain.then(run, run);
    return this.saveChain;
  }

  async saveEvents() {
    const p = this.persist('events', this.data.events);
    this.syncReminders();
    return p;
  }

  saveCalendars() {
    return this.persist('calendars', this.data.calendars);
  }

  savePrefs() {
    return this.persist('prefs', this.data.prefs);
  }

  syncReminders() {
    const reminders = this.ctx.shell?.reminders;
    if (!reminders) return Promise.resolve();
    return syncReminders({ reminders, events: this.data.events, lang: this.ctx.lang, hour12: this.fmt.hour12() }).catch((err) => console.error('[calendar] reminder sync failed', err));
  }

  replaceData({ calendars, events, prefs }) {
    if (calendars) this.data.calendars = sanitizeCalendars(calendars, this.ctx.lang);
    if (events) this.data.events = events;
    if (prefs) this.data.prefs = sanitizePrefs(prefs);
  }

  // ------------------------------------------------------------------ snackbar
  toast(text, undo) {
    const { h, icon, ui } = this.ctx;
    clearTimeout(this._snackT);
    ui.clear(this.snack);
    // (Element.append would print "null" for a missing button: build the list first)
    const parts = [
      h('span', { class: 'grow' }, text),
      undo
        ? h(
            'button',
            {
              class: 'btn subtle ac-undo',
              type: 'button',
              onclick: async () => {
                this.hideToast();
                await undo();
              },
            },
            this.t('undo'),
          )
        : null,
      h('button', { class: 'btn subtle icon-btn', type: 'button', 'aria-label': this.t('dismiss'), onclick: () => this.hideToast() }, icon('dismiss', { size: 12 })),
    ];
    this.snack.append(...parts.filter(Boolean));
    this.snack.classList.add('show');
    this._snackT = setTimeout(() => this.hideToast(), undo ? 8000 : 4000);
  }

  hideToast() {
    clearTimeout(this._snackT);
    this.snack.classList.remove('show');
  }

  // ------------------------------------------------------------------ keyboard
  onKey(e) {
    const tag = e.target.tagName;
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable;
    if (e.defaultPrevented) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === 'f' || e.key === 'e')) {
      e.preventDefault();
      this.searchInput.focus();
      this.searchInput.select();
      return;
    }
    if (mod && e.key === 'n') {
      e.preventDefault();
      this.newEvent();
      return;
    }
    if (typing || e.altKey || mod) {
      if (e.altKey && !mod && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !typing) {
        e.preventDefault();
        this.step(e.key === 'ArrowLeft' ? -1 : 1);
      }
      return;
    }
    const k = e.key;
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (k === 'n' || k === 'N') {
      handled();
      this.newEvent();
    } else if (k === 't' || k === 'T') {
      handled();
      this.goToday();
    } else if (/^[1-5]$/.test(k)) {
      handled();
      this.setView(VIEWS[Number(k) - 1]);
    } else if (k === '/') {
      handled();
      this.searchInput.focus();
    } else if (k === '?') {
      handled();
      shortcutsDialog(this);
    } else if (k === 'PageUp' || k === 'PageDown') {
      handled();
      this.step(k === 'PageUp' ? -1 : 1);
    } else if (k === 'Delete' || k === 'Backspace') {
      const o = this.selectedOccurrence();
      if (o && !o.readOnly) {
        handled();
        this.deleteOcc(o);
      }
    } else if (k === 'Enter' && !e.target.closest('button, [role="button"]')) {
      handled();
      const o = this.selectedOccurrence();
      if (o) this.edit(o);
      else this.newEvent({ date: this.state.date });
    } else if (k === 'Escape') {
      if (this.state.selected) {
        handled();
        this.select(null);
      } else if (this.root.classList.contains('pane-open-overlay')) {
        handled();
        this.togglePane(false);
      }
    } else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(k)) {
      if (e.target.closest('.ac-mini, .ac-pane, .ac-toolbar, .ac-ag-row, .ac-views')) return;
      handled();
      const d = this.state.date;
      const delta = this.state.view === 'agenda' ? { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -1, ArrowDown: 1 }[k] : this.state.view === 'day' && (k === 'ArrowUp' || k === 'ArrowDown') ? { ArrowUp: -1, ArrowDown: 1 }[k] : { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[k];
      this.goTo(addDays(d, delta));
      this.viewEl.focus({ preventScroll: true });
    }
  }
}

