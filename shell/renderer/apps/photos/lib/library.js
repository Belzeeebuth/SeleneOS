// Photos library, shared by every Photos window (module state lives in the shell page).
//   lib.items            -> all images of the library folders, newest first
//   lib.scan()           -> rescan (incremental: unchanged files come from the backend index)
//   favorites / albums / user folders / preferences, persisted in the app storage
//   lib.on(fn)           -> fn(event) with event = 'items' | 'favorites' | 'albums' | 'folders' | 'prefs' | 'scanning'
import { sortItems, uid, dirName } from './util.js';

export const DEFAULT_PREFS = {
  thumbSize: 'medium', // small | medium | large
  layout: 'justified', // justified | square
  includePictures: true,
  slideshowInterval: 5, // seconds
  slideshowTransition: 'crossfade', // crossfade | kenburns
  slideshowShuffle: false,
  slideshowLoop: true,
  jpegQuality: 92,
  confirmDelete: true,
  viewerBackground: 'dark', // dark | theme
  filmstrip: true,
  navCollapsed: false,
};

class Library {
  constructor(api, storage) {
    this.api = api;
    this.storage = storage;
    this.items = [];
    this.byPath = new Map();
    this.favorites = new Set();
    this.albums = [];
    this.folders = [];
    this.prefs = { ...DEFAULT_PREFS };
    this.scanned = false;
    this.scanning = false;
    this.errors = [];
    this.subs = new Set();
    this._loaded = null;
    this._scanP = null;
    this._rescan = false;
    this._watchId = null;
    this._offChanged = null;
    this.users = 0;
  }

  on(fn) {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }
  emit(ev, data) {
    for (const fn of [...this.subs]) {
      try {
        fn(ev, data);
      } catch (err) {
        console.error('[photos] listener failed', err);
      }
    }
  }

  load() {
    if (!this._loaded) {
      this._loaded = (async () => {
        const [xdg, fav, albums, folders, prefs] = await Promise.all([
          this.api.invoke('fs:xdg').catch(() => null),
          this.storage.get('favorites', []).catch(() => []),
          this.storage.get('albums', []).catch(() => []),
          this.storage.get('folders', []).catch(() => []),
          this.storage.get('prefs', {}).catch(() => ({})),
        ]);
        this.xdg = xdg || {};
        this.favorites = new Set(Array.isArray(fav) ? fav.filter((p) => typeof p === 'string') : []);
        this.albums = (Array.isArray(albums) ? albums : [])
          .filter((a) => a && typeof a.id === 'string' && typeof a.name === 'string')
          .map((a) => ({ id: a.id, name: a.name.slice(0, 200), items: Array.isArray(a.items) ? [...new Set(a.items.filter((p) => typeof p === 'string'))] : [], cover: typeof a.cover === 'string' ? a.cover : null, created: Number(a.created) || Date.now() }));
        this.folders = (Array.isArray(folders) ? folders : []).filter((p) => typeof p === 'string' && p.startsWith('/'));
        if (prefs && typeof prefs === 'object') {
          for (const k of Object.keys(DEFAULT_PREFS)) if (prefs[k] !== undefined && typeof prefs[k] === typeof DEFAULT_PREFS[k]) this.prefs[k] = prefs[k];
        }
      })();
    }
    return this._loaded;
  }

  get pictures() {
    return this.xdg?.pictures || `${this.xdg?.home || ''}/Pictures`;
  }

  roots() {
    const r = [];
    if (this.prefs.includePictures !== false) r.push(this.pictures);
    for (const f of this.folders) if (!r.includes(f)) r.push(f);
    return r;
  }

  /** Scan once (first gallery view); later calls return the same promise unless forced. */
  ensureScanned() {
    if (this.scanned || this._scanP) return this._scanP || Promise.resolve();
    return this.scan();
  }

  scan() {
    if (this._scanP) {
      this._rescan = true;
      return this._scanP;
    }
    this.scanning = true;
    this.emit('scanning', true);
    this._scanP = (async () => {
      try {
        do {
          this._rescan = false;
          const roots = this.roots();
          const res = roots.length ? await this.api.invoke('photos:scan', roots, { prune: true }) : { items: [], errors: [] };
          this.errors = res.errors || [];
          this._setItems(res.items || []);
        } while (this._rescan);
        this.scanned = true;
        this._watch();
      } catch (err) {
        console.error('[photos] scan failed', err);
        this.errors = [{ path: '', message: String(err?.message || err) }];
        this.scanned = true;
        this.emit('items');
      } finally {
        this.scanning = false;
        this._scanP = null;
        this.emit('scanning', false);
      }
    })();
    return this._scanP;
  }

  _setItems(items) {
    // Keep object identity for unchanged files (open viewers / selections hold references).
    const next = [];
    const map = new Map();
    for (const it of items) {
      const old = this.byPath.get(it.path);
      const keep = old && old.key === it.key ? Object.assign(old, { thumb: old.thumb || it.thumb, taken: it.taken, w: old.w || it.w, h: old.h || it.h }) : it;
      next.push(keep);
      map.set(keep.path, keep);
    }
    this.items = sortItems(next);
    this.byPath = map;
    this.emit('items');
  }

  async _watch() {
    const roots = this.roots();
    const sig = roots.join('\n');
    if (this._watchSig === sig) return;
    this._watchSig = sig;
    if (this._watchId) this.api.invoke('photos:unwatch', this._watchId).catch(() => {});
    this._watchId = null;
    if (!roots.length) return;
    try {
      this._watchId = await this.api.invoke('photos:watch', roots);
    } catch {}
    if (!this._offChanged) {
      this._offChanged = this.api.on('photos:changed', (e) => {
        if (e?.watchId === this._watchId && this.users > 0) this._debouncedScan();
      });
    }
  }
  _debouncedScan() {
    clearTimeout(this._dt);
    this._dt = setTimeout(() => this.scan(), 300);
  }

  retain() {
    this.users++;
  }
  release() {
    this.users = Math.max(0, this.users - 1);
    if (!this.users && this._watchId) {
      this.api.invoke('photos:unwatch', this._watchId).catch(() => {});
      this._watchId = null;
      this._watchSig = null;
      this.scanned = false; // next window rescans (and re-watches)
    }
  }

  get(path) {
    return this.byPath.get(path) || null;
  }

  /** Items for paths (library objects when known, else fetched from the backend). */
  async resolve(paths) {
    const out = paths.map((p) => this.byPath.get(p) || null);
    const missing = paths.filter((p, i) => !out[i]);
    if (missing.length) {
      const got = await this.api.invoke('photos:items', missing).catch(() => []);
      const m = new Map(got.filter(Boolean).map((x) => [x.path, x]));
      for (let i = 0; i < paths.length; i++) if (!out[i]) out[i] = m.get(paths[i]) || null;
    }
    return out.filter(Boolean);
  }

  // ---------------------------------------------------------------- prefs
  setPref(k, v) {
    this.prefs[k] = v;
    this.storage.set('prefs', this.prefs).catch(() => {});
    this.emit('prefs', k);
    if (k === 'includePictures') this.scan();
  }

  // ---------------------------------------------------------------- favorites
  isFavorite(p) {
    return this.favorites.has(p);
  }
  setFavorite(paths, on) {
    for (const p of paths) on ? this.favorites.add(p) : this.favorites.delete(p);
    this.storage.set('favorites', [...this.favorites]).catch(() => {});
    this.emit('favorites');
  }
  toggleFavorite(paths) {
    const allFav = paths.every((p) => this.favorites.has(p));
    this.setFavorite(paths, !allFav);
    return !allFav;
  }
  favoriteItems() {
    return this.items.filter((it) => this.favorites.has(it.path));
  }

  // ---------------------------------------------------------------- albums
  _saveAlbums() {
    this.storage.set('albums', this.albums).catch(() => {});
    this.emit('albums');
  }
  album(id) {
    return this.albums.find((a) => a.id === id) || null;
  }
  createAlbum(name, paths = []) {
    const a = { id: uid(), name: String(name).trim().slice(0, 200), items: [...new Set(paths)], cover: null, created: Date.now() };
    this.albums.unshift(a);
    this._saveAlbums();
    return a;
  }
  renameAlbum(id, name) {
    const a = this.album(id);
    if (!a) return;
    a.name = String(name).trim().slice(0, 200);
    this._saveAlbums();
  }
  deleteAlbum(id) {
    this.albums = this.albums.filter((a) => a.id !== id);
    this._saveAlbums();
  }
  addToAlbum(id, paths) {
    const a = this.album(id);
    if (!a) return 0;
    const before = a.items.length;
    for (const p of paths) if (!a.items.includes(p)) a.items.push(p);
    this._saveAlbums();
    return a.items.length - before;
  }
  removeFromAlbum(id, paths) {
    const a = this.album(id);
    if (!a) return;
    const set = new Set(paths);
    a.items = a.items.filter((p) => !set.has(p));
    if (a.cover && set.has(a.cover)) a.cover = null;
    this._saveAlbums();
  }
  setCover(id, path) {
    const a = this.album(id);
    if (!a) return;
    a.cover = path;
    this._saveAlbums();
  }
  albumCover(a) {
    return (a.cover && this.byPath.get(a.cover)) || a.items.map((p) => this.byPath.get(p)).find(Boolean) || null;
  }

  // ---------------------------------------------------------------- folders
  addFolder(dir) {
    if (!dir || this.folders.includes(dir) || (this.prefs.includePictures !== false && dir === this.pictures)) return false;
    this.folders.push(dir);
    this.storage.set('folders', this.folders).catch(() => {});
    this.emit('folders');
    this.scan();
    return true;
  }
  removeFolder(dir) {
    this.folders = this.folders.filter((f) => f !== dir);
    this.storage.set('folders', this.folders).catch(() => {});
    this.emit('folders');
    this.scan();
  }
  /** Root folder (library location) that contains a path. */
  rootOf(p) {
    return this.roots().find((r) => p === r || p.startsWith(`${r}/`)) || dirName(p);
  }

  // ---------------------------------------------------------------- file changes made by the app
  /** Files deleted / moved to the trash: drop them from the library, favorites and albums. */
  removed(paths) {
    const set = new Set(paths);
    this.items = this.items.filter((it) => !set.has(it.path));
    for (const p of paths) this.byPath.delete(p);
    let fav = false;
    for (const p of paths) if (this.favorites.delete(p)) fav = true;
    if (fav) this.storage.set('favorites', [...this.favorites]).catch(() => {});
    let alb = false;
    for (const a of this.albums) {
      const n = a.items.length;
      a.items = a.items.filter((p) => !set.has(p));
      if (a.cover && set.has(a.cover)) a.cover = null;
      if (a.items.length !== n) alb = true;
    }
    if (alb) this._saveAlbums();
    this.emit('items');
    if (fav) this.emit('favorites');
  }
  /** Merge fresh metadata for one file (after a save / rotate); adds it when it lives in a library folder. */
  applyItem(n) {
    if (!n?.path) return null;
    const old = this.byPath.get(n.path);
    if (old) {
      if (old !== n) Object.assign(old, n);
    } else if (this.roots().some((r) => n.path.startsWith(`${r}/`))) {
      this.items.push(n);
      this.byPath.set(n.path, n);
    } else return n;
    this.items = sortItems(this.items);
    this.emit('items');
    return this.byPath.get(n.path);
  }

  /** A file was renamed: carry favorites and album membership over to the new path. */
  renamed(oldPath, n) {
    const old = this.byPath.get(oldPath);
    if (old) {
      this.byPath.delete(oldPath);
      Object.assign(old, n);
      this.byPath.set(old.path, old);
    }
    if (this.favorites.delete(oldPath)) {
      this.favorites.add(n.path);
      this.storage.set('favorites', [...this.favorites]).catch(() => {});
    }
    let alb = false;
    for (const a of this.albums) {
      const i = a.items.indexOf(oldPath);
      if (i >= 0) {
        a.items[i] = n.path;
        alb = true;
      }
      if (a.cover === oldPath) a.cover = n.path;
    }
    if (alb) this._saveAlbums();
    this.items = sortItems(this.items);
    this.emit('items');
  }

  /** A file was rewritten (rotate, save): refresh its metadata from the backend. */
  async changed(path) {
    const [it] = await this.api.invoke('photos:items', [path]).catch(() => []);
    if (!it) return null;
    const old = this.byPath.get(path);
    if (old) {
      Object.assign(old, it);
      this.items = sortItems(this.items);
    } else if (this.roots().some((r) => path.startsWith(`${r}/`))) {
      this.items.push(it);
      this.byPath.set(path, it);
      this.items = sortItems(this.items);
    }
    this.emit('items');
    return old || it;
  }
}

let shared = null;
export function sharedLibrary(api, storage) {
  if (!shared) shared = new Library(api, storage);
  return shared;
}
