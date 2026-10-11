// Selene "Éclipse" wallpapers: an abstract total eclipse (dark) and a pale sky
// with a white disc (light). Drawn on a canvas in headless Chromium, saved as JPEG.
// Run: node wallpaper.mjs   (from this folder; needs shell/node_modules/playwright-core)
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, '../../../../shell/package.json'));
const { chromium } = require('playwright-core');

const W = 2560, H = 1440;

function draw(mode, W, H) {
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  // Deterministic random numbers so the file is reproducible.
  let seed = mode === 'dark' ? 7 : 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const cx = W * 0.76, cy = H * 0.27, R = W * 0.085;
  const dark = mode === 'dark';

  // Sky
  if (dark) {
    g.fillStyle = '#09090A'; g.fillRect(0, 0, W, H);
    let rg = g.createRadialGradient(cx, cy, R, cx, cy, W * 0.75);
    rg.addColorStop(0, 'rgba(58,44,28,0.55)'); rg.addColorStop(0.25, 'rgba(30,25,20,0.35)'); rg.addColorStop(1, 'rgba(9,9,10,0)');
    g.fillStyle = rg; g.fillRect(0, 0, W, H);
    const lg = g.createLinearGradient(0, 0, 0, H);
    lg.addColorStop(0, 'rgba(0,0,0,0)'); lg.addColorStop(1, 'rgba(0,0,0,0.35)');
    g.fillStyle = lg; g.fillRect(0, 0, W, H);
  } else {
    const lg = g.createLinearGradient(0, 0, 0, H);
    lg.addColorStop(0, '#CFD8E1'); lg.addColorStop(0.55, '#E6EAEE'); lg.addColorStop(1, '#F2EEE7');
    g.fillStyle = lg; g.fillRect(0, 0, W, H);
    const rg = g.createRadialGradient(cx, cy, R, cx, cy, W * 0.6);
    rg.addColorStop(0, 'rgba(255,255,255,0.75)'); rg.addColorStop(0.3, 'rgba(255,255,255,0.25)'); rg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = rg; g.fillRect(0, 0, W, H);
  }

  // Orbit hairlines around the disc
  g.save();
  g.lineWidth = 1.5;
  for (const [k, a] of [[1.9, 0.10], [2.9, 0.075], [4.4, 0.055], [6.6, 0.04], [9.6, 0.03]]) {
    g.strokeStyle = dark ? `rgba(240,214,170,${a})` : `rgba(70,80,96,${a * 0.9})`;
    g.beginPath(); g.arc(cx, cy, R * k, 0, Math.PI * 2); g.stroke();
  }
  g.restore();

  if (dark) {
    // Corona streamers
    g.save(); g.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 900; i++) {
      const a = rnd() * Math.PI * 2;
      const len = R * (0.15 + Math.pow(rnd(), 2.2) * 1.15);
      const w = 0.6 + rnd() * 1.6;
      const r0 = R * 0.98;
      const x0 = cx + Math.cos(a) * r0, y0 = cy + Math.sin(a) * r0;
      const x1 = cx + Math.cos(a) * (r0 + len), y1 = cy + Math.sin(a) * (r0 + len);
      const lgr = g.createLinearGradient(x0, y0, x1, y1);
      const warm = rnd() < 0.55;
      lgr.addColorStop(0, warm ? 'rgba(255,196,120,0.10)' : 'rgba(255,240,215,0.10)');
      lgr.addColorStop(1, 'rgba(255,200,130,0)');
      g.strokeStyle = lgr; g.lineWidth = w;
      g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
    }
    // Soft halo
    let hg = g.createRadialGradient(cx, cy, R * 0.95, cx, cy, R * 1.9);
    hg.addColorStop(0, 'rgba(255,214,150,0.42)'); hg.addColorStop(0.18, 'rgba(240,166,70,0.16)'); hg.addColorStop(1, 'rgba(240,166,70,0)');
    g.fillStyle = hg; g.beginPath(); g.arc(cx, cy, R * 1.9, 0, Math.PI * 2); g.fill();
    g.restore();
    // Thin corona ring
    g.save();
    g.shadowColor = 'rgba(245,170,70,0.9)'; g.shadowBlur = 28;
    g.strokeStyle = '#FFEFD2'; g.lineWidth = 3.2;
    g.beginPath(); g.arc(cx, cy, R + 1, 0, Math.PI * 2); g.stroke();
    g.shadowBlur = 6; g.lineWidth = 1.4; g.strokeStyle = '#FFF8EA';
    g.beginPath(); g.arc(cx, cy, R + 0.5, 0, Math.PI * 2); g.stroke();
    g.restore();
    // Bead of light on the lower-left rim
    g.save(); g.globalCompositeOperation = 'lighter';
    const ba = Math.PI * 0.80, bx = cx + Math.cos(ba) * R, by = cy + Math.sin(ba) * R;
    const bg = g.createRadialGradient(bx, by, 0, bx, by, R * 0.5);
    bg.addColorStop(0, 'rgba(255,246,228,0.95)'); bg.addColorStop(0.08, 'rgba(255,220,160,0.55)'); bg.addColorStop(0.4, 'rgba(240,160,70,0.10)'); bg.addColorStop(1, 'rgba(240,160,70,0)');
    g.fillStyle = bg; g.beginPath(); g.arc(bx, by, R * 0.5, 0, Math.PI * 2); g.fill();
    g.restore();
    // The dark disc
    const dg = g.createRadialGradient(cx - R * 0.3, cy - R * 0.3, 0, cx, cy, R);
    dg.addColorStop(0, '#0D0D0F'); dg.addColorStop(1, '#050506');
    g.fillStyle = dg; g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.fill();
  } else {
    // White disc with a faint cool rim and a warm inner glow
    g.save();
    g.shadowColor = 'rgba(255,255,255,0.9)'; g.shadowBlur = 90;
    g.fillStyle = '#FFFFFF'; g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.fill();
    g.restore();
    const dg = g.createRadialGradient(cx - R * 0.35, cy - R * 0.35, R * 0.1, cx, cy, R);
    dg.addColorStop(0, '#FFFFFF'); dg.addColorStop(0.85, '#FBF9F5'); dg.addColorStop(1, '#F3EEE5');
    g.fillStyle = dg; g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.fill();
    g.strokeStyle = 'rgba(214,170,110,0.55)'; g.lineWidth = 1.6;
    g.beginPath(); g.arc(cx, cy, R + 0.8, 0, Math.PI * 2); g.stroke();
  }

  // Fine grain
  const img = g.getImageData(0, 0, W, H), d = img.data;
  const amp = dark ? 9 : 7;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rnd() - 0.5) * amp;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
  return cv.toDataURL('image/jpeg', 0.9);
}

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage();
for (const mode of ['dark', 'light']) {
  const url = await page.evaluate(`(${draw})(${JSON.stringify(mode)}, ${W}, ${H})`);
  writeFileSync(join(here, `wallpaper-${mode}.jpg`), Buffer.from(url.split(',')[1], 'base64'));
  console.log('wrote', `wallpaper-${mode}.jpg`);
}
await browser.close();
