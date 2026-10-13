// Éditeur de code (app id "code"): a folder-based code editor.
//   - Explorer: the opened folder as a tree (create, rename, delete to the Recycle Bin), .gitignore-aware (ignored
//     files, .git and node_modules are hidden unless « Afficher les fichiers ignorés » is on), git status per file.
//   - Editor: CodeMirror 6 (vendor/codemirror.js, built by shell/tools/vendor-codemirror.mjs) with tabs, syntax
//     highlighting, line numbers, find / replace (regex), go to line, multi-cursor (Alt+click, Ctrl+D), auto-indent,
//     bracket matching and closing, folding. One EditorView; each tab keeps its own EditorState (and undo history).
//   - Terminal panel: the Terminal app's PTY backend (main/ipc/pty.js) and xterm.js, started in the opened folder.
//   - Status bar: git branch (main/ipc/code.js, git with an argument vector), cursor, indentation, line ending, language.
// Test hook: ctx.win.el.__code (the CodeApp instance).
import { CM, LANGS, langOf, extensions, detectIndent, tabExt } from './lib/cm.js';
import { loadXterm } from '../terminal/lib/session.js';
import { bus } from '../terminal/lib/bus.js';
import { resolveScheme, xtermTheme, pageAmbiance } from '../terminal/lib/schemes.js';
import { effectiveTheme } from '../../core/theme.js';
import { i18n } from '../../core/i18n.js';

const { EditorView, EditorState, EditorSelection, Compartment } = CM;
const MAX_BYTES = 8 * 1024 * 1024;
const ALWAYS_HIDDEN = new Set(['.git', 'node_modules']);
const MAX_RECENT = 8;

const langComp = new Compartment();
const wrapComp = new Compartment();
const tabComp = new Compartment();

const join = (dir, name) => (dir.endsWith('/') ? dir + name : `${dir}/${name}`);
const baseName = (p) => String(p).replace(/\/+$/, '').split('/').pop() || p;
const dirName = (p) => String(p).replace(/\/[^/]*$/, '') || '/';
const extOf = (name) => (/\.[^./]+$/.exec(name)?.[0] || '').toLowerCase();
const within = (p, dir) => p === dir || p.startsWith(dir.endsWith('/') ? dir : `${dir}/`);

let tabSeq = 0;

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
    this.tabs = [];
    this.active = null;
    this.focusedRow = null;
    this.prefs = { recent: [], showIgnored: false, wrap: false, terminal: false, sideW: 260, panelH: 220, sideHidden: false };
    this.term = null;
  }

  icon(name, opts) {
    return this.ctx.icon(name, opts);
  }

  // ------------------------------------------------------------------ setup
  async init() {
    const { h, t } = this;
    const saved = await this.ctx.storage.get('prefs', null);
    if (saved && typeof saved === 'object') Object.assign(this.prefs, saved);
    const btn = (ic, tip, onclick, extra = {}) =>
      h('button', { class: 'btn subtle code-tbtn', 'data-tip': tip, 'aria-label': tip, onclick, ...extra }, this.icon(ic, { size: 18 }));

    this.treeEl = h('div', { class: 'code-tree', role: 'tree', tabindex: 0, 'aria-label': t('explorer'), onkeydown: (e) => this.treeKey(e), oncontextmenu: (e) => this.treeMenu(e, null) });
    this.sideTitle = h('div', { class: 'code-side-title' }, t('explorer'));
    this.side = h(
      'aside',
      { class: 'code-side' },
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
    this.splitter = h('div', { class: 'code-split', role: 'separator', 'aria-orientation': 'vertical', onpointerdown: (e) => this.dragSide(e) });

    this.tabsEl = h('div', { class: 'code-tabs', role: 'tablist', 'aria-label': t('openFiles') });
    this.host = h('div', { class: 'code-host' });
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
    this.center = h('div', { class: 'code-center' }, this.tabsEl, h('div', { class: 'code-editor' }, this.host, this.welcome), this.panel);

    this.stBranch = h('button', { class: 'code-st code-st-branch', onclick: () => this.refresh() });
    this.stPos = h('button', { class: 'code-st', onclick: () => this.gotoLine() });
    this.stIndent = h('button', { class: 'code-st', onclick: (e) => this.indentMenu(e) });
    this.stEol = h('span', { class: 'code-st' });
    this.stLang = h('button', { class: 'code-st', onclick: (e) => this.langMenu(e) });
    this.status = h(
      'footer',
      { class: 'code-status' },
      this.stBranch,
      h('span', { class: 'code-grow' }),
      this.stPos,
      this.stIndent,
      h('span', { class: 'code-st' }, 'UTF-8'),
      this.stEol,
      this.stLang,
    );

    this.saveBtn = btn('floppy-disk', `${t('save')} (Ctrl+S)`, () => this.save(), { 'data-act': 'save' });
    this.termBtn = btn('terminal-window', `${t('terminal')} (Ctrl+\`)`, () => this.toggleTerminal(), { 'data-act': 'terminal' });
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
    this.applyLayout();

    this.view = new EditorView({ parent: this.host, state: EditorState.create({ doc: '' }) });
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
    this.folder = st.path || dir;
    this.entries.clear();
    this.expanded = new Set([this.folder]);
    this.prefs.recent = [this.folder, ...this.prefs.recent.filter((r) => r !== this.folder)].slice(0, MAX_RECENT);
    this.savePrefs();
    await Promise.all([this.loadDir(this.folder), this.loadGit()]);
    this.render();
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
    if (!this.folder || !within(p, this.folder)) return null;
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
    this.entries.clear();
    await Promise.all([...dirs.map((d) => this.loadDir(d)), this.loadGit()]);
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
    this.side.classList.toggle('empty', !this.folder);
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
      if (!entry.dir) items.push({ label: t('open'), icon: 'file-text', action: () => this.openFile(entry.path) });
      items.push(
        { label: t('rename'), icon: 'pencil-simple', shortcut: 'F2', action: () => this.renameEntry(entry) },
        { label: t('delete'), icon: 'trash', shortcut: t('key.delete'), danger: true, action: () => this.trashEntry(entry) },
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
      else await this.api.invoke('fs:writeText', path, '');
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
    for (const tab of this.tabs) {
      if (tab.path && within(tab.path, entry.path)) {
        tab.path = to + tab.path.slice(entry.path.length);
        tab.name = baseName(tab.path);
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
    for (const tab of [...this.tabs]) if (tab.path && within(tab.path, entry.path)) this.closeTab(tab, true);
    this.focusedRow = null;
    await this.refresh();
  }

  // ------------------------------------------------------------------ tabs and documents
  makeState(text, tab) {
    return EditorState.create({
      doc: text,
      extensions: extensions({
        lang: tab.lang,
        langComp,
        wrapComp,
        tabComp,
        indent: tab.indent,
        wrap: this.prefs.wrap,
        uiLang: String(i18n.lang).startsWith('fr') ? 'fr' : 'en',
        keys: [
          { key: 'Mod-s', run: () => (this.save(), true) },
          { key: 'Mod-g', run: () => (this.gotoLine(), true) },
          { key: 'Mod-h', run: (v) => (CM.openSearchPanel(v), setTimeout(() => this.host.querySelector('.cm-search [name=replace]')?.focus(), 0), true) },
        ],
        onUpdate: (u) => this.onUpdate(u),
      }),
    });
  }

  async openFile(path) {
    const existing = this.tabs.find((x) => x.path === path);
    if (existing) return this.activate(existing);
    const st = await this.api.invoke('fs:stat', path).catch(() => null);
    if (!st || st.dir) {
      this.ui.alert(this.t('fileMissing', { path }), { parent: this.win });
      return null;
    }
    if (st.size > MAX_BYTES) {
      this.ui.alert(this.t('fileTooBig', { name: baseName(path) }), { parent: this.win });
      return null;
    }
    let text;
    try {
      text = await this.api.invoke('fs:readText', path, { maxBytes: MAX_BYTES });
    } catch (err) {
      this.ui.alert(this.t('openFailed', { error: err.message }), { parent: this.win });
      return null;
    }
    if (text.includes('\0')) {
      const ok = await this.ui.confirm(this.t('binaryFile', { name: baseName(path) }), { title: this.t('open'), okLabel: this.t('openWith'), parent: this.win });
      if (ok) this.ctx.shell.openFile(path);
      return null;
    }
    const eol = text.includes('\r\n') ? 'CRLF' : 'LF';
    const tab = { id: ++tabSeq, path, name: baseName(path), eol, lang: langOf(path, text.slice(0, 200).split('\n')[0]), indent: detectIndent(text) };
    tab.state = this.makeState(text, tab);
    tab.saved = tab.state.doc;
    tab.dirty = false;
    // replace an untouched, empty untitled tab (like a fresh « Sans titre »)
    const blank = this.active && !this.active.path && !this.active.dirty && this.active.state.doc.length === 0 ? this.active : null;
    this.tabs.push(tab);
    if (blank) this.closeTab(blank, true);
    this.activate(tab);
    return tab;
  }

  newUntitled() {
    const n = this.tabs.filter((x) => !x.path).length + 1;
    const tab = { id: ++tabSeq, path: null, name: n > 1 ? `${this.t('untitled')} ${n}` : this.t('untitled'), eol: 'LF', lang: 'plain', indent: { tabs: false, size: 2 } };
    tab.state = this.makeState('', tab);
    tab.saved = tab.state.doc;
    tab.dirty = false;
    this.tabs.push(tab);
    this.activate(tab);
    return tab;
  }

  activate(tab) {
    if (this.active && this.active !== tab && this.tabs.includes(this.active)) {
      this.active.state = this.view.state;
      this.active.scroll = this.view.scrollDOM.scrollTop;
    }
    this.active = tab;
    if (tab) {
      this.view.setState(tab.state);
      const top = tab.scroll || 0;
      requestAnimationFrame(() => (this.view.scrollDOM.scrollTop = top));
      this.view.focus();
    }
    this.render();
    return tab;
  }

  onUpdate(u) {
    const tab = this.active;
    if (!tab || u.view !== this.view) return;
    if (u.docChanged) {
      const dirty = !u.state.doc.eq(tab.saved);
      if (dirty !== tab.dirty) {
        tab.dirty = dirty;
        this.renderTabs();
        this.updateTitle();
      }
    }
    if (u.docChanged || u.selectionSet) this.renderPos();
  }

  async closeTab(tab, force = false) {
    if (!tab) return true;
    if (!force && tab === this.active) tab.state = this.view.state;
    if (!force && tab.dirty) {
      const r = await this.ui.dialog({
        title: this.t('unsavedTitle'),
        body: this.t('unsavedOne', { name: tab.name }),
        buttons: [
          { label: this.t('save'), value: 'save', primary: true },
          { label: this.t('dontSave'), value: 'discard' },
          { label: this.t('common.cancel'), value: null },
        ],
        parent: this.win,
      });
      if (!r) return false;
      if (r === 'save' && !(await this.save(tab))) return false;
    }
    const i = this.tabs.indexOf(tab);
    if (i < 0) return true;
    this.tabs.splice(i, 1);
    if (this.active === tab) {
      this.active = null;
      const next = this.tabs[Math.min(i, this.tabs.length - 1)];
      if (next) this.activate(next);
      else {
        this.view.setState(EditorState.create({ doc: '' }));
        this.render();
      }
    } else this.renderTabs();
    return true;
  }

  async save(tab = this.active, saveAs = false) {
    if (!tab) return false;
    if (tab === this.active) tab.state = this.view.state;
    let path = tab.path;
    if (!path || saveAs) {
      const picked = await this.ui.filePicker({ mode: 'save', title: this.t('saveAs'), path: path ? dirName(path) : this.folder || undefined, name: path ? baseName(path) : `${this.t('untitledFile')}.txt`, parent: this.win });
      if (!picked) return false;
      path = Array.isArray(picked) ? picked[0] : picked;
    }
    let text = tab.state.doc.toString();
    if (tab.eol === 'CRLF') text = text.replace(/\n/g, '\r\n');
    try {
      await this.api.invoke('fs:writeText', path, text);
    } catch (err) {
      this.ui.alert(this.t('saveFailed', { error: err.message }), { parent: this.win });
      return false;
    }
    const renamed = path !== tab.path;
    tab.path = path;
    tab.name = baseName(path);
    tab.saved = tab.state.doc;
    tab.dirty = false;
    if (renamed && tab.lang === 'plain') {
      tab.lang = langOf(path);
      if (tab === this.active) this.view.dispatch({ effects: langComp.reconfigure(LANGS[tab.lang].load()) });
      else tab.state = tab.state.update({ effects: langComp.reconfigure(LANGS[tab.lang].load()) }).state;
    }
    this.renderTabs();
    this.updateTitle();
    if (this.folder && within(path, this.folder)) {
      if (renamed) await this.loadDir(dirName(path)).catch(() => {});
      await this.loadGit();
      this.renderTree();
      this.renderStatus();
    }
    return true;
  }

  async saveAll() {
    for (const tab of [...this.tabs]) if (tab.dirty && !(await this.save(tab))) return false;
    return true;
  }

  async beforeClose() {
    if (this.active) this.active.state = this.view.state;
    const dirty = this.tabs.filter((x) => x.dirty);
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
    this.stopTerminal();
    this.offTheme?.();
    this.view?.destroy();
  }

  renderTabs() {
    const { h, t } = this;
    this.tabsEl.replaceChildren(
      ...this.tabs.map((tab) =>
        h(
          'div',
          {
            class: ['code-tab', tab === this.active && 'active', tab.dirty && 'dirty'],
            role: 'tab',
            tabindex: tab === this.active ? 0 : -1,
            'aria-selected': String(tab === this.active),
            'data-id': tab.id,
            title: tab.path || tab.name,
            onclick: () => tab !== this.active && this.activate(tab),
            onauxclick: (e) => e.button === 1 && this.closeTab(tab),
            onkeydown: (e) => {
              if (e.key === 'Enter' || e.key === ' ') this.activate(tab);
            },
          },
          this.icon(tab.path ? this.ui.fileIcon({ name: tab.name, ext: extOf(tab.name) }) : 'file', { size: 16 }),
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
    this.tabsEl.classList.toggle('empty', !this.tabs.length);
    this.tabsEl.querySelector('.code-tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  renderWelcome() {
    const { h, t } = this;
    const show = !this.active;
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
            ['Ctrl+G', t('gotoLine')],
            ['Ctrl+D', t('nextOccurrence')],
            ['Ctrl+`', t('terminal')],
          ].map(([k, v]) => h('div', { class: 'code-key' }, h('dt', null, v), h('dd', null, h('kbd', null, k)))),
        ),
      ),
    );
  }

  renderPos() {
    const tab = this.active;
    this.stPos.hidden = this.stIndent.hidden = this.stEol.hidden = this.stLang.hidden = !tab;
    if (!tab) return;
    const s = this.view.state;
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
      this.stBranch.replaceChildren(this.icon('git-branch', { size: 14 }), h('span', { class: 'code-branch' }, g.branch), extra ? h('span', null, extra) : null);
      this.stBranch.hidden = false;
      const changed = Object.keys(g.files || {}).length;
      this.stBranch.dataset.tip = changed ? t('gitChanges', { count: changed }) : t('gitClean');
    } else this.stBranch.hidden = true;
    const tab = this.active;
    if (tab) {
      this.stIndent.textContent = tab.indent.tabs ? t('indentTabs', { size: tab.indent.size }) : t('indentSpaces', { size: tab.indent.size });
      this.stEol.textContent = tab.eol;
      this.stLang.textContent = LANGS[tab.lang]?.name === 'Text' ? t('plainText') : LANGS[tab.lang]?.name;
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
    this.saveBtn.disabled = !tab;
  }

  render() {
    this.renderTabs();
    this.renderTree();
    this.renderWelcome();
    this.renderStatus();
    this.updateTitle();
  }

  // ------------------------------------------------------------------ commands
  find() {
    if (!this.active) return;
    this.view.focus();
    CM.openSearchPanel(this.view);
  }

  async gotoLine() {
    if (!this.active) return;
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
    if (!v) return this.view.focus();
    const [l, c] = v.split(/[:,]/).map((x) => parseInt(x, 10));
    this.goto(l, c || 1);
  }

  goto(lineNo, col = 1) {
    const doc = this.view.state.doc;
    const line = doc.line(Math.max(1, Math.min(doc.lines, lineNo)));
    const pos = Math.min(line.to, line.from + Math.max(0, col - 1));
    this.view.dispatch({ selection: EditorSelection.cursor(pos), effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
    this.view.focus();
  }

  langMenu(e) {
    const tab = this.active;
    if (!tab) return;
    this.ui.menu(
      e,
      Object.entries(LANGS).map(([id, l]) => ({
        label: id === 'plain' ? this.t('plainText') : l.name,
        checked: tab.lang === id,
        action: () => {
          tab.lang = id;
          this.view.dispatch({ effects: langComp.reconfigure(l.load()) });
          this.renderStatus();
        },
      })),
    );
  }

  indentMenu(e) {
    const tab = this.active;
    if (!tab) return;
    const set = (indent) => {
      tab.indent = indent;
      this.view.dispatch({ effects: tabComp.reconfigure(tabExt(indent)) });
      this.renderStatus();
    };
    this.ui.menu(e, [
      ...[2, 4, 8].map((n) => ({ label: this.t('indentSpaces', { size: n }), checked: !tab.indent.tabs && tab.indent.size === n, action: () => set({ tabs: false, size: n }) })),
      '-',
      ...[4, 8].map((n) => ({ label: this.t('indentTabs', { size: n }), checked: tab.indent.tabs && tab.indent.size === n, action: () => set({ tabs: true, size: n }) })),
    ]);
  }

  moreMenu(e) {
    const { t } = this;
    const tab = this.active;
    this.ui.menu(e, [
      { label: t('openFolder'), icon: 'folder-open', shortcut: 'Ctrl+O', action: () => this.pickFolder() },
      { label: t('openFile'), icon: 'file-text', action: () => this.pickFile() },
      ...(this.prefs.recent.length
        ? [{ label: t('recentFolders'), icon: 'clock-counter-clockwise', submenu: this.prefs.recent.map((r) => ({ label: r, action: () => this.openFolder(r) })) }]
        : []),
      '-',
      { label: t('save'), shortcut: 'Ctrl+S', disabled: !tab, action: () => this.save() },
      { label: t('saveAs'), shortcut: 'Ctrl+Maj+S', disabled: !tab, action: () => this.save(tab, true) },
      { label: t('saveAll'), disabled: !this.tabs.some((x) => x.dirty), action: () => this.saveAll() },
      { label: t('closeTabShort'), shortcut: 'Ctrl+W', disabled: !tab, action: () => this.closeTab(tab) },
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
    for (const tab of [...this.tabs]) if (!(await this.closeTab(tab))) return;
    this.folder = null;
    this.entries.clear();
    this.git = { repo: false, files: {}, ignored: [] };
    this.savePrefs();
    this.render();
  }

  setWrap(on) {
    this.prefs.wrap = on;
    this.savePrefs();
    if (this.active) this.view.dispatch({ effects: wrapComp.reconfigure(on ? EditorView.lineWrapping : []) });
    for (const tab of this.tabs) if (tab !== this.active) tab.state = tab.state.update({ effects: wrapComp.reconfigure(on ? EditorView.lineWrapping : []) }).state;
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
    if (k === 's' && e.shiftKey) run(() => this.save(this.active, true));
    else if (k === 's') run(() => this.save());
    else if (k === 'o') run(() => this.pickFolder());
    else if (k === 'n' && !e.shiftKey) run(() => this.newUntitled());
    else if (k === 'w') run(() => this.active && this.closeTab(this.active));
    else if (k === 'b') run(() => this.toggleSide());
    else if (k === 'g') run(() => this.gotoLine());
    else if (k === 'tab' && this.tabs.length > 1) {
      const i = this.tabs.indexOf(this.active);
      run(() => this.activate(this.tabs[(i + (e.shiftKey ? -1 : 1) + this.tabs.length) % this.tabs.length]));
    } else if (k === 'f' && !this.host.contains(e.target)) run(() => this.find());
  }

  dragSide(e) {
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = this.side.getBoundingClientRect().width;
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
    } else if (this.active) this.view.focus();
  }

  async startTerminal() {
    if (this.termStarting) return this.termStarting;
    this.termStarting = (async () => {
      const { Terminal, FitAddon } = await loadXterm(this.ui);
      bus.attach(this.api);
      const mono = getComputedStyle(this.root).getPropertyValue('--font-mono').trim() || 'monospace';
      const term = new Terminal({ fontFamily: mono, fontSize: 13, cursorBlink: true, allowProposedApi: true, scrollback: 5000, theme: this.termTheme() });
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
    return xtermTheme(resolveScheme('system', mode, pageAmbiance()));
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
