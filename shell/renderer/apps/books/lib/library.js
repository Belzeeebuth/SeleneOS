// Livres — the library (home view): « Continuer la lecture » row and every book as a cover card, search,
// sort (recent, title, author), « Ajouter des livres », context menu (open, show in Fichiers, remove from the
// library, move the file to the trash). Cards are keyboard reachable (arrows move between them, Enter opens,
// Delete removes from the library, Shift+F10 / the menu key open the menu).
import { store } from './store.js';
import { fold } from './content.js';

const collator = () => new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

export class Library {
  constructor(app) {
    this.app = app;
    this.ctx = app.ctx;
    this.t = app.t;
    this.h = app.ctx.h;
    this.query = '';
    this.missing = new Set();
    this.offs = [];
    this.build();
    const later = () => this.schedule();
    this.offs.push(store.on('library', later), store.on('cover', later), store.on('progress', later));
  }

  build() {
    const { h, t } = this;
    const { icon, ui } = this.ctx;
    const uid = this.ctx.win.id;
    this.countEl = h('span', { class: 'caption text-2 books-lib-count' });
    this.searchInput = h('input', {
      class: 'input books-lib-search',
      type: 'search',
      placeholder: t('library.search'),
      'aria-label': t('library.search'),
      spellcheck: false,
      autocomplete: 'off',
      oninput: () => {
        this.query = fold(this.searchInput.value);
        this.render();
      },
      onkeydown: (e) => {
        if (e.key === 'Escape' && this.searchInput.value) {
          e.preventDefault();
          e.stopPropagation();
          this.searchInput.value = '';
          this.query = '';
          this.render();
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          this.el.querySelector('.books-card')?.focus();
        }
      },
    });
    this.sortSel = ui.select({
      options: ['recent', 'title', 'author'].map((v) => ({ value: v, label: t(`sort.${v}`) })),
      value: store.pref('sort'),
      onchange: (v) => {
        store.setPref('sort', v);
        this.render();
      },
    });
    this.sortSel.classList.add('books-lib-sort');
    this.sortSel.setAttribute('aria-label', t('library.sortBy'));
    const addBtn = () => h('button', { type: 'button', class: 'btn primary books-add', dataset: { cmd: 'add' }, onclick: () => this.app.pickBooks() }, icon('plus'), h('span', null, t('library.add')));
    this.head = h(
      'div',
      { class: 'books-lib-head' },
      h('div', { class: 'books-lib-heading' }, h('h1', { class: 'title books-lib-title' }, t('library.title')), this.countEl),
      h('div', { class: 'books-lib-tools' }, h('div', { class: 'search-box books-lib-searchbox' }, this.searchInput, icon('magnifying-glass', { size: 14 })), this.sortSel, addBtn()),
    );
    this.continueRow = h('div', { class: 'books-continue', role: 'list', 'aria-labelledby': `books-continue-${uid}` });
    this.continueSec = h('section', { class: 'books-lib-section' }, h('h2', { class: 'subtitle books-section-title', id: `books-continue-${uid}` }, t('library.continue')), this.continueRow);
    this.grid = h('div', { class: 'books-grid', role: 'list', 'aria-labelledby': `books-all-${uid}` });
    this.allTitle = h('h2', { class: 'subtitle books-section-title', id: `books-all-${uid}` }, t('library.all'));
    this.allSec = h('section', { class: 'books-lib-section' }, this.allTitle, this.grid);
    this.emptyEl = h(
      'div',
      { class: 'empty books-lib-empty', hidden: true },
      icon('books', { size: 48 }),
      h('div', { class: 'subtitle' }, t('library.emptyTitle')),
      h('div', { class: 'text-2 books-lib-empty-body' }, t('library.emptyBody')),
      addBtn(),
    );
    this.noMatchEl = h('div', { class: 'empty books-lib-nomatch', hidden: true }, icon('magnifying-glass', { size: 32 }), h('div', { class: 'text-2' }, t('library.noMatch')));
    this.scroller = h('div', { class: 'books-lib-scroll' }, this.continueSec, this.allSec, this.emptyEl, this.noMatchEl);
    this.el = h('div', { class: 'books-library', hidden: true }, this.head, this.scroller);
  }

  show() {
    this.el.hidden = false;
    this.render();
    this.checkMissing();
  }
  hide() {
    this.el.hidden = true;
  }
  get shown() {
    return !this.el.hidden;
  }
  focus() {
    (this.el.querySelector('.books-card') || this.searchInput).focus({ preventScroll: true });
  }

  schedule() {
    if (this.pending || !this.shown) return;
    this.pending = setTimeout(() => {
      this.pending = null;
      this.render();
    }, 60);
  }

  async checkMissing() {
    const list = store.list();
    const missing = new Set();
    await Promise.all(list.map(async (e) => !(await this.ctx.api.invoke('fs:exists', e.path).catch(() => true)) && missing.add(e.path)));
    for (const e of list) if (missing.has(e.path) && e.source === 'found' && !e.opened) store.remove(e.path, { hide: false });
    const changed = missing.size !== this.missing.size || [...missing].some((p) => !this.missing.has(p));
    this.missing = missing;
    if (changed) this.render();
  }

  sorted(list) {
    const c = collator();
    const by = store.pref('sort');
    const title = (e) => e.title || e.path.split('/').pop();
    if (by === 'title') return list.sort((a, b) => c.compare(title(a), title(b)));
    if (by === 'author') return list.sort((a, b) => c.compare(a.authorSort || a.authors[0] || '￿', b.authorSort || b.authors[0] || '￿') || c.compare(title(a), title(b)));
    return list.sort((a, b) => (b.opened || 0) - (a.opened || 0) || (b.added || 0) - (a.added || 0) || c.compare(title(a), title(b)));
  }

  render() {
    if (this.pending) {
      clearTimeout(this.pending);
      this.pending = null;
    }
    const { t } = this;
    const { ui } = this.ctx;
    const focused = this.el.contains(document.activeElement) ? document.activeElement.closest?.('.books-card') : null;
    const focusPath = focused?.dataset.path;
    const focusKind = focused?.classList.contains('continue') ? 'continue' : 'grid';
    const all = store.list();
    const q = this.query;
    const shown = q ? all.filter((e) => fold(`${e.title} ${e.authors.join(' ')} ${e.series} ${e.path.split('/').pop()}`).includes(q)) : all;
    const sorted = this.sorted(shown.slice());
    this.countEl.textContent = t('library.count', { count: all.length, n: this.app.fmt(all.length) });
    if (this.sortSel.value !== store.pref('sort')) this.sortSel.value = store.pref('sort');
    // continue reading: started, not finished, most recent first
    const cont = q ? [] : all.filter((e) => e.opened && e.progress > 0 && e.progress < 0.995 && !this.missing.has(e.path) && !e.error).sort((a, b) => b.opened - a.opened).slice(0, 8);
    ui.clear(this.continueRow);
    for (const e of cont) this.continueRow.appendChild(this.card(e, 'continue'));
    this.continueSec.hidden = !cont.length;
    ui.clear(this.grid);
    for (const e of sorted) this.grid.appendChild(this.card(e, 'grid'));
    this.allSec.hidden = !sorted.length;
    this.allTitle.textContent = q ? t('library.results') : t('library.all');
    this.emptyEl.hidden = all.length > 0;
    this.noMatchEl.hidden = !(all.length && q && !sorted.length);
    if (focusPath) {
      const sel = `.books-card.${focusKind}[data-path="${CSS.escape(focusPath)}"]`;
      (this.el.querySelector(sel) || this.el.querySelector(`.books-card[data-path="${CSS.escape(focusPath)}"]`) || this.el.querySelector('.books-card'))?.focus({ preventScroll: true });
    }
  }

  coverEl(e) {
    const { h } = this;
    const src = store.cover(e.path);
    if (src) return h('div', { class: 'books-cover' }, h('img', { src, alt: '', draggable: false }));
    let hash = 0;
    for (const ch of e.title || e.path) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
    return h(
      'div',
      { class: 'books-cover generated', 'aria-hidden': 'true', dataset: { variant: String(hash % 5) } },
      h('span', { class: 'books-cover-title' }, e.title || e.path.split('/').pop().replace(/\.epub$/i, '')),
      e.authors[0] ? h('span', { class: 'books-cover-author' }, e.authors[0]) : null,
    );
  }

  card(e, kind) {
    const { h, t } = this;
    const { icon } = this.ctx;
    const missing = this.missing.has(e.path);
    const title = e.title || e.path.split('/').pop().replace(/\.epub$/i, '');
    const author = e.authors.join(', ');
    const started = e.opened && e.progress > 0;
    const finished = started && e.progress >= 0.995;
    let status = null;
    let statusIcon = null;
    if (missing) {
      status = t('library.missing');
      statusIcon = 'file-x';
    } else if (e.error === 'EDRM') {
      status = t('library.protected');
      statusIcon = 'lock-key';
    } else if (e.error) {
      status = t('library.damaged');
      statusIcon = 'warning';
    } else if (finished) status = t('library.finished');
    else if (!started) status = t('library.new');
    const pct = this.app.pct(e.progress);
    const progress =
      started && !finished && !missing && !e.error
        ? h('div', { class: 'books-card-progress' }, h('div', { class: 'progress', 'aria-hidden': 'true' }, h('div', { class: 'bar', style: { width: `${Math.round(e.progress * 100)}%` } })), h('span', { class: 'caption text-2' }, pct))
        : h('div', { class: ['books-card-status', 'caption', statusIcon && 'warn'] }, statusIcon ? icon(statusIcon, { size: 14 }) : null, h('span', null, status || ''));
    const label = [title, author, started && !finished && !missing ? t('library.readPct', { pct }) : status].filter(Boolean).join(', ');
    const el = h(
      'div',
      {
        class: ['books-card', kind, missing && 'missing', e.error && 'broken'],
        role: 'listitem',
        tabindex: '0',
        'aria-label': label,
        dataset: { path: e.path },
        'data-tip': e.path,
      },
      this.coverEl(e),
      h(
        'div',
        { class: 'books-card-text' },
        h('div', { class: 'books-card-title' }, title),
        author ? h('div', { class: 'books-card-author caption text-2 ellipsis' }, author) : null,
        kind === 'continue' && e.series ? h('div', { class: 'caption text-3 ellipsis' }, e.series) : null,
        progress,
      ),
      h('button', { type: 'button', class: 'btn subtle icon-btn small books-card-more', tabindex: '-1', 'aria-hidden': 'true', onclick: (ev) => (ev.stopPropagation(), this.menu(ev, e)) }, icon('dots-three')),
    );
    el.addEventListener('click', () => this.app.openBook(e.path));
    el.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      this.menu(ev, e);
    });
    el.addEventListener('keydown', (ev) => {
      if (ev.target !== el) return;
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        this.app.openBook(e.path);
      } else if (ev.key === 'Delete') {
        ev.preventDefault();
        this.app.removeFromLibrary(e.path);
      } else if ((ev.key === 'F10' && ev.shiftKey) || ev.key === 'ContextMenu') {
        ev.preventDefault();
        this.menu(el, e);
      } else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(ev.key)) {
        ev.preventDefault();
        this.moveFocus(el, ev.key);
      }
    });
    return el;
  }

  moveFocus(from, key) {
    const container = from.parentElement;
    const cards = [...container.querySelectorAll(':scope > .books-card')];
    if (key === 'Home') return cards[0]?.focus();
    if (key === 'End') return cards[cards.length - 1]?.focus();
    if (key === 'ArrowUp' && container === this.grid && from.getBoundingClientRect().top <= cards[0].getBoundingClientRect().top + 2 && !this.continueSec.hidden) return this.continueRow.querySelector('.books-card')?.focus();
    if (key === 'ArrowDown' && container === this.continueRow) return this.grid.querySelector('.books-card')?.focus();
    if (key === 'ArrowUp' && from === cards[0]) return this.searchInput.focus();
    const r = from.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    let best = null;
    let bestD = Infinity;
    for (const c of cards) {
      if (c === from) continue;
      const b = c.getBoundingClientRect();
      const x = b.left + b.width / 2;
      const y = b.top + b.height / 2;
      const dx = x - cx;
      const dy = y - cy;
      const ok = key === 'ArrowRight' ? dx > 4 && Math.abs(dy) < r.height / 2 : key === 'ArrowLeft' ? dx < -4 && Math.abs(dy) < r.height / 2 : key === 'ArrowDown' ? dy > 4 : dy < -4;
      if (!ok) continue;
      const d = key === 'ArrowRight' || key === 'ArrowLeft' ? Math.abs(dx) : Math.abs(dy) * 4 + Math.abs(dx);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    if (!best && (key === 'ArrowRight' || key === 'ArrowLeft')) best = cards[cards.indexOf(from) + (key === 'ArrowRight' ? 1 : -1)];
    best?.focus();
    best?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  menu(at, e) {
    const { t } = this;
    const missing = this.missing.has(e.path);
    this.ctx.ui.menu(at, [
      { label: t('menu.open'), icon: 'book-open', action: () => this.app.openBook(e.path) },
      { label: t('menu.showInFiles'), icon: 'folder-open', disabled: missing, action: () => this.ctx.shell.launch('files', { select: e.path }) },
      '-',
      { label: t('menu.remove'), icon: 'x', action: () => this.app.removeFromLibrary(e.path) },
      { label: t('menu.trash'), icon: 'trash', danger: true, disabled: missing, action: () => this.app.trashBook(e.path) },
    ]);
  }

  destroy() {
    for (const off of this.offs) off();
    clearTimeout(this.pending);
  }
}
