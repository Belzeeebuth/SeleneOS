'use strict';
// Code Editor backend (apps/code): git status of an opened folder. git runs with an argument vector only (no shell),
// with `-C <folder>`, a timeout, and a plain environment (no pager, no prompts, no optional locks).
//
//   code:git(dir) -> { repo: false } | { repo: true, root, branch, detached, ahead, behind, files: { relPath: code },
//                                       ignored: [relPath] }
//       relPath is relative to `dir` (forward slashes; folders end with '/'); paths outside `dir` are left out.
//       code: 'M' modified, 'A' added (staged new file), 'D' deleted, 'R' renamed, 'U' conflict, '?' untracked.
//       ignored: what .gitignore hides (git status --ignored, folders collapsed), for the file tree.
//   code:gitAvailable() -> boolean
//   code:openFolder(dir) -> { root }   registers `dir` as a folder the Code Editor opened (for the window that asks;
//       16 at most): search / replace (code-search.js) and code:gitShow only work inside a registered folder.
//       root is its real path (symlinks resolved). Throws ENOTDIR / EINVAL; the file-system root itself is refused.
//   code:gitShow(root, relPath, rev = 'HEAD') -> { repo, exists, text } | { repo, exists: true, binary: true }
//                                              | { repo, exists: true, tooBig: true }
//       the content of a file of the opened folder at a revision (git cat-file with an argument vector; `relPath`
//       relative to `root`, no '..'; rev: HEAD, HEAD~n or a commit hash). exists: false = not in that revision
//       (new file, no commit yet) or not a repository (repo: false).
// When git is missing (or `dir` is not in a repository) the result is { repo: false }: the app just shows no status.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { run, which } = require('../lib/exec');

const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', LC_ALL: 'C' };
const MAX_IGNORED = 2000;
const MAX_SHOW = 8 * 1024 * 1024;
const MAX_ROOTS = 16;

const fail = (message, code) => Object.assign(new Error(message), { code });

/** true when `child` is `parent` or inside it (both absolute, normalised). */
function inside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

// ------------------------------------------------------------------ opened folders
// The ipc framework passes the Electron event last; a handler called with fewer arguments gets it earlier.
const isEvent = (x) => !!x && typeof x === 'object' && 'sender' in x;
const senderKey = (event) => event?.sender?.id ?? 0;
const roots = new Map(); // sender id -> [real root] (most recent first)

async function openRoot(dir, event) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir) || dir.includes('\0')) throw fail('Invalid folder', 'EINVAL');
  const st = await fsp.stat(dir).catch(() => null);
  if (!st?.isDirectory()) throw fail(`Not a folder: ${dir}`, 'ENOTDIR');
  const real = await fsp.realpath(dir);
  if (real === path.parse(real).root) throw fail('The root of the file system cannot be searched', 'EINVAL');
  const key = senderKey(event);
  const list = [real, ...(roots.get(key) || []).filter((r) => r !== real)].slice(0, MAX_ROOTS);
  roots.set(key, list);
  return { root: real };
}

/** The real path of `dir` when it is a folder this window opened (code:openFolder), else throws ENOTOPEN. */
async function checkRoot(event, dir) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir) || dir.includes('\0')) throw fail('Invalid folder', 'EINVAL');
  const real = await fsp.realpath(dir).catch(() => null);
  if (!real || !(roots.get(senderKey(event)) || []).includes(real)) throw fail('This folder is not open in the Code Editor', 'ENOTOPEN');
  return real;
}

/** A path relative to the opened folder, forward slashes, with no way out of it; null when invalid. */
function cleanRel(rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0') || rel.length > 4096) return null;
  const norm = path.posix.normalize(rel.split(path.sep).join('/'));
  if (norm.startsWith('/') || norm === '.' || norm === '..' || norm.startsWith('../')) return null;
  return norm.replace(/\/+$/, '');
}

async function gitShow(root, rel, rev, event) {
  const real = await checkRoot(event, root);
  const clean = cleanRel(rel);
  if (!clean) throw fail('Invalid path', 'EINVAL');
  const r = rev == null ? 'HEAD' : rev;
  if (typeof r !== 'string' || !/^(?:HEAD(?:~\d{1,4})?|[0-9a-f]{7,40})$/.test(r)) throw fail('Invalid revision', 'EINVAL');
  if (!which('git')) return { repo: false, exists: false, text: '' };
  // `<rev>:./<path>` is relative to the working directory (-C): the opened folder, wherever it sits in the repository
  const out = await run('git', ['-C', real, 'cat-file', 'blob', `${r}:./${clean}`], { timeout: 15000, env: GIT_ENV }).catch(() => null);
  if (!out || out.code !== 0) {
    const inRepo = await run('git', ['-C', real, 'rev-parse', '--is-inside-work-tree'], { timeout: 5000, env: GIT_ENV }).catch(() => null);
    return { repo: inRepo?.code === 0 && inRepo.stdout.trim() === 'true', exists: false, text: '' };
  }
  const text = out.stdout;
  if (text.length > MAX_SHOW) return { repo: true, exists: true, tooBig: true };
  if (text.includes('\0')) return { repo: true, exists: true, binary: true };
  return { repo: true, exists: true, text };
}

/** One status code for an XY pair of `git status --porcelain=v1`. */
function codeOf(xy) {
  if (xy === '??') return '?';
  if (xy === '!!') return '!';
  if (xy.includes('U') || xy === 'AA' || xy === 'DD') return 'U';
  if (xy[0] === 'R' || xy[1] === 'R') return 'R';
  if (xy[0] === 'A') return 'A';
  if (xy[0] === 'D' || xy[1] === 'D') return 'D';
  return 'M';
}

/**
 * Parses `git status --porcelain=v1 --branch -z [--ignored]` output.
 * -> { branch, detached, ahead, behind, entries: [{ path, code, from? }] }  (paths relative to the repository root)
 */
function parseStatus(out) {
  const res = { branch: '', detached: false, ahead: 0, behind: 0, entries: [] };
  const parts = String(out || '').split('\0');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    if (p.startsWith('## ')) {
      const head = p.slice(3);
      if (/^HEAD \(no branch\)/.test(head)) res.detached = true;
      else {
        const m = /^(?:No commits yet on |Initial commit on )?(.+?)(?:\.\.\.(\S+))?(?: \[(.*)\])?$/.exec(head);
        res.branch = m ? m[1] : head;
        const info = m?.[3] || '';
        res.ahead = Number(/ahead (\d+)/.exec(info)?.[1] || 0);
        res.behind = Number(/behind (\d+)/.exec(info)?.[1] || 0);
      }
      continue;
    }
    if (p.length < 4) continue;
    const xy = p.slice(0, 2);
    const entry = { path: p.slice(3), code: codeOf(xy) };
    // renames and copies: the next NUL-separated field is the original path
    if (xy[0] === 'R' || xy[0] === 'C') entry.from = parts[++i] || '';
    res.entries.push(entry);
  }
  return res;
}

/** Maps repository-relative entries to paths relative to `rel` (the opened folder inside the repository). */
function relativeTo(entries, rel) {
  const prefix = rel ? `${rel.replace(/\/+$/, '')}/` : '';
  const files = {};
  const ignored = [];
  for (const e of entries) {
    if (prefix && !e.path.startsWith(prefix)) continue;
    const p = e.path.slice(prefix.length);
    if (!p) continue;
    if (e.code === '!') {
      if (ignored.length < MAX_IGNORED) ignored.push(p);
    } else files[p] = e.code;
  }
  return { files, ignored };
}

async function gitStatus(dir) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir) || dir.includes('\0')) return { repo: false };
  try {
    if (!fs.statSync(dir).isDirectory()) return { repo: false };
  } catch {
    return { repo: false };
  }
  if (!which('git')) return { repo: false };
  const top = await run('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { timeout: 5000, env: GIT_ENV }).catch(() => null);
  if (!top || top.code !== 0) return { repo: false };
  const root = top.stdout.trim();
  const st = await run('git', ['-C', root, 'status', '--porcelain=v1', '--branch', '-z', '--ignored', '--untracked-files=normal'], {
    timeout: 15000,
    env: GIT_ENV,
  }).catch(() => null);
  if (!st || st.code !== 0) return { repo: true, root, branch: '', detached: false, ahead: 0, behind: 0, files: {}, ignored: [] };
  const parsed = parseStatus(st.stdout);
  let real = dir;
  try {
    real = fs.realpathSync(dir);
  } catch {}
  const rel = path.relative(root, real).split(path.sep).join('/');
  const { files, ignored } = relativeTo(parsed.entries, rel.startsWith('..') ? '' : rel);
  let branch = parsed.branch;
  if (parsed.detached) {
    const sha = await run('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], { timeout: 5000, env: GIT_ENV }).catch(() => null);
    branch = sha?.code === 0 ? sha.stdout.trim() : 'HEAD';
  }
  return { repo: true, root, branch, detached: parsed.detached, ahead: parsed.ahead, behind: parsed.behind, files, ignored };
}

module.exports = function register(api) {
  api.handle('code:git', async (dir) => gitStatus(dir));
  api.handle('code:gitAvailable', async () => !!which('git'));
  api.handle('code:openFolder', async (dir, event) => openRoot(dir, event));
  api.handle('code:gitShow', async (root, rel, rev, event) => {
    if (isEvent(rev)) [rev, event] = [undefined, rev];
    return gitShow(root, rel, rev, event);
  });
};
module.exports.parseStatus = parseStatus;
module.exports.relativeTo = relativeTo;
// shared with code-search.js (same area)
module.exports.checkRoot = checkRoot;
module.exports.inside = inside;
module.exports.isEvent = isEvent;
module.exports.cleanRel = cleanRel;
module.exports.fail = fail;
