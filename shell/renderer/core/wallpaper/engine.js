// Wallpaper engine: draws an animated scene (core/wallpaper/effects/*.js) on canvases inside a host element.
// Used by the desktop (core/features/wallpaper.js), the lock / sign-in screens (core/wallpaper/lock.js) and the
// mini previews of Settings. Built for software rendering in a VM without GPU:
//   - the animated canvas is rendered at a fraction of the screen resolution (effect.scale, 0.25–0.5) and upscaled
//     by CSS; static parts (sky, mountains) are drawn once at full resolution on their own canvases (bg / fg);
//   - frame rate capped (15 or 30 fps), nothing scheduled while paused, no allocations in the frame loop;
//   - a still frame can be exported (snapshot) for the Mica material, the lock screen blur and reduced motion.
//
//   const r = new WallpaperRenderer({ host, effect: EFFECTS.aurora, params: { mode, accent, intensity, speed }, fps: 30 });
//   r.start()  r.stop()  r.setPaused(reason, bool)  r.setFps(n)  r.setParams(p)  r.resize()  r.renderStill(t?)
//   await r.snapshot({ width, type })  -> blob: URL of the composited frame (caller revokes it)
//   r.stats -> { frames, drawMs, running, paused: [...reasons], fps, effect }       r.destroy()
//
// Effect contract (effects/*.js default export):
//   { id, name: {en, fr}, desc: {en, fr}, scale: 0.5, layered: false, heroTime: 12, create(env) -> instance }
//   env = { mode: 'light'|'dark', accent: '#rrggbb', intensity: 0..1, weather?, small: bool }
//   instance = { resize(w, h), frame(g, t, dt), background?(g, W, H), foreground?(g, W, H), dispose?() }
//   frame() draws the animated canvas (w × h px) for animation time t (s); background / foreground draw the static
//   full-resolution layers under / over it (layered effects only).

// ---------------------------------------------------------------- shared helpers for effects
/** Deterministic PRNG (mulberry32) → () => [0, 1). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

export function hexRgb(hex) {
  const s = String(hex || '').replace('#', '');
  const n = parseInt(s.length === 3 ? s.split('').map((c) => c + c).join('') : s, 16);
  return Number.isFinite(n) ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : [0, 120, 212];
}
export const rgba = ([r, g, b], a = 1) => `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${a})`;
export const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

export function rgbToHsl([r, g, b]) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  return [h * 360, s * 100, l * 100];
}
export function hsl(h, s, l) {
  s = Math.max(0, Math.min(100, s)) / 100;
  l = Math.max(0, Math.min(100, l)) / 100;
  h = ((h % 360) + 360) % 360;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

/** Soft round sprite: radial gradient of `rgb` through [offset, alpha] stops. */
export function radialSprite(size, rgb, stops = [[0, 1], [0.4, 0.5], [1, 0]]) {
  const c = canvas(size, size);
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [o, a] of stops) gr.addColorStop(o, rgba(rgb, a));
  g.fillStyle = gr;
  g.fillRect(0, 0, size, size);
  return c;
}

/** Linear gradient filling a context (stops: [[offset, rgb, alpha]]). */
export function linear(g, x0, y0, x1, y1, stops) {
  const gr = g.createLinearGradient(x0, y0, x1, y1);
  for (const [o, rgb, a] of stops) gr.addColorStop(o, rgba(rgb, a ?? 1));
  return gr;
}

// ---------------------------------------------------------------- renderer
function layerCanvas(className) {
  const c = document.createElement('canvas');
  c.className = className;
  c.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;display:block';
  return c;
}
const reduceMotionNow = () => document.documentElement.dataset.reducedMotion === 'on' || document.documentElement.dataset.animations === 'off';
let seq = 0;

export class WallpaperRenderer {
  constructor({ host, effect, params = {}, fps = 30, scale, className = '', still = false } = {}) {
    this.host = host;
    this.effect = effect;
    this.params = { mode: 'dark', accent: '#0078d4', intensity: 0.5, speed: 1, ...params };
    this.fps = fps === 15 ? 15 : fps === 60 ? 60 : 30;
    this.scaleOverride = scale;
    this.time = effect?.heroTime ?? 12;
    this.paused = new Set();
    this.running = false;
    this.frames = 0;
    this.drawMs = 0;
    this._raf = 0;
    this._last = 0;
    this._built = false;
    this.id = ++seq;
    this.still = still;
    this.root = document.createElement('div');
    this.root.className = `wp-scene ${className}`.trim();
    this.root.dataset.effect = effect?.id || '';
    // inline layout: the scene works in any host (desktop, lock / sign-in screen, Settings previews) without a style sheet
    this.root.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:none;contain:strict';
    this.anim = layerCanvas('wp-anim');
    this.root.append(this.anim);
    this.g = this.anim.getContext('2d', { alpha: !!effect?.layered || !!effect?.transparent, desynchronized: false });
    host.append(this.root);
    this._tick = this._tick.bind(this);
    this._ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this._onResize()) : null;
    this._ro?.observe(this.root);
    this.build();
  }

  get stats() {
    return { frames: this.frames, drawMs: Math.round(this.drawMs * 100) / 100, running: this.running && !this.paused.size, paused: [...this.paused], fps: this.fps, effect: this.effect?.id, time: this.time };
  }

  /** (Re)create the effect instance and the static layers for the current size and params. */
  build() {
    const W = Math.max(1, this.root.clientWidth || this.host.clientWidth || window.innerWidth);
    const H = Math.max(1, this.root.clientHeight || this.host.clientHeight || window.innerHeight);
    this.W = W;
    this.H = H;
    const small = W < 600;
    const k = this.scaleOverride ?? (small ? 1 : this.effect.scale ?? 0.5);
    const w = Math.max(2, Math.round(W * k));
    const h = Math.max(2, Math.round(H * k));
    this.anim.width = w;
    this.anim.height = h;
    this.inst?.dispose?.();
    this.inst = this.effect.create({ mode: this.params.mode === 'light' ? 'light' : 'dark', accent: this.params.accent, intensity: Math.max(0, Math.min(1, this.params.intensity)), weather: this.params.weather, small });
    this.inst.resize(w, h);
    // static full-resolution layers
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    for (const which of ['background', 'foreground']) {
      const key = which === 'background' ? 'bg' : 'fg';
      if (this.effect.layered && typeof this.inst[which] === 'function') {
        let c = this[key];
        if (!c) {
          c = this[key] = layerCanvas(`wp-${key}`);
          if (key === 'bg') this.root.prepend(c);
          else this.root.append(c);
        }
        c.width = Math.round(W * dpr);
        c.height = Math.round(H * dpr);
        const g = c.getContext('2d');
        g.clearRect(0, 0, c.width, c.height);
        this.inst[which](g, c.width, c.height);
      } else if (this[key]) {
        this[key].remove();
        this[key] = null;
      }
    }
    this._built = true;
    this.renderStill(this.time);
  }

  _onResize() {
    const W = this.root.clientWidth;
    const H = this.root.clientHeight;
    if (!W || !H || (W === this.W && H === this.H)) return;
    clearTimeout(this._resizeTimer);
    this._resizeTimer = setTimeout(() => this.build(), 120);
  }
  resize() {
    this.build();
  }

  setParams(p = {}) {
    const next = { ...this.params, ...p };
    const rebuild = next.mode !== this.params.mode || next.accent !== this.params.accent || next.intensity !== this.params.intensity || JSON.stringify(next.weather || null) !== JSON.stringify(this.params.weather || null);
    this.params = next;
    if (rebuild) this.build();
  }
  setEffect(effect) {
    if (effect === this.effect) return;
    this.effect = effect;
    this.root.dataset.effect = effect.id;
    this.g = null;
    // a new 2D context needs a new canvas when the alpha mode changes
    const c = layerCanvas('wp-anim');
    this.anim.replaceWith(c);
    this.anim = c;
    this.g = c.getContext('2d', { alpha: !!effect.layered || !!effect.transparent });
    this.time = effect.heroTime ?? 12;
    this.build();
  }
  setFps(fps) {
    this.fps = fps === 15 ? 15 : fps === 60 ? 60 : 30;
  }

  /** Draw one frame at time t (no loop): still image for reduced motion, previews, snapshots. */
  renderStill(t = this.time) {
    if (!this.inst) return;
    try {
      this.inst.frame(this.g, t, 0);
    } catch (err) {
      console.error('[wallpaper] frame failed', err);
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._schedule();
  }
  stop() {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    this._last = 0;
  }
  /** Pause for a reason ('hidden', 'covered', 'locked', 'motion', 'offscreen', …); runs when no reason is left. */
  setPaused(reason, on) {
    const had = this.paused.size;
    if (on) this.paused.add(reason);
    else this.paused.delete(reason);
    if (had && !this.paused.size) this._schedule();
    if (!had && this.paused.size && this._raf) {
      cancelAnimationFrame(this._raf);
      this._raf = 0;
    }
  }
  _schedule() {
    if (!this.running || this.paused.size || this._raf) return;
    this._last = 0;
    this._raf = requestAnimationFrame(this._tick);
  }
  _tick(now) {
    this._raf = 0;
    if (!this.running || this.paused.size) return;
    const interval = 1000 / this.fps;
    if (this._last && now - this._last < interval - 4) {
      this._raf = requestAnimationFrame(this._tick);
      return;
    }
    const dt = this._last ? Math.min(250, now - this._last) / 1000 : 1 / this.fps;
    this._last = now;
    this.time += dt * (this.params.speed ?? 1);
    const t0 = performance.now();
    try {
      this.inst.frame(this.g, this.time, dt);
    } catch (err) {
      console.error('[wallpaper] frame failed', err);
      this.stop();
      return;
    }
    const ms = performance.now() - t0;
    this.drawMs = this.frames ? this.drawMs * 0.9 + ms * 0.1 : ms;
    this.frames++;
    if (!this.anim.isConnected) {
      this.stop();
      return;
    }
    this._raf = requestAnimationFrame(this._tick);
  }

  /** The composited picture (bg + animated frame + fg) as a blob: URL — Mica, lock screen, still frames. */
  async snapshot({ width = Math.min(1920, Math.round(this.W * Math.min(2, window.devicePixelRatio || 1))), type = 'image/jpeg', quality = 0.9, t } = {}) {
    if (!this._built) this.build();
    if (t != null) this.renderStill(t);
    const restore = t != null && this.running;
    const W = Math.max(2, Math.round(width));
    const H = Math.max(2, Math.round((W * this.H) / this.W));
    const c = canvas(W, H);
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    if (this.bg) g.drawImage(this.bg, 0, 0, W, H);
    g.drawImage(this.anim, 0, 0, W, H);
    if (this.fg) g.drawImage(this.fg, 0, 0, W, H);
    if (restore) this.renderStill(this.time); // back to the running frame before the next paint
    const blob = await new Promise((res) => c.toBlob(res, type, quality));
    return blob ? URL.createObjectURL(blob) : '';
  }

  destroy() {
    this.stop();
    this._ro?.disconnect();
    clearTimeout(this._resizeTimer);
    this.inst?.dispose?.();
    this.inst = null;
    this.root.remove();
  }
}

export { reduceMotionNow };
