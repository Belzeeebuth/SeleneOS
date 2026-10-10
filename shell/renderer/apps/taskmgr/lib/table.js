// Virtualized tree-grid used by every Task Manager list (Processes, Details, Services, Users…).
//
//   const tb = new VTable({ columns, rowHeight: 30, header: 'two-line' | 'one-line', label,
//                           onSort(colId), onSelect(row), onActivate(row), onContext(row, event|rect),
//                           onToggle(row), onHeaderContext(event), onResize(widths), onDelete(row) });
//   tb.setColumns(cols)   cols: [{ id, label: () => str, top?: () => str, hot?: () => bool, width, min,
//                                  align: 'start'|'end', name?: true, flex?: true, max?: px, sortable?: true,
//                                  cell: (row) => str | { text, heat, icon, tip, cls } }]
//   tb.setRows(rows)      rows: [{ key, kind: 'group'|'item', depth, expandable, expanded, data,
//                                  label (group rows), selectable }]
//   tb.setSort(id, dir)   tb.select(key, { scroll })   tb.selectedRow()   tb.refreshHeader()
//
// Only the rows in view (+ overscan) exist in the DOM. Row elements are keyed by row.key and
// reused across ticks; each cell is only written when its text / heat / icon actually changed.
import { h, icon } from '../../../core/ui.js';
import { rowIcon, iconKey } from './util.js';

const OVERSCAN = 6;
let seq = 0;

export class VTable {
  constructor(opts = {}) {
    this.o = opts;
    this.rowH = opts.rowHeight || 30;
    this.cols = [];
    this.widths = { ...(opts.widths || {}) };
    this.rows = [];
    this.index = new Map();
    this.sel = null;
    this.sort = { id: null, dir: 1 };
    this.live = new Map();
    this.spare = [];
    this.layoutVer = 0;
    this.id = `tmt${++seq}`;
    this.el = h('div', {
      class: ['tm-table', opts.header === 'two-line' ? 'two-line' : 'one-line', opts.flat && 'flat', opts.className],
      role: 'treegrid',
      tabindex: '0',
      'aria-label': opts.label || '',
      'aria-multiselectable': 'false',
    });
    this.el.style.setProperty('--rowh', `${this.rowH}px`);
    // The header lives outside the scrolling area (rows never slide under it); it follows the
    // horizontal scroll and reserves the vertical scrollbar's width so the columns line up.
    this.head = h('div', { class: 'tm-thead', role: 'row' });
    this.headWrap = h('div', { class: 'tm-thead-wrap' }, this.head);
    this.body = h('div', { class: 'tm-tbody', role: 'rowgroup' });
    this.emptyEl = h('div', { class: 'tm-empty caption text-2', hidden: true });
    // Not a tab stop of its own (Chromium makes overflowing boxes focusable): the grid is.
    this.scroller = h('div', { class: 'tm-scroll', tabindex: '-1' }, this.body, this.emptyEl);
    this.el.append(this.headWrap, this.scroller);
    // A click on a row would focus the scroller (tabindex -1): the keyboard belongs to the grid.
    this.scroller.addEventListener('focus', () => this.focus());
    this._raf = 0;
    this.scroller.addEventListener(
      'scroll',
      () => {
        if (this.headWrap.scrollLeft !== this.scroller.scrollLeft) this.headWrap.scrollLeft = this.scroller.scrollLeft;
        this._queue();
      },
      { passive: true },
    );
    this._ro = new ResizeObserver(() => this._queue());
    this._ro.observe(this.scroller);
    this._wire();
  }

  // ------------------------------------------------------------------ columns
  setColumns(cols) {
    this.cols = cols;
    this.layoutVer++;
    for (const el of [...this.live.values(), ...this.spare]) el.remove();
    this.live.clear();
    this.spare = [];
    this._buildHead();
    this._applyWidths();
    this._queue();
  }
  colWidth(c) {
    // Default widths grow to fit the header label (French labels are longer); a width the user
    // set by dragging a divider wins.
    return Math.max(c.min || 48, this.widths[c.id] ?? Math.max(c.width ?? 100, this._labelWidth(c)));
  }
  _labelWidth(c) {
    const text = typeof c.label === 'function' ? c.label() : c.label || '';
    if (!text) return 0;
    const ctx = (VTable._measure ||= document.createElement('canvas').getContext('2d'));
    const font = `12px ${getComputedStyle(this.el.isConnected ? this.el : document.body).fontFamily}`;
    if (ctx.font !== font) ctx.font = font;
    return Math.ceil(ctx.measureText(text).width) + 24; // + the cell's horizontal padding
  }
  _applyWidths() {
    // A flexible column takes the spare width, up to its `max` (so numbers don't drift far away
    // from the names in a maximized window).
    const tpl = this.cols
      .map((c) => {
        const w = this.colWidth(c);
        return c.flex ? `minmax(${w}px, ${c.max ? `${Math.max(w, c.max)}px` : '1fr'})` : `${w}px`;
      })
      .join(' ');
    const total = this.cols.reduce((a, c) => a + this.colWidth(c), 0);
    this.el.style.setProperty('--tm-cols', tpl);
    this.el.style.setProperty('--tm-minw', `${total}px`);
  }
  _buildHead() {
    this.head.textContent = '';
    this.headCells = new Map();
    for (const c of this.cols) {
      const top = c.top ? h('div', { class: 'tm-th-top' }) : null;
      const sortIc = h('span', { class: 'tm-sort' }, icon('chevron_up', { size: 10 }));
      const cell = h(
        'div',
        {
          class: ['tm-th', c.align === 'end' && 'end', c.sortable === false && 'nosort'],
          role: 'columnheader',
          // One tab stop for the whole header row (roving): ←/→ move between the column headers.
          tabindex: '-1',
          dataset: { col: c.id },
          'aria-sort': 'none',
        },
        sortIc,
        top,
        h('div', { class: 'tm-th-label ellipsis' }, typeof c.label === 'function' ? c.label() : c.label),
        h('div', { class: 'tm-rs', dataset: { col: c.id } }),
      );
      this.headCells.set(c.id, { cell, top });
      this.head.appendChild(cell);
    }
    this._paintSort();
    this.refreshHeader();
  }
  refreshHeader() {
    if (!this.headCells) return;
    for (const c of this.cols) {
      const hc = this.headCells.get(c.id);
      if (!hc) continue;
      if (hc.top) {
        const v = c.top();
        if (hc.top.textContent !== v) hc.top.textContent = v;
      }
      const hot = !!c.hot?.();
      if (hc.cell.classList.contains('hot') !== hot) hc.cell.classList.toggle('hot', hot);
    }
  }
  relabel() {
    for (const c of this.cols) {
      const lab = this.headCells?.get(c.id)?.cell.querySelector('.tm-th-label');
      if (lab) lab.textContent = typeof c.label === 'function' ? c.label() : c.label;
    }
    this._applyWidths();
    this.refreshHeader();
  }
  setSort(id, dir) {
    this.sort = { id, dir };
    this._paintSort();
  }
  _paintSort() {
    if (!this.headCells) return;
    for (const [id, { cell }] of this.headCells) {
      const on = id === this.sort.id;
      cell.classList.toggle('sorted', on);
      cell.classList.toggle('desc', on && this.sort.dir < 0);
      cell.setAttribute('aria-sort', on ? (this.sort.dir < 0 ? 'descending' : 'ascending') : 'none');
    }
    if (!this.head.contains(document.activeElement)) this._rove(this.headCells.get(this.sort.id)?.cell);
  }
  // The header's single tab stop: the given cell, else the sorted column, else the first one.
  _rove(cell) {
    const cells = [...this.head.children];
    const target = cell && cells.includes(cell) ? cell : cells[0];
    for (const c of cells) c.tabIndex = c === target ? 0 : -1;
  }

  // ------------------------------------------------------------------ rows
  setRows(rows, { emptyText } = {}) {
    this.rows = rows;
    this.index = new Map();
    rows.forEach((r, i) => this.index.set(r.key, i));
    if (this.sel != null && !this.index.has(this.sel)) {
      this.sel = null;
      this.o.onSelect?.(null);
    }
    this.el.setAttribute('aria-rowcount', String(rows.length));
    this.emptyEl.hidden = rows.length > 0;
    if (emptyText != null) this.emptyEl.textContent = emptyText;
    this._render();
  }
  selectedRow() {
    return this.sel == null ? null : this.rows[this.index.get(this.sel)] || null;
  }
  rowByKey(key) {
    const i = this.index.get(key);
    return i == null ? null : this.rows[i];
  }
  select(key, { scroll = true, silent = false } = {}) {
    if (key != null && !this.index.has(key)) return false;
    const changed = key !== this.sel;
    this.sel = key;
    for (const [k, el] of this.live) {
      const on = k === key;
      if (el.classList.contains('sel') !== on) {
        el.classList.toggle('sel', on);
        el.setAttribute('aria-selected', String(on));
      }
    }
    if (key != null) {
      this.el.setAttribute('aria-activedescendant', `${this.id}-${this.index.get(key)}`);
      if (scroll) this.scrollTo(this.index.get(key));
    } else this.el.removeAttribute('aria-activedescendant');
    if (changed && !silent) this.o.onSelect?.(this.selectedRow());
    return true;
  }
  scrollTo(i) {
    const sc = this.scroller;
    const top = i * this.rowH;
    const view = sc.clientHeight;
    if (top < sc.scrollTop) sc.scrollTop = top;
    else if (top + this.rowH > sc.scrollTop + view) sc.scrollTop = top + this.rowH - view;
  }
  focus() {
    this.el.focus({ preventScroll: true });
  }

  _queue() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this._render();
    });
  }

  _render() {
    if (!this._fitted && this.el.isConnected && document.fonts?.status !== 'loading') {
      this._fitted = true; // label widths measured with the real font
      this._applyWidths();
    }
    const n = this.rows.length;
    this.body.style.height = `${n * this.rowH}px`;
    const sc = this.scroller;
    const gutter = sc.offsetWidth - sc.clientWidth;
    if (this._gutter !== gutter) {
      this._gutter = gutter;
      this.head.style.paddingRight = `${gutter}px`;
    }
    const top = sc.scrollTop;
    const vh = Math.max(sc.clientHeight, this.rowH * 10);
    const first = Math.max(0, Math.floor(top / this.rowH) - OVERSCAN);
    const last = Math.min(n, Math.ceil((top + vh) / this.rowH) + OVERSCAN);
    const want = new Set();
    for (let i = first; i < last; i++) want.add(this.rows[i].key);
    for (const [k, el] of this.live) {
      if (!want.has(k)) {
        this.live.delete(k);
        el.classList.remove('sel');
        el.removeAttribute('aria-selected');
        el._key = null;
        this.spare.push(el);
      }
    }
    for (let i = first; i < last; i++) {
      const row = this.rows[i];
      let el = this.live.get(row.key);
      if (!el) {
        // Recycled rows keep their cells: _fill only rewrites what differs for the new row.
        el = this.spare.pop() || h('div', { role: 'row' });
        el._key = row.key;
        this.live.set(row.key, el);
        if (!el.parentNode) this.body.appendChild(el);
      }
      this._fill(el, row, i);
    }
    // Keep a few detached-ready spares around; drop the rest.
    while (this.spare.length > 24) this.spare.pop().remove();
    for (const el of this.spare) el.hidden = true;
  }

  _fill(el, row, i) {
    el.hidden = false;
    const y = i * this.rowH;
    if (el._y !== y) {
      el._y = y;
      el.style.transform = `translateY(${y}px)`;
    }
    if (el.id !== `${this.id}-${i}`) {
      el.id = `${this.id}-${i}`;
      el.setAttribute('aria-rowindex', String(i + 1));
    }
    const kind = row.kind === 'group' ? 'group' : 'item';
    if (el._kind !== kind || el._ver !== this.layoutVer) this._build(el, kind);
    const sel = row.key === this.sel;
    if (el.classList.contains('sel') !== sel) {
      el.classList.toggle('sel', sel);
      el.setAttribute('aria-selected', String(sel));
    }
    if (row.expandable) el.setAttribute('aria-expanded', String(!!row.expanded));
    else el.removeAttribute('aria-expanded');
    el.setAttribute('aria-level', String((row.depth || 0) + 1));
    if (kind === 'group') {
      const g = el._g;
      const label = row.label || '';
      if (g.label.textContent !== label) g.label.textContent = label;
      g.chev.classList.toggle('open', !!row.expanded);
      return;
    }
    const dim = !!row.dim;
    if (el.classList.contains('dim') !== dim) el.classList.toggle('dim', dim);
    this.cols.forEach((c, ci) => {
      const slot = el._cells[ci];
      let v = c.cell(row);
      if (v == null || typeof v !== 'object') v = { text: v == null ? '' : String(v) };
      if (c.name) {
        const depth = row.depth || 0;
        if (slot.depth !== depth) {
          slot.depth = depth;
          slot.indent.style.width = `${depth * 20}px`;
        }
        const exp = row.expandable ? (row.expanded ? 'open' : 'closed') : 'none';
        if (slot.exp !== exp) {
          slot.exp = exp;
          slot.chev.classList.toggle('hidden', exp === 'none');
          slot.chev.classList.toggle('open', exp === 'open');
        }
        const ik = iconKey(v.icon);
        if (slot.ik !== ik) {
          slot.ik = ik;
          const ni = rowIcon(v.icon);
          slot.ico.replaceWith(ni);
          slot.ico = ni;
        }
      } else {
        const hv = v.heat == null ? '' : String(v.heat);
        if (slot.heat !== hv) {
          slot.heat = hv;
          if (hv === '') delete slot.el.dataset.h;
          else slot.el.dataset.h = hv;
        }
        const ik = v.icon ? iconKey(v.icon) : '';
        if (slot.ik !== ik) {
          slot.ik = ik;
          slot.ico?.remove();
          slot.ico = v.icon ? rowIcon(v.icon) : null;
          if (slot.ico) slot.el.insertBefore(slot.ico, slot.text);
        }
      }
      const text = v.text ?? '';
      if (slot.textValue !== text) {
        slot.textValue = text;
        slot.text.textContent = text;
      }
      const tip = v.tip || '';
      if (slot.tip !== tip) {
        slot.tip = tip;
        if (tip) slot.el.dataset.tip = tip;
        else delete slot.el.dataset.tip;
      }
      const cls = v.cls || '';
      if (slot.cls !== cls) {
        if (slot.cls) slot.el.classList.remove(...slot.cls.split(' '));
        if (cls) slot.el.classList.add(...cls.split(' '));
        slot.cls = cls;
      }
    });
  }

  _build(el, kind) {
    el.textContent = '';
    el._kind = kind;
    el._ver = this.layoutVer;
    el.className = kind === 'group' ? 'tm-row group' : 'tm-row';
    if (kind === 'group') {
      const chev = h('span', { class: 'tm-chev open' }, icon('chevron_right', { size: 12 }));
      const label = h('span', { class: 'tm-glabel ellipsis' });
      el.appendChild(h('div', { class: 'tm-td tm-gcell', role: 'gridcell' }, chev, label));
      el._g = { chev, label };
      return;
    }
    el._cells = this.cols.map((c) => {
      const text = h('span', { class: 'tm-tx ellipsis' });
      if (c.name) {
        const indent = h('span', { class: 'tm-indent' });
        const chev = h('span', { class: 'tm-chev hidden', 'aria-hidden': 'true' }, icon('chevron_right', { size: 12 }));
        const ico = h('span', { class: 'tm-ico' });
        const td = h('div', { class: 'tm-td tm-name', role: 'gridcell' }, indent, chev, ico, text);
        el.appendChild(td);
        return { el: td, text, indent, chev, ico };
      }
      const td = h('div', { class: ['tm-td', c.align === 'end' && 'end', c.heat && 'heat', `c-${c.id}`], role: 'gridcell' }, text);
      el.appendChild(td);
      return { el: td, text, ico: null };
    });
  }

  // ------------------------------------------------------------------ interaction
  _rowFromEvent(e) {
    const el = e.target.closest?.('.tm-row');
    if (!el || !this.body.contains(el)) return null;
    return this.rowByKey(el._key);
  }

  _wire() {
    this.body.addEventListener('pointerdown', (e) => {
      const row = this._rowFromEvent(e);
      if (!row) return;
      if (e.button === 0 && e.target.closest('.tm-chev') && row.expandable) {
        e.preventDefault();
        this.select(row.key, { scroll: false });
        this.o.onToggle?.(row);
        this.focus();
        return;
      }
      if (e.button === 0 || e.button === 2) {
        this.select(row.key, { scroll: false });
        this.focus();
      }
    });
    this.body.addEventListener('dblclick', (e) => {
      const row = this._rowFromEvent(e);
      if (!row || e.target.closest('.tm-chev')) return;
      if (row.kind === 'group' || (row.expandable && !this.o.activateExpandable)) this.o.onToggle?.(row);
      else this.o.onActivate?.(row);
    });
    this.body.addEventListener('contextmenu', (e) => {
      const row = this._rowFromEvent(e);
      e.preventDefault();
      if (!row) return;
      this.select(row.key, { scroll: false });
      this.o.onContext?.(row, e);
    });
    this.el.addEventListener('contextmenu', (e) => {
      if (e.defaultPrevented) return;
      if (this.head.contains(e.target)) {
        e.preventDefault();
        this.o.onHeaderContext?.(e);
      }
    });
    this.head.addEventListener('click', (e) => {
      if (e.target.closest('.tm-rs') || this._resizing) return;
      const th = e.target.closest('.tm-th');
      if (!th || th.classList.contains('nosort')) return;
      this.o.onSort?.(th.dataset.col);
    });
    this.head.addEventListener('pointerdown', (e) => {
      const rs = e.target.closest('.tm-rs');
      if (!rs || e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const col = this.cols.find((c) => c.id === rs.dataset.col);
      if (!col) return;
      const th = rs.parentElement;
      const startX = e.clientX;
      const startW = th.getBoundingClientRect().width;
      rs.setPointerCapture(e.pointerId);
      this._resizing = true;
      this.el.classList.add('resizing');
      const move = (ev) => {
        this.widths[col.id] = Math.max(col.min || 48, Math.round(startW + ev.clientX - startX));
        this._applyWidths();
      };
      const up = () => {
        rs.removeEventListener('pointermove', move);
        rs.removeEventListener('pointerup', up);
        rs.removeEventListener('pointercancel', up);
        this.el.classList.remove('resizing');
        setTimeout(() => (this._resizing = false), 0);
        this.o.onResize?.({ ...this.widths });
      };
      rs.addEventListener('pointermove', move);
      rs.addEventListener('pointerup', up);
      rs.addEventListener('pointercancel', up);
    });
    this.head.addEventListener('dblclick', (e) => {
      const rs = e.target.closest('.tm-rs');
      if (!rs) return;
      // Double-click a divider: back to the default width.
      delete this.widths[rs.dataset.col];
      this._applyWidths();
      this.o.onResize?.({ ...this.widths });
    });
    // Keyboard on column headers: Enter / Space sorts, Shift+F10 / Menu opens the column chooser.
    this.head.addEventListener('keydown', (e) => {
      const th = e.target.closest?.('.tm-th');
      if (!th || e.defaultPrevented) return;
      if ((e.key === 'Enter' || e.key === ' ') && !th.classList.contains('nosort')) {
        e.preventDefault();
        this.o.onSort?.(th.dataset.col);
      } else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
        e.preventDefault();
        const r = th.getBoundingClientRect();
        this.o.onHeaderContext?.({ x: r.left + 8, y: r.bottom });
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        const cells = [...this.head.children];
        const sib = e.key === 'Home' ? cells[0] : e.key === 'End' ? cells[cells.length - 1] : e.key === 'ArrowRight' ? th.nextElementSibling : th.previousElementSibling;
        if (sib) {
          this._rove(sib);
          sib.focus();
        }
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.focus();
      }
    });
    this.head.addEventListener('focusin', (e) => {
      const th = e.target.closest?.('.tm-th');
      if (th) this._rove(th);
    });
    this.el.addEventListener('keydown', (e) => this._key(e));
  }

  _move(delta, abs) {
    const n = this.rows.length;
    if (!n) return;
    let i = this.sel == null ? -1 : this.index.get(this.sel);
    if (abs != null) i = abs;
    else i = i < 0 ? (delta > 0 ? 0 : n - 1) : i + delta;
    i = Math.max(0, Math.min(n - 1, i));
    this.select(this.rows[i].key);
  }

  _key(e) {
    // Keys an open menu already handled (its listener runs first, in the capture phase) are not ours.
    if (e.target !== this.el || e.defaultPrevented) return;
    const row = this.selectedRow();
    const page = Math.max(1, Math.floor(this.scroller.clientHeight / this.rowH) - 1);
    switch (e.key) {
      case 'ArrowDown':
        this._move(1);
        break;
      case 'ArrowUp':
        this._move(-1);
        break;
      case 'PageDown':
        this._move(page);
        break;
      case 'PageUp':
        this._move(-page);
        break;
      case 'Home':
        this._move(0, 0);
        break;
      case 'End':
        this._move(0, this.rows.length - 1);
        break;
      case 'ArrowRight':
        if (row?.expandable && !row.expanded) this.o.onToggle?.(row);
        else if (row?.expandable) this._move(1);
        else return;
        break;
      case 'ArrowLeft': {
        if (!row) return;
        if (row.expandable && row.expanded) this.o.onToggle?.(row);
        else if (row.depth > 0 || row.parentKey) {
          const pk = row.parentKey;
          if (pk && this.index.has(pk)) this.select(pk);
          else {
            for (let i = this.index.get(row.key) - 1; i >= 0; i--) {
              if ((this.rows[i].depth || 0) < (row.depth || 0)) {
                this.select(this.rows[i].key);
                break;
              }
            }
          }
        } else return;
        break;
      }
      case 'Enter':
        if (!row) return;
        if (row.kind === 'group' || (row.expandable && !this.o.activateExpandable)) this.o.onToggle?.(row);
        else this.o.onActivate?.(row);
        break;
      case ' ':
        if (row?.expandable) this.o.onToggle?.(row);
        else return;
        break;
      case 'Delete':
        if (!row) return;
        this.o.onDelete?.(row);
        break;
      case 'ContextMenu':
      case 'F10':
        if (e.key === 'F10' && !e.shiftKey) return;
        if (!row) return;
        {
          const el = this.live.get(row.key);
          const r = el?.getBoundingClientRect();
          this.o.onContext?.(row, r ? { x: r.left + 48, y: r.top + r.height / 2 } : null);
        }
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  }

  destroy() {
    this._ro.disconnect();
    cancelAnimationFrame(this._raf);
  }
}
