// Personalization profiles: save the complete look of the desktop and switch with one click.
// See docs/PERSONALIZATION.md §5.
//
//   import { profiles, PROFILE_KEYS } from '../../core/profiles.js';
//   await profiles.list()                       -> [{ id, name, builtin, values, created, updated }]
//   await profiles.saveCurrent(name)            -> new user profile (snapshot of every PROFILE_KEYS value)
//   await profiles.apply(id)                    -> one settings:setMany inside a ~300 ms cross-fade
//   await profiles.rename(id, name)  await profiles.duplicate(id)  await profiles.remove(id)
//   profiles.exportJson(profile) -> string      await profiles.importJson(text) -> profile (validated)
//   profiles.current()                          -> id of the profile matching the current settings, or null
//   profiles.label(p)                           -> localized name
//   profiles.on('change' | 'applied', fn)
// From anywhere in the shell: shell.emit('profiles:apply', { id })  (also window.__aurora.theme.profiles)
//
// Other personalization areas append the keys they add to PROFILE_KEYS (and, if they are part of the
// "look" that the built-in profiles reset, to LOOK_KEYS) and add a validator to VALIDATORS.
import { api, Emitter } from './api.js';
import { settings } from './settings.js';
import { theme, STYLES, FONTS, AMBIANCES, LEGACY_STYLES } from './theme.js';
import { EFFECT_IDS, SET_IDS } from './wallpaper/dynamic.js';
import { i18n } from './i18n.js';
import { SHORTCUT_IDS, isAppAction, validCombo } from './shortcuts.js';

/** Every settings key a profile saves and restores (dotted keys are sub-keys). */
export const PROFILE_KEYS = [
  // Area A — theme engine
  'style', 'ambiance', 'theme', 'autoTheme', 'accent', 'accentFromWallpaper', 'transparency', 'transparencyLevel', 'blur',
  'cornerRadius', 'fontFamily', 'textScale', 'scale', 'reducedMotion', 'animations', 'taskbar.color', 'taskbar.opacity', 'appThemes',
  // wallpapers (B1)
  'wallpaper', 'wallpaperFit', 'lockWallpaper', 'wallpaperMode', 'animatedWallpaper', 'dynamicWallpaper', 'slideshow', 'lockScreen',
  // taskbar + Start + Focus mode (B2)
  'taskbar.align', 'taskbar.autohide', 'taskbar.showSearch', 'taskbar.showTaskView', 'taskbar.showWidgets',
  'taskbar.size', 'taskbar.position', 'taskbar.showLabels', 'taskbar.combine', 'taskbar.widgets', 'taskbar.search',
  'start.layout', 'start.background', 'start.folders', 'start.groups', 'startShowRecent', 'focusMode',
  'taskbar.tray', 'taskbar.badges', 'taskbar.widgetsPos', 'taskbar.hideDelay', 'showSeconds', 'start.showRecentApps', 'start.showMostUsed',
  // packs + input (B3)
  'cursorPack', 'cursorSize', 'iconPack', 'soundPack', 'soundEvents', 'soundVolume', 'startupSound', 'snapPresets', 'snapLayouts',
  'multitasking.snapLayouts', 'multitasking.snapBar', 'multitasking.snapAssist', 'shortcuts',
  // desktop
  'desktopIconSize',
];
/** Sub-keys never saved in a profile (runtime state). */
export const PROFILE_EXCLUDE = ['focusMode.active', 'focusMode.endsAt', 'focusMode.prevDnd'];
/** The "look": what a built-in profile sets (every other key is left alone — text size, scale, layout…). */
export const LOOK_KEYS = [
  'style', 'ambiance', 'theme', 'autoTheme', 'accent', 'accentFromWallpaper', 'transparencyLevel', 'blur', 'cornerRadius', 'fontFamily',
  'taskbar.color', 'taskbar.opacity', 'wallpaper', 'wallpaperFit', 'wallpaperMode', 'cursorPack', 'iconPack', 'soundPack',
];

const solid = (c) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="10"><rect width="16" height="10" fill="${c}"/></svg>`)}`;

export const BUILTIN_PROFILES = [
  { id: 'aurora-dark', name: { en: 'Nocturne', fr: 'Nocturne' }, values: { style: 'nocturne', ambiance: 'cold', theme: 'dark', accent: '#c9d3e6', wallpaper: 'builtin:nocturne' } },
  { id: 'aurora-light', name: { en: 'Nocturne, light', fr: 'Nocturne clair' }, values: { style: 'nocturne', ambiance: 'cold', theme: 'light', accent: '#c9d3e6', wallpaper: 'builtin:nocturne' } },
  { id: 'eclipse', name: { en: 'Eclipse', fr: 'Éclipse' }, values: { style: 'eclipse', ambiance: 'neutral', theme: 'dark', accent: '#e9b566', wallpaper: 'builtin:eclipse' } },
  { id: 'clairdelune', name: { en: 'Clair de lune', fr: 'Clair de lune' }, values: { style: 'clairdelune', ambiance: 'warm', theme: 'dark', accent: '#a58bf2', wallpaper: 'builtin:clairdelune' } },
  { id: 'contrast', name: { en: 'High Contrast', fr: 'Contraste élevé' }, values: { style: 'contrast', theme: 'dark', accent: '#c9d3e6', wallpaper: solid('#000000'), cursorPack: 'highvis' } },
];

// ---------------------------------------------------------------- helpers
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const getPath = (obj, key) => key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
/** Deterministic JSON (sorted object keys) for comparisons. */
export function stableJson(v) {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}
const same = (a, b) => stableJson(a) === stableJson(b);

function stripExcluded(key, value) {
  if (!isObj(value)) return value;
  const out = clone(value);
  for (const ex of PROFILE_EXCLUDE) if (ex.startsWith(`${key}.`)) delete out[ex.slice(key.length + 1)];
  return out;
}

// ---------------------------------------------------------------- validation (import + storage)
const HEX = /^#[0-9a-f]{6}$/i;
const TIME = /^([01]?\d|2[0-3]):[0-5]\d$/;
const int = (lo, hi) => (v) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? Math.round(v) : undefined);
const bool = (v) => (typeof v === 'boolean' ? v : undefined);
const oneOf = (...xs) => (v) => (xs.includes(v) ? v : undefined);
const hex = (v) => (typeof v === 'string' && HEX.test(v) ? v.toLowerCase() : undefined);
// Identifiers (pack ids, widget ids, app ids…): never anything that could break out of CSS, HTML or a URL.
const SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const slug = (v) => (typeof v === 'string' && SLUG.test(v) && !UNSAFE_KEYS.has(v) ? v : undefined);
const CTRL = /[\u0000-\u001f\u007f]/;
/** Free text shown with textContent (names): control characters removed, length bounded. */
const text = (max) => (v) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f<>]+/g, ' ').trim().slice(0, max) : undefined);
const num = (lo, hi) => (v) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : undefined);
/** An absolute local path (no "..", no control characters). */
const localPath = (v) => (typeof v === 'string' && v.startsWith('/') && v.length < 4096 && !CTRL.test(v) && !/(^|\/)\.\.(\/|$)/.test(v) ? v : undefined);
const arrayOf = (fn, max) => (v) => (Array.isArray(v) ? v.slice(0, max).map(fn).filter((x) => x !== undefined) : undefined);
const safePrimitive = (x) => x === null || typeof x === 'boolean' || (typeof x === 'number' && Number.isFinite(x)) || slug(x) !== undefined;
/**
 * An object with known fields (each validated; `required` ones must be valid). Unknown sub-keys are kept
 * only when they are plain safe primitives, so a later area can add a field without losing it on import.
 */
function shape(spec, { required = [] } = {}) {
  return (v) => {
    if (!isObj(v)) return undefined;
    const out = {};
    for (const [k, fn] of Object.entries(spec)) {
      if (!Object.prototype.hasOwnProperty.call(v, k)) {
        if (required.includes(k)) return undefined;
        continue;
      }
      const x = fn(v[k]);
      if (x !== undefined) out[k] = x;
      else if (required.includes(k)) return undefined;
    }
    for (const [k, x] of Object.entries(v)) if (!(k in spec) && slug(k) && safePrimitive(x)) out[k] = x;
    return out;
  };
}
/** A sound reference: null (the pack's sound), 'none', a sound id or an absolute file path. */
const soundRef = (v) => (v === null || v === 'none' ? v : slug(v) ?? (/\.(ogg|oga|opus|wav|mp3|flac|m4a|webm)$/i.test(String(v)) ? localPath(v) : undefined));
/** A keyboard combo in main/lib/hotkeys.js syntax ("Super+Shift+S"), or null (= turned off). */
const combo = (v) => (v === null ? null : typeof v === 'string' && /^[^\s<>"'`(){}\\\u0000-\u001f\u007f]{1,48}$/u.test(v) ? v : undefined);
const zone = shape({ x: num(0, 1), y: num(0, 1), w: num(0.02, 1), h: num(0.02, 1) }, { required: ['x', 'y', 'w', 'h'] });
/** Split tree of a custom snap layout (Settings editor): null = one zone, or { s: 'v'|'h', r: 0.1–0.9, a, b }. */
function splitTree(v, depth = 0, count = { n: 0 }) {
  if (v === null || v === undefined) return ++count.n <= 16 ? null : undefined;
  if (!isObj(v) || depth > 5 || (v.s !== 'v' && v.s !== 'h') || typeof v.r !== 'number' || !(v.r >= 0.1 && v.r <= 0.9)) return undefined;
  const a = splitTree(v.a ?? null, depth + 1, count);
  const b = splitTree(v.b ?? null, depth + 1, count);
  return a === undefined || b === undefined ? undefined : { s: v.s, r: Math.round(v.r * 1000) / 1000, a, b };
}
// Pictures removed by the redesign (same list as main/ipc/settings.js migrate()): profiles saved before it get Nocturne.
const RETIRED_WALLPAPERS = new Set(['builtin:bloom', 'builtin:glow', 'builtin:flow', 'builtin:sunrise', 'builtin:aurora', 'builtin:dunes']);
function wallpaperValue(v) {
  if (typeof v !== 'string' || !v || v.length > 8192) return undefined;
  if (RETIRED_WALLPAPERS.has(v)) return 'builtin:nocturne';
  if (/^builtin:[a-z0-9-]{1,32}$/.test(v)) return v;
  if (localPath(v)) return v;
  if (/^data:image\/(svg\+xml|png|jpeg|webp)[;,]/i.test(v) && !CTRL.test(v) && !/<script|javascript:|on\w+\s*=|<foreignObject|href\s*=/i.test(decodeURIComponentSafe(v))) return v;
  // remote pictures are not accepted: an imported profile must not make the desktop contact a server
  return undefined;
}
function decodeURIComponentSafe(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
/** Validators: return the (normalised) value, or undefined when invalid. */
export const VALIDATORS = {
  // older releases' styles (win11, minimal, glass, retro) become Nocturne
  style: (v) => (LEGACY_STYLES.includes(v) ? 'nocturne' : oneOf(...STYLES.map((s) => s.id))(v)),
  // null = the style's own ambiance (the default)
  ambiance: (v) => (v === null ? null : oneOf(...AMBIANCES.map((a) => a.id))(v)),
  theme: oneOf('light', 'dark'),
  autoTheme: (v) => (isObj(v) && typeof v.enabled === 'boolean' && TIME.test(v.light || '') && TIME.test(v.dark || '') ? { enabled: v.enabled, light: v.light, dark: v.dark } : undefined),
  accent: hex,
  accentFromWallpaper: bool,
  transparency: bool,
  transparencyLevel: int(0, 100),
  blur: int(0, 100),
  cornerRadius: int(0, 200),
  fontFamily: oneOf(...FONTS.map((f) => f.id)),
  textScale: int(80, 150),
  scale: int(100, 200),
  reducedMotion: bool,
  animations: bool,
  'taskbar.color': (v) => (v === null || v === 'accent' ? v : hex(v)),
  'taskbar.opacity': (v) => (v === null ? null : int(0, 100)(v)),
  appThemes: (v) => {
    if (!isObj(v)) return undefined;
    const out = {};
    for (const [id, cfg] of Object.entries(v).slice(0, 300)) {
      if (!slug(id) || !isObj(cfg)) continue;
      const th = ['system', 'light', 'dark'].includes(cfg.theme) ? cfg.theme : 'system';
      const ac = cfg.accent == null ? null : hex(cfg.accent);
      if (ac === undefined) continue;
      out[id] = { theme: th, accent: ac };
    }
    return out;
  },
  wallpaper: wallpaperValue,
  lockWallpaper: (v) => (v === null ? null : wallpaperValue(v)),
  wallpaperFit: oneOf('fill', 'fit', 'stretch', 'center', 'tile'),
  desktopIconSize: oneOf('small', 'medium', 'large'),
  // wallpaper engine (B1)
  wallpaperMode: oneOf('static', 'animated', 'dynamic', 'slideshow'),
  animatedWallpaper: (v) =>
    isObj(v) && EFFECT_IDS.includes(v.id)
      ? { id: v.id, speed: int(0, 100)(v.speed) ?? 50, intensity: int(0, 100)(v.intensity) ?? 50, fps: v.fps === 15 ? 15 : 30, pauseOnMaximized: v.pauseOnMaximized !== false }
      : undefined,
  dynamicWallpaper: (v) => {
    if (!isObj(v)) return undefined;
    const loc = v.location;
    const place =
      loc === null || loc === undefined
        ? null
        : isObj(loc) && Number.isFinite(loc.lat) && Number.isFinite(loc.lon) && Math.abs(loc.lat) <= 90 && Math.abs(loc.lon) <= 180
          ? { name: String(loc.name ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 120), lat: loc.lat, lon: loc.lon }
          : undefined;
    if (place === undefined) return undefined;
    return { source: v.source === 'weather' ? 'weather' : 'time', set: SET_IDS.includes(v.set) ? v.set : SET_IDS[0], location: place, followTheme: v.followTheme === true };
  },
  slideshow: (v) => {
    if (!isObj(v)) return undefined;
    const folder = v.folder == null ? null : typeof v.folder === 'string' && v.folder.startsWith('/') && !v.folder.includes('\0') && !/(^|\/)\.\.(\/|$)/.test(v.folder) && v.folder.length < 4096 ? v.folder : undefined;
    if (folder === undefined) return undefined;
    return { folder, interval: int(1, 1440)(v.interval) ?? 30, shuffle: v.shuffle !== false };
  },
  lockScreen: (v) => (isObj(v) && ['picture', 'spotlight', 'animated'].includes(v.mode) ? { mode: v.mode, effect: EFFECT_IDS.includes(v.effect) ? v.effect : 'aurora' } : undefined),
  'taskbar.align': oneOf('left', 'center'),
  // Reserved keys (docs/PERSONALIZATION.md §1.2): strict by default. The area that implements a key may
  // replace its validator when it changes the schema (edit it here: a second entry with the same name
  // further down would silently win) — never fall back to the generic type check for values that reach
  // CSS, HTML, URLs or the file system. (B1's wallpaper validators are above.)
  // B2 — taskbar, Start, Focus mode
  'taskbar.autohide': bool,
  'taskbar.showSearch': bool,
  'taskbar.showTaskView': bool,
  'taskbar.showWidgets': bool,
  'taskbar.size': oneOf('small', 'medium', 'large'),
  'taskbar.position': oneOf('bottom', 'top', 'left', 'right'),
  'taskbar.showLabels': bool,
  'taskbar.combine': oneOf('always', 'whenFull', 'never'),
  'taskbar.widgets': arrayOf(slug, 16),
  'start.layout': oneOf('default', 'morePins', 'moreRecommended', 'list'),
  'start.background': oneOf('acrylic', 'glass', 'solid', 'accent', 'wallpaper'),
  'start.folders': arrayOf(slug, 16),
  'start.groups': arrayOf(shape({ id: slug, name: text(60), apps: arrayOf(slug, 200) }, { required: ['id'] }), 64),
  startShowRecent: bool,
  focusMode: shape({ active: bool, hideNotifications: bool, dimDesktop: bool, dimLevel: int(0, 100), hideIcons: bool, simplifyTaskbar: bool, duration: int(0, 1440), endsAt: int(0, 8.64e15), prevDnd: (v) => (v === null || typeof v === 'boolean' ? v : undefined) }),
  'taskbar.tray': shape({ network: bool, volume: bool, battery: bool }),
  'taskbar.badges': bool,
  'taskbar.widgetsPos': oneOf('auto', 'start', 'inline', 'end'),
  'taskbar.hideDelay': int(0, 5000),
  showSeconds: bool,
  'start.showRecentApps': bool,
  'start.showMostUsed': bool,
  'taskbar.search': (v) => (v === null || ['hidden', 'icon', 'box'].includes(v) ? v : undefined),
  // B3 — packs and input (ids of core/packs.js CURSOR_PACKS / ICON_PACKS and core/sounds.js SOUND_PACKS; listed here
  // so this module does not import the shell runtime)
  cursorPack: oneOf('default', 'classic', 'midnight', 'accent', 'large', 'highvis', 'retro'),
  cursorSize: int(100, 300),
  iconPack: oneOf('selene', 'fluent', 'tiles', 'accent', 'glass', 'graphite', 'mono', 'outline', 'retro'),
  soundPack: oneOf('aurora', 'chimes', 'retro', 'soft', 'silent'),
  soundEvents: shape({ notification: soundRef, startup: soundRef, shutdown: soundRef }),
  soundVolume: int(0, 100),
  startupSound: bool,
  snapPresets: arrayOf(
    shape(
      {
        id: slug,
        name: text(60),
        // (a layout left with no valid zone is dropped, not kept as an empty tile)
        zones: (v) => { const zs = arrayOf((z) => { const o = zone(z); return o && o.x + o.w <= 1.001 && o.y + o.h <= 1.001 ? o : undefined; }, 16)(v); return zs?.length ? zs : undefined; },
        spec: shape({ kind: oneOf('columns', 'rows', 'main', 'grid', 'custom'), count: int(1, 6), ratio: int(10, 90), side: oneOf('left', 'right'), rows: int(1, 6), tree: splitTree }),
      },
      { required: ['id', 'zones'] },
    ),
    32,
  ),
  snapLayouts: (v) => (v === null ? null : arrayOf(slug, 32)(v)),
  'multitasking.snapLayouts': bool,
  'multitasking.snapBar': bool,
  'multitasking.snapAssist': bool,
  // catalog actions of core/shortcuts.js and 'app:<appId>'; combos checked with the same rules as Settings
  shortcuts: (v) => {
    if (!isObj(v)) return undefined;
    const out = {};
    for (const [id, c] of Object.entries(v).slice(0, 300)) {
      if (UNSAFE_KEYS.has(id) || !(SHORTCUT_IDS.has(id) || isAppAction(id))) continue;
      const x = combo(c);
      if (x === null || (x !== undefined && validCombo(x))) out[id] = x;
    }
    return out;
  },
};

/** Deep copy of plain JSON keeping only inert values: no prototype keys, no strings that could break out of
 *  CSS / HTML / a URL (quotes, brackets, parentheses, backslashes, control characters). */
function inert(v, depth = 0) {
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string') return v.length <= 4096 && !/[<>"'`(){}\\;\u0000-\u001f\u007f]/.test(v) ? v : undefined;
  if (depth > 6) return undefined;
  if (Array.isArray(v)) return v.slice(0, 500).map((x) => inert(x, depth + 1)).filter((x) => x !== undefined);
  if (isObj(v)) {
    const out = {};
    for (const [k, x] of Object.entries(v).slice(0, 500)) {
      if (UNSAFE_KEYS.has(k) || k.length > 64) continue;
      const y = inert(x, depth + 1);
      if (y !== undefined) out[k] = y;
    }
    return out;
  }
  return undefined;
}

/** Generic check for keys without a validator: same JSON type as the default, inert plain JSON, bounded size. */
function genericValid(value, def) {
  let json;
  try {
    json = JSON.stringify(value);
  } catch {
    return undefined;
  }
  if (json === undefined || json.length > 65536) return undefined;
  const type = (x) => (x === null ? 'null' : Array.isArray(x) ? 'array' : typeof x);
  if (def !== undefined && def !== null && value !== null && type(value) !== type(def)) return undefined;
  return inert(JSON.parse(json));
}

/** Validate a values map: unknown keys dropped, invalid values dropped. */
export function sanitizeValues(values, defaults = {}) {
  const out = {};
  if (!isObj(values)) return out;
  for (const key of PROFILE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(values, key)) continue;
    const fn = VALIDATORS[key];
    const v = fn ? fn(values[key]) : genericValid(values[key], getPath(defaults, key));
    if (v !== undefined) out[key] = stripExcluded(key, v);
  }
  return out;
}

// ---------------------------------------------------------------- store
const emitter = new Emitter();
let store = null; // { version: 1, profiles: [...] }
let defaultsCache = null;

async function defaults() {
  if (!defaultsCache) defaultsCache = await api.invoke('settings:defaults').catch(() => ({}));
  return defaultsCache;
}
async function load() {
  if (store) return store;
  const raw = await api.invoke('storage:get', 'shell', 'profiles', null).catch(() => null);
  const defs = await defaults();
  const list = Array.isArray(raw?.profiles) ? raw.profiles : [];
  store = {
    version: 1,
    profiles: list
      .filter((p) => isObj(p) && typeof p.id === 'string' && /^u-[a-z0-9]{4,40}$/.test(p.id))
      .map((p) => ({ id: p.id, name: cleanName(p.name), created: Number(p.created) || Date.now(), updated: Number(p.updated) || Date.now(), values: sanitizeValues(p.values, defs) })),
  };
  return store;
}
async function persist() {
  await api.invoke('storage:set', 'shell', 'profiles', store);
  emitter.emit('change', store.profiles);
}
function cleanName(name, fallback) {
  const s = String(name ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return s || fallback || (i18n.lang === 'fr' ? 'Profil sans nom' : 'Untitled profile');
}
const newId = () => `u-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** Snapshot of the current settings for every PROFILE_KEYS key. */
export function snapshot(all = settings.all()) {
  const out = {};
  for (const key of PROFILE_KEYS) {
    const v = getPath(all, key);
    if (v !== undefined) out[key] = stripExcluded(key, clone(v));
  }
  return out;
}

function builtinValues(p, defs) {
  const out = {};
  for (const key of LOOK_KEYS) out[key] = clone(getPath(defs, key) ?? null);
  return { ...out, ...clone(p.values) };
}

/** { patch, reset } to apply a profile (keys equal to the default are reset to keep settings.json small). */
async function plan(p) {
  const defs = await defaults();
  const values = p.builtin ? builtinValues(p, defs) : p.values;
  const keys = p.builtin ? LOOK_KEYS : PROFILE_KEYS;
  const patch = {};
  const reset = [];
  for (const key of keys) {
    const has = Object.prototype.hasOwnProperty.call(values, key);
    const excluded = PROFILE_EXCLUDE.filter((ex) => ex.startsWith(`${key}.`)).map((ex) => ex.slice(key.length + 1));
    if (excluded.length) {
      // object with runtime sub-keys (focusMode.active): restore the others one by one
      const v = has && isObj(values[key]) ? values[key] : getPath(defs, key) || {};
      for (const [sub, sv] of Object.entries(v)) {
        if (excluded.includes(sub)) continue;
        if (same(sv, getPath(defs, `${key}.${sub}`))) reset.push(`${key}.${sub}`);
        else patch[`${key}.${sub}`] = clone(sv);
      }
      continue;
    }
    // missing from the profile, or equal to the default: back to the default
    if (!has || same(values[key], getPath(defs, key))) reset.push(key);
    else patch[key] = clone(values[key]);
  }
  return { patch, reset };
}

function matches(p, all, defs) {
  const values = p.builtin ? builtinValues(p, defs) : p.values;
  const keys = p.builtin ? LOOK_KEYS : PROFILE_KEYS;
  for (const key of keys) {
    const want = Object.prototype.hasOwnProperty.call(values, key) ? values[key] : getPath(defs, key);
    if (!same(stripExcluded(key, want ?? null), stripExcluded(key, getPath(all, key) ?? null))) return false;
  }
  return true;
}

let applying = null;

export const profiles = {
  PROFILE_KEYS,
  LOOK_KEYS,
  on: (ev, fn) => emitter.on(ev, fn),
  label(p) {
    return p ? i18n.name(p.name) : '';
  },
  async list() {
    const s = await load();
    return [...BUILTIN_PROFILES.map((p) => ({ ...p, builtin: true })), ...s.profiles];
  },
  async get(id) {
    return (await profiles.list()).find((p) => p.id === id) || null;
  },
  /** Effective values of a profile (built-ins: their look over the defaults). */
  async valuesOf(p) {
    return p.builtin ? builtinValues(p, await defaults()) : p.values;
  },
  async saveCurrent(name) {
    const s = await load();
    const p = { id: newId(), name: cleanName(name), created: Date.now(), updated: Date.now(), values: snapshot() };
    s.profiles.push(p);
    await persist();
    return p;
  },
  /** Overwrite a user profile with the current settings. */
  async update(id) {
    const s = await load();
    const p = s.profiles.find((x) => x.id === id);
    if (!p) throw Object.assign(new Error('Unknown profile'), { code: 'ENOENT' });
    p.values = snapshot();
    p.updated = Date.now();
    await persist();
    return p;
  },
  async rename(id, name) {
    const s = await load();
    const p = s.profiles.find((x) => x.id === id);
    if (!p) throw Object.assign(new Error('Unknown profile'), { code: 'ENOENT' });
    p.name = cleanName(name, p.name);
    p.updated = Date.now();
    await persist();
    return p;
  },
  async duplicate(id) {
    const src = await profiles.get(id);
    if (!src) throw Object.assign(new Error('Unknown profile'), { code: 'ENOENT' });
    const s = await load();
    const suffix = i18n.lang === 'fr' ? ' (copie)' : ' (copy)';
    const p = { id: newId(), name: cleanName(`${profiles.label(src)}${suffix}`), created: Date.now(), updated: Date.now(), values: clone(await profiles.valuesOf(src)) };
    s.profiles.push(p);
    await persist();
    return p;
  },
  async remove(id) {
    const s = await load();
    const i = s.profiles.findIndex((x) => x.id === id);
    if (i < 0) return false;
    s.profiles.splice(i, 1);
    await persist();
    return true;
  },
  /** Apply with one click: one atomic settings:setMany, inside a whole-screen cross-fade. */
  async apply(id) {
    const p = typeof id === 'object' && id ? id : await profiles.get(id);
    if (!p) throw Object.assign(new Error('Unknown profile'), { code: 'ENOENT' });
    if (applying) await applying.catch(() => {});
    applying = (async () => {
      const { patch, reset } = await plan(p);
      await theme.transition(() => api.invoke('settings:setMany', patch, { reset }));
      emitter.emit('applied', p);
      return p;
    })();
    try {
      return await applying;
    } finally {
      applying = null;
    }
  },
  /** id of the profile that matches the current settings (user profiles first), or null. */
  async current() {
    const defs = await defaults();
    const all = settings.all();
    const list = await profiles.list();
    const found = [...list.filter((p) => !p.builtin), ...list.filter((p) => p.builtin)].find((p) => matches(p, all, defs));
    return found?.id || null;
  },
  exportJson(p) {
    return JSON.stringify({ format: 'aurora-profile', version: 1, name: profiles.label(p), exported: new Date().toISOString(), values: p.values }, null, 2);
  },
  /** Validate + add an exported profile. Throws (code EINVAL) on a bad file. */
  async importJson(text) {
    if (typeof text !== 'string' || text.length > 262144) throw Object.assign(new Error('File too large'), { code: 'EINVAL' });
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw Object.assign(new Error('Not a JSON file'), { code: 'EINVAL' });
    }
    if (!isObj(data) || data.format !== 'aurora-profile' || data.version !== 1 || !isObj(data.values)) throw Object.assign(new Error('Not a Selene profile'), { code: 'EINVAL' });
    const values = sanitizeValues(data.values, await defaults());
    if (!Object.keys(values).length) throw Object.assign(new Error('The profile has no usable settings'), { code: 'EINVAL' });
    const s = await load();
    const p = { id: newId(), name: cleanName(data.name), created: Date.now(), updated: Date.now(), values };
    s.profiles.push(p);
    await persist();
    return p;
  },
  /** Forget the cached store (tests). */
  _reload() {
    store = null;
    defaultsCache = null;
  },
};

let inited = false;
/** Called once by theme.watchTheme(): exposes theme.profiles and the 'profiles:apply' shell event. */
export function init() {
  if (inited) return;
  inited = true;
  theme.profiles = profiles;
  import('./services.js')
    .then(({ shell }) => {
      shell.on('profiles:apply', (arg) => {
        const id = typeof arg === 'string' ? arg : arg?.id;
        if (id) profiles.apply(id).catch((err) => console.warn('[profiles] apply failed', err.message));
      });
      shell.profiles = shell.profiles || profiles;
    })
    .catch(() => {});
}
