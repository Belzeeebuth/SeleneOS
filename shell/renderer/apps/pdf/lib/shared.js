// State shared by every PDF Reader window: preferences and the Recent documents list.
// Persisted with ctx.storage (~/.config/aurora/apps/pdf/{prefs,recent}.json).
import { Emitter } from '../../../core/api.js';

const RECENT_MAX = 30;

export const DEFAULT_PREFS = {
  sidebar: true, // sidebar open for documents
  sidebarWidth: 232,
  sidebarView: 'thumbs', // thumbs | outline | attachments
  darkPages: false, // dark reading mode (inverted pages)
  layout: 'continuous', // single | continuous | two | cover
  highlightColor: '#FFFF98',
  inkColor: '#1E1E1E',
  inkThickness: 3,
  inkOpacity: 100,
  textColor: '#1E1E1E',
  textSize: 14,
};

// Colours offered by the tools (highlight colours match pdf.js' defaults so its own pickers agree).
export const HIGHLIGHT_COLORS = [
  ['yellow', '#FFFF98'],
  ['green', '#53FFBC'],
  ['blue', '#80EBFF'],
  ['pink', '#FFCBE6'],
  ['red', '#FF4F5F'],
];
export const PEN_COLORS = [
  ['black', '#1E1E1E'],
  ['red', '#E81123'],
  ['orange', '#F7630C'],
  ['yellow', '#FFB900'],
  ['green', '#16C60C'],
  ['blue', '#0078D4'],
  ['purple', '#8764B8'],
  ['white', '#FFFFFF'],
];

export const shared = {
  ready: null,
  api: null,
  prefs: { ...DEFAULT_PREFS },
  recent: [],
  windows: new Set(),
  lastFocused: null,
  events: new Emitter(),

  init(ctx) {
    if (this.ready) return this.ready;
    this.api = ctx.api;
    this.ready = (async () => {
      const [prefs, recent] = await Promise.all([ctx.storage.get('prefs', {}).catch(() => ({})), ctx.storage.get('recent', []).catch(() => [])]);
      this.prefs = sanitizePrefs(prefs);
      this.recent = sanitizeRecent(recent);
    })();
    return this.ready;
  },

  on(ev, fn) {
    return this.events.on(ev, fn);
  },

  setPref(key, value) {
    if (this.prefs[key] === value) return;
    this.prefs[key] = value;
    this.save('prefs', this.prefs);
    this.events.emit('prefs', key, value);
  },

  // ---------------------------------------------------------------- recent documents
  recentGet(path) {
    return this.recent.find((r) => r.path === path) || null;
  },
  /** Insert or update an entry (moved to the top unless keepOrder). */
  recentPut(entry, { keepOrder = false } = {}) {
    const i = this.recent.findIndex((r) => r.path === entry.path);
    const prev = i >= 0 ? this.recent[i] : null;
    const next = { ...(prev || {}), ...entry };
    if (i >= 0) this.recent.splice(i, 1);
    if (keepOrder && i >= 0) this.recent.splice(i, 0, next);
    else this.recent.unshift(next);
    this.recent.length = Math.min(this.recent.length, RECENT_MAX);
    this.saveRecent();
    return next;
  },
  recentRemove(path) {
    const n = this.recent.length;
    this.recent = this.recent.filter((r) => r.path !== path);
    if (this.recent.length !== n) this.saveRecent();
  },
  recentClear() {
    this.recent = [];
    this.saveRecent();
  },
  recentRename(from, to) {
    const r = this.recentGet(from);
    if (!r) return;
    this.recentRemove(to);
    r.path = to;
    r.name = to.split('/').pop();
    this.saveRecent();
  },
  saveRecent() {
    clearTimeout(this._recentTimer);
    this._recentTimer = setTimeout(() => this.save('recent', this.recent), 200);
    this.events.emit('recent');
  },

  save(name, value) {
    this.api?.invoke('storage:set', 'pdf', name, value).catch((err) => console.error('[pdf] saving', name, err));
  },

  // ---------------------------------------------------------------- windows
  register(w) {
    this.windows.add(w);
  },
  unregister(w) {
    this.windows.delete(w);
    if (this.lastFocused === w) this.lastFocused = null;
  },
  noteFocus(w) {
    this.lastFocused = w;
  },
  /** Window that should receive a file opened from elsewhere. */
  target() {
    if (this.lastFocused && this.windows.has(this.lastFocused) && !this.lastFocused.closing) return this.lastFocused;
    return [...this.windows].reverse().find((w) => !w.closing) || null;
  },
  /** { win, tab } already showing this file, if any. */
  findOpen(path) {
    for (const w of this.windows) {
      const tab = w.tabs.find((t) => t.doc?.path === path);
      if (tab) return { win: w, tab };
    }
    return null;
  },
};

/**
 * The Recent list comes from a JSON file the user (or anything else) can edit: keep only well-formed
 * entries and fields, so a bad value can never break the start page or point an <img> at the network.
 */
export function sanitizeRecent(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  const int = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : undefined);
  for (const r of list) {
    if (!r || typeof r !== 'object' || typeof r.path !== 'string') continue;
    const path = r.path;
    if (!path.startsWith('/') || path.length > 4096 || path.includes('\0') || seen.has(path)) continue;
    seen.add(path);
    const e = { path, name: typeof r.name === 'string' && r.name.trim() ? r.name.slice(0, 255) : path.split('/').pop() || path };
    const pages = int(r.pages, 1, 1e6);
    if (pages) e.pages = pages;
    const page = int(r.page, 1, 1e6);
    if (page) e.page = pages ? Math.min(page, pages) : page;
    // Dates between 1990 and 100 years from now (anything else cannot be formatted).
    if (Number.isFinite(r.date) && r.date > 631152000000 && r.date < Date.now() + 3.15e12) e.date = r.date;
    if (Number.isFinite(r.size) && r.size >= 0) e.size = r.size;
    if (['auto', 'page-actual', 'page-fit', 'page-width'].includes(r.scale) || (Number.isFinite(r.scale) && r.scale >= 0.1 && r.scale <= 10)) e.scale = r.scale;
    if (typeof r.thumb === 'string' && r.thumb.length < 400000 && /^data:image\/(jpeg|png);base64,[a-z0-9+/=]+$/i.test(r.thumb)) e.thumb = r.thumb;
    out.push(e);
    if (out.length >= RECENT_MAX) break;
  }
  return out;
}

/** Why a save failed, in the user's language (system messages are English and technical). */
export function saveErrorText(t, err) {
  const code = err?.code || '';
  if (code === 'EACCES' || code === 'EPERM') return t('save.errDenied');
  if (code === 'ENOSPC' || code === 'EDQUOT') return t('save.errSpace');
  if (code === 'EROFS') return t('save.errReadOnly');
  if (code === 'ENOENT' || code === 'ENOTDIR') return t('save.errFolder');
  if (code === 'EISDIR') return t('save.errIsFolder');
  return t('save.errOther');
}

function sanitizePrefs(p) {
  const out = { ...DEFAULT_PREFS };
  if (!p || typeof p !== 'object') return out;
  const bool = (k) => typeof p[k] === 'boolean' && (out[k] = p[k]);
  const num = (k, lo, hi) => Number.isFinite(p[k]) && (out[k] = Math.max(lo, Math.min(hi, p[k])));
  const color = (k) => typeof p[k] === 'string' && /^#[0-9a-f]{6}$/i.test(p[k]) && (out[k] = p[k].toUpperCase());
  const oneOf = (k, list) => list.includes(p[k]) && (out[k] = p[k]);
  bool('sidebar');
  bool('darkPages');
  num('sidebarWidth', 160, 420);
  num('inkThickness', 1, 20);
  num('inkOpacity', 10, 100);
  num('textSize', 8, 72);
  color('highlightColor');
  color('inkColor');
  color('textColor');
  oneOf('sidebarView', ['thumbs', 'outline', 'attachments']);
  oneOf('layout', ['single', 'continuous', 'two', 'cover']);
  return out;
}
