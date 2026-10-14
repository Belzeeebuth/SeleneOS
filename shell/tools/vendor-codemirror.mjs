#!/usr/bin/env node
// Builds the CodeMirror 6 bundle of the Code Editor (renderer/apps/code/vendor/codemirror.js).
//
//   node tools/vendor-codemirror.mjs            (from shell/; needs npm and the registry, through the proxy if any)
//
// The renderer loads plain ES modules from app://, with no bundler and no node_modules resolution, so the editor
// component is vendored as ONE prebuilt, minified ES module. This script installs the pinned packages below into a
// throwaway folder (they are not dependencies of the shell: package.json stays as it is), writes an entry module that
// re-exports what apps/code/main.js uses, bundles it with esbuild and writes the result next to the app. The output
// is committed; run this again only to update CodeMirror (bump the versions, rebuild, run test/code.test.mjs and
// test/code-extra.test.mjs). @codemirror/merge draws the diff views (side by side and inline) of the editor.
// Licences: CodeMirror and Lezer are MIT (apps/code/vendor/LICENSE-codemirror.txt).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SHELL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(SHELL, 'renderer', 'apps', 'code', 'vendor');

export const PACKAGES = {
  '@codemirror/view': '6.43.14',
  '@codemirror/state': '6.7.6',
  '@codemirror/language': '6.13.1',
  '@codemirror/commands': '6.11.1',
  '@codemirror/search': '6.7.2',
  '@codemirror/autocomplete': '6.20.3',
  '@codemirror/lang-javascript': '6.2.5',
  '@codemirror/lang-python': '6.2.1',
  '@codemirror/lang-html': '6.4.12',
  '@codemirror/lang-css': '6.3.1',
  '@codemirror/lang-json': '6.0.2',
  '@codemirror/lang-markdown': '6.5.2',
  '@codemirror/lang-cpp': '6.0.3',
  '@codemirror/lang-rust': '6.0.2',
  '@codemirror/lang-go': '6.0.1',
  '@codemirror/lang-yaml': '6.1.3',
  '@codemirror/legacy-modes': '6.5.5',
  '@codemirror/merge': '6.12.2',
  '@lezer/highlight': '1.2.5',
  esbuild: '0.28.2',
};

const ENTRY = `
export { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars,
  drawSelection, dropCursor, rectangularSelection, crosshairCursor } from '@codemirror/view';
export { EditorState, EditorSelection, Compartment, StateEffect, StateField, Prec, Annotation, Transaction, ChangeSet, Text }
  from '@codemirror/state';
export { syntaxHighlighting, HighlightStyle, indentOnInput, bracketMatching, foldGutter, foldKeymap, indentUnit,
  StreamLanguage, LanguageSupport } from '@codemirror/language';
export { defaultKeymap, history, historyKeymap, indentWithTab, undo, redo, selectAll } from '@codemirror/commands';
export { search, searchKeymap, highlightSelectionMatches, openSearchPanel, closeSearchPanel, gotoLine,
  SearchQuery, setSearchQuery, findNext, replaceAll, selectNextOccurrence } from '@codemirror/search';
export { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap } from '@codemirror/autocomplete';
export { tags } from '@lezer/highlight';
export { javascript } from '@codemirror/lang-javascript';
export { python } from '@codemirror/lang-python';
export { html } from '@codemirror/lang-html';
export { css } from '@codemirror/lang-css';
export { json } from '@codemirror/lang-json';
export { markdown } from '@codemirror/lang-markdown';
export { cpp } from '@codemirror/lang-cpp';
export { rust } from '@codemirror/lang-rust';
export { go } from '@codemirror/lang-go';
export { yaml } from '@codemirror/lang-yaml';
export { MergeView, unifiedMergeView, goToNextChunk, goToPreviousChunk, getChunks, acceptChunk, rejectChunk, getOriginalDoc,
  updateOriginalDoc, originalDocChangeEffect, uncollapseUnchanged, Chunk, diff, presentableDiff } from '@codemirror/merge';
export { shell as shellMode } from '@codemirror/legacy-modes/mode/shell';
export { toml as tomlMode } from '@codemirror/legacy-modes/mode/toml';
`;

function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'selene-cm-'));
  try {
    fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify({ name: 'cm-vendor', private: true, dependencies: PACKAGES }, null, 1));
    console.log(`installing ${Object.keys(PACKAGES).length} packages in ${work}`);
    execFileSync('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts=false', '--loglevel=error'], { cwd: work, stdio: 'inherit' });
    fs.writeFileSync(path.join(work, 'entry.mjs'), ENTRY);
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const out = path.join(OUT_DIR, 'codemirror.js');
    execFileSync(
      path.join(work, 'node_modules', '.bin', 'esbuild'),
      ['entry.mjs', '--bundle', '--format=esm', '--minify', '--target=chrome120', '--legal-comments=none', `--outfile=${out}`],
      { cwd: work, stdio: 'inherit' },
    );
    const versions = Object.entries(PACKAGES).filter(([n]) => n !== 'esbuild').map(([n, v]) => `${n}@${v}`).join(', ');
    const body = fs.readFileSync(out, 'utf8');
    fs.writeFileSync(out, `// GENERATED by shell/tools/vendor-codemirror.mjs: do not edit by hand. MIT licence (LICENSE-codemirror.txt).\n// ${versions}\n${body}`);
    const lic = fs.readFileSync(path.join(work, 'node_modules', '@codemirror', 'view', 'LICENSE'), 'utf8');
    fs.writeFileSync(path.join(OUT_DIR, 'LICENSE-codemirror.txt'), `CodeMirror 6 and Lezer (${versions})\n\n${lic}`);
    console.log(`wrote ${path.relative(SHELL, out)} (${Math.round(fs.statSync(out).size / 1024)} KB)`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main();
