// Selene app icons: the colours of every look and the SVG of one icon (docs/design/BRIEF.md, "App icons").
//
//   import { ICON_LOOKS, lookKey, iconLook, seleneIconSvg } from './app-icon-art.js';
//   lookKey({ style, ambiance, theme }) -> 'cold-dark' | 'neutral-light' | … | 'contrast-dark' | 'contrast-light'
//   iconLook(key)                       -> { base: [top, bottom], hues: { slot: hex }, edge?, flat? }
//   seleneIconSvg(id, glyph, look)      -> the SVG markup of one icon (glyph = an APP_GLYPHS entry of core/app-glyphs.js)
//
// The icon is always the same design: a rounded square on a base common to every app, one muted symbol with a slight
// vertical gradient, and a soft top highlight. Only the colours follow the ambiance and the mode, so the icons match
// the surfaces and the wallpaper of every style: night blue for cold (Nocturne), warm charcoal for neutral (Éclipse),
// plum for warm (Clair de lune). Each app keeps its own hue slot (`APP_GLYPHS[id].hue`), and every ambiance maps the
// nine slots to its own palette, so an app keeps its place in the palette across ambiances. Neutral and warm have no
// blue or cyan symbol (hue outside 185°–250°) and no blue cast in their base.
// Light mode keeps a dark tile, one step lighter than in dark mode: on the light bars and wallpapers a dark tile keeps
// its silhouette and the symbols their contrast (a light tile vanishes into a white bar). Contraste élevé draws the
// style's own colours: a black tile, a white edge and a white symbol (dark); the reverse in light mode.
//
// Shared by tools/gen-app-icons.mjs (the static apps/<id>/icon.svg files are the cold dark look, byte for byte) and
// core/packs.js (the "selene" icon pack, drawn at run time for the current look). Every symbol is >= 4.5:1 on its
// base (checked by the generator). This module is the only place with icon colours: no hex values elsewhere.

export const HUE_SLOTS = ['silver', 'blue', 'lavender', 'sage', 'teal', 'amber', 'sand', 'rose', 'terra'];

export const ICON_LOOKS = {
  // Nocturne: night-blue base, muted cold palette (the original icons)
  cold: {
    dark: ['#222c45', '#161d30'],
    light: ['#2a3653', '#1c243b'],
    hues: { silver: '#c5cee0', blue: '#93abdb', lavender: '#ae9fdf', sage: '#94c3a7', teal: '#86bcc6', amber: '#dcb77e', sand: '#cbbd9d', rose: '#d89ca4', terra: '#d99a80' },
  },
  // Éclipse: warm charcoal / umber base; stone, bone, heather, olive, moss, amber, sand, clay and copper symbols
  neutral: {
    dark: ['#2b2724', '#1b1917'],
    light: ['#35302b', '#24201d'],
    hues: { silver: '#c6c0b6', blue: '#ebe0ca', lavender: '#c9a3bd', sage: '#b7b07c', teal: '#a3b494', amber: '#e3b46c', sand: '#cdb995', rose: '#d6a09a', terra: '#d4876a' },
  },
  // Clair de lune: plum / aubergine base; cream, lavender, mauve, sage, eucalyptus, honey, oat, rose and peach symbols
  warm: {
    dark: ['#3a2839', '#251a25'],
    light: ['#46304a', '#2e1f30'],
    hues: { silver: '#ebe0d4', blue: '#c0a8ea', lavender: '#d3a5d0', sage: '#b2c59c', teal: '#9fc3b0', amber: '#e3bf88', sand: '#d6c4ab', rose: '#e3a3b5', terra: '#eaa28e' },
  },
  // Contraste élevé (styles/contrast.css: white on black, black on white): flat colours and a solid edge
  contrast: {
    dark: { base: ['#000000', '#000000'], ink: '#ffffff', edge: '#ffffff' },
    light: { base: ['#ffffff', '#ffffff'], ink: '#000000', edge: '#000000' },
  },
};

const AMBIANCES = ['cold', 'neutral', 'warm'];
/** The look of the icons for a style, an ambiance and a mode. */
export function lookKey({ style, ambiance, theme } = {}) {
  const mode = theme === 'light' ? 'light' : 'dark';
  if (style === 'contrast') return `contrast-${mode}`;
  return `${AMBIANCES.includes(ambiance) ? ambiance : 'cold'}-${mode}`;
}
/** { base: [top, bottom], hues, edge?, ink?, flat } of a look key (unknown keys: cold dark). */
export function iconLook(key) {
  const [amb, mode] = String(key || '').split('-');
  if (amb === 'contrast') {
    const c = ICON_LOOKS.contrast[mode === 'light' ? 'light' : 'dark'];
    return { base: c.base, hues: Object.fromEntries(HUE_SLOTS.map((s) => [s, c.ink])), edge: c.edge, flat: true };
  }
  const l = ICON_LOOKS[amb] || ICON_LOOKS.cold;
  return { base: l[mode === 'light' ? 'light' : 'dark'], hues: l.hues, flat: false };
}

// ------------------------------------------------------------------ colour helpers
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const hex = (a) => `#${a.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;
export const mix = (a, b, t) => hex(rgb(a).map((v, i) => v + (rgb(b)[i] - v) * t));

/** The cold slot of a colour of the original palette (app-glyphs.js tables written before `hue` existed). */
export const slotOfColor = (c) => HUE_SLOTS.find((s) => ICON_LOOKS.cold.hues[s] === String(c).toLowerCase()) || 'silver';

// ------------------------------------------------------------------ SVG
/**
 * The SVG of one Selene icon.
 *   id:    prefix of the gradient ids ('browser', 'special-thispc', 'app-default')
 *   glyph: { vb: 256 (Phosphor) | 48 (logo), inner, hue }
 *   look:  iconLook(key)
 * The SVG carries a size media query: at 26 px and below the hairline is dropped and the symbol grows (36/48 instead of
 * 32/48; 38/48 at 18 px and below), so 16 and 24 px icons stay legible.
 */
export function seleneIconSvg(id, glyph, look = iconLook('cold-dark')) {
  const logo = glyph.vb === 48;
  const color = look.hues[glyph.hue] || look.hues.silver;
  const [top, bottom] = look.base;
  const fill = look.flat ? color : `url(#${id}-f)`;
  // the logo is drawn on the 48 grid: scaled to the same optical size as the 256-grid glyphs
  const inner = logo ? glyph.inner.replace(/<path d="([^"]*)"\/>/g, `<path d="$1" fill="${fill}"/>`) : glyph.inner;
  const sym = logo
    ? `<g class="s" transform="translate(10.8 8.6) scale(.6)" fill="${fill}">${inner}</g>`
    : `<g class="s" transform="translate(8 8) scale(.125)" fill="${fill}">${inner}</g>`;
  const small = logo ? 'translate(8.6px,6px) scale(.7)' : 'translate(6px,6px) scale(.140625)';
  const tiny = logo ? 'translate(7.3px,4.5px) scale(.76)' : 'translate(5px,5px) scale(.1484)';
  if (look.flat) {
    // Contraste élevé: flat tile, a 2-unit edge in the ink colour (1 px at 24 px), no highlight
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">
<!-- Selene app icon, high contrast (core/app-icon-art.js). Symbol: Phosphor Icons 2.1.1, MIT. -->
<style>@media (max-width:26px){.s{transform:${small}}}@media (max-width:18px){.s{transform:${tiny}}}</style>
<rect x="3" y="3" width="42" height="42" rx="9" fill="${top}" stroke="${look.edge}" stroke-width="2"/>
${sym}
</svg>
`;
  }
  const light = mix(color, '#ffffff', 0.32);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">
<!-- Selene app icon (tools/gen-app-icons.mjs). Symbol: Phosphor Icons 2.1.1, MIT (assets/icons/LICENSE-phosphor.txt). -->
<style>@media (max-width:26px){.hl{display:none}.s{transform:${small}}}@media (max-width:18px){.s{transform:${tiny}}}</style>
<defs>
<linearGradient id="${id}-b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient>
<linearGradient id="${id}-h" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".2"/><stop offset=".5" stop-color="#fff" stop-opacity=".06"/><stop offset="1" stop-color="#fff" stop-opacity=".03"/></linearGradient>
<linearGradient id="${id}-f" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${light}"/><stop offset="1" stop-color="${color}"/></linearGradient>
</defs>
<rect x="2" y="2" width="44" height="44" rx="9.7" fill="url(#${id}-b)"/>
<rect class="hl" x="2.5" y="2.5" width="43" height="43" rx="9.2" fill="none" stroke="url(#${id}-h)"/>
${sym}
</svg>
`;
}
