#!/usr/bin/env node
// Selene app icons: generates every app icon, the default app icon, the desktop icons (Ordinateur, Corbeille), the
// logo, the glyph table of the derived icon packs, and the review sheet.
//
//   node tools/gen-app-icons.mjs [--phosphor <dir>] [--sheet] [--glyphs-only]
//
// --phosphor: the Phosphor 2.1.1 "assets" folder (it holds fill/, regular/…); default $PHOSPHOR_DIR.
//             Without it, the glyphs already stored in shell/renderer/core/app-glyphs.js are reused, so the icons can
//             be regenerated (e.g. after a colour change) without the design kit.
// --sheet:    also renders docs/design/icons-sheet.png (needs playwright-core and /opt/pw-browsers/chromium).
// --glyphs-only: only rewrites core/app-glyphs.js (the icon files are left untouched).
//
// Style (docs/design/BRIEF.md, "Decisions after the mockups"): a rounded square (radius 22 % of the tile) on a common
// base with a hairline inner highlight; each app's symbol is a Phosphor "fill" glyph (MIT) in one muted colour with a
// slight vertical gradient. The colours of every look (cold / neutral / warm × dark / light, Contraste élevé) and the
// SVG itself live in shell/renderer/core/app-icon-art.js, shared with the shell's "selene" icon pack (core/packs.js),
// which draws the icons for the current ambiance at run time. The static files written here are the cold dark look
// (night-blue base #222c45 -> #161d30): they are what .desktop files, the docs and the first frame before the shell
// loads show.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { ICON_LOOKS, HUE_SLOTS, iconLook, seleneIconSvg } from '../shell/renderer/core/app-icon-art.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHELL = join(ROOT, 'shell/renderer');
const args = process.argv.slice(2);
const argVal = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
const PHOSPHOR = argVal('--phosphor') || process.env.PHOSPHOR_DIR || null;

// ------------------------------------------------------------------ palette
// Muted symbol colours of the cold look (the static files); every look's symbols are >= 4.5:1 on its base (checked
// below). The palettes of all the looks are in core/app-icon-art.js.
export const HUES = ICON_LOOKS.cold.hues;
const [BASE_TOP, BASE_BOTTOM] = ICON_LOOKS.cold.dark;

// app id -> [Phosphor glyph ("fill" weight, or "bold:<name>" for line symbols), hue]
const APPS = {
  archive: ['archive', 'sand'],
  backup: ['clock-counter-clockwise', 'teal'],
  browser: ['compass', 'blue'],
  calculator: ['calculator', 'silver'],
  calendar: ['calendar-dots', 'rose'],
  camera: ['camera', 'terra'],
  chess: ['horse', 'sand'],
  clock: ['clock', 'silver'],
  code: ['bold:code', 'teal'],
  cloud: ['cloud', 'blue'],
  contacts: ['address-book', 'lavender'],
  disks: ['hard-drives', 'silver'],
  files: ['folder-simple', 'amber'],
  game2048: ['number-square-two', 'terra'], // (not squares-four: a 2 × 2 grid of squares reads as the Windows logo)
  installer: ['download-simple', 'blue'],
  mail: ['envelope-simple', 'blue'],
  maps: ['map-trifold', 'sage'],
  media: ['play-circle', 'rose'],
  music: ['music-notes', 'lavender'], // launcher alias of the Lecteur (apps/music/manifest.json "alias")
  minesweeper: ['flag', 'terra'],
  nettools: ['network', 'teal'],
  notepad: ['file-text', 'silver'],
  notes: ['notebook', 'sand'],
  paint: ['palette', 'lavender'],
  passwords: ['key', 'amber'],
  pdf: ['file-pdf', 'terra'],
  photos: ['image', 'teal'],
  recorder: ['microphone', 'rose'],
  remote: ['screencast', 'blue'],
  screenrec: ['record', 'terra'], // Enregistreur d'écran: the « rec » ring and dot
  settings: ['gear-six', 'silver'],
  snake: ['game-controller', 'sage'],
  snipping: ['bold:scan', 'rose'],
  solitaire: ['spade', 'silver'],
  store: ['cube', 'lavender'],
  taskmgr: ['bold:pulse', 'sage'],
  terminal: ['bold:terminal', 'sage'],
  todo: ['check-circle', 'blue'],
  weather: ['cloud-sun', 'amber'],
  winver: ['@logo', 'silver'],
};
// shell icons: key -> [glyph, hue, output file]
const SPECIAL = {
  'special:thispc': ['desktop', 'blue', 'assets/icons/this-pc.svg'],
  'special:trash': ['trash', 'silver', 'assets/icons/recycle-bin.svg'],
  default: ['app-window', 'silver', 'assets/app-default.svg'],
};

// ------------------------------------------------------------------ colour helpers
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const hex = (a) => `#${a.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;
const mix = (a, b, t) => hex(rgb(a).map((v, i) => v + (rgb(b)[i] - v) * t));
const lum = (h) => {
  const c = rgb(h).map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
export const contrast = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
/** Tile colour of the "tiles" pack: the muted hue darkened toward the night base, white glyph >= 4.5:1. */
const tileOf = (hue) => {
  for (let t = 0.45; t <= 0.9; t += 0.05) {
    const c = mix(hue, BASE_BOTTOM, t);
    if (contrast(c, '#ffffff') >= 4.5) return c;
  }
  return BASE_TOP;
};

// ------------------------------------------------------------------ logo
const f = (n) => Number(n.toFixed(2));
/** Crescent = circle (cx, cy, R) minus circle (cx+dx, cy+dy, r), as one path. */
function crescent(cx, cy, R, dx, dy, r) {
  const d = Math.hypot(dx, dy);
  const dir = Math.atan2(dy, dx);
  // angle (seen from the outer centre) of the two intersection points
  const a = Math.acos((R * R + d * d - r * r) / (2 * R * d));
  const p = (t) => [f(cx + R * Math.cos(t)), f(cy + R * Math.sin(t))];
  const [x1, y1] = p(dir - a);
  const [x2, y2] = p(dir + a);
  return `M${x1} ${y1}A${R} ${R} 0 1 0 ${x2} ${y2}A${r} ${r} 0 0 1 ${x1} ${y1}Z`;
}
// 48-unit grid: a slim crescent opening to the upper right, and a round dot-star in the opening.
export const LOGO_CRESCENT = crescent(21, 26.5, 17, 6.4, -6.4, 15.6);
export const LOGO_DOT = { cx: 37.2, cy: 10.6, r: 2.7 };
const { cx: DX, cy: DY, r: DR } = LOGO_DOT;
export const LOGO_DOT_PATH = `M${f(DX - DR)} ${DY}a${DR} ${DR} 0 1 0 ${f(2 * DR)} 0a${DR} ${DR} 0 1 0 ${f(-2 * DR)} 0Z`;
const logoInner = (fill, dotFill = fill) => `<path d="${LOGO_CRESCENT}" fill="${fill}"/><path d="${LOGO_DOT_PATH}" fill="${dotFill}"/>`;

// ------------------------------------------------------------------ glyphs
function loadGlyphs() {
  const all = { ...Object.fromEntries(Object.entries(APPS)), ...Object.fromEntries(Object.entries(SPECIAL).map(([k, v]) => [k, v])) };
  const out = {};
  let stored = null;
  if (!PHOSPHOR || !existsSync(PHOSPHOR)) {
    const src = readFileSync(join(SHELL, 'core/app-glyphs.js'), 'utf8');
    const m = /export const APP_GLYPHS = (\{[\s\S]*?\n\});/.exec(src);
    stored = m ? JSON.parse(m[1]) : {};
  }
  for (const [id, [name, hue]] of Object.entries(all)) {
    let inner;
    if (name === '@logo') inner = null;
    else if (stored) inner = stored[id]?.inner;
    else {
      // "bold:pulse": a line glyph in Phosphor's bold weight (for symbols whose fill form is a box with a cut-out)
      const [w, n] = name.includes(':') ? name.split(':') : ['fill', name];
      const svg = readFileSync(join(PHOSPHOR, w, `${n}-${w}.svg`), 'utf8');
      inner = /<svg[^>]*>([\s\S]*)<\/svg>/.exec(svg)[1].trim();
    }
    if (name !== '@logo' && !inner) throw new Error(`no glyph for ${id}`);
    out[id] = { name, hue, color: HUES[hue], inner };
  }
  return out;
}

// ------------------------------------------------------------------ icon SVG
// (the cold dark look; core/app-icon-art.js draws every look)
const iconSvg = (key, g) => seleneIconSvg(key, { vb: g.name === '@logo' ? 48 : 256, inner: g.name === '@logo' ? logoInner('currentColor').replace(/ fill="currentColor"/g, '') : g.inner, hue: g.hue }, iconLook('cold-dark'));

function logoSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">
<!-- Selene logo: a slim crescent and a round dot-star (tools/gen-app-icons.mjs). Silver with a slate rim, so it
     reads on dark and light surfaces alike. Geometry (48 grid) is shared with the installer art and the winver icon. -->
<defs>
<linearGradient id="selene-logo-m" x1="10" y1="10" x2="26" y2="44" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#f4f6fb"/><stop offset="1" stop-color="#a9b4ca"/></linearGradient>
</defs>
<path d="${LOGO_CRESCENT}" fill="url(#selene-logo-m)" stroke="#4d5a75" stroke-opacity=".85" stroke-width=".9" stroke-linejoin="round"/>
<circle cx="${LOGO_DOT.cx}" cy="${LOGO_DOT.cy}" r="${LOGO_DOT.r}" fill="#dfe5f0" stroke="#4d5a75" stroke-opacity=".85" stroke-width=".9"/>
</svg>
`;
}

// ------------------------------------------------------------------ write
const glyphs = loadGlyphs();
// contrast checks (symbol vs tile, tiles-pack white glyph vs tile)
const problems = [];
for (const [k, g] of Object.entries(glyphs)) {
  for (const b of [BASE_TOP, BASE_BOTTOM]) if (contrast(g.color, b) < 4.5) problems.push(`${k}: ${g.color} on ${b} = ${contrast(g.color, b).toFixed(2)}`);
}
// every look of the shell's "selene" pack: each symbol colour >= 4.5:1 on both stops of its base
for (const amb of ['cold', 'neutral', 'warm']) {
  for (const mode of ['dark', 'light']) {
    const look = iconLook(`${amb}-${mode}`);
    for (const slot of HUE_SLOTS) for (const b of look.base) if (contrast(look.hues[slot], b) < 4.5) problems.push(`${amb}-${mode} ${slot}: ${look.hues[slot]} on ${b} = ${contrast(look.hues[slot], b).toFixed(2)}`);
  }
}
if (problems.length) {
  console.error('contrast too low:\n' + problems.join('\n'));
  process.exit(1);
}

const glyphsOnly = args.includes('--glyphs-only');
if (!glyphsOnly) {
  for (const [id, g] of Object.entries(glyphs)) {
    const file = id in APPS ? join(SHELL, 'apps', id, 'icon.svg') : join(SHELL, SPECIAL[id][2]);
    writeFileSync(file, iconSvg(id === 'default' ? 'app-default' : id.replace(/[^a-z0-9]+/gi, '-'), g));
  }
  writeFileSync(join(SHELL, 'assets/aurora-logo.svg'), logoSvg());
}

// glyph table of the derived packs (core/packs.js)
const table = {};
for (const [id, g] of Object.entries(glyphs)) {
  table[id] =
    g.name === '@logo'
      ? { vb: 48, hue: g.hue, color: g.color, tile: tileOf(g.color), inner: logoInner('currentColor').replace(/ fill="currentColor"/g, '') }
      : { vb: 256, hue: g.hue, color: g.color, tile: tileOf(g.color), inner: g.inner };
}
writeFileSync(
  join(SHELL, 'core/app-glyphs.js'),
  `// GENERATED by tools/gen-app-icons.mjs: do not edit by hand.
// The symbol of every Selene app icon, for the derived icon packs of core/packs.js.
//   APP_GLYPHS[appId | 'special:thispc' | 'special:trash' | 'default'] = { vb, hue, color, tile, inner }
//   vb: viewBox size of \`inner\` (256 for Phosphor glyphs, 48 for the logo); hue: the app's palette slot (its symbol
//   colour in every look, core/app-icon-art.js); color: the symbol colour of the static (cold) icon; tile: a darker
//   tile colour for that hue (white glyph >= 4.5:1); inner: SVG markup without fills.
// Symbols: Phosphor Icons 2.1.1 (MIT, assets/icons/LICENSE-phosphor.txt), "fill" weight.
export const APP_GLYPHS = ${JSON.stringify(table, null, 1)};
// The logo on a 48 grid (also drawn by assets/aurora-logo.svg, apps/winver/icon.svg and apps/installer/art.js).
export const LOGO = ${JSON.stringify({ crescent: LOGO_CRESCENT, dot: LOGO_DOT, dotPath: LOGO_DOT_PATH })};
`,
);
console.log(glyphsOnly ? 'wrote core/app-glyphs.js' : `wrote ${Object.keys(glyphs).length} icons, the logo and core/app-glyphs.js`);

// ------------------------------------------------------------------ review sheet
if (args.includes('--sheet')) {
  const require = createRequire(join(ROOT, 'shell/package.json'));
  const { chromium } = require('playwright-core');
  const fonts = pathToFileURL(join(ROOT, 'docs/design/mockups/assets/fonts')).href;
  const ids = [...Object.keys(APPS), 'special:thispc', 'special:trash', 'default'];
  const fileOf = (id) => pathToFileURL(id in APPS ? join(SHELL, 'apps', id, 'icon.svg') : join(SHELL, SPECIAL[id][2])).href;
  // the validated names of the brief (docs/design/BRIEF.md), the manifests' names otherwise
  const RENAMED = {
    'special:thispc': 'Ordinateur', 'special:trash': 'Corbeille', default: 'Par défaut', files: 'Fichiers', notepad: 'Éditeur de texte',
    paint: 'Dessin', todo: 'Tâches', media: 'Lecteur', store: 'Logithèque', browser: 'Navigateur', archive: 'Archives',
    taskmgr: 'Moniteur système', snipping: 'Capture d’écran', winver: 'À propos de Selene', installer: 'Installer Selene',
  };
  const label = (id) => {
    if (RENAMED[id]) return RENAMED[id];
    try {
      const m = JSON.parse(readFileSync(join(SHELL, 'apps', id, 'manifest.json'), 'utf8'));
      return typeof m.name === 'string' ? m.name : m.name.fr || m.name.en;
    } catch {
      return id;
    }
  };
  const block = (mode) => {
    const bg = mode === 'dark' ? '#0e131f' : '#f1f4f9';
    const fg = mode === 'dark' ? '#e6eaf2' : '#141a26';
    const fg2 = mode === 'dark' ? '#a9b2c5' : '#4a5468';
    return `<section style="background:${bg};color:${fg}">
      <header><img src="${pathToFileURL(join(SHELL, 'assets/aurora-logo.svg')).href}" width="56" height="56"><img src="${pathToFileURL(join(SHELL, 'assets/aurora-logo.svg')).href}" width="24" height="24"><img src="${pathToFileURL(join(SHELL, 'assets/aurora-logo.svg')).href}" width="16" height="16"><h1>Selene</h1><span style="color:${fg2}">Icônes des applications, 96 px, puis 48, 32, 24 et 16 px</span></header>
      <div class="grid">${ids.map((id) => `<figure><img src="${fileOf(id)}" width="96" height="96"><figcaption style="color:${fg2}">${label(id)}</figcaption></figure>`).join('')}</div>
      ${[48, 32, 24, 16].map((s) => `<div class="row">${ids.map((id) => `<img src="${fileOf(id)}" width="${s}" height="${s}">`).join('')}</div>`).join('')}
    </section>`;
  };
  const html = `<!doctype html><meta charset="utf-8"><style>
    @font-face { font-family: Inter; src: url(${fonts}/inter-latin-wght-normal.woff2) format('woff2'); font-weight: 100 900; }
    @font-face { font-family: Manrope; src: url(${fonts}/manrope-latin-wght-normal.woff2) format('woff2'); font-weight: 200 800; }
    body { margin: 0; font: 13px Inter, sans-serif; width: 1600px; }
    section { padding: 28px 40px 30px; }
    header { display: flex; align-items: center; gap: 14px; margin-bottom: 18px; }
    h1 { font: 600 26px Manrope, sans-serif; margin: 0 16px 0 4px; }
    .grid { display: grid; grid-template-columns: repeat(14, 1fr); gap: 10px 0; }
    figure { margin: 0; display: flex; flex-direction: column; align-items: center; gap: 4px; }
    figcaption { font-size: 11px; text-align: center; max-width: 106px; line-height: 1.25; }
    .row { display: flex; gap: 10px; align-items: center; margin-top: 14px; flex-wrap: wrap; }
  </style>${block('dark')}${block('light')}`;
  const tmp = join(ROOT, 'docs/design/.icons-sheet.html');
  writeFileSync(tmp, html);
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(tmp).href);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(200);
  mkdirSync(join(ROOT, 'docs/design'), { recursive: true });
  await page.screenshot({ path: join(ROOT, 'docs/design/icons-sheet.png'), fullPage: true });
  await browser.close();
  (await import('node:fs')).unlinkSync(tmp);
  console.log('wrote docs/design/icons-sheet.png');
}
