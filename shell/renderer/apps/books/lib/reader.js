// Livres — the reader: one book in the window. Toolbar, side panel (table of contents, bookmarks, search),
// the page area (one sandboxed frame per chapter, see content.js), the progress bar with a seek slider, and the
// « Affichage » flyout (text size, font, line spacing, margins, alignment, theme, layout).
//
// Paginated mode: the chapter's <body> is a CSS multi-column box exactly as tall as the page; its columns
// overflow to the side and we move them with a transform (one or two columns per view). Scroll mode: the frame
// is as tall as the chapter and the page area scrolls. A position is { spine, ratio } (chapter and fraction of
// it), so it survives a change of size, font or mode.
import { BookSession, findAll, fold, textMap } from './content.js';
import { store, FONT_SIZES } from './store.js';
import { effectiveTheme, styleAccentVars } from '../../../core/theme.js';

const MARGINS = { narrow: 0.035, normal: 0.075, wide: 0.13 };
const LINE_HEIGHTS = { tight: 1.3, normal: 1.55, loose: 1.85 };
const FONTS = {
  serif: '"Noto Serif", "DejaVu Serif", "Liberation Serif", serif',
  sans: '"Inter", "Noto Sans", "DejaVu Sans", "Liberation Sans", sans-serif',
  readable: '"Atkinson Hyperlegible", "Atkinson Hyperlegible Next", "Inter", "Noto Sans", "DejaVu Sans", sans-serif',
};
const MAX_COLUMN = 760; // one column never gets wider than this (comfortable line length)
const MIN_SPREAD_COLUMN = 360; // two pages side by side only when each is at least this wide
const BASE_CSS = `:root { -webkit-text-size-adjust: none; text-size-adjust: none; }
:root > body { overflow-wrap: break-word; }
img.books-image-page { display: block; margin: 0 auto; max-width: 100%; max-height: 100%; object-fit: contain; }
a[data-books-href], a[data-books-url] { cursor: pointer; }
:root > body mark[data-books-hit] { background: Mark !important; color: MarkText !important; border-radius: 2px; }`;

const reduceMotion = () => document.documentElement.dataset.animations === 'off';
const isTyping = (t) => !!t?.closest?.('input, textarea, select, [contenteditable="true"]');
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export class Reader {
  constructor(app) {
    this.app = app;
    this.ctx = app.ctx;
    this.t = app.t;
    this.h = app.ctx.h;
    this.book = null;
    this.session = null;
    this.cur = null; // { spine, frame, doc, views, view, step, n, colW, gap, rtl, error }
    this.seq = 0;
    this.searchSeq = 0;
    this.offs = [];
    this.build();
  }

  // ================================================================== DOM
  build() {
    const { h, t } = this;
    const { icon } = this.ctx;
    const btn = (cmd, ic, label, onclick, extra = {}) =>
      h('button', { type: 'button', class: ['btn', 'subtle', 'icon-btn', 'books-tb-btn'], dataset: { cmd }, 'aria-label': label, 'data-tip': label, onclick, ...extra }, icon(ic));
    this.backBtn = h('button', { type: 'button', class: 'btn subtle books-back-btn', dataset: { cmd: 'library' }, onclick: () => this.app.showLibrary() }, icon('arrow-left'), h('span', { class: 'books-back-label' }, t('reader.library')));
    this.backBtn.setAttribute('aria-label', t('reader.library'));
    this.tocBtn = btn('toc', 'list', t('reader.contents'), () => this.toggleSide());
    this.tocBtn.setAttribute('aria-expanded', 'false');
    this.titleEl = h('div', { class: 'books-rtitle body-strong ellipsis' });
    this.chapEl = h('div', { class: 'books-rchap caption text-2 ellipsis' });
    this.searchBtn = btn('search', 'magnifying-glass', `${t('reader.search')} (${this.app.key('Ctrl+F')})`, () => this.openSearch());
    this.markBtn = btn('bookmark', 'bookmark-simple', `${t('reader.addBookmark')} (${this.app.key('Ctrl+D')})`, () => this.toggleBookmark());
    this.markBtn.setAttribute('aria-pressed', 'false');
    this.aaBtn = btn('appearance', 'text-aa', t('reader.appearance'), () => this.toggleFlyout());
    this.aaBtn.setAttribute('aria-expanded', 'false');
    this.fsBtn = btn('fullscreen', 'corners-out', `${t('reader.fullscreen')} (F11)`, () => this.toggleFullscreen());
    this.moreBtn = btn('more', 'dots-three', t('reader.more'), (e) => this.moreMenu(e));
    this.toolbar = h(
      'div',
      { class: 'books-rbar', role: 'toolbar', 'aria-label': t('reader.toolbar') },
      this.backBtn,
      this.tocBtn,
      h('div', { class: 'books-rtitles' }, this.titleEl, this.chapEl),
      this.searchBtn,
      this.markBtn,
      this.aaBtn,
      this.fsBtn,
      this.moreBtn,
    );

    // ---- side panel
    this.tabs = {};
    const tab = (id, label) => {
      const b = h('button', { type: 'button', class: 'tab books-side-tab', role: 'tab', id: `books-tab-${id}-${this.ctx.win.id}`, dataset: { tab: id }, onclick: () => this.setTab(id) }, label);
      this.tabs[id] = b;
      return b;
    };
    this.tabBar = h('div', { class: 'tabs books-side-tabs', role: 'tablist', 'aria-label': t('reader.contents') }, tab('toc', t('side.toc')), tab('bookmarks', t('side.bookmarks')), tab('search', t('side.search')));
    this.tabBar.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      e.preventDefault();
      e.stopPropagation();
      const ids = Object.keys(this.tabs);
      const i = ids.indexOf(this.sideTab);
      const next = ids[(i + (e.key === 'ArrowRight' ? 1 : ids.length - 1)) % ids.length];
      this.setTab(next);
      this.tabs[next].focus();
    });
    this.tocList = h('div', { class: 'books-toc', role: 'tree', 'aria-label': t('side.toc') });
    this.markList = h('div', { class: 'books-marks', role: 'list', 'aria-label': t('side.bookmarks') });
    this.searchInput = h('input', {
      class: 'input books-search-input',
      type: 'search',
      placeholder: t('search.placeholder'),
      'aria-label': t('search.placeholder'),
      spellcheck: false,
      autocomplete: 'off',
      onkeydown: (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          clearTimeout(this.searchTimer);
          this.runSearch(this.searchInput.value);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          if (this.searchInput.value) {
            this.searchInput.value = '';
            this.runSearch('');
          } else this.closeSide();
        }
      },
      oninput: () => {
        clearTimeout(this.searchTimer);
        this.searchTimer = setTimeout(() => this.runSearch(this.searchInput.value), 450);
      },
    });
    this.searchStatus = h('div', { class: 'books-search-status caption text-2', role: 'status', 'aria-live': 'polite' });
    this.searchResults = h('div', { class: 'books-results', role: 'list', 'aria-label': t('side.search') });
    this.panels = {
      toc: h('div', { class: 'books-panel', role: 'tabpanel', dataset: { panel: 'toc' } }, this.tocList),
      bookmarks: h('div', { class: 'books-panel', role: 'tabpanel', dataset: { panel: 'bookmarks' } }, this.markList),
      search: h('div', { class: 'books-panel books-panel-search', role: 'tabpanel', dataset: { panel: 'search' } }, h('div', { class: 'search-box books-search-box' }, this.searchInput, icon('magnifying-glass', { size: 14 })), this.searchStatus, this.searchResults),
    };
    for (const [id, p] of Object.entries(this.panels)) p.setAttribute('aria-labelledby', this.tabs[id].id);
    this.side = h('aside', { class: 'books-side', hidden: true, 'aria-label': t('reader.contents') }, this.tabBar, ...Object.values(this.panels));
    this.side.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault();
        e.stopPropagation();
        this.closeSide({ focus: true });
      }
    });
    this.scrim = h('div', { class: 'books-scrim', hidden: true, onclick: () => this.closeSide() });

    // ---- page area
    this.viewEl = h('div', { class: 'books-view', tabindex: '-1', 'aria-label': t('reader.page') });
    this.loadingEl = h('div', { class: 'books-loading', hidden: true, role: 'status' }, h('div', { class: 'spinner' }), h('span', { class: 'books-sr' }, t('reader.loading')));
    this.ribbon = h('div', { class: 'books-ribbon', hidden: true, 'aria-hidden': 'true' }, icon('bookmark-simple', { filled: true, size: 22 }));
    this.backChip = h('button', { type: 'button', class: 'btn books-backchip', hidden: true, onclick: () => this.goBack() }, icon('arrow-left', { size: 14 }), h('span', null, t('reader.backToPage')));
    this.note = h('div', { class: 'books-note', hidden: true, role: 'dialog', 'aria-label': t('note.title') });
    this.stage = h('div', { class: 'books-stage' }, this.viewEl, this.loadingEl, this.ribbon, this.backChip, this.note);
    this.viewEl.addEventListener('click', (e) => {
      if (e.target !== this.viewEl || this.layout !== 'paged') return;
      const r = this.viewEl.getBoundingClientRect();
      if (e.clientX < r.left + r.width / 2 !== this.isRtl()) this.prev();
      else this.next();
    });
    this.viewEl.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.viewEl.addEventListener('scroll', () => this.onScroll(), { passive: true });

    // ---- footer
    // the left button turns back (forward in a right-to-left book), the right one forward
    this.prevBtn = h('button', { type: 'button', class: 'btn subtle icon-btn', dataset: { cmd: 'prev' }, 'aria-label': t('reader.prev'), 'data-tip': t('reader.prev'), onclick: () => (this.isRtl() ? this.next() : this.prev()) }, icon('caret-left'));
    this.nextBtn = h('button', { type: 'button', class: 'btn subtle icon-btn', dataset: { cmd: 'next' }, 'aria-label': t('reader.next'), 'data-tip': t('reader.next'), onclick: () => (this.isRtl() ? this.prev() : this.next()) }, icon('caret-right'));
    this.footChap = h('span', { class: 'books-foot-chap ellipsis' });
    this.footPage = h('span', { class: 'books-foot-page' });
    this.footPct = h('span', { class: 'books-foot-pct' });
    this.seek = this.ctx.ui.slider({ min: 0, max: 1000, step: 1, value: 0, oninput: (v) => this.seekPreview(v), onchange: (v) => this.seekTo(v / 1000) });
    this.seek.classList.add('books-seek');
    this.seek.setAttribute('aria-label', t('reader.position'));
    this.footer = h(
      'div',
      { class: 'books-foot' },
      this.prevBtn,
      h('div', { class: 'books-foot-mid' }, h('div', { class: 'books-foot-info caption' }, this.footChap, this.footPage, this.footPct), this.seek),
      this.nextBtn,
    );

    this.flyout = h('div', { class: 'books-flyout', hidden: true, role: 'dialog', 'aria-label': t('reader.appearance') });
    this.errorEl = h('div', { class: 'books-error', hidden: true });
    this.main = h('div', { class: 'books-rmain' }, this.side, this.scrim, this.stage);
    this.el = h('div', { class: 'books-reader', tabindex: '-1' }, this.toolbar, this.main, this.footer, this.flyout, this.errorEl);
    this.el.addEventListener('keydown', (e) => this.onKey(e));
    this.paperProbe = h('span', { class: 'books-probe', 'aria-hidden': 'true' });
    this.el.appendChild(this.paperProbe);

    this.ro = new ResizeObserver(() => this.scheduleRelayout());
    this.ro.observe(this.viewEl);
    this.offs.push(store.on('prefs', (k) => this.onPref(k)));
    this.offs.push(store.on('bookmarks', (p) => p === this.book?.path && (this.renderMarks(), this.updateMarkState())));
    const th = this.ctx.shell?.theme;
    if (th?.on) {
      this.offs.push(th.on('change', () => this.applyTheme()));
      this.offs.push(th.on('style', () => this.applyTheme()));
    }
    if (this.ctx.settings?.on) this.offs.push(this.ctx.settings.on('accent', () => this.applyTheme()));
    this.offs.push(this.ctx.win.on?.('fullscreen', (on) => this.onFullscreen(on)) || (() => {}));
    this.outside = (e) => {
      if (!this.flyout.hidden && !this.flyout.contains(e.target) && !this.aaBtn.contains(e.target)) this.closeFlyout();
      if (!this.note.hidden && !this.note.contains(e.target)) this.closeNote();
    };
    document.addEventListener('pointerdown', this.outside, true);
    this.sideTab = store.pref('sidebarTab');
    this.applyTheme();
  }

  get layout() {
    return store.pref('layout');
  }

  // ================================================================== open / close
  async open(path, { at } = {}) {
    const { t } = this;
    this.errorEl.hidden = true;
    this.applyTheme();
    this.showLoading(true);
    let book;
    try {
      book = await this.ctx.api.invoke('books:open', path);
    } catch (err) {
      if (this.closed) return false;
      this.showLoading(false);
      this.showBookError(err?.code, path);
      return false;
    }
    if (this.closed) return false;
    this.book = book;
    this.session = new BookSession(this.ctx.api, book);
    this.titleEl.textContent = book.title;
    this.titleEl.setAttribute('data-tip', [book.title, book.authors.join(', ')].filter(Boolean).join(' — '));
    this.ctx.win.setTitle(book.title);
    this.weights = book.spine.map((s) => Math.max(1, s.size));
    this.cum = [];
    let acc = 0;
    for (const w of this.weights) {
      this.cum.push(acc);
      acc += w;
    }
    this.total = acc;
    this.rtlBook = book.direction === 'rtl';
    this.flatToc = [];
    const walk = (items, depth) => {
      for (const it of items) {
        this.flatToc.push({ ...it, depth });
        if (it.children?.length) walk(it.children, depth + 1);
      }
    };
    walk(book.toc, 0);
    if (!this.flatToc.length) this.flatToc = book.spine.map((s, i) => ({ label: t('reader.section', { n: this.app.fmt(i + 1) }), href: s.href, frag: '', spine: i, depth: 0, generated: true }));
    this.renderToc();
    this.renderMarks();
    this.history = [];
    const entry = store.get(path);
    const pos = at || entry?.pos || { spine: this.firstLinear(), ratio: 0 };
    await this.goTo({ spine: clamp(pos.spine, 0, book.spine.length - 1), ratio: pos.ratio || 0 });
    if (this.closed) return false;
    this.viewEl.focus({ preventScroll: true });
    // warm up the next chapter
    this.session.parse(this.nextSpine(this.cur?.spine ?? 0)).catch(() => {});
    return true;
  }

  close() {
    if (this.closed) return;
    this.savePosition(true);
    this.closed = true;
    this.seq++;
    this.searchSeq++;
    this.ro.disconnect();
    for (const off of this.offs) off?.();
    document.removeEventListener('pointerdown', this.outside, true);
    clearTimeout(this.relayoutTimer);
    clearTimeout(this.saveTimer);
    clearTimeout(this.searchTimer);
    this.session?.close();
    if (this.ctx.win.fullscreen) this.ctx.win.setFullscreen(false);
    this.el.remove();
  }

  showLoading(on) {
    clearTimeout(this.loadingTimer);
    if (!on) {
      this.loadingEl.hidden = true;
      return;
    }
    this.loadingTimer = setTimeout(() => (this.loadingEl.hidden = false), 180);
  }

  showBookError(code, path) {
    const { h, t } = this;
    const { icon, ui } = this.ctx;
    const kind = { EDRM: 'drm', EBADZIP: 'damaged', ENOTEPUB: 'damaged', ETOOBIG: 'tooBig', ENOENT: 'missing' }[code] || 'generic';
    ui.clear(this.errorEl);
    this.errorEl.append(
      h(
        'div',
        { class: 'books-error-card', role: 'alert' },
        icon(kind === 'drm' ? 'lock-key' : 'warning', { size: 40 }),
        h('div', { class: 'subtitle' }, t(`error.${kind}Title`)),
        h('div', { class: 'text-2 books-error-body' }, t(`error.${kind}Body`)),
        h('div', { class: 'caption text-2 books-error-path ellipsis', 'data-tip': path }, path.split('/').pop()),
        h('button', { type: 'button', class: 'btn primary', dataset: { cmd: 'error-back' }, onclick: () => this.app.showLibrary() }, t('reader.backToLibrary')),
      ),
    );
    this.errorEl.hidden = false;
    this.el.classList.add('has-error');
    this.ctx.win.setTitle(this.app.appName);
    this.app.bookFailed(path, code || 'EFAIL');
    setTimeout(() => this.errorEl.querySelector('button')?.focus(), 30);
  }

  firstLinear() {
    const i = this.book.spine.findIndex((s) => s.linear);
    return i < 0 ? 0 : i;
  }
  nextSpine(i) {
    const s = this.book.spine;
    for (let j = i + 1; j < s.length; j++) if (s[j].linear || !s[i]?.linear) return j;
    return -1;
  }
  prevSpine(i) {
    const s = this.book.spine;
    for (let j = i - 1; j >= 0; j--) if (s[j].linear || !s[i]?.linear) return j;
    return -1;
  }

  // ================================================================== chapter loading
  userCss() {
    const p = store.prefs;
    const c = this.colors || { paper: 'Canvas', ink: 'CanvasText', link: 'LinkText', line: 'GrayText', scheme: 'light', force: false };
    const L = [];
    L.push(`:root { color-scheme: ${c.scheme} !important; background-color: ${c.paper} !important; color: ${c.ink} !important; font-size: ${p.fontSize}% !important; }`);
    L.push(`:root > body { color: ${c.ink} !important; background: transparent !important; }`);
    if (c.force) L.push(`:root > body :not(img, svg, svg *, video, a, mark) { color: inherit !important; background-color: transparent !important; border-color: ${c.line} !important; }`);
    L.push(`:root > body a[data-books-href], :root > body a[data-books-url] { color: ${c.link} !important; }`);
    if (FONTS[p.font]) {
      L.push(`:root > body, :root > body :not(code, pre, kbd, samp, tt, var, code *, pre *, kbd *, samp *, svg, svg *) { font-family: ${FONTS[p.font]} !important; }`);
      if (p.font === 'readable') L.push(':root > body { letter-spacing: 0.01em; word-spacing: 0.06em; }');
    }
    if (LINE_HEIGHTS[p.lineHeight]) L.push(`:root > body, :root > body :not(h1, h2, h3, h4, h5, h6, svg, svg *) { line-height: ${LINE_HEIGHTS[p.lineHeight]} !important; }`);
    if (p.align === 'justify') L.push(':root > body :is(p, li, dd, blockquote) { text-align: justify !important; hyphens: auto !important; -webkit-hyphens: auto !important; }');
    else if (p.align === 'left') L.push(':root > body :is(p, li, dd, blockquote) { text-align: start !important; hyphens: manual !important; }');
    return L.join('\n');
  }

  async loadChapter(i) {
    const seq = ++this.seq;
    this.closeNote();
    this.showLoading(true);
    let res;
    try {
      res = await this.session.render(i, this.userCss(), BASE_CSS);
    } catch (err) {
      if (seq !== this.seq || this.closed) return false;
      this.showLoading(false);
      this.showChapterError(i, err);
      return true;
    }
    if (seq !== this.seq || this.closed) return false;
    const frame = this.h('iframe', { class: 'books-frame', title: this.chapterLabelOf(i) || this.book.title, referrerpolicy: 'no-referrer' });
    frame.setAttribute('sandbox', 'allow-same-origin');
    frame.setAttribute('srcdoc', res.srcdoc);
    frame.style.visibility = 'hidden';
    const loaded = new Promise((resolve) => frame.addEventListener('load', resolve, { once: true }));
    this.viewEl.appendChild(frame);
    this.sizeFrame(frame);
    await Promise.race([loaded, new Promise((r) => setTimeout(r, 8000))]);
    if (seq !== this.seq || this.closed) {
      frame.remove();
      return false;
    }
    const doc = frame.contentDocument;
    if (!doc?.body) {
      frame.remove();
      this.showLoading(false);
      this.showChapterError(i, new Error('frame'));
      return true;
    }
    await Promise.race([doc.fonts?.ready, new Promise((r) => setTimeout(r, 1500))]).catch(() => {});
    if (seq !== this.seq || this.closed) {
      frame.remove();
      return false;
    }
    const hadFocus = this.el.contains(document.activeElement) && document.activeElement !== frame;
    for (const old of [...this.viewEl.querySelectorAll('.books-frame, .books-chap-error')]) if (old !== frame) old.remove();
    // keyboard focus was in the old page (after a click in it): keep it in the reader
    if (hadFocus && (!document.activeElement || document.activeElement === document.body)) this.viewEl.focus({ preventScroll: true });
    this.cur = { spine: i, frame, doc, views: 1, view: 0, step: 1, n: 1, gap: 0, colW: 1, rtl: false, error: false, frags: new Map() };
    this.wireFrame(frame, doc);
    this.layoutChapter();
    frame.style.visibility = '';
    this.showLoading(false);
    // late images / fonts change the layout: measure again, keeping the position
    for (const img of doc.images) if (!img.complete) img.addEventListener('load', () => this.scheduleRelayout(), { once: true });
    doc.fonts?.addEventListener?.('loadingdone', () => this.scheduleRelayout());
    return true;
  }

  showChapterError(i, err) {
    const { h, t } = this;
    const hadFocus = this.el.contains(document.activeElement);
    for (const old of [...this.viewEl.querySelectorAll('.books-frame, .books-chap-error')]) old.remove();
    if (hadFocus && (!document.activeElement || document.activeElement === document.body)) this.viewEl.focus({ preventScroll: true });
    const msg = err?.code === 'EDRM' ? t('error.chapterDrm') : t('error.chapterBody');
    this.viewEl.appendChild(h('div', { class: 'books-chap-error', role: 'alert' }, this.ctx.icon('warning', { size: 32 }), h('div', { class: 'body-strong' }, t('error.chapterTitle')), h('div', { class: 'text-2' }, msg)));
    this.cur = { spine: i, frame: null, doc: null, views: 1, view: 0, step: 1, n: 1, gap: 0, colW: 1, rtl: false, error: true, frags: new Map() };
    this.updateChrome();
  }

  wireFrame(frame, doc) {
    // Listeners run in the shell's context (the frame itself runs nothing: no allow-scripts).
    doc.addEventListener('click', (e) => this.onFrameClick(e, frame), true);
    doc.addEventListener('auxclick', (e) => e.target?.closest?.('a') && e.preventDefault(), true);
    doc.addEventListener('dragstart', (e) => e.preventDefault(), true);
    doc.addEventListener('submit', (e) => e.preventDefault(), true);
    doc.addEventListener('keydown', (e) => this.onKey(e));
    doc.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    doc.addEventListener('contextmenu', (e) => this.onFrameMenu(e, frame));
    doc.addEventListener('pointerdown', (e) => {
      this.outside(e);
      this.swipe = e.pointerType === 'mouse' ? null : { x: e.clientX, y: e.clientY, t: Date.now() };
    });
    doc.addEventListener('pointerup', (e) => {
      const s = this.swipe;
      this.swipe = null;
      if (!s || this.layout !== 'paged') return;
      const dx = e.clientX - s.x;
      if (Math.abs(dx) > 50 && Math.abs(e.clientY - s.y) < 80 && Date.now() - s.t < 800) {
        this.swallowClick = true;
        if (dx < 0 === !this.isRtl()) this.next();
        else this.prev();
      }
    });
  }

  sizeFrame(frame) {
    const m = this.metrics();
    if (this.layout === 'paged') {
      Object.assign(frame.style, { left: `${m.left}px`, top: `${m.mv}px`, width: `${m.innerW}px`, height: `${m.innerH}px` });
    } else {
      Object.assign(frame.style, { left: '', top: '', width: `${m.innerW}px`, marginTop: `${m.mv}px`, marginBottom: `${m.mv}px` });
    }
    return m;
  }

  metrics() {
    const W = Math.max(200, this.viewEl.clientWidth);
    const H = Math.max(200, this.viewEl.clientHeight);
    const paged = this.layout === 'paged';
    let mh = Math.round(clamp(W * (MARGINS[store.pref('margins')] || MARGINS.normal), 12, 160));
    const mv = paged ? Math.round(clamp(H * 0.055, 14, 48)) : 24;
    let innerW = Math.max(160, W - 2 * mh);
    const gap = Math.round(clamp(mh * 1.4, 40, 112));
    const n = paged && store.pref('spread') && innerW >= 2 * MIN_SPREAD_COLUMN + gap ? 2 : 1;
    if (n === 1 && innerW > MAX_COLUMN) {
      innerW = MAX_COLUMN;
      mh = Math.floor((W - innerW) / 2);
    }
    innerW = Math.floor(innerW);
    const innerH = Math.floor(Math.max(160, H - 2 * mv));
    return { W, H, mh, mv, innerW, innerH, n, gap, left: Math.floor((W - innerW) / 2) };
  }

  layoutCss(m) {
    if (this.layout === 'paged') {
      return `:root { height: ${m.innerH}px !important; overflow: hidden !important; margin: 0 !important; padding: 0 !important; }
:root > body { box-sizing: border-box !important; height: ${m.innerH}px !important; min-height: 0 !important; max-height: none !important; width: auto !important; max-width: none !important; margin: 0 !important; padding: 0 !important; column-count: ${m.n} !important; column-width: auto !important; column-gap: ${m.gap}px !important; column-fill: auto !important; overflow: visible !important; position: relative !important; }
:root > body img, :root > body svg, :root > body video { max-width: 100% !important; max-height: ${Math.max(40, m.innerH - 8)}px !important; object-fit: contain; break-inside: avoid; }
:root > body img { height: auto; }
:root > body table { max-width: 100% !important; }
:root > body pre { white-space: pre-wrap !important; }${
        m.imagePage
          ? `
:root > body :is(img, svg, video) { display: block !important; margin: 0 auto !important; width: auto !important; height: ${Math.max(40, m.innerH - 8)}px !important; max-width: 100% !important; object-fit: contain !important; }
:root > body :is(div, p, section, figure):has(> :is(img, svg, video)) { margin: 0 !important; padding: 0 !important; text-indent: 0 !important; height: auto !important; }`
          : ''
      }`;
    }
    return `:root { height: auto !important; overflow: hidden !important; margin: 0 !important; padding: 0 !important; }
:root > body { margin: 0 !important; padding: 0 0 8px !important; columns: auto !important; column-count: auto !important; height: auto !important; min-height: 0 !important; max-height: none !important; overflow: visible !important; }
:root > body img, :root > body svg, :root > body video { max-width: 100% !important; }
:root > body img { height: auto; }
:root > body table { max-width: 100% !important; }
:root > body pre { white-space: pre-wrap !important; }`;
  }

  /** Measure the current chapter (pages / height) for the current size and settings. */
  layoutChapter() {
    const c = this.cur;
    if (!c || c.error || !c.doc?.body) return;
    const m = this.sizeFrame(c.frame);
    const body = c.doc.body;
    // a page that is only a picture (cover, plate): one centred page, the picture fitted to it
    const pics = body.querySelectorAll('img, svg, video');
    m.imagePage = pics.length === 1 && (body.textContent || '').trim().length < 40;
    if (m.imagePage && this.layout === 'paged') m.n = 1;
    const layoutStyle = c.doc.querySelector('style[data-books="layout"]');
    const css = this.layoutCss(m);
    if (layoutStyle && layoutStyle.textContent !== css) layoutStyle.textContent = css;
    c.rtl = c.doc.defaultView?.getComputedStyle(body).direction === 'rtl';
    c.frags = new Map();
    if (this.layout === 'paged') {
      body.style.setProperty('transition', 'none', 'important');
      body.style.setProperty('transform', 'none', 'important');
      const sw = c.doc.documentElement.scrollWidth;
      c.n = m.n;
      c.gap = m.gap;
      c.colW = (m.innerW - (m.n - 1) * m.gap) / m.n;
      c.step = m.innerW + m.gap;
      const cols = Math.max(1, Math.round((sw + m.gap) / (c.colW + m.gap)));
      c.views = Math.max(1, Math.ceil(cols / m.n));
      c.frame.style.height = `${m.innerH}px`;
    } else {
      body.style.removeProperty('transform');
      c.frame.style.height = '0px';
      const hgt = Math.max(c.doc.documentElement.scrollHeight, body.scrollHeight);
      c.frame.style.height = `${Math.ceil(hgt) + 2}px`;
      c.height = Math.ceil(hgt) + 2;
      c.views = 1;
      c.view = 0;
    }
  }

  scheduleRelayout() {
    clearTimeout(this.relayoutTimer);
    this.relayoutTimer = setTimeout(() => this.relayout(), 120);
  }

  /** Measure again and keep the reading position (window resized, settings changed). */
  relayout() {
    const c = this.cur;
    if (!c || this.closed) return;
    if (c.error) return this.updateChrome();
    const pos = this.position();
    this.layoutChapter();
    this.place({ ratio: pos.ratio });
  }

  // ================================================================== positions
  async goTo(target, { push = false, resetHistory = false } = {}) {
    if (!this.book) return;
    if (resetHistory) this.history = [];
    if (push && this.cur && !this.cur.error) {
      this.history.push(this.position());
      if (this.history.length > 50) this.history.shift();
    }
    const spine = clamp(target.spine | 0, 0, this.book.spine.length - 1);
    if (!this.cur || this.cur.spine !== spine || target.reload) {
      this.loadingChapter = true;
      let ok = false;
      try {
        ok = await this.loadChapter(spine);
      } finally {
        if (ok || this.closed) this.loadingChapter = false;
      }
      if (!ok || this.closed) return;
    }
    this.place(target);
    this.backChip.hidden = !this.history.length;
    // page turns asked while the chapter was loading
    const q = this.queued || 0;
    this.queued = 0;
    for (let k = 0; k < Math.min(20, Math.abs(q)); k++) await (q > 0 ? this.next() : this.prev());
  }

  place(t) {
    const c = this.cur;
    if (!c) return;
    if (c.error) return this.updateChrome();
    let el = null;
    if (t.frag) el = this.findTarget(t.frag);
    if (t.search) el = this.highlight(t.search.needle, t.search.n);
    if (this.layout === 'paged') {
      let view = 0;
      if (t.end) view = c.views - 1;
      else if (el) view = this.viewOf(el);
      else if (t.ratio != null) view = Math.floor(clamp(t.ratio, 0, 1) * c.views + 1e-6);
      this.showView(view);
    } else {
      const max = Math.max(0, this.viewEl.scrollHeight - this.viewEl.clientHeight);
      let top = t.ratio > 0 ? c.frame.offsetTop + t.ratio * c.height : 0;
      if (t.end) top = max;
      else if (el) top = c.frame.offsetTop + this.rectOf(el).top - 24;
      this.viewEl.scrollTop = clamp(top, 0, max);
      this.afterMove();
    }
  }

  rectOf(el) {
    const rects = el.getClientRects?.();
    return rects && rects.length ? rects[0] : el.getBoundingClientRect();
  }

  /** Page (view) holding an element of the current chapter (paginated mode). */
  viewOf(el) {
    const c = this.cur;
    const r = this.rectOf(el);
    // measured from the body's own box: right whatever the current page shift (even mid-animation)
    const b = c.doc.body.getBoundingClientRect();
    const pos = c.rtl ? b.right - r.right : r.left - b.left;
    const col = Math.max(0, Math.floor((pos + 1) / (c.colW + c.gap)));
    return clamp(Math.floor(col / c.n), 0, c.views - 1);
  }

  findTarget(frag) {
    const d = this.cur?.doc;
    if (!d || !frag) return null;
    return d.getElementById(frag) || d.getElementsByName(frag)[0] || null;
  }

  showView(v, { animate = false } = {}) {
    const c = this.cur;
    if (!c || c.error) return;
    c.view = clamp(v, 0, c.views - 1);
    const body = c.doc.body;
    const x = c.view * c.step * (c.rtl ? 1 : -1);
    if (animate && !reduceMotion()) body.style.setProperty('transition', 'transform 160ms cubic-bezier(0.1, 0.9, 0.2, 1)', 'important');
    else body.style.setProperty('transition', 'none', 'important');
    body.style.setProperty('transform', `translateX(${x}px)`, 'important');
    this.afterMove();
  }

  /** { spine, ratio } of the top / start of what is on screen. */
  position() {
    const c = this.cur;
    if (!c) return { spine: 0, ratio: 0 };
    if (c.error) return { spine: c.spine, ratio: 0 };
    if (this.layout === 'paged') return { spine: c.spine, ratio: c.view / c.views };
    const top = this.viewEl.scrollTop - c.frame.offsetTop;
    return { spine: c.spine, ratio: clamp(top / Math.max(1, c.height), 0, 1) };
  }

  /** How much of the current chapter has been seen (0..1, end of the screen). */
  chapterSeen() {
    const c = this.cur;
    if (!c || c.error) return 1;
    if (this.layout === 'paged') return (c.view + 1) / c.views;
    const bottom = this.viewEl.scrollTop - c.frame.offsetTop + this.viewEl.clientHeight;
    return clamp(bottom / Math.max(1, c.height), 0, 1);
  }

  progress() {
    const c = this.cur;
    if (!c || !this.total) return 0;
    return clamp((this.cum[c.spine] + this.chapterSeen() * this.weights[c.spine]) / this.total, 0, 1);
  }

  afterMove() {
    this.updateChrome();
    this.savePosition();
    this.closeNote();
  }

  savePosition(now = false) {
    if (!this.book || !this.cur) return;
    clearTimeout(this.saveTimer);
    const write = () => store.setPosition(this.book.path, this.position(), this.progress());
    if (now) {
      write();
      store.flush();
    } else this.saveTimer = setTimeout(write, 300);
  }

  // ================================================================== navigation
  async next() {
    if (this.loadingChapter) {
      this.queued = (this.queued || 0) + 1;
      return;
    }
    const c = this.cur;
    if (!c) return;
    if (this.layout === 'scroll' && !c.error) {
      const max = this.viewEl.scrollHeight - this.viewEl.clientHeight;
      if (this.viewEl.scrollTop < max - 2) {
        this.viewEl.scrollTop = Math.min(max, this.viewEl.scrollTop + this.viewEl.clientHeight * 0.9);
        return;
      }
    } else if (!c.error && c.view < c.views - 1) return this.showView(c.view + 1, { animate: true });
    const j = this.nextSpine(c.spine);
    if (j >= 0) await this.goTo({ spine: j, ratio: 0 });
  }

  async prev() {
    if (this.loadingChapter) {
      this.queued = (this.queued || 0) - 1;
      return;
    }
    const c = this.cur;
    if (!c) return;
    if (this.layout === 'scroll' && !c.error) {
      if (this.viewEl.scrollTop > 2) {
        this.viewEl.scrollTop = Math.max(0, this.viewEl.scrollTop - this.viewEl.clientHeight * 0.9);
        return;
      }
    } else if (!c.error && c.view > 0) return this.showView(c.view - 1, { animate: true });
    const j = this.prevSpine(c.spine);
    if (j >= 0) await this.goTo({ spine: j, end: true });
  }

  isRtl() {
    return this.rtlBook || !!this.cur?.rtl;
  }

  async goBack() {
    const p = this.history.pop();
    this.backChip.hidden = !this.history.length;
    if (p) await this.goTo(p);
    this.viewEl.focus({ preventScroll: true });
  }

  seekPreview(v) {
    if (!this.total) return;
    const g = v / 1000;
    const i = this.spineAt(g);
    this.footChap.textContent = this.chapterLabelOf(i) || this.book.title;
    this.footPage.textContent = '';
    this.footPct.textContent = this.app.pct(g);
  }

  spineAt(g) {
    const x = clamp(g, 0, 1) * this.total;
    let i = 0;
    while (i + 1 < this.cum.length && this.cum[i + 1] <= x) i++;
    return i;
  }

  async seekTo(g) {
    if (!this.total) return;
    const i = this.spineAt(g);
    const ratio = clamp((g * this.total - this.cum[i]) / this.weights[i], 0, 1);
    await this.goTo({ spine: i, ratio }, { resetHistory: true });
  }

  onWheel(e) {
    if (e.ctrlKey) return;
    if (this.layout !== 'paged') {
      // scroll mode: the wheel over the page scrolls the reading area (the frame itself never scrolls)
      if (e.target?.ownerDocument && e.target.ownerDocument !== document) {
        e.preventDefault();
        this.viewEl.scrollTop += e.deltaY * (e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? this.viewEl.clientHeight : 1);
      }
      return;
    }
    e.preventDefault();
    const d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    const now = Date.now();
    if (now - (this.wheelAt || 0) < 280) return;
    this.wheelAcc = (this.wheelAcc || 0) + d * (e.deltaMode === 1 ? 30 : 1);
    if (Math.abs(this.wheelAcc) < 40) return;
    const fwd = this.wheelAcc > 0;
    this.wheelAcc = 0;
    this.wheelAt = now;
    if (fwd) this.next();
    else this.prev();
  }

  onScroll() {
    if (this.layout !== 'scroll' || !this.cur) return;
    if (this.scrollRaf) return;
    this.scrollRaf = requestAnimationFrame(() => {
      this.scrollRaf = 0;
      this.updateChrome();
      this.savePosition();
    });
  }

  onKey(e) {
    if (e.defaultPrevented || this.closed) return;
    const k = e.key;
    const ctrl = e.ctrlKey || e.metaKey;
    const typing = isTyping(e.target);
    const inFlyout = this.flyout.contains(e.target);
    if (ctrl && !e.altKey && (k === 'f' || k === 'F')) {
      e.preventDefault();
      this.openSearch();
      return;
    }
    if (!this.book) {
      if (k === 'Escape' && !typing) {
        e.preventDefault();
        this.app.showLibrary();
      }
      return;
    }
    if (ctrl && !e.altKey && (k === 'd' || k === 'D' || k === 'b' || k === 'B')) {
      e.preventDefault();
      this.toggleBookmark();
      return;
    }
    if (ctrl && (k === '+' || k === '=' || k === '-' || k === '0')) {
      e.preventDefault();
      if (k === '0') store.setPref('fontSize', 100);
      else this.stepFont(k === '-' ? -1 : 1);
      return;
    }
    if (k === 'F11') {
      e.preventDefault();
      this.toggleFullscreen();
      return;
    }
    if (k === 'Escape') {
      if (!this.note.hidden) this.closeNote();
      else if (!this.flyout.hidden) this.closeFlyout({ focus: true });
      else if (this.sideOpen && this.side.classList.contains('overlay')) this.closeSide({ focus: true });
      else if (this.ctx.win.fullscreen) this.toggleFullscreen();
      else return;
      e.preventDefault();
      return;
    }
    if (ctrl && !e.altKey && !typing && (k === 'Home' || k === 'End')) {
      e.preventDefault();
      if (k === 'Home') this.goTo({ spine: this.firstLinear(), ratio: 0 }, { resetHistory: true });
      else this.goTo({ spine: this.book.spine.length - 1, end: true }, { resetHistory: true });
      return;
    }
    if (ctrl || e.altKey || typing || inFlyout || e.target?.closest?.('.books-side, .books-note')) return;
    const onButton = !!e.target?.closest?.('button, [role="slider"], .slider, a[href]');
    const rtl = this.isRtl();
    let act = null;
    switch (k) {
      case 'ArrowRight':
        act = rtl ? 'prev' : 'next';
        break;
      case 'ArrowLeft':
        act = rtl ? 'next' : 'prev';
        break;
      case 'PageDown':
        act = 'next';
        break;
      case 'PageUp':
        act = 'prev';
        break;
      case ' ':
      case 'Spacebar':
        if (onButton) return;
        act = e.shiftKey ? 'prev' : 'next';
        break;
      case 'ArrowDown':
      case 'ArrowUp':
        if (this.layout === 'scroll') {
          this.viewEl.scrollTop += k === 'ArrowDown' ? 48 : -48;
          e.preventDefault();
          return;
        }
        act = k === 'ArrowDown' ? 'next' : 'prev';
        break;
      case 'Home':
        act = 'home';
        break;
      case 'End':
        act = 'end';
        break;
      default:
        return;
    }
    if (onButton && (k === 'ArrowRight' || k === 'ArrowLeft') && e.target?.closest?.('.slider')) return;
    e.preventDefault();
    if (act === 'next') this.next();
    else if (act === 'prev') this.prev();
    else if (act === 'home') this.goTo({ spine: this.cur.spine, ratio: 0 });
    else if (act === 'end') this.goTo({ spine: this.cur.spine, end: true });
  }

  // ================================================================== links, footnotes, menu
  onFrameClick(e, frame) {
    const a = e.target?.closest?.('a');
    if (a) {
      // a link (or what is left of an unsafe one) never turns the page
      e.preventDefault();
      e.stopPropagation();
      if (a.hasAttribute('data-books-url')) this.openExternal(a.getAttribute('data-books-url'));
      else if (a.hasAttribute('data-books-href')) this.followLink(a, e, frame);
      return;
    }
    if (this.swallowClick) {
      this.swallowClick = false;
      return;
    }
    if (this.layout !== 'paged' || e.button !== 0) return;
    const sel = frame.contentDocument?.getSelection?.();
    if (sel && !sel.isCollapsed) return;
    const w = frame.clientWidth;
    const x = e.clientX;
    const rtl = this.isRtl();
    if (x < w * 0.22) rtl ? this.next() : this.prev();
    else if (x > w * 0.78) rtl ? this.prev() : this.next();
  }

  /** http(s) links open in the Navigateur; mailto: goes through the shell, which hands it to Mail. */
  openExternal(url) {
    if (/^https?:/i.test(url)) this.ctx.shell.openUrl(url);
    else if (/^mailto:/i.test(url)) window.open(url);
  }

  async followLink(a, e, frame) {
    const path = a.getAttribute('data-books-href');
    const frag = a.getAttribute('data-books-frag') || '';
    const spine = this.session.indexOf(path);
    if (spine < 0) return;
    const type = `${a.getAttribute('epub:type') || ''} ${a.getAttribute('role') || ''}`;
    const isNoteRef = /noteref/i.test(type);
    if (frag) {
      // a note: show it in a popover instead of leaving the page
      let target = null;
      if (spine === this.cur.spine) target = this.findTarget(frag);
      else {
        const p = await this.session.parse(spine).catch(() => null);
        target = p?.doc.getElementById(frag) || null;
      }
      const tType = target ? `${target.getAttribute('epub:type') || ''} ${target.getAttribute('role') || ''}` : '';
      if (target && (isNoteRef || /footnote|endnote|rearnote|doc-footnote|doc-endnote|\bnote\b/i.test(tType))) {
        let block = target;
        if ((block.textContent || '').trim().length < 4) block = target.closest('p, li, aside, dd, div, section') || target;
        const text = (block.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
        if (text) {
          const fr = frame.getBoundingClientRect();
          const r = a.getBoundingClientRect();
          this.showNote(text, { x: fr.left + r.left, y: fr.top + r.bottom }, () => this.goTo({ spine, frag }, { push: true }));
          return;
        }
      }
    }
    await this.goTo({ spine, frag, ratio: 0 }, { push: true });
  }

  showNote(text, at, go) {
    const { h, t } = this;
    const { ui, icon } = this.ctx;
    ui.clear(this.note);
    const goBtn = h('button', { type: 'button', class: 'btn small', dataset: { cmd: 'note-go' }, onclick: () => (this.closeNote(), go()) }, t('note.go'));
    this.note.append(
      h('div', { class: 'books-note-head' }, h('span', { class: 'caption text-2' }, t('note.title')), h('button', { type: 'button', class: 'btn subtle icon-btn small', 'aria-label': t('note.close'), onclick: () => this.closeNote({ focus: true }) }, icon('x', { size: 14 }))),
      h('div', { class: 'books-note-text selectable' }, text),
      h('div', { class: 'books-note-foot' }, goBtn),
    );
    this.note.hidden = false;
    const sr = this.stage.getBoundingClientRect();
    const w = Math.min(380, sr.width - 24);
    this.note.style.width = `${w}px`;
    const x = clamp(at.x - sr.left - 24, 12, sr.width - w - 12);
    const nh = this.note.offsetHeight;
    let y = at.y - sr.top + 8;
    if (y + nh > sr.height - 8) y = Math.max(8, at.y - sr.top - nh - 28);
    this.note.style.left = `${x}px`;
    this.note.style.top = `${y}px`;
    this.noteReturn = document.activeElement;
    goBtn.focus({ preventScroll: true });
    this.note.onkeydown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.closeNote({ focus: true });
      }
    };
  }

  closeNote({ focus = false } = {}) {
    if (this.note.hidden) return;
    this.note.hidden = true;
    if (focus) this.viewEl.focus({ preventScroll: true });
  }

  onFrameMenu(e, frame) {
    e.preventDefault();
    const { t } = this;
    const sel = (frame.contentDocument?.getSelection?.()?.toString() || '').trim();
    const fr = frame.getBoundingClientRect();
    const marked = !!this.bookmarkHere();
    const items = [];
    if (sel) {
      items.push({ label: t('menu.copy'), icon: 'copy', action: () => this.ctx.api.invoke('clipboard:writeText', sel).catch(() => {}) });
      items.push({ label: t('menu.searchFor', { text: sel.length > 24 ? `${sel.slice(0, 24)}…` : sel }), icon: 'magnifying-glass', action: () => this.openSearch(sel.slice(0, 200)) });
      items.push('-');
    }
    items.push({ label: marked ? t('reader.removeBookmark') : t('reader.addBookmark'), icon: 'bookmark-simple', action: () => this.toggleBookmark() });
    items.push({ label: t('reader.contents'), icon: 'list', action: () => this.openSide('toc') });
    this.ctx.ui.menu({ x: fr.left + e.clientX, y: fr.top + e.clientY }, items);
  }

  // ================================================================== chrome (title, footer, states)
  chapterIndexAt() {
    const c = this.cur;
    if (!c) return -1;
    let best = -1;
    for (let i = 0; i < this.flatToc.length; i++) {
      const it = this.flatToc[i];
      if (it.spine < 0 || it.spine > c.spine) continue;
      if (it.spine === c.spine && it.frag && !c.error && c.doc) {
        let v = c.frags.get(it.frag);
        if (v === undefined) {
          const el = this.findTarget(it.frag);
          v = el ? (this.layout === 'paged' ? this.viewOf(el) : this.rectOf(el).top) : -1;
          c.frags.set(it.frag, v);
        }
        if (this.layout === 'paged' ? v > c.view : v > this.viewEl.scrollTop - c.frame.offsetTop + this.viewEl.clientHeight / 3) continue;
      }
      best = i;
    }
    return best;
  }

  /** Label of the chapter holding spine item `spine`: its first entry in the table of contents, else the last one before. */
  chapterLabelOf(spine) {
    let best = null;
    for (const it of this.flatToc || []) {
      if (it.spine < 0 || it.spine > spine) continue;
      if (best && best.spine === it.spine) continue;
      best = it;
    }
    return best?.label || '';
  }

  updateChrome() {
    const c = this.cur;
    if (!c || !this.book) return;
    const { t } = this;
    const idx = this.chapterIndexAt();
    const label = idx >= 0 ? this.flatToc[idx].label : this.book.title;
    this.chapEl.textContent = label;
    this.footChap.textContent = label;
    if (this.layout === 'paged' && !c.error) {
      this.footPage.textContent = t('reader.pageOf', { page: this.app.fmt(c.view + 1), pages: this.app.fmt(c.views) });
    } else this.footPage.textContent = '';
    const g = this.progress();
    this.footPct.textContent = this.app.pct(g);
    if (document.activeElement !== this.seek) this.seek.setValue(Math.round(g * 1000));
    this.seek.setAttribute('aria-valuetext', `${this.app.pct(g)} — ${label}`);
    // table of contents: current entry
    if (this.tocCurrent !== idx) {
      this.tocCurrent = idx;
      for (const b of this.tocList.querySelectorAll('[aria-current]')) b.removeAttribute('aria-current');
      const cur = this.tocList.querySelector(`[data-index="${idx}"]`);
      if (cur) {
        cur.setAttribute('aria-current', 'true');
        if (!this.side.hidden) cur.scrollIntoView({ block: 'nearest' });
      }
    }
    const atStart = this.prevSpine(c.spine) < 0 && (c.error || (this.layout === 'paged' ? c.view === 0 : this.viewEl.scrollTop <= 2));
    const atEnd = this.nextSpine(c.spine) < 0 && (c.error || (this.layout === 'paged' ? c.view >= c.views - 1 : this.viewEl.scrollTop >= this.viewEl.scrollHeight - this.viewEl.clientHeight - 2));
    const rtl = this.isRtl();
    this.prevBtn.disabled = rtl ? atEnd : atStart;
    this.nextBtn.disabled = rtl ? atStart : atEnd;
    if (this.labelsRtl !== rtl) {
      this.labelsRtl = rtl;
      const [l, r] = rtl ? [this.t('reader.next'), this.t('reader.prev')] : [this.t('reader.prev'), this.t('reader.next')];
      this.prevBtn.setAttribute('aria-label', l);
      this.prevBtn.setAttribute('data-tip', l);
      this.nextBtn.setAttribute('aria-label', r);
      this.nextBtn.setAttribute('data-tip', r);
    }
    this.updateMarkState();
  }

  // ================================================================== table of contents
  renderToc() {
    const { h } = this;
    this.ctx.ui.clear(this.tocList);
    this.tocCurrent = null;
    if (!this.book.hasToc) this.tocList.appendChild(h('div', { class: 'caption text-2 books-toc-note' }, this.t('side.noToc')));
    this.flatToc.forEach((it, i) => {
      const style = { paddingInlineStart: `${12 + it.depth * 16}px` };
      if (it.spine < 0) {
        this.tocList.appendChild(h('div', { class: 'books-toc-label caption text-2', role: 'treeitem', 'aria-level': String(it.depth + 1), style }, it.label));
        return;
      }
      this.tocList.appendChild(
        h(
          'button',
          {
            type: 'button',
            class: ['books-toc-item', it.depth === 0 && 'top'],
            role: 'treeitem',
            'aria-level': String(it.depth + 1),
            dataset: { index: String(i) },
            style,
            onclick: () => {
              this.goTo({ spine: it.spine, frag: it.frag, ratio: 0 }, { resetHistory: true });
              if (this.side.classList.contains('overlay')) this.closeSide();
              this.viewEl.focus({ preventScroll: true });
            },
          },
          h('span', { class: 'ellipsis' }, it.label),
        ),
      );
    });
    this.tocList.onkeydown = (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const items = [...this.tocList.querySelectorAll('button')];
      const i = items.indexOf(document.activeElement);
      if (i < 0) return;
      e.preventDefault();
      items[clamp(i + (e.key === 'ArrowDown' ? 1 : -1), 0, items.length - 1)].focus();
    };
  }

  // ================================================================== side panel
  get sideOpen() {
    return !this.side.hidden;
  }

  toggleSide() {
    if (this.sideOpen) this.closeSide({ focus: true });
    else this.openSide(this.sideTab === 'search' ? 'toc' : this.sideTab);
  }

  openSide(tab) {
    this.setTab(tab || this.sideTab || 'toc');
    const overlay = this.el.clientWidth < 860;
    this.side.classList.toggle('overlay', overlay);
    this.scrim.hidden = !overlay;
    this.side.hidden = false;
    this.tocBtn.setAttribute('aria-expanded', 'true');
    this.tocBtn.classList.add('toggled');
    if (tab === 'toc') {
      const cur = this.tocList.querySelector('[aria-current]');
      cur?.scrollIntoView({ block: 'center' });
      (cur || this.tocList.querySelector('button'))?.focus({ preventScroll: true });
    } else if (tab === 'bookmarks') (this.markList.querySelector('button') || this.tabs.bookmarks).focus({ preventScroll: true });
    if (!overlay) this.relayout();
  }

  closeSide({ focus = false } = {}) {
    if (!this.sideOpen) return;
    this.side.hidden = true;
    this.scrim.hidden = true;
    this.tocBtn.setAttribute('aria-expanded', 'false');
    this.tocBtn.classList.remove('toggled');
    if (focus) this.viewEl.focus({ preventScroll: true });
    this.relayout();
  }

  setTab(id) {
    this.sideTab = id;
    store.setPref('sidebarTab', id);
    for (const [k, b] of Object.entries(this.tabs)) {
      b.classList.toggle('selected', k === id);
      b.setAttribute('aria-selected', String(k === id));
      b.tabIndex = k === id ? 0 : -1;
      this.panels[k].hidden = k !== id;
    }
  }

  // ================================================================== bookmarks
  bookmarkHere() {
    const c = this.cur;
    if (!c || !this.book) return null;
    const list = store.bookmarks(this.book.path);
    if (c.error) return list.find((b) => b.spine === c.spine) || null;
    if (this.layout === 'paged') return list.find((b) => b.spine === c.spine && Math.floor(b.ratio * c.views + 1e-6) === c.view) || null;
    const pos = this.position();
    const span = this.viewEl.clientHeight / Math.max(1, c.height);
    return list.find((b) => b.spine === c.spine && b.ratio >= pos.ratio - 0.002 && b.ratio < pos.ratio + span) || null;
  }

  excerpt() {
    const c = this.cur;
    if (!c?.doc) return '';
    const d = c.doc;
    let node = null;
    let offset = 0;
    const pts = this.layout === 'paged' ? [[6, 6], [12, 24], [30, 50], [c.frame.clientWidth / 3, 40]] : [[6, Math.max(6, this.viewEl.scrollTop - c.frame.offsetTop + 6)]];
    for (const [x, y] of pts) {
      const r = d.caretRangeFromPoint?.(x, y);
      if (r && r.startContainer?.nodeType === 3) {
        node = r.startContainer;
        offset = r.startOffset;
        while (offset > 0 && /\S/.test(node.data[offset - 1])) offset--; // from the start of that word
        break;
      }
    }
    let s = '';
    if (node) {
      const w = d.createTreeWalker(d.body, 4);
      w.currentNode = node;
      s = node.data.slice(offset);
      while (s.length < 160 && w.nextNode()) s += w.currentNode.data;
    } else {
      const text = d.body.textContent || '';
      const at = Math.floor(this.position().ratio * text.length);
      s = text.slice(at, at + 200);
    }
    s = s.replace(/\s+/g, ' ').trim();
    return s.length > 140 ? `${s.slice(0, 140).replace(/\s+\S*$/, '')}…` : s;
  }

  toggleBookmark() {
    if (!this.book || !this.cur) return;
    const list = store.bookmarks(this.book.path).slice();
    const here = this.bookmarkHere();
    if (here) {
      store.setBookmarks(this.book.path, list.filter((b) => b !== here));
      this.app.toast(this.t('toast.bookmarkRemoved'));
    } else {
      const pos = this.position();
      const idx = this.chapterIndexAt();
      list.push({ id: `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, ...pos, progress: this.progress(), label: idx >= 0 ? this.flatToc[idx].label : this.book.title, excerpt: this.excerpt(), at: Date.now() });
      list.sort((a, b) => a.spine - b.spine || a.ratio - b.ratio);
      store.setBookmarks(this.book.path, list);
      this.app.toast(this.t('toast.bookmarkAdded'));
    }
  }

  updateMarkState() {
    const on = !!this.bookmarkHere();
    this.ribbon.hidden = !on;
    this.markBtn.setAttribute('aria-pressed', String(on));
    this.markBtn.classList.toggle('on', on);
    const label = `${on ? this.t('reader.removeBookmark') : this.t('reader.addBookmark')} (${this.app.key('Ctrl+D')})`;
    this.markBtn.setAttribute('aria-label', label);
    this.markBtn.setAttribute('data-tip', label);
    this.ctx.ui.clear(this.markBtn).appendChild(this.ctx.icon('bookmark-simple', { filled: on }));
  }

  renderMarks() {
    const { h, t } = this;
    const { icon, ui, i18n } = this.ctx;
    ui.clear(this.markList);
    const list = this.book ? store.bookmarks(this.book.path) : [];
    if (!list.length) {
      this.markList.appendChild(h('div', { class: 'empty books-side-empty' }, icon('bookmark-simple', { size: 28 }), h('div', { class: 'text-2' }, t('side.noBookmarks', { key: this.app.key('Ctrl+D') }))));
      return;
    }
    for (const b of list) {
      const row = h(
        'div',
        { class: 'books-mark', role: 'listitem' },
        h(
          'button',
          { type: 'button', class: 'books-mark-go', dataset: { id: b.id }, onclick: () => this.goTo({ spine: b.spine, ratio: b.ratio }, { resetHistory: true }).then(() => this.viewEl.focus({ preventScroll: true })) },
          h('span', { class: 'books-mark-top' }, h('span', { class: 'body-strong ellipsis' }, b.label || this.book.title), h('span', { class: 'caption text-2' }, this.app.pct(b.progress))),
          b.excerpt ? h('span', { class: 'books-mark-excerpt caption text-2' }, b.excerpt) : null,
          h('span', { class: 'caption text-3 books-mark-date' }, i18n.formatDate(b.at || Date.now(), { dateStyle: 'medium' })),
        ),
        h('button', { type: 'button', class: 'btn subtle icon-btn small books-mark-del', 'aria-label': t('side.removeBookmark'), 'data-tip': t('side.removeBookmark'), onclick: () => this.removeBookmark(b.id) }, icon('x', { size: 14 })),
      );
      this.markList.appendChild(row);
    }
  }

  removeBookmark(id) {
    const list = store.bookmarks(this.book.path).filter((b) => b.id !== id);
    store.setBookmarks(this.book.path, list);
    (this.markList.querySelector('.books-mark-go') || this.tabs.bookmarks).focus({ preventScroll: true });
  }

  // ================================================================== search
  openSearch(text) {
    this.openSide('search');
    if (typeof text === 'string') {
      this.searchInput.value = text;
      this.runSearch(text);
    }
    this.searchInput.focus();
    this.searchInput.select();
  }

  async runSearch(query) {
    const seq = ++this.searchSeq;
    const { h, t } = this;
    const { ui } = this.ctx;
    const needle = fold(query);
    ui.clear(this.searchResults);
    this.results = [];
    if (needle.length < 2 || !this.book) {
      this.searchStatus.textContent = needle.length ? t('search.tooShort') : '';
      return;
    }
    this.searchStatus.textContent = t('search.searching');
    const MAX = 500;
    let count = 0;
    for (let i = 0; i < this.book.spine.length && count < MAX; i++) {
      const text = await this.session.text(i);
      if (seq !== this.searchSeq || this.closed) return;
      if (!text) continue;
      const hits = findAll(text, needle, MAX - count);
      if (!hits.length) continue;
      const group = h('div', { class: 'books-result-group', role: 'listitem' }, h('div', { class: 'books-result-chap caption text-2 ellipsis' }, this.chapterLabelOf(i) || this.book.title));
      hits.forEach((m, n) => {
        const before = text.slice(Math.max(0, m.start - 48), m.start).replace(/\s+/g, ' ');
        const after = text.slice(m.end, m.end + 72).replace(/\s+/g, ' ');
        const r = { spine: i, n, needle };
        this.results.push(r);
        group.appendChild(
          h(
            'button',
            { type: 'button', class: 'books-result', dataset: { spine: String(i), n: String(n) }, onclick: () => this.goToResult(r) },
            h('span', null, `${m.start > 48 ? '…' : ''}${before.trimStart()}`, h('mark', null, text.slice(m.start, m.end)), `${after.trimEnd()}${m.end + 72 < text.length ? '…' : ''}`),
          ),
        );
      });
      count += hits.length;
      this.searchResults.appendChild(group);
      this.searchStatus.textContent = t('search.count', { count, n: this.app.fmt(count) });
    }
    if (seq !== this.searchSeq) return;
    this.searchStatus.textContent = count ? t('search.count', { count, n: this.app.fmt(count) }) + (count >= MAX ? ` ${t('search.more')}` : '') : t('search.none');
  }

  async goToResult(r) {
    await this.goTo({ spine: r.spine, search: { needle: r.needle, n: r.n } }, { resetHistory: true });
    if (this.side.classList.contains('overlay')) this.closeSide();
  }

  /** Wrap the n-th match of `needle` in the current chapter in <mark data-books-hit>; returns the first mark. */
  highlight(needle, n) {
    const d = this.cur?.doc;
    if (!d) return null;
    for (const m of [...d.querySelectorAll('mark[data-books-hit]')]) {
      const p = m.parentNode;
      while (m.firstChild) p.insertBefore(m.firstChild, m);
      m.remove();
      p.normalize();
    }
    const { text, nodes } = textMap(d.body);
    const hits = findAll(text, needle, n + 1);
    const hit = hits[n] || hits[0];
    if (!hit) return null;
    let first = null;
    for (const { node, at } of nodes) {
      const end = at + node.data.length;
      if (end <= hit.start || at >= hit.end) continue;
      if (node.parentNode?.closest?.('svg')) continue;
      const s = Math.max(hit.start, at) - at;
      const e = Math.min(hit.end, end) - at;
      const mid = node.splitText(s);
      mid.splitText(e - s);
      const mark = d.createElement('mark');
      mark.setAttribute('data-books-hit', '');
      mid.parentNode.insertBefore(mark, mid);
      mark.appendChild(mid);
      first ||= mark;
    }
    return first;
  }

  // ================================================================== appearance
  stepFont(dir) {
    const v = clamp(store.pref('fontSize') + dir * FONT_SIZES.step, FONT_SIZES.min, FONT_SIZES.max);
    store.setPref('fontSize', v);
  }

  onPref(k) {
    if (this.closed) return;
    if (k === 'sidebarTab' || k === 'sort') return;
    if (k === 'theme') this.applyTheme();
    else if (k === 'layout') {
      const pos = this.position();
      this.el.dataset.layout = this.layout;
      if (this.cur && !this.cur.error) this.goTo({ ...pos, reload: true });
      else this.updateChrome();
    } else this.applyUserCss();
    if (!this.flyout.hidden) this.renderFlyout();
  }

  applyUserCss() {
    const c = this.cur;
    if (c?.doc) {
      const st = c.doc.querySelector('style[data-books="user"]');
      if (st) st.textContent = this.userCss();
    }
    this.relayout();
  }

  /** Reading theme: Clair / Sépia / Sombre (or the shell's mode), through the shell's own tokens. */
  applyTheme() {
    if (this.closed) return;
    const pref = store.pref('theme');
    const sys = effectiveTheme(this.ctx.win.el);
    const mode = pref === 'auto' ? sys : pref === 'dark' ? 'dark' : 'light';
    const reading = pref === 'auto' ? (mode === 'dark' ? 'dark' : 'light') : pref;
    const el = this.el;
    el.setAttribute('data-theme-scope', '');
    el.dataset.theme = mode;
    el.dataset.reading = reading;
    el.dataset.layout = this.layout;
    try {
      const all = this.ctx.settings.all?.() || {};
      for (const [k, v] of Object.entries(styleAccentVars(all.style, all.accent, mode))) el.style.setProperty(k, v);
    } catch {}
    const cs = getComputedStyle(this.paperProbe);
    this.colors = { paper: cs.backgroundColor, ink: cs.color, link: cs.borderTopColor, line: cs.outlineColor, scheme: mode, force: reading === 'dark' || reading === 'sepia' };
    this.applyUserCss();
  }

  toggleFlyout() {
    if (this.flyout.hidden) this.openFlyout();
    else this.closeFlyout({ focus: true });
  }

  openFlyout() {
    this.renderFlyout();
    this.flyout.hidden = false;
    this.aaBtn.setAttribute('aria-expanded', 'true');
    const r = this.aaBtn.getBoundingClientRect();
    const host = this.el.getBoundingClientRect();
    const w = this.flyout.offsetWidth;
    this.flyout.style.left = `${clamp(r.right - host.left - w, 8, host.width - w - 8)}px`;
    this.flyout.style.top = `${r.bottom - host.top + 6}px`;
    this.flyout.querySelector('button, input, select')?.focus({ preventScroll: true });
  }

  closeFlyout({ focus = false } = {}) {
    if (this.flyout.hidden) return;
    this.flyout.hidden = true;
    this.aaBtn.setAttribute('aria-expanded', 'false');
    if (focus) this.aaBtn.focus({ preventScroll: true });
  }

  renderFlyout() {
    const { h, t } = this;
    const { ui, icon } = this.ctx;
    const p = store.prefs;
    const focusedKey = document.activeElement?.closest?.('[data-pref]')?.dataset.pref;
    ui.clear(this.flyout);
    const row = (label, control, key) => h('div', { class: 'books-fly-row', dataset: { pref: key } }, h('div', { class: 'books-fly-label caption text-2' }, label), control);
    const seg = (key, options) => {
      const el = h('div', { class: 'segmented books-seg', role: 'radiogroup', 'aria-label': t(`fly.${key}`) });
      for (const [value, label] of options) {
        el.appendChild(
          h(
            'button',
            {
              type: 'button',
              role: 'radio',
              'aria-checked': String(p[key] === value),
              class: p[key] === value ? 'selected' : '',
              dataset: { value },
              tabindex: p[key] === value ? '0' : '-1',
              onclick: () => store.setPref(key, value),
            },
            label,
          ),
        );
      }
      el.addEventListener('keydown', (e) => {
        if (!['ArrowRight', 'ArrowLeft'].includes(e.key)) return;
        e.preventDefault();
        e.stopPropagation();
        const vals = options.map((o) => o[0]);
        const i = vals.indexOf(p[key]);
        const next = vals[(i + (e.key === 'ArrowRight' ? 1 : vals.length - 1)) % vals.length];
        store.setPref(key, next);
        setTimeout(() => this.flyout.querySelector(`[data-pref="${key}"] [data-value="${next}"]`)?.focus(), 0);
      });
      return el;
    };
    const size = h(
      'div',
      { class: 'books-size' },
      h('button', { type: 'button', class: 'btn icon-btn', dataset: { cmd: 'font-smaller' }, 'aria-label': t('fly.smaller'), 'data-tip': t('fly.smaller'), disabled: p.fontSize <= FONT_SIZES.min, onclick: () => this.stepFont(-1) }, h('span', { class: 'books-a-small', 'aria-hidden': 'true' }, 'A')),
      h('span', { class: 'books-size-val', 'aria-live': 'polite' }, this.ctx.i18n.formatNumber(p.fontSize / 100, { style: 'percent', maximumFractionDigits: 0 })),
      h('button', { type: 'button', class: 'btn icon-btn', dataset: { cmd: 'font-bigger' }, 'aria-label': t('fly.bigger'), 'data-tip': t('fly.bigger'), disabled: p.fontSize >= FONT_SIZES.max, onclick: () => this.stepFont(1) }, h('span', { class: 'books-a-big', 'aria-hidden': 'true' }, 'A')),
    );
    const fontSel = ui.select({ options: ['book', 'serif', 'sans', 'readable'].map((v) => ({ value: v, label: t(`font.${v}`) })), value: p.font, onchange: (v) => store.setPref('font', v) });
    fontSel.setAttribute('aria-label', t('fly.font'));
    fontSel.classList.add('books-font-select');
    const themes = h('div', { class: 'books-themes', role: 'radiogroup', 'aria-label': t('fly.theme') });
    for (const v of ['auto', 'light', 'sepia', 'dark']) {
      themes.appendChild(
        h(
          'button',
          { type: 'button', role: 'radio', class: ['books-theme', p.theme === v && 'selected'], dataset: { value: v }, 'aria-checked': String(p.theme === v), tabindex: p.theme === v ? '0' : '-1', onclick: () => store.setPref('theme', v) },
          h('span', { class: 'books-swatch', dataset: { swatch: v }, ...this.swatchScope(v) }, v === 'auto' ? icon('circle-half', { size: 16 }) : 'Aa'),
          h('span', { class: 'caption' }, t(`theme.${v}`)),
        ),
      );
    }
    themes.addEventListener('keydown', (e) => {
      if (!['ArrowRight', 'ArrowLeft'].includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      const vals = ['auto', 'light', 'sepia', 'dark'];
      const next = vals[(vals.indexOf(p.theme) + (e.key === 'ArrowRight' ? 1 : 3)) % 4];
      store.setPref('theme', next);
      setTimeout(() => this.flyout.querySelector(`[data-pref="theme"] [data-value="${next}"]`)?.focus(), 0);
    });
    const spread = ui.toggle({ checked: p.spread, label: t('fly.spread'), onchange: (v) => store.setPref('spread', v) });
    spread.classList.add('books-spread');
    this.flyout.append(
      h('div', { class: 'books-fly-title body-strong' }, t('reader.appearance')),
      row(t('fly.size'), size, 'fontSize'),
      row(t('fly.font'), fontSel, 'font'),
      row(t('fly.lineHeight'), seg('lineHeight', [['book', t('lh.book')], ['tight', t('lh.tight')], ['normal', t('lh.normal')], ['loose', t('lh.loose')]]), 'lineHeight'),
      row(t('fly.margins'), seg('margins', [['narrow', t('margins.narrow')], ['normal', t('margins.normal')], ['wide', t('margins.wide')]]), 'margins'),
      row(t('fly.align'), seg('align', [['book', t('align.book')], ['left', t('align.left')], ['justify', t('align.justify')]]), 'align'),
      row(t('fly.theme'), themes, 'theme'),
      row(t('fly.layout'), seg('layout', [['paged', t('layout.paged')], ['scroll', t('layout.scroll')]]), 'layout'),
      h('div', { class: 'books-fly-row', dataset: { pref: 'spread' } }, spread),
    );
    spread.hidden = p.layout !== 'paged';
    if (focusedKey) {
      const target = this.flyout.querySelector(`[data-pref="${focusedKey}"] [aria-checked="true"], [data-pref="${focusedKey}"] select, [data-pref="${focusedKey}"] input, [data-pref="${focusedKey}"] button:not([disabled])`);
      target?.focus({ preventScroll: true });
    }
    // Tab stays in the flyout; Escape closes it
    this.flyout.onkeydown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.closeFlyout({ focus: true });
      } else if (e.key === 'Tab') {
        const f = [...this.flyout.querySelectorAll('button:not([disabled]), select, input')].filter((x) => x.tabIndex >= 0 && x.offsetParent);
        if (!f.length) return;
        const i = f.indexOf(document.activeElement);
        if (e.shiftKey && i <= 0) {
          e.preventDefault();
          f[f.length - 1].focus();
        } else if (!e.shiftKey && i === f.length - 1) {
          e.preventDefault();
          f[0].focus();
        }
      }
    };
  }

  /** Theme-scope attributes that make a swatch use the palette of that reading theme. */
  swatchScope(v) {
    if (v === 'auto') return {};
    return { 'data-theme-scope': '', 'data-theme': v === 'dark' ? 'dark' : 'light', ...(v === 'sepia' ? { 'data-reading': 'sepia' } : {}) };
  }

  // ================================================================== window
  toggleFullscreen() {
    this.ctx.win.setFullscreen(!this.ctx.win.fullscreen);
  }

  onFullscreen(on) {
    const label = on ? this.t('reader.exitFullscreen') : `${this.t('reader.fullscreen')} (F11)`;
    this.fsBtn.setAttribute('aria-label', label);
    this.fsBtn.setAttribute('data-tip', label);
    this.ctx.ui.clear(this.fsBtn).appendChild(this.ctx.icon(on ? 'corners-in' : 'corners-out'));
    this.el.classList.toggle('fullscreen', !!on);
    this.scheduleRelayout();
  }

  moreMenu(e) {
    const { t } = this;
    if (!this.book) return;
    this.ctx.ui.menu(e, [
      { label: t('menu.info'), icon: 'info', action: () => this.app.showInfo(this.book) },
      { label: t('menu.showInFiles'), icon: 'folder-open', action: () => this.ctx.shell.launch('files', { select: this.book.path }) },
      '-',
      { label: t('reader.backToLibrary'), icon: 'books', action: () => this.app.showLibrary() },
    ]);
  }
}
