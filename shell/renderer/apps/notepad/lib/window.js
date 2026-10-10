// One Notepad window: tab strip in the title bar, menu bar, editor area (find bar, notices,
// documents), status bar and the Settings page. Commands are shared by menus and shortcuts.
import { Doc, basename, dirname } from './doc.js';
import { FindBar } from './find.js';
import { Menus } from './menu.js';
import { SettingsPage } from './settings.js';
import * as dlg from './dialogs.js';
import { decode, decodeAs, encode, unencodable, ENCODINGS, EOLS, normalizeEol } from './codec.js';
import { shared, ZOOM_MIN, ZOOM_MAX } from './shared.js';
import { accentVars } from '../../../core/theme.js';

const WARN_SIZE = 16 * 1024 * 1024;
const MAX_SIZE = 64 * 1024 * 1024;
const SESSION_TEXT_LIMIT = 8 * 1024 * 1024;
const DND_MIME = 'application/x-aurora-paths';
const ACCENT_KEYS = ['--accent', '--accent-hover', '--accent-pressed', '--accent-text', '--accent-subtle', '--on-accent', '--accent-base'];
const SEARCH_ENGINES = {
  duckduckgo: 'https://duckduckgo.com/?q=%s',
  google: 'https://www.google.com/search?q=%s',
  bing: 'https://www.bing.com/search?q=%s',
  qwant: 'https://www.qwant.com/?q=%s',
  ecosia: 'https://www.ecosia.org/search?q=%s',
  startpage: 'https://www.startpage.com/sp/search?query=%s',
};

const reduceMotion = () => document.documentElement.dataset.animations === 'off';

/** Suggested file name for "Save as": the first line of text, like Windows 11 Notepad. */
function suggestName(text) {
  const first = String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  if (!first) return '';
  const clean = first
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 48)
    .trim()
    .replace(/[. ]+$/, '');
  return clean ? `${clean}.txt` : '';
}

export class NotepadWindow {
  constructor(ctx) {
    this.ctx = ctx;
    this.win = ctx.win;
    this.h = ctx.h;
    this.icon = ctx.icon;
    this.ui = ctx.ui;
    this.t = ctx.t;
    this.api = ctx.api;
    this.shared = shared;
    this.docs = [];
    this.active = null;
    this.closing = false;
    this.themeClass = '';
    this.key = `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    this.menus = new Menus({ h: ctx.h, icon: ctx.icon, themeClass: () => this.themeClass });
    this.offs = [];
    this._stRaf = 0;
    this._findTimer = null;
    this._sessionTimer = null;
  }

  get prefs() {
    return shared.prefs;
  }
  get appName() {
    return this.ctx.i18n.name(this.ctx.manifest.name);
  }
  fmt(n) {
    return this.ctx.i18n.formatNumber(n);
  }

  // ================================================================== setup
  async init() {
    this.build();
    shared.register(this);
    shared.noteFocus(this);
    this.wire();
    this.applyPrefs();
    this.applyTheme();
    await this.openInitial();
    if (!this.docs.length) this.newTab();
    this.active?.focus();
  }

  build() {
    const { h, icon, t, win } = this;
    win.el.classList.add('np-window');
    // ---- tab strip (title bar)
    this.tabsEl = h('div', { class: 'np-tabs', role: 'tablist', 'aria-label': t('tabs.label') });
    this.newBtn = h('button', { type: 'button', class: 'np-newtab no-drag', onclick: () => this.newTab() }, icon('add', { size: 16 }));
    this.strip = h('div', { class: 'np-strip' }, this.tabsEl, this.newBtn, h('div', { class: 'np-strip-drag' }));
    win.titlebarSlot.appendChild(this.strip);
    this.tabsEl.addEventListener(
      'wheel',
      (e) => {
        if (this.tabsEl.scrollWidth <= this.tabsEl.clientWidth) return;
        e.preventDefault();
        this.tabsEl.scrollLeft += e.deltaY || e.deltaX;
      },
      { passive: false },
    );
    this.tabsEl.addEventListener('scroll', () => this.updateTabOverflow(), { passive: true });
    new ResizeObserver(() => this.revealActiveTab()).observe(this.tabsEl);

    // ---- menu bar
    this.menusEl = h('div', { class: 'np-menus', role: 'menubar' });
    this.gearBtn = h('button', { type: 'button', class: 'btn subtle icon-btn np-gear', onclick: () => this.settings.open() }, icon('settings', { size: 16 }));
    this.menubarEl = h('div', { class: 'np-menubar' }, this.menusEl, h('div', { class: 'grow' }), this.gearBtn);
    this.bar = this.menus.menubar(
      this.menusEl,
      [
        { id: 'file', label: () => t('menu.file'), key: () => t('menu.fileKey'), items: () => this.fileMenu() },
        { id: 'edit', label: () => t('menu.edit'), key: () => t('menu.editKey'), items: () => this.editMenu() },
        { id: 'view', label: () => t('menu.view'), key: () => t('menu.viewKey'), items: () => this.viewMenu() },
      ],
      { restoreFocus: () => this.active?.ta },
    );

    // ---- editor area
    this.find = new FindBar(this);
    this.noticeEl = h('div', { class: 'np-notice', hidden: true, role: 'alert' });
    this.docsEl = h('div', { class: 'np-docs' });
    this.dropEl = h('div', { class: 'np-drop', hidden: true }, h('div', { class: 'np-drop-card' }, icon('document_arrow_up', { size: 28 }), (this.dropText = h('span'))));
    this.main = h('div', { class: 'np-main' }, this.find.el, this.noticeEl, this.docsEl, this.dropEl);

    // ---- status bar
    const sep = () => h('span', { class: 'np-st-sep', 'aria-hidden': 'true' });
    this.st = {
      pos: h('span', { class: 'np-st-item np-st-pos' }),
      chars: h('span', { class: 'np-st-item np-st-chars' }),
      zoom: h('button', { type: 'button', class: 'np-st-item np-st-btn np-st-zoom', onclick: (e) => this.zoomMenu(e) }),
      eol: h('button', { type: 'button', class: 'np-st-item np-st-btn np-st-eol', onclick: (e) => this.eolMenu(e) }),
      enc: h('button', { type: 'button', class: 'np-st-item np-st-btn np-st-enc', onclick: (e) => this.encMenu(e) }),
    };
    this.statusEl = h(
      'div',
      { class: 'np-status' },
      h('div', { class: 'np-st-left' }, this.st.pos, sep(), this.st.chars),
      h('div', { class: 'np-st-right' }, this.st.zoom, sep(), this.st.eol, sep(), this.st.enc),
    );

    this.settings = new SettingsPage(this);
    this.root = h('div', { class: 'np-root' }, this.menubarEl, this.main, this.statusEl, this.settings.el);
    win.body.appendChild(this.root);
    this.relabel();
  }

  wire() {
    const { win, ctx } = this;
    this.offs.push(
      shared.on('prefs', (key) => this.applyPrefs(key)),
      shared.on('recent', () => {}),
      ctx.shell.theme.on('change', () => this.applyTheme()),
      this.api.on('shell:hotkey', (p) => {
        if (String(p?.combo || '').includes('Alt')) this.bar.altCancel();
      }),
    );
    ctx.onLangChange(() => this.relabel());
    win.el.addEventListener('keydown', (e) => this.onKey(e), true);
    // Linux pastes the primary selection on middle click into the *focused* field, wherever the
    // click lands: only allow it when the click is on a text field itself (middle click on a tab closes it).
    win.el.addEventListener(
      'mouseup',
      (e) => {
        if (e.button === 1 && !e.target.closest?.('textarea, input')) e.preventDefault();
      },
      true,
    );
    win.el.addEventListener('keyup', (e) => {
      if (e.key === 'Alt' && !this.dialogOpen() && this.bar.altUp()) e.preventDefault();
    });
    win.on('focus', () => {
      shared.noteFocus(this);
      if (this.active) this.checkExternal(this.active);
    });
    win.on('blur', () => this.bar.altCancel());
    win.onBeforeClose(() => this.beforeClose());
    ctx.onClose(() => this.destroy());
    // Ctrl + mouse wheel zoom
    this.docsEl.addEventListener(
      'wheel',
      (e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        if (e.deltaY < 0) this.zoomBy(10);
        else if (e.deltaY > 0) this.zoomBy(-10);
      },
      { passive: false },
    );
    // Drag & drop files onto the window opens them.
    const isFileDrag = (e) => {
      const types = [...(e.dataTransfer?.types || [])];
      return types.includes('Files') || types.includes(DND_MIME);
    };
    const over = (e) => {
      if (!isFileDrag(e) || this.dialogOpen()) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
      this.showDrop(true);
    };
    win.el.addEventListener('dragenter', over, true);
    win.el.addEventListener('dragover', over, true);
    win.el.addEventListener('dragleave', (e) => {
      if (!e.relatedTarget || !win.el.contains(e.relatedTarget)) this.showDrop(false);
    });
    win.el.addEventListener(
      'drop',
      (e) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        e.stopPropagation();
        this.showDrop(false);
        this.dropFiles(e.dataTransfer);
      },
      true,
    );
    // Dialogs live in the window; when one goes away with the keyboard focus inside it, the focus
    // would fall back to <body>. Put it back into the editor (or the settings page).
    this.mo = new MutationObserver((muts) => {
      if (muts.some((m) => [...m.removedNodes].some((n) => n.classList?.contains('dialog-layer')))) this.restoreFocus();
    });
    this.mo.observe(win.el, { childList: true });
    // Window-wide resizes: keep highlights aligned.
    this.ro = new ResizeObserver(() => {
      if (this.find.isOpen && this.active?.hlState) this.active.renderHighlights();
    });
    this.ro.observe(this.docsEl);
  }

  restoreFocus() {
    const a = document.activeElement;
    if (a && a !== document.body && a.isConnected) return;
    if (this.closing || this.ctx.shell.wm.focused() !== this.win || this.dialogOpen() || this.menus.isOpen) return;
    if (this.settings.isOpen) this.settings.el.focus({ preventScroll: true });
    else this.active?.focus();
  }

  destroy() {
    this.mo?.disconnect();
    for (const off of this.offs) {
      try {
        off?.();
      } catch {}
    }
    this.offs = [];
    this.ro?.disconnect();
    this.menus.close(null, { restoreFocus: false });
    clearTimeout(this._sessionTimer);
    shared.unregister(this);
  }

  async openInitial() {
    const a = this.ctx.args || {};
    if (a.restore) await this.restoreEntry(a.restore);
    else if (this.prefs.startup === 'restore' && !shared.windows.some((w) => w !== this)) {
      const entries = shared.takeSession().filter((e) => e?.tabs?.length);
      if (entries.length) {
        await this.restoreEntry(entries[0]);
        for (const e of entries.slice(1)) this.ctx.shell.launch('notepad', { newWindow: true, restore: e });
      }
    }
    if (a.file) await this.openPath(a.file);
  }

  // ================================================================== labels / prefs / theme
  relabel() {
    const { t } = this;
    const tip = (el, label, key) => {
      el.dataset.tip = key ? `${label} (${key})` : label;
      el.setAttribute('aria-label', label);
    };
    tip(this.newBtn, t('file.newTab'), 'Ctrl+N');
    tip(this.gearBtn, t('settings.title'));
    tip(this.st.zoom, t('view.zoom'));
    tip(this.st.eol, t('status.eolTip'));
    tip(this.st.enc, t('status.encTip'));
    this.tabsEl.setAttribute('aria-label', t('tabs.label'));
    this.dropText.textContent = t('drop.hint');
    this.bar.relabel();
    this.find.relabel();
    for (const d of this.docs) {
      d.ta.setAttribute('aria-label', t('editor.label'));
      this.updateTab(d);
    }
    this.renderNotice();
    this.updateTitle();
    this.updateStatus();
    this.settings.refresh();
  }

  applyPrefs(key) {
    const p = this.prefs;
    const r = this.root;
    if (!key || key === 'font' || key === 'zoom') {
      const f = p.font;
      r.style.setProperty('--np-font', dlg.fontCss(f));
      r.style.setProperty('--np-fs', `${(((Number(f.size) || 11) * 4) / 3) * ((p.zoom || 100) / 100)}px`);
      r.style.setProperty('--np-weight', String(f.weight || 400));
      r.style.setProperty('--np-style', f.italic ? 'italic' : 'normal');
    }
    if (!key || key === 'wordWrap') {
      r.classList.toggle('nowrap', !p.wordWrap);
      for (const d of this.docs) d.ta.wrap = p.wordWrap ? 'soft' : 'off';
    }
    if (!key || key === 'statusBar') this.statusEl.hidden = !p.statusBar;
    if (key === 'theme') this.applyTheme();
    if (key && ['font', 'zoom', 'wordWrap'].includes(key) && this.active) {
      requestAnimationFrame(() => {
        if (this.find.isOpen) this.active?.renderHighlights();
        this.active?.reveal();
      });
    }
    if (key === 'zoom' || !key) this.updateStatus();
    if (key && key !== 'zoom') this.settings.refresh();
  }

  applyTheme() {
    const sys = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
    const pref = this.prefs.theme;
    const eff = pref === 'light' || pref === 'dark' ? pref : sys;
    const override = eff !== sys;
    this.themeClass = override ? `np-theme-${eff}` : '';
    const el = this.win.el;
    el.classList.toggle('np-theme-light', override && eff === 'light');
    el.classList.toggle('np-theme-dark', override && eff === 'dark');
    if (override) {
      const vars = accentVars(this.ctx.settings.get('accent'), eff);
      for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, v);
    } else for (const k of ACCENT_KEYS) el.style.removeProperty(k);
  }

  // ================================================================== tabs
  newTab({ doc, activate = true, index, animate = true } = {}) {
    if (!doc) doc = new Doc(this, {});
    doc.ta.wrap = this.prefs.wordWrap ? 'soft' : 'off';
    doc.ta.setAttribute('aria-label', this.t('editor.label'));
    const at = Math.max(0, Math.min(index ?? this.docs.length, this.docs.length));
    this.buildTab(doc);
    this.flipTabs(() => {
      this.docs.splice(at, 0, doc);
      this.tabsEl.insertBefore(doc.tab.el, this.tabsEl.children[at] || null);
    }, animate ? doc.tab.el : null);
    this.docsEl.appendChild(doc.el);
    this.updateTab(doc);
    if (activate || !this.active) this.activate(doc);
    this.scheduleSession();
    return doc;
  }

  buildTab(doc) {
    const { h, icon, t } = this;
    const title = h('span', { class: 'np-tab-title' });
    const dot = h('span', { class: 'np-tab-dot', 'aria-hidden': 'true' });
    const close = h(
      'button',
      {
        type: 'button',
        class: 'np-tab-close',
        tabindex: '-1',
        onclick: (e) => {
          e.stopPropagation();
          this.closeTab(doc);
        },
      },
      icon('dismiss', { size: 12 }),
    );
    const el = h('div', { class: 'np-tab no-drag', role: 'tab', tabindex: '-1', 'aria-selected': 'false', dataset: { doc: doc.id } }, h('div', { class: 'np-tab-bg' }), title, h('span', { class: 'np-tab-state' }, dot, close));
    doc.tab = { el, title, close, dot };
    el.addEventListener('pointerdown', (e) => this.onTabPointerDown(e, doc));
    el.addEventListener('mousedown', (e) => {
      if (e.button === 1) e.preventDefault();
    });
    el.addEventListener('auxclick', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        this.closeTab(doc);
      }
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.tabMenu(e, doc);
    });
    el.addEventListener('keydown', (e) => this.onTabKey(e, doc));
    return el;
  }

  updateTab(doc) {
    if (!doc?.tab) return;
    const { t } = this;
    const { el, title, close } = doc.tab;
    title.textContent = doc.title;
    el.classList.toggle('dirty', doc.dirty);
    el.dataset.tip = doc.path || doc.title;
    el.setAttribute('aria-label', doc.dirty ? `${doc.title}, ${t('tab.unsaved')}` : doc.title);
    close.setAttribute('aria-label', t('file.closeTab'));
    close.dataset.tip = `${t('file.closeTab')} (Ctrl+W)`;
  }

  /** Keep the active tab visible in a scrolled (overflowing) tab strip. */
  revealActiveTab() {
    const el = this.active?.tab?.el;
    const strip = this.tabsEl;
    if (el && el.isConnected) {
      const tr = strip.getBoundingClientRect();
      const er = el.getBoundingClientRect();
      if (er.left < tr.left) strip.scrollLeft -= tr.left - er.left + 8;
      else if (er.right > tr.right) strip.scrollLeft += er.right - tr.right + 8;
    }
    this.updateTabOverflow();
  }
  updateTabOverflow() {
    const strip = this.tabsEl;
    strip.classList.toggle('fade-l', strip.scrollLeft > 1);
    strip.classList.toggle('fade-r', strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1);
  }

  // FLIP-animate the tab strip around a DOM change (tab added / moved / removed).
  flipTabs(change, entering = null) {
    if (reduceMotion() || !this.win.el.isConnected) {
      change();
      return;
    }
    const before = new Map(this.docs.map((d) => [d.tab.el, d.tab.el.getBoundingClientRect().left]));
    const plus = this.newBtn.getBoundingClientRect().left;
    change();
    for (const d of this.docs) {
      const el = d.tab.el;
      if (el === entering || !before.has(el)) continue;
      const dx = before.get(el) - el.getBoundingClientRect().left;
      if (Math.abs(dx) > 0.5) el.animate([{ transform: `translateX(${dx}px)` }, { transform: 'none' }], { duration: 200, easing: 'cubic-bezier(0.1, 0.9, 0.2, 1)' });
    }
    const pdx = plus - this.newBtn.getBoundingClientRect().left;
    if (Math.abs(pdx) > 0.5) this.newBtn.animate([{ transform: `translateX(${pdx}px)` }, { transform: 'none' }], { duration: 200, easing: 'cubic-bezier(0.1, 0.9, 0.2, 1)' });
    if (entering) entering.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: 'cubic-bezier(0.1, 0.9, 0.2, 1)' });
  }

  activate(doc, { focus = true } = {}) {
    if (!doc) return;
    if (this.settings.isOpen) this.settings.close();
    if (this.active === doc) {
      if (focus) doc.focus();
      return;
    }
    const prev = this.active;
    if (prev) {
      prev.clearHighlights();
      prev.hide();
      prev.tab?.el.classList.remove('active');
      prev.tab?.el.setAttribute('aria-selected', 'false');
    }
    this.active = doc;
    doc.show();
    doc.tab.el.classList.add('active');
    doc.tab.el.setAttribute('aria-selected', 'true');
    this.revealActiveTab();
    if (this.find.isOpen) this.find.search({ select: false });
    this.updateTitle();
    this.updateStatus();
    this.renderNotice();
    if (focus) doc.focus();
    this.checkExternal(doc);
    this.scheduleSession();
  }

  async closeTab(doc = this.active, { prompt = true } = {}) {
    if (!doc || !this.docs.includes(doc)) return true;
    if (prompt && doc.dirty) {
      this.activate(doc);
      const r = await dlg.askSave(this, doc);
      if (!r) return false;
      if (r === 'save' && !(await this.save(doc))) return false;
    }
    if (!this.docs.includes(doc)) return true;
    if (this.docs.length === 1) {
      // Closing the last tab closes the window (already confirmed above); nothing is left to restore.
      this.closing = true;
      clearTimeout(this._sessionTimer);
      shared.removeSessionEntry(this.key);
      this.win.close(true);
      return true;
    }
    this.removeTab(doc);
    return true;
  }

  removeTab(doc, { animate = true } = {}) {
    const i = this.docs.indexOf(doc);
    if (i < 0) return;
    const wasActive = this.active === doc;
    const el = doc.tab.el;
    const lockW = el.getBoundingClientRect().width;
    if (animate && !reduceMotion()) {
      // Fade the tab out in place, then collapse the strip.
      const ghost = el.cloneNode(true);
      ghost.classList.add('np-tab-ghost');
      ghost.style.width = `${lockW}px`;
      ghost.style.left = `${el.offsetLeft - this.tabsEl.scrollLeft}px`;
      this.tabsEl.parentElement.appendChild(ghost);
      ghost.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(6px)' }], { duration: 150, easing: 'cubic-bezier(0.7, 0, 1, 0.5)', fill: 'forwards' }).finished.then(
        () => ghost.remove(),
        () => ghost.remove(),
      );
    }
    this.flipTabs(() => {
      this.docs.splice(i, 1);
      el.remove();
    });
    doc.destroy();
    if (wasActive) {
      this.active = null;
      this.activate(this.docs[Math.min(i, this.docs.length - 1)]);
    }
    this.scheduleSession();
  }

  async closeOthers(doc) {
    for (const d of this.docs.filter((x) => x !== doc)) if (!(await this.closeTab(d))) return false;
    this.activate(doc);
    return true;
  }
  async closeRight(doc) {
    const i = this.docs.indexOf(doc);
    for (const d of this.docs.slice(i + 1)) if (!(await this.closeTab(d))) return false;
    return true;
  }

  moveTab(doc, to) {
    const from = this.docs.indexOf(doc);
    if (from < 0 || to === from) return;
    this.docs.splice(from, 1);
    this.docs.splice(to, 0, doc);
    this.tabsEl.insertBefore(doc.tab.el, this.tabsEl.children[to + (to > from ? 1 : 0)] || null);
    this.scheduleSession();
  }

  onTabPointerDown(e, doc) {
    if (e.button !== 0 || e.target.closest('.np-tab-close')) return;
    this.activate(doc);
    const el = doc.tab.el;
    const startX = e.clientX;
    const startY = e.clientY;
    const pid = e.pointerId;
    let dragging = false;
    let rects = null;
    let from = 0;
    let to = 0;
    const move = (ev) => {
      if (ev.pointerId !== pid) return;
      const dx = ev.clientX - startX;
      if (!dragging) {
        if (Math.abs(dx) < 5 && Math.abs(ev.clientY - startY) < 5) return;
        if (this.docs.length < 2) return;
        dragging = true;
        try {
          el.setPointerCapture(pid);
        } catch {}
        rects = this.docs.map((d) => d.tab.el.getBoundingClientRect());
        from = this.docs.indexOf(doc);
        to = from;
        this.tabsEl.classList.add('dragging');
        el.classList.add('drag');
      }
      const w = rects[from].width;
      const minDx = rects[0].left - rects[from].left;
      const maxDx = rects[rects.length - 1].right - rects[from].right;
      const cx = Math.max(minDx, Math.min(maxDx, dx));
      el.style.transform = `translateX(${cx}px)`;
      const center = rects[from].left + w / 2 + cx;
      to = from;
      for (let j = 0; j < rects.length; j++) {
        if (j === from) continue;
        const mid = rects[j].left + rects[j].width / 2;
        if (j > from && center >= mid) to = Math.max(to, j);
        if (j < from && center <= mid) to = Math.min(to, j);
      }
      this.docs.forEach((d, j) => {
        if (d === doc) return;
        let shift = 0;
        if (from < to && j > from && j <= to) shift = -w;
        if (from > to && j < from && j >= to) shift = w;
        d.tab.el.style.transform = shift ? `translateX(${shift}px)` : '';
      });
    };
    const up = (ev) => {
      if (ev.pointerId !== pid) return;
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      if (!dragging) {
        doc.focus();
        return;
      }
      this.tabsEl.classList.remove('dragging');
      const before = el.getBoundingClientRect().left;
      for (const d of this.docs) d.tab.el.style.transform = '';
      el.classList.remove('drag');
      if (to !== from) this.moveTab(doc, to);
      const after = el.getBoundingClientRect().left;
      if (!reduceMotion() && Math.abs(before - after) > 0.5) el.animate([{ transform: `translateX(${before - after}px)` }, { transform: 'none' }], { duration: 180, easing: 'cubic-bezier(0.1, 0.9, 0.2, 1)' });
      doc.focus();
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
  }

  onTabKey(e, doc) {
    const i = this.docs.indexOf(doc);
    let next = null;
    if (e.key === 'ArrowRight') next = this.docs[(i + 1) % this.docs.length];
    else if (e.key === 'ArrowLeft') next = this.docs[(i - 1 + this.docs.length) % this.docs.length];
    else if (e.key === 'Home') next = this.docs[0];
    else if (e.key === 'End') next = this.docs[this.docs.length - 1];
    else if (e.key === 'Delete') {
      e.preventDefault();
      this.closeTab(doc);
      return;
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      this.activate(doc);
      return;
    } else if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
      e.preventDefault();
      const r = doc.tab.el.getBoundingClientRect();
      this.tabMenu({ x: r.left + 12, y: r.bottom }, doc, true);
      return;
    }
    if (next) {
      e.preventDefault();
      this.activate(next, { focus: false });
      next.tab.el.focus();
    }
  }

  tabMenu(at, doc, keyboard = false) {
    const { t } = this;
    const i = this.docs.indexOf(doc);
    this.menus.popup(
      at,
      [
        { label: t('file.closeTab'), shortcut: 'Ctrl+W', action: () => this.closeTab(doc) },
        { label: t('tab.closeOthers'), disabled: this.docs.length < 2, action: () => this.closeOthers(doc) },
        { label: t('tab.closeRight'), disabled: i >= this.docs.length - 1, action: () => this.closeRight(doc) },
        '-',
        { label: t('tab.copyPath'), disabled: !doc.path, action: () => this.copyPath(doc) },
        { label: t('tab.openFolder'), disabled: !doc.path, action: () => this.openFolder(doc) },
      ],
      { keyboard, restore: this.active?.ta },
    );
  }

  copyPath(doc) {
    if (!doc?.path) return;
    this.api.invoke('clipboard:writeText', doc.path).catch((err) => dlg.alert(this, this.appName, err.message));
  }
  openFolder(doc) {
    if (!doc?.path) return;
    this.ctx.shell.launch('files', { select: doc.path });
  }

  // ================================================================== menus
  fileMenu() {
    const { t } = this;
    const recent = shared.recent;
    const recentItems = recent.length
      ? [
          ...recent.slice(0, 10).map((p) => ({ label: basename(p), shortcut: this.shortDir(p), tip: p, action: () => this.openRecent(p) })),
          '-',
          { label: t('file.clearRecent'), action: () => shared.clearRecent() },
        ]
      : [{ label: t('file.noRecent'), disabled: true }];
    return [
      { label: t('file.newTab'), shortcut: 'Ctrl+N', action: () => this.newTab() },
      { label: t('file.newWindow'), shortcut: 'Ctrl+Shift+N', action: () => this.newWindow() },
      { label: t('file.open'), shortcut: 'Ctrl+O', action: () => this.openDialog() },
      { label: t('file.recent'), id: 'recent', submenu: () => recentItems },
      { label: t('file.save'), shortcut: 'Ctrl+S', action: () => this.save() },
      { label: t('file.saveAs'), shortcut: 'Ctrl+Shift+S', action: () => this.saveAs() },
      { label: t('file.saveAll'), shortcut: 'Ctrl+Alt+S', action: () => this.saveAll() },
      '-',
      { label: t('file.closeTab'), shortcut: 'Ctrl+W', action: () => this.closeTab() },
      { label: t('file.closeWindow'), shortcut: 'Ctrl+Shift+W', action: () => this.win.close() },
      { label: t('file.exit'), action: () => this.exitAll() },
    ];
  }

  editMenu() {
    const { t } = this;
    const d = this.active;
    const hasSel = !!d && d.ta.selectionStart !== d.ta.selectionEnd;
    return [
      { label: t('edit.undo'), shortcut: 'Ctrl+Z', disabled: !d?.history.canUndo, action: () => this.undo() },
      { label: t('edit.redo'), shortcut: 'Ctrl+Y', disabled: !d?.history.canRedo, action: () => this.redo() },
      '-',
      { label: t('edit.cut'), shortcut: 'Ctrl+X', disabled: !hasSel, action: () => this.cut() },
      { label: t('edit.copy'), shortcut: 'Ctrl+C', disabled: !hasSel, action: () => this.copy() },
      { label: t('edit.paste'), shortcut: 'Ctrl+V', action: () => this.paste() },
      { label: t('edit.delete'), shortcut: t('keys.del'), disabled: !d, action: () => this.del() },
      '-',
      { label: t('edit.searchWeb'), shortcut: 'Ctrl+E', disabled: !hasSel, action: () => this.searchWeb() },
      { label: t('edit.find'), shortcut: 'Ctrl+F', action: () => this.find.open() },
      { label: t('edit.findNext'), shortcut: 'F3', action: () => this.find.next(1) },
      { label: t('edit.findPrev'), shortcut: 'Shift+F3', action: () => this.find.next(-1) },
      { label: t('edit.replace'), shortcut: 'Ctrl+H', action: () => this.find.open({ replace: true }) },
      { label: t('edit.goTo'), shortcut: 'Ctrl+G', action: () => this.goTo() },
      '-',
      { label: t('edit.selectAll'), shortcut: 'Ctrl+A', action: () => this.selectAll() },
      { label: t('edit.timeDate'), shortcut: 'F5', action: () => this.insertDateTime() },
      '-',
      { label: t('edit.font'), action: () => this.fontDialog() },
    ];
  }

  viewMenu() {
    const { t } = this;
    return [
      {
        label: t('view.zoom'),
        id: 'zoom',
        submenu: () => [
          { label: t('view.zoomIn'), shortcut: t('keys.plus'), disabled: this.prefs.zoom >= ZOOM_MAX, action: () => this.zoomBy(10) },
          { label: t('view.zoomOut'), shortcut: t('keys.minus'), disabled: this.prefs.zoom <= ZOOM_MIN, action: () => this.zoomBy(-10) },
          { label: t('view.zoomReset'), shortcut: 'Ctrl+0', action: () => this.setZoom(100) },
        ],
      },
      { label: t('view.statusBar'), checked: !!this.prefs.statusBar, action: () => shared.setPref('statusBar', !this.prefs.statusBar) },
      { label: t('view.wordWrap'), checked: !!this.prefs.wordWrap, action: () => shared.setPref('wordWrap', !this.prefs.wordWrap) },
    ];
  }

  editorMenu(e, doc) {
    const { t } = this;
    const hasSel = doc.ta.selectionStart !== doc.ta.selectionEnd;
    this.menus.popup(e, [
      { label: t('edit.undo'), icon: 'arrow_undo', shortcut: 'Ctrl+Z', disabled: !doc.history.canUndo, action: () => this.undo() },
      { label: t('edit.redo'), icon: 'arrow_redo', shortcut: 'Ctrl+Y', disabled: !doc.history.canRedo, action: () => this.redo() },
      '-',
      { label: t('edit.cut'), icon: 'cut', shortcut: 'Ctrl+X', disabled: !hasSel, action: () => this.cut() },
      { label: t('edit.copy'), icon: 'copy', shortcut: 'Ctrl+C', disabled: !hasSel, action: () => this.copy() },
      { label: t('edit.paste'), icon: 'clipboard_paste', shortcut: 'Ctrl+V', action: () => this.paste() },
      { label: t('edit.delete'), icon: 'delete', shortcut: t('keys.del'), disabled: !hasSel, action: () => this.del() },
      '-',
      { label: t('edit.selectAll'), icon: 'select_all_on', shortcut: 'Ctrl+A', action: () => this.selectAll() },
      { label: t('edit.searchWeb'), icon: 'globe_search', shortcut: 'Ctrl+E', disabled: !hasSel, action: () => this.searchWeb() },
    ], { restore: doc.ta });
  }

  shortDir(p) {
    const home = this.ctx.env?.home || '';
    let d = dirname(p);
    if (home && (d === home || d.startsWith(`${home}/`))) d = `~${d.slice(home.length)}`;
    return d.length > 34 ? `…${d.slice(-33)}` : d;
  }

  zoomMenu(e) {
    const { t } = this;
    this.menus.popup(e.currentTarget, [
      { label: t('view.zoomIn'), shortcut: t('keys.plus'), disabled: this.prefs.zoom >= ZOOM_MAX, action: () => this.zoomBy(10) },
      { label: t('view.zoomOut'), shortcut: t('keys.minus'), disabled: this.prefs.zoom <= ZOOM_MIN, action: () => this.zoomBy(-10) },
      { label: t('view.zoomReset'), shortcut: 'Ctrl+0', action: () => this.setZoom(100) },
    ], { restore: this.active?.ta });
  }

  eolMenu(e) {
    const d = this.active;
    if (!d) return;
    this.menus.popup(
      e.currentTarget,
      EOLS.map((k) => ({ label: this.t(`eol.${k}`), checked: d.eol === k, action: () => this.setEol(d, k) })),
      { restore: d.ta, className: 'np-menu-up' },
    );
  }

  encMenu(e) {
    const d = this.active;
    if (!d) return;
    const { t } = this;
    this.menus.popup(
      e.currentTarget,
      [
        ...ENCODINGS.map((k) => ({ label: t(`encMenu.${k}`), checked: d.encoding === k, action: () => this.setEncoding(d, k) })),
        '-',
        {
          label: t('enc.reopen'),
          disabled: !d.path,
          submenu: () => ENCODINGS.filter((k) => k !== 'utf-8-bom').map((k) => ({ label: t(`encMenu.${k}`), action: () => this.reopenWith(d, k) })),
        },
      ],
      { restore: d.ta },
    );
  }

  setEol(d, eol) {
    if (d.eol === eol) return;
    d.eol = eol;
    d.metaDirty = true;
    this.onDocChanged(d);
    this.updateStatus();
  }
  setEncoding(d, enc) {
    if (d.encoding === enc) return;
    d.encoding = enc;
    d.metaDirty = true;
    this.onDocChanged(d);
    this.updateStatus();
  }

  async reopenWith(d, enc) {
    if (!d.path) return;
    if (d.dirty) {
      const ok = await dlg.confirm(this, { title: this.appName, message: this.t('enc.reopenConfirm', { name: d.title }), ok: this.t('enc.reopenOk') });
      if (!ok) return;
    }
    try {
      const bytes = await this.api.invoke('fs:readBytes', d.path);
      const dec = decodeAs(bytes, enc);
      const st = await this.api.invoke('fs:stat', d.path);
      d.setText(dec.text);
      d.encoding = dec.encoding;
      if (dec.eol) d.eol = dec.eol;
      d.mtime = st?.mtime || d.mtime;
      d.size = st?.size || d.size;
      d.markSaved();
      this.onDocChanged(d);
    } catch (err) {
      dlg.alert(this, this.t('err.openTitle'), this.t('err.open', { name: d.title }), err.message);
    }
  }

  // ================================================================== commands: file
  newWindow() {
    return this.ctx.shell.launch('notepad', { newWindow: true });
  }

  // The file picker is ~820×560: inside a smaller window it would be clipped, so it is then shown
  // as a screen-level modal instead (like the separate dialog window Windows uses).
  pickerParent() {
    const r = this.win.el.getBoundingClientRect();
    return r.width >= 860 && r.height >= 600 ? this.win : undefined;
  }

  async openDialog() {
    const res = await this.ui.filePicker({
      mode: 'open',
      multiple: true,
      parent: this.pickerParent(),
      title: this.t('file.openTitle'),
      path: this.active?.path ? dirname(this.active.path) : undefined,
    });
    const list = Array.isArray(res) ? res : res ? [res] : [];
    this.active?.focus();
    for (const p of list) await this.openPath(p);
  }

  async openRecent(p) {
    const st = await this.api.invoke('fs:stat', p).catch(() => null);
    if (!st) {
      const ok = await dlg.confirm(this, { title: this.t('err.openTitle'), message: this.t('recent.missing', { name: basename(p) }), ok: this.t('recent.remove') });
      if (ok) shared.removeRecent(p);
      return null;
    }
    return this.openPath(p);
  }

  async openPath(path, { activate = true, quiet = false } = {}) {
    const { t } = this;
    path = String(path || '');
    if (!path) return null;
    const existing = shared.findDoc(path);
    if (existing) {
      if (existing.w !== this) existing.w.win.focus();
      existing.w.activate(existing.d);
      return existing.d;
    }
    const st = await this.api.invoke('fs:stat', path).catch(() => null);
    if (!st) {
      if (!quiet) await dlg.alert(this, t('err.openTitle'), t('err.notFound', { path }));
      return null;
    }
    if (st.dir) {
      if (!quiet) await dlg.alert(this, t('err.openTitle'), t('err.isDir', { name: basename(path) }));
      return null;
    }
    if (st.size > MAX_SIZE) {
      if (!quiet) await dlg.alert(this, t('err.openTitle'), t('err.tooBig', { name: basename(path), size: this.ctx.i18n.formatSize(st.size), max: this.ctx.i18n.formatSize(MAX_SIZE) }));
      return null;
    }
    if (st.size > WARN_SIZE && !quiet) {
      const ok = await dlg.confirm(this, { title: t('ask.bigTitle'), message: t('ask.big', { name: basename(path), size: this.ctx.i18n.formatSize(st.size) }), ok: t('ask.openAnyway') });
      if (!ok) return null;
    }
    let bytes;
    try {
      bytes = await this.api.invoke('fs:readBytes', path);
    } catch (err) {
      if (!quiet) await dlg.alert(this, t('err.openTitle'), t('err.open', { name: basename(path) }), err.message);
      return null;
    }
    const again = shared.findDoc(path); // opened meanwhile (double click)
    if (again) {
      again.w.activate(again.d);
      return again.d;
    }
    const dec = decode(bytes);
    const doc = new Doc(this, { path, text: dec.text, encoding: dec.encoding, eol: dec.eol || this.prefs.defaultEol, mtime: st.mtime, size: st.size });
    const replace = this.active?.pristine ? this.active : null;
    if (replace) {
      this.newTab({ doc, index: this.docs.indexOf(replace) + 1, activate, animate: false });
      this.removeTab(replace, { animate: false });
    } else this.newTab({ doc, activate });
    shared.addRecent(path);
    return doc;
  }

  async dropFiles(dt) {
    let paths = [];
    try {
      const raw = dt.getData(DND_MIME);
      if (raw) paths = JSON.parse(raw);
    } catch {}
    if (!paths.length) paths = [...(dt.files || [])].map((f) => this.api.pathForFile(f)).filter(Boolean);
    for (const p of paths.slice(0, 32)) {
      const st = await this.api.invoke('fs:stat', p).catch(() => null);
      if (st && !st.dir) await this.openPath(p);
    }
    this.win.focus();
  }

  showDrop(on) {
    if (!!on === !this.dropEl.hidden) return;
    this.dropEl.hidden = !on;
  }

  async save(doc = this.active) {
    if (!doc) return false;
    if (!doc.path) return this.saveAs(doc);
    return this.writeDoc(doc, doc.path);
  }

  async saveAs(doc = this.active) {
    if (!doc) return false;
    const { t } = this;
    this.activate(doc, { focus: false });
    const name = doc.path ? basename(doc.path) : suggestName(doc.text) || `${t('untitled')}.txt`;
    const dir = doc.path ? dirname(doc.path) : this.ctx.shell.xdg?.documents;
    let p = await this.ui.filePicker({ mode: 'save', name, path: dir, parent: this.pickerParent(), title: t('file.saveAs') });
    if (!p) {
      doc.focus();
      return false;
    }
    if (!/\.[^/.]+$/.test(basename(p))) {
      p = `${p}.txt`;
      if (await this.api.invoke('fs:exists', p).catch(() => false)) {
        const ok = await dlg.confirm(this, { title: t('file.saveAs'), message: t('ask.replace', { name: basename(p) }), ok: t('ask.replaceOk') });
        if (!ok) return false;
      }
    }
    const other = this.docs.find((d) => d !== doc && d.path === p);
    const ok = await this.writeDoc(doc, p);
    if (ok && other && !other.dirty) this.removeTab(other);
    doc.focus();
    return ok;
  }

  // Files first (no questions asked), then "Save as" for each unsaved Untitled tab.
  async saveAll() {
    const dirty = this.docs.filter((d) => d.dirty);
    for (const d of dirty.filter((x) => x.path)) if (!(await this.save(d))) return false;
    for (const d of dirty.filter((x) => !x.path)) {
      if (!this.docs.includes(d)) continue;
      this.activate(d);
      if (!(await this.save(d))) return false;
    }
    return true;
  }

  async writeDoc(doc, path) {
    const { t } = this;
    let enc = doc.encoding;
    const bad = unencodable(doc.text, enc);
    if (bad) {
      const v = await this.ui.dialog({
        title: t('ask.lossyTitle'),
        body: t('ask.lossy', { ch: bad, enc: t(`enc.${enc}`) }),
        parent: this.win,
        className: 'np-dialog',
        buttons: [
          { label: t('ask.lossyUtf8'), value: 'utf8', primary: true },
          { label: t('ask.lossyAnyway'), value: 'anyway' },
          { label: t('common.cancel'), value: null },
        ],
      });
      if (!v) return false;
      if (v === 'utf8') enc = 'utf-8';
    }
    try {
      const { bytes } = encode(doc.text, enc, doc.eol);
      const entry = await this.api.invoke('fs:writeBytes', path, bytes);
      doc.path = path;
      doc.encoding = enc;
      doc.mtime = entry?.mtime ?? Date.now();
      doc.size = entry?.size ?? bytes.length;
      doc.notice = null;
      doc.markSaved();
      shared.addRecent(path);
      this.onDocChanged(doc);
      this.renderNotice();
      return true;
    } catch (err) {
      await dlg.alert(this, t('err.saveTitle'), t('err.save', { name: basename(path) }), err.message);
      return false;
    }
  }

  async reload(doc) {
    if (!doc?.path) return;
    try {
      const st = await this.api.invoke('fs:stat', doc.path);
      if (!st) throw new Error(this.t('err.notFound', { path: doc.path }));
      if (st.size > MAX_SIZE) throw new Error(this.t('err.tooBig', { name: doc.title, size: this.ctx.i18n.formatSize(st.size), max: this.ctx.i18n.formatSize(MAX_SIZE) }));
      const bytes = await this.api.invoke('fs:readBytes', doc.path);
      const dec = decode(bytes);
      const caret = doc.ta.selectionStart;
      const top = doc.ta.scrollTop;
      doc.setText(dec.text);
      doc.encoding = dec.encoding;
      if (dec.eol) doc.eol = dec.eol;
      doc.mtime = st.mtime;
      doc.size = st.size;
      doc.notice = null;
      doc.markSaved();
      const c = Math.min(caret, doc.text.length);
      doc.ta.setSelectionRange(c, c);
      doc.ta.scrollTop = top;
      doc.scroll.top = top;
      this.onDocChanged(doc);
      this.renderNotice();
    } catch (err) {
      dlg.alert(this, this.t('err.openTitle'), this.t('err.open', { name: doc.title }), err.message);
    }
  }

  async checkExternal(doc) {
    if (!doc?.path || doc._checking) return;
    doc._checking = true;
    try {
      const st = await this.api.invoke('fs:stat', doc.path).catch(() => null);
      if (!this.docs.includes(doc)) return;
      if (!st) {
        if (doc.notice?.kind !== 'deleted' && !doc.notice?.dismissed) doc.notice = { kind: 'deleted' };
      } else if (st.mtime !== doc.mtime || st.size !== doc.size) {
        if (!doc.dirty) await this.reload(doc);
        else if (!doc.notice || doc.notice.kind !== 'changed') doc.notice = { kind: 'changed', mtime: st.mtime };
      }
      if (doc === this.active) this.renderNotice();
    } finally {
      doc._checking = false;
    }
  }

  renderNotice() {
    const { h, icon, t } = this;
    const d = this.active;
    const n = d?.notice;
    if (!n || n.dismissed) {
      this.noticeEl.hidden = true;
      this.noticeEl.textContent = '';
      return;
    }
    const btn = (label, fn, primary) => h('button', { type: 'button', class: ['btn', 'small', primary && 'primary'], onclick: fn }, label);
    const dismiss = () => {
      n.dismissed = true;
      if (n.kind === 'changed') {
        // Keep my version: the file on disk is now "different", so the tab stays modified.
        d.mtime = n.mtime ?? d.mtime;
        d.forceDirty = true;
        d.notice = null;
        this.onDocChanged(d);
      }
      this.renderNotice();
      d.focus();
    };
    const msg = n.kind === 'deleted' ? t('notice.deleted') : t('notice.changed');
    const actions =
      n.kind === 'deleted'
        ? [btn(t('common.save'), () => this.save(d), true), btn(t('notice.dismiss'), dismiss)]
        : [btn(t('notice.reload'), () => this.reload(d), true), btn(t('notice.keep'), dismiss)];
    this.noticeEl.replaceChildren(h('div', { class: 'infobar warning np-notice-bar' }, icon('warning', { size: 16, filled: true }), h('span', { class: 'grow' }, msg), h('span', { class: 'np-notice-actions' }, actions)));
    this.noticeEl.hidden = false;
  }

  async exitAll() {
    for (const w of [...shared.windows]) {
      const ok = await w.win.close();
      if (!ok) return false;
    }
    return true;
  }

  // ================================================================== commands: edit
  undo() {
    const d = this.active;
    if (d?.undo()) d.focus();
  }
  redo() {
    const d = this.active;
    if (d?.redo()) d.focus();
  }
  selectedText(d = this.active) {
    if (!d) return '';
    return d.text.slice(d.ta.selectionStart, d.ta.selectionEnd);
  }
  async copy() {
    const s = this.selectedText();
    if (!s) return;
    await this.api.invoke('clipboard:writeText', s).catch((err) => dlg.alert(this, this.appName, err.message));
    this.active?.focus();
  }
  async cut() {
    const d = this.active;
    const s = this.selectedText(d);
    if (!s) return;
    try {
      await this.api.invoke('clipboard:writeText', s);
      d.replaceSelection('', { kind: 'edit' });
    } catch (err) {
      dlg.alert(this, this.appName, err.message);
    }
    d.focus();
  }
  async paste() {
    const d = this.active;
    if (!d) return;
    try {
      const text = await this.api.invoke('clipboard:readText');
      if (text) d.replaceSelection(normalizeEol(String(text)), { kind: 'edit' });
    } catch (err) {
      dlg.alert(this, this.appName, err.message);
    }
    d.focus();
  }
  del() {
    const d = this.active;
    if (!d) return;
    const s = d.ta.selectionStart;
    const e = d.ta.selectionEnd;
    if (s !== e) d.replaceRange(s, e, '', { kind: 'edit' });
    else if (s < d.text.length) {
      const cp = d.text.codePointAt(s);
      d.replaceRange(s, s + (cp > 0xffff ? 2 : 1), '', { kind: 'del-fwd', select: 'start' });
    }
    d.focus();
  }
  selectAll() {
    const d = this.active;
    if (!d) return;
    d.focus();
    d.ta.select();
    this.scheduleStatus();
  }
  insertDateTime() {
    const d = this.active;
    if (!d) return;
    const now = new Date();
    const i18n = this.ctx.i18n;
    // Plain spaces (ICU uses U+202F before AM/PM), like Windows: "3:45 PM 10/10/2026" / "15:45 10/10/2026".
    const s = `${i18n.formatTime(now, { hour: 'numeric', minute: '2-digit' })} ${i18n.formatDate(now, { year: 'numeric', month: 'numeric', day: 'numeric' })}`.replace(/[\u202f\u00a0]/g, ' ');
    d.replaceSelection(s, { kind: 'edit' });
    d.focus();
  }
  async searchWeb() {
    const q = this.selectedText().trim().replace(/\s+/g, ' ').slice(0, 500);
    if (!q) return;
    let engine = 'duckduckgo';
    try {
      const prefs = await this.api.invoke('storage:get', 'browser', 'prefs', null);
      if (prefs?.engine && SEARCH_ENGINES[prefs.engine]) engine = prefs.engine;
    } catch {}
    const url = SEARCH_ENGINES[engine].replace('%s', encodeURIComponent(q).replace(/%20/g, '+'));
    this.ctx.shell.openUrl(url);
  }
  async goTo() {
    const d = this.active;
    if (!d) return;
    const n = await dlg.goToLine(this, d);
    if (n == null) {
      d.focus();
      return;
    }
    const pos = d.lineStart(n);
    d.focus();
    d.ta.setSelectionRange(pos, pos);
    d.reveal(pos, { center: true });
    this.scheduleStatus();
  }
  async fontDialog() {
    const f = await dlg.fontDialog(this);
    if (f) shared.setPref('font', f);
    this.active?.focus();
  }

  // ================================================================== commands: view
  setZoom(z) {
    const v = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(z)));
    shared.setPref('zoom', v);
  }
  zoomBy(dz) {
    this.setZoom((this.prefs.zoom || 100) + dz);
  }

  // ================================================================== status / title
  onDocChanged(doc) {
    this.updateTab(doc);
    if (doc === this.active) {
      this.updateTitle();
      this.scheduleStatus();
      if (this.find.isOpen) {
        this.find.matchesStale = true;
        clearTimeout(this._findTimer);
        this._findTimer = setTimeout(() => this.find.refresh(), 150);
      }
    }
    this.scheduleSession();
  }

  updateTitle() {
    const d = this.active;
    if (!d) return;
    this.win.setTitle(`${d.dirty ? '*' : ''}${d.title} - ${this.appName}`);
  }

  scheduleStatus() {
    if (this._stRaf) return;
    this._stRaf = requestAnimationFrame(() => {
      this._stRaf = 0;
      this.updateStatus();
    });
  }

  updateStatus() {
    const d = this.active;
    if (!d || !this.st) return;
    const { t } = this;
    const ta = d.ta;
    const s = ta.selectionStart;
    const e = ta.selectionEnd;
    const caret = ta.selectionDirection === 'backward' ? s : e;
    const { line, col } = d.lineCol(caret);
    this.st.pos.textContent = t('status.pos', { line, col });
    const total = d.text.length;
    this.st.chars.textContent = s !== e ? t('status.selChars', { count: total, sel: this.fmt(e - s), n: this.fmt(total) }) : t('status.chars', { count: total, n: this.fmt(total) });
    this.st.zoom.textContent = t('status.zoom', { zoom: this.prefs.zoom || 100 });
    this.st.eol.textContent = t(`eol.${d.eol}`);
    this.st.enc.textContent = t(`enc.${d.encoding}`);
  }

  layoutChanged() {
    if (this.find.isOpen && this.active?.hlState) requestAnimationFrame(() => this.active?.renderHighlights());
  }

  dialogOpen() {
    return !!this.win.el.querySelector(':scope > .dialog-layer:not(.closing)');
  }

  // ================================================================== keyboard
  onKey(e) {
    const layer = this.win.el.querySelector(':scope > .dialog-layer:not(.closing)');
    if (layer) {
      // A dialog is up but the keyboard is still elsewhere (it focuses itself a few ms later):
      // send the key to the dialog instead of the editor behind it.
      if (!layer.contains(e.target)) {
        const field = layer.querySelector('input:not([type=checkbox]):not([type=radio]), select, textarea, .btn.primary, button');
        if (field) field.focus();
        else {
          e.preventDefault();
          e.stopPropagation();
        }
      }
      return;
    }
    const k = e.key;
    if (k === 'Alt') {
      if (!e.repeat) this.bar.altDown();
      return;
    }
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) this.bar.altCancel();
    const ctrl = e.ctrlKey || e.metaKey;
    const lower = k.length === 1 ? k.toLowerCase() : k;
    const run = (fn) => {
      e.preventDefault();
      e.stopPropagation();
      fn();
    };
    // Menu access keys (Alt+F / Alt+E / Alt+V, localized) and F10.
    if (e.altKey && !ctrl && !e.shiftKey && k.length === 1) {
      const code = /^Key[A-Z]$/.test(e.code) ? e.code.slice(3) : k;
      if (this.bar.accessKey(code) || this.bar.accessKey(k)) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
    if (k === 'F10' && !ctrl && !e.altKey && !e.shiftKey) return run(() => this.bar.enterKeyboard());
    if (this.settings.isOpen) {
      if (ctrl && !e.altKey && ['n', 'o', 'w'].includes(lower)) {
        this.settings.close();
      } else return;
    }
    // In the find / replace fields, text editing keys belong to the field.
    const inField = !!e.target?.matches?.('input, select, textarea:not(.np-text)');
    if (k === 'F3') return run(() => this.find.next(e.shiftKey ? -1 : 1));
    if (k === 'F5' && !ctrl && !e.altKey && !inField) return run(() => this.insertDateTime());
    if (k === 'Escape' && this.find.isOpen && !ctrl) return run(() => this.find.close());
    if (!ctrl) return;
    const shift = e.shiftKey;
    const alt = e.altKey;
    const code = e.code || '';
    // Ctrl+1…9 select a tab (by physical key, so AZERTY works).
    const digit = /^Digit([1-9])$/.exec(code) || /^Numpad([1-9])$/.exec(code);
    if (digit && !shift && !alt) {
      const n = Number(digit[1]);
      const d = n === 9 ? this.docs[this.docs.length - 1] : this.docs[n - 1];
      if (d) run(() => this.activate(d));
      return;
    }
    if (k === 'Tab' || k === 'PageDown' || k === 'PageUp') {
      const dir = k === 'PageUp' || (k === 'Tab' && shift) ? -1 : 1;
      const i = this.docs.indexOf(this.active);
      return run(() => this.activate(this.docs[(i + dir + this.docs.length) % this.docs.length]));
    }
    if (k === '+' || k === '=' || code === 'NumpadAdd') return run(() => this.zoomBy(10));
    if (k === '-' || k === '_' || code === 'NumpadSubtract') return run(() => this.zoomBy(-10));
    if (k === '0' || code === 'Digit0' || code === 'Numpad0') return run(() => this.setZoom(100));
    if (alt) {
      if (lower === 's' && !shift) return run(() => this.saveAll());
      return;
    }
    switch (lower) {
      case 'n':
        return run(() => (shift ? this.newWindow() : this.newTab()));
      case 'o':
        if (!shift) return run(() => this.openDialog());
        return;
      case 's':
        return run(() => (shift ? this.saveAs() : this.save()));
      case 'w':
        return run(() => (shift ? this.win.close() : this.closeTab()));
      case 'z':
        if (inField) return;
        return run(() => (shift ? this.redo() : this.undo()));
      case 'y':
        if (!shift && !inField) return run(() => this.redo());
        return;
      case 'f':
        if (!shift) return run(() => this.find.open());
        return;
      case 'h':
        if (!shift) return run(() => this.find.open({ replace: true }));
        return;
      case 'g':
        if (!shift) return run(() => this.goTo());
        return;
      case 'e':
        if (!shift) return run(() => this.searchWeb());
        return;
      case 'p':
        // Printing is not supported; keep Chromium's print dialog away.
        return run(() => {});
      default:
    }
  }

  // ================================================================== close / session
  async beforeClose() {
    if (this.closing) return true;
    this.menus.close(null, { restoreFocus: false });
    if (this.prefs.startup === 'restore') {
      this.saveSessionNow();
      await shared.flushSession();
      this.closing = true;
      return true;
    }
    const dirty = this.docs.filter((d) => d.dirty);
    if (dirty.length === 1) {
      const d = dirty[0];
      this.activate(d);
      const r = await dlg.askSave(this, d);
      if (!r) return false;
      if (r === 'save' && !(await this.save(d))) return false;
    } else if (dirty.length > 1) {
      const r = await dlg.askSaveMany(this, dirty);
      if (!r) return false;
      if (r.action === 'save') {
        for (const d of r.docs) {
          this.activate(d);
          if (!(await this.save(d))) return false;
        }
      }
    }
    this.finishClose();
    return true;
  }

  finishClose() {
    this.closing = true;
    clearTimeout(this._sessionTimer);
    if (this.prefs.startup === 'restore') this.saveSessionNow();
    else shared.removeSessionEntry(this.key);
  }

  scheduleSession() {
    if (this.prefs.startup !== 'restore' || this.closing) return;
    clearTimeout(this._sessionTimer);
    this._sessionTimer = setTimeout(() => this.saveSessionNow(), 1200);
  }

  saveSessionNow() {
    if (this.prefs.startup !== 'restore') return;
    const tabs = this.docs
      .filter((d) => !d.pristine)
      .map((d) => {
        const keepText = d.dirty || !d.path;
        return {
          path: d.path,
          text: keepText && d.text.length <= SESSION_TEXT_LIMIT ? d.text : null,
          dirty: d.dirty,
          eol: d.eol,
          encoding: d.encoding,
          sel: [d.ta.selectionStart, d.ta.selectionEnd],
          scroll: d === this.active && !d.el.hidden ? { top: d.ta.scrollTop, left: d.ta.scrollLeft } : d.scroll,
          mtime: d.mtime,
          size: d.size,
        };
      })
      .filter((x) => x.path || x.text != null);
    if (!tabs.length) {
      shared.removeSessionEntry(this.key);
      return;
    }
    const active = Math.max(0, this.docs.filter((d) => !d.pristine).indexOf(this.active));
    shared.saveSessionEntry(this.key, { tabs, active });
  }

  async restoreEntry(entry) {
    const tabs = Array.isArray(entry?.tabs) ? entry.tabs : [];
    const made = [];
    for (const tb of tabs) {
      let doc = null;
      if (tb.text != null) {
        doc = new Doc(this, { path: tb.path || null, text: String(tb.text), encoding: tb.encoding, eol: tb.eol, mtime: tb.mtime, size: tb.size });
        if (tb.dirty) doc.forceDirty = true;
        this.newTab({ doc, activate: false, animate: false });
      } else if (tb.path) {
        doc = await this.openPath(tb.path, { activate: false, quiet: true });
      }
      if (!doc) continue;
      const len = doc.text.length;
      if (Array.isArray(tb.sel)) doc.ta.setSelectionRange(Math.min(tb.sel[0] || 0, len), Math.min(tb.sel[1] || 0, len));
      if (tb.scroll) doc.scroll = { top: Number(tb.scroll.top) || 0, left: Number(tb.scroll.left) || 0 };
      made.push(doc);
    }
    const act = made[Math.min(entry?.active || 0, made.length - 1)];
    if (act) {
      this.activate(act);
      requestAnimationFrame(() => {
        act.ta.scrollTop = act.scroll.top;
        act.ta.scrollLeft = act.scroll.left;
      });
    }
  }
}
