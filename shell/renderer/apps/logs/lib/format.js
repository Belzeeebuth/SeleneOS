// Pure helpers of the « Journaux système » app (no DOM, also imported by test/logs.test.mjs):
// priorities, the views (presets), the saved filters and the query sent to main/ipc/journal.js.

/** syslog level names, in priority order (0 = emergency … 7 = debug). Also the text export / copy keywords. */
export const LEVEL_KEYS = ['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug'];
/** Phosphor glyph per priority (filled for 0..5). */
export const PRIO_ICONS = ['fire', 'shield-warning', 'warning-circle', 'x-circle', 'warning', 'info', 'info', 'code'];
/** Colour family per priority: CSS classes .tone-<tone>, values from the tokens. */
export function prioTone(p) {
  if (p == null) return 'none';
  if (p <= 2) return 'critical';
  if (p === 3) return 'error';
  if (p === 4) return 'warning';
  if (p === 5) return 'notice';
  if (p === 6) return 'info';
  return 'debug';
}

export const PERIODS = ['all', '1h', '24h', '7d', 'custom'];
export const SCOPES = ['all', 'kernel', 'user'];
const BASE = { boot: 'current', priority: 7, period: 'all', since: null, until: null, scope: 'all', source: null, search: '' };
/** The five views of the toolbar. */
export const PRESETS = {
  errors: { ...BASE, priority: 3 },
  previous: { ...BASE, boot: 'previous' },
  kernel: { ...BASE, scope: 'kernel' },
  mine: { ...BASE, scope: 'user' },
  all: { ...BASE, boot: 'all' },
};
export const PRESET_ORDER = ['errors', 'previous', 'kernel', 'mine', 'all'];
export const DEFAULT_STATE = { ...PRESETS.errors };

const BOOT_ID = /^[0-9a-f]{32}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const UNIT = /^(?!-)[A-Za-z0-9:_.@\\*?-]{1,256}$/;
const IDENT = /^(?!-)[^\x00-\x1f\x7f]{1,128}$/;

export const validUnit = (s) => typeof s === 'string' && UNIT.test(s);
export const validIdent = (s) => typeof s === 'string' && IDENT.test(s) && s.trim() === s;

/** Saved filters are user-editable JSON: keep only well-formed values. */
export function sanitizeState(s) {
  const out = { ...DEFAULT_STATE };
  if (!s || typeof s !== 'object' || Array.isArray(s)) return out;
  if (['current', 'previous', 'all'].includes(s.boot) || BOOT_ID.test(String(s.boot))) out.boot = s.boot;
  if (Number.isInteger(s.priority) && s.priority >= 0 && s.priority <= 7) out.priority = s.priority;
  if (PERIODS.includes(s.period)) out.period = s.period;
  if (out.period === 'custom') {
    const since = typeof s.since === 'string' && ISO.test(s.since) && Number.isFinite(Date.parse(s.since)) ? s.since : null;
    const until = typeof s.until === 'string' && ISO.test(s.until) && Number.isFinite(Date.parse(s.until)) ? s.until : null;
    if ((since || until) && !(since && until && Date.parse(since) > Date.parse(until))) Object.assign(out, { since, until });
    else out.period = 'all';
  }
  if (SCOPES.includes(s.scope)) out.scope = s.scope;
  const src = s.source;
  if (src && typeof src === 'object' && (src.kind === 'unit' ? validUnit(src.value) : src.kind === 'ident' ? validIdent(src.value) : false)) out.source = { kind: src.kind, value: src.value };
  if (typeof s.search === 'string') out.search = s.search.slice(0, 200).replace(/[\x00-\x1f\x7f]/g, ' ');
  return out;
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
/** The view these filters are, or null (custom filters). */
export function presetOf(state) {
  for (const id of PRESET_ORDER) {
    const p = PRESETS[id];
    if (Object.keys(p).every((k) => same(p[k], state[k]))) return id;
  }
  return null;
}

/** Start of the period, in ms (null = no bound). */
export function periodBounds(state, now = Date.now()) {
  switch (state.period) {
    case '1h':
      return { since: now - 3600e3, until: null };
    case '24h':
      return { since: now - 86400e3, until: null };
    case '7d':
      return { since: now - 7 * 86400e3, until: null };
    case 'custom':
      return { since: state.since ? Date.parse(state.since) : null, until: state.until ? Date.parse(state.until) : null };
    default:
      return { since: null, until: null };
  }
}

/** Filters -> the journal:query object (main/ipc/journal.js). */
export function toQuery(state, now = Date.now()) {
  const { since, until } = periodBounds(state, now);
  const q = { boot: state.boot, priority: state.priority };
  if (state.scope === 'kernel') q.kernel = true;
  if (state.scope === 'user') q.user = true;
  if (state.source?.kind === 'unit') q.unit = state.source.value;
  if (state.source?.kind === 'ident') q.identifier = state.source.value;
  if (since != null) q.since = new Date(since).toISOString();
  if (until != null) q.until = new Date(until).toISOString();
  const s = (state.search || '').trim();
  if (s) q.grep = s;
  return q;
}

/** Live view possible: the filters include the boot that is running and no end date. */
export function canFollow(state, currentBootId) {
  if (!(state.boot === 'current' || state.boot === 'all' || (currentBootId && state.boot === currentBootId))) return false;
  const { until } = periodBounds(state);
  return until == null || until > Date.now();
}

/** A source typed by hand: a unit when it ends like one, else a program name. */
export function guessSource(text, known = { units: [], identifiers: [] }) {
  const v = String(text || '').trim();
  if (!v) return null;
  if (known.units?.includes(v)) return { kind: 'unit', value: v };
  if (known.identifiers?.includes(v)) return { kind: 'ident', value: v };
  if (/\.(service|socket|mount|timer|scope|slice|target|path|device|swap|automount)$/.test(v) && validUnit(v)) return { kind: 'unit', value: v };
  return validIdent(v) ? { kind: 'ident', value: v } : null;
}

const pad2 = (n) => String(n).padStart(2, '0');
/** Local time with its offset: 2026-10-14T09:17:17.123+02:00 (as in the text export). */
export function isoLocal(ms) {
  const d = new Date(ms);
  const off = -d.getTimezoneOffset();
  const a = Math.abs(off);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}${off >= 0 ? '+' : '-'}${pad2(Math.floor(a / 60))}:${pad2(a % 60)}`;
}

/** An entry as one text line, the same layout as the text export (copy / paste into a forum or a bug report). */
export function entryLine(e) {
  const level = e.prio == null ? '-' : LEVEL_KEYS[e.prio];
  const head = `${isoLocal(e.ts)} ${level.padEnd(7)} ${e.source || '?'}${e.pid ? `[${e.pid}]` : ''}: `;
  const indent = ' '.repeat(Math.min(head.length, 60));
  return head + String(e.msg || '').split('\n').map((l, i) => (i ? indent + l : l)).join('\n') + (e.truncated ? ' […]' : '');
}

/** First line of a message (the list shows only that). */
export function firstLine(msg) {
  const s = String(msg || '');
  const i = s.indexOf('\n');
  return i < 0 ? s : s.slice(0, i);
}
