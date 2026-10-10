// Find / Replace bar (Windows 11 Notepad style): an inline bar at the top of the editor with a
// replace toggle, the "3 of 12" counter, next / previous, search options (match case, whole word,
// wrap around), replace and replace all. Matches are highlighted behind the text (Doc.setHighlights)
// and the current one is selected and scrolled into view.

const MAX_MATCHES = 20000;

function escapeRe(s) {
  return s.replace(/[\^$\\.*+?()[\]{}|/]/g, '\\$&');
}

export class FindBar {
  constructor(nw) {
    this.nw = nw;
    this.query = '';
    this.replacement = '';
    this.isOpen = false;
    this.replaceMode = false;
    this.matches = [];
    this.truncated = false;
    this.current = -1;
    this.anchor = 0;
    this.statusTimer = null;
    this.build();
  }

  get prefs() {
    return this.nw.prefs;
  }
  get doc() {
    return this.nw.active;
  }

  build() {
    const { h, icon, t } = this.nw;
    const iconBtn = (ic, cls, onclick, size = 16) => h('button', { type: 'button', class: ['btn', 'subtle', 'icon-btn', 'np-find-btn', cls], onclick }, icon(ic, { size }));
    this.toggleBtn = iconBtn('chevron_right', 'np-find-toggle', () => this.setReplaceMode(!this.replaceMode, { focus: true }));
    this.input = h('input', { class: 'input np-find-input', type: 'text', spellcheck: false, autocomplete: 'off' });
    this.count = h('span', { class: 'np-find-count', 'aria-live': 'polite' });
    this.field = h('div', { class: 'np-find-field' }, this.input, this.count);
    this.nextBtn = iconBtn('arrow_down', 'np-find-next', () => this.next(1, { focusInput: false }));
    this.prevBtn = iconBtn('arrow_up', 'np-find-prev', () => this.next(-1, { focusInput: false }));
    this.optBtn = h(
      'button',
      { type: 'button', class: 'btn subtle np-find-btn np-find-opts', 'aria-haspopup': 'menu', onclick: (e) => this.optionsMenu(e) },
      icon('settings', { size: 16 }),
      icon('chevron_down', { size: 10 }),
    );
    this.closeBtn = iconBtn('dismiss', 'np-find-close', () => this.close());
    this.rinput = h('input', { class: 'input np-replace-input', type: 'text', spellcheck: false, autocomplete: 'off' });
    this.replaceBtn = h('button', { type: 'button', class: 'btn np-replace-one', onclick: () => this.replaceOne() });
    this.replaceAllBtn = h('button', { type: 'button', class: 'btn np-replace-all', onclick: () => this.replaceAll() });
    this.status = h('span', { class: 'np-find-status caption', 'aria-live': 'polite' });
    this.row2 = h('div', { class: 'np-find-row np-find-row2', hidden: true }, h('span', { class: 'np-find-spacer' }), h('div', { class: 'np-find-field' }, this.rinput), this.replaceBtn, this.replaceAllBtn);
    this.el = h(
      'div',
      { class: 'np-find', role: 'search', hidden: true },
      h('div', { class: 'np-find-row' }, this.toggleBtn, this.field, this.nextBtn, this.prevBtn, this.optBtn, this.status, h('span', { class: 'grow' }), this.closeBtn),
      this.row2,
    );
    this.input.addEventListener('input', () => {
      this.query = this.input.value;
      this.search({ select: true, fromAnchor: true });
    });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.next(e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      }
    });
    this.rinput.addEventListener('input', () => {
      this.replacement = this.rinput.value;
    });
    this.rinput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.ctrlKey && e.altKey) this.replaceAll();
        else this.replaceOne();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      }
    });
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      }
    });
    this.relabel();
  }

  relabel() {
    const { t } = this.nw;
    this.input.placeholder = t('find.find');
    this.input.setAttribute('aria-label', t('find.find'));
    this.rinput.placeholder = t('find.replace');
    this.rinput.setAttribute('aria-label', t('find.replace'));
    const tip = (el, label, key) => {
      el.dataset.tip = key ? `${label} (${key})` : label;
      el.setAttribute('aria-label', label);
    };
    tip(this.toggleBtn, t('find.toggleReplace'));
    tip(this.nextBtn, t('edit.findNext'), 'F3');
    tip(this.prevBtn, t('edit.findPrev'), 'Shift+F3');
    tip(this.optBtn, t('find.options'));
    tip(this.closeBtn, t('find.close'), 'Esc');
    this.replaceBtn.textContent = t('find.replaceOne');
    this.replaceAllBtn.textContent = t('find.replaceAll');
    this.updateCount();
  }

  // ------------------------------------------------------------------ open / close
  open({ replace = false } = {}) {
    const doc = this.doc;
    const wasOpen = this.isOpen;
    this.isOpen = true;
    this.el.hidden = false;
    if (!wasOpen && document.documentElement.dataset.animations !== 'off') {
      this.el.animate([{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'none' }], { duration: 167, easing: 'cubic-bezier(0.1, 0.9, 0.2, 1)' });
    }
    this.setReplaceMode(!!replace);
    // Seed with the selection (single line), like Windows.
    if (doc) {
      const s = doc.ta.selectionStart;
      const e = doc.ta.selectionEnd;
      const sel = doc.text.slice(s, e);
      if (sel && sel.length < 256 && !sel.includes('\n')) {
        this.input.value = sel;
        this.query = sel;
      }
      this.anchor = s;
    }
    this.input.focus();
    this.input.select();
    this.search({ select: false });
    this.nw.layoutChanged();
  }

  setReplaceMode(on, { focus = false } = {}) {
    this.replaceMode = !!on;
    this.row2.hidden = !this.replaceMode;
    this.el.classList.toggle('replace', this.replaceMode);
    this.toggleBtn.replaceChildren(this.nw.icon(this.replaceMode ? 'chevron_down' : 'chevron_right', { size: 16 }));
    this.toggleBtn.setAttribute('aria-expanded', String(this.replaceMode));
    if (focus) (this.replaceMode ? this.rinput : this.input).focus();
    this.nw.layoutChanged();
  }

  close({ focusEditor = true } = {}) {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.el.hidden = true;
    for (const d of this.nw.docs) d.clearHighlights();
    this.setStatus('');
    this.nw.layoutChanged();
    if (focusEditor) this.doc?.focus();
  }

  // ------------------------------------------------------------------ searching
  regex() {
    if (!this.query) return null;
    const flags = `g${this.prefs.matchCase ? '' : 'i'}u`;
    let src = escapeRe(this.query);
    if (this.prefs.wholeWord) src = `(?<![\\p{L}\\p{N}_])${src}(?![\\p{L}\\p{N}_])`;
    try {
      return new RegExp(src, flags);
    } catch {
      return null;
    }
  }

  /** Recompute the match list for the active document. */
  search({ select = false, fromAnchor = false } = {}) {
    const doc = this.doc;
    this.matchesStale = false;
    this.matches = [];
    this.truncated = false;
    this.current = -1;
    const re = this.regex();
    if (doc && re) {
      const text = doc.text;
      let m;
      while ((m = re.exec(text))) {
        if (m[0] === '') {
          re.lastIndex++;
          continue;
        }
        if (this.matches.length >= MAX_MATCHES) {
          this.truncated = true;
          break;
        }
        this.matches.push([m.index, m.index + m[0].length]);
      }
      const s = doc.ta.selectionStart;
      const e = doc.ta.selectionEnd;
      this.current = this.matches.findIndex(([a, b]) => a === s && b === e);
      if (select && this.matches.length) {
        const from = fromAnchor ? this.anchor : s;
        let i = this.matches.findIndex(([a]) => a >= from);
        if (i < 0 && this.prefs.wrapAround) i = 0;
        if (i >= 0) this.selectMatch(i);
      }
    }
    this.paint();
  }

  /** Called when the document text changed while the bar is open (debounced by the window). */
  refresh() {
    if (!this.isOpen) return;
    this.search({ select: false });
  }

  paint() {
    this.updateCount();
    const doc = this.doc;
    if (!doc) return;
    if (this.isOpen && this.query) doc.setHighlights(this.matches, this.current);
    else doc.clearHighlights();
  }

  updateCount() {
    const { t } = this.nw;
    const n = this.matches.length;
    const none = !!this.query && n === 0;
    this.field.classList.toggle('none', none);
    this.input.classList.toggle('invalid', none);
    let text = '';
    if (!this.query) text = '';
    else if (!n) text = t('find.none');
    else if (this.current >= 0) text = t('find.count', { index: this.nw.fmt(this.current + 1), total: `${this.nw.fmt(n)}${this.truncated ? '+' : ''}` });
    else text = t('find.total', { count: n, n: `${this.nw.fmt(n)}${this.truncated ? '+' : ''}` });
    this.count.textContent = text;
  }

  selectMatch(i, { reveal = true } = {}) {
    const doc = this.doc;
    const m = this.matches[i];
    if (!doc || !m) return;
    this.current = i;
    doc.ta.setSelectionRange(m[0], m[1]);
    if (reveal) doc.reveal(m[0], { center: true });
    this.paint();
    this.nw.scheduleStatus();
  }

  /** Find next (dir 1) / previous (dir -1) from the current selection. */
  next(dir = 1, { focusInput = true } = {}) {
    const doc = this.doc;
    if (!doc) return false;
    if (!this.query) {
      this.open();
      return false;
    }
    if (!this.isOpen || this.matchesStale || !this.matches.length) this.search({ select: false });
    const n = this.matches.length;
    if (!n) {
      this.setStatus(this.nw.t('find.notFound', { q: this.query }));
      this.nw.ctx.shell.sounds?.play?.('notify');
      return false;
    }
    const s = doc.ta.selectionStart;
    const e = doc.ta.selectionEnd;
    let i;
    if (dir > 0) {
      // From the end of the current match, otherwise from the caret / selection start.
      const onMatch = this.matches.some(([a, b]) => a === s && b === e);
      const from = onMatch ? e : s;
      i = this.matches.findIndex(([a]) => a >= from && !(onMatch && a === s));
    } else {
      i = -1;
      for (let k = n - 1; k >= 0; k--) {
        if (this.matches[k][0] < s) {
          i = k;
          break;
        }
      }
    }
    let wrapped = false;
    if (i < 0) {
      if (!this.prefs.wrapAround) {
        this.setStatus(this.nw.t('find.endReached'));
        return false;
      }
      i = dir > 0 ? 0 : n - 1;
      wrapped = true;
    }
    this.selectMatch(i);
    this.setStatus(wrapped ? this.nw.t('find.wrapped') : '');
    if (this.isOpen && focusInput && !this.el.contains(document.activeElement)) this.input.focus();
    return true;
  }

  replaceOne() {
    const doc = this.doc;
    if (!doc || !this.query) return;
    this.search({ select: false });
    const s = doc.ta.selectionStart;
    const e = doc.ta.selectionEnd;
    const hit = this.matches.findIndex(([a, b]) => a === s && b === e);
    if (hit < 0) {
      this.next(1);
      return;
    }
    const rep = this.rinput.value;
    doc.replaceRange(s, e, rep, { select: [s + rep.length, s + rep.length], reveal: false });
    this.search({ select: false });
    const i = this.matches.findIndex(([a]) => a >= s + rep.length);
    if (i >= 0) this.selectMatch(i);
    else if (this.prefs.wrapAround && this.matches.length) this.selectMatch(0);
    else this.paint();
  }

  replaceAll() {
    const doc = this.doc;
    if (!doc || !this.query) return 0;
    const re = this.regex();
    if (!re) return 0;
    const text = doc.text;
    const rep = this.rinput.value;
    const parts = [];
    let pos = 0;
    let first = -1;
    let last = -1;
    let count = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m[0] === '') {
        re.lastIndex++;
        continue;
      }
      if (first < 0) first = m.index;
      parts.push(text.slice(pos, m.index), rep);
      pos = m.index + m[0].length;
      last = pos;
      count++;
    }
    if (!count) {
      this.setStatus(this.nw.t('find.notFound', { q: this.query }));
      return 0;
    }
    parts.push(text.slice(pos, last));
    const middle = parts.join('').slice(first);
    const caret = Math.min(doc.ta.selectionStart, first);
    doc.replaceRange(first, last, middle, { select: [caret, caret], reveal: false });
    this.search({ select: false });
    this.setStatus(this.nw.t('find.replaced', { count, n: this.nw.fmt(count) }), 6000);
    return count;
  }

  setStatus(text, ms = 4000) {
    clearTimeout(this.statusTimer);
    this.status.textContent = text || '';
    if (text) this.statusTimer = setTimeout(() => (this.status.textContent = ''), ms);
  }

  optionsMenu(e) {
    const { t } = this.nw;
    const p = this.prefs;
    const toggle = (key) => () => {
      this.nw.shared.setPref(key, !this.prefs[key]);
      this.search({ select: false });
    };
    this.nw.menus.popup(e.currentTarget, [
      { label: t('find.matchCase'), checked: !!p.matchCase, action: toggle('matchCase') },
      { label: t('find.wholeWord'), checked: !!p.wholeWord, action: toggle('wholeWord') },
      { label: t('find.wrapAround'), checked: !!p.wrapAround, action: toggle('wrapAround') },
    ], { restore: this.input });
  }
}
