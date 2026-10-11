// System Monitor window: title-bar search, a tab bar along the top (Processes, Performance, Startup,
// Users, Services, and Settings as a gear), a quiet toolbar row (the Processes views switch: list,
// details, history; then the page's commands), and the pages themselves. Pages implement:
//   { id, icon, title(), needs: { procs, shell }, mount(el), show(), hide(), update(store),
//     commands() -> [{ id, icon, label, action, disabled, pressed, menu }], onSearch(q), focus(), relabel() }
import { wm } from '../../../core/wm.js';
import { Store } from './store.js';
import { createFormat, debounce, alignMenu, errText } from './util.js';
import { createActions } from './actions.js';
import { ProcessesPage } from './pages/processes.js';
import { PerformancePage } from './pages/performance.js';
import { HistoryPage } from './pages/history.js';
import { StartupPage } from './pages/startup.js';
import { UsersPage } from './pages/users.js';
import { DetailsPage } from './pages/details.js';
import { ServicesPage } from './pages/services.js';
import { SettingsPage } from './pages/settings.js';

export const PAGE_ORDER = ['processes', 'performance', 'history', 'startup', 'users', 'details', 'services'];
// Top tabs. History and Details are views of the Processes tab (switch in the toolbar row).
export const TABS = ['processes', 'performance', 'startup', 'users', 'services'];
export const PROC_VIEWS = ['processes', 'details', 'history'];
const tabOf = (id) => (PROC_VIEWS.includes(id) ? 'processes' : id);

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

// Saved preferences are user-editable JSON: keep only well-formed values (a bad column width would
// otherwise break the grid layout, an unknown speed would stop polling…).
const plain = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
export function sanitizePrefs(saved) {
  const p = { ...DEFAULT_PREFS };
  if (!plain(saved)) return p;
  const oneOf = (v, list, d) => (list.includes(v) ? v : d);
  for (const [k, d] of Object.entries(DEFAULT_PREFS)) if (typeof d === 'boolean' && typeof saved[k] === 'boolean') p[k] = saved[k];
  p.startPage = oneOf(saved.startPage, [...PAGE_ORDER, 'settings'], DEFAULT_PREFS.startPage);
  p.speed = oneOf(saved.speed, ['high', 'normal', 'low', 'paused'], DEFAULT_PREFS.speed);
  p.cpuGraph = oneOf(saved.cpuGraph, ['overall', 'logical'], DEFAULT_PREFS.cpuGraph);
  const pages = Object.keys;
  p.columns = {};
  if (plain(saved.columns)) for (const pg of pages(saved.columns)) if (Array.isArray(saved.columns[pg])) p.columns[pg] = saved.columns[pg].filter((c) => typeof c === 'string');
  p.widths = {};
  if (plain(saved.widths)) {
    for (const pg of pages(saved.widths)) {
      if (!plain(saved.widths[pg])) continue;
      p.widths[pg] = {};
      for (const [c, w] of Object.entries(saved.widths[pg])) if (Number.isFinite(w) && w >= 24 && w <= 4000) p.widths[pg][c] = Math.round(w);
    }
  }
  p.sort = {};
  if (plain(saved.sort)) for (const pg of pages(saved.sort)) if (plain(saved.sort[pg]) && typeof saved.sort[pg].id === 'string') p.sort[pg] = { id: saved.sort[pg].id, dir: saved.sort[pg].dir < 0 ? -1 : 1 };
  return p;
}

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
      this.prefs = sanitizePrefs(await this.ctx.storage.get('prefs', null));
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

    // ---- tabs along the top
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
    this.lastProcView = 'processes';
    this.navItems = new Map();
    const mkTab = (id) => {
      const p = this.pages[id];
      const gear = id === 'settings';
      const label = h('span', { class: ['tm-tab-label', gear && 'sr-only'] }, this.tabTitle(id));
      const btn = h(
        'button',
        { class: ['tm-tab', gear && 'tm-tab-gear'], role: 'tab', 'aria-selected': 'false', 'data-tip': gear ? p.title() : null, dataset: { page: id }, onclick: () => this.go(id === 'processes' ? this.lastProcView : id, { focus: false }) },
        gear ? icon(p.icon) : null,
        label,
      );
      btn._label = label;
      this.navItems.set(id, btn);
      return btn;
    };
    this.navList = h('div', { class: 'tm-tablist', role: 'tablist', 'aria-label': t('nav.label') }, TABS.map(mkTab), h('span', { class: 'tm-tab-gap', 'aria-hidden': 'true' }), mkTab('settings'));
    this.nav = h('nav', { class: 'tm-tabbar', 'aria-label': t('nav.label') }, this.navList);
    this.navList.addEventListener('keydown', (e) => this._navKeys(e));

    // ---- Processes views: list, details, history
    this.viewBtns = new Map();
    this.views = h(
      'div',
      { class: 'tm-views', role: 'group', 'aria-label': t('views.label') },
      PROC_VIEWS.map((id) => {
        const b = h('button', { class: 'tm-view', 'aria-pressed': 'false', dataset: { view: id }, onclick: () => this.go(id, { focus: false }) }, t(`views.${id}`));
        this.viewBtns.set(id, b);
        return b;
      }),
    );

    // ---- main area
    this.titleEl = h('h1', { class: 'tm-title ellipsis' });
    this.cmdBar = h('div', { class: 'tm-cmds', role: 'toolbar', 'aria-label': t('cmd.toolbar') });
    this.head = h('header', { class: 'tm-head' }, this.titleEl, this.views, this.cmdBar);
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
    this.root = h('div', { class: 'tm-root' }, this.nav, this.main);
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
      this.errorText.textContent = this.t('err.data', { msg: errText(this.t, err) });
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
    // Tab / Shift+Tab cycle inside this window (and inside an open dialog): focus must never move
    // into another window's DOM, which would also activate that window.
    win.el.addEventListener('keydown', (e) => this._wrapTab(e));
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
      const tab = tabOf(id);
      if (tab === 'processes') this.lastProcView = id;
      for (const [k, b] of this.navItems) {
        b.classList.toggle('selected', k === tab);
        b.setAttribute('aria-selected', String(k === tab));
        b.tabIndex = k === tab ? 0 : -1;
      }
      this.views.hidden = tab !== 'processes';
      for (const [k, b] of this.viewBtns) {
        b.classList.toggle('selected', k === id);
        b.setAttribute('aria-pressed', String(k === id));
      }
      this.titleEl.textContent = p.title();
      this.store.setNeeds(p.needs || {});
      p.onSearch?.(this.query);
      p.show?.();
      if (this.store.perf) p.update?.(this.store);
      this.renderCommands();
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

  // ------------------------------------------------------------------ tabs
  tabTitle(id) {
    return this.t(id === 'startup' ? 'nav.startupTab' : `nav.${id}`);
  }
  // Kept for callers of the old navigation pane: the tab bar has no collapsed state.
  applyNav() {}
  toggleNav() {}
  _layout() {
    this._fitCommands();
  }
  _navKeys(e) {
    if (e.defaultPrevented) return;
    const items = [...this.navItems.values()];
    const i = items.indexOf(document.activeElement);
    if (i < 0) return;
    let j = null;
    if (e.key === 'ArrowRight') j = (i + 1) % items.length;
    else if (e.key === 'ArrowLeft') j = (i - 1 + items.length) % items.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = items.length - 1;
    if (j == null) return;
    e.preventDefault();
    items[j].focus();
  }

  _keys(e) {
    if (e.defaultPrevented) return; // handled by an open menu
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

  _wrapTab(e) {
    if (e.key !== 'Tab' || e.ctrlKey || e.altKey || e.metaKey || e.defaultPrevented) return;
    const layers = [...this.win.el.querySelectorAll(':scope > .dialog-layer:not(.closing)')];
    const scope = layers[layers.length - 1] || this.win.el;
    const list = [...scope.querySelectorAll('a[href], button, input, select, textarea, [tabindex]')].filter(
      (el) => el.tabIndex >= 0 && !el.disabled && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden' && (scope !== this.win.el || !el.closest('.dialog-layer')),
    );
    if (!list.length) return;
    const a = document.activeElement;
    const outside = !scope.contains(a);
    // Focus on something outside the list (e.g. a scrollable box Chromium made focusable): is any
    // tab stop left in that direction?
    const FOLLOWING = Node.DOCUMENT_POSITION_FOLLOWING;
    const after = list.filter((el) => el !== a && a.compareDocumentPosition(el) & FOLLOWING);
    const atEnd = e.shiftKey ? after.length === list.length - (list.includes(a) ? 1 : 0) : after.length === 0;
    if (outside || atEnd) {
      e.preventDefault();
      (e.shiftKey ? list[list.length - 1] : list[0]).focus();
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
    this.nav.setAttribute('aria-label', t('nav.label'));
    this.navList.setAttribute('aria-label', t('nav.label'));
    this.views.setAttribute('aria-label', t('views.label'));
    for (const [id, b] of this.viewBtns) b.textContent = t(`views.${id}`);
    this.cmdBar.setAttribute('aria-label', t('cmd.toolbar'));
    this.errorBar.querySelector('.btn').textContent = t('common.retry');
    this.searchBox.querySelector('.tm-search-clear').setAttribute('aria-label', t('search.clear'));
    for (const [id, b] of this.navItems) {
      b._label.textContent = this.tabTitle(id);
      if (id === 'settings') b.dataset.tip = this.pages[id].title();
    }
    for (const p of Object.values(this.pages)) {
      p.el.setAttribute('aria-label', p.title());
      p.relabel?.();
    }
    if (this.current) this.titleEl.textContent = this.current.title();
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
    this.closed = true;
    this.store.dispose();
    this._ro?.disconnect();
    for (const off of this.offs) off();
    for (const p of Object.values(this.pages)) p.destroy?.();
  }
}
