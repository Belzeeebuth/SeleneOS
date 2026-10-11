#!/usr/bin/env node
// Renders Selene's built-in wallpapers: an original lunar set (night and moon scenes, lunar abstracts), drawn
// procedurally with the Canvas 2D API inside an offscreen Electron/Chromium window (driven by playwright-core,
// like test/lib.mjs). No external images. Output: renderer/assets/wallpapers/<name>.jpg, 2560x1440, JPEG ~q88,
// < 1.2 MB. Every gradient gets a fine grain (dither) so nothing bands.
//
//   xvfb-run -a node tools/gen-wallpapers.mjs                         # every wallpaper + the contact sheet
//   xvfb-run -a node tools/gen-wallpapers.mjs --only=nocturne-dark --scale=0.5 --out=/tmp/wp
//   xvfb-run -a node tools/gen-wallpapers.mjs --only=dynamic         # the time-of-day variants (dynamic/*.jpg)
//   xvfb-run -a node tools/gen-wallpapers.mjs --sheet-only           # docs/design/wallpapers-sheet.jpg only
//
// Static wallpapers (core/theme.js WALLPAPERS: builtin:<id> -> <id>-light.jpg / <id>-dark.jpg):
//   nocturne     moon low over a calm lake (dark) / the same lake at dawn (light)
//   eclipse      black disc with a thin cream ring and an amber corona (dark) / white disc on a pale sky (light)
//   clairdelune  moon phases on an arc over dunes, warm night (dark) / lavender and peach dawn (light)
//   forest       moonlit pine forest in layers of mist
//   peaks        mountains under a crescent with earthshine (dark) / alpenglow at dawn (light)
//   milkyway     the Milky Way over a dark horizon (one picture for both modes)
// Time-of-day sets (core/wallpaper/dynamic.js): dynamic/<set>-<phase>.jpg. Dawn and night reuse the static
// pictures of the same scene (lake: nocturne-light / nocturne-dark, dunes: clairdelune-*, peaks: peaks-*), so only
// the day and dusk variants are rendered here.
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

export const NAMES = ['nocturne-dark', 'nocturne-light', 'eclipse-dark', 'eclipse-light', 'clairdelune-dark', 'clairdelune-light',
  'forest-dark', 'forest-light', 'peaks-dark', 'peaks-light', 'milkyway'];
export const DYNAMIC_NAMES = ['lake', 'dunes', 'peaks'].flatMap((set) => ['day', 'dusk'].map((ph) => `dynamic/${set}-${ph}`));
const only = arg('only', '') ? arg('only', '').split(',').flatMap((n) => (n === 'dynamic' ? DYNAMIC_NAMES : [n])) : [...NAMES, ...DYNAMIC_NAMES];
const sheetOnly = process.argv.includes('--sheet-only');
const scale = Number(arg('scale', '1')) || 1;
const OUT_DIR = path.resolve(arg('out', path.join(here, '..', 'renderer', 'assets', 'wallpapers')));
const SHEET = path.resolve(here, '..', '..', 'docs', 'design', 'wallpapers-sheet.jpg');
const MAX_BYTES = 1200 * 1024;
const W = Math.round(2560 * scale);
const H = Math.round(1440 * scale);

// ---------------------------------------------------------------------------------------------
// Everything below `render` runs inside Chromium (serialised by Playwright), so it must be self-contained.
// Coordinates are authored for 2560x1440 (a global transform scales them).
function render({ id, W, H, quality }) {
  const S = W / 2560;
  const WW = 2560;
  const HH = 1440;
  const TAU = Math.PI * 2;
  const mk = () => {
    const cv = document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    const cx = cv.getContext('2d');
    cx.setTransform(S, 0, 0, S, 0, 0);
    return [cv, cx];
  };
  const [c, g] = mk();
  const [L, lg] = mk(); // scratch layer (moons)

  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const hx = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const rgba = (h, a = 1) => {
    const [r, gg, b] = hx(h);
    return `rgba(${r},${gg},${b},${a})`;
  };
  const mix = (a, b, t) => {
    const A = hx(a);
    const B = hx(b);
    return '#' + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, '0')).join('');
  };
  const blur = (ctx, px) => { ctx.filter = px > 0 ? `blur(${(px * S).toFixed(2)}px)` : 'none'; };
  function vgrad(ctx, y0, y1, stops) {
    const gr = ctx.createLinearGradient(0, y0, 0, y1);
    for (const [o, col, a = 1] of stops) gr.addColorStop(o, rgba(col, a));
    return gr;
  }
  function fillV(y0, y1, stops) {
    g.fillStyle = vgrad(g, y0, y1, stops);
    g.fillRect(0, y0, WW, y1 - y0);
  }
  function glow(x, y, r, col, a, ry = r) {
    g.save();
    g.translate(x, y);
    g.scale(1, ry / r);
    const gr = g.createRadialGradient(0, 0, 0, 0, 0, r);
    gr.addColorStop(0, rgba(col, a));
    gr.addColorStop(0.3, rgba(col, a * 0.45));
    gr.addColorStop(0.65, rgba(col, a * 0.12));
    gr.addColorStop(1, rgba(col, 0));
    g.fillStyle = gr;
    g.fillRect(-r, -r, 2 * r, 2 * r);
    g.restore();
  }
  // Smooth 1D noise (sum of sines), -1..1
  function smooth(seed, oct = 4, base = 1) {
    const r = rng(seed);
    const comps = Array.from({ length: oct }, (_, i) => ({ f: ((0.7 + r() * 0.7) * base * Math.pow(2.1, i) * TAU) / WW, p: r() * TAU, a: Math.pow(0.5, i) }));
    const n = comps.reduce((s, k) => s + k.a, 0);
    return (x) => comps.reduce((s, k) => s + k.a * Math.sin(x * k.f + k.p), 0) / n;
  }
  // Jagged 1D noise (midpoint displacement), about -1..1
  function jagged(seed, rough = 0.55) {
    const r = rng(seed);
    const N = 1024;
    const a = new Float32Array(N + 1);
    a[0] = r() * 2 - 1;
    a[N] = r() * 2 - 1;
    for (let step = N, s = 0.9; step > 1; step >>= 1, s *= rough) {
      const h = step >> 1;
      for (let i = h; i < N; i += step) a[i] = (a[i - h] + a[i + h]) / 2 + (r() * 2 - 1) * s;
    }
    return (x) => {
      const t = Math.max(0, Math.min(1, x / WW)) * N;
      const i = Math.min(N - 1, Math.floor(t));
      const f = t - i;
      return a[i] * (1 - f) + a[i + 1] * f;
    };
  }
  function ridgePath(ctx, fy, step = 4) {
    ctx.beginPath();
    ctx.moveTo(-10, HH + 10);
    for (let x = -10; x <= WW + 10; x += step) ctx.lineTo(x, fy(x));
    ctx.lineTo(WW + 10, HH + 10);
    ctx.closePath();
  }
  function ridge(fy, fill, rim = null, rimA = 0, step = 4) {
    ridgePath(g, fy, step);
    g.fillStyle = fill;
    g.fill();
    if (rim && rimA > 0) {
      g.save();
      blur(g, 0.6);
      g.beginPath();
      for (let x = -10; x <= WW + 10; x += step) g.lineTo(x, fy(x) + 0.8);
      g.strokeStyle = rgba(rim, rimA);
      g.lineWidth = 1.6;
      g.stroke();
      g.restore();
    }
  }
  function mist(y, h, col, a) {
    g.fillStyle = vgrad(g, y - h, y + h, [[0, col, 0], [0.5, col, a], [1, col, 0]]);
    g.fillRect(0, y - h, WW, 2 * h);
  }
  function stars(seed, n, { y0 = 0, y1 = 900, x0 = 0, x1 = WW, maxA = 0.7, col = '#E6ECFA', fade = 1.6, avoid = null } = {}) {
    const r = rng(seed);
    for (let i = 0; i < n; i++) {
      const x = x0 + r() * (x1 - x0);
      const t = Math.pow(r(), fade);
      const y = y0 + t * (y1 - y0);
      if (avoid && Math.hypot(x - avoid.x, y - avoid.y) < avoid.r) continue;
      const big = r() < 0.04;
      const rad = big ? 1.1 + r() * 0.7 : 0.45 + Math.pow(r(), 2) * 0.7;
      const a = maxA * (0.15 + Math.pow(r(), 2.2) * 0.85) * (1 - t * 0.55);
      if (big) {
        const gr = g.createRadialGradient(x, y, 0, x, y, rad * 5);
        gr.addColorStop(0, rgba(col, a * 0.35));
        gr.addColorStop(1, rgba(col, 0));
        g.fillStyle = gr;
        g.fillRect(x - rad * 5, y - rad * 5, rad * 10, rad * 10);
      }
      g.fillStyle = rgba(col, a);
      g.beginPath();
      g.arc(x, y, rad, 0, TAU);
      g.fill();
    }
  }
  // Maria, laid out after the real near side (north up). Low contrast and broken into irregular patches, with
  // Procellarum/Imbrium merged and Serenitatis-Tranquillitatis-Fecunditatis as one chain: no "face".
  const MARIA = [
    [-0.64, 0.04, 0.17, 0.4, 0.9], [-0.5, -0.26, 0.22, 0.2, 0.95], [-0.3, -0.44, 0.22, 0.16, 1], [-0.56, 0.36, 0.13, 0.15, 0.75],
    [-0.72, -0.16, 0.1, 0.24, 0.7], [-0.08, -0.74, 0.3, 0.055, 0.55], [0.22, -0.72, 0.16, 0.05, 0.5], [0.2, -0.4, 0.14, 0.13, 1],
    [0.33, -0.1, 0.19, 0.15, 1], [0.5, 0.15, 0.11, 0.15, 0.8], [0.7, -0.3, 0.085, 0.075, 0.95], [0.32, 0.3, 0.075, 0.065, 0.75],
    [0.02, -0.22, 0.075, 0.055, 0.65], [-0.18, 0.43, 0.15, 0.11, 0.8], [-0.3, 0.2, 0.12, 0.09, 0.65], [-0.48, 0.5, 0.075, 0.065, 0.75],
  ];
  // A moon: k = lit fraction (0 new .. 1 full); waxing = lit on the right. Colours: lit, limb, maria, earthshine.
  function moon({ x, y, r, k = 1, waxing = true, lit = '#F4F6FA', limb = '#C3CBDB', maria = '#6E7A95', mariaA = 0.17, earth = 0.07, earthCol = null,
    halo = null, haloA = 0.3, haloR = 4, alpha = 1, ring = 0, seed = 7, detail = true }) {
    if (halo) glow(x, y, r * haloR, halo, haloA);
    if (k < 0.999 && earth > 0) {
      g.fillStyle = rgba(earthCol || lit, earth);
      g.beginPath();
      g.arc(x, y, r, 0, TAU);
      g.fill();
    }
    if (ring > 0) {
      g.strokeStyle = rgba(earthCol || lit, ring);
      g.lineWidth = 1;
      g.beginPath();
      g.arc(x, y, r, 0, TAU);
      g.stroke();
    }
    if (k <= 0.001) return;
    lg.save();
    lg.setTransform(1, 0, 0, 1, 0, 0);
    lg.clearRect(0, 0, W, H);
    lg.restore();
    lg.save();
    lg.translate(x, y);
    // lit area
    lg.save();
    if (!waxing) lg.scale(-1, 1);
    lg.beginPath();
    lg.arc(0, 0, r, -Math.PI / 2, Math.PI / 2, false);
    const rx = r * Math.abs(2 * k - 1);
    lg.ellipse(0, 0, Math.max(rx, 0.01), r, 0, Math.PI / 2, -Math.PI / 2, k < 0.5);
    lg.closePath();
    lg.restore();
    const gr = lg.createRadialGradient(r * 0.22 * (waxing ? 1 : -1), -r * 0.3, 0, 0, 0, r * 1.05);
    gr.addColorStop(0, lit);
    gr.addColorStop(0.7, mix(lit, limb, 0.35));
    gr.addColorStop(1, limb);
    lg.fillStyle = gr;
    blur(lg, Math.max(0.6, r * 0.012));
    lg.fill();
    // surface: maria, speckles, a few bright craters (all clipped to the lit area)
    lg.globalCompositeOperation = 'source-atop';
    const rr = rng(seed);
    blur(lg, r * 0.07);
    for (const [dx, dy, ax, ay, w] of MARIA) {
      for (let j = 0; j < 5; j++) {
        lg.fillStyle = rgba(maria, (mariaA * w) / 3);
        lg.beginPath();
        lg.ellipse(r * (dx + (rr() - 0.5) * ax * 1.1), r * (dy + (rr() - 0.5) * ay * 1.1), r * ax * (0.55 + rr() * 0.6), r * ay * (0.55 + rr() * 0.6), rr() * Math.PI, 0, TAU);
        lg.fill();
      }
    }
    if (detail && r > 40) {
      blur(lg, 0.8);
      for (let i = 0; i < Math.round(r * 1.2); i++) {
        const a = rr() * TAU;
        const d = Math.sqrt(rr()) * r;
        lg.fillStyle = rr() < 0.5 ? rgba(maria, 0.025 + rr() * 0.035) : rgba('#FFFFFF', 0.04 + rr() * 0.06);
        lg.beginPath();
        lg.arc(Math.cos(a) * d, Math.sin(a) * d, r * (0.005 + rr() * 0.012), 0, TAU);
        lg.fill();
      }
      // Tycho with faint rays, Copernicus, Kepler
      blur(lg, r * 0.01);
      const T = [-0.12, 0.72];
      lg.strokeStyle = rgba('#FFFFFF', 0.06);
      lg.lineWidth = r * 0.012;
      for (let i = 0; i < 14; i++) {
        const a = rr() * TAU;
        const len = r * (0.25 + rr() * 0.55);
        lg.beginPath();
        lg.moveTo(T[0] * r, T[1] * r);
        lg.lineTo(T[0] * r + Math.cos(a) * len, T[1] * r + Math.sin(a) * len);
        lg.stroke();
      }
      for (const [cx, cy, cr, ca] of [[T[0], T[1], 0.035, 0.55], [-0.33, -0.12, 0.03, 0.4], [-0.55, -0.06, 0.022, 0.35], [0.38, 0.52, 0.02, 0.3]]) {
        lg.fillStyle = rgba('#FFFFFF', ca);
        lg.beginPath();
        lg.arc(cx * r, cy * r, cr * r, 0, TAU);
        lg.fill();
      }
    }
    lg.globalCompositeOperation = 'source-over';
    blur(lg, 0);
    lg.restore();
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = alpha;
    g.drawImage(L, 0, 0);
    g.restore();
  }
  function grain(amt, seed = 99) {
    const im = g.getImageData(0, 0, W, H);
    const d = im.data;
    let s = seed >>> 0;
    for (let i = 0; i < d.length; i += 4) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      const a = (s & 0xffff) / 65536;
      const b = (s >>> 16) / 65536;
      const n = (a + b - 1) * amt;
      d[i] += n;
      d[i + 1] += n;
      d[i + 2] += n;
    }
    g.putImageData(im, 0, 0);
  }
  function clouds(seed, n, y0, y1, col, a) {
    const r = rng(seed);
    g.save();
    blur(g, 14);
    for (let i = 0; i < n; i++) {
      g.fillStyle = rgba(col, a * (0.4 + r() * 0.6));
      g.beginPath();
      g.ellipse(r() * WW, y0 + r() * (y1 - y0), 180 + r() * 380, 5 + r() * 9, 0, 0, TAU);
      g.fill();
    }
    g.restore();
  }

  // ---------------------------------------------------------------- scenes
  // Lake (Nocturne): a moon low over calm water, its reflection broken into glints, a low far shore.
  function lake(P) {
    const HZ = 930;
    fillV(0, HZ, P.sky);
    glow(P.moon.x, P.moon.y, 700, P.skyGlow, P.skyGlowA);
    if (P.stars) stars(11, P.stars, { y0: 0, y1: HZ - 60, maxA: P.starA, col: P.starCol, avoid: { x: P.moon.x, y: P.moon.y, r: 260 } });
    clouds(5, 9, 280, HZ - 120, P.cloud, P.cloudA);
    moon(P.moon);
    // far shore: hills left and right, a thin tree line in between
    const hills = smooth(21, 4, 2.2);
    const shore = (x) => {
      const left = Math.max(0, 1 - x / 1150);
      const right = Math.max(0, (x - 1950) / 610);
      return HZ - 7 - 5 * (hills(x * 3) * 0.5 + 0.5) - 78 * Math.pow(left, 1.4) * (0.75 + 0.25 * hills(x)) - 46 * Math.pow(right, 1.2) * (0.8 + 0.2 * hills(x + 400));
    };
    ridge(shore, P.shore, P.shoreRim, P.shoreRimA);
    // water
    g.fillStyle = vgrad(g, HZ, HH, P.water);
    g.fillRect(0, HZ, WW, HH - HZ);
    // mirrored shore (soft)
    g.save();
    blur(g, 2.5);
    g.globalAlpha = 0.55;
    g.beginPath();
    g.moveTo(-10, HZ);
    for (let x = -10; x <= WW + 10; x += 6) g.lineTo(x, HZ + (HZ - shore(x)) * 0.8);
    g.lineTo(WW + 10, HZ);
    g.closePath();
    g.fillStyle = P.shore;
    g.fill();
    g.restore();
    // glow of the moon on the water
    glow(P.moon.x, HZ + 40, 520, P.skyGlow, P.waterGlowA, 120);
    // glints
    const r = rng(31);
    const M = P.moon.x;
    let y = HZ + 3;
    while (y < HH) {
      const t = (y - HZ) / (HH - HZ);
      const calm = Math.min(1, Math.max(0, (HH - 70 - y) / 160)); // keep the bar zone calm
      const n = 1 + Math.floor(t * 4);
      for (let k = 0; k < n; k++) {
        const spread = 26 + t * 230;
        const x = M + (r() + r() + r() - 1.5) * spread * 1.4;
        const w = (10 + t * 150) * (0.3 + r());
        const h = 0.9 + t * 3;
        const o = P.glintA * (1 - t * 0.7) * (0.35 + 0.65 * r()) * Math.exp(-Math.pow((x - M) / (60 + t * 210), 2)) * calm;
        if (o < 0.015) continue;
        g.fillStyle = rgba(P.glint, o);
        g.beginPath();
        g.roundRect(x - w / 2, y, w, h, h / 2);
        g.fill();
      }
      y += 1.6 + t * t * 9 + r() * 1.5;
    }
    // ripples
    for (let i = 0; i < 260; i++) {
      const t = Math.pow(r(), 0.8);
      const yy = HZ + 4 + t * (HH - HZ - 80);
      const w = 40 + r() * (80 + t * 420);
      g.fillStyle = rgba(P.ripple, P.rippleA * (0.4 + r() * 0.6));
      g.fillRect(r() * WW - w / 2, yy, w, 0.8 + t * 1.2);
    }
    mist(HZ - 6, 26, P.mist, P.mistA);
  }

  // Dunes (Clair de lune): moon phases on an arc (or one moon), soft dunes with moonlit crests.
  function dunes(P) {
    const HZ = 900;
    fillV(0, HZ + 120, P.sky);
    glow(1280, HZ, 1100, P.horizonGlow, P.horizonGlowA, 360);
    if (P.stars) stars(41, P.stars, { y0: 0, y1: 760, maxA: P.starA, col: P.starCol });
    if (P.arc) {
      const ph = [0.07, 0.24, 0.5, 0.78, 1, 0.78, 0.5, 0.24, 0.07];
      const rad = [24, 28, 32, 37, 50, 37, 32, 28, 24];
      // faint orbit line
      g.save();
      g.setLineDash([3, 9]);
      g.strokeStyle = rgba(P.moonC.lit, P.orbitA);
      g.lineWidth = 1.2;
      g.beginPath();
      for (let i = -11; i <= 11; i++) {
        const t = i / 8;
        g.lineTo(1280 + t * 860, 250 + t * t * 150);
      }
      g.stroke();
      g.restore();
      ph.forEach((k, i) => {
        const t = (i - 4) / 4;
        moon({ ...P.moonC, x: 1280 + t * 860, y: 250 + t * t * 150, r: rad[i], k, waxing: i < 4, seed: 70 + i, halo: i === 4 ? P.moonC.halo : null, haloA: P.moonC.haloA, haloR: 3.2, ring: P.ring });
      });
    }
    if (P.moon) moon(P.moon);
    // dunes, back to front
    P.layers.forEach((Ly, i) => {
      const n = smooth(100 + i * 13, 3, 0.7 + i * 0.25);
      const n2 = smooth(200 + i * 7, 2, 2.4);
      const fy = (x) => Ly.y - Ly.amp * (0.65 * n(x) + 0.35 * Math.abs(n2(x)));
      mist(Ly.y - Ly.amp * 0.4, 70, P.mist, P.mistA);
      ridge(fy, vgrad(g, Ly.y - Ly.amp, HH, [[0, Ly.top], [0.35, Ly.mid], [1, Ly.bottom]]), Ly.rim, Ly.rimA, 3);
    });
  }

  // Forest: layers of pines in the mist under a crescent.
  function fir(ctx, x, y, h, w, r) {
    const tiers = 7 + Math.floor(r() * 4);
    ctx.moveTo(x, y - h);
    for (let i = 1; i <= tiers; i++) {
      const t = i / tiers;
      const yy = y - h + h * t * 0.94;
      const ww = w * t * (0.8 + r() * 0.35);
      ctx.lineTo(x + ww, yy);
      ctx.lineTo(x + ww * 0.42, yy - h * 0.025);
    }
    ctx.lineTo(x + w * 0.06, y + 4);
    ctx.lineTo(x - w * 0.06, y + 4);
    for (let i = tiers; i >= 1; i--) {
      const t = i / tiers;
      const yy = y - h + h * t * 0.94;
      const ww = w * t * (0.8 + r() * 0.35);
      ctx.lineTo(x - ww * 0.42, yy - h * 0.025);
      ctx.lineTo(x - ww, yy);
    }
    ctx.closePath();
  }
  function forest(P) {
    fillV(0, HH, P.sky);
    glow(P.moon.x, P.moon.y, 620, P.skyGlow, P.skyGlowA);
    if (P.stars) stars(51, P.stars, { y0: 0, y1: 760, maxA: P.starA, col: P.starCol, avoid: { x: P.moon.x, y: P.moon.y, r: 200 } });
    moon(P.moon);
    const layers = [
      { y: 820, amp: 120, th: 70, d: 0.9 },
      { y: 930, amp: 110, th: 105, d: 0.85 },
      { y: 1060, amp: 100, th: 150, d: 0.8 },
      { y: 1220, amp: 90, th: 220, d: 0.75 },
      { y: 1400, amp: 70, th: 300, d: 0.7 },
    ];
    layers.forEach((Ly, i) => {
      const t = i / (layers.length - 1);
      const col = mix(P.far, P.near, Math.pow(t, 0.8));
      const n = smooth(300 + i * 17, 3, 0.8);
      const fy = (x) => Ly.y - Ly.amp * (0.5 + 0.5 * n(x));
      const r = rng(400 + i);
      g.fillStyle = col;
      ridgePath(g, fy, 6);
      g.fill();
      g.beginPath();
      let x = -30;
      while (x < WW + 30) {
        const h = Ly.th * (0.5 + r() * 0.65);
        const w = h * (0.2 + r() * 0.08);
        if (r() > 0.12) fir(g, x, fy(x) + 6, h, w, r);
        x += w * (0.55 + r() * 1.1) * Ly.d;
      }
      g.fill();
      if (i < layers.length - 1) mist(Ly.y + 10, 90 - i * 8, P.mist, P.mistA * (1 - t * 0.5));
    });
  }

  // Peaks: mountain ranges (moonlit rims), a crescent with earthshine.
  function peaks(P) {
    fillV(0, HH, P.sky);
    glow(P.moon.x, P.moon.y, 620, P.skyGlow, P.skyGlowA);
    if (P.stars) stars(61, P.stars, { y0: 0, y1: 820, maxA: P.starA, col: P.starCol, avoid: { x: P.moon.x, y: P.moon.y, r: 180 } });
    moon(P.moon);
    const layers = [
      { y: 900, amp: 440, rough: 0.6 },
      { y: 1030, amp: 280, rough: 0.58 },
      { y: 1180, amp: 190, rough: 0.55 },
      { y: 1350, amp: 110, rough: 0.5 },
    ];
    layers.forEach((Ly, i) => {
      const t = i / (layers.length - 1);
      const n = jagged(500 + i * 11, Ly.rough);
      const s = smooth(600 + i, 2, 0.6);
      const fy = (x) => Ly.y - Ly.amp * Math.max(0.05, 0.5 + 0.9 * n(x)) * (0.7 + 0.3 * s(x));
      const col = mix(P.far, P.near, t);
      mist(Ly.y - Ly.amp * 0.3, 110, P.mist, P.mistA * (1 - t * 0.6));
      ridge(fy, vgrad(g, Ly.y - Ly.amp, Ly.y + 120, [[0, mix(col, P.rim, P.rimMix * (1 - t))], [0.45, col], [1, mix(col, P.near, 0.4)]]), P.rim, P.rimA * (1 - t * 0.7), 2);
    });
  }

  // Eclipse: a disc with a thin ring and a corona of fine streamers; orbit circles; heavier grain.
  function eclipse(P) {
    const X = 1600;
    const Y = 610;
    const R = 236;
    g.fillStyle = P.bg;
    g.fillRect(0, 0, WW, HH);
    glow(X, Y, 1500, P.bgGlow, P.bgGlowA);
    // orbits
    g.save();
    g.strokeStyle = rgba(P.orbit, P.orbitA);
    g.lineWidth = 1.2;
    for (const [rx, ry, a] of [[520, 520, 0], [800, 300, -0.32], [1150, 1150, 0]]) {
      g.beginPath();
      g.ellipse(X, Y, rx, ry, a, 0, TAU);
      g.stroke();
    }
    g.fillStyle = rgba(P.orbit, P.orbitA * 3);
    g.beginPath();
    g.arc(X + 520 * Math.cos(2.5), Y + 520 * Math.sin(2.5), 5, 0, TAU);
    g.fill();
    g.restore();
    if (P.stars) stars(71, P.stars, { y0: 0, y1: 1100, maxA: P.starA, col: P.starCol, fade: 1.2, avoid: { x: X, y: Y, r: 560 } });
    // corona
    glow(X, Y, R * 3.2, P.corona, P.coronaA);
    const r = rng(77);
    g.save();
    blur(g, 3);
    g.lineCap = 'round';
    for (let i = 0; i < 520; i++) {
      const a = r() * TAU;
      const len = R * (0.08 + Math.pow(r(), 2.6) * (0.9 + 0.5 * Math.abs(Math.cos(a))));
      const gr = g.createLinearGradient(X + Math.cos(a) * R, Y + Math.sin(a) * R, X + Math.cos(a) * (R + len), Y + Math.sin(a) * (R + len));
      gr.addColorStop(0, rgba(P.streamer, P.streamerA * (0.4 + r() * 0.6)));
      gr.addColorStop(1, rgba(P.streamer, 0));
      g.strokeStyle = gr;
      g.lineWidth = 1 + r() * 3;
      g.beginPath();
      g.moveTo(X + Math.cos(a) * R * 0.98, Y + Math.sin(a) * R * 0.98);
      g.lineTo(X + Math.cos(a) * (R + len), Y + Math.sin(a) * (R + len));
      g.stroke();
    }
    g.restore();
    // ring
    g.save();
    blur(g, 5);
    g.strokeStyle = rgba(P.ring, P.ringA * 0.5);
    g.lineWidth = 10;
    g.beginPath();
    g.arc(X, Y, R + 1, 0, TAU);
    g.stroke();
    blur(g, 0.8);
    g.strokeStyle = rgba(P.ring, P.ringA);
    g.lineWidth = 2.4;
    g.beginPath();
    g.arc(X, Y, R + 0.5, 0, TAU);
    g.stroke();
    g.restore();
    // disc
    g.fillStyle = P.disc;
    g.beginPath();
    g.arc(X, Y, R, 0, TAU);
    g.fill();
    // ghost of the moon's surface on the disc
    moon({ x: X, y: Y, r: R - 2, k: 1, lit: P.disc, limb: P.discLimb, maria: P.discMaria, mariaA: P.discMariaA, earth: 0, seed: 9, detail: false });
  }

  // Milky Way: a diagonal band of fine stars, glow clouds and dust lanes over a dark, calm horizon.
  function milkyway() {
    fillV(0, HH, [[0, '#03050B'], [0.55, '#070B17'], [0.85, '#0D1424'], [1, '#0A0F1B']]);
    const r = rng(81);
    const ax = 300;
    const ay = 1300;
    const bx = 2350;
    const by = 80;
    const len = Math.hypot(bx - ax, by - ay);
    const ux = (bx - ax) / len;
    const uy = (by - ay) / len;
    const along = (t, off) => [ax + ux * t * len - uy * off, ay + uy * t * len + ux * off];
    g.save();
    g.globalCompositeOperation = 'lighter';
    blur(g, 40);
    for (let i = 0; i < 70; i++) {
      const t = r();
      const [x, y] = along(t, (r() + r() - 1) * 300);
      const bright = Math.exp(-Math.pow((t - 0.42) / 0.3, 2));
      g.fillStyle = rgba(r() < 0.5 ? '#B9A88F' : '#8A9BC8', 0.018 + 0.035 * bright * r());
      g.beginPath();
      g.ellipse(x, y, 160 + r() * 260, 70 + r() * 120, Math.atan2(uy, ux), 0, TAU);
      g.fill();
    }
    g.restore();
    // fine stars: dense along the band
    for (let i = 0; i < 26000; i++) {
      const t = r();
      const off = (r() + r() + r() + r() - 2) * 230;
      const [x, y] = along(t, off);
      const a = (0.07 + Math.pow(r(), 3) * 0.45) * Math.exp(-Math.pow(off / 330, 2));
      g.fillStyle = rgba(r() < 0.8 ? '#E4E9F5' : '#F2E2C8', a);
      g.fillRect(x, y, 1.1, 1.1);
    }
    // dust lanes
    g.save();
    blur(g, 12);
    for (let i = 0; i < 60; i++) {
      const t = 0.1 + r() * 0.8;
      const [x, y] = along(t, (r() - 0.5) * 50 + 24 * Math.sin(t * 11));
      g.fillStyle = rgba('#05070E', 0.12 + r() * 0.16);
      g.beginPath();
      g.ellipse(x, y, 60 + r() * 140, 4 + r() * 10, Math.atan2(uy, ux) + (r() - 0.5) * 0.25, 0, TAU);
      g.fill();
    }
    g.restore();
    stars(83, 900, { y0: 0, y1: 1200, maxA: 0.55, col: '#E6ECFA', fade: 1.1 });
    // horizon: low dark hills, calm under the bar
    const n = smooth(84, 4, 1.4);
    ridge((x) => 1290 - 60 * (0.5 + 0.5 * n(x)), '#04060C', '#5D6B8C', 0.25);
    mist(1260, 40, '#2A3555', 0.18);
  }

  // ---------------------------------------------------------------- palettes
  const NIGHT_MOON = { lit: '#F4F6FA', limb: '#C1C9D9', maria: '#6C7894', mariaA: 0.19, earthCol: '#AFC0E4', earth: 0.06 };
  const PALE_MOON = { lit: '#FFFFFF', limb: '#E3E8F1', maria: '#93A0BA', mariaA: 0.2, earthCol: '#FFFFFF', earth: 0.0 };
  const WARM_MOON = { lit: '#FBF1E1', limb: '#E0CBAF', maria: '#9C8466', mariaA: 0.2, earthCol: '#F3E3CC', earth: 0.05 };
  const AMBER_MOON = { lit: '#F9E6C9', limb: '#E3B988', maria: '#A97F58', mariaA: 0.2, earth: 0 };

  const scenes = {
    'nocturne-dark': () => lake({
      sky: [[0, '#04060D'], [0.45, '#0A1122'], [0.85, '#17223C'], [1, '#22304F']],
      skyGlow: '#9FB3DA', skyGlowA: 0.2, waterGlowA: 0.1, stars: 520, starA: 0.6, starCol: '#E3EAF7', cloud: '#7C8FB8', cloudA: 0.09,
      moon: { ...NIGHT_MOON, x: 1700, y: 590, r: 92, halo: '#C6D3EE', haloA: 0.22, haloR: 3.4 },
      shore: '#0A1020', shoreRim: '#3B4B70', shoreRimA: 0.35, water: [[0, '#17223B'], [0.3, '#0E1629'], [1, '#05080F']],
      glint: '#E3EAF7', glintA: 0.62, ripple: '#9DB0D4', rippleA: 0.045, mist: '#3A4A70', mistA: 0.16,
    }),
    'nocturne-light': () => lake({
      sky: [[0, '#C9D4E7'], [0.5, '#E3E7F0'], [0.88, '#F1E5E3'], [1, '#F4DED6']],
      skyGlow: '#FFFFFF', skyGlowA: 0.35, waterGlowA: 0.22, stars: 0, cloud: '#FFFFFF', cloudA: 0.35,
      moon: { ...PALE_MOON, x: 1660, y: 420, r: 80, mariaA: 0.16, alpha: 0.9, halo: '#FFFFFF', haloA: 0.3, haloR: 3 },
      shore: '#9AA5BD', shoreRim: '#FFFFFF', shoreRimA: 0.2, water: [[0, '#E3E3EC'], [0.25, '#CBD3E2'], [1, '#A9B5CA']],
      glint: '#FFFFFF', glintA: 0.5, ripple: '#FFFFFF', rippleA: 0.12, mist: '#F4EEF0', mistA: 0.55,
    }),
    'dynamic/lake-day': () => lake({
      sky: [[0, '#5E86C2'], [0.55, '#97B5DD'], [1, '#D3E0EF']],
      skyGlow: '#FFFFFF', skyGlowA: 0.12, waterGlowA: 0.08, stars: 0, cloud: '#FFFFFF', cloudA: 0.4,
      moon: { ...PALE_MOON, x: 1680, y: 330, r: 64, k: 0.7, waxing: true, alpha: 0.6, maria: '#7D8FB3' },
      shore: '#4F6488', shoreRim: '#DDE6F3', shoreRimA: 0.2, water: [[0, '#8EA8CD'], [0.3, '#5F7CA8'], [1, '#2F4870']],
      glint: '#FFFFFF', glintA: 0.3, ripple: '#E6EEF8', rippleA: 0.12, mist: '#DCE6F2', mistA: 0.5,
    }),
    'dynamic/lake-dusk': () => lake({
      sky: [[0, '#151B33'], [0.45, '#2C3157'], [0.8, '#6E5A78'], [1, '#C48A78']],
      skyGlow: '#E7B48E', skyGlowA: 0.16, waterGlowA: 0.12, stars: 160, starA: 0.45, starCol: '#F1E8F2', cloud: '#C99A9A', cloudA: 0.14,
      moon: { ...AMBER_MOON, x: 900, y: 790, r: 74, halo: '#F2C79A', haloA: 0.2, haloR: 3.2 },
      shore: '#1A1B2E', shoreRim: '#B98C86', shoreRimA: 0.25, water: [[0, '#6F5873'], [0.3, '#2E2D4B'], [1, '#0F1222']],
      glint: '#F7DDBA', glintA: 0.55, ripple: '#E3B9A4', rippleA: 0.05, mist: '#B88C8E', mistA: 0.2,
    }),

    'clairdelune-dark': () => dunes({
      sky: [[0, '#0E0A09'], [0.5, '#1A1311'], [0.85, '#2C211C'], [1, '#3A2A22']],
      horizonGlow: '#8A6248', horizonGlowA: 0.28, stars: 420, starA: 0.55, starCol: '#FFF1DE', arc: true, orbitA: 0.08, ring: 0.16,
      moonC: { ...WARM_MOON, halo: '#F7E3C3', haloA: 0.2 },
      mist: '#6A5040', mistA: 0.1,
      layers: [
        { y: 960, amp: 90, top: '#4A382E', mid: '#3A2B24', bottom: '#2B201B', rim: '#C9A88A', rimA: 0.3 },
        { y: 1080, amp: 110, top: '#3A2B24', mid: '#2A1F1A', bottom: '#1E1613', rim: '#D9B896', rimA: 0.28 },
        { y: 1230, amp: 120, top: '#2A1F1A', mid: '#1C1512', bottom: '#120D0B', rim: '#E3C4A0', rimA: 0.22 },
        { y: 1400, amp: 90, top: '#1B1411', mid: '#130E0C', bottom: '#0C0908', rim: '#E3C4A0', rimA: 0.14 },
      ],
    }),
    'clairdelune-light': () => dunes({
      sky: [[0, '#BDB3D9'], [0.45, '#D9CCE0'], [0.85, '#F1D8D0'], [1, '#F6D6C2']],
      horizonGlow: '#FFE6D2', horizonGlowA: 0.5, stars: 0, arc: true, orbitA: 0.35, ring: 0.55,
      moonC: { ...PALE_MOON, earthCol: '#FFFFFF', earth: 0.16, maria: '#B4A6BF', mariaA: 0.24, halo: '#FFFFFF', haloA: 0.35 },
      mist: '#FBEDE6', mistA: 0.4,
      layers: [
        { y: 960, amp: 90, top: '#E7CFCB', mid: '#DCC1C0', bottom: '#D2B5B7', rim: '#FFF6EF', rimA: 0.5 },
        { y: 1080, amp: 110, top: '#D9BDBD', mid: '#CBAEB2', bottom: '#BFA1A8', rim: '#FFF3EA', rimA: 0.45 },
        { y: 1230, amp: 120, top: '#C8AAAF', mid: '#B999A2', bottom: '#AC8C97', rim: '#FBE9DF', rimA: 0.4 },
        { y: 1400, amp: 90, top: '#B4949E', mid: '#A88894', bottom: '#9C7D8A', rim: '#F5E1D8', rimA: 0.3 },
      ],
    }),
    'dynamic/dunes-day': () => dunes({
      sky: [[0, '#6E95C9'], [0.5, '#A9C2E0'], [0.9, '#E2E2DC'], [1, '#EDDFCB']],
      horizonGlow: '#FFF6E8', horizonGlowA: 0.35, stars: 0, arc: false,
      moon: { ...PALE_MOON, x: 1720, y: 300, r: 58, k: 0.62, waxing: false, alpha: 0.55, maria: '#7D8FB3' },
      mist: '#F5EBDD', mistA: 0.35,
      layers: [
        { y: 960, amp: 90, top: '#E3C9A4', mid: '#D9BB93', bottom: '#CDAC83', rim: '#FFF4E2', rimA: 0.5 },
        { y: 1080, amp: 110, top: '#D6B78E', mid: '#C9A67B', bottom: '#BB966C', rim: '#FFF0DA', rimA: 0.45 },
        { y: 1230, amp: 120, top: '#C49F74', mid: '#B48D63', bottom: '#A47D56', rim: '#FBE6C8', rimA: 0.35 },
        { y: 1400, amp: 90, top: '#A9835A', mid: '#9A754E', bottom: '#8C6946', rim: '#F2D9B8', rimA: 0.25 },
      ],
    }),
    'dynamic/dunes-dusk': () => dunes({
      sky: [[0, '#1C1830'], [0.45, '#3E3150'], [0.8, '#8E5A62'], [1, '#D98E68']],
      horizonGlow: '#F0A070', horizonGlowA: 0.3, stars: 140, starA: 0.4, starCol: '#FBE9E0', arc: false,
      moon: { ...AMBER_MOON, x: 820, y: 700, r: 70, halo: '#F6C9A0', haloA: 0.22, haloR: 3 },
      mist: '#B97F6E', mistA: 0.14,
      layers: [
        { y: 960, amp: 90, top: '#7A5450', mid: '#6A4744', bottom: '#5A3B39', rim: '#F2B48A', rimA: 0.35 },
        { y: 1080, amp: 110, top: '#5E3F3C', mid: '#4D3331', bottom: '#3F2928', rim: '#F0AD84', rimA: 0.3 },
        { y: 1230, amp: 120, top: '#422C2B', mid: '#352322', bottom: '#2A1C1B', rim: '#E9A27C', rimA: 0.22 },
        { y: 1400, amp: 90, top: '#2C1E1D', mid: '#231817', bottom: '#1A1211', rim: '#E09A76', rimA: 0.14 },
      ],
    }),

    'eclipse-dark': () => eclipse({
      bg: '#09090A', bgGlow: '#2A2117', bgGlowA: 0.55, orbit: '#E9DCC4', orbitA: 0.07, stars: 260, starA: 0.45, starCol: '#F3EBDD',
      corona: '#F2A63A', coronaA: 0.2, streamer: '#F5C27A', streamerA: 0.2, ring: '#FFF0D2', ringA: 0.95,
      disc: '#050506', discLimb: '#0B0B0D', discMaria: '#2A2723', discMariaA: 0.22,
    }),
    'eclipse-light': () => eclipse({
      bg: '#EFEDE8', bgGlow: '#FFFFFF', bgGlowA: 0.75, orbit: '#7A7266', orbitA: 0.12, stars: 0,
      corona: '#F0C58C', coronaA: 0.26, streamer: '#E8B676', streamerA: 0.16, ring: '#D9C7A6', ringA: 0.7,
      disc: '#FBFAF7', discLimb: '#ECE7DE', discMaria: '#B9AE9C', discMariaA: 0.14,
    }),

    'forest-dark': () => forest({
      sky: [[0, '#04060D'], [0.4, '#0A1120'], [0.62, '#16203A'], [1, '#1E2A45']],
      skyGlow: '#A9BDE4', skyGlowA: 0.16, stars: 380, starA: 0.55, starCol: '#E3EAF7',
      moon: { ...NIGHT_MOON, x: 640, y: 300, r: 66, k: 0.32, waxing: false, halo: '#C6D3EE', haloA: 0.16, haloR: 3.2 },
      far: '#25324F', near: '#05080F', mist: '#5D6F98', mistA: 0.16,
    }),
    'forest-light': () => forest({
      sky: [[0, '#C8D2E2'], [0.45, '#E2E6EE'], [0.7, '#EEEDF0'], [1, '#EDE9EA']],
      skyGlow: '#FFFFFF', skyGlowA: 0.35, stars: 0,
      moon: { ...PALE_MOON, x: 640, y: 300, r: 60, k: 0.4, waxing: false, alpha: 0.85 },
      far: '#C5CDDA', near: '#6A778E', mist: '#F4F3F5', mistA: 0.6,
    }),

    'peaks-dark': () => peaks({
      sky: [[0, '#03050B'], [0.45, '#0A1121'], [0.65, '#16203B'], [1, '#1C2742']],
      skyGlow: '#A9BDE4', skyGlowA: 0.15, stars: 460, starA: 0.6, starCol: '#E3EAF7',
      moon: { ...NIGHT_MOON, x: 1940, y: 290, r: 62, k: 0.2, waxing: true, earth: 0.1, halo: '#C6D3EE', haloA: 0.14, haloR: 3 },
      far: '#27324E', near: '#05080F', rim: '#8EA3CC', rimA: 0.45, rimMix: 0.35, mist: '#41527A', mistA: 0.14,
    }),
    'peaks-light': () => peaks({
      sky: [[0, '#B4C1DB'], [0.4, '#D9D9E6'], [0.62, '#F1DCD8'], [1, '#F2D2C2']],
      skyGlow: '#FFFFFF', skyGlowA: 0.3, stars: 0,
      moon: { ...PALE_MOON, x: 1940, y: 290, r: 56, k: 0.55, waxing: false, alpha: 0.8 },
      far: '#D0B4BE', near: '#6D7690', rim: '#FFEFE8', rimA: 0.5, rimMix: 0.45, mist: '#F7E7E2', mistA: 0.45,
    }),
    'dynamic/peaks-day': () => peaks({
      sky: [[0, '#4F7CBE'], [0.45, '#8DB0DD'], [0.65, '#C4D6EC'], [1, '#D8E3F0']],
      skyGlow: '#FFFFFF', skyGlowA: 0.12, stars: 0,
      moon: { ...PALE_MOON, x: 1940, y: 290, r: 54, k: 0.6, waxing: true, alpha: 0.55, maria: '#7D8FB3' },
      far: '#8696B6', near: '#2C3A55', rim: '#F4F7FC', rimA: 0.6, rimMix: 0.55, mist: '#E3ECF6', mistA: 0.4,
    }),
    'dynamic/peaks-dusk': () => peaks({
      sky: [[0, '#141932'], [0.45, '#33335A'], [0.65, '#7A5A75'], [1, '#C98670']],
      skyGlow: '#F0B48E', skyGlowA: 0.14, stars: 160, starA: 0.45, starCol: '#F1E8F2',
      moon: { ...AMBER_MOON, x: 1940, y: 380, r: 60, halo: '#F2C79A', haloA: 0.18, haloR: 3 },
      far: '#4E4562', near: '#120F19', rim: '#E2A88E', rimA: 0.4, rimMix: 0.35, mist: '#9A7088', mistA: 0.16,
    }),

    milkyway,
  };
  scenes[id]();
  grain(id.startsWith('eclipse') ? 5 : 3.2);
  return c.toDataURL('image/jpeg', quality);
}

// Contact sheet of the whole set (runs in Chromium too).
async function sheet({ items, cols, tw, th }) {
  const pad = 24;
  const lab = 34;
  const rows = Math.ceil(items.length / cols);
  const c = document.createElement('canvas');
  c.width = pad + cols * (tw + pad);
  c.height = pad + rows * (th + lab + pad) + 40;
  const g = c.getContext('2d');
  g.fillStyle = '#121826';
  g.fillRect(0, 0, c.width, c.height);
  g.font = '600 20px Inter, "Noto Sans", sans-serif';
  g.fillStyle = '#E6EAF2';
  g.fillText('Selene — fonds d’écran (tools/gen-wallpapers.mjs)', pad, 30);
  for (const [i, it] of items.entries()) {
    const img = new Image();
    img.src = it.url;
    await img.decode();
    const x = pad + (i % cols) * (tw + pad);
    const y = 40 + pad + Math.floor(i / cols) * (th + lab + pad);
    g.drawImage(img, x, y, tw, th);
    g.strokeStyle = '#2A3349';
    g.strokeRect(x + 0.5, y + 0.5, tw - 1, th - 1);
    g.font = '15px Inter, "Noto Sans", sans-serif';
    g.fillStyle = '#A9B2C5';
    g.fillText(it.name, x, y + th + 22);
  }
  return c.toDataURL('image/jpeg', 0.86);
}

// ---------------------------------------------------------------------------------------------
async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'selene-wpgen-'));
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
    page.on('pageerror', (e) => console.log(`[page error] ${e.message}`));
    fs.mkdirSync(OUT_DIR, { recursive: true });
    for (const id of sheetOnly ? [] : only) {
      const t0 = Date.now();
      let quality = 0.88;
      let buf;
      for (;;) {
        const url = await page.evaluate(render, { id, W, H, quality });
        buf = Buffer.from(url.split(',')[1], 'base64');
        if (buf.length <= MAX_BYTES || quality <= 0.7 || scale !== 1) break;
        quality -= 0.03;
      }
      const file = path.join(OUT_DIR, `${id}.jpg`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, buf);
      console.log(`${id}.jpg  ${W}x${H}  q${quality.toFixed(2)}  ${(buf.length / 1024).toFixed(0)} KB  ${Date.now() - t0} ms`);
    }
    // contact sheet of whatever is in OUT_DIR (full set when run without --only)
    if (sheetOnly || !arg('only', '')) {
      const items = [...NAMES, ...DYNAMIC_NAMES]
        .filter((n) => fs.existsSync(path.join(OUT_DIR, `${n}.jpg`)))
        .map((n) => ({ name: `${n}.jpg`, url: `data:image/jpeg;base64,${fs.readFileSync(path.join(OUT_DIR, `${n}.jpg`)).toString('base64')}` }));
      const url = await page.evaluate(sheet, { items, cols: 4, tw: 480, th: 270 });
      const out = arg('sheet', SHEET);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, Buffer.from(url.split(',')[1], 'base64'));
      console.log(`sheet -> ${out}`);
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
