// State shared by every Archive Manager window: preferences, the Recent archives list, the tools the
// backend found, and the open windows (opening an archive that is already open focuses its window).
import { Emitter } from '../../../core/api.js';

const DEFAULT_PREFS = {
  sort: { key: 'name', dir: 'asc' },
  widths: { name: 300, type: 150, packed: 110, size: 100, ratio: 70, mtime: 160, location: 220 },
  nav: true,
  preview: true,
  navWidth: 220,
  previewWidth: 300,
  compact: false,
  overwrite: 'rename',
  showWhenDone: true,
  format: 'zip',
  level: 5,
};
const MAX_RECENT = 12;

class Shared extends Emitter {
  constructor() {
    super();
    this.ready = null;
    this.ctx = null;
    this.prefs = structuredClone(DEFAULT_PREFS);
    this.recent = [];
    this.tools = { sevenZip: true, bsdtar: true, bsdcat: true, create: ['zip', '7z', 'tar', 'tar.gz', 'tar.xz', 'tar.zst', 'tar.bz2'], encrypt: true };
    this.windows = new Set();
    this.saveTimer = null;
  }

  init(ctx) {
    if (!this.ready) {
      this.ctx = ctx;
      this.ready = (async () => {
        const [prefs, recent, tools] = await Promise.all([
          ctx.storage.get('prefs', null).catch(() => null),
          ctx.storage.get('recent', []).catch(() => []),
          ctx.api.invoke('archive:tools').catch(() => null),
        ]);
        if (prefs && typeof prefs === 'object') {
          for (const k of Object.keys(DEFAULT_PREFS)) {
            const v = prefs[k];
            if (v === undefined || v === null) continue;
            if (typeof DEFAULT_PREFS[k] === 'object') {
              if (typeof v === 'object') this.prefs[k] = { ...DEFAULT_PREFS[k], ...sanitizeObj(v, DEFAULT_PREFS[k]) };
            } else if (typeof v === typeof DEFAULT_PREFS[k]) this.prefs[k] = v;
          }
        }
        this.prefs.navWidth = clamp(this.prefs.navWidth, 140, 480);
        this.prefs.previewWidth = clamp(this.prefs.previewWidth, 200, 640);
        if (!['rename', 'replace', 'skip'].includes(this.prefs.overwrite)) this.prefs.overwrite = 'rename';
        if (!['asc', 'desc'].includes(this.prefs.sort.dir)) this.prefs.sort.dir = 'asc';
        if (Array.isArray(recent)) {
          this.recent = recent
            .filter((r) => r && typeof r.path === 'string' && r.path.startsWith('/'))
            .slice(0, MAX_RECENT)
            .map((r) => ({ path: r.path, name: String(r.name || r.path.split('/').pop()), date: Number(r.date) || 0, size: Number(r.size) || 0, format: String(r.format || '') }));
        }
        if (tools && typeof tools === 'object') this.tools = tools;
      })();
    }
    return this.ready;
  }

  setPref(key, value) {
    this.prefs[key] = value;
    this.emit('prefs', key);
    this.persist('prefs');
  }

  recentAdd(listing) {
    const item = { path: listing.path, name: listing.name, date: Date.now(), size: listing.size, format: listing.format };
    this.recent = [item, ...this.recent.filter((r) => r.path !== item.path)].slice(0, MAX_RECENT);
    this.emit('recent');
    this.persist('recent');
  }
  recentRemove(path) {
    this.recent = this.recent.filter((r) => r.path !== path);
    this.emit('recent');
    this.persist('recent');
  }
  recentClear() {
    this.recent = [];
    this.emit('recent');
    this.persist('recent');
  }

  persist(what) {
    clearTimeout(this.saveTimer?.[what]);
    this.saveTimer = this.saveTimer || {};
    this.saveTimer[what] = setTimeout(() => {
      this.ctx?.storage.set(what, what === 'prefs' ? this.prefs : this.recent).catch(() => {});
    }, 250);
  }

  findOpen(path) {
    for (const w of this.windows) if (w.listing?.path === path && !w.win._closing) return w;
    return null;
  }
}

function sanitizeObj(v, def) {
  const out = {};
  for (const [k, d] of Object.entries(def)) if (typeof v[k] === typeof d) out[k] = v[k];
  return out;
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, Number(v) || a));

export const shared = new Shared();
