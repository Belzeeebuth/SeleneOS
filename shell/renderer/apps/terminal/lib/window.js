// A Terminal window (Windows Terminal look & feel): tabs in the title bar, split panes, find,
// settings tab, profiles dropdown, keyboard shortcuts, context menus.
import { prefs } from './prefs.js';
import { bus } from './bus.js';
import { Session, loadXterm } from './session.js';
import { PaneTree } from './panes.js';
import { FindBar } from './find.js';
import { SettingsPage } from './settings.js';
import { resolveScheme, xtermTheme, rgba } from './schemes.js';
import { profileIcon, profileIconSvg } from './icons.js';

let envPromise = null;

function cap(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function shellQuote(p) {
  return /^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, "'\\''")}'`;
}

// "Ctrl+Shift+T" style combo for a keydown (letters by label, digits by position).
function comboOf(e) {
  const parts = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  let key = e.key;
  if (/^Digit[0-9]$/.test(e.code)) key = e.code.slice(5);
  else if (e.code === 'NumpadAdd') key = '+';
  else if (e.code === 'NumpadSubtract') key = '-';
  else if (e.code === 'Equal') key = e.shiftKey ? '+' : '=';
  else if (e.code === 'Minus') key = '-';
  else if (e.code === 'Comma' && key !== ',') key = ',';
  else if (key === ' ') key = 'Space';
  else if (key.length === 1) key = key.toUpperCase();
  if (['Control', 'Alt', 'Shift', 'Meta', 'AltGraph'].includes(key)) return parts.join('+');
  return [...parts, key].join('+');
}

export class TerminalApp {
  constructor(ctx) {
    this.ctx = ctx;
    this.win = ctx.win;
    this.prefs = prefs;
    this.tabs = [];
    this.active = null; // tab
    this.zoom = 0;
    this.closing = false;
    this.offs = [];
    this.lastBell = 0;
    this.scheme = null;
  }

  get t() {
    return this.ctx.t;
  }

  // A shortcut as the user's language writes it (Ctrl+Maj+T in French).
  kbd(combo) {
    return combo.replace(/Shift/g, this.ctx.t('keys.shift'));
  }

  // ================================================================== setup
  async init() {
    const { ctx } = this;
    ctx.ui.loadCss('app://shell/node_modules/@xterm/xterm/css/xterm.css');
    if (!envPromise) {
      envPromise = ctx.api.invoke('pty:env').catch(() => ({ shellName: 'bash', python: true, sudo: true }));
    }
    const [env] = await Promise.all([envPromise, prefs.load(ctx), loadXterm(ctx.ui).catch(() => null)]);
    this.env = env;
    bus.attach(ctx.api);
    this.build();
    this.wire();
    this.applyAppearance();
    const args = ctx.args || {};
    const profile = this.profileById(args.profile) || this.defaultProfile();
    await this.newTab(profile, { cwd: args.cwd || null, command: args.command || null });
    if (args.settings) this.openSettings();
  }

  build() {
    const { h, icon, t, win } = this.ctx;
    win.el.classList.add('tm-window');
    win.el.__terminal = this; // tests and debugging
    // ---- tab strip in the title bar
    this.tabsEl = h('div', { class: 'tm-tabs', role: 'tablist', 'aria-label': t('tabs.label') });
    this.newBtn = h(
      'button',
      { type: 'button', class: 'tm-newtab', 'aria-label': t('tabs.new'), 'data-tip': t('tabs.newTip'), 'data-tip-pos': 'below', onclick: () => this.newTab() },
      icon('add', { size: 16 }),
    );
    this.dropBtn = h(
      'button',
      { type: 'button', class: 'tm-dropdown', 'aria-label': t('tabs.profiles'), 'aria-haspopup': 'menu', 'data-tip': t('tabs.profiles'), 'data-tip-pos': 'below', onclick: () => this.profileMenu() },
      icon('chevron_down', { size: 12 }),
    );
    // Scroll buttons, shown when the tabs do not fit (Windows Terminal style).
    const scrollBtn = (dir) =>
      h(
        'button',
        { type: 'button', tabindex: '-1', class: `tm-scroll tm-scroll-${dir}`, 'aria-hidden': 'true', hidden: true, onclick: () => this.scrollTabs(dir === 'l' ? -1 : 1) },
        icon(dir === 'l' ? 'chevron_left' : 'chevron_right', { size: 12 }),
      );
    this.scrollL = scrollBtn('l');
    this.scrollR = scrollBtn('r');
    this.strip = h(
      'div',
      { class: 'tm-strip' },
      this.scrollL,
      this.tabsEl,
      this.scrollR,
      h('div', { class: 'tm-newgroup' }, this.newBtn, this.dropBtn),
      h('div', { class: 'tm-strip-drag' }),
    );
    win.titlebarSlot.appendChild(this.strip);
    this.tabsEl.addEventListener('scroll', () => this.updateScrollButtons(), { passive: true });
    this.stripRo = new ResizeObserver(() => {
      this.updateScrollButtons();
      if (this.active) this.revealTab(this.active);
    });
    this.stripRo.observe(this.tabsEl);
    this.tabsEl.addEventListener(
      'wheel',
      (e) => {
        if (this.tabsEl.scrollWidth <= this.tabsEl.clientWidth) return;
        e.preventDefault();
        this.tabsEl.scrollLeft += e.deltaY || e.deltaX;
      },
      { passive: false },
    );
    // ---- content
    this.views = h('div', { class: 'tm-views' });
    this.toast = h('div', { class: 'tm-toast', 'aria-live': 'polite', hidden: true });
    this.root = h('div', { class: 'tm-root' }, this.views, this.toast);
    win.body.appendChild(this.root);
    this.find = new FindBar(this);
  }

  wire() {
    const { ctx, win } = this;
    win.el.addEventListener('keydown', (e) => this.onKey(e), true);
    this.views.addEventListener('contextmenu', (e) => this.onContextMenu(e));
    // Middle click pastes the PRIMARY selection (X11), unless the program wants the mouse.
    this.views.addEventListener(
      'mousedown',
      (e) => {
        if (e.button !== 1) return;
        const s = this.sessionAt(e.target);
        if (!s?.term || s.term.modes.mouseTrackingMode !== 'none') return;
        e.preventDefault();
        ctx.api
          .invoke('pty:primaryRead')
          .then((text) => text && s.paste(text))
          .catch(() => {});
      },
      true,
    );
    this.views.addEventListener('mouseup', (e) => e.button === 1 && e.preventDefault(), true);
    this.views.addEventListener(
      'wheel',
      (e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        e.stopPropagation();
        this.zoomBy(e.deltaY < 0 ? 1 : -1);
      },
      { passive: false, capture: true },
    );
    // Drop files: insert their quoted paths (like Windows Terminal).
    this.views.addEventListener('dragover', (e) => {
      if ([...(e.dataTransfer?.types || [])].some((x) => x === 'Files' || x === 'text/plain')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }
    });
    this.views.addEventListener('drop', (e) => {
      const s = this.sessionAt(e.target) || this.session;
      if (!s) return;
      e.preventDefault();
      const files = [...(e.dataTransfer?.files || [])].map((f) => ctx.api.pathForFile(f)).filter(Boolean);
      const text = files.length ? files.map(shellQuote).join(' ') : e.dataTransfer.getData('text/plain');
      if (text && s.state === 'running') ctx.api.send('pty:write', s.ptyId, text);
      s.focus();
    });
    win.onBeforeClose(() => this.beforeClose());
    ctx.onClose(() => this.destroy());
    win.on('focus', () => {
      if (this.active?.kind === 'term' && !this.find.isOpen && !this.win.el.querySelector('.dialog-layer')) {
        setTimeout(() => {
          if (!this.win.el.contains(document.activeElement) || document.activeElement === this.win.body) this.session?.focus();
        }, 0);
      }
      this.active?.el.classList.remove('bell');
    });
    win.on('fullscreen', () => this.session?.fitSoon(60));
    this.offs.push(
      prefs.on('change', (key) => this.prefsChanged(key)),
      ctx.shell.theme.on('change', () => this.applyAppearance()),
      ctx.settings.on('transparency', () => this.applyAppearance()),
    );
    ctx.onLangChange(() => this.relabel());
  }

  // ================================================================== profiles
  profiles() {
    const { t } = this.ctx;
    const env = this.env || {};
    const list = [{ id: 'shell', name: cap(env.shellName || 'bash'), icon: 'shell', command: null }];
    if (env.python !== false) list.push({ id: 'python', name: t('profile.python'), icon: 'python', command: ['python3'] });
    if (env.sudo !== false) list.push({ id: 'root', name: t('profile.root'), icon: 'root', command: ['sudo', '-i'] });
    return list;
  }

  profileById(id) {
    return id ? this.profiles().find((p) => p.id === id) || null : null;
  }

  defaultProfile() {
    return this.profileById(prefs.get('defaultProfile')) || this.profiles()[0];
  }

  startDir() {
    return prefs.get('startDir') || null;
  }

  // ================================================================== appearance
  termOptions() {
    const face = prefs.get('fontFace');
    const transparent = document.documentElement.dataset.transparency !== 'off';
    const opacity = transparent ? prefs.get('opacity') / 100 : 1;
    this.scheme = resolveScheme(prefs.get('scheme'), this.ctx.shell.theme.mode);
    return {
      fontFamily: `"${face}", "Cascadia Mono", "DejaVu Sans Mono", "Noto Sans Mono", monospace, "Noto Color Emoji"`,
      fontSize: Math.max(6, Math.min(72, prefs.get('fontSize') + this.zoom)),
      lineHeight: prefs.get('lineHeight'),
      cursorStyle: prefs.get('cursorShape'),
      cursorBlink: prefs.get('cursorBlink'),
      cursorInactiveStyle: 'outline',
      cursorWidth: 2,
      scrollback: prefs.get('scrollback'),
      theme: xtermTheme(this.scheme, opacity),
      // Bold as bright suits dark schemes; on light ones the bright colours wash out.
      drawBoldTextInBrightColors: this.scheme.dark,
      customGlyphs: true,
      rescaleOverlappingGlyphs: true,
      // (> 1 would also "fix" inverse video against the default background and grey it out)
      minimumContrastRatio: 1,
      smoothScrollDuration: 0,
      scrollOnUserInput: true,
      rightClickSelectsWord: false,
      macOptionIsMeta: false,
      wordSeparator: ' ()[]{}\',"`│─<>|;',
      linkHandler: { activate: (e, uri) => this.openLink(e, uri), allowNonHttpProtocols: false },
    };
  }

  applyAppearance() {
    const opts = this.termOptions();
    const transparent = document.documentElement.dataset.transparency !== 'off';
    const opacity = transparent ? prefs.get('opacity') / 100 : 1;
    const c = this.scheme.colors;
    const el = this.win.el;
    el.classList.toggle('tm-acrylic', transparent && prefs.get('acrylic'));
    el.classList.toggle('tm-scheme-light', !this.scheme.dark);
    el.style.setProperty('--tm-bg', opacity >= 1 ? c.background : rgba(c.background, opacity));
    el.style.setProperty('--tm-bg-solid', c.background);
    el.style.setProperty('--tm-fg', c.foreground);
    el.style.setProperty('--tm-fg-2', rgba(c.foreground, 0.7));
    el.style.setProperty('--tm-hover', rgba(c.foreground, 0.08));
    for (const s of this.allSessions()) s.applyOptions(opts);
    if (this.find.isOpen) this.find.decorate();
  }

  prefsChanged(key) {
    if (key === 'defaultProfile' || key === 'startDir' || key === 'confirmClose' || key === 'warnPaste' || key === 'copyOnSelect' || key === 'bell' || key === 'closeOnExit') return;
    this.applyAppearance();
  }

  zoomBy(step) {
    if (step === 0) this.zoom = 0;
    else this.zoom = Math.max(6 - prefs.get('fontSize'), Math.min(72 - prefs.get('fontSize'), this.zoom + step));
    const opts = this.termOptions();
    for (const s of this.allSessions()) s.applyOptions({ fontSize: opts.fontSize });
    this.showToast(this.ctx.t('zoom.toast', { size: opts.fontSize }));
  }

  showToast(text) {
    clearTimeout(this._toastTimer);
    this.toast.textContent = text;
    this.toast.hidden = false;
    this.toast.classList.remove('out');
    this._toastTimer = setTimeout(() => {
      this.toast.classList.add('out');
      this._toastTimer = setTimeout(() => (this.toast.hidden = true), 200);
    }, 1100);
  }

  // ================================================================== tabs
  allSessions() {
    return this.tabs.flatMap((t) => (t.tree ? t.tree.sessions() : []));
  }

  get session() {
    return this.active?.kind === 'term' ? this.active.session : null;
  }

  makeTabEl(tab) {
    const { h, icon, t } = this.ctx;
    tab.iconEl = h('span', { class: 'tm-tab-icon' });
    tab.titleEl = h('span', { class: 'tm-tab-title' });
    tab.bellEl = h('span', { class: 'tm-tab-bell', 'aria-hidden': 'true' }, icon('alert', { size: 12, filled: true }));
    tab.closeEl = h(
      'button',
      { type: 'button', class: 'tm-tab-close', tabindex: '-1', 'aria-label': t('tabs.close'), 'data-tip': t('tabs.close'), 'data-tip-pos': 'below', onclick: (e) => (e.stopPropagation(), this.closeTab(tab)) },
      icon('dismiss', { size: 12 }),
    );
    tab.el = h(
      'div',
      { class: `tm-tab tm-tab-${tab.kind} no-drag`, role: 'tab', tabindex: '-1', 'aria-selected': 'false', dataset: { tab: tab.id } },
      h('span', { class: 'tm-tab-bg' }),
      tab.iconEl,
      tab.titleEl,
      tab.bellEl,
      tab.closeEl,
    );
    tab.el.addEventListener('pointerdown', (e) => this.tabPointerDown(e, tab));
    tab.el.addEventListener('auxclick', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        this.closeTab(tab);
      }
    });
    tab.el.addEventListener('dblclick', (e) => {
      // Never let it reach the title bar (double-click there maximizes the window).
      e.stopPropagation();
      if (!e.target.closest('.tm-tab-close') && tab.kind === 'term') this.renameTab(tab);
    });
    tab.el.addEventListener('contextmenu', (e) => this.tabMenu(e, tab));
    tab.el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.activate(tab);
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const i = this.tabs.indexOf(tab) + (e.key === 'ArrowRight' ? 1 : -1);
        this.tabs[(i + this.tabs.length) % this.tabs.length]?.el.focus();
      } else if (e.key === 'Delete') {
        e.preventDefault();
        this.closeTab(tab);
      }
    });
    return tab.el;
  }

  insertTab(tab, index = this.tabs.length) {
    this.tabs.splice(index, 0, tab);
    const ref = this.tabs[index + 1]?.el || null;
    this.tabsEl.insertBefore(tab.el, ref);
    this.views.appendChild(tab.view);
    if (document.documentElement.dataset.animations !== 'off') {
      tab.el.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 200, easing: 'cubic-bezier(0.1, 0.9, 0.2, 1)' });
    }
  }

  async newTab(profile = this.defaultProfile(), { cwd = null, command = null, index } = {}) {
    if (this.closing) return null;
    const { h } = this.ctx;
    const tab = { id: `t${Math.random().toString(36).slice(2, 9)}`, kind: 'term', customTitle: '', session: null };
    tab.view = h('div', { class: 'tm-view', dataset: { tab: tab.id } });
    tab.tree = new PaneTree(this, tab.view);
    this.makeTabEl(tab);
    const session = new Session(this, profile, { cwd, command });
    tab.session = session;
    tab.tree.setRoot(session);
    this.insertTab(tab, index ?? (this.active ? this.tabs.indexOf(this.active) + 1 : this.tabs.length));
    this.activate(tab);
    this.updateTab(tab);
    try {
      await session.start();
    } catch (err) {
      this.error(err);
    }
    if (this.active === tab) session.focus();
    this.updateTab(tab);
    return tab;
  }

  activate(tab) {
    if (!tab) return;
    const prev = this.active;
    this.active = tab;
    for (const x of this.tabs) {
      const on = x === tab;
      x.el.classList.toggle('active', on);
      x.el.setAttribute('aria-selected', String(on));
      x.el.tabIndex = on ? 0 : -1;
      x.view.classList.toggle('active', on);
    }
    tab.el.classList.remove('bell');
    this.revealTab(tab);
    if (prev !== tab && this.find.isOpen) this.find.close({ refocus: false });
    if (tab.kind === 'term') {
      for (const s of tab.tree.sessions()) s.fitSoon(0);
      setTimeout(() => this.active === tab && !tab.el.querySelector('.tm-tab-rename') && tab.session?.focus(), 0);
    } else tab.page?.focus();
    this.updateTitle();
  }

  // Scroll the tab strip (only it) so the tab is visible.
  revealTab(tab) {
    const strip = this.tabsEl;
    const l = tab.el.offsetLeft - strip.offsetLeft - 4;
    const r = l + tab.el.offsetWidth + 12;
    if (l < strip.scrollLeft) strip.scrollLeft = l;
    else if (r > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = r - strip.clientWidth;
    this.updateScrollButtons();
  }

  updateScrollButtons() {
    const el = this.tabsEl;
    const over = el.scrollWidth > el.clientWidth + 1;
    this.scrollL.hidden = this.scrollR.hidden = !over;
    this.scrollL.disabled = el.scrollLeft <= 0;
    this.scrollR.disabled = el.scrollLeft + el.clientWidth >= el.scrollWidth - 1;
  }

  scrollTabs(dir) {
    const reduce = document.documentElement.dataset.animations === 'off';
    this.tabsEl.scrollBy({ left: dir * Math.max(120, this.tabsEl.clientWidth * 0.6), behavior: reduce ? 'auto' : 'smooth' });
  }

  tabFor(session) {
    return this.tabs.find((t) => t.tree?.find(session));
  }

  tabTitle(tab) {
    if (tab.kind === 'settings') return this.ctx.t('settings.title');
    return tab.customTitle || tab.session?.title || '';
  }

  updateTab(tab) {
    if (!tab) return;
    const title = this.tabTitle(tab);
    if (tab.titleEl.textContent !== title) tab.titleEl.textContent = title;
    tab.el.title = title;
    tab.el.setAttribute('aria-label', title);
    const kind = tab.kind === 'settings' ? 'settings' : tab.session?.profile.icon || 'shell';
    if (tab.iconEl.dataset.kind !== kind) {
      tab.iconEl.dataset.kind = kind;
      tab.iconEl.innerHTML = '';
      tab.iconEl.appendChild(kind === 'settings' ? this.ctx.icon('settings', { size: 16 }) : profileIcon(this.ctx.h, kind));
    }
    tab.el.classList.toggle('exited', tab.kind === 'term' && tab.session?.state === 'exited');
    if (tab === this.active) this.updateTitle();
  }

  updateTitle() {
    const title = this.active ? this.tabTitle(this.active) : '';
    const name = this.ctx.i18n.name(this.ctx.manifest.name);
    this.win.setTitle(title || name);
  }

  sessionTitleChanged(session) {
    const tab = this.tabFor(session);
    if (!tab) return;
    if (tab.session === session) this.updateTab(tab);
  }

  sessionFocused(session) {
    const tab = this.tabFor(session);
    if (!tab || tab.session === session) return;
    tab.session = session;
    this.markFocusedPane(tab);
    this.updateTab(tab);
    this.find.follow(session);
  }

  paneClicked(session) {
    this.sessionFocused(session);
  }

  markFocusedPane(tab) {
    const multi = tab.tree.count > 1;
    tab.view.classList.toggle('multi', multi);
    for (const leaf of tab.tree.leaves()) leaf.el.classList.toggle('focused', multi && leaf.session === tab.session);
  }

  focusSession(session) {
    const tab = this.tabFor(session);
    if (!tab) return;
    if (this.active !== tab) this.activate(tab);
    tab.session = session;
    this.markFocusedPane(tab);
    this.updateTab(tab);
    session.focus();
  }

  sessionAt(target) {
    const el = target?.closest?.('.tm-term');
    if (!el) return null;
    return this.allSessions().find((s) => s.el === el) || null;
  }

  // ------------------------------------------------------------------ split panes
  async splitPane(dir = 'auto', session = this.session, { duplicate = true } = {}) {
    const tab = session && this.tabFor(session);
    if (!tab) return null;
    const d = dir === 'auto' ? tab.tree.autoDir(session) : dir;
    let cwd = null;
    if (duplicate && session.ptyId && session.state === 'running') {
      try {
        cwd = (await this.ctx.api.invoke('pty:info', session.ptyId)).cwd;
      } catch {}
    }
    const profile = duplicate ? session.profile : this.defaultProfile();
    const s = new Session(this, profile, { cwd, command: duplicate ? session.command : null });
    tab.tree.split(session, d, s);
    tab.session = s;
    this.markFocusedPane(tab);
    try {
      await s.start();
    } catch (err) {
      this.error(err);
    }
    for (const x of tab.tree.sessions()) x.fitSoon(0);
    if (this.active === tab && tab.session === s) s.focus();
    this.updateTab(tab);
    return s;
  }

  async duplicateTab(tab = this.active) {
    if (!tab || tab.kind !== 'term') return null;
    const s = tab.session;
    let cwd = null;
    if (s?.ptyId && s.state === 'running') {
      try {
        cwd = (await this.ctx.api.invoke('pty:info', s.ptyId)).cwd;
      } catch {}
    }
    return this.newTab(s.profile, { cwd, command: s.command, index: this.tabs.indexOf(tab) + 1 });
  }

  moveFocus(dir) {
    const s = this.session;
    const tab = this.active;
    if (!s || !tab) return false;
    const n = tab.tree.neighbor(s, dir);
    if (!n) return false;
    this.focusSession(n);
    return true;
  }

  // Close one pane (the tab goes when its last pane goes, the window when its last tab goes).
  async closeSession(session, { force = false } = {}) {
    const tab = this.tabFor(session);
    if (!tab) return;
    if (!force && session.busy && prefs.get('confirmClose')) {
      const ok = await this.ctx.ui.confirm(this.ctx.t('confirm.runningBody', { name: session.busyName }), {
        title: this.ctx.t('confirm.runningTitle'),
        okLabel: this.ctx.t('confirm.close'),
        parent: this.win,
      });
      if (!ok) return;
    }
    if (tab.tree.count <= 1) {
      this.removeTab(tab);
      return;
    }
    if (this.find.session === session) this.find.close({ refocus: false });
    const next = tab.tree.remove(session);
    session.dispose();
    tab.session = next?.session || tab.tree.sessions()[0];
    this.markFocusedPane(tab);
    for (const x of tab.tree.sessions()) x.fitSoon(0);
    this.updateTab(tab);
    if (this.active === tab) tab.session?.focus();
  }

  async closeTab(tab = this.active, { force = false } = {}) {
    if (!tab) return;
    if (!force && tab.kind === 'term' && prefs.get('confirmClose')) {
      const sessions = tab.tree.sessions();
      const busy = sessions.find((s) => s.busy);
      if (sessions.length > 1 || busy) {
        const ok = await this.ctx.ui.confirm(
          busy && sessions.length === 1 ? this.ctx.t('confirm.runningBody', { name: busy.busyName }) : this.ctx.t('confirm.panesBody', { count: sessions.length }),
          { title: busy && sessions.length === 1 ? this.ctx.t('confirm.runningTitle') : this.ctx.t('confirm.panesTitle'), okLabel: this.ctx.t('confirm.close'), parent: this.win },
        );
        if (!ok) return;
      }
    }
    this.removeTab(tab);
  }

  removeTab(tab) {
    const i = this.tabs.indexOf(tab);
    if (i < 0) return;
    if (this.find.isOpen && tab === this.active) this.find.close({ refocus: false });
    this.tabs.splice(i, 1);
    const finish = () => {
      tab.el.remove();
      tab.view.remove();
    };
    if (tab.tree) for (const s of tab.tree.sessions()) s.dispose();
    tab.page?.dispose();
    if (this.tabs.length && document.documentElement.dataset.animations !== 'off') {
      tab.el.style.pointerEvents = 'none';
      tab.el.animate([{ opacity: 1 }, { opacity: 0, transform: 'translateY(4px)' }], { duration: 120, easing: 'cubic-bezier(0.7, 0, 1, 0.5)' }).finished.then(finish, finish);
      tab.view.remove();
    } else finish();
    if (!this.tabs.length) {
      this.closing = true;
      this.win.close(true);
      return;
    }
    if (this.active === tab) this.activate(this.tabs[Math.min(i, this.tabs.length - 1)]);
  }

  async closeOtherTabs(keep, { rightOnly = false } = {}) {
    const idx = this.tabs.indexOf(keep);
    const victims = this.tabs.filter((t, i) => t !== keep && (!rightOnly || i > idx));
    if (!victims.length) return;
    const count = victims.reduce((n, t) => n + (t.tree ? t.tree.count : 0), 0);
    if (prefs.get('confirmClose') && count > 1) {
      const ok = await this.ctx.ui.confirm(this.ctx.t('confirm.tabsBody', { count: victims.length }), {
        title: this.ctx.t('confirm.tabsTitle'),
        okLabel: this.ctx.t('confirm.closeAll'),
        parent: this.win,
      });
      if (!ok) return;
    }
    this.activate(keep);
    for (const t of victims) this.removeTab(t);
  }

  cycleTab(dir) {
    if (this.tabs.length < 2) return;
    const i = this.tabs.indexOf(this.active);
    this.activate(this.tabs[(i + dir + this.tabs.length) % this.tabs.length]);
  }

  async renameTab(tab) {
    const { h, t } = this.ctx;
    if (tab.kind !== 'term') return;
    const input = h('input', { class: 'tm-tab-rename', value: this.tabTitle(tab), spellcheck: false, 'aria-label': t('tabs.rename') });
    tab.titleEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      if (save) tab.customTitle = input.value.trim();
      input.replaceWith(tab.titleEl);
      this.updateTab(tab);
      if (this.active === tab) tab.session?.focus();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  // Drag a tab sideways to reorder it.
  tabPointerDown(e, tab) {
    if (e.button !== 0 || e.target.closest('.tm-tab-close, input')) return;
    if (this.active !== tab) this.activate(tab);
    const el = tab.el;
    const startX = e.clientX;
    const grab = startX - el.getBoundingClientRect().left;
    let dragging = false;
    try {
      el.setPointerCapture(e.pointerId); // so the release is seen even outside the tab
    } catch {}
    const naturalLeft = () => this.tabsEl.getBoundingClientRect().left + el.offsetLeft - this.tabsEl.scrollLeft;
    const move = (ev) => {
      if (!dragging && Math.abs(ev.clientX - startX) < 6) return;
      if (!dragging) {
        dragging = true;
        el.classList.add('dragging');
      }
      const others = this.tabs.filter((x) => x !== tab);
      let index = others.findIndex((x) => ev.clientX < x.el.getBoundingClientRect().left + x.el.offsetWidth / 2);
      if (index < 0) index = others.length;
      if (this.tabs.indexOf(tab) !== index) {
        this.tabs.splice(this.tabs.indexOf(tab), 1);
        this.tabs.splice(index, 0, tab);
        this.tabsEl.insertBefore(el, this.tabs[index + 1]?.el || null);
      }
      el.style.transform = `translateX(${ev.clientX - grab - naturalLeft()}px)`;
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      if (dragging) {
        el.classList.remove('dragging');
        el.style.transform = '';
      }
      // Clicking a tab puts the keyboard back in its terminal (not while its name is being edited).
      setTimeout(() => {
        if (this.active === tab && tab.kind === 'term' && !tab.el.querySelector('.tm-tab-rename')) tab.session?.focus();
      }, 0);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  // ------------------------------------------------------------------ settings tab
  openSettings(section) {
    let tab = this.tabs.find((t) => t.kind === 'settings');
    if (!tab) {
      const { h } = this.ctx;
      tab = { id: `t${Math.random().toString(36).slice(2, 9)}`, kind: 'settings', customTitle: '' };
      tab.view = h('div', { class: 'tm-view tm-settings-view', dataset: { tab: tab.id } });
      tab.page = new SettingsPage(this);
      tab.view.appendChild(tab.page.el);
      this.makeTabEl(tab);
      this.insertTab(tab, this.active ? this.tabs.indexOf(this.active) + 1 : this.tabs.length);
      this.updateTab(tab);
    }
    this.activate(tab);
    if (section) tab.page.show(section);
    return tab;
  }

  // ================================================================== menus
  async profileMenu() {
    const { ui, t } = this.ctx;
    const profiles = this.profiles();
    const items = profiles.map((p, i) => ({
      label: p.name,
      icon: 'window_console',
      shortcut: i < 9 ? this.kbd(`Ctrl+Shift+${i + 1}`) : undefined,
      action: () => this.newTab(p),
    }));
    items.push('-', { label: t('menu.settings'), icon: 'settings', shortcut: this.kbd('Ctrl+,'), action: () => this.openSettings() });
    items.push({ label: t('menu.newWindow'), icon: 'window_new', shortcut: this.kbd('Ctrl+Shift+N'), action: () => this.newWindow() });
    items.push({ label: t('menu.about'), icon: 'info', action: () => this.about() });
    this.dropBtn.classList.add('open');
    const p = ui.menu(this.dropBtn, items, { class: 'tm-menu tm-profile-menu' });
    // ui.menu draws Fluent icons only: put the profile artwork in the profile rows.
    const menu = document.querySelector('.menu.tm-profile-menu');
    if (menu) {
      const rows = menu.querySelectorAll('.menu-item');
      profiles.forEach((pr, i) => {
        const ic = rows[i]?.querySelector('.icon');
        if (ic) ic.innerHTML = profileIconSvg(pr.icon);
      });
    }
    await p;
    this.dropBtn.classList.remove('open');
  }

  terminalMenuItems(s) {
    const { t } = this.ctx;
    const tab = this.tabFor(s);
    const multi = tab?.tree.count > 1;
    return [
      { label: t('menu.copy'), icon: 'copy', shortcut: this.kbd('Ctrl+Shift+C'), disabled: !s.hasSelection(), action: () => s.copy() },
      { label: t('menu.paste'), icon: 'clipboard_paste', shortcut: this.kbd('Ctrl+Shift+V'), disabled: s.state !== 'running', action: () => s.paste() },
      { label: t('menu.selectAll'), icon: 'select_all_on', shortcut: this.kbd('Ctrl+Shift+A'), action: () => s.selectAll() },
      '-',
      { label: t('menu.find'), icon: 'search', shortcut: this.kbd('Ctrl+Shift+F'), action: () => this.find.open(s) },
      { label: t('menu.clear'), icon: 'eraser', action: () => s.clear() },
      '-',
      {
        label: t('menu.split'),
        icon: 'split_vertical',
        submenu: [
          { label: t('menu.splitDuplicate'), icon: 'tab_desktop_copy', shortcut: this.kbd('Alt+Shift+D'), action: () => this.splitPane('auto', s) },
          { label: t('menu.splitRight'), icon: 'split_vertical', shortcut: this.kbd('Alt+Shift++'), action: () => this.splitPane('row', s) },
          { label: t('menu.splitDown'), icon: 'split_horizontal', shortcut: this.kbd('Alt+Shift+-'), action: () => this.splitPane('col', s) },
        ],
      },
      multi ? { label: t('menu.closePane'), icon: 'dismiss_square_multiple', shortcut: this.kbd('Ctrl+Shift+W'), action: () => this.closeSession(s) } : null,
      { label: t('menu.closeTab'), icon: 'dismiss', shortcut: multi ? undefined : this.kbd('Ctrl+Shift+W'), action: () => this.closeTab(tab) },
    ].filter(Boolean);
  }

  onContextMenu(e) {
    const s = this.sessionAt(e.target);
    if (!s?.term) return;
    // A program that uses the mouse (htop, vim…) gets the right click; Shift+right-click still opens the menu.
    if (s.term.modes.mouseTrackingMode !== 'none' && !e.shiftKey) {
      e.preventDefault();
      return;
    }
    this.focusSession(s);
    this.ctx.ui.menu(e, this.terminalMenuItems(s), { class: 'tm-menu' }).then(() => {
      if (!this.find.isOpen && !this.win.el.querySelector('.dialog-layer') && this.session === s) s.focus();
    });
  }

  tabMenu(e, tab) {
    const { t } = this.ctx;
    const i = this.tabs.indexOf(tab);
    const term = tab.kind === 'term';
    this.ctx.ui.menu(
      e,
      [
        term ? { label: t('menu.renameTab'), icon: 'rename', action: () => this.renameTab(tab) } : null,
        term ? { label: t('menu.duplicateTab'), icon: 'tab_desktop_copy', shortcut: this.kbd('Ctrl+Shift+D'), action: () => this.duplicateTab(tab) } : null,
        term ? { label: t('menu.splitTab'), icon: 'split_vertical', action: () => (this.activate(tab), this.splitPane('auto', tab.session)) } : null,
        term ? '-' : null,
        { label: t('menu.closeRight'), icon: 'arrow_right', disabled: i >= this.tabs.length - 1, action: () => this.closeOtherTabs(tab, { rightOnly: true }) },
        { label: t('menu.closeOthers'), icon: 'dismiss_square_multiple', disabled: this.tabs.length < 2, action: () => this.closeOtherTabs(tab) },
        { label: t('menu.closeTab'), icon: 'dismiss', action: () => this.closeTab(tab) },
      ].filter(Boolean),
      { class: 'tm-menu' },
    );
  }

  // ================================================================== keyboard
  onKey(e) {
    if (e.defaultPrevented || e.isComposing) return;
    if (e.getModifierState?.('AltGraph')) return;
    const combo = comboOf(e);
    const inField = e.target.closest?.('input, textarea:not(.xterm-helper-textarea), select, [contenteditable="true"]');
    const s = this.session;
    const run = (fn) => {
      e.preventDefault();
      e.stopPropagation();
      fn();
    };
    // Window / tab level (work everywhere in the window, also in the settings tab).
    switch (combo) {
      case 'Ctrl+Shift+T':
        return run(() => this.newTab());
      case 'Ctrl+Shift+N':
        return run(() => this.newWindow());
      case 'Ctrl+Shift+D':
        return this.active?.kind === 'term' ? run(() => this.duplicateTab()) : undefined;
      case 'Ctrl+Shift+W':
        return run(() => (s ? this.closeSession(s) : this.closeTab()));
      case 'Ctrl+Tab':
        return run(() => this.cycleTab(1));
      case 'Ctrl+Shift+Tab':
        return run(() => this.cycleTab(-1));
      case 'Ctrl+,':
        return run(() => this.openSettings());
      case 'Ctrl+Shift+Space':
        return run(() => this.profileMenu());
      case 'F11':
      case 'Alt+Enter':
        return run(() => this.win.setFullscreen(!this.win.fullscreen));
      default:
    }
    let m = /^Ctrl\+Shift\+([1-9])$/.exec(combo);
    if (m) {
      const p = this.profiles()[Number(m[1]) - 1];
      if (p) return run(() => this.newTab(p));
    }
    m = /^Ctrl\+Alt\+([1-9])$/.exec(combo);
    if (m && /^[1-9]$/.test(e.key)) {
      const tab = this.tabs[Number(m[1]) - 1];
      if (tab) return run(() => this.activate(tab));
    }
    if (inField || !s) return;
    // Terminal level.
    switch (combo) {
      case 'Ctrl+Shift+C':
      case 'Ctrl+Insert':
        return run(() => s.copy());
      case 'Ctrl+C':
        if (s.hasSelection()) {
          return run(() => {
            s.copy();
            s.term.clearSelection();
          });
        }
        return;
      case 'Ctrl+Shift+V':
      case 'Shift+Insert':
        return run(() => s.paste());
      case 'Ctrl+Shift+A':
        return run(() => s.selectAll());
      case 'Ctrl+Shift+F':
        return run(() => this.find.open(s));
      case 'Ctrl+=':
      case 'Ctrl++':
      case 'Ctrl+Shift++':
        return run(() => this.zoomBy(1));
      case 'Ctrl+-':
        return run(() => this.zoomBy(-1));
      case 'Ctrl+0':
        return run(() => this.zoomBy(0));
      case 'Alt+Shift+D':
        return run(() => this.splitPane('auto', s));
      case 'Alt+Shift++':
      case 'Alt+Shift+=':
        return run(() => this.splitPane('row', s));
      case 'Alt+Shift+-':
      case 'Alt+Shift+_':
        return run(() => this.splitPane('col', s));
      case 'Ctrl+Shift+ArrowUp':
        return run(() => s.term.scrollLines(-1));
      case 'Ctrl+Shift+ArrowDown':
        return run(() => s.term.scrollLines(1));
      case 'Ctrl+Shift+PageUp':
        return run(() => s.term.scrollPages(-1));
      case 'Ctrl+Shift+PageDown':
        return run(() => s.term.scrollPages(1));
      case 'Ctrl+Shift+Home':
        return run(() => s.term.scrollToTop());
      case 'Ctrl+Shift+End':
        return run(() => s.term.scrollToBottom());
      default:
    }
    m = /^Alt\+(Shift\+)?Arrow(Left|Right|Up|Down)$/.exec(combo);
    if (m && this.active?.tree.count > 1) {
      const dir = m[2].toLowerCase();
      // Moving the focus only takes the key when there is a pane that way (else the shell gets it).
      if (m[1]) return run(() => this.active.tree.resize(s, dir));
      if (this.active.tree.neighbor(s, dir)) return run(() => this.moveFocus(dir));
    }
  }

  // ================================================================== misc actions
  newWindow() {
    this.ctx.shell.launch('terminal', {});
  }

  openLink(e, uri) {
    if (!/^https?:\/\//i.test(uri)) return;
    try {
      this.ctx.shell.openUrl(uri);
    } catch (err) {
      this.error(err);
    }
  }

  bell(session) {
    const mode = prefs.get('bell');
    if (mode === 'none') return;
    const now = performance.now();
    if (now - this.lastBell < 200) return;
    this.lastBell = now;
    const tab = this.tabFor(session);
    if (mode === 'sound') this.ctx.shell.sounds?.play?.('notify');
    session.flashBell();
    if (tab && (tab !== this.active || this.ctx.shell.wm.focused() !== this.win)) tab.el.classList.add('bell');
    this.win.flash();
  }

  async confirmPaste(text) {
    const { t, ui } = this.ctx;
    const lines = text.replace(/[\r\n]+$/, '').split(/\r\n|\r|\n/).length;
    return ui.confirm(t('paste.body', { count: lines }), { title: t('paste.title'), okLabel: t('paste.ok'), parent: this.win });
  }

  about() {
    const ctx = this.ctx;
    const { h, t, ui } = ctx;
    ui.dialog({
      title: t('about.title'),
      parent: this.win,
      body: h(
        'div',
        { class: 'tm-about' },
        h('img', { src: ctx.appUrl('icon.svg'), alt: '', width: 48, height: 48 }),
        h(
          'div',
          null,
          h('div', { class: 'body-strong' }, ctx.i18n.name(ctx.manifest.name)),
          h('div', { class: 'caption text-2' }, t('about.version', { v: this.env?.version || '1.0' })),
          h('div', { class: 'caption text-2' }, t('about.credits')),
        ),
      ),
    });
  }

  error(err) {
    console.error('[terminal]', err);
    this.ctx.ui.alert(String(err?.message || err), { title: this.ctx.t('error.title'), parent: this.win });
  }

  relabel() {
    const { t } = this.ctx;
    this.tabsEl.setAttribute('aria-label', t('tabs.label'));
    this.newBtn.setAttribute('aria-label', t('tabs.new'));
    this.newBtn.dataset.tip = t('tabs.newTip');
    this.dropBtn.setAttribute('aria-label', t('tabs.profiles'));
    this.dropBtn.dataset.tip = t('tabs.profiles');
    for (const tab of this.tabs) {
      tab.closeEl.setAttribute('aria-label', t('tabs.close'));
      tab.closeEl.dataset.tip = t('tabs.close');
      if (tab.session) {
        // Profile names are translated (Python 3, Root shell).
        const p = this.profileById(tab.session.profile.id);
        if (p) tab.session.profile = { ...tab.session.profile, name: p.name };
      }
      tab.page?.relabel();
      this.updateTab(tab);
    }
    this.find.relabel();
  }

  // ================================================================== closing
  async beforeClose() {
    if (this.closing || !prefs.get('confirmClose')) return true;
    const sessions = this.allSessions().filter((s) => s.state === 'running');
    const busy = sessions.filter((s) => s.busy);
    const tabs = this.tabs.filter((tb) => tb.kind === 'term').length;
    if (sessions.length <= 1 && !busy.length) return true;
    const { t, ui } = this.ctx;
    let title;
    let body;
    if (tabs > 1) {
      title = t('confirm.windowTitle');
      body = t('confirm.windowBody', { count: tabs });
    } else if (sessions.length > 1) {
      title = t('confirm.panesTitle');
      body = t('confirm.panesBody', { count: sessions.length });
    } else {
      title = t('confirm.runningTitle');
      body = t('confirm.runningBody', { name: busy[0].busyName });
    }
    return ui.confirm(body, { title, okLabel: tabs > 1 ? t('confirm.closeAll') : t('confirm.close'), parent: this.win });
  }

  destroy() {
    this.closing = true;
    for (const off of this.offs) off?.();
    this.find.close({ refocus: false });
    for (const tab of this.tabs) {
      if (tab.tree) for (const s of tab.tree.sessions()) s.dispose();
      tab.page?.dispose();
    }
    clearTimeout(this._toastTimer);
    this.stripRo?.disconnect();
  }
}
