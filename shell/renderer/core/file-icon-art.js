// Fichiers icons (folders, file types, drives): their colours in every look and the SVG of one icon.
//
//   import { FILE_ICONS, fileLookKey, fileIconLook, fileIconSvg, fileTypeTints } from './file-icon-art.js';
//   fileLookKey(lookKey)          -> 'cold' | 'neutral' | 'warm' | 'contrast-dark' | 'contrast-light'
//   fileIconLook(key)             -> { folder, page, device, types, flat }   (colours of one look)
//   fileIconSvg(name, look, glyphOf) -> the SVG markup of one icon (name = a FILE_ICONS key;
//                                       glyphOf(phosphorName, 'r' | 'b') -> the glyph's inner paths)
//   fileTypeTints(key, mode)      -> { dir, doc, xls, … } colours of the Phosphor file-type glyphs (.ft-*: desktop,
//                                    Lanceur search and recommendations)
//
// One design for every look: a folder (back tab, front panel, one dark glyph), a pale page with a folded corner and one
// coloured glyph, and a rounded device tile with a light glyph. Only the colours change, and they come from the app
// icon palette (core/app-icon-art.js), so the Fichiers icons match the app icons of the same ambiance:
//   cold (Nocturne)        the original slate-blue folder and cool page (the static icons/*.svg files, byte for byte)
//   neutral (Éclipse)      amber folder, warm-white page, warm-charcoal device tile; stone, bone, olive, moss, clay…
//   warm (Clair de lune)   mauve folder, cream page, plum device tile; lavender, rose, peach, sage, honey…
//   contrast               Contraste élevé: flat black and white (reversed in light mode), solid 2-unit outlines
// Neutral and warm have no blue or cyan. They do not depend on the mode (the icons read on dark and light surfaces,
// as the cold ones do); Contraste élevé follows the mode. Every file-type glyph is >= 4.5:1 on its page.
//
// Shared by tools/gen-files-icons.mjs (writes the cold look to renderer/apps/files/icons/*.svg) and core/file-icons.js
// (maps those files to the current look at run time). No icon colour lives anywhere else.
import { ICON_LOOKS, mix } from './app-icon-art.js';

// shape, Phosphor glyph and palette slot (core/app-icon-art.js HUE_SLOTS) of every icon. `icon:` keeps the glyph
// names visible to tools/vendor-icons.mjs, so they stay packed in phosphor.json.
export const FILE_ICONS = {
  folder: { shape: 'folder' },
  'folder-desktop': { shape: 'folder', icon: 'desktop' },
  'folder-documents': { shape: 'folder', icon: 'file-text' },
  'folder-downloads': { shape: 'folder', icon: 'download-simple' },
  'folder-home': { shape: 'folder', icon: 'house-simple' },
  'folder-music': { shape: 'folder', icon: 'music-notes' },
  'folder-pictures': { shape: 'folder', icon: 'image' },
  'folder-videos': { shape: 'folder', icon: 'film-strip' },
  file: { shape: 'page' },
  'file-archive': { shape: 'page', icon: 'file-zip', slot: 'sand' },
  'file-audio': { shape: 'page', icon: 'music-notes', slot: 'lavender' },
  'file-code': { shape: 'page', icon: 'code', slot: 'blue' },
  'file-disc': { shape: 'page', icon: 'hard-drive', slot: 'silver' },
  'file-doc': { shape: 'page', icon: 'text-align-left', slot: 'blue' },
  'file-exec': { shape: 'page', icon: 'terminal-window', slot: 'silver', ink: 0.07 },
  'file-font': { shape: 'page', icon: 'text-aa', slot: 'silver' },
  'file-image': { shape: 'page', icon: 'image', slot: 'teal' },
  'file-mail': { shape: 'page', icon: 'envelope-simple', slot: 'blue' },
  'file-package': { shape: 'page', icon: 'package', slot: 'sand' },
  'file-pdf': { shape: 'page', icon: 'file-pdf', slot: 'terra' },
  'file-sheet': { shape: 'page', icon: 'table', slot: 'sage' },
  'file-slides': { shape: 'page', icon: 'presentation', slot: 'amber' },
  'file-text': { shape: 'page', icon: 'text-align-left', slot: 'silver' },
  'file-video': { shape: 'page', icon: 'film-strip', slot: 'rose' },
  'file-web': { shape: 'page', icon: 'globe-simple', slot: 'blue' },
  'drive-hdd': { shape: 'device', icon: 'hard-drive' },
  'drive-optical': { shape: 'device', icon: 'vinyl-record' },
  'drive-system': { shape: 'device', icon: 'hard-drives' },
  'drive-usb': { shape: 'device', icon: 'usb' },
  gallery: { shape: 'device', icon: 'images' },
  home: { shape: 'device', icon: 'house-simple' },
  link: { shape: 'link', icon: 'link-simple' },
  'trash-full': { shape: 'device', icon: 'trash' },
};

// The cold look: the original Fichiers colours (slate-blue folder), kept as they were drawn.
const COLD = {
  folder: { back: '#5d7099', front: '#8397c4', hi: '#a8b8dc', ink: '#1b2336' },
  page: { sheet: '#eef1f7', fold: '#d3dae7', line: '#0b1020' },
  device: { tile: '#26324d', ink: '#c9d3e6' },
  types: {
    'file-archive': '#8a6f4a', 'file-audio': '#7a62b8', 'file-code': '#3f62c0', 'file-disc': '#55637e', 'file-doc': '#3f62c0',
    'file-exec': '#3b475e', 'file-font': '#55637e', 'file-image': '#2f7d8c', 'file-mail': '#4a6fb8', 'file-package': '#8a6f4a',
    'file-pdf': '#b5483f', 'file-sheet': '#2f8059', 'file-slides': '#b0712a', 'file-text': '#55637e', 'file-video': '#a8506f',
    'file-web': '#3f62c0',
  },
};
// The folder's palette slot in each ambiance (cold: the slate blue above)
export const FOLDER_SLOT = { cold: 'blue', neutral: 'amber', warm: 'lavender' };
// Slots a page glyph takes instead, per ambiance. Neutral's "blue" slot is bone, which on a pale page cannot be told
// apart from stone (plain text, same glyph as a document): documents, code, web pages and mail take heather instead.
const PAGE_SLOT = { neutral: { blue: 'lavender' } };
const pageSlot = (amb, name) => PAGE_SLOT[amb]?.[FILE_ICONS[name].slot] || FILE_ICONS[name].slot;

// ------------------------------------------------------------------ colour helpers
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const hex = (a) => `#${a.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;
const lin = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
/** WCAG relative luminance of a '#rrggbb' colour */
export const luminance = (h) => {
  const [r, g, b] = rgb(h).map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const contrast = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
/** The colour mixed toward `toward` (or white when lighter is needed) until it reaches the luminance `L`. */
function shade(c, L, toward) {
  const target = luminance(c) > L ? toward : '#ffffff';
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const t = (lo + hi) / 2;
    if (luminance(mix(c, target, t)) > L === (target !== '#ffffff')) lo = t;
    else hi = t;
  }
  return mix(c, target, (lo + hi) / 2);
}
/**
 * An "ink" of a pastel palette colour: same hue, saturation raised (the muted symbol colours are drawn for dark tiles;
 * on a pale page a glyph needs more colour to keep its identity), value lowered until the luminance is `L`.
 * HSV keeps the hue exactly, so a slot never drifts toward blue.
 */
function ink(c, L, boost = 2.1, cap = 0.72) {
  const [r, g, b] = rgb(c).map((v) => v / 255);
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const d = mx - mn;
  let h = 0;
  if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h + 6) % 6;
  const s = Math.min(cap, (mx ? d / mx : 0) * boost);
  const at = (v) => {
    const C = v * s;
    const X = C * (1 - Math.abs((h % 2) - 1));
    const m = v - C;
    const k = Math.floor(h);
    const [R, G, B] = [[C, X, 0], [X, C, 0], [0, C, X], [0, X, C], [X, 0, C], [C, 0, X]][k];
    return hex([R + m, G + m, B + m].map((x) => x * 255));
  };
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const v = (lo + hi) / 2;
    if (luminance(at(v)) < L) lo = v;
    else hi = v;
  }
  return at((lo + hi) / 2);
}

// ------------------------------------------------------------------ looks
/** The Fichiers look of an app-icon look key (core/app-icon-art.js lookKey): cold, neutral and warm ignore the mode. */
export function fileLookKey(key) {
  const [amb, mode] = String(key || '').split('-');
  if (amb === 'contrast') return `contrast-${mode === 'light' ? 'light' : 'dark'}`;
  return ['neutral', 'warm'].includes(amb) ? amb : 'cold';
}

// luminances of the cold design, matched by the derived looks so the silhouettes read the same on every surface
const L_FOLDER = { back: 0.16, front: 0.31, hi: 0.47 };
const L_GLYPH = 0.14; // file-type glyph on the page: >= 4.5:1
const looks = new Map();
/** { folder: { back, front, hi, ink }, page: { sheet, fold, line }, device: { tile, ink }, types: { name: colour }, flat } */
export function fileIconLook(key) {
  key = fileLookKey(key);
  if (looks.has(key)) return looks.get(key);
  let look;
  if (key === 'cold') look = { ...COLD, flat: false };
  else if (key.startsWith('contrast')) {
    const c = ICON_LOOKS.contrast[key === 'contrast-light' ? 'light' : 'dark'];
    const bg = c.base[0];
    look = {
      folder: { back: c.ink, front: c.ink, hi: c.ink, ink: bg },
      page: { sheet: bg, fold: bg, line: c.ink },
      device: { tile: bg, ink: c.ink },
      types: Object.fromEntries(Object.keys(COLD.types).map((n) => [n, c.ink])),
      flat: true,
    };
  } else {
    const L = ICON_LOOKS[key];
    const [top, bottom] = L.dark;
    const f = L.hues[FOLDER_SLOT[key]];
    look = {
      folder: { back: shade(f, L_FOLDER.back, bottom), front: shade(f, L_FOLDER.front, bottom), hi: shade(f, L_FOLDER.hi, bottom), ink: bottom },
      page: { sheet: mix(L.hues.silver, '#ffffff', 0.72), fold: mix(L.hues.silver, '#ffffff', 0.3), line: mix(bottom, '#000000', 0.5) },
      device: { tile: mix(top, L.hues.silver, 0.04), ink: L.hues.silver },
      types: Object.fromEntries(Object.keys(COLD.types).map((n) => [n, ink(L.hues[pageSlot(key, n)], FILE_ICONS[n].ink ?? L_GLYPH)])),
      flat: false,
    };
  }
  looks.set(key, look);
  return look;
}

// ------------------------------------------------------------------ SVG
// A Phosphor glyph (256 box) placed in a size x size square centred on (cx, cy).
function glyph(inner, cx, cy, size, color) {
  const s = size / 256;
  return `<g transform="translate(${cx - size / 2} ${cy - size / 2}) scale(${s})" fill="${color}">${inner}</g>`;
}
const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">\n${body}\n</svg>\n`;
const FOLDER_BACK = 'M4.5 11.5a3 3 0 0 1 3-3h9.4c.9 0 1.7.3 2.3.9l2.6 2.5c.6.6 1.4.9 2.2.9h14.5a3 3 0 0 1 3 3v21.7a3 3 0 0 1-3 3h-31a3 3 0 0 1-3-3z';
const FOLDER_FRONT = 'M4.5 18.5a3 3 0 0 1 3-3h33a3 3 0 0 1 3 3v18a3 3 0 0 1-3 3h-33a3 3 0 0 1-3-3z';
const PAGE = 'M12.5 4.5h16.2l10.8 10.8v26.2a2.5 2.5 0 0 1-2.5 2.5H12.5a2.5 2.5 0 0 1-2.5-2.5v-34.5a2.5 2.5 0 0 1 2.5-2.5z';
const FOLD = 'M28.7 4.6v8.4a2.4 2.4 0 0 0 2.4 2.4h8.3';

/** The SVG of one Fichiers icon in a look (fileIconLook). glyphOf(name, 'r' | 'b') returns a Phosphor glyph's paths. */
export function fileIconSvg(name, look, glyphOf) {
  const def = FILE_ICONS[name];
  if (!def) throw new Error(`unknown Fichiers icon ${name}`);
  const g = (weight) => {
    const inner = glyphOf(def.icon, weight);
    if (!inner) throw new Error(`missing glyph ${def.icon}/${weight}`);
    return inner;
  };
  const { flat } = look;
  if (def.shape === 'folder') {
    const F = look.folder;
    return svg(
      [
        `  <path d="${FOLDER_BACK}" fill="${F.back}"/>`,
        flat ? `  <path d="${FOLDER_FRONT}" fill="${F.front}" stroke="${F.ink}" stroke-width="1.5"/>` : `  <path d="${FOLDER_FRONT}" fill="${F.front}"/>`,
        flat ? '' : `  <path d="M7.5 16.1h33" stroke="${F.hi}" stroke-linecap="round" opacity=".9"/>`,
        def.icon ? '  ' + glyph(g('b'), 24, 28, 14, F.ink) : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }
  if (def.shape === 'page') {
    const P = look.page;
    return svg(
      [
        flat
          ? `  <path d="${PAGE}" fill="${P.sheet}" stroke="${P.line}" stroke-width="2"/>`
          : `  <path d="${PAGE}" fill="${P.sheet}" stroke="${P.line}" stroke-opacity=".28"/>`,
        flat
          ? `  <path d="${FOLD}" fill="${P.fold}" stroke="${P.line}" stroke-width="2" stroke-linejoin="round"/>`
          : `  <path d="${FOLD}" fill="${P.fold}" stroke="${P.line}" stroke-opacity=".22" stroke-linejoin="round"/>`,
        def.icon ? '  ' + glyph(g('r'), 24.7, 29, 17, look.types[name]) : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }
  const D = look.device;
  if (def.shape === 'link') {
    return svg(
      flat
        ? `  <circle cx="24" cy="24" r="10" fill="${D.tile}" stroke="${D.ink}" stroke-width="2"/>\n  ${glyph(g('b'), 24, 24, 14, D.ink)}`
        : `  <circle cx="24" cy="24" r="10" fill="${D.tile}"/>\n  ${glyph(g('b'), 24, 24, 14, D.ink)}`,
    );
  }
  return svg(
    [
      `  <rect x="5" y="9" width="38" height="30" rx="7" fill="${D.tile}"/>`,
      flat
        ? `  <rect x="6" y="10" width="36" height="28" rx="6" fill="none" stroke="${D.ink}" stroke-width="2"/>`
        : `  <rect x="5.5" y="9.5" width="37" height="29" rx="6.5" fill="none" stroke="${D.ink}" stroke-opacity=".22"/>`,
      '  ' + glyph(g('r'), 24, 24, 20, D.ink),
    ].join('\n'),
  );
}

// ------------------------------------------------------------------ Phosphor file-type glyphs (.ft-* classes)
// The desktop, the Lanceur's search results and its recommendations draw files with a Phosphor glyph tinted by a
// .ft-* class (core/shell.css). Neutral and warm tint them from the same slots as the Fichiers pages: the palette
// colour itself in dark mode (it reads on dark glass and wallpapers, like the app icon symbols), the page ink in light
// mode. Cold keeps shell.css as it is (null).
const FT_SLOT = { doc: 'file-doc', xls: 'file-sheet', ppt: 'file-slides', pdf: 'file-pdf', img: 'file-image', audio: 'file-audio', video: 'file-video', zip: 'file-archive', code: 'file-code' };
export function fileTypeTints(key, mode = 'dark') {
  key = fileLookKey(key);
  if (key !== 'neutral' && key !== 'warm') return null;
  const L = ICON_LOOKS[key];
  const look = fileIconLook(key);
  const out = {};
  for (const [ft, n] of Object.entries(FT_SLOT)) out[ft] = mode === 'light' ? look.types[n] : L.hues[pageSlot(key, n)];
  out.dir = mode === 'light' ? look.folder.back : L.hues[FOLDER_SLOT[key]];
  // desktop (on the wallpaper): folders, plain pages (white sheet, coloured outline) and the shortcut badge (white square)
  // (Clair de lune light: the mauve front panel is ~1.9:1 on the lavender wallpaper, so the darker back panel, ~3.3:1;
  // Éclipse light keeps its amber front panel, ~2.5:1 on its pale stone, the back one turns it muddy)
  out.folder = mode === 'light' ? (key === 'warm' ? look.folder.back : look.folder.front) : L.hues[FOLDER_SLOT[key]];
  out.page = look.types['file-text'];
  out.link = look.types['file-doc'];
  return out;
}
