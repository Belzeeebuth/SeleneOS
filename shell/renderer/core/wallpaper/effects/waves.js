// "Waves": layered translucent swells in the accent colour rolling under a soft sky, with light on the crests.
// Each layer is one path (48 points) filled with a pre-built gradient; no allocations per frame.
import { canvas, rgba, hexRgb, rgbToHsl, hsl } from '../engine.js';

const LAYERS = 6;
const PTS = 48;

export default {
  id: 'waves',
  name: { en: 'Waves', fr: 'Vagues' },
  desc: { en: 'Layered swells in your accent color roll gently', fr: 'Des houles superposées dans votre couleur d’accentuation roulent doucement' },
  scale: 0.5,
  heroTime: 25,
  create(env) {
    const dark = env.mode === 'dark';
    const [h0, s0] = rgbToHsl(hexRgb(env.accent || '#0078d4'));
    const s = s0 < 12 ? s0 : Math.max(55, Math.min(90, s0));
    const k = env.intensity;
    let w = 0;
    let h = 0;
    let bg = null;
    const fills = [];
    const base = new Float32Array(LAYERS);
    const amp = new Float32Array(LAYERS);
    const freq = new Float32Array(LAYERS);
    const spd = new Float32Array(LAYERS);
    const phase = new Float32Array(LAYERS);
    let crest = '';
    return {
      resize(W, H) {
        w = W;
        h = H;
        bg = canvas(w, h);
        const g = bg.getContext('2d');
        const gr = g.createLinearGradient(0, 0, 0, h);
        if (dark) {
          gr.addColorStop(0, rgba(hsl(h0 + 25, s * 0.5, 6)));
          gr.addColorStop(0.5, rgba(hsl(h0 + 10, s * 0.6, 13)));
          gr.addColorStop(1, rgba(hsl(h0, s * 0.7, 18)));
        } else {
          gr.addColorStop(0, rgba(hsl(h0 + 20, s * 0.6, 96)));
          gr.addColorStop(0.5, rgba(hsl(h0 + 10, s * 0.6, 90)));
          gr.addColorStop(1, rgba(hsl(h0, s * 0.7, 82)));
        }
        g.fillStyle = gr;
        g.fillRect(0, 0, w, h);
        const sun = g.createRadialGradient(w * 0.72, h * 0.3, 0, w * 0.72, h * 0.3, h * 0.6);
        sun.addColorStop(0, dark ? rgba(hsl(h0 + 30, 80, 60), 0.25) : 'rgba(255,255,255,0.7)');
        sun.addColorStop(1, dark ? rgba(hsl(h0 + 30, 80, 60), 0) : 'rgba(255,255,255,0)');
        g.fillStyle = sun;
        g.fillRect(0, 0, w, h);
        fills.length = 0;
        for (let i = 0; i < LAYERS; i++) {
          const d = i / (LAYERS - 1); // 0 back … 1 front
          base[i] = h * (0.38 + d * 0.46);
          amp[i] = h * (0.025 + d * 0.035) * (0.7 + 0.6 * k);
          freq[i] = (Math.PI * 2 * (1.2 + (i % 3) * 0.45)) / w;
          spd[i] = (0.12 + d * 0.22) * (i % 2 ? -1 : 1);
          phase[i] = i * 1.7;
          const top = base[i] - amp[i] * 2;
          const lg = g.createLinearGradient(0, top, 0, h);
          const hu = h0 + (0.5 - d) * 36;
          // atmospheric depth: far swells are paler and more transparent, near ones deep and saturated
          if (dark) {
            lg.addColorStop(0, rgba(hsl(hu, s * (0.6 + 0.4 * d), 46 - d * 16), 0.35 + d * 0.5));
            lg.addColorStop(1, rgba(hsl(hu + 10, s, 12 - d * 6), 0.9 + d * 0.1));
          } else {
            lg.addColorStop(0, rgba(hsl(hu, s * (0.55 + 0.45 * d), 80 - d * 30), 0.35 + d * 0.5));
            lg.addColorStop(1, rgba(hsl(hu + 10, s, 52 - d * 22), 0.9 + d * 0.1));
          }
          fills.push(lg);
        }
        crest = dark ? 'rgba(200,230,255,0.35)' : 'rgba(255,255,255,0.75)';
      },
      frame(g, t) {
        g.globalCompositeOperation = 'source-over';
        g.globalAlpha = 1;
        g.drawImage(bg, 0, 0);
        g.lineWidth = Math.max(1, h * 0.0025);
        g.strokeStyle = crest;
        for (let i = 0; i < LAYERS; i++) {
          const b = base[i];
          const a = amp[i];
          const f = freq[i];
          const ph = phase[i] + t * spd[i];
          g.beginPath();
          for (let j = 0; j <= PTS; j++) {
            const x = (j / PTS) * w;
            const y = b + a * Math.sin(x * f + ph) + a * 0.45 * Math.sin(x * f * 2.3 - ph * 1.4 + i) + a * 0.2 * Math.sin(x * f * 5.1 + ph * 2.1);
            if (j === 0) g.moveTo(x, y);
            else g.lineTo(x, y);
          }
          g.globalAlpha = 0.55 + 0.25 * (i / LAYERS);
          g.stroke();
          g.lineTo(w, h);
          g.lineTo(0, h);
          g.closePath();
          g.globalAlpha = 1;
          g.fillStyle = fills[i];
          g.fill();
        }
      },
    };
  },
};
