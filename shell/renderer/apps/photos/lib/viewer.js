// Photo viewer: fit / zoom (wheel at cursor, keys, slider, double-click), pan, swipe, prev/next,
// filmstrip, floating toolbar, info pane, rotate, delete, favorite, full screen.
import { fitScale, clampPan, zoomAt, centered, stepZoom, minZoom, sliderToScale, scaleToSlider, MAX_ZOOM } from './zoom.js';
import { clamp, extOf, baseName, dirName, formatExposure, megapixels, rafThrottle, reduceMotion, setDragPaths, EASE } from './util.js';

const FILM_ITEM = 56;
const FILM_GAP = 4;
const FILM_STRIDE = FILM_ITEM + FILM_GAP;
const BAR_TOP = 56;
const BAR_BOTTOM = 84;

export class Viewer {
  constructor(app) {
    this.app = app;
    this.h = app.h;
    this.t = app.t;
    this.icon = app.icon;
    this.ui = app.ui;
    this.lib = app.lib;
    this.thumbs = app.thumbs;
    this.list = [];
    this.index = -1;
    this.item = null;
    this.nw = 0;
    this.nh = 0;
    this.z = { s: 1, tx: 0, ty: 0 };
    this.fit = 1;
    this.atFit = true;
    this.loadToken = 0;
    this.cache = new Map(); // url -> HTMLImageElement (decoded)
    this.infoOpen = false;
    this.fs = false;
    this.from = 'gallery';
    this._rotQueue = Promise.resolve();
    this._build();
  }

  // ================================================================== DOM
  _build() {
    const { h, t, icon } = this;
    const tb = (ic, label, key, onclick, extra = {}) =>
      h('button', { class: 'btn subtle icon-btn ph-tb', 'aria-label': label, 'data-tip': key ? `${label} (${key})` : label, 'data-tip-pos': 'below', onclick, ...extra }, icon(ic));
    this.btnEdit = h('button', { class: 'btn subtle ph-tb ph-tb-edit', 'data-tip': `${t('editImage')} (Ctrl+E)`, 'data-tip-pos': 'below', 'aria-label': t('editImage'), onclick: () => this.edit() }, icon('image_edit'), h('span', { class: 'ph-tb-label' }, t('edit')));
    this.btnRotate = tb('arrow_rotate_clockwise', t('rotate'), 'Ctrl+R', () => this.rotate(), { dataset: { cmd: 'rotate' } });
    this.btnFav = tb('heart', t('favorite'), 'Ctrl+D', () => this.toggleFavorite(), { dataset: { cmd: 'favorite' } });
    this.btnDelete = tb('delete', t('delete'), 'Del', () => this.deleteCurrent(), { dataset: { cmd: 'delete' } });
    this.btnInfo = tb('info', t('fileInfo'), 'I', () => this.toggleInfo(), { dataset: { cmd: 'info' } });
    this.btnMore = tb('more_horizontal', t('more'), null, (e) => this.moreMenu(e), { dataset: { cmd: 'more' } });
    this.tools = h('div', { class: 'ph-vtools', role: 'toolbar', 'aria-label': t('imageTools') }, this.btnEdit, h('div', { class: 'vsep' }), this.btnRotate, this.btnFav, this.btnDelete, h('div', { class: 'vsep' }), this.btnInfo, this.btnMore);
    this.backBtn = h('button', { class: 'btn subtle ph-vback', 'aria-label': t('backToGallery'), 'data-tip': t('backToGallery'), 'data-tip-pos': 'below', onclick: () => this.app.closeViewer() }, icon('arrow_left'), h('span', { class: 'ph-vback-label' }, t('nav.gallery')));
    this.nameEl = h('div', { class: 'ph-vname ellipsis' });
    this.top = h('div', { class: 'ph-vtop' }, h('div', { class: 'ph-vtop-left' }, this.backBtn, this.nameEl), this.tools, h('div', { class: 'ph-vtop-right' }));

    this.imgwrap = h('div', { class: 'ph-imgwrap' });
    this.prevBtn = h('button', { class: 'ph-chev prev', tabindex: '-1', 'aria-label': t('previous'), 'data-tip': `${t('previous')} (←)`, onclick: () => this.go(this.index - 1, -1) }, icon('chevron_left', { size: 20 }));
    this.nextBtn = h('button', { class: 'ph-chev next', tabindex: '-1', 'aria-label': t('next'), 'data-tip': `${t('next')} (→)`, onclick: () => this.go(this.index + 1, 1) }, icon('chevron_right', { size: 20 }));
    this.spinner = h('div', { class: 'spinner ph-vspin', hidden: true });
    this.errorEl = h('div', { class: 'ph-verror', hidden: true });
    this.stage = h('div', { class: 'ph-stage', tabindex: '-1' }, this.imgwrap, this.spinner, this.errorEl);

    // Bottom bar: full screen / slideshow · filmstrip · zoom
    this.btnFs = h('button', { class: 'btn subtle icon-btn ph-tb', 'aria-label': t('fullScreen'), 'data-tip': `${t('fullScreen')} (F11)`, dataset: { cmd: 'fullscreen' }, onclick: () => this.toggleFullscreen() }, icon('full_screen_maximize'));
    this.btnShow = h('button', { class: 'btn subtle icon-btn ph-tb', 'aria-label': t('slideshow'), 'data-tip': `${t('slideshow')} (F5)`, dataset: { cmd: 'slideshow' }, onclick: () => this.app.startSlideshow(this.list, this.index) }, icon('slide_play'));
    this.counter = h('span', { class: 'ph-counter caption text-2' });
    this.film = h('div', { class: 'ph-film', role: 'listbox', 'aria-label': t('filmstrip'), tabindex: '-1' });
    this.filmInner = h('div', { class: 'ph-film-inner' });
    this.film.appendChild(this.filmInner);
    this.zoomSlider = this.ui.slider({ min: 0, max: 100, step: 0.5, value: 0, style: { width: '120px' } });
    this.zoomSlider.classList.add('ph-zoom-slider');
    this.zoomSlider.setAttribute('aria-label', t('zoom'));
    this.zoomSlider.addEventListener('input', () => {
      const r = this._rect();
      this.setZoom(sliderToScale(Number(this.zoomSlider.value), minZoom(this.fit), MAX_ZOOM), r.width / 2, r.height / 2, false);
    });
    this.zoomLabel = h('button', { class: 'btn subtle ph-zoom-label', 'data-tip': t('zoomOptions'), dataset: { cmd: 'zoom-menu' }, onclick: (e) => this.zoomMenu(e) }, '100%');
    this.zoomBox = h(
      'div',
      { class: 'ph-zoom' },
      h('button', { class: 'btn subtle icon-btn ph-tb', 'aria-label': t('zoomOut'), 'data-tip': `${t('zoomOut')} (Ctrl+−)`, dataset: { cmd: 'zoom-out' }, onclick: () => this.zoomStep(-1) }, icon('zoom_out')),
      this.zoomSlider,
      h('button', { class: 'btn subtle icon-btn ph-tb', 'aria-label': t('zoomIn'), 'data-tip': `${t('zoomIn')} (Ctrl++)`, dataset: { cmd: 'zoom-in' }, onclick: () => this.zoomStep(1) }, icon('zoom_in')),
      this.zoomLabel,
    );
    this.bottom = h('div', { class: 'ph-vbottom' }, h('div', { class: 'ph-vbottom-left' }, this.btnFs, this.btnShow, this.counter), this.film, this.zoomBox);

    this.info = h('aside', { class: 'ph-info', 'aria-label': t('fileInfo'), hidden: true });
    this.center = h('div', { class: 'ph-vcenter' }, this.stage, this.prevBtn, this.nextBtn, this.top, this.bottom);
    this.el = h('div', { class: 'ph-viewer' }, this.center, this.info);

    this._render = rafThrottle(() => this._apply());
    this._bindStage();
    this._bindFilm();
    this.ro = new ResizeObserver(() => this._onResize());
    this.ro.observe(this.stage);
    this.ro.observe(this.el);
    // Bars auto-hide in full screen.
    this.center.addEventListener('pointermove', () => this._poke());
  }

  destroy() {
    this.ro.disconnect();
    clearTimeout(this._idleT);
    this.loadToken++;
  }

  applyPrefs() {
    this.el.dataset.bg = this.lib.prefs.viewerBackground === 'theme' ? 'theme' : 'dark';
    this.el.classList.toggle('no-film', !this.lib.prefs.filmstrip);
    this._refit();
  }

  // ================================================================== open / navigation
  open(list, index, { from = 'gallery' } = {}) {
    this.list = list.slice();
    this.from = from;
    this.el.classList.toggle('standalone', from !== 'gallery');
    this.backBtn.querySelector('.ph-vback-label').textContent = from === 'gallery' ? this.t('nav.gallery') : this.t('seeAll');
    const lab = from === 'gallery' ? `${this.t('backToGallery')} (Esc)` : this.t('seeAll');
    this.backBtn.dataset.tip = lab;
    this.backBtn.setAttribute('aria-label', lab);
    this.applyPrefs();
    this._buildFilm();
    this.show(clamp(index, 0, this.list.length - 1), 0);
  }

  setList(list, index) {
    this.list = list.slice();
    this._buildFilm();
    if (index != null) this.show(index, 0);
  }

  go(i, dir = 0) {
    if (!this.list.length) return;
    if (i < 0 || i >= this.list.length) {
      this._bump(i < 0 ? -1 : 1);
      return;
    }
    if (i === this.index) return;
    this.show(i, dir || Math.sign(i - this.index));
  }

  _bump(dir) {
    if (reduceMotion()) return;
    this.imgwrap.animate([{ transform: 'translateX(0)' }, { transform: `translateX(${-dir * 24}px)` }, { transform: 'translateX(0)' }], { duration: 260, easing: EASE });
  }

  fullUrl(it) {
    return `${this.app.api.mediaUrl(it.path)}?v=${Math.round(it.mtime || 0)}-${it.size || 0}`;
  }

  _decode(url) {
    const hit = this.cache.get(url);
    if (hit) return hit;
    const img = new Image();
    img.decoding = 'async';
    const p = new Promise((resolve, reject) => {
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('decode'));
    }).then(async () => {
      try {
        await img.decode();
      } catch {}
      return img;
    });
    img.src = url;
    const entry = p;
    this.cache.set(url, entry);
    entry.catch(() => this.cache.delete(url));
    while (this.cache.size > 6) this.cache.delete(this.cache.keys().next().value);
    return entry;
  }

  _resetWrap() {
    const w = this.imgwrap.style;
    if (!w.transform) return;
    w.transition = 'none';
    w.transform = '';
    w.transformOrigin = '';
    void this.imgwrap.offsetWidth;
    w.transition = '';
  }

  async show(i, dir = 0, { instant = false } = {}) {
    const it = this.list[i];
    if (!it) return;
    this.index = i;
    this.item = it;
    const token = ++this.loadToken;
    this._updateChrome();
    this._syncFilm(true);
    if (this.infoOpen) this._renderInfo();
    this.errorEl.hidden = true;
    clearTimeout(this._spinT);
    this._spinT = setTimeout(() => token === this.loadToken && (this.spinner.hidden = false), 250);

    // Placeholder: the cached thumbnail at the final size, so the photo appears immediately.
    const layer = this.h('img', { class: 'ph-img', alt: it.name, draggable: false });
    const thumb = this.thumbs.url(it);
    const nw0 = it.w || 0;
    const nh0 = it.h || 0;
    const old = this.imgwrap.querySelector('.ph-img:not(.leaving)');
    let placed = false;
    if (thumb && nw0 && nh0 && !instant) {
      layer.src = thumb;
      this._place(layer, nw0, nh0, old, dir);
      placed = true;
    }
    if (!instant) this._resetWrap();
    let full;
    try {
      full = await this._decode(this.fullUrl(it));
    } catch {
      if (token !== this.loadToken) return;
      clearTimeout(this._spinT);
      this.spinner.hidden = true;
      if (!placed) this._place(layer, 0, 0, old, dir, true);
      layer.remove();
      this._showError(it);
      return;
    }
    if (token !== this.loadToken) return;
    clearTimeout(this._spinT);
    this.spinner.hidden = true;
    if (instant) this._resetWrap();
    const nw = full.naturalWidth || nw0 || 1;
    const nh = full.naturalHeight || nh0 || 1;
    if (!it.w || !it.h || Math.abs(nw / nh - it.w / it.h) > 0.02) {
      it.w = nw;
      it.h = nh;
    }
    layer.src = full.src;
    if (placed && (nw !== this.nw || nh !== this.nh)) {
      // Real size differs from the header guess: keep the visual size, swap the scale.
      const k = this.nw / nw;
      this.nw = nw;
      this.nh = nh;
      layer.style.width = `${nw}px`;
      layer.style.height = `${nh}px`;
      this.z.s *= k;
      this.fit = this._fitFor(nw, nh);
      if (this.atFit) this._toFit(false);
      this._apply();
    } else if (!placed) this._place(layer, nw, nh, old, dir, false, instant);
    layer.classList.toggle('pixel-art', nw <= 64 && nh <= 64);
    this._preload(i);
  }

  _place(layer, nw, nh, old, dir, empty = false, instant = false) {
    this.nw = nw;
    this.nh = nh;
    layer.style.width = `${nw}px`;
    layer.style.height = `${nh}px`;
    this.img = layer;
    if (!empty) this.imgwrap.appendChild(layer);
    this.fit = this._fitFor(nw, nh);
    this._toFit(false);
    this._apply();
    const anim = !reduceMotion() && old && !instant;
    if (old) {
      old.classList.add('leaving');
      if (anim) {
        const ox = dir ? -dir * 60 : 0;
        old.animate([{ opacity: 1 }, { opacity: 0, translate: `${ox}px 0` }], { duration: 160, easing: 'linear', fill: 'forwards' }).finished.finally(() => old.remove());
      } else old.remove();
    }
    if (anim && !empty) layer.animate([{ opacity: 0, translate: `${dir * 60}px 0` }, { opacity: 1, translate: '0 0' }], { duration: 260, easing: EASE });
    for (const o of this.imgwrap.querySelectorAll('.ph-img.leaving')) if (o !== old && !o.getAnimations().length) o.remove();
  }

  _preload(i) {
    for (const k of [i + 1, i - 1]) {
      const it = this.list[k];
      if (it && !this.cache.has(this.fullUrl(it))) this._decode(this.fullUrl(it)).catch(() => {});
    }
  }

  _showError(it) {
    const { h, t } = this;
    this.ui.clear(this.errorEl);
    this.errorEl.hidden = false;
    this.errorEl.append(
      this.icon('image_off', { size: 48 }),
      h('div', { class: 'subtitle' }, t('cantOpenTitle')),
      h('div', { class: 'text-2' }, t('cantOpenBody', { name: it.name })),
      h('button', { class: 'btn', onclick: () => this.app.showInFolder(it) }, this.icon('folder_open'), t('showInFolder')),
    );
    this.img = null;
    this.nw = 0;
    this.nh = 0;
    this._updateZoomUi();
  }

  _updateChrome() {
    const it = this.item;
    const { t } = this;
    if (!it) return;
    this.app.setTitle(it.name);
    this.nameEl.textContent = it.name;
    this.nameEl.dataset.tip = it.path;
    this.counter.textContent = t('counter', { i: this.index + 1, n: this.list.length });
    const fav = this.lib.isFavorite(it.path);
    this.btnFav.classList.toggle('on', fav);
    this.btnFav.replaceChildren(this.icon('heart', { filled: fav }));
    const lab = fav ? t('unfavorite') : t('favorite');
    this.btnFav.setAttribute('aria-label', lab);
    this.btnFav.setAttribute('aria-pressed', String(fav));
    this.btnFav.dataset.tip = `${lab} (Ctrl+D)`;
    const ext = extOf(it.path);
    const canRotate = ['.jpg', '.jpeg', '.png', '.webp', '.bmp'].includes(ext);
    this.btnRotate.disabled = !canRotate;
    this.btnRotate.dataset.tip = canRotate ? `${t('rotate')} (Ctrl+R)` : t('rotateUnavailable');
    this.prevBtn.hidden = this.index <= 0;
    this.nextBtn.hidden = this.index >= this.list.length - 1;
  }

  // ================================================================== zoom & pan
  _rect() {
    return { width: this.stage.clientWidth || 1, height: this.stage.clientHeight || 1 };
  }
  _insets() {
    if (this.fs) return { top: 0, bottom: 0 };
    return { top: BAR_TOP, bottom: this.lib.prefs.filmstrip ? BAR_BOTTOM : BAR_TOP };
  }
  _fitFor(nw, nh) {
    const r = this._rect();
    const ins = this._insets();
    const svg = extOf(this.item?.path) === '.svg';
    return fitScale(nw, nh, r.width - 16, r.height - ins.top - ins.bottom, { upscale: svg });
  }
  _toFit(animate) {
    const r = this._rect();
    const ins = this._insets();
    const c = centered(this.fit, this.nw, this.nh, r.width, r.height - ins.top - ins.bottom);
    this.z = { s: this.fit, tx: c.tx, ty: c.ty + ins.top };
    this.atFit = true;
    if (animate) this._animateNext();
    this._render();
  }
  fitToWindow() {
    this._toFit(true);
  }
  _refit() {
    if (!this.nw) return;
    this.fit = this._fitFor(this.nw, this.nh);
    if (this.atFit) this._toFit(false);
    else {
      this.z = this._clamp(this.z);
      this._render();
    }
  }
  _onResize() {
    this.el.classList.toggle('compact', this.el.clientWidth < 760);
    this._refit();
    this._renderFilm();
  }
  _clamp(z) {
    const r = this._rect();
    const ins = this._insets();
    const hgt = this.nh * z.s;
    // Clamp inside the area between the bars when the image fits there, else the whole stage.
    const areaH = r.height - ins.top - ins.bottom;
    if (hgt <= areaH) {
      const c = clampPan(z, this.nw, this.nh, r.width, areaH);
      return { ...c, ty: c.ty + ins.top };
    }
    return clampPan(z, this.nw, this.nh, r.width, r.height);
  }
  setZoom(s, cx, cy, animate = true) {
    if (!this.nw) return;
    s = clamp(s, minZoom(this.fit), MAX_ZOOM);
    if (Math.abs(s - this.fit) < 1e-4) return this._toFit(animate);
    this.z = this._clamp(zoomAt(this.z, s, cx, cy));
    this.atFit = false;
    if (animate) this._animateNext();
    this._render();
  }
  zoomStep(dir) {
    const r = this._rect();
    this.setZoom(stepZoom(this.z.s, dir, this.fit), r.width / 2, r.height / 2);
  }
  zoomTo(s) {
    const r = this._rect();
    this.setZoom(s, r.width / 2, r.height / 2);
  }
  _animateNext() {
    if (reduceMotion() || !this.img) return;
    this.img.classList.add('animating');
    clearTimeout(this._animT);
    this._animT = setTimeout(() => this.img?.classList.remove('animating'), 260);
  }
  _apply() {
    const img = this.img;
    if (!img) return this._updateZoomUi();
    const { s, tx, ty } = this.z;
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
    img.classList.toggle('pixelated', s >= 3);
    this.stage.classList.toggle('zoomed', !this.atFit && (this.nw * s > this._rect().width + 1 || this.nh * s > this._rect().height + 1));
    this._updateZoomUi();
  }
  _updateZoomUi() {
    const pct = this.nw ? Math.round(this.z.s * 100) : 100;
    this.zoomLabel.textContent = `${pct}%`;
    this.zoomLabel.setAttribute('aria-label', this.t('zoomLevel', { pct }));
    this.zoomSlider.setValue?.(this.nw ? scaleToSlider(this.z.s, minZoom(this.fit), MAX_ZOOM) : 0);
  }
  zoomMenu(e) {
    const { t } = this;
    this.ui.menu(e, [
      { label: t('fitToWindow'), shortcut: 'Ctrl+0', action: () => this.fitToWindow() },
      { label: t('actualSize'), shortcut: 'Ctrl+1', action: () => this.zoomTo(1) },
      '-',
      ...[0.25, 0.5, 2, 4, 8].map((s) => ({ label: `${s * 100}%`, action: () => this.zoomTo(s) })),
    ]);
  }

  _bindStage() {
    const st = this.stage;
    st.addEventListener(
      'wheel',
      (e) => {
        if (!this.nw) return;
        e.preventDefault();
        // Horizontal touchpad swipes browse; vertical wheel zooms at the cursor (Windows Photos default).
        if (Math.abs(e.deltaX) > Math.abs(e.deltaY) * 1.5 && !e.ctrlKey) {
          this._swipeAcc = (this._swipeAcc || 0) + e.deltaX;
          clearTimeout(this._swipeT);
          this._swipeT = setTimeout(() => (this._swipeAcc = 0), 200);
          if (Math.abs(this._swipeAcc) > 120 && Date.now() - (this._swipeAt || 0) > 400) {
            this._swipeAt = Date.now();
            this.go(this.index + Math.sign(this._swipeAcc), Math.sign(this._swipeAcc));
            this._swipeAcc = 0;
          }
          return;
        }
        const r = st.getBoundingClientRect();
        const d = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
        const k = Math.exp(-clamp(d, -300, 300) * 0.0022);
        this.setZoom(this.z.s * k, e.clientX - r.left, e.clientY - r.top, false);
      },
      { passive: false },
    );
    st.addEventListener('contextmenu', (e) => {
      if (!this.item || e.target.closest('.ph-verror')) return;
      e.preventDefault();
      this.app.itemMenu(e, this.item, [this.item], { viewer: true });
    });
    st.addEventListener('dblclick', (e) => {
      if (!this.nw || e.target.closest('button')) return;
      const r = st.getBoundingClientRect();
      if (this.atFit || Math.abs(this.z.s - this.fit) < 1e-3) {
        const target = this.fit < 0.999 ? 1 : this.fit * 2;
        this.setZoom(target, e.clientX - r.left, e.clientY - r.top);
      } else this.fitToWindow();
    });
    let drag = null;
    st.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !this.nw || e.target.closest('button, .ph-verror')) return;
      e.preventDefault();
      st.focus({ preventScroll: true });
      const zoomed = this.stage.classList.contains('zoomed');
      drag = { x: e.clientX, y: e.clientY, z: { ...this.z }, zoomed, moved: false, id: e.pointerId };
      st.setPointerCapture(e.pointerId);
      if (zoomed) st.classList.add('panning');
    });
    st.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      if (drag.zoomed) {
        this.z = this._clamp({ s: drag.z.s, tx: drag.z.tx + dx, ty: drag.z.ty + dy });
        this._render();
      } else if (this.img && this.list.length > 1) {
        // Swipe: the photo follows the pointer horizontally.
        this.img.style.translate = `${dx}px 0`;
        this.img.style.opacity = String(1 - Math.min(0.5, Math.abs(dx) / 600));
      }
    });
    const end = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x;
      st.classList.remove('panning');
      if (!drag.zoomed && this.img) {
        const img = this.img;
        if (Math.abs(dx) > 80 && e.type === 'pointerup') {
          const dir = dx < 0 ? 1 : -1;
          const target = this.index + dir;
          if (target >= 0 && target < this.list.length) {
            this.go(target, dir);
          } else this._snapBack(img);
        } else this._snapBack(img);
      }
      drag = null;
    };
    st.addEventListener('pointerup', end);
    st.addEventListener('pointercancel', end);
  }
  _snapBack(img) {
    if (!img.style.translate) return;
    const from = img.style.translate;
    img.style.translate = '';
    img.style.opacity = '';
    if (!reduceMotion()) img.animate([{ translate: from }, { translate: '0 0' }], { duration: 200, easing: EASE });
  }

  // ================================================================== filmstrip (virtualized)
  _bindFilm() {
    this.film.addEventListener('scroll', () => this._renderFilm(), { passive: true });
    this.film.addEventListener(
      'wheel',
      (e) => {
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
          e.preventDefault();
          this.film.scrollLeft += e.deltaY;
        }
      },
      { passive: false },
    );
    this.film.addEventListener('click', (e) => {
      const el = e.target.closest('.ph-film-item');
      if (el) this.go(Number(el.dataset.i));
    });
    this.film.addEventListener('dragstart', (e) => {
      const el = e.target.closest('.ph-film-item');
      const it = el && this.list[Number(el.dataset.i)];
      if (it) setDragPaths(e.dataTransfer, [it.path]);
    });
  }
  _buildFilm() {
    this.filmInner.style.width = `${this.list.length * FILM_STRIDE - FILM_GAP + 16}px`;
    this.ui.clear(this.filmInner);
    this._filmEls = new Map();
    this._renderFilm();
  }
  _renderFilm() {
    if (!this._filmEls) return;
    const w = this.film.clientWidth || 600;
    const sl = this.film.scrollLeft;
    const from = Math.max(0, Math.floor((sl - 8) / FILM_STRIDE) - 4);
    const to = Math.min(this.list.length - 1, Math.ceil((sl + w) / FILM_STRIDE) + 4);
    for (const [i, el] of this._filmEls) {
      if (i < from || i > to) {
        el.remove();
        this._filmEls.delete(i);
      }
    }
    for (let i = from; i <= to; i++) {
      if (this._filmEls.has(i)) continue;
      const it = this.list[i];
      const img = this.h('img', { alt: '', draggable: false });
      const el = this.h('div', { class: ['ph-film-item', i === this.index && 'current'], role: 'option', 'aria-selected': String(i === this.index), 'aria-label': it.name, draggable: 'true', dataset: { i }, style: { left: `${8 + i * FILM_STRIDE}px` } }, img);
      img.onload = () => el.classList.add('loaded');
      const u = this.thumbs.url(it);
      if (u) img.src = u;
      else
        this.thumbs.request(it, 1).then((x) => {
          if (x && el.isConnected) img.src = x;
        });
      this._filmEls.set(i, el);
      this.filmInner.appendChild(el);
    }
  }
  _syncFilm(smooth) {
    if (!this._filmEls) return;
    for (const [i, el] of this._filmEls) {
      el.classList.toggle('current', i === this.index);
      el.setAttribute('aria-selected', String(i === this.index));
    }
    const w = this.film.clientWidth;
    const target = 8 + this.index * FILM_STRIDE + FILM_ITEM / 2 - w / 2;
    this.film.scrollTo({ left: Math.max(0, target), behavior: smooth && !reduceMotion() ? 'smooth' : 'auto' });
    this._renderFilm();
  }

  // ================================================================== commands
  edit() {
    if (this.item) this.app.openEditor(this.item);
  }

  toggleFavorite() {
    if (!this.item) return;
    const on = this.lib.toggleFavorite([this.item.path]);
    this._updateChrome();
    if (!reduceMotion()) this.btnFav.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.25)' }, { transform: 'scale(1)' }], { duration: 300, easing: EASE });
    this.app.announce(on ? this.t('addedFav') : this.t('removedFav'));
  }

  toggleInfo(force) {
    this.infoOpen = force ?? !this.infoOpen;
    this.info.hidden = !this.infoOpen;
    this.btnInfo.classList.toggle('toggled', this.infoOpen);
    this.btnInfo.setAttribute('aria-pressed', String(this.infoOpen));
    if (this.infoOpen) {
      this._renderInfo();
      if (!reduceMotion()) this.info.animate([{ transform: 'translateX(24px)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 220, easing: EASE });
    }
  }

  async _renderInfo() {
    const it = this.item;
    if (!it) return;
    const { h, t } = this;
    const token = (this._infoTok = (this._infoTok || 0) + 1);
    let meta = null;
    try {
      meta = await this.app.api.invoke('photos:meta', it.path);
    } catch {}
    if (token !== this._infoTok || !this.infoOpen) return;
    const i18n = this.app.ctx.i18n;
    const row = (ic, label, ...lines) =>
      h('div', { class: 'ph-info-row' }, this.icon(ic, { size: 20 }), h('div', { class: 'ph-info-text' }, h('div', { class: 'caption text-2' }, label), ...lines.filter(Boolean).map((l) => (l instanceof Node ? l : h('div', { class: 'selectable' }, l)))));
    const w = meta?.w || this.nw || it.w;
    const hh = meta?.h || this.nh || it.h;
    const taken = meta?.taken || it.taken;
    const camera = [meta?.make, meta?.model && !(meta?.make && meta.model.startsWith(meta.make)) ? meta.model : meta?.model && meta?.make ? meta.model.replace(meta.make, '').trim() : meta?.model].filter(Boolean).join(' ');
    const exp = [meta?.fnumber ? `f/${Math.round(meta.fnumber * 10) / 10}` : null, meta?.exposure ? formatExposure(meta.exposure) : null, meta?.iso ? `ISO ${meta.iso}` : null, meta?.focal ? `${Math.round(meta.focal)} mm` : null].filter(Boolean).join(' · ');
    const albums = this.lib.albums.filter((a) => a.items.includes(it.path));
    const ext = extOf(it.path).slice(1).toUpperCase();
    this.ui.clear(this.info);
    const parts = [
      h(
        'div',
        { class: 'ph-info-head' },
        h('div', { class: 'subtitle' }, t('fileInfo')),
        h('button', { class: 'btn subtle icon-btn', 'aria-label': t('close'), 'data-tip': t('close'), onclick: () => this.toggleInfo(false) }, this.icon('dismiss')),
      ),
      h('div', { class: 'ph-info-name body-strong selectable' }, it.name),
      row('calendar', taken ? t('dateTaken') : t('dateModified'), i18n.formatDate(taken || meta?.mtime || it.mtime, { dateStyle: 'full' }), i18n.formatTime(taken || meta?.mtime || it.mtime, { hour: 'numeric', minute: '2-digit' })),
      w && hh ? row('image', t('dimensions'), `${w} × ${hh}`, w * hh >= 1e6 ? t('megapixels', { mp: i18n.formatNumber(megapixels(w, hh)) }) : null) : null,
      row('document', t('fileSize'), i18n.formatSize(meta?.size ?? it.size), t('fileType', { type: ext })),
      camera || exp ? row('camera', t('camera'), camera || null, exp || null, meta?.lens || null) : null,
      meta?.gps ? row('location', t('location'), `${meta.gps.lat.toFixed(5)}, ${meta.gps.lon.toFixed(5)}`) : null,
      row(
        'folder',
        t('location_folder'),
        h('div', { class: 'selectable ph-info-path' }, dirName(it.path)),
        h('a', { href: '#', class: 'ph-info-link', onclick: (e) => (e.preventDefault(), this.app.showInFolder(it)) }, t('openFileLocation')),
      ),
      albums.length
        ? row('album', t('nav.albums'), h('div', { class: 'ph-chips' }, ...albums.map((a) => h('button', { class: 'ph-chip', onclick: () => this.app.goToAlbum(a.id) }, a.name))))
        : null,
    ];
    this.info.append(...parts.filter(Boolean));
  }

  moreMenu(e) {
    const it = this.item;
    if (!it) return;
    this.app.itemMenu(e, it, [it], { viewer: true });
  }

  toggleFullscreen(force) {
    this.fs = force ?? !this.fs;
    this.app.win.setFullscreen(this.fs);
    this.el.classList.toggle('fs', this.fs);
    this.btnFs.replaceChildren(this.icon(this.fs ? 'full_screen_minimize' : 'full_screen_maximize'));
    const lab = this.fs ? this.t('exitFullScreen') : this.t('fullScreen');
    this.btnFs.setAttribute('aria-label', lab);
    this.btnFs.dataset.tip = `${lab} (F11)`;
    this._poke();
    requestAnimationFrame(() => this._refit());
  }
  _poke() {
    this.el.classList.remove('idle');
    clearTimeout(this._idleT);
    if (this.fs) this._idleT = setTimeout(() => this.el.classList.add('idle'), 2500);
  }

  // Rotation is saved to the file: JPEG losslessly (EXIF orientation), PNG/WebP/BMP re-encoded.
  rotate(steps = 1) {
    const it = this.item;
    if (!it || this.btnRotate.disabled) {
      if (it) this.app.toast(this.t('rotateUnavailable'));
      return;
    }
    // Immediate visual feedback (turn around the photo's centre, rescaled to the new fit); the file is
    // written in the background and presses are queued.
    this._pendingRot = (this._pendingRot || 0) + steps;
    const deg = this._pendingRot * 90;
    const odd = Math.abs(this._pendingRot) % 2 === 1;
    const k = this.atFit && this.nw ? (odd ? this._fitFor(this.nh, this.nw) : this.fit) / this.fit : 1;
    const ox = this.z.tx + (this.nw * this.z.s) / 2;
    const oy = this.z.ty + (this.nh * this.z.s) / 2;
    const w = this.imgwrap.style;
    w.transformOrigin = `${ox}px ${oy}px`;
    w.transition = reduceMotion() ? 'none' : `transform 250ms ${EASE}`;
    w.transform = `rotate(${deg}deg) scale(${k})`;
    this._rotQueue = this._rotQueue.then(async () => {
      try {
        await this.app.rotateFile(it, steps);
      } catch (err) {
        this.app.error(this.t('rotateFailed'), err);
      }
      this._pendingRot -= steps;
      if (this._pendingRot !== 0) return;
      if (this.item === it) await this.show(this.index, 0, { instant: true });
      this._resetWrap();
      this._rotDone = (this._rotDone || 0) + 1;
    });
    return this._rotQueue;
  }

  async deleteCurrent() {
    const it = this.item;
    if (!it) return;
    const ok = await this.app.deleteItems([it]);
    if (!ok) return;
  }

  /** Called by the app after files were removed. */
  removed(paths) {
    const set = new Set(paths);
    const cur = this.item;
    const before = this.list.length;
    const idx = this.index;
    this.list = this.list.filter((x) => !set.has(x.path));
    if (this.list.length === before) return;
    if (this.app.mode !== 'viewer') {
      // Not on screen: just keep the list consistent for the next time it opens.
      this.index = Math.max(0, this.list.indexOf(cur));
      return;
    }
    this._buildFilm();
    if (!this.list.length) {
      this.app.viewerEmpty();
      return;
    }
    if (cur && set.has(cur.path)) {
      this.index = -1;
      this.show(Math.min(idx, this.list.length - 1), 1);
    } else this.index = this.list.indexOf(cur);
    this._syncFilm(false);
    this._updateChrome();
  }

  // ================================================================== keyboard
  onKey(e) {
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key;
    const zoomed = this.stage.classList.contains('zoomed');
    const pan = (dx, dy) => {
      this.z = this._clamp({ ...this.z, tx: this.z.tx + dx, ty: this.z.ty + dy });
      this._render();
    };
    if (ctrl && (k === '=' || k === '+' || k === 'Add')) return this.zoomStep(1), true;
    if (ctrl && (k === '-' || k === 'Subtract')) return this.zoomStep(-1), true;
    if (ctrl && k === '0') return this.fitToWindow(), true;
    if (ctrl && k === '1') return this.zoomTo(1), true;
    if (ctrl && (k === 'e' || k === 'E')) return this.edit(), true;
    if (ctrl && (k === 'd' || k === 'D')) return this.toggleFavorite(), true;
    if (ctrl && (k === 'r' || k === 'R')) return this.rotate(e.shiftKey ? -1 : 1), true;
    if (ctrl && (k === 'c' || k === 'C')) return this.app.copyItems([this.item]), true;
    if (ctrl && e.shiftKey && (k === 's' || k === 'S')) return this.app.saveAs(this.item), true;
    if (ctrl) return false;
    if (e.altKey && k === 'Enter') return this.toggleInfo(), true;
    if (e.altKey) return false;
    switch (k) {
      case 'ArrowLeft':
        if (zoomed) pan(60, 0);
        else this.go(this.index - 1, -1);
        return true;
      case 'ArrowRight':
        if (zoomed) pan(-60, 0);
        else this.go(this.index + 1, 1);
        return true;
      case 'ArrowUp':
        if (zoomed) pan(0, 60);
        return true;
      case 'ArrowDown':
        if (zoomed) pan(0, -60);
        return true;
      case 'PageUp':
        this.go(this.index - 1, -1);
        return true;
      case 'PageDown':
        this.go(this.index + 1, 1);
        return true;
      case 'Home':
        this.go(0, -1);
        return true;
      case 'End':
        this.go(this.list.length - 1, 1);
        return true;
      case 'Delete':
        this.deleteCurrent();
        return true;
      case 'F11':
      case 'f':
      case 'F':
        this.toggleFullscreen();
        return true;
      case 'F5':
        this.app.startSlideshow(this.list, this.index);
        return true;
      case 'F2':
        this.app.renameItem(this.item);
        return true;
      case 'i':
      case 'I':
        this.toggleInfo();
        return true;
      case '+':
      case '=':
        this.zoomStep(1);
        return true;
      case '-':
        this.zoomStep(-1);
        return true;
      case 'Escape':
        if (this.fs) this.toggleFullscreen(false);
        else if (this.infoOpen && document.activeElement && this.info.contains(document.activeElement)) this.toggleInfo(false);
        else if (this.from === 'file') this.app.win.close();
        else this.app.closeViewer();
        return true;
      default:
        return false;
    }
  }

  get current() {
    return this.item;
  }
}

export { baseName };
