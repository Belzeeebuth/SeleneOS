// Clock window: navigation pane (Focus, Timer, Alarm, Stopwatch, World clock, Settings),
// page routing with Fluent entrance animations, the frame/second render loop, keyboard shortcuts,
// relaunch arguments (notification clicks) and the taskbar progress of running timers / focus sessions.
import { getStore } from './store.js';
import { loadCities, cityById } from './cities.js';
import { reduceMotion, EASE, guardClicks } from './widgets.js';
import { timeParts } from './time.js';
import { AlarmPage } from './page-alarm.js';
import { TimerPage } from './page-timer.js';
import { StopwatchPage } from './page-stopwatch.js';
import { WorldPage } from './page-world.js';
import { FocusPage } from './page-focus.js';
import { SettingsPage } from './page-settings.js';

export const PAGES = [
  { id: 'alarm', icon: 'clock_alarm', label: 'nav.alarm', cls: AlarmPage },
  { id: 'timer', icon: 'hourglass_half', label: 'nav.timer', cls: TimerPage },
  { id: 'stopwatch', icon: 'timer', label: 'nav.stopwatch', cls: StopwatchPage },
  { id: 'world', icon: 'globe', label: 'nav.world', cls: WorldPage },
  { id: 'focus', icon: 'target', label: 'nav.focus', cls: FocusPage },
];
const SETTINGS = { id: 'settings', icon: 'settings', label: 'nav.settings', cls: SettingsPage };
const NARROW = 700;

export class ClockApp {
  constructor(ctx) {
    this.ctx = ctx;
    this.h = ctx.h;
    this.t = ctx.t;
    this.icon = ctx.icon;
    this.ui = ctx.ui;
    this.win = ctx.win;
    this.shell = ctx.shell;
    this.i18n = ctx.i18n;
    this.pages = new Map();
    this.page = null;
    this.pageId = null;
    this.closed = false;
    this.offs = [];
  }

  get lang() {
    return this.i18n.lang;
  }
  get locale() {
    return this.i18n.locale;
  }
  get h12() {
    return this.store.h12;
  }

  async init() {
    this.store = getStore(this.ctx);
    await this.store.ready;
    try {
      await loadCities(this.ctx.appUrl);
      // stored ids that are not (or no longer) in the bundled list would shift the reorder indexes
      this.store.pruneCities((id) => !!cityById(id));
    } catch (err) {
      console.error('[clock] city list failed to load', err);
      this.citiesError = err;
    }
    this._build();
    this.win.el.__clock = this; // test / automation hook
    const args = this.ctx.args || {};
    this.go(this._pageFromArgs(args) || this.store.prefs.page, { animate: false, save: false });
    this._applyArgs(args);
    this.offs.push(
      this.store.on((kind, extra) => this._onStore(kind, extra)),
      this.ctx.settings.on('notifications', () => this.page?.onStore?.('notifications')),
      this.ctx.settings.on('clock24h', () => this.rebuild()),
      this.ctx.settings.on('theme', () => this.pageId === 'settings' && this.page.render()),
      this.ctx.settings.on('appThemes', () => this.pageId === 'settings' && this.page.render()),
    );
    this.ctx.onLangChange(() => this.rebuild());
    // keys typed anywhere in the window (the window body itself may hold the focus)
    this.win.body.addEventListener('keydown', (e) => this._keys(e));
    this.ctx.onClose(() => this._dispose());
    this.win.on('restore', () => this.kick());
    this.win.on('focus', () => this.kick());
    this._loop();
    return this;
  }

  // ------------------------------------------------------------------ layout
  _build() {
    const { h, t, icon } = this;
    this.burger = h(
      'button',
      { type: 'button', class: 'btn subtle ck-burger', 'aria-label': t('nav.toggle'), 'data-tip': t('nav.toggle'), onclick: () => this.toggleNav() },
      icon('line_horizontal_3'),
    );
    this.navItems = {};
    const item = (p) => {
      const el = h(
        'button',
        { type: 'button', class: 'nav-item ck-nav-item', dataset: { page: p.id }, 'aria-label': t(p.label), onclick: () => this.go(p.id) },
        h('span', { class: 'ck-nav-icon' }, icon(p.icon), h('span', { class: 'ck-nav-dot', hidden: true })),
        h('span', { class: 'ck-nav-label ellipsis' }, t(p.label)),
      );
      this.navItems[p.id] = el;
      return el;
    };
    this.pill = h('div', { class: 'ck-nav-pill', 'aria-hidden': 'true' });
    this.navList = h('div', { class: 'ck-nav-list', role: 'tablist', 'aria-orientation': 'vertical' }, PAGES.map(item));
    this.navEl = h(
      'nav',
      { class: 'ck-nav', 'aria-label': t('nav.label') },
      h('div', { class: 'ck-nav-top' }, this.burger),
      this.navList,
      h('div', { class: 'ck-nav-foot' }, item(SETTINGS)),
      this.pill,
    );
    // one Tab stop for the whole pane (the selected item); arrow keys / Home / End move between items,
    // Enter or Space opens the page (WinUI NavigationView / ARIA tabs pattern)
    this.navEl.addEventListener('keydown', (e) => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key) || e.altKey || e.ctrlKey) return;
      const all = [...this.navEl.querySelectorAll('.ck-nav-item')];
      const i = all.indexOf(document.activeElement);
      if (i < 0) return;
      e.preventDefault();
      const n = e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length;
      all[n].focus();
    });
    // the Tab stop follows the focused item while inside the pane, and goes back to the selected
    // page's item when the focus leaves it (so Tab always leaves the pane in one step)
    const rove = (target) => {
      for (const el of this.navEl.querySelectorAll('.ck-nav-item')) el.tabIndex = el === target ? 0 : -1;
    };
    this.navEl.addEventListener('focusin', (e) => {
      const it = e.target.closest?.('.ck-nav-item');
      if (it) rove(it);
    });
    this.navEl.addEventListener('focusout', (e) => {
      if (this.navEl.contains(e.relatedTarget)) return;
      rove(this.navItems[this.pageId]);
      // the overlay pane of a narrow window is light-dismiss: Tab (or a click) out of it closes it
      if (e.relatedTarget && this.root.classList.contains('nav-open')) this.closeNavOverlay();
    });
    this.infoSlot = h('div', { class: 'ck-info-slot' });
    this.scroller = h('div', { class: 'ck-scroll', tabindex: '-1' });
    // clicking an empty part of a page gives it the keyboard focus (Space / L / R on the stopwatch…)
    this.scroller.addEventListener('pointerdown', (e) => {
      if (!e.target.closest('button, input, select, textarea, a, [tabindex]:not(.ck-scroll), [contenteditable="true"]')) {
        setTimeout(() => {
          if (!this.scroller.contains(document.activeElement) || document.activeElement === document.body) this.scroller.focus({ preventScroll: true });
        });
      }
    });
    this.main = h('main', { class: 'ck-main' }, this.infoSlot, this.scroller);
    this.scrim = h('div', { class: 'ck-scrim', onclick: () => this.closeNavOverlay() });
    this.root = h('div', { class: 'ck' }, this.navEl, this.main, this.scrim);
    this.win.body.appendChild(this.root);
    this.ro = new ResizeObserver(() => this._layout());
    this.ro.observe(this.root);
    this._layout();
    this._renderSaveError();
  }

  _layout() {
    const w = this.root.clientWidth;
    const narrow = w > 0 && w < NARROW;
    this.root.classList.toggle('narrow', narrow);
    this.root.classList.toggle('compact', narrow || this.store.prefs.navCollapsed);
    if (!narrow) this.root.classList.remove('nav-open');
    this.root.classList.toggle('tight', w > 0 && w < 520);
    this._navTips();
    this._placePill(false);
    this.page?.onResize?.();
  }

  toggleNav() {
    if (this.root.classList.contains('narrow')) {
      const open = !this.root.classList.contains('nav-open');
      this.root.classList.toggle('nav-open', open);
      this._navTips();
      if (open) this.navItems[this.pageId]?.focus();
    } else {
      this.store.setPref('navCollapsed', !this.store.prefs.navCollapsed);
      this._layout();
    }
  }

  closeNavOverlay() {
    if (!this.root.classList.contains('nav-open')) return;
    this.root.classList.remove('nav-open');
    this._navTips();
  }

  /** Icon-only pane: each item names itself in a tooltip (like a compact WinUI NavigationView). */
  _navTips() {
    const iconsOnly = this.root.classList.contains('compact') && !this.root.classList.contains('nav-open');
    for (const el of Object.values(this.navItems)) {
      if (iconsOnly) el.dataset.tip = el.getAttribute('aria-label');
      else delete el.dataset.tip;
    }
  }

  _placePill(animate = true) {
    const el = this.navItems[this.pageId];
    if (!el || !this.pill) return;
    const nav = this.navEl.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (!r.height) return;
    // Full-height edge bar (only drawn where the style sets --sel-bar-w, i.e. Éclipse), not a short pill.
    const y = r.top - nav.top;
    const x = r.left - nav.left;
    this.pill.style.height = `${r.height}px`;
    this.pill.style.transition = animate && !reduceMotion() ? `transform 250ms ${EASE}` : 'none';
    this.pill.style.transform = `translate(${x}px, ${y}px)`;
    this.pill.hidden = false;
  }

  // ------------------------------------------------------------------ routing
  go(id, { animate = true, save = true } = {}) {
    const def = [...PAGES, SETTINGS].find((p) => p.id === id) || PAGES[1];
    this.closeNavOverlay();
    if (this.pageId === def.id && this.page) return this.page;
    this.page?.hide?.();
    if (this.page?.el) this.page.el.remove();
    let page = this.pages.get(def.id);
    if (!page) {
      page = new def.cls(this);
      page.el = page.build();
      page.el.classList.add('ck-page', `ck-page-${def.id}`);
      page.el.setAttribute('role', 'tabpanel');
      page.el.setAttribute('aria-label', this.t(def.label));
      this.pages.set(def.id, page);
    }
    this.page = page;
    this.pageId = def.id;
    this.root.dataset.page = def.id;
    this.scroller.scrollTop = 0;
    this.scroller.appendChild(page.el);
    page.show?.();
    if (!this.win.el.contains(document.activeElement) || document.activeElement === this.win.body) this.scroller.focus({ preventScroll: true });
    for (const [pid, el] of Object.entries(this.navItems)) {
      el.classList.toggle('selected', pid === def.id);
      el.setAttribute('aria-selected', String(pid === def.id));
      el.setAttribute('role', 'tab');
      el.tabIndex = pid === def.id ? 0 : -1;
    }
    this._placePill(animate);
    if (animate && !reduceMotion()) page.el.animate([{ opacity: 0, transform: 'translateY(28px)' }, { opacity: 1, transform: 'none' }], { duration: 300, easing: EASE });
    if (save && this.store.prefs.page !== def.id) this.store.setPref('page', def.id);
    this.kick();
    return page;
  }

  /** Rebuild every page (language or time format changed). */
  rebuild() {
    if (this.closed) return;
    const id = this.pageId;
    for (const p of this.pages.values()) {
      p.destroy?.();
      p.el?.remove();
    }
    this.pages.clear();
    this.page = null;
    this.pageId = null;
    this.root.remove();
    this.ro.disconnect();
    this._build();
    this.go(id, { animate: false, save: false });
  }

  _pageFromArgs(args) {
    const d = args?.reminder?.data;
    if (d?.alarmId) return 'alarm';
    if (d?.timerId) return 'timer';
    if (d?.focus || /^focus-/.test(args?.reminder?.id || '')) return 'focus';
    if (typeof args?.page === 'string' && [...PAGES, SETTINGS].some((p) => p.id === args.page)) return args.page;
    return null;
  }

  _applyArgs(args) {
    const d = args?.reminder?.data;
    if (d?.alarmId) this.page?.highlight?.(d.alarmId);
    if (d?.timerId) this.page?.highlight?.(d.timerId);
  }

  onRelaunch(args) {
    const id = this._pageFromArgs(args || {});
    if (id) this.go(id);
    this._applyArgs(args || {});
  }

  // ------------------------------------------------------------------ store events
  _onStore(kind, extra) {
    if (this.closed) return;
    if (kind === 'save-error') return this._renderSaveError();
    if (kind === 'error') {
      this.ui.alert(this.t('errors.schedule', { msg: extra?.message || String(extra) }), { title: this.t('errors.title'), parent: this.win });
      return;
    }
    for (const p of this.pages.values()) p.onStore?.(kind, extra);
    this._updateDots();
    this.kick();
  }

  _renderSaveError() {
    const { h, t, icon } = this;
    this.infoSlot.replaceChildren();
    if (this.store.saveError) {
      this.infoSlot.appendChild(
        h('div', { class: 'infobar error ck-infobar', role: 'alert' }, icon('error_circle', { filled: true }), h('div', { class: 'grow' }, h('b', null, t('errors.saveTitle')), ' ', t('errors.saveBody'))),
      );
    }
    // stored files that could not be read at startup (set aside as <name>.unreadable-<date>.json)
    const lost = this.store.loadErrors || [];
    if (lost.length) {
      const what = lost.map((e) => t(`errors.part.${e.name}`)).join(t('units.sep'));
      const kept = lost.filter((e) => e.backup).map((e) => e.backup);
      this.infoSlot.appendChild(
        h(
          'div',
          { class: 'infobar warning ck-infobar ck-load-error', role: 'alert' },
          icon('warning', { filled: true }),
          h('div', { class: 'grow' }, h('b', null, t('errors.loadTitle', { what })), ' ', kept.length ? t('errors.loadKept', { files: kept.join(', ') }) : t('errors.loadLost')),
          h('button', { type: 'button', class: 'btn subtle icon-btn', 'aria-label': t('errors.dismiss'), 'data-tip': t('errors.dismiss'), onclick: () => this.store.dismissLoadErrors() }, icon('dismiss')),
        ),
      );
    }
  }

  _updateDots(now = Date.now()) {
    const s = this.store;
    const on = {
      timer: s.timers.some((x) => x.state === 'running' || x.state === 'done'),
      stopwatch: s.stopwatch.running,
      focus: !!s.focus.session,
      alarm: false,
    };
    for (const [id, v] of Object.entries(on)) {
      const dot = this.navItems[id]?.querySelector('.ck-nav-dot');
      if (dot && dot.hidden === v) dot.hidden = !v;
    }
    // taskbar progress: focus session first, else the timer that ends soonest
    let prog = null;
    const fs = s.focus.session;
    if (fs) prog = s.focusElapsed(now) / (s.focusTotal() || 1);
    else {
      const run = s.timers.filter((x) => x.state === 'running').sort((a, b) => a.endAt - b.endAt)[0];
      if (run) prog = 1 - s.progressOf(run, now);
    }
    const key = prog == null ? 'none' : Math.round(prog * 200);
    if (key !== this._progKey) {
      this._progKey = key;
      try {
        this.win.setProgress?.(prog == null ? null : Math.max(0.001, Math.min(1, prog)));
      } catch {}
    }
  }

  // ------------------------------------------------------------------ loop
  kick() {
    if (this.closed) return;
    cancelAnimationFrame(this.raf);
    clearTimeout(this.to);
    this._loop();
  }

  _visible() {
    const el = this.win.el;
    return !this.win.minimized && el.isConnected && !el.classList.contains('off-desktop');
  }

  _loop() {
    if (this.closed) return;
    const now = Date.now();
    const visible = this._visible();
    this.store.tickTimers(now);
    if (visible) {
      try {
        this.page?.tick?.(now);
      } catch (err) {
        console.error('[clock] tick failed', err);
      }
    }
    if (!this._lastSlow || now - this._lastSlow >= 1000) {
      this._lastSlow = now;
      this._updateDots(now);
      this.store.checkZone();
    }
    const frames = visible && this.page?.wantsFrames?.(now);
    if (frames) this.raf = requestAnimationFrame(() => this._loop());
    else this.to = setTimeout(() => this._loop(), visible ? 1000 - (now % 1000) + 8 : 1000);
  }

  // ------------------------------------------------------------------ keyboard
  _keys(e) {
    if (e.defaultPrevented) return;
    if (this.win.el.querySelector(':scope > .dialog-layer:not(.closing)')) return;
    const tag = e.target?.tagName;
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable;
    if (e.key === 'Escape' && this.root.classList.contains('nav-open')) {
      this.closeNavOverlay();
      e.preventDefault();
      return;
    }
    if (e.ctrlKey && !e.altKey && !e.shiftKey && /^[1-5]$/.test(e.key)) {
      e.preventDefault();
      this.go(PAGES[Number(e.key) - 1].id);
      return;
    }
    if (e.ctrlKey && e.key === ',') {
      e.preventDefault();
      this.go('settings');
      return;
    }
    if (typing && e.key !== 'Escape') return;
    if (this.page?.onKey?.(e)) e.preventDefault();
  }

  _dispose() {
    this.closed = true;
    // A dialog still open when the window goes away (taskbar "Close window", Task Manager…) is answered
    // "cancel": otherwise ui.dialog's document-level key handler outlives it and swallows Tab / Esc in
    // every other window until Esc is pressed once.
    for (const dlg of this.win.el.querySelectorAll(':scope > .dialog-layer .dialog')) {
      try {
        dlg._done?.(null);
      } catch {}
    }
    cancelAnimationFrame(this.raf);
    clearTimeout(this.to);
    this.ro?.disconnect();
    for (const off of this.offs) off?.();
    for (const p of this.pages.values()) p.destroy?.();
    this.store.flush().catch(() => {});
  }

  // ------------------------------------------------------------------ helpers for pages
  /** ui.dialog scoped to the Clock window, with Clock's dialog class and a double-click guard. */
  dialog(opts) {
    return this.ui.dialog({
      parent: this.win,
      ...opts,
      className: ['ck-dialog', opts.className].filter(Boolean).join(' '),
      onOpen: (dlg, done) => {
        guardClicks(dlg);
        opts.onOpen?.(dlg, done);
      },
    });
  }

  /** Yes / no question in the Clock window -> boolean. */
  async confirm(message, { title, okLabel, cancelLabel, danger } = {}) {
    const v = await this.dialog({
      title,
      body: message,
      buttons: [
        { label: okLabel || this.t('common.ok'), value: true, primary: !danger, danger },
        { label: cancelLabel || this.t('common.cancel'), value: false },
      ],
    });
    return v === true;
  }

  /** { main, period, full } for a moment, in the user's 12/24 h format (optionally in another zone). */
  timeParts(at, { tz, seconds = false } = {}) {
    return timeParts(at, { locale: this.locale, h12: this.h12, tz, seconds });
  }
  timeText(at, opts) {
    return this.timeParts(at, opts).full;
  }
}
