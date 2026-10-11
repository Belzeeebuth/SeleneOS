// Generates the "Clair de lune" assets: app icons, logo and the two wallpapers (night and dawn).
// Usage: node gen-assets.mjs   (writes into ./icons and next to this file)
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PH = '/tmp/claude-0/-home-user-claudeai-test/43a764b0-782a-59d4-b82c-ab1cdd8af354/scratchpad/designkit/phosphor-icons-core-2.1.1/package/assets';
mkdirSync(join(here, 'icons'), { recursive: true });

const f = (n) => +n.toFixed(2);

// Crescent = disc (c1, r1) minus disc (c2, r2).
export function crescent([x1, y1], r1, [x2, y2], r2) {
  const dx = x2 - x1, dy = y2 - y1, d = Math.hypot(dx, dy);
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h = Math.sqrt(r1 * r1 - a * a);
  const xm = x1 + (a * dx) / d, ym = y1 + (a * dy) / d;
  const p1 = [f(xm + (h * dy) / d), f(ym - (h * dx) / d)];
  const p2 = [f(xm - (h * dy) / d), f(ym + (h * dx) / d)];
  return `M${p1} A${r1} ${r1} 0 1 0 ${p2} A${r2} ${r2} 0 0 1 ${p1}Z`;
}

// Four-point star made of quadratic curves.
const sparkle = (cx, cy, s, w = 0.3) =>
  `M${cx} ${cy - s}Q${f(cx + s * w)} ${f(cy - s * w)} ${cx + s} ${cy}Q${f(cx + s * w)} ${f(cy + s * w)} ${cx} ${cy + s}Q${f(cx - s * w)} ${f(cy + s * w)} ${cx - s} ${cy}Q${f(cx - s * w)} ${f(cy - s * w)} ${cx} ${cy - s}Z`;

/* ------------------------------------------------------------------ logo */
const LOGO_PATH = crescent([22, 26], 18, [28.5, 20.5], 15.5);
const STAR_PATH = sparkle(39.5, 9.5, 5.2, 0.24);
export const logo = (id, from, to) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">
  <defs><linearGradient id="${id}" x1="6" y1="10" x2="34" y2="44" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs>
  <path d="${LOGO_PATH}" fill="url(#${id})"/>
  <path d="${STAR_PATH}" fill="url(#${id})"/>
</svg>`;
writeFileSync(join(here, 'icons/selene-logo-dark.svg'), logo('lg', '#FFF6E8', '#C3AEF4'));
writeFileSync(join(here, 'icons/selene-logo-light.svg'), logo('lg', '#7A5BD6', '#3B2A63'));
export const LOGO = { LOGO_PATH, STAR_PATH };

/* ------------------------------------------------------------- app icons */
const ph = (name, weight = 'fill') => {
  const file = weight === 'regular' ? `${name}.svg` : `${name}-${weight}.svg`;
  const svg = readFileSync(join(PH, weight, file), 'utf8');
  return svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
};
const glyph = (name, color, weight = 'fill', size = 34) => {
  const o = (64 - size) / 2;
  return `<svg x="${o}" y="${o}" width="${size}" height="${size}" viewBox="0 0 256 256" fill="${color}">${ph(name, weight)}</svg>`;
};

const CREAM = '#FFF7EC';
const tile = (id, top, bottom, body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>
    <linearGradient id="${id}-bg" x1="0" y1="4" x2="0" y2="60" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient>
    <linearGradient id="${id}-rim" x1="0" y1="4" x2="0" y2="60" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff" stop-opacity=".34"/><stop offset=".45" stop-color="#fff" stop-opacity=".06"/><stop offset="1" stop-color="#000" stop-opacity=".12"/></linearGradient>
  </defs>
  <rect x="4" y="4" width="56" height="56" rx="15" fill="url(#${id}-bg)"/>
  <rect x="4.5" y="4.5" width="55" height="55" rx="14.5" fill="none" stroke="url(#${id}-rim)"/>
  ${body}
</svg>`;

// Gear built from a ring and rounded teeth.
const gear = (fill, hole) => {
  let teeth = '';
  for (let i = 0; i < 8; i++) teeth += `<rect x="28.6" y="13.2" width="6.8" height="9" rx="1.8" transform="rotate(${i * 45} 32 32)" fill="${fill}"/>`;
  return `${teeth}<circle cx="32" cy="32" r="13.2" fill="${fill}"/><circle cx="32" cy="32" r="5.6" fill="${hole}"/>`;
};

const icons = {
  fichiers: ['Fichiers', tile('fi', '#EDB867', '#C27C2C', `
    <path d="M15 22.5a3 3 0 0 1 3-3h8.6a3 3 0 0 1 2.1.9l2.2 2.2h14.1a3 3 0 0 1 3 3V30H15z" fill="#F7D9A6"/>
    <rect x="15" y="26.5" width="34" height="20" rx="3.2" fill="${CREAM}"/>
    <rect x="15" y="26.5" width="34" height="3" rx="1.5" fill="#fff" opacity=".7"/>`)],
  navigateur: ['Navigateur', tile('na', '#5674D8', '#2A3A87', `
    <defs><clipPath id="na-c"><circle cx="32" cy="32" r="16"/></clipPath></defs>
    <circle cx="32" cy="32" r="16" fill="${CREAM}"/>
    <g clip-path="url(#na-c)" fill="none" stroke="#3B54B0" stroke-width="2.2">
      <ellipse cx="32" cy="32" rx="6.6" ry="16"/><path d="M14 32h36M16 24.5h32M16 39.5h32"/>
    </g>`)],
  courrier: ['Courrier', tile('co', '#EC8C70', '#B44C3B', `
    <rect x="14" y="20" width="36" height="25" rx="3.5" fill="${CREAM}"/>
    <path d="M16.5 23l15.5 12 15.5-12" fill="none" stroke="#C25A45" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>`)],
  parametres: ['Paramètres', tile('pa', '#958A82', '#5B524C', gear(CREAM, '#7A6F68'))],
  terminal: ['Terminal', tile('te', '#3E3530', '#1E1815', `
    <path d="M19 23.5l8 7.5-8 7.5" fill="none" stroke="${CREAM}" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M31.5 41h13" stroke="#B9A4F2" stroke-width="3.4" stroke-linecap="round"/>`)],
  logitheque: ['Logithèque', tile('lo', '#A98CF0', '#6746BE', `
    <path d="M25 26v-2.5a7 7 0 0 1 14 0V26" fill="none" stroke="${CREAM}" stroke-width="3" stroke-linecap="round"/>
    <path d="M17.6 25.5h28.8l-2.1 19.4a3.2 3.2 0 0 1-3.2 2.9H22.9a3.2 3.2 0 0 1-3.2-2.9z" fill="${CREAM}"/>
    <path d="${crescent([31, 37.2], 5.2, [33.8, 35.2], 4.4)}" fill="#7A58CF"/>`)],
  photos: ['Photos', tile('ph', '#5DB4AC', '#2C6A72', `
    <defs><clipPath id="ph-c"><rect x="14" y="17" width="36" height="30" rx="5"/></clipPath></defs>
    <rect x="14" y="17" width="36" height="30" rx="5" fill="${CREAM}"/>
    <g clip-path="url(#ph-c)">
      <circle cx="40.5" cy="26" r="4.2" fill="#EDB867"/>
      <path d="M12 41c6-6 10-8.5 15-5.5s8 3.5 12 0.5 9-2.5 13 0V49H12z" fill="#7DBEB5"/>
      <path d="M12 44c7-4.5 13-5.5 19-3s12 2.5 21-1V49H12z" fill="#2F7279"/>
    </g>`)],
  calendrier: ['Calendrier', tile('ca', '#FCF6EE', '#E6D9C7', `
    <path d="M4 19V19a15 15 0 0 1 15-15h26a15 15 0 0 1 15 15v0H4z" fill="#8F6FDC"/>
    <path d="M4 19h56v3H4z" fill="#7A5BCB" opacity=".35"/>
    ${[[0, 0], [1, 0], [2, 0], [3, 0], [0, 1], [1, 1], [3, 1], [0, 2], [1, 2], [2, 2]].map(([c, r]) => `<circle cx="${20 + c * 8}" cy="${31 + r * 8}" r="2.3" fill="#8D7E70"/>`).join('')}
    <circle cx="36" cy="39" r="4.3" fill="#8F6FDC"/>`)],
  lecteur: ['Lecteur', tile('le', '#CF6299', '#8A3062', `
    <path d="M27.5 41.5V22.8l18-4v18.7" fill="none" stroke="${CREAM}" stroke-width="3" stroke-linejoin="round"/>
    <path d="M27.5 22.8l18-4v5l-18 4z" fill="${CREAM}"/>
    <ellipse cx="22.8" cy="42" rx="5.4" ry="4.4" fill="${CREAM}"/>
    <ellipse cx="40.8" cy="38" rx="5.4" ry="4.4" fill="${CREAM}"/>`)],
  calculatrice: ['Calculatrice', tile('cl', '#8DAE74', '#4C6941', `
    <g stroke="${CREAM}" stroke-width="3.2" stroke-linecap="round" fill="none">
      <path d="M24 19.5v9M19.5 24h9"/><path d="M35.5 24h9"/>
      <path d="M20.8 36.8l6.4 6.4M27.2 36.8l-6.4 6.4"/><path d="M35.5 37.5h9M35.5 42.5h9"/>
    </g>`)],
  // Extra pinned apps: same tile, Phosphor glyph.
  editeur: ['Éditeur de texte', tile('ed', '#EBDDC8', '#CDB698', `
    <g stroke="#5A4535" stroke-width="3" stroke-linecap="round"><path d="M19 22h26M19 29h26M19 36h26M19 43h15"/></g>`)],
  notes: ['Notes', tile('no', '#E8B44E', '#B57A22', glyph('note-pencil', CREAM))],
  horloge: ['Horloge', tile('ho', '#56628F', '#2B3157', `
    <circle cx="32" cy="32" r="16" fill="${CREAM}"/>
    <path d="M32 22v10l6.5 4" fill="none" stroke="#3A4472" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`)],
  meteo: ['Météo', tile('me', '#76A2DA', '#3D61A0', glyph('cloud-moon', CREAM))],
  moniteur: ['Moniteur système', tile('mo', '#58977A', '#2D5C45', glyph('pulse', CREAM, 'bold', 30))],
  capture: ["Capture d'écran", tile('cp', '#8577A8', '#4B416E', `
    <g fill="none" stroke="${CREAM}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
      <path d="M17 24.5V20a3 3 0 0 1 3-3h4.5M39.5 17H44a3 3 0 0 1 3 3v4.5M47 39.5V44a3 3 0 0 1-3 3h-4.5M24.5 47H20a3 3 0 0 1-3-3v-4.5"/>
    </g><circle cx="32" cy="32" r="5" fill="${CREAM}"/>`)],
  archives: ['Archives', tile('ar', '#C2A77D', '#836C4B', glyph('archive', CREAM))],
  echecs: ['Échecs', tile('ec', '#A87A5E', '#664533', glyph('horse', CREAM))],
};
for (const [id, [, svg]] of Object.entries(icons)) writeFileSync(join(here, `icons/${id}.svg`), svg);
writeFileSync(join(here, 'icons/names.json'), JSON.stringify(Object.fromEntries(Object.entries(icons).map(([k, [n]]) => [k, n])), null, 2));

/* ------------------------------------------------------------ wallpapers */
function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Smooth curve through points (Catmull-Rom to cubic Bezier), closed down to the bottom edge.
function ridge(pts, bottom = 960) {
  let d = `M${pts[0][0]} ${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${p2[0]} ${p2[1]}`;
  }
  const open = d;
  d += ` L${pts.at(-1)[0]} ${bottom} L${pts[0][0]} ${bottom}Z`;
  return { fill: d, line: open };
}
// Lit part of a moon: k = illuminated fraction, waxing = lit on the right.
function phase(cx, cy, r, k, waxing) {
  if (k >= 0.999) return `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`;
  const rx = f(Math.abs(1 - 2 * k) * r);
  const side = waxing ? 1 : 0; // outer limb sweep
  const top = `${cx} ${cy - r}`, bot = `${cx} ${cy + r}`;
  const termSweep = waxing ? (k < 0.5 ? 0 : 1) : (k < 0.5 ? 1 : 0);
  return `M${top} A${r} ${r} 0 0 ${side} ${bot} A${rx} ${r} 0 0 ${termSweep} ${top}Z`;
}

const HILLS = [
  [[-40, 600], [180, 572], [420, 590], [640, 560], [860, 584], [1080, 556], [1320, 578], [1520, 566], [1660, 580]],
  [[-40, 676], [220, 640], [470, 668], [700, 650], [950, 682], [1180, 642], [1420, 664], [1660, 640]],
  [[-40, 760], [260, 728], [560, 758], [820, 724], [1080, 750], [1340, 716], [1660, 744]],
  [[-40, 850], [300, 818], [640, 842], [980, 810], [1300, 836], [1660, 812]],
];

function wallpaper(mode) {
  const night = mode === 'nuit';
  const rand = rng(night ? 7 : 11);
  const W = 1600, H = 900;
  const sky = night
    ? [['0', '#100B0F'], ['.42', '#1D1317'], ['.62', '#33211F'], ['.72', '#5A3A2D']]
    : [['0', '#ADA8C6'], ['.38', '#D2C3D0'], ['.6', '#ECD3C7'], ['.7', '#F6DAC0']];
  const hills = night
    ? [['#4A302A', '#2E1F1B'], ['#33231E', '#221713'], ['#251914', '#1A110D'], ['#18100C', '#110B08']]
    : [['#E2BFB0', '#D6AE9F'], ['#D3A593', '#C5917F'], ['#BF8B78', '#AD7865'], ['#A56E5B', '#93604E']];
  const rimColor = night ? '#E2B892' : '#FFF4EA';
  const rimOp = night ? [0.45, 0.28, 0.2, 0.14] : [0.7, 0.55, 0.45, 0.35];
  const haze = night ? '#7A4C3A' : '#FBE6D6';

  let defs = `<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">${sky.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join('')}</linearGradient>`;
  defs += `<radialGradient id="glow" cx="800" cy="100" r="460" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${night ? '#F5E2C4' : '#FFFFFF'}" stop-opacity="${night ? 0.16 : 0.45}"/><stop offset=".35" stop-color="${night ? '#E9C9A2' : '#FFF8F0'}" stop-opacity="${night ? 0.06 : 0.18}"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient>`;
  defs += `<radialGradient id="horizon" cx="800" cy="600" r="900" gradientTransform="matrix(1 0 0 .32 0 408)" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${night ? '#B06C48' : '#FFE3C9'}" stop-opacity="${night ? 0.32 : 0.6}"/><stop offset="1" stop-color="${night ? '#B06C48' : '#FFE3C9'}" stop-opacity="0"/></radialGradient>`;
  defs += `<radialGradient id="lit" cx=".38" cy=".34" r=".8"><stop offset="0" stop-color="${night ? '#FBF1DF' : '#FFFFFF'}"/><stop offset=".7" stop-color="${night ? '#EBD8BA' : '#FFFBF6'}"/><stop offset="1" stop-color="${night ? '#CDB592' : '#F3E9EC'}"/></radialGradient>`;
  defs += `<filter id="grain" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency=".85" numOctaves="2" seed="4" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 1  0 0 0 0 .96  0 0 0 0 .9  0 0 0 ${night ? 0.07 : 0.06} 0"/></filter>`;
  defs += `<filter id="soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${night ? 10 : 8}"/></filter>`;
  hills.forEach(([a, b], i) => {
    defs += `<linearGradient id="h${i}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${a}"/><stop offset=".55" stop-color="${b}"/></linearGradient>`;
    defs += `<linearGradient id="r${i}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${rimColor}" stop-opacity="0"/><stop offset=".5" stop-color="${rimColor}" stop-opacity="${rimOp[i]}"/><stop offset="1" stop-color="${rimColor}" stop-opacity="0"/></linearGradient>`;
  });

  let body = `<rect width="${W}" height="${H}" fill="url(#sky)"/><rect width="${W}" height="${H}" fill="url(#horizon)"/>`;
  // stars (night only, a handful at dawn)
  const nStars = night ? 170 : 26;
  for (let i = 0; i < nStars; i++) {
    const x = f(rand() * W), y = f(Math.pow(rand(), 1.4) * 520);
    const r = f(0.45 + Math.pow(rand(), 3) * 1.1), o = f(night ? 0.25 + rand() * 0.6 : 0.35 + rand() * 0.4);
    body += `<circle cx="${x}" cy="${y}" r="${r}" fill="${night ? '#FFF3E2' : '#FFFFFF'}" opacity="${o}"/>`;
  }
  body += `<rect width="${W}" height="${H}" fill="url(#glow)"/>`;

  // moon phases along a shallow arc in the upper sky
  const phases = [0, 0.18, 0.5, 0.8, 1, 0.8, 0.5, 0.18, 0];
  const radii = [13, 16, 19, 22, 30, 22, 19, 16, 13];
  phases.forEach((k, i) => {
    const t = (i - 4) / 4;
    const cx = f(800 + t * 520), cy = f(100 + t * t * 88), r = radii[i];
    const waxing = i < 4;
    // dark disc (earthshine)
    body += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${night ? '#F3E3CC' : '#FFFFFF'}" fill-opacity="${night ? 0.05 : 0.18}" stroke="${night ? '#F3E3CC' : '#FFFFFF'}" stroke-opacity="${night ? 0.18 : 0.55}" stroke-width="1"/>`;
    if (k > 0) {
      const p = phase(cx, cy, r, k, waxing);
      if (k === 1) body += `<circle cx="${cx}" cy="${cy}" r="${r + 5}" fill="${night ? '#F7E6C8' : '#FFFFFF'}" opacity="${night ? 0.32 : 0.6}" filter="url(#soft)"/>`;
      body += `<clipPath id="m${i}"><path d="${p}"/></clipPath>`;
      body += `<path d="${p}" fill="url(#lit)"/>`;
      // maria: soft darker patches laid out like the real near side (no three-blob "face")
      const M = [[-0.36, -0.34, 0.27, 0.22, -20], [0.08, -0.32, 0.14, 0.13, 0], [0.22, -0.06, 0.18, 0.15, 15], [0.6, -0.24, 0.1, 0.08, 0],
        [-0.56, 0.06, 0.18, 0.34, 10], [-0.16, 0.38, 0.13, 0.1, -10], [0.46, 0.14, 0.09, 0.12, 0]];
      body += `<g clip-path="url(#m${i})" fill="${night ? '#B79D7C' : '#D9CCD4'}" opacity="${night ? 0.26 : 0.3}">
        ${M.map(([dx, dy, rx, ry, a]) => `<ellipse cx="${f(cx + r * dx)}" cy="${f(cy + r * dy)}" rx="${f(r * rx)}" ry="${f(r * ry)}" transform="rotate(${a} ${f(cx + r * dx)} ${f(cy + r * dy)})"/>`).join('')}
      </g>`;
    }
  });
  // a faint orbit line joining the phases
  body += `<path d="M${800 - 600} ${f(100 + 1.1538 * 1.1538 * 88)} Q800 ${f(2 * 100 - (100 + 1.1538 * 1.1538 * 88))} ${800 + 600} ${f(100 + 1.1538 * 1.1538 * 88)}" fill="none" stroke="${night ? '#F3E3CC' : '#FFFFFF'}" stroke-opacity="${night ? 0.07 : 0.3}" stroke-width="1" stroke-dasharray="2 6"/>`;

  // hills with mist between layers
  HILLS.forEach((pts, i) => {
    const { fill, line } = ridge(pts);
    const top = Math.min(...pts.map((p) => p[1]));
    body += `<rect x="0" y="${top - 70}" width="${W}" height="110" fill="${haze}" opacity="${night ? 0.1 : 0.22}" filter="url(#soft)"/>`;
    body += `<path d="${fill}" fill="url(#h${i})"/>`;
    body += `<path d="${line}" fill="none" stroke="url(#r${i})" stroke-width="1.2"/>`;
  });
  body += `<rect width="${W}" height="${H}" filter="url(#grain)"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice"><defs>${defs}</defs>${body}</svg>`;
}
writeFileSync(join(here, 'wallpaper-nuit.svg'), wallpaper('nuit'));
writeFileSync(join(here, 'wallpaper-aube.svg'), wallpaper('aube'));
console.log('assets written');
