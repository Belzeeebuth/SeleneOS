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
import { theme, STYLES, FONTS } from './theme.js';
import { i18n } from './i18n.js';

/** Every settings key a profile saves and restores (dotted keys are sub-keys). */
export const PROFILE_KEYS = [
  // Area A — theme engine
  'style', 'theme', 'autoTheme', 'accent', 'accentFromWallpaper', 'transparency', 'transparencyLevel', 'blur',
  'cornerRadius', 'fontFamily', 'textScale', 'scale', 'reducedMotion', 'animations', 'taskbar.color', 'taskbar.opacity', 'appThemes',
  // wallpapers (B1)
  'wallpaper', 'wallpaperFit', 'lockWallpaper', 'wallpaperMode', 'animatedWallpaper', 'dynamicWallpaper',
  // taskbar + Start + Focus mode (B2)
  'taskbar.align', 'taskbar.autohide', 'taskbar.showSearch', 'taskbar.showTaskView', 'taskbar.showWidgets',
  'taskbar.size', 'taskbar.position', 'taskbar.showLabels', 'taskbar.combine', 'taskbar.widgets',
  'start.layout', 'start.background', 'start.folders', 'start.groups', 'startShowRecent', 'focusMode',
  // packs + input (B3)
  'cursorPack', 'iconPack', 'soundPack', 'soundEvents', 'snapPresets', 'shortcuts',
  // desktop
  'desktopIconSize',
];
/** Sub-keys never saved in a profile (runtime state). */
export const PROFILE_EXCLUDE = ['focusMode.active'];
/** The "look": what a built-in profile sets (every other key is left alone — text size, scale, layout…). */
export const LOOK_KEYS = [
  'style', 'theme', 'autoTheme', 'accent', 'accentFromWallpaper', 'transparencyLevel', 'blur', 'cornerRadius', 'fontFamily',
  'taskbar.color', 'taskbar.opacity', 'wallpaper', 'wallpaperFit', 'wallpaperMode', 'cursorPack', 'iconPack', 'soundPack',
];

const solid = (c) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="10"><rect width="16" height="10" fill="${c}"/></svg>`)}`;

export const BUILTIN_PROFILES = [
  { id: 'aurora-light', name: { en: 'Aurora Light', fr: 'Aurora clair' }, values: { style: 'win11', theme: 'light', accent: '#0078d4', wallpaper: 'builtin:bloom' } },
  { id: 'aurora-dark', name: { en: 'Aurora Dark', fr: 'Aurora sombre' }, values: { style: 'win11', theme: 'dark', accent: '#0078d4', wallpaper: 'builtin:bloom' } },
  { id: 'glass', name: { en: 'Glass', fr: 'Verre' }, values: { style: 'glass', theme: 'dark', accent: '#b146c2', wallpaper: 'builtin:glow', transparencyLevel: 60, blur: 60 } },
  { id: 'minimal', name: { en: 'Minimal', fr: 'Minimal' }, values: { style: 'minimal', theme: 'light', accent: '#5d5a58', wallpaper: solid('#d9d6cf'), cornerRadius: 75 } },
  { id: 'retro', name: { en: 'Retro', fr: 'Rétro' }, values: { style: 'retro', theme: 'light', accent: '#1f3f99', wallpaper: solid('#2a7c7a'), fontFamily: 'liberation-sans' } },
  { id: 'contrast', name: { en: 'High Contrast', fr: 'Contraste élevé' }, values: { style: 'contrast', theme: 'dark', accent: '#0078d4', wallpaper: solid('#000000') } },
  { id: 'night-owl', name: { en: 'Night Owl', fr: 'Oiseau de nuit' }, values: { style: 'win11', theme: 'dark', accent: '#6b69d6', wallpaper: 'builtin:aurora', transparencyLevel: 65, blur: 70, 'taskbar.color': 'accent' } },
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
function wallpaperValue(v) {
  if (typeof v !== 'string' || !v || v.length > 8192) return undefined;
  if (/^builtin:[a-z0-9-]{1,32}$/.test(v)) return v;
  if (v.startsWith('/') && !v.includes('\0') && !/(^|\/)\.\.(\/|$)/.test(v) && v.length < 4096) return v;
  if (/^data:image\/(svg\+xml|png|jpeg|webp);?/i.test(v) && !/<script|javascript:|on\w+=/i.test(decodeURIComponentSafe(v))) return v;
  if (/^https?:\/\//i.test(v) && v.length < 2048) return v;
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
  style: oneOf(...STYLES.map((s) => s.id)),
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
      if (!/^[a-z0-9._-]{1,64}$/i.test(id) || !isObj(cfg)) continue;
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
  'taskbar.align': oneOf('left', 'center'),
};

/** Generic check for keys without a validator: same JSON type as the default, plain JSON, bounded size. */
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
  return JSON.parse(json);
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
    if (!isObj(data) || data.format !== 'aurora-profile' || data.version !== 1 || !isObj(data.values)) throw Object.assign(new Error('Not an Aurora profile'), { code: 'EINVAL' });
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
