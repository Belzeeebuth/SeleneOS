// Code Editor tests (app id "code") — drive the real Electron shell with Playwright.
//   Welcome screen, open a folder (git repository fixture), .gitignore-aware tree (node_modules, dist, *.log, .git
//   hidden; « Afficher les fichiers ignorés »), git status in the tree (modified / new) and the branch in the status bar
//   (main/ipc/code.js), tabs with unsaved dots, Ctrl+S, syntax highlighting + line numbers (CodeMirror 6 vendored
//   bundle), language detection, find / replace with a regex (CodeMirror panel, French phrases), go to line, multi-cursor
//   (Ctrl+D), auto-indent and bracket closing, create / rename / delete to the Recycle Bin, terminal panel on the PTY
//   backend (runs in the opened folder), unsaved-changes prompt on close, French + dark / light screenshots.
// Usage:  cd aurora-os/shell && xvfb-run -a -s "-screen 0 1600x900x24" node test/code.test.mjs
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
    await sleep(100);
  }
  throw new Error(`timeout waiting for ${label} (last: ${JSON.stringify(last)})`);
}

// ------------------------------------------------------------------ fixture: a small git project
function makeProject(home) {
  const dir = path.join(home, 'Projets', 'lune');
  const w = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  w('.gitignore', 'node_modules/\ndist/\n*.log\n');
  w('README.md', '# Lune\n\nA *small* project with [links](https://example.org).\n');
  w(
    'src/main.js',
    `// Entry point\nimport { phase } from './moon.js';\n\nexport function greet(name) {\n  const count = 42;\n  return \`Bonjour \${name}, phase \${phase(count)}\`;\n}\n\nconsole.log(greet('Selene'));\n`,
  );
  w('src/moon.js', 'export const phase = (n) => (n % 8) + 1;\n');
  w('tools/build.py', 'import sys\n\ndef build(target="dist"):\n    """Build the project."""\n    return 0 if target else 1\n\nif __name__ == "__main__":\n    sys.exit(build())\n');
  w('style.css', '.moon {\n  color: #ffcc00;\n  border-radius: 50%;\n}\n');
  w('config.yaml', 'name: lune\nversion: 1\nflags:\n  - fast\n');
  w('package.json', '{\n  "name": "lune",\n  "private": true\n}\n');
  w('scripts/run.sh', '#!/bin/sh\necho "lune $1"\n');
  w('native/moon.c', '#include <stdio.h>\nint main(void) { printf("moon\\n"); return 0; }\n');
  w('native/moon.rs', 'fn main() {\n    println!("moon");\n}\n');
  w('native/moon.go', 'package main\n\nfunc main() {}\n');
  w('node_modules/left-pad/index.js', 'module.exports = 1;\n');
  w('dist/bundle.js', 'console.log(1);\n');
  w('debug.log', 'log\n');
  const git = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.org', ...a], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  // working-tree changes: one modified file, one new file
  fs.appendFileSync(path.join(dir, 'src/main.js'), '// changed\n');
  w('notes.txt', 'à faire\n');
  return dir;
}

// ------------------------------------------------------------------ run
const s = await launchShell({ lang: 'fr', theme: 'dark', size: '1280x720' });
const errors = [];
s.page.on('console', (m) => {
  if (m.type() === 'error' && !/favicon|ERR_FILE_NOT_FOUND|net::/.test(m.text())) errors.push(m.text());
});
s.page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
const project = makeProject(s.home);
const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();

try {
  await section('launch: welcome screen, FR strings, no folder', async () => {
    await s.aurora(() => window.__aurora.shell.launch('code'));
    await until(s, (a) => a && a.view && document.querySelector('.app-code .code-welcome-title')?.textContent, { label: 'welcome' });
    const w = await C(s, (a) => ({
      title: document.querySelector('.app-code .code-welcome-title')?.textContent,
      open: document.querySelector('.app-code [data-act="open-folder"]')?.textContent,
      tree: document.querySelector('.app-code .code-tree-empty p')?.textContent,
      noDoc: a.root.classList.contains('no-doc'),
      winTitle: a.win.title || document.querySelector('.win.app-code .win-title, .win.app-code .titlebar-title')?.textContent,
    }));
    check('welcome title', w.title, 'Éditeur de code');
    check('open folder button (FR)', w.open, 'Ouvrir un dossier');
    check('empty explorer text', w.tree, "Aucun dossier n'est ouvert.");
    check('no document → welcome', w.noDoc, true);
    // the shortcut list: every label on one line, not cut, aligned left (default window size, then maximized)
    const keys = () =>
      C(s, () =>
        [...document.querySelectorAll('.app-code .code-key dt')].map((dt) => {
          const r = document.createRange();
          r.selectNodeContents(dt);
          const lines = new Set([...r.getClientRects()].map((x) => Math.round(x.top))).size;
          return { text: dt.textContent, lines, cut: dt.scrollWidth > dt.clientWidth + 1, align: getComputedStyle(dt).textAlign };
        }),
      );
    for (const k of await keys()) check(`shortcut label on one line: ${k.text}`, [k.lines, k.cut, k.align], [1, false, 'left']);
    check('shortcut list has « Sélectionner l\'occurrence suivante »', (await keys()).some((k) => /occurrence suivante/.test(k.text)), true);
    // no file open: the status bar shows no file items (cursor, indentation, encoding, line ending, language)
    check('status bar empty without a file', await C(s, (a) => [...a.status.querySelectorAll('.code-st')].filter((e) => !e.hidden && e.offsetParent).map((e) => e.textContent)), []);
    await C(s, (a) => a.win.maximize());
    await sleep(400);
    for (const k of await keys()) check(`maximized: shortcut label on one line: ${k.text}`, [k.lines, k.cut], [1, false]);
    await s.shot('code-welcome-fr-dark');
  });

  await section('open folder: .gitignore-aware tree, git status, branch', async () => {
    await C(s, (a, dir) => a.openFolder(dir), project);
    await until(s, (a) => document.querySelectorAll('.app-code .code-row').length > 3, { label: 'tree rows' });
    const t = await C(s, (a) => ({
      names: [...document.querySelectorAll('.app-code .code-row')].map((r) => r.querySelector('.code-name').textContent),
      side: document.querySelector('.app-code .code-side-title').textContent,
      git: a.git.repo,
      branch: document.querySelector('.app-code .code-branch')?.textContent,
    }));
    check('side title is the folder name', t.side, 'lune');
    check('folders first', t.names.slice(0, 4), ['native', 'scripts', 'src', 'tools']);
    check('dotfiles shown (.gitignore)', t.names.includes('.gitignore'), true);
    for (const hidden of ['node_modules', 'dist', 'debug.log', '.git']) check(`hidden: ${hidden}`, t.names.includes(hidden), false);
    if (hasGit) {
      check('git repo detected', t.git, true);
      check('branch in status bar', t.branch, 'main');
      check('status bar branch has no stray text', await C(s, (a) => a.stBranch.textContent.trim()), 'main');
      const g = await C(s, () => {
        const row = (n) => [...document.querySelectorAll('.app-code .code-row')].find((r) => r.querySelector('.code-name').textContent === n);
        return { src: row('src')?.className, notes: row('notes.txt')?.className, notesBadge: row('notes.txt')?.querySelector('.code-git')?.textContent, readme: row('README.md')?.className };
      });
      check('modified folder marked (src)', g.src, (c) => /git-M/.test(c));
      check('new file marked (notes.txt)', g.notes, (c) => /git-U-new/.test(c));
      check('new file badge U', g.notesBadge, 'U');
      check('clean file not marked', g.readme, (c) => !/git-/.test(c));
    }
    // show ignored files
    await C(s, (a) => a.setShowIgnored(true));
    const shown = await C(s, () => [...document.querySelectorAll('.app-code .code-row.ignored')].map((r) => r.querySelector('.code-name').textContent));
    check('show ignored: node_modules, dist, debug.log, .git dimmed', ['node_modules', 'dist', 'debug.log', '.git'].every((n) => shown.includes(n)), true);
    await C(s, (a) => a.setShowIgnored(false));
    // expand src and check the modified file
    await s.page.click('.app-code .code-row[data-path$="/src"]');
    await until(s, () => document.querySelector('.app-code .code-row[data-path$="/src/main.js"]'), { label: 'src expanded' });
    if (hasGit) check('modified file marked (main.js)', await C(s, () => document.querySelector('.app-code .code-row[data-path$="/src/main.js"]').className), (c) => /git-M/.test(c));
  });

  await section('open a file: tab, highlighting, line numbers, language', async () => {
    await s.page.click('.app-code .code-row[data-path$="/src/main.js"]');
    await until(s, (a) => a.active?.name === 'main.js' && document.querySelector('.app-code .cm-content'), { label: 'main.js open' });
    await sleep(300);
    const e = await C(s, (a) => ({
      tabs: [...document.querySelectorAll('.app-code .code-tab .code-tab-name')].map((x) => x.textContent),
      kw: document.querySelectorAll('.app-code .cm-content .tk-kw').length,
      str: document.querySelectorAll('.app-code .cm-content .tk-str').length,
      com: document.querySelectorAll('.app-code .cm-content .tk-com').length,
      nums: [...document.querySelectorAll('.app-code .cm-lineNumbers .cm-gutterElement')].map((x) => x.textContent).filter(Boolean).slice(0, 3),
      lang: a.stLang.textContent,
      pos: a.stPos.textContent,
      eol: a.stEol.textContent,
      indent: a.stIndent.textContent,
      kwColor: getComputedStyle(document.querySelector('.app-code .cm-content .tk-kw')).color,
      textColor: getComputedStyle(document.querySelector('.app-code .cm-content')).color,
    }));
    check('one tab', e.tabs, ['main.js']);
    check('keywords highlighted', e.kw, (n) => n >= 3);
    check('strings highlighted', e.str, (n) => n >= 1);
    check('comments highlighted', e.com, (n) => n >= 1);
    check('keyword colour differs from text', e.kwColor !== e.textColor, true);
    check('line numbers', e.nums, (n) => n.includes('1') && n.includes('2'));
    check('language in status bar', e.lang, 'JavaScript');
    check('position in status bar (FR)', e.pos, 'Ligne 1, col. 1');
    check('line ending', e.eol, 'LF');
    check('encoding shown with a file open', await C(s, (a) => (a.stEnc.hidden ? null : a.stEnc.textContent)), 'UTF-8');
    check('indentation detected', e.indent, 'Espaces : 2');
    // language detection for other files
    const langs = await s.page.evaluate(async () => {
      const m = await import('app://shell/apps/code/lib/cm.js');
      return ['a.py', 'b.ts', 'c.html', 'd.css', 'e.json', 'f.md', 'g.c', 'h.hpp', 'i.rs', 'j.go', 'k.sh', 'l.yaml', 'Makefile', 'm.toml', 'n.unknown'].map((n) => m.langOf(n));
    });
    check('langOf', langs, ['python', 'typescript', 'html', 'css', 'json', 'markdown', 'cpp', 'cpp', 'rust', 'go', 'shell', 'yaml', 'shell', 'toml', 'plain']);
    const shebang = await s.page.evaluate(async () => (await import('app://shell/apps/code/lib/cm.js')).langOf('run', '#!/usr/bin/env python3'));
    check('langOf from #! line', shebang, 'python');
  });

  await section('edit: unsaved dot, title, Ctrl+S writes the file', async () => {
    await C(s, (a) => a.goto(1, 1));
    await s.page.keyboard.press('End');
    await s.page.keyboard.type(' (modifié)');
    const d = await C(s, (a) => ({ dirty: a.active.dirty, cls: document.querySelector('.app-code .code-tab.active').className, dot: getComputedStyle(document.querySelector('.app-code .code-tab.active .code-dot')).display, title: a.win.title }));
    check('tab dirty', d.dirty, true);
    check('dirty class', d.cls, (c) => /dirty/.test(c));
    check('unsaved dot shown', d.dot, 'block');
    await s.page.keyboard.press('Control+s');
    await until(s, (a) => !a.active.dirty, { label: 'saved' });
    check('file saved on disk', fs.readFileSync(path.join(project, 'src/main.js'), 'utf8').split('\n')[0], '// Entry point (modifié)');
    check('dot hidden after save', await C(s, () => getComputedStyle(document.querySelector('.app-code .code-tab.active .code-dot')).display), 'none');
  });

  await section('find / replace with a regex (CodeMirror panel in French)', async () => {
    await s.page.keyboard.press('Control+f');
    await until(s, () => document.querySelector('.app-code .cm-search input[name=search]'), { label: 'search panel' });
    const labels = await C(s, () => ({
      ph: document.querySelector('.app-code .cm-search input[name=search]').placeholder,
      all: document.querySelector('.app-code .cm-search button[name=replaceAll]')?.textContent,
      re: [...document.querySelectorAll('.app-code .cm-search label')].map((l) => l.textContent.trim()),
    }));
    check('search placeholder FR', labels.ph, 'Rechercher');
    check('replace all FR', labels.all, 'Tout remplacer');
    check('regexp label FR', labels.re.includes('Expression régulière'), true);
    await s.page.fill('.app-code .cm-search input[name=search]', 'phase\\(\\w+\\)');
    await s.page.check('.app-code .cm-search input[name=re]');
    await s.page.fill('.app-code .cm-search input[name=replace]', 'phase(1)');
    await s.page.click('.app-code .cm-search button[name=replaceAll]');
    const doc = await C(s, (a) => a.view.state.doc.toString());
    check('regex replace applied', doc.includes('phase ${phase(1)}') && !doc.includes('phase(count)'), true);
    await s.page.keyboard.press('Escape');
    check('search panel closed', await C(s, () => !document.querySelector('.app-code .cm-search')), true);
  });

  await section('go to line (Ctrl+G), multi-cursor (Ctrl+D), auto-indent and brackets', async () => {
    await C(s, (a) => a.view.focus());
    await s.page.keyboard.press('Control+g');
    await until(s, () => document.querySelector('.dialog input'), { label: 'goto prompt' });
    await s.page.fill('.dialog input', '5:3');
    await s.page.keyboard.press('Enter');
    await until(s, (a) => !document.querySelector('.dialog') && a.view.state.doc.lineAt(a.view.state.selection.main.head).number === 5, { label: 'line 5' });
    check('status shows line 5, col 3', await C(s, (a) => a.stPos.textContent), 'Ligne 5, col. 3');
    // multi-cursor: cursor in « greet » then Ctrl+D twice
    await C(s, (a) => {
      const doc = a.view.state.doc.toString();
      const i = doc.indexOf('greet');
      a.view.dispatch({ selection: { anchor: i + 1 } });
      a.view.focus();
    });
    await s.page.keyboard.press('Control+d');
    await s.page.keyboard.press('Control+d');
    const sel = await C(s, (a) => ({ n: a.view.state.selection.ranges.length, texts: a.view.state.selection.ranges.map((r) => a.view.state.sliceDoc(r.from, r.to)), st: a.stPos.textContent }));
    check('two selections on « greet »', sel.n, (n) => n >= 2);
    check('both select « greet »', sel.texts.every((x) => x === 'greet'), true);
    check('status counts selections', sel.st, (t) => /2 sélections/.test(t));
    // auto-indent + bracket closing at the end of the document
    await C(s, (a) => {
      const end = a.view.state.doc.length;
      a.view.dispatch({ selection: { anchor: end } });
      a.view.focus();
    });
    await s.page.keyboard.type('function f() {');
    await s.page.keyboard.press('Enter');
    await s.page.keyboard.type('return 1;');
    const tail = await C(s, (a) => a.view.state.doc.toString().split('\n').slice(-3));
    check('closing bracket inserted and body indented', tail, ['function f() {', '  return 1;', '}']);
    // bracket matching highlight
    await C(s, (a) => {
      const doc = a.view.state.doc.toString();
      a.view.dispatch({ selection: { anchor: doc.lastIndexOf('{') + 1 } });
    });
    await sleep(100);
    check('matching bracket highlighted', await C(s, () => document.querySelectorAll('.app-code .cm-matchingBracket').length), (n) => n >= 1);
  });

  await section('second tab, language menu, switch tabs keeps edits', async () => {
    await s.page.click('.app-code .code-row[data-path$="/README.md"]');
    await until(s, (a) => a.active?.name === 'README.md', { label: 'README open' });
    const r = await C(s, (a) => ({ tabs: a.tabs.map((x) => x.name), lang: a.stLang.textContent, head: document.querySelectorAll('.app-code .cm-content .tk-head').length }));
    check('two tabs', r.tabs, ['main.js', 'README.md']);
    check('markdown language', r.lang, 'Markdown');
    check('markdown heading highlighted', r.head, (n) => n >= 1);
    await s.page.click('.app-code .code-tab[data-id] >> text=main.js');
    await until(s, (a) => a.active?.name === 'main.js', { label: 'back to main.js' });
    check('edits kept across tab switch', await C(s, (a) => a.view.state.doc.toString().includes('function f() {') && a.active.dirty), true);
  });

  await section('explorer: create, rename, delete to the Recycle Bin', async () => {
    // new file in src through the prompt
    await C(s, (a, dir) => void a.createIn(dir, false), path.join(project, 'src'));
    await until(s, () => document.querySelector('.dialog input'), { label: 'new file prompt' });
    await s.page.fill('.dialog input', 'lune.ts');
    await s.page.keyboard.press('Enter');
    await until(s, (a) => a.active?.name === 'lune.ts', { label: 'new file opened' });
    check('file created', fs.existsSync(path.join(project, 'src/lune.ts')), true);
    check('TypeScript detected', await C(s, (a) => a.stLang.textContent), 'TypeScript');
    // invalid name is refused
    await C(s, (a, dir) => void a.createIn(dir, true), path.join(project, 'src'));
    await until(s, () => document.querySelector('.dialog input'), { label: 'new folder prompt' });
    await s.page.fill('.dialog input', 'moon.js');
    await s.page.keyboard.press('Enter');
    await sleep(200);
    check('existing name refused', await C(s, () => !!document.querySelector('.dialog')), true);
    await s.page.fill('.dialog input', 'lib');
    await s.page.keyboard.press('Enter');
    await until(s, () => !document.querySelector('.dialog'), { label: 'folder prompt closed' });
    check('folder created', fs.statSync(path.join(project, 'src/lib')).isDirectory(), true);
    // rename the open file: the tab follows
    await C(s, (a, p) => {
      const e = a.entries.get(p.dir).find((x) => x.name === p.name);
      a.renameEntry(e);
    }, { dir: path.join(project, 'src'), name: 'lune.ts' });
    await until(s, () => document.querySelector('.dialog input'), { label: 'rename prompt' });
    await s.page.fill('.dialog input', 'satellite.ts');
    await s.page.keyboard.press('Enter');
    await until(s, (a) => a.tabs.some((x) => x.name === 'satellite.ts'), { label: 'renamed tab' });
    check('renamed on disk', fs.existsSync(path.join(project, 'src/satellite.ts')) && !fs.existsSync(path.join(project, 'src/lune.ts')), true);
    // delete to the Recycle Bin: the tab closes
    await C(s, (a, p) => {
      const e = a.entries.get(p.dir).find((x) => x.name === p.name);
      a.trashEntry(e);
    }, { dir: path.join(project, 'src'), name: 'satellite.ts' });
    const confirmText = await until(s, () => [...document.querySelectorAll('.dialog')].map((d) => d.textContent).find((t) => t.includes('corbeille')), { label: 'trash confirm' });
    check('trash confirm FR', confirmText, (t) => t.includes('Mettre « satellite.ts » à la corbeille ?'));
    await s.page.click('.dialog:has-text("corbeille") .dialog-footer .btn.danger');
    await until(s, (a) => !a.tabs.some((x) => x.name === 'satellite.ts'), { label: 'tab closed after trash' });
    check('gone from the folder', fs.existsSync(path.join(project, 'src/satellite.ts')), false);
    check('in the Recycle Bin', fs.existsSync(path.join(s.home, '.local/share/Trash/files/satellite.ts')), true);
  });

  await section('terminal panel: PTY in the opened folder', async () => {
    await C(s, (a) => a.toggleTerminal(true));
    await until(s, (a) => a.ptyId && document.querySelector('.app-code .code-panel .xterm'), { label: 'terminal started', timeout: 15000 });
    const visible = await C(s, () => getComputedStyle(document.querySelector('.app-code .code-panel')).display);
    check('panel visible', visible, 'flex');
    await sleep(800);
    await C(s, (a) => a.api.send('pty:write', a.ptyId, 'echo "CODE_$((6*7))_$(basename "$PWD")"\r'));
    const out = await until(
      s,
      (a) => {
        const b = a.term.buffer.active;
        let text = '';
        for (let i = 0; i < b.length; i++) text += `${b.getLine(i)?.translateToString(true) || ''}\n`;
        return text.includes('CODE_42_lune') && text;
      },
      { label: 'terminal output', timeout: 15000 },
    ).catch((e) => String(e));
    check('command ran in the project folder', String(out).includes('CODE_42_lune'), true);
    // Ctrl+` hides it
    await C(s, (a) => a.view.focus());
    await s.page.keyboard.press('Control+`');
    check('Ctrl+` hides the panel', await C(s, (a) => a.termOpen), false);
    await s.page.keyboard.press('Control+`');
    check('Ctrl+` shows it again', await C(s, (a) => a.termOpen), true);
  });

  await section('find panel: Selene fields, buttons and checkboxes, many tabs, FR dark + light', async () => {
    const names = ['src/moon.js', 'tools/build.py', 'style.css', 'config.yaml', 'package.json', 'scripts/run.sh', 'native/moon.c', 'native/moon.rs', 'native/moon.go', '.gitignore', 'notes.txt'];
    await C(s, async (a, list) => {
      for (const p of list) await a.openFile(p);
    }, names.map((n) => path.join(project, n)));
    await until(s, (a) => a.tabs.length >= 13, { label: 'many tabs' });
    await C(s, (a) => a.toggleTerminal(false));
    await C(s, (a) => {
      a.activate(a.tabs.find((x) => x.name === 'main.js'));
      a.find();
    });
    await until(s, () => document.querySelector('.app-code .cm-search.selene'), { label: 'dressed search panel' });
    await s.page.fill('.app-code .cm-search input[name=search]', 'phase');
    await s.page.check('.app-code .cm-search input[name=case]');
    await sleep(400); // the checkbox fades to the accent (--dur-fast)
    const look = await C(s, () => {
      const p = document.querySelector('.app-code .cm-search');
      const probe = document.createElement('span');
      probe.style.background = 'var(--accent)';
      p.appendChild(probe);
      const accent = getComputedStyle(probe).backgroundColor;
      probe.remove();
      const box = (sel) => getComputedStyle(p.querySelector(sel));
      return {
        fields: [...p.querySelectorAll('input:not([type=checkbox])')].map((x) => x.className),
        buttons: [...p.querySelectorAll('button:not([name=close])')].map((x) => x.className),
        labels: [...p.querySelectorAll('label')].map((x) => x.className),
        cmLeft: p.querySelectorAll('.cm-textfield, .cm-button').length,
        appearance: box('input[name=case]').appearance,
        size: [box('input[name=case]').width, box('input[name=case]').height],
        checkedBg: box('input[name=case]').backgroundColor,
        uncheckedBg: box('input[name=word]').backgroundColor, // (« re » stays checked from the regex section)
        accent,
        btnImage: box('button[name=next]').backgroundImage,
        btnRadius: box('button[name=next]').borderTopLeftRadius,
        fieldRadius: box('input[name=search]').borderTopLeftRadius,
        heights: [box('input[name=search]').height, box('button[name=next]').height],
        close: p.querySelector('button[name=close] .icon')?.dataset.icon,
        closeTip: p.querySelector('button[name=close]')?.dataset.tip,
      };
    });
    check('fields are Selene inputs', look.fields, (f) => f.length === 2 && f.every((c) => /\binput\b/.test(c)));
    check('buttons are Selene buttons', look.buttons, (b) => b.length === 5 && b.every((c) => /\bbtn\b/.test(c) && /\bsmall\b/.test(c)));
    check('options are Selene checkboxes', look.labels, ['checkbox', 'checkbox', 'checkbox']);
    check('no CodeMirror field / button class left', look.cmLeft, 0);
    check('checkbox drawn by Selene (no native box)', look.appearance, 'none');
    check('checkbox 18 px', look.size, ['18px', '18px']);
    check('checked option filled with the accent', look.checkedBg, look.accent);
    check('unchecked option not filled', look.uncheckedBg !== look.accent, true);
    check('buttons: no CodeMirror gradient', look.btnImage, 'none');
    check('rounded like Selene controls', look.btnRadius !== '1px' && look.btnRadius === look.fieldRadius, true);
    check('fields and buttons one height', look.heights[0], look.heights[1]);
    check('close button: Phosphor x with a tip', [look.close, look.closeTip], ['x', 'Fermer']);
    // EditorView.setState (tab switch) rebuilds the open panel: it is dressed again
    await C(s, (a) => a.activate(a.tabs.find((x) => x.name === 'README.md')));
    await C(s, (a) => a.activate(a.tabs.find((x) => x.name === 'main.js')));
    check('panel dressed again after a tab switch', await C(s, () => {
      const p = document.querySelector('.app-code .cm-search');
      return !!p && p.classList.contains('selene') && p.querySelectorAll('.input').length === 2 && !!p.querySelector('[name=close] .icon');
    }), true);
    check('find query kept', await C(s, () => document.querySelector('.app-code .cm-search input[name=search]').value), 'phase');
    check('tab strip overflows (many tabs)', await C(s, () => {
      const t = document.querySelector('.app-code .code-tabs');
      return t.scrollWidth > t.clientWidth;
    }), true);
    await sleep(300);
    await s.shot('code-find-fr-dark');
    await s.aurora(() => window.__aurora.settings.set('theme', 'light'));
    await sleep(900);
    const lightLook = await C(s, () => {
      const p = document.querySelector('.app-code .cm-search');
      return { field: getComputedStyle(p.querySelector('input[name=search]')).backgroundColor, text: getComputedStyle(p.querySelector('label')).color };
    });
    check('light: field background is light', lightLook.field, (c) => c.match(/\d+/g).slice(0, 3).map(Number).reduce((x, y) => x + y, 0) > 600);
    check('light: option text is dark', lightLook.text, (c) => c.match(/\d+/g).slice(0, 3).map(Number).reduce((x, y) => x + y, 0) < 300);
    await s.shot('code-find-fr-light');
    await s.aurora(() => window.__aurora.settings.set('theme', 'dark'));
    await sleep(600);
    // back to the state the next sections expect: panel closed, two tabs, terminal open
    await C(s, (a) => a.view.dom.querySelector('.cm-search [name=close]')?.click());
    await C(s, async (a, list) => {
      for (const t of a.tabs.filter((x) => list.includes(x.path))) await a.closeTab(t, true);
    }, names.map((n) => path.join(project, n)));
    await C(s, (a) => a.toggleTerminal(true));
    check('back to two tabs, panel closed', await C(s, (a) => [a.tabs.map((x) => x.name), !!document.querySelector('.app-code .cm-search')]), [['main.js', 'README.md'], false]);
  });

  await section('screenshots FR dark + light (1280x720)', async () => {
    await C(s, (a) => {
      const t = a.tabs.find((x) => x.name === 'main.js');
      a.activate(t);
      a.goto(4, 10);
    });
    await sleep(500);
    const dark = await s.shot('code-fr-dark');
    fs.copyFileSync(dark, path.join(DOCS, 'code-fr-dark.png'));
    await s.aurora(() => window.__aurora.settings.set('theme', 'light'));
    await sleep(900);
    const light = await s.shot('code-fr-light');
    fs.copyFileSync(light, path.join(DOCS, 'code-fr-light.png'));
    const colors = await C(s, () => ({ bg: getComputedStyle(document.querySelector('.app-code .cm-editor')).backgroundColor, text: getComputedStyle(document.querySelector('.app-code .cm-content')).color, termVp: getComputedStyle(document.querySelector('.app-code .xterm-viewport')).backgroundColor }));
    check('terminal draws on the panel surface (transparent viewport)', colors.termVp, (c) => /rgba\(0, 0, 0, 0\)|transparent/.test(c));
    check('light editor: dark text', colors.text, (c) => {
      const [r, g, b] = c.match(/\d+/g).map(Number);
      return r + g + b < 200;
    });
    // welcome screen in light mode
    await C(s, (a) => a.toggleTerminal(false));
    await sleep(200);
  });

  await section('unsaved changes prompt on close', async () => {
    await C(s, (a) => void a.win.close());
    await until(s, () => document.querySelector('.dialog'), { label: 'unsaved dialog' });
    const txt = await C(s, () => ({ title: document.querySelector('.dialog .dialog-title')?.textContent, buttons: [...document.querySelectorAll('.dialog .dialog-footer .btn')].map((b) => b.textContent) }));
    check('unsaved title', txt.title, 'Modifications non enregistrées');
    check('buttons', txt.buttons, ['Enregistrer', 'Ne pas enregistrer', 'Annuler']);
    // Cancel keeps the window
    await s.page.click('.dialog .dialog-footer .btn >> text=Annuler');
    await sleep(300);
    check('cancel keeps the window', await C(s, (a) => !!a && !a.win.closed), true);
    await C(s, (a) => void a.win.close());
    await until(s, () => document.querySelector('.dialog'), { label: 'unsaved dialog 2' });
    await s.page.click('.dialog .dialog-footer .btn >> text=Ne pas enregistrer');
    await until(s, () => !document.querySelector('.win.app-code') || 'gone', { label: 'closed' });
    await sleep(400);
    check('window closed', await s.page.evaluate(() => !document.querySelector('.win.app-code')), true);
    check('discarded edits not written', fs.readFileSync(path.join(project, 'src/main.js'), 'utf8').includes('function f()'), false);
  });

  await section('reopen: last folder restored, welcome lists the folder', async () => {
    await s.aurora(() => window.__aurora.shell.launch('code'));
    await until(s, (a) => a && a.folder && document.querySelectorAll('.app-code .code-row').length > 3, { label: 'folder restored' });
    check('folder restored', await C(s, (a) => a.folder), project);
    check('terminal stays closed as it was left', await C(s, (a) => a.termOpen), false);
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
