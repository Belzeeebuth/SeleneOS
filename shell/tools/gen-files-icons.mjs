// Draws the Fichiers (Files) folder, file-type and drive icons in the Selene style:
// a slate-blue folder and a pale page, each with one muted Phosphor glyph (regular weight).
// Usage (from shell/):  node tools/gen-files-icons.mjs   -> renderer/apps/files/icons/*.svg
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, '..', 'renderer', 'apps', 'files', 'icons');
const { glyphs } = JSON.parse(fs.readFileSync(path.join(here, '..', 'renderer', 'assets', 'icons', 'phosphor.json'), 'utf8'));

// A Phosphor glyph (256 box) placed in a size x size square centred on (cx, cy).
function glyph(name, cx, cy, size, color, weight = 'r') {
  const g = glyphs[name]?.[weight];
  if (!g) throw new Error(`missing glyph ${name}/${weight}`);
  const s = size / 256;
  return `<g transform="translate(${cx - size / 2} ${cy - size / 2}) scale(${s})" fill="${color}">${g}</g>`;
}
const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">\n${body}\n</svg>\n`;

// Folder: back tab + front panel. Mid-tone slate blue reads on the dark and light surfaces.
const FOLDER_BACK = '#5d7099';
const FOLDER_FRONT = '#8397c4';
const FOLDER_HI = '#a8b8dc';
const folder = (inner) =>
  svg(
    [
      `  <path d="M4.5 11.5a3 3 0 0 1 3-3h9.4c.9 0 1.7.3 2.3.9l2.6 2.5c.6.6 1.4.9 2.2.9h14.5a3 3 0 0 1 3 3v21.7a3 3 0 0 1-3 3h-31a3 3 0 0 1-3-3z" fill="${FOLDER_BACK}"/>`,
      `  <path d="M4.5 18.5a3 3 0 0 1 3-3h33a3 3 0 0 1 3 3v18a3 3 0 0 1-3 3h-33a3 3 0 0 1-3-3z" fill="${FOLDER_FRONT}"/>`,
      `  <path d="M7.5 16.1h33" stroke="${FOLDER_HI}" stroke-linecap="round" opacity=".9"/>`,
      inner ? '  ' + glyph(inner, 24, 28, 14, '#1b2336', 'b') : '',
    ]
      .filter(Boolean)
      .join('\n'),
  );

// Page: pale sheet with a folded corner and one coloured glyph.
const page = (inner, color) =>
  svg(
    [
      `  <path d="M12.5 4.5h16.2l10.8 10.8v26.2a2.5 2.5 0 0 1-2.5 2.5H12.5a2.5 2.5 0 0 1-2.5-2.5v-34.5a2.5 2.5 0 0 1 2.5-2.5z" fill="#eef1f7" stroke="#0b1020" stroke-opacity=".28"/>`,
      `  <path d="M28.7 4.6v8.4a2.4 2.4 0 0 0 2.4 2.4h8.3" fill="#d3dae7" stroke="#0b1020" stroke-opacity=".22" stroke-linejoin="round"/>`,
      inner ? '  ' + glyph(inner, 24.7, 29, 17, color) : '',
    ]
      .filter(Boolean)
      .join('\n'),
  );

// Device: rounded tile in the night-blue base of the app icons, glyph in silver.
const device = (inner, color = '#c9d3e6') =>
  svg(
    [
      `  <rect x="5" y="9" width="38" height="30" rx="7" fill="#26324d"/>`,
      `  <rect x="5.5" y="9.5" width="37" height="29" rx="6.5" fill="none" stroke="#c9d3e6" stroke-opacity=".22"/>`,
      '  ' + glyph(inner, 24, 24, 20, color),
    ].join('\n'),
  );

const icons = {
  folder: folder(null),
  'folder-desktop': folder('desktop'),
  'folder-documents': folder('file-text'),
  'folder-downloads': folder('download-simple'),
  'folder-home': folder('house-simple'),
  'folder-music': folder('music-notes'),
  'folder-pictures': folder('image'),
  'folder-videos': folder('film-strip'),
  file: page(null),
  'file-archive': page('file-zip', '#8a6f4a'),
  'file-audio': page('music-notes', '#7a62b8'),
  'file-code': page('code', '#3f62c0'),
  'file-disc': page('hard-drive', '#55637e'),
  'file-doc': page('text-align-left', '#3f62c0'),
  'file-exec': page('terminal-window', '#3b475e'),
  'file-font': page('text-aa', '#55637e'),
  'file-image': page('image', '#2f7d8c'),
  'file-mail': page('envelope-simple', '#4a6fb8'),
  'file-package': page('package', '#8a6f4a'),
  'file-pdf': page('file-pdf', '#b5483f'),
  'file-sheet': page('table', '#2f8059'),
  'file-slides': page('presentation', '#b0712a'),
  'file-text': page('text-align-left', '#55637e'),
  'file-video': page('film-strip', '#a8506f'),
  'file-web': page('globe-simple', '#3f62c0'),
  'drive-hdd': device('hard-drive'),
  'drive-optical': device('disc' in glyphs ? 'disc' : 'vinyl-record' in glyphs ? 'vinyl-record' : 'hard-drive'),
  'drive-system': device('hard-drives'),
  'drive-usb': device('usb'),
  gallery: device('images'),
  home: device('house-simple'),
  link: svg(`  <circle cx="24" cy="24" r="10" fill="#26324d"/>\n  ${glyph('link-simple', 24, 24, 14, '#c9d3e6', 'b')}`),
  'trash-full': device('trash'),
};
for (const [name, body] of Object.entries(icons)) fs.writeFileSync(path.join(OUT, `${name}.svg`), body);
console.log(`wrote ${Object.keys(icons).length} icons to ${OUT}`);
