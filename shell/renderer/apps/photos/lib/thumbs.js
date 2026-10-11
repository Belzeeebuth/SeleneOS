// Thumbnail service shared by every Photos window.
//   thumbs.url(item)               -> URL string if available right now (memory or disk cache), else null
//   thumbs.request(item, prio)     -> Promise<url | null>  (generated off the main thread, cached on disk)
//   thumbs.cancel(item)            -> drop a queued request (tile scrolled away)
// Cache: memory (key -> URL, LRU) + disk (~/.config/aurora/apps/photos/thumbs/<key>.webp, key = path+mtime+size).
import { loadPixels } from './util.js';

const TH_HEIGHT = 320;
const TH_MAXW = 960;
const MEM_MAX = 1500;

export class Thumbs {
  constructor(api) {
    this.api = api;
    this.dir = null;
    this.mem = new Map(); // key -> { url, revoke }
    this.queue = []; // [{ item, resolve, prio, seq }]
    this.pending = new Map(); // key -> Promise
    this.waiters = new Map(); // key -> job
    this.workers = [];
    this.busy = 0;
    this.seq = 0;
    this.failed = new Set();
    this.listeners = new Set();
    this.workerBroken = false;
  }

  async init() {
    if (!this.dir) this.dir = await this.api.invoke('photos:thumbDir').catch(() => null);
    return this;
  }

  /** Listen for item size corrections ({ item, w, h }) found while decoding. */
  onSize(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _memGet(key) {
    const e = this.mem.get(key);
    if (!e) return null;
    this.mem.delete(key);
    this.mem.set(key, e);
    return e.url;
  }
  _memSet(key, url, revoke = false) {
    this.mem.set(key, { url, revoke });
    while (this.mem.size > MEM_MAX) {
      const [k, v] = this.mem.entries().next().value;
      this.mem.delete(k);
      if (v.revoke) URL.revokeObjectURL(v.url);
    }
  }

  url(item) {
    if (!item) return null;
    if (item.ext === '.svg') return this.api.mediaUrl(item.path);
    const m = this._memGet(item.key);
    if (m) return m;
    if (item.thumb && this.dir) {
      const u = this.api.mediaUrl(`${this.dir}/${item.key}.webp`);
      this._memSet(item.key, u);
      return u;
    }
    return null;
  }

  isFailed(item) {
    return this.failed.has(item.key);
  }

  request(item, prio = 0) {
    const now = this.url(item);
    if (now) return Promise.resolve(now);
    if (this.failed.has(item.key)) return Promise.resolve(null);
    let p = this.pending.get(item.key);
    if (p) {
      const job = this.waiters.get(item.key);
      if (job) {
        job.prio = Math.max(job.prio, prio);
        job.seq = ++this.seq;
      }
      return p;
    }
    p = new Promise((resolve) => {
      const job = { item, resolve, prio, seq: ++this.seq };
      this.waiters.set(item.key, job);
      this.queue.push(job);
    });
    this.pending.set(item.key, p);
    this._pump();
    return p;
  }

  cancel(item) {
    const job = this.waiters.get(item?.key);
    if (!job || job.running) return;
    const i = this.queue.indexOf(job);
    if (i >= 0) this.queue.splice(i, 1);
    this.waiters.delete(item.key);
    this.pending.delete(item.key);
    job.resolve(null);
  }

  _poolSize() {
    return Math.max(2, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
  }

  _worker() {
    if (this.workerBroken) return null;
    const free = this.workers.find((w) => !w.busy);
    if (free) return free;
    if (this.workers.length >= this._poolSize()) return null;
    try {
      const w = new Worker(new URL('./thumb-worker.js', import.meta.url), { type: 'module' });
      const slot = { w, busy: false, cb: null };
      w.onmessage = (e) => slot.cb?.(e.data);
      w.onerror = (e) => {
        e.preventDefault?.();
        slot.cb?.({ error: 'worker' });
      };
      this.workers.push(slot);
      return slot;
    } catch {
      this.workerBroken = true;
      return null;
    }
  }

  _pump() {
    while (this.queue.length) {
      const slot = this._worker();
      if (!slot && !this.workerBroken) return;
      if (this.workerBroken && this.busy >= 2) return;
      // Highest priority first, then most recently requested (the tiles the user looks at now).
      let bi = 0;
      for (let i = 1; i < this.queue.length; i++) {
        const a = this.queue[i];
        const b = this.queue[bi];
        if (a.prio > b.prio || (a.prio === b.prio && a.seq > b.seq)) bi = i;
      }
      const job = this.queue.splice(bi, 1)[0];
      job.running = true;
      this.busy++;
      this._run(job, slot).finally(() => {
        this.busy--;
        if (slot) slot.busy = false;
        this._pump();
      });
    }
  }

  async _run(job, slot) {
    const { item } = job;
    let res = null;
    if (slot) {
      slot.busy = true;
      const id = job.seq;
      res = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          // A worker stuck on a huge / hostile file is replaced: its late answer must never be taken for
          // the next job's thumbnail (it would be cached and saved under the wrong key).
          slot.cb = null;
          slot.w.terminate();
          this.workers = this.workers.filter((x) => x !== slot);
          resolve({ error: 'timeout' });
        }, 30000);
        slot.cb = (d) => {
          if (d?.id !== id && d?.error !== 'worker') return; // stale answer
          clearTimeout(timer);
          slot.cb = null;
          resolve(d);
        };
        slot.w.postMessage({ id, url: this.api.mediaUrl(item.path), height: TH_HEIGHT, maxWidth: TH_MAXW });
      });
    }
    if (!res || res.error) res = await this._mainThread(item).catch((err) => ({ error: String(err?.message || err) }));
    let url = null;
    if (res && !res.error && res.blob) {
      url = URL.createObjectURL(res.blob);
      this._memSet(item.key, url, true);
      if (res.w && res.h && (item.w !== res.w || item.h !== res.h)) {
        item.w = res.w;
        item.h = res.h;
        for (const fn of this.listeners) fn(item);
      }
      this._persist(item, res.blob);
    } else this.failed.add(item.key);
    this.waiters.delete(item.key);
    this.pending.delete(item.key);
    job.resolve(url);
  }

  // Fallback when a worker can't decode (or workers are unavailable): <img> decode + canvas.
  async _mainThread(item) {
    const img = await loadPixels(this.api.mediaUrl(item.path));
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (!w || !h) throw new Error('empty');
    let th = Math.min(TH_HEIGHT, h);
    let tw = Math.max(1, Math.round((w * th) / h));
    if (tw > TH_MAXW) {
      tw = TH_MAXW;
      th = Math.max(1, Math.round((h * tw) / w));
    }
    const c = document.createElement('canvas');
    c.width = tw;
    c.height = th;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, tw, th);
    const blob = await new Promise((r) => c.toBlob(r, 'image/webp', 0.82));
    if (!blob) throw new Error('encode');
    return { blob, w, h };
  }

  async _persist(item, blob) {
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      await this.api.invoke('photos:thumbPut', item.key, bytes);
      item.thumb = true;
    } catch {}
  }

  /** Forget everything about a file (after it changed or was deleted). */
  forget(item) {
    if (!item) return;
    const e = this.mem.get(item.key);
    if (e?.revoke) URL.revokeObjectURL(e.url);
    this.mem.delete(item.key);
    this.failed.delete(item.key);
  }
}

let shared = null;
export function sharedThumbs(api) {
  if (!shared) shared = new Thumbs(api);
  return shared;
}
