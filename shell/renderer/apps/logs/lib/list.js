// Virtualised list of journal entries (a grid: time, level, source, message), newest first.
//
//   const list = new LogList({ h, icon, label, rowHeight, columns: [{ id, label: () => str, width | flex, fit: () => [str] }],
//                              cell(entry, colId) -> { text, icon, iconFilled, cls, tip },
//                              onSelect(entry|null), onActivate(entry), onContext(entry, point|null), onCopy(entry),
//                              onNearEnd() });
//   list.setEntries(entries, { keep })   list.prepend(newer) -> added   list.append(older)
//   list.select(cursor, { scroll })      list.selected()   list.entries   list.setAnchor(cursor)   list.relabel()
//
// Only the rows in view (+ a few above and below) exist in the DOM; they are recycled while scrolling, and a cell is
// only written when its text changed, so tens of thousands of entries scroll smoothly. Keyboard: arrows, Page Up /
// Down, Home / End move the selection; Enter activates; Shift+F10 / Menu opens the context menu; Ctrl+C copies.
const OVERSCAN = 8;
let seq = 0;

export class LogList {
  constructor(o) {
    this.o = o;
    this.h = o.h;
    this.icon = o.icon;
    this.rowH = o.rowHeight || 28;
    this.entries = [];
    this.index = new Map();
    this.sel = null;
    this.anchor = null;
    this.live = new Map();
    this.spare = [];
    this.fresh = new Map(); // cursor -> time it arrived (live view highlight)
    this.id = `lgl${++seq}`;
    const { h } = this;
    this.el = h('div', { class: 'lg-list', role: 'grid', tabindex: '0', 'aria-label': o.label || '', 'aria-rowcount': '0', 'aria-colcount': String(o.columns.length) });
    this.head = h('div', { class: 'lg-head', role: 'row', 'aria-rowindex': '1' });
    this.headWrap = h('div', { class: 'lg-head-wrap', role: 'rowgroup' }, this.head);
    this.body = h('div', { class: 'lg-body', role: 'rowgroup' });
    this.scroller = h('div', { class: 'lg-scroll', tabindex: '-1' }, this.body);
    this.el.append(this.headWrap, this.scroller);
    this.scroller.addEventListener('focus', () => this.focus());
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
    this.setColumns(o.columns);
    this._wire();
  }

  // ------------------------------------------------------------------ columns
  setColumns(cols) {
    this.cols = cols;
    this.head.textContent = '';
    for (const c of cols) this.head.appendChild(this.h('div', { class: ['lg-th', `c-${c.id}`], role: 'columnheader' }, this.h('span', { class: 'ellipsis' }, c.label())));
    for (const el of [...this.live.values(), ...this.spare]) el.remove();
    this.live.clear();
    this.spare = [];
    this._layout();
    this._queue();
  }
  relabel() {
    [...this.head.children].forEach((th, i) => (th.firstChild.textContent = this.cols[i].label()));
    this.el.setAttribute('aria-label', this.o.label || '');
    this._layout();
    this._render(true);
  }
  _layout() {
    // Fixed columns as wide as their longest word (French labels are longer), the message takes the rest.
    const ctx = (LogList._measure ||= document.createElement('canvas').getContext('2d'));
    const style = getComputedStyle(this.el.isConnected ? this.el : document.body);
    let total = 0;
    const tpl = this.cols.map((c) => {
      if (c.flex) {
        total += c.min || 160;
        return `minmax(${c.min || 160}px, 1fr)`;
      }
      ctx.font = `700 13px ${style.fontFamily}`; // the most serious levels are bold
      const words = [c.label(), ...(c.fit?.() || [])];
      const w = Math.min(c.max || 400, Math.max(c.width || 80, ...words.map((x) => Math.ceil(ctx.measureText(String(x)).width) + 20 + (c.iconPad || 0))));
      total += w;
      return `${w}px`;
    });
    this.el.style.setProperty('--lg-cols', tpl.join(' '));
    // Narrower than this, the list scrolls sideways (the header follows).
    this.el.style.setProperty('--lg-minw', `${total}px`);
    this._laidOut = this.el.isConnected;
  }

  // ------------------------------------------------------------------ data
  _reindex() {
    this.index = new Map();
    this.entries.forEach((e, i) => this.index.set(e.cursor, i));
    this.el.setAttribute('aria-rowcount', String(this.entries.length + 1));
  }
  /** New content. keep: false (a new search) starts at the top with nothing selected; true keeps both. */
  setEntries(entries, { keep = false } = {}) {
    const prevSel = this.sel;
    this.entries = entries;
    this._reindex();
    if (!keep) this.scroller.scrollTop = 0;
    if (prevSel != null && (!keep || !this.index.has(prevSel))) {
      this.sel = null;
      this.el.removeAttribute('aria-activedescendant');
      this.o.onSelect?.(null);
    }
    this._render(true);
  }
  /** Newer entries (newest first) go on top. The rows the person is reading stay where they are. */
  prepend(newer) {
    const add = newer.filter((e) => e.cursor && !this.index.has(e.cursor));
    if (!add.length) return 0;
    const atTop = this.scroller.scrollTop < this.rowH / 2;
    this.entries = add.concat(this.entries);
    this._reindex();
    const now = performance.now();
    for (const e of add) this.fresh.set(e.cursor, now);
    if (!atTop) this.scroller.scrollTop += add.length * this.rowH;
    this._render(true);
    clearTimeout(this._freshTimer);
    this._freshTimer = setTimeout(() => this._render(), 1600);
    return add.length;
  }
  append(older) {
    const add = older.filter((e) => e.cursor && !this.index.has(e.cursor));
    this.entries = this.entries.concat(add);
    this._reindex();
    this._render(true);
    return add.length;
  }
  /** Keep at most n entries (drops the oldest, at the bottom). */
  trim(n) {
    if (this.entries.length <= n) return false;
    this.entries = this.entries.slice(0, n);
    this._reindex();
    if (this.sel != null && !this.index.has(this.sel)) this.select(null);
    this._render(true);
    return true;
  }
  selected() {
    return this.sel == null ? null : this.entries[this.index.get(this.sel)] || null;
  }
  select(cursor, { scroll = true, silent = false } = {}) {
    if (cursor != null && !this.index.has(cursor)) return false;
    const changed = cursor !== this.sel;
    this.sel = cursor;
    for (const [k, el] of this.live) {
      const on = k === cursor;
      if (el._sel === on) continue;
      el._sel = on;
      el.classList.toggle('sel', on);
      el.setAttribute('aria-selected', String(on));
    }
    if (cursor != null) {
      this.el.setAttribute('aria-activedescendant', `${this.id}-${this.index.get(cursor)}`);
      if (scroll) this.scrollTo(this.index.get(cursor));
    } else this.el.removeAttribute('aria-activedescendant');
    if (changed && !silent) this.o.onSelect?.(this.selected());
    return true;
  }
  setAnchor(cursor) {
    this.anchor = cursor;
    this._render(true);
  }
  scrollTo(i, center = false) {
    const sc = this.scroller;
    const top = i * this.rowH;
    if (center) sc.scrollTop = Math.max(0, top - (sc.clientHeight - this.rowH) / 2);
    else if (top < sc.scrollTop) sc.scrollTop = top;
    else if (top + this.rowH > sc.scrollTop + sc.clientHeight) sc.scrollTop = top + this.rowH - sc.clientHeight;
    this._render();
  }
  focus() {
    this.el.focus({ preventScroll: true });
  }
  /** Rows currently in the DOM (tests). */
  domRows() {
    return this.body.children.length;
  }

  // ------------------------------------------------------------------ render
  _queue() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this._render();
    });
  }
  _render(force = false) {
    if (!this._laidOut && this.el.isConnected) this._layout();
    const n = this.entries.length;
    this.body.style.height = `${n * this.rowH}px`;
    const sc = this.scroller;
    const gutter = sc.offsetWidth - sc.clientWidth;
    if (this._gutter !== gutter) {
      this._gutter = gutter;
      this.head.style.paddingRight = `${gutter}px`;
    }
    const top = sc.scrollTop;
    const vh = Math.max(sc.clientHeight, this.rowH * 12);
    const first = Math.max(0, Math.floor(top / this.rowH) - OVERSCAN);
    const last = Math.min(n, Math.ceil((top + vh) / this.rowH) + OVERSCAN);
    const want = new Set();
    for (let i = first; i < last; i++) want.add(this.entries[i].cursor);
    for (const [k, el] of this.live) {
      if (!want.has(k)) {
        this.live.delete(k);
        el._key = null;
        el.hidden = true;
        this.spare.push(el);
      }
    }
    const now = performance.now();
    for (let i = first; i < last; i++) {
      const e = this.entries[i];
      let el = this.live.get(e.cursor);
      if (!el) {
        el = this.spare.pop() || this._build();
        el._key = e.cursor;
        el._entry = null;
        this.live.set(e.cursor, el);
      }
      this._fill(el, e, i, force, now);
    }
    while (this.spare.length > 32) this.spare.pop().remove();
    if (this.fresh.size) for (const [k, t] of this.fresh) if (now - t > 1500) this.fresh.delete(k);
    if (this.o.onNearEnd && n && last >= n - 4 && n * this.rowH > sc.clientHeight - this.rowH) this.o.onNearEnd();
  }
  _build() {
    // As few elements as possible per row (each one costs style and layout work when a row is reused): a cell is
    // one block with a text node (ellipsis on the cell), plus the level icon.
    const { h } = this;
    const el = h('div', { class: 'lg-row', role: 'row', 'aria-selected': 'false' });
    el._cells = this.cols.map((c) => {
      const text = document.createTextNode('');
      const td = h('div', { class: ['lg-td', `c-${c.id}`], role: 'gridcell' }, text);
      el.appendChild(td);
      return { td, text, ico: null, ik: '', cls: '', val: null };
    });
    this.body.appendChild(el);
    return el;
  }
  _fill(el, e, i, force, now) {
    el.hidden = false;
    const y = i * this.rowH;
    if (el._y !== y) {
      el._y = y;
      el.style.transform = `translateY(${y}px)`;
    }
    const id = `${this.id}-${i}`;
    if (el.id !== id) {
      el.id = id;
      el.setAttribute('aria-rowindex', String(i + 2));
    }
    const sel = e.cursor === this.sel;
    if (el._sel !== sel) {
      el._sel = sel;
      el.classList.toggle('sel', sel);
      el.setAttribute('aria-selected', String(sel));
    }
    const anchor = e.cursor === this.anchor;
    if (el._anchor !== anchor) {
      el._anchor = anchor;
      el.classList.toggle('anchor', anchor);
    }
    const fresh = this.fresh.has(e.cursor) && now - this.fresh.get(e.cursor) < 1500;
    if (el._fresh !== fresh) {
      el._fresh = fresh;
      el.classList.toggle('fresh', fresh);
    }
    if (el._entry === e && !force) return;
    el._entry = e;
    const tone = this.o.rowClass?.(e) || '';
    if (el._tone !== tone) {
      if (el._tone) el.classList.remove(el._tone);
      if (tone) el.classList.add(tone);
      el._tone = tone;
    }
    this.cols.forEach((c, ci) => {
      const slot = el._cells[ci];
      let v = this.o.cell(e, c.id);
      if (v == null || typeof v !== 'object') v = { text: v == null ? '' : String(v) };
      const ik = v.icon ? `${v.icon}|${v.iconFilled ? 1 : 0}` : '';
      if (slot.ik !== ik) {
        slot.ik = ik;
        slot.ico?.remove();
        slot.ico = v.icon ? this.icon(v.icon, { size: 16, filled: !!v.iconFilled, class: 'lg-ico' }) : null;
        if (slot.ico) slot.td.insertBefore(slot.ico, slot.text);
      }
      if (slot.val !== v.text) {
        slot.val = v.text;
        slot.text.data = v.text;
      }
      const cls = v.cls || '';
      if (slot.cls !== cls) {
        if (slot.cls) slot.td.classList.remove(...slot.cls.split(' '));
        if (cls) slot.td.classList.add(...cls.split(' '));
        slot.cls = cls;
      }
    });
  }

  // ------------------------------------------------------------------ interaction
  _entryFrom(ev) {
    const row = ev.target.closest?.('.lg-row');
    if (!row || !this.body.contains(row) || row._key == null) return null;
    return this.entries[this.index.get(row._key)] || null;
  }
  _wire() {
    this.body.addEventListener('pointerdown', (ev) => {
      const e = this._entryFrom(ev);
      if (!e || (ev.button !== 0 && ev.button !== 2)) return;
      this.select(e.cursor, { scroll: false });
      this.focus();
    });
    this.body.addEventListener('dblclick', (ev) => {
      const e = this._entryFrom(ev);
      if (e) this.o.onActivate?.(e);
    });
    this.body.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      const e = this._entryFrom(ev);
      if (!e) return;
      this.select(e.cursor, { scroll: false });
      this.o.onContext?.(e, ev);
    });
    this.el.addEventListener('keydown', (ev) => this._key(ev));
  }
  _move(delta, abs) {
    const n = this.entries.length;
    if (!n) return;
    let i = this.sel == null ? -1 : this.index.get(this.sel);
    if (abs != null) i = abs;
    else i = i < 0 ? 0 : i + delta;
    i = Math.max(0, Math.min(n - 1, i));
    this.select(this.entries[i].cursor);
  }
  _key(ev) {
    if (ev.target !== this.el || ev.defaultPrevented) return;
    const page = Math.max(1, Math.floor(this.scroller.clientHeight / this.rowH) - 1);
    const e = this.selected();
    const mod = ev.ctrlKey || ev.metaKey;
    if (mod && (ev.key === 'c' || ev.key === 'C')) {
      if (e) this.o.onCopy?.(e);
    } else if (ev.key === 'ArrowDown') this._move(1);
    else if (ev.key === 'ArrowUp') this._move(-1);
    else if (ev.key === 'PageDown') this._move(page);
    else if (ev.key === 'PageUp') this._move(-page);
    else if (ev.key === 'Home') this._move(0, 0);
    else if (ev.key === 'End') this._move(0, this.entries.length - 1);
    else if (ev.key === 'Enter' && e) this.o.onActivate?.(e);
    else if ((ev.key === 'ContextMenu' || (ev.key === 'F10' && ev.shiftKey)) && e) {
      const r = this.live.get(e.cursor)?.getBoundingClientRect();
      this.o.onContext?.(e, r ? { x: r.left + 120, y: r.top + r.height / 2 } : null);
    } else return;
    ev.preventDefault();
    ev.stopPropagation();
  }
  destroy() {
    this._ro.disconnect();
    cancelAnimationFrame(this._raf);
    clearTimeout(this._freshTimer);
  }
}
