// Applies appearance settings to the document (docs/PERSONALIZATION.md):
//   theme (light/dark, "Auto" by time of day), accent colour (+ derived shades, optionally picked from the
//   wallpaper), visual style (core/styles/<style>.css), transparency level, blur intensity, corner radius,
//   font family, text size, reduced motion, taskbar colour/opacity, per-app themes, wallpaper (+ a pre-blurred
//   copy used for the "Mica" window material), night light, scale.
//
// Mica trick: windows paint `var(--mica-image)` with background-attachment: fixed, which is a
// heavily blurred copy of the wallpaper rendered once here — the real Windows 11 Mica look
// without per-frame backdrop blur (cheap enough for software rendering in a VM).
//
// Public API (stable):
//   applyTheme(all?)  watchTheme()  accentVars(hex, mode)  resolveWallpaper(value, mode)  WALLPAPERS  ACCENTS
//   theme.on('change'|'wallpaper'|'mica'|'style', fn)   theme.mode   theme.style   theme.wallpaperUrl  theme.micaUrl
//   theme.transition(async fn)      run fn inside a ~300 ms cross-fade of the whole UI (profiles, style switch)
//   theme.whenApplied()             resolves after the next applyTheme() finished
//   theme.profiles                  core/profiles.js API (set once the shell booted)
//   effectiveTheme(el)              'light' | 'dark' in effect for an element (honours per-app themes)
//   STYLES  FONTS  fontInstalled(id)  styleVars(styleId, all)  applyVisualStyle(all, root?)  wallpaperAccent(url)
//   appThemeFor(appId)  decorateWindow(winEl)
//   setWallpaperOverride(url|null)  the picture the wallpaper engine shows instead of settings.wallpaper (animated
//                                   still frame, time-of-day variant, slideshow picture): desktop, Mica, accent from
//                                   wallpaper and the lock screen follow it (core/features/wallpaper.js, area B1)
import { api, Emitter } from './api.js';
import { settings } from './settings.js';

// Selene wallpapers (one per style, light + dark; drawn by tools/gen-wallpapers.mjs), then the other lunar scenes.
// Ids of the retired set (bloom, glow, flow, sunrise, aurora, dunes) are unknown here and resolve to the first entry.
export const WALLPAPERS = [
  { id: 'nocturne', name: { en: 'Nocturne', fr: 'Nocturne' }, light: 'nocturne-light.jpg', dark: 'nocturne-dark.jpg' },
  { id: 'eclipse', name: { en: 'Eclipse', fr: 'Éclipse' }, light: 'eclipse-light.jpg', dark: 'eclipse-dark.jpg' },
  { id: 'clairdelune', name: { en: 'Moonlight', fr: 'Clair de lune' }, light: 'clairdelune-light.jpg', dark: 'clairdelune-dark.jpg' },
  { id: 'forest', name: { en: 'Pine forest', fr: 'Forêt de pins' }, light: 'forest-light.jpg', dark: 'forest-dark.jpg' },
  { id: 'peaks', name: { en: 'Peaks', fr: 'Cimes' }, light: 'peaks-light.jpg', dark: 'peaks-dark.jpg' },
  { id: 'milkyway', name: { en: 'Milky Way', fr: 'Voie lactée' }, light: 'milkyway.jpg', dark: 'milkyway.jpg' },
];

// The four Selene accents. `hex` is the value stored in settings.accent (every consumer keeps reading a
// plain '#rrggbb'); `dark` / `light` are the curated tokens of each mode. Contrast (docs/design/SYSTEM.md §3):
// --on-accent on --accent ≥ 5:1 and --accent-text on every surface of the three ambiances ≥ 4.8:1.
export const ACCENT_PRESETS = [
  {
    id: 'silver',
    name: { en: 'Lunar silver', fr: 'Argent lunaire' },
    hex: '#c9d3e6',
    dark: { accent: '#c9d3e6', hover: '#d7dfed', pressed: '#b9c4da', text: '#c9d3e6', on: '#101624' },
    light: { accent: '#55637e', hover: '#4a5770', pressed: '#3e4a62', text: '#4a5770', on: '#ffffff' },
  },
  {
    id: 'night',
    name: { en: 'Night blue', fr: 'Bleu nuit' },
    hex: '#6f8de6',
    dark: { accent: '#8ba3ec', hover: '#9db2f0', pressed: '#7a95e6', text: '#9db2f0', on: '#0b1020' },
    light: { accent: '#3756b8', hover: '#3150ae', pressed: '#2a4699', text: '#3150ae', on: '#ffffff' },
  },
  {
    id: 'violet',
    name: { en: 'Violet', fr: 'Violet' },
    hex: '#a58bf2',
    dark: { accent: '#b9a4f2', hover: '#c3b1f5', pressed: '#a993ec', text: '#c3b1f5', on: '#160f2b' },
    light: { accent: '#6a4bc3', hover: '#6143b8', pressed: '#553aa5', text: '#6143b8', on: '#ffffff' },
  },
  {
    id: 'amber',
    name: { en: 'Amber', fr: 'Ambre' },
    hex: '#e9b566',
    dark: { accent: '#f2a63a', hover: '#f2b45e', pressed: '#e0952a', text: '#f2b45e', on: '#1a1206' },
    light: { accent: '#a65a06', hover: '#995204', pressed: '#874803', text: '#8f4c03', on: '#ffffff' },
  },
];
export const DEFAULT_ACCENT = ACCENT_PRESETS[0].hex;
export const ACCENTS = ACCENT_PRESETS.map((a) => a.hex);
/** The preset of a stored accent hex ('silver' …), or null for a custom colour. */
export function accentPreset(hex) {
  const v = String(hex || '').toLowerCase();
  return ACCENT_PRESETS.find((a) => a.hex === v) || null;
}

// Colour ambiances (palettes of tokens.css, <html data-ambiance>).
export const AMBIANCES = [
  { id: 'cold', name: { en: 'Cold', fr: 'Froide' }, desc: { en: 'Ink blue and slate', fr: 'Bleu encre et ardoise' }, swatch: { dark: '#121826', light: '#f1f4f9' } },
  { id: 'neutral', name: { en: 'Neutral', fr: 'Neutre' }, desc: { en: 'Pure greys', fr: 'Gris purs' }, swatch: { dark: '#18181b', light: '#f4f4f5' } },
  { id: 'warm', name: { en: 'Warm', fr: 'Chaude' }, desc: { en: 'Warm blacks and cream', fr: 'Noirs chauds et crème' }, swatch: { dark: '#1f1a16', light: '#f7f1e8' } },
];
const AMBIANCE_IDS = AMBIANCES.map((a) => a.id);

// Visual styles. `defaults` are the ambiance, accent and wallpaper a style brings (they follow the style
// unless the user changed them: styleChoicePatch). `traits` are what CSS alone cannot do (or what must beat
// the user's sliders):
//   opaque: no translucency (transparency level ignored)   noBlur: no backdrop blur
//   noMica: windows are flat (no pre-blurred wallpaper is computed)   noTaskbarColor: ignore taskbar.color
//   contrast: its own palette (ambiance and accent ignored)
export const STYLES = [
  { id: 'nocturne', name: { en: 'Nocturne', fr: 'Nocturne' }, desc: { en: 'Ink-blue night, silver accent, floating bar islands', fr: 'Nuit bleu encre, accent argenté, barre en îlots flottants' }, defaults: { ambiance: 'cold', accent: '#c9d3e6', wallpaper: 'builtin:nocturne' }, traits: { noMica: true } },
  { id: 'eclipse', name: { en: 'Eclipse', fr: 'Éclipse' }, desc: { en: 'Graphite, amber accent, full-width opaque bar', fr: 'Graphite, accent ambre, barre opaque sur toute la largeur' }, defaults: { ambiance: 'neutral', accent: '#e9b566', wallpaper: 'builtin:eclipse' }, traits: { noMica: true } },
  { id: 'clairdelune', name: { en: 'Moonlight', fr: 'Clair de lune' }, desc: { en: 'Warm night and cream, violet accent, three floating pills', fr: 'Nuit chaude et crème, accent violet, trois pastilles flottantes' }, defaults: { ambiance: 'warm', accent: '#a58bf2', wallpaper: 'builtin:clairdelune' }, traits: { noMica: true } },

  { id: 'contrast', name: { en: 'High contrast', fr: 'Contraste élevé' }, desc: { en: 'Maximum legibility: solid colours, thick borders, AAA contrast', fr: 'Lisibilité maximale : couleurs pleines, bordures épaisses, contraste AAA' }, defaults: null, traits: { opaque: true, noBlur: true, noMica: true, noTaskbarColor: true, contrast: true } },
];
const styleOf = (id) => STYLES.find((s) => s.id === id) || STYLES[0];
/** Style ids of older releases: they all become Nocturne (settings.js migrates saved settings too). */
export const LEGACY_STYLES = ['win11', 'minimal', 'glass', 'retro'];
/** The ambiance in effect: the setting, else the style's default. */
export function ambianceOf(all = settings.all()) {
  if (AMBIANCE_IDS.includes(all.ambiance)) return all.ambiance;
  return styleOf(all.style).defaults?.ambiance || 'cold';
}
/** { ambiance, accent, wallpaper } a style brings (Contraste élevé: null, it keeps the user's choices). */
export function styleDefaults(id) {
  return styleOf(id).defaults || null;
}
/**
 * The settings patch for choosing a style: the ambiance, the accent and the wallpaper follow the new style's
 * defaults unless the user changed them (their value differs from the previous style's default).
 * Use it with settings:setMany (chooseStyle does).
 */
export function styleChoicePatch(id, all = settings.all()) {
  const next = styleOf(id);
  const patch = { style: next.id };
  if (!next.defaults) return patch;
  const same = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
  // coming from a style without defaults (High contrast): the values count as defaults when they are exactly
  // one style's pair (ambiance + accent), i.e. the user did not pick them separately
  const prev = styleOf(all.style).defaults || STYLES.find((st) => st.defaults && same(st.defaults.ambiance, all.ambiance ?? 'cold') && same(st.defaults.accent, all.accent))?.defaults || STYLES[0].defaults;
  if (all.ambiance == null || same(all.ambiance, prev.ambiance)) patch.ambiance = next.defaults.ambiance;
  if (!all.accentFromWallpaper && (all.accent == null || same(all.accent, prev.accent))) patch.accent = next.defaults.accent;
  if (all.wallpaper == null || same(all.wallpaper, prev.wallpaper)) patch.wallpaper = next.defaults.wallpaper;
  return patch;
}
/** Choose a style the way Settings does (one atomic settings:setMany, one cross-fade). */
export function chooseStyle(id) {
  return api.invoke('settings:setMany', styleChoicePatch(id));
}

// Curated fonts (installed in the image: fonts-inter, fonts-noto-core, fonts-dejavu-core, fonts-liberation2,
// fonts-cascadia-code, fonts-unifont — see iso/packages.d/personalization.list).
export const FONTS = [
  {
    id: 'inter',
    name: { en: 'Inter and Manrope (default)', fr: 'Inter et Manrope (par défaut)' },
    probe: 'Inter',
    font: '"Inter", "Noto Sans", "DejaVu Sans", system-ui, sans-serif',
    display: '"Manrope", "Inter", "Noto Sans", sans-serif',
  },
  { id: 'system', name: { en: 'System default', fr: 'Police du système' }, probe: null, font: 'system-ui, sans-serif', display: 'system-ui, sans-serif' },
  { id: 'noto-sans', name: 'Noto Sans', probe: 'Noto Sans', font: '"Noto Sans", "Inter", "DejaVu Sans", sans-serif' },
  { id: 'dejavu-sans', name: 'DejaVu Sans', probe: 'DejaVu Sans', font: '"DejaVu Sans", "Noto Sans", sans-serif' },
  { id: 'liberation-sans', name: 'Liberation Sans', probe: 'Liberation Sans', font: '"Liberation Sans", "Arimo", "DejaVu Sans", sans-serif' },
  { id: 'noto-serif', name: { en: 'Noto Serif (serif)', fr: 'Noto Serif (à empattements)' }, probe: 'Noto Serif', font: '"Noto Serif", "DejaVu Serif", "Liberation Serif", serif' },
  { id: 'dejavu-serif', name: { en: 'DejaVu Serif (serif)', fr: 'DejaVu Serif (à empattements)' }, probe: 'DejaVu Serif', font: '"DejaVu Serif", "Noto Serif", "Liberation Serif", serif' },
  { id: 'cascadia', name: { en: 'Cascadia Code (monospace)', fr: 'Cascadia Code (chasse fixe)' }, probe: 'Cascadia Code', font: '"Cascadia Code", "Cascadia Mono", "DejaVu Sans Mono", monospace' },
  { id: 'unifont', name: { en: 'Unifont (pixel)', fr: 'Unifont (pixel)' }, probe: 'Unifont', font: '"Unifont", "DejaVu Sans Mono", monospace' },
];
const fontOf = (id) => FONTS.find((f) => f.id === id) || FONTS[0];

const fontCache = new Map();
/** Whether a curated font is installed (canvas width probe against generic fallbacks). */
export function fontInstalled(id) {
  const f = fontOf(id);
  if (!f.probe) return true;
  if (fontCache.has(f.probe)) return fontCache.get(f.probe);
  let ok = false;
  try {
    const g = document.createElement('canvas').getContext('2d');
    const s = 'mmmmmmmmmmlli1WQ@#àé 0123';
    for (const base of ['monospace', 'serif', 'sans-serif']) {
      g.font = `32px ${base}`;
      const w0 = g.measureText(s).width;
      g.font = `32px "${f.probe}", ${base}`;
      if (Math.abs(g.measureText(s).width - w0) > 0.5) ok = true;
    }
  } catch {}
  fontCache.set(f.probe, ok);
  return ok;
}

const emitter = new Emitter();
let profilesApi = null;
// Events: theme.on('change', mode)  theme.on('wallpaper', url)  theme.on('mica', blobUrl)  theme.on('style', id)
export const theme = {
  on: (ev, fn) => emitter.on(ev, fn),
  get mode() {
    return document.documentElement.dataset.theme || 'light';
  },
  get style() {
    return document.documentElement.dataset.style || 'nocturne';
  },
  get ambiance() {
    return document.documentElement.dataset.ambiance || 'cold';
  },
  get profiles() {
    return profilesApi;
  },
  set profiles(v) {
    profilesApi = v;
  },
  wallpaperUrl: '',
  wallpaperOverride: null,
  micaUrl: '',
  transition: (fn) => transition(fn),
  whenApplied: () => whenApplied(),
};

// ---- colour helpers ----
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
export function hexToRgb(hex) {
  const h = String(hex).replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex([r, g, b]) {
  return `#${[r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;
}
function rgbToHsl([r, g, b]) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  return [h * 360, s * 100, l * 100];
}
function hslToRgb(h, s, l) {
  s /= 100;
  l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}
function hsl(h, s, l, a = 1) {
  return `hsla(${h.toFixed(1)}, ${Math.max(0, Math.min(100, s)).toFixed(1)}%, ${Math.max(0, Math.min(100, l)).toFixed(1)}%, ${a})`;
}
/** WCAG relative luminance of '#rrggbb'. */
export function luminance(hex) {
  const c = hexToRgb(hex).map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

export function accentVars(hex, mode) {
  hex = HEX.test(hex || '') ? hex : DEFAULT_ACCENT;
  const preset = accentPreset(hex);
  if (preset) {
    const p = preset[mode === 'dark' ? 'dark' : 'light'];
    const [r, g, b] = hexToRgb(p.accent);
    return {
      '--accent': p.accent,
      '--accent-hover': p.hover,
      '--accent-pressed': p.pressed,
      '--accent-text': p.text,
      '--accent-subtle': `rgba(${r}, ${g}, ${b}, ${mode === 'dark' ? 0.16 : 0.12})`,
      '--on-accent': p.on,
      '--accent-base': hex,
    };
  }
  const [h, s, l] = rgbToHsl(hexToRgb(hex));
  if (mode === 'dark') {
    const L = Math.max(66, Math.min(78, l + 30));
    return {
      '--accent': hsl(h, s, L),
      '--accent-hover': hsl(h, s, L - 5),
      '--accent-pressed': hsl(h, s, L - 10),
      '--accent-text': hsl(h, s, Math.min(85, L + 6)),
      '--accent-subtle': hsl(h, s, L, 0.16),
      '--on-accent': '#000000',
      '--accent-base': hex,
    };
  }
  const L = Math.min(40, Math.max(28, l - 6));
  return {
    '--accent': hsl(h, s, L),
    '--accent-hover': hsl(h, s, L + 4),
    '--accent-pressed': hsl(h, s, L + 8),
    '--accent-text': hsl(h, s, Math.max(20, L - 8)),
    '--accent-subtle': hsl(h, s, L, 0.12),
    '--on-accent': '#ffffff',
    '--accent-base': hex,
  };
}

// Accent variables of a style: High contrast uses its own palette (yellow on black in dark mode, dark blue
// on white in light mode — both ≥ 7:1 against the background).
const ACCENT_KEYS = ['--accent', '--accent-hover', '--accent-pressed', '--accent-text', '--accent-subtle', '--on-accent', '--accent-base'];
export function styleAccentVars(styleId, hex, mode) {
  const st = styleOf(styleId);
  if (st.traits.contrast) {
    return mode === 'dark'
      ? { '--accent': '#ffff00', '--accent-hover': '#ffff66', '--accent-pressed': '#e6e600', '--accent-text': '#ffff00', '--accent-subtle': 'rgba(255, 255, 0, 0.22)', '--on-accent': '#000000', '--accent-base': HEX.test(hex || '') ? hex : DEFAULT_ACCENT }
      : { '--accent': '#1c0aa8', '--accent-hover': '#2a17c4', '--accent-pressed': '#13077a', '--accent-text': '#1c0aa8', '--accent-subtle': 'rgba(28, 10, 168, 0.14)', '--on-accent': '#ffffff', '--accent-base': HEX.test(hex || '') ? hex : DEFAULT_ACCENT };
  }
  return accentVars(hex, mode);
}

// The result is used inside CSS `url("…")`: quotes, backslashes and line breaks are percent-encoded and
// only image-safe schemes are accepted (anything else falls back to the default wallpaper).
export function resolveWallpaper(value, mode) {
  const v = typeof value === 'string' && value ? value : STYLES[0].defaults.wallpaper;
  const builtin = (id) => {
    const w = WALLPAPERS.find((x) => x.id === id) || WALLPAPERS[0];
    return `app://shell/assets/wallpapers/${mode === 'dark' ? w.dark : w.light}`;
  };
  if (v.startsWith('builtin:')) return builtin(v.slice(8));
  const safe = (u) => u.replace(/["\\\n\r\f]/g, (c) => encodeURIComponent(c));
  if (v.startsWith('/')) return safe(api.mediaUrl(v));
  if (/^(app|media|blob|https?):/i.test(v) || /^data:image\//i.test(v)) return safe(v);
  return builtin(WALLPAPERS[0].id);
}

// The wallpaper is decoded once and kept as a small (≤ 640 px) canvas: the Mica copy (320 px) and the
// accent picker (64 px) are drawn from it, so dragging the blur slider never re-decodes a 2560 px JPEG.
let srcCache = { url: '', p: null };
function loadImage(url) {
  if (srcCache.url === url && srcCache.p) return srcCache.p;
  const p = (async () => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = url;
    await img.decode();
    const k = Math.min(1, 640 / Math.max(1, img.naturalWidth));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * k));
    c.height = Math.max(1, Math.round(img.naturalHeight * k));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c;
  })();
  srcCache = { url, p };
  p.catch(() => srcCache.p === p && (srcCache = { url: '', p: null }));
  return p;
}

// Pre-blur the wallpaper once (downscaled canvas + blur filter) for the Mica material.
async function makeMica(url, { blur = 18, sat = 1.4 } = {}) {
  try {
    const img = await loadImage(url);
    const w = 320;
    const h = Math.round((w * window.innerHeight) / window.innerWidth) || 180;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    // cover-fit
    const scale = Math.max(w / img.width, h / img.height);
    const dw = img.width * scale;
    const dh = img.height * scale;
    g.filter = `blur(${blur.toFixed(1)}px) saturate(${sat})`;
    g.drawImage(img, (w - dw) / 2 - 20, (h - dh) / 2 - 20, dw + 40, dh + 40);
    return await new Promise((res) => c.toBlob((b) => res(b ? URL.createObjectURL(b) : ''), 'image/png'));
  } catch {
    return '';
  }
}

/** The most vivid colour of an image (accent from wallpaper), normalised to a usable accent. */
const accentCache = new Map();
export async function wallpaperAccent(url) {
  if (accentCache.has(url)) return accentCache.get(url);
  let out = DEFAULT_ACCENT;
  try {
    const img = await loadImage(url);
    const w = 64;
    const h = 36;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, w, h);
    const px = g.getImageData(0, 0, w, h).data;
    const bins = Array.from({ length: 24 }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
    let ar = 0;
    let ag = 0;
    let ab = 0;
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i];
      const gg = px[i + 1];
      const b = px[i + 2];
      ar += r;
      ag += gg;
      ab += b;
      const max = Math.max(r, gg, b);
      const min = Math.min(r, gg, b);
      const v = max / 255;
      const s = max ? (max - min) / max : 0;
      if (s < 0.22 || v < 0.18 || v > 0.98) continue;
      const [hh] = rgbToHsl([r, gg, b]);
      const wt = s * s * v;
      const bin = bins[Math.floor(hh / 15) % 24];
      bin.w += wt;
      bin.r += r * wt;
      bin.g += gg * wt;
      bin.b += b * wt;
    }
    const n = px.length / 4;
    // neighbouring hue bins vote together, so a gradient is not split across two bins
    let best = -1;
    let bestW = 0;
    for (let i = 0; i < 24; i++) {
      const wsum = bins[i].w + 0.5 * (bins[(i + 23) % 24].w + bins[(i + 1) % 24].w);
      if (wsum > bestW) {
        bestW = wsum;
        best = i;
      }
    }
    let rgb;
    if (best >= 0 && bins[best].w > n * 0.004) rgb = [bins[best].r / bins[best].w, bins[best].g / bins[best].w, bins[best].b / bins[best].w];
    else rgb = [ar / n, ag / n, ab / n];
    const [hh, ss, ll] = rgbToHsl(rgb);
    const grey = ss < 12;
    out = rgbToHex(hslToRgb(hh, grey ? Math.min(ss, 14) : Math.max(48, Math.min(88, ss)), Math.max(34, Math.min(52, ll))));
  } catch {}
  accentCache.set(url, out);
  return out;
}

// ---- visual style sheets (core/styles/*.css): loaded once, toggled by <html data-style> ----
let styleSheetsReady = null;
function loadStyleSheets() {
  if (styleSheetsReady) return styleSheetsReady;
  const files = ['base', ...STYLES.map((s) => s.id)];
  styleSheetsReady = Promise.all(
    files.map(
      (f) =>
        new Promise((resolve) => {
          const href = `app://shell/core/styles/${f}.css`;
          if (document.querySelector(`link[data-href="${href}"]`)) return resolve();
          const l = document.createElement('link');
          l.rel = 'stylesheet';
          l.href = href;
          l.dataset.href = href;
          l.onload = l.onerror = () => resolve();
          document.head.appendChild(l);
          setTimeout(resolve, 2000);
        }),
    ),
  );
  return styleSheetsReady;
}

const clampNum = (v, lo, hi, def) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def;
};

/** CSS variables computed from the settings for a visual style (written to :root, or to a preview element). */
export function styleVars(styleId, all = settings.all()) {
  const st = styleOf(styleId);
  const tr = st.traits;
  const out = {};
  const on = all.transparency !== false && !tr.opaque;
  const level = clampNum(all.transparencyLevel, 0, 100, 50);
  // 0 → opaque, 50 → 1 (default), 100 → 3.2 (very see-through; alpha is clamped in tokens.css)
  out['--tp'] = on ? (level <= 50 ? level / 50 : 1 + ((level - 50) / 50) * 2.2).toFixed(3) : '0';
  const blur = clampNum(all.blur, 0, 100, 50);
  // 0–100 → 0–56 px; 28 px at the default 50 (the mockups' panels)
  out['--blur-px'] = `${tr.noBlur ? 0 : Math.round(blur * 0.56)}px`;
  out['--corner'] = (clampNum(all.cornerRadius, 0, 200, 100) / 100).toFixed(3);
  out['--text-scale'] = (clampNum(all.textScale, 80, 150, 100) / 100).toFixed(3);
  const f = fontOf(all.fontFamily);
  out['--font'] = f.font;
  out['--font-display'] = f.display || f.font;
  const tb = all.taskbar || {};
  if (tb.opacity != null && Number.isFinite(Number(tb.opacity)) && on) out['--a-taskbar'] = (clampNum(tb.opacity, 0, 100, 83) / 100).toFixed(3);
  return out;
}

const VARS_ID = 'aurora-theme-vars';
function writeVars(vars) {
  let el = document.getElementById(VARS_ID);
  if (!el) {
    el = document.createElement('style');
    el.id = VARS_ID;
    document.head.appendChild(el);
  }
  const css = `:root {\n${Object.entries(vars)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join('\n')}\n}\n`;
  if (el.textContent !== css) el.textContent = css;
}

/** data-style + style sheets + computed variables on a root element (shell, sign-in screen). */
export async function applyVisualStyle(all = settings.all(), root = document.documentElement) {
  const st = styleOf(all.style);
  root.dataset.style = st.id;
  root.dataset.ambiance = ambianceOf(all);
  root.dataset.accent = accentPreset(all.accent)?.id || 'custom';
  writeVars(styleVars(st.id, all));
  await loadStyleSheets();
  return st.id;
}

// ---- taskbar colour ----
function taskbarColor(all, mode) {
  const st = styleOf(all.style);
  const c = all.taskbar?.color;
  if (!c || st.traits.noTaskbarColor) return null;
  if (c === 'accent') {
    const [h, s] = rgbToHsl(hexToRgb(HEX.test(all.accent || '') ? all.accent : DEFAULT_ACCENT));
    return rgbToHex(hslToRgb(h, Math.min(s, 80), mode === 'dark' ? 18 : 32));
  }
  return HEX.test(c) ? (c.length === 4 ? rgbToHex(hexToRgb(c)) : c.toLowerCase()) : null;
}
function applyTaskbar(all, mode) {
  const el = document.getElementById('taskbar');
  const color = taskbarColor(all, mode);
  if (!el) return color;
  for (const k of ACCENT_KEYS) el.style.removeProperty(k);
  if (color) {
    const tone = luminance(color) > 0.36 ? 'light' : 'dark';
    el.setAttribute('data-theme-scope', '');
    el.dataset.theme = tone;
    el.style.setProperty('--taskbar-rgb', hexToRgb(color).join(' '));
    if (tone !== mode) for (const [k, v] of Object.entries(styleAccentVars(all.style, all.accent, tone))) el.style.setProperty(k, v);
  } else {
    el.removeAttribute('data-theme-scope');
    delete el.dataset.theme;
    el.style.removeProperty('--taskbar-rgb');
  }
  return color;
}

// ---- per-app themes ----
/** { theme: 'system'|'light'|'dark', accent: null|hex } for an app (normalised). */
export function appThemeFor(appId, all = settings.all()) {
  const raw = (all.appThemes && typeof all.appThemes === 'object' && all.appThemes[appId]) || {};
  return { theme: ['light', 'dark'].includes(raw.theme) ? raw.theme : 'system', accent: HEX.test(raw.accent || '') ? raw.accent.toLowerCase() : null };
}

const decorated = new WeakMap(); // element -> true when it carries per-app theme attributes
function themeElement(el, mode, accent, all, force) {
  if (force) {
    el.setAttribute('data-theme-scope', '');
    el.dataset.theme = mode;
    for (const [k, v] of Object.entries(styleAccentVars(all.style, accent || all.accent, mode))) el.style.setProperty(k, v);
    decorated.set(el, true);
  } else if (decorated.get(el)) {
    el.removeAttribute('data-theme-scope');
    delete el.dataset.theme;
    for (const k of ACCENT_KEYS) el.style.removeProperty(k);
    decorated.delete(el);
  }
}

/** Apply the per-app theme of a window element (.win[data-app]). */
export function decorateWindow(el, all = settings.all()) {
  if (!el?.classList?.contains('win') || !el.dataset.app) return;
  const cfg = appThemeFor(el.dataset.app, all);
  const sys = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  const force = cfg.theme !== 'system' || !!cfg.accent;
  themeElement(el, cfg.theme === 'system' ? sys : cfg.theme, cfg.accent, all, force);
}

function decorateAll(all) {
  for (const el of document.querySelectorAll('#windows > .win[data-app]')) decorateWindow(el, all);
}

/** 'light' | 'dark' in effect for an element: its window's per-app theme, else the system mode. */
export function effectiveTheme(el) {
  const scoped = el?.closest?.('[data-theme-scope][data-theme]');
  return scoped?.dataset.theme === 'dark' || (!scoped && document.documentElement.dataset.theme === 'dark') ? 'dark' : 'light';
}

// App style sheets written as `:root[data-theme="dark"] .app-x …` follow the window's own mode: each such
// selector is rewritten into "root is dark and the element is not inside a themed window" + "inside (or on)
// a dark-themed window". Specificity is unchanged (:where adds none).
function splitTop(sel) {
  const out = [];
  let depth = 0;
  let quote = null;
  let cur = '';
  for (const ch of sel) {
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
function firstCompound(s) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (depth === 0 && /[\s>+~]/.test(ch)) return [s.slice(0, i), s.slice(i)];
  }
  return [s, ''];
}
const ROOT_THEME = /^:root((?:\[[^\]]+\])+)\s+(.+)$/s;
export function scopeThemeSelector(selector) {
  if (!selector.includes('data-theme')) return null;
  let changed = false;
  const parts = splitTop(selector).map((part) => {
    const m = ROOT_THEME.exec(part);
    if (!m) return [part];
    const attrs = m[1].match(/\[[^\]]+\]/g) || [];
    const themeAttr = attrs.find((a) => /^\[data-theme\s*=\s*["']?(light|dark)["']?\]$/.test(a));
    if (!themeAttr || /^[>+~]/.test(m[2])) return [part];
    const mode = /dark/.test(themeAttr) ? 'dark' : 'light';
    const others = attrs.filter((a) => a !== themeAttr).join('');
    const [first, rest] = firstCompound(m[2]);
    if (!first || /::/.test(first)) return [part];
    changed = true;
    const t = `[data-theme="${mode}"]`;
    return [
      `:root${others}${t} ${first}:where(:not(.win[data-theme-scope], .win[data-theme-scope] *))${rest}`,
      `:root${others} :is(:where(.win[data-theme-scope])${t} ${first}, ${first}:where(.win[data-theme-scope])${t})${rest}`,
    ];
  });
  return changed ? parts.flat().join(', ') : null;
}
function rewriteRules(rules) {
  for (const rule of rules) {
    if (rule.cssRules && !(rule instanceof CSSStyleRule)) rewriteRules(rule.cssRules);
    else if (rule instanceof CSSStyleRule && rule.selectorText.includes(':root[')) {
      const next = scopeThemeSelector(rule.selectorText);
      if (next) {
        try {
          rule.selectorText = next;
        } catch {}
      }
    }
  }
}
const rewritten = new WeakSet();
function scopeAppSheet(link) {
  const sheet = link.sheet;
  if (!sheet || rewritten.has(sheet)) return;
  rewritten.add(sheet);
  try {
    rewriteRules(sheet.cssRules);
  } catch (err) {
    console.warn('[theme] app style sheet not scoped', link.href, err.message);
  }
}
function watchAppSheets() {
  const handle = (n) => {
    if (n.tagName !== 'LINK' || !/^app:\/\/shell\/apps\//.test(n.href || '')) return;
    if (n.sheet) scopeAppSheet(n);
    else n.addEventListener('load', () => scopeAppSheet(n), { once: true });
  };
  for (const l of document.head.querySelectorAll('link[rel="stylesheet"]')) handle(l);
  new MutationObserver((recs) => {
    for (const r of recs) for (const n of r.addedNodes) handle(n);
  }).observe(document.head, { childList: true });
}

// Text size: the --fs-* tokens follow --text-scale, but many style sheets (apps, features) use plain px
// font sizes. Once the text size differs from 100 % the first time, every shell / app style sheet has its
// `font-size: Npx` and `line-height: Npx` declarations rewritten to `calc(Npx * var(--text-scale, 1))` —
// identical at 100 %, so nothing is touched for users who never change the text size.
const FONT_PROPS = ['font-size', 'line-height'];
const PX = /^(\d+(?:\.\d+)?)px$/;
const scaledSheets = new WeakSet();
let fontScaling = false;
function scaleRules(rules) {
  for (const rule of rules) {
    if (rule.style) {
      for (const prop of FONT_PROPS) {
        const v = rule.style.getPropertyValue(prop).trim();
        const m = PX.exec(v);
        if (m && Number(m[1]) > 0) {
          try {
            rule.style.setProperty(prop, `calc(${m[1]}px * var(--text-scale, 1))`, rule.style.getPropertyPriority(prop));
          } catch {}
        }
      }
    }
    if (rule.cssRules) scaleRules(rule.cssRules);
  }
}
function scaleSheet(sheet) {
  if (!sheet || scaledSheets.has(sheet)) return;
  const href = sheet.href || '';
  if (href && (!href.startsWith('app://shell/') || href.includes('/node_modules/'))) return;
  scaledSheets.add(sheet);
  try {
    scaleRules(sheet.cssRules);
  } catch {}
}
function enableFontScaling() {
  if (fontScaling) return;
  fontScaling = true;
  for (const s of document.styleSheets) scaleSheet(s);
  new MutationObserver((recs) => {
    for (const r of recs) {
      for (const n of r.addedNodes) {
        if (n.tagName === 'LINK') {
          if (n.sheet) scaleSheet(n.sheet);
          else n.addEventListener('load', () => scaleSheet(n.sheet), { once: true });
        } else if (n.tagName === 'STYLE' && n.id !== VARS_ID) setTimeout(() => scaleSheet(n.sheet), 0);
      }
    }
  }).observe(document.head, { childList: true });
}

// Menus and pickers are appended to <body>: they copy the per-app theme of the window they were opened from
// (the window last clicked, else the one holding the focus) when they open over that window — or of the
// themed menu they are a submenu of.
let lastPointerWin = null;
let hoverWin = null; // window under the pointer (tooltips belong to what is hovered, not to what was clicked)
function popupOwner(n) {
  if (n.classList.contains('tooltip')) return hoverWin?.isConnected && decorated.get(hoverWin) ? hoverWin : null;
  const parentMenu = [...document.querySelectorAll('body > .menu[data-theme-scope]')].find((m) => m !== n);
  if (parentMenu) return parentMenu;
  let pointer = false;
  const win = lastPointerWin?.isConnected ? ((pointer = true), lastPointerWin) : document.activeElement?.closest?.('#windows > .win');
  if (!win || !decorated.get(win)) return null;
  if (pointer) return win;
  const r = n.getBoundingClientRect();
  const w = win.getBoundingClientRect();
  return r.left >= w.left - 16 && r.left <= w.right && r.top >= w.top - 16 && r.top <= w.bottom ? win : null;
}
function watchPopups() {
  document.addEventListener('pointerdown', (e) => (lastPointerWin = e.target?.closest?.('#windows > .win') || null), true);
  document.addEventListener('keydown', () => (lastPointerWin = null), true);
  document.addEventListener('pointerover', (e) => (hoverWin = e.target?.closest?.('#windows > .win') || null), true);
  new MutationObserver((recs) => {
    for (const r of recs) {
      for (const n of r.addedNodes) {
        if (n.nodeType !== 1 || !n.matches('.menu, .st-picker, .tooltip')) continue;
        const owner = popupOwner(n);
        if (owner) {
          n.setAttribute('data-theme-scope', '');
          n.dataset.theme = owner.dataset.theme;
          for (const k of ACCENT_KEYS) {
            const v = owner.style.getPropertyValue(k);
            if (v) n.style.setProperty(k, v);
          }
        }
      }
    }
  }).observe(document.body, { childList: true });
}

let lastWallpaper = '';
// Wallpaper engine (core/features/wallpaper.js): a picture shown instead of settings.wallpaper, or null.
let wallpaperOverride = null;
export function setWallpaperOverride(url) {
  const v = typeof url === 'string' && /^(app:|media:|blob:|data:image\/)/i.test(url) ? url : null;
  if (v === wallpaperOverride) return;
  wallpaperOverride = v;
  theme.wallpaperOverride = v;
  if (applied && !pending) {
    pending = Promise.resolve().then(() => {
      pending = null;
      return applyTheme();
    });
  }
}
let lastMicaKey = '';
let lastMica = '';
let micaTimer = null;
let nightEl = null;
let applied = false;
let pending = null;

// Synchronous part: everything that changes colours (so it can run inside a view transition).
function applyColors(all) {
  const root = document.documentElement;
  const mode = all.theme === 'dark' ? 'dark' : 'light';
  const st = styleOf(all.style);
  const prevStyle = root.dataset.style;
  root.dataset.theme = mode;
  root.dataset.style = st.id;
  root.dataset.ambiance = ambianceOf(all);
  root.dataset.accent = accentPreset(all.accent)?.id || 'custom';
  root.dataset.transparency = all.transparency === false || st.traits.opaque ? 'off' : 'on';
  const reduced = !!all.reducedMotion;
  root.dataset.reducedMotion = reduced ? 'on' : 'off';
  root.dataset.animations = all.animations === false || reduced ? 'off' : 'on';
  for (const [k, v] of Object.entries(styleAccentVars(st.id, all.accent, mode))) root.style.setProperty(k, v);
  root.style.setProperty('--wallpaper-fit', all.wallpaperFit || 'fill');
  writeVars(styleVars(st.id, all));
  if (clampNum(all.textScale, 80, 150, 100) !== 100) enableFontScaling();
  applyTaskbar(all, mode);
  decorateAll(all);

  // Night light: warm overlay above everything, ignores pointer events; fades in and out.
  if (all.nightLight) {
    if (!nightEl) {
      nightEl = document.createElement('div');
      nightEl.id = 'night-light';
      Object.assign(nightEl.style, { position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: '2147483646', mixBlendMode: 'multiply', transition: 'opacity 1s, background 1s', opacity: '0' });
      document.body.appendChild(nightEl);
      requestAnimationFrame(() => nightEl && (nightEl.style.opacity = '1'));
    }
    const s = Math.max(0, Math.min(100, all.nightLightStrength ?? 40)) / 100;
    nightEl.style.background = `rgba(255, ${Math.round(190 - 60 * s)}, ${Math.round(120 - 100 * s)}, ${0.15 + 0.35 * s})`;
  } else if (nightEl) {
    const el = nightEl;
    nightEl = null;
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 1000);
  }
  if (prevStyle !== st.id && applied) emitter.emit('style', st.id);
  return mode;
}

let latest = null; // most recent settings snapshot passed to applyTheme
let transitioning = false;
let appliedWaiters = [];

function whenApplied(timeout = 1500) {
  return new Promise((resolve) => {
    appliedWaiters.push(resolve);
    setTimeout(resolve, timeout);
  });
}
const motionOn = (all = settings.all()) => all.animations !== false && !all.reducedMotion;

/** Run fn (which changes settings) inside one cross-fade of the whole screen (~300 ms). */
async function transition(fn) {
  const root = document.documentElement;
  if (!applied || !motionOn() || transitioning || typeof document.startViewTransition !== 'function') {
    const r = await fn();
    return r;
  }
  transitioning = true;
  root.classList.add('theme-switching');
  let result;
  let failure = null;
  try {
    const vt = document.startViewTransition(async () => {
      const waiting = whenApplied(2500);
      try {
        result = await fn();
      } catch (err) {
        failure = err; // e.g. settings:setMany refused the patch: the caller must hear about it
        return;
      }
      await waiting;
    });
    vt.ready.catch(() => {});
    await vt.updateCallbackDone.catch(() => {});
    await vt.finished.catch(() => {});
  } finally {
    transitioning = false;
    root.classList.remove('theme-switching');
  }
  if (failure) throw failure;
  return result;
}

export async function applyTheme(all = settings.all()) {
  const root = document.documentElement;
  latest = all;
  const prevMode = root.dataset.theme;
  const nextMode = all.theme === 'dark' ? 'dark' : 'light';
  const accentChanged = root.style.getPropertyValue('--accent-base') !== (HEX.test(all.accent || '') ? all.accent : DEFAULT_ACCENT);
  const styleChanged = (root.dataset.style || 'nocturne') !== styleOf(all.style).id;
  const ambianceChanged = !!root.dataset.ambiance && root.dataset.ambiance !== ambianceOf(all);
  const animate = applied && motionOn(all) && (prevMode !== nextMode || accentChanged || styleChanged || ambianceChanged);
  if (!applied) await loadStyleSheets();
  let mode;
  // Light/dark, accent and style switches cross-fade the whole screen for a short moment. Only one
  // transition runs at a time: a switch requested meanwhile applies at once, and the transition's
  // (asynchronous) update callback always applies the *latest* settings, so rapid toggling can never
  // leave the screen out of sync with the setting.
  if (animate && !transitioning && typeof document.startViewTransition === 'function') {
    transitioning = true;
    root.classList.add('theme-switching');
    const done = () => {
      transitioning = false;
      root.classList.remove('theme-switching');
    };
    try {
      const vt = document.startViewTransition(() => {
        mode = applyColors(latest || all);
      });
      vt.ready.catch(() => {});
      vt.finished.catch(() => {}).then(done);
      await vt.updateCallbackDone.catch(() => {});
    } catch {
      done();
    }
  }
  if (!mode) mode = applyColors(latest || all);
  all = latest || all;
  applied = true;
  const waiters = appliedWaiters.splice(0);

  const wp = wallpaperOverride || resolveWallpaper(all.wallpaper, mode);
  const st = styleOf(all.style);
  const blurLevel = clampNum(all.blur, 0, 100, 50);
  const micaOpts = { blur: (blurLevel / 50) * 18 * (st.traits.micaBlur ?? 1), sat: 1.4 * (st.traits.micaSat ?? 1) };
  const micaKey = `${wp}|${micaOpts.blur.toFixed(1)}|${micaOpts.sat}`;
  if (wp !== lastWallpaper) {
    lastWallpaper = wp;
    theme.wallpaperUrl = wp;
    root.style.setProperty('--wallpaper', `url("${wp}")`);
    // The desktop starts its cross-fade right away; the blurred Mica copy follows.
    emitter.emit('wallpaper', wp);
  }
  for (const fn of waiters) fn();
  if (all.accentFromWallpaper) {
    wallpaperAccent(wp).then((hex) => {
      if (latest?.accentFromWallpaper && lastWallpaper === wp && String(settings.get('accent') || '').toLowerCase() !== hex) settings.set('accent', hex).catch(() => {});
    });
  }
  if (st.traits.noMica) {
    // flat windows: no pre-blurred wallpaper to compute (cheaper, and no Mica look)
    if (lastMicaKey) {
      lastMicaKey = '';
      clearTimeout(micaTimer);
      if (lastMica) URL.revokeObjectURL(lastMica);
      lastMica = '';
      theme.micaUrl = '';
      root.style.setProperty('--mica-image', 'none');
      emitter.emit('mica', '');
    } else root.style.setProperty('--mica-image', 'none');
  } else if (micaKey !== lastMicaKey) {
    // same picture, other blur / style: wait until the slider rests (one re-blur instead of one per step)
    const sameWall = lastMicaKey.startsWith(`${wp}|`);
    lastMicaKey = micaKey;
    clearTimeout(micaTimer);
    const run = async () => {
      if (micaKey !== lastMicaKey) return;
      const mica = await makeMica(wp, micaOpts);
      if (micaKey !== lastMicaKey) {
        if (mica) URL.revokeObjectURL(mica);
      } else {
        if (lastMica) URL.revokeObjectURL(lastMica);
        lastMica = mica;
        theme.micaUrl = mica;
        root.style.setProperty('--mica-image', mica ? `url("${mica}")` : 'none');
        emitter.emit('mica', mica);
      }
    };
    if (sameWall) micaTimer = setTimeout(run, 160);
    else await run();
  }

  const scale = (Number(all.scale) || 100) / 100;
  api.invoke('shell:zoom', scale).catch(() => {});
  emitter.emit('change', mode);
}

// ---- "Auto" mode: light / dark by time of day ----
const minutes = (s, def) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ''));
  return m ? (Number(m[1]) % 24) * 60 + (Number(m[2]) % 60) : def;
};
/** 'light' | 'dark' that the Auto schedule wants at `date`. */
export function autoThemeAt(cfg = {}, date = new Date()) {
  const light = minutes(cfg.light, 7 * 60);
  const dark = minutes(cfg.dark, 19 * 60);
  const now = date.getHours() * 60 + date.getMinutes();
  if (light === dark) return 'light';
  const isLight = light < dark ? now >= light && now < dark : !(now >= dark && now < light);
  return isLight ? 'light' : 'dark';
}
// Auto mode applies its light / dark choice when it is turned on (or its times change), at boot, and each
// time the schedule crosses a boundary. In between, a manual choice (quick settings, a profile, the Colors
// page) is respected until the next boundary — it is never flipped back by an unrelated settings change.
let autoSig = null; // config the schedule was last enforced for
let autoPhase = null; // 'light' | 'dark' the schedule wanted at that time
function checkAutoTheme() {
  const cfg = settings.get('autoTheme');
  if (!cfg?.enabled) {
    autoSig = null;
    autoPhase = null;
    return;
  }
  const sig = `${cfg.light}|${cfg.dark}`;
  const want = autoThemeAt(cfg);
  if (sig === autoSig && want === autoPhase) return;
  autoSig = sig;
  autoPhase = want;
  if ((settings.get('theme') === 'dark' ? 'dark' : 'light') !== want) settings.set('theme', want).catch(() => {});
}

const THEME_KEYS = [
  'theme', 'accent', 'transparency', 'animations', 'wallpaper', 'wallpaperFit', 'nightLight', 'nightLightStrength', 'scale', '*',
  'style', 'ambiance', 'accentFromWallpaper', 'transparencyLevel', 'blur', 'cornerRadius', 'fontFamily', 'textScale', 'reducedMotion', 'taskbar', 'appThemes',
];
let lastStyleId = null; // style of the last settings snapshot seen by watchTheme (follow rule below)
export function watchTheme() {
  lastStyleId = styleOf(settings.get('style')).id;
  settings.on('*', (_v, key) => {
    // A plain settings.set('style', id) (quick settings, a script) gets the same follow rule as Settings:
    // the ambiance, accent and wallpaper that were the old style's defaults follow the new style.
    // settings:setMany callers (profiles, chooseStyle) send their own complete patch.
    const nowStyle = styleOf(settings.get('style')).id;
    if (nowStyle !== lastStyleId) {
      const prev = lastStyleId;
      lastStyleId = nowStyle;
      if (key === 'style' && prev) {
        const all = settings.all();
        const { style, ...rest } = styleChoicePatch(nowStyle, { ...all, style: prev });
        const patch = Object.fromEntries(Object.entries(rest).filter(([k, v]) => String(all[k] ?? '').toLowerCase() !== String(v).toLowerCase()));
        if (Object.keys(patch).length) api.invoke('settings:setMany', patch).catch(() => {});
      }
    }
    if (key && !THEME_KEYS.includes(String(key).split('.')[0])) return;
    if (key === 'autoTheme' || key === '*') checkAutoTheme();
    if (pending) return;
    pending = Promise.resolve().then(() => {
      pending = null;
      return applyTheme();
    });
  });
  settings.on('autoTheme', checkAutoTheme);
  checkAutoTheme();
  setInterval(checkAutoTheme, 30000);

  // per-app themes: decorate windows as they are created; app style sheets follow the window's mode
  const winRoot = document.getElementById('windows');
  if (winRoot) {
    new MutationObserver((recs) => {
      const all = settings.all();
      for (const r of recs) {
        for (const n of r.addedNodes) if (n.nodeType === 1 && n.classList.contains('win')) decorateWindow(n, all);
        // a closed window must not stay referenced (it would keep its whole DOM and app alive)
        for (const n of r.removedNodes) {
          if (n === lastPointerWin) lastPointerWin = null;
          if (n === hoverWin) hoverWin = null;
        }
      }
    }).observe(winRoot, { childList: true });
  }
  watchAppSheets();
  watchPopups();
  // profiles (core/profiles.js): exposed as theme.profiles and through shell.emit('profiles:apply', { id })
  import('./profiles.js')
    .then((m) => m.init?.())
    .catch((err) => console.error('[theme] profiles unavailable', err));
}
