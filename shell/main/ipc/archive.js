'use strict';
// Archive Manager backend (renderer/apps/archive): list, extract, create, add to, delete from, test and
// preview archives with 7-Zip (`7z`, package 7zip) and libarchive (`bsdtar` / `bsdcat`, libarchive-tools).
//
// Every tool runs through spawn() with an argument array (never a shell), with '--' (or "./name") in front
// of user paths, LC_ALL=C.UTF-8, and in its own process group without a controlling terminal: passwords are
// written to 7-Zip's stdin (never on a command line, where `ps` would show them) and cancel kills the whole
// pipeline.
//
//   archive:tools ()                          -> { sevenZip, bsdtar, bsdcat, create: [formats], encrypt }
//   archive:list (path, {password})           -> Listing (below)
//   archive:extract (path, dest, {entries, password, overwrite: 'rename'|'replace'|'skip', opId,
//                    skipUnsafe, allowBomb})  -> { dest, items: [top-level paths], files, dirs, bytes,
//                                                 skipped: [{path, reason}], renamed, replaced, kept }
//   archive:extractTemp (path, {entries, password, session, sub, opId}) -> same, into the window's private temp
//                    folder (<tempDir>/x-<sub> when sub is given, for drag & drop)
//   archive:tempDir (session)                 -> the window's private temp folder (0700, removed on cleanup/quit)
//   archive:preview (path, entry, {password, session, opId, text: maxBytes}) -> { path, size, text?, binary?,
//                    truncated? }   one entry extracted to the window's private temp folder (cached)
//   archive:cleanup (session)                 -> true  (stops that window's previews / temp extractions, then
//                                                deletes its temp files)
//   archive:create (srcPaths, destPath, {format: zip|7z|tar|tar.gz|tar.xz|tar.zst, level 0-9, password,
//                   encryptNames, opId})      -> { path, size }
//   archive:add (path, srcPaths, {base, password, opId}) -> { added }      (zip, 7z, tar family)
//   archive:delete (path, entries, {password, opId})     -> { deleted }    (zip, 7z, tar family)
//   archive:test (path, {password, opId})     -> { ok, errors: [string], files }
//   archive:cancel (opId)                     -> true
//   event 'archive:progress' { opId, phase, done, total, percent (0..1 | null), current }
//
// Listing = { path, name, size, mtime, format, kind, type, method, solid, comment, physicalSize,
//   entries: [{ path, raw, name, dir, size, packed, mtime, mode, encrypted, link, hardlink, method }],
//   count, files, dirs, totalSize, totalPacked, perEntryPacked, truncated, encrypted, headersEncrypted,
//   unsafe: [{ path, reason: 'absolute'|'parent'|'link'|'special' }], bomb: null | { reason, total, ratio },
//   canAdd, canDelete, canEncrypt, readOnly: null | 'format' | 'damaged' | 'truncated' | 'perm' }
//   `path` is normalised ("./a//b/" -> "a/b"), `raw` is the name stored in the archive.
//
// Safe extraction: entries with an absolute path, a '..' component, a link pointing outside the
// destination, or a device/FIFO are reported in `unsafe` and refused (EUNSAFE) unless skipUnsafe is set,
// in which case they are excluded by exact name. Extraction always happens in a private staging folder
// (0700) inside the destination; after the tool finishes the staging tree is checked with lstat/realpath
// (escaping symlinks and special files are deleted, setuid bits and unreadable modes fixed) and only then
// moved into place with the chosen overwrite policy. Zip bombs (> 10 GB, or > 100x and > 64 MB) need
// allowBomb. Errors carry a code: ENOENT (the archive) ENOENTRY (an item not in the archive) ENOITEM (an item
// to add / compress is missing) ENODEST EFORMAT EPASSWORD EBADPASSWORD EZIPPASSWORD EUNSAFE EBOMB ENOSPC EACCES
// EEXIST ELINK (preview of a link) ENOTSUP ETOOL ECORRUPT ECANCELED EARCHIVE EINVAL.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { which } = require('../lib/exec');

const MAX_ENTRIES = 200000;
const BOMB_TOTAL = 10 * 1024 ** 3;
const BOMB_RATIO = 100;
const BOMB_MIN = 64 * 1024 ** 2;
const ENV = { ...process.env, LC_ALL: 'C.UTF-8', LANG: 'C.UTF-8', LANGUAGE: '' };
const CREATE_FORMATS = ['zip', '7z', 'tar', 'tar.gz', 'tar.xz', 'tar.zst', 'tar.bz2'];
const TAR_FILTER = { 'tar.gz': 'gzip', 'tar.xz': 'xz', 'tar.zst': 'zstd', 'tar.bz2': 'bzip2', tar: null };
const TAR_FLAG = { gzip: '-z', xz: '-J', zstd: '--zstd', bzip2: '-j' };

function err(message, code, extra) {
  const e = new Error(message);
  e.code = code;
  if (extra) Object.assign(e, extra);
  if (code === 'ECANCELED' || code === 'EPASSWORD' || code === 'EBADPASSWORD' || code === 'EUNSAFE' || code === 'EBOMB') e.quiet = true;
  return e;
}

// ------------------------------------------------------------------ tools
let toolCache = null;
function tools() {
  if (!toolCache || !toolCache.sz || !toolCache.bsdtar) {
    toolCache = { sz: which('7z') || which('7zz') || which('7za'), bsdtar: which('bsdtar'), bsdcat: which('bsdcat') };
  }
  return toolCache;
}
function need(bin, name) {
  if (!bin) throw err(`${name} is not installed`, 'ETOOL');
  return bin;
}

// ------------------------------------------------------------------ paths
function absPath(p, what = 'path') {
  if (typeof p !== 'string' || !p || p.includes('\0') || !path.isAbsolute(p)) throw err(`Invalid ${what}`, 'EINVAL');
  return path.resolve(p);
}
function isInside(root, p) {
  const rel = path.relative(root, p);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}
/** Normalise an archive member name. Returns { path, unsafe } ; path '' = the archive root itself. */
function normEntry(raw) {
  const s = String(raw);
  if (s.startsWith('/')) return { path: s.replace(/^\/+/, ''), unsafe: 'absolute' };
  const parts = s.split('/').filter((x) => x && x !== '.');
  if (parts.includes('..')) return { path: parts.join('/'), unsafe: 'parent' };
  return { path: parts.join('/'), unsafe: null };
}
/** Does a symlink target stay inside the extraction root? (lexical, relative to the link's folder) */
function linkInside(entryPath, target) {
  if (!target) return true;
  if (target.startsWith('/')) return false;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(entryPath), target));
  return resolved !== '..' && !resolved.startsWith('../');
}
function splitExt(name) {
  const m = /(\.tar\.(gz|xz|bz2|zst|lz|lzma)|\.[^./]{1,8})$/i.exec(name);
  return m && m.index > 0 ? [name.slice(0, m.index), m[0]] : [name, ''];
}
/** Does p exist (a dangling link counts)? */
const present = (p) => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};
async function exists(p) {
  try {
    await fsp.lstat(p);
    return true;
  } catch {
    return false;
  }
}
/**
 * mkdir -p without fs.mkdir({recursive}): Node's recursive mkdir never settles for a path under a pseudo
 * file system (e.g. "/proc/x": mkdir says ENOENT, the parent exists, and it retries forever). Walk up to the
 * nearest existing ancestor, then create each missing component with a plain mkdir.
 */
async function mkdirp(dir, mode) {
  const missing = [];
  let cur = path.resolve(dir);
  for (;;) {
    let st = null;
    try {
      st = await fsp.stat(cur);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    if (st) {
      if (!st.isDirectory()) throw Object.assign(new Error(`Not a folder: ${cur}`), { code: 'ENOTDIR' });
      break;
    }
    missing.push(cur);
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  for (const d of missing.reverse()) {
    try {
      await fsp.mkdir(d, mode);
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
}
async function uniqueName(dir, name) {
  if (!(await exists(path.join(dir, name)))) return path.join(dir, name);
  const [stem, ext] = splitExt(name);
  for (let i = 2; i < 10000; i++) {
    const cand = path.join(dir, `${stem} (${i})${ext}`);
    if (!(await exists(cand))) return cand;
  }
  throw err('Could not find a free name', 'EEXIST');
}
function parseModeString(s) {
  const m = /([-dlcbpsD])([-r][-w][-xsS])([-r][-w][-xsS])([-r][-w][-xtT])/.exec(s || '');
  if (!m) return null;
  const perm = m.slice(2).join('');
  let mode = 0;
  const bits = [0o400, 0o200, 0o100, 0o40, 0o20, 0o10, 4, 2, 1];
  for (let i = 0; i < 9; i++) if (perm[i] !== '-' && perm[i] !== 'S' && perm[i] !== 'T') mode |= bits[i];
  const type = { d: 0o40000, D: 0o40000, l: 0o120000, c: 0o20000, b: 0o60000, p: 0o10000, s: 0o140000, '-': 0o100000 }[m[1]];
  return { mode: mode | type, type: m[1] };
}
// libarchive patterns: escape glob characters; '^' anchors (exclusions are unanchored by default).
// Pattern files are newline-separated (bsdtar's --null pattern files only honour the first pattern), so a
// newline or carriage return inside a name becomes '?' (any one character).
function globEscape(s) {
  return s.replace(/[\\*?[\]^]/g, (c) => `\\${c}`).replace(/[\r\n]/g, '?');
}
// POSIX basic regular expression (bsdtar -s) matching exactly `s`.
function breEscape(s) {
  return s.replace(/[.[\]*^$\\,]/g, (c) => (c === ',' ? '\\,' : `\\${c}`));
}

// ------------------------------------------------------------------ format detection
const MAGIC = [
  ['zip', [0x50, 0x4b, 0x03, 0x04]],
  ['zip', [0x50, 0x4b, 0x05, 0x06]],
  ['zip', [0x50, 0x4b, 0x07, 0x08]],
  ['7z', [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]],
  ['rar', [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07]],
  ['cab', [0x4d, 0x53, 0x43, 0x46]],
  ['gz', [0x1f, 0x8b]],
  ['xz', [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]],
  ['bz2', [0x42, 0x5a, 0x68]],
  ['zst', [0x28, 0xb5, 0x2f, 0xfd]],
];
function isTarHeader(buf) {
  if (buf.length < 512) return false;
  if (buf.toString('latin1', 257, 262) === 'ustar') return true;
  let zero = true;
  for (let i = 0; i < 512; i++) if (buf[i]) zero = false;
  if (zero) return buf.length >= 1024; // empty tar: two zero blocks
  const stored = parseInt(buf.toString('latin1', 148, 156).replace(/[\0 ]+$/, '').trim(), 8);
  if (!Number.isFinite(stored)) return false;
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : buf[i];
  return sum === stored;
}
async function readHead(file, n = 4096) {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}
/** First bytes of the decompressed stream (bsdcat), to tell a compressed tar from a single compressed file. */
function decompressedHead(file, n = 1024) {
  const { bsdcat } = tools();
  if (!bsdcat) return Promise.resolve(null);
  return new Promise((resolve) => {
    const child = spawn(bsdcat, [], { env: ENV, detached: true, stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks = [];
    let got = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
      resolve(Buffer.concat(chunks).subarray(0, n));
    };
    child.stdout.on('data', (c) => {
      chunks.push(c);
      got += c.length;
      if (got >= n) finish();
    });
    child.on('error', () => finish());
    child.on('close', finish);
    child.stdin.on('error', () => {});
    const rs = fs.createReadStream(file, { start: 0, end: 4 * 1024 * 1024 });
    rs.on('error', () => finish());
    rs.pipe(child.stdin);
    setTimeout(finish, 15000).unref?.();
  });
}

async function detect(file) {
  let st;
  try {
    st = await fsp.stat(file);
  } catch (e) {
    throw err(e.code === 'EACCES' ? 'Permission denied' : 'The archive does not exist', e.code === 'EACCES' ? 'EACCES' : 'ENOENT');
  }
  if (st.isDirectory()) throw err('This is a folder, not an archive', 'EFORMAT');
  let head;
  try {
    head = await readHead(file);
  } catch (e) {
    throw err(e.code === 'EACCES' ? 'Permission denied' : String(e.message), e.code === 'EACCES' ? 'EACCES' : 'EARCHIVE');
  }
  const name = path.basename(file);
  let kind = null;
  for (const [k, sig] of MAGIC) if (sig.every((b, i) => head[i] === b)) {
    kind = k;
    break;
  }
  if (!kind && isTarHeader(head)) kind = 'tar';
  if (!kind) {
    if (/\.(zip|jar)$/i.test(name) && head.length) kind = 'zip'; // self-extracting / prefixed zip
    else if (/\.tar$/i.test(name) && head.length === 0) kind = 'tar';
    else throw err('This file is not an archive, or the format is not supported', 'EFORMAT');
  }
  let format = kind;
  let filter = null;
  if (kind === 'gz' || kind === 'xz' || kind === 'bz2' || kind === 'zst') {
    filter = { gz: 'gzip', xz: 'xz', bz2: 'bzip2', zst: 'zstd' }[kind];
    const dh = await decompressedHead(file);
    const tarry = dh ? isTarHeader(dh) || (dh.length === 0 && /\.(tgz|txz|tbz2?|tzst|tar\.\w+)$/i.test(name)) : /\.(tgz|txz|tbz2?|tzst|tar\.\w+)$/i.test(name);
    if (tarry) {
      format = `tar.${kind}`;
      kind = 'tar';
    } else {
      kind = 'single';
    }
  }
  if (kind === 'zip' && /\.jar$/i.test(name)) format = 'jar';
  return { file, name, size: st.size, mtime: st.mtimeMs, mode: st.mode, kind, format, filter };
}

// ------------------------------------------------------------------ processes
const ops = new Map(); // opId -> op
const running = new Set(); // every live child (killed on quit)

function makeOp(opId, sender, sendTo, phase) {
  const id = typeof opId === 'string' && opId ? opId.slice(0, 80) : `op${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  const op = {
    id,
    phase,
    canceled: false,
    children: new Set(),
    done: 0,
    total: 0,
    bytes: 0,
    totalBytes: 0,
    percent: null,
    current: '',
    cleanup: [],
    lastSent: 0,
    started: 0,
    session: null,
    settled: null,
    /** The tools print an item's name when they START it: done = items finished = started - 1 (the last
     *  one is counted when the whole operation succeeds). */
    tick(name) {
      op.started++;
      op.done = Math.max(0, Math.min(op.total > 0 ? op.total : Infinity, op.started - 1));
      op.current = name;
    },
    emit(force = false) {
      const now = Date.now();
      if (!force && now - op.lastSent < 80) return;
      op.lastSent = now;
      let percent = op.percent;
      if (percent == null && op.totalBytes > 0) percent = Math.min(1, op.bytes / op.totalBytes);
      if (percent == null && op.total > 0) percent = Math.min(1, op.done / op.total);
      sendTo(sender, 'archive:progress', { opId: id, phase: op.phase, done: op.done, total: op.total, percent, current: op.current });
    },
  };
  ops.set(id, op);
  return op;
}
function endOp(op) {
  ops.delete(op.id);
}
function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {}
  }
  const t = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
    }
  }, 1500);
  t.unref?.();
}
function cancelOp(op) {
  op.canceled = true;
  for (const c of op.children) killTree(c);
}
function checkCanceled(op) {
  if (op?.canceled) throw err('The operation was canceled', 'ECANCELED');
}

/** Split a byte stream into "lines" on \n, \r and the backspaces 7-Zip uses to redraw its progress. */
function lineSplitter(onLine) {
  let buf = '';
  return {
    push(chunk) {
      buf += chunk.toString('utf8');
      const parts = buf.split(/[\r\n\x08]+/);
      buf = parts.pop();
      for (const p of parts) if (p.trim()) onLine(p);
    },
    end() {
      if (buf.trim()) onLine(buf);
      buf = '';
    },
  };
}

/**
 * Run a pipeline of tools. stages: [{ bin, args, cwd }]; stage i's stdout feeds stage i+1's stdin.
 * input: string written to the first stage's stdin, or inputFile: a file streamed into it (bytes counted
 * in op.bytes). The last stage's stdout goes to onOut(chunk), outFd (a file descriptor) or is ignored.
 * Resolves { codes, stderr: [text per stage], outText (when collect) }.
 */
function pipeline(op, stages, { input = null, inputFile = null, onOut = null, outFd = null, onErr = null, collect = false, timeout = 0 } = {}) {
  return new Promise((resolve, reject) => {
    // canceled between two steps of an operation: don't start the next tool at all
    if (op?.canceled) return reject(err('The operation was canceled', 'ECANCELED'));
    const children = [];
    const stderr = stages.map(() => '');
    const codes = stages.map(() => null);
    let outText = '';
    let closed = 0;
    let failed = null;
    let timer = null;
    for (let i = 0; i < stages.length; i++) {
      const s = stages[i];
      const last = i === stages.length - 1;
      let child;
      try {
        child = spawn(s.bin, s.args, {
          cwd: s.cwd,
          env: ENV,
          detached: true,
          stdio: ['pipe', last && outFd != null ? outFd : 'pipe', 'pipe'],
        });
      } catch (e) {
        failed = e;
        break;
      }
      children.push(child);
      running.add(child);
      op?.children.add(child);
      child.stdin.on('error', () => {});
      child.stdout?.on('error', () => {});
      child.stderr.on('data', (d) => {
        if (stderr[i].length < 256 * 1024) stderr[i] += d;
        onErr?.(d, i);
      });
      child.on('error', (e) => {
        failed = failed || e;
      });
      child.on('close', (code, signal) => {
        codes[i] = code == null ? (signal ? 128 : 1) : code;
        running.delete(child);
        op?.children.delete(child);
        if (++closed === children.length) {
          if (timer) clearTimeout(timer);
          if (op?.canceled) return reject(err('The operation was canceled', 'ECANCELED'));
          if (failed) return reject(failed.code === 'ENOENT' ? err(`${path.basename(s.bin)} is not installed`, 'ETOOL') : failed);
          resolve({ codes, stderr, outText });
        }
      });
    }
    if (failed && !children.length) return reject(failed);
    // wire the stages together
    for (let i = 0; i < children.length - 1; i++) children[i].stdout.pipe(children[i + 1].stdin);
    const lastChild = children[children.length - 1];
    if (lastChild.stdout) {
      lastChild.stdout.on('data', (d) => {
        if (collect && outText.length < 512 * 1024 * 1024) outText += d.toString('utf8');
        onOut?.(d);
      });
    }
    const first = children[0];
    if (inputFile) {
      const rs = fs.createReadStream(inputFile, { highWaterMark: 1 << 20 });
      rs.on('data', (c) => {
        if (op) {
          op.bytes += c.length;
          op.emit();
        }
      });
      rs.on('error', (e) => {
        failed = failed || e;
        first.stdin.destroy();
      });
      first.stdin.on('error', () => rs.destroy());
      rs.pipe(first.stdin);
    } else {
      first.stdin.end(input == null ? '' : input);
    }
    if (timeout) {
      timer = setTimeout(() => {
        failed = err('The operation timed out', 'ETIMEDOUT');
        for (const c of children) killTree(c);
      }, timeout);
    }
  });
}

// ------------------------------------------------------------------ 7-Zip output parsing
function parseSevenTime(v) {
  const m = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)(?:\.(\d+))?/.exec(v || '');
  if (!m) return null;
  const ms = m[7] ? Math.round(Number(`0.${m[7]}`) * 1000) : 0;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], ms);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}
const num = (v) => (v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/** Streaming parser for `7z l -slt`. */
function sltParser() {
  let section = 'pre';
  let props = {};
  let cur = null;
  const raws = [];
  let promptSeen = false;
  return {
    raws,
    get props() {
      return props;
    },
    get prompt() {
      return promptSeen;
    },
    line(l) {
      if (l.startsWith('Enter password')) promptSeen = true;
      if (l === '----------') {
        section = 'entries';
        cur = null;
        return;
      }
      if (l === '--' && section !== 'entries') {
        section = 'archive';
        props = {};
        return;
      }
      if (section === 'entries') {
        if (l === '') {
          if (cur && cur.Path !== undefined) raws.push(cur);
          cur = null;
          return;
        }
        const i = l.indexOf(' = ');
        if (i > 0) {
          (cur ||= {})[l.slice(0, i)] = l.slice(i + 3);
        } else if (/ =$/.test(l)) (cur ||= {})[l.slice(0, -2)] = '';
      } else if (section === 'archive') {
        const i = l.indexOf(' = ');
        if (i > 0) props[l.slice(0, i)] = l.slice(i + 3);
      }
    },
    end() {
      if (cur && cur.Path !== undefined) raws.push(cur);
      cur = null;
    },
  };
}
function entryFromSlt(r) {
  const attr = r.Attributes || '';
  const pm = parseModeString(r.Mode || attr);
  const dir = r.Folder === '+' || /^D/.test(attr) || pm?.type === 'd';
  const link = pm?.type === 'l' || !!r['Symbolic Link'];
  const tarLink = !!r['Symbolic Link'] || !!r['Hard Link'];
  return {
    raw: r.Path,
    dir,
    size: dir || tarLink ? 0 : num(r.Size) ?? 0,
    packed: r.Mode !== undefined ? null : num(r['Packed Size']), // tar: 7-Zip reports 512-byte blocks
    mtime: parseSevenTime(r.Modified),
    mode: pm ? pm.mode : dir ? 0o40755 : 0o100644,
    special: pm && 'cbps'.includes(pm.type) ? pm.type : null,
    encrypted: r.Encrypted === '+',
    link: link ? r['Symbolic Link'] || '' : null,
    hardlink: r['Hard Link'] || null,
    method: r.Method || '',
  };
}

/** `bsdtar -tv` line parser (used when 7-Zip is missing). */
function decodeBsdtarName(s) {
  const bytes = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) {
      const n = s[i + 1];
      if (/[0-7]/.test(n) && /^[0-7]{3}$/.test(s.slice(i + 1, i + 4))) {
        bytes.push(parseInt(s.slice(i + 1, i + 4), 8));
        i += 3;
        continue;
      }
      const map = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '\\': 92 };
      if (map[n] !== undefined) {
        bytes.push(map[n]);
        i++;
        continue;
      }
    }
    for (const b of Buffer.from(c, 'utf8')) bytes.push(b);
  }
  return Buffer.from(bytes).toString('utf8');
}
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
function entryFromBsdtar(line) {
  const m = /^([-dlcbpshD][-rwxsStT]{9})[+.@ ]?\s+\d+\s+\S+\s+\S+\s+(\d+|\d+,\s*\d+)\s+(\w{3})\s+(\d+)\s+(\d\d:\d\d|\d{4}) (.*)$/.exec(line);
  if (!m) return null;
  const pm = parseModeString(m[1]);
  let name = m[6];
  let link = null;
  let hardlink = null;
  if (pm.type === 'l') {
    const i = name.lastIndexOf(' -> ');
    if (i >= 0) {
      link = decodeBsdtarName(name.slice(i + 4));
      name = name.slice(0, i);
    }
  } else if (pm.type === 'h' || / link to /.test(name)) {
    const i = name.lastIndexOf(' link to ');
    if (i >= 0) {
      hardlink = decodeBsdtarName(name.slice(i + 9));
      name = name.slice(0, i);
    }
  }
  const now = new Date();
  let mtime = null;
  if (m[5].includes(':')) {
    const [hh, mm] = m[5].split(':').map(Number);
    let d = new Date(now.getFullYear(), MONTHS[m[3]] ?? 0, Number(m[4]), hh, mm);
    if (d - now > 86400000) d = new Date(now.getFullYear() - 1, MONTHS[m[3]] ?? 0, Number(m[4]), hh, mm);
    mtime = d.getTime();
  } else mtime = new Date(Number(m[5]), MONTHS[m[3]] ?? 0, Number(m[4])).getTime();
  const dir = pm.type === 'd' || pm.type === 'D';
  return {
    raw: decodeBsdtarName(name),
    dir,
    size: dir ? 0 : Number(String(m[2]).split(',')[0]) || 0,
    packed: null,
    mtime,
    mode: pm.mode,
    special: 'cbps'.includes(pm.type) ? pm.type : null,
    encrypted: false,
    link: pm.type === 'l' ? link || '' : null,
    hardlink,
    method: '',
  };
}

// 7-Zip messages -> error codes
function sevenError(text, { password, prompt } = {}) {
  const t = String(text || '');
  if (/Wrong password|Data Error in encrypted file|CRC Failed in encrypted file|Cannot open encrypted archive|Can not open encrypted archive/i.test(t)) {
    return password ? err('The password is incorrect', 'EBADPASSWORD') : err('A password is required', 'EPASSWORD');
  }
  if (prompt || /Enter password/.test(t)) return password ? err('The password is incorrect', 'EBADPASSWORD') : err('A password is required', 'EPASSWORD');
  if (/Can ?not open the file as archive|Is not archive|Can not open file as archive/i.test(t)) return err('This file is not an archive, or the format is not supported', 'EFORMAT');
  if (/Unsupported Method|Unsupported feature/i.test(t)) return err(`This archive uses a compression method that is not supported${firstError(t)}`, 'ENOTSUP');
  if (/There is not enough space|No space left/i.test(t)) return err('There is not enough space on the disk', 'ENOSPC');
  if (/Permission denied|Access is denied|Can ?not open output file|Read-only file system/i.test(t)) return err(`Access denied${firstError(t)}`, 'EACCES');
  // "cannot open file <path> errno=2" when the output folder can't be written (7-Zip prints it on 3 lines)
  if (/cannot open file/i.test(t) && /errno=(2|13|30)\b/.test(t)) return err('Cannot write to the destination folder', 'EACCES');
  if (/Data Error|CRC Failed|Headers Error|Unexpected end of (archive|data)|Unavailable data|There are data after the end|is not supported archive/i.test(t)) {
    return err(`The archive is damaged${firstError(t)}`, 'ECORRUPT');
  }
  return err(firstError(t).replace(/^: /, '') || '7-Zip failed', 'EARCHIVE');
}
function firstError(t) {
  const lines = String(t)
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter((l) => /^(ERROR|Error|WARNING|bsdtar:)|: (Error|Can|Cannot|Damaged|Truncated|Incorrect|Unrecognized|Path|Unsupported)/.test(l) && !/^Errors?: \d+$/.test(l));
  return lines.length ? `: ${lines.slice(0, 3).join(' · ').slice(0, 400)}` : '';
}
function bsdtarError(text) {
  const t = String(text || '');
  if (/passphrase|encrypt/i.test(t)) return err('Encrypted entries in this format are not supported', 'ENOTSUP');
  if (/Unrecognized archive format|not appear to be a/i.test(t)) return err('This file is not an archive, or the format is not supported', 'EFORMAT');
  if (/No space left/i.test(t)) return err('There is not enough space on the disk', 'ENOSPC');
  if (/Permission denied/i.test(t)) return err(`Access denied${firstError(t)}`, 'EACCES');
  if (/Truncated|Damaged|corrupt|Invalid|checksum|CRC|Premature end/i.test(t)) return err(`The archive is damaged${firstError(t)}`, 'ECORRUPT');
  return err(firstError(t).replace(/^: /, '') || 'bsdtar failed', 'EARCHIVE');
}

// ------------------------------------------------------------------ listing
const listCache = new Map(); // path -> { key, listing }

function canWrite(info, t) {
  if (info.kind === 'zip' || info.kind === '7z') return !!t.sz;
  if (info.kind === 'tar') return !!t.bsdtar;
  return false;
}

async function listArchive(file, { password = null, op = null } = {}) {
  const info = await detect(file);
  const key = `${info.size}|${info.mtime}`;
  const hit = listCache.get(file);
  if (hit && hit.key === key && (!hit.listing.headersEncrypted || hit.password === password)) return { info, listing: await withAccess(info, hit.listing) };
  const t = tools();
  const raws = [];
  let props = {};
  let truncated = false;
  let count = 0;
  const push = (e) => {
    count++;
    if (raws.length < MAX_ENTRIES) raws.push(e);
    else truncated = true;
  };
  let headersEncrypted = false;
  let damaged = null;
  if (info.kind === 'single') {
    let size = null;
    if (info.filter === 'gzip' && info.size >= 18) {
      const fh = await fsp.open(file, 'r');
      try {
        const b = Buffer.alloc(4);
        await fh.read(b, 0, 4, info.size - 4);
        size = b.readUInt32LE(0);
      } finally {
        await fh.close();
      }
    }
    const inner = info.name.replace(/\.(gz|xz|bz2|zst|lzma)$/i, '') || 'data';
    push({ raw: inner === info.name ? `${inner}.out` : inner, dir: false, size: size ?? 0, packed: info.size, mtime: info.mtime, mode: 0o100644, encrypted: false, link: null, hardlink: null, method: info.filter });
    props = { Type: info.filter };
  } else if (t.sz && info.kind !== 'tar') {
    const p = sltParser();
    // blank lines separate the records: split on '\n' only (no progress output with -bsp0)
    let buf = '';
    const res = await pipeline(op, [{ bin: t.sz, args: ['l', '-slt', '-bsp0', '-sccUTF-8', '--', file] }], {
      input: password != null ? `${password}\n` : '',
      onOut: (d) => {
        buf += d.toString('utf8');
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).replace(/\r$/, '');
          buf = buf.slice(i + 1);
          p.line(line);
          if (p.raws.length) {
            for (const r of p.raws.splice(0)) push(entryFromSlt(r));
          }
        }
      },
    });
    if (buf) p.line(buf);
    p.end();
    for (const r of p.raws.splice(0)) push(entryFromSlt(r));
    props = p.props;
    headersEncrypted = p.prompt;
    if (res.codes[0] !== 0) {
      const text = `${res.stderr[0]}`;
      const e = sevenError(text, { password, prompt: p.prompt && !count });
      // 7-Zip lists RAR/others it cannot fully decode; only fail when nothing was listed.
      if (!count || e.code === 'EPASSWORD' || e.code === 'EBADPASSWORD') throw e;
      if (e.code === 'ECORRUPT') damaged = e.message;
    }
  } else if (t.sz && info.kind === 'tar') {
    // a tar is listed by reading it whole: report progress by bytes (big .tar.xz can take a while)
    if (op) op.totalBytes = info.size;
    const p = sltParser();
    let buf = '';
    const stages = [];
    if (info.filter) stages.push({ bin: need(t.bsdcat, 'bsdcat'), args: [] });
    stages.push({ bin: t.sz, args: ['l', '-slt', '-bsp0', '-sccUTF-8', '-si', '-ttar'] });
    const res = await pipeline(op, stages, {
      inputFile: file,
      onOut: (d) => {
        buf += d.toString('utf8');
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          p.line(buf.slice(0, i).replace(/\r$/, ''));
          buf = buf.slice(i + 1);
          if (p.raws.length) for (const r of p.raws.splice(0)) push(entryFromSlt(r));
        }
      },
    });
    if (buf) p.line(buf);
    p.end();
    for (const r of p.raws.splice(0)) push(entryFromSlt(r));
    props = { ...p.props, Type: info.format };
    if (res.codes.some((c) => c !== 0)) {
      const e = info.filter && res.codes[0] !== 0 ? bsdtarError(res.stderr[0] || 'The archive is damaged') : sevenError(res.stderr[res.stderr.length - 1]);
      if (!count) throw e;
      damaged = e.message;
    }
  } else if (t.bsdtar) {
    // Fallback without 7-Zip: bsdtar -tv (minute precision dates, no packed sizes).
    let buf = '';
    const res = await pipeline(op, [{ bin: t.bsdtar, args: ['-tvf', file] }], {
      onOut: (d) => {
        buf += d.toString('utf8');
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const e = entryFromBsdtar(buf.slice(0, i));
          buf = buf.slice(i + 1);
          if (e) push(e);
        }
      },
    });
    if (buf) {
      const e = entryFromBsdtar(buf);
      if (e) push(e);
    }
    if (res.codes[0] !== 0) {
      if (!count) throw bsdtarError(res.stderr[0]);
      damaged = bsdtarError(res.stderr[0]).message;
    }
    props = { Type: info.format };
  } else {
    throw err('No archive tool is installed (7zip or libarchive-tools)', 'ETOOL');
  }

  // normalise, de-duplicate (last one wins, like extraction), classify unsafe entries
  const byPath = new Map();
  const unsafe = [];
  for (const r of raws) {
    // Zips made on Windows (Windows PowerShell's Compress-Archive…) use '\\' as the folder separator:
    // shown as folders, like Explorer and libarchive do ("..\\x" and "\\abs" are then caught as unsafe)
    const n = normEntry(info.kind === 'zip' ? r.raw.replace(/\\/g, '/') : r.raw);
    let reason = n.unsafe;
    if (!reason && r.special) reason = 'special';
    if (!reason && r.link != null && r.link !== '' && !linkInside(n.path, r.link)) reason = 'link';
    if (!reason && r.hardlink) {
      const hn = normEntry(r.hardlink);
      if (hn.unsafe) reason = 'link';
    }
    if (reason) {
      unsafe.push({ path: r.raw, reason, link: r.link || r.hardlink || null });
      continue;
    }
    if (!n.path) continue; // "./" root entry
    const name = n.path.slice(n.path.lastIndexOf('/') + 1);
    byPath.set(n.path, { ...r, path: n.path, name });
  }
  // A file stored under an unsafe link ("esc" -> /tmp, then "esc/x") is unsafe too.
  const unsafeLinks = new Set(unsafe.filter((u) => u.reason === 'link').map((u) => normEntry(info.kind === 'zip' ? u.path.replace(/\\/g, '/') : u.path).path).filter(Boolean));
  const underUnsafe = (p) => {
    if (!unsafeLinks.size) return false;
    for (let i = p.indexOf('/'); i > 0; i = p.indexOf('/', i + 1)) if (unsafeLinks.has(p.slice(0, i))) return true;
    return false;
  };
  const entries = [];
  for (const e of byPath.values()) {
    if (underUnsafe(e.path)) {
      unsafe.push({ path: e.raw, reason: 'link', link: null });
      continue;
    }
    entries.push(e);
  }
  let files = 0;
  let dirs = 0;
  let totalSize = 0;
  let totalPacked = 0;
  let perEntryPacked = false;
  let encrypted = false;
  for (const e of entries) {
    if (e.dir) dirs++;
    else {
      files++;
      totalSize += e.size || 0;
    }
    if (e.packed != null && !e.dir) {
      totalPacked += e.packed;
      if (info.kind !== 'tar' && info.kind !== 'single') perEntryPacked = true;
    }
    if (e.encrypted) encrypted = true;
  }
  if (info.kind === 'tar' || info.kind === 'single' || !perEntryPacked) totalPacked = info.size;
  const ratio = info.size > 0 ? totalSize / info.size : 0;
  let bomb = null;
  if (totalSize > BOMB_TOTAL) bomb = { reason: 'size', total: totalSize, ratio };
  else if (totalSize > BOMB_MIN && ratio > BOMB_RATIO) bomb = { reason: 'ratio', total: totalSize, ratio };
  const write = canWrite(info, t);
  const listing = {
    path: file,
    name: info.name,
    size: info.size,
    mtime: info.mtime,
    format: info.format,
    kind: info.kind,
    type: props.Type || info.format,
    method: props.Method || [...new Set(entries.filter((e) => !e.dir && e.method).map((e) => e.method.split(' ').pop()))].slice(0, 3).join(', '),
    solid: props.Solid === '+',
    blocks: num(props.Blocks),
    comment: props.Comment || '',
    physicalSize: num(props['Physical Size']) ?? info.size,
    entries,
    count,
    files,
    dirs,
    totalSize,
    totalPacked,
    perEntryPacked,
    truncated,
    encrypted: encrypted || headersEncrypted,
    headersEncrypted,
    unsafe,
    bomb,
    damaged,
    canAdd: write && !truncated && !damaged,
    canDelete: write && !truncated && !damaged,
    canEncrypt: !!t.sz && (info.kind === 'zip' || info.kind === '7z'),
  };
  if (listCache.size > 12) listCache.delete(listCache.keys().next().value);
  listCache.set(file, { key, listing, password: headersEncrypted ? password : null });
  return { info, listing: await withAccess(info, listing) };
}

/** Can this process rewrite the archive? (the file and its folder writable, the file not marked read-only:
 *  7-Zip refuses to update a file without write bits even as root). Checked on every listing, not cached. */
async function writable(info) {
  if (!(info.mode & 0o222)) return false;
  try {
    await fsp.access(info.file, fs.constants.W_OK);
    await fsp.access(path.dirname(info.file), fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}
/** The listing with canAdd / canDelete for the current permissions, and why it is read-only:
 *  readOnly = null | 'format' (rar, cab, single .gz…, or a missing tool) | 'damaged' | 'truncated' | 'perm'. */
async function withAccess(info, listing) {
  let readOnly = null;
  if (!canWrite(info, tools())) readOnly = 'format';
  else if (listing.damaged) readOnly = 'damaged';
  else if (listing.truncated) readOnly = 'truncated';
  else if (!(await writable(info))) readOnly = 'perm';
  return { ...listing, canAdd: !readOnly, canDelete: !readOnly, readOnly };
}

// ------------------------------------------------------------------ extraction
/** Entries (from the listing) selected by display paths: each path and everything below it. */
function selectEntries(listing, sel) {
  if (!sel) return listing.entries;
  const set = new Set(sel.map((s) => normEntry(s).path).filter(Boolean));
  const prefixes = [...set].map((s) => `${s}/`);
  return listing.entries.filter((e) => set.has(e.path) || prefixes.some((p) => e.path.startsWith(p)));
}

async function sanitizeTree(root, skipped) {
  const stack = [root];
  let files = 0;
  let dirsN = 0;
  let bytes = 0;
  while (stack.length) {
    const dir = stack.pop();
    let names;
    try {
      names = await fsp.readdir(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      const p = path.join(dir, n);
      let st;
      try {
        st = await fsp.lstat(p);
      } catch {
        continue;
      }
      const rel = path.relative(root, p);
      if (st.isSymbolicLink()) {
        let target = '';
        try {
          target = await fsp.readlink(p);
        } catch {}
        let ok = !path.isAbsolute(target) && isInside(root, path.resolve(path.dirname(p), target));
        if (ok) {
          try {
            ok = isInside(await fsp.realpath(root), await fsp.realpath(p));
          } catch (e) {
            ok = e.code === 'ENOENT'; // dangling link inside the folder: harmless
          }
        }
        if (!ok) {
          await fsp.unlink(p).catch(() => {});
          skipped.push({ path: rel, reason: 'link' });
        } else files++;
      } else if (st.isDirectory()) {
        dirsN++;
        await fsp.chmod(p, (st.mode & 0o777) | 0o700).catch(() => {});
        stack.push(p);
      } else if (st.isFile()) {
        files++;
        bytes += st.size;
        if (st.mode & 0o7000 || !(st.mode & 0o400)) await fsp.chmod(p, (st.mode & 0o777) | 0o400).catch(() => {});
      } else {
        await fsp.rm(p, { force: true }).catch(() => {});
        skipped.push({ path: rel, reason: 'special' });
      }
    }
  }
  return { files, dirs: dirsN, bytes };
}

/**
 * Defense in depth for "skip the unsafe items" (archives that HAVE unsafe entries only): the tools strip '/'
 * and '..' and write such entries inside the staging folder, and the exclusion list is a newline-separated
 * file that can't name an entry whose name holds a line break (7-Zip's listing can't even show it). So only
 * what the listing says is safe survives: anything else in the staging folder is removed (never following a
 * link) and reported as skipped.
 */
async function dropUnlisted(stage, listing, skipped) {
  const safe = new Set();
  for (const e of listing.entries) {
    for (let p = e.path; p; p = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '') safe.add(p);
  }
  const walk = async (dir, rel) => {
    let names;
    try {
      names = await fsp.readdir(dir);
    } catch {
      return;
    }
    for (const n of names) {
      const r = rel ? `${rel}/${n}` : n;
      const p = path.join(dir, n);
      if (!safe.has(r)) {
        await fsp.rm(p, { recursive: true, force: true }).catch(() => {}); // rm -r removes links, never follows them
        skipped.push({ path: r, reason: 'unsafe' });
        continue;
      }
      let st = null;
      try {
        st = await fsp.lstat(p);
      } catch {}
      if (st?.isDirectory()) await walk(p, r);
    }
  };
  await walk(stage, '');
}

async function moveInto(src, dst, policy, stats) {
  const sst = await fsp.lstat(src);
  let dstat = null;
  try {
    dstat = await fsp.lstat(dst);
  } catch {}
  if (!dstat) {
    await fsp.rename(src, dst);
    return dst;
  }
  if (sst.isDirectory() && dstat.isDirectory()) {
    for (const n of await fsp.readdir(src)) await moveInto(path.join(src, n), path.join(dst, n), policy, stats);
    return dst;
  }
  const sameKind = sst.isDirectory() === dstat.isDirectory();
  if (policy === 'skip') {
    stats.kept++;
    return null;
  }
  if (policy === 'replace' && sameKind) {
    await fsp.rm(dst, { recursive: true, force: true });
    await fsp.rename(src, dst);
    stats.replaced++;
    return dst;
  }
  const alt = await uniqueName(path.dirname(dst), path.basename(dst));
  await fsp.rename(src, alt);
  stats.renamed++;
  return alt;
}

async function freeSpace(dir) {
  try {
    const s = await fsp.statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return Infinity;
  }
}

/** Run the extraction tool for `targets` (listing entries) into `stage`. */
async function runExtract(op, info, listing, stage, { targets, all, password, skipped }) {
  const t = tools();
  op.total = targets.length;
  op.totalBytes = info.kind === 'tar' || info.kind === 'single' ? info.size : 0;
  op.emit(true);
  const unsafeRaw = listing.unsafe.map((u) => u.path);
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'aurora-arc-lst-'));
  op.cleanup.push(() => fsp.rm(tmp, { recursive: true, force: true }));
  // libarchive for RAR (7zip in Debian has no RAR decoder), without 7-Zip, and for unencrypted zips that
  // hold symlinks: 7-Zip drops every relative link containing '..' even when it stays inside the folder,
  // while bsdtar recreates them and refuses to write through any link (escaping ones are removed after).
  const zipLinks = info.kind === 'zip' && t.bsdtar && listing.entries.some((e) => e.link != null) && !listing.encrypted;
  // 7-Zip would write "dir\\file.txt" as one file name; libarchive turns the '\\' into folders
  const zipBackslash = info.kind === 'zip' && t.bsdtar && !listing.encrypted && [...listing.entries, ...listing.unsafe].some((e) => (e.raw ?? e.path).includes('\\'));
  const useBsdtar = info.kind === 'rar' || !t.sz || zipLinks || zipBackslash;
  if (info.kind === 'single') {
    const name = targets[0]?.raw || 'data';
    const fd = fs.openSync(path.join(stage, name), 'wx', 0o644);
    try {
      op.current = name;
      const res = await pipeline(op, [{ bin: need(t.bsdcat, 'bsdcat'), args: [] }], { inputFile: info.file, outFd: fd });
      if (res.codes[0] !== 0) throw bsdtarError(res.stderr[0]);
      op.done = 1;
    } finally {
      fs.closeSync(fd);
    }
    return;
  }
  if (!useBsdtar) {
    const args = ['x', '-y', '-bsp1', '-bb1', '-bso1', '-bse2', '-sccUTF-8', '-scsUTF-8', '-spd'];
    if (info.kind === 'tar') args.push('-snld', '-si', '-ttar'); // tar link targets were checked in the listing
    if (unsafeRaw.length) {
      const lst = path.join(tmp, 'exclude.lst');
      await fsp.writeFile(lst, unsafeRaw.join('\n') + '\n', { mode: 0o600 });
      args.push(`-x@${lst}`);
    }
    // No '--' here: 7-Zip would read "@list" after it as a file name. The archive path is absolute, so it
    // can never be taken for a switch.
    if (info.kind !== 'tar') args.push(info.file);
    if (!all) {
      const lst = path.join(tmp, 'include.lst');
      await fsp.writeFile(lst, targets.map((e) => e.raw).join('\n') + '\n', { mode: 0o600 });
      args.push(`@${lst}`);
    }
    const stages = [];
    if (info.kind === 'tar' && info.filter) stages.push({ bin: need(t.bsdcat, 'bsdcat'), args: [] });
    stages.push({ bin: t.sz, args, cwd: stage });
    const dangerous = [];
    const split = lineSplitter((l) => {
      const m = /^\s*(\d+)%/.exec(l);
      if (m && info.kind !== 'tar') op.percent = Number(m[1]) / 100;
      const f = /^- (.+)$/.exec(l);
      if (f) op.tick(f[1]);
      op.emit();
    });
    const errSplit = lineSplitter((l) => {
      const d = /Dangerous (?:symbolic )?link path was ignored : (.+?) : /.exec(l);
      if (d) dangerous.push(d[1]);
    });
    const res = await pipeline(op, stages, {
      inputFile: info.kind === 'tar' ? info.file : null,
      input: info.kind === 'tar' ? null : password != null ? `${password}\n${password}\n` : '',
      onOut: (d) => split.push(d),
      onErr: (d, i) => i === stages.length - 1 && errSplit.push(d),
    });
    split.end();
    errSplit.end();
    for (const d of dangerous) skipped.push({ path: d, reason: 'link' });
    const last = res.codes[res.codes.length - 1];
    if (info.kind === 'tar' && info.filter && res.codes[0] !== 0) throw bsdtarError(res.stderr[0]);
    if (last !== 0) {
      const text = res.stderr[res.stderr.length - 1];
      const onlyLinks = dangerous.length && !String(text).split(/\n/).some((l) => /^ERROR/.test(l) && !/Dangerous/.test(l));
      if (!onlyLinks) {
        const e = sevenError(text, { password });
        // RAR-like methods 7-Zip cannot decode: try libarchive.
        if (e.code === 'ENOTSUP' && t.bsdtar) return runBsdtarExtract(op, info, stage, { targets, all, unsafeRaw, tmp, password, skipped });
        throw e;
      }
    }
    return;
  }
  return runBsdtarExtract(op, info, stage, { targets, all, unsafeRaw, tmp, password, skipped });
}

async function runBsdtarExtract(op, info, stage, { targets, all, unsafeRaw, tmp, skipped = [] }) {
  const t = tools();
  const args = ['-x', '-v', '--no-same-owner', '--no-same-permissions', '-f', info.file, '-C', stage];
  // libarchive names zip entries with '/' only (see zipBackslash)
  const bsdName = (raw) => (info.kind === 'zip' ? raw.replace(/\\/g, '/') : raw);
  for (const u of unsafeRaw) {
    const r = breEscape(bsdName(u));
    args.push('-s', `,^${r}$,,rHS`, '-s', `,^${r}/.*$,,rHS`);
  }
  if (!all) {
    const lst = path.join(tmp, 'include.lst');
    await fsp.writeFile(lst, targets.map((e) => `${globEscape(bsdName(e.raw))}\n`).join(''), { mode: 0o600 });
    args.push('-T', lst);
  }
  op.percent = null;
  const split = lineSplitter((l) => {
    const m = /^x (.+)$/.exec(l);
    if (m) {
      op.tick(m[1]);
      op.emit();
    }
  });
  const refused = [];
  const res = await pipeline(op, [{ bin: need(t.bsdtar, 'bsdtar'), args }], {
    onErr: (d) => {
      split.push(d);
    },
  });
  split.end();
  if (res.codes[0] !== 0) {
    // libarchive's own guards (writing through a symlink, '..' in a path) are expected refusals: report
    // them as skipped items. Anything else is a real failure.
    const lines = res.stderr[0].split('\n').map((l) => l.trim()).filter(Boolean);
    let fatal = false;
    for (const l of lines) {
      let m;
      if ((m = /^(?:x )?(.+?): Cannot extract through symlink/.exec(l))) refused.push({ path: m[1], reason: 'link' });
      else if ((m = /^(?:x )?(.+?): Path contains '\.\.'/.exec(l))) refused.push({ path: m[1], reason: 'parent' });
      else if ((m = /^(?:x )?(.+?): Hard-link target .* (does not exist|contains)/.exec(l))) refused.push({ path: m[1], reason: 'link' });
      else if (/^x /.test(l) || /Removing leading '\/'/.test(l) || /Error exit delayed/.test(l)) continue;
      else fatal = true;
    }
    if (fatal || !refused.length) throw bsdtarError(res.stderr[0]);
    skipped.push(...refused);
  }
}

async function doExtract(op, file, dest, opts = {}) {
  const { info, listing } = await listArchive(file, { password: opts.password ?? null, op });
  checkCanceled(op);
  const sel = Array.isArray(opts.entries) && opts.entries.length ? opts.entries.map(String) : null;
  const targets = selectEntries(listing, sel);
  if (sel && !targets.length) throw err('The selected items are not in the archive', 'ENOENTRY');
  const skipped = [];
  if (listing.unsafe.length && !sel && !opts.skipUnsafe) {
    throw err(`This archive contains ${listing.unsafe.length} item(s) that would be written outside the destination folder`, 'EUNSAFE');
  }
  if (!sel) for (const u of listing.unsafe) skipped.push({ path: u.path, reason: u.reason });
  const total = targets.reduce((s, e) => s + (e.dir ? 0 : e.size || 0), 0);
  if (!opts.allowBomb) {
    const ratio = info.size > 0 ? listing.totalSize / info.size : 0;
    if (total > BOMB_TOTAL || (total > BOMB_MIN && ratio > BOMB_RATIO)) {
      throw err(`Extracting would write ${total} bytes (${Math.round(ratio)}x the archive size)`, 'EBOMB');
    }
  }
  if (targets.some((e) => e.encrypted) && opts.password == null) throw err('A password is required', 'EPASSWORD');
  if (info.kind === 'rar' && targets.some((e) => e.encrypted)) throw err('Encrypted RAR archives are not supported', 'ENOTSUP');
  // destination
  checkCanceled(op);
  try {
    await mkdirp(dest);
  } catch (e) {
    if (e.code === 'ENOTDIR') throw err('The destination is not a folder', 'EINVAL');
    throw err(`Cannot create the destination folder: ${e.message}`, 'EACCES');
  }
  const dst = await fsp.stat(dest);
  if (!dst.isDirectory()) throw err('The destination is not a folder', 'EINVAL');
  // The staging folder first: a folder that can't be written to (read-only, /proc, /sys…) is reported as
  // such, not as a full disk (pseudo file systems report 0 bytes free).
  let stage;
  try {
    stage = await fsp.mkdtemp(path.join(dest, '.aurora-extract-'));
  } catch (e) {
    throw err(`Cannot write to the destination folder: ${e.message}`, e.code === 'ENOSPC' ? 'ENOSPC' : 'EACCES');
  }
  await fsp.chmod(stage, 0o700).catch(() => {});
  if (total > (await freeSpace(dest))) {
    await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
    throw err('There is not enough space on the disk', 'ENOSPC');
  }
  let flat = null;
  try {
    await runExtract(op, info, listing, stage, { targets, all: !sel, password: opts.password ?? null, skipped });
    checkCanceled(op);
    if (!sel && listing.unsafe.length) await dropUnlisted(stage, listing, skipped);
    op.phase = 'finishing';
    op.percent = 1;
    op.emit(true);
    // What goes where: every selected item lands in the destination under its own name (an item shown in
    // a sub-folder of the archive, or found by a search, is extracted without its parent folders), or the
    // whole tree when extracting everything. The selected items are first laid out exactly as they will
    // end up (in a second staging folder) and only THEN checked: a link that stays inside the archive's
    // tree ("a/b/c/x -> ../../../y") can point far outside once its parent folders are dropped
    // ("dest/x -> ../../../y").
    let root = stage;
    let order = null; // the selected items, in selection order
    if (sel) {
      order = [];
      flat = await fsp.mkdtemp(path.join(dest, '.aurora-extract-'));
      await fsp.chmod(flat, 0o700).catch(() => {});
      for (const s of [...new Set(sel.map((x) => normEntry(x).path).filter(Boolean))]) {
        const src = path.join(stage, ...s.split('/'));
        if (!isInside(stage, src) || src === stage || !(await exists(src))) continue;
        // two selected items with the same name (search results from several folders): "name (2).ext"
        const to = await uniqueName(flat, path.basename(src));
        await fsp.rename(src, to);
        order.push(path.basename(to));
      }
      root = flat;
    }
    const sum = await sanitizeTree(root, skipped);
    checkCanceled(op);
    // From here on the result is moved into place (renames): too late to cancel, the operation completes.
    op.committed = true;
    const srcs = (order || (await fsp.readdir(root))).map((n) => path.join(root, n)).filter(present); // links removed by the check are gone
    const stats = { renamed: 0, replaced: 0, kept: 0 };
    const items = [];
    const policy = ['rename', 'replace', 'skip'].includes(opts.overwrite) ? opts.overwrite : 'rename';
    for (const src of srcs) {
      const out = await moveInto(src, path.join(dest, path.basename(src)), policy, stats);
      if (out) items.push(out);
    }
    return { dest, items, files: sum.files, dirs: sum.dirs, bytes: sum.bytes, skipped, ...stats };
  } finally {
    await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
    if (flat) await fsp.rm(flat, { recursive: true, force: true }).catch(() => {});
  }
}

/** The target of a link entry of a zip / 7z archive (stored as the entry's data; 7-Zip's listing omits it). */
async function linkTargetOf(op, info, entry, password) {
  const t = tools();
  if (!t.sz || (info.kind !== 'zip' && info.kind !== '7z')) return '';
  if (entry.encrypted && password == null) throw err('A password is required', 'EPASSWORD');
  let out = Buffer.alloc(0);
  const res = await pipeline(op, [{ bin: t.sz, args: ['x', '-so', '-bd', '-sccUTF-8', '-spd', info.file, entry.raw] }], {
    input: password != null ? `${password}\n` : '',
    onOut: (d) => {
      if (out.length < 4096) out = Buffer.concat([out, d]);
    },
  });
  if (res.codes[0] !== 0) throw sevenError(res.stderr[0], { password });
  return out.subarray(0, 4096).toString('utf8').replace(/\0[\s\S]*$/, '');
}

// ------------------------------------------------------------------ temp folders (preview / copy)
let tmpRoot = null;
function tempRoot() {
  if (!tmpRoot) tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-archive-'));
  fs.chmodSync(tmpRoot, 0o700);
  return tmpRoot;
}
function sessionDir(session) {
  const s = String(session || 'default');
  if (!/^[\w.-]{1,64}$/.test(s) || s.startsWith('.')) throw err('Invalid session', 'EINVAL');
  const d = path.join(tempRoot(), s);
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

// ------------------------------------------------------------------ creation / update
async function countTree(paths, limit = 500000) {
  let n = 0;
  let bytes = 0;
  const stack = [...paths];
  const t0 = Date.now();
  while (stack.length && n < limit && Date.now() - t0 < 4000) {
    const p = stack.pop();
    let st;
    try {
      st = await fsp.lstat(p);
    } catch {
      continue;
    }
    n++;
    if (st.isDirectory()) {
      try {
        for (const c of await fsp.readdir(p)) stack.push(path.join(p, c));
      } catch {}
    } else bytes += st.size;
  }
  return { count: stack.length ? 0 : n, bytes };
}
const LEVELS = { gzip: (l) => Math.max(1, Math.min(9, l)), xz: (l) => Math.max(0, Math.min(9, l)), bzip2: (l) => Math.max(1, Math.min(9, l)), zstd: (l) => [1, 1, 2, 3, 5, 7, 10, 15, 17, 19][Math.max(0, Math.min(9, l))] };

function tarOperand(name) {
  // bsdtar treats operands starting with '-C' (chdir) or '@' (archive inclusion) specially.
  return /^[-@]/.test(name) ? `./${name}` : name;
}
/** Absolute paths grouped by their folder: Map folder -> [names]. */
function groupByFolder(paths) {
  const groups = new Map();
  for (const p of paths) {
    const d = path.dirname(p);
    if (!groups.has(d)) groups.set(d, []);
    groups.get(d).push(path.basename(p));
  }
  return groups;
}
/**
 * A copy of `src` at `dst` for 7-Zip to read: hard links for files (a real copy across file systems),
 * real folders, links recreated as links (stored as links with -snl, never followed). Devices, FIFOs and
 * sockets are left out (7-Zip skips them too).
 */
async function mirror(op, src, dst) {
  checkCanceled(op);
  const st = await fsp.lstat(src);
  if (st.isSymbolicLink()) {
    await fsp.symlink(await fsp.readlink(src), dst);
  } else if (st.isDirectory()) {
    await fsp.mkdir(dst, { mode: 0o700 });
    for (const n of await fsp.readdir(src)) await mirror(op, path.join(src, n), path.join(dst, n));
    await fsp.chmod(dst, (st.mode & 0o777) | 0o700).catch(() => {});
    await fsp.utimes(dst, st.atime, st.mtime).catch(() => {});
  } else if (st.isFile()) {
    try {
      await fsp.link(src, dst);
    } catch {
      await fsp.copyFile(src, dst, fs.constants.COPYFILE_FICLONE);
      await fsp.chmod(dst, st.mode & 0o777).catch(() => {});
      await fsp.utimes(dst, st.atime, st.mtime).catch(() => {});
    }
  }
}

async function sevenProgress(op, args, { input, cwd }) {
  const t = tools();
  const split = lineSplitter((l) => {
    const m = /^\s*(\d+)%/.exec(l);
    if (m) op.percent = Number(m[1]) / 100;
    const f = /^([-+U=RTD]) (.+)$/.exec(l);
    if (f) op.tick(f[2]);
    op.emit();
  });
  const res = await pipeline(op, [{ bin: need(t.sz, '7-Zip'), args, cwd }], { input, onOut: (d) => split.push(d) });
  split.end();
  return res;
}

async function doCreate(op, srcPaths, destPath, opts) {
  const t = tools();
  const format = CREATE_FORMATS.includes(opts.format) ? opts.format : 'zip';
  const level = Math.max(0, Math.min(9, Number.isFinite(Number(opts.level)) ? Number(opts.level) : 5));
  const password = opts.password ? String(opts.password) : null;
  if (password && /[\r\n\0]/.test(password)) throw err('The password cannot contain line breaks', 'EINVAL');
  if (password && !(format === 'zip' || format === '7z')) throw err('Only ZIP and 7z archives can be encrypted', 'ENOTSUP');
  // 7-Zip's ZIP AES encoder only takes printable ASCII passwords (7z archives accept any Unicode).
  if (password && format === 'zip' && !/^[\x20-\x7e]+$/.test(password)) throw err('ZIP passwords can only contain ASCII letters, digits and symbols', 'EZIPPASSWORD');
  for (const s of srcPaths) {
    if (!(await exists(s))) throw err(`Item not found: ${s}`, 'ENOITEM');
    if (s === destPath) throw err('An archive cannot contain itself', 'EINVAL');
  }
  const dir = path.dirname(destPath);
  const dst = await fsp.stat(dir).catch(() => null);
  if (!dst?.isDirectory()) throw err('The destination folder does not exist', 'ENODEST');
  if ((await fsp.lstat(destPath).catch(() => null))?.isDirectory()) throw err('A folder with this name already exists', 'EEXIST');
  const ext = format === 'zip' ? '.zip' : format === '7z' ? '.7z' : `.${format}`;
  // The output is written next to the destination (atomic rename at the end), or in a private temp
  // folder when the destination lies inside one of the folders being compressed.
  const insideSrc = srcPaths.some((s) => isInside(s, destPath));
  const workDir = insideSrc ? await fsp.mkdtemp(path.join(os.tmpdir(), 'aurora-arc-new-')) : dir;
  const tmpOut = path.join(workDir, `.aurora-new-${crypto.randomBytes(5).toString('hex')}${ext}`);
  op.cleanup.push(() => fsp.rm(tmpOut, { force: true }));
  if (insideSrc) op.cleanup.push(() => fsp.rm(workDir, { recursive: true, force: true }));
  // Can the archive be written there at all? (a clear "access denied" instead of a tool error later)
  for (const d of new Set([workDir, dir])) {
    const probe = path.join(d, `.aurora-probe-${crypto.randomBytes(4).toString('hex')}`);
    try {
      await (await fsp.open(probe, 'wx', 0o600)).close();
      await fsp.unlink(probe).catch(() => {});
    } catch (e) {
      throw err(`Cannot write to the destination folder: ${e.message}`, e.code === 'ENOSPC' ? 'ENOSPC' : 'EACCES');
    }
  }
  const counted = await countTree(srcPaths);
  op.total = counted.count;
  op.emit(true);
  checkCanceled(op);
  if ((format === 'zip' || format === '7z') && t.sz) {
    // -snl: symbolic links are stored as links, never followed (a link to "..", "/" or a home folder would
    // otherwise pull the whole tree in, again and again, or put private files in the archive)
    const args = ['a', `-t${format}`, `-mx=${level}`, '-snl', '-bsp1', '-bb1', '-bso1', '-bse2', '-sccUTF-8', '-scsUTF-8', '-spd', '-y'];
    if (password) {
      args.push('-p');
      if (format === 'zip') args.push('-mem=AES256');
      else if (opts.encryptNames) args.push('-mhe=on');
    }
    args.push('--', tmpOut, ...srcPaths);
    const res = await sevenProgress(op, args, { input: password ? `${password}\n${password}\n` : '' });
    if (res.codes[0] !== 0 && res.codes[0] !== 1) throw sevenError(res.stderr[0]);
  } else {
    if (password) throw err('7-Zip is required to create encrypted archives', 'ETOOL');
    const args = ['-c', '-v', '-f', tmpOut];
    if (format === 'zip') args.push('--format', 'zip', '--options', `zip:compression=${level === 0 ? 'store' : 'deflate'}`);
    else if (format === '7z') args.push('--format', '7zip');
    else {
      args.push('--format', 'pax');
      const filter = TAR_FILTER[format];
      if (filter) args.push(TAR_FLAG[filter], '--options', `${filter}:compression-level=${LEVELS[filter](level)}`);
    }
    for (const s of srcPaths) args.push('-C', path.dirname(s), tarOperand(path.basename(s)));
    const split = lineSplitter((l) => {
      const m = /^a (.+)$/.exec(l);
      if (m) {
        op.tick(m[1]);
        op.emit();
      }
    });
    const res = await pipeline(op, [{ bin: need(t.bsdtar, 'bsdtar'), args }], { onErr: (d) => split.push(d) });
    split.end();
    if (res.codes[0] !== 0) throw bsdtarError(res.stderr[0]);
  }
  checkCanceled(op);
  await fsp.chmod(tmpOut, 0o644).catch(() => {});
  try {
    await fsp.rename(tmpOut, destPath);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    await fsp.copyFile(tmpOut, destPath);
  }
  const st = await fsp.stat(destPath);
  return { path: destPath, size: st.size };
}

const locks = new Map();
async function withLock(file, fn) {
  const prev = locks.get(file) || Promise.resolve();
  let release;
  const mine = new Promise((r) => (release = r));
  locks.set(file, prev.then(() => mine));
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(file) === mine) locks.delete(file);
  }
}

/** bsdtar rewrite of a tar family archive: copy every kept entry (@archive) plus new files. */
async function rewriteTar(op, info, listing, { exclude = [], addBase = null, addPaths = [] }) {
  const t = tools();
  const bsdtar = need(t.bsdtar, 'bsdtar');
  const dir = path.dirname(info.file);
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'aurora-arc-upd-'));
  op.cleanup.push(() => fsp.rm(tmp, { recursive: true, force: true }));
  const filter = info.filter;
  const outTmp = path.join(dir, `.${path.basename(info.file)}.aurora-${crypto.randomBytes(4).toString('hex')}`);
  op.cleanup.push(() => fsp.rm(outTmp, { force: true }));
  const fmt = ['--format', 'pax'];
  const comp = filter ? [TAR_FLAG[filter]] : [];
  let source = info.file;
  op.total = listing.count + (addPaths.length ? (await countTree(addPaths)).count : 0);
  const split = lineSplitter((l) => {
    const m = /^a (.+)$/.exec(l);
    if (m) {
      op.tick(m[1]);
      op.emit();
    }
  });
  if (exclude.length) {
    const lst = path.join(tmp, 'exclude.lst');
    await fsp.writeFile(lst, exclude.map((x) => `^${globEscape(x)}\n`).join(''), { mode: 0o600 });
    const pass1 = addPaths.length ? path.join(tmp, 'pass1.tar') : outTmp;
    const args = ['-c', '-v', '-f', pass1, ...fmt, ...(addPaths.length ? [] : comp), '-X', lst, `@${source}`];
    const res = await pipeline(op, [{ bin: bsdtar, args }], { onErr: (d) => split.push(d) });
    if (res.codes[0] !== 0) throw bsdtarError(res.stderr[0]);
    source = pass1;
  }
  if (addPaths.length) {
    // The items are read from their own folder (-C <folder> <name>), so links inside them are stored as links
    // (never followed). Into a sub-folder of the archive: a staging folder where <base> is a link to that
    // folder, read as "<base>/<name>" (only that path component is followed).
    const groupArgs = [];
    let gi = 0;
    for (const [folder, names] of groupByFolder(addPaths)) {
      let cdir = folder;
      let prefix = '';
      if (addBase) {
        const parts = addBase.split('/');
        cdir = path.join(tmp, `g${gi++}`);
        await fsp.mkdir(path.join(cdir, ...parts.slice(0, -1)), { recursive: true });
        await fsp.symlink(folder, path.join(cdir, ...parts));
        prefix = `${addBase}/`;
      }
      groupArgs.push('-C', cdir, ...names.map((n) => tarOperand(prefix + n)));
    }
    const args = ['-c', '-v', '-f', outTmp, ...fmt, ...comp, `@${source}`, ...groupArgs];
    const res = await pipeline(op, [{ bin: bsdtar, args, cwd: tmp }], { onErr: (d) => split.push(d) });
    if (res.codes[0] !== 0) throw bsdtarError(res.stderr[0]);
  }
  split.end();
  checkCanceled(op);
  const st = await fsp.stat(info.file);
  await fsp.chmod(outTmp, st.mode & 0o777).catch(() => {});
  await fsp.rename(outTmp, info.file);
}

async function doAdd(op, file, srcPaths, opts) {
  const { info, listing } = await listArchive(file, { password: opts.password ?? null, op });
  if (listing.readOnly === 'perm') throw err('You do not have permission to change this archive', 'EACCES');
  if (!listing.canAdd) throw err('Files cannot be added to this type of archive', 'ENOTSUP');
  const nb = normEntry(String(opts.base || ''));
  if (nb.unsafe) throw err('Invalid folder in the archive', 'EINVAL'); // "../..": would leave the staging folder
  const base = nb.path;
  for (const s of srcPaths) {
    if (!(await exists(s))) throw err(`Item not found: ${s}`, 'ENOITEM');
    if (s === file || isInside(s, file)) throw err('An archive cannot contain itself', 'EINVAL');
  }
  const names = srcPaths.map((s) => path.basename(s));
  if (new Set(names).size !== names.length) throw err('Two of the items have the same name', 'EINVAL');
  const t = tools();
  const counted = await countTree(srcPaths);
  op.total = counted.count;
  op.emit(true);
  if (info.kind === 'zip' || info.kind === '7z') {
    if (listing.encrypted && opts.password == null) throw err('A password is required', 'EPASSWORD');
    // -snl: links inside the added folders are stored as links, never followed (see doCreate). 7-Zip stores
    // relative operands as given and can't go through a linked folder with -snl, so:
    //  - into the archive's root: run from each item's own folder with its bare name;
    //  - into a sub-folder: a staging copy laid out as <base>/<name> (hard links where possible).
    const runs = [];
    if (!base) {
      for (const [folder, names] of groupByFolder(srcPaths)) runs.push({ cwd: folder, operands: names.map((n) => `./${n}`) });
    } else {
      const stage = await fsp.mkdtemp(path.join(path.dirname(file), '.aurora-add-')).catch(() => fsp.mkdtemp(path.join(os.tmpdir(), 'aurora-arc-add-')));
      op.cleanup.push(() => fsp.rm(stage, { recursive: true, force: true }));
      await fsp.chmod(stage, 0o700).catch(() => {});
      const baseDir = path.join(stage, ...base.split('/'));
      await fsp.mkdir(baseDir, { recursive: true });
      for (const s of srcPaths) await mirror(op, s, path.join(baseDir, path.basename(s)));
      runs.push({ cwd: stage, operands: srcPaths.map((s) => `${base}/${path.basename(s)}`) });
    }
    const args = ['a', `-t${info.kind}`, '-snl', '-bsp1', '-bb1', '-bso1', '-bse2', '-sccUTF-8', '-scsUTF-8', '-spd', '-y'];
    if (opts.password != null && listing.encrypted) {
      args.push('-p');
      if (info.kind === 'zip') args.push('-mem=AES256');
      else if (listing.headersEncrypted) args.push('-mhe=on');
    }
    for (const r of runs) {
      const res = await sevenProgress(op, [...args, '--', file, ...r.operands], { input: opts.password != null ? `${opts.password}\n${opts.password}\n` : '', cwd: r.cwd });
      if (res.codes[0] !== 0 && res.codes[0] !== 1) throw sevenError(res.stderr[0], { password: opts.password });
    }
  } else {
    const exclude = [];
    for (const n of names) {
      const p = base ? `${base}/${n}` : n;
      if (listing.entries.some((e) => e.path === p || e.path.startsWith(`${p}/`))) exclude.push(p);
    }
    await rewriteTar(op, info, listing, { exclude, addBase: base || null, addPaths: srcPaths });
  }
  listCache.delete(file);
  return { added: srcPaths.length };
}

async function doDelete(op, file, entries, opts) {
  const { info, listing } = await listArchive(file, { password: opts.password ?? null, op });
  if (listing.readOnly === 'perm') throw err('You do not have permission to change this archive', 'EACCES');
  if (!listing.canDelete) throw err('Items cannot be deleted from this type of archive', 'ENOTSUP');
  const sel = [...new Set(entries.map((s) => normEntry(String(s)).path).filter(Boolean))];
  const targets = selectEntries(listing, sel);
  if (!targets.length) throw err('The selected items are not in the archive', 'ENOENTRY');
  op.total = targets.length;
  op.emit(true);
  if (info.kind === 'zip' || info.kind === '7z') {
    if (listing.headersEncrypted && opts.password == null) throw err('A password is required', 'EPASSWORD');
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'aurora-arc-del-'));
    op.cleanup.push(() => fsp.rm(tmp, { recursive: true, force: true }));
    const lst = path.join(tmp, 'delete.lst');
    // the raw names of every selected entry (folders: their children too, implicit folders have none)
    await fsp.writeFile(lst, targets.map((e) => e.raw).join('\n') + '\n', { mode: 0o600 });
    const args = ['d', '-bsp1', '-bb1', '-bso1', '-bse2', '-sccUTF-8', '-scsUTF-8', '-spd', '-y'];
    if (listing.headersEncrypted) args.push('-p', '-mhe=on');
    args.push(file, `@${lst}`); // absolute archive path; no '--' (it would turn "@list" into a file name)
    const res = await sevenProgress(op, args, { input: opts.password != null ? `${opts.password}\n${opts.password}\n` : '' });
    if (res.codes[0] !== 0 && res.codes[0] !== 1) throw sevenError(res.stderr[0], { password: opts.password });
  } else {
    await rewriteTar(op, info, listing, { exclude: sel });
  }
  listCache.delete(file);
  return { deleted: targets.length };
}

async function doTest(op, file, opts) {
  let info;
  let listing;
  try {
    ({ info, listing } = await listArchive(file, { password: opts.password ?? null, op }));
  } catch (e) {
    if (e.code === 'ECORRUPT') return { ok: false, errors: [e.message], files: 0 };
    throw e;
  }
  const t = tools();
  if (listing.encrypted && opts.password == null && (info.kind === 'zip' || info.kind === '7z')) throw err('A password is required', 'EPASSWORD');
  op.total = listing.files;
  op.emit(true);
  const errors = [];
  if (info.kind === 'single' || (info.kind === 'tar' && (!t.sz || info.filter))) {
    // decompress everything (checks the gzip/xz/zstd/bzip2 checksums), then read the tar stream
    op.totalBytes = info.size;
    const stages = [];
    if (info.filter) stages.push({ bin: need(t.bsdcat, 'bsdcat'), args: [] });
    if (info.kind === 'tar') stages.push(t.sz ? { bin: t.sz, args: ['t', '-bsp0', '-bb1', '-bso1', '-bse2', '-si', '-ttar'] } : { bin: need(t.bsdtar, 'bsdtar'), args: ['-tf', '-'] });
    const res = await pipeline(op, stages, { inputFile: file, onOut: () => {} });
    res.codes.forEach((c, i) => {
      if (c !== 0) errors.push(firstError(res.stderr[i]).replace(/^: /, '') || res.stderr[i].trim().split('\n').pop() || `exit ${c}`);
    });
  } else if (info.kind === 'rar' || !t.sz) {
    const split = lineSplitter((l) => {
      const m = /^x (.+)$/.exec(l);
      if (m) {
        op.tick(m[1]);
        op.emit();
      }
    });
    const res = await pipeline(op, [{ bin: need(t.bsdtar, 'bsdtar'), args: ['-x', '-v', '-O', '-f', file] }], { onErr: (d) => split.push(d), onOut: () => {} });
    split.end();
    if (res.codes[0] !== 0) errors.push(...res.stderr[0].split('\n').filter((l) => l.trim() && !/^x /.test(l)).slice(0, 20));
  } else {
    const args = ['t', '-bsp1', '-bb1', '-bso1', '-bse2', '-sccUTF-8', '-spd', '--', file];
    const res = await sevenProgress(op, args, { input: opts.password != null ? `${opts.password}\n` : '' });
    if (res.codes[0] !== 0) {
      const e = sevenError(res.stderr[0], { password: opts.password });
      if (e.code === 'EPASSWORD' || e.code === 'EBADPASSWORD') throw e;
      errors.push(...res.stderr[0].split('\n').filter((l) => /ERROR|Error|error/.test(l) && !/^Errors?: \d+|Sub items Errors|Archives with Errors/.test(l)).slice(0, 20));
      if (!errors.length) errors.push(e.message);
    }
  }
  checkCanceled(op);
  return { ok: errors.length === 0, errors, files: listing.files };
}

// ------------------------------------------------------------------ registration
module.exports = function register(api) {
  // session: the window's temp-folder session for operations that write there (preview, extractTemp), so
  // archive:cleanup can stop them before deleting the folder.
  const run = (opts, sender, phase, fn, session = null) => {
    const op = makeOp(opts?.opId, sender, api.sendTo, phase);
    op.session = session;
    const p = (async () => {
      try {
        const res = await fn(op);
        // a cancel that arrives while the result is being moved into place comes too late: the files are
        // there, so report success (not "canceled" over files that were extracted)
        if (!op.committed) checkCanceled(op);
        op.percent = 1;
        if (op.total > 0) op.done = op.total;
        op.emit(true);
        return res;
      } catch (e) {
        if (op.canceled && !op.committed) throw err('The operation was canceled', 'ECANCELED');
        throw e;
      } finally {
        for (const c of op.children) killTree(c);
        for (const fn2 of op.cleanup.reverse()) await Promise.resolve().then(fn2).catch(() => {});
        endOp(op);
      }
    })();
    op.settled = p.then(() => {}, () => {});
    return p;
  };
  const optsOf = (o) => (o && typeof o === 'object' ? o : {});
  const pathsOf = (list, what) => {
    if (!Array.isArray(list) || !list.length || list.length > 10000) throw err(`Invalid ${what}`, 'EINVAL');
    return list.map((p) => absPath(p, what));
  };

  api.handle('archive:tools', () => {
    const t = tools();
    return {
      sevenZip: !!t.sz,
      bsdtar: !!t.bsdtar,
      bsdcat: !!t.bsdcat,
      create: CREATE_FORMATS.filter((f) => (f === 'zip' || f === '7z' ? !!t.sz || !!t.bsdtar : !!t.bsdtar)),
      encrypt: !!t.sz,
    };
  });

  api.handle('archive:list', async (file, opts, event) => {
    const o = optsOf(opts);
    const p = absPath(file, 'archive path');
    const op = makeOp(o.opId, event?.sender, api.sendTo, 'list');
    try {
      const { listing } = await listArchive(p, { password: o.password ?? null, op });
      return listing;
    } catch (e) {
      if (op.canceled) throw err('The operation was canceled', 'ECANCELED');
      throw e;
    } finally {
      endOp(op);
    }
  });

  api.handle('archive:extract', (file, dest, opts, event) => {
    const o = optsOf(opts);
    const p = absPath(file, 'archive path');
    const d = absPath(dest, 'destination');
    return run(o, event?.sender, 'extract', (op) => doExtract(op, p, d, o));
  });

  api.handle('archive:extractTemp', (file, opts, event) => {
    const o = optsOf(opts);
    const p = absPath(file, 'archive path');
    return run(o, event?.sender, 'extract', async (op) => {
      const sd = sessionDir(o.session);
      let d;
      if (o.sub != null) {
        if (!/^[\w-]{1,40}$/.test(String(o.sub))) throw err('Invalid folder', 'EINVAL');
        d = path.join(sd, `x-${o.sub}`);
        await fsp.rm(d, { recursive: true, force: true });
        await fsp.mkdir(d, { mode: 0o700 });
      } else d = await fsp.mkdtemp(path.join(sd, 'x-'));
      return doExtract(op, p, d, { ...o, overwrite: 'rename', skipUnsafe: true });
    }, String(o.session || 'default'));
  });

  // The window's private temp folder (to build drag & drop paths before extracting).
  api.handle('archive:tempDir', (session) => sessionDir(session));

  api.handle('archive:preview', (file, entry, opts, event) => {
    const o = optsOf(opts);
    const p = absPath(file, 'archive path');
    const e = normEntry(String(entry || ''));
    if (!e.path || e.unsafe) throw err('Invalid entry', 'EINVAL');
    const textMax = Math.max(0, Math.min(4 * 1024 * 1024, Number(o.text) || 0));
    const describe = async (out) => {
      // never read through a link (the renderer resolves links inside the archive itself)
      const lst = await fsp.lstat(out).catch(() => null);
      if (!lst) throw err('This item could not be extracted', 'ENOENTRY');
      if (lst.isSymbolicLink()) throw err('This item is a symbolic link', 'ELINK');
      if (!lst.isFile()) throw err('This item is not a file', 'EINVAL');
      const st = lst;
      const res = { path: out, size: st.size };
      if (textMax) {
        const fh = await fsp.open(out, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
          const buf = Buffer.alloc(Math.min(textMax, st.size));
          const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
          const head = buf.subarray(0, bytesRead);
          let ctrl = 0;
          for (const b of head.subarray(0, 8192)) if (b === 0 || (b < 9 && b !== 0) || (b > 13 && b < 32 && b !== 27)) ctrl++;
          res.binary = head.includes(0) || ctrl > Math.min(8192, head.length) * 0.02;
          res.truncated = st.size > bytesRead;
          if (!res.binary) res.text = head.toString('utf8');
        } finally {
          await fh.close();
        }
      }
      return res;
    };
    return run(o, event?.sender, 'preview', async (op) => {
      // A link is never extracted for a preview: its target is returned ({ link }) and the window follows it
      // inside the archive (extracted alone, its target wouldn't be there).
      const { info, listing } = await listArchive(p, { password: o.password ?? null, op });
      const entry = listing.entries.find((x) => x.path === e.path);
      if (!entry) throw err('The item is not in the archive', 'ENOENTRY');
      if (entry.link != null) return { link: entry.link || (await linkTargetOf(op, info, entry, o.password ?? null)), size: 0 };
      const st = await fsp.stat(p);
      const key = crypto.createHash('sha1').update(`${p}|${st.size}|${st.mtimeMs}|${e.path}`).digest('hex').slice(0, 20);
      const dir = path.join(sessionDir(o.session), `p-${key}`);
      const name = e.path.split('/').pop();
      const out = path.join(dir, name);
      if (await exists(out)) return describe(out);
      await fsp.rm(dir, { recursive: true, force: true });
      await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
      try {
        const res = await doExtract(op, p, dir, { entries: [e.path], password: o.password ?? null, overwrite: 'replace', allowBomb: !!o.allowBomb });
        return describe(res.items[0] || out);
      } catch (err2) {
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
        throw err2;
      }
    }, String(o.session || 'default'));
  });

  api.handle('archive:cleanup', async (session) => {
    const s = String(session || '');
    if (!/^[\w.-]{1,64}$/.test(s) || s.startsWith('.')) return true;
    // stop what is still writing into that folder (a preview, a drag & drop extraction) first, or it could
    // recreate files after the folder is gone
    const pending = [...ops.values()].filter((op) => op.session === s);
    for (const op of pending) cancelOp(op);
    if (pending.length) await Promise.race([Promise.all(pending.map((op) => op.settled)), new Promise((r) => setTimeout(r, 5000).unref?.())]);
    if (tmpRoot) await fsp.rm(path.join(tmpRoot, s), { recursive: true, force: true }).catch(() => {});
    return true;
  });

  api.handle('archive:create', (srcPaths, destPath, opts, event) => {
    const o = optsOf(opts);
    const srcs = pathsOf(srcPaths, 'source path');
    const dst = absPath(destPath, 'archive path');
    return run(o, event?.sender, 'create', (op) => withLock(dst, () => doCreate(op, srcs, dst, o)));
  });

  api.handle('archive:add', (file, srcPaths, opts, event) => {
    const o = optsOf(opts);
    const p = absPath(file, 'archive path');
    const srcs = pathsOf(srcPaths, 'source path');
    return run(o, event?.sender, 'add', (op) => withLock(p, () => doAdd(op, p, srcs, o)));
  });

  api.handle('archive:delete', (file, entries, opts, event) => {
    const o = optsOf(opts);
    const p = absPath(file, 'archive path');
    if (!Array.isArray(entries) || !entries.length) throw err('Nothing to delete', 'EINVAL');
    return run(o, event?.sender, 'delete', (op) => withLock(p, () => doDelete(op, p, entries, o)));
  });

  api.handle('archive:test', (file, opts, event) => {
    const o = optsOf(opts);
    const p = absPath(file, 'archive path');
    return run(o, event?.sender, 'test', (op) => doTest(op, p, o));
  });

  api.handle('archive:cancel', (opId) => {
    const op = ops.get(String(opId || ''));
    if (op) cancelOp(op);
    return true;
  });

  const killAll = () => {
    for (const op of ops.values()) cancelOp(op);
    for (const c of running) killTree(c);
    if (tmpRoot) {
      try {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      } catch {}
    }
  };
  try {
    const { app } = require('electron');
    app.on('will-quit', killAll);
  } catch {}
};

// exported for unit tests
module.exports._internal = { normEntry, linkInside, parseModeString, entryFromBsdtar, decodeBsdtarName, parseSevenTime, isTarHeader, globEscape, breEscape, splitExt, sevenError };
