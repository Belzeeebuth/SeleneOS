'use strict';
// Persistent shell settings + per-app JSON storage.
//
// Settings channels:
//   settings:all                 -> full merged settings object
//   settings:get (key)           -> value at dotted key ('taskbar.align')
//   settings:set (key, value)    -> sets & persists; broadcasts 'settings:changed' {key, value, all}
//   settings:reset (key?)        -> restore default for key (or everything)
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
  mouse: { speed: 0, leftHanded: false }, // pointer acceleration -1..1 and primary button (applied with xinput, main/ipc/locale.js)
};

function isObj(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(a, b) {
  if (!isObj(b)) return b === undefined ? a : b;
  const out = { ...(isObj(a) ? a : {}) };
  for (const [k, v] of Object.entries(b)) out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : v;
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
  const parts = key.split('.');
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!isObj(o[parts[i]])) o[parts[i]] = {};
    o = o[parts[i]];
  }
  o[parts[parts.length - 1]] = value;
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
    if (typeof key !== 'string' || !key) throw api.error('Invalid settings key', 'EINVAL');
    setPath(user, key, value);
    save();
    const all = merged();
    api.broadcast('settings:changed', { key, value: getPath(all, key), all });
    return getPath(all, key);
  });
  api.handle('settings:reset', (key) => {
    if (!key) user = {};
    else {
      const parts = key.split('.');
      const parent = parts.length > 1 ? getPath(user, parts.slice(0, -1).join('.')) : user;
      if (isObj(parent)) delete parent[parts[parts.length - 1]];
    }
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
