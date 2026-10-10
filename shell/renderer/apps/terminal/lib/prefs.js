// Terminal settings, shared by every Terminal window (ES modules are loaded once per shell page).
// Persisted with ctx.storage ('prefs' -> ~/.config/aurora/apps/terminal/prefs.json).
//   await prefs.load(ctx)   prefs.get('fontSize')   prefs.set('fontSize', 15)   prefs.reset()
//   prefs.on('change', (key, value) => …)   key '*' after a reset
import { Emitter } from '../../../core/api.js';
import { SCHEMES } from './schemes.js';

export const FONTS = ['Cascadia Code', 'Cascadia Mono', 'DejaVu Sans Mono', 'Noto Sans Mono', 'Liberation Mono', 'Ubuntu Mono'];
export const CURSORS = ['bar', 'underline', 'block'];
export const BELLS = ['visual', 'sound', 'none'];
export const CLOSE_ON_EXIT = ['graceful', 'always', 'never'];

export const DEFAULTS = Object.freeze({
  defaultProfile: 'shell',
  startDir: '', // '' = home folder
  scheme: 'system',
  fontFace: 'Cascadia Code',
  fontSize: 14,
  lineHeight: 1.2,
  cursorShape: 'bar',
  cursorBlink: true,
  scrollback: 10000,
  opacity: 100,
  acrylic: false,
  copyOnSelect: false,
  confirmClose: true,
  warnPaste: true,
  bell: 'visual',
  closeOnExit: 'graceful',
});

const LIMITS = { fontSize: [6, 48], lineHeight: [1, 2], scrollback: [0, 100000], opacity: [20, 100] };

function sanitize(v) {
  const out = { ...DEFAULTS };
  if (!v || typeof v !== 'object') return out;
  for (const [k, def] of Object.entries(DEFAULTS)) {
    const x = v[k];
    if (x === undefined || x === null) continue;
    if (typeof def === 'boolean') out[k] = !!x;
    else if (typeof def === 'number') {
      const n = Number(x);
      if (Number.isFinite(n)) {
        const [lo, hi] = LIMITS[k] || [-Infinity, Infinity];
        out[k] = Math.max(lo, Math.min(hi, n));
      }
    } else if (typeof x === 'string') out[k] = x;
  }
  if (!CURSORS.includes(out.cursorShape)) out.cursorShape = DEFAULTS.cursorShape;
  if (!BELLS.includes(out.bell)) out.bell = DEFAULTS.bell;
  if (!CLOSE_ON_EXIT.includes(out.closeOnExit)) out.closeOnExit = DEFAULTS.closeOnExit;
  if (out.scheme !== 'system' && !SCHEMES.some((s) => s.id === out.scheme)) out.scheme = 'system';
  if (!out.fontFace.trim()) out.fontFace = DEFAULTS.fontFace;
  out.scrollback = Math.round(out.scrollback);
  return out;
}

const emitter = new Emitter();
let values = { ...DEFAULTS };
let loading = null;
let storage = null;
let saveTimer = null;

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    storage?.set('prefs', values).catch((err) => console.error('[terminal] saving settings failed', err));
  }, 250);
}

export const prefs = {
  DEFAULTS,
  load(ctx) {
    if (!loading) {
      storage = ctx.storage;
      loading = storage
        .get('prefs', null)
        .then((v) => {
          values = sanitize(v);
        })
        .catch(() => {
          values = { ...DEFAULTS };
        });
    }
    return loading.then(() => values);
  },
  get(key) {
    return values[key];
  },
  all() {
    return values;
  },
  set(key, value) {
    const next = sanitize({ ...values, [key]: value });
    if (next[key] === values[key]) return;
    values = next;
    save();
    emitter.emit('change', key, values[key]);
  },
  reset() {
    values = { ...DEFAULTS };
    save();
    emitter.emit('change', '*', null);
  },
  on: (ev, fn) => emitter.on(ev, fn),
  sanitize,
};
