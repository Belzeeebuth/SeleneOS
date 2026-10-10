// Applies appearance settings to the document:
//   theme (light/dark), accent colour (+ derived shades), transparency, animations,
//   wallpaper (+ a pre-blurred copy used for the "Mica" window material), night light, scale.
//
// Mica trick: windows paint `var(--mica-image)` with background-attachment: fixed, which is a
// heavily blurred copy of the wallpaper rendered once here — the real Windows 11 Mica look
// without per-frame backdrop blur (cheap enough for software rendering in a VM).
import { api, Emitter } from './api.js';
import { settings } from './settings.js';

export const WALLPAPERS = [
  { id: 'bloom', name: { en: 'Bloom', fr: 'Floraison' }, light: 'bloom-light.jpg', dark: 'bloom-dark.jpg' },
  { id: 'glow', name: { en: 'Glow', fr: 'Lueur' }, light: 'glow-light.jpg', dark: 'glow-dark.jpg' },
  { id: 'flow', name: { en: 'Flow', fr: 'Flux' }, light: 'flow-light.jpg', dark: 'flow-dark.jpg' },
  { id: 'sunrise', name: { en: 'Sunrise', fr: 'Aurore' }, light: 'sunrise.jpg', dark: 'sunrise.jpg' },
  { id: 'aurora', name: { en: 'Northern lights', fr: 'Aurore boréale' }, light: 'aurora.jpg', dark: 'aurora.jpg' },
  { id: 'dunes', name: { en: 'Dunes', fr: 'Dunes' }, light: 'dunes.jpg', dark: 'dunes.jpg' },
];

export const ACCENTS = [
  '#0078d4', '#0063b1', '#8764b8', '#b146c2', '#e3008c', '#c30052', '#e81123', '#da3b01',
  '#ca5010', '#ff8c00', '#986f0b', '#498205', '#107c10', '#00b294', '#038387', '#2d7d9a',
  '#5d5a58', '#68768a',
];

const emitter = new Emitter();
// Events: theme.on('change', mode)  theme.on('wallpaper', url)  theme.on('mica', blobUrl)
export const theme = {
  on: (ev, fn) => emitter.on(ev, fn),
  get mode() {
    return document.documentElement.dataset.theme || 'light';
  },
  wallpaperUrl: '',
  micaUrl: '',
};

// ---- colour helpers ----
function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
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
function hsl(h, s, l, a = 1) {
  return `hsla(${h.toFixed(1)}, ${Math.max(0, Math.min(100, s)).toFixed(1)}%, ${Math.max(0, Math.min(100, l)).toFixed(1)}%, ${a})`;
}

export function accentVars(hex, mode) {
  hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex || '') ? hex : '#0078d4';
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

// The result is used inside CSS `url("…")`: quotes, backslashes and line breaks are percent-encoded and
// only image-safe schemes are accepted (anything else falls back to the default wallpaper).
export function resolveWallpaper(value, mode) {
  const v = typeof value === 'string' && value ? value : 'builtin:bloom';
  const builtin = (id) => {
    const w = WALLPAPERS.find((x) => x.id === id) || WALLPAPERS[0];
    return `app://shell/assets/wallpapers/${mode === 'dark' ? w.dark : w.light}`;
  };
  if (v.startsWith('builtin:')) return builtin(v.slice(8));
  const safe = (u) => u.replace(/["\\\n\r\f]/g, (c) => encodeURIComponent(c));
  if (v.startsWith('/')) return safe(api.mediaUrl(v));
  if (/^(app|media|blob|https?):/i.test(v) || /^data:image\//i.test(v)) return safe(v);
  return builtin('bloom');
}

// Pre-blur the wallpaper once (downscaled canvas + blur filter) for the Mica material.
async function makeMica(url) {
  try {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = url;
    await img.decode();
    const w = 320;
    const h = Math.round((w * window.innerHeight) / window.innerWidth) || 180;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    // cover-fit
    const scale = Math.max(w / img.naturalWidth, h / img.naturalHeight);
    const dw = img.naturalWidth * scale;
    const dh = img.naturalHeight * scale;
    g.filter = 'blur(18px) saturate(1.4)';
    g.drawImage(img, (w - dw) / 2 - 20, (h - dh) / 2 - 20, dw + 40, dh + 40);
    return await new Promise((res) => c.toBlob((b) => res(b ? URL.createObjectURL(b) : ''), 'image/png'));
  } catch {
    return '';
  }
}

let lastWallpaper = '';
let lastMica = '';
let nightEl = null;
let applied = false;
let pending = null;

// Synchronous part: everything that changes colours (so it can run inside a view transition).
function applyColors(all) {
  const root = document.documentElement;
  const mode = all.theme === 'dark' ? 'dark' : 'light';
  root.dataset.theme = mode;
  root.dataset.transparency = all.transparency === false ? 'off' : 'on';
  root.dataset.animations = all.animations === false ? 'off' : 'on';
  for (const [k, v] of Object.entries(accentVars(all.accent, mode))) root.style.setProperty(k, v);
  root.style.setProperty('--wallpaper-fit', all.wallpaperFit || 'fill');

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
  return mode;
}

let latest = null; // most recent settings snapshot passed to applyTheme
let transitioning = false;

export async function applyTheme(all = settings.all()) {
  const root = document.documentElement;
  latest = all;
  const prevMode = root.dataset.theme;
  const nextMode = all.theme === 'dark' ? 'dark' : 'light';
  const accentChanged = root.style.getPropertyValue('--accent-base') !== (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(all.accent || '') ? all.accent : '#0078d4');
  const animate = applied && all.animations !== false && (prevMode !== nextMode || accentChanged);
  let mode;
  // Light/dark (and accent) switches cross-fade the whole screen for a short moment. Only one
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

  const wp = resolveWallpaper(all.wallpaper, mode);
  if (wp !== lastWallpaper) {
    lastWallpaper = wp;
    theme.wallpaperUrl = wp;
    root.style.setProperty('--wallpaper', `url("${wp}")`);
    // The desktop starts its cross-fade right away; the blurred Mica copy follows.
    emitter.emit('wallpaper', wp);
    const mica = await makeMica(wp);
    if (wp !== lastWallpaper) {
      if (mica) URL.revokeObjectURL(mica);
    } else {
      if (lastMica) URL.revokeObjectURL(lastMica);
      lastMica = mica;
      theme.micaUrl = mica;
      root.style.setProperty('--mica-image', mica ? `url("${mica}")` : 'none');
      emitter.emit('mica', mica);
    }
  }

  const scale = (Number(all.scale) || 100) / 100;
  api.invoke('shell:zoom', scale).catch(() => {});
  emitter.emit('change', mode);
}

const THEME_KEYS = ['theme', 'accent', 'transparency', 'animations', 'wallpaper', 'wallpaperFit', 'nightLight', 'nightLightStrength', 'scale', '*'];
export function watchTheme() {
  settings.on('*', (_v, key) => {
    if (key && !THEME_KEYS.includes(String(key).split('.')[0])) return;
    if (pending) return;
    pending = Promise.resolve().then(() => {
      pending = null;
      return applyTheme();
    });
  });
}
