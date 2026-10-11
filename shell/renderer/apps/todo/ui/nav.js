// Navigation pane: search box, smart lists (My Day, Important, Planned, Assigned to me, All, Completed,
// Tasks), user lists and list groups with counts, "New list" / "New group" / settings. Lists can be dragged
// to reorder them or into a group; nav items are drop targets for dragged tasks.
import { DEFAULT_LIST, counts } from '../lib/store.js';
import { SMART_ICONS } from './app.js';
import { beginDrag } from './drag.js';

const SMART = ['myday', 'important', 'planned', 'assigned', 'all', 'completed'];

export class Nav {
  constructor(app) {
    this.app = app;
    this.items = new Map();
    this.el = this._build();
  }

  _build() {
    const { h, t, icon } = this.app;
    this.search = h('input', {
      class: 'input td-search-input',
      type: 'search',
      placeholder: t('search.placeholder'),
      'aria-label': t('search.placeholder'),
      spellcheck: false,
      oninput: () => {
        clearTimeout(this._st);
        this._st = setTimeout(() => this.app.setSearch(this.search.value), 120);
      },
      onkeydown: (e) => {
        if (e.key === 'Enter') {
          clearTimeout(this._st);
          this.app.setSearch(this.search.value);
          if (this.search.value.trim()) this.app.list.focusList();
        } else if (e.key === 'ArrowDown' && this.search.value.trim()) {
          e.preventDefault();
          this.app.list.focusList();
        }
      },
    });
    this.searchClear = h('button', { type: 'button', class: 'btn subtle icon-btn td-search-clear', hidden: true, 'aria-label': t('search.clear'), onclick: () => (this.clearSearch(), this.app.setSearch(''), this.search.focus()) }, icon('dismiss', { size: 12 }));
    this.search.addEventListener('input', () => (this.searchClear.hidden = !this.search.value));
    this.smartEl = h('div', { class: 'td-nav-smart', role: 'group', 'aria-label': t('nav.smartLists') });
    this.listsEl = h('div', { class: 'td-nav-lists', role: 'group', 'aria-label': t('nav.myLists') });
    this.scroller = h('div', { class: 'td-nav-scroll' }, this.smartEl, h('div', { class: 'td-nav-sep', role: 'separator' }), this.listsEl);
    this.scroller.addEventListener('keydown', (e) => this._keys(e));
    const foot = h(
      'div',
      { class: 'td-nav-foot' },
      h('button', { type: 'button', class: 'btn subtle td-newlist', 'data-tip': `${t('nav.newList')} (${this.app.fmt.keys('Ctrl+L')})`, onclick: () => this.app.newList() }, icon('add'), h('span', { class: 'ellipsis' }, t('nav.newList'))),
      h('button', { type: 'button', class: 'btn subtle icon-btn td-newgroup', 'aria-label': t('nav.newGroup'), 'data-tip': t('nav.newGroup'), onclick: () => this.app.newGroup() }, icon('folder_add')),
      h('button', { type: 'button', class: 'btn subtle icon-btn td-settings-btn', 'aria-label': t('settings.title'), 'data-tip': t('settings.title'), onclick: () => this.app.go('settings') }, icon('settings')),
    );
    return h(
      'nav',
      { class: 'td-nav', 'aria-label': t('nav.label') },
      h('div', { class: 'td-nav-top' }, h('div', { class: 'search-box td-search' }, this.search, this.searchClear, icon('search'))),
      this.scroller,
      foot,
    );
  }

  focusSearch() {
    this.search.focus();
    this.search.select();
  }
  clearSearch() {
    this.search.value = '';
    this.searchClear.hidden = true;
  }
  itemFor(view) {
    return this.items.get(view) || null;
  }
  focusCurrent() {
    (this.items.get(this.app.view) || this.items.get('myday'))?.focus();
  }

  render() {
    const { app } = this;
    const { h } = app;
    const store = app.store;
    const c = counts(store.data, app.now());
    const prefs = store.data.prefs;
    const focusedView = document.activeElement?.closest?.('.td-nav')?.contains(document.activeElement) ? document.activeElement.dataset?.view || document.activeElement.dataset?.group : null;
    const scroll = this.scroller.scrollTop;
    this.items.clear();
    app.ui.clear(this.smartEl);
    for (const v of [...SMART, `list:${DEFAULT_LIST}`]) {
      if (SMART.includes(v) && v !== 'myday') {
        if (prefs.smart[v] === false) continue;
        if (prefs.autoHideEmpty && !c[v] && app.view !== v) continue;
      }
      this.smartEl.appendChild(this._item(v, { icon: SMART_ICONS[v], label: v.startsWith('list:') ? app.t('nav.tasks') : app.t(`nav.${v}`), count: c[v], drop: ['myday', 'important', `list:${DEFAULT_LIST}`].includes(v) }));
    }
    app.ui.clear(this.listsEl);
    const entries = [
      ...store.data.groups.map((g) => ({ g, order: g.order })),
      ...store.userLists().filter((l) => !l.groupId).map((l) => ({ l, order: l.order })),
    ].sort((a, b) => a.order - b.order);
    for (const e of entries) {
      if (e.l) this.listsEl.appendChild(this._listItem(e.l, c));
      else {
        const lists = store.userLists().filter((l) => l.groupId === e.g.id);
        const total = lists.reduce((n, l) => n + (c[`list:${l.id}`] || 0), 0);
        const head = h(
          'button',
          {
            type: 'button',
            class: ['td-group-head', e.g.collapsed && 'collapsed'],
            dataset: { group: e.g.id },
            'aria-expanded': String(!e.g.collapsed),
            onclick: () => store.setGroupCollapsed(e.g.id, !e.g.collapsed),
            oncontextmenu: (ev) => app.groupMenu(ev, e.g.id),
          },
          app.icon('chevron_right', { size: 12, class: 'td-group-chev' }),
          app.icon(e.g.collapsed ? 'folder' : 'folder_open', { class: 'td-group-ic' }),
          h('span', { class: 'td-nav-label ellipsis' }, e.g.name),
          e.g.collapsed && total ? h('span', { class: 'td-nav-count' }, String(total)) : null,
        );
        const body = h('div', { class: 'td-group-body', role: 'group', 'aria-label': e.g.name, hidden: e.g.collapsed });
        for (const l of lists) body.appendChild(this._listItem(l, c, true));
        if (!lists.length && !e.g.collapsed) body.appendChild(h('div', { class: 'td-group-empty caption' }, app.t('nav.groupEmpty')));
        this.listsEl.appendChild(h('div', { class: 'td-group', dataset: { groupId: e.g.id } }, head, body));
      }
    }
    for (const [v, el] of this.items) {
      const on = v === app.view;
      el.classList.toggle('selected', on);
      if (on) el.setAttribute('aria-current', 'page');
      else el.removeAttribute('aria-current');
    }
    this.el.querySelector('.td-settings-btn')?.classList.toggle('active', app.view === 'settings');
    this.scroller.scrollTop = scroll;
    if (focusedView) (this.items.get(focusedView) || this.listsEl.querySelector(`[data-group="${CSS.escape(focusedView)}"]`))?.focus({ preventScroll: true });
  }

  _item(view, { icon: ic, emoji, label, count, drop, indent = false }) {
    const { app } = this;
    const { h } = app;
    const th = app.themeOf(view);
    const el = h(
      'button',
      {
        type: 'button',
        class: ['nav-item', 'td-nav-item', indent && 'indent', `td-c-${th.color}`],
        dataset: { view, ...(drop ? { drop: view } : {}) },
        'data-tip': label.length > 26 ? label : null,
        'data-tip-pos': 'below',
        onclick: () => app.go(view),
        oncontextmenu: (e) => app.listMenu(e, view),
      },
      emoji ? h('span', { class: 'td-nav-emoji', 'aria-hidden': 'true' }, emoji) : app.icon(ic, { class: 'td-nav-ic', filled: view === 'important' }),
      h('span', { class: 'td-nav-label ellipsis' }, label),
      count ? h('span', { class: 'td-nav-count', 'aria-label': app.t('nav.count', { count }) }, String(count)) : null,
    );
    this.items.set(view, el);
    return el;
  }

  _listItem(l, c, indent = false) {
    const view = `list:${l.id}`;
    const el = this._item(view, { icon: 'text_bullet_list_ltr', emoji: l.emoji, label: this.app.listName(l), count: c[view], drop: true, indent });
    el.dataset.listId = l.id;
    el.addEventListener('pointerdown', (e) => this._dragList(e, el, l));
    el.addEventListener('dblclick', () => this.app.renameList(l.id));
    return el;
  }

  // keyboard: arrows move between nav entries
  _keys(e) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const all = [...this.scroller.querySelectorAll('.td-nav-item, .td-group-head')].filter((x) => x.offsetParent);
    const i = all.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    const n = e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length;
    all[n].focus();
    all[n].scrollIntoView({ block: 'nearest' });
  }

  // ---------------------------------------------------------------- group rename (inline)
  editGroup(gid) {
    const head = this.listsEl.querySelector(`[data-group="${CSS.escape(gid)}"]`);
    const g = this.app.store.group(gid);
    if (!head || !g) return;
    const { h } = this.app;
    const input = h('input', { class: 'input td-group-edit', value: g.name, 'aria-label': this.app.t('list.groupName'), spellcheck: false });
    const label = head.querySelector('.td-nav-label');
    label.replaceWith(input);
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      if (save && input.value.trim()) this.app.store.renameGroup(gid, input.value);
      else this.app.render();
      setTimeout(() => this.listsEl.querySelector(`[data-group="${CSS.escape(gid)}"]`)?.focus(), 0);
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('pointerdown', (e) => e.stopPropagation());
    input.addEventListener('blur', () => finish(true));
    setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  }

  // ---------------------------------------------------------------- drag lists (reorder / into groups)
  _dragList(e, el, l) {
    if (e.button !== 0) return;
    const { app } = this;
    let target = null; // { el, mode: 'before'|'after'|'into' }
    const line = app.h('div', { class: 'td-drop-line', hidden: true });
    beginDrag(e, {
      el,
      host: app.root,
      scroller: this.scroller,
      onStart: () => {
        el.classList.add('td-dragging');
        this.listsEl.appendChild(line);
      },
      onMove: (x, y) => {
        target = null;
        line.hidden = true;
        this.listsEl.querySelectorAll('.drop-into').forEach((n) => n.classList.remove('drop-into'));
        const hit = document.elementFromPoint(x, y);
        const head = hit?.closest?.('.td-group-head');
        const item = hit?.closest?.('.td-nav-lists .td-nav-item');
        if (head && this.listsEl.contains(head)) {
          head.classList.add('drop-into');
          target = { el: head, mode: 'into' };
        } else if (item && item !== el) {
          const r = item.getBoundingClientRect();
          const mode = y < r.top + r.height / 2 ? 'before' : 'after';
          target = { el: item, mode };
          const lr = this.listsEl.getBoundingClientRect();
          line.hidden = false;
          line.style.transform = `translateY(${(mode === 'before' ? r.top : r.bottom) - lr.top - 1}px)`;
          line.style.left = `${r.left - lr.left + 8}px`;
          line.style.width = `${r.width - 16}px`;
        }
      },
      onDrop: () => {
        el.classList.remove('td-dragging');
        line.remove();
        this.listsEl.querySelectorAll('.drop-into').forEach((n) => n.classList.remove('drop-into'));
        if (!target) return null;
        if (target.mode === 'into') {
          const gid = target.el.dataset.group;
          app.store.moveListToGroup(l.id, gid);
          app.store.setGroupCollapsed(gid, false);
          return null;
        }
        // new order of top-level entries + lists inside groups
        const tgtId = target.el.dataset.listId;
        const tgt = app.store.list(tgtId);
        const ordered = this._flatOrder().filter((x) => x !== l.id);
        const i = ordered.indexOf(tgtId) + (target.mode === 'after' ? 1 : 0);
        ordered.splice(i, 0, l.id);
        this._applyFlatOrder(ordered, { [l.id]: tgt?.groupId || null });
        return null;
      },
      onCancel: () => {
        el.classList.remove('td-dragging');
        line.remove();
        this.listsEl.querySelectorAll('.drop-into').forEach((n) => n.classList.remove('drop-into'));
      },
    });
  }

  /** Lists (and group markers 'g:<id>') in on-screen order. */
  _flatOrder() {
    const out = [];
    for (const n of this.listsEl.querySelectorAll('.td-nav-item[data-list-id], .td-group')) {
      if (n.classList.contains('td-group')) out.push(`g:${n.dataset.groupId}`);
      else out.push(n.dataset.listId);
    }
    return out;
  }

  _applyFlatOrder(ids, groupOf) {
    const store = this.app.store;
    let i = 1;
    for (const id of ids) {
      if (id.startsWith('g:')) {
        const g = store.group(id.slice(2));
        if (g) g.order = i++;
      } else {
        const l = store.list(id);
        if (!l) continue;
        l.order = i++;
        if (id in groupOf) l.groupId = groupOf[id];
      }
    }
    store.commit('lists', { reordered: ids });
  }
}
