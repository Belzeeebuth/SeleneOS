// Phosphor icons (MIT, @phosphor-icons/core 2.1.1) packed in assets/icons/phosphor.json by tools/vendor-icons.mjs.
//   icon('folder-simple')                         -> <span class="icon">…regular svg…</span>
//   icon('folder', { filled: true, size: 20, class: 'x' })   old Fluent names still work through aliases.json
//   icon('gear-six', { weight: 'bold' })          weight: 'regular' | 'fill' | 'bold'
//   hasIcon('wifi_1'), resolveIcon('wifi_1') -> { glyph: 'wifi-high', weight: 'regular' }
// Name forms: a Phosphor name ('folder-simple', 'folder-simple-fill', 'caret-down-bold'), or an old Fluent name
// ('folder', 'folder_filled') mapped in assets/icons/aliases.json. Filled / active states use the fill weight;
// icons drawn at 12 px or less use the bold weight so their 16-unit strokes stay visible.
// Unknown names render a neutral dashed circle (and warn once).
const FALLBACK = 'circle-dashed';
const WEIGHT_KEY = { regular: 'r', fill: 'f', bold: 'b' };
let GLYPHS = {};
let ALIASES = {};
let VB = 256;
const warned = new Set();

export async function loadIcons() {
  try {
    const data = await (await fetch('app://shell/assets/icons/phosphor.json')).json();
    GLYPHS = data.glyphs || {};
    ALIASES = data.aliases || {};
    VB = data.v || 256;
  } catch (err) {
    console.error('[icons] failed to load', err);
  }
}

/** { glyph, weight|null } for a name, or null when it is unknown. */
export function resolveIcon(name) {
  let n = String(name || '');
  let weight = null;
  const fl = /^(.+)_filled$/.exec(n);
  if (fl) {
    n = fl[1];
    weight = 'fill';
  }
  const alias = ALIASES[n];
  if (alias) {
    const [glyph, w] = alias.split(':');
    return GLYPHS[glyph] ? { glyph, weight: weight || w || null } : null;
  }
  if (GLYPHS[n]) return { glyph: n, weight };
  const suffixed = /^(.+)-(fill|bold|regular)$/.exec(n);
  if (suffixed && GLYPHS[suffixed[1]]) return { glyph: suffixed[1], weight: suffixed[2] };
  return null;
}

export function hasIcon(name) {
  return !!resolveIcon(name);
}

/** Inner markup (paths) and viewBox size of a glyph; the paths take their colour from `fill` (currentColor). */
export function iconInner(name, { filled = false, weight = null, size = 0 } = {}) {
  let r = resolveIcon(name);
  if (!r) {
    // Before loadIcons() resolves every name is unknown: only warn once the set is there.
    if (GLYPHS[FALLBACK] && !warned.has(name)) {
      warned.add(name);
      console.warn(`[icons] unknown icon "${name}"`);
    }
    r = { glyph: FALLBACK, weight: null };
  }
  const e = GLYPHS[r.glyph];
  if (!e) return { vb: VB, inner: '' }; // not loaded yet
  const w = weight || r.weight || (filled ? 'fill' : size && size <= 12 ? 'bold' : 'regular');
  return { vb: VB, inner: e[WEIGHT_KEY[w] || 'r'] || e.r || '' };
}

export function iconSvg(name, opts = {}) {
  const { vb, inner } = iconInner(name, opts);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${vb} ${vb}" fill="currentColor" aria-hidden="true">${inner}</svg>`;
}

export function icon(name, opts = {}) {
  const span = document.createElement('span');
  span.className = `icon${opts.class ? ` ${opts.class}` : ''}`;
  if (opts.size) {
    span.style.width = `${opts.size}px`;
    span.style.height = `${opts.size}px`;
  }
  if (opts.color) span.style.color = opts.color;
  span.innerHTML = iconSvg(name, opts);
  span.dataset.icon = name;
  return span;
}
