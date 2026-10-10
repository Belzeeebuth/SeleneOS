// Task Manager window: title-bar search, collapsible navigation pane, page header with the
// page's command bar, and the pages themselves. Pages implement:
//   { id, icon, title(), needs: { procs, shell }, mount(el), show(), hide(), update(store),
//     commands() -> [{ id, icon, label, action, disabled, pressed, menu }], onSearch(q), focus(), relabel() }
import { wm } from '../../../core/wm.js';
import { Store } from './store.js';
import { createFormat, debounce, alignMenu } from './util.js';
import { createActions } from './actions.js';
import { ProcessesPage } from './pages/processes.js';
import { PerformancePage } from './pages/performance.js';
import { HistoryPage } from './pages/history.js';
import { StartupPage } from './pages/startup.js';
import { UsersPage } from './pages/users.js';
import { DetailsPage } from './pages/details.js';
import { ServicesPage } from './pages/services.js';
import { SettingsPage } from './pages/settings.js';

// Like WinUI's NavigationView: the pane is expanded in wide windows, compact (icons) below.
const NAV_EXPAND_MIN = 1000;

export const PAGE_ORDER = ['processes', 'performance', 'history', 'startup', 'users', 'details', 'services'];

const DEFAULT_PREFS = {
  startPage: 'processes',
  speed: 'normal',
  navExpanded: true,
  groupByType: true,
  memPercent: false,
  kernelThreads: false,
  showFullName: false,
  effConfirm: true,
  alwaysOnTop: false,
  minimizeOnUse: false,
  historyAll: false,
  cpuGraph: 'overall',
  columns: {},
  widths: {},
  sort: {},
};

export class TaskManager {
  constructor(ctx) {
    this.ctx = ctx;
    this.win = ctx.win;
    this.t = ctx.t;
    this.fmt = createFormat(ctx);
    this.store = new Store(ctx.api);
    this.pages = {};
    this.current = null;
    this.query = '';
    this.prefs = { ...DEFAULT_PREFS };
    this.offs = [];
  }

  async init() {
    const { h, icon, win, t } = this.ctx;
    try {
      const saved = await this.ctx.storage.get('prefs', null);
      if (saved && typeof saved === 'object') this.prefs = { ...DEFAULT_PREFS, ...saved };
    } catch {}
    this.savePrefs = debounce(() => this.ctx.storage.set('prefs', this.prefs).catch(() => {}), 400);
    this.actions = createActions(this);

    // ---- title bar search
    this.search = h('input', {
      class: 'input tm-search-input',
      type: 'search',
      spellcheck: false,
      'aria-label': t('search.label'),
      placeholder: t('search.placeholder'),
    });
    const clearBtn = h('button', { class: 'tm-search-clear', tabindex: '-1', 'aria-label': t('search.clear'), onclick: () => this.setQuery('', true) }, icon('dismiss', { size: 12 }));
    this.searchBox = h('div', { class: 'tm-search' }, icon('search', { size: 14, class: 'tm-search-ic' }), this.search, clearBtn);
    win.titlebarSlot.appendChild(h('div', { class: 'tm-tb' }, this.searchBox));
    const onSearch = debounce((q) => this.applyQuery(q), 120);
    this.search.addEventListener('input', () => {
      this.searchBox.classList.toggle('has-text', !!this.search.value);
      onSearch(this.search.value);
    });
    this.search.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.search.value) {
        e.preventDefault();
        e.stopPropagation();
        this.setQuery('', true);
      } else if (e.key === 'Enter' || e.key === 'ArrowDown') {
        e.preventDefault();
        onSearch.flush(this.search.value);
        this.current?.focus();
      }
    });

    // ---- navigation
    this.burger = h('button', { class: 'tm-burger btn subtle icon-btn', 'aria-label': t('nav.toggle'), 'data-tip': t('nav.toggle'), onclick: () => this.toggleNav() }, icon('navigation'));
    this.pages = {
      processes: new ProcessesPage(this),
      performance: new PerformancePage(this),
      history: new HistoryPage(this),
      startup: new StartupPage(this),
      users: new UsersPage(this),
      details: new DetailsPage(this),
      services: new ServicesPage(this),
      settings: new SettingsPage(this),
    };
    this.navItems = new Map();
    const mkItem = (id) => {
      const p = this.pages[id];
      const label = h('span', { class: 'tm-nav-label ellipsis' }, p.title());
      const btn = h('button', { class: 'nav-item tm-nav-item', role: 'tab', 'aria-selected': 'false', dataset: { page: id }, onclick: () => this.go(id, { focus: false }) }, icon(p.icon), label);
      btn._label = label;
      this.navItems.set(id, btn);
      return btn;
    };
    this.navList = h('div', { class: 'tm-nav-list', role: 'tablist', 'aria-orientation': 'vertical' }, PAGE_ORDER.map(mkItem));
    this.nav = h('nav', { class: 'tm-nav', 'aria-label': t('nav.label') }, h('div', { class: 'tm-nav-top' }, this.burger), this.navList, h('div', { class: 'tm-nav-foot' }, mkItem('settings')));
    this.navList.addEventListener('keydown', (e) => this._navKeys(e));
    this.nav.querySelector('.tm-nav-foot').addEventListener('keydown', (e) => this._navKeys(e));

    // ---- main area
    this.titleEl = h('h1', { class: 'tm-title ellipsis' });
    this.cmdBar = h('div', { class: 'tm-cmds', role: 'toolbar', 'aria-label': t('cmd.toolbar') });
    this.head = h('header', { class: 'tm-head' }, this.titleEl, this.cmdBar);
    this.pageHost = h('div', { class: 'tm-pages' });
    this.errorText = h('div', { class: 'caption grow' });
    this.errorBar = h(
      'div',
      { class: 'infobar error tm-error', role: 'alert', hidden: true },
      icon('error_circle', { filled: true }),
      this.errorText,
      h('button', { class: 'btn small', onclick: () => this.store.refresh() }, t('common.retry')),
    );
    this.main = h('main', { class: 'tm-main' }, this.head, this.errorBar, this.pageHost);
    this.scrim = h('div', { class: 'tm-scrim', onclick: () => this.toggleNav(false) });
    this.root = h('div', { class: 'tm-root' }, this.nav, this.scrim, this.main);
    win.body.appendChild(this.root);

    for (const [id, p] of Object.entries(this.pages)) {
      p.el = h('section', { class: `tm-page tm-page-${id}`, role: 'tabpanel', hidden: true, 'aria-label': p.title() });
      p.mount(p.el);
      this.pageHost.appendChild(p.el);
    }

    // ---- behaviour
    this.store.setSpeed(this.prefs.speed);
    this.store.on('tick', () => this._tick());
    this.store.on('error', (err) => {
      this.errorText.textContent = t('err.data', { msg: err?.message || String(err) });
      this.errorBar.hidden = false;
    });
    this._ro = new ResizeObserver(() => this._layout());
    this._ro.observe(this.root);
    win.on('minimize', () => this.store.stop());
    win.on('restore', () => this.store.start());
    win.on('close', () => this.destroy());
    this.offs.push(wm.on('change', () => this.current?.onWindows?.()));
    this.offs.push(wm.on('open', () => this.current?.onWindows?.()));
    this.offs.push(wm.on('close', () => this.current?.onWindows?.()));
    this.ctx.onLangChange(() => this.relabel());
    this.root.addEventListener('keydown', (e) => this._keys(e));
    this.applyAlwaysOnTop();
    this.applyNav();

    const start = this.ctx.args?.page && this.pages[this.ctx.args.page] ? this.ctx.args.page : this.prefs.startPage;
    this.go(this.pages[start] ? start : 'processes', { focus: false, animate: false });
    this.store.start();
  }

  // ------------------------------------------------------------------ pages
  go(id, { focus = true, animate = true, select } = {}) {
    const p = this.pages[id];
    if (!p) return;
    const prev = this.current;
    if (prev !== p) {
      if (prev) {
        prev.hide?.();
        prev.el.hidden = true;
      }
      this.current = p;
      p.el.hidden = false;
      if (animate && document.documentElement.dataset.animations !== 'off') {
        p.el.classList.remove('enter');
        void p.el.offsetWidth;
        p.el.classList.add('enter');
      }
      for (const [k, b] of this.navItems) {
        b.classList.toggle('selected', k === id);
        b.setAttribute('aria-selected', String(k === id));
        b.tabIndex = k === id ? 0 : -1;
      }
      this.titleEl.textContent = p.title();
      this.store.setNeeds(p.needs || {});
      p.onSearch?.(this.query);
      p.show?.();
      if (this.store.perf) p.update?.(this.store);
      this.renderCommands();
      if (this.navOverlay) this.toggleNav(false);
    }
    if (select != null) p.reveal?.(select);
    if (focus) setTimeout(() => p.focus?.(), 0);
  }

  _tick() {
    if (!this.errorBar.hidden) this.errorBar.hidden = true;
    this.current?.update?.(this.store);
    this.renderCommands();
  }

  applyQuery(q) {
    this.query = q;
    if (q && (this.current?.id === 'performance' || this.current?.id === 'settings')) this.go('processes', { focus: false });
    this.current?.onSearch?.(q);
  }
  setQuery(q, focusSearch) {
    this.search.value = q;
    this.searchBox.classList.toggle('has-text', !!q);
    this.applyQuery(q);
    if (focusSearch) this.search.focus();
  }

  // ------------------------------------------------------------------ command bar
  renderCommands() {
    const { h, icon } = this.ctx;
    const cmds = (this.current?.commands?.() || []).filter(Boolean);
    const sig = JSON.stringify(cmds.map((c) => [c.id, c.label, !!c.disabled, c.pressed ?? null, c.icon]));
    if (sig === this._cmdSig) return;
    this._cmdSig = sig;
    const focusedId = this.cmdBar.contains(document.activeElement) ? document.activeElement.dataset.cmd : null;
    this.cmdBar.textContent = '';
    for (const c of cmds) {
      const btn = h(
        'button',
        {
          class: ['btn', 'subtle', 'tm-cmd', c.menu && 'has-menu'],
          disabled: !!c.disabled,
          'data-tip': c.label,
          'data-tip-pos': 'below',
          'aria-label': c.label,
          dataset: { cmd: c.id },
          'aria-pressed': c.pressed == null ? null : String(!!c.pressed),
          'aria-haspopup': c.menu ? 'menu' : null,
          onclick: (e) => {
            if (c.menu) this.menu(e.currentTarget, c.menu());
            else c.action?.();
          },
        },
        c.icon ? icon(c.icon, { filled: !!c.pressed }) : null,
        h('span', { class: 'tm-cmd-label' }, c.label),
        c.menu ? icon('chevron_down', { size: 12, class: 'tm-cmd-chev' }) : null,
      );
      this.cmdBar.appendChild(btn);
    }
    if (focusedId) this.cmdBar.querySelector(`[data-cmd="${focusedId}"]`)?.focus();
    this._fitCommands();
  }
  // Labels collapse to icons (with tooltips) when the commands don't fit next to the title.
  _fitCommands() {
    this.head.classList.remove('compact');
    const kids = [...this.cmdBar.children];
    const need = kids.reduce((a, c) => a + c.offsetWidth, 0) + Math.max(0, kids.length - 1) * 2;
    if (need > this.cmdBar.clientWidth + 1) this.head.classList.add('compact');
  }

  // ------------------------------------------------------------------ navigation pane
  applyNav() {
    const narrow = this.root.clientWidth > 0 && this.root.clientWidth < NAV_EXPAND_MIN;
    this.root.classList.toggle('narrow', narrow);
    const expanded = narrow ? !!this.navOverlay : this.prefs.navExpanded;
    this.root.classList.toggle('nav-expanded', expanded);
    this.root.classList.toggle('nav-overlay', narrow && !!this.navOverlay);
    for (const b of this.navItems.values()) {
      if (expanded) b.removeAttribute('data-tip');
      else b.setAttribute('data-tip', b._label.textContent);
    }
    this.burger.setAttribute('aria-expanded', String(expanded));
  }
  toggleNav(force) {
    if (this.root.classList.contains('narrow')) {
      this.navOverlay = force ?? !this.navOverlay;
    } else {
      this.prefs.navExpanded = force ?? !this.prefs.navExpanded;
      this.savePrefs();
    }
    this.applyNav();
    this._fitCommands();
  }
  _layout() {
    const wasNarrow = this.root.classList.contains('narrow');
    const narrow = this.root.clientWidth < NAV_EXPAND_MIN;
    if (wasNarrow !== narrow) {
      this.navOverlay = false;
      this.applyNav();
    }
    this._fitCommands();
  }
  _navKeys(e) {
    const items = [...this.navItems.values()];
    const i = items.indexOf(document.activeElement);
    if (i < 0) return;
    let j = null;
    if (e.key === 'ArrowDown') j = (i + 1) % items.length;
    else if (e.key === 'ArrowUp') j = (i - 1 + items.length) % items.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = items.length - 1;
    if (j == null) return;
    e.preventDefault();
    items[j].focus();
  }

  _keys(e) {
    const k = e.key;
    if ((e.ctrlKey && (k === 'f' || k === 'F' || k === 'e' || k === 'E')) || (k === '/' && !/INPUT|TEXTAREA/.test(document.activeElement?.tagName))) {
      e.preventDefault();
      this.search.focus();
      this.search.select();
      return;
    }
    if (e.ctrlKey && k === 'Tab') {
      e.preventDefault();
      const order = [...PAGE_ORDER, 'settings'];
      const i = order.indexOf(this.current?.id);
      this.go(order[(i + (e.shiftKey ? -1 : 1) + order.length) % order.length]);
      return;
    }
    if (k === 'F5') {
      e.preventDefault();
      this.store.refresh();
      this.current?.refresh?.();
    }
  }

  // ------------------------------------------------------------------ preferences
  setPref(key, value) {
    this.prefs[key] = value;
    this.savePrefs();
    if (key === 'speed') this.store.setSpeed(value);
    if (key === 'alwaysOnTop') this.applyAlwaysOnTop();
    this.current?.onPref?.(key, value);
    for (const p of Object.values(this.pages)) if (p !== this.current) p.onPref?.(key, value, { hidden: true });
    this._cmdSig = null;
    this.renderCommands();
  }

  applyAlwaysOnTop() {
    const w = this.win;
    const on = !!this.prefs.alwaysOnTop;
    if (!!w.alwaysOnTop === on) return;
    w.alwaysOnTop = on;
    // The wm applies the always-on-top band on focus; re-stack right away.
    const others = wm.list().filter((x) => x !== w && !x.alwaysOnTop && !x.fullscreen);
    const top = Math.max(10, ...others.map((x) => Number(x.el.style.zIndex) || 0));
    w.el.style.zIndex = String(on ? 100000 + top + 1 : top + 1);
  }

  speedMenu() {
    const { t } = this;
    const cur = this.prefs.speed;
    return ['high', 'normal', 'low', 'paused'].map((s) => ({ label: t(`speed.${s}`), checked: cur === s, action: () => this.setPref('speed', s) }));
  }

  relabel() {
    const { t } = this;
    this.search.placeholder = t('search.placeholder');
    this.search.setAttribute('aria-label', t('search.label'));
    this.burger.setAttribute('aria-label', t('nav.toggle'));
    this.burger.dataset.tip = t('nav.toggle');
    this.nav.setAttribute('aria-label', t('nav.label'));
    this.cmdBar.setAttribute('aria-label', t('cmd.toolbar'));
    this.errorBar.querySelector('.btn').textContent = t('common.retry');
    this.searchBox.querySelector('.tm-search-clear').setAttribute('aria-label', t('search.clear'));
    for (const [id, b] of this.navItems) b._label.textContent = this.pages[id].title();
    for (const p of Object.values(this.pages)) {
      p.el.setAttribute('aria-label', p.title());
      p.relabel?.();
    }
    if (this.current) this.titleEl.textContent = this.current.title();
    this.applyNav();
    this._cmdSig = null;
    this.renderCommands();
  }

  menu(at, items) {
    return this.ctx.ui.menu(at, alignMenu(items));
  }

  // Window → front, honoring "Minimize on use".
  switchTo(w) {
    w.focus();
    if (this.prefs.minimizeOnUse && w !== this.win) this.win.minimize();
  }

  destroy() {
    this.store.stop();
    this._ro?.disconnect();
    for (const off of this.offs) off();
    for (const p of Object.values(this.pages)) p.destroy?.();
  }
}
