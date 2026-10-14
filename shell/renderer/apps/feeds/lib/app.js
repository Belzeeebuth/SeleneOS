// Podcasts & News — the application: subscriptions pane (views, folders, unread counts), article / episode list,
// reading pane (sanitised HTML in a sandboxed iframe, « Afficher les images » per feed), episode actions (download with
// progress and cancel, play, mark played, chapters), mini-player (±15 / 30 s, speed, sleep timer, resume position),
// refresh (on open, every 30 min while open, F5), OPML import / export.
// Backend: main/ipc/feeds.js. Parsing: lib/parse.js. State: lib/store.js (ctx.storage). Test hook: win.el.__feeds.
import { parseFeed, parseChapters, parseOpml, buildOpml } from './parse.js';
import { buildArticle } from './sanitize.js';
import { FeedStore, itemKey, splitKey, when } from './store.js';
import { PodcastPlayer, SPEEDS } from './player.js';
import { clock, durationParts, hostOf, pool } from './util.js';
import { openAddDialog, getDoc } from './add.js';
import { effectiveTheme } from '../../../core/theme.js';

const REFRESH_MS = 30 * 60000;
const OPEN_MIN_AGE = 10 * 60000;
const AUTO_MIN_AGE = 25 * 60000;
const PAGE = 150;
const SAVE_POS_MS = 5000;

/** Menu entries without nulls and without leading, trailing or doubled separators. */
function cleanMenu(items) {
  const out = [];
  for (const it of items) {
    if (!it) continue;
    if (it === '-' && (!out.length || out[out.length - 1] === '-')) continue;
    out.push(it);
  }
  while (out[out.length - 1] === '-') out.pop();
  return out;
}

const ERRORS = ['EOFFLINE', 'ETIMEDOUT', 'EHTTP', 'EPARSE', 'ENOTFEED', 'ETOOBIG', 'ETOOMANYREDIRECTS', 'ETLS', 'EINVAL', 'ENOFEED', 'ENOSPC', 'EBADDATA'];

export class FeedsApp {
  constructor(ctx) {
    this.ctx = ctx;
    this.win = ctx.win;
    this.h = ctx.h;
    this.t = ctx.t;
    this.api = ctx.api;
    this.ui = ctx.ui;
    this.icon = ctx.icon;
    this.store = new FeedStore(ctx.storage);
    this.player = new PodcastPlayer({ api: ctx.api });
    this.view = { type: 'all' };
    this.sel = null;
    this.rows = [];
    this.rendered = 0;
    this.sticky = new Set();
    this.dls = new Map(); // item key -> { received, total, state }
    this.pendingPlay = null;
    this.chapters = new Map(); // item key -> [chapter] | Promise
    this.images = new Map(); // remote url -> local path | Promise
    this.refreshing = null;
    this.progress = { done: 0, total: 0 };
    this.lastRefresh = 0;
    this.readSeq = 0;
    this.lastPosSave = 0;
    this.offs = [];
    this.layout = 'wide';
    this.pane = 'list';
    this.navOpen = false;
    this.closed = false;
    this.win.el.__feeds = this;
  }

  get locale() {
    return this.ctx.lang === 'fr' ? 'fr-FR' : 'en-US';
  }

  async init() {
    await this.store.load();
    const v = this.store.prefs.view;
    this.view = this.validView(v) ? v : { type: 'all' };
    this.player.setRate(this.store.prefs.speed || 1);
    this.player.setVolume(this.store.prefs.volume ?? 1);
    this.build();
    this.offs.push(this.store.on((what, feedId) => this.onStore(what, feedId)));
    this.offs.push(this.api.on('feeds:progress', (p) => this.onProgress(p)));
    this.offs.push(this.player.on('time', () => this.onTime()));
    this.offs.push(this.player.on('state', () => this.renderPlayer()));
    this.offs.push(this.player.on('meta', () => this.onMeta()));
    this.offs.push(this.player.on('ended', () => this.onEnded()));
    this.offs.push(this.player.on('sleep', () => this.renderSleep()));
    this.offs.push(this.player.on('error', () => this.onPlayError()));
    const rerender = () => this.sel && this.renderReader({ keep: true });
    this.offs.push(this.ctx.settings.on('theme', rerender));
    this.offs.push(this.ctx.settings.on('accent', rerender));
    if (this.ctx.shell?.theme?.on) this.offs.push(this.ctx.shell.theme.on('change', rerender));
    this.ctx.onLangChange(() => {
      this.build();
      this.renderAll();
    });
    this.win.onBeforeClose(async () => {
      if (this.dls.size) {
        const ok = await this.ui.confirm(this.t('close.downloadsText'), { title: this.t('close.downloadsTitle'), okLabel: this.t('close.downloadsOk'), parent: this.win });
        if (!ok) return false;
        for (const key of [...this.dls.keys()]) this.api.invoke('feeds:cancel', key).catch(() => {});
      }
      this.savePosition(true);
      await this.store.flush();
      return true;
    });
    this.ctx.onClose(() => this.destroy());
    this.renderAll();
    await this.checkFiles();
    for (const f of this.store.feeds) if (f.image && !f.imagePath) this.loadCover(f);
    this.refreshAll({ reason: 'open' });
    this.timer = setInterval(() => this.refreshAll({ reason: 'auto' }), REFRESH_MS);
  }

  destroy() {
    this.closed = true;
    clearInterval(this.timer);
    clearTimeout(this.storeTimer);
    this.resizeObs?.disconnect();
    for (const off of this.offs) off?.();
    this.offs = [];
    this.savePosition(true);
    this.store.flush();
    this.player.destroy();
  }

  validView(v) {
    if (!v || typeof v !== 'object') return false;
    if (['all', 'unread', 'starred', 'podcasts', 'downloads'].includes(v.type)) return true;
    if (v.type === 'feed') return !!this.store.feed(v.id);
    if (v.type === 'folder') return this.store.folders().includes(v.id);
    return false;
  }

  announce(text) {
    if (!this.live) return;
    this.live.textContent = '';
    setTimeout(() => {
      if (this.live) this.live.textContent = text;
    }, 30);
  }

  // ------------------------------------------------------------------ text helpers
  errorText(code, extra = {}) {
    // download errors cross the IPC bridge as code + message only: the status is in the message
    const status = Number(extra.status) || Number(/answered (\d{3})/.exec(extra.message || '')?.[1]) || 0;
    if (code === 'EHTTP' && (status === 404 || status === 410)) return this.t('error.E404');
    if (code === 'EHTTP' && !status) return this.t('error.EFAIL');
    if (code === 'EHTTP' && (status === 429 || status === 503) && extra.at > Date.now()) return this.t('error.ERETRY', { time: this.fmtTime(extra.at) });
    return this.t(`error.${ERRORS.includes(code) ? code : 'EFAIL'}`, { status });
  }
  /** The error as a sentence of its own ("No internet connection…."). */
  errorLine(code, extra = {}) {
    const s = this.errorText(code, extra);
    return `${s.charAt(0).toUpperCase()}${s.slice(1)}.`;
  }
  fmtTime(ms) {
    return new Intl.DateTimeFormat(this.locale, { hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
  }
  /** List date: time today, "Yesterday", weekday this week, "13 Oct" this year, "13 Oct 2025" before. */
  fmtShortDate(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    const now = new Date();
    const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((day(now) - day(d)) / 86400000);
    if (diff === 0) return this.fmtTime(ms);
    if (diff === 1) return new Intl.RelativeTimeFormat(this.locale, { numeric: 'auto' }).format(-1, 'day').replace(/^./, (c) => c.toUpperCase());
    if (diff > 1 && diff < 7) return new Intl.DateTimeFormat(this.locale, { weekday: 'long' }).format(d).replace(/^./, (c) => c.toUpperCase());
    const opts = d.getFullYear() === now.getFullYear() ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' };
    return new Intl.DateTimeFormat(this.locale, opts).format(d);
  }
  fmtLongDate(ms) {
    if (!ms) return this.t('row.noDate');
    const s = new Intl.DateTimeFormat(this.locale, { dateStyle: 'full', timeStyle: 'short' }).format(new Date(ms));
    return s.replace(/^./, (c) => c.toUpperCase());
  }
  fmtDuration(s) {
    const p = durationParts(s);
    if (p.h) return this.t('dur.hm', { h: p.h, m: String(p.m).padStart(2, '0') });
    if (p.m) return this.t('dur.m', { m: p.m });
    return this.t('dur.s', { s: p.s });
  }
  fmtSpeed(r) {
    return `${new Intl.NumberFormat(this.locale, { maximumFractionDigits: 2 }).format(r)}×`;
  }
  feedTitle(f) {
    return this.store.title(f) || hostOf(f?.url) || this.t('row.noTitle');
  }
  isEpisode(ref) {
    return !!ref?.item?.enc;
  }

  // ------------------------------------------------------------------ chrome
  build() {
    const { h, t, icon } = this;
    this.ui.clear(this.win.body);
    this.resizeObs?.disconnect();
    // subscriptions pane
    this.addBtn = h('button', { class: 'btn primary fd-add', name: 'add', onclick: () => this.addDialog() }, icon('plus'), h('span', { class: 'lbl' }, t('nav.add')));
    this.refreshBtn = h('button', { class: 'btn subtle icon-btn fd-refresh', name: 'refresh', 'aria-label': t('nav.refresh'), 'data-tip': `${t('nav.refresh')} (F5)`, onclick: () => this.refreshAll({ manual: true }) }, icon('arrows-clockwise'));
    this.moreBtn = h('button', { class: 'btn subtle icon-btn fd-more', name: 'more', 'aria-label': t('nav.more'), 'data-tip': t('nav.more'), 'aria-haspopup': 'menu', onclick: (e) => this.appMenu(e) }, icon('dots-three'));
    this.viewsEl = h('div', { class: 'fd-views' });
    this.subsEl = h('div', { class: 'fd-subs', role: 'group', 'aria-labelledby': 'fd-subs-title' });
    this.statusEl = h('div', { class: 'fd-status', role: 'status' });
    this.nav = h(
      'nav',
      { class: 'fd-nav', 'aria-label': t('nav.label'), onkeydown: (e) => this.onNavKey(e) },
      h('div', { class: 'fd-nav-head' }, this.addBtn, this.refreshBtn, this.moreBtn),
      h('div', { class: 'fd-nav-scroll' }, this.viewsEl, h('div', { class: 'fd-subs-title', id: 'fd-subs-title' }, t('nav.subscriptions')), this.subsEl),
      this.statusEl,
    );
    // list pane
    this.navToggle = h('button', { class: 'btn subtle icon-btn fd-nav-toggle', name: 'nav', 'aria-label': t('nav.show'), 'data-tip': t('nav.show'), 'aria-expanded': 'false', onclick: () => this.toggleNav() }, icon('list'));
    this.listTitle = h('h2', { class: 'fd-list-title', id: 'fd-list-title' });
    this.listSub = h('div', { class: 'fd-list-sub' });
    this.markAllBtn = h('button', { class: 'btn subtle icon-btn fd-markall', name: 'markall', 'aria-label': t('list.markAll'), 'data-tip': t('list.markAll'), onclick: () => this.markAllRead() }, icon('list-checks'));
    this.feedMenuBtn = h('button', { class: 'btn subtle icon-btn fd-feedmenu', name: 'feedmenu', 'aria-label': t('list.feedMenu'), 'data-tip': t('list.feedMenu'), 'aria-haspopup': 'menu', onclick: (e) => this.viewMenu(e) }, icon('dots-three'));
    this.listInfo = h('div', { class: 'fd-list-info' });
    this.rowsEl = h('div', { class: 'fd-rows', role: 'listbox', 'aria-labelledby': 'fd-list-title', onkeydown: (e) => this.onRowsKey(e), onscroll: () => this.maybeMore() });
    this.listEmpty = h('div', { class: 'fd-list-empty', hidden: true });
    this.listEl = h(
      'section',
      { class: 'fd-list', 'aria-label': t('list.label') },
      h('div', { class: 'fd-list-head' }, this.navToggle, h('div', { class: 'fd-list-heading' }, this.listTitle, this.listSub), this.markAllBtn, this.feedMenuBtn),
      this.listInfo,
      this.rowsEl,
      this.listEmpty,
    );
    // reading pane
    this.reader = h('section', { class: 'fd-reader', 'aria-label': t('reader.label') });
    this.buildPlayer();
    this.live = h('div', { class: 'fd-live', 'aria-live': 'polite' });
    this.scrim = h('div', { class: 'fd-scrim', onclick: () => this.toggleNav(false) });
    this.root = h('div', { class: 'fd', onkeydown: (e) => this.onKey(e) }, h('div', { class: 'fd-main' }, this.nav, this.scrim, this.listEl, this.reader), this.playerEl, this.live, this.player.el);
    this.win.body.appendChild(this.root);
    this.resizeObs = new ResizeObserver(() => this.applyLayout());
    this.resizeObs.observe(this.root);
    this.applyLayout();
  }

  applyLayout() {
    const w = this.root?.clientWidth || 0;
    if (!w) return;
    const layout = w >= 1000 ? 'wide' : w >= 700 ? 'medium' : 'narrow';
    if (layout !== this.layout || !this.root.dataset.layout) {
      const wasWide = this.layout === 'wide';
      this.layout = layout;
      this.root.dataset.layout = layout;
      if (layout === 'wide') this.toggleNav(false);
      else if (wasWide) this.pane = this.sel ? 'reader' : 'list';
    }
    this.root.dataset.pane = this.pane;
  }
  setPane(p) {
    this.pane = p;
    if (this.root) this.root.dataset.pane = p;
  }
  toggleNav(open = !this.navOpen) {
    this.navOpen = !!open && this.layout === 'narrow';
    if (!this.root) return;
    this.root.dataset.nav = this.navOpen ? 'open' : 'closed';
    this.navToggle?.setAttribute('aria-expanded', String(this.navOpen));
    if (this.navOpen) this.nav.querySelector('.nav-item.selected, .nav-item')?.focus();
  }

  renderAll() {
    this.renderNav();
    this.renderList();
    this.renderReader();
    this.renderPlayer();
    this.renderStatus();
  }

  onStore(what, feedId) {
    if (this.closed) return;
    // while a refresh runs, every feed reports twice: draw at most every 300 ms (the end of the refresh draws again)
    if (this.refreshing && what !== 'items') {
      this.pendingStore = { what: this.pendingStore && this.pendingStore.what !== what ? 'items' : what, feedId: this.pendingStore && this.pendingStore.feedId !== feedId ? null : feedId };
      if (!this.storeTimer) {
        this.storeTimer = setTimeout(() => {
          this.storeTimer = null;
          const p = this.pendingStore;
          this.pendingStore = null;
          if (p) this.drawStore(p.what, p.feedId);
        }, 300);
      }
      return;
    }
    this.drawStore(what, feedId);
  }
  drawStore(what, feedId) {
    if (this.closed) return;
    if (!this.validView(this.view)) this.view = { type: 'all' };
    this.renderNav();
    this.renderList({ keepScroll: true });
    if (this.sel && !this.store.byKey(this.sel)) {
      this.sel = null;
      this.renderReader();
    } else if (this.sel && (!feedId || splitKey(this.sel)[0] === feedId) && what !== 'feeds') this.updateReaderState();
  }

  // ------------------------------------------------------------------ subscriptions pane
  navButton({ cls, name, iconName, label, count, selected, data, onclick, art, error, oncontextmenu }) {
    const { h, icon } = this;
    return h(
      'button',
      {
        class: ['nav-item', cls, selected && 'selected'],
        type: 'button',
        name,
        dataset: data,
        'aria-current': selected ? 'page' : null,
        tabindex: '-1',
        title: label,
        onclick,
        oncontextmenu,
      },
      art || icon(iconName),
      h('span', { class: 'fd-nav-label ellipsis' }, label),
      error ? h('span', { class: 'fd-nav-error', 'data-tip': error, 'aria-label': error, role: 'img' }, icon('warning-circle', { size: 16 })) : null,
      count ? h('span', { class: 'fd-count', 'aria-label': this.t('nav.unreadCount', { count }) }, count > 999 ? '999+' : String(count)) : null,
    );
  }

  feedArt(f, size = 'sm') {
    const { h } = this;
    const letter = (this.feedTitle(f).match(/[\p{L}\p{N}]/u) || ['?'])[0].toUpperCase();
    const ph = h('span', { class: `fd-art fd-art-${size} fd-letter`, 'aria-hidden': 'true' }, letter);
    if (!f?.imagePath) return ph;
    const img = h('img', { class: `fd-art fd-art-${size}`, alt: '', src: this.api.mediaUrl(f.imagePath), draggable: 'false' });
    img.addEventListener('error', () => {
      img.replaceWith(ph);
      if (this.store.feed(f.id)?.imagePath === f.imagePath) this.store.patchFeed(f.id, { imagePath: '' }, { silent: true });
    });
    return img;
  }

  renderNav() {
    if (!this.viewsEl) return;
    const { h, t } = this;
    const c = this.store.counts();
    const focused = this.nav.contains(document.activeElement) ? document.activeElement.closest('.nav-item') : null;
    const focusKey = focused ? `${focused.name}|${focused.dataset.feed || focused.dataset.folder || ''}` : null;
    const sel = (type, id) => this.view.type === type && (id == null || this.view.id === id);
    const dlCount = c.downloads + [...this.dls.keys()].filter((k) => !this.store.byKey(k)?.item.dl).length;
    const views = [
      ['all', 'newspaper', t('nav.all'), c.unread],
      ['unread', 'envelope-simple', t('nav.unread'), c.unread],
      ['starred', 'star', t('nav.starred'), c.starred],
      ['podcasts', 'microphone', t('nav.podcasts'), c.podcasts],
      ['downloads', 'download-simple', t('nav.downloads'), dlCount],
    ];
    this.ui.clear(this.viewsEl);
    for (const [type, ic, label, count] of views) {
      this.viewsEl.appendChild(this.navButton({ cls: 'fd-view', name: `view-${type}`, iconName: ic, label, count, selected: sel(type), data: { view: type }, onclick: () => this.setView({ type }) }));
    }
    this.ui.clear(this.subsEl);
    const feeds = this.store.sortedFeeds();
    if (!feeds.length) this.subsEl.appendChild(h('div', { class: 'fd-subs-empty' }, t('nav.noSubs')));
    const feedBtn = (f, nested) =>
      this.navButton({
        cls: ['fd-sub', nested && 'nested'].filter(Boolean).join(' '),
        name: 'feed',
        label: this.feedTitle(f),
        count: c.perFeed.get(f.id) || 0,
        selected: sel('feed', f.id),
        data: { feed: f.id },
        art: this.feedArt(f, 'xs'),
        error: f.error ? this.errorLine(f.error, { status: f.lastStatus, at: f.retryAt }) : null,
        onclick: () => this.setView({ type: 'feed', id: f.id }),
        oncontextmenu: (e) => this.feedMenu(e, f),
      });
    for (const folder of this.store.folders()) {
      const collapsed = this.store.prefs.collapsed.includes(folder);
      const row = this.navButton({
        cls: 'fd-folder',
        name: 'folder',
        iconName: collapsed ? 'folder-simple' : 'folder-open',
        label: folder,
        count: c.perFolder.get(folder) || 0,
        selected: sel('folder', folder),
        data: { folder },
        onclick: () => this.setView({ type: 'folder', id: folder }),
        oncontextmenu: (e) => this.folderMenu(e, folder),
      });
      row.setAttribute('aria-expanded', String(!collapsed));
      const caret = h(
        'span',
        {
          class: 'fd-caret',
          role: 'button',
          'aria-label': collapsed ? t('nav.expand', { name: folder }) : t('nav.collapse', { name: folder }),
          onclick: (e) => {
            e.stopPropagation();
            this.toggleFolder(folder);
          },
        },
        this.icon(collapsed ? 'caret-right' : 'caret-down', { size: 12 }),
      );
      row.insertBefore(caret, row.firstChild);
      this.subsEl.appendChild(row);
      if (!collapsed) for (const f of feeds.filter((x) => x.folder === folder)) this.subsEl.appendChild(feedBtn(f, true));
    }
    for (const f of feeds.filter((x) => !x.folder)) this.subsEl.appendChild(feedBtn(f, false));
    // roving tab stop: the selected entry (or the first)
    const items = [...this.nav.querySelectorAll('.nav-item')];
    (items.find((b) => b.classList.contains('selected')) || items[0])?.setAttribute('tabindex', '0');
    if (focusKey) {
      const again = items.find((b) => `${b.name}|${b.dataset.feed || b.dataset.folder || ''}` === focusKey);
      if (again) {
        items.forEach((b) => b.setAttribute('tabindex', '-1'));
        again.setAttribute('tabindex', '0');
        again.focus({ preventScroll: true });
      }
    }
  }

  /** Count badges updated in place (opening an item must not rebuild the whole pane). */
  updateCounts() {
    if (!this.nav) return;
    const c = this.store.counts();
    const dl = c.downloads + [...this.dls.keys()].filter((k) => !this.store.byKey(k)?.item.dl).length;
    const set = (btn, n) => {
      if (!btn) return;
      let el = btn.querySelector('.fd-count');
      if (!n) return el?.remove();
      if (!el) {
        el = this.h('span', { class: 'fd-count' });
        btn.appendChild(el);
      }
      el.textContent = n > 999 ? '999+' : String(n);
      el.setAttribute('aria-label', this.t('nav.unreadCount', { count: n }));
    };
    const views = { all: c.unread, unread: c.unread, starred: c.starred, podcasts: c.podcasts, downloads: dl };
    for (const [v, n] of Object.entries(views)) set(this.viewsEl.querySelector(`[data-view="${v}"]`), n);
    for (const b of this.subsEl.querySelectorAll('[data-feed]')) set(b, c.perFeed.get(b.dataset.feed) || 0);
    for (const b of this.subsEl.querySelectorAll('[data-folder]')) set(b, c.perFolder.get(b.dataset.folder) || 0);
  }

  toggleFolder(folder) {
    const list = this.store.prefs.collapsed.filter((x) => x !== folder);
    if (!this.store.prefs.collapsed.includes(folder)) list.push(folder);
    this.store.setPref('collapsed', list);
    this.renderNav();
  }

  onNavKey(e) {
    const items = [...this.nav.querySelectorAll('.nav-item')];
    const i = items.indexOf(document.activeElement);
    if (i < 0) return;
    let next = null;
    if (e.key === 'ArrowDown') next = items[Math.min(items.length - 1, i + 1)];
    else if (e.key === 'ArrowUp') next = items[Math.max(0, i - 1)];
    else if (e.key === 'Home') next = items[0];
    else if (e.key === 'End') next = items[items.length - 1];
    else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && items[i].dataset.folder) {
      const collapsed = this.store.prefs.collapsed.includes(items[i].dataset.folder);
      if ((e.key === 'ArrowLeft') !== collapsed) {
        e.preventDefault();
        this.toggleFolder(items[i].dataset.folder);
      }
      return;
    } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      e.preventDefault();
      const b = items[i];
      if (b.dataset.feed) this.feedMenu(b, this.store.feed(b.dataset.feed));
      else if (b.dataset.folder) this.folderMenu(b, b.dataset.folder);
      return;
    } else if (e.key === 'Escape' && this.navOpen) {
      e.preventDefault();
      this.toggleNav(false);
      this.navToggle.focus();
      return;
    }
    if (!next) return;
    e.preventDefault();
    items.forEach((b) => b.setAttribute('tabindex', '-1'));
    next.setAttribute('tabindex', '0');
    next.focus();
  }

  setView(view) {
    if (!this.validView(view)) return;
    const same = view.type === this.view.type && view.id === this.view.id;
    this.view = view;
    this.store.setPref('view', view);
    if (!same) this.sticky = new Set();
    this.renderNav();
    this.renderList();
    this.toggleNav(false);
    if (this.layout !== 'wide') this.setPane('list');
  }

  renderStatus() {
    if (!this.statusEl) return;
    const { t } = this;
    this.refreshBtn?.classList.toggle('spinning', !!this.refreshing);
    if (this.refreshing) this.statusEl.textContent = t('status.refreshing', { done: this.progress.done, total: this.progress.total });
    else if (this.lastRefresh || this.store.feeds.some((f) => f.lastFetch)) {
      const last = this.lastRefresh || Math.max(...this.store.feeds.map((f) => f.lastFetch || 0));
      this.statusEl.textContent =
        Date.now() - last > 20 * 3600000 ? t('status.updatedOn', { date: new Intl.DateTimeFormat(this.locale, { day: 'numeric', month: 'short' }).format(new Date(last)) }) : t('status.updated', { time: this.fmtTime(last) });
    }
    else this.statusEl.textContent = this.store.feeds.length ? t('status.never') : '';
  }

  // ------------------------------------------------------------------ list pane
  viewTitle() {
    const { t } = this;
    const v = this.view;
    if (v.type === 'feed') return this.feedTitle(this.store.feed(v.id));
    if (v.type === 'folder') return v.id;
    return t(`nav.${v.type}`);
  }

  renderList({ keepScroll = false } = {}) {
    if (!this.rowsEl) return;
    const { t } = this;
    const scroll = this.rowsEl.scrollTop;
    const hadFocus = this.rowsEl.contains(document.activeElement);
    this.rows = this.store.query(this.view, { sticky: this.sticky, downloading: new Set(this.dls.keys()) });
    this.listTitle.textContent = this.viewTitle();
    const unread = this.rows.filter((r) => !r.item.read).length;
    this.listSub.textContent = [t('list.count', { count: this.rows.length }), unread && this.view.type !== 'unread' ? t('list.unread', { count: unread }) : ''].filter(Boolean).join(' · ');
    this.markAllBtn.hidden = !unread;
    this.feedMenuBtn.hidden = !['feed', 'folder'].includes(this.view.type);
    this.renderListInfo();
    const keepCount = keepScroll ? Math.max(this.rendered, PAGE) : PAGE;
    this.ui.clear(this.rowsEl);
    this.rendered = 0;
    this.appendRows(keepCount);
    if (keepScroll) this.rowsEl.scrollTop = scroll;
    else this.rowsEl.scrollTop = 0;
    this.renderEmpty();
    if (hadFocus) (this.rowsEl.querySelector('.fd-row[aria-selected="true"]') || this.rowsEl.querySelector('.fd-row'))?.focus({ preventScroll: true });
  }

  renderListInfo() {
    const { h, t, icon } = this;
    this.ui.clear(this.listInfo);
    if (this.view.type !== 'feed') return;
    const f = this.store.feed(this.view.id);
    if (!f?.error) return;
    this.listInfo.appendChild(
      h(
        'div',
        { class: 'infobar fd-feed-error', role: 'status' },
        icon('warning-circle'),
        h('div', { class: 'grow' }, t('list.feedError', { error: this.errorText(f.error, { status: f.lastStatus, at: f.retryAt }) })),
        h('button', { class: 'btn small', name: 'retry', onclick: () => this.refreshFeeds([f], { manual: true }) }, t('common.retry')),
      ),
    );
  }

  appendRows(n) {
    const end = Math.min(this.rows.length, this.rendered + n);
    const frag = document.createDocumentFragment();
    for (let i = this.rendered; i < end; i++) frag.appendChild(this.rowEl(this.rows[i]));
    this.rendered = end;
    this.rowsEl.appendChild(frag);
    const items = this.rowsEl.querySelectorAll('.fd-row');
    if (items.length && !this.rowsEl.querySelector('.fd-row[tabindex="0"]')) items[0].setAttribute('tabindex', '0');
  }
  maybeMore() {
    const el = this.rowsEl;
    if (this.rendered < this.rows.length && el.scrollTop + el.clientHeight > el.scrollHeight - 400) this.appendRows(PAGE);
  }

  renderEmpty() {
    const { h, t, icon } = this;
    this.ui.clear(this.listEmpty);
    const empty = !this.rows.length;
    this.listEmpty.hidden = !empty;
    this.rowsEl.hidden = empty;
    if (!empty) return;
    let ic = 'newspaper';
    let title = t('empty.feedTitle');
    let text = t('empty.feedText');
    const actions = [];
    if (!this.store.feeds.length) {
      ic = 'rss';
      title = t('empty.welcomeTitle');
      text = t('empty.welcomeText');
      actions.push(h('button', { class: 'btn primary', name: 'welcome-add', onclick: () => this.addDialog() }, this.icon('plus'), t('empty.welcomeAdd')));
      actions.push(h('button', { class: 'btn', name: 'welcome-search', onclick: () => this.addDialog({ tab: 'search' }) }, this.icon('magnifying-glass'), t('empty.welcomeSearch')));
    } else if (this.view.type === 'unread') {
      ic = 'check-circle';
      title = t('empty.unreadTitle');
      text = t('empty.unreadText');
    } else if (this.view.type === 'starred') {
      ic = 'star';
      title = t('empty.starredTitle');
      text = t('empty.starredText');
    } else if (this.view.type === 'podcasts') {
      ic = 'microphone';
      title = t('empty.podcastsTitle');
      text = t('empty.podcastsText');
      actions.push(h('button', { class: 'btn', name: 'welcome-search', onclick: () => this.addDialog({ tab: 'search' }) }, this.icon('magnifying-glass'), t('empty.welcomeSearch')));
    } else if (this.view.type === 'downloads') {
      ic = 'download-simple';
      title = t('empty.downloadsTitle');
      text = t('empty.downloadsText');
    }
    this.listEmpty.append(h('div', { class: 'fd-empty-art' }, icon(ic, { size: 40 })), h('div', { class: 'fd-empty-title' }, title), h('div', { class: 'fd-empty-text' }, text), actions.length ? h('div', { class: 'fd-empty-actions' }, actions) : null);
  }

  rowEl(r) {
    const { h, t, icon } = this;
    const { feed, item, key } = r;
    const ep = !!item.enc;
    const dl = this.dls.get(key);
    const selected = key === this.sel;
    const date = this.fmtShortDate(when(item));
    const sub = [];
    if (ep) {
      if (item.played) sub.push(h('span', { class: 'fd-row-played' }, icon('check-circle', { size: 14, filled: true }), t('row.played')));
      else if (item.pos > 0 && item.duration) sub.push(h('span', null, t('row.left', { time: this.fmtDuration(Math.max(0, item.duration - item.pos)) })));
      else if (item.duration) sub.push(h('span', null, this.fmtDuration(item.duration)));
      if (dl) sub.push(h('span', { class: 'fd-row-dl' }, icon('download-simple', { size: 14 }), h('span', { class: 'fd-row-dl-text' }, this.dlRowText(dl))));
      else if (item.dl) sub.push(h('span', { class: 'fd-row-dl done' }, icon('download-simple', { size: 14, filled: true }), t('row.downloaded')));
    }
    const title = item.title || t('row.noTitle');
    const playing = this.player.key === key && !this.player.paused;
    const row = h(
      'div',
      {
        class: ['fd-row', !item.read && 'unread', ep && 'episode', selected && 'selected', item.played && 'played'],
        role: 'option',
        id: `fd-row-${key}`,
        'aria-selected': String(selected),
        tabindex: selected ? '0' : '-1',
        dataset: { key },
        onclick: (e) => {
          if (e.target.closest('.fd-row-play')) return;
          this.open(key, { focusReader: false });
        },
        oncontextmenu: (e) => this.itemMenu(e, key),
      },
      h('span', { class: 'fd-dot', 'aria-label': item.read ? null : t('row.unread'), role: item.read ? null : 'img' }),
      this.feedArt(feed, 'sm'),
      h(
        'div',
        { class: 'fd-row-text' },
        h('div', { class: 'fd-row-meta' }, h('span', { class: 'fd-row-source ellipsis' }, this.feedTitle(feed)), item.starred ? h('span', { class: 'fd-row-star', role: 'img', 'aria-label': t('row.starred') }, icon('star', { size: 14, filled: true })) : null, h('span', { class: 'fd-row-date' }, date)),
        h('div', { class: 'fd-row-title' }, title),
        ep ? h('div', { class: 'fd-row-sub' }, sub) : item.summary ? h('div', { class: 'fd-row-snippet' }, item.summary) : null,
        ep && item.pos > 0 && item.duration && !item.played ? h('div', { class: 'fd-row-progress', role: 'presentation' }, h('div', { class: 'fd-row-bar', style: { width: `${Math.min(100, (item.pos / item.duration) * 100)}%` } })) : null,
      ),
      ep
        ? h(
            'button',
            {
              class: ['btn', 'subtle', 'icon-btn', 'fd-row-play', playing && 'on'],
              tabindex: '-1',
              'aria-label': playing ? t('row.pause') : t('row.play'),
              'data-tip': playing ? t('row.pause') : t('row.play'),
              onclick: (e) => {
                e.stopPropagation();
                this.play(key);
              },
            },
            icon(playing ? 'pause' : 'play', { filled: true }),
          )
        : null,
    );
    return row;
  }

  updateRow(key) {
    const old = this.rowsEl?.querySelector(`.fd-row[data-key="${CSS.escape(key)}"]`);
    if (!old) return;
    const r = this.rows.find((x) => x.key === key);
    if (!r) return;
    const focus = document.activeElement === old;
    const next = this.rowEl(r);
    next.setAttribute('tabindex', old.getAttribute('tabindex'));
    old.replaceWith(next);
    if (focus) next.focus({ preventScroll: true });
  }

  onRowsKey(e) {
    const rows = [...this.rowsEl.querySelectorAll('.fd-row')];
    const i = rows.indexOf(document.activeElement);
    if (i < 0) return;
    const key = rows[i].dataset.key;
    let next = null;
    if (e.key === 'ArrowDown') next = i + 1 < rows.length ? rows[i + 1] : null;
    else if (e.key === 'ArrowUp') next = rows[Math.max(0, i - 1)];
    else if (e.key === 'Home') next = rows[0];
    else if (e.key === 'End') {
      if (this.rendered < this.rows.length) this.appendRows(this.rows.length - this.rendered);
      const all = this.rowsEl.querySelectorAll('.fd-row');
      next = all[all.length - 1];
    } else if (e.key === 'Enter') {
      e.preventDefault();
      this.open(key, { focusReader: this.layout !== 'wide' });
      return;
    } else if (e.key === ' ' && this.store.byKey(key)?.item.enc) {
      e.preventDefault();
      this.play(key);
      return;
    } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      e.preventDefault();
      this.itemMenu(rows[i], key);
      return;
    }
    if (!next) {
      if (e.key === 'ArrowDown' && this.rendered < this.rows.length) {
        e.preventDefault();
        this.appendRows(PAGE);
        this.onRowsKey(e);
      }
      return;
    }
    e.preventDefault();
    this.focusRow(next, { open: this.layout === 'wide' });
  }
  focusRow(row, { open = true } = {}) {
    for (const r of this.rowsEl.querySelectorAll('.fd-row[tabindex="0"]')) r.setAttribute('tabindex', '-1');
    row.setAttribute('tabindex', '0');
    row.focus();
    row.scrollIntoView({ block: 'nearest' });
    if (open) this.open(row.dataset.key, { focusReader: false });
  }
  /** Next / previous item of the list (j / k). */
  step(dir) {
    const i = this.rows.findIndex((r) => r.key === this.sel);
    const j = i < 0 ? 0 : i + dir;
    if (j < 0 || j >= this.rows.length) return;
    if (j >= this.rendered) this.appendRows(j - this.rendered + PAGE);
    const row = this.rowsEl.querySelector(`.fd-row[data-key="${CSS.escape(this.rows[j].key)}"]`);
    if (row) this.focusRow(row);
  }

  // ------------------------------------------------------------------ opening items
  open(key, { focusReader = false } = {}) {
    const ref = this.store.byKey(key);
    if (!ref) return;
    const prev = this.sel;
    this.sel = key;
    if (this.view.type === 'unread' || this.view.type === 'starred') this.sticky.add(key);
    if (!ref.item.read) this.store.patchItem(ref.feed.id, ref.item.id, { read: true }, { silent: true });
    if (prev && prev !== key) {
      const old = this.rowsEl.querySelector(`.fd-row[data-key="${CSS.escape(prev)}"]`);
      old?.classList.remove('selected');
      old?.setAttribute('aria-selected', 'false');
    }
    this.updateRow(key);
    this.updateCounts();
    this.renderReader();
    if (this.layout !== 'wide') this.setPane('reader');
    if (focusReader) setTimeout(() => this.reader.querySelector('.fd-read-title')?.focus(), 30);
  }

  back() {
    if (this.layout === 'wide' || this.pane !== 'reader') return false;
    this.setPane('list');
    const row = this.sel && this.rowsEl.querySelector(`.fd-row[data-key="${CSS.escape(this.sel)}"]`);
    (row || this.rowsEl.querySelector('.fd-row'))?.focus();
    return true;
  }

  // ------------------------------------------------------------------ reading pane
  readerEmpty() {
    const { h, t, icon } = this;
    this.ui.clear(this.reader);
    this.reader.className = 'fd-reader empty';
    this.reader.append(h('div', { class: 'fd-reader-empty' }, h('div', { class: 'fd-empty-art' }, icon('book-open', { size: 48 })), h('div', { class: 'fd-empty-title' }, t('reader.emptyTitle')), h('div', { class: 'fd-empty-text' }, t('reader.emptyText'))));
  }

  frameColors() {
    const probe = this.h('span', { style: { position: 'absolute', visibility: 'hidden' } });
    this.root.appendChild(probe);
    const read = (v) => {
      probe.style.color = `var(${v})`;
      return getComputedStyle(probe).color;
    };
    const colors = { text: read('--text'), text2: read('--text-2'), accent: read('--accent-text'), line: read('--line-soft'), code: read('--layer'), scheme: effectiveTheme(this.root) };
    probe.remove();
    return colors;
  }

  toolbarButton(name, ic, label, fn, { filled = false, on = false, tip } = {}) {
    const { h, icon } = this;
    return h('button', { class: ['btn', 'subtle', 'fd-tb', on && 'on'], name, 'aria-label': label, 'data-tip': tip || label, 'aria-pressed': on ? 'true' : null, onclick: fn }, icon(ic, { filled }), h('span', { class: 'lbl' }, label));
  }

  async renderReader({ keep = false } = {}) {
    if (!this.reader) return;
    const ref = this.sel && this.store.byKey(this.sel);
    if (!ref) return this.readerEmpty();
    const seq = ++this.readSeq;
    const html = await this.store.content(ref.feed.id, ref.item.id);
    if (seq !== this.readSeq || this.closed) return;
    const { h, t, icon } = this;
    const { feed, item, key } = ref;
    const ep = !!item.enc;
    const scroll = keep ? this.reader.querySelector('.fd-read-scroll')?.scrollTop || 0 : 0;
    this.ui.clear(this.reader);
    this.reader.className = `fd-reader ${ep ? 'episode' : 'article'}`;
    // toolbar
    const back = h('button', { class: 'btn subtle icon-btn fd-back', name: 'back', 'aria-label': t('list.back'), 'data-tip': t('list.back'), onclick: () => this.back() }, icon('caret-left'));
    this.readBar = h(
      'div',
      { class: 'fd-read-bar', role: 'toolbar', 'aria-label': t('reader.toolbar') },
      back,
      this.toolbarButton('star', 'star', item.starred ? t('reader.unstar') : t('reader.star'), () => this.toggleStar(key), { filled: item.starred, on: item.starred, tip: `${item.starred ? t('reader.unstar') : t('reader.star')} (S)` }),
      this.toolbarButton('read', item.read ? 'envelope-simple' : 'envelope-simple-open', item.read ? t('reader.markUnread') : t('reader.markRead'), () => this.toggleRead(key), { tip: `${item.read ? t('reader.markUnread') : t('reader.markRead')} (M)` }),
      item.link ? this.toolbarButton('browser', 'arrow-square-out', t('reader.openBrowser'), () => this.openInBrowser(key), { tip: `${t('reader.openBrowser')} (V)` }) : null,
      h('span', { class: 'grow' }),
      h('button', { class: 'btn subtle icon-btn fd-tb-more', name: 'item-more', 'aria-label': t('reader.more'), 'data-tip': t('reader.more'), 'aria-haspopup': 'menu', onclick: (e) => this.itemMenu(e, key) }, icon('dots-three')),
    );
    // head
    const metaBits = [item.author ? t('reader.by', { author: item.author }) : null, this.fmtLongDate(item.date || item.seen)].filter(Boolean);
    const source = h('button', { class: 'fd-read-source', name: 'source', onclick: () => this.setView({ type: 'feed', id: feed.id }) }, this.feedArt(feed, 'xs'), h('span', { class: 'ellipsis' }, this.feedTitle(feed)));
    const titleEl = h('h1', { class: 'fd-read-title selectable', tabindex: '-1' }, item.title || t('row.noTitle'));
    const head = h('header', { class: 'fd-read-head' });
    if (ep) {
      const cover = h('div', { class: 'fd-ep-cover' }, this.feedArt(feed, 'lg'));
      this.episodeImage(item, feed).then((p) => {
        if (p && cover.isConnected) {
          const img = h('img', { class: 'fd-art fd-art-lg', alt: '', src: this.api.mediaUrl(p) });
          img.addEventListener('error', () => img.remove());
          img.addEventListener('load', () => cover.replaceChildren(img));
        }
      });
      const epBits = [item.season && item.episode ? t('ep.seasonEp', { s: item.season, e: item.episode }) : item.episode ? t('ep.episode', { n: item.episode }) : null, this.fmtLongDate(item.date || item.seen), item.duration ? this.fmtDuration(item.duration) : null].filter(Boolean);
      head.append(cover, h('div', { class: 'fd-ep-head-text' }, source, titleEl, h('div', { class: 'fd-read-meta' }, epBits.join(' · '))));
    } else head.append(source, titleEl, h('div', { class: 'fd-read-meta' }, metaBits.join(' · ')));
    this.epActions = ep ? h('div', { class: 'fd-ep-actions' }) : null;
    this.chaptersEl = ep ? h('div', { class: 'fd-chapters', hidden: true }) : null;
    // body
    const doc = buildArticle({ html, base: item.link || feed.siteUrl || feed.url, allowImages: !!feed.showImages, colors: this.frameColors(), lang: this.ctx.lang, empty: ep ? t('reader.noNotes') : t('reader.noContent') });
    this.remoteImages = doc.remote;
    const info = h('div', { class: 'fd-read-info' });
    if (doc.remote && !feed.showImages) {
      info.appendChild(
        h(
          'div',
          { class: 'infobar fd-images-bar', role: 'status' },
          icon('image'),
          h('div', { class: 'grow' }, t('reader.imagesBlocked')),
          h('button', { class: 'btn small', name: 'show-images', onclick: () => this.setShowImages(feed.id, true) }, t('reader.showImages')),
        ),
      );
    }
    const frame = h('iframe', { class: 'fd-frame', sandbox: 'allow-popups allow-popups-to-escape-sandbox', referrerpolicy: 'no-referrer', title: ep ? t('reader.notes') : t('reader.content'), tabindex: '0' });
    frame.srcdoc = doc.srcdoc;
    const scrollEl = h('div', { class: 'fd-read-scroll' }, head, this.epActions, this.chaptersEl, info, h('div', { class: 'fd-read-body' }, frame));
    this.reader.append(this.readBar, scrollEl);
    this.frame = frame;
    if (ep) {
      this.renderEpisodeActions();
      this.renderChapters();
    }
    if (keep) scrollEl.scrollTop = scroll;
  }

  /** Toolbar / actions refresh after a state change of the open item (no frame reload). */
  updateReaderState() {
    const ref = this.sel && this.store.byKey(this.sel);
    if (!ref || !this.readBar?.isConnected) return;
    const { t } = this;
    const { item, key } = ref;
    const focused = this.readBar.contains(document.activeElement) ? document.activeElement.name : null;
    const star = this.toolbarButton('star', 'star', item.starred ? t('reader.unstar') : t('reader.star'), () => this.toggleStar(key), { filled: item.starred, on: item.starred, tip: `${item.starred ? t('reader.unstar') : t('reader.star')} (S)` });
    const read = this.toolbarButton('read', item.read ? 'envelope-simple' : 'envelope-simple-open', item.read ? t('reader.markUnread') : t('reader.markRead'), () => this.toggleRead(key), { tip: `${item.read ? t('reader.markUnread') : t('reader.markRead')} (M)` });
    this.readBar.querySelector('[name="star"]')?.replaceWith(star);
    this.readBar.querySelector('[name="read"]')?.replaceWith(read);
    if (focused) this.readBar.querySelector(`[name="${focused}"]`)?.focus();
    if (item.enc) this.renderEpisodeActions();
  }

  renderEpisodeActions() {
    const ref = this.sel && this.store.byKey(this.sel);
    if (!ref || !this.epActions?.isConnected) return;
    const { h, t, icon } = this;
    const { item, key } = ref;
    const focused = this.epActions.contains(document.activeElement) ? document.activeElement.name : null;
    const dl = this.dls.get(key);
    const current = this.player.key === key;
    const playing = current && !this.player.paused;
    const pos = current ? this.player.currentTime : item.pos;
    let playLabel = t('ep.play');
    if (playing) playLabel = t('ep.pause');
    else if (pos >= 2 && !item.played) playLabel = t('ep.resume', { time: clock(pos) });
    const btns = [h('button', { class: 'btn primary fd-ep-play', name: 'play', onclick: () => this.play(key) }, icon(playing ? 'pause' : 'play', { filled: true }), playLabel)];
    if (dl) {
      const pct = dl.total ? Math.floor((dl.received / dl.total) * 100) : 0;
      btns.push(
        h(
          'div',
          { class: 'fd-ep-dl' },
          h('div', { class: 'fd-ep-dl-text' }, this.dlText(dl)),
          h('div', { class: ['progress', !dl.total && 'indeterminate'], role: 'progressbar', 'aria-label': t('ep.download'), 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': dl.total ? String(pct) : null }, h('div', { class: 'bar', style: dl.total ? { width: `${pct}%` } : null })),
        ),
        h('button', { class: 'btn fd-ep-cancel', name: 'cancel', onclick: () => this.cancelDownload(key) }, icon('x'), t('ep.cancel')),
      );
    } else if (item.dl) {
      btns.push(h('button', { class: 'btn fd-ep-delete', name: 'delete-dl', onclick: () => this.deleteDownload(key) }, icon('trash'), t('ep.deleteDl'), item.dl.size ? h('span', { class: 'fd-btn-note' }, this.ctx.i18n.formatSize(item.dl.size)) : null));
    } else {
      btns.push(h('button', { class: 'btn fd-ep-download', name: 'download', onclick: () => this.download(key) }, icon('download-simple'), t('ep.download'), item.enc.length ? h('span', { class: 'fd-btn-note' }, this.ctx.i18n.formatSize(item.enc.length)) : null));
    }
    btns.push(h('button', { class: 'btn fd-ep-played', name: 'played', onclick: () => this.setPlayed(key, !item.played) }, icon(item.played ? 'arrow-counter-clockwise' : 'check-circle'), item.played ? t('ep.markUnplayed') : t('ep.markPlayed')));
    this.ui.clear(this.epActions);
    this.epActions.append(...btns);
    if (this.dlError?.key === key) this.epActions.appendChild(h('div', { class: 'fd-ep-error', role: 'alert' }, icon('warning-circle', { size: 16 }), t('ep.downloadFailed', { error: this.errorText(this.dlError.code, this.dlError) })));
    if (focused) this.epActions.querySelector(`[name="${focused}"]`)?.focus();
  }

  async renderChapters() {
    const ref = this.sel && this.store.byKey(this.sel);
    const el = this.chaptersEl;
    if (!ref || !el) return;
    const { h, t } = this;
    const { item, key } = ref;
    let list = item.ichap?.length ? item.ichap : null;
    if (!list && item.chapters) {
      if (!this.chapters.has(key)) {
        this.chapters.set(
          key,
          this.api
            .invoke('feeds:fetch', item.chapters, { accept: 'application/json+chapters, application/json;q=0.9, */*;q=0.5' })
            .then((r) => (r.status === 200 ? parseChapters(r.text) : []))
            .catch(() => []),
        );
      }
      list = await this.chapters.get(key);
      if (!el.isConnected || this.sel !== key) return;
    }
    this.ui.clear(el);
    if (!list?.length) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    el.append(
      h('h2', { class: 'fd-chapters-title' }, t('ep.chapters')),
      h(
        'ol',
        { class: 'fd-chapter-list' },
        list.map((c) => h('li', null, h('button', { class: 'fd-chapter', name: 'chapter', dataset: { start: String(c.start) }, onclick: () => this.playAt(key, c.start) }, h('span', { class: 'fd-chapter-time' }, clock(c.start)), h('span', { class: 'fd-chapter-title' }, c.title)))),
      ),
    );
  }

  async episodeImage(item, feed) {
    if (!item.image || item.image === feed.image) return null;
    return this.cachedImage(item.image);
  }
  cachedImage(url) {
    if (!url) return Promise.resolve(null);
    if (!this.images.has(url)) {
      this.images.set(
        url,
        this.api
          .invoke('feeds:image', url)
          .then((r) => r?.path || null)
          .catch(() => null),
      );
    }
    return this.images.get(url);
  }
  async loadCover(f) {
    if (!f?.image) return;
    const p = await this.cachedImage(f.image);
    if (p && this.store.feed(f.id) && this.store.feed(f.id).image === f.image) this.store.patchFeed(f.id, { imagePath: p });
  }

  setShowImages(feedId, on) {
    this.store.patchFeed(feedId, { showImages: !!on }, { silent: true });
    this.renderReader({ keep: true });
  }

  // ------------------------------------------------------------------ item actions
  toggleStar(key) {
    const ref = this.store.byKey(key);
    if (!ref) return;
    if (this.view.type === 'starred') this.sticky.add(key);
    this.store.patchItem(ref.feed.id, ref.item.id, { starred: !ref.item.starred });
    this.announce(ref.item.starred ? this.t('reader.starredNow') : this.t('reader.unstarredNow'));
  }
  toggleRead(key) {
    const ref = this.store.byKey(key);
    if (!ref) return;
    if (this.view.type === 'unread') this.sticky.add(key);
    this.store.patchItem(ref.feed.id, ref.item.id, { read: !ref.item.read });
  }
  openInBrowser(key) {
    const ref = this.store.byKey(key);
    const link = ref?.item.link;
    if (!link || !/^https?:\/\//i.test(link)) return;
    this.ctx.shell.openUrl(link);
  }
  markAllRead() {
    const refs = this.rows.filter((r) => !r.item.read).map((r) => ({ feedId: r.feed.id, itemId: r.item.id }));
    if (!refs.length) return;
    if (this.view.type === 'unread') for (const r of this.rows) this.sticky.add(r.key);
    this.store.patchMany(refs, { read: true });
    this.announce(this.t('list.markedAll', { count: refs.length }));
  }
  markFeedRead(feedIds) {
    const set = new Set(feedIds);
    const refs = [];
    for (const f of this.store.feeds) if (set.has(f.id)) for (const it of this.store.list(f.id)) if (!it.read) refs.push({ feedId: f.id, itemId: it.id });
    this.store.patchMany(refs, { read: true });
  }
  setPlayed(key, played) {
    const ref = this.store.byKey(key);
    if (!ref) return;
    this.store.patchItem(ref.feed.id, ref.item.id, played ? { played: true, read: true, pos: 0 } : { played: false });
    if (played && this.player.key === key) {
      this.player.pause();
    }
  }

  itemMenu(e, key) {
    const ref = this.store.byKey(key);
    if (!ref) return;
    const { t } = this;
    const { feed, item } = ref;
    const ep = !!item.enc;
    this.ui.menu(e, cleanMenu([
      { label: item.read ? t('reader.markUnread') : t('reader.markRead'), icon: item.read ? 'envelope-simple' : 'envelope-simple-open', shortcut: 'M', action: () => this.toggleRead(key) },
      { label: item.starred ? t('reader.unstar') : t('reader.star'), icon: 'star', shortcut: 'S', action: () => this.toggleStar(key) },
      ep ? '-' : null,
      ep ? { label: this.player.key === key && !this.player.paused ? t('ep.pause') : t('ep.play'), icon: 'play', action: () => this.play(key) } : null,
      ep && !item.dl && !this.dls.has(key) ? { label: t('ep.download'), icon: 'download-simple', action: () => this.download(key) } : null,
      ep && this.dls.has(key) ? { label: t('ep.cancel'), icon: 'x', action: () => this.cancelDownload(key) } : null,
      ep && item.dl ? { label: t('ep.deleteDl'), icon: 'trash', action: () => this.deleteDownload(key) } : null,
      ep ? { label: item.played ? t('ep.markUnplayed') : t('ep.markPlayed'), icon: 'check-circle', action: () => this.setPlayed(key, !item.played) } : null,
      '-',
      item.link ? { label: t('reader.openBrowser'), icon: 'arrow-square-out', shortcut: 'V', action: () => this.openInBrowser(key) } : null,
      item.link ? { label: t('reader.copyLink'), icon: 'link', action: () => this.api.invoke('clipboard:writeText', item.link).catch(() => {}) } : null,
      this.sel === key && (this.remoteImages || feed.showImages) ? { label: feed.showImages ? t('menu.hideImages') : t('reader.showImages'), icon: 'image', action: () => this.setShowImages(feed.id, !feed.showImages) } : null,
    ]));
  }

  // ------------------------------------------------------------------ downloads & playback
  onProgress(p) {
    if (!p?.id || this.closed) return;
    const key = p.id;
    const d = this.dls.get(key);
    if (!d || !['progress', 'queued'].includes(p.state)) return;
    const shapeChanged = d.state !== p.state || !d.total !== !p.total;
    Object.assign(d, { received: p.received || 0, total: p.total || 0, state: p.state });
    if (shapeChanged) {
      this.updateRow(key);
      if (this.sel === key) this.renderEpisodeActions();
    } else this.paintProgress(key);
    if (this.pendingPlay === key) this.renderPlayerStatus();
  }

  /** Progress text and bars updated in place (the buttons stay the same elements, so they can be clicked). */
  paintProgress(key) {
    const d = this.dls.get(key);
    if (!d) return;
    const pct = d.total ? Math.floor((d.received / d.total) * 100) : 0;
    const rowText = this.rowsEl?.querySelector(`.fd-row[data-key="${CSS.escape(key)}"] .fd-row-dl-text`);
    if (rowText) rowText.textContent = this.dlRowText(d);
    if (this.sel === key && this.epActions?.isConnected) {
      const text = this.epActions.querySelector('.fd-ep-dl-text');
      if (text) text.textContent = this.dlText(d);
      const bar = this.epActions.querySelector('.fd-ep-dl .progress');
      if (bar && d.total) {
        bar.querySelector('.bar').style.width = `${pct}%`;
        bar.setAttribute('aria-valuenow', String(pct));
      }
    }
  }
  dlRowText(d) {
    return d.state === 'queued' ? this.t('row.queued') : this.t('row.downloading', { pct: d.total ? Math.floor((d.received / d.total) * 100) : 0 });
  }
  dlText(d) {
    const { t } = this;
    if (d.state === 'queued') return t('row.queued');
    return d.total ? t('ep.downloadingPct', { pct: Math.floor((d.received / d.total) * 100), size: this.ctx.i18n.formatSize(d.total) }) : t('ep.downloadingSize', { size: this.ctx.i18n.formatSize(d.received) });
  }

  async download(key, { play = false } = {}) {
    const ref = this.store.byKey(key);
    if (!ref?.item.enc || this.dls.has(key)) return this.dlPromises?.get(key);
    const { feed, item } = ref;
    this.dlError = null;
    this.dls.set(key, { received: 0, total: item.enc.length || 0, state: 'queued' });
    this.dlPromises ||= new Map();
    if (play) this.pendingPlay = key;
    this.renderNav();
    if (this.view.type === 'downloads') this.renderList({ keepScroll: true });
    else this.updateRow(key);
    if (this.sel === key) this.renderEpisodeActions();
    this.renderPlayer();
    const job = this.api
      .invoke('feeds:download', key, item.enc.url, { podcast: this.feedTitle(feed), title: item.title || this.t('row.noTitle'), type: item.enc.type })
      .then(
        (res) => {
          this.dls.delete(key);
          this.dlPromises.delete(key);
          if (this.closed) return null;
          this.store.patchItem(feed.id, item.id, { dl: { path: res.path, size: res.size } });
          this.announce(this.t('ep.downloaded', { name: item.title }));
          if (this.pendingPlay === key) {
            this.pendingPlay = null;
            this.startPlayback(key);
          }
          return res;
        },
        (e) => {
          this.dls.delete(key);
          this.dlPromises.delete(key);
          if (this.pendingPlay === key) this.pendingPlay = null;
          if (this.closed) return null;
          if (e.code !== 'ECANCELED') {
            this.dlError = { key, code: e.code, status: e.status, message: e.message };
            this.announce(this.t('ep.downloadFailed', { error: this.errorText(e.code, e) }));
          }
          this.renderNav();
          this.renderList({ keepScroll: true });
          if (this.sel === key) this.renderEpisodeActions();
          this.renderPlayer();
          return null;
        },
      );
    this.dlPromises.set(key, job);
    return job;
  }

  cancelDownload(key) {
    if (this.pendingPlay === key) this.pendingPlay = null;
    return this.api.invoke('feeds:cancel', key).catch(() => false);
  }

  async deleteDownload(key, { quiet = false } = {}) {
    const ref = this.store.byKey(key);
    if (!ref?.item.dl) return false;
    if (this.player.key === key) this.player.stop();
    try {
      await this.api.invoke('feeds:deleteFile', ref.item.dl.path);
    } catch (e) {
      // already gone: forget it anyway
      const st = await this.api.invoke('feeds:files', [ref.item.dl.path]).catch(() => ({}));
      if (st[ref.item.dl.path] != null) {
        if (!quiet) this.ui.alert(this.errorLine(e.code, e), { parent: this.win });
        return false;
      }
    }
    this.store.patchItem(ref.feed.id, ref.item.id, { dl: null });
    this.renderPlayer();
    return true;
  }

  /** Forget downloads whose file was deleted outside the app. */
  async checkFiles() {
    const refs = [];
    for (const f of this.store.feeds) for (const it of this.store.list(f.id)) if (it.dl) refs.push({ feedId: f.id, itemId: it.id, path: it.dl.path });
    if (!refs.length) return;
    const st = await this.api.invoke('feeds:files', refs.map((r) => r.path)).catch(() => null);
    if (!st) return;
    const gone = refs.filter((r) => st[r.path] == null);
    if (gone.length) this.store.patchMany(gone, { dl: null });
  }

  async clearPlayed() {
    const { t } = this;
    const refs = [];
    let size = 0;
    for (const f of this.store.feeds) {
      for (const it of this.store.list(f.id)) {
        if (it.dl && it.played) {
          refs.push(itemKey(f.id, it.id));
          size += it.dl.size || 0;
        }
      }
    }
    if (!refs.length) {
      await this.ui.alert(t('clear.none'), { title: t('clear.title'), parent: this.win });
      return 0;
    }
    const ok = await this.ui.confirm(t('clear.text', { count: refs.length, size: this.ctx.i18n.formatSize(size) }), { title: t('clear.title'), okLabel: t('clear.ok'), danger: true, parent: this.win });
    if (!ok) return 0;
    let n = 0;
    for (const key of refs) if (await this.deleteDownload(key, { quiet: true })) n++;
    this.announce(t('clear.done', { count: n }));
    return n;
  }

  /** Play / pause an episode: the downloaded file, or download it first. */
  async play(key) {
    const ref = this.store.byKey(key);
    if (!ref?.item.enc) return;
    if (this.player.key === key && this.player.loaded) {
      await this.player.toggle();
      this.renderPlayer();
      return;
    }
    if (this.pendingPlay === key) return;
    this.savePosition(true);
    if (ref.item.dl) return this.startPlayback(key);
    this.pendingPlay = key;
    this.renderPlayer();
    if (!this.dls.has(key)) await this.download(key, { play: true });
  }
  async playAt(key, t) {
    const ref = this.store.byKey(key);
    if (!ref) return;
    if (this.player.key === key && this.player.loaded) {
      this.player.seek(t);
      if (this.player.paused) this.player.play();
      return;
    }
    this.store.patchItem(ref.feed.id, ref.item.id, { pos: t, played: false }, { silent: true });
    return this.play(key);
  }

  async startPlayback(key) {
    const ref = this.store.byKey(key);
    if (!ref?.item.dl) return;
    const { item } = ref;
    let at = item.played ? 0 : item.pos || 0;
    if (item.duration && at > item.duration - 5) at = 0;
    if (item.played) this.store.patchItem(ref.feed.id, item.id, { played: false }, { silent: true });
    await this.player.load(key, item.dl.path, { at, autoplay: true, rate: this.store.prefs.speed || 1 });
    this.renderPlayer();
    this.updateRow(key);
    if (this.sel === key) this.renderEpisodeActions();
  }

  savePosition(force = false) {
    const key = this.player.key;
    if (!key) return;
    const now = Date.now();
    if (!force && now - this.lastPosSave < SAVE_POS_MS) return;
    this.lastPosSave = now;
    const ref = this.store.byKey(key);
    if (!ref) return;
    const pos = Math.floor(this.player.currentTime);
    const patch = { pos };
    const dur = Math.round(this.player.duration);
    if (dur && (!ref.item.duration || Math.abs(ref.item.duration - dur) > 2)) patch.duration = dur;
    this.store.patchItem(ref.feed.id, ref.item.id, patch, { silent: true });
  }

  onTime() {
    this.savePosition();
    this.renderPlayerTime();
  }
  onMeta() {
    this.renderPlayerTime();
    this.savePosition(true);
  }
  onEnded() {
    const key = this.player.key;
    const ref = key && this.store.byKey(key);
    if (ref) this.store.patchItem(ref.feed.id, ref.item.id, { played: true, read: true, pos: 0 });
    this.announce(this.t('player.ended'));
    this.renderPlayer();
  }
  onPlayError() {
    const key = this.player.key;
    this.announce(this.t('player.error'));
    if (key) this.checkFiles();
  }

  // ------------------------------------------------------------------ mini-player
  buildPlayer() {
    const { h, t, icon } = this;
    const btn = (cls, name, ic, label, fn, extra) => h('button', { class: ['btn', 'subtle', 'icon-btn', cls], name, 'aria-label': label, 'data-tip': label, onclick: fn }, icon(ic), extra ? h('span', { class: 'fd-skip-n', 'aria-hidden': 'true' }, extra) : null);
    this.plArt = h('span', { class: 'fd-pl-art' });
    this.plTitle = h('div', { class: 'fd-pl-title ellipsis' });
    this.plSub = h('div', { class: 'fd-pl-sub ellipsis' });
    this.plBack = btn('fd-pl-back', 'back', 'arrow-counter-clockwise', t('player.back15'), () => this.player.skip(-15), '15');
    this.plPlay = h('button', { class: 'btn primary icon-btn fd-pl-play', name: 'pl-play', 'aria-label': t('player.play'), onclick: () => this.player.key && this.play(this.player.key) }, icon('play', { filled: true }));
    this.plFwd = btn('fd-pl-fwd', 'forward', 'arrow-clockwise', t('player.fwd30'), () => this.player.skip(30), '30');
    this.plTime = h('span', { class: 'fd-pl-time' }, '0:00');
    this.plLeft = h('span', { class: 'fd-pl-time' }, '0:00');
    this.plSeek = this.ui.slider({
      min: 0,
      max: 1000,
      step: 1,
      value: 0,
      oninput: (v) => {
        this.seeking = true;
        const d = this.player.duration;
        if (d) this.plTime.textContent = clock((v / 1000) * d);
      },
      onchange: (v) => {
        this.seeking = false;
        const d = this.player.duration;
        if (d) this.player.seek((v / 1000) * d);
        this.savePosition(true);
      },
    });
    this.plSeek.classList.add('fd-pl-seek');
    this.plSeek.setAttribute('aria-label', t('player.seek'));
    this.plSpeed = h('button', { class: 'btn subtle fd-pl-speed', name: 'speed', 'aria-label': t('player.speed'), 'data-tip': t('player.speed'), 'aria-haspopup': 'menu', onclick: (e) => this.speedMenu(e) }, '1×');
    this.plSleepLabel = h('span', { class: 'fd-pl-sleep-left' });
    this.plSleep = h('button', { class: 'btn subtle fd-pl-sleep', name: 'sleep', 'aria-label': t('player.sleep'), 'data-tip': t('player.sleep'), 'aria-haspopup': 'menu', onclick: (e) => this.sleepMenu(e) }, icon('moon'), this.plSleepLabel);
    this.plClose = btn('fd-pl-close', 'pl-close', 'x', t('player.close'), () => this.closePlayer());
    this.plStatus = h('div', { class: 'fd-pl-status' });
    this.playerEl = h(
      'div',
      { class: 'fd-player', role: 'region', 'aria-label': t('player.label'), hidden: true },
      h('button', { class: 'fd-pl-info', name: 'pl-info', 'aria-label': t('player.showEpisode'), onclick: () => this.revealPlaying() }, this.plArt, h('span', { class: 'fd-pl-text' }, this.plTitle, this.plSub)),
      h('div', { class: 'fd-pl-center' }, h('div', { class: 'fd-pl-controls' }, this.plBack, this.plPlay, this.plFwd), h('div', { class: 'fd-pl-bar' }, this.plTime, this.plSeek, this.plLeft), this.plStatus),
      h('div', { class: 'fd-pl-side' }, this.plSpeed, this.plSleep, this.plClose),
    );
  }

  renderPlayer() {
    if (!this.playerEl) return;
    const { t, icon } = this;
    const key = this.player.key || this.pendingPlay;
    const ref = key && this.store.byKey(key);
    this.playerEl.hidden = !ref;
    if (!ref) {
      this.lastPlayerSig = null;
      return;
    }
    const { feed, item } = ref;
    const pending = !this.player.key || this.player.key !== key;
    if (this.plArt.dataset.feed !== feed.id || this.plArt.dataset.path !== (feed.imagePath || '')) {
      this.plArt.dataset.feed = feed.id;
      this.plArt.dataset.path = feed.imagePath || '';
      this.plArt.replaceChildren(this.feedArt(feed, 'sm'));
    }
    this.plTitle.textContent = item.title || t('row.noTitle');
    this.plTitle.title = item.title || '';
    this.plSub.textContent = this.feedTitle(feed);
    const playing = !pending && !this.player.paused;
    this.plPlay.replaceChildren(icon(playing ? 'pause' : 'play', { filled: true }));
    this.plPlay.setAttribute('aria-label', playing ? t('player.pause') : t('player.play'));
    this.plPlay.dataset.tip = `${playing ? t('player.pause') : t('player.play')} (${t('player.spaceKey')})`;
    this.plPlay.disabled = pending;
    for (const b of [this.plBack, this.plFwd, this.plSeek]) b.disabled = pending;
    this.plSpeed.textContent = this.fmtSpeed(this.player.rate);
    this.playerEl.classList.toggle('pending', pending);
    this.renderPlayerStatus();
    this.renderPlayerTime();
    this.renderSleep();
    // the list row and the reader show the play state too (re-drawn only when it changes)
    const sig = `${key}|${playing}|${pending}`;
    if (sig !== this.lastPlayerSig) {
      this.lastPlayerSig = sig;
      this.updateRow(key);
      if (this.sel === key) this.renderEpisodeActions();
      if (this.lastPlayerKey && this.lastPlayerKey !== key) this.updateRow(this.lastPlayerKey);
      this.lastPlayerKey = key;
    }
  }

  renderPlayerStatus() {
    const { t } = this;
    const key = this.player.key || this.pendingPlay;
    const pending = !!key && this.player.key !== key;
    const dl = pending && this.dls.get(key);
    this.plStatus.textContent = pending ? (dl && dl.total ? t('player.downloading', { pct: Math.floor((dl.received / dl.total) * 100) }) : t('player.downloadingStart')) : '';
  }

  renderPlayerTime() {
    if (!this.plSeek || this.seeking) return;
    const d = this.player.duration;
    const c = this.player.currentTime;
    const key = this.player.key;
    if (!key) {
      const ref = this.pendingPlay && this.store.byKey(this.pendingPlay);
      this.plTime.textContent = clock(ref?.item.pos || 0);
      this.plLeft.textContent = ref?.item.duration ? `-${clock(ref.item.duration - (ref.item.pos || 0))}` : '';
      this.plSeek.setValue(ref?.item.duration ? Math.round(((ref.item.pos || 0) / ref.item.duration) * 1000) : 0);
      return;
    }
    this.plTime.textContent = clock(c);
    this.plLeft.textContent = d ? `-${clock(Math.max(0, d - c))}` : '';
    this.plSeek.setValue(d ? Math.round((c / d) * 1000) : 0);
    this.plSeek.setAttribute('aria-valuetext', `${clock(c)} / ${clock(d)}`);
  }

  renderSleep() {
    if (!this.plSleepLabel) return;
    const left = this.player.sleepLeft;
    this.plSleep.classList.toggle('on', left != null);
    this.plSleepLabel.textContent = left == null ? '' : clock(left);
    this.plSleep.setAttribute('aria-label', left == null ? this.t('player.sleep') : this.t('player.sleepLeft', { time: clock(left) }));
  }

  speedMenu(e) {
    const cur = this.player.rate;
    this.ui.menu(
      e,
      SPEEDS.map((r) => ({
        label: this.fmtSpeed(r),
        checked: Math.abs(cur - r) < 0.01,
        action: () => this.setSpeed(r),
      })),
      { above: true },
    );
  }
  setSpeed(r) {
    this.player.setRate(r);
    this.store.setPref('speed', r);
    this.renderPlayer();
  }

  sleepMenu(e) {
    const { t } = this;
    const on = this.player.sleepLeft != null;
    this.ui.menu(
      e,
      [
        { header: t('player.sleep') },
        ...[5, 15, 30, 45, 60].map((m) => ({ label: t('player.sleepIn', { min: m }), action: () => this.player.setSleep(m) })),
        on ? '-' : null,
        on ? { label: t('player.sleepOff'), icon: 'x', action: () => this.player.setSleep(null) } : null,
      ].filter(Boolean),
      { above: true },
    );
  }

  closePlayer() {
    this.savePosition(true);
    const key = this.player.key || this.pendingPlay;
    if (this.pendingPlay) this.pendingPlay = null;
    this.player.stop();
    this.renderPlayer();
    if (key) this.updateRow(key);
    if (key && this.sel === key) this.renderEpisodeActions();
    this.playerEl.hidden = true;
  }

  revealPlaying() {
    const key = this.player.key || this.pendingPlay;
    if (!key) return;
    if (!this.rows.some((r) => r.key === key)) this.setView({ type: 'feed', id: splitKey(key)[0] });
    this.open(key, { focusReader: true });
    this.rowsEl.querySelector(`.fd-row[data-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  // ------------------------------------------------------------------ keyboard
  onKey(e) {
    if (e.defaultPrevented) return;
    if (e.key === 'F5') {
      e.preventDefault();
      this.refreshAll({ manual: true });
      return;
    }
    const tgt = e.target;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(tgt.tagName) || tgt.isContentEditable;
    if (typing || e.ctrlKey || e.altKey || e.metaKey) return;
    if (tgt.closest?.('.dialog-layer, .menu')) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (k === 'j') this.step(1);
    else if (k === 'k') this.step(-1);
    else if (k === 'm' && this.sel) this.toggleRead(this.sel);
    else if (k === 's' && this.sel) this.toggleStar(this.sel);
    else if (k === 'v' && this.sel) this.openInBrowser(this.sel);
    else if (k === ' ' && this.player.key && !tgt.closest('button, a, [role="option"], iframe')) this.play(this.player.key);
    else if (k === 'Escape' && this.back()) {
      /* back to the list */
    } else return;
    e.preventDefault();
  }

  // ------------------------------------------------------------------ menus
  appMenu(e) {
    const { t } = this;
    this.ui.menu(e, [
      { label: t('menu.import'), icon: 'upload-simple', action: () => this.importOpml() },
      { label: t('menu.export'), icon: 'export', disabled: !this.store.feeds.length, action: () => this.exportOpml() },
      '-',
      { label: t('menu.markAll'), icon: 'list-checks', disabled: !this.store.counts().unread, action: () => this.markFeedRead(this.store.feeds.map((f) => f.id)) },
      { label: t('menu.clearPlayed'), icon: 'broom', action: () => this.clearPlayed() },
      { label: t('menu.openFolder'), icon: 'folder-open', action: () => this.openPodcastsFolder() },
    ]);
  }
  viewMenu(e) {
    if (this.view.type === 'feed') this.feedMenu(e, this.store.feed(this.view.id));
    else if (this.view.type === 'folder') this.folderMenu(e, this.view.id);
  }
  feedMenu(e, f) {
    if (!f) return;
    const { t } = this;
    this.ui.menu(e, cleanMenu([
      { label: t('menu.refresh'), icon: 'arrows-clockwise', action: () => this.refreshFeeds([f], { manual: true }) },
      { label: t('menu.markRead'), icon: 'list-checks', action: () => this.markFeedRead([f.id]) },
      '-',
      { label: t('menu.rename'), icon: 'pencil-simple', action: () => this.renameFeed(f) },
      { label: t('menu.folder'), icon: 'folder-simple', action: () => this.moveToFolder(f) },
      { label: f.showImages ? t('menu.hideImages') : t('menu.showImages'), icon: 'image', action: () => this.setShowImages(f.id, !f.showImages) },
      '-',
      f.siteUrl ? { label: t('menu.openSite'), icon: 'globe', action: () => this.ctx.shell.openUrl(f.siteUrl) } : null,
      { label: t('menu.copyUrl'), icon: 'link', action: () => this.api.invoke('clipboard:writeText', f.url).catch(() => {}) },
      '-',
      { label: t('menu.unsubscribe'), icon: 'trash', danger: true, action: () => this.unsubscribe(f) },
    ]));
  }
  folderMenu(e, folder) {
    const { t } = this;
    const ids = this.store.feeds.filter((f) => f.folder === folder).map((f) => f.id);
    this.ui.menu(e, [
      { label: t('menu.markRead'), icon: 'list-checks', action: () => this.markFeedRead(ids) },
      { label: t('menu.renameFolder'), icon: 'pencil-simple', action: () => this.renameFolder(folder) },
      { label: t('menu.removeFolder'), icon: 'folder-simple', action: () => this.removeFolder(folder) },
    ]);
  }

  async renameFeed(f) {
    const { t } = this;
    const v = await this.ui.prompt({ title: t('dialog.renameTitle'), label: t('dialog.renameLabel'), value: this.feedTitle(f), parent: this.win, maxlength: 200, select: true });
    if (v == null) return;
    const name = v.replace(/\s+/g, ' ').trim();
    this.store.patchFeed(f.id, { customTitle: name && name !== f.title ? name : '' });
  }
  async moveToFolder(f) {
    const { t } = this;
    const v = await this.ui.prompt({ title: t('dialog.folderTitle'), label: t('dialog.folderLabel'), value: f.folder || '', parent: this.win, maxlength: 100 });
    if (v == null) return;
    this.store.patchFeed(f.id, { folder: v.replace(/\s+/g, ' ').trim() });
  }
  async renameFolder(folder) {
    const { t } = this;
    const v = await this.ui.prompt({ title: t('dialog.renameFolderTitle'), label: t('dialog.renameLabel'), value: folder, parent: this.win, maxlength: 100 });
    if (v == null) return;
    const name = v.replace(/\s+/g, ' ').trim();
    if (!name || name === folder) return;
    for (const f of this.store.feeds) if (f.folder === folder) this.store.patchFeed(f.id, { folder: name }, { silent: true });
    if (this.view.type === 'folder' && this.view.id === folder) this.view = { type: 'folder', id: name };
    this.store.emit('feeds');
  }
  removeFolder(folder) {
    for (const f of this.store.feeds) if (f.folder === folder) this.store.patchFeed(f.id, { folder: '' }, { silent: true });
    this.store.emit('feeds');
  }
  async unsubscribe(f) {
    const { t } = this;
    const ok = await this.ui.confirm(t('dialog.unsubText', { name: this.feedTitle(f) }), { title: t('dialog.unsubTitle'), okLabel: t('dialog.unsubOk'), danger: true, parent: this.win });
    if (!ok) return false;
    for (const key of [...this.dls.keys()]) if (splitKey(key)[0] === f.id) await this.cancelDownload(key);
    if (this.player.key && splitKey(this.player.key)[0] === f.id) this.closePlayer();
    if (this.view.type === 'feed' && this.view.id === f.id) this.view = { type: 'all' };
    await this.store.removeFeed(f.id);
    this.announce(t('dialog.unsubDone', { name: this.feedTitle(f) }));
    return true;
  }

  async openPodcastsFolder() {
    const dirs = await this.api.invoke('feeds:dirs').catch(() => null);
    if (!dirs) return;
    await this.api.invoke('fs:mkdir', dirs.podcasts).catch(() => {});
    this.ctx.shell.launch('files', { path: dirs.podcasts });
  }

  // ------------------------------------------------------------------ subscribe & refresh
  addDialog(opts = {}) {
    return openAddDialog(this, opts);
  }

  /** Subscribe from a fetch result (already parsed). Returns the feed. */
  async subscribe(url, res, parsed, { folder = '', select = true } = {}) {
    const existing = this.store.feedByUrl(url) || (res?.url && this.store.feedByUrl(res.url));
    if (existing) {
      if (select) this.setView({ type: 'feed', id: existing.id });
      return { feed: existing, existing: true };
    }
    const f = this.store.addFeed({ url: res?.permanent && res.url ? res.url : url, title: parsed?.title || hostOf(url), siteUrl: parsed?.siteUrl || '', folder });
    if (res && parsed) await this.applyFetch(f, res, parsed);
    if (select) this.setView({ type: 'feed', id: f.id });
    this.announce(this.t('add.added', { name: this.feedTitle(this.store.feed(f.id)) }));
    return { feed: this.store.feed(f.id), existing: false };
  }

  async applyFetch(f, res, parsed = null) {
    const patch = { lastFetch: Date.now(), lastStatus: res.status, error: null, retryAt: null };
    if (res.permanent && res.url && res.url !== f.url && !this.store.feedByUrl(res.url)) patch.url = res.url;
    if (res.status === 304) {
      this.store.patchFeed(f.id, patch);
      return { added: [] };
    }
    const p = parsed || parseFeed(res.text, res.url);
    Object.assign(patch, {
      title: p.title || f.title || hostOf(f.url),
      siteUrl: p.siteUrl || f.siteUrl,
      description: p.description || f.description,
      author: p.author || f.author,
      podcast: !!p.podcast,
      ttl: p.ttl,
      etag: res.etag || null,
      lastModified: res.lastModified || null,
    });
    if (p.image !== f.image) Object.assign(patch, { image: p.image || '', imagePath: '' });
    const merged = await this.store.merge(f.id, p);
    this.store.patchFeed(f.id, patch);
    const now = this.store.feed(f.id);
    if (now?.image && !now.imagePath) this.loadCover(now);
    return merged;
  }

  async refreshFeed(f, { manual = false } = {}) {
    const cur = this.store.feed(f.id);
    if (!cur) return;
    if (!manual && cur.retryAt && cur.retryAt > Date.now()) return;
    try {
      const res = await getDoc(this.api, cur.url, { etag: cur.etag, lastModified: cur.lastModified });
      if (!this.store.feed(f.id)) return;
      await this.applyFetch(cur, res);
    } catch (e) {
      if (!this.store.feed(f.id)) return;
      let retryAt = null;
      if (e.retryAfter) retryAt = Date.now() + e.retryAfter;
      else if (e.status === 429 || e.status === 503) retryAt = Date.now() + 3600000;
      this.store.patchFeed(f.id, { lastFetch: Date.now(), error: e.code || 'EFAIL', lastStatus: e.status || null, retryAt });
    } finally {
      this.progress.done++;
      this.renderStatus();
    }
  }

  refreshFeeds(feeds, { manual = false } = {}) {
    if (!feeds.length) return Promise.resolve();
    const run = async () => {
      this.progress = { done: 0, total: feeds.length };
      this.renderStatus();
      await pool(feeds, 4, (f) => this.refreshFeed(f, { manual }), { key: (f) => f.url, perHost: 2 });
      this.lastRefresh = Date.now();
    };
    const prev = this.refreshing || Promise.resolve();
    const job = prev.then(run).finally(() => {
      if (this.refreshing !== job) return;
      this.refreshing = null;
      clearTimeout(this.storeTimer);
      this.storeTimer = null;
      this.pendingStore = null;
      this.renderStatus();
      this.drawStore('items', null);
    });
    this.refreshing = job;
    this.renderStatus();
    return job;
  }

  /** reason: 'open' (feeds older than 10 min), 'auto' (older than 25 min or their <ttl>), manual: every feed. */
  refreshAll({ manual = false, reason = 'auto' } = {}) {
    if (this.refreshing && !manual) return this.refreshing;
    const now = Date.now();
    const feeds = this.store.feeds.filter((f) => {
      if (manual) return true;
      if (f.retryAt && f.retryAt > now) return false;
      if (!f.lastFetch) return true;
      const min = reason === 'open' ? OPEN_MIN_AGE : Math.max(AUTO_MIN_AGE, (f.ttl || 0) * 60000);
      return now - f.lastFetch >= min;
    });
    if (!feeds.length) {
      if (manual) this.lastRefresh = now;
      this.renderStatus();
      return Promise.resolve();
    }
    return this.refreshFeeds(feeds, { manual });
  }

  // ------------------------------------------------------------------ OPML
  async importOpml(path) {
    const { t, ui } = this;
    if (!path) path = await ui.filePicker({ mode: 'open', title: t('opml.importTitle'), filters: [{ name: t('opml.files'), ext: ['.opml', '.xml'] }], parent: this.win });
    if (!path) return null;
    let list;
    try {
      list = parseOpml(await this.api.invoke('fs:readText', path, { maxBytes: 5 * 1024 * 1024 }));
    } catch (e) {
      await ui.alert(t('opml.importFailed', { error: e.code === 'EPARSE' ? t('opml.notOpml') : e.message }), { parent: this.win });
      return null;
    }
    const added = [];
    for (const o of list) {
      if (this.store.feedByUrl(o.url)) continue;
      added.push(this.store.addFeed({ url: o.url, title: o.title || hostOf(o.url), siteUrl: o.siteUrl, folder: o.folder }));
    }
    this.announce(added.length ? t('opml.imported', { count: added.length }) : t('opml.none'));
    this.ctx.shell.notify?.({ appId: 'feeds', title: added.length ? t('opml.imported', { count: added.length }) : t('opml.none'), timeout: 4000, silent: true });
    if (added.length) await this.refreshFeeds(added, { manual: true });
    return added.length;
  }

  async exportOpml(path) {
    const { t, ui } = this;
    if (!path) {
      const xdg = await this.api.invoke('fs:xdg').catch(() => ({}));
      path = await ui.filePicker({ mode: 'save', title: t('opml.exportTitle'), name: t('opml.fileName'), path: xdg.documents, filters: [{ name: t('opml.files'), ext: ['.opml'] }], parent: this.win });
    }
    if (!path) return null;
    if (!/\.(opml|xml)$/i.test(path)) path += '.opml';
    const feeds = this.store.sortedFeeds().map((f) => ({ url: f.url, title: this.feedTitle(f), siteUrl: f.siteUrl, folder: f.folder }));
    await this.api.invoke('fs:writeText', path, buildOpml(feeds, t('opml.title')));
    this.ctx.shell.notify?.({ appId: 'feeds', title: t('opml.exported', { name: path.split('/').pop() }), body: path, timeout: 4000, silent: true });
    return path;
  }

  /** Launch / relaunch arguments: { file: '….opml' } imports it; { url } opens the add dialog with that address. */
  async handleArgs(args = {}) {
    if (args.file && /\.(opml|xml)$/i.test(args.file)) await this.importOpml(args.file);
    else if (typeof args.url === 'string' && /^(https?|feed):/i.test(args.url)) this.addDialog({ url: args.url });
  }
}
