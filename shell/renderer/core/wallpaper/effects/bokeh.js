// "Bokeh": soft out-of-focus lights drifting upwards with parallax (big near lights move faster and are softer).
// Particles live in typed arrays; each frame is a background blit plus one sprite blit per light.
import { rng, canvas, rgba, hexRgb, rgbToHsl, hsl, radialSprite } from '../engine.js';

export default {
  id: 'bokeh',
  name: { en: 'Bokeh', fr: 'Bokeh' },
  desc: { en: 'Soft lights drift slowly through the dusk', fr: 'Des lumières douces dérivent lentement dans le crépuscule' },
  scale: 0.5,
  heroTime: 20,
  create(env) {
    const dark = env.mode === 'dark';
    const [h0] = rgbToHsl(hexRgb(env.accent || '#0078d4'));
    const k = env.intensity;
    const N = Math.round(40 + 50 * k);
    const X = new Float32Array(N);
    const Y = new Float32Array(N);
    const R = new Float32Array(N);
    const V = new Float32Array(N);
    const PH = new Float32Array(N);
    const C = new Uint8Array(N);
    const D = new Float32Array(N);
    let w = 0;
    let h = 0;
    let bg = null;
    let sprites = [];
    const hues = [h0, h0 + 40, h0 - 35, 38, h0 + 160];
    return {
      resize(W, H) {
        w = W;
        h = H;
        bg = canvas(w, h);
        const g = bg.getContext('2d');
        const gr = g.createLinearGradient(0, 0, w * 0.3, h);
        if (dark) {
          gr.addColorStop(0, rgba(hsl(h0 + 20, 55, 9)));
          gr.addColorStop(0.55, rgba(hsl(h0 + 40, 50, 6)));
          gr.addColorStop(1, rgba(hsl(h0 - 20, 60, 3)));
        } else {
          gr.addColorStop(0, rgba(hsl(h0 + 20, 60, 93)));
          gr.addColorStop(0.55, rgba(hsl(h0 + 45, 55, 89)));
          gr.addColorStop(1, rgba(hsl(h0 - 20, 55, 84)));
        }
        g.fillStyle = gr;
        g.fillRect(0, 0, w, h);
        const glow = (x, y, r, col, a) => {
          const rg = g.createRadialGradient(x, y, 0, x, y, r);
          rg.addColorStop(0, rgba(col, a));
          rg.addColorStop(1, rgba(col, 0));
          g.fillStyle = rg;
          g.fillRect(0, 0, w, h);
        };
        glow(w * 0.25, h * 0.75, h * 0.8, hsl(h0, 70, dark ? 30 : 80), dark ? 0.35 : 0.5);
        glow(w * 0.8, h * 0.2, h * 0.7, hsl(h0 + 50, 70, dark ? 28 : 85), dark ? 0.3 : 0.45);
        // two sprite styles per hue: crisp disc with a bright rim (far) and a very soft disc (near)
        sprites = [];
        for (const hu of hues) {
          const col = hsl(hu, dark ? 90 : 80, dark ? 64 : 70);
          const crisp = canvas(96, 96);
          const cg = crisp.getContext('2d');
          const rg = cg.createRadialGradient(48, 48, 0, 48, 48, 46);
          rg.addColorStop(0, rgba(col, 0.55));
          rg.addColorStop(0.82, rgba(col, 0.7));
          rg.addColorStop(0.93, rgba(col, 0.95));
          rg.addColorStop(1, rgba(col, 0));
          cg.fillStyle = rg;
          cg.fillRect(0, 0, 96, 96);
          sprites.push(crisp, radialSprite(96, col, [[0, 0.8], [0.55, 0.45], [1, 0]]));
        }
        const r = rng(23);
        const m = Math.min(w, h);
        for (let i = 0; i < N; i++) {
          D[i] = r(); // depth: 0 far … 1 near
          R[i] = m * (0.012 + 0.07 * D[i] ** 1.8 + r() * 0.014);
          X[i] = r() * w;
          Y[i] = r() * h;
          V[i] = m * (0.006 + 0.03 * D[i]); // px / s upwards
          PH[i] = r() * Math.PI * 2;
          C[i] = Math.floor(r() * hues.length) * 2 + (D[i] > 0.55 ? 1 : 0);
        }
      },
      frame(g, t) {
        g.globalCompositeOperation = 'source-over';
        g.globalAlpha = 1;
        g.drawImage(bg, 0, 0);
        g.globalCompositeOperation = dark ? 'lighter' : 'source-over';
        for (let i = 0; i < N; i++) {
          // positions are a pure function of t (still frames and previews are deterministic): lights rise and
          // come back from the bottom, shifted sideways on every lap
          const r = R[i];
          const span = h + r * 4;
          const p = Y[i] + r * 2 - V[i] * t;
          const lap = Math.floor(p / span);
          const y = p - lap * span - r * 2;
          const x0 = X[i] - lap * w * 0.37;
          const x = (((x0 % w) + w) % w) + Math.sin(t * 0.21 + PH[i]) * r * 1.6;
          const tw = 0.55 + 0.45 * Math.sin(t * (0.4 + D[i] * 0.5) + PH[i] * 3);
          g.globalAlpha = Math.min(1, (dark ? 0.5 : 0.5) * (0.55 + 0.45 * tw) * (0.7 + 0.6 * k) * (1 - D[i] * 0.25));
          g.drawImage(sprites[C[i]], x - r, y - r, r * 2, r * 2);
        }
        g.globalAlpha = 1;
        g.globalCompositeOperation = 'source-over';
      },
    };
  },
};
