// Content area of File Explorer: Details / icons (XL, L, M, S) / List / Tiles views, the Home and
// This PC pages, grouping, selection (click, Ctrl/Shift, rubber band, keyboard, type-to-find),
// inline rename, thumbnails and drag & drop.
import { shared, getColumns, saveColumns, isPinned } from './shared.js';
import * as T from './types.js';
import * as ops from './ops.js';
import { TRASH_TARGET } from './dnd.js';

const MODES = ['xl', 'large', 'medium', 'small', 'list', 'details', 'tiles'];
export const VIEW_MODES = MODES;
const ICON_SIZE = { xl: 256, large: 96, medium: 48, small: 16, list: 16, details: 16, tiles: 48 };

const COLSETS = {
  dir: [
    { id: 'name', width: 300 },
    { id: 'mtime', width: 168 },
    { id: 'type', width: 160 },
    { id: 'size', width: 104, align: 'end' },
  ],
  search: [
    { id: 'name', width: 260 },
    { id: 'location', width: 280 },
    { id: 'mtime', width: 160 },
    { id: 'size', width: 100, align: 'end' },
    { id: 'type', width: 150, hidden: true },
  ],
  trash: [
    { id: 'name', width: 250 },
    { id: 'origin', width: 240 },
    { id: 'deleted', width: 160 },
    { id: 'size', width: 100, align: 'end' },
    { id: 'type', width: 150 },
    { id: 'mtime', width: 160, hidden: true },
  ],
};

let idSeq = 0;

export class ContentView {
  constructor(ex) {
    this.ex = ex;
    const { h } = ex;
    this.uid = `fxv${++idSeq}`;
    this.inner = h('div', { class: 'fx-inner' });
    this.scroller = h('div', {
      class: 'fx-scroll',
      tabindex: '0',
      role: 'listbox',
      'aria-multiselectable': 'true',
      'aria-label': ex.t('view.label'),
    }, this.inner);
    this.toastHost = h('div', { class: 'fx-toasts', 'aria-live': 'polite' });
    this.el = h('div', { class: 'fx-content' }, this.scroller, this.toastHost);
    this.items = [];
    this.byKey = new Map();
    this.sel = new Set();
    this.focusKey = null;
    this.anchorKey = null;
    this.collapsed = new Set();
    this.renaming = null;
    this.kbd = false;
    this.loc = null;
    this.data = null;
    this.vs = { mode: 'details', sort: 'name', dir: 1, group: 'none' };
    this.bind();
    this.thumbObserver = new IntersectionObserver((list) => this.onThumbsVisible(list), { root: this.scroller, rootMargin: '200px' });
  }

  get mode() {
    if (this.loc?.type === 'home' || this.loc?.type === 'thispc') return this.loc.type;
    return this.vs.mode;
  }

  focus() {
    this.scroller.focus({ preventScroll: true });
  }

  // ---------------------------------------------------------------- data / render
  setData(loc, data, vs, restore = null) {
    const sameLoc = this.loc && this.ex.locKey(this.loc) === this.ex.locKey(loc);
    const prevScroll = sameLoc ? this.scroller.scrollTop : 0;
    if (!sameLoc) this.collapsed.clear();
    this.loc = loc;
    this.data = data;
    this.vs = { ...vs };
    if (this.renaming) this.endRename();
    this.render();
    if (!sameLoc && document.documentElement.dataset.animations !== 'off') {
      this.inner.classList.remove('enter');
      void this.inner.offsetWidth;
      this.inner.classList.add('enter');
    }
    if (restore) {
      this.sel = new Set((restore.sel || []).filter((k) => this.byKey.has(k)));
      this.focusKey = this.byKey.has(restore.focus) ? restore.focus : [...this.sel][0] || null;
      this.anchorKey = this.focusKey;
      this.scroller.scrollTop = restore.scroll ?? (sameLoc ? prevScroll : 0);
    } else {
      this.sel = new Set();
      this.focusKey = null;
      this.anchorKey = null;
      this.scroller.scrollTop = sameLoc ? prevScroll : 0;
    }
    this.paintSel();
    if (restore?.reveal && this.focusKey) this.reveal(this.byKey.get(this.focusKey));
  }

  state() {
    return { sel: [...this.sel], focus: this.focusKey, scroll: this.scroller.scrollTop };
  }

  setViewSettings(vs) {
    const st = this.state();
    this.vs = { ...vs };
    this.render();
    this.sel = new Set(st.sel.filter((k) => this.byKey.has(k)));
    this.focusKey = st.focus;
    this.paintSel();
    const f = this.byKey.get(this.focusKey) || this.items.find((i) => this.sel.has(i.key));
    if (f) this.reveal(f);
  }

  render() {
    const { h } = this.ex;
    this.thumbObserver.disconnect();
    this.items = [];
    this.byKey = new Map();
    this.inner.replaceChildren();
    const mode = this.mode;
    this.inner.className = `fx-inner m-${mode}${shared.prefs.checkboxes ? ' with-checks' : ''}`;
    this.inner.addEventListener('animationend', () => this.inner.classList.remove('enter'), { once: true });
    this.scroller.classList.toggle('details', mode === 'details');
    if (!this.loc || !this.data) return;
    if (mode === 'home') return this.renderHome();
    if (mode === 'thispc') return this.renderThisPC();
    const entries = this.data.entries || [];
    let items = entries.map((e) => ({ key: e.path, entry: e, kind: this.loc.type === 'trash' ? 'trash' : 'file', type: T.typeName(e) }));
    this.sortItems(items);
    if (mode === 'details') this.renderDetailsHeader();
    if (!items.length) {
      this.inner.append(h('div', { class: 'fx-empty' }, this.loc.type === 'search' ? (this.data.searching ? this.ex.t('search.searching') : this.ex.t('search.noResults')) : this.ex.t('view.empty')));
      return;
    }
    const groups = this.vs.group !== 'none' && mode !== 'list' ? this.groupItems(items) : null;
    if (groups) {
      for (const g of groups) {
        const collapsed = this.collapsed.has(g.id);
        const body = h('div', { class: ['fx-items', `l-${mode}`] });
        const head = h('button', {
          class: 'fx-group-head',
          'aria-expanded': String(!collapsed),
          onclick: () => {
            if (this.collapsed.has(g.id)) this.collapsed.delete(g.id);
            else this.collapsed.add(g.id);
            sec.classList.toggle('collapsed', this.collapsed.has(g.id));
            head.setAttribute('aria-expanded', String(!this.collapsed.has(g.id)));
          },
        }, this.ex.icon('chevron_down', { size: 12 }), h('span', { class: 'lbl' }, g.label), h('span', { class: 'cnt' }, `(${g.items.length})`), h('span', { class: 'line' }));
        const sec = h('div', { class: ['fx-group', collapsed && 'collapsed'] }, head, body);
        for (const it of g.items) body.append(this.itemEl(it, mode));
        this.inner.append(sec);
      }
    } else {
      const body = h('div', { class: ['fx-items', `l-${mode}`] });
      const frag = document.createDocumentFragment();
      for (const it of items) frag.append(this.itemEl(it, mode));
      body.append(frag);
      this.inner.append(body);
    }
    this.paintCut();
  }

  register(it) {
    it.index = this.items.length;
    it.id = `${this.uid}-${it.index}`;
    this.items.push(it);
    this.byKey.set(it.key, it);
  }

  sortItems(items) {
    const { sort, dir } = this.vs;
    const ff = shared.prefs.foldersFirst;
    const byName = (a, b) => T.compareNames(a.entry.name, b.entry.name);
    const cmp = {
      name: byName,
      mtime: (a, b) => (a.entry.mtime || 0) - (b.entry.mtime || 0),
      type: (a, b) => T.compareNames(a.type, b.type),
      size: (a, b) => (a.entry.size || 0) - (b.entry.size || 0),
      location: (a, b) => T.compareNames(T.dirname(a.entry.path), T.dirname(b.entry.path)),
      origin: (a, b) => T.compareNames(a.entry.originalPath || '', b.entry.originalPath || ''),
      deleted: (a, b) => (a.entry.deletedAt || 0) - (b.entry.deletedAt || 0),
    }[sort] || byName;
    items.sort((a, b) => {
      if (ff && a.entry.dir !== b.entry.dir) return a.entry.dir ? -1 : 1;
      return cmp(a, b) * dir || byName(a, b);
    });
  }

  groupItems(items) {
    const t = this.ex.t;
    const g = this.vs.group;
    const map = new Map();
    for (const it of items) {
      let id;
      let label;
      if (g === 'type') {
        id = it.type;
        label = it.type;
      } else if (g === 'mtime') {
        id = T.dateBucket(this.loc.type === 'trash' && this.vs.sort === 'deleted' ? it.entry.deletedAt : it.entry.mtime);
        label = t(`groups.${id}`);
      } else if (g === 'size') {
        id = T.sizeBucket(it.entry);
        label = t(`groups.size_${id}`);
      } else {
        id = T.nameBucket(it.entry.name);
        label = id === 'other' ? t('groups.other') : id;
      }
      if (!map.has(id)) map.set(id, { id, label, items: [] });
      map.get(id).items.push(it);
    }
    let order;
    if (g === 'mtime') order = T.DATE_BUCKETS;
    else if (g === 'size') order = T.SIZE_BUCKETS;
    else if (g === 'name') order = ['0 – 9', 'A – H', 'I – P', 'Q – Z', 'other'];
    const list = [...map.values()];
    if (order) list.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    else list.sort((a, b) => T.compareNames(a.label, b.label));
    if (this.vs.dir < 0 && g !== 'mtime') list.reverse();
    // Items inside a group must follow display order for keyboard / range selection.
    return list;
  }

  // ---------------------------------------------------------------- details columns
  colSetName() {
    return this.loc.type === 'search' ? 'search' : this.loc.type === 'trash' ? 'trash' : 'dir';
  }

  columns() {
    const set = this.colSetName();
    if (!this._cols || this._colsSet !== set) {
      this._cols = getColumns(set, COLSETS[set]);
      this._colsSet = set;
    }
    return this._cols;
  }

  applyColumnWidths() {
    const cols = this.columns().filter((c) => !c.hidden);
    let total = 0;
    for (const c of cols) {
      this.inner.style.setProperty(`--w-${c.id}`, `${c.width}px`);
      total += c.width;
    }
    this.inner.style.setProperty('--w-total', `${total + (shared.prefs.checkboxes ? 28 : 0) + 8}px`);
  }

  renderDetailsHeader() {
    const { h, t, icon } = this.ex;
    this.applyColumnWidths();
    const cols = this.columns().filter((c) => !c.hidden);
    const head = h('div', { class: 'fx-dh', role: 'row' });
    if (shared.prefs.checkboxes) {
      const all = h('span', { class: 'fx-check fx-check-all', role: 'checkbox', 'aria-label': t('more.selectAll'), onclick: (e) => {
        e.stopPropagation();
        if (this.sel.size === this.items.length) this.selectNone();
        else this.selectAll();
      } });
      head.append(all);
    }
    for (const c of cols) {
      const sorted = this.vs.sort === c.id;
      const cell = h('div', {
        class: ['fx-dh-cell', `c-${c.id}`, sorted && 'sorted', c.align === 'end' && 'end'],
        role: 'columnheader',
        'aria-sort': sorted ? (this.vs.dir > 0 ? 'ascending' : 'descending') : 'none',
        style: { width: `var(--w-${c.id})` },
        tabindex: '-1',
        onclick: (e) => {
          if (e.target.closest('.fx-col-resize')) return;
          this.ex.setSort(c.id, sorted ? -this.vs.dir : 1);
        },
      },
      h('span', { class: 'ellipsis' }, t(`cols.${c.id}`)),
      sorted ? h('span', { class: 'fx-sort-ind' }, icon(this.vs.dir > 0 ? 'chevron_up' : 'chevron_down', { size: 10 })) : null);
      const grip = h('div', { class: 'fx-col-resize', ondblclick: (e) => {
        e.stopPropagation();
        this.autoSizeColumn(c);
      } });
      grip.addEventListener('pointerdown', (e) => this.startColResize(e, c));
      cell.append(grip);
      head.append(cell);
    }
    head.addEventListener('contextmenu', (e) => this.columnsMenu(e));
    this.inner.append(head);
  }

  startColResize(e, col) {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = col.width;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    this.inner.classList.add('resizing');
    const move = (ev) => {
      col.width = Math.max(col.id === 'name' ? 120 : 60, Math.min(900, Math.round(startW + ev.clientX - startX)));
      this.applyColumnWidths();
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      this.inner.classList.remove('resizing');
      saveColumns(this.colSetName(), this.columns());
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  autoSizeColumn(col) {
    const cells = this.inner.querySelectorAll(`.fx-cell.c-${col.id}`);
    let max = 80;
    const probe = this.ex.h('span', { class: 'fx-measure' });
    this.inner.append(probe);
    for (const c of cells) {
      probe.textContent = c.textContent;
      max = Math.max(max, probe.offsetWidth + (col.id === 'name' ? 44 : 24));
    }
    probe.remove();
    col.width = Math.min(900, max);
    this.applyColumnWidths();
    saveColumns(this.colSetName(), this.columns());
  }

  columnsMenu(e) {
    const t = this.ex.t;
    const cols = this.columns();
    this.ex.ui.menu(e, [
      ...cols.map((c) => ({
        label: t(`cols.${c.id}`),
        checked: !c.hidden,
        disabled: c.id === 'name',
        action: () => {
          c.hidden = !c.hidden;
          saveColumns(this.colSetName(), cols);
          this.setViewSettings(this.vs);
        },
      })),
      '-',
      { label: t('cols.sizeAll'), icon: 'arrow_autofit_width', action: () => cols.filter((c) => !c.hidden).forEach((c) => this.autoSizeColumn(c)) },
    ]);
  }

  cellContent(it, id) {
    const e = it.entry;
    switch (id) {
      case 'mtime':
        return T.formatDate(e.mtime);
      case 'type':
        return it.type;
      case 'size':
        return e.dir ? '' : T.formatKB(e.size);
      case 'location':
        return T.dirname(e.path);
      case 'origin':
        return T.dirname(e.originalPath || '');
      case 'deleted':
        return T.formatDate(e.deletedAt);
      default:
        return '';
    }
  }

  // ---------------------------------------------------------------- item elements
  nameNode(it) {
    const { h } = this.ex;
    const text = T.displayName(it.entry);
    const content = this.loc?.type === 'search' ? T.highlight(h, text, this.loc.query) : [text];
    return h('span', { class: 'fx-name' }, ...content);
  }

  iconNode(entry, size, { thumbs = true } = {}) {
    const { h, api } = this.ex;
    const box = h('span', { class: 'fx-ic' });
    let img;
    if (thumbs && size >= 32 && T.isImage(entry) && !entry.deletedAt) {
      img = h('img', { class: 'fx-photo', src: api.mediaUrl(entry.path), loading: 'lazy', decoding: 'async', alt: '', draggable: false });
      img.addEventListener('error', () => {
        img.className = '';
        img.src = T.iconFor(entry);
      }, { once: true });
    } else {
      img = h('img', { src: T.iconFor(entry), alt: '', draggable: false, decoding: 'async' });
      if (thumbs && size >= 48 && T.isVideo(entry) && !entry.deletedAt) {
        box.dataset.video = entry.path;
        this.thumbObserver.observe(box);
      }
    }
    box.append(img);
    if (entry.link) box.append(h('img', { class: 'fx-link', src: T.iconPath('link'), alt: '' }));
    return box;
  }

  onThumbsVisible(list) {
    for (const en of list) {
      if (!en.isIntersecting) continue;
      const box = en.target;
      this.thumbObserver.unobserve(box);
      const p = box.dataset.video;
      if (!p) continue;
      this.ex.api.invoke('files:thumb', p, 256).then((thumb) => {
        if (!thumb || !box.isConnected) return;
        const img = this.ex.h('img', { class: 'fx-photo fx-video', src: this.ex.api.mediaUrl(thumb), alt: '', draggable: false });
        img.addEventListener('load', () => {
          box.firstChild?.replaceWith(img);
          box.classList.add('has-video');
        }, { once: true });
      }).catch(() => {});
    }
  }

  itemEl(it, mode) {
    const { h } = this.ex;
    this.register(it);
    const e = it.entry;
    const attrs = {
      class: ['fx-item', mode === 'details' ? 'fx-row' : mode === 'tiles' ? 'fx-tilecard' : mode === 'list' || mode === 'small' ? 'fx-line' : 'fx-tile', e.hidden && 'is-hidden'],
      id: it.id,
      role: 'option',
      'aria-selected': 'false',
      draggable: it.kind === 'file' ? 'true' : 'false',
      dataset: { key: it.key },
      title: mode === 'details' ? null : this.tooltip(it),
    };
    const check = shared.prefs.checkboxes ? h('span', { class: 'fx-check', 'aria-hidden': 'true' }) : null;
    let el;
    if (mode === 'details') {
      const cols = this.columns().filter((c) => !c.hidden);
      el = h('div', attrs, check, ...cols.map((c) =>
        c.id === 'name'
          ? h('div', { class: 'fx-cell c-name', style: { width: 'var(--w-name)' } }, this.iconNode(e, 16), this.nameNode(it))
          : h('div', { class: ['fx-cell', `c-${c.id}`, c.align === 'end' && 'end'], style: { width: `var(--w-${c.id})` } }, this.cellContent(it, c.id))));
    } else if (mode === 'tiles') {
      el = h('div', attrs, check, this.iconNode(e, 48), h('div', { class: 'fx-meta' }, this.nameNode(it),
        h('span', { class: 'fx-sub' }, it.kind === 'trash' ? T.dirname(e.originalPath || '') : it.type),
        e.dir ? null : h('span', { class: 'fx-sub' }, T.humanSize(e.size))));
    } else {
      el = h('div', attrs, check, this.iconNode(e, ICON_SIZE[mode]), this.nameNode(it));
    }
    it.el = el;
    return el;
  }

  tooltip(it) {
    const e = it.entry;
    const t = this.ex.t;
    const lines = [`${t('props.type')}: ${it.type}`];
    if (!e.dir) lines.push(`${t('props.size')}: ${T.humanSize(e.size)}`);
    if (e.mtime) lines.push(`${t('cols.mtime')}: ${T.formatDate(e.mtime)}`);
    if (this.loc?.type === 'search') lines.push(`${t('cols.location')}: ${T.dirname(e.path)}`);
    return lines.join('\n');
  }

  // ---------------------------------------------------------------- Home
  section(id, title, count, content, opts = {}) {
    const { h, icon } = this.ex;
    const collapsed = this.collapsed.has(id);
    const sec = h('section', { class: ['fx-sec', collapsed && 'collapsed'], dataset: { sec: id } });
    const head = h('button', {
      class: 'fx-sec-head',
      'aria-expanded': String(!collapsed),
      onclick: () => {
        if (this.collapsed.has(id)) this.collapsed.delete(id);
        else this.collapsed.add(id);
        sec.classList.toggle('collapsed', this.collapsed.has(id));
        head.setAttribute('aria-expanded', String(!this.collapsed.has(id)));
      },
    }, icon('chevron_down', { size: 12 }), h('span', null, title), count != null ? h('span', { class: 'cnt' }, `(${count})`) : null);
    sec.append(head, h('div', { class: ['fx-sec-body', opts.cls] }, content));
    return sec;
  }

  renderHome() {
    const { h, t } = this.ex;
    const d = this.data;
    const wrap = h('div', { class: 'fx-home' });
    // Quick access tiles
    const grid = h('div', { class: 'fx-quick' });
    for (const e of d.quick) {
      const it = { key: `q:${e.path}`, entry: e, kind: 'file', type: T.typeName(e), section: 'quick' };
      this.register(it);
      const where = e.missing ? t('home.missing') : T.knownFolder(e.path) && T.knownFolder(e.path) !== 'home' ? t('home.storedLocally') : T.dirname(e.path);
      it.el = h('div', { class: ['fx-item', 'fx-qtile', e.missing && 'missing'], id: it.id, role: 'option', draggable: 'true', dataset: { key: it.key }, title: e.path },
        this.iconNode(e, 40, { thumbs: false }),
        h('div', { class: 'fx-meta' }, h('span', { class: 'fx-name' }, e.name), h('span', { class: 'fx-sub' }, where)),
        h('span', { class: 'fx-pin', 'aria-label': t('menu.pinned') }, this.ex.icon('pin', { size: 12 })));
      grid.append(it.el);
    }
    if (!d.quick.length) grid.append(h('div', { class: 'fx-empty-inline' }, t('home.noPins')));
    wrap.append(this.section('quick', t('home.quickAccess'), null, grid));
    if (shared.prefs.showFavorites) wrap.append(this.section('fav', t('home.favorites'), null, this.homeTable(d.favorites, 'f', t('home.noFavorites'))));
    if (shared.prefs.showRecent) wrap.append(this.section('recent', t('home.recent'), null, this.homeTable(d.recent, 'r', t('home.noRecent'))));
    this.inner.append(wrap);
    this.paintCut();
  }

  homeTable(entries, prefix, emptyText) {
    const { h, t } = this.ex;
    if (!entries.length) return h('div', { class: 'fx-empty-inline' }, emptyText);
    const table = h('div', { class: 'fx-htable' },
      h('div', { class: 'fx-hrow fx-hhead' }, h('span', null, t('cols.name')), h('span', null, t('cols.mtime')), h('span', null, t('cols.location'))));
    for (const e of entries) {
      const it = { key: `${prefix}:${e.path}`, entry: e, kind: 'file', type: T.typeName(e), section: prefix };
      this.register(it);
      it.el = h('div', { class: ['fx-item', 'fx-hrow'], id: it.id, role: 'option', draggable: 'true', dataset: { key: it.key }, title: e.path },
        h('span', { class: 'fx-cell c-name' }, this.iconNode(e, 16), h('span', { class: 'fx-name' }, T.displayName(e))),
        h('span', { class: 'fx-cell' }, T.formatDate(e.mtime)),
        h('span', { class: 'fx-cell' }, this.prettyDir(T.dirname(e.path))));
      table.append(it.el);
    }
    return table;
  }

  prettyDir(p) {
    const x = shared.xdg;
    for (const k of ['desktop', 'documents', 'downloads', 'pictures', 'music', 'videos']) {
      if (p === x[k]) return this.ex.t(`places.${k}`);
      if (T.isInside(p, x[k])) return `${this.ex.t(`places.${k}`)}${p.slice(x[k].length)}`;
    }
    if (p === shared.home) return T.basename(shared.home);
    if (T.isInside(p, shared.home)) return `~${p.slice(shared.home.length)}`;
    return p;
  }

  // ---------------------------------------------------------------- This PC
  renderThisPC() {
    const { h, t } = this.ex;
    const d = this.data;
    const wrap = h('div', { class: 'fx-thispc' });
    const fgrid = h('div', { class: 'fx-pcgrid' });
    for (const e of d.folders) {
      const it = { key: e.path, entry: e, kind: 'file', type: T.typeName(e) };
      this.register(it);
      it.el = h('div', { class: 'fx-item fx-pctile', id: it.id, role: 'option', draggable: 'true', dataset: { key: it.key }, title: e.path },
        this.iconNode(e, 48, { thumbs: false }),
        h('div', { class: 'fx-meta' }, h('span', { class: 'fx-name' }, e.label || e.name), h('span', { class: 'fx-sub' }, t('home.storedLocally'))));
      fgrid.append(it.el);
    }
    wrap.append(this.section('folders', t('thispc.folders'), d.folders.length, fgrid));
    const dgrid = h('div', { class: 'fx-pcgrid drives' });
    for (const drv of d.drives) {
      const entry = { name: T.driveName(drv, t), path: drv.mountpoint || '', dir: true, drive: drv };
      const it = { key: `drive:${drv.id}`, entry, kind: 'drive', type: t('drives.kindLocal') };
      this.register(it);
      const size = drv.size || 0;
      const free = drv.free ?? null;
      const used = free != null ? size - free : null;
      const frac = size && used != null ? used / size : 0;
      it.el = h('div', { class: ['fx-item', 'fx-drive', !drv.mounted && 'unmounted'], id: it.id, role: 'option', draggable: 'false', dataset: { key: it.key }, title: drv.device || drv.mountpoint || '' },
        h('span', { class: 'fx-ic' }, h('img', { src: T.driveIcon(drv), alt: '', draggable: false })),
        h('div', { class: 'fx-meta' },
          h('span', { class: 'fx-name' }, entry.name),
          drv.mounted && size ? h('div', { class: ['fx-cap', frac > 0.9 && 'full'] }, h('div', { class: 'fill', style: { width: `${Math.max(1, Math.round(frac * 100))}%` } })) : null,
          h('span', { class: 'fx-sub' }, drv.mounted ? (free != null && size ? t('drives.freeOf', { free: T.humanSize(free), size: T.humanSize(size) }) : T.humanSize(size)) : t('drives.notMountedSize', { size: T.humanSize(size) }))));
      dgrid.append(it.el);
    }
    wrap.append(this.section('drives', t('thispc.drives'), d.drives.length, dgrid));
    this.inner.append(wrap);
    this.paintCut();
  }

  // ---------------------------------------------------------------- selection
  selectedItems() {
    return this.items.filter((it) => this.sel.has(it.key));
  }

  selectedEntries() {
    const seen = new Set();
    const out = [];
    for (const it of this.selectedItems()) {
      if (it.kind === 'drive' || !it.entry?.path || seen.has(it.entry.path)) continue;
      seen.add(it.entry.path);
      out.push(it.entry);
    }
    return out;
  }

  setSel(keys, focus) {
    this.sel = new Set(keys);
    if (focus !== undefined) {
      this.focusKey = focus;
      this.anchorKey = focus;
    }
    this.paintSel();
  }

  select(keys, { focus = true, reveal = true } = {}) {
    const valid = keys.filter((k) => this.byKey.has(k));
    this.sel = new Set(valid);
    if (focus && valid.length) {
      this.focusKey = valid[0];
      this.anchorKey = valid[0];
    }
    this.paintSel();
    if (reveal && valid.length) this.reveal(this.byKey.get(valid[0]));
  }

  selectAll() {
    this.sel = new Set(this.items.map((i) => i.key));
    this.paintSel();
  }

  selectNone() {
    this.sel = new Set();
    this.paintSel();
  }

  invert() {
    this.sel = new Set(this.items.filter((i) => !this.sel.has(i.key)).map((i) => i.key));
    this.paintSel();
  }

  range(fromKey, toKey) {
    const a = this.byKey.get(fromKey)?.index ?? 0;
    const b = this.byKey.get(toKey)?.index ?? 0;
    const [lo, hi] = a < b ? [a, b] : [b, a];
    return this.items.slice(lo, hi + 1).map((i) => i.key);
  }

  paintSel() {
    for (const it of this.items) {
      const on = this.sel.has(it.key);
      if (it.el.classList.contains('selected') !== on) {
        it.el.classList.toggle('selected', on);
        it.el.setAttribute('aria-selected', String(on));
      }
      it.el.classList.toggle('focused', this.kbd && it.key === this.focusKey);
    }
    const f = this.byKey.get(this.focusKey);
    if (f) this.scroller.setAttribute('aria-activedescendant', f.id);
    else this.scroller.removeAttribute('aria-activedescendant');
    const all = this.inner.querySelector('.fx-check-all');
    if (all) {
      all.classList.toggle('on', this.items.length > 0 && this.sel.size === this.items.length);
      all.classList.toggle('some', this.sel.size > 0 && this.sel.size < this.items.length);
    }
    this.ex.onSelection();
  }

  paintCut() {
    const clip = this.ex.ctx.shell.clipboard.getFiles();
    const cut = clip?.mode === 'cut' ? new Set(clip.paths) : null;
    for (const it of this.items) it.el.classList.toggle('cut', !!cut && cut.has(it.entry?.path));
  }

  reveal(it) {
    if (!it?.el) return;
    const group = it.el.closest('.fx-group.collapsed, .fx-sec.collapsed');
    if (group) group.classList.remove('collapsed');
    it.el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  // ---------------------------------------------------------------- events
  bind() {
    const sc = this.scroller;
    sc.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    sc.addEventListener('pointerup', (e) => this.onPointerUp(e));
    sc.addEventListener('click', (e) => this.onClick(e));
    sc.addEventListener('dblclick', (e) => this.onDblClick(e));
    sc.addEventListener('contextmenu', (e) => this.onContextMenu(e));
    sc.addEventListener('keydown', (e) => this.onKey(e));
    sc.addEventListener('focus', () => {
      if (!this.focusKey && this.items.length && this.kbd) {
        this.focusKey = this.items[0].key;
        this.paintSel();
      }
    });
    sc.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      this.ex.zoomView(e.deltaY < 0 ? 1 : -1);
    }, { passive: false });
    sc.addEventListener('dragstart', (e) => {
      const el = e.target.closest?.('.fx-item');
      const it = el && this.byKey.get(el.dataset.key);
      if (!it || it.kind !== 'file' || this.renaming) {
        e.preventDefault();
        return;
      }
      this.pendingSingle = null;
      if (!this.sel.has(it.key)) this.setSel([it.key], it.key);
      const entries = this.selectedEntries().filter((x) => !x.missing);
      if (!entries.length) {
        e.preventDefault();
        return;
      }
      this.ex.dnd.start(e, entries);
      this.dragging = true;
    });
    sc.addEventListener('dragend', () => {
      this.dragging = false;
      this.ex.dnd.end();
    });
    this.ex.dnd.dropTarget(sc, (e) => this.dropDest(e), { mark: (e) => this.dropMark(e) });
  }

  dropDest(e) {
    const el = e.target.closest?.('.fx-item');
    const it = el && this.byKey.get(el.dataset.key);
    if (it && it.entry?.dir && !it.entry.missing && it.entry.path && (it.kind === 'file' || (it.kind === 'drive' && it.entry.drive.mounted))) {
      return it.entry.path;
    }
    if (this.loc?.type === 'dir') return this.loc.path;
    if (this.loc?.type === 'trash') return TRASH_TARGET;
    return null;
  }

  dropMark(e) {
    const el = e.target.closest?.('.fx-item');
    const it = el && this.byKey.get(el.dataset.key);
    if (it && it.entry?.dir && it.entry.path) return el;
    return null;
  }

  onPointerDown(e) {
    clearTimeout(this.renameTimer);
    if (this.renaming && !e.target.closest('.fx-rename')) this.commitRename();
    if (e.target.closest('.fx-rename, .fx-dh, .fx-sec-head, .fx-group-head, .fx-hhead')) return;
    const el = e.target.closest('.fx-item');
    if (e.pointerType === 'mouse' && this.kbd) {
      this.kbd = false;
      this.paintSel();
    }
    if (e.button === 0 || e.button === 2) this.focus();
    if (!el) {
      if (e.button === 0) {
        if (!e.ctrlKey && !e.shiftKey && this.sel.size) this.setSel([]);
        this.startBand(e);
      } else if (e.button === 2 && this.sel.size) this.setSel([]);
      return;
    }
    const key = el.dataset.key;
    if (e.button === 2) {
      if (!this.sel.has(key)) this.setSel([key], key);
      else {
        this.focusKey = key;
        this.paintSel();
      }
      return;
    }
    if (e.button !== 0) return;
    this.armedRename = false;
    if (e.target.closest('.fx-check')) {
      const s = new Set(this.sel);
      if (s.has(key)) s.delete(key);
      else s.add(key);
      this.sel = s;
      this.focusKey = key;
      this.anchorKey = key;
      this.paintSel();
      return;
    }
    if (e.ctrlKey && e.shiftKey) {
      this.sel = new Set([...this.sel, ...this.range(this.anchorKey || key, key)]);
      this.focusKey = key;
      this.paintSel();
    } else if (e.ctrlKey) {
      this.pendingToggle = key;
    } else if (e.shiftKey) {
      this.sel = new Set(this.range(this.anchorKey || key, key));
      this.focusKey = key;
      this.paintSel();
    } else if (this.sel.has(key)) {
      this.pendingSingle = key;
      this.armedRename = this.sel.size === 1 && e.detail === 1 && !!e.target.closest('.fx-name') && !shared.prefs.singleClick;
      this.focusKey = key;
    } else {
      this.setSel([key], key);
    }
  }

  onPointerUp(e) {
    if (this.pendingToggle) {
      const key = this.pendingToggle;
      this.pendingToggle = null;
      if (!this.dragging) {
        const s = new Set(this.sel);
        if (s.has(key)) s.delete(key);
        else s.add(key);
        this.sel = s;
        this.focusKey = key;
        this.anchorKey = key;
        this.paintSel();
      }
    }
    if (this.pendingSingle) {
      const key = this.pendingSingle;
      this.pendingSingle = null;
      if (!this.dragging && (this.sel.size !== 1 || !this.sel.has(key))) this.setSel([key], key);
      else this.anchorKey = key;
    }
  }

  onClick(e) {
    const el = e.target.closest('.fx-item');
    if (!el || e.button !== 0) return;
    if (shared.prefs.singleClick && !e.ctrlKey && !e.shiftKey && !e.target.closest('.fx-check')) {
      this.openItems([this.byKey.get(el.dataset.key)]);
      return;
    }
    if (this.armedRename && e.detail === 1) {
      const key = el.dataset.key;
      this.renameTimer = setTimeout(() => {
        if (this.sel.size === 1 && this.sel.has(key) && !this.dragging) this.beginRename(key);
      }, 550);
    }
    this.armedRename = false;
  }

  onDblClick(e) {
    clearTimeout(this.renameTimer);
    const el = e.target.closest('.fx-item');
    if (!el || e.target.closest('.fx-check, .fx-rename')) return;
    const it = this.byKey.get(el.dataset.key);
    if (!it) return;
    if (e.ctrlKey && it.entry?.dir) {
      this.ex.ctx.shell.launch('files', { path: it.entry.path });
      return;
    }
    this.openItems([it]);
  }

  openItems(items) {
    items = items.filter(Boolean);
    if (!items.length) return;
    const drives = items.filter((i) => i.kind === 'drive');
    if (drives.length) return this.ex.openDrive(drives[0].entry.drive);
    if (items[0].kind === 'trash') return this.ex.properties({ trash: items[0].entry });
    this.ex.openEntries(items.map((i) => i.entry));
  }

  onContextMenu(e) {
    e.preventDefault();
    if (e.target.closest('.fx-dh')) return;
    if (e.target.closest('.fx-rename')) return;
    const el = e.target.closest('.fx-item');
    if (el) {
      const key = el.dataset.key;
      if (!this.sel.has(key)) this.setSel([key], key);
      this.ex.itemMenu(e, this.selectedItems());
    } else {
      this.ex.backgroundMenu(e);
    }
  }

  menuAtFocus() {
    const it = this.byKey.get(this.focusKey) || this.selectedItems()[0];
    if (it && this.sel.has(it.key)) {
      const r = it.el.getBoundingClientRect();
      this.ex.itemMenu({ x: r.left + 24, y: r.top + Math.min(r.height, 24) }, this.selectedItems());
    } else {
      const r = this.scroller.getBoundingClientRect();
      this.ex.backgroundMenu({ x: r.left + 40, y: r.top + 40 });
    }
  }

  // ---------------------------------------------------------------- rubber band
  startBand(e) {
    if (e.pointerType === 'touch') return;
    const sc = this.scroller;
    const r0 = sc.getBoundingClientRect();
    // Ignore clicks on the scrollbars.
    if (e.clientX > r0.left + sc.clientWidth || e.clientY > r0.top + sc.clientHeight) return;
    const sx = e.clientX - r0.left + sc.scrollLeft;
    const sy = e.clientY - r0.top + sc.scrollTop;
    const base = e.ctrlKey || e.shiftKey ? new Set(this.sel) : new Set();
    const toggle = e.ctrlKey;
    const boxes = this.items
      .map((it) => {
        const r = it.el.getBoundingClientRect();
        if (!r.width) return null;
        return { key: it.key, l: r.left - r0.left + sc.scrollLeft, t: r.top - r0.top + sc.scrollTop, r: r.right - r0.left + sc.scrollLeft, b: r.bottom - r0.top + sc.scrollTop };
      })
      .filter(Boolean);
    let band = null;
    let last = { x: e.clientX, y: e.clientY };
    let scrollTimer = null;
    const pointerId = e.pointerId;
    try {
      sc.setPointerCapture(pointerId);
    } catch {}
    const update = () => {
      const r = sc.getBoundingClientRect();
      const cx = Math.max(0, Math.min(sc.scrollWidth, last.x - r.left + sc.scrollLeft));
      const cy = Math.max(0, Math.min(sc.scrollHeight, last.y - r.top + sc.scrollTop));
      const x = Math.min(sx, cx);
      const y = Math.min(sy, cy);
      const w = Math.abs(cx - sx);
      const hh = Math.abs(cy - sy);
      if (!band) {
        if (w < 4 && hh < 4) return;
        band = this.ex.h('div', { class: 'fx-band' });
        this.inner.append(band);
        this.banding = true;
      }
      Object.assign(band.style, { transform: `translate(${x}px, ${y}px)`, width: `${w}px`, height: `${hh}px` });
      const s = new Set(base);
      for (const b of boxes) {
        if (b.r > x && b.l < x + w && b.b > y && b.t < y + hh) {
          if (toggle && base.has(b.key)) s.delete(b.key);
          else s.add(b.key);
        }
      }
      this.sel = s;
      this.paintSel();
    };
    const autoScroll = () => {
      const r = sc.getBoundingClientRect();
      let dy = 0;
      if (last.y < r.top + 20) dy = -Math.min(30, r.top + 20 - last.y);
      else if (last.y > r.bottom - 20) dy = Math.min(30, last.y - (r.bottom - 20));
      if (dy) {
        sc.scrollTop += dy;
        update();
      }
    };
    const move = (ev) => {
      last = { x: ev.clientX, y: ev.clientY };
      update();
      if (!scrollTimer) scrollTimer = setInterval(autoScroll, 30);
    };
    const up = () => {
      sc.removeEventListener('pointermove', move);
      sc.removeEventListener('pointerup', up);
      sc.removeEventListener('pointercancel', up);
      clearInterval(scrollTimer);
      band?.remove();
      this.banding = false;
      try {
        sc.releasePointerCapture(pointerId);
      } catch {}
    };
    sc.addEventListener('pointermove', move);
    sc.addEventListener('pointerup', up);
    sc.addEventListener('pointercancel', up);
  }

  // ---------------------------------------------------------------- keyboard
  onKey(e) {
    if (e.target !== this.scroller) return;
    const k = e.key;
    const nav = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'];
    if (nav.includes(k) && !e.altKey) {
      e.preventDefault();
      if (!this.items.length) return;
      this.kbd = true;
      const target = this.neighbor(k);
      if (!target) return;
      if (e.shiftKey) {
        const base = e.ctrlKey ? this.sel : new Set();
        this.sel = new Set([...base, ...this.range(this.anchorKey || target.key, target.key)]);
        this.focusKey = target.key;
      } else if (e.ctrlKey) {
        this.focusKey = target.key;
      } else {
        this.sel = new Set([target.key]);
        this.focusKey = target.key;
        this.anchorKey = target.key;
      }
      this.paintSel();
      this.reveal(target);
      return;
    }
    if (k === ' ' && !e.altKey) {
      e.preventDefault();
      if (this.typeBuf && Date.now() - this.typeAt < 900) return this.typeAhead(' ');
      const f = this.byKey.get(this.focusKey);
      if (!f) return;
      this.kbd = true;
      const s = new Set(this.sel);
      if (e.ctrlKey && s.has(f.key)) s.delete(f.key);
      else s.add(f.key);
      this.sel = s;
      this.anchorKey = f.key;
      this.paintSel();
      return;
    }
    if (k === 'Enter' && !e.altKey && !e.ctrlKey) {
      e.preventDefault();
      this.openItems(this.selectedItems());
      return;
    }
    if (k === 'Escape' && this.sel.size && !this.renaming) {
      // Windows keeps the selection; Esc only matters for menus/rename. Clear "cut" ghosting instead.
      return;
    }
    if (k.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      this.typeAhead(k);
    }
  }

  typeAhead(ch) {
    const now = Date.now();
    if (!this.typeBuf || now - this.typeAt > 900) this.typeBuf = '';
    this.typeAt = now;
    this.typeBuf += ch.toLowerCase();
    const buf = this.typeBuf;
    const repeat = buf.length > 1 && [...buf].every((c) => c === buf[0]);
    const needle = repeat ? buf[0] : buf;
    const cur = this.byKey.get(this.focusKey)?.index ?? -1;
    const n = this.items.length;
    const start = repeat || buf.length === 1 ? cur + 1 : Math.max(0, cur);
    for (let i = 0; i < n; i++) {
      const it = this.items[(start + i) % n];
      if (T.displayName(it.entry).toLowerCase().startsWith(needle)) {
        this.kbd = true;
        this.setSel([it.key], it.key);
        this.reveal(it);
        return;
      }
    }
  }

  neighbor(k) {
    const items = this.items.filter((i) => i.el.offsetParent !== null);
    if (!items.length) return null;
    const cur = this.byKey.get(this.focusKey);
    if (!cur || cur.el.offsetParent === null) return k === 'End' ? items[items.length - 1] : items[0];
    const idx = items.indexOf(cur);
    if (k === 'Home') return items[0];
    if (k === 'End') return items[items.length - 1];
    const mode = this.mode;
    const vertical = mode === 'details';
    if (vertical) {
      if (k === 'ArrowDown') return items[Math.min(items.length - 1, idx + 1)];
      if (k === 'ArrowUp') return items[Math.max(0, idx - 1)];
      if (k === 'PageDown' || k === 'PageUp') {
        const per = Math.max(1, Math.floor(this.scroller.clientHeight / Math.max(1, cur.el.offsetHeight)) - 1);
        return items[Math.max(0, Math.min(items.length - 1, idx + (k === 'PageDown' ? per : -per)))];
      }
      return null;
    }
    if (mode === 'list') {
      if (k === 'ArrowDown') return items[Math.min(items.length - 1, idx + 1)];
      if (k === 'ArrowUp') return items[Math.max(0, idx - 1)];
    }
    const rects = items.map((it) => it.el.getBoundingClientRect());
    const r = rects[idx];
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const pick = (cands, score) => {
      let best = null;
      let bestS = Infinity;
      for (const i of cands) {
        const s = score(rects[i]);
        if (s < bestS) {
          bestS = s;
          best = items[i];
        }
      }
      return best;
    };
    const all = items.map((_, i) => i).filter((i) => i !== idx);
    if (k === 'ArrowDown' || k === 'ArrowUp') {
      const down = k === 'ArrowDown';
      const cands = all.filter((i) => (down ? rects[i].top >= r.bottom - 2 : rects[i].bottom <= r.top + 2));
      if (!cands.length) return null;
      const edge = down ? Math.min(...cands.map((i) => rects[i].top)) : Math.max(...cands.map((i) => rects[i].bottom));
      const row = cands.filter((i) => (down ? rects[i].top - edge < r.height / 2 : edge - rects[i].bottom < r.height / 2));
      return pick(row, (q) => Math.abs(q.left + q.width / 2 - cx));
    }
    if (k === 'PageDown' || k === 'PageUp') {
      const down = k === 'PageDown';
      const step = Math.max(r.height, this.scroller.clientHeight - r.height);
      const ty = down ? cy + step : cy - step;
      const cands = all.filter((i) => (down ? rects[i].top >= r.bottom - 2 : rects[i].bottom <= r.top + 2));
      if (!cands.length) return null;
      return pick(cands, (q) => Math.abs(q.top + q.height / 2 - ty) * 3 + Math.abs(q.left + q.width / 2 - cx));
    }
    if (k === 'ArrowRight' || k === 'ArrowLeft') {
      const right = k === 'ArrowRight';
      const same = all.filter((i) => Math.abs(rects[i].top + rects[i].height / 2 - cy) < r.height / 2 && (right ? rects[i].left >= r.right - 2 : rects[i].right <= r.left + 2));
      if (same.length) return pick(same, (q) => Math.abs(q.left + q.width / 2 - cx));
      if (mode === 'list') {
        const cols = all.filter((i) => (right ? rects[i].left >= r.right - 2 : rects[i].right <= r.left + 2));
        if (!cols.length) return null;
        return pick(cols, (q) => Math.abs(q.left - r.left) * 4 + Math.abs(q.top - r.top));
      }
      return items[right ? Math.min(items.length - 1, idx + 1) : Math.max(0, idx - 1)];
    }
    return null;
  }

  // ---------------------------------------------------------------- inline rename
  beginRename(key, { isNew = false } = {}) {
    const it = this.byKey.get(key);
    if (!it || it.kind !== 'file' || !it.entry || it.entry.missing) return false;
    if (this.renaming) this.endRename();
    const { h } = this.ex;
    this.setSel([key], key);
    this.reveal(it);
    const nameEl = it.el.querySelector('.fx-name');
    if (!nameEl) return false;
    const e = it.entry;
    const showExt = shared.prefs.extensions || e.dir;
    const [stem, ext] = T.splitExt(e.name, e.dir);
    const initial = showExt ? e.name : ext && stem ? stem : e.name;
    const multiline = ['xl', 'large', 'medium'].includes(this.mode);
    const input = h(multiline ? 'textarea' : 'input', {
      class: ['fx-rename', multiline && 'multi'],
      spellcheck: false,
      'aria-label': this.ex.t('rename.title'),
      rows: multiline ? 1 : null,
    });
    input.value = initial;
    const tip = h('div', { class: 'fx-rename-tip', role: 'alert', hidden: true });
    nameEl.hidden = true;
    nameEl.after(input);
    it.el.append(tip);
    it.el.classList.add('renaming');
    it.el.draggable = false;
    this.renaming = { key, it, input, nameEl, tip, entry: e, isNew, ext, showExt };
    const fit = () => {
      if (multiline) {
        input.style.height = 'auto';
        input.style.height = `${input.scrollHeight}px`;
      }
    };
    input.addEventListener('input', () => {
      const bad = /[/\0]/.test(input.value);
      if (bad) {
        const pos = input.selectionStart - 1;
        input.value = input.value.replace(/[/\0]/g, '');
        input.setSelectionRange(Math.max(0, pos), Math.max(0, pos));
        this.renameTip(this.ex.t('rename.invalidChars'));
      }
      fit();
    });
    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') {
        ev.preventDefault();
        this.commitRename();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        this.endRename();
        this.focus();
      } else if (ev.key === 'Tab') {
        ev.preventDefault();
        const next = this.items[(it.index + (ev.shiftKey ? -1 : 1) + this.items.length) % this.items.length];
        const nextKey = next && next !== it ? next.key : null;
        this.commitRename().then((ok) => ok && nextKey && setTimeout(() => this.beginRename(nextKey), 60));
      }
    });
    input.addEventListener('blur', () => setTimeout(() => this.renaming?.input === input && !this.renaming.busy && this.commitRename(), 0));
    input.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    input.addEventListener('dblclick', (ev) => ev.stopPropagation());
    requestAnimationFrame(() => {
      input.focus();
      const end = showExt && ext && !e.dir ? initial.length - ext.length : initial.length;
      input.setSelectionRange(0, Math.max(0, end));
      fit();
    });
    return true;
  }

  renameTip(msg) {
    const r = this.renaming;
    if (!r) return;
    r.tip.textContent = msg;
    r.tip.hidden = false;
    clearTimeout(this.tipTimer);
    this.tipTimer = setTimeout(() => r.tip && (r.tip.hidden = true), 4000);
  }

  async commitRename() {
    const r = this.renaming;
    if (!r || r.busy) return false;
    const ex = this.ex;
    const t = ex.t;
    let v = r.input.value.replace(/^\s+|\s+$/g, '');
    if (!r.showExt && r.ext && v && !v.toLowerCase().endsWith(r.ext.toLowerCase())) v += r.ext;
    if (!v || v === r.entry.name) {
      this.endRename();
      return true;
    }
    const err = ops.validateName(ex, v);
    if (err) {
      this.renameTip(err);
      r.input.focus();
      return false;
    }
    r.busy = true;
    if (r.showExt && !r.entry.dir) {
      const oldExt = T.splitExt(r.entry.name, false)[1].toLowerCase();
      const newExt = T.splitExt(v, false)[1].toLowerCase();
      if (oldExt !== newExt) {
        const ok = await ex.ui.confirm(t('rename.extWarning'), { title: t('rename.title'), okLabel: t('common.yes'), cancelLabel: t('common.no'), parent: ex.win });
        if (!ok) {
          r.busy = false;
          r.input.focus();
          return false;
        }
      }
    }
    try {
      const res = await ops.rename(ex, r.entry, v);
      this.endRename();
      await ex.refresh({ select: [res.path] });
      this.focus();
      return true;
    } catch (e2) {
      r.busy = false;
      if (e2.code === 'EEXIST') {
        await ex.ui.alert(t(r.entry.dir ? 'rename.existsFolder' : 'rename.exists', { name: v }), { title: t('rename.title'), parent: ex.win });
        if (this.renaming === r) {
          r.input.focus();
          r.input.select();
        }
      } else {
        await ops.alertError(ex, e2, t('rename.title'));
        this.endRename();
      }
      return false;
    }
  }

  endRename() {
    const r = this.renaming;
    if (!r) return;
    this.renaming = null;
    r.input.remove();
    r.tip.remove();
    r.nameEl.hidden = false;
    r.it.el.classList.remove('renaming');
    r.it.el.draggable = r.it.kind === 'file';
    if (this.ex.pendingRefresh) {
      this.ex.pendingRefresh = false;
      this.ex.refresh();
    }
  }

  // ---------------------------------------------------------------- in-window toast (delete + undo)
  toast(text, action) {
    const { h, icon, t } = this.ex;
    this.toastHost.replaceChildren();
    const el = h('div', { class: 'fx-toast', role: 'status' },
      icon('checkmark_circle', { size: 16, filled: true }),
      h('span', { class: 'grow' }, text),
      action ? h('button', { class: 'btn small', onclick: () => {
        close();
        action.action();
      } }, action.label) : null,
      h('button', { class: 'btn subtle icon-btn small', 'aria-label': t('common.close'), onclick: () => close() }, icon('dismiss', { size: 12 })));
    const close = () => {
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 200);
    };
    this.toastHost.append(el);
    let timer = setTimeout(close, 6000);
    el.addEventListener('mouseenter', () => clearTimeout(timer));
    el.addEventListener('mouseleave', () => (timer = setTimeout(close, 2500)));
  }
}
