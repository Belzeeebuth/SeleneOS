// Image decoding / encoding for Paint.
//   await decodeImage(bytes)                -> ImageBitmap (PNG, JPEG, BMP, GIF first frame, WebP, ICO…)
//   await encodeCanvas(canvas, 'png'|'jpeg'|'bmp'|'gif'|'webp')  -> Uint8Array
// Chromium encodes PNG, JPEG and WebP natively; BMP (24-bit) and GIF (89a, median-cut palette,
// LZW) are encoded here.

export const FORMATS = {
  png: { ext: '.png', mime: 'image/png', exts: ['.png'] },
  jpeg: { ext: '.jpg', mime: 'image/jpeg', exts: ['.jpg', '.jpeg', '.jpe', '.jfif'] },
  bmp: { ext: '.bmp', mime: 'image/bmp', exts: ['.bmp', '.dib'] },
  gif: { ext: '.gif', mime: 'image/gif', exts: ['.gif'] },
  webp: { ext: '.webp', mime: 'image/webp', exts: ['.webp'] },
};

export const OPEN_EXTS = ['.png', '.jpg', '.jpeg', '.jpe', '.jfif', '.bmp', '.dib', '.gif', '.webp', '.ico', '.avif'];

export function formatOf(path) {
  const ext = (/\.[^./]+$/.exec(String(path || ''))?.[0] || '').toLowerCase();
  for (const [k, f] of Object.entries(FORMATS)) if (f.exts.includes(ext)) return k;
  return null;
}

export async function decodeImage(bytes) {
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes]);
  try {
    return await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  } catch {
    // Some formats (e.g. SVG/ICO variants) only decode through an <img>.
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return await createImageBitmap(img);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

function toBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error(`Cannot encode ${type}`))), type, quality));
}

export function flatten(canvas, background = '#ffffff') {
  const c = document.createElement('canvas');
  c.width = canvas.width;
  c.height = canvas.height;
  const ctx = c.getContext('2d');
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(canvas, 0, 0);
  return c;
}

export async function encodeCanvas(canvas, fmt, { quality = 0.92 } = {}) {
  let out;
  if (fmt === 'jpeg') out = await toBlob(flatten(canvas), 'image/jpeg', quality);
  else if (fmt === 'webp') out = await toBlob(canvas, 'image/webp', quality);
  else if (fmt === 'bmp') {
    const f = flatten(canvas);
    return encodeBMP(f.getContext('2d').getImageData(0, 0, f.width, f.height));
  } else if (fmt === 'gif') return encodeGIF(canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height));
  else out = await toBlob(canvas, 'image/png');
  return new Uint8Array(await out.arrayBuffer());
}

// ---------------------------------------------------------------- BMP (24-bit, bottom-up)
export function encodeBMP(img) {
  const { width: w, height: h, data } = img;
  const row = Math.ceil((w * 3) / 4) * 4;
  const size = 54 + row * h;
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
  dv.setUint32(30, 0, true);
  dv.setUint32(34, row * h, true);
  dv.setInt32(38, 3780, true); // 96 DPI
  dv.setInt32(42, 3780, true);
  for (let y = 0; y < h; y++) {
    let o = 54 + (h - 1 - y) * row;
    let i = y * w * 4;
    for (let x = 0; x < w; x++, i += 4) {
      u8[o++] = data[i + 2];
      u8[o++] = data[i + 1];
      u8[o++] = data[i];
    }
  }
  return u8;
}

// ---------------------------------------------------------------- GIF
function quantize(data, maxColors) {
  const n = data.length / 4;
  const exact = new Map();
  for (let i = 0; i < n && exact.size <= maxColors; i++) {
    if (data[i * 4 + 3] < 128) continue;
    const key = (data[i * 4] << 16) | (data[i * 4 + 1] << 8) | data[i * 4 + 2];
    if (!exact.has(key)) exact.set(key, exact.size);
  }
  const index = new Uint8Array(n);
  if (exact.size <= maxColors) {
    const palette = [...exact.keys()].map((k) => [(k >> 16) & 255, (k >> 8) & 255, k & 255]);
    for (let i = 0; i < n; i++) {
      const key = (data[i * 4] << 16) | (data[i * 4 + 1] << 8) | data[i * 4 + 2];
      index[i] = exact.get(key) ?? 0;
    }
    return { palette, index };
  }
  // Median cut on a 5-5-5 histogram.
  const count = new Uint32Array(32768);
  const sum = new Float64Array(32768 * 3);
  const binOf = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    const bin = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    binOf[i] = bin;
    if (data[i * 4 + 3] < 128) continue;
    count[bin]++;
    sum[bin * 3] += r;
    sum[bin * 3 + 1] += g;
    sum[bin * 3 + 2] += b;
  }
  const used = [];
  for (let b = 0; b < 32768; b++) if (count[b]) used.push(b);
  const comp = (bin, c) => (c === 0 ? bin >> 10 : c === 1 ? (bin >> 5) & 31 : bin & 31);
  const boxInfo = (bins) => {
    let best = 0;
    let range = -1;
    let total = 0;
    for (let c = 0; c < 3; c++) {
      let lo = 31;
      let hi = 0;
      for (const b of bins) {
        const v = comp(b, c);
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      if (hi - lo > range) {
        range = hi - lo;
        best = c;
      }
    }
    for (const b of bins) total += count[b];
    return { bins, axis: best, range, total };
  };
  let boxes = [boxInfo(used)];
  while (boxes.length < maxColors) {
    let pick = -1;
    let score = 0;
    boxes.forEach((bx, i) => {
      const s = bx.range * Math.sqrt(bx.total);
      if (bx.bins.length > 1 && bx.range > 0 && s > score) {
        score = s;
        pick = i;
      }
    });
    if (pick < 0) break;
    const bx = boxes[pick];
    const sorted = [...bx.bins].sort((a, b) => comp(a, bx.axis) - comp(b, bx.axis));
    let acc = 0;
    let cut = 1;
    for (let i = 0; i < sorted.length - 1; i++) {
      acc += count[sorted[i]];
      if (acc >= bx.total / 2) {
        cut = i + 1;
        break;
      }
      cut = i + 1;
    }
    boxes.splice(pick, 1, boxInfo(sorted.slice(0, cut)), boxInfo(sorted.slice(cut)));
  }
  const palette = boxes.map((bx) => {
    let r = 0;
    let g = 0;
    let b = 0;
    let c = 0;
    for (const bin of bx.bins) {
      r += sum[bin * 3];
      g += sum[bin * 3 + 1];
      b += sum[bin * 3 + 2];
      c += count[bin];
    }
    return [Math.round(r / c), Math.round(g / c), Math.round(b / c)];
  });
  const map = new Int16Array(32768).fill(-1);
  const nearest = (bin) => {
    const r = (bin >> 10) * 8 + 4;
    const g = ((bin >> 5) & 31) * 8 + 4;
    const b = (bin & 31) * 8 + 4;
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < palette.length; i++) {
      const p = palette[i];
      const d = (p[0] - r) ** 2 * 3 + (p[1] - g) ** 2 * 4 + (p[2] - b) ** 2 * 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  };
  for (let i = 0; i < n; i++) {
    const bin = binOf[i];
    if (map[bin] < 0) map[bin] = nearest(bin);
    index[i] = map[bin];
  }
  return { palette, index };
}

function lzw(indices, minCodeSize, out) {
  const clearCode = 1 << minCodeSize;
  const eoi = clearCode + 1;
  let nextCode = eoi + 1;
  let codeSize = minCodeSize + 1;
  let table = new Map();
  let cur = 0;
  let shift = 0;
  const bytes = [];
  const emit = (code) => {
    cur |= code << shift;
    shift += codeSize;
    while (shift >= 8) {
      bytes.push(cur & 255);
      cur >>>= 8;
      shift -= 8;
    }
  };
  emit(clearCode);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = (prefix << 8) | k;
    const code = table.get(key);
    if (code !== undefined) {
      prefix = code;
      continue;
    }
    emit(prefix);
    if (nextCode === 4096) {
      emit(clearCode);
      nextCode = eoi + 1;
      codeSize = minCodeSize + 1;
      table = new Map();
    } else {
      if (nextCode >= 1 << codeSize) codeSize++;
      table.set(key, nextCode++);
    }
    prefix = k;
  }
  emit(prefix);
  emit(eoi);
  if (shift > 0) bytes.push(cur & 255);
  for (let i = 0; i < bytes.length; i += 255) {
    const chunk = bytes.slice(i, i + 255);
    out.push(chunk.length, ...chunk);
  }
  out.push(0);
}

export function encodeGIF(img) {
  const { width: w, height: h, data } = img;
  let transparent = false;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 128) {
      transparent = true;
      break;
    }
  }
  const { palette, index } = quantize(data, transparent ? 255 : 256);
  let tIndex = -1;
  if (transparent) {
    tIndex = palette.length;
    palette.push([0, 0, 0]);
    for (let i = 0; i < w * h; i++) if (data[i * 4 + 3] < 128) index[i] = tIndex;
  }
  let bits = 1;
  while (1 << bits < palette.length) bits++;
  const tableSize = 1 << bits;
  const out = [];
  const u16 = (v) => out.push(v & 255, (v >> 8) & 255);
  out.push(...[...'GIF89a'].map((c) => c.charCodeAt(0)));
  u16(w);
  u16(h);
  out.push(0x80 | ((bits - 1) << 4) | (bits - 1), 0, 0);
  for (let i = 0; i < tableSize; i++) {
    const p = palette[i] || [0, 0, 0];
    out.push(p[0], p[1], p[2]);
  }
  if (transparent) out.push(0x21, 0xf9, 0x04, 0x01, 0, 0, tIndex, 0);
  out.push(0x2c);
  u16(0);
  u16(0);
  u16(w);
  u16(h);
  out.push(0);
  const minCode = Math.max(2, bits);
  out.push(minCode);
  // Build in chunks to avoid huge spread arguments.
  const body = [];
  lzw(index, minCode, body);
  const head = Uint8Array.from(out);
  const res = new Uint8Array(head.length + body.length + 1);
  res.set(head, 0);
  res.set(body, head.length);
  res[res.length - 1] = 0x3b;
  return res;
}
