// Weather overlay of the dynamic wallpaper (transparent, drawn over the time-of-day picture):
//   rain / storm (streaks + gentle lightning), snow (drifting flakes), clouds (slow cloud banks), fog (drifting haze).
// Every particle position is a pure function of t (no state), so still frames and previews are deterministic.
// The colour wash under the particles is CSS (weatherTint) so it costs nothing per frame and also works when
// animations are off ("static tint").
import { rng, canvas, radialSprite } from '../engine.js';

const COUNTS = { rain: { light: 90, moderate: 190, heavy: 360 }, snow: { light: 60, moderate: 130, heavy: 240 } };

/** CSS background of the colour wash for a weather kind ('' = none). */
export function weatherTint(kind, intensity = 'moderate', isDay = true) {
  const heavy = intensity === 'heavy';
  switch (kind) {
    case 'clouds':
      return isDay
        ? `linear-gradient(180deg, rgba(110,122,140,${heavy ? 0.34 : 0.14}) 0%, rgba(140,150,165,${heavy ? 0.2 : 0.06}) 100%)`
        : `linear-gradient(180deg, rgba(20,24,34,${heavy ? 0.38 : 0.16}) 0%, rgba(20,24,34,${heavy ? 0.2 : 0.06}) 100%)`;
    case 'rain':
      return isDay
        ? `linear-gradient(180deg, rgba(48,62,82,${heavy ? 0.46 : 0.34}) 0%, rgba(40,52,70,${heavy ? 0.3 : 0.2}) 100%)`
        : `linear-gradient(180deg, rgba(8,12,22,${heavy ? 0.5 : 0.38}) 0%, rgba(8,12,22,${heavy ? 0.32 : 0.22}) 100%)`;
    case 'storm':
      return `linear-gradient(180deg, rgba(14,18,32,${isDay ? 0.55 : 0.62}) 0%, rgba(20,24,38,${isDay ? 0.36 : 0.42}) 100%)`;
    case 'snow':
      return isDay
        ? 'linear-gradient(180deg, rgba(214,224,240,0.32) 0%, rgba(235,240,250,0.2) 100%)'
        : 'linear-gradient(180deg, rgba(60,72,100,0.3) 0%, rgba(120,135,165,0.16) 100%)';
    case 'fog':
      return isDay
        ? `linear-gradient(180deg, rgba(205,210,218,${heavy ? 0.3 : 0.18}) 0%, rgba(222,226,232,${heavy ? 0.66 : 0.5}) 70%, rgba(228,231,236,${heavy ? 0.72 : 0.58}) 100%)`
        : `linear-gradient(180deg, rgba(60,66,80,${heavy ? 0.3 : 0.2}) 0%, rgba(90,98,112,${heavy ? 0.55 : 0.42}) 75%, rgba(96,104,118,${heavy ? 0.6 : 0.46}) 100%)`;
    default:
      return '';
  }
}

export default {
  id: 'weather',
  name: { en: 'Weather', fr: 'Météo' },
  desc: { en: 'Rain, snow, clouds, fog or storm over the picture', fr: 'Pluie, neige, nuages, brouillard ou orage sur l’image' },
  scale: 0.5,
  transparent: true,
  heroTime: 3.3,
  create(env) {
    const wx = env.weather || { kind: 'clear', intensity: 'moderate', isDay: true };
    const kind = wx.kind || 'clear';
    const inten = ['light', 'moderate', 'heavy'].includes(wx.intensity) ? wx.intensity : 'moderate';
    const day = wx.isDay !== false;
    const rain = kind === 'rain' || kind === 'storm';
    let w = 0;
    let h = 0;
    let n = 0;
    let X = null;
    let Y = null;
    let L = null;
    let V = null;
    let P = null;
    let F = null;
    let sprite = null;
    let clouds = [];
    let cloudCfg = null;
    let rainFar = '';
    let rainNear = '';
    let slant = 0;
    const flashCycle = 8.5;

    function cloudSprite(seed, dark) {
      const cw = 360;
      const ch = 150;
      const c = canvas(cw, ch);
      const g = c.getContext('2d');
      const r = rng(seed);
      const col = dark ? [92, 101, 118] : [255, 255, 255];
      for (let i = 0; i < 14; i++) {
        const u = i / 13 - 0.5;
        const rr = ch * (0.22 + 0.2 * Math.cos(u * Math.PI) * (0.7 + r() * 0.5));
        const x = cw / 2 + u * cw * 0.72 + (r() - 0.5) * 20;
        const y = ch * 0.62 - rr * 0.35 + (r() - 0.5) * 10;
        g.drawImage(radialSprite(Math.ceil(rr * 2), col, [[0, 0.9], [0.55, 0.6], [1, 0]]), x - rr, y - rr);
      }
      return c;
    }
    function fogSprite() {
      const c = canvas(512, 96);
      const g = c.getContext('2d');
      const col = day ? '236,239,244' : '120,128,142';
      const gr = g.createRadialGradient(256, 48, 0, 256, 48, 256);
      gr.addColorStop(0, `rgba(${col},0.75)`);
      gr.addColorStop(0.5, `rgba(${col},0.35)`);
      gr.addColorStop(1, `rgba(${col},0)`);
      g.setTransform(1, 0, 0, 96 / 512, 0, 48 - 48 * (96 / 512));
      g.fillStyle = gr;
      g.fillRect(0, 0, 512, 512);
      return c;
    }

    return {
      resize(W, H) {
        w = W;
        h = H;
        const area = Math.max(0.25, Math.min(2.2, (w * h) / (800 * 450)));
        const r = rng(31);
        if (rain || kind === 'snow') {
          n = Math.round((COUNTS[rain ? 'rain' : 'snow'][kind === 'storm' ? 'heavy' : inten] || 120) * area);
          X = new Float32Array(n);
          Y = new Float32Array(n);
          L = new Float32Array(n);
          V = new Float32Array(n);
          P = new Float32Array(n);
          F = new Uint8Array(n);
          const m = Math.min(w, h);
          for (let i = 0; i < n; i++) {
            const near = r() < 0.35;
            F[i] = near ? 1 : 0;
            X[i] = r() * w * 1.2 - w * 0.1;
            Y[i] = r() * h;
            P[i] = r() * Math.PI * 2;
            if (rain) {
              L[i] = m * (near ? 0.05 + r() * 0.03 : 0.025 + r() * 0.02);
              V[i] = m * (near ? 1.9 + r() * 0.5 : 1.2 + r() * 0.4) * (kind === 'storm' ? 1.25 : 1);
            } else {
              L[i] = Math.max(1, m * (near ? 0.0042 + r() * 0.0035 : 0.0018 + r() * 0.0022)); // flake radius
              V[i] = m * (near ? 0.09 + r() * 0.05 : 0.04 + r() * 0.03);
            }
          }
          slant = kind === 'storm' ? 0.28 : 0.12;
          rainFar = day ? 'rgba(210,222,238,0.32)' : 'rgba(160,178,205,0.25)';
          rainNear = day ? 'rgba(228,236,248,0.5)' : 'rgba(180,196,222,0.38)';
          sprite = kind === 'snow' ? radialSprite(16, day ? [255, 255, 255] : [210, 220, 240], [[0, 1], [0.45, 0.75], [1, 0]]) : null;
        }
        if (kind === 'clouds' || kind === 'storm' || kind === 'fog' || (rain && inten !== 'light')) {
          const fog = kind === 'fog';
          const count = fog ? 4 : kind === 'clouds' && inten === 'light' ? 4 : 7;
          const shapes = fog ? [fogSprite()] : [cloudSprite(3, !day || kind === 'storm' || rain), cloudSprite(8, !day || kind === 'storm' || rain)];
          clouds = [];
          for (let i = 0; i < count; i++) {
            const cw = fog ? w * (1.1 + r() * 0.6) : w * (0.32 + r() * 0.3);
            clouds.push({
              sprite: shapes[i % shapes.length],
              w: cw,
              h: fog ? h * (0.22 + r() * 0.18) : cw * 0.42,
              y: fog ? h * (0.35 + (i / count) * 0.55) : h * (-0.06 + r() * 0.34),
              x0: r() * (w + cw),
              v: (fog ? 0.006 : 0.011 + r() * 0.012) * w * (i % 2 && fog ? -1 : 1),
              a: fog ? 0.55 + r() * 0.25 : kind === 'clouds' ? (inten === 'light' ? 0.5 + r() * 0.2 : 0.65 + r() * 0.25) : 0.42 + r() * 0.2,
            });
          }
          cloudCfg = true;
        }
      },
      frame(g, t) {
        g.clearRect(0, 0, w, h);
        g.globalCompositeOperation = 'source-over';
        // clouds / fog banks
        if (cloudCfg) {
          for (let i = 0; i < clouds.length; i++) {
            const c = clouds[i];
            const span = w + c.w;
            const x = ((((c.x0 + c.v * t) % span) + span) % span) - c.w;
            g.globalAlpha = c.a;
            g.drawImage(c.sprite, x, c.y, c.w, c.h);
          }
          g.globalAlpha = 1;
        }
        if (rain) {
          for (let pass = 0; pass < 2; pass++) {
            g.beginPath();
            for (let i = 0; i < n; i++) {
              if (F[i] !== pass) continue;
              const span = h + L[i];
              const y = ((Y[i] + V[i] * t) % span) - L[i];
              const x = X[i] + y * slant;
              g.moveTo(x, y);
              g.lineTo(x + L[i] * slant, y + L[i]);
            }
            g.lineWidth = pass ? Math.max(1, h * 0.0022) : Math.max(0.8, h * 0.0014);
            g.strokeStyle = pass ? rainNear : rainFar;
            g.stroke();
          }
        } else if (kind === 'snow') {
          for (let i = 0; i < n; i++) {
            const rr = L[i];
            const span = h + rr * 4;
            const y = ((Y[i] + V[i] * t) % span) - rr * 2;
            const x = X[i] + Math.sin(t * (0.5 + F[i] * 0.4) + P[i]) * rr * 6 + y * 0.05;
            g.globalAlpha = F[i] ? 0.95 : 0.7;
            g.drawImage(sprite, x - rr * 2, y - rr * 2, rr * 4, rr * 4);
          }
          g.globalAlpha = 1;
        }
        // lightning: two soft flashes every few seconds (well under the 3-flashes-per-second photosensitivity limit)
        if (kind === 'storm') {
          const tc = t % flashCycle;
          const f = tc < 0.6 ? Math.exp(-tc / 0.07) * 0.26 + (tc > 0.22 ? Math.exp(-(tc - 0.22) / 0.09) * 0.2 : 0) : 0;
          if (f > 0.01) {
            g.globalAlpha = f;
            g.fillStyle = '#dfe8ff';
            g.fillRect(0, 0, w, h);
            g.globalAlpha = 1;
          }
        }
      },
    };
  },
};
