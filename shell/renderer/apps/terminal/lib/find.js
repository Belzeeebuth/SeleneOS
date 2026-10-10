// Find in the terminal buffer (Ctrl+Shift+F), Windows Terminal style: a small box at the top right of
// the focused pane with previous/next, "match case", "regular expression" and a match count.
// @xterm/addon-search is not shipped, so this searches the buffer itself: wrapped rows are joined into
// logical lines, matches are mapped back to cells (wide characters, combining marks) and shown with
// xterm decorations; the current match is selected and scrolled into view.
import { mix } from './schemes.js';

const MAX_MATCHES = 2000;
const MAX_DECORATIONS = 400;

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Logical lines of the active buffer: { rows: [y…], text }.
function logicalLines(term) {
  const buf = term.buffer.active;
  const out = [];
  let cur = null;
  for (let y = 0; y < buf.length; y++) {
    const line = buf.getLine(y);
    if (!line) continue;
    const next = buf.getLine(y + 1);
    const text = line.translateToString(!next?.isWrapped);
    if (line.isWrapped && cur) {
      cur.rows.push(y);
      cur.text += text;
    } else {
      cur = { rows: [y], text };
      out.push(cur);
    }
  }
  return out;
}

// String offset -> { row, col } for one logical line (built only for lines that have matches).
function cellMap(term, rows) {
  const buf = term.buffer.active;
  const map = [];
  const cell = buf.getNullCell();
  for (const y of rows) {
    const line = buf.getLine(y);
    const trim = y === rows[rows.length - 1];
    const str = line.translateToString(trim);
    let len = 0;
    for (let x = 0; x < line.length && len < str.length; x++) {
      line.getCell(x, cell);
      const w = cell.getWidth();
      if (w === 0) continue;
      const chars = cell.getChars() || ' ';
      for (let k = 0; k < chars.length; k++) map.push({ row: y, col: x, w });
      len += chars.length;
    }
  }
  return map;
}

export class FindBar {
  constructor(app) {
    this.app = app;
    const { h, icon, t } = app.ctx;
    this.session = null;
    this.matches = [];
    this.index = -1;
    this.decorations = [];
    this.caseSensitive = false;
    this.regex = false;
    this.dirty = false;
    this._timer = 0;
    this._writeOff = null;
    this.input = h('input', {
      class: 'tm-find-input',
      type: 'text',
      spellcheck: false,
      'aria-label': t('find.placeholder'),
      placeholder: t('find.placeholder'),
      oninput: () => this.schedule(),
      onkeydown: (e) => this.onKey(e),
    });
    this.count = h('span', { class: 'tm-find-count', 'aria-live': 'polite' });
    const btn = (cls, ic, tipKey, fn, extra = {}) =>
      h('button', { type: 'button', class: `tm-find-btn ${cls}`, 'data-tip': t(tipKey), 'aria-label': t(tipKey), onclick: fn, ...extra }, icon(ic, { size: 16 }));
    this.prevBtn = btn('tm-find-prev', 'arrow_up', 'find.previous', () => this.step(-1));
    this.nextBtn = btn('tm-find-next', 'arrow_down', 'find.next', () => this.step(1));
    this.caseBtn = btn('tm-find-case', 'text_case_title', 'find.matchCase', () => this.toggle('caseSensitive'), { 'aria-pressed': 'false' });
    this.reBtn = btn('tm-find-re', 'code', 'find.regex', () => this.toggle('regex'), { 'aria-pressed': 'false' });
    this.closeBtn = btn('tm-find-close', 'dismiss', 'find.close', () => this.close());
    this.el = h(
      'div',
      { class: 'tm-find', role: 'search', hidden: true },
      h('div', { class: 'tm-find-field' }, this.input, this.count),
      this.prevBtn,
      this.nextBtn,
      h('span', { class: 'tm-find-sep' }),
      this.caseBtn,
      this.reBtn,
      this.closeBtn,
    );
  }

  get isOpen() {
    return !this.el.hidden;
  }

  relabel() {
    const { t } = this.app.ctx;
    this.input.placeholder = t('find.placeholder');
    this.input.setAttribute('aria-label', t('find.placeholder'));
    for (const [b, k] of [
      [this.prevBtn, 'find.previous'],
      [this.nextBtn, 'find.next'],
      [this.caseBtn, 'find.matchCase'],
      [this.reBtn, 'find.regex'],
      [this.closeBtn, 'find.close'],
    ]) {
      b.dataset.tip = t(k);
      b.setAttribute('aria-label', t(k));
    }
    this.updateCount();
  }

  open(session) {
    if (!session?.term) return;
    if (this.session !== session) this.detach();
    this.session = session;
    session.pane?.appendChild(this.el);
    this.el.hidden = false;
    this.el.classList.remove('closing');
    const sel = session.term.getSelection();
    if (sel && !sel.includes('\n') && sel.length < 200) this.input.value = sel;
    this._writeOff = session.term.onWriteParsed(() => (this.dirty = true));
    this.input.focus();
    this.input.select();
    if (this.input.value) this.run({ keepIndex: false });
    else this.updateCount();
  }

  // The pane the bar lives in went away / another pane got the focus.
  follow(session) {
    if (!this.isOpen || session === this.session) return;
    const q = this.input.value;
    this.open(session);
    this.input.value = q;
    if (q) this.run({ keepIndex: false });
  }

  close({ refocus = true } = {}) {
    if (!this.isOpen) return;
    const s = this.session;
    this.el.hidden = true;
    this.detach();
    if (refocus) s?.focus();
  }

  detach() {
    this.clearDecorations();
    this._writeOff?.dispose();
    this._writeOff = null;
    this.matches = [];
    this.index = -1;
    this.session?.term?.clearSelection();
    this.session = null;
  }

  toggle(key) {
    this[key] = !this[key];
    const b = key === 'regex' ? this.reBtn : this.caseBtn;
    b.classList.toggle('on', this[key]);
    b.setAttribute('aria-pressed', String(this[key]));
    this.run({ keepIndex: false });
    this.input.focus();
  }

  schedule() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.run({ keepIndex: false }), 120);
  }

  onKey(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      this.step(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.close();
    } else if (e.key === 'F3') {
      e.preventDefault();
      this.step(e.shiftKey ? -1 : 1);
    }
  }

  buildRegExp(q) {
    if (!q) return null;
    try {
      return new RegExp(this.regex ? q : escapeRe(q), this.caseSensitive ? 'g' : 'gi');
    } catch {
      return 'invalid';
    }
  }

  run({ keepIndex = true } = {}) {
    clearTimeout(this._timer);
    const term = this.session?.term;
    this.clearDecorations();
    this.matches = [];
    this.dirty = false;
    const re = this.buildRegExp(this.input.value);
    this.el.classList.toggle('invalid', re === 'invalid');
    if (!term || !re || re === 'invalid') {
      this.index = -1;
      term?.clearSelection();
      this.updateCount();
      return;
    }
    for (const ll of logicalLines(term)) {
      re.lastIndex = 0;
      let m;
      let map = null;
      while ((m = re.exec(ll.text))) {
        if (!m[0].length) {
          re.lastIndex++;
          continue;
        }
        map ??= cellMap(term, ll.rows);
        const a = map[m.index];
        const b = map[m.index + m[0].length - 1];
        if (a && b) this.matches.push({ start: a, end: { row: b.row, col: b.col + b.w } });
        if (this.matches.length >= MAX_MATCHES) break;
      }
      if (this.matches.length >= MAX_MATCHES) break;
    }
    if (!this.matches.length) {
      this.index = -1;
      term.clearSelection();
      this.updateCount();
      return;
    }
    if (!keepIndex || this.index < 0 || this.index >= this.matches.length) {
      // Start from the match closest to the bottom of the visible area, searching upwards like WT.
      const buf = term.buffer.active;
      const bottom = buf.viewportY + term.rows;
      let i = this.matches.length - 1;
      while (i > 0 && this.matches[i].start.row >= bottom) i--;
      this.index = i;
    }
    this.decorate();
    this.reveal();
  }

  step(dir) {
    if (!this.session) return;
    if (this.dirty || !this.matches.length) this.run({ keepIndex: true });
    if (!this.matches.length) return;
    this.index = (this.index + dir + this.matches.length) % this.matches.length;
    this.decorate();
    this.reveal();
  }

  reveal() {
    const term = this.session?.term;
    const m = this.matches[this.index];
    if (!term || !m) return;
    const cols = term.cols;
    const len = (m.end.row - m.start.row) * cols + (m.end.col - m.start.col);
    term.select(m.start.col, m.start.row, Math.max(1, len));
    const buf = term.buffer.active;
    if (m.start.row < buf.viewportY || m.start.row >= buf.viewportY + term.rows) {
      term.scrollToLine(Math.max(0, m.start.row - Math.floor(term.rows / 2)));
    }
    this.updateCount();
  }

  decorate() {
    this.clearDecorations();
    const term = this.session?.term;
    if (!term || !this.matches.length) return;
    const scheme = this.app.scheme;
    const c = scheme.colors;
    const all = mix(c.background, c.yellow, scheme.dark ? 0.35 : 0.3);
    const cur = scheme.dark ? '#f2a33a' : '#f5b041';
    const buf = term.buffer.active;
    const cursorAbs = buf.baseY + buf.cursorY;
    // Decorate the matches around the current one (decorations are cheap, not free).
    const half = MAX_DECORATIONS / 2;
    const lo = Math.max(0, this.index - half);
    const hi = Math.min(this.matches.length, lo + MAX_DECORATIONS);
    for (let i = lo; i < hi; i++) {
      const m = this.matches[i];
      const active = i === this.index;
      for (let row = m.start.row; row <= m.end.row; row++) {
        const x = row === m.start.row ? m.start.col : 0;
        const end = row === m.end.row ? m.end.col : term.cols;
        if (end <= x) continue;
        const marker = term.registerMarker(row - cursorAbs);
        if (!marker) continue;
        const d = term.registerDecoration({
          marker,
          x,
          width: end - x,
          backgroundColor: active ? cur : all,
          foregroundColor: active ? '#000000' : undefined,
          layer: 'top',
          overviewRulerOptions: { color: active ? cur : all, position: 'center' },
        });
        if (d) this.decorations.push(d, marker);
        else marker.dispose();
      }
    }
  }

  clearDecorations() {
    for (const d of this.decorations) d.dispose();
    this.decorations = [];
  }

  updateCount() {
    const { t } = this.app.ctx;
    const q = this.input.value;
    let text = '';
    if (q && this.el.classList.contains('invalid')) text = t('find.invalid');
    else if (q && !this.matches.length) text = t('find.none');
    else if (this.matches.length) text = t('find.count', { index: this.index + 1, count: this.matches.length >= MAX_MATCHES ? `${MAX_MATCHES}+` : this.matches.length });
    this.count.textContent = text;
    this.el.classList.toggle('nomatch', !!q && !this.matches.length);
    this.prevBtn.disabled = this.nextBtn.disabled = !this.matches.length;
  }
}
