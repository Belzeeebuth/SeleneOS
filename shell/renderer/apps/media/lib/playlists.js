// Media Player playlists, persisted with ctx.storage('playlists').
//   const pls = new Playlists(storage); await pls.load();
//   pls.list() pls.get(id) pls.create(name, paths) pls.rename(id, name) pls.remove(id)
//   pls.add(id, paths) pls.removeAt(id, i) pls.move(id, from, to) pls.on(fn)
export class Playlists {
  constructor(storage) {
    this.storage = storage;
    this.items = [];
    this._subs = new Set();
  }
  on(fn) {
    this._subs.add(fn);
    return () => this._subs.delete(fn);
  }
  _changed(id) {
    const pl = id && this.get(id);
    if (pl) pl.updated = Date.now();
    this.storage.set('playlists', this.items).catch((err) => console.error('[media] saving playlists failed', err));
    for (const fn of [...this._subs]) {
      try {
        fn(id);
      } catch (err) {
        console.error(err);
      }
    }
  }
  async load() {
    const raw = await this.storage.get('playlists', []).catch(() => []);
    this.items = (Array.isArray(raw) ? raw : [])
      .filter((p) => p && typeof p.id === 'string' && typeof p.name === 'string')
      .map((p) => ({ id: p.id, name: p.name, items: Array.isArray(p.items) ? p.items.filter((x) => typeof x === 'string') : [], created: p.created || Date.now(), updated: p.updated || Date.now() }));
  }
  list() {
    return this.items;
  }
  get(id) {
    return this.items.find((p) => p.id === id) || null;
  }
  nameTaken(name, exceptId) {
    const n = String(name).trim().toLowerCase();
    return this.items.some((p) => p.id !== exceptId && p.name.trim().toLowerCase() === n);
  }
  uniqueName(base) {
    if (!this.nameTaken(base)) return base;
    for (let i = 2; ; i++) if (!this.nameTaken(`${base} (${i})`)) return `${base} (${i})`;
  }
  create(name, paths = []) {
    const pl = { id: `pl${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: String(name).trim(), items: [...paths], created: Date.now(), updated: Date.now() };
    this.items.push(pl);
    this._changed(pl.id);
    return pl;
  }
  rename(id, name) {
    const pl = this.get(id);
    if (!pl) return false;
    pl.name = String(name).trim();
    this._changed(id);
    return true;
  }
  remove(id) {
    const i = this.items.findIndex((p) => p.id === id);
    if (i < 0) return false;
    this.items.splice(i, 1);
    this._changed(null);
    return true;
  }
  add(id, paths) {
    const pl = this.get(id);
    if (!pl || !paths?.length) return 0;
    pl.items.push(...paths);
    this._changed(id);
    return paths.length;
  }
  removeAt(id, indexes) {
    const pl = this.get(id);
    if (!pl) return 0;
    const set = new Set([].concat(indexes));
    const before = pl.items.length;
    pl.items = pl.items.filter((_, i) => !set.has(i));
    this._changed(id);
    return before - pl.items.length;
  }
  move(id, from, to) {
    const pl = this.get(id);
    if (!pl || from === to || from < 0 || from >= pl.items.length) return false;
    const [x] = pl.items.splice(from, 1);
    pl.items.splice(Math.max(0, Math.min(pl.items.length, to)), 0, x);
    this._changed(id);
    return true;
  }
}
