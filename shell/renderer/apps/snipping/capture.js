// Screen snipping: optional delay countdown, frozen full-screen capture (shell:capture) and the
// Windows 11-style selection overlay (Rectangle / Window / Full screen / Free-form).
//
//   const s = new SnipSession({ api, h, icon, t, mode, delay, exclude: win, onMode, settle });
//     settle: ms to wait after hiding the app window before the screen is grabbed (lets the
//     taskbar finish animating a button out)
//   const res = await s.run();   // -> { canvas, mode, rect } | null when cancelled (Esc, X, s.cancel())
//   s.cancel();                  // window closed, screen locked, …
//
// The overlay lives in #overlays (above windows, the taskbar and toasts) and shows the frozen
// screenshot dimmed, with the selection bright. Coordinates are CSS pixels; the screenshot is in
// device pixels (scale = bitmap width / viewport width), so the snip keeps the full resolution.
import { wm } from '../../core/wm.js';
import { ui } from '../../core/ui.js';

export const MODES = ['rect', 'window', 'full', 'free'];
export const MODE_ICONS = { rect: 'rectangle_landscape', window: 'window', full: 'full_screen_maximize', free: 'lasso' };

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
let seq = 0;

/** Visible, capturable targets for Window mode, top-most first (taskbar, windows, then the desktop). */
export function windowTargets(exclude) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const clip = (r) => {
    const x = Math.max(0, r.left);
    const y = Math.max(0, r.top);
    return { x, y, width: Math.max(0, Math.min(vw, r.right) - x), height: Math.max(0, Math.min(vh, r.bottom) - y) };
  };
  const out = [];
  const tb = document.getElementById('taskbar');
  if (tb) {
    const cs = getComputedStyle(tb);
    const r = clip(tb.getBoundingClientRect());
    if (cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.05 && r.width > 8 && r.height > 8) out.push({ kind: 'taskbar', rect: r });
  }
  for (const w of wm.stack()) {
    if (w === exclude || w.minimized || w._closing || !w.el?.isConnected) continue;
    if (w.desktop && w.desktop !== wm.currentDesktop) continue;
    if (w.el.classList.contains('off-desktop') || w.el.classList.contains('snip-hidden')) continue;
    if (getComputedStyle(w.el).visibility === 'hidden') continue;
    const r = clip(w.el.getBoundingClientRect());
    if (r.width < 8 || r.height < 8) continue;
    out.push({ kind: 'window', id: w.id, title: w.title, rect: r });
  }
  out.push({ kind: 'desktop', rect: { x: 0, y: 0, width: vw, height: vh } });
  return out;
}

/** Crop the frozen screenshot (device pixels) to a CSS-pixel rect; a free-form path masks the rest transparent. */
export function cropBitmap(bmp, scale, rect, path) {
  const sx = Math.max(0, Math.floor(rect.x * scale));
  const sy = Math.max(0, Math.floor(rect.y * scale));
  const ex = Math.min(bmp.width, Math.ceil((rect.x + rect.width) * scale));
  const ey = Math.min(bmp.height, Math.ceil((rect.y + rect.height) * scale));
  const w = Math.max(1, ex - sx);
  const hgt = Math.max(1, ey - sy);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = hgt;
  const g = c.getContext('2d');
  g.drawImage(bmp, sx, sy, w, hgt, 0, 0, w, hgt);
  if (path && path.length > 2) {
    g.globalCompositeOperation = 'destination-in';
    g.beginPath();
    path.forEach(([x, y], i) => (i ? g.lineTo(x * scale - sx, y * scale - sy) : g.moveTo(x * scale - sx, y * scale - sy)));
    g.closePath();
    g.fillStyle = '#000';
    g.fill();
  }
  return c;
}

export class SnipSession {
  constructor({ api, h, icon, t, mode = 'rect', delay = 0, exclude = null, onMode = null, settle = 40 }) {
    Object.assign(this, { api, h, icon, t, exclude, onMode });
    this.mode = MODES.includes(mode) ? mode : 'rect';
    this.delay = Math.max(0, Number(delay) || 0);
    this.settle = Math.max(0, Number(settle) || 0);
    this.cancelled = false;
    this.phase = 'idle'; // idle | countdown | grabbing | overlay | done
    this._cancelers = new Set();
    this.overlay = null;
    this.pill = null;
  }

  /** Abort whatever is in progress (countdown, overlay). run() then resolves with null. */
  cancel() {
    if (this.cancelled) return;
    this.cancelled = true;
    for (const fn of [...this._cancelers]) fn();
    this._teardown();
  }

  _sleep(ms) {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this._cancelers.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this._cancelers.add(done);
    });
  }

  async run() {
    try {
      if (this.delay > 0) {
        this.phase = 'countdown';
        await this._countdown(this.delay);
      }
      if (this.cancelled) return null;
      this.phase = 'grabbing';
      ui.closeMenus();
      document.querySelectorAll('body > .tooltip').forEach((e) => e.remove());
      // Let the compositor present a frame without the app window / countdown pill.
      await nextFrame();
      await nextFrame();
      await this._sleep(this.settle);
      if (this.cancelled) return null;
      const bytes = await this.api.invoke('shell:capture');
      if (this.cancelled) return null;
      const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      if (this.cancelled) return null;
      const scale = bmp.width / Math.max(1, window.innerWidth) || 1;
      this.bitmap = bmp;
      this.scale = scale;
      this.targets = windowTargets(this.exclude);
      const full = { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
      if (this.mode === 'full') {
        this.phase = 'done';
        return { canvas: cropBitmap(bmp, scale, full), mode: 'full', rect: full };
      }
      this.phase = 'overlay';
      const sel = await this._showOverlay(bmp, scale);
      if (!sel || this.cancelled) return null;
      this.phase = 'done';
      return { canvas: cropBitmap(bmp, scale, sel.rect, sel.path), mode: sel.mode, rect: sel.rect };
    } finally {
      this._teardown();
      // The snip has been cropped into its own canvas by now: free the full-screen bitmap.
      this.bitmap?.close?.();
      this.bitmap = null;
    }
  }

  _teardown() {
    this.pill?.remove();
    this.pill = null;
    if (this.overlay) {
      this.overlay._cleanup?.();
      this.overlay.remove();
      this.overlay = null;
    }
  }

  // ------------------------------------------------------------------ delay countdown pill
  async _countdown(seconds) {
    const { h, icon, t } = this;
    const label = h('span', { class: 'snip-cd-label' });
    const num = h('span', { class: 'snip-cd-num' });
    this.pill = h(
      'div',
      { class: 'app-snipping snip-countdown', role: 'status', 'aria-live': 'polite' },
      h('span', { class: 'snip-cd-ring' }, num),
      icon('timer', { size: 16 }),
      label,
      h('button', { class: 'btn subtle icon-btn small snip-cd-x', 'aria-label': t('countdownCancel'), 'data-tip': t('countdownCancel'), onclick: () => this.cancel() }, icon('dismiss', { size: 12 })),
    );
    (document.getElementById('overlays') || document.body).appendChild(this.pill);
    for (let n = seconds; n > 0 && !this.cancelled; n--) {
      num.textContent = String(n);
      label.textContent = t('countdown', { n });
      if (document.documentElement.dataset.animations !== 'off') num.animate?.([{ transform: 'scale(1.35)', opacity: 0.2 }, { transform: 'none', opacity: 1 }], { duration: 260, easing: 'cubic-bezier(0.1, 0.9, 0.2, 1)' });
      await this._sleep(1000);
    }
    this.pill?.remove();
    this.pill = null;
  }

  // ------------------------------------------------------------------ selection overlay
  _showOverlay(bmp, scale) {
    const { h, icon, t } = this;
    const NS = 'http://www.w3.org/2000/svg';
    const svg = (tag, attrs = {}) => {
      const el = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      return el;
    };
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const id = `snipmask${++seq}`;

    const shot = h('canvas', { class: 'snip-shot', width: bmp.width, height: bmp.height, 'aria-hidden': 'true' });
    shot.getContext('2d').drawImage(bmp, 0, 0);
    const hole = svg('path', { fill: '#000', 'fill-rule': 'evenodd' });
    const mask = svg('mask', { id, maskUnits: 'userSpaceOnUse', x: '0', y: '0', width: String(vw), height: String(vh) });
    mask.append(svg('rect', { x: '0', y: '0', width: String(vw), height: String(vh), fill: '#fff' }), hole);
    const defs = svg('defs');
    defs.append(mask);
    const dim = svg('rect', { class: 'snip-dim', x: '0', y: '0', width: String(vw), height: String(vh), mask: `url(#${id})` });
    const outline = svg('path', { class: 'snip-outline', fill: 'none' });
    const outlineDark = svg('path', { class: 'snip-outline-dark', fill: 'none' });
    const winOutline = svg('rect', { class: 'snip-win-outline', fill: 'none', rx: '8' });
    const layer = svg('svg', { class: 'snip-layer', width: String(vw), height: String(vh), viewBox: `0 0 ${vw} ${vh}`, 'aria-hidden': 'true' });
    layer.append(defs, dim, outlineDark, outline, winOutline);
    const sizeLabel = h('div', { class: 'snip-size', 'aria-hidden': 'true' });

    const modeBtns = {};
    const bar = h(
      'div',
      { class: 'snip-bar', role: 'toolbar', 'aria-label': t('mode') },
      MODES.map((m) => {
        const b = h(
          'button',
          {
            class: 'snip-bar-btn',
            dataset: { mode: m, tipPos: 'below' },
            'data-tip': t(`modeTips.${m}`),
            'aria-label': t(`modeTips.${m}`),
            'aria-pressed': 'false',
            onclick: () => setMode(m, true),
          },
          icon(MODE_ICONS[m], { size: 20 }),
        );
        modeBtns[m] = b;
        return b;
      }),
      h('div', { class: 'snip-bar-sep' }),
      h('button', { class: 'snip-bar-btn snip-bar-close', dataset: { tipPos: 'below' }, 'data-tip': t('overlayClose'), 'aria-label': t('overlayClose'), onclick: () => finish(null) }, icon('dismiss', { size: 20 })),
    );
    const hint = h('div', { class: 'snip-ov-hint', role: 'status', 'aria-live': 'polite' });

    const ov = h(
      'div',
      { class: 'app-snipping snip-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('overlay'), tabindex: '-1', dataset: { mode: this.mode } },
      shot,
      layer,
      sizeLabel,
      bar,
      hint,
    );
    this.overlay = ov;

    const st = { dragging: false, start: null, rect: null, path: null, target: null, pointerId: null };
    const clampX = (x) => Math.max(0, Math.min(vw, x));
    const clampY = (y) => Math.max(0, Math.min(vh, y));
    const rectPath = (r) => `M${r.x} ${r.y}h${r.width}v${r.height}h${-r.width}Z`;
    const pathD = (pts, close) => (pts.length ? `M${pts.map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join('L')}${close ? 'Z' : ''}` : '');
    const devSize = (r) => `${Math.max(1, Math.round(r.width * scale))} × ${Math.max(1, Math.round(r.height * scale))}`;

    const showSize = (r, text) => {
      if (!r) {
        sizeLabel.classList.remove('show');
        return;
      }
      sizeLabel.textContent = text ?? devSize(r);
      sizeLabel.classList.add('show');
      const lw = sizeLabel.offsetWidth || 80;
      const lh = sizeLabel.offsetHeight || 24;
      let x = r.x + r.width - lw;
      let y = r.y + r.height + 8;
      if (y + lh > vh - 4) y = r.y + r.height - lh - 8;
      if (y < 4) y = 4;
      x = Math.max(4, Math.min(vw - lw - 4, x));
      sizeLabel.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    };
    const clearSel = () => {
      hole.setAttribute('d', '');
      outline.setAttribute('d', '');
      outlineDark.setAttribute('d', '');
      winOutline.style.display = 'none';
      showSize(null);
      st.rect = null;
      st.path = null;
    };
    const drawRect = (r) => {
      const d = rectPath(r);
      hole.setAttribute('d', d);
      outline.setAttribute('d', d);
      outlineDark.setAttribute('d', d);
      showSize(r);
    };
    const drawTarget = (tg) => {
      st.target = tg;
      if (!tg) return clearSel();
      const r = tg.rect;
      hole.setAttribute('d', rectPath(r));
      outline.setAttribute('d', '');
      outlineDark.setAttribute('d', '');
      const inset = 1;
      Object.entries({ x: r.x + inset, y: r.y + inset, width: Math.max(0, r.width - 2 * inset), height: Math.max(0, r.height - 2 * inset) }).forEach(([k, v]) => winOutline.setAttribute(k, String(v)));
      winOutline.setAttribute('rx', tg.kind === 'window' && r.width < vw ? '8' : '0');
      winOutline.style.display = 'inline';
      showSize(r);
    };
    const updateHint = () => {
      hint.textContent = this.mode === 'full' ? '' : t(`overlayHint.${this.mode}`);
      // Replay the fade in / out for the new text.
      hint.style.animation = 'none';
      void hint.offsetWidth;
      hint.style.animation = '';
    };
    const setMode = (m, user) => {
      if (!MODES.includes(m)) return;
      this.mode = m;
      ov.dataset.mode = m;
      for (const [k, b] of Object.entries(modeBtns)) {
        b.classList.toggle('selected', k === m);
        b.setAttribute('aria-pressed', String(k === m));
      }
      if (user) this.onMode?.(m);
      clearSel();
      st.target = null;
      updateHint();
      if (m === 'full') finish({ rect: { x: 0, y: 0, width: vw, height: vh }, mode: 'full' });
      else if (m === 'window' && st.lastPoint) drawTarget(hit(st.lastPoint));
    };
    const hit = ([x, y]) => this.targets.find((tg) => x >= tg.rect.x && y >= tg.rect.y && x < tg.rect.x + tg.rect.width && y < tg.rect.y + tg.rect.height) || null;
    const pointOf = (e) => [clampX(e.clientX), clampY(e.clientY)];

    let resolveFn;
    const done = new Promise((r) => (resolveFn = r));
    let finished = false;
    const finish = (res) => {
      if (finished) return;
      finished = true;
      this._cancelers.delete(onCancel);
      resolveFn(res);
    };
    const onCancel = () => finish(null);
    this._cancelers.add(onCancel);

    const onDown = (e) => {
      if (e.target.closest('.snip-bar')) return;
      if (e.button === 2) {
        // Right-click abandons the selection in progress (Esc closes the overlay).
        if (st.dragging) {
          st.dragging = false;
          ov.classList.remove('dragging');
          clearSel();
        }
        return;
      }
      if (e.button !== 0) return;
      e.preventDefault();
      const p = pointOf(e);
      st.lastPoint = p;
      if (this.mode === 'window') {
        st.downTarget = hit(p);
        drawTarget(st.downTarget);
        return;
      }
      st.dragging = true;
      st.pointerId = e.pointerId;
      try {
        ov.setPointerCapture(e.pointerId);
      } catch {}
      ov.classList.add('dragging');
      st.start = p;
      if (this.mode === 'free') {
        st.path = [p];
        hole.setAttribute('d', '');
        outline.setAttribute('d', pathD(st.path, false));
        outlineDark.setAttribute('d', pathD(st.path, false));
      } else {
        st.rect = { x: p[0], y: p[1], width: 0, height: 0 };
        drawRect(st.rect);
      }
    };
    const onMove = (e) => {
      const p = pointOf(e);
      st.lastPoint = p;
      if (this.mode === 'window') {
        if (!st.dragging) {
          const tg = hit(p);
          if (tg !== st.target) drawTarget(tg);
        }
        return;
      }
      if (!st.dragging || e.pointerId !== st.pointerId) return;
      if (this.mode === 'free') {
        const evs = e.getCoalescedEvents?.() || [];
        for (const ce of evs.length ? evs : [e]) {
          const q = [clampX(ce.clientX), clampY(ce.clientY)];
          const last = st.path[st.path.length - 1];
          if (Math.hypot(q[0] - last[0], q[1] - last[1]) >= 1.5) st.path.push(q);
        }
        const d = pathD(st.path, false);
        outline.setAttribute('d', d);
        outlineDark.setAttribute('d', d);
        hole.setAttribute('d', st.path.length > 2 ? pathD(st.path, true) : '');
        showSize(bboxOf(st.path));
      } else {
        const [x0, y0] = st.start;
        st.rect = { x: Math.min(x0, p[0]), y: Math.min(y0, p[1]), width: Math.abs(p[0] - x0), height: Math.abs(p[1] - y0) };
        drawRect(st.rect);
      }
    };
    const onUp = (e) => {
      if (this.mode === 'window') {
        if (e.button !== 0) return;
        const tg = hit(pointOf(e));
        if (tg && tg === st.downTarget) finish({ rect: tg.rect, mode: 'window', target: tg });
        st.downTarget = null;
        return;
      }
      if (!st.dragging || e.pointerId !== st.pointerId) return;
      st.dragging = false;
      ov.classList.remove('dragging');
      try {
        ov.releasePointerCapture(e.pointerId);
      } catch {}
      if (this.mode === 'free') {
        const bb = st.path && st.path.length > 2 ? bboxOf(st.path) : null;
        if (bb && bb.width >= 4 && bb.height >= 4) finish({ rect: bb, path: st.path, mode: 'free' });
        else clearSel();
      } else {
        const r = st.rect;
        if (r && r.width >= 4 && r.height >= 4) finish({ rect: r, mode: 'rect' });
        else clearSel();
      }
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(null);
        return;
      }
      if (this.mode === 'window' && ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        e.preventDefault();
        const list = this.targets;
        const i = list.indexOf(st.target);
        const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1;
        drawTarget(list[(i + step + list.length) % list.length] || list[0]);
        return;
      }
      if (this.mode === 'window' && (e.key === 'Enter' || e.key === ' ') && st.target && !e.target.closest?.('.snip-bar')) {
        e.preventDefault();
        finish({ rect: st.target.rect, mode: 'window', target: st.target });
      }
    };
    // Keep the keyboard inside the overlay while it is up.
    const onFocusOut = () =>
      setTimeout(() => {
        if (!finished && ov.isConnected && !ov.contains(document.activeElement)) ov.focus({ preventScroll: true });
      }, 0);

    ov.addEventListener('pointerdown', onDown);
    ov.addEventListener('pointermove', onMove);
    ov.addEventListener('pointerup', onUp);
    ov.addEventListener('pointercancel', onUp);
    ov.addEventListener('contextmenu', (e) => e.preventDefault());
    ov.addEventListener('keydown', onKey);
    ov.addEventListener('focusout', onFocusOut);
    ov._cleanup = () => {
      this._cancelers.delete(onCancel);
    };

    (document.getElementById('overlays') || document.body).appendChild(ov);
    setMode(this.mode, false);
    clearSel();
    ov.focus({ preventScroll: true });

    // Test / debugging hook: the live state of the overlay.
    ov.__snip = { targets: this.targets, state: st, scale, setMode: (m) => setMode(m, true) };
    return done;
  }
}

function bboxOf(pts) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}
