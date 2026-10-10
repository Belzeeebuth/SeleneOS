// One File Explorer window: tabs (each with its own history), address bar, command bar,
// navigation pane, content view, details/preview pane and status bar.
import { shared, setPref, getView, setView, isPinned, pin, unpin, isFavorite, toggleFavorite, addRecent, removeRecent, refreshDrives, peekUndo } from './shared.js';
import * as T from './types.js';
import * as ops from './ops.js';
import * as dlg from './dialogs.js';
import { AddressBar, SearchBox } from './address.js';
import { ContentView, VIEW_MODES } from './view.js';
import { NavPane } from './navpane.js';
import { SidePane } from './panes.js';
import { DnD, TRASH_TARGET } from './dnd.js';

let tabSeq = 0;
const MODE_ICONS = { xl: 'grid', large: 'grid', medium: 'grid_dots', small: 'apps_list', list: 'list', details: 'apps_list_detail', tiles: 'content_view' };

export class Explorer {
  constructor(ctx) {
    this.ctx = ctx;
    this.win = ctx.win;
    this.h = ctx.h;
    this.t = ctx.t;
    this.api = ctx.api;
    this.ui = ctx.ui;
    this.icon = ctx.icon;
    this.tabs = [];
    this.tab = null;
    this.navSeq = 0;
    this.refreshSeq = 0;
    this.watchId = null;
    this.watchPath = null;
    this.offs = [];
    this.closed = false;
    this.vs = getView('*');
    this.dnd = new DnD(this);
    this.view = new ContentView(this);
    this.nav = new NavPane(this);
    this.side = new SidePane(this);
    this.build();
  }

  // ---------------------------------------------------------------- location helpers
  locKey(loc) {
    if (!loc) return '';
    if (loc.type === 'dir') return loc.path;
    if (loc.type === 'search') return `search:${this.locKey(loc.root)}:${loc.query}`;
    return loc.type;
  }

  viewKey(loc = this.tab?.loc) {
    if (!loc) return '*';
    if (loc.type === 'search') return 'search:';
    return this.locKey(loc);
  }

  locName(loc) {
    const t = this.t;
    if (!loc) return '';
    if (loc.type === 'home') return t('places.home');
    if (loc.type === 'thispc') return t('places.thisPc');
    if (loc.type === 'trash') return t('places.trash');
    if (loc.type === 'search') return t('search.resultsIn', { name: this.locName(loc.root) });
    const p = loc.path;
    const k = T.knownFolder(p);
    if (k && k !== 'home') return t(`places.${k}`);
    const d = shared.drives.find((x) => x.mountpoint === p);
    if (d) return T.driveName(d, t);
    if (p === '/') return T.driveName({ mountpoint: '/' }, t);
    return T.basename(p);
  }

  locIcon(loc) {
    if (!loc) return T.iconPath('folder');
    if (loc.type === 'home') return T.iconPath('home');
    if (loc.type === 'thispc') return T.THIS_PC_ICON;
    if (loc.type === 'trash') return this.nav.trashFull ? T.iconPath('trash-full') : T.TRASH_ICON;
    if (loc.type === 'search') return T.iconPath('folder');
    const d = shared.drives.find((x) => x.mountpoint === loc.path);
    if (d) return T.driveIcon(d);
    return T.iconFor({ dir: true, path: loc.path });
  }

  iconForEntry(e) {
    return T.iconFor(e);
  }

  currentDir() {
    const loc = this.tab?.loc;
    return loc?.type === 'dir' ? loc.path : null;
  }

  // ---------------------------------------------------------------- DOM
  build() {
    const { h } = this;
    this.root = h('div', { class: 'fx-root' });
    // Tabs live in the tall title bar.
    this.tabStrip = h('div', { class: 'fx-tabs', role: 'tablist' });
    this.newTabBtn = h('button', { class: 'fx-newtab', 'data-no-drag': '', onclick: () => this.newTab() }, this.icon('add', { size: 14 }));
    this.tabBar = h('div', { class: 'fx-tabbar' }, this.tabStrip, this.newTabBtn);
    this.win.titlebarSlot.appendChild(this.tabBar);
    this.tabStrip.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) this.tabStrip.scrollLeft += e.deltaY;
    }, { passive: true });

    this.navSplit = h('div', { class: 'fx-split', role: 'separator', 'aria-orientation': 'vertical' });
    this.paneSplit = h('div', { class: 'fx-split', role: 'separator', 'aria-orientation': 'vertical' });
    this.main = h('div', { class: 'fx-main' }, this.nav.el, this.navSplit, this.view.el, this.paneSplit, this.side.el);
    this.buildTop();
    this.buildStatus();
    this.root.append(this.top, this.main, this.status);
    this.win.body.appendChild(this.root);
    this.splitter(this.navSplit, 'navWidth', this.nav.el, 1, 140, 480);
    this.splitter(this.paneSplit, 'paneWidth', this.side.el, -1, 200, 640);
    this.applyPrefs();
    this.relabelStatic();
  }

  buildTop() {
    const { h, t } = this;
    const navBtn = (ic, label, key, fn) =>
      h('button', { class: 'fx-navbtn', 'aria-label': label, 'data-tip': key ? `${label} (${key})` : label, 'data-tip-pos': 'below', onclick: fn }, this.icon(ic, { size: 16 }));
    this.btnBack = navBtn('arrow_left', t('nav.back'), 'Alt+Left', () => this.goBack());
    this.btnFwd = navBtn('arrow_right', t('nav.forward'), 'Alt+Right', () => this.goForward());
    this.btnUp = navBtn('arrow_up', t('nav.up'), 'Alt+Up', () => this.goUp());
    this.btnRefresh = navBtn('arrow_clockwise', t('nav.refresh'), 'F5', () => this.refresh());
    for (const b of [this.btnBack, this.btnFwd]) {
      b.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.historyMenu(e, b === this.btnBack ? -1 : 1);
      });
    }
    const oldAddress = this.address;
    this.address = new AddressBar(this);
    this.search = new SearchBox(this);
    const addrRow = h('div', { class: 'fx-addrrow' },
      h('div', { class: 'fx-navbtns' }, this.btnBack, this.btnFwd, this.btnUp, this.btnRefresh),
      this.address.el,
      this.search.el);
    this.buildCommandBar();
    const top = h('div', { class: 'fx-top' }, addrRow, this.cmdBar);
    if (this.top) this.top.replaceWith(top);
    this.top = top;
    if (oldAddress && this.tab) {
      this.address.set(this.tab.loc);
      this.search.setPlaceholder(this.locName(this.tab.loc.type === 'search' ? this.tab.loc.root : this.tab.loc));
      this.search.sync(this.tab.loc);
    }
  }

  cmdButton(ic, label, opts = {}) {
    const { h } = this;
    const b = h('button', {
      class: ['fx-cmd', opts.text && 'has-text', opts.menu && 'has-menu', opts.cls],
      'aria-label': label,
      'data-tip': opts.text ? null : opts.key ? `${label} (${opts.key})` : label,
      'data-tip-pos': 'below',
      'aria-haspopup': opts.menu ? 'menu' : null,
      onclick: opts.onclick,
    },
    this.icon(ic, { size: 16, filled: !!opts.filled }),
    opts.text ? h('span', { class: 'fx-cmd-label' }, opts.text) : null,
    opts.menu ? this.icon('chevron_down', { size: 10, class: 'fx-cmd-chev' }) : null);
    return b;
  }

  buildCommandBar() {
    const { h, t } = this;
    const c = (this.cmd = {});
    c.new = this.cmdButton('add_circle', t('cmd.new'), { text: t('cmd.new'), menu: true, cls: 'accent-icon', onclick: (e) => this.newMenu(e.currentTarget) });
    c.cut = this.cmdButton('cut', t('cmd.cut'), { key: 'Ctrl+X', onclick: () => this.clip('cut') });
    c.copy = this.cmdButton('copy', t('cmd.copy'), { key: 'Ctrl+C', onclick: () => this.clip('copy') });
    c.paste = this.cmdButton('clipboard_paste', t('cmd.paste'), { key: 'Ctrl+V', onclick: () => this.paste() });
    c.rename = this.cmdButton('rename', t('cmd.rename'), { key: 'F2', onclick: () => this.rename() });
    c.del = this.cmdButton('delete', t('cmd.delete'), { key: 'Del', onclick: () => this.del(false) });
    c.sort = this.cmdButton('arrow_sort', t('cmd.sort'), { text: t('cmd.sort'), menu: true, onclick: (e) => this.sortMenu(e.currentTarget) });
    c.view = this.cmdButton('apps_list_detail', t('cmd.view'), { text: t('cmd.view'), menu: true, onclick: (e) => this.viewMenu(e.currentTarget) });
    c.more = this.cmdButton('more_horizontal', t('cmd.more'), { onclick: (e) => this.moreMenu(e.currentTarget) });
    c.details = this.cmdButton('panel_right', t('cmd.detailsPane'), { text: t('cmd.details'), cls: 'fx-cmd-details', onclick: () => this.togglePane('details') });
    this.ctxCmds = h('div', { class: 'fx-cmd-ctx' });
    const sep = () => h('div', { class: 'fx-cmd-sep' });
    this.cmdBar = h('div', { class: 'fx-cmdbar', role: 'toolbar', 'aria-label': t('cmd.label') },
      c.new, sep(), c.cut, c.copy, c.paste, c.rename, c.del, sep(), c.sort, c.view, this.ctxCmds, sep(), c.more,
      h('div', { class: 'grow' }), c.details);
  }

  buildStatus() {
    const { h, t } = this;
    this.stCount = h('span');
    this.stSel = h('span', { class: 'fx-st-sel' });
    this.stDetails = h('button', { class: 'fx-st-btn', 'aria-label': t('view.details'), 'data-tip': t('view.detailsTip'), onclick: () => this.setMode('details') }, this.icon('apps_list_detail', { size: 14 }));
    this.stLarge = h('button', { class: 'fx-st-btn', 'aria-label': t('view.large'), 'data-tip': t('view.largeTip'), onclick: () => this.setMode('large') }, this.icon('grid', { size: 14 }));
    const st = h('div', { class: 'fx-status', role: 'status' }, this.stCount, this.stSel, h('div', { class: 'grow' }), this.stDetails, this.stLarge);
    if (this.status) this.status.replaceWith(st);
    this.status = st;
  }

  relabelStatic() {
    const t = this.t;
    this.newTabBtn.setAttribute('aria-label', t('tabs.new'));
    this.newTabBtn.dataset.tip = `${t('tabs.new')} (Ctrl+T)`;
    this.newTabBtn.dataset.tipPos = 'below';
    this.tabStrip.setAttribute('aria-label', t('tabs.label'));
    this.navSplit.setAttribute('aria-label', t('nav.resize'));
    this.paneSplit.setAttribute('aria-label', t('pane.resize'));
  }

  splitter(el, pref, target, sign, min, max) {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startW = target.getBoundingClientRect().width;
      el.classList.add('active');
      const move = (ev) => {
        const w = Math.max(min, Math.min(max, startW + (ev.clientX - startX) * sign));
        target.style.width = `${w}px`;
      };
      const up = () => {
        el.releasePointerCapture?.(e.pointerId);
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
        el.classList.remove('active');
        setPref(pref, Math.round(target.getBoundingClientRect().width));
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
    el.addEventListener('dblclick', () => {
      setPref(pref, pref === 'navWidth' ? 232 : 300);
      this.applyPrefs();
    });
  }

  applyPrefs() {
    const p = shared.prefs;
    this.nav.el.hidden = !p.navPane;
    this.navSplit.hidden = !p.navPane;
    this.nav.el.style.width = `${p.navWidth}px`;
    this.side.el.style.width = `${p.paneWidth}px`;
    this.paneSplit.hidden = !p.pane;
    if (this.side.kind !== p.pane) this.side.setKind(p.pane);
    this.root.classList.toggle('compact', !!p.compact);
    this.cmd?.details.classList.toggle('toggled', p.pane === 'details');
  }

  // ---------------------------------------------------------------- lifecycle
  async init(args = {}) {
    const ctx = this.ctx;
    // Live updates
    this.offs.push(this.api.on('fs:changed', (ev) => {
      if (ev.watchId && ev.watchId === this.watchId) {
        clearTimeout(this.watchTimer);
        this.watchTimer = setTimeout(() => this.refresh({ quiet: true }), 180);
      }
    }));
    this.offs.push(this.api.on('fs:trash-changed', () => {
      this.nav.updateTrash();
      const loc = this.tab?.loc;
      if (loc?.type === 'trash' || (loc?.type === 'search' && loc.root.type === 'trash')) this.refresh({ quiet: true });
    }));
    this.offs.push(shared.events.on('prefs', (key) => this.onPref(key)));
    this.offs.push(shared.events.on('pins', () => {
      this.nav.render();
      this.nav.sync(this.tab.loc);
      if (this.tab?.loc.type === 'home') this.refresh({ quiet: true });
    }));
    for (const ev of ['favorites', 'recent']) {
      this.offs.push(shared.events.on(ev, () => this.tab?.loc.type === 'home' && this.refresh({ quiet: true })));
    }
    this.offs.push(shared.events.on('views', () => {
      this.vs = getView(this.viewKey());
      this.view.setViewSettings(this.vs);
    }));
    this.offs.push(shared.events.on('drives', () => {
      if (this.nav.expanded.has('thispc')) this.nav.loadChildren({ id: 'thispc' }).then(() => this.nav.render());
      if (this.tab?.loc.type === 'thispc') this.refresh({ quiet: true });
    }));
    this.offs.push(shared.events.on('undo', () => this.updateCommands()));
    this.offs.push(ctx.shell.on('files-clipboard', () => {
      this.view.paintCut();
      this.updateCommands();
    }));
    ctx.onLangChange(() => this.relabel());
    this.win.on('close', () => this.dispose());
    this.win.on('focus', () => {
      if (!this.win.el.contains(document.activeElement) || document.activeElement === this.win.el) this.view.focus();
    });

    // Window-level keyboard shortcuts and mouse back/forward buttons.
    this.win.el.addEventListener('keydown', (e) => this.onKey(e));
    // When a focused element disappears (re-rendered row, hidden input…), focus would fall to <body>,
    // outside the window, and keyboard shortcuts would stop working: bring it back to the items view.
    this.win.el.addEventListener('focusout', (e) => {
      if (e.relatedTarget) return;
      setTimeout(() => {
        const a = document.activeElement;
        if ((!a || a === document.body) && !this.closed && this.win.isFocused?.() && !document.querySelector('.menu')) this.view.focus();
      }, 0);
    });
    this.win.el.addEventListener('mouseup', (e) => {
      if (e.button === 3) {
        e.preventDefault();
        this.goBack();
      } else if (e.button === 4) {
        e.preventDefault();
        this.goForward();
      }
    });
    this.win.el.addEventListener('dragover', (e) => {
      // Not over a drop target: no badge.
      if (!e.defaultPrevented) this.dnd.hideBadge();
    });
    this.win.el.addEventListener('dragleave', (e) => {
      if (!this.win.el.contains(e.relatedTarget)) this.dnd.hideBadge();
    });
    this.win.el.addEventListener('drop', () => this.dnd.hideBadge());

    const loc = await this.locFromArgs(args);
    this.nav.render();
    await this.newTab(loc.loc, { select: loc.select });
    setTimeout(() => this.view.focus(), 50);
  }

  async locFromArgs(args = {}) {
    const p = args.path || args.file;
    let select = args.select ? [args.select] : null;
    if (!p && args.select) return { loc: { type: 'dir', path: T.dirname(args.select) }, select };
    if (!p) return { loc: { type: shared.prefs.startAt === 'thispc' ? 'thispc' : 'home' } };
    if (p === 'home' || p === 'thispc' || p === 'trash') return { loc: { type: p } };
    if (p === '~') return { loc: { type: 'dir', path: shared.home } };
    const st = await this.api.invoke('fs:stat', p);
    if (st && !st.dir) return { loc: { type: 'dir', path: T.dirname(p) }, select: [p] };
    return { loc: { type: 'dir', path: p }, select };
  }

  // Relaunch of a singleInstance-like request on this window (not used: each launch = new window).
  async openArgs(args) {
    const { loc, select } = await this.locFromArgs(args);
    this.newTab(loc, { select });
  }

  dispose() {
    if (this.closed) return;
    this.closed = true;
    this.offs.forEach((off) => {
      try {
        off?.();
      } catch {}
    });
    if (this.watchId) this.api.invoke('fs:unwatch', this.watchId).catch(() => {});
    this.watchId = null;
    this.view.thumbObserver.disconnect();
  }

  relabel() {
    this.buildTop();
    this.buildStatus();
    this.relabelStatic();
    this.applyPrefs();
    this.renderTabs();
    this.nav.render();
    if (this.tab) {
      this.nav.sync(this.tab.loc);
      this.view.setViewSettings(this.vs);
      this.address.set(this.tab.loc);
      this.updateTitle();
    }
    this.updateNavButtons();
    this.updateCommands();
    this.updateStatus();
    this.side.update(true);
  }

  onPref(key) {
    this.applyPrefs();
    if (key === 'hidden') {
      this.refresh({ quiet: true });
      this.nav.refreshAll();
    } else if (['extensions', 'checkboxes', 'foldersFirst', 'showRecent', 'showFavorites', 'compact'].includes(key)) {
      if (key === 'showRecent' || key === 'showFavorites') this.tab?.loc.type === 'home' && this.refresh({ quiet: true });
      else this.view.setViewSettings(this.vs);
      this.side.update(true);
    } else if (key === 'fullPathTitle') this.updateTitle();
  }

  // ---------------------------------------------------------------- tabs
  async newTab(loc = { type: shared.prefs.startAt === 'thispc' ? 'thispc' : 'home' }, { activate = true, index, select } = {}) {
    const tab = { id: ++tabSeq, history: [{ loc, state: select ? { sel: select, focus: select[0], reveal: true } : null }], index: 0, loc };
    const at = index ?? (activate || !this.tab ? this.tabs.length : this.tabs.indexOf(this.tab) + 1);
    this.tabs.splice(at, 0, tab);
    this.renderTabs();
    if (activate || !this.tab) await this.activateTab(tab);
    return tab;
  }

  async activateTab(tab) {
    if (!tab || this.tab === tab) return;
    if (this.view.renaming) await this.view.commitRename();
    if (this.tab) this.tab.history[this.tab.index].state = this.view.state();
    this.tab = tab;
    this.renderTabs();
    const entry = tab.history[tab.index];
    const ok = await this.navigate(entry.loc, { push: false, restore: entry.state });
    if (!ok && this.tab === tab && !this.view.loc) await this.navigate({ type: 'home' }, { push: false });
    tab.el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  closeTab(tab = this.tab) {
    if (!tab) return;
    if (this.tabs.length <= 1) {
      this.win.close();
      return;
    }
    const i = this.tabs.indexOf(tab);
    const hadFocus = tab.el?.contains(document.activeElement);
    this.tabs.splice(i, 1);
    if (this.tab === tab) {
      this.tab = null;
      this.activateTab(this.tabs[Math.min(i, this.tabs.length - 1)]).then(() => !hadFocus && this.view.focus());
    }
    this.renderTabs();
  }

  closeOtherTabs(keep) {
    this.tabs = [keep];
    if (this.tab !== keep) this.activateTab(keep);
    this.renderTabs();
  }

  closeTabsRight(tab) {
    const i = this.tabs.indexOf(tab);
    const removed = this.tabs.splice(i + 1);
    if (removed.includes(this.tab)) {
      this.tab = null;
      this.activateTab(tab);
    }
    this.renderTabs();
  }

  tabTitle(tab) {
    const loc = tab.loc;
    if (loc.type === 'search') return `${loc.query} - ${this.locName(loc)}`;
    return this.locName(loc);
  }

  makeTabEl(tab) {
    const { h } = this;
    const el = h('div', { class: 'fx-tab', role: 'tab', 'data-no-drag': '', dataset: { tab: String(tab.id) } },
      h('img', { class: 'fx-tab-ic', alt: '', draggable: false }),
      h('span', { class: 'fx-tab-title' }),
      h('button', { class: 'fx-tab-x', tabindex: '-1', onclick: (e) => {
        e.stopPropagation();
        this.closeTab(tab);
      } }, this.icon('dismiss', { size: 10 })));
    el.addEventListener('pointerdown', (e) => this.tabPointerDown(e, tab));
    el.addEventListener('auxclick', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        this.closeTab(tab);
      }
    });
    el.addEventListener('mousedown', (e) => e.button === 1 && e.preventDefault());
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.tabMenu(e, tab);
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const i = this.tabs.indexOf(tab) + (e.key === 'ArrowRight' ? 1 : -1);
        const next = this.tabs[(i + this.tabs.length) % this.tabs.length];
        this.activateTab(next).then(() => next.el?.focus());
      } else if (e.key === 'Delete') this.closeTab(tab);
      else if (e.key === 'Enter' || e.key === 'ArrowDown') {
        e.preventDefault();
        this.view.focus();
      }
    });
    // Dropping files on a tab moves/copies them into that tab's folder; hovering switches to it.
    this.dnd.dropTarget(el, () => (tab.loc.type === 'dir' ? tab.loc.path : tab.loc.type === 'trash' ? TRASH_TARGET : null), {
      onHover: () => this.activateTab(tab),
      hoverDelay: 600,
    });
    return el;
  }

  // Keyed rendering: tab elements are reused so focus and hover states survive updates.
  renderTabs() {
    const t = this.t;
    const hadFocus = this.tabStrip.contains(document.activeElement);
    for (const tab of this.tabs) {
      if (!tab.el) tab.el = this.makeTabEl(tab);
      const active = tab === this.tab;
      const title = this.tabTitle(tab);
      tab.el.classList.toggle('active', active);
      tab.el.setAttribute('aria-selected', String(active));
      tab.el.tabIndex = active ? 0 : -1;
      tab.el.title = tab.loc.type === 'dir' ? tab.loc.path : title;
      tab.el.querySelector('.fx-tab-ic').src = this.locIcon(tab.loc);
      tab.el.querySelector('.fx-tab-title').textContent = title;
      const x = tab.el.querySelector('.fx-tab-x');
      x.setAttribute('aria-label', t('tabs.close'));
      x.dataset.tip = `${t('tabs.close')} (Ctrl+W)`;
      x.dataset.tipPos = 'below';
    }
    const els = this.tabs.map((x) => x.el);
    const kids = [...this.tabStrip.children];
    if (kids.length !== els.length || els.some((el, i) => kids[i] !== el)) this.tabStrip.replaceChildren(...els);
    this.tabBar.classList.toggle('single', this.tabs.length === 1);
    if (hadFocus && !this.tabStrip.contains(document.activeElement)) this.tab?.el?.focus();
  }

  updateTab() {
    this.renderTabs();
  }

  tabPointerDown(e, tab) {
    if (e.button !== 0 || e.target.closest('.fx-tab-x')) return;
    this.activateTab(tab);
    const el = tab.el;
    const startX = e.clientX;
    let dragging = false;
    const others = this.tabs.filter((x) => x !== tab).map((x) => ({ tab: x, el: x.el, rect: x.el.getBoundingClientRect() }));
    const myRect = el.getBoundingClientRect();
    let target = this.tabs.indexOf(tab);
    el.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const dx = ev.clientX - startX;
      if (!dragging && Math.abs(dx) < 6) return;
      if (!dragging) {
        dragging = true;
        el.classList.add('dragging');
        this.tabStrip.classList.add('reordering');
      }
      el.style.transform = `translateX(${dx}px)`;
      const center = myRect.left + myRect.width / 2 + dx;
      // Position among the other tabs
      target = others.filter((o) => o.rect.left + o.rect.width / 2 < center).length;
      const from = this.tabs.indexOf(tab);
      others.forEach((o, i) => {
        const orig = i >= from ? i + 1 : i; // index in the full list
        let shift = 0;
        if (orig > from && i < target) shift = -myRect.width;
        else if (orig < from && i >= target) shift = myRect.width;
        o.el.style.transform = shift ? `translateX(${shift}px)` : '';
      });
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      if (!dragging) return;
      el.classList.remove('dragging');
      this.tabStrip.classList.remove('reordering');
      this.tabs = this.tabs.filter((x) => x !== tab);
      this.tabs.splice(target, 0, tab);
      // FLIP: animate tabs from their visual position to the new layout.
      const before = new Map(this.tabs.map((x) => [x, x.el.getBoundingClientRect().left]));
      for (const x of this.tabs) x.el.style.transform = '';
      this.renderTabs();
      for (const x of this.tabs) {
        const dx = (before.get(x) ?? 0) - x.el.getBoundingClientRect().left;
        if (dx && document.documentElement.dataset.animations !== 'off') {
          x.el.animate([{ transform: `translateX(${dx}px)` }, { transform: 'none' }], { duration: 200, easing: 'cubic-bezier(0.1, 0.9, 0.2, 1)' });
        }
      }
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  tabMenu(e, tab) {
    const t = this.t;
    const i = this.tabs.indexOf(tab);
    this.ui.menu(e, [
      { label: t('tabs.new'), icon: 'tab_add', shortcut: 'Ctrl+T', action: () => this.newTab() },
      { label: t('tabs.duplicate'), icon: 'tab_desktop_copy', action: () => this.newTab(tab.loc, { index: i + 1 }) },
      { label: t('tabs.moveToWindow'), icon: 'window_new', action: () => {
        const loc = tab.loc.type === 'search' ? tab.loc.root : tab.loc;
        this.ctx.shell.launch('files', { path: loc.type === 'dir' ? loc.path : loc.type });
        this.closeTab(tab);
      } },
      '-',
      { label: t('tabs.close'), icon: 'dismiss', shortcut: 'Ctrl+W', action: () => this.closeTab(tab) },
      { label: t('tabs.closeOthers'), disabled: this.tabs.length < 2, action: () => this.closeOtherTabs(tab) },
      { label: t('tabs.closeRight'), disabled: i >= this.tabs.length - 1, action: () => this.closeTabsRight(tab) },
    ]);
  }

  // ---------------------------------------------------------------- navigation
  async loadHome() {
    const api = this.api;
    const statAll = (paths) => Promise.all(paths.map((p) => api.invoke('fs:stat', p).catch(() => null)));
    const [quickStats, favStats, openedStats, modified] = await Promise.all([
      statAll(shared.pinned),
      shared.prefs.showFavorites ? statAll(shared.favorites) : [],
      shared.prefs.showRecent ? statAll(shared.recent.slice(0, 20).map((r) => r.path)) : [],
      shared.prefs.showRecent ? api.invoke('files:recent', { limit: 24 }).catch(() => []) : [],
    ]);
    const quick = shared.pinned.map((p, i) => quickStats[i] ? { ...quickStats[i], name: T.knownFolder(p) && T.knownFolder(p) !== 'home' ? this.t(`places.${T.knownFolder(p)}`) : quickStats[i].name } : { name: T.basename(p), path: p, dir: true, missing: true });
    const favorites = favStats.filter(Boolean);
    const recentMap = new Map();
    shared.recent.slice(0, 20).forEach((r, i) => {
      const st = openedStats[i];
      if (st && !st.dir) recentMap.set(st.path, { ...st, _rank: Math.max(r.time, st.mtime) });
    });
    for (const e of modified) if (!recentMap.has(e.path)) recentMap.set(e.path, { ...e, _rank: e.mtime });
    const recent = [...recentMap.values()].sort((a, b) => b._rank - a._rank).slice(0, 20);
    return { quick, favorites, recent };
  }

  async loadLocation(loc) {
    const api = this.api;
    const hidden = shared.prefs.hidden;
    switch (loc.type) {
      case 'dir':
        return { entries: await api.invoke('fs:list', loc.path, { hidden }) };
      case 'trash':
        return { entries: await api.invoke('fs:trashList') };
      case 'home':
        return this.loadHome();
      case 'thispc': {
        await refreshDrives();
        const x = shared.xdg;
        const keys = ['desktop', 'documents', 'downloads', 'music', 'pictures', 'videos'];
        const stats = await Promise.all([shared.home, ...keys.map((k) => x[k])].map((p) => api.invoke('fs:stat', p).catch(() => null)));
        const folders = stats
          .map((st, i) => (st ? { ...st, label: i === 0 ? T.basename(shared.home) : this.t(`places.${keys[i - 1]}`) } : null))
          .filter(Boolean);
        return { folders, drives: shared.drives.filter((d) => d.size > 0 || d.mounted) };
      }
      case 'search': {
        const q = loc.query;
        if (loc.root.type === 'trash') {
          const words = q.toLowerCase().split(/\s+/).filter(Boolean);
          const list = await api.invoke('fs:trashList');
          return { entries: list.filter((e) => words.every((w) => e.name.toLowerCase().includes(w))) };
        }
        const root = loc.root.type === 'dir' ? loc.root.path : loc.root.type === 'thispc' ? '/' : shared.home;
        const entries = await api.invoke('fs:search', root, q, { hidden, limit: 1000, timeoutMs: 15000 });
        return { entries };
      }
      default:
        throw new Error(`Unknown location ${loc.type}`);
    }
  }

  // navigate(loc, {push = true, replace, restore, select, historyIndex})
  async navigate(loc, opts = {}) {
    if (this.closed) return false;
    const tab = this.tab;
    if (!tab) return false;
    if (this.view.renaming) await this.view.commitRename();
    const seq = ++this.navSeq;
    let restore = opts.restore || null;
    if (opts.select) restore = { sel: opts.select, focus: opts.select[0], reveal: true };
    const busyTimer = setTimeout(() => this.setBusy(true), 150);
    let data;
    if (loc.type === 'search') {
      // Show the (empty) results page at once; results stream in when the search finishes.
      this.commitLocation(tab, loc, opts);
      this.applyLocation(loc, { entries: [], searching: true }, null);
      this.setBusy(true);
    }
    try {
      data = await this.loadLocation(loc);
    } catch (err) {
      clearTimeout(busyTimer);
      if (seq === this.navSeq) this.setBusy(false);
      if (seq !== this.navSeq || this.closed) return false;
      await this.showNavError(loc, err);
      if (loc.type === 'search' && this.tab === tab) this.applyLocation(loc, { entries: [] }, null);
      return false;
    }
    clearTimeout(busyTimer);
    if (seq !== this.navSeq || this.closed || this.tab !== tab) return false;
    this.setBusy(false);
    if (loc.type !== 'search') this.commitLocation(tab, loc, opts);
    this.applyLocation(loc, data, restore);
    return true;
  }

  commitLocation(tab, loc, opts) {
    if (opts.historyIndex != null) {
      tab.history[tab.index].state = tab.history[tab.index].state || null;
      tab.index = opts.historyIndex;
      tab.history[tab.index].loc = loc;
    } else if (opts.push !== false) {
      const cur = tab.history[tab.index];
      if (cur && this.view.loc && this.locKey(this.view.loc) === this.locKey(cur.loc)) cur.state = this.view.state();
      if (opts.replace) tab.history[tab.index] = { loc, state: null };
      else if (!cur || this.locKey(cur.loc) !== this.locKey(loc)) {
        tab.history = tab.history.slice(0, tab.index + 1);
        tab.history.push({ loc, state: null });
        if (tab.history.length > 100) tab.history.shift();
        tab.index = tab.history.length - 1;
      }
    }
    tab.loc = loc;
  }

  applyLocation(loc, data, restore) {
    const tab = this.tab;
    tab.loc = loc;
    this.vs = getView(this.viewKey(loc));
    this.view.setData(loc, data, this.vs, restore);
    this.address.set(loc);
    this.search.setPlaceholder(this.locName(loc.type === 'search' ? loc.root : loc));
    this.search.sync(loc);
    this.nav.sync(loc);
    this.updateTab(tab);
    this.updateTitle();
    this.updateNavButtons();
    this.updateCommands();
    this.updateStatus();
    this.side.update(true);
    this.watch(loc);
  }

  async showNavError(loc, err) {
    const t = this.t;
    const name = this.locName(loc);
    let msg;
    if (err?.code === 'EACCES' || err?.code === 'EPERM') msg = t('errors.noAccess', { name });
    else if (err?.code === 'ENOENT') msg = t('errors.notFound', { path: loc.path || name });
    else if (err?.code === 'ENOTDIR') msg = t('errors.notFolder', { path: loc.path || name });
    else msg = ops.errText(this, err);
    await this.ui.alert(msg, { title: name || t('appName'), parent: this.win });
  }

  updateTitle() {
    const loc = this.tab?.loc;
    if (!loc) return;
    const base = shared.prefs.fullPathTitle && loc.type === 'dir' ? loc.path : this.locName(loc);
    this.win.setTitle(`${base} - ${this.t('appName')}`);
    this.win.setIcon?.(this.ctx.appUrl('icon.svg'));
  }

  updateNavButtons() {
    const tab = this.tab;
    if (!tab) return;
    this.btnBack.disabled = tab.index <= 0;
    this.btnFwd.disabled = tab.index >= tab.history.length - 1;
    this.btnUp.disabled = tab.loc.type === 'home';
    const prev = tab.history[tab.index - 1];
    const next = tab.history[tab.index + 1];
    this.btnBack.dataset.tip = prev ? this.t('nav.backTo', { name: this.locName(prev.loc) }) : `${this.t('nav.back')} (Alt+Left)`;
    this.btnFwd.dataset.tip = next ? this.t('nav.forwardTo', { name: this.locName(next.loc) }) : `${this.t('nav.forward')} (Alt+Right)`;
    const up = this.upLoc();
    this.btnUp.dataset.tip = up ? this.t('nav.upTo', { name: this.locName(up) }) : this.t('nav.up');
  }

  historyMenu(e, dir) {
    const tab = this.tab;
    const items = [];
    if (dir < 0) for (let i = tab.index - 1; i >= 0 && items.length < 12; i--) items.push(i);
    else for (let i = tab.index + 1; i < tab.history.length && items.length < 12; i++) items.push(i);
    if (!items.length) return;
    this.ui.menu(e, items.map((i) => ({ label: this.locName(tab.history[i].loc), icon: 'folder', iconFilled: true, action: () => this.goHistory(i) })), { class: 'app-files fx-scroll-menu' });
  }

  async goHistory(i) {
    const tab = this.tab;
    if (!tab || i < 0 || i >= tab.history.length || i === tab.index) return;
    if (this.view.loc) tab.history[tab.index].state = this.view.state();
    const target = tab.history[i];
    await this.navigate(target.loc, { historyIndex: i, restore: target.state });
  }

  goBack() {
    return this.goHistory(this.tab.index - 1);
  }

  goForward() {
    return this.goHistory(this.tab.index + 1);
  }

  upLoc() {
    const loc = this.tab?.loc;
    if (!loc) return null;
    if (loc.type === 'search') return loc.root;
    if (loc.type === 'thispc' || loc.type === 'trash') return { type: 'home' };
    if (loc.type === 'dir') {
      const segs = this.address.segmentsFor(loc);
      return segs[segs.length - 2]?.loc || { type: 'thispc' };
    }
    return null;
  }

  goUp() {
    const loc = this.tab.loc;
    const up = this.upLoc();
    if (!up) return;
    this.navigate(up, loc.type === 'dir' && up.type === 'dir' ? { select: [loc.path] } : {});
  }

  cancelSearch() {
    const loc = this.tab.loc;
    if (loc.type !== 'search') return;
    this.navSeq++;
    this.setBusy(false);
    // Back to the folder the search started from (replacing the results page in history).
    const tab = this.tab;
    if (tab.index > 0 && this.locKey(tab.history[tab.index - 1].loc) === this.locKey(loc.root)) this.goBack();
    else this.navigate(loc.root, { replace: true });
  }

  async refresh({ select, quiet = false } = {}) {
    if (this.closed || !this.tab) return;
    if (this.view.renaming) {
      this.pendingRefresh = true;
      return;
    }
    const loc = this.tab.loc;
    const navAt = this.navSeq;
    const seq = ++this.refreshSeq;
    const st = this.view.state();
    if (select) {
      st.sel = select;
      st.focus = select[0];
      st.reveal = true;
    }
    if (!quiet) this.btnRefresh.classList.add('spin');
    try {
      const data = await this.loadLocation(loc);
      if (seq !== this.refreshSeq || navAt !== this.navSeq || this.tab.loc !== loc || this.closed) return;
      if (this.view.renaming) {
        this.pendingRefresh = true;
        return;
      }
      this.view.setData(loc, data, this.vs, st);
      this.updateCommands();
      this.updateStatus();
      this.side.update();
      if (loc.type === 'dir') this.nav.refreshPath(loc.path);
    } catch (err) {
      if (navAt !== this.navSeq) return;
      if (loc.type === 'dir' && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
        // The folder vanished (deleted, renamed, drive removed): go to the closest existing parent.
        let p = T.dirname(loc.path);
        while (p !== '/' && !(await this.api.invoke('fs:exists', p))) p = T.dirname(p);
        this.navigate({ type: 'dir', path: p }, { replace: true });
      } else if (!quiet) this.showNavError(loc, err);
    } finally {
      setTimeout(() => this.btnRefresh?.classList.remove('spin'), 300);
    }
  }

  // Called after operations: refresh this window (selecting new items when they are in view).
  refreshAll(opts) {
    if (this.closed) return;
    this.nav.updateTrash();
    const loc = this.tab?.loc;
    if (opts?.dir && loc?.type === 'dir' && loc.path === opts.dir) this.refresh({ select: opts.select, quiet: true });
    else this.refresh({ quiet: true });
    if (opts?.dir) this.nav.refreshPath(opts.dir);
  }

  async watch(loc) {
    const path = loc.type === 'dir' ? loc.path : null;
    if (path === this.watchPath) return;
    if (this.watchId) this.api.invoke('fs:unwatch', this.watchId).catch(() => {});
    this.watchId = null;
    this.watchPath = path;
    if (!path) return;
    try {
      const id = await this.api.invoke('fs:watch', path);
      if (this.watchPath === path && !this.closed) this.watchId = id;
      else this.api.invoke('fs:unwatch', id).catch(() => {});
    } catch {}
  }

  setBusy(on) {
    this.address?.setBusy(on);
    this.root.classList.toggle('busy', !!on);
  }

  toast(text, action) {
    this.view.toast(text, action);
  }

  // ---------------------------------------------------------------- selection-driven UI
  onSelection() {
    this.updateCommands();
    this.updateStatus();
    this.side.update();
  }

  updateStatus() {
    if (!this.stCount) return;
    const t = this.t;
    const n = this.view.items.length;
    this.stCount.textContent = t('status.items', { count: n });
    const sel = this.view.selectedItems();
    if (sel.length) {
      const files = sel.filter((i) => i.entry && !i.entry.dir && i.kind !== 'drive');
      const size = files.reduce((s, i) => s + (i.entry.size || 0), 0);
      this.stSel.textContent = files.length ? t('status.selectedSize', { count: sel.length, size: T.humanSize(size) }) : t('status.selected', { count: sel.length });
      this.stSel.hidden = false;
    } else {
      this.stSel.textContent = '';
      this.stSel.hidden = true;
    }
    const custom = this.tab && (this.tab.loc.type === 'home' || this.tab.loc.type === 'thispc');
    this.stDetails.classList.toggle('on', !custom && this.vs.mode === 'details');
    this.stLarge.classList.toggle('on', !custom && this.vs.mode === 'large');
    this.stDetails.disabled = custom;
    this.stLarge.disabled = custom;
  }

  selectionInfo() {
    const loc = this.tab?.loc || { type: 'home' };
    const items = this.view.selectedItems();
    const entries = this.view.selectedEntries();
    const files = items.filter((i) => i.kind === 'file' && !i.entry.missing);
    return {
      loc,
      items,
      entries,
      inFolder: loc.type === 'dir',
      canModify: items.length > 0 && files.length === items.length,
      single: items.length === 1 ? items[0] : null,
      trash: loc.type === 'trash' || (loc.type === 'search' && loc.root.type === 'trash'),
    };
  }

  updateCommands() {
    if (!this.cmd || !this.tab) return;
    const s = this.selectionInfo();
    const c = this.cmd;
    const clip = this.ctx.shell.clipboard.getFiles();
    c.new.disabled = !s.inFolder;
    c.cut.disabled = !s.canModify;
    c.copy.disabled = !s.canModify;
    c.paste.disabled = !s.inFolder || !clip?.paths?.length;
    c.rename.disabled = !(s.single && s.canModify);
    c.del.disabled = !(s.canModify || (s.trash && s.items.length));
    const custom = s.loc.type === 'home' || s.loc.type === 'thispc';
    c.sort.disabled = custom;
    c.details.classList.toggle('toggled', shared.prefs.pane === 'details');
    c.view.querySelector('.icon').replaceWith(this.icon(custom ? 'apps_list_detail' : MODE_ICONS[this.vs.mode] || 'apps_list_detail', { size: 16 }));
    // Context-specific commands (like Windows' Recycle Bin / picture / archive tools).
    const { h, t } = this;
    const ctx = [];
    const btn = (ic, label, fn, opts = {}) => {
      const b = this.cmdButton(ic, label, { text: label, onclick: fn, ...opts });
      ctx.push(b);
      return b;
    };
    if (s.trash) {
      btn('delete_dismiss', t('trash.empty'), () => ops.emptyTrash(this));
      btn('arrow_undo', t('trash.restoreAll'), () => this.restoreAll());
      if (s.items.length) btn('arrow_counterclockwise', t('trash.restoreSelected'), () => ops.restore(this, s.entries));
    } else if (s.single && s.single.kind === 'file' && T.isImage(s.single.entry)) {
      btn('image', t('cmd.setBackground'), () => ops.setWallpaper(this, s.single.entry));
    } else if (s.single && s.single.kind === 'file' && T.isArchive(s.single.entry)) {
      btn('folder_zip', t('cmd.extractAll'), () => dlg.extractDialog(this, s.single.entry));
    } else if (s.single && s.single.kind === 'drive') {
      const d = s.single.entry.drive;
      if (d.mounted && d.mountpoint !== '/' && d.kind !== 'system' && d.device) btn('arrow_eject', t('drives.eject'), () => this.driveOp('eject', d));
      btn('info', t('menu.properties'), () => this.properties({ drive: d }));
    }
    if (s.loc.type === 'search') btn('dismiss', t('search.close'), () => this.cancelSearch());
    if (ctx.length) ctx.unshift(h('div', { class: 'fx-cmd-sep' }));
    this.ctxCmds.replaceChildren(...ctx);
  }

  // ---------------------------------------------------------------- menus
  menu(at, items, opts = {}) {
    // ui.menu only knows Fluent glyphs; decorate rows that need an app icon (Open with) or bold text.
    const { h } = this;
    const decorate = (menuEl) => {
      for (const { row, it } of menuEl._entries || []) {
        if (it.img) {
          const img = h('img', { class: 'icon fx-menu-img', src: it.img, alt: '' });
          const ic = row.querySelector('.icon');
          if (ic) ic.replaceWith(img);
        }
        if (it.bold) row.classList.add('fx-bold');
      }
      menuEl.classList.add('app-files');
    };
    const mo = new MutationObserver((muts) => {
      for (const m of muts) for (const n of m.addedNodes) if (n.classList?.contains('menu')) decorate(n);
    });
    mo.observe(document.body, { childList: true });
    const p = this.ui.menu(at, items, opts);
    p.finally(() => setTimeout(() => mo.disconnect(), 0));
    return p;
  }

  newItems() {
    const t = this.t;
    const dir = this.currentDir();
    return [
      { label: t('new.folder'), icon: 'folder_add', shortcut: 'Ctrl+Shift+N', disabled: !dir, action: () => this.newFolder() },
      '-',
      { label: t('new.text'), icon: 'document_text', disabled: !dir, action: () => this.newFile('text') },
      { label: t('new.markdown'), icon: 'document_markdown', disabled: !dir, action: () => this.newFile('markdown') },
      { label: t('new.empty'), icon: 'document', disabled: !dir, action: () => this.newFile('empty') },
    ];
  }

  newMenu(btn) {
    this.menu(btn, this.newItems());
  }

  sortItems() {
    const t = this.t;
    const loc = this.tab.loc;
    const keys = loc.type === 'trash' ? ['name', 'origin', 'deleted', 'size', 'type', 'mtime'] : loc.type === 'search' ? ['name', 'mtime', 'type', 'size', 'location'] : ['name', 'mtime', 'type', 'size'];
    return [
      ...keys.map((k) => ({ label: t(`cols.${k}`), checked: this.vs.sort === k, action: () => this.setSort(k, this.vs.sort === k ? this.vs.dir : k === 'mtime' || k === 'deleted' || k === 'size' ? -1 : 1) })),
      '-',
      { label: t('sort.asc'), icon: 'text_sort_ascending', checked: this.vs.dir > 0, action: () => this.setSort(this.vs.sort, 1) },
      { label: t('sort.desc'), icon: 'text_sort_descending', checked: this.vs.dir < 0, action: () => this.setSort(this.vs.sort, -1) },
      '-',
      { label: t('sort.groupBy'), icon: 'group_list', submenu: this.groupItemsMenu() },
    ];
  }

  groupItemsMenu() {
    const t = this.t;
    return ['none', 'name', 'mtime', 'type', 'size'].map((g) => ({ label: t(`group.${g}`), checked: this.vs.group === g, action: () => this.updateView({ group: g }) }));
  }

  sortMenu(btn) {
    this.menu(btn, this.sortItems());
  }

  viewModeItems() {
    const t = this.t;
    const custom = this.tab.loc.type === 'home' || this.tab.loc.type === 'thispc';
    return VIEW_MODES.map((m) => ({
      label: t(`view.${m}`),
      icon: MODE_ICONS[m],
      checked: !custom && this.vs.mode === m,
      disabled: custom,
      shortcut: `Ctrl+Shift+${['xl', 'large', 'medium', 'small', 'list', 'details', 'tiles'].indexOf(m) + 1}`,
      action: () => this.setMode(m),
    }));
  }

  showItems() {
    const t = this.t;
    const p = shared.prefs;
    return [
      { label: t('show.navPane'), icon: 'panel_left', checked: p.navPane, action: () => setPref('navPane', !p.navPane) },
      { label: t('show.detailsPane'), icon: 'panel_right', checked: p.pane === 'details', shortcut: 'Alt+Shift+P', action: () => this.togglePane('details') },
      { label: t('show.previewPane'), icon: 'panel_right_gallery', checked: p.pane === 'preview', shortcut: 'Alt+P', action: () => this.togglePane('preview') },
      '-',
      { label: t('show.checkboxes'), icon: 'checkbox_checked', checked: p.checkboxes, action: () => setPref('checkboxes', !p.checkboxes) },
      { label: t('show.extensions'), icon: 'document', checked: p.extensions, action: () => setPref('extensions', !p.extensions) },
      { label: t('show.hidden'), icon: 'eye', checked: p.hidden, action: () => setPref('hidden', !p.hidden) },
    ];
  }

  viewMenu(btn) {
    const t = this.t;
    this.menu(btn, [
      ...this.viewModeItems(),
      '-',
      { label: t('view.compact'), icon: 'text_density', checked: shared.prefs.compact, action: () => setPref('compact', !shared.prefs.compact) },
      '-',
      { label: t('view.show'), icon: 'eye', submenu: this.showItems() },
    ]);
  }

  moreMenu(btn) {
    const t = this.t;
    const s = this.selectionInfo();
    const op = peekUndo();
    this.menu(btn, [
      { label: ops.undoLabel(this), icon: 'arrow_undo', shortcut: 'Ctrl+Z', disabled: !op, action: () => ops.undo(this) },
      '-',
      { label: t('more.selectAll'), icon: 'select_all_on', shortcut: 'Ctrl+A', disabled: !this.view.items.length, action: () => this.view.selectAll() },
      { label: t('more.selectNone'), icon: 'select_all_off', disabled: !s.items.length, action: () => this.view.selectNone() },
      { label: t('more.invert'), icon: 'checkbox_indeterminate', disabled: !this.view.items.length, action: () => this.view.invert() },
      '-',
      { label: t('menu.copyPath'), icon: 'copy_select', shortcut: 'Ctrl+Shift+C', disabled: !(s.entries.length || s.inFolder), action: () => this.copyPath() },
      { label: t('menu.openTerminal'), icon: 'window_console', disabled: !s.inFolder, action: () => this.openTerminal(this.currentDir()) },
      '-',
      { label: t('menu.properties'), icon: 'info', shortcut: 'Alt+Enter', disabled: s.loc.type === 'home', action: () => this.propertiesForSelection() },
      { label: t('more.options'), icon: 'settings', action: () => dlg.optionsDialog(this) },
    ]);
  }

  openWithItems(entry) {
    const t = this.t;
    const reg = this.ctx.shell.registry;
    const ext = (entry.ext || '').toLowerCase();
    const def = reg.handlerFor(entry.path);
    const apps = reg.list().filter((m) => m.id !== 'files' && (m.fileTypes || []).includes(ext));
    if (def && !apps.some((a) => a.id === def)) apps.unshift(reg.get(def));
    const items = apps.filter(Boolean).map((m) => ({ label: reg.name(m.id), icon: 'app_generic', img: reg.iconUrl(m.id), action: () => this.openWith(entry, m.id) }));
    if (items.length) items.push('-');
    items.push({ label: t('openWith.choose'), icon: 'apps', action: () => dlg.chooseApp(this, entry) });
    return items;
  }

  driveMenuItems(d) {
    const t = this.t;
    const items = [];
    const isSystem = d.mountpoint === '/' || d.kind === 'system';
    if (!isSystem && d.device) {
      if (!d.mounted) items.push({ label: t('drives.mount'), icon: 'hard_drive', action: () => this.driveOp('mount', d) });
      else items.push({ label: t('drives.unmount'), icon: 'arrow_eject', action: () => this.driveOp('unmount', d) });
      if (d.removable || d.kind === 'usb' || d.kind === 'optical') items.push({ label: t('drives.eject'), icon: 'arrow_eject', action: () => this.driveOp('eject', d) });
      items.push('-');
    }
    items.push({ label: t('menu.properties'), icon: 'info', action: () => this.properties({ drive: d }) });
    return items;
  }

  itemMenu(at, items) {
    const t = this.t;
    const s = this.selectionInfo();
    if (!items.length) return;
    // Drives (This PC)
    if (items[0].kind === 'drive') {
      const d = items[0].entry.drive;
      const loc = d.mountpoint ? { type: 'dir', path: d.mountpoint } : null;
      return this.menu(at, [
        { label: t('menu.open'), icon: 'open', action: () => this.openDrive(d) },
        { label: t('menu.openNewTab'), icon: 'tab_add', disabled: !loc, action: () => this.newTab(loc) },
        { label: t('menu.openNewWindow'), icon: 'window_new', disabled: !loc, action: () => this.ctx.shell.launch('files', { path: d.mountpoint }) },
        '-',
        ...this.driveMenuItems(d),
      ]);
    }
    // Recycle Bin items
    if (items[0].kind === 'trash') {
      return this.menu(at, [
        { label: t('trash.restore'), icon: 'arrow_undo', action: () => ops.restore(this, s.entries) },
        '-',
        { label: t('trash.deleteForever'), icon: 'delete', shortcut: 'Del', action: () => ops.deleteForever(this, s.entries) },
        '-',
        { label: t('menu.properties'), icon: 'info', disabled: items.length !== 1, action: () => this.properties({ trash: items[0].entry }) },
      ]);
    }
    const entries = s.entries;
    if (!entries.length) return;
    const single = entries.length === 1 ? entries[0] : null;
    const missing = entries.some((e) => e.missing);
    const allDirs = entries.every((e) => e.dir);
    const iconBar = [
      { icon: 'cut', label: t('cmd.cut'), disabled: missing, action: () => this.clip('cut') },
      { icon: 'copy', label: t('cmd.copy'), disabled: missing, action: () => this.clip('copy') },
      { icon: 'rename', label: t('cmd.rename'), disabled: !single || missing, action: () => this.rename() },
      { icon: 'delete', label: t('cmd.delete'), disabled: missing, action: () => this.del(false) },
    ];
    const list = [];
    list.push({ label: t('menu.open'), icon: 'open', shortcut: 'Enter', disabled: missing, action: () => this.openEntries(entries) });
    if (single?.dir) {
      list.push({ label: t('menu.openNewTab'), icon: 'tab_add', disabled: missing, action: () => this.newTab({ type: 'dir', path: single.path }) });
      list.push({ label: t('menu.openNewWindow'), icon: 'window_new', disabled: missing, action: () => this.ctx.shell.launch('files', { path: single.path }) });
    }
    if (single && !single.dir && !missing) list.push({ label: t('menu.openWith'), icon: 'apps', submenu: this.openWithItems(single) });
    if (s.loc.type === 'search' || s.loc.type === 'home') {
      if (single) list.push({ label: t('menu.openLocation'), icon: 'folder_open', action: () => this.navigate({ type: 'dir', path: T.dirname(single.path) }, { select: [single.path] }) });
    }
    list.push('-');
    if (single?.dir) {
      list.push(isPinned(single.path)
        ? { label: t('menu.unpin'), icon: 'pin_off', action: () => unpin(single.path) }
        : { label: t('menu.pin'), icon: 'pin', disabled: missing, action: () => pin(single.path) });
    } else if (single) {
      list.push(isFavorite(single.path)
        ? { label: t('menu.unfavorite'), icon: 'star_off', action: () => toggleFavorite(single.path, false) }
        : { label: t('menu.favorite'), icon: 'star', action: () => toggleFavorite(single.path, true) });
    }
    const it0 = items[0];
    if (it0.section === 'r' && single) list.push({ label: t('menu.removeRecent'), icon: 'history_dismiss', action: () => removeRecent(single.path) });
    if (!missing) {
      list.push({ label: t('menu.compress'), icon: 'folder_zip', action: () => this.compress(entries) });
      if (single && T.isArchive(single)) list.push({ label: t('cmd.extractAll'), icon: 'folder_arrow_up', action: () => dlg.extractDialog(this, single) });
    }
    list.push({ label: t('menu.copyPath'), icon: 'copy_select', shortcut: 'Ctrl+Shift+C', action: () => this.copyPath() });
    if (single && T.isImage(single) && !missing) list.push({ label: t('cmd.setBackground'), icon: 'image', action: () => ops.setWallpaper(this, single) });
    if (single?.dir && !missing) {
      list.push('-');
      list.push({ label: t('menu.openTerminal'), icon: 'window_console', action: () => this.openTerminal(single.path) });
    }
    if (single?.dir && this.ctx.shell.clipboard.getFiles()?.paths?.length && !missing) {
      list.push({ label: t('menu.pasteInto'), icon: 'clipboard_paste', action: () => ops.paste(this, single.path) });
    }
    list.push('-');
    list.push({ label: t('menu.properties'), icon: 'info', shortcut: 'Alt+Enter', disabled: missing, action: () => this.properties({ entries }) });
    if (allDirs && missing && single && isPinned(single.path)) list.splice(1, 0, { label: t('menu.unpin'), icon: 'pin_off', action: () => unpin(single.path) });
    return this.menu(at, list, { iconBar });
  }

  backgroundMenu(at) {
    const t = this.t;
    const loc = this.tab.loc;
    const dir = this.currentDir();
    const clip = this.ctx.shell.clipboard.getFiles();
    const op = peekUndo();
    const custom = loc.type === 'home' || loc.type === 'thispc';
    const list = [];
    list.push({ label: t('cmd.view'), icon: 'apps_list_detail', disabled: custom, submenu: this.viewModeItems() });
    list.push({ label: t('menu.sortBy'), icon: 'arrow_sort', disabled: custom, submenu: this.sortItems().filter((x) => x === '-' || !x.submenu) });
    list.push({ label: t('sort.groupBy'), icon: 'group_list', disabled: custom, submenu: this.groupItemsMenu() });
    list.push({ label: t('nav.refresh'), icon: 'arrow_clockwise', shortcut: 'F5', action: () => this.refresh() });
    if (loc.type === 'trash') {
      list.push('-');
      list.push({ label: t('trash.empty'), icon: 'delete_dismiss', disabled: !this.view.items.length, action: () => ops.emptyTrash(this) });
      list.push({ label: t('trash.restoreAll'), icon: 'arrow_undo', disabled: !this.view.items.length, action: () => this.restoreAll() });
    }
    if (dir) {
      list.push('-');
      list.push({ label: t('cmd.paste'), icon: 'clipboard_paste', shortcut: 'Ctrl+V', disabled: !clip?.paths?.length, action: () => this.paste() });
      list.push({ label: ops.undoLabel(this), icon: 'arrow_undo', shortcut: 'Ctrl+Z', disabled: !op, action: () => ops.undo(this) });
      list.push('-');
      list.push({ label: t('cmd.new'), icon: 'add_circle', submenu: this.newItems() });
      list.push('-');
      list.push({ label: t('menu.openTerminal'), icon: 'window_console', action: () => this.openTerminal(dir) });
      list.push({ label: t('menu.copyPath'), icon: 'copy_select', action: () => ops.copyAsPath(this, [dir]) });
      list.push('-');
      list.push({ label: t('menu.properties'), icon: 'info', action: () => this.propertiesForSelection(true) });
    } else if (loc.type === 'thispc') {
      list.push('-');
      list.push({ label: t('menu.properties'), icon: 'info', action: () => this.ctx.shell.launch('settings', { page: 'about' }) });
    }
    this.menu(at, list);
  }

  // ---------------------------------------------------------------- actions
  async openEntries(entries) {
    entries = entries.filter(Boolean);
    const missing = entries.find((e) => e.missing);
    if (missing) {
      await this.ui.alert(this.t('errors.notFound', { path: missing.path }), { title: this.t('appName'), parent: this.win });
      return;
    }
    const dirs = entries.filter((e) => e.dir);
    const files = entries.filter((e) => !e.dir);
    if (files.length > 15) {
      const ok = await this.ui.confirm(this.t('confirm.openMany', { count: files.length }), { title: this.t('appName'), parent: this.win });
      if (!ok) return;
    }
    for (const f of files) await this.openFile(f);
    if (dirs.length) {
      for (const d of dirs.slice(1)) this.newTab({ type: 'dir', path: d.path }, { activate: false });
      await this.navigate({ type: 'dir', path: dirs[0].path });
    }
  }

  async openFile(entry) {
    const reg = this.ctx.shell.registry;
    const handler = reg.handlerFor(entry.path);
    if (!handler) {
      if (T.isArchive(entry)) return dlg.extractDialog(this, entry);
      return dlg.chooseApp(this, entry);
    }
    addRecent(entry.path);
    try {
      await this.ctx.shell.openFile(entry.path);
    } catch (err) {
      ops.alertError(this, err);
    }
  }

  async openWith(entry, appId) {
    addRecent(entry.path);
    try {
      await this.ctx.shell.openFile(entry.path, { appId });
    } catch (err) {
      ops.alertError(this, err);
    }
  }

  async openDrive(d) {
    if (d.mountpoint) return this.navigate({ type: 'dir', path: d.mountpoint });
    if (!d.device) return;
    const mp = await this.driveOp('mount', d);
    if (mp) this.navigate({ type: 'dir', path: mp });
  }

  async driveOp(op, d) {
    const t = this.t;
    try {
      this.setBusy(true);
      const res = await this.api.invoke(`fs:${op}`, d.device);
      await refreshDrives();
      if (op === 'eject') this.toast(t('drives.safeToRemove', { name: T.driveName(d, t) }));
      if ((op === 'unmount' || op === 'eject') && this.tab.loc.type === 'dir' && d.mountpoint && (this.tab.loc.path === d.mountpoint || T.isInside(this.tab.loc.path, d.mountpoint))) {
        this.navigate({ type: 'thispc' }, { replace: true });
      }
      if (op === 'mount') {
        const fresh = shared.drives.find((x) => x.device === d.device);
        return fresh?.mountpoint || res || null;
      }
      return res;
    } catch (err) {
      await this.ui.alert(err.message || String(err), { title: t(`drives.${op}Error`), parent: this.win });
      return null;
    } finally {
      this.setBusy(false);
    }
  }

  clip(mode) {
    const s = this.selectionInfo();
    if (!s.canModify) return;
    const paths = s.entries.map((e) => e.path);
    this.ctx.shell.clipboard.setFiles(paths, mode);
    this.view.paintCut();
    this.updateCommands();
  }

  paste() {
    const dir = this.currentDir();
    if (!dir) return;
    return ops.paste(this, dir);
  }

  rename() {
    const s = this.selectionInfo();
    if (!s.single || !s.canModify) return;
    this.view.beginRename(s.single.key);
  }

  isProtected(p) {
    return p === '/' || p === shared.home || shared.drives.some((d) => d.mountpoint === p);
  }

  async del(permanent) {
    const s = this.selectionInfo();
    if (!s.items.length) return;
    if (s.trash) return ops.deleteForever(this, s.entries);
    if (!s.canModify) return;
    const prot = s.entries.find((e) => this.isProtected(e.path));
    if (prot) {
      await this.ui.alert(this.t('errors.protected', { name: prot.name }), { title: this.t('appName'), parent: this.win });
      return;
    }
    if (permanent) await ops.deleteForever(this, s.entries);
    else await ops.trash(this, s.entries.map((e) => e.path));
  }

  async restoreAll() {
    const list = await this.api.invoke('fs:trashList').catch(() => []);
    if (!list.length) return;
    const ok = await this.ui.confirm(this.t('trash.restoreAllConfirm', { count: list.length }), { title: this.t('trash.restoreAll'), parent: this.win });
    if (ok) await ops.restore(this, list);
  }

  async newFolder() {
    const dir = this.currentDir();
    if (!dir) return;
    const e = await ops.createFolder(this, dir);
    if (!e) return;
    await this.refresh({ select: [e.path], quiet: true });
    this.view.beginRename(e.path, { isNew: true });
  }

  async newFile(kind) {
    const dir = this.currentDir();
    if (!dir) return;
    const e = await ops.createFile(this, dir, kind);
    if (!e) return;
    await this.refresh({ select: [e.path], quiet: true });
    this.view.beginRename(e.path, { isNew: true });
  }

  async compress(entries) {
    const zip = await ops.compress(this, entries);
    if (!zip) return;
    const dir = T.dirname(zip);
    if (this.currentDir() === dir) {
      await this.refresh({ select: [zip], quiet: true });
      this.view.beginRename(zip, { isNew: true });
    }
  }

  copyPath() {
    const s = this.selectionInfo();
    const paths = s.entries.length ? s.entries.map((e) => e.path) : this.currentDir() ? [this.currentDir()] : [];
    if (paths.length) ops.copyAsPath(this, paths);
  }

  openTerminal(dir) {
    if (dir) this.ctx.shell.launch('terminal', { cwd: dir });
  }

  properties(target) {
    return dlg.showProperties(this, target);
  }

  async propertiesForSelection(background = false) {
    const s = this.selectionInfo();
    if (!background && s.items.length) {
      const it = s.items[0];
      if (it.kind === 'drive') return this.properties({ drive: it.entry.drive });
      if (it.kind === 'trash') return this.properties({ trash: it.entry });
      if (s.entries.some((e) => e.missing)) return;
      return this.properties({ entries: s.entries });
    }
    if (s.loc.type === 'dir') {
      const st = await this.api.invoke('fs:stat', s.loc.path);
      if (st) this.properties({ entries: [st] });
    } else if (s.loc.type === 'thispc') this.ctx.shell.launch('settings', { page: 'about' });
  }

  // ---------------------------------------------------------------- view settings
  updateView(patch) {
    this.vs = { ...this.vs, ...patch };
    setView(this.viewKey(), this.vs);
    this.view.setViewSettings(this.vs);
    this.updateStatus();
    this.updateCommands();
  }

  setSort(sort, dir) {
    this.updateView({ sort, dir });
  }

  setMode(mode) {
    const loc = this.tab?.loc;
    if (!loc || loc.type === 'home' || loc.type === 'thispc') return;
    this.updateView({ mode });
  }

  zoomView(delta) {
    const order = ['details', 'list', 'small', 'medium', 'large', 'xl'];
    const i = order.indexOf(this.vs.mode);
    const next = order[Math.max(0, Math.min(order.length - 1, (i < 0 ? 3 : i) + delta))];
    if (next !== this.vs.mode) this.setMode(next);
  }

  togglePane(kind) {
    setPref('pane', shared.prefs.pane === kind ? null : kind);
  }

  // ---------------------------------------------------------------- keyboard
  focusRegion(dir = 1) {
    const regions = [this.address.el, this.nav.tree, this.view.scroller];
    const cur = regions.findIndex((r) => r.contains(document.activeElement));
    const next = regions[(cur + dir + regions.length) % regions.length];
    if (next === this.address.el) this.address.beginEdit();
    else next.focus();
  }

  onKey(e) {
    if (e.defaultPrevented || this.closed) return;
    if (e.target.closest?.('.dialog-layer, .fx-props, .fx-pg')) return;
    const k = e.key;
    const low = k.length === 1 ? k.toLowerCase() : k;
    const ctrl = e.ctrlKey || e.metaKey;
    const alt = e.altKey;
    const shift = e.shiftKey;
    const inInput = !!e.target.closest?.('input, textarea, [contenteditable="true"]');
    const inTree = this.nav.tree.contains(e.target);
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    // ---- window-wide
    if (ctrl && !alt && low === 't') return handled(), this.newTab();
    if (ctrl && !alt && low === 'w') return handled(), this.closeTab();
    if (ctrl && !alt && !shift && low === 'n') return handled(), this.ctx.shell.launch('files', { path: this.tab.loc.type === 'dir' ? this.tab.loc.path : this.tab.loc.type === 'search' ? 'home' : this.tab.loc.type });
    if ((ctrl && !shift && low === 'l') || (alt && low === 'd') || (k === 'F4' && !alt && !ctrl)) return handled(), this.address.beginEdit();
    if ((ctrl && (low === 'f' || low === 'e') && !shift) || k === 'F3') return handled(), this.search.focus();
    if (k === 'F5' || (ctrl && low === 'r')) return handled(), this.refresh();
    if (alt && k === 'ArrowLeft') return handled(), this.goBack();
    if (alt && k === 'ArrowRight') return handled(), this.goForward();
    if (alt && k === 'ArrowUp') return handled(), this.goUp();
    if (alt && k === 'Home') return handled(), this.navigate({ type: 'home' });
    if (k === 'BrowserBack') return handled(), this.goBack();
    if (k === 'BrowserForward') return handled(), this.goForward();
    if (ctrl && k === 'Tab') {
      handled();
      const i = this.tabs.indexOf(this.tab) + (shift ? -1 : 1);
      return this.activateTab(this.tabs[(i + this.tabs.length) % this.tabs.length]);
    }
    if (ctrl && !shift && !alt && /^[1-9]$/.test(k)) {
      handled();
      const i = k === '9' ? this.tabs.length - 1 : Number(k) - 1;
      return this.tabs[i] && this.activateTab(this.tabs[i]);
    }
    if (ctrl && shift && /^Digit[1-7]$/.test(e.code)) return handled(), this.setMode(VIEW_MODES[Number(e.code.slice(5)) - 1]);
    if (alt && !ctrl && low === 'p') return handled(), this.togglePane(shift ? 'details' : 'preview');
    if (k === 'F6') return handled(), this.focusRegion(shift ? -1 : 1);
    if (ctrl && shift && low === 'n') return handled(), this.newFolder();
    if (inInput) return;
    // ---- content commands (not while typing)
    if (ctrl && !shift && low === 'z') return handled(), ops.undo(this);
    if (inTree) return;
    if (ctrl && !shift && low === 'a') return handled(), this.view.selectAll();
    if (ctrl && !shift && low === 'c') return handled(), this.clip('copy');
    if (ctrl && !shift && low === 'x') return handled(), this.clip('cut');
    if (ctrl && !shift && low === 'v') return handled(), this.paste();
    if (ctrl && shift && low === 'c') return handled(), this.copyPath();
    if (k === 'Delete') return handled(), this.del(shift);
    if (k === 'F2') return handled(), this.rename();
    if (alt && k === 'Enter') return handled(), this.propertiesForSelection();
    if (k === 'Backspace' && !alt && !ctrl) return handled(), this.goBack();
    if (k === 'ContextMenu' || (shift && k === 'F10')) return handled(), this.view.menuAtFocus();
  }
}
