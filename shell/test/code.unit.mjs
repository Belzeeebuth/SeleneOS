// Code Editor unit tests: the git status parser of main/ipc/code.js (porcelain v1 -z output), its mapping to the
// opened folder, and the real backend on a throwaway repository (git argv only).
// Usage:  cd aurora-os/shell && node test/code.unit.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('../main/ipc/code.js');
const { parseStatus, relativeTo } = mod;

let passed = 0;
const t = (name, fn) => {
  try {
    fn();
    passed++;
  } catch (err) {
    console.error(`✗ ${name}\n${err.stack}`);
    process.exitCode = 1;
  }
};

t('branch line with upstream and ahead/behind', () => {
  const r = parseStatus('## main...origin/main [ahead 2, behind 1]\0');
  assert.equal(r.branch, 'main');
  assert.equal(r.ahead, 2);
  assert.equal(r.behind, 1);
  assert.equal(r.detached, false);
});
t('branch without upstream, slashes in the name', () => {
  assert.equal(parseStatus('## feature/moon-phase\0').branch, 'feature/moon-phase');
});
t('no commits yet', () => {
  assert.equal(parseStatus('## No commits yet on main\0?? a.txt\0').branch, 'main');
});
t('detached HEAD', () => {
  const r = parseStatus('## HEAD (no branch)\0');
  assert.equal(r.detached, true);
  assert.equal(r.branch, '');
});
t('entries: modified, added, deleted, untracked, ignored, conflict, rename with original path', () => {
  const out = ['## main', ' M src/main.js', 'M  staged.js', 'A  new.js', ' D gone.js', '?? notes.txt', '?? newdir/', '!! node_modules/', 'UU both.js', 'R  to name.js', 'from name.js', 'MM twice.js', ''].join('\0');
  const r = parseStatus(out);
  const m = Object.fromEntries(r.entries.map((e) => [e.path, e.code]));
  assert.deepEqual(m, {
    'src/main.js': 'M',
    'staged.js': 'M',
    'new.js': 'A',
    'gone.js': 'D',
    'notes.txt': '?',
    'newdir/': '?',
    'node_modules/': '!',
    'both.js': 'U',
    'to name.js': 'R',
    'twice.js': 'M',
  });
  assert.equal(r.entries.find((e) => e.code === 'R').from, 'from name.js');
});
t('relativeTo: a sub-folder of the repository', () => {
  const entries = [
    { path: 'app/src/a.js', code: 'M' },
    { path: 'app/dist/', code: '!' },
    { path: 'other/b.js', code: 'M' },
    { path: 'app/', code: '?' },
  ];
  const r = relativeTo(entries, 'app');
  assert.deepEqual(r.files, { 'src/a.js': 'M' });
  assert.deepEqual(r.ignored, ['dist/']);
  assert.deepEqual(relativeTo(entries, '').files, { 'app/src/a.js': 'M', 'other/b.js': 'M', 'app/': '?' });
});
t('garbage is ignored', () => {
  assert.deepEqual(parseStatus('').entries, []);
  assert.deepEqual(parseStatus('x\0\0').entries, []);
  assert.deepEqual(parseStatus(null).entries, []);
});

// the real handler on a throwaway repository
let hasGit = true;
try {
  execFileSync('git', ['--version'], { stdio: 'pipe' });
} catch {
  hasGit = false;
}
if (hasGit) {
  const handlers = {};
  mod({ handle: (ch, fn) => (handlers[ch] = fn), DEV: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-unit-'));
  try {
    const git = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=T', '-c', 'user.email=t@example.org', ...a], { stdio: 'pipe' });
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, '.gitignore'), 'build/\n');
    fs.writeFileSync(path.join(dir, 'sub', 'a.txt'), 'a\n');
    git('init', '-q', '-b', 'trunk');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    fs.writeFileSync(path.join(dir, 'sub', 'a.txt'), 'b\n');
    fs.writeFileSync(path.join(dir, 'sub', 'n; rm -rf $HOME.txt'), 'x\n'); // odd names stay data (argv, -z)
    fs.mkdirSync(path.join(dir, 'build'));
    fs.writeFileSync(path.join(dir, 'build', 'x'), '');
    const r = await handlers['code:git'](dir);
    t('backend: branch and files', () => {
      assert.equal(r.repo, true);
      assert.equal(r.branch, 'trunk');
      assert.equal(r.files['sub/a.txt'], 'M');
      assert.equal(r.files['sub/n; rm -rf $HOME.txt'], '?');
      assert.ok(r.ignored.includes('build/'));
    });
    const sub = await handlers['code:git'](path.join(dir, 'sub'));
    t('backend: opened sub-folder gets relative paths', () => {
      assert.equal(sub.files['a.txt'], 'M');
      assert.equal(sub.root, fs.realpathSync(dir));
    });
    const none = await handlers['code:git'](os.tmpdir());
    t('backend: not a repository', () => assert.equal(none.repo, false));
    const bad = await handlers['code:git']('relative/path');
    t('backend: bad input', () => assert.equal(bad.repo, false));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`code.unit: ${passed} passed${process.exitCode ? ', FAILURES above' : ''}`);
