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
  '.cm-panel.cm-search': { padding: '8px 36px 8px 10px', fontFamily: 'var(--font)', fontSize: 'var(--fs-small)', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px' },
  '.cm-panel.cm-search br': { flexBasis: '100%', height: 0, content: '""' },
  '.cm-panel.cm-search input[type=checkbox]': { accentColor: 'var(--accent)', margin: '0 2px 0 6px' },
  '.cm-panel.cm-search label': { color: 'var(--text-2)', fontSize: 'var(--fs-small)', display: 'inline-flex', alignItems: 'center' },
  '.cm-panel.cm-search [name=close]': { color: 'var(--text-2)', fontSize: '18px', top: '6px', right: '8px', cursor: 'pointer' },
  '.cm-textfield': {
    backgroundColor: 'var(--input-bg)', color: 'var(--text)', border: '1px solid var(--line)', borderRadius: 'var(--radius-sm)',
    padding: '4px 8px', fontFamily: 'var(--font)', fontSize: 'var(--fs-small)', minWidth: '180px', margin: 0,
  },
  '.cm-textfield:focus': { outline: '2px solid var(--focus-ring)', outlineOffset: '-1px' },
  '.cm-button': {
    backgroundImage: 'none', backgroundColor: 'var(--control)', color: 'var(--text)', border: '1px solid var(--line-soft)',
    borderRadius: 'var(--radius-sm)', padding: '4px 10px', fontFamily: 'var(--font)', fontSize: 'var(--fs-small)', margin: 0, cursor: 'pointer',
  },
  '.cm-button:hover': { backgroundColor: 'var(--control-hover)' },
  '.cm-button:active': { backgroundImage: 'none', backgroundColor: 'var(--control-pressed)' },
});

// ------------------------------------------------------------------ phrases (CodeMirror's own UI)
export const PHRASES_FR = {
  Find: 'Rechercher', Replace: 'Remplacer', next: 'suivant', previous: 'précédent', all: 'tout',
  'match case': 'respecter la casse', regexp: 'expression régulière', 'by word': 'mot entier',
  replace: 'remplacer', 'replace all': 'tout remplacer', close: 'fermer',
  'current match': 'résultat actuel', 'on line': 'à la ligne', 'replaced match on line $': 'résultat remplacé à la ligne $',
  'replaced $ matches': '$ résultats remplacés', 'Go to line': 'Aller à la ligne', go: 'aller',
  'Folded lines': 'Lignes repliées', 'Unfolded lines': 'Lignes dépliées', to: 'à', 'folded code': 'code replié',
  unfold: 'déplier', 'Fold line': 'Replier la ligne', 'Unfold line': 'Déplier la ligne', 'Control character': 'Caractère de contrôle',
  'Selection deleted': 'Sélection supprimée',
};

/**
 * The extensions of one document.
 *   { lang, langComp / wrapComp / tabComp (Compartments), indent: { tabs, size }, wrap, uiLang: 'fr'|'en', keys, onUpdate(update) }
 */
export const tabExt = ({ tabs = false, size = 2 } = {}) => [EditorState.tabSize.of(size), CM.indentUnit.of(tabs ? '\t' : ' '.repeat(size))];

export function extensions({ lang, langComp, wrapComp, tabComp, indent, wrap = false, uiLang = 'en', keys = [], onUpdate }) {
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
    EditorView.updateListener.of((u) => onUpdate?.(u)),
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
