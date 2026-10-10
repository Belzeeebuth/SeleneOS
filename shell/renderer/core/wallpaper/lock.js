// Lock screen / sign-in screen background (settings.lockScreen, docs/PERSONALIZATION.md §B1):
//   mode 'picture'   settings.lockWallpaper (null = the desktop's picture — whatever the wallpaper engine shows)
//   mode 'spotlight' a different built-in picture every day (core/wallpaper/dynamic.js spotlightPick)
//   mode 'animated'  a lightweight animated scene (settings.lockScreen.effect) behind the clock
// Used by core/features/lock.js (through ctx.wallpaperEngine) and by core/greeter/greeter.js (sign-in screen).
//
//   lockMode(all)                               -> 'picture' | 'spotlight' | 'animated'
//   lockPictureUrl(all, mode, { desktopUrl, now }) -> URL for picture / spotlight modes (sync), or null (animated)
//   await lockScreenWallpaper(all, mode, { desktopUrl, now }) -> URL for every mode (animated: a still frame, blob:)
//   mountLockEffect(ls, { effect, params, fps }) -> { renderer, dispose } | null
//       runs the effect inside the LockScreen's picture (ls.wall) while the clock view is visible; stops on the
//       sign-in view, when the screen is dismissed, and honours reduced motion (a still frame).
import { resolveWallpaper } from '../theme.js';
import { spotlightPick, EFFECT_IDS } from './dynamic.js';

export function lockMode(all = {}) {
  const m = all.lockScreen?.mode;
  return m === 'spotlight' || m === 'animated' ? m : 'picture';
}

export function lockPictureUrl(all = {}, mode = 'dark', { desktopUrl, now = new Date() } = {}) {
  const m = lockMode(all);
  if (m === 'spotlight') return spotlightPick(now).url;
  if (m === 'animated') return null;
  if (all.lockWallpaper) return resolveWallpaper(all.lockWallpaper, mode);
  return desktopUrl || resolveWallpaper(all.wallpaper, mode);
}

const stills = new Map(); // key -> Promise<blob url>
/** A still frame of an effect (cached per effect / mode / accent / size). */
export function effectStill(effectId, { mode = 'dark', accent = '#0078d4', intensity = 0.5 } = {}) {
  const id = EFFECT_IDS.includes(effectId) ? effectId : 'aurora';
  const W = Math.max(320, Math.min(1920, window.innerWidth || 1280));
  const H = Math.max(200, Math.min(1200, window.innerHeight || 720));
  const key = `${id}|${mode}|${accent}|${intensity}|${W}x${H}`;
  if (!stills.has(key)) {
    stills.set(
      key,
      (async () => {
        const [{ WallpaperRenderer }, { effectById }] = await Promise.all([import('./engine.js'), import('./effects/index.js')]);
        const host = document.createElement('div');
        host.style.cssText = `position:fixed;left:-${W + 50}px;top:0;width:${W}px;height:${H}px;visibility:hidden;pointer-events:none`;
        document.body.append(host);
        try {
          const r = new WallpaperRenderer({ host, effect: effectById(id), params: { mode, accent, intensity, speed: 1 } });
          const url = await r.snapshot({ width: W, t: r.effect.heroTime ?? 12 });
          r.destroy();
          return url;
        } finally {
          host.remove();
        }
      })().catch((err) => {
        stills.delete(key);
        console.warn('[wallpaper] lock still failed', err?.message || err);
        return '';
      }),
    );
  }
  return stills.get(key);
}

export async function lockScreenWallpaper(all = {}, mode = 'dark', opts = {}) {
  if (lockMode(all) !== 'animated') return lockPictureUrl(all, mode, opts);
  return effectStill(all.lockScreen?.effect, { mode: 'dark', accent: all.accent || '#0078d4' });
}

const reduced = () => document.documentElement.dataset.reducedMotion === 'on' || document.documentElement.dataset.animations === 'off';

/** Run an animated effect in a LockScreen's picture (ls.wall). */
export async function mountLockEffect(ls, { effect, params = {}, fps = 30 } = {}) {
  if (!ls?.wall || !effect) return null;
  const [{ WallpaperRenderer }, { effectById }] = await Promise.all([import('./engine.js'), import('./effects/index.js')]);
  if (!ls.el?.isConnected) return null;
  const host = document.createElement('div');
  host.className = 'wp-lock';
  host.style.cssText = 'position:absolute;inset:0;pointer-events:none';
  ls.wall.append(host);
  const r = new WallpaperRenderer({ host, effect: effectById(effect), params: { mode: 'dark', accent: '#0078d4', intensity: 0.5, speed: 1, ...params }, fps });
  const sync = () => {
    r.setPaused('signin', ls.el.classList.contains('stage-signin'));
    r.setPaused('motion', reduced());
    r.setPaused('hidden', document.hidden);
    if (!ls.el.isConnected) dispose();
  };
  const mo = new MutationObserver(sync);
  mo.observe(ls.el, { attributes: true, attributeFilter: ['class'] });
  const rootMo = new MutationObserver(sync);
  rootMo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-animations', 'data-reduced-motion'] });
  document.addEventListener('visibilitychange', sync);
  // the lock screen leaves the DOM when dismissed
  const gone = setInterval(() => !ls.el.isConnected && dispose(), 1000);
  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    clearInterval(gone);
    mo.disconnect();
    rootMo.disconnect();
    document.removeEventListener('visibilitychange', sync);
    r.destroy();
    host.remove();
  }
  sync();
  r.start();
  return { renderer: r, dispose };
}
