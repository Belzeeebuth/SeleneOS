// "Fluid gradient": a mesh gradient in the accent colour — large soft colour fields drift on slow Lissajous paths
// and melt into each other. Rendered at ¼ resolution (it is all soft gradients) from pre-coloured radial sprites.
import { rgba, hexRgb, rgbToHsl, hsl, radialSprite } from '../engine.js';

export default {
  id: 'fluid',
  name: { en: 'Fluid gradient', fr: 'Dégradé fluide' },
  desc: { en: 'Soft color fields in your accent color drift and blend', fr: 'Des champs de couleur dans votre teinte d’accentuation dérivent et se mélangent' },
  scale: 0.25,
  heroTime: 30,
  create(env) {
    const dark = env.mode === 'dark';
    const [h0, s0] = rgbToHsl(hexRgb(env.accent || '#0078d4'));
    const s = s0 < 12 ? s0 : Math.max(55, Math.min(95, s0));
    const k = env.intensity;
    // base + six fields: the accent, its neighbours on the colour wheel, a highlight and a deep tone
    const base = dark ? hsl(h0, s * 0.55, 7) : hsl(h0, s * 0.5, 95);
    const fields = dark
      ? [[h0, s, 46, 0.95], [h0 + 42, s, 40, 0.9], [h0 - 46, s * 0.95, 38, 0.9], [h0 + 14, s * 0.85, 66, 0.7], [h0 - 20, s, 16, 0.95], [h0 + 80, s * 0.85, 34, 0.75]]
      : [[h0, s, 64, 0.85], [h0 + 42, s, 74, 0.85], [h0 - 46, s * 0.95, 72, 0.85], [h0, 30, 99, 0.95], [h0 - 16, s, 52, 0.6], [h0 + 80, s * 0.85, 80, 0.75]];
    let w = 0;
    let h = 0;
    let sprites = [];
    const baseCss = rgba(base);
    // per field: centre (u, v), radius, Lissajous frequencies and phases
    const P = [
      [0.22, 0.3, 0.75, 0.11, 0.07, 0.0, 1.3],
      [0.78, 0.25, 0.7, 0.08, 0.12, 2.1, 0.4],
      [0.3, 0.8, 0.8, 0.09, 0.06, 4.0, 2.6],
      [0.62, 0.55, 0.45, 0.13, 0.1, 1.0, 5.1],
      [0.85, 0.85, 0.65, 0.07, 0.09, 3.3, 0.9],
      [0.5, 0.1, 0.55, 0.1, 0.08, 5.5, 3.7],
    ];
    return {
      resize(W, H) {
        w = W;
        h = H;
        sprites = fields.map(([hh, ss, ll, a]) => radialSprite(128, hsl(hh, ss, ll), [[0, a], [0.35, a * 0.8], [0.7, a * 0.3], [1, 0]]));
      },
      frame(g, t) {
        g.globalCompositeOperation = 'source-over';
        g.globalAlpha = 1;
        g.fillStyle = baseCss;
        g.fillRect(0, 0, w, h);
        const amp = 0.12 + 0.16 * k;
        const m = Math.max(w, h);
        for (let i = 0; i < P.length; i++) {
          const p = P[i];
          const x = (p[0] + amp * Math.sin(t * p[3] + p[5]) + amp * 0.5 * Math.sin(t * p[4] * 1.7 + p[6])) * w;
          const y = (p[1] + amp * Math.cos(t * p[4] + p[6]) + amp * 0.4 * Math.sin(t * p[3] * 1.3 + p[5])) * h;
          const r = p[2] * m * 0.72 * (0.9 + 0.14 * Math.sin(t * 0.05 + i));
          g.globalAlpha = 0.8 + 0.2 * k;
          g.drawImage(sprites[i], x - r, y - r, r * 2, r * 2);
        }
        g.globalAlpha = 1;
      },
    };
  },
};

