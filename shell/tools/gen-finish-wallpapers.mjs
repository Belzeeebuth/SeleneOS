#!/usr/bin/env node
// Renders the wallpapers of the Halo and Prisme finishes (docs/design/mockups-mix/, core/finishes.js) into
// renderer/assets/wallpapers/{halo,prisme}-{nocturne,eclipse,clairdelune}-{dark,light}.jpg: 2560x1440,
// progressive JPEG q88 (stepped down only to stay < 700 KB), finely dithered so no gradient bands.
//
//   xvfb-run -a node tools/gen-finish-wallpapers.mjs                       # all twelve
//   xvfb-run -a node tools/gen-finish-wallpapers.mjs --only=halo-eclipse-light,prisme-nocturne-dark --out=/tmp/wp
//
// Halo   a ring of luminous, softly lit petals around a hollow core (procedural SVG, ported from
//        docs/design/mockups-mix/halo/build/gen-wallpapers.mjs), rasterised by Electron/Chromium at 2560x1440 and
//        encoded by the Python half. Nocturne: blue / indigo / cyan on navy; Eclipse: amber / gold corona around a
//        dark disc; Clair de lune: violet / pink / peach on lavender. Each style has a dark and a light variant.
// Prisme aurora veils with a small moon or eclipse (numpy, tools/gen-finish-wallpapers.py, ported from
//        docs/design/mockups-mix/prisme/build/wallpapers.py).
// Deterministic: re-running produces the same pictures. Needs python3 with numpy + Pillow.
import { _electron as electron } from 'playwright-core';
import { execFileSync } from 'node:child_process';
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
const PY = path.join(here, 'gen-finish-wallpapers.py');
const OUT_DIR = path.resolve(arg('out', path.join(here, '..', 'renderer', 'assets', 'wallpapers')));
export const STYLES = ['nocturne', 'eclipse', 'clairdelune'];
export const NAMES = ['halo', 'prisme'].flatMap((f) => STYLES.flatMap((s) => ['dark', 'light'].map((m) => `${f}-${s}-${m}`)));
const only = arg('only', '') ? arg('only', '').split(',') : NAMES;
const W = 2560, H = 1440; // output; the SVG is authored on a 1920x1080 view box
const VW = 1920, VH = 1080;
const f = (n) => Math.round(n * 10) / 10;

// ------------------------------------------------------------------------------------------- Halo (SVG)
// One petal: a curved spine from the inner radius to the tip, with a fat, asymmetric width profile.
function petal(cx, cy, theta, r0, r1, sweep, width, dir) {
  const N = 48, left = [], right = [], spine = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const r = r0 + (r1 - r0) * t;
    const a = theta + dir * sweep * Math.pow(t, 1.35);
    spine.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const [x0, y0] = spine[Math.max(0, i - 1)], [x1, y1] = spine[Math.min(N, i + 1)];
    let nx = -(y1 - y0), ny = x1 - x0;
    const l = Math.hypot(nx, ny) || 1;
    nx /= l; ny /= l;
    const w = width * Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.04)), 0.75) * (1 - 0.35 * t);
    const lead = w * 0.62, trail = w * 0.38 + w * 0.25 * t; // asymmetric: fuller leading edge
    left.push([spine[i][0] + nx * lead * dir, spine[i][1] + ny * lead * dir]);
    right.push([spine[i][0] - nx * trail * dir, spine[i][1] - ny * trail * dir]);
  }
  const pts = left.concat(right.slice().reverse());
  const d = 'M' + pts.map(([x, y]) => `${f(x)},${f(y)}`).join('L') + 'Z';
  const hd = 'M' + left.slice(2, N - 2).map(([x, y]) => `${f(x)},${f(y)}`).join('L'); // leading-edge highlight
  const m = Math.round(N * 0.45);
  return { d, hd, base: spine[0], tip: spine[N], lead: left[m], trail: right[m] };
}

function ring(o, id) {
  const { cx, cy, n, r0, r1, sweep, width, dir, phase, stops, opacity, hlOpacity, blend, shadow = '#000', shadowA = 0.45, relief = 0.5 } = o;
  let defs = '', body = '';
  for (let i = 0; i < n; i++) {
    const th = phase + (i / n) * Math.PI * 2;
    const jitter = 1 + 0.07 * Math.sin(i * 2.3 + phase * 5);
    const p = petal(cx, cy, th, r0, r1 * jitter, sweep, width * jitter, dir);
    const g = `${id}g${i}`, x = `${id}x${i}`;
    defs += `<linearGradient id="${g}" gradientUnits="userSpaceOnUse" x1="${f(p.base[0])}" y1="${f(p.base[1])}" x2="${f(p.tip[0])}" y2="${f(p.tip[1])}">` +
      stops.map(([o2, c, a = 1]) => `<stop offset="${o2}" stop-color="${c}" stop-opacity="${a}"/>`).join('') + '</linearGradient>';
    defs += `<linearGradient id="${x}" gradientUnits="userSpaceOnUse" x1="${f(p.lead[0])}" y1="${f(p.lead[1])}" x2="${f(p.trail[0])}" y2="${f(p.trail[1])}">` +
      `<stop offset="0" stop-color="#fff" stop-opacity="${relief * 0.75}"/><stop offset="0.3" stop-color="#fff" stop-opacity="0"/><stop offset="0.7" stop-color="${shadow}" stop-opacity="0"/><stop offset="1" stop-color="${shadow}" stop-opacity="${relief * 0.6}"/></linearGradient>`;
    if (shadowA > 0) body += `<path d="${p.d}" fill="${shadow}" opacity="${shadowA}" filter="url(#drop)" transform="translate(${dir * 6},10)"/>`;
    body += `<g opacity="${opacity}"><path d="${p.d}" fill="url(#${g})"/><path d="${p.d}" fill="url(#${x})"/></g>`;
    body += `<path d="${p.hd}" fill="none" stroke="#fff" stroke-width="${f(width * 0.07)}" stroke-linecap="round" opacity="${hlOpacity}" filter="url(#soft)"/>`;
  }
  return { defs, body: `<g style="mix-blend-mode:${blend}">${body}</g>` };
}

// Petal rings of a style (shared by its two variants; `tone` adjusts shadows / highlights per mode).
const RINGS = {
  nocturne: (tone) => [
    { n: 7, r0: 200, r1: 640, sweep: 1.15, width: 330, dir: 1, phase: 0.2, opacity: 0.94, hlOpacity: tone.hl * 0.18, shadow: tone.shadow[0], shadowA: tone.shadowA,
      stops: tone.light ? [[0, '#2B33B8'], [0.4, '#4A5BF0'], [0.85, '#8197FF'], [1, '#C5D0FF']] : [[0, '#1C1A80'], [0.4, '#3340D6'], [0.85, '#6C84FF'], [1, '#A9B8FF']] },
    { n: 7, r0: 160, r1: 500, sweep: 1.05, width: 270, dir: 1, phase: 0.65, opacity: 0.95, hlOpacity: tone.hl * 0.22, shadow: tone.shadow[1], shadowA: tone.shadowA,
      stops: tone.light ? [[0, '#1648C8'], [0.45, '#2B7BFF'], [0.85, '#63B0FF'], [1, '#D2EAFF']] : [[0, '#0A2C8F'], [0.45, '#1F66F2'], [0.85, '#4FA2FF'], [1, '#BFE0FF']] },
    { n: 6, r0: 120, r1: 340, sweep: 0.95, width: 180, dir: 1, phase: 0.1, opacity: 0.95, hlOpacity: tone.hl * 0.32, shadow: tone.shadow[2], shadowA: tone.shadowA * 0.9,
      stops: tone.light ? [[0, '#0C79B0'], [0.45, '#18B6E6'], [0.9, '#7CE6FF'], [1, '#EAFBFF']] : [[0, '#0B5C8A'], [0.45, '#14A8DA'], [0.9, '#6EE0FF'], [1, '#E2FAFF']] },
  ],
  eclipse: (tone) => [
    { n: 9, r0: 200, r1: 720, sweep: 1.25, width: 170, dir: -1, phase: 0.15, opacity: 0.9, hlOpacity: 0.16, shadow: tone.shadow[0], shadowA: tone.shadowA, relief: 0.35,
      stops: tone.light ? [[0, '#B4400F', 0.75], [0.3, '#E2560F'], [0.7, '#F97316', 0.85], [1, '#FDBA74', 0]] : [[0, '#7C2D12', 0.6], [0.3, '#C2410C'], [0.7, '#F97316', 0.8], [1, '#FDBA74', 0]] },
    { n: 9, r0: 195, r1: 560, sweep: 1.05, width: 140, dir: -1, phase: 0.5, opacity: 0.9, hlOpacity: 0.22, shadow: tone.shadow[1], shadowA: tone.shadowA, relief: 0.35,
      stops: tone.light ? [[0, '#C2650A', 0.75], [0.35, '#EE9A0E'], [0.75, '#FBBF24', 0.9], [1, '#FFE7A3', 0]] : [[0, '#92400E', 0.6], [0.35, '#E28A0B'], [0.75, '#FBBF24', 0.85], [1, '#FFF0C2', 0]] },
    { n: 8, r0: 190, r1: 400, sweep: 0.8, width: 100, dir: -1, phase: 0.05, opacity: 0.9, hlOpacity: 0.3, shadow: tone.shadow[2], shadowA: tone.shadowA, relief: 0.3,
      stops: tone.light ? [[0, '#D07A06', 0.8], [0.45, '#F6B41A'], [0.85, '#FFD95A', 0.9], [1, '#FFF3C4', 0]] : [[0, '#B45309', 0.7], [0.45, '#F5B71A'], [0.85, '#FFE58A', 0.8], [1, '#FFFBEA', 0]] },
  ],
  clairdelune: (tone) => [
    { n: 7, r0: 200, r1: 640, sweep: 1.1, width: 320, dir: -1, phase: 0.6, opacity: 0.9, hlOpacity: tone.hl * 0.4, shadow: tone.shadow[0], shadowA: tone.shadowA, relief: 0.45,
      stops: tone.light ? [[0, '#8F63E8'], [0.4, '#9D74F2'], [0.85, '#C6A8FB'], [1, '#EFE5FF']] : [[0, '#6A3FD0'], [0.4, '#8A5EF0'], [0.85, '#B795FF'], [1, '#E6D8FF']] },
    { n: 7, r0: 165, r1: 500, sweep: 1.0, width: 260, dir: -1, phase: 1.05, opacity: 0.93, hlOpacity: tone.hl * 0.45, shadow: tone.shadow[1], shadowA: tone.shadowA, relief: 0.45,
      stops: tone.light ? [[0, '#D5468F'], [0.45, '#E866AE'], [0.85, '#F7A3CE'], [1, '#FFE6F2']] : [[0, '#C0347E'], [0.45, '#E2579F'], [0.85, '#F58FC2'], [1, '#FFD9EC']] },
    { n: 6, r0: 125, r1: 345, sweep: 0.92, width: 175, dir: -1, phase: 0.3, opacity: 0.95, hlOpacity: tone.hl * 0.55, shadow: tone.shadow[2], shadowA: tone.shadowA * 0.9, relief: 0.4,
      stops: tone.light ? [[0, '#F57D52'], [0.45, '#FF9C70'], [0.9, '#FFC9A6'], [1, '#FFF4EA']] : [[0, '#E8693E'], [0.45, '#FF8C5E'], [0.9, '#FFBC94'], [1, '#FFEADB']] },
  ],
};

// Twelve-ish parameters per picture: background, centre, glow, core, ambient orbs, petal tone.
const HALO = {
  'nocturne-dark': {
    bg: '<radialGradient id="bg" cx="0.62" cy="0.46" r="0.85"><stop offset="0" stop-color="#132A78"/><stop offset="0.45" stop-color="#0A1646"/><stop offset="1" stop-color="#040820"/></radialGradient>',
    cx: 1180, cy: 510, blend: 'normal', bloom: 0.55,
    glow: [['#2E5BFF', 0.6, 520], ['#22D3EE', 0.35, 240]],
    tone: { light: false, hl: 1, shadow: ['#030A2A', '#03103A', '#04204A'], shadowA: 0.55 },
    core: '<circle cx="1180" cy="510" r="120" fill="url(#core)"/>',
    coreGrad: '<radialGradient id="core"><stop offset="0" stop-color="#F0FCFF" stop-opacity="0.95"/><stop offset="0.35" stop-color="#9BE7FF" stop-opacity="0.5"/><stop offset="1" stop-color="#2563EB" stop-opacity="0"/></radialGradient>',
    orbs: [['#5B8CFF', 220, 180, 120, 0.18], ['#22D3EE', 1700, 960, 160, 0.14], ['#7C6BFF', 380, 880, 200, 0.12]],
    grain: 0.05,
  },
  'nocturne-light': {
    bg: '<radialGradient id="bg" cx="0.62" cy="0.46" r="0.9"><stop offset="0" stop-color="#F4F8FF"/><stop offset="0.5" stop-color="#DCE6FF"/><stop offset="1" stop-color="#BFD0FA"/></radialGradient>',
    cx: 1180, cy: 510, blend: 'normal', bloom: 0.4,
    glow: [['#7FA2FF', 0.45, 520], ['#8EEBFF', 0.4, 240]],
    tone: { light: true, hl: 1.6, shadow: ['#2A3590', '#1B3C8F', '#155A7A'], shadowA: 0.2 },
    core: '<circle cx="1180" cy="510" r="130" fill="url(#core)"/>',
    coreGrad: '<radialGradient id="core"><stop offset="0" stop-color="#FFFFFF" stop-opacity="1"/><stop offset="0.4" stop-color="#E4F8FF" stop-opacity="0.75"/><stop offset="1" stop-color="#9CC8FF" stop-opacity="0"/></radialGradient>',
    orbs: [['#9DB6FF', 220, 180, 160, 0.45], ['#9BE9FF', 1700, 960, 180, 0.4], ['#B8A8FF', 380, 880, 200, 0.35]],
    grain: 0.035,
  },
  'eclipse-dark': {
    bg: '<radialGradient id="bg" cx="0.55" cy="0.47" r="0.8"><stop offset="0" stop-color="#2B1507"/><stop offset="0.42" stop-color="#110803"/><stop offset="1" stop-color="#030201"/></radialGradient>',
    cx: 1060, cy: 490, blend: 'screen', bloom: 0.9,
    glow: [['#F97316', 0.55, 520], ['#FBBF24', 0.45, 290]],
    tone: { light: false, hl: 1, shadow: ['#000', '#000', '#000'], shadowA: 0 },
    core: '<circle cx="1060" cy="490" r="200" fill="url(#ring)"/><circle cx="1060" cy="490" r="184" fill="#060403"/><circle cx="1060" cy="490" r="184" fill="url(#disc)"/>',
    coreGrad: '<radialGradient id="ring"><stop offset="0.86" stop-color="#FFF6DA" stop-opacity="0"/><stop offset="0.93" stop-color="#FFF3C9" stop-opacity="1"/><stop offset="1" stop-color="#FDBA74" stop-opacity="0"/></radialGradient>' +
      '<radialGradient id="disc" cx="0.42" cy="0.38"><stop offset="0" stop-color="#2A1A0C"/><stop offset="1" stop-color="#060403"/></radialGradient>',
    orbs: [['#F59E0B', 260, 860, 180, 0.12], ['#FB923C', 1680, 200, 150, 0.12], ['#FDE68A', 1560, 900, 90, 0.10]],
    grain: 0.05,
  },
  'eclipse-light': {
    // Daylight: cream and apricot sky, saturated amber / gold petals around a pale sun disc with a thin gold ring.
    bg: '<radialGradient id="bg" cx="0.55" cy="0.47" r="0.85"><stop offset="0" stop-color="#FFF5E4"/><stop offset="0.5" stop-color="#FCE6C6"/><stop offset="1" stop-color="#F3CDA6"/></radialGradient>',
    cx: 1060, cy: 490, blend: 'normal', bloom: 0.45,
    glow: [['#FFB054', 0.55, 520], ['#FFE07A', 0.5, 290]],
    tone: { light: true, hl: 1, shadow: ['#7C2D12', '#8A4A0A', '#8A5A0A'], shadowA: 0.16 },
    core: '<circle cx="1060" cy="490" r="206" fill="url(#ring)"/><circle cx="1060" cy="490" r="184" fill="url(#disc)"/>',
    coreGrad: '<radialGradient id="ring"><stop offset="0.84" stop-color="#F59E0B" stop-opacity="0"/><stop offset="0.9" stop-color="#F29A12" stop-opacity="0.95"/><stop offset="1" stop-color="#FFC46B" stop-opacity="0"/></radialGradient>' +
      '<radialGradient id="disc" cx="0.42" cy="0.38"><stop offset="0" stop-color="#FFFFFF"/><stop offset="0.7" stop-color="#FFF6E2"/><stop offset="1" stop-color="#FFE7BD"/></radialGradient>',
    orbs: [['#FFC36B', 260, 860, 200, 0.4], ['#FFA77A', 1680, 200, 170, 0.35], ['#FFE08A', 1560, 900, 120, 0.4]],
    grain: 0.035,
  },
  'clairdelune-light': {
    bg: '<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#F3EDFB"/><stop offset="0.55" stop-color="#E9DEF6"/><stop offset="1" stop-color="#F8E4EC"/></linearGradient>',
    cx: 1120, cy: 480, blend: 'normal', bloom: 0.55,
    glow: [['#B48CFF', 0.5, 560], ['#FFB394', 0.45, 300]],
    tone: { light: true, hl: 1, shadow: ['#5B2A86', '#7A1F55', '#8A3A1A'], shadowA: 0.22 },
    core: '<circle cx="1120" cy="480" r="130" fill="url(#core)"/>',
    coreGrad: '<radialGradient id="core"><stop offset="0" stop-color="#FFFDF8" stop-opacity="1"/><stop offset="0.45" stop-color="#FFF1E4" stop-opacity="0.8"/><stop offset="1" stop-color="#FFE0EC" stop-opacity="0"/></radialGradient>',
    orbs: [['#C7B2FF', 240, 200, 200, 0.4], ['#FFC6B0', 1720, 960, 220, 0.45], ['#F7B6D9', 300, 900, 160, 0.35]],
    grain: 0.04,
  },
  'clairdelune-dark': {
    // The same flower at night: deep violet to plum, the petals glowing from within, a warm peach core.
    bg: '<radialGradient id="bg" cx="0.58" cy="0.45" r="0.9"><stop offset="0" stop-color="#3A1F5E"/><stop offset="0.5" stop-color="#22123D"/><stop offset="1" stop-color="#140A24"/></radialGradient>',
    cx: 1120, cy: 480, blend: 'normal', bloom: 0.7,
    glow: [['#9B6BFF', 0.5, 560], ['#FF9A7A', 0.4, 300]],
    tone: { light: false, hl: 0.8, shadow: ['#0C0520', '#1A0618', '#200A08'], shadowA: 0.3 },
    core: '<circle cx="1120" cy="480" r="130" fill="url(#core)"/>',
    coreGrad: '<radialGradient id="core"><stop offset="0" stop-color="#FFF3E6" stop-opacity="0.9"/><stop offset="0.35" stop-color="#FFC2A6" stop-opacity="0.4"/><stop offset="1" stop-color="#FFC2A6" stop-opacity="0"/></radialGradient>',
    orbs: [['#7A55E0', 240, 200, 200, 0.22], ['#E0608E', 1720, 960, 220, 0.18], ['#B05ACF', 300, 900, 160, 0.16]],
    grain: 0.05,
  },
};

export function haloSvg(name) {
  const st = name.split('-')[0];
  const s = HALO[name];
  let defs = s.bg + s.coreGrad, body = `<rect width="${VW}" height="${VH}" fill="url(#bg)"/>`;
  s.orbs.forEach(([c, x, y, r, a], i) => {
    defs += `<radialGradient id="orb${i}"><stop offset="0" stop-color="${c}" stop-opacity="${a}"/><stop offset="1" stop-color="${c}" stop-opacity="0"/></radialGradient>`;
    body += `<circle cx="${x}" cy="${y}" r="${r * 2.2}" fill="url(#orb${i})"/>`;
  });
  s.glow.forEach(([c, a, r], i) => {
    defs += `<radialGradient id="glow${i}"><stop offset="0" stop-color="${c}" stop-opacity="${a}"/><stop offset="0.55" stop-color="${c}" stop-opacity="${a * 0.35}"/><stop offset="1" stop-color="${c}" stop-opacity="0"/></radialGradient>`;
    body += `<circle cx="${s.cx}" cy="${s.cy}" r="${r * 1.6}" fill="url(#glow${i})"/>`;
  });
  let petals = '';
  RINGS[st](s.tone).forEach((r, i) => {
    const R = ring({ ...r, cx: s.cx, cy: s.cy, blend: s.blend }, `r${i}`);
    defs += R.defs;
    petals += R.body;
  });
  // blurred copy underneath for luminosity, sharp copy on top
  body += `<g filter="url(#bloom)" opacity="${s.bloom}">${petals}</g>${petals}${s.core}`;
  defs += '<filter id="soft" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="7"/></filter>' +
    '<filter id="drop" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="16"/></filter>' +
    '<filter id="bloom" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="38"/></filter>' +
    `<filter id="grain" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="1.2" numOctaves="2" seed="4"/><feColorMatrix values="0 0 0 0 0.5  0 0 0 0 0.5  0 0 0 0 0.5  0 0 0 ${s.grain} 0"/></filter>`;
  body += `<rect width="${VW}" height="${VH}" filter="url(#grain)"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${VW} ${VH}"><defs>${defs}</defs>${body}</svg>`;
}

// Runs inside Chromium: rasterise an SVG at its own size and return a lossless PNG data URL.
async function rasterise({ svg, W, H }) {
  const img = new Image();
  img.src = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  await img.decode();
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  c.getContext('2d').drawImage(img, 0, 0, W, H);
  return c.toDataURL('image/png');
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'selene-finish-wp-'));
  try {
    const halo = only.filter((n) => n.startsWith('halo-'));
    if (halo.length) {
      const mainJs = path.join(tmp, 'main.js');
      fs.writeFileSync(mainJs, `const { app, BrowserWindow } = require('electron');
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.whenReady().then(() => {
  const w = new BrowserWindow({ show: false, width: 320, height: 200, webPreferences: { backgroundThrottling: false } });
  w.loadURL('data:text/html,<!doctype html><title>wallpapers</title>');
});`);
      const app = await electron.launch({ executablePath: require('electron'), args: ['--no-sandbox', mainJs], timeout: 60000 });
      try {
        const page = await app.firstWindow();
        for (const n of halo) {
          const url = await page.evaluate(rasterise, { svg: haloSvg(n.slice(5)), W, H });
          const png = path.join(tmp, `${n}.png`);
          fs.writeFileSync(png, Buffer.from(url.split(',')[1], 'base64'));
          execFileSync('python3', ['-I', PY, 'encode', png, path.join(OUT_DIR, `${n}.jpg`)], { stdio: 'inherit' });
        }
      } finally {
        await app.close();
      }
    }
    const prisme = only.filter((n) => n.startsWith('prisme-')).map((n) => n.slice(7));
    if (prisme.length) execFileSync('python3', ['-I', PY, 'prisme', OUT_DIR, ...prisme], { stdio: 'inherit' });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
