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
      this.recent = Array.isArray(recent) ? recent.filter((r) => r && typeof r.path === 'string' && r.path.startsWith('/')).slice(0, RECENT_MAX) : [];
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
