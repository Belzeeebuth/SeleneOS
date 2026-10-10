// Aurora window manager. Windows are DOM elements inside #windows.
//
//   const win = wm.create({
//     appId, title, icon,                 // icon: URL string or Fluent icon name (via iconName)
//     width, height, x, y,                // optional geometry (centered/cascaded if x/y omitted)
//     minWidth = 320, minHeight = 200,
//     resizable = true, maximizable = true, minimizable = true,
//     titlebar = 'default' | 'tall' | 'none',   // 'tall' (44px) leaves room for tabs in win.titlebarSlot
//     background = 'mica' | 'mica-alt' | 'solid' | 'transparent',
//     maximized = false, alwaysOnTop = false, className,
//     skipTaskbar = false,                // hint for the taskbar (e.g. the Run dialog)
//     desktop,                            // virtual desktop id (defaults to wm.currentDesktop)
//   });
//   win.body                -> content element (flex column, fills the window)
//   win.titlebarSlot        -> element inside the title bar for tabs / search boxes
//   win.setTitle(s) win.setIcon(url) win.focus() win.minimize() win.maximize() win.restore()
//   win.toggleMaximize() win.close(force) win.setSize(w, h) win.center() win.setFullscreen(bool)
//   win.setProgress(0..1 | null)  win.flash()  win.makeDraggable(el)  win.setMinSize(w, h)
//   win.onBeforeClose(async () => boolean)   -> return false to cancel closing
//   win.on('focus'|'blur'|'resize'|'move'|'minimize'|'restore'|'maximize'|'close'|'fullscreen'|'snap', fn)
//   wm.list() wm.focused() wm.get(id) wm.byApp(appId) wm.minimizeAll() wm.toggleDesktop()
//   wm.on('open'|'close'|'focus'|'change', fn)
//   wm.anchorProvider = (win) => DOMRect | null      (set by the taskbar for minimize animations)
//   wm.workarea() -> {x, y, width, height}
//
// Additions (window management & navigation):
//   win.snapTo(zone, { animate = true, source })  zones: left right tl tr bl br third-l third-c third-r
//       two-thirds-l two-thirds-r quarter-l half-c quarter-r vmax (vertical maximize) max
//   win.maximizeVertically()  win.isSnapped()  win.isOnCurrentDesktop()
//   Snapped windows: toggleMaximize() (title bar double-click / maximize button) maximizes them, and restore()
//   from that maximized state puts them back in their snap zone; restore() of a snapped window -> normal size.
//   Closing the active window hands activation to the next window as soon as the close animation starts.
//   win.focusContent()        -> moves keyboard focus into the window (last focused control, [autofocus], or the body)
//   win.restoreFromMinimize({ animate = true })
//   win.startKeyboardMove('move'|'size')   -> arrow keys move/resize, Enter commits, Esc cancels (Alt+Space menu);
//       it also ends when another window is activated.   wm.endKeyboardMove(commit = true) ends any in progress
//   win.desktop               -> id of the virtual desktop the window lives on
//   wm.mru({ desktop, includeMinimized = true }) -> windows, most recently focused first (Alt+Tab order)
//   wm.zoneRect(zone, win?)   -> {x, y, width, height} of a snap zone in the current work area
//   Virtual desktops:
//     wm.desktops             -> [{ id, name }]  (name null = default "Desktop N"; use wm.desktopName(id))
//     wm.currentDesktop       -> id of the active desktop
//     wm.listDesktop(id = current) -> windows on that desktop (taskbar: show only these)
//     wm.createDesktop(name?) -> desktop    wm.removeDesktop(id, {animate})    wm.renameDesktop(id, name)
//     wm.switchDesktop(id, { animate = true })    wm.moveToDesktop(win, id)    wm.desktopName(id)
//     wm.on('desktop', ({ current, previous, desktops }))   active desktop changed
//     wm.on('desktops', (desktops))                         desktops added / removed / renamed
//   More events: wm.on('snap', (win, zone, { source }))  wm.on('drag-move', (win, { x, y }))
//     wm.on('drag-end', (win, { x, y, zone }))  wm.on('titlebar-menu', (win, event))
//     wm.on('max-hover', (win, button))  wm.on('max-leave', (win, button))
//   wm.dragSnapOverride       -> zone a feature (snap bar) wants a drag to end in, or null
//   wm.snapEnabled            -> edge snapping while dragging (default on)
//   wm.shakeToMinimize        -> Aero shake (shake a title bar to minimise the other windows); default off
//   (features/snaplayouts.js drives both from settings 'multitasking.snap' / 'multitasking.shake')
//   Focus inside <webview>/<iframe>: such focus changes never reach the shell document as focusin, so the
//   wm watches window 'blur' + document.activeElement and focuses the owning window. Apps need nothing extra.
import { Emitter } from './api.js';
import { h, icon } from './ui.js';
import { i18n, t } from './i18n.js';

const MIN_VISIBLE = 64;
let seq = 0;
let zTop = 10;
let cascade = 0;
let dseq = 1;

// Windows 11-like motion: arrivals decelerate, departures accelerate.
const EASE = 'cubic-bezier(0.1, 0.9, 0.2, 1)';
const EASE_IN = 'cubic-bezier(0.7, 0, 1, 0.5)';
const EASE_IN_OUT = 'cubic-bezier(0.65, 0, 0.35, 1)';
const DUR = { open: 260, close: 160, minimize: 240, restore: 300, flip: 260, desktop: 340 };

i18n.extend({
  en: { wm: { desktopN: 'Desktop {n}', maximizeVertically: 'Maximize vertically' } },
  fr: {
    wm: {
      minimize: 'Réduire',
      maximize: 'Agrandir',
      restore: 'Niveau inférieur',
      close: 'Fermer',
      move: 'Déplacer',
      size: 'Taille',
      snap: 'Ancrer',
      desktopN: 'Bureau {n}',
      maximizeVertically: 'Agrandir verticalement',
    },
  },
});

const SVG_MIN = '<svg viewBox="0 0 10 10"><path d="M0 5h10" stroke="currentColor" stroke-width="1"/></svg>';
const SVG_MAX = '<svg viewBox="0 0 10 10"><rect x=".5" y=".5" width="9" height="9" rx="1.5" fill="none" stroke="currentColor"/></svg>';
const SVG_RESTORE =
  '<svg viewBox="0 0 10 10"><rect x=".5" y="2.5" width="7" height="7" rx="1.5" fill="none" stroke="currentColor"/><path d="M2.5 .5h5.5a1.5 1.5 0 0 1 1.5 1.5v5.5" fill="none" stroke="currentColor"/></svg>';
const SVG_CLOSE = '<svg viewBox="0 0 10 10"><path d="M.5.5l9 9M9.5.5l-9 9" stroke="currentColor" stroke-width="1"/></svg>';

// Functional rules the wm relies on (window chrome styling itself lives in shell.css).
const CORE_CSS = `
.win.off-desktop { visibility: hidden !important; pointer-events: none !important; }
.win-ctl[hidden] { display: none !important; }
.win-body:focus, .win-body:focus-visible, .win:focus, .win:focus-visible { outline: none; }
.win.kb-moving { outline: 2px solid var(--accent); outline-offset: -2px; }
body.wm-kb-moving, body.wm-kb-moving * { cursor: move !important; }
body.wm-kb-sizing, body.wm-kb-sizing * { cursor: nwse-resize !important; }
`;

const reduceMotion = () => document.documentElement.dataset.animations === 'off';

function zBase(win) {
  if (win.fullscreen) return 200000;
  if (win.alwaysOnTop) return 100000;
  return 0;
}

// Stacking counter. It only grows, so after very many activations it is compacted (order kept) to stay
// far below the always-on-top / fullscreen bands and the shell overlays above windows.
function nextZ() {
  if (zTop >= 20000) {
    const order = wm.list().sort((a, b) => Number(a.el.style.zIndex || 0) - zBase(a) - (Number(b.el.style.zIndex || 0) - zBase(b)));
    zTop = 10;
    for (const w of order) w.el.style.zIndex = String(zBase(w) + ++zTop);
  }
  return ++zTop;
}

class Win extends Emitter {
  constructor(opts) {
    super();
    this.id = `win${++seq}`;
    this.appId = opts.appId || 'unknown';
    this.opts = {
      minWidth: 320,
      minHeight: 200,
      resizable: true,
      maximizable: true,
      minimizable: true,
      titlebar: 'default',
      background: 'mica',
      ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)),
    };
    this.title = opts.title || '';
    this.iconUrl = opts.icon || '';
    this.state = 'normal'; // normal | maximized | snapped | fullscreen
    this.minimized = false;
    this.snap = null;
    this.restoreRect = null;
    this.progress = null;
    this.alwaysOnTop = !!opts.alwaysOnTop;
    this.desktop = opts.desktop && wm.desktops.some((d) => d.id === opts.desktop) ? opts.desktop : wm.currentDesktop;
    this._beforeClose = [];
    this._closing = false;
    this._lastFocus = null;
    this.createdAt = Date.now();
    this._build();
  }

  _build() {
    const o = this.opts;
    this.iconEl = h('img', { class: 'win-icon', src: this.iconUrl || 'app://shell/assets/app-default.svg', draggable: false, alt: '' });
    this.titleEl = h('span', { class: 'win-title ellipsis' }, this.title);
    this.titlebarSlot = h('div', { class: 'win-tb-slot' });
    this.btnMin = h('button', { class: 'win-ctl win-min', tabindex: '-1', 'aria-label': t('wm.minimize'), 'data-tip': t('wm.minimize'), html: SVG_MIN, onclick: () => this.minimize() });
    this.btnMax = h('button', { class: 'win-ctl win-max', tabindex: '-1', 'aria-label': t('wm.maximize'), html: SVG_MAX, onclick: () => this.toggleMaximize() });
    this.btnClose = h('button', { class: 'win-ctl win-close', tabindex: '-1', 'aria-label': t('wm.close'), 'data-tip': t('wm.close'), html: SVG_CLOSE, onclick: () => this.close() });
    if (!o.minimizable) this.btnMin.hidden = true;
    if (!o.maximizable || !o.resizable) this.btnMax.hidden = true;
    this.controls = h('div', { class: 'win-controls' }, this.btnMin, this.btnMax, this.btnClose);
    this.titlebar = h('header', { class: 'win-titlebar' }, this.iconEl, this.titleEl, this.titlebarSlot, this.controls);
    this.body = h('div', { class: 'win-body', tabindex: '-1' });
    this.el = h(
      'section',
      {
        class: ['win', `bg-${o.background}`, `tb-${o.titlebar}`, o.className],
        role: 'dialog',
        'aria-label': this.title,
        dataset: { app: this.appId, id: this.id },
      },
      o.titlebar === 'none' ? null : this.titlebar,
      this.body,
    );
    if (o.titlebar === 'none') {
      // Floating controls when the app draws its own chrome.
      this.controls.classList.add('floating');
      this.el.appendChild(this.controls);
    }
    if (o.resizable) {
      for (const d of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
        const r = h('div', { class: `win-resize r-${d}` });
        r.addEventListener('pointerdown', (e) => this._startResize(e, d));
        // Windows: double-clicking the top or bottom border maximizes vertically (and back).
        if (d === 'n' || d === 's') r.addEventListener('dblclick', () => this.maximizeVertically());
        this.el.appendChild(r);
      }
    }
    this.makeDraggable(this.titlebar);
    this.titlebar.addEventListener('dblclick', (e) => {
      if (isInteractive(e.target)) return;
      if (this.opts.maximizable && this.opts.resizable) this.toggleMaximize();
    });
    this.titlebar.addEventListener('contextmenu', (e) => {
      if (isInteractive(e.target)) return;
      e.preventDefault();
      wm.emit('titlebar-menu', this, e);
    });
    this.iconEl.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.detail > 1) return; // second click of a double-click: that one closes the window
      wm.emit('titlebar-menu', this, e);
    });
    this.iconEl.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      this.close();
    });
    this.el.addEventListener(
      'pointerdown',
      (e) => {
        this._ptrTarget = e.target;
        this.focus();
        this._ptrTarget = null;
      },
      true,
    );
    this.el.addEventListener('focusin', (e) => {
      if (e.target !== this.body && e.target !== this.el) this._lastFocus = e.target;
      this.focus();
    });
    this.btnMax.addEventListener('mouseenter', () => wm.emit('max-hover', this, this.btnMax));
    this.btnMax.addEventListener('mouseleave', () => wm.emit('max-leave', this, this.btnMax));
  }

  // ---------------------------------------------------------------- geometry
  rect() {
    return { x: this.x, y: this.y, width: this.w, height: this.h };
  }
  _apply() {
    const s = this.el.style;
    s.left = `${this.x}px`;
    s.top = `${this.y}px`;
    s.width = `${this.w}px`;
    s.height = `${this.h}px`;
  }
  setRect({ x = this.x, y = this.y, width = this.w, height = this.h }, animate = false) {
    const prev = animate ? this.el.getBoundingClientRect() : null;
    this.x = Math.round(x);
    this.y = Math.round(y);
    this.w = Math.round(Math.max(this.opts.minWidth, width));
    this.h = Math.round(Math.max(this.opts.minHeight, height));
    this._apply();
    if (animate && !reduceMotion() && this.el.isConnected && prev.width > 0 && !this.minimized && !this.el.classList.contains('off-desktop')) {
      this._geomAnim?.cancel();
      this._geomAnim = flip(this.el, prev);
    }
    this.emit('resize', this.rect());
    this.emit('move', this.rect());
  }
  setSize(width, height) {
    this.setRect({ width, height });
  }
  /** Change the minimum size (e.g. a game board that grows); grows the window if it is smaller. */
  setMinSize(minWidth, minHeight) {
    if (minWidth != null) this.opts.minWidth = Math.max(1, Math.round(minWidth));
    if (minHeight != null) this.opts.minHeight = Math.max(1, Math.round(minHeight));
    if (this.state === 'normal' && (this.w < this.opts.minWidth || this.h < this.opts.minHeight)) {
      this.setRect({ width: Math.max(this.w, this.opts.minWidth), height: Math.max(this.h, this.opts.minHeight) });
    }
  }
  center() {
    const wa = wm.workarea();
    this.setRect({ x: wa.x + (wa.width - this.w) / 2, y: wa.y + (wa.height - this.h) / 2 });
  }
  // Keep at least a grabbable part of the title bar inside the work area (resolution changes, taskbar moves).
  _ensureVisible() {
    const wa = wm.workarea();
    const width = Math.min(this.w, wa.width);
    const height = Math.min(this.h, wa.height);
    let { x, y } = this;
    if (x > wa.x + wa.width - MIN_VISIBLE) x = wa.x + wa.width - width;
    if (x + width < wa.x + MIN_VISIBLE) x = wa.x;
    if (y < wa.y) y = wa.y;
    if (y > wa.y + wa.height - 40) y = Math.max(wa.y, wa.y + wa.height - height);
    if (x !== this.x || y !== this.y || width !== this.w || height !== this.h) this.setRect({ x, y, width, height });
  }

  // ---------------------------------------------------------------- state
  setTitle(title) {
    this.title = String(title ?? '');
    this.titleEl.textContent = this.title;
    this.el.setAttribute('aria-label', this.title);
    wm.emit('change', this);
  }
  setIcon(url) {
    this.iconUrl = url;
    this.iconEl.src = url;
    wm.emit('change', this);
  }
  setProgress(p) {
    this.progress = p == null ? null : Math.max(0, Math.min(1, p));
    wm.emit('change', this);
  }
  flash() {
    if (wm.focused() === this) return;
    this.flashing = true;
    wm.emit('change', this);
  }
  makeDraggable(el) {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || isInteractive(e.target) || e.target.closest('.win-resize')) return;
      this._startDrag(e);
    });
  }
  onBeforeClose(fn) {
    this._beforeClose.push(fn);
    return () => (this._beforeClose = this._beforeClose.filter((f) => f !== fn));
  }

  focus() {
    if (this._closing) return;
    // Activating a window that lives on another virtual desktop switches to that desktop (Windows behaviour).
    if (this.desktop !== wm.currentDesktop) wm.switchDesktop(this.desktop, { focus: this });
    if (this.minimized) this.restoreFromMinimize();
    const prev = wm._focused;
    wm._touchMru(this);
    if (prev === this && this.el.classList.contains('active')) return;
    // A click inside the app body places focus itself; activation from the title bar, the keyboard,
    // the taskbar or Alt+Tab puts the keyboard back on the window's last focused control.
    const clickInBody = this._ptrTarget && this.body.contains(this._ptrTarget);
    wm._focused = this;
    // A keyboard move/size (Alt+Space > Move) ends when another window is activated.
    if (prev && prev !== this) prev._kbMove?.finish(true);
    this.flashing = false;
    this.el.style.zIndex = String(zBase(this) + nextZ());
    for (const w of wm.list()) w.el.classList.toggle('active', w === this);
    if (prev && prev !== this) prev.emit('blur');
    this.emit('focus');
    wm.emit('focus', this);
    wm.emit('change', this);
    if (!clickInBody) this._scheduleFocusContent();
  }
  _scheduleFocusContent() {
    clearTimeout(this._fcTimer);
    this._fcTimer = setTimeout(() => {
      if (wm._focused === this && !this.minimized && !this._closing) this.focusContent();
    }, 0);
  }
  // Move keyboard focus into this window, unless it already is there or a shell surface
  // (menu, overlay, global dialog, open Start menu) currently owns the keyboard.
  focusContent() {
    const a = document.activeElement;
    const last = this._lastFocus;
    const lastOk = last?.isConnected && this.el.contains(last) && !last.closest('[hidden], .minimized');
    if (a && a !== document.body && this.el.contains(a) && !((a === this.body || a === this.el) && lastOk)) return;
    if (a && a !== document.body && (a.closest('.menu, #overlays > :not(.closing), .wm-keep-focus:not(.closing)') || a.closest('#start.open'))) return;
    if (document.querySelector('#overlays > .dialog-layer.global:not(.closing), #overlays > .wm-keep-focus:not(.closing)')) return;
    const target = (lastOk && last) || this.body.querySelector('[autofocus]') || this.body;
    try {
      target.focus({ preventScroll: true });
    } catch {}
  }
  isFocused() {
    return wm._focused === this && !this.minimized;
  }
  isMaximized() {
    return this.state === 'maximized';
  }
  isSnapped() {
    return this.state === 'snapped';
  }
  isOnCurrentDesktop() {
    return this.desktop === wm.currentDesktop;
  }

  _setMaxButton(restore) {
    this.btnMax.innerHTML = restore ? SVG_RESTORE : SVG_MAX;
    this.btnMax.setAttribute('aria-label', restore ? t('wm.restore') : t('wm.maximize'));
  }
  // Caption button labels follow a live language switch.
  _relabel() {
    for (const [b, k] of [[this.btnMin, 'wm.minimize'], [this.btnClose, 'wm.close']]) {
      b.setAttribute('aria-label', t(k));
      b.dataset.tip = t(k);
    }
    this.btnMax.setAttribute('aria-label', this.state === 'maximized' ? t('wm.restore') : t('wm.maximize'));
  }

  maximize() {
    if (!this.opts.maximizable || this.state === 'maximized') return;
    if (this.state === 'normal') this.restoreRect = this.rect();
    // Maximizing a snapped window and restoring it puts it back in its snap zone (Windows behaviour).
    this._snapBeforeMax = this.state === 'snapped' && this.snap !== 'vmax' ? this.snap : null;
    this.state = 'maximized';
    this.snap = null;
    this.el.classList.remove('snapped');
    this.el.classList.add('maximized');
    this._setMaxButton(true);
    const wa = wm.workarea();
    this.setRect({ x: wa.x, y: wa.y, width: wa.width, height: wa.height }, true);
    this.emit('maximize');
    wm.emit('change', this);
  }
  restore() {
    if (this.minimized) return this.restoreFromMinimize();
    if (this.state === 'normal') return;
    const back = this.state === 'maximized' ? this._snapBeforeMax : null;
    this._snapBeforeMax = null;
    if (back && this.opts.resizable && wm.zoneRect(back, this)) {
      this.el.classList.remove('maximized');
      this.state = 'snapped'; // keeps restoreRect: the size the window had before it was snapped
      this.emit('restore');
      return this.snapTo(back, { source: 'restore' });
    }
    this.state = 'normal';
    this.snap = null;
    this.el.classList.remove('maximized', 'snapped');
    this._setMaxButton(false);
    if (this.restoreRect) this.setRect(clampRect(this.restoreRect, wm.workarea()), true);
    this.emit('restore');
    wm.emit('change', this);
  }
  // Title bar double-click / maximize button: a snapped window shows "Maximize" and maximizes (like Windows);
  // only a maximized window restores.
  toggleMaximize() {
    if (this.state === 'maximized') this.restore();
    else this.maximize();
  }
  maximizeVertically() {
    if (!this.opts.resizable) return;
    if (this.state === 'snapped' && this.snap === 'vmax') return this.restore();
    this.snapTo('vmax', { source: 'border' });
  }

  snapTo(zone, { animate = true, source = 'api' } = {}) {
    if (!this.opts.resizable) return;
    if (zone === 'max') return this.maximize();
    const r = wm.zoneRect(zone, this);
    if (!r) return;
    if (this.state === 'normal') this.restoreRect = this.rect();
    this.state = 'snapped';
    this.snap = zone;
    this.el.classList.remove('maximized');
    this.el.classList.add('snapped');
    this._setMaxButton(false);
    this.setRect(r, animate);
    this.emit('snap', zone);
    wm.emit('snap', this, zone, { source });
    wm.emit('change', this);
  }

  _minimizeTarget(r) {
    const anchor = wm.anchorProvider?.(this);
    if (anchor && anchor.width) return { x: anchor.left + anchor.width / 2, y: anchor.top + anchor.height / 2, scale: 0.12 };
    // No taskbar button (e.g. dialogs): sink towards the bottom centre of the screen.
    return { x: r.left + r.width / 2, y: window.innerHeight - 24, scale: 0.3 };
  }

  minimize() {
    if (this.minimized || !this.opts.minimizable) return;
    this._kbMove?.finish(true);
    this.minimized = true;
    this._geomAnim?.cancel();
    const done = () => {
      if (this.minimized) this.el.classList.add('minimized');
    };
    if (!reduceMotion() && this.isOnCurrentDesktop() && this.el.isConnected) {
      const r = this.el.getBoundingClientRect();
      const tg = this._minimizeTarget(r);
      const dx = tg.x - (r.left + r.width / 2);
      const dy = tg.y - (r.top + r.height / 2);
      this._minAnim?.cancel();
      this._minAnim = this.el.animate(
        [
          { transform: 'none', opacity: 1 },
          { opacity: 1, offset: 0.45 },
          { transform: `translate(${dx}px, ${dy}px) scale(${tg.scale})`, opacity: 0 },
        ],
        { duration: DUR.minimize, easing: 'cubic-bezier(0.45, 0, 0.7, 0.35)', fill: 'forwards' },
      );
      this._minAnim.finished.then(
        () => {
          done();
          this._minAnim?.cancel();
          this._minAnim = null;
        },
        () => {},
      );
    } else done();
    if (wm._focused === this) {
      wm._focused = null;
      this.el.classList.remove('active');
      this.emit('blur');
      wm.focusTop(this);
    }
    // Stay above the window that just got focus while flying to the taskbar.
    if (this._minAnim) this.el.style.zIndex = String(zBase(this) + nextZ());
    this.emit('minimize');
    wm.emit('change', this);
  }
  restoreFromMinimize({ animate = true } = {}) {
    if (!this.minimized) return;
    this.minimized = false;
    this._minAnim?.cancel();
    this._minAnim = null;
    this.el.classList.remove('minimized');
    if (animate && !reduceMotion() && this.isOnCurrentDesktop()) {
      const r = this.el.getBoundingClientRect();
      const tg = this._minimizeTarget(r);
      const dx = tg.x - (r.left + r.width / 2);
      const dy = tg.y - (r.top + r.height / 2);
      this.el.animate(
        [
          { transform: `translate(${dx}px, ${dy}px) scale(${tg.scale})`, opacity: 0 },
          { transform: 'none', opacity: 1 },
        ],
        { duration: DUR.restore, easing: EASE },
      );
    }
    this.emit('restore');
    this.focus();
  }

  setFullscreen(on) {
    const want = !!on;
    if (want === this.el.classList.contains('fullscreen')) return;
    this.el.classList.toggle('fullscreen', want);
    this.fullscreen = want;
    this.el.style.zIndex = String(zBase(this) + nextZ());
    this.emit('fullscreen', want);
    this.emit('resize', this.rect());
    wm.emit('change', this);
  }

  async close(force = false) {
    if (this._closing) return false;
    if (!force) {
      for (const fn of this._beforeClose) {
        try {
          if ((await fn()) === false) return false;
        } catch (err) {
          console.error(err);
        }
      }
    }
    this._closing = true;
    this._kbMove?.finish(false);
    const finish = () => {
      this.el.remove();
      wm._remove(this);
    };
    this.emit('close');
    // Hand activation to the next window right away (not after the close animation): a second Alt+F4
    // pressed during the animation closes that next window, like Windows.
    if (wm._focused === this) {
      wm._focused = null;
      this.el.classList.remove('active');
      this.emit('blur');
      wm.focusTop(this);
    }
    // No close animation when hidden, or when a feature (Task View) is driving the transform itself.
    if (reduceMotion() || this.minimized || !this.isOnCurrentDesktop() || this.el.style.transform) finish();
    else {
      this.el.classList.add('closing');
      this._geomAnim?.cancel();
      this.el
        .animate(
          [
            { opacity: 1, transform: 'none' },
            { opacity: 0, transform: 'scale(0.95)' },
          ],
          { duration: DUR.close, easing: EASE_IN, fill: 'forwards' },
        )
        .finished.then(finish, finish);
    }
    return true;
  }

  // ---------------------------------------------------------------- keyboard move / size (Alt+Space menu)
  startKeyboardMove(mode = 'move') {
    if (this.fullscreen || this.minimized) return;
    if (mode === 'size' && (!this.opts.resizable || this.state === 'maximized')) return;
    if (mode === 'move' && this.state === 'maximized') return;
    this._kbMove?.finish(false);
    this.focus();
    const start = this.rect();
    const startState = { state: this.state, snap: this.snap };
    if (this.state === 'snapped') {
      this.state = 'normal';
      this.snap = null;
      this.el.classList.remove('snapped');
    }
    let edgeX = null; // 'w' | 'e'
    let edgeY = null; // 'n' | 's'
    const cls = mode === 'size' ? 'wm-kb-sizing' : 'wm-kb-moving';
    document.body.classList.add(cls);
    this.el.classList.add('kb-moving');
    if (!this.el.hasAttribute('tabindex')) this.el.setAttribute('tabindex', '-1');
    this.el.focus({ preventScroll: true });
    const onKey = (e) => {
      const step = e.ctrlKey ? 1 : 10;
      let { x, y, width, height } = this.rect();
      const k = e.key;
      if (k === 'Enter') return stop(e, true);
      if (k === 'Escape') return stop(e, false);
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(k)) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      if (mode === 'move') {
        if (k === 'ArrowLeft') x -= step;
        if (k === 'ArrowRight') x += step;
        if (k === 'ArrowUp') y -= step;
        if (k === 'ArrowDown') y += step;
        const wa = wm.workarea();
        y = Math.max(wa.y, Math.min(y, wa.y + wa.height - 32));
        x = Math.max(wa.x - width + MIN_VISIBLE, Math.min(x, wa.x + wa.width - MIN_VISIBLE));
      } else {
        // First arrow picks the edge (like Windows), later arrows move it.
        if ((k === 'ArrowLeft' || k === 'ArrowRight') && !edgeX) {
          edgeX = k === 'ArrowLeft' ? 'w' : 'e';
          return;
        }
        if ((k === 'ArrowUp' || k === 'ArrowDown') && !edgeY) {
          edgeY = k === 'ArrowUp' ? 'n' : 's';
          return;
        }
        const dx = k === 'ArrowLeft' ? -step : k === 'ArrowRight' ? step : 0;
        const dy = k === 'ArrowUp' ? -step : k === 'ArrowDown' ? step : 0;
        if (dx && edgeX === 'e') width = Math.max(this.opts.minWidth, width + dx);
        if (dx && edgeX === 'w') {
          const nw = Math.max(this.opts.minWidth, width - dx);
          x += width - nw;
          width = nw;
        }
        if (dy && edgeY === 's') height = Math.max(this.opts.minHeight, height + dy);
        if (dy && edgeY === 'n') {
          const nh = Math.max(this.opts.minHeight, height - dy);
          y += height - nh;
          height = nh;
        }
      }
      this.setRect({ x, y, width, height });
    };
    const onPointer = () => stop(null, true);
    const stop = (e, commit) => {
      if (e) {
        e.preventDefault();
        e.stopPropagation();
      }
      this._kbMove?.finish(commit);
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPointer, true);
    this._kbMove = {
      mode,
      finish: (commit) => {
        document.removeEventListener('keydown', onKey, true);
        document.removeEventListener('pointerdown', onPointer, true);
        document.body.classList.remove(cls);
        this.el.classList.remove('kb-moving');
        this._kbMove = null;
        if (!commit) {
          this.setRect(start, true);
          if (startState.state === 'snapped') {
            this.state = 'snapped';
            this.snap = startState.snap;
            this.el.classList.add('snapped');
          }
        } else if (this.state === 'normal') this.restoreRect = this.rect();
        wm.emit('change', this);
        if (wm._focused === this) this.focusContent();
      },
    };
    wm.emit('change', this);
  }

  // ---------------------------------------------------------------- pointer interactions
  _startDrag(e) {
    if (this.fullscreen) return;
    e.preventDefault();
    const target = e.currentTarget || this.titlebar;
    const startX = e.clientX;
    const startY = e.clientY;
    let ox = startX - this.x;
    let oy = startY - this.y;
    let moved = false;
    let zone = null;
    let last = null;
    let raf = 0;
    const wa = wm.workarea();
    const shake = { dir: 0, lastX: startX, turns: [] };
    const pid = e.pointerId;
    // Capture only once it really is a drag: an immediate capture would retarget plain clicks and
    // double-clicks (window icon menu / close) to the title bar.
    document.body.classList.add('wm-dragging');
    const frame = () => {
      raf = 0;
      const ev = last;
      if (!ev) return;
      let nx = ev.clientX - ox;
      let ny = ev.clientY - oy;
      ny = Math.max(wa.y, Math.min(ny, wa.y + wa.height - 32));
      nx = Math.max(wa.x - this.w + MIN_VISIBLE, Math.min(nx, wa.x + wa.width - MIN_VISIBLE));
      this.x = Math.round(nx);
      this.y = Math.round(ny);
      this._apply();
      wm.emit('drag-move', this, { x: ev.clientX, y: ev.clientY });
      if (this.opts.resizable && wm.snapEnabled !== false) {
        zone = wm.dragSnapOverride || snapZone(ev.clientX, ev.clientY, wa);
        wm._showSnapPreview(zone, this);
      }
      this.emit('move', this.rect());
    };
    const move = (ev) => {
      if (ev.pointerId !== pid) return;
      if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
      if (!moved) {
        moved = true;
        try {
          target.setPointerCapture?.(pid);
        } catch {}
        this._geomAnim?.cancel();
        if (this.state !== 'normal') {
          // Tear off from maximized/snapped state, keeping the cursor at the same relative spot.
          const rr = this.restoreRect || { width: Math.min(this.w, 900), height: Math.min(this.h, 600) };
          const ratio = (startX - this.x) / this.w;
          this.state = 'normal';
          this.snap = null;
          this.el.classList.remove('maximized', 'snapped');
          this._setMaxButton(false);
          this.w = rr.width;
          this.h = rr.height;
          ox = Math.round(rr.width * ratio);
          oy = Math.min(oy, 16);
          this.emit('restore');
          wm.emit('change', this);
        }
      }
      if (wm.shakeToMinimize) this._trackShake(shake, ev);
      last = ev;
      if (!raf) raf = requestAnimationFrame(frame);
    };
    const up = (ev) => {
      if (ev && ev.pointerId !== pid) return;
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      if (raf) {
        cancelAnimationFrame(raf);
        frame();
      }
      document.body.classList.remove('wm-dragging');
      wm._showSnapPreview(null);
      const end = { x: ev?.clientX ?? 0, y: ev?.clientY ?? 0, zone };
      if (moved && zone && ev?.type !== 'pointercancel') this.snapTo(zone, { source: 'drag' });
      else if (moved) this.restoreRect = this.rect();
      wm.dragSnapOverride = null;
      if (moved) wm.emit('drag-end', this, end);
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
  }

  // Aero shake: 4 quick horizontal direction changes within 600ms minimise every other window (again: restore).
  _trackShake(s, ev) {
    const dx = ev.clientX - s.lastX;
    if (Math.abs(dx) < 12) return;
    const dir = Math.sign(dx);
    s.lastX = ev.clientX;
    if (dir !== s.dir) {
      s.dir = dir;
      const now = performance.now();
      s.turns = s.turns.filter((tm) => now - tm < 600);
      s.turns.push(now);
      if (s.turns.length >= 5) {
        s.turns = [];
        wm._shake(this);
      }
    }
  }

  _startResize(e, dir) {
    if (e.button !== 0 || this.state === 'maximized' || this.fullscreen) return;
    e.preventDefault();
    e.stopPropagation();
    this.focus();
    this._geomAnim?.cancel();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    document.body.classList.add('wm-dragging');
    const start = { x: e.clientX, y: e.clientY, r: this.rect() };
    const { minWidth, minHeight } = this.opts;
    const wa = wm.workarea();
    let last = null;
    let raf = 0;
    let resized = false;
    const frame = () => {
      raf = 0;
      const ev = last;
      if (!ev) return;
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      let { x, y, width, height } = start.r;
      if (dir.includes('e')) width = Math.max(minWidth, width + dx);
      if (dir.includes('s')) height = Math.max(minHeight, height + dy);
      if (dir.includes('w')) {
        const nw = Math.max(minWidth, width - dx);
        x += width - nw;
        width = nw;
      }
      if (dir.includes('n')) {
        const nh = Math.max(minHeight, height - dy);
        y += height - nh;
        height = nh;
      }
      if (y < wa.y) {
        height += y - wa.y;
        y = wa.y;
      }
      this.x = Math.round(x);
      this.y = Math.round(y);
      this.w = Math.round(width);
      this.h = Math.round(height);
      this._apply();
      this.emit('resize', this.rect());
    };
    const move = (ev) => {
      resized = true;
      last = ev;
      if (!raf) raf = requestAnimationFrame(frame);
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      if (raf) {
        cancelAnimationFrame(raf);
        frame();
      }
      document.body.classList.remove('wm-dragging');
      if (!resized) return; // a plain click (or the first half of a double-click) keeps the snap state
      this.state = 'normal';
      this.snap = null;
      this.el.classList.remove('snapped');
      this.restoreRect = this.rect();
      wm.emit('change', this);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }
}

function isInteractive(el) {
  return !!el.closest?.('button, input, select, textarea, a, [contenteditable="true"], [data-no-drag], .win-controls, webview, iframe, .no-drag');
}

// Desktop names: plain strings, trimmed, at most 100 characters (null = default "Desktop N").
function cleanName(name) {
  return typeof name === 'string' || typeof name === 'number' ? String(name).trim().slice(0, 100) || null : null;
}

function clampRect(r, wa) {
  const width = Math.min(r.width, wa.width);
  const height = Math.min(r.height, wa.height);
  let { x, y } = r;
  if (x > wa.x + wa.width - MIN_VISIBLE) x = wa.x + wa.width - width;
  if (x + width < wa.x + MIN_VISIBLE) x = wa.x;
  if (y < wa.y) y = wa.y;
  if (y > wa.y + wa.height - 40) y = Math.max(wa.y, wa.y + wa.height - height);
  return { x, y, width, height };
}

function snapZone(x, y, wa) {
  const E = 6;
  const C = 60;
  const left = x <= wa.x + E;
  const right = x >= wa.x + wa.width - E;
  const top = y <= wa.y + E;
  if (left && y < wa.y + C) return 'tl';
  if (left && y > wa.y + wa.height - C) return 'bl';
  if (right && y < wa.y + C) return 'tr';
  if (right && y > wa.y + wa.height - C) return 'br';
  if (left) return 'left';
  if (right) return 'right';
  if (top) return 'max';
  return null;
}

// FLIP animation from a previous bounding rect to the element's current one.
function flip(el, prev) {
  const next = el.getBoundingClientRect();
  if (!next.width || !next.height) return null;
  const sx = prev.width / next.width;
  const sy = prev.height / next.height;
  const dx = prev.left - next.left;
  const dy = prev.top - next.top;
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) return null;
  return el.animate(
    [
      { transformOrigin: 'top left', transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
      { transformOrigin: 'top left', transform: 'none' },
    ],
    { duration: DUR.flip, easing: EASE },
  );
}

class WindowManager extends Emitter {
  constructor() {
    super();
    this.windows = new Map();
    this._focused = null;
    this._mru = [];
    this.layer = null;
    this.anchorProvider = null;
    this.insets = { top: 0, bottom: 48, left: 0, right: 0 };
    this._desktopShown = null;
    this.desktops = [{ id: 'd1', name: null }];
    this.currentDesktop = 'd1';
    this.dragSnapOverride = null;
    this.snapEnabled = true;
    this.shakeToMinimize = false;
    this._shaken = null;
  }
  mount(layer) {
    this.layer = layer;
    if (!document.getElementById('wm-core-css')) document.head.appendChild(h('style', { id: 'wm-core-css' }, CORE_CSS));
    this.snapPreview = h('div', { class: 'snap-preview' });
    layer.appendChild(this.snapPreview);
    window.addEventListener('resize', () => this._refit());
    i18n.on('change', () => {
      for (const w of this.list()) w._relabel();
    });
    // Focus moving into a <webview>/<iframe> never fires focusin in the shell document; the shell
    // window just blurs. Catch that and activate the window that owns the embedded content.
    window.addEventListener('blur', () =>
      setTimeout(() => {
        const a = document.activeElement;
        if (!a || (a.tagName !== 'WEBVIEW' && a.tagName !== 'IFRAME')) return;
        const el = a.closest('.win');
        const w = el && this.get(el.dataset.id);
        if (w && this._focused !== w) {
          w._lastFocus = a;
          w.focus();
        }
      }, 0),
    );
  }
  setInsets(insets) {
    Object.assign(this.insets, insets);
    this._refit();
  }
  workarea() {
    const i = this.insets;
    return { x: i.left, y: i.top, width: window.innerWidth - i.left - i.right, height: window.innerHeight - i.top - i.bottom };
  }
  // Rectangle of a snap zone in the current work area ('vmax' keeps the window's own x/width).
  zoneRect(zone, win) {
    const wa = this.workarea();
    const hw = Math.round(wa.width / 2);
    const hh = Math.round(wa.height / 2);
    const t3 = Math.round(wa.width / 3);
    const q = Math.round(wa.width / 4);
    const R = (x, y, width, height) => ({ x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) });
    switch (zone) {
      case 'max':
        return R(wa.x, wa.y, wa.width, wa.height);
      case 'left':
        return R(wa.x, wa.y, hw, wa.height);
      case 'right':
        return R(wa.x + hw, wa.y, wa.width - hw, wa.height);
      case 'tl':
        return R(wa.x, wa.y, hw, hh);
      case 'tr':
        return R(wa.x + hw, wa.y, wa.width - hw, hh);
      case 'bl':
        return R(wa.x, wa.y + hh, hw, wa.height - hh);
      case 'br':
        return R(wa.x + hw, wa.y + hh, wa.width - hw, wa.height - hh);
      case 'third-l':
        return R(wa.x, wa.y, t3, wa.height);
      case 'third-c':
        return R(wa.x + t3, wa.y, t3, wa.height);
      case 'third-r':
        return R(wa.x + 2 * t3, wa.y, wa.width - 2 * t3, wa.height);
      case 'two-thirds-l':
        return R(wa.x, wa.y, wa.width - t3, wa.height);
      case 'two-thirds-r':
        return R(wa.x + t3, wa.y, wa.width - t3, wa.height);
      case 'quarter-l':
        return R(wa.x, wa.y, q, wa.height);
      case 'half-c':
        return R(wa.x + q, wa.y, wa.width - 2 * q, wa.height);
      case 'quarter-r':
        return R(wa.x + wa.width - q, wa.y, q, wa.height);
      case 'vmax': {
        const x = win ? win.x : wa.x;
        const width = win ? win.w : hw;
        return R(Math.max(wa.x, Math.min(x, wa.x + wa.width - width)), wa.y, Math.min(width, wa.width), wa.height);
      }
      default:
        return null;
    }
  }
  create(opts = {}) {
    const win = new Win(opts);
    const wa = this.workarea();
    const w = Math.min(opts.width || 800, wa.width - 16);
    const hgt = Math.min(opts.height || 560, wa.height - 16);
    let x = opts.x;
    let y = opts.y;
    if (x == null || y == null) {
      const off = (cascade++ % 8) * 28;
      x = wa.x + Math.max(8, (wa.width - w) / 2 - 84 + off);
      y = wa.y + Math.max(8, (wa.height - hgt) / 2 - 64 + off);
      if (x + w > wa.x + wa.width) x = wa.x + 8;
      if (y + hgt > wa.y + wa.height) y = wa.y + 8;
    }
    win.x = Math.round(x);
    win.y = Math.round(y);
    win.w = Math.round(Math.max(win.opts.minWidth, w));
    win.h = Math.round(Math.max(win.opts.minHeight, hgt));
    if (opts.maximized && win.opts.maximizable) {
      // Open straight into the maximized state (no open + maximize double animation).
      win.restoreRect = win.rect();
      win.state = 'maximized';
      win.el.classList.add('maximized');
      win._setMaxButton(true);
      Object.assign(win, { x: wa.x, y: wa.y, w: wa.width, h: wa.height });
    }
    win._apply();
    if (win.desktop !== this.currentDesktop) win.el.classList.add('off-desktop');
    this.windows.set(win.id, win);
    this.layer.appendChild(win.el);
    if (!reduceMotion() && win.desktop === this.currentDesktop) {
      win.el.animate(
        [
          { opacity: 0, transform: 'scale(0.94) translateY(8px)' },
          { opacity: 1, transform: 'none' },
        ],
        { duration: DUR.open, easing: EASE },
      );
    }
    if (win.desktop === this.currentDesktop) win.focus();
    this._desktopShown = null;
    this.emit('open', win);
    this.emit('change', win);
    return win;
  }
  _remove(win) {
    this.windows.delete(win.id);
    this._mru = this._mru.filter((w) => w !== win);
    if (this._focused === win) {
      this._focused = null;
      this.focusTop();
    }
    this.emit('close', win);
    this.emit('change', win);
  }
  _touchMru(win) {
    if (this._mru[0] === win) return;
    this._mru = [win, ...this._mru.filter((w) => w !== win)];
  }
  list() {
    return [...this.windows.values()];
  }
  get(id) {
    return this.windows.get(id);
  }
  byApp(appId) {
    return this.list().filter((w) => w.appId === appId);
  }
  focused() {
    return this._focused;
  }
  // Windows sorted top-most first.
  stack() {
    return this.list().sort((a, b) => Number(b.el.style.zIndex || 0) - Number(a.el.style.zIndex || 0));
  }
  // Most recently used first (Alt+Tab order). Windows never focused follow in stacking order.
  mru({ desktop = this.currentDesktop, includeMinimized = true } = {}) {
    const seen = new Set(this._mru);
    const all = [...this._mru.filter((w) => this.windows.has(w.id)), ...this.stack().filter((w) => !seen.has(w))];
    return all.filter((w) => !w._closing && (desktop == null || w.desktop === desktop) && (includeMinimized || !w.minimized));
  }
  focusTop(except) {
    const next = this.mru({ includeMinimized: false }).find((w) => w !== except);
    if (next) next.focus();
    else {
      this._focused = null;
      for (const w of this.list()) w.el.classList.remove('active');
      this.emit('focus', null);
    }
  }
  minimizeAll() {
    for (const w of this.listDesktop()) w.minimize();
  }
  // End any keyboard move/size in progress (a shell surface such as Alt+Tab or Task View takes the keyboard).
  endKeyboardMove(commit = true) {
    for (const w of this.list()) w._kbMove?.finish(commit);
  }
  // Win+D: minimise everything, press again to bring the same windows back.
  toggleDesktop() {
    if (this._desktopShown) {
      const ids = this._desktopShown;
      this._desktopShown = null;
      for (const id of ids) this.get(id)?.restoreFromMinimize();
      return;
    }
    const vis = this.stack().filter((w) => !w.minimized && w.desktop === this.currentDesktop);
    this._desktopShown = vis.reverse().map((w) => w.id);
    for (const w of vis) w.minimize();
  }
  _shake(win) {
    if (this._shaken?.by === win.id) {
      const ids = this._shaken.ids;
      this._shaken = null;
      for (const id of ids) this.get(id)?.restoreFromMinimize();
      win.focus();
      return;
    }
    const others = this.listDesktop().filter((w) => w !== win && !w.minimized);
    if (!others.length) return;
    this._shaken = { by: win.id, ids: others.map((w) => w.id) };
    for (const w of others) w.minimize();
  }

  // ---------------------------------------------------------------- virtual desktops
  listDesktop(id = this.currentDesktop) {
    return this.list().filter((w) => w.desktop === id);
  }
  desktopIndex(id) {
    return this.desktops.findIndex((d) => d.id === id);
  }
  desktopName(id) {
    const i = this.desktopIndex(id);
    if (i < 0) return '';
    return this.desktops[i].name || t('wm.desktopN', { n: i + 1 });
  }
  createDesktop(name = null) {
    const d = { id: `d${++dseq}`, name: cleanName(name) };
    this.desktops.push(d);
    this.emit('desktops', this.desktops);
    return d;
  }
  renameDesktop(id, name) {
    const d = this.desktops.find((x) => x.id === id);
    if (!d) return;
    d.name = cleanName(name);
    this.emit('desktops', this.desktops);
  }
  removeDesktop(id, { animate = true } = {}) {
    const i = this.desktopIndex(id);
    if (i < 0 || this.desktops.length < 2) return false;
    // Windows merge into the neighbour on the left (or the right for the first desktop).
    const fallback = this.desktops[i > 0 ? i - 1 : 1].id;
    if (this.currentDesktop === id) this.switchDesktop(fallback, { animate });
    for (const w of this.listDesktop(id)) this.moveToDesktop(w, fallback);
    this.desktops.splice(i, 1);
    this.emit('desktops', this.desktops);
    return true;
  }
  moveToDesktop(win, id) {
    if (!win || win.desktop === id || this.desktopIndex(id) < 0) return;
    win.desktop = id;
    const here = id === this.currentDesktop;
    win.el.classList.toggle('off-desktop', !here);
    if (!here && this._focused === win) {
      this._focused = null;
      win.el.classList.remove('active');
      win.emit('blur');
      this.focusTop(win);
    }
    this.emit('change', win);
  }
  switchDesktop(id, { animate = true, focus = null } = {}) {
    if (id === this.currentDesktop || this.desktopIndex(id) < 0) return;
    const prevId = this.currentDesktop;
    const dir = this.desktopIndex(id) > this.desktopIndex(prevId) ? 1 : -1;
    this.currentDesktop = id;
    this._desktopShown = null;
    const W = window.innerWidth;
    const anim = animate && !reduceMotion();
    const outgoing = this.listDesktop(prevId);
    const incoming = this.listDesktop(id);
    for (const w of outgoing) {
      w._deskAnim?.cancel();
      if (w.minimized || !anim) {
        w.el.classList.add('off-desktop');
        continue;
      }
      const a = w.el.animate([{ transform: 'none' }, { transform: `translateX(${-dir * W}px)` }], { duration: DUR.desktop, easing: EASE_IN_OUT, fill: 'forwards' });
      w._deskAnim = a;
      a.finished.then(
        () => {
          if (w.desktop !== this.currentDesktop) w.el.classList.add('off-desktop');
          a.cancel();
        },
        () => {},
      );
    }
    for (const w of incoming) {
      w._deskAnim?.cancel();
      w.el.classList.remove('off-desktop');
      if (!w.minimized && anim) {
        w._deskAnim = w.el.animate([{ transform: `translateX(${dir * W}px)` }, { transform: 'none' }], { duration: DUR.desktop, easing: EASE_IN_OUT });
      }
    }
    const prevFocused = this._focused;
    if (prevFocused && prevFocused.desktop !== id) {
      this._focused = null;
      prevFocused.el.classList.remove('active');
      prevFocused.emit('blur');
    }
    const next = focus && focus.desktop === id ? focus : this.mru({ desktop: id, includeMinimized: false })[0];
    if (next) next.focus();
    else {
      for (const w of this.list()) w.el.classList.remove('active');
      this.emit('focus', null);
    }
    this.emit('desktop', { current: id, previous: prevId, desktops: this.desktops });
    for (const w of [...outgoing, ...incoming]) this.emit('change', w);
  }

  _showSnapPreview(zone, win) {
    const p = this.snapPreview;
    if (!p) return;
    const r = zone && this.zoneRect(zone, win);
    if (!r) {
      p.classList.remove('show');
      return;
    }
    Object.assign(p.style, { left: `${r.x + 6}px`, top: `${r.y + 6}px`, width: `${r.width - 12}px`, height: `${r.height - 12}px` });
    p.classList.add('show');
  }
  _refit() {
    const wa = this.workarea();
    for (const w of this.list()) {
      if (w.restoreRect) w.restoreRect = clampRect(w.restoreRect, wa);
      if (w.fullscreen) continue;
      if (w.state === 'maximized') w.setRect({ x: wa.x, y: wa.y, width: wa.width, height: wa.height });
      else if (w.state === 'snapped' && w.snap) w.snapTo(w.snap, { animate: false, source: 'refit' });
      else w._ensureVisible();
    }
  }
}

export const wm = new WindowManager();
export { Win };
