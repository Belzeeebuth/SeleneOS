// Aurora Browser — one browser window: tab strip (in the tall title bar), toolbar, favorites
// bar, find bar, the tab views (internal pages or <webview>s) and all the glue between them.
//
// Tab navigation model: a tab keeps a short list of "entries"; each is either an internal page
// ({ kind: 'internal', route, query }) or the single web entry ({ kind: 'web' }) that stands for
// the whole history of the tab's <webview>. Back/forward first walk the webview's own history and
// then step to the neighbouring internal entries (e.g. web page -> back -> New tab page).
import { h, icon, ui, clear } from './dom.js';
import { shared } from './shared.js';
import { classify, internalUrl, parseInternal, isInternal, isWebUrl, displayUrl, hostOf, netError, nextZoom, comboFromEvent, searchUrl, engineOf } from './util.js';
import { Omnibox } from './omnibox.js';
import { FavBar, barMode } from './favbar.js';
import { renderPage, pageTitle, pageIcon } from './pages.js';
import * as panels from './panels.js';
import { closeMenus, showMenu } from './menu.js';

let tabSeq = 0;
const reduceMotion = () => document.documentElement.dataset.animations === 'off';
const APP_ICON = 'app://shell/apps/browser/icon.svg';
const SVG_NS = 'http://www.w3.org/2000/svg';

/** Download progress ring around the toolbar button (real SVG elements: h() only makes HTML ones). */
function progressRing() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'bw-dl-ring');
  svg.setAttribute('viewBox', '0 0 36 36');
  svg.setAttribute('aria-hidden', 'true');
  const track = document.createElementNS(SVG_NS, 'circle');
  const bar = document.createElementNS(SVG_NS, 'circle');
  for (const c of [track, bar]) {
    c.setAttribute('cx', '18');
    c.setAttribute('cy', '18');
    c.setAttribute('r', '15');
    c.setAttribute('pathLength', '100');
  }
  track.setAttribute('class', 'track');
  bar.setAttribute('class', 'bar');
  svg.append(track, bar);
  return svg;
}

export class BrowserWindowCtl {
  constructor(ctx) {
    this.ctx = ctx;
    this.win = ctx.win;
    this.t = ctx.t;
    this.args = ctx.args || {};
    this.private = !!this.args.private;
    // All Private windows share one in-memory session (like InPrivate); it is wiped when the last one closes.
    if (this.private && !shared.privatePartition) shared.privatePartition = `browser-private-${Date.now().toString(36)}${++shared.privateSeq}`;
    this.partition = this.private ? shared.privatePartition : 'persist:browser';
    this.tabs = [];
    this.active = null;
    this.closedTabs = [];
    this.lastFocus = Date.now();
    this.fs = null; // null | 'user' | 'html'
    this.closing = false;
    this.flyout = null;
    this.subs = [];
  }

  get store() {
    return shared.store;
  }
  get prefs() {
    return shared.store.prefs;
  }

  async init() {
    if (this.private) await shared.api.invoke('browser:initPartition', this.partition);
    if (this.args.popup) {
      const { width, height } = this.args.popup;
      if (width && height) this.win.setSize(Math.max(520, Math.min(width + 16, 1400)), Math.max(420, Math.min(height + 130, 1000)));
    }
    this.build();
    shared.windows.push(this);
    this.wire();
    await this.openInitialTabs();
  }

  // ================================================================== DOM
  build() {
    const { t, win } = this;
    win.el.classList.add('bw-window');
    if (this.private) win.el.classList.add('bw-private');
    // ---- tab strip (title bar)
    this.tabsEl = h('div', { class: 'bw-tabs', role: 'tablist', 'aria-label': t('tabs.label') });
    this.newTabBtn = h('button', { class: 'bw-newtab no-drag', 'aria-label': t('tab.new'), onclick: () => this.newTab() }, icon('add', { size: 16 }));
    this.privateBadge = this.private ? h('div', { class: 'bw-private-badge no-drag', 'data-tip': t('private.tip') }, icon('window_inprivate', { size: 16 }), h('span', null, t('private.badge'))) : null;
    this.strip = h('div', { class: 'bw-strip' }, this.privateBadge, this.tabsEl, this.newTabBtn, h('div', { class: 'bw-strip-drag' }));
    win.titlebarSlot.appendChild(this.strip);
    this.tabsEl.addEventListener('wheel', (e) => {
      if (this.tabsEl.scrollWidth <= this.tabsEl.clientWidth) return;
      e.preventDefault();
      this.tabsEl.scrollLeft += e.deltaY || e.deltaX;
    }, { passive: false });
    this.tabsEl.addEventListener('keydown', (e) => this.onStripKey(e));
    this.tabsEl.addEventListener('scroll', () => this.updateStripOverflow(), { passive: true });
    new ResizeObserver(() => this.updateStripOverflow()).observe(this.tabsEl);
    this.strip.addEventListener('pointerleave', () => this.unlockTabWidths());

    // ---- toolbar
    const tb = (name, ic, onclick, extra = {}) => h('button', { class: ['bw-tbtn', extra.class], 'aria-label': t(name), onclick, ...extra.attrs }, icon(ic, { size: 18 }));
    this.backBtn = tb('nav.back', 'arrow_left', (e) => this.navClick(e, -1), { attrs: { oncontextmenu: (e) => this.navHistoryMenu(e, -1) } });
    this.fwdBtn = tb('nav.forward', 'arrow_right', (e) => this.navClick(e, 1), { attrs: { oncontextmenu: (e) => this.navHistoryMenu(e, 1) } });
    for (const [btn, dir] of [
      [this.backBtn, -1],
      [this.fwdBtn, 1],
    ]) {
      // Long press shows the history list, like right-click.
      btn.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        clearTimeout(this.pressTimer);
        this.pressTimer = setTimeout(() => {
          this.longPressed = true;
          this.navHistoryMenu({ preventDefault() {}, currentTarget: btn, target: btn, clientX: 0, clientY: 0, __el: btn }, dir);
        }, 550);
      });
      for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) btn.addEventListener(ev, () => clearTimeout(this.pressTimer));
    }
    this.reloadBtn = tb('nav.reload', 'arrow_clockwise', (e) => (this.active?.web.loading && this.isWeb(this.active) ? this.stop() : this.reload(e.shiftKey || e.ctrlKey)));
    this.homeBtn = tb('nav.home', 'home', () => this.goHome());
    this.omni = new Omnibox(this);
    this.favBtn = tb('fav.title', 'star_line_horizontal_3', () => panels.favoritesMenu(this, this.favBtn));
    this.dlBtn = h(
      'button',
      { class: 'bw-tbtn bw-dl-btn', 'aria-label': t('dl.title'), onclick: () => this.toggleDownloads() },
      icon('arrow_download', { size: 18 }),
      progressRing(),
      (this.dlBadge = h('span', { class: 'bw-dl-badge', hidden: true })),
    );
    this.moreBtn = tb('menu.more', 'more_horizontal', () => panels.moreMenu(this, this.moreBtn));
    this.toolbar = h(
      'div',
      { class: 'bw-toolbar', role: 'toolbar', 'aria-label': t('toolbar.label') },
      h('div', { class: 'bw-tb-group' }, this.backBtn, this.fwdBtn, this.reloadBtn, this.homeBtn),
      this.omni.el,
      h('div', { class: 'bw-tb-group' }, this.favBtn, this.dlBtn, this.moreBtn),
    );
    this.setTips();

    // ---- favorites bar
    this.favbar = new FavBar(this);

    // ---- content
    this.views = h('div', { class: 'bw-views' });
    this.status = h('div', { class: 'bw-status', 'aria-hidden': 'true' });
    this.findBar = panels.buildFindBar(this);
    this.fsHint = h('div', { class: 'bw-fs-hint', hidden: true });
    this.fsHot = h('div', { class: 'bw-fs-hot', onpointerenter: () => this.root.classList.add('bw-fs-reveal') });
    this.content = h('div', { class: 'bw-content' }, this.views, this.status, this.findBar.el, this.fsHint);
    this.chrome = h('div', { class: 'bw-chrome', onpointerleave: () => this.root.classList.remove('bw-fs-reveal') }, this.toolbar, this.favbar.el);
    this.root = h('div', { class: 'bw-root' }, this.fsHot, this.chrome, this.content);
    win.body.appendChild(this.root);
    this.applyPrefsToChrome();
  }

  setTips() {
    const { t } = this;
    const tip = (el, text) => {
      el.dataset.tip = text;
      el.dataset.tipPos = 'below';
    };
    tip(this.backBtn, `${t('nav.back')} (Alt+←)`);
    tip(this.fwdBtn, `${t('nav.forward')} (Alt+→)`);
    tip(this.homeBtn, `${t('nav.home')} (Alt+Home)`);
    tip(this.favBtn, `${t('fav.title')} (Ctrl+Shift+O)`);
    tip(this.dlBtn, `${t('dl.title')} (Ctrl+J)`);
    tip(this.moreBtn, `${t('menu.more')} (Alt+F)`);
    tip(this.newTabBtn, `${t('tab.new')} (Ctrl+T)`);
    this.newTabBtn.setAttribute('aria-label', t('tab.new'));
    this.updateReloadBtn();
  }

  wire() {
    const { win } = this;
    win.on('focus', () => {
      this.lastFocus = Date.now();
    });
    win.on('blur', () => {
      this.omni.closeSuggest();
      this.hideHoverCard();
    });
    win.on('resize', () => {
      this.favbar.layout();
      this.flyout?.place?.();
      this.omni.layout();
    });
    win.on('fullscreen', (on) => {
      if (!on && this.fs) this.setFullscreen(null, true);
    });
    win.el.addEventListener('keydown', (e) => this.onKeyDown(e));
    win.on('close', () => this.onClose());
    this.subs.push(shared.on('downloads', () => this.updateDownloadsButton()));
    this.subs.push(this.store.on('favicons', () => this.favbar.refreshIcons()));
    this.ctx.onLangChange(() => this.relocalize());
    this.updateDownloadsButton();
    this.audioTimer = setInterval(() => this.pollAudio(), 1000);
  }

  relocalize() {
    const { t } = this;
    this.setTips();
    for (const [el, key] of [
      [this.backBtn, 'nav.back'],
      [this.fwdBtn, 'nav.forward'],
      [this.homeBtn, 'nav.home'],
      [this.favBtn, 'fav.title'],
      [this.dlBtn, 'dl.title'],
      [this.moreBtn, 'menu.more'],
    ])
      el.setAttribute('aria-label', t(key));
    if (this.privateBadge) {
      this.privateBadge.querySelector('span').textContent = t('private.badge');
      this.privateBadge.dataset.tip = t('private.tip');
    }
    this.tabsEl.setAttribute('aria-label', t('tabs.label'));
    this.omni.relocalize();
    this.favbar.render();
    this.findBar.relocalize();
    for (const tab of this.tabs) {
      if (this.entry(tab)?.kind === 'internal') this.showEntry(tab, { rerender: true });
      else if (this.isWeb(tab) && tab.web.error) this.renderError(tab);
      this.updateTabEl(tab);
    }
    this.updateChrome();
  }

  // ================================================================== initial tabs / session
  async openInitialTabs() {
    const a = this.args;
    const s = this.store.session;
    if (a.restore?.tabs?.length) return this.restoreTabs(a.restore);
    const others = shared.windows.filter((w) => w !== this);
    if (!this.private && !a.url && !a.newWindow && !others.length && !shared.restoredOnce && this.prefs.startup === 'continue' && s?.windows?.length) {
      shared.restoredOnce = true;
      const [first, ...rest] = s.windows;
      this.restoreTabs(first);
      for (const w of rest) shared.shell.launch('browser', { newWindow: true, restore: w });
      return;
    }
    shared.restoredOnce = true;
    if (a.url) this.openUrl(a.url, { active: true });
    else if (a.route) this.newTab({ url: internalUrl(a.route, a.query) });
    else this.newTab();
  }

  restoreTabs(state) {
    const list = (state.tabs || []).filter((x) => x?.url);
    if (!list.length) return this.newTab();
    const activeIdx = Math.min(Math.max(0, state.active ?? 0), list.length - 1);
    const tabs = list.map((x) => this.createTab({ lazy: { url: x.url, title: x.title }, active: false, activateIfNone: false, animate: false }));
    this.activate(tabs[activeIdx]);
  }

  sessionState() {
    return {
      tabs: this.tabs.map((tab) => ({ url: this.tabUrl(tab), title: this.tabTitle(tab) })).filter((x) => x.url && x.url !== 'about:blank'),
      active: Math.max(0, this.tabs.indexOf(this.active)),
    };
  }

  saveSession() {
    if (!this.private && !this.closing) shared.saveSession();
  }

  onClose() {
    this.closing = true;
    clearInterval(this.audioTimer);
    for (const timer of [this.pressTimer, this.hoverTimer, this.statusTimer, this.fsHintTimer]) clearTimeout(timer);
    for (const off of this.subs) off();
    this.subs = [];
    closeMenus();
    this.closeFlyout();
    this.hideHoverCard();
    for (const tab of this.tabs) this.disposeTab(tab);
    for (const tab of this.tabs) for (const p of tab.perms || []) shared.api.invoke('browser:permissionReply', p.id, { allow: false }).catch(() => {});
    shared.windows = shared.windows.filter((w) => w !== this);
    if (!this.private) {
      const others = shared.windows.filter((w) => !w.private);
      if (others.length) shared.saveSession();
      else {
        // Last normal window: remember its tabs for "continue where you left off", and let the
        // next start of the browser (even in this desktop session) restore them.
        this.closing = false;
        shared.store.session = { windows: [this.sessionState()], saved: Date.now() };
        this.closing = true;
        shared.store.save('session', 0);
        shared.restoredOnce = false;
      }
    } else if (!shared.windows.some((w) => w.private && w.partition === this.partition)) {
      // Private session over: forget its finished downloads and wipe the in-memory partition.
      shared.privatePartition = null;
      for (const [id, d] of shared.downloads) if (d.partition === this.partition && d.state !== 'progressing') shared.downloads.delete(id);
      shared.emit('downloads');
      shared.api.invoke('browser:disposePartition', this.partition).catch(() => {});
    }
    shared.store.flush();
  }

  // ================================================================== tab helpers
  entry(tab) {
    return tab?.entries[tab.idx] || null;
  }
  isWeb(tab) {
    return this.entry(tab)?.kind === 'web';
  }
  tabUrl(tab) {
    if (!tab) return '';
    if (tab.lazy) return tab.lazy.url;
    const e = this.entry(tab);
    if (!e) return '';
    if (e.kind === 'internal') return e.url;
    return tab.web.url || '';
  }
  tabTitle(tab) {
    if (tab.lazy) return tab.lazy.title || tab.lazy.url;
    const e = this.entry(tab);
    if (!e) return this.t('tab.newTitle');
    if (e.kind === 'internal') return pageTitle(this, e);
    if (tab.web.error) return hostOf(tab.web.url) || tab.web.url;
    return tab.web.title || displayUrl(tab.web.url).replace(/^https?:\/\//, '') || this.t('tab.untitled');
  }
  tabFavicon(tab) {
    const url = this.tabUrl(tab);
    if (tab.lazy) return { img: this.store.favicon(url) };
    const e = this.entry(tab);
    if (!e) return { img: APP_ICON };
    if (e.kind === 'internal') return pageIcon(e);
    if (tab.web.error) return { icon: tab.web.error.cert ? 'shield_error' : 'document_error' };
    if (tab.web.crashed) return { icon: 'document_error' };
    return { img: tab.web.favicon || (this.private ? null : this.store.favicon(url)) };
  }

  // ================================================================== tabs
  newTab(opts = {}) {
    const url = opts.url || 'aurora://newtab';
    return this.createTab({ ...opts, url, active: opts.active !== false, focusOmni: opts.focusOmni ?? url === 'aurora://newtab' });
  }

  openUrl(url, opts = {}) {
    return this.createTab({ ...opts, url, active: opts.active !== false });
  }

  createTab({ url, lazy, active = true, index, opener, animate = true, focusOmni = false, openedByScript = false, activateIfNone = true } = {}) {
    const tab = {
      id: `t${++tabSeq}`,
      entries: [],
      idx: -1,
      wv: null,
      wcId: null,
      ready: false,
      web: { url: '', title: '', favicon: null, loading: false, error: null, crashed: false, audible: false, committed: false },
      muted: false,
      lazy: lazy || null,
      openerId: opener?.id || null,
      openedByScript,
      perms: [],
      blockedPopups: [],
      find: { open: false, text: '' },
      zoom: 1,
      omniText: null,
      created: Date.now(),
    };
    tab.view = h('div', { class: 'bw-view', dataset: { tab: tab.id } });
    tab.el = this.buildTabEl(tab);
    this.views.appendChild(tab.view);
    let at = typeof index === 'number' ? index : this.tabs.length;
    if (opener && typeof index !== 'number') {
      // Chrome-like: tabs opened from a page go right after it (and after its earlier children).
      const oi = this.tabs.indexOf(opener);
      at = oi + 1;
      while (at < this.tabs.length && this.tabs[at].openerId === opener.id) at++;
    }
    at = Math.max(0, Math.min(at, this.tabs.length));
    this.flipTabs(() => {
      this.tabs.splice(at, 0, tab);
      // Insert relative to the model, not to tabsEl.children: closing tabs stay in the DOM
      // for their exit animation.
      this.tabsEl.insertBefore(tab.el, this.tabs[at + 1]?.el || null);
    }, animate ? tab.el : null);
    if (!lazy && url) this.navigate(tab, url, { initial: true });
    this.updateTabEl(tab);
    if (active || (!this.active && activateIfNone)) this.activate(tab, { focusOmni });
    this.saveSession();
    return tab;
  }

  buildTabEl(tab) {
    const { t } = this;
    const iconBox = h('span', { class: 'bw-tab-icon' });
    const title = h('span', { class: 'bw-tab-title' });
    const audio = h('button', {
      class: 'bw-tab-audio',
      tabindex: '-1',
      onclick: (e) => {
        e.stopPropagation();
        this.setMuted(tab, !tab.muted);
      },
    });
    const close = h(
      'button',
      {
        class: 'bw-tab-close',
        tabindex: '-1',
        'aria-label': t('tab.close'),
        'data-tip': `${t('tab.close')} (Ctrl+W)`,
        onclick: (e) => {
          e.stopPropagation();
          this.closeTab(tab, { byMouse: true });
        },
      },
      icon('dismiss', { size: 12 }),
    );
    const el = h('div', { class: 'bw-tab no-drag', role: 'tab', tabindex: '-1', 'aria-selected': 'false', dataset: { tab: tab.id } }, h('div', { class: 'bw-tab-bg' }), iconBox, title, audio, close);
    tab.parts = { iconBox, title, audio, close };
    el.addEventListener('pointerdown', (e) => {
      this.hideHoverCard();
      this.onTabPointerDown(e, tab);
    });
    el.addEventListener('pointerenter', () => this.scheduleHoverCard(tab));
    el.addEventListener('pointerleave', () => this.hideHoverCard());
    el.addEventListener('mousedown', (e) => {
      if (e.button === 1) e.preventDefault(); // no autoscroll
    });
    el.addEventListener('auxclick', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        this.closeTab(tab, { byMouse: true });
      }
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      panels.tabMenu(this, tab, e);
    });
    return el;
  }

  updateTabEl(tab) {
    if (!tab?.el) return;
    const { iconBox, title, audio, close } = tab.parts;
    const loading = !tab.lazy && this.isWeb(tab) && tab.web.loading && !tab.web.error;
    const fav = this.tabFavicon(tab);
    const key = loading ? 'spin' : fav.img ? `img:${fav.img}` : `icon:${fav.icon || 'globe'}`;
    if (iconBox.dataset.key !== key) {
      iconBox.dataset.key = key;
      clear(iconBox);
      if (loading) iconBox.appendChild(h('span', { class: 'bw-spinner' }));
      else if (fav.img) {
        const img = h('img', { src: fav.img, alt: '', draggable: false });
        img.onerror = () => {
          img.replaceWith(icon('globe', { size: 16 }));
        };
        iconBox.appendChild(img);
      } else iconBox.appendChild(icon(fav.icon || 'globe', { size: 16 }));
    }
    const text = this.tabTitle(tab);
    if (title.textContent !== text) title.textContent = text;
    tab.el.setAttribute('aria-label', text);
    const audible = tab.web.audible || tab.muted;
    tab.el.classList.toggle('audible', !!audible);
    if (audible) {
      const ic = tab.muted ? 'speaker_mute' : 'speaker_2';
      if (audio.dataset.icon !== ic) {
        audio.dataset.icon = ic;
        clear(audio).appendChild(icon(ic, { size: 14 }));
      }
      const tip = tab.muted ? this.t('tab.unmute') : this.t('tab.mute');
      audio.dataset.tip = tip;
      audio.setAttribute('aria-label', tip);
    }
    close.setAttribute('aria-label', this.t('tab.close'));
    tab.el.classList.toggle('loading', loading);
    tab.el.classList.toggle('private', this.private);
  }

  // Edge-style hover card under a tab: title + site.
  scheduleHoverCard(tab) {
    clearTimeout(this.hoverTimer);
    const delay = this.hoverCard?.isConnected ? 60 : 500;
    this.hoverTimer = setTimeout(() => this.showHoverCard(tab), delay);
  }
  showHoverCard(tab) {
    if (this.tabsEl.classList.contains('dragging') || !tab.el.isConnected || tab.closed) return;
    const url = this.tabUrl(tab);
    const host = isInternal(url) ? this.t('site.internal') : hostOf(url) || displayUrl(url);
    if (!this.hoverCard) this.hoverCard = h('div', { class: 'bw-hovercard', role: 'tooltip' });
    const card = this.hoverCard;
    clear(card);
    card.append(h('div', { class: 'bw-hc-title' }, this.tabTitle(tab)), h('div', { class: 'bw-hc-host' }, host));
    if (tab.web.audible && this.isWeb(tab)) card.appendChild(h('div', { class: 'bw-hc-host' }, icon(tab.muted ? 'speaker_mute' : 'speaker_2', { size: 12 }), ' ', tab.muted ? this.t('tab.unmute') : this.t('tab.mute')));
    const fresh = !card.isConnected;
    if (fresh) this.win.el.appendChild(card);
    const wr = this.win.el.getBoundingClientRect();
    const r = tab.el.getBoundingClientRect();
    const left = Math.max(4, Math.min(r.left - wr.left, wr.width - card.offsetWidth - 4));
    card.style.left = `${Math.round(left)}px`;
    card.style.top = `${Math.round(r.bottom - wr.top + 6)}px`;
    if (fresh) card.classList.add('in');
  }
  hideHoverCard() {
    clearTimeout(this.hoverTimer);
    this.hoverCard?.remove();
  }

  updateStripOverflow() {
    const c = this.tabsEl;
    const over = c.scrollWidth > c.clientWidth + 1;
    c.classList.toggle('ov-l', over && c.scrollLeft > 2);
    c.classList.toggle('ov-r', over && c.scrollLeft + c.clientWidth < c.scrollWidth - 2);
  }

  activate(tab, { focusOmni = false, focusPage = true } = {}) {
    if (!tab || this.closing) return;
    const prev = this.active;
    if (prev && prev !== tab) {
      prev.el.classList.remove('active');
      prev.el.setAttribute('aria-selected', 'false');
      prev.el.tabIndex = -1;
      prev.view.classList.remove('active');
      prev.omniText = this.omni.editing && this.omni.dirty && this.omni.userText ? this.omni.userText : null;
    }
    this.active = tab;
    tab.lastActive = Date.now();
    tab.el.classList.add('active');
    tab.el.setAttribute('aria-selected', 'true');
    tab.el.tabIndex = 0;
    tab.view.classList.add('active');
    this.closeFlyout();
    if (prev !== tab) this.omni.reset();
    if (tab.lazy) {
      const { url } = tab.lazy;
      tab.lazy = null;
      this.navigate(tab, url, { initial: true });
    }
    this.scrollTabIntoView(tab);
    this.updateChrome();
    this.findBar.sync();
    if (this.isWeb(tab) && tab.wv && tab.ready) this.refreshZoom(tab);
    if (focusOmni || (this.entry(tab)?.route === 'newtab' && !focusPage)) this.omni.focus();
    else if (focusPage) this.focusPage(tab);
    if (tab.omniText) this.omni.setEditedText(tab.omniText);
    if (tab.perms.length) setTimeout(() => this.showNextPermission(tab), 50);
    this.saveSession();
  }

  focusPage(tab = this.active) {
    if (!tab || this.active !== tab) return;
    if (this.entry(tab)?.route === 'newtab') {
      this.omni.focus();
      return;
    }
    if (this.dialogOpen()) return; // never pull focus out of a modal dialog
    if (this.isWeb(tab) && tab.wv) {
      setTimeout(() => {
        if (this.active === tab && !this.omni.editing && !this.dialogOpen()) tab.wv.focus();
      }, 0);
    } else tab.pageEl?.focus?.({ preventScroll: true });
  }

  dialogOpen() {
    return !!this.win.el.querySelector('.dialog-layer:not(.closing)');
  }

  scrollTabIntoView(tab) {
    requestAnimationFrame(() => this.updateStripOverflow());
    const el = tab.el;
    const c = this.tabsEl;
    if (c.scrollWidth <= c.clientWidth) return;
    const l = el.offsetLeft;
    const r = l + el.offsetWidth;
    if (l < c.scrollLeft) c.scrollTo({ left: l - 8, behavior: reduceMotion() ? 'auto' : 'smooth' });
    else if (r > c.scrollLeft + c.clientWidth) c.scrollTo({ left: r - c.clientWidth + 8, behavior: reduceMotion() ? 'auto' : 'smooth' });
  }

  closeTab(tab, { byMouse = false, skipStack = false } = {}) {
    if (!tab || !this.tabs.includes(tab)) return;
    this.hideHoverCard();
    const i = this.tabs.indexOf(tab);
    if (!skipStack && !tab.lazy) {
      const url = this.tabUrl(tab);
      if (url && url !== 'aurora://newtab' && url !== 'about:blank') this.closedTabs.push({ url, title: this.tabTitle(tab), index: i });
      if (this.closedTabs.length > 25) this.closedTabs.shift();
    } else if (!skipStack && tab.lazy) this.closedTabs.push({ url: tab.lazy.url, title: tab.lazy.title, index: i });
    for (const p of tab.perms) shared.api.invoke('browser:permissionReply', p.id, { allow: false }).catch(() => {});
    tab.perms = [];
    if (this.tabs.length === 1) {
      // Closing the last tab closes the window (like Edge / Chrome); the window keeps the tab so
      // "continue where you left off" restores it, and onClose() releases it.
      this.win.close();
      return;
    }
    if (byMouse) this.lockTabWidths();
    let next = null;
    if (this.active === tab) {
      const opener = tab.openerId && this.tabs.find((x) => x.id === tab.openerId);
      const sibling = this.tabs[i + 1] && this.tabs[i + 1].openerId === tab.openerId && tab.openerId ? this.tabs[i + 1] : null;
      next = sibling || (opener && this.tabs[i + 1]?.openerId !== tab.openerId ? opener : null) || this.tabs[i + 1] || this.tabs[i - 1];
    }
    this.tabs.splice(i, 1);
    tab.closed = true;
    if (tab.find.open) this.findBar.stop(tab);
    this.disposeTab(tab);
    const el = tab.el;
    el.classList.add('closing');
    const finish = () => {
      this.flipTabs(() => el.remove());
      tab.view.remove();
      tab.wv = null;
    };
    if (reduceMotion()) finish();
    else el.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(6px) scale(0.96)' }], { duration: 120, easing: 'cubic-bezier(0.7, 0, 1, 0.5)' }).finished.then(finish, finish);
    if (next) this.activate(next);
    this.saveSession();
  }

  /** Release what a tab holds outside its own DOM (internal page store listeners). */
  disposeTab(tab) {
    this.cancelAuth(tab);
    try {
      tab.page?.destroy?.();
    } catch (err) {
      console.error('[browser] page destroy failed', err);
    }
    tab.page = null;
    tab.pageEntry = null;
  }

  closeOtherTabs(keep) {
    // Activate the survivor first so closing the others never activates (and loads) them.
    this.activate(keep);
    for (const tab of [...this.tabs]) if (tab !== keep) this.closeTab(tab);
  }

  closeTabsToRight(tab) {
    const i = this.tabs.indexOf(tab);
    const doomed = this.tabs.slice(i + 1);
    if (doomed.includes(this.active)) this.activate(tab);
    for (const x of doomed) this.closeTab(x);
  }

  reopenClosed() {
    const c = this.closedTabs.pop();
    if (!c) return null;
    return this.createTab({ url: c.url, active: true, index: Math.min(c.index, this.tabs.length) });
  }

  duplicateTab(tab) {
    const url = this.tabUrl(tab);
    return this.createTab({ url, index: this.tabs.indexOf(tab) + 1, active: true });
  }

  moveTab(tab, to) {
    const from = this.tabs.indexOf(tab);
    if (from < 0 || to === from) return;
    this.tabs.splice(from, 1);
    this.tabs.splice(to, 0, tab);
    this.tabsEl.insertBefore(tab.el, this.tabs[to + 1]?.el || null);
    this.saveSession();
  }

  moveTabToNewWindow(tab) {
    const url = this.tabUrl(tab);
    this.closeTab(tab, { skipStack: true });
    shared.shell.launch('browser', { newWindow: true, private: this.private || undefined, url });
  }

  selectTab(i) {
    const tab = i < 0 ? this.tabs[this.tabs.length - 1] : this.tabs[i];
    if (tab) this.activate(tab);
  }

  cycleTab(dir) {
    if (this.tabs.length < 2) return;
    const i = this.tabs.indexOf(this.active);
    this.activate(this.tabs[(i + dir + this.tabs.length) % this.tabs.length]);
  }

  // FLIP animation of the tab strip around a DOM mutation (insertion / removal / reorder).
  flipTabs(mutate, entering = null) {
    if (reduceMotion()) return mutate();
    const before = new Map();
    for (const el of this.tabsEl.children) before.set(el, el.getBoundingClientRect().left);
    const plusBefore = this.newTabBtn.getBoundingClientRect().left;
    mutate();
    for (const el of this.tabsEl.children) {
      if (el === entering) continue;
      const old = before.get(el);
      if (old == null) continue;
      const dx = old - el.getBoundingClientRect().left;
      if (Math.abs(dx) > 0.5) el.animate([{ transform: `translateX(${dx}px)` }, { transform: 'none' }], { duration: 200, easing: 'cubic-bezier(0.1, 0.9, 0.2, 1)' });
    }
    const pdx = plusBefore - this.newTabBtn.getBoundingClientRect().left;
    if (Math.abs(pdx) > 0.5) this.newTabBtn.animate([{ transform: `translateX(${pdx}px)` }, { transform: 'none' }], { duration: 200, easing: 'cubic-bezier(0.1, 0.9, 0.2, 1)' });
    if (entering) entering.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: 'cubic-bezier(0.1, 0.9, 0.2, 1)' });
  }

  // While closing tabs with the mouse, keep widths stable so the next close button lands
  // under the pointer (released when the pointer leaves the strip).
  lockTabWidths() {
    if (this.tabsEl.classList.contains('locked')) return;
    const w = this.active?.el.getBoundingClientRect().width || 0;
    if (!w) return;
    this.tabsEl.style.setProperty('--locked-w', `${Math.round(w)}px`);
    this.tabsEl.classList.add('locked');
  }
  unlockTabWidths() {
    if (!this.tabsEl.classList.contains('locked')) return;
    this.flipTabs(() => this.tabsEl.classList.remove('locked'));
  }

  // ---- drag to reorder
  onTabPointerDown(e, tab) {
    if (e.button !== 0 || e.target.closest('.bw-tab-close, .bw-tab-audio')) return;
    this.activate(tab);
    const el = tab.el;
    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;
    let rects = null;
    let from = this.tabs.indexOf(tab);
    let to = from;
    const pointerId = e.pointerId;
    const move = (ev) => {
      const dx = ev.clientX - startX;
      if (!dragging) {
        if (Math.abs(dx) < 5 && Math.abs(ev.clientY - startY) < 5) return;
        if (this.tabs.length < 2) return;
        dragging = true;
        el.setPointerCapture?.(pointerId);
        rects = this.tabs.map((x) => x.el.getBoundingClientRect());
        from = this.tabs.indexOf(tab);
        to = from;
        this.tabsEl.classList.add('dragging');
        el.classList.add('drag');
      }
      const first = rects[0].left;
      const last = rects[rects.length - 1].right;
      const w = rects[from].width;
      const minDx = first - rects[from].left;
      const maxDx = last - rects[from].right;
      const cx = Math.max(minDx, Math.min(maxDx, dx));
      el.style.transform = `translateX(${cx}px)`;
      const center = rects[from].left + w / 2 + cx;
      to = from;
      for (let j = 0; j < rects.length; j++) {
        if (j === from) continue;
        const mid = rects[j].left + rects[j].width / 2;
        if (j > from && center >= mid - 1) to = Math.max(to, j);
        if (j < from && center <= mid + 1) to = Math.min(to, j);
      }
      this.tabs.forEach((x, j) => {
        if (x === tab) return;
        let shift = 0;
        if (from < to && j > from && j <= to) shift = -w;
        if (from > to && j < from && j >= to) shift = w;
        x.el.style.transform = shift ? `translateX(${shift}px)` : '';
      });
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      if (!dragging) return;
      this.tabsEl.classList.remove('dragging');
      const before = el.getBoundingClientRect().left;
      for (const x of this.tabs) x.el.style.transform = '';
      el.classList.remove('drag');
      if (to !== from) this.moveTab(tab, to);
      const after = el.getBoundingClientRect().left;
      if (!reduceMotion() && Math.abs(before - after) > 0.5) el.animate([{ transform: `translateX(${before - after}px)` }, { transform: 'none' }], { duration: 180, easing: 'cubic-bezier(0.1, 0.9, 0.2, 1)' });
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  onStripKey(e) {
    const i = this.tabs.indexOf(this.active);
    let next = null;
    if (e.key === 'ArrowRight') next = this.tabs[(i + 1) % this.tabs.length];
    else if (e.key === 'ArrowLeft') next = this.tabs[(i - 1 + this.tabs.length) % this.tabs.length];
    else if (e.key === 'Home') next = this.tabs[0];
    else if (e.key === 'End') next = this.tabs[this.tabs.length - 1];
    else if (e.key === 'Delete') {
      e.preventDefault();
      this.closeTab(this.active);
      this.active?.el.focus();
      return;
    } else if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
      e.preventDefault();
      const r = this.active.el.getBoundingClientRect();
      panels.tabMenu(this, this.active, { x: r.left + 12, y: r.bottom });
      return;
    }
    if (next) {
      e.preventDefault();
      this.activate(next, { focusPage: false });
      next.el.focus();
    }
  }

  // ================================================================== navigation
  navigate(tab, input, opts = {}) {
    if (!tab) return;
    const c = typeof input === 'object' && input ? input : classify(input, this.prefs.engine);
    if (!c) return;
    tab.omniText = null;
    if (tab.lazy) tab.lazy = null;
    if (c.type === 'internal') return this.goInternal(tab, c.route === 'notfound' ? 'notfound' : c.route, c.query || {}, c.url);
    if (c.type === 'blocked') return this.goInternal(tab, 'blocked', { url: c.url }, c.url);
    if (c.type === 'external') {
      this.openExternal(c.url);
      return;
    }
    return this.goWeb(tab, c.url, opts);
  }

  goInternal(tab, route, query = {}, url) {
    const entry = { kind: 'internal', route, query, url: route === 'blocked' || route === 'notfound' ? url : internalUrl(route, query) };
    const cur = this.entry(tab);
    if (cur?.kind === 'internal' && cur.url === entry.url) {
      this.showEntry(tab, { rerender: true });
      return;
    }
    if (cur?.kind === 'web') this.pauseMedia(tab);
    tab.entries = tab.entries.slice(0, tab.idx + 1);
    tab.entries.push(entry);
    tab.idx = tab.entries.length - 1;
    this.showEntry(tab);
  }

  goWeb(tab, url, opts = {}) {
    const cur = this.entry(tab);
    if (cur?.kind !== 'web') {
      const webIdx = tab.entries.findIndex((x) => x.kind === 'web');
      if (webIdx >= 0 && webIdx < tab.idx) {
        tab.entries = tab.entries.slice(0, webIdx + 1);
        tab.idx = webIdx;
      } else {
        if (webIdx > tab.idx) this.destroyWebview(tab);
        tab.entries = tab.entries.slice(0, tab.idx + 1);
        tab.entries.push({ kind: 'web' });
        tab.idx = tab.entries.length - 1;
      }
    }
    tab.web.error = null;
    tab.web.crashed = false;
    tab.web.url = url;
    tab.web.loading = true;
    tab.blockedPopups = [];
    this.loadInWebview(tab, url, opts);
    this.showEntry(tab);
  }

  loadInWebview(tab, url, { reloadSame = false } = {}) {
    if (!tab.wv) {
      this.createWebview(tab, url);
      return;
    }
    if (tab.ready) tab.wv.loadURL(url).catch(() => {});
    else {
      // Not attached yet: start over with a fresh element (changing src on a live guest would
      // report failed loads as console errors).
      tab.wv.remove();
      tab.wv = null;
      tab.wcId = null;
      this.createWebview(tab, url);
    }
  }

  createWebview(tab, url) {
    const wv = document.createElement('webview');
    wv.setAttribute('partition', this.partition);
    wv.setAttribute('allowpopups', '');
    wv.setAttribute('webpreferences', 'spellcheck=no, autoplayPolicy=document-user-activation-required');
    wv.className = 'bw-webview';
    wv.setAttribute('src', url);
    tab.wv = wv;
    tab.ready = false;
    this.bindWebview(tab, wv);
    tab.view.prepend(wv);
  }

  destroyWebview(tab) {
    if (!tab.wv) return;
    tab.wv.remove();
    tab.wv = null;
    tab.wcId = null;
    tab.ready = false;
    tab.web = { url: '', title: '', favicon: null, loading: false, error: null, crashed: false, audible: false, committed: false };
  }

  bindWebview(tab, wv) {
    const on = (ev, fn) =>
      wv.addEventListener(ev, (e) => {
        if (tab.wv !== wv || tab.closed) return;
        try {
          fn(e);
        } catch (err) {
          console.error(`[browser] ${ev}`, err);
        }
      });
    const isActive = () => this.active === tab;
    on('did-attach', () => {
      if (tab.closed || !wv.isConnected) return;
      try {
        tab.wcId = wv.getWebContentsId();
        // The guest exists from here on: its methods (loadURL, canGoBack…) are usable.
        tab.ready = true;
        if (tab.muted) wv.setAudioMuted(true);
      } catch {}
    });
    on('dom-ready', () => {
      if (tab.closed) return;
      if (tab.wcId == null) tab.wcId = wv.getWebContentsId();
      if (!tab.ready && tab.muted) wv.setAudioMuted(true);
      tab.ready = true;
      if (isActive()) this.updateNavButtons();
    });
    on('did-start-loading', () => {
      tab.web.loading = true;
      this.updateTabEl(tab);
      if (isActive()) this.updateChrome({ keepOmni: true });
    });
    on('did-stop-loading', () => {
      tab.web.loading = false;
      this.cancelAuth(tab); // stopped (Esc / Stop): the request that wanted credentials is gone
      this.updateTabEl(tab);
      if (isActive()) {
        this.updateChrome({ keepOmni: true });
        this.refreshZoom(tab);
      }
    });
    on('did-start-navigation', (e) => {
      if (!e.isMainFrame || e.isInPlace) return;
      this.cancelAuth(tab);
      tab.web.error = null;
      tab.web.crashed = false;
      tab.errorEl?.remove();
      tab.errorEl = null;
    });
    on('did-navigate', (e) => {
      let url = e.url;
      try {
        // view-source: pages report the inner URL here; keep the scheme for the omnibox.
        const cur = wv.getURL();
        if (cur.startsWith('view-source:') && cur.endsWith(e.url)) url = cur;
      } catch {}
      e = { url, httpResponseCode: e.httpResponseCode };
      tab.web.url = e.url;
      tab.web.committed = true;
      tab.web.error = null;
      const ti = wv.getTitle();
      tab.web.title = ti && ti !== e.url && !e.url.endsWith(ti) ? ti : '';
      tab.web.favicon = this.private ? null : this.store.favicon(e.url);
      tab.blockedPopups = [];
      if (!this.private) this.store.addVisit(e.url, '');
      if (tab.find.open) this.findBar.refresh(tab);
      this.updateTabEl(tab);
      if (isActive()) this.updateChrome();
      this.saveSession();
    });
    on('did-navigate-in-page', (e) => {
      if (!e.isMainFrame) return;
      tab.web.url = e.url;
      if (!this.private) this.store.addVisit(e.url, tab.web.title);
      if (isActive()) this.updateChrome();
      this.saveSession();
    });
    on('did-fail-load', (e) => {
      if (!e.isMainFrame || e.errorCode === -3) return;
      tab.web.error = { ...netError(e.errorCode, e.errorDescription), url: e.validatedURL || tab.web.url };
      tab.web.url = e.validatedURL || tab.web.url;
      tab.web.loading = false;
      this.renderError(tab);
      this.updateTabEl(tab);
      if (isActive()) this.updateChrome();
    });
    on('page-title-updated', (e) => {
      tab.web.title = e.title;
      if (!this.private) this.store.setHistoryTitle(tab.web.url, e.title);
      this.updateTabEl(tab);
      if (isActive()) this.updateWindowTitle();
      this.saveSession();
    });
    on('page-favicon-updated', async (e) => {
      const src = (e.favicons || [])[0];
      if (!src) return;
      const pageUrl = tab.web.url;
      const data = await shared.api.invoke('browser:favicon', src, this.partition).catch(() => null);
      if (!data || tab.web.url !== pageUrl) return;
      tab.web.favicon = data;
      if (!this.private) this.store.setFavicon(pageUrl, data);
      this.updateTabEl(tab);
    });
    on('update-target-url', (e) => {
      if (isActive()) this.setStatus(e.url);
    });
    on('found-in-page', (e) => this.findBar.onResult(tab, e.result));
    on('enter-html-full-screen', () => {
      if (isActive()) this.setFullscreen('html');
    });
    on('leave-html-full-screen', () => {
      if (this.fs === 'html') this.setFullscreen(null);
    });
    on('media-started-playing', () => {
      tab.web.audible = true;
      tab.audibleAt = Date.now();
      this.updateTabEl(tab);
    });
    on('media-paused', () => setTimeout(() => this.pollAudio(tab), 300));
    on('focus', () => {
      closeMenus();
      this.omni.closeSuggest();
      if (this.flyout && !this.flyout.sticky) this.closeFlyout();
      if (!this.win.isFocused?.()) this.win.focus();
    });
    on('close', () => {
      if (tab.openedByScript) this.closeTab(tab);
    });
    on('render-process-gone', (e) => {
      if (e.details?.reason === 'clean-exit') return;
      tab.web.crashed = true;
      tab.web.loading = false;
      tab.web.error = { code: 0, name: e.details?.reason === 'oom' ? 'Out of Memory' : 'RESULT_CODE_KILLED', kind: 'crash', url: tab.web.url };
      this.renderError(tab);
      this.updateTabEl(tab);
      if (isActive()) this.updateChrome();
    });
  }

  pollAudio(only) {
    // media-started-playing turns the indicator on; polling (cheap, only audible tabs) turns it off
    // once the tab has been silent for a moment (like Chrome's "recently audible"), so short
    // silences never make it flicker.
    const now = Date.now();
    for (const tab of only ? [only] : this.tabs.filter((x) => x.web.audible)) {
      if (!tab.wv || !tab.ready) continue;
      let audible = false;
      try {
        audible = tab.wv.isCurrentlyAudible();
      } catch {}
      if (audible) tab.audibleAt = now;
      else if (tab.web.audible && now - (tab.audibleAt || 0) < 2500) continue;
      if (audible !== tab.web.audible) {
        tab.web.audible = audible;
        this.updateTabEl(tab);
      }
    }
  }

  setMuted(tab, muted) {
    tab.muted = !!muted;
    try {
      if (tab.wv && tab.ready) tab.wv.setAudioMuted(tab.muted);
    } catch {}
    this.updateTabEl(tab);
  }

  pauseMedia(tab) {
    if (!tab.wv || !tab.ready) return;
    tab.wv.executeJavaScript('document.querySelectorAll("video,audio").forEach((m) => { try { m.pause(); } catch {} });', false).catch(() => {});
  }

  showEntry(tab, { rerender = false } = {}) {
    const e = this.entry(tab);
    if (!e) return;
    tab.view.classList.toggle('web', e.kind === 'web');
    tab.view.classList.toggle('internal', e.kind === 'internal');
    if (e.kind === 'internal') {
      if (rerender || tab.pageEntry !== e) {
        tab.page?.destroy?.();
        tab.pageEl?.remove();
        const page = renderPage(this, tab, e);
        tab.page = page;
        tab.pageEl = page.el;
        tab.pageEntry = e;
        if (tab.internalZoom && tab.internalZoom !== 1) tab.pageEl.style.zoom = String(tab.internalZoom);
        tab.view.appendChild(page.el);
      }
      tab.errorEl?.remove();
      tab.errorEl = null;
      if (tab.find.open) this.findBar.close(tab);
    } else {
      tab.page?.destroy?.();
      tab.page = null;
      tab.pageEl?.remove();
      tab.pageEl = null;
      tab.pageEntry = null;
      if (tab.web.error) this.renderError(tab);
    }
    this.updateTabEl(tab);
    if (this.active === tab) this.updateChrome();
    this.saveSession();
  }

  renderError(tab) {
    tab.errorEl?.remove();
    tab.errorEl = panels.errorPage(this, tab);
    tab.view.appendChild(tab.errorEl);
  }

  canGoBack(tab = this.active) {
    if (!tab || tab.lazy) return false;
    if (this.isWeb(tab) && tab.wv && tab.ready) {
      try {
        if (tab.wv.canGoBack()) return true;
      } catch {}
    }
    return tab.idx > 0;
  }
  canGoForward(tab = this.active) {
    if (!tab || tab.lazy) return false;
    if (this.isWeb(tab) && tab.wv && tab.ready) {
      try {
        if (tab.wv.canGoForward()) return true;
      } catch {}
    }
    return tab.idx < tab.entries.length - 1;
  }

  goBack(tab = this.active) {
    if (!tab) return;
    if (this.isWeb(tab) && tab.wv && tab.ready) {
      try {
        if (tab.wv.canGoBack()) {
          tab.wv.goBack();
          return;
        }
      } catch {}
    }
    if (tab.idx > 0) {
      if (this.isWeb(tab)) this.pauseMedia(tab);
      tab.idx--;
      this.showEntry(tab);
    }
  }

  goForward(tab = this.active) {
    if (!tab) return;
    if (this.isWeb(tab) && tab.wv && tab.ready) {
      try {
        if (tab.wv.canGoForward()) {
          tab.wv.goForward();
          return;
        }
      } catch {}
    }
    if (tab.idx < tab.entries.length - 1) {
      if (this.isWeb(tab)) this.pauseMedia(tab);
      tab.idx++;
      this.showEntry(tab);
    }
  }

  navClick(e, dir) {
    if (this.longPressed) {
      this.longPressed = false;
      return;
    }
    if (dir < 0) this.goBack();
    else this.goForward();
  }

  async navHistoryMenu(e, dir) {
    e.preventDefault();
    const tab = this.active;
    if (!tab) return;
    const anchor = dir < 0 ? this.backBtn : this.fwdBtn;
    const items = [];
    const webItem = (x, go) => {
      const fav = isInternal(x.url) ? APP_ICON : this.private ? null : this.store.favicon(x.url);
      return { label: x.title || displayUrl(x.url), img: fav || undefined, icon: fav ? undefined : 'globe', title: displayUrl(x.url), action: go };
    };
    const internalItem = (en, idx) => {
      const pi = pageIcon(en);
      return { label: pageTitle(this, en), img: pi.img, icon: pi.img ? undefined : pi.icon || 'tab_desktop', action: () => this.goToEntry(tab, idx) };
    };
    // The web part of the tab's history, with page titles (Chromium keeps them per entry).
    let hist = null;
    if (this.isWeb(tab) && tab.wv && tab.ready && tab.wcId != null) hist = await shared.api.invoke('browser:navHistory', tab.wcId).catch(() => null);
    if (this.active !== tab || this.closing) return;
    const webSteps = [];
    if (hist?.entries?.length) {
      const list = hist.entries;
      if (dir < 0) for (let i = hist.index - 1; i >= 0 && webSteps.length < 12; i--) webSteps.push({ ...list[i], off: i - hist.index });
      else for (let i = hist.index + 1; i < list.length && webSteps.length < 12; i++) webSteps.push({ ...list[i], off: i - hist.index });
    }
    for (const x of webSteps) items.push(webItem(x, () => tab.wv?.goToOffset(x.off)));
    if (dir < 0) {
      for (let i = tab.idx - 1; i >= 0; i--) if (tab.entries[i].kind === 'internal') items.push(internalItem(tab.entries[i], i));
    } else {
      for (let i = tab.idx + 1; i < tab.entries.length; i++) {
        const en = tab.entries[i];
        if (en.kind === 'internal') items.push(internalItem(en, i));
        else items.push(webItem({ url: tab.web.url, title: tab.web.title }, () => this.goToEntry(tab, i)));
      }
    }
    if (!items.length) return;
    items.push('-', { label: this.t('nav.fullHistory'), icon: 'history', shortcut: 'Ctrl+H', action: () => this.openInternal('history') });
    anchor.classList.add('open');
    showMenu(anchor, items.slice(0, 16).concat(items.length > 16 ? items.slice(-2) : []), {
      className: this.private ? 'bw-private' : '',
      onClose: () => anchor.classList.remove('open'),
    });
  }

  goToEntry(tab, idx) {
    if (!tab.entries[idx]) return;
    if (this.isWeb(tab)) this.pauseMedia(tab);
    tab.idx = idx;
    this.showEntry(tab);
  }

  reload(ignoreCache = false, tab = this.active) {
    if (!tab) return;
    if (tab.lazy) return this.activate(tab);
    const e = this.entry(tab);
    if (!e) return;
    if (e.kind === 'internal') {
      if (e.route === 'blocked' || e.route === 'notfound') return;
      this.showEntry(tab, { rerender: true });
      return;
    }
    if (!tab.wv || !tab.ready) return this.loadInWebview(tab, tab.web.error?.url || tab.web.url);
    if (tab.web.error || tab.web.crashed) {
      const url = tab.web.error?.url || tab.web.url;
      tab.web.error = null;
      tab.web.crashed = false;
      tab.errorEl?.remove();
      tab.errorEl = null;
      tab.wv.loadURL(url).catch(() => {});
      return;
    }
    if (ignoreCache) tab.wv.reloadIgnoringCache();
    else tab.wv.reload();
  }

  stop(tab = this.active) {
    if (tab?.wv && tab.ready) tab.wv.stop();
  }

  goHome(tab = this.active) {
    const home = this.prefs.homeUrl?.trim();
    this.navigate(tab, home || 'aurora://newtab');
    if (!home) this.omni.focus();
  }

  /** Open an internal page, reusing a tab that already shows it (like Edge does for settings). */
  openInternal(route, query) {
    const url = internalUrl(route, query);
    const existing = this.tabs.find((x) => this.entry(x)?.kind === 'internal' && this.entry(x).route === route);
    if (existing) {
      this.activate(existing);
      if (query && Object.keys(query).length) this.navigate(existing, url);
      return existing;
    }
    if (this.active && this.entry(this.active)?.route === 'newtab' && !this.canGoBack(this.active)) {
      this.navigate(this.active, url);
      return this.active;
    }
    return this.createTab({ url, active: true });
  }

  /** Open a URL from a link/menu following the usual modifiers (middle / Ctrl = background tab). */
  openFromLink(url, e, tab = this.active) {
    if (e && (e.button === 1 || e.ctrlKey || e.metaKey)) return this.openUrl(url, { active: !!e.shiftKey, opener: tab });
    if (e?.shiftKey) return shared.shell.launch('browser', { newWindow: true, url, private: this.private || undefined });
    this.navigate(tab || this.active, url);
    this.focusPage(tab);
  }

  openExternal(url) {
    // Pages can trigger these repeatedly: at most one prompt / hand-off every 2 seconds.
    const now = Date.now();
    if (now - (shared.lastExternal || 0) < 2000) return;
    shared.lastExternal = now;
    if (/^mailto:/i.test(url) && shared.shell.registry?.get?.('mail')) {
      shared.shell.launch('mail', { mailto: url, compose: { mailto: url } });
      return;
    }
    ui.alert(this.t('external.none', { url }), { title: this.t('external.title'), parent: this.win });
  }

  // ================================================================== backend events
  handleOpen(source, p) {
    const url = p.url;
    // Defense in depth (the backend already refuses these): pages never open data: documents.
    if (/^data:/i.test(url) && !/^data:image\/(png|jpe?g|gif|webp|bmp|avif|x-icon)[;,]/i.test(url)) return null;
    if (p.disposition === 'new-window' && /\b(width|height|popup)\b/i.test(p.features || '')) {
      const m = /width=(\d+)/i.exec(p.features);
      const n = /height=(\d+)/i.exec(p.features);
      shared.shell.launch('browser', { newWindow: true, private: this.private || undefined, url, popup: { width: m ? Number(m[1]) : null, height: n ? Number(n[1]) : null } });
      return;
    }
    if (p.disposition === 'new-window' && !this.private) {
      shared.shell.launch('browser', { newWindow: true, url });
      return;
    }
    const background = p.disposition === 'background-tab';
    const tab = this.createTab({ url, active: !background, opener: source, openedByScript: true });
    return tab;
  }

  onDownloadStarted(d, tab) {
    this.closeDownloadTab(tab);
    if (!this.closing) this.toggleDownloads(true);
  }

  /** A tab opened just to start a download (target=_blank link to a file) is closed again. */
  closeDownloadTab(tab) {
    if (tab && tab.openedByScript && !tab.web.committed && this.tabs.length > 1 && this.tabs.includes(tab)) this.closeTab(tab, { skipStack: true });
  }

  popupBlocked(tab, url) {
    if (!tab.blockedPopups.includes(url)) tab.blockedPopups.push(url);
    if (tab === this.active) this.omni.updateChips();
  }

  queuePermission(tab, p) {
    tab.perms.push(p);
    if (tab === this.active && !this.closing) this.showNextPermission(tab);
  }

  dropPermission(id) {
    for (const tab of this.tabs) tab.perms = tab.perms.filter((p) => p.id !== id);
    if (this.flyout?.permId === id) this.closeFlyout();
  }

  showNextPermission(tab) {
    const p = tab.perms[0];
    if (!p || this.active !== tab || this.flyout?.permId === p.id) return;
    panels.permissionBubble(this, tab, p);
  }

  /**
   * Modal requests from a page (HTTP sign-in, alert / confirm / prompt), one dialog at a time per
   * window. `open(done => …)` shows the dialog and resolves with the answer; `reply(answer)` sends it.
   */
  queueModal(tab, p, open, reply) {
    this.modalQueue = (this.modalQueue || Promise.resolve()).then(async () => {
      if (tab.closed || this.closing || this.modalDropped?.has(p.id)) return reply(null);
      if (tab !== this.active) this.activate(tab, { focusPage: false });
      tab.auth = p;
      let answer = null;
      try {
        answer = await open((done) => (tab.authDone = done));
      } catch (err) {
        console.error('[browser] page dialog failed', err);
      }
      tab.auth = null;
      tab.authDone = null;
      reply(answer);
    });
  }

  showAuth(tab, p) {
    this.queueModal(tab, p, (onHandle) => panels.authDialog(this, p, onHandle), (creds) => shared.api.invoke('browser:authReply', p.id, creds).catch(() => {}));
  }

  showJsDialog(tab, p) {
    this.queueModal(tab, p, (onHandle) => panels.jsDialog(this, p, onHandle), (answer) => shared.api.invoke('browser:jsDialogReply', p.id, answer || { ok: false }).catch(() => {}));
  }

  /** The backend gave up on a request (navigation, timeout, tab gone): close its dialog. */
  dropAuth(id) {
    (this.modalDropped ||= new Set()).add(id);
    for (const tab of this.tabs) if (tab.auth?.id === id) tab.authDone?.(null);
  }

  /** The tab moved on (new navigation, stop, close): its pending sign-in is moot. */
  cancelAuth(tab) {
    tab.authDone?.(null);
  }

  showPageMenu(tab, params) {
    if (tab !== this.active) return;
    panels.pageMenu(this, tab, params);
  }

  // ================================================================== chrome state
  updateChrome({ keepOmni = false } = {}) {
    const tab = this.active;
    if (!tab) return;
    this.updateNavButtons();
    this.updateReloadBtn();
    if (!keepOmni || !this.omni.editing) this.omni.sync(tab);
    else this.omni.updateChips();
    this.updateWindowTitle();
    this.favbar.updateVisibility();
  }

  updateNavButtons() {
    this.backBtn.disabled = !this.canGoBack();
    this.fwdBtn.disabled = !this.canGoForward();
  }

  updateReloadBtn() {
    const tab = this.active;
    const loading = !!(tab && this.isWeb(tab) && tab.web.loading && !tab.web.error);
    const ic = loading ? 'dismiss' : 'arrow_clockwise';
    if (this.reloadBtn.dataset.state !== ic) {
      this.reloadBtn.dataset.state = ic;
      clear(this.reloadBtn).appendChild(icon(ic, { size: 18 }));
    }
    const label = loading ? this.t('nav.stop') : this.t('nav.reload');
    this.reloadBtn.setAttribute('aria-label', label);
    this.reloadBtn.dataset.tip = loading ? `${label} (Esc)` : `${label} (Ctrl+R)`;
    this.reloadBtn.dataset.tipPos = 'below';
  }

  updateWindowTitle() {
    const tab = this.active;
    const title = tab ? this.tabTitle(tab) : '';
    const app = this.private ? this.t('private.windowTitle') : this.t('app.name');
    const n = this.tabs.length - 1;
    const more = n > 0 ? ` ${this.t('window.more', { count: n })}` : '';
    this.win.setTitle(title ? `${title}${more} - ${app}` : app);
  }

  applyPrefsToChrome() {
    this.homeBtn.hidden = !this.prefs.homeButton;
    this.favbar.updateVisibility();
  }

  onPrefs(key) {
    if (key === 'homeButton' || key === 'showBar') this.applyPrefsToChrome();
    if (key === 'engine') this.omni.relocalize();
    for (const tab of this.tabs) {
      const e = this.entry(tab);
      if (e?.kind === 'internal' && (e.route === 'settings' || e.route === 'newtab')) tab.page?.update?.(key);
    }
  }

  onBookmarks() {
    this.favbar.render();
    if (this.active) this.omni.updateChips();
  }

  setStatus(url) {
    clearTimeout(this.statusTimer);
    if (url) {
      this.status.textContent = displayUrl(url);
      this.status.classList.add('show');
    } else this.statusTimer = setTimeout(() => this.status.classList.remove('show'), 300);
  }

  updateDownloadsButton() {
    const active = shared.activeDownloads(this);
    const any = shared.downloadList(this).length > 0;
    this.dlBtn.classList.toggle('has', any);
    this.dlBtn.hidden = !any && !this.dlPinned;
    this.dlBadge.hidden = !active.length;
    this.dlBadge.textContent = String(active.length);
    let total = 0;
    let received = 0;
    for (const d of active) {
      total += d.total || 0;
      received += d.received || 0;
    }
    const pct = active.length && total ? Math.min(100, (received / total) * 100) : active.length ? 8 : 0;
    this.dlBtn.classList.toggle('progress', active.length > 0);
    this.dlBtn.style.setProperty('--dl-pct', String(pct));
    this.win.setProgress(active.length ? (total ? received / total : null) : null);
  }

  toggleDownloads(forceOpen = false) {
    if (this.flyout?.kind === 'downloads') {
      if (!forceOpen) this.closeFlyout();
      return;
    }
    this.dlPinned = true;
    this.dlBtn.hidden = false;
    panels.downloadsFlyout(this, this.dlBtn);
  }

  setFlyout(f, kind) {
    this.closeFlyout();
    f.kind = kind;
    this.flyout = f;
  }

  closeFlyout() {
    const f = this.flyout;
    this.flyout = null;
    f?.close();
  }

  menuClass() {
    return this.private ? 'app-browser bw-private' : 'app-browser';
  }

  // ================================================================== zoom / fullscreen
  refreshZoom(tab = this.active) {
    if (!tab) return;
    if (this.isWeb(tab) && tab.wv && tab.ready) {
      try {
        tab.zoom = tab.wv.getZoomFactor();
      } catch {}
    } else tab.zoom = tab.internalZoom || 1;
    if (tab === this.active) this.omni.updateChips();
  }

  zoom(dir) {
    const tab = this.active;
    if (!tab) return;
    const cur = this.isWeb(tab) ? tab.zoom || 1 : tab.internalZoom || 1;
    const next = dir === 0 ? 1 : nextZoom(cur, dir);
    if (this.isWeb(tab)) {
      if (!tab.wv || !tab.ready) return;
      tab.wv.setZoomFactor(next);
      tab.zoom = next;
      // Chromium zooms per site: keep the other tabs of the same host in sync.
      const host = hostOf(tab.web.url);
      for (const x of this.tabs) if (x !== tab && x.wv && hostOf(x.web.url) === host) x.zoom = next;
    } else {
      tab.internalZoom = next;
      tab.zoom = next;
      if (tab.pageEl) tab.pageEl.style.zoom = next === 1 ? '' : String(next);
    }
    this.omni.updateChips();
    this.menuZoomUpdate?.();
  }

  setFullscreen(mode, fromWm = false) {
    const prev = this.fs;
    this.fs = mode;
    if (!fromWm) this.win.setFullscreen(!!mode);
    this.root.classList.toggle('bw-fs', !!mode);
    this.root.classList.toggle('bw-fs-user', mode === 'user');
    this.root.classList.remove('bw-fs-reveal');
    this.win.el.classList.toggle('bw-fs-win', !!mode);
    clearTimeout(this.fsHintTimer);
    if (mode === 'user' && prev !== 'user') {
      this.fsHint.textContent = this.t('fs.hint');
      this.fsHint.hidden = false;
      this.fsHint.classList.remove('leaving');
      this.fsHintTimer = setTimeout(() => {
        this.fsHint.classList.add('leaving');
        this.fsHintTimer = setTimeout(() => (this.fsHint.hidden = true), 300);
      }, 2600);
    } else if (!mode) this.fsHint.hidden = true;
    if (!mode && prev === 'html' && fromWm && this.active?.wv) {
      this.active.wv.executeJavaScript('document.fullscreenElement && document.exitFullscreen()', false).catch(() => {});
    }
  }

  toggleFullscreen() {
    if (this.fs === 'html') {
      this.active?.wv?.executeJavaScript('document.fullscreenElement && document.exitFullscreen()', false).catch(() => {});
      this.setFullscreen(null);
    } else this.setFullscreen(this.fs ? null : 'user');
  }

  // ================================================================== keyboard
  onKeyDown(e) {
    if (e.defaultPrevented) return;
    if (e.target.closest?.('.dialog-layer')) return;
    const combo = comboFromEvent(e);
    if (!combo) return;
    if (this.handleCombo(combo, { event: e })) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  /** Returns true when the combo was handled. */
  handleCombo(combo, { tab = this.active, fromPage = false, passThrough = false, event } = {}) {
    if (this.closing) return false;
    if (fromPage && tab !== this.active) return false;
    const inText = event && event.target.matches?.('input, textarea, [contenteditable="true"]');
    const t = this.active;
    switch (combo) {
      case 'Ctrl+T':
        this.newTab();
        return true;
      case 'Ctrl+W':
      case 'Ctrl+F4':
        this.closeTab(t);
        return true;
      case 'Ctrl+Shift+W':
        this.win.close();
        return true;
      case 'Ctrl+N':
        shared.shell.launch('browser', { newWindow: true });
        return true;
      case 'Ctrl+Shift+N':
        shared.shell.launch('browser', { newWindow: true, private: true });
        return true;
      case 'Ctrl+Shift+T':
        this.reopenClosed();
        return true;
      case 'Ctrl+L':
      case 'Alt+D':
      case 'F6':
      case 'Ctrl+E':
      case 'Ctrl+K':
        if (fromPage && (combo === 'Ctrl+E' || combo === 'Ctrl+K')) return false;
        this.omni.focus();
        return true;
      case 'Ctrl+F':
        this.findBar.open();
        return true;
      case 'F3':
      case 'Ctrl+G':
        this.findBar.open();
        this.findBar.step(true);
        return true;
      case 'Shift+F3':
      case 'Ctrl+Shift+G':
        this.findBar.open();
        this.findBar.step(false);
        return true;
      case 'Ctrl+R':
      case 'F5':
      case 'BrowserRefresh':
        this.reload(false);
        return true;
      case 'Ctrl+F5':
      case 'Shift+F5':
      case 'Ctrl+Shift+R':
        this.reload(true);
        return true;
      case 'Ctrl+H':
        this.openInternal('history');
        return true;
      case 'Ctrl+J':
        this.openInternal('downloads');
        return true;
      case 'Ctrl+Shift+O':
        this.openInternal('favorites');
        return true;
      case 'Ctrl+D':
        panels.favoriteFlyout(this);
        return true;
      case 'Ctrl+Shift+B':
        this.store.setPref('showBar', barMode(this.prefs) === 'never' ? 'always' : 'never');
        return true;
      case 'Ctrl+Tab':
      case 'Ctrl+PageDown':
        this.cycleTab(1);
        return true;
      case 'Ctrl+Shift+Tab':
      case 'Ctrl+PageUp':
        this.cycleTab(-1);
        return true;
      case 'Alt+ArrowLeft':
      case 'BrowserBack':
        if (inText && !event.target.closest('.bw-omni')) return false;
        this.goBack();
        return true;
      case 'Alt+ArrowRight':
      case 'BrowserForward':
        if (inText && !event.target.closest('.bw-omni')) return false;
        this.goForward();
        return true;
      case 'Alt+Home':
      case 'BrowserHome':
        this.goHome();
        return true;
      case 'Ctrl+Plus':
      case 'ZoomIn':
        this.zoom(1);
        return true;
      case 'Ctrl+Minus':
      case 'ZoomOut':
        this.zoom(-1);
        return true;
      case 'Ctrl+0':
        this.zoom(0);
        return true;
      case 'F11':
        this.toggleFullscreen();
        return true;
      case 'Ctrl+U':
        if (t && this.isWeb(t) && isWebUrl(t.web.url)) this.openUrl(`view-source:${t.web.url}`, { opener: t });
        return true;
      case 'Ctrl+Shift+Delete':
        panels.clearDataDialog(this);
        return true;
      case 'Alt+F':
        panels.moreMenu(this, this.moreBtn);
        return true;
      case 'Ctrl+P':
        panels.savePdf(this);
        return true;
      case 'Ctrl+S':
        panels.savePage(this);
        return true;
      case 'F12':
      case 'Ctrl+Shift+I':
      case 'Ctrl+Shift+J':
      case 'Ctrl+Shift+C':
        if (shared.dev && t?.wcId != null) shared.api.invoke('browser:inspect', t.wcId).catch(() => {});
        return shared.dev;
      case 'Escape':
        if (this.findBar.isOpen()) {
          this.findBar.close();
          return true;
        }
        if (this.fs === 'user') {
          this.setFullscreen(null);
          return true;
        }
        if (t && this.isWeb(t) && t.web.loading && !passThrough) {
          this.stop();
          return true;
        }
        return false;
      default:
        if (/^Ctrl\+[1-8]$/.test(combo)) {
          this.selectTab(Number(combo.slice(5)) - 1);
          return true;
        }
        if (combo === 'Ctrl+9') {
          this.selectTab(-1);
          return true;
        }
        return false;
    }
  }
}

export { APP_ICON, searchUrl, engineOf, parseInternal, isInternal };
