// One Archive Manager window: a Windows 11 File Explorer-style "compressed folder" view (address bar with
// breadcrumbs, command bar, navigation tree, details list, preview pane, status bar) plus the archive
// commands (extract all / selected, add, delete, new archive, test, properties), drag & drop, the
// clipboard, password prompts and progress dialogs. Opened without a file it shows the Welcome page.
import { shared } from './shared.js';
import { DetailsList } from './list.js';
import { NavTree } from './navtree.js';
import { PreviewPane } from './preview.js';
import { Welcome } from './welcome.js';
import { withProgress, errorInfo } from './ops.js';
import * as D from './dialogs.js';
import { buildTree, search, makeSorter, basename, dirname, joinPath, stemOf, splitExt, isArchiveName, ancestors, ratioOf } from './util.js';
import { trustedDragPaths } from '../../../core/desktop.js';

const DND_MIME = 'application/x-aurora-paths';
let uidSeq = 0;
const canceled = (e) => e?.code === 'ECANCELED';

export class ArchiveWindow {
  constructor(ctx) {
    this.ctx = ctx;
    this.win = ctx.win;
    this.h = ctx.h;
    this.t = ctx.t;
    this.ui = ctx.ui;
    this.icon = ctx.icon;
    this.api = ctx.api;
    this.shell = ctx.shell;
    this.i18n = ctx.i18n;
    this.uid = `arc${++uidSeq}`;
    this.session = `${this.win.id}-${Math.random().toString(36).slice(2, 8)}`;
    this.listing = null;
    this.tree = null;
    this.folder = null;
    this.password = null;
    this.history = [];
    this.future = [];
    this.query = '';
    this.busy = 0;
    this.offs = [];
    this.dragSeq = 0;
  }

  get appName() {
    return this.i18n.name(this.ctx.manifest.name);
  }

  // ================================================================== layout
  build() {
    const { h, t, icon } = this;
    const nb = (cls, ic, label, onclick, extra = {}) => h('button', { class: ['arc-navbtn', cls], 'aria-label': label, 'data-tip': label, 'data-tip-pos': 'below', onclick, ...extra }, icon(ic));
    this.btnBack = nb('back', 'arrow_left', t('nav.back'), () => this.goBack());
    this.btnFwd = nb('fwd', 'arrow_right', t('nav.forward'), () => this.goForward());
    this.btnUp = nb('up', 'arrow_up', t('nav.up'), () => this.goUp());
    this.btnRefresh = nb('refresh', 'arrow_clockwise', t('nav.refresh'), () => this.reload({ keep: true, spin: true }));
    this.crumbs = h('div', { class: 'arc-crumbs', role: 'navigation', 'aria-label': t('nav.address') });
    this.address = h('div', { class: 'arc-address' }, this.crumbs);
    this.searchInput = h('input', {
      class: 'arc-search-input',
      type: 'search',
      spellcheck: false,
      'aria-label': t('search.label'),
      oninput: () => this.onSearch(),
      onkeydown: (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          if (this.searchInput.value) {
            this.searchInput.value = '';
            this.onSearch();
          } else this.list.el.focus();
        } else if (e.key === 'Enter' || e.key === 'ArrowDown') {
          e.preventDefault();
          this.list.el.focus();
          if (this.list.focusIndex < 0 && this.list.items.length) this.list.moveFocus(0);
        }
      },
    });
    this.searchBtn = h('button', { class: 'arc-search-btn', tabindex: '-1', 'aria-label': t('search.clear'), onclick: () => { this.searchInput.value = ''; this.onSearch(); this.searchInput.focus(); } }, icon('search'));
    this.searchBox = h('div', { class: 'arc-search' }, this.searchInput, this.searchBtn);
    const addrRow = h('div', { class: 'arc-addrrow' }, h('div', { class: 'arc-navbtns' }, this.btnBack, this.btnFwd, this.btnUp, this.btnRefresh), this.address, this.searchBox);

    const cmd = (key, ic, label, onclick, { text = true, chev = false, accent = false, tip } = {}) =>
      h(
        'button',
        { class: ['arc-cmd', text && 'has-text', accent && 'accent-icon'], 'data-cmd': key, 'data-tip': tip || label, 'data-tip-pos': 'below', 'aria-label': label, onclick },
        icon(ic),
        text ? h('span', { class: 'arc-cmd-label' }, label) : null,
        chev ? icon('chevron_down', { size: 12, class: 'arc-cmd-chev' }) : null,
      );
    this.cmds = {
      new: cmd('new', 'add', t('cmd.new'), (e) => this.newMenu(e), { chev: true }),
      extractAll: cmd('extractAll', 'folder_arrow_up', t('cmd.extractAll'), () => this.extractAll(), { accent: true, tip: `${t('cmd.extractAll')} (Ctrl+Shift+E)` }),
      extractSel: cmd('extractSel', 'folder_arrow_right', t('cmd.extractSel'), () => this.extractSelected()),
      add: cmd('add', 'document_add', t('cmd.add'), () => this.addFiles()),
      delete: cmd('delete', 'delete', t('cmd.delete'), () => this.deleteSelected(), { text: false, tip: `${t('cmd.delete')} (Del)` }),
      copy: cmd('copy', 'copy', t('cmd.copy'), () => this.copySelection(), { text: false, tip: `${t('cmd.copy')} (Ctrl+C)` }),
      test: cmd('test', 'shield_checkmark', t('cmd.test'), () => this.testArchive()),
      props: cmd('props', 'info', t('cmd.props'), () => this.properties(), { text: false, tip: `${t('cmd.props')} (Alt+Enter)` }),
      sort: cmd('sort', 'arrow_sort', t('cmd.sort'), (e) => this.sortMenu(e), { chev: true }),
      view: cmd('view', 'apps_list', t('cmd.view'), (e) => this.viewMenu(e), { chev: true }),
      preview: cmd('preview', 'panel_right', t('cmd.previewPane'), () => this.togglePreview(), { text: false, tip: `${t('cmd.previewPane')} (Alt+P)` }),
    };
    const sep = () => h('div', { class: 'arc-cmd-sep', role: 'separator' });
    const C = this.cmds;
    this.cmdbar = h(
      'div',
      { class: 'arc-cmdbar', role: 'toolbar', 'aria-label': t('cmd.toolbar') },
      C.new, sep(), C.extractAll, C.extractSel, sep(), C.add, C.copy, C.delete, sep(), C.test, C.props,
      h('div', { class: 'grow' }),
      C.sort, C.view, sep(), C.preview,
    );
    this.cmdbar.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const btns = [...this.cmdbar.querySelectorAll('.arc-cmd:not(:disabled)')];
      const i = btns.indexOf(document.activeElement);
      if (i < 0) return;
      e.preventDefault();
      btns[(i + (e.key === 'ArrowRight' ? 1 : -1) + btns.length) % btns.length].focus();
    });
    this.top = h('div', { class: 'arc-top' }, addrRow, this.cmdbar);
    this.infobar = h('div', { class: 'arc-infos' });

    this.list = new DetailsList(this);
    this.nav = new NavTree(this);
    this.preview = new PreviewPane(this);
    this.navWrap = h('div', { class: 'arc-navpane' }, this.nav.el);
    this.split1 = h('div', { class: 'arc-split', role: 'separator', 'aria-orientation': 'vertical', onpointerdown: (e) => this.dragSplit(e, 'nav') });
    this.split2 = h('div', { class: 'arc-split', role: 'separator', 'aria-orientation': 'vertical', onpointerdown: (e) => this.dragSplit(e, 'preview') });
    this.content = h('div', { class: 'arc-content' }, this.infobar, this.list.el);
    this.main = h('div', { class: 'arc-main' }, this.navWrap, this.split1, this.content, this.split2, this.preview.el);
    this.statusLeft = h('div', { class: 'arc-status-l', 'aria-live': 'polite' });
    this.statusRight = h('div', { class: 'arc-status-r' });
    this.status = h('div', { class: 'arc-status caption' }, this.statusLeft, this.statusRight);
    this.toast = h('div', { class: 'arc-toast', role: 'status', hidden: true });
    this.welcome = new Welcome(this);
    this.dropEl = h('div', { class: 'arc-drop', hidden: true }, h('div', { class: 'arc-drop-card' }, icon('document_arrow_up', { size: 28 }), (this.dropText = h('span'))));
    this.view = h('div', { class: 'arc-view', hidden: true }, this.top, this.main, this.status);
    this.task = h('div', { class: 'arc-task', hidden: true });
    this.root = h('div', { class: 'arc-root' }, this.view, this.welcome.el, this.task, this.toast, this.dropEl);
    this.win.body.appendChild(this.root);
    this.applyPanes();
    this.wire();
  }

  applyPanes() {
    const p = shared.prefs;
    const narrow = this.win.w < 640;
    this.navWrap.hidden = !p.nav || narrow;
    this.split1.hidden = this.navWrap.hidden;
    this.preview.el.hidden = !p.preview || this.win.w < 760;
    this.split2.hidden = this.preview.el.hidden;
    this.navWrap.style.width = `${p.navWidth}px`;
    this.preview.el.style.width = `${p.previewWidth}px`;
    this.root.classList.toggle('compact', !!p.compact);
    this.cmds.preview.classList.toggle('toggled', !this.preview.el.hidden);
    this.cmds.preview.setAttribute('aria-pressed', String(!this.preview.el.hidden));
  }

  dragSplit(e, which) {
    e.preventDefault();
    const x0 = e.clientX;
    const key = which === 'nav' ? 'navWidth' : 'previewWidth';
    const w0 = shared.prefs[key];
    const el = which === 'nav' ? this.navWrap : this.preview.el;
    const sp = e.currentTarget;
    sp.setPointerCapture?.(e.pointerId);
    sp.classList.add('active');
    let w = w0;
    const move = (ev) => {
      const dx = ev.clientX - x0;
      w = which === 'nav' ? Math.max(140, Math.min(480, w0 + dx)) : Math.max(200, Math.min(640, w0 - dx));
      el.style.width = `${w}px`;
    };
    const up = () => {
      sp.classList.remove('active');
      sp.removeEventListener('pointermove', move);
      sp.removeEventListener('pointerup', up);
      sp.removeEventListener('pointercancel', up);
      shared.setPref(key, Math.round(w));
    };
    sp.addEventListener('pointermove', move);
    sp.addEventListener('pointerup', up);
    sp.addEventListener('pointercancel', up);
  }

  wire() {
    const { win } = this;
    win.on('resize', () => {
      this.applyPanes();
      this.fitCrumbs();
    });
    win.body.addEventListener('keydown', (e) => this.onKey(e));
    this.offs.push(shared.on('prefs', (k) => {
      if (k === 'nav' || k === 'preview' || k === 'compact') {
        this.applyPanes();
        if (k === 'compact') this.list.refreshRows();
      }
      if (k === 'sort' && this.listing) this.refreshList({ keep: true });
    }));
    // drag & drop of files from Files / the desktop
    const isFileDrag = (e) => {
      const types = [...(e.dataTransfer?.types || [])];
      return types.includes('Files') || types.includes(DND_MIME);
    };
    const over = (e) => {
      if (!isFileDrag(e) || this.draggingOut || this.dialogOpen() || !this.task.hidden) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
      this.showDrop(true);
    };
    win.el.addEventListener('dragenter', over, true);
    win.el.addEventListener('dragover', over, true);
    win.el.addEventListener('dragleave', (e) => {
      if (!e.relatedTarget || !win.el.contains(e.relatedTarget)) this.showDrop(false);
    });
    win.el.addEventListener(
      'drop',
      (e) => {
        if (!isFileDrag(e) || this.draggingOut) return;
        e.preventDefault();
        e.stopPropagation();
        this.showDrop(false);
        this.onDrop(e.dataTransfer);
      },
      true,
    );
    this.win.onBeforeClose(async () => {
      if (!this.busy) return true;
      return this.ui.confirm(this.t('close.busyBody'), { title: this.t('close.busyTitle'), okLabel: this.t('close.busyOk'), parent: this.win });
    });
    this.ctx.onClose(() => this.destroy());
    this.ctx.onLangChange(() => this.relabel());
  }

  relabel() {
    // Rebuild every label in the new language (state is kept).
    const keepFolder = this.folder?.path;
    const sel = [...this.list.selected];
    this.win.body.replaceChildren();
    this.list.destroy();
    this.welcome.destroy();
    for (const off of this.offs) off();
    this.offs = [];
    this.build();
    if (this.listing) {
      this.showView();
      this.nav.setRoot(this.tree.root, this.listing.name);
      this.navigate(this.tree.all.get(keepFolder) || this.tree.root, { history: false, select: sel });
      this.renderInfos();
      this.setTitle();
    } else this.showWelcome();
  }

  dialogOpen() {
    return !!this.win.el.querySelector(':scope > .dialog-layer:not(.closing)');
  }
  showDrop(on) {
    if (on) {
      this.dropText.textContent = this.listing ? (this.listing.canAdd ? this.t('drop.add', { name: this.listing.name }) : this.t('drop.readOnly')) : this.t('drop.welcome');
      this.dropEl.classList.toggle('blocked', !!this.listing && !this.listing.canAdd);
    }
    if (!!on === !this.dropEl.hidden) return;
    this.dropEl.hidden = !on;
  }

  // ================================================================== start-up
  async init(args = {}) {
    shared.windows.add(this);
    this.build();
    this.api.invoke('archive:tempDir', this.session).then((d) => (this.tempDir = d)).catch(() => {});
    if (args.extract) return this.extractFlow(args);
    if (args.compress) return this.compressFlow(args);
    if (args.file) {
      const other = shared.findOpen(args.file);
      if (other && other !== this) {
        other.win.focus();
        this.win.close(true);
        return;
      }
      this.showView(true);
      const ok = await this.openPath(args.file);
      if (!ok && !this.listing) this.showWelcome();
      return;
    }
    this.showWelcome();
  }
  showWelcome() {
    this.view.hidden = true;
    this.task.hidden = true;
    this.welcome.show();
    this.win.setTitle(this.appName);
    setTimeout(() => this.welcome.el.querySelector('.arc-wcard')?.focus({ preventScroll: true }), 60);
  }
  showView(loading = false) {
    this.welcome.hide();
    this.task.hidden = true;
    this.view.hidden = false;
    this.root.classList.toggle('loading', loading);
  }
  setTitle() {
    this.win.setTitle(this.listing ? `${this.listing.name} - ${this.appName}` : this.appName);
  }

  // ================================================================== opening
  async openDialog() {
    const { t, ui } = this;
    const p = await ui.filePicker({
      mode: 'open',
      title: t('open.title'),
      path: this.listing ? dirname(this.listing.path) : undefined,
      filters: [
        { name: t('open.archives'), ext: ['.zip', '.7z', '.rar', '.tar', '.gz', '.tgz', '.xz', '.txz', '.bz2', '.tbz2', '.zst', '.tzst', '.cab', '.jar'] },
        { name: t('open.all'), ext: ['*'] },
      ],
      parent: this.win,
    });
    if (p) await this.openPath(p);
  }

  /** Load (or reload) an archive; prompts for a password when its file names are encrypted. */
  async openPath(path, { keepFolder = null, select = null } = {}) {
    const { t } = this;
    const other = shared.findOpen(path);
    if (other && other !== this) {
      other.win.focus();
      return true;
    }
    if (this.listing?.path !== path) this.password = null;
    this.root.classList.add('loading');
    let listing;
    try {
      listing = await this.withPassword((password) => this.api.invoke('archive:list', path, { password }), { name: basename(path), needed: false, silentFirst: true });
    } catch (e) {
      this.root.classList.remove('loading');
      if (canceled(e)) return false;
      await D.errorDialog(this, t('err.openTitle', { name: basename(path) }), e);
      return false;
    }
    this.root.classList.remove('loading');
    this.setListing(listing, { keepFolder, select });
    shared.recentAdd(listing);
    return true;
  }

  setListing(listing, { keepFolder = null, select = null } = {}) {
    const first = this.listing?.path !== listing.path;
    this.listing = listing;
    this.tree = buildTree(listing.entries, listing.name);
    if (first) {
      this.history = [];
      this.future = [];
      this.searchInput.value = '';
      this.query = '';
    }
    this.showView();
    this.searchInput.placeholder = this.t('search.placeholder', { name: listing.name });
    this.nav.setRoot(this.tree.root, listing.name);
    let folder = (keepFolder != null && this.tree.all.get(keepFolder)) || null;
    if (!folder) {
      folder = this.tree.root;
      // a single top-level folder: show its content like Explorer does after "Extract all"? No — keep root.
    }
    this.navigate(folder, { history: false, select });
    this.renderInfos();
    this.setTitle();
    this.updateCommands();
    if (first) setTimeout(() => !this.dialogOpen() && this.list.el.focus({ preventScroll: true }), 30);
  }

  async reload({ keep = true, spin = false, select = null } = {}) {
    if (!this.listing) return;
    if (spin) {
      this.btnRefresh.classList.remove('spin');
      void this.btnRefresh.offsetWidth;
      this.btnRefresh.classList.add('spin');
    }
    const folder = keep ? this.folder?.path : null;
    const sel = select || (keep ? [...this.list.selected] : null);
    try {
      const listing = await this.withPassword((password) => this.api.invoke('archive:list', this.listing.path, { password }), { needed: false, silentFirst: true });
      this.setListing(listing, { keepFolder: folder, select: sel });
    } catch (e) {
      if (canceled(e)) return;
      await D.errorDialog(this, this.t('err.openTitle', { name: this.listing.name }), e);
    }
  }

  renderInfos() {
    const { h, t, icon, i18n } = this;
    const L = this.listing;
    this.infobar.replaceChildren();
    const bar = (kind, ic, text, action) =>
      h('div', { class: ['infobar', 'arc-info', kind], role: kind === 'error' ? 'alert' : 'status' }, icon(ic, { filled: true }), h('div', { class: 'grow' }, text), action || null);
    if (L.unsafe.length) {
      this.infobar.appendChild(
        bar('warning', 'shield_error', t('info.unsafe', { count: L.unsafe.length, n: i18n.formatNumber(L.unsafe.length) }), h('button', { class: 'btn small', onclick: () => D.unsafeDialog(this, L.unsafe).then((go) => go && this.extractAll({ skipConfirmUnsafe: true })) }, t('info.details'))),
      );
    }
    if (L.damaged) this.infobar.appendChild(bar('error', 'error_circle', t('info.damaged')));
    if (L.truncated) this.infobar.appendChild(bar('warning', 'warning', t('info.truncated', { shown: i18n.formatNumber(L.entries.length), total: i18n.formatNumber(L.count) })));
    this.infobar.hidden = !this.infobar.children.length;
  }

  // ================================================================== navigation
  navigate(node, { history = true, select = null } = {}) {
    if (!node || !node.dir) return;
    if (history && this.folder && this.folder !== node) {
      this.history.push(this.folder.path);
      this.future = [];
    }
    const from = this.folder;
    this.folder = node;
    if (this.query && history) {
      this.query = '';
      this.searchInput.value = '';
    }
    this.renderCrumbs();
    this.nav.select(node);
    // coming back up: select the folder we came from (Explorer does this)
    const sel = select || (from && from.parent === node && !this.query ? [from.path] : null);
    this.refreshList({ select: sel });
    this.list.el.classList.remove('enter');
    void this.list.el.offsetWidth;
    if (history) this.list.el.classList.add('enter');
    this.updateNavButtons();
  }
  goBack() {
    const p = this.history.pop();
    if (p == null) return;
    this.future.push(this.folder.path);
    this.navigate(this.tree.all.get(p) || this.tree.root, { history: false });
  }
  goForward() {
    const p = this.future.pop();
    if (p == null) return;
    this.history.push(this.folder.path);
    this.navigate(this.tree.all.get(p) || this.tree.root, { history: false });
  }
  goUp() {
    if (this.query) {
      this.searchInput.value = '';
      this.onSearch();
      return;
    }
    if (this.folder?.parent) this.navigate(this.folder.parent);
  }
  updateNavButtons() {
    this.btnBack.disabled = !this.history.length;
    this.btnFwd.disabled = !this.future.length;
    this.btnUp.disabled = !this.folder?.parent && !this.query;
  }

  renderCrumbs() {
    const { h, icon, t } = this;
    this.crumbs.replaceChildren();
    const chain = ancestors(this.folder);
    const items = [];
    chain.forEach((n, i) => {
      const isRoot = i === 0;
      const crumb = h(
        'button',
        {
          class: ['arc-crumb', i === chain.length - 1 && !this.query && 'current'],
          dataset: { path: n.path },
          onclick: () => this.navigate(n),
        },
        isRoot ? h('img', { class: 'arc-crumb-ic', src: 'app://shell/apps/archive/icons/file-archive.svg', alt: '' }) : null,
        h('span', { class: 'ellipsis' }, isRoot ? this.listing.name : n.name),
      );
      items.push(crumb);
      const kids = [...n.children.values()].filter((c) => c.dir);
      const chev = h(
        'button',
        {
          class: 'arc-crumb-chev',
          'aria-label': t('nav.subfolders', { name: isRoot ? this.listing.name : n.name }),
          disabled: !kids.length,
          onclick: (e) => {
            const coll = new Intl.Collator(this.i18n.locale, { numeric: true, sensitivity: 'base' });
            chev.classList.add('open');
            this.ui
              .menu(e.currentTarget, kids.sort((a, b) => coll.compare(a.name, b.name)).slice(0, 200).map((c) => ({ label: c.name, icon: 'folder', action: () => this.navigate(c) })))
              .then(() => chev.classList.remove('open'));
          },
        },
        icon('chevron_right', { size: 12 }),
      );
      if (i < chain.length - 1 || kids.length) items.push(chev);
    });
    if (this.query) {
      items.push(h('span', { class: 'arc-crumb current search' }, h('span', { class: 'ellipsis' }, t('search.results', { q: this.query }))));
    }
    this.more = h('button', { class: 'arc-crumb-more', hidden: true, 'aria-label': t('nav.more') }, '…');
    this.crumbs.append(this.more, ...items);
    requestAnimationFrame(() => this.fitCrumbs());
  }
  fitCrumbs() {
    if (!this.more || !this.crumbs.isConnected) return;
    const all = [...this.crumbs.children].filter((c) => c !== this.more);
    for (const c of all) c.hidden = false;
    this.more.hidden = true;
    const hidden = [];
    let i = 0;
    while (this.crumbs.scrollWidth > this.crumbs.clientWidth + 1 && i < all.length - 2) {
      this.more.hidden = false;
      all[i].hidden = true;
      if (all[i].classList.contains('arc-crumb')) hidden.push(all[i]);
      i++;
    }
    if (hidden.length) {
      this.more.onclick = (e) => this.ui.menu(e.currentTarget, hidden.map((c) => ({ label: c.textContent, icon: 'folder', action: () => this.navigate(this.tree.all.get(c.dataset.path) || this.tree.root) })));
    } else this.more.hidden = true;
  }

  // ================================================================== list
  columns() {
    const { t } = this;
    const W = shared.prefs.widths;
    const L = this.listing;
    const cols = [{ key: 'name', label: t('col.name'), width: W.name, min: 120 }];
    if (this.query) cols.push({ key: 'location', label: t('col.location'), width: W.location });
    cols.push({ key: 'type', label: t('col.type'), width: W.type });
    if (L?.perEntryPacked) cols.push({ key: 'packed', label: t('col.packed'), width: W.packed, align: 'end' });
    cols.push({ key: 'size', label: t('col.size'), width: W.size, align: 'end' });
    if (L?.perEntryPacked) cols.push({ key: 'ratio', label: t('col.ratio'), width: W.ratio, align: 'end' });
    cols.push({ key: 'mtime', label: t('col.mtime'), width: W.mtime });
    return cols;
  }
  refreshList({ keep = false, select = null } = {}) {
    if (!this.folder) return;
    const sort = shared.prefs.sort;
    const nodes = this.query ? search(this.tree.root, this.query) : [...this.folder.children.values()];
    const valid = ['name', 'type', 'packed', 'size', 'ratio', 'mtime', 'location'];
    nodes.sort(makeSorter(valid.includes(sort.key) ? sort.key : 'name', sort.dir, this.i18n.locale));
    this.list.setColumns(this.columns());
    this.list.setItems(nodes, { keep, select, empty: this.query ? this.t('list.noResults') : this.t('list.empty') });
  }
  setSort(key) {
    const s = shared.prefs.sort;
    shared.setPref('sort', s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'mtime' || key === 'size' || key === 'packed' ? 'desc' : 'asc' });
  }
  onSearch() {
    const q = this.searchInput.value.trim();
    this.searchBox.classList.toggle('has-text', !!q);
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      if (q === this.query) return;
      this.query = q;
      this.renderCrumbs();
      this.refreshList();
      this.updateNavButtons();
    }, 120);
  }

  onSelectionChange() {
    this.updateCommands();
    this.updateStatus();
    if (!this.preview.el.hidden) this.preview.update(this.list.selectedNodes());
  }
  updateCommands() {
    const L = this.listing;
    const sel = this.list?.selected.size || 0;
    const busy = this.busy > 0;
    const C = this.cmds;
    if (!C) return;
    C.extractAll.disabled = !L || busy;
    C.extractSel.disabled = !L || busy || !sel;
    C.add.disabled = !L || busy || !L.canAdd;
    C.add.dataset.tip = L && !L.canAdd ? this.t('cmd.readOnlyTip', { fmt: (L.format || '').toUpperCase() }) : this.t('cmd.add');
    C.delete.disabled = !L || busy || !L.canDelete || !sel;
    C.copy.disabled = !L || busy || !sel;
    C.test.disabled = !L || busy;
    C.props.disabled = !L;
    C.sort.disabled = !L;
    this.btnRefresh.disabled = !L || busy;
  }
  updateStatus() {
    const { t, i18n, h, icon } = this;
    const L = this.listing;
    if (!L) return;
    const count = this.list.items.length;
    const sel = this.list.selectedNodes();
    const parts = [h('span', null, t('status.items', { count, n: i18n.formatNumber(count) }))];
    if (sel.length) {
      const size = sel.reduce((s, n) => s + (n.dir ? n.tsize : n.size), 0);
      parts.push(h('span', { class: 'arc-status-sep' }), h('span', null, t('status.selected', { count: sel.length, n: i18n.formatNumber(sel.length) })));
      if (size || sel.some((n) => !n.dir)) parts.push(h('span', { class: 'arc-status-size' }, i18n.formatSize(size)));
    }
    this.statusLeft.replaceChildren(...parts);
    const ratio = ratioOf(L.totalSize, L.size);
    this.statusRight.replaceChildren(
      L.encrypted ? h('span', { class: 'arc-status-lock', 'data-tip': L.headersEncrypted ? t('props.encHeaders') : t('props.encData') }, icon('lock_closed', { size: 12, filled: true })) : null,
      h('span', { class: 'arc-fmt-badge' }, (L.format || '').toUpperCase()),
      h('span', null, i18n.formatSize(L.size)),
      ratio != null && L.totalSize ? h('span', { class: 'text-2' }, t('status.ratio', { pct: i18n.formatNumber(Math.round(ratio * 100)) })) : null,
      !L.canAdd ? h('span', { class: 'text-2' }, t('status.readOnly')) : null,
    );
  }

  // ================================================================== passwords
  async askPassword(error = false) {
    const pw = await D.passwordDialog(this, { name: this.listing?.name || '', error });
    if (pw != null) this.password = pw;
    return pw;
  }
  /** Run fn(password); prompts on EPASSWORD / EBADPASSWORD and retries. */
  async withPassword(fn, { name = null, needed = false, silentFirst = false } = {}) {
    let error = false;
    for (let tries = 0; tries < 8; tries++) {
      if (needed && this.password == null) {
        const pw = await D.passwordDialog(this, { name: name || this.listing?.name || '', error });
        if (pw == null) {
          const e = new Error('canceled');
          e.code = 'ECANCELED';
          throw e;
        }
        this.password = pw;
      }
      try {
        return await fn(this.password);
      } catch (e) {
        if (e.code === 'EPASSWORD' || e.code === 'EBADPASSWORD') {
          error = e.code === 'EBADPASSWORD' || (this.password != null && !silentFirst);
          if (e.code === 'EPASSWORD' && this.password != null) error = true;
          this.password = null;
          needed = true;
          silentFirst = false;
          continue;
        }
        throw e;
      }
    }
    const e = new Error('Too many attempts');
    e.code = 'EBADPASSWORD';
    throw e;
  }

  // ================================================================== extraction
  defaultDest() {
    const L = this.listing;
    return joinPath(dirname(L.path), stemOf(L.name) || 'Extracted');
  }
  selectedOrAll() {
    return this.list.selectedNodes();
  }
  async extractAll({ skipConfirmUnsafe = false } = {}) {
    if (!this.listing || this.busy) return;
    const opts = await D.extractDialog(this, { defaultDest: this.defaultDest() });
    if (!opts) return;
    await this.runExtract({ nodes: null, ...opts, unsafeConfirmed: skipConfirmUnsafe });
  }
  async extractSelected(nodes = this.list.selectedNodes()) {
    if (!this.listing || this.busy || !nodes.length) return;
    const opts = await D.extractDialog(this, { count: nodes.length, defaultDest: dirname(this.listing.path) });
    if (!opts) return;
    await this.runExtract({ nodes, ...opts });
  }
  async runExtract({ nodes, dest, overwrite = 'rename', show = false, unsafeConfirmed = false, quiet = false }) {
    const { t, i18n } = this;
    const L = this.listing;
    let skipUnsafe = false;
    if (!nodes && L.unsafe.length) {
      if (!unsafeConfirmed && !(await D.unsafeDialog(this, L.unsafe))) return null;
      skipUnsafe = true;
    }
    const total = nodes ? nodes.reduce((s, n) => s + (n.dir ? n.tsize : n.size), 0) : L.totalSize;
    let allowBomb = false;
    const ratio = L.size ? L.totalSize / L.size : 0;
    if (L.bomb && (total > 10 * 1024 ** 3 || (total > 64 * 1024 ** 2 && ratio > 100))) {
      if (!(await D.bombDialog(this, { total, ratio }))) return null;
      allowBomb = true;
    }
    const needed = nodes ? nodes.some((n) => n.encrypted || n.anyEncrypted) : L.encrypted;
    try {
      const res = await this.withPassword(
        (password) =>
          withProgress(this, { title: t('prog.extracting'), line: t('prog.extractLine', { name: L.name, dest }) }, (opId) =>
            this.api.invoke('archive:extract', L.path, dest, { entries: nodes ? nodes.map((n) => n.path) : null, password, overwrite, opId, skipUnsafe, allowBomb }),
          ),
        { needed },
      );
      const unexpected = res.skipped.filter((s) => !L.unsafe.some((u) => u.path === s.path));
      if (unexpected.length) {
        this.ui.alert(t('done.skipped', { count: unexpected.length, n: i18n.formatNumber(unexpected.length), list: unexpected.slice(0, 6).map((s) => s.path).join('\n') }), { title: t('done.skippedTitle'), parent: this.win });
      }
      if (show) this.shell.launch('files', res.items.length === 1 && nodes ? { select: res.items[0] } : { path: res.dest });
      else if (!quiet) {
        this.showToast(t('done.extracted', { count: res.files, n: i18n.formatNumber(res.files), dest: basename(res.dest) || res.dest }), {
          label: t('done.openFolder'),
          action: () => this.shell.launch('files', res.items.length ? { select: res.items[0] } : { path: res.dest }),
        });
      }
      return res;
    } catch (e) {
      if (canceled(e)) {
        this.showToast(t('done.canceled'));
        return null;
      }
      await D.errorDialog(this, t('err.extractTitle'), e);
      return null;
    }
  }

  /** Extract one file to the private temp folder (cached) -> { path, text?, binary?, truncated? } */
  async previewFile(n, { text = 0, progress = false } = {}) {
    const L = this.listing;
    const call = (password, opId) => this.api.invoke('archive:preview', L.path, n.path, { password, session: this.session, text, opId, allowBomb: true });
    if (progress) {
      return this.withPassword((password) => withProgress(this, { title: this.t('prog.opening'), line: n.name, delay: 500 }, (opId) => call(password, opId)), { needed: n.encrypted });
    }
    if (n.encrypted && this.password == null) {
      const e = new Error('password');
      e.code = 'EPASSWORD';
      throw e;
    }
    return call(this.password, undefined);
  }

  async openNode(n) {
    if (!n) return;
    if (n.dir) {
      if (this.query) {
        this.query = '';
        this.searchInput.value = '';
        this.searchBox.classList.remove('has-text');
      }
      this.navigate(n);
      return;
    }
    if (this.busy) return;
    try {
      const res = await this.previewFile(n, { progress: true });
      await this.shell.openFile(res.path);
    } catch (e) {
      if (canceled(e)) return;
      await D.errorDialog(this, this.t('err.openFileTitle', { name: n.name }), e);
    }
  }
  async openMany(nodes) {
    const files = nodes.filter((n) => !n.dir).slice(0, 10);
    if (nodes.length === 1 || (!files.length && nodes[0]?.dir)) return this.openNode(nodes[0]);
    for (const n of files) await this.openNode(n);
  }

  // ================================================================== modifying the archive
  async addFiles(paths = null) {
    const { t, ui, i18n } = this;
    const L = this.listing;
    if (!L || this.busy) return;
    if (!L.canAdd) {
      await ui.alert(t('cmd.readOnlyTip', { fmt: (L.format || '').toUpperCase() }), { title: t('cmd.add'), parent: this.win });
      return;
    }
    if (!paths) {
      const r = await ui.filePicker({ mode: 'open', multiple: true, title: t('add.title', { name: L.name }), parent: this.win });
      paths = Array.isArray(r) ? r : r ? [r] : [];
      if (!paths.length) return;
    } else {
      const where = this.folder?.path ? `${L.name}/${this.folder.path}` : L.name;
      const ok = await ui.confirm(t('add.confirm', { count: paths.length, n: i18n.formatNumber(paths.length), name: paths.length === 1 ? basename(paths[0]) : '', where }), { title: t('add.confirmTitle'), okLabel: t('add.ok'), parent: this.win });
      if (!ok) return;
    }
    paths = paths.filter((p) => p !== L.path);
    if (!paths.length) return;
    const base = this.query ? '' : this.folder?.path || '';
    // names already in this folder are replaced: ask first (Windows' "Replace the files in the destination?")
    const clash = paths.filter((p) => this.folder?.children.has(basename(p)) && !this.query);
    if (clash.length) {
      const ok = await ui.confirm(t('add.replace', { count: clash.length, n: i18n.formatNumber(clash.length), name: basename(clash[0]) }), { title: t('add.replaceTitle'), okLabel: t('add.replaceOk'), parent: this.win });
      if (!ok) return;
    }
    try {
      await this.withPassword(
        (password) => withProgress(this, { title: t('prog.adding'), line: t('prog.addLine', { count: paths.length, n: i18n.formatNumber(paths.length), name: L.name }) }, (opId) => this.api.invoke('archive:add', L.path, paths, { base, password, opId })),
        { needed: L.encrypted && this.password == null },
      );
      await this.reload({ keep: true, select: paths.map((p) => (base ? `${base}/${basename(p)}` : basename(p))) });
      this.showToast(t('done.added', { count: paths.length, n: i18n.formatNumber(paths.length) }));
    } catch (e) {
      if (canceled(e)) return this.reload({ keep: true });
      await D.errorDialog(this, t('err.addTitle'), e);
      await this.reload({ keep: true });
    }
  }

  async deleteSelected() {
    const { t, i18n } = this;
    const L = this.listing;
    const nodes = this.list.selectedNodes();
    if (!L || this.busy || !nodes.length || !L.canDelete) return;
    if (!(await D.confirmDelete(this, nodes))) return;
    const idx = this.list.focusIndex;
    try {
      await this.withPassword(
        (password) => withProgress(this, { title: t('prog.deleting'), line: L.name }, (opId) => this.api.invoke('archive:delete', L.path, nodes.map((n) => n.path), { password, opId })),
        { needed: L.headersEncrypted && this.password == null },
      );
      await this.reload({ keep: true, select: [] });
      const next = this.list.items[Math.min(idx, this.list.items.length - 1)];
      if (next) this.list.selectPaths([next.path]);
      this.showToast(t('done.deleted', { count: nodes.length, n: i18n.formatNumber(nodes.length) }));
    } catch (e) {
      if (canceled(e)) return this.reload({ keep: true });
      await D.errorDialog(this, t('err.deleteTitle'), e);
      await this.reload({ keep: true });
    }
  }

  async testArchive() {
    const { t } = this;
    const L = this.listing;
    if (!L || this.busy) return;
    try {
      const res = await this.withPassword((password) => withProgress(this, { title: t('prog.testing'), line: L.name }, (opId) => this.api.invoke('archive:test', L.path, { password, opId })), { needed: L.encrypted && this.password == null });
      await D.testResultDialog(this, res);
    } catch (e) {
      if (canceled(e)) return;
      await D.errorDialog(this, t('test.title'), e);
    }
  }

  async properties() {
    if (!this.listing) return;
    await D.propertiesDialog(this, this.list.selectedNodes());
  }

  async newArchive(sources = []) {
    const opts = await D.newArchiveDialog(this, { sources });
    if (!opts) return;
    const { t, i18n } = this;
    try {
      const res = await withProgress(this, { title: t('prog.creating'), line: t('prog.createLine', { name: basename(opts.dest) }) }, (opId) =>
        this.api.invoke('archive:create', opts.sources, opts.dest, { format: opts.format, level: opts.level, password: opts.password, encryptNames: opts.encryptNames, opId }),
      );
      if (this.listing) {
        this.shell.launch('archive', { file: res.path });
        this.showToast(t('done.created', { name: basename(res.path), size: i18n.formatSize(res.size) }));
      } else {
        if (opts.password) this.password = opts.password;
        await this.openPath(res.path);
      }
    } catch (e) {
      if (canceled(e)) return;
      await D.errorDialog(this, t('err.createTitle'), e);
    }
  }

  // ================================================================== clipboard / drag & drop
  async copySelection() {
    const nodes = this.list.selectedNodes();
    const L = this.listing;
    if (!L || !nodes.length || this.busy) return;
    const { t, i18n } = this;
    try {
      const res = await this.withPassword(
        (password) => withProgress(this, { title: t('prog.copying'), line: L.name, delay: 500 }, (opId) => this.api.invoke('archive:extractTemp', L.path, { entries: nodes.map((n) => n.path), password, session: this.session, opId })),
        { needed: nodes.some((n) => n.encrypted || n.anyEncrypted) && this.password == null },
      );
      this.shell.clipboard.setFiles(res.items, 'copy');
      this.showToast(t('done.copied', { count: res.items.length, n: i18n.formatNumber(res.items.length) }));
    } catch (e) {
      if (canceled(e)) return;
      await D.errorDialog(this, t('err.copyTitle'), e);
    }
  }
  async paste() {
    const clip = this.shell.clipboard.getFiles();
    if (!clip?.paths?.length || !this.listing) return;
    // our own Copy puts files of this archive's temp folder on the clipboard: never add those back
    const paths = clip.paths.filter((p) => !(this.tempDir && p.startsWith(`${this.tempDir}/`)));
    if (paths.length) await this.addFiles(paths);
  }

  /** Drag entries out: the paths point into the window's temp folder; extraction starts immediately. */
  dragOut(e, nodes) {
    const L = this.listing;
    const total = nodes.reduce((s, n) => s + (n.dir ? n.tsize : n.size), 0);
    if (!L || !this.tempDir || total > 512 * 1024 * 1024 || nodes.some((n) => (n.encrypted || n.anyEncrypted) && this.password == null)) {
      e.preventDefault();
      if (total > 512 * 1024 * 1024) this.showToast(this.t('drag.tooBig'));
      else if (nodes.some((n) => n.encrypted || n.anyEncrypted)) this.showToast(this.t('drag.locked'));
      return;
    }
    const sub = `d${++this.dragSeq}`;
    const dir = `${this.tempDir}/x-${sub}`;
    const paths = nodes.map((n) => `${dir}/${n.name}`);
    const dt = e.dataTransfer;
    dt.effectAllowed = 'copy';
    dt.setData(DND_MIME, JSON.stringify(paths));
    dt.setData('text/uri-list', paths.map((p) => `file://${p.split('/').map(encodeURIComponent).join('/')}`).join('\r\n'));
    dt.setData('text/plain', paths.join('\n'));
    this.draggingOut = true;
    this.api.invoke('archive:extractTemp', L.path, { entries: nodes.map((n) => n.path), password: this.password, session: this.session, sub }).catch(() => {});
    const ghost = this.h('div', { class: 'app-archive arc-drag-ghost' }, this.h('img', { src: `app://shell/apps/archive/icons/${nodes[0].dir ? 'folder' : 'file'}.svg`, alt: '' }), nodes.length > 1 ? this.h('span', null, String(nodes.length)) : null);
    document.body.appendChild(ghost);
    try {
      dt.setDragImage(ghost, 24, 24);
    } catch {}
    setTimeout(() => ghost.remove(), 0);
  }
  dragEnd() {
    this.draggingOut = false;
  }

  async onDrop(dt) {
    let paths = trustedDragPaths(dt);
    if (!paths.length) paths = [...(dt.files || [])].map((f) => this.api.pathForFile(f)).filter(Boolean);
    paths = paths.filter((p) => typeof p === 'string' && p.startsWith('/'));
    if (!paths.length) return;
    this.win.focus();
    if (!this.listing) {
      const arcs = paths.filter((p) => isArchiveName(p));
      if (arcs.length === paths.length) {
        await this.openPath(arcs[0]);
        for (const p of arcs.slice(1, 8)) this.shell.launch('archive', { file: p });
      } else await this.newArchive(paths);
      return;
    }
    if (!this.listing.canAdd) {
      await this.ui.alert(this.t('cmd.readOnlyTip', { fmt: (this.listing.format || '').toUpperCase() }), { title: this.t('cmd.add'), parent: this.win });
      return;
    }
    await this.addFiles(paths);
  }

  // ================================================================== menus
  newMenu(e) {
    const { t } = this;
    this.ui.menu(e.currentTarget, [
      { label: t('menu.newArchive'), icon: 'folder_zip', shortcut: 'Ctrl+N', action: () => this.newArchive() },
      { label: t('menu.openArchive'), icon: 'folder_open', shortcut: 'Ctrl+O', action: () => this.openDialog() },
      '-',
      { label: t('menu.newWindow'), icon: 'window_new', action: () => this.shell.launch('archive', {}) },
    ]);
  }
  sortMenu(e) {
    const { t } = this;
    const s = shared.prefs.sort;
    const keys = ['name', 'type', 'size', ...(this.listing?.perEntryPacked ? ['packed', 'ratio'] : []), 'mtime'];
    this.ui.menu(e?.currentTarget instanceof Element ? e.currentTarget : e, [
      ...keys.map((k) => ({ label: t(`col.${k}`), checked: s.key === k, action: () => shared.setPref('sort', { key: k, dir: s.dir }) })),
      '-',
      { label: t('sort.asc'), checked: s.dir === 'asc', action: () => shared.setPref('sort', { key: s.key, dir: 'asc' }) },
      { label: t('sort.desc'), checked: s.dir === 'desc', action: () => shared.setPref('sort', { key: s.key, dir: 'desc' }) },
    ]);
  }
  viewMenu(e) {
    const { t } = this;
    const p = shared.prefs;
    this.ui.menu(e.currentTarget, [
      { label: t('view.compact'), checked: !!p.compact, action: () => shared.setPref('compact', !p.compact) },
      '-',
      { label: t('view.nav'), checked: !!p.nav, action: () => shared.setPref('nav', !p.nav) },
      { label: t('view.preview'), checked: !!p.preview, shortcut: 'Alt+P', action: () => this.togglePreview() },
    ]);
  }
  togglePreview() {
    shared.setPref('preview', !shared.prefs.preview);
    if (shared.prefs.preview) this.preview.update(this.list.selectedNodes());
  }
  itemMenu(at, nodes) {
    const { t } = this;
    const L = this.listing;
    const one = nodes.length === 1 ? nodes[0] : null;
    this.ui.menu(at, [
      { label: one?.dir ? t('menu.openFolder') : t('menu.open'), icon: 'open', shortcut: 'Enter', action: () => this.openMany(nodes), disabled: this.busy > 0 },
      '-',
      { label: t('menu.extractTo'), icon: 'folder_arrow_right', action: () => this.extractSelected(nodes), disabled: this.busy > 0 },
      { label: t('menu.extractHere'), icon: 'folder_arrow_up', action: () => this.runExtract({ nodes, dest: dirname(L.path), overwrite: shared.prefs.overwrite }), disabled: this.busy > 0 },
      { label: t('cmd.copy'), icon: 'copy', shortcut: 'Ctrl+C', action: () => this.copySelection(), disabled: this.busy > 0 },
      '-',
      { label: t('cmd.delete'), icon: 'delete', shortcut: 'Del', action: () => this.deleteSelected(), disabled: !L.canDelete || this.busy > 0 },
      '-',
      { label: t('menu.copyPath'), icon: 'document_copy', action: () => this.api.invoke('clipboard:writeText', nodes.map((n) => n.path).join('\n')) },
      { label: t('cmd.props'), icon: 'info', shortcut: 'Alt+Enter', action: () => this.properties() },
    ]);
  }
  backgroundMenu(at) {
    const { t } = this;
    const L = this.listing;
    const clip = this.shell.clipboard.getFiles();
    this.ui.menu(at, [
      { label: t('cmd.sort'), icon: 'arrow_sort', submenu: ['name', 'type', 'size', ...(L.perEntryPacked ? ['packed', 'ratio'] : []), 'mtime'].map((k) => ({ label: t(`col.${k}`), checked: shared.prefs.sort.key === k, action: () => shared.setPref('sort', { key: k, dir: shared.prefs.sort.dir }) })) },
      { label: t('nav.refresh'), icon: 'arrow_clockwise', shortcut: 'F5', action: () => this.reload({ keep: true, spin: true }) },
      '-',
      { label: t('menu.paste'), icon: 'clipboard_paste', shortcut: 'Ctrl+V', disabled: !clip?.paths?.length || !L.canAdd || this.busy > 0, action: () => this.paste() },
      { label: t('cmd.add'), icon: 'document_add', disabled: !L.canAdd || this.busy > 0, action: () => this.addFiles() },
      '-',
      { label: t('cmd.extractAll'), icon: 'folder_arrow_up', disabled: this.busy > 0, action: () => this.extractAll() },
      { label: t('cmd.props'), icon: 'info', shortcut: 'Alt+Enter', action: () => D.propertiesDialog(this, []) },
    ]);
  }
  columnMenu(e) {
    this.sortMenu(e);
  }

  // ================================================================== keyboard
  onKey(e) {
    if (this.dialogOpen()) return;
    const inField = e.target.closest?.('input, textarea, select, [contenteditable="true"]');
    const k = e.key;
    const ctrl = e.ctrlKey && !e.altKey;
    if (ctrl && !e.shiftKey && (k === 'o' || k === 'O')) {
      e.preventDefault();
      return this.openDialog();
    }
    if (ctrl && !e.shiftKey && (k === 'n' || k === 'N')) {
      e.preventDefault();
      return this.newArchive();
    }
    if (!this.listing || !this.task.hidden) return;
    if ((ctrl && (k === 'f' || k === 'e' || k === 'F' || k === 'E') && !e.shiftKey) || k === 'F3') {
      e.preventDefault();
      this.searchInput.focus();
      this.searchInput.select();
      return;
    }
    if (ctrl && e.shiftKey && (k === 'e' || k === 'E')) {
      e.preventDefault();
      return this.extractAll();
    }
    if (k === 'F5') {
      e.preventDefault();
      return this.reload({ keep: true, spin: true });
    }
    if (e.altKey && k === 'ArrowLeft') {
      e.preventDefault();
      return this.goBack();
    }
    if (e.altKey && k === 'ArrowRight') {
      e.preventDefault();
      return this.goForward();
    }
    if (e.altKey && k === 'ArrowUp') {
      e.preventDefault();
      return this.goUp();
    }
    if (e.altKey && k === 'Enter') {
      e.preventDefault();
      return this.properties();
    }
    if (e.altKey && (k === 'p' || k === 'P')) {
      e.preventDefault();
      return this.togglePreview();
    }
    if (k === 'F6') {
      e.preventDefault();
      const order = [this.nav.el, this.list.el, this.searchInput].filter((el) => el.offsetParent !== null);
      const i = order.findIndex((el) => el.contains(document.activeElement));
      order[(i + (e.shiftKey ? -1 : 1) + order.length) % order.length]?.focus();
      return;
    }
    if (inField) return;
    if (k === 'Backspace') {
      e.preventDefault();
      return this.goUp();
    }
    if (k === 'Delete') {
      e.preventDefault();
      return this.deleteSelected();
    }
    if (ctrl && (k === 'c' || k === 'C') && !e.shiftKey) {
      e.preventDefault();
      return this.copySelection();
    }
    if (ctrl && (k === 'v' || k === 'V') && !e.shiftKey) {
      e.preventDefault();
      return this.paste();
    }
  }

  // ================================================================== feedback
  showToast(text, action = null) {
    const { h } = this;
    clearTimeout(this.toastTimer);
    this.toast.replaceChildren(h('span', { class: 'grow' }, text), action ? h('button', { class: 'btn subtle small', onclick: () => (action.action(), this.hideToast()) }, action.label) : null);
    this.toast.hidden = false;
    this.toast.classList.remove('out');
    this.toastTimer = setTimeout(() => this.hideToast(), action ? 7000 : 4000);
  }
  hideToast() {
    this.toast.classList.add('out');
    setTimeout(() => {
      if (this.toast.classList.contains('out')) this.toast.hidden = true;
    }, 200);
  }
  onBusy() {
    this.updateCommands();
    this.root.classList.toggle('busy', this.busy > 0);
  }

  // ================================================================== headless flows (args.extract / args.compress)
  compact(title) {
    this.view.hidden = true;
    this.welcome.hide();
    this.task.hidden = false;
    this.win.setTitle(title);
    this.win.setMinSize(380, 200);
    this.win.btnMax && (this.win.btnMax.hidden = true);
    this.win.el.classList.add('arc-compact-win');
    this.win.setSize(480, 230);
    this.win.center();
  }
  taskError(title, e) {
    const { h, t, icon } = this;
    const info = errorInfo(t, e);
    this.task.replaceChildren(
      h(
        'div',
        { class: 'arc-prog arc-task-error' },
        h('div', { class: 'arc-task-head' }, icon('error_circle', { size: 24, filled: true }), h('div', { class: 'arc-prog-title' }, title)),
        h('div', { class: 'selectable' }, info.message),
        info.details && info.details !== info.message ? h('div', { class: 'arc-details mono selectable' }, info.details) : null,
        h('div', { class: 'arc-prog-actions' }, h('button', { class: 'btn primary', onclick: () => this.win.close(true) }, t('common.close'))),
      ),
    );
    this.task.querySelector('.btn.primary')?.focus();
  }

  async extractFlow(args) {
    const { t } = this;
    const file = String(args.extract);
    this.compact(t('flow.extractTitle', { name: basename(file) }));
    this.task.replaceChildren(this.h('div', { class: 'arc-prog' }, this.h('div', { class: 'arc-prog-title' }, t('prog.reading')), this.h('div', { class: 'progress indeterminate' }, this.h('div', { class: 'bar' }))));
    let listing;
    try {
      listing = await this.withPassword((password) => this.api.invoke('archive:list', file, { password }), { name: basename(file), silentFirst: true });
    } catch (e) {
      if (canceled(e)) return this.win.close(true);
      return this.taskError(t('err.openTitle', { name: basename(file) }), e);
    }
    this.listing = listing;
    let dest = args.dest ? String(args.dest) : null;
    if (!dest) {
      // "Extract here": one top-level item goes straight next to the archive, anything else into a folder
      // named after it (Windows' default).
      const tops = new Set(listing.entries.map((e) => e.path.split('/')[0]));
      dest = tops.size === 1 ? dirname(file) : await this.uniquePath(dirname(file), stemOf(listing.name) || 'Extracted');
    }
    let skipUnsafe = false;
    if (listing.unsafe.length) {
      if (!(await D.unsafeDialog(this, listing.unsafe))) return this.win.close(true);
      skipUnsafe = true;
    }
    let allowBomb = false;
    if (listing.bomb) {
      if (!(await D.bombDialog(this, listing.bomb))) return this.win.close(true);
      allowBomb = true;
    }
    try {
      const res = await this.withPassword(
        (password) =>
          withProgress(this, { mode: 'inline', host: this.task, title: t('prog.extracting'), line: t('prog.extractLine', { name: listing.name, dest }) }, (opId) =>
            this.api.invoke('archive:extract', file, dest, { password, opId, skipUnsafe, allowBomb, overwrite: args.overwrite || 'rename' }),
          ),
        { needed: listing.encrypted },
      );
      if (args.show !== false) this.shell.launch('files', res.items.length === 1 ? { select: res.items[0] } : { path: res.dest });
      this.win.close(true);
    } catch (e) {
      if (canceled(e)) return this.win.close(true);
      this.taskError(t('err.extractTitle'), e);
    }
  }

  async compressFlow(args) {
    const { t } = this;
    const paths = (Array.isArray(args.compress) ? args.compress : [args.compress]).map(String).filter((p) => p.startsWith('/'));
    if (!paths.length) return this.showWelcome();
    if (!args.format) {
      // No format: the full "Create an archive" dialog, pre-filled.
      this.showWelcome();
      await this.newArchive(paths);
      if (!this.listing) this.win.close(true);
      return;
    }
    const fmt = String(args.format);
    const ext = { zip: '.zip', '7z': '.7z', tar: '.tar', 'tar.gz': '.tar.gz', 'tar.xz': '.tar.xz', 'tar.zst': '.tar.zst', 'tar.bz2': '.tar.bz2' }[fmt];
    if (!ext) return this.showWelcome();
    const dir = args.dest ? dirname(String(args.dest)) : dirname(paths[0]);
    const name = args.dest ? basename(String(args.dest)) : `${paths.length === 1 ? stemOf(basename(paths[0])) || basename(paths[0]) : basename(dirname(paths[0])) || 'Archive'}${ext}`;
    const dest = await this.uniquePath(dir, name);
    this.compact(t('flow.compressTitle', { name: basename(dest) }));
    try {
      await withProgress(this, { mode: 'inline', host: this.task, title: t('prog.creating'), line: t('prog.createLine', { name: basename(dest) }) }, (opId) =>
        this.api.invoke('archive:create', paths, dest, { format: fmt, level: Number.isFinite(Number(args.level)) ? Number(args.level) : 5, opId }),
      );
      if (args.show) this.shell.launch('files', { select: dest });
      this.win.close(true);
    } catch (e) {
      if (canceled(e)) return this.win.close(true);
      this.taskError(t('err.createTitle'), e);
    }
  }

  /** dir/name, or "name (2).ext", "name (3).ext"… when it exists (compound extensions kept: "a (2).tar.gz"). */
  async uniquePath(dir, name) {
    const [stem, ext] = splitExt(name);
    for (let i = 1; i < 1000; i++) {
      const cand = joinPath(dir === '/' ? '' : dir, i === 1 ? name : `${stem} (${i})${ext}`) || `/${name}`;
      if (!(await this.api.invoke('fs:exists', cand).catch(() => false))) return cand.startsWith('/') ? cand : `/${cand}`;
    }
    return joinPath(dir, name);
  }

  // ================================================================== teardown
  destroy() {
    shared.windows.delete(this);
    for (const off of this.offs) off();
    this.list?.destroy();
    this.welcome?.destroy();
    clearTimeout(this.toastTimer);
    this.api.invoke('archive:cleanup', this.session).catch(() => {});
  }
}

