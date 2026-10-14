// Éditeur de code (app id "code"): a folder-based code editor.
//   - Explorer: the opened folder as a tree (create, rename, delete to the Recycle Bin), .gitignore-aware (ignored
//     files, .git and node_modules are hidden unless « Afficher les fichiers ignorés » is on), git status per file.
//   - « Rechercher dans les fichiers » (Ctrl+Shift+F, lib/search.js): the other view of the side panel; search and
//     replace across the folder (main/ipc/code-search.js).
//   - Editor: CodeMirror 6 (vendor/codemirror.js, built by shell/tools/vendor-codemirror.mjs) with tabs, syntax
//     highlighting, line numbers, find / replace (regex), go to line, multi-cursor (Alt+click, Ctrl+D), auto-indent,
//     bracket matching and closing, folding.
//   - Documents and tabs: a Doc is one open file (or untitled buffer); each tab that shows it keeps its own
//     EditorState (selection, scroll, undo history) and every change is copied to the doc's other tabs (Sync
//     annotation, not added to their history), so one file shown twice stays the same everywhere.
//   - Split view: up to two panes side by side or one above the other (Ctrl+\), each with its own tabs and its own
//     EditorView; move a tab to the other pane (menu or drag), close a pane, focus with Ctrl+1 / Ctrl+2. The layout
//     (split, size, the files of each pane) is remembered per folder (prefs.layouts).
//   - Comparisons (lib/diff.js, @codemirror/merge): a tab of kind 'diff' compares a document with git HEAD
//     (code:gitShow), with the file saved on disk, or with another file; side by side or inline, next / previous
//     change (F7 / Shift+F7), revert a change. Its right side is the document itself (editable, in sync).
//   - Terminal panel: the Terminal app's PTY backend (main/ipc/pty.js) and xterm.js, started in the opened folder.
//   - Status bar: git branch (main/ipc/code.js, git with an argument vector), cursor, indentation, line ending, language.
// Test hook: ctx.win.el.__code (the CodeApp instance).
import { CM, LANGS, langOf, extensions, detectIndent, tabExt, dressSearchPanel, Sync } from './lib/cm.js';
import { SearchPanel } from './lib/search.js';
import { DiffView } from './lib/diff.js';
import { loadXterm } from '../terminal/lib/session.js';
import { bus } from '../terminal/lib/bus.js';
import { resolveScheme, xtermTheme, pageAmbiance } from '../terminal/lib/schemes.js';
import { effectiveTheme } from '../../core/theme.js';
import { i18n } from '../../core/i18n.js';

const { EditorView, EditorState, EditorSelection, Compartment, Transaction, Text } = CM;
const MAX_BYTES = 8 * 1024 * 1024;
const ALWAYS_HIDDEN = new Set(['.git', 'node_modules']);
const MAX_RECENT = 8;
const MAX_LAYOUTS = 24;
const MAX_RESTORE = 24;
const TAB_TYPE = 'application/x-selene-code-tab';

const langComp = new Compartment();
const wrapComp = new Compartment();
const tabComp = new Compartment();

const join = (dir, name) => (dir.endsWith('/') ? dir + name : `${dir}/${name}`);
const baseName = (p) => String(p).replace(/\/+$/, '').split('/').pop() || p;
const dirName = (p) => String(p).replace(/\/[^/]*$/, '') || '/';
const extOf = (name) => (/\.[^./]+$/.exec(name)?.[0] || '').toLowerCase();
const within = (p, dir) => p === dir || p.startsWith(dir.endsWith('/') ? dir : `${dir}/`);
const textOf = (s) => Text.of(String(s).split(/\r\n|\r|\n/));

let tabSeq = 0;
let docSeq = 0;
let paneSeq = 0;

/** One open document: a file, or an untitled buffer. Shared by every tab (and comparison) that shows it. */
class Doc {
  constructor({ path = null, name, eol = 'LF', lang = 'plain', indent = { tabs: false, size: 2 } }) {
    this.id = ++docSeq;
    this.path = path;
    this.name = name;
    this.eol = eol;
    this.lang = lang;
    this.indent = indent;
    this.saved = Text.of(['']); // the text as last loaded or saved
    this.dirty = false;
    this.version = 0; // + 1 for each change (search results remember it)
    this.tabs = new Set();
  }
}

/** A tab of a pane: a document ('file') or a comparison ('diff', tab.diff = DiffView). */
class Tab {
  constructor(kind, pane, doc) {
    this.id = ++tabSeq;
    this.kind = kind;
    this.pane = pane;
    this.doc = doc;
    this.state = null; // the EditorState while the tab is not shown ('file')
    this.scroll = 0;
    this.diff = null;
  }

  get name() {
    return this.kind === 'diff' ? this.diff?.title || '' : this.doc.name;
  }

  get path() {
    return this.kind === 'file' ? this.doc.path : null;
  }

  get dirty() {
    return !!this.doc?.dirty;
  }

  get lang() {
    return this.doc?.lang;
  }

  get eol() {
    return this.doc?.eol;
  }

  get indent() {
    return this.doc?.indent;
  }
}

class CodeApp {
  constructor(ctx) {
    this.ctx = ctx;
    this.win = ctx.win;
    this.t = ctx.t;
    this.h = ctx.h;
    this.api = ctx.api;
    this.ui = ctx.ui;
    this.folder = null;
    this.entries = new Map(); // dir -> [Entry]
    this.expanded = new Set();
    this.git = { repo: false, files: {}, ignored: [] };
    this.ignoredSet = new Set();
    this.changedDirs = new Map(); // rel dir -> strongest code inside
    this.docs = new Set();
    this.panes = [];
    this.focused = null; // the pane that has (or last had) the focus
    this.split = null; // 'right' | 'down' while two panes are shown
    this.ratio = 0.5;
    this.focusedRow = null;
    this.compareFirst = null; // « Sélectionner pour comparer »
    this.prefs = {
      recent: [],
      showIgnored: false,
      wrap: false,
      terminal: false,
      sideW: 260,
      panelH: 220,
      sideHidden: false,
      sideView: 'explorer',
      diffMode: 'split',
      layouts: {},
      search: {},
    };
    this.term = null;
    this.termOpen = false;
    this.closeIcon = () => this.icon('x', { size: 16 }); // the find panel's close button (lib/cm.js dressSearchPanel)
  }

  icon(name, opts) {
    return this.ctx.icon(name, opts);
  }

  uiLang() {
    return String(i18n.lang).startsWith('fr') ? 'fr' : 'en';
  }

  // ------------------------------------------------------------------ the focused pane (compatibility getters)
  get pane() {
    return this.focused;
  }

  /** The tabs of the focused pane. */
  get tabs() {
    return this.focused?.tabs || [];
  }

  /** The active tab of the focused pane. */
  get active() {
    return this.focused?.active || null;
  }

  /** The editor of the focused pane: its EditorView, or the editable side of a comparison. */
  get view() {
    const tab = this.focused?.active;
    return tab?.kind === 'diff' ? tab.diff.editView : this.focused?.view;
  }

  get host() {
    return this.focused?.host;
  }

  get tabsEl() {
    return this.focused?.tabsEl;
  }

  allTabs() {
    return this.panes.flatMap((p) => p.tabs);
  }

  otherPane(pane) {
    return this.panes.find((p) => p !== pane) || null;
  }

  // ------------------------------------------------------------------ setup
  async init() {
    const { h, t } = this;
    const saved = await this.ctx.storage.get('prefs', null);
    if (saved && typeof saved === 'object') Object.assign(this.prefs, saved);
    if (!this.prefs.layouts || typeof this.prefs.layouts !== 'object') this.prefs.layouts = {};
    const btn = (ic, tip, onclick, extra = {}) =>
      h('button', { class: 'btn subtle code-tbtn', 'data-tip': tip, 'aria-label': tip, onclick, ...extra }, this.icon(ic, { size: 18 }));

    this.treeEl = h('div', { class: 'code-tree', role: 'tree', tabindex: 0, 'aria-label': t('explorer'), onkeydown: (e) => this.treeKey(e), oncontextmenu: (e) => this.treeMenu(e, null) });
    this.sideTitle = h('div', { class: 'code-side-title' }, t('explorer'));
    this.explorerEl = h(
      'div',
      { class: 'code-explorer' },
      h(
        'div',
        { class: 'code-side-head' },
        this.sideTitle,
        h(
          'div',
          { class: 'code-side-actions' },
          btn('file-plus', t('newFile'), () => this.createIn(this.targetDir(), false), { 'data-act': 'new-file' }),
          btn('folder-simple-plus', t('newFolder'), () => this.createIn(this.targetDir(), true), { 'data-act': 'new-folder' }),
          btn('arrow-clockwise', t('refresh'), () => this.refresh(), { 'data-act': 'refresh' }),
          btn('caret-double-left', t('collapseAll'), () => this.collapseAll(), { 'data-act': 'collapse' }),
        ),
      ),
      this.treeEl,
    );
    this.search = new SearchPanel(this);
    const act = (view, ic, tip) =>
      h('button', { class: 'code-act', role: 'tab', 'data-view': view, 'data-tip': tip, 'aria-label': tip, onclick: () => this.setSideView(view, { focus: true }) }, this.icon(ic, { size: 20 }));
    this.actBtns = [act('explorer', 'files', `${t('explorer')} (${t('kExplorer')})`), act('search', 'magnifying-glass', `${t('searchTitle')} (${t('kSearch')})`)];
    this.side = h(
      'aside',
      { class: 'code-side' },
      h('div', { class: 'code-activity', role: 'tablist', 'aria-orientation': 'vertical', 'aria-label': t('sideViews') }, this.actBtns),
      h('div', { class: 'code-side-body' }, this.explorerEl, this.search.el),
    );
    this.splitter = h('div', { class: 'code-split', role: 'separator', 'aria-orientation': 'vertical', onpointerdown: (e) => this.dragSide(e) });

    this.panesEl = h('div', { class: 'code-panes' });
    this.paneSplitter = h('div', {
      class: 'code-pane-split',
      role: 'separator',
      tabindex: 0,
      'aria-label': t('paneResize'),
      onpointerdown: (e) => this.dragPanes(e),
      onkeydown: (e) => this.paneSplitKey(e),
    });
    this.welcome = h('div', { class: 'code-welcome' });
    this.termHost = h('div', { class: 'code-term-host' });
    this.panel = h(
      'section',
      { class: 'code-panel', 'aria-label': t('terminal') },
      h('div', { class: 'code-panel-split', role: 'separator', 'aria-orientation': 'horizontal', onpointerdown: (e) => this.dragPanel(e) }),
      h(
        'div',
        { class: 'code-panel-head' },
        h('span', { class: 'code-panel-title' }, this.icon('terminal-window', { size: 16 }), t('terminal')),
        h('span', { class: 'code-grow' }),
        btn('arrow-clockwise', t('termRestart'), () => this.restartTerminal(), { 'data-act': 'term-restart' }),
        btn('x', t('termHide'), () => this.toggleTerminal(false), { 'data-act': 'term-hide' }),
      ),
      this.termHost,
    );
    this.center = h('div', { class: 'code-center' }, h('div', { class: 'code-editors' }, this.panesEl, this.welcome), this.panel);

    this.stBranch = h('button', { class: 'code-st code-st-branch', onclick: () => this.refresh() });
    this.stPos = h('button', { class: 'code-st', onclick: () => this.gotoLine() });
    this.stIndent = h('button', { class: 'code-st', onclick: (e) => this.indentMenu(e) });
    this.stEnc = h('span', { class: 'code-st' }, 'UTF-8');
    this.stEol = h('span', { class: 'code-st' });
    this.stLang = h('button', { class: 'code-st', onclick: (e) => this.langMenu(e) });
    this.status = h(
      'footer',
      { class: 'code-status' },
      this.stBranch,
      h('span', { class: 'code-grow' }),
      this.stPos,
      this.stIndent,
      this.stEnc,
      this.stEol,
      this.stLang,
    );

    this.saveBtn = btn('floppy-disk', `${t('save')} (Ctrl+S)`, () => this.save(), { 'data-act': 'save' });
    this.termBtn = btn('terminal-window', `${t('terminal')} (Ctrl+\`)`, () => this.toggleTerminal(), { 'data-act': 'terminal' });
    this.splitBtn = btn('square-split-horizontal', `${t('splitRight')} (Ctrl+\\)`, () => this.splitEditor('right'), { 'data-act': 'split' });
    const toolbar = h(
      'div',
      { class: 'code-toolbar', role: 'toolbar' },
      btn('sidebar-simple', `${t('toggleSide')} (Ctrl+B)`, () => this.toggleSide(), { 'data-act': 'side' }),
      h('button', { class: 'btn subtle code-open', 'data-act': 'open-folder', onclick: () => this.pickFolder() }, this.icon('folder-open', { size: 18 }), h('span', null, t('openFolder'))),
      btn('file-plus', `${t('newFile')} (Ctrl+N)`, () => this.newUntitled(), { 'data-act': 'new-untitled' }),
      this.saveBtn,
      h('span', { class: 'code-sep' }),
      btn('magnifying-glass', `${t('find')} (Ctrl+F)`, () => this.find(), { 'data-act': 'find' }),
      btn('list-numbers', `${t('gotoLine')} (Ctrl+G)`, () => this.gotoLine(), { 'data-act': 'goto' }),
      this.splitBtn,
      h('span', { class: 'code-grow' }),
      this.termBtn,
      btn('dots-three', t('more'), (e) => this.moreMenu(e), { 'data-act': 'more' }),
    );

    this.root = h(
      'div',
      { class: 'code-root' },
      toolbar,
      h('div', { class: 'code-main' }, this.side, this.splitter, this.center),
      this.status,
    );
    this.win.body.appendChild(this.root);
    this.addPane();
    this.applySplit();
    this.applyLayout();
    this.setSideView(this.prefs.sideView === 'search' ? 'search' : 'explorer', { save: false });

    this.root.addEventListener('keydown', (e) => this.keys(e), true);
    this.win.onBeforeClose(() => this.beforeClose());
    this.win.on?.('close', () => this.dispose());
    this.win.on?.('focus', () => this.softRefresh());
    this.offTheme = this.ctx.settings?.on?.('theme', () => setTimeout(() => this.applyTermTheme(), 50));

    const args = this.ctx.args || {};
    if (args.folder) await this.openFolder(args.folder);
    else if (args.file) {
      if (this.prefs.folder && within(args.file, this.prefs.folder)) await this.openFolder(this.prefs.folder);
      await this.openFile(args.file);
    } else if (this.prefs.folder && (await this.api.invoke('fs:exists', this.prefs.folder).catch(() => false))) await this.openFolder(this.prefs.folder);
    this.render();
    if (this.prefs.terminal && this.folder) this.toggleTerminal(true);
  }

  relaunch(args = {}) {
    this.win.focus();
    if (args.folder) this.openFolder(args.folder);
    else if (args.file) this.openFile(args.file);
  }

  savePrefs() {
    this.prefs.folder = this.folder;
    this.ctx.storage.set('prefs', this.prefs);
  }

  applyLayout() {
    this.root.style.setProperty('--code-side-w', `${this.prefs.sideW}px`);
    this.root.style.setProperty('--code-panel-h', `${this.prefs.panelH}px`);
    this.root.classList.toggle('no-side', !!this.prefs.sideHidden);
    this.root.classList.toggle('term-open', !!this.prefs.terminal && !!this.termOpen);
  }

  // ------------------------------------------------------------------ side panel: explorer / search
  setSideView(view, { focus = false, save = true } = {}) {
    const v = view === 'search' ? 'search' : 'explorer';
    this.prefs.sideView = v;
    this.side.dataset.view = v;
    for (const b of this.actBtns) {
      const on = b.dataset.view === v;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', String(on));
    }
    if (this.prefs.sideHidden && save) {
      this.prefs.sideHidden = false;
      this.applyLayout();
    }
    if (save) this.savePrefs();
    if (focus) {
      if (v === 'search') this.search.focus();
      else this.treeEl.focus();
    }
  }

  /** Ctrl+Shift+F (Ctrl+Shift+H: with the replace field): the search view, with the selected text as the query. */
  showSearch({ replace = false } = {}) {
    const v = this.active ? this.view : null;
    const sel = v?.state.selection.main;
    const picked = sel && !sel.empty ? v.state.sliceDoc(sel.from, sel.to) : '';
    this.setSideView('search');
    if (picked && !picked.includes('\n') && picked.length <= 200) {
      this.search.opts.query = picked;
      this.search.syncControls();
      this.search.run();
    }
    this.search.focus({ replace });
  }

  // ------------------------------------------------------------------ folder and tree
  async pickFolder() {
    const p = await this.ui.filePicker({ mode: 'folder', title: this.t('openFolder'), path: this.folder || undefined, parent: this.win });
    if (p) await this.openFolder(Array.isArray(p) ? p[0] : p);
  }

  async openFolder(dir) {
    const st = await this.api.invoke('fs:stat', dir).catch(() => null);
    if (!st?.dir) {
      this.ui.alert(this.t('folderMissing', { path: dir }), { parent: this.win });
      return false;
    }
    if (this.folder) this.saveLayoutNow();
    this.folder = st.path || dir;
    this.entries.clear();
    this.expanded = new Set([this.folder]);
    this.prefs.recent = [this.folder, ...this.prefs.recent.filter((r) => r !== this.folder)].slice(0, MAX_RECENT);
    this.savePrefs();
    // search, replace and git show only work in a folder the app registered (main/ipc/code.js)
    await Promise.all([this.loadDir(this.folder), this.loadGit(), this.api.invoke('code:openFolder', this.folder).catch(() => null)]);
    this.search.reset();
    this.render();
    await this.restoreLayout();
    if (this.term && this.ptyId) this.api.send('pty:write', this.ptyId, `cd ${shellQuote(this.folder)}\r`);
    return true;
  }

  async loadDir(dir) {
    const list = await this.api.invoke('fs:list', dir, { hidden: true }).catch(() => []);
    list.sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })));
    this.entries.set(dir, list);
    return list;
  }

  async loadGit() {
    if (!this.folder) return;
    const g = await this.api.invoke('code:git', this.folder).catch(() => ({ repo: false }));
    this.git = { files: {}, ignored: [], ...g };
    this.ignoredSet = new Set((this.git.ignored || []).map((p) => p.replace(/\/$/, '')));
    const rank = { U: 5, D: 4, M: 3, R: 3, A: 2, '?': 1 };
    this.changedDirs = new Map();
    for (const [p, code] of Object.entries(this.git.files || {})) {
      const parts = p.replace(/\/$/, '').split('/');
      for (let i = 1; i < (p.endsWith('/') ? parts.length + 1 : parts.length); i++) {
        const d = parts.slice(0, i).join('/');
        if ((rank[code] || 0) > (rank[this.changedDirs.get(d)] || 0)) this.changedDirs.set(d, code);
      }
    }
  }

  rel(p) {
    if (!this.folder || !p || !within(p, this.folder)) return null;
    return p.slice(this.folder.length).replace(/^\/+/, '');
  }

  isIgnored(entry) {
    if (ALWAYS_HIDDEN.has(entry.name)) return true;
    const r = this.rel(entry.path);
    return r != null && this.ignoredSet.has(r);
  }

  /** The git code of a file or folder ('M', 'A', '?', 'D', 'U', 'R') or ''. */
  gitCode(entry) {
    const r = this.rel(entry.path);
    if (r == null || !this.git.repo) return '';
    const f = this.git.files || {};
    if (entry.dir) return f[`${r}/`] || this.changedDirs.get(r) || '';
    if (f[r]) return f[r];
    // inside an untracked folder ('dir/' entry)
    const parts = r.split('/');
    for (let i = parts.length - 1; i > 0; i--) if (f[`${parts.slice(0, i).join('/')}/`] === '?') return '?';
    return '';
  }

  async refresh() {
    if (!this.folder) return;
    const dirs = [...this.expanded].filter((d) => within(d, this.folder));
    // reload in place (no clear first): a rename / new-name check during the reload still sees the listing
    await Promise.all([...dirs.map((d) => this.loadDir(d)), this.loadGit()]);
    for (const d of [...this.entries.keys()]) if (!dirs.includes(d)) this.entries.delete(d);
    this.renderTree();
    this.renderStatus();
  }

  softRefresh() {
    clearTimeout(this.softTimer);
    if (!this.folder || Date.now() - (this.lastSoft || 0) < 3000) return;
    this.softTimer = setTimeout(() => {
      this.lastSoft = Date.now();
      this.refresh();
    }, 200);
  }

  collapseAll() {
    if (!this.folder) return;
    this.expanded = new Set([this.folder]);
    this.renderTree();
  }

  async toggleDir(path, open = !this.expanded.has(path)) {
    if (open) {
      this.expanded.add(path);
      if (!this.entries.has(path)) await this.loadDir(path);
    } else this.expanded.delete(path);
    this.renderTree();
  }

  /** Visible rows, depth first: [{ entry, depth }]. */
  rows() {
    const out = [];
    const walk = (dir, depth) => {
      for (const e of this.entries.get(dir) || []) {
        const ignored = this.isIgnored(e);
        if (ignored && !this.prefs.showIgnored) continue;
        out.push({ entry: e, depth, ignored });
        if (e.dir && this.expanded.has(e.path)) walk(e.path, depth + 1);
      }
    };
    if (this.folder) walk(this.folder, 0);
    return out;
  }

  renderTree() {
    const { h, t } = this;
    this.treeEl.replaceChildren();
    this.sideTitle.textContent = this.folder ? baseName(this.folder) : t('explorer');
    this.sideTitle.title = this.folder || '';
    this.side.classList.toggle('no-folder', !this.folder); // (not .empty: a core/ui.css class)
    if (!this.folder) {
      this.treeEl.append(
        h('div', { class: 'code-tree-empty' }, h('p', null, t('noFolder')), h('button', { class: 'btn primary', 'data-act': 'tree-open', onclick: () => this.pickFolder() }, t('openFolder'))),
      );
      return;
    }
    const activePath = this.active?.path;
    for (const { entry: e, depth, ignored } of this.rows()) {
      const code = this.gitCode(e);
      const open = e.dir && this.expanded.has(e.path);
      const row = h(
        'div',
        {
          class: ['code-row', e.dir && 'dir', ignored && 'ignored', code && `git-${code === '?' ? 'U-new' : code}`, e.path === activePath && 'active', e.path === this.focusedRow && 'focused'],
          role: 'treeitem',
          'aria-expanded': e.dir ? String(open) : null,
          'aria-selected': String(e.path === activePath),
          'data-path': e.path,
          style: { paddingLeft: `${8 + depth * 14}px` },
          title: e.path,
          onclick: () => {
            this.focusedRow = e.path;
            if (e.dir) this.toggleDir(e.path);
            else this.openFile(e.path);
          },
          oncontextmenu: (ev) => this.treeMenu(ev, e),
        },
        h('span', { class: 'code-caret' }, e.dir ? this.icon(open ? 'caret-down' : 'caret-right', { size: 12 }) : null),
        this.icon(e.dir ? (open ? 'folder-open' : 'folder-simple') : this.ui.fileIcon(e), { size: 16, filled: e.dir, class: e.dir ? 'folder-icon' : 'file-icon' }),
        h('span', { class: 'code-name' }, e.name),
        code ? h('span', { class: 'code-git', 'data-tip': t(`git.${code === '?' ? 'untracked' : code}`) }, e.dir ? '•' : code === '?' ? 'U' : code) : null,
      );
      this.treeEl.append(row);
    }
    if (!this.treeEl.children.length) this.treeEl.append(h('div', { class: 'code-tree-empty' }, h('p', null, t('emptyFolder'))));
  }

  treeKey(e) {
    const rows = this.rows();
    if (!rows.length) return;
    let i = rows.findIndex((r) => r.entry.path === this.focusedRow);
    const cur = rows[i]?.entry;
    const move = (j) => {
      j = Math.max(0, Math.min(rows.length - 1, j));
      this.focusedRow = rows[j].entry.path;
      this.renderTree();
      this.treeEl.querySelector('.code-row.focused')?.scrollIntoView({ block: 'nearest' });
    };
    if (e.key === 'ArrowDown') move(i + 1);
    else if (e.key === 'ArrowUp') move(i < 0 ? 0 : i - 1);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(rows.length - 1);
    else if (e.key === 'ArrowRight' && cur?.dir) this.toggleDir(cur.path, true);
    else if (e.key === 'ArrowLeft' && cur) {
      if (cur.dir && this.expanded.has(cur.path)) this.toggleDir(cur.path, false);
      else if (dirName(cur.path) !== this.folder) move(rows.findIndex((r) => r.entry.path === dirName(cur.path)));
    } else if (e.key === 'Enter' && cur) cur.dir ? this.toggleDir(cur.path) : this.openFile(cur.path);
    else if (e.key === 'F2' && cur) this.renameEntry(cur);
    else if (e.key === 'Delete' && cur) this.trashEntry(cur);
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  targetDir() {
    const sel = this.focusedRow && this.rows().find((r) => r.entry.path === this.focusedRow)?.entry;
    if (sel) return sel.dir ? sel.path : dirName(sel.path);
    return this.folder;
  }

  treeMenu(ev, entry) {
    if (!this.folder) return;
    ev.preventDefault();
    ev.stopPropagation();
    const { t } = this;
    const dir = entry ? (entry.dir ? entry.path : dirName(entry.path)) : this.folder;
    if (entry) this.focusedRow = entry.path;
    const items = [
      { label: t('newFile'), icon: 'file-plus', action: () => this.createIn(dir, false) },
      { label: t('newFolder'), icon: 'folder-simple-plus', action: () => this.createIn(dir, true) },
    ];
    if (entry) {
      items.push('-');
      if (!entry.dir) {
        items.push(
          { label: t('open'), icon: 'file-text', action: () => this.openFile(entry.path) },
          { label: t('openToSide'), icon: 'square-split-horizontal', action: () => this.openToSide(entry.path) },
        );
      }
      items.push(
        { label: t('rename'), icon: 'pencil-simple', shortcut: 'F2', action: () => this.renameEntry(entry) },
        { label: t('delete'), icon: 'trash', shortcut: t('key.delete'), danger: true, action: () => this.trashEntry(entry) },
      );
      if (!entry.dir) {
        const code = this.gitCode(entry);
        items.push('-');
        if (this.git.repo && code && code !== 'D') items.push({ label: t('compareHead'), icon: 'arrows-left-right', action: () => this.compareHead(entry.path) });
        if (this.compareFirst && this.compareFirst !== entry.path) {
          const first = this.compareFirst;
          items.push({ label: t('compareWithSelected', { name: baseName(first) }), icon: 'arrows-left-right', action: () => this.compareFiles(first, entry.path) });
        }
        items.push({ label: t('selectForCompare'), action: () => (this.compareFirst = entry.path) });
      }
      items.push(
        '-',
        { label: t('copyPath'), icon: 'copy', action: () => this.api.invoke('clipboard:writeText', entry.path) },
        { label: t('openTerminalHere'), icon: 'terminal-window', action: () => this.terminalCd(dir) },
      );
    } else items.push('-', { label: t('refresh'), icon: 'arrow-clockwise', action: () => this.refresh() });
    this.ui.menu(ev, items);
  }

  validName(dir) {
    return (v) => {
      const name = String(v || '').trim();
      if (!name) return this.t('nameEmpty');
      if (name.includes('/') || name === '.' || name === '..' || name.includes('\0')) return this.t('nameInvalid');
      if ((this.entries.get(dir) || []).some((e) => e.name === name)) return this.t('nameExists');
      return null;
    };
  }

  async createIn(dir, folder) {
    if (!dir) return folder ? null : this.newUntitled();
    const name = await this.ui.prompt({
      title: this.t(folder ? 'newFolder' : 'newFile'),
      label: this.t('nameLabel'),
      placeholder: folder ? this.t('folderPlaceholder') : this.t('filePlaceholder'),
      okLabel: this.t('create'),
      parent: this.win,
      validate: this.validName(dir),
    });
    if (!name) return null;
    const path = join(dir, name.trim());
    try {
      if (folder) await this.api.invoke('fs:mkdir', path);
      else {
        // never empty an existing file (the listing may be stale)
        if (await this.api.invoke('fs:exists', path).catch(() => false)) throw new Error(this.t('nameExists'));
        await this.api.invoke('fs:writeText', path, '');
      }
    } catch (err) {
      this.ui.alert(this.t('createFailed', { error: err.message }), { parent: this.win });
      return null;
    }
    this.expanded.add(dir);
    await this.loadDir(dir);
    await this.loadGit();
    this.focusedRow = path;
    this.renderTree();
    if (!folder) await this.openFile(path);
    return path;
  }

  async renameEntry(entry) {
    const dir = dirName(entry.path);
    const name = await this.ui.prompt({
      title: this.t('rename'),
      label: this.t('nameLabel'),
      value: entry.name,
      okLabel: this.t('rename'),
      parent: this.win,
      validate: (v) => (String(v).trim() === entry.name ? null : this.validName(dir)(v)),
    });
    if (!name || name.trim() === entry.name) return;
    let res;
    try {
      res = await this.api.invoke('fs:rename', entry.path, name.trim());
    } catch (err) {
      this.ui.alert(this.t('renameFailed', { error: err.message }), { parent: this.win });
      return;
    }
    const to = res?.path || join(dir, name.trim());
    for (const doc of this.docs) {
      if (doc.path && within(doc.path, entry.path)) {
        doc.path = to + doc.path.slice(entry.path.length);
        doc.name = baseName(doc.path);
      }
    }
    if (this.expanded.has(entry.path)) {
      this.expanded.delete(entry.path);
      this.expanded.add(to);
    }
    this.focusedRow = to;
    await this.refresh();
    this.renderTabs();
    this.updateTitle();
    this.saveLayoutSoon();
  }

  async trashEntry(entry) {
    const ok = await this.ui.confirm(this.t(entry.dir ? 'trashFolderConfirm' : 'trashFileConfirm', { name: entry.name }), {
      title: this.t('delete'),
      okLabel: this.t('moveToTrash'),
      danger: true,
      parent: this.win,
    });
    if (!ok) return;
    try {
      await this.api.invoke('fs:trash', [entry.path]);
    } catch (err) {
      this.ui.alert(this.t('trashFailed', { error: err.message }), { parent: this.win });
      return;
    }
    for (const tab of this.allTabs()) if (tab.doc?.path && within(tab.doc.path, entry.path)) await this.closeTab(tab, true);
    this.focusedRow = null;
    await this.refresh();
  }

  // ------------------------------------------------------------------ documents
  docByPath(path) {
    for (const d of this.docs) if (d.path === path) return d;
    return null;
  }

  /** The view that shows a tab right now (null when its state is stored). */
  liveView(tab) {
    if (tab.kind === 'diff') return tab.diff?.editView || null;
    const p = tab.pane;
    return p && p.active === tab && p.view.codeTab === tab ? p.view : null;
  }

  tabState(tab) {
    return this.liveView(tab)?.state || tab.state || null;
  }

  docState(doc) {
    for (const t of doc.tabs) {
      const s = this.tabState(t);
      if (s) return s;
    }
    return null;
  }

  docText(doc) {
    return this.docState(doc)?.doc || null;
  }

  /** The extensions of an editor of `doc` (the tabs, and the editable side of its comparisons). */
  docExtensions(doc, keys = []) {
    return extensions({
      lang: doc.lang,
      langComp,
      wrapComp,
      tabComp,
      indent: doc.indent,
      wrap: this.prefs.wrap,
      uiLang: this.uiLang(),
      keys: [
        ...keys,
        { key: 'Mod-s', run: () => (this.save(), true) },
        { key: 'Mod-g', run: () => (this.gotoLine(), true) },
        { key: 'Mod-h', run: (v) => (CM.openSearchPanel(v), setTimeout(() => v.dom.querySelector('.cm-search [name=replace]')?.focus(), 0), true) },
      ],
      closeIcon: this.closeIcon,
      onUpdate: (u) => this.onUpdate(u),
    });
  }

  /** Reconfigures every editor of a document (language, indentation, wrapping). */
  reconfigureDoc(doc, effects) {
    for (const t of doc.tabs) {
      const v = this.liveView(t);
      if (v) v.dispatch({ effects });
      else if (t.state) t.state = t.state.update({ effects }).state;
    }
  }

  /** Copies a change made in one editor of a document to its other tabs (not to their undo history). */
  propagate(doc, src, tr) {
    const spec = { changes: tr.changes, annotations: [Sync.of(true), Transaction.addToHistory.of(false)] };
    for (const t of doc.tabs) {
      if (t === src) continue;
      const v = this.liveView(t);
      if (v) v.dispatch(spec);
      else if (t.state) t.state = t.state.update(spec).state;
    }
  }

  markDirty(doc, state) {
    const dirty = !state.doc.eq(doc.saved);
    if (dirty !== doc.dirty) {
      doc.dirty = dirty;
      this.renderTabs();
      this.updateTitle();
    }
  }

  onUpdate(u) {
    const tab = u.view.codeTab;
    if (!tab?.doc) return;
    const doc = tab.doc;
    if (u.docChanged) {
      let own = false;
      for (const tr of u.transactions) {
        if (!tr.docChanged || tr.annotation(Sync)) continue;
        own = true;
        this.propagate(doc, tab, tr);
      }
      if (own) doc.version++;
      this.markDirty(doc, u.state);
    }
    if (tab.kind === 'diff' && (u.docChanged || u.selectionSet)) tab.diff.refresh();
    if ((u.docChanged || u.selectionSet) && tab === this.active) this.renderPos();
  }

  /** A change made by the app (replace across files, undo of it): through a shown editor when there is one. */
  applyToDoc(doc, spec) {
    for (const t of doc.tabs) {
      const v = this.liveView(t);
      if (v) {
        v.dispatch(spec);
        return;
      }
    }
    const t = [...doc.tabs].find((x) => x.state);
    if (!t) return;
    const tr = t.state.update(spec);
    t.state = tr.state;
    if (tr.docChanged) {
      this.propagate(doc, t, tr);
      doc.version++;
      this.markDirty(doc, tr.state);
    }
  }

  /**
   * Reads a document's file again when it has no unsaved change (a replace across files wrote it). Only the changed
   * middle is replaced: the cursors stay where they were; Ctrl+Z in the editor goes back.
   */
  async reloadDoc(doc) {
    if (!doc?.path || doc.dirty) return false;
    let text;
    try {
      text = await this.api.invoke('fs:readText', doc.path, { maxBytes: MAX_BYTES });
    } catch {
      return false;
    }
    const cur = this.docText(doc)?.toString();
    if (cur == null || doc.dirty) return false;
    const next = text.replace(/\r\n?/g, '\n');
    if (cur !== next) {
      let a = 0;
      while (a < cur.length && a < next.length && cur.charCodeAt(a) === next.charCodeAt(a)) a++;
      let b = 0;
      while (b < cur.length - a && b < next.length - a && cur.charCodeAt(cur.length - 1 - b) === next.charCodeAt(next.length - 1 - b)) b++;
      this.applyToDoc(doc, { changes: { from: a, to: cur.length - b, insert: next.slice(a, next.length - b) }, userEvent: 'input.replace' });
    }
    doc.saved = this.docText(doc);
    this.markDirty(doc, this.docState(doc));
    return true;
  }

  /** The texts of the open documents of the folder (searched instead of the files) and their versions. */
  openBuffers() {
    const buffers = [];
    const versions = new Map();
    for (const doc of this.docs) {
      if (!doc.path || !this.folder || !within(doc.path, this.folder)) continue;
      const text = this.docText(doc);
      if (!text) continue;
      buffers.push({ path: doc.path, text: text.toString() });
      versions.set(doc.path, doc.version);
    }
    return { buffers, versions };
  }

  /** Reads a file into a new document: { doc, text } or null (an alert says why, unless quiet). */
  async loadDoc(path, { quiet = false } = {}) {
    const fail = (key, vars) => {
      if (!quiet) this.ui.alert(this.t(key, vars), { parent: this.win });
      return null;
    };
    const st = await this.api.invoke('fs:stat', path).catch(() => null);
    if (!st || st.dir) return fail('fileMissing', { path });
    if (st.size > MAX_BYTES) return fail('fileTooBig', { name: baseName(path) });
    let text;
    try {
      text = await this.api.invoke('fs:readText', path, { maxBytes: MAX_BYTES });
    } catch (err) {
      return fail('openFailed', { error: err.message });
    }
    if (text.includes('\0')) {
      if (quiet) return null;
      const ok = await this.ui.confirm(this.t('binaryFile', { name: baseName(path) }), { title: this.t('open'), okLabel: this.t('openWith'), parent: this.win });
      if (ok) this.ctx.shell.openFile(path);
      return null;
    }
    // opened meanwhile (two quick clicks)
    const again = this.docByPath(path);
    if (again) return { doc: again, text: this.docText(again)?.toString() ?? text };
    const doc = new Doc({ path, name: baseName(path), eol: text.includes('\r\n') ? 'CRLF' : 'LF', lang: langOf(path, text.slice(0, 200).split('\n')[0]), indent: detectIndent(text) });
    doc.saved = textOf(text);
    return { doc, text };
  }

  // ------------------------------------------------------------------ panes
  addPane() {
    const { h, t } = this;
    const pane = { id: ++paneSeq, tabs: [], active: null };
    pane.tabsEl = h('div', { class: 'code-tabs', role: 'tablist', 'aria-label': t('openFiles') });
    // no scrollbar on the tab strip: a vertical wheel scrolls it sideways
    pane.tabsEl.addEventListener(
      'wheel',
      (e) => {
        if (!e.deltaY || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
        pane.tabsEl.scrollLeft += e.deltaY;
        e.preventDefault();
      },
      { passive: false },
    );
    // a tab dragged here from the other pane (or within this one)
    pane.tabsEl.addEventListener('dragover', (e) => {
      if (![...(e.dataTransfer?.types || [])].includes(TAB_TYPE)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      pane.tabsEl.classList.add('drop');
    });
    pane.tabsEl.addEventListener('dragleave', () => pane.tabsEl.classList.remove('drop'));
    pane.tabsEl.addEventListener('drop', (e) => {
      pane.tabsEl.classList.remove('drop');
      const id = Number(e.dataTransfer?.getData(TAB_TYPE));
      const tab = this.allTabs().find((x) => x.id === id);
      if (!tab) return;
      e.preventDefault();
      const over = e.target.closest?.('.code-tab');
      const at = over ? pane.tabs.findIndex((x) => String(x.id) === over.dataset.id) : -1;
      this.moveTab(tab, pane, at < 0 ? null : at);
    });
    const pbtn = (ic, tip, onclick, act) => h('button', { class: 'btn subtle code-tbtn', 'data-tip': tip, 'aria-label': tip, 'data-act': act, onclick }, this.icon(ic, { size: 16 }));
    pane.splitBtn = pbtn('square-split-horizontal', `${t('splitRight')} (Ctrl+\\)`, () => this.splitEditor('right', pane.active), 'pane-split');
    pane.closeBtn = pbtn('x', t('closePane'), () => this.closePane(pane), 'pane-close');
    pane.bar = h('div', { class: 'code-tabbar' }, pane.tabsEl, h('div', { class: 'code-pane-acts' }, pane.splitBtn, pane.closeBtn));
    pane.host = h('div', { class: 'code-host' });
    pane.diffHost = h('div', { class: 'code-diff-host' });
    pane.el = h('div', { class: 'code-pane', 'data-pane': pane.id }, pane.bar, h('div', { class: 'code-editor' }, pane.host, pane.diffHost));
    pane.el.addEventListener('pointerdown', () => this.focusPane(pane), true);
    pane.el.addEventListener('focusin', () => this.focusPane(pane));
    pane.view = new EditorView({ parent: pane.host, state: EditorState.create({ doc: '' }) });
    pane.view.codeTab = null;
    this.panes.push(pane);
    if (!this.focused) this.focused = pane;
    return pane;
  }

  applySplit() {
    const two = this.panes.length > 1;
    const down = two && this.split === 'down';
    this.panesEl.classList.toggle('split-right', two && !down);
    this.panesEl.classList.toggle('split-down', down);
    const want = two ? [this.panes[0].el, this.paneSplitter, this.panes[1].el] : [this.panes[0].el];
    const have = [...this.panesEl.children];
    if (want.length !== have.length || want.some((el, i) => el !== have[i])) this.panesEl.replaceChildren(...want);
    this.paneSplitter.setAttribute('aria-orientation', down ? 'horizontal' : 'vertical');
    this.applyRatio();
    this.root.classList.toggle('two-panes', two);
  }

  applyRatio() {
    const two = this.panes.length > 1;
    this.panes[0].el.style.flex = two ? `${this.ratio} 1 0` : '';
    if (two) this.panes[1].el.style.flex = `${1 - this.ratio} 1 0`;
    this.paneSplitter.setAttribute('aria-valuenow', String(Math.round(this.ratio * 100)));
  }

  focusPane(pane, { focus = false } = {}) {
    if (!pane || !this.panes.includes(pane)) return;
    const changed = this.focused !== pane;
    this.focused = pane;
    if (focus) {
      if (pane.active?.kind === 'diff') pane.active.diff.focus();
      else if (pane.active) pane.view.focus();
    }
    if (changed) {
      this.renderPaneState();
      this.renderTree();
      this.renderStatus();
      this.updateTitle();
      this.saveLayoutSoon();
    }
  }

  /** Ctrl+1 / Ctrl+2. Ctrl+2 with one pane splits it. */
  focusPaneIndex(i) {
    if (i >= this.panes.length) {
      if (i === 1) this.splitEditor('right');
      return;
    }
    this.focusPane(this.panes[i], { focus: true });
  }

  /**
   * Ctrl+\ : shows the document of `src` (the active tab) in a second pane, to the right or below. With two panes
   * already, in the other one.
   */
  splitEditor(dir = 'right', src = this.active) {
    if (this.panes.length === 1) {
      if (!src?.doc) return null;
      this.split = dir === 'down' ? 'down' : 'right';
      const pane = this.addPane();
      this.applySplit();
      return this.openDocIn(src, pane);
    }
    const d = dir === 'down' ? 'down' : 'right';
    if (this.split !== d) {
      this.split = d;
      this.applySplit();
    }
    if (!src?.doc) return null;
    return this.openDocIn(src, this.otherPane(src.pane));
  }

  /** The document of tab `src` in pane `pane` (its tab there, or a new one at the same place in the text). */
  openDocIn(src, pane) {
    const doc = src.doc;
    const there = pane.tabs.find((x) => x.kind === 'file' && x.doc === doc);
    if (there) return this.activate(there);
    const st = this.tabState(src);
    const tab = this.addTab(pane, doc, { selection: st?.selection });
    return this.activate(tab);
  }

  async openToSide(path) {
    if (this.panes.length === 1) {
      this.split = 'right';
      this.addPane();
      this.applySplit();
    }
    const pane = this.panes.find((p) => p !== this.focused) || this.panes[1];
    const tab = await this.openFile(path, { pane });
    if (!tab && !pane.tabs.length) this.removePane(pane);
    return tab;
  }

  /**
   * Moves a tab to another pane (default: the other one, made when there is only one) at `index`, or within its
   * pane. A file already open there keeps its tab there. quiet: no activation or render (closePane).
   */
  moveTab(tab, pane = null, index = null, { quiet = false } = {}) {
    if (!tab) return null;
    if (!pane) {
      if (this.panes.length < 2) {
        this.split = this.split || 'right';
        pane = this.addPane();
        this.applySplit();
      } else pane = this.otherPane(tab.pane);
    }
    const from = tab.pane;
    const i = from.tabs.indexOf(tab);
    if (i < 0) return null;
    if (from === pane) {
      from.tabs.splice(i, 1);
      const at = index == null ? from.tabs.length : index > i ? index - 1 : index;
      from.tabs.splice(Math.max(0, Math.min(from.tabs.length, at)), 0, tab);
      this.renderTabs();
      this.saveLayoutSoon();
      return tab;
    }
    const wasActive = from.active === tab;
    if (wasActive) this.stash(tab);
    from.tabs.splice(i, 1);
    const there = tab.kind === 'file' ? pane.tabs.find((x) => x.kind === 'file' && x.doc === tab.doc) : null;
    if (there) tab.doc.tabs.delete(tab);
    else {
      tab.pane = pane;
      if (index == null || index > pane.tabs.length) pane.tabs.push(tab);
      else pane.tabs.splice(index, 0, tab);
      if (tab.kind === 'diff') {
        tab.diff.el.hidden = true;
        pane.diffHost.append(tab.diff.el);
      }
    }
    if (wasActive) {
      from.active = null;
      if (!from.tabs.length) this.removePane(from, { quiet: true });
      else if (!quiet) this.activate(from.tabs[Math.min(i, from.tabs.length - 1)], { focus: false, takeFocus: false });
    }
    if (quiet) return there || tab;
    return this.activate(there || tab);
  }

  /** « Fermer le volet »: its tabs join the other pane. */
  closePane(pane = this.focused) {
    if (this.panes.length < 2 || !this.panes.includes(pane)) return;
    const other = this.otherPane(pane);
    const act = pane.active;
    let keep = other.active;
    for (const tab of [...pane.tabs]) {
      const r = this.moveTab(tab, other, null, { quiet: true });
      if (tab === act) keep = r;
    }
    if (this.panes.includes(pane)) this.removePane(pane, { quiet: true });
    if (keep) this.activate(keep);
    else this.render();
    this.saveLayoutSoon();
  }

  /** Removes an empty pane. */
  removePane(pane, { quiet = false } = {}) {
    const i = this.panes.indexOf(pane);
    if (i < 0 || this.panes.length < 2) return;
    this.panes.splice(i, 1);
    pane.view.destroy();
    pane.el.remove();
    if (this.focused === pane) this.focused = this.panes[0];
    this.split = null;
    this.applySplit();
    if (!quiet) {
      this.render();
      this.saveLayoutSoon();
    }
  }

  dragPanes(e) {
    e.preventDefault();
    const rect = this.panesEl.getBoundingClientRect();
    const down = this.split === 'down';
    this.paneSplitter.classList.add('dragging');
    const move = (ev) => {
      const r = down ? (ev.clientY - rect.top) / rect.height : (ev.clientX - rect.left) / rect.width;
      this.ratio = Math.max(0.15, Math.min(0.85, r));
      this.applyRatio();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      this.paneSplitter.classList.remove('dragging');
      this.saveLayoutSoon();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  paneSplitKey(e) {
    const down = this.split === 'down';
    const less = down ? 'ArrowUp' : 'ArrowLeft';
    const more = down ? 'ArrowDown' : 'ArrowRight';
    if (e.key !== less && e.key !== more) return;
    e.preventDefault();
    this.ratio = Math.max(0.15, Math.min(0.85, this.ratio + (e.key === more ? 0.05 : -0.05)));
    this.applyRatio();
    this.saveLayoutSoon();
  }

  // ------------------------------------------------------------------ layout per folder
  layoutOf() {
    const files = (p) =>
      p.tabs
        .filter((x) => x.kind === 'file' && x.doc.path && within(x.doc.path, this.folder))
        .map((x) => x.doc.path)
        .slice(0, MAX_RESTORE);
    return {
      split: this.panes.length > 1 ? this.split : null,
      ratio: Math.round(this.ratio * 1000) / 1000,
      focus: Math.max(0, this.panes.indexOf(this.focused)),
      panes: this.panes.map((p) => ({ files: files(p), active: p.active?.kind === 'file' ? p.active.doc.path : null })),
    };
  }

  saveLayoutNow() {
    clearTimeout(this.layoutTimer);
    if (!this.folder || this.restoring || this.closingFolder) return;
    const all = { ...this.prefs.layouts };
    delete all[this.folder];
    all[this.folder] = this.layoutOf();
    const keys = Object.keys(all);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_LAYOUTS))) delete all[k];
    this.prefs.layouts = all;
    this.savePrefs();
  }

  saveLayoutSoon() {
    if (!this.folder || this.restoring || this.closingFolder) return;
    clearTimeout(this.layoutTimer);
    this.layoutTimer = setTimeout(() => this.saveLayoutNow(), 300);
  }

  /** Opens the files the folder had in each pane last time, and its split. */
  async restoreLayout() {
    const l = this.prefs.layouts?.[this.folder];
    if (!l || !Array.isArray(l.panes)) return;
    const ok = (f) => typeof f === 'string' && within(f, this.folder);
    this.restoring = true;
    try {
      if (typeof l.ratio === 'number' && l.ratio >= 0.15 && l.ratio <= 0.85) this.ratio = l.ratio;
      const [p0, p1] = l.panes;
      for (const f of (p0?.files || []).filter(ok).slice(0, MAX_RESTORE)) await this.openFile(f, { pane: this.panes[0], quiet: true, focus: false });
      const second = (p1?.files || []).filter(ok).slice(0, MAX_RESTORE);
      if ((l.split === 'right' || l.split === 'down') && second.length) {
        if (this.panes.length < 2) this.addPane();
        this.split = l.split;
        this.applySplit();
        const pane = this.panes[1];
        for (const f of second) await this.openFile(f, { pane, quiet: true, focus: false });
        if (!pane.tabs.length) this.removePane(pane, { quiet: true });
      }
      l.panes.forEach((p, i) => {
        const pane = this.panes[i];
        const tab = pane && p?.active && pane.tabs.find((x) => x.kind === 'file' && x.doc.path === p.active);
        if (tab) this.activate(tab, { focus: false });
      });
      const fp = this.panes[Math.min(this.panes.length - 1, Number(l.focus) || 0)];
      if (fp) this.focused = fp;
    } finally {
      this.restoring = false;
    }
    this.render();
  }

  // ------------------------------------------------------------------ tabs
  /** A new tab of `doc` in `pane` (its text: `text`, else the document's current text). */
  addTab(pane, doc, { text = null, selection, index } = {}) {
    const tab = new Tab('file', pane, doc);
    const content = text ?? this.docText(doc)?.toString() ?? '';
    const sel = selection && selection.ranges.every((r) => r.to <= content.length) ? selection : undefined;
    tab.state = EditorState.create({ doc: content, selection: sel, extensions: this.docExtensions(doc) });
    doc.tabs.add(tab);
    this.docs.add(doc);
    if (index == null || index > pane.tabs.length) pane.tabs.push(tab);
    else pane.tabs.splice(index, 0, tab);
    return tab;
  }

  async openFile(path, { pane = this.focused, focus = true, quiet = false } = {}) {
    const here = pane.tabs.find((x) => x.kind === 'file' && x.doc.path === path);
    if (here) return this.activate(here, { focus });
    let doc = this.docByPath(path);
    let text = null;
    if (!doc) {
      const r = await this.loadDoc(path, { quiet });
      if (!r) return null;
      ({ doc, text } = r);
    }
    if (!this.panes.includes(pane)) pane = this.focused;
    const again = pane.tabs.find((x) => x.kind === 'file' && x.doc === doc);
    if (again) return this.activate(again, { focus });
    // replace an untouched, empty untitled tab (like a fresh « Sans titre »)
    const a = pane.active;
    const blank = a && a.kind === 'file' && !a.doc.path && !a.doc.dirty && a.doc.tabs.size === 1 && this.tabState(a)?.doc.length === 0 ? a : null;
    const tab = this.addTab(pane, doc, { text });
    if (blank) await this.closeTab(blank, true);
    this.activate(tab, { focus });
    return tab;
  }

  /** Opens a file and selects `len` characters at line:col (1-based line, 0-based column). */
  async openAt(path, line, col = 0, len = 0) {
    const tab = await this.openFile(path);
    if (!tab) return null;
    const v = this.liveView(tab);
    if (!v) return tab;
    const doc = v.state.doc;
    const ln = doc.line(Math.max(1, Math.min(doc.lines, line)));
    const from = Math.min(ln.to, ln.from + Math.max(0, col));
    const to = Math.min(ln.to, from + Math.max(0, len));
    v.dispatch({ selection: EditorSelection.single(from, to), effects: EditorView.scrollIntoView(from, { y: 'center' }) });
    v.focus();
    return tab;
  }

  newUntitled() {
    const n = [...this.docs].filter((d) => !d.path).length + 1;
    const doc = new Doc({ path: null, name: n > 1 ? `${this.t('untitled')} ${n}` : this.t('untitled') });
    const tab = this.addTab(this.focused, doc, { text: '' });
    this.activate(tab);
    return tab;
  }

  /** Keeps the shown state of a file tab that is about to be hidden. */
  stash(tab) {
    if (tab.kind !== 'file') return;
    const v = tab.pane?.view;
    if (v && v.codeTab === tab) {
      tab.state = v.state;
      tab.scroll = v.scrollDOM.scrollTop;
      v.codeTab = null; // the view no longer stands for this tab: changes now go to tab.state
    }
  }

  /** Shows a tab in its pane. takeFocus: that pane becomes the focused one. */
  activate(tab, { focus = true, takeFocus = true } = {}) {
    const pane = tab?.pane;
    if (!pane || !pane.tabs.includes(tab)) return null;
    if (takeFocus) this.focused = pane;
    const prev = pane.active;
    if (prev && prev !== tab) this.stash(prev);
    pane.active = tab;
    pane.el.classList.toggle('diff', tab.kind === 'diff');
    if (tab.kind === 'file') {
      if (pane.view.codeTab !== tab) {
        pane.view.setState(tab.state);
        pane.view.codeTab = tab;
        dressSearchPanel(pane.view.dom, this.closeIcon); // setState rebuilds an open find panel
        const top = tab.scroll || 0;
        requestAnimationFrame(() => {
          if (pane.view.codeTab === tab) pane.view.scrollDOM.scrollTop = top;
        });
      }
      if (focus) pane.view.focus();
    } else {
      if (tab.diff.el.parentNode !== pane.diffHost) pane.diffHost.append(tab.diff.el);
      for (const c of pane.diffHost.children) c.hidden = c !== tab.diff.el;
      tab.diff.shown();
      if (focus) tab.diff.focus();
    }
    this.render();
    this.saveLayoutSoon();
    return tab;
  }

  async closeTab(tab, force = false) {
    if (!tab) return true;
    const pane = tab.pane;
    if (!pane || !pane.tabs.includes(tab)) return true;
    const doc = tab.doc;
    // the last view of a document with unsaved changes
    if (!force && doc?.dirty && doc.tabs.size === 1) {
      const r = await this.ui.dialog({
        title: this.t('unsavedTitle'),
        body: this.t('unsavedOne', { name: doc.name }),
        buttons: [
          { label: this.t('save'), value: 'save', primary: true },
          { label: this.t('dontSave'), value: 'discard' },
          { label: this.t('common.cancel'), value: null },
        ],
        parent: this.win,
      });
      if (!r) return false;
      if (r === 'save' && !(await this.save(tab))) return false;
      if (!pane.tabs.includes(tab)) return true;
    }
    const wasActive = pane.active === tab;
    if (wasActive) this.stash(tab);
    const i = pane.tabs.indexOf(tab);
    pane.tabs.splice(i, 1);
    if (tab.kind === 'diff') tab.diff.destroy();
    if (doc) {
      doc.tabs.delete(tab);
      if (!doc.tabs.size) this.docs.delete(doc);
    }
    if (wasActive) {
      pane.active = null;
      const mine = this.focused === pane;
      const next = pane.tabs[Math.min(i, pane.tabs.length - 1)];
      if (next) this.activate(next, { focus: mine, takeFocus: mine });
      else if (this.panes.length > 1) this.removePane(pane);
      else {
        pane.el.classList.remove('diff');
        pane.view.setState(EditorState.create({ doc: '' }));
        pane.view.codeTab = null;
        this.render();
      }
    } else this.renderTabs();
    this.saveLayoutSoon();
    return true;
  }

  async closeOthers(tab) {
    for (const x of [...tab.pane.tabs]) if (x !== tab && !(await this.closeTab(x))) return false;
    return true;
  }

  async save(tab = this.active, saveAs = false) {
    const doc = tab?.doc;
    if (!doc) return false;
    let path = doc.path;
    if (!path || saveAs) {
      const picked = await this.ui.filePicker({ mode: 'save', title: this.t('saveAs'), path: path ? dirName(path) : this.folder || undefined, name: path ? baseName(path) : `${this.t('untitledFile')}.txt`, parent: this.win });
      if (!picked) return false;
      path = Array.isArray(picked) ? picked[0] : picked;
    }
    const state = this.docState(doc);
    if (!state) return false;
    let text = state.doc.toString();
    if (doc.eol === 'CRLF') text = text.replace(/\n/g, '\r\n');
    try {
      await this.api.invoke('fs:writeText', path, text);
    } catch (err) {
      this.ui.alert(this.t('saveFailed', { error: err.message }), { parent: this.win });
      return false;
    }
    const renamed = path !== doc.path;
    doc.path = path;
    doc.name = baseName(path);
    doc.saved = state.doc;
    doc.dirty = false;
    if (renamed && doc.lang === 'plain') {
      doc.lang = langOf(path);
      this.reconfigureDoc(doc, langComp.reconfigure(LANGS[doc.lang].load()));
    }
    // a comparison with the saved file now compares with this
    for (const x of doc.tabs) if (x.kind === 'diff' && x.diff.source === 'saved') x.diff.setOriginal(state.doc.toString());
    this.renderTabs();
    this.updateTitle();
    if (this.folder && within(path, this.folder)) {
      if (renamed) await this.loadDir(dirName(path)).catch(() => {});
      await this.loadGit();
      this.renderTree();
      this.renderStatus();
    }
    if (renamed) this.saveLayoutSoon();
    return true;
  }

  saveDoc(doc) {
    const tab = [...doc.tabs][0];
    return tab ? this.save(tab) : false;
  }

  async saveAll() {
    for (const doc of [...this.docs]) if (doc.dirty && !(await this.saveDoc(doc))) return false;
    return true;
  }

  /** After a replace across files: git status and the tree. */
  async afterReplace() {
    if (!this.folder) return;
    await this.loadGit();
    this.renderTree();
    this.renderStatus();
  }

  async beforeClose() {
    const dirty = [...this.docs].filter((d) => d.dirty);
    if (!dirty.length) return true;
    const r = await this.ui.dialog({
      title: this.t('unsavedTitle'),
      body: dirty.length === 1 ? this.t('unsavedOne', { name: dirty[0].name }) : this.t('unsavedMany', { count: dirty.length }),
      buttons: [
        { label: this.t(dirty.length === 1 ? 'save' : 'saveAll'), value: 'save', primary: true },
        { label: this.t('dontSave'), value: 'discard' },
        { label: this.t('common.cancel'), value: null },
      ],
      parent: this.win,
    });
    if (!r) return false;
    if (r === 'save') return this.saveAll();
    return true;
  }

  dispose() {
    this.saveLayoutNow();
    this.search?.dispose();
    this.stopTerminal();
    this.offTheme?.();
    for (const tab of this.allTabs()) if (tab.kind === 'diff') tab.diff.destroy();
    for (const p of this.panes) p.view?.destroy();
  }

  // ------------------------------------------------------------------ comparisons (lib/diff.js)
  /**
   * Opens a comparison tab in the focused pane: `doc` (or the file at `path`) against `original`.
   * The same comparison already open there is shown again, with the original read anew.
   */
  async openDiff({ source, path = null, doc = null, otherPath = null, original, origLabel, modLabel }) {
    let text = null;
    if (!doc) {
      doc = this.docByPath(path);
      if (!doc) {
        const r = await this.loadDoc(path);
        if (!r) return null;
        ({ doc, text } = r);
      }
    }
    const pane = this.focused;
    const same = pane.tabs.find((x) => x.kind === 'diff' && x.doc === doc && x.diff.source === source && x.diff.otherPath === (otherPath || null));
    if (same) {
      same.diff.setOriginal(original);
      return this.activate(same);
    }
    const content = text ?? this.docText(doc)?.toString() ?? '';
    const tab = new Tab('diff', pane, doc);
    tab.diff = new DiffView(this, tab, { source, original, text: content, origLabel, modLabel, otherPath, mode: this.prefs.diffMode });
    doc.tabs.add(tab);
    this.docs.add(doc);
    const at = pane.active ? pane.tabs.indexOf(pane.active) + 1 : pane.tabs.length;
    pane.tabs.splice(at, 0, tab);
    tab.diff.el.hidden = true;
    pane.diffHost.append(tab.diff.el);
    return this.activate(tab);
  }

  /** « Comparer avec HEAD »: a file of the opened folder against its version in git HEAD. */
  async compareHead(path) {
    const { t } = this;
    const rel = this.rel(path);
    if (!rel || !this.git.repo) {
      this.ui.alert(t('diffNoRepo'), { parent: this.win });
      return null;
    }
    let res;
    try {
      res = await this.api.invoke('code:gitShow', this.folder, rel, 'HEAD');
    } catch (err) {
      this.ui.alert(t('diffFailed', { error: err.message }), { parent: this.win });
      return null;
    }
    if (!res.repo) {
      this.ui.alert(t('diffNoRepo'), { parent: this.win });
      return null;
    }
    if (res.binary || res.tooBig) {
      this.ui.alert(t(res.binary ? 'diffBinary' : 'fileTooBig', { name: baseName(path) }), { parent: this.win });
      return null;
    }
    return this.openDiff({ source: 'head', path, original: res.exists ? res.text : '', origLabel: res.exists ? 'HEAD' : t('diffHeadNone'), modLabel: t('diffWorking') });
  }

  /** « Comparer avec le fichier enregistré »: the unsaved changes of a document. */
  async compareSaved(doc) {
    if (!doc?.path) return null;
    let original;
    try {
      original = await this.api.invoke('fs:readText', doc.path, { maxBytes: MAX_BYTES });
    } catch (err) {
      this.ui.alert(this.t('diffFailed', { error: err.message }), { parent: this.win });
      return null;
    }
    return this.openDiff({ source: 'saved', doc, original, origLabel: this.t('diffSavedLabel'), modLabel: this.t('diffUnsavedLabel') });
  }

  /** « Comparer deux fichiers »: `left` (read-only) against `right` (its document, editable). */
  async compareFiles(left, right) {
    const st = await this.api.invoke('fs:stat', left).catch(() => null);
    if (!st || st.dir) {
      this.ui.alert(this.t('fileMissing', { path: left }), { parent: this.win });
      return null;
    }
    if (st.size > MAX_BYTES) {
      this.ui.alert(this.t('fileTooBig', { name: baseName(left) }), { parent: this.win });
      return null;
    }
    let original;
    try {
      original = await this.api.invoke('fs:readText', left, { maxBytes: MAX_BYTES });
    } catch (err) {
      this.ui.alert(this.t('diffFailed', { error: err.message }), { parent: this.win });
      return null;
    }
    if (original.includes('\0')) {
      this.ui.alert(this.t('diffBinary', { name: baseName(left) }), { parent: this.win });
      return null;
    }
    const sameName = baseName(left) === baseName(right);
    const label = (p) => (sameName && this.rel(p) ? this.rel(p) : baseName(p));
    return this.openDiff({ source: 'file', path: right, otherPath: left, original, origLabel: label(left), modLabel: label(right) });
  }

  async compareWithPicked(tab = this.active) {
    const path = tab?.doc?.path;
    if (!path) return null;
    const p = await this.ui.filePicker({ mode: 'open', title: this.t('compareFiles'), path: dirName(path), parent: this.win });
    if (!p) return null;
    return this.compareFiles(Array.isArray(p) ? p[0] : p, path);
  }

  // ------------------------------------------------------------------ rendering
  renderTabs() {
    for (const pane of this.panes) this.renderPaneTabs(pane);
    this.renderPaneState();
  }

  renderPaneTabs(pane) {
    const { h, t } = this;
    pane.tabsEl.replaceChildren(
      ...pane.tabs.map((tab) =>
        h(
          'div',
          {
            class: ['code-tab', tab === pane.active && 'active', tab.dirty && 'dirty', tab.kind === 'diff' && 'diff'],
            role: 'tab',
            tabindex: tab === pane.active ? 0 : -1,
            'aria-selected': String(tab === pane.active),
            'data-id': tab.id,
            draggable: 'true',
            title: tab.kind === 'diff' ? tab.diff.tip : tab.path || tab.name,
            onclick: () => (tab !== pane.active ? this.activate(tab) : this.focusPane(pane)),
            onauxclick: (e) => e.button === 1 && this.closeTab(tab),
            oncontextmenu: (e) => this.tabMenu(e, tab),
            ondragstart: (e) => {
              e.dataTransfer.setData(TAB_TYPE, String(tab.id));
              e.dataTransfer.effectAllowed = 'move';
            },
            onkeydown: (e) => {
              if (e.key === 'Enter' || e.key === ' ') this.activate(tab);
            },
          },
          this.icon(tab.kind === 'diff' ? 'arrows-left-right' : tab.path ? this.ui.fileIcon({ name: tab.name, ext: extOf(tab.name) }) : 'file', { size: 16 }),
          h('span', { class: 'code-tab-name' }, tab.name),
          h(
            'button',
            {
              class: 'code-tab-x',
              'aria-label': tab.dirty ? t('closeUnsaved', { name: tab.name }) : t('closeTab', { name: tab.name }),
              'data-tip': t('closeTab', { name: tab.name }),
              onclick: (e) => {
                e.stopPropagation();
                this.closeTab(tab);
              },
            },
            h('span', { class: 'code-dot', 'aria-hidden': 'true' }),
            this.icon('x', { size: 14 }),
          ),
        ),
      ),
    );
    pane.tabsEl.classList.toggle('empty', !pane.tabs.length);
    pane.bar.classList.toggle('no-tabs', !pane.tabs.length);
    pane.closeBtn.hidden = this.panes.length < 2;
    pane.splitBtn.hidden = this.panes.length > 1 || !pane.active?.doc;
    pane.tabsEl.querySelector('.code-tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  renderPaneState() {
    const two = this.panes.length > 1;
    for (const p of this.panes) p.el.classList.toggle('focused', two && p === this.focused);
  }

  tabMenu(e, tab) {
    const { t } = this;
    const doc = tab.doc;
    const path = doc?.path;
    const inRepo = !!(path && this.git.repo && this.rel(path));
    this.ui.menu(e, [
      { label: t('closeTabShort'), shortcut: 'Ctrl+W', action: () => this.closeTab(tab) },
      { label: t('closeOthers'), disabled: tab.pane.tabs.length < 2, action: () => this.closeOthers(tab) },
      '-',
      { label: t(this.panes.length > 1 ? 'moveToOtherPane' : 'moveToNewPane'), icon: 'arrow-square-out', action: () => this.moveTab(tab) },
      { label: t('splitRight'), icon: 'square-split-horizontal', shortcut: 'Ctrl+\\', disabled: !doc, action: () => this.splitEditor('right', tab) },
      { label: t('splitDown'), icon: 'square-split-vertical', disabled: !doc, action: () => this.splitEditor('down', tab) },
      '-',
      { label: t('compareHead'), icon: 'arrows-left-right', disabled: !inRepo, action: () => this.compareHead(path) },
      { label: t('compareSaved'), disabled: !path, action: () => this.compareSaved(doc) },
      { label: t('compareFiles'), disabled: !path, action: () => this.compareWithPicked(tab) },
      '-',
      { label: t('copyPath'), icon: 'copy', disabled: !path, action: () => this.api.invoke('clipboard:writeText', path) },
    ]);
  }

  renderWelcome() {
    const { h, t } = this;
    const show = !this.allTabs().length;
    this.root.classList.toggle('no-doc', show);
    if (!show) return;
    const recent = this.prefs.recent.filter((r) => r !== this.folder).slice(0, 5);
    this.welcome.replaceChildren(
      h(
        'div',
        { class: 'code-welcome-inner' },
        h('div', { class: 'code-welcome-icon' }, this.icon('code', { size: 40 })),
        h('h2', { class: 'code-welcome-title' }, this.folder ? baseName(this.folder) : t('welcomeTitle')),
        h('p', { class: 'code-welcome-text' }, this.folder ? t('welcomeFolder') : t('welcomeText')),
        h(
          'div',
          { class: 'code-welcome-actions' },
          h('button', { class: ['btn', !this.folder && 'primary'], 'data-act': 'welcome-open', onclick: () => this.pickFolder() }, this.icon('folder-open', { size: 16 }), t('openFolder')),
          h('button', { class: 'btn', 'data-act': 'welcome-new', onclick: () => (this.folder ? this.createIn(this.folder, false) : this.newUntitled()) }, this.icon('file-plus', { size: 16 }), t('newFile')),
        ),
        recent.length
          ? h(
              'div',
              { class: 'code-recent' },
              h('div', { class: 'code-recent-title' }, t('recentFolders')),
              recent.map((r) =>
                h('button', { class: 'code-recent-item', title: r, onclick: () => this.openFolder(r) }, this.icon('folder-simple', { size: 16 }), h('span', { class: 'code-recent-name' }, baseName(r)), h('span', { class: 'code-recent-path' }, r)),
              ),
            )
          : null,
        h(
          'dl',
          { class: 'code-keys' },
          [
            ['Ctrl+S', t('save')],
            ['Ctrl+F', t('find')],
            ['Ctrl+H', t('replace')],
            [t('kSearch'), t('searchTitle')],
            ['Ctrl+G', t('gotoLine')],
            ['Ctrl+D', t('nextOccurrence')],
            ['Ctrl+\\', t('splitRight')],
            ['Ctrl+`', t('terminal')],
          ].map(([k, v]) => h('div', { class: 'code-key' }, h('dt', null, v), h('dd', null, h('kbd', null, k)))),
        ),
      ),
    );
  }

  renderPos() {
    const tab = this.active;
    // file items (cursor, indentation, encoding, line ending, language) only with a file open
    this.stPos.hidden = this.stIndent.hidden = this.stEnc.hidden = this.stEol.hidden = this.stLang.hidden = !tab?.doc;
    const v = tab?.doc ? this.view : null;
    if (!v) return;
    const s = v.state;
    const head = s.selection.main.head;
    const line = s.doc.lineAt(head);
    const col = head - line.from + 1;
    const n = s.selection.ranges.length;
    this.stPos.textContent = n > 1 ? `${this.t('pos', { line: line.number, col })} (${this.t('selections', { count: n })})` : this.t('pos', { line: line.number, col });
    this.stPos.dataset.tip = this.t('gotoLine');
  }

  renderStatus() {
    const { h, t } = this;
    const g = this.git;
    if (this.folder && g.repo && g.branch) {
      const extra = [g.ahead ? `↑${g.ahead}` : '', g.behind ? `↓${g.behind}` : ''].filter(Boolean).join(' ');
      this.stBranch.replaceChildren(...[this.icon('git-branch', { size: 14 }), h('span', { class: 'code-branch' }, g.branch), extra ? h('span', null, extra) : null].filter(Boolean));
      this.stBranch.hidden = false;
      const changed = Object.keys(g.files || {}).length;
      this.stBranch.dataset.tip = changed ? t('gitChanges', { count: changed }) : t('gitClean');
    } else this.stBranch.hidden = true;
    const doc = this.active?.doc;
    if (doc) {
      this.stIndent.textContent = doc.indent.tabs ? t('indentTabs', { size: doc.indent.size }) : t('indentSpaces', { size: doc.indent.size });
      this.stEol.textContent = doc.eol;
      this.stLang.textContent = LANGS[doc.lang]?.name === 'Text' ? t('plainText') : LANGS[doc.lang]?.name;
      this.stLang.dataset.tip = t('language');
    }
    this.renderPos();
  }

  updateTitle() {
    const tab = this.active;
    const app = this.t('appName');
    const parts = [];
    if (tab) parts.push(`${tab.dirty ? '• ' : ''}${tab.name}`);
    if (this.folder) parts.push(baseName(this.folder));
    parts.push(app);
    this.win.setTitle(parts.join(' — '));
    this.saveBtn.disabled = !tab?.doc;
    this.splitBtn.disabled = !tab?.doc;
  }

  render() {
    this.renderTabs();
    this.renderTree();
    this.renderWelcome();
    this.renderStatus();
    this.updateTitle();
    if (this.search && !this.folder) this.search.renderResults();
  }

  // ------------------------------------------------------------------ commands
  find() {
    if (!this.active?.doc) return;
    const v = this.view;
    v.focus();
    CM.openSearchPanel(v);
  }

  async gotoLine() {
    if (!this.active?.doc) return;
    const s = this.view.state;
    const max = s.doc.lines;
    const cur = s.doc.lineAt(s.selection.main.head).number;
    const v = await this.ui.prompt({
      title: this.t('gotoLine'),
      label: this.t('gotoLabel', { max }),
      value: String(cur),
      okLabel: this.t('go'),
      parent: this.win,
      validate: (x) => (/^\s*\d+\s*(?:[:,]\s*\d+\s*)?$/.test(x || '') ? null : this.t('gotoInvalid')),
    });
    if (!v) return this.view?.focus();
    const [l, c] = v.split(/[:,]/).map((x) => parseInt(x, 10));
    this.goto(l, c || 1);
  }

  goto(lineNo, col = 1) {
    const view = this.view;
    const doc = view.state.doc;
    const line = doc.line(Math.max(1, Math.min(doc.lines, lineNo)));
    const pos = Math.min(line.to, line.from + Math.max(0, col - 1));
    view.dispatch({ selection: EditorSelection.cursor(pos), effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
    view.focus();
  }

  langMenu(e) {
    const doc = this.active?.doc;
    if (!doc) return;
    this.ui.menu(
      e,
      Object.entries(LANGS).map(([id, l]) => ({
        label: id === 'plain' ? this.t('plainText') : l.name,
        checked: doc.lang === id,
        action: () => {
          doc.lang = id;
          this.reconfigureDoc(doc, langComp.reconfigure(l.load()));
          this.renderStatus();
        },
      })),
    );
  }

  indentMenu(e) {
    const doc = this.active?.doc;
    if (!doc) return;
    const set = (indent) => {
      doc.indent = indent;
      this.reconfigureDoc(doc, tabComp.reconfigure(tabExt(indent)));
      this.renderStatus();
    };
    this.ui.menu(e, [
      ...[2, 4, 8].map((n) => ({ label: this.t('indentSpaces', { size: n }), checked: !doc.indent.tabs && doc.indent.size === n, action: () => set({ tabs: false, size: n }) })),
      '-',
      ...[4, 8].map((n) => ({ label: this.t('indentTabs', { size: n }), checked: doc.indent.tabs && doc.indent.size === n, action: () => set({ tabs: true, size: n }) })),
    ]);
  }

  moreMenu(e) {
    const { t } = this;
    const tab = this.active;
    const doc = tab?.doc;
    const path = doc?.path;
    const inRepo = !!(path && this.git.repo && this.rel(path));
    this.ui.menu(e, [
      { label: t('openFolder'), icon: 'folder-open', shortcut: 'Ctrl+O', action: () => this.pickFolder() },
      { label: t('openFile'), icon: 'file-text', action: () => this.pickFile() },
      ...(this.prefs.recent.length
        ? [{ label: t('recentFolders'), icon: 'clock-counter-clockwise', submenu: this.prefs.recent.map((r) => ({ label: r, action: () => this.openFolder(r) })) }]
        : []),
      '-',
      { label: t('save'), shortcut: 'Ctrl+S', disabled: !doc, action: () => this.save() },
      { label: t('saveAs'), shortcut: t('kSaveAs'), disabled: !doc, action: () => this.save(tab, true) },
      { label: t('saveAll'), disabled: ![...this.docs].some((x) => x.dirty), action: () => this.saveAll() },
      { label: t('closeTabShort'), shortcut: 'Ctrl+W', disabled: !tab, action: () => this.closeTab(tab) },
      '-',
      { label: t('searchTitle'), icon: 'magnifying-glass', shortcut: t('kSearch'), disabled: !this.folder, action: () => this.showSearch() },
      {
        label: t('editorLayout'),
        icon: 'square-split-horizontal',
        submenu: [
          { label: t('splitRight'), icon: 'square-split-horizontal', shortcut: 'Ctrl+\\', disabled: !doc, action: () => this.splitEditor('right') },
          { label: t('splitDown'), icon: 'square-split-vertical', disabled: !doc, action: () => this.splitEditor('down') },
          { label: t(this.panes.length > 1 ? 'moveToOtherPane' : 'moveToNewPane'), disabled: !tab, action: () => this.moveTab(tab) },
          { label: t('closePane'), disabled: this.panes.length < 2, action: () => this.closePane() },
        ],
      },
      {
        label: t('compare'),
        icon: 'arrows-left-right',
        submenu: [
          { label: t('compareHead'), disabled: !inRepo, action: () => this.compareHead(path) },
          { label: t('compareSaved'), disabled: !path, action: () => this.compareSaved(doc) },
          { label: t('compareFiles'), disabled: !path, action: () => this.compareWithPicked(tab) },
        ],
      },
      '-',
      { label: t('wordWrap'), checked: !!this.prefs.wrap, action: () => this.setWrap(!this.prefs.wrap) },
      { label: t('showIgnored'), checked: !!this.prefs.showIgnored, disabled: !this.folder, action: () => this.setShowIgnored(!this.prefs.showIgnored) },
      '-',
      { label: t('closeFolder'), disabled: !this.folder, action: () => this.closeFolder() },
    ]);
  }

  async pickFile() {
    const p = await this.ui.filePicker({ mode: 'open', title: this.t('openFile'), path: this.folder || undefined, parent: this.win });
    if (p) await this.openFile(Array.isArray(p) ? p[0] : p);
  }

  async closeFolder() {
    this.saveLayoutNow();
    this.closingFolder = true;
    try {
      for (const tab of this.allTabs()) if (!(await this.closeTab(tab))) return;
    } finally {
      this.closingFolder = false;
    }
    this.folder = null;
    this.entries.clear();
    this.git = { repo: false, files: {}, ignored: [] };
    this.search.reset();
    this.savePrefs();
    this.render();
  }

  setWrap(on) {
    this.prefs.wrap = on;
    this.savePrefs();
    for (const doc of this.docs) this.reconfigureDoc(doc, wrapComp.reconfigure(on ? EditorView.lineWrapping : []));
  }

  setShowIgnored(on) {
    this.prefs.showIgnored = on;
    this.savePrefs();
    this.renderTree();
  }

  toggleSide() {
    this.prefs.sideHidden = !this.prefs.sideHidden;
    this.savePrefs();
    this.applyLayout();
  }

  keys(e) {
    // F7 / Shift+F7: next / previous change of a comparison
    if (e.key === 'F7' && !e.ctrlKey && !e.altKey && !e.metaKey && this.active?.kind === 'diff' && !this.win.el.querySelector('.dialog-layer')) {
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) this.active.diff.prev();
      else this.active.diff.next();
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    if (!mod || e.altKey) return;
    const k = e.key.toLowerCase();
    const inTerm = this.panel.contains(e.target);
    if (k === '`' || e.code === 'Backquote' || (k === 'j' && !e.shiftKey)) {
      e.preventDefault();
      e.stopPropagation();
      this.toggleTerminal();
      return;
    }
    if (inTerm || this.win.el.querySelector('.dialog-layer')) return;
    const run = (fn) => {
      e.preventDefault();
      e.stopPropagation();
      fn();
    };
    if (k === 'f' && e.shiftKey) run(() => this.showSearch());
    else if (k === 'h' && e.shiftKey) run(() => this.showSearch({ replace: true }));
    else if (k === 'e' && e.shiftKey) run(() => this.setSideView('explorer', { focus: true }));
    else if (k === 's' && e.shiftKey) run(() => this.save(this.active, true));
    else if (k === 's') run(() => this.save());
    else if (k === 'o') run(() => this.pickFolder());
    else if (k === 'n' && !e.shiftKey) run(() => this.newUntitled());
    else if (k === 'w') run(() => this.active && this.closeTab(this.active));
    else if (k === 'b') run(() => this.toggleSide());
    else if (k === 'g') run(() => this.gotoLine());
    else if (e.key === '\\' || (e.code === 'Backslash' && !e.shiftKey)) run(() => this.splitEditor('right'));
    else if (e.code === 'Digit1' || e.code === 'Numpad1') run(() => this.focusPaneIndex(0));
    else if (e.code === 'Digit2' || e.code === 'Numpad2') run(() => this.focusPaneIndex(1));
    else if (k === 'tab' && this.tabs.length > 1) {
      const i = this.tabs.indexOf(this.active);
      run(() => this.activate(this.tabs[(i + (e.shiftKey ? -1 : 1) + this.tabs.length) % this.tabs.length]));
    } else if (k === 'f' && !e.target.closest?.('.cm-editor')) run(() => this.find());
  }

  dragSide(e) {
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = this.side.querySelector('.code-side-body').getBoundingClientRect().width;
    const move = (ev) => {
      this.prefs.sideW = Math.max(160, Math.min(560, Math.round(w0 + ev.clientX - x0)));
      this.applyLayout();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      this.savePrefs();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  dragPanel(e) {
    e.preventDefault();
    const y0 = e.clientY;
    const h0 = this.panel.getBoundingClientRect().height;
    const move = (ev) => {
      this.prefs.panelH = Math.max(100, Math.min(Math.round(this.center.clientHeight - 120), Math.round(h0 - (ev.clientY - y0))));
      this.applyLayout();
      this.fitTerm();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      this.savePrefs();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // ------------------------------------------------------------------ terminal panel (main/ipc/pty.js)
  async toggleTerminal(force) {
    const open = force ?? !this.termOpen;
    this.termOpen = open;
    this.prefs.terminal = open;
    this.savePrefs();
    this.applyLayout();
    this.termBtn.classList.toggle('on', open);
    this.termBtn.setAttribute('aria-pressed', String(open));
    if (open) {
      if (!this.term) await this.startTerminal();
      this.fitTerm();
      this.term?.focus();
    } else if (this.active) this.view?.focus();
  }

  async startTerminal() {
    if (this.termStarting) return this.termStarting;
    this.termStarting = (async () => {
      const { Terminal, FitAddon } = await loadXterm(this.ui);
      bus.attach(this.api);
      const mono = getComputedStyle(this.root).getPropertyValue('--font-mono').trim() || 'monospace';
      const term = new Terminal({ fontFamily: mono, fontSize: 13, cursorBlink: true, allowProposedApi: true, allowTransparency: true, scrollback: 5000, theme: this.termTheme() });
      const fit = new FitAddon();
      term.loadAddon(fit);
      this.termHost.replaceChildren();
      term.open(this.termHost);
      this.term = term;
      this.fit = fit;
      this.fitTerm();
      try {
        this.ptyId = await this.api.invoke('pty:spawn', { cols: term.cols, rows: term.rows, cwd: this.folder || '~' });
      } catch (err) {
        term.write(`\r\n${this.t('termFailed', { error: err.message })}\r\n`);
        return;
      }
      const id = this.ptyId;
      bus.register(id, {
        onPtyData: (data) => term.write(data, () => this.api.send('pty:ack', id, data.length)),
        onPtyExit: () => {
          if (this.ptyId !== id) return;
          this.ptyId = null;
          term.write(`\r\n\x1b[2m${this.t('termEnded')}\x1b[0m\r\n`);
        },
        onPtyProc: () => {},
      });
      term.onData((d) => this.ptyId === id && this.api.send('pty:write', id, d));
      term.onResize(({ cols, rows }) => this.ptyId === id && this.api.invoke('pty:resize', id, cols, rows).catch(() => {}));
      this.termRO = new ResizeObserver(() => this.fitTerm());
      this.termRO.observe(this.termHost);
    })();
    try {
      await this.termStarting;
    } finally {
      this.termStarting = null;
    }
  }

  termTheme() {
    const mode = effectiveTheme(this.win.el) === 'light' ? 'light' : 'dark';
    // the Terminal's default scheme for the mode and ambiance, drawn on the panel's own surface (transparent background)
    return { ...xtermTheme(resolveScheme('system', mode, pageAmbiance())), background: 'rgba(0, 0, 0, 0)' };
  }

  applyTermTheme() {
    if (this.term) this.term.options.theme = this.termTheme();
  }

  fitTerm() {
    if (!this.term || !this.termOpen) return;
    try {
      this.fit.fit();
    } catch {}
  }

  stopTerminal() {
    this.termRO?.disconnect();
    if (this.ptyId) {
      this.api.invoke('pty:kill', this.ptyId).catch(() => {});
      bus.unregister(this.ptyId);
    }
    this.ptyId = null;
    this.term?.dispose();
    this.term = null;
  }

  async restartTerminal() {
    this.stopTerminal();
    if (this.termOpen) {
      await this.startTerminal();
      this.term?.focus();
    }
  }

  async terminalCd(dir) {
    await this.toggleTerminal(true);
    if (this.ptyId) this.api.send('pty:write', this.ptyId, `cd ${shellQuote(dir)}\r`);
  }
}

/** A path as one POSIX shell word. */
export function shellQuote(s) {
  return /^[\w./~-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export default {
  async launch(ctx) {
    const app = new CodeApp(ctx);
    ctx.win.el.__code = app;
    await app.init();
    return {
      code: app,
      onRelaunch: (args) => app.relaunch(args),
    };
  },
};
