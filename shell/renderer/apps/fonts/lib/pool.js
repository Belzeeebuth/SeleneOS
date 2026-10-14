// Polices: font faces loaded for previews.
//
// Every preview face is a FontFace built from the file bytes (fonts:bytes, one face cut out of a collection) under a
// unique family alias (« selene-fonts-<pool>-<n> »), so it never clashes with the shell's own fonts, another app's
// fonts or another window of this app. Faces are reference-counted: release() puts an unused face on an idle list,
// and the oldest idle faces are removed from document.fonts once more than `idle` wait there; dispose() (window
// closed) removes them all.
//
//   const pool = new FontPool(api);
//   const alias = await pool.acquire(file, index);   // null when the face cannot be loaded (OTS refused it…)
//   el.style.fontFamily = `"${alias}"`;  …  pool.release(file, index);
let pools = 0;

export const ALIAS_PREFIX = 'selene-fonts-';

export class FontPool {
  constructor(api, { idle = 48 } = {}) {
    this.api = api;
    this.idleMax = idle;
    this.entries = new Map(); // key -> { alias, refs, face, promise, failed }
    this.idle = new Set(); // keys with refs === 0, oldest first
    this.prefix = `${ALIAS_PREFIX}${Date.now().toString(36)}${++pools}-`;
    this.seq = 0;
    this.disposed = false;
  }

  key(file, index = 0) {
    return `${file}#${(Number(index) || 0) & 0xffff}`;
  }

  /** Loads (or reuses) the face; resolves to its alias, or null when it cannot be shown. */
  acquire(file, index = 0) {
    if (this.disposed) return Promise.resolve(null);
    const k = this.key(file, index);
    let e = this.entries.get(k);
    if (!e) {
      e = { alias: `${this.prefix}${++this.seq}`, refs: 0, face: null, failed: false, promise: null };
      this.entries.set(k, e);
      e.promise = this._load(k, e, file, index);
    }
    e.refs++;
    this.idle.delete(k);
    return e.promise.then(() => (e.failed || this.entries.get(k) !== e ? null : e.alias));
  }

  release(file, index = 0) {
    const k = this.key(file, index);
    const e = this.entries.get(k);
    if (!e || e.refs <= 0) return;
    e.refs--;
    if (!e.refs) {
      this.idle.add(k);
      this._trim();
    }
  }

  /** Alias of a face that is loaded right now (no reference taken). */
  aliasOf(file, index = 0) {
    const e = this.entries.get(this.key(file, index));
    return e && e.face ? e.alias : null;
  }

  _trim() {
    while (this.idle.size > this.idleMax) {
      const k = this.idle.values().next().value;
      this.idle.delete(k);
      this._drop(k);
    }
  }

  _drop(k) {
    const e = this.entries.get(k);
    if (!e) return;
    this.entries.delete(k);
    if (e.face) {
      try {
        document.fonts.delete(e.face);
      } catch {}
      e.face = null;
    }
  }

  async _load(k, e, file, index) {
    try {
      const bytes = await this.api.invoke('fonts:bytes', file, (Number(index) || 0) & 0xffff);
      if (this.disposed || this.entries.get(k) !== e) return;
      // font-synthesis is off where the faces are used: each style is drawn from its own face, never faked.
      const face = new FontFace(e.alias, bytes, { display: 'block' });
      await face.load();
      if (this.disposed || this.entries.get(k) !== e) return;
      document.fonts.add(face);
      e.face = face;
    } catch (err) {
      e.failed = true;
      e.error = err;
    }
  }

  /** Faces of this pool currently in document.fonts. */
  loadedCount() {
    let n = 0;
    for (const e of this.entries.values()) if (e.face) n++;
    return n;
  }

  dispose() {
    this.disposed = true;
    for (const k of [...this.entries.keys()]) this._drop(k);
    this.idle.clear();
  }
}

/** Every preview face of this app present in document.fonts (all windows): for tests and checks. */
export function loadedAliases() {
  const out = [];
  for (const f of document.fonts) if (String(f.family).replace(/"/g, '').startsWith(ALIAS_PREFIX)) out.push(String(f.family).replace(/"/g, ''));
  return out;
}
