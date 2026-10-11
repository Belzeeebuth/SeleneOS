// Notes app controller: layout (navigation pane, notes list, editor), views (All notes, Pinned, Recently
// deleted, notebooks, #tags), search, sorting, drag & drop to notebooks, keyboard, autosave, import /
// export / share, responsive layout (three panes -> overlay navigation -> one pane at a time).
import { NotesStore, displayTitle, PURGE_DAYS } from '../lib/store.js';
import { parseQuery, snippet, dateGroup, plainText } from '../lib/text.js';
import { sanitizeFragment } from '../lib/sanitize.js';
import { Editor } from './editor.js';
import { closePopover } from './popover.js';
import { notebookDialog, exportNote, importFiles, shortcutsDialog } from './dialogs.js';
import { welcomeSeed } from './welcome.js';

const NOTE_MIME = 'application/x-aurora-note';
const SORTS = ['modified', 'created', 'title'];

export class NotesApp {
  constructor(ctx) {
    this.ctx = ctx;
    this.win = ctx.win;
    this.t = ctx.t;
    this.store = new NotesStore(ctx.api, { locale: this.locale });
    this.view = { kind: 'all' };
    this.sort = 'modified';
    this.query = parseQuery('');
    this.selectedId = null;
    this.prefs = {};
    this.itemCache = new Map();
    this.sessionNew = new Set();
    this.editSeq = 0;
    this.selToken = 0;
    this.offs = [];
    this.ready = false;
  }

  get locale() {
    return this.ctx.lang === 'fr' ? 'fr-FR' : 'en-US';
  }

  // ------------------------------------------------------------------ boot
  async init() {
    const { ctx } = this;
    try {
      this.prefs = (await ctx.storage.get('prefs', {})) || {};
    } catch {
      this.prefs = {};
    }
    if (SORTS.includes(this.prefs.sort)) this.sort = this.prefs.sort;
    if (this.prefs.view && ['all', 'pinned', 'deleted', 'notebook', 'tag'].includes(this.prefs.view.kind)) this.view = { kind: this.prefs.view.kind, id: this.prefs.view.id };
    this.build();
    this.setLoading(true);
    try {
      await this.store.load({ seed: welcomeSeed(ctx.lang) });
    } catch (err) {
      console.error('[notes] load failed', err);
      this.setLoading(false);
      await ctx.ui.alert(this.t('errors.load', { message: err.message }), { title: this.t('appName'), parent: this.win });
    }
    this.setLoading(false);
    this.ready = true;
    // the saved view may point at a notebook / tag that is gone
    if ((this.view.kind === 'notebook' && !this.store.notebook(this.view.id)) || (this.view.kind === 'tag' && !this.store.tags().some((x) => x.tag === this.view.id))) this.view = { kind: 'all' };
    this.offs.push(this.store.on((what, data) => this.onStoreChange(what, data)));
    this.renderNav();
    this.renderList();
    const first = this.store.get(this.prefs.selected) && !this.store.get(this.prefs.selected).deletedAt ? this.prefs.selected : this.visibleNotes()[0]?.id;
    this.select(first || null, { focus: false });
    // keep relative times fresh
    const tick = setInterval(() => this.refreshDates(), 60000);
    this.offs.push(() => clearInterval(tick));
    this.offs.push(ctx.settings.on('clock24h', () => this.renderList({ force: true })));
    ctx.onLangChange(() => this.relocalize());
    ctx.onClose(() => this.destroy());
    await this.handleArgs(ctx.args || {});
    if (!this.selectedId) this.listEl.focus({ preventScroll: true });
  }

  destroy() {
    closePopover();
    this.editor?.destroy();
    for (const off of this.offs) {
      try {
        off?.();
      } catch {}
    }
  }

  async handleArgs(args = {}) {
    try {
      if (args.file && /\.(md|markdown|txt)$/i.test(args.file)) {
        const ids = await importFiles(this, [args.file]);
        if (ids[0]) this.reveal(ids[0]);
      }
      if (args.noteId && this.store.get(args.noteId)) this.reveal(args.noteId);
      if (args.newNote) await this.newNote({ title: args.title || '', text: args.text || '' });
    } catch (err) {
      console.error('[notes] args failed', err);
    }
  }

  savePrefs() {
    clearTimeout(this._prefsT);
    this._prefsT = setTimeout(() => {
      const p = { ...this.prefs, sort: this.sort, view: this.view, selected: this.selectedId };
      this.prefs = p;
      this.ctx.storage.set('prefs', p).catch(() => {});
    }, 400);
  }

  // ------------------------------------------------------------------ DOM
  build() {
    const { h, icon, ui } = this.ctx;
    const t = this.t;
    ui.clear(this.win.body);
    ui.clear(this.win.titlebarSlot);
    this.editor?.destroy();
    this.itemCache.clear();

    // search box in the tall title bar (as in Mail / Outlook)
    this.searchInput = h('input', {
      class: 'nt-search-input',
      type: 'search',
      spellcheck: false,
      placeholder: t('searchPlaceholder'),
      'aria-label': t('search'),
      value: this.searchInput?.value || '',
      oninput: () => {
        clearTimeout(this._searchT);
        this._searchT = setTimeout(() => this.setSearch(this.searchInput.value), 120);
      },
      onkeydown: (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          if (this.searchInput.value) this.clearSearch();
          else this.focusList();
        } else if (e.key === 'Enter' || e.key === 'ArrowDown') {
          e.preventDefault();
          this.setSearch(this.searchInput.value);
          this.focusList();
        }
      },
    });
    this.searchClear = h(
      'button',
      { type: 'button', class: 'nt-search-clear', hidden: !this.searchInput.value, 'aria-label': t('clearSearch'), 'data-tip': t('clearSearch'), onclick: () => this.clearSearch(true) },
      icon('dismiss', { size: 12 }),
    );
    this.win.titlebarSlot.appendChild(h('div', { class: 'nt-tb-search' }, h('div', { class: 'nt-search' }, icon('search', { size: 16 }), this.searchInput, this.searchClear)));

    // navigation pane
    this.newBtn = h('button', { type: 'button', class: 'btn primary nt-new', 'data-tip': `${t('newNote')} (Ctrl+N)`, onclick: () => this.newNote() }, icon('note_add', { size: 16 }), h('span', { class: 'ellipsis' }, t('newNote')));
    this.navList = h('div', { class: 'nt-nav-list', role: 'tree', 'aria-label': t('navLabel') });
    this.navList.addEventListener('keydown', (e) => this.navKeys(e));
    this.nav = h(
      'nav',
      { class: 'nt-nav', 'aria-label': t('navLabel') },
      h('div', { class: 'nt-nav-top' }, this.newBtn),
      h('div', { class: 'nt-nav-scroll' }, this.navList),
      h(
        'div',
        { class: 'nt-nav-bottom' },
        h('button', { type: 'button', class: 'btn subtle nt-nav-btn', onclick: () => this.importNotes() }, icon('arrow_import', { size: 16 }), h('span', { class: 'ellipsis' }, t('import.button'))),
        h('button', { type: 'button', class: 'btn subtle icon-btn', 'aria-label': t('keys.title'), 'data-tip': t('keys.title'), onclick: () => shortcutsDialog(this) }, icon('keyboard', { size: 16 })),
      ),
    );

    // notes list
    this.navToggle = h('button', { type: 'button', class: 'btn subtle icon-btn nt-nav-toggle', 'aria-label': t('toggleNav'), 'data-tip': t('toggleNav'), 'aria-expanded': 'true', onclick: () => this.toggleNav() }, icon('navigation', { size: 16 }));
    this.listTitle = h('div', { class: 'nt-list-title ellipsis' });
    this.listCount = h('div', { class: 'nt-list-count caption ellipsis' });
    this.sortBtn = h('button', { type: 'button', class: 'btn subtle icon-btn', 'aria-haspopup': 'menu', 'aria-label': t('sort.label'), 'data-tip': t('sort.label'), onclick: (e) => this.sortMenu(e.currentTarget) }, icon('arrow_sort', { size: 16 }));
    this.listMoreBtn = h('button', { type: 'button', class: 'btn subtle icon-btn', 'aria-haspopup': 'menu', 'aria-label': t('moreOptions'), 'data-tip': t('moreOptions'), onclick: (e) => this.listMenu(e.currentTarget) }, icon('more_horizontal', { size: 16 }));
    this.listNewBtn = h('button', { type: 'button', class: 'btn subtle icon-btn nt-list-new', 'aria-label': t('newNote'), 'data-tip': `${t('newNote')} (Ctrl+N)`, onclick: () => this.newNote() }, icon('note_add', { size: 16 }));
    this.listEl = h('div', { class: 'nt-list', role: 'listbox', tabindex: '0', 'aria-label': t('notesList') });
    this.listEl.addEventListener('keydown', (e) => this.listKeys(e));
    this.listEl.addEventListener('focus', (e) => {
      if (e.target === this.listEl) this.listEl.querySelector('.nt-item[tabindex="0"]')?.focus({ preventScroll: true });
    });
    this.listEmpty = h('div', { class: 'nt-list-empty empty', hidden: true });
    this.listPane = h(
      'section',
      { class: 'nt-listpane', 'aria-label': t('notesList') },
      h('header', { class: 'nt-list-head' }, this.navToggle, h('div', { class: 'nt-list-heading' }, this.listTitle, this.listCount), this.listNewBtn, this.sortBtn, this.listMoreBtn),
      this.listEl,
      this.listEmpty,
    );
    this.splitter = h('div', { class: 'nt-splitter', role: 'separator', 'aria-orientation': 'vertical', 'aria-label': t('resizeList'), tabindex: '-1' });
    this.splitter.addEventListener('pointerdown', (e) => this.startResize(e));

    this.editor = new Editor(this);
    this.scrim = h('div', { class: 'nt-scrim', onclick: () => this.toggleNav(false) });
    this.toastHost = h('div', { class: 'nt-toasts', 'aria-live': 'polite' });
    this.loading = h('div', { class: 'nt-loading', hidden: true }, h('div', { class: 'spinner' }));
    this.root = h('div', { class: 'nt-root', tabindex: '-1' }, this.nav, this.scrim, this.listPane, this.splitter, this.editor.el, this.toastHost, this.loading);
    if (this.prefs.listW) this.root.style.setProperty('--nt-list-w', `${this.prefs.listW}px`);
    this.root.classList.toggle('nav-collapsed', !!this.prefs.navCollapsed);
    this.win.body.appendChild(this.root);
    this.root.addEventListener('keydown', (e) => this.onKey(e));
    this.ro?.disconnect();
    this.ro = new ResizeObserver(() => this.layout());
    this.ro.observe(this.win.body);
    this.layout();
  }

  setLoading(on) {
    this.loading.hidden = !on;
  }

  relocalize() {
    const sel = this.selectedId;
    this.saveCurrent();
    this.build();
    this.renderNav();
    this.renderList({ force: true });
    this.select(sel, { focus: false, force: true });
  }

  layout() {
    const w = this.win.body.clientWidth;
    const mode = w >= 980 ? 'wide' : w >= 680 ? 'medium' : 'narrow';
    if (mode !== this.mode) {
      this.mode = mode;
      this.root.dataset.layout = mode;
      this.toggleNav(false, { silent: true });
    }
    const navShown = mode === 'wide' ? !this.root.classList.contains('nav-collapsed') : this.root.classList.contains('nav-open');
    this.navToggle.setAttribute('aria-expanded', String(navShown));
  }

  toggleNav(force, { silent = false } = {}) {
    if (this.mode === 'wide') {
      if (force === false && silent) {
        this.root.classList.remove('nav-open');
        return;
      }
      const collapsed = force === undefined ? !this.root.classList.contains('nav-collapsed') : !force;
      this.root.classList.toggle('nav-collapsed', collapsed);
      this.root.classList.remove('nav-open');
      this.prefs.navCollapsed = collapsed;
      this.savePrefs();
    } else {
      const open = force === undefined ? !this.root.classList.contains('nav-open') : force;
      this.root.classList.toggle('nav-open', open);
      if (open && !silent) setTimeout(() => (this.navList.querySelector('[tabindex="0"]') || this.newBtn).focus(), 50);
    }
    this.layout();
  }

  startResize(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const start = this.listPane.getBoundingClientRect().width;
    this.root.classList.add('resizing');
    const move = (ev) => {
      const w = Math.max(240, Math.min(520, start + ev.clientX - startX));
      this.root.style.setProperty('--nt-list-w', `${w}px`);
      this.prefs.listW = Math.round(w);
    };
    const up = () => {
      this.root.classList.remove('resizing');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      this.savePrefs();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // ------------------------------------------------------------------ navigation pane
  renderNav() {
    const { h, icon } = this.ctx;
    const t = this.t;
    const counts = this.store.counts();
    const focusedKey = this.navList.contains(document.activeElement) ? document.activeElement.dataset.key : null;
    const cur = this.viewKey(this.view);
    const item = (key, view, ic, label, count, extra = {}) => {
      const el = h(
        'div',
        {
          class: ['nt-nav-item', key === cur && !this.query.terms.length && 'selected', extra.class],
          role: 'treeitem',
          tabindex: key === (focusedKey || cur) ? '0' : '-1',
          'aria-selected': String(key === cur),
          dataset: { key, ...(extra.data || {}) },
          onclick: () => this.setView(view),
          oncontextmenu: extra.menu ? (e) => extra.menu(e) : null,
        },
        extra.lead || icon(ic, { size: 18, filled: key === cur }),
        h('span', { class: 'label ellipsis' }, label),
        count ? h('span', { class: 'nt-count-badge' }, String(count)) : null,
        extra.tail || null,
      );
      if (extra.drop) this.bindDrop(el, extra.drop);
      return el;
    };
    const section = (key, label, open, actions) =>
      h(
        'div',
        { class: 'nt-nav-section', dataset: { section: key } },
        h(
          'button',
          {
            type: 'button',
            class: 'nt-nav-section-btn',
            'aria-expanded': String(open),
            onclick: () => {
              this.prefs[`${key}Closed`] = open;
              this.savePrefs();
              this.renderNav();
            },
          },
          icon(open ? 'chevron_down' : 'chevron_right', { size: 12 }),
          h('span', { class: 'ellipsis' }, label),
        ),
        actions || null,
      );
    const kids = [
      item('all', { kind: 'all' }, 'document_multiple', t('view.all'), counts.all, { drop: (ids) => this.restoreIfDeleted(ids) }),
      item('pinned', { kind: 'pinned' }, 'pin', t('view.pinned'), counts.pinned, { drop: (ids) => this.store.setMeta(ids, { pinned: true, pinnedAt: Date.now(), deletedAt: null }) }),
      item('deleted', { kind: 'deleted' }, 'delete', t('view.deleted'), counts.deleted, { drop: (ids) => this.deleteNotes(ids) }),
    ];
    const nbOpen = !this.prefs.notebooksClosed;
    kids.push(
      section(
        'notebooks',
        t('notebooks'),
        nbOpen,
        h('button', { type: 'button', class: 'btn subtle icon-btn nt-nav-add', 'aria-label': t('newNotebook'), 'data-tip': `${t('newNotebook')} (Ctrl+Shift+N)`, onclick: () => this.newNotebook() }, icon('add', { size: 14 })),
      ),
    );
    if (nbOpen) {
      for (const nb of this.store.notebooks) {
        kids.push(
          item(`nb:${nb.id}`, { kind: 'notebook', id: nb.id }, null, nb.name, counts.notebooks[nb.id] || 0, {
            class: 'nt-nav-nb',
            data: { color: nb.color, id: nb.id },
            lead: nb.emoji ? h('span', { class: 'nt-nb-emoji', 'aria-hidden': 'true' }, nb.emoji) : h('span', { class: 'nt-nb-icon', dataset: { color: nb.color } }, icon('notebook', { size: 18, filled: true })),
            menu: (e) => this.notebookMenu(nb, e),
            drop: (ids) => this.moveNotes(ids, nb.id),
          }),
        );
      }
    }
    const tags = this.store.tags();
    if (tags.length) {
      const tagsOpen = !this.prefs.tagsClosed;
      kids.push(section('tags', t('tags'), tagsOpen));
      if (tagsOpen) for (const tg of tags) kids.push(item(`tag:${tg.tag}`, { kind: 'tag', id: tg.tag }, 'number_symbol', tg.tag, tg.count, { class: 'nt-nav-tag' }));
    }
    this.navList.replaceChildren(...kids);
    if (!this.navList.querySelector('[tabindex="0"]')) this.navList.querySelector('.nt-nav-item')?.setAttribute('tabindex', '0');
    if (focusedKey) this.navList.querySelector(`[data-key="${CSS.escape(focusedKey)}"]`)?.focus({ preventScroll: true });
  }

  viewKey(v) {
    return v.kind === 'notebook' ? `nb:${v.id}` : v.kind === 'tag' ? `tag:${v.id}` : v.kind;
  }

  navKeys(e) {
    const items = [...this.navList.querySelectorAll('.nt-nav-item, .nt-nav-section-btn')];
    const i = items.indexOf(document.activeElement);
    if (i < 0) return;
    const move = (j) => {
      e.preventDefault();
      j = Math.max(0, Math.min(items.length - 1, j));
      for (const x of items) if (x.classList.contains('nt-nav-item')) x.tabIndex = -1;
      items[j].tabIndex = 0;
      items[j].focus();
    };
    const el = items[i];
    if (e.key === 'ArrowDown') move(i + 1);
    else if (e.key === 'ArrowUp') move(i - 1);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(items.length - 1);
    else if ((e.key === 'Enter' || e.key === ' ') && el.classList.contains('nt-nav-item')) {
      e.preventDefault();
      el.click();
      if (this.mode !== 'wide') this.toggleNav(false);
      this.focusList();
    } else if ((e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) && el.dataset.id) {
      e.preventDefault();
      const nb = this.store.notebook(el.dataset.id);
      if (nb) this.notebookMenu(nb, el);
    } else if (e.key === 'F2' && el.dataset.id) {
      e.preventDefault();
      const nb = this.store.notebook(el.dataset.id);
      if (nb) this.editNotebook(nb);
    } else if (e.key === 'Delete' && el.dataset.id) {
      e.preventDefault();
      const nb = this.store.notebook(el.dataset.id);
      if (nb) this.deleteNotebook(nb);
    }
  }

  bindDrop(el, onDrop) {
    let depth = 0;
    el.addEventListener('dragenter', (e) => {
      if (![...e.dataTransfer.types].includes(NOTE_MIME)) return;
      e.preventDefault();
      depth++;
      el.classList.add('drop-target');
    });
    el.addEventListener('dragover', (e) => {
      if (![...e.dataTransfer.types].includes(NOTE_MIME)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    });
    el.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (!depth) el.classList.remove('drop-target');
    });
    el.addEventListener('drop', async (e) => {
      depth = 0;
      el.classList.remove('drop-target');
      const raw = e.dataTransfer.getData(NOTE_MIME);
      if (!raw) return;
      e.preventDefault();
      let ids = [];
      try {
        ids = JSON.parse(raw);
      } catch {
        ids = [raw];
      }
      ids = ids.filter((id) => this.store.get(id));
      if (!ids.length) return;
      await this.saveCurrent();
      try {
        await onDrop(ids);
      } catch (err) {
        this.error(err.message);
      }
    });
  }

  setView(view, { keepSearch = false } = {}) {
    if (!keepSearch && this.query.terms.length + this.query.tags.length) this.clearSearch(false);
    this.view = view;
    this.savePrefs();
    this.renderNav();
    this.renderList({ force: true, resetScroll: true });
    if (this.mode !== 'wide') this.toggleNav(false);
    // keep the open note when it is part of the new view, else open the first one
    const list = this.visibleNotes();
    if (!list.some((n) => n.id === this.selectedId)) this.select(this.mode === 'narrow' ? null : list[0]?.id || null, { focus: false });
    else this.updateSelection();
  }

  // ------------------------------------------------------------------ list
  visibleNotes() {
    const searching = !this.query.empty;
    const view = searching && this.view.kind !== 'deleted' ? { kind: 'all' } : this.view;
    const list = this.store.query(view, this.query, this.sort);
    if (view.kind === 'deleted' || this.sort === 'title' || searching) return list;
    // pinned notes first (Apple Notes / OneNote style), except in the Pinned view
    if (view.kind === 'pinned') return list;
    return [...list.filter((n) => n.pinned), ...list.filter((n) => !n.pinned)];
  }

  viewTitle() {
    const t = this.t;
    if (!this.query.empty) return t('searchResults');
    switch (this.view.kind) {
      case 'pinned':
        return t('view.pinned');
      case 'deleted':
        return t('view.deleted');
      case 'notebook':
        return this.store.notebook(this.view.id)?.name || t('view.all');
      case 'tag':
        return `#${this.view.id}`;
      default:
        return t('view.all');
    }
  }

  groupLabel(g) {
    const t = this.t;
    if (g.key === 'pinned') return t('group.pinned');
    if (g.key === 'today') return t('group.today');
    if (g.key === 'yesterday') return t('group.yesterday');
    if (g.key === 'week') return t('group.week');
    if (g.key === 'month') return t('group.month');
    if (g.month !== undefined) return new Intl.DateTimeFormat(this.locale, { month: 'long' }).format(new Date(g.year, g.month, 1)).replace(/^\p{Ll}/u, (c) => c.toLocaleUpperCase(this.locale));
    return String(g.year);
  }

  renderList({ force = false, resetScroll = false } = {}) {
    if (!this.ready) return;
    const { h, icon } = this.ctx;
    const t = this.t;
    const notes = this.visibleNotes();
    this.listTitle.textContent = this.viewTitle();
    const deletedView = this.view.kind === 'deleted' && this.query.empty;
    this.listCount.textContent = deletedView && notes.length ? t('deleted.hint', { count: PURGE_DAYS }) : t('noteCount', { count: notes.length });
    this.listPane.classList.toggle('searching', !this.query.empty);
    const searching = !this.query.empty;
    const showNb = searching || ['all', 'pinned', 'tag', 'deleted'].includes(this.view.kind);
    const grouped = !searching && this.sort !== 'title';
    const kids = [];
    let lastGroup = null;
    for (const n of notes) {
      if (grouped) {
        const g = n.pinned && this.view.kind !== 'pinned' && this.view.kind !== 'deleted' ? { key: 'pinned' } : dateGroup(this.view.kind === 'deleted' ? n.deletedAt : this.sort === 'created' ? n.created : n.modified);
        if (g.key !== lastGroup) {
          kids.push(h('div', { class: 'nt-group-head caption', role: 'presentation' }, this.groupLabel(g)));
          lastGroup = g.key;
        }
      }
      kids.push(this.itemFor(n, { showNb, force }));
    }
    const scroll = this.listEl.scrollTop;
    const hadFocus = this.listEl.contains(document.activeElement) ? document.activeElement.dataset.id : null;
    this.listEl.replaceChildren(...kids);
    // drop cached items of notes that are no longer listed
    if (this.itemCache.size > notes.length * 2 + 50) {
      const keep = new Set(notes.map((n) => n.id));
      for (const id of this.itemCache.keys()) if (!keep.has(id)) this.itemCache.delete(id);
    }
    this.listEl.scrollTop = resetScroll ? 0 : scroll;
    this.updateSelection();
    if (hadFocus) this.listEl.querySelector(`.nt-item[data-id="${CSS.escape(hadFocus)}"]`)?.focus({ preventScroll: true });
    // empty states
    this.listEmpty.hidden = notes.length > 0;
    if (!notes.length) {
      const e = searching
        ? [icon('search', { size: 48 }), h('div', { class: 'body-strong' }, t('empty.noResults')), h('div', { class: 'caption' }, t('empty.noResultsHint'))]
        : this.view.kind === 'deleted'
          ? [icon('delete', { size: 48 }), h('div', { class: 'body-strong' }, t('empty.noDeleted')), h('div', { class: 'caption' }, t('empty.noDeletedHint', { count: PURGE_DAYS }))]
          : this.view.kind === 'pinned'
            ? [icon('pin', { size: 48 }), h('div', { class: 'body-strong' }, t('empty.noPinned')), h('div', { class: 'caption' }, t('empty.noPinnedHint'))]
            : [
                icon('note', { size: 48 }),
                h('div', { class: 'body-strong' }, t('empty.noNotes')),
                h('div', { class: 'caption' }, t('empty.noNotesHint')),
                h('button', { type: 'button', class: 'btn', onclick: () => this.newNote() }, icon('note_add', { size: 16 }), t('newNote')),
              ];
      this.listEmpty.replaceChildren(...e);
    }
  }

  itemFor(n, { showNb, force }) {
    const { h, icon } = this.ctx;
    const t = this.t;
    const nb = this.store.notebook(n.notebookId);
    const sig = [n.modified, n.title, n.preview, n.pinned, n.thumb, n.deletedAt, n.notebookId, nb?.name, nb?.color, nb?.emoji, showNb, this.query.terms.join('\u0001'), this.sort, this.ctx.lang].join('|');
    const cached = this.itemCache.get(n.id);
    if (cached && cached._sig === sig && !force) return cached;
    const title = displayTitle(n);
    const searching = this.query.terms.length > 0;
    const segs = searching ? snippet(`${n.title ? `${n.firstLine} ` : ''}${n.text}`, this.query.terms, 160) : null;
    const date = this.listDate(this.view.kind === 'deleted' ? n.deletedAt : this.sort === 'created' ? n.created : n.modified);
    const titleEl = h('div', { class: ['nt-item-title ellipsis', !title && 'untitled'] });
    if (searching && title) this.fillHighlighted(titleEl, title);
    else titleEl.textContent = title || t('untitled');
    const preview = h('div', { class: 'nt-item-preview ellipsis' });
    if (segs) for (const s of segs) preview.appendChild(s.hit ? h('mark', null, s.text) : document.createTextNode(s.text));
    else preview.textContent = n.preview || t('noText');
    let thumb = null;
    if (n.thumb) {
      const src = /^(https?|data|media):/.test(n.thumb) ? n.thumb : this.ctx.api.mediaUrl(`${this.store.root}/${n.id}/${n.thumb}`);
      thumb = h('img', { class: 'nt-item-thumb', src, alt: '', loading: 'lazy', decoding: 'async', draggable: false, onerror: (e) => e.currentTarget.remove() });
    }
    const days = n.deletedAt ? Math.max(0, Math.ceil((n.deletedAt + PURGE_DAYS * 86400000 - Date.now()) / 86400000)) : 0;
    const el = h(
      'div',
      {
        class: ['nt-item', thumb && 'has-thumb'],
        role: 'option',
        tabindex: '-1',
        draggable: 'true',
        dataset: { id: n.id },
        'aria-label': `${title || t('untitled')}, ${date}`,
        onclick: () => this.select(n.id, { fromList: true }),
        oncontextmenu: (e) => {
          e.preventDefault();
          this.select(n.id, { focus: false, fromList: true });
          this.noteMenu(this.store.get(n.id), e);
        },
        ondragstart: (e) => {
          this.saveCurrent();
          e.dataTransfer.setData(NOTE_MIME, JSON.stringify([n.id]));
          e.dataTransfer.setData('text/plain', title || t('untitled'));
          e.dataTransfer.effectAllowed = 'move';
          el.classList.add('dragging');
          this.root.classList.add('dragging-note');
        },
        ondragend: () => {
          el.classList.remove('dragging');
          this.root.classList.remove('dragging-note');
        },
      },
      h(
        'div',
        { class: 'nt-item-main' },
        h('div', { class: 'nt-item-row' }, titleEl, n.pinned ? h('span', { class: 'nt-item-pin', 'aria-label': t('pinned'), title: t('pinned') }, icon('pin', { size: 12, filled: true })) : null, h('span', { class: 'nt-item-date caption' }, date)),
        preview,
        showNb || n.deletedAt
          ? h(
              'div',
              { class: 'nt-item-meta caption' },
              nb ? h('span', { class: 'nt-item-nb', dataset: { color: nb.color } }, nb.emoji ? h('span', { class: 'nt-nb-emoji' }, nb.emoji) : h('span', { class: 'nt-nb-dot' }), h('span', { class: 'ellipsis' }, nb.name)) : null,
              n.deletedAt ? h('span', { class: 'nt-item-days' }, t('deleted.daysLeft', { count: days })) : null,
            )
          : null,
      ),
      thumb,
    );
    el._sig = sig;
    this.itemCache.set(n.id, el);
    return el;
  }

  fillHighlighted(el, text) {
    const segs = snippet(text, this.query.terms, 500);
    el.replaceChildren(...segs.map((s) => (s.hit ? this.ctx.h('mark', null, s.text) : document.createTextNode(s.text))));
  }

  listDate(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    const now = new Date();
    const h12 = this.ctx.settings.get('clock24h');
    const timeOpts = { hour: 'numeric', minute: '2-digit', ...(h12 == null ? {} : { hour12: !h12 }) };
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return new Intl.DateTimeFormat(this.locale, timeOpts).format(d);
    const y = new Date(now);
    y.setDate(y.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return this.t('group.yesterday');
    if (now - d < 6 * 86400000) return new Intl.DateTimeFormat(this.locale, { weekday: 'long' }).format(d);
    return new Intl.DateTimeFormat(this.locale, { dateStyle: 'short' }).format(d);
  }

  fmtDate(ms, withTime = false) {
    if (!ms) return '';
    const h12 = this.ctx.settings.get('clock24h');
    return new Intl.DateTimeFormat(this.locale, withTime ? { dateStyle: 'long', timeStyle: 'short', ...(h12 == null ? {} : { hour12: !h12 }) } : { dateStyle: 'long' }).format(new Date(ms));
  }

  fmtRelative(ms) {
    if (!ms) return '';
    if (Date.now() - ms < 45000) return this.t('justNow');
    return this.ctx.i18n.relativeTime(ms);
  }

  refreshDates() {
    this.renderList({ force: true });
    this.editor.renderEdited();
  }

  updateSelection() {
    let found = false;
    for (const el of this.listEl.querySelectorAll('.nt-item')) {
      const on = el.dataset.id === this.selectedId;
      el.classList.toggle('selected', on);
      el.setAttribute('aria-selected', String(on));
      el.tabIndex = on ? 0 : -1;
      if (on) found = true;
    }
    if (!found) this.listEl.querySelector('.nt-item')?.setAttribute('tabindex', '0');
  }

  focusList() {
    const el = this.listEl.querySelector('.nt-item.selected') || this.listEl.querySelector('.nt-item');
    if (el) el.focus();
    else this.listEl.focus();
  }

  listKeys(e) {
    const items = [...this.listEl.querySelectorAll('.nt-item')];
    const cur = document.activeElement?.closest?.('.nt-item');
    const i = items.indexOf(cur);
    const go = (j) => {
      e.preventDefault();
      const el = items[Math.max(0, Math.min(items.length - 1, j))];
      if (!el) return;
      this.select(el.dataset.id, { focus: false, fromList: true, keepListFocus: true });
      el.focus();
      el.scrollIntoView({ block: 'nearest' });
    };
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i < 0 ? 0 : i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(items.length - 1);
    else if (e.key === 'PageDown') go(i + 8);
    else if (e.key === 'PageUp') go(i - 8);
    else if (e.key === 'Enter' && cur) {
      e.preventDefault();
      this.select(cur.dataset.id, { focus: true, fromList: true });
    } else if (e.key === 'Delete' && cur) {
      e.preventDefault();
      const n = this.store.get(cur.dataset.id);
      if (n?.deletedAt) this.purgeNotes([n.id]);
      else this.deleteNotes([cur.dataset.id]);
    } else if ((e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) && cur) {
      e.preventDefault();
      this.noteMenu(this.store.get(cur.dataset.id), cur);
    } else if (e.key === 'F2' && cur) {
      e.preventDefault();
      this.select(cur.dataset.id, { focus: false });
      this.editor.title.focus();
      this.editor.title.select();
    }
  }

  // ------------------------------------------------------------------ selection
  async select(id, { focus = true, force = false, fromList = false, keepListFocus = false } = {}) {
    if (id === this.selectedId && !force) {
      if (this.mode === 'narrow' && id) this.root.classList.add('show-editor');
      if (focus && id && !keepListFocus) this.editor.load(this.store.get(id), { focus: true, terms: this.query.terms });
      return;
    }
    const token = ++this.selToken;
    const prev = this.selectedId;
    if (prev && prev !== id) await this.leaveNote(prev);
    if (token !== this.selToken) return; // a newer selection won
    this.selectedId = id && this.store.get(id) ? id : null;
    const note = this.selectedId ? this.store.get(this.selectedId) : null;
    this.editor.load(note, { focus: focus && !keepListFocus, terms: this.query.terms });
    this.root.classList.toggle('show-editor', !!note && this.mode === 'narrow' && (fromList || focus));
    this.updateSelection();
    this.updateWindowTitle();
    this.savePrefs();
    if (note && !keepListFocus) this.listEl.querySelector(`.nt-item[data-id="${CSS.escape(note.id)}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  showList() {
    this.root.classList.remove('show-editor');
    this.focusList();
  }

  reveal(id) {
    const n = this.store.get(id);
    if (!n) return;
    if (!this.visibleNotes().some((x) => x.id === id)) {
      this.clearSearch(false);
      this.view = n.deletedAt ? { kind: 'deleted' } : { kind: 'notebook', id: n.notebookId };
      this.renderNav();
      this.renderList({ force: true });
    }
    this.select(id, { focus: true, fromList: true });
  }

  updateWindowTitle() {
    const n = this.selectedId && this.store.get(this.selectedId);
    const title = n ? displayTitle(n) || this.t('untitled') : '';
    this.win.setTitle(title ? `${title} - ${this.t('appName')}` : this.t('appName'));
  }

  /** Save, clean up attachments, and drop a note that was created and left empty. */
  async leaveNote(id) {
    if (this.editor.note?.id === id) await this.saveCurrent();
    const n = this.store.get(id);
    if (!n) return;
    if (this.sessionNew.has(id) && !n.title && !n.text.trim() && !n.html.includes('<img') && !n.html.includes('<hr') && !n.html.includes('<table') && !n.deletedAt) {
      this.sessionNew.delete(id);
      await this.store.purge([id]).catch(() => {});
      return;
    }
    const keep = [...n.html.matchAll(/data-att="([^"]+)"/g)].map((m) => m[1]);
    this.ctx.api.invoke('notes:gc', id, keep).catch(() => {});
  }

  // ------------------------------------------------------------------ saving
  scheduleSave() {
    this.editSeq++;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveCurrent(), 500);
  }

  async saveCurrent() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const ed = this.editor;
    const note = ed?.note;
    if (!note || ed.readOnly) return true;
    const cur = this.store.get(note.id);
    if (!cur) return true;
    const html = ed.serialize();
    const title = ed.title.value.replace(/\s+/g, ' ').trim();
    if (cur.html === html && cur.title === title) {
      if (ed.savedState === 'pending' || ed.savedState === 'saving') ed.setSaved('saved');
      return true;
    }
    const seq = this.editSeq;
    ed.setSaved('saving');
    try {
      const updated = await this.store.update(note.id, { html, title });
      if (ed.note?.id === note.id) {
        ed.note = updated;
        if (seq === this.editSeq) ed.setSaved('saved');
        this.updateWindowTitle();
      }
      return true;
    } catch (err) {
      console.error('[notes] save failed', err);
      if (ed.note?.id === note.id) ed.setSaved('error', err);
      return false;
    }
  }

  onStoreChange(what, data) {
    if (what === 'error') {
      if (!this._errShown) {
        this._errShown = true;
        this.error(this.t('errors.save', { message: data?.message || '' }), { after: () => (this._errShown = false) });
      }
      return;
    }
    cancelAnimationFrame(this._renderRaf);
    this._renderRaf = requestAnimationFrame(() => {
      this.renderNav();
      this.renderList();
      if (data?.kind === 'notebooks' || data?.kind === 'meta') {
        const n = this.selectedId && this.store.get(this.selectedId);
        if (n && this.editor.note?.id === n.id) {
          this.editor.note = n;
          this.editor.renderMeta();
          this.editor.updateState();
        }
      }
    });
  }

  // ------------------------------------------------------------------ actions
  async newNote({ title = '', text = '', notebookId } = {}) {
    if (!this.ready) return null;
    await this.saveCurrent();
    let nbId = notebookId || (this.view.kind === 'notebook' ? this.view.id : this.prefs.lastNotebook);
    if (!this.store.notebook(nbId)) nbId = this.store.notebooks[0]?.id;
    let html = '';
    if (text) html = text.split('\n').map((l) => `<div>${l ? escapeText(l) : '<br>'}</div>`).join('');
    else if (this.view.kind === 'tag') html = `<div>#${escapeText(this.view.id)} </div>`;
    try {
      const n = await this.store.create({ title, html, notebookId: nbId, pinned: this.view.kind === 'pinned' });
      this.sessionNew.add(n.id);
      if (!this.query.empty) this.clearSearch(false);
      if (this.view.kind === 'deleted') this.view = { kind: 'all' };
      this.renderNav();
      this.renderList({ force: true });
      await this.select(n.id, { focus: true, fromList: true });
      this.editor.title.focus();
      return n;
    } catch (err) {
      this.error(this.t('errors.create', { message: err.message }));
      return null;
    }
  }

  async togglePin(id) {
    const n = id && this.store.get(id);
    if (!n || n.deletedAt) return;
    await this.saveCurrent();
    await this.store.pin(id, !n.pinned);
    this.toast(n.pinned ? this.t('toast.pinned') : this.t('toast.unpinned'));
  }

  async deleteNotes(ids) {
    ids = ids.filter((id) => this.store.get(id) && !this.store.get(id).deletedAt);
    if (!ids.length) return;
    await this.saveCurrent();
    const list = this.visibleNotes();
    const idx = list.findIndex((n) => n.id === this.selectedId);
    const wasSelected = ids.includes(this.selectedId);
    for (const id of ids) this.sessionNew.delete(id);
    await this.store.trash(ids);
    if (wasSelected) {
      const remaining = this.visibleNotes();
      const next = remaining[Math.min(Math.max(0, idx), remaining.length - 1)];
      this.selectedId = null;
      await this.select(next?.id || null, { focus: false });
      this.focusList();
    }
    this.toast(this.t('toast.deleted', { count: ids.length }), {
      action: this.t('undo'),
      onAction: () => this.restoreNotes(ids, { reveal: ids.length === 1 }),
    });
  }

  async restoreNotes(ids, { reveal = true } = {}) {
    await this.store.restore(ids);
    if (reveal && ids.length === 1) {
      if (this.view.kind === 'deleted') this.select(ids[0], { focus: false, force: true });
      else this.reveal(ids[0]);
    } else if (this.selectedId && ids.includes(this.selectedId)) this.select(this.selectedId, { force: true, focus: false });
    this.toast(this.t('toast.restored', { count: ids.length }));
  }

  async restoreIfDeleted(ids) {
    const del = ids.filter((id) => this.store.get(id)?.deletedAt);
    if (del.length) await this.restoreNotes(del, { reveal: false });
  }

  async purgeNotes(ids) {
    const t = this.t;
    const one = ids.length === 1 ? this.store.get(ids[0]) : null;
    const ok = await this.ctx.ui.confirm(one ? t('confirm.purgeOne', { title: displayTitle(one) || t('untitled') }) : t('confirm.purgeMany', { count: ids.length }), {
      title: t('deletePermanently'),
      okLabel: t('delete'),
      danger: true,
      parent: this.win,
    });
    if (!ok) return;
    const list = this.visibleNotes();
    const idx = list.findIndex((n) => n.id === this.selectedId);
    try {
      await this.store.purge(ids);
    } catch (err) {
      this.error(t('errors.delete', { message: err.message }));
      return;
    }
    if (ids.includes(this.selectedId)) {
      this.selectedId = null;
      const remaining = this.visibleNotes();
      this.editor.load(null);
      await this.select(remaining[Math.min(Math.max(0, idx), remaining.length - 1)]?.id || null, { focus: false });
    }
    this.focusList();
  }

  async emptyDeleted() {
    const ids = this.store.all().filter((n) => n.deletedAt).map((n) => n.id);
    if (!ids.length) return;
    const ok = await this.ctx.ui.confirm(this.t('confirm.empty', { count: ids.length }), { title: this.t('emptyDeleted'), okLabel: this.t('emptyDeleted'), danger: true, parent: this.win });
    if (!ok) return;
    try {
      await this.store.purge(ids);
    } catch (err) {
      this.error(this.t('errors.delete', { message: err.message }));
    }
    if (ids.includes(this.selectedId)) {
      this.selectedId = null;
      this.editor.load(null);
    }
  }

  async moveNotes(ids, notebookId) {
    const nb = this.store.notebook(notebookId);
    if (!nb) return;
    await this.saveCurrent();
    const del = ids.filter((id) => this.store.get(id)?.deletedAt);
    await this.store.move(ids, notebookId);
    if (del.length) await this.store.restore(del);
    this.prefs.lastNotebook = notebookId;
    this.toast(this.t('toast.moved', { count: ids.length, name: nb.name }));
    if (this.selectedId && ids.includes(this.selectedId) && !this.visibleNotes().some((n) => n.id === this.selectedId)) {
      // the note left the current view: keep showing it (its chip now shows the new notebook)
      this.editor.note = this.store.get(this.selectedId);
      this.editor.renderMeta();
    }
  }

  moveMenu(ids, anchor) {
    const cur = ids.length === 1 ? this.store.get(ids[0])?.notebookId : null;
    this.ctx.ui.menu(anchor, [
      { header: this.t('moveTo') },
      ...this.store.notebooks.map((nb) => ({ label: nb.emoji ? `${nb.emoji}  ${nb.name}` : nb.name, icon: nb.emoji ? null : 'notebook', checked: nb.id === cur, action: () => this.moveNotes(ids, nb.id) })),
      '-',
      { label: this.t('newNotebookEllipsis'), icon: 'notebook_add', action: async () => {
        const nb = await this.newNotebook({ select: false });
        if (nb) this.moveNotes(ids, nb.id);
      } },
    ]);
  }

  async duplicate(id) {
    await this.saveCurrent();
    try {
      const n = await this.store.duplicate(id, this.t('copySuffix'));
      if (n) this.reveal(n.id);
    } catch (err) {
      this.error(this.t('errors.duplicate', { message: err.message }));
    }
  }

  async share(note) {
    await this.saveCurrent();
    const n = this.store.get(note.id) || note;
    const box = document.createElement('div');
    box.appendChild(sanitizeFragment(n.html, { attachments: true, allowRemote: true, allowMedia: true }));
    try {
      await this.ctx.shell.launch('mail', { subject: displayTitle(n) || this.t('untitled'), body: plainText(box, { bullets: true, checklistMarks: true }) });
    } catch (err) {
      this.error(err.message);
    }
  }

  noteMenu(note, anchor) {
    if (!note) return;
    const t = this.t;
    if (note.deletedAt) {
      this.ctx.ui.menu(anchor, [
        { label: t('restore'), icon: 'arrow_undo', action: () => this.restoreNotes([note.id]) },
        { label: t('moveTo'), icon: 'folder_arrow_right', submenu: this.store.notebooks.map((nb) => ({ label: nb.name, action: () => this.moveNotes([note.id], nb.id) })) },
        '-',
        { label: t('deletePermanently'), icon: 'delete_dismiss', danger: true, shortcut: 'Delete', action: () => this.purgeNotes([note.id]) },
      ]);
      return;
    }
    this.ctx.ui.menu(anchor, [
      { label: note.pinned ? t('unpin') : t('pin'), icon: note.pinned ? 'pin_off' : 'pin', shortcut: 'Ctrl+P', action: () => this.togglePin(note.id) },
      { label: t('moveTo'), icon: 'folder_arrow_right', submenu: this.store.notebooks.map((nb) => ({ label: nb.emoji ? `${nb.emoji}  ${nb.name}` : nb.name, checked: nb.id === note.notebookId, action: () => this.moveNotes([note.id], nb.id) })) },
      { label: t('duplicate'), icon: 'copy', action: () => this.duplicate(note.id) },
      '-',
      {
        label: t('export.menu'),
        icon: 'arrow_export_ltr',
        submenu: [
          { label: t('fmt.md'), icon: 'document_text', action: () => exportNote(this, note, 'md') },
          { label: t('fmt.txt'), icon: 'document', action: () => exportNote(this, note, 'txt') },
          { label: t('fmt.html'), icon: 'globe', action: () => exportNote(this, note, 'html') },
        ],
      },
      { label: t('shareMail'), icon: 'mail', action: () => this.share(note) },
      { label: t('ed.find'), icon: 'search', shortcut: 'Ctrl+F', action: () => (this.select(note.id, { focus: false }), this.editor.openFind()) },
      '-',
      { label: t('delete'), icon: 'delete', danger: true, shortcut: 'Delete', action: () => this.deleteNotes([note.id]) },
    ]);
  }

  sortMenu(anchor) {
    const t = this.t;
    this.ctx.ui.menu(anchor, [
      { header: t('sort.label') },
      ...SORTS.map((s) => ({
        label: t(`sort.${s}`),
        checked: this.sort === s,
        action: () => {
          this.sort = s;
          this.savePrefs();
          this.renderList({ force: true });
        },
      })),
    ]);
  }

  listMenu(anchor) {
    const t = this.t;
    const hasDeleted = this.store.counts().deleted > 0;
    this.ctx.ui.menu(anchor, [
      { label: t('newNote'), icon: 'note_add', shortcut: 'Ctrl+N', action: () => this.newNote() },
      { label: t('newNotebookEllipsis'), icon: 'notebook_add', shortcut: 'Ctrl+Shift+N', action: () => this.newNotebook() },
      { label: t('import.menu'), icon: 'arrow_import', action: () => this.importNotes() },
      '-',
      this.view.kind === 'deleted' ? { label: t('emptyDeleted'), icon: 'delete_dismiss', danger: true, disabled: !hasDeleted, action: () => this.emptyDeleted() } : null,
      { label: t('keys.title'), icon: 'keyboard', action: () => shortcutsDialog(this) },
    ].filter(Boolean));
  }

  // ---- notebooks
  async newNotebook({ select = true } = {}) {
    const res = await notebookDialog(this);
    if (!res) return null;
    try {
      const nb = await this.store.addNotebook(res);
      this.prefs.notebooksClosed = false;
      if (select) this.setView({ kind: 'notebook', id: nb.id });
      else this.renderNav();
      return nb;
    } catch (err) {
      this.error(this.t('errors.notebook', { message: err.message }));
      return null;
    }
  }

  async editNotebook(nb) {
    const res = await notebookDialog(this, nb);
    if (!res) return;
    try {
      await this.store.updateNotebook(nb.id, res);
      this.renderList({ force: true });
    } catch (err) {
      this.error(this.t('errors.notebook', { message: err.message }));
    }
  }

  async deleteNotebook(nb) {
    const t = this.t;
    if (this.store.notebooks.length <= 1) {
      await this.ctx.ui.alert(t('nb.lastOne'), { title: t('nb.delete'), parent: this.win });
      return;
    }
    const count = this.store.counts().notebooks[nb.id] || 0;
    const ok = await this.ctx.ui.confirm(count ? t('confirm.deleteNotebook', { name: nb.name, count }) : t('confirm.deleteEmptyNotebook', { name: nb.name }), {
      title: t('nb.delete'),
      okLabel: t('delete'),
      danger: true,
      parent: this.win,
    });
    if (!ok) return;
    await this.saveCurrent();
    try {
      await this.store.removeNotebook(nb.id);
    } catch (err) {
      this.error(t('errors.notebook', { message: err.message }));
      return;
    }
    if (this.view.kind === 'notebook' && this.view.id === nb.id) this.setView({ kind: 'all' });
    if (this.selectedId && this.store.get(this.selectedId)?.deletedAt) this.select(this.selectedId, { force: true, focus: false });
    this.toast(count ? t('toast.notebookDeleted', { name: nb.name, count }) : t('toast.notebookDeletedEmpty', { name: nb.name }));
  }

  notebookMenu(nb, e) {
    const t = this.t;
    const idx = this.store.notebooks.indexOf(nb);
    const ids = this.store.notebooks.map((b) => b.id);
    const swap = (d) => () => {
      const j = idx + d;
      [ids[idx], ids[j]] = [ids[j], ids[idx]];
      this.store.reorderNotebooks(ids);
    };
    this.ctx.ui.menu(e, [
      { label: t('newNoteHere'), icon: 'note_add', action: () => this.newNote({ notebookId: nb.id }) },
      '-',
      { label: t('nb.edit'), icon: 'edit', shortcut: 'F2', action: () => this.editNotebook(nb) },
      { label: t('nb.moveUp'), icon: 'arrow_up', disabled: idx <= 0, action: swap(-1) },
      { label: t('nb.moveDown'), icon: 'arrow_down', disabled: idx >= ids.length - 1, action: swap(1) },
      '-',
      { label: t('nb.delete'), icon: 'delete', danger: true, disabled: this.store.notebooks.length <= 1, action: () => this.deleteNotebook(nb) },
    ]);
  }

  async importNotes() {
    const ids = await importFiles(this);
    if (ids.length) this.reveal(ids[ids.length - 1]);
  }

  // ------------------------------------------------------------------ search
  setSearch(q) {
    const next = parseQuery(q);
    this.searchClear.hidden = !q;
    const same = JSON.stringify(next) === JSON.stringify(this.query);
    this.query = next;
    if (same) return;
    this.renderNav();
    this.renderList({ force: true, resetScroll: true });
    this.editor.setSearchTerms(this.query.terms);
    const list = this.visibleNotes();
    if (!this.query.empty && list.length && !list.some((n) => n.id === this.selectedId)) this.select(list[0].id, { focus: false, keepListFocus: true });
  }

  clearSearch(focus = true) {
    this.searchInput.value = '';
    this.searchClear.hidden = true;
    if (!this.query.empty) {
      this.query = parseQuery('');
      this.renderNav();
      this.renderList({ force: true });
      this.editor.setSearchTerms([]);
    }
    if (focus) this.searchInput.focus();
  }

  // ------------------------------------------------------------------ keyboard
  onKey(e) {
    if (e.defaultPrevented) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const go = (fn) => {
      e.preventDefault();
      e.stopPropagation();
      fn();
    };
    if (ctrl && !e.altKey) {
      if (k === 'n' && !e.shiftKey) return go(() => this.newNote());
      if (k === 'n' && e.shiftKey) return go(() => this.newNotebook());
      if (k === 'e' || (k === 'f' && e.shiftKey)) return go(() => (this.searchInput.focus(), this.searchInput.select()));
      if (k === 'f' && !e.shiftKey) return go(() => (this.editor.note ? this.editor.openFind() : this.searchInput.focus()));
      if (k === 'p' && !e.shiftKey) return go(() => this.togglePin(this.selectedId));
      if (k === 's' && !e.shiftKey) return go(() => this.saveCurrent());
      if (k === '/') return go(() => shortcutsDialog(this));
    }
    if (e.key === 'F1') return go(() => shortcutsDialog(this));
    if (e.key === 'Escape' && this.root.classList.contains('nav-open')) return go(() => this.toggleNav(false));
  }

  // ------------------------------------------------------------------ feedback
  toast(text, { action, onAction, timeout = 4500 } = {}) {
    const { h, icon } = this.ctx;
    for (const old of this.toastHost.children) old.remove();
    const el = h(
      'div',
      { class: 'nt-toast', role: 'status' },
      h('span', { class: 'grow' }, text),
      action
        ? h('button', { type: 'button', class: 'btn subtle nt-toast-action', onclick: () => {
            close();
            onAction?.();
          } }, action)
        : null,
      h('button', { type: 'button', class: 'btn subtle icon-btn', 'aria-label': this.t('common.close'), onclick: () => close() }, icon('dismiss', { size: 12 })),
    );
    const close = () => {
      clearTimeout(timer);
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 160);
    };
    const timer = setTimeout(close, timeout);
    this.toastHost.appendChild(el);
  }

  toastClear() {
    for (const el of this.toastHost.children) el.remove();
  }

  error(message, { after } = {}) {
    return this.ctx.ui.alert(message, { title: this.t('errors.title'), parent: this.win }).then(() => after?.());
  }

  // ------------------------------------------------------------------ closing
  async beforeClose() {
    const ok = await this.saveCurrent();
    try {
      await this.store.flush();
    } catch {}
    if (!ok) {
      const v = await this.ctx.ui.confirm(this.t('confirm.closeUnsaved'), { title: this.t('errors.title'), okLabel: this.t('closeAnyway'), danger: true, parent: this.win });
      if (!v) return false;
    }
    if (this.selectedId) await this.leaveNote(this.selectedId);
    await this.store.flush();
    return true;
  }
}

function escapeText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
