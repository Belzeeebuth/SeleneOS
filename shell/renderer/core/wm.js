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
//   });
//   win.body                -> content element (flex column, fills the window)
//   win.titlebarSlot        -> element inside the title bar for tabs / search boxes
//   win.setTitle(s) win.setIcon(url) win.focus() win.minimize() win.maximize() win.restore()
//   win.toggleMaximize() win.close(force) win.setSize(w, h) win.center() win.setFullscreen(bool)
//   win.setProgress(0..1 | null)  win.flash()  win.makeDraggable(el)
//   win.onBeforeClose(async () => boolean)   -> return false to cancel closing
//   win.on('focus'|'blur'|'resize'|'move'|'minimize'|'restore'|'maximize'|'close'|'fullscreen', fn)
//   wm.list() wm.focused() wm.get(id) wm.byApp(appId) wm.minimizeAll() wm.toggleDesktop()
//   wm.on('open'|'close'|'focus'|'change', fn)
//   wm.anchorProvider = (win) => DOMRect | null      (set by the taskbar for minimize animations)
//   wm.workarea() -> {x, y, width, height}
import { Emitter } from './api.js';
import { h, icon } from './ui.js';
import { t } from './i18n.js';

const MIN_VISIBLE = 64;
let seq = 0;
let zTop = 10;
let cascade = 0;

const SVG_MIN = '<svg viewBox="0 0 10 10"><path d="M0 5h10" stroke="currentColor" stroke-width="1"/></svg>';
const SVG_MAX = '<svg viewBox="0 0 10 10"><rect x=".5" y=".5" width="9" height="9" rx="1.5" fill="none" stroke="currentColor"/></svg>';
const SVG_RESTORE =
  '<svg viewBox="0 0 10 10"><rect x=".5" y="2.5" width="7" height="7" rx="1.5" fill="none" stroke="currentColor"/><path d="M2.5 .5h5.5a1.5 1.5 0 0 1 1.5 1.5v5.5" fill="none" stroke="currentColor"/></svg>';
const SVG_CLOSE = '<svg viewBox="0 0 10 10"><path d="M.5.5l9 9M9.5.5l-9 9" stroke="currentColor" stroke-width="1"/></svg>';

const reduceMotion = () => document.documentElement.dataset.animations === 'off';

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
    this._beforeClose = [];
    this._closing = false;
    this.createdAt = Date.now();
    this._build();
  }

  _build() {
    const o = this.opts;
    this.iconEl = h('img', { class: 'win-icon', src: this.iconUrl || 'app://shell/assets/app-default.svg', draggable: false, alt: '' });
    this.titleEl = h('span', { class: 'win-title ellipsis' }, this.title);
    this.titlebarSlot = h('div', { class: 'win-tb-slot' });
    this.btnMin = h('button', { class: 'win-ctl win-min', tabindex: '-1', 'aria-label': t('wm.minimize'), html: SVG_MIN, onclick: () => this.minimize() });
    this.btnMax = h('button', { class: 'win-ctl win-max', tabindex: '-1', 'aria-label': t('wm.maximize'), html: SVG_MAX, onclick: () => this.toggleMaximize() });
    this.btnClose = h('button', { class: 'win-ctl win-close', tabindex: '-1', 'aria-label': t('wm.close'), html: SVG_CLOSE, onclick: () => this.close() });
    if (!o.minimizable) this.btnMin.hidden = true;
    if (!o.maximizable || !o.resizable) this.btnMax.hidden = true;
    this.controls = h('div', { class: 'win-controls' }, this.btnMin, this.btnMax, this.btnClose);
    this.titlebar = h('header', { class: 'win-titlebar' }, this.iconEl, this.titleEl, this.titlebarSlot, this.controls);
    this.body = h('div', { class: 'win-body' });
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
    this.iconEl.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      this.close();
    });
    this.el.addEventListener('pointerdown', () => this.focus(), true);
    this.el.addEventListener('focusin', () => this.focus());
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
    const prev = this.el.getBoundingClientRect();
    this.x = Math.round(x);
    this.y = Math.round(y);
    this.w = Math.round(Math.max(this.opts.minWidth, width));
    this.h = Math.round(Math.max(this.opts.minHeight, height));
    this._apply();
    if (animate && !reduceMotion() && this.el.isConnected && prev.width > 0) flip(this.el, prev);
    this.emit('resize', this.rect());
    this.emit('move', this.rect());
  }
  setSize(width, height) {
    this.setRect({ width, height });
  }
  center() {
    const wa = wm.workarea();
    this.setRect({ x: wa.x + (wa.width - this.w) / 2, y: wa.y + (wa.height - this.h) / 2 });
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
    if (this.minimized) this.restoreFromMinimize();
    const prev = wm._focused;
    if (prev === this && this.el.classList.contains('active')) return;
    wm._focused = this;
    this.flashing = false;
    this.el.style.zIndex = String((this.alwaysOnTop ? 100000 : 0) + ++zTop);
    for (const w of wm.list()) w.el.classList.toggle('active', w === this);
    if (prev && prev !== this) prev.emit('blur');
    this.emit('focus');
    wm.emit('focus', this);
    wm.emit('change', this);
  }
  isFocused() {
    return wm._focused === this && !this.minimized;
  }
  isMaximized() {
    return this.state === 'maximized';
  }

  maximize() {
    if (!this.opts.maximizable || this.state === 'maximized') return;
    if (this.state === 'normal') this.restoreRect = this.rect();
    this.state = 'maximized';
    this.snap = null;
    this.el.classList.add('maximized');
    this.btnMax.innerHTML = SVG_RESTORE;
    this.btnMax.setAttribute('aria-label', t('wm.restore'));
    const wa = wm.workarea();
    this.setRect({ x: wa.x, y: wa.y, width: wa.width, height: wa.height }, true);
    this.emit('maximize');
    wm.emit('change', this);
  }
  restore() {
    if (this.minimized) return this.restoreFromMinimize();
    if (this.state === 'normal') return;
    this.state = 'normal';
    this.snap = null;
    this.el.classList.remove('maximized', 'snapped');
    this.btnMax.innerHTML = SVG_MAX;
    this.btnMax.setAttribute('aria-label', t('wm.maximize'));
    if (this.restoreRect) this.setRect(this.restoreRect, true);
    this.emit('restore');
    wm.emit('change', this);
  }
  toggleMaximize() {
    if (this.state === 'normal') this.maximize();
    else this.restore();
  }

  snapTo(zone) {
    if (!this.opts.resizable) return;
    if (zone === 'max') return this.maximize();
    const wa = wm.workarea();
    const half = { w: Math.round(wa.width / 2), h: Math.round(wa.height / 2) };
    const r = {
      left: { x: wa.x, y: wa.y, width: half.w, height: wa.height },
      right: { x: wa.x + half.w, y: wa.y, width: wa.width - half.w, height: wa.height },
      tl: { x: wa.x, y: wa.y, width: half.w, height: half.h },
      tr: { x: wa.x + half.w, y: wa.y, width: wa.width - half.w, height: half.h },
      bl: { x: wa.x, y: wa.y + half.h, width: half.w, height: wa.height - half.h },
      br: { x: wa.x + half.w, y: wa.y + half.h, width: wa.width - half.w, height: wa.height - half.h },
      'third-l': { x: wa.x, y: wa.y, width: Math.round(wa.width / 3), height: wa.height },
      'third-c': { x: wa.x + Math.round(wa.width / 3), y: wa.y, width: Math.round(wa.width / 3), height: wa.height },
      'third-r': { x: wa.x + 2 * Math.round(wa.width / 3), y: wa.y, width: wa.width - 2 * Math.round(wa.width / 3), height: wa.height },
      'two-thirds-l': { x: wa.x, y: wa.y, width: Math.round((wa.width * 2) / 3), height: wa.height },
      'two-thirds-r': { x: wa.x + Math.round(wa.width / 3), y: wa.y, width: wa.width - Math.round(wa.width / 3), height: wa.height },
    }[zone];
    if (!r) return;
    if (this.state === 'normal') this.restoreRect = this.rect();
    this.state = 'snapped';
    this.snap = zone;
    this.el.classList.remove('maximized');
    this.el.classList.add('snapped');
    this.btnMax.innerHTML = SVG_MAX;
    this.setRect(r, true);
    wm.emit('change', this);
  }

  minimize() {
    if (this.minimized || !this.opts.minimizable) return;
    this.minimized = true;
    const anchor = wm.anchorProvider?.(this);
    const done = () => {
      if (this.minimized) this.el.classList.add('minimized');
    };
    if (!reduceMotion() && anchor) {
      const r = this.el.getBoundingClientRect();
      const dx = anchor.left + anchor.width / 2 - (r.left + r.width / 2);
      const dy = anchor.top + anchor.height / 2 - (r.top + r.height / 2);
      this.el
        .animate(
          [
            { transform: 'none', opacity: 1 },
            { transform: `translate(${dx}px, ${dy}px) scale(0.12)`, opacity: 0 },
          ],
          { duration: 260, easing: 'cubic-bezier(0.7, 0, 0.84, 0)' },
        )
        .finished.then(done, done);
    } else done();
    if (wm._focused === this) {
      wm._focused = null;
      this.el.classList.remove('active');
      this.emit('blur');
      wm.focusTop(this);
    }
    this.emit('minimize');
    wm.emit('change', this);
  }
  restoreFromMinimize() {
    if (!this.minimized) return;
    this.minimized = false;
    this.el.classList.remove('minimized');
    const anchor = wm.anchorProvider?.(this);
    if (!reduceMotion() && anchor) {
      const r = this.el.getBoundingClientRect();
      const dx = anchor.left + anchor.width / 2 - (r.left + r.width / 2);
      const dy = anchor.top + anchor.height / 2 - (r.top + r.height / 2);
      this.el.animate(
        [
          { transform: `translate(${dx}px, ${dy}px) scale(0.12)`, opacity: 0 },
          { transform: 'none', opacity: 1 },
        ],
        { duration: 280, easing: 'cubic-bezier(0.1, 0.9, 0.2, 1)' },
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
    if (want) this.el.style.zIndex = String(200000 + ++zTop);
    else this.el.style.zIndex = String(++zTop);
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
    const finish = () => {
      this.el.remove();
      wm._remove(this);
    };
    this.emit('close');
    if (reduceMotion() || this.minimized) finish();
    else {
      this.el.classList.add('closing');
      this.el
        .animate(
          [
            { opacity: 1, transform: 'none' },
            { opacity: 0, transform: 'scale(0.94)' },
          ],
          { duration: 140, easing: 'cubic-bezier(0.7, 0, 1, 0.5)', fill: 'forwards' },
        )
        .finished.then(finish, finish);
    }
    return true;
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
    const wa = wm.workarea();
    target.setPointerCapture?.(e.pointerId);
    document.body.classList.add('wm-dragging');
    const move = (ev) => {
      if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
      if (!moved) {
        moved = true;
        if (this.state !== 'normal') {
          // Tear off from maximized/snapped state, keeping the cursor at the same relative spot.
          const rr = this.restoreRect || { width: Math.min(this.w, 900), height: Math.min(this.h, 600) };
          const ratio = (startX - this.x) / this.w;
          this.state = 'normal';
          this.snap = null;
          this.el.classList.remove('maximized', 'snapped');
          this.btnMax.innerHTML = SVG_MAX;
          this.w = rr.width;
          this.h = rr.height;
          ox = Math.round(rr.width * ratio);
          oy = Math.min(oy, 16);
          wm.emit('change', this);
        }
      }
      let nx = ev.clientX - ox;
      let ny = ev.clientY - oy;
      ny = Math.max(wa.y, Math.min(ny, wa.y + wa.height - 32));
      nx = Math.max(wa.x - this.w + MIN_VISIBLE, Math.min(nx, wa.x + wa.width - MIN_VISIBLE));
      this.x = nx;
      this.y = ny;
      this._apply();
      if (this.opts.resizable) {
        zone = snapZone(ev.clientX, ev.clientY, wa);
        wm._showSnapPreview(zone);
      }
      this.emit('move', this.rect());
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      document.body.classList.remove('wm-dragging');
      wm._showSnapPreview(null);
      if (moved && zone) this.snapTo(zone);
      else if (moved) this.restoreRect = this.rect();
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  }

  _startResize(e, dir) {
    if (e.button !== 0 || this.state === 'maximized' || this.fullscreen) return;
    e.preventDefault();
    e.stopPropagation();
    this.focus();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    document.body.classList.add('wm-dragging');
    const start = { x: e.clientX, y: e.clientY, r: this.rect() };
    const { minWidth, minHeight } = this.opts;
    const move = (ev) => {
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
      if (y < 0) {
        height += y;
        y = 0;
      }
      this.x = Math.round(x);
      this.y = Math.round(y);
      this.w = Math.round(width);
      this.h = Math.round(height);
      this._apply();
      this.emit('resize', this.rect());
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      document.body.classList.remove('wm-dragging');
      this.state = 'normal';
      this.snap = null;
      this.el.classList.remove('snapped');
      this.restoreRect = this.rect();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }
}

function isInteractive(el) {
  return !!el.closest?.('button, input, select, textarea, a, [contenteditable="true"], [data-no-drag], .win-controls, webview, iframe, .no-drag');
}

function snapZone(x, y, wa) {
  const E = 6;
  const C = 60;
  const left = x <= wa.x + E;
  const right = x >= wa.x + wa.width - E;
  const top = y <= wa.y + E;
  const bottom = y >= wa.y + wa.height - E;
  if (left && y < wa.y + C) return 'tl';
  if (left && y > wa.y + wa.height - C) return 'bl';
  if (right && y < wa.y + C) return 'tr';
  if (right && y > wa.y + wa.height - C) return 'br';
  if (left) return 'left';
  if (right) return 'right';
  if (top) return 'max';
  if (bottom && false) return null;
  return null;
}

// FLIP animation from a previous bounding rect to the element's current one.
function flip(el, prev) {
  const next = el.getBoundingClientRect();
  if (!next.width || !next.height) return;
  const sx = prev.width / next.width;
  const sy = prev.height / next.height;
  const dx = prev.left - next.left;
  const dy = prev.top - next.top;
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) return;
  el.animate(
    [
      { transformOrigin: 'top left', transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
      { transformOrigin: 'top left', transform: 'none' },
    ],
    { duration: 240, easing: 'cubic-bezier(0.1, 0.9, 0.2, 1)' },
  );
}

class WindowManager extends Emitter {
  constructor() {
    super();
    this.windows = new Map();
    this._focused = null;
    this.layer = null;
    this.anchorProvider = null;
    this.insets = { top: 0, bottom: 48, left: 0, right: 0 };
    this._desktopShown = null;
  }
  mount(layer) {
    this.layer = layer;
    this.snapPreview = h('div', { class: 'snap-preview' });
    layer.appendChild(this.snapPreview);
    window.addEventListener('resize', () => this._refit());
  }
  setInsets(insets) {
    Object.assign(this.insets, insets);
    this._refit();
  }
  workarea() {
    const i = this.insets;
    return { x: i.left, y: i.top, width: window.innerWidth - i.left - i.right, height: window.innerHeight - i.top - i.bottom };
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
    win._apply();
    this.windows.set(win.id, win);
    this.layer.appendChild(win.el);
    if (!reduceMotion()) {
      win.el.animate(
        [
          { opacity: 0, transform: 'scale(0.92) translateY(10px)' },
          { opacity: 1, transform: 'none' },
        ],
        { duration: 220, easing: 'cubic-bezier(0.1, 0.9, 0.2, 1)' },
      );
    }
    if (opts.maximized) win.maximize();
    win.focus();
    this._desktopShown = null;
    this.emit('open', win);
    this.emit('change', win);
    return win;
  }
  _remove(win) {
    this.windows.delete(win.id);
    if (this._focused === win) {
      this._focused = null;
      this.focusTop();
    }
    this.emit('close', win);
    this.emit('change', win);
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
  focusTop(except) {
    const next = this.stack().find((w) => w !== except && !w.minimized && !w._closing);
    if (next) next.focus();
    else {
      this._focused = null;
      for (const w of this.list()) w.el.classList.remove('active');
      this.emit('focus', null);
    }
  }
  minimizeAll() {
    for (const w of this.list()) w.minimize();
  }
  // Win+D: minimise everything, press again to bring the same windows back.
  toggleDesktop() {
    if (this._desktopShown) {
      const ids = this._desktopShown;
      this._desktopShown = null;
      for (const id of ids) this.get(id)?.restoreFromMinimize();
      return;
    }
    const vis = this.stack().filter((w) => !w.minimized);
    this._desktopShown = vis.reverse().map((w) => w.id);
    for (const w of vis) w.minimize();
  }
  _showSnapPreview(zone) {
    const p = this.snapPreview;
    if (!zone) {
      p.classList.remove('show');
      return;
    }
    const wa = this.workarea();
    const hw = wa.width / 2;
    const hh = wa.height / 2;
    const r = {
      max: [wa.x, wa.y, wa.width, wa.height],
      left: [wa.x, wa.y, hw, wa.height],
      right: [wa.x + hw, wa.y, hw, wa.height],
      tl: [wa.x, wa.y, hw, hh],
      tr: [wa.x + hw, wa.y, hw, hh],
      bl: [wa.x, wa.y + hh, hw, hh],
      br: [wa.x + hw, wa.y + hh, hw, hh],
    }[zone];
    Object.assign(p.style, { left: `${r[0] + 6}px`, top: `${r[1] + 6}px`, width: `${r[2] - 12}px`, height: `${r[3] - 12}px` });
    p.classList.add('show');
  }
  _refit() {
    const wa = this.workarea();
    for (const w of this.list()) {
      if (w.state === 'maximized') w.setRect({ x: wa.x, y: wa.y, width: wa.width, height: wa.height });
      else if (w.state === 'snapped' && w.snap) w.snapTo(w.snap);
      else if (w.x > wa.x + wa.width - MIN_VISIBLE || w.y > wa.y + wa.height - 32) w.center();
    }
  }
}

export const wm = new WindowManager();
export { Win };
