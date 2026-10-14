// Code Editor unit tests: the git status parser of main/ipc/code.js (porcelain v1 -z output), its mapping to the
// opened folder, and the real backend on a throwaway repository (git argv only); the search engine of
// main/ipc/code-search.js (globs, .gitignore rules, query options, replacement patterns) and its handlers on a
// throwaway folder: opened-folder check, every option, .gitignore respected (nested, negated, from the repository
// above), binaries / large files / links, open buffers, result cap, streaming, cancel, replace exactly as previewed
// (hash check, chosen matches, outside paths refused), undo; code:gitShow (HEAD content, new file, bad input).
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

// ------------------------------------------------------------------ search engine (code-search.js), pure parts
const S = require('../main/ipc/code-search.js');
const g = (pat) => S.globToRegExp(pat);
const gm = (pat, rel, dir = false) => {
  const x = g(pat);
  return !!x && (!x.dirOnly || dir) && x.re.test(rel);
};
t('glob: no slash matches at any depth, a slash anchors', () => {
  assert.ok(gm('*.js', 'a.js') && gm('*.js', 'src/deep/a.js'));
  assert.ok(!gm('*.js', 'a.jsx') && !gm('*.js', 'a.js/x'));
  assert.ok(gm('/build', 'build') && !gm('/build', 'src/build'));
  assert.ok(gm('src/*.ts', 'src/a.ts') && !gm('src/*.ts', 'src/x/a.ts') && !gm('src/*.ts', 'lib/src/a.ts'));
});
t('glob: ** forms, ?, classes, escapes, dir-only', () => {
  assert.ok(gm('src/**/x.ts', 'src/x.ts') && gm('src/**/x.ts', 'src/a/b/x.ts'));
  assert.ok(gm('**/logs', 'logs') && gm('**/logs', 'a/b/logs'));
  assert.ok(gm('a/**', 'a/b/c') && !gm('a/**', 'a'));
  assert.ok(gm('a?c', 'abc') && !gm('a?c', 'a/c'));
  assert.ok(gm('[ab].c', 'a.c') && gm('[ab].c', 'b.c') && !gm('[ab].c', 'c.c'));
  assert.ok(gm('[!a].c', 'b.c') && !gm('[!a].c', 'a.c'));
  assert.ok(gm('\\#x', '#x') && gm('a.b', 'a.b') && !gm('a.b', 'axb'));
  assert.ok(g('build/').dirOnly && gm('build/', 'x/build', true) && !gm('build/', 'build', false));
});
t('gitignore: comments, negation, last rule wins, nested base, ancestors prefix', () => {
  const rules = S.parseIgnore('# comment\n\n*.log\n!keep.log\ndist/\n/only-top.txt\ntrailing.txt   \n');
  const st = [{ base: '', rules }];
  assert.equal(S.ignoredBy(st, 'a.log', false), true);
  assert.equal(S.ignoredBy(st, 'x/keep.log', false), false);
  assert.equal(S.ignoredBy(st, 'dist', true), true);
  assert.equal(S.ignoredBy(st, 'dist', false), false);
  assert.equal(S.ignoredBy(st, 'only-top.txt', false), true);
  assert.equal(S.ignoredBy(st, 'sub/only-top.txt', false), false);
  assert.equal(S.ignoredBy(st, 'trailing.txt', false), true);
  const nested = [...st, { base: 'sub', rules: S.parseIgnore('/gen\n!*.log\n') }];
  assert.equal(S.ignoredBy(nested, 'sub/gen', true), true);
  assert.equal(S.ignoredBy(nested, 'gen', true), false);
  assert.equal(S.ignoredBy(nested, 'sub/x.log', false), false); // re-included below sub/
  const up = [{ prefix: 'app/', base: '', rules: S.parseIgnore('/app/cache/\n*.tmp\n') }];
  assert.equal(S.ignoredBy(up, 'cache', true), true);
  assert.equal(S.ignoredBy(up, 'x/y.tmp', false), true);
});
t('query: literal escaping, case, whole word (letters with accents), regex, errors', () => {
  const cols = (q, text, o = {}) => S.findInText(text, S.compileQuery({ query: q, ...o })).map((m) => m.col);
  assert.deepEqual(cols('a.b', 'axb a.b'), [4]);
  assert.deepEqual(cols('Lune', 'lune LUNE Lune'), [0, 5, 10]);
  assert.deepEqual(cols('Lune', 'lune LUNE Lune', { matchCase: true }), [10]);
  assert.deepEqual(cols('cat', 'cat concat cat_x écat cat', { wholeWord: true }), [0, 22]);
  assert.deepEqual(cols('été', 'été étés Été', { wholeWord: true }), [0, 9]);
  assert.deepEqual(cols('\\d+', 'a1 b22', { regex: true }), [1, 4]);
  assert.deepEqual(cols('^x', 'x x\nxx', { regex: true }), [0, 0]);
  assert.throws(() => S.compileQuery({ query: '(', regex: true }), (e) => e.code === 'EREGEX');
  assert.throws(() => S.compileQuery({ query: '' }), (e) => e.code === 'EQUERY');
  assert.equal(S.compileQuery({ query: 'a\\-b', regex: true }).flags.includes('u'), false); // valid outside Unicode mode
});
t('replacement patterns: $&, $1, $<name>, $$, $`, $\', $10 with one group', () => {
  const re = S.compileQuery({ query: '(?<user>\\w+)@(\\w+)', regex: true });
  const m = [...S.findInText('to ann@site.', re, { replace: '[$2|$1|$<user>|$&|$$|$`|$\'|$10]', regex: true })];
  assert.equal(m[0].rep, '[site|ann|ann|ann@site|$|to |.|ann0]');
  assert.equal(S.findInText('x', S.compileQuery({ query: 'x' }), { replace: '$1' })[0].rep, '$1'); // literal: as typed
});
t('matches: CRLF, long-line preview window, empty matches skipped, limit', () => {
  const crlf = S.findInText('ab\r\nab\r\n', S.compileQuery({ query: 'b$', regex: true }));
  assert.deepEqual(crlf.map((m) => [m.line, m.col]), [[1, 1], [2, 1]]);
  const long = `${'x'.repeat(1000)}NEEDLE${'y'.repeat(1000)}`;
  const [lm] = S.findInText(long, S.compileQuery({ query: 'needle' }));
  assert.equal(lm.col, 1000);
  assert.ok(lm.text.length <= 240 && lm.off > 0 && lm.text.slice(lm.col - lm.off, lm.col - lm.off + 6) === 'NEEDLE');
  assert.deepEqual(S.findInText('aaa', S.compileQuery({ query: 'b*', regex: true })), []);
  assert.equal(S.findInText('a a a a', S.compileQuery({ query: 'a' }), { limit: 2 }).length, 2);
});
t('replaceInText: all, or only the chosen ordinals', () => {
  const re = S.compileQuery({ query: 'o' });
  assert.deepEqual(S.replaceInText('foo\nbo', re, '0'), { text: 'f00\nb0', count: 3 });
  assert.deepEqual(S.replaceInText('foo\nbo', re, '0', { only: new Set([1, 2]) }), { text: 'fo0\nb0', count: 2 });
});

// ------------------------------------------------------------------ search / replace / gitShow handlers
const ta = async (name, fn) => {
  try {
    await fn();
    passed++;
  } catch (err) {
    console.error(`✗ ${name}\n${err.stack}`);
    process.exitCode = 1;
  }
};
{
  const handlers = {};
  const batches = [];
  const sender = { id: 7, isDestroyed: () => false, send: (ch, p) => ch === 'code:search-batch' && batches.push(p) };
  const event = { sender };
  const fake = { handle: (ch, fn) => (handlers[ch] = fn), DEV: true, sendTo: (s2, ch, p) => s2?.send(ch, p) };
  mod(fake);
  S(fake);
  const call = (ch, ...a) => handlers[ch](...a, event);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'code-search-'));
  const root = path.join(base, 'repo', 'proj');
  const w = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  try {
    fs.mkdirSync(path.join(base, 'repo', '.git'), { recursive: true }); // the repository's top is above the folder
    fs.writeFileSync(path.join(base, 'repo', '.gitignore'), '*.tmp\n');
    fs.writeFileSync(path.join(base, 'outside.txt'), 'lune outside\n');
    w('.gitignore', 'dist/\n*.log\n!keep.log\n');
    w('README.md', '# Lune\nLa lune et la Lune.\n');
    w('src/main.js', 'const lune = 1;\nconsole.log(lune, LUNE, lunes);\n');
    w('src/moon.ts', 'export const lune = "lune";\n');
    w('src/gen/.gitignore', 'out.js\n');
    w('src/gen/out.js', 'lune generated\n');
    w('src/gen/kept.js', 'lune kept\n');
    w('dist/bundle.js', 'lune dist\n');
    w('debug.log', 'lune log\n');
    w('keep.log', 'lune keep\n');
    w('cache.tmp', 'lune tmp\n');
    w('node_modules/pkg/index.js', 'lune module\n');
    w('big.txt', `lune\n${'z'.repeat(70 * 1024)}\n`);
    fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.from([0x6c, 0x75, 0x6e, 0x65, 0, 1, 2]));
    fs.writeFileSync(path.join(root, 'latin1.txt'), Buffer.from([0x6c, 0x75, 0x6e, 0x65, 0x20, 0xe9, 0x0a])); // « lune é » in Latin-1
    fs.symlinkSync(path.join(base, 'outside.txt'), path.join(root, 'link-out.txt'));
    fs.symlinkSync(path.join(base), path.join(root, 'link-dir'));
    fs.symlinkSync(path.join(root, 'README.md'), path.join(root, 'link-in.md'));
    const search = async (o) => {
      batches.length = 0;
      const res = await call('code:search', root, { id: 't1', query: 'lune', maxFileBytes: 64 * 1024, ...o });
      const files = batches.flatMap((b) => b.results);
      return { res, files, rels: files.map((f) => f.rel) };
    };

    await ta('search: refused before code:openFolder, and for /', async () => {
      await assert.rejects(call('code:search', root, { id: 'x', query: 'lune' }), (e) => e.code === 'ENOTOPEN');
      await assert.rejects(call('code:openFolder', '/'), (e) => e.code === 'EINVAL');
      await assert.rejects(call('code:openFolder', path.join(root, 'README.md')), (e) => e.code === 'ENOTDIR');
      assert.equal((await call('code:openFolder', root)).root, fs.realpathSync(root));
      await assert.rejects(handlers['code:search'](root, { id: 'x', query: 'lune' }, { sender: { id: 99 } }), (e) => e.code === 'ENOTOPEN'); // another window
    });
    await ta('search: default options, .gitignore (nested, negated, from above), node_modules, binaries, large files, links', async () => {
      const { res, rels, files } = await search({});
      assert.deepEqual(rels, ['README.md', 'keep.log', 'latin1.txt', 'link-in.md', 'src/gen/kept.js', 'src/main.js', 'src/moon.ts']);
      assert.equal(res.files, 7);
      assert.equal(res.matches, files.reduce((n, f) => n + f.matches.length, 0));
      assert.equal(res.skipped.binary, 1);
      assert.equal(res.skipped.large, 1);
      assert.equal(res.cancelled, false);
      const main = files.find((f) => f.rel === 'src/main.js');
      assert.equal(main.path, path.join(root, 'src/main.js'));
      assert.deepEqual(main.matches.map((m) => [m.line, m.col, m.len]), [[1, 6, 4], [2, 12, 4], [2, 18, 4], [2, 24, 4]]);
      assert.match(main.hash, /^[0-9a-f]{40}$/);
    });
    await ta('search: match case, whole word, regex', async () => {
      const cs = await search({ matchCase: true, query: 'Lune' });
      assert.deepEqual(cs.files.map((f) => [f.rel, f.matches.length]), [['README.md', 2], ['link-in.md', 2]]);
      const ww = await search({ wholeWord: true, include: 'src/main.js' });
      assert.deepEqual(ww.files[0].matches.map((m) => m.col), [6, 12, 18]); // not « lunes »
      const re = await search({ regex: true, query: 'lune(s)?\\b', matchCase: true, include: '*.js' });
      assert.deepEqual(re.rels, ['src/gen/kept.js', 'src/main.js']);
      await assert.rejects(search({ regex: true, query: '[' }), (e) => e.code === 'EREGEX');
    });
    await ta('search: include / exclude globs', async () => {
      assert.deepEqual((await search({ include: '*.ts, README.md' })).rels, ['README.md', 'src/moon.ts']);
      assert.deepEqual((await search({ include: 'src' })).rels, ['src/gen/kept.js', 'src/main.js', 'src/moon.ts']);
      assert.deepEqual((await search({ include: './src/*.js' })).rels, ['src/main.js']);
      assert.deepEqual((await search({ exclude: 'src/, *.md' })).rels, ['keep.log', 'latin1.txt']);
      assert.deepEqual((await search({ exclude: 'gen' })).rels.filter((r) => r.startsWith('src/')), ['src/main.js', 'src/moon.ts']);
    });
    await ta('search: useIgnore off reads ignored files and node_modules (never .git, never outside)', async () => {
      const { rels } = await search({ useIgnore: false });
      for (const r of ['dist/bundle.js', 'debug.log', 'cache.tmp', 'node_modules/pkg/index.js', 'src/gen/out.js']) assert.ok(rels.includes(r), r);
      assert.ok(!rels.some((r) => r.startsWith('link-dir') || r === 'link-out.txt'));
    });
    await ta('search: open buffers are searched instead of the file', async () => {
      const { files } = await search({ buffers: [{ path: path.join(root, 'src/moon.ts'), text: 'nothing here\nlune lune\n' }, { path: path.join(base, 'outside.txt'), text: 'lune' }] });
      const moon = files.find((f) => f.rel === 'src/moon.ts');
      assert.equal(moon.buffer, true);
      assert.equal(moon.hash, null);
      assert.deepEqual(moon.matches.map((m) => [m.line, m.col]), [[2, 0], [2, 5]]);
      assert.ok(!files.some((f) => f.path.endsWith('outside.txt')));
    });
    await ta('search: result cap (limitHit) and replacement preview', async () => {
      const { res, files } = await search({ maxResults: 3 });
      assert.equal(res.matches, 3);
      assert.equal(res.limitHit, true);
      assert.equal(files.reduce((n, f) => n + f.matches.length, 0), 3);
      const rep = await search({ regex: true, query: '(l)une', replace: '$1ua', include: 'src/moon.ts' });
      assert.deepEqual(rep.files[0].matches.map((m) => m.rep), ['lua', 'lua']);
    });
    await ta('search: cancel stops a long search', async () => {
      for (let i = 0; i < 60; i++) w(`many/f${String(i).padStart(2, '0')}.txt`, 'lune\n');
      batches.length = 0;
      const p = call('code:search', root, { id: 'slow', query: 'lune', delayMs: 15 });
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(await call('code:searchCancel', 'slow'), true);
      const res = await p;
      assert.equal(res.cancelled, true);
      assert.ok(res.files < 60, `files ${res.files}`);
      assert.equal(await call('code:searchCancel', 'slow'), false);
      fs.rmSync(path.join(root, 'many'), { recursive: true, force: true });
    });
    await ta('replace: files on disk changed exactly as previewed; chosen matches; changed files left alone', async () => {
      const opts = { query: 'lune', wholeWord: true, matchCase: true };
      const { files } = await search({ ...opts, replace: 'Séléné', include: 'src' });
      const expected = {};
      for (const f of files) {
        // the preview: each match replaced by its text, at its line and column
        const lines = fs.readFileSync(f.path, 'utf8').split('\n');
        for (const m of [...f.matches].reverse()) lines[m.line - 1] = lines[m.line - 1].slice(0, m.col) + m.rep + lines[m.line - 1].slice(m.col + m.len);
        expected[f.path] = lines.join('\n');
      }
      const main = files.find((f) => f.rel === 'src/main.js');
      const moon = files.find((f) => f.rel === 'src/moon.ts');
      const kept = files.find((f) => f.rel === 'src/gen/kept.js');
      fs.appendFileSync(kept.path, '// edited since the search\n');
      const res = await call('code:replace', root, { ...opts, replace: 'Séléné', files: [main, moon, kept].map((f) => ({ path: f.path, hash: f.hash })) });
      assert.deepEqual(res.changed.map((c) => [path.relative(root, c.path), c.count]), [['src/main.js', 2], ['src/moon.ts', 2]]);
      assert.deepEqual(res.skipped, [{ path: kept.path, reason: 'changed' }]);
      assert.equal(fs.readFileSync(main.path, 'utf8'), expected[main.path]);
      assert.equal(fs.readFileSync(moon.path, 'utf8'), expected[moon.path]);
      assert.equal(fs.readFileSync(main.path, 'utf8'), 'const Séléné = 1;\nconsole.log(Séléné, LUNE, lunes);\n');
      assert.ok(res.undoId);
      // undo puts the bytes back
      const u = await call('code:replaceUndo', res.undoId);
      assert.equal(u.restored.length, 2);
      assert.equal(fs.readFileSync(main.path, 'utf8'), 'const lune = 1;\nconsole.log(lune, LUNE, lunes);\n');
      await assert.rejects(call('code:replaceUndo', res.undoId), (e) => e.code === 'ENOUNDO');
      // only some matches (ordinals of the file)
      const again = await search({ ...opts, include: 'src/main.js' });
      const r2 = await call('code:replace', root, { ...opts, replace: 'X', files: [{ path: main.path, hash: again.files[0].hash, only: [1] }] });
      assert.equal(r2.changed[0].count, 1);
      assert.equal(fs.readFileSync(main.path, 'utf8'), 'const lune = 1;\nconsole.log(X, LUNE, lunes);\n');
    });
    await ta('replace: never outside the folder, never through a link out, never a non-UTF-8 file', async () => {
      const sha = (p) => require('crypto').createHash('sha1').update(fs.readFileSync(p)).digest('hex');
      const out = path.join(base, 'outside.txt');
      const res = await call('code:replace', root, {
        query: 'lune',
        replace: 'X',
        files: [
          { path: out, hash: sha(out) },
          { path: path.join(root, '..', '..', 'outside.txt'), hash: sha(out) },
          { path: path.join(root, 'link-out.txt'), hash: sha(out) },
          { path: path.join(root, 'latin1.txt'), hash: sha(path.join(root, 'latin1.txt')) },
          { path: 'relative.txt', hash: 'x' },
        ],
      });
      assert.deepEqual(res.changed, []);
      assert.deepEqual(res.skipped.map((x) => x.reason), ['outside', 'outside', 'outside', 'encoding', 'invalid']);
      assert.equal(fs.readFileSync(out, 'utf8'), 'lune outside\n');
      await assert.rejects(handlers['code:replace'](root, { query: 'lune', replace: 'X', files: [] }, { sender: { id: 99 } }), (e) => e.code === 'ENOTOPEN');
    });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }

  // code:gitShow on a real repository
  if (hasGit) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-show-'));
    try {
      const git = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=T', '-c', 'user.email=t@example.org', ...a], { stdio: 'pipe' });
      fs.mkdirSync(path.join(dir, 'sub'));
      fs.writeFileSync(path.join(dir, 'sub', 'a.txt'), 'one\ntwo\n');
      git('init', '-q', '-b', 'main');
      git('add', '-A');
      git('commit', '-q', '-m', 'init');
      fs.writeFileSync(path.join(dir, 'sub', 'a.txt'), 'one\n2\n');
      fs.writeFileSync(path.join(dir, 'sub', 'new.txt'), 'new\n');
      await ta('gitShow: HEAD content, a new file, a sub-folder, bad input', async () => {
        await assert.rejects(call('code:gitShow', dir, 'sub/a.txt', 'HEAD'), (e) => e.code === 'ENOTOPEN');
        await call('code:openFolder', dir);
        assert.deepEqual(await call('code:gitShow', dir, 'sub/a.txt', 'HEAD'), { repo: true, exists: true, text: 'one\ntwo\n' });
        assert.deepEqual(await handlers['code:gitShow'](dir, 'sub/a.txt', event), { repo: true, exists: true, text: 'one\ntwo\n' }); // rev left out
        assert.deepEqual(await call('code:gitShow', dir, 'sub/new.txt', 'HEAD'), { repo: true, exists: false, text: '' });
        await call('code:openFolder', path.join(dir, 'sub'));
        assert.equal((await call('code:gitShow', path.join(dir, 'sub'), 'a.txt', 'HEAD')).text, 'one\ntwo\n');
        for (const bad of ['../x', '/etc/passwd', '', 'a\0b']) await assert.rejects(call('code:gitShow', dir, bad, 'HEAD'), (e) => e.code === 'EINVAL', bad);
        for (const rev of ['--output=/tmp/x', 'HEAD;ls', 'main']) await assert.rejects(call('code:gitShow', dir, 'sub/a.txt', rev), (e) => e.code === 'EINVAL', rev);
        const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'code-plain-'));
        await call('code:openFolder', plain);
        assert.deepEqual(await call('code:gitShow', plain, 'x.txt', 'HEAD'), { repo: false, exists: false, text: '' });
        fs.rmSync(plain, { recursive: true, force: true });
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

console.log(`code.unit: ${passed} passed${process.exitCode ? ', FAILURES above' : ''}`);
