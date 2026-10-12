// Functional tests for the Photos app (renderer/apps/photos + main/ipc/photos.js).
// Run: cd aurora-os/shell && xvfb-run -a -s "-screen 0 1600x900x24" node test/photos.test.mjs [--only=<name part>] [--keep]
//
// 1. Unit tests (plain Node): justified layout, zoom math, EXIF orientation table, header parsers.
// 2. Shell tests: the real Electron shell with ~40 generated pictures (PNG, JPEG with EXIF orientation /
//    date / camera, GIF animation, SVG, WebP, BMP) in the throwaway $HOME — gallery grouping, thumbnails
//    (memory + disk cache), viewer (args, next/prev, zoom/pan, info), rotate, editor (crop, rotate, adjustments,
//    save as copy), favorites/albums persistence, delete to trash, set as wallpaper, slideshow, search,
//    EN/FR, light/dark, small/maximized windows, and a 1000-picture performance run.
// Screenshots: test/out/photos-*.png and docs/screenshots/photos-*.png.
import { launchShell, OUT } from './lib.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(here, '..', 'renderer', 'apps', 'photos');
const DOCS = path.join(here, '..', '..', 'docs', 'screenshots');
fs.mkdirSync(DOCS, { recursive: true });
const ONLY = process.argv.find((a) => a.startsWith('--only='))?.slice(7);
const KEEP = process.argv.includes('--keep');

const results = [];
let current = null;
async function test(name, fn) {
  if (ONLY && !new RegExp(ONLY, 'i').test(name)) return;
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name} (${Date.now() - t0} ms)`);
  } catch (err) {
    results.push({ name, ok: false, err });
    const where =
      String(err?.stack || '')
        .split('\n')
        .find((l) => l.includes('photos.test.mjs')) || '';
    console.log(`FAIL  ${name}\n      ${String(err?.message || err).split('\n').slice(0, 24).join('\n      ')}\n      ${where.trim()}`);
    if (current) {
      await current.page.keyboard.press('Escape').catch(() => {});
      await current.page.evaluate(() => document.querySelectorAll('.menu, .dialog-layer').forEach((e) => e.remove())).catch(() => {});
    }
  }
}

async function load(rel) {
  const src = fs.readFileSync(path.join(APP, rel), 'utf8');
  return import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);
}

// ------------------------------------------------------------------ fixtures (pure Node encoders)
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = t[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
})();

/** Procedural "landscape": sky gradient, sun, two hills. hue shifts the palette. */
function paint(w, h, seed = 0) {
  const px = Buffer.alloc(w * h * 3);
  const hue = (seed * 47) % 360;
  const hsl = (H, S, L) => {
    const a = S * Math.min(L, 1 - L);
    const f = (n) => {
      const k = (n + H / 30) % 12;
      return L - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    };
    return [f(0) * 255, f(8) * 255, f(4) * 255];
  };
  const top = hsl(hue, 0.7, 0.72);
  const bot = hsl((hue + 30) % 360, 0.65, 0.45);
  const hillA = hsl((hue + 120) % 360, 0.45, 0.42);
  const hillB = hsl((hue + 150) % 360, 0.5, 0.28);
  const sx = w * (0.25 + ((seed * 13) % 50) / 100);
  const sy = h * 0.3;
  const sr = Math.min(w, h) * 0.09;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = y / h;
      let c = [top[0] + (bot[0] - top[0]) * t, top[1] + (bot[1] - top[1]) * t, top[2] + (bot[2] - top[2]) * t];
      if ((x - sx) ** 2 + (y - sy) ** 2 < sr * sr) c = [255, 226, 120];
      const h1 = h * (0.62 + 0.08 * Math.sin((x / w) * 6.28 + seed));
      const h2 = h * (0.78 + 0.06 * Math.sin((x / w) * 9.4 + seed * 2));
      if (y > h1) c = hillA;
      if (y > h2) c = hillB;
      const i = (y * w + x) * 3;
      px[i] = c[0];
      px[i + 1] = c[1];
      px[i + 2] = c[2];
    }
  }
  return px;
}

function pngFromRGB(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(CRC(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 3 })), chunk('IEND', Buffer.alloc(0))]);
}
const png = (w, h, seed) => pngFromRGB(w, h, paint(w, h, seed));
function solidPng(w, h, [r, g, b]) {
  const px = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    px[i * 3] = r;
    px[i * 3 + 1] = g;
    px[i * 3 + 2] = b;
  }
  return pngFromRGB(w, h, px);
}

function bmp(w, h, seed) {
  const rgb = paint(w, h, seed);
  const row = Math.ceil((w * 3) / 4) * 4;
  const buf = Buffer.alloc(54 + row * h);
  buf.write('BM', 0, 'latin1');
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(w, 18);
  buf.writeInt32LE(h, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 3;
      const d = 54 + (h - 1 - y) * row + x * 3;
      buf[d] = rgb[s + 2];
      buf[d + 1] = rgb[s + 1];
      buf[d + 2] = rgb[s];
    }
  return buf;
}

/** Animated GIF (6x6x6 palette, uncompressed LZW stream: a clear code every 254 pixels). */
function gif(w, h, frames = 3) {
  const pal = Buffer.alloc(256 * 3);
  for (let i = 0; i < 216; i++) {
    pal[i * 3] = Math.floor(i / 36) * 51;
    pal[i * 3 + 1] = (Math.floor(i / 6) % 6) * 51;
    pal[i * 3 + 2] = (i % 6) * 51;
  }
  const parts = [Buffer.from('GIF89a', 'latin1')];
  const lsd = Buffer.alloc(7);
  lsd.writeUInt16LE(w, 0);
  lsd.writeUInt16LE(h, 2);
  lsd[4] = 0xf7;
  parts.push(lsd, pal);
  parts.push(Buffer.from([0x21, 0xff, 0x0b]), Buffer.from('NETSCAPE2.0', 'latin1'), Buffer.from([3, 1, 0, 0, 0]));
  for (let f = 0; f < frames; f++) {
    const rgb = paint(w, h, f * 3 + 1);
    const idx = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) idx[i] = Math.round(rgb[i * 3] / 51) * 36 + Math.round(rgb[i * 3 + 1] / 51) * 6 + Math.round(rgb[i * 3 + 2] / 51);
    parts.push(Buffer.from([0x21, 0xf9, 4, 0, 30, 0, 0, 0]));
    const id = Buffer.alloc(10);
    id[0] = 0x2c;
    id.writeUInt16LE(w, 5);
    id.writeUInt16LE(h, 7);
    parts.push(id);
    const codes = [256];
    for (let i = 0; i < idx.length; i++) {
      if (i && i % 254 === 0) codes.push(256);
      codes.push(idx[i]);
    }
    codes.push(257);
    const bytes = [];
    let acc = 0;
    let n = 0;
    for (const c of codes) {
      acc |= c << n;
      n += 9;
      while (n >= 8) {
        bytes.push(acc & 0xff);
        acc >>>= 8;
        n -= 8;
      }
    }
    if (n) bytes.push(acc & 0xff);
    const data = [8];
    for (let i = 0; i < bytes.length; i += 255) {
      const sub = bytes.slice(i, i + 255);
      data.push(sub.length, ...sub);
    }
    data.push(0);
    parts.push(Buffer.from(data));
  }
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}

const svg = (seed) =>
  Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480" viewBox="0 0 640 480"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(${seed * 40},80%,70%)"/><stop offset="1" stop-color="hsl(${seed * 40 + 40},70%,40%)"/></linearGradient></defs><rect width="640" height="480" fill="url(#g)"/><circle cx="420" cy="150" r="60" fill="#ffd75e"/><path d="M0 360 L180 220 L340 360 L460 260 L640 380 V480 H0Z" fill="#1f6e5a"/><script>alert(1)</script></svg>`);

/** EXIF APP1 (big-endian): Orientation, Make, Model, DateTimeOriginal, FNumber, ExposureTime, ISO. */
function exifApp1({ orientation = 1, make, model, date, fnumber, exposure, iso } = {}) {
  const ifd0 = [];
  const exif = [];
  ifd0.push({ tag: 0x0112, type: 3, value: orientation });
  if (make) ifd0.push({ tag: 0x010f, type: 2, value: make });
  if (model) ifd0.push({ tag: 0x0110, type: 2, value: model });
  if (date) exif.push({ tag: 0x9003, type: 2, value: date });
  if (fnumber) exif.push({ tag: 0x829d, type: 5, value: [fnumber * 10, 10] });
  if (exposure) exif.push({ tag: 0x829a, type: 5, value: [1, Math.round(1 / exposure)] });
  if (iso) exif.push({ tag: 0x8827, type: 3, value: iso });
  ifd0.push({ tag: 0x8769, type: 4, value: 0 }); // patched below
  ifd0.sort((a, b) => a.tag - b.tag);
  exif.sort((a, b) => a.tag - b.tag);
  const ifdSize = (n) => 2 + n * 12 + 4;
  const ifd0Off = 8;
  const exifOff = ifd0Off + ifdSize(ifd0.length);
  let dataOff = exifOff + ifdSize(exif.length);
  const data = [];
  const write = (entries, at, buf) => {
    buf.writeUInt16BE(entries.length, at);
    entries.forEach((e, i) => {
      const o = at + 2 + i * 12;
      buf.writeUInt16BE(e.tag, o);
      buf.writeUInt16BE(e.type, o + 2);
      if (e.type === 2) {
        const s = Buffer.from(`${e.value}\0`, 'latin1');
        buf.writeUInt32BE(s.length, o + 4);
        if (s.length <= 4) s.copy(buf, o + 8);
        else {
          buf.writeUInt32BE(dataOff, o + 8);
          data.push({ off: dataOff, b: s });
          dataOff += s.length + (s.length % 2);
        }
      } else if (e.type === 3) {
        buf.writeUInt32BE(1, o + 4);
        buf.writeUInt16BE(e.value, o + 8);
      } else if (e.type === 4) {
        buf.writeUInt32BE(1, o + 4);
        buf.writeUInt32BE(e.tag === 0x8769 ? exifOff : e.value, o + 8);
      } else if (e.type === 5) {
        buf.writeUInt32BE(1, o + 4);
        buf.writeUInt32BE(dataOff, o + 8);
        const b = Buffer.alloc(8);
        b.writeUInt32BE(e.value[0], 0);
        b.writeUInt32BE(e.value[1], 4);
        data.push({ off: dataOff, b });
        dataOff += 8;
      }
    });
    buf.writeUInt32BE(0, at + 2 + entries.length * 12);
  };
  const tiff = Buffer.alloc(4096);
  tiff.write('MM', 0, 'latin1');
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(ifd0Off, 4);
  write(ifd0, ifd0Off, tiff);
  write(exif, exifOff, tiff);
  for (const d of data) d.b.copy(tiff, d.off);
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff.subarray(0, dataOff)]);
  const head = Buffer.from([0xff, 0xe1, 0, 0]);
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([head, body]);
}
function withExif(jpeg, opts) {
  let at = 2;
  if (jpeg[2] === 0xff && jpeg[3] === 0xe0) at = 4 + jpeg.readUInt16BE(4);
  return Buffer.concat([jpeg.subarray(0, at), exifApp1(opts), jpeg.subarray(at)]);
}

const MONTH_MS = 30.5 * 86400000;
const NOW = Date.now();
function setTime(file, ms) {
  fs.utimesSync(file, ms / 1000, ms / 1000);
}

/** Write the ~40 fixture pictures (JPEGs are encoded by the shell's canvas, then get EXIF in Node). */
async function makeFixtures(home, s) {
  const pics = path.join(home, 'Pictures');
  const trips = path.join(pics, 'Trips');
  const screens = path.join(pics, 'Screenshots');
  fs.mkdirSync(trips, { recursive: true });
  fs.mkdirSync(screens, { recursive: true });
  const sizes = [
    [800, 600], [600, 800], [1200, 400], [500, 500], [960, 640], [640, 960], [1024, 576], [720, 540],
    [400, 600], [900, 600], [1280, 720], [480, 640], [1000, 750], [600, 450], [300, 900], [800, 800],
  ];
  const files = [];
  // 24 PNGs over ~5 months, spread over three folders.
  for (let i = 0; i < 24; i++) {
    const [w, h] = sizes[i % sizes.length];
    const dir = i % 5 === 0 ? trips : i % 7 === 0 ? screens : pics;
    const p = path.join(dir, `photo-${String(i + 1).padStart(2, '0')}.png`);
    fs.writeFileSync(p, png(Math.round(w / 2), Math.round(h / 2), i));
    setTime(p, NOW - Math.floor(i / 5) * MONTH_MS - i * 3600000);
    files.push(p);
  }
  // JPEGs from the shell canvas (real JPEG encoder), EXIF injected here.
  const jpegs = await s.page.evaluate(async () => {
    const out = [];
    const specs = [
      [1200, 800, 0], [800, 1200, 1], [1600, 900, 2], [1000, 1000, 3], [1400, 700, 4], [900, 1200, 5], [1200, 900, 6], [1024, 768, 7],
    ];
    for (const [w, h, k] of specs) {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d');
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, `hsl(${k * 45},70%,72%)`);
      g.addColorStop(1, `hsl(${k * 45 + 40},60%,38%)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#ffd75e';
      ctx.beginPath();
      ctx.arc(w * 0.7, h * 0.3, Math.min(w, h) * 0.1, 0, 7);
      ctx.fill();
      // A red marker in the top-left corner (orientation checks).
      ctx.fillStyle = '#ff0000';
      ctx.fillRect(0, 0, Math.round(w * 0.2), Math.round(h * 0.2));
      ctx.fillStyle = '#1f6e5a';
      ctx.beginPath();
      ctx.moveTo(0, h * 0.75);
      ctx.lineTo(w * 0.35, h * 0.5);
      ctx.lineTo(w * 0.65, h * 0.72);
      ctx.lineTo(w, h * 0.55);
      ctx.lineTo(w, h);
      ctx.lineTo(0, h);
      ctx.fill();
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
      const b = new Uint8Array(await blob.arrayBuffer());
      let bin = '';
      for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000));
      out.push(btoa(bin));
    }
    return out;
  });
  jpegs.forEach((b64, i) => {
    const raw = Buffer.from(b64, 'base64');
    const p = path.join(i < 3 ? trips : pics, `IMG_${2000 + i}.jpg`);
    let data = raw;
    if (i === 0) data = withExif(raw, { orientation: 6, make: 'Contoso', model: 'Contoso Z9', date: '2024:07:14 18:30:05', fnumber: 2.8, exposure: 1 / 250, iso: 200 });
    else if (i === 1) data = withExif(raw, { orientation: 1, make: 'Fabrikam', model: 'Fabrikam X100', date: '2024:07:15 09:12:00', fnumber: 4, exposure: 1 / 60, iso: 400 });
    else if (i === 2) data = withExif(raw, { orientation: 1, date: '2023:12:24 20:00:00' });
    fs.writeFileSync(p, data);
    setTime(p, NOW - (i % 4) * MONTH_MS - i * 7200000);
    files.push(p);
  });
  // Other formats.
  const other = [
    ['animation.gif', gif(160, 120, 3)],
    ['vector.svg', svg(2)],
    ['bitmap.bmp', bmp(240, 160, 9)],
    ['solid-gray.png', solidPng(200, 100, [100, 100, 100])],
    ['pano.png', png(1200, 240, 11)],
    ['tall.png', png(200, 700, 12)],
  ];
  for (const [n, buf] of other) {
    const p = path.join(pics, n);
    fs.writeFileSync(p, buf);
    setTime(p, NOW - 2 * 86400000);
    files.push(p);
  }
  // A WebP made by the shell canvas.
  const webp = await s.page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 640;
    c.height = 400;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#3a7bd5';
    ctx.fillRect(0, 0, 640, 400);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(100, 100, 200, 100);
    const blob = await new Promise((r) => c.toBlob(r, 'image/webp', 0.9));
    const b = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
    return btoa(bin);
  });
  const wp = path.join(pics, 'web-image.webp');
  fs.writeFileSync(wp, Buffer.from(webp, 'base64'));
  setTime(wp, NOW - 3 * 86400000);
  files.push(wp);
  // A damaged picture: valid JPEG start marker, garbage after it.
  const bad = path.join(screens, 'zz-corrupt.jpg');
  fs.writeFileSync(bad, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]), Buffer.alloc(400, 0x5a)]));
  setTime(bad, NOW - 20 * 86400000);
  files.push(bad);
  // Hidden folder and non-image files are ignored.
  fs.mkdirSync(path.join(pics, '.hidden'), { recursive: true });
  fs.writeFileSync(path.join(pics, '.hidden', 'secret.png'), png(50, 50, 1));
  fs.writeFileSync(path.join(pics, 'notes.txt'), 'not an image');
  return files;
}

// ------------------------------------------------------------------ helpers
const photosWin = (s) => s.page.locator('.win.app-photos').last();
async function waitTiles(s, min = 1) {
  await s.page.waitForFunction((n) => document.querySelectorAll('.app-photos .ph-tile').length >= n, min, { timeout: 30000 });
}
async function waitThumbsLoaded(s, timeout = 30000) {
  await s.page.waitForFunction(
    () => {
      const tiles = [...document.querySelectorAll('.app-photos .ph-gallery:not([hidden]) .ph-tile')].filter((t) => {
        const r = t.getBoundingClientRect();
        const sc = t.closest('.ph-scroll').getBoundingClientRect();
        return r.bottom > sc.top && r.top < sc.bottom;
      });
      return tiles.length > 0 && tiles.every((t) => t.classList.contains('loaded') || t.classList.contains('broken'));
    },
    null,
    { timeout },
  );
}
const appEval = (fn, arg) => s.page.evaluate(([src, a]) => new Function('a', 'arg', `return (${src})(a, arg)`)([...document.querySelectorAll('.win.app-photos')].pop().__photos, a), [fn.toString(), arg]);
const app = (s) => s.page.evaluateHandle(() => [...document.querySelectorAll('.win.app-photos')].pop().__photos);
async function launchPhotos(s, args) {
  await s.aurora((a) => window.__aurora.registry.launch('photos', a || {}), args || null);
  await s.page.waitForFunction(() => [...document.querySelectorAll('.win.app-photos')].pop()?.__photos?.mode, null, { timeout: 20000 });
}
async function closePhotos(s) {
  await s.aurora(async () => {
    for (const w of window.__aurora.wm.byApp('photos')) await w.close(true);
  });
  await s.page.waitForFunction(() => !document.querySelector('.win.app-photos') && !window.__aurora.wm.byApp('photos').length, null, { timeout: 15000 });
}
async function docShot(s, name) {
  const f = await s.shot(`photos-${name}`);
  fs.copyFileSync(f, path.join(DOCS, `photos-${name}.png`));
  return f;
}
async function pixelOf(s, file, x, y) {
  return s.page.evaluate(
    async ({ url, x, y }) => {
      const blob = await (await fetch(url)).blob();
      const bmp = await createImageBitmap(blob);
      const c = document.createElement('canvas');
      c.width = bmp.width;
      c.height = bmp.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(bmp, 0, 0);
      const d = ctx.getImageData(Math.round(x * (c.width - 1)), Math.round(y * (c.height - 1)), 1, 1).data;
      return { w: c.width, h: c.height, rgb: [d[0], d[1], d[2]] };
    },
    { url: `media://local${file.split('/').map(encodeURIComponent).join('/')}?t=${Date.now()}`, x, y },
  );
}
function consoleErrors(s) {
  return s.logs.filter((l) => (l.startsWith('[error]') || l.startsWith('[pageerror]')) && !/favicon|ERR_FILE_NOT_FOUND|icon\.svg/.test(l));
}

// ================================================================== unit tests
await test('unit: justified layout fills rows exactly and keeps aspect ratios', async () => {
  const { justify, squares, findBlock, safeAspect } = await load('lib/layout.js');
  const aspects = [1.5, 0.75, 1.33, 1, 2, 0.5, 1.5, 1.5, 3, 1, 1, 0.8];
  const L = justify(aspects, 1000, { rowHeight: 200, gap: 4 });
  assert.ok(L.rows.length >= 3);
  for (const row of L.rows.slice(0, -1)) {
    const last = row.cells.at(-1);
    assert.equal(last.x + last.w, 1000, 'full rows end at the right edge');
    for (const c of row.cells) assert.ok(Math.abs(c.w / row.h - aspects[c.i]) < 0.08 || c === last, `cell ${c.i} keeps its aspect`);
  }
  const lastRow = L.rows.at(-1);
  assert.ok(lastRow.h <= 200);
  const covered = L.rows.flatMap((r) => r.cells.map((c) => c.i));
  assert.deepEqual(covered, aspects.map((_, i) => i));
  const S = squares(7, 500, { size: 150, gap: 4 });
  assert.equal(S.rows.length, 3);
  assert.equal(S.rows[0].cells.length, 3);
  assert.equal(findBlock([0, 10, 20, 30], 25), 2);
  assert.equal(safeAspect(100, 1), 4);
  assert.equal(safeAspect(0, 0), 1);
});

await test('unit: zoom math keeps the point under the cursor fixed', async () => {
  const Z = await load('lib/zoom.js');
  assert.equal(Z.fitScale(4000, 3000, 1000, 600), 0.2);
  assert.equal(Z.fitScale(200, 100, 1000, 600), 1, 'small images are not enlarged');
  const st = { s: 0.5, tx: 100, ty: 50 };
  const before = Z.toImage(st, 400, 300);
  const z2 = Z.zoomAt(st, 2, 400, 300);
  const after = Z.toImage(z2, 400, 300);
  assert.ok(Math.abs(before.x - after.x) < 1e-9 && Math.abs(before.y - after.y) < 1e-9);
  const c = Z.clampPan({ s: 1, tx: 500, ty: -9000 }, 2000, 1000, 800, 600);
  assert.equal(c.tx, 0);
  assert.equal(c.ty, -400);
  const small = Z.clampPan({ s: 1, tx: 0, ty: 0 }, 200, 100, 800, 600);
  assert.deepEqual([small.tx, small.ty], [300, 250], 'small image is centered');
  assert.equal(Z.stepZoom(1, 1, 0.3), 1.25);
  assert.equal(Z.stepZoom(1, -1, 0.3), 0.75);
  const v = Z.scaleToSlider(2, 0.05);
  assert.ok(Math.abs(Z.sliderToScale(v, 0.05) - 2) < 1e-9);
});

await test('unit: EXIF orientation table and header parsers', async () => {
  const B = require('../main/ipc/photos.js');
  // Four clockwise turns are the identity; CW then CCW too.
  for (let o = 1; o <= 8; o++) {
    let x = o;
    for (let i = 0; i < 4; i++) x = B.ROT_CW[x];
    assert.equal(x, o);
    assert.equal(B.ROT_CCW[B.ROT_CW[o]], o);
  }
  assert.equal(B.ROT_CW[1], 6);
  assert.equal(B.ROT_CW[6], 3);
  const ex = exifApp1({ orientation: 6, make: 'Contoso', model: 'Z9', date: '2024:07:14 18:30:05', fnumber: 2.8, exposure: 1 / 250, iso: 200 });
  const parsed = B.parseExif(ex.subarray(4), 6, true);
  assert.equal(parsed.o, 6);
  assert.equal(parsed.make, 'Contoso');
  assert.equal(parsed.model, 'Z9');
  assert.equal(parsed.iso, 200);
  assert.ok(Math.abs(parsed.fnumber - 2.8) < 1e-6);
  assert.equal(new Date(parsed.taken).getFullYear(), 2024);
  assert.deepEqual(B.svgInfo(Buffer.from('<svg viewBox="0 0 200 100">')), { w: 200, h: 100 });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-unit-'));
  const p = path.join(tmp, 'a.png');
  fs.writeFileSync(p, png(30, 20, 1));
  assert.deepEqual((await B.imageInfo(p, '.png')).w, 30);
  fs.writeFileSync(path.join(tmp, 'b.gif'), gif(16, 12, 2));
  assert.equal((await B.imageInfo(path.join(tmp, 'b.gif'), '.gif')).h, 12);
  fs.writeFileSync(path.join(tmp, 'c.bmp'), bmp(20, 10, 1));
  assert.equal((await B.imageInfo(path.join(tmp, 'c.bmp'), '.bmp')).w, 20);
  fs.rmSync(tmp, { recursive: true, force: true });
});

await test('unit: a malformed EXIF orientation tag is never trusted for an in-place rewrite', async () => {
  const B = require('../main/ipc/photos.js');
  const ex = exifApp1({ orientation: 6 });
  const tiff = Buffer.from(ex.subarray(10)); // after APP1 header + "Exif\0\0"
  // Find the orientation entry (tag 0x0112) and make its count 2: its "value" would then live elsewhere.
  const n = tiff.readUInt16BE(8);
  let entry = -1;
  for (let i = 0; i < n; i++) if (tiff.readUInt16BE(10 + i * 12) === 0x0112) entry = 10 + i * 12;
  assert.ok(entry > 0);
  assert.equal(B.parseExif(tiff, 0).oOffset, entry + 8, 'well-formed tag: rewritable inline value');
  tiff.writeUInt32BE(2, entry + 4);
  const bad = B.parseExif(tiff, 0);
  assert.equal(bad.oOffset, null, 'count != 1: not rewritable');
  assert.equal(bad.o, 1);
  tiff.writeUInt32BE(1, entry + 4);
  tiff.writeUInt16BE(4, entry + 2); // LONG instead of SHORT
  assert.equal(B.parseExif(tiff, 0).oOffset, null, 'wrong type: not rewritable');
});

// ================================================================== shell tests
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-photos-'));
let s = await launchShell({ home, keepHome: true, theme: 'light', lang: 'en' });
current = s;
const files = await makeFixtures(home, s);
console.log(`fixtures: ${files.length} pictures in ${home}/Pictures`);

await test('gallery: scans Pictures recursively, groups by month, loads thumbnails', async () => {
  await launchPhotos(s);
  await waitTiles(s, 10);
  await waitThumbsLoaded(s);
  const info = await s.page.evaluate(() => {
    const a = [...document.querySelectorAll('.win.app-photos')].pop().__photos;
    return {
      items: a.lib.items.length,
      names: a.lib.items.map((i) => i.name),
      groups: a.gallery.grid.groups.map((g) => g.label),
      headers: [...document.querySelectorAll('.app-photos .ph-ghead-label')].map((e) => e.textContent),
      title: document.querySelector('.app-photos .ph-title').textContent,
    };
  });
  assert.equal(info.items, files.length, `all ${files.length} pictures found (hidden folder & .txt skipped)`);
  assert.ok(!info.names.includes('secret.png'));
  assert.ok(info.groups.length >= 4, `several month groups: ${info.groups.join(', ')}`);
  assert.match(info.groups[0], /^[A-Z][a-z]+ \d{4}$/, 'English month labels');
  assert.ok(info.groups.some((g) => g === 'July 2024'), 'EXIF date taken used for grouping');
  assert.equal(info.title, 'Gallery');
  // EXIF orientation 6: the 1200x800 JPEG is laid out and thumbnailed as a portrait picture.
  const o6 = await appEval(async (a) => {
    const it = a.lib.items.find((x) => x.name === 'IMG_2000.jpg');
    const img = new Image();
    img.src = await a.thumbs.request(it, 3);
    await img.decode();
    return { w: it.w, h: it.h, tw: img.naturalWidth, th: img.naturalHeight };
  });
  assert.deepEqual([o6.w, o6.h], [800, 1200]);
  assert.ok(o6.th > o6.tw, `portrait thumbnail ${o6.tw}x${o6.th}`);
  await docShot(s, 'gallery');
});

await test('gallery: thumbnails cached on disk (path+mtime+size key)', async () => {
  const dir = path.join(home, '.config', 'aurora', 'apps', 'photos', 'thumbs');
  await s.page.waitForTimeout(800);
  const n = fs.readdirSync(dir).filter((f) => f.endsWith('.webp')).length;
  assert.ok(n >= 10, `thumbnails written to ${dir} (${n})`);
  assert.ok(fs.existsSync(path.join(home, '.config', 'aurora', 'apps', 'photos', 'index.json')), 'metadata index written');
});


const sortedNames = (dir) =>
  fs
    .readdirSync(dir)
    .filter((n) => /\.(png|jpe?g|gif|webp|bmp|svg|avif|ico)$/i.test(n) && !n.startsWith('.'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
const viewerState = () =>
  s.page.evaluate(() => {
    const a = [...document.querySelectorAll('.win.app-photos')].pop().__photos;
    const v = a.viewer;
    return {
      mode: a.mode,
      name: v?.item?.name,
      index: v?.index,
      count: v?.list.length,
      film: document.querySelectorAll('.app-photos .ph-film-item').length,
      z: v ? { ...v.z } : null,
      fit: v?.fit,
      nw: v?.nw,
      nh: v?.nh,
      zoomLabel: v?.zoomLabel.textContent,
      title: a.win.title,
      fs: !!v?.fs,
    };
  });
async function waitViewerImage(name) {
  await s.page.waitForFunction(
    (n) => {
      const v = [...document.querySelectorAll('.win.app-photos')].pop().__photos.viewer;
      const img = v?.img;
      return v && v.item?.name === n && img && img.complete && img.naturalWidth > 0 && img.src.includes(encodeURIComponent(n).replace(/%20/g, '%20')) && !img.src.startsWith('blob:') && !img.src.includes('/thumbs/');
    },
    name,
    { timeout: 15000 },
  );
}

await test('viewer: opening a file via args shows it with its folder siblings in the filmstrip', async () => {
  await closePhotos(s);
  const pics = path.join(home, 'Pictures');
  const names = sortedNames(pics);
  const target = path.join(pics, 'photo-02.png');
  await launchPhotos(s, { file: target });
  await waitViewerImage('photo-02.png');
  const st = await viewerState();
  assert.equal(st.mode, 'viewer');
  assert.equal(st.count, names.length, 'filmstrip = images of the folder');
  assert.equal(st.index, names.indexOf('photo-02.png'));
  assert.equal(st.title, 'photo-02.png');
  assert.ok(st.film > 0 && st.film <= names.length, 'filmstrip is virtualized');
  await s.page.waitForTimeout(400);
  await docShot(s, 'viewer');
});

await test('viewer: next / previous with arrows, Home / End and the chevrons', async () => {
  const names = sortedNames(path.join(home, 'Pictures'));
  const i0 = names.indexOf('photo-02.png');
  await s.page.keyboard.press('ArrowRight');
  await waitViewerImage(names[i0 + 1]);
  await s.page.keyboard.press('ArrowLeft');
  await s.page.keyboard.press('ArrowLeft');
  await waitViewerImage(names[i0 - 1]);
  await s.page.keyboard.press('End');
  await waitViewerImage(names.at(-1));
  await s.page.keyboard.press('Home');
  await waitViewerImage(names[0]);
  const box = await s.page.locator('.app-photos .ph-vcenter').last().boundingBox();
  await s.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await s.page.locator('.app-photos .ph-chev.next').last().click();
  await waitViewerImage(names[1]);
  // Filmstrip click
  await s.page.locator(`.app-photos .ph-film-item[data-i="${i0}"]`).last().click();
  await waitViewerImage('photo-02.png');
});

await test('viewer: wheel zoom at the cursor, slider, double-click 100 % / fit, pan by drag', async () => {
  // A big image: IMG_2003.jpg is 1000x1000 -> fits the stage below 100 %.
  const names = sortedNames(path.join(home, 'Pictures'));
  await s.page.locator(`.app-photos .ph-film-item[data-i="${names.indexOf('IMG_2003.jpg')}"]`).last().evaluate((e) => e.scrollIntoView());
  await s.aurora((i) => [...document.querySelectorAll('.win.app-photos')].pop().__photos.viewer.go(i), names.indexOf('IMG_2003.jpg'));
  await waitViewerImage('IMG_2003.jpg');
  let st = await viewerState();
  assert.ok(st.fit < 1, `fit scale ${st.fit}`);
  assert.equal(st.z.s, st.fit);
  assert.equal(st.zoomLabel, `${Math.round(st.fit * 100)}%`);
  const stage = await s.page.locator('.app-photos .ph-stage').last().boundingBox();
  const cx = stage.x + stage.width * 0.4;
  const cy = stage.y + stage.height * 0.45;
  const imgPt = (z) => ({ x: (cx - stage.x - z.tx) / z.s, y: (cy - stage.y - z.ty) / z.s });
  // Start at 100 % (bigger than the stage both ways): from there the zoom must pivot on the cursor.
  await s.page.keyboard.press('Control+1');
  st = await viewerState();
  assert.equal(st.z.s, 1);
  const p0 = imgPt(st.z);
  await s.page.mouse.move(cx, cy);
  await s.page.keyboard.down('Control');
  for (let i = 0; i < 4; i++) await s.page.mouse.wheel(0, -100);
  await s.page.keyboard.up('Control');
  await s.page.waitForTimeout(150);
  st = await viewerState();
  assert.ok(st.z.s > 1.5, `zoomed in (${st.z.s})`);
  const p1 = imgPt(st.z);
  assert.ok(Math.abs(p0.x - p1.x) < 1.5 && Math.abs(p0.y - p1.y) < 1.5, `pixel under the cursor stays put (${JSON.stringify(p0)} vs ${JSON.stringify(p1)})`);
  assert.equal(st.zoomLabel, `${Math.round(st.z.s * 100)}%`);
  // Pan by dragging
  const before = st.z;
  await s.page.mouse.move(cx, cy);
  await s.page.mouse.down();
  await s.page.mouse.move(cx + 60, cy + 40, { steps: 5 });
  await s.page.mouse.up();
  st = await viewerState();
  assert.ok(st.z.tx !== before.tx || st.z.ty !== before.ty, 'image moved');
  assert.ok(st.z.tx <= 0.5 && st.z.tx >= stage.width - st.nw * st.z.s - 0.5, 'pan clamped horizontally');
  // Double-click -> fit, double-click -> 100 %
  await s.page.mouse.dblclick(cx, cy);
  await s.page.waitForTimeout(300);
  st = await viewerState();
  assert.equal(st.z.s, st.fit, 'back to fit');
  await s.page.mouse.dblclick(cx, cy);
  await s.page.waitForTimeout(300);
  st = await viewerState();
  assert.equal(st.z.s, 1, '100 %');
  await docShot(s, 'viewer-zoom');
  // Keyboard zoom
  await s.page.keyboard.press('Control+0');
  st = await viewerState();
  assert.equal(st.z.s, st.fit);
  await s.page.keyboard.press('Control+=');
  st = await viewerState();
  assert.ok(st.z.s > st.fit);
  // Slider
  await s.page.locator('.app-photos .ph-zoom-slider').last().evaluate((el) => {
    el.value = '80';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  st = await viewerState();
  assert.ok(st.z.s > 2, `slider zoom ${st.z.s}`);
  await s.page.keyboard.press('Control+0');
});

await test('viewer: EXIF orientation is applied (JPEG with orientation 6 shows portrait)', async () => {
  const p = path.join(home, 'Pictures', 'Trips', 'IMG_2000.jpg');
  await s.aurora((f) => [...document.querySelectorAll('.win.app-photos')].pop().__photos.openFile(f), p);
  await waitViewerImage('IMG_2000.jpg');
  const st = await viewerState();
  assert.equal(st.nw, 800);
  assert.equal(st.nh, 1200);
  const it = await s.page.evaluate(() => {
    const v = [...document.querySelectorAll('.win.app-photos')].pop().__photos.viewer;
    return { w: v.item.w, h: v.item.h, o: v.item.o };
  });
  assert.deepEqual(it, { w: 800, h: 1200, o: 6 }, 'backend reports display dimensions');
});

await test('viewer: file information pane shows EXIF details', async () => {
  await s.page.keyboard.press('i');
  await s.page.waitForSelector('.app-photos .ph-info .ph-info-row');
  await s.page.waitForFunction(() => /Contoso/.test(document.querySelector('.app-photos .ph-info')?.textContent || ''));
  const text = await s.page.locator('.app-photos .ph-info').last().textContent();
  assert.match(text, /IMG_2000\.jpg/);
  assert.match(text, /Contoso Z9/);
  assert.match(text, /f\/2\.8 · 1\/250 s · ISO 200/);
  assert.match(text, /July 14, 2024/);
  assert.match(text, /800 × 1200/);
  assert.match(text, /Open file location/);
  await docShot(s, 'viewer-info');
  await s.page.keyboard.press('i');
  assert.equal(await s.page.locator('.app-photos .ph-info').last().isHidden(), true);
});

await test('viewer: Ctrl+R rotates a JPEG losslessly (EXIF) and a PNG by re-encoding', async () => {
  const jp = path.join(home, 'Pictures', 'Trips', 'IMG_2000.jpg');
  const bytesBefore = fs.readFileSync(jp);
  await s.page.locator('.app-photos .ph-stage').last().focus();
  const done0 = await s.page.evaluate(() => [...document.querySelectorAll('.win.app-photos')].pop().__photos.viewer._rotDone || 0);
  await s.page.keyboard.press('Control+r');
  await s.page.waitForFunction((d) => {
    const v = [...document.querySelectorAll('.win.app-photos')].pop().__photos.viewer;
    return v.item.o === 3 && (v._rotDone || 0) > d;
  }, done0, { timeout: 10000 });
  const bytesAfter = fs.readFileSync(jp);
  assert.equal(bytesAfter.length, bytesBefore.length, 'same size: only the orientation tag changed');
  const diff = [...bytesAfter].reduce((n, b, i) => n + (b !== bytesBefore[i] ? 1 : 0), 0);
  assert.ok(diff >= 1 && diff <= 2, `one tag byte changed (${diff})`);
  await waitViewerImage('IMG_2000.jpg');
  let st = await viewerState();
  assert.deepEqual([st.nw, st.nh], [1200, 800], 'orientation 3: landscape again');
  // PNG: pixels are rotated.
  const pp = path.join(home, 'Pictures', 'photo-04.png');
  await s.aurora((f) => [...document.querySelectorAll('.win.app-photos')].pop().__photos.openFile(f), pp);
  await waitViewerImage('photo-04.png');
  st = await viewerState();
  const [w0, h0] = [st.nw, st.nh];
  const done1 = await s.page.evaluate(() => [...document.querySelectorAll('.win.app-photos')].pop().__photos.viewer._rotDone || 0);
  await s.page.locator('.app-photos .ph-tb[data-cmd="rotate"]').last().click();
  await s.page.waitForFunction((d) => ([...document.querySelectorAll('.win.app-photos')].pop().__photos.viewer._rotDone || 0) > d, done1, { timeout: 10000 });
  st = await viewerState();
  assert.deepEqual([st.nw, st.nh], [h0, w0], 'viewer shows the rotated picture');
  assert.equal(await s.page.evaluate(() => [...document.querySelectorAll('.win.app-photos')].pop().__photos.viewer.imgwrap.style.transform), '');
  const px = await pixelOf(s, pp, 0, 0);
  assert.deepEqual([px.w, px.h], [h0, w0], 'PNG rotated on disk');
});


const editorState = () =>
  s.page.evaluate(() => {
    const a = [...document.querySelectorAll('.win.app-photos')].pop().__photos;
    const e = a.editor;
    return { mode: a.mode, tool: e?.tool, edit: e ? JSON.parse(JSON.stringify(e.edit)) : null, dirty: e?.dirty, canvas: e ? [e.canvas.width, e.canvas.height] : null, busy: e?.busy };
  });
async function ensurePhotos(args) {
  const n = await s.aurora(() => window.__aurora.wm.byApp('photos').filter((w) => !w._closing).length);
  if (!n) {
    await s.page.waitForFunction(() => !document.querySelector('.win.app-photos'), null, { timeout: 15000 });
    await launchPhotos(s, args);
  }
}
async function openInEditor(file) {
  await ensurePhotos({ file });
  await s.aurora((f) => [...document.querySelectorAll('.win.app-photos')].pop().__photos.openFile(f), file);
  await waitViewerImage(path.basename(file));
  await s.page.locator('.app-photos .ph-stage').last().focus();
  await s.page.keyboard.press('Control+e');
  await s.page.waitForFunction(() => {
    const a = [...document.querySelectorAll('.win.app-photos')].pop().__photos;
    return a.mode === 'editor' && a.editor.preview && a.editor.canvas.width > 1 && !a.editor.el.classList.contains('loading');
  }, null, { timeout: 15000 });
}
/** Click "Save as copy", accept the save dialog (default name), wait for the editor to close. Returns the new path. */
async function saveCopy() {
  await s.page.locator('.app-photos [data-cmd="save-copy"]').last().click();
  await s.page.waitForSelector('.app-photos .fp-dialog');
  const name = await s.page.locator('.app-photos .fp-dialog .fp-bottom input.input').last().inputValue();
  await s.page.locator('.app-photos .fp-dialog .dialog-footer .btn.primary').last().click();
  await s.page.waitForFunction(() => [...document.querySelectorAll('.win.app-photos')].pop().__photos.mode === 'viewer', null, { timeout: 20000 });
  return name;
}

await test('editor: crop to 1:1 and save as copy writes a square picture', async () => {
  const src = path.join(home, 'Pictures', 'solid-gray.png');
  await openInEditor(src);
  let st = await editorState();
  assert.equal(st.tool, 'crop');
  assert.deepEqual(st.canvas, [200, 100]);
  await docShot(s, 'editor-crop');
  await s.page.locator('.app-photos .ph-ratio[data-aspect="1:1"]').last().click();
  st = await editorState();
  assert.equal(st.edit.aspect, '1:1');
  assert.deepEqual(st.edit.crop, { x: 0.25, y: 0, w: 0.5, h: 1 });
  assert.ok(st.dirty);
  const name = await saveCopy();
  assert.equal(name, 'solid-gray (2).png');
  const out = path.join(home, 'Pictures', name);
  assert.ok(fs.existsSync(out), 'copy written next to the original');
  const px = await pixelOf(s, out, 0.5, 0.5);
  assert.deepEqual([px.w, px.h], [100, 100]);
  assert.deepEqual(px.rgb, [100, 100, 100]);
  const v = await viewerState();
  assert.equal(v.name, name, 'the saved copy is shown');
  const orig = await pixelOf(s, src, 0.5, 0.5);
  assert.deepEqual([orig.w, orig.h], [200, 100], 'original untouched');
});

await test('editor: free crop by dragging a handle gives the expected pixel size', async () => {
  const src = path.join(home, 'Pictures', 'solid-gray.png');
  await openInEditor(src);
  const box = await s.page.locator('.app-photos .ph-crop-box').last().boundingBox();
  // Drag the bottom-right corner to the middle of the picture.
  const h = await s.page.locator('.app-photos .ph-crop-h.h-se').last().boundingBox();
  await s.page.mouse.move(h.x + h.width - 6, h.y + h.height - 6);
  await s.page.mouse.down();
  await s.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 6 });
  await s.page.mouse.up();
  const st = await editorState();
  assert.ok(Math.abs(st.edit.crop.w - 0.5) < 0.03 && Math.abs(st.edit.crop.h - 0.5) < 0.03, JSON.stringify(st.edit.crop));
  // Exact values for the saved size check.
  await s.page.evaluate(() => [...document.querySelectorAll('.win.app-photos')].pop().__photos.editor.setEdit({ crop: { x: 0.1, y: 0.2, w: 0.5, h: 0.6 } }));
  const name = await saveCopy();
  const px = await pixelOf(s, path.join(home, 'Pictures', name), 0.5, 0.5);
  assert.deepEqual([px.w, px.h], [100, 60]);
});

await test('editor: rotate 90° then save as copy (pixels really rotated)', async () => {
  const src = path.join(home, 'Pictures', 'photo-02.png');
  const o = await pixelOf(s, src, 0.5, 0.02); // sky (top)
  const oBottom = await pixelOf(s, src, 0.5, 0.98); // hills (bottom)
  await openInEditor(src);
  await s.page.locator('.app-photos [data-cmd="rot-right"]').last().click();
  let st = await editorState();
  assert.equal(st.edit.rot, 1);
  await s.page.waitForTimeout(300);
  await docShot(s, 'editor-rotate');
  const name = await saveCopy();
  const out = path.join(home, 'Pictures', name);
  const left = await pixelOf(s, out, 0.02, 0.5);
  const right = await pixelOf(s, out, 0.98, 0.5);
  assert.deepEqual([left.w, left.h], [o.h, o.w], 'dimensions swapped');
  const close = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 24);
  assert.ok(close(right.rgb, o.rgb), `right edge = former top (${right.rgb} vs ${o.rgb})`);
  assert.ok(close(left.rgb, oBottom.rgb), `left edge = former bottom (${left.rgb} vs ${oBottom.rgb})`);
});

await test('editor: adjustments are applied on save; undo / redo; filters', async () => {
  const src = path.join(home, 'Pictures', 'solid-gray.png');
  await openInEditor(src);
  await s.page.locator('.app-photos .ph-etab[data-tool="adjust"]').last().click();
  const setSlider = (sel, v) =>
    s.page.locator(sel).last().evaluate((el, val) => {
      el.value = String(val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, v);
  await setSlider('.app-photos .ph-adj-slider[data-adjust="brightness"]', 60);
  let st = await editorState();
  assert.equal(st.edit.adjust.brightness, 60);
  await setSlider('.app-photos .ph-adj-slider[data-adjust="warmth"]', 50);
  await s.page.waitForTimeout(200);
  await docShot(s, 'editor-adjust');
  // Undo the warmth, redo it, undo again.
  await s.page.keyboard.press('Control+z');
  st = await editorState();
  assert.equal(st.edit.adjust.warmth, 0);
  assert.equal(st.edit.adjust.brightness, 60);
  assert.equal(await s.page.locator('.app-photos .ph-adj-slider[data-adjust="warmth"]').last().inputValue(), '0', 'slider follows undo');
  await s.page.keyboard.press('Control+y');
  st = await editorState();
  assert.equal(st.edit.adjust.warmth, 50);
  await s.page.keyboard.press('Control+z');
  const name = await saveCopy();
  const px = await pixelOf(s, path.join(home, 'Pictures', name), 0.5, 0.5);
  assert.ok(px.rgb[0] > 130 && px.rgb[0] === px.rgb[1] && px.rgb[1] === px.rgb[2], `brighter neutral gray: ${px.rgb}`);
  // Filter: sepia on a colored photo -> warm tones; mono -> r = g = b.
  const col = path.join(home, 'Pictures', 'photo-03.png');
  await openInEditor(col);
  await s.page.locator('.app-photos .ph-etab[data-tool="filter"]').last().click();
  await s.page.waitForSelector('.app-photos .ph-filter[data-filter="mono"]');
  assert.ok((await s.page.locator('.app-photos .ph-filter').count()) >= 9, '8+ filter presets');
  await s.page.locator('.app-photos .ph-filter[data-filter="mono"]').last().click();
  st = await editorState();
  assert.equal(st.edit.filter.id, 'mono');
  await s.page.waitForTimeout(200);
  await docShot(s, 'editor-filter');
  const n2 = await saveCopy();
  const m = await pixelOf(s, path.join(home, 'Pictures', n2), 0.5, 0.1);
  assert.ok(Math.abs(m.rgb[0] - m.rgb[1]) <= 2 && Math.abs(m.rgb[1] - m.rgb[2]) <= 2, `mono pixel ${m.rgb}`);
});

await test('editor: markup pen stroke is saved; leaving with edits asks first', async () => {
  const src = path.join(home, 'Pictures', 'solid-gray.png');
  await openInEditor(src);
  await s.page.locator('.app-photos .ph-etab[data-tool="markup"]').last().click();
  const swatchBg = await s.page.locator('.app-photos .ph-swatch[data-color="#0078d4"]').last().evaluate((e) => getComputedStyle(e).backgroundColor);
  assert.equal(swatchBg, 'rgb(0, 120, 212)', 'swatches show their colour');
  const c = await s.page.locator('.app-photos .ph-ecanvas').last().boundingBox();
  // Highlighter stroke, then the eraser removes it.
  await s.page.locator('.app-photos .ph-pen-tools button', { hasText: 'Highlighter' }).click();
  await s.page.mouse.move(c.x + c.width * 0.2, c.y + c.height * 0.25);
  await s.page.mouse.down();
  await s.page.mouse.move(c.x + c.width * 0.8, c.y + c.height * 0.25, { steps: 8 });
  await s.page.mouse.up();
  let st = await editorState();
  assert.equal(st.edit.markup.length, 1);
  assert.equal(st.edit.markup[0].tool, 'highlighter');
  await s.page.locator('.app-photos .ph-pen-tools button', { hasText: 'Eraser' }).click();
  await s.page.mouse.move(c.x + c.width * 0.5, c.y + c.height * 0.1);
  await s.page.mouse.down();
  await s.page.mouse.move(c.x + c.width * 0.5, c.y + c.height * 0.4, { steps: 6 });
  await s.page.mouse.up();
  st = await editorState();
  assert.equal(st.edit.markup.length, 0, 'eraser removed the stroke');
  await s.page.locator('.app-photos .ph-pen-tools button', { hasText: 'Pen' }).click();
  await s.page.mouse.move(c.x + c.width * 0.2, c.y + c.height * 0.5);
  await s.page.mouse.down();
  await s.page.mouse.move(c.x + c.width * 0.8, c.y + c.height * 0.5, { steps: 10 });
  await s.page.mouse.up();
  st = await editorState();
  assert.equal(st.edit.markup.length, 1);
  assert.ok(st.edit.markup[0].points.length > 3);
  await docShot(s, 'editor-markup');
  // Escape -> "Save your changes?" -> Cancel keeps the editor open.
  await s.page.keyboard.press('Escape');
  await s.page.waitForSelector('.app-photos .dialog');
  assert.match(await s.page.locator('.app-photos .dialog').last().textContent(), /Save your changes\?/);
  await s.page.locator('.app-photos .dialog .dialog-footer .btn').nth(2).click();
  await s.page.waitForTimeout(250);
  st = await editorState();
  assert.equal(st.mode, 'editor');
  // Closing the window also asks.
  const closing = s.aurora(() => window.__aurora.wm.byApp('photos').at(-1).close());
  await s.page.waitForSelector('.app-photos .dialog');
  await s.page.locator('.app-photos .dialog .dialog-footer .btn').nth(2).click();
  await closing;
  assert.equal(await s.aurora(() => window.__aurora.wm.byApp('photos').length), 1, 'window stays open after Cancel');
  const name = await saveCopy();
  const px = await pixelOf(s, path.join(home, 'Pictures', name), 0.5, 0.5);
  assert.ok(px.rgb[0] > 200 && px.rgb[1] < 60, `red pen stroke saved: ${px.rgb}`);
  // Don't save path
  await openInEditor(src);
  await s.page.locator('.app-photos [data-cmd="rot-right"]').last().click();
  assert.equal(await s.page.evaluate(() => document.activeElement?.dataset?.cmd), 'rot-right', 'focus kept on the button after the panel re-renders');
  await s.page.keyboard.press('Escape');
  await s.page.waitForSelector('.app-photos .dialog');
  await s.page.locator('.app-photos .dialog .dialog-footer .btn').nth(1).click();
  await s.page.waitForFunction(() => [...document.querySelectorAll('.win.app-photos')].pop().__photos.mode === 'viewer');
});


async function toGallery() {
  await ensurePhotos();
  await appEval((a) => (a.mode === 'gallery' ? null : a.mode === 'editor' ? a.closeEditor({ force: true }).then(() => a.closeViewer()) : a.closeViewer()));
  await s.page.waitForFunction(() => [...document.querySelectorAll('.win.app-photos')].pop().__photos.mode === 'gallery');
  await waitTiles(s, 1);
}
async function ensureViewer(name = 'photo-02.png') {
  const f = path.join(home, 'Pictures', name);
  await ensurePhotos({ file: f });
  if ((await appEval((a) => a.mode)) !== 'viewer') {
    await appEval((a, p) => a.openFile(p), f);
    await waitViewerImage(name);
  }
}
async function nav(page) {
  await s.page.locator(`.app-photos .ph-nav-item[data-page="${page}"]`).last().click();
  await s.page.waitForTimeout(150);
}

await test('gallery: Ctrl/Shift multi-select, bulk favorite and copy, Esc clears', async () => {
  await toGallery();
  await nav('gallery');
  await waitThumbsLoaded(s);
  const tiles = s.page.locator('.app-photos .ph-gallery .ph-tile');
  await tiles.nth(0).click({ modifiers: ['Control'] });
  await tiles.nth(2).click({ modifiers: ['Shift'] });
  await tiles.nth(4).click({ modifiers: ['Control'] });
  let n = await appEval((a) => a.gallery.grid.selected.size);
  assert.equal(n, 4, 'items 0-2 by range + item 4');
  assert.match(await s.page.locator('.app-photos .ph-selcount').last().textContent(), /4 selected/);
  await s.page.waitForTimeout(250);
  await docShot(s, 'gallery-select');
  await s.page.locator('.app-photos .ph-selbar [data-cmd="sel-fav"]').last().click();
  const favs = await appEval((a) => [...a.lib.favorites]);
  assert.equal(favs.length, 4);
  await s.page.locator('.app-photos .ph-selbar [data-cmd="sel-copy"]').last().click();
  // (the files are checked first: copy reports pictures that were moved or deleted)
  await s.page.waitForFunction(() => window.__aurora.shell.clipboard.getFiles()?.paths?.length === 4, null, { timeout: 5000 });
  const clip = await s.aurora(() => window.__aurora.shell.clipboard.getFiles());
  assert.equal(clip.paths.length, 4);
  assert.equal(clip.mode, 'copy');
  await s.page.locator('.app-photos .ph-scroll').last().focus();
  await s.page.keyboard.press('Escape');
  n = await appEval((a) => a.gallery.grid.selected.size);
  assert.equal(n, 0);
  assert.equal(await s.page.locator('.app-photos .ph-selbar').last().isHidden(), true);
  // Favorites persist in the app storage.
  const stored = JSON.parse(fs.readFileSync(path.join(home, '.config', 'aurora', 'apps', 'photos', 'favorites.json'), 'utf8'));
  assert.deepEqual(stored.sort(), favs.sort());
  await nav('favorites');
  await waitTiles(s, 4);
  assert.equal(await appEval((a) => a.gallery.grid.flat.length), 4, 'favorites page');
  assert.equal(await s.page.locator('.app-photos .ph-gallery .ph-fav-badge').count(), 4, 'heart badges');
});

await test('gallery: keyboard navigation (arrows, Enter opens, Esc back to the gallery)', async () => {
  await nav('gallery');
  await s.page.locator('.app-photos .ph-scroll').last().focus();
  await s.page.keyboard.press('ArrowRight');
  await s.page.keyboard.press('ArrowRight');
  await s.page.keyboard.press('ArrowDown');
  const idx = await appEval((a) => a.gallery.grid.focusIdx);
  assert.ok(idx > 2, `focus moved down a row (${idx})`);
  const name = await appEval((a) => a.gallery.grid.flat[a.gallery.grid.focusIdx].name);
  await s.page.keyboard.press('Enter');
  await waitViewerImage(name);
  const st = await viewerState();
  assert.equal(st.count, await appEval((a) => a.gallery.grid.flat.length), 'viewer browses the gallery list');
  await s.page.keyboard.press('Escape');
  await s.page.waitForFunction(() => [...document.querySelectorAll('.win.app-photos')].pop().__photos.mode === 'gallery');
  assert.equal(await appEval((a) => a.gallery.grid.flat[a.gallery.grid.focusIdx]?.name), name, 'focus returns to the opened photo');
});

await test('gallery: keyboard-only selection and bulk actions keep the focus', async () => {
  await toGallery();
  await nav('gallery');
  await s.page.locator('.app-photos .ph-scroll').last().focus();
  await s.page.keyboard.press('Home');
  await s.page.keyboard.press(' ');
  await s.page.keyboard.press('Shift+ArrowRight');
  assert.equal(await appEval((a) => a.gallery.grid.selected.size), 2, 'Space + Shift+Arrow select');
  // The selection bar is reachable with Shift+Tab; acting on it keeps the focus there.
  const favBefore = await appEval((a) => a.lib.favorites.size);
  await s.page.locator('.app-photos .ph-selbar [data-cmd="sel-fav"]').last().focus();
  await s.page.keyboard.press('Enter');
  assert.notEqual(await appEval((a) => a.lib.favorites.size), favBefore);
  assert.equal(await s.page.evaluate(() => document.activeElement?.dataset?.cmd), 'sel-fav', 'focus stays on the rebuilt button');
  await s.page.keyboard.press('Enter');
  assert.equal(await appEval((a) => a.lib.favorites.size), favBefore, 'toggled back');
  await s.page.locator('.app-photos .ph-selbar [data-cmd="sel-clear"]').last().focus();
  await s.page.keyboard.press('Enter');
  assert.equal(await appEval((a) => a.gallery.grid.selected.size), 0);
  const active = await s.page.evaluate(() => document.activeElement?.className || document.activeElement?.tagName);
  assert.notEqual(active, 'BODY', `focus stays in the window (${active})`);
});

await test('gallery: search by file name and by date text', async () => {
  const box = s.page.locator('.app-photos .ph-search-input').last();
  await box.fill('IMG_2001');
  await s.page.waitForFunction(() => [...document.querySelectorAll('.win.app-photos')].pop().__photos.gallery.route.page === 'search');
  await s.page.waitForTimeout(150);
  assert.deepEqual(await appEval((a) => a.gallery.grid.flat.map((i) => i.name)), ['IMG_2001.jpg']);
  assert.match(await s.page.locator('.app-photos .ph-title').last().textContent(), /Results for “IMG_2001”/);
  await box.fill('july 2024');
  await s.page.waitForTimeout(400);
  const names = await appEval((a) => a.gallery.grid.flat.map((i) => i.name).sort());
  assert.deepEqual(names, ['IMG_2000.jpg', 'IMG_2001.jpg'], 'date text matches EXIF dates');
  await box.fill('zzzz-nothing');
  await s.page.waitForTimeout(400);
  assert.equal(await s.page.locator('.app-photos .ph-empty').last().isVisible(), true, 'empty state');
  await box.fill('');
  await s.page.waitForTimeout(400);
  assert.equal(await appEval((a) => a.gallery.route.page), 'gallery');
});

await test('albums: create, add photos via picking, rename, cover, persistence after relaunch', async () => {
  await nav('albums');
  await s.page.locator('.app-photos [data-cmd="new-album"]').last().click();
  await s.page.waitForSelector('.app-photos .dialog input.input');
  await s.page.locator('.app-photos .dialog input.input').last().fill('Summer trip');
  await s.page.keyboard.press('Enter');
  await s.page.waitForFunction(() => [...document.querySelectorAll('.win.app-photos')].pop().__photos.gallery.route.page === 'album');
  assert.match(await s.page.locator('.app-photos .ph-empty').last().textContent(), /This album is empty/);
  await s.page.locator('.app-photos .ph-empty .btn.primary').last().click();
  await s.page.waitForFunction(() => !!document.querySelector('.app-photos .ph-gridwrap.picking'));
  await waitTiles(s, 3);
  const tiles = s.page.locator('.app-photos .ph-gallery .ph-tile');
  await tiles.nth(1).click();
  await tiles.nth(3).click();
  await tiles.nth(5).click();
  await s.page.locator('.app-photos [data-cmd="pick-add"]').last().click();
  await s.page.waitForFunction(() => [...document.querySelectorAll('.win.app-photos')].pop().__photos.gallery.route.page === 'album');
  await waitTiles(s, 3);
  let al = await appEval((a) => a.lib.albums.map((x) => ({ name: x.name, n: x.items.length })));
  assert.deepEqual(al, [{ name: 'Summer trip', n: 3 }]);
  // Rename via the album "…" menu
  await s.page.locator('.app-photos [data-cmd="album-more"]').last().click();
  await s.page.locator('.menu .menu-item', { hasText: 'Rename album' }).click();
  await s.page.locator('.app-photos .dialog input.input').last().fill('Summer 2026');
  await s.page.keyboard.press('Enter');
  await s.page.waitForTimeout(200);
  assert.equal(await s.page.locator('.app-photos .ph-title').last().textContent(), 'Summer 2026');
  // Set the third photo as cover through the context menu.
  const third = await appEval((a) => a.gallery.grid.flat[2].path);
  await s.page.locator('.app-photos .ph-gallery .ph-tile').nth(2).click({ button: 'right' });
  await s.page.locator('.menu .menu-item', { hasText: 'Set as album cover' }).click();
  assert.equal(await appEval((a) => a.lib.albums[0].cover), third);
  await nav('albums');
  await s.page.waitForSelector('.app-photos .ph-album');
  await s.page.waitForTimeout(300);
  await docShot(s, 'albums');
  // Relaunch: albums + favorites are still there.
  await closePhotos(s);
  await launchPhotos(s);
  await nav('albums');
  al = await appEval((a) => a.lib.albums.map((x) => ({ name: x.name, n: x.items.length, cover: x.cover })));
  assert.deepEqual(al, [{ name: 'Summer 2026', n: 3, cover: third }]);
  assert.equal(await appEval((a) => a.lib.favorites.size), 4);
  await s.page.locator('.app-photos .ph-album').first().click();
  await waitTiles(s, 3);
  // Remove one photo from the album with the selection bar.
  await s.page.locator('.app-photos .ph-gallery .ph-tile').nth(0).click({ modifiers: ['Control'] });
  await s.page.locator('.app-photos .ph-selbar [data-cmd="sel-remove"]').last().click();
  assert.equal(await appEval((a) => a.lib.albums[0].items.length), 2);
});

await test('folders: tree of folders, subfolders, add a folder, remove it', async () => {
  await nav('folders');
  await s.page.waitForSelector('.app-photos .ph-tree-row');
  await s.page.waitForTimeout(300);
  let rows = await s.page.locator('.app-photos .ph-tree-row').allTextContents();
  assert.deepEqual(rows, ['Pictures', 'Screenshots', 'Trips']);
  const picsCount = sortedNames(path.join(home, 'Pictures')).length;
  await s.page.waitForFunction((n) => [...document.querySelectorAll('.win.app-photos')].pop().__photos.gallery.grid.flat.length === n, picsCount);
  assert.equal(await s.page.locator('.app-photos .ph-subfolder').count(), 2, 'subfolder chips');
  await s.page.locator('.app-photos .ph-tree-row', { hasText: 'Trips' }).click();
  const tripCount = sortedNames(path.join(home, 'Pictures', 'Trips')).length;
  await s.page.waitForFunction((n) => [...document.querySelectorAll('.win.app-photos')].pop().__photos.gallery.grid.flat.length === n, tripCount);
  assert.equal(await s.page.locator('.app-photos .ph-title').last().textContent(), 'Trips');
  await waitThumbsLoaded(s);
  await docShot(s, 'folders');
  // Add a folder outside Pictures (through the folder picker).
  const extra = path.join(home, 'Documents', 'Scans');
  fs.mkdirSync(extra, { recursive: true });
  fs.writeFileSync(path.join(extra, 'scan-1.png'), png(300, 400, 21));
  fs.writeFileSync(path.join(extra, 'scan-2.png'), png(300, 400, 22));
  const before = await appEval((a) => a.lib.items.length);
  await s.page.locator('.app-photos .ph-tree-add').last().click();
  await s.page.waitForSelector('.app-photos .fp-dialog');
  await s.page.locator('.app-photos .fp-dialog .fp-path').last().fill(extra);
  // (core file picker: Enter in the path box also triggers the dialog's default button; keep it to navigation)
  await s.page.evaluate(() => document.querySelector('.app-photos .fp-dialog .fp-top').addEventListener('keydown', (e) => e.key === 'Enter' && e.stopPropagation()));
  await s.page.locator('.app-photos .fp-dialog .fp-path').last().press('Enter');
  await s.page.waitForTimeout(300);
  await s.page.locator('.app-photos .fp-dialog .dialog-footer .btn.primary').last().click();
  await s.page.waitForFunction((n) => [...document.querySelectorAll('.win.app-photos')].pop().__photos.lib.items.length === n + 2, before, { timeout: 15000 });
  rows = await s.page.locator('.app-photos .ph-tree-row').allTextContents();
  assert.ok(rows.includes('Scans'), rows.join(','));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, '.config', 'aurora', 'apps', 'photos', 'folders.json'), 'utf8')), [extra]);
  // Remove it (context menu on the root)
  await s.page.locator('.app-photos .ph-tree-row', { hasText: 'Scans' }).click({ button: 'right' });
  await s.page.locator('.menu .menu-item', { hasText: 'Remove folder' }).click();
  await s.page.locator('.app-photos .dialog .dialog-footer .btn.primary').last().click();
  await s.page.waitForFunction((n) => [...document.querySelectorAll('.win.app-photos')].pop().__photos.lib.items.length === n, before, { timeout: 15000 });
  assert.ok(fs.existsSync(path.join(extra, 'scan-1.png')), 'files are not deleted');
});

await test('library: new files dropped into Pictures appear automatically (watcher)', async () => {
  await nav('gallery');
  const before = await appEval((a) => a.lib.items.length);
  const p = path.join(home, 'Pictures', 'new-arrival.png');
  fs.writeFileSync(p, png(320, 240, 30));
  await s.page.waitForFunction((n) => [...document.querySelectorAll('.win.app-photos')].pop().__photos.lib.items.length === n + 1, before, { timeout: 15000 });
  assert.equal(await appEval((a, f) => !!a.lib.get(f), p), true);
});

await test('viewer: delete moves the file to the Recycle Bin after confirmation', async () => {
  const p = path.join(home, 'Pictures', 'new-arrival.png');
  if (!fs.existsSync(p)) fs.writeFileSync(p, png(320, 240, 30));
  await ensurePhotos({ file: p });
  await s.aurora((f) => [...document.querySelectorAll('.win.app-photos')].pop().__photos.openFile(f), p);
  await waitViewerImage('new-arrival.png');
  const count = (await viewerState()).count;
  await s.page.keyboard.press('Delete');
  await s.page.waitForSelector('.app-photos .ph-del-dialog');
  assert.match(await s.page.locator('.app-photos .ph-del-dialog').textContent(), /new-arrival\.png” will be moved to the Recycle Bin/);
  await s.page.locator('.app-photos .ph-del-dialog .btn.primary').click();
  await s.page.waitForFunction((n) => [...document.querySelectorAll('.win.app-photos')].pop().__photos.viewer.list.length === n - 1, count);
  assert.ok(!fs.existsSync(p), 'removed from Pictures');
  assert.ok(fs.existsSync(path.join(home, '.local', 'share', 'Trash', 'files', 'new-arrival.png')), 'in the trash');
  assert.ok(fs.existsSync(path.join(home, '.local', 'share', 'Trash', 'info', 'new-arrival.png.trashinfo')));
  const st = await viewerState();
  assert.notEqual(st.name, 'new-arrival.png', 'viewer moved to another photo');
  assert.equal(await appEval((a, f) => !!a.lib.get(f), p), false);
  // Cancel keeps the file
  const name = st.name;
  await s.page.locator('.app-photos .ph-stage').last().focus();
  await s.page.keyboard.press('Delete');
  await s.page.waitForSelector('.app-photos .ph-del-dialog');
  await s.page.keyboard.press('Escape');
  await s.page.waitForTimeout(250);
  assert.equal((await viewerState()).name, name);
});

await test('viewer: "…" menu sets the desktop background and the lock screen', async () => {
  await ensureViewer();
  const st = await viewerState();
  const p = await appEval((a) => a.viewer.item.path);
  const prev = await s.aurora(() => ({ wallpaper: window.__aurora.settings.get('wallpaper'), lockWallpaper: window.__aurora.settings.get('lockWallpaper') }));
  await s.page.locator('.app-photos .ph-tb[data-cmd="more"]').last().click();
  await s.page.locator('.menu .menu-item', { hasText: 'Set as' }).hover();
  await s.page.locator('.menu .menu-item', { hasText: 'Desktop background' }).click();
  await s.page.waitForFunction((f) => window.__aurora.settings.get('wallpaper') === f, p);
  await s.page.locator('.app-photos .ph-tb[data-cmd="more"]').last().click();
  await s.page.locator('.menu .menu-item', { hasText: 'Set as' }).hover();
  await s.page.locator('.menu .menu-item', { hasText: 'Lock screen' }).click();
  await s.page.waitForFunction((f) => window.__aurora.settings.get('lockWallpaper') === f, p);
  assert.ok(st.name);
  // Open with ▸ lists Draw (app id paint) for PNG/JPEG.
  await s.page.locator('.app-photos .ph-tb[data-cmd="more"]').last().click();
  await s.page.locator('.menu .menu-item', { hasText: 'Open with' }).hover();
  await s.page.waitForTimeout(300);
  const items = await s.page.locator('.menu .menu-item').allTextContents();
  assert.ok(items.some((x) => x.includes('Draw')), items.join(' | '));
  await s.page.keyboard.press('Escape'); // closes the submenu
  await s.page.keyboard.press('Escape'); // closes the menu
  assert.equal(await s.page.locator('.menu').count(), 0);
  // Put the shell's own backgrounds back (later screenshots would show a stretched fixture picture).
  await s.aurora(async (v) => {
    await window.__aurora.settings.set('wallpaper', v.wallpaper);
    await window.__aurora.settings.set('lockWallpaper', v.lockWallpaper ?? null);
  }, prev);
});

await test('viewer: Save as converts formats, Open with ▸ Draw, F2 renames and keeps favorites', async () => {
  const src = path.join(home, 'Pictures', 'photo-03.png');
  await ensurePhotos({ file: src });
  await appEval((a, p) => a.openFile(p), src);
  await waitViewerImage('photo-03.png');
  // Save as JPEG
  await s.page.locator('.app-photos .ph-stage').last().focus();
  await s.page.keyboard.press('Control+Shift+S');
  await s.page.waitForSelector('.app-photos .fp-dialog');
  const nameInput = s.page.locator('.app-photos .fp-dialog .fp-bottom input.input').last();
  await nameInput.fill('photo-03-converted.jpg');
  await s.page.locator('.app-photos .fp-dialog .dialog-footer .btn.primary').last().click();
  const out = path.join(home, 'Pictures', 'photo-03-converted.jpg');
  await s.page.waitForFunction(() => !document.querySelector('.app-photos .fp-dialog'));
  for (let i = 0; i < 50 && !fs.existsSync(out); i++) await s.page.waitForTimeout(100);
  const head = fs.readFileSync(out).subarray(0, 3);
  assert.deepEqual([...head], [0xff, 0xd8, 0xff], 'real JPEG data');
  const px = await pixelOf(s, out, 0.5, 0.5);
  const orig = await pixelOf(s, src, 0.5, 0.5);
  assert.deepEqual([px.w, px.h], [orig.w, orig.h]);
  // Open with ▸ Draw (app id paint)
  await s.page.locator('.app-photos .ph-tb[data-cmd="more"]').last().click();
  await s.page.locator('.menu .menu-item', { hasText: 'Open with' }).hover();
  await s.page.locator('.menu .menu-item', { hasText: 'Draw' }).click();
  await s.page.waitForFunction(() => window.__aurora.wm.byApp('paint').length === 1, null, { timeout: 15000 });
  await s.aurora(async () => {
    for (const w of window.__aurora.wm.byApp('paint')) await w.close(true);
  });
  // F2 rename, favorites follow the file.
  await appEval((a) => a.viewer.toggleFavorite());
  assert.equal(await appEval((a, p) => a.lib.isFavorite(p), src), true);
  await s.aurora(() => [...document.querySelectorAll('.win.app-photos')].pop().__photos.win.focus());
  await s.page.locator('.app-photos .ph-stage').last().focus();
  await s.page.keyboard.press('F2');
  await s.page.waitForSelector('.app-photos .dialog input.input');
  await s.page.locator('.app-photos .dialog input.input').last().fill('renamed-photo.png');
  await s.page.keyboard.press('Enter');
  const renamed = path.join(home, 'Pictures', 'renamed-photo.png');
  await s.page.waitForFunction(() => [...document.querySelectorAll('.win.app-photos')].pop().__photos.viewer.item.name === 'renamed-photo.png');
  assert.ok(fs.existsSync(renamed) && !fs.existsSync(src));
  assert.equal(await appEval((a, p) => a.lib.isFavorite(p), renamed), true, 'favorite follows the rename');
  assert.equal(await s.page.locator('.app-photos .ph-vname').last().textContent(), 'renamed-photo.png');
  // Invalid name is refused inline.
  await s.page.waitForFunction(() => !document.querySelector('.app-photos .dialog-layer'));
  await s.page.waitForTimeout(100);
  assert.equal(await s.page.evaluate(() => !!document.activeElement?.closest('.app-photos')), true, 'focus is back in the window after the dialog');
  await s.page.keyboard.press('F2');
  await s.page.waitForSelector('.app-photos .dialog input.input');
  await s.page.locator('.app-photos .dialog input.input').last().fill('a/b.png');
  await s.page.keyboard.press('Enter');
  assert.match(await s.page.locator('.app-photos .dialog .field-hint').last().textContent(), /valid file name/);
  await s.page.keyboard.press('Escape');
});

await test('slideshow: full screen, advances on its own, Space pauses, Esc exits', async () => {
  await ensureViewer();
  await appEval((a) => a.lib.setPref('slideshowInterval', 2));
  await s.page.locator('.app-photos .ph-stage').last().focus();
  await s.page.keyboard.press('F5');
  await s.page.waitForSelector('.app-photos .ph-slideshow:not([hidden]) .ph-ss-img');
  assert.equal(await s.aurora(() => window.__aurora.wm.byApp('photos').at(-1).fullscreen), true);
  const i0 = await appEval((a) => a.slideshow.index);
  await s.page.waitForFunction((i) => [...document.querySelectorAll('.win.app-photos')].pop().__photos.slideshow.index !== i, i0, { timeout: 6000 });
  await docShot(s, 'slideshow');
  await s.page.keyboard.press(' ');
  assert.equal(await appEval((a) => a.slideshow.playing), false);
  const i1 = await appEval((a) => a.slideshow.index);
  await s.page.waitForTimeout(2600);
  assert.equal(await appEval((a) => a.slideshow.index), i1, 'paused');
  await s.page.keyboard.press('ArrowRight');
  await s.page.waitForTimeout(150);
  assert.notEqual(await appEval((a) => a.slideshow.index), i1, 'arrow browses while paused');
  // Ken Burns transition
  await appEval((a) => a.lib.setPref('slideshowTransition', 'kenburns'));
  await s.page.keyboard.press(' ');
  await s.page.waitForTimeout(2500);
  const kb = await s.page.evaluate(() => document.querySelector('.app-photos .ph-ss-layer:last-child .ph-ss-img')?.getAnimations().length || 0);
  assert.ok(kb >= 1, 'pan & zoom animation running');
  await s.page.keyboard.press('Escape');
  await s.page.waitForFunction(() => [...document.querySelectorAll('.win.app-photos')].pop().__photos.mode === 'viewer');
  assert.equal(await s.aurora(() => window.__aurora.wm.byApp('photos').at(-1).fullscreen), false);
  await appEval((a) => (a.lib.setPref('slideshowTransition', 'crossfade'), a.lib.setPref('slideshowInterval', 5)));
});

await test('viewer: full screen (F11) hides the chrome when idle; Esc leaves full screen first', async () => {
  await ensureViewer();
  await s.page.locator('.app-photos .ph-stage').last().focus();
  await s.page.keyboard.press('F11');
  assert.equal(await s.aurora(() => window.__aurora.wm.byApp('photos').at(-1).fullscreen), true);
  await s.page.waitForTimeout(2900);
  assert.equal(await s.page.locator('.app-photos .ph-viewer.fs.idle').count(), 1, 'chrome hidden when idle');
  await s.page.mouse.move(400, 400);
  await s.page.mouse.move(420, 420);
  assert.equal(await s.page.locator('.app-photos .ph-viewer.fs.idle').count(), 0);
  await s.page.keyboard.press('Escape');
  assert.equal(await s.aurora(() => window.__aurora.wm.byApp('photos').at(-1).fullscreen), false);
  assert.equal(await appEval((a) => a.mode), 'viewer', 'still in the viewer');
});

await test('drag & drop: thumbnails carry file paths; dropped pictures open in the viewer', async () => {
  await toGallery();
  const payload = await s.page.evaluate(() => {
    const tile = document.querySelector('.app-photos .ph-gallery .ph-tile');
    const dt = new DataTransfer();
    tile.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    const r = { aurora: dt.getData('application/x-aurora-paths'), uri: dt.getData('text/uri-list'), name: tile._item.path };
    tile.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    return r;
  });
  assert.deepEqual(JSON.parse(payload.aurora), [payload.name]);
  assert.ok(payload.uri.startsWith('file:///'));
  const a = path.join(home, 'Pictures', 'photo-05.png');
  const b = path.join(home, 'Pictures', 'photo-07.png');
  await appEval((x, arg) => x.openDropped(arg), [a, b, path.join(home, 'Pictures', 'notes.txt')]);
  await waitViewerImage('photo-05.png');
  const st = await viewerState();
  assert.equal(st.count, 2, 'only the dropped pictures');
});

await test('formats: GIF, SVG, BMP, WebP thumbnails; damaged file shows a placeholder and an error', async () => {
  await toGallery();
  await nav('gallery');
  const st = await appEval(async (a) => {
    const want = ['animation.gif', 'vector.svg', 'bitmap.bmp', 'web-image.webp', 'IMG_2000.jpg', 'zz-corrupt.jpg'];
    const out = {};
    for (const n of want) {
      const it = a.lib.items.find((x) => x.name === n);
      const url = await a.thumbs.request(it, 3);
      out[n] = { url: !!url, failed: a.thumbs.isFailed(it), w: it.w, h: it.h };
      if (url && n === 'IMG_2000.jpg') {
        const img = new Image();
        img.src = url;
        await img.decode();
        out[n].thumb = [img.naturalWidth, img.naturalHeight];
      }
    }
    return out;
  });
  for (const n of ['animation.gif', 'vector.svg', 'bitmap.bmp', 'web-image.webp']) assert.ok(st[n].url && !st[n].failed, `${n} thumbnail: ${JSON.stringify(st[n])}`);
  assert.deepEqual([st['animation.gif'].w, st['animation.gif'].h], [160, 120]);
  assert.deepEqual([st['vector.svg'].w, st['vector.svg'].h], [640, 480]);
  const [tw, th] = st['IMG_2000.jpg'].thumb;
  assert.equal(tw > th, st['IMG_2000.jpg'].w > st['IMG_2000.jpg'].h, `thumbnail follows the EXIF orientation (${tw}x${th})`);
  assert.equal(st['zz-corrupt.jpg'].failed, true, 'damaged file has no thumbnail');
  // The viewer shows an error for the damaged file, the SVG renders as an <img> (its script never runs).
  await appEval((a, p) => a.openFile(p), path.join(home, 'Pictures', 'Screenshots', 'zz-corrupt.jpg'));
  await s.page.waitForSelector('.app-photos .ph-verror:not([hidden])');
  assert.match(await s.page.locator('.app-photos .ph-verror').last().textContent(), /Can’t open this picture/);
  await s.page.keyboard.press('ArrowLeft');
  await waitViewerImage(sortedNames(path.join(home, 'Pictures', 'Screenshots')).at(-2));
  assert.equal(await s.page.locator('.app-photos .ph-verror').last().isHidden(), true, 'error cleared on the next photo');
  await appEval((a, p) => a.openFile(p), path.join(home, 'Pictures', 'vector.svg'));
  await waitViewerImage('vector.svg');
  const svgSt = await viewerState();
  assert.ok(svgSt.z.s > 1 || svgSt.nw >= 640, 'SVG scales to fit');
  const svgDom = await s.page.evaluate(() => ({ inline: document.querySelectorAll('.app-photos .ph-imgwrap svg').length, img: [...document.querySelectorAll('.app-photos .ph-imgwrap img.ph-img')].pop()?.src || '' }));
  assert.equal(svgDom.inline, 0, 'never inlined');
  assert.match(svgDom.img, /^media:\/\/local\/.*vector\.svg/, 'shown through <img>');
  await appEval((a, p) => a.openFile(p), path.join(home, 'Pictures', 'animation.gif'));
  await waitViewerImage('animation.gif');
});

await test('viewer: Esc closes a viewer opened from a file; “See all photos” switches to the gallery', async () => {
  await launchPhotos(s, { file: path.join(home, 'Pictures', 'photo-02.png') });
  await waitViewerImage('photo-02.png');
  const n0 = await s.aurora(() => window.__aurora.wm.byApp('photos').length);
  await s.page.locator('.app-photos .ph-stage').last().focus();
  await s.page.keyboard.press('Escape');
  await s.page.waitForFunction((n) => window.__aurora.wm.byApp('photos').length === n - 1, n0);
  await launchPhotos(s, { file: path.join(home, 'Pictures', 'photo-02.png') });
  await waitViewerImage('photo-02.png');
  await s.page.locator('.app-photos .ph-vback').last().click();
  await s.page.waitForFunction(() => [...document.querySelectorAll('.win.app-photos')].pop().__photos.mode === 'gallery');
  await waitTiles(s, 5);
  await closePhotos(s);
});

await test('live language switch keeps the current photo; right-click menus', async () => {
  await toGallery();
  await nav('gallery');
  // Right-click on the gallery background.
  const box = await s.page.locator('.app-photos .ph-scroll').last().boundingBox();
  await s.page.mouse.click(box.x + box.width - 30, box.y + box.height - 10, { button: 'right' });
  let items = await s.page.locator('.menu .menu-item').allTextContents();
  assert.ok(items.some((x) => x.includes('Add a folder')) && items.some((x) => x.includes('Select all')), items.join(' | '));
  await s.page.keyboard.press('Escape');
  await s.page.locator('.app-photos .ph-gallery .ph-tile').nth(1).click();
  await s.page.waitForFunction(() => [...document.querySelectorAll('.win.app-photos')].pop().__photos.mode === 'viewer');
  const name = (await viewerState()).name;
  // Right-click on the photo.
  const st = await s.page.locator('.app-photos .ph-stage').last().boundingBox();
  await s.page.mouse.click(st.x + st.width / 2, st.y + st.height / 2, { button: 'right' });
  items = await s.page.locator('.menu .menu-item').allTextContents();
  assert.ok(items.some((x) => x.includes('Set as')) && items.some((x) => x.includes('Save as')), items.join(' | '));
  await s.page.keyboard.press('Escape');
  await s.aurora(() => window.__aurora.settings.set('lang', 'fr'));
  await s.page.waitForFunction(() => /Modifier/.test(document.querySelector('.app-photos .ph-tb-edit')?.textContent || ''), null, { timeout: 10000 });
  assert.equal((await viewerState()).name, name, 'same photo after the switch');
  assert.equal(await s.page.locator('.app-photos .ph-search').count(), 1, 'one search box (in the gallery header)');
  assert.equal(await s.page.locator('.app-photos .win-titlebar .ph-search').count(), 0, 'the title bar holds no search box');
  await s.page.locator('.app-photos .ph-stage').last().focus();
  await s.page.keyboard.press('Escape');
  const back = await s.page
    .waitForFunction(() => document.querySelector('.app-photos .ph-title')?.textContent === 'Galerie', null, { timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  if (!back) {
    // Diagnose instead of a bare timeout (this step was seen flaking once under heavy load).
    const dbg = await s.page.evaluate(() => {
      const a = [...document.querySelectorAll('.win.app-photos')].pop()?.__photos;
      const el = document.activeElement;
      return { mode: a?.mode, from: a?.viewer?.from, viewerFrom: a?.viewerFrom, active: el ? `${el.tagName}.${el.className}` : null, menus: document.querySelectorAll('.menu').length, dialogs: document.querySelectorAll('.dialog-layer').length, wins: window.__aurora.wm.list().map((w) => w.appId), titles: [...document.querySelectorAll('.app-photos .ph-title')].map((x) => x.textContent) };
    });
    assert.fail(`Esc did not return to the gallery: ${JSON.stringify(dbg)}`);
  }
  await s.aurora(() => window.__aurora.settings.set('lang', 'en'));
  await s.page.waitForFunction(() => document.querySelector('.app-photos .ph-title')?.textContent === 'Gallery');
  assert.equal(await s.page.locator('.app-photos .ph-search').count(), 1);
});

async function noOverflow(selectors) {
  return s.page.evaluate((sels) => {
    const bad = [];
    for (const sel of sels)
      for (const el of document.querySelectorAll(sel)) {
        if (!el.offsetParent) continue;
        if (el.scrollWidth > el.clientWidth + 1) bad.push(`${sel} (${el.scrollWidth} > ${el.clientWidth}): ${el.textContent.slice(0, 60)}`);
      }
    return bad;
  }, selectors);
}

await test('window sizes: minimum size and maximized layouts have no overflow', async () => {
  await toGallery();
  await nav('gallery');
  await s.aurora(() => {
    const w = window.__aurora.wm.byApp('photos').at(-1);
    w.restore?.();
    w.setRect({ x: 60, y: 40, width: 500, height: 420 });
  });
  await s.page.waitForTimeout(500);
  const r = await s.page.locator('.win.app-photos').last().boundingBox();
  assert.ok(r.width <= 502 && r.height <= 422, `min size ${r.width}x${r.height}`);
  assert.deepEqual(await noOverflow(['.app-photos .ph-head', '.app-photos .ph-cmds', '.app-photos .ph-nav']), []);
  assert.equal(await s.page.locator('.app-photos .ph-nav-label').first().isVisible(), false, 'navigation collapses to icons');
  await waitThumbsLoaded(s);
  await docShot(s, 'gallery-small');
  await appEval((a) => a.gallery.grid.scroll.focus());
  await s.page.keyboard.press('Enter');
  await s.page.waitForFunction(() => [...document.querySelectorAll('.win.app-photos')].pop().__photos.mode === 'viewer');
  await s.page.waitForTimeout(500);
  assert.deepEqual(await noOverflow(['.app-photos .ph-vtools', '.app-photos .ph-vbottom', '.app-photos .ph-zoom']), []);
  const tb = await s.page.locator('.app-photos .ph-vtools').last().boundingBox();
  assert.ok(tb.x >= r.x && tb.x + tb.width <= r.x + r.width, 'toolbar inside the window');
  await docShot(s, 'viewer-small');
  // Editor at the minimum size: the tool panel becomes a bottom sheet.
  await s.page.locator('.app-photos .ph-stage').last().focus();
  await s.page.keyboard.press('Control+e');
  await s.page.waitForFunction(() => [...document.querySelectorAll('.win.app-photos')].pop().__photos.editor?.preview);
  await s.page.waitForTimeout(400);
  assert.equal(await s.page.locator('.app-photos .ph-editor.narrow').count(), 1);
  assert.deepEqual(await noOverflow(['.app-photos .ph-etop-right', '.app-photos .ph-etop-left', '.app-photos .ph-etab']), []);
  const sheet = await s.page.locator('.app-photos .ph-epanel').last().boundingBox();
  const cv = await s.page.locator('.app-photos .ph-ecanvas-wrap').last().boundingBox();
  assert.ok(cv.y + cv.height <= sheet.y + 1, 'preview above the tool sheet');
  await docShot(s, 'editor-small');
  await appEval((a) => a.closeEditor({ force: true }));
  await s.aurora(() => window.__aurora.wm.byApp('photos').at(-1).maximize());
  await s.page.waitForTimeout(500);
  await docShot(s, 'viewer-maximized');
  await s.aurora(() => window.__aurora.wm.byApp('photos').at(-1).restore());
});

let errs = consoleErrors(s);
await test('no console errors in English / light', async () => {
  assert.deepEqual(errs, []);
});
await s.close();

// ------------------------------------------------------------------ French + dark (same HOME: warm caches)
s = await launchShell({ home, keepHome: true, theme: 'dark', lang: 'fr' });
current = s;

await test('FR + dark: gallery, viewer, editor and settings are translated and fit', async () => {
  await launchPhotos(s);
  await waitTiles(s, 10);
  await waitThumbsLoaded(s);
  const groups = await appEval((a) => a.gallery.grid.groups.map((g) => g.label));
  assert.ok(groups.includes('juillet 2024'), groups.join(', '));
  assert.equal(await s.page.locator('.app-photos .ph-title').last().textContent(), 'Galerie');
  const navs = await s.page.locator('.app-photos .ph-nav-label').allTextContents();
  assert.deepEqual(navs, ['Galerie', 'Favoris', 'Albums', 'Dossiers', 'Paramètres']);
  assert.deepEqual(await noOverflow(['.app-photos .ph-head', '.app-photos .ph-cmds']), []);
  await docShot(s, 'gallery-fr-dark');
  // Viewer + info
  await s.page.locator('.app-photos .ph-gallery .ph-tile').first().click();
  await s.page.waitForFunction(() => [...document.querySelectorAll('.win.app-photos')].pop().__photos.mode === 'viewer');
  await s.page.keyboard.press('i');
  await s.page.waitForSelector('.app-photos .ph-info .ph-info-row');
  await s.page.waitForTimeout(400);
  const info = await s.page.locator('.app-photos .ph-info').last().textContent();
  assert.match(info, /Informations sur le fichier/);
  assert.match(info, /Ouvrir l’emplacement du fichier/);
  assert.deepEqual(await noOverflow(['.app-photos .ph-vtools', '.app-photos .ph-vbottom-left', '.app-photos .ph-zoom']), []);
  await docShot(s, 'viewer-fr-dark');
  await s.page.keyboard.press('i');
  // Editor
  await s.page.locator('.app-photos .ph-stage').last().focus();
  await s.page.keyboard.press('Control+e');
  await s.page.waitForFunction(() => [...document.querySelectorAll('.win.app-photos')].pop().__photos.editor?.preview);
  await s.page.locator('.app-photos .ph-etab[data-tool="filter"]').last().click();
  await s.page.waitForTimeout(300);
  assert.deepEqual(await noOverflow(['.app-photos .ph-etop', '.app-photos .ph-etabs', '.app-photos .ph-epanel']), []);
  await docShot(s, 'editor-fr-dark');
  await s.page.locator('.app-photos .ph-etab[data-tool="adjust"]').last().click();
  assert.match(await s.page.locator('.app-photos .ph-epanel').last().textContent(), /Luminosité.*Hautes lumières/s);
  await appEval((a) => a.closeEditor({ force: true }));
  await appEval((a) => a.closeViewer());
  // Settings page
  await nav('settings');
  await s.page.waitForSelector('.app-photos .ph-settings');
  assert.match(await s.page.locator('.app-photos .ph-settings').textContent(), /Durée par photo/);
  await docShot(s, 'settings-fr-dark');
  // Settings change applies (thumbnail size large).
  await s.page.locator('.app-photos .ph-set-row .select').nth(0).selectOption('large');
  assert.equal(await appEval((a) => a.lib.prefs.thumbSize), 'large');
  await nav('gallery');
  await waitTiles(s, 3);
  const h = await s.page.evaluate(() => Math.max(...[...document.querySelectorAll('.app-photos .ph-gallery .ph-row')].map((r) => r.getBoundingClientRect().height)));
  assert.ok(h > 220, `large rows (${h}px)`);
  await appEval((a) => a.lib.setPref('thumbSize', 'medium'));
  // Viewer background follows the setting.
  await appEval((a) => a.lib.setPref('viewerBackground', 'theme'));
  assert.equal(await appEval((a) => a.root.dataset.bg), 'theme');
  await appEval((a) => a.lib.setPref('viewerBackground', 'dark'));
  assert.equal(await appEval((a) => a.root.dataset.bg), 'dark');
});

await test('FR: Pictures folder header, menu key names and tooltips are French', async () => {
  await toGallery();
  await nav('folders');
  await s.page.waitForFunction(() => document.querySelector('.app-photos .ph-tree-row.selected'));
  await s.page.waitForTimeout(400);
  assert.equal(await s.page.locator('.app-photos .ph-title').last().textContent(), 'Images', 'Pictures root shown as "Images"');
  assert.equal(await s.page.locator('.app-photos .ph-tree-row').first().textContent(), 'Images');
  await nav('gallery');
  await waitTiles(s, 3);
  const tile = await s.page.locator('.app-photos .ph-gallery .ph-tile').first().boundingBox();
  await s.page.mouse.click(tile.x + 20, tile.y + 20, { button: 'right' });
  await s.page.waitForSelector('.menu .menu-item');
  const shortcuts = await s.page.locator('.menu .menu-item .shortcut').allTextContents();
  await s.page.keyboard.press('Escape');
  assert.ok(shortcuts.includes('Entrée') && shortcuts.includes('Suppr'), shortcuts.join(' | '));
  assert.ok(!shortcuts.some((k) => /^(Enter|Del)$/.test(k)), 'no English key names');
  await s.page.locator('.app-photos .ph-gallery .ph-tile').first().click();
  await s.page.waitForFunction(() => [...document.querySelectorAll('.win.app-photos')].pop().__photos.mode === 'viewer');
  assert.equal(await s.page.locator('.app-photos [data-cmd="delete"]').last().getAttribute('data-tip'), 'Supprimer (Suppr)');
  assert.match(await s.page.locator('.app-photos .ph-vback').last().getAttribute('data-tip'), /\(Échap\)$/);
  const st = await s.page.locator('.app-photos .ph-stage').last().boundingBox();
  await s.page.mouse.click(st.x + st.width / 2, st.y + st.height / 2, { button: 'right' });
  await s.page.waitForSelector('.menu .menu-item');
  const vk = await s.page.locator('.menu .menu-item .shortcut').allTextContents();
  await s.page.keyboard.press('Escape');
  assert.ok(vk.includes('Ctrl+Maj+S'), vk.join(' | '));
  await appEval((a) => a.startSlideshow(a.viewer.list, a.viewer.index));
  await s.page.waitForTimeout(400);
  assert.equal(await s.page.locator('.app-photos [data-cmd="ss-play"]').last().getAttribute('data-tip'), 'Pause (Espace)');
  await appEval((a) => a.stopSlideshow());
  await appEval((a) => a.closeViewer());
});

errs = consoleErrors(s);
await test('no console errors in French / dark', async () => {
  assert.deepEqual(errs, []);
});
await s.close();
if (!KEEP) fs.rmSync(home, { recursive: true, force: true });
else console.log(`kept: ${home}`);

// ------------------------------------------------------------------ QA hardening: hostile data, error paths, races, leaks
{
  const qhome = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-photos-qa-'));
  const qpics = path.join(qhome, 'Pictures');
  fs.mkdirSync(qpics, { recursive: true });
  const put = (dir, name, buf, ms = NOW) => {
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, name);
    fs.writeFileSync(p, buf);
    setTime(p, ms);
    return p;
  };
  const HOSTILE = ['<img src=x onerror="window.__phx=1">.png', '"q\' & <b>bold.png', 'new\nline.png', '#hash?query%2e.png', `${'long-name-'.repeat(23)}end.png`];
  HOSTILE.forEach((n, i) => put(qpics, n, png(320, 200, i), NOW - i * 3600e3));
  const evilDir = path.join(qpics, '<svg onload="window.__phx3=1">');
  put(evilDir, 'inside.png', png(200, 300, 3), NOW - 86400e3);
  for (let i = 0; i < 12; i++) put(path.join(qpics, 'Batch'), `b${String(i).padStart(2, '0')}.png`, png(400, 300, i), NOW - 40 * 86400e3 - i * 1000);
  put(qpics, 'hostile.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200" onload="window.top.__phx4=1"><script>window.top.__phx5=1</script><rect width="300" height="200" fill="teal"/></svg>'), NOW - 5 * 86400e3);
  s = await launchShell({ home: qhome, keepHome: true, theme: 'light', lang: 'en' });
  current = s;
  const jpg = Buffer.from(
    await s.page.evaluate(async () => {
      const c = document.createElement('canvas');
      c.width = 400;
      c.height = 300;
      c.getContext('2d').fillRect(0, 0, 400, 300);
      const b = new Uint8Array(await (await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9))).arrayBuffer());
      let bin = '';
      for (const v of b) bin += String.fromCharCode(v);
      return btoa(bin);
    }),
    'base64',
  );
  put(qpics, 'exif-evil.jpg', withExif(jpg, { make: '<img src=x onerror="window.__phx2=1">', model: '<script>window.__phx6=1</script>Z9', date: '2024:01:02 03:04:05' }), NOW - 2 * 86400e3);
  const dialogs = () => s.page.evaluate(() => [...document.querySelectorAll('.dialog-layer:not(.closing)')].map((d) => d.textContent));
  const dismiss = async () => {
    for (let i = 0; i < 4 && (await dialogs()).length; i++) {
      await s.page.keyboard.press('Escape');
      await s.page.waitForTimeout(250);
    }
  };

  await test('security: hostile file / folder names and EXIF text are shown as text, never run as HTML', async () => {
    await launchPhotos(s);
    await waitTiles(s, 10);
    const names = await appEval((a) => a.lib.items.map((x) => x.name));
    for (const n of HOSTILE) assert.ok(names.includes(n), `listed: ${JSON.stringify(n)}`);
    // Viewer + info pane for every picture, folders page with the hostile folder, an album with a hostile name, search.
    await appEval(async (a) => {
      for (let i = 0; i < a.lib.items.length; i++) {
        a.openViewer(a.lib.items, i, { from: 'gallery' });
        a.viewer.toggleInfo(true);
        await new Promise((r) => setTimeout(r, 120));
      }
    });
    await s.page.waitForTimeout(500);
    const info = await appEval(async (a) => {
      a.viewer.show(a.lib.items.findIndex((x) => x.name === 'exif-evil.jpg'));
      await new Promise((r) => setTimeout(r, 700));
      return a.viewer.info.textContent;
    });
    assert.match(info, /<img src=x onerror="window.__phx2=1"> <script>window.__phx6=1<\/script>Z9/, 'EXIF camera text shown literally');
    await appEval((a) => (a.closeViewer(), a.gallery.navigate({ page: 'folders' })));
    await s.page.waitForTimeout(500);
    await appEval((a, d) => a.gallery._selectFolder(d), evilDir);
    await s.page.waitForTimeout(600);
    assert.equal(await s.page.locator('.app-photos .ph-title').last().textContent(), path.basename(evilDir));
    await appEval((a) => {
      a.lib.createAlbum('<img src=x onerror="window.__phx7=1">', a.lib.items.slice(0, 2).map((x) => x.path));
      a.gallery.navigate({ page: 'albums' });
    });
    await s.page.waitForTimeout(400);
    await appEval((a) => {
      a.gallery.navigate({ page: 'gallery' });
      a.gallery.searchInput.value = '<img src=x onerror=window.__phx8=1>';
      a.gallery.search(a.gallery.searchInput.value);
    });
    await s.page.waitForTimeout(400);
    const flags = await s.page.evaluate(() => Object.keys(window).filter((k) => k.startsWith('__phx')));
    assert.deepEqual(flags, [], 'no injected script ran');
    assert.equal(await s.page.locator('.app-photos b, .app-photos script, .app-photos img[src="x"], .app-photos svg[onload]').count(), 0, 'no injected elements');
    await appEval((a) => (a.gallery.searchInput.value = '', a.gallery.search('')));
  });

  await test('errors: a missing file never blocks the launch; background / copy refuse missing files; plain-word messages', async () => {
    await closePhotos(s);
    const t0 = Date.now();
    await s.aurora(async () => {
      await window.__aurora.registry.launch('photos', { file: '/nonexistent/dir/ghost.png' });
    });
    assert.ok(Date.now() - t0 < 8000, 'launch() resolves without waiting for the alert');
    await s.page.waitForFunction(() => document.querySelector('.app-photos .dialog-layer'));
    assert.match((await dialogs()).join(' '), /ghost\.png/);
    assert.equal(await appEval((a) => a.mode), 'gallery', 'gallery underneath the message');
    await dismiss();
    // A picture deleted behind Photos' back.
    const victim = put(qpics, 'victim.png', png(300, 200, 9), NOW + 1000);
    await closePhotos(s);
    await launchPhotos(s, { file: victim });
    await s.page.waitForFunction(() => [...document.querySelectorAll('.win.app-photos')].pop().__photos.viewer?.img?.complete);
    fs.unlinkSync(victim);
    const wp0 = await s.aurora(() => window.__aurora.settings.get('wallpaper'));
    await appEval((a) => a.setAs('desktop', a.viewer.item));
    await s.page.waitForFunction(() => document.querySelector('.app-photos .dialog-layer'));
    assert.match((await dialogs()).join(' '), /background[\s\S]*moved or deleted/, 'plain explanation');
    assert.equal(await s.aurora(() => window.__aurora.settings.get('wallpaper')), wp0, 'wallpaper unchanged');
    await dismiss();
    await s.aurora(() => window.__aurora.shell.clipboard.setFiles(['/tmp/marker'], 'copy'));
    await appEval((a) => a.copyItems([a.viewer.item]));
    await s.page.waitForTimeout(400);
    assert.deepEqual((await s.aurora(() => window.__aurora.shell.clipboard.getFiles())).paths, ['/tmp/marker'], 'clipboard untouched');
    assert.match((await dialogs()).join(' '), /victim\.png” was moved or deleted/);
    await dismiss();
    await appEval((a) => a.rotateFile(a.viewer.item, 1).catch((err) => void a.error(a.t('rotateFailed'), err)));
    await s.page.waitForFunction(() => document.querySelector('.app-photos .dialog-layer'));
    const msg = (await dialogs()).join(' ');
    assert.match(msg, /Couldn’t rotate this photo[\s\S]*The file was moved or deleted\./);
    assert.doesNotMatch(msg, /HTTP|ENOENT/, 'no raw error codes');
    await dismiss();
    // A save that fails for lack of permission says so in plain words.
    const ok = await appEval((a) => [a.errorText({ code: 'EACCES', message: "EACCES: permission denied, open '/x'" }), a.errorText({ code: 'ENOSPC', message: 'ENOSPC' }), a.errorText(new Error('decode'))]);
    assert.deepEqual(ok, ['You don’t have permission to use this location.', 'There isn’t enough space on the disk.', 'This file isn’t a valid picture.']);
  });

  await test('races: double close, double save, double delete and restarting a slideshow stay single and consistent', async () => {
    await closePhotos(s);
    const target = path.join(qpics, 'Batch', 'b03.png');
    await launchPhotos(s, { file: target });
    await waitViewerImage('b03.png');
    await appEval((a) => a.openEditor(a.viewer.item));
    await s.page.waitForFunction(() => [...document.querySelectorAll('.win.app-photos')].pop().__photos.editor?.preview);
    await appEval((a) => a.editor.setEdit({ rot: 1 }));
    // Close button clicked twice: one prompt.
    await s.aurora(() => {
      const w = window.__aurora.wm.byApp('photos').at(-1);
      w.close();
      setTimeout(() => w.close(), 30);
    });
    await s.page.waitForTimeout(700);
    assert.equal((await dialogs()).length, 1, 'one unsaved-changes prompt');
    await dismiss();
    assert.equal(await s.aurora(() => window.__aurora.wm.byApp('photos').length), 1, 'Cancel keeps the window');
    // Save twice in a row (double click / Ctrl+S repeat): one save picker.
    await s.aurora(() => {
      const a = [...document.querySelectorAll('.win.app-photos')].pop().__photos;
      a.editor.save('copy');
      a.editor.save('copy');
    });
    await s.page.waitForTimeout(700);
    assert.equal((await dialogs()).length, 1, 'one save picker');
    await dismiss();
    await appEval((a) => a.closeEditor({ force: true }));
    await s.page.waitForFunction(() => [...document.querySelectorAll('.win.app-photos')].pop().__photos.mode === 'viewer');
    // Double click on Delete (no confirmation): the file is trashed once, no error.
    await appEval((a) => a.lib.setPref('confirmDelete', false));
    const before = await appEval((a) => a.viewer.list.length);
    await s.page.locator('.app-photos [data-cmd="delete"]').last().dblclick();
    await s.page.waitForTimeout(1200);
    assert.deepEqual(await dialogs(), [], 'no "couldn’t delete" error');
    assert.equal(await appEval((a) => a.viewer.list.length), before - 1, 'one file deleted');
    assert.equal(fs.existsSync(target), false);
    await appEval((a) => a.lib.setPref('confirmDelete', true));
    // Starting a slideshow twice from a viewer opened from a file: Esc returns to that viewer.
    await appEval((a) => {
      a.startSlideshow(a.viewer.list, a.viewer.index);
      a.startSlideshow(a.viewer.list, a.viewer.index);
    });
    await s.page.waitForTimeout(600);
    await s.page.keyboard.press('Escape');
    await s.page.waitForFunction(() => [...document.querySelectorAll('.win.app-photos')].pop().__photos.mode === 'viewer');
    assert.equal(await appEval((a) => !a.viewer.el.hidden && !!a.viewer.item), true, 'viewer shown again');
  });

  await test('slideshow: unreadable pictures are skipped, an all-unreadable list stops with a message; paused browsing stays still', async () => {
    await appEval((a) => {
      a.lib.setPref('slideshowLoop', true);
      const bad = ['/nope/a.png', '/nope/b.png'].map((p) => ({ path: p, name: p.slice(6), ext: '.png', mtime: 1, size: 1 }));
      a.startSlideshow(bad, 0);
    });
    await s.page.waitForFunction(() => [...document.querySelectorAll('.win.app-photos')].pop().__photos.mode === 'viewer', null, { timeout: 8000 });
    assert.match((await dialogs()).join(' '), /None of these pictures can be shown/);
    await dismiss();
    // Ken Burns: browsing while paused shows the next photo without starting its motion.
    await appEval((a) => {
      a.lib.setPref('slideshowTransition', 'kenburns');
      a.startSlideshow(a.viewer.list, 0);
    });
    await s.page.waitForTimeout(900);
    await s.page.keyboard.press(' ');
    await s.page.keyboard.press('ArrowRight');
    await s.page.waitForTimeout(1300);
    const running = await s.page.evaluate(() =>
      [...document.querySelectorAll('.app-photos .ph-ss-img')].flatMap((i) => i.getAnimations()).filter((x) => x.playState === 'running').length,
    );
    assert.equal(running, 0, 'no Ken Burns motion while paused');
    assert.equal(await appEval((a) => a.slideshow.pos), 1);
    await s.page.keyboard.press('Escape');
    await appEval((a) => a.lib.setPref('slideshowTransition', 'crossfade'));
  });

  await test('thumbnails: a late answer from a slow worker is never used for another picture', async () => {
    const r = await appEval(async (a) => {
      const T = a.thumbs;
      const item = a.lib.items.find((x) => x.name === 'b05.png');
      T.forget(item);
      T.failed.delete(item.key);
      const posted = [];
      const slot = { busy: false, cb: null, w: { postMessage: (m) => posted.push(m), terminate() {} } };
      const job = { item, resolve() {}, prio: 0, seq: 4242 };
      const run = T._run(job, slot);
      // A stale answer (another job's id) arrives first: it must be ignored...
      const stale = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/webp' });
      slot.cb?.({ id: 4241, blob: stale, w: 1, h: 1 });
      const stillWaiting = !!slot.cb;
      // ...then this job's own failure: the main-thread fallback makes the real thumbnail.
      slot.cb?.({ id: 4242, error: 'boom' });
      await run;
      const url = T.url(item);
      const img = new Image();
      img.src = url;
      await img.decode();
      return { posted: posted.length, stillWaiting, w: img.naturalWidth, h: img.naturalHeight };
    });
    assert.equal(r.posted, 1);
    assert.equal(r.stillWaiting, true, 'stale message ignored');
    assert.ok(r.w > 100 && r.h > 50, `real thumbnail ${r.w}x${r.h}`);
  });

  await test('keyboard: arrows on the focused zoom slider zoom instead of browsing photos', async () => {
    await appEval((a) => a.viewer.go(2));
    await s.page.waitForTimeout(400);
    const i0 = await appEval((a) => a.viewer.index);
    const s0 = await appEval((a) => a.viewer.z.s);
    await s.page.locator('.app-photos .ph-zoom-slider').last().focus();
    for (let k = 0; k < 6; k++) await s.page.keyboard.press('ArrowRight');
    await s.page.waitForTimeout(200);
    assert.equal(await appEval((a) => a.viewer.index), i0, 'same photo');
    assert.ok((await appEval((a) => a.viewer.z.s)) > s0, 'zoomed in');
    await s.page.locator('.app-photos .ph-stage').last().focus();
    await s.page.keyboard.press('Control+0');
  });

  await test('leaks: opening and closing Photos 15 times leaves no window, listener or folder watcher behind', async () => {
    await closePhotos(s);
    const nodes0 = await s.page.evaluate(() => document.getElementsByTagName('*').length);
    for (let i = 0; i < 15; i++) {
      await launchPhotos(s, i % 3 === 1 ? { file: path.join(qpics, 'Batch', 'b01.png') } : undefined);
      if (i % 5 === 2) await appEval((a) => a.openEditor(a.lib.items.find((x) => x.name === 'b02.png')));
      await s.page.waitForTimeout(250);
      await closePhotos(s);
    }
    await s.page.waitForTimeout(600);
    const st = await s.page.evaluate(async () => {
      const L = (await import('app://shell/apps/photos/lib/library.js')).sharedLibrary();
      const T = (await import('app://shell/apps/photos/lib/thumbs.js')).sharedThumbs();
      return { subs: L.subs.size, users: L.users, watch: L._watchId, thumbListeners: T.listeners.size, queue: T.queue.length, pending: T.pending.size, nodes: document.getElementsByTagName('*').length, menus: document.querySelectorAll('.menu, .dialog-layer').length };
    });
    assert.deepEqual({ subs: st.subs, users: st.users, watch: st.watch, thumbListeners: st.thumbListeners, menus: st.menus }, { subs: 0, users: 0, watch: null, thumbListeners: 0, menus: 0 });
    assert.ok(st.nodes <= nodes0 + 5, `DOM back to its size (${nodes0} -> ${st.nodes})`);
    assert.deepEqual(consoleErrors(s).filter((l) => !/404 \(Not Found\)/.test(l)), [], 'no console errors (404s are the deliberately missing files)');
  });

  await s.close();
  if (!KEEP) fs.rmSync(qhome, { recursive: true, force: true });
}

// ------------------------------------------------------------------ performance: 1000 pictures
await test('performance: 1000 pictures — first paint, virtualization, scroll frame times, warm start', async () => {
  const phome = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-photos-perf-'));
  const pics = path.join(phome, 'Pictures');
  fs.mkdirSync(pics, { recursive: true });
  const shapes = [[160, 120], [120, 160], [200, 100], [150, 150], [180, 120], [96, 160]];
  const t0 = Date.now();
  for (let i = 0; i < 1000; i++) {
    const [w, h] = shapes[i % shapes.length];
    const sub = path.join(pics, `set-${Math.floor(i / 100)}`);
    fs.mkdirSync(sub, { recursive: true });
    const p = path.join(sub, `img-${String(i).padStart(4, '0')}.png`);
    fs.writeFileSync(p, png(w, h, i));
    setTime(p, NOW - i * 0.75 * 86400000);
  }
  console.log(`      generated 1000 pictures in ${Date.now() - t0} ms`);
  try {
  s = await launchShell({ home: phome, keepHome: true, theme: 'light', lang: 'en' });
  current = s;
  const tl = Date.now();
  await launchPhotos(s);
  await waitTiles(s, 10);
  const tTiles = Date.now() - tl;
  await waitThumbsLoaded(s, 60000);
  const tFirst = Date.now() - tl;
  const count = await appEval((a) => a.lib.items.length);
  assert.equal(count, 1000);
  const groups = await appEval((a) => a.gallery.grid.groups.length);
  const domTiles = await s.page.locator('.app-photos .ph-tile').count();
  console.log(`      cold: tiles laid out after ${tTiles} ms, visible thumbnails loaded after ${tFirst} ms; ${groups} month groups; ${domTiles} tiles in the DOM`);
  assert.ok(domTiles < 250, `virtualized (${domTiles} DOM tiles for 1000 items)`);
  assert.ok(tTiles < 8000, `tiles within 8 s cold (${tTiles} ms)`);
  // Scroll through the whole gallery measuring frame times.
  const perf = await s.page.evaluate(async () => {
    const a = [...document.querySelectorAll('.win.app-photos')].pop().__photos;
    const grid = a.gallery.grid;
    const sc = grid.scroll;
    const frames = [];
    let maxTiles = 0;
    const st0 = { ...grid.renderStats };
    let last = performance.now();
    const total = sc.scrollHeight - sc.clientHeight;
    const steps = 240;
    for (let i = 1; i <= steps; i++) {
      sc.scrollTop = (total * i) / steps;
      await new Promise((r) => requestAnimationFrame(r));
      const now = performance.now();
      frames.push(now - last);
      last = now;
      maxTiles = Math.max(maxTiles, document.querySelectorAll('.app-photos .ph-tile').length);
    }
    const calls = grid.renderStats.calls - st0.calls;
    const jsMs = grid.renderStats.ms - st0.ms;
    frames.sort((x, y) => x - y);
    return {
      avg: frames.reduce((x, y) => x + y, 0) / frames.length,
      p50: frames[Math.floor(frames.length / 2)],
      p95: frames[Math.floor(frames.length * 0.95)],
      max: frames.at(-1),
      maxTiles,
      height: sc.scrollHeight,
      renderCalls: calls,
      jsPerFrame: jsMs / Math.max(1, calls),
    };
  });
  const load = os.loadavg()[0].toFixed(1);
  console.log(
    `      scroll ${perf.height}px in 240 steps: grid JS ${perf.jsPerFrame.toFixed(2)} ms/frame (${perf.renderCalls} renders); frame times avg ${perf.avg.toFixed(1)} / p50 ${perf.p50.toFixed(1)} / p95 ${perf.p95.toFixed(1)} / max ${perf.max.toFixed(1)} ms (software rendering, load avg ${load}); max ${perf.maxTiles} tiles in the DOM`,
  );
  assert.ok(perf.maxTiles < 300, 'DOM stays bounded while scrolling');
  // Smoothness proxy independent of the (software) rasterizer and machine load: the grid's own work per frame.
  assert.ok(perf.jsPerFrame < 6, `grid JS per frame ${perf.jsPerFrame.toFixed(2)} ms`);
  assert.ok(perf.p50 < 120, `median frame ${perf.p50.toFixed(1)} ms`);
  await s.page.waitForTimeout(1500);
  await docShot(s, 'gallery-1000');
  // Date scrubber: jump to the middle.
  const sb = await s.page.locator('.app-photos .ph-scrubber').last().boundingBox();
  assert.ok(sb, 'scrubber visible for long galleries');
  await s.page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height * 0.5);
  await s.page.waitForTimeout(200);
  const bubble = await s.page.locator('.app-photos .ph-scrub-bubble').last().textContent();
  assert.match(bubble, /\d{4}$/);
  await s.page.mouse.down();
  await s.page.mouse.up();
  await s.page.waitForTimeout(300);
  const top = await appEval((a) => {
    const g = a.gallery.grid;
    const st = g.scroll.scrollTop;
    const b = g.blocks.find((x) => x.y + x.h > st + 1);
    return g.groups[b.gi].label;
  });
  assert.equal(top, bubble, `scrubber jumped to ${bubble}`);
  // Scrolling a bit further shows the floating month label.
  await appEval((a) => (a.gallery.grid.scroll.scrollTop += 300));
  await s.page.waitForTimeout(150);
  assert.equal(await s.page.locator('.app-photos .ph-sticky .ph-sticky-label').last().textContent(), bubble);
  assert.equal(await s.page.locator('.app-photos .ph-sticky').last().isVisible(), true);
  await docShot(s, 'gallery-scrubber');
  const perfErrs = consoleErrors(s);
  await s.close();
  // Warm start: index + thumbnails are cached on disk.
  s = await launchShell({ home: phome, keepHome: true, theme: 'light', lang: 'en' });
  current = s;
  const tw = Date.now();
  await launchPhotos(s);
  await waitTiles(s, 10);
  await waitThumbsLoaded(s, 60000);
  const tWarm = Date.now() - tw;
  console.log(`      warm start: visible thumbnails after ${tWarm} ms`);
  assert.ok(tWarm < Math.max(3000, tFirst), `warm start faster (${tWarm} ms)`);
  assert.deepEqual([...perfErrs, ...consoleErrors(s)], []);
  } finally {
    await s.close();
    fs.rmSync(phome, { recursive: true, force: true });
  }
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
