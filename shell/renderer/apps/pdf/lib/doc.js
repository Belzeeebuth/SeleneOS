// One open PDF (one tab): loading (password, errors), the pdf.js viewer, its state (page, zoom,
// rotation, layout, editor tool), find, saving and the sidebar panels' data.
import { engine, docParams, guard, PDFJS } from './engine.js';
import { shared, HIGHLIGHT_COLORS } from './shared.js';
import { ThumbsPanel, OutlinePanel, AttachmentsPanel } from './sidebar.js';
import * as dlg from './dialogs.js';

export const basename = (p) => String(p || '').replace(/\/+$/, '').split('/').pop() || p;
export const dirname = (p) => String(p || '').replace(/\/[^/]*$/, '') || '/';

const MAX_BYTES = 1024 * 1024 * 1024; // 1 GB
export const ZOOM_STEPS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
export const ZOOM_PRESETS = ['auto', 'page-actual', 'page-fit', 'page-width'];
let seq = 0;

/** Tool ids <-> pdf.js AnnotationEditorType */
export const TOOLS = { none: 0, text: 3, highlight: 9, ink: 15 };

export class PdfDoc {
  constructor(w, path) {
    this.w = w;
    this.ctx = w.ctx;
    this.h = w.h;
    this.t = w.t;
    this.id = `doc${++seq}`;
    this.path = path;
    this.state = 'loading'; // loading | ready | error
    this.error = null; // { kind, message }
    this.pdf = null;
    this.viewer = null;
    this.dirty = false;
    this.pageNum = 1;
    this.pages = 0;
    this.scale = 1;
    this.scaleValue = 'auto';
    this.rotation = 0;
    this.layout = shared.prefs.layout;
    this.mode = 0; // current pdf.js editor mode
    this.tool = 0; // tool the user chose (restored when the tab / window comes back)
    this.editState = {};
    this.fileSize = 0;
    this.destroyed = false;
    this.offs = [];
    this.findState = null; // last find results { current, total, state }
    this.saving = false;
    const { h } = this;
    this.viewerEl = h('div', { class: 'pdfViewer' });
    this.scroller = h('div', { class: 'pdf-scroller', tabindex: '0', role: 'document' }, this.viewerEl);
    this.overlay = h('div', { class: 'pdf-doc-overlay', hidden: true });
    this.el = h('div', { class: 'pdf-doc', dataset: { doc: this.id }, hidden: true }, this.scroller, this.overlay);
    this.scroller.hidden = true;
    this.panels = { thumbs: null, outline: null, attachments: null };
    this.attachments = null;
    // Middle-click on a link would open it through window.open (the shell sends http(s) URLs straight to
    // the browser), skipping the confirmation: links are only followed by our own handlers.
    this.scroller.addEventListener('mousedown', (e) => e.button === 1 && e.target.closest?.('a[href]') && e.preventDefault(), true);
    this.scroller.addEventListener('auxclick', (e) => this.onLinkAuxClick(e), true);
  }

  onLinkAuxClick(e) {
    const a = e.target.closest?.('a[href]');
    if (!a || e.button !== 1) return;
    e.preventDefault();
    e.stopPropagation();
    const href = a.getAttribute('href') || '';
    if (/^(https?|mailto):/i.test(href)) this.w.openExternal(href);
  }

  get name() {
    return basename(this.path);
  }
  get title() {
    return this.name;
  }
  get ready() {
    return this.state === 'ready';
  }

  // ================================================================== loading
  async load({ initial } = {}) {
    if (this.loading) return;
    this.loading = true;
    try {
      await this.loadNow(initial);
    } finally {
      this.loading = false;
    }
  }

  async loadNow(initial) {
    this.teardownDocument();
    this.setState('loading');
    let E;
    try {
      E = await engine();
    } catch (err) {
      console.error('[pdf] engine', err);
      return this.fail('engine');
    }
    if (this.destroyed) return;
    this.E = E;
    const { api } = this.ctx;
    const st = await api.invoke('fs:stat', this.path).catch(() => null);
    if (this.destroyed) return;
    if (!st) return this.fail('missing');
    if (st.dir) return this.fail('corrupt', this.t('error.isFolder'));
    if (st.size > MAX_BYTES) return this.fail('tooBig');
    this.fileSize = st.size;
    this.mtime = st.mtime;
    let data;
    try {
      data = await api.invoke('fs:readBytes', this.path);
    } catch (err) {
      console.warn('[pdf] read failed', err?.code, err?.message);
      return this.fail(err?.code === 'EACCES' || /EACCES|permission/i.test(err?.message || '') ? 'denied' : 'read');
    }
    if (this.destroyed) return;
    if (!(data instanceof Uint8Array)) data = new Uint8Array(data);
    if (!looksLikePdf(data)) return this.fail('corrupt', this.t('error.notPdf'));
    const worker = await this.w.ensureWorker();
    if (this.destroyed || !worker) return;
    const task = E.lib.getDocument({ data, ...docParams(), worker });
    this.task = task;
    let passwordCanceled = false;
    task.onPassword = (update, reason) => {
      dlg.askPassword(this, reason === E.lib.PasswordResponses.INCORRECT_PASSWORD).then((pw) => {
        if (this.destroyed || task.destroyed) return;
        if (pw == null) {
          passwordCanceled = true;
          task.destroy();
        } else update(pw);
      });
    };
    let pdf;
    try {
      pdf = await task.promise;
    } catch (err) {
      if (this.destroyed) return;
      if (passwordCanceled || err?.name === 'PasswordException') return this.fail('locked');
      console.warn('[pdf] open failed', err?.name, err?.message);
      // pdf.js messages are English and technical: only known causes get a (translated) detail line.
      return this.fail('corrupt', err?.name === 'InvalidPDFException' ? this.t('error.invalidStructure') : '');
    }
    if (this.destroyed) {
      pdf.destroy();
      return;
    }
    this.pdf = pdf;
    this.pages = pdf.numPages;
    try {
      this.setupViewer(initial);
    } catch (err) {
      console.error('[pdf] viewer setup', err);
      this.teardownDocument();
      return this.fail('corrupt');
    }
    this.setState('ready');
    this.loadExtras();
  }

  fail(kind, message) {
    this.error = { kind, message: message || '' };
    this.setState('error');
  }

  setState(state) {
    this.state = state;
    this.scroller.hidden = state !== 'ready';
    this.renderOverlay();
    this.w.onDocState(this);
  }

  renderOverlay() {
    const { h, t, ctx } = this;
    const { icon, ui } = ctx;
    ui.clear(this.overlay);
    clearTimeout(this._spinTimer);
    if (this.state === 'ready') {
      this.overlay.hidden = true;
      return;
    }
    this.overlay.hidden = false;
    if (this.state === 'loading') {
      // A spinner only for slow opens: nothing flashes for small files.
      const box = h('div', { class: 'pdf-loading' }, h('div', { class: 'spinner' }), h('div', { class: 'text-2' }, t('loading', { name: this.name })));
      box.style.opacity = '0';
      this.overlay.appendChild(box);
      this._spinTimer = setTimeout(() => (box.style.opacity = ''), 250);
      return;
    }
    const kind = this.error?.kind || 'corrupt';
    const ic = { missing: 'document_dismiss', locked: 'lock_closed', denied: 'lock_closed', tooBig: 'document_error', engine: 'error_circle' }[kind] || 'document_error';
    const buttons = [];
    if (kind === 'locked') buttons.push(h('button', { class: 'btn primary', onclick: () => this.load() }, t('error.enterPassword')));
    else if (kind !== 'missing') buttons.push(h('button', { class: 'btn', onclick: () => this.load() }, t('error.retry')));
    buttons.push(h('button', { class: ['btn', kind !== 'locked' && 'primary'], onclick: () => this.w.openDialog({ replace: this }) }, t('error.openOther')));
    buttons.push(h('button', { class: 'btn', onclick: () => this.w.closeDoc(this) }, t('error.closeTab')));
    this.overlay.appendChild(
      h(
        'div',
        { class: 'pdf-error', role: 'alert' },
        h('div', { class: 'pdf-error-icon' }, icon(ic, { size: 40 })),
        h('div', { class: 'subtitle' }, t(`error.${kind}.title`)),
        h('div', { class: 'text-2 pdf-error-body' }, t(`error.${kind}.body`, { name: this.name, path: this.path })),
        this.error?.message ? h('div', { class: 'caption text-2 pdf-error-detail selectable' }, this.error.message) : null,
        h('div', { class: 'pdf-error-actions' }, buttons),
      ),
    );
  }

  // ================================================================== viewer
  setupViewer(initial = {}) {
    const { lib, viewer: V, l10n } = this.E;
    const eventBus = new V.EventBus();
    // Aborted on teardown: releases the viewer's ResizeObserver and scroll listener.
    this.viewerAC = new AbortController();
    const doc = this;
    class LinkService extends V.PDFLinkService {
      addLinkAttributes(link, url) {
        link.href = /^(https?|mailto):/i.test(url) ? url : '#';
        link.title = displayUrl(url);
        link.rel = 'noopener noreferrer nofollow';
        link.removeAttribute('target');
        link.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          doc.w.openExternal(url);
          return false;
        };
      }
    }
    const linkService = new LinkService({ eventBus, ignoreDestinationZoom: false });
    const findController = new V.PDFFindController({ eventBus, linkService, updateMatchesCountOnProgress: true });
    const viewer = new V.PDFViewer({
      container: this.scroller,
      viewer: this.viewerEl,
      eventBus,
      linkService,
      findController,
      l10n,
      textLayerMode: 1,
      annotationMode: lib.AnnotationMode.ENABLE_FORMS,
      annotationEditorMode: lib.AnnotationEditorType.NONE,
      annotationEditorHighlightColors: HIGHLIGHT_COLORS.map(([n, c]) => `${n}=${c}`).join(','),
      enableHighlightFloatingButton: false,
      imageResourcesPath: `${PDFJS}web/images/`,
      enableAutoLinking: true,
      abortSignal: this.viewerAC.signal,
    });
    linkService.setViewer(viewer);
    l10n.translate(this.scroller);
    Object.assign(this, { eventBus, linkService, findController, viewer });
    const on = (name, fn) => eventBus.on(name, fn);
    on('pagesinit', () => this.onPagesInit(initial));
    on('pagechanging', (e) => {
      this.pageNum = e.pageNumber;
      this.w.onDocPage(this);
      this.panels.thumbs?.setCurrent(e.pageNumber);
      this.panels.outline?.setCurrentPage(e.pageNumber);
      this.rememberSoon();
    });
    on('scalechanging', (e) => {
      this.scale = e.scale;
      this.scaleValue = e.presetValue || e.scale;
      this.w.onDocZoom(this);
      this.rememberSoon();
    });
    on('rotationchanging', (e) => {
      this.rotation = e.pagesRotation;
      this.panels.thumbs?.setRotation(e.pagesRotation);
    });
    on('updatefindmatchescount', (e) => {
      this.findState = { ...(this.findState || {}), current: e.matchesCount?.current || 0, total: e.matchesCount?.total || 0 };
      this.w.onDocFind(this);
    });
    on('updatefindcontrolstate', (e) => {
      this.findState = { ...(this.findState || {}), state: e.state, previous: e.previous, current: e.matchesCount?.current || 0, total: e.matchesCount?.total || 0 };
      this.w.onDocFind(this);
    });
    on('annotationeditoruimanager', (e) => {
      this.uiManager = e.uiManager;
    });
    on('annotationeditormodechanged', (e) => {
      this.mode = e.mode;
      // pdf.js switches by itself, e.g. clicking an existing highlight selects it in highlight mode.
      if (this.w.active === this && this.w.focused) this.tool = e.mode;
      this.w.onDocTool(this);
    });
    on('editingstateschanged', (e) => {
      Object.assign(this.editState, e.details || {});
      if (this.editState.hasSelectedEditor) guard.editingViews.add(this.scroller);
      else guard.editingViews.delete(this.scroller);
      this.w.onDocEditState(this);
    });
    this.pdf.annotationStorage.onSetModified = () => this.setDirty(true);
    this.pdf.annotationStorage.onResetModified = () => this.setDirty(false);
    viewer.setDocument(this.pdf);
    linkService.setDocument(this.pdf, null);
    // Ctrl + wheel zooms around the pointer.
    this.scroller.addEventListener(
      'wheel',
      (e) => {
        if (!e.ctrlKey || !this.viewer) return;
        e.preventDefault();
        const now = performance.now();
        if (now - (this._wheelAt || 0) < 60) return;
        this._wheelAt = now;
        this.zoomStep(e.deltaY < 0 ? 1 : -1, e);
      },
      { passive: false },
    );
  }

  onPagesInit(initial) {
    // A document that finished loading in a background tab: pdf.js would size and scroll it against a hidden,
    // zero-size container (errors, a 10 % zoom, the remembered page lost). Set it up when the tab is shown.
    if (this.el.hidden || !this.scroller.offsetParent || !this.scroller.clientWidth) {
      this.deferredInit = initial || {};
      return;
    }
    this.deferredInit = null;
    const v = this.viewer;
    const remembered = shared.recentGet(this.path);
    this.applyLayout(this.layout, { keepPage: false });
    const scale = initial?.scale ?? remembered?.scale ?? 'auto';
    v.currentScaleValue = isValidScale(scale) ? String(scale) : 'auto';
    const page = Math.max(1, Math.min(this.pages, Number(initial?.page ?? remembered?.page) || 1));
    if (page > 1) v.currentPageNumber = page;
    else this.scroller.scrollTop = 0; // show the margin above the first page
    if (initial?.rotation) v.pagesRotation = initial.rotation;
    this.pageNum = v.currentPageNumber;
    this.w.onDocPage(this);
    this.w.onDocZoom(this);
    this.remember({ touch: true });
    this.makeRecentThumb();
  }

  async loadExtras() {
    const pdf = this.pdf;
    try {
      // pdf.js 6: Map(id -> { filename, rawFilename, description }); the bytes come from getAttachmentContent(id).
      const att = await pdf.getAttachments();
      if (this.destroyed) return;
      const entries = att instanceof Map ? [...att.entries()] : Object.entries(att || {});
      this.attachments = entries.length
        ? entries.map(([id, a]) => ({ id, filename: a?.filename || id, description: a?.description || '', content: a?.content || null }))
        : null;
    } catch {
      this.attachments = null;
    }
    this.w.onDocExtras(this);
  }

  /** Sidebar panel (created on first use). */
  panel(name) {
    if (!this.ready) return null;
    if (!this.panels[name]) {
      if (name === 'thumbs') this.panels.thumbs = new ThumbsPanel(this);
      else if (name === 'outline') this.panels.outline = new OutlinePanel(this);
      else if (name === 'attachments') this.panels.attachments = new AttachmentsPanel(this);
    }
    return this.panels[name];
  }

  // ================================================================== state shown by the window
  show() {
    this.el.hidden = false;
    if (this.deferredInit && this.viewer) {
      if (!this.scroller.offsetParent || !this.scroller.clientWidth) {
        requestAnimationFrame(() => !this.el.hidden && !this.destroyed && this.show());
        return;
      }
      this.onPagesInit(this.deferredInit);
      this.viewer.update();
      return;
    }
    if (this._savedScroll && this.viewer && !this.scroller.offsetParent) {
      // Not laid out yet: restore once it is.
      requestAnimationFrame(() => !this.el.hidden && !this.destroyed && this.show());
      return;
    }
    if (this._savedScroll && this.viewer) {
      const { top, left, width, height, scaleValue } = this._savedScroll;
      const sizeChanged = width !== this.scroller.clientWidth || height !== this.scroller.clientHeight;
      if (sizeChanged && typeof scaleValue === 'string' && ZOOM_PRESETS.includes(scaleValue)) {
        const page = this.viewer.currentPageNumber;
        this.viewer.currentScaleValue = scaleValue;
        this.viewer.currentPageNumber = page;
      } else {
        this.scroller.scrollTop = top;
        this.scroller.scrollLeft = left;
      }
      this.viewer.update();
    }
    this._savedScroll = null;
  }
  hide() {
    if (this.viewer && !this.el.hidden) {
      this._savedScroll = {
        top: this.scroller.scrollTop,
        left: this.scroller.scrollLeft,
        width: this.scroller.clientWidth,
        height: this.scroller.clientHeight,
        scaleValue: this.scaleValue,
      };
    }
    this.el.hidden = true;
  }
  focus() {
    if (this.ready) this.scroller.focus({ preventScroll: true });
  }
  /** The window resized: re-fit preset zooms (page width, page fit, automatic). */
  relayout() {
    if (!this.viewer || this.el.hidden) return;
    if (this.deferredInit) {
      // Loaded while the window was minimized / on another desktop: set the view up now that it has a size.
      if (this.scroller.offsetParent && this.scroller.clientWidth) {
        this.onPagesInit(this.deferredInit);
        this.viewer.update();
      }
      return;
    }
    if (typeof this.scaleValue === 'string' && ZOOM_PRESETS.includes(this.scaleValue)) this.viewer.currentScaleValue = this.scaleValue;
    this.viewer.update();
  }

  setDirty(on) {
    if (this.dirty === on) return;
    this.dirty = on;
    this.w.onDocDirty(this);
  }

  // ================================================================== navigation / zoom / layout
  goToPage(n) {
    if (!this.viewer) return;
    const p = Math.max(1, Math.min(this.pages, Math.round(Number(n)) || 1));
    this.viewer.currentPageNumber = p;
  }
  nextPage() {
    this.viewer?.nextPage();
  }
  prevPage() {
    this.viewer?.previousPage();
  }

  setZoom(value) {
    if (!this.viewer) return;
    this.viewer.currentScaleValue = String(value);
  }
  zoomStep(dir, ev) {
    if (!this.viewer) return;
    const cur = this.viewer.currentScale;
    let next = cur;
    if (dir > 0) next = ZOOM_STEPS.find((z) => z > cur * 1.001) ?? ZOOM_STEPS.at(-1);
    else next = [...ZOOM_STEPS].reverse().find((z) => z < cur * 0.999) ?? ZOOM_STEPS[0];
    if (Math.abs(next - cur) < 1e-6) return;
    if (ev) {
      // Keep the point under the pointer still (pdf.js expects coordinates relative to the container's offset parent).
      const r = this.scroller.getBoundingClientRect();
      const origin = [ev.clientX - r.left + this.scroller.offsetLeft, ev.clientY - r.top + this.scroller.offsetTop];
      this.viewer.updateScale({ scaleFactor: next / cur, origin, drawingDelay: 300 });
    } else this.viewer.currentScaleValue = String(next);
  }
  rotate(delta) {
    if (!this.viewer) return;
    const page = this.viewer.currentPageNumber;
    this.viewer.pagesRotation = (((this.viewer.pagesRotation + delta) % 360) + 360) % 360;
    this.viewer.currentPageNumber = page;
  }
  applyLayout(layout, { keepPage = true } = {}) {
    if (!this.viewer) {
      this.layout = layout;
      return;
    }
    const { ScrollMode, SpreadMode } = this.E.viewer;
    const v = this.viewer;
    const page = v.currentPageNumber;
    this.layout = layout;
    v.scrollMode = layout === 'single' ? ScrollMode.PAGE : ScrollMode.VERTICAL;
    v.spreadMode = layout === 'two' ? SpreadMode.ODD : layout === 'cover' ? SpreadMode.EVEN : SpreadMode.NONE;
    if (typeof this.scaleValue === 'string' && ZOOM_PRESETS.includes(this.scaleValue)) v.currentScaleValue = this.scaleValue;
    if (keepPage && page) v.currentPageNumber = page;
  }

  // ================================================================== find
  find(query, { caseSensitive = false, entireWord = false, again = false, previous = false } = {}) {
    if (!this.eventBus) return;
    if (!query) {
      this.findClose();
      return;
    }
    this.findState = { ...(this.findState || {}), state: 3 };
    this.eventBus.dispatch('find', { source: this, type: again ? 'again' : '', query, caseSensitive, entireWord, highlightAll: true, findPrevious: previous, matchDiacritics: false });
  }
  findClose() {
    this.findState = null;
    this.eventBus?.dispatch('findbarclose', { source: this });
  }

  // ================================================================== annotation tools
  /** Switch the pdf.js editor mode (0 = none). */
  setMode(mode) {
    if (!this.viewer || !this.uiManager) return false;
    if (this.viewer.annotationEditorMode === mode) return true;
    try {
      this.viewer.annotationEditorMode = { mode };
      return true;
    } catch (err) {
      console.warn('[pdf] editor mode', err);
      return false;
    }
  }
  /** Commit what is being edited (text being typed, an ink drawing in progress): it becomes a saved change. */
  commitEdits() {
    try {
      this.uiManager?.endCurrentEditing?.();
    } catch (err) {
      console.warn('[pdf] commit', err?.message || err);
    }
  }
  setParam(type, value) {
    this.eventBus?.dispatch('switchannotationeditorparams', { source: this, type, value });
  }
  editingAction(name) {
    this.eventBus?.dispatch('editingaction', { source: this, name });
  }
  highlightSelection() {
    if (!this.uiManager) return;
    this.uiManager.highlightSelection('context_menu');
  }

  // ================================================================== text
  selectionInDoc() {
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return '';
    const node = sel.anchorNode;
    if (!node || !this.scroller.contains(node)) return '';
    return sel.toString();
  }
  selectAll() {
    if (!this.ready) return;
    const sel = document.getSelection();
    sel.removeAllRanges();
    sel.selectAllChildren(this.scroller);
  }

  /** Bytes of an embedded file. */
  async attachmentBytes(a) {
    if (a.content) return a.content;
    const bytes = await this.pdf.getAttachmentContent(a.id);
    if (!bytes) throw Object.assign(new Error(this.t('att.empty')), { code: 'EEMPTY' });
    a.content = bytes;
    return bytes;
  }

  // ================================================================== save
  async bytes() {
    this.commitEdits();
    const storage = this.pdf.annotationStorage;
    if (storage.size === 0) return this.pdf.getData();
    // pdf.js marks the annotations as saved as soon as the new bytes are built; the document only becomes
    // clean once they are on disk (the window resets it after a successful write).
    const onReset = storage.onResetModified;
    storage.onResetModified = null;
    try {
      return await this.pdf.saveDocument();
    } finally {
      storage.onResetModified = onReset;
    }
  }

  // ================================================================== recent list
  rememberSoon() {
    clearTimeout(this._rememberTimer);
    this._rememberTimer = setTimeout(() => this.remember(), 600);
  }
  remember({ touch = false } = {}) {
    // (not shown yet: its page and zoom are still the ones remembered)
    if (!this.ready || !this.viewer || this.deferredInit) return;
    const entry = { path: this.path, name: this.name, page: this.pageNum, pages: this.pages, size: this.fileSize, scale: this.scaleValue };
    if (touch) entry.date = Date.now();
    shared.recentPut(entry, { keepOrder: !touch });
  }
  async makeRecentThumb() {
    try {
      const page = await this.pdf.getPage(1);
      if (this.destroyed) return;
      const vp1 = page.getViewport({ scale: 1 });
      const scale = 112 / vp1.width;
      const vp = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(vp.width));
      canvas.height = Math.max(1, Math.round(vp.height));
      const c2d = canvas.getContext('2d');
      c2d.fillStyle = '#fff';
      c2d.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: c2d, canvas, viewport: vp }).promise;
      if (this.destroyed) return;
      shared.recentPut({ path: this.path, thumb: canvas.toDataURL('image/jpeg', 0.72) }, { keepOrder: true });
      canvas.width = canvas.height = 0;
    } catch (err) {
      if (!this.destroyed) console.warn('[pdf] thumbnail', err?.message || err);
    }
  }

  // ================================================================== teardown
  /** Forget the loaded document and its viewer (before loading again, or on close). */
  teardownDocument() {
    guard.editingViews.delete(this.scroller);
    for (const [k, p] of Object.entries(this.panels)) {
      p?.destroy();
      this.panels[k] = null;
    }
    try {
      this.viewer?.setDocument(null);
      this.linkService?.setDocument(null);
    } catch {}
    this.viewerAC?.abort();
    this.viewerAC = null;
    // Nothing that outlives the document (the shared worker's message handlers) may point back at this tab.
    if (this.task) this.task.onPassword = null;
    if (this.pdf) {
      this.pdf.annotationStorage.onSetModified = null;
      this.pdf.annotationStorage.onResetModified = null;
    }
    try {
      if (this.pdf) this.pdf.destroy();
      else this.task?.destroy();
    } catch {}
    this.viewer = null;
    this.linkService = null;
    this.findController = null;
    this.eventBus = null;
    this.uiManager = null;
    this.pdf = null;
    this.task = null;
    this.mode = 0;
    this.dirty = false;
    this.attachments = null;
    this.viewerEl.replaceChildren();
    this.scroller.querySelector('#hiddenCopyElement')?.remove();
  }

  destroy() {
    if (this.destroyed) return;
    clearTimeout(this._rememberTimer);
    clearTimeout(this._spinTimer);
    if (this.ready) this.remember();
    this.destroyed = true;
    this.closePasswordDialog?.();
    try {
      this.E?.l10n.forget(this.scroller);
    } catch {}
    this.teardownDocument();
    this.el.remove();
  }
}

function looksLikePdf(bytes) {
  const n = Math.min(bytes.length, 1024);
  for (let i = 0; i < n - 4; i++) {
    if (bytes[i] === 0x25 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x44 && bytes[i + 3] === 0x46 && bytes[i + 4] === 0x2d) return true; // %PDF-
  }
  return false;
}

export function isValidScale(v) {
  if (ZOOM_PRESETS.includes(v)) return true;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0.1 && n <= 10;
}

export function displayUrl(url) {
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = '';
      u.password = '';
    }
    return u.href;
  } catch {
    return String(url);
  }
}
