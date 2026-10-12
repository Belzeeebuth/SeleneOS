// Canvas history charts (Performance page): 60-second area charts with a scrolling grid, and
// sparklines for the device list. New samples slide in with a short eased scroll (no animation
// when [data-animations="off"]); between samples nothing is redrawn.
import { h } from '../../../core/ui.js';

const reduceMotion = () => document.documentElement.dataset.animations === 'off';

export function rgba(color, a) {
  const c = String(color || '').trim();
  let r = 0;
  let g = 0;
  let b = 0;
  if (c.startsWith('#')) {
    const x = c.length === 4 ? c.slice(1).split('').map((ch) => ch + ch).join('') : c.slice(1, 7);
    r = parseInt(x.slice(0, 2), 16);
    g = parseInt(x.slice(2, 4), 16);
    b = parseInt(x.slice(4, 6), 16);
  } else {
    const m = /rgba?\(([^)]+)\)/.exec(c);
    if (m) [r, g, b] = m[1].split(',').map((v) => parseFloat(v));
  }
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

// Monotone cubic interpolation (Fritsch–Carlson): smooth, never overshoots 0 % / 100 %.
function monotonePath(ctx, xs, ys, move = true) {
  const n = xs.length;
  if (!n) return;
  if (move) ctx.moveTo(xs[0], ys[0]);
  else ctx.lineTo(xs[0], ys[0]);
  if (n === 1) return;
  if (n === 2) {
    ctx.lineTo(xs[1], ys[1]);
    return;
  }
  const d = new Array(n - 1);
  const m = new Array(n);
  for (let i = 0; i < n - 1; i++) {
    const dx = xs[i + 1] - xs[i];
    d[i] = dx ? (ys[i + 1] - ys[i]) / dx : 0;
  }
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const tau = 3 / Math.sqrt(s);
      m[i] = tau * a * d[i];
      m[i + 1] = tau * b * d[i];
    }
  }
  for (let i = 0; i < n - 1; i++) {
    const dx = (xs[i + 1] - xs[i]) / 3;
    ctx.bezierCurveTo(xs[i] + dx, ys[i] + m[i] * dx, xs[i + 1] - dx, ys[i + 1] - m[i + 1] * dx, xs[i + 1], ys[i + 1]);
  }
}

export class Chart {
  constructor({ mini = false, grid = true, gridRows = 10, gridCols = 10, span = 60000, className, label } = {}) {
    this.mini = mini;
    // grid: false draws no grid, only a faint baseline (the Selene Performances detail).
    this.grid = grid;
    this.gridRows = gridRows;
    this.gridCols = gridCols;
    this.span = span;
    this.canvas = h('canvas', { class: ['tm-canvas', className], role: 'img', 'aria-label': label || '' });
    this.ctx = this.canvas.getContext('2d');
    this.now = 0;
    this.data = null;
    this._anim = 0;
    this._ro = new ResizeObserver(() => this.draw());
    this._ro.observe(this.canvas);
  }

  // data: { color, series: [{ points: [[t, v]…], dash?, fill?, width? }], max }
  set(data, now, { animate = true } = {}) {
    this.data = data;
    cancelAnimationFrame(this._anim);
    const from = this.now;
    if (!animate || !from || reduceMotion() || now - from > 5000 || now <= from || !this.canvas.isConnected) {
      this.now = now;
      this.draw();
      return;
    }
    const dur = Math.min(320, now - from);
    const t0 = performance.now();
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / dur);
      const e = 1 - (1 - k) ** 3;
      this.now = from + (now - from) * e;
      this.draw();
      if (k < 1) this._anim = requestAnimationFrame(step);
    };
    this._anim = requestAnimationFrame(step);
  }

  draw() {
    const c = this.canvas;
    const d = this.data;
    const cw = c.clientWidth;
    const ch = c.clientHeight;
    if (!cw || !ch) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(cw * dpr);
    const H = Math.round(ch * dpr);
    if (c.width !== W || c.height !== H) {
      c.width = W;
      c.height = H;
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    if (!d) return;
    const dark = document.documentElement.dataset.theme === 'dark';
    const now = this.now || Date.now();
    const span = this.span;
    // Grid: horizontal rows + vertical lines that scroll with time.
    if (!this.mini && !this.grid) {
      ctx.strokeStyle = rgba(d.color, dark ? 0.22 : 0.18);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, ch - 0.5);
      ctx.lineTo(cw, ch - 0.5);
      ctx.stroke();
    } else if (!this.mini) {
      ctx.strokeStyle = rgba(d.color, dark ? 0.26 : 0.2);
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let r = 1; r < this.gridRows; r++) {
        const y = Math.round((ch * r) / this.gridRows) + 0.5;
        ctx.moveTo(0, y);
        ctx.lineTo(cw, y);
      }
      const stepT = span / this.gridCols;
      for (let tt = Math.floor(now / stepT) * stepT; tt > now - span; tt -= stepT) {
        const x = Math.round(cw - ((now - tt) / span) * cw) + 0.5;
        ctx.moveTo(x, 0);
        ctx.lineTo(x, ch);
      }
      ctx.stroke();
    }
    const max = d.max > 0 ? d.max : 100;
    const pad = this.mini ? 1 : 1.5;
    for (const s of d.series) {
      const pts = s.points || [];
      const xs = [];
      const ys = [];
      for (let i = 0; i < pts.length; i++) {
        const [t, v] = pts[i];
        const x = cw - ((now - t) / span) * cw;
        if (x < 0 && i + 1 < pts.length && cw - ((now - pts[i + 1][0]) / span) * cw < 0) continue;
        xs.push(x);
        ys.push(ch - pad - Math.max(0, Math.min(1, v / max)) * (ch - pad * 2));
      }
      if (!xs.length) continue;
      if (xs.length === 1) {
        xs.unshift(xs[0] - 2);
        ys.unshift(ys[0]);
      }
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, cw, ch);
      ctx.clip();
      if (s.fill !== false) {
        ctx.beginPath();
        monotonePath(ctx, xs, ys);
        ctx.lineTo(xs[xs.length - 1], ch);
        ctx.lineTo(xs[0], ch);
        ctx.closePath();
        if (!this.grid && !this.mini) {
          // Soft accent fill that fades towards the baseline.
          const g = ctx.createLinearGradient(0, 0, 0, ch);
          g.addColorStop(0, rgba(d.color, s.fillAlpha ?? (dark ? 0.3 : 0.2)));
          g.addColorStop(1, rgba(d.color, 0.02));
          ctx.fillStyle = g;
        } else ctx.fillStyle = rgba(d.color, s.fillAlpha ?? (dark ? 0.24 : 0.13));
        ctx.fill();
      }
      ctx.beginPath();
      monotonePath(ctx, xs, ys);
      ctx.strokeStyle = s.color || d.color;
      ctx.lineWidth = s.width || (this.mini ? 1 : this.grid ? 1.5 : 2);
      ctx.lineJoin = 'round';
      ctx.setLineDash(s.dash ? [4, 3] : []);
      ctx.stroke();
      ctx.restore();
    }
  }

  destroy() {
    cancelAnimationFrame(this._anim);
    this._ro.disconnect();
  }
}

// "Nice" upper bound for auto-scaled charts: 1, 2, 5 × 10^n of the unit.
export function niceMax(v, min = 1) {
  const x = Math.max(v, min);
  const p = 10 ** Math.floor(Math.log10(x));
  for (const m of [1, 2, 5, 10]) if (x <= m * p) return m * p;
  return 10 * p;
}
