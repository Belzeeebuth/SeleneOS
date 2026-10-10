// Virtualized photo grid: justified rows (or squares) grouped by month, with a sticky date header,
// a date scrubber, lazy thumbnails (IntersectionObserver), multi-select and keyboard navigation.
//
//   const grid = new VirtualGrid(app, { onOpen(item, list), onContext(e, item), onSelection(set), onDelete(items) })
//   grid.setData({ items, grouped, empty })   grid.relayout()   grid.selectAll()   grid.clearSelection()
//   grid.selected -> Set of paths      grid.el -> root element
import { justify, squares, safeAspect, findBlock } from './layout.js';
import { groupByMonth, rafThrottle, setDragPaths, clamp } from './util.js';

const PAD_X = 24;
const HEADER_H = 52;
const FIRST_HEADER_H = 40;
const GAP = 4;
const SIZES = { small: { row: 128, sq: 120 }, medium: { row: 188, sq: 168 }, large: { row: 272, sq: 248 } };

let gridSeq = 0;

export class VirtualGrid {
  constructor(app, opts = {}) {
    this.app = app;
    this.h = app.h;
    this.t = app.t;
    this.icon = app.icon;
    this.thumbs = app.thumbs;
    this.lib = app.lib;
    this.opts = opts;
    this.id = `phg${++gridSeq}`;
    this.items = [];
    this.groups = [];
    this.grouped = true;
    this.blocks = [];
    this.tops = [];
    this.flat = [];
    this.pos = new Map(); // path -> flat index
    this.cellAt = []; // flat index -> { b, c }
    this.rendered = new Map(); // block index -> element
    this.selected = new Set();
    this.anchor = -1;
    this.focusIdx = -1;
    this.kb = false;
    this.width = 0;
    this.totalH = 0;
    this.renderStats = { calls: 0, ms: 0 };
    this._build();
  }

  _build() {
    const { h } = this;
    this.canvas = h('div', { class: 'ph-canvas' });
    this.scroll = h('div', {
      class: 'ph-scroll',
      tabindex: '0',
      role: 'grid',
      'aria-multiselectable': 'true',
      'aria-label': this.opts.label || this.t('gallery'),
    }, this.canvas);
    this.sticky = h('div', { class: 'ph-sticky', 'aria-hidden': 'true' }, h('span', { class: 'ph-sticky-label' }));
    this.scrubLabel = h('div', { class: 'ph-scrub-bubble' });
    this.scrubber = h('div', { class: 'ph-scrubber', 'aria-hidden': 'true' }, h('div', { class: 'ph-scrub-track' }), this.scrubLabel);
    this.emptyHost = h('div', { class: 'ph-grid-empty', hidden: true });
    this.el = h('div', { class: 'ph-gridwrap' }, this.scroll, this.sticky, this.scrubber, this.emptyHost);

    this._onScroll = rafThrottle(() => this._render());
    this.scroll.addEventListener('scroll', () => {
      this._onScroll();
      this.el.classList.add('scrolling');
      clearTimeout(this._scrollT);
      this._scrollT = setTimeout(() => this.el.classList.remove('scrolling'), 900);
    }, { passive: true });
    this.ro = new ResizeObserver(() => {
      const w = this.scroll.clientWidth;
      if (w && Math.abs(w - this.width) > 0.5) this.relayout(true);
      else this._render();
    });
    this.ro.observe(this.scroll);
    this.io = new IntersectionObserver((entries) => this._onIntersect(entries), { root: this.scroll, rootMargin: '400px 0px' });
    this._offSize = this.thumbs.onSize(() => this._sizeChanged());

    // Pointer & keyboard
    this.scroll.addEventListener('click', (e) => this._onClick(e));
    this.scroll.addEventListener('dblclick', (e) => e.preventDefault());
    this.scroll.addEventListener('contextmenu', (e) => this._onContext(e));
    this.scroll.addEventListener('keydown', (e) => this._onKey(e));
    this.scroll.addEventListener('pointerdown', () => (this.kb = false));
    this.scroll.addEventListener('focus', () => {
      if (this.focusIdx < 0 && this.flat.length && this.kb) this._setFocus(0, false);
    });
    this.scroll.addEventListener('dragstart', (e) => this._onDragStart(e));
    this._bindScrubber();
  }

  destroy() {
    this.ro.disconnect();
    this.io.disconnect();
    this._offSize?.();
    this._onScroll.cancel();
  }

  get sizes() {
    return SIZES[this.lib.prefs.thumbSize] || SIZES.medium;
  }

  // ---------------------------------------------------------------- data & layout
  setData({ items = [], grouped = true, empty = null, keepScroll = false } = {}) {
    const prevSel = this.selected;
    this.items = items;
    this.grouped = grouped;
    this.groups = grouped ? groupByMonth(items, this.app.locale) : [{ key: 'all', label: '', items }];
    this.flat = this.groups.flatMap((g) => g.items);
    this.pos = new Map(this.flat.map((it, i) => [it.path, i]));
    // Drop selected paths that are gone.
    this.selected = new Set([...prevSel].filter((p) => this.pos.has(p)));
    if (this.selected.size !== prevSel.size) this._selChanged();
    this.focusIdx = Math.min(this.focusIdx, this.flat.length - 1);
    this.emptyHost.hidden = !!items.length || !empty;
    this.app.ui.clear(this.emptyHost);
    if (!items.length && empty) this.emptyHost.appendChild(empty);
    this.scroll.hidden = !items.length && !!empty;
    if (!keepScroll) this.scroll.scrollTop = 0;
    this.relayout(keepScroll);
  }

  relayout(keepAnchor = false) {
    const width = this.scroll.clientWidth;
    if (!width) {
      this.width = 0;
      return;
    }
    let anchor = null;
    if (keepAnchor && this.blocks.length) {
      const st = this.scroll.scrollTop;
      const bi = findBlock(this.tops, st);
      const b = this.blocks[bi];
      const first = b?.cells?.[0]?.idx ?? (this.blocks[bi + 1]?.cells?.[0]?.idx ?? -1);
      if (first >= 0) anchor = { idx: first, off: st - (this.blocks[this.cellAt[first]?.b]?.y ?? 0) };
    }
    this.width = width;
    const scrubW = this._needsScrubber() ? 16 : 0;
    const inner = Math.max(80, width - PAD_X * 2 - scrubW);
    const sz = this.sizes;
    const square = this.lib.prefs.layout === 'square';
    this.blocks = [];
    this.cellAt = new Array(this.flat.length);
    let y = this.grouped ? 0 : 8;
    let idx = 0;
    this.groups.forEach((g, gi) => {
      if (this.grouped) {
        const hh = gi === 0 ? FIRST_HEADER_H : HEADER_H;
        this.blocks.push({ type: 'header', y, h: hh, group: g, gi });
        y += hh;
      }
      const L = square
        ? squares(g.items.length, inner, { size: sz.sq, gap: GAP, y0: y })
        : justify(g.items.map((it) => safeAspect(it.w, it.h)), inner, { rowHeight: sz.row, gap: GAP, y0: y });
      for (const row of L.rows) {
        const bi = this.blocks.length;
        const cells = row.cells.map((c, ci) => {
          const fi = idx + c.i;
          this.cellAt[fi] = { b: bi, c: ci };
          return { idx: fi, item: g.items[c.i], x: c.x + PAD_X, w: c.w };
        });
        this.blocks.push({ type: 'row', y: row.y, h: row.h, cells, gi });
      }
      idx += g.items.length;
      y += L.height + (L.rows.length ? GAP : 0);
    });
    this.totalH = y + 24;
    this.tops = this.blocks.map((b) => b.y);
    this.canvas.style.height = `${this.totalH}px`;
    for (const el of this.rendered.values()) this._unmountBlock(el);
    this.rendered.clear();
    if (anchor && this.cellAt[anchor.idx]) this.scroll.scrollTop = this.blocks[this.cellAt[anchor.idx].b].y + anchor.off;
    this._buildScrubber();
    this._render();
  }

  _sizeChanged() {
    clearTimeout(this._szT);
    this._szT = setTimeout(() => this.relayout(true), 250);
  }

  // ---------------------------------------------------------------- rendering
  _render() {
    if (!this.width) return;
    const t0 = performance.now();
    try {
      this._renderBlocks();
    } finally {
      this.renderStats.calls++;
      this.renderStats.ms += performance.now() - t0;
    }
  }

  _renderBlocks() {
    const st = this.scroll.scrollTop;
    const vh = this.scroll.clientHeight || 600;
    const from = Math.max(0, findBlock(this.tops, st - vh * 0.75));
    const toY = st + vh * 1.75;
    const keep = new Set();
    for (let i = from; i < this.blocks.length && this.blocks[i].y <= toY; i++) {
      keep.add(i);
      if (!this.rendered.has(i)) {
        const el = this._mountBlock(this.blocks[i], i);
        this.rendered.set(i, el);
        this.canvas.appendChild(el);
      }
    }
    for (const [i, el] of this.rendered) {
      if (!keep.has(i)) {
        this._unmountBlock(el);
        this.rendered.delete(i);
      }
    }
    this._updateSticky(st);
    this._updateScrubThumb(st, vh);
  }

  _mountBlock(b, bi) {
    const { h } = this;
    if (b.type === 'header') {
      const allSel = b.group.items.length > 0 && b.group.items.every((it) => this.selected.has(it.path));
      const el = h(
        'div',
        { class: ['ph-ghead', bi === 0 && 'first', allSel && 'all-selected'], style: { transform: `translateY(${b.y}px)`, height: `${b.h}px` }, dataset: { b: bi } },
        h('button', {
          class: 'ph-gcheck',
          tabindex: '-1',
          'aria-label': this.t('selectGroup', { group: b.group.label }),
          'data-tip': this.t('selectGroup', { group: b.group.label }),
          onclick: (e) => {
            e.stopPropagation();
            this._toggleGroup(b.group);
          },
        }, this.icon('checkmark', { size: 12 })),
        h('span', { class: 'ph-ghead-label' }, b.group.label),
        h('span', { class: 'ph-ghead-count caption' }, this.t('itemCount', { count: b.group.items.length })),
      );
      return el;
    }
    const row = h('div', { class: 'ph-row', style: { transform: `translateY(${b.y}px)`, height: `${b.h}px` }, dataset: { b: bi } });
    for (const c of b.cells) row.appendChild(this._tile(c, b.h));
    return row;
  }

  _unmountBlock(el) {
    for (const t of el.querySelectorAll('.ph-tile')) {
      this.io.unobserve(t);
      if (t._item && !t._loaded) this.thumbs.cancel(t._item);
    }
    el.remove();
  }

  _tile(c, height) {
    const { h } = this;
    const it = c.item;
    const img = h('img', { class: 'ph-thumb', alt: '', draggable: false, decoding: 'async' });
    const sel = this.selected.has(it.path);
    const tile = h(
      'div',
      {
        class: ['ph-tile', sel && 'selected', c.idx === this.focusIdx && this.kb && 'kbfocus'],
        id: `${this.id}-t${c.idx}`,
        role: 'gridcell',
        'aria-selected': sel ? 'true' : 'false',
        'aria-label': it.name,
        draggable: 'true',
        style: { left: `${c.x}px`, width: `${c.w}px`, height: `${height}px` },
        dataset: { i: c.idx },
      },
      img,
      this.lib.isFavorite(it.path) ? h('span', { class: 'ph-fav-badge' }, this.icon('heart', { filled: true, size: 14 })) : null,
      it.ext === '.gif' || it.ext === '.svg' ? h('span', { class: 'ph-type-badge' }, it.ext.slice(1).toUpperCase()) : null,
      h('button', { class: 'ph-check', tabindex: '-1', 'aria-label': this.t('select'), 'data-action': 'check' }, this.icon('checkmark', { size: 12 })),
    );
    tile._item = it;
    tile._img = img;
    img.addEventListener('load', () => {
      tile._loaded = true;
      tile.classList.add('loaded');
    });
    img.addEventListener('error', () => tile.classList.add('broken'));
    const url = this.thumbs.url(it);
    if (url) {
      // Cached thumbnails appear without a fade (less raster work while scrolling fast).
      tile.classList.add('instant');
      img.src = url;
    } else if (this.thumbs.isFailed(it)) tile.classList.add('broken');
    else this.io.observe(tile);
    return tile;
  }

  _onIntersect(entries) {
    for (const e of entries) {
      const tile = e.target;
      const it = tile._item;
      if (!it) continue;
      if (e.isIntersecting) {
        const visible = e.intersectionRect.height > 0;
        this.thumbs.request(it, visible ? 2 : 1).then((url) => {
          if (!tile.isConnected || tile._item !== it) return;
          if (url) {
            tile._img.src = url;
            this.io.unobserve(tile);
          } else if (this.thumbs.isFailed(it)) {
            tile.classList.add('broken');
            this.io.unobserve(tile);
          }
        });
      } else if (!tile._loaded) this.thumbs.cancel(it);
    }
  }

  /** Re-render tiles in place (favorite badges, selection) without relayout. */
  refreshTiles() {
    for (const [i, el] of this.rendered) {
      this._unmountBlock(el);
      this.rendered.delete(i);
    }
    this._render();
  }

  // ---------------------------------------------------------------- sticky header + scrubber
  _updateSticky(st) {
    if (!this.grouped || !this.blocks.length) {
      this.sticky.hidden = true;
      return;
    }
    const bi = findBlock(this.tops, st);
    const gi = this.blocks[bi]?.gi ?? 0;
    const headerBi = this.blocks.findIndex((b) => b.type === 'header' && b.gi === gi);
    const head = this.blocks[headerBi];
    if (!head || st <= head.y + 4) {
      this.sticky.hidden = true;
      return;
    }
    const next = this.blocks.find((b, i) => i > headerBi && b.type === 'header');
    const stickyH = 40;
    const push = next ? Math.min(0, next.y - st - stickyH) : 0;
    this.sticky.hidden = false;
    this.sticky.firstChild.textContent = head.group.label;
    this.sticky.style.transform = `translateY(${push}px)`;
  }

  _needsScrubber() {
    return this.grouped && this.groups.length > 1 && this.flat.length > 40;
  }

  _buildScrubber() {
    const track = this.scrubber.firstChild;
    this.app.ui.clear(track);
    const on = this._needsScrubber() && this.totalH > (this.scroll.clientHeight || 600) * 2.2;
    this.scrubber.hidden = !on;
    this.el.classList.toggle('has-scrubber', on);
    if (!on) return;
    let lastYear = null;
    let lastPct = -100;
    for (const b of this.blocks) {
      if (b.type !== 'header') continue;
      const yr = new Date(b.group.ts).getFullYear();
      if (yr === lastYear) continue;
      lastYear = yr;
      const pct = (b.y / this.totalH) * 100;
      if (pct - lastPct < 4) continue; // avoid overlapping labels
      lastPct = pct;
      track.appendChild(this.h('div', { class: 'ph-scrub-year caption', style: { top: `${pct}%` } }, String(yr)));
    }
    track.appendChild(this.h('div', { class: 'ph-scrub-thumb' }));
  }

  _updateScrubThumb(st, vh) {
    const th = this.scrubber.querySelector('.ph-scrub-thumb');
    if (!th || !this.totalH) return;
    th.style.top = `${(st / this.totalH) * 100}%`;
    th.style.height = `${Math.max(2, (vh / this.totalH) * 100)}%`;
  }

  _groupAtFraction(f) {
    const y = f * this.totalH;
    const bi = findBlock(this.tops, y);
    const gi = this.blocks[bi]?.gi ?? 0;
    return { y, group: this.groups[gi] };
  }

  _bindScrubber() {
    let dragging = false;
    const frac = (e) => {
      const r = this.scrubber.getBoundingClientRect();
      return { f: clamp((e.clientY - r.top) / r.height, 0, 1), y: clamp(e.clientY - r.top, 0, r.height) };
    };
    const show = (e) => {
      const { f, y } = frac(e);
      const { group } = this._groupAtFraction(f);
      this.scrubLabel.textContent = group?.label || '';
      this.scrubLabel.style.top = `${y}px`;
      this.scrubber.classList.add('hover');
      return f;
    };
    const jump = (f) => {
      const { y } = this._groupAtFraction(f);
      const bi = findBlock(this.tops, y);
      // Snap to the start of the month under the pointer.
      let hb = bi;
      while (hb > 0 && this.blocks[hb].type !== 'header') hb--;
      this.scroll.scrollTop = this.blocks[hb]?.y ?? y;
    };
    this.scrubber.addEventListener('pointermove', (e) => {
      const f = show(e);
      if (dragging) jump(f);
    });
    this.scrubber.addEventListener('pointerleave', () => {
      if (!dragging) this.scrubber.classList.remove('hover');
    });
    this.scrubber.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      dragging = true;
      this.scrubber.setPointerCapture(e.pointerId);
      this.scrubber.classList.add('dragging');
      jump(show(e));
    });
    const end = () => {
      dragging = false;
      this.scrubber.classList.remove('dragging', 'hover');
    };
    this.scrubber.addEventListener('pointerup', end);
    this.scrubber.addEventListener('pointercancel', end);
  }

  // ---------------------------------------------------------------- selection
  _selChanged() {
    this.el.classList.toggle('selecting', this.selected.size > 0 || !!this.forceSelect);
    this.opts.onSelection?.(this.selected);
  }
  setSelectMode(on) {
    this.forceSelect = !!on;
    if (!on) this.selected.clear();
    this.refreshTiles();
    this._selChanged();
  }
  isSelecting() {
    return this.selected.size > 0 || !!this.forceSelect;
  }
  selectedItems() {
    return this.flat.filter((it) => this.selected.has(it.path));
  }
  _applySel(idxs, on) {
    for (const i of idxs) {
      const it = this.flat[i];
      if (!it) continue;
      if (on) this.selected.add(it.path);
      else this.selected.delete(it.path);
    }
    this._paintSelection();
    this._selChanged();
  }
  _paintSelection() {
    for (const el of this.rendered.values()) {
      if (el.classList.contains('ph-ghead')) {
        const g = this.blocks[Number(el.dataset.b)]?.group;
        el.classList.toggle('all-selected', !!g && g.items.every((it) => this.selected.has(it.path)));
        continue;
      }
      for (const t of el.children) {
        const s = this.selected.has(t._item?.path);
        t.classList.toggle('selected', s);
        t.setAttribute('aria-selected', s ? 'true' : 'false');
      }
    }
  }
  toggle(i, { range = false } = {}) {
    if (range && this.anchor >= 0) {
      const [a, b] = [Math.min(this.anchor, i), Math.max(this.anchor, i)];
      this._applySel(Array.from({ length: b - a + 1 }, (_, k) => a + k), true);
      return;
    }
    const it = this.flat[i];
    if (!it) return;
    this.anchor = i;
    this._applySel([i], !this.selected.has(it.path));
  }
  _toggleGroup(g) {
    const all = g.items.every((it) => this.selected.has(it.path));
    this._applySel(g.items.map((it) => this.pos.get(it.path)), !all);
  }
  selectAll() {
    this._applySel(this.flat.map((_, i) => i), true);
  }
  clearSelection() {
    if (!this.selected.size) return;
    this.selected.clear();
    this._paintSelection();
    this._selChanged();
  }
  selectPaths(paths) {
    this.selected = new Set(paths.filter((p) => this.pos.has(p)));
    this._paintSelection();
    this._selChanged();
  }

  // ---------------------------------------------------------------- events
  _tileFrom(e) {
    return e.target.closest?.('.ph-tile');
  }
  _onClick(e) {
    const tile = this._tileFrom(e);
    if (!tile) return;
    const i = Number(tile.dataset.i);
    this._setFocus(i, false);
    if (e.target.closest('[data-action="check"]')) {
      e.stopPropagation();
      this.toggle(i, { range: e.shiftKey });
      return;
    }
    if (e.shiftKey) return this.toggle(i, { range: true });
    if (e.ctrlKey || e.metaKey || this.isSelecting()) return this.toggle(i);
    this.anchor = i;
    this.opts.onOpen?.(this.flat[i], this.flat, i);
  }
  _onContext(e) {
    const tile = this._tileFrom(e);
    e.preventDefault();
    if (!tile) {
      this.opts.onBackgroundContext?.(e);
      return;
    }
    const i = Number(tile.dataset.i);
    this._setFocus(i, false);
    const it = this.flat[i];
    const items = this.selected.has(it.path) ? this.selectedItems() : [it];
    this.opts.onContext?.(e, it, items);
  }
  _onDragStart(e) {
    const tile = this._tileFrom(e);
    if (!tile) return;
    const it = tile._item;
    const items = this.selected.has(it.path) ? this.selectedItems() : [it];
    setDragPaths(e.dataTransfer, items.map((x) => x.path));
    try {
      const ghost = tile._img;
      if (ghost?.complete) e.dataTransfer.setDragImage(ghost, Math.min(48, ghost.width / 2), Math.min(48, ghost.height / 2));
    } catch {}
  }

  _setFocus(i, scroll = true) {
    if (!this.flat.length) return;
    i = clamp(i, 0, this.flat.length - 1);
    this.focusIdx = i;
    if (scroll) this.scrollToIndex(i);
    for (const el of this.rendered.values()) for (const t of el.querySelectorAll?.('.ph-tile') || []) t.classList.toggle('kbfocus', this.kb && Number(t.dataset.i) === i);
    this.scroll.setAttribute('aria-activedescendant', `${this.id}-t${i}`);
  }

  scrollToIndex(i, { center = false } = {}) {
    const pos = this.cellAt[i];
    if (!pos) return;
    const b = this.blocks[pos.b];
    const st = this.scroll.scrollTop;
    const vh = this.scroll.clientHeight;
    const top = b.y - (this.grouped ? 44 : 8);
    if (center) this.scroll.scrollTop = b.y - (vh - b.h) / 2;
    else if (top < st) this.scroll.scrollTop = top;
    else if (b.y + b.h + 8 > st + vh) this.scroll.scrollTop = b.y + b.h + 8 - vh;
    this._render();
  }

  scrollToPath(p) {
    const i = this.pos.get(p);
    if (i == null) return;
    this.scrollToIndex(i, { center: true });
    this.focusIdx = i;
  }

  /** Index of the first photo in view. */
  firstVisible() {
    const st = this.scroll.scrollTop;
    for (let bi = Math.max(0, findBlock(this.tops, st)); bi < this.blocks.length; bi++) {
      const b = this.blocks[bi];
      if (b.type === 'row' && b.y + b.h > st) return b.cells[0].idx;
    }
    return 0;
  }

  _vertical(i, dir) {
    const pos = this.cellAt[i];
    if (!pos) return i;
    const b = this.blocks[pos.b];
    const c = b.cells[pos.c];
    const cx = c.x + c.w / 2;
    for (let bi = pos.b + dir; bi >= 0 && bi < this.blocks.length; bi += dir) {
      const nb = this.blocks[bi];
      if (nb.type !== 'row') continue;
      let best = nb.cells[0];
      for (const cc of nb.cells) if (Math.abs(cc.x + cc.w / 2 - cx) < Math.abs(best.x + best.w / 2 - cx)) best = cc;
      return best.idx;
    }
    return i;
  }

  _onKey(e) {
    if (e.target !== this.scroll) return;
    const n = this.flat.length;
    if (!n) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (this.focusIdx < 0 && (e.key === 'Enter' || e.key === ' ')) this.focusIdx = this.firstVisible();
    let i = this.focusIdx < 0 ? this.firstVisible() : this.focusIdx;
    let move = null;
    switch (e.key) {
      case 'ArrowRight':
        move = Math.min(n - 1, i + 1);
        break;
      case 'ArrowLeft':
        move = Math.max(0, i - 1);
        break;
      case 'ArrowDown':
        move = this._vertical(i, 1);
        break;
      case 'ArrowUp':
        move = this._vertical(i, -1);
        break;
      case 'Home':
        move = 0;
        break;
      case 'End':
        move = n - 1;
        break;
      case 'PageDown':
      case 'PageUp': {
        const dir = e.key === 'PageDown' ? 1 : -1;
        const target = (this.blocks[this.cellAt[i]?.b]?.y ?? 0) + dir * this.scroll.clientHeight * 0.9;
        let bi = clamp(findBlock(this.tops, target), 0, this.blocks.length - 1);
        while (this.blocks[bi] && this.blocks[bi].type !== 'row') bi += dir > 0 ? 1 : -1;
        move = this.blocks[bi]?.cells?.[0]?.idx ?? (dir > 0 ? n - 1 : 0);
        break;
      }
      case 'Enter':
        e.preventDefault();
        if (this.focusIdx >= 0) this.opts.onOpen?.(this.flat[this.focusIdx], this.flat, this.focusIdx);
        return;
      case ' ':
        e.preventDefault();
        this.kb = true;
        this.toggle(i);
        this._setFocus(i);
        return;
      case 'a':
      case 'A':
        if (ctrl) {
          e.preventDefault();
          this.selectAll();
        }
        return;
      case 'Escape':
        if (this.isSelecting()) {
          e.preventDefault();
          e.stopPropagation();
          if (this.forceSelect) this.opts.onExitSelect?.();
          this.forceSelect = false;
          this.clearSelection();
          this._selChanged();
        }
        return;
      case 'Delete': {
        e.preventDefault();
        const items = this.selected.size ? this.selectedItems() : this.focusIdx >= 0 ? [this.flat[this.focusIdx]] : [];
        if (items.length) this.opts.onDelete?.(items);
        return;
      }
      case 'F10':
      case 'ContextMenu':
        if (e.key === 'ContextMenu' || e.shiftKey) {
          e.preventDefault();
          const tile = this.scroll.querySelector(`#${this.id}-t${i}`);
          if (tile) {
            const r = tile.getBoundingClientRect();
            const it = this.flat[i];
            const items = this.selected.has(it.path) ? this.selectedItems() : [it];
            this.opts.onContext?.({ clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, preventDefault() {}, stopPropagation() {} }, it, items);
          }
        }
        return;
      default:
        return;
    }
    if (move != null) {
      e.preventDefault();
      this.kb = true;
      if (e.shiftKey) {
        if (this.anchor < 0) this.anchor = i;
        const [a, b] = [Math.min(this.anchor, move), Math.max(this.anchor, move)];
        this.selected = new Set(this.flat.slice(a, b + 1).map((x) => x.path));
        this._paintSelection();
        this._selChanged();
      } else if (!ctrl) this.anchor = move;
      this._setFocus(move);
    }
  }
}
