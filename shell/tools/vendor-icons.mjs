// Packs the Phosphor icons (MIT, @phosphor-icons/core 2.1.1) the shell needs into one JSON file used by
// renderer/core/icons.js:
//   renderer/assets/icons/phosphor.json = {
//     v: 256,                                     // viewBox size of every glyph
//     aliases: { "<old Fluent name>": "<phosphor name>[:regular|fill|bold]" },   // copy of aliases.json
//     glyphs:  { "<phosphor name>": { r: "<svg inner regular>", f: "<inner fill>", b: "<inner bold>" } }
//   }
// Sources: renderer/assets/icons/aliases.json (hand-edited: old Fluent name -> Phosphor name), the EXTRA list below,
// and every Phosphor name the code passes directly to icon() / iconSvg() / `icon: '…'` (found by scanIconNames).
//
//   node tools/vendor-icons.mjs [path/to/phosphor/assets]      (default: $PHOSPHOR_ASSETS or node_modules)
//
// Only the glyphs in use are packed (regular + fill + bold), so the file stays small.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SHELL = path.join(here, '..');
export const ICON_DIR = path.join(SHELL, 'renderer', 'assets', 'icons');

// Glyphs packed even when no call site uses them yet: the fallback, window controls and a few the redesign needs.
export const EXTRA = [
  'circle-dashed', // fallback for unknown names (icons.js)
  'x', 'minus', 'square', 'copy-simple', 'arrows-out-simple', 'arrows-in-simple', // window controls
  'moon', 'moon-stars', 'star-four', 'sun', 'sun-dim', 'circle-half', // theme / night
  'magnifying-glass', 'house-simple', 'folder-simple', 'desktop', 'monitor', 'storefront', 'squares-four',
  'lock-simple', 'lock-simple-open', 'user-circle', 'power', 'arrow-clockwise', 'sign-out',
  'list', 'dots-three', 'dots-three-vertical', 'caret-down', 'caret-up', 'caret-left', 'caret-right',
  'check', 'check-circle', 'info', 'warning', 'warning-circle', 'question', 'bell', 'bell-slash', 'gear-six',
  'wifi-high', 'wifi-medium', 'wifi-low', 'wifi-none', 'wifi-slash', 'wifi-x', 'network', 'network-slash',
  'speaker-high', 'speaker-low', 'speaker-none', 'speaker-slash', 'speaker-x', 'battery-full', 'battery-charging',
  'bluetooth', 'airplane', 'eye', 'eye-slash', 'text-aa', 'palette', 'paint-brush', 'image', 'images',
];

// A literal is an icon name when it is an alias key or a Phosphor-style name (kebab-case) passed at an icon call site.
const CALL_RE = [
  /\bicon\(\s*['"`]([a-z][a-z0-9_-]*)['"`]/g, // icon('name'…), app.icon('name'), pc.icon('name')
  /\biconSvg\(\s*['"`]([a-z][a-z0-9_-]*)['"`]/g,
  /\bicon:\s*['"`]([a-z][a-z0-9_-]*)['"`]/g, // { icon: 'name' }
];

function listFiles() {
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'assets', 'out'].includes(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(m?js|json|html)$/.test(e.name)) files.push(p);
    }
  };
  walk(path.join(SHELL, 'renderer'));
  walk(path.join(SHELL, 'main'));
  const catalog = path.join(SHELL, '..', 'rootfs', 'usr', 'share', 'aurora', 'store', 'catalog.json');
  if (fs.existsSync(catalog)) files.push(catalog);
  return files;
}

// Names built at run time ('battery_' + level, …): listed explicitly.
export const DYNAMIC = [
  ...Array.from({ length: 11 }, (_, i) => `battery_${i}`),
  ...Array.from({ length: 11 }, (_, i) => `battery_charge_${i}`),
  'wifi_1', 'wifi_2', 'wifi_3', 'wifi_4', 'speaker_0', 'speaker_1', 'speaker_2', 'speaker_mute',
];

/**
 * Every icon name the code uses.
 *   legacy: string literals that are old Fluent names (dictionary: `fluentNames`, else the alias keys) + DYNAMIC
 *   direct: names at icon call sites (icon('x'), iconSvg('x'), icon: 'x'), Fluent or Phosphor style
 */
export function scanIconNames({ fluentNames = null } = {}) {
  const aliases = JSON.parse(fs.readFileSync(path.join(ICON_DIR, 'aliases.json'), 'utf8'));
  const dict = fluentNames || new Set(Object.keys(aliases));
  const legacy = new Set(DYNAMIC);
  const direct = new Map(); // name -> first file
  for (const f of listFiles()) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/['"`]([a-z][a-z0-9_]*)['"`]/g)) if (dict.has(m[1])) legacy.add(m[1]);
    for (const re of CALL_RE) for (const m of src.matchAll(re)) if (!direct.has(m[1])) direct.set(m[1], path.relative(SHELL, f));
  }
  return { legacy, direct, aliases };
}

const splitAlias = (v) => {
  const [name, weight = null] = String(v).split(':');
  return { name, weight };
};

function readGlyph(assets, weight, name) {
  const file = path.join(assets, weight, weight === 'regular' ? `${name}.svg` : `${name}-${weight}.svg`);
  if (!fs.existsSync(file)) return null;
  const svg = fs.readFileSync(file, 'utf8');
  if (!/viewBox="0 0 256 256"/.test(svg)) throw new Error(`unexpected viewBox in ${file}`);
  return svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').trim();
}

function build(assets) {
  const { direct, aliases } = scanIconNames();
  const want = new Set(EXTRA);
  for (const v of Object.values(aliases)) want.add(splitAlias(v).name);
  for (const n of direct.keys()) {
    const base = n.replace(/-(fill|bold)$/, '');
    if (!aliases[n] && fs.existsSync(path.join(assets, 'regular', `${base}.svg`))) want.add(base);
  }
  const glyphs = {};
  const missing = [];
  for (const name of [...want].sort()) {
    const r = readGlyph(assets, 'regular', name);
    if (!r) {
      missing.push(name);
      continue;
    }
    glyphs[name] = { r, f: readGlyph(assets, 'fill', name) || r, b: readGlyph(assets, 'bold', name) || r };
  }
  if (missing.length) throw new Error(`unknown Phosphor glyphs: ${missing.join(', ')}`);
  const unresolved = Object.entries(aliases).filter(([, v]) => !glyphs[splitAlias(v).name]);
  if (unresolved.length) throw new Error(`aliases without a glyph: ${unresolved.map(([k]) => k).join(', ')}`);
  const out = path.join(ICON_DIR, 'phosphor.json');
  fs.writeFileSync(out, JSON.stringify({ v: 256, aliases, glyphs }));
  const license = path.join(assets, '..', 'LICENSE');
  if (fs.existsSync(license)) fs.copyFileSync(license, path.join(ICON_DIR, 'LICENSE-phosphor.txt'));
  console.log(`wrote ${Object.keys(glyphs).length} glyphs, ${Object.keys(aliases).length} aliases to ${path.relative(process.cwd(), out)} (${(fs.statSync(out).size / 1e3).toFixed(0)} kB)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const assets = process.argv[2] || process.env.PHOSPHOR_ASSETS || path.join(SHELL, 'node_modules', '@phosphor-icons', 'core', 'assets');
  if (!fs.existsSync(path.join(assets, 'regular'))) {
    console.error(`Phosphor assets not found in ${assets} (pass the path to @phosphor-icons/core/assets)`);
    process.exit(1);
  }
  build(assets);
}
