// Gallery: navigation pane + pages (Gallery, Favorites, Albums, Album, Folders, Search, Settings),
// header command bar / selection bar, and the shared virtual grid.
import { VirtualGrid } from './grid.js';
import { matcher, baseName, dirName, sortItems, debounce } from './util.js';

const PAGES = ['gallery', 'favorites', 'albums', 'folders'];
const NAV_ICONS = { gallery: 'image_multiple', favorites: 'heart', albums: 'album', folders: 'folder' };

export class Gallery {
  constructor(app) {
    this.app = app;
    this.h = app.h;
    this.t = app.t;
    this.icon = app.icon;
    this.ui = app.ui;
    this.lib = app.lib;
    this.route = { page: 'gallery' };
    this.history = [];
    this.query = '';
    this.tree = new Map(); // dir -> { open, children: [{name, path}] | null }
    this.folderSel = null;
    this.folderCache = null;
    this._build();
    this._offLib = this.lib.on((ev) => this._onLib(ev));
  }

  destroy() {
    this._offLib?.();
    this.grid.destroy();
  }

  // ================================================================== layout
  _build() {
    const { h, t, icon } = this;
    this.navItems = {};
    const navItem = (id, label, ic) => {
      const el = h(
        'button',
        {
          class: 'nav-item ph-nav-item',
          'data-tip': label,
          'data-tip-pos': 'right',
          'aria-label': label,
          dataset: { page: id },
          onclick: () => this.navigate({ page: id }),
        },
        icon(ic),
        h('span', { class: 'ph-nav-label ellipsis' }, label),
      );
      this.navItems[id] = el;
      return el;
    };
    this.nav = h(
      'nav',
      { class: 'ph-nav', 'aria-label': t('navigation') },
      h('button', { class: 'btn subtle icon-btn ph-hamburger', 'aria-label': t('toggleNav'), 'data-tip': t('toggleNav'), onclick: () => this.toggleNav() }, icon('navigation')),
      ...PAGES.map((p) => navItem(p, t(`nav.${p}`), NAV_ICONS[p])),
      h('div', { class: 'grow' }),
      navItem('settings', t('nav.settings'), 'settings'),
    );
    this.titleEl = h('h1', { class: 'ph-title ellipsis' });
    this.countEl = h('span', { class: 'ph-count caption text-2' });
    this.backBtn = h('button', { class: 'btn subtle icon-btn ph-back', 'aria-label': t('back'), 'data-tip': t('back'), hidden: true, onclick: () => this.back() }, icon('arrow_left'));
    this.cmds = h('div', { class: 'ph-cmds' });
    this.selbar = h('div', { class: 'ph-selbar', hidden: true });
    this.progress = h('div', { class: 'progress indeterminate ph-scanbar', hidden: true }, h('div', { class: 'bar' }));
    this.head = h('header', { class: 'ph-head' }, this.backBtn, h('div', { class: 'ph-titles' }, this.titleEl, this.countEl), this.cmds, this.selbar);
    this.body = h('div', { class: 'ph-body' });
    this.main = h('div', { class: 'ph-main' }, this.head, this.progress, this.body);
    this.el = h('div', { class: 'ph-gallery' }, this.nav, this.main);

    this.grid = new VirtualGrid(this.app, {
      label: t('nav.gallery'),
      onOpen: (item, list, i) => {
        if (this.route.pick) return;
        this.app.openViewer(list, i, { from: 'gallery' });
      },
      onContext: (e, item, items) => this.app.itemMenu(e, item, items, { album: this.route.page === 'album' ? this.route.id : null }),
      onSelection: () => this._renderSelbar(),
      onDelete: (items) => this.app.deleteItems(items),
      onExitSelect: () => this._renderSelbar(),
      onBackgroundContext: (e) => this._backgroundMenu(e),
    });

    this.nav.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const items = [...this.nav.querySelectorAll('.ph-nav-item')];
      const i = items.indexOf(document.activeElement);
      if (i < 0) return;
      e.preventDefault();
      items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
    });

    // Search box in the page header (right side, before the commands)
    this.searchInput = h('input', {
      class: 'input ph-search-input',
      type: 'search',
      placeholder: t('searchPlaceholder'),
      'aria-label': t('search'),
      spellcheck: false,
    });
    const runSearch = debounce(() => this.search(this.searchInput.value), 220);
    this.searchInput.addEventListener('input', () => runSearch());
    this.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') runSearch.flush();
      else if (e.key === 'Escape') {
        e.stopPropagation();
        if (this.searchInput.value) {
          this.searchInput.value = '';
          runSearch.flush();
        } else this.grid.scroll.focus();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.grid.kb = true;
        this.grid.scroll.focus();
      }
    });
    this.searchBox = h('div', { class: 'search-box ph-search' }, icon('search'), this.searchInput);
  }

  get navCollapsed() {
    return !!this.lib.prefs.navCollapsed;
  }
  toggleNav() {
    this.lib.setPref('navCollapsed', !this.lib.prefs.navCollapsed);
  }
  applyNavState() {
    this.el.classList.toggle('nav-collapsed', this.navCollapsed);
  }

  // ================================================================== routing
  navigate(route, { push = true } = {}) {
    if (this.route.pick && route.page !== this.route.page) this.route.pick = null;
    if (push && JSON.stringify(route) !== JSON.stringify(this.route)) this.history.push(this.route);
    if (this.history.length > 50) this.history.shift();
    this.route = route;
    if (route.page !== 'search' && this.searchInput.value && !route.keepSearch) this.searchInput.value = '';
    this.grid.forceSelect = !!route.pick;
    if (!route.pick) this.grid.clearSelection();
    this.render();
  }
  back() {
    const prev = this.history.pop();
    if (prev) this.navigate(prev, { push: false });
    else if (this.route.page === 'album') this.navigate({ page: 'albums' }, { push: false });
  }
  search(q) {
    this.query = String(q || '').trim();
    if (!this.query) {
      if (this.route.page === 'search') this.back();
      return;
    }
    if (this.route.page === 'search') {
      this.route = { page: 'search', q: this.query };
      this.render();
    } else this.navigate({ page: 'search', q: this.query, keepSearch: true });
  }

  _onLib(ev) {
    if (ev === 'scanning') this._renderProgress();
    if (ev === 'items' || ev === 'favorites' || ev === 'albums' || ev === 'folders') {
      if (ev === 'folders') this.tree.clear();
      if (this.app.mode === 'gallery' || ev === 'items') this.refresh(ev);
    }
    if (ev === 'prefs') {
      this.applyNavState();
      if (this.route.page === 'settings') return;
      this.grid.relayout(true);
    }
  }

  /** Re-render the current page after data changes, keeping the scroll position. */
  refresh(ev) {
    const p = this.route.page;
    if (p === 'settings') return;
    if (ev === 'favorites' && p !== 'favorites') {
      this.grid.refreshTiles();
      this._renderSelbar();
      return;
    }
    if (p === 'folders' && ev === 'items') {
      this._loadFolder(this.folderSel, true);
      return;
    }
    this.render({ keepScroll: true });
  }

  // ================================================================== rendering
  render({ keepScroll = false } = {}) {
    const { route, t } = this;
    for (const [id, el] of Object.entries(this.navItems)) {
      const on = id === route.page || (id === 'albums' && route.page === 'album');
      el.classList.toggle('selected', on);
      if (on) el.setAttribute('aria-current', 'page');
      else el.removeAttribute('aria-current');
    }
    this.backBtn.hidden = !(route.page === 'album' || route.page === 'search' || route.pick);
    this.el.dataset.page = route.page;
    this._renderProgress();
    const page = route.page;
    if (page === 'gallery') this._pageGrid(t('nav.gallery'), this.lib.items, { keepScroll, empty: this._emptyGallery() });
    else if (page === 'favorites') this._pageGrid(t('nav.favorites'), this.lib.favoriteItems(), { keepScroll, empty: this._empty('heart', t('emptyFavTitle'), t('emptyFavBody')) });
    else if (page === 'search') {
      const m = matcher(route.q, this.app.locale);
      this._pageGrid(t('resultsFor', { q: route.q }), this.lib.items.filter(m), { keepScroll, empty: this._empty('search', t('noResults'), t('noResultsBody')) });
    } else if (page === 'album') this._pageAlbum(keepScroll);
    else if (page === 'albums') this._pageAlbums();
    else if (page === 'folders') this._pageFolders();
    else if (page === 'settings') this._pageSettings();
    this._renderSelbar();
  }

  _renderProgress() {
    const busy = this.lib.scanning && this.lib.items.length > 0 && this.route.page !== 'settings';
    this.progress.hidden = !busy;
  }

  _setBody(...nodes) {
    // Keep the grid element alive (it holds observers) when switching pages.
    for (const c of [...this.body.children]) c.remove();
    for (const n of nodes) if (n) this.body.appendChild(n);
  }

  _cmd(icon, label, onclick, { primary = false, tip, id, disabled = false, compact = false } = {}) {
    return this.h(
      'button',
      {
        class: ['btn', primary ? 'primary' : 'subtle', 'ph-cmd', compact && 'icon-only'],
        'data-tip': tip || label,
        'aria-label': label,
        dataset: id ? { cmd: id } : undefined,
        disabled,
        onclick,
      },
      this.icon(icon),
      compact ? null : this.h('span', { class: 'ph-cmd-label' }, label),
    );
  }

  _viewMenu(e) {
    const p = this.lib.prefs;
    const t = this.t;
    this.ui.menu(e, [
      { header: t('thumbSize') },
      ...['small', 'medium', 'large'].map((s) => ({ label: t(`size.${s}`), checked: p.thumbSize === s, action: () => this.lib.setPref('thumbSize', s) })),
      '-',
      { header: t('layoutLabel') },
      { label: t('layout.justified'), checked: p.layout === 'justified', action: () => this.lib.setPref('layout', 'justified') },
      { label: t('layout.square'), checked: p.layout === 'square', action: () => this.lib.setPref('layout', 'square') },
    ]);
  }

  _backgroundMenu(e) {
    const { t } = this;
    const p = this.lib.prefs;
    const has = this.grid.flat.length > 0;
    this.ui.menu(e, [
      {
        label: t('view'),
        icon: 'grid',
        submenu: [
          ...['small', 'medium', 'large'].map((s) => ({ label: t(`size.${s}`), checked: p.thumbSize === s, action: () => this.lib.setPref('thumbSize', s) })),
          '-',
          { label: t('layout.justified'), checked: p.layout === 'justified', action: () => this.lib.setPref('layout', 'justified') },
          { label: t('layout.square'), checked: p.layout === 'square', action: () => this.lib.setPref('layout', 'square') },
        ],
      },
      { label: t('slideshow'), icon: 'slide_play', shortcut: 'F5', disabled: !has, action: () => this.app.startSlideshow(this.grid.flat, 0) },
      { label: t('selectAll'), icon: 'select_all_on', shortcut: 'Ctrl+A', disabled: !has, action: () => this.grid.selectAll() },
      '-',
      { label: t('addFolder'), icon: 'folder_add', action: () => this.app.addFolder() },
    ]);
  }

  _gridCmds(items, { folder = false, album = null } = {}) {
    const { t } = this;
    const out = [];
    if (album) out.push(this._cmd('image_add', t('addPhotos'), () => this.startPick(album.id), { id: 'add-photos' }));
    out.push(
      this._cmd('slide_play', t('slideshow'), () => items.length && this.app.startSlideshow(this.grid.flat, 0), { id: 'slideshow', disabled: !items.length }),
      this._cmd('grid', t('view'), (e) => this._viewMenu(e), { id: 'view' }),
      this._cmd('multiselect_ltr', t('selectMode'), () => {
        this.grid.setSelectMode(!this.grid.forceSelect);
        this._renderSelbar();
      }, { id: 'select', disabled: !items.length }),
    );
    if (!album && (this.route.page === 'gallery' || folder)) out.push(this._cmd('folder_add', t('addFolder'), () => this.app.addFolder(), { id: 'add-folder' }));
    if (album) {
      out.push(
        this._cmd('more_horizontal', t('more'), (e) =>
          this.ui.menu(e, [
            { label: t('renameAlbum'), icon: 'rename', action: () => this.app.renameAlbum(album) },
            { label: t('deleteAlbum'), icon: 'delete', action: () => this.app.deleteAlbum(album) },
          ]), { id: 'album-more', compact: true }),
      );
    }
    return out;
  }

  /** Run a header re-render without dropping the keyboard focus (rebuilt buttons keep it by data-cmd). */
  _keepFocus(fn) {
    const a = document.activeElement;
    const inHead = a && this.head.contains(a);
    const cmd = inHead ? a.dataset?.cmd : null;
    fn();
    if (!inHead || a.isConnected && a.offsetParent) return;
    const target = (cmd && this.head.querySelector(`[data-cmd="${cmd}"]`)) || this.head.querySelector('.ph-selbar:not([hidden]) button') || this.grid.scroll;
    if (target?.offsetParent || target === this.grid.scroll) target.focus({ preventScroll: true });
  }

  _setHeader(title, count, cmds) {
    this.titleEl.textContent = title;
    this.countEl.textContent = count == null ? '' : this.t('itemCount', { count });
    this._keepFocus(() => {
      this.ui.clear(this.cmds);
      for (const c of cmds) this.cmds.appendChild(c);
    });
  }

  _pageGrid(title, items, { keepScroll, empty, grouped = true }) {
    if (this.lib.scanning && !this.lib.items.length && !this.lib.scanned) {
      this._setHeader(title, null, []);
      this._setBody(this._loading());
      return;
    }
    if (this.route.pick) {
      const a = this.lib.album(this.route.pick);
      title = this.t('pickTitle', { album: a?.name || '' });
    }
    this._setHeader(title, items.length, this.route.pick ? [] : this._gridCmds(items));
    this._setBody(this.grid.el);
    this.grid.el.classList.toggle('picking', !!this.route.pick);
    this.grid.setData({ items, grouped, empty, keepScroll });
  }

  _loading() {
    return this.h('div', { class: 'empty ph-loading' }, this.h('div', { class: 'spinner' }), this.h('div', { class: 'text-2' }, this.t('scanning')));
  }

  _empty(ic, title, body, action) {
    const { h } = this;
    return h(
      'div',
      { class: 'ph-empty' },
      h('div', { class: 'ph-empty-art' }, this.icon(ic, { size: 40 })),
      h('div', { class: 'subtitle' }, title),
      body ? h('div', { class: 'text-2 ph-empty-body' }, body) : null,
      action || null,
    );
  }

  _emptyGallery() {
    const errs = this.lib.errors?.filter((e) => e.path) || [];
    return this._empty(
      'image_multiple',
      this.t('emptyTitle'),
      errs.length ? this.t('emptyErrors', { path: errs[0].path }) : this.t('emptyBody'),
      this.h('button', { class: 'btn primary', onclick: () => this.app.addFolder() }, this.icon('folder_add'), this.t('addFolder')),
    );
  }

  // ---------------------------------------------------------------- albums
  _pageAlbums() {
    const { h, t } = this;
    const albums = this.lib.albums;
    this._setHeader(t('nav.albums'), null, [this._cmd('add', t('newAlbum'), () => this.app.newAlbum(), { id: 'new-album', primary: false })]);
    this.countEl.textContent = t('albumCount', { count: albums.length });
    if (!albums.length) {
      this._setBody(this._empty('album', t('emptyAlbumsTitle'), t('emptyAlbumsBody'), h('button', { class: 'btn primary', onclick: () => this.app.newAlbum() }, this.icon('add'), t('newAlbum'))));
      return;
    }
    const grid = h('div', { class: 'ph-albums', role: 'list' });
    for (const a of albums) {
      const cover = this.lib.albumCover(a);
      const img = h('img', { alt: '', draggable: false });
      const art = h('div', { class: ['ph-album-cover', !cover && 'empty'] }, cover ? img : this.icon('album', { size: 32 }));
      if (cover) {
        const u = this.app.thumbs.url(cover);
        if (u) img.src = u;
        else this.app.thumbs.request(cover, 2).then((x) => x && (img.src = x));
        img.onload = () => art.classList.add('loaded');
      }
      const count = a.items.filter((p) => this.lib.byPath.has(p)).length;
      const card = h(
        'button',
        {
          class: 'ph-album',
          role: 'listitem',
          dataset: { id: a.id },
          'aria-label': `${a.name}, ${t('itemCount', { count })}`,
          onclick: () => this.navigate({ page: 'album', id: a.id }),
          oncontextmenu: (e) => {
            e.preventDefault();
            this.ui.menu(e, [
              { label: t('open'), icon: 'open', action: () => this.navigate({ page: 'album', id: a.id }) },
              { label: t('slideshow'), icon: 'slide_play', disabled: !count, action: () => this.app.startSlideshow(a.items.map((p) => this.lib.get(p)).filter(Boolean), 0) },
              '-',
              { label: t('renameAlbum'), icon: 'rename', action: () => this.app.renameAlbum(a) },
              { label: t('deleteAlbum'), icon: 'delete', action: () => this.app.deleteAlbum(a) },
            ]);
          },
        },
        art,
        h('div', { class: 'ph-album-name body-strong ellipsis' }, a.name),
        h('div', { class: 'caption text-2' }, t('itemCount', { count })),
      );
      grid.appendChild(card);
    }
    this._setBody(h('div', { class: 'ph-albums-scroll' }, grid));
  }

  _pageAlbum(keepScroll) {
    const a = this.lib.album(this.route.id);
    if (!a) {
      this.navigate({ page: 'albums' }, { push: false });
      return;
    }
    const items = a.items.map((p) => this.lib.get(p)).filter(Boolean);
    const empty = this._empty('image_add', this.t('emptyAlbumTitle'), this.t('emptyAlbumBody'), this.h('button', { class: 'btn primary', onclick: () => this.startPick(a.id) }, this.icon('image_add'), this.t('addPhotos')));
    if (this.lib.scanning && !this.lib.scanned) {
      this._setHeader(a.name, null, []);
      this._setBody(this._loading());
      return;
    }
    this._setHeader(a.name, items.length, this._gridCmds(items, { album: a }));
    this._setBody(this.grid.el);
    this.grid.el.classList.remove('picking');
    this.grid.setData({ items, grouped: false, empty, keepScroll });
  }

  /** "Add photos" to an album: pick in the gallery with checkboxes. */
  startPick(albumId) {
    this.navigate({ page: 'gallery', pick: albumId });
    this.grid.setSelectMode(true);
    this._renderSelbar();
  }

  // ---------------------------------------------------------------- folders
  _pageFolders() {
    const { h, t } = this;
    const roots = this.lib.roots();
    if (!this.folderSel || !roots.some((r) => this.folderSel === r || this.folderSel.startsWith(`${r}/`))) this.folderSel = roots[0] || null;
    this.treeEl = h('div', { class: 'ph-tree', role: 'tree', 'aria-label': t('nav.folders') });
    this.subEl = h('div', { class: 'ph-subfolders' });
    const right = h('div', { class: 'ph-folder-main' }, this.subEl, this.grid.el);
    this._setBody(h('div', { class: 'ph-folders' }, this.treeEl, right));
    this._renderTree();
    if (!roots.length) {
      this._setHeader(t('nav.folders'), null, [this._cmd('folder_add', t('addFolder'), () => this.app.addFolder(), { id: 'add-folder' })]);
      this.grid.setData({ items: [], empty: this._empty('folder', t('noFoldersTitle'), t('noFoldersBody'), h('button', { class: 'btn primary', onclick: () => this.app.addFolder() }, this.icon('folder_add'), t('addFolder'))) });
      return;
    }
    this._loadFolder(this.folderSel);
  }

  async _loadFolder(dir, keepScroll = false) {
    if (!dir) return;
    if (this.route.page !== 'folders') return;
    this.folderSel = dir;
    const { t, h } = this;
    let res;
    try {
      res = await this.app.api.invoke('photos:folder', dir);
    } catch (err) {
      res = { items: [], dirs: [], error: this.app.errorText(err) };
    }
    if (this.route.page !== 'folders' || this.folderSel !== dir) return;
    const items = sortItems(res.items.map((it) => this.lib.get(it.path) || it));
    const isRoot = this.lib.folders.includes(dir);
    const cmds = this._gridCmds(items, { folder: true });
    cmds.push(this._cmd('folder_open', t('openInFiles'), () => this.app.shell.launch('files', { path: dir }), { id: 'open-folder', compact: true }));
    if (isRoot) cmds.push(this._cmd('folder_prohibited', t('removeFolder'), () => this.app.removeFolder(dir), { id: 'remove-folder', compact: true }));
    this._setHeader(this.folderLabel(dir), items.length, cmds);
    this.ui.clear(this.subEl);
    this.subEl.hidden = !res.dirs.length;
    for (const d of res.dirs) {
      this.subEl.appendChild(
        h('button', { class: 'ph-subfolder', 'data-tip': d.path, onclick: () => this._selectFolder(d.path) }, this.icon('folder', { filled: true, class: 'ph-folder-ic' }), h('span', { class: 'ellipsis' }, d.name)),
      );
    }
    this.grid.setData({
      items,
      grouped: true,
      keepScroll,
      empty: this._empty('folder', res.error ? t('folderError') : t('folderEmptyTitle'), res.error || (res.dirs.length ? t('folderEmptySub') : t('folderEmptyBody'))),
    });
    this._renderTree();
  }

  async _selectFolder(dir) {
    // Expand the tree down to the folder.
    const root = this.lib.rootOf(dir);
    let cur = root;
    const parts = dir.slice(root.length).split('/').filter(Boolean);
    const node = (p) => {
      if (!this.tree.has(p)) this.tree.set(p, { open: false, children: null });
      return this.tree.get(p);
    };
    node(cur).open = true;
    for (const part of parts.slice(0, -1)) {
      cur = `${cur}/${part}`;
      node(cur).open = true;
    }
    await this._loadFolder(dir);
  }

  async _ensureChildren(dir) {
    const n = this.tree.get(dir) || { open: false, children: null };
    this.tree.set(dir, n);
    if (!n.children) {
      try {
        n.children = (await this.app.api.invoke('photos:folder', dir)).dirs;
      } catch {
        n.children = [];
      }
    }
    return n;
  }

  async _renderTree() {
    const { h, t } = this;
    const el = this.treeEl;
    if (!el) return;
    const rows = [];
    const add = async (dir, depth, label, isRoot) => {
      const n = this.tree.get(dir) || { open: depth === 0 && dir === this.folderSel, children: null };
      this.tree.set(dir, n);
      if (n.open) await this._ensureChildren(dir);
      const hasKids = n.children ? n.children.length > 0 : true;
      const sel = dir === this.folderSel;
      const row = h(
        'div',
        {
          class: ['ph-tree-row', sel && 'selected'],
          role: 'treeitem',
          'aria-expanded': hasKids ? String(!!n.open) : undefined,
          'aria-selected': String(sel),
          tabindex: sel ? '0' : '-1',
          style: { paddingLeft: `${8 + depth * 16}px` },
          dataset: { path: dir },
          'data-tip': dir,
          onclick: () => this._selectFolder(dir),
          oncontextmenu: (e) => {
            e.preventDefault();
            this.ui.menu(e, [
              { label: t('openInFiles'), icon: 'folder_open', action: () => this.app.shell.launch('files', { path: dir }) },
              isRoot && this.lib.folders.includes(dir) ? { label: t('removeFolder'), icon: 'folder_prohibited', action: () => this.app.removeFolder(dir) } : null,
            ].filter(Boolean));
          },
        },
        h(
          'button',
          {
            class: ['ph-tree-twisty', !hasKids && 'invisible'],
            tabindex: '-1',
            'aria-label': n.open ? t('collapse') : t('expand'),
            onclick: async (e) => {
              e.stopPropagation();
              n.open = !n.open;
              this._renderTree();
            },
          },
          this.icon(n.open ? 'chevron_down' : 'chevron_right', { size: 12 }),
        ),
        this.icon(isRoot && dir === this.lib.pictures ? 'image' : 'folder', { filled: true, class: 'ph-folder-ic' }),
        h('span', { class: 'ellipsis' }, label),
      );
      rows.push(row);
      if (n.open && n.children) for (const c of n.children) await add(c.path, depth + 1, c.name, false);
    };
    for (const r of this.lib.roots()) await add(r, 0, this.folderLabel(r), true);
    if (!this.treeEl || this.treeEl !== el) return;
    const focused = el.contains(document.activeElement) ? document.activeElement?.dataset?.path : null;
    this.ui.clear(el);
    for (const r of rows) el.appendChild(r);
    el.appendChild(h('button', { class: 'btn subtle ph-tree-add', onclick: () => this.app.addFolder() }, this.icon('add'), t('addFolder')));
    if (focused) el.querySelector(`[data-path="${CSS.escape(focused)}"]`)?.focus();
    el.onkeydown = (e) => {
      const list = [...el.querySelectorAll('.ph-tree-row')];
      const i = list.indexOf(document.activeElement);
      if (i < 0) return;
      const row = list[i];
      const p = row.dataset.path;
      const n = this.tree.get(p);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        list[Math.max(0, Math.min(list.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
      } else if (e.key === 'ArrowRight' && n && !n.open) {
        e.preventDefault();
        n.open = true;
        this._renderTree();
      } else if (e.key === 'ArrowLeft' && n?.open) {
        e.preventDefault();
        n.open = false;
        this._renderTree();
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this._selectFolder(p);
      }
    };
  }

  // ---------------------------------------------------------------- settings
  _pageSettings() {
    const { h, t, ui } = this;
    const p = this.lib.prefs;
    this._setHeader(t('nav.settings'), null, []);
    const row = (ic, title, desc, control) =>
      h('div', { class: 'card-row ph-set-row' }, this.icon(ic, { size: 20 }), h('div', { class: 'grow' }, h('div', null, title), desc ? h('div', { class: 'caption text-2' }, desc) : null), control);
    const section = (title, ...rows) => h('section', { class: 'ph-set-section' }, h('h2', { class: 'body-strong ph-set-title' }, title), ...rows);
    const select = (key, opts) =>
      ui.select({ value: p[key], options: opts.map(([value, label]) => ({ value, label })), onchange: (v) => this.lib.setPref(key, typeof p[key] === 'number' ? Number(v) : v) });
    const toggle = (key) => ui.toggle({ checked: !!p[key], label: p[key] ? t('on') : t('off'), onchange: (v, e) => {
      this.lib.setPref(key, v);
      e.target.closest('.toggle').querySelector('.toggle-label').textContent = v ? t('on') : t('off');
    } });
    const quality = ui.slider({ min: 50, max: 100, step: 1, value: p.jpegQuality, style: { width: '160px' } });
    const qv = h('span', { class: 'ph-set-val' }, `${p.jpegQuality}`);
    quality.addEventListener('input', () => (qv.textContent = quality.value));
    quality.addEventListener('change', () => this.lib.setPref('jpegQuality', Number(quality.value)));

    const folderRows = this.lib.folders.map((f) =>
      h('div', { class: 'card-row ph-set-row ph-set-sub' }, this.icon('folder', { size: 20 }), h('div', { class: 'grow ellipsis selectable', 'data-tip': f }, f),
        h('button', { class: 'btn subtle icon-btn', 'aria-label': t('removeFolder'), 'data-tip': t('removeFolder'), onclick: () => this.app.removeFolder(f) }, this.icon('dismiss'))),
    );
    const page = h(
      'div',
      { class: 'ph-settings' },
      section(
        t('set.library'),
        row('image', t('set.pictures'), this.lib.pictures, toggle('includePictures')),
        ...folderRows,
        h('div', { class: 'card-row ph-set-row ph-set-sub' }, this.icon('folder_add', { size: 20 }), h('div', { class: 'grow' }, t('set.addFolderDesc')), h('button', { class: 'btn', onclick: () => this.app.addFolder() }, t('addFolder'))),
      ),
      section(
        t('set.gallery'),
        row('grid', t('thumbSize'), null, select('thumbSize', [['small', t('size.small')], ['medium', t('size.medium')], ['large', t('size.large')]])),
        row('layout_cell_four', t('layoutLabel'), null, select('layout', [['justified', t('layout.justified')], ['square', t('layout.square')]])),
      ),
      section(
        t('set.viewer'),
        row('dark_theme', t('set.viewerBg'), t('set.viewerBgDesc'), select('viewerBackground', [['dark', t('set.bgDark')], ['theme', t('set.bgTheme')]])),
        row('slide_multiple', t('set.filmstrip'), null, toggle('filmstrip')),
        row('delete', t('set.confirmDelete'), t('set.confirmDeleteDesc'), toggle('confirmDelete')),
      ),
      section(
        t('slideshow'),
        row('timer', t('set.interval'), null, select('slideshowInterval', [2, 3, 5, 10, 20, 30].map((s) => [s, t('seconds', { count: s })]))),
        row('slide_play', t('set.transition'), null, select('slideshowTransition', [['crossfade', t('set.crossfade')], ['kenburns', t('set.kenburns')]])),
        row('arrow_shuffle', t('set.shuffle'), null, toggle('slideshowShuffle')),
        row('arrow_repeat_all', t('set.loop'), null, toggle('slideshowLoop')),
      ),
      section(t('set.editing'), row('image_edit', t('set.jpegQuality'), t('set.jpegQualityDesc'), h('div', { class: 'row', style: { gap: '12px', alignItems: 'center' } }, quality, qv))),
      section(t('set.about'), h('div', { class: 'card-row ph-set-row' }, h('img', { src: this.app.ctx.appUrl('icon.svg'), width: 32, height: 32, alt: '' }), h('div', { class: 'grow' }, h('div', null, t('appName')), h('div', { class: 'caption text-2' }, t('set.version', { v: '1.0' }))))),
    );
    this._setBody(h('div', { class: 'ph-settings-scroll' }, page));
  }

  // ---------------------------------------------------------------- selection bar
  _renderSelbar() {
    this._keepFocus(() => this._renderSelbarNow());
  }

  _renderSelbarNow() {
    const { h, t } = this;
    const sel = this.grid.selectedItems();
    const on = this.grid.isSelecting() && this.route.page !== 'settings' && this.route.page !== 'albums';
    this.selbar.hidden = !on;
    this.cmds.hidden = on;
    this.head.classList.toggle('has-selection', on);
    if (!on) return;
    this.ui.clear(this.selbar);
    const n = sel.length;
    const paths = sel.map((x) => x.path);
    if (this.route.pick) {
      const a = this.lib.album(this.route.pick);
      this.selbar.append(
        h('span', { class: 'ph-selcount' }, t('selectedCount', { count: n })),
        h('div', { class: 'grow' }),
        h('button', { class: 'btn primary', disabled: !n, dataset: { cmd: 'pick-add' }, onclick: () => {
          const added = this.lib.addToAlbum(a.id, paths);
          this.app.toast(t('addedToAlbum', { count: added, album: a.name }));
          this.grid.setSelectMode(false);
          this.navigate({ page: 'album', id: a.id }, { push: false });
        } }, t('addToThisAlbum')),
        h('button', { class: 'btn', onclick: () => {
          this.grid.setSelectMode(false);
          this.navigate({ page: 'album', id: a.id }, { push: false });
        } }, t('common.cancel')),
      );
      return;
    }
    const allFav = n > 0 && paths.every((p) => this.lib.isFavorite(p));
    const album = this.route.page === 'album' ? this.lib.album(this.route.id) : null;
    const btns = [
      this._cmd(allFav ? 'heart_off' : 'heart', allFav ? t('unfavorite') : t('favorite'), () => this.lib.toggleFavorite(paths), { id: 'sel-fav', disabled: !n, compact: true }),
      this._cmd('album_add', t('addToAlbum'), (e) => this.app.albumMenu(e, paths), { id: 'sel-album', disabled: !n, compact: true }),
      this._cmd('copy', t('copy'), () => this.app.copyItems(sel), { id: 'sel-copy', disabled: !n, compact: true }),
      this._cmd('folder_open', t('showInFolder'), () => this.app.showInFolder(sel[0]), { id: 'sel-show', disabled: !n, compact: true }),
      album ? this._cmd('image_off', t('removeFromAlbum'), () => this.lib.removeFromAlbum(album.id, paths), { id: 'sel-remove', disabled: !n, compact: true }) : null,
      this._cmd('delete', t('delete'), () => this.app.deleteItems(sel), { id: 'sel-delete', disabled: !n, compact: true }),
    ].filter(Boolean);
    this.selbar.append(
      h('button', {
        class: 'btn subtle icon-btn',
        'aria-label': t('clearSelection'),
        'data-tip': t('clearSelection'),
        dataset: { cmd: 'sel-clear' },
        onclick: () => {
          this.grid.setSelectMode(false);
          this._renderSelbar();
        },
      }, this.icon('dismiss')),
      h('span', { class: 'ph-selcount' }, t('selectedCount', { count: n })),
      h('button', { class: 'btn subtle', dataset: { cmd: 'sel-all' }, onclick: () => this.grid.selectAll() }, t('selectAll')),
      h('div', { class: 'grow' }),
      ...btns,
    );
  }

  folderOf(item) {
    return dirName(item.path);
  }

  /** Display name of a folder (the Pictures library folder is shown under its translated name). */
  folderLabel(dir) {
    return dir === this.lib.pictures ? this.t('pictures') : baseName(dir);
  }
}
