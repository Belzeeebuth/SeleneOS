// Photo editor: Crop & rotate (aspect presets, straighten, flip, 90° turns), Adjustments, Filters,
// Markup (pen / highlighter / eraser), undo / redo, Save as copy / Save / Copy to clipboard.
import * as P from './pipeline.js';
import { extOf, stem, dirName, baseName, clamp, rafThrottle, reduceMotion, loadPixels, ENCODABLE, EASE } from './util.js';

const PREVIEW_MAX = 1600;
const TOOLS = [
  ['crop', 'crop'],
  ['adjust', 'brightness_high'],
  ['filter', 'color'],
  ['markup', 'ink_stroke'],
];
const ADJ_GROUPS = [
  ['light', ['brightness', 'exposure', 'contrast', 'highlights', 'shadows']],
  ['color', ['saturation', 'warmth', 'tint']],
  ['effects', ['vignette']],
];
const COLORS = ['#000000', '#ffffff', '#e81123', '#ff8c00', '#fff100', '#16c60c', '#0078d4', '#886ce4'];

export class Editor {
  constructor(app) {
    this.app = app;
    this.h = app.h;
    this.t = app.t;
    this.icon = app.icon;
    this.ui = app.ui;
    this.lib = app.lib;
    this.item = null;
    this.edit = P.defaultEdit();
    this.history = [];
    this.hIdx = -1;
    this.tool = 'crop';
    this.pen = { tool: 'pen', color: '#e81123', size: 8 };
    this.busy = false;
    this._build();
  }

  get dirty() {
    return !!this.item && !P.isIdentity(this.edit);
  }

  // ================================================================== DOM
  _build() {
    const { h, t, icon } = this;
    const tb = (ic, label, key, onclick, cmd) => h('button', { class: 'btn subtle icon-btn', 'aria-label': label, 'data-tip': key ? `${label} (${key})` : label, 'data-tip-pos': 'below', dataset: { cmd }, onclick }, icon(ic));
    this.undoBtn = tb('arrow_undo', t('undo'), 'Ctrl+Z', () => this.undo(), 'undo');
    this.redoBtn = tb('arrow_redo', t('redo'), 'Ctrl+Y', () => this.redo(), 'redo');
    this.resetBtn = h('button', { class: 'btn subtle', dataset: { cmd: 'reset' }, onclick: () => this.reset() }, t('reset'));
    this.tabs = h('div', { class: 'ph-etabs', role: 'tablist', 'aria-label': t('editTools') });
    this.tabBtns = {};
    for (const [id, ic] of TOOLS) {
      const b = h('button', { class: 'ph-etab', role: 'tab', 'aria-selected': 'false', dataset: { tool: id }, 'data-tip': t(`tool.${id}`), onclick: () => this.setTool(id) }, icon(ic), h('span', { class: 'ph-etab-label' }, t(`tool.${id}`)));
      this.tabBtns[id] = b;
      this.tabs.appendChild(b);
    }
    this.tabs.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const ids = TOOLS.map((x) => x[0]);
      const i = ids.indexOf(this.tool);
      const n = ids[(i + (e.key === 'ArrowRight' ? 1 : -1) + ids.length) % ids.length];
      this.setTool(n);
      this.tabBtns[n].focus();
    });
    this.saveBtn = h('button', { class: 'btn primary ph-save-main', dataset: { cmd: 'save-copy' }, onclick: () => this.save('copy') }, t('saveCopy'));
    this.saveMore = h('button', { class: 'btn primary icon-btn ph-save-more', 'aria-label': t('saveOptions'), 'data-tip': t('saveOptions'), 'data-tip-pos': 'below', dataset: { cmd: 'save-menu' }, onclick: (e) => this.saveMenu(e) }, icon('chevron_down', { size: 12 }));
    this.cancelBtn = h('button', { class: 'btn', dataset: { cmd: 'cancel' }, onclick: () => this.app.closeEditor() }, t('common.cancel'));
    this.top = h(
      'div',
      { class: 'ph-etop' },
      h('div', { class: 'ph-etop-left' }, this.undoBtn, this.redoBtn, this.resetBtn),
      this.tabs,
      h('div', { class: 'ph-etop-right' }, h('div', { class: 'ph-split' }, this.saveBtn, this.saveMore), this.cancelBtn),
    );
    this.canvas = h('canvas', { class: 'ph-ecanvas', 'aria-label': t('editPreview') });
    this.cropBox = h('div', { class: 'ph-crop-box', tabindex: '0', 'aria-label': t('cropArea') },
      h('div', { class: 'ph-crop-grid' }, h('i'), h('i'), h('i'), h('i')),
      ...['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((d) => h('div', { class: `ph-crop-h h-${d}`, dataset: { h: d } })),
    );
    this.cropDim = h('div', { class: 'ph-crop-dim' });
    this.cropLayer = h('div', { class: 'ph-crop', hidden: true }, this.cropDim, this.cropBox);
    this.canvasWrap = h('div', { class: 'ph-ecanvas-wrap' }, this.canvas, this.cropLayer);
    this.stage = h('div', { class: 'ph-estage' }, this.canvasWrap);
    this.panel = h('div', { class: 'ph-epanel', role: 'tabpanel' });
    this.savingEl = h('div', { class: 'ph-esaving', hidden: true }, h('div', { class: 'spinner' }), h('div', { class: 'ph-esaving-label' }, t('saving')));
    this.el = h('div', { class: 'ph-editor' }, this.top, h('div', { class: 'ph-ebody' }, this.stage, this.panel), this.savingEl);
    this._render = rafThrottle(() => this.renderNow());
    this.ro = new ResizeObserver(() => {
      this.el.classList.toggle('compact', this.el.clientWidth < 880);
      this.el.classList.toggle('narrow', this.el.clientWidth < 660);
      this._layoutCanvas();
    });
    this.ro.observe(this.stage);
    this.ro.observe(this.el);
    this._bindCrop();
    this._bindMarkup();
  }

  destroy() {
    this.ro.disconnect();
  }

  // ================================================================== open / close
  async open(item) {
    this.item = item;
    this.edit = P.defaultEdit();
    this.history = [];
    this.hIdx = -1;
    this._commit();
    this.src = null;
    this.base = null;
    this.baseKey = null;
    this.filterThumbs = null;
    this.el.classList.add('loading');
    const url = `${this.app.api.mediaUrl(item.path)}?v=${Math.round(item.mtime || 0)}-${item.size || 0}`;
    const img = await loadPixels(url);
    let w = img.naturalWidth;
    let hgt = img.naturalHeight;
    const ext = extOf(item.path);
    if (ext === '.svg' || !w || !hgt) {
      // Vector images: rasterize at a useful size.
      const ar = w && hgt ? w / hgt : 1;
      const long = Math.max(2048, w || 0, hgt || 0);
      if (ar >= 1) {
        w = long;
        hgt = Math.round(long / ar);
      } else {
        hgt = long;
        w = Math.round(long * ar);
      }
      const c = document.createElement('canvas');
      c.width = w;
      c.height = hgt;
      c.getContext('2d').drawImage(img, 0, 0, w, hgt);
      this.src = c;
    } else this.src = img;
    this.srcW = w;
    this.srcH = hgt;
    // Downscaled preview source.
    const k = Math.min(1, PREVIEW_MAX / Math.max(w, hgt));
    const pw = Math.max(1, Math.round(w * k));
    const ph = Math.max(1, Math.round(hgt * k));
    const pc = document.createElement('canvas');
    pc.width = pw;
    pc.height = ph;
    const pctx = pc.getContext('2d');
    pctx.imageSmoothingQuality = 'high';
    pctx.drawImage(this.src, 0, 0, pw, ph);
    this.preview = pc;
    this.pScale = pw / w;
    this.el.classList.remove('loading');
    this.setTool('crop');
    this._syncButtons();
    if (!reduceMotion()) this.canvasWrap.animate([{ opacity: 0, transform: 'scale(0.98)' }, { opacity: 1, transform: 'none' }], { duration: 250, easing: EASE });
  }

  close() {
    this.item = null;
    this.src = null;
    this.preview = null;
    this.base = null;
  }

  // ================================================================== history
  _snapshot() {
    return JSON.stringify(this.edit);
  }
  _commit() {
    const s = this._snapshot();
    if (this.history[this.hIdx] === s) return;
    this.history = this.history.slice(0, this.hIdx + 1);
    this.history.push(s);
    if (this.history.length > 100) this.history.shift();
    this.hIdx = this.history.length - 1;
    this._syncButtons();
  }
  undo() {
    if (this.hIdx <= 0) return;
    this.hIdx--;
    this.edit = JSON.parse(this.history[this.hIdx]);
    this._afterHistory();
  }
  redo() {
    if (this.hIdx >= this.history.length - 1) return;
    this.hIdx++;
    this.edit = JSON.parse(this.history[this.hIdx]);
    this._afterHistory();
  }
  reset() {
    const markup = [];
    this.edit = { ...P.defaultEdit(), markup };
    this._commit();
    this._afterHistory();
  }
  _afterHistory() {
    this.filterThumbs = null;
    this._renderPanel();
    this._render();
    this._syncButtons();
  }
  _syncButtons() {
    this.undoBtn.disabled = this.hIdx <= 0;
    this.redoBtn.disabled = this.hIdx >= this.history.length - 1;
    this.resetBtn.disabled = P.isIdentity(this.edit);
    const ext = extOf(this.item?.path || '');
    this.canOverwrite = !!ENCODABLE[ext] || ext === '.bmp';
  }

  /** Test / automation hook: merge a partial edit and commit it. */
  setEdit(partial) {
    this.edit = { ...this.edit, ...JSON.parse(JSON.stringify(partial)) };
    this._commit();
    this._afterHistory();
  }

  // ================================================================== tools
  setTool(id) {
    this.tool = id;
    for (const [k, b] of Object.entries(this.tabBtns)) {
      b.classList.toggle('selected', k === id);
      b.setAttribute('aria-selected', String(k === id));
      b.tabIndex = k === id ? 0 : -1;
    }
    this.el.dataset.tool = id;
    this.cropLayer.hidden = id !== 'crop';
    this._renderPanel();
    this._render();
  }

  _renderPanel() {
    // Keep keyboard focus on the same control across re-renders (or on the active tab).
    const a = document.activeElement;
    let key = null;
    if (a && this.panel.contains(a)) {
      for (const k of ['cmd', 'aspect', 'filter', 'adjust']) if (a.dataset?.[k]) key = `[data-${k}="${a.dataset[k]}"]`;
      if (!key) key = a.classList.contains('ph-straighten') ? '.ph-straighten' : a.classList.contains('ph-filter-amount') ? '.ph-filter-amount' : '';
    }
    this.ui.clear(this.panel);
    const tool = this.tool;
    if (tool === 'crop') this._panelCrop();
    else if (tool === 'adjust') this._panelAdjust();
    else if (tool === 'filter') this._panelFilter();
    else if (tool === 'markup') this._panelMarkup();
    if (key !== null) {
      const el = (key && this.panel.querySelector(key)) || this.tabBtns[this.tool];
      el?.focus({ preventScroll: true });
    }
  }

  _section(title, ...kids) {
    return this.h('section', { class: 'ph-psec' }, title ? this.h('h3', { class: 'ph-psec-title body-strong' }, title) : null, ...kids);
  }

  _panelCrop() {
    const { h, t } = this;
    const e = this.edit;
    const ratios = this.h('div', { class: 'ph-ratios', role: 'radiogroup', 'aria-label': t('aspectRatio') });
    for (const a of P.ASPECTS) {
      ratios.appendChild(
        h('button', {
          class: ['ph-ratio', e.aspect === a.id && 'selected'],
          role: 'radio',
          'aria-checked': String(e.aspect === a.id),
          dataset: { aspect: a.id },
          onclick: () => this.setAspect(a.id),
        }, a.id === 'free' ? t('aspect.free') : a.id === 'original' ? t('aspect.original') : a.id === '1:1' ? t('aspect.square') : a.id),
      );
    }
    const straight = this.ui.slider({ min: -45, max: 45, step: 0.5, value: e.straighten, style: { width: '100%' } });
    straight.classList.add('ph-straighten');
    straight.setAttribute('aria-label', t('straighten'));
    const sv = h('span', { class: 'ph-adj-val' }, `${e.straighten}°`);
    straight.addEventListener('input', () => {
      this.edit.straighten = Number(straight.value);
      sv.textContent = `${straight.value}°`;
      this.cropLayer.classList.add('fine-grid');
      this._render();
    });
    straight.addEventListener('change', () => {
      this.cropLayer.classList.remove('fine-grid');
      this._commit();
    });
    straight.addEventListener('dblclick', () => {
      straight.setValue(0);
      this.edit.straighten = 0;
      sv.textContent = '0°';
      this._commit();
      this._render();
    });
    const btn = (ic, label, fn, cmd) => h('button', { class: 'btn ph-rbtn', 'data-tip': label, 'aria-label': label, dataset: { cmd }, onclick: fn }, this.icon(ic, { size: 20 }));
    this.panel.append(
      this._section(t('aspectRatio'), ratios),
      this._section(
        t('rotateFlip'),
        h('div', { class: 'ph-rbtns' },
          btn('arrow_rotate_counterclockwise', t('rotateLeft'), () => this.rotate(-1), 'rot-left'),
          btn('arrow_rotate_clockwise', t('rotateRight'), () => this.rotate(1), 'rot-right'),
          btn('flip_horizontal', t('flipH'), () => this.flip('h'), 'flip-h'),
          btn('flip_vertical', t('flipV'), () => this.flip('v'), 'flip-v')),
      ),
      this._section(h('span', { class: 'row ph-row-between' }, h('span', null, t('straighten')), sv), straight),
      this._section(null, h('button', { class: 'btn', dataset: { cmd: 'reset-crop' }, disabled: P.isFullCrop(e.crop) && !e.straighten && !e.rot && !e.flipH && !e.flipV, onclick: () => {
        this.edit.crop = null;
        this.edit.straighten = 0;
        this.edit.rot = 0;
        this.edit.flipH = false;
        this.edit.flipV = false;
        this.edit.aspect = 'free';
        this._commit();
        this._afterHistory();
      } }, t('resetCrop'))),
      h('div', { class: 'caption text-2 ph-hint' }, t('cropHint')),
    );
  }

  _frame() {
    return P.frameSize(this.srcW, this.srcH, this.edit.rot);
  }

  setAspect(id) {
    const a = P.ASPECTS.find((x) => x.id === id);
    if (!a) return;
    const [fw, fh] = this._frame();
    this.edit.aspect = id;
    const r = a.r === 'original' ? fw / fh : a.r;
    this.edit.crop = r ? P.centeredCrop(fw, fh, r) : this.edit.crop;
    this._commit();
    this._renderPanel();
    this._render();
  }

  rotate(dir) {
    const e = this.edit;
    e.rot = (e.rot + (dir > 0 ? 1 : 3)) % 4;
    [e.flipH, e.flipV] = [e.flipV, e.flipH];
    if (e.crop) e.crop = P.transformCrop(e.crop, dir > 0 ? 'cw' : 'ccw');
    if (P.SWAP_ASPECT[e.aspect]) e.aspect = P.SWAP_ASPECT[e.aspect];
    this._commit();
    this.filterThumbs = null;
    this._renderPanel();
    this._render();
    if (!reduceMotion()) this.canvas.animate([{ transform: `rotate(${dir > 0 ? -90 : 90}deg) scale(0.9)`, opacity: 0.6 }, { transform: 'none', opacity: 1 }], { duration: 250, easing: EASE });
  }

  flip(axis) {
    const e = this.edit;
    if (axis === 'h') e.flipH = !e.flipH;
    else e.flipV = !e.flipV;
    e.straighten = -e.straighten || 0;
    if (e.crop) e.crop = P.transformCrop(e.crop, axis === 'h' ? 'flipH' : 'flipV');
    this._commit();
    this.filterThumbs = null;
    this._renderPanel();
    this._render();
  }

  _panelAdjust() {
    const { h, t } = this;
    for (const [g, keys] of ADJ_GROUPS) {
      const rows = keys.map((k) => {
        const val = h('span', { class: 'ph-adj-val' }, String(this.edit.adjust[k] || 0));
        const s = this.ui.slider({ min: -100, max: 100, step: 1, value: this.edit.adjust[k] || 0, style: { width: '100%' } });
        s.classList.add('ph-adj-slider', 'bipolar');
        s.dataset.adjust = k;
        s.setAttribute('aria-label', t(`adj.${k}`));
        const paintCenter = () => {
          const v = Number(s.value);
          s.style.setProperty('--from', `${Math.min(50, (v + 100) / 2)}%`);
          s.style.setProperty('--to', `${Math.max(50, (v + 100) / 2)}%`);
        };
        paintCenter();
        s.addEventListener('input', () => {
          this.edit.adjust[k] = Number(s.value);
          val.textContent = s.value;
          paintCenter();
          this._render();
        });
        s.addEventListener('change', () => this._commit());
        const resetOne = () => {
          s.setValue(0);
          this.edit.adjust[k] = 0;
          val.textContent = '0';
          paintCenter();
          this._commit();
          this._render();
        };
        s.addEventListener('dblclick', resetOne);
        return h('div', { class: 'ph-adj' }, h('div', { class: 'ph-adj-head' }, h('label', { ondblclick: resetOne }, t(`adj.${k}`)), val), s);
      });
      this.panel.appendChild(this._section(t(`adjGroup.${g}`), ...rows));
    }
    this.panel.appendChild(h('div', { class: 'caption text-2 ph-hint' }, t('adjustHint')));
  }

  _panelFilter() {
    const { h, t } = this;
    const grid = h('div', { class: 'ph-filters', role: 'radiogroup', 'aria-label': t('tool.filter') });
    const thumbs = this._filterThumbs();
    P.FILTERS.forEach((f, i) => {
      const c = h('canvas', { class: 'ph-filter-art' });
      const src = thumbs[i];
      c.width = src.width;
      c.height = src.height;
      c.getContext('2d').drawImage(src, 0, 0);
      const sel = this.edit.filter.id === f.id;
      grid.appendChild(
        h('button', {
          class: ['ph-filter', sel && 'selected'],
          role: 'radio',
          'aria-checked': String(sel),
          dataset: { filter: f.id },
          onclick: () => {
            this.edit.filter = { id: f.id, amount: this.edit.filter.id === f.id ? this.edit.filter.amount : 100 };
            this._commit();
            this._renderPanel();
            this._render();
          },
        }, c, h('span', { class: 'caption ph-filter-name' }, t(`filter.${f.id}`))),
      );
    });
    const amt = this.ui.slider({ min: 0, max: 100, step: 1, value: this.edit.filter.amount, style: { width: '100%' } });
    amt.classList.add('ph-filter-amount');
    amt.setAttribute('aria-label', t('intensity'));
    amt.disabled = this.edit.filter.id === 'original';
    const val = h('span', { class: 'ph-adj-val' }, String(this.edit.filter.amount));
    amt.addEventListener('input', () => {
      this.edit.filter.amount = Number(amt.value);
      val.textContent = amt.value;
      this._render();
    });
    amt.addEventListener('change', () => this._commit());
    this.panel.append(this._section(t('tool.filter'), grid), this._section(h('span', { class: 'row ph-row-between' }, h('span', null, t('intensity')), val), amt));
  }

  _filterThumbs() {
    if (this.filterThumbs) return this.filterThumbs;
    // Small render of the current geometry, then each preset applied to it.
    const geo = { ...this.edit, adjust: P.defaultEdit().adjust, filter: { id: 'original', amount: 100 }, markup: [] };
    const [ow, oh] = P.outputSize(this.srcW, this.srcH, geo);
    const k = 112 / Math.max(ow, oh);
    const small = P.render(this.preview, this.srcW, this.srcH, geo, { scale: k, crop: true });
    this.filterThumbs = P.FILTERS.map((f) => P.render(small, small.width, small.height, { ...P.defaultEdit(), filter: { id: f.id, amount: 100 } }, { scale: 1 }));
    return this.filterThumbs;
  }

  _panelMarkup() {
    const { h, t } = this;
    const tools = this.ui.segmented({
      value: this.pen.tool,
      options: [
        { value: 'pen', icon: 'pen', tip: t('pen'), label: t('pen') },
        { value: 'highlighter', icon: 'highlight', tip: t('highlighter'), label: t('highlighter') },
        { value: 'eraser', icon: 'eraser', tip: t('eraser'), label: t('eraser') },
      ],
      onchange: (v) => {
        this.pen.tool = v;
        this.el.dataset.pen = v;
        // ui.segmented rebuilds its buttons: keep the keyboard focus on the chosen one.
        tools.querySelector('button.selected')?.focus({ preventScroll: true });
      },
    });
    tools.classList.add('ph-pen-tools');
    this.el.dataset.pen = this.pen.tool;
    const swatches = h('div', { class: 'ph-swatches', role: 'radiogroup', 'aria-label': t('color') });
    for (const c of COLORS) {
      const sw = h('button', {
          class: ['ph-swatch', this.pen.color === c && 'selected'],
          role: 'radio',
          'aria-checked': String(this.pen.color === c),
          'aria-label': this.t(`colorName.${c.slice(1)}`),
          'data-tip': this.t(`colorName.${c.slice(1)}`),
          dataset: { color: c },
          onclick: (e) => {
            this.pen.color = c;
            for (const s of swatches.children) {
              s.classList.toggle('selected', s === e.currentTarget);
              s.setAttribute('aria-checked', String(s === e.currentTarget));
            }
          },
        });
      sw.style.setProperty('--sw', c);
      swatches.appendChild(sw);
    }
    const size = this.ui.slider({ min: 1, max: 40, step: 1, value: this.pen.size, style: { width: '100%' } });
    size.setAttribute('aria-label', t('penSize'));
    const sv = h('span', { class: 'ph-adj-val' }, String(this.pen.size));
    size.addEventListener('input', () => {
      this.pen.size = Number(size.value);
      sv.textContent = size.value;
    });
    this.panel.append(
      this._section(t('tool.markup'), tools),
      this._section(t('color'), swatches),
      this._section(h('span', { class: 'row ph-row-between' }, h('span', null, t('penSize')), sv), size),
      this._section(null, h('button', { class: 'btn', dataset: { cmd: 'clear-markup' }, disabled: !this.edit.markup.length, onclick: () => {
        this.edit.markup = [];
        this._commit();
        this._renderPanel();
        this._render();
      } }, this.icon('delete'), t('clearMarkup'))),
      h('div', { class: 'caption text-2 ph-hint' }, t('markupHint')),
    );
  }

  // ================================================================== rendering
  renderNow() {
    if (!this.preview) return;
    const cropMode = this.tool === 'crop';
    const noMarkup = { ...this.edit, markup: [] };
    const key = JSON.stringify(noMarkup) + cropMode;
    if (key !== this.baseKey) {
      this.base = P.render(this.preview, this.srcW, this.srcH, noMarkup, { scale: this.pScale, crop: !cropMode });
      this.baseKey = key;
    }
    const c = this.canvas;
    if (c.width !== this.base.width || c.height !== this.base.height) {
      c.width = this.base.width;
      c.height = this.base.height;
    }
    const ctx = c.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(this.base, 0, 0);
    if (this.edit.markup.length) P.drawMarkup(c, this.srcW, this.srcH, this.edit, this.pScale, !cropMode);
    this._layoutCanvas();
    this._syncButtons();
  }

  _layoutCanvas() {
    if (!this.base) return;
    const sw = this.stage.clientWidth - 48;
    const sh = this.stage.clientHeight - 48;
    if (sw <= 0 || sh <= 0) return;
    const bw = this.base.width;
    const bh = this.base.height;
    // Small pictures may be enlarged up to 200 % so the crop handles stay usable.
    const k = Math.min(sw / bw, sh / bh, 2 / this.pScale);
    this.canvas.classList.toggle('pixelated', k * this.pScale > 1.5);
    const w = Math.max(1, Math.round(bw * k));
    const hh = Math.max(1, Math.round(bh * k));
    this.canvasWrap.style.width = `${w}px`;
    this.canvasWrap.style.height = `${hh}px`;
    this.cssW = w;
    this.cssH = hh;
    this._placeCrop();
  }

  _placeCrop() {
    if (this.tool !== 'crop') return;
    const c = P.isFullCrop(this.edit.crop) ? { x: 0, y: 0, w: 1, h: 1 } : this.edit.crop;
    const s = this.cropBox.style;
    s.left = `${c.x * this.cssW}px`;
    s.top = `${c.y * this.cssH}px`;
    s.width = `${c.w * this.cssW}px`;
    s.height = `${c.h * this.cssH}px`;
    const x1 = `${c.x * 100}%`;
    const y1 = `${c.y * 100}%`;
    const x2 = `${(c.x + c.w) * 100}%`;
    const y2 = `${(c.y + c.h) * 100}%`;
    this.cropDim.style.clipPath = `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${x1} ${y1}, ${x2} ${y1}, ${x2} ${y2}, ${x1} ${y2}, ${x1} ${y1})`;
  }

  // ================================================================== crop interaction
  _bindCrop() {
    let drag = null;
    const box = this.cropBox;
    box.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      box.focus({ preventScroll: true });
      const handle = e.target.dataset?.h || 'move';
      const c = P.isFullCrop(this.edit.crop) ? { x: 0, y: 0, w: 1, h: 1 } : { ...this.edit.crop };
      drag = { handle, x: e.clientX, y: e.clientY, c, id: e.pointerId };
      box.setPointerCapture(e.pointerId);
      this.cropLayer.classList.add('active');
    });
    box.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = (e.clientX - drag.x) / this.cssW;
      const dy = (e.clientY - drag.y) / this.cssH;
      this.edit.crop = this._dragCrop(drag.c, drag.handle, dx, dy);
      this._placeCrop();
    });
    const end = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      drag = null;
      this.cropLayer.classList.remove('active');
      if (P.isFullCrop(this.edit.crop)) this.edit.crop = null;
      this._commit();
      this._renderPanel();
    };
    box.addEventListener('pointerup', end);
    box.addEventListener('pointercancel', end);
    box.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 0.05 : 0.01;
      const m = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (!m) return;
      e.preventDefault();
      e.stopPropagation();
      const c = P.isFullCrop(this.edit.crop) ? { x: 0, y: 0, w: 1, h: 1 } : this.edit.crop;
      this.edit.crop = this._dragCrop(c, e.ctrlKey ? 'se' : 'move', m[0], m[1]);
      this._placeCrop();
      clearTimeout(this._kbT);
      this._kbT = setTimeout(() => this._commit(), 400);
    });
  }

  /** New crop rect for a drag of `handle` by (dx, dy) (normalized), honouring the aspect lock. */
  _dragCrop(c0, handle, dx, dy) {
    const [fw, fh] = this._frame();
    const minW = Math.max(16 / this.cssW, 8 / fw);
    const minH = Math.max(16 / this.cssH, 8 / fh);
    if (handle === 'move') {
      return { x: clamp(c0.x + dx, 0, 1 - c0.w), y: clamp(c0.y + dy, 0, 1 - c0.h), w: c0.w, h: c0.h };
    }
    const a = P.ASPECTS.find((x) => x.id === this.edit.aspect);
    const ratio = a?.r === 'original' ? fw / fh : a?.r || null;
    let { x, y, w, h } = c0;
    let x2 = x + w;
    let y2 = y + h;
    if (handle.includes('w')) x = clamp(x + dx, 0, x2 - minW);
    if (handle.includes('e')) x2 = clamp(x2 + dx, x + minW, 1);
    if (handle.includes('n')) y = clamp(y + dy, 0, y2 - minH);
    if (handle.includes('s')) y2 = clamp(y2 + dy, y + minH, 1);
    w = x2 - x;
    h = y2 - y;
    if (ratio) {
      const rn = (ratio * fh) / fw; // normalized w / h
      const horizontalDrive = handle === 'e' || handle === 'w' || (handle.length === 2 && Math.abs(dx) >= Math.abs(dy));
      if (horizontalDrive) h = w / rn;
      else w = h * rn;
      // Fit inside the frame from the fixed anchor.
      const ax = handle.includes('w') ? c0.x + c0.w : handle.includes('e') ? c0.x : c0.x + c0.w / 2;
      const ay = handle.includes('n') ? c0.y + c0.h : handle.includes('s') ? c0.y : c0.y + c0.h / 2;
      const maxW = handle.includes('w') ? ax : handle.includes('e') ? 1 - ax : 2 * Math.min(ax, 1 - ax);
      const maxH = handle.includes('n') ? ay : handle.includes('s') ? 1 - ay : 2 * Math.min(ay, 1 - ay);
      const k = Math.min(1, maxW / w, maxH / h);
      w *= k;
      h *= k;
      x = handle.includes('w') ? ax - w : handle.includes('e') ? ax : ax - w / 2;
      y = handle.includes('n') ? ay - h : handle.includes('s') ? ay : ay - h / 2;
    }
    return { x: clamp(x, 0, 1), y: clamp(y, 0, 1), w: clamp(w, minW, 1), h: clamp(h, minH, 1) };
  }

  // ================================================================== markup interaction
  _toSource(e) {
    const r = this.canvas.getBoundingClientRect();
    const ox = (e.clientX - r.left) / r.width;
    const oy = (e.clientY - r.top) / r.height;
    const [fx, fy] = P.outputToFrame(ox, oy, this.edit);
    return P.frameToSource(fx, fy, this.srcW, this.srcH, this.edit);
  }
  _bindMarkup() {
    let stroke = null;
    let erased = false;
    const c = this.canvas;
    const eraseAt = (e) => {
      const [sx, sy] = this._toSource(e);
      const r = (12 / this.cssW) * P.outputSize(this.srcW, this.srcH, this.edit)[0];
      const before = this.edit.markup.length;
      this.edit.markup = this.edit.markup.filter((s) => !P.strokeHit(s, sx, sy, this.srcW, this.srcH, r));
      if (this.edit.markup.length !== before) {
        erased = true;
        this._render();
      }
    };
    c.addEventListener('pointerdown', (e) => {
      if (this.tool !== 'markup' || e.button !== 0) return;
      e.preventDefault();
      c.setPointerCapture(e.pointerId);
      if (this.pen.tool === 'eraser') {
        erased = false;
        stroke = { eraser: true };
        eraseAt(e);
        return;
      }
      // Size: pixels on screen -> fraction of the source short side.
      const [ow] = P.outputSize(this.srcW, this.srcH, this.edit);
      const px = this.pen.size * (this.pen.tool === 'highlighter' ? 2.5 : 1);
      const size = ((px / this.cssW) * ow) / Math.min(this.srcW, this.srcH);
      stroke = { tool: this.pen.tool, color: this.pen.color, size, points: [this._toSource(e).map((v) => Math.round(v * 1e5) / 1e5)] };
      this.edit.markup.push(stroke);
      this._lastPt = [e.clientX, e.clientY];
      this._render();
    });
    c.addEventListener('pointermove', (e) => {
      if (!stroke) return;
      if (stroke.eraser) return eraseAt(e);
      if (Math.hypot(e.clientX - this._lastPt[0], e.clientY - this._lastPt[1]) < 1.5) return;
      this._lastPt = [e.clientX, e.clientY];
      stroke.points.push(this._toSource(e).map((v) => Math.round(v * 1e5) / 1e5));
      this._render();
    });
    const end = () => {
      if (!stroke) return;
      const wasEraser = stroke.eraser;
      stroke = null;
      if (!wasEraser || erased) {
        this._commit();
        this._renderPanel();
      }
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
  }

  // ================================================================== saving
  saveMenu(e) {
    const { t } = this;
    this.ui.menu(e, [
      { label: t('saveCopy'), icon: 'save_copy', shortcut: 'Ctrl+S', action: () => this.save('copy') },
      { label: t('save'), icon: 'save', disabled: !this.canOverwrite, action: () => this.save('overwrite') },
      { label: t('copyToClipboard'), icon: 'copy', action: () => this.save('clipboard') },
      '-',
      { label: t('jpegQualityItem', { q: this.lib.prefs.jpegQuality }), icon: 'options', action: () => this.qualityDialog() },
    ]);
  }

  async qualityDialog() {
    const { h, t } = this;
    const val = h('span', { class: 'ph-adj-val' }, String(this.lib.prefs.jpegQuality));
    const s = this.ui.slider({ min: 50, max: 100, step: 1, value: this.lib.prefs.jpegQuality, style: { width: '100%' } });
    s.addEventListener('input', () => (val.textContent = s.value));
    const ok = await this.ui.dialog({
      title: t('set.jpegQuality'),
      parent: this.app.win,
      body: h('div', { style: { minWidth: '320px' } }, h('div', { class: 'row ph-row-between' }, h('span', { class: 'text-2' }, t('set.jpegQualityDesc')), val), s),
      buttons: [
        { label: t('common.ok'), value: true, primary: true },
        { label: t('common.cancel'), value: null },
      ],
    });
    if (ok) this.lib.setPref('jpegQuality', Number(s.value));
  }

  async _renderFull() {
    return P.renderAsync(this.src, this.srcW, this.srcH, this.edit, { scale: 1, crop: true });
  }

  /** mode: 'copy' | 'overwrite' | 'clipboard'. Resolves to the written path (or true for clipboard), null if cancelled. */
  async save(mode = 'copy') {
    if (this.busy || !this.item) return null;
    const { t } = this;
    const it = this.item;
    const ext0 = extOf(it.path);
    let dest = it.path;
    let ext = ext0;
    if (mode === 'overwrite') {
      if (!this.canOverwrite) return this.save('copy');
      const ok = await this.ui.confirm(t('overwriteBody', { name: it.name }), { title: t('overwriteTitle'), okLabel: t('save'), parent: this.app.win });
      if (!ok) return null;
    } else if (mode === 'copy') {
      ext = ENCODABLE[ext0] || ext0 === '.bmp' ? ext0 : '.png';
      const dir = dirName(it.path);
      let name = `${stem(it.path)}${ext}`;
      try {
        name = await this.app.api.invoke('fs:uniqueName', dir, name);
      } catch {}
      const filters = [
        { name: t('fmt.jpeg'), ext: ['.jpg', '.jpeg'] },
        { name: t('fmt.png'), ext: ['.png'] },
        { name: t('fmt.webp'), ext: ['.webp'] },
        { name: t('fmt.bmp'), ext: ['.bmp'] },
      ];
      const first = filters.findIndex((f) => f.ext.includes(ext));
      if (first > 0) filters.unshift(filters.splice(first, 1)[0]);
      // "All supported pictures" first: the extension typed in the name picks the format.
      filters.unshift({ name: t('fmt.all'), ext: [ext, ...['.jpg', '.jpeg', '.png', '.webp', '.bmp'].filter((e) => e !== ext)] });
      dest = await this.ui.filePicker({ mode: 'save', title: t('saveCopy'), path: dir, name, filters, parent: this.app.win });
      if (!dest) return null;
      ext = extOf(dest);
      if (!ENCODABLE[ext] && ext !== '.bmp') {
        dest += '.png';
        ext = '.png';
      }
    }
    this.busy = true;
    this.savingEl.hidden = false;
    this.savingEl.querySelector('.ph-esaving-label').textContent = mode === 'clipboard' ? t('copying') : t('saving');
    try {
      const canvas = await this._renderFull();
      const blob = await P.encode(canvas, mode === 'clipboard' ? '.png' : ext, (this.lib.prefs.jpegQuality || 92) / 100);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (mode === 'clipboard') {
        await this.app.api.invoke('clipboard:writeImage', bytes);
        this.app.toast(t('copiedImage'));
        return true;
      }
      await this.app.api.invoke('photos:write', dest, bytes);
      // History baseline: the saved state is now "clean".
      const saved = dest;
      this.app.editorSaved(it, saved, mode);
      return saved;
    } catch (err) {
      this.app.error(t('saveFailed', { name: baseName(dest) }), err);
      return null;
    } finally {
      this.busy = false;
      this.savingEl.hidden = true;
    }
  }

  /** Ask before discarding edits. Resolves true when it's OK to leave. */
  async confirmLeave() {
    if (!this.dirty) return true;
    const { t } = this;
    const v = await this.ui.dialog({
      title: t('unsavedTitle'),
      body: t('unsavedBody'),
      parent: this.app.win,
      buttons: [
        { label: t('saveCopy'), value: 'save', primary: true },
        { label: t('dontSave'), value: 'discard' },
        { label: t('common.cancel'), value: null },
      ],
    });
    if (v === 'discard') return true;
    if (v === 'save') return !!(await this.save('copy'));
    return false;
  }

  onKey(e) {
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (ctrl && k === 'z' && !e.shiftKey) return this.undo(), true;
    if (ctrl && (k === 'y' || (k === 'z' && e.shiftKey))) return this.redo(), true;
    if (ctrl && k === 's') return this.save('copy'), true;
    if (e.key === 'Escape') {
      this.app.closeEditor();
      return true;
    }
    return false;
  }
}
