'use strict';
// « Journaux système » backend (renderer/apps/logs): reads the systemd journal with journalctl, as the person
// (no root). journalctl always runs with an argument vector built by buildArgs() from a query that went
// through validateQuery(); every value is passed as --option=value, so no value can be read as an option.
//
// Query q (validateQuery; unknown keys ignored):
//   boot        'current' (default) | 'previous' | 'all' | a boot id (32 hex)            -> --boot=0 / -1 / <id>
//   priority    0..7: that level and the more serious ones (-p); 7 (default) = no filter, entries without
//               PRIORITY included
//   unit        unit name (-u, or --user-unit with `user`): [A-Za-z0-9:_.@\\*?-], ≤ 256, not starting with '-'
//   identifier  syslog identifier (-t): printable, ≤ 128, not starting with '-'
//   kernel      true: kernel messages only (the match _TRANSPORT=kernel: -k would also force the current boot)
//   user        true: the person's own journal (--user)
//   since, until  ISO 8601 dates or epoch ms (--since=@s / --until=@s, then refined here to the millisecond; with
//               a cursor journalctl refuses --since, so the bound is only checked here)
//   grep        text (≤ 200 chars) looked for in MESSAGE, literally and ignoring case (--grep with the text
//               escaped and lower-cased: journalctl's smart case). journalctl built without PCRE2: filtered
//               here instead (grepFallback: true)
//   limit       entries per request, 1..5000 (default 500)
//   before      cursor: entries older than it (the next page, newest first: --reverse --after-cursor)
//   after       cursor: entries newer than it (--after-cursor)
//   tag         optional string: a newer query with the same tag from the same window cancels this one
//
// Channels:
//   journal:boots () -> { boots: [{ index, id, first, last }] newest first (first / last in ms), limited, mock }
//   journal:query (q) -> { entries: [Entry] newest first, more, limited, grepFallback, mock }
//        more: there are older entries (newer ones with `after`) past this page
//   journal:entry (cursor) -> { entry: Entry, fields: [{ name, value, binary, truncated, size, missing }] }
//   journal:context (cursor, { before = 25, after = 25 }) -> { entries newest first, anchor, limited }
//        the entries written just before and after that one whatever their source (no filter; ≤ 200 each side)
//   journal:sources ({ user }) -> { units: [string], identifiers: [string] }   (journalctl -F, suggestions)
//   journal:follow (q) -> { id }   new entries matching q, streamed to the asking window only:
//        (+journal:entries) { id, entries: [Entry] oldest first }   (+journal:followEnd) { id, error? }
//        q.after (a cursor): starts right after that entry, else at the end of the journal (-f -n 0). The boot
//        must be 'current', 'all' or the current boot id (EINVAL otherwise); q.until is ignored.
//        Ends with journal:unfollow, or when that window's renderer goes away or reloads. ≤ 8 at a time.
//   journal:unfollow (id) -> { ok }
//   journal:export (q, { path, format: 'text' | 'json' }) -> { path, count, bytes, capped }
//        the newest ≤ 20 000 entries matching q (its limit and cursors are ignored), written oldest first to
//        path (absolute; its folder must exist; written to a temporary file, then renamed). text: one line per
//        entry « 2026-10-14T09:17:17.123+02:00 err     bluetoothd[811]: message » (local time, syslog level
//        names, continuation lines indented, « -- Boot <id> -- » between boots); json: an array of objects with
//        every field, values decoded to text (≤ 64 KiB each; a repeated field is an array).
//   journal:follows () -> number of follows running (tests)
//
// Entry: { cursor, ts (ms), us (µs, string), prio (0..7 | null), source, pid, unit, transport, boot, host,
//          uid, comm, msg, truncated, size, binary, missing, multi }
//   msg is MESSAGE as text: byte arrays (journalctl's form for non-UTF-8 or control characters) decoded as
//   UTF-8 with U+FFFD for bad bytes (binary: true), a repeated field's values joined with new lines (multi: n),
//   colour / escape sequences removed, other control characters replaced by U+FFFD; cut at 4 KiB in lists and
//   64 KiB in journal:entry (truncated: true, size: the full length in bytes). missing: journalctl left the
//   value out (null). source: SYSLOG_IDENTIFIER, else _COMM, else the program name.
// limited: journalctl said this account only sees its own entries (it is not in adm / systemd-journal / wheel).
// Errors: EINVAL (bad argument), ENOENT (journalctl missing, cursor not found), ENOBOOT (no such boot, e.g. no
// previous boot in a volatile journal), ETIMEDOUT (20 s), ECANCELED (replaced by a query with the same tag),
// ECMD (journalctl failed: its message).
//
// Dev / tests (api.DEV unless AURORA_REAL_BACKENDS=1): a fixture directory instead of journalctl:
// AURORA_JOURNAL_FIXTURE=<dir> (default test/fixtures/logs/default; layout in test/fixtures/logs/fixture-lib.mjs):
// boots.json, system/<boot>.jsonl, user/<boot>.jsonl (journalctl JSON lines), meta.json { limited, pcre2, missing }.
// The same parsing and filtering code runs on it. Without `user` it shows system + user entries (like journalctl),
// only the user ones when meta.limited. The fake follow tails the current boot's files (AURORA_JOURNAL_POLL_MS,
// default 150 ms), so a test appends a line and sees it arrive.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');
const { which } = require('../lib/exec');

const LIMIT_MAX = 5000;
const LIMIT_DEFAULT = 500;
const LIST_MSG_MAX = 4096;
const DETAIL_MAX = 65536;
const EXPORT_MAX = 20000;
const SCAN_MAX = 200000; // entries read when searching without PCRE2
const QUERY_TIMEOUT = 20000;
const LINE_MAX = 8 * 1024 * 1024; // a JSON line longer than this is skipped
const FOLLOW_MAX = 8;
const FIXTURE_DEFAULT = path.join(__dirname, '..', '..', 'test', 'fixtures', 'logs', 'default');

const BOOT_RE = /^[0-9a-f]{32}$/;
const CURSOR_RE = /^[a-z]=[0-9a-f]{1,64}(?:;[a-z]=[0-9a-f]{1,64}){0,11}$/;
const UNIT_RE = /^(?!-)[A-Za-z0-9:_.@\\*?-]{1,256}$/;
const IDENT_RE = /^(?!-)[^\x00-\x1f\x7f]{1,128}$/;
const LEVELS = ['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug'];

const err = (message, code) => Object.assign(new Error(message), { code, quiet: true });

// ---------------------------------------------------------------- validation
function parseDate(v, name) {
  if (v == null || v === '') return null;
  let ms = NaN;
  if (typeof v === 'number') ms = v;
  else if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}([T ][0-9:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(v.trim())) ms = Date.parse(v.trim());
  if (!Number.isFinite(ms) || ms < Date.UTC(1990, 0, 1) || ms > Date.UTC(2200, 0, 1)) throw err(`Invalid ${name} date`, 'EINVAL');
  return Math.floor(ms);
}

function validCursor(c) {
  return typeof c === 'string' && c.length <= 600 && CURSOR_RE.test(c);
}

/** Normalized query or EINVAL. */
function validateQuery(q = {}) {
  if (q == null || typeof q !== 'object' || Array.isArray(q)) throw err('Invalid query', 'EINVAL');
  const v = { boot: 'current', priority: 7, unit: null, identifier: null, kernel: false, user: false, since: null, until: null, grep: '', limit: LIMIT_DEFAULT, before: null, after: null, tag: null };
  if (q.boot != null) {
    const b = String(q.boot);
    if (!['current', 'previous', 'all'].includes(b) && !BOOT_RE.test(b)) throw err('Invalid boot', 'EINVAL');
    v.boot = b;
  }
  if (q.priority != null) {
    if (!Number.isInteger(q.priority) || q.priority < 0 || q.priority > 7) throw err('Invalid priority', 'EINVAL');
    v.priority = q.priority;
  }
  if (q.unit != null && q.unit !== '') {
    if (typeof q.unit !== 'string' || !UNIT_RE.test(q.unit)) throw err('Invalid unit name', 'EINVAL');
    v.unit = q.unit;
  }
  if (q.identifier != null && q.identifier !== '') {
    if (typeof q.identifier !== 'string' || !IDENT_RE.test(q.identifier) || q.identifier.trim() !== q.identifier) throw err('Invalid identifier', 'EINVAL');
    v.identifier = q.identifier;
  }
  v.kernel = q.kernel === true;
  v.user = q.user === true;
  v.since = parseDate(q.since, 'since');
  v.until = parseDate(q.until, 'until');
  if (v.since != null && v.until != null && v.since > v.until) throw err('The start date is after the end date', 'EINVAL');
  if (q.grep != null && q.grep !== '') {
    if (typeof q.grep !== 'string' || q.grep.length > 200 || /[\x00-\x08\x0a-\x1f\x7f]/.test(q.grep)) throw err('Invalid search text', 'EINVAL');
    v.grep = q.grep.trim();
  }
  if (q.limit != null) {
    const n = Number(q.limit);
    if (!Number.isFinite(n) || n < 1) throw err('Invalid limit', 'EINVAL');
    v.limit = Math.min(LIMIT_MAX, Math.floor(n));
  }
  for (const k of ['before', 'after']) {
    if (q[k] == null || q[k] === '') continue;
    if (!validCursor(q[k])) throw err(`Invalid ${k} cursor`, 'EINVAL');
    v[k] = q[k];
  }
  if (v.before && v.after) throw err('Use before or after, not both', 'EINVAL');
  if (q.tag != null) {
    if (typeof q.tag !== 'string' || q.tag.length > 64) throw err('Invalid tag', 'EINVAL');
    v.tag = q.tag;
  }
  return v;
}

/** PCRE2 pattern matching the text literally. */
function escapePcre(s) {
  return String(s).replace(/[\\^$.|?*+()[\]{}\/#-]/g, '\\$&');
}

/**
 * journalctl arguments for a validated query.
 *   mode 'page'   newest first (--reverse), older than v.before; or with v.after, newer than it (oldest first)
 *   mode 'follow' --follow (after v.after, else --lines=0)
 * opts: { lines, grep: false (filter in JS instead) }
 */
function buildArgs(v, mode = 'page', opts = {}) {
  const a = ['--output=json', '--all', '--no-pager'];
  if (v.user) a.push('--user');
  if (v.boot === 'current') a.push('--boot=0');
  else if (v.boot === 'previous') a.push('--boot=-1');
  else if (BOOT_RE.test(v.boot)) a.push(`--boot=${v.boot}`);
  if (v.priority < 7) a.push(`--priority=${v.priority}`);
  if (v.unit) a.push(v.user ? `--user-unit=${v.unit}` : `--unit=${v.unit}`);
  if (v.identifier) a.push(`--identifier=${v.identifier}`);
  // journalctl takes only one of --since, --cursor and --after-cursor: with a cursor, the start date is checked here.
  if (v.since != null && !v.before && !v.after) a.push(`--since=@${Math.floor(v.since / 1000)}`);
  if (v.until != null && mode !== 'follow') a.push(`--until=@${Math.ceil(v.until / 1000)}`);
  if (v.grep && opts.grep !== false) a.push(`--grep=${escapePcre(v.grep.toLowerCase())}`);
  if (mode === 'follow') {
    a.push('--follow');
    if (v.after) a.push(`--after-cursor=${v.after}`);
    else a.push('--lines=0');
  } else if (v.after) {
    a.push(`--after-cursor=${v.after}`);
    if (opts.lines) a.push(`--lines=${opts.lines}`);
  } else {
    a.push('--reverse');
    if (v.before) a.push(`--after-cursor=${v.before}`);
    if (opts.lines) a.push(`--lines=${opts.lines}`);
  }
  if (v.kernel) a.push('_TRANSPORT=kernel'); // a match, after the options
  return a;
}

// ---------------------------------------------------------------- parsing
const UTF8 = new TextDecoder('utf-8', { fatal: false });

function bytesToText(arr, max) {
  const n = Math.min(arr.length, max == null ? arr.length : max * 4);
  const u8 = new Uint8Array(n);
  for (let i = 0; i < n; i++) u8[i] = arr[i] & 255;
  return UTF8.decode(u8);
}

/** A journal field value (string, byte array, array of values, null) -> { text, binary, multi, missing }. */
function decodeValue(v, max) {
  if (v == null) return { text: '', missing: true };
  if (typeof v === 'string') return { text: v };
  if (typeof v === 'number' || typeof v === 'boolean') return { text: String(v) };
  if (Array.isArray(v)) {
    if (!v.length) return { text: '' };
    if (v.every((x) => typeof x === 'number')) return { text: bytesToText(v, max), binary: true };
    const parts = v.map((x) => decodeValue(x, max));
    return { text: parts.map((p) => p.text).join('\n'), binary: parts.some((p) => p.binary), multi: parts.length, missing: parts.every((p) => p.missing), parts };
  }
  try {
    return { text: JSON.stringify(v) };
  } catch {
    return { text: '' };
  }
}

/** Colour and other escape sequences removed, CR LF and lone CR -> new line, other control characters (but tab) -> U+FFFD. */
function cleanText(s) {
  return String(s)
    .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '')
    .replace(/\x1b[@-Z\\-_]?/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '�');
}

function cut(text, max) {
  if (text.length <= max) return { text, truncated: false };
  // Do not cut a surrogate pair in half.
  let end = max;
  const c = text.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end--;
  return { text: text.slice(0, end), truncated: true };
}

const fieldText = (raw, k) => {
  const v = raw[k];
  if (v == null) return '';
  if (typeof v === 'string') return v;
  return cleanText(decodeValue(v, 512).text).split('\n')[0];
};

/** One journalctl JSON object -> { entry, full } (full: the whole cleaned message, for searching here). */
function parseRaw(raw, max = LIST_MSG_MAX) {
  const m = decodeValue(raw.MESSAGE);
  const full = cleanText(m.text);
  const c = cut(full, max);
  const us = typeof raw.__REALTIME_TIMESTAMP === 'string' && /^\d{1,20}$/.test(raw.__REALTIME_TIMESTAMP) ? raw.__REALTIME_TIMESTAMP : '0';
  const p = Number(fieldText(raw, 'PRIORITY'));
  const exe = fieldText(raw, '_EXE');
  const transport = fieldText(raw, '_TRANSPORT');
  const source = fieldText(raw, 'SYSLOG_IDENTIFIER') || fieldText(raw, '_COMM') || (exe ? exe.split('/').pop() : '') || (transport === 'kernel' ? 'kernel' : '');
  const entry = {
    cursor: typeof raw.__CURSOR === 'string' ? raw.__CURSOR : '',
    ts: Number(BigInt(us) / 1000n),
    us,
    prio: fieldText(raw, 'PRIORITY') !== '' && Number.isInteger(p) && p >= 0 && p <= 7 ? p : null,
    source,
    pid: fieldText(raw, 'SYSLOG_PID') || fieldText(raw, '_PID'),
    unit: fieldText(raw, '_SYSTEMD_USER_UNIT') || fieldText(raw, '_SYSTEMD_UNIT') || fieldText(raw, 'UNIT') || fieldText(raw, 'USER_UNIT'),
    transport,
    boot: fieldText(raw, '_BOOT_ID'),
    host: fieldText(raw, '_HOSTNAME'),
    uid: fieldText(raw, '_UID'),
    comm: fieldText(raw, '_COMM'),
    msg: c.text,
    truncated: c.truncated,
    size: c.truncated ? Buffer.byteLength(full) : undefined,
    binary: !!m.binary,
    missing: !!m.missing,
    multi: m.multi || undefined,
  };
  // A unit like user@1000.service is not the source of a user-unit message: prefer the user unit (done above).
  return { entry, full };
}

const FIELD_ORDER = (n) => (n.startsWith('__') ? 2 : n.startsWith('_') ? 1 : 0);
/** Every field of an entry for the details pane, values cleaned and cut at max. */
function entryFields(raw, max = DETAIL_MAX) {
  const out = [];
  for (const name of Object.keys(raw).sort((a, b) => FIELD_ORDER(a) - FIELD_ORDER(b) || a.localeCompare(b))) {
    if (!/^[A-Z0-9_]{1,64}$/.test(name)) continue;
    const d = decodeValue(raw[name]);
    const values = d.parts ? d.parts : [d];
    for (const p of values) {
      const clean = cleanText(p.text);
      const c = cut(clean, max);
      out.push({ name, value: c.text, binary: !!p.binary || undefined, truncated: c.truncated || undefined, size: c.truncated ? Buffer.byteLength(clean) : undefined, missing: !!p.missing || undefined });
    }
  }
  return out;
}

/** `journalctl --list-boots --output=json` -> [{ index, id, first, last }] newest first. */
function parseBootsJson(text) {
  let arr;
  try {
    arr = JSON.parse(String(text || '').trim() || '[]');
  } catch {
    return null;
  }
  if (!Array.isArray(arr)) return null;
  const out = [];
  for (const b of arr) {
    const id = String(b?.boot_id || '').replace(/-/g, '').toLowerCase();
    if (!BOOT_RE.test(id)) continue;
    out.push({ index: Number(b.index) || 0, id, first: Math.floor(Number(b.first_entry) / 1000) || null, last: Math.floor(Number(b.last_entry) / 1000) || null });
  }
  return out.sort((a, b) => b.index - a.index);
}

/** Text form (older journalctl, run with TZ=UTC): " -1 b7e4… Mon 2026-10-13 16:10:07 UTC—Mon 2026-10-13 20:47:31 UTC". */
function parseBootsText(text) {
  const out = [];
  const re = /^\s*(-?\d+)\s+([0-9a-f]{32})\s+\S+\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) UTC[\s—–-]+(?:\S+\s+)?(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) UTC/;
  for (const line of String(text || '').split('\n')) {
    const m = re.exec(line);
    if (!m) continue;
    out.push({ index: Number(m[1]), id: m[2], first: Date.parse(`${m[3].replace(' ', 'T')}Z`), last: Date.parse(`${m[4].replace(' ', 'T')}Z`) });
  }
  return out.sort((a, b) => b.index - a.index);
}

/** What journalctl's messages on stderr mean. */
function stderrFlags(text) {
  const s = String(text || '');
  return {
    limited: /not seeing messages from (other users and )?the system|not seeing messages from other users|insufficient permissions/i.test(s),
    noFiles: /No journal files were opened due to insufficient permissions/i.test(s),
    noPcre: /PCRE2|pattern matching support|Compiled without pattern/i.test(s),
    noBoot: /No journal boot entry found|No such boot ID|specified boot .* (is not available|not found)|Failed to (look up|find) boot|Data from the specified boot/i.test(s),
  };
}

// ---------------------------------------------------------------- text export format
const pad2 = (n) => String(n).padStart(2, '0');
/** Local time with its offset: 2026-10-14T09:17:17.123+02:00. */
function isoLocal(ms) {
  const d = new Date(ms);
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}${sign}${pad2(Math.floor(a / 60))}:${pad2(a % 60)}`;
}

/** One entry as a text line (continuation lines indented under the message). */
function entryLine(e) {
  const level = e.prio == null ? '-' : LEVELS[e.prio];
  const head = `${isoLocal(e.ts)} ${level.padEnd(7)} ${e.source || '?'}${e.pid ? `[${e.pid}]` : ''}: `;
  const lines = String(e.msg || '').split('\n');
  const indent = ' '.repeat(Math.min(head.length, 60));
  return head + lines.map((l, i) => (i ? indent + l : l)).join('\n') + (e.truncated ? ` […]` : '');
}

// ---------------------------------------------------------------- matching (fixture mode, JS search fallback)
function globRe(g) {
  return new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
}
const SYS_UNIT_FIELDS = ['_SYSTEMD_UNIT', 'UNIT', 'COREDUMP_UNIT', 'OBJECT_SYSTEMD_UNIT'];
const USER_UNIT_FIELDS = ['_SYSTEMD_USER_UNIT', 'USER_UNIT', 'UNIT', 'COREDUMP_USER_UNIT', 'OBJECT_SYSTEMD_USER_UNIT'];

/** fn(raw, parsed) -> boolean. `filters: false` checks only the search text and the dates (real mode). */
function makeMatcher(v, { filters = true } = {}) {
  const needle = v.grep ? v.grep.toLowerCase() : '';
  const unitRe = v.unit ? globRe(v.unit) : null;
  return (raw, p) => {
    if (v.since != null && p.entry.ts < v.since) return false;
    if (v.until != null && p.entry.ts > v.until) return false;
    if (filters) {
      if (v.priority < 7 && (p.entry.prio == null || p.entry.prio > v.priority)) return false;
      if (v.kernel && raw._TRANSPORT !== 'kernel') return false;
      if (v.identifier && fieldText(raw, 'SYSLOG_IDENTIFIER') !== v.identifier) return false;
      if (unitRe && !(v.user ? USER_UNIT_FIELDS : SYS_UNIT_FIELDS).some((f) => unitRe.test(fieldText(raw, f)))) return false;
    }
    if (needle && !p.full.toLowerCase().includes(needle)) return false;
    return true;
  };
}

/** Position of a cursor (realtime then sequence number), to page through fixture data. */
function cursorKey(c) {
  const t = /(?:^|;)t=([0-9a-f]+)/.exec(c || '');
  const i = /(?:^|;)i=([0-9a-f]+)/.exec(c || '');
  return { t: t ? parseInt(t[1], 16) : 0, i: i ? parseInt(i[1], 16) : 0 };
}
const cmpKey = (a, b) => a.t - b.t || a.i - b.i;

// ---------------------------------------------------------------- fixture source
class Fixture {
  constructor(dir) {
    this.dir = dir;
    this.cache = new Map();
  }
  meta() {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, 'meta.json'), 'utf8')) || {};
    } catch {
      return {};
    }
  }
  check() {
    if (this.meta().missing) throw err('journalctl: command not found', 'ENOENT');
  }
  boots() {
    const list = parseBootsJson(fs.readFileSync(path.join(this.dir, 'boots.json'), 'utf8')) || [];
    return list;
  }
  currentBoot() {
    return this.boots().find((b) => b.index === 0)?.id || null;
  }
  bootIds(boot) {
    const boots = this.boots();
    if (boot === 'all') return boots.map((b) => b.id);
    const want = boot === 'current' ? boots.find((b) => b.index === 0) : boot === 'previous' ? boots.find((b) => b.index === -1) : boots.find((b) => b.id === boot);
    if (!want) throw err('No journal boot entry found for the specified boot', 'ENOBOOT');
    return [want.id];
  }
  namespaces(user) {
    if (user) return ['user'];
    return this.meta().limited ? ['user'] : ['system', 'user'];
  }
  load(file) {
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      return [];
    }
    const hit = this.cache.get(file);
    if (hit && hit.size === st.size && hit.mtime === st.mtimeMs) return hit.list;
    const list = [];
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let raw;
      try {
        raw = JSON.parse(line);
      } catch {
        continue;
      }
      if (!raw || typeof raw !== 'object') continue;
      const p = parseRaw(raw);
      p.raw = raw;
      p.key = cursorKey(p.entry.cursor);
      list.push(p);
    }
    this.cache.set(file, { size: st.size, mtime: st.mtimeMs, list });
    return list;
  }
  /** Every entry of these boots / namespaces, oldest first. */
  entries(boot, user) {
    const out = [];
    for (const id of this.bootIds(boot)) for (const ns of this.namespaces(user)) out.push(...this.load(path.join(this.dir, ns, `${id}.jsonl`)));
    return out.sort((a, b) => cmpKey(a.key, b.key));
  }
}

// ---------------------------------------------------------------- journalctl runner
const JENV = () => ({ ...process.env, LC_ALL: 'C', TZ: 'UTC', SYSTEMD_PAGER: '', PAGER: 'cat', SYSTEMD_COLORS: '0', SYSTEMD_LESS: '' });

/**
 * Runs journalctl, calling onRaw(obj) for every JSON line; onRaw returning false stops it.
 * -> { code, stderr, stopped, timedOut, cancelled }
 */
function streamJournal(args, { onRaw, onText, timeout = QUERY_TIMEOUT, registerKill } = {}) {
  return new Promise((resolve, reject) => {
    if (!which('journalctl')) return reject(err('journalctl: command not found', 'ENOENT'));
    let child;
    try {
      child = spawn(which('journalctl'), args, { env: JENV(), stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return reject(err(`journalctl: ${e.message}`, 'ENOENT'));
    }
    const dec = new StringDecoder('utf8');
    let buf = '';
    let skipping = false;
    let stderr = '';
    let stopped = false;
    let timedOut = false;
    let cancelled = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      try {
        child.kill('SIGTERM');
      } catch {}
    };
    registerKill?.(() => {
      cancelled = true;
      stop();
    });
    const timer = timeout ? setTimeout(() => ((timedOut = true), stop()), timeout) : null;
    const line = (l) => {
      if (stopped || !l) return;
      if (onText) {
        if (onText(l) === false) stop();
        return;
      }
      let obj;
      try {
        obj = JSON.parse(l);
      } catch {
        return;
      }
      if (obj && typeof obj === 'object' && onRaw(obj) === false) stop();
    };
    child.stdout.on('data', (chunk) => {
      if (stopped) return;
      buf += dec.write(chunk);
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (skipping) skipping = false;
        else line(l);
        if (stopped) return;
      }
      if (buf.length > LINE_MAX) {
        buf = '';
        skipping = true;
      }
    });
    child.stderr.on('data', (d) => {
      if (stderr.length < 16384) stderr += d;
    });
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(err(`journalctl: ${e.message}`, e.code === 'ENOENT' ? 'ENOENT' : 'ECMD'));
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (!stopped && !skipping && buf) line(buf + dec.end());
      resolve({ code, stderr, stopped, timedOut, cancelled });
    });
  });
}

/** The first line of journalctl's stderr that is an error (not the permission hint or a notice). */
function errorLine(stderr) {
  return (
    String(stderr || '')
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !/^Hint:|^Users in groups|^Pass -q|^No journal files were found|^-- No entries --/.test(l)) || ''
  );
}

function failFrom(r, flags) {
  if (r.cancelled) return err('Replaced by a newer search', 'ECANCELED');
  if (r.timedOut) return err('The journal took too long to answer', 'ETIMEDOUT');
  if (flags.noBoot) return err('No journal boot entry found for the specified boot', 'ENOBOOT');
  return err(errorLine(r.stderr) || `journalctl failed (exit status ${r.code})`, 'ECMD');
}

// ---------------------------------------------------------------- the module
function register(api) {
  const useFixture = !!api.DEV && process.env.AURORA_REAL_BACKENDS !== '1';
  const fixture = useFixture ? new Fixture(process.env.AURORA_JOURNAL_FIXTURE && path.isAbsolute(process.env.AURORA_JOURNAL_FIXTURE) ? process.env.AURORA_JOURNAL_FIXTURE : FIXTURE_DEFAULT) : null;
  let pcre2 = true; // set to false the first time journalctl says it has no pattern matching
  const running = new Map(); // `${senderId}:${tag}` -> kill()
  let bootsCache = null; // { at, value }

  const senderKey = (event) => event?.sender?.id ?? 0;

  // A query with a tag cancels the previous one with the same tag from the same window (typing in the search box).
  function tagKill(event, v) {
    if (!v.tag) return {};
    const key = `${senderKey(event)}:${v.tag}`;
    running.get(key)?.();
    let kill = null;
    const token = {};
    const cancel = () => {
      token.cancelled = true;
      kill?.();
    };
    running.set(key, cancel);
    return {
      token,
      registerKill: (fn) => {
        kill = fn;
        if (token.cancelled) fn();
      },
      done: () => {
        if (running.get(key) === cancel) running.delete(key);
      },
    };
  }

  // ------------------------------------------------ boots
  async function boots() {
    if (fixture) {
      fixture.check();
      return { boots: fixture.boots(), limited: !!fixture.meta().limited, mock: true };
    }
    if (bootsCache && Date.now() - bootsCache.at < 30000) return bootsCache.value;
    let out = '';
    const r = await streamJournal(['--list-boots', '--output=json', '--no-pager'], { onText: (l) => void (out += `${l}\n`) });
    let list = parseBootsJson(out);
    let stderr = r.stderr;
    if (list == null || (!list.length && r.code !== 0)) {
      // An older journalctl without JSON for --list-boots: its text form (TZ=UTC).
      out = '';
      const t = await streamJournal(['--list-boots', '--no-pager'], { onText: (l) => void (out += `${l}\n`) });
      list = parseBootsText(out);
      stderr += t.stderr;
    }
    const value = { boots: list.slice(0, 200), limited: stderrFlags(stderr).limited, mock: false };
    bootsCache = { at: Date.now(), value };
    return value;
  }

  // ------------------------------------------------ query
  function pageFixture(v, list, match) {
    const want = v.limit + 1;
    const res = [];
    if (v.after) {
      const k = cursorKey(v.after);
      for (const p of list) {
        if (cmpKey(p.key, k) <= 0 || !match(p.raw, p)) continue;
        res.push(p);
        if (res.length >= want) break;
      }
      const more = res.length > v.limit;
      return { picked: res.slice(0, v.limit).reverse(), more };
    }
    const k = v.before ? cursorKey(v.before) : null;
    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i];
      if (k && cmpKey(p.key, k) >= 0) continue;
      if (!match(p.raw, p)) continue;
      res.push(p);
      if (res.length >= want) break;
    }
    return { picked: res.slice(0, v.limit), more: res.length > v.limit };
  }

  async function queryReal(v, ctl, keepRaw = false, max = LIST_MSG_MAX) {
    const useGrep = !!v.grep && pcre2;
    const want = v.limit + 1;
    const run = async (grep) => {
      const picked = [];
      let scanned = 0;
      // journalctl filters; here only the exact date bounds, and the search text when journalctl cannot.
      const js = makeMatcher({ ...v, grep: grep ? '' : v.grep }, { filters: false });
      // --lines when journalctl's answer is the page; when this side may still drop entries (exact date bounds,
      // search without PCRE2), the stream is stopped here once the page is full (at most SCAN_MAX entries read).
      const exact = (v.grep && !grep) || v.since != null || v.until != null;
      const args = buildArgs(v, 'page', { lines: exact ? SCAN_MAX : want, grep });
      const r = await streamJournal(args, {
        registerKill: ctl.registerKill,
        onRaw: (raw) => {
          scanned++;
          const p = parseRaw(raw, max);
          // Past the date bound in the reading direction: nothing further can match.
          if (!v.after && v.since != null && p.entry.ts < v.since) return false;
          if (v.after && v.until != null && p.entry.ts > v.until) return false;
          if (!js(raw, p)) return scanned < SCAN_MAX;
          if (keepRaw) p.raw = raw;
          picked.push(p);
          return picked.length < want && scanned < SCAN_MAX;
        },
      });
      return { r, picked, scanned };
    };
    let res = await run(useGrep);
    let flags = stderrFlags(res.r.stderr);
    let grepFallback = !!v.grep && !useGrep;
    if (useGrep && flags.noPcre) {
      pcre2 = false;
      grepFallback = true;
      res = await run(false);
      flags = stderrFlags(res.r.stderr);
    }
    const { r, picked } = res;
    // --grep with no match exits with 1 and says nothing: an empty result, not an error.
    if (r.cancelled || r.timedOut || flags.noBoot || (!r.stopped && r.code !== 0 && !picked.length && !flags.noFiles && errorLine(r.stderr))) throw failFrom(r, flags);
    const more = picked.length > v.limit;
    let list = picked.slice(0, v.limit);
    if (v.after) list = list.reverse();
    return { picked: list, more, limited: flags.limited, grepFallback };
  }

  async function query(v, event, opts = {}) {
    const ctl = tagKill(event, v);
    try {
      if (fixture) {
        fixture.check();
        const meta = fixture.meta();
        const list = fixture.entries(v.boot, v.user);
        const { picked, more } = pageFixture(v, list, makeMatcher(v));
        if (ctl.token?.cancelled) throw err('Replaced by a newer search', 'ECANCELED');
        return { picked, more, limited: !!meta.limited && !v.user, grepFallback: !!v.grep && meta.pcre2 === false };
      }
      return await queryReal(v, ctl, opts.keepRaw, opts.max);
    } finally {
      ctl.done?.();
    }
  }

  api.handle('journal:boots', () => boots());

  api.handle('journal:query', async (q, event) => {
    const v = validateQuery(q);
    const r = await query(v, event);
    return { entries: r.picked.map((p) => p.entry), more: r.more, limited: r.limited, grepFallback: r.grepFallback, mock: !!fixture };
  });

  // ------------------------------------------------ one entry, context
  async function findRaw(cursor) {
    if (!validCursor(cursor)) throw err('Invalid cursor', 'EINVAL');
    if (fixture) {
      fixture.check();
      const p = fixture.entries('all', false).find((x) => x.entry.cursor === cursor) || fixture.entries('all', true).find((x) => x.entry.cursor === cursor);
      if (!p) throw err('This entry is no longer in the journal', 'ENOENT');
      return p.raw;
    }
    let found = null;
    const r = await streamJournal(['--output=json', '--all', '--no-pager', `--cursor=${cursor}`, '--lines=1'], {
      onRaw: (raw) => {
        found = raw;
        return false;
      },
    });
    if (!found || found.__CURSOR !== cursor) {
      if (r.timedOut) throw failFrom(r, {});
      throw err('This entry is no longer in the journal', 'ENOENT');
    }
    return found;
  }

  api.handle('journal:entry', async (cursor) => {
    const raw = await findRaw(cursor);
    return { entry: parseRaw(raw, DETAIL_MAX).entry, fields: entryFields(raw) };
  });

  api.handle('journal:context', async (cursor, opts = {}) => {
    if (!validCursor(cursor)) throw err('Invalid cursor', 'EINVAL');
    const n = (x, d) => (Number.isInteger(x) && x >= 0 ? Math.min(200, x) : d);
    const before = n(opts?.before, 25);
    const after = n(opts?.after, 25);
    if (fixture) {
      fixture.check();
      const list = fixture.entries('all', false);
      const i = list.findIndex((p) => p.entry.cursor === cursor);
      if (i < 0) throw err('This entry is no longer in the journal', 'ENOENT');
      const slice = list.slice(Math.max(0, i - before), i + after + 1).reverse();
      return { entries: slice.map((p) => p.entry), anchor: cursor, limited: !!fixture.meta().limited };
    }
    const newer = [];
    const older = [];
    const base = ['--output=json', '--all', '--no-pager'];
    const a = await streamJournal([...base, `--cursor=${cursor}`, `--lines=${after + 1}`], { onRaw: (raw) => void newer.push(parseRaw(raw).entry) });
    if (!newer.length || newer[0].cursor !== cursor) throw err('This entry is no longer in the journal', 'ENOENT');
    let b = { stderr: '' };
    if (before) b = await streamJournal([...base, '--reverse', `--after-cursor=${cursor}`, `--lines=${before}`], { onRaw: (raw) => void older.push(parseRaw(raw).entry) });
    return { entries: [...newer.reverse(), ...older], anchor: cursor, limited: stderrFlags(a.stderr + b.stderr).limited };
  });

  // ------------------------------------------------ sources (suggestions)
  const sourcesCache = new Map();
  api.handle('journal:sources', async (opts = {}) => {
    const user = opts?.user === true;
    const unitField = user ? '_SYSTEMD_USER_UNIT' : '_SYSTEMD_UNIT';
    const sort = (set) => [...set].filter((x) => x && x.length <= 256).sort((a, b) => a.localeCompare(b)).slice(0, 3000);
    if (fixture) {
      fixture.check();
      const units = new Set();
      const ids = new Set();
      for (const p of fixture.entries('all', user)) {
        const u = fieldText(p.raw, unitField);
        if (u && (user || p.raw._RUNTIME_SCOPE !== 'user')) units.add(u);
        const id = fieldText(p.raw, 'SYSLOG_IDENTIFIER');
        if (id) ids.add(id);
      }
      return { units: sort(units), identifiers: sort(ids) };
    }
    const hit = sourcesCache.get(user);
    if (hit && Date.now() - hit.at < 60000) return hit.value;
    const field = async (name) => {
      const set = new Set();
      await streamJournal([...(user ? ['--user'] : []), `--field=${name}`, '--no-pager'], { timeout: 8000, onText: (l) => void (set.size < 5000 && set.add(l.trim())) }).catch(() => null);
      return set;
    };
    const [units, ids] = await Promise.all([field(unitField), field('SYSLOG_IDENTIFIER')]);
    const value = { units: sort(units), identifiers: sort(ids) };
    sourcesCache.set(user, { at: Date.now(), value });
    return value;
  });

  // ------------------------------------------------ follow
  const follows = new Map(); // id -> { stop(), sender }
  let followSeq = 0;
  const watchedSenders = new WeakSet();
  // No journalctl -f left behind when the shell quits.
  process.once('exit', () => {
    for (const f of follows.values()) f.stop();
  });

  function currentBootReal() {
    try {
      return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim().replace(/-/g, '');
    } catch {
      return null;
    }
  }

  api.handle('journal:follow', async (q, event) => {
    const v = validateQuery(q);
    const sender = event?.sender;
    const cur = fixture ? fixture.currentBoot() : currentBootReal();
    if (!['current', 'all'].includes(v.boot) && v.boot !== cur) throw err('Only the current boot can be followed', 'EINVAL');
    if (follows.size >= FOLLOW_MAX) throw err('Too many live views', 'ELIMIT');
    if (fixture) fixture.check();
    const id = ++followSeq;
    let pending = [];
    let flushTimer = null;
    let ended = false;
    const flush = () => {
      flushTimer = null;
      if (!pending.length || ended) return;
      const batch = pending.splice(0, 1000);
      api.sendTo(sender, 'journal:entries', { id, entries: batch });
      if (pending.length) flushTimer = setTimeout(flush, 50);
    };
    const push = (p) => {
      pending.push(p.entry);
      if (pending.length > 5000) pending = pending.slice(-5000); // a flood: keep the newest
      if (!flushTimer) flushTimer = setTimeout(flush, 120);
    };
    const end = (error) => {
      if (ended) return;
      flush();
      ended = true;
      follows.delete(id);
      clearTimeout(flushTimer);
      api.sendTo(sender, 'journal:followEnd', { id, error: error || null });
    };
    let stop;
    if (fixture) {
      // Tail the current boot's files: new complete lines are entries.
      const files = fixture.namespaces(v.user).map((ns) => path.join(fixture.dir, ns, `${cur}.jsonl`));
      const offsets = new Map();
      for (const f of files) {
        try {
          offsets.set(f, fs.statSync(f).size);
        } catch {
          offsets.set(f, 0);
        }
      }
      const startKey = v.after ? cursorKey(v.after) : null;
      const match = makeMatcher({ ...v, until: null });
      const poll = () => {
        const fresh = [];
        for (const f of files) {
          let size = 0;
          try {
            size = fs.statSync(f).size;
          } catch {
            continue;
          }
          const from = offsets.get(f) || 0;
          if (size <= from) continue;
          const fd = fs.openSync(f, 'r');
          const b = Buffer.alloc(size - from);
          fs.readSync(fd, b, 0, b.length, from);
          fs.closeSync(fd);
          const text = b.toString('utf8');
          const last = text.lastIndexOf('\n');
          if (last < 0) continue;
          offsets.set(f, from + Buffer.byteLength(text.slice(0, last + 1)));
          for (const line of text.slice(0, last).split('\n')) {
            let raw;
            try {
              raw = JSON.parse(line);
            } catch {
              continue;
            }
            const p = parseRaw(raw);
            if (startKey && cmpKey(cursorKey(p.entry.cursor), startKey) <= 0) continue;
            if (match(raw, p)) fresh.push(p);
          }
        }
        fresh.sort((a, b) => cmpKey(cursorKey(a.entry.cursor), cursorKey(b.entry.cursor)));
        for (const p of fresh) push(p);
      };
      const timer = setInterval(poll, Math.max(20, Number(process.env.AURORA_JOURNAL_POLL_MS) || 150));
      stop = () => {
        clearInterval(timer);
        end();
      };
    } else {
      const useGrep = !!v.grep && pcre2;
      const jsMatch = makeMatcher({ ...v, until: null, grep: useGrep ? '' : v.grep }, { filters: false });
      let kill = null;
      streamJournal(buildArgs(v, 'follow', { grep: useGrep }), {
        timeout: 0,
        registerKill: (fn) => (kill = fn),
        onRaw: (raw) => {
          const p = parseRaw(raw);
          if (jsMatch(raw, p)) push(p);
        },
      })
        .then((r) => end(r.stopped || r.code === 0 ? null : failFrom(r, stderrFlags(r.stderr)).message))
        .catch((e) => end(e.message));
      stop = () => {
        kill?.();
        end();
      };
    }
    follows.set(id, { stop, sender });
    if (sender && !watchedSenders.has(sender)) {
      watchedSenders.add(sender);
      const drop = () => {
        for (const [fid, f] of [...follows]) if (f.sender === sender) f.stop();
      };
      sender.once('destroyed', drop);
      sender.on('render-process-gone', drop);
      sender.on('did-finish-load', drop); // a reloaded shell starts over
    }
    return { id };
  });

  api.handle('journal:unfollow', (id) => {
    const f = follows.get(Number(id));
    if (!f) return { ok: false };
    f.stop();
    return { ok: true };
  });

  api.handle('journal:follows', () => follows.size);

  // ------------------------------------------------ export
  function checkExportPath(p) {
    if (typeof p !== 'string' || !p || p.length > 4096 || p.includes('\0') || !path.isAbsolute(p) || path.normalize(p) !== p || p.endsWith('/')) throw err('Invalid file path', 'EINVAL');
    const dir = path.dirname(p);
    let st;
    try {
      st = fs.statSync(dir);
    } catch {
      throw err('The folder does not exist', 'ENOENT');
    }
    if (!st.isDirectory()) throw err('The folder does not exist', 'ENOENT');
    try {
      if (!fs.lstatSync(p).isFile()) throw err('A folder or special file has this name', 'EISDIR');
    } catch (e) {
      if (e.code === 'EISDIR') throw e;
    }
    return p;
  }

  api.handle('journal:export', async (q, opts = {}, event) => {
    const v = validateQuery({ ...(q || {}), limit: undefined, before: undefined, after: undefined });
    v.limit = EXPORT_MAX;
    const format = opts?.format === 'json' ? 'json' : opts?.format === 'text' || opts?.format == null ? 'text' : null;
    if (!format) throw err('Invalid format', 'EINVAL');
    const file = checkExportPath(opts?.path);
    let picked;
    let more;
    if (fixture) {
      fixture.check();
      ({ picked, more } = pageFixture(v, fixture.entries(v.boot, v.user), makeMatcher(v)));
    } else {
      ({ picked, more } = await queryReal(v, {}, true, DETAIL_MAX));
    }
    const list = picked.slice().reverse(); // oldest first
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.part-${process.pid}-${Date.now()}`);
    const fd = fs.openSync(tmp, 'w', 0o644);
    let bytes = 0;
    const write = (s) => {
      bytes += fs.writeSync(fd, s);
    };
    try {
      if (format === 'text') {
        let boot = null;
        for (const p of list) {
          const e = fixture ? parseRaw(p.raw, DETAIL_MAX).entry : p.entry;
          if (e.boot && e.boot !== boot) {
            write(`-- Boot ${e.boot} --\n`);
            boot = e.boot;
          }
          write(`${entryLine(e)}\n`);
        }
      } else {
        write('[\n');
        list.forEach((p, i) => {
          const obj = {};
          for (const f of entryFields(p.raw, DETAIL_MAX)) {
            const val = f.value + (f.truncated ? ' […]' : '');
            if (f.name in obj) obj[f.name] = [].concat(obj[f.name], val);
            else obj[f.name] = val;
          }
          write(`${JSON.stringify(obj)}${i < list.length - 1 ? ',' : ''}\n`);
        });
        write(']\n');
      }
      fs.closeSync(fd);
      fs.renameSync(tmp, file);
    } catch (e) {
      try {
        fs.closeSync(fd);
      } catch {}
      fs.rmSync(tmp, { force: true });
      throw err(e.message, e.code === 'ENOSPC' ? 'ENOSPC' : e.code === 'EACCES' ? 'EACCES' : 'EFAIL');
    }
    return { path: file, count: list.length, bytes, capped: !!more };
  });
}

module.exports = register;
// Pure helpers, exported for tests (test/logs.test.mjs).
Object.assign(module.exports, {
  validateQuery,
  buildArgs,
  escapePcre,
  decodeValue,
  cleanText,
  parseRaw,
  entryFields,
  parseBootsJson,
  parseBootsText,
  stderrFlags,
  errorLine,
  entryLine,
  isoLocal,
  makeMatcher,
  cursorKey,
  LIMIT_MAX,
  LIST_MSG_MAX,
  DETAIL_MAX,
  EXPORT_MAX,
  LEVELS,
});
