// Packs Fluent UI System Icons (MIT, @fluentui/svg-icons) into one JSON map used by
// renderer/core/icons.js:  { "<name>": { "r": "<svg inner regular>", "f": "<svg inner filled>" } }
// Names are the Fluent base names, e.g. "folder", "arrow_left", "document_text".
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..', 'node_modules', '@fluentui', 'svg-icons', 'icons');
const out = path.join(here, '..', 'renderer', 'assets', 'icons', 'fluent.json');
const map = {};
for (const file of fs.readdirSync(src).sort()) {
  const m = /^(.+)_(20|24)_(regular|filled)\.svg$/.exec(file);
  if (!m) continue;
  const [, name, size, style] = m;
  const key = style === 'regular' ? 'r' : 'f';
  const entry = (map[name] ||= {});
  // prefer 20px; fall back to 24px when no 20px variant exists
  if (entry[key] && entry[`${key}s`] === '20') continue;
  if (entry[key] && size === '24') continue;
  const svg = fs.readFileSync(path.join(src, file), 'utf8');
  const inner = svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
  entry[key] = inner;
  entry[`${key}s`] = size;
}
for (const e of Object.values(map)) {
  if (e.rs === '24' || e.fs === '24') e.v = 24;
  delete e.rs;
  delete e.fs;
}
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(map));
console.log(`wrote ${Object.keys(map).length} icons to ${path.relative(process.cwd(), out)} (${(fs.statSync(out).size / 1e6).toFixed(1)} MB)`);
