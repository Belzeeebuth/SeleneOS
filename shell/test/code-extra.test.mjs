// Code Editor, the « Later » items (app id "code") — drive the real Electron shell with Playwright.
//   Search across files (Ctrl+Shift+F side view; main/ipc/code-search.js): each option (match case, whole word,
//   regular expression, include / exclude globs, .gitignore + node_modules), results grouped by file with the match
//   highlighted, click to open at the match, stop a long search, replace across files (preview, replace one match /
//   one file / all with a confirmation; files on disk changed exactly as previewed; open files changed in their
//   buffer; « Annuler le remplacement »).
//   Split view: Ctrl+\ (right) and « Fractionner vers le bas », one document shown in both panes stays the same
//   (edits and undo), Ctrl+1 / Ctrl+2, move a tab (menu and drag), close a pane, the layout remembered per folder.
//   Comparisons (@codemirror/merge): « Comparer avec HEAD » on a temp git repository (side by side and inline,
//   next / previous change with F7 / Shift+F7, revert a change), « Comparer avec le fichier enregistré » for unsaved
//   changes, two files; screenshots in French and English, light and dark.
// Usage:  cd aurora-os/shell && xvfb-run -a -s "-screen 0 1600x900x24" node test/code-extra.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { launchShell, ROOT } from './lib.mjs';

const DOCS = path.join(ROOT, '..', 'docs', 'screenshots');
fs.mkdirSync(DOCS, { recursive: true });

let passed = 0;
const failures = [];
function check(name, actual, expected) {
  const ok = typeof expected === 'function' ? !!expected(actual) : Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else failures.push(`${name}\n      expected: ${typeof expected === 'function' ? '(predicate)' : JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
  return ok;
}
async function section(name, fn) {
  const t0 = Date.now();
  const before = failures.length;
  try {
    await fn();
    console.log(`  ${failures.length === before ? '✓' : '✗'} ${name} (${Date.now() - t0} ms)`);
  } catch (err) {
    failures.push(`${name}: threw ${err?.stack || err}`);
    console.log(`  ✗ ${name}: ${err?.message || err}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const W = '.win.app-code';

/** Evaluates fn(app, arg) in the shell, app = the CodeApp of the Code Editor window. */
function C(s, fn, arg) {
  return s.page.evaluate(`(async () => { const el = document.querySelector('${W}'); return (${fn.toString()})(el && el.__code, ${JSON.stringify(arg ?? null)}); })()`);
}
async function until(s, fn, { timeout = 10000, label = 'condition', arg } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = await C(s, fn, arg).catch((e) => `ERR ${e.message}`);
    if (last && !String(last).startsWith('ERR')) return last;
    await sleep(80);
  }
  throw new Error(`timeout waiting for ${label} (last: ${JSON.stringify(last)})`);
}

// ------------------------------------------------------------------ fixture: a small git project
const MAIN_HEAD = "// Entry point\nimport { phase } from './moon.js';\n\nexport function greet(name) {\n  const count = 42;\n  return `Bonjour ${name}, phase ${phase(count)}`;\n}\n\nconsole.log(greet('Selene'));\n";
const MAIN_WORK = MAIN_HEAD.replace('const count = 42;', 'const count = 7;').concat('// fin\n');
function makeProject(home, name = 'lune') {
  const dir = path.join(home, 'Projets', name);
  const w = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  w('.gitignore', 'node_modules/\ndist/\n*.log\n');
  w('README.md', '# Lune\n\nLa lune brille. Une lune, deux lunes.\n');
  w('src/main.js', MAIN_HEAD);
  w('src/moon.js', "export const lune = 'pleine lune';\nexport const LUNE = 1;\n");
  w('src/util.js', '// la lune\nexport function lunaire(x) {\n  return `lune ${x}`;\n}\n');
  w('notes/todo.txt', 'Penser à la lune.\n');
  w('dist/bundle.js', 'lune dist\n');
  w('node_modules/pkg/index.js', 'lune module\n');
  w('debug.log', 'lune log\n');
  const git = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.org', ...a], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  w('src/main.js', MAIN_WORK); // two separate changes against HEAD
  return dir;
}
const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');

const s = await launchShell({ lang: 'fr', theme: 'dark', size: '1280x720' });
const errors = [];
s.page.on('console', (m) => {
  if (m.type() === 'error' && !/favicon|ERR_FILE_NOT_FOUND|net::/.test(m.text())) errors.push(m.text());
});
s.page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
const project = makeProject(s.home);
const other = path.join(s.home, 'Projets', 'autre');
fs.mkdirSync(other, { recursive: true });
fs.writeFileSync(path.join(other, 'a.txt'), 'autre\n');

const results = () => C(s, (a) => a.search.results.filter((f) => f.matches.length > f.dismissed.size).map((f) => [f.rel, f.matches.length - f.dismissed.size]));
const statusText = () => C(s, (a) => a.search.statusText.textContent);

try {
  await section('launch, open the folder; Ctrl+Shift+F shows « Rechercher dans les fichiers »', async () => {
    await s.aurora(() => window.__aurora.shell.launch('code'));
    await until(s, (a) => a && a.view && a.search, { label: 'app' });
    await C(s, (a) => a.win.maximize());
    await C(s, (a, dir) => a.openFolder(dir), project);
    await until(s, (a) => document.querySelectorAll('.app-code .code-row').length > 3, { label: 'tree' });
    await C(s, (a) => a.treeEl.focus());
    await s.page.keyboard.press('Control+Shift+F');
    const v = await until(s, (a) => a.side.dataset.view === 'search' && document.activeElement === a.search.queryInput && {
      title: a.search.el.querySelector('.code-side-title').textContent,
      ph: a.search.queryInput.placeholder,
      opts: a.search.optBtns.map((b) => b.getAttribute('aria-label')),
      act: [...document.querySelectorAll('.app-code .code-act')].map((b) => [b.dataset.view, b.getAttribute('aria-selected')]),
      explorerShown: getComputedStyle(a.explorerEl).display !== 'none',
    }, { label: 'search view' });
    check('search view title (FR)', v.title, 'Recherche');
    check('search region name (FR)', await C(s, (a) => a.search.el.getAttribute('aria-label')), 'Rechercher dans les fichiers');
    check('query placeholder', v.ph, 'Rechercher');
    check('option labels (FR)', v.opts, ['Respecter la casse (Alt+C)', 'Mot entier (Alt+W)', 'Expression régulière (Alt+R)']);
    check('activity bar: search selected', v.act, [['explorer', 'false'], ['search', 'true']]);
    check('explorer hidden while searching', v.explorerShown, false);
  });

  await section('search: typing streams results grouped by file, .gitignore respected, match highlighted', async () => {
    await s.page.keyboard.type('lune');
    await until(s, (a) => a.search.status === 'done' && a.search.results.length >= 4, { label: 'results' });
    check('results by file (sorted, ignored files left out)', await results(), [['README.md', 4], ['notes/todo.txt', 1], ['src/moon.js', 3], ['src/util.js', 2]]);
    check('count line (FR plural)', await statusText(), '10 résultats dans 4 fichiers');
    const dom = await C(s, () => ({
      files: [...document.querySelectorAll('.app-code .code-sfile .code-srow-file')].map((r) => [r.querySelector('.code-sname').textContent, r.querySelector('.code-sdir')?.textContent || '', r.querySelector('.code-scount').textContent]),
      marks: [...document.querySelectorAll('.app-code .code-sfile[data-path$="README.md"] mark.code-shit')].map((m) => m.textContent),
      lines: [...document.querySelectorAll('.app-code .code-sfile[data-path$="README.md"] .code-sline-no')].map((m) => m.textContent),
      preview: document.querySelector('.app-code .code-sfile[data-path$="todo.txt"] .code-spreview')?.textContent,
    }));
    check('file rows: name, folder, count', dom.files, [['README.md', '', '4'], ['todo.txt', 'notes', '1'], ['moon.js', 'src', '3'], ['util.js', 'src', '2']]);
    check('matches highlighted', dom.marks, ['Lune', 'lune', 'lune', 'lune']);
    check('line numbers', dom.lines, ['1', '3', '3', '3']);
    check('line preview', dom.preview, 'Penser à la lune.');
    check('result list is a tree', await C(s, () => document.querySelectorAll('.app-code .code-slist [role=treeitem]').length), 4 + 10);
  });

  await section('search options: match case, whole word, regex, include / exclude, .gitignore off', async () => {
    await s.page.click('.app-code [data-act="opt-case"]');
    await until(s, (a) => a.search.status === 'done' && a.search.opts.matchCase, { label: 'case' });
    check('match case', await results(), [['README.md', 3], ['notes/todo.txt', 1], ['src/moon.js', 2], ['src/util.js', 2]]);
    check('toggle pressed', await C(s, () => document.querySelector('.app-code [data-act="opt-case"]').getAttribute('aria-pressed')), 'true');
    await C(s, (a) => a.search.search('lune', { matchCase: false, wholeWord: true }));
    check('whole word (« lunes » left out)', await results(), [['README.md', 3], ['notes/todo.txt', 1], ['src/moon.js', 3], ['src/util.js', 2]]);
    await C(s, (a) => a.search.search('^export', { wholeWord: false, regex: true }));
    check('regular expression', await results(), [['src/main.js', 1], ['src/moon.js', 2], ['src/util.js', 1]]);
    await C(s, (a) => a.search.search('lune(', {}));
    check('invalid expression reported', await statusText(), (t) => t.startsWith('Expression régulière non valide'));
    check('error styled', await C(s, (a) => a.search.statusEl.classList.contains('error')), true);
    await C(s, (a) => a.search.search('lune', { regex: false, include: 'src/' }));
    check('files to include', await results(), [['src/moon.js', 3], ['src/util.js', 2]]);
    await C(s, (a) => a.search.search('lune', { include: '', exclude: '*.md, notes' }));
    check('files to exclude', await results(), [['src/moon.js', 3], ['src/util.js', 2]]);
    await C(s, (a) => a.search.setOpt('showFilters', true));
    check('filter fields shown with their labels', await C(s, (a) => [...a.search.filters.querySelectorAll('.code-slabel > span, .code-signore > span')].map((x) => x.textContent)), [
      'Fichiers à inclure',
      'Fichiers à exclure',
      'Ignorer les fichiers listés dans .gitignore et node_modules',
    ]);
    await C(s, (a) => a.search.search('lune', { exclude: '', useIgnore: false }));
    check('.gitignore off: dist, node_modules and logs searched', await results(), (r) => ['debug.log', 'dist/bundle.js', 'node_modules/pkg/index.js'].every((x) => r.some(([p]) => p === x)));
    await C(s, (a) => a.search.search('lune', { useIgnore: true }));
    check('.gitignore on again', await results(), [['README.md', 4], ['notes/todo.txt', 1], ['src/moon.js', 3], ['src/util.js', 2]]);
    await s.page.click('.app-code .code-search input[name="useIgnore"]');
    await until(s, (a) => a.search.status === 'done' && !a.search.opts.useIgnore, { label: 'checkbox' });
    check('the checkbox turns it off', (await results()).length, 7);
    await s.page.click('.app-code .code-search input[name="useIgnore"]');
    await until(s, (a) => a.search.status === 'done' && a.search.opts.useIgnore, { label: 'checkbox on' });
    await C(s, (a) => a.search.setOpt('showFilters', false));
  });

  await section('click a result: the file opens at the match, selected', async () => {
    await s.page.click('.app-code .code-sfile[data-path$="src/util.js"] .code-srow-match >> nth=1');
    const o = await until(s, (a) => a.active?.name === 'util.js' && (() => {
      const st = a.view.state;
      const sel = st.selection.main;
      const line = st.doc.lineAt(sel.from);
      return { line: line.number, col: sel.from - line.from, text: st.sliceDoc(sel.from, sel.to), focus: a.view.hasFocus };
    })(), { label: 'opened' });
    check('opened at line 3, column 10, match selected', o, { line: 3, col: 10, text: 'lune', focus: true });
    // keyboard: Down then Enter in the list opens the next match
    await C(s, (a) => a.search.list.querySelector('.code-sfile[data-path$="README.md"] .code-srow-file').focus());
    await s.page.keyboard.press('ArrowDown');
    await s.page.keyboard.press('Enter');
    const k = await until(s, (a) => a.active?.name === 'README.md' && a.view.state.sliceDoc(a.view.state.selection.main.from, a.view.state.selection.main.to), { label: 'keyboard open' });
    check('keyboard: Enter on a match opens it', k, 'Lune');
  });

  await section('stop a long search', async () => {
    for (let i = 0; i < 80; i++) {
      fs.mkdirSync(path.join(project, 'many'), { recursive: true });
      fs.writeFileSync(path.join(project, 'many', `f${String(i).padStart(2, '0')}.txt`), 'lune\n');
    }
    await C(s, (a) => {
      a.search.testDelay = 40;
      a.search.search('lune', {});
    });
    await until(s, (a) => a.search.status === 'running' && a.search.results.length >= 3, { label: 'running' });
    const running = await C(s, (a) => ({ stop: !a.search.stopBtn.hidden, text: a.search.statusText.textContent, label: a.search.stopBtn.textContent }));
    check('stop button while running', running.stop, true);
    check('stop label (FR)', running.label, 'Arrêter');
    check('progress text', running.text, (t) => t.startsWith('Recherche en cours…'));
    await s.page.click('.app-code [data-act="search-stop"]');
    const done = await until(s, (a) => a.search.status === 'done' && { cancelled: a.search.summary.cancelled, files: a.search.results.length, text: a.search.statusText.textContent, stop: a.search.stopBtn.hidden }, { label: 'stopped' });
    check('search stopped', done.cancelled, true);
    check('fewer files than all', done.files, (n) => n < 84);
    check('stopped text', done.text, (t) => t.startsWith('Recherche arrêtée :'));
    check('stop button hidden again', done.stop, true);
    await C(s, (a) => (a.search.testDelay = 0));
    fs.rmSync(path.join(project, 'many'), { recursive: true, force: true });
  });

  await section('replace across files: preview, one match, one file, all (as previewed), open buffers, undo', async () => {
    // moon.js open and clean, README.md open with an unsaved line
    await C(s, async (a, dir) => {
      for (const t of [...a.allTabs()]) await a.closeTab(t, true);
      await a.openFile(`${dir}/src/moon.js`);
      const tab = await a.openFile(`${dir}/README.md`);
      const v = a.liveView(tab);
      v.dispatch({ changes: { from: v.state.doc.length, insert: 'Nouvelle ligne : lune.\n' } });
    }, project);
    check('README dirty in the editor', await C(s, (a) => a.docByPath(`${a.folder}/README.md`).dirty), true);
    await C(s, (a) => a.search.setOpt('showReplace', true));
    await C(s, (a) => a.search.search('lune', { matchCase: true, wholeWord: true, regex: false }));
    await s.page.fill('.app-code .code-search input[name="replace"]', 'Séléné');
    await until(s, (a) => a.search.opts.replace === 'Séléné' && document.querySelector('.app-code .code-search ins.code-srep'), { label: 'preview' });
    const pv = await C(s, () => ({
      del: [...document.querySelectorAll('.app-code .code-sfile[data-path$="todo.txt"] del.code-shit')].map((x) => x.textContent),
      ins: [...document.querySelectorAll('.app-code .code-sfile[data-path$="todo.txt"] ins.code-srep')].map((x) => x.textContent),
      all: document.querySelector('.app-code [data-act="replace-all"]').textContent,
    }));
    check('preview: old text struck, new text inserted', [pv.del, pv.ins], [['lune'], ['Séléné']]);
    check('« Remplacer tout » (FR)', pv.all, 'Remplacer tout');
    check('the README buffer is searched (its unsaved line too)', await results(), [['README.md', 3], ['notes/todo.txt', 1], ['src/moon.js', 2], ['src/util.js', 2]]);
    // one match: the second one of util.js
    const before = { util: read(project, 'src/util.js'), todo: read(project, 'notes/todo.txt'), moon: read(project, 'src/moon.js'), readme: read(project, 'README.md') };
    await C(s, (a) => a.search.replaceMatch(a.search.results.find((f) => f.rel === 'src/util.js'), 1));
    check('one match replaced on disk', read(project, 'src/util.js'), before.util.replace('`lune ', '`Séléné '));
    check('the other match of the file kept', read(project, 'src/util.js').includes('// la lune'), true);
    // dismiss the remaining util.js match, then « Remplacer tout » with its confirmation
    await until(s, (a) => a.search.status === 'done' && a.search.results.some((f) => f.rel === 'src/util.js'), { label: 'searched again' });
    await C(s, (a) => a.search.dismiss(a.search.results.find((f) => f.rel === 'src/util.js'), 0));
    check('dismissed file left out', await results(), [['README.md', 3], ['notes/todo.txt', 1], ['src/moon.js', 2]]);
    const preview = await C(s, (a) => a.search.results.filter((f) => f.rel === 'notes/todo.txt').map((f) => f.matches.map((m) => ({ line: m.line, col: m.col, len: m.len, rep: a.search.repOf(m) }))));
    // todo.txt opened in the editor after the search: replaced on disk, its tab shows the new text
    await C(s, (a, dir) => a.openFile(`${dir}/notes/todo.txt`), project);
    await s.page.click('.app-code [data-act="replace-all"]');
    const conf = await until(s, () => document.querySelector('.dialog')?.textContent, { label: 'confirm' });
    check('confirmation text (FR)', conf, (t) => t.includes('Remplacer 6 occurrences dans 3 fichiers par « Séléné » ?'));
    await s.page.click('.dialog .dialog-footer .btn.primary');
    await until(s, (a) => a.search.status === 'done' && !a.search.busy && a.search.message, { label: 'replaced' });
    // the disk file changed exactly as previewed
    const lines = before.todo.split('\n');
    for (const m of [...preview[0]].reverse()) lines[m.line - 1] = lines[m.line - 1].slice(0, m.col) + m.rep + lines[m.line - 1].slice(m.col + m.len);
    check('todo.txt on disk = the preview', read(project, 'notes/todo.txt'), lines.join('\n'));
    check('util.js: the dismissed match kept', read(project, 'src/util.js'), before.util.replace('`lune ', '`Séléné '));
    check('todo.txt tab (opened after the search) shows the file as written, not unsaved', await C(s, (a) => {
      const d = a.docByPath(`${a.folder}/notes/todo.txt`);
      return [a.docText(d).toString(), d.dirty];
    }), [lines.join('\n'), false]);
    check('moon.js (open, clean): changed in the editor and saved', [read(project, 'src/moon.js'), await C(s, (a) => a.docByPath(`${a.folder}/src/moon.js`).dirty)], [before.moon.replaceAll("'pleine lune'", "'pleine Séléné'").replace('const lune', 'const Séléné'), false]);
    check('README (unsaved): only its buffer changed', [read(project, 'README.md'), await C(s, (a) => a.docText(a.docByPath(`${a.folder}/README.md`)).toString())], [
      before.readme,
      '# Lune\n\nLa Séléné brille. Une Séléné, deux lunes.\nNouvelle ligne : Séléné.\n',
    ]);
    check('message (FR)', await C(s, (a) => a.search.message), (m) => m.startsWith('6 occurrences remplacées dans 3 fichiers.') && m.includes('enregistrez-le'));
    check('undo offered', await C(s, (a) => !a.search.undoBtn.hidden && a.search.undoBtn.textContent), 'Annuler le remplacement');
    // undo: disk files back, buffers back
    await s.page.click('.app-code [data-act="replace-undo"]');
    await until(s, (a) => a.search.status === 'done' && !a.search.busy && a.search.message === 'Remplacement annulé.', { label: 'undone' });
    check('undo: todo.txt back', read(project, 'notes/todo.txt'), before.todo);
    check('undo: its tab too', await C(s, (a) => a.docText(a.docByPath(`${a.folder}/notes/todo.txt`)).toString()), before.todo);
    check('undo: moon.js back on disk', read(project, 'src/moon.js'), before.moon);
    check('undo: README buffer back (the unsaved line kept)', await C(s, (a) => a.docText(a.docByPath(`${a.folder}/README.md`)).toString()), '# Lune\n\nLa lune brille. Une lune, deux lunes.\nNouvelle ligne : lune.\n');
    // replace in one file, then Ctrl+Z in that file's editor undoes it
    await C(s, (a) => a.search.replaceFile(a.search.results.find((f) => f.rel === 'README.md')));
    check('replace in one file (README buffer)', await C(s, (a) => a.docText(a.docByPath(`${a.folder}/README.md`)).toString()), '# Lune\n\nLa Séléné brille. Une Séléné, deux lunes.\nNouvelle ligne : Séléné.\n');
    await C(s, async (a) => {
      const tab = a.allTabs().find((x) => x.name === 'README.md');
      a.activate(tab);
    });
    await s.page.keyboard.press('Control+z');
    check('Ctrl+Z in the editor undoes it', await C(s, (a) => a.view.state.doc.toString()), '# Lune\n\nLa lune brille. Une lune, deux lunes.\nNouvelle ligne : lune.\n');
    await C(s, (a) => a.search.setOpt('showReplace', false));
    // throw the unsaved line away
    await C(s, async (a) => {
      for (const t of [...a.allTabs()]) await a.closeTab(t, true);
    });
  });

  await section('screenshots: search FR dark + light', async () => {
    await C(s, (a) => {
      a.search.setOpt('showReplace', true);
      a.search.opts.replace = 'Séléné';
      a.search.syncControls();
      return a.search.search('lune', { matchCase: false, wholeWord: false });
    });
    await C(s, (a) => a.openAt(`${a.folder}/src/moon.js`, 1, 13, 4));
    await sleep(400);
    fs.copyFileSync(await s.shot('code-search-fr-dark'), path.join(DOCS, 'code-search-fr-dark.png'));
    await s.aurora(() => window.__aurora.settings.set('theme', 'light'));
    await sleep(900);
    const light = await C(s, () => {
      const ins = getComputedStyle(document.querySelector('.app-code ins.code-srep'));
      const row = getComputedStyle(document.querySelector('.app-code .code-srow-match'));
      return { insBg: ins.backgroundColor, text: row.color };
    });
    check('light: dark result text', light.text, (c) => c.match(/\d+/g).slice(0, 3).map(Number).reduce((x, y) => x + y, 0) < 300);
    check('light: inserted text tinted', light.insBg, (c) => c !== 'rgba(0, 0, 0, 0)');
    await s.shot('code-search-fr-light');
    await s.aurora(() => window.__aurora.settings.set('theme', 'dark'));
    await sleep(600);
    await C(s, (a) => {
      a.search.setOpt('showReplace', false);
      a.setSideView('explorer');
    });
  });

  await section('split view: Ctrl+\\, one document in both panes stays the same (edits, undo)', async () => {
    await C(s, async (a) => {
      for (const t of [...a.allTabs()]) await a.closeTab(t, true);
      await a.openFile(`${a.folder}/src/moon.js`);
    });
    await C(s, (a) => a.view.focus());
    await s.page.keyboard.press('Control+Backslash');
    await until(s, (a) => a.panes.length === 2 && a.panes[1].active, { label: 'split' });
    const g = await C(s, (a) => {
      const [p0, p1] = a.panes.map((p) => p.el.getBoundingClientRect());
      return {
        cls: a.panesEl.className,
        sideBySide: p1.left >= p0.right - 1 && Math.abs(p0.top - p1.top) < 2 && p0.width > 200 && p1.width > 200,
        sameDoc: a.panes[0].active.doc === a.panes[1].active.doc,
        focused: a.panes.indexOf(a.focused),
        names: a.panes.map((p) => p.tabs.map((t) => t.name)),
      };
    });
    check('two panes side by side', [g.cls, g.sideBySide], ['code-panes split-right', true]);
    check('the same document in both', g.sameDoc, true);
    check('the new pane has the focus', g.focused, 1);
    check('tabs of each pane', g.names, [['moon.js'], ['moon.js']]);
    // type in pane 1 (the left one): the right one follows
    await C(s, (a) => {
      const v = a.panes[0].view;
      v.dispatch({ selection: { anchor: 0 } });
      v.focus();
    });
    await s.page.keyboard.type('// A\n');
    const sync = await C(s, (a) => ({ left: a.panes[0].view.state.doc.toString(), right: a.panes[1].view.state.doc.toString(), dirty: [...document.querySelectorAll('.app-code .code-tab')].map((t) => t.classList.contains('dirty')) }));
    check('typed text in both panes', [sync.left.startsWith('// A\n'), sync.left === sync.right], [true, true]);
    check('both tabs show unsaved', sync.dirty, [true, true]);
    // the right pane has its own cursor
    check('own selection per pane', await C(s, (a) => [a.panes[0].view.state.selection.main.head, a.panes[1].view.state.selection.main.head]), (x) => x[0] === 5 && x[1] !== 5);
    for (let i = 0; i < 3; i++) await s.page.keyboard.press('Control+z');
    check('undo in the left pane: both back, not dirty', await C(s, (a, dir) => [a.panes[1].view.state.doc.toString(), a.docByPath(`${dir}/src/moon.js`).dirty], project), [read(project, 'src/moon.js'), false]);
    // an edit in the right pane reaches the left tab while it is hidden
    await C(s, (a, dir) => a.openFile(`${dir}/src/util.js`, { pane: a.panes[0] }), project);
    await C(s, (a) => {
      const v = a.panes[1].view;
      v.dispatch({ changes: { from: v.state.doc.length, insert: '// B\n' }, userEvent: 'input' });
    });
    await C(s, (a) => a.activate(a.panes[0].tabs.find((t) => t.name === 'moon.js')));
    check('a hidden tab gets the changes of the other pane', await C(s, (a) => a.panes[0].view.state.doc.toString().endsWith('// B\n')), true);
    await C(s, (a) => a.save());
    check('saved once for both', [read(project, 'src/moon.js').endsWith('// B\n'), await C(s, () => document.querySelectorAll('.app-code .code-tab.dirty').length)], [true, 0]);
  });

  await section('split view: Ctrl+1 / Ctrl+2, move a tab (menu, drag), close a pane, split down', async () => {
    await s.page.keyboard.press('Control+Digit2');
    check('Ctrl+2 focuses the right pane', await C(s, (a) => [a.panes.indexOf(a.focused), a.panes[1].el.contains(document.activeElement)]), [1, true]);
    await s.page.keyboard.press('Control+Digit1');
    check('Ctrl+1 focuses the left pane', await C(s, (a) => [a.panes.indexOf(a.focused), a.panes[0].el.contains(document.activeElement), a.panes[0].el.classList.contains('focused')]), [0, true, true]);
    check('the other pane looks unfocused', await C(s, (a) => a.panes[1].el.classList.contains('focused')), false);
    // move util.js (left) to the right pane through the tab menu
    await s.page.click('.app-code .code-pane >> nth=0 >> .code-tab:has-text("util.js")', { button: 'right' });
    await until(s, () => document.querySelector('.menu'), { label: 'tab menu' });
    const items = await C(s, () => [...document.querySelectorAll('.menu .menu-item, .menu [role=menuitem]')].map((x) => x.textContent.trim()).filter(Boolean));
    check('tab menu (FR)', items, (x) => ['Déplacer dans l\'autre volet', 'Fractionner à droite', 'Fractionner vers le bas', 'Comparer avec HEAD', 'Comparer avec le fichier enregistré'].every((w) => x.some((i) => i.startsWith(w))));
    await s.page.click('.menu >> text=Déplacer dans l\'autre volet');
    const mv = await until(s, (a) => a.panes[1].tabs.some((t) => t.name === 'util.js') && a.panes.map((p) => p.tabs.map((t) => t.name)), { label: 'moved' });
    check('util.js moved to the right pane', mv, [['moon.js'], ['moon.js', 'util.js']]);
    check('the moved tab is active and focused there', await C(s, (a) => [a.focused === a.panes[1], a.panes[1].active.name]), [true, 'util.js']);
    // drag util.js back onto the left tab strip
    await s.page.dragAndDrop('.app-code .code-pane >> nth=1 >> .code-tab:has-text("util.js")', '.app-code .code-pane >> nth=0 >> .code-tabs');
    const dr = await until(s, (a) => a.panes[0].tabs.some((t) => t.name === 'util.js') && a.panes.map((p) => p.tabs.map((t) => t.name)), { label: 'dragged', timeout: 4000 }).catch(() => null);
    check('drag a tab to the other pane', dr, [['moon.js', 'util.js'], ['moon.js']]);
    // a document already open there: its tab stays, the moved one goes
    await C(s, (a) => a.moveTab(a.panes[1].tabs[0], a.panes[0]));
    check('moving a document open in both: one tab left', await C(s, (a) => a.panes.map((p) => p.tabs.map((t) => t.name))), [['moon.js', 'util.js']]);
    check('the emptied pane closed', await C(s, (a) => [a.panes.length, a.panesEl.querySelectorAll('.code-pane').length, a.root.classList.contains('two-panes')]), [1, 1, false]);
    // split down, then « Fermer le volet » gathers the tabs
    await C(s, (a) => a.splitEditor('down'));
    await C(s, (a, dir) => a.openFile(`${dir}/notes/todo.txt`), project);
    const down = await C(s, (a) => {
      const [p0, p1] = a.panes.map((p) => p.el.getBoundingClientRect());
      return { cls: a.panesEl.className, below: p1.top >= p0.bottom - 1 && Math.abs(p0.left - p1.left) < 2 };
    });
    check('split down: one above the other', [down.cls, down.below], ['code-panes split-down', true]);
    await sleep(300);
    await s.shot('code-split-down-fr-dark');
    await C(s, (a) => a.closePane(a.panes[1]));
    check('close the pane: its tabs join the other one', await C(s, (a) => [a.panes.length, a.tabs.map((t) => t.name)]), [1, ['moon.js', 'util.js', 'todo.txt']]);
  });

  await section('split view: the layout is remembered per folder', async () => {
    await C(s, async (a) => {
      for (const t of [...a.allTabs()]) await a.closeTab(t, true);
      await a.openFile(`${a.folder}/src/moon.js`);
      await a.openFile(`${a.folder}/notes/todo.txt`);
      a.splitEditor('down');
      await a.openFile(`${a.folder}/README.md`);
      a.ratio = 0.4;
      a.applyRatio();
      a.saveLayoutNow();
    });
    // another folder: its own (empty) layout
    await C(s, (a, dir) => a.openFolder(dir), other);
    check('another folder: its own layout', await C(s, (a) => a.prefs.layouts[a.folder] == null), true);
    await C(s, async (a) => {
      for (const t of [...a.allTabs()]) await a.closeTab(t, true);
    });
    await C(s, (a, dir) => a.openFolder(dir), project);
    const back = await until(s, (a) => a.panes.length === 2 && {
      split: a.split,
      panes: a.panes.map((p) => p.tabs.map((t) => t.name)),
      active: a.panes.map((p) => p.active?.name),
      ratio: a.ratio,
    }, { label: 'layout back' });
    check('layout restored on reopening the folder', back, { split: 'down', panes: [['moon.js', 'todo.txt'], ['todo.txt', 'README.md']], active: ['todo.txt', 'README.md'], ratio: 0.4 });
    // and after closing the window
    await C(s, (a) => a.win.close());
    await until(s, () => !document.querySelector('.win.app-code') || null, { label: 'closed' }).catch(() => {});
    await sleep(400);
    await s.aurora(() => window.__aurora.shell.launch('code'));
    const again = await until(s, (a) => a && a.folder && a.panes.length === 2 && a.panes[1].tabs.length === 2 && a.panes.map((p) => p.tabs.map((t) => t.name)), { label: 'relaunch', timeout: 15000 });
    check('layout restored after closing the window', again, [['moon.js', 'todo.txt'], ['todo.txt', 'README.md']]);
    await C(s, (a) => a.win.maximize());
    await C(s, (a) => a.closePane(a.panes[1]));
  });

  await section('compare with HEAD: side by side, next / previous change, revert a change', async () => {
    // main.js is open in the editor; the comparison's right side is the same document
    await C(s, async (a) => {
      for (const t of [...a.allTabs()]) await a.closeTab(t, true);
      await a.openFile(`${a.folder}/src/main.js`);
    });
    // from the tree: « Comparer avec HEAD » on the modified file
    await s.page.click('.app-code .code-row[data-path$="/src"]');
    await until(s, () => document.querySelector('.app-code .code-row[data-path$="/src/main.js"]'), { label: 'src open' });
    await s.page.click('.app-code .code-row[data-path$="/src/main.js"]', { button: 'right' });
    await until(s, () => document.querySelector('.menu'), { label: 'tree menu' });
    await s.page.click('.menu >> text=Comparer avec HEAD');
    const d = await until(s, (a) => a.active?.kind === 'diff' && a.active.diff.mv && {
      title: a.active.name,
      tip: document.querySelector('.app-code .code-tab.active').title,
      heads: [...a.active.diff.heads.querySelectorAll('.code-diff-side')].map((x) => x.textContent),
      a: a.active.diff.mv.a.state.doc.toString(),
      b: a.active.diff.mv.b.state.doc.toString(),
      count: a.active.diff.countEl.textContent,
      changed: [document.querySelectorAll('.app-code .cm-merge-a .cm-changedLine').length, document.querySelectorAll('.app-code .cm-merge-b .cm-changedLine').length],
      readOnly: a.active.diff.mv.a.state.readOnly,
      arrows: document.querySelectorAll('.app-code .cm-merge-revert .code-diff-arrow').length,
    }, { label: 'diff' });
    check('tab title', d.title, 'main.js (HEAD)');
    check('tab tip (FR)', d.tip, (t) => t.endsWith('src/main.js comparé avec sa version dans HEAD'));
    check('labels over the two sides', d.heads, ['HEAD', 'Copie de travail']);
    check('left side = HEAD (read only)', [d.a, d.readOnly], [MAIN_HEAD, true]);
    check('right side = the working copy', d.b, MAIN_WORK);
    check('two changes', d.count, '2 modifications');
    check('changed lines marked on both sides', d.changed, (x) => x[0] >= 1 && x[1] >= 2);
    check('revert arrows between the sides', d.arrows, 2);
    // F7 / Shift+F7
    await C(s, (a) => a.active.diff.editView.focus());
    await s.page.keyboard.press('F7');
    const n1 = await C(s, (a) => [a.active.diff.countEl.textContent, a.view.state.doc.lineAt(a.view.state.selection.main.head).number]);
    check('F7: first change', n1, ['Modification 1 sur 2', 5]);
    await s.page.keyboard.press('F7');
    check('F7: second change', await C(s, (a) => [a.active.diff.countEl.textContent, a.view.state.doc.lineAt(a.view.state.selection.main.head).number]), ['Modification 2 sur 2', 10]);
    await s.page.keyboard.press('Shift+F7');
    check('Shift+F7: back to the first', await C(s, (a) => a.active.diff.countEl.textContent), 'Modification 1 sur 2');
    // revert the change under the cursor (the bar's button)
    await s.page.click('.app-code .code-diff:not([hidden]) [data-act="diff-revert"]');
    const r = await C(s, (a) => ({ b: a.active.diff.mv.b.state.doc.toString(), count: a.active.diff.countEl.textContent, dirty: a.active.doc.dirty }));
    check('change reverted', r.b, MAIN_HEAD.concat('// fin\n'));
    check('one change left', r.count, (t) => t === '1 modification' || t === 'Modification 1 sur 1');
    check('the document is now unsaved', r.dirty, true);
    check('the main.js tab has the same text', await C(s, (a) => a.docText(a.active.doc).toString() === a.active.diff.mv.b.state.doc.toString() && a.tabState(a.tabs.find((t) => t.kind === 'file' && t.name === 'main.js')).doc.toString()), MAIN_HEAD.concat('// fin\n'));
    // and the revert arrow between the sides for the other one
    await C(s, (a) => a.active.diff.mv.scheduleMeasure());
    await sleep(200);
    await s.page.dispatchEvent('.app-code .cm-merge-revert .code-diff-arrow', 'mousedown');
    check('revert arrow: no difference left', await C(s, (a) => [a.active.diff.mv.b.state.doc.toString(), a.active.diff.countEl.textContent]), [MAIN_HEAD, 'Aucune différence']);
    // undo in the comparison: both changes back
    await C(s, (a) => a.active.diff.editView.focus());
    await s.page.keyboard.press('Control+z');
    check('Ctrl+Z in the comparison', await C(s, (a) => a.active.diff.chunks().length), 1);
    await s.page.keyboard.press('Control+z');
    check('Ctrl+Z again: two changes', await C(s, (a) => [a.active.diff.chunks().length, a.active.diff.mv.b.state.doc.toString()]), [2, MAIN_WORK]);
  });

  await section('compare with HEAD: inline mode, its revert button; screenshots', async () => {
    await C(s, (a) => a.active.diff.setMode('inline'));
    const inl = await until(s, (a) => a.active.diff.uv && {
      heads: a.active.diff.heads.hidden,
      what: a.active.diff.titleEl.textContent,
      deleted: document.querySelectorAll('.app-code .code-diff:not([hidden]) .cm-deletedChunk').length,
      btn: document.querySelector('.app-code .code-diff:not([hidden]) .cm-deletedChunk .code-diff-chunk-revert')?.textContent,
      mode: [...a.active.diff.modeSeg.querySelectorAll('button')].map((b) => b.getAttribute('aria-pressed')),
    }, { label: 'inline' });
    check('inline: one column, « HEAD ↔ Copie de travail » in the bar', [inl.heads, inl.what], [true, 'HEAD ↔ Copie de travail']);
    check('inline: deleted lines shown with a revert button', [inl.deleted >= 1, inl.btn], [true, 'Annuler']);
    check('mode buttons pressed state', inl.mode, ['false', 'true']);
    check('the same two changes inline', await C(s, (a) => [a.active.diff.chunks().length, a.view.state.doc.toString()]), [2, MAIN_WORK]);
    await s.page.dispatchEvent('.app-code .code-diff:not([hidden]) .cm-deletedChunk .code-diff-chunk-revert >> nth=0', 'mousedown');
    check('inline revert button', await C(s, (a) => [a.active.diff.chunks().length, a.view.state.doc.toString().includes('const count = 42;')]), [1, true]);
    // (a mode switch starts a new undo history for the comparison: put the change back by hand)
    await C(s, (a) => {
      const v = a.view;
      const i = v.state.doc.toString().indexOf('count = 42');
      v.dispatch({ changes: { from: i + 8, to: i + 10, insert: '7' } });
    });
    check('two changes for the pictures', await C(s, (a) => a.active.diff.chunks().length), 2);
    await sleep(300);
    await s.shot('code-diff-inline-fr-dark');
    await C(s, (a) => a.active.diff.setMode('split'));
    // the file on the left, its comparison on the right
    await C(s, (a) => a.moveTab(a.active));
    await C(s, (a) => {
      a.split = 'right';
      a.applySplit();
    });
    await C(s, (a) => a.panes[0].view.dispatch({ selection: { anchor: 0 } }));
    await sleep(500);
    fs.copyFileSync(await s.shot('code-diff-fr-dark'), path.join(DOCS, 'code-diff-fr-dark.png'));
    await s.aurora(() => window.__aurora.settings.set('theme', 'light'));
    await sleep(900);
    const col = await C(s, () => ({
      a: getComputedStyle(document.querySelector('.app-code .cm-merge-a .cm-changedLine')).backgroundColor,
      b: getComputedStyle(document.querySelector('.app-code .cm-merge-b .cm-changedLine')).backgroundColor,
    }));
    check('light: removed and added lines tinted differently', col.a !== col.b && !/rgba\(0, 0, 0, 0\)/.test(col.a), true);
    await s.shot('code-diff-fr-light');
    await s.aurora(() => window.__aurora.settings.set('theme', 'dark'));
    await sleep(600);
    await C(s, async (a) => {
      for (const t of [...a.allTabs()]) await a.closeTab(t, true);
    });
  });

  await section('compare with the saved file (unsaved changes), and two files', async () => {
    const tab = await C(s, async (a) => {
      const t = await a.openFile(`${a.folder}/notes/todo.txt`);
      const v = a.liveView(t);
      v.dispatch({ changes: { from: 0, insert: 'Ajout non enregistré\n' } });
      await a.compareSaved(t.doc);
      return { name: a.active.name, kind: a.active.kind };
    });
    check('unsaved vs saved: a comparison tab', tab, { name: 'todo.txt (enregistré)', kind: 'diff' });
    const u = await C(s, (a) => ({ heads: [...a.active.diff.heads.querySelectorAll('.code-diff-side')].map((x) => x.textContent), count: a.active.diff.countEl.textContent, a: a.active.diff.mv.a.state.doc.toString() }));
    check('labels', u.heads, ['Fichier enregistré', 'Modifications non enregistrées']);
    check('the saved text on the left, one change', [u.a, u.count], [read(project, 'notes/todo.txt'), 'Modification 1 sur 1']);
    await s.page.keyboard.press('Control+s');
    await until(s, (a) => !a.active.doc.dirty, { label: 'saved' });
    check('saved: no difference left', await C(s, (a) => a.active.diff.countEl.textContent), 'Aucune différence');
    check('written on disk', read(project, 'notes/todo.txt'), 'Ajout non enregistré\nPenser à la lune.\n');
    // two files: « Sélectionner pour comparer » then « Comparer avec « … » » in the tree
    await C(s, (a, dir) => {
      a.compareFirst = `${dir}/src/moon.js`;
    }, project);
    await s.page.click('.app-code .code-row[data-path$="/src/util.js"]', { button: 'right' });
    await until(s, () => document.querySelector('.menu'), { label: 'menu' });
    await s.page.click('.menu >> text=Comparer avec « moon.js »');
    const two = await until(s, (a) => a.active?.kind === 'diff' && a.active.diff.source === 'file' && {
      name: a.active.name,
      heads: [...a.active.diff.heads.querySelectorAll('.code-diff-side')].map((x) => x.textContent),
      left: a.active.diff.mv.a.state.doc.toString(),
      right: a.active.diff.mv.b.state.doc.toString(),
    }, { label: 'two files' });
    check('two files: title and labels', [two.name, two.heads], ['moon.js ↔ util.js', ['moon.js', 'util.js']]);
    check('two files: contents', [two.left, two.right], [read(project, 'src/moon.js'), read(project, 'src/util.js')]);
    await C(s, async (a) => {
      for (const t of [...a.allTabs()]) await a.closeTab(t, true);
    });
  });

  await section('English: search, split view and comparison, light + dark screenshots', async () => {
    await C(s, (a) => a.win.close());
    await sleep(500);
    await s.aurora(() => window.__aurora.settings.set('lang', 'en'));
    await sleep(800);
    await s.aurora(() => window.__aurora.shell.launch('code'));
    await until(s, (a) => a && a.folder, { label: 'relaunch EN', timeout: 15000 });
    await C(s, (a) => a.win.maximize());
    await C(s, async (a) => {
      for (const t of [...a.allTabs()]) await a.closeTab(t, true);
      await a.openFile(`${a.folder}/src/main.js`);
      a.splitEditor('right');
      await a.compareHead(`${a.folder}/src/main.js`);
      a.showSearch();
      a.search.setOpt('showReplace', true);
      a.search.opts.replace = 'Selene';
      a.search.syncControls();
      await a.search.search('lune', { matchCase: false, wholeWord: false, regex: false });
    });
    const en = await C(s, (a) => ({
      title: a.search.el.getAttribute('aria-label'),
      head: a.search.el.querySelector('.code-side-title').textContent,
      status: a.search.statusText.textContent,
      all: a.search.replaceAllBtn.textContent,
      diff: a.active.name,
      count: a.active.diff.countEl.textContent,
      heads: [...a.active.diff.heads.querySelectorAll('.code-diff-side')].map((x) => x.textContent),
    }));
    check('EN strings', en, { title: 'Search in files', head: 'Search', status: '9 results in 4 files', all: 'Replace all', diff: 'main.js (HEAD)', count: '2 changes', heads: ['HEAD', 'Working copy'] });
    await sleep(400);
    await s.shot('code-extra-en-dark');
    await s.aurora(() => window.__aurora.settings.set('theme', 'light'));
    await sleep(900);
    await s.shot('code-extra-en-light');
    await s.aurora(() => window.__aurora.settings.set('theme', 'dark'));
    await sleep(500);
    await C(s, async (a) => {
      for (const t of [...a.allTabs()]) await a.closeTab(t, true);
      a.search.setOpt('showReplace', false);
    });
    await C(s, (a) => a.win.close());
    await sleep(400);
  });

  check('no console errors', errors, []);
} finally {
  await s.close();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  ✗ ${f}`).join('\n'));
  process.exit(1);
}
