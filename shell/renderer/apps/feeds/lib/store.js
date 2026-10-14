// Subscriptions, articles / episodes and their state for Podcasts & News, kept in ctx.storage
// (~/.config/aurora/apps/feeds/):
//   'feeds'           [feed]  { id, url, title, customTitle, siteUrl, description, author, image, imagePath, podcast,
//                     folder, added, lastFetch, lastStatus, etag, lastModified, error, retryAt, showImages, ttl }
//   'prefs'           { keep, speed, view, collapsed: [folder], volume }
//   'items-<feedId>'  [item]  { id, guid, title, link, date, seen, author, summary, image, enc: { url, type, length },
//                     duration, episode, season, chapters, ichap, read, starred, played, pos, dl: { path, size } | null }
//   'content-<feedId>' { itemId: html }   (article bodies / show notes, loaded only when an item is opened)
// Bounded: `keep` items per feed (default 200, newest first); starred, downloaded and half-listened items are never
// dropped. Bodies are cut at 150 000 characters.
import { hashId, debounce } from './util.js';

export const KEEP_DEFAULT = 200;
const CONTENT_MAX = 150000;
const FUTURE_SLACK = 24 * 3600000;

export const itemKey = (feedId, itemId) => `${feedId}_${itemId}`;
export function splitKey(key) {
  const i = String(key).indexOf('_');
  return i > 0 ? [key.slice(0, i), key.slice(i + 1)] : [key, ''];
}

const str = (v, n = 2000) => (typeof v === 'string' ? v.slice(0, n) : '');
const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);

function sanitizeFeed(f) {
  if (!f || typeof f !== 'object' || typeof f.url !== 'string' || !/^https?:\/\//i.test(f.url)) return null;
  return {
    id: str(f.id, 40) || hashId(f.url),
    url: str(f.url, 2000),
    title: str(f.title, 300),
    customTitle: str(f.customTitle, 300),
    siteUrl: str(f.siteUrl, 2000),
    description: str(f.description, 1000),
    author: str(f.author, 200),
    image: str(f.image, 2000),
    imagePath: str(f.imagePath, 1000),
    podcast: !!f.podcast,
    folder: str(f.folder, 120),
    added: num(f.added) || Date.now(),
    lastFetch: num(f.lastFetch),
    lastStatus: num(f.lastStatus),
    etag: str(f.etag, 300) || null,
    lastModified: str(f.lastModified, 100) || null,
    error: str(f.error, 40) || null,
    retryAt: num(f.retryAt),
    showImages: !!f.showImages,
    ttl: num(f.ttl),
  };
}

function sanitizeItem(it) {
  if (!it || typeof it !== 'object' || typeof it.id !== 'string') return null;
  const enc = it.enc && typeof it.enc === 'object' && typeof it.enc.url === 'string' ? { url: str(it.enc.url, 2000), type: str(it.enc.type, 80), length: num(it.enc.length) } : null;
  const dl = it.dl && typeof it.dl === 'object' && typeof it.dl.path === 'string' ? { path: str(it.dl.path, 2000), size: num(it.dl.size) } : null;
  return {
    id: it.id.slice(0, 40),
    guid: str(it.guid, 500),
    title: str(it.title, 500),
    link: str(it.link, 2000),
    date: num(it.date),
    seen: num(it.seen) || Date.now(),
    author: str(it.author, 200),
    summary: str(it.summary, 400),
    image: str(it.image, 2000),
    enc,
    duration: num(it.duration),
    episode: num(it.episode),
    season: num(it.season),
    chapters: str(it.chapters, 2000) || null,
    ichap: Array.isArray(it.ichap) ? it.ichap.slice(0, 500).filter((c) => c && Number.isFinite(c.start) && typeof c.title === 'string') : null,
    read: !!it.read,
    starred: !!it.starred,
    played: !!it.played,
    pos: num(it.pos) || 0,
    dl,
  };
}

/** Sort key of an item: its date, or when it was first seen. */
export const when = (it) => it.date || it.seen || 0;

export class FeedStore {
  constructor(storage) {
    this.storage = storage;
    this.feeds = [];
    this.items = new Map(); // feedId -> [item]
    this.contents = new Map(); // feedId -> { itemId: html }  (LRU, a few feeds)
    this.prefs = { keep: KEEP_DEFAULT, speed: 1, view: { type: 'all' }, collapsed: [], volume: 1 };
    this.subs = new Set();
    this.dirtyItems = new Set();
    this.dirtyContent = new Set();
    this.saveFeedsSoon = debounce(() => this.storage.set('feeds', this.feeds).catch(() => {}), 300);
    this.savePrefsSoon = debounce(() => this.storage.set('prefs', this.prefs).catch(() => {}), 300);
    this.saveItemsSoon = debounce(() => this.flushItems(), 400);
  }

  /** fn(what: 'feeds' | 'items' | 'merge' (a refresh), feedId | null) */
  on(fn) {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }
  emit(what, feedId = null) {
    for (const fn of [...this.subs]) {
      try {
        fn(what, feedId);
      } catch (err) {
        console.error('[feeds] store listener failed', err);
      }
    }
  }

  async load() {
    const feeds = await this.storage.get('feeds', []).catch(() => []);
    this.feeds = (Array.isArray(feeds) ? feeds : []).map(sanitizeFeed).filter(Boolean);
    const seen = new Set();
    this.feeds = this.feeds.filter((f) => (seen.has(f.id) ? false : (seen.add(f.id), true)));
    const prefs = await this.storage.get('prefs', null).catch(() => null);
    if (prefs && typeof prefs === 'object') {
      const keep = Math.round(Number(prefs.keep));
      this.prefs.keep = keep >= 20 && keep <= 5000 ? keep : KEEP_DEFAULT;
      const sp = Number(prefs.speed);
      this.prefs.speed = sp >= 0.5 && sp <= 3 ? sp : 1;
      const vol = Number(prefs.volume);
      this.prefs.volume = vol >= 0 && vol <= 1 ? vol : 1;
      if (prefs.view && typeof prefs.view === 'object' && typeof prefs.view.type === 'string') this.prefs.view = { type: prefs.view.type, id: str(prefs.view.id, 120) || undefined };
      this.prefs.collapsed = Array.isArray(prefs.collapsed) ? prefs.collapsed.filter((x) => typeof x === 'string').slice(0, 200) : [];
    }
    await Promise.all(
      this.feeds.map(async (f) => {
        const list = await this.storage.get(`items-${f.id}`, []).catch(() => []);
        this.items.set(f.id, (Array.isArray(list) ? list : []).map(sanitizeItem).filter(Boolean));
      }),
    );
  }

  setPref(k, v) {
    this.prefs[k] = v;
    this.savePrefsSoon();
  }

  feed(id) {
    return this.feeds.find((f) => f.id === id) || null;
  }
  feedByUrl(url) {
    const norm = (u) => String(u || '').replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();
    return this.feeds.find((f) => norm(f.url) === norm(url)) || null;
  }
  title(f) {
    return (f && (f.customTitle || f.title)) || '';
  }
  sortedFeeds() {
    return [...this.feeds].sort((a, b) => this.title(a).localeCompare(this.title(b), undefined, { sensitivity: 'base', numeric: true }));
  }
  folders() {
    return [...new Set(this.feeds.map((f) => f.folder).filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  }

  addFeed(data) {
    const existing = this.feedByUrl(data.url);
    if (existing) return existing;
    let id = hashId(data.url);
    while (this.feed(id)) id = hashId(`${id}+`);
    const f = sanitizeFeed({ ...data, id, added: Date.now() });
    this.feeds.push(f);
    this.items.set(f.id, []);
    this.saveFeedsSoon();
    this.emit('feeds');
    return f;
  }

  async removeFeed(id) {
    const i = this.feeds.findIndex((f) => f.id === id);
    if (i < 0) return;
    this.feeds.splice(i, 1);
    this.items.delete(id);
    this.contents.delete(id);
    this.dirtyItems.delete(id);
    this.dirtyContent.delete(id);
    this.saveFeedsSoon();
    await Promise.all([this.storage.delete(`items-${id}`), this.storage.delete(`content-${id}`)].map((p) => p.catch(() => {})));
    this.emit('feeds');
  }

  patchFeed(id, patch, { silent = false } = {}) {
    const f = this.feed(id);
    if (!f) return null;
    Object.assign(f, patch);
    this.saveFeedsSoon();
    if (!silent) this.emit('feeds', id);
    return f;
  }

  list(feedId) {
    return this.items.get(feedId) || [];
  }
  item(feedId, itemId) {
    return this.list(feedId).find((i) => i.id === itemId) || null;
  }
  byKey(key) {
    const [f, i] = splitKey(key);
    const it = this.item(f, i);
    return it ? { feed: this.feed(f), item: it, key } : null;
  }

  patchItem(feedId, itemId, patch, { silent = false } = {}) {
    const it = this.item(feedId, itemId);
    if (!it) return null;
    Object.assign(it, patch);
    this.dirtyItems.add(feedId);
    this.saveItemsSoon();
    if (!silent) this.emit('items', feedId);
    return it;
  }

  /** Same patch for many items: [{ feedId, itemId }]. */
  patchMany(refs, patch) {
    const feeds = new Set();
    for (const { feedId, itemId } of refs) {
      const it = this.item(feedId, itemId);
      if (!it) continue;
      Object.assign(it, typeof patch === 'function' ? patch(it) : patch);
      feeds.add(feedId);
    }
    for (const f of feeds) this.dirtyItems.add(f);
    if (feeds.size) {
      this.saveItemsSoon();
      this.emit('items', feeds.size === 1 ? [...feeds][0] : null);
    }
    return feeds.size;
  }

  async contentMap(feedId) {
    if (this.contents.has(feedId)) {
      const m = this.contents.get(feedId);
      this.contents.delete(feedId);
      this.contents.set(feedId, m); // LRU touch
      return m;
    }
    const m = await this.storage.get(`content-${feedId}`, {}).catch(() => ({}));
    const map = m && typeof m === 'object' && !Array.isArray(m) ? m : {};
    this.contents.set(feedId, map);
    while (this.contents.size > 6) {
      const old = [...this.contents.keys()].find((k) => !this.dirtyContent.has(k));
      if (!old) break;
      this.contents.delete(old);
    }
    return map;
  }
  async content(feedId, itemId) {
    const m = await this.contentMap(feedId);
    return typeof m[itemId] === 'string' ? m[itemId] : '';
  }

  /**
   * Merge a parsed feed into the stored items. First fetch: articles are unread, podcast episodes only the newest 3.
   * Returns { added: [item], updated: n }.
   */
  async merge(feedId, parsed) {
    const feed = this.feed(feedId);
    if (!feed) return { added: [], updated: 0 };
    const first = !feed.lastFetch;
    const list = this.list(feedId);
    const byId = new Map(list.map((i) => [i.id, i]));
    const contents = await this.contentMap(feedId);
    const now = Date.now();
    const added = [];
    let updated = 0;
    const fresh = [];
    for (const p of parsed.items) {
      const ident = p.guid || p.link || p.enclosure?.url || `${p.title}|${p.date || ''}`;
      if (!ident) continue;
      const id = hashId(ident);
      if (fresh.some((x) => x.id === id)) continue;
      let date = p.date || null;
      if (date && date > now + FUTURE_SLACK) date = null;
      const data = {
        guid: p.guid || '',
        title: p.title || '',
        link: p.link || '',
        date,
        author: p.author || '',
        summary: (p.summary || '').slice(0, 400),
        image: p.image || '',
        enc: p.enclosure ? { url: p.enclosure.url, type: p.enclosure.type || '', length: p.enclosure.length ?? null } : null,
        duration: p.duration ?? null,
        episode: p.episode ?? null,
        season: p.season ?? null,
        chapters: p.chapters || null,
        ichap: p.inlineChapters || null,
      };
      const old = byId.get(id);
      if (old) {
        const changed = ['title', 'link', 'summary', 'image', 'duration'].some((k) => (old[k] || null) !== (data[k] || null)) || old.enc?.url !== data.enc?.url;
        Object.assign(old, data, { date: data.date || old.date });
        if (changed) updated++;
      } else {
        const it = sanitizeItem({ id, ...data, seen: now, read: false });
        list.push(it);
        byId.set(id, it);
        added.push(it);
      }
      fresh.push({ id });
      if (p.html) contents[id] = p.html.length > CONTENT_MAX ? p.html.slice(0, CONTENT_MAX) : p.html;
    }
    if (first && feed.podcast !== false && parsed.podcast) {
      const newest = [...added].sort((a, b) => when(b) - when(a)).slice(0, 3);
      for (const it of added) if (!newest.includes(it)) it.read = true;
    }
    this.trim(feedId);
    const keepIds = new Set(this.list(feedId).map((i) => i.id));
    for (const k of Object.keys(contents)) if (!keepIds.has(k)) delete contents[k];
    this.dirtyItems.add(feedId);
    this.dirtyContent.add(feedId);
    this.saveItemsSoon();
    this.emit('merge', feedId);
    return { added: added.filter((i) => keepIds.has(i.id)), updated };
  }

  /** Keep the newest `keep` items (plus starred, downloaded and half-listened ones). */
  trim(feedId) {
    const list = this.list(feedId);
    list.sort((a, b) => when(b) - when(a));
    const keep = this.prefs.keep || KEEP_DEFAULT;
    if (list.length <= keep) return;
    const kept = list.filter((it, i) => i < keep || it.starred || it.dl || (it.pos > 0 && !it.played));
    this.items.set(feedId, kept);
  }

  async flushItems() {
    const jobs = [];
    for (const id of this.dirtyItems) if (this.feed(id)) jobs.push(this.storage.set(`items-${id}`, this.list(id)).catch(() => {}));
    for (const id of this.dirtyContent) if (this.feed(id) && this.contents.has(id)) jobs.push(this.storage.set(`content-${id}`, this.contents.get(id)).catch(() => {}));
    this.dirtyItems.clear();
    this.dirtyContent.clear();
    await Promise.all(jobs);
  }

  async flush() {
    this.saveFeedsSoon.flush();
    this.savePrefsSoon.flush();
    this.saveItemsSoon.cancel();
    await this.flushItems();
  }

  // ---------------------------------------------------------------- views
  /** [{ feed, item, key }] of a view, newest first. extra: { downloading: Set(key) } */
  query(view, extra = {}) {
    const out = [];
    const push = (f, filter) => {
      for (const it of this.list(f.id)) if (!filter || filter(it, f)) out.push({ feed: f, item: it, key: itemKey(f.id, it.id) });
    };
    const type = view?.type || 'all';
    for (const f of this.feeds) {
      if (type === 'all') push(f);
      else if (type === 'unread') push(f, (it) => !it.read || extra.sticky?.has(itemKey(f.id, it.id)));
      else if (type === 'starred') push(f, (it) => it.starred || extra.sticky?.has(itemKey(f.id, it.id)));
      else if (type === 'podcasts') {
        if (f.podcast) push(f, (it) => !!it.enc);
      } else if (type === 'downloads') push(f, (it) => !!it.dl || extra.downloading?.has(itemKey(f.id, it.id)));
      else if (type === 'feed') {
        if (f.id === view.id) push(f);
      } else if (type === 'folder') {
        if (f.folder && f.folder === view.id) push(f);
      }
    }
    out.sort((a, b) => when(b.item) - when(a.item));
    return out;
  }

  counts() {
    const perFeed = new Map();
    const perFolder = new Map();
    let unread = 0;
    let starred = 0;
    let podcasts = 0;
    let downloads = 0;
    for (const f of this.feeds) {
      let n = 0;
      for (const it of this.list(f.id)) {
        if (!it.read) n++;
        if (it.starred) starred++;
        if (it.dl) downloads++;
        if (f.podcast && it.enc && !it.read) podcasts++;
      }
      perFeed.set(f.id, n);
      if (f.folder) perFolder.set(f.folder, (perFolder.get(f.folder) || 0) + n);
      unread += n;
    }
    return { unread, starred, podcasts, downloads, perFeed, perFolder };
  }
}
