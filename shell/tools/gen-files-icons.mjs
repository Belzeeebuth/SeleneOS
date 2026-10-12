// Draws the Fichiers (Files) folder, file-type and drive icons in the Selene style: a folder, a pale page and a device
// tile, each with one muted Phosphor glyph. The design and the colours of every look live in
// renderer/core/file-icon-art.js; this writes its cold look (Nocturne: slate-blue folder) as the static SVG files.
// The other looks (neutral, warm, Contraste élevé) are drawn at run time by renderer/core/file-icons.js.
// Usage (from shell/):  node tools/gen-files-icons.mjs   -> renderer/apps/files/icons/*.svg
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FILE_ICONS, fileIconLook, fileIconSvg, contrast } from '../renderer/core/file-icon-art.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, '..', 'renderer', 'apps', 'files', 'icons');
const { glyphs } = JSON.parse(fs.readFileSync(path.join(here, '..', 'renderer', 'assets', 'icons', 'phosphor.json'), 'utf8'));
const glyphOf = (name, weight) => glyphs[name]?.[weight];

// every look: each file-type glyph stays >= 4.5:1 on its page
for (const key of ['cold', 'neutral', 'warm', 'contrast-dark', 'contrast-light']) {
  const look = fileIconLook(key);
  const low = Object.entries(look.types).filter(([, c]) => contrast(c, look.page.sheet) < (key === 'cold' ? 3 : 4.5));
  if (low.length) throw new Error(`${key}: low contrast on the page: ${low.map(([n, c]) => `${n} ${c} ${contrast(c, look.page.sheet).toFixed(2)}`).join(', ')}`);
}
const cold = fileIconLook('cold');
for (const name of Object.keys(FILE_ICONS)) fs.writeFileSync(path.join(OUT, `${name}.svg`), fileIconSvg(name, cold, glyphOf));
console.log(`wrote ${Object.keys(FILE_ICONS).length} icons to ${OUT}`);
