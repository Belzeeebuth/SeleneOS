// One PDF Reader window: document tabs in the title bar, the command bar, the sidebar frame, the
// document area (one PdfDoc per tab), the start page, find bar, flyouts, presentation mode,
// keyboard shortcuts, drag & drop and the unsaved-changes prompts.
import { PdfDoc, TOOLS, basename, dirname } from './doc.js';
import { FindBar } from './findbar.js';
import { StartPage } from './start.js';
import { shared, HIGHLIGHT_COLORS, PEN_COLORS, saveErrorText } from './shared.js';
import { engine, acquireWorker, releaseWorker } from './engine.js';
import * as dlg from './dialogs.js';
import { trustedDragPaths } from '../../../core/desktop.js';

const DND_MIME = 'application/x-aurora-paths';
const EASE = 'cubic-bezier(0.1, 0.9, 0.2, 1)';
const reduceMotion = () => document.documentElement.dataset.animations === 'off';
const ZOOM_LEVELS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
// pdf.js AnnotationEditorParamsType
const P = { FREETEXT_SIZE: 11, FREETEXT_COLOR: 12, INK_COLOR: 21, INK_THICKNESS: 22, INK_OPACITY: 23, HIGHLIGHT_COLOR: 31 };
const PRESENTATION = { NORMAL: 1, CHANGING: 2, FULLSCREEN: 3 };
let tabSeq = 0;

export class PdfWindow {
  constructor(ctx) {
    this.ctx = ctx;
    this.win = ctx.win;
    this.h = ctx.h;
    this.t = ctx.t;
    this.tabs = [];
    this.activeTab = null;
    this.closing = false;
    this.focused = true;
    this.presenting = null;
    this.flyout = null;
    this.offs = [];
    this.worker = null;
  }

  get active() {
    return this.activeTab?.doc || null;
  }
  get appName() {
    return this.ctx.i18n.name(this.ctx.manifest.name);
  }
  docs() {
    return this.tabs.map((t) => t.doc).filter(Boolean);
  }
  fmt(n) {
    return this.ctx.i18n.formatNumber(n);
  }
  /** A keyboard shortcut as the UI language writes it ("Ctrl+Shift+S" -> "Ctrl+Maj+S", "Esc" -> "Échap"). */
  key(combo) {
    return localizeKeys(combo, this.ctx.lang);
  }
  /** ui.menu with the shortcuts localized (submenus included). */
  menu(at, items, opts) {
    const fix = (list) => list.map((it) => (it && typeof it === 'object' ? { ...it, shortcut: it.shortcut && this.key(it.shortcut), submenu: Array.isArray(it.submenu) ? fix(it.submenu) : it.submenu } : it));
    return this.ctx.ui.menu(at, fix(items), opts);
  }

  // ================================================================== setup
  async init() {
    this.build();
    shared.register(this);
    shared.noteFocus(this);
    this.wire();
    const a = this.ctx.args || {};
    // Not awaited: the tab shows its loading state at once and launch() returns (relaunches reach us).
    if (a.file) this.openPath(a.file, { newTab: true });
    if (!this.tabs.length) this.newTab();
    engine().catch((err) => console.error('[pdf] pdf.js failed to load', err)); // warm up
  }

  /** The shared pdf.js worker, held while this window is open. */
  async ensureWorker() {
    const E = await engine();
    if (this.closing) return null; // closed while pdf.js was loading: never take a reference that is not released
    if (!this.workerHeld) {
      this.worker = acquireWorker(E.lib);
      this.workerHeld = true;
    }
    return this.worker;
  }

  build() {
    const { h, win } = this;
    const { icon } = this.ctx;
    win.el.classList.add('pdf-window');
    win.setMinSize?.(500, 380);
    // ---- tabs (title bar)
    this.tabsEl = h('div', { class: 'pdf-tabs', role: 'tablist' });
    this.newTabBtn = h('button', { type: 'button', class: 'pdf-newtab no-drag', onclick: () => this.newTab() }, icon('add', { size: 16 }));
    this.strip = h('div', { class: 'pdf-strip' }, this.tabsEl, this.newTabBtn, h('div', { class: 'pdf-strip-drag' }));
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

    // ---- toolbar
    this.buildToolbar();

    // ---- sidebar
    this.sideTitle = h('div', { class: 'pdf-side-title body-strong ellipsis' });
    this.pivots = {};
    const pivot = (id, ic) => {
      const b = h('button', { type: 'button', class: 'btn subtle icon-btn pdf-pivot', role: 'tab', dataset: { view: id }, onclick: () => this.setSideView(id) }, icon(ic));
      this.pivots[id] = b;
      return b;
    };
    this.sideHead = h('div', { class: 'pdf-side-head' }, h('div', { class: 'pdf-pivots', role: 'tablist' }, pivot('thumbs', 'document_one_page_multiple'), pivot('outline', 'text_bullet_list_tree'), pivot('attachments', 'attach')), this.sideTitle);
    this.sideBody = h('div', { class: 'pdf-side-body' });
    this.sideResize = h('div', { class: 'pdf-side-resize', role: 'separator', 'aria-orientation': 'vertical', tabindex: '-1' });
    this.sidebar = h('aside', { class: 'pdf-sidebar', hidden: true }, this.sideHead, this.sideBody, this.sideResize);
    this.sideResize.addEventListener('pointerdown', (e) => this.startSideResize(e));

    // ---- stage
    this.find = new FindBar(this);
    this.docsHost = h('div', { class: 'pdf-docs' });
    this.start = new StartPage(this);
    this.hint = h('div', { class: 'pdf-hint', hidden: true, role: 'status' });
    this.dropEl = h('div', { class: 'pdf-drop', hidden: true }, h('div', { class: 'pdf-drop-card' }, icon('document_arrow_up', { size: 28 }), (this.dropText = h('span'))));
    this.stage = h('div', { class: 'pdf-stage' }, this.docsHost, this.find.el, this.hint);
    this.main = h('div', { class: 'pdf-main' }, this.sidebar, this.stage);
    this.root = h('div', { class: 'pdf-root' }, this.toolbar, this.main, this.start.el, this.dropEl);
    win.body.appendChild(this.root);
    this.applyPrefs();
    this.relabel();
  }

  // ------------------------------------------------------------------ toolbar
  buildToolbar() {
    const { h } = this;
    const { icon } = this.ctx;
    this.tb = {};
    this.tbItems = []; // { el, prio, menu }
    const add = (el, prio, menu) => {
      this.tbItems.push({ el, prio, menu });
      return el;
    };
    const btn = (id, ic, onclick, cls) => {
      const b = h('button', { type: 'button', class: ['btn', 'subtle', 'icon-btn', 'pdf-tb-btn', cls], dataset: { cmd: id }, onclick }, icon(ic));
      this.tb[id] = b;
      return b;
    };
    const sep = () => h('div', { class: 'pdf-tb-sep', 'aria-hidden': 'true' });

    // page box
    this.pageInput = h('input', {
      class: 'pdf-pagebox',
      type: 'text',
      inputmode: 'numeric',
      autocomplete: 'off',
      spellcheck: false,
      onkeydown: (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const n = parseInt(this.pageInput.value, 10);
          if (this.active?.ready && Number.isFinite(n)) this.active.goToPage(n);
          this.updatePageBox();
          this.active?.focus({ preventScroll: true });
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          this.updatePageBox();
          this.active?.focus({ preventScroll: true });
        }
      },
      onblur: () => this.updatePageBox(),
      onfocus: () => this.pageInput.select(),
    });
    this.pageCount = h('span', { class: 'pdf-pagecount' });
    this.pageBox = h('div', { class: 'pdf-tb-page' }, this.pageInput, this.pageCount);

    // zoom
    this.zoomLabel = h('span', { class: 'pdf-zoom-label' });
    this.zoomBtn = h('button', { type: 'button', class: 'btn subtle pdf-tb-zoom', dataset: { cmd: 'zoomMenu' }, onclick: (e) => this.zoomMenu(e) }, this.zoomLabel, icon('chevron_down', { size: 12 }));
    this.tb.zoomMenu = this.zoomBtn;

    // layout
    this.layoutBtn = h('button', { type: 'button', class: 'btn subtle pdf-tb-split1', dataset: { cmd: 'layout' }, onclick: (e) => this.layoutMenu(e) }, (this.layoutIcon = h('span', { class: 'pdf-layout-icon' })), icon('chevron_down', { size: 12 }));
    this.tb.layout = this.layoutBtn;

    // annotation tools: [tool | chevron]
    const tool = (id, ic) => {
      const main = h('button', { type: 'button', class: 'btn subtle pdf-tool-main', dataset: { cmd: id }, 'aria-pressed': 'false', onclick: () => this.toggleTool(id) }, icon(ic), (h('span', { class: 'pdf-tool-swatch' })));
      const more = h('button', { type: 'button', class: 'btn subtle pdf-tool-more', dataset: { cmd: `${id}Options` }, onclick: (e) => this.toolFlyout(id, e.currentTarget) }, icon('chevron_down', { size: 12 }));
      this.tb[id] = main;
      this.tb[`${id}Options`] = more;
      return h('div', { class: 'pdf-tool', dataset: { tool: id } }, main, more);
    };

    const left = h(
      'div',
      { class: 'pdf-tb-group' },
      add(btn('sidebar', 'panel_left', () => this.toggleSidebar()), 100, () => ({ label: this.t('tb.sidebar'), icon: 'panel_left', checked: this.sidebarShown(), action: () => this.toggleSidebar() })),
      sep(),
      add(this.pageBox, 95, () => ({ label: this.t('tb.goto'), icon: 'document_page_number', shortcut: 'Ctrl+G', action: () => this.gotoPrompt() })),
      sep(),
      add(btn('zoomOut', 'zoom_out', () => this.active?.zoomStep(-1)), 72, () => ({ label: this.t('tb.zoomOut'), icon: 'zoom_out', shortcut: 'Ctrl+-', action: () => this.active?.zoomStep(-1) })),
      add(this.zoomBtn, 90, () => ({ label: this.t('tb.zoom'), icon: 'zoom_fit', submenu: this.zoomItems() })),
      add(btn('zoomIn', 'zoom_in', () => this.active?.zoomStep(1)), 72, () => ({ label: this.t('tb.zoomIn'), icon: 'zoom_in', shortcut: 'Ctrl+=', action: () => this.active?.zoomStep(1) })),
      sep(),
      add(btn('rotateLeft', 'arrow_rotate_counterclockwise', () => this.active?.rotate(-90)), 40, () => ({ label: this.t('tb.rotateLeft'), icon: 'arrow_rotate_counterclockwise', shortcut: 'Ctrl+[', action: () => this.active?.rotate(-90) })),
      add(btn('rotateRight', 'arrow_rotate_clockwise', () => this.active?.rotate(90)), 42, () => ({ label: this.t('tb.rotateRight'), icon: 'arrow_rotate_clockwise', shortcut: 'Ctrl+]', action: () => this.active?.rotate(90) })),
      add(this.layoutBtn, 48, () => ({ label: this.t('tb.layout'), icon: 'document_one_page_multiple', submenu: this.layoutItems() })),
    );
    const right = h(
      'div',
      { class: 'pdf-tb-group' },
      add(btn('find', 'search', () => this.find.open()), 85, () => ({ label: this.t('tb.find'), icon: 'search', shortcut: 'Ctrl+F', action: () => this.find.open() })),
      sep(),
      add(tool('highlight', 'highlight'), 66, () => ({ label: this.t('tool.highlight'), icon: 'highlight', checked: this.active?.mode === TOOLS.highlight, action: () => this.toggleTool('highlight') })),
      add(tool('ink', 'inking_tool'), 62, () => ({ label: this.t('tool.ink'), icon: 'inking_tool', checked: this.active?.mode === TOOLS.ink, action: () => this.toggleTool('ink') })),
      add(tool('text', 'text_t'), 58, () => ({ label: this.t('tool.text'), icon: 'text_t', checked: this.active?.mode === TOOLS.text, action: () => this.toggleTool('text') })),
      sep(),
      add(btn('darkPages', 'dark_theme', () => this.toggleDarkPages()), 30, () => ({ label: this.t('tb.darkPages'), icon: 'dark_theme', checked: shared.prefs.darkPages, action: () => this.toggleDarkPages() })),
      add(btn('present', 'slide_play', () => this.enterPresentation()), 52, () => ({ label: this.t('tb.present'), icon: 'slide_play', shortcut: 'F5', action: () => this.enterPresentation() })),
      sep(),
      add(btn('save', 'save', () => this.save()), 76, () => ({ label: this.t('tb.save'), icon: 'save', shortcut: 'Ctrl+S', disabled: !this.active?.dirty, action: () => this.save() })),
      add(btn('saveAs', 'save_edit', () => this.saveAs()), 36, () => ({ label: this.t('tb.saveAs'), icon: 'save_edit', shortcut: 'Ctrl+Shift+S', disabled: !this.active?.ready, action: () => this.saveAs() })),
    );
    this.moreBtn = btn('more', 'more_horizontal', (e) => this.moreMenu(e));
    this.toolbar = h('div', { class: 'pdf-toolbar', role: 'toolbar', hidden: true }, left, h('div', { class: 'pdf-tb-spacer' }), right, this.moreBtn);
    this.tbObserver = new ResizeObserver(() => this.fitToolbar());
    this.tbObserver.observe(this.toolbar);
  }

  /** Hide the least important commands until the bar fits; they move to the "…" menu (Fluent CommandBar). */
  fitToolbar() {
    if (this.toolbar.hidden || this._fitting) return;
    this._fitting = true;
    for (const it of this.tbItems) it.el.classList.remove('pdf-overflowed');
    this.updateSeparators();
    const order = [...this.tbItems].sort((a, b) => a.prio - b.prio);
    let i = 0;
    while (this.toolbar.scrollWidth > this.toolbar.clientWidth + 1 && i < order.length) {
      order[i++].el.classList.add('pdf-overflowed');
      this.updateSeparators();
    }
    this._fitting = false;
  }
  updateSeparators() {
    for (const g of this.toolbar.querySelectorAll('.pdf-tb-group')) {
      let seenItem = false;
      let pendingSep = null;
      for (const el of g.children) {
        if (el.classList.contains('pdf-tb-sep')) {
          el.classList.add('pdf-overflowed');
          if (seenItem) pendingSep = el;
          continue;
        }
        if (el.classList.contains('pdf-overflowed')) continue;
        if (pendingSep) pendingSep.classList.remove('pdf-overflowed');
        pendingSep = null;
        seenItem = true;
      }
    }
  }

  wire() {
    const { win, ctx } = this;
    ctx.onLangChange(() => this.relabel());
    this.offs.push(
      shared.on('prefs', (key) => this.applyPrefs(key)),
      ctx.shell.theme?.on?.('change', () => this.updateDarkPages()) || null,
    );
    win.el.addEventListener('keydown', (e) => this.onKey(e));
    win.on('focus', () => this.onWinFocus(true));
    win.on('blur', () => this.onWinFocus(false));
    win.on('resize', () => this.onResize());
    win.on('fullscreen', (on) => {
      if (!on && this.presenting) this.exitPresentation({ fromWm: true });
    });
    win.onBeforeClose(() => this.beforeClose());
    ctx.onClose(() => this.destroy());
    this.ro = new ResizeObserver(() => this.onResize());
    this.ro.observe(this.stage);
    // Drag & drop of PDF files (from Files, the desktop…).
    const isFileDrag = (e) => {
      const types = [...(e.dataTransfer?.types || [])];
      return types.includes('Files') || types.includes(DND_MIME);
    };
    const over = (e) => {
      if (!isFileDrag(e) || this.dialogOpen() || this.presenting) return;
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
    // Context menu, presentation clicks and external-link safety in the document area.
    this.docsHost.addEventListener('contextmenu', (e) => this.onContextMenu(e));
    this.stage.addEventListener('pointerdown', () => {
      if (this.isNarrow() && this.narrowSidebar) {
        this.narrowSidebar = false;
        this.updateSidebar();
      }
    });
    this.docsHost.addEventListener('click', (e) => this.onDocClick(e), true);
    this.docsHost.addEventListener('wheel', (e) => this.onPresentWheel(e), { passive: false });
    this.docsHost.addEventListener('pointermove', () => this.presenting && this.pokeCursor());
    // Focusing something inside an animating element can scroll overflow:hidden ancestors: undo it.
    for (const el of [win.el, win.body, this.root, this.main, this.stage]) {
      el.addEventListener('scroll', () => {
        if (el.scrollTop || el.scrollLeft) {
          el.scrollTop = 0;
          el.scrollLeft = 0;
        }
      });
    }
    // A dialog closing with the keyboard focus in it: give the focus back to the document.
    this.mo = new MutationObserver((muts) => {
      if (muts.some((m) => [...m.removedNodes].some((n) => n.classList?.contains('dialog-layer')))) this.restoreFocus();
    });
    this.mo.observe(win.el, { childList: true });
  }

  restoreFocus() {
    const a = document.activeElement;
    if (a && a !== document.body && a.isConnected) return;
    if (this.closing || this.ctx.shell.wm.focused() !== this.win || this.dialogOpen()) return;
    this.focusActive();
  }

  dialogOpen() {
    return !!this.win.el.querySelector(':scope > .dialog-layer:not(.closing)');
  }

  // ================================================================== labels / prefs
  relabel() {
    const { t } = this;
    const tip = (el, label, key) => {
      if (!el) return;
      el.dataset.tip = key ? `${label} (${this.key(key)})` : label;
      el.setAttribute('aria-label', label);
    };
    tip(this.newTabBtn, t('tabs.new'), 'Ctrl+T');
    this.tabsEl.setAttribute('aria-label', t('tabs.label'));
    this.toolbar.setAttribute('aria-label', t('tb.label'));
    tip(this.tb.sidebar, t('tb.sidebar'), 'F4');
    tip(this.pageInput, t('tb.page'), 'Ctrl+G');
    tip(this.tb.zoomOut, t('tb.zoomOut'), 'Ctrl+-');
    tip(this.tb.zoomIn, t('tb.zoomIn'), 'Ctrl+=');
    tip(this.zoomBtn, t('tb.zoom'));
    tip(this.tb.rotateLeft, t('tb.rotateLeft'), 'Ctrl+[');
    tip(this.tb.rotateRight, t('tb.rotateRight'), 'Ctrl+]');
    tip(this.layoutBtn, t('tb.layout'));
    tip(this.tb.find, t('tb.find'), 'Ctrl+F');
    tip(this.tb.highlight, t('tool.highlight'));
    tip(this.tb.highlightOptions, t('tool.highlightOptions'));
    tip(this.tb.ink, t('tool.ink'));
    tip(this.tb.inkOptions, t('tool.inkOptions'));
    tip(this.tb.text, t('tool.text'));
    tip(this.tb.textOptions, t('tool.textOptions'));
    tip(this.tb.darkPages, t('tb.darkPages'));
    tip(this.tb.present, t('tb.present'), 'F5');
    tip(this.tb.save, t('tb.save'), 'Ctrl+S');
    tip(this.tb.saveAs, t('tb.saveAs'), 'Ctrl+Shift+S');
    tip(this.tb.more, t('more'));
    tip(this.pivots.thumbs, t('sidebar.thumbs'));
    tip(this.pivots.outline, t('sidebar.outline'));
    tip(this.pivots.attachments, t('sidebar.attachments'));
    this.sideResize.setAttribute('aria-label', t('sidebar.resize'));
    this.dropText.textContent = t('drop.hint');
    this.find.relabel();
    this.start.relabel();
    for (const tab of this.tabs) this.updateTab(tab);
    for (const d of this.docs()) if (!d.ready) d.renderOverlay();
    this.updateSideTitle();
    this.refreshChrome();
    requestAnimationFrame(() => this.fitToolbar());
  }

  applyPrefs(key) {
    const p = shared.prefs;
    if (!key || key === 'sidebarWidth') this.root.style.setProperty('--pdf-side-w', `${p.sidebarWidth}px`);
    if (!key || key === 'darkPages') this.updateDarkPages();
    if (!key || key === 'sidebar' || key === 'sidebarView') this.updateSidebar();
  }

  updateDarkPages() {
    const on = !!shared.prefs.darkPages;
    this.root.classList.toggle('dark-pages', on);
    this.tb.darkPages?.classList.toggle('on', on);
    this.tb.darkPages?.setAttribute('aria-pressed', String(on));
  }

  // ================================================================== tabs
  newTab({ activate = true, index } = {}) {
    const tab = { id: `t${++tabSeq}`, doc: null };
    this.buildTab(tab);
    const at = Math.max(0, Math.min(index ?? this.tabs.length, this.tabs.length));
    this.flipTabs(() => {
      this.tabs.splice(at, 0, tab);
      this.tabsEl.insertBefore(tab.el, this.tabsEl.children[at] || null);
    }, tab.el);
    this.updateTab(tab);
    if (activate || !this.activeTab) this.activate(tab);
    return tab;
  }

  buildTab(tab) {
    const { h } = this;
    const { icon } = this.ctx;
    tab.icon = h('span', { class: 'pdf-tab-icon' });
    tab.title = h('span', { class: 'pdf-tab-title' });
    tab.close = h(
      'button',
      {
        type: 'button',
        class: 'pdf-tab-close',
        tabindex: '-1',
        onclick: (e) => {
          e.stopPropagation();
          this.closeTab(tab);
        },
      },
      icon('dismiss', { size: 12 }),
    );
    tab.dot = h('span', { class: 'pdf-tab-dot', 'aria-hidden': 'true' });
    tab.el = h('div', { class: 'pdf-tab no-drag', role: 'tab', tabindex: '-1', 'aria-selected': 'false', dataset: { tab: tab.id } }, h('div', { class: 'pdf-tab-bg' }), tab.icon, tab.title, h('span', { class: 'pdf-tab-state' }, tab.dot, tab.close));
    tab.el.addEventListener('pointerdown', (e) => this.onTabPointerDown(e, tab));
    tab.el.addEventListener('mousedown', (e) => e.button === 1 && e.preventDefault());
    tab.el.addEventListener('auxclick', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        this.closeTab(tab);
      }
    });
    tab.el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.tabMenu(e, tab);
    });
    tab.el.addEventListener('keydown', (e) => this.onTabKey(e, tab));
  }

  updateTab(tab) {
    if (!tab?.el) return;
    const { t } = this;
    const { icon, ui } = this.ctx;
    const doc = tab.doc;
    const title = doc ? doc.title : t('tabs.newTab');
    tab.title.textContent = title;
    tab.el.dataset.tip = doc ? doc.path : title;
    tab.el.classList.toggle('dirty', !!doc?.dirty);
    tab.el.setAttribute('aria-label', doc?.dirty ? `${title}, ${t('tabs.unsaved')}` : title);
    tab.close.setAttribute('aria-label', t('tabs.close'));
    tab.close.dataset.tip = `${t('tabs.close')} (${this.key('Ctrl+W')})`;
    const state = !doc ? 'start' : doc.state;
    if (tab.iconState !== state) {
      tab.iconState = state;
      ui.clear(tab.icon);
      if (state === 'loading') tab.icon.appendChild(this.h('span', { class: 'spinner small' }));
      else if (state === 'error') tab.icon.appendChild(icon('document_error', { size: 16 }));
      else tab.icon.appendChild(this.h('img', { src: this.ctx.appUrl('icon.svg'), alt: '', draggable: false }));
    }
  }

  activate(tab, { focus = true } = {}) {
    if (!tab || !this.tabs.includes(tab)) return;
    if (this.activeTab === tab) {
      if (focus) this.focusActive();
      return;
    }
    const prev = this.activeTab;
    this.closeFlyout();
    // The floating sidebar of a narrow window is a light-dismiss panel: it does not follow to another tab.
    if (this.narrowSidebar && this.isNarrow()) this.narrowSidebar = false;
    if (prev) {
      prev.el.classList.remove('active');
      prev.el.setAttribute('aria-selected', 'false');
      prev.el.tabIndex = -1;
      if (prev.doc) {
        // Inactive documents never keep an editing tool on (its listeners are global).
        if (prev.doc.mode) prev.doc.setMode(0);
        prev.doc.hide();
        if (this.find.isOpen) prev.doc.findClose();
      }
    }
    this.activeTab = tab;
    tab.el.classList.add('active');
    tab.el.setAttribute('aria-selected', 'true');
    tab.el.tabIndex = 0; // the tab strip is one Tab stop (arrow keys move between tabs)
    this.revealActiveTab();
    // Lay the document area out before showing the document (pdf.js measures it).
    this.root.classList.toggle('has-doc', !!tab.doc);
    this.toolbar.hidden = !tab.doc;
    if (tab.doc) {
      this.start.hide();
      tab.doc.show();
      if (tab.doc.tool && this.focused) tab.doc.setMode(tab.doc.tool);
    } else this.start.show();
    this.find.docChanged();
    this.updateSidebar();
    this.refreshChrome();
    if (focus) this.focusActive();
  }

  activateDoc(doc) {
    const tab = this.tabs.find((t) => t.doc === doc);
    if (tab) this.activate(tab, { focus: false });
  }

  /** Put the keyboard focus where it belongs: the document, its error page's main action, or the start page. */
  focusActive() {
    const d = this.active;
    if (!d) return this.start.focus();
    if (d.ready) return d.focus();
    const b = d.overlay.querySelector('.btn.primary');
    if (b) b.focus({ preventScroll: true });
    else this.win.body.focus({ preventScroll: true });
  }

  /** Close a tab (asking to save its changes). Resolves false when the user cancels. */
  closeTab(tab = this.activeTab, { prompt = true } = {}) {
    if (!tab || !this.tabs.includes(tab)) return Promise.resolve(true);
    // A second request while the first one is asking (double click, Ctrl+W twice…) waits for the same answer.
    if (tab.closing) return tab.closing;
    tab.closing = this.closeTabNow(tab, prompt).finally(() => (tab.closing = null));
    return tab.closing;
  }

  async closeTabNow(tab, prompt) {
    const doc = tab.doc;
    doc?.commitEdits();
    if (prompt && doc?.dirty) {
      this.activate(tab);
      if (!(await this.confirmDiscard(doc))) return false;
    }
    if (!this.tabs.includes(tab) || this.closing) return true;
    if (this.tabs.length === 1) {
      this.closing = true;
      this.win.close(true);
      return true;
    }
    this.removeTab(tab);
    return true;
  }

  /**
   * Save / Don't save / Cancel for a document with changes. Resolves true when the document may go (saved or
   * discarded). One question at a time per window: another close request meanwhile is refused (and the open
   * question is brought to attention), like a modal dialog on Windows.
   */
  async confirmDiscard(doc) {
    if (this.prompting) {
      this.nudgePrompt();
      return false;
    }
    this.prompting = true;
    try {
      const r = await dlg.askSave(doc);
      if (!r) return false;
      if (r === 'save') return await this.save(doc);
      return true;
    } finally {
      this.prompting = false;
    }
  }

  /** Draw attention to the dialog that is already open in this window. */
  nudgePrompt() {
    this.win.focus();
    const d = this.win.el.querySelector(':scope > .dialog-layer:not(.closing) .dialog');
    if (!d) return;
    (d.querySelector('.dialog-footer .btn.primary') || d).focus?.({ preventScroll: true });
    if (!reduceMotion()) d.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.02)' }, { transform: 'scale(1)' }], { duration: 240, easing: EASE });
  }

  closeDoc(doc) {
    const tab = this.tabs.find((t) => t.doc === doc);
    if (tab) this.closeTab(tab);
  }

  removeTab(tab) {
    const i = this.tabs.indexOf(tab);
    if (i < 0) return;
    const wasActive = this.activeTab === tab;
    const el = tab.el;
    if (!reduceMotion()) {
      const ghost = el.cloneNode(true);
      ghost.classList.add('pdf-tab-ghost');
      ghost.style.width = `${el.getBoundingClientRect().width}px`;
      ghost.style.left = `${el.offsetLeft - this.tabsEl.scrollLeft}px`;
      this.strip.appendChild(ghost);
      ghost.animate([{ opacity: 1 }, { opacity: 0, transform: 'translateY(6px)' }], { duration: 150, easing: 'cubic-bezier(0.7, 0, 1, 0.5)', fill: 'forwards' }).finished.then(
        () => ghost.remove(),
        () => ghost.remove(),
      );
    }
    this.flipTabs(() => {
      this.tabs.splice(i, 1);
      el.remove();
    });
    tab.doc?.destroy();
    tab.doc = null;
    if (wasActive) {
      this.activeTab = null;
      this.activate(this.tabs[Math.min(i, this.tabs.length - 1)]);
    }
  }

  flipTabs(change, entering = null) {
    if (reduceMotion() || !this.win.el.isConnected) {
      change();
      return;
    }
    const before = new Map(this.tabs.map((t) => [t.el, t.el.getBoundingClientRect().left]));
    const plus = this.newTabBtn.getBoundingClientRect().left;
    change();
    for (const t of this.tabs) {
      if (t.el === entering || !before.has(t.el)) continue;
      const dx = before.get(t.el) - t.el.getBoundingClientRect().left;
      if (Math.abs(dx) > 0.5) t.el.animate([{ transform: `translateX(${dx}px)` }, { transform: 'none' }], { duration: 200, easing: EASE });
    }
    const pdx = plus - this.newTabBtn.getBoundingClientRect().left;
    if (Math.abs(pdx) > 0.5) this.newTabBtn.animate([{ transform: `translateX(${pdx}px)` }, { transform: 'none' }], { duration: 200, easing: EASE });
    if (entering) entering.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: EASE });
  }

  revealActiveTab() {
    const el = this.activeTab?.el;
    const strip = this.tabsEl;
    if (el?.isConnected) {
      const tr = strip.getBoundingClientRect();
      const er = el.getBoundingClientRect();
      if (er.left < tr.left) strip.scrollLeft -= tr.left - er.left + 8;
      else if (er.right > tr.right) strip.scrollLeft += er.right - tr.right + 8;
    }
    this.updateTabOverflow();
  }
  updateTabOverflow() {
    const s = this.tabsEl;
    s.classList.toggle('fade-l', s.scrollLeft > 1);
    s.classList.toggle('fade-r', s.scrollLeft + s.clientWidth < s.scrollWidth - 1);
  }

  cycleTab(dir) {
    if (this.tabs.length < 2) return;
    const i = this.tabs.indexOf(this.activeTab);
    this.activate(this.tabs[(i + dir + this.tabs.length) % this.tabs.length]);
  }

  moveTab(tab, to) {
    const from = this.tabs.indexOf(tab);
    if (from < 0 || to === from) return;
    this.tabs.splice(from, 1);
    this.tabs.splice(to, 0, tab);
    this.tabsEl.insertBefore(tab.el, this.tabsEl.children[to + (to > from ? 1 : 0)] || null);
  }

  onTabPointerDown(e, tab) {
    if (e.button !== 0 || e.target.closest('.pdf-tab-close')) return;
    this.activate(tab, { focus: false });
    const el = tab.el;
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
        if ((Math.abs(dx) < 5 && Math.abs(ev.clientY - startY) < 5) || this.tabs.length < 2) return;
        dragging = true;
        try {
          el.setPointerCapture(pid);
        } catch {}
        rects = this.tabs.map((t) => t.el.getBoundingClientRect());
        from = this.tabs.indexOf(tab);
        to = from;
        this.tabsEl.classList.add('dragging');
        el.classList.add('drag');
      }
      const w = rects[from].width;
      const cx = Math.max(rects[0].left - rects[from].left, Math.min(rects.at(-1).right - rects[from].right, dx));
      el.style.transform = `translateX(${cx}px)`;
      const center = rects[from].left + w / 2 + cx;
      to = from;
      for (let j = 0; j < rects.length; j++) {
        if (j === from) continue;
        const mid = rects[j].left + rects[j].width / 2;
        if (j > from && center >= mid) to = Math.max(to, j);
        if (j < from && center <= mid) to = Math.min(to, j);
      }
      this.tabs.forEach((t, j) => {
        if (t === tab) return;
        let shift = 0;
        if (from < to && j > from && j <= to) shift = -w;
        if (from > to && j < from && j >= to) shift = w;
        t.el.style.transform = shift ? `translateX(${shift}px)` : '';
      });
    };
    const up = (ev) => {
      if (ev.pointerId !== pid) return;
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      if (!dragging) {
        this.focusActive();
        return;
      }
      this.tabsEl.classList.remove('dragging');
      const before = el.getBoundingClientRect().left;
      for (const t of this.tabs) t.el.style.transform = '';
      el.classList.remove('drag');
      if (to !== from) this.moveTab(tab, to);
      const after = el.getBoundingClientRect().left;
      if (!reduceMotion() && Math.abs(before - after) > 0.5) el.animate([{ transform: `translateX(${before - after}px)` }, { transform: 'none' }], { duration: 180, easing: EASE });
      this.focusActive();
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
  }

  onTabKey(e, tab) {
    const i = this.tabs.indexOf(tab);
    let next = null;
    if (e.key === 'ArrowRight') next = this.tabs[(i + 1) % this.tabs.length];
    else if (e.key === 'ArrowLeft') next = this.tabs[(i - 1 + this.tabs.length) % this.tabs.length];
    else if (e.key === 'Home') next = this.tabs[0];
    else if (e.key === 'End') next = this.tabs.at(-1);
    else if (e.key === 'Delete') {
      e.preventDefault();
      this.closeTab(tab);
      return;
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      this.activate(tab);
      return;
    } else if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
      e.preventDefault();
      const r = tab.el.getBoundingClientRect();
      this.tabMenu({ x: r.left + 12, y: r.bottom }, tab);
      return;
    }
    if (next) {
      e.preventDefault();
      e.stopPropagation();
      this.activate(next, { focus: false });
      next.el.focus({ preventScroll: true });
    }
  }

  tabMenu(at, tab) {
    const { t } = this;
    const i = this.tabs.indexOf(tab);
    const path = tab.doc?.path;
    this.menu(at, [
      { label: t('tabs.new'), icon: 'tab_add', shortcut: 'Ctrl+T', action: () => this.newTab() },
      '-',
      { label: t('tabs.close'), icon: 'dismiss', shortcut: 'Ctrl+W', action: () => this.closeTab(tab) },
      { label: t('tabs.closeOthers'), disabled: this.tabs.length < 2, action: () => this.closeOthers(tab) },
      { label: t('tabs.closeRight'), disabled: i >= this.tabs.length - 1, action: () => this.closeRight(tab) },
      '-',
      { label: t('start.copyPath'), icon: 'copy', disabled: !path, action: () => this.copyText(path) },
      { label: t('menu.openLocation'), icon: 'folder_open', disabled: !path, action: () => this.openLocation(path) },
    ]);
  }
  async closeOthers(tab) {
    for (const x of this.tabs.filter((y) => y !== tab)) if (!(await this.closeTab(x))) return;
    this.activate(tab);
  }
  async closeRight(tab) {
    const i = this.tabs.indexOf(tab);
    for (const x of this.tabs.slice(i + 1)) if (!(await this.closeTab(x))) return;
  }

  // ================================================================== opening
  async openDialog({ replace = null } = {}) {
    if (this.picking) return; // Ctrl+O pressed again before the picker took the keyboard
    this.picking = true;
    try {
      await this.openDialogNow(replace);
    } finally {
      this.picking = false;
    }
  }
  async openDialogNow(replace) {
    const { t, ctx } = this;
    const cur = this.active?.path;
    const xdg = await ctx.api.invoke('fs:xdg').catch(() => ({}));
    if (this.closing) return;
    const path = await ctx.ui.filePicker({
      mode: 'open',
      title: t('open.title'),
      filters: [{ name: t('open.filter'), ext: ['.pdf'] }],
      path: cur ? dirname(cur) : this.lastDir || xdg.documents,
      multiple: true,
      parent: this.win,
    });
    if (!path || this.closing) return;
    const paths = Array.isArray(path) ? path : [path];
    if (!paths.length) return;
    this.lastDir = dirname(paths[0]);
    let first = true;
    for (const p of paths) {
      await this.openPath(p, first && replace ? { replace } : {});
      first = false;
    }
  }

  /**
   * Open a file in this window: an empty start tab is reused, otherwise a new tab opens.
   * A file that is already open somewhere is simply brought to the front.
   */
  async openPath(path, { newTab = false, replace = null, initial } = {}) {
    if (!path) return null;
    const found = shared.findOpen(path);
    if (found && found.tab.doc !== replace) {
      found.win.win.focus();
      found.win.activate(found.tab);
      // A tab that failed (missing file, wrong password…) tries again.
      if (found.tab.doc.state === 'error') found.tab.doc.load({ initial });
      return found.tab.doc;
    }
    let tab = null;
    if (replace) tab = this.tabs.find((t) => t.doc === replace) || null;
    else if (!newTab && this.activeTab && !this.activeTab.doc) tab = this.activeTab;
    else if (newTab && this.activeTab && !this.activeTab.doc) tab = this.activeTab;
    if (tab?.doc) {
      tab.doc.destroy();
      tab.doc = null;
    }
    if (!tab) tab = this.newTab({ activate: false });
    const doc = new PdfDoc(this, path);
    tab.doc = doc;
    this.docsHost.appendChild(doc.el);
    this.updateTab(tab);
    if (this.activeTab === tab) {
      this.activeTab = null; // re-run activation for the new content
      tab.el.classList.remove('active');
    }
    this.activate(tab);
    await doc.load({ initial });
    return doc;
  }

  async dropFiles(dt) {
    // Shell paths only from drags that started in the shell (a web page can forge the MIME type).
    let paths = trustedDragPaths(dt);
    if (!paths.length) paths = [...(dt.files || [])].map((f) => this.ctx.api.pathForFile(f)).filter(Boolean);
    const pdfs = paths.filter((p) => typeof p === 'string' && /\.pdf$/i.test(p)).slice(0, 32);
    if (!pdfs.length) {
      if (paths.length) this.alert(this.t('drop.notPdfTitle'), this.t('drop.notPdf'));
      return;
    }
    this.win.focus();
    for (const p of pdfs) await this.openPath(p);
  }

  showDrop(on) {
    if (!!on === !this.dropEl.hidden) return;
    this.dropEl.hidden = !on;
  }

  // ================================================================== document callbacks
  onDocState(doc) {
    const tab = this.tabs.find((t) => t.doc === doc);
    if (tab) this.updateTab(tab);
    if (doc !== this.active) return;
    this.updateSidebar();
    this.refreshChrome();
    // Keyboard focus: only when this window is in front and nothing else holds the keyboard (a document
    // that finishes loading must not steal the focus from another app or from the find box).
    const a = document.activeElement;
    const idle = !a || a === document.body || a === this.win.body || a === this.win.el || this.start.el.contains(a) || doc.el.contains(a) || this.tabsEl.contains(a);
    const canFocus = this.ctx.shell.wm.focused() === this.win && !this.dialogOpen() && idle;
    if (doc.ready) {
      if (canFocus) doc.focus();
      this.find.docChanged();
    } else if (doc.state === 'error' && canFocus) {
      this.focusActive();
    }
  }
  onDocPage(doc) {
    if (doc !== this.active) return;
    this.updatePageBox();
    // Single-page views hide the page that held the focus (e.g. its text layer): keep the keyboard here.
    requestAnimationFrame(() => {
      const a = document.activeElement;
      if (doc !== this.active || this.closing || this.dialogOpen()) return;
      if ((!a || a === document.body || !a.isConnected || (doc.scroller.contains(a) && !a.offsetParent)) && this.ctx.shell.wm.focused() === this.win) doc.focus();
    });
  }
  onDocZoom(doc) {
    if (doc === this.active) this.updateZoom();
  }
  onDocFind(doc) {
    if (doc === this.active) this.find.update();
  }
  onDocTool(doc) {
    if (doc === this.active) this.updateTools();
  }
  onDocEditState() {}
  onDocDirty(doc) {
    const tab = this.tabs.find((t) => t.doc === doc);
    if (tab) this.updateTab(tab);
    if (doc === this.active) this.refreshChrome();
  }
  onDocExtras(doc) {
    if (doc === this.active) this.updateSidebar();
  }

  /** Toolbar, title, sidebar visibility for the active tab. */
  refreshChrome() {
    const doc = this.active;
    const ready = !!doc?.ready;
    const hadToolbar = !this.toolbar.hidden;
    this.toolbar.hidden = !doc;
    this.root.classList.toggle('has-doc', !!doc);
    this.toolbar.classList.toggle('disabled', !ready);
    for (const b of this.toolbar.querySelectorAll('button, input')) {
      if (b === this.moreBtn) continue;
      b.disabled = !ready;
    }
    if (ready) {
      this.tb.save.disabled = !doc.dirty || doc.saving;
    }
    this.tb.sidebar.classList.toggle('on', this.sidebarShown());
    this.tb.sidebar.setAttribute('aria-pressed', String(this.sidebarShown()));
    this.updatePageBox();
    this.updateZoom();
    this.updateLayoutIcon();
    this.updateTools();
    this.updateDarkPages();
    this.updateTitle();
    if (!hadToolbar && doc) requestAnimationFrame(() => this.fitToolbar());
  }

  updateTitle() {
    const doc = this.active;
    this.win.setTitle(doc ? `${doc.dirty ? '• ' : ''}${doc.title} - ${this.appName}` : this.appName);
  }

  updatePageBox() {
    const doc = this.active;
    const ready = !!doc?.ready;
    if (document.activeElement !== this.pageInput || !ready) this.pageInput.value = ready ? String(doc.pageNum) : '';
    this.pageCount.textContent = ready ? `/ ${this.fmt(doc.pages)}` : '';
    const digits = ready ? String(doc.pages).length : 1;
    this.pageInput.style.width = `${Math.max(2, digits) + 2.2}ch`;
  }

  updateZoom() {
    const doc = this.active;
    if (!doc?.ready || !doc.viewer) {
      this.zoomLabel.textContent = '';
      return;
    }
    this.zoomLabel.textContent = this.fmtPercent(doc.viewer.currentScale || doc.scale || 1);
  }
  fmtPercent(scale) {
    return new Intl.NumberFormat(this.ctx.i18n.locale, { style: 'percent', maximumFractionDigits: 0 }).format(scale);
  }

  updateLayoutIcon() {
    const { icon, ui } = this.ctx;
    const layout = this.active?.layout || shared.prefs.layout;
    ui.clear(this.layoutIcon);
    this.layoutIcon.appendChild(icon(layoutIcon(layout)));
  }

  updateTools() {
    const doc = this.active;
    for (const name of ['highlight', 'ink', 'text']) {
      const on = !!doc?.ready && doc.mode === TOOLS[name];
      const b = this.tb[name];
      b.classList.toggle('on', on);
      b.parentElement.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }
    const sw = (name, color) => this.tb[name]?.querySelector('.pdf-tool-swatch')?.style.setProperty('--c', color);
    sw('highlight', shared.prefs.highlightColor);
    sw('ink', shared.prefs.inkColor);
    sw('text', shared.prefs.textColor);
    this.root.classList.toggle('tool-active', !!doc?.mode);
  }

  // ================================================================== sidebar
  /** In narrow windows the sidebar floats over the page and starts closed (the preference is for wide ones). */
  isNarrow() {
    return this.root.classList.contains('narrow');
  }
  sidebarShown() {
    const want = this.isNarrow() ? !!this.narrowSidebar : !!shared.prefs.sidebar;
    return want && !!this.active?.ready && !this.presenting;
  }
  toggleSidebar(force) {
    const on = force ?? !this.sidebarShown();
    if (this.isNarrow()) {
      this.narrowSidebar = on;
      this.updateSidebar();
    } else shared.setPref('sidebar', on);
    if (on && !this.active?.ready) return;
    if (!reduceMotion() && on) this.sidebar.animate([{ opacity: 0, transform: 'translateX(-12px)' }, { opacity: 1, transform: 'none' }], { duration: 250, easing: EASE });
  }
  setSideView(view) {
    shared.setPref('sidebarView', view);
  }

  updateSidebar() {
    const doc = this.active;
    const show = this.sidebarShown();
    this.sidebar.hidden = !show;
    this.tb.sidebar?.classList.toggle('on', show);
    this.tb.sidebar?.setAttribute('aria-pressed', String(show));
    const hasAtt = !!doc?.attachments?.length;
    this.pivots.attachments.hidden = !hasAtt;
    let view = shared.prefs.sidebarView;
    if (view === 'attachments' && !hasAtt) view = 'thumbs';
    for (const [id, b] of Object.entries(this.pivots)) {
      b.classList.toggle('selected', id === view);
      b.setAttribute('aria-selected', String(id === view));
    }
    this.sideView = view;
    this.updateSideTitle();
    const panel = show ? doc.panel(view) : null;
    if (this.sidePanel && this.sidePanel !== panel) {
      this.sidePanel.detach?.();
      this.sidePanel.el.remove();
    }
    if (panel && this.sidePanel !== panel) {
      this.sideBody.replaceChildren(panel.el);
      this.sideBody.scrollTop = 0;
      panel.setWidth?.(this.thumbWidth());
      panel.attach?.(this.sideBody);
      if (!reduceMotion()) panel.el.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 200, easing: EASE });
    }
    this.sidePanel = panel;
    if (!panel) this.sideBody.replaceChildren();
    this.onResize();
  }
  /** A page was picked in the floating (narrow) sidebar: get it out of the way. */
  onSidebarPick() {
    if (this.isNarrow() && this.narrowSidebar) {
      this.narrowSidebar = false;
      this.updateSidebar();
      this.active?.focus();
    }
  }
  updateSideTitle() {
    const v = this.sideView || 'thumbs';
    this.sideTitle.textContent = this.t(`sidebar.${v}`);
  }
  thumbWidth() {
    return (shared.prefs.sidebarWidth || 232) - 72;
  }

  startSideResize(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = this.sidebar.getBoundingClientRect().width;
    this.sideResize.setPointerCapture(e.pointerId);
    this.root.classList.add('side-resizing');
    const move = (ev) => {
      const w = Math.max(160, Math.min(420, startW + ev.clientX - startX));
      this.root.style.setProperty('--pdf-side-w', `${w}px`);
      this._sideW = w;
      this.sidePanel?.setWidth?.(w - 72);
    };
    const up = () => {
      this.sideResize.removeEventListener('pointermove', move);
      this.sideResize.removeEventListener('pointerup', up);
      this.sideResize.removeEventListener('pointercancel', up);
      this.root.classList.remove('side-resizing');
      if (this._sideW) shared.setPref('sidebarWidth', Math.round(this._sideW));
      this.active?.relayout();
    };
    this.sideResize.addEventListener('pointermove', move);
    this.sideResize.addEventListener('pointerup', up);
    this.sideResize.addEventListener('pointercancel', up);
  }

  onResize() {
    const w = this.root.clientWidth;
    const narrow = w > 0 && w < 760;
    if (narrow !== this.isNarrow()) {
      this.root.classList.toggle('narrow', narrow);
      this.narrowSidebar = false;
      this.updateSidebar();
    }
    clearTimeout(this._relayoutTimer);
    this._relayoutTimer = setTimeout(() => {
      this.active?.relayout();
      this.revealActiveTab();
    }, 60);
  }

  // ================================================================== commands
  toggleTool(name) {
    const doc = this.active;
    if (!doc?.ready) return;
    const mode = TOOLS[name];
    const next = doc.mode === mode ? 0 : mode;
    doc.tool = next;
    if (next) this.applyToolParams(doc);
    if (!doc.setMode(next)) {
      doc.tool = 0;
      this.alert(this.t('tool.unavailableTitle'), this.t('tool.unavailable'));
    }
    if (!next) doc.focus();
  }
  applyToolParams(doc) {
    const p = shared.prefs;
    if (doc._paramsApplied) return;
    doc._paramsApplied = true;
    doc.setParam(P.HIGHLIGHT_COLOR, p.highlightColor);
    doc.setParam(P.INK_COLOR, p.inkColor);
    doc.setParam(P.INK_THICKNESS, p.inkThickness);
    doc.setParam(P.INK_OPACITY, p.inkOpacity / 100);
    doc.setParam(P.FREETEXT_COLOR, p.textColor);
    doc.setParam(P.FREETEXT_SIZE, p.textSize);
  }

  toggleDarkPages() {
    shared.setPref('darkPages', !shared.prefs.darkPages);
  }

  gotoPrompt() {
    const doc = this.active;
    if (!doc?.ready) return;
    if (!this.pageBox.classList.contains('pdf-overflowed') && !this.toolbar.hidden) {
      this.pageInput.focus({ preventScroll: true });
      this.pageInput.select();
    } else dlg.goToPage(doc);
  }

  async save(doc = this.active) {
    if (!doc?.ready) return false;
    doc.commitEdits();
    if (!doc.dirty) return true;
    return this.writeDoc(doc, doc.path);
  }

  async saveAs(doc = this.active) {
    if (!doc?.ready) return false;
    const { t, ctx } = this;
    this.activateDoc(doc);
    const path = await ctx.ui.filePicker({ mode: 'save', title: t('save.asTitle'), name: doc.name, path: dirname(doc.path), filters: [{ name: t('open.filter'), ext: ['.pdf'] }], parent: this.win });
    if (!path) return false;
    const other = shared.findOpen(path);
    if (other && other.tab.doc !== doc) {
      this.alert(t('save.failedTitle'), t('save.inUse', { name: basename(path) }));
      return false;
    }
    return this.writeDoc(doc, path, { rename: true });
  }

  async writeDoc(doc, path, { rename = false } = {}) {
    const { t } = this;
    if (doc.saving) return false;
    doc.saving = true;
    this.refreshChrome();
    try {
      const bytes = await doc.bytes();
      if (doc.destroyed) return false;
      const st = await this.writeFile(path, bytes);
      doc.pdf?.annotationStorage.resetModified();
      doc.setDirty(false);
      if (rename && path !== doc.path) {
        doc.path = path;
        doc.remember({ touch: true });
        doc.makeRecentThumb();
      }
      if (st?.size != null) doc.fileSize = st.size;
      this.flashHint(t('save.done', { name: basename(path) }));
      return true;
    } catch (err) {
      console.warn('[pdf] save failed', err?.code, err?.message);
      this.alert(t('save.failedTitle'), t('save.failed', { name: basename(path), error: saveErrorText(t, err) }));
      return false;
    } finally {
      doc.saving = false;
      const tab = this.tabs.find((x) => x.doc === doc);
      if (tab) this.updateTab(tab);
      this.refreshChrome();
    }
  }

  /** Write a whole PDF safely (temporary file + rename, see main/ipc/pdf.js). */
  async writeFile(path, bytes) {
    const { api } = this.ctx;
    try {
      return await api.invoke('pdf:save', path, bytes);
    } catch (err) {
      if (err?.code !== 'ENOHANDLER') throw err;
      // Older main process without the PDF backend.
      await api.invoke('fs:writeBytes', path, bytes);
      return api.invoke('fs:stat', path).catch(() => null);
    }
  }

  async openExternal(url) {
    const r = await dlg.confirmLink(this, url);
    if (r === 'open') {
      if (/^mailto:/i.test(url)) window.open(url); // the shell routes mailto: to Mail
      else this.ctx.shell.openUrl(url);
    } else if (r === 'copy') this.copyText(url);
  }

  copyText(text) {
    if (!text) return;
    this.ctx.api.invoke('clipboard:writeText', text).catch((err) => this.alert(this.t('copy.failed'), err?.message));
  }
  copySelection() {
    const text = this.active?.selectionInDoc();
    if (text) this.copyText(text);
  }

  openLocation(path) {
    if (path) this.ctx.shell.launch('files', { select: path });
  }

  async openWith(appId) {
    const doc = this.active;
    if (!doc) return;
    const id = appId || (await dlg.chooseApp(this, doc.path));
    if (id) this.ctx.shell.launch(id, { file: doc.path });
  }

  openWithItems() {
    const reg = this.ctx.shell.registry;
    const apps = dlg.openWithApps(reg).suggested;
    const items = apps.map((m) => ({ label: reg.name(m.id), icon: 'app_generic', action: () => this.openWith(m.id) }));
    if (items.length) items.push('-');
    items.push({ label: this.t('openWith.choose'), icon: 'apps', action: () => this.openWith() });
    return items;
  }

  alert(title, body) {
    return this.ctx.ui.dialog({ title, body: body || '', parent: this.win, className: 'pdf-dialog', buttons: [{ label: this.t('common.ok'), value: true, primary: true }] });
  }

  flashHint(text, ms = 2200) {
    clearTimeout(this._hintTimer);
    this.hint.textContent = text;
    this.hint.hidden = false;
    if (!reduceMotion()) this.hint.animate([{ opacity: 0, transform: 'translate(-50%, 8px)' }, { opacity: 1, transform: 'translate(-50%, 0)' }], { duration: 250, easing: EASE });
    this._hintTimer = setTimeout(() => {
      const done = () => (this.hint.hidden = true);
      if (reduceMotion()) done();
      else this.hint.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: 'linear' }).finished.then(done, done);
    }, ms);
  }

  // ================================================================== menus
  zoomItems() {
    const doc = this.active;
    const t = this.t;
    const v = doc?.scaleValue;
    const preset = (val, label, shortcut) => ({ label, shortcut, checked: v === val, action: () => doc?.setZoom(val) });
    return [
      preset('auto', t('zoom.auto'), 'Ctrl+0'),
      preset('page-actual', t('zoom.actual')),
      preset('page-fit', t('zoom.fit')),
      preset('page-width', t('zoom.width')),
      '-',
      ...ZOOM_LEVELS.map((z) => ({ label: this.fmtPercent(z), checked: typeof v === 'number' && Math.abs(v - z) < 1e-3, action: () => doc?.setZoom(z) })),
    ];
  }
  zoomMenu(e) {
    if (!this.active?.ready) return;
    this.menu(e.currentTarget, this.zoomItems(), { class: 'pdf-menu' });
  }

  layoutItems() {
    const doc = this.active;
    const cur = doc?.layout || shared.prefs.layout;
    const item = (id) => ({ label: this.t(`layout.${id}`), icon: layoutIcon(id), checked: cur === id, action: () => this.setLayout(id) });
    return [item('single'), item('continuous'), '-', item('two'), item('cover')];
  }
  layoutMenu(e) {
    if (!this.active?.ready) return;
    this.menu(e.currentTarget, this.layoutItems());
  }
  setLayout(id) {
    const doc = this.active;
    if (!doc?.ready) return;
    doc.applyLayout(id);
    shared.setPref('layout', id);
    this.updateLayoutIcon();
  }

  moreMenu(e) {
    const { t } = this;
    const doc = this.active;
    const ready = !!doc?.ready;
    const overflow = this.tbItems.filter((it) => it.el.classList.contains('pdf-overflowed')).map((it) => it.menu());
    const sel = ready && !!doc.selectionInDoc();
    this.menu(e.currentTarget, [
      { label: t('menu.open'), icon: 'folder_open', shortcut: 'Ctrl+O', action: () => this.openDialog() },
      { label: t('tabs.new'), icon: 'tab_add', shortcut: 'Ctrl+T', action: () => this.newTab() },
      ...(overflow.length ? ['-', ...overflow] : []),
      '-',
      { label: t('menu.copy'), icon: 'copy', shortcut: 'Ctrl+C', disabled: !sel, action: () => this.copySelection() },
      { label: t('menu.selectAll'), icon: 'select_all_on', shortcut: 'Ctrl+A', disabled: !ready, action: () => doc.selectAll() },
      { label: t('tb.goto'), icon: 'document_page_number', shortcut: 'Ctrl+G', disabled: !ready, action: () => this.gotoPrompt() },
      '-',
      { label: t('menu.openLocation'), icon: 'folder_open', disabled: !doc, action: () => this.openLocation(doc.path) },
      { label: t('menu.openWith'), icon: 'open', disabled: !doc, submenu: this.openWithItems() },
      { label: t('menu.properties'), icon: 'info', shortcut: 'Ctrl+D', disabled: !ready, action: () => dlg.properties(doc) },
      { label: t('menu.print'), icon: 'printer', shortcut: 'Ctrl+P', disabled: !ready, action: () => this.print() },
      '-',
      { label: t('tabs.close'), icon: 'dismiss', shortcut: 'Ctrl+W', action: () => this.closeTab() },
    ]);
  }

  // Print the PDF itself (with the annotations added here, when there are some): core/print.js.
  async print(doc = this.active) {
    if (!doc?.ready || this._printing) return null;
    this._printing = true;
    try {
      const { printDialog } = await import('../../../core/print.js');
      const edited = !!doc.dirty || doc.pdf?.annotationStorage?.size > 0;
      const data = edited || !doc.path ? await doc.bytes() : null;
      return await printDialog({ title: doc.name, parent: this.win, appId: 'pdf', shell: this.ctx?.shell, render: 'pdf', file: data ? null : doc.path, data });
    } finally {
      this._printing = false;
    }
  }

  onContextMenu(e) {
    const doc = this.active;
    if (!doc?.ready) return;
    if (this.presenting) {
      e.preventDefault();
      doc.prevPage();
      return;
    }
    // Inside a text editor (free text annotation) keep the native behaviour.
    if (e.target.closest?.('[contenteditable="true"], input, textarea')) return;
    e.preventDefault();
    const { t } = this;
    const link = e.target.closest?.('.annotationLayer a[href], a.internalLink, .linkAnnotation a');
    const href = link?.getAttribute('href') || '';
    const external = link && href && !href.startsWith('#') && /^(https?|mailto):/i.test(href);
    const sel = doc.selectionInDoc();
    const items = [];
    if (external) {
      items.push({ label: t('ctx.openLink'), icon: 'open', action: () => this.openExternal(href) }, { label: t('ctx.copyLink'), icon: 'link', action: () => this.copyText(href) }, '-');
    }
    if (sel) {
      items.push(
        { label: t('menu.copy'), icon: 'copy', shortcut: 'Ctrl+C', action: () => this.copyText(sel) },
        { label: t('ctx.highlight'), icon: 'highlight', action: () => doc.highlightSelection() },
        '-',
      );
    }
    items.push(
      { label: t('menu.selectAll'), icon: 'select_all_on', shortcut: 'Ctrl+A', action: () => doc.selectAll() },
      '-',
      { label: t('tb.rotateRight'), icon: 'arrow_rotate_clockwise', shortcut: 'Ctrl+]', action: () => doc.rotate(90) },
      { label: t('tb.rotateLeft'), icon: 'arrow_rotate_counterclockwise', shortcut: 'Ctrl+[', action: () => doc.rotate(-90) },
      '-',
      { label: t('zoom.fit'), icon: 'zoom_fit', checked: doc.scaleValue === 'page-fit', action: () => doc.setZoom('page-fit') },
      { label: t('zoom.width'), icon: 'arrow_autofit_width', checked: doc.scaleValue === 'page-width', action: () => doc.setZoom('page-width') },
      '-',
      { label: t('menu.properties'), icon: 'info', shortcut: 'Ctrl+D', action: () => dlg.properties(doc) },
    );
    this.menu(e, items);
  }

  // ================================================================== tool flyouts
  toolFlyout(name, anchor) {
    if (!this.active?.ready) return;
    if (this.flyout?.name === name) {
      this.closeFlyout();
      return;
    }
    const { h, t } = this;
    const p = shared.prefs;
    const doc = this.active;
    const body = h('div', { class: 'pdf-flyout-body' });
    const swatches = (colors, current, onPick) => {
      const row = h('div', { class: 'pdf-swatches', role: 'radiogroup', 'aria-label': t('tool.color') });
      const btns = colors.map(([id, c]) =>
        h(
          'button',
          {
            type: 'button',
            class: ['pdf-swatch', c.toUpperCase() === String(current).toUpperCase() && 'selected'],
            role: 'radio',
            'aria-checked': String(c.toUpperCase() === String(current).toUpperCase()),
            'aria-label': t(`color.${id}`),
            'data-tip': t(`color.${id}`),
            ref: (el) => el.style.setProperty('--c', c),
            tabindex: c.toUpperCase() === String(current).toUpperCase() ? '0' : '-1',
            onclick: () => {
              for (const b of btns) {
                const on = b.style.getPropertyValue('--c') === c;
                b.classList.toggle('selected', on);
                b.setAttribute('aria-checked', String(on));
                b.tabIndex = on ? 0 : -1;
              }
              onPick(c);
            },
          },
          this.ctx.icon('checkmark', { size: 12, class: 'pdf-swatch-check' }),
        ),
      );
      row.addEventListener('keydown', (e) => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
        e.preventDefault();
        const i = btns.indexOf(document.activeElement);
        const n = btns[(i + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length];
        n.focus({ preventScroll: true });
        n.click();
      });
      row.append(...btns);
      return row;
    };
    const slider = (label, min, max, step, value, fmt, onInput) => {
      const val = h('span', { class: 'caption text-2 pdf-fly-val' }, fmt(value));
      const s = this.ctx.ui.slider({
        min,
        max,
        step,
        value,
        oninput: (v) => {
          val.textContent = fmt(v);
          onInput(v);
        },
      });
      s.setAttribute('aria-label', label);
      return h('div', { class: 'pdf-fly-row' }, h('div', { class: 'pdf-fly-label' }, h('span', null, label), val), s);
    };
    if (name === 'highlight') {
      body.append(
        h('div', { class: 'pdf-fly-title caption' }, t('tool.color')),
        swatches(HIGHLIGHT_COLORS, p.highlightColor, (c) => {
          shared.setPref('highlightColor', c);
          doc.setParam(P.HIGHLIGHT_COLOR, c);
          this.updateTools();
        }),
      );
    } else if (name === 'ink') {
      body.append(
        h('div', { class: 'pdf-fly-title caption' }, t('tool.color')),
        swatches(PEN_COLORS, p.inkColor, (c) => {
          shared.setPref('inkColor', c);
          doc.setParam(P.INK_COLOR, c);
          this.updateTools();
        }),
        slider(t('tool.thickness'), 1, 20, 1, p.inkThickness, (v) => this.fmt(v), (v) => {
          shared.setPref('inkThickness', v);
          doc.setParam(P.INK_THICKNESS, v);
        }),
        slider(t('tool.opacity'), 10, 100, 5, p.inkOpacity, (v) => this.fmtPercent(v / 100), (v) => {
          shared.setPref('inkOpacity', v);
          doc.setParam(P.INK_OPACITY, v / 100);
        }),
      );
    } else if (name === 'text') {
      body.append(
        h('div', { class: 'pdf-fly-title caption' }, t('tool.color')),
        swatches(PEN_COLORS, p.textColor, (c) => {
          shared.setPref('textColor', c);
          doc.setParam(P.FREETEXT_COLOR, c);
          this.updateTools();
        }),
        slider(t('tool.size'), 8, 72, 1, p.textSize, (v) => `${this.fmt(v)} pt`, (v) => {
          shared.setPref('textSize', v);
          doc.setParam(P.FREETEXT_SIZE, v);
        }),
      );
    }
    this.openFlyout(name, anchor, body);
  }

  openFlyout(name, anchor, body) {
    this.closeFlyout();
    const el = this.h('div', { class: 'pdf-flyout', role: 'dialog', 'aria-label': this.t(`tool.${name}Options`) }, body);
    this.win.el.appendChild(el);
    const wr = this.win.el.getBoundingClientRect();
    const ar = anchor.getBoundingClientRect();
    const fr = el.getBoundingClientRect();
    let left = ar.left - wr.left + ar.width / 2 - fr.width / 2;
    left = Math.max(8, Math.min(wr.width - fr.width - 8, left));
    el.style.left = `${left}px`;
    el.style.top = `${ar.bottom - wr.top + 6}px`;
    anchor.setAttribute('aria-expanded', 'true');
    const outside = (e) => {
      if (!el.contains(e.target) && !anchor.contains(e.target)) this.closeFlyout();
    };
    const keys = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.closeFlyout();
        anchor.focus({ preventScroll: true });
      }
    };
    setTimeout(() => document.addEventListener('pointerdown', outside, true));
    el.addEventListener('keydown', keys);
    this.flyout = {
      name,
      el,
      close: () => {
        document.removeEventListener('pointerdown', outside, true);
        anchor.setAttribute('aria-expanded', 'false');
        if (reduceMotion()) el.remove();
        else el.animate([{ opacity: 1 }, { opacity: 0, transform: 'translateY(-4px)' }], { duration: 120, easing: 'linear', fill: 'forwards' }).finished.then(() => el.remove(), () => el.remove());
      },
    };
    setTimeout(() => (el.querySelector('[tabindex="0"], button, input') || el).focus({ preventScroll: true }), 30);
  }
  closeFlyout() {
    const f = this.flyout;
    this.flyout = null;
    f?.close();
  }

  // ================================================================== presentation
  async enterPresentation() {
    const doc = this.active;
    if (!doc?.ready || this.presenting) return;
    const { viewer: V } = doc.E;
    const v = doc.viewer;
    this.find.close({ focusDoc: false });
    this.closeFlyout();
    this.ctx.ui.closeMenus?.();
    doc.setMode(0);
    this.presenting = { doc, scrollMode: v.scrollMode, spreadMode: v.spreadMode, scaleValue: doc.scaleValue, page: v.currentPageNumber, wasFullscreen: !!this.win.fullscreen };
    v.presentationModeState = PRESENTATION.CHANGING;
    this.root.classList.add('presenting');
    this.win.setFullscreen(true);
    this.updateSidebar();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    if (!this.presenting || doc.destroyed) return;
    v.scrollMode = V.ScrollMode.PAGE;
    v.spreadMode = V.SpreadMode.NONE;
    v.presentationModeState = PRESENTATION.FULLSCREEN;
    v.currentPageNumber = this.presenting.page;
    v.currentScaleValue = 'page-fit';
    doc.scroller.focus({ preventScroll: true });
    this.flashHint(this.t('present.hint'), 2600);
    this.pokeCursor();
    // Keys typed while the focus fell on <body> still drive the presentation (the window covers the screen).
    this._presentKeys = (e) => {
      if (e.target === document.body || e.target === document.documentElement) this.onKey(e);
    };
    document.addEventListener('keydown', this._presentKeys);
  }

  exitPresentation({ fromWm = false } = {}) {
    const st = this.presenting;
    if (!st) return;
    this.presenting = null;
    document.removeEventListener('keydown', this._presentKeys);
    this._presentKeys = null;
    clearTimeout(this._cursorTimer);
    this.root.classList.remove('presenting', 'hide-cursor');
    const { doc } = st;
    if (!fromWm) this.win.setFullscreen(st.wasFullscreen);
    if (!doc.destroyed && doc.viewer) {
      const v = doc.viewer;
      const page = v.currentPageNumber;
      v.presentationModeState = PRESENTATION.NORMAL;
      v.scrollMode = st.scrollMode;
      v.spreadMode = st.spreadMode;
      v.currentScaleValue = String(st.scaleValue);
      v.currentPageNumber = page;
      if (doc.tool) doc.setMode(doc.tool);
    }
    this.hint.hidden = true;
    this.updateSidebar();
    this.refreshChrome();
    doc.focus();
  }

  onDocClick(e) {
    if (!this.presenting) return;
    if (e.button !== 0 || e.target.closest?.('a, button, input, select, textarea, .annotationLayer section')) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.shiftKey) this.active?.prevPage();
    else this.active?.nextPage();
    this.active?.focus();
  }
  onPresentWheel(e) {
    if (!this.presenting || e.ctrlKey) return;
    e.preventDefault();
    const now = performance.now();
    if (now - (this._presentWheel || 0) < 350 || Math.abs(e.deltaY) < 4) return;
    this._presentWheel = now;
    if (e.deltaY > 0) this.active?.nextPage();
    else this.active?.prevPage();
  }
  pokeCursor() {
    this.root.classList.remove('hide-cursor');
    clearTimeout(this._cursorTimer);
    this._cursorTimer = setTimeout(() => this.presenting && this.root.classList.add('hide-cursor'), 2000);
  }

  // ================================================================== keyboard
  onKey(e) {
    if (e.defaultPrevented || this.closing) return;
    if (e.target.closest?.('.dialog-layer') || document.querySelector('body > .menu')) return;
    const doc = this.active;
    const ready = !!doc?.ready;
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key;
    const lower = k.length === 1 ? k.toLowerCase() : k;
    const inField = isEditable(e.target);
    const run = (fn) => {
      e.preventDefault();
      e.stopPropagation();
      fn();
    };

    // Tab / Shift+Tab cycle inside the window (inside an open flyout) instead of walking out to the taskbar.
    if (k === 'Tab' && !ctrl && !e.altKey) {
      if (this.presenting) return run(() => {});
      const root = this.flyout?.el.contains(e.target) ? this.flyout.el : this.win.el;
      wrapTab(e, root);
      return;
    }
    if (k === 'F6' && !ctrl && !e.altKey && !this.presenting) return run(() => this.focusRegion(e.shiftKey ? -1 : 1));

    if (this.presenting) {
      if (k === 'Escape' || k === 'F5' || k === 'F11') return run(() => this.exitPresentation());
      if (['ArrowRight', 'ArrowDown', 'PageDown', 'Enter', 'n', 'N'].includes(k) || (k === ' ' && !e.shiftKey)) return run(() => doc?.nextPage());
      if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace', 'p', 'P'].includes(k) || (k === ' ' && e.shiftKey)) return run(() => doc?.prevPage());
      if (k === 'Home') return run(() => doc?.goToPage(1));
      if (k === 'End') return run(() => doc?.goToPage(doc.pages));
      if (ctrl && (k === '=' || k === '+' || k === '-' || k === '0')) return run(() => {});
      return;
    }

    if (ctrl && !e.altKey) {
      if (k === 'Tab') return run(() => this.cycleTab(e.shiftKey ? -1 : 1));
      if (k === 'PageDown') return run(() => this.cycleTab(1));
      if (k === 'PageUp') return run(() => this.cycleTab(-1));
      if (lower === 'o') return run(() => this.openDialog());
      if (lower === 't') return run(() => this.newTab());
      if (lower === 'w' || k === 'F4') return run(() => this.closeTab());
      if (lower === 's' && e.shiftKey) return run(() => ready && this.saveAs());
      if (lower === 's') return run(() => ready && this.save());
      if (lower === 'p') return run(() => ready && !e.shiftKey && this.print()); // the Selene print dialog
      if (!ready) return;
      if (lower === 'f') return run(() => this.find.open());
      if (lower === 'g') return run(() => this.gotoPrompt());
      if (lower === 'd') return run(() => dlg.properties(doc));
      if (k === '=' || k === '+' || e.code === 'NumpadAdd') return run(() => doc.zoomStep(1));
      if (k === '-' || e.code === 'NumpadSubtract') return run(() => doc.zoomStep(-1));
      if (k === '0' || e.code === 'Numpad0') return run(() => doc.setZoom('auto'));
      if (k === ']') return run(() => doc.rotate(90));
      if (k === '[') return run(() => doc.rotate(-90));
      if (inField) return;
      if (lower === 'a' && !doc.mode) return run(() => doc.selectAll());
      if (lower === 'c' && !doc.mode) {
        const sel = doc.selectionInDoc();
        if (sel) return run(() => this.copyText(sel));
        return;
      }
      if (!doc.mode && (lower === 'z' || lower === 'y')) return run(() => doc.editingAction(lower === 'y' || e.shiftKey ? 'redo' : 'undo'));
      return;
    }
    if (k === 'F3') return run(() => ready && this.find.next(e.shiftKey));
    if (k === 'F4' && !e.altKey) return run(() => ready && this.toggleSidebar());
    if (k === 'F5' || k === 'F11') return run(() => ready && this.enterPresentation());
    if (!ready || inField || e.altKey) return;
    if (k === 'Escape') {
      if (this.find.isOpen) return run(() => this.find.close());
      // (inside a text annotation, the first Escape is the editor's: it commits the text)
      if (doc.mode) return run(() => this.toggleTool(toolName(doc.mode)));
      return;
    }
    // Let the annotation editor move / delete selected annotations.
    if (doc.mode && doc.uiManager?.hasSelection) return;
    if (e.target.closest?.('.pdf-thumbs, .pdf-outline, .pdf-attachments, .pdf-tabs, .pdf-toolbar, .pdf-flyout, .pdf-find')) return;
    // Shift + arrows / Home / End extend a text selection natively.
    if (e.shiftKey && k !== ' ') return;
    const sc = doc.scroller;
    const pageMode = doc.layout === 'single' || doc.scaleValue === 'page-fit';
    const noHScroll = sc.scrollWidth <= sc.clientWidth + 1;
    if (k === 'Home') return run(() => doc.goToPage(1));
    if (k === 'End') return run(() => doc.goToPage(doc.pages));
    if (k === 'PageDown' || (k === ' ' && !e.shiftKey)) return run(() => (pageMode ? doc.nextPage() : scrollBy(sc, sc.clientHeight - 40)));
    if (k === 'PageUp' || (k === ' ' && e.shiftKey)) return run(() => (pageMode ? doc.prevPage() : scrollBy(sc, -(sc.clientHeight - 40))));
    if (k === 'ArrowDown') return run(() => (pageMode && sc.scrollHeight <= sc.clientHeight + 1 ? doc.nextPage() : scrollBy(sc, 48)));
    if (k === 'ArrowUp') return run(() => (pageMode && sc.scrollHeight <= sc.clientHeight + 1 ? doc.prevPage() : scrollBy(sc, -48)));
    if (k === 'ArrowRight') return run(() => (noHScroll ? doc.nextPage() : scrollBy(sc, 0, 48)));
    if (k === 'ArrowLeft') return run(() => (noHScroll ? doc.prevPage() : scrollBy(sc, 0, -48)));
  }

  /** F6 / Shift+F6: tab strip -> command bar -> sidebar -> document (or start page) -> … */
  focusRegion(dir) {
    const visible = (el) => el && !el.closest('[hidden]') && el.getClientRects().length > 0;
    const first = (root) => tabStops(root)[0] || null;
    const regions = [
      { root: this.strip, target: () => this.activeTab?.el },
      { root: this.toolbar, target: () => first(this.toolbar) },
      { root: this.sidebar, target: () => this.sidePanel?.el.querySelector('[tabindex="0"]') || this.sidePanel?.el || first(this.sidebar) },
      { root: this.find.el, target: () => this.find.input },
      { root: this.docsHost, target: () => (this.active?.ready ? this.active.scroller : this.active?.overlay.querySelector('.btn.primary') || first(this.active?.overlay || this.docsHost)) },
      { root: this.start.el, target: () => this.start.list.querySelector('.pdf-recent-row') || this.start.openBtn },
    ].filter((r) => visible(r.root) && visible(r.target()));
    if (!regions.length) return;
    const a = document.activeElement;
    let cur = regions.findIndex((r) => r.root.contains(a));
    if (cur < 0) cur = dir > 0 ? -1 : 0;
    const next = regions[(cur + dir + regions.length) % regions.length];
    next.target()?.focus({ preventScroll: true });
  }

  onWinFocus(on) {
    this.focused = on;
    if (on) shared.noteFocus(this);
    const doc = this.active;
    if (!doc?.ready || !doc.uiManager) return;
    // The annotation editor listens to the whole shell: park it while another window is in front.
    if (!on) {
      doc.commitEdits();
      if (doc.mode === TOOLS.highlight) doc.setMode(0);
      else if (doc.mode) doc.uiManager.removeEditListeners?.();
      this.closeFlyout();
    } else if (doc.tool) {
      if (doc.mode !== doc.tool) doc.setMode(doc.tool);
      else doc.uiManager.addEditListeners?.();
    }
  }

  // ================================================================== closing
  async beforeClose() {
    if (this.closing) return true;
    if (this.prompting) {
      // Closing again (taskbar, Alt+F4…) while a save question is open: that question must be answered first.
      this.nudgePrompt();
      return false;
    }
    for (const d of this.docs()) d.commitEdits();
    for (const tab of [...this.tabs]) {
      const doc = tab.doc;
      if (!doc?.dirty || !this.tabs.includes(tab)) continue;
      this.activate(tab);
      if (!(await this.confirmDiscard(doc))) return false;
      if (this.closing) return true;
    }
    this.closing = true;
    if (this.presenting) this.exitPresentation();
    return true;
  }

  destroy() {
    this.closing = true;
    if (this._presentKeys) document.removeEventListener('keydown', this._presentKeys);
    this.closeFlyout();
    this.mo?.disconnect();
    this.ro?.disconnect();
    this.tbObserver?.disconnect();
    clearTimeout(this._hintTimer);
    clearTimeout(this._cursorTimer);
    clearTimeout(this._relayoutTimer);
    for (const off of this.offs) {
      try {
        off?.();
      } catch {}
    }
    for (const tab of this.tabs) tab.doc?.destroy();
    this.start.destroy();
    shared.unregister(this);
    if (this.workerHeld) releaseWorker();
    this.workerHeld = false;
  }
}

/** Keyboard-focusable controls inside root, in Tab order (DOM order: no positive tabindex is used). */
function tabStops(root) {
  if (!root) return [];
  const inOtherLayer = (el) => {
    const layer = el.closest('.dialog-layer');
    return !!layer && !layer.contains(root);
  };
  return [...root.querySelectorAll('button, input, textarea, select, a[href], [tabindex]')].filter(
    (el) => !el.disabled && el.tabIndex >= 0 && !el.closest('[hidden], .pdf-overflowed') && !inOtherLayer(el) && el.getClientRects().length > 0,
  );
}
/** Tab / Shift+Tab wrap around inside root like a Windows app. Returns true when it moved the focus. */
function wrapTab(e, root) {
  const stops = tabStops(root);
  if (!stops.length) return false;
  const a = document.activeElement;
  // The deepest stop holding the focus (the document view is a stop that contains its text layers and links).
  let i = -1;
  stops.forEach((x, j) => {
    if (x === a || x.contains(a)) i = j;
  });
  let next = null;
  if (!e.shiftKey && (i === stops.length - 1 || (i < 0 && !root.contains(a)))) next = stops[0];
  else if (e.shiftKey && (i === 0 || (i < 0 && !root.contains(a)))) next = stops[stops.length - 1];
  if (!next) return false;
  e.preventDefault();
  e.stopPropagation();
  next.focus({ preventScroll: true });
  return true;
}

const KEYS_FR = { Shift: 'Maj', Esc: 'Échap', Escape: 'Échap', Del: 'Suppr', Delete: 'Suppr', Space: 'Espace', Enter: 'Entrée', Home: 'Origine', End: 'Fin', PageUp: 'Pg préc', PageDown: 'Pg suiv' };
export function localizeKeys(combo, lang) {
  if (!combo || lang !== 'fr') return combo;
  return String(combo)
    .split('+')
    .map((k) => KEYS_FR[k] || k)
    .join('+');
}

function isEditable(el) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'color'].includes(el.type);
  return false;
}

function scrollBy(el, dy, dx = 0) {
  el.scrollBy({ top: dy, left: dx, behavior: reduceMotion() ? 'auto' : 'smooth' });
}

function layoutIcon(id) {
  return { single: 'document_one_page', continuous: 'document_one_page_multiple', two: 'book_open', cover: 'book_open' }[id] || 'document_one_page_multiple';
}

function toolName(mode) {
  return Object.keys(TOOLS).find((k) => TOOLS[k] === mode) || 'highlight';
}

