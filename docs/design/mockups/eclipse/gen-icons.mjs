// Selene "Éclipse" — app icons and logo, drawn as plain SVG.
// Common style: 96-unit rounded square, two-stop vertical gradient, a faint
// lunar disc in the top-right corner, one flat white glyph (6-unit strokes).
// Run: node gen-icons.mjs  (writes icons/*.svg and logo.svg next to this file)
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
mkdirSync(join(here, 'icons'), { recursive: true });

const W = '#FFFFFF';
const S = (d, w = 6) => `<path d="${d}" fill="none" stroke="${W}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;
const F = (d, o = 1) => `<path d="${d}" fill="${W}"${o < 1 ? ` fill-opacity="${o}"` : ''}/>`;
const f2 = (n) => +n.toFixed(2);

function gear(cx, cy, n, ro, ri, hole) {
  const tw = 0.2, bw = 0.33;
  const p = (r, a) => `${f2(cx + r * Math.cos(a))} ${f2(cy + r * Math.sin(a))}`;
  let d = '';
  for (let i = 0; i < n; i++) {
    const a = (i * 2 * Math.PI) / n - Math.PI / 2;
    d += `${i ? 'L' : 'M'}${p(ri, a - bw)} L${p(ro, a - tw)} L${p(ro, a + tw)} L${p(ri, a + bw)} `;
    const next = ((i + 1) * 2 * Math.PI) / n - Math.PI / 2;
    d += `A${ri} ${ri} 0 0 1 ${p(ri, next - bw)} `;
  }
  d += `Z M${cx + hole} ${cy} A${hole} ${hole} 0 1 0 ${cx - hole} ${cy} A${hole} ${hole} 0 1 0 ${cx + hole} ${cy} Z`;
  return `<path d="${d}" fill="${W}" fill-rule="evenodd" stroke="${W}" stroke-width="2.5" stroke-linejoin="round"/>`;
}

const apps = {
  fichiers: ['Fichiers', '#F0A646', '#C8741A',
    F('M24 34a6 6 0 0 1 6-6h11.5a6 6 0 0 1 4.2 1.8L49 33h17a6 6 0 0 1 6 6v3H24z', 0.62) +
    F('M24 42h48v20a6 6 0 0 1-6 6H30a6 6 0 0 1-6-6z')],
  navigateur: ['Navigateur', '#5B8BEA', '#2D52B8',
    S('M48 24a24 24 0 1 0 0.01 0', 5.5) +
    F('M59 37L52.6 52.6L43.4 43.4z') + F('M37 59L43.4 43.4L52.6 52.6z', 0.55) +
    `<circle cx="48" cy="48" r="3" fill="#3A62C8"/>`],
  courrier: ['Courrier', '#3BAEE0', '#1C76AA',
    S('M30 30h36a6 6 0 0 1 6 6v24a6 6 0 0 1-6 6H30a6 6 0 0 1-6-6V36a6 6 0 0 1 6-6z', 5.5) + S('M27 35l21 15l21-15', 5.5)],
  calendrier: ['Calendrier', '#EE6157', '#BC3530',
    F('M28 32h40a5 5 0 0 1 5 5v28a5 5 0 0 1-5 5H28a5 5 0 0 1-5-5V37a5 5 0 0 1 5-5z') +
    S('M37 26v10M59 26v10', 5.5) +
    ['37,48', '48,48', '59,48', '37,59', '48,59'].map((c) => { const [x, y] = c.split(','); return `<rect x="${x - 4}" y="${y - 4}" width="8" height="8" rx="2" fill="#C9413B"/>`; }).join('')],
  photos: ['Photos', '#F28585', '#C84A62',
    F('M22 68L40 44l11 14 7-8 16 18z') + `<circle cx="61" cy="34" r="7" fill="${W}"/>`],
  lecteur: ['Lecteur', '#E862A6', '#A9346F',
    `<path d="M40 31.5L66 48L40 64.5z" fill="${W}" stroke="${W}" stroke-width="7" stroke-linejoin="round"/>`],
  terminal: ['Terminal', '#4A4A52', '#1C1C21',
    S('M29 36l13 12l-13 12', 6) + S('M50 62h17', 6).replace(W, '#F2A63A')],
  parametres: ['Paramètres', '#767A86', '#43454E', gear(48, 48, 8, 25, 19.5, 8)],
  logitheque: ['Logithèque', '#9677F5', '#5A3BCF',
    S('M39 40v-5a9 9 0 0 1 18 0v5', 5.5) + F('M27 40h42l-3 25a6 6 0 0 1-6 5H36a6 6 0 0 1-6-5z')],
  calculatrice: ['Calculatrice', '#45BC84', '#20845A',
    S('M36 30v14M29 37h14M53 37h14M30 54l12 12M42 54l-12 12M53 56h14M53 64h14', 5)],
  editeur: ['Éditeur de texte', '#6A8AAF', '#3D5878',
    S('M28 33h40M28 43h40M28 53h40M28 63h24', 5.5)],
  notes: ['Notes', '#EDC04A', '#C29315',
    F('M30 24h26l14 14v28a6 6 0 0 1-6 6H30a6 6 0 0 1-6-6V30a6 6 0 0 1 6-6z') +
    `<path d="M56 24v10a4 4 0 0 0 4 4h10" fill="#D6A529"/>` + S('M33 50h22M33 60h14', 5).replaceAll(W, '#C29315')],
  moniteur: ['Moniteur système', '#36B4AC', '#197C77',
    S('M22 50h12l6-15l11 28l6-13h17', 5.5)],
  capture: ['Capture d\'écran', '#6670EA', '#3A42BC',
    S('M26 38v-6a6 6 0 0 1 6-6h6M58 26h6a6 6 0 0 1 6 6v6M70 58v6a6 6 0 0 1-6 6h-6M38 70h-6a6 6 0 0 1-6-6v-6', 5.5) +
    `<circle cx="48" cy="48" r="8" fill="${W}"/>`],
  horloge: ['Horloge', '#4A5A9C', '#252E62',
    S('M48 24a24 24 0 1 0 0.01 0', 5.5) + S('M48 35v13l9 7', 5.5)],
  meteo: ['Météo', '#62BEF0', '#2C86C6',
    F('M36 66a13 13 0 0 1-1.5-25.9A16 16 0 0 1 65 43a11.5 11.5 0 0 1-1 23z')],
  taches: ['Tâches', '#86C24A', '#4E8A1E',
    S('M28 49l13 13l27-27', 7)],
  dessin: ['Dessin', '#E07848', '#AE461F',
    F('M48 24c-13.3 0-24 10.2-24 23.3C24 60 34.5 72 46 72c4.4 0 5.5-3.3 3.6-6.2c-1.7-2.6-.5-6.3 3.4-6.3H60c7 0 12-5 12-12C72 34 61.3 24 48 24z') +
    ['36,46', '42,35', '55,34'].map((c) => { const [x, y] = c.split(','); return `<circle cx="${x}" cy="${y}" r="4.2" fill="#C2552A"/>`; }).join('')],
};

function tile(id, [label, c1, c2, glyph]) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="96" height="96">
  <title>${label}</title>
  <defs>
    <linearGradient id="g" x1="0" y1="4" x2="0" y2="92" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient>
    <linearGradient id="h" x1="0" y1="4" x2="0" y2="92" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff" stop-opacity=".28"/><stop offset=".5" stop-color="#fff" stop-opacity=".04"/><stop offset="1" stop-color="#000" stop-opacity=".12"/></linearGradient>
    <clipPath id="c"><rect x="4" y="4" width="88" height="88" rx="24"/></clipPath>
  </defs>
  <rect x="4" y="4" width="88" height="88" rx="24" fill="url(#g)"/>
  <circle cx="80" cy="16" r="34" fill="#fff" fill-opacity=".09" clip-path="url(#c)"/>
  <rect x="4.75" y="4.75" width="86.5" height="86.5" rx="23.25" fill="none" stroke="url(#h)" stroke-width="1.5"/>
  ${glyph}
</svg>
`;
}

for (const [id, def] of Object.entries(apps)) writeFileSync(join(here, 'icons', `${id}.svg`), tile(id, def));

// Logo: crescent cut from two circles, plus a slender four-point star in the hollow.
const C1 = { x: 24, y: 24, r: 18 }, C2 = { x: 31.5, y: 16.5, r: 14.5 };
const dx = C2.x - C1.x, dy = C2.y - C1.y, d = Math.hypot(dx, dy);
const a = (C1.r ** 2 - C2.r ** 2 + d ** 2) / (2 * d), hh = Math.sqrt(C1.r ** 2 - a ** 2);
const mx = C1.x + (a * dx) / d, my = C1.y + (a * dy) / d;
const P1 = [f2(mx + (hh * dy) / d), f2(my - (hh * dx) / d)], P2 = [f2(mx - (hh * dy) / d), f2(my + (hh * dx) / d)];
const crescent = `M${P1} A${C1.r} ${C1.r} 0 1 0 ${P2} A${C2.r} ${C2.r} 0 0 1 ${P1} Z`.replaceAll(',', ' ');
const sx = 35.5, sy = 13.5, L = 6.2, wst = 1.25;
const star = `M${sx} ${sy - L}Q${sx + wst} ${sy - wst} ${sx + L} ${sy}Q${sx + wst} ${sy + wst} ${sx} ${sy + L}Q${sx - wst} ${sy + wst} ${sx - L} ${sy}Q${sx - wst} ${sy - wst} ${sx} ${sy - L}Z`;
const logo = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">
  <title>Selene</title>
  <defs>
    <linearGradient id="m" x1="8" y1="8" x2="36" y2="42" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#FBF7EE"/><stop offset=".55" stop-color="#DCDDE2"/><stop offset="1" stop-color="#A3A9B6"/></linearGradient>
  </defs>
  <path d="${crescent}" fill="url(#m)"/>
  <path d="${star}" fill="#F2C27A"/>
</svg>
`;
writeFileSync(join(here, 'logo.svg'), logo);
// Light-background variant: deep graphite crescent, darker amber star.
writeFileSync(join(here, 'logo-light.svg'), logo
  .replace('#FBF7EE', '#4A4B52').replace('#DCDDE2', '#2B2C31').replace('#A3A9B6', '#141416').replace('#F2C27A', '#B8680C'));
console.log('icons:', Object.keys(apps).length, 'crescent', crescent);
