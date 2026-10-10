// Small generated artwork for Paint: brush stroke previews and tool cursors.
import { iconSvg } from '../../core/icons.js';
import { applyFinish, finishFor } from './lib/brushes.js';

/** Draws a sample S-stroke with the given brush into a (2x density) preview canvas. */
export function previewStroke(canvas, kind, color, createEngine) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const spec = finishFor(kind);
  const target = spec ? document.createElement('canvas') : canvas;
  if (spec) {
    target.width = W;
    target.height = H;
  }
  const size = kind === 'airbrush' ? 6 : kind === 'natural' ? 7 : 10;
  const e = createEngine(kind, target.getContext('2d'), { color, size, seed: 42 });
  const pts = 48;
  for (let i = 0; i <= pts; i++) {
    const tt = i / pts;
    const x = 14 + tt * (W - 28);
    const y = H / 2 + Math.sin(tt * Math.PI * 2) * (H * 0.24);
    e.add(x, y);
    if (kind === 'airbrush' && i % 3 === 0) e.tick();
  }
  e.end();
  if (spec) {
    const tmp = document.createElement('canvas');
    const tmp2 = document.createElement('canvas');
    tmp.width = tmp2.width = W;
    tmp.height = tmp2.height = H;
    applyFinish(ctx, target, { x: 0, y: 0, w: W, h: H }, spec, size, tmp, tmp2);
  }
}

const inner = (name, filled = true) => /<svg[^>]*>([\s\S]*)<\/svg>/.exec(iconSvg(name, { filled }))?.[1] || '';

function svgCursor(svg, hx, hy, fallback = 'crosshair') {
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${Math.round(hx)} ${Math.round(hy)}, ${fallback}`;
}

function glyphCursor(name, hot, { flip = false } = {}) {
  const px = 24;
  const k = px / 22; // viewBox -1..21
  const tr = flip ? ' transform="translate(20 0) scale(-1 1)"' : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="-1 -1 22 22"><g${tr} fill="#000" stroke="#fff" stroke-width="1.5" stroke-linejoin="round" paint-order="stroke">${inner(name)}</g></svg>`;
  return svgCursor(svg, (hot[0] + 1) * k, (hot[1] + 1) * k);
}

// Brush/eraser cursors depend on size × zoom (continuous with Ctrl+wheel): keep the cache bounded.
const cache = new Map();
const CACHE_MAX = 160;
function cached(key, fn) {
  let v = cache.get(key);
  if (v === undefined) {
    v = fn();
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  } else cache.delete(key);
  cache.set(key, v);
  return v;
}

/** CSS cursor for a tool. opts: { size (image px), scale (CSS px per image px) } */
export function cursorFor(tool, { size = 1, scale = 1 } = {}) {
  switch (tool) {
    case 'pencil':
      return cached('pencil', () => glyphCursor('edit', [2.4, 17.6]));
    case 'fill':
      return cached('fill', () => glyphCursor('paint_bucket', [17.5, 16.5]));
    case 'picker':
      return cached('picker', () => glyphCursor('eyedropper', [2.4, 17.6]));
    case 'zoom':
      return cached('zoom', () => glyphCursor('zoom_in', [8, 8]));
    case 'text':
      return 'text';
    case 'select':
    case 'shape':
      return 'crosshair';
    case 'brush':
    case 'eraser': {
      const d = Math.max(1, size * scale);
      if (d > 120) return 'crosshair';
      if (d < 5) return cached('dot', () => svgCursor(crossSvg(), 8, 8));
      const key = `${tool}:${d.toFixed(1)}`;
      return cached(key, () => {
        const n = Math.ceil(d) + 4;
        const c = n / 2;
        const shape =
          tool === 'eraser'
            ? `<rect x="${(c - d / 2).toFixed(2)}" y="${(c - d / 2).toFixed(2)}" width="${d.toFixed(2)}" height="${d.toFixed(2)}"`
            : `<circle cx="${c}" cy="${c}" r="${(d / 2).toFixed(2)}"`;
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${n}" height="${n}" viewBox="0 0 ${n} ${n}">${shape} fill="none" stroke="#fff" stroke-width="3"/>${shape} fill="none" stroke="#000" stroke-width="1"/></svg>`;
        return svgCursor(svg, c, c);
      });
    }
    default:
      return 'default';
  }
}

function crossSvg() {
  return '<svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 17 17"><path d="M8.5 1v5M8.5 11v5M1 8.5h5M11 8.5h5" stroke="#fff" stroke-width="3"/><path d="M8.5 1v5M8.5 11v5M1 8.5h5M11 8.5h5" stroke="#000" stroke-width="1"/><rect x="7.5" y="7.5" width="2" height="2" fill="#000" stroke="#fff" stroke-width=".8"/></svg>';
}
