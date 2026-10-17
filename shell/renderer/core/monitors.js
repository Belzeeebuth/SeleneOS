// Screens of the desktop. The shell window covers every screen (main/index.js); this module knows where each one is
// (CSS px of the shell window) and keeps the main-screen parts on the main screen:
//   - #screen-main (bar, Lanceur, panels, notifications, overlays) and #screen-desk (wallpaper, desktop icons) are
//     placed on the main screen's rectangle (CSS --scr-x / --scr-y / --scr-w / --scr-h);
//   - #screen-walls draws the wallpaper on every other screen (and covers them while the session is locked);
//   - the window manager (core/wm.js) asks it for per-screen work areas.
//
//   monitors.list  -> [{ id, x, y, width, height, primary }]   (one screen = the whole window)
//   monitors.main() monitors.at(x, y) monitors.forRect(rect) monitors.neighbour(mon, dir)  monitors.on('change', fn)
// Main process: 'display:monitors' (invoke + broadcast, main/ipc/display.js). Dev / tests: AURORA_DEV_MONITORS.
import { api, Emitter } from './api.js';

// ---------------------------------------------------------------- pure maths (test/displays.unit.mjs)
const overlap = (a, b) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
const contains = (m, x, y) => x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height;

export function monitorAt(list, x, y) {
  const hit = list.find((m) => contains(m, x, y));
  if (hit) return hit;
  // between screens of different sizes: the nearest one
  let best = list[0];
  let bd = Infinity;
  for (const m of list) {
    const dx = Math.max(m.x - x, 0, x - (m.x + m.width - 1));
    const dy = Math.max(m.y - y, 0, y - (m.y + m.height - 1));
    const d = dx * dx + dy * dy;
    if (d < bd) {
      bd = d;
      best = m;
    }
  }
  return best;
}

export function monitorForRect(list, r) {
  let best = null;
  let area = 0;
  for (const m of list) {
    const a = overlap(m, { x: r.x, y: r.y, width: r.width ?? r.w ?? 1, height: r.height ?? r.h ?? 1 });
    if (a > area) {
      area = a;
      best = m;
    }
  }
  return best || monitorAt(list, r.x + (r.width ?? r.w ?? 0) / 2, r.y + Math.min(16, (r.height ?? r.h ?? 0) / 2));
}

/** The screen on the left / right (by centre), wrapping round like Windows' Super+Shift+arrows. */
export function neighbour(list, mon, dir) {
  if (!mon || list.length < 2) return null;
  const sorted = [...list].sort((a, b) => a.x + a.width / 2 - (b.x + b.width / 2) || a.y - b.y);
  const i = sorted.indexOf(mon);
  const j = (i + (dir === 'left' ? -1 : 1) + sorted.length) % sorted.length;
  return sorted[j] === mon ? null : sorted[j];
}

/** A window rectangle moved from one work area to another, at the same relative place, shrunk to fit. */
export function relocate(r, from, to) {
  const width = Math.min(r.width, to.width);
  const height = Math.min(r.height, to.height);
  const fx = from.width > r.width ? (r.x - from.x) / (from.width - r.width) : 0;
  const fy = from.height > r.height ? (r.y - from.y) / (from.height - r.height) : 0;
  const cl = (v) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
  return {
    x: Math.round(to.x + cl(fx) * (to.width - width)),
    y: Math.round(to.y + cl(fy) * (to.height - height)),
    width: Math.round(width),
    height: Math.round(height),
  };
}

/** Work area of a screen: the main one loses the bar's insets (+ reserved space), the others are whole. */
export function workareaOf(mon, insets, isMain) {
  const i = isMain ? insets : { top: 0, right: 0, bottom: 0, left: 0 };
  return { x: mon.x + (i.left || 0), y: mon.y + (i.top || 0), width: mon.width - (i.left || 0) - (i.right || 0), height: mon.height - (i.top || 0) - (i.bottom || 0) };
}

// ---------------------------------------------------------------- live model
class Monitors extends Emitter {
  constructor() {
    super();
    this._list = null; // null = one screen, the whole window
  }
  get list() {
    if (this._list && this._list.length) return this._list;
    return [{ id: 'm1', x: 0, y: 0, width: window.innerWidth, height: window.innerHeight, primary: true }];
  }
  /** Several screens — or one screen that is not the whole window (dev / tests, a window still being resized). */
  get multi() {
    const l = this._list;
    // (Chromium keeps the window 1px short of the screen until aurora-xresize fixes it: a couple of px is still one screen)
    const off = (a, b) => Math.abs(a - b) > 2;
    return !!(l && (l.length > 1 || (l.length === 1 && (l[0].x || l[0].y || off(l[0].width, window.innerWidth) || off(l[0].height, window.innerHeight)))));
  }
  main() {
    const l = this.list;
    return l.find((m) => m.primary) || l[0];
  }
  at(x, y) {
    return monitorAt(this.list, x, y);
  }
  forRect(r) {
    return monitorForRect(this.list, r);
  }
  neighbour(mon, dir) {
    return neighbour(this.list, mon, dir);
  }
  byId(id) {
    return this.list.find((m) => m.id === id) || null;
  }
  async init() {
    this._walls = document.getElementById('screen-walls');
    api.on('display:monitors', (d) => this.set(d));
    // a resize is also a zoom change (Mise à l'échelle): the main process gives the screens in CSS px of the new zoom
    let refetch = 0;
    window.addEventListener('resize', () => {
      this._apply();
      clearTimeout(refetch);
      refetch = setTimeout(() => api.invoke('display:monitors').then((d) => this.set(d)).catch(() => {}), 150);
    });
    // the desktop's wallpaper changes (picture, slideshow, animated still frame): repaint the other screens
    const desk = document.getElementById('desktop');
    if (desk && typeof MutationObserver === 'function') {
      let tmr = 0;
      new MutationObserver(() => {
        if (!this.multi || tmr) return;
        tmr = setTimeout(() => {
          tmr = 0;
          this._paintWalls();
        }, 200);
      }).observe(desk, { subtree: true, childList: true, attributes: true, attributeFilter: ['style'] });
    }
    try {
      this.set(await api.invoke('display:monitors'));
    } catch {
      this._apply();
    }
  }
  set(data) {
    const list = Array.isArray(data?.monitors) ? data.monitors.filter((m) => m && m.width > 0 && m.height > 0) : [];
    const next = list.length ? list.map((m, i) => ({ id: String(m.id ?? `m${i + 1}`), x: +m.x || 0, y: +m.y || 0, width: +m.width, height: +m.height, primary: !!m.primary })) : null;
    if (next && !next.some((m) => m.primary)) next[0].primary = true;
    const same = JSON.stringify(next) === JSON.stringify(this._list);
    this._list = next;
    this._apply();
    if (!same) this.emit('change', this.list);
  }
  _apply() {
    const root = document.documentElement.style;
    const m = this.main();
    const on = this.multi;
    root.setProperty('--scr-x', on ? `${m.x}px` : '0px');
    root.setProperty('--scr-y', on ? `${m.y}px` : '0px');
    root.setProperty('--scr-w', on ? `${m.width}px` : '100vw');
    root.setProperty('--scr-h', on ? `${m.height}px` : '100vh');
    document.body.classList.toggle('multi-screen', on);
    this._paintWalls();
  }
  // Wallpaper on the other screens: the desktop's current picture (or its still frame for animated wallpapers).
  _paintWalls() {
    const host = this._walls;
    if (!host) return;
    const others = this.multi ? this.list.filter((m) => m !== this.main()) : [];
    while (host.children.length > others.length) host.lastChild.remove();
    while (host.children.length < others.length) host.appendChild(Object.assign(document.createElement('div'), { className: 'screen-wall' }));
    const bg = this._wallpaperImage();
    others.forEach((m, i) => {
      const el = host.children[i];
      el.dataset.monitor = m.id;
      Object.assign(el.style, { left: `${m.x}px`, top: `${m.y}px`, width: `${m.width}px`, height: `${m.height}px`, backgroundImage: bg || '' });
    });
  }
  _wallpaperImage() {
    const layers = document.querySelectorAll('#desktop .wallpaper-layer');
    for (let i = layers.length - 1; i >= 0; i--) {
      const b = layers[i].style.backgroundImage;
      if (b && b !== 'none') return b;
    }
    const mica = getComputedStyle(document.documentElement).getPropertyValue('--mica-image').trim();
    return mica && mica !== 'none' ? mica : '';
  }
  /** The desktop changed its wallpaper (core/desktop.js, features/wallpaper.js): repaint the other screens. */
  refreshWallpaper() {
    this._paintWalls();
  }
}

export const monitors = new Monitors();
