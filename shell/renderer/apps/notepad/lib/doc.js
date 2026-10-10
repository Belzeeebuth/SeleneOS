// One Notepad document (a tab): its <textarea>, undo history, file metadata, find highlights
// and caret geometry helpers.
//
// Every tab keeps its own textarea (hidden when inactive), so selection, scroll position and
// history survive tab switches. Edits typed by the user are captured with beforeinput/input and
// recorded in History; programmatic edits go through replaceRange() so they are undoable too.
import { History } from './history.js';
import { normalizeEol } from './codec.js';

let seq = 0;
const HL_TEXT_LIMIT = 1_500_000; // above this, all-match highlights are skipped (selection still works)
const HL_MARK_LIMIT = 1500;
const MEASURE_LIMIT = 3_000_000;

export function basename(p) {
  return String(p || '').split('/').filter(Boolean).pop() || String(p || '');
}
export function dirname(p) {
  const s = String(p || '').replace(/\/+$/, '');
  const i = s.lastIndexOf('/');
  return i <= 0 ? '/' : s.slice(0, i);
}

function countNl(text, from, to) {
  let n = 0;
  let i = text.indexOf('\n', from);
  while (i !== -1 && i < to) {
    n++;
    i = text.indexOf('\n', i + 1);
  }
  return n;
}

export class Doc {
  constructor(nw, opts = {}) {
    this.nw = nw;
    this.id = `npd${++seq}`;
    this.path = opts.path || null;
    this.encoding = opts.encoding || 'utf-8';
    this.eol = opts.eol || nw.prefs.defaultEol || 'lf';
    this.mtime = opts.mtime || 0;
    this.size = opts.size || 0;
    this.history = new History();
    this.savedMarker = 0;
    this.metaDirty = false;
    this.forceDirty = false;
    this.notice = null; // { kind: 'changed' | 'deleted' }
    this.scroll = { top: 0, left: 0 };
    this.pending = null;
    this.anchor = null;
    this.hlState = null;
    this.value = '';
    this.build();
    this.setText(opts.text || '');
  }

  get name() {
    return this.path ? basename(this.path) : null;
  }
  get title() {
    return this.name || this.nw.t('untitled');
  }
  get dirty() {
    return this.forceDirty || this.metaDirty || this.history.marker() !== this.savedMarker;
  }
  get pristine() {
    return !this.path && !this.dirty && this.value === '' && !this.history.canUndo && !this.history.canRedo;
  }
  get text() {
    return this.value;
  }

  // ------------------------------------------------------------------ DOM
  build() {
    const { h } = this.nw;
    this.ta = h('textarea', {
      class: 'np-text',
      spellcheck: false,
      autocomplete: 'off',
      autocorrect: 'off',
      autocapitalize: 'off',
      wrap: 'soft',
      'aria-multiline': 'true',
      dataset: { doc: this.id },
    });
    this.hlInner = h('div', { class: 'np-hl-inner' });
    this.hl = h('div', { class: 'np-hl', 'aria-hidden': 'true', hidden: true }, this.hlInner);
    this.measureEl = h('div', { class: 'np-hl-inner np-measure', 'aria-hidden': 'true' });
    this.el = h('div', { class: 'np-doc', hidden: true, dataset: { doc: this.id } }, this.hl, this.ta, this.measureEl);
    const ta = this.ta;
    ta.addEventListener('beforeinput', (e) => {
      if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') {
        e.preventDefault();
        if (e.inputType === 'historyUndo') this.undo();
        else this.redo();
        return;
      }
      this.pending = { s: ta.selectionStart, e: ta.selectionEnd, type: e.inputType };
    });
    ta.addEventListener('input', (e) => this.onInput(e));
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) this._menuKeyAt = Date.now();
      if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
        e.preventDefault();
        this.replaceSelection('\t', { kind: 'type', reveal: !this.nw.prefs.wordWrap });
      }
    });
    ta.addEventListener('scroll', () => {
      this.syncHighlightScroll();
      if (!this.el.hidden) this.scroll = { top: ta.scrollTop, left: ta.scrollLeft };
    });
    const sel = () => this.nw.scheduleStatus();
    for (const ev of ['select', 'selectionchange', 'keyup', 'pointerup', 'focus']) ta.addEventListener(ev, sel);
    ta.addEventListener('pointerdown', () => {
      const move = () => this.nw.scheduleStatus();
      ta.addEventListener('pointermove', move);
      window.addEventListener('pointerup', () => ta.removeEventListener('pointermove', move), { once: true });
    });
    ta.addEventListener('contextmenu', (e) => this.nw.editorMenu(e, this));
  }

  setText(text, { keepHistory = false } = {}) {
    this.ta.value = text;
    this.value = this.ta.value;
    this.anchor = null;
    if (!keepHistory) {
      this.history.clear();
      this.savedMarker = 0;
    }
    this.ta.setSelectionRange(0, 0);
    this.ta.scrollTop = 0;
    this.ta.scrollLeft = 0;
    this.scroll = { top: 0, left: 0 };
  }

  markSaved() {
    this.savedMarker = this.history.marker();
    this.metaDirty = false;
    this.forceDirty = false;
  }

  // ------------------------------------------------------------------ change tracking
  onInput(e) {
    const ta = this.ta;
    const old = this.value;
    const cur = ta.value;
    const p = this.pending;
    this.pending = null;
    if (cur === old) return;
    const after = [ta.selectionStart, ta.selectionEnd];
    const ch = diff(old, cur, p, after);
    this.value = cur;
    if (!ch) return;
    const type = p?.type || e.inputType || '';
    let kind = 'edit';
    if ((type === 'insertText' || type === 'insertCompositionText') && ch.inserted.length <= 4) kind = 'type';
    else if (type === 'deleteContentBackward' && !ch.inserted) kind = 'del-back';
    else if (type === 'deleteContentForward' && !ch.inserted) kind = 'del-fwd';
    this.history.push({ ...ch, selBefore: p ? [p.s, p.e] : after, selAfter: after }, kind, this.savedMarker);
    this.changed(ch.pos);
  }

  changed(pos) {
    if (this.anchor && pos < this.anchor.pos) this.anchor = null;
    this.nw.onDocChanged(this);
  }

  /** Replace [start, end) with text as one undoable step. select: 'end' | 'start' | 'insert' | [s, e] */
  replaceRange(start, end, text, { select = 'end', kind = 'edit', reveal = true } = {}) {
    const ta = this.ta;
    text = normalizeEol(String(text ?? ''));
    const old = this.value;
    start = Math.max(0, Math.min(start, old.length));
    end = Math.max(start, Math.min(end, old.length));
    const removed = old.slice(start, end);
    const selBefore = [ta.selectionStart, ta.selectionEnd];
    let sel;
    if (Array.isArray(select)) sel = select;
    else if (select === 'insert') sel = [start, start + text.length];
    else if (select === 'start') sel = [start, start];
    else sel = [start + text.length, start + text.length];
    if (removed === text) {
      ta.setSelectionRange(sel[0], sel[1]);
      return false;
    }
    ta.setRangeText(text, start, end, 'preserve');
    this.value = ta.value;
    ta.setSelectionRange(sel[0], sel[1]);
    this.history.push({ pos: start, removed, inserted: text, selBefore, selAfter: sel }, kind, this.savedMarker);
    this.changed(start);
    if (reveal) this.reveal(sel[1]);
    return true;
  }

  replaceSelection(text, opts = {}) {
    return this.replaceRange(this.ta.selectionStart, this.ta.selectionEnd, text, opts);
  }

  undo() {
    const s = this.history.undo();
    if (!s) return false;
    this._apply(s.pos, s.pos + s.inserted.length, s.removed, s.selBefore);
    return true;
  }
  redo() {
    const s = this.history.redo();
    if (!s) return false;
    this._apply(s.pos, s.pos + s.removed.length, s.inserted, s.selAfter);
    return true;
  }
  _apply(start, end, text, sel) {
    const ta = this.ta;
    ta.setRangeText(text, start, end, 'preserve');
    this.value = ta.value;
    const len = this.value.length;
    ta.setSelectionRange(Math.min(sel[0], len), Math.min(sel[1], len));
    this.changed(start);
    this.reveal(ta.selectionEnd);
  }

  // ------------------------------------------------------------------ positions
  lineCol(pos) {
    const text = this.value;
    pos = Math.max(0, Math.min(pos, text.length));
    let a = this.anchor;
    if (!a || a.pos > text.length) a = { pos: 0, line: 1 };
    const line = pos >= a.pos ? a.line + countNl(text, a.pos, pos) : a.line - countNl(text, pos, a.pos);
    this.anchor = { pos, line };
    const ls = text.lastIndexOf('\n', pos - 1) + 1;
    return { line, col: pos - ls + 1 };
  }
  lineCount() {
    return countNl(this.value, 0, this.value.length) + 1;
  }
  lineStart(n) {
    const text = this.value;
    let i = 0;
    for (let k = 1; k < n; k++) {
      const j = text.indexOf('\n', i);
      if (j === -1) return text.length;
      i = j + 1;
    }
    return i;
  }

  metrics() {
    const cs = getComputedStyle(this.ta);
    const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.35 || 20;
    return { lh, padTop: parseFloat(cs.paddingTop) || 0, padLeft: parseFloat(cs.paddingLeft) || 0 };
  }

  /** Caret geometry in content coordinates (independent of scrolling). */
  coords(pos) {
    const ta = this.ta;
    const { lh, padTop, padLeft } = this.metrics();
    const text = this.value;
    const wrap = this.nw.prefs.wordWrap;
    const m = this.measureEl;
    if (!wrap) {
      const { line, col } = this.lineCol(pos);
      const ls = pos - col + 1;
      m.style.width = 'max-content';
      const span = document.createElement('span');
      span.textContent = text.slice(ls, pos);
      m.replaceChildren(span);
      const left = padLeft + span.getBoundingClientRect().width;
      m.textContent = '';
      return { top: padTop + (line - 1) * lh, left, height: lh };
    }
    if (text.length > MEASURE_LIMIT) {
      const ratio = text.length ? pos / text.length : 0;
      return { top: Math.max(0, ratio * ta.scrollHeight - lh), left: padLeft, height: lh };
    }
    m.style.width = `${ta.clientWidth}px`;
    m.textContent = text.slice(0, pos);
    const mark = document.createElement('span');
    mark.textContent = '​';
    m.appendChild(mark);
    const r = { top: mark.offsetTop, left: mark.offsetLeft, height: mark.offsetHeight || lh };
    m.textContent = '';
    return r;
  }

  /** Scroll so that pos is visible (center: put it in the middle third like Windows' Find). */
  reveal(pos = this.ta.selectionEnd, { center = false } = {}) {
    const ta = this.ta;
    if (this.el.hidden || !ta.clientHeight) return;
    const c = this.coords(pos);
    const { lh } = this.metrics();
    const top = ta.scrollTop;
    const hgt = ta.clientHeight;
    if (c.top < top || c.top + c.height > top + hgt) {
      ta.scrollTop = center ? Math.max(0, c.top - hgt / 3) : c.top < top ? Math.max(0, c.top - lh) : c.top + c.height - hgt + lh;
    }
    if (!this.nw.prefs.wordWrap) {
      const left = ta.scrollLeft;
      const w = ta.clientWidth;
      if (c.left < left + 8 || c.left > left + w - 24) ta.scrollLeft = Math.max(0, c.left - w / 2);
    }
  }

  focus() {
    try {
      this.ta.focus({ preventScroll: true });
    } catch {}
  }

  // ------------------------------------------------------------------ find highlights (mirror behind the textarea)
  setHighlights(matches, current) {
    this.hlState = matches && matches.length ? { matches, current } : null;
    this.renderHighlights();
  }
  clearHighlights() {
    if (!this.hlState && this.hl.hidden) return;
    this.hlState = null;
    this.renderHighlights();
  }
  renderHighlights() {
    const st = this.hlState;
    const text = this.value;
    if (!st || text.length > HL_TEXT_LIMIT || this.el.hidden) {
      this.hl.hidden = true;
      this.hlInner.textContent = '';
      return;
    }
    const { matches, current } = st;
    let from = 0;
    let to = matches.length;
    if (matches.length > HL_MARK_LIMIT) {
      const c = current >= 0 ? current : 0;
      from = Math.max(0, c - HL_MARK_LIMIT / 2);
      to = Math.min(matches.length, from + HL_MARK_LIMIT);
    }
    const frag = document.createDocumentFragment();
    let pos = 0;
    for (let i = from; i < to; i++) {
      const [s, e] = matches[i];
      if (s < pos || e > text.length) continue;
      if (s > pos) frag.appendChild(document.createTextNode(text.slice(pos, s)));
      const mk = document.createElement('mark');
      mk.className = i === current ? 'np-m cur' : 'np-m';
      mk.textContent = text.slice(s, e);
      frag.appendChild(mk);
      pos = e;
    }
    frag.appendChild(document.createTextNode(`${text.slice(pos)}​`));
    this.hlInner.replaceChildren(frag);
    this.hlInner.style.width = this.nw.prefs.wordWrap ? `${this.ta.clientWidth}px` : 'max-content';
    this.hlInner.style.minWidth = `${this.ta.clientWidth}px`;
    this.hl.hidden = false;
    this.syncHighlightScroll();
  }
  syncHighlightScroll() {
    if (this.hl.hidden) return;
    this.hlInner.style.transform = `translate(${-this.ta.scrollLeft}px, ${-this.ta.scrollTop}px)`;
  }

  // ------------------------------------------------------------------ show / hide
  show() {
    this.el.hidden = false;
    this.ta.scrollTop = this.scroll.top;
    this.ta.scrollLeft = this.scroll.left;
    if (this.hlState) this.renderHighlights();
  }
  hide() {
    if (!this.el.hidden) this.scroll = { top: this.ta.scrollTop, left: this.ta.scrollLeft };
    this.el.hidden = true;
  }
  destroy() {
    this.el.remove();
  }
}

// Describe the edit that turned `old` into `cur` as { pos, removed, inserted }.
// Fast path from the selection before/after the edit; full prefix/suffix diff as a fallback.
function diff(old, cur, before, after) {
  const delta = cur.length - old.length;
  if (before) {
    const p = Math.min(before.s, after[0]);
    const i = after[1] - p;
    const r = i - delta;
    if (p >= 0 && i >= 0 && r >= 0 && p + r <= old.length && p + i <= cur.length) {
      const k = Math.min(256, p);
      const okPrefix = old.substr(p - k, k) === cur.substr(p - k, k);
      const okSuffix = old.substr(p + r, 256) === cur.substr(p + i, 256);
      if (okPrefix && okSuffix) return { pos: p, removed: old.substr(p, r), inserted: cur.substr(p, i) };
    }
  }
  const m = Math.min(old.length, cur.length);
  let a = 0;
  while (a < m && old.charCodeAt(a) === cur.charCodeAt(a)) a++;
  let b = 0;
  while (b < m - a && old.charCodeAt(old.length - 1 - b) === cur.charCodeAt(cur.length - 1 - b)) b++;
  return { pos: a, removed: old.slice(a, old.length - b), inserted: cur.slice(a, cur.length - b) };
}
