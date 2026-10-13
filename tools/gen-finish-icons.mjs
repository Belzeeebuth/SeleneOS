#!/usr/bin/env node
// Halo and Prisme icon packs: the colourful app, desktop and file-type icons of the two "finishes"
// (docs/design/mockups-mix/{halo,prisme}). One static SVG per app, special icon and Fichiers icon.
//
//   node tools/gen-finish-icons.mjs [--phosphor <dir>] [--sheet <out.png>] [--check]
//
// --check:    writes nothing; exits 1 when a file on disk differs from what the generator draws (test/icons.test.mjs).
// --phosphor: the Phosphor 2.1.1 "assets" folder (fill/, bold/…); default $PHOSPHOR_DIR. Only needed for the few
//             symbols that are not packed in shell/renderer/assets/icons/phosphor.json (Prisme's flower and open bag):
//             they are cached in tools/gen-finish-icons.glyphs.json, so the icons regenerate without the design kit.
// --sheet:    also renders a review sheet (every icon at 64, 48, 32, 24 and 16 px, on dark and light) to <out.png>
//             (needs the shell's Electron/Playwright: run it from a machine that can launch the shell tests).
//
// Output: shell/renderer/assets/icons/packs/halo/*.svg and packs/prisme/*.svg, named after
//   - the app id (apps/<id>/manifest.json):        browser.svg, files.svg…
//   - the shell specials:                          this-pc.svg (Ordinateur), recycle-bin.svg (Corbeille),
//                                                  app-default.svg (Linux apps without an icon)
//   - the Fichiers icons (core/file-icon-art.js FILE_ICONS keys): folder.svg, file-pdf.svg, drive-usb.svg…
// core/packs.js serves them as the "halo" and "prisme" icon packs; core/file-icons.js maps the Fichiers pictures
// and the desktop / Lanceur file-type glyphs to them.
//
// Halo (Mica-like finish): free shapes, one vivid gradient per app, a soft top light and a light top edge; a tile
// only where the mockup used one (Calculatrice, Terminal, Moniteur système, Photos, 2048). Prisme (frosted finish):
// a glossy squircle with a two-tone gradient by app family (documents and time: gold to rose; creation and media:
// pink to violet; web and messages: indigo to cyan; system and tools: teal, green, slate, ink) and a white Phosphor
// symbol. Both read at 16, 24, 32 and 48 px: a size media query inside each SVG drops the fine details (lines,
// sheens) and enlarges the Prisme symbol at 26 px and below.
// Symbols: Phosphor Icons 2.1.1 (MIT, shell/renderer/assets/icons/LICENSE-phosphor.txt).
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_GLYPHS } from '../shell/renderer/core/app-glyphs.js';
import { FILE_ICONS } from '../shell/renderer/core/file-icon-art.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHELL = join(ROOT, 'shell/renderer');
const OUT = join(SHELL, 'assets/icons/packs');
const CACHE = join(ROOT, 'tools/gen-finish-icons.glyphs.json');
const args = process.argv.slice(2);
const argVal = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
const KIT = argVal('--phosphor') || process.env.PHOSPHOR_DIR || null;

// ------------------------------------------------------------------ glyphs
const PACKED = JSON.parse(readFileSync(join(SHELL, 'assets/icons/phosphor.json'), 'utf8')).glyphs;
// symbols the shell does not pack, but the Selene app icons hold (fill weight)
const FROM_APPS = { compass: 'browser', 'number-square-two': 'game2048', spade: 'solitaire', 'clock-counter-clockwise': 'backup' };
const cache = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {};
let cacheDirty = false;
const W = { r: 'regular', f: 'fill', b: 'bold' };
/** The inner paths of a Phosphor glyph (256 grid), weight 'f' | 'r' | 'b'. */
function G(name, w = 'f') {
  if (PACKED[name]?.[w]) return PACKED[name][w];
  if (w === 'f' && FROM_APPS[name]) return APP_GLYPHS[FROM_APPS[name]].inner;
  const key = `${name}:${w}`;
  if (KIT) {
    const file = join(KIT, W[w], `${name}${w === 'r' ? '' : `-${W[w]}`}.svg`);
    if (existsSync(file)) {
      const inner = readFileSync(file, 'utf8').replace(/^[\s\S]*?<svg[^>]*>/, '').replace('</svg>', '').trim();
      if (cache[key] !== inner) (cache[key] = inner), (cacheDirty = true);
      return inner;
    }
  }
  if (cache[key]) return cache[key];
  throw new Error(`glyph ${key} not found (pass --phosphor <assets dir>)`);
}
const LOGO = APP_GLYPHS.winver.inner; // the Selene crescent and dot-star, 48 grid

// ------------------------------------------------------------------ SVG helpers
const stops = (s) => s.map(([o, c, a]) => `<stop offset="${o}" stop-color="${c}"${a == null ? '' : ` stop-opacity="${a}"`}/>`).join('');
const lg = (id, s, x1 = 0, y1 = 0, x2 = 0, y2 = 1) => `<linearGradient id="${id}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">${stops(s)}</linearGradient>`;
const rg = (id, s, cx = 0.5, cy = 0.5, r = 0.5) => `<radialGradient id="${id}" cx="${cx}" cy="${cy}" r="${r}">${stops(s)}</radialGradient>`;
/** A Phosphor glyph in a size x size box at (x, y). */
const gl = (inner, x, y, size, fill, cls = '') => `<g${cls ? ` class="${cls}"` : ''} transform="translate(${x} ${y}) scale(${+(size / 256).toFixed(5)})" fill="${fill}">${inner}</g>`;
const r2 = (v) => +v.toFixed(2);

// ================================================================== HALO
const SHEEN_DEF = lg('sheen', [[0, '#fff', 0.55], [0.35, '#fff', 0.08], [1, '#fff', 0]]);
const GLOSS_DEF = lg('gloss', [[0, '#fff', 0.32], [1, '#fff', 0]]);
const TILE = (g) => `<rect x="6" y="6" width="52" height="52" rx="14" fill="url(#${g})"/>`;
const SHEEN = '<rect class="d" x="6.6" y="6.6" width="50.8" height="50.8" rx="13.4" fill="none" stroke="url(#sheen)" stroke-width="1.2"/>';
const PAGE = 'M15 6h24.5L52 18.5V53a5 5 0 0 1-5 5H15a5 5 0 0 1-5-5V11a5 5 0 0 1 5-5Z';
const FOLD = 'M39.5 6v8.5a4 4 0 0 0 4 4H52Z';
const haloSvg = (defs, body, small = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
<!-- Halo icon (tools/gen-finish-icons.mjs). Symbols: Phosphor Icons 2.1.1, MIT. -->
<style>@media (max-width:26px){.d{display:none}${small}}</style>
<defs>${defs}</defs>
${body}
</svg>
`;
/** A Phosphor fill glyph used as a free shape: its own gradient, a soft top light and a light top edge. */
function shape(inner, x, y, size, grad) {
  const k = 256 / size;
  return `<g transform="translate(${x} ${y}) scale(${+(size / 256).toFixed(5)})"><g fill="url(#${grad})">${inner}</g><g fill="url(#gloss)">${inner}</g><g class="d" fill="none" stroke="url(#sheen)" stroke-width="${r2(1.1 * k)}">${inner}</g></g>`;
}
function gear(cx, cy, ro, ri, n, tw = 0.42) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a0 = (2 * Math.PI * i) / n;
    const step = (2 * Math.PI) / n;
    for (const [fr, r] of [[0, ri], [0.5 - tw / 2 - 0.06, ri], [0.5 - tw / 2, ro], [0.5 + tw / 2, ro], [0.5 + tw / 2 + 0.06, ri]]) {
      const a = a0 + step * fr;
      pts.push(`${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`);
    }
  }
  return `M${pts.join('L')}Z`;
}
// a white page with a folded corner (Éditeur, documents)
const page = (p = 'p', c = 'c') => `<path d="${PAGE}" fill="url(#${p})" stroke="#7E88A3" stroke-opacity=".32" stroke-width=".8"/><path d="${FOLD}" fill="url(#${c})"/>`;
const PAGE_DEFS = lg('p', [[0, '#FFFFFF'], [1, '#E9ECF5']]) + lg('c', [[0, '#D6DAE6'], [1, '#B9C0D3']]);
// a document page with a coloured badge holding a white symbol (file types)
function docBadge(c1, c2, glyph, w = 'f', lines = true) {
  return haloSvg(
    PAGE_DEFS + lg('r', [[0, c1], [1, c2]], 0, 0, 1, 1) + GLOSS_DEF,
    page() +
      (lines ? `<g class="d" fill="#C9D0E2"><rect x="16" y="16" width="18" height="2.8" rx="1.4"/><rect x="16" y="22" width="26" height="2.8" rx="1.4"/></g>` : '') +
      `<rect x="10" y="30" width="34" height="24" rx="6" fill="url(#r)"/><rect class="d" x="10" y="30" width="34" height="11" rx="6" fill="url(#gloss)"/>` +
      gl(G(glyph, w), 17, 32, 20, '#fff', 's'),
    '.s{transform:translate(13px,28px) scale(.109)}',
  );
}
// the yellow folder of the mockup; a symbol on its front for the special folders
function haloFolder(glyph) {
  return haloSvg(
    lg('b', [[0, '#F7B53B'], [1, '#E0860F']]) + lg('f', [[0, '#FFE27A'], [1, '#FFB42A']]) + lg('p', [[0, '#FFFFFF'], [1, '#E6EEFF']]),
    '<path d="M6 17a6 6 0 0 1 6-6h13.5a4 4 0 0 1 2.8 1.2L32 16h20a6 6 0 0 1 6 6v26a6 6 0 0 1-6 6H12a6 6 0 0 1-6-6Z" fill="url(#b)"/>' +
      '<rect x="12" y="19" width="40" height="22" rx="2.5" fill="url(#p)"/><rect x="12" y="19" width="40" height="22" rx="2.5" fill="#9DB4E8" opacity=".15"/>' +
      '<path d="M6 30a6 6 0 0 1 6-6h40a6 6 0 0 1 6 6v18a6 6 0 0 1-6 6H12a6 6 0 0 1-6-6Z" fill="url(#f)"/>' +
      '<path class="d" d="M11 25.6h42" stroke="#fff" stroke-opacity=".75" stroke-width="1.3" stroke-linecap="round"/>' +
      (glyph ? gl(G(glyph, 'f'), 23, 30, 18, '#B4650A', 's') : ''),
    glyph ? '.s{transform:translate(20px,27px) scale(.09375)}' : '',
  );
}
// a silver device slab (drives)
function haloDrive(extra, led = '#2FD39A') {
  return haloSvg(
    lg('b', [[0, '#EEF2F8'], [1, '#A9B5CA']]) + lg('f', [[0, '#5A6680'], [1, '#2C3448']]) + GLOSS_DEF,
    '<rect x="6" y="16" width="52" height="34" rx="8" fill="url(#b)"/>' +
      '<rect x="6" y="16" width="52" height="15" rx="8" fill="url(#gloss)"/>' +
      '<rect x="11" y="36" width="42" height="9" rx="3.5" fill="url(#f)"/>' +
      `<circle cx="48" cy="40.5" r="2.2" fill="${led}"/>` +
      '<g class="d" stroke="#8E9AB2" stroke-width="1.6" stroke-linecap="round"><path d="M14 23h14M14 27h9"/></g>' +
      (extra || ''),
  );
}

const HALO = {};
HALO.files = haloFolder(null);
HALO.browser = haloSvg(
  rg('s', [[0, '#C8FAFF'], [0.35, '#36C6EE'], [0.75, '#2A6BE6'], [1, '#2340B8']], 0.36, 0.3, 0.75) + lg('o', [[0, '#FFFFFF'], [1, '#FFD27A']], 0, 0, 1, 0) + GLOSS_DEF,
  '<g transform="rotate(-20 32 33)"><path d="M3 33.5A29 9.5 0 0 1 61 33.5" fill="none" stroke="url(#o)" stroke-width="3" opacity=".55"/></g>' +
    '<circle cx="32" cy="33" r="20" fill="url(#s)"/>' +
    '<path class="d" d="M18 26c6-3 9 2 14-1s6-7 11-5" fill="none" stroke="#fff" stroke-opacity=".28" stroke-width="2.4" stroke-linecap="round"/>' +
    '<path class="d" d="M16 40c5 1 7-3 12-1s5 6 11 5" fill="none" stroke="#fff" stroke-opacity=".2" stroke-width="2.4" stroke-linecap="round"/>' +
    '<g transform="rotate(-20 32 33)"><path d="M3 33.5A29 9.5 0 0 0 61 33.5" fill="none" stroke="url(#o)" stroke-width="3.2" stroke-linecap="round"/></g>' +
    '<ellipse cx="26" cy="22" rx="10" ry="5.5" fill="url(#gloss)" transform="rotate(-25 26 22)"/>' +
    '<circle cx="53" cy="12" r="3.6" fill="#FFE7A3"/><circle cx="52" cy="11" r="1.3" fill="#fff" opacity=".8"/>',
);
HALO.mail = haloSvg(
  lg('bk', [[0, '#3A5BE0'], [1, '#2A3FB8']]) + lg('fr', [[0, '#73C0FF'], [1, '#4562F5']]) + lg('l', [[0, '#FFFFFF'], [1, '#E3EAFF']]),
  '<rect x="6" y="18" width="52" height="36" rx="7" fill="url(#bk)"/>' +
    '<rect x="13" y="9" width="38" height="30" rx="3.5" fill="url(#l)"/>' +
    '<g class="d"><rect x="18" y="15" width="18" height="3" rx="1.5" fill="#4C6EF5"/><rect x="18" y="21" width="28" height="2.6" rx="1.3" fill="#B7C5EE"/><rect x="18" y="26" width="22" height="2.6" rx="1.3" fill="#B7C5EE"/></g>' +
    '<path d="M6 27.5 32 41l26-13.5V47a7 7 0 0 1-7 7H13a7 7 0 0 1-7-7Z" fill="url(#fr)"/>' +
    '<path class="d" d="M8.5 49.5 25 37.6M55.5 49.5 39 37.6" stroke="#fff" stroke-opacity=".3" stroke-width="1.4" stroke-linecap="round"/>' +
    '<path d="M7 28.4 32 41.3l25-12.9" fill="none" stroke="#fff" stroke-opacity=".6" stroke-width="1.2" stroke-linecap="round"/>',
);
HALO.settings = haloSvg(
  lg('g', [[0, '#D7DEEA'], [0.5, '#9AA8C0'], [1, '#5E6C88']], 0, 0, 0.3, 1) + rg('h', [[0, '#B9D3FF'], [0.6, '#6C7BFF'], [1, '#4B3FD9']], 0.4, 0.35, 0.7),
  `<path d="${gear(32, 32, 26, 20.5, 9)}" fill="url(#g)" stroke="#5E6C88" stroke-width="1.2" stroke-linejoin="round"/>` +
    '<circle cx="32" cy="32" r="13.5" fill="#EEF2F8"/><circle cx="32" cy="32" r="13.5" fill="none" stroke="#7D8AA3" stroke-opacity=".5"/>' +
    '<circle cx="32" cy="32" r="9" fill="url(#h)"/><circle cx="29.5" cy="29" r="3" fill="#fff" opacity=".55"/>',
);
HALO.calculator = haloSvg(
  lg('t', [[0, '#FFB65C'], [1, '#F2620F']]) + SHEEN_DEF,
  TILE('t') +
    SHEEN +
    '<rect x="13" y="12.5" width="38" height="13" rx="3.5" fill="#3A1A06" opacity=".82"/><rect x="33" y="17" width="13" height="4" rx="2" fill="#FFE2C2"/>' +
    [31, 43].flatMap((y) => [13, 27, 41].map((x) => (x === 41 && y === 43 ? `<rect x="${x}" y="${y}" width="10" height="8" rx="2.6" fill="#3A1A06" opacity=".85"/>` : `<rect x="${x}" y="${y}" width="10" height="8" rx="2.6" fill="#FFFFFF" opacity=".95"/>`))).join(''),
);
HALO.paint = haloSvg(
  lg('w', [[0, '#FFF7EA'], [1, '#F4C88E']]) + GLOSS_DEF,
  '<path d="M32 7c15.5 0 26 10.5 26 23 0 9-6.5 12.5-12.5 10.8-4.6-1.3-7.8 1.5-6.6 6.2 1.4 5.5-2.4 10-8.4 10C16.5 57 6 46.5 6 32S17 7 32 7Z" fill="url(#w)"/>' +
    '<path class="d" d="M32 7c15.5 0 26 10.5 26 23" fill="none" stroke="#fff" stroke-opacity=".8" stroke-width="1.4"/>' +
    [[19, 24, '#FF4D6D'], [31, 16.5, '#FFC23D'], [44, 20, '#2FD39A'], [17, 38, '#4D8BFF'], [27, 47, '#A45CFF']]
      .map(([x, y, c]) => `<circle cx="${x}" cy="${y}" r="5.2" fill="${c}"/><circle class="d" cx="${x - 1.6}" cy="${y - 1.8}" r="1.6" fill="#fff" opacity=".6"/>`)
      .join('') +
    '<circle cx="47.5" cy="33" r="3.2" fill="#E2A868" opacity=".7"/>',
);
HALO.notepad = haloSvg(
  lg('p', [[0, '#FFFFFF'], [1, '#E4E9FB']]) + lg('c', [[0, '#C9D2F7'], [1, '#9AA8EE']]) + lg('pen', [[0, '#7C8CFF'], [1, '#4F46E5']]),
  page() +
    '<rect x="16" y="24" width="20" height="3.6" rx="1.8" fill="#5B5CF0"/>' +
    [[32, 28], [38.5, 24], [45, 27]].map(([y, w]) => `<rect x="16" y="${y}" width="${w}" height="2.8" rx="1.4" fill="#AEB8DA"/>`).join('') +
    '<g transform="rotate(40 50 44)"><rect x="46" y="26" width="8" height="24" rx="2" fill="url(#pen)"/><path d="M46 50h8l-4 7Z" fill="#FFD6B3"/><path d="M48.6 54.6h2.8L50 57Z" fill="#3B2F5C"/><rect x="46" y="26" width="8" height="4" rx="2" fill="#FF8FB1"/></g>',
);
// Éditeur de code: an indigo editor window with white angle brackets and a cyan slash
HALO.code = haloSvg(
  lg('cw', [[0, '#7FA6FF'], [1, '#4A36D8']], 0, 0, 1, 1) + GLOSS_DEF,
  '<rect x="6" y="9" width="52" height="46" rx="11" fill="url(#cw)"/><path class="d" d="M17 9h30a11 11 0 0 1 11 11v3H6v-3A11 11 0 0 1 17 9Z" fill="url(#gloss)"/>' +
    '<path d="M24 23.5l-9.5 8.5 9.5 8.5M40 23.5l9.5 8.5-9.5 8.5" fill="none" stroke="#fff" stroke-width="4.4" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M35.5 20.5l-7 23" fill="none" stroke="#8FF4FF" stroke-width="4.4" stroke-linecap="round"/>',
);
HALO.terminal = haloSvg(
  lg('t', [[0, '#3E4A66'], [1, '#141A2A']]) + SHEEN_DEF + lg('m', [[0, '#7CFFCB'], [1, '#2BD4A0']]),
  TILE('t') + SHEEN + '<path d="M17 26l9 7-9 7" fill="none" stroke="url(#m)" stroke-width="4.2" stroke-linecap="round" stroke-linejoin="round"/><rect x="30" y="38" width="16" height="4.2" rx="2.1" fill="url(#m)"/>',
);
HALO.media = haloSvg(
  lg('d', [[0, '#FF8A5B'], [0.5, '#F0386B'], [1, '#B21AA5']], 0, 0, 1, 1) + GLOSS_DEF,
  '<circle cx="32" cy="32" r="25" fill="url(#d)"/><ellipse cx="32" cy="19" rx="17" ry="9" fill="url(#gloss)"/>' +
    '<path d="M27 21.6v20.8a2.2 2.2 0 0 0 3.4 1.9l16.6-10.4a2.2 2.2 0 0 0 0-3.8L30.4 19.7a2.2 2.2 0 0 0-3.4 1.9Z" fill="#fff"/>',
);
// Musique (launcher alias of the Lecteur): two notes in the Lecteur's sunset gradient on a soft disc
HALO.music = haloSvg(
  lg('mu', [[0, '#FFB86B'], [0.5, '#FF4F8B'], [1, '#9B35E0']], 0, 0, 1, 1) + lg('mb', [[0, '#FFE3EE'], [1, '#F6D3FF']]) + GLOSS_DEF,
  '<circle cx="32" cy="32" r="25" fill="url(#mb)"/><ellipse class="d" cx="32" cy="19" rx="17" ry="9" fill="url(#gloss)"/>' + gl(G('music-notes', 'f'), 14, 14, 36, 'url(#mu)'),
);
// Caméra: an indigo camera body with a white lens ring, a deep glass lens and a small warm flash
HALO.camera = haloSvg(
  lg('cb', [[0, '#7FD8FF'], [0.5, '#4D7CFF'], [1, '#5B34D6']], 0, 0, 1, 1) + rg('ln', [[0, '#A8ECFF'], [0.45, '#2B4FC9'], [1, '#141A3A']], 0.38, 0.35, 0.7) + GLOSS_DEF,
  '<path d="M22.5 11h19a3 3 0 0 1 2.6 1.5L47 18h5a6 6 0 0 1 6 6v24a6 6 0 0 1-6 6H12a6 6 0 0 1-6-6V24a6 6 0 0 1 6-6h5l2.9-5.5A3 3 0 0 1 22.5 11Z" fill="url(#cb)"/>' +
    '<path class="d" d="M12 18h40a6 6 0 0 1 6 6v6H6v-6a6 6 0 0 1 6-6Z" fill="url(#gloss)"/>' +
    '<circle cx="32" cy="36" r="13.5" fill="#fff"/><circle cx="32" cy="36" r="10.2" fill="url(#ln)"/>' +
    '<circle class="d" cx="28.4" cy="32.2" r="3" fill="#fff" opacity=".7"/><circle cx="50" cy="24.5" r="2.4" fill="#FFE7A3"/>',
);
const PHOTO_DEFS = lg('sky', [[0, '#FFD6A0'], [0.55, '#FF92B5'], [1, '#B77BFF']]) + lg('m1', [[0, '#8A5CFF'], [1, '#5530D0']]) + lg('m2', [[0, '#C26BFF'], [1, '#8E3FE0']]) + SHEEN_DEF;
const photo = (x, y, s, id) =>
  `<clipPath id="${id}"><rect x="${x}" y="${y}" width="${s}" height="${s}" rx="${r2(s * 0.27)}"/></clipPath>` +
  `<g clip-path="url(#${id})" transform="translate(${x} ${y}) scale(${r2(s / 52)}) translate(-6 -6)"><rect x="6" y="6" width="52" height="52" fill="url(#sky)"/>` +
  '<circle cx="41" cy="23" r="7" fill="#FFF3C4"/><circle cx="41" cy="23" r="10.5" fill="#FFF3C4" opacity=".3"/>' +
  '<path d="M2 50 20 30l10 11 7-7 23 20v12H2Z" fill="url(#m1)"/><path d="M2 58c12-9 22-12 34-8s16 4 26 1v12H2Z" fill="url(#m2)"/></g>';
HALO.photos = haloSvg(PHOTO_DEFS, photo(6, 6, 52, 'c') + SHEEN);
// the day number of the calendars ("12", the mockup's date) as strokes: no font needed inside an <img>
const TWELVE = '<path d="M21.5 34.5l4.5-3.2V49" fill="none" stroke="#2A2F3D" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M32.5 35c0-2.6 2.2-4.2 4.8-4.2s4.8 1.6 4.8 4.4c0 4.4-9.6 8.2-9.6 13.8h9.8" fill="none" stroke="#2A2F3D" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/>';
HALO.calendar = haloSvg(
  lg('pg', [[0, '#FFFFFF'], [1, '#E9ECF4']]) + lg('band', [[0, '#FF6F6F'], [1, '#E2304E']]),
  '<rect x="8" y="10" width="48" height="46" rx="9" fill="url(#pg)"/><path d="M8 19a9 9 0 0 1 9-9h30a9 9 0 0 1 9 9v5H8Z" fill="url(#band)"/>' +
    '<rect x="19" y="6" width="4.4" height="10" rx="2.2" fill="#7E879C"/><rect x="40.6" y="6" width="4.4" height="10" rx="2.2" fill="#7E879C"/>' +
    TWELVE,
);
HALO.clock = haloSvg(
  lg('r', [[0, '#8EA2FF'], [1, '#3F33C4']], 0, 0, 1, 1) + lg('f', [[0, '#FFFFFF'], [1, '#E6EAF7']]),
  '<circle cx="32" cy="32" r="26" fill="url(#r)"/><circle cx="32" cy="32" r="20" fill="url(#f)"/>' +
    `<g class="d">${Array.from({ length: 12 }, (_, i) => `<rect x="31" y="14.5" width="2" height="4" rx="1" fill="#9AA3C2" transform="rotate(${i * 30} 32 32)"/>`).join('')}</g>` +
    '<path d="M32 32V20.5" stroke="#1E1B4B" stroke-width="3.2" stroke-linecap="round"/><path d="M32 32l9 5" stroke="#1E1B4B" stroke-width="2.6" stroke-linecap="round"/>' +
    '<path class="d" d="M32 32l-7 9" stroke="#FF7A45" stroke-width="1.6" stroke-linecap="round"/><circle cx="32" cy="32" r="2.4" fill="#FF7A45"/>' +
    '<path class="d" d="M14 22a21 21 0 0 1 14-10" fill="none" stroke="#fff" stroke-opacity=".5" stroke-width="1.6" stroke-linecap="round"/>',
);
HALO.store = haloSvg(
  lg('b', [[0, '#D08CFF'], [0.55, '#8B45F5'], [1, '#E0479E']], 0, 0, 0.6, 1) + GLOSS_DEF,
  '<path d="M24 25v-6a8 8 0 0 1 16 0v6" fill="none" stroke="#6A2BD9" stroke-width="3.6" stroke-linecap="round"/>' +
    '<path d="M13 22h38a2 2 0 0 1 2 2.2l-2.6 27.6A6 6 0 0 1 44.4 57H19.6a6 6 0 0 1-6-5.2L11 24.2A2 2 0 0 1 13 22Z" fill="url(#b)"/>' +
    '<path class="d" d="M14 23.4h36" stroke="#fff" stroke-opacity=".6" stroke-width="1.3" stroke-linecap="round"/>' +
    '<circle cx="24" cy="27.5" r="2" fill="#4B1A9E" opacity=".6"/><circle cx="40" cy="27.5" r="2" fill="#4B1A9E" opacity=".6"/>' +
    '<path d="M32 31.5c.9 4.6 1.9 5.6 6.5 6.5-4.6.9-5.6 1.9-6.5 6.5-.9-4.6-1.9-5.6-6.5-6.5 4.6-.9 5.6-1.9 6.5-6.5Z" fill="#fff"/>',
);
HALO.taskmgr = haloSvg(
  lg('t', [[0, '#4FE6A8'], [1, '#0B9467']]) + SHEEN_DEF,
  TILE('t') +
    SHEEN +
    `<g class="d">${[[14, 10], [23, 16], [32, 8], [41, 20]].map(([x, h]) => `<rect x="${x}" y="${52 - h}" width="6" height="${h}" rx="2" fill="#fff" opacity=".22"/>`).join('')}</g>` +
    '<path d="M12 34h8l4.5-10 7 21 5-14 3 5h12.5" fill="none" stroke="#fff" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/>',
);
const MONITOR = (scr) =>
  '<path d="M25 46h14l2 7H23Z" fill="#8F9AB0"/><rect x="18" y="52" width="28" height="4.5" rx="2.25" fill="url(#b)"/>' +
  `<rect x="5" y="10" width="54" height="37" rx="6" fill="url(#b)"/><rect x="8.5" y="13.5" width="47" height="30" rx="3.5" fill="url(#${scr})"/>`;
const MONITOR_DEFS = lg('b', [[0, '#E6EBF3'], [1, '#A2AEC3']]);
HALO['this-pc'] = haloSvg(
  MONITOR_DEFS + lg('s', [[0, '#5B86FF'], [0.55, '#8A55F0'], [1, '#FF7AB6']], 0, 0, 1, 1),
  MONITOR('s') + '<circle cx="34" cy="28.5" r="9" fill="none" stroke="#fff" stroke-opacity=".75" stroke-width="2.4"/><circle cx="34" cy="28.5" r="4" fill="#fff" opacity=".6"/>',
);
const BIN = (inside = '') =>
  '<path d="M15 21h34l-3.3 31.2A5 5 0 0 1 40.7 57H23.3a5 5 0 0 1-5-4.8Z" fill="url(#b)"/>' +
  inside +
  [[24, 0.6], [32, 0], [40, -0.6]].map(([x, d]) => `<path d="M${x} 27l${d} 24" stroke="#7F98C4" stroke-opacity=".55" stroke-width="2" stroke-linecap="round"/>`).join('') +
  '<rect x="11" y="14" width="42" height="7" rx="3.5" fill="url(#l)"/><rect x="26" y="9.5" width="12" height="6" rx="2.5" fill="none" stroke="#9FB3D6" stroke-width="2.4"/>';
const BIN_DEFS = lg('b', [[0, '#F2F7FF', 0.95], [1, '#9FB8E4', 0.95]]) + lg('l', [[0, '#E6EEFB'], [1, '#8EA4CE']]);
HALO['recycle-bin'] = haloSvg(BIN_DEFS, BIN());
// --- the apps the mockup did not draw, in the same language
HALO.archive = haloSvg(
  lg('b', [[0, '#F2C27E'], [1, '#C07A32']]) + lg('l', [[0, '#FFE0A8'], [1, '#E2A458']]) + GLOSS_DEF,
  '<path d="M10 24h44v26a6 6 0 0 1-6 6H16a6 6 0 0 1-6-6Z" fill="url(#b)"/>' +
    '<rect x="6" y="12" width="52" height="14" rx="5" fill="url(#l)"/><rect x="6" y="12" width="52" height="7" rx="3.5" fill="url(#gloss)"/>' +
    '<rect x="23" y="31" width="18" height="7" rx="3.5" fill="#FFF6E6"/><rect x="29" y="12" width="6" height="14" fill="#8A4E14" opacity=".35"/>',
);
HALO.backup = haloSvg(
  lg('d', [[0, '#62E8C9'], [1, '#0B8C86']], 0, 0, 1, 1) + GLOSS_DEF,
  '<circle cx="32" cy="32" r="25" fill="url(#d)"/><ellipse class="d" cx="32" cy="19" rx="17" ry="9" fill="url(#gloss)"/>' + gl(G('clock-counter-clockwise', 'b'), 14, 14, 36, '#fff'),
);
HALO.chess = haloSvg(
  lg('k', [[0, '#B79CFF'], [1, '#4A25B8']], 0, 0, 0.6, 1) + lg('base', [[0, '#E6E0FF'], [1, '#9C8BE0']]) + GLOSS_DEF + SHEEN_DEF,
  '<ellipse cx="32" cy="55" rx="20" ry="3.6" fill="#2A1A66" opacity=".25"/>' + shape(G('horse'), 4, 3, 56, 'k'),
);
HALO.cloud = haloSvg(lg('c', [[0, '#B7ECFF'], [0.5, '#5FB8FF'], [1, '#3561E8']]) + GLOSS_DEF + SHEEN_DEF, shape(G('cloud'), 2, 4, 60, 'c'));
HALO.contacts = haloSvg(
  lg('card', [[0, '#FFFFFF'], [1, '#E7EBF6']]) + lg('a', [[0, '#FFB38A'], [1, '#F0566A']], 0, 0, 1, 1) + lg('sp', [[0, '#7C8CFF'], [1, '#4F46E5']]),
  '<rect x="12" y="7" width="42" height="50" rx="7" fill="url(#card)"/>' +
    [15, 25, 35, 45].map((y) => `<rect x="8" y="${y}" width="8" height="4" rx="2" fill="url(#sp)"/>`).join('') +
    '<circle cx="34" cy="25" r="7.5" fill="url(#a)"/><path d="M21 45c1.5-7 6.6-10.5 13-10.5S45.5 38 47 45a2 2 0 0 1-2 2.4H23a2 2 0 0 1-2-2.4Z" fill="url(#a)"/>' +
    '<circle class="d" cx="31.5" cy="22.5" r="2.2" fill="#fff" opacity=".45"/>',
);
HALO.disks = haloDrive('', '#2FD39A');
HALO.game2048 = haloSvg(
  lg('t', [[0, '#FFD36B'], [1, '#F08A12']]) + lg('u', [[0, '#FFF0C2'], [1, '#FFC867']]) + SHEEN_DEF,
  '<rect x="16" y="4" width="44" height="44" rx="12" fill="url(#u)" opacity=".9"/>' +
    '<rect x="4" y="16" width="44" height="44" rx="12" fill="url(#t)"/><rect class="d" x="4.6" y="16.6" width="42.8" height="42.8" rx="11.4" fill="none" stroke="url(#sheen)" stroke-width="1.2"/>' +
    '<path d="M18.5 32.5c0-3.6 2.8-6 6.6-6s6.6 2.4 6.6 6c0 6-13.2 10.4-13.2 17.5h13.6" fill="none" stroke="#fff" stroke-width="4.6" stroke-linecap="round" stroke-linejoin="round"/>',
);
HALO.installer = haloSvg(
  lg('tr', [[0, '#E6EBF3'], [1, '#A2AEC3']]) + lg('a', [[0, '#7FD8FF'], [1, '#4A4BEA']]) + GLOSS_DEF,
  '<path d="M6 38h12l3.5 6h21l3.5-6h12v12a6 6 0 0 1-6 6H12a6 6 0 0 1-6-6Z" fill="url(#tr)"/>' +
    '<path d="M26 6h12v20h9.2a1.6 1.6 0 0 1 1.2 2.7L33.2 44.6a1.6 1.6 0 0 1-2.4 0L15.6 28.7a1.6 1.6 0 0 1 1.2-2.7H26Z" fill="url(#a)"/>' +
    '<path class="d" d="M26 6h12v12H26Z" fill="url(#gloss)"/>',
);
HALO.maps = haloSvg(
  lg('a', [[0, '#8FF0B4'], [1, '#22A86C']]) + lg('b', [[0, '#C8F7DC'], [1, '#6FD6A0']]) + lg('pin', [[0, '#FF8A8A'], [1, '#E2304E']]),
  '<path d="M6 14l16-6v44L6 58Z" fill="url(#a)"/><path d="M22 8l20 6v44l-20-6Z" fill="url(#b)"/><path d="M42 14l16-6v44l-16 6Z" fill="url(#a)"/>' +
    '<path class="d" d="M10 40c6-4 10 2 16-2s10-8 18-4 8 1 10-1" fill="none" stroke="#fff" stroke-width="2" stroke-dasharray="3 3" stroke-linecap="round"/>' +
    '<path d="M38 6a9 9 0 0 1 9 9c0 6.8-9 15-9 15s-9-8.2-9-15a9 9 0 0 1 9-9Z" fill="url(#pin)"/><circle cx="38" cy="15" r="3.4" fill="#fff"/>',
);
HALO.minesweeper = haloSvg(
  lg('f', [[0, '#FF8A6B'], [1, '#E2304E']], 0, 0, 1, 1) + lg('p', [[0, '#D7DEEA'], [1, '#7D8AA3']], 0, 0, 1, 0) + GLOSS_DEF,
  '<ellipse cx="30" cy="55" rx="18" ry="4" fill="url(#p)"/><rect x="18" y="7" width="5" height="49" rx="2.5" fill="url(#p)"/>' +
    '<path d="M23 9c8-3 13 3 20 1.5 3-.6 5.5-1.6 7.5-2.8 1-.6 2.3.1 2.3 1.3V33c0 .7-.4 1.3-1 1.6-7.8 4-13.5-1.8-21-.3-2.5.5-5 1.3-7.8 2.4Z" fill="url(#f)"/>' +
    '<path class="d" d="M23 9c8-3 13 3 20 1.5 3-.6 5.5-1.6 7.5-2.8 1-.6 2.3.1 2.3 1.3v8C45 22 37 15 23 21Z" fill="url(#gloss)"/>',
);
HALO.nettools = haloSvg(
  lg('d', [[0, '#5FE0F5'], [1, '#1859D0']], 0, 0, 1, 1) + GLOSS_DEF,
  '<circle cx="32" cy="32" r="25" fill="url(#d)"/><ellipse class="d" cx="32" cy="19" rx="17" ry="9" fill="url(#gloss)"/>' + gl(G('network'), 15, 15, 34, '#fff'),
);
HALO.notes = haloSvg(
  lg('cv', [[0, '#FFCF5C'], [1, '#EE8A12']]) + lg('pg', [[0, '#FFFFFF'], [1, '#F1EAD9']]) + GLOSS_DEF,
  '<rect x="13" y="6" width="42" height="52" rx="6" fill="url(#pg)"/><rect x="10" y="6" width="40" height="52" rx="6" fill="url(#cv)"/>' +
    '<rect x="10" y="6" width="40" height="18" rx="6" fill="url(#gloss)"/>' +
    '<rect x="20" y="16" width="22" height="9" rx="2.5" fill="#fff" opacity=".9"/>' +
    [14, 24, 34, 44].map((y) => `<rect x="6" y="${y}" width="9" height="4" rx="2" fill="#5A3A12" opacity=".55"/>`).join(''),
);
HALO.passwords = haloSvg(lg('k', [[0, '#FFE58A'], [0.6, '#F5B21C'], [1, '#D97A06']], 0, 0, 1, 1) + GLOSS_DEF + SHEEN_DEF, shape(G('key'), 4, 4, 56, 'k'));
HALO.pdf = haloSvg(
  PAGE_DEFS + lg('r', [[0, '#FF6B6B'], [1, '#D9284A']]),
  page() +
    '<g class="d" fill="#C9D0E2"><rect x="16" y="16" width="18" height="2.8" rx="1.4"/><rect x="16" y="22" width="26" height="2.8" rx="1.4"/></g>' +
    '<rect x="6" y="32" width="34" height="15" rx="4" fill="url(#r)"/><path d="M11.5 43.5v-8h3a2.5 2.5 0 0 1 0 5h-3M20 35.5v8h2.4a4 4 0 0 0 0-8ZM30 43.5v-8h5M30 39.5h4" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
);
// Enregistreur vocal: a free-shape microphone, peach to raspberry
HALO.recorder = haloSvg(lg('g', [[0, '#FFC07A'], [0.5, '#FF6A6A'], [1, '#D41E6A']], 0, 0, 1, 1) + GLOSS_DEF + SHEEN_DEF, shape(G('microphone'), 2, 2, 60, 'g'));
HALO.remote = haloSvg(
  MONITOR_DEFS + lg('s', [[0, '#5FE0F5'], [1, '#4338E0']], 0, 0, 1, 1),
  MONITOR('s') + gl(G('screencast'), 19, 13, 30, '#fff'),
);
// Enregistreur d'écran: the silver monitor of Ordinateur, a coral screen and a white « rec » ring with a red dot
HALO.screenrec = haloSvg(
  MONITOR_DEFS + lg('s', [[0, '#FF9A7A'], [0.55, '#F2456B'], [1, '#B21AA5']], 0, 0, 1, 1) + rg('rd', [[0, '#FF8A8A'], [1, '#E0182F']], 0.4, 0.35, 0.65),
  MONITOR('s') + '<circle cx="32" cy="28.5" r="10.5" fill="none" stroke="#fff" stroke-width="2.6"/><circle cx="32" cy="28.5" r="6.4" fill="#fff"/><circle cx="32" cy="28.5" r="5" fill="url(#rd)"/>',
);
HALO.snake = haloSvg(lg('g', [[0, '#A8F59A'], [1, '#15994A']], 0, 0, 1, 1) + GLOSS_DEF + SHEEN_DEF, shape(G('game-controller'), 2, 2, 60, 'g'));
HALO.snipping = haloSvg(
  lg('k', [[0, '#FF9AD5'], [1, '#B21AA5']], 0, 0, 1, 1) + lg('sel', [[0, '#FFE3F4', 0.9], [1, '#F7B3E0', 0.6]]),
  '<rect x="18" y="18" width="28" height="28" rx="4" fill="url(#sel)"/><rect class="d" x="18" y="18" width="28" height="28" rx="4" fill="none" stroke="#C0368E" stroke-width="1.4" stroke-dasharray="3 2.4"/>' +
    '<path d="M7 20v-6a7 7 0 0 1 7-7h6M44 7h6a7 7 0 0 1 7 7v6M57 44v6a7 7 0 0 1-7 7h-6M20 57h-6a7 7 0 0 1-7-7v-6" fill="none" stroke="url(#k)" stroke-width="5" stroke-linecap="round"/>',
);
HALO.solitaire = haloSvg(
  lg('bk', [[0, '#FF7A8F'], [1, '#C21D4A']], 0, 0, 1, 1) + lg('fr', [[0, '#FFFFFF'], [1, '#E7EBF6']]),
  '<g transform="rotate(-14 26 34)"><rect x="9" y="11" width="32" height="44" rx="6" fill="url(#bk)"/><rect class="d" x="13" y="15" width="24" height="36" rx="3.5" fill="none" stroke="#fff" stroke-opacity=".5" stroke-width="1.4"/></g>' +
    '<g transform="rotate(10 40 34)"><rect x="24" y="10" width="32" height="44" rx="6" fill="url(#fr)"/><rect x="24" y="10" width="32" height="44" rx="6" fill="none" stroke="#B8C0D6" stroke-opacity=".7"/>' +
    gl(G('spade'), 28, 20, 24, '#1E2233') +
    '</g>',
);
HALO.sticky = haloSvg(
  lg('n', [[0, '#FFF59A'], [1, '#FFC93C']]) + lg('cr', [[0, '#F5B300'], [1, '#E09400']], 0, 0, 1, 1) + GLOSS_DEF,
  '<path d="M12 8h40a4 4 0 0 1 4 4v28L40 56H12a4 4 0 0 1-4-4V12a4 4 0 0 1 4-4Z" fill="url(#n)"/><path d="M56 40H44a4 4 0 0 0-4 4v12Z" fill="url(#cr)"/>' +
    '<rect x="8" y="8" width="48" height="14" rx="4" fill="url(#gloss)"/>' +
    '<g class="d" fill="#B9860A" opacity=".55"><rect x="16" y="22" width="26" height="3" rx="1.5"/><rect x="16" y="29" width="30" height="3" rx="1.5"/><rect x="16" y="36" width="18" height="3" rx="1.5"/></g>',
);
HALO.todo = haloSvg(
  lg('d', [[0, '#7FA8FF'], [1, '#3346D3']], 0, 0, 1, 1) + GLOSS_DEF,
  '<circle cx="32" cy="32" r="25" fill="url(#d)"/><ellipse cx="32" cy="19" rx="17" ry="9" fill="url(#gloss)"/>' +
    '<path d="M20.5 33.5l7.5 7.5 15.5-17" fill="none" stroke="#fff" stroke-width="5.2" stroke-linecap="round" stroke-linejoin="round"/>',
);
HALO.translate = haloSvg(
  lg('a', [[0, '#FFB65C'], [1, '#F2620F']], 0, 0, 1, 1) + lg('b', [[0, '#73C0FF'], [1, '#3F4BE8']], 0, 0, 1, 1) + GLOSS_DEF,
  '<path d="M26 6h24a8 8 0 0 1 8 8v14a8 8 0 0 1-8 8h-1v6l-7-6H26a8 8 0 0 1-8-8V14a8 8 0 0 1 8-8Z" fill="url(#a)"/>' +
    '<path class="d" d="M30 15h16M38 12v3M43 15c-1.5 6-5 10-11 12M33 18c1.5 4 5 7.5 10 9" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/>' +
    '<path d="M14 24h22a8 8 0 0 1 8 8v14a8 8 0 0 1-8 8H21l-8 6v-6.2A8 8 0 0 1 6 46V32a8 8 0 0 1 8-8Z" fill="url(#b)"/>' +
    '<path d="M17.5 48.5l7.5-18 7.5 18M20.3 42h9.4" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>',
);
// Éditeur vidéo: a clapperboard as a free shape, sky blue to violet
HALO.weather = haloSvg(
  rg('sun', [[0, '#FFF3B0'], [0.55, '#FFC23D'], [1, '#FF8A1F']], 0.4, 0.35, 0.7) + lg('c', [[0, '#FFFFFF'], [1, '#C9DAF7']]) + GLOSS_DEF,
  '<circle cx="24" cy="24" r="17" fill="url(#sun)"/>' +
    '<path d="M21 56h28a11 11 0 0 0 1.4-21.9A14 14 0 0 0 23.6 33 11.5 11.5 0 0 0 21 56Z" fill="url(#c)"/>' +
    '<path class="d" d="M24.5 34.5A13.5 13.5 0 0 1 49 35" fill="none" stroke="#fff" stroke-width="1.4" stroke-linecap="round"/>',
);
HALO.winver = haloSvg(
  rg('n', [[0, '#5E6FD8'], [0.6, '#27307A'], [1, '#141A3A']], 0.35, 0.3, 0.8) + lg('m', [[0, '#FFFFFF'], [1, '#C9D3FF']]) + GLOSS_DEF,
  '<circle cx="32" cy="32" r="26" fill="url(#n)"/><ellipse class="d" cx="32" cy="18" rx="18" ry="9" fill="url(#gloss)"/>' +
    `<g transform="translate(9 9) scale(.96)" fill="url(#m)">${LOGO}</g>`,
);
HALO['app-default'] = haloSvg(
  lg('t', [[0, '#8EA2FF'], [1, '#4B3FD9']]) + lg('w', [[0, '#FFFFFF'], [1, '#E4E9FB']]),
  '<rect x="6" y="9" width="52" height="46" rx="8" fill="url(#w)"/><path d="M6 17a8 8 0 0 1 8-8h36a8 8 0 0 1 8 8v4H6Z" fill="url(#t)"/>' +
    '<g fill="#fff" opacity=".85"><circle cx="45" cy="15" r="2"/><circle cx="51" cy="15" r="2"/></g>' +
    '<g class="d" fill="#C2CBEA"><rect x="13" y="28" width="16" height="20" rx="3"/><rect x="33" y="28" width="18" height="3.2" rx="1.6"/><rect x="33" y="35" width="14" height="3.2" rx="1.6"/><rect x="33" y="42" width="16" height="3.2" rx="1.6"/></g>',
);
// --- Fichiers icons
const HALO_FILES = {};
for (const [name, def] of Object.entries(FILE_ICONS)) if (def.shape === 'folder') HALO_FILES[name] = haloFolder(def.icon);
HALO_FILES.file = haloSvg(PAGE_DEFS, page() + '<g class="d" fill="#D3D9E8"><rect x="16" y="24" width="26" height="2.8" rx="1.4"/><rect x="16" y="31" width="30" height="2.8" rx="1.4"/><rect x="16" y="38" width="22" height="2.8" rx="1.4"/></g>');
HALO_FILES['file-text'] = haloSvg(
  PAGE_DEFS,
  page() + '<rect x="16" y="22" width="20" height="3.6" rx="1.8" fill="#5B5CF0"/>' + [[30, 28], [36.5, 24], [43, 27], [49.5, 18]].map(([y, w]) => `<rect x="16" y="${y}" width="${w}" height="2.8" rx="1.4" fill="#AEB8DA"/>`).join(''),
);
HALO_FILES['file-pdf'] = HALO.pdf;
HALO_FILES['file-sheet'] = haloSvg(
  PAGE_DEFS + lg('g', [[0, '#46E09B'], [1, '#109A63']]),
  page() + '<rect x="15" y="26" width="32" height="24" rx="3.5" fill="url(#g)"/><path d="M15 34h32M15 42h32M26 26v24M36.5 26v24" stroke="#fff" stroke-opacity=".75" stroke-width="1.6"/>',
);
HALO_FILES['file-image'] = haloSvg(PAGE_DEFS + PHOTO_DEFS, page() + photo(14, 24, 30, 'ph'));
const BADGES = {
  'file-doc': ['#62B6FF', '#2766E8', 'text-align-left', 'b'],
  'file-slides': ['#FFB65C', '#F2620F', 'presentation', 'f'],
  'file-audio': ['#FF8AC8', '#C2268F', 'music-notes', 'f'],
  'file-video': ['#B98CFF', '#6A2BD9', 'film-strip', 'f'],
  'file-archive': ['#F2C27E', '#B8701F', 'file-zip', 'f'],
  'file-code': ['#4FE6C8', '#0E8C8C', 'code', 'b'],
  'file-exec': ['#3E4A66', '#141A2A', 'terminal-window', 'f'],
  'file-font': ['#C59CFF', '#7A3CE0', 'text-aa', 'b'],
  'file-mail': ['#73C0FF', '#4562F5', 'envelope-simple', 'f'],
  'file-package': ['#E8B46A', '#A8641C', 'package', 'f'],
  'file-disc': ['#B7C6DE', '#56648A', 'hard-drive', 'f'],
  'file-web': ['#5BF2EE', '#139AE6', 'globe-simple', 'f'],
};
for (const [name, [a, b, g, w]] of Object.entries(BADGES)) HALO_FILES[name] = docBadge(a, b, g, w);
HALO_FILES['drive-hdd'] = haloDrive('', '#2FD39A');
HALO_FILES['drive-system'] = haloDrive(`<g transform="translate(36 17) scale(.27)" fill="#5B5CF0">${LOGO}</g>`, '#5FB8FF');
HALO_FILES['drive-usb'] = haloSvg(
  lg('b', [[0, '#73C0FF'], [1, '#3F4BE8']], 0, 0, 1, 1) + lg('m', [[0, '#EEF2F8'], [1, '#A9B5CA']]) + GLOSS_DEF,
  '<g transform="rotate(-35 32 32)"><rect x="25" y="4" width="14" height="14" rx="2" fill="url(#m)"/><rect x="28.5" y="8" width="2.6" height="3.4" fill="#6B7894"/><rect x="33" y="8" width="2.6" height="3.4" fill="#6B7894"/>' +
    '<rect x="20" y="17" width="24" height="44" rx="7" fill="url(#b)"/><rect x="20" y="17" width="12" height="44" rx="6" fill="url(#gloss)"/><circle cx="32" cy="50" r="3" fill="#fff" opacity=".8"/></g>',
);
HALO_FILES['drive-optical'] = haloSvg(
  rg('cd', [[0, '#FFFFFF'], [0.3, '#E6EBF3'], [0.6, '#C9D3E6'], [1, '#9AA8C0']]) + lg('ir', [[0, '#FF9AD5', 0.55], [0.35, '#7FD8FF', 0.5], [0.7, '#9BF26A', 0.45], [1, '#FFD36B', 0.5]], 0, 0, 1, 1),
  '<circle cx="32" cy="32" r="26" fill="url(#cd)"/><circle cx="32" cy="32" r="26" fill="url(#ir)"/><circle cx="32" cy="32" r="9" fill="#EEF2F8"/><circle cx="32" cy="32" r="4" fill="#5E6C88"/>' +
    '<circle cx="32" cy="32" r="25.4" fill="none" stroke="#8E9AB2" stroke-opacity=".5"/>',
);
HALO_FILES.gallery = haloSvg(PHOTO_DEFS + lg('b2', [[0, '#C9D2F7'], [1, '#9AA8EE']]), '<rect x="14" y="4" width="44" height="44" rx="11" fill="url(#b2)" opacity=".85"/>' + photo(6, 14, 44, 'g1'));
HALO_FILES.home = haloSvg(
  lg('roof', [[0, '#FF8A6B'], [1, '#E2304E']], 0, 0, 1, 1) + lg('w', [[0, '#FFFFFF'], [1, '#E6EAF7']]) + lg('door', [[0, '#7FA8FF'], [1, '#3346D3']]),
  '<path d="M13 30h38v22a5 5 0 0 1-5 5H18a5 5 0 0 1-5-5Z" fill="url(#w)"/><rect x="27" y="39" width="10" height="18" rx="2.5" fill="url(#door)"/>' +
    '<path d="M6.5 30.5 29.4 9.2a3.8 3.8 0 0 1 5.2 0L57.5 30.5a2.6 2.6 0 0 1-1.8 4.5H8.3a2.6 2.6 0 0 1-1.8-4.5Z" fill="url(#roof)"/>',
);
HALO_FILES.link = haloSvg(lg('d', [[0, '#7FA8FF'], [1, '#3346D3']], 0, 0, 1, 1), '<circle cx="32" cy="32" r="20" fill="#fff"/><circle cx="32" cy="32" r="17" fill="url(#d)"/>' + gl(G('link-simple', 'b'), 20, 20, 24, '#fff'));
HALO_FILES['trash-full'] = haloSvg(
  BIN_DEFS + lg('p1', [[0, '#FFE27A'], [1, '#FFB42A']]) + lg('p2', [[0, '#9AD8FF'], [1, '#4C7DF0']]),
  '<circle cx="25" cy="17" r="8" fill="url(#p1)"/><circle cx="38" cy="15" r="7" fill="url(#p2)"/>' + BIN(),
);

// ================================================================== PRISME
function squircle(cx, cy, r, n = 5, steps = 96) {
  const pts = [];
  for (let i = 0; i < steps; i++) {
    const t = (2 * Math.PI * i) / steps;
    const c = Math.cos(t);
    const s = Math.sin(t);
    pts.push(`${(cx + r * Math.sign(c) * Math.abs(c) ** (2 / n)).toFixed(2)},${(cy + r * Math.sign(s) * Math.abs(s) ** (2 / n)).toFixed(2)}`);
  }
  return `M${pts.join(' L')}Z`;
}
const SQ = squircle(32, 32, 28);
/** A Prisme icon: glossy squircle, two-tone gradient, white symbol (a Phosphor glyph or custom markup). */
function prisme(top, bottom, symbol, { glyphColor = '#FFFFFF', size = 34, logo = false } = {}) {
  let sym;
  let small = '';
  if (typeof symbol === 'string' && symbol.startsWith('<')) sym = `<g filter="url(#ds)">${symbol}</g>`;
  else {
    const [name, w = 'f'] = Array.isArray(symbol) ? symbol : [symbol];
    const off = (64 - size) / 2;
    if (logo) {
      sym = `<g filter="url(#ds)"><g class="s" transform="translate(12 12.5) scale(.8333)" fill="${glyphColor}">${LOGO}</g></g>`;
      small = '.s{transform:translate(8px,8.5px) scale(1)}';
    } else {
      sym = `<g filter="url(#ds)">${gl(G(name, w), off, off + 0.5, size, glyphColor, 's')}</g>`;
      const big = size + 8;
      small = `.s{transform:translate(${(64 - big) / 2}px,${(64 - big) / 2 + 0.5}px) scale(${+(big / 256).toFixed(5)})}`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
<!-- Prisme icon (tools/gen-finish-icons.mjs). Symbols: Phosphor Icons 2.1.1, MIT. -->
<style>@media (max-width:26px){.d{display:none}${small}}</style>
<defs>
<linearGradient id="bg" x1="0.2" y1="0" x2="0.8" y2="1"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient>
<radialGradient id="sheen" cx="0.3" cy="0.05" r="0.9"><stop offset="0" stop-color="#FFFFFF" stop-opacity="0.45"/><stop offset="0.55" stop-color="#FFFFFF" stop-opacity="0.06"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/></radialGradient>
<linearGradient id="rim" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF" stop-opacity="0.75"/><stop offset="0.35" stop-color="#FFFFFF" stop-opacity="0.12"/><stop offset="1" stop-color="#000000" stop-opacity="0.18"/></linearGradient>
<filter id="ds" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="1.2" stdDeviation="1.2" flood-color="#000000" flood-opacity="0.22"/></filter>
<clipPath id="clip"><path d="${SQ}"/></clipPath>
</defs>
<path d="${SQ}" fill="url(#bg)"/>
<g clip-path="url(#clip)">
<ellipse cx="22" cy="6" rx="40" ry="24" fill="url(#sheen)"/>
<ellipse cx="50" cy="66" rx="34" ry="14" fill="${bottom}" opacity="0.55"/>
</g>
${sym}
<path d="${SQ}" fill="none" stroke="url(#rim)" stroke-width="1"/>
</svg>
`;
}
// app id -> [top, bottom, symbol (Phosphor name or [name, weight]), options]
const PRISME_APPS = {
  // documents and time: gold, tangerine, coral, rose
  files: ['#FFD45C', '#FF8F1F', 'folder-simple'],
  notepad: ['#FFB06A', '#F2602E', 'note-pencil'],
  notes: ['#FFE07A', '#F59E1B', 'notebook'],
  sticky: ['#FFE98A', '#F2B200', 'note'],
  archive: ['#F7CF84', '#C9822F', 'archive'],
  contacts: ['#FFB98A', '#EF6A3A', 'address-book'],
  pdf: ['#FF8C8C', '#E0303C', 'file-pdf'],
  todo: ['#FF9C86', '#EC4462', 'check-circle'],
  clock: ['#FF7FA6', '#D92C6B', 'clock'],
  // creation and media: pink, orchid, violet
  photos: ['#FFC35A', '#F2468F', 'flower'],
  paint: ['#F08CFF', '#A83CF0', 'paint-brush'],
  snipping: ['#FF9BD2', '#D93A92', ['scan', 'b']],
  media: ['#A88DFF', '#5B3BF0', 'play'],
  recorder: ['#FFB38A', '#E8457A', 'microphone'],
  screenrec: ['#FF8A7A', '#D9264F', 'record'],
  camera: ['#FF8EC7', '#6A3BE6', 'camera'],
  music: ['#FF9ACB', '#B8329A', 'music-notes'],
  // games (play): one hue each, from the same warm-to-violet arc
  chess: ['#C6A6FF', '#6A36DE', 'horse'],
  solitaire: ['#FF8FB3', '#D42D62', 'spade'],
  minesweeper: ['#FFB37A', '#E8562C', 'flag'],
  game2048: ['#FFCF6B', '#F0821C', 'number-square-two'],
  snake: ['#A8F27A', '#25A04A', 'game-controller'],
  // web and messages: indigo, azure, cyan
  store: ['#86A6FF', '#3E4CE6', 'shopping-bag-open'],
  remote: ['#9AA6FF', '#4B3BDF', 'screencast'],
  mail: ['#62C8FF', '#2770F2', 'envelope-simple'],
  cloud: ['#9AD8FF', '#4A7CF0', 'cloud'],
  weather: ['#7FD3FF', '#2F86F0', 'cloud-sun'],
  browser: ['#5BF2EE', '#139AE6', 'compass'],
  nettools: ['#5FE0F5', '#1676C8', 'network'],
  translate: ['#6EE8D8', '#1A92C4', ['translate', 'b']],
  // system and tools: teal, green, slate, ink
  calculator: ['#52F0C2', '#0E9F96', 'calculator'],
  maps: ['#8FF0B4', '#1FA87A', 'map-trifold'],
  backup: ['#6EE6C6', '#129A86', 'clock-counter-clockwise'],
  passwords: ['#74E3B8', '#11896E', 'key'],
  taskmgr: ['#9BF26A', '#1FA650', ['pulse', 'b'], { size: 36 }],
  settings: ['#B9C5DE', '#56648A', 'gear-six'],
  disks: ['#AFC0DA', '#4E5D80', 'hard-drives'],
  installer: ['#8FB0FF', '#3550D8', ['download-simple', 'b']],
  code: ['#8C9EFF', '#2A2F9E', ['code', 'b'], { size: 36 }],
  terminal: ['#465172', '#121624', ['terminal', 'b'], { size: 36, glyphColor: '#7DFFC9' }],
  winver: ['#4A5680', '#161B2E', null, { logo: true, glyphColor: '#E9EEFF' }],
  'this-pc': ['#7FB6FF', '#3A5BE0', 'desktop'],
  'recycle-bin': ['#C9D3E6', '#66748F', 'trash'],
  'app-default': ['#C3CCE0', '#66748F', 'app-window'],
};
const PRISME = {};
for (const [id, [top, bottom, sym, opts]] of Object.entries(PRISME_APPS)) PRISME[id] = prisme(top, bottom, sym, opts);
// Calendrier: a white page with the day number in the app colour (as in the mockup)
PRISME.calendar = prisme(
  '#FF8A7A',
  '#EE3657',
  '<rect x="16" y="15" width="32" height="34" rx="7" fill="#FFFFFF"/><path d="M16 22a7 7 0 0 1 7-7h18a7 7 0 0 1 7 7v3H16z" fill="#FFE0E4"/>' +
    '<rect x="22" y="11.5" width="3.4" height="7.5" rx="1.7" fill="#FFFFFF"/><rect x="38.6" y="11.5" width="3.4" height="7.5" rx="1.7" fill="#FFFFFF"/>' +
    '<g transform="translate(32 37.5) scale(.62) translate(-32 -40)">' +
    TWELVE.replace(/#2A2F3D/g, '#EE3657').replace(/stroke-width="3.6"/g, 'stroke-width="4.6"') +
    '</g>',
);
// --- Fichiers icons: the mockup's orange folder; white pages with a two-tone label and a white symbol; squircles
// for the drives and places
const P_FOLDER_DEFS =
  lg('b', [[0, '#F7A928'], [1, '#E07B12']]) +
  lg('f', [[0, '#FFDB6E'], [1, '#FF9F22']], 0.2, 0, 0.7, 1) +
  lg('s', [[0, '#fff', 0.55], [0.3, '#fff', 0]]) +
  '<filter id="d" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="1.6" stdDeviation="1.6" flood-color="#5a2a00" flood-opacity=".28"/></filter>';
function prismeFolder(glyph) {
  const FRONT = 'M4 25a5 5 0 0 1 5-5h46a5 5 0 0 1 5 5v26a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z';
  return haloSvg(
    P_FOLDER_DEFS,
    '<g filter="url(#d)">' +
      '<path d="M6 15a5 5 0 0 1 5-5h12.5a5 5 0 0 1 3.9 1.9L30 15h23a5 5 0 0 1 5 5v31a5 5 0 0 1-5 5H11a5 5 0 0 1-5-5z" fill="url(#b)"/>' +
      '<rect x="10" y="18" width="44" height="17" rx="3" fill="#FFF7E8"/>' +
      `<path d="${FRONT}" fill="url(#f)"/><path d="${FRONT}" fill="url(#s)"/>` +
      '<path class="d" d="M4.5 25a4.5 4.5 0 0 1 4.5-4.5h46a4.5 4.5 0 0 1 4.5 4.5" fill="none" stroke="#fff" stroke-opacity=".7"/>' +
      '</g>' +
      (glyph ? `<g filter="url(#d)">${gl(G(glyph, 'f'), 23, 28, 18, '#FFFFFF', 's')}</g>` : ''),
    glyph ? '.s{transform:translate(20px,25px) scale(.09375)}' : '',
  );
}
const P_PAGE = 'M14 5h24l14 14v36a4 4 0 0 1-4 4H14a4 4 0 0 1-4-4V9a4 4 0 0 1 4-4z';
const P_FOLD = 'M38 5l14 14H42a4 4 0 0 1-4-4z';
function prismePage(top, bottom, glyph, w = 'f') {
  return haloSvg(
    lg('p', [[0, '#FFFFFF'], [1, '#EEF0F6']]) +
      lg('c', [[0, top], [1, bottom]], 0, 0, 1, 1) +
      '<filter id="d" x="-30%" y="-20%" width="160%" height="150%"><feDropShadow dx="0" dy="1.6" stdDeviation="1.6" flood-color="#000" flood-opacity=".22"/></filter>',
    '<g filter="url(#d)">' +
      `<path d="${P_PAGE}" fill="url(#p)" stroke="#7E88A3" stroke-opacity=".3" stroke-width=".8"/><path d="${P_FOLD}" fill="#D9DDE8"/>` +
      '<g class="d" fill="#DCE6F7"><rect x="16" y="14" width="18" height="3" rx="1.5"/><rect x="16" y="21" width="24" height="3" rx="1.5"/></g>' +
      (glyph ? `<rect x="8" y="30" width="34" height="22" rx="6" fill="url(#c)"/>` + gl(G(glyph, w), 16, 32, 18, '#FFFFFF', 's') : '<g class="d" fill="#DCE6F7"><rect x="16" y="28" width="22" height="3" rx="1.5"/><rect x="16" y="35" width="26" height="3" rx="1.5"/><rect x="16" y="42" width="16" height="3" rx="1.5"/></g>') +
      '</g>',
    glyph ? '.s{transform:translate(12px,29px) scale(.1016)}' : '',
  );
}
const PRISME_FILES = {};
for (const [name, def] of Object.entries(FILE_ICONS)) if (def.shape === 'folder') PRISME_FILES[name] = prismeFolder(def.icon);
PRISME_FILES.file = prismePage(null, null, null);
const P_PAGES = {
  'file-text': ['#C3CCE0', '#66748F', 'text-align-left', 'b'],
  'file-doc': ['#62B6FF', '#2766E8', 'text-align-left', 'b'],
  'file-sheet': ['#52E3A0', '#119A62', 'table'],
  'file-slides': ['#FFB06A', '#F2602E', 'presentation'],
  'file-pdf': ['#FF8C8C', '#E0303C', 'file-pdf'],
  'file-image': ['#FFC35A', '#F2468F', 'image'],
  'file-audio': ['#F08CFF', '#A83CF0', 'music-notes'],
  'file-video': ['#A88DFF', '#5B3BF0', 'film-strip'],
  'file-archive': ['#F7CF84', '#C9822F', 'file-zip'],
  'file-code': ['#52F0C2', '#0E9F96', 'code', 'b'],
  'file-exec': ['#465172', '#121624', 'terminal-window'],
  'file-font': ['#C6A6FF', '#6A36DE', 'text-aa', 'b'],
  'file-mail': ['#62C8FF', '#2770F2', 'envelope-simple'],
  'file-package': ['#E8B46A', '#A8641C', 'package'],
  'file-disc': ['#AFC0DA', '#4E5D80', 'hard-drive'],
  'file-web': ['#5BF2EE', '#139AE6', 'globe-simple'],
};
for (const [name, [a, b, g, w]] of Object.entries(P_PAGES)) PRISME_FILES[name] = prismePage(a, b, g, w);
PRISME_FILES['drive-hdd'] = prisme('#AFC0DA', '#4E5D80', 'hard-drive');
PRISME_FILES['drive-system'] = prisme('#8FB0FF', '#3550D8', 'hard-drives');
PRISME_FILES['drive-usb'] = prisme('#62C8FF', '#2770F2', ['usb', 'b']);
PRISME_FILES['drive-optical'] = prisme('#C6A6FF', '#6A36DE', 'vinyl-record');
PRISME_FILES.gallery = prisme('#FFC35A', '#F2468F', 'images');
PRISME_FILES.home = prisme('#FFB06A', '#F2602E', 'house-simple');
PRISME_FILES.link = prisme('#62C8FF', '#2770F2', ['link-simple', 'b']);
PRISME_FILES['trash-full'] = prisme('#C9D3E6', '#66748F', 'trash');

// ================================================================== write
const APP_IDS = readdirSync(join(SHELL, 'apps')).filter((d) => existsSync(join(SHELL, 'apps', d, 'manifest.json')));
export const SPECIAL_FILES = ['this-pc', 'recycle-bin', 'app-default'];
const CHECK = args.includes('--check');
let n = 0;
const stale = [];
for (const [pack, apps, files] of [['halo', HALO, HALO_FILES], ['prisme', PRISME, PRISME_FILES]]) {
  const dir = join(OUT, pack);
  if (CHECK) {
    const want = Object.keys({ ...apps, ...files }).map((id) => `${id}.svg`).sort();
    const have = existsSync(dir) ? readdirSync(dir).sort() : [];
    if (JSON.stringify(want) !== JSON.stringify(have)) stale.push(`${pack}: files ${have.length} / ${want.length}`);
    for (const [id, svg] of Object.entries({ ...apps, ...files })) if (!existsSync(join(dir, `${id}.svg`)) || readFileSync(join(dir, `${id}.svg`), 'utf8') !== svg) stale.push(`${pack}/${id}`);
    continue;
  }
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const missingApps = [...APP_IDS, ...SPECIAL_FILES].filter((id) => !apps[id]);
  const missingFiles = Object.keys(FILE_ICONS).filter((k) => !files[k]);
  if (missingApps.length || missingFiles.length) throw new Error(`${pack}: no icon for ${[...missingApps, ...missingFiles].join(', ')}`);
  for (const [id, svg] of Object.entries({ ...apps, ...files })) {
    if (/\]|undefined|NaN/.test(svg)) throw new Error(`${pack}/${id}: bad SVG`);
    writeFileSync(join(dir, `${id}.svg`), svg);
    n++;
  }
}
if (CHECK) {
  console.log(stale.length ? `stale: ${stale.join(', ')}` : 'up to date');
  process.exit(stale.length ? 1 : 0);
}
if (cacheDirty) writeFileSync(CACHE, `${JSON.stringify(cache, null, 1)}\n`);
console.log(`wrote ${n} icons to ${OUT}`);

// ------------------------------------------------------------------ review sheet
const sheet = argVal('--sheet');
if (sheet) {
  const { createRequire } = await import('node:module');
  const require = createRequire(join(ROOT, 'shell/package.json'));
  const names = [...APP_IDS, ...SPECIAL_FILES, ...Object.keys(FILE_ICONS)];
  const sizes = [64, 48, 32, 24, 16];
  const cell = (pack, id) => `<div class="c"><div class="r">${sizes.map((s) => `<img src="${pack}/${id}.svg" width="${s}" height="${s}">`).join('')}</div><span>${id}</span></div>`;
  const html = `<!doctype html><meta charset="utf-8"><style>body{margin:0;font:11px sans-serif;display:grid;grid-template-columns:1fr 1fr}
section{padding:12px;display:flex;flex-wrap:wrap;gap:6px}section.l{background:#eef0f7;color:#222}section.k{background:#141a2e;color:#ddd}
.c{width:226px;display:flex;flex-direction:column;gap:2px}.r{display:flex;align-items:flex-end;gap:6px}h2{width:100%;margin:4px 0}</style>
${['halo', 'prisme'].map((p) => ['k', 'l'].map((t) => `<section class="${t}"><h2>${p} (${t === 'k' ? 'dark' : 'light'})</h2>${names.map((id) => cell(p, id)).join('')}</section>`).join('')).join('')}`;
  const tmp = join(OUT, '_sheet.html');
  writeFileSync(tmp, html);
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' }).catch(() => null);
  if (!browser) console.warn('no Chromium: sheet skipped (set CHROMIUM)');
  else {
    const page = await browser.newPage({ viewport: { width: 1900, height: 1000 } });
    await page.goto(`file://${tmp}`);
    await page.waitForTimeout(500);
    await page.screenshot({ path: sheet, fullPage: true });
    await browser.close();
    console.log('sheet', sheet);
  }
  rmSync(tmp, { force: true });
}
