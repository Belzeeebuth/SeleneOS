// Media Player library: scans the library folders (fs:list walk with limits), reads tags,
// probes durations with hidden media elements, renders video thumbnails and caches everything.
//
//   const lib = new Library({ api, storage, home });
//   await lib.load();                 cached folders + metadata
//   await lib.scan();                 walk folders, then enrich in the background
//   lib.songs() lib.videos() lib.albums() lib.artists() lib.get(path) await lib.ensure(path)
//   lib.on('change', ({ type: 'scan' | 'meta' | 'scanning', paths }) => …)
//
// Caches: metadata in ctx.storage('meta'); artwork and thumbnails as files under
// ~/.cache/aurora/media/{art,thumbs}/ (served to <img> through api.mediaUrl).
import { AUDIO_EXT, VIDEO_EXT, MEDIA_EXT, extOf, kindOf, baseName, dirName, guessFromName, hash, pool, debounce, compareText } from './util.js';
import { readTags, urlReader } from './tags.js';

const LIMITS = { depth: 10, dirs: 3000, files: 20000 };
const META_VERSION = 2;

function once(el, ok, ms = 10000) {
  return new Promise((resolve, reject) => {
    const done = (fn, v) => {
      clearTimeout(t);
      el.removeEventListener(ok, onOk);
      el.removeEventListener('error', onErr);
      fn(v);
    };
    const onOk = () => done(resolve);
    const onErr = () => done(reject, new Error(el.error?.message || 'media error'));
    const t = setTimeout(() => done(reject, new Error('timeout')), ms);
    el.addEventListener(ok, onOk);
    el.addEventListener('error', onErr);
  });
}

export class Library {
  constructor({ api, storage, home, xdg = {}, locale = () => 'en' }) {
    this.api = api;
    this.storage = storage;
    this.home = home;
    this.locale = locale;
    this.cacheDir = `${home}/.cache/aurora/media`;
    this.folders = { music: [xdg.music || `${home}/Music`], video: [xdg.videos || `${home}/Videos`] };
    this.entries = new Map(); // path -> entry (library + opened files)
    this.inLibrary = new Set(); // paths found by the last scan
    this.meta = {};
    this.scanning = false;
    this.lastScan = 0;
    this._subs = new Set();
    this._pending = new Set();
    this._jobs = new Map();
    this._saveMeta = debounce(() => this.storage.set('meta', { v: META_VERSION, items: this.meta }).catch(() => {}), 1200);
    this._emitMeta = debounce(() => {
      const paths = [...this._pending];
      this._pending.clear();
      this._emit({ type: 'meta', paths });
    }, 250);
  }

  on(fn) {
    this._subs.add(fn);
    return () => this._subs.delete(fn);
  }
  /** Window closed: persist what was learnt, stop background work and events. */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this._subs.clear();
    this._emitMeta.cancel();
    this._saveMeta.flush();
  }
  _emit(ev) {
    for (const fn of [...this._subs]) {
      try {
        fn(ev);
      } catch (err) {
        console.error('[media] library listener failed', err);
      }
    }
  }

  async load() {
    const [folders, meta] = await Promise.all([this.storage.get('folders', null).catch(() => null), this.storage.get('meta', null).catch(() => null)]);
    if (folders && Array.isArray(folders.music) && Array.isArray(folders.video)) {
      this.folders = { music: folders.music.filter((p) => typeof p === 'string'), video: folders.video.filter((p) => typeof p === 'string') };
    }
    if (meta && meta.v === META_VERSION && meta.items && typeof meta.items === 'object') {
      for (const [p, m] of Object.entries(meta.items)) {
        const clean = this._cleanMeta(m);
        if (clean) this.meta[p] = clean;
      }
    }
  }
  /** Cached metadata is re-validated on load: known fields of the right type only, and artwork /
   *  thumbnails only from our own cache folder. */
  _cleanMeta(m) {
    if (!m || typeof m !== 'object' || typeof m.k !== 'string') return null;
    const out = { k: m.k };
    for (const f of ['title', 'artist', 'album', 'albumArtist', 'genre']) if (typeof m[f] === 'string' && m[f]) out[f] = m[f].slice(0, 500);
    for (const f of ['track', 'year', 'duration', 'width', 'height']) if (Number.isFinite(m[f]) && m[f] > 0) out[f] = m[f];
    for (const f of ['art', 'thumb']) if (typeof m[f] === 'string' && m[f].startsWith(`${this.cacheDir}/`) && !m[f].includes('/../')) out[f] = m[f];
    for (const f of ['tagged', 'bad']) if (m[f] === true) out[f] = true;
    return out;
  }

  saveFolders() {
    return this.storage.set('folders', this.folders);
  }
  async addFolder(kind, dir) {
    const list = this.folders[kind];
    if (!list || list.includes(dir)) return false;
    list.push(dir);
    await this.saveFolders();
    return true;
  }
  async removeFolder(kind, dir) {
    const list = this.folders[kind];
    const i = list ? list.indexOf(dir) : -1;
    if (i < 0) return false;
    list.splice(i, 1);
    await this.saveFolders();
    return true;
  }

  // ---------------------------------------------------------------- scanning
  /** Recursively list supported media under `root` (bounded). */
  async walk(root, exts = MEDIA_EXT, limits = LIMITS) {
    const files = [];
    const queue = [[root, 0]];
    const seen = new Set();
    let dirs = 0;
    while (queue.length && dirs < limits.dirs && files.length < limits.files) {
      const batch = queue.splice(0, 8);
      const lists = await Promise.all(batch.map(([d]) => this.api.invoke('fs:list', d).catch(() => [])));
      batch.forEach(([, depth], bi) => {
        dirs++;
        for (const e of lists[bi]) {
          if (e.dir) {
            if (depth < limits.depth && !seen.has(e.path) && !e.link) {
              seen.add(e.path);
              queue.push([e.path, depth + 1]);
            }
          } else if (exts.includes((e.ext || extOf(e.name)).toLowerCase()) && files.length < limits.files) files.push(e);
        }
      });
    }
    return files;
  }

  /** Walk the library folders. quiet: background refresh (no "scanning" state shown). */
  async scan({ quiet = false } = {}) {
    if (this._scanPromise) {
      // A folder added (or removed) while a scan runs must not be missed: run once more after it.
      this._again ||= this._scanPromise
        .catch(() => {})
        .then(() => {
          this._again = null;
          return this.scan({ quiet });
        });
      return this._again;
    }
    this.scanning = !quiet;
    if (!quiet) this._emit({ type: 'scanning' });
    const before = new Set(this.inLibrary);
    this._scanPromise = (async () => {
      const found = new Map();
      for (const [kind, exts] of [
        ['music', AUDIO_EXT],
        ['video', VIDEO_EXT],
      ]) {
        for (const root of this.folders[kind]) {
          const files = await this.walk(root, exts);
          for (const f of files) if (!found.has(f.path)) found.set(f.path, f);
        }
      }
      this.inLibrary = new Set(found.keys());
      for (const f of found.values()) this._upsert(f);
      // Forget library entries that disappeared (keep files opened from elsewhere).
      for (const [p, e] of this.entries) if (e.fromScan && !found.has(p)) this.entries.delete(p);
      for (const p of Object.keys(this.meta)) if (!found.has(p) && !this.entries.has(p)) delete this.meta[p];
      this._saveMeta();
      this.lastScan = Date.now();
      this.scanning = false;
      const changed = before.size !== found.size || [...found.keys()].some((p) => !before.has(p));
      this._emit({ type: 'scan', changed, quiet });
      this.enrich([...found.keys()]);
    })().finally(() => {
      this.scanning = false;
      this._scanPromise = null;
    });
    return this._scanPromise;
  }

  _upsert(f, fromScan = true) {
    const key = `${f.size}:${Math.round(f.mtime || 0)}`;
    const cached = this.meta[f.path];
    const guess = guessFromName(f.path);
    const prev = this.entries.get(f.path);
    const e = {
      path: f.path,
      name: f.name || baseName(f.path),
      ext: extOf(f.path),
      kind: kindOf(f.path),
      size: f.size || 0,
      mtime: f.mtime || 0,
      dir: dirName(f.path),
      guessTitle: guess.title,
      guessArtist: guess.artist,
      fromScan: fromScan || !!prev?.fromScan,
      ...(cached && cached.k === key ? cached : { k: key }),
    };
    this.entries.set(f.path, e);
    return e;
  }

  /** Entry for any file (library or not); stats + enriches unknown files. */
  async ensure(path) {
    let e = this.entries.get(path);
    if (e) return e;
    const st = await this.api.invoke('fs:stat', path).catch(() => null);
    if (!st || st.dir) return null;
    e = this._upsert({ path, name: st.name, size: st.size, mtime: st.mtime }, false);
    this.enrich([path]);
    return e;
  }
  get(path) {
    return this.entries.get(path) || null;
  }

  // ---------------------------------------------------------------- enrichment
  enrich(paths) {
    const todo = paths.map((p) => this.entries.get(p)).filter((e) => e && !e.tagged && !this._jobs.has(e.path));
    if (!todo.length) return this._enrichPromise || Promise.resolve();
    for (const e of todo) this._jobs.set(e.path, true);
    const run = async () => {
      const audio = todo.filter((e) => e.kind === 'audio');
      const video = todo.filter((e) => e.kind === 'video');
      await Promise.all([pool(audio, 3, (e) => this._enrichAudio(e)), pool(video, 2, (e) => this._enrichVideo(e))]);
      for (const e of todo) this._jobs.delete(e.path);
    };
    this._enrichPromise = (this._enrichPromise || Promise.resolve()).then(run, run);
    return this._enrichPromise;
  }

  _store(e, data) {
    Object.assign(e, data);
    const { k, title, artist, album, albumArtist, track, year, genre, duration, art, thumb, width, height, tagged, bad } = e;
    this.meta[e.path] = { k, title, artist, album, albumArtist, track, year, genre, duration, art, thumb, width, height, tagged, bad };
    this._saveMeta();
    this._pending.add(e.path);
    this._emitMeta();
  }

  async _writeCache(sub, name, bytes) {
    const path = `${this.cacheDir}/${sub}/${name}`;
    if (!(await this.api.invoke('fs:exists', path).catch(() => false))) await this.api.invoke('fs:writeBytes', path, bytes);
    return path;
  }

  async _enrichAudio(e) {
    if (this.disposed) return;
    const url = this.api.mediaUrl(e.path);
    let tags = {};
    try {
      tags = await readTags(urlReader(url, e.size), e.ext);
    } catch {}
    const data = { tagged: true };
    for (const k of ['title', 'artist', 'album', 'albumArtist', 'track', 'year', 'genre']) if (tags[k] != null) data[k] = tags[k];
    if (tags.picture?.data?.length) {
      const ext = tags.picture.mime === 'image/png' ? 'png' : tags.picture.mime === 'image/webp' ? 'webp' : 'jpg';
      try {
        data.art = await this._writeCache('art', `${hash(tags.picture.data)}.${ext}`, tags.picture.data);
      } catch {}
    }
    if (!data.art) {
      // no embedded picture: the album cover next to the files (folder.jpg, cover.jpg…), copied to the art cache once
      const cover = await this._folderCover(e.dir);
      if (cover) data.art = cover;
    }
    if (Number.isFinite(tags.duration) && tags.duration > 0) data.duration = tags.duration;
    else {
      try {
        data.duration = await this.probeDuration(url);
      } catch {
        data.bad = true;
      }
    }
    this._store(e, data);
  }

  _folderCover(dir) {
    this._covers ||= new Map();
    if (!this._covers.has(dir)) {
      this._covers.set(
        dir,
        (async () => {
          const list = await this.api.invoke('fs:list', dir).catch(() => []);
          const names = ['folder', 'cover', 'front', 'album', 'albumart'];
          const pick = list
            .filter((f) => !f.dir && /\.(jpe?g|png|webp)$/i.test(f.name) && f.size > 64 && f.size < 20 * 1024 * 1024)
            .map((f) => ({ f, rank: names.indexOf(f.name.replace(/\.[^.]+$/, '').toLowerCase()) }))
            .filter((x) => x.rank >= 0)
            .sort((a, b) => a.rank - b.rank)[0]?.f;
          if (!pick) return null;
          const bytes = await this.api.invoke('fs:readBytes', pick.path);
          const ext = /\.png$/i.test(pick.name) ? 'png' : /\.webp$/i.test(pick.name) ? 'webp' : 'jpg';
          return this._writeCache('art', `${hash(bytes)}.${ext}`, bytes);
        })().catch(() => null),
      );
    }
    return this._covers.get(dir);
  }

  async probeDuration(url) {
    const a = document.createElement('audio');
    a.preload = 'metadata';
    a.src = url;
    try {
      await once(a, 'loadedmetadata', 12000);
      let d = a.duration;
      if (d === Infinity) {
        // Some streams only know their length once the end has been reached.
        a.currentTime = 1e7;
        await once(a, 'durationchange', 4000).catch(() => {});
        d = a.duration;
      }
      return Number.isFinite(d) ? d : 0;
    } finally {
      a.removeAttribute('src');
      a.load();
    }
  }

  async _enrichVideo(e) {
    if (this.disposed) return;
    const data = { tagged: true };
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    v.crossOrigin = 'anonymous';
    v.src = this.api.mediaUrl(e.path);
    try {
      await once(v, 'loadedmetadata', 15000);
      const d = v.duration;
      if (Number.isFinite(d)) data.duration = d;
      data.width = v.videoWidth;
      data.height = v.videoHeight;
      if (v.videoWidth > 0) {
        v.currentTime = Number.isFinite(d) && d > 0 ? Math.min(d * 0.1, Math.max(0, d - 0.1)) : 1;
        await once(v, 'seeked', 10000);
        const W = 400;
        const H = 225;
        const c = document.createElement('canvas');
        c.width = W;
        c.height = H;
        const g = c.getContext('2d');
        g.fillStyle = '#000';
        g.fillRect(0, 0, W, H);
        const s = Math.max(W / v.videoWidth, H / v.videoHeight);
        const dw = v.videoWidth * s;
        const dh = v.videoHeight * s;
        g.drawImage(v, (W - dw) / 2, (H - dh) / 2, dw, dh);
        const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.82));
        if (blob) {
          const bytes = new Uint8Array(await blob.arrayBuffer());
          data.thumb = await this._writeCache('thumbs', `${hash(`${e.path}|${e.k}`)}.jpg`, bytes);
        }
      }
    } catch {
      if (!data.duration) data.bad = true;
    } finally {
      v.removeAttribute('src');
      v.load();
    }
    this._store(e, data);
  }

  async clearCache() {
    this.meta = {};
    await this.storage.set('meta', { v: META_VERSION, items: {} }).catch(() => {});
    for (const sub of ['art', 'thumbs']) await this.api.invoke('fs:delete', [`${this.cacheDir}/${sub}`]).catch(() => {});
    for (const e of this.entries.values()) {
      for (const k of ['title', 'artist', 'album', 'albumArtist', 'track', 'year', 'genre', 'duration', 'art', 'thumb', 'width', 'height', 'tagged', 'bad']) delete e[k];
    }
    this.enrich([...this.entries.keys()]);
  }

  // ---------------------------------------------------------------- views
  _lib(kind) {
    return [...this.inLibrary].map((p) => this.entries.get(p)).filter((e) => e && e.kind === kind);
  }
  songs() {
    return this._lib('audio');
  }
  videos() {
    return this._lib('video');
  }
  albums(unknownAlbum = 'Unknown album', unknownArtist = 'Unknown artist') {
    const map = new Map();
    for (const s of this.songs()) {
      const artist = s.albumArtist || s.artist || '';
      const album = s.album || '';
      const key = `${artist.toLowerCase()}\u0000${album.toLowerCase()}`;
      if (!map.has(key)) map.set(key, { key, title: album || unknownAlbum, artist: artist || unknownArtist, unknown: !album, songs: [], art: null, year: null });
      const a = map.get(key);
      a.songs.push(s);
      a.art ||= s.art || null;
      a.year ||= s.year || null;
    }
    const loc = this.locale();
    for (const a of map.values()) a.songs.sort((x, y) => (x.track || 999) - (y.track || 999) || compareText(x.title || x.guessTitle, y.title || y.guessTitle, loc));
    return [...map.values()].sort((a, b) => a.unknown - b.unknown || compareText(a.title, b.title, loc));
  }
  artists(unknownArtist = 'Unknown artist') {
    const map = new Map();
    for (const s of this.songs()) {
      const name = s.artist || s.guessArtist || '';
      const key = name.toLowerCase();
      if (!map.has(key)) map.set(key, { key, name: name || unknownArtist, unknown: !name, songs: [], art: null });
      const a = map.get(key);
      a.songs.push(s);
      a.art ||= s.art || null;
    }
    const loc = this.locale();
    return [...map.values()].sort((a, b) => a.unknown - b.unknown || compareText(a.name, b.name, loc));
  }
  // Genres from the tags (« Rock », « rock » are one genre); songs without one are grouped last.
  genres(unknownGenre = 'Unknown genre') {
    const map = new Map();
    for (const s of this.songs()) {
      const name = String(s.genre || '').trim();
      const key = name.toLowerCase();
      if (!map.has(key)) map.set(key, { key, name: name || unknownGenre, unknown: !name, songs: [] });
      map.get(key).songs.push(s);
    }
    const loc = this.locale();
    return [...map.values()].sort((a, b) => a.unknown - b.unknown || compareText(a.name, b.name, loc));
  }
}
