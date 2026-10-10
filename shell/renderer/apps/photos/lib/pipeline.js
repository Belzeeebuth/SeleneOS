// Photo editing pipeline shared by the editor preview and the full-resolution save.
//
//   edit = {
//     rot: 0..3 (quarter turns clockwise), flipH, flipV, straighten: -45..45 (degrees),
//     crop: null | { x, y, w, h } (0..1, in the rotated + straightened frame), aspect: 'free' | 'original' | '1:1' | …,
//     adjust: { brightness, exposure, contrast, highlights, shadows, saturation, warmth, tint, vignette } (-100..100),
//     filter: { id, amount: 0..100 },
//     markup: [{ tool: 'pen' | 'highlighter', color, size (fraction of the short side), points: [[x, y], …] (0..1 of the source) }]
//   }
//   render(src, srcW, srcH, edit, { scale, crop })  -> HTMLCanvasElement (sync; previews)
//   renderAsync(...)                                 -> Promise<canvas> (full size, yields while processing pixels)
//   encode(canvas, ext, quality)                     -> Promise<Blob>   (png / jpeg / webp / bmp)
//
// Geometry: the source (already EXIF-oriented) is turned `rot` quarter turns and flipped; that is the
// "frame". Straightening rotates the content inside the frame and scales it up just enough that no
// empty corner shows, so any crop rectangle inside the frame is always fully covered.
export const ADJUST_KEYS = ['brightness', 'exposure', 'contrast', 'highlights', 'shadows', 'saturation', 'warmth', 'tint', 'vignette'];

const LUMA = [0.2126, 0.7152, 0.0722, 0.2126, 0.7152, 0.0722, 0.2126, 0.7152, 0.0722];
const SEPIA = [0.393, 0.769, 0.189, 0.349, 0.686, 0.168, 0.272, 0.534, 0.131];
const COOL_MONO = [0.2, 0.68, 0.07, 0.21, 0.71, 0.08, 0.23, 0.74, 0.1];

export const FILTERS = [
  { id: 'original' },
  { id: 'vivid', p: { contrast: 18, saturation: 38 } },
  { id: 'golden', p: { warmth: 38, saturation: 12, brightness: 6, highlights: -12 } },
  { id: 'radiate', p: { exposure: 12, contrast: 12, saturation: 18, vignette: 18 } },
  { id: 'warmContrast', p: { warmth: 26, contrast: 32, shadows: -12 } },
  { id: 'calm', p: { saturation: -38, contrast: -16, brightness: 8 }, fade: 0.06 },
  { id: 'coolLight', p: { warmth: -32, brightness: 12, tint: -6 } },
  { id: 'vividCool', p: { warmth: -26, saturation: 32, contrast: 14 } },
  { id: 'dramatic', p: { contrast: 42, saturation: -22, vignette: 38, shadows: -16, highlights: -22 } },
  { id: 'mono', m: LUMA },
  { id: 'monoContrast', m: LUMA, p: { contrast: 38, shadows: -10 } },
  { id: 'monoCool', m: COOL_MONO, p: { brightness: 6 } },
  { id: 'sepia', m: SEPIA, p: { contrast: 6 } },
  { id: 'vintage', m: SEPIA, mAmount: 0.35, p: { saturation: -18, warmth: 14, vignette: 28, contrast: -8 }, fade: 0.08 },
  { id: 'faded', p: { contrast: -14, saturation: -18, brightness: 6 }, fade: 0.14 },
];

export function defaultEdit() {
  return {
    rot: 0,
    flipH: false,
    flipV: false,
    straighten: 0,
    crop: null,
    aspect: 'free',
    adjust: Object.fromEntries(ADJUST_KEYS.map((k) => [k, 0])),
    filter: { id: 'original', amount: 100 },
    markup: [],
  };
}

export const cloneEdit = (e) => JSON.parse(JSON.stringify(e));

export function isFullCrop(c) {
  return !c || (c.x <= 0.0005 && c.y <= 0.0005 && c.w >= 0.9995 && c.h >= 0.9995);
}

export function hasPixelOps(edit) {
  return ADJUST_KEYS.some((k) => Math.round(edit.adjust?.[k] || 0) !== 0) || (edit.filter && edit.filter.id !== 'original' && edit.filter.amount > 0);
}

export function isIdentity(edit) {
  return !edit.rot && !edit.flipH && !edit.flipV && !edit.straighten && isFullCrop(edit.crop) && !hasPixelOps(edit) && !(edit.markup || []).length;
}

export function frameSize(w, h, rot) {
  return rot % 2 ? [h, w] : [w, h];
}

/** Scale applied to straightened content so it covers the whole frame. */
export function straightenScale(fw, fh, deg) {
  const a = (Math.abs(deg) * Math.PI) / 180;
  if (!a) return 1;
  return Math.cos(a) + Math.max(fw / fh, fh / fw) * Math.sin(a);
}

/** Output size in pixels for an edit at full resolution. */
export function outputSize(srcW, srcH, edit) {
  const [fw, fh] = frameSize(srcW, srcH, edit.rot || 0);
  const c = isFullCrop(edit.crop) ? { w: 1, h: 1 } : edit.crop;
  return [Math.max(1, Math.round(c.w * fw)), Math.max(1, Math.round(c.h * fh))];
}

/** Canvas transform from source pixel space (centered) to output pixel space. */
function applyTransform(ctx, srcW, srcH, edit, scale, crop) {
  const [fw, fh] = frameSize(srcW, srcH, edit.rot || 0);
  const c = crop && !isFullCrop(edit.crop) ? edit.crop : { x: 0, y: 0 };
  const k = straightenScale(fw, fh, edit.straighten || 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(scale, scale);
  ctx.translate(-c.x * fw, -c.y * fh);
  ctx.translate(fw / 2, fh / 2);
  ctx.rotate(((edit.straighten || 0) * Math.PI) / 180);
  ctx.scale(k, k);
  ctx.scale(edit.flipH ? -1 : 1, edit.flipV ? -1 : 1);
  ctx.rotate(((edit.rot || 0) * Math.PI) / 2);
}

/** Map a point of the (uncropped) frame (0..1) to source coordinates (0..1) — used by markup. */
export function frameToSource(fx, fy, srcW, srcH, edit) {
  const [fw, fh] = frameSize(srcW, srcH, edit.rot || 0);
  let x = fx * fw - fw / 2;
  let y = fy * fh - fh / 2;
  const k = straightenScale(fw, fh, edit.straighten || 0);
  const a = (-(edit.straighten || 0) * Math.PI) / 180;
  [x, y] = [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];
  x /= k;
  y /= k;
  if (edit.flipH) x = -x;
  if (edit.flipV) y = -y;
  const r = (-(edit.rot || 0) * Math.PI) / 2;
  [x, y] = [x * Math.cos(r) - y * Math.sin(r), x * Math.sin(r) + y * Math.cos(r)];
  return [(x + srcW / 2) / srcW, (y + srcH / 2) / srcH];
}

/** Map an output point (0..1 of the cropped image) to frame coordinates (0..1). */
export function outputToFrame(ox, oy, edit) {
  const c = isFullCrop(edit.crop) ? { x: 0, y: 0, w: 1, h: 1 } : edit.crop;
  return [c.x + ox * c.w, c.y + oy * c.h];
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function drawGeometry(src, srcW, srcH, edit, scale, crop) {
  const [fw, fh] = frameSize(srcW, srcH, edit.rot || 0);
  const c = crop && !isFullCrop(edit.crop) ? edit.crop : { w: 1, h: 1 };
  const W = Math.max(1, Math.round(c.w * fw * scale));
  const H = Math.max(1, Math.round(c.h * fh * scale));
  const canvas = makeCanvas(W, H);
  const ctx = canvas.getContext('2d', { willReadFrequently: hasPixelOps(edit) });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  applyTransform(ctx, srcW, srcH, edit, scale, crop);
  ctx.drawImage(src, -srcW / 2, -srcH / 2, srcW, srcH);
  return canvas;
}

function drawMarkup(canvas, srcW, srcH, edit, scale, crop) {
  const strokes = edit.markup || [];
  if (!strokes.length) return;
  const ctx = canvas.getContext('2d');
  ctx.save();
  applyTransform(ctx, srcW, srcH, edit, scale, crop);
  for (const s of strokes) drawStroke(ctx, s, srcW, srcH);
  ctx.restore();
}

export function drawStroke(ctx, s, srcW, srcH) {
  const pts = s.points || [];
  if (!pts.length) return;
  const lw = Math.max(0.5, (s.size || 0.01) * Math.min(srcW, srcH));
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = s.tool === 'highlighter' ? 'square' : 'round';
  ctx.globalAlpha = s.tool === 'highlighter' ? 0.42 : 1;
  ctx.strokeStyle = s.color || '#e81123';
  ctx.fillStyle = s.color || '#e81123';
  ctx.lineWidth = lw;
  const P = (p) => [p[0] * srcW - srcW / 2, p[1] * srcH - srcH / 2];
  if (pts.length === 1) {
    const [x, y] = P(pts[0]);
    ctx.beginPath();
    ctx.arc(x, y, lw / 2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.beginPath();
    let [x0, y0] = P(pts[0]);
    ctx.moveTo(x0, y0);
    // Smooth the polyline with quadratic curves through midpoints.
    for (let i = 1; i < pts.length - 1; i++) {
      const [x1, y1] = P(pts[i]);
      const [x2, y2] = P(pts[i + 1]);
      ctx.quadraticCurveTo(x1, y1, (x1 + x2) / 2, (y1 + y2) / 2);
      x0 = x2;
      y0 = y2;
    }
    const [xl, yl] = P(pts[pts.length - 1]);
    ctx.lineTo(xl, yl);
    ctx.stroke();
  }
  ctx.restore();
}

// ------------------------------------------------------------------ pixel operations
function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Effective parameters: user adjustments + the filter preset scaled by its amount. */
export function effectiveParams(edit) {
  const f = FILTERS.find((x) => x.id === edit.filter?.id) || FILTERS[0];
  const amt = Math.max(0, Math.min(100, edit.filter?.amount ?? 100)) / 100;
  const p = {};
  for (const k of ADJUST_KEYS) p[k] = Math.max(-100, Math.min(100, (edit.adjust?.[k] || 0) + amt * (f.p?.[k] || 0)));
  p.fade = amt * (f.fade || 0);
  p.matrix = null;
  if (f.m) {
    const a = amt * (f.mAmount ?? 1);
    const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    p.matrix = I.map((v, i) => v + a * (f.m[i] - v));
  }
  return p;
}

export function toneLUT(p) {
  const lut = new Uint8ClampedArray(256);
  const ex = Math.pow(2, (p.exposure / 100) * 1.2);
  const gamma = Math.pow(2, (-p.brightness / 100) * 0.85);
  const c = p.contrast / 100;
  const ck = c >= 0 ? 1 + c * 1.25 : 1 + c * 0.8;
  const hl = p.highlights / 100;
  const sh = p.shadows / 100;
  for (let v = 0; v < 256; v++) {
    let x = v / 255;
    x *= ex;
    x = Math.min(1, x);
    if (gamma !== 1) x = Math.pow(x, gamma);
    if (ck !== 1) x = (x - 0.5) * ck + 0.5;
    x = Math.min(1, Math.max(0, x));
    if (hl) {
      const w = smoothstep(0.45, 1, x);
      x += hl * 0.38 * w * (hl > 0 ? 1 - x : x);
    }
    if (sh) {
      const w = 1 - smoothstep(0, 0.55, x);
      x += sh * 0.4 * w * (sh > 0 ? (1 - x) * Math.min(1, x * 4 + 0.25) : x);
    }
    if (p.fade) x = p.fade + x * (1 - p.fade);
    lut[v] = Math.round(Math.min(1, Math.max(0, x)) * 255);
  }
  return lut;
}

/** Apply adjustments/filter to RGBA pixels in place. `data` holds `rows` rows of a w×h image starting at row yOff
 *  (bands keep the vignette centred on the whole image). */
export function applyPixels(data, w, h, p, lut = toneLUT(p), yOff = 0, rows = h) {
  const sat = 1 + p.saturation / 100;
  const warm = p.warmth / 100;
  const tint = p.tint / 100;
  const rMul = (1 + 0.16 * warm) * (1 + 0.05 * tint);
  const gMul = 1 - 0.12 * tint;
  const bMul = (1 - 0.16 * warm) * (1 + 0.05 * tint);
  const m = p.matrix;
  const vig = p.vignette / 100;
  const cx = w / 2;
  const cy = h / 2;
  const colorOps = sat !== 1 || rMul !== 1 || gMul !== 1 || bMul !== 1;
  for (let yy = 0; yy < rows; yy++) {
    const ny = (yy + yOff + 0.5 - cy) / cy;
    const ny2 = ny * ny;
    let i = yy * w * 4;
    for (let x = 0; x < w; x++, i += 4) {
      let r = lut[data[i]];
      let g = lut[data[i + 1]];
      let b = lut[data[i + 2]];
      if (colorOps) {
        if (sat !== 1) {
          const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          r = l + (r - l) * sat;
          g = l + (g - l) * sat;
          b = l + (b - l) * sat;
        }
        r *= rMul;
        g *= gMul;
        b *= bMul;
      }
      if (m) {
        const nr = m[0] * r + m[1] * g + m[2] * b;
        const ng = m[3] * r + m[4] * g + m[5] * b;
        const nb = m[6] * r + m[7] * g + m[8] * b;
        r = nr;
        g = ng;
        b = nb;
      }
      if (vig) {
        const nx = (x + 0.5 - cx) / cx;
        const d = Math.sqrt(nx * nx + ny2) * 0.7071;
        const f = smoothstep(0.32, 1, d);
        if (vig > 0) {
          const k = 1 - vig * 0.82 * f;
          r *= k;
          g *= k;
          b *= k;
        } else {
          const k = -vig * 0.6 * f;
          r += (255 - r) * k;
          g += (255 - g) * k;
          b += (255 - b) * k;
        }
      }
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
    }
  }
}

/** Synchronous render (previews, small images). */
export function render(src, srcW, srcH, edit, { scale = 1, crop = true } = {}) {
  const canvas = drawGeometry(src, srcW, srcH, edit, scale, crop);
  if (hasPixelOps(edit)) {
    const ctx = canvas.getContext('2d');
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    applyPixels(img.data, canvas.width, canvas.height, effectiveParams(edit));
    ctx.putImageData(img, 0, 0);
  }
  drawMarkup(canvas, srcW, srcH, edit, scale, crop);
  return canvas;
}

/** Full-size render that yields to the event loop while processing pixels (keeps the UI responsive). */
export async function renderAsync(src, srcW, srcH, edit, { scale = 1, crop = true, onProgress } = {}) {
  const canvas = drawGeometry(src, srcW, srcH, edit, scale, crop);
  if (hasPixelOps(edit)) {
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    const p = effectiveParams(edit);
    const lut = toneLUT(p);
    // Process in horizontal bands to bound memory and keep frames flowing.
    const band = Math.max(16, Math.floor(4_000_000 / W));
    for (let y = 0; y < H; y += band) {
      const hh = Math.min(band, H - y);
      const img = ctx.getImageData(0, y, W, hh);
      applyPixels(img.data, W, H, p, lut, y, hh);
      ctx.putImageData(img, 0, y);
      onProgress?.(Math.min(1, (y + hh) / H));
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  drawMarkup(canvas, srcW, srcH, edit, scale, crop);
  return canvas;
}

// ------------------------------------------------------------------ encoding
export async function encode(canvas, ext, quality = 0.92) {
  ext = (ext || '.png').toLowerCase();
  if (ext === '.bmp') return encodeBMP(canvas);
  const type = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png';
  let c = canvas;
  if (type === 'image/jpeg') {
    // JPEG has no alpha: flatten on white like Windows does.
    c = makeCanvas(canvas.width, canvas.height);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(canvas, 0, 0);
  }
  const blob = await new Promise((resolve) => c.toBlob(resolve, type, type === 'image/png' ? undefined : quality));
  if (!blob) throw new Error('encode');
  return blob;
}

/** 24-bit bottom-up BMP (flattened on white). */
export function encodeBMP(canvas) {
  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext('2d');
  const px = ctx.getImageData(0, 0, w, h).data;
  const rowSize = Math.ceil((w * 3) / 4) * 4;
  const size = 54 + rowSize * h;
  const buf = new ArrayBuffer(size);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  u8[0] = 0x42;
  u8[1] = 0x4d;
  dv.setUint32(2, size, true);
  dv.setUint32(10, 54, true);
  dv.setUint32(14, 40, true);
  dv.setInt32(18, w, true);
  dv.setInt32(22, h, true);
  dv.setUint16(26, 1, true);
  dv.setUint16(28, 24, true);
  dv.setUint32(34, rowSize * h, true);
  dv.setInt32(38, 2835, true);
  dv.setInt32(42, 2835, true);
  for (let y = 0; y < h; y++) {
    let o = 54 + (h - 1 - y) * rowSize;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const a = px[i + 3] / 255;
      u8[o++] = Math.round(px[i + 2] * a + 255 * (1 - a));
      u8[o++] = Math.round(px[i + 1] * a + 255 * (1 - a));
      u8[o++] = Math.round(px[i] * a + 255 * (1 - a));
    }
  }
  return new Blob([buf], { type: 'image/bmp' });
}

/** Aspect ratio presets for the crop tool (w / h of the output; 'original' uses the frame). */
export const ASPECTS = [
  { id: 'free', r: null },
  { id: 'original', r: 'original' },
  { id: '1:1', r: 1 },
  { id: '4:3', r: 4 / 3 },
  { id: '3:2', r: 3 / 2 },
  { id: '16:9', r: 16 / 9 },
  { id: '3:4', r: 3 / 4 },
  { id: '2:3', r: 2 / 3 },
  { id: '9:16', r: 9 / 16 },
];

/** Largest centred crop (normalized) with the given output aspect inside a fw×fh frame. */
export function centeredCrop(fw, fh, ratio) {
  if (!ratio) return { x: 0, y: 0, w: 1, h: 1 };
  const fr = fw / fh;
  if (ratio >= fr) {
    const h = fr / ratio;
    return { x: 0, y: (1 - h) / 2, w: 1, h };
  }
  const w = ratio / fr;
  return { x: (1 - w) / 2, y: 0, w, h: 1 };
}
