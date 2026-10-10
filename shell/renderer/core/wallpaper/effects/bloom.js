// "Bloom": the default Aurora rosette of glass petals, alive — every petal sways around the heart on its own
// rhythm, the flower slowly breathes and turns, and a band of light glides across the glass. Petals are rendered
// once into sprites (the same geometry as tools/gen-wallpapers.mjs) in the accent colour; a frame is a background
// blit, ~19 transformed petal blits, a glow and a shimmer pass on a small flower layer.
import { rng, canvas, rgba, mix, hexRgb, rgbToHsl, hsl, radialSprite } from '../engine.js';

const TAU = Math.PI * 2;
const RINGS = [
  { n: 7, L: 0.385, w: 0.122, off: 0, alpha: [0.7, 0.72], tone: 0.95, sway: 0.05 },
  { n: 7, L: 0.295, w: 0.108, off: Math.PI / 7, alpha: [0.82, 0.85], tone: 0.7, sway: 0.065 },
  { n: 5, L: 0.152, w: 0.072, off: 0.3, alpha: [0.78, 0.8], tone: 0.45, sway: 0.08 },
];

/** Palette from the accent colour (the default blue gives the classic Bloom). */
function palette(mode, accent) {
  const dark = mode === 'dark';
  const [h0, s0] = rgbToHsl(hexRgb(accent || '#0078d4'));
  const h = h0 + 8; // the default accent (#0078d4, 206°) lands on the original petal hue (~214°)
  const s = Math.max(s0 < 12 ? s0 : 55, Math.min(95, s0));
  return dark
    ? { bg: [hsl(h, s * 0.7, 13), hsl(h, s * 0.75, 7.5), hsl(h, s * 0.8, 2.6)], glow: hsl(h, s * 0.75, 45), glow2: hsl(h, s * 0.7, 22), deep: hsl(h + 4, s, 31), mid: hsl(h, s * 0.95, 51), light: hsl(h - 3, Math.min(100, s + 10), 68), spec: hsl(h - 4, 100, 92), core: hsl(h - 4, 100, 75) }
    : { bg: [hsl(h, s * 0.6, 92), hsl(h, s * 0.62, 89), hsl(h, s * 0.6, 82)], glow: hsl(h - 2, 100, 83), glow2: [255, 255, 255], deep: hsl(h + 4, s, 39), mid: hsl(h, s * 0.95, 54), light: hsl(h - 3, 100, 79), spec: [255, 255, 255], core: hsl(h - 3, 100, 91), shadow: hsl(h + 4, s, 30) };
}

export default {
  id: 'bloom',
  name: { en: 'Bloom', fr: 'Floraison' },
  desc: { en: 'The Aurora flower breathes, sways and shimmers in your accent color', fr: 'La fleur d’Aurora respire, ondule et scintille dans votre couleur d’accentuation' },
  scale: 0.5,
  heroTime: 0,
  create(env) {
    const dark = env.mode === 'dark';
    const pal = palette(env.mode, env.accent);
    const k = env.intensity;
    let w = 0;
    let h = 0;
    let cx = 0;
    let cy = 0;
    let bg = null; // background sprite (w × h)
    let petals = []; // { sprite, dx, dy, alpha, sway, phase, ring }
    let glowSprite = null;
    let flower = null; // flower layer (square around the heart)
    let fg = null;
    let half = 0;
    let shimmer = null;
    let heart = null;

    function shadeAt(sv, tone) {
      const body = 0.5 + 0.5 * Math.cos((sv + 0.3) * Math.PI * 0.85);
      let col = body < 0.5 ? mix(pal.deep, pal.mid, body * 2) : mix(pal.mid, pal.light, (body - 0.5) * 2);
      col = mix(col, pal.deep, (1 - tone) * 0.5);
      const spec = Math.exp(-(((sv + 0.55) / 0.13) ** 2)) * 0.55 + Math.max(0, Math.abs(sv) - 0.86) * 2.2;
      return mix(col, pal.spec, Math.max(0, Math.min(1, spec)));
    }

    function petalSprite(p) {
      const STEPS = 40;
      const center = [];
      for (let i = 0; i <= STEPS; i++) {
        const t = i / STEPS;
        const ang = p.a + p.bend * t * t;
        const rad = p.L * t;
        center.push({ x: Math.cos(ang) * rad, y: Math.sin(ang) * rad, nx: -Math.sin(ang + p.bend * t * 0.5), ny: Math.cos(ang + p.bend * t * 0.5), t });
      }
      const widthAt = (t) => p.w * Math.sin(Math.PI * Math.min(1, t * 1.01)) ** 0.62 * (1 - 0.22 * t);
      const edge = (sv) => center.map((c) => ({ x: c.x + c.nx * widthAt(c.t) * sv, y: c.y + c.ny * widthAt(c.t) * sv }));
      const all = [...edge(-1), ...edge(1)];
      const minX = Math.floor(Math.min(...all.map((q) => q.x))) - 2;
      const minY = Math.floor(Math.min(...all.map((q) => q.y))) - 2;
      const maxX = Math.ceil(Math.max(...all.map((q) => q.x))) + 2;
      const maxY = Math.ceil(Math.max(...all.map((q) => q.y))) + 2;
      const c = canvas(maxX - minX, maxY - minY);
      const g = c.getContext('2d');
      g.translate(-minX, -minY);
      const STRIPS = 44;
      for (let i = 0; i < STRIPS; i++) {
        const s0 = -1 + (2 * i) / STRIPS;
        const s1 = Math.min(1, -1 + (2 * (i + 1.6)) / STRIPS);
        const a = edge(s0);
        const b = edge(s1);
        g.beginPath();
        g.moveTo(a[0].x, a[0].y);
        for (const q of a) g.lineTo(q.x, q.y);
        for (let j = b.length - 1; j >= 0; j--) g.lineTo(b[j].x, b[j].y);
        g.closePath();
        g.fillStyle = rgba(shadeAt((s0 + s1) / 2, p.tone));
        g.fill();
      }
      const tip = center[center.length - 1];
      const lg = g.createLinearGradient(0, 0, tip.x, tip.y);
      lg.addColorStop(0, rgba(pal.deep, 0.75));
      lg.addColorStop(0.35, rgba(pal.deep, 0.15));
      lg.addColorStop(0.8, 'rgba(255,255,255,0)');
      lg.addColorStop(1, `rgba(255,255,255,${dark ? 0.12 : 0.3})`);
      g.globalCompositeOperation = 'source-atop';
      g.fillStyle = lg;
      g.fillRect(minX, minY, maxX - minX, maxY - minY);
      return { sprite: c, dx: minX, dy: minY };
    }

    function glow(g, x, y, r, col, a) {
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, rgba(col, a));
      gr.addColorStop(0.45, rgba(col, a * 0.45));
      gr.addColorStop(1, rgba(col, 0));
      g.fillStyle = gr;
      g.fillRect(x - r, y - r, r * 2, r * 2);
    }

    return {
      resize(W, H) {
        w = W;
        h = H;
        cx = w * 0.5;
        cy = h * 0.475;
        // background
        bg = canvas(w, h);
        const bgc = bg.getContext('2d');
        const gr = bgc.createLinearGradient(0, 0, w * 0.35, h * 1.1);
        gr.addColorStop(0, rgba(pal.bg[0]));
        gr.addColorStop(dark ? 0.55 : 0.5, rgba(pal.bg[1]));
        gr.addColorStop(1, rgba(pal.bg[2]));
        bgc.fillStyle = gr;
        bgc.fillRect(0, 0, w, h);
        glow(bgc, cx, cy, h * 0.8, pal.glow, dark ? 0.38 : 0.5);
        glow(bgc, w * 0.3, h * 0.08, h * 0.7, pal.glow2, dark ? 0.3 : 0.5);
        // petals
        const r = rng(17);
        petals = [];
        RINGS.forEach((ring, ri) => {
          const list = [];
          for (let i = 0; i < ring.n; i++) {
            const a = -Math.PI / 2 + ring.off + (i * TAU) / ring.n + (r() - 0.5) * 0.12;
            list.push({ a, L: h * ring.L * (0.92 + r() * 0.16), w: h * ring.w * (0.9 + r() * 0.2), bend: 0.42 + r() * 0.12, tone: ring.tone });
          }
          list.sort((p, q) => Math.sin(p.a) - Math.sin(q.a));
          for (const p of list) petals.push({ ...petalSprite(p), alpha: ring.alpha[dark ? 1 : 0], sway: ring.sway, phase: r() * TAU, speed: 0.35 + r() * 0.3, ring: ri });
        });
        // flower layer + glow / shadow sprite (a blurred silhouette of the flower at rest)
        half = Math.ceil(h * 0.385 * 1.18 + h * 0.07);
        flower = canvas(half * 2, half * 2);
        fg = flower.getContext('2d');
        const rest = canvas(half * 2, half * 2);
        const rg = rest.getContext('2d');
        for (const p of petals) {
          rg.globalAlpha = p.alpha;
          rg.drawImage(p.sprite, half + p.dx, half + p.dy);
        }
        const q = 4; // blur on a ¼-size copy: cheap and smooth
        glowSprite = canvas(Math.ceil((half * 2) / q) + 40, Math.ceil((half * 2) / q) + 40);
        const gg = glowSprite.getContext('2d');
        gg.filter = `blur(${Math.max(2, (h * 0.05) / q)}px)`;
        gg.drawImage(rest, 20, 20, (half * 2) / q, (half * 2) / q);
        gg.filter = 'none';
        if (!dark) {
          gg.globalCompositeOperation = 'source-in';
          gg.fillStyle = rgba(pal.shadow);
          gg.fillRect(0, 0, glowSprite.width, glowSprite.height);
        }
        heart = radialSprite(Math.max(8, Math.round(h * 0.2)), pal.core, [[0, dark ? 0.3 : 0.35], [0.45, dark ? 0.14 : 0.16], [1, 0]]);
        // shimmer band
        shimmer = canvas(64, 8);
        const sg = shimmer.getContext('2d');
        const sgr = sg.createLinearGradient(0, 0, 64, 0);
        sgr.addColorStop(0, 'rgba(255,255,255,0)');
        sgr.addColorStop(0.5, `rgba(255,255,255,${dark ? 0.55 : 0.7})`);
        sgr.addColorStop(1, 'rgba(255,255,255,0)');
        sg.fillStyle = sgr;
        sg.fillRect(0, 0, 64, 8);
      },
      frame(g, t) {
        const breathe = 1 + (0.012 + 0.02 * k) * Math.sin(t * 0.42);
        const rot = 0.05 * Math.sin(t * 0.061) + t * 0.004;
        g.globalCompositeOperation = 'source-over';
        g.globalAlpha = 1;
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.drawImage(bg, 0, 0);
        // glow (dark) / soft shadow (light) under the flower
        const gw = glowSprite.width * 4;
        const cs = Math.cos(rot) * breathe * 1.04;
        const sn = Math.sin(rot) * breathe * 1.04;
        g.setTransform(cs, sn, -sn, cs, cx, cy + (dark ? 0 : h * 0.03));
        if (dark) {
          g.globalCompositeOperation = 'lighter';
          g.globalAlpha = 0.42 + 0.12 * k + 0.1 * Math.sin(t * 0.42);
        } else g.globalAlpha = 0.3;
        g.drawImage(glowSprite, -gw / 2, -gw / 2, gw, gw);
        g.globalCompositeOperation = 'source-over';
        // petals on the flower layer
        fg.setTransform(1, 0, 0, 1, 0, 0);
        fg.globalCompositeOperation = 'source-over';
        fg.clearRect(0, 0, half * 2, half * 2);
        for (let i = 0; i < petals.length; i++) {
          const p = petals[i];
          const a = rot + p.sway * (0.4 + k) * 0.6 * Math.sin(t * p.speed + p.phase);
          const sc = breathe * (1 + 0.015 * p.ring * Math.sin(t * 0.42 + 0.6));
          const c = Math.cos(a) * sc;
          const s = Math.sin(a) * sc;
          fg.setTransform(c, s, -s, c, half, half);
          fg.globalAlpha = p.alpha;
          fg.drawImage(p.sprite, p.dx, p.dy);
        }
        // a band of light gliding across the glass
        const period = 14;
        const ph = (t % period) / period;
        fg.globalCompositeOperation = 'source-atop';
        fg.globalAlpha = 0.25 + 0.45 * k;
        const ang = -0.9;
        const pos = (ph * 2.6 - 1.3) * half * 2;
        fg.setTransform(Math.cos(ang), Math.sin(ang), -Math.sin(ang), Math.cos(ang), half, half);
        fg.drawImage(shimmer, pos - half * 0.35, -half * 1.5, half * 0.7, half * 3);
        fg.setTransform(1, 0, 0, 1, 0, 0);
        fg.globalAlpha = 1;
        fg.globalCompositeOperation = 'source-over';
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.globalAlpha = 1;
        g.drawImage(flower, cx - half, cy - half);
        // the bright heart
        g.globalCompositeOperation = dark ? 'lighter' : 'source-over';
        g.globalAlpha = 0.75 + 0.25 * Math.sin(t * 0.42);
        g.drawImage(heart, cx - heart.width / 2, cy - heart.height / 2);
        g.globalAlpha = 1;
        g.globalCompositeOperation = 'source-over';
      },
      dispose() {
        petals = [];
      },
    };
  },
};
