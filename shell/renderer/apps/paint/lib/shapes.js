// Shape geometry and rendering for the Shapes gallery.
// A shape is { type, x0, y0, x1, y1, c1?, c2? (curve), pts? (polygon), closed?, stroke, fillColor,
//              size, outline, fill, seed }.  Coordinates are image pixels.
// geometry(shape) -> { rings: [[ [x, y], … ], …], closed, join } — every shape is a list of point
// rings so that solid and textured outlines/fills share one code path.
import { applyFinish, createEngine, FINISH, grainPattern } from './brushes.js';

export const SHAPES = [
  'line', 'curve', 'ellipse', 'rect', 'roundrect', 'polygon', 'triangle', 'rtriangle',
  'diamond', 'pentagon', 'hexagon', 'arrowR', 'arrowL', 'arrowU', 'arrowD', 'star4',
  'star5', 'star6', 'calloutRect', 'calloutOval', 'calloutCloud', 'heart', 'lightning',
];
export const OUTLINES = ['none', 'solid', 'crayon', 'marker', 'oil', 'natural', 'watercolor'];
export const FILLS = ['none', 'solid', 'crayon', 'marker', 'oil', 'natural', 'watercolor'];
export const isOpen = (type) => type === 'line' || type === 'curve';

const TAU = Math.PI * 2;

function arc(out, cx, cy, rx, ry, a0, a1, n) {
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    out.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return out;
}

function fit(unit, l, t, w, h) {
  let ux0 = Infinity;
  let uy0 = Infinity;
  let ux1 = -Infinity;
  let uy1 = -Infinity;
  for (const [x, y] of unit) {
    if (x < ux0) ux0 = x;
    if (y < uy0) uy0 = y;
    if (x > ux1) ux1 = x;
    if (y > uy1) uy1 = y;
  }
  const sx = w / (ux1 - ux0 || 1);
  const sy = h / (uy1 - uy0 || 1);
  return unit.map(([x, y]) => [l + (x - ux0) * sx, t + (y - uy0) * sy]);
}

function star(n, inner) {
  const pts = [];
  for (let i = 0; i < n * 2; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / n;
    const r = i % 2 ? inner : 1;
    pts.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return pts;
}

function regular(n, a0) {
  return Array.from({ length: n }, (_, i) => {
    const a = a0 + (i * TAU) / n;
    return [Math.cos(a), Math.sin(a)];
  });
}

const segs = (len) => Math.max(8, Math.min(180, Math.round(len / 2)));

function roundRectRing(l, t, r, b, rad, tail) {
  const out = [];
  rad = Math.max(0, Math.min(rad, (r - l) / 2, (b - t) / 2));
  const n = Math.max(3, Math.round(rad / 1.5));
  out.push([l + rad, t], [r - rad, t]);
  arc(out, r - rad, t + rad, rad, rad, -Math.PI / 2, 0, n);
  out.push([r, b - rad]);
  arc(out, r - rad, b - rad, rad, rad, 0, Math.PI / 2, n);
  if (tail) out.push(...tail);
  out.push([l + rad, b]);
  arc(out, l + rad, b - rad, rad, rad, Math.PI / 2, Math.PI, n);
  out.push([l, t + rad]);
  arc(out, l + rad, t + rad, rad, rad, Math.PI, Math.PI * 1.5, n);
  return out;
}

function ellipseRing(cx, cy, rx, ry, a0 = 0, a1 = TAU) {
  const per = Math.PI * (3 * (rx + ry) - Math.sqrt((3 * rx + ry) * (rx + 3 * ry)));
  const n = Math.max(24, Math.min(720, Math.round(((per * Math.abs(a1 - a0)) / TAU) / 1.2)));
  const out = arc([], cx, cy, rx, ry, a0, a1, n);
  if (a1 - a0 >= TAU - 1e-6) out.pop();
  return out;
}

function cloudRing() {
  const N = 9;
  const base = Array.from({ length: N }, (_, i) => {
    const a = (i * TAU) / N + 0.25;
    return [Math.cos(a), Math.sin(a) * 0.62];
  });
  const out = [];
  for (let i = 0; i < N; i++) {
    const p = base[i];
    const q = base[(i + 1) % N];
    const mx = (p[0] + q[0]) / 2;
    const my = (p[1] + q[1]) / 2;
    const rad = Math.hypot(q[0] - p[0], q[1] - p[1]) / 2;
    const a0 = Math.atan2(p[1] - my, p[0] - mx);
    // Bulge away from the centre.
    const outward = Math.atan2(my, mx);
    let a1 = a0 + Math.PI;
    const midA = a0 + Math.PI / 2;
    if (Math.cos(midA - outward) < 0) a1 = a0 - Math.PI;
    for (let k = 0; k <= 14; k++) {
      const a = a0 + ((a1 - a0) * k) / 14;
      out.push([mx + Math.cos(a) * rad, my + Math.sin(a) * rad * 1.05]);
    }
  }
  return out;
}

const HEART = (() => {
  const pts = [];
  for (let i = 0; i < 160; i++) {
    const t = (i / 160) * TAU;
    pts.push([16 * Math.sin(t) ** 3, -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t))]);
  }
  return pts;
})();

const LIGHTNING = [
  [0.42, 0], [0.74, 0], [0.56, 0.35], [0.82, 0.35], [0.26, 1], [0.42, 0.53], [0.17, 0.53],
];

function cubic(p0, c1, c2, p1) {
  const len = Math.hypot(c1[0] - p0[0], c1[1] - p0[1]) + Math.hypot(c2[0] - c1[0], c2[1] - c1[1]) + Math.hypot(p1[0] - c2[0], p1[1] - c2[1]);
  const n = Math.max(12, Math.min(400, Math.round(len / 2)));
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    out.push([a * p0[0] + b * c1[0] + c * c2[0] + d * p1[0], a * p0[1] + b * c1[1] + c * c2[1] + d * p1[1]]);
  }
  return out;
}

export function normBox(s) {
  return {
    l: Math.min(s.x0, s.x1),
    t: Math.min(s.y0, s.y1),
    r: Math.max(s.x0, s.x1),
    b: Math.max(s.y0, s.y1),
  };
}

export function geometry(s) {
  const type = s.type;
  if (type === 'line') return { rings: [[[s.x0, s.y0], [s.x1, s.y1]]], closed: false, join: 'round' };
  if (type === 'curve') {
    const p0 = [s.x0, s.y0];
    const p1 = [s.x1, s.y1];
    const c1 = s.c1 || [s.x0 + (s.x1 - s.x0) / 3, s.y0 + (s.y1 - s.y0) / 3];
    const c2 = s.c2 || [s.x0 + ((s.x1 - s.x0) * 2) / 3, s.y0 + ((s.y1 - s.y0) * 2) / 3];
    return { rings: [cubic(p0, c1, c2, p1)], closed: false, join: 'round' };
  }
  if (type === 'polygon') return { rings: [s.pts.map((p) => [...p])], closed: s.closed !== false, join: 'miter' };

  const nb = normBox(s);
  const inset = s.outline && s.outline !== 'none' ? Math.min(s.size / 2, (nb.r - nb.l) / 2, (nb.b - nb.t) / 2) : 0;
  const l = nb.l + inset;
  const t = nb.t + inset;
  const r = nb.r - inset;
  const b = nb.b - inset;
  const w = Math.max(0, r - l);
  const h = Math.max(0, b - t);
  const cx = (l + r) / 2;
  const cy = (t + b) / 2;
  const poly = (pts, join = 'miter') => ({ rings: [pts], closed: true, join });
  switch (type) {
    case 'ellipse':
      return poly(ellipseRing(cx, cy, w / 2, h / 2), 'round');
    case 'rect':
      return poly([[l, t], [r, t], [r, b], [l, b]]);
    case 'roundrect':
      return poly(roundRectRing(l, t, r, b, Math.max(2, Math.min(w, h) * 0.18)), 'round');
    case 'triangle':
      return poly([[cx, t], [r, b], [l, b]]);
    case 'rtriangle':
      return poly([[l, t], [r, b], [l, b]]);
    case 'diamond':
      return poly([[cx, t], [r, cy], [cx, b], [l, cy]]);
    case 'pentagon':
      return poly(fit(regular(5, -Math.PI / 2), l, t, w, h));
    case 'hexagon':
      return poly([[l, cy], [l + w / 4, t], [r - w / 4, t], [r, cy], [r - w / 4, b], [l + w / 4, b]]);
    case 'arrowR': {
      const hd = Math.min(w, h / 2);
      return poly([[l, t + h / 4], [r - hd, t + h / 4], [r - hd, t], [r, cy], [r - hd, b], [r - hd, b - h / 4], [l, b - h / 4]]);
    }
    case 'arrowL': {
      const hd = Math.min(w, h / 2);
      return poly([[r, t + h / 4], [l + hd, t + h / 4], [l + hd, t], [l, cy], [l + hd, b], [l + hd, b - h / 4], [r, b - h / 4]]);
    }
    case 'arrowU': {
      const hd = Math.min(h, w / 2);
      return poly([[l + w / 4, b], [l + w / 4, t + hd], [l, t + hd], [cx, t], [r, t + hd], [r - w / 4, t + hd], [r - w / 4, b]]);
    }
    case 'arrowD': {
      const hd = Math.min(h, w / 2);
      return poly([[l + w / 4, t], [l + w / 4, b - hd], [l, b - hd], [cx, b], [r, b - hd], [r - w / 4, b - hd], [r - w / 4, t]]);
    }
    case 'star4':
      return poly(fit(star(4, 0.38), l, t, w, h));
    case 'star5':
      return poly(fit(star(5, 0.4), l, t, w, h));
    case 'star6':
      return poly(fit(star(6, 0.56), l, t, w, h));
    case 'calloutRect': {
      const bb = t + h * 0.72;
      const rad = Math.max(2, Math.min(w, bb - t) * 0.16);
      const b1 = Math.max(l + rad + 1, l + w * 0.36);
      const b0 = Math.max(l + rad, l + w * 0.18);
      return poly(roundRectRing(l, t, r, bb, rad, [[b1, bb], [l + w * 0.1, b], [b0, bb]]), 'round');
    }
    case 'calloutOval': {
      const ry = h * 0.4;
      const ecy = t + ry;
      const a1 = (115 * Math.PI) / 180;
      const a2 = (138 * Math.PI) / 180;
      const ring = ellipseRing(cx, ecy, w / 2, ry, a2, a1 + TAU);
      ring.push([l + w * 0.1, b]);
      return poly(ring, 'round');
    }
    case 'calloutCloud': {
      const main = fit(cloudRing(), l, t, w, h * 0.78);
      const e1 = ellipseRing(l + w * 0.2, t + h * 0.86, w * 0.06, h * 0.045);
      const e2 = ellipseRing(l + w * 0.09, t + h * 0.955, w * 0.035, h * 0.03);
      return { rings: [main, e1, e2], closed: true, join: 'round' };
    }
    case 'heart':
      return poly(fit(HEART, l, t, w, h), 'round');
    case 'lightning':
      return poly(fit(LIGHTNING, l, t, w, h));
    default:
      return poly([[l, t], [r, t], [r, b], [l, b]]);
  }
}

export function toPath(g) {
  const p = new Path2D();
  for (const ring of g.rings) {
    if (!ring.length) continue;
    p.moveTo(ring[0][0], ring[0][1]);
    for (let i = 1; i < ring.length; i++) p.lineTo(ring[i][0], ring[i][1]);
    if (g.closed) p.closePath();
  }
  return p;
}

export function geometryBounds(g) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const ring of g.rings) {
    for (const [x, y] of ring) {
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Pixel area a rendered shape can touch (for undo). */
export function shapeBounds(s) {
  const g = geometry(s);
  const b = geometryBounds(g);
  const pad = Math.ceil(s.size * (s.type === 'polygon' || !isOpen(s.type) ? 3 : 1)) + 8 + (s.outline === 'watercolor' || s.fill === 'watercolor' ? s.size + 8 : 0);
  return { x: Math.floor(b.x - pad), y: Math.floor(b.y - pad), w: Math.ceil(b.w + pad * 2) + 1, h: Math.ceil(b.h + pad * 2) + 1 };
}

function densePoints(ring, closed, step = 2) {
  const pts = closed ? [...ring, ring[0]] : ring;
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[i + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
    for (let k = 0; k < n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/**
 * Draw a shape into ctx. env: { scratch(i) -> canvas the size of ctx.canvas }.
 */
export function renderShape(ctx, s, env) {
  const g = geometry(s);
  if (!g.rings.length || !g.rings[0].length) return;
  const path = toPath(g);
  const bounds = shapeBounds(s);
  const size = Math.max(1, s.size);
  const coverage = () => {
    const c = env.scratch(0);
    const cc = c.getContext('2d');
    cc.clearRect(bounds.x, bounds.y, bounds.w, bounds.h);
    return [c, cc];
  };
  const finish = (cov, spec) => applyFinish(ctx, cov, bounds, spec, size, env.scratch(1), env.scratch(2));

  if (g.closed && s.fill && s.fill !== 'none') {
    if (s.fill === 'solid') {
      ctx.fillStyle = s.fillColor;
      ctx.fill(path);
    } else {
      const [cov, cc] = coverage();
      cc.fillStyle = s.fillColor;
      if (s.fill === 'natural') {
        cc.save();
        cc.clip(path);
        cc.strokeStyle = s.fillColor;
        cc.lineWidth = 1.2;
        cc.beginPath();
        for (let k = -bounds.h; k < bounds.w; k += 4) {
          cc.moveTo(bounds.x + k, bounds.y + bounds.h);
          cc.lineTo(bounds.x + k + bounds.h, bounds.y);
        }
        cc.stroke();
        cc.restore();
      } else cc.fill(path);
      finish(cov, FINISH[s.fill] || FINISH.solid);
    }
  }

  let outline = s.outline || 'solid';
  if (!g.closed && outline === 'none') outline = 'solid';
  if (outline === 'none') return;
  const join = g.join;
  const cap = g.closed ? 'butt' : 'round';
  if (outline === 'solid') {
    ctx.strokeStyle = s.stroke;
    ctx.lineWidth = size;
    ctx.lineJoin = join;
    ctx.lineCap = cap;
    ctx.miterLimit = 6;
    ctx.stroke(path);
    return;
  }
  const [cov, cc] = coverage();
  if (outline === 'oil') {
    for (const ring of g.rings) {
      const e = createEngine('oil', cc, { color: s.stroke, size, seed: s.seed || 1 });
      for (const [x, y] of densePoints(ring, g.closed)) e.add(x, y);
      e.end();
    }
    ctx.drawImage(cov, bounds.x, bounds.y, bounds.w, bounds.h, bounds.x, bounds.y, bounds.w, bounds.h);
    return;
  }
  cc.strokeStyle = s.stroke;
  cc.lineWidth = outline === 'natural' ? Math.max(1, size * 0.8) : size;
  cc.lineJoin = 'round';
  cc.lineCap = 'round';
  cc.stroke(path);
  finish(cov, FINISH[outline]);
}

/** Does the point hit the shape body (for dragging a pending shape)? */
export function hitShape(s, x, y, tol) {
  if (isOpen(s.type)) {
    const g = geometry(s);
    const pts = g.rings[0];
    for (let i = 0; i < pts.length - 1; i++) if (distToSeg(x, y, pts[i], pts[i + 1]) <= tol + s.size / 2) return true;
    return false;
  }
  const b = s.type === 'polygon' ? geometryBounds(geometry(s)) : (() => {
    const n = normBox(s);
    return { x: n.l, y: n.t, w: n.r - n.l, h: n.b - n.t };
  })();
  return x >= b.x - tol && x <= b.x + b.w + tol && y >= b.y - tol && y <= b.y + b.h + tol;
}

function distToSeg(px, py, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - a[0]) * dx + (py - a[1]) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
}

/** SVG path data for the gallery icon of a shape type (20×20 box). */
export function shapeIcon(type) {
  let s;
  if (type === 'line') s = { type, x0: 3.5, y0: 16.5, x1: 16.5, y1: 3.5 };
  else if (type === 'curve') s = { type, x0: 3, y0: 15, x1: 17, y1: 5, c1: [5, 1], c2: [15, 19] };
  else if (type === 'polygon') s = { type, pts: [[3, 9], [9, 3], [17, 6], [14, 16], [5, 15]], closed: true };
  else s = { type, x0: 2.5, y0: 3.5, x1: 17.5, y1: 16.5, outline: 'none', size: 0 };
  if (['star4', 'star5', 'star6', 'heart', 'pentagon', 'hexagon', 'ellipse'].includes(type)) Object.assign(s, { y0: 2.5, y1: 17.5 });
  const g = geometry(s);
  return g.rings
    .map((ring) => `M${ring.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join('L')}${g.closed ? 'Z' : ''}`)
    .join('');
}

export { grainPattern };
