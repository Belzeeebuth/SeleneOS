'use strict';
// Code Editor backend, part 2 (apps/code): search and replace across the files of the opened folder, in Node (walk +
// read with caps; ripgrep is not needed). Only inside a folder the app registered with code:openFolder (code.js); no
// file outside it is read or written (paths and symlinks are resolved and checked; folder links are not followed).
//
//   code:search(root, opts) -> { id, files, matches, limitHit, cancelled, timedOut, scanned,
//                                skipped: { binary, large, unreadable }, ms }
//       opts: { id (renderer-chosen, [\w-]{1,64}), query, regex, matchCase, wholeWord,
//               include, exclude (comma-separated globs: `*.js` matches at any depth, `src/**/x.ts` or `./src` from
//               the folder, a folder name matches everything under it),
//               useIgnore = true (.gitignore files of the folder and of its repository, .git/info/exclude, and
//               node_modules are skipped), maxResults = 5000 (≤ 20000), maxFileBytes = 4 MB (≤ 16 MB),
//               replace? (string: each match then carries `rep`, the replacement text it would get),
//               buffers?: [{ path, text }] (the editor's open documents: searched instead of the file on disk) }
//       .git / .hg / .svn are never searched; binary files (a NUL byte in the first 8000 bytes, or a known binary
//       extension) and files over maxFileBytes are skipped and counted.
//       (+code:search-batch) { id, results: [FileResult] }, in order, to the window that asked, before the answer.
//       FileResult = { path, rel, size, hash (sha1 of the bytes; null for a buffer), buffer?, matches: [Match] }
//       Match = { line (1-based), col (0-based, UTF-16 units in the line), len, text (the line, or a window of it
//                 when longer than 240), off (column where `text` starts), rep? }
//       Matching is per line (a match never spans lines; `^` and `$` are the line's ends; CR of CRLF ignored).
//       Empty matches are skipped. Regex replacements expand $&, $1…$99, $<name>, $$, $` and $' (within the line).
//   code:searchCancel(id) -> boolean
//   code:replace(root, { query, regex, matchCase, wholeWord, replace, files: [{ path, hash, only? }] })
//       -> { changed: [{ path, count }], skipped: [{ path, reason }], undoId }
//       Each file is re-read, must still have the `hash` of the search (else reason 'changed'), and gets exactly the
//       matches of the search (only: [ordinal] limits it to those matches of the file). Reasons: invalid, outside,
//       missing, large, binary, encoding (not UTF-8: never rewritten), changed, nomatch, failed.
//   code:replaceUndo(undoId) -> { restored: [path], skipped: [{ path, reason }] }   (paths as given to code:replace)
//       puts back the bytes of the files of that replace that nobody changed since (64 MB of history, last 8).
// Test hook (dev only): opts.delayMs waits that long before each file (a slow search to cancel).
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { checkRoot, inside, isEvent, fail } = require('./code.js');

const DEFAULT_MAX_RESULTS = 5000;
const MAX_RESULTS = 20000;
const DEFAULT_MAX_FILE = 4 * 1024 * 1024;
const MAX_FILE = 16 * 1024 * 1024;
const MAX_SCANNED = 200000;
const DEADLINE_MS = 120000;
const MAX_QUERY = 2000;
const MAX_BUFFERS_BYTES = 64 * 1024 * 1024;
const PREVIEW_MAX = 240;
const PREVIEW_BEFORE = 50;
const UNDO_BYTES = 64 * 1024 * 1024;
const UNDO_KEEP = 8;
const ALWAYS_SKIP = new Set(['.git', '.hg', '.svn']);
const IGNORE_SKIP = new Set(['node_modules']);
const BINARY_EXT = new Set(
  ('png jpg jpeg gif bmp ico icns webp avif tif tiff psd xcf pdf zip gz tgz bz2 xz zst 7z rar tar jar war class so o a ' +
    'lib dll exe bin dylib wasm woff woff2 ttf otf eot mp3 mp4 m4a m4v aac ogg oga opus flac wav webm mkv avi mov ' +
    'sqlite sqlite3 db pyc pyo node iso img dmg deb rpm apk blend glb fbx')
    .split(' ')
    .map((x) => `.${x}`),
);

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
const isBinary = (buf) => buf.subarray(0, 8000).includes(0);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

// ------------------------------------------------------------------ globs and .gitignore
/**
 * A gitignore-style pattern as { re, dirOnly }, tested against a path relative to the pattern's base folder.
 * No slash (or only a trailing one): matches at any depth. A leading or inner slash anchors it to the base.
 * `*` and `?` stop at `/`; `**` / `**\/` / `\/**` span folders; [a-z] classes ([!…] negated); `\x` is a literal x.
 */
function globToRegExp(glob) {
  let g = String(glob || '');
  if (!g || g.length > 1000) return null;
  let dirOnly = false;
  if (g.endsWith('/') && !g.endsWith('\\/')) {
    dirOnly = true;
    g = g.replace(/\/+$/, '');
  }
  if (!g) return null;
  const anchored = g.startsWith('/') || g.includes('/');
  g = g.replace(/^\/+/, '');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        const start = i === 0 || g[i - 1] === '/';
        if (start && g[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
          continue;
        }
        if (start && i + 2 === g.length) {
          re += '.*';
          i += 1;
          continue;
        }
        while (g[i + 1] === '*') i++;
      }
      re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '[') {
      let j = i + 1;
      if (g[j] === '!' || g[j] === '^') j++;
      if (g[j] === ']') j++;
      while (j < g.length && g[j] !== ']') j++;
      if (j >= g.length) {
        re += '\\[';
        continue;
      }
      let body = g.slice(i + 1, j);
      const neg = body[0] === '!' || body[0] === '^';
      if (neg) body = body.slice(1);
      re += `[${neg ? '^' : ''}${body.replace(/\\/g, '\\\\').replace(/\[/g, '\\[').replace(/\]/g, '\\]')}]`;
      i = j;
    } else if (c === '\\' && i + 1 < g.length) re += escapeRe(g[++i]);
    else re += escapeRe(c);
  }
  try {
    return { re: new RegExp(`${anchored ? '^' : '^(?:.*/)?'}${re}$`), dirOnly };
  } catch {
    return null;
  }
}

/** The rules of a .gitignore text: [{ re, dirOnly, negate }] in order (the last rule that matches wins). */
function parseIgnore(text) {
  const rules = [];
  for (let line of String(text || '').split('\n')) {
    line = line.replace(/\r$/, '');
    if (!line || line.startsWith('#')) continue;
    line = line.replace(/(?<!\\)\s+$/, ''); // trailing spaces go unless escaped
    if (!line) continue;
    let negate = false;
    if (line.startsWith('!')) {
      negate = true;
      line = line.slice(1);
    }
    const g = globToRegExp(line);
    if (g) rules.push({ ...g, negate });
  }
  return rules;
}

/**
 * Whether `rel` (relative to the searched folder) is ignored by a stack of rule sets
 * [{ prefix, base, rules }]: `base` is the set's folder relative to the searched folder ('' = the folder itself);
 * `prefix` is prepended for the sets of the folders above it (the repository's own .gitignore files).
 */
function ignoredBy(stack, rel, isDir) {
  let ignored = false;
  for (const { prefix = '', base = '', rules } of stack) {
    let sub;
    if (!base) sub = rel;
    else if (rel.startsWith(`${base}/`)) sub = rel.slice(base.length + 1);
    else continue;
    sub = prefix + sub;
    for (const r of rules) if ((!r.dirOnly || isDir) && r.re.test(sub)) ignored = !r.negate;
  }
  return ignored;
}

/** Comma-separated globs -> [glob]. A leading ./ anchors to the folder. */
function globList(s) {
  return String(s || '')
    .split(',')
    .map((x) => x.trim().replace(/^\.\//, '/'))
    .filter(Boolean)
    .slice(0, 64)
    .map(globToRegExp)
    .filter(Boolean);
}
const matchesAny = (globs, rel, isDir) => globs.some((g) => (!g.dirOnly || isDir) && g.re.test(rel));

// ------------------------------------------------------------------ matching
/** The search RegExp ('g', Unicode when it can). Throws EREGEX for an invalid expression, EQUERY for no query. */
function compileQuery({ query, regex = false, matchCase = false, wholeWord = false } = {}) {
  const q = typeof query === 'string' ? query : '';
  if (!q || q.length > MAX_QUERY) throw fail('Invalid query', 'EQUERY');
  const src = regex ? q : escapeRe(q);
  const word = (s, cls) => `(?<!${cls})(?:${s})(?!${cls})`;
  const flags = matchCase ? 'g' : 'gi';
  let re;
  try {
    re = new RegExp(wholeWord ? word(src, '[\\p{L}\\p{N}_]') : src, `${flags}u`);
  } catch (err) {
    if (!regex) throw fail(err.message, 'EREGEX');
    // some valid non-Unicode expressions (\-, \_, …) are errors in Unicode mode
    try {
      re = new RegExp(wholeWord ? word(src, '[\\w\\u00C0-\\u024F]') : src, flags);
    } catch (err2) {
      throw fail(err2.message, 'EREGEX');
    }
  }
  // a whole-text test can rule a file out before the line walk, unless the expression has lookarounds of its own
  // (they could see past a line's end in the whole text)
  re.precheck = !regex || !/\(\?<?[=!]/.test(q);
  return re;
}

/** The text a regex replacement gives for one match (the String.prototype.replace patterns). */
function expandReplacement(rep, m, input) {
  return String(rep).replace(/\$(\$|&|`|'|\d{1,2}|<([^>]*)>)/g, (all, tok, name) => {
    if (tok === '$') return '$';
    if (tok === '&') return m[0];
    if (tok === '`') return input.slice(0, m.index);
    if (tok === "'") return input.slice(m.index + m[0].length);
    if (name !== undefined) return m.groups ? (m.groups[name] ?? '') : all;
    const two = Number(tok);
    if (tok.length === 2 && two >= 1 && two < m.length) return m[two] ?? '';
    const one = Number(tok[0]);
    if (one >= 1 && one < m.length) return (m[one] ?? '') + tok.slice(1);
    return all;
  });
}

/** Every match of `re` in `text`, line by line: yields { line (1-based), lineFrom, input, m }. */
function* eachMatch(text, re) {
  const n = text.length;
  if (re.precheck) {
    re.quick ||= new RegExp(re.source, `${re.flags.replace('g', '')}m`);
    if (!re.quick.test(text)) return;
  }
  let pos = 0;
  let line = 0;
  while (pos <= n) {
    let end = text.indexOf('\n', pos);
    if (end < 0) end = n;
    line++;
    const lineEnd = end > pos && text.charCodeAt(end - 1) === 13 ? end - 1 : end;
    const input = text.slice(pos, lineEnd);
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(input))) {
      if (!m[0].length) {
        // an empty match: step over it (by code point in Unicode mode)
        const cp = re.unicode ? input.codePointAt(re.lastIndex) : 0;
        re.lastIndex += cp > 0xffff ? 2 : 1;
        if (re.lastIndex > input.length) break;
        continue;
      }
      yield { line, lineFrom: pos, input, m };
    }
    if (end >= n) break;
    pos = end + 1;
  }
}

function previewOf(input, m) {
  if (input.length <= PREVIEW_MAX) return { text: input, off: 0 };
  const off = Math.max(0, Math.min(m.index - PREVIEW_BEFORE, input.length - PREVIEW_MAX));
  return { text: input.slice(off, off + PREVIEW_MAX), off };
}

/** Up to `limit` matches of a text: [Match] (see the header). `replace`: also the expanded replacement. */
function findInText(text, re, { limit = Infinity, replace = null, regex = false } = {}) {
  const out = [];
  if (limit <= 0) return out;
  for (const { line, input, m } of eachMatch(text, re)) {
    const p = previewOf(input, m);
    const r = { line, col: m.index, len: m[0].length, text: p.text, off: p.off };
    if (typeof replace === 'string') r.rep = regex ? expandReplacement(replace, m, input) : replace;
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

/** Replaces the matches of `re` (all, or those whose ordinal is in `only`): { text, count }. */
function replaceInText(text, re, replace, { regex = false, only = null } = {}) {
  const parts = [];
  let last = 0;
  let ordinal = -1;
  let count = 0;
  for (const { lineFrom, input, m } of eachMatch(text, re)) {
    ordinal++;
    if (only && !only.has(ordinal)) continue;
    const at = lineFrom + m.index;
    parts.push(text.slice(last, at), regex ? expandReplacement(replace, m, input) : replace);
    last = at + m[0].length;
    count++;
  }
  if (!count) return { text, count: 0 };
  parts.push(text.slice(last));
  return { text: parts.join(''), count };
}

// ------------------------------------------------------------------ the walk
async function readIgnoreFile(file) {
  const st = await fsp.stat(file).catch(() => null);
  if (!st?.isFile() || st.size > 1024 * 1024) return [];
  return parseIgnore(await fsp.readFile(file, 'utf8').catch(() => ''));
}

/**
 * The ignore rules that come from above the searched folder: when it is inside a git repository (a .git found in
 * one of its parents), that repository's .git/info/exclude and the .gitignore files of the folders in between.
 */
async function ancestorIgnores(real) {
  const chain = [];
  let dir = path.dirname(real);
  let top = null;
  for (let i = 0; i < 40 && dir !== path.dirname(dir); i++) {
    chain.unshift(dir);
    if (await fsp.lstat(path.join(dir, '.git')).then(() => true, () => false)) {
      top = dir;
      break;
    }
    dir = path.dirname(dir);
  }
  if (await fsp.lstat(path.join(real, '.git')).then(() => true, () => false)) {
    // the folder is the top of its repository
    const rules = await readIgnoreFile(path.join(real, '.git', 'info', 'exclude'));
    return rules.length ? [{ prefix: '', base: '', rules }] : [];
  }
  if (!top) return [];
  const sets = [];
  const relFrom = (d) => path.relative(d, real).split(path.sep).join('/');
  const exclude = await readIgnoreFile(path.join(top, '.git', 'info', 'exclude'));
  if (exclude.length) sets.push({ prefix: `${relFrom(top)}/`, base: '', rules: exclude });
  for (const d of chain.slice(chain.indexOf(top))) {
    const rules = await readIgnoreFile(path.join(d, '.gitignore'));
    if (rules.length) sets.push({ prefix: `${relFrom(d)}/`, base: '', rules });
  }
  return sets;
}

const clampInt = (v, def, min, max) => (Number.isFinite(Number(v)) ? Math.max(min, Math.min(max, Math.round(Number(v)))) : def);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs one search. `root` is the folder as the app knows it (paths in the results start with it), `real` its real
 * path. emit(fileResult) receives each file with matches, in path order. ctl.cancelled stops it.
 */
async function search(root, real, opts, ctl, emit, { dev = false } = {}) {
  const t0 = Date.now();
  const re = compileQuery(opts);
  const regex = !!opts.regex;
  const maxResults = clampInt(opts.maxResults, DEFAULT_MAX_RESULTS, 1, MAX_RESULTS);
  const maxFile = clampInt(opts.maxFileBytes, DEFAULT_MAX_FILE, 1024, MAX_FILE);
  const replace = typeof opts.replace === 'string' ? opts.replace : null;
  const include = globList(opts.include);
  const exclude = globList(opts.exclude);
  const useIgnore = opts.useIgnore !== false;
  const delay = dev ? clampInt(opts.delayMs, 0, 0, 1000) : 0;
  const rootAbs = path.resolve(root);
  const buffers = new Map();
  let bufBytes = 0;
  for (const b of Array.isArray(opts.buffers) ? opts.buffers : []) {
    if (!b || typeof b.path !== 'string' || typeof b.text !== 'string' || !path.isAbsolute(b.path)) continue;
    const abs = path.resolve(b.path);
    if (!inside(abs, rootAbs) || bufBytes + b.text.length > MAX_BUFFERS_BYTES) continue;
    bufBytes += b.text.length;
    buffers.set(abs, b.text);
  }
  const res = { files: 0, matches: 0, limitHit: false, cancelled: false, timedOut: false, scanned: 0, skipped: { binary: 0, large: 0, unreadable: 0 } };
  const stack = useIgnore ? await ancestorIgnores(real) : [];
  const stop = () => {
    if (ctl.cancelled) res.cancelled = true;
    else if (Date.now() - t0 > DEADLINE_MS) res.timedOut = true;
    return res.cancelled || res.timedOut || res.limitHit;
  };

  async function searchFile(abs, rel) {
    res.scanned++;
    if (res.scanned > MAX_SCANNED) {
      res.limitHit = true;
      return;
    }
    if (delay) await sleep(delay);
    if (stop()) return;
    let text = buffers.get(abs);
    let hash = null;
    let size;
    if (text != null) size = text.length;
    else {
      if (BINARY_EXT.has(path.extname(abs).toLowerCase())) {
        res.skipped.binary++;
        return;
      }
      const st = await fsp.stat(abs).catch(() => null);
      if (!st?.isFile()) {
        res.skipped.unreadable++;
        return;
      }
      if (st.size > maxFile) {
        res.skipped.large++;
        return;
      }
      const data = await fsp.readFile(abs).catch(() => null);
      if (!data) {
        res.skipped.unreadable++;
        return;
      }
      if (isBinary(data)) {
        res.skipped.binary++;
        return;
      }
      text = data.toString('utf8');
      hash = sha1(data);
      size = data.length;
    }
    const left = maxResults - res.matches;
    const matches = findInText(text, re, { limit: left + 1, replace, regex });
    if (!matches.length) return;
    if (matches.length > left) {
      matches.length = left;
      res.limitHit = true;
    }
    if (!matches.length) return;
    res.files++;
    res.matches += matches.length;
    const out = { path: path.join(root, rel), rel, size, hash, matches };
    if (hash == null) out.buffer = true;
    emit(out);
  }

  async function walk(abs, rel, inc) {
    if (stop()) return;
    let ents;
    try {
      ents = await fsp.readdir(abs, { withFileTypes: true });
    } catch {
      res.skipped.unreadable++;
      return;
    }
    ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    let pushed = false;
    if (useIgnore && ents.some((e) => e.name === '.gitignore')) {
      const rules = await readIgnoreFile(path.join(abs, '.gitignore'));
      if (rules.length) {
        stack.push({ prefix: '', base: rel, rules });
        pushed = true;
      }
    }
    try {
      for (const e of ents) {
        if (stop()) return;
        const r = rel ? `${rel}/${e.name}` : e.name;
        const p = path.join(abs, e.name);
        let isDir = e.isDirectory();
        let isFile = e.isFile();
        if (e.isSymbolicLink()) {
          // links: only to files, and only when they resolve inside the folder (folder links are not followed:
          // no loops, no way out of the folder)
          const target = await fsp.realpath(p).catch(() => null);
          const st = target && (await fsp.stat(target).catch(() => null));
          if (!st?.isFile() || !inside(target, real)) continue;
          isFile = true;
          isDir = false;
        }
        if (isDir) {
          if (ALWAYS_SKIP.has(e.name)) continue;
          if (useIgnore && (IGNORE_SKIP.has(e.name) || ignoredBy(stack, r, true))) continue;
          if (matchesAny(exclude, r, true)) continue;
          await walk(p, r, inc || matchesAny(include, r, true));
        } else if (isFile) {
          if (useIgnore && ignoredBy(stack, r, false)) continue;
          if (matchesAny(exclude, r, false)) continue;
          if (include.length && !inc && !matchesAny(include, r, false)) continue;
          await searchFile(path.join(abs, e.name), r);
        }
      }
    } finally {
      if (pushed) stack.pop();
    }
  }

  await walk(root, '', false);
  stop();
  res.ms = Date.now() - t0;
  return res;
}

// ------------------------------------------------------------------ replace
const undoStore = new Map(); // undoId -> { key, root, entries: [{ path, before, after }] }
let undoSeq = 0;

async function replaceFiles(root, real, opts, key) {
  const re = compileQuery(opts);
  if (typeof opts.replace !== 'string' || opts.replace.length > 100000) throw fail('Invalid replacement', 'EINVAL');
  const files = Array.isArray(opts.files) ? opts.files : null;
  if (!files || files.length > 20000) throw fail('Invalid file list', 'EINVAL');
  const rootAbs = path.resolve(root);
  const changed = [];
  const skipped = [];
  const entries = [];
  let undoBytes = 0;
  for (const f of files) {
    const p = f?.path;
    const skip = (reason) => skipped.push({ path: String(p), reason });
    if (typeof p !== 'string' || !path.isAbsolute(p) || p.includes('\0') || typeof f.hash !== 'string') {
      skip('invalid');
      continue;
    }
    const abs = path.resolve(p);
    if (!inside(abs, rootAbs)) {
      skip('outside');
      continue;
    }
    const target = await fsp.realpath(abs).catch(() => null);
    if (!target) {
      skip('missing');
      continue;
    }
    if (!inside(target, real)) {
      skip('outside');
      continue;
    }
    const st = await fsp.stat(target).catch(() => null);
    if (!st?.isFile()) {
      skip('missing');
      continue;
    }
    if (st.size > MAX_FILE) {
      skip('large');
      continue;
    }
    const data = await fsp.readFile(target).catch(() => null);
    if (!data) {
      skip('missing');
      continue;
    }
    if (isBinary(data)) {
      skip('binary');
      continue;
    }
    if (sha1(data) !== f.hash) {
      skip('changed');
      continue;
    }
    const text = data.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(data)) {
      skip('encoding');
      continue;
    }
    const only = Array.isArray(f.only) ? new Set(f.only.filter((n) => Number.isInteger(n) && n >= 0)) : null;
    const out = replaceInText(text, re, opts.replace, { regex: !!opts.regex, only });
    if (!out.count) {
      skip('nomatch');
      continue;
    }
    const bytes = Buffer.from(out.text, 'utf8');
    try {
      await fsp.writeFile(target, bytes);
    } catch {
      skip('failed');
      continue;
    }
    changed.push({ path: p, count: out.count });
    undoBytes += data.length;
    entries.push({ path: target, shown: p, before: data, after: sha1(bytes) });
  }
  let undoId = null;
  if (entries.length && undoBytes <= UNDO_BYTES) {
    undoId = `u${++undoSeq}`;
    undoStore.set(undoId, { key, root: real, entries, bytes: undoBytes });
    // keep the last few, and no more than UNDO_BYTES in all
    const ids = [...undoStore.keys()];
    let total = 0;
    for (let i = ids.length - 1; i >= 0; i--) {
      total += undoStore.get(ids[i]).bytes;
      if (total > UNDO_BYTES || ids.length - i > UNDO_KEEP) undoStore.delete(ids[i]);
    }
  }
  return { changed, skipped, undoId };
}

async function undoReplace(undoId, key) {
  const rec = typeof undoId === 'string' ? undoStore.get(undoId) : null;
  if (!rec || rec.key !== key) throw fail('Nothing to undo', 'ENOUNDO');
  undoStore.delete(undoId);
  const restored = [];
  const skipped = [];
  for (const e of rec.entries) {
    // still the same file (no link put in its place since), still inside the folder
    const now = await fsp.realpath(e.path).catch(() => null);
    if (now !== e.path || !inside(now, rec.root)) {
      skipped.push({ path: e.shown, reason: now ? 'changed' : 'missing' });
      continue;
    }
    const data = await fsp.readFile(e.path).catch(() => null);
    if (!data) {
      skipped.push({ path: e.shown, reason: 'missing' });
      continue;
    }
    if (sha1(data) !== e.after) {
      skipped.push({ path: e.shown, reason: 'changed' });
      continue;
    }
    try {
      await fsp.writeFile(e.path, e.before);
      restored.push(e.shown);
    } catch {
      skipped.push({ path: e.shown, reason: 'failed' });
    }
  }
  return { restored, skipped };
}

// ------------------------------------------------------------------ registration
module.exports = function register(api) {
  const running = new Map(); // id -> ctl
  const sendTo = (sender, channel, payload) => (api.sendTo ? api.sendTo(sender, channel, payload) : sender?.send?.(channel, payload));
  const senderKey = (event) => event?.sender?.id ?? 0;

  api.handle('code:search', async (root, opts, event) => {
    if (isEvent(opts)) [opts, event] = [{}, opts];
    const real = await checkRoot(event, root);
    const o = opts && typeof opts === 'object' ? opts : {};
    const id = typeof o.id === 'string' && /^[\w-]{1,64}$/.test(o.id) ? o.id : `s${Date.now()}`;
    const ctl = { cancelled: false };
    running.get(id) && (running.get(id).cancelled = true);
    running.set(id, ctl);
    let batch = [];
    let last = Date.now();
    const flush = () => {
      if (batch.length) sendTo(event?.sender, 'code:search-batch', { id, results: batch });
      batch = [];
      last = Date.now();
    };
    try {
      const res = await search(root, real, o, ctl, (r) => {
        batch.push(r);
        if (batch.length >= 50 || Date.now() - last > 120) flush();
      }, { dev: !!api.DEV });
      flush();
      return { id, ...res };
    } finally {
      if (running.get(id) === ctl) running.delete(id);
    }
  });

  api.handle('code:searchCancel', async (id) => {
    const ctl = typeof id === 'string' ? running.get(id) : null;
    if (!ctl) return false;
    ctl.cancelled = true;
    return true;
  });

  api.handle('code:replace', async (root, opts, event) => {
    if (isEvent(opts)) [opts, event] = [{}, opts];
    const real = await checkRoot(event, root);
    return replaceFiles(root, real, opts && typeof opts === 'object' ? opts : {}, senderKey(event));
  });

  api.handle('code:replaceUndo', async (undoId, event) => {
    const rec = typeof undoId === 'string' ? undoStore.get(undoId) : null;
    if (rec) await checkRoot(event, rec.root);
    return undoReplace(undoId, senderKey(event));
  });
};

Object.assign(module.exports, { globToRegExp, parseIgnore, ignoredBy, globList, compileQuery, expandReplacement, findInText, replaceInText, search });
