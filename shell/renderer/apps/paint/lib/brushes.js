// Brush engines. Each engine draws a stroke incrementally into a 2D context (the "live" layer)
// while points arrive:   const e = createEngine('oil', ctx, { color, size, seed }); e.add(x, y)…; e.end();
// e.rect is the bounding box of everything drawn so far (image pixels, padded).
//
// "Coverage" brushes (crayon, marker, natural pencil, watercolor) draw an opaque mask; their
// look (grain, transparency, soft edges) is applied when the stroke is committed with
// applyFinish(), and previewed meanwhile with previewStyle() on the live canvas element.
import { shade } from './color.js';

export const BRUSHES = ['brush', 'calli1', 'calli2', 'airbrush', 'oil', 'crayon', 'marker', 'natural', 'watercolor'];

export const FINISH = {
  crayon: { grain: 'crayon', alpha: 0.95, width: 1 },
  marker: { alpha: 0.45, width: 1.15 },
  natural: { grain: 'pencil', alpha: 0.88, width: 0.6 },
  watercolor: { grain: 'paper', alpha: 0.62, blur: 0.12, rim: true, width: 1.3, previewAlpha: 0.36 },
  // shape fills
  oil: { grain: 'paper', alpha: 0.97 },
  solid: {},
};

export function rng(seed = 1) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- grain textures
export const GRAIN_SIZE = 128;
const grains = new Map();

function noiseTile(N, seed, passes) {
  const r = rng(seed);
  let a = new Float32Array(N * N);
  for (let i = 0; i < a.length; i++) a[i] = r();
  for (let p = 0; p < passes; p++) {
    const o = new Float32Array(N * N);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        let s = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = (y + dy + N) % N;
          for (let dx = -1; dx <= 1; dx++) s += a[yy * N + ((x + dx + N) % N)];
        }
        o[y * N + x] = s / 9;
      }
    }
    a = o;
  }
  let min = Infinity;
  let max = -Infinity;
  for (const v of a) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const k = max > min ? 1 / (max - min) : 1;
  for (let i = 0; i < a.length; i++) a[i] = (a[i] - min) * k;
  return a;
}

const smooth = (e0, e1, x) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

export function grainCanvas(kind) {
  if (grains.has(kind)) return grains.get(kind).canvas;
  const N = GRAIN_SIZE;
  let alpha;
  if (kind === 'crayon') {
    const a = noiseTile(N, 7, 2);
    const b = noiseTile(N, 8, 0);
    alpha = (i) => smooth(0.3, 0.5, 0.65 * a[i] + 0.35 * b[i]);
  } else if (kind === 'pencil') {
    const a = noiseTile(N, 11, 0);
    const b = noiseTile(N, 12, 2);
    alpha = (i) => 0.15 + 0.85 * smooth(0.28, 0.72, 0.5 * a[i] + 0.5 * b[i]);
  } else {
    const a = noiseTile(N, 13, 3);
    const b = noiseTile(N, 14, 0);
    alpha = (i) => 0.62 + 0.3 * a[i] + 0.08 * b[i];
  }
  const c = document.createElement('canvas');
  c.width = N;
  c.height = N;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(N, N);
  for (let i = 0; i < N * N; i++) img.data[i * 4 + 3] = Math.round(255 * Math.max(0, Math.min(1, alpha(i))));
  ctx.putImageData(img, 0, 0);
  grains.set(kind, { canvas: c, url: null });
  return c;
}

export function grainUrl(kind) {
  grainCanvas(kind);
  const g = grains.get(kind);
  if (!g.url) g.url = g.canvas.toDataURL('image/png');
  return g.url;
}

export function grainPattern(ctx, kind) {
  return ctx.createPattern(grainCanvas(kind), 'repeat');
}

/** CSS applied to the live canvas element so an in-progress coverage stroke looks like the final result. */
export function previewStyle(spec, size, scale) {
  if (!spec) return { opacity: '', filter: '', mask: '' };
  const blur = spec.blur ? blurRadius(spec, size) : 0;
  return {
    opacity: String(spec.previewAlpha ?? spec.alpha ?? 1),
    filter: blur ? `blur(${(blur * scale).toFixed(2)}px)` : '',
    mask: spec.grain ? `url("${grainUrl(spec.grain)}") 0 0 / ${GRAIN_SIZE * scale}px ${GRAIN_SIZE * scale}px repeat` : '',
  };
}

const blurRadius = (spec, size) => 0.6 + size * (spec.blur || 0);

/** The area applyFinish() will touch for content within `rect`. */
export function finishRect(rect, spec, size) {
  const pad = spec?.blur ? Math.ceil(blurRadius(spec, size) * 3) + 2 : 0;
  return { x: rect.x - pad, y: rect.y - pad, w: rect.w + pad * 2, h: rect.h + pad * 2 };
}

/**
 * Composite a coverage mask (`src`, opaque colour) into `dst` with the brush's finish.
 * `tmp` and `tmp2` are scratch canvases of the same size as `src`.
 */
export function applyFinish(dst, src, rect, spec, size, tmp, tmp2) {
  const W = src.width;
  const H = src.height;
  const fr = finishRect(rect, spec, size);
  const x = Math.max(0, Math.floor(fr.x));
  const y = Math.max(0, Math.floor(fr.y));
  const w = Math.min(W, Math.ceil(fr.x + fr.w)) - x;
  const h = Math.min(H, Math.ceil(fr.y + fr.h)) - y;
  if (w <= 0 || h <= 0) return;
  if (!spec || (!spec.grain && !spec.blur && (spec.alpha ?? 1) === 1)) {
    dst.drawImage(src, x, y, w, h, x, y, w, h);
    return;
  }
  const t = tmp.getContext('2d');
  t.save();
  t.clearRect(x, y, w, h);
  if (spec.blur) {
    const b = blurRadius(spec, size);
    t.filter = `blur(${b}px)`;
    t.globalAlpha = spec.rim ? 0.55 : 1;
    t.drawImage(src, x, y, w, h, x, y, w, h);
    t.filter = 'none';
    t.globalAlpha = 1;
    if (spec.rim) {
      const u = tmp2.getContext('2d');
      u.save();
      u.clearRect(x, y, w, h);
      u.drawImage(src, x, y, w, h, x, y, w, h);
      u.globalCompositeOperation = 'destination-out';
      u.filter = `blur(${b * 2.5}px)`;
      u.drawImage(src, x, y, w, h, x, y, w, h);
      u.restore();
      t.globalAlpha = 0.85;
      t.filter = `blur(${Math.max(0.4, b * 0.4)}px)`;
      t.drawImage(tmp2, x, y, w, h, x, y, w, h);
      t.filter = 'none';
      t.globalAlpha = 1;
    }
  } else t.drawImage(src, x, y, w, h, x, y, w, h);
  if (spec.grain) {
    t.globalCompositeOperation = 'destination-in';
    t.fillStyle = grainPattern(t, spec.grain);
    t.fillRect(x, y, w, h);
  }
  t.restore();
  dst.save();
  dst.globalAlpha = spec.alpha ?? 1;
  dst.drawImage(tmp, x, y, w, h, x, y, w, h);
  dst.restore();
}

// ---------------------------------------------------------------- helpers
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

/** Quadratic smoothing through midpoints: feeds curve segments to `seg(x0, y0, cx, cy, x1, y1)`. */
class Smoother {
  constructor(seg) {
    this.seg = seg;
    this.p = [];
    this.count = 0;
  }
  add(x, y) {
    const p = this.p;
    const last = p[p.length - 1];
    if (last && Math.hypot(x - last[0], y - last[1]) < 0.3) return;
    p.push([x, y]);
    this.count++;
    if (p.length > 3) p.shift();
    if (p.length === 2) {
      const m = mid(p[0], p[1]);
      this.seg(p[0][0], p[0][1], (p[0][0] + m[0]) / 2, (p[0][1] + m[1]) / 2, m[0], m[1]);
    } else if (p.length === 3) {
      const a = mid(p[0], p[1]);
      const b = mid(p[1], p[2]);
      this.seg(a[0], a[1], p[1][0], p[1][1], b[0], b[1]);
    }
  }
  end() {
    const p = this.p;
    if (p.length >= 2) {
      const a = mid(p[p.length - 2], p[p.length - 1]);
      const b = p[p.length - 1];
      this.seg(a[0], a[1], (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, b[0], b[1]);
    }
    return this.count;
  }
}

function sampleQuad(x0, y0, cx, cy, x1, y1, step, fn) {
  const len = (Math.hypot(cx - x0, cy - y0) + Math.hypot(x1 - cx, y1 - cy) + Math.hypot(x1 - x0, y1 - y0)) / 2;
  const n = Math.max(1, Math.ceil(len / step));
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    fn(u * u * x0 + 2 * u * t * cx + t * t * x1, u * u * y0 + 2 * u * t * cy + t * t * y1);
  }
}

export function bresenham(x0, y0, x1, y1, fn) {
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    fn(x0, y0);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
}

class Engine {
  constructor(ctx, o) {
    this.ctx = ctx;
    this.color = o.color || '#000000';
    this.size = Math.max(1, Number(o.size) || 1);
    this.rand = rng(o.seed ?? 1);
    this.box = null;
  }
  grow(x, y, r) {
    const b = this.box;
    if (!b) this.box = { x0: x - r, y0: y - r, x1: x + r, y1: y + r };
    else {
      if (x - r < b.x0) b.x0 = x - r;
      if (y - r < b.y0) b.y0 = y - r;
      if (x + r > b.x1) b.x1 = x + r;
      if (y + r > b.y1) b.y1 = y + r;
    }
  }
  get rect() {
    const b = this.box;
    if (!b) return null;
    const x = Math.floor(b.x0) - 2;
    const y = Math.floor(b.y0) - 2;
    return { x, y, w: Math.ceil(b.x1) + 2 - x, h: Math.ceil(b.y1) + 2 - y };
  }
  tick() {}
  end() {}
}

// Aliased pixel pencil (round stamps) and square eraser, like classic Paint.
class PixelEngine extends Engine {
  constructor(ctx, o) {
    super(ctx, o);
    this.size = Math.round(this.size);
    this.square = !!o.square;
    this.last = null;
    const s = this.size;
    if (!this.square && s > 2) {
      const c = document.createElement('canvas');
      c.width = s;
      c.height = s;
      const g = c.getContext('2d');
      g.fillStyle = this.color;
      const r = s / 2;
      for (let row = 0; row < s; row++) {
        const dy = row + 0.5 - r;
        const half = Math.sqrt(Math.max(0, r * r - dy * dy));
        const a = Math.round(r - half);
        const b = Math.round(r + half);
        if (b > a) g.fillRect(a, row, b - a, 1);
      }
      this.stampCanvas = c;
    }
  }
  stamp(ix, iy) {
    const s = this.size;
    const o = Math.floor((s - 1) / 2);
    if (this.stampCanvas) this.ctx.drawImage(this.stampCanvas, ix - o, iy - o);
    else this.ctx.fillRect(ix - o, iy - o, s, s);
  }
  add(x, y) {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    this.ctx.fillStyle = this.color;
    if (!this.last) this.stamp(ix, iy);
    else {
      let first = true;
      bresenham(this.last[0], this.last[1], ix, iy, (px, py) => {
        if (first) {
          first = false;
          return;
        }
        this.stamp(px, py);
      });
    }
    this.last = [ix, iy];
    this.grow(ix + 0.5, iy + 0.5, this.size / 2 + 1);
  }
}

// Smooth round brush. With `vary`, the width breathes slightly with speed for a natural feel.
class RoundEngine extends Engine {
  constructor(ctx, o) {
    super(ctx, o);
    this.size *= o.widthFactor || 1;
    this.vary = !!o.vary;
    this.w = this.size;
    this.first = null;
    this.sm = new Smoother((...s) => this.seg(...s));
  }
  add(x, y) {
    if (!this.first) this.first = [x, y];
    this.sm.add(x, y);
  }
  seg(x0, y0, cx, cy, x1, y1) {
    const ctx = this.ctx;
    if (this.vary && this.size > 2) {
      const d = Math.hypot(x1 - x0, y1 - y0);
      const target = this.size * Math.max(0.7, 1.05 - d / (this.size * 5 + 30));
      this.w += (target - this.w) * 0.3;
    }
    ctx.strokeStyle = this.color;
    ctx.lineWidth = this.w;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.quadraticCurveTo(cx, cy, x1, y1);
    ctx.stroke();
    const r = this.w / 2 + 1;
    this.grow(x0, y0, r);
    this.grow(cx, cy, r);
    this.grow(x1, y1, r);
  }
  end() {
    const n = this.sm.end();
    if (n <= 1 && this.first) {
      const [x, y] = this.first;
      this.ctx.fillStyle = this.color;
      this.ctx.beginPath();
      this.ctx.arc(x, y, Math.max(0.5, this.size / 2), 0, Math.PI * 2);
      this.ctx.fill();
      this.grow(x, y, this.size / 2 + 1);
    }
  }
}

// Flat nib held at a fixed angle: thick across the nib, hairline along it.
class CalligraphyEngine extends Engine {
  constructor(ctx, o) {
    super(ctx, o);
    const r = this.size / 2;
    this.nx = Math.cos(o.angle) * r;
    this.ny = Math.sin(o.angle) * r;
    this.prev = null;
    this.sm = new Smoother((x0, y0, cx, cy, x1, y1) => sampleQuad(x0, y0, cx, cy, x1, y1, 1, (x, y) => this.step(x, y)));
  }
  add(x, y) {
    if (!this.prev) this.prev = [x, y];
    this.sm.add(x, y);
  }
  step(x, y) {
    const [ax, ay] = this.prev;
    this.quad(ax, ay, x, y);
    this.prev = [x, y];
  }
  quad(ax, ay, bx, by) {
    const ctx = this.ctx;
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    const ex = (dx / len) * 0.6;
    const ey = (dy / len) * 0.6;
    const { nx, ny } = this;
    ctx.fillStyle = this.color;
    ctx.strokeStyle = this.color;
    ctx.beginPath();
    ctx.moveTo(ax - ex + nx, ay - ey + ny);
    ctx.lineTo(bx + ex + nx, by + ey + ny);
    ctx.lineTo(bx + ex - nx, by + ey - ny);
    ctx.lineTo(ax - ex - nx, ay - ey - ny);
    ctx.closePath();
    ctx.fill();
    ctx.lineWidth = 1.2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
    const r = this.size / 2 + 2;
    this.grow(ax, ay, r);
    this.grow(bx, by, r);
  }
  end() {
    const n = this.sm.end();
    if (n <= 1 && this.prev) {
      const [x, y] = this.prev;
      const ctx = this.ctx;
      ctx.strokeStyle = this.color;
      ctx.lineWidth = 1.6;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x - this.nx, y - this.ny);
      ctx.lineTo(x + this.nx, y + this.ny);
      ctx.stroke();
      this.grow(x, y, this.size / 2 + 2);
    }
  }
}

// Spray of aliased dots; keeps spraying while the button is held (tick()).
class AirbrushEngine extends Engine {
  constructor(ctx, o) {
    super(ctx, o);
    this.r = this.size * 1.6 + 3;
    this.dot = this.size > 24 ? 2 : 1;
    this.n = Math.max(4, Math.round(this.r * this.r * 0.045));
    this.last = null;
  }
  spray(x, y, n) {
    const ctx = this.ctx;
    ctx.fillStyle = this.color;
    for (let i = 0; i < n; i++) {
      const a = this.rand() * Math.PI * 2;
      const d = Math.sqrt(this.rand()) * this.r;
      ctx.fillRect(Math.floor(x + Math.cos(a) * d), Math.floor(y + Math.sin(a) * d), this.dot, this.dot);
    }
    this.grow(x, y, this.r + 2);
  }
  add(x, y) {
    if (!this.last) {
      this.spray(x, y, this.n);
      this.last = [x, y];
      return;
    }
    const [lx, ly] = this.last;
    const dist = Math.hypot(x - lx, y - ly);
    const step = Math.max(1, this.r * 0.5);
    const steps = Math.floor(dist / step);
    for (let k = 1; k <= steps; k++) {
      const t = (k * step) / dist;
      this.spray(lx + (x - lx) * t, ly + (y - ly) * t, Math.ceil(this.n * 0.45));
    }
    if (steps) this.last = [lx + ((x - lx) * steps * step) / dist, ly + ((y - ly) * steps * step) / dist];
    this.cur = [x, y];
  }
  tick() {
    const p = this.cur || this.last;
    if (p) this.spray(p[0], p[1], Math.ceil(this.n * 0.5));
  }
}

// Bristle brush: streaky strands of slightly varied colour; the paint load runs out along the stroke.
class OilEngine extends Engine {
  constructor(ctx, o) {
    super(ctx, o);
    const s = this.size;
    const n = Math.max(5, Math.min(36, Math.round(s * 0.9)));
    this.bristles = Array.from({ length: n }, (_, i) => ({
      off: ((i + 0.5) / n - 0.5) * s * 1.05 + (this.rand() - 0.5) * (s / n),
      w: 0.9 + this.rand() * Math.max(0.8, s * 0.07),
      a: 0.5 + this.rand() * 0.45,
      c: shade(this.color, (this.rand() - 0.5) * 0.32),
      life: 0.3 + this.rand() * 0.7,
      p: null,
    }));
    this.prev = null;
    this.dir = null;
    this.travel = 0;
    this.sm = new Smoother((x0, y0, cx, cy, x1, y1) => sampleQuad(x0, y0, cx, cy, x1, y1, 1.5, (x, y) => this.step(x, y)));
  }
  add(x, y) {
    if (!this.prev) this.prev = [x, y];
    this.sm.add(x, y);
  }
  step(x, y) {
    const [px, py] = this.prev;
    const dx = x - px;
    const dy = y - py;
    const len = Math.hypot(dx, dy);
    if (len < 0.01) return;
    let tx = dx / len;
    let ty = dy / len;
    if (this.dir) {
      tx = this.dir[0] * 0.7 + tx * 0.3;
      ty = this.dir[1] * 0.7 + ty * 0.3;
      const l = Math.hypot(tx, ty) || 1;
      tx /= l;
      ty /= l;
    }
    this.dir = [tx, ty];
    const nx = -ty;
    const ny = tx;
    this.travel += len;
    const load = Math.max(0.12, 1 - this.travel / (this.size * 26 + 280));
    const ctx = this.ctx;
    ctx.lineCap = 'butt';
    for (const b of this.bristles) {
      const qx = x + nx * b.off;
      const qy = y + ny * b.off;
      if (b.p && b.life > 1 - load) {
        ctx.strokeStyle = b.c;
        ctx.globalAlpha = b.a * (0.5 + 0.5 * load);
        ctx.lineWidth = b.w;
        ctx.beginPath();
        ctx.moveTo(b.p[0], b.p[1]);
        ctx.lineTo(qx, qy);
        ctx.stroke();
      }
      b.p = [qx, qy];
    }
    ctx.globalAlpha = 1;
    this.grow(x, y, this.size * 0.6 + 3);
    this.prev = [x, y];
  }
  end() {
    this.sm.end();
  }
}

/**
 * kind: pencil | eraser | brush | calli1 | calli2 | airbrush | oil | crayon | marker | natural | watercolor
 * opts: { color, size, seed }
 */
export function createEngine(kind, ctx, opts) {
  switch (kind) {
    case 'pencil':
      return new PixelEngine(ctx, opts);
    case 'eraser':
      return new PixelEngine(ctx, { ...opts, square: true });
    case 'calli1':
      return new CalligraphyEngine(ctx, { ...opts, angle: -Math.PI / 4 });
    case 'calli2':
      return new CalligraphyEngine(ctx, { ...opts, angle: Math.PI / 4 });
    case 'airbrush':
      return new AirbrushEngine(ctx, opts);
    case 'oil':
      return new OilEngine(ctx, opts);
    case 'crayon':
    case 'marker':
    case 'natural':
    case 'watercolor':
      return new RoundEngine(ctx, { ...opts, widthFactor: FINISH[kind].width });
    default:
      return new RoundEngine(ctx, { ...opts, vary: true });
  }
}

/** The finish to apply when committing a stroke of this kind (null = draw as is). */
export function finishFor(kind) {
  return ['crayon', 'marker', 'natural', 'watercolor'].includes(kind) ? FINISH[kind] : null;
}
