// State shared by every File Explorer window of the session (ES modules are evaluated once):
// preferences, Quick access pins, favorites, recently opened files, per-folder view settings,
// the undo stack and the drag & drop payload in flight. Persisted through ctx.storage.
import { Emitter } from '../../../core/api.js';

export const DND_MIME = 'application/x-aurora-paths';

export const PREF_DEFAULTS = {
  hidden: false, // show hidden (dot) files
  extensions: true, // show file name extensions
  navPane: true,
  pane: null, // null | 'details' | 'preview'
  compact: false,
  checkboxes: false,
  startAt: 'home', // 'home' | 'thispc'
  singleClick: false,
  showRecent: true,
  showFavorites: true,
  fullPathTitle: false,
  confirmTrash: false,
  foldersFirst: true,
  navWidth: 232,
  paneWidth: 300,
};

const VIEW_DEFAULT = { mode: 'details', sort: 'name', dir: 1, group: 'none' };

export const shared = {
  ready: null,
  ctx: null,
  t: (k) => k,
  home: '/',
  user: 'user',
  xdg: null,
  prefs: { ...PREF_DEFAULTS },
  pinned: [],
  favorites: [],
  recent: [],
  views: {},
  columns: {},
  events: new Emitter(),
  undo: [],
  drag: null, // { paths, sourceWin } while an internal drag is in flight
  drives: [],
  mounts: new Map(), // dir -> mountpoint cache
};

const saveTimers = {};
function persist(name) {
  clearTimeout(saveTimers[name]);
  saveTimers[name] = setTimeout(() => {
    shared.ctx?.storage.set(name, shared[name]).catch((err) => console.warn('[files] could not save', name, err));
  }, 250);
}

export function initShared(ctx) {
  if (shared.ready) return shared.ready;
  shared.ctx = ctx;
  shared.t = ctx.t;
  shared.ready = (async () => {
    const [xdg, prefs, pinned, favorites, recent, views, columns] = await Promise.all([
      ctx.api.invoke('fs:xdg'),
      ctx.storage.get('prefs', null),
      ctx.storage.get('pinned', null),
      ctx.storage.get('favorites', []),
      ctx.storage.get('recent', []),
      ctx.storage.get('views', {}),
      ctx.storage.get('columns', {}),
    ]);
    shared.xdg = xdg;
    shared.home = xdg.home;
    shared.user = ctx.env?.user || xdg.home.split('/').pop() || 'user';
    shared.prefs = { ...PREF_DEFAULTS, ...(prefs || {}) };
    shared.pinned = Array.isArray(pinned) ? pinned : [xdg.desktop, xdg.downloads, xdg.documents, xdg.pictures, xdg.music, xdg.videos];
    shared.favorites = Array.isArray(favorites) ? favorites : [];
    shared.recent = Array.isArray(recent) ? recent : [];
    shared.views = views && typeof views === 'object' ? views : {};
    shared.columns = columns && typeof columns === 'object' ? columns : {};
    ctx.api.invoke('files:drivesWatch').catch(() => {});
    refreshDrives();
    ctx.api.on('files:drives-changed', () => refreshDrives());
  })();
  return shared.ready;
}

export async function refreshDrives() {
  try {
    shared.drives = await shared.ctx.api.invoke('fs:drives');
  } catch {
    shared.drives = [];
  }
  shared.mounts.clear();
  shared.events.emit('drives', shared.drives);
  return shared.drives;
}

export function setPref(key, value) {
  if (shared.prefs[key] === value) return;
  shared.prefs[key] = value;
  persist('prefs');
  shared.events.emit('prefs', key, value);
}

// ---------------------------------------------------------------- Quick access / favorites / recent
export function isPinned(p) {
  return shared.pinned.includes(p);
}
export function pin(p) {
  if (isPinned(p)) return;
  shared.pinned = [...shared.pinned, p];
  persist('pinned');
  shared.events.emit('pins');
}
export function unpin(p) {
  shared.pinned = shared.pinned.filter((x) => x !== p);
  persist('pinned');
  shared.events.emit('pins');
}
export function movePin(p, toIndex) {
  const list = shared.pinned.filter((x) => x !== p);
  list.splice(Math.max(0, Math.min(list.length, toIndex)), 0, p);
  shared.pinned = list;
  persist('pinned');
  shared.events.emit('pins');
}
export function isFavorite(p) {
  return shared.favorites.includes(p);
}
export function toggleFavorite(p, on = !isFavorite(p)) {
  shared.favorites = on ? [...new Set([p, ...shared.favorites])] : shared.favorites.filter((x) => x !== p);
  persist('favorites');
  shared.events.emit('favorites');
}
export function addRecent(p) {
  shared.recent = [{ path: p, time: Date.now() }, ...shared.recent.filter((r) => r.path !== p)].slice(0, 40);
  persist('recent');
  shared.events.emit('recent');
}
export function removeRecent(p) {
  shared.recent = shared.recent.filter((r) => r.path !== p);
  persist('recent');
  shared.events.emit('recent');
}
export function clearHistory() {
  shared.recent = [];
  persist('recent');
  shared.events.emit('recent');
}

// When files move or get renamed, keep pins / favorites / recent pointing at them.
export function renamePaths(from, to) {
  const fix = (p) => (p === from ? to : p.startsWith(`${from}/`) ? to + p.slice(from.length) : p);
  let changed = false;
  const pinned = shared.pinned.map(fix);
  if (pinned.join('\n') !== shared.pinned.join('\n')) {
    shared.pinned = pinned;
    persist('pinned');
    changed = true;
  }
  const fav = shared.favorites.map(fix);
  if (fav.join('\n') !== shared.favorites.join('\n')) {
    shared.favorites = fav;
    persist('favorites');
    changed = true;
  }
  const rec = shared.recent.map((r) => ({ ...r, path: fix(r.path) }));
  if (rec.some((r, i) => r.path !== shared.recent[i].path)) {
    shared.recent = rec;
    persist('recent');
    changed = true;
  }
  if (changed) {
    shared.events.emit('pins');
    shared.events.emit('favorites');
    shared.events.emit('recent');
  }
}

// ---------------------------------------------------------------- per-folder view settings
export function viewDefaults(locKey) {
  const x = shared.xdg || {};
  if (locKey === 'trash') return { ...VIEW_DEFAULT, sort: 'deleted', dir: -1 };
  if (locKey === 'gallery') return { ...VIEW_DEFAULT, mode: 'medium', sort: 'mtime', dir: -1 };
  if (locKey === x.pictures || locKey === x.videos) return { ...VIEW_DEFAULT, mode: 'large' };
  if (locKey === x.downloads) return { ...VIEW_DEFAULT, sort: 'mtime', dir: -1, group: 'mtime' };
  if (locKey.startsWith('search:')) return { ...VIEW_DEFAULT };
  return { ...VIEW_DEFAULT };
}
export function getView(locKey) {
  const v = shared.views[locKey] || shared.views['*'];
  return { ...viewDefaults(locKey), ...(v || {}) };
}
export function setView(locKey, patch) {
  const key = locKey.startsWith('search:') ? 'search:' : locKey;
  shared.views[key] = { ...getView(key), ...patch, at: Date.now() };
  const keys = Object.keys(shared.views);
  if (keys.length > 400) {
    keys.sort((a, b) => (shared.views[a].at || 0) - (shared.views[b].at || 0));
    for (const k of keys.slice(0, keys.length - 400)) delete shared.views[k];
  }
  persist('views');
}
export function resetViews() {
  shared.views = {};
  persist('views');
  shared.events.emit('views');
}

export function getColumns(set, defaults) {
  const saved = shared.columns[set];
  if (!saved) return defaults.map((c) => ({ ...c }));
  return defaults.map((c) => ({ ...c, ...(saved[c.id] || {}) }));
}
export function saveColumns(set, cols) {
  shared.columns[set] = Object.fromEntries(cols.map((c) => [c.id, { width: c.width, hidden: !!c.hidden }]));
  persist('columns');
}

// ---------------------------------------------------------------- undo stack (session wide, like Windows)
export function pushUndo(op) {
  shared.undo.push({ ...op, time: Date.now() });
  if (shared.undo.length > 50) shared.undo.shift();
  shared.events.emit('undo');
}
export function peekUndo() {
  return shared.undo[shared.undo.length - 1] || null;
}
export function popUndo() {
  const op = shared.undo.pop() || null;
  shared.events.emit('undo');
  return op;
}

// Mount point of a folder (from the cached drive list) — decides move vs copy for drag & drop.
export function mountOf(p) {
  let best = '/';
  for (const d of shared.drives) {
    const m = d.mountpoint;
    if (!m) continue;
    if ((p === m || p.startsWith(m === '/' ? '/' : `${m}/`)) && m.length > best.length) best = m;
  }
  return best;
}
