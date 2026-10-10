// "Night sky": a starry sky with the Milky Way over a hill line — the stars twinkle and, now and then, a shooting
// star crosses the sky. Layered: the sky (full resolution, static) under a transparent animated canvas that only
// draws the twinkles and meteors (cleared each frame), under the static hills.
import { rng, canvas, radialSprite } from '../engine.js';

const HILLS = 0.86;

export default {
  id: 'starfield',
  name: { en: 'Night sky', fr: 'Ciel étoilé' },
  desc: { en: 'Twinkling stars, the Milky Way and the odd shooting star', fr: 'Étoiles scintillantes, Voie lactée et quelques étoiles filantes' },
  scale: 0.5,
  layered: true,
  heroTime: 7.4,
  create(env) {
    const light = env.mode === 'light';
    const k = env.intensity;
    const NT = Math.round(50 + 70 * k); // twinkling stars
    const TX = new Float32Array(NT);
    const TY = new Float32Array(NT);
    const TS = new Float32Array(NT);
    const TP = new Float32Array(NT);
    const TF = new Float32Array(NT);
    let w = 0;
    let h = 0;
    let glint = null;
    let streak = null;
    // meteors: a deterministic schedule (start time, angle, origin) repeating every `cycle` seconds
    const METEORS = 6;
    const MS = new Float32Array(METEORS);
    const MX = new Float32Array(METEORS);
    const MY = new Float32Array(METEORS);
    const MA = new Float32Array(METEORS);
    const cycle = 60 - 28 * k;
    const r0 = rng(99);
    for (let i = 0; i < METEORS; i++) {
      MS[i] = (i / METEORS) * cycle + r0() * (cycle / METEORS) * 0.6;
      MX[i] = 0.1 + r0() * 0.75;
      MY[i] = 0.05 + r0() * 0.3;
      MA[i] = 0.35 + r0() * 0.5;
    }
    return {
      resize(W, H) {
        w = W;
        h = H;
        glint = canvas(32, 32);
        const g = glint.getContext('2d');
        const dot = radialSprite(32, [235, 244, 255], [[0, 1], [0.12, 0.85], [0.3, 0.25], [1, 0]]);
        g.drawImage(dot, 0, 0);
        g.globalCompositeOperation = 'lighter';
        const ray = (horizontal) => {
          const gr = horizontal ? g.createLinearGradient(0, 16, 32, 16) : g.createLinearGradient(16, 0, 16, 32);
          gr.addColorStop(0, 'rgba(220,235,255,0)');
          gr.addColorStop(0.5, 'rgba(220,235,255,0.75)');
          gr.addColorStop(1, 'rgba(220,235,255,0)');
          g.fillStyle = gr;
          if (horizontal) g.fillRect(0, 15.4, 32, 1.2);
          else g.fillRect(15.4, 0, 1.2, 32);
        };
        ray(true);
        ray(false);
        streak = canvas(256, 6);
        const sg = streak.getContext('2d');
        const sgr = sg.createLinearGradient(0, 0, 256, 0);
        sgr.addColorStop(0, 'rgba(255,255,255,0)');
        sgr.addColorStop(0.85, 'rgba(225,238,255,0.65)');
        sgr.addColorStop(1, 'rgba(255,255,255,1)');
        sg.fillStyle = sgr;
        sg.beginPath();
        sg.moveTo(0, 3);
        sg.lineTo(250, 0.6);
        sg.arc(250, 3, 2.4, -Math.PI / 2, Math.PI / 2);
        sg.lineTo(0, 3);
        sg.fill();
        const r = rng(5);
        const m = Math.min(w, h);
        for (let i = 0; i < NT; i++) {
          TX[i] = r() * w;
          TY[i] = r() ** 1.4 * h * (HILLS - 0.06);
          TS[i] = m * (0.012 + r() ** 3 * 0.03);
          TP[i] = r() * Math.PI * 2;
          TF[i] = 0.6 + r() * 2.2;
        }
      },
      background(g, W, H) {
        const gr = g.createLinearGradient(0, 0, 0, H);
        if (light) {
          gr.addColorStop(0, '#0e1a40');
          gr.addColorStop(0.55, '#24386e');
          gr.addColorStop(0.85, '#4f6aa0');
          gr.addColorStop(1, '#6f86b6');
        } else {
          gr.addColorStop(0, '#02030b');
          gr.addColorStop(0.5, '#050b22');
          gr.addColorStop(0.82, '#0d1d40');
          gr.addColorStop(1, '#16294f');
        }
        g.fillStyle = gr;
        g.fillRect(0, 0, W, H);
        // Milky Way: a soft diagonal band of glow and dense faint stars
        const r = rng(77);
        g.save();
        g.translate(W * 0.5, H * 0.45);
        g.rotate(-0.42);
        const band = g.createLinearGradient(0, -H * 0.22, 0, H * 0.22);
        band.addColorStop(0, 'rgba(160,170,255,0)');
        band.addColorStop(0.5, light ? 'rgba(190,200,255,0.13)' : 'rgba(170,175,255,0.16)');
        band.addColorStop(1, 'rgba(160,170,255,0)');
        g.fillStyle = band;
        g.fillRect(-W, -H * 0.22, W * 2, H * 0.44);
        for (let i = 0; i < 26; i++) {
          const x = (r() - 0.5) * W * 1.6;
          const y = (r() - 0.5) * H * 0.22;
          const rr = H * (0.05 + r() * 0.12);
          const cg = g.createRadialGradient(x, y, 0, x, y, rr);
          const warm = r() > 0.6;
          cg.addColorStop(0, warm ? 'rgba(255,200,170,0.09)' : 'rgba(150,170,255,0.1)');
          cg.addColorStop(1, 'rgba(150,170,255,0)');
          g.fillStyle = cg;
          g.fillRect(x - rr, y - rr, rr * 2, rr * 2);
        }
        const dense = Math.round(2600 * Math.min(1.4, (W * H) / (1920 * 1080)));
        for (let i = 0; i < dense; i++) {
          const x = (r() - 0.5) * W * 1.7;
          const y = (r() + r() + r() - 1.5) * H * 0.12;
          g.fillStyle = `rgba(230,236,255,${(0.08 + r() * 0.4).toFixed(3)})`;
          g.fillRect(x, y, 1, 1);
        }
        g.restore();
        // scattered stars
        const n = Math.round(1300 * Math.min(1.4, (W * H) / (1920 * 1080)));
        for (let i = 0; i < n; i++) {
          const x = r() * W;
          const y = r() * H * HILLS;
          const s = 0.5 + r() ** 5 * 1.6;
          g.fillStyle = `rgba(255,255,255,${(0.2 + r() * 0.75).toFixed(3)})`;
          g.beginPath();
          g.arc(x, y, s, 0, Math.PI * 2);
          g.fill();
        }
        // glow over the horizon (distant town / last light)
        const hg = g.createRadialGradient(W * 0.7, H * HILLS, 0, W * 0.7, H * HILLS, H * 0.5);
        hg.addColorStop(0, light ? 'rgba(255,190,150,0.3)' : 'rgba(255,160,120,0.16)');
        hg.addColorStop(1, 'rgba(255,160,120,0)');
        g.fillStyle = hg;
        g.fillRect(0, 0, W, H);
      },
      foreground(g, W, H) {
        const r = rng(13);
        const layer = (base, amp, col, f, ph) => {
          g.beginPath();
          g.moveTo(0, H);
          for (let x = 0; x <= W; x += 4) {
            const u = x / W;
            const y = H * (base - amp * (0.5 + 0.3 * Math.sin(u * f + ph) + 0.2 * Math.sin(u * f * 2.7 + ph * 1.9)));
            g.lineTo(x, y);
          }
          g.lineTo(W, H);
          g.closePath();
          g.fillStyle = col;
          g.fill();
        };
        layer(HILLS + 0.02, 0.06, light ? '#1a2440' : '#0a1020', 5.1, 1.2);
        layer(HILLS + 0.08, 0.06, light ? '#0e1528' : '#04070f', 3.3, 4.1);
        // a few pine silhouettes on the near hill
        g.fillStyle = light ? '#0e1528' : '#04070f';
        for (let i = 0; i < 28; i++) {
          const x = r() * W;
          const u = x / W;
          const base = H * (HILLS + 0.08 - 0.06 * (0.5 + 0.3 * Math.sin(u * 3.3 + 4.1) + 0.2 * Math.sin(u * 3.3 * 2.7 + 4.1 * 1.9))) + 2;
          const th = H * (0.025 + r() * 0.035);
          g.beginPath();
          g.moveTo(x, base - th);
          g.lineTo(x - th * 0.22, base);
          g.lineTo(x + th * 0.22, base);
          g.closePath();
          g.fill();
        }
      },
      frame(g, t) {
        g.clearRect(0, 0, w, h);
        g.globalCompositeOperation = 'lighter';
        for (let i = 0; i < NT; i++) {
          const tw = 0.5 + 0.5 * Math.sin(t * TF[i] + TP[i]);
          const a = tw * tw * (0.45 + 0.5 * k);
          if (a < 0.03) continue;
          const s = TS[i] * (0.6 + 0.5 * tw);
          g.globalAlpha = a;
          g.drawImage(glint, TX[i] - s / 2, TY[i] - s / 2, s, s);
        }
        // shooting stars
        const tc = t % cycle;
        for (let i = 0; i < METEORS; i++) {
          const dtm = tc - MS[i];
          if (dtm < 0 || dtm > 1.1) continue;
          const p = dtm / 1.1;
          const len = w * 0.16;
          const x = (MX[i] + p * 0.32 * Math.cos(MA[i])) * w;
          const y = MY[i] * h + p * 0.32 * Math.sin(MA[i]) * w;
          g.globalAlpha = Math.sin(p * Math.PI) * (0.65 + 0.35 * k);
          const c = Math.cos(MA[i]);
          const s = Math.sin(MA[i]);
          g.setTransform(c, s, -s, c, x, y);
          g.drawImage(streak, -len, -Math.max(1.5, h * 0.004), len, Math.max(3, h * 0.008));
          g.setTransform(1, 0, 0, 1, 0, 0);
        }
        g.globalAlpha = 1;
        g.globalCompositeOperation = 'source-over';
      },
    };
  },
};

