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

export const shared = {
  ready: null,
  storage: null,
  api: null,
  prefs: clone(DEFAULT_PREFS),
  recent: [],
  session: null,
  windows: [], // NotepadWindow controllers, oldest first
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
        if (prefs && typeof prefs === 'object') {
          this.prefs = { ...clone(DEFAULT_PREFS), ...prefs, font: { ...DEFAULT_PREFS.font, ...(prefs.font || {}) } };
        }
        this.recent = Array.isArray(recent) ? recent.filter((p) => typeof p === 'string') : [];
        this.session = session && Array.isArray(session.windows) ? session : { windows: [] };
      })();
    }
    return this.ready;
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
  },
  mostRecent() {
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
    for (const w of this.windows) {
      const d = w.docs.find((x) => x.path === path);
      if (d) return { w, d };
    }
    return null;
  },

  async loadFonts() {
    if (this.fonts) return this.fonts;
    try {
      this.fonts = await this.api.invoke('notepad:fonts');
    } catch {
      this.fonts = { all: [], mono: [] };
    }
    return this.fonts;
  },
};
