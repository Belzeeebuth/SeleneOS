// Find bar: a floating card at the top right of the document area (like Edge's PDF find box).
// One per window; it searches the active document (pdf.js PDFFindController highlights the matches).
const NOT_FOUND = 1;
const WRAPPED = 2;
const PENDING = 3;

export class FindBar {
  constructor(w) {
    this.w = w;
    const { h } = w;
    const { icon } = w.ctx;
    this.isOpen = false;
    this.caseSensitive = false;
    this.entireWord = false;
    this.input = h('input', {
      class: 'pdf-find-input',
      type: 'text',
      spellcheck: false,
      autocomplete: 'off',
      oninput: () => this.schedule(),
      onkeydown: (e) => this.onKey(e),
    });
    this.count = h('span', { class: 'pdf-find-count caption', 'aria-live': 'polite' });
    const btn = (ic, cls, onclick) => h('button', { type: 'button', class: ['btn', 'subtle', 'icon-btn', 'pdf-find-btn', cls], onclick }, icon(ic));
    this.prevBtn = btn('chevron_up', 'prev', () => this.next(true));
    this.nextBtn = btn('chevron_down', 'next', () => this.next(false));
    this.caseBtn = btn('text_case_title', 'case', () => this.toggle('caseSensitive'));
    this.wordBtn = btn('text_whole_word', 'word', () => this.toggle('entireWord'));
    this.closeBtn = btn('dismiss', 'close', () => this.close());
    this.el = h(
      'div',
      { class: 'pdf-find', role: 'search', hidden: true },
      h('div', { class: 'pdf-find-box' }, icon('search', { class: 'pdf-find-glass' }), this.input, this.count),
      h('div', { class: 'pdf-find-sep' }),
      this.prevBtn,
      this.nextBtn,
      h('div', { class: 'pdf-find-sep' }),
      this.caseBtn,
      this.wordBtn,
      this.closeBtn,
    );
    this.relabel();
  }

  relabel() {
    const { t } = this.w;
    const tip = (el, label, key) => {
      el.dataset.tip = key ? `${label} (${this.w.key(key)})` : label;
      el.setAttribute('aria-label', label);
    };
    this.input.placeholder = t('find.placeholder');
    this.input.setAttribute('aria-label', t('find.placeholder'));
    tip(this.prevBtn, t('find.prev'), 'Shift+F3');
    tip(this.nextBtn, t('find.next'), 'F3');
    tip(this.caseBtn, t('find.matchCase'));
    tip(this.wordBtn, t('find.wholeWord'));
    tip(this.closeBtn, t('find.close'), 'Esc');
    this.caseBtn.setAttribute('aria-pressed', String(this.caseSensitive));
    this.wordBtn.setAttribute('aria-pressed', String(this.entireWord));
    this.update();
  }

  open({ select = true } = {}) {
    const doc = this.w.active;
    if (!doc?.ready) return;
    const sel = doc.selectionInDoc().trim();
    if (sel && sel.length < 200 && !sel.includes('\n')) this.input.value = sel;
    if (!this.isOpen) {
      this.isOpen = true;
      this.el.hidden = false;
      if (document.documentElement.dataset.animations !== 'off') {
        this.el.animate([{ opacity: 0, transform: 'translateY(-8px)' }, { opacity: 1, transform: 'none' }], { duration: 250, easing: 'cubic-bezier(0.1, 0.9, 0.2, 1)' });
      }
    }
    this.input.focus({ preventScroll: true });
    if (select) this.input.select();
    if (this.input.value) this.search();
    this.w.onFindToggle?.(true);
  }

  close({ focusDoc = true } = {}) {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.el.hidden = true;
    clearTimeout(this.timer);
    for (const d of this.w.docs()) if (d.findState || d === this.w.active) d.findClose();
    if (focusDoc) this.w.active?.focus({ preventScroll: true });
    this.w.onFindToggle?.(false);
  }

  toggle(key) {
    this[key] = !this[key];
    this.caseBtn.classList.toggle('on', this.caseSensitive);
    this.wordBtn.classList.toggle('on', this.entireWord);
    this.caseBtn.setAttribute('aria-pressed', String(this.caseSensitive));
    this.wordBtn.setAttribute('aria-pressed', String(this.entireWord));
    this.search();
    this.input.focus({ preventScroll: true });
  }

  schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.search(), 120);
  }

  search() {
    clearTimeout(this.timer);
    const doc = this.w.active;
    if (!doc?.ready) return;
    doc.find(this.input.value, { caseSensitive: this.caseSensitive, entireWord: this.entireWord });
    this.update();
  }

  next(previous = false) {
    const doc = this.w.active;
    if (!doc?.ready) return;
    if (!this.isOpen) {
      this.open({ select: false });
      if (!this.input.value) return;
    }
    if (!this.input.value) {
      this.input.focus({ preventScroll: true });
      return;
    }
    doc.find(this.input.value, { caseSensitive: this.caseSensitive, entireWord: this.entireWord, again: true, previous });
  }

  /** The active document changed: run the query there. */
  docChanged() {
    if (!this.isOpen) return;
    if (this.input.value) this.search();
    else this.update();
  }

  onKey(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      this.next(e.shiftKey);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.close();
    }
  }

  update() {
    const { t } = this.w;
    const doc = this.w.active;
    const fs = doc?.findState;
    const q = this.input.value;
    let text = '';
    let none = false;
    if (q && fs) {
      if (fs.total > 0) text = t('find.count', { current: this.w.fmt(Math.max(1, fs.current)), total: this.w.fmt(fs.total) });
      else if (fs.state === NOT_FOUND || (fs.state !== PENDING && fs.total === 0 && fs.state != null)) {
        text = t('find.none');
        none = true;
      }
    }
    this.count.textContent = text;
    this.el.classList.toggle('not-found', none);
    this.input.classList.toggle('invalid', none);
    const has = !!fs?.total;
    this.prevBtn.disabled = !has;
    this.nextBtn.disabled = !has;
    this.el.classList.toggle('wrapped', fs?.state === WRAPPED);
  }
}
