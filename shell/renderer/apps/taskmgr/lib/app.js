// System Monitor window: a permanent strip of four meters along the top (processor, memory, disk,
// network: value + sparkline; a click opens the Performances detail on that device), a toolbar
// (search on the left, the "Show:" view menu, the page's commands, Settings), and the pages
// themselves. Pages implement:
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
// The "Show:" menu. Details and History are other views of the processes.
export const VIEWS = ['processes', 'details', 'history', 'startup', 'services', 'users'];
export const PROC_VIEWS = ['processes', 'details', 'history'];
export const METERS = ['cpu', 'mem', 'disk', 'net'];
const SPARK_W = 64;
const SPARK_H = 22;
const SVGNS = 'http://www.w3.org/2000/svg';

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

    // ---- search, on the left of the toolbar
    this.search = h('input', {
      class: 'input tm-search-input',
      type: 'search',
      spellcheck: false,
      'aria-label': t('search.label'),
      placeholder: t('search.placeholder'),
    });
    const clearBtn = h('button', { class: 'tm-search-clear', tabindex: '-1', 'aria-label': t('search.clear'), onclick: () => this.setQuery('', true) }, icon('x', { size: 12 }));
    this.searchBox = h('div', { class: 'tm-search' }, icon('magnifying-glass', { size: 14, class: 'tm-search-ic' }), this.search, clearBtn);
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

    // ---- the four meters
    this.meters = new Map();
    const mkMeter = (id) => {
      const label = h('span', { class: 'tm-meter-label' }, t(`meter.${id}`));
      const val = h('span', { class: 'tm-meter-val' }, '—');
      const svg = document.createElementNS(SVGNS, 'svg');
      svg.setAttribute('viewBox', `0 0 ${SPARK_W} ${SPARK_H}`);
      svg.setAttribute('preserveAspectRatio', 'none');
      svg.setAttribute('aria-hidden', 'true');
      svg.classList.add('tm-spark');
      const area = document.createElementNS(SVGNS, 'path');
      area.classList.add('tm-spark-area');
      const line = document.createElementNS(SVGNS, 'path');
      line.classList.add('tm-spark-line');
      svg.append(area, line);
      const b = h(
        'button',
        { class: 'tm-meter', type: 'button', 'aria-pressed': 'false', 'data-tip': t('meter.open'), 'data-tip-pos': 'below', dataset: { meter: id }, onclick: () => this.openDevice(id) },
        h('span', { class: 'tm-meter-text' }, label, val),
        svg,
      );
      Object.assign(b, { _label: label, _val: val, _area: area, _line: line });
      this.meters.set(id, b);
      return b;
    };
    this.meterBar = h('div', { class: 'tm-meters', role: 'group', 'aria-label': t('meter.label') }, METERS.map(mkMeter));
    this.meterBar.addEventListener('keydown', (e) => {
      const items = [...this.meters.values()];
      const i = items.indexOf(document.activeElement);
      if (i < 0) return;
      const j = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: items.length - 1 }[e.key];
      if (j == null) return;
      e.preventDefault();
      items[(j + items.length) % items.length].focus();
    });

    // ---- "Show:" view menu, Settings
    this.viewLabel = h('span', { class: 'tm-viewbtn-label' });
    this.viewPre = h('span', { class: 'tm-viewbtn-pre' }, t('views.show'));
    this.viewBtn = h(
      'button',
      { class: 'btn subtle tm-viewbtn', type: 'button', 'aria-haspopup': 'menu', onclick: (e) => this.viewMenu(e.currentTarget) },
      this.viewPre,
      this.viewLabel,
      icon('caret-down', { size: 12, class: 'tm-cmd-chev' }),
    );
    this.settingsBtn = h(
      'button',
      { class: 'btn subtle tm-settings-btn', type: 'button', 'aria-pressed': 'false', 'aria-label': this.pages.settings.title(), 'data-tip': this.pages.settings.title(), 'data-tip-pos': 'below', onclick: () => this.go('settings', { focus: false }) },
      icon('gear-six'),
    );

    // ---- main area
    this.titleEl = h('h1', { class: 'tm-title ellipsis' });
    this.cmdBar = h('div', { class: 'tm-cmds', role: 'toolbar', 'aria-label': t('cmd.toolbar') });
    this.head = h('header', { class: 'tm-head' }, this.titleEl, this.searchBox, this.viewBtn, this.cmdBar, this.settingsBtn);
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
    this.root = h('div', { class: 'tm-root' }, this.meterBar, this.main);
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
      if (PROC_VIEWS.includes(id)) this.lastProcView = id;
      this.viewLabel.textContent = this.tabTitle(id);
      this.settingsBtn.setAttribute('aria-pressed', String(id === 'settings'));
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
    this.updateMeters();
    this.renderCommands();
  }

  // ------------------------------------------------------------------ meters
  meterDevice(kind) {
    const perf = this.store.perf;
    if (!perf) return null;
    if (kind === 'cpu' || kind === 'mem') return { id: kind };
    if (kind === 'disk') return perf.disks[0] ? { id: `disk:${perf.disks[0].name}`, d: perf.disks[0] } : null;
    const n = perf.net.find((x) => x.type !== 'loopback' && x.iface !== 'lo') || perf.net[0];
    return n ? { id: `net:${n.iface}`, n } : null;
  }
  updateMeters() {
    const perf = this.store.perf;
    if (!perf) return;
    const { fmt, store } = this;
    const series = (k) => store.series.get(k) || [];
    const sum = (a, b) => a.map(([tt, v], i) => [tt, v + (b[i]?.[1] || 0)]);
    const perfDev = this.current?.id === 'performance' ? this.pages.performance.selected || '' : '';
    for (const [kind, b] of this.meters) {
      const dev = this.meterDevice(kind);
      let text = '—';
      let pts = [];
      let max = 100;
      if (kind === 'cpu') {
        text = fmt.pct(perf.cpu.total);
        pts = series('cpu');
      } else if (kind === 'mem') {
        const total = perf.mem.total || 1;
        text = fmt.pct((perf.mem.used / total) * 100);
        pts = series('mem');
        max = total;
      } else if (kind === 'disk' && dev) {
        text = fmt.pct(dev.d.busyPct);
        pts = series(`${dev.id}:busy`);
      } else if (kind === 'net' && dev) {
        text = fmt.bits((dev.n.rxBps + dev.n.txBps) * 8);
        pts = sum(series(`${dev.id}:rx`), series(`${dev.id}:tx`));
        max = Math.max(1, ...pts.map((x) => x[1]));
      }
      if (b._val.textContent !== text) b._val.textContent = text;
      b.setAttribute('aria-label', `${b._label.textContent} ${text}`);
      const last = pts.slice(-30);
      if (last.length > 1) {
        const step = SPARK_W / 29;
        const x0 = SPARK_W - (last.length - 1) * step;
        const y = (v) => (SPARK_H - 1.5 - Math.max(0, Math.min(1, v / max)) * (SPARK_H - 3)).toFixed(1);
        const d = last.map(([, v], i) => `${i ? 'L' : 'M'}${(x0 + i * step).toFixed(1)} ${y(v)}`).join(' ');
        b._line.setAttribute('d', d);
        b._area.setAttribute('d', `${d} L${SPARK_W} ${SPARK_H} L${x0.toFixed(1)} ${SPARK_H} Z`);
      }
      const on = !!dev && perfDev === dev.id;
      b.classList.toggle('selected', on);
      b.setAttribute('aria-pressed', String(on));
    }
  }
  // A meter opens the Performances detail on its device.
  openDevice(kind) {
    this.go('performance', { focus: false });
    const dev = this.meterDevice(kind);
    if (dev) this.pages.performance.select(dev.id);
    this.updateMeters();
  }

  viewMenu(at) {
    const { t } = this;
    const cur = this.current?.id;
    const item = (id) => ({ label: this.tabTitle(id), checked: cur === id, action: () => this.go(id) });
    at.classList.add('open');
    const p = this.menu(at, [...VIEWS.map(item), '-', item('performance'), item('settings')]);
    Promise.resolve(p).finally(() => at.classList.remove('open'));
    return p;
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
    let cmds = (this.current?.commands?.() || []).filter((c) => c && !c.hidden);
    // "Run a command" and a page's View menu live in the "…" menu, at its top.
    const run = cmds.find((c) => c.id === 'run');
    const view = cmds.find((c) => c.id === 'view');
    if (run || view) {
      cmds = cmds.filter((c) => c !== run && c !== view);
      const head = () => [run && { label: run.label, icon: 'terminal-window', disabled: !!run.disabled, action: run.action }, run && view && '-', ...(view ? view.menu() : [])].filter(Boolean);
      const more = cmds.find((c) => c.id === 'more');
      if (more) {
        const own = more.menu;
        cmds = cmds.map((c) => (c === more ? { ...c, menu: () => [...head(), '-', ...own()] } : c));
      } else cmds.push({ id: 'more', icon: 'dots-three', label: this.t('cmd.more'), menu: head });
    }
    const sig = JSON.stringify(cmds.map((c) => [c.id, c.label, !!c.disabled, c.pressed ?? null, c.icon]));
    if (sig === this._cmdSig) return;
    this._cmdSig = sig;
    const focusedId = this.cmdBar.contains(document.activeElement) ? document.activeElement.dataset.cmd : null;
    this.cmdBar.textContent = '';
    for (const c of cmds) {
      const btn = h(
        'button',
        {
          class: ['btn', 'subtle', 'tm-cmd', c.menu && 'has-menu', c.id === 'more' && 'tm-cmd-more'],
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
        c.icon ? icon(c.id === 'more' ? 'dots-three' : c.icon, { filled: !!c.pressed }) : null,
        c.id === 'more' ? null : h('span', { class: 'tm-cmd-label' }, c.label),
        c.menu && c.id !== 'more' ? icon('chevron_down', { size: 12, class: 'tm-cmd-chev' }) : null,
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

  // ------------------------------------------------------------------ views
  tabTitle(id) {
    return this.t(id === 'startup' ? 'nav.startupTab' : `nav.${id}`);
  }
  // Kept for callers of the old navigation pane: there is no navigation pane any more.
  applyNav() {}
  toggleNav() {}
  _layout() {
    this._fitCommands();
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
    this.meterBar.setAttribute('aria-label', t('meter.label'));
    for (const [id, b] of this.meters) {
      b._label.textContent = t(`meter.${id}`);
      b.dataset.tip = t('meter.open');
    }
    this.viewPre.textContent = t('views.show');
    if (this.current) this.viewLabel.textContent = this.tabTitle(this.current.id);
    this.settingsBtn.setAttribute('aria-label', this.pages.settings.title());
    this.settingsBtn.dataset.tip = this.pages.settings.title();
    this.cmdBar.setAttribute('aria-label', t('cmd.toolbar'));
    this.errorBar.querySelector('.btn').textContent = t('common.retry');
    this.searchBox.querySelector('.tm-search-clear').setAttribute('aria-label', t('search.clear'));
    this.updateMeters();
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
