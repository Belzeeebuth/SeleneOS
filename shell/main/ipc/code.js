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
// When git is missing (or `dir` is not in a repository) the result is { repo: false }: the app just shows no status.
const fs = require('fs');
const path = require('path');
const { run, which } = require('../lib/exec');

const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', LC_ALL: 'C' };
const MAX_IGNORED = 2000;

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
};
module.exports.parseStatus = parseStatus;
module.exports.relativeTo = relativeTo;
