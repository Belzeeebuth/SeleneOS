// Server-side RFB encoders for the Remote Desktop tests (test/remote-extra.test.mjs): they produce the bytes a VNC
// server would send, so the app's decoders (renderer/apps/remote/lib/rfb.js) can be checked pixel by pixel.
// Pixel format: the one the client asks for (32 bpp, little-endian, R G B X), so CPIXEL / TPIXEL = R G B.
// Images: { w, h, px: Uint8Array RGBA (alpha ignored) }.
import zlib from 'node:zlib';

export const ENC = { RAW: 0, COPYRECT: 1, HEXTILE: 5, TIGHT: 7, ZRLE: 16, DESKTOPSIZE: -223, LASTRECT: -224, CURSOR: -239 };

export function image(w, h, fn) {
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b] = fn(x, y);
      px.set([r, g, b, 255], (y * w + x) * 4);
    }
  return { w, h, px };
}
/** Deterministic test picture: smooth gradient, 2-colour "text" stripes, a few-colour area, noise, solid blocks. */
export function testPattern(w, h, seed = 1) {
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) >>> 16) & 255;
  const noise = Array.from({ length: w * h }, () => [rnd(), rnd(), rnd()]);
  return image(w, h, (x, y) => {
    const zone = Math.floor((x / w) * 5);
    if (y < 6) return [20, 30, 40];
    if (zone === 0) return [Math.round((x * 255) / w), Math.round((y * 255) / h), 128];
    if (zone === 1) return (x + (y >> 1)) % 7 < 2 ? [250, 250, 250] : [10, 60, 160];
    if (zone === 2) return [[200, 40, 40], [40, 200, 40], [40, 40, 200], [220, 220, 30], [30, 220, 220]][((x >> 2) + (y >> 3)) % 5];
    if (zone === 3) return noise[y * w + x];
    return y % 20 < 10 ? [90, 90, 90] : [240, 120, 0];
  });
}
export function crop(img, x0, y0, w, h) {
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) px.set(img.px.subarray(((y0 + y) * img.w + x0) * 4, ((y0 + y) * img.w + x0 + w) * 4), y * w * 4);
  return { w, h, px };
}
const rgbAt = (img, x, y) => {
  const o = (y * img.w + x) * 4;
  return [img.px[o], img.px[o + 1], img.px[o + 2]];
};
const key = (c) => (c[0] << 16) | (c[1] << 8) | c[2];

export function rectHeader(x, y, w, h, enc) {
  const b = Buffer.alloc(12);
  b.writeUInt16BE(x, 0);
  b.writeUInt16BE(y, 2);
  b.writeUInt16BE(w, 4);
  b.writeUInt16BE(h, 6);
  b.writeInt32BE(enc, 8);
  return b;
}
export const updateHeader = (n) => Buffer.from([0, 0, n >> 8, n & 255]);
export const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};

export function raw(img) {
  const b = Buffer.alloc(img.w * img.h * 4);
  for (let i = 0; i < img.w * img.h; i++) b.set([img.px[i * 4], img.px[i * 4 + 1], img.px[i * 4 + 2], 0], i * 4);
  return b;
}
const pixel4 = (c) => [c[0], c[1], c[2], 0];

// ---------------------------------------------------------------- Hextile (raw, solid, mono subrects, coloured subrects)
export function hextile(img) {
  const out = [];
  let bg = null;
  let fg = null;
  for (let ty = 0; ty < img.h; ty += 16)
    for (let tx = 0; tx < img.w; tx += 16) {
      const tw = Math.min(16, img.w - tx);
      const th = Math.min(16, img.h - ty);
      const colours = new Map();
      for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) colours.set(key(rgbAt(img, tx + x, ty + y)), rgbAt(img, tx + x, ty + y));
      if (colours.size === 1) {
        const c = [...colours.values()][0];
        if (bg && key(bg) === key(c)) out.push(Buffer.from([0])); // same background as the previous tile
        else {
          out.push(Buffer.from([2, ...pixel4(c)]));
          bg = c;
        }
        continue;
      }
      // background = most frequent colour; subrects = horizontal runs of the other colours
      const count = new Map();
      for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) count.set(key(rgbAt(img, tx + x, ty + y)), (count.get(key(rgbAt(img, tx + x, ty + y))) || 0) + 1);
      const bgKey = [...count.entries()].sort((a, b) => b[1] - a[1])[0][0];
      const runs = [];
      for (let y = 0; y < th; y++)
        for (let x = 0; x < tw; ) {
          const c = rgbAt(img, tx + x, ty + y);
          let e = x + 1;
          while (e < tw && key(rgbAt(img, tx + e, ty + y)) === key(c)) e++;
          if (key(c) !== bgKey) runs.push({ x, y, w: e - x, c });
          x = e;
        }
      const mono = colours.size === 2;
      if (runs.length > 255 || runs.length * (mono ? 2 : 6) > tw * th * 4) {
        const b = [1];
        for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) b.push(...pixel4(rgbAt(img, tx + x, ty + y)));
        out.push(Buffer.from(b));
        bg = null; // undefined after a raw tile for strict servers: always send it again
        fg = null;
        continue;
      }
      const bgc = colours.get(bgKey);
      let sub = 8;
      const b = [0];
      if (!bg || key(bg) !== bgKey) {
        sub |= 2;
        b.push(...pixel4(bgc));
        bg = bgc;
      }
      if (mono) {
        const f = runs[0].c;
        if (!fg || key(fg) !== key(f)) {
          sub |= 4;
          b.push(...pixel4(f));
          fg = f;
        }
      } else sub |= 16;
      b.push(runs.length);
      for (const r of runs) {
        if (!mono) b.push(...pixel4(r.c));
        b.push((r.x << 4) | r.y, ((r.w - 1) << 4) | 0);
      }
      b[0] = sub;
      out.push(Buffer.from(b));
    }
  return Buffer.concat(out);
}

// ---------------------------------------------------------------- zlib stream kept across rectangles
export class Deflater {
  constructor(level = 6) {
    this.z = zlib.createDeflate({ level });
    this.chunks = [];
    this.z.on('data', (d) => this.chunks.push(d));
  }
  /** Next piece of the stream for `data`, ended with a sync flush (what VNC servers do per rectangle). */
  push(data) {
    return new Promise((resolve) => {
      this.z.write(data);
      this.z.flush(zlib.constants.Z_SYNC_FLUSH, () => {
        const out = Buffer.concat(this.chunks);
        this.chunks = [];
        resolve(out);
      });
    });
  }
}

// ---------------------------------------------------------------- ZRLE (raw, solid, packed palette, plain RLE, palette RLE)
function runLength(n) {
  const b = [];
  n -= 1;
  while (n >= 255) {
    b.push(255);
    n -= 255;
  }
  b.push(n);
  return b;
}
export async function zrle(img, deflater, { force = null } = {}) {
  const data = [];
  let tile = 0;
  for (let ty = 0; ty < img.h; ty += 64)
    for (let tx = 0; tx < img.w; tx += 64, tile++) {
      const tw = Math.min(64, img.w - tx);
      const th = Math.min(64, img.h - ty);
      const px = [];
      for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) px.push(rgbAt(img, tx + x, ty + y));
      const pal = [...new Map(px.map((c) => [key(c), c])).values()];
      const idx = new Map(pal.map((c, i) => [key(c), i]));
      let mode = force;
      if (!mode) {
        if (pal.length === 1) mode = 'solid';
        else if (pal.length <= 16) mode = tile % 2 ? 'packed' : 'prle';
        else if (pal.length <= 127) mode = 'prle';
        else mode = tile % 2 ? 'raw' : 'rle';
      }
      if (mode === 'solid') data.push(1, ...px[0]);
      else if (mode === 'raw') {
        data.push(0);
        for (const c of px) data.push(...c);
      } else if (mode === 'packed') {
        data.push(pal.length);
        for (const c of pal) data.push(...c);
        const bpp = pal.length === 2 ? 1 : pal.length <= 4 ? 2 : 4;
        for (let y = 0; y < th; y++) {
          let byte = 0;
          let bits = 0;
          for (let x = 0; x < tw; x++) {
            byte = (byte << bpp) | idx.get(key(px[y * tw + x]));
            bits += bpp;
            if (bits === 8) {
              data.push(byte);
              byte = 0;
              bits = 0;
            }
          }
          if (bits) data.push(byte << (8 - bits));
        }
      } else {
        const runs = [];
        for (let i = 0; i < px.length; ) {
          let e = i + 1;
          while (e < px.length && key(px[e]) === key(px[i])) e++;
          runs.push([px[i], e - i]);
          i = e;
        }
        if (mode === 'rle') {
          data.push(128);
          for (const [c, n] of runs) data.push(...c, ...runLength(n));
        } else {
          data.push(128 + pal.length);
          for (const c of pal) data.push(...c);
          for (const [c, n] of runs) {
            if (n === 1) data.push(idx.get(key(c)));
            else data.push(idx.get(key(c)) | 128, ...runLength(n));
          }
        }
      }
    }
  const z = await deflater.push(Buffer.from(data));
  return Buffer.concat([u32(z.length), z]);
}

// ---------------------------------------------------------------- Tight
function compactLen(n) {
  const b = [n & 0x7f];
  if (n > 0x7f) {
    b[0] |= 0x80;
    b.push((n >> 7) & 0x7f);
    if (n > 0x3fff) {
      b[1] |= 0x80;
      b.push((n >> 14) & 0xff);
    }
  }
  return b;
}
/**
 * kind: 'fill' | 'copy' (no filter) | 'mono' (2-colour palette) | 'palette' | 'gradient' | 'jpeg' (opts.jpeg bytes).
 * streams: [Deflater x4] (index = Tight stream id); opts.reset: bitmask of streams to reset (the deflater is renewed).
 */
export async function tight(img, kind, streams, opts = {}) {
  let reset = opts.reset || 0;
  for (let i = 0; i < 4; i++) if (reset & (1 << i)) streams[i] = new Deflater();
  const px = [];
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) px.push(rgbAt(img, x, y));
  if (kind === 'fill') return Buffer.from([0x80 | reset, ...px[0]]);
  if (kind === 'jpeg') return Buffer.concat([Buffer.from([0x90 | reset, ...compactLen(opts.jpeg.length)]), Buffer.from(opts.jpeg)]);
  let stream = 0;
  let head = [];
  let data;
  if (kind === 'copy') {
    stream = 0;
    head = [(stream << 4) | reset];
    data = Buffer.from(px.flat());
  } else if (kind === 'mono' || kind === 'palette') {
    stream = kind === 'mono' ? 1 : 2;
    const pal = [...new Map(px.map((c) => [key(c), c])).values()];
    if (kind === 'mono' && pal.length !== 2) throw new Error('mono needs 2 colours');
    const idx = new Map(pal.map((c, i) => [key(c), i]));
    head = [0x40 | (stream << 4) | reset, 1, pal.length - 1, ...pal.flat()];
    if (pal.length === 2) {
      const stride = (img.w + 7) >> 3;
      data = Buffer.alloc(stride * img.h);
      for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) if (idx.get(key(px[y * img.w + x]))) data[y * stride + (x >> 3)] |= 0x80 >> (x & 7);
    } else data = Buffer.from(px.map((c) => idx.get(key(c))));
  } else if (kind === 'gradient') {
    stream = 3;
    head = [0x40 | (stream << 4) | reset, 2];
    data = Buffer.alloc(img.w * img.h * 3);
    for (let y = 0; y < img.h; y++)
      for (let x = 0; x < img.w; x++)
        for (let c = 0; c < 3; c++) {
          const v = (xx, yy) => (xx < 0 || yy < 0 ? 0 : px[yy * img.w + xx][c]);
          const pred = Math.max(0, Math.min(255, v(x - 1, y) + v(x, y - 1) - v(x - 1, y - 1)));
          data[(y * img.w + x) * 3 + c] = (px[y * img.w + x][c] - pred) & 255;
        }
  } else throw new Error(`unknown tight kind ${kind}`);
  if (data.length < 12) return Buffer.concat([Buffer.from(head), data]); // short data is sent as is
  const z = await streams[stream].push(data);
  return Buffer.concat([Buffer.from(head), Buffer.from(compactLen(z.length)), z]);
}

/** Cursor pseudo-encoding body: pixels + 1-bit mask (rows padded to a byte). */
export function cursor(img, maskFn) {
  const stride = (img.w + 7) >> 3;
  const mask = Buffer.alloc(stride * img.h);
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) if (maskFn(x, y)) mask[y * stride + (x >> 3)] |= 0x80 >> (x & 7);
  return Buffer.concat([raw(img), mask]);
}

/** Apply an RfbClient's callbacks to a plain framebuffer (Node side of the tests). */
export function framebuffer(w, h) {
  const fb = { w, h, px: new Uint8Array(w * h * 4) };
  fb.raw = (x, y, rw, rh, px) => {
    for (let yy = 0; yy < rh; yy++) fb.px.set(px.subarray(yy * rw * 4, (yy + 1) * rw * 4), ((y + yy) * fb.w + x) * 4);
  };
  fb.copy = (sx, sy, x, y, rw, rh) => {
    const src = crop(fb, sx, sy, rw, rh);
    fb.raw(x, y, rw, rh, src.px);
  };
  return fb;
}
/** Number of pixels whose RGB differ by more than tol (alpha ignored). */
export function diff(a, b, tol = 0) {
  if (a.w !== b.w || a.h !== b.h) return Infinity;
  let n = 0;
  for (let i = 0; i < a.w * a.h; i++)
    for (let c = 0; c < 3; c++)
      if (Math.abs(a.px[i * 4 + c] - b.px[i * 4 + c]) > tol) {
        n++;
        break;
      }
  return n;
}
