// "Aurora": flowing northern-lights curtains over a mountain lake. Layered effect:
//   background (full res, static) = night sky + stars;  animated canvas (½ res) = curtains + their reflection;
//   foreground (full res, static) = mountain ranges, translucent lake, shoreline.
// Curtains are columns of a pre-rendered gradient sprite whose base line, height and brightness follow slowly
// drifting sums of sines — a few thousand Math.sin and ~500 drawImage calls per frame, no allocations.
import { rng, canvas, rgba, hexRgb } from '../engine.js';

const HORIZON = 0.73;
const CURTAINS = [
  { base: 0.5, amp: 0.13, hgt: 0.34, f: [1.6, 3.7, 7.1], w: [0.05, -0.08, 0.13], low: '#4dffb8', mid: '#19e0a2', top: '#8a5cff', a: 0.42 },
  { base: 0.4, amp: 0.08, hgt: 0.26, f: [2.9, 5.3, 9.4], w: [-0.04, 0.07, -0.11], low: '#8affdc', mid: '#25cfe8', top: '#4a5cff', a: 0.26 },
  { base: 0.6, amp: 0.08, hgt: 0.18, f: [3.1, 6.1, 11.3], w: [0.06, -0.05, 0.09], low: '#c2ff9a', mid: '#2ae39a', top: '#c25cff', a: 0.24 },
];

function noise1(seed, octaves = 5) {
  const r = rng(seed);
  const comps = Array.from({ length: octaves }, (_, i) => ({ f: (i + 1) * (0.7 + r() * 0.9), p: r() * Math.PI * 2, a: 1 / (i + 1) ** 1.4 }));
  const norm = comps.reduce((s, k) => s + k.a, 0);
  return (x) => comps.reduce((s, k) => s + k.a * Math.sin(x * k.f + k.p), 0) / norm;
}

export default {
  id: 'aurora',
  name: { en: 'Aurora', fr: 'Aurore boréale' },
  desc: { en: 'Northern lights flowing over a mountain lake', fr: 'Des aurores boréales ondulent au-dessus d’un lac de montagne' },
  scale: 0.5,
  layered: true,
  heroTime: 40,
  create(env) {
    const light = env.mode === 'light';
    const k = 0.55 + env.intensity * 0.9; // brightness
    let w = 0;
    let h = 0;
    let cols = 0;
    let colW = 0;
    let sprites = [];
    let phase = null; // Float32Array: per curtain × column random phase
    const sky = light
      ? [[0, '#0d1a44'], [0.45, '#1f3b78'], [0.66, '#4a6fa8'], [HORIZON, '#7f9cc8']]
      : [[0, '#010310'], [0.4, '#03102a'], [0.66, '#0a2a4a'], [HORIZON, '#16405e']];

    function curtainSprite(cu) {
      // vertical gradient (bright base fading upwards) with soft left / right edges
      const sw = 16;
      const sh = 256;
      const c = canvas(sw, sh);
      const g = c.getContext('2d');
      const gr = g.createLinearGradient(0, sh, 0, 0);
      gr.addColorStop(0, rgba(hexRgb(cu.low), 0));
      gr.addColorStop(0.06, rgba(hexRgb(cu.low), 1));
      gr.addColorStop(0.3, rgba(hexRgb(cu.mid), 0.62));
      gr.addColorStop(0.72, rgba(hexRgb(cu.top), 0.3));
      gr.addColorStop(1, rgba(hexRgb(cu.top), 0));
      g.fillStyle = gr;
      g.fillRect(0, 0, sw, sh);
      g.globalCompositeOperation = 'destination-in';
      const edge = g.createLinearGradient(0, 0, sw, 0);
      edge.addColorStop(0, 'rgba(0,0,0,0)');
      edge.addColorStop(0.5, 'rgba(0,0,0,1)');
      edge.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = edge;
      g.fillRect(0, 0, sw, sh);
      return c;
    }

    return {
      resize(W, Hh) {
        w = W;
        h = Hh;
        cols = Math.max(24, Math.min(170, Math.round(w / 5)));
        colW = w / cols;
        sprites = CURTAINS.map(curtainSprite);
        const r = rng(7);
        phase = new Float32Array(CURTAINS.length * cols);
        for (let i = 0; i < phase.length; i++) phase[i] = r() * Math.PI * 2;
      },
      background(g, W, H) {
        const gr = g.createLinearGradient(0, 0, 0, H * HORIZON);
        for (const [o, c] of sky) gr.addColorStop(o / HORIZON, c);
        g.fillStyle = gr;
        g.fillRect(0, 0, W, H);
        // lake: darker reflected sky
        const lk = g.createLinearGradient(0, H * HORIZON, 0, H);
        lk.addColorStop(0, light ? '#3d5a88' : '#0b2238');
        lk.addColorStop(1, light ? '#0d1a36' : '#01040a');
        g.fillStyle = lk;
        g.fillRect(0, H * HORIZON, W, H * (1 - HORIZON));
        const r = rng(41);
        const S = W / 2560;
        const n = Math.round((light ? 500 : 1100) * Math.min(1, (W * H) / (2560 * 1600)) + 120);
        for (let i = 0; i < n; i++) {
          const x = r() * W;
          const y = r() ** 1.5 * H * HORIZON;
          const s = Math.max(0.6, (0.3 + r() ** 4 * 1.5) * S * 1.6);
          const a = (0.25 + r() * 0.7) * (light ? 0.6 : 1);
          g.fillStyle = `rgba(255,255,255,${a.toFixed(3)})`;
          g.beginPath();
          g.arc(x, y, s, 0, Math.PI * 2);
          g.fill();
          // reflection of the brightest stars
          if (a > 0.8 && y > H * HORIZON * 0.55) {
            g.fillStyle = `rgba(255,255,255,${(a * 0.25).toFixed(3)})`;
            g.fillRect(x - s * 2, H * HORIZON * 2 - y, s * 4, s * 0.8);
          }
        }
      },
      foreground(g, W, H) {
        const S = W / 2560;
        const hz = H * HORIZON;
        const range = (base, amp, col, seed, det) => {
          const n = noise1(seed, 6);
          const d = noise1(seed + 9, 3);
          g.beginPath();
          g.moveTo(0, hz + 2);
          for (let x = 0; x <= W; x += Math.max(1, 3 * S)) {
            const u = x / W;
            const ridge = 1 - Math.abs(n(u * 3.4));
            g.lineTo(x, H * base - H * amp * ridge ** 2 + H * det * d(u * 50));
          }
          g.lineTo(W, hz + 2);
          g.closePath();
          g.fillStyle = col;
          g.fill();
        };
        range(HORIZON - 0.005, 0.1, light ? '#1d2c4a' : '#0a1a2c', 61, 0.006);
        range(HORIZON + 0.005, 0.05, light ? '#111b30' : '#050d18', 62, 0.004);
        // mirrored range in the lake
        g.save();
        g.translate(0, hz * 2);
        g.scale(1, -1);
        g.globalAlpha = 0.45;
        range(HORIZON - 0.005, 0.1, light ? '#1d2c4a' : '#0a1a2c', 61, 0.006);
        g.restore();
        // the lake surface darkens the reflections drawn by the animated layer below
        const lake = g.createLinearGradient(0, hz, 0, H);
        lake.addColorStop(0, light ? 'rgba(20,34,64,0.18)' : 'rgba(2,8,18,0.22)');
        lake.addColorStop(1, light ? 'rgba(8,14,30,0.8)' : 'rgba(1,4,10,0.86)');
        g.fillStyle = lake;
        g.fillRect(0, hz, W, H - hz);
        const r = rng(43);
        for (let i = 0; i < 160; i++) {
          const y = hz + r() ** 1.6 * (H - hz);
          const x = r() * W;
          const len = (40 + r() * 260) * S * (1 + (y - hz) / (H - hz));
          g.fillStyle = `rgba(150,255,220,${(0.03 + r() * 0.05).toFixed(3)})`;
          g.fillRect(x, y, len, Math.max(1, 1.2 * S));
        }
        // shoreline
        const sh = noise1(71, 4);
        g.fillStyle = light ? '#070b16' : '#01050b';
        g.beginPath();
        g.moveTo(0, H);
        for (let x = 0; x <= W; x += Math.max(1, 4 * S)) {
          const u = x / W;
          g.lineTo(x, H * (0.955 + 0.022 * sh(u * 5)) - (u < 0.25 ? H * 0.06 * (1 - u / 0.25) ** 2 : 0));
        }
        g.lineTo(W, H);
        g.fill();
      },
      frame(g, t) {
        g.clearRect(0, 0, w, h);
        const hz = h * HORIZON;
        g.globalCompositeOperation = 'lighter';
        for (let c = 0; c < CURTAINS.length; c++) {
          const cu = CURTAINS[c];
          const sp = sprites[c];
          const f = cu.f;
          const ws = cu.w;
          const off = c * cols;
          for (let i = 0; i < cols; i++) {
            const u = i / cols;
            const yb = h * (cu.base + cu.amp * (0.6 * Math.sin(u * f[0] * 3 + t * ws[0] * 3 + c) + 0.3 * Math.sin(u * f[1] * 3 + t * ws[1] * 3 + c * 2.1) + 0.1 * Math.sin(u * f[2] * 3 + t * ws[2] * 4)));
            // brightness: slow waves travelling along the curtain + fine shimmering rays
            let inten = 0.55 + 0.45 * Math.sin(u * 7.3 - t * 0.21 + c * 1.7) * Math.sin(u * 3.1 + t * 0.13 + c);
            // rays: smooth bright folds drifting along the curtain, with a little per-column flicker
            const ray = 0.58 + 0.3 * Math.sin(u * 41 + t * 0.55 + c * 2) * Math.sin(u * 13 - t * 0.31 + c) + 0.12 * Math.sin(phase[off + i] + t * 1.3);
            inten *= ray * k * cu.a;
            if (inten <= 0.01) continue;
            const hh = h * cu.hgt * (0.65 + 0.35 * ray) * (0.75 + 0.25 * Math.sin(u * 11 + t * 0.3));
            g.globalAlpha = inten > 1 ? 1 : inten;
            g.drawImage(sp, i * colW - colW * 1.2, yb - hh, colW * 3.4, hh * 1.05);
          }
        }
        // reflection in the lake: the sky band just above the horizon, mirrored and dimmed
        g.globalCompositeOperation = 'source-over';
        g.globalAlpha = 0.5;
        const band = Math.min(hz, h - hz);
        g.setTransform(1, 0, 0, -1, 0, hz * 2);
        g.drawImage(g.canvas, 0, hz - band, w, band, 0, hz - band, w, band);
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.globalAlpha = 1;
      },
    };
  },
};

