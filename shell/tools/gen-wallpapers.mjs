#!/usr/bin/env node
// Renders Aurora's built-in wallpapers: original, procedural abstract artwork drawn with the
// Canvas 2D API inside an offscreen Electron/Chromium window (driven by playwright-core, like
// test/lib.mjs). Output: renderer/assets/wallpapers/<name>.jpg at 2560x1600, JPEG ~q88, < 700 KB.
//
//   xvfb-run -a node tools/gen-wallpapers.mjs                    # all wallpapers
//   xvfb-run -a node tools/gen-wallpapers.mjs --only=bloom-light,aurora --scale=0.5 --out=/tmp/wp
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
const only = arg('only', '') ? arg('only', '').split(',') : NAMES;
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
  // A twisted rosette of translucent glass petals.
  function bloom(dark) {
    const r = rng(17);
    const bg = g.createLinearGradient(0, 0, W * 0.35, H * 1.1);
    if (dark) {
      bg.addColorStop(0, '#0a1838');
      bg.addColorStop(0.55, '#050d22');
      bg.addColorStop(1, '#02040c');
    } else {
      bg.addColorStop(0, '#dfe9f7');
      bg.addColorStop(0.5, '#d2e2f5');
      bg.addColorStop(1, '#b5cdec');
    }
    fillAll(g, bg);
    const cx = W * 0.5;
    const cy = H * 0.475;
    glow(g, cx, cy, H * 0.8, dark ? '#1a47c8' : '#a9cbff', dark ? 0.38 : 0.5);
    glow(g, W * 0.3, H * 0.08, H * 0.7, dark ? '#10265e' : '#ffffff', dark ? 0.3 : 0.5);

    const pal = dark
      ? { deep: '#05299a', mid: '#1b63ec', light: '#63adff', spec: '#d6ecff' }
      : { deep: '#0843bf', mid: '#2477ee', light: '#93c6ff', spec: '#ffffff' };
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
      lg.addColorStop(1, rgba('#ffffff', dark ? 0.12 : 0.3));
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
      sg.fillStyle = '#0d3a8c';
      sg.fillRect(0, 0, W, H);
      put(sl, { blur: 80, alpha: 0.3, dy: 50 });
    }
    put(fl);
    glow(g, cx, cy, H * 0.1, dark ? '#7fb8ff' : '#cfe4ff', dark ? 0.3 : 0.35);
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

  // ------------------------------------------------------------------ Aurora
  function aurora() {
    const horizon = H * 0.74;
    fillAll(
      g,
      vgrad(g, [
        [0, '#010310'],
        [0.4, '#03102a'],
        [0.68, '#0a2a4a'],
        [0.74, '#16405e'],
      ]),
    );
    const r = rng(41);
    // stars
    for (let i = 0; i < 1100; i++) {
      const x = r() * W;
      const y = r() ** 1.5 * horizon;
      const s = (0.3 + r() ** 4 * 1.5) * S * 1.4;
      g.fillStyle = `rgba(255,255,255,${0.25 + r() * 0.7})`;
      g.beginPath();
      g.arc(x, y, s, 0, TAU);
      g.fill();
    }
    for (let i = 0; i < 18; i++) glow(g, r() * W, r() ** 1.5 * horizon * 0.7, 9 * S, '#cfe6ff', 0.45);
    // curtains
    const [al, ag] = layer();
    ag.globalCompositeOperation = 'lighter';
    const curtains = [
      { base: 0.48, amp: 0.15, hgt: 0.36, f: 1.7, seed: 51, low: '#4dffb8', mid: '#19e0a2', top: '#8a5cff', a: 0.3 },
      { base: 0.38, amp: 0.08, hgt: 0.26, f: 3.1, seed: 52, low: '#8affdc', mid: '#25cfe8', top: '#4a5cff', a: 0.18 },
      { base: 0.58, amp: 0.09, hgt: 0.18, f: 3.2, seed: 53, low: '#c2ff9a', mid: '#2ae39a', top: '#c25cff', a: 0.16 },
    ];
    for (const cu of curtains) {
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
    put(al, { blur: 60, op: 'lighter', alpha: 0.8 });
    put(al, { blur: 3, op: 'lighter', alpha: 0.85 });
    // distant range
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
    range(0.735, 0.1, '#0a1a2c', 61, 0.006);
    range(0.745, 0.05, '#050d18', 62, 0.004);
    // lake: reflect the sky and mountains
    const lake = H - horizon;
    g.save();
    g.translate(0, horizon * 2);
    g.scale(1, -1);
    g.globalAlpha = 0.55;
    g.drawImage(c, 0, horizon - lake * 1.0, W, lake, 0, horizon - lake, W, lake);
    g.restore();
    g.fillStyle = vgrad(g, [
      [0, 'rgba(2,8,18,0.35)'],
      [1, 'rgba(1,4,10,0.92)'],
    ], horizon, H);
    g.fillRect(0, horizon, W, lake);
    // ripples
    for (let i = 0; i < 160; i++) {
      const y = horizon + r() ** 1.6 * lake;
      const x = r() * W;
      const w = (40 + r() * 260) * S * (1 + (y - horizon) / lake);
      g.fillStyle = `rgba(150,255,220,${0.03 + r() * 0.05})`;
      g.fillRect(x, y, w, 1.2 * S);
    }
    // shoreline
    g.fillStyle = '#01050b';
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
  function dunes() {
    fillAll(
      g,
      vgrad(g, [
        [0, '#efd9cf'],
        [0.3, '#f6d2b4'],
        [0.5, '#f9c497'],
        [0.56, '#fbcf9f'],
      ]),
    );
    glow(g, W * 0.3, H * 0.45, H * 0.6, '#fff1d6', 0.7);
    g.fillStyle = 'rgba(255,248,232,0.9)';
    g.beginPath();
    g.arc(W * 0.3, H * 0.45, H * 0.035, 0, TAU);
    g.fill();
    const layers = [
      { base: 0.52, amp: 0.05, lit: '#f2b48a', shade: '#d98f6c', seed: 81, peaks: 3 },
      { base: 0.6, amp: 0.07, lit: '#efa271', shade: '#cc7a52', seed: 82, peaks: 3 },
      { base: 0.69, amp: 0.08, lit: '#ea8f58', shade: '#b8603a', seed: 83, peaks: 2 },
      { base: 0.79, amp: 0.1, lit: '#e17a40', shade: '#9e4826', seed: 84, peaks: 2 },
      { base: 0.92, amp: 0.12, lit: '#d4682e', shade: '#7f3519', seed: 85, peaks: 2 },
    ];
    for (const L of layers) {
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
        for (const p of pts) {
          // windward: long convex rise to the peak
          ctx.bezierCurveTo(prev.x + (p.px - prev.x) * 0.45, prev.y, p.px - (p.px - prev.x) * 0.25, p.py, p.px, p.py);
          // lee: short drop to the valley
          ctx.bezierCurveTo(p.px + (p.vx - p.px) * 0.35, p.py + (p.vy - p.py) * 0.2, p.vx - (p.vx - p.px) * 0.35, p.vy, p.vx, p.vy);
          prev = { x: p.vx, y: p.vy };
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
      for (const p of pts) {
        const depth = H * L.amp * (1.2 + r() * 0.8);
        g.beginPath();
        g.moveTo(p.px, p.py);
        g.bezierCurveTo(p.px + (p.vx - p.px) * 0.35, p.py + (p.vy - p.py) * 0.2, p.vx - (p.vx - p.px) * 0.35, p.vy, p.vx, p.vy);
        g.bezierCurveTo(p.vx + (p.vx - p.px) * 0.4, p.vy + depth * 0.9, p.px + (p.vx - p.px) * 0.1, p.py + depth * 1.1, p.px, p.py);
        g.closePath();
        const sg = g.createLinearGradient(p.px, p.py, p.vx, p.vy + depth);
        sg.addColorStop(0, rgba(L.shade, 0.95));
        sg.addColorStop(1, rgba(L.shade, 0.35));
        g.fillStyle = sg;
        g.fill();
      }
      // haze at the foot of each layer for depth
      g.fillStyle = vgrad(g, [
        [0, 'rgba(255,214,170,0)'],
        [1, 'rgba(255,214,170,0.18)'],
      ], H * L.base, H);
      g.fillRect(0, H * L.base, W, H);
      g.restore();
      // crisp sunlit crest line
      g.save();
      g.beginPath();
      crest(g);
      g.strokeStyle = 'rgba(255,236,210,0.35)';
      g.lineWidth = 1.4 * S;
      g.stroke();
      g.restore();
    }
  }

  const scenes = {
    'bloom-light': () => bloom(false),
    'bloom-dark': () => bloom(true),
    'glow-light': () => glowScene(false),
    'glow-dark': () => glowScene(true),
    'flow-light': () => flow(false),
    'flow-dark': () => flow(true),
    sunrise,
    aurora,
    dunes,
  };
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
