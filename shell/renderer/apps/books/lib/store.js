// Livres — persisted state shared by every window of the app (ctx.storage, ~/.config/aurora/apps/books/):
//   library.json    { v, books: [Entry], hidden: [path] }
//     Entry = { path, title, authors, authorSort, language, series, seriesIndex, size, mtime, added, opened,
//               source: 'user' | 'found', pos: { spine, ratio } | null, progress (0..1), error: code | null }
//     hidden: books removed from the library that the folder scan must not bring back.
//   covers.json     { path: 'data:image/jpeg;base64,…' }   (small thumbnails made from the books' covers)
//   bookmarks.json  { path: [{ id, spine, ratio, progress, label, excerpt, at }] }
//   prefs.json      reading settings (DEFAULT_PREFS) and the library sort order
// Everything read back is checked (types, ranges): a damaged or tampered file never breaks the app.
import { Emitter } from '../../../core/api.js';

export const DEFAULT_PREFS = {
  fontSize: 100, // % of the book's size
  font: 'book', // book | serif | sans | readable
  lineHeight: 'book', // book | tight | normal | loose
  margins: 'normal', // narrow | normal | wide
  align: 'book', // book | left | justify
  theme: 'auto', // auto | light | sepia | dark
  layout: 'paged', // paged | scroll
  spread: true, // two pages side by side when the window is wide enough
  sort: 'recent', // recent | title | author
  sidebarTab: 'toc', // toc | bookmarks | search
};
const CHOICES = {
  font: ['book', 'serif', 'sans', 'readable'],
  lineHeight: ['book', 'tight', 'normal', 'loose'],
  margins: ['narrow', 'normal', 'wide'],
  align: ['book', 'left', 'justify'],
  theme: ['auto', 'light', 'sepia', 'dark'],
  layout: ['paged', 'scroll'],
  sort: ['recent', 'title', 'author'],
  sidebarTab: ['toc', 'bookmarks', 'search'],
};
export const FONT_SIZES = { min: 70, max: 200, step: 10 };

const str = (v, max = 1000) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v, def = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : def);
const clamp01 = (v) => Math.min(1, Math.max(0, num(v)));
const isPath = (p) => typeof p === 'string' && p.startsWith('/') && p.length < 4096 && !p.includes('\0');

function cleanPos(p) {
  if (!p || typeof p !== 'object') return null;
  const spine = Math.floor(num(p.spine, -1));
  if (spine < 0 || spine > 100000) return null;
  return { spine, ratio: clamp01(p.ratio) };
}
function cleanEntry(e) {
  if (!e || typeof e !== 'object' || !isPath(e.path)) return null;
  return {
    path: e.path,
    title: str(e.title, 500),
    authors: Array.isArray(e.authors) ? e.authors.filter((a) => typeof a === 'string').map((a) => a.slice(0, 300)).slice(0, 20) : [],
    authorSort: str(e.authorSort, 300),
    language: str(e.language, 40),
    series: str(e.series, 300),
    seriesIndex: typeof e.seriesIndex === 'number' && Number.isFinite(e.seriesIndex) ? e.seriesIndex : null,
    size: num(e.size),
    mtime: num(e.mtime),
    added: num(e.added),
    opened: num(e.opened),
    source: e.source === 'found' ? 'found' : 'user',
    pos: cleanPos(e.pos),
    progress: clamp01(e.progress),
    error: typeof e.error === 'string' ? e.error.slice(0, 40) : null,
    meta: e.meta === true,
  };
}
function cleanBookmark(b) {
  if (!b || typeof b !== 'object') return null;
  const pos = cleanPos(b);
  if (!pos) return null;
  return { id: str(b.id, 60) || `b${Math.random().toString(36).slice(2, 10)}`, ...pos, progress: clamp01(b.progress), label: str(b.label, 300), excerpt: str(b.excerpt, 400), at: num(b.at) };
}

export const store = {
  ready: null,
  api: null,
  books: new Map(), // path -> Entry
  hidden: new Set(),
  covers: {},
  marks: {},
  prefs: { ...DEFAULT_PREFS },
  events: new Emitter(),
  timers: {},

  init(ctx) {
    if (this.ready) return this.ready;
    this.api = ctx.api;
    this.ready = (async () => {
      const [lib, covers, marks, prefs] = await Promise.all(['library', 'covers', 'bookmarks', 'prefs'].map((n) => ctx.storage.get(n, null).catch(() => null)));
      this.books = new Map();
      for (const e of Array.isArray(lib?.books) ? lib.books : []) {
        const c = cleanEntry(e);
        if (c && !this.books.has(c.path)) this.books.set(c.path, c);
      }
      this.hidden = new Set(Array.isArray(lib?.hidden) ? lib.hidden.filter(isPath).slice(0, 5000) : []);
      this.covers = {};
      if (covers && typeof covers === 'object') for (const [p, v] of Object.entries(covers)) if (isPath(p) && typeof v === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(v) && v.length < 400000) this.covers[p] = v;
      this.marks = {};
      if (marks && typeof marks === 'object') {
        for (const [p, list] of Object.entries(marks)) {
          if (!isPath(p) || !Array.isArray(list)) continue;
          const l = list.map(cleanBookmark).filter(Boolean).slice(0, 1000);
          if (l.length) this.marks[p] = l;
        }
      }
      this.prefs = { ...DEFAULT_PREFS };
      if (prefs && typeof prefs === 'object') {
        for (const [k, def] of Object.entries(DEFAULT_PREFS)) {
          const v = prefs[k];
          if (CHOICES[k]) this.prefs[k] = CHOICES[k].includes(v) ? v : def;
          else if (k === 'fontSize') this.prefs.fontSize = Math.min(FONT_SIZES.max, Math.max(FONT_SIZES.min, Math.round(num(v, def) / 10) * 10));
          else if (typeof def === 'boolean') this.prefs[k] = typeof v === 'boolean' ? v : def;
        }
      }
    })();
    return this.ready;
  },

  on(ev, fn) {
    return this.events.on(ev, fn);
  },

  // ---------------------------------------------------------------- library
  list() {
    return [...this.books.values()];
  },
  get(path) {
    return this.books.get(path) || null;
  },
  /** Insert or update a library entry. */
  put(path, patch = {}) {
    if (!isPath(path)) return null;
    const prev = this.books.get(path);
    const next = cleanEntry({ added: Date.now(), ...(prev || {}), ...patch, path });
    this.books.set(path, next);
    if (patch.source === 'user') this.hidden.delete(path);
    this.save('library');
    this.events.emit('library', path);
    return next;
  },
  remove(path, { hide = true } = {}) {
    const had = this.books.delete(path);
    if (hide) this.hidden.add(path);
    delete this.covers[path];
    this.save('library');
    this.save('covers');
    if (had) this.events.emit('library', path);
  },
  forget(path) {
    // the file itself is gone (moved to the trash): drop everything about it
    this.books.delete(path);
    this.hidden.delete(path);
    delete this.covers[path];
    delete this.marks[path];
    this.save('library');
    this.save('covers');
    this.save('bookmarks');
    this.events.emit('library', path);
  },
  isHidden(path) {
    return this.hidden.has(path);
  },
  cover(path) {
    return this.covers[path] || null;
  },
  setCover(path, dataUrl) {
    if (!dataUrl) delete this.covers[path];
    else this.covers[path] = dataUrl;
    this.save('covers');
    this.events.emit('cover', path);
  },
  setPosition(path, pos, progress) {
    const e = this.books.get(path);
    if (!e) return;
    e.pos = cleanPos(pos);
    e.progress = clamp01(progress);
    e.opened = Date.now();
    this.save('library', 600);
    this.events.emit('progress', path);
  },

  // ---------------------------------------------------------------- bookmarks
  bookmarks(path) {
    return this.marks[path] || [];
  },
  setBookmarks(path, list) {
    const l = list.map(cleanBookmark).filter(Boolean);
    if (l.length) this.marks[path] = l;
    else delete this.marks[path];
    this.save('bookmarks');
    this.events.emit('bookmarks', path);
  },

  // ---------------------------------------------------------------- prefs
  pref(k) {
    return this.prefs[k];
  },
  setPref(k, v) {
    if (this.prefs[k] === v) return;
    this.prefs[k] = v;
    this.save('prefs');
    this.events.emit('prefs', k, v);
  },

  // ---------------------------------------------------------------- persistence
  data(name) {
    if (name === 'library') return { v: 1, books: this.list(), hidden: [...this.hidden] };
    if (name === 'covers') return this.covers;
    if (name === 'bookmarks') return this.marks;
    return this.prefs;
  },
  save(name, delay = 250) {
    clearTimeout(this.timers[name]);
    this.timers[name] = setTimeout(() => this.write(name), delay);
  },
  write(name) {
    clearTimeout(this.timers[name]);
    delete this.timers[name];
    return this.api?.invoke('storage:set', 'books', name, this.data(name)).catch((err) => console.error('[books] saving', name, err));
  },
  /** Write everything pending now (window closing). */
  flush() {
    return Promise.all(Object.keys(this.timers).map((n) => this.write(n)));
  },
};
