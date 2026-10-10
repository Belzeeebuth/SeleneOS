// Media Player application: layout (navigation pane, pages, now playing stage, transport bar),
// routing, playback orchestration (play queue + player), keyboard shortcuts, drag & drop,
// menus, dialogs, mini player / full screen, and persistence.
import { MEDIA_EXT, AUDIO_EXT, VIDEO_EXT, isMedia, kindOf, baseName, dirName, stem, debounce, clamp, formatTime, extOf } from './util.js';
import { PlayQueue } from './queue.js';
import { Library } from './library.js';
import { Player } from './player.js';
import { Playlists } from './playlists.js';
import { Transport } from './transport.js';
import { Stage } from './stage.js';
import { ROW_MIME } from './components.js';
import * as V from './views.js';

const FILES_MIME = 'application/x-aurora-paths';
const EASE = 'cubic-bezier(0.1, 0.9, 0.2, 1)';
const RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const DEFAULT_PREFS = { visualizer: 'bars', resume: true, videoStage: true, songSort: 'az', videoSort: 'az', navCollapsed: false, playlistsOpen: true, showRemaining: false };
const reduceMotion = () => document.documentElement.dataset.animations === 'off';

export class MediaApp {
  constructor(ctx) {
    this.ctx = ctx;
    this.h = ctx.h;
    this.icon = ctx.icon;
    this.t = ctx.t;
    this.ui = ctx.ui;
    this.api = ctx.api;
    this.win = ctx.win;
    this.shell = ctx.shell;
    this.storage = ctx.storage;
    this.i18n = ctx.i18n;
    this.appUrl = ctx.appUrl;
    this.prefs = { ...DEFAULT_PREFS };
    this.recent = [];
    this.route = { name: 'home' };
    this.history = [];
    this.lists = [];
    this.view = null;
    this.stageOpen = false;
    this.mini = false;
    this.navOverlay = false;
    this.navMode = 'expanded';
    this.dragPaths = null;
    this._errStreak = 0;
    this._disposers = [];
  }
  get locale() {
    return this.i18n?.locale || 'en-US';
  }

  // ================================================================== init
  async init() {
    const { api } = this;
    const xdg = await api.invoke('fs:xdg').catch(() => ({ home: this.ctx.env?.home || '/home/user' }));
    this.xdg = xdg;
    this.home = xdg.home;
    this.queue = new PlayQueue();
    this.player = new Player({ api });
    this.lib = new Library({ api, storage: this.storage, home: this.home, xdg, locale: () => this.locale });
    this.playlists = new Playlists(this.storage);
    const [prefs, recent, state] = await Promise.all([
      this.storage.get('prefs', {}).catch(() => ({})),
      this.storage.get('recent', []).catch(() => []),
      this.storage.get('state', null).catch(() => null),
      this.lib.load(),
      this.playlists.load(),
    ]);
    Object.assign(this.prefs, prefs && typeof prefs === 'object' ? prefs : {});
    this.recent = Array.isArray(recent) ? recent.filter((p) => typeof p === 'string').slice(0, 30) : [];
    this._build();
    // Test / automation hook (like Paint's win.el.__paint).
    this.win.el.__media = this;
    this._bindPlayer();
    this._bindKeys();
    this._bindDnD();
    this._bindWindow();
    this.lib.on((ev) => this._onLibrary(ev));
    this.playlists.on(() => this._onPlaylists());
    this.queue.on((why) => this._onQueue(why));
    // Restore volume / speed / queue.
    if (state && typeof state === 'object') {
      if (Number.isFinite(state.volume)) this.player.setVolume(state.volume);
      if (state.muted) this.player.setMuted(true);
      if (Number.isFinite(state.rate) && RATES.includes(state.rate)) this.player.setRate(state.rate);
    }
    const args = this.ctx.args || {};
    const wantFiles = this._argPaths(args);
    if (!wantFiles.length && this.prefs.resume !== false && state?.queue) {
      const q = PlayQueue.from(state.queue);
      this.queue.items = q.items;
      this.queue.index = q.index;
      this.queue.shuffle = q.shuffle;
      this.queue.repeat = q.repeat;
      this.queue.order = q.order;
      if (this.queue.current) {
        await this.lib.ensure(this.queue.current.path);
        this.player.load(this.queue.current.path, { autoplay: false, at: Number(state.pos) || 0 });
      }
    }
    this.render();
    this.updateNow();
    for (const p of this.recent.slice(0, 12)) this.lib.ensure(p).catch(() => {});
    this.lib.scan().catch((err) => console.error('[media] scan failed', err));
    if (wantFiles.length) await this.handleArgs(args);
  }

  _argPaths(args) {
    const list = [];
    if (typeof args?.file === 'string') list.push(args.file);
    if (Array.isArray(args?.files)) list.push(...args.files.filter((f) => typeof f === 'string'));
    return list;
  }

  async handleArgs(args = {}) {
    const paths = this._argPaths(args);
    if (typeof args.folder === 'string') paths.push(...(await this._expand([args.folder])));
    if (!paths.length) return;
    const playable = paths.filter(isMedia);
    if (!playable.length) {
      this.toast({ kind: 'error', title: this.t('errors.playTitle'), body: this.t('errors.notSupported', { name: baseName(paths[0]) }) });
      return;
    }
    await this.playEntries(playable, 0, { openStage: playable.length === 1 && kindOf(playable[0]) === 'video' && this.prefs.videoStage !== false });
  }

  // ================================================================== layout
  _build() {
    const { h, t, icon } = this;
    this.searchInput = h('input', { class: 'input mp-search-input', type: 'search', placeholder: t('search.placeholder'), 'aria-label': t('search.placeholder') });
    this.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const q = this.searchInput.value.trim();
        if (q) this.go({ name: 'search', arg: q });
        this._closeNavOverlay();
      } else if (e.key === 'Escape' && this.searchInput.value) {
        e.stopPropagation();
        this.searchInput.value = '';
      }
    });
    this.backBtn = h('button', { class: 'btn subtle icon-btn mp-back', 'aria-label': t('nav.back'), 'data-tip': t('nav.back'), disabled: true, onclick: () => this.back() }, icon('arrow_left'));
    this.menuBtn = h('button', { class: 'btn subtle icon-btn mp-hamburger', 'aria-label': t('nav.toggle'), 'data-tip': t('nav.toggle'), onclick: (e) => this.toggleNav(e) }, icon('line_horizontal_3'));
    this.searchBtn = h('button', { class: 'btn subtle icon-btn mp-search-btn', 'aria-label': t('search.placeholder'), 'data-tip': t('search.placeholder'), onclick: () => this.focusSearch() }, icon('search'));
    this.navItems = {};
    const item = (id, ic, label, route, extra) => {
      const el = h('div', { class: 'nav-item mp-nav-item', tabindex: '0', role: 'link', dataset: { nav: id }, 'aria-label': label }, icon(ic), h('span', { class: 'mp-nav-label ellipsis' }, label), extra || null);
      el.addEventListener('click', () => {
        this.go(route);
        this._closeNavOverlay();
      });
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          el.click();
        }
      });
      this.navItems[id] = el;
      return el;
    };
    this.plChevron = h(
      'button',
      {
        class: 'mp-nav-chevron',
        tabindex: '-1',
        'aria-label': t('nav.expandPlaylists'),
        onclick: (e) => {
          e.stopPropagation();
          this.setPref('playlistsOpen', !this.prefs.playlistsOpen);
          this._renderNavPlaylists();
        },
      },
      icon('chevron_down', { size: 12 }),
    );
    this.navPlaylists = h('div', { class: 'mp-nav-children', role: 'group' });
    this.navEl = h(
      'nav',
      { class: 'mp-nav', 'aria-label': t('nav.label') },
      h('div', { class: 'mp-nav-top' }, this.backBtn, this.menuBtn),
      h('div', { class: 'search-box mp-search' }, this.searchInput, icon('search')),
      this.searchBtn,
      h(
        'div',
        { class: 'mp-nav-scroll' },
        item('home', 'home', t('nav.home'), { name: 'home' }),
        item('music', 'music_note_2', t('nav.music'), { name: 'music' }),
        item('videos', 'video', t('nav.videos'), { name: 'videos' }),
        h('div', { class: 'mp-nav-sep' }),
        item('queue', 'text_bullet_list', t('nav.queue'), { name: 'queue' }),
        item('playlists', 'album', t('nav.playlists'), { name: 'playlists' }, this.plChevron),
        this.navPlaylists,
      ),
      h('div', { class: 'mp-nav-foot' }, item('settings', 'settings', t('nav.settings'), { name: 'settings' })),
    );
    this._navDrop(this.navItems.queue, (paths) => this.addToQueue(paths));
    this.scroller = h('div', { class: 'mp-scroll', tabindex: '-1' });
    this.floatBack = h('button', { class: 'btn subtle icon-btn mp-back', 'aria-label': t('nav.back'), 'data-tip': t('nav.back'), disabled: true, onclick: () => this.back() }, icon('arrow_left'));
    this.floatBar = h(
      'div',
      { class: 'mp-float' },
      this.floatBack,
      h('button', { class: 'btn subtle icon-btn mp-float-menu', 'aria-label': t('nav.toggle'), 'data-tip': t('nav.toggle'), onclick: (e) => this.toggleNav(e) }, icon('line_horizontal_3')),
    );
    this.content = h('main', { class: 'mp-content' }, this.floatBar, this.scroller);
    this.scrim = h('div', { class: 'mp-nav-scrim', onclick: () => this._closeNavOverlay() });
    this.mainEl = h('div', { class: 'mp-main' }, this.navEl, this.scrim, this.content);
    this.stage = new Stage(this);
    this.transport = new Transport(this);
    this.toasts = h('div', { class: 'mp-toasts', role: 'status', 'aria-live': 'polite' });
    this.dropEl = h('div', { class: 'mp-drop', hidden: true }, h('div', { class: 'mp-drop-card' }, icon('arrow_download', { size: 32 }), h('div', { class: 'mp-drop-text subtitle' })));
    this.osd = h('div', { class: 'mp-osd', hidden: true });
    this.root = h('div', { class: 'mp' }, this.mainEl, this.stage.el, this.transport.el, this.toasts, this.osd, this.dropEl);
    this.win.body.appendChild(this.root);
    this._renderNavPlaylists();
    this._ro = new ResizeObserver(() => this._layout());
    this._ro.observe(this.root);
    this._layout();
    // Auto-hide video controls after 3 s without pointer movement.
    this.root.addEventListener('pointermove', () => this._poke());
    this.root.addEventListener('pointerdown', () => this._poke());
    this.root.addEventListener('pointerleave', () => this._poke(true));
  }

  _layout() {
    const w = this.root.clientWidth;
    if (!w) return;
    const mode = w < 640 ? 'minimal' : w < 1008 || this.prefs.navCollapsed ? 'compact' : 'expanded';
    if (mode !== this.navMode) {
      this.navMode = mode;
      this._closeNavOverlay();
    }
    this.root.classList.toggle('nav-expanded', mode === 'expanded');
    this.root.classList.toggle('nav-compact', mode === 'compact');
    this.root.classList.toggle('nav-minimal', mode === 'minimal');
    this.root.classList.toggle('w-narrow', w < 760);
    this.root.classList.toggle('w-tiny', w < 560);
    const compact = mode !== 'expanded' && !this.navOverlay;
    for (const el of Object.values(this.navItems)) {
      if (compact) el.dataset.tip = el.getAttribute('aria-label');
      else delete el.dataset.tip;
    }
  }

  toggleNav(e) {
    if (this.navMode === 'expanded') {
      this.setPref('navCollapsed', true);
      this._layout();
      return;
    }
    if (this.navMode === 'compact' && this.prefs.navCollapsed && this.root.clientWidth >= 1008 && !this.navOverlay) {
      this.setPref('navCollapsed', false);
      this._layout();
      return;
    }
    this.navOverlay = !this.navOverlay;
    this.root.classList.toggle('nav-open', this.navOverlay);
    this._layout();
    // Keyboard users land in the pane; pointer users keep their focus where it was.
    if (this.navOverlay && e?.detail === 0) setTimeout(() => this.navItems[this._navKey()]?.focus(), 50);
  }
  _closeNavOverlay() {
    if (!this.navOverlay) return;
    this.navOverlay = false;
    this.root.classList.remove('nav-open');
    this._layout();
  }
  focusSearch() {
    if (this.navMode !== 'expanded' && !this.navOverlay) this.toggleNav();
    setTimeout(() => {
      this.searchInput.focus();
      this.searchInput.select();
    }, 60);
  }

  _renderNavPlaylists() {
    const { h, t, icon } = this;
    const open = this.prefs.playlistsOpen !== false;
    this.plChevron.classList.toggle('open', open);
    this.plChevron.setAttribute('aria-expanded', String(open));
    this.navItems.playlists.setAttribute('aria-expanded', String(open));
    this.navPlaylists.hidden = !open;
    const kids = this.playlists.list().map((pl) => {
      const el = h('div', { class: 'nav-item mp-nav-item mp-nav-child', tabindex: '0', role: 'link', dataset: { nav: `pl:${pl.id}` }, 'aria-label': pl.name, 'data-tip': pl.name }, icon('text_bullet_list'), h('span', { class: 'mp-nav-label ellipsis' }, pl.name));
      el.addEventListener('click', () => {
        this.go({ name: 'playlist', arg: pl.id });
        this._closeNavOverlay();
      });
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          el.click();
        }
      });
      el.addEventListener('contextmenu', (e) =>
        this.ui.menu(e, [
          { label: t('menu.play'), icon: 'play', disabled: !pl.items.length, action: () => this.playEntries(pl.items, 0) },
          { label: t('playlists.rename'), icon: 'rename', action: () => this.renamePlaylist(pl.id) },
          { label: t('playlists.delete'), icon: 'delete', danger: true, action: () => this.deletePlaylist(pl.id) },
        ]),
      );
      this._navDrop(el, (paths) => this.addToPlaylist(pl.id, paths));
      return el;
    });
    const add = h('div', { class: 'nav-item mp-nav-item mp-nav-child mp-nav-new', tabindex: '0', role: 'button', 'aria-label': t('playlists.new'), 'data-tip': t('playlists.new') }, icon('add'), h('span', { class: 'mp-nav-label ellipsis' }, t('playlists.new')));
    add.addEventListener('click', () => this.newPlaylist());
    add.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        this.newPlaylist();
      }
    });
    this.navPlaylists.replaceChildren(...kids, add);
    this._updateNavSelection();
  }

  _navKey() {
    const r = this.route.name;
    if (r === 'album' || r === 'artist') return 'music';
    if (r === 'playlist') return `pl:${this.route.arg}`;
    return r;
  }
  _updateNavSelection() {
    const key = this._navKey();
    for (const el of this.navEl.querySelectorAll('.mp-nav-item')) {
      const on = el.dataset.nav === key;
      el.classList.toggle('selected', on);
      if (on) el.setAttribute('aria-current', 'page');
      else el.removeAttribute('aria-current');
    }
  }

  _navDrop(el, onPaths) {
    let depth = 0;
    el.addEventListener('dragenter', (e) => {
      if (!this._dragHasMedia(e)) return;
      depth++;
      el.classList.add('mp-drop-target');
    });
    el.addEventListener('dragleave', () => {
      if (--depth <= 0) {
        depth = 0;
        el.classList.remove('mp-drop-target');
      }
    });
    el.addEventListener('dragover', (e) => {
      if (!this._dragHasMedia(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
    });
    el.addEventListener('drop', async (e) => {
      depth = 0;
      el.classList.remove('mp-drop-target');
      if (!this._dragHasMedia(e)) return;
      e.preventDefault();
      e.stopPropagation();
      this._hideDrop();
      const paths = await this._dropPaths(e);
      if (paths.length) onPaths(paths);
      else this.toast({ kind: 'warning', title: this.t('errors.noMediaTitle'), body: this.t('errors.noMedia') });
    });
  }

  // ================================================================== routing
  go(route, { replace = false } = {}) {
    const same = route.name === this.route.name && route.arg === this.route.arg;
    if (this.stageOpen && !this.mini) this.closeStage();
    if (same) {
      this.scroller.scrollTo({ top: 0, behavior: reduceMotion() ? 'auto' : 'smooth' });
      return;
    }
    if (!replace) this.history.push({ ...this.route, scroll: this.scroller.scrollTop });
    if (this.history.length > 50) this.history.shift();
    this.route = { name: route.name, arg: route.arg };
    this.render({ anim: replace ? 'fade' : 'enter' });
  }
  back() {
    if (this.stageOpen) return this.closeStage();
    const prev = this.history.pop();
    if (!prev) return;
    this.route = { name: prev.name, arg: prev.arg };
    this.render({ scroll: prev.scroll, anim: 'fade' });
  }

  render({ keepScroll = false, scroll, anim } = {}) {
    this.lists = [];
    const map = { home: V.homeView, music: V.musicView, album: V.albumView, artist: V.artistView, videos: V.videosView, queue: V.queueView, playlists: V.playlistsView, playlist: V.playlistView, search: V.searchView, settings: V.settingsView };
    const fn = map[this.route.name] || V.homeView;
    let res;
    try {
      res = fn(this, this.route.arg);
    } catch (err) {
      console.error('[media] view failed', err);
      res = { el: this.h('div', { class: 'mp-page' }, this.h('div', { class: 'empty' }, this.icon('error_circle', { size: 48 }), String(err?.message || err))) };
    }
    const top = keepScroll ? this.scroller.scrollTop : scroll || 0;
    const hadFocus = this.scroller.contains(document.activeElement);
    this.scroller.replaceChildren(res.el);
    this.view = res;
    this.scroller.scrollTop = top;
    if (anim && !reduceMotion()) {
      const frames = anim === 'enter' ? [{ opacity: 0, transform: 'translateY(28px)' }, { opacity: 1, transform: 'none' }] : [{ opacity: 0 }, { opacity: 1 }];
      res.el.animate(frames, { duration: anim === 'enter' ? 300 : 160, easing: EASE });
    }
    this._syncBack();
    this._updateNavSelection();
    if (hadFocus && !keepScroll) this.scroller.focus?.();
  }
  _rerenderSoon = debounce(() => this.render({ keepScroll: true }), 300);

  _syncBack() {
    const off = !this.history.length && !this.stageOpen;
    this.backBtn.disabled = off;
    this.floatBack.disabled = off;
  }

  trackList(list) {
    this.lists.push(list);
  }

  // ================================================================== display helpers
  titleOf(e) {
    return e?.title || e?.guessTitle || (e?.path ? stem(e.path) : '');
  }
  artistOf(e) {
    if (!e) return '';
    if (e.kind === 'video') return e.artist || '';
    return e.artist || e.guessArtist || this.t('library.unknownArtist');
  }
  albumOf(e) {
    return e?.album || this.t('library.unknownAlbum');
  }
  artistKeyOf(e) {
    return (e?.artist || e?.guessArtist || '').toLowerCase();
  }
  albumKeyOf(e) {
    return `${(e?.albumArtist || e?.artist || '').toLowerCase()}\u0000${(e?.album || '').toLowerCase()}`;
  }
  albums() {
    return this.lib.albums(this.t('library.unknownAlbum'), this.t('library.unknownArtist'));
  }
  artists() {
    return this.lib.artists(this.t('library.unknownArtist'));
  }
  fmtTotal(sec) {
    if (!sec) return '';
    const h = Math.floor(sec / 3600);
    const m = Math.round((sec % 3600) / 60);
    if (h) return this.t('time.hm', { h, m });
    if (m) return this.t('time.m', { m });
    return this.t('time.s', { s: Math.round(sec) });
  }
  currentPath() {
    return this.player.path || null;
  }
  currentEntry() {
    const it = this.queue.current;
    if (!it) return null;
    return this.lib.get(it.path) || { path: it.path, name: baseName(it.path), kind: kindOf(it.path), guessTitle: stem(it.path) };
  }
  isVideo() {
    const e = this.currentEntry();
    if (!e) return false;
    if (this.player.path === e.path && this.player.el.readyState >= 1) return this.player.hasVideo;
    return e.kind === 'video';
  }

  // ================================================================== prefs / state
  setPref(k, v) {
    this.prefs[k] = v;
    this.storage.set('prefs', this.prefs).catch(() => {});
    if (k === 'visualizer') this.stage.syncViz();
  }
  _saveState = debounce(() => {
    this.storage
      .set('state', { queue: this.queue.toJSON(), pos: this.player.currentTime || 0, volume: this.player.volume, muted: this.player.muted, rate: this.player.rate })
      .catch(() => {});
  }, 700);
  _saveRecent = debounce(() => this.storage.set('recent', this.recent).catch(() => {}), 800);
  addRecent(path) {
    this.recent = [path, ...this.recent.filter((p) => p !== path)].slice(0, 30);
    this._saveRecent();
  }

  // ================================================================== events
  _bindPlayer() {
    const p = this.player;
    p.on('state', () => {
      this.updateNow();
      this._saveState();
      if (!p.paused) this._errStreak = 0;
      this._poke();
    });
    p.on('load', () => this.updateNow());
    p.on('meta', () => {
      this.updateNow();
      const e = this.currentEntry();
      // Learn durations of files opened outside the library.
      if (e && this.lib.get(e.path) && !e.duration && p.duration) this.lib._store(this.lib.get(e.path), { duration: p.duration });
    });
    let lastSave = 0;
    p.on('time', () => {
      this.transport.updateTime();
      this.stage.updateTime();
      if (Date.now() - lastSave > 5000) {
        lastSave = Date.now();
        this._saveState();
      }
    });
    p.on('ended', () => this._onEnded());
    p.on('error', (err) => this._onError(err));
    p.on('volume', () => {
      this.transport.updateVolume();
      this._saveState();
    });
    p.on('rate', () => this._saveState());
    p.on('buffering', (on) => this.stage.setBuffering(on));
  }

  _bindWindow() {
    const w = this.win;
    const offFs = w.on('fullscreen', (on) => {
      this.root.classList.toggle('fs', on);
      if (on) {
        this._stageBeforeFs = this.stageOpen;
        this.openStage();
      } else if (!this._stageBeforeFs && !this.isVideo()) this.closeStage();
      this.updateNow();
      this._poke();
    });
    this._disposers.push(offFs);
    w.onBeforeClose(async () => {
      this._saveState.flush();
      return true;
    });
    this.ctx.onClose(() => this.destroy());
    const onAnim = () => this.stage.syncViz();
    this._disposers.push(this.ctx.settings.on('animations', onAnim));
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this._saveState.flush();
    this._saveRecent.flush();
    // Nothing may overwrite the saved position once the window is gone.
    const noop = Object.assign(() => {}, { flush() {}, cancel() {} });
    this._saveState = noop;
    this._saveRecent = noop;
    this._rerenderSoon.cancel();
    clearTimeout(this._skipT);
    clearTimeout(this._osdT);
    this._ro?.disconnect();
    this.stage.viz.stop();
    this.transport.closeVolume();
    clearTimeout(this._idleT);
    for (const off of this._disposers) {
      try {
        off?.();
      } catch {}
    }
    this.player.destroy();
  }

  _onLibrary(ev) {
    if (ev.type === 'meta') {
      if (this.view?.onMeta) this.view.onMeta(ev.paths);
      else if (this.view?.rerenderOnMeta) this._rerenderSoon();
      const cur = this.currentPath();
      if (cur && ev.paths.includes(cur)) this.updateNow();
    } else if (ev.type === 'scan' || ev.type === 'scanning') {
      if (['home', 'music', 'videos', 'album', 'artist', 'search'].includes(this.route.name)) this.render({ keepScroll: true });
    }
  }
  _onPlaylists() {
    this._renderNavPlaylists();
    if (['playlists', 'playlist', 'home'].includes(this.route.name)) this.render({ keepScroll: true });
  }
  _onQueue() {
    this._saveState();
    if (this.view?.queueBound) this._rerenderSoon();
    this.updateNow();
  }

  /** Refresh everything that shows the current item / playback state. */
  updateNow() {
    this.transport.update();
    this.stage.update();
    this.root.classList.toggle('is-video', this.isVideo());
    this.root.classList.toggle('playing', !this.player.paused);
    for (const l of this.lists) l.markPlaying();
    this.win.el.classList.toggle('mp-has-media', !!this.queue.current);
  }

  // ================================================================== playback
  _paths(list) {
    return (list || []).map((x) => (typeof x === 'string' ? x : x?.path)).filter(Boolean);
  }

  async playEntries(list, start = 0, { shuffle, openStage } = {}) {
    const paths = this._paths(list);
    if (!paths.length) return;
    if (shuffle !== undefined) this.queue.shuffle = !!shuffle;
    if (shuffle) start = Math.floor(Math.random() * paths.length);
    this.queue.set(paths, start);
    await this.loadCurrent({ autoplay: true });
    if (openStage || (this.isVideo() && this.prefs.videoStage !== false && !this.stageOpen && kindOf(this.queue.current?.path) === 'video')) this.openStage();
  }
  async playQueueIndex(i) {
    if (this.queue.jump(i) < 0) return;
    await this.loadCurrent({ autoplay: true });
  }
  async loadCurrent({ autoplay = true, at = 0 } = {}) {
    const it = this.queue.current;
    if (!it) {
      this.player.stop();
      this.updateNow();
      return;
    }
    await this.lib.ensure(it.path);
    this.player.load(it.path, { autoplay, at });
    if (autoplay) this.addRecent(it.path);
    this.updateNow();
  }
  async addToQueue(list, { quiet = false } = {}) {
    const paths = this._paths(list);
    if (!paths.length) return;
    const idle = !this.queue.current;
    const added = this.queue.add(paths);
    if (idle) {
      this.queue.jump(this.queue.indexOfUid(added[0].uid));
      await this.loadCurrent({ autoplay: true });
    }
    if (!quiet) this.toast({ kind: 'success', title: this.t('toast.addedQueue', { count: paths.length }) });
  }
  async playNext(list) {
    const paths = this._paths(list);
    if (!paths.length) return;
    const idle = !this.queue.current;
    const added = this.queue.playNext(paths);
    if (idle) {
      this.queue.jump(this.queue.indexOfUid(added[0].uid));
      await this.loadCurrent({ autoplay: true });
    } else this.toast({ kind: 'success', title: this.t('toast.playNext', { count: paths.length }) });
  }
  async togglePlay() {
    if (!this.player.loaded) {
      if (this.queue.current) return this.loadCurrent({ autoplay: true });
      const songs = this.lib.songs();
      if (songs.length) return this.playEntries(songs, 0);
      return this.openFiles();
    }
    await this.player.toggle();
  }
  async next() {
    const i = this.queue.next();
    if (i < 0) return;
    await this.loadCurrent({ autoplay: true });
  }
  async prev() {
    if (this.player.loaded && this.player.currentTime > 3) {
      this.player.seek(0);
      return;
    }
    const i = this.queue.prev();
    if (i < 0) return;
    await this.loadCurrent({ autoplay: true });
  }
  async _onEnded() {
    const before = this.queue.index;
    const i = this.queue.next({ auto: true });
    if (i < 0) {
      // End of the queue: rewind, stay paused (like Windows).
      this.player.seek(0);
      this.updateNow();
      if (this.win.fullscreen && this.isVideo()) this._poke();
      return;
    }
    if (i === before && this.queue.repeat === 'one') {
      this.player.seek(0);
      this.player.play();
      return;
    }
    await this.loadCurrent({ autoplay: true });
  }
  async _onError({ code, path }) {
    const name = baseName(path);
    const exists = await this.api.invoke('fs:exists', path).catch(() => true);
    const key = !exists ? 'errors.notFound' : code === 4 ? 'errors.notSupported' : code === 3 ? 'errors.decode' : 'errors.read';
    const e = this.lib.get(path);
    if (e) {
      e.bad = true;
      for (const l of this.lists) l.update([path]);
    }
    this._errStreak++;
    const canSkip = this.queue.length > 1 && this._errStreak < this.queue.length && this.queue.peekNext() >= 0;
    this.toast({ kind: 'error', id: 'play-error', title: this.t('errors.playTitle'), body: `${this.t(key, { name })}${canSkip ? ` ${this.t('errors.skipping')}` : ''}`, timeout: 9000 });
    this.updateNow();
    if (canSkip) {
      clearTimeout(this._skipT);
      this._skipT = setTimeout(() => {
        if (this.player.path === path) this.next();
      }, 1600);
    }
  }
  removeFromQueue(indexes) {
    const sorted = [...indexes].sort((a, b) => b - a);
    const wasPlaying = !this.player.paused;
    let currentRemoved = false;
    for (const i of sorted) currentRemoved = this.queue.removeAt(i).wasCurrent || currentRemoved;
    if (currentRemoved) {
      if (this.queue.current) this.loadCurrent({ autoplay: wasPlaying });
      else this.player.stop();
    }
  }
  moveInQueue(from, to) {
    this.queue.move(from, to);
  }
  async clearQueue() {
    if (!this.queue.length) return;
    this.queue.clear();
    this.player.stop();
    if (this.stageOpen) this.closeStage();
    if (this.mini) this.toggleMini(false);
    this.updateNow();
  }
  toggleShuffle() {
    this.queue.setShuffle(!this.queue.shuffle);
    this.osdShow('arrow_shuffle', this.queue.shuffle ? this.t('transport.shuffleOn') : this.t('transport.shuffleOff'));
  }
  cycleRepeat() {
    const m = this.queue.cycleRepeat();
    this.osdShow(m === 'one' ? 'arrow_repeat_1' : 'arrow_repeat_all', this.t(`transport.repeat_${m}`));
  }
  setVolume(v) {
    this.player.setVolume(clamp(v, 0, 1));
  }
  setMuted(m) {
    this.player.setMuted(m);
  }
  setRate(r) {
    this.player.setRate(r);
    this.osdShow('top_speed', r === 1 ? this.t('speed.normal') : `${this.i18n.formatNumber(r)}×`);
  }

  // ================================================================== stage / full screen / mini
  openStage() {
    if (!this.queue.current) return;
    if (!this.stageOpen) {
      this.stageOpen = true;
      this._stageFocus = document.activeElement;
      this.root.classList.add('stage-open');
      this.stage.el.setAttribute('aria-hidden', 'false');
      if (!reduceMotion()) this.stage.el.animate([{ opacity: 0, transform: 'scale(1.02)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: EASE });
    }
    this._syncBack();
    this.stage.update();
    this._poke();
  }
  closeStage() {
    if (!this.stageOpen) return;
    if (this.win.fullscreen) this.win.setFullscreen(false);
    if (this.mini) return;
    this.stageOpen = false;
    this.root.classList.remove('stage-open', 'idle');
    this.stage.el.setAttribute('aria-hidden', 'true');
    this._syncBack();
    this.stage.syncViz();
    if (this._stageFocus?.isConnected) this._stageFocus.focus({ preventScroll: true });
  }
  toggleStage() {
    if (this.stageOpen) this.closeStage();
    else this.openStage();
  }
  toggleFullscreen(on) {
    const want = on === undefined ? !this.win.fullscreen : !!on;
    if (want && !this.queue.current) return;
    if (want && this.mini) this.toggleMini(false);
    this.win.setFullscreen(want);
  }
  toggleMini(on) {
    const want = on === undefined ? !this.mini : !!on;
    if (want === this.mini) return;
    const w = this.win;
    if (want) {
      if (!this.queue.current) return;
      if (w.fullscreen) w.setFullscreen(false);
      this._miniRestore = { rect: w.rect(), state: w.state, minW: w.opts.minWidth, minH: w.opts.minHeight, stage: this.stageOpen, top: w.alwaysOnTop };
      if (w.state !== 'normal') w.restore();
      w.opts.minWidth = 260;
      w.opts.minHeight = 220;
      this.mini = true;
      this.root.classList.add('mini');
      this.openStage();
      const r = w.rect();
      const wa = this.shell?.wm?.workarea?.() || { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
      const size = { width: 340, height: 340 + 32 };
      w.setRect({ x: Math.min(r.x + r.width - size.width, wa.x + wa.width - size.width - 16), y: Math.max(wa.y, Math.min(r.y, wa.y + wa.height - size.height - 16)), ...size }, true);
      w.alwaysOnTop = true;
      w.focus();
    } else {
      const s = this._miniRestore || {};
      this.mini = false;
      this.root.classList.remove('mini');
      w.alwaysOnTop = !!s.top;
      w.opts.minWidth = s.minW || 500;
      w.opts.minHeight = s.minH || 460;
      if (s.rect) w.setRect(s.rect, true);
      if (s.state === 'maximized') w.maximize();
      if (!s.stage) this.closeStage();
      w.focus();
    }
    this.updateNow();
    this.stage.syncViz();
  }

  /** Show the stage controls and restart the 3 s idle timer (video only). */
  _poke(leave = false) {
    clearTimeout(this._idleT);
    this.root.classList.remove('idle');
    if (!this.stageOpen || !this.isVideo() || this.player.paused) return;
    if (this.transport.fly || document.querySelector('.menu')) return;
    this._idleT = setTimeout(
      () => {
        if (this.stageOpen && this.isVideo() && !this.player.paused && !this.transport.fly && !document.querySelector('.menu') && !this.transport.el.contains(document.activeElement)) this.root.classList.add('idle');
      },
      leave ? 600 : 3000,
    );
  }

  osdShow(ic, text) {
    const { h, icon } = this;
    this.osd.replaceChildren(icon(ic, { filled: true }), h('span', null, text));
    this.osd.hidden = false;
    this.osd.classList.remove('out');
    if (!reduceMotion()) this.osd.animate([{ opacity: 0, transform: 'translate(-50%, 8px) scale(.96)' }, { opacity: 1, transform: 'translate(-50%, 0)' }], { duration: 160, easing: EASE });
    clearTimeout(this._osdT);
    this._osdT = setTimeout(() => (this.osd.hidden = true), 1100);
  }

  focusContent() {
    const target = this.scroller.querySelector('.mp-row.selected[tabindex="0"]') || this.scroller;
    target.focus?.({ preventScroll: true });
  }

  // ================================================================== keyboard
  _bindKeys() {
    this.win.el.addEventListener('keydown', (e) => this._key(e));
  }
  _key(e) {
    if (e.defaultPrevented) return;
    if (e.target.closest?.('.dialog-layer, .menu')) return;
    if (document.querySelector('.menu')) return;
    const k = e.key;
    const lower = k.length === 1 ? k.toLowerCase() : k;
    const ctrl = e.ctrlKey || e.metaKey;
    const typing = !!e.target.closest?.('input:not([type="range"]):not([type="checkbox"]), textarea, select, [contenteditable="true"]');
    const done = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    this._poke();
    if (ctrl && !e.altKey) {
      if (lower === 'o') {
        done();
        return e.shiftKey ? this.openFolder() : this.openFiles();
      }
      if (typing) return;
      if (lower === 'p') return done(), this.togglePlay();
      if (lower === 'f') return done(), this.next();
      if (lower === 'b') return done(), this.prev();
      if (lower === 'h') return done(), this.toggleShuffle();
      if (lower === 't') return done(), this.cycleRepeat();
      if (lower === 'e') return done(), this.focusSearch();
      if (lower === 'm' && e.shiftKey) return done(), this.toggleMini();
      return;
    }
    if (k === 'Escape') {
      if (this.transport.fly) return done(), this.transport.closeVolume();
      if (this.win.fullscreen) return done(), this.toggleFullscreen(false);
      if (typing) return;
      if (this.navOverlay) return done(), this._closeNavOverlay();
      if (this.stageOpen && !this.mini) return done(), this.closeStage();
      return;
    }
    if (k === 'F11') return done(), this.toggleFullscreen();
    if (typing || e.altKey) return;
    const onControl = e.target.closest?.('button, [role="tab"], a, input[type="range"], input[type="checkbox"]');
    if (k === ' ' || lower === 'k') {
      if (k === ' ' && onControl && !this.transport.el.contains(e.target)) return; // let buttons activate
      if (k === ' ' && onControl && this.transport.el.contains(e.target) && e.target.tagName === 'BUTTON') return;
      return done(), this.togglePlay();
    }
    if (e.target.closest?.('input[type="range"]')) return;
    if (k === 'ArrowLeft' || k === 'ArrowRight' || lower === 'j' || lower === 'l') {
      if (!this.player.loaded) return;
      done();
      const d = k === 'ArrowLeft' ? -5 : k === 'ArrowRight' ? 5 : lower === 'j' ? -10 : 10;
      this.player.seekBy(d);
      this.osdShow(d < 0 ? 'rewind' : 'fast_forward', `${formatTime(this.player.currentTime)} / ${formatTime(this.player.duration)}`);
      return;
    }
    if (k === 'ArrowUp' || k === 'ArrowDown') {
      done();
      this.setVolume(this.player.volume + (k === 'ArrowUp' ? 0.05 : -0.05));
      this.osdShow(this.player.volume === 0 ? 'speaker_mute' : 'speaker_2', this.t('transport.volumeValue', { v: Math.round(this.player.volume * 100) }));
      return;
    }
    if (lower === 'm') {
      done();
      this.setMuted(!this.player.muted);
      this.osdShow(this.player.muted ? 'speaker_mute' : 'speaker_2', this.player.muted ? this.t('transport.volumeMuted') : this.t('transport.volumeValue', { v: Math.round(this.player.volume * 100) }));
      return;
    }
    if (lower === 'f') return done(), this.toggleFullscreen();
    if (lower === 'n') return done(), this.next();
    if (lower === 'p') return done(), this.prev();
    if (k === '>' || k === '<') {
      done();
      const i = RATES.indexOf(this.player.rate);
      const next = RATES[clamp((i < 0 ? 2 : i) + (k === '>' ? 1 : -1), 0, RATES.length - 1)];
      return this.setRate(next);
    }
  }

  // ================================================================== drag & drop
  _dragHasMedia(e) {
    const types = [...(e.dataTransfer?.types || [])];
    return types.includes('Files') || types.includes(FILES_MIME) || types.includes(ROW_MIME) || types.includes('text/uri-list');
  }
  async _dropPaths(e) {
    const dt = e.dataTransfer;
    let paths = [];
    try {
      const own = dt.getData(ROW_MIME);
      if (own) paths = JSON.parse(own).paths || [];
    } catch {}
    if (!paths.length) {
      try {
        const files = dt.getData(FILES_MIME);
        if (files) paths = JSON.parse(files);
      } catch {}
    }
    if (!paths.length && dt.files?.length) paths = [...dt.files].map((f) => this.api.pathForFile(f)).filter(Boolean);
    if (!paths.length) {
      const uris = dt.getData('text/uri-list');
      if (uris)
        paths = uris
          .split(/\r?\n/)
          .filter((u) => u.startsWith('file://'))
          .map((u) => {
            try {
              return decodeURIComponent(new URL(u).pathname);
            } catch {
              return null;
            }
          })
          .filter(Boolean);
    }
    return this._expand(paths.filter((p) => typeof p === 'string'));
  }
  /** Files stay as-is, folders are walked; only playable media is kept. */
  async _expand(paths) {
    const out = [];
    for (const p of paths) {
      if (isMedia(p)) {
        out.push(p);
        continue;
      }
      const st = await this.api.invoke('fs:stat', p).catch(() => null);
      if (st?.dir) {
        const files = await this.lib.walk(p, MEDIA_EXT, { depth: 6, dirs: 500, files: 5000 });
        files.sort((a, b) => a.path.localeCompare(b.path, this.locale, { numeric: true }));
        out.push(...files.map((f) => f.path));
      }
    }
    return out;
  }
  _bindDnD() {
    const el = this.win.el;
    let depth = 0;
    el.addEventListener('dragenter', (e) => {
      if (!this._dragHasMedia(e) || e.dataTransfer.types.includes(ROW_MIME)) return;
      depth++;
      this._showDrop();
    });
    el.addEventListener('dragleave', () => {
      if (--depth <= 0) {
        depth = 0;
        this._hideDrop();
      }
    });
    el.addEventListener('dragover', (e) => {
      if (!this._dragHasMedia(e) || e.dataTransfer.types.includes(ROW_MIME)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    el.addEventListener('drop', async (e) => {
      depth = 0;
      this._hideDrop();
      if (!this._dragHasMedia(e) || e.dataTransfer.types.includes(ROW_MIME)) return;
      e.preventDefault();
      await this.dropFiles(await this._dropPaths(e));
    });
  }
  /** Dropped files: play when idle, otherwise add to the play queue. */
  async dropFiles(paths) {
    if (!paths.length) {
      this.toast({ kind: 'warning', title: this.t('errors.noMediaTitle'), body: this.t('errors.noMedia') });
      return;
    }
    if (!this.queue.current || !this.player.loaded) await this.playEntries(paths, 0, { openStage: paths.length === 1 && kindOf(paths[0]) === 'video' && this.prefs.videoStage !== false });
    else await this.addToQueue(paths);
  }
  _showDrop() {
    const idle = !this.queue.current || !this.player.loaded;
    this.dropEl.querySelector('.mp-drop-text').textContent = idle ? this.t('drop.play') : this.t('drop.queue');
    this.dropEl.hidden = false;
  }
  _hideDrop() {
    this.dropEl.hidden = true;
  }
  endDrag() {
    this._hideDrop();
  }

  // ================================================================== files & folders
  _filters() {
    const { t } = this;
    return [
      { name: t('filters.media'), ext: MEDIA_EXT },
      { name: t('filters.audio'), ext: AUDIO_EXT },
      { name: t('filters.video'), ext: VIDEO_EXT },
    ];
  }
  async openFiles({ append = false } = {}) {
    const res = await this.ui.filePicker({ mode: 'open', multiple: true, title: this.t('home.openFiles'), filters: this._filters(), path: this.lastDir || this.xdg.music, parent: this.win });
    const paths = [].concat(res || []).filter(Boolean);
    if (!paths.length) return;
    this.lastDir = dirName(paths[0]);
    const playable = paths.filter(isMedia);
    if (!playable.length) {
      this.toast({ kind: 'error', title: this.t('errors.playTitle'), body: this.t('errors.notSupported', { name: baseName(paths[0]) }) });
      return;
    }
    if (append) await this.addToQueue(playable);
    else await this.playEntries(playable, 0, { openStage: playable.length === 1 && kindOf(playable[0]) === 'video' && this.prefs.videoStage !== false });
  }
  async openFolder() {
    const dir = await this.ui.filePicker({ mode: 'folder', title: this.t('home.openFolder'), path: this.lastDir || this.xdg.music, parent: this.win });
    if (!dir) return;
    this.lastDir = dir;
    const paths = await this._expand([dir]);
    if (!paths.length) {
      this.toast({ kind: 'warning', title: this.t('errors.noMediaTitle'), body: this.t('errors.folderEmpty', { name: baseName(dir) || dir }) });
      return;
    }
    await this.playEntries(paths, 0);
  }
  async addLibraryFolder(kind) {
    const dir = await this.ui.filePicker({ mode: 'folder', title: this.t('library.addFolder'), path: kind === 'video' ? this.xdg.videos : this.xdg.music, parent: this.win });
    if (!dir) return;
    if (!(await this.lib.addFolder(kind, dir))) {
      this.toast({ kind: 'info', title: this.t('library.folderExists') });
      return;
    }
    if (this.route.name === 'settings') this.render({ keepScroll: true });
    await this.refreshLibrary();
  }
  async removeLibraryFolder(kind, dir) {
    const ok = await this.ui.confirm(this.t('settings.removeFolderConfirm', { name: dir }), { title: this.t('settings.removeFolderTitle'), okLabel: this.t('settings.remove'), parent: this.win });
    if (!ok) return;
    await this.lib.removeFolder(kind, dir);
    this.render({ keepScroll: true });
    await this.refreshLibrary();
  }
  async refreshLibrary() {
    try {
      await this.lib.scan();
    } catch (err) {
      this.ui.alert(String(err?.message || err), { title: this.t('library.scanFailed'), parent: this.win });
    }
  }
  async clearCache() {
    const ok = await this.ui.confirm(this.t('settings.cacheConfirm'), { title: this.t('settings.cache'), okLabel: this.t('settings.clear'), parent: this.win });
    if (!ok) return;
    await this.lib.clearCache();
    this.toast({ kind: 'success', title: this.t('settings.cacheCleared') });
  }

  // ================================================================== playlists
  async newPlaylist(paths = []) {
    const t = this.t;
    const name = await this.ui.prompt({
      title: t('playlists.new'),
      label: t('playlists.name'),
      value: this.playlists.uniqueName(t('playlists.untitled')),
      okLabel: t('playlists.create'),
      parent: this.win,
      validate: (v) => (!v.trim() ? t('playlists.nameEmpty') : this.playlists.nameTaken(v) ? t('playlists.nameTaken') : null),
    });
    if (!name) return null;
    const pl = this.playlists.create(name, this._paths(paths));
    if (paths.length) this.toast({ kind: 'success', title: this.t('toast.addedPlaylist', { count: paths.length, name: pl.name }) });
    else this.go({ name: 'playlist', arg: pl.id });
    return pl;
  }
  async renamePlaylist(id) {
    const pl = this.playlists.get(id);
    if (!pl) return;
    const t = this.t;
    const name = await this.ui.prompt({
      title: t('playlists.rename'),
      label: t('playlists.name'),
      value: pl.name,
      okLabel: t('playlists.rename'),
      parent: this.win,
      validate: (v) => (!v.trim() ? t('playlists.nameEmpty') : this.playlists.nameTaken(v, id) ? t('playlists.nameTaken') : null),
    });
    if (name) this.playlists.rename(id, name);
  }
  async deletePlaylist(id) {
    const pl = this.playlists.get(id);
    if (!pl) return;
    const ok = await this.ui.confirm(this.t('playlists.deleteConfirm', { name: pl.name }), { title: this.t('playlists.deleteTitle'), okLabel: this.t('playlists.delete'), danger: true, parent: this.win });
    if (!ok) return;
    this.playlists.remove(id);
    if (this.route.name === 'playlist' && this.route.arg === id) this.go({ name: 'playlists' }, { replace: true });
  }
  addToPlaylist(id, list) {
    const pl = this.playlists.get(id);
    const paths = this._paths(list);
    if (!pl || !paths.length) return;
    this.playlists.add(id, paths);
    this.toast({ kind: 'success', title: this.t('toast.addedPlaylist', { count: paths.length, name: pl.name }) });
  }
  async addFilesToPlaylist(id) {
    const res = await this.ui.filePicker({ mode: 'open', multiple: true, title: this.t('playlists.addMedia'), filters: this._filters(), path: this.lastDir || this.xdg.music, parent: this.win });
    const paths = [].concat(res || []).filter(isMedia);
    if (paths.length) {
      this.lastDir = dirName(paths[0]);
      for (const p of paths) this.lib.ensure(p);
      this.addToPlaylist(id, paths);
    }
  }

  // ================================================================== menus
  addToMenuItems(paths) {
    const { t } = this;
    const items = [
      { label: t('menu.queue'), icon: 'text_bullet_list_add', action: () => this.addToQueue(paths) },
      '-',
      { label: t('playlists.new'), icon: 'add', action: () => this.newPlaylist(paths) },
    ];
    for (const pl of this.playlists.list()) items.push({ label: pl.name, icon: 'text_bullet_list', action: () => this.addToPlaylist(pl.id, paths) });
    return items;
  }

  itemMenu(ev, entries, ctx = {}) {
    const { t } = this;
    const paths = this._paths(entries);
    if (!paths.length) return;
    const single = paths.length === 1 ? entries[0] : null;
    const items = [
      { label: t('menu.play'), icon: 'play', action: () => (ctx.context === 'queue' ? this.playQueueIndex(ctx.indexes[0]) : this.playEntries(paths, 0, { openStage: single?.kind === 'video' })) },
      ctx.context !== 'queue' ? { label: t('menu.playNext'), icon: 'arrow_next', action: () => this.playNext(paths) } : null,
      { label: t('menu.addTo'), icon: 'add', submenu: this.addToMenuItems(paths) },
    ];
    if (ctx.context === 'queue') {
      items.push('-');
      items.push({ label: t('menu.moveUp'), icon: 'arrow_up', disabled: !single || ctx.indexes[0] === 0, action: () => this.moveInQueue(ctx.indexes[0], ctx.indexes[0] - 1) });
      items.push({ label: t('menu.moveDown'), icon: 'arrow_down', disabled: !single || ctx.indexes[0] >= this.queue.length - 1, action: () => this.moveInQueue(ctx.indexes[0], ctx.indexes[0] + 1) });
      items.push({ label: t('menu.removeFromQueue'), icon: 'dismiss', shortcut: t('keys.del'), action: () => this.removeFromQueue(ctx.indexes) });
    }
    if (ctx.context === 'playlist' && ctx.playlistId) {
      const pl = this.playlists.get(ctx.playlistId);
      items.push('-');
      items.push({ label: t('menu.moveUp'), icon: 'arrow_up', disabled: !single || ctx.indexes[0] === 0, action: () => this.playlists.move(ctx.playlistId, ctx.indexes[0], ctx.indexes[0] - 1) });
      items.push({ label: t('menu.moveDown'), icon: 'arrow_down', disabled: !single || ctx.indexes[0] >= (pl?.items.length || 0) - 1, action: () => this.playlists.move(ctx.playlistId, ctx.indexes[0], ctx.indexes[0] + 1) });
      items.push({ label: t('playlists.removeFrom'), icon: 'dismiss', shortcut: t('keys.del'), action: () => this.playlists.removeAt(ctx.playlistId, ctx.indexes) });
    }
    if (single) {
      items.push('-');
      items.push({ label: t('menu.showInFolder'), icon: 'folder_open', action: () => this.showInFolder(single.path) });
      items.push({ label: t('menu.properties'), icon: 'info', action: () => this.showProperties(single.path) });
    }
    return this.ui.menu(ev, items.filter(Boolean));
  }

  moreMenu(ev) {
    const { t } = this;
    const cur = this.queue.current;
    const narrow = this.root.classList.contains('w-tiny');
    const rate = this.player.rate;
    const items = [
      { label: t('more.openFiles'), icon: 'document', shortcut: 'Ctrl+O', action: () => this.openFiles() },
      { label: t('more.openFolder'), icon: 'folder_open', shortcut: 'Ctrl+Shift+O', action: () => this.openFolder() },
      '-',
      narrow ? { label: t('more.shuffle'), icon: 'arrow_shuffle', checked: this.queue.shuffle, action: () => this.toggleShuffle() } : null,
      narrow ? { label: t(`transport.repeat_${this.queue.repeat}`), icon: 'arrow_repeat_all', action: () => this.cycleRepeat() } : null,
      {
        label: t('speed.title'),
        icon: 'top_speed',
        disabled: !cur,
        submenu: RATES.map((r) => ({ label: r === 1 ? t('speed.normal') : `${this.i18n.formatNumber(r)}×`, checked: rate === r, action: () => this.setRate(r) })),
      },
      { label: t('more.addToPlaylist'), icon: 'album_add', disabled: !cur, submenu: cur ? this.addToMenuItems([cur.path]).slice(2) : [] },
      '-',
      { label: t('menu.showInFolder'), icon: 'folder_open', disabled: !cur, action: () => this.showInFolder(cur.path) },
      { label: t('menu.properties'), icon: 'info', disabled: !cur, action: () => this.showProperties(cur.path) },
      '-',
      { label: t('nav.settings'), icon: 'settings', action: () => this.go({ name: 'settings' }) },
      { label: t('shortcuts.title'), icon: 'keyboard', action: () => this.showShortcuts() },
    ];
    return this.ui.menu(ev, items.filter(Boolean), { above: true });
  }

  showInFolder(path) {
    this.shell.launch('files', { path: dirName(path), select: path });
  }

  async showProperties(path) {
    const { h, t } = this;
    const e = (await this.lib.ensure(path)) || { path, name: baseName(path) };
    const isCur = this.player.path === path;
    const dur = e.duration || (isCur ? this.player.duration : 0);
    const kind = e.kind || kindOf(path);
    const ext = extOf(path).slice(1).toUpperCase();
    const w = e.width || (isCur ? this.player.el.videoWidth : 0);
    const hh = e.height || (isCur ? this.player.el.videoHeight : 0);
    const rows = [
      [t('col.title'), this.titleOf(e)],
      kind !== 'video' ? [t('col.artist'), this.artistOf(e)] : null,
      kind !== 'video' ? [t('col.album'), this.albumOf(e)] : null,
      e.track ? [t('col.track'), String(e.track)] : null,
      e.genre ? [t('col.genre'), e.genre] : null,
      e.year ? [t('col.year'), String(e.year)] : null,
      [t('col.duration'), dur ? formatTime(dur) : '—'],
      w && hh ? [t('col.resolution'), `${w} × ${hh}`] : null,
      [t('col.type'), t(kind === 'video' ? 'props.videoType' : 'props.audioType', { ext })],
      e.size ? [t('col.size'), this.i18n.formatSize(e.size)] : null,
      e.size && dur ? [t('col.bitrate'), t('props.kbps', { n: this.i18n.formatNumber(Math.round((e.size * 8) / dur / 1000)) })] : null,
      [t('col.location'), path],
    ].filter(Boolean);
    const body = h(
      'div',
      { class: 'mp-props' },
      rows.map(([k, v]) => h('div', { class: 'mp-prop' }, h('div', { class: 'mp-prop-k text-2' }, k), h('div', { class: 'mp-prop-v selectable' }, v))),
    );
    await this.ui.dialog({ title: t('menu.properties'), body, parent: this.win, className: 'mp-props-dialog', buttons: [{ label: t('common.close'), value: true, primary: true }] });
  }

  async showShortcuts() {
    const { h, t } = this;
    const list = [
      ['Space / K', 'shortcuts.play'],
      ['← / →', 'shortcuts.seek5'],
      ['J / L', 'shortcuts.seek10'],
      ['↑ / ↓', 'shortcuts.volume'],
      ['M', 'shortcuts.mute'],
      ['N / Ctrl+F', 'shortcuts.next'],
      ['P / Ctrl+B', 'shortcuts.prev'],
      ['F / F11', 'shortcuts.fullscreen'],
      ['Esc', 'shortcuts.escape'],
      ['Ctrl+H', 'shortcuts.shuffle'],
      ['Ctrl+T', 'shortcuts.repeat'],
      ['< / >', 'shortcuts.speed'],
      ['Ctrl+O', 'shortcuts.open'],
      ['Ctrl+Shift+O', 'shortcuts.openFolder'],
      ['Ctrl+E', 'shortcuts.search'],
      ['Ctrl+Shift+M', 'shortcuts.mini'],
    ];
    const body = h('div', { class: 'mp-keys' }, list.map(([k, d]) => h('div', { class: 'mp-key-row' }, h('kbd', null, k), h('span', null, t(d)))));
    await this.ui.dialog({ title: t('shortcuts.title'), body, parent: this.win, className: 'mp-keys-dialog', buttons: [{ label: t('common.close'), value: true, primary: true }] });
  }

  // ================================================================== toasts
  toast({ kind = 'info', title, body, timeout, id } = {}) {
    const { h, icon, t } = this;
    if (id) this.toasts.querySelector(`[data-id="${id}"]`)?.remove();
    const ic = { error: 'error_circle', warning: 'warning', success: 'checkmark_circle', info: 'info' }[kind] || 'info';
    const close = h('button', { class: 'btn subtle icon-btn mp-toast-close', 'aria-label': t('common.close'), 'data-tip': t('common.close') }, icon('dismiss'));
    const el = h('div', { class: ['infobar', 'mp-toast', kind], role: kind === 'error' ? 'alert' : 'status', dataset: id ? { id } : {} }, icon(ic, { filled: true }), h('div', { class: 'grow' }, h('div', { class: 'body-strong' }, title), body ? h('div', { class: 'mp-toast-body' }, body) : null), close);
    const remove = () => {
      if (!el.isConnected) return;
      el.classList.add('out');
      setTimeout(() => el.remove(), reduceMotion() ? 0 : 180);
    };
    close.addEventListener('click', remove);
    this.toasts.appendChild(el);
    while (this.toasts.children.length > 3) this.toasts.firstChild.remove();
    setTimeout(remove, timeout || (kind === 'error' ? 9000 : 4000));
    return el;
  }
}
