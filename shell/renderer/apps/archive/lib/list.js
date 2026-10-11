// Details view of the archive (Windows 11 File Explorer "Details" layout): sortable, resizable columns,
// multi-selection (click, Ctrl, Shift, Ctrl+A, arrows, Home/End, Page Up/Down, type-ahead), and
// virtual scrolling so folders with hundreds of thousands of items stay fast.
import { iconUrl, typeName, ratioOf } from './util.js';
import { shared } from './shared.js';

const ROW_H = { normal: 30, compact: 24 };
const HEAD_H = 32;

export class DetailsList {
  constructor(w) {
    this.w = w;
    const { h } = w;
    this.items = [];
    this.selected = new Set(); // node paths
    this.anchor = -1;
    this.focusIndex = -1;
    this.columns = [];
    this.range = [0, -1];
    this.rowEls = new Map();
    this.typeBuf = '';
    this.typeTimer = null;
    this.searchMode = false;
    this.head = h('div', { class: 'arc-dh', role: 'row' });
    this.rows = h('div', { class: 'arc-rows', role: 'presentation' });
    this.emptyEl = h('div', { class: 'arc-empty', hidden: true });
    this.inner = h('div', { class: 'arc-inner' }, this.head, this.rows, this.emptyEl);
    this.el = h('div', {
      class: 'arc-scroll',
      tabindex: '0',
      role: 'listbox',
      'aria-multiselectable': 'true',
      'aria-label': w.t('list.label'),
    }, this.inner);
    this.el.addEventListener('scroll', () => this.schedule());
    this.el.addEventListener('keydown', (e) => this.onKey(e));
    this.el.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.el.addEventListener('dblclick', (e) => {
      const i = this.indexAt(e);
      if (i >= 0) this.w.openNode(this.items[i]);
    });
    this.el.addEventListener('contextmenu', (e) => this.onContext(e));
    this.el.addEventListener('dragstart', (e) => {
      this.dropPendingUp(); // a drag swallows the pointerup: the "collapse on release" must not fire later
      const i = this.indexAt(e);
      if (i < 0) return e.preventDefault();
      if (!this.selected.has(this.items[i].path)) this.selectOnly(i);
      this.dragging = true;
      this.w.dragOut(e, this.selectedNodes());
    });
    this.el.addEventListener('dragend', () => {
      this.dragging = false;
      this.w.dragEnd?.();
    });
    this.el.addEventListener('focus', () => this.el.classList.toggle('kb', true));
    this.ro = new ResizeObserver(() => {
      this.fit();
      this.schedule();
    });
    this.ro.observe(this.el);
  }

  get rowH() {
    return shared.prefs.compact ? ROW_H.compact : ROW_H.normal;
  }

  // ---------------------------------------------------------------- columns
  setColumns(cols) {
    this.columns = cols;
    for (const c of cols) c.eff = c.width;
    this.renderHead();
    this.fit();
    this.schedule(true);
  }
  totalWidth() {
    return this.columns.reduce((s, c) => s + (c.eff ?? c.width), 0);
  }
  /** Avoid a horizontal scrollbar when it can be: when the columns don't fit, they give up width (Name
   *  first, then Type, Date modified, Folder, Compressed size, Size, Ratio) down to their minimum widths.
   *  Columns the user resized by hand keep their width. */
  fit() {
    const avail = Math.max(0, this.el.clientWidth - 16);
    if (!avail || !this.columns.length || this.userSized) return;
    const MIN = { name: 132, type: 84, mtime: 120, location: 110, packed: 96, size: 68, ratio: 50 };
    const ORDER = ['name', 'type', 'mtime', 'location', 'packed', 'size', 'ratio'];
    const eff = new Map(this.columns.map((c) => [c, c.width]));
    let excess = this.columns.reduce((t, c) => t + c.width, 0) - avail;
    for (const key of ORDER) {
      if (excess <= 0) break;
      const c = this.columns.find((x) => x.key === key);
      if (!c) continue;
      const give = Math.max(0, Math.min(excess, c.width - Math.min(c.width, MIN[key] || 60)));
      eff.set(c, c.width - give);
      excess -= give;
    }
    let changed = false;
    for (const c of this.columns) {
      if (eff.get(c) !== c.eff) {
        c.eff = eff.get(c);
        changed = true;
      }
    }
    if (!changed) return;
    [...this.head.children].forEach((cell, i) => this.columns[i] && (cell.style.width = `${this.columns[i].eff}px`));
    this.inner.style.setProperty('--w-total', `${this.totalWidth()}px`);
    this.applyWidths();
  }
  renderHead() {
    const { h, icon } = this.w;
    const sort = shared.prefs.sort;
    this.head.replaceChildren();
    for (const c of this.columns) {
      const cell = h(
        'div',
        {
          class: ['arc-dh-cell', c.align === 'end' && 'end', sort.key === c.key && 'sorted'],
          role: 'columnheader',
          'aria-sort': sort.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none',
          style: { width: `${c.eff ?? c.width}px` },
          dataset: { key: c.key },
          onclick: (e) => {
            if (e.target.closest('.arc-col-resize')) return;
            this.w.setSort(c.key);
          },
        },
        h('span', { class: 'ellipsis' }, c.label),
        sort.key === c.key ? h('span', { class: 'arc-sort-ind', 'aria-hidden': 'true' }, icon(sort.dir === 'asc' ? 'chevron_up' : 'chevron_down', { size: 12 })) : null,
        h('div', { class: 'arc-col-resize', onpointerdown: (e) => this.startResize(e, c, cell) }),
      );
      this.head.appendChild(cell);
    }
    this.inner.style.setProperty('--w-total', `${this.totalWidth()}px`);
  }
  startResize(e, col, cell) {
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    const w0 = col.eff ?? col.width;
    const target = e.currentTarget;
    target.setPointerCapture?.(e.pointerId);
    this.inner.classList.add('resizing');
    const move = (ev) => {
      col.width = col.eff = Math.max(col.min || 56, Math.min(900, Math.round(w0 + ev.clientX - x0)));
      cell.style.width = `${col.width}px`;
      this.inner.style.setProperty('--w-total', `${this.totalWidth()}px`);
      this.applyWidths();
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      this.inner.classList.remove('resizing');
      this.userSized = true; // the user's widths win over auto-fitting from now on
      shared.setPref('widths', { ...shared.prefs.widths, [col.key]: col.width });
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  }
  applyWidths() {
    for (const row of this.rowEls.values()) {
      [...row.children].forEach((cell, i) => {
        if (this.columns[i]) cell.style.width = `${this.columns[i].eff ?? this.columns[i].width}px`;
      });
    }
  }

  // ---------------------------------------------------------------- items
  setItems(items, { keep = false, focusPath = null, select = null, empty = '' } = {}) {
    const prevFocus = this.items[this.focusIndex]?.path;
    this.items = items;
    if (!keep) this.selected.clear();
    else {
      const present = new Set(items.map((n) => n.path));
      for (const p of [...this.selected]) if (!present.has(p)) this.selected.delete(p);
    }
    if (select) {
      this.selected = new Set(select.filter((p) => items.some((n) => n.path === p)));
    }
    const want = focusPath || (keep ? prevFocus : null) || (select && select[0]);
    this.focusIndex = want ? items.findIndex((n) => n.path === want) : -1;
    if (this.focusIndex < 0 && !keep) this.focusIndex = -1;
    this.anchor = this.focusIndex;
    this.emptyEl.textContent = empty;
    this.emptyEl.hidden = items.length > 0;
    this.rows.style.height = `${items.length * this.rowH}px`;
    this.rowEls.clear();
    this.rows.replaceChildren();
    this.range = [0, -1];
    if (!keep) this.el.scrollTop = 0;
    this.render(true);
    if (this.focusIndex >= 0) this.ensureVisible(this.focusIndex);
    this.w.onSelectionChange();
  }
  refreshRows() {
    this.rowEls.clear();
    this.rows.replaceChildren();
    this.rows.style.height = `${this.items.length * this.rowH}px`;
    this.range = [0, -1];
    this.render(true);
  }

  schedule(force = false) {
    if (force) this.forceNext = true;
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = null;
      const f = this.forceNext;
      this.forceNext = false;
      this.render(f);
    });
  }

  render(force = false) {
    const rh = this.rowH;
    const top = Math.max(0, this.el.scrollTop - HEAD_H);
    const height = this.el.clientHeight || 600;
    const first = Math.max(0, Math.floor(top / rh) - 6);
    const last = Math.min(this.items.length - 1, Math.ceil((top + height) / rh) + 6);
    if (force || first !== this.range[0] || last !== this.range[1]) {
      for (const [i, el] of this.rowEls) {
        if (i < first || i > last || force) {
          el.remove();
          this.rowEls.delete(i);
        }
      }
      for (let i = first; i <= last; i++) {
        if (!this.rowEls.has(i)) {
          const el = this.buildRow(i);
          this.rowEls.set(i, el);
          this.rows.appendChild(el);
        }
      }
      this.range = [first, last];
    }
    this.paintState();
  }

  buildRow(i) {
    const { h, t, i18n, icon } = this.w;
    const n = this.items[i];
    const L = this.w.listing;
    const cells = this.columns.map((c) => {
      let content = '';
      switch (c.key) {
        case 'name':
          content = [
            h('span', { class: 'arc-ic' }, h('img', { src: iconUrl(n), alt: '', draggable: false }), n.link != null ? h('img', { class: 'arc-link-ov', src: 'app://shell/apps/archive/icons/link.svg', alt: '' }) : null),
            h('span', { class: 'arc-name ellipsis' }, n.name),
            n.encrypted ? h('span', { class: 'arc-lock', 'data-tip': t('list.encrypted'), 'aria-label': t('list.encrypted') }, icon('lock_closed', { size: 12, filled: true })) : null,
          ];
          break;
        case 'type':
          content = typeName(n, t);
          break;
        case 'packed':
          content = n.dir ? '' : n.packed == null ? '' : i18n.formatSize(n.packed);
          break;
        case 'size':
          content = n.dir ? '' : i18n.formatSize(n.size);
          break;
        case 'ratio': {
          const r = n.dir ? null : ratioOf(n.size, n.packed);
          content = r == null ? '' : t('fmt.pct', { n: i18n.formatNumber(Math.round(r * 100)) });
          break;
        }
        case 'mtime':
          content = n.mtime ? i18n.formatDate(n.mtime, { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }).replace(',', '') : '';
          break;
        case 'location':
          content = n.parent?.path ? `${L?.name || ''}/${n.parent.path}` : L?.name || '';
          break;
      }
      return h('div', { class: ['arc-cell', `c-${c.key}`, c.align === 'end' && 'end'], role: 'gridcell', style: { width: `${c.eff ?? c.width}px` } }, content);
    });
    const row = h(
      'div',
      {
        class: 'arc-row',
        role: 'option',
        id: `${this.w.uid}-r${i}`,
        draggable: 'true',
        'aria-selected': 'false',
        dataset: { index: String(i), path: n.path },
        style: { transform: `translateY(${i * this.rowH}px)`, height: `${this.rowH}px` },
      },
      cells,
    );
    return row;
  }

  paintState() {
    for (const [i, el] of this.rowEls) {
      const n = this.items[i];
      const sel = this.selected.has(n.path);
      el.classList.toggle('selected', sel);
      el.setAttribute('aria-selected', String(sel));
      el.classList.toggle('focused', i === this.focusIndex);
      el.classList.toggle('cut', !!this.w.dimmed?.has(n.path));
    }
    if (this.focusIndex >= 0 && this.rowEls.has(this.focusIndex)) this.el.setAttribute('aria-activedescendant', `${this.w.uid}-r${this.focusIndex}`);
    else this.el.removeAttribute('aria-activedescendant');
  }

  // ---------------------------------------------------------------- selection
  selectedNodes() {
    return this.items.filter((n) => this.selected.has(n.path));
  }
  selectOnly(i) {
    this.selected = new Set(i >= 0 && this.items[i] ? [this.items[i].path] : []);
    this.focusIndex = i;
    this.anchor = i;
    this.paintState();
    this.w.onSelectionChange();
  }
  selectAll() {
    this.selected = new Set(this.items.map((n) => n.path));
    this.paintState();
    this.w.onSelectionChange();
  }
  clearSelection() {
    this.selected.clear();
    this.paintState();
    this.w.onSelectionChange();
  }
  selectPaths(paths) {
    this.selected = new Set(paths);
    const i = this.items.findIndex((n) => this.selected.has(n.path));
    if (i >= 0) {
      this.focusIndex = this.anchor = i;
      this.ensureVisible(i);
    }
    this.paintState();
    this.w.onSelectionChange();
  }
  moveFocus(i, { shift = false, ctrl = false } = {}) {
    if (!this.items.length) return;
    i = Math.max(0, Math.min(this.items.length - 1, i));
    this.focusIndex = i;
    if (shift) {
      const a = this.anchor < 0 ? i : this.anchor;
      const [lo, hi] = a < i ? [a, i] : [i, a];
      this.selected = new Set(this.items.slice(lo, hi + 1).map((n) => n.path));
    } else if (!ctrl) {
      this.selected = new Set([this.items[i].path]);
      this.anchor = i;
    }
    this.ensureVisible(i);
    this.paintState();
    this.w.onSelectionChange();
  }
  ensureVisible(i) {
    const rh = this.rowH;
    const top = i * rh + HEAD_H;
    const bottom = top + rh;
    const view = this.el.clientHeight;
    if (top - HEAD_H < this.el.scrollTop) this.el.scrollTop = top - HEAD_H;
    else if (bottom > this.el.scrollTop + view) this.el.scrollTop = bottom - view;
    this.render();
  }
  indexAt(e) {
    const row = e.target.closest?.('.arc-row');
    return row ? Number(row.dataset.index) : -1;
  }

  // ---------------------------------------------------------------- input
  dropPendingUp() {
    if (this.pendingUp) this.el.removeEventListener('pointerup', this.pendingUp);
    this.pendingUp = null;
  }
  onPointerDown(e) {
    this.dropPendingUp();
    if (e.target.closest('.arc-dh')) return;
    if (e.button !== 0 && e.button !== 2) return;
    const i = this.indexAt(e);
    if (i < 0) {
      if (e.button === 0 && !e.ctrlKey && !e.shiftKey && this.selected.size) this.clearSelection();
      return;
    }
    if (e.button === 2) {
      if (!this.selected.has(this.items[i].path)) this.selectOnly(i);
      return;
    }
    if (e.shiftKey) this.moveFocus(i, { shift: true });
    else if (e.ctrlKey) {
      const p = this.items[i].path;
      if (this.selected.has(p)) this.selected.delete(p);
      else this.selected.add(p);
      this.focusIndex = this.anchor = i;
      this.paintState();
      this.w.onSelectionChange();
    } else if (!this.selected.has(this.items[i].path) || this.selected.size === 1) this.selectOnly(i);
    else {
      // click inside a multi-selection: keep it for dragging, collapse on release without a drag
      this.focusIndex = i;
      const up = () => {
        this.dropPendingUp();
        if (!this.dragging) this.selectOnly(i);
      };
      this.pendingUp = up;
      this.el.addEventListener('pointerup', up);
      this.paintState();
    }
  }
  onContext(e) {
    if (e.target.closest('.arc-dh')) {
      e.preventDefault();
      this.w.columnMenu(e);
      return;
    }
    e.preventDefault();
    const i = this.indexAt(e);
    if (i < 0) {
      this.clearSelection();
      this.w.backgroundMenu(e);
    } else this.w.itemMenu(e, this.selectedNodes());
  }
  onKey(e) {
    const n = this.items.length;
    const page = Math.max(1, Math.floor((this.el.clientHeight - HEAD_H) / this.rowH) - 1);
    const mods = { shift: e.shiftKey, ctrl: e.ctrlKey };
    const fi = this.focusIndex;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        this.moveFocus(fi < 0 ? 0 : fi + 1, mods);
        return;
      case 'ArrowUp':
        if (e.altKey) return;
        e.preventDefault();
        this.moveFocus(fi < 0 ? 0 : fi - 1, mods);
        return;
      case 'Home':
        e.preventDefault();
        this.moveFocus(0, mods);
        return;
      case 'End':
        e.preventDefault();
        this.moveFocus(n - 1, mods);
        return;
      case 'PageDown':
        e.preventDefault();
        this.moveFocus(fi < 0 ? 0 : fi + page, mods);
        return;
      case 'PageUp':
        e.preventDefault();
        this.moveFocus(fi < 0 ? 0 : fi - page, mods);
        return;
      case ' ':
        if (e.ctrlKey && fi >= 0) {
          e.preventDefault();
          const p = this.items[fi].path;
          if (this.selected.has(p)) this.selected.delete(p);
          else this.selected.add(p);
          this.paintState();
          this.w.onSelectionChange();
          return;
        }
        if (this.typeBuf) break; // part of a type-ahead name
        if (fi >= 0 && !this.selected.has(this.items[fi].path)) {
          e.preventDefault();
          this.moveFocus(fi);
        }
        return;
      case 'Enter':
        if (e.altKey) return;
        e.preventDefault();
        if (this.selected.size === 1) this.w.openNode(this.selectedNodes()[0]);
        else if (this.selected.size > 1) this.w.openMany(this.selectedNodes());
        return;
      case 'Escape':
        if (this.selected.size) {
          e.preventDefault();
          e.stopPropagation();
          this.clearSelection();
        }
        return;
      case 'ContextMenu':
      case 'F10':
        if (e.key === 'F10' && !e.shiftKey) return;
        e.preventDefault();
        {
          const el = this.rowEls.get(fi);
          const r = (el || this.el).getBoundingClientRect();
          const at = { x: r.left + 40, y: r.top + (el ? r.height : 40) };
          if (this.selected.size) this.w.itemMenu(at, this.selectedNodes());
          else this.w.backgroundMenu(at);
        }
        return;
      default:
        break;
    }
    if (e.key === 'a' && e.ctrlKey && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      this.selectAll();
      return;
    }
    // type-ahead
    if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey && n) {
      e.preventDefault();
      clearTimeout(this.typeTimer);
      this.typeTimer = setTimeout(() => (this.typeBuf = ''), 900);
      const same = this.typeBuf.length === 1 && e.key.toLowerCase() === this.typeBuf;
      this.typeBuf = same ? this.typeBuf : this.typeBuf + e.key.toLowerCase();
      const start = same || this.typeBuf.length === 1 ? fi + 1 : Math.max(0, fi);
      for (let k = 0; k < n; k++) {
        const i = (start + k) % n;
        if (this.items[i].name.toLowerCase().startsWith(this.typeBuf)) {
          this.moveFocus(i);
          break;
        }
      }
    }
  }

  destroy() {
    this.ro.disconnect();
    cancelAnimationFrame(this.raf);
    clearTimeout(this.typeTimer);
    this.dropPendingUp();
  }
}
