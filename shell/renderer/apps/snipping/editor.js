// Snip editor: shows the snip on a zoomable stage and annotates it with vector ink (ballpoint pen,
// multiply-blended highlighter), a stroke eraser, image crop with handles, and undo/redo.
//
//   const ed = new SnipEditor({ h, t, onChange, onZoom, onToolChange });
//   ed.load(canvas)                        new image (history reset, zoom to fit)
//   ed.setTool('pen' | 'hl' | 'eraser' | 'crop' | null)
//   ed.pen / ed.hl = { color, size }       current ink (size in image pixels)
//   ed.undo() ed.redo() ed.canUndo ed.canRedo ed.eraseAll()
//   ed.zoomIn() ed.zoomOut() ed.setZoom(z, anchor) ed.fit() ed.zoom ed.fitMode
//   ed.applyCrop() ed.cancelCrop()
//   ed.toggleRuler(on?) ed.ruler -> { cx, cy, angle } | null   (drag to move, wheel / arrows to rotate;
//       pen and highlighter strokes started next to an edge are drawn straight along it)
//   ed.render() -> canvas (image + ink)    ed.isDirty() ed.markSaved() ed.isEdited()
//
// Strokes are stored in image coordinates, so zoom never degrades them and crop just offsets them.
// The composite lives in the `view` canvas at full image resolution; the stroke being drawn goes to
// a `live` canvas on top (CSS multiply blending for the highlighter, identical to the final result).

export const HL_ALPHA = 0.5;
const ZOOMS = [0.1, 0.25, 1 / 3, 0.5, 2 / 3, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8];
const HISTORY_MAX = 80;
const MIN_CROP = 8;
const RULER_T = 64; // ruler thickness and length, CSS px (it keeps its on-screen size at every zoom)
const RULER_L = 1400;
const RULER_SNAP = 28; // strokes starting this close to an edge (CSS px) are drawn along it

export const PEN_COLORS = [
  ['black', '#000000'], ['white', '#ffffff'], ['gray', '#808080'], ['silver', '#c8c8c8'],
  ['red', '#e81224'], ['orange', '#f7630c'], ['yellow', '#fff100'], ['lime', '#8fd400'],
  ['green', '#16a34a'], ['teal', '#00a3a3'], ['blue', '#0078d4'], ['navy', '#1f3a93'],
  ['purple', '#8a4fff'], ['pink', '#ff6fb5'], ['magenta', '#c2179b'], ['brown', '#8e562e'],
];
export const HL_COLORS = [
  ['yellow', '#ffef00'], ['lime', '#9cff3a'], ['cyan', '#3ae8ff'], ['pink', '#ff8ad8'],
  ['orange', '#ffad33'], ['red', '#ff6b6b'], ['purple', '#c39bff'], ['blue', '#7cb5ff'],
];

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  let tt = len ? ((px - ax) * dx + (py - ay) * dy) / len : 0;
  tt = clamp(tt, 0, 1);
  return Math.hypot(px - (ax + tt * dx), py - (ay + tt * dy));
}

function bboxOf(s) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of s.points) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  const r = s.size / 2 + 1;
  return { x0: x0 - r, y0: y0 - r, x1: x1 + r, y1: y1 + r };
}

export function drawStroke(g, s, { live = false } = {}) {
  const p = s.points;
  if (!p.length) return;
  g.save();
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.strokeStyle = s.color;
  g.fillStyle = s.color;
  g.lineWidth = s.size;
  if (s.tool === 'hl' && !live) {
    g.globalCompositeOperation = 'multiply';
    g.globalAlpha = HL_ALPHA;
  }
  const dot = p.length === 1 || (p.length === 2 && p[0][0] === p[1][0] && p[0][1] === p[1][1]);
  g.beginPath();
  if (dot) {
    g.arc(p[0][0], p[0][1], s.size / 2, 0, Math.PI * 2);
    g.fill();
  } else {
    // Quadratic curves through the midpoints: smooth ink without overshoot.
    g.moveTo(p[0][0], p[0][1]);
    for (let i = 1; i < p.length - 1; i++) {
      const mx = (p[i][0] + p[i + 1][0]) / 2;
      const my = (p[i][1] + p[i + 1][1]) / 2;
      g.quadraticCurveTo(p[i][0], p[i][1], mx, my);
    }
    const last = p[p.length - 1];
    g.lineTo(last[0], last[1]);
    g.stroke();
  }
  g.restore();
}

function hitStroke(s, x, y, r) {
  const b = s.bbox || bboxOf(s);
  if (x < b.x0 - r || x > b.x1 + r || y < b.y0 - r || y > b.y1 + r) return false;
  const lim = s.size / 2 + r;
  const p = s.points;
  if (p.length === 1) return Math.hypot(x - p[0][0], y - p[0][1]) <= lim;
  for (let i = 1; i < p.length; i++) if (distToSeg(x, y, p[i - 1][0], p[i - 1][1], p[i][0], p[i][1]) <= lim) return true;
  return false;
}

function cursorUrl(svg, hx, hy, fallback) {
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${hx} ${hy}, ${fallback}`;
}

export class SnipEditor {
  constructor({ h, t, onChange, onZoom, onToolChange, onCropChange, onRulerChange }) {
    this.h = h;
    this.t = t;
    this.onRulerChange = onRulerChange;
    this.onChange = onChange;
    this.onZoom = onZoom;
    this.onToolChange = onToolChange;
    this.onCropChange = onCropChange;
    this.tool = null;
    this.pen = { color: '#e81224', size: 4 };
    this.hl = { color: '#ffef00', size: 18 };
    this.zoom = 1;
    this.fitMode = true;
    this.history = [];
    this.idx = -1;
    this.saved = null;
    this.original = null;
    this.crop = null;
    this.ruler = null;
    this._op = null;

    this.view = h('canvas', { class: 'snip-view' });
    this.live = h('canvas', { class: 'snip-live', 'aria-hidden': 'true' });
    this.cropBox = h('div', { class: 'snip-crop-box' }, h('div', { class: 'snip-crop-grid' }), ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((d) => h('div', { class: `snip-ch snip-ch-${d}`, dataset: { h: d } })));
    this.cropSize = h('div', { class: 'snip-crop-size' });
    this.cropLayer = h('div', { class: 'snip-crop', hidden: true }, this.cropBox, this.cropSize);
    this.rulerAngle = h('span', { class: 'snip-ruler-angle' });
    this.rulerEl = h(
      'div',
      { class: 'snip-ruler', role: 'slider', tabindex: '0', 'aria-label': t('ruler'), 'aria-valuemin': '0', 'aria-valuemax': '359', 'aria-valuenow': '0' },
      h('div', { class: 'snip-ruler-ticks' }),
      this.rulerAngle,
    );
    this.rulerLayer = h('div', { class: 'snip-ruler-layer', hidden: true }, this.rulerEl);
    this.wrap = h('div', { class: 'snip-wrap' }, this.view, this.live, this.rulerLayer, this.cropLayer);
    this.inner = h('div', { class: 'snip-stage-inner' }, this.wrap);
    this.el = h('div', { class: 'snip-stage', tabindex: '0', role: 'img', 'aria-label': t('canvas') }, this.inner);

    this.wrap.addEventListener('pointerdown', (e) => this._down(e));
    this.wrap.addEventListener('pointermove', (e) => this._move(e));
    this.wrap.addEventListener('pointerup', (e) => this._up(e));
    this.wrap.addEventListener('pointercancel', (e) => this._up(e, true));
    this.wrap.addEventListener('lostpointercapture', (e) => this._op && this._op.pointerId === e.pointerId && this._up(e, this._op.kind === 'pan'));
    this.el.addEventListener('pointerdown', (e) => {
      // Middle button (or primary on the empty stage around the image) pans when zoomed in.
      if (this._op || (e.target.closest('.snip-wrap') && e.button !== 1)) return;
      if (e.button === 1 || e.button === 0) this._startPan(e, this.el);
    });
    this.el.addEventListener('pointermove', (e) => this._op?.kind === 'pan' && this._op.host === this.el && this._panMove(e));
    this.el.addEventListener('pointerup', (e) => this._op?.kind === 'pan' && this._op.host === this.el && this._endPan(e));
    this.el.addEventListener(
      'wheel',
      (e) => {
        if (!e.ctrlKey || !this.hasImage) return;
        e.preventDefault();
        const f = Math.exp(-e.deltaY * 0.0025);
        this.setZoom(this.zoom * f, { x: e.clientX, y: e.clientY });
      },
      { passive: false },
    );
    this.el.addEventListener('auxclick', (e) => e.button === 1 && e.preventDefault());
    // The focus ring around the snip only shows when the user moves the keyboard focus there (Tab),
    // not when the app parks the focus on the canvas (after a snip, a crop, a closed flyout).
    this.el.addEventListener('blur', () => this.el.classList.remove('quiet'));
    this._wireRuler();
    this._ro = new ResizeObserver(() => {
      if (this.fitMode && this.hasImage) this.fit();
    });
    this._ro.observe(this.el);
  }

  /** Give the canvas the keyboard focus (shortcuts, crop keys) without drawing a focus ring. */
  focusQuiet() {
    if (document.activeElement === this.el) return;
    this.el.classList.add('quiet');
    this.el.focus({ preventScroll: true });
  }
  dispose() {
    this._ro?.disconnect();
    this._cancelOp();
    cancelAnimationFrame(this._liveRaf);
  }

  // ------------------------------------------------------------------ state
  get state() {
    return this.history[this.idx] || null;
  }
  get hasImage() {
    return !!this.state;
  }
  get W() {
    return this.state?.base.width || 0;
  }
  get H() {
    return this.state?.base.height || 0;
  }
  get canUndo() {
    return this.idx > 0 && !this._op;
  }
  get canRedo() {
    return this.idx < this.history.length - 1 && !this._op;
  }
  get strokes() {
    return this.state?.strokes || [];
  }
  isDirty() {
    return !!this.state && this.state !== this.saved;
  }
  isEdited() {
    return !!this.state && this.state !== this.original;
  }
  markSaved() {
    this.saved = this.state;
  }

  load(source, { saved = false } = {}) {
    const base = document.createElement('canvas');
    base.width = source.width;
    base.height = source.height;
    base.getContext('2d').drawImage(source, 0, 0);
    this._cancelOp();
    if (this.crop) this._endCrop();
    if (this.ruler) this.toggleRuler(false);
    const st = { base, strokes: [] };
    this.history = [st];
    this.idx = 0;
    this.original = st;
    this.saved = saved ? st : null;
    this._sizeCanvases();
    this.redraw();
    this.fitMode = true;
    this.fit();
    this.el.scrollTop = 0;
    this.el.scrollLeft = 0;
    this.onChange?.('load');
  }

  _push(st) {
    this.history = this.history.slice(0, this.idx + 1);
    this.history.push(st);
    if (this.history.length > HISTORY_MAX) this.history.splice(1, this.history.length - HISTORY_MAX);
    this.idx = this.history.length - 1;
  }

  _applyState(kind) {
    const resized = this.view.width !== this.W || this.view.height !== this.H;
    if (resized) this._sizeCanvases();
    this.redraw();
    if (resized) {
      if (this.fitMode) this.fit();
      else this._layout();
    }
    this.onChange?.(kind);
  }

  undo() {
    if (!this.canUndo) return false;
    if (this.crop) this._endCrop();
    this.idx--;
    this._applyState('undo');
    return true;
  }
  redo() {
    if (!this.canRedo) return false;
    if (this.crop) this._endCrop();
    this.idx++;
    this._applyState('redo');
    return true;
  }
  eraseAll() {
    if (!this.strokes.length) return false;
    this._push({ base: this.state.base, strokes: [] });
    this._applyState('erase');
    return true;
  }

  // ------------------------------------------------------------------ rendering
  _sizeCanvases() {
    for (const c of [this.view, this.live]) {
      c.width = Math.max(1, this.W);
      c.height = Math.max(1, this.H);
    }
  }
  redraw(strokes = this.strokes) {
    if (!this.state) return;
    const g = this.view.getContext('2d');
    g.clearRect(0, 0, this.view.width, this.view.height);
    g.drawImage(this.state.base, 0, 0);
    for (const s of strokes) drawStroke(g, s);
  }
  /** A copy of the current image with its ink, at full resolution. */
  render() {
    const c = document.createElement('canvas');
    c.width = this.W;
    c.height = this.H;
    if (this.state) c.getContext('2d').drawImage(this.view, 0, 0);
    return c;
  }
  pixel(x, y) {
    return [...this.view.getContext('2d').getImageData(Math.floor(x), Math.floor(y), 1, 1).data];
  }

  // ------------------------------------------------------------------ zoom / layout
  get dpr() {
    return window.devicePixelRatio || 1;
  }
  _layout() {
    if (!this.state) return;
    const w = (this.W * this.zoom) / this.dpr;
    const hgt = (this.H * this.zoom) / this.dpr;
    this.wrap.style.width = `${w}px`;
    this.wrap.style.height = `${hgt}px`;
    this.wrap.classList.toggle('pixelated', this.zoom >= 2);
    this._updateCursor();
    if (this.crop) this._layoutCrop();
    if (this.ruler) this._layoutRuler();
  }
  fitZoom() {
    const pad = 48;
    const aw = Math.max(40, this.el.clientWidth - pad);
    const ah = Math.max(40, this.el.clientHeight - pad);
    if (!this.W || !this.H) return 1;
    return clamp(Math.min(1, (aw * this.dpr) / this.W, (ah * this.dpr) / this.H), 0.05, 1);
  }
  fit() {
    if (!this.state) return;
    const prev = this.zoom;
    this.fitMode = true;
    this.zoom = this.fitZoom();
    this._layout();
    if (prev !== this.zoom) this.onZoom?.(this.zoom);
  }
  setZoom(z, anchor) {
    if (!this.state) return;
    z = clamp(z, 0.05, 8);
    const st = this.el;
    const r = this.wrap.getBoundingClientRect();
    const sr = st.getBoundingClientRect();
    const ax = anchor ? anchor.x : sr.left + sr.width / 2;
    const ay = anchor ? anchor.y : sr.top + sr.height / 2;
    const fx = r.width ? (ax - r.left) / r.width : 0.5;
    const fy = r.height ? (ay - r.top) / r.height : 0.5;
    this.zoom = z;
    this.fitMode = false;
    this._layout();
    // Keep the image point under the anchor where it was.
    const r2 = this.wrap.getBoundingClientRect();
    st.scrollLeft += r2.left + fx * r2.width - ax;
    st.scrollTop += r2.top + fy * r2.height - ay;
    this.onZoom?.(this.zoom);
  }
  zoomIn() {
    const z = ZOOMS.find((v) => v > this.zoom + 1e-3) ?? ZOOMS[ZOOMS.length - 1];
    this.setZoom(z);
  }
  zoomOut() {
    const z = [...ZOOMS].reverse().find((v) => v < this.zoom - 1e-3) ?? ZOOMS[0];
    this.setZoom(z);
  }

  // ------------------------------------------------------------------ tools
  setTool(tool) {
    if (tool === this.tool) return;
    this._cancelOp();
    if (this.crop && tool !== 'crop') this._endCrop();
    this.tool = tool;
    if (tool === 'crop' && this.state) this._beginCrop();
    this._updateCursor();
    this.onToolChange?.(tool);
  }
  setInk(kind, patch) {
    Object.assign(kind === 'hl' ? this.hl : this.pen, patch);
    this._updateCursor();
  }
  _updateCursor() {
    const z = this.zoom / this.dpr;
    let c = 'default';
    if (this.tool === 'pen' || this.tool === 'hl') {
      const ink = this.tool === 'hl' ? this.hl : this.pen;
      const d = clamp(Math.round(ink.size * z), 3, 60);
      if (this.tool === 'pen') {
        const s = d + 4;
        c = cursorUrl(`<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}"><circle cx="${s / 2}" cy="${s / 2}" r="${d / 2}" fill="${ink.color}" stroke="#fff" stroke-width="1"/><circle cx="${s / 2}" cy="${s / 2}" r="${d / 2 + 1}" fill="none" stroke="#000" stroke-opacity=".35" stroke-width="1"/></svg>`, s / 2, s / 2, 'crosshair');
      } else {
        const w = Math.max(4, Math.round(d * 0.45));
        const s = d + 4;
        c = cursorUrl(`<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}"><rect x="${(s - w) / 2}" y="2" width="${w}" height="${d}" rx="1" fill="${ink.color}" fill-opacity=".7" stroke="#000" stroke-opacity=".45"/></svg>`, s / 2, s / 2, 'crosshair');
      }
    } else if (this.tool === 'eraser') {
      c = cursorUrl('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="10" fill="#fff" fill-opacity=".35" stroke="#000" stroke-opacity=".75"/><circle cx="12" cy="12" r="9" fill="none" stroke="#fff" stroke-opacity=".9"/></svg>', 12, 12, 'cell');
    } else if (this.tool === 'crop') c = 'default';
    else c = this._canPan() ? 'grab' : 'default';
    this.wrap.style.cursor = c;
  }
  _canPan() {
    return this.el.scrollWidth > this.el.clientWidth + 1 || this.el.scrollHeight > this.el.clientHeight + 1;
  }
  _pt(e) {
    const r = this.wrap.getBoundingClientRect();
    return [((e.clientX - r.left) * this.W) / (r.width || 1), ((e.clientY - r.top) * this.H) / (r.height || 1)];
  }
  eraserRadius() {
    return (10 * this.dpr) / this.zoom;
  }

  _down(e) {
    if (!this.state || this._op) return;
    if (e.target.closest('.snip-crop, .snip-ruler')) return; // crop layer and ruler handle their own drags
    if (e.button === 1 || (e.button === 0 && !this.tool)) {
      this._startPan(e, this.wrap);
      return;
    }
    if (e.button !== 0) return;
    e.preventDefault();
    this.focusQuiet();
    if (this.tool === 'pen' || this.tool === 'hl') {
      const ink = this.tool === 'hl' ? this.hl : this.pen;
      const p = this._pt(e);
      const snap = this._rulerSnap(p, ink.size);
      const stroke = { tool: this.tool, color: ink.color, size: ink.size, points: [snap ? snap.project(p) : p] };
      this._op = { kind: 'ink', pointerId: e.pointerId, stroke, snap };
      this.live.classList.toggle('hl', this.tool === 'hl');
      this._capture(e);
      this._drawLive();
    } else if (this.tool === 'eraser') {
      const p = this._pt(e);
      this._op = { kind: 'erase', pointerId: e.pointerId, strokes: this.strokes.slice(), removed: 0, last: p };
      this._capture(e);
      this._eraseAt(p);
    }
  }
  _move(e) {
    const op = this._op;
    if (!op || op.pointerId !== e.pointerId) return;
    if (op.kind === 'pan') return this._panMove(e);
    const evs = e.getCoalescedEvents?.() || [];
    const list = evs.length ? evs : [e];
    if (op.kind === 'ink') {
      const pts = op.stroke.points;
      for (const ce of list) {
        const q = op.snap ? op.snap.project(this._pt(ce)) : this._pt(ce);
        const last = pts[pts.length - 1];
        if (Math.hypot(q[0] - last[0], q[1] - last[1]) >= 0.75) pts.push(q);
      }
      this._drawLive();
    } else if (op.kind === 'erase') {
      const r = this.eraserRadius();
      for (const ce of list) {
        const q = this._pt(ce);
        // Sample the path so fast swipes still hit thin strokes.
        const n = Math.max(1, Math.ceil(Math.hypot(q[0] - op.last[0], q[1] - op.last[1]) / (r / 2)));
        for (let i = 1; i <= n; i++) this._eraseAt([op.last[0] + ((q[0] - op.last[0]) * i) / n, op.last[1] + ((q[1] - op.last[1]) * i) / n]);
        op.last = q;
      }
    }
  }
  _up(e, cancel = false) {
    const op = this._op;
    if (!op || op.pointerId !== e.pointerId) return;
    if (op.kind === 'pan') return this._endPan(e);
    this._op = null;
    if (op.kind === 'ink') {
      cancelAnimationFrame(this._liveRaf);
      this._liveRaf = 0;
      this.live.getContext('2d').clearRect(0, 0, this.live.width, this.live.height);
      if (cancel) return;
      const s = op.stroke;
      s.bbox = bboxOf(s);
      this._push({ base: this.state.base, strokes: [...this.strokes, s] });
      drawStroke(this.view.getContext('2d'), s);
      this.onChange?.('ink');
    } else if (op.kind === 'erase') {
      if (op.removed) {
        this._push({ base: this.state.base, strokes: op.strokes });
        this.onChange?.('erase');
      }
      this.redraw();
    }
  }
  _capture(e) {
    try {
      this.wrap.setPointerCapture(e.pointerId);
    } catch {}
  }
  _cancelOp() {
    if (!this._op) return;
    const op = this._op;
    this._op = null;
    if (op.kind === 'ink') this.live.getContext('2d').clearRect(0, 0, this.live.width, this.live.height);
    if (op.kind === 'erase') this.redraw();
  }
  _drawLive() {
    if (this._liveRaf) return;
    this._liveRaf = requestAnimationFrame(() => {
      this._liveRaf = 0;
      const op = this._op;
      const g = this.live.getContext('2d');
      g.clearRect(0, 0, this.live.width, this.live.height);
      if (op?.kind === 'ink') drawStroke(g, op.stroke, { live: true });
    });
  }
  _eraseAt([x, y]) {
    const op = this._op;
    const r = this.eraserRadius();
    const keep = op.strokes.filter((s) => !hitStroke(s, x, y, r));
    if (keep.length !== op.strokes.length) {
      op.removed += op.strokes.length - keep.length;
      op.strokes = keep;
      this.redraw(keep);
    }
  }
  _startPan(e, host) {
    if (!this._canPan()) return;
    e.preventDefault();
    this._op = { kind: 'pan', pointerId: e.pointerId, host, x: e.clientX, y: e.clientY, sl: this.el.scrollLeft, st: this.el.scrollTop };
    try {
      host.setPointerCapture(e.pointerId);
    } catch {}
    this.wrap.style.cursor = 'grabbing';
  }
  _panMove(e) {
    const op = this._op;
    if (!op || op.pointerId !== e.pointerId) return;
    this.el.scrollLeft = op.sl - (e.clientX - op.x);
    this.el.scrollTop = op.st - (e.clientY - op.y);
  }
  _endPan(e) {
    if (this._op?.pointerId !== e.pointerId) return;
    this._op = null;
    this._updateCursor();
  }

  // ------------------------------------------------------------------ ruler
  /** Show / hide the ruler (Windows Snipping Tool style). Returns the new state. */
  toggleRuler(on = !this.ruler) {
    if (on && !this.state) return false;
    if (on && this.crop) this.cancelCrop();
    if (on) {
      if (!this.ruler) {
        // Centred on the visible part of the image.
        const sr = this.el.getBoundingClientRect();
        const r = this.wrap.getBoundingClientRect();
        const k = r.width / (this.W || 1) || 1;
        const cx = clamp((sr.left + sr.width / 2 - r.left) / k, 0, this.W);
        const cy = clamp((sr.top + sr.height / 2 - r.top) / k, 0, this.H);
        this.ruler = { cx, cy, angle: 0 };
      }
      this.rulerLayer.hidden = false;
      this._layoutRuler();
    } else {
      this.ruler = null;
      this.rulerLayer.hidden = true;
    }
    this.onRulerChange?.(!!this.ruler);
    return !!this.ruler;
  }
  rotateRuler(deg) {
    if (!this.ruler) return;
    this.ruler.angle = (((Math.round((this.ruler.angle + deg) * 10) / 10) % 360) + 360) % 360;
    this._layoutRuler();
  }
  _layoutRuler() {
    const r = this.ruler;
    if (!r) return;
    const k = this.zoom / this.dpr;
    Object.assign(this.rulerEl.style, {
      width: `${RULER_L}px`,
      height: `${RULER_T}px`,
      left: `${r.cx * k - RULER_L / 2}px`,
      top: `${r.cy * k - RULER_T / 2}px`,
      transform: `rotate(${r.angle}deg)`,
    });
    const a = Math.round(r.angle) % 360;
    this.rulerAngle.textContent = `${a}°`;
    this.rulerAngle.style.transform = `rotate(${-r.angle}deg)`;
    this.rulerEl.setAttribute('aria-valuenow', String(a));
    this.rulerEl.setAttribute('aria-valuetext', `${a}°`);
  }
  /** Straight-edge for a stroke starting at p (image px): the line along the nearest ruler edge, or null. */
  _rulerSnap(p, size) {
    const r = this.ruler;
    if (!r || this.rulerLayer.hidden) return null;
    const k = this.zoom / this.dpr;
    const T = RULER_T / k;
    const L = RULER_L / k;
    const near = RULER_SNAP / k;
    const a = (r.angle * Math.PI) / 180;
    const u = [Math.cos(a), Math.sin(a)];
    const n = [-Math.sin(a), Math.cos(a)];
    const d = [p[0] - r.cx, p[1] - r.cy];
    const along = d[0] * u[0] + d[1] * u[1];
    const across = d[0] * n[0] + d[1] * n[1];
    if (Math.abs(along) > L / 2) return null;
    const off = size / 2 + 1;
    let line;
    if (across <= -T / 2 && across >= -T / 2 - near) line = -T / 2 - off;
    else if (across >= T / 2 && across <= T / 2 + near) line = T / 2 + off;
    else return null;
    const base = [r.cx + n[0] * line, r.cy + n[1] * line];
    return {
      base,
      u,
      project: (q) => {
        const tt = (q[0] - base[0]) * u[0] + (q[1] - base[1]) * u[1];
        return [base[0] + u[0] * tt, base[1] + u[1] * tt];
      },
    };
  }
  _wireRuler() {
    const el = this.rulerEl;
    let drag = null;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !this.ruler) return;
      e.preventDefault();
      e.stopPropagation();
      el.focus({ preventScroll: true });
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, cx: this.ruler.cx, cy: this.ruler.cy };
      try {
        el.setPointerCapture(e.pointerId);
      } catch {}
      el.classList.add('dragging');
    });
    el.addEventListener('pointermove', (e) => {
      if (!drag || drag.id !== e.pointerId || !this.ruler) return;
      const k = this.zoom / this.dpr;
      this.ruler.cx = clamp(drag.cx + (e.clientX - drag.x) / k, 0, this.W);
      this.ruler.cy = clamp(drag.cy + (e.clientY - drag.y) / k, 0, this.H);
      this._layoutRuler();
    });
    const end = (e) => {
      if (!drag || drag.id !== e.pointerId) return;
      drag = null;
      el.classList.remove('dragging');
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener(
      'wheel',
      (e) => {
        if (e.ctrlKey) return; // Ctrl+wheel still zooms
        e.preventDefault();
        e.stopPropagation();
        this.rotateRuler((e.deltaY > 0 ? 1 : -1) * (e.shiftKey ? 15 : 1));
      },
      { passive: false },
    );
    el.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 15 : 1;
      const k = this.zoom / this.dpr;
      const move = { ArrowUp: [0, -10], ArrowDown: [0, 10] }[e.key];
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') this.rotateRuler(e.key === 'ArrowLeft' ? -step : step);
      else if (move && this.ruler) {
        this.ruler.cy = clamp(this.ruler.cy + move[1] / k, 0, this.H);
        this._layoutRuler();
      } else if (e.key === 'Home') this.rotateRuler(-this.ruler.angle);
      else return;
      e.preventDefault();
      e.stopPropagation();
    });
  }

  // ------------------------------------------------------------------ crop
  _beginCrop() {
    if (this.ruler) this.toggleRuler(false);
    this.crop = { x: 0, y: 0, w: this.W, h: this.H };
    this.cropLayer.hidden = false;
    this.wrap.classList.add('cropping');
    if (!this._cropWired) {
      this._cropWired = true;
      this.cropLayer.addEventListener('pointerdown', (e) => this._cropDown(e));
      this.cropLayer.addEventListener('pointermove', (e) => this._cropMove(e));
      this.cropLayer.addEventListener('pointerup', (e) => this._cropUp(e));
      this.cropLayer.addEventListener('pointercancel', (e) => this._cropUp(e));
    }
    this._layoutCrop();
    this.focusQuiet(); // Enter applies, Esc cancels
    this.onCropChange?.(this.crop);
  }
  _endCrop() {
    this.crop = null;
    this._cropDrag = null;
    this.cropLayer.hidden = true;
    this.wrap.classList.remove('cropping');
  }
  get cropRect() {
    if (!this.crop) return null;
    const c = this.crop;
    const x = Math.round(c.x);
    const y = Math.round(c.y);
    return { x, y, w: Math.round(c.x + c.w) - x, h: Math.round(c.y + c.h) - y };
  }
  setCropRect(r) {
    if (!this.crop) return;
    const x = clamp(r.x, 0, this.W - MIN_CROP);
    const y = clamp(r.y, 0, this.H - MIN_CROP);
    this.crop = { x, y, w: clamp(r.w, MIN_CROP, this.W - x), h: clamp(r.h, MIN_CROP, this.H - y) };
    this._layoutCrop();
    this.onCropChange?.(this.crop);
  }
  /** Keyboard crop: arrows move the box, Shift+arrows resize it (Ctrl = 10 px steps). */
  nudgeCrop(dx, dy, resize = false) {
    if (!this.crop) return;
    const c = this.crop;
    if (resize) this.setCropRect({ x: c.x, y: c.y, w: c.w + dx, h: c.h + dy });
    else this.setCropRect({ x: clamp(c.x + dx, 0, this.W - c.w), y: clamp(c.y + dy, 0, this.H - c.h), w: c.w, h: c.h });
  }
  resetCrop() {
    if (this.crop) this.setCropRect({ x: 0, y: 0, w: this.W, h: this.H });
  }
  _layoutCrop() {
    const c = this.crop;
    if (!c) return;
    const k = this.zoom / this.dpr;
    Object.assign(this.cropBox.style, { left: `${c.x * k}px`, top: `${c.y * k}px`, width: `${c.w * k}px`, height: `${c.h * k}px` });
    const r = this.cropRect;
    this.cropSize.textContent = this.t('cropSize', { w: r.w, h: r.h });
    const top = c.y * k + c.h * k - 30;
    Object.assign(this.cropSize.style, { left: `${c.x * k + (c.w * k) / 2}px`, top: `${Math.max(4, top)}px` });
  }
  _cropDown(e) {
    if (e.button !== 0 || !this.crop) return;
    e.preventDefault();
    e.stopPropagation();
    const handle = e.target.closest('.snip-ch')?.dataset.h || (e.target.closest('.snip-crop-box') ? 'move' : null);
    if (!handle) return;
    this.focusQuiet();
    this._cropDrag = { handle, pointerId: e.pointerId, x: e.clientX, y: e.clientY, start: { ...this.crop } };
    try {
      this.cropLayer.setPointerCapture(e.pointerId);
    } catch {}
    this.cropLayer.classList.add('dragging');
  }
  _cropMove(e) {
    const d = this._cropDrag;
    if (!d || d.pointerId !== e.pointerId) return;
    const r = this.wrap.getBoundingClientRect();
    const dx = ((e.clientX - d.x) * this.W) / (r.width || 1);
    const dy = ((e.clientY - d.y) * this.H) / (r.height || 1);
    const s = d.start;
    let x0 = s.x;
    let y0 = s.y;
    let x1 = s.x + s.w;
    let y1 = s.y + s.h;
    if (d.handle === 'move') {
      const nx = clamp(s.x + dx, 0, this.W - s.w);
      const ny = clamp(s.y + dy, 0, this.H - s.h);
      this.crop = { x: nx, y: ny, w: s.w, h: s.h };
    } else {
      if (d.handle.includes('w')) x0 = clamp(s.x + dx, 0, x1 - MIN_CROP);
      if (d.handle.includes('e')) x1 = clamp(s.x + s.w + dx, x0 + MIN_CROP, this.W);
      if (d.handle.includes('n')) y0 = clamp(s.y + dy, 0, y1 - MIN_CROP);
      if (d.handle.includes('s')) y1 = clamp(s.y + s.h + dy, y0 + MIN_CROP, this.H);
      this.crop = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
    this._layoutCrop();
    this.onCropChange?.(this.crop);
  }
  _cropUp(e) {
    if (!this._cropDrag || this._cropDrag.pointerId !== e.pointerId) return;
    this._cropDrag = null;
    this.cropLayer.classList.remove('dragging');
  }
  /** Apply the crop rectangle (undoable). Returns true when the image changed. */
  applyCrop() {
    if (!this.crop) return false;
    const r = this.cropRect;
    this._endCrop();
    this.tool = null;
    this.onToolChange?.(null);
    this._updateCursor();
    if (r.x === 0 && r.y === 0 && r.w === this.W && r.h === this.H) return false;
    const base = document.createElement('canvas');
    base.width = r.w;
    base.height = r.h;
    base.getContext('2d').drawImage(this.state.base, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
    const strokes = this.strokes.map((s) => {
      const n = { ...s, points: s.points.map(([x, y]) => [x - r.x, y - r.y]) };
      n.bbox = bboxOf(n);
      return n;
    });
    this._push({ base, strokes });
    this.fitMode = true;
    this._applyState('crop');
    this.fit();
    return true;
  }
  cancelCrop() {
    if (!this.crop) return;
    this._endCrop();
    this.tool = null;
    this._updateCursor();
    this.onToolChange?.(null);
  }
}
