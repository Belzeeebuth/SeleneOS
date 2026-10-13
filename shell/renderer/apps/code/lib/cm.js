// CodeMirror 6 setup of the Code Editor: languages by file name, the Selene editor theme (tokens only, so every
// theme, style, ambiance, accent and mode applies), the search / go-to-line phrases in French, and the extensions of
// one document. The component itself is the vendored bundle ../vendor/codemirror.js (shell/tools/vendor-codemirror.mjs).
import * as CM from '../vendor/codemirror.js';

export { CM };

const { EditorView, EditorState, HighlightStyle, tags: T, StreamLanguage, LanguageSupport } = CM;

// ------------------------------------------------------------------ languages
// id -> { name, load() -> extension }. Names are shown in the status bar (same in English and French).
const shellLang = () => new LanguageSupport(StreamLanguage.define(CM.shellMode));
const tomlLang = () => new LanguageSupport(StreamLanguage.define(CM.tomlMode));
export const LANGS = {
  javascript: { name: 'JavaScript', load: () => CM.javascript({ jsx: true }) },
  typescript: { name: 'TypeScript', load: () => CM.javascript({ typescript: true, jsx: true }) },
  python: { name: 'Python', load: () => CM.python() },
  html: { name: 'HTML', load: () => CM.html() },
  css: { name: 'CSS', load: () => CM.css() },
  json: { name: 'JSON', load: () => CM.json() },
  markdown: { name: 'Markdown', load: () => CM.markdown() },
  cpp: { name: 'C/C++', load: () => CM.cpp() },
  rust: { name: 'Rust', load: () => CM.rust() },
  go: { name: 'Go', load: () => CM.go() },
  shell: { name: 'Shell', load: shellLang },
  yaml: { name: 'YAML', load: () => CM.yaml() },
  toml: { name: 'TOML', load: tomlLang },
  plain: { name: 'Text', load: () => [] },
};

const BY_EXT = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  py: 'python', pyw: 'python', pyi: 'python',
  html: 'html', htm: 'html', xhtml: 'html', vue: 'html', svelte: 'html',
  css: 'css', scss: 'css', less: 'css',
  json: 'json', jsonc: 'json', webmanifest: 'json',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  c: 'cpp', h: 'cpp', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp', ino: 'cpp',
  rs: 'rust', go: 'go',
  sh: 'shell', bash: 'shell', zsh: 'shell', ksh: 'shell',
  yml: 'yaml', yaml: 'yaml',
  toml: 'toml',
};
const BY_NAME = {
  makefile: 'shell', dockerfile: 'shell', '.bashrc': 'shell', '.profile': 'shell', '.bash_profile': 'shell', '.zshrc': 'shell',
  'package.json': 'json', '.eslintrc': 'json', '.prettierrc': 'json', 'cargo.lock': 'toml', 'pipfile': 'toml',
};

/** The language id of a file name (and optionally its first line, for #! scripts). */
export function langOf(name, firstLine = '') {
  const base = String(name || '').split('/').pop().toLowerCase();
  if (BY_NAME[base]) return BY_NAME[base];
  const ext = base.includes('.') ? base.split('.').pop() : '';
  if (BY_EXT[ext]) return BY_EXT[ext];
  const m = /^#!.*\b(bash|sh|zsh|python3?|node)\b/.exec(firstLine || '');
  if (m) return m[1].startsWith('python') ? 'python' : m[1] === 'node' ? 'javascript' : 'shell';
  return 'plain';
}

// ------------------------------------------------------------------ theme
// Syntax colours are classes (style.css colours them with tokens): no colour value here.
export const seleneHighlight = HighlightStyle.define([
  { tag: [T.keyword, T.controlKeyword, T.moduleKeyword, T.operatorKeyword, T.definitionKeyword, T.modifier], class: 'tk-kw' },
  { tag: [T.string, T.special(T.string), T.regexp, T.character, T.docString], class: 'tk-str' },
  { tag: [T.number, T.bool, T.null, T.atom, T.unit], class: 'tk-num' },
  { tag: [T.comment, T.lineComment, T.blockComment, T.docComment, T.meta], class: 'tk-com' },
  { tag: [T.function(T.variableName), T.function(T.propertyName), T.macroName], class: 'tk-fn' },
  { tag: [T.typeName, T.className, T.namespace, T.standard(T.variableName)], class: 'tk-type' },
  { tag: [T.tagName, T.angleBracket], class: 'tk-tag' },
  { tag: [T.attributeName, T.propertyName], class: 'tk-prop' },
  { tag: [T.definition(T.variableName), T.definition(T.propertyName)], class: 'tk-def' },
  { tag: [T.operator, T.punctuation, T.separator, T.bracket], class: 'tk-op' },
  { tag: [T.heading, T.heading1, T.heading2, T.heading3], class: 'tk-head' },
  { tag: [T.link, T.url], class: 'tk-link' },
  { tag: T.emphasis, class: 'tk-em' },
  { tag: T.strong, class: 'tk-strong' },
  { tag: T.invalid, class: 'tk-bad' },
  { tag: [T.self, T.special(T.variableName)], class: 'tk-kw' },
]);

export const seleneTheme = EditorView.theme({
  '&': { height: '100%', color: 'var(--text)', backgroundColor: 'var(--bg)', fontSize: 'var(--code-font-size, 13px)' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.55' },
  '.cm-content': { caretColor: 'var(--accent)', padding: '6px 0' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 28%, transparent)',
  },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--text) 4%, transparent)' },
  '.cm-gutters': { backgroundColor: 'var(--bg)', color: 'var(--text-3)', border: 'none', borderRight: '1px solid var(--line-soft)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text)' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 14px', minWidth: '32px' },
  '.cm-foldGutter .cm-gutterElement': { color: 'var(--text-3)', padding: '0 4px' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 22%, transparent)',
    outline: '1px solid color-mix(in srgb, var(--accent) 60%, transparent)',
  },
  '.cm-nonmatchingBracket, &.cm-focused .cm-nonmatchingBracket': { backgroundColor: 'var(--danger-bg)', color: 'var(--danger)' },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--warning) 26%, transparent)', outline: '1px solid color-mix(in srgb, var(--warning) 55%, transparent)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'color-mix(in srgb, var(--accent) 40%, transparent)' },
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--accent) 14%, transparent)' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--card)', border: '1px solid var(--line-soft)', color: 'var(--text-2)' },
  '.cm-tooltip': { backgroundColor: 'var(--surface-raised)', color: 'var(--text)', border: '1px solid var(--line)', borderRadius: 'var(--radius-sm)', boxShadow: 'var(--shadow-flyout)' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--sel-bg)', color: 'var(--text)' },
  '.cm-panels': { backgroundColor: 'var(--bg-alt)', color: 'var(--text)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--line-soft)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--line-soft)' },
  // The find / replace panel wears Selene's controls (dressSearchPanel below: .input, .btn, .checkbox of core/ui.css);
  // these rules only size them for the panel and undo CodeMirror's base margins, fonts and close button.
  '.cm-panel.cm-search': {
    padding: '8px 48px 8px 10px', fontFamily: 'var(--font)', fontSize: 'var(--fs-small)', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px',
  },
  '.cm-panel.cm-search br': { flexBasis: '100%', height: 0, content: '""' },
  '.cm-panel.cm-search input, .cm-panel.cm-search button, .cm-panel.cm-search label': { margin: 0 },
  '.cm-panel.cm-search .input': { width: '240px', minHeight: '28px', padding: '3px 10px', fontFamily: 'var(--font)', fontSize: 'var(--fs-small)' },
  '.cm-panel.cm-search .btn': { minHeight: '28px', fontFamily: 'var(--font)', fontSize: 'var(--fs-small)' },
  '.cm-panel.cm-search .checkbox': { minHeight: '28px', gap: '8px', marginLeft: '10px', fontSize: 'var(--fs-small)', color: 'var(--text)', whiteSpace: 'nowrap' },
  '.cm-panel.cm-search .checkbox input': { margin: 0 },
  '.cm-panel.cm-search [name=close]': {
    top: '8px', right: '10px', width: '28px', minWidth: '28px', height: '28px', padding: 0, color: 'var(--text-2)', backgroundColor: 'transparent', borderRadius: 'var(--radius-sm)',
  },
  '.cm-panel.cm-search [name=close]:hover': { backgroundColor: 'var(--subtle-hover)', color: 'var(--text)' },
  '.cm-panel.cm-search [name=close]:focus-visible': { outline: '2px solid var(--focus-ring)', outlineOffset: '-2px' },
});

/**
 * Gives CodeMirror's find / replace panel Selene's own controls: its fields become .input, its buttons .btn.small,
 * its option labels .checkbox (core/ui.css, so every theme, visual style and the contrast mode apply) and the close
 * button the Phosphor x. CodeMirror's classes are swapped out so its base theme no longer paints them. Idempotent:
 * runs after each update (extensions) and after EditorView.setState (main.js), which rebuilds the panel.
 */
export function dressSearchPanel(root, closeIcon) {
  // the panel groups are children of .cm-editor: no walk through the document's lines on every keystroke
  let p = null;
  for (const c of root?.children || []) if (c.classList.contains('cm-panels')) p ||= c.querySelector('.cm-search:not(.selene)');
  if (!p) return false;
  p.classList.add('selene');
  for (const f of p.querySelectorAll('input.cm-textfield')) f.classList.replace('cm-textfield', 'input');
  for (const b of p.querySelectorAll('button.cm-button')) {
    b.classList.replace('cm-button', 'btn');
    b.classList.add('small');
  }
  for (const l of p.querySelectorAll('label')) if (l.querySelector('input[type=checkbox]')) l.classList.add('checkbox');
  const x = p.querySelector('button[name=close]');
  if (x) {
    x.classList.add('btn', 'subtle', 'icon-btn');
    x.dataset.tip = x.getAttribute('aria-label') || '';
    const ic = closeIcon?.();
    if (ic) x.replaceChildren(ic);
  }
  return true;
}

// ------------------------------------------------------------------ phrases (CodeMirror's own UI)
export const PHRASES_FR = {
  Find: 'Rechercher', Replace: 'Remplacer', next: 'Suivant', previous: 'Précédent', all: 'Tout',
  'match case': 'Respecter la casse', regexp: 'Expression régulière', 'by word': 'Mot entier',
  replace: 'Remplacer', 'replace all': 'Tout remplacer', close: 'Fermer',
  'current match': 'résultat actuel', 'on line': 'à la ligne', 'replaced match on line $': 'résultat remplacé à la ligne $',
  'replaced $ matches': '$ résultats remplacés', 'Go to line': 'Aller à la ligne', go: 'Aller',
  'Folded lines': 'Lignes repliées', 'Unfolded lines': 'Lignes dépliées', to: 'à', 'folded code': 'code replié',
  unfold: 'déplier', 'Fold line': 'Replier la ligne', 'Unfold line': 'Déplier la ligne', 'Control character': 'Caractère de contrôle',
  'Selection deleted': 'Sélection supprimée',
};

/**
 * The extensions of one document.
 *   { lang, langComp / wrapComp / tabComp (Compartments), indent: { tabs, size }, wrap, uiLang: 'fr'|'en', keys,
 *     closeIcon() -> the search panel's close glyph, onUpdate(update) }
 */
export const tabExt = ({ tabs = false, size = 2 } = {}) => [EditorState.tabSize.of(size), CM.indentUnit.of(tabs ? '\t' : ' '.repeat(size))];

export function extensions({ lang, langComp, wrapComp, tabComp, indent, wrap = false, uiLang = 'en', keys = [], closeIcon, onUpdate }) {
  const {
    lineNumbers, highlightActiveLineGutter, highlightSpecialChars, history, foldGutter, drawSelection, dropCursor,
    indentOnInput, syntaxHighlighting, bracketMatching, closeBrackets, autocompletion, rectangularSelection,
    crosshairCursor, highlightActiveLine, highlightSelectionMatches, keymap, closeBracketsKeymap, defaultKeymap,
    searchKeymap, historyKeymap, foldKeymap, completionKeymap, indentWithTab, search,
  } = CM;
  return [
    keymap.of(keys),
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    foldGutter(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    syntaxHighlighting(seleneHighlight),
    bracketMatching(),
    closeBrackets(),
    autocompletion({ activateOnTyping: false }),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    search({ top: true }),
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, indentWithTab]),
    langComp.of(LANGS[lang]?.load() || []),
    tabComp.of(tabExt(indent)),
    wrapComp.of(wrap ? EditorView.lineWrapping : []),
    uiLang === 'fr' ? EditorState.phrases.of(PHRASES_FR) : [],
    seleneTheme,
    EditorView.updateListener.of((u) => {
      dressSearchPanel(u.view.dom, closeIcon);
      onUpdate?.(u);
    }),
  ];
}

/** Guesses the indentation of a text: { tabs, size }. */
export function detectIndent(text) {
  const lines = String(text).split('\n', 400);
  let tabs = 0;
  const counts = {};
  for (const l of lines) {
    if (l.startsWith('\t')) tabs++;
    else {
      const m = /^( +)\S/.exec(l);
      if (m) counts[m[1].length] = (counts[m[1].length] || 0) + 1;
    }
  }
  const spaced = Object.values(counts).reduce((a, b) => a + b, 0);
  if (tabs > spaced) return { tabs: true, size: 4 };
  const size = [2, 4, 8].find((n) => counts[n]) || 2;
  return { tabs: false, size: counts[2] && counts[4] && counts[2] >= counts[4] / 3 ? 2 : size };
}
