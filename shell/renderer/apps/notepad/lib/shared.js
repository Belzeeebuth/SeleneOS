// State shared by every Notepad window (one module instance serves them all):
// preferences, recent files, the restorable session and the list of open windows.
// Persisted with ctx.storage in ~/.config/aurora/apps/notepad/{prefs,recent,session}.json.

export const FONT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72];
export const ZOOM_MIN = 10;
export const ZOOM_MAX = 500;

export const DEFAULT_PREFS = {
  font: { family: 'Cascadia Mono', weight: 400, italic: false, size: 11 },
  wordWrap: true,
  statusBar: true,
  zoom: 100,
  theme: 'system', // system | light | dark
  openFiles: 'tab', // tab | window
  startup: 'new', // new (start a new session, ask to save) | restore (continue the previous session)
  matchCase: false,
  wrapAround: true,
  wholeWord: false,
  defaultEol: 'lf',
};

const MAX_RECENT = 12;

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

const oneOf = (v, list, def) => (list.includes(v) ? v : def);
const bool = (v, def) => (typeof v === 'boolean' ? v : def);

/** Stored preferences are untrusted (hand-edited or from an older version): keep only valid values. */
export function sanitizePrefs(raw) {
  const d = DEFAULT_PREFS;
  const p = raw && typeof raw === 'object' ? raw : {};
  const f = p.font && typeof p.font === 'object' ? p.font : {};
  const family = typeof f.family === 'string' ? f.family.replace(/["\\;{}<>]/g, '').trim().slice(0, 80) : '';
  const size = Number(f.size);
  const weight = Number(f.weight);
  const zoom = Number(p.zoom);
  return {
    font: {
      family: family || d.font.family,
      weight: [300, 400, 600, 700].includes(weight) ? weight : d.font.weight,
      italic: bool(f.italic, d.font.italic),
      size: Number.isFinite(size) && size >= 6 && size <= 96 ? Math.round(size) : d.font.size,
    },
    wordWrap: bool(p.wordWrap, d.wordWrap),
    statusBar: bool(p.statusBar, d.statusBar),
    zoom: Number.isFinite(zoom) ? Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(zoom))) : d.zoom,
    theme: oneOf(p.theme, ['system', 'light', 'dark'], d.theme),
    openFiles: oneOf(p.openFiles, ['tab', 'window'], d.openFiles),
    startup: oneOf(p.startup, ['new', 'restore'], d.startup),
    matchCase: bool(p.matchCase, d.matchCase),
    wrapAround: bool(p.wrapAround, d.wrapAround),
    wholeWord: bool(p.wholeWord, d.wholeWord),
    defaultEol: oneOf(p.defaultEol, ['lf', 'crlf', 'cr'], d.defaultEol),
  };
}

export const shared = {
  ready: null,
  storage: null,
  api: null,
  prefs: clone(DEFAULT_PREFS),
  recent: [],
  session: null,
  windows: [], // NotepadWindow controllers, oldest first
  mru: [], // most recently focused first
  justFocused: null,
  fonts: null,
  _subs: new Map(),
  _timers: {},

  init(ctx) {
    if (!this.ready) {
      this.storage = ctx.storage;
      this.api = ctx.api;
      this.ready = (async () => {
        const get = (n, f) => ctx.storage.get(n, f).catch(() => f);
        const [prefs, recent, session] = await Promise.all([get('prefs', null), get('recent', []), get('session', null)]);
        this.prefs = sanitizePrefs(prefs);
        this.recent = Array.isArray(recent) ? [...new Set(recent.filter((p) => typeof p === 'string' && p.startsWith('/')))].slice(0, MAX_RECENT) : [];
        this.session = session && Array.isArray(session.windows) ? { windows: session.windows.filter((w) => w && typeof w === 'object' && Array.isArray(w.tabs)) } : { windows: [] };
        this.watchTooltips();
      })();
    }
    return this.ready;
  },

  // Tooltips are drawn at screen level (core/ui.js): give the ones shown over a Notepad window that
  // overrides the system theme (Settings > App theme) that window's colours too.
  watchTooltips() {
    if (this._tipObserver || typeof MutationObserver === 'undefined') return;
    let hoverWin = null;
    document.addEventListener('pointerover', (e) => (hoverWin = e.target?.closest?.('.win.app-notepad') || null), true);
    this._tipObserver = new MutationObserver((recs) => {
      for (const r of recs) {
        for (const n of r.addedNodes) {
          if (n.nodeType !== 1 || !n.classList.contains('tooltip')) continue;
          const owner = (hoverWin?.isConnected && hoverWin) || document.activeElement?.closest?.('.win.app-notepad');
          const cls = owner && [...owner.classList].find((c) => c === 'np-theme-light' || c === 'np-theme-dark');
          if (cls) n.classList.add(cls);
        }
      }
    });
    this._tipObserver.observe(document.body, { childList: true });
  },

  on(ev, fn) {
    if (!this._subs.has(ev)) this._subs.set(ev, new Set());
    this._subs.get(ev).add(fn);
    return () => this._subs.get(ev)?.delete(fn);
  },
  emit(ev, ...a) {
    for (const fn of [...(this._subs.get(ev) || [])]) {
      try {
        fn(...a);
      } catch (err) {
        console.error(`[notepad] ${ev} listener failed`, err);
      }
    }
  },

  _save(name, value, delay = 250) {
    clearTimeout(this._timers[name]);
    this._timers[name] = setTimeout(() => {
      this.storage?.set(name, value).catch((err) => console.error(`[notepad] saving ${name} failed`, err));
    }, delay);
  },

  setPref(key, value) {
    if (JSON.stringify(this.prefs[key]) === JSON.stringify(value)) return;
    this.prefs[key] = value;
    this._save('prefs', this.prefs);
    this.emit('prefs', key, value);
    if (key === 'startup' && value !== 'restore') this.clearSession();
  },

  addRecent(path) {
    if (!path) return;
    this.recent = [path, ...this.recent.filter((p) => p !== path)].slice(0, MAX_RECENT);
    this._save('recent', this.recent);
    this.emit('recent');
    // Also feed the Start menu's "Recommended" list.
    import('../../../core/start.js')
      .then((m) => m.recent?.addFile?.(path))
      .catch(() => {});
  },
  removeRecent(path) {
    this.recent = this.recent.filter((p) => p !== path);
    this._save('recent', this.recent);
    this.emit('recent');
  },
  clearRecent() {
    this.recent = [];
    this._save('recent', this.recent);
    this.emit('recent');
  },

  // ---------------------------------------------------------------- session (Continue previous session)
  saveSessionEntry(key, entry) {
    const list = this.session.windows.filter((w) => w.key !== key);
    list.push({ key, ...entry });
    this.session = { windows: list };
    this._save('session', this.session, 400);
  },
  removeSessionEntry(key) {
    if (!this.session.windows.some((w) => w.key === key)) return;
    this.session = { windows: this.session.windows.filter((w) => w.key !== key) };
    this._save('session', this.session, 0);
  },
  takeSession() {
    const list = this.session.windows;
    this.session = { windows: [] };
    return list;
  },
  clearSession() {
    this.session = { windows: [] };
    this._save('session', this.session, 0);
  },
  flushSession() {
    clearTimeout(this._timers.session);
    return this.storage?.set('session', this.session).catch(() => {});
  },

  // ---------------------------------------------------------------- windows
  register(w) {
    this.windows.push(w);
  },
  unregister(w) {
    this.windows = this.windows.filter((x) => x !== w);
    this.mru = this.mru.filter((x) => x !== w);
  },
  // Focus tracking. The registry focuses the *oldest* Notepad window right before calling
  // onRelaunch; justFocused remembers which window was in front before that, for one tick.
  noteFocus(w) {
    if (this.mru[0] !== w) {
      const jf = { w, prev: this.mru[0] || null };
      this.justFocused = jf;
      setTimeout(() => {
        if (this.justFocused === jf) this.justFocused = null;
      });
    }
    this.mru = [w, ...this.mru.filter((x) => x !== w)];
  },
  relaunchTarget() {
    const jf = this.justFocused;
    if (jf?.prev && this.windows.includes(jf.prev) && !jf.prev.closing) return jf.prev;
    return this.mostRecent();
  },
  mostRecent() {
    const alive = this.mru.find((w) => this.windows.includes(w) && !w.closing);
    if (alive) return alive;
    const wm = this.windows[0]?.ctx.shell.wm;
    if (!wm) return null;
    const order = wm.mru({ desktop: null });
    for (const win of order) {
      const w = this.windows.find((x) => x.win === win && !x.closing);
      if (w) return w;
    }
    return this.windows.find((x) => !x.closing) || null;
  },
  findDoc(path) {
    if (!path) return null; // (Untitled tabs have no path)
    for (const w of this.windows) {
      const d = w.docs.find((x) => x.path === path);
      if (d) return { w, d };
    }
    return null;
  },

  async loadFonts() {
    // A font installed or removed in the Fonts app (event fonts:changed) is seen on the next list.
    if (!this._fontsWatch && typeof this.api?.on === 'function') {
      this._fontsWatch = true;
      this.api.on('fonts:changed', () => {
        this.fonts = null;
      });
    }
    if (this.fonts) return this.fonts;
    try {
      this.fonts = await this.api.invoke('notepad:fonts');
    } catch {
      this.fonts = { all: [], mono: [] };
    }
    return this.fonts;
  },
};
