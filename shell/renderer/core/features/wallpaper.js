// Wallpaper engine of the desktop (personalization area B1, docs/PERSONALIZATION.md §B1).
// settings.wallpaperMode:
//   'static'    the picture / solid colour of settings.wallpaper (drawn by core/desktop.js, nothing to do here)
//   'animated'  an animated scene (core/wallpaper/effects) on canvases right above the desktop picture; a still frame
//               of the scene becomes the desktop picture (theme.setWallpaperOverride), so Mica, "accent from wallpaper",
//               the lock screen and reduced motion all get a matching picture
//   'dynamic'   a time-of-day set (dawn / day / dusk / night, sun times from settings.dynamicWallpaper.location or
//               fixed hours) with a slow cross-fade between variants; source 'weather' adds the current weather
//               (main/ipc/weather.js) as a tint + animated rain / snow / clouds / fog / storm; optionally the light /
//               dark theme follows the sun (dynamicWallpaper.followTheme)
//   'slideshow' a picture from settings.slideshow.folder (null = the built-in pictures) every `interval` minutes
// Animations are capped (15 / 30 fps) and pause while a maximized or full-screen window covers the desktop
// (animatedWallpaper.pauseOnMaximized), while the session is locked, while the shell is hidden, and with reduced
// motion / animations off (a still frame instead).
//
//   ctx.wallpaperEngine (also window.__aurora.wallpaperEngine):
//     state                    -> { mode, effect, running, paused, frames, fps, drawMs, overrideUrl, dynamic, weather, slideshow }
//     renderer / weatherRenderer  the running WallpaperRenderer instances (or null)
//     lockWallpaperUrl()       -> picture for the lock screen (features/lock.js)
//     attachLock(ls)           -> runs the animated lock screen effect inside a LockScreen (features/lock.js)
//     next()                   -> next slideshow picture (also shell.emit('wallpaper:next'))
//     refresh()                -> re-evaluate now (time of day, weather)
//     setClock(date | null)    -> tests: pretend the current time is `date` (null = real clock)
//   shell events: 'wallpaper:next', 'wallpaper:changed' { mode, url }
import { WallpaperRenderer } from '../wallpaper/engine.js';
import { effectById, WEATHER_EFFECT } from '../wallpaper/effects/index.js';
import { weatherTint } from '../wallpaper/effects/weather.js';
import { dynamicPick, spotlightList } from '../wallpaper/dynamic.js';
import { daylightAt } from '../wallpaper/solar.js';
import { lockMode, lockPictureUrl, effectStill, mountLockEffect } from '../wallpaper/lock.js';
import { setWallpaperOverride, resolveWallpaper } from '../theme.js';

const IMAGE_EXT = /\.(jpe?g|png|webp|avif|gif|bmp)$/i;
const FADE_MS = 4000;
const WEATHER_POLL_MS = 15 * 60000;

export async function mount(ctx) {
  const { api, settings, theme, wm, shell, ui } = ctx;
  ui.loadCss('app://shell/core/features/wallpaper.css');
  const deskWall = document.querySelector('#desktop > .wallpaper');
  if (!deskWall) return;
  const host = document.createElement('div');
  host.className = 'wp-engine';
  host.setAttribute('aria-hidden', 'true');
  const fades = document.createElement('div');
  fades.className = 'wp-fades';
  const scene = document.createElement('div');
  scene.className = 'wp-scene-host';
  const tint = document.createElement('div');
  tint.className = 'wp-tint';
  const overlay = document.createElement('div');
  overlay.className = 'wp-overlay';
  host.append(scene, fades, tint, overlay);
  deskWall.after(host);

  let clock = null;
  const now = () => (clock ? new Date(clock.base + (Date.now() - clock.at)) : new Date());
  const cfg = (key, def) => ({ ...def, ...(settings.get(key) || {}) });
  const animCfg = () => cfg('animatedWallpaper', { id: 'aurora', speed: 50, intensity: 50, fps: 30, pauseOnMaximized: true });
  const dynCfg = () => cfg('dynamicWallpaper', { source: 'time', set: 'bloom', location: null, followTheme: false });
  const slideCfg = () => cfg('slideshow', { folder: null, interval: 30, shuffle: true });
  const modeOf = () => (['animated', 'dynamic', 'slideshow'].includes(settings.get('wallpaperMode')) ? settings.get('wallpaperMode') : 'static');
  const themeMode = () => (settings.get('theme') === 'dark' ? 'dark' : 'light');
  const motionOff = () => document.documentElement.dataset.reducedMotion === 'on' || document.documentElement.dataset.animations === 'off' || settings.get('reducedMotion') === true || settings.get('animations') === false;
  // effects drawn in the accent colour use the default blue while the accent is taken from the wallpaper (no feedback loop)
  const effectAccent = () => (settings.get('accentFromWallpaper') ? '#0078d4' : settings.get('accent') || '#0078d4');
  const speedFactor = (v) => {
    const s = Number.isFinite(Number(v)) && v !== null && v !== '' ? Math.max(0, Math.min(100, Number(v))) : 50;
    return s <= 50 ? 0.2 + (0.8 * s) / 50 : 1 + (1.5 * (s - 50)) / 50;
  };

  const st = {
    mode: 'static',
    renderer: null,
    weatherRenderer: null,
    overrideUrl: null,
    stillKey: '',
    dynamic: null, // { set, phase, url, next, source }
    weather: null,
    weatherError: null,
    slideshow: { list: [], index: -1, folder: undefined, url: null, timer: 0 },
    timers: { dyn: 0, tick: 0, weather: 0, still: 0 },
  };
  const oldUrls = [];
  function override(url) {
    if (url === st.overrideUrl) return;
    const prev = st.overrideUrl;
    st.overrideUrl = url || null;
    setWallpaperOverride(st.overrideUrl);
    // blob: stills are revoked once nothing shows them any more (the desktop cross-fade takes 700 ms)
    if (prev?.startsWith('blob:')) {
      oldUrls.push(prev);
      setTimeout(() => {
        const u = oldUrls.shift();
        if (u && u !== st.overrideUrl) URL.revokeObjectURL(u);
      }, 8000);
    }
    shell.emit('wallpaper:changed', { mode: st.mode, url: st.overrideUrl || theme.wallpaperUrl });
  }

  // ---------------------------------------------------------------- pausing
  const covered = () => {
    try {
      return (wm.listDesktop?.() || wm.list()).some((w) => !w.minimized && (w.state === 'maximized' || w.fullscreen));
    } catch {
      return false;
    }
  };
  const locked = () => !!ctx.lockScreen?.locked || document.body.classList.contains('aurora-locked');
  function syncPause() {
    const motion = motionOff();
    for (const r of [st.renderer, st.weatherRenderer]) {
      if (!r) continue;
      r.setPaused('hidden', document.hidden);
      r.setPaused('locked', locked());
      r.setPaused('covered', animCfg().pauseOnMaximized !== false && covered());
      const was = r.paused.has('motion');
      r.setPaused('motion', motion);
      if (motion && !was) r.renderStill(r.effect.heroTime ?? 12);
    }
  }
  document.addEventListener('visibilitychange', syncPause);
  for (const ev of ['change', 'open', 'close', 'desktop']) wm.on?.(ev, () => queueMicrotask(syncPause));
  shell.on('lock', () => setTimeout(syncPause, 0));
  shell.on('unlock', () => setTimeout(syncPause, 0));
  new MutationObserver(syncPause).observe(document.documentElement, { attributes: true, attributeFilter: ['data-animations', 'data-reduced-motion'] });

  // ---------------------------------------------------------------- animated
  function stopAnimated() {
    st.renderer?.destroy();
    st.renderer = null;
    st.stillKey = '';
    clearTimeout(st.timers.still);
  }
  async function updateStill(force) {
    const r = st.renderer;
    if (!r) return;
    const key = `${r.effect.id}|${r.params.mode}|${r.params.accent}|${r.params.intensity}|${r.W}x${r.H}`;
    if (!force && key === st.stillKey) return;
    st.stillKey = key;
    const url = await r.snapshot({ t: r.effect.heroTime ?? 12 });
    if (st.renderer !== r || st.stillKey !== key || st.mode !== 'animated') {
      if (url) URL.revokeObjectURL(url);
      return;
    }
    if (url) override(url);
  }
  function enterAnimated() {
    const c = animCfg();
    const effect = effectById(c.id);
    const params = { mode: themeMode(), accent: effectAccent(), intensity: Math.max(0, Math.min(100, Number(c.intensity) || 0)) / 100, speed: speedFactor(c.speed) };
    if (st.renderer && st.renderer.effect.id !== effect.id) stopAnimated();
    if (!st.renderer) {
      st.renderer = new WallpaperRenderer({ host: scene, effect, params, fps: Number(c.fps) === 15 ? 15 : 30 });
      st.renderer.root.classList.add('wp-desktop-scene');
    } else {
      st.renderer.setParams(params);
      st.renderer.setFps(Number(c.fps) === 15 ? 15 : 30);
    }
    syncPause();
    st.renderer.start();
    clearTimeout(st.timers.still);
    st.timers.still = setTimeout(() => updateStill(), 60);
  }

  // ---------------------------------------------------------------- cross-fade (dynamic, slideshow)
  async function preload(url) {
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return true;
    } catch {
      return false;
    }
  }
  function crossFade(fromUrl) {
    if (!fromUrl || motionOff()) return;
    for (const el of [...fades.children]) el.remove();
    const el = document.createElement('div');
    el.className = 'wp-fade';
    el.style.backgroundImage = `url("${fromUrl}")`;
    fades.append(el);
    el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FADE_MS, easing: 'cubic-bezier(0.45, 0, 0.55, 1)', fill: 'forwards' }).finished.then(
      () => el.remove(),
      () => el.remove(),
    );
  }
  async function showPicture(url) {
    if (!url || url === st.overrideUrl) return;
    const from = st.overrideUrl || theme.wallpaperUrl;
    await preload(url);
    crossFade(from);
    override(url);
  }

  // ---------------------------------------------------------------- dynamic (time of day + weather)
  function stopDynamic() {
    clearTimeout(st.timers.dyn);
    clearInterval(st.timers.weather);
    st.timers.weather = 0;
    st.weatherKey = '';
    st.dynamic = null;
    stopWeatherFx();
  }
  function stopWeatherFx() {
    st.weatherRenderer?.destroy();
    st.weatherRenderer = null;
    tint.style.background = '';
    tint.dataset.kind = '';
  }
  function applyWeatherFx() {
    const d = dynCfg();
    const w = st.weather;
    if (st.mode !== 'dynamic' || d.source !== 'weather' || !w || w.kind === 'clear') return stopWeatherFx();
    const isDay = w.isDay ?? (st.dynamic ? st.dynamic.phase === 'day' || st.dynamic.phase === 'dawn' : true);
    tint.style.background = weatherTint(w.kind, w.intensity, isDay);
    tint.dataset.kind = w.kind;
    const params = { mode: 'dark', weather: { kind: w.kind, intensity: w.intensity, isDay }, intensity: 0.5, speed: 1 };
    if (!st.weatherRenderer) {
      st.weatherRenderer = new WallpaperRenderer({ host: overlay, effect: WEATHER_EFFECT, params, fps: Number(animCfg().fps) === 15 ? 15 : 30 });
    } else st.weatherRenderer.setParams(params);
    st.weatherRenderer.root.hidden = motionOff();
    syncPause();
    st.weatherRenderer.start();
  }
  async function fetchWeather(force = false) {
    const d = dynCfg();
    if (st.mode !== 'dynamic' || d.source !== 'weather') return;
    if (!d.location) {
      st.weather = null;
      st.weatherError = 'ENOLOCATION';
      applyWeatherFx();
      return;
    }
    const here = (w) => w?.location && Math.abs(w.location.lat - d.location.lat) < 0.01 && Math.abs(w.location.lon - d.location.lon) < 0.01;
    try {
      const w = await api.invoke('weather:current', d.location, { force });
      if (!here(w) || st.mode !== 'dynamic') return; // the location changed meanwhile
      st.weather = w;
      st.weatherError = w?.stale ? w.error || 'ESTALE' : null;
    } catch (err) {
      st.weatherError = err.code || 'EOFFLINE';
      if (!here(st.weather)) st.weather = null; // never show another place's weather
    }
    applyWeatherFx();
    shell.emit('wallpaper:weather', { weather: st.weather, error: st.weatherError });
  }
  async function enterDynamic() {
    const d = dynCfg();
    const pick = dynamicPick(d.set, now(), d.location);
    st.dynamic = { set: pick.set, phase: pick.phase, url: pick.url, next: pick.next, sunrise: pick.sunrise, sunset: pick.sunset, source: pick.source };
    if (pick.url !== st.overrideUrl) await showPicture(pick.url);
    clearTimeout(st.timers.dyn);
    // next phase change (at most an hour away: survives clock changes and suspend)
    const wait = Math.max(1000, Math.min(3600000, pick.next.getTime() - now().getTime() + 500));
    st.timers.dyn = setTimeout(() => st.mode === 'dynamic' && enterDynamic(), wait);
    followSun();
    if (d.source === 'weather') {
      const key = d.location ? `${d.location.lat},${d.location.lon}` : '';
      if (!st.timers.weather || st.weatherKey !== key) {
        clearInterval(st.timers.weather);
        st.weatherKey = key;
        st.timers.weather = setInterval(() => fetchWeather(), WEATHER_POLL_MS);
        fetchWeather();
      } else applyWeatherFx();
    } else {
      clearInterval(st.timers.weather);
      st.timers.weather = 0;
      st.weatherKey = '';
      st.weather = null;
      stopWeatherFx();
    }
  }
  // light from sunrise to sunset (the "Auto" mode of the Colors page wins when it is on)
  function followSun() {
    const d = dynCfg();
    if (st.mode !== 'dynamic' || !d.followTheme || settings.get('autoTheme')?.enabled) return;
    const want = daylightAt(now(), d.location) ? 'light' : 'dark';
    if (themeMode() !== want) settings.set('theme', want).catch(() => {});
  }
  api.on('weather:changed', (w) => {
    const d = dynCfg();
    if (st.mode !== 'dynamic' || d.source !== 'weather' || !d.location || !w?.location) return;
    if (Math.abs(w.location.lat - d.location.lat) < 0.01 && Math.abs(w.location.lon - d.location.lon) < 0.01) {
      st.weather = w;
      st.weatherError = null;
      applyWeatherFx();
    }
  });

  // ---------------------------------------------------------------- slideshow
  function stopSlideshow() {
    clearTimeout(st.slideshow.timer);
    st.slideshow.timer = 0;
  }
  async function slideList(folder) {
    if (!folder) return spotlightList().map((x) => x.url);
    try {
      const entries = await api.invoke('fs:list', folder);
      return entries.filter((e) => !e.dir && IMAGE_EXT.test(e.name || '')).map((e) => resolveWallpaper(e.path || `${folder}/${e.name}`, themeMode()));
    } catch {
      return [];
    }
  }
  function shuffled(list, seed) {
    const out = list.slice();
    let a = seed >>> 0 || 1;
    for (let i = out.length - 1; i > 0; i--) {
      a = (Math.imul(a ^ (a >>> 15), 2246822507) + 0x9e3779b9) >>> 0;
      const j = a % (i + 1);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }
  async function slideshowStep(advance) {
    const c = slideCfg();
    const ss = st.slideshow;
    if (ss.folder !== c.folder || ss.shuffle !== c.shuffle || !ss.list.length) {
      let list = await slideList(c.folder);
      if (!list.length) list = spotlightList().map((x) => x.url);
      ss.list = c.shuffle ? shuffled(list, (Date.now() / 86400000) | 0) : list;
      ss.folder = c.folder;
      ss.shuffle = c.shuffle;
      ss.index = -1;
      advance = true;
    }
    if (advance || ss.index < 0) ss.index = (ss.index + 1) % ss.list.length;
    ss.url = ss.list[ss.index];
    await showPicture(ss.url);
    stopSlideshow();
    const minutes = Math.max(1, Math.min(1440, Number(c.interval) || 30));
    ss.timer = setTimeout(() => st.mode === 'slideshow' && slideshowStep(true), minutes * 60000);
  }

  // ---------------------------------------------------------------- mode switch
  let applying = null;
  let again = false;
  async function apply() {
    if (applying) {
      again = true;
      return applying;
    }
    applying = (async () => {
      do {
        again = false;
        const mode = modeOf();
        if (mode !== st.mode) {
          if (st.mode === 'animated') stopAnimated();
          if (st.mode === 'dynamic') stopDynamic();
          if (st.mode === 'slideshow') {
            stopSlideshow();
            st.slideshow.list = [];
          }
          st.mode = mode;
          host.dataset.mode = mode;
        }
        try {
          if (mode === 'animated') enterAnimated();
          else if (mode === 'dynamic') await enterDynamic();
          else if (mode === 'slideshow') await slideshowStep(false);
          else override(null);
        } catch (err) {
          console.error('[wallpaper] apply failed', err);
        }
      } while (again);
    })();
    try {
      await applying;
    } finally {
      applying = null;
    }
  }
  const KEYS = ['wallpaperMode', 'animatedWallpaper', 'dynamicWallpaper', 'slideshow', 'theme', 'accent', 'accentFromWallpaper', 'reducedMotion', 'animations', 'autoTheme'];
  let queued = false;
  settings.on('*', (_v, key) => {
    const k = String(key || '*').split('.')[0];
    if (k !== '*' && !KEYS.includes(k)) {
      if (k === 'lockScreen') prepareLock();
      return;
    }
    if (k === '*' || k === 'lockScreen') prepareLock();
    if (queued) return;
    queued = true;
    setTimeout(() => {
      queued = false;
      apply().then(syncPause);
    }, 30);
  });
  // a minute tick: time of day after a suspend / clock change, theme following the sun
  st.timers.tick = setInterval(() => {
    if (st.mode === 'dynamic' && st.dynamic) {
      const d = dynCfg();
      if (dynamicPick(d.set, now(), d.location).url !== st.dynamic.url) enterDynamic();
      else followSun();
    }
  }, 60000);
  shell.on('wallpaper:next', () => st.mode === 'slideshow' && slideshowStep(true));
  window.addEventListener('resize', () => {
    clearTimeout(st.timers.still);
    st.timers.still = setTimeout(() => updateStill(), 600);
  });

  // ---------------------------------------------------------------- lock screen
  let lockStill = '';
  async function prepareLock() {
    const all = settings.all();
    if (lockMode(all) === 'animated') lockStill = await effectStill(all.lockScreen?.effect, { mode: 'dark', accent: effectAccent() });
  }
  const engine = {
    get state() {
      const r = st.renderer;
      return {
        mode: st.mode,
        effect: r?.effect.id || null,
        running: !!r && r.running && !r.paused.size,
        paused: r ? [...r.paused] : [],
        frames: r?.frames || 0,
        fps: r?.fps || null,
        drawMs: r?.drawMs || 0,
        overrideUrl: st.overrideUrl,
        dynamic: st.dynamic ? { ...st.dynamic } : null,
        weather: st.weather,
        weatherError: st.weatherError,
        weatherFx: st.weatherRenderer ? { kind: tint.dataset.kind, running: st.weatherRenderer.running && !st.weatherRenderer.paused.size, frames: st.weatherRenderer.frames, paused: [...st.weatherRenderer.paused] } : null,
        slideshow: { index: st.slideshow.index, count: st.slideshow.list.length, url: st.slideshow.url },
      };
    },
    get renderer() {
      return st.renderer;
    },
    get weatherRenderer() {
      return st.weatherRenderer;
    },
    lockWallpaperUrl() {
      const all = settings.all();
      if (lockMode(all) === 'animated') return lockStill || theme.wallpaperUrl;
      return lockPictureUrl(all, theme.mode, { desktopUrl: theme.wallpaperUrl, now: now() });
    },
    attachLock(ls) {
      const all = settings.all();
      const m = lockMode(all);
      if (m === 'animated') return mountLockEffect(ls, { effect: all.lockScreen?.effect || 'aurora', params: { mode: 'dark', accent: effectAccent() }, fps: Number(animCfg().fps) === 15 ? 15 : 30 });
      // "same as the desktop" while the desktop is animated: the lock screen shows the same scene
      if (m === 'picture' && !all.lockWallpaper && st.mode === 'animated' && st.renderer) {
        const c = animCfg();
        return mountLockEffect(ls, { effect: st.renderer.effect.id, params: { ...st.renderer.params }, fps: Number(c.fps) === 15 ? 15 : 30 });
      }
      return null;
    },
    next: () => slideshowStep(true),
    refresh: () => apply().then(() => (st.mode === 'dynamic' ? fetchWeather(true) : null)),
    setClock(date) {
      clock = date ? { base: new Date(date).getTime(), at: Date.now() } : null;
      return apply().then(() => (st.mode === 'dynamic' ? enterDynamic() : null));
    },
    syncPause,
  };
  ctx.wallpaperEngine = engine;
  shell.wallpaperEngine = engine; // apps (Settings) reach it through ctx.shell
  await apply();
  prepareLock();
}
