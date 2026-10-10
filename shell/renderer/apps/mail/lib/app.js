// The main Mail window: navigation pane (accounts + folders), message list, reading pane /
// inline composer, titlebar search, keyboard shortcuts and responsive layout.
import { store } from './store.js';
import { MessageList, DRAG_MIME } from './list.js';
import { Reader } from './reader.js';
import { Composer } from './compose.js';
import { AccountSetup } from './setup.js';
import { openSettings } from './settings.js';
import { MailWindowBase, trapFocus, guardDialog } from './base.js';
import { avatarColor, initials, parseAddresses, parseMailto, debounce, keyName } from './util.js';

const FOLDER_ICONS = { inbox: 'mail_inbox', drafts: 'drafts', sent: 'send', archive: 'archive', junk: 'mail_prohibited', trash: 'delete', all: 'mail_multiple', flagged: 'flag', important: 'star' };

export class MailApp extends MailWindowBase {
  constructor(ctx) {
    super(ctx);
    this.account = null;
    this.folder = null;
    this.folders = new Map(); // accountId -> { tree, special }
    this.searchText = '';
    this.filter = '';
    this.composer = null;
    this.openSeq = 0;
    this.offs = [];
    const { h } = ctx;
    this.root = h('div', { class: 'ml-root', 'data-layout': 'wide' });
    ctx.win.body.appendChild(this.root);
    this.focusTrap = trapFocus(ctx.win);
    ctx.win.el.addEventListener('ml-focus-lost', () => this.focusList());
    ctx.win.el.__mail = this; // test / debugging hook
  }

  async init() {
    const { api, win } = this.ctx;
    await store.init(this.ctx);
    this.offs.push(store.on('accounts', () => this.onAccountsChanged()));
    this.offs.push(store.on('changed', (ev) => this.onChanged(ev))); // from message windows
    this.offs.push(api.on('mail:changed', (ev) => this.onChanged(ev)));
    this.offs.push(api.on('mail:status', (ev) => this.onStatus(ev)));
    this.ctx.onClose(() => this.destroy());
    win.onBeforeClose(async () => (this.composer ? this.composer.close() : true));
    this.ctx.onLangChange(() => this.relocalize());
    if (!store.accounts.length) this.showSetup('first');
    else await this.showMain();
    api.invoke('mail:watch', true).catch(() => {});
    // Folders other than the inbox have no push: refresh what is on screen every few minutes.
    const timer = setInterval(() => {
      if (this.list && !this.composer && !win.minimized && document.visibilityState !== 'hidden') this.refresh().catch(() => {});
    }, 5 * 60 * 1000);
    this.offs.push(() => clearInterval(timer));
  }

  destroy() {
    for (const off of this.offs) off?.();
    this.offs = [];
    this.resizeObs?.disconnect();
    this.reader?.destroy();
    this.composer?.cleanup();
    // Keep the IDLE watchers for new-mail notifications unless they are turned off.
    if (store.prefs.notifications === false) this.ctx.api.invoke('mail:watch', false).catch(() => {});
  }

  // ------------------------------------------------------------ first run / setup
  showSetup(mode = 'first') {
    const { h, ui, win } = this.ctx;
    this.resizeObs?.disconnect();
    this.resizeObs = null;
    win.el.classList.remove('ml-narrow');
    this.list = null;
    this.nav = null;
    ui.clear(this.root);
    ui.clear(win.titlebarSlot);
    this.root.className = 'ml-root setup';
    win.setTitle(this.t('appName'));
    const setup = (this.setup = new AccountSetup(this.ctx, {
      mode,
      onDone: async (account) => {
        store.setPref('lastAccount', account.id);
        await this.showMain(account.id);
        // A message requested by another app before any account existed (mailto: link…)
        if (this.pendingCompose) {
          const pre = this.pendingCompose;
          this.pendingCompose = null;
          await this.newMessage({ to: parseAddresses(pre.to), cc: parseAddresses(pre.cc), bcc: parseAddresses(pre.bcc), subject: pre.subject, body: pre.body });
        }
      },
      onCancel: () => this.showMain(),
    }));
    this.root.appendChild(h('div', { class: 'ml-setup-page' }, setup.el));
  }

  // ------------------------------------------------------------ main layout
  async showMain(accountId) {
    const { h, ui } = this.ctx;
    if (!store.accounts.length) return this.showSetup('first');
    this.setup = null;
    ui.clear(this.root);
    this.root.className = 'ml-root';
    this.nav = h('nav', { class: 'ml-nav', 'aria-label': this.t('nav.label') });
    this.list = new MessageList(this.ctx, this);
    this.reader?.destroy(); // coming back from the setup screen: drop the old pane's listeners
    this.reader = new Reader(this.ctx, this);
    this.readerHost = h('div', { class: 'ml-readpane' }, this.reader.el);
    this.splitter = h('div', { class: 'ml-splitter', role: 'separator', 'aria-orientation': 'vertical', tabindex: '-1' });
    this.main = h('div', { class: 'ml-main' }, this.list.el, this.splitter, this.readerHost);
    this.scrim = h('div', { class: 'ml-scrim', onclick: () => this.toggleNav(false) });
    this.snack = h('div', { class: 'ml-snack-host', 'aria-live': 'polite' });
    this.offline = h('div', { class: 'ml-offline', hidden: true });
    this.root.append(this.nav, this.main, this.scrim, this.snack);
    this.list.head.after(this.offline);
    this.list.el.style.setProperty('--list-w', `${store.prefs.listWidth || 380}px`);
    this.buildSearch();
    this.wireSplitter();
    this.wireKeys();
    this.navSig = null;
    this.resizeObs?.disconnect();
    this.resizeObs = new ResizeObserver(() => this.layout());
    this.resizeObs.observe(this.root);
    this.layout();
    const acc = store.account(accountId) || store.account(store.prefs.lastAccount) || store.accounts[0];
    await this.switchAccount(acc.id);
  }

  layout() {
    const w = this.root.clientWidth;
    const mode = w >= 1060 ? 'wide' : w >= 700 ? 'medium' : 'narrow';
    if (this.root.dataset.layout !== mode) {
      this.root.dataset.layout = mode;
      this.navOverlay = false;
      this.root.classList.remove('nav-open');
    }
    const collapsed = mode !== 'wide' || store.prefs.navCollapsed;
    this.root.classList.toggle('nav-collapsed', collapsed);
    // Small windows: the title bar keeps its room for the search box.
    this.ctx.win.el.classList.toggle('ml-narrow', mode === 'narrow');
  }

  toggleNav(force) {
    const mode = this.root.dataset.layout;
    if (mode === 'wide' && force === undefined) {
      store.setPref('navCollapsed', !store.prefs.navCollapsed);
      this.layout();
      return;
    }
    const open = force ?? !this.root.classList.contains('nav-open');
    this.root.classList.toggle('nav-open', open);
    if (open) setTimeout(() => this.nav.querySelector('.ml-folder.selected, .ml-folder')?.focus(), 50);
  }

  buildSearch() {
    const { h, icon, ui, win } = this.ctx;
    const t = (k, v) => this.t(k, v);
    ui.clear(win.titlebarSlot);
    this.searchInput = h('input', { class: 'ml-search-input', type: 'search', name: 'search', placeholder: t('search.placeholder'), 'aria-label': t('search.placeholder'), spellcheck: false });
    this.searchClear = h('button', { class: 'ml-search-clear', type: 'button', 'aria-label': t('search.clear'), hidden: true, onclick: () => this.clearSearch(true) }, icon('dismiss', { size: 12 }));
    const box = h('div', { class: 'ml-search', role: 'search' }, icon('search', { size: 14, class: 'ml-search-icon' }), this.searchInput, this.searchClear);
    this.searchInput.addEventListener('input', () => (this.searchClear.hidden = !this.searchInput.value));
    this.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.search(this.searchInput.value);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (this.searchInput.value || this.searchText) this.clearSearch(false);
        else this.list.scroller.focus();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.list.scroller.focus();
      }
    });
    win.titlebarSlot.appendChild(h('div', { class: 'ml-search-slot' }, box));
  }

  wireSplitter() {
    const sp = this.splitter;
    sp.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      sp.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const start = this.list.el.getBoundingClientRect().width;
      this.root.classList.add('resizing');
      const move = (ev) => {
        const max = Math.max(300, this.main.clientWidth - 360);
        const w = Math.max(280, Math.min(max, start + ev.clientX - startX));
        this.list.el.style.setProperty('--list-w', `${Math.round(w)}px`);
      };
      const up = () => {
        sp.removeEventListener('pointermove', move);
        sp.removeEventListener('pointerup', up);
        this.root.classList.remove('resizing');
        store.setPref('listWidth', Math.round(this.list.el.getBoundingClientRect().width));
      };
      sp.addEventListener('pointermove', move);
      sp.addEventListener('pointerup', up);
    });
    sp.addEventListener('dblclick', () => {
      this.list.el.style.setProperty('--list-w', '380px');
      store.setPref('listWidth', 380);
    });
  }

  // ------------------------------------------------------------ accounts & folders
  async switchAccount(id) {
    const acc = store.account(id);
    if (!acc) return;
    this.account = acc;
    store.setPref('lastAccount', id);
    this.searchText = '';
    this.filter = '';
    if (this.searchInput) {
      this.searchInput.value = '';
      this.searchClear.hidden = true;
    }
    this.renderNav();
    this.list.setHeader(this.t('folder.inbox'), 'inbox');
    this.list.renderSkeleton();
    this.reader.showEmpty();
    this.lastUndo = null;
    // The offline / wrong-password bar belongs to the previous account.
    this.onStatus({ accountId: id, online: true });
    this.ctx.api
      .invoke('mail:status')
      .then((all) => all?.[id] && this.onStatus({ accountId: id, ...all[id] }))
      .catch(() => {});
    let data = null;
    try {
      data = await this.loadFolders();
    } catch (e) {
      this.list.error = e;
      this.list.messages = [];
      this.list.render();
      this.renderNav();
      return;
    }
    const last = store.prefs.lastFolder?.[id];
    const exists = (path) => {
      const walk = (arr) => arr.some((n) => n.path === path || walk(n.children));
      return walk(data.tree);
    };
    await this.openFolder(last && exists(last) ? last : data.special.inbox || 'INBOX');
  }

  async loadFolders() {
    const acc = this.account;
    const data = await this.ctx.api.invoke('mail:folders', acc.id);
    if (this.account !== acc) return data;
    this.folders.set(acc.id, data);
    this.renderNav();
    return data;
  }

  refreshFolders = debounce(() => this.loadFolders().catch(() => {}), 400);

  folderData() {
    return this.folders.get(this.account?.id) || { tree: [], special: {} };
  }

  findFolder(path) {
    let hit = null;
    const walk = (arr) => {
      for (const n of arr) {
        if (n.path === path) hit = n;
        else walk(n.children);
        if (hit) return;
      }
    };
    walk(this.folderData().tree);
    return hit;
  }

  folderSpecial(path = this.folder) {
    const sp = this.folderData().special;
    for (const [k, v] of Object.entries(sp)) if (v === path) return k;
    return path && path.toUpperCase() === 'INBOX' ? 'inbox' : null;
  }

  folderName(node) {
    if (!node) return '';
    if (node.special && FOLDER_ICONS[node.special]) {
      const label = this.t(`folder.${node.special}`);
      if (label !== `folder.${node.special}`) return label;
    }
    return node.name;
  }

  async openFolder(path) {
    if (!path) return;
    this.folder = path;
    const prev = { ...(store.prefs.lastFolder || {}) };
    prev[this.account.id] = path;
    store.setPref('lastFolder', prev);
    const node = this.findFolder(path);
    const name = node ? this.folderName(node) : path;
    this.list.setHeader(name, this.folderSpecial(path));
    this.ctx.win.setTitle(`${name} - ${this.account.email} - ${this.t('appName')}`);
    this.searchInput.placeholder = this.t('search.placeholderIn', { folder: name });
    this.paintNavSelection();
    this.root.classList.remove('show-reader');
    if (this.root.classList.contains('nav-open')) this.toggleNav(false);
    if (!this.composer) this.reader.showEmpty();
    await this.list.load({ reset: true });
  }

  renderNav() {
    const { h, icon, ui } = this.ctx;
    const t = (k, v) => this.t(k, v);
    const nav = this.nav;
    if (!nav) return;
    // Only rebuild when something visible changed (folder counts refresh often).
    const sig = JSON.stringify([this.account?.id, this.account?.name, this.account?.email, this.ctx.lang, this.folderData().tree, store.prefs.collapsed]);
    if (sig === this.navSig && nav.firstChild) {
      this.paintNavSelection();
      return;
    }
    this.navSig = sig;
    const focusedPath = nav.contains(document.activeElement) ? document.activeElement.closest?.('.ml-folder')?.dataset.path : null;
    const keepScroll = nav.querySelector('.ml-folders')?.scrollTop || 0;
    ui.clear(nav);
    const acc = this.account;
    const p = store.preset(acc?.provider);
    const hamburger = h('button', { class: 'btn subtle icon-btn ml-hamburger', name: 'nav-toggle', 'aria-label': t('nav.toggle'), 'data-tip': t('nav.toggle'), onclick: () => this.toggleNav() }, icon('navigation'));
    const compose = h('button', { class: 'btn primary ml-newmail', name: 'new-mail', 'data-tip': `${t('nav.newMail')} (Ctrl+N)`, onclick: () => this.newMessage() }, icon('compose'), h('span', { class: 'label' }, t('nav.newMail')));
    const acctBtn = h(
      'button',
      { class: 'ml-account', name: 'account', 'aria-haspopup': 'menu', onclick: (e) => this.accountMenu(e) },
      h('span', { class: 'ml-avatar', style: { background: acc ? avatarColor(acc.email) : '#888' } }, acc ? initials(acc.name, acc.email) : '?'),
      h('span', { class: 'ml-account-text label' }, h('span', { class: 'body-strong ellipsis' }, acc?.name || acc?.email || ''), h('span', { class: 'caption text-2 ellipsis' }, acc?.email || '')),
      h('span', { class: 'label ml-account-chev' }, icon('chevron_down', { size: 12 })),
    );
    acctBtn.title = acc ? `${acc.email} (${p.name})` : '';
    const data = this.folderData();
    const folders = h('div', { class: 'ml-folders', role: 'tree', 'aria-label': t('nav.folders') });
    // Special folders come first in a fixed order wherever they live in the tree (INBOX.Sent,
    // [Gmail]/Trash…); everything else follows under "Folders".
    const TOP = ['inbox', 'drafts', 'sent', 'archive', 'junk', 'trash'];
    const top = new Map();
    const walk = (arr) => {
      for (const n of arr) {
        if (n.special && TOP.includes(n.special) && !top.has(n.special)) top.set(n.special, n);
        walk(n.children);
      }
    };
    walk(data.tree);
    const specialNodes = TOP.filter((k) => top.has(k)).map((k) => top.get(k));
    const exclude = new Set(specialNodes);
    const otherNodes = data.tree.filter((n) => !exclude.has(n));
    for (const n of specialNodes) this.appendTree(folders, n, 0, exclude);
    if (otherNodes.length) {
      const collapsed = !!store.prefs.collapsed?.[`${acc.id}:__more`];
      const head = h('button', { class: ['ml-folder-section', collapsed && 'collapsed'], name: 'more-folders', 'aria-expanded': String(!collapsed) }, icon('chevron_down', { size: 12, class: 'chev' }), h('span', { class: 'label' }, t('nav.moreFolders')));
      const box = h('div', { class: 'ml-folder-group', hidden: collapsed });
      head.addEventListener('click', () => {
        const c = !box.hidden;
        box.hidden = c;
        head.classList.toggle('collapsed', c);
        head.setAttribute('aria-expanded', String(!c));
        store.setPref('collapsed', { ...(store.prefs.collapsed || {}), [`${acc.id}:__more`]: c });
      });
      for (const n of otherNodes) this.appendTree(box, n, 0, exclude);
      folders.append(head, box);
    }
    if (!data.tree.length) folders.appendChild(h('div', { class: 'caption text-2 ml-folders-empty' }, t('nav.noFolders')));
    const settingsBtn = h('button', { class: 'nav-item ml-navbtn', name: 'settings', 'data-tip': t('nav.settings'), onclick: () => this.openSettings() }, icon('settings'), h('span', { class: 'label' }, t('nav.settings')));
    nav.append(h('div', { class: 'ml-nav-top' }, hamburger), h('div', { class: 'ml-nav-compose' }, compose), acctBtn, folders, h('div', { class: 'ml-nav-bottom' }, settingsBtn));
    folders.scrollTop = keepScroll;
    this.paintNavSelection();
    if (focusedPath) [...nav.querySelectorAll('.ml-folder')].find((el) => el.dataset.path === focusedPath)?.focus({ preventScroll: true });
  }

  appendTree(parent, node, depth, exclude = new Set()) {
    const { h } = this.ctx;
    const kids = node.children.filter((c) => !exclude.has(c));
    const row = this.folderRow(node, depth, kids.length > 0);
    parent.appendChild(row);
    if (kids.length) {
      const key = `${this.account.id}:${node.path}`;
      const collapsed = !!store.prefs.collapsed?.[key];
      const box = h('div', { class: 'ml-folder-group', role: 'group', hidden: collapsed });
      for (const c of kids) this.appendTree(box, c, depth + 1, exclude);
      parent.appendChild(box);
      row.setAttribute('aria-expanded', String(!collapsed));
      row.querySelector('.ml-twisty')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const c = !box.hidden;
        box.hidden = c;
        row.setAttribute('aria-expanded', String(!c));
        row.classList.toggle('collapsed', c);
        store.setPref('collapsed', { ...(store.prefs.collapsed || {}), [key]: c });
      });
      row.classList.toggle('collapsed', collapsed);
    }
  }

  folderRow(node, depth, hasKids = node.children.length > 0) {
    const { h, icon } = this.ctx;
    const t = (k, v) => this.t(k, v);
    const ic = FOLDER_ICONS[node.special] || 'folder';
    const name = this.folderName(node);
    const count = node.special === 'drafts' ? node.total : node.special === 'sent' || node.special === 'trash' || node.special === 'archive' ? 0 : node.unseen;
    const row = h(
      'div',
      {
        class: ['nav-item', 'ml-folder', node.noselect && 'noselect', node.special && `sp-${node.special}`],
        role: 'treeitem',
        tabindex: '0',
        dataset: { path: node.path },
        title: node.special ? name : node.path.split(node.delimiter || '/').join(' › '),
        style: { paddingLeft: `${12 + depth * 16}px` },
      },
      hasKids ? h('span', { class: 'ml-twisty', role: 'button', 'aria-label': t('nav.expand') }, icon('chevron_down', { size: 10 })) : depth ? h('span', { class: 'ml-twisty-space' }) : null,
      icon(ic, { size: 18 }),
      h('span', { class: 'label ellipsis grow' }, name),
      count ? h('span', { class: ['ml-count', node.special === 'drafts' && 'muted'], 'aria-label': t('nav.unread', { count }) }, String(count)) : null,
      count && node.special !== 'drafts' ? h('span', { class: 'ml-rail-dot' }) : null,
    );
    if (!node.noselect) {
      row.addEventListener('click', () => this.openFolder(node.path));
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this.openFolder(node.path);
        } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
          e.preventDefault();
          const all = [...this.nav.querySelectorAll('.ml-folder:not(.noselect)')].filter((x) => x.offsetParent);
          const i = all.indexOf(row);
          const next = e.key === 'Home' ? all[0] : e.key === 'End' ? all[all.length - 1] : all[i + (e.key === 'ArrowDown' ? 1 : -1)];
          next?.focus();
        } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && row.hasAttribute('aria-expanded')) {
          // Collapse / expand a folder with subfolders, like a tree view.
          const open = row.getAttribute('aria-expanded') === 'true';
          if (open === (e.key === 'ArrowLeft')) {
            e.preventDefault();
            row.querySelector('.ml-twisty')?.click();
          }
        }
      });
      row.addEventListener('contextmenu', (e) => this.folderMenu(e, node));
      // Drop messages on a folder to move them.
      row.addEventListener('dragover', (e) => {
        if (![...(e.dataTransfer?.types || [])].includes(DRAG_MIME) || node.path === this.folder) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        row.classList.add('drop');
      });
      row.addEventListener('dragleave', () => row.classList.remove('drop'));
      row.addEventListener('drop', (e) => {
        row.classList.remove('drop');
        try {
          const d = JSON.parse(e.dataTransfer.getData(DRAG_MIME));
          e.preventDefault();
          if (d.accountId === this.account.id && d.folder === this.folder) this.moveTo(node.path, d.uids);
        } catch {}
      });
    }
    return row;
  }

  paintNavSelection() {
    if (!this.nav) return;
    // The folder tree is one Tab stop (the selected folder); arrows move inside it.
    const rows = [...this.nav.querySelectorAll('.ml-folder')];
    const sel = rows.find((el) => el.dataset.path === this.folder) || rows.find((el) => !el.classList.contains('noselect'));
    for (const el of rows) {
      const on = el.dataset.path === this.folder;
      el.classList.toggle('selected', on);
      el.setAttribute('aria-selected', String(on));
      el.tabIndex = el === sel ? 0 : -1;
    }
  }

  async folderMenu(e, node) {
    const { ui, api } = this.ctx;
    const t = (k, v) => this.t(k, v);
    await ui.menu(e, [
      { label: t('nav.open'), icon: 'folder_open', action: () => this.openFolder(node.path) },
      { label: t('nav.markAllRead'), icon: 'mail_all_read', action: () => this.markAllRead(node.path) },
      ['trash', 'junk'].includes(node.special)
        ? {
            label: t('nav.emptyFolder'),
            icon: 'delete_dismiss',
            disabled: !node.total,
            danger: true,
            action: async () => {
              if (!(await ui.confirm(t('nav.emptyConfirm', { folder: this.folderName(node) }), { title: t('nav.emptyFolder'), okLabel: t('nav.emptyOk'), danger: true, parent: this.ctx.win }))) return;
              try {
                await api.invoke('mail:emptyFolder', this.account.id, node.path);
                if (node.path === this.folder) this.list.load({ reset: true });
                this.refreshFolders();
              } catch (err) {
                this.alertError(err);
              }
            },
          }
        : null,
      '-',
      { label: t('list.refresh'), icon: 'arrow_sync', action: () => this.refresh() },
    ].filter(Boolean));
  }

  async markAllRead(path) {
    try {
      await this.ctx.api.invoke('mail:markAllRead', this.account.id, path);
      if (path === this.folder) this.list.update(this.list.messages.map((m) => m.uid), { seen: true });
      this.refreshFolders();
    } catch (e) {
      this.alertError(e);
    }
  }

  async accountMenu(e) {
    const { ui } = this.ctx;
    const t = (k, v) => this.t(k, v);
    await ui.menu(e, [
      { header: t('nav.accounts') },
      ...store.accounts.map((a) => ({ label: a.name ? `${a.name} — ${a.email}` : a.email, checked: a.id === this.account.id, action: () => a.id !== this.account.id && this.switchAccount(a.id) })),
      '-',
      { label: t('nav.addAccount'), icon: 'person_add', action: () => this.addAccount() },
      { label: t('nav.manageAccounts'), icon: 'settings', action: () => this.openSettings('accounts') },
    ]);
  }

  async addAccount() {
    const { h, ui } = this.ctx;
    let done = null;
    const setup = new AccountSetup(this.ctx, {
      mode: 'add',
      onDone: (account) => done?.(account),
      onCancel: () => done?.(null),
    });
    const res = await ui.dialog({
      body: h('div', { class: 'ml-setup-dialog-body' }, setup.el),
      parent: this.ctx.win,
      className: 'ml-setup-dialog',
      buttons: [],
      onOpen: (dlg, close) => {
        done = (v) => close(v || null);
      },
    });
    if (res?.id) await this.switchAccount(res.id);
  }

  async editAccount(account) {
    await openSettings(this.ctx, this, 'accounts', account?.id);
  }

  async openSettings(section) {
    await openSettings(this.ctx, this, section);
    this.focusList();
  }

  onAccountsChanged() {
    if (!this.nav) return;
    if (!store.accounts.length) {
      this.account = null;
      this.showSetup('first');
      return;
    }
    const cur = this.account && store.account(this.account.id);
    if (!cur) this.switchAccount(store.accounts[0].id);
    else {
      this.account = cur;
      this.renderNav();
    }
  }

  // ------------------------------------------------------------ events from the backend
  onChanged(ev) {
    if (!this.account || ev.accountId !== this.account.id) return;
    this.refreshFolders();
    if (ev.folder === this.folder || (ev.folder === 'INBOX' && this.folderSpecial() === 'inbox')) this.softRefresh();
  }

  softRefresh = debounce(() => this.list && this.list.load({ soft: true }), 250);

  onNewMail(ev) {
    if (!this.account || ev.accountId !== this.account.id) return;
    this.refreshFolders();
    if (this.folderSpecial() === 'inbox') this.softRefresh();
  }

  onStatus(ev) {
    if (!this.account || ev.accountId !== this.account.id || !this.offline) return;
    const { h, icon, ui } = this.ctx;
    ui.clear(this.offline);
    this.offline.hidden = ev.online;
    this.offline.dataset.code = ev.online ? '' : ev.code || '';
    if (!ev.online && ['ECONN', 'ETIMEOUT'].includes(this.list?.error?.code || '')) ui.clear(this.list.banner);
    if (!ev.online && this.list?.banner?.querySelector('.infobar.error')) ui.clear(this.list.banner);
    if (!ev.online) {
      this.offline.append(
        h(
          'div',
          { class: 'infobar warning' },
          icon('cloud_dismiss'),
          h('div', { class: 'grow' }, ev.code === 'EAUTH' ? this.t('status.authFailed') : this.t('status.offline')),
          ev.code === 'EAUTH' ? h('button', { class: 'btn small', onclick: () => this.editAccount(this.account) }, this.t('list.fixAccount')) : h('button', { class: 'btn small', onclick: () => this.refresh() }, this.t('list.retry')),
        ),
      );
    }
  }

  onListLoaded() {
    // Keep the reading pane in sync when the open message disappeared (moved elsewhere).
    const open = this.reader?.msg;
    if (open && open.accountId === this.account.id && open.folder === this.folder && !this.list.byUid(open.uid) && !this.composer) this.reader.showEmpty();
  }

  async refresh() {
    if (!this.account || !this.list) return;
    if (!this.folder) return this.switchAccount(this.account.id); // the first load failed
    this.refreshFolders();
    await this.list.load({ soft: true });
  }

  // ------------------------------------------------------------ search
  search(q) {
    const text = String(q || '').trim();
    if (!text) return this.clearSearch(false);
    this.searchText = text;
    this.searchClear.hidden = false;
    this.reader.msg && !this.composer && this.reader.showEmpty();
    this.list.load({ reset: true });
  }

  clearSearch(focus = false) {
    const had = this.searchText || this.filter;
    this.searchInput.value = '';
    this.searchClear.hidden = true;
    this.searchText = '';
    this.filter = '';
    this.list.updateCount();
    if (had) this.list.load({ reset: true });
    if (focus) this.searchInput.focus();
  }

  setFilter(f) {
    this.filter = f;
    this.list.updateCount();
    this.list.load({ reset: true });
  }

  // ------------------------------------------------------------ selection & reading
  onSelection(open) {
    const uids = this.list.selectedUids;
    if (uids.length !== 1 || !open) this.openSeq++; // cancel a message still loading
    if (uids.length > 1) {
      if (!this.composer) this.reader.showMulti(uids.length);
      return;
    }
    if (uids.length === 1 && open) this.openMessage(uids[0]);
    else if (!uids.length && !this.composer) this.reader.showEmpty();
  }

  clearSelection() {
    this.list.clearSelection();
    this.reader.showEmpty();
  }

  async openMessage(uid) {
    if (this.composer) {
      if (!(await this.closeComposer())) return;
    }
    const summary = this.list.byUid(uid);
    if (!summary) return;
    const seq = ++this.openSeq;
    const acc = this.account;
    const folder = this.folder;
    if (this.folderSpecial() === 'drafts' || summary.draft) return this.openDraft(summary);
    this.reader.showLoading(summary);
    this.root.classList.add('show-reader');
    clearTimeout(this.openTimer);
    await new Promise((r) => (this.openTimer = setTimeout(r, 60)));
    if (seq !== this.openSeq) return;
    try {
      const msg = await this.ctx.api.invoke('mail:message', acc.id, folder, uid);
      if (seq !== this.openSeq || this.account !== acc || this.folder !== folder) return;
      this.reader.showMessage(msg);
      store.addContacts(msg.from);
      if (!summary.seen) {
        summary.seen = true;
        this.list.update(uid, { seen: true });
        this.bumpUnread(folder, -1);
      }
    } catch (e) {
      if (seq !== this.openSeq) return;
      if (e.code === 'ENOMSG') {
        this.list.remove([uid]);
        this.reader.showEmpty();
        this.snackbar(this.t('reader.gone'));
        return;
      }
      this.reader.showError(e, () => this.openMessage(uid));
    }
  }

  async openDraft(summary) {
    try {
      const msg = await this.ctx.api.invoke('mail:message', this.account.id, this.folder, summary.uid, { markSeen: false });
      await this.openComposer({
        mode: 'draft',
        to: msg.to,
        cc: msg.cc,
        bcc: msg.bcc,
        subject: msg.subject,
        html: msg.html,
        body: msg.html ? null : msg.text,
        cids: msg.inlineCids,
        draft: { folder: this.folder, uid: summary.uid },
        inReplyTo: msg.inReplyTo,
        references: msg.references,
      });
    } catch (e) {
      this.reader.showError(e);
    }
  }

  bumpUnread(path, delta) {
    const node = this.findFolder(path);
    if (!node) return;
    node.unseen = Math.max(0, (node.unseen || 0) + delta);
    this.renderNav();
  }

  backToList() {
    this.root.classList.remove('show-reader');
    setTimeout(() => this.list.scroller.focus(), 50);
  }

  focusReader() {
    this.reader.frame?.focus();
  }

  currentUids() {
    const sel = this.list?.selectedUids || [];
    if (sel.length) return sel;
    const m = this.reader?.msg;
    return m && m.folder === this.folder ? [m.uid] : [];
  }

  // ------------------------------------------------------------ actions
  async setFlags(uids, patch) {
    if (!uids.length) return;
    const { api } = this.ctx;
    const before = uids.map((u) => ({ uid: u, ...(this.list.byUid(u) ? { seen: this.list.byUid(u).seen, flagged: this.list.byUid(u).flagged } : {}) }));
    let unreadDelta = 0;
    if (patch.seen !== undefined) for (const b of before) if (b.seen !== undefined && b.seen !== patch.seen) unreadDelta += patch.seen ? -1 : 1;
    this.list.update(uids, patch);
    if (this.reader.msg && uids.includes(this.reader.msg.uid) && this.reader.msg.folder === this.folder) this.reader.updateFlags(patch);
    if (unreadDelta) this.bumpUnread(this.folder, unreadDelta);
    try {
      await api.invoke('mail:setFlags', this.account.id, this.folder, uids, patch);
    } catch (e) {
      for (const b of before) this.list.update([b.uid], { seen: b.seen, flagged: b.flagged });
      if (unreadDelta) this.bumpUnread(this.folder, -unreadDelta);
      this.alertError(e);
    }
  }

  setSelectedFlags(patch) {
    return this.setFlags(this.currentUids(), patch);
  }

  toggleFlagSelected() {
    const uids = this.currentUids();
    if (!uids.length) return;
    const allFlagged = uids.every((u) => this.list.byUid(u)?.flagged);
    return this.setFlags(uids, { flagged: !allFlagged });
  }

  // Remove messages from the list optimistically and select the next one.
  async removeAndRun(uids, op, doneText) {
    const snap = this.list.snapshot();
    const wasOpen = this.reader.msg && uids.includes(this.reader.msg.uid);
    const idx = this.list.remove(uids);
    const unread = snap.messages.filter((m) => uids.includes(m.uid) && !m.seen).length;
    if (unread) this.bumpUnread(this.folder, -unread);
    const next = this.list.messages[Math.min(Math.max(0, idx), this.list.messages.length - 1)];
    if (wasOpen || this.list.selected.size === 0) {
      if (next && this.root.dataset.layout !== 'narrow') this.list.select(next.uid, { open: true });
      else {
        this.reader.showEmpty();
        this.root.classList.remove('show-reader');
      }
    }
    try {
      const res = await op();
      const undo = this.undoFor(res);
      if (doneText) this.snackbar(typeof doneText === 'function' ? doneText(res) : doneText, undo ? { label: this.t('snack.undo'), action: undo } : null);
      this.refreshFolders();
      return res;
    } catch (e) {
      this.list.restore(snap);
      if (unread) this.bumpUnread(this.folder, unread);
      this.alertError(e);
      return null;
    }
  }

  // "Undo" for a move / archive / delete to Trash: move the messages back (the server told us their
  // new UIDs). Also reachable with Ctrl+Z while the snackbar is the last action.
  undoFor(res) {
    if (!res?.folder || !Array.isArray(res.uids) || !res.uids.length) return null;
    const acc = this.account;
    const from = this.folder;
    const run = async () => {
      if (this.lastUndo === run) this.lastUndo = null;
      try {
        await this.ctx.api.invoke('mail:move', acc.id, res.folder, res.uids, from);
        if (this.account === acc && this.folder === from) await this.list.load({ soft: true });
        this.refreshFolders();
        this.snackbar(this.t('snack.undone'));
      } catch (e) {
        this.alertError(e);
      }
    };
    this.lastUndo = run;
    return run;
  }

  async deleteMessages(uids) {
    if (!uids.length) return;
    const { ui, api } = this.ctx;
    const t = (k, v) => this.t(k, v);
    const sp = this.folderData().special;
    const permanent = !sp.trash || sp.trash === this.folder;
    if (permanent && !(await ui.confirm(t('act.deleteForeverConfirm', { count: uids.length }), { title: t('act.deleteForever'), okLabel: t('act.delete'), danger: true, parent: this.ctx.win }))) return;
    await this.removeAndRun(uids, () => api.invoke('mail:delete', this.account.id, this.folder, uids), (res) => (res?.permanent ? t('snack.deletedForever', { count: uids.length }) : t('snack.deleted', { count: uids.length })));
  }

  deleteSelected() {
    return this.deleteMessages(this.currentUids());
  }

  async archiveSelected() {
    const uids = this.currentUids();
    if (!uids.length || this.folderSpecial() === 'archive') return;
    await this.removeAndRun(uids, () => this.ctx.api.invoke('mail:archive', this.account.id, this.folder, uids), this.t('snack.archived', { count: uids.length }));
  }

  async moveTo(dest, uids = this.currentUids()) {
    if (!uids.length || !dest || dest === this.folder) return;
    const node = this.findFolder(dest);
    await this.removeAndRun(uids, () => this.ctx.api.invoke('mail:move', this.account.id, this.folder, uids, dest), this.t('snack.moved', { count: uids.length, folder: this.folderName(node) || dest }));
  }

  async moveToSpecial(kind) {
    const sp = this.folderData().special;
    let dest = sp[kind];
    if (!dest && kind === 'junk') dest = null;
    if (!dest) {
      this.alertError(Object.assign(new Error(this.t('act.noFolder')), { code: 'EINVAL' }));
      return;
    }
    return this.moveTo(dest);
  }

  async moveMenu(e) {
    const { ui } = this.ctx;
    const t = (k, v) => this.t(k, v);
    const items = [];
    const walk = (arr, depth) => {
      for (const n of arr) {
        if (!n.noselect) items.push({ label: `${' '.repeat(depth)}${this.folderName(n)}`, icon: FOLDER_ICONS[n.special] || 'folder', disabled: n.path === this.folder, action: () => this.moveTo(n.path) });
        walk(n.children, depth + 1);
      }
    };
    walk(this.folderData().tree, 0);
    if (!this.currentUids().length) return;
    await ui.menu(e, [{ header: t('act.moveTo') }, ...items]);
  }

  async contextMenu(e) {
    const { ui } = this.ctx;
    const t = (k, v) => this.t(k, v);
    const uids = this.list.selectedUids;
    if (!uids.length) return;
    const msgs = uids.map((u) => this.list.byUid(u)).filter(Boolean);
    const one = msgs.length === 1;
    const anyUnread = msgs.some((m) => !m.seen);
    const allFlagged = msgs.every((m) => m.flagged);
    const special = this.folderSpecial();
    await ui.menu(e, [
      one ? { label: t('act.reply'), icon: 'arrow_reply', shortcut: 'Ctrl+R', action: () => this.reply('reply') } : null,
      one ? { label: t('act.replyAll'), icon: 'arrow_reply_all', shortcut: 'Ctrl+Shift+R', action: () => this.reply('replyAll') } : null,
      one ? { label: t('act.forward'), icon: 'arrow_forward', shortcut: 'Ctrl+F', action: () => this.reply('forward') } : null,
      one ? '-' : null,
      { label: anyUnread ? t('act.markRead') : t('act.markUnread'), icon: anyUnread ? 'mail_read' : 'mail_unread', shortcut: anyUnread ? 'Ctrl+Q' : 'Ctrl+U', action: () => this.setFlags(uids, { seen: anyUnread }) },
      { label: allFlagged ? t('act.unflag') : t('act.flag'), icon: allFlagged ? 'flag_off' : 'flag', shortcut: keyName('Insert', this.ctx.lang), action: () => this.setFlags(uids, { flagged: !allFlagged }) },
      '-',
      { label: t('act.move'), icon: 'folder_arrow_right', action: () => this.moveMenu(e instanceof Event ? e : null) },
      special !== 'archive' ? { label: t('act.archive'), icon: 'archive', action: () => this.archiveSelected() } : null,
      special !== 'junk' ? { label: t('act.junk'), icon: 'mail_prohibited', action: () => this.moveToSpecial('junk') } : { label: t('act.notJunk'), icon: 'mail_inbox', action: () => this.moveToSpecial('inbox') },
      { label: t('act.delete'), icon: 'delete', shortcut: keyName('Delete', this.ctx.lang), danger: true, action: () => this.deleteMessages(uids) },
    ].filter(Boolean));
  }

  // ------------------------------------------------------------ composing
  newMessage(prefill = {}) {
    return this.openComposer({ mode: 'new', ...prefill });
  }

  async reply(mode) {
    const msg = this.reader.msg;
    if (!msg || msg.accountId === '@file') return;
    const attachments = mode === 'forward' ? await this.forwardAttachments(msg) : [];
    await this.openComposer({ mode, original: msg, attachments });
  }

  // Double-click: the message in its own window.
  openStandalone(m) {
    if (!m || !this.account) return;
    if (this.folderSpecial() === 'drafts' || m.draft) return;
    this.ctx.shell.launch('mail', { newWindow: true, read: { accountId: this.account.id, folder: this.folder, uid: m.uid, special: { ...this.folderData().special } } });
  }

  async openComposer(opts) {
    if (!store.accounts.length) return;
    if (this.composer && !(await this.closeComposer())) return;
    this.list?.clearSelection();
    const composer = new Composer(this.ctx, {
      accountId: this.account?.id,
      ...opts,
      onClose: (reason, info) => this.onComposerClosed(composer, reason, info),
    });
    this.composer = composer;
    this.root.classList.add('composing', 'show-reader');
    this.readerHost.replaceChildren(composer.el);
    composer.focus();
    return composer;
  }

  async closeComposer() {
    if (!this.composer) return true;
    return this.composer.close();
  }

  onComposerClosed(composer, reason, info) {
    if (this.composer !== composer) return;
    this.composer = null;
    this.root.classList.remove('composing');
    this.readerHost.replaceChildren(this.reader.el);
    this.reader.showEmpty();
    this.root.classList.remove('show-reader');
    if (reason !== 'popout') this.focusList();
    if (reason === 'sent') this.snackbar(this.t('snack.sent'));
    if (info?.folder || reason === 'sent') {
      this.refreshFolders();
      if (this.folderSpecial() === 'sent' || this.folderSpecial() === 'drafts') setTimeout(() => this.softRefresh(), 800);
    }
  }

  // Launch arguments: { to, cc, subject, body } | { mailto } | { open: { accountId, folder, uid } }
  async handleArgs(args = {}) {
    if (!args || !Object.keys(args).length) return;
    if (args.open) {
      const { accountId, folder, uid } = args.open;
      if (!store.account(accountId)) return;
      if (this.account?.id !== accountId) await this.switchAccount(accountId);
      if (this.folder !== folder) await this.openFolder(folder);
      if (!this.list.byUid(uid)) await this.list.load({ soft: true });
      if (this.list.byUid(uid)) this.list.select(uid, { open: true });
      return;
    }
    let pre = null;
    if (args.mailto) pre = parseMailto(args.mailto);
    else if (args.to || args.subject || args.body || args.cc) pre = { to: args.to || '', cc: args.cc || '', bcc: args.bcc || '', subject: args.subject || '', body: args.body || '' };
    if (pre) {
      if (!store.accounts.length) {
        this.pendingCompose = pre;
        return;
      }
      await this.newMessage({ to: parseAddresses(pre.to), cc: parseAddresses(pre.cc), bcc: parseAddresses(pre.bcc), subject: pre.subject, body: pre.body });
    }
  }

  // ------------------------------------------------------------ misc
  // Keys are taken from the whole document while this window is the active one, so shortcuts keep
  // working when focus fell back to <body> (e.g. after a pane was replaced).
  wireKeys() {
    if (this.keysWired) return;
    this.keysWired = true;
    const handler = (e) => {
      const win = this.ctx.win;
      if (!win.el.isConnected || this.ctx.shell.wm.focused?.() !== win) return;
      if (!win.el.contains(e.target) && e.target !== document.body && e.target !== document.documentElement) return;
      this.onKey(e);
    };
    document.addEventListener('keydown', handler);
    this.offs.push(() => document.removeEventListener('keydown', handler));
  }

  // Put keyboard focus back on the message list (after a composer, dialog or menu went away).
  focusList() {
    setTimeout(() => {
      if (!this.list || this.composer) return;
      // Never steal focus from another window (e.g. a composer that was just popped out).
      if (this.ctx.shell.wm.focused?.() !== this.ctx.win) return;
      const a = document.activeElement;
      if (a && a !== document.body && this.ctx.win.el.contains(a) && a.isConnected && !a.closest('.dialog-layer.closing')) return;
      this.list.scroller.focus({ preventScroll: true });
    }, 30);
  }

  onKey(e) {
    if (e.defaultPrevented) return;
    if (guardDialog(this.ctx.win, e)) return; // a dialog is open: nothing happens behind it
    if (this.focusTrap?.tabFromBody(e)) return;
    if (!this.list || this.root.classList.contains('setup')) return;
    const layer = e.target.closest?.('.dialog-layer');
    if (layer && !layer.classList.contains('closing')) return;
    const k = e.key;
    const lower = k.length === 1 ? k.toLowerCase() : k;
    const ctrl = e.ctrlKey || e.metaKey;
    const editable = !!e.target.closest?.('input, textarea, select, [contenteditable="true"]');
    const inComposer = !!e.target.closest?.('.ml-compose');
    const run = (fn) => {
      e.preventDefault();
      e.stopPropagation();
      fn();
    };
    if (ctrl && !e.shiftKey && lower === 'n') return run(() => this.newMessage());
    if (k === 'F5') return run(() => this.refresh());
    if ((ctrl && lower === 'e') || k === 'F3') return run(() => this.searchInput.focus());
    if (inComposer) return;
    if (ctrl && e.shiftKey && lower === 'r') return run(() => this.reply('replyAll'));
    if (ctrl && !e.shiftKey && lower === 'r') return run(() => this.reply('reply'));
    if (ctrl && !e.shiftKey && lower === 'f' && !editable) return run(() => this.reply('forward'));
    if (ctrl && lower === 'q') return run(() => this.setSelectedFlags({ seen: true }));
    if (ctrl && lower === 'u') return run(() => this.setSelectedFlags({ seen: false }));
    if (ctrl && e.shiftKey && lower === 'g') return run(() => this.toggleFlagSelected());
    if (ctrl && e.shiftKey && lower === 'v') return run(() => this.moveMenu(this.list.el.querySelector('.ml-item.selected') || null));
    if (editable) return;
    if (ctrl && !e.shiftKey && lower === 'z' && this.lastUndo) return run(() => this.lastUndo());
    if (k === 'Delete') return run(() => this.deleteSelected());
    if (k === 'Insert') return run(() => this.toggleFlagSelected());
    if (k === 'Escape' && this.root.classList.contains('show-reader') && this.root.dataset.layout === 'narrow') return run(() => this.backToList());
    if (k === 'Escape' && this.root.classList.contains('nav-open')) return run(() => this.toggleNav(false));
  }

  // Language switched while Mail is open: every pane follows, nothing typed is lost.
  relocalize() {
    if (this.setup) {
      this.setup.relocalize();
      this.ctx.win.setTitle(this.t('appName'));
      return;
    }
    if (!this.list) return;
    this.nav?.setAttribute('aria-label', this.t('nav.label'));
    this.renderNav();
    const typed = this.searchInput?.value || '';
    const hadFocus = document.activeElement === this.searchInput;
    this.buildSearch();
    this.searchInput.value = typed;
    this.searchClear.hidden = !typed;
    if (hadFocus) this.searchInput.focus();
    const node = this.findFolder(this.folder);
    const name = node ? this.folderName(node) : this.folder || '';
    this.list.setHeader(name, this.folderSpecial());
    if (this.folder && this.account) {
      this.searchInput.placeholder = this.t('search.placeholderIn', { folder: name });
      this.ctx.win.setTitle(`${name} - ${this.account.email} - ${this.t('appName')}`);
    }
    this.list.relocalize();
    this.reader.relocalize();
    this.composer?.relocalize();
    const status = this.offline && !this.offline.hidden ? this.offline.dataset.code : null;
    if (status != null) this.onStatus({ accountId: this.account.id, online: false, code: status || null });
  }
}
