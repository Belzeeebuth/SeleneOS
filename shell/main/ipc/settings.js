'use strict';
// Persistent shell settings + per-app JSON storage.
//
// Settings channels:
//   settings:all                 -> full merged settings object
//   settings:get (key)           -> value at dotted key ('taskbar.align')
//   settings:set (key, value)    -> sets & persists; broadcasts 'settings:changed' {key, value, all}
//   settings:reset (key?)        -> restore default for key (or everything)
//   settings:setMany (patch, { reset })  -> applies { 'dotted.key': value, … } (and resets the keys in
//                                   opts.reset) atomically: one save, ONE 'settings:changed'
//                                   broadcast { key: '*', keys, value: all, all }
//   settings:defaults            -> the defaults (DEFAULTS + /etc/aurora/settings.json)
// Personalization keys are documented in docs/PERSONALIZATION.md.
// App storage channels (~/.config/aurora/apps/<appId>/<name>.json):
//   storage:get (appId, name, fallback)  -> stored JSON value or fallback
//   storage:set (appId, name, value)     -> true
//   storage:delete (appId, name)         -> true
const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_DIR = path.join(os.homedir(), '.config', 'aurora');
const FILE = path.join(CONFIG_DIR, 'settings.json');
const SYSTEM_FILE = '/etc/aurora/settings.json';

const DEFAULTS = {
  theme: 'light', // 'light' | 'dark'
  accent: '#0078d4',
  transparency: true,
  animations: true,
  wallpaper: 'builtin:bloom', // 'builtin:<id>' or absolute image path
  wallpaperFit: 'fill', // fill | fit | stretch | center | tile
  lang: null, // null -> follow system ($LANG); 'en' | 'fr'
  clock24h: null, // null -> locale default
  scale: 100, // display scale % (shell zoom)
  nightLight: false,
  nightLightStrength: 40,
  sounds: true,
  volume: 60,
  desktopIcons: true,
  desktopIconSize: 'medium',
  lockTimeout: 0, // minutes of inactivity before auto-lock, 0 = never
  taskbar: { align: 'center', autohide: false, showSearch: true, showTaskView: true, showWidgets: false },
  pinned: ['files', 'browser', 'mail', 'notepad', 'terminal', 'settings'],
  startPinned: [
    'browser', 'mail', 'files', 'settings', 'calculator', 'paint', 'notepad', 'terminal', 'media',
    'snipping', 'taskmgr', 'minesweeper', 'solitaire', 'snake', 'game2048', 'chess',
  ],
  notifications: { enabled: true, dnd: false, sounds: true },
  defaultApps: {},
  keyboardLayout: null,
  startShowRecent: true,
  showSeconds: false,
  // Settings app (apps/settings) — keys below are applied live by the shell or the backends:
  lockWallpaper: null, // lock screen picture: null = same as the desktop, 'builtin:<id>' or absolute image path
  multitasking: { snap: true, snapLayouts: true, snapBar: true, snapAssist: true, shake: false }, // features/snaplayouts.js (snapBar: layouts bar when dragging a window to the top)
  clipboard: { history: false }, // Win+V clipboard history (features/hotkeys.js)
  mouse: { speed: 0, leftHanded: false }, // pointer acceleration -1..1 and primary button (applied with xinput, main/ipc/locale.js)

  // ---- Personalization (docs/PERSONALIZATION.md). Area A — theme engine (core/theme.js):
  style: 'win11', // visual style: win11 | minimal | glass | retro | contrast
  autoTheme: { enabled: false, light: '07:00', dark: '19:00' }, // "Auto" mode: theme follows the time of day
  accentFromWallpaper: false, // pick the accent colour from the wallpaper
  transparencyLevel: 50, // 0 opaque … 50 Windows 11 look … 100 most see-through (windows, flyouts, taskbar)
  blur: 50, // blur intensity 0–100 (acrylic surfaces + Mica)
  cornerRadius: 100, // rounded-corner intensity, % of the style's radii (0–200)
  fontFamily: 'inter', // inter | system | noto-sans | dejavu-sans | liberation-sans | noto-serif | dejavu-serif | cascadia | unifont
  textScale: 100, // text size % (80–150), independent of the UI scale
  reducedMotion: false, // implies animations off + no animated wallpaper
  appThemes: {}, // { [appId]: { theme: 'system'|'light'|'dark', accent: null|'#rrggbb' } }
  // Area B1 — wallpaper engine (core/features/wallpaper.js, core/wallpaper/):
  wallpaperMode: 'static', // static (picture / solid colour) | animated | dynamic | slideshow
  // effect: aurora | bloom | fluid | bokeh | starfield | waves; speed / intensity 0–100; fps 15 | 30
  animatedWallpaper: { id: 'aurora', speed: 50, intensity: 50, fps: 30, pauseOnMaximized: true },
  // source: time (time of day) | weather (time of day + weather overlay); set: bloom | dunes | lake;
  // location: null (fixed 07:00–19:00 day) | { name, lat, lon }; followTheme: light from sunrise to sunset
  dynamicWallpaper: { source: 'time', set: 'bloom', location: null, followTheme: false },
  slideshow: { folder: null, interval: 30, shuffle: true }, // folder null = the built-in pictures; interval in minutes
  lockScreen: { mode: 'picture', effect: 'aurora' }, // picture (lockWallpaper, null = same as the desktop) | spotlight | animated
  // Area B2 — Start (core/start.js) + Focus mode (core/features/focus.js); taskbar.* additions are merged into `taskbar` below:
  // layout: default | morePins | moreRecommended | list; background: acrylic | solid | accent | wallpaper;
  // folders: shortcuts next to the power button (documents, downloads, music, pictures, videos, files, settings, home, network);
  // groups: app folders in Pinned [{ id: 'g-…', name, apps: [appId] }]
  // showRecentApps / showMostUsed: apps in Recommended (recently added for a week / launched most)
  start: { layout: 'default', background: 'acrylic', folders: [], groups: [], showRecentApps: true, showMostUsed: false },
  // active is runtime state (never in profiles; a new session starts with it off); dimLevel 0–100; duration in minutes (0 = until off)
  // endsAt (ms, 0 = until turned off) and prevDnd (Do not disturb before the session) are runtime state too: a session
  // survives a restart of the shell until endsAt; hideIcons fades the desktop icons
  focusMode: { active: false, hideNotifications: true, dimDesktop: true, dimLevel: 40, hideIcons: false, simplifyTaskbar: true, duration: 0, endsAt: 0, prevDnd: null },
  // Area B3 — packs (core/packs.js, core/sounds.js) + input (core/shortcuts.js, features/hotkeys.js, features/snaplayouts.js):
  cursorPack: 'default', // default (system) | classic | midnight | accent | large | highvis | retro
  cursorSize: 100, // 100–300 (%): size of the pointer (the system pack is drawn as "Aurora light" when > 100)
  iconPack: 'fluent', // fluent (the apps' own icons) | tiles | accent | graphite | mono | outline | glass | retro
  soundPack: 'aurora', // aurora | chimes | retro | soft | silent
  soundEvents: { notification: null, startup: null, shutdown: null }, // null = pack sound, 'none' = silent, '<pack>.<sound>', '/abs/file.ogg'
  soundVolume: 100, // 0–100: volume of the system sounds (multiplies every pack sound and sound file)
  startupSound: true, // play the startup sound when the session starts
  snapPresets: [], // [{ id, name, zones: [{ x, y, w, h }] }] (fractions of the work area)
  snapLayouts: null, // null = the six Windows 11 layouts then every preset; else the ordered ids shown (features/snaplayouts.js)
  shortcuts: {}, // { [actionId]: 'Super+K' | null } — overrides of core/shortcuts.js SHORTCUTS (null = turned off); 'app:<appId>' = open an app
};
// Personalization keys of the taskbar (Area A: color/opacity; Area B2: the rest), merged into DEFAULTS.taskbar.
Object.assign(DEFAULTS.taskbar, {
  color: null, // null = theme default | 'accent' | '#rrggbb'
  opacity: null, // null = follows transparencyLevel | 0–100
  size: 'medium', // small | medium | large
  position: 'bottom', // bottom | top | left | right
  showLabels: false, // app names next to the icons (horizontal taskbars)
  combine: 'always', // always | whenFull | never (one button per window)
  widgets: [], // tray mini widgets: 'weather' | 'cpu' | 'memory' | 'network'
  search: null, // null = follows showSearch | 'hidden' | 'icon' | 'box'
  tray: { network: true, volume: true, battery: true }, // status icons shown next to the clock
  badges: true, // unread-notification counts on app buttons
  widgetsPos: 'auto', // auto (start when centered, end when left-aligned) | start | inline (after Task view) | end (before the tray)
  hideDelay: 600, // ms an auto-hidden taskbar stays after the pointer leaves it
});

function isObj(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

// Keys that would reach Object.prototype through setPath / delete (prototype pollution of the main process).
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
/** A dotted settings key that is safe to walk: non-empty segments, no prototype names. */
function validKey(key) {
  return typeof key === 'string' && key.length > 0 && key.length <= 200 && key.split('.').every((p) => p && !UNSAFE_KEYS.has(p));
}

function deepMerge(a, b) {
  if (!isObj(b)) return b === undefined ? a : b;
  const out = { ...(isObj(a) ? a : {}) };
  for (const [k, v] of Object.entries(b)) {
    if (UNSAFE_KEYS.has(k)) continue;
    out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function getPath(obj, key) {
  if (!key) return obj;
  return key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function setPath(obj, key, value) {
  if (!validKey(key)) return;
  const parts = key.split('.');
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!Object.prototype.hasOwnProperty.call(o, parts[i]) || !isObj(o[parts[i]])) o[parts[i]] = {};
    o = o[parts[i]];
  }
  o[parts[parts.length - 1]] = value;
}

/** Remove a user override (dotted key); never walks into inherited properties. */
function deletePath(obj, key) {
  if (!validKey(key)) return;
  const parts = key.split('.');
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!isObj(o) || !Object.prototype.hasOwnProperty.call(o, parts[i])) return;
    o = o[parts[i]];
  }
  if (isObj(o)) delete o[parts[parts.length - 1]];
}

function safeName(s) {
  return String(s).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || '_';
}

module.exports = function register(api) {
  const base = deepMerge(DEFAULTS, readJson(SYSTEM_FILE, {}));
  // user overrides only (so new defaults reach existing users)
  let user = readJson(FILE, {});
  const merged = () => deepMerge(base, user);
  let saveTimer = null;
  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        writeJsonAtomic(FILE, user);
      } catch (err) {
        console.error('[settings] save failed', err);
      }
    }, 150);
  };

  // Main-process access for other backend modules (e.g. locale:setKeyboard persists keyboardLayout).
  api.settings = {
    get: (key) => getPath(merged(), key),
    set: (key, value) => {
      if (!validKey(key)) throw api.error('Invalid settings key', 'EINVAL');
      setPath(user, key, value);
      save();
      const all = merged();
      api.broadcast('settings:changed', { key, value: getPath(all, key), all });
      return getPath(all, key);
    },
  };

  api.handle('settings:all', () => merged());
  api.handle('settings:defaults', () => base);
  api.handle('settings:get', (key) => getPath(merged(), key));
  api.handle('settings:set', (key, value) => {
    if (!validKey(key)) throw api.error('Invalid settings key', 'EINVAL');
    setPath(user, key, value);
    save();
    const all = merged();
    api.broadcast('settings:changed', { key, value: getPath(all, key), all });
    return getPath(all, key);
  });
  // Several keys at once (profiles, the Theme designer): one save, one broadcast.
  api.handle('settings:setMany', (patch, opts = {}) => {
    if (!isObj(patch)) throw api.error('Invalid settings patch', 'EINVAL');
    const reset = Array.isArray(opts?.reset) ? opts.reset : [];
    const keys = [];
    for (const key of [...Object.keys(patch), ...reset]) {
      if (!validKey(key)) throw api.error(`Invalid settings key ${String(key).slice(0, 80)}`, 'EINVAL');
    }
    for (const key of reset) {
      deletePath(user, key);
      keys.push(key);
    }
    for (const [key, value] of Object.entries(patch)) {
      setPath(user, key, value);
      if (!keys.includes(key)) keys.push(key);
    }
    save();
    const all = merged();
    api.broadcast('settings:changed', { key: '*', keys, value: all, all });
    return all;
  });
  api.handle('settings:reset', (key) => {
    if (!key) user = {};
    else if (!validKey(key)) throw api.error('Invalid settings key', 'EINVAL');
    else deletePath(user, key);
    save();
    const all = merged();
    api.broadcast('settings:changed', { key: key || '*', value: key ? getPath(all, key) : all, all });
    return all;
  });

  const storeFile = (appId, name) => path.join(CONFIG_DIR, 'apps', safeName(appId), `${safeName(name)}.json`);
  api.handle('storage:get', (appId, name, fallback = null) => readJson(storeFile(appId, name), fallback));
  api.handle('storage:set', (appId, name, value) => {
    writeJsonAtomic(storeFile(appId, name), value);
    return true;
  });
  api.handle('storage:delete', (appId, name) => {
    try {
      fs.unlinkSync(storeFile(appId, name));
    } catch {}
    return true;
  });
  api.handle('storage:dir', (appId) => {
    const d = path.join(CONFIG_DIR, 'apps', safeName(appId));
    fs.mkdirSync(d, { recursive: true });
    return d;
  });
};

module.exports.DEFAULTS = DEFAULTS;
