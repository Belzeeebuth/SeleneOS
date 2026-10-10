#!/usr/bin/env node
// Renders Aurora's built-in wallpapers: original, procedural abstract artwork drawn with the
// Canvas 2D API inside an offscreen Electron/Chromium window (driven by playwright-core, like
// test/lib.mjs). Output: renderer/assets/wallpapers/<name>.jpg at 2560x1600, JPEG ~q88, < 700 KB.
//
//   xvfb-run -a node tools/gen-wallpapers.mjs                    # all wallpapers
//   xvfb-run -a node tools/gen-wallpapers.mjs --only=bloom-light,aurora --scale=0.5 --out=/tmp/wp
//   xvfb-run -a node tools/gen-wallpapers.mjs --only=dynamic        # the 12 time-of-day variants (dynamic/*.jpg)
//
// Every scene is deterministic (seeded RNG), so re-running produces the same images.
import { _electron as electron } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.slice(n.length + 3) : d;
};

export const NAMES = ['bloom-light', 'bloom-dark', 'glow-light', 'glow-dark', 'flow-light', 'flow-dark', 'sunrise', 'aurora', 'dunes'];
// Time-of-day sets of the dynamic wallpaper (core/wallpaper/dynamic.js): dynamic/<set>-<phase>.jpg
// (the Lakeside night is the original 'aurora' picture, so lake-night is not generated)
export const DYNAMIC_NAMES = ['bloom', 'dunes', 'lake'].flatMap((set) => ['dawn', 'day', 'dusk', 'night'].map((ph) => `dynamic/${set}-${ph}`)).filter((n) => n !== 'dynamic/lake-night');
const only = arg('only', '') ? arg('only', '').split(',').flatMap((n) => (n === 'dynamic' ? DYNAMIC_NAMES : [n])) : [...NAMES, ...DYNAMIC_NAMES];
const scale = Number(arg('scale', '1')) || 1;
const OUT_DIR = path.resolve(arg('out', path.join(here, '..', 'renderer', 'assets', 'wallpapers')));
const MAX_BYTES = 700 * 1024;
const W = Math.round(2560 * scale);
const H = Math.round(1600 * scale);

// ---------------------------------------------------------------------------------------------
// Everything below `render` runs inside Chromium (serialised by Playwright), so it must be
// self-contained.
function render({ id, W, H, quality }) {
  const S = W / 2560; // all pixel sizes are authored for 2560 px wide
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  const TAU = Math.PI * 2;

  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function layer(w = W, h = H) {
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    return [cv, cv.getContext('2d')];
  }
  function hex(h) {
    const n = parseInt(h.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgba(h, a = 1) {
    const [r, gg, b] = hex(h);
    return `rgba(${r},${gg},${b},${a})`;
  }
  function mixHex(a, b, t) {
    const A = hex(a);
    const B = hex(b);
    return `#${A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, '0')).join('')}`;
  }
  function put(src, { blur = 0, op = 'source-over', alpha = 1, dx = 0, dy = 0 } = {}) {
    g.save();
    g.globalCompositeOperation = op;
    g.globalAlpha = alpha;
    if (blur) g.filter = `blur(${blur * S}px)`;
    g.drawImage(src, dx * S, dy * S, W, H);
    g.restore();
  }
  // Smooth 1-D fractal noise built from a few incommensurate sines.
  function noise1(seed, octaves = 5) {
    const r = rng(seed);
    const comps = Array.from({ length: octaves }, (_, i) => ({ f: (i + 1) * (0.7 + r() * 0.9), p: r() * TAU, a: 1 / (i + 1) ** 1.4 }));
    const norm = comps.reduce((s, k) => s + k.a, 0);
    return (x) => comps.reduce((s, k) => s + k.a * Math.sin(x * k.f + k.p), 0) / norm;
  }
  function vgrad(ctx, stops, y0 = 0, y1 = H) {
    const gr = ctx.createLinearGradient(0, y0, 0, y1);
    for (const [o, col] of stops) gr.addColorStop(o, col);
    return gr;
  }
  function fillAll(ctx, style) {
    ctx.fillStyle = style;
    ctx.fillRect(0, 0, W, H);
  }
  function glow(ctx, x, y, r, col, a) {
    const gr = ctx.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, rgba(col, a));
    gr.addColorStop(0.45, rgba(col, a * 0.45));
    gr.addColorStop(1, rgba(col, 0));
    ctx.fillStyle = gr;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // Fine monochrome grain hides gradient banding (kept tiny so JPEGs stay small).
  function grain(amount, seed = 7) {
    const d = g.getImageData(0, 0, W, H);
    const r = rng(seed);
    const px = d.data;
    for (let i = 0; i < px.length; i += 4) {
      const n = (r() - 0.5) * amount;
      px[i] += n;
      px[i + 1] += n;
      px[i + 2] += n;
    }
    g.putImageData(d, 0, 0);
  }

  // ------------------------------------------------------------------ Bloom
  // A twisted rosette of translucent glass petals. `p` = palette of the variant (BLOOM below).
  function bloom(p) {
    const dark = !!p.dark;
    const r = rng(17);
    const bg = g.createLinearGradient(0, 0, W * 0.35, H * 1.1);
    for (const [o, col] of p.bg) bg.addColorStop(o, col);
    fillAll(g, bg);
    const cx = W * 0.5;
    const cy = H * 0.475;
    if (p.sun) glow(g, W * p.sun[0], H * p.sun[1], H * p.sun[2], p.sun[3], p.sun[4]);
    glow(g, cx, cy, H * 0.8, p.glow[0], p.glow[1]);
    glow(g, W * 0.3, H * 0.08, H * 0.7, p.glow2[0], p.glow2[1]);

    const pal = p.pal;
    const lerpC = (a, b, t) => mixHex(a, b, Math.max(0, Math.min(1, t)));
    // Cross-section shade of a curved glass ribbon: s in [-1, 1] from one edge to the other.
    function shadeAt(s, tone) {
      const body = 0.5 + 0.5 * Math.cos((s + 0.3) * Math.PI * 0.85);
      let col = body < 0.5 ? lerpC(pal.deep, pal.mid, body * 2) : lerpC(pal.mid, pal.light, (body - 0.5) * 2);
      col = lerpC(col, pal.deep, (1 - tone) * 0.5);
      const spec = Math.exp(-(((s + 0.55) / 0.13) ** 2)) * 0.55 + Math.max(0, Math.abs(s) - 0.86) * 2.2;
      return lerpC(col, pal.spec, spec);
    }
    // A petal: curved centre line from the heart outwards, width tapering to both ends.
    function petal(p) {
      const STEPS = 72;
      const center = [];
      for (let i = 0; i <= STEPS; i++) {
        const t = i / STEPS;
        const ang = p.a + p.bend * t * t;
        const rad = p.r0 + p.L * t;
        center.push({ x: cx + Math.cos(ang) * rad, y: cy + Math.sin(ang) * rad, nx: -Math.sin(ang + p.bend * t * 0.5), ny: Math.cos(ang + p.bend * t * 0.5), t });
      }
      const widthAt = (t) => p.w * Math.sin(Math.PI * Math.min(1, t * 1.01)) ** 0.62 * (1 - 0.22 * t);
      const edge = (s) => center.map((c) => ({ x: c.x + c.nx * widthAt(c.t) * s, y: c.y + c.ny * widthAt(c.t) * s }));
      const [pl, pg] = layer();
      const STRIPS = 120;
      for (let k = 0; k < STRIPS; k++) {
        const s0 = -1 + (2 * k) / STRIPS;
        const s1 = -1 + (2 * (k + 1.6)) / STRIPS; // overlap so strips never show seams
        const a = edge(s0);
        const b = edge(Math.min(1, s1));
        pg.beginPath();
        pg.moveTo(a[0].x, a[0].y);
        for (const q of a) pg.lineTo(q.x, q.y);
        for (let i = b.length - 1; i >= 0; i--) pg.lineTo(b[i].x, b[i].y);
        pg.closePath();
        pg.fillStyle = shadeAt((s0 + Math.min(1, s1)) / 2, p.tone);
        pg.fill();
      }
      // along the length: deeper at the heart, luminous towards the tip
      const tip = center[center.length - 1];
      const lg = pg.createLinearGradient(cx, cy, tip.x, tip.y);
      lg.addColorStop(0, rgba(pal.deep, 0.75));
      lg.addColorStop(0.35, rgba(pal.deep, 0.15));
      lg.addColorStop(0.8, rgba('#ffffff', 0));
      lg.addColorStop(1, rgba('#ffffff', p.tipA ?? (dark ? 0.12 : 0.3)));
      pg.globalCompositeOperation = 'source-atop';
      pg.fillStyle = lg;
      pg.fillRect(0, 0, W, H);
      pg.globalCompositeOperation = 'source-over';
      return pl;
    }
    const rings = [
      { n: 7, L: 0.385, w: 0.122, off: 0, alpha: dark ? 0.72 : 0.7, tone: 0.95, blur: 1.5 },
      { n: 7, L: 0.295, w: 0.108, off: Math.PI / 7, alpha: dark ? 0.85 : 0.82, tone: 0.7, blur: 0 },
      { n: 5, L: 0.152, w: 0.072, off: 0.3, alpha: dark ? 0.8 : 0.78, tone: 0.45, blur: 0 },
    ];
    const [fl, fg] = layer();
    for (const ring of rings) {
      const list = [];
      for (let i = 0; i < ring.n; i++) {
        const a = -Math.PI / 2 + ring.off + (i * TAU) / ring.n + (r() - 0.5) * 0.12;
        list.push({ a, L: H * ring.L * (0.92 + r() * 0.16), w: H * ring.w * (0.9 + r() * 0.2), r0: 0, bend: 0.42 + r() * 0.12, tone: ring.tone });
      }
      list.sort((p, q) => Math.sin(p.a) - Math.sin(q.a));
      for (const p of list) {
        const pl = petal(p);
        fg.save();
        fg.globalAlpha = ring.alpha;
        if (ring.blur) fg.filter = `blur(${ring.blur * S}px)`;
        fg.drawImage(pl, 0, 0);
        fg.restore();
      }
    }
    if (dark) {
      put(fl, { blur: 80, op: 'lighter', alpha: 0.5 });
    } else {
      const [sl, sg] = layer();
      sg.drawImage(fl, 0, 0);
      sg.globalCompositeOperation = 'source-in';
      sg.fillStyle = p.shadow;
      sg.fillRect(0, 0, W, H);
      put(sl, { blur: 80, alpha: 0.3, dy: 50 });
    }
    put(fl);
    glow(g, cx, cy, H * 0.1, p.core[0], p.core[1]);
  }

  // ------------------------------------------------------------------ Glow
  // A tilted ring of light floating in soft colour haze.
  function glowScene(dark) {
    const bg = g.createLinearGradient(0, 0, W, H);
    if (dark) {
      bg.addColorStop(0, '#120a2a');
      bg.addColorStop(0.5, '#0b0820');
      bg.addColorStop(1, '#04030d');
    } else {
      bg.addColorStop(0, '#fbf1f1');
      bg.addColorStop(0.5, '#f0eaf8');
      bg.addColorStop(1, '#dfe9f9');
    }
    fillAll(g, bg);
    const [hl, hg] = layer(W / 4, H / 4);
    const blob = (x, y, rad, col, a) => {
      const gr = hg.createRadialGradient(x / 4, y / 4, 0, x / 4, y / 4, rad / 4);
      gr.addColorStop(0, rgba(col, a));
      gr.addColorStop(1, rgba(col, 0));
      hg.fillStyle = gr;
      hg.fillRect(0, 0, W / 4, H / 4);
    };
    if (dark) {
      blob(W * 0.22, H * 0.25, H * 0.75, '#7a1f9e', 0.55);
      blob(W * 0.8, H * 0.78, H * 0.8, '#2a3bd6', 0.5);
      blob(W * 0.62, H * 0.18, H * 0.5, '#0d7fb8', 0.35);
    } else {
      blob(W * 0.2, H * 0.25, H * 0.75, '#ffb3cf', 0.65);
      blob(W * 0.82, H * 0.78, H * 0.8, '#b7b4ff', 0.6);
      blob(W * 0.65, H * 0.12, H * 0.55, '#ffd3b0', 0.55);
    }
    put(hl, { blur: 40 });

    const cx = W * 0.56;
    const cy = H * 0.52;
    const R = H * 0.3;
    const ring = (ctx, lw, a, from = 0, to = TAU) => {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(-0.42);
      ctx.scale(1, 0.86);
      const cg = ctx.createConicGradient(0.3, 0, 0);
      const cols = dark ? ['#ff4fa3', '#a24bff', '#3d6bff', '#20d0ff', '#ff8a4c', '#ff4fa3'] : ['#ff6a9f', '#a05cff', '#4a74ff', '#2fb6f2', '#8d7cff', '#ff7ab0', '#ffa06a', '#ff6a9f'];
      cols.forEach((col, i) => cg.addColorStop(i / (cols.length - 1), rgba(col, a)));
      ctx.strokeStyle = cg;
      ctx.lineWidth = lw;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(0, 0, R, from, to);
      ctx.stroke();
      ctx.restore();
    };
    // inner glass disc
    const disc = g.createRadialGradient(cx - R * 0.25, cy - R * 0.3, 0, cx, cy, R * 1.05);
    disc.addColorStop(0, rgba('#ffffff', dark ? 0.08 : 0.5));
    disc.addColorStop(0.7, rgba('#ffffff', dark ? 0.03 : 0.18));
    disc.addColorStop(1, rgba('#ffffff', 0));
    g.fillStyle = disc;
    g.beginPath();
    g.ellipse(cx, cy, R * 1.02, R * 0.9, -0.42, 0, TAU);
    g.fill();

    const [gl, gg] = layer();
    ring(gg, H * 0.16, 1);
    put(gl, { blur: 110, alpha: dark ? 0.9 : 0.42, op: dark ? 'lighter' : 'source-over' });
    const [bl, bg2] = layer();
    ring(bg2, H * (dark ? 0.045 : 0.032), 1);
    put(bl, { blur: dark ? 14 : 9, alpha: 0.95 });
    const [cl, cg2] = layer();
    ring(cg2, H * 0.012, 1);
    put(cl, { blur: 2, alpha: dark ? 0.9 : 0.75, op: dark ? 'lighter' : 'source-over' });
    // specular highlight on the upper-left arc
    const [sl, sg] = layer();
    sg.save();
    sg.translate(cx, cy);
    sg.rotate(-0.42);
    sg.scale(1, 0.86);
    sg.strokeStyle = 'rgba(255,255,255,0.95)';
    sg.lineWidth = H * 0.005;
    sg.lineCap = 'round';
    sg.beginPath();
    sg.arc(0, 0, R * 0.995, Math.PI * 1.08, Math.PI * 1.38);
    sg.stroke();
    sg.restore();
    put(sl, { blur: 5, alpha: dark ? 0.6 : 0.75 });
    // a couple of small satellite orbs
    for (const [x, y, rr, col] of [
      [0.27, 0.68, 0.035, dark ? '#ff6fb1' : '#ff8fbd'],
      [0.83, 0.3, 0.022, dark ? '#4fc8ff' : '#7aa6ff'],
    ]) {
      const ox = W * x;
      const oy = H * y;
      const r0 = H * rr;
      glow(g, ox, oy, r0 * 4, col, dark ? 0.35 : 0.3);
      const og = g.createRadialGradient(ox - r0 * 0.35, oy - r0 * 0.35, r0 * 0.1, ox, oy, r0);
      og.addColorStop(0, rgba('#ffffff', 0.95));
      og.addColorStop(0.5, rgba(col, 0.85));
      og.addColorStop(1, rgba(col, 0.25));
      g.fillStyle = og;
      g.beginPath();
      g.arc(ox, oy, r0, 0, TAU);
      g.fill();
    }
  }

  // ------------------------------------------------------------------ Flow
  // Silk ribbons made of hundreds of fine, twisting threads.
  function flow(dark) {
    const bg = g.createLinearGradient(0, 0, W * 0.2, H);
    if (dark) {
      bg.addColorStop(0, '#04161d');
      bg.addColorStop(0.55, '#062430');
      bg.addColorStop(1, '#020b10');
    } else {
      bg.addColorStop(0, '#f4f9f8');
      bg.addColorStop(0.55, '#e0eef0');
      bg.addColorStop(1, '#cfe1ec');
    }
    fillAll(g, bg);
    glow(g, W * 0.7, H * 0.45, H * 0.8, dark ? '#0b6b7a' : '#ffffff', dark ? 0.35 : 0.6);
    const bands = dark
      ? [
          { y: 0.62, amp: 0.16, th: 0.2, f: 1.25, ph: 0.4, tw: 1.6, c: ['#00e0c0', '#2b7bff'], n: 110, seed: 3 },
          { y: 0.42, amp: 0.13, th: 0.13, f: 1.1, ph: 2.2, tw: 2.1, c: ['#18b4ff', '#7a5cff'], n: 90, seed: 5 },
          { y: 0.78, amp: 0.1, th: 0.1, f: 1.5, ph: 4.1, tw: 1.3, c: ['#2fffa8', '#00b7c7'], n: 70, seed: 9 },
        ]
      : [
          { y: 0.62, amp: 0.16, th: 0.2, f: 1.25, ph: 0.4, tw: 1.6, c: ['#00a6a0', '#1d6fe0'], n: 110, seed: 3 },
          { y: 0.42, amp: 0.13, th: 0.13, f: 1.1, ph: 2.2, tw: 2.1, c: ['#1590e6', '#6a5ae6'], n: 90, seed: 5 },
          { y: 0.78, amp: 0.1, th: 0.1, f: 1.5, ph: 4.1, tw: 1.3, c: ['#16c08a', '#0098b0'], n: 70, seed: 9 },
        ];
    const [rl, rgc] = layer();
    rgc.globalCompositeOperation = dark ? 'lighter' : 'source-over';
    for (const b of bands) {
      const nz = noise1(b.seed, 4);
      const grad = rgc.createLinearGradient(0, 0, W, 0);
      grad.addColorStop(0, b.c[0]);
      grad.addColorStop(1, b.c[1]);
      rgc.strokeStyle = grad;
      rgc.lineWidth = 1.5 * S;
      for (let j = 0; j < b.n; j++) {
        const t = j / (b.n - 1);
        rgc.globalAlpha = (dark ? 0.16 : 0.3) * (0.25 + 0.75 * Math.sin(t * Math.PI));
        rgc.beginPath();
        for (let x = -W * 0.05; x <= W * 1.05; x += 6 * S) {
          const u = x / W;
          const centre = H * (b.y + b.amp * nz(u * b.f * 3 + b.ph));
          const twist = Math.cos(u * Math.PI * b.tw + b.ph);
          const off = (t - 0.5) * H * b.th * (0.25 + 0.75 * twist) + (t - 0.5) * H * 0.02 * Math.sin(u * 9 + t * 3);
          const y = centre + off;
          if (x <= -W * 0.05) rgc.moveTo(x, y);
          else rgc.lineTo(x, y);
        }
        rgc.stroke();
      }
    }
    put(rl, { blur: 40, alpha: dark ? 0.7 : 0.35, op: dark ? 'lighter' : 'source-over' });
    put(rl, { blur: 0.6 });
  }

  // ------------------------------------------------------------------ Sunrise
  function sunrise() {
    fillAll(
      g,
      vgrad(g, [
        [0, '#231f5c'],
        [0.28, '#5a3f8f'],
        [0.5, '#c4628a'],
        [0.64, '#f39a6b'],
        [0.72, '#ffc985'],
        [0.78, '#ffe3ae'],
      ]),
    );
    const sx = W * 0.6;
    const sy = H * 0.66;
    glow(g, sx, sy, H * 0.9, '#ffb07a', 0.45);
    glow(g, sx, sy, H * 0.3, '#fff0c8', 0.75);
    g.fillStyle = '#fff6df';
    g.beginPath();
    g.arc(sx, sy, H * 0.045, 0, TAU);
    g.fill();
    // thin clouds
    const r = rng(21);
    const [cl, cgx] = layer();
    for (let i = 0; i < 26; i++) {
      const y = H * (0.18 + r() * 0.38);
      const x = W * r();
      const w = W * (0.12 + r() * 0.3);
      const hh = H * (0.004 + r() * 0.01);
      const cg = cgx.createLinearGradient(x - w / 2, 0, x + w / 2, 0);
      const col = y < H * 0.35 ? '#eaa0c8' : '#ffcfa3';
      cg.addColorStop(0, rgba(col, 0));
      cg.addColorStop(0.3 + r() * 0.4, rgba(col, 0.28));
      cg.addColorStop(1, rgba(col, 0));
      cgx.fillStyle = cg;
      cgx.beginPath();
      cgx.ellipse(x, y, w / 2, hh, (r() - 0.5) * 0.02, 0, TAU);
      cgx.fill();
    }
    put(cl, { blur: 7 });
    const ridges = [
      { base: 0.6, amp: 0.1, col: '#c0688a', fog: '#ffc2a0', seed: 31, det: 0.012 },
      { base: 0.67, amp: 0.1, col: '#93507c', fog: '#ffb08c', seed: 32, det: 0.014 },
      { base: 0.74, amp: 0.09, col: '#6a3b6c', fog: '#f59a86', seed: 33, det: 0.016 },
      { base: 0.81, amp: 0.08, col: '#46285a', fog: '#d77d86', seed: 34, det: 0.018 },
      { base: 0.89, amp: 0.07, col: '#2b1a42', fog: '#a75f7d', seed: 35, det: 0.02 },
      { base: 0.97, amp: 0.06, col: '#1a1030', fog: null, seed: 36, det: 0.02 },
    ];
    for (const rd of ridges) {
      const n = noise1(rd.seed, 6);
      const d = noise1(rd.seed + 100, 3);
      g.beginPath();
      g.moveTo(0, H);
      for (let x = 0; x <= W; x += 4 * S) {
        const u = x / W;
        const ridge = 1 - Math.abs(n(u * 4.2));
        const y = H * (rd.base - rd.amp * ridge ** 1.6) + H * rd.det * d(u * 40);
        g.lineTo(x, y);
      }
      g.lineTo(W, H);
      g.closePath();
      g.fillStyle = vgrad(g, [
        [rd.base - rd.amp - 0.02, rd.col],
        [1, mixHex(rd.col, '#100820', 0.35)],
      ], H * (rd.base - rd.amp), H);
      g.fill();
      if (rd.fog) {
        g.fillStyle = vgrad(g, [
          [0, rgba(rd.fog, 0)],
          [1, rgba(rd.fog, 0.5)],
        ], H * (rd.base - rd.amp * 0.4), H * (rd.base + 0.07));
        g.fillRect(0, H * (rd.base - rd.amp * 0.4), W, H);
      }
    }
  }

  // ------------------------------------------------------------------ Aurora / Lakeside
  // Mountain lake under the sky; at night the northern lights (`p.curtains`) dance over the range. `p` = LAKE variant.
  function aurora(p) {
    const horizon = H * 0.74;
    fillAll(g, vgrad(g, p.sky));
    const r = rng(41);
    const x2 = rng(43); // extras (sun, clouds) use their own sequence: the stars and ripples stay where they are
    // stars
    for (let i = 0; i < p.stars; i++) {
      const x = r() * W;
      const y = r() ** 1.5 * horizon;
      const s = (0.3 + r() ** 4 * 1.5) * S * 1.4;
      g.fillStyle = `rgba(255,255,255,${(0.25 + r() * 0.7) * (p.starA ?? 1)})`;
      g.beginPath();
      g.arc(x, y, s, 0, TAU);
      g.fill();
    }
    for (let i = 0; i < (p.stars ? 18 : 0); i++) glow(g, r() * W, r() ** 1.5 * horizon * 0.7, 9 * S, '#cfe6ff', 0.45 * (p.starA ?? 1));
    // sun / afterglow behind the range
    for (const sg of p.glows || []) glow(g, W * sg[0], H * sg[1], H * sg[2], sg[3], sg[4]);
    if (p.sunDisc) {
      g.fillStyle = p.sunDisc[3];
      g.beginPath();
      g.arc(W * p.sunDisc[0], H * p.sunDisc[1], H * p.sunDisc[2], 0, TAU);
      g.fill();
    }
    // clouds: thin streaks (dawn, dusk) or soft cumulus puffs (day)
    if (p.clouds) {
      const cd = p.clouds;
      const [cl, cgx] = layer();
      for (let i = 0; i < cd.n; i++) {
        const y = H * (cd.y0 ?? 0.1) + H * x2() * (cd.dy ?? 0.4);
        const x = W * x2();
        if (cd.kind === 'puff') {
          const w = W * (0.06 + x2() * 0.1);
          const parts = 7 + Math.floor(x2() * 6);
          for (let k = 0; k < parts; k++) {
            const u = k / (parts - 1) - 0.5;
            const rr = w * (0.16 + 0.22 * Math.cos(u * Math.PI) * (0.7 + x2() * 0.5));
            const px = x + u * w * 1.1 + (x2() - 0.5) * w * 0.12;
            const py = y - rr * 0.45 + (x2() - 0.5) * rr * 0.3;
            const gr = cgx.createRadialGradient(px - rr * 0.2, py - rr * 0.3, rr * 0.1, px, py, rr);
            gr.addColorStop(0, rgba(cd.col, cd.a));
            gr.addColorStop(0.6, rgba(cd.col, cd.a * 0.75));
            gr.addColorStop(1, rgba(cd.col, 0));
            cgx.fillStyle = gr;
            cgx.beginPath();
            cgx.arc(px, py, rr, 0, TAU);
            cgx.fill();
          }
          // flat, slightly shaded base
          const bg2 = cgx.createLinearGradient(0, y - w * 0.1, 0, y + w * 0.06);
          bg2.addColorStop(0, rgba(cd.shade || cd.col, 0));
          bg2.addColorStop(1, rgba(cd.shade || cd.col, cd.a * 0.35));
          cgx.fillStyle = bg2;
          cgx.beginPath();
          cgx.ellipse(x, y - w * 0.04, w * 0.6, w * 0.1, 0, 0, TAU);
          cgx.fill();
        } else {
          const w = W * (0.14 + x2() * 0.3);
          const hh = H * (0.003 + x2() * 0.009);
          const cg = cgx.createLinearGradient(x - w / 2, 0, x + w / 2, 0);
          const col = cd.cols ? cd.cols[y < H * 0.3 ? 0 : 1] : cd.col;
          cg.addColorStop(0, rgba(col, 0));
          cg.addColorStop(0.3 + x2() * 0.4, rgba(col, cd.a));
          cg.addColorStop(1, rgba(col, 0));
          cgx.fillStyle = cg;
          cgx.beginPath();
          cgx.ellipse(x, y, w / 2, hh, (x2() - 0.5) * 0.02, 0, TAU);
          cgx.fill();
        }
      }
      put(cl, { blur: cd.blur ?? 7 });
    }
    // curtains
    if (p.curtains) {
      const [al, ag] = layer();
      ag.globalCompositeOperation = 'lighter';
      for (const cu of p.curtains) {
        const nb = noise1(cu.seed, 5);
        const nh = noise1(cu.seed + 7, 6);
        const ni = noise1(cu.seed + 13, 3);
        for (let x = 0; x <= W; x += 1.5 * S) {
          const u = x / W;
          const yb = H * (cu.base + cu.amp * nb(u * cu.f));
          let inten = Math.max(0, 0.55 + 0.6 * ni(u * 2.2));
          if (inten <= 0.02) continue;
          const ray = 0.55 + 0.45 * Math.abs(nh(u * 90));
          const hh = H * cu.hgt * (0.5 + 0.3 * nh(u * 14) + 0.2 * ray) * (0.6 + 0.4 * inten);
          inten *= 0.6 + 0.6 * ray * ray;
          const gr = ag.createLinearGradient(0, yb, 0, yb - hh);
          gr.addColorStop(0, rgba(cu.low, 0));
          gr.addColorStop(0.07, rgba(cu.low, cu.a * 1.6 * inten));
          gr.addColorStop(0.3, rgba(cu.mid, cu.a * inten));
          gr.addColorStop(0.75, rgba(cu.top, cu.a * 0.5 * inten));
          gr.addColorStop(1, rgba(cu.top, 0));
          ag.fillStyle = gr;
          ag.fillRect(x, yb - hh, 2 * S, hh);
        }
      }
      put(al, { blur: 60, op: 'lighter', alpha: 0.8 * (p.curtainA ?? 1) });
      put(al, { blur: 3, op: 'lighter', alpha: 0.85 * (p.curtainA ?? 1) });
    }
    // distant range(s)
    const range = (base, amp, col, seed, det) => {
      const n = noise1(seed, 6);
      const d = noise1(seed + 9, 3);
      g.beginPath();
      g.moveTo(0, horizon + 2);
      for (let x = 0; x <= W; x += 3 * S) {
        const u = x / W;
        const ridge = 1 - Math.abs(n(u * 3.4));
        g.lineTo(x, H * base - H * amp * ridge ** 2 + H * det * d(u * 50));
      }
      g.lineTo(W, horizon + 2);
      g.closePath();
      g.fillStyle = col;
      g.fill();
    };
    for (const rg of p.ranges) {
      range(rg[0], rg[1], rg[2], rg[3], rg[4]);
      // atmospheric haze at the foot of a range (daylight)
      if (rg[5]) {
        g.fillStyle = vgrad(g, [
          [0, rgba(rg[5], 0)],
          [1, rgba(rg[5], rg[6] ?? 0.35)],
        ], H * (rg[0] - rg[1] * 0.5), horizon);
        g.fillRect(0, H * (rg[0] - rg[1] * 0.5), W, horizon - H * (rg[0] - rg[1] * 0.5));
      }
    }
    // lake: reflect the sky and mountains
    const lake = H - horizon;
    g.save();
    g.translate(0, horizon * 2);
    g.scale(1, -1);
    g.globalAlpha = p.reflect ?? 0.55;
    g.drawImage(c, 0, horizon - lake * 1.0, W, lake, 0, horizon - lake, W, lake);
    g.restore();
    g.fillStyle = vgrad(g, p.lake, horizon, H);
    g.fillRect(0, horizon, W, lake);
    // ripples
    for (let i = 0; i < 160; i++) {
      const y = horizon + r() ** 1.6 * lake;
      const x = r() * W;
      const w = (40 + r() * 260) * S * (1 + (y - horizon) / lake);
      g.fillStyle = `rgba(${p.ripple},${(0.03 + r() * 0.05) * (p.rippleA ?? 1)})`;
      g.fillRect(x, y, w, 1.2 * S);
    }
    // shoreline
    g.fillStyle = p.shore;
    const sh = noise1(71, 4);
    g.beginPath();
    g.moveTo(0, H);
    for (let x = 0; x <= W; x += 4 * S) {
      const u = x / W;
      g.lineTo(x, H * (0.95 + 0.025 * sh(u * 5)) - (u < 0.25 ? H * 0.06 * (1 - u / 0.25) ** 2 : 0));
    }
    g.lineTo(W, H);
    g.fill();
  }

  // ------------------------------------------------------------------ Dunes
  // Desert dunes: gentle windward slopes, shaded lee faces. `p` = DUNES variant.
  function dunes(p) {
    fillAll(g, vgrad(g, p.sky));
    if (p.stars) {
      const r = rng(91);
      for (let i = 0; i < p.stars; i++) {
        const x = r() * W;
        const y = r() ** 1.4 * H * 0.6;
        g.fillStyle = `rgba(255,255,255,${0.2 + r() * 0.75})`;
        g.beginPath();
        g.arc(x, y, (0.35 + r() ** 4 * 1.4) * S * 1.4, 0, TAU);
        g.fill();
      }
    }
    const sun = p.sun;
    glow(g, W * sun.x, H * sun.y, H * sun.glowR, sun.glowCol, sun.glowA);
    if (sun.glow2) glow(g, W * sun.x, H * sun.y, H * sun.glow2[0], sun.glow2[1], sun.glow2[2]);
    g.fillStyle = sun.disc;
    g.beginPath();
    g.arc(W * sun.x, H * sun.y, H * sun.r, 0, TAU);
    g.fill();
    if (sun.crater) {
      // moon: a few soft maria
      for (const [dx, dy, rr, a] of [[-0.3, -0.2, 0.35, 0.12], [0.25, 0.1, 0.28, 0.1], [-0.05, 0.35, 0.22, 0.08]]) {
        g.fillStyle = `rgba(120,135,170,${a})`;
        g.beginPath();
        g.arc(W * sun.x + dx * H * sun.r, H * sun.y + dy * H * sun.r, rr * H * sun.r, 0, TAU);
        g.fill();
      }
    }
    for (const L of p.layers) {
      const r = rng(L.seed);
      // crest made of peaks: gentle windward slope on the left, steep lee on the right
      const pts = [];
      const seg = W / L.peaks;
      let x0 = -seg * (0.2 + r() * 0.5);
      while (x0 < W + seg) {
        const px = x0 + seg * (0.55 + r() * 0.25);
        const vx = x0 + seg * (1 + r() * 0.2);
        pts.push({ px, py: H * (L.base - L.amp * (0.6 + r() * 0.4)), vx, vy: H * (L.base + L.amp * 0.15 * r()) });
        x0 = vx;
      }
      const crest = (ctx) => {
        let prev = { x: -seg * 0.8, y: H * L.base };
        ctx.moveTo(prev.x, prev.y);
        for (const q of pts) {
          // windward: long convex rise to the peak
          ctx.bezierCurveTo(prev.x + (q.px - prev.x) * 0.45, prev.y, q.px - (q.px - prev.x) * 0.25, q.py, q.px, q.py);
          // lee: short drop to the valley
          ctx.bezierCurveTo(q.px + (q.vx - q.px) * 0.35, q.py + (q.vy - q.py) * 0.2, q.vx - (q.vx - q.px) * 0.35, q.vy, q.vx, q.vy);
          prev = { x: q.vx, y: q.vy };
        }
      };
      g.save();
      g.beginPath();
      crest(g);
      g.lineTo(W + seg, H);
      g.lineTo(-seg, H);
      g.closePath();
      g.fillStyle = vgrad(g, [
        [0, L.lit],
        [1, mixHex(L.lit, L.shade, 0.5)],
      ], H * (L.base - L.amp), H * (L.base + 0.15));
      g.fill();
      g.clip();
      // shaded lee faces: between the lee edge and a curve sweeping back under the peak
      for (const q of pts) {
        const depth = H * L.amp * (1.2 + r() * 0.8);
        g.beginPath();
        g.moveTo(q.px, q.py);
        g.bezierCurveTo(q.px + (q.vx - q.px) * 0.35, q.py + (q.vy - q.py) * 0.2, q.vx - (q.vx - q.px) * 0.35, q.vy, q.vx, q.vy);
        g.bezierCurveTo(q.vx + (q.vx - q.px) * 0.4, q.vy + depth * 0.9, q.px + (q.vx - q.px) * 0.1, q.py + depth * 1.1, q.px, q.py);
        g.closePath();
        const sg = g.createLinearGradient(q.px, q.py, q.vx, q.vy + depth);
        sg.addColorStop(0, rgba(L.shade, 0.95));
        sg.addColorStop(1, rgba(L.shade, 0.35));
        g.fillStyle = sg;
        g.fill();
      }
      // haze at the foot of each layer for depth
      g.fillStyle = vgrad(g, [
        [0, `rgba(${p.haze},0)`],
        [1, `rgba(${p.haze},${p.hazeA})`],
      ], H * L.base, H);
      g.fillRect(0, H * L.base, W, H);
      g.restore();
      // crisp lit crest line
      g.save();
      g.beginPath();
      crest(g);
      g.strokeStyle = p.crest;
      g.lineWidth = 1.4 * S;
      g.stroke();
      g.restore();
    }
  }

  // ---- palettes. The originals ('bloom-light', 'aurora', 'dunes', …) keep their exact look; the time-of-day sets
  // (core/wallpaper/dynamic.js) add dawn / day / dusk / night variants of Bloom, Dunes and Lakeside.
  const BLOOM = {
    light: { bg: [[0, '#dfe9f7'], [0.5, '#d2e2f5'], [1, '#b5cdec']], glow: ['#a9cbff', 0.5], glow2: ['#ffffff', 0.5], pal: { deep: '#0843bf', mid: '#2477ee', light: '#93c6ff', spec: '#ffffff' }, shadow: '#0d3a8c', core: ['#cfe4ff', 0.35] },
    dark: { dark: true, bg: [[0, '#0a1838'], [0.55, '#050d22'], [1, '#02040c']], glow: ['#1a47c8', 0.38], glow2: ['#10265e', 0.3], pal: { deep: '#05299a', mid: '#1b63ec', light: '#63adff', spec: '#d6ecff' }, core: ['#7fb8ff', 0.3] },
    dawn: { bg: [[0, '#fbe3da'], [0.5, '#efd6ea'], [1, '#c9c3ea']], sun: [0.86, 0.9, 0.9, '#ffc9a8', 0.55], glow: ['#ffbfd2', 0.5], glow2: ['#fff6ec', 0.55], pal: { deep: '#6a2a93', mid: '#b955c4', light: '#ffb2cf', spec: '#fff6f0' }, shadow: '#4b1d6e', core: ['#ffe0ec', 0.4] },
    day: { bg: [[0, '#e9f3fd'], [0.5, '#d6e9fb'], [1, '#b2d4f4']], sun: [0.18, 0.06, 0.8, '#ffffff', 0.7], glow: ['#9fd2ff', 0.55], glow2: ['#ffffff', 0.6], pal: { deep: '#0a52c9', mid: '#1f86f2', light: '#8fd0ff', spec: '#ffffff' }, shadow: '#0b4aa0', core: ['#dff2ff', 0.4], tipA: 0.34 },
    dusk: { dark: true, bg: [[0, '#2a1446'], [0.5, '#7a2a5c'], [1, '#d8643e']], sun: [0.82, 0.95, 0.95, '#ff9a4d', 0.55], glow: ['#e0407a', 0.4], glow2: ['#3a1a5e', 0.35], pal: { deep: '#5a0f5e', mid: '#de3f7c', light: '#ffae6b', spec: '#fff0d8' }, core: ['#ffc59a', 0.32], tipA: 0.16 },
    night: { dark: true, bg: [[0, '#081633'], [0.55, '#040b1f'], [1, '#01030a']], glow: ['#1840b8', 0.36], glow2: ['#0e2257', 0.3], pal: { deep: '#04258c', mid: '#185ce0', light: '#5aa6ff', spec: '#d2eaff' }, core: ['#7cb4ff', 0.28] },
  };
  const AURORA_CURTAINS = [
    { base: 0.48, amp: 0.15, hgt: 0.36, f: 1.7, seed: 51, low: '#4dffb8', mid: '#19e0a2', top: '#8a5cff', a: 0.3 },
    { base: 0.38, amp: 0.08, hgt: 0.26, f: 3.1, seed: 52, low: '#8affdc', mid: '#25cfe8', top: '#4a5cff', a: 0.18 },
    { base: 0.58, amp: 0.09, hgt: 0.18, f: 3.2, seed: 53, low: '#c2ff9a', mid: '#2ae39a', top: '#c25cff', a: 0.16 },
  ];
  const LAKE = {
    aurora: {
      sky: [[0, '#010310'], [0.4, '#03102a'], [0.68, '#0a2a4a'], [0.74, '#16405e']],
      stars: 1100, curtains: AURORA_CURTAINS,
      ranges: [[0.735, 0.1, '#0a1a2c', 61, 0.006], [0.745, 0.05, '#050d18', 62, 0.004]],
      lake: [[0, 'rgba(2,8,18,0.35)'], [1, 'rgba(1,4,10,0.92)']], ripple: '150,255,220', shore: '#01050b',
    },
    dawn: {
      sky: [[0, '#26325e'], [0.32, '#5d5f98'], [0.56, '#d39aac'], [0.7, '#ffcfae'], [0.74, '#ffe3c4']],
      stars: 260, starA: 0.45,
      glows: [[0.63, 0.75, 0.75, '#ffb48a', 0.5], [0.63, 0.75, 0.24, '#fff0d6', 0.7]],
      clouds: { n: 30, cols: ['#d9a6d0', '#ffc6b4'], a: 0.3, blur: 6, y0: 0.14, dy: 0.42 },
      ranges: [[0.705, 0.12, '#6c6a98', 64, 0.006, '#f2b5b8', 0.4], [0.735, 0.1, '#3f3d6a', 61, 0.006, '#d898a8', 0.25], [0.745, 0.05, '#25233f', 62, 0.004]],
      reflect: 0.6, lake: [[0, 'rgba(60,50,100,0.2)'], [1, 'rgba(14,12,32,0.85)']], ripple: '255,214,200', rippleA: 1.4, shore: '#0f0d1d',
    },
    day: {
      sky: [[0, '#2f7fd0'], [0.35, '#64a8ec'], [0.62, '#b8dbf8'], [0.74, '#e6f3fc']],
      stars: 0,
      glows: [[0.24, 0.12, 0.6, '#ffffff', 0.6], [0.24, 0.12, 0.12, '#ffffff', 0.85]],
      clouds: { kind: 'puff', n: 9, col: '#ffffff', shade: '#a9c3e0', a: 0.78, blur: 22, y0: 0.12, dy: 0.36 },
      ranges: [[0.69, 0.16, '#93a9c6', 64, 0.007, '#d6e8f8', 0.45], [0.725, 0.11, '#5f7a9c', 61, 0.006, '#c3dbf2', 0.3], [0.745, 0.05, '#2f4a3c', 62, 0.004]],
      reflect: 0.62, lake: [[0, 'rgba(40,110,160,0.18)'], [1, 'rgba(8,40,62,0.78)']], ripple: '255,255,255', rippleA: 1.6, shore: '#13261a',
    },
    dusk: {
      sky: [[0, '#140f38'], [0.3, '#3e2a6c'], [0.55, '#b4507a'], [0.68, '#ff8a62'], [0.74, '#ffb874']],
      stars: 420, starA: 0.6,
      curtains: AURORA_CURTAINS.slice(1), curtainA: 0.45,
      glows: [[0.34, 0.76, 0.85, '#ff7a52', 0.5], [0.34, 0.76, 0.22, '#ffd29a', 0.7]],
      clouds: { n: 26, cols: ['#c46a9a', '#ffae86'], a: 0.32, blur: 6, y0: 0.16, dy: 0.42 },
      ranges: [[0.735, 0.1, '#2c1d44', 61, 0.006, '#c0567a', 0.22], [0.745, 0.05, '#170f2a', 62, 0.004]],
      reflect: 0.6, lake: [[0, 'rgba(40,16,48,0.25)'], [1, 'rgba(8,4,14,0.9)']], ripple: '255,170,140', rippleA: 1.3, shore: '#07040c',
    },
  };
  LAKE.night = LAKE.aurora;
  const DUNES = {
    sunset: {
      sky: [[0, '#efd9cf'], [0.3, '#f6d2b4'], [0.5, '#f9c497'], [0.56, '#fbcf9f']],
      sun: { x: 0.3, y: 0.45, glowR: 0.6, glowCol: '#fff1d6', glowA: 0.7, disc: 'rgba(255,248,232,0.9)', r: 0.035 },
      layers: [
        { base: 0.52, amp: 0.05, lit: '#f2b48a', shade: '#d98f6c', seed: 81, peaks: 3 },
        { base: 0.6, amp: 0.07, lit: '#efa271', shade: '#cc7a52', seed: 82, peaks: 3 },
        { base: 0.69, amp: 0.08, lit: '#ea8f58', shade: '#b8603a', seed: 83, peaks: 2 },
        { base: 0.79, amp: 0.1, lit: '#e17a40', shade: '#9e4826', seed: 84, peaks: 2 },
        { base: 0.92, amp: 0.12, lit: '#d4682e', shade: '#7f3519', seed: 85, peaks: 2 },
      ],
      haze: '255,214,170', hazeA: 0.18, crest: 'rgba(255,236,210,0.35)',
    },
  };
  const duneLayers = (cols) => DUNES.sunset.layers.map((L, i) => ({ ...L, lit: cols[i][0], shade: cols[i][1] }));
  DUNES.dawn = {
    sky: [[0, '#3a3f78'], [0.22, '#7c6fa8'], [0.42, '#e3a4b4'], [0.53, '#ffd2b6'], [0.56, '#ffe1c6']],
    sun: { x: 0.22, y: 0.52, glowR: 0.55, glowCol: '#ffd9c0', glowA: 0.75, glow2: [0.12, '#fff4e4', 0.8], disc: 'rgba(255,244,230,0.95)', r: 0.03 },
    layers: duneLayers([['#dcaab0', '#a9789a'], ['#d0979f', '#956486'], ['#c08391', '#7f5276'], ['#a96e83', '#673f63'], ['#8e5a74', '#4f2e50']]),
    haze: '255,206,214', hazeA: 0.22, crest: 'rgba(255,232,236,0.4)',
  };
  DUNES.day = {
    sky: [[0, '#4b97de'], [0.25, '#86c0f0'], [0.45, '#cfe8f8'], [0.56, '#f4ead6']],
    sun: { x: 0.74, y: 0.14, glowR: 0.55, glowCol: '#ffffff', glowA: 0.75, glow2: [0.1, '#ffffff', 0.9], disc: 'rgba(255,255,250,0.98)', r: 0.03 },
    layers: duneLayers([['#f5d29a', '#d9a868'], ['#f0c27f', '#cf9452'], ['#e9b06a', '#c27f3e'], ['#e09b55', '#ad672c'], ['#d4863f', '#91501d']]),
    haze: '255,244,224', hazeA: 0.2, crest: 'rgba(255,250,235,0.5)',
  };
  DUNES.dusk = {
    sky: [[0, '#2b1a4e'], [0.2, '#6d2f6c'], [0.38, '#d65a62'], [0.5, '#ff9a55'], [0.56, '#ffc36e']],
    sun: { x: 0.7, y: 0.5, glowR: 0.65, glowCol: '#ffb15a', glowA: 0.75, glow2: [0.14, '#ffe2a8', 0.85], disc: 'rgba(255,226,170,0.95)', r: 0.04 },
    layers: duneLayers([['#e0784e', '#a8463a'], ['#cf6342', '#913631'], ['#b84f3a', '#782a2a'], ['#983d34', '#5a1f24'], ['#752c2c', '#3d141c']]),
    haze: '255,150,110', hazeA: 0.2, crest: 'rgba(255,200,150,0.4)',
  };
  DUNES.night = {
    sky: [[0, '#02050f'], [0.25, '#06112b'], [0.45, '#0f2449'], [0.56, '#1d3a66']],
    stars: 950,
    sun: { x: 0.74, y: 0.2, glowR: 0.45, glowCol: '#9fc0ff', glowA: 0.35, glow2: [0.1, '#e4eeff', 0.6], disc: 'rgba(236,242,255,0.96)', r: 0.028, crater: true },
    layers: duneLayers([['#2f4170', '#1a2547'], ['#28395f', '#141e3c'], ['#213151', '#101833'], ['#1a2844', '#0b122a'], ['#142036', '#070d1f']]),
    haze: '110,140,210', hazeA: 0.12, crest: 'rgba(170,195,255,0.3)',
  };

  const scenes = {
    'bloom-light': () => bloom(BLOOM.light),
    'bloom-dark': () => bloom(BLOOM.dark),
    'glow-light': () => glowScene(false),
    'glow-dark': () => glowScene(true),
    'flow-light': () => flow(false),
    'flow-dark': () => flow(true),
    sunrise,
    aurora: () => aurora(LAKE.aurora),
    dunes: () => dunes(DUNES.sunset),
  };
  for (const ph of ['dawn', 'day', 'dusk', 'night']) {
    scenes[`dynamic/bloom-${ph}`] = () => bloom(BLOOM[ph]);
    scenes[`dynamic/dunes-${ph}`] = () => dunes(DUNES[ph]);
    scenes[`dynamic/lake-${ph}`] = () => aurora(LAKE[ph]);
  }
  scenes[id]();
  grain(3.2);
  return c.toDataURL('image/jpeg', quality);
}

// ---------------------------------------------------------------------------------------------
async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-wpgen-'));
  const mainJs = path.join(tmp, 'main.js');
  fs.writeFileSync(
    mainJs,
    `const { app, BrowserWindow } = require('electron');
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.whenReady().then(() => {
  const w = new BrowserWindow({ show: false, width: 320, height: 200, webPreferences: { backgroundThrottling: false } });
  w.loadURL('data:text/html,<!doctype html><title>wallpapers</title>');
});`,
  );
  const app = await electron.launch({ executablePath: require('electron'), args: ['--no-sandbox', mainJs], timeout: 60000 });
  try {
    const page = await app.firstWindow();
    page.on('console', (m) => console.log(`[page] ${m.text()}`));
    fs.mkdirSync(OUT_DIR, { recursive: true });
    for (const id of only) {
      const t0 = Date.now();
      let quality = 0.88;
      let buf;
      for (;;) {
        const url = await page.evaluate(render, { id, W, H, quality });
        buf = Buffer.from(url.split(',')[1], 'base64');
        if (buf.length <= MAX_BYTES || quality <= 0.6 || scale !== 1) break;
        quality -= 0.03;
      }
      const file = path.join(OUT_DIR, `${id}.jpg`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, buf);
      console.log(`${id}.jpg  ${W}x${H}  q${quality.toFixed(2)}  ${(buf.length / 1024).toFixed(0)} KB  ${Date.now() - t0} ms`);
    }
  } finally {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
