// Finishes ("finitions"): the material of the whole shell, on top of the visual style (shape: Nocturne, Éclipse,
// Clair de lune, Contraste élevé) and the ambiance (colour mood). docs/PERSONALIZATION.md §1.1.
//   halo   : Mica-like tinted glass (windows show a pre-blurred copy of the wallpaper), colourful free-shape icons,
//            petal-halo wallpapers                                            (docs/design/mockups-mix/halo)
//   prisme : frosted glass with a faint grain and stronger colour bleed, glossy two-tone icons, aurora-veil
//            wallpapers with a small moon                                     (docs/design/mockups-mix/prisme)
//   sobre  : the matte Selene look of 2026-10-11: flat opaque windows, muted icons (docs/design/SYSTEM.md)
// <html data-finish> is written by core/theme.js; the glass levels and tints live in core/styles/finish-*.css.
//
//   FINISHES                     [{ id, name: {en, fr}, desc: {en, fr}, preview }]  (order: halo, prisme, sobre)
//   DEFAULT_FINISH               'halo' (new users, and settings files that never chose one)
//   finishDefaults(finish, style) -> { accent: '#rrggbb', wallpaper: 'builtin:<id>', iconPack }
//   FINISH_ACCENTS               curated dark / light values of the finish accents (same shape as ACCENT_PRESETS)
//   finishOf(value)              a valid finish id ('halo' for anything unknown)

export const DEFAULT_FINISH = 'halo';

export const FINISHES = [
  {
    id: 'halo',
    name: { en: 'Halo', fr: 'Halo' },
    desc: { en: 'Glass tinted by the wallpaper, colourful icons, luminous wallpapers', fr: 'Verre teinté par le fond d’écran, icônes colorées, fonds lumineux' },
    preview: 'app://shell/assets/finishes/halo.jpg',
  },
  {
    id: 'prisme',
    name: { en: 'Prism', fr: 'Prisme' },
    desc: { en: 'Frosted glass with a fine grain, glossy icons, aurora veils', fr: 'Verre dépoli au grain fin, icônes brillantes, voiles d’aurore' },
    preview: 'app://shell/assets/finishes/prisme.jpg',
  },
  {
    id: 'sobre',
    name: { en: 'Plain', fr: 'Sobre' },
    desc: { en: 'Matte opaque surfaces, muted icons', fr: 'Surfaces mates et opaques, icônes discrètes' },
    preview: 'app://shell/assets/finishes/sobre.jpg',
  },
];
export const FINISH_IDS = FINISHES.map((f) => f.id);
export function finishOf(value) {
  return FINISH_IDS.includes(value) ? value : DEFAULT_FINISH;
}

// The accents each finish brings, per style (measured on the mockups: Halo ice blue / amber / plum, Prisme cyan /
// honey / rose). Sobre keeps the Selene accents of core/theme.js STYLES.
const ACCENTS = {
  halo: { nocturne: '#7fcbff', eclipse: '#ffb547', clairdelune: '#b5367f' },
  prisme: { nocturne: '#72e4ff', eclipse: '#ffc65c', clairdelune: '#b42f78' },
  sobre: { nocturne: '#c9d3e6', eclipse: '#e9b566', clairdelune: '#a58bf2' },
};
const WALLPAPERS = {
  halo: { nocturne: 'builtin:halo-nocturne', eclipse: 'builtin:halo-eclipse', clairdelune: 'builtin:halo-clairdelune' },
  prisme: { nocturne: 'builtin:prisme-nocturne', eclipse: 'builtin:prisme-eclipse', clairdelune: 'builtin:prisme-clairdelune' },
  sobre: { nocturne: 'builtin:nocturne', eclipse: 'builtin:eclipse', clairdelune: 'builtin:clairdelune' },
};
const ICON_PACK = { halo: 'halo', prisme: 'prisme', sobre: 'selene' };

/** { accent, wallpaper, iconPack } a finish brings for a style (High contrast: the Nocturne values; it shows its own colours anyway). */
export function finishDefaults(finish, style) {
  const f = finishOf(finish);
  const st = ['nocturne', 'eclipse', 'clairdelune'].includes(style) ? style : 'nocturne';
  return { accent: ACCENTS[f][st], wallpaper: WALLPAPERS[f][st], iconPack: ICON_PACK[f] };
}

// Curated values of the finish accents in each mode (like ACCENT_PRESETS in core/theme.js): --on-accent on --accent
// ≥ 5:1, --accent-text ≥ 4.5:1 on the glass and the surfaces of its mode.
export const FINISH_ACCENTS = [
  {
    id: 'ice',
    name: { en: 'Ice blue', fr: 'Bleu glacier' },
    hex: '#7fcbff',
    dark: { accent: '#7fcbff', hover: '#99d6ff', pressed: '#6bbcf2', text: '#8fd2ff', on: '#061433' },
    light: { accent: '#1d6aa8', hover: '#195f97', pressed: '#155285', text: '#195f97', on: '#ffffff' },
  },
  {
    id: 'gold',
    name: { en: 'Gold', fr: 'Or' },
    hex: '#ffb547',
    dark: { accent: '#ffb547', hover: '#ffc266', pressed: '#f0a530', text: '#ffc266', on: '#2a1500' },
    light: { accent: '#a35a00', hover: '#944f00', pressed: '#804400', text: '#8f4c00', on: '#ffffff' },
  },
  {
    id: 'plum',
    name: { en: 'Plum', fr: 'Prune' },
    hex: '#b5367f',
    dark: { accent: '#f08cc4', hover: '#f4a3d0', pressed: '#e57ab6', text: '#f4a3d0', on: '#2a0a1c' },
    light: { accent: '#b5367f', hover: '#a32f72', pressed: '#8f2964', text: '#a12c6f', on: '#ffffff' },
  },
  {
    id: 'cyan',
    name: { en: 'Cyan', fr: 'Cyan' },
    hex: '#72e4ff',
    dark: { accent: '#72e4ff', hover: '#8eeaff', pressed: '#5ad8f5', text: '#9eebff', on: '#041a28' },
    light: { accent: '#0b6f8a', hover: '#0a6580', pressed: '#085870', text: '#0a6580', on: '#ffffff' },
  },
  {
    id: 'honey',
    name: { en: 'Honey', fr: 'Miel' },
    hex: '#ffc65c',
    dark: { accent: '#ffc65c', hover: '#ffd27d', pressed: '#f2b743', text: '#ffd27d', on: '#2a1500' },
    light: { accent: '#9a5800', hover: '#8c5000', pressed: '#7a4500', text: '#8c5000', on: '#ffffff' },
  },
  {
    id: 'rose',
    name: { en: 'Rose', fr: 'Rose' },
    hex: '#b42f78',
    dark: { accent: '#f28ac0', hover: '#f6a2cd', pressed: '#e977b3', text: '#f6a2cd', on: '#2a0a1c' },
    light: { accent: '#b42f78', hover: '#a0286a', pressed: '#8c225d', text: '#a0286a', on: '#ffffff' },
  },
];
/** The curated finish accent of a stored hex, or null. */
/**
 * The accents offered for a finish (Réglages rapides and Personnalisation): its own three (one per style), then the
 * shared presets, minus a preset that looks the same as one of the finish's own (e.g. Halo's « Or » and the amber preset);
 * the current accent is always kept so it stays selectable.
 */
export function offeredAccents(finish, presets, current = '') {
  const own = finish !== 'sobre' ? [...new Set(['nocturne', 'eclipse', 'clairdelune'].map((st) => finishDefaults(finish, st).accent))].map(finishAccent).filter(Boolean) : [];
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(String(h).slice(i, i + 2), 16));
  const near = (a, b) => { const [x, y] = [rgb(a), rgb(b)]; return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]) < 60; };
  const cur = String(current || '').toLowerCase();
  return [...own, ...presets.filter((p) => p.hex === cur || !own.some((o) => near(o.hex, p.hex)))];
}

export function finishAccent(hex) {
  const v = String(hex || '').toLowerCase();
  return FINISH_ACCENTS.find((a) => a.hex === v) || null;
}
