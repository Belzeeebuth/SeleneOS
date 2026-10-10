// Aurora Calculator — a Windows 11 style calculator.
//   Standard (immediate execution), Scientific (precedence, functions), Programmer (64-bit two's
//   complement, HEX/DEC/OCT/BIN, bitwise), Date calculation and 12 unit converters.
// Layout: header (hamburger, mode title, keep-on-top), mode view, history/memory pane docked on the
// right when the window is >= 560px wide, otherwise shown as a flyout.
import { Engine, STD_PREC, SCI_PREC } from './lib/engine.js';
import { decimalSystem } from './lib/decimal.js';
import { programmerSystem, parseProgrammer, WORDS, SHIFTS } from './lib/programmer.js';
import { parseLoose, CalcError } from './lib/num.js';
import { CATEGORIES } from './lib/units.js';
import { createCalcView } from './ui/calc.js';
import { createDateView } from './ui/date.js';
import { createConverterView } from './ui/converter.js';

const CALC_MODES = [
  { id: 'standard', icon: 'calculator' },
  { id: 'scientific', icon: 'math_formula' },
  { id: 'programmer', icon: 'code' },
  { id: 'date', icon: 'calendar_ltr' },
];
const MODE_IDS = [...CALC_MODES.map((m) => m.id), ...CATEGORIES.map((c) => `conv-${c.id}`)];
const DOCK_MIN = 560;
const COMPACT = { width: 296, height: 400, minWidth: 220, minHeight: 300 };
const MAX_HISTORY = 100;
const reduceMotion = () => document.documentElement.dataset.animations === 'off';

export default {
  async launch(ctx) {
    const app = new CalculatorApp(ctx);
    await app.start();
    return { onFocus: () => app.onFocus() };
  },
};

class CalculatorApp {
  constructor(ctx) {
    this.ctx = ctx;
    this.win = ctx.win;
    this.S = {
      mode: 'standard',
      angle: 'deg',
      fe: false,
      prog: { radix: 10, bits: 64, shift: 'arith', keypad: 'full' },
      conv: {},
      date: { mode: 'diff' },
    };
    this.history = { standard: [], scientific: [] };
    this.memStore = { dec: [], prog: [] };
    this.convState = {};
    this.dateState = null;
    this.paneTab = 'history';
    this.compact = false;
    this.view = null;
    this.navOpen = false;
    this.paneFly = null;
  }

  // ------------------------------------------------------------ startup
  async start() {
    const saved = await this.ctx.storage.get('state', null).catch(() => null);
    this.restore(saved);
    const S = this.S;
    this.engines = {
      standard: new Engine(decimalSystem({ angle: S.angle }), { prec: STD_PREC }),
      scientific: new Engine(decimalSystem({ angle: S.angle }), { prec: SCI_PREC }),
      programmer: new Engine(programmerSystem(S.prog), { prec: SCI_PREC }),
    };
    for (const k of ['standard', 'scientific']) {
      this.engines[k].onHistory = (entry) => {
        this.history[k].unshift(entry);
        if (this.history[k].length > MAX_HISTORY) this.history[k].length = MAX_HISTORY;
        this.renderPane();
      };
    }
    this.build();
    this.setMode(S.mode, { animate: false });

    this.onKey = (e) => this.handleKey(e);
    document.addEventListener('keydown', this.onKey);
    this.ro = new ResizeObserver(() => this.layout());
    this.ro.observe(this.win.body);
    this.ctx.onLangChange(() => this.rebuild());
    this.ctx.onClose(() => {
      document.removeEventListener('keydown', this.onKey);
      this.ro.disconnect();
      clearTimeout(this.persistTimer);
      this.view?.destroy?.();
    });
    setTimeout(() => this.root.focus({ preventScroll: true }), 0);
  }

  restore(saved) {
    if (!saved || typeof saved !== 'object') return;
    const S = this.S;
    if (MODE_IDS.includes(saved.mode)) S.mode = saved.mode;
    if (['deg', 'rad', 'grad'].includes(saved.angle)) S.angle = saved.angle;
    S.fe = !!saved.fe;
    const p = saved.prog || {};
    if ([16, 10, 8, 2].includes(p.radix)) S.prog.radix = p.radix;
    if (WORDS.some((w) => w.bits === p.bits)) S.prog.bits = p.bits;
    if (SHIFTS.includes(p.shift)) S.prog.shift = p.shift;
    if (p.keypad === 'bits' || p.keypad === 'full') S.prog.keypad = p.keypad;
    if (saved.conv && typeof saved.conv === 'object') {
      for (const [k, v] of Object.entries(saved.conv)) if (v && typeof v.from === 'string' && typeof v.to === 'string') S.conv[k] = { from: v.from, to: v.to };
    }
    if (saved.date?.mode === 'add' || saved.date?.mode === 'diff') S.date.mode = saved.date.mode;
  }

  persist() {
    clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.ctx.storage.set('state', this.S).catch((err) => console.warn('[calculator] could not save settings', err));
    }, 250);
  }

  // ------------------------------------------------------------ DOM
  build() {
    const { h, icon, t } = this.ctx;
    this.titleEl = h('h1', { class: 'calc-title', id: `${this.win.id}-calc-title` });
    this.compactBtn = h(
      'button',
      { class: 'calc-iconbtn calc-compact-btn', type: 'button', 'data-key': 'compact', 'aria-label': t('compact.enter'), 'data-tip': t('compact.enterTip'), onclick: () => this.setCompact(true) },
      icon('picture_in_picture_enter', { size: 16 }),
    );
    this.backBtn = h(
      'button',
      { class: 'calc-iconbtn calc-back-full', type: 'button', 'data-key': 'fullview', 'aria-label': t('compact.exit'), 'data-tip': t('compact.exitTip'), onclick: () => this.setCompact(false) },
      icon('picture_in_picture_exit', { size: 16 }),
    );
    this.historyBtn = h(
      'button',
      { class: 'calc-iconbtn calc-history-btn', type: 'button', 'data-key': 'history', 'aria-label': t('history.open'), 'data-tip': t('history.openTip'), onclick: () => this.togglePaneFlyout('history') },
      icon('history', { size: 16 }),
    );
    this.hamburger = h(
      'button',
      { class: 'calc-iconbtn calc-ham', type: 'button', 'data-key': 'nav', 'aria-label': t('nav.open'), 'aria-expanded': 'false', 'data-tip': t('nav.open'), onclick: () => this.openNav() },
      icon('line_horizontal_3', { size: 16 }),
    );
    this.header = h('header', { class: 'calc-header' }, this.backBtn, this.hamburger, this.titleEl, this.compactBtn, h('div', { class: 'grow' }), this.historyBtn);
    this.stage = h('div', { class: 'calc-stage', role: 'region', 'aria-labelledby': this.titleEl.id });
    this.main = h('div', { class: 'calc-main' }, this.header, this.stage);
    this.pane = h('aside', { class: 'calc-pane', 'aria-label': t('pane.label') });
    this.buildNav();
    this.root = h('div', { class: 'calc', tabindex: '-1' }, this.main, this.pane, this.navLayer);
    this.win.body.appendChild(this.root);
  }

  buildNav() {
    const { h, icon, t } = this.ctx;
    const item = (id, iconName, label) =>
      h(
        'button',
        { class: 'calc-nav-item', type: 'button', role: 'menuitemradio', 'data-mode': id, onclick: () => this.setMode(id, { fromNav: true }) },
        icon(iconName, { size: 16 }),
        h('span', { class: 'ellipsis' }, label),
      );
    this.navItems = [
      ...CALC_MODES.map((m) => item(m.id, m.icon, t(`mode.${m.id}`))),
      ...CATEGORIES.map((c) => item(`conv-${c.id}`, c.icon, t(`conv.cat.${c.id}`))),
    ];
    const navHam = h(
      'button',
      { class: 'calc-iconbtn calc-ham', type: 'button', 'aria-label': t('nav.close'), onclick: () => this.closeNav() },
      icon('line_horizontal_3', { size: 16 }),
    );
    const about = h('button', { class: 'calc-nav-item', type: 'button', 'data-mode': 'about', onclick: () => (this.closeNav(), this.showAbout()) }, icon('info', { size: 16 }), h('span', { class: 'ellipsis' }, t('nav.about')));
    this.nav = h(
      'nav',
      { class: 'calc-nav', 'aria-label': t('nav.label'), role: 'menu' },
      h('div', { class: 'calc-nav-top' }, navHam),
      h(
        'div',
        { class: 'calc-nav-list' },
        h('div', { class: 'calc-nav-header' }, t('nav.calculator')),
        this.navItems.slice(0, CALC_MODES.length),
        h('div', { class: 'calc-nav-header' }, t('nav.converter')),
        this.navItems.slice(CALC_MODES.length),
      ),
      h('div', { class: 'calc-nav-foot' }, about),
    );
    this.nav.addEventListener('keydown', (e) => {
      const items = [...this.nav.querySelectorAll('.calc-nav-item')];
      const i = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
        n?.focus();
      } else if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        items[e.key === 'Home' ? 0 : items.length - 1]?.focus();
      }
    });
    const scrim = h('div', { class: 'calc-nav-scrim', onclick: () => this.closeNav() });
    this.navLayer = h('div', { class: 'calc-navlayer' }, scrim, this.nav);
  }

  rebuild() {
    this.closeNav(true);
    this.closePaneFlyout(true);
    this.view?.destroy?.();
    this.view = null;
    const wasCompact = this.compact;
    this.root.remove();
    this.build();
    this.root.classList.toggle('compact', wasCompact);
    this.setMode(this.S.mode, { animate: false });
  }

  flyoutHost() {
    return this.root;
  }

  // ------------------------------------------------------------ modes
  setMode(id, { animate = true, fromNav = false } = {}) {
    if (!MODE_IDS.includes(id)) id = 'standard';
    const { t } = this.ctx;
    if (fromNav) this.closeNav();
    if (this.compact && id !== 'standard') this.setCompact(false);
    this.closePaneFlyout(true);
    this.view?.destroy?.();
    this.S.mode = id;
    const env = { ctx: this.ctx, S: this.S, app: this };
    let view;
    try {
      if (id === 'standard' || id === 'scientific' || id === 'programmer') view = createCalcView(env, id);
      else if (id === 'date') view = createDateView(env);
      else view = createConverterView(env, id.slice(5));
    } catch (err) {
      console.error('[calculator] could not open mode', id, err);
      this.reportError(err);
      if (id !== 'standard') return this.setMode('standard', { animate: false });
      throw err;
    }
    this.view = view;
    this.stage.replaceChildren(view.el);
    this.root.dataset.mode = id;
    this.titleEl.textContent = id.startsWith('conv-') ? t(`conv.cat.${id.slice(5)}`) : t(`mode.${id}`);
    this.compactBtn.hidden = id !== 'standard';
    for (const it of this.navItems) {
      const sel = it.dataset.mode === id;
      it.classList.toggle('selected', sel);
      it.setAttribute('aria-checked', String(sel));
    }
    this.persist();
    this.layout();
    view.refresh?.();
    this.renderPane();
    if (animate && !reduceMotion()) {
      view.el.animate([{ opacity: 0, transform: 'translateY(16px)' }, { opacity: 1, transform: 'none' }], { duration: 280, easing: 'cubic-bezier(0.1, 0.9, 0.2, 1)' });
      this.titleEl.animate([{ opacity: 0, transform: 'translateX(-8px)' }, { opacity: 1, transform: 'none' }], { duration: 250, easing: 'cubic-bezier(0.1, 0.9, 0.2, 1)' });
    }
    if (fromNav) setTimeout(() => this.root.focus({ preventScroll: true }), 0);
  }

  isDocked() {
    return !this.compact && !!this.view?.pane && this.win.body.clientWidth >= DOCK_MIN;
  }

  layout() {
    if (!this.view) return;
    const docked = this.isDocked();
    const wasDocked = this.root.classList.contains('docked');
    this.root.classList.toggle('docked', docked);
    this.root.classList.toggle('narrow', this.win.body.clientWidth < 400);
    this.historyBtn.hidden = docked || this.compact || !this.view.historyKind;
    if (docked !== wasDocked) {
      this.closePaneFlyout(true);
      this.renderPane();
      this.view.refresh?.();
    }
    this.view.layout?.();
  }

  onFocus() {
    if (!this.root.contains(document.activeElement)) this.root.focus({ preventScroll: true });
  }

  // ------------------------------------------------------------ navigation pane
  openNav() {
    if (this.navOpen) return this.closeNav();
    this.navOpen = true;
    this.closePaneFlyout(true);
    this.view?.closeFlyouts?.();
    this.root.classList.add('nav-open');
    this.hamburger.setAttribute('aria-expanded', 'true');
    const sel = this.navItems.find((i) => i.classList.contains('selected')) || this.navItems[0];
    setTimeout(() => {
      sel.focus({ preventScroll: true });
      sel.scrollIntoView({ block: 'nearest' });
    }, 30);
  }

  closeNav(immediate = false) {
    if (!this.navOpen) return;
    this.navOpen = false;
    this.root.classList.remove('nav-open');
    this.hamburger.setAttribute('aria-expanded', 'false');
    if (!immediate) this.root.focus({ preventScroll: true });
  }

  showAbout() {
    const { h, t, ui } = this.ctx;
    ui.dialog({
      title: t('about.title'),
      parent: this.win,
      body: h(
        'div',
        { class: 'calc-about' },
        h('img', { src: this.ctx.appUrl('icon.svg'), alt: '', width: 56, height: 56 }),
        h('div', null, h('div', { class: 'body-strong' }, t('app.name')), h('div', { class: 'caption text-2' }, t('about.version', { v: '1.0' })), h('p', { class: 'caption text-2' }, t('about.text'))),
      ),
    });
  }

  // ------------------------------------------------------------ history & memory
  memoryList() {
    return this.memStore[this.view?.memoryKind || 'dec'];
  }

  memOps() {
    const v = this.view;
    if (v?.memoryKind === 'prog') {
      const sys = v.engine.sys;
      return { add: (a, b) => sys.wrap(a + b), sub: (a, b) => sys.wrap(a - b), neg: (a) => sys.wrap(-a) };
    }
    return { add: (a, b) => a.add(b), sub: (a, b) => a.sub(b), neg: (a) => a.neg() };
  }

  memoryWrap() {
    const sys = this.engines.programmer.sys;
    this.memStore.prog = this.memStore.prog.map((v) => sys.wrap(v));
    this.renderPane();
  }

  memory(op, index = 0) {
    const view = this.view;
    if (!view?.engine) return;
    const eng = view.engine;
    if (eng.error && op !== 'mc') return;
    const list = this.memoryList();
    const ops = this.memOps();
    try {
      const v = view.value();
      switch (op) {
        case 'ms':
          list.unshift(v);
          break;
        case 'mplus':
          if (list.length) list[index] = ops.add(list[index], v);
          else list.unshift(v);
          break;
        case 'mminus':
          if (list.length) list[index] = ops.sub(list[index], v);
          else list.unshift(ops.neg(v));
          break;
        case 'mr':
          if (list.length) eng.setValue(list[index]);
          break;
        case 'mc':
          list.length = 0;
          break;
        case 'mdel':
          list.splice(index, 1);
          break;
        default:
      }
    } catch (err) {
      if (!(err instanceof CalcError || err?.calcError)) throw err;
      this.ctx.ui.alert(this.ctx.t(`err.${err.code}`), { title: this.ctx.t('app.name'), parent: this.win });
    }
    if (op !== 'mr' && op !== 'mc' && op !== 'mdel') eng.freeze();
    view.refresh();
    this.renderPane();
  }

  clearHistory() {
    const k = this.view?.historyKind;
    if (!k) return;
    this.history[k] = [];
    this.renderPane();
  }

  paneTabs() {
    const p = this.view?.pane;
    if (p === 'both') return ['history', 'memory'];
    if (p === 'memory') return ['memory'];
    return [];
  }

  renderPane() {
    const { h, t } = this.ctx;
    const docked = this.isDocked();
    this.pane.textContent = '';
    this.pane.hidden = !docked;
    if (docked) {
      const tabs = this.paneTabs();
      if (!tabs.includes(this.paneTab)) this.paneTab = tabs[0];
      const tabBar = h(
        'div',
        { class: 'calc-pane-tabs', role: 'tablist' },
        tabs.map((tab) =>
          h(
            'button',
            {
              class: ['calc-pane-tab', tab === this.paneTab && 'selected'],
              type: 'button',
              role: 'tab',
              'data-tab': tab,
              'aria-selected': String(tab === this.paneTab),
              onclick: () => {
                this.paneTab = tab;
                this.renderPane();
              },
            },
            t(`pane.${tab}`),
          ),
        ),
      );
      this.pane.append(tabBar, this.buildList(this.paneTab, false));
    }
    if (this.paneFly) this.fillPaneFlyout();
  }

  buildList(tab, inFlyout) {
    const { h, icon, t, ui } = this.ctx;
    const view = this.view;
    const wrap = h('div', { class: 'calc-plist-wrap', 'data-list': tab });
    const list = h('div', { class: 'calc-plist', role: 'list' });
    let count = 0;
    if (tab === 'history') {
      const items = this.history[view?.historyKind] || [];
      count = items.length;
      if (!items.length) list.append(h('div', { class: 'calc-pempty' }, t('history.empty')));
      items.forEach((it, i) => {
        const row = h(
          'button',
          {
            class: 'calc-hitem',
            type: 'button',
            role: 'listitem',
            onclick: () => {
              view.recall(it);
              if (inFlyout) this.closePaneFlyout();
            },
            oncontextmenu: (e) =>
              ui.menu(e, [
                {
                  label: t('history.delete'),
                  icon: 'delete',
                  action: () => {
                    this.history[view.historyKind].splice(i, 1);
                    this.renderPane();
                  },
                },
              ]),
          },
          h('div', { class: 'calc-hitem-expr' }, view.renderExpr([...it.items, { k: 'eq' }])),
          h('div', { class: 'calc-hitem-val' }, view.fmt(it.v)),
        );
        list.append(row);
      });
    } else {
      const items = this.memoryList();
      count = items.length;
      if (!items.length) list.append(h('div', { class: 'calc-pempty' }, t('memory.empty')));
      items.forEach((v, i) => {
        const act = (op, label, aria) =>
          h(
            'button',
            {
              class: 'calc-mitem-btn',
              type: 'button',
              'aria-label': aria,
              'data-tip': aria,
              onclick: (e) => {
                e.stopPropagation();
                this.memory(op, i);
              },
            },
            label,
          );
        const row = h(
          'div',
          {
            class: 'calc-mitem',
            role: 'listitem',
            tabindex: '0',
            'data-index': String(i),
            onclick: () => {
              this.memory('mr', i);
              if (inFlyout) this.closePaneFlyout();
            },
            onkeydown: (e) => {
              if (e.key === 'Enter' && e.target === row) {
                e.preventDefault();
                e.stopPropagation();
                row.click();
              }
            },
            oncontextmenu: (e) =>
              ui.menu(e, [
                { label: t('memory.clearItem'), icon: 'delete', action: () => this.memory('mdel', i) },
                { label: t('memory.addItem'), action: () => this.memory('mplus', i) },
                { label: t('memory.subItem'), action: () => this.memory('mminus', i) },
              ]),
          },
          h('div', { class: 'calc-mitem-val' }, view.fmt(v)),
          h('div', { class: 'calc-mitem-actions' }, act('mdel', 'MC', t('memory.clearItem')), act('mplus', 'M+', t('memory.addItem')), act('mminus', 'M−', t('memory.subItem'))),
        );
        list.append(row);
      });
    }
    const trash = h(
      'button',
      {
        class: 'calc-iconbtn calc-ptrash',
        type: 'button',
        'data-key': tab === 'history' ? 'clear-history' : 'clear-memory',
        'aria-label': t(tab === 'history' ? 'history.clear' : 'memory.clear'),
        'data-tip': t(tab === 'history' ? 'history.clear' : 'memory.clear'),
        onclick: () => {
          if (tab === 'history') this.clearHistory();
          else this.memory('mc');
          if (inFlyout) this.closePaneFlyout();
        },
      },
      icon('delete', { size: 16 }),
    );
    trash.hidden = !count;
    wrap.append(list, h('div', { class: 'calc-pfoot' }, trash));
    return wrap;
  }

  togglePaneFlyout(tab) {
    if (this.paneFly && this.paneFly.tab === tab) return this.closePaneFlyout();
    this.openPaneFlyout(tab);
  }

  openPaneFlyout(tab) {
    if (!this.paneTabs().includes(tab)) return;
    if (this.isDocked()) {
      this.paneTab = tab;
      this.renderPane();
      return;
    }
    const { h } = this.ctx;
    this.closePaneFlyout(true);
    this.view?.closeFlyouts?.();
    const display = this.view.el.querySelector('.calc-display');
    const rr = this.root.getBoundingClientRect();
    const top = display ? display.getBoundingClientRect().bottom - rr.top : 120;
    const panel = h('div', { class: 'calc-panefly-panel', role: 'dialog', 'aria-label': this.ctx.t(`pane.${tab}`), tabindex: '-1' });
    const scrim = h('div', { class: 'calc-panefly-scrim', onclick: () => this.closePaneFlyout() });
    const layer = h('div', { class: 'calc-panefly', style: { '--fly-top': `${Math.round(top)}px` } }, scrim, panel);
    this.root.appendChild(layer);
    this.paneFly = { tab, layer, panel };
    this.fillPaneFlyout();
    this.historyBtn.classList.toggle('on', tab === 'history');
    setTimeout(() => (panel.querySelector('.calc-hitem, .calc-mitem') || panel).focus({ preventScroll: true }), 30);
  }

  fillPaneFlyout() {
    const f = this.paneFly;
    if (!f) return;
    f.panel.replaceChildren(this.buildList(f.tab, true));
  }

  closePaneFlyout(immediate = false) {
    const f = this.paneFly;
    if (!f) return;
    this.paneFly = null;
    this.historyBtn.classList.remove('on');
    if (immediate || reduceMotion()) f.layer.remove();
    else {
      f.layer.classList.add('closing');
      setTimeout(() => f.layer.remove(), 160);
    }
    if (!immediate) this.root.focus({ preventScroll: true });
  }

  // ------------------------------------------------------------ compact overlay (keep on top)
  setCompact(on) {
    on = !!on;
    if (on === this.compact) return;
    const win = this.win;
    if (on) {
      if (this.S.mode !== 'standard') this.setMode('standard', { animate: false });
      this.closeNav(true);
      this.closePaneFlyout(true);
      this.preCompact = { rect: win.rect(), minWidth: win.opts.minWidth, minHeight: win.opts.minHeight, maximized: win.isMaximized?.() || win.state === 'maximized' };
      if (this.preCompact.maximized) win.restore();
      win.opts.minWidth = COMPACT.minWidth;
      win.opts.minHeight = COMPACT.minHeight;
      this.compact = true;
      this.root.classList.add('compact');
      const r = win.rect();
      win.setRect({ x: r.x + Math.max(0, r.width - COMPACT.width), y: r.y, width: COMPACT.width, height: COMPACT.height }, true);
      this.setOnTop(true);
    } else {
      const p = this.preCompact || {};
      win.opts.minWidth = p.minWidth ?? 320;
      win.opts.minHeight = p.minHeight ?? 480;
      this.compact = false;
      this.root.classList.remove('compact');
      this.setOnTop(false);
      if (p.rect) win.setRect(p.rect, true);
      if (p.maximized) win.maximize();
    }
    this.layout();
    this.renderPane();
    this.view?.refresh?.();
    if (!reduceMotion()) this.view?.el.animate([{ opacity: 0.4 }, { opacity: 1 }], { duration: 200, easing: 'linear' });
    setTimeout(() => (on ? this.backBtn : this.compactBtn).focus({ preventScroll: true }), 0);
  }

  setOnTop(on) {
    const win = this.win;
    if (typeof win.setAlwaysOnTop === 'function') {
      win.setAlwaysOnTop(on);
      return;
    }
    // wm honours win.alwaysOnTop when computing z-order on focus; apply it right away too.
    win.alwaysOnTop = on;
    const z = Number(win.el.style.zIndex) || 0;
    const base = z % 100000;
    win.el.style.zIndex = String((on ? 100000 : 0) + base);
    win.el.classList.toggle('calc-on-top', on);
    this.ctx.shell?.wm?.emit?.('change', win);
  }

  // ------------------------------------------------------------ clipboard
  async copy() {
    const s = this.view?.copyText?.();
    if (s == null || s === '') return;
    try {
      await this.ctx.api.invoke('clipboard:writeText', s);
    } catch (err) {
      this.reportError(err);
    }
  }

  async paste() {
    let text = '';
    try {
      text = await this.ctx.api.invoke('clipboard:readText');
    } catch (err) {
      return this.reportError(err);
    }
    const view = this.view;
    if (!view) return;
    if (view.paste) {
      view.paste(text);
      return;
    }
    if (!view.engine) return;
    const v = view.memoryKind === 'prog' ? parseProgrammer(text, view.engine.sys) : parseLoose(text, this.ctx.lang);
    if (v == null) {
      const eng = view.engine;
      eng.clear();
      eng.error = 'invalid';
      eng.errorExpr = [];
      view.refresh();
      return;
    }
    view.setValue(v);
  }

  // ------------------------------------------------------------ keyboard
  handleKey(e) {
    const win = this.win;
    if (!(win.isFocused?.() ?? win.el.classList.contains('active'))) return;
    if (e.defaultPrevented || e.isComposing) return;
    const tgt = e.target;
    if (tgt && tgt !== document.body && !win.el.contains(tgt)) return;
    if (document.querySelector('body > .menu') || win.el.querySelector('.dialog-layer')) return;
    if (tgt?.matches?.('input, textarea, select, [contenteditable="true"]')) return;
    if (e.key === 'Escape') {
      if (this.navOpen) {
        e.preventDefault();
        this.closeNav();
        return;
      }
      if (this.paneFly) {
        e.preventDefault();
        this.closePaneFlyout();
        return;
      }
      if (this.view?.closeFlyouts?.()) {
        e.preventDefault();
        return;
      }
    }
    if (e.altKey && !e.ctrlKey && !e.metaKey) {
      const m = { 1: 'standard', 2: 'scientific', 4: 'programmer', 5: 'date' }[e.key];
      if (m) {
        e.preventDefault();
        this.setMode(m);
        return;
      }
      if (e.key === 'ArrowUp' && this.S.mode === 'standard') {
        e.preventDefault();
        this.setCompact(true);
        return;
      }
      if (e.key === 'ArrowDown' && this.compact) {
        e.preventDefault();
        this.setCompact(false);
        return;
      }
    }
    if (this.navOpen) return;
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === 'h' && !e.shiftKey) {
        e.preventDefault();
        if (this.view?.historyKind && !this.compact) this.togglePaneFlyout('history');
        return;
      }
      if (k === 'd' && e.shiftKey) {
        e.preventDefault();
        this.clearHistory();
        return;
      }
      if (k === 'c' && !e.shiftKey) {
        const sel = window.getSelection?.();
        if (sel && !sel.isCollapsed && this.root.contains(sel.anchorNode)) return; // let a text selection copy
        e.preventDefault();
        this.copy();
        return;
      }
      if (k === 'v' && !e.shiftKey) {
        e.preventDefault();
        this.paste();
        return;
      }
    }
    if (this.paneFly && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      const items = [...this.paneFly.panel.querySelectorAll('.calc-hitem, .calc-mitem')];
      const i = items.indexOf(document.activeElement);
      items[Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
      e.preventDefault();
      return;
    }
    if (this.view?.handleKey?.(e)) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  reportError(err) {
    const { t, ui } = this.ctx;
    ui.alert(t('err.unexpected', { msg: String(err?.message || err) }), { title: t('app.name'), parent: this.win });
  }
}
