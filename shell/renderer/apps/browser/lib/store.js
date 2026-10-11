// Aurora Browser — persistent data shared by every browser window of the session:
// preferences, favorites (bookmarks), history, favicon cache, downloads list, last session.
// Everything lives in ctx.storage (~/.config/aurora/apps/browser/<name>.json); writes are debounced.
import { debounce, uid, hostOf, bareHost, isWebUrl, matchScore, typedForm } from './util.js';

export const HISTORY_CAP = 5000;
const FAVICON_CAP = 400;
const DOWNLOADS_CAP = 200;

export const DEFAULT_PREFS = {
  engine: 'duckduckgo',
  startup: 'newtab', // 'newtab' | 'continue'
  homeButton: true,
  homeUrl: '', // '' = new tab page
  showBar: true,
  dnt: false,
  block3p: false,
  ntpShortcuts: true,
  ntpBackground: true,
  lastFolder: 'bar',
};

export const SEED_SITES = [
  { title: 'Wikipedia', url: 'https://www.wikipedia.org/' },
  { title: 'DuckDuckGo', url: 'https://duckduckgo.com/' },
  { title: 'OpenStreetMap', url: 'https://www.openstreetmap.org/' },
  { title: 'MDN Web Docs', url: 'https://developer.mozilla.org/' },
  { title: 'Ubuntu', url: 'https://ubuntu.com/' },
];

/** Default favorites; `t` localizes the titles of the Selene OS folder (first run only). */
function seedBookmarks(t = null) {
  const now = Date.now();
  const tr = (key, fallback) => {
    const v = t ? t(key) : key;
    return v && v !== key ? v : fallback;
  };
  const mk = (title, url) => ({ id: uid('b'), type: 'url', title, url, added: now });
  return {
    bar: {
      id: 'bar',
      type: 'folder',
      title: '',
      added: now,
      children: [
        ...SEED_SITES.map((s) => mk(s.title, s.url)),
        {
          id: uid('f'),
          type: 'folder',
          title: 'Selene OS',
          added: now,
          children: [mk(tr('seed.docs', 'Selene OS — documentation'), 'aurora://about'), mk(tr('seed.settings', 'Selene Browser settings'), 'aurora://settings')],
        },
      ],
    },
    other: { id: 'other', type: 'folder', title: '', added: now, children: [] },
  };
}

/** Validate a stored favorites tree (a hand-edited or truncated file must not break the app). */
function sanitizeNode(n, forceId = null, depth = 0) {
  if (!n || typeof n !== 'object' || depth > 40) return null;
  const id = forceId || (typeof n.id === 'string' && n.id ? n.id : uid(n.type === 'folder' ? 'f' : 'b'));
  const title = typeof n.title === 'string' ? n.title : '';
  const added = Number(n.added) || Date.now();
  if (forceId || n.type === 'folder') {
    if (!Array.isArray(n.children)) return forceId ? null : { id, type: 'folder', title, added, children: [] };
    const seen = new Set();
    const children = [];
    for (const c of n.children) {
      const x = sanitizeNode(c, null, depth + 1);
      if (!x || seen.has(x.id) || x.id === 'bar' || x.id === 'other') continue;
      seen.add(x.id);
      children.push(x);
    }
    return { id, type: 'folder', title, added, children };
  }
  if (typeof n.url !== 'string' || !n.url) return null;
  return { id, type: 'url', title, url: n.url, added };
}

class Emitter {
  constructor() {
    this._h = new Map();
  }
  on(ev, fn) {
    if (!this._h.has(ev)) this._h.set(ev, new Set());
    this._h.get(ev).add(fn);
    return () => this._h.get(ev)?.delete(fn);
  }
  emit(ev, ...a) {
    for (const fn of [...(this._h.get(ev) || [])]) {
      try {
        fn(...a);
      } catch (err) {
        console.error(`[browser] ${ev} listener failed`, err);
      }
    }
  }
}

export class Store extends Emitter {
  constructor() {
    super();
    this.prefs = { ...DEFAULT_PREFS };
    this.bookmarks = seedBookmarks();
    this.history = new Map(); // url -> { url, title, favicon, visits, last }
    this.favicons = new Map(); // host -> data URL (insertion order = LRU)
    this.downloads = []; // persisted, newest first
    this.session = { windows: [] };
    this.ntp = { shortcuts: [], hidden: [] };
    this._savers = {};
    this.storage = null;
  }

  async load(storage, t = null) {
    this.storage = storage;
    const get = (n, f) => storage.get(n, f).catch(() => f);
    const [prefs, bookmarks, history, favicons, downloads, session, ntp] = await Promise.all([
      get('prefs', null),
      get('bookmarks', null),
      get('history', []),
      get('favicons', {}),
      get('downloads', []),
      get('session', null),
      get('ntp', null),
    ]);
    if (prefs && typeof prefs === 'object') this.prefs = { ...DEFAULT_PREFS, ...prefs };
    const bar = sanitizeNode(bookmarks?.bar, 'bar');
    const other = sanitizeNode(bookmarks?.other, 'other');
    if (bar && other) this.bookmarks = { bar, other };
    else {
      this.bookmarks = seedBookmarks(t);
      this.save('bookmarks');
    }
    if (Array.isArray(history)) {
      // Oldest first, so the Map stays ordered by recency like addVisit() keeps it.
      const list = history.filter((e) => e && typeof e.url === 'string' && isWebUrl(e.url));
      list.sort((a, b) => (Number(a.last) || 0) - (Number(b.last) || 0));
      for (const e of list.slice(-HISTORY_CAP)) {
        this.history.set(e.url, { url: e.url, title: typeof e.title === 'string' ? e.title : '', visits: Math.max(1, Number(e.visits) || 1), first: Number(e.first) || Number(e.last) || 0, last: Number(e.last) || 0 });
      }
    }
    if (favicons && typeof favicons === 'object') for (const [k, v] of Object.entries(favicons)) if (typeof v === 'string') this.favicons.set(k, v);
    if (Array.isArray(downloads)) this.downloads = downloads.filter((d) => d && d.id);
    if (session?.windows) this.session = session;
    if (ntp && typeof ntp === 'object') this.ntp = { shortcuts: ntp.shortcuts || [], hidden: ntp.hidden || [] };
  }

  save(name, delay = 600) {
    if (!this.storage) return;
    if (!this._savers[name]) {
      this._savers[name] = debounce(() => {
        this.storage.set(name, this.serialize(name)).catch((err) => console.error(`[browser] saving ${name} failed`, err));
      }, delay);
    }
    this._savers[name]();
  }

  flush() {
    for (const s of Object.values(this._savers)) s.flush();
  }

  serialize(name) {
    switch (name) {
      case 'prefs':
        return this.prefs;
      case 'bookmarks':
        return this.bookmarks;
      case 'history':
        return [...this.history.values()];
      case 'favicons':
        return Object.fromEntries(this.favicons);
      case 'downloads':
        return this.downloads.slice(0, DOWNLOADS_CAP);
      case 'session':
        return this.session;
      case 'ntp':
        return this.ntp;
      default:
        return null;
    }
  }

  // ------------------------------------------------------------------ prefs
  setPref(key, value) {
    if (this.prefs[key] === value) return;
    this.prefs[key] = value;
    this.save('prefs', 200);
    this.emit('prefs', key, value);
  }

  // ------------------------------------------------------------------ favicons
  favicon(url) {
    const host = hostOf(url);
    return (host && this.favicons.get(host)) || null;
  }
  setFavicon(url, data) {
    const host = hostOf(url);
    if (!host || !data) return;
    if (this.favicons.get(host) === data) return;
    this.favicons.delete(host);
    this.favicons.set(host, data);
    while (this.favicons.size > FAVICON_CAP) this.favicons.delete(this.favicons.keys().next().value);
    this.save('favicons', 2000);
    this.emit('favicons', host);
  }

  // ------------------------------------------------------------------ history
  addVisit(url, title) {
    if (!isWebUrl(url)) return;
    const now = Date.now();
    const prev = this.history.get(url);
    const e = prev || { url, title: '', visits: 0, first: now };
    e.visits = (e.visits || 0) + 1;
    e.last = now;
    if (title) e.title = title;
    this.history.delete(url);
    this.history.set(url, e); // keep Map ordered by recency
    if (this.history.size > HISTORY_CAP) {
      const drop = this.history.size - HISTORY_CAP;
      const it = this.history.keys();
      for (let i = 0; i < drop; i++) this.history.delete(it.next().value);
    }
    this.save('history', 1500);
    this.emit('history');
  }
  setHistoryTitle(url, title) {
    const e = this.history.get(url);
    if (!e || !title || e.title === title) return;
    e.title = title;
    this.save('history', 1500);
    this.emit('history');
  }
  removeHistory(url) {
    if (this.history.delete(url)) {
      this.save('history', 300);
      this.emit('history');
    }
  }
  clearHistory(since = 0) {
    if (!since) this.history.clear();
    else for (const [k, e] of this.history) if ((e.last || 0) >= since) this.history.delete(k);
    this.save('history', 100);
    this.emit('history');
  }
  historyList() {
    return [...this.history.values()].sort((a, b) => (b.last || 0) - (a.last || 0));
  }

  /** Most visited sites, one tile per host, newest first among ties. */
  topSites(n = 8) {
    const hidden = new Set(this.ntp.hidden || []);
    const byHost = new Map();
    const now = Date.now();
    for (const e of this.history.values()) {
      const host = bareHost(e.url);
      if (!host || hidden.has(host)) continue;
      const age = (now - (e.last || 0)) / 86400000;
      const score = (e.visits || 1) * (age < 1 ? 4 : age < 7 ? 2 : age < 30 ? 1 : 0.5);
      const cur = byHost.get(host);
      if (!cur) byHost.set(host, { host, score, best: e });
      else {
        cur.score += score;
        const path = (u) => {
          try {
            return new URL(u).pathname.length;
          } catch {
            return 99;
          }
        };
        if (path(e.url) < path(cur.best.url) || (path(e.url) === path(cur.best.url) && (e.visits || 0) > (cur.best.visits || 0))) cur.best = e;
      }
    }
    return [...byHost.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, n)
      .map((x) => {
        let url = x.best.url;
        try {
          const u = new URL(url);
          if (u.pathname.length > 1 && x.best.visits < 2) url = `${u.origin}/`;
        } catch {}
        return { title: x.best.title, url, host: x.host };
      });
  }

  // ------------------------------------------------------------------ bookmarks
  roots() {
    return [this.bookmarks.bar, this.bookmarks.other];
  }
  *walk(node = null, parent = null) {
    const nodes = node ? [node] : this.roots();
    for (const n of nodes) {
      yield [n, parent];
      if (n.type === 'folder') for (const c of n.children) yield* this.walk(c, n);
    }
  }
  node(id) {
    for (const [n] of this.walk()) if (n.id === id) return n;
    return null;
  }
  parentOf(id) {
    for (const [n, p] of this.walk()) if (n.id === id) return p;
    return null;
  }
  findBookmark(url) {
    if (!url) return null;
    for (const [n] of this.walk()) if (n.type === 'url' && n.url === url) return n;
    return null;
  }
  bookmarkList() {
    const out = [];
    for (const [n] of this.walk()) if (n.type === 'url') out.push(n);
    return out;
  }
  /** Flattened folder list for <select>s: [{ id, title, depth }]. */
  folders() {
    const out = [];
    const rec = (n, depth) => {
      out.push({ id: n.id, title: n.title, depth });
      for (const c of n.children) if (c.type === 'folder') rec(c, depth + 1);
    };
    for (const r of this.roots()) rec(r, 0);
    return out;
  }
  isAncestor(ancestorId, id) {
    const a = this.node(ancestorId);
    if (!a || a.type !== 'folder') return false;
    for (const [n] of this.walk(a)) if (n.id === id) return true;
    return false;
  }
  _changedBookmarks() {
    this.save('bookmarks', 200);
    this.emit('bookmarks');
  }
  addBookmark({ title, url, parentId = 'bar', index = -1 }) {
    const parent = this.node(parentId) || this.bookmarks.bar;
    const n = { id: uid('b'), type: 'url', title: title || url, url, added: Date.now() };
    if (index < 0 || index > parent.children.length) parent.children.push(n);
    else parent.children.splice(index, 0, n);
    this._changedBookmarks();
    return n;
  }
  addFolder({ title, parentId = 'bar', index = -1 }) {
    const parent = this.node(parentId) || this.bookmarks.bar;
    const n = { id: uid('f'), type: 'folder', title, added: Date.now(), children: [] };
    if (index < 0 || index > parent.children.length) parent.children.push(n);
    else parent.children.splice(index, 0, n);
    this._changedBookmarks();
    return n;
  }
  updateNode(id, { title, url, parentId }) {
    const n = this.node(id);
    if (!n) return null;
    if (title != null) n.title = title;
    if (url != null && n.type === 'url') n.url = url;
    if (parentId && parentId !== this.parentOf(id)?.id) this.moveNode(id, parentId, -1, true);
    this._changedBookmarks();
    return n;
  }
  moveNode(id, parentId, index = -1, silent = false) {
    if (id === 'bar' || id === 'other' || id === parentId || this.isAncestor(id, parentId)) return false;
    const n = this.node(id);
    const from = this.parentOf(id);
    const to = this.node(parentId);
    if (!n || !from || !to || to.type !== 'folder') return false;
    const fromIdx = from.children.indexOf(n);
    from.children.splice(fromIdx, 1);
    let i = index;
    if (from === to && index > fromIdx) i -= 1;
    if (i < 0 || i > to.children.length) to.children.push(n);
    else to.children.splice(i, 0, n);
    if (!silent) this._changedBookmarks();
    return true;
  }
  removeNode(id) {
    if (id === 'bar' || id === 'other') return null;
    const p = this.parentOf(id);
    if (!p) return null;
    const i = p.children.findIndex((c) => c.id === id);
    const [n] = p.children.splice(i, 1);
    this._changedBookmarks();
    return { node: n, parentId: p.id, index: i };
  }
  restoreNode({ node, parentId, index }) {
    const p = this.node(parentId) || this.bookmarks.other;
    p.children.splice(Math.min(index, p.children.length), 0, node);
    this._changedBookmarks();
  }

  // ------------------------------------------------------------------ omnibox
  suggest(text, limit = 6) {
    const q = String(text || '').trim().toLowerCase();
    if (!q) return [];
    const terms = q.split(/\s+/).filter(Boolean);
    const seen = new Set();
    const out = [];
    for (const b of this.bookmarkList()) {
      const s = matchScore(b, terms);
      if (s) out.push({ kind: 'bookmark', url: b.url, title: b.title, score: s + 20 });
    }
    const now = Date.now();
    for (const e of this.history.values()) {
      const s = matchScore(e, terms);
      if (!s) continue;
      const age = (now - (e.last || 0)) / 86400000;
      out.push({ kind: 'history', url: e.url, title: e.title, score: s + Math.min(30, (e.visits || 1) * 3) + (age < 1 ? 10 : age < 7 ? 5 : 0) });
    }
    out.sort((a, b) => b.score - a.score);
    const res = [];
    for (const o of out) {
      if (seen.has(o.url)) continue;
      seen.add(o.url);
      res.push(o);
      if (res.length >= limit) break;
    }
    return res;
  }

  /** Best inline completion for what the user typed ("wiki" -> "wikipedia.org/"). */
  inlineCompletion(text) {
    const q = String(text || '').toLowerCase();
    if (!q || /\s/.test(q) || q.length < 2) return null;
    let best = null;
    const consider = (url, weight) => {
      const forms = [typedForm(url)];
      try {
        const u = new URL(url);
        forms.push(`${u.host.replace(/^www\./, '')}/`);
        forms.push(`${u.host}/`);
      } catch {}
      for (const f of forms) {
        if (f.toLowerCase().startsWith(q) && f.length > q.length) {
          // Prefer the shortest completion (usually the host) with the highest weight.
          const score = weight - f.length / 1000;
          if (!best || score > best.score) best = { text: f, url, score };
        }
      }
    };
    for (const e of this.history.values()) consider(e.url, (e.visits || 1) + ((e.last || 0) > Date.now() - 7 * 86400000 ? 2 : 0));
    for (const b of this.bookmarkList()) if (isWebUrl(b.url)) consider(b.url, 3);
    if (!best) return null;
    // Return the host-only form when that is what matched, so Enter goes to the site root.
    const url = best.text.endsWith('/') && !best.text.slice(0, -1).includes('/') ? `${new URL(best.url).protocol}//${best.text}` : best.url;
    return { text: best.text, url };
  }

  // ------------------------------------------------------------------ downloads
  upsertDownload(d) {
    if (d.private) return;
    const i = this.downloads.findIndex((x) => x.id === d.id);
    const rec = {
      id: d.id,
      url: d.url,
      filename: d.filename,
      path: d.path,
      state: d.state,
      total: d.total,
      received: d.received,
      startTime: d.startTime,
      endTime: d.endTime,
      mime: d.mime,
    };
    if (i >= 0) this.downloads[i] = rec;
    else this.downloads.unshift(rec);
    this.save('downloads', d.state === 'progressing' ? 3000 : 200);
  }
  removeDownload(id) {
    this.downloads = this.downloads.filter((d) => d.id !== id);
    this.save('downloads', 200);
  }
  clearDownloads(keepActive = true) {
    this.downloads = keepActive ? this.downloads.filter((d) => d.state === 'progressing') : [];
    this.save('downloads', 100);
  }
}
