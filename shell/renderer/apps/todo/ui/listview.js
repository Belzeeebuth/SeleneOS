// Main pane: themed header (title, "…" list options, Sort / Group / Suggestions), sort chip, info bars,
// "Add a task" box with due / reminder / repeat quick buttons, and the task rows (grouped sections,
// collapsible Completed section, FLIP animations, keyboard navigation, multi-select, drag to reorder or
// onto a list in the nav).
import * as D from '../lib/dates.js';
import { DEFAULT_LIST, viewTasks, sortTasks, sortDone, plannedGroups, groupByList, groupByDue, search, matchRanges, SORTS } from '../lib/store.js';
import { SMART_ICONS } from './app.js';
import { snapshot, playFlip, fadeIn, reduceMotion, EASE } from './anim.js';
import { beginDrag, liveReorder } from './drag.js';

const NO_ADD = new Set(['completed', 'assigned', 'search']);
const NO_SORT = new Set(['planned', 'completed', 'assigned', 'search']);
const EMPTY_ICON = { myday: 'weather_sunny', important: 'star', planned: 'calendar_ltr', assigned: 'person', all: 'infinity', completed: 'checkmark_circle', search: 'search' };

export class ListView {
  constructor(app) {
    this.app = app;
    this.collapsed = new Set();
    this.add = { due: null, remindAt: null, repeat: null };
    this.el = this._build();
  }

  get t() {
    return this.app.t;
  }

  // ---------------------------------------------------------------- skeleton
  _build() {
    const { h, t, icon } = this.app;
    this.burger = h('button', { type: 'button', class: 'btn subtle icon-btn td-burger', 'aria-label': t('nav.toggle'), 'data-tip': t('nav.toggle'), onclick: () => this.app.toggleNav() }, icon('line_horizontal_3'));
    this.titleIcon = h('span', { class: 'td-title-icon', 'aria-hidden': 'true' });
    this.titleEl = h('h1', { class: 'td-title', id: `${this.app.win.id}-title` });
    this.moreBtn = h('button', { type: 'button', class: 'btn subtle icon-btn td-more', 'aria-label': t('toolbar.listOptions'), 'data-tip': t('toolbar.listOptions'), onclick: (e) => this.app.listMenu(e, this.app.view) }, icon('more_horizontal'));
    this.sortBtn = h('button', { type: 'button', class: 'btn subtle td-tool td-sort-btn', 'aria-label': t('toolbar.sort'), 'data-tip': t('toolbar.sort'), onclick: (e) => this.sortMenu(e) }, icon('arrow_sort'), h('span', { class: 'td-tool-label' }, t('toolbar.sort')));
    this.groupBtn = h('button', { type: 'button', class: 'btn subtle td-tool td-group-btn', 'aria-label': t('toolbar.group'), 'data-tip': t('toolbar.group'), onclick: (e) => this.groupMenu(e) }, icon('group_list'), h('span', { class: 'td-tool-label' }, t('toolbar.group')));
    this.suggestBtn = h('button', { type: 'button', class: 'btn subtle td-tool td-suggest-btn', 'aria-label': t('toolbar.suggestions'), 'data-tip': t('toolbar.suggestions'), onclick: () => this.app.toggleSuggestions() }, icon('lightbulb'), h('span', { class: 'td-tool-label' }, t('toolbar.suggestions')));
    this.subtitle = h('div', { class: 'td-subtitle' });
    this.head = h(
      'header',
      { class: 'td-head' },
      h('div', { class: 'td-head-row' }, this.burger, h('div', { class: 'td-title-wrap' }, this.titleIcon, this.titleEl, this.moreBtn), h('div', { class: 'td-tools' }, this.sortBtn, this.groupBtn, this.suggestBtn)),
      this.subtitle,
    );
    this.titleEl.addEventListener('click', () => this.editTitle(false));
    this.titleEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'F2') {
        e.preventDefault();
        this.editTitle(true);
      }
    });
    const pickIcon = () => {
      const v = this.app.view;
      if (v.startsWith('list:') && v !== `list:${DEFAULT_LIST}`) this.app.changeEmoji(this.titleIcon, v.slice(5));
    };
    this.titleIcon.addEventListener('click', pickIcon);
    // keyboard: the icon of a user list is a button (Enter / Space open the emoji picker, focus comes back to it)
    this.titleIcon.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && this.titleIcon.classList.contains('clickable')) {
        e.preventDefault();
        pickIcon();
      }
    });
    this.chipSlot = h('div', { class: 'td-chip-slot' });
    this.bannerSlot = h('div', { class: 'td-banner-slot' });
    this.addEl = this._buildAdd();
    this.body = h('div', { class: 'td-body' });
    this.scroller = h('div', { class: 'td-scroll', tabindex: '-1' }, this.body);
    this.body.addEventListener('keydown', (e) => this._keys(e));
    this.bg = h('div', { class: 'td-main-bg', 'aria-hidden': 'true' });
    return h('main', { class: 'td-main', 'aria-labelledby': `${this.app.win.id}-title` }, this.bg, this.head, this.chipSlot, this.bannerSlot, this.addEl, this.scroller);
  }

  _buildAdd() {
    const { h, t, icon } = this.app;
    this.addInput = h('input', {
      class: 'td-add-input',
      type: 'text',
      placeholder: t('add.placeholder'),
      'aria-label': t('add.placeholder'),
      maxlength: '400',
      spellcheck: true,
      oninput: () => this._paintAdd(),
      onfocus: () => this._paintAdd(),
      onblur: () => setTimeout(() => this._paintAdd(), 150),
      onkeydown: (e) => {
        if (e.key === 'Enter' && !e.isComposing) {
          e.preventDefault();
          this.submitAdd();
        } else if (e.key === 'Escape' && (this.addInput.value || this._hasAddChips())) {
          e.preventDefault();
          e.stopPropagation();
          this.resetAdd();
        } else if (e.key === 'ArrowDown' && !this.addInput.value) {
          e.preventDefault();
          const first = this.body.querySelector('.td-task');
          if (first) this.focusRow(first.dataset.id);
        }
      },
    });
    const btn = (cls, ic, label, fn) =>
      h('button', { type: 'button', class: ['btn subtle td-add-opt', cls], 'aria-label': label, 'data-tip': label, onmousedown: (e) => e.preventDefault(), onclick: fn }, icon(ic), h('span', { class: 'td-add-opt-label' }));
    this.addDue = btn('td-add-due', 'calendar_ltr', t('add.due'), async (e) => {
      const v = await this.app.dueMenu(e.currentTarget, this.add.due);
      if (v !== undefined) this.add.due = v;
      if (!this.add.due) this.add.repeat = null;
      this._paintAdd();
      this.addInput.focus();
    });
    this.addRemind = btn('td-add-remind', 'alert', t('add.remind'), async (e) => {
      const v = await this.app.reminderMenu(e.currentTarget, this.add.remindAt);
      if (v !== undefined) this.add.remindAt = v;
      this._paintAdd();
      this.addInput.focus();
    });
    this.addRepeat = btn('td-add-repeat', 'arrow_repeat_all', t('add.repeat'), async (e) => {
      const v = await this.app.repeatMenu(e.currentTarget, this.add.repeat, this.add.due);
      if (v !== undefined) {
        this.add.repeat = v;
        if (v && !this.add.due) this.add.due = D.alignDue(this.app.today(), v, this.app.weekStart);
      }
      this._paintAdd();
      this.addInput.focus();
    });
    this.addSubmit = h('button', { type: 'button', class: 'btn td-add-submit', disabled: true, onmousedown: (e) => e.preventDefault(), onclick: () => this.submitAdd() }, t('add.add'));
    this.addIcon = h('button', { type: 'button', class: 'td-add-icon', tabindex: '-1', 'aria-hidden': 'true', onclick: () => this.addInput.focus() }, icon('add', { class: 'td-add-plus' }), h('span', { class: 'td-add-ring' }));
    return h(
      'div',
      { class: 'td-add' },
      h('div', { class: 'td-add-main' }, this.addIcon, this.addInput),
      h('div', { class: 'td-add-bar' }, this.addDue, this.addRemind, this.addRepeat, h('div', { class: 'grow' }), this.addSubmit),
    );
  }

  _hasAddChips() {
    return !!(this.add.due || this.add.remindAt || this.add.repeat);
  }

  _paintAdd() {
    const { app } = this;
    const active = document.activeElement === this.addInput || !!this.addInput.value || this._hasAddChips() || this.addEl.contains(document.activeElement);
    this.addEl.classList.toggle('active', active);
    this.addSubmit.disabled = !this.addInput.value.trim();
    const set = (b, label, on, tone) => {
      b.classList.toggle('set', !!on);
      b.classList.toggle('overdue', tone === 'overdue');
      b.querySelector('.td-add-opt-label').textContent = on ? label : '';
    };
    const ds = this.add.due ? D.dueState(this.add.due, app.now()) : null;
    set(this.addDue, this.add.due ? app.fmt.dueLong(this.add.due) : '', this.add.due, ds);
    set(this.addRemind, this.add.remindAt ? app.fmt.reminderShort(this.add.remindAt) : '', this.add.remindAt);
    set(this.addRepeat, this.add.repeat ? app.fmt.repeat(this.add.repeat) : '', this.add.repeat);
  }

  resetAdd() {
    this.addInput.value = '';
    this.add = { due: null, remindAt: null, repeat: null };
    this._paintAdd();
  }

  canAdd() {
    return !NO_ADD.has(this.app.view) && this.app.view !== 'settings';
  }

  focusAdd() {
    if (!this.canAdd()) return;
    this.addInput.focus();
    this.addInput.select();
  }

  submitAdd() {
    const { app } = this;
    const title = this.addInput.value.trim();
    if (!title) return null;
    const v = app.view;
    const fields = { title, due: this.add.due, remindAt: this.add.remindAt, repeat: this.add.repeat };
    if (v.startsWith('list:')) fields.listId = v.slice(5);
    if (v === 'myday') fields.myDay = true;
    if (v === 'important') fields.important = true;
    if (v === 'planned' && !fields.due) fields.due = app.today();
    const task = app.addTask(fields);
    this.resetAdd();
    this.addInput.focus();
    if (task) {
      app.focusId = task.id;
      requestAnimationFrame(() => this.rowEl(task.id)?.scrollIntoView({ block: 'nearest' }));
    }
    return task;
  }

  // ---------------------------------------------------------------- view change
  viewChanged(changed) {
    const { app } = this;
    if (changed) {
      this.resetAdd();
      this.scroller.scrollTop = 0;
      this.editing?.(false);
      requestAnimationFrame(() => fadeIn(this.body, { y: 16 }));
    }
    this.addEl.hidden = !this.canAdd();
    this.el.hidden = app.view === 'settings';
    if (app.settingsView) app.settingsView.el.hidden = app.view !== 'settings';
  }

  // ---------------------------------------------------------------- header
  renderHeader() {
    const { app } = this;
    const { h, t } = app;
    const v = app.view;
    const th = v === 'search' ? { color: 'accent', bg: null } : app.themeOf(v);
    const main = this.el;
    for (const c of [...main.classList]) if (c.startsWith('td-c-') || c.startsWith('td-bg-')) main.classList.remove(c);
    main.classList.add(`td-c-${th.color}`);
    // the detail / suggestions panes and popovers use the colour of the current list too
    for (const c of [...app.root.classList]) if (c.startsWith('td-c-')) app.root.classList.remove(c);
    app.root.classList.add(`td-c-${th.color}`);
    if (th.bg) main.classList.add(`td-bg-${th.bg}`, 'has-bg');
    else main.classList.remove('has-bg');
    if (!this._editingTitle) this.titleEl.textContent = app.viewTitle(v);
    const isUser = v.startsWith('list:') && v !== `list:${DEFAULT_LIST}`;
    this.titleEl.tabIndex = isUser ? 0 : -1;
    this.titleEl.classList.toggle('editable', isUser);
    if (isUser) this.titleEl.dataset.tip = t('list.clickToRename');
    else delete this.titleEl.dataset.tip;
    app.ui.clear(this.titleIcon);
    const list = v.startsWith('list:') ? app.store.list(v.slice(5)) : null;
    if (list?.emoji) {
      this.titleIcon.append(list.emoji);
      this.titleIcon.className = 'td-title-icon emoji';
    } else if (SMART_ICONS[v]) {
      this.titleIcon.append(app.icon(SMART_ICONS[v], { filled: v === 'important' }));
      this.titleIcon.className = 'td-title-icon';
    } else if (v === 'search') {
      this.titleIcon.className = 'td-title-icon';
      this.titleIcon.append(app.icon('search'));
    } else this.titleIcon.className = 'td-title-icon empty';
    if (isUser) {
      this.titleIcon.dataset.tip = t('menu.changeIcon');
      this.titleIcon.setAttribute('role', 'button');
      this.titleIcon.setAttribute('aria-label', t('menu.changeIcon'));
      this.titleIcon.removeAttribute('aria-hidden');
      this.titleIcon.tabIndex = 0;
    } else {
      delete this.titleIcon.dataset.tip;
      this.titleIcon.removeAttribute('role');
      this.titleIcon.removeAttribute('aria-label');
      this.titleIcon.removeAttribute('tabindex');
      this.titleIcon.setAttribute('aria-hidden', 'true');
    }
    this.titleIcon.classList.toggle('clickable', isUser);
    this.subtitle.textContent = v === 'myday' ? app.fmt.longToday() : '';
    this.subtitle.hidden = v !== 'myday';
    const prefs = app.store.viewPrefs(v);
    this.moreBtn.hidden = v === 'search';
    this.sortBtn.hidden = NO_SORT.has(v);
    this.groupBtn.hidden = ['planned', 'assigned', 'search'].includes(v);
    this.groupBtn.classList.toggle('on', !!prefs.groupBy && prefs.groupBy !== 'none' && !['all', 'completed'].includes(v));
    this.suggestBtn.hidden = v !== 'myday';
    this.suggestBtn.classList.toggle('on', app.suggestOpen);
    this.suggestBtn.setAttribute('aria-pressed', String(app.suggestOpen));
    // sort chip
    app.ui.clear(this.chipSlot);
    if (prefs.sort && !NO_SORT.has(v)) {
      const s = prefs.sort;
      this.chipSlot.appendChild(
        h(
          'div',
          { class: 'td-sortchip' },
          h(
            'button',
            { type: 'button', class: 'td-chip-main', 'aria-label': t('toolbar.reverse'), 'data-tip': t('toolbar.reverse'), onclick: () => app.store.setViewPref(v, { sort: { by: s.by, dir: s.dir === 'desc' ? 'asc' : 'desc' } }) },
            h('span', null, t('sort.sortedBy', { by: t(`sort.${s.by}`) })),
            app.icon(s.dir === 'desc' ? 'chevron_up' : 'chevron_down', { size: 12 }),
          ),
          h('button', { type: 'button', class: 'td-chip-x', 'aria-label': t('sort.remove'), 'data-tip': t('sort.remove'), onclick: () => app.store.setViewPref(v, { sort: null }) }, app.icon('dismiss', { size: 12 })),
        ),
      );
    }
  }

  editTitle(selectAll) {
    const { app } = this;
    const v = app.view;
    if (!v.startsWith('list:') || v === `list:${DEFAULT_LIST}` || this._editingTitle) return;
    const l = app.store.list(v.slice(5));
    if (!l) return;
    const input = app.h('input', { class: 'td-title-input', value: `${l.emoji ? `${l.emoji} ` : ''}${l.name}`, 'aria-label': app.t('list.name'), maxlength: '255', spellcheck: false });
    this._editingTitle = true;
    this.titleEl.replaceWith(input);
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      this._editingTitle = false;
      this.editing = null;
      input.replaceWith(this.titleEl);
      if (save && input.value.trim()) app.store.renameList(l.id, input.value);
      this.renderHeader();
    };
    this.editing = finish;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true);
        this.focusAdd();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(false);
        this.titleEl.focus();
      }
    });
    input.addEventListener('blur', () => finish(true));
    setTimeout(() => {
      input.focus();
      if (selectAll) input.select();
    }, 0);
  }

  sortMenu(e) {
    const { app } = this;
    const v = app.view;
    const cur = app.store.viewPrefs(v).sort;
    const items = SORTS.filter((s) => s !== 'myDay' || v !== 'myday').map((s) => ({
      label: app.t(`sort.${s}`),
      icon: { importance: 'star', due: 'calendar_ltr', myDay: 'weather_sunny', alpha: 'text_sort_ascending', created: 'calendar_add' }[s],
      checked: cur?.by === s,
      action: () => app.store.setViewPref(v, { sort: { by: s, dir: 'asc' } }),
    }));
    if (cur) items.push('-', { label: app.t('sort.remove'), icon: 'dismiss', action: () => app.store.setViewPref(v, { sort: null }) });
    return app.menu(e, [{ header: app.t('sort.by') }, ...items]);
  }

  groupMenu(e) {
    const { app } = this;
    const v = app.view;
    const cur = app.store.viewPrefs(v).groupBy || 'none';
    const opts = v.startsWith('list:') ? ['none', 'due'] : ['none', 'list'];
    return app.menu(e, [
      { header: app.t('group.by') },
      ...opts.map((g) => ({ label: app.t(`group.${g}`), checked: cur === g, action: () => app.store.setViewPref(v, { groupBy: g }) })),
    ]);
  }

  // ---------------------------------------------------------------- banners
  renderBanner() {
    const { app } = this;
    const { h, t, icon } = app;
    app.ui.clear(this.bannerSlot);
    const store = app.store;
    if (store.saveError) {
      this.bannerSlot.appendChild(
        h(
          'div',
          { class: 'infobar error td-banner', role: 'alert' },
          icon('error_circle', { filled: true }),
          h('div', { class: 'grow' }, h('div', { class: 'body-strong' }, t('errors.saveTitle')), h('div', { class: 'caption td-banner-msg', 'data-tip': store.saveError }, store.saveError)),
          h('button', { type: 'button', class: 'btn', onclick: () => store.flush() }, t('common.retry')),
        ),
      );
    }
    if (store.readOnly) {
      // the data file could not be read: say so for as long as nothing is being saved (not only in the start-up alert)
      this.bannerSlot.appendChild(
        h(
          'div',
          { class: 'infobar warning td-banner td-readonly-banner', role: 'status' },
          icon('warning', { filled: true }),
          h('div', { class: 'grow' }, h('div', { class: 'body-strong' }, t('errors.readOnlyTitle')), h('div', { class: 'caption' }, t('errors.readOnlyBody'))),
        ),
      );
    }
    const v = app.view;
    const seedHere = v === 'myday' || v === 'important' || v === 'all' || (v.startsWith('list:') && store.data.tasks.some((x) => x.seed && x.listId === v.slice(5)));
    if (store.data.prefs.seedBanner && store.hasSeed() && seedHere) {
      this.bannerSlot.appendChild(
        h(
          'div',
          { class: 'infobar td-banner td-seed-banner' },
          icon('lightbulb', { filled: true }),
          h('div', { class: 'grow' }, h('div', { class: 'body-strong' }, t('seed.title')), h('div', { class: 'caption' }, t('seed.body'))),
          h('div', { class: 'td-banner-btns' },
            h('button', { type: 'button', class: 'btn td-seed-remove', onclick: () => this.removeExamples() }, t('seed.remove')),
            h('button', { type: 'button', class: 'btn subtle icon-btn td-seed-dismiss', 'aria-label': t('seed.keep'), 'data-tip': t('seed.keep'), onclick: () => store.setPref('seedBanner', false) }, icon('dismiss'))),
        ),
      );
    }
  }

  removeExamples() {
    const removed = this.app.store.removeSeed();
    for (const id of removed) this.app._removeReminder(id);
    this.app.announce(this.app.t('seed.removed'));
  }

  // ---------------------------------------------------------------- rows
  sorted(open, view) {
    const prefs = this.app.store.viewPrefs(view);
    return sortTasks(open, prefs.sort, { view, starToTop: this.app.store.data.prefs.starToTop, locale: this.app.i18n.locale });
  }

  render({ animate = true } = {}) {
    const { app } = this;
    if (app.view === 'settings') return;
    this.renderHeader();
    this.renderBanner();
    this._paintAdd();
    this.addEl.hidden = !this.canAdd();
    const before = animate ? snapshot(this.scroller, '.td-task') : new Map();
    const hadFocus = this.body.contains(document.activeElement) ? document.activeElement.closest('.td-task')?.dataset.id || 'list' : null;
    const scroll = this.scroller.scrollTop;
    app.ui.clear(this.body);
    const v = app.view;
    const now = app.now();
    const store = app.store;
    const prefs = store.viewPrefs(v);
    let open;
    let done;
    let snippets = null;
    if (v === 'search') {
      const res = search(store.data, app.query);
      snippets = new Map(res.map((r) => [r.task.id, r]));
      open = res.filter((r) => !r.task.done).map((r) => r.task);
      done = res.filter((r) => r.task.done).map((r) => r.task);
    } else ({ open, done } = viewTasks(store.data, v, now));
    const smart = !v.startsWith('list:');
    const opts = { showList: smart, snippets };
    let sections;
    if (v === 'planned') sections = plannedGroups(open, now, app.weekStart).map((g) => ({ key: g.key, label: app.t(`planned.${g.key}`), tasks: g.tasks }));
    else if (v === 'search' || (smart && prefs.groupBy === 'list')) {
      sections = groupByList(this.sorted(open, v), store.data.lists).map((g) => ({ key: `l:${g.key}`, label: app.listName(store.list(g.key)), emoji: store.list(g.key)?.emoji, tasks: g.tasks }));
      if (v === 'search' || v === 'all') opts.showList = false;
    } else if (!smart && prefs.groupBy === 'due') sections = groupByDue(this.sorted(open, v), now, app.weekStart).map((g) => ({ key: g.key, label: app.t(g.key === 'noDate' ? 'planned.noDate' : `planned.${g.key}`), tasks: g.tasks }));
    else sections = [{ key: null, tasks: this.sorted(open, v) }];
    for (const s of sections) this.body.appendChild(this._section(s, opts));
    const showDone = v === 'completed' || v === 'search' || (prefs.showCompleted && done.length);
    if (v === 'completed') {
      for (const g of groupByList(sortDone(done), store.data.lists)) this.body.appendChild(this._section({ key: `c:${g.key}`, label: app.listName(store.list(g.key)), emoji: store.list(g.key)?.emoji, tasks: g.tasks }, { showList: false }));
    } else if (showDone && done.length) {
      this.body.appendChild(this._completedSection(sortDone(done), { ...opts, showList: smart && v !== 'search' }));
    }
    if (!open.length && !(showDone && done.length)) this.body.appendChild(this._empty(v));
    this.body.classList.toggle('big', open.length + (showDone ? done.length : 0) > 150);
    this.scroller.scrollTop = scroll;
    if (animate) playFlip(this.scroller, before, { sel: '.td-task' });
    this.paintSelection();
    for (const id of app.completing.keys()) this.markCompleting(id, true);
    if (hadFocus) {
      if (hadFocus !== 'list' && this.focusRow(hadFocus, { preventScroll: true })) return;
      if (app.focusId && this.focusRow(app.focusId, { preventScroll: true })) return;
      this.focusList();
    }
  }

  _sectionHead(key, label, count, { emoji, cls } = {}) {
    const { h, icon } = this.app;
    const ck = `${this.app.view}|${key}`;
    const collapsed = this.collapsed.has(ck);
    const btn = h(
      'button',
      {
        type: 'button',
        class: ['td-sec-head', cls, collapsed && 'collapsed'],
        'aria-expanded': String(!collapsed),
        onclick: () => {
          if (this.collapsed.has(ck)) this.collapsed.delete(ck);
          else this.collapsed.add(ck);
          this.render();
        },
      },
      icon('chevron_right', { size: 12, class: 'td-sec-chev' }),
      emoji ? h('span', { class: 'td-sec-emoji', 'aria-hidden': 'true' }, emoji) : null,
      h('span', { class: 'td-sec-label' }, label),
      h('span', { class: 'td-sec-count' }, String(count)),
    );
    return { btn, collapsed };
  }

  _section(s, opts) {
    const { h } = this.app;
    const sec = h('section', { class: 'td-sec', dataset: { key: s.key || '' } });
    let collapsed = false;
    if (s.key != null) {
      const head = this._sectionHead(s.key, s.label, s.tasks.length, { emoji: s.emoji });
      collapsed = head.collapsed;
      sec.appendChild(head.btn);
    }
    const rows = h('div', { class: 'td-rows', role: 'list', 'aria-label': s.label || this.app.viewTitle(this.app.view) });
    if (!collapsed) for (const t of s.tasks) rows.appendChild(this.row(t, opts));
    sec.appendChild(rows);
    return sec;
  }

  _completedSection(tasks, opts) {
    const { app } = this;
    const { h } = app;
    const v = app.view;
    const prefs = app.store.viewPrefs(v);
    const open = v === 'search' ? true : prefs.completedOpen !== false;
    const btn = h(
      'button',
      {
        type: 'button',
        class: ['td-sec-head', 'td-done-head', !open && 'collapsed'],
        'aria-expanded': String(open),
        onclick: () => (v === 'search' ? null : app.store.setViewPref(v, { completedOpen: !open })),
      },
      app.icon('chevron_right', { size: 12, class: 'td-sec-chev' }),
      h('span', { class: 'td-sec-label' }, app.t('list.completed')),
      h('span', { class: 'td-sec-count' }, String(tasks.length)),
    );
    const rows = h('div', { class: 'td-rows td-done-rows', role: 'list', 'aria-label': app.t('list.completed') });
    if (open) for (const t of tasks) rows.appendChild(this.row(t, opts));
    return h('section', { class: 'td-sec td-done-sec', dataset: { key: 'done' } }, btn, rows);
  }

  _empty(v) {
    const { app } = this;
    const { h, t } = app;
    const key = v.startsWith('list:') ? 'list' : v;
    if (key === 'list') return h('div', { class: 'td-empty td-empty-list' }, h('div', { class: 'caption text-2' }, t('empty.list')));
    return h(
      'div',
      { class: ['td-empty', `td-empty-${key}`] },
      h('div', { class: 'td-empty-art' }, app.icon(EMPTY_ICON[key] || 'checkmark_circle', { filled: key === 'important' })),
      h('div', { class: 'subtitle td-empty-title' }, t(`empty.${key}Title`)),
      h('div', { class: 'text-2 td-empty-text' }, t(`empty.${key}`, { q: app.query.trim() })),
      key === 'myday' ? h('button', { type: 'button', class: 'btn td-empty-btn', onclick: () => app.toggleSuggestions(true) }, app.icon('lightbulb'), t('toolbar.suggestions')) : null,
    );
  }

  row(task, { showList = false, snippets = null } = {}) {
    const { app } = this;
    const { h, t, icon } = app;
    const today = app.today();
    const meta = [];
    const list = app.store.list(task.listId);
    if (showList && list) meta.push(h('span', { class: 'td-meta-list' }, list.emoji ? `${list.emoji} ` : '', app.listName(list)));
    if (task.myDay === today && app.view !== 'myday') meta.push(h('span', { class: 'td-meta-myday' }, icon('weather_sunny', { size: 12 }), t('nav.myday')));
    if (task.steps.length) meta.push(h('span', { class: 'td-meta-steps' }, t('row.steps', { done: task.steps.filter((s) => s.done).length, total: task.steps.length })));
    if (task.due) {
      const st = D.dueState(task.due, app.now());
      meta.push(h('span', { class: ['td-meta-due', !task.done && st === 'overdue' && 'overdue', !task.done && st === 'today' && 'today'] }, icon('calendar_ltr', { size: 12 }), app.fmt.dueShort(task.due)));
    }
    if (Number.isFinite(task.remindAt)) {
      const past = task.remindAt <= Date.now();
      meta.push(h('span', { class: ['td-meta-remind', past && 'past'], 'data-tip': `${app.fmt.reminderMain(task.remindAt)}, ${app.fmt.reminderSub(task.remindAt)}` }, icon('alert', { size: 12 }), task.due ? null : app.fmt.reminderShort(task.remindAt)));
    }
    if (task.repeat) meta.push(h('span', { class: 'td-meta-repeat', 'data-tip': app.fmt.repeat(task.repeat) }, icon('arrow_repeat_all', { size: 12 })));
    if (task.note.trim()) meta.push(h('span', { class: 'td-meta-note', 'data-tip': t('detail.note') }, icon('note', { size: 12 })));
    const snip = snippets?.get(task.id);
    if (snip && snip.where !== 'title') meta.push(h('span', { class: 'td-meta-snip' }, `${t(snip.where === 'step' ? 'search.inStep' : 'search.inNote')} `, this._highlight(snip.text)));
    const titleEl = h('div', { class: 'td-row-title' }, snip ? this._highlight(task.title) : task.title);
    const check = h(
      'button',
      {
        type: 'button',
        class: 'td-check',
        role: 'checkbox',
        'aria-checked': String(task.done),
        'aria-label': t(task.done ? 'row.markNotCompleted' : 'row.markCompleted', { title: task.title }),
        'data-tip': t(task.done ? 'row.markNotCompletedTip' : 'row.markCompletedTip'),
        tabindex: '-1',
        onclick: (e) => {
          e.stopPropagation();
          app.complete([task.id], !(task.done || app.completing.has(task.id)));
        },
      },
      checkSvg(),
    );
    const star = h(
      'button',
      {
        type: 'button',
        class: ['td-star', task.important && 'on'],
        'aria-pressed': String(task.important),
        'aria-label': t(task.important ? 'row.removeImportance' : 'row.markImportant', { title: task.title }),
        'data-tip': t(task.important ? 'row.removeImportanceTip' : 'row.markImportantTip'),
        tabindex: '-1',
        onclick: (e) => {
          e.stopPropagation();
          app.toggleImportant([task.id]);
          if (!reduceMotion()) e.currentTarget.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.35)' }, { transform: 'scale(1)' }], { duration: 300, easing: EASE });
        },
      },
      icon('star', { filled: task.important }),
    );
    const el = h(
      'div',
      {
        class: ['td-task', task.done && 'done', task.important && 'important'],
        role: 'listitem',
        tabindex: '-1',
        dataset: { id: task.id },
        'aria-label': this._ariaLabel(task),
      },
      check,
      h('div', { class: 'td-row-main' }, titleEl, meta.length ? h('div', { class: 'td-row-meta' }, meta) : null),
      star,
    );
    el.addEventListener('click', (e) => {
      const add = e.ctrlKey || e.metaKey;
      app.select(task.id, { add, range: e.shiftKey });
      if (!add && !e.shiftKey) el.focus({ preventScroll: true });
    });
    el.addEventListener('dblclick', (e) => {
      if (e.target.closest('.td-check, .td-star')) return;
      app.openTask(task.id, { focus: true, field: 'title' });
    });
    el.addEventListener('contextmenu', (e) => {
      if (!app.sel.has(task.id)) app.select(task.id, { open: false });
      app.taskMenu(e, task.id);
    });
    el.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.td-check, .td-star') || e.button !== 0) return;
      this._dragRow(e, el, task);
    });
    return el;
  }

  _ariaLabel(task) {
    const { app } = this;
    const parts = [task.title];
    if (task.done) parts.push(app.t('row.completed'));
    if (task.important) parts.push(app.t('row.important'));
    if (task.due) parts.push(app.fmt.dueLong(task.due));
    if (task.steps.length) parts.push(app.t('row.steps', { done: task.steps.filter((s) => s.done).length, total: task.steps.length }));
    return parts.join(', ');
  }

  _highlight(text) {
    const { h } = this.app;
    const ranges = matchRanges(text, this.app.query);
    if (!ranges.length) return text;
    const out = [];
    let i = 0;
    for (const [a, b] of ranges) {
      if (a > i) out.push(text.slice(i, a));
      out.push(h('mark', { class: 'td-mark' }, text.slice(a, b)));
      i = b;
    }
    if (i < text.length) out.push(text.slice(i));
    return out;
  }

  markCompleting(id, on) {
    const el = this.rowEl(id);
    if (!el) return;
    el.classList.toggle('completing', on);
    const c = el.querySelector('.td-check');
    c?.setAttribute('aria-checked', String(on || el.classList.contains('done')));
  }

  rowEl(id) {
    return this.body.querySelector(`.td-task[data-id="${CSS.escape(id)}"]`);
  }
  contains(id) {
    return !!this.rowEl(id);
  }
  visibleIds() {
    return [...this.body.querySelectorAll('.td-task')].map((r) => r.dataset.id);
  }

  paintSelection() {
    const { app } = this;
    let roving = null;
    for (const r of this.body.querySelectorAll('.td-task')) {
      const id = r.dataset.id;
      r.classList.toggle('selected', app.sel.has(id));
      r.classList.toggle('open', app.openId === id);
      r.setAttribute('aria-selected', String(app.sel.has(id)));
      r.tabIndex = -1;
      if (id === app.focusId) roving = r;
    }
    (roving || this.body.querySelector('.td-task'))?.setAttribute('tabindex', '0');
    this.el.classList.toggle('multi', app.sel.size > 1);
  }

  focusRow(id, { preventScroll = false } = {}) {
    const el = this.rowEl(id);
    if (!el) return false;
    this.app.focusId = id;
    this.paintSelection();
    el.focus({ preventScroll });
    if (!preventScroll) el.scrollIntoView({ block: 'nearest' });
    return true;
  }

  focusList() {
    const { app } = this;
    if (app.focusId && this.focusRow(app.focusId)) return;
    const first = this.body.querySelector('.td-task');
    if (first) this.focusRow(first.dataset.id);
    else if (this.canAdd()) this.addInput.focus();
    else this.scroller.focus({ preventScroll: true });
  }

  scrollToRow(id) {
    const el = this.rowEl(id);
    if (!el) return;
    el.scrollIntoView({ block: 'nearest', behavior: reduceMotion() ? 'auto' : 'smooth' });
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1300);
  }

  /** The row to focus after `ids` disappear (next, else previous). */
  neighborOf(ids) {
    const all = this.visibleIds();
    const set = new Set(ids);
    const last = Math.max(...ids.map((id) => all.indexOf(id)));
    for (let i = last + 1; i < all.length; i++) if (!set.has(all[i])) return all[i];
    for (let i = Math.min(...ids.map((id) => all.indexOf(id))) - 1; i >= 0; i--) if (!set.has(all[i])) return all[i];
    return null;
  }

  canReorder() {
    const { app } = this;
    const v = app.view;
    if (!(v === 'myday' || v.startsWith('list:'))) return false;
    const p = app.store.viewPrefs(v);
    return !p.sort && (!p.groupBy || p.groupBy === 'none');
  }

  // ---------------------------------------------------------------- keyboard
  _keys(e) {
    const { app } = this;
    const row = e.target.closest?.('.td-task');
    if (!row || e.target !== row) return;
    const id = row.dataset.id;
    const ids = this.visibleIds();
    const i = ids.indexOf(id);
    const k = e.key;
    if ((k === 'ArrowDown' || k === 'ArrowUp') && e.altKey) {
      e.preventDefault();
      if (!this.canReorder() || row.classList.contains('done')) return;
      const rows = [...row.parentElement.querySelectorAll(':scope > .td-task')];
      const j = rows.indexOf(row) + (k === 'ArrowDown' ? 1 : -1);
      if (j < 0 || j >= rows.length) return;
      const order = rows.map((r) => r.dataset.id);
      order.splice(rows.indexOf(row), 1);
      order.splice(j, 0, id);
      app.store.reorder(order, app.view);
      app.announce(app.t('a11y.movedPos', { pos: j + 1, total: rows.length }));
      return;
    }
    if (k === 'ArrowDown' || k === 'ArrowUp' || k === 'Home' || k === 'End') {
      e.preventDefault();
      const n = k === 'Home' ? 0 : k === 'End' ? ids.length - 1 : Math.max(0, Math.min(ids.length - 1, i + (k === 'ArrowDown' ? 1 : -1)));
      if (k === 'ArrowUp' && i === 0 && !e.shiftKey && this.canAdd()) {
        this.addInput.focus();
        return;
      }
      const target = ids[n];
      if (e.shiftKey) {
        if (!app.anchorId) app.anchorId = id;
        app.select(target, { range: true });
      } else app.select(target, { open: !!app.openId }); // the selection follows the focus; details follow if open
      this.focusRow(target);
      return;
    }
    if (k === 'Enter') {
      e.preventDefault();
      app.openTask(id, { focus: true });
    } else if (k === ' ' || k === 'Spacebar') {
      e.preventDefault();
      const t = app.store.task(id);
      if (t) app.complete([id], !(t.done || app.completing.has(id)));
    } else if (k === 'F2') {
      e.preventDefault();
      app.openTask(id, { focus: true, field: 'title' });
    } else if (k === 'ContextMenu' || (k === 'F10' && e.shiftKey)) {
      e.preventDefault();
      const r = row.getBoundingClientRect();
      if (!app.sel.has(id)) app.select(id, { open: false });
      app.taskMenu({ x: r.left + 40, y: r.bottom - 4 }, id);
    } else if (!e.ctrlKey && !e.altKey && !e.metaKey && k.length === 1 && this.canAdd() && /\S/.test(k)) {
      // typing on a row starts a new task, like the To Do app
      this.addInput.focus();
    }
  }

  // ---------------------------------------------------------------- drag & drop
  _dragRow(e, el, task) {
    const { app } = this;
    const ids = app.sel.has(task.id) && app.sel.size > 1 ? [...app.sel] : [task.id];
    const container = el.parentElement;
    const reorder = ids.length === 1 && !task.done && this.canReorder();
    let target = null;
    const startOrder = [...container.querySelectorAll(':scope > .td-task')].map((r) => r.dataset.id);
    const clearTarget = () => app.nav.el.querySelectorAll('.drop-target').forEach((n) => n.classList.remove('drop-target'));
    beginDrag(e, {
      el,
      host: app.root,
      scroller: this.scroller,
      compact: true,
      makeGhost: () =>
        app.h(
          'div',
          { class: ['td-ghost-task', task.done && 'done'] },
          app.h('span', { class: 'td-check' }, checkSvg()),
          app.h('span', { class: 'td-ghost-title' }, task.title),
          ids.length > 1 ? app.h('span', { class: 'td-ghost-count badge' }, String(ids.length)) : null,
        ),
      onStart: () => {
        el.classList.add('td-dragging');
        for (const id of ids) this.rowEl(id)?.classList.add('td-dragging');
        if (app.root.classList.contains('narrow')) app.toggleNav(true);
      },
      onMove: (x, y) => {
        clearTarget();
        target = null;
        const hit = document.elementFromPoint(x, y);
        const drop = hit?.closest?.('.td-nav [data-drop]');
        if (drop && app.nav.el.contains(drop)) {
          const v = drop.dataset.drop;
          const t = app.store.task(task.id);
          const same = v.startsWith('list:') && ids.every((id) => app.store.task(id)?.listId === v.slice(5));
          if (!same && t) {
            drop.classList.add('drop-target');
            target = v;
          }
          return;
        }
        if (reorder && this.scroller.contains(hit) || (reorder && hit === this.scroller)) liveReorder(container, el, y, '.td-task');
      },
      onDrop: () => {
        clearTarget();
        for (const r of this.body.querySelectorAll('.td-dragging')) r.classList.remove('td-dragging');
        if (app.root.classList.contains('narrow')) app.toggleNav(false);
        if (target) {
          if (target === 'myday') app.toggleMyDay(ids, true);
          else if (target === 'important') app.toggleImportant(ids, true);
          else if (target.startsWith('list:')) app.moveTasks(ids, target.slice(5));
          if (reorder) this._restoreOrder(container, startOrder);
          return null;
        }
        if (reorder) {
          const order = [...container.querySelectorAll(':scope > .td-task')].map((r) => r.dataset.id);
          if (order.join() !== startOrder.join()) {
            app.store.reorder(order, app.view);
            app.announce(app.t('a11y.movedPos', { pos: order.indexOf(task.id) + 1, total: order.length }));
          }
          return el.getBoundingClientRect();
        }
        return null;
      },
      onCancel: () => {
        clearTarget();
        for (const r of this.body.querySelectorAll('.td-dragging')) r.classList.remove('td-dragging');
        if (reorder) this._restoreOrder(container, startOrder);
      },
    });
  }

  _restoreOrder(container, order) {
    const rows = new Map([...container.querySelectorAll(':scope > .td-task')].map((r) => [r.dataset.id, r]));
    for (const id of order) if (rows.has(id)) container.appendChild(rows.get(id));
  }
}

let checkProto = null;
function checkSvg() {
  if (!checkProto) {
    checkProto = document.createElement('span');
    checkProto.className = 'td-check-ic';
    checkProto.setAttribute('aria-hidden', 'true');
    checkProto.innerHTML =
      '<svg viewBox="0 0 20 20"><circle class="td-ring" cx="10" cy="10" r="8.5"/><circle class="td-fill" cx="10" cy="10" r="9.25"/><path class="td-tick" d="M6.2 10.4l2.6 2.6 5-5.4"/></svg>';
  }
  return checkProto.cloneNode(true);
}

export { checkSvg };
