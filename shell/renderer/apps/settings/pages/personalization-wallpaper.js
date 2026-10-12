// Settings > Personalization: Background, Lock screen, and Animated & dynamic wallpapers (area B1,
// docs/PERSONALIZATION.md §B1). The desktop side lives in core/features/wallpaper.js + core/wallpaper/.
//   background        Picture / Solid color / Slideshow / Animated / Dynamic (time of day, weather)
//   lockscreen        Picture (or same as desktop) / Picture of the day / Animated scene, + screen timeout
//   wallpaperEffects  effect gallery with live previews, speed, intensity, frame rate, pause when maximized;
//                     time-of-day sets, weather, location (offline cities + Open-Meteo search), theme follows the sun
// Keys: wallpaper, wallpaperFit, wallpaperMode, animatedWallpaper, dynamicWallpaper, slideshow, lockWallpaper, lockScreen.
// Shared builders (exported): kindControl(pc), effectGallery(pc, opts), animatedControls(pc), setGallery(pc),
//   dynamicControls(pc), slideshowControls(pc), heroPreview(pc), pickLocation(pc)
import { wallpaperChoices, resolveWallpaper } from '../../../core/theme.js';
import { WallpaperRenderer } from '../../../core/wallpaper/engine.js';
import { EFFECTS, effectById, WEATHER_EFFECT } from '../../../core/wallpaper/effects/index.js';
import { weatherTint } from '../../../core/wallpaper/effects/weather.js';
import { DYNAMIC_SETS, PHASE_NAMES, setById, variantUrl, dynamicPick, spotlightPick } from '../../../core/wallpaper/dynamic.js';
import { FIXED } from '../../../core/wallpaper/solar.js';
import { searchCities, samePlace } from '../../../core/wallpaper/cities.js';
import { thumb, solidWallpaper, solidColorOf } from './personalization.js';
import { liveSlider, pickColorDialog } from './personalization-designer.js';
import { PAGES } from '../lib/index.js';

const CSS = 'app://shell/apps/settings/pages/personalization-wallpaper.css';
const SOLIDS = ['#0b5394', '#1e3a5f', '#004e8c', '#0063b1', '#2d7d9a', '#038387', '#107c10', '#498205', '#5c2e91', '#8764b8', '#881798', '#c30052', '#a4262c', '#ca5010', '#986f0b', '#7a7574', '#4c4a48', '#1f1f1f'];
const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif', '.avif'];
const INTERVALS = [1, 10, 30, 60, 360, 1440];
const WEATHER_KINDS = ['live', 'clear', 'clouds', 'rain', 'snow', 'fog', 'storm'];

// ------------------------------------------------------------------ helpers
const setMany = (pc, patch) => pc.api.invoke('settings:setMany', patch);
const reduced = () => document.documentElement.dataset.reducedMotion === 'on' || document.documentElement.dataset.animations === 'off';
const modeOf = (pc) => (pc.settings.get('theme') === 'dark' ? 'dark' : 'light');
const anim = (pc) => ({ id: 'aurora', speed: 50, intensity: 50, fps: 30, pauseOnMaximized: true, ...(pc.settings.get('animatedWallpaper') || {}) });
const dyn = (pc) => ({ source: 'time', set: 'lake', location: null, followTheme: false, ...(pc.settings.get('dynamicWallpaper') || {}) });
const slide = (pc) => ({ folder: null, interval: 30, shuffle: true, ...(pc.settings.get('slideshow') || {}) });
const lockCfg = (pc) => ({ mode: 'picture', effect: 'aurora', ...(pc.settings.get('lockScreen') || {}) });
const engine = (pc) => pc.shell.wallpaperEngine || null;
const accentFor = (pc) => (pc.settings.get('accentFromWallpaper') ? '#0078d4' : pc.settings.get('accent') || '#0078d4');
const speedFactor = (v) => {
  const s = Number.isFinite(Number(v)) ? Math.max(0, Math.min(100, Number(v))) : 50;
  return s <= 50 ? 0.2 + (0.8 * s) / 50 : 1 + (1.5 * (s - 50)) / 50;
};
// "6:04 AM" / "06:04": two-digit hours with a 24-hour clock, like the taskbar clock
const fmtTime = (pc, d) => {
  if (!d) return '';
  const h24 = pc.settings.get('clock24h');
  let two = !!h24;
  if (h24 == null) {
    try {
      two = ['h23', 'h24'].includes(new Intl.DateTimeFormat(pc.i18n.locale, { hour: 'numeric' }).resolvedOptions().hourCycle);
    } catch {}
  }
  return pc.i18n.formatTime(new Date(d), { hour: two ? '2-digit' : 'numeric', minute: '2-digit', ...(h24 != null ? { hour12: !h24 } : {}) });
};
const clockText = (pc, hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return fmtTime(pc, d);
};

/** 'picture' | 'solid' | 'slideshow' | 'animated' | 'dynamic' */
export function kindOf(pc) {
  const m = pc.settings.get('wallpaperMode');
  if (m === 'animated' || m === 'dynamic' || m === 'slideshow') return m;
  return solidColorOf(pc.settings.get('wallpaper')) ? 'solid' : 'picture';
}

function bgImage(el, url) {
  if (!url) return;
  if (url.startsWith('data:') || url.startsWith('blob:')) el.style.backgroundImage = `url("${url}")`;
  else thumb(url).then((u) => (el.style.backgroundImage = `url("${u}")`));
}

/** A small live scene (Settings previews): starts when visible, 15 fps, still frame with reduced motion. */
function miniScene(pc, { effect, params, fps = 15, className } = {}) {
  const el = pc.h('div', { class: ['wp-mini', className], dataset: { effect: effect.id } });
  let r = null;
  let visible = false;
  let cur = { effect, params };
  const sync = () => {
    if (!r) return;
    r.setPaused('offscreen', !visible);
    r.setPaused('hidden', document.hidden);
    r.setPaused('minimized', !!pc.win?.minimized);
    const was = r.paused.has('motion');
    r.setPaused('motion', reduced());
    if (reduced() && !was) r.renderStill(cur.effect.heroTime ?? 12);
  };
  const ensure = () => {
    if (r || !el.isConnected || !el.clientWidth) return;
    r = new WallpaperRenderer({ host: el, effect: cur.effect, params: cur.params, fps });
    sync();
    r.start();
  };
  const io = new IntersectionObserver((entries) => {
    visible = entries.some((e) => e.isIntersecting);
    if (visible) ensure();
    sync();
  });
  io.observe(el);
  const mo = new MutationObserver(sync);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-animations', 'data-reduced-motion'] });
  document.addEventListener('visibilitychange', sync);
  const offWin = [pc.win?.on?.('minimize', sync), pc.win?.on?.('restore', sync)];
  pc.onDispose(() => {
    io.disconnect();
    mo.disconnect();
    document.removeEventListener('visibilitychange', sync);
    for (const off of offWin) typeof off === 'function' && off();
    r?.destroy();
    r = null;
  });
  el.update = ({ effect: e, params: p }) => {
    cur = { effect: e || cur.effect, params: { ...cur.params, ...(p || {}) } };
    el.dataset.effect = cur.effect.id;
    if (!r) return;
    if (r.effect !== cur.effect) r.setEffect(cur.effect);
    r.setParams(cur.params);
    if (reduced()) r.renderStill(cur.effect.heroTime ?? 12);
  };
  el.renderer = () => r;
  return el;
}

// ------------------------------------------------------------------ hero preview (desktop)
const heroStatus = (pc) => {
  const { t, L } = pc;
  const e = engine(pc)?.state;
  const k = kindOf(pc);
  if (k === 'animated') {
    const why = e?.paused?.filter((x) => x !== 'motion') || [];
    if (reduced()) return t('wp.status_still');
    if (why.length) return t('wp.status_paused', { why: why.map((w) => t(`wp.why_${w}`)).join(', ') });
    return t('wp.status_running', { fps: anim(pc).fps === 15 ? 15 : 30 });
  }
  if (k === 'dynamic') {
    const d = dyn(pc);
    const p = e?.dynamic || dynamicPick(d.set, new Date(), d.location);
    return t('wp.status_dynamic', { set: L(setById(d.set).name), phase: L(PHASE_NAMES[p.phase]) });
  }
  if (k === 'slideshow') {
    const s = e?.slideshow;
    return s?.count ? t('wp.status_slideshow', { n: s.index + 1, count: s.count }) : t('wp.kind_slideshow');
  }
  return k === 'solid' ? t('pers.solid') : t('wp.status_static');
};

export function heroPreview(pc, { tryWeather = null } = {}) {
  const { h, settings, t } = pc;
  pc.ui.loadCss(CSS);
  const pic = h('div', { class: 'wp-hero-pic' });
  const sceneBox = h('div', { class: 'wp-hero-layer' });
  const tintEl = h('div', { class: 'wp-hero-tint' });
  const wxBox = h('div', { class: 'wp-hero-layer' });
  const pv = h('div', { class: 'st-preview wp-hero', 'aria-hidden': 'true' }, pic, sceneBox, tintEl, wxBox, h('div', { class: 'pv-taskbar' }, h('i'), h('i'), h('i'), h('i'), h('i')));
  const status = h('div', { class: 'wp-hero-status body-strong' });
  const side = h('div', { class: 'wp-hero-side' }, h('div', { class: 'caption text-2' }, t('wp.heroNow')), status);
  let scene = null;
  let wx = null;
  const wxParamsOf = (kind) => {
    const e = engine(pc)?.state;
    const live = e?.weather;
    const p = e?.dynamic?.phase || 'day';
    const isDay = p === 'day' || p === 'dawn';
    if (kind && kind !== 'live') return { kind, intensity: 'moderate', isDay };
    if (dyn(pc).source !== 'weather' || !live) return null;
    return { kind: live.kind, intensity: live.intensity, isDay: live.isDay ?? isDay };
  };
  function paint() {
    const all = settings.all();
    const mode = modeOf(pc);
    const k = kindOf(pc);
    pv.dataset.mode = mode;
    pv.dataset.kind = k;
    pv.style.setProperty('--pv-accent', all.accent || '#0078d4');
    status.textContent = heroStatus(pc);
    // animated: a live mini scene; everything else: the picture
    if (k === 'animated') {
      const a = anim(pc);
      const params = { mode, accent: accentFor(pc), intensity: (Number(a.intensity) || 0) / 100, speed: speedFactor(a.speed) };
      if (!scene) {
        scene = miniScene(pc, { effect: effectById(a.id), params, fps: 15 });
        sceneBox.append(scene);
      } else scene.update({ effect: effectById(a.id), params });
      sceneBox.hidden = false;
    } else {
      sceneBox.hidden = true;
      const e = engine(pc)?.state;
      let url;
      if (k === 'dynamic') {
        const d = dyn(pc);
        url = dynamicPick(d.set, new Date(), d.location).url;
      } else if (k === 'slideshow') url = e?.slideshow?.url || e?.overrideUrl || resolveWallpaper(all.wallpaper, mode);
      else url = resolveWallpaper(all.wallpaper, mode);
      pv.dataset.fit = k === 'dynamic' ? 'fill' : all.wallpaperFit || 'fill';
      bgImage(pic, url);
    }
    // weather (dynamic + weather source, or the "Preview a weather" choice)
    const wp = k === 'dynamic' ? wxParamsOf(tryWeather?.() || 'live') : null;
    if (wp && wp.kind !== 'clear') {
      tintEl.style.background = weatherTint(wp.kind, wp.intensity, wp.isDay);
      tintEl.dataset.kind = wp.kind;
      if (!wx) {
        wx = miniScene(pc, { effect: WEATHER_EFFECT, params: { mode: 'dark', weather: wp, intensity: 0.5, speed: 1 }, fps: 15, className: 'wp-mini-weather' });
        wxBox.append(wx);
      } else wx.update({ params: { weather: wp } });
      wxBox.hidden = false;
    } else {
      tintEl.style.background = '';
      tintEl.dataset.kind = '';
      wxBox.hidden = true;
    }
  }
  paint();
  pc.onDispose(settings.on('*', () => queueMicrotask(paint)));
  pc.onDispose(pc.shell.on?.('wallpaper:changed', () => setTimeout(paint, 50)));
  pc.onDispose(pc.shell.on?.('wallpaper:weather', () => paint()));
  pc.onDispose(pc.shell.on?.('wallpaper:paused', () => (status.textContent = heroStatus(pc))));
  pc.every(5000, () => (status.textContent = heroStatus(pc)));
  const root = h('div', { class: 'st-pers-hero wp-hero-row' }, pv, side);
  root.repaint = paint;
  return root;
}

// ------------------------------------------------------------------ background kind (shared by Background + Effects pages)
export function kindControl(pc, { onKind } = {}) {
  const { t, settings, kit } = pc;
  const options = [
    { value: 'picture', label: t('pers.picture') },
    { value: 'solid', label: t('pers.solid') },
    { value: 'slideshow', label: t('wp.kind_slideshow') },
    { value: 'animated', label: t('wp.kind_animated') },
    { value: 'dynamic', label: t('wp.kind_dynamic') },
  ];
  const combo = kit.combo({
    options,
    value: kindOf(pc),
    label: t('pers.personalizeBg'),
    onChange: async (v) => {
      const patch = {};
      if (v === 'picture' || v === 'solid') {
        patch.wallpaperMode = 'static';
        const solid = !!solidColorOf(settings.get('wallpaper'));
        if (v === 'solid' && !solid) patch.wallpaper = solidWallpaper(SOLIDS[0]);
        if (v === 'picture' && solid) patch.wallpaper = 'builtin:nocturne';
      } else patch.wallpaperMode = v;
      await setMany(pc, patch);
      onKind?.(v);
    },
  });
  // The settings broadcast can arrive after settings:setMany resolves (the cache is still the old kind when
  // onChange calls onKind): repaint on every change; onKind is a no-op when the kind did not change.
  pc.onDispose(
    settings.on('*', () => {
      const k = kindOf(pc);
      if (combo.getValue() !== k) combo.setValue(k);
      onKind?.(k);
    }),
  );
  return kit.row({ icon: 'image', title: t('pers.personalizeBg'), desc: t('wp.kindDesc'), control: combo, section: 'mode' });
}

// ------------------------------------------------------------------ pictures (desktop + lock screen)
async function rememberCustom(pc, path) {
  const list = ((await pc.storage.get('recent-wallpapers', [])) || []).filter((p) => p !== path);
  list.unshift(path);
  await pc.storage.set('recent-wallpapers', list.slice(0, 5));
}
async function browseImage(pc, title) {
  const xdg = pc.shell.xdg || {};
  return pc.ui.filePicker({ mode: 'open', title, path: xdg.pictures, filters: [{ name: pc.t('pers.images'), ext: IMAGE_EXT }], parent: pc.win });
}
async function wallGrid(pc, { key, includeSame = false, onPick }) {
  const { h, t, settings, icon, L } = pc;
  const grid = h('div', { class: 'st-wall-grid', role: 'listbox', 'aria-label': t('pers.choosePhoto') });
  const recents = ((await pc.storage.get('recent-wallpapers', [])) || []).filter((p) => typeof p === 'string');
  const exists = await Promise.all(recents.map((p) => pc.api.invoke('fs:exists', p).catch(() => false)));
  const items = [];
  if (includeSame) items.push({ value: null, label: t('pers.sameAsDesktop') });
  for (const w of wallpaperChoices()) items.push({ value: `builtin:${w.id}`, label: L(w.name) });
  recents.forEach((p, i) => exists[i] && items.push({ value: p, label: p.split('/').pop() }));
  const tiles = items.map((it) => {
    const el = h('button', { class: 'st-wall', type: 'button', role: 'option', 'aria-label': it.label, 'data-tip': it.label, onclick: () => (onPick ? onPick(it.value) : settings.set(key, it.value)) });
    if (it.value === null) {
      el.classList.add('st-wall-same');
      el.append(h('span', { class: 'st-wall-same-label' }, icon('desktop', { size: 20 }), h('span', { class: 'caption' }, it.label)));
    }
    return { el, it };
  });
  const paintImages = () => {
    for (const { el, it } of tiles) bgImage(el, it.value === null ? engine(pc)?.state?.overrideUrl || resolveWallpaper(settings.get('wallpaper'), modeOf(pc)) : resolveWallpaper(it.value, modeOf(pc)));
  };
  const mark = () => {
    const cur = settings.get(key) ?? null;
    for (const { el, it } of tiles) {
      const on = (cur || null) === it.value;
      el.classList.toggle('selected', on);
      el.setAttribute('aria-selected', String(on));
      el.querySelector('.st-wall-check')?.remove();
      if (on) el.appendChild(h('span', { class: 'st-wall-check' }, icon('checkmark', { size: 12 })));
    }
  };
  grid.append(...tiles.map((x) => x.el));
  paintImages();
  mark();
  pc.onDispose(settings.on(key, mark));
  pc.onDispose(settings.on('theme', paintImages));
  return grid;
}

function pictureBody(pc, refresh) {
  const { h, t, kit, settings } = pc;
  const body = h('div');
  (async () => {
    const grid = await wallGrid(pc, { key: 'wallpaper' });
    body.append(
      kit.group(
        null,
        h('div', { class: 'st-expander open' }, kit.row({ icon: 'image_multiple', title: t('pers.recentImages'), className: 'st-exp-head' }), h('div', { class: 'st-exp-body' }, h('div', { class: 'wp-pad' }, grid))),
        kit.row({
          icon: 'folder_open',
          title: t('pers.choosePhoto'),
          control: kit.button(t('pers.browse'), async () => {
            const p = await browseImage(pc, t('pers.choosePhoto'));
            if (!p) return;
            await rememberCustom(pc, p);
            await setMany(pc, { wallpaper: p, wallpaperMode: 'static' });
            refresh();
          }),
        }),
        fitRow(pc),
      ),
    );
  })();
  return body;
}
function fitRow(pc) {
  const { t, kit, settings } = pc;
  const fitOpts = ['fill', 'fit', 'stretch', 'center', 'tile'].map((v) => ({ value: v, label: t(`pers.fit_${v}`) }));
  return kit.row({ icon: 'scale_fill', title: t('pers.fit'), section: 'fit', control: kit.combo({ options: fitOpts, value: settings.get('wallpaperFit') || 'fill', label: t('pers.fit'), onChange: (v) => settings.set('wallpaperFit', v) }) });
}

function solidBody(pc) {
  const { h, t, kit, settings } = pc;
  const sw = h('div', { class: 'st-solid-grid', role: 'listbox', 'aria-label': t('pers.backgroundColors') });
  const paint = () => {
    const cur = solidColorOf(settings.get('wallpaper'));
    sw.replaceChildren(
      ...SOLIDS.map((c) => {
        const b = h('button', { class: ['st-swatch', c === cur && 'selected'], type: 'button', role: 'option', 'aria-selected': String(c === cur), 'aria-label': c, onclick: () => setMany(pc, { wallpaper: solidWallpaper(c), wallpaperMode: 'static' }) });
        b.style.setProperty('--sw', c);
        return b;
      }),
    );
  };
  paint();
  pc.onDispose(settings.on('wallpaper', paint));
  return kit.group(
    null,
    h('div', { class: 'st-expander open' }, kit.row({ icon: 'color_background', title: t('pers.backgroundColors'), className: 'st-exp-head' }), h('div', { class: 'st-exp-body' }, h('div', { class: 'wp-pad' }, sw))),
    kit.row({
      icon: 'color',
      title: t('pers.customColor'),
      control: kit.button(t('pers.viewColors'), async () => {
        const c = await pickColorDialog(pc, solidColorOf(settings.get('wallpaper')) || '#0b5394');
        if (c && c !== 'default') await setMany(pc, { wallpaper: solidWallpaper(c), wallpaperMode: 'static' });
      }),
    }),
  );
}

// ------------------------------------------------------------------ slideshow
export function slideshowControls(pc) {
  const { h, t, kit, settings, icon } = pc;
  const folderText = h('span', { class: 'wp-folder ellipsis' });
  const countText = h('span', { class: 'caption text-2' });
  const note = h('div', { class: 'caption text-2 wp-note', hidden: true });
  let builtin = null;
  const paintFolder = async () => {
    const f = slide(pc).folder;
    folderText.textContent = f || t('wp.slideBuiltin');
    folderText.title = f || '';
    if (builtin) builtin.hidden = !f;
    if (!f) {
      countText.textContent = '';
      note.hidden = true;
      return;
    }
    const list = await pc.api.invoke('fs:list', f).catch(() => []);
    const n = list.filter((e) => !e.dir && /\.(jpe?g|png|webp|avif|gif|bmp)$/i.test(e.name || '')).length;
    countText.textContent = t('wp.slideCount', { count: n });
    note.textContent = t('wp.slideEmpty');
    note.hidden = n > 0;
  };
  const browse = kit.button(t('wp.slideBrowse'), async () => {
    const dir = await pc.ui.filePicker({ mode: 'folder', title: t('wp.slideFolder'), path: slide(pc).folder || pc.shell.xdg?.pictures, parent: pc.win });
    if (dir) await settings.set('slideshow.folder', dir);
  });
  // shown only while a folder is chosen (kept in the row so it appears / disappears live)
  builtin = kit.button(t('wp.slideUseBuiltin'), () => settings.set('slideshow.folder', null));
  paintFolder();
  pc.onDispose(settings.on('slideshow.folder', paintFolder));
  const fmtInterval = (m) => (m >= 1440 ? t('wp.day', { count: m / 1440 }) : m >= 60 ? t('power.h', { count: m / 60 }) : t('power.m', { count: m }));
  const every = kit.combo({ options: INTERVALS.map((m) => ({ value: m, label: fmtInterval(m) })), value: INTERVALS.includes(Number(slide(pc).interval)) ? Number(slide(pc).interval) : 30, label: t('wp.slideEvery'), onChange: (v) => settings.set('slideshow.interval', Number(v)) });
  const shuffle = kit.toggle({ value: slide(pc).shuffle !== false, label: t('wp.shuffle'), onChange: (v) => settings.set('slideshow.shuffle', v) });
  pc.onDispose(settings.on('slideshow', () => shuffle.set(slide(pc).shuffle !== false)));
  return kit.group(
    null,
    kit.row({ icon: 'image_multiple', title: t('wp.slideFolder'), desc: h('span', { class: 'wp-folder-line' }, folderText, countText), section: 'slideshow', control: h('div', { class: 'row wp-btns' }, builtin, browse) }),
    note,
    kit.row({ icon: 'timer', title: t('wp.slideEvery'), control: every }),
    kit.row({ icon: 'arrow_shuffle', title: t('wp.shuffle'), control: shuffle }),
    kit.row({ icon: 'next', title: t('wp.next'), desc: t('wp.nextDesc'), control: kit.button(t('wp.next'), () => pc.shell.emit('wallpaper:next'), { icon: 'next' }) }),
    fitRow(pc),
  );
}

// ------------------------------------------------------------------ animated
/** Gallery of effects with live mini previews, bound to a key ('animatedWallpaper.id' or 'lockScreen.effect'). */
export function effectGallery(pc, { key = 'animatedWallpaper.id', onPick, activeMode } = {}) {
  const { h, t, settings, L, icon } = pc;
  pc.ui.loadCss(CSS);
  const cur = () => settings.get(key) || 'aurora';
  const grid = h('div', { class: 'wp-gallery', role: 'radiogroup', 'aria-label': t('wp.effects') });
  const cards = EFFECTS.map((e) => {
    const params = () => ({ mode: key.startsWith('lock') ? 'dark' : modeOf(pc), accent: accentFor(pc), intensity: (Number(anim(pc).intensity) || 50) / 100, speed: speedFactor(anim(pc).speed) });
    const mini = miniScene(pc, { effect: e, params: params(), fps: 15 });
    const card = h(
      'button',
      {
        class: 'wp-card',
        type: 'button',
        role: 'radio',
        dataset: { effect: e.id },
        'aria-label': L(e.name),
        onclick: () => (onPick ? onPick(e.id) : settings.set(key, e.id)),
      },
      h('div', { class: 'wp-card-pv' }, mini, h('span', { class: 'wp-card-check' }, icon('checkmark', { size: 12 }))),
      h('div', { class: 'wp-card-text' }, h('div', { class: 'wp-card-title' }, L(e.name)), h('div', { class: 'wp-card-desc caption text-2' }, L(e.desc))),
    );
    card.mini = mini;
    card.params = params;
    return card;
  });
  const mark = () => {
    grid.classList.toggle('wp-inactive', !!activeMode && settings.get('wallpaperMode') !== activeMode);
    for (const c of cards) {
      const on = c.dataset.effect === cur();
      c.classList.toggle('selected', on);
      c.setAttribute('aria-checked', String(on));
      c.tabIndex = on ? 0 : -1;
    }
  };
  // arrow keys move between cards (radio group)
  grid.addEventListener('keydown', (e) => {
    if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(e.key)) return;
    const i = cards.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    const n = cards[(i + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1) + cards.length) % cards.length];
    n.focus();
    n.click();
  });
  grid.append(...cards);
  mark();
  pc.onDispose(settings.on(key, mark));
  pc.onDispose(settings.on('wallpaperMode', mark));
  pc.onDispose(settings.on('*', () => queueMicrotask(() => cards.forEach((c) => c.mini.update({ params: c.params() })))));
  return grid;
}

export function animatedControls(pc) {
  const { h, t, kit, settings } = pc;
  const fps = kit.combo({
    options: [
      { value: 15, label: t('wp.fps15') },
      { value: 30, label: t('wp.fps30') },
    ],
    value: anim(pc).fps === 15 ? 15 : 30,
    label: t('wp.fps'),
    onChange: (v) => settings.set('animatedWallpaper.fps', Number(v)),
  });
  const pause = kit.toggle({ value: anim(pc).pauseOnMaximized !== false, label: t('wp.pauseMax'), onChange: (v) => settings.set('animatedWallpaper.pauseOnMaximized', v) });
  pc.onDispose(
    settings.on('animatedWallpaper', () => {
      fps.setValue(anim(pc).fps === 15 ? 15 : 30);
      pause.set(anim(pc).pauseOnMaximized !== false);
    }),
  );
  const note = kit.infobar({ kind: 'info', message: t('wp.motionOff'), action: kit.link(t('wp.motionLink'), () => pc.go('visualEffects', 'reducedMotion')), className: 'wp-motion-note' });
  const paintNote = () => (note.hidden = !reduced());
  paintNote();
  const mo = new MutationObserver(paintNote);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-animations', 'data-reduced-motion'] });
  pc.onDispose(() => mo.disconnect());
  return h(
    'div',
    { class: 'wp-anim-controls' },
    note,
    kit.group(
      null,
      kit.row({ icon: 'top_speed', title: t('wp.speed'), desc: t('wp.speedDesc'), section: 'speed', control: liveSlider(pc, { key: 'animatedWallpaper.speed', min: 0, max: 100, def: 50, label: t('wp.speed'), format: (v) => `${v}` }) }),
      kit.row({ icon: 'brightness_high', title: t('wp.intensity'), desc: t('wp.intensityDesc'), section: 'intensity', control: liveSlider(pc, { key: 'animatedWallpaper.intensity', min: 0, max: 100, def: 50, label: t('wp.intensity'), format: (v) => `${v}` }) }),
      kit.row({ icon: 'fps_30', title: t('wp.fps'), desc: t('wp.fpsDesc'), section: 'fps', control: fps }),
      kit.row({ icon: 'window_multiple', title: t('wp.pauseMax'), desc: t('wp.pauseMaxDesc'), section: 'pauseMax', control: pause }),
    ),
  );
}

// ------------------------------------------------------------------ dynamic
export function setGallery(pc, { onPick, activeMode } = {}) {
  const { h, t, settings, L, icon } = pc;
  pc.ui.loadCss(CSS);
  const grid = h('div', { class: 'wp-sets', role: 'radiogroup', 'aria-label': t('wp.sets') });
  const cards = DYNAMIC_SETS.map((s) => {
    const cells = ['dawn', 'day', 'dusk', 'night'].map((ph) => {
      const cell = h('span', { class: 'wp-set-cell', dataset: { phase: ph }, 'data-tip': L(PHASE_NAMES[ph]) });
      bgImage(cell, variantUrl(s.id, ph));
      return cell;
    });
    return h(
      'button',
      { class: 'wp-set', type: 'button', role: 'radio', dataset: { set: s.id }, 'aria-label': L(s.name), onclick: () => (onPick ? onPick(s.id) : settings.set('dynamicWallpaper.set', s.id)) },
      h('div', { class: 'wp-set-strip' }, cells),
      h('div', { class: 'wp-set-text' }, h('span', { class: 'wp-card-title' }, L(s.name)), h('span', { class: 'wp-set-phase caption text-2' })),
      h('span', { class: 'wp-card-check' }, icon('checkmark', { size: 12 })),
    );
  });
  const mark = () => {
    const d = dyn(pc);
    const p = dynamicPick(d.set, new Date(), d.location).phase;
    grid.classList.toggle('wp-inactive', !!activeMode && settings.get('wallpaperMode') !== activeMode);
    for (const c of cards) {
      const on = c.dataset.set === d.set;
      c.classList.toggle('selected', on);
      c.setAttribute('aria-checked', String(on));
      for (const cell of c.querySelectorAll('.wp-set-cell')) cell.classList.toggle('now', cell.dataset.phase === p);
      c.querySelector('.wp-set-phase').textContent = L(PHASE_NAMES[p]);
    }
  };
  grid.append(...cards);
  mark();
  pc.onDispose(settings.on('dynamicWallpaper', mark));
  pc.onDispose(settings.on('wallpaperMode', mark));
  pc.every(60000, mark);
  return grid;
}

function placeLabel(pc, loc) {
  if (!loc) return '';
  const coords = `${Number(loc.lat).toFixed(2)}, ${Number(loc.lon).toFixed(2)}`;
  return loc.name ? `${loc.name} (${coords})` : coords;
}

/** Location dialog: offline cities + online search (weather:search) + manual coordinates. Resolves to a place, 'clear' or null. */
export async function pickLocation(pc) {
  const { h, t, ui, i18n } = pc;
  pc.ui.loadCss(CSS);
  const input = h('input', { class: 'input', type: 'search', autocomplete: 'off', spellcheck: false, placeholder: t('wp.locSearch'), 'aria-label': t('wp.locSearch') });
  const list = h('div', { class: 'wp-loc-list', role: 'listbox', 'aria-label': t('wp.locSearch') });
  const msg = h('div', { class: 'caption text-2 wp-loc-msg' }, t('wp.locSearchHint'));
  const cur = dyn(pc).location;
  const lat = h('input', { class: 'input', inputmode: 'decimal', value: cur ? String(cur.lat) : '', 'aria-label': t('wp.lat'), placeholder: '48.8566' });
  const lon = h('input', { class: 'input', inputmode: 'decimal', value: cur ? String(cur.lon) : '', 'aria-label': t('wp.lon'), placeholder: '2.3522' });
  const name = h('input', { class: 'input', value: cur?.name || '', maxLength: 80, 'aria-label': t('wp.locName'), placeholder: t('wp.locNameDefault') });
  const err = h('div', { class: 'caption wp-loc-err', role: 'alert', hidden: true }, t('wp.invalidCoords'));
  let dlgEl = null;
  const choose = (place) => dlgEl?._done?.(place);
  let seq = 0;
  let timer = 0;
  function render(items, note) {
    list.replaceChildren(
      ...items.map((p) =>
        h(
          'button',
          { class: 'wp-loc-item', type: 'button', role: 'option', dataset: { lat: p.lat, lon: p.lon }, onclick: () => choose({ name: p.name, lat: Math.round(p.lat * 10000) / 10000, lon: Math.round(p.lon * 10000) / 10000 }) },
          pc.icon('location', { size: 16 }),
          h('span', { class: 'wp-loc-name' }, p.name),
          h('span', { class: 'caption text-2 ellipsis' }, [p.admin1, p.country].filter(Boolean).join(', ')),
        ),
      ),
    );
    msg.textContent = note || '';
    msg.hidden = !note;
  }
  async function search() {
    const q = input.value.trim();
    const my = ++seq;
    if (q.length < 2) return render([], t('wp.locSearchHint'));
    const offline = searchCities(q, i18n.lang, 6);
    render(offline, t('wp.locSearching'));
    let online = null;
    try {
      online = await pc.api.invoke('weather:search', q, { lang: i18n.lang, count: 8 });
    } catch {
      online = null;
    }
    if (my !== seq) return;
    // online results first (they name the region); a built-in city they already list is not shown twice
    const merged = [];
    for (const p of [...(online || []), ...offline]) if (!merged.some((m) => samePlace(m, p))) merged.push(p);
    render(merged.slice(0, 10), online === null ? t('wp.locOffline') : merged.length ? '' : t('wp.locNoResult'));
  }
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(search, 250);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && list.firstChild) {
      e.preventDefault();
      list.firstChild.focus();
    }
  });
  list.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [...list.children];
    const i = items.indexOf(document.activeElement);
    (items[i + (e.key === 'ArrowDown' ? 1 : -1)] || (e.key === 'ArrowUp' ? input : null))?.focus();
  });
  const useCoords = pc.kit.button(t('wp.useCoords'), () => {
    const a = Number(String(lat.value).replace(',', '.'));
    const b = Number(String(lon.value).replace(',', '.'));
    if (!lat.value.trim() || !lon.value.trim() || !Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a) > 90 || Math.abs(b) > 180) {
      err.hidden = false;
      return;
    }
    choose({ name: name.value.trim().slice(0, 80) || t('wp.locNameDefault'), lat: Math.round(a * 10000) / 10000, lon: Math.round(b * 10000) / 10000 });
  });
  useCoords.classList.add('wp-use-coords');
  const body = h(
    'div',
    { class: 'wp-loc-dialog' },
    input,
    msg,
    list,
    h('div', { class: 'wp-loc-manual' }, h('div', { class: 'body-strong' }, t('wp.locManual')), h('div', { class: 'wp-loc-grid' }, h('label', null, h('span', { class: 'caption text-2' }, t('wp.lat')), lat), h('label', null, h('span', { class: 'caption text-2' }, t('wp.lon')), lon), h('label', { class: 'wp-loc-name-field' }, h('span', { class: 'caption text-2' }, t('wp.locName')), name)), err, useCoords),
  );
  const buttons = [];
  if (cur) buttons.push({ label: t('wp.clearLocation'), value: 'clear' });
  buttons.push({ label: t('common.cancel'), value: null });
  const shown = ui.dialog({ title: t('wp.locTitle'), body, parent: pc.win, buttons, className: 'wp-loc-dlg', width: 460 });
  dlgEl = body.closest('.dialog');
  const r = await shown;
  clearTimeout(timer);
  return r;
}

function sunText(pc) {
  const { t, L } = pc;
  const d = dyn(pc);
  const p = dynamicPick(d.set, new Date(), d.location);
  if (p.polar) return t(p.polar === 'day' ? 'wp.polarDay' : 'wp.polarNight');
  const head = p.source === 'fixed' ? t('wp.sunFixed', { rise: clockText(pc, FIXED.sunrise), set: clockText(pc, FIXED.sunset) }) : t('wp.sunInfo', { rise: fmtTime(pc, p.sunrise), set: fmtTime(pc, p.sunset) });
  const order = ['dawn', 'day', 'dusk', 'night'];
  const nextPhase = order[(order.indexOf(p.phase) + 1) % 4];
  return `${head} · ${t('wp.phaseNow', { phase: L(PHASE_NAMES[p.phase]) })} · ${t('wp.phaseNext', { phase: L(PHASE_NAMES[nextPhase]), time: fmtTime(pc, p.next) })}`;
}

function weatherText(pc) {
  const { t } = pc;
  const d = dyn(pc);
  if (!d.location) return { text: t('wp.weatherNoLoc'), kind: 'info' };
  const e = engine(pc)?.state;
  const w = e?.weather;
  if (!w) return { text: e?.weatherError ? t('wp.weatherOffline') : t('wp.locSearching'), kind: e?.weatherError ? 'warning' : 'info' };
  const temp = w.temperature == null ? '' : `${pc.i18n.formatNumber(w.temperature, { maximumFractionDigits: 0 })} °C`;
  const head = t('wp.weatherNow', { desc: t(`wp.w_${w.describe || 'clear'}`), temp }).replace(/,\s*$/, '');
  const when = fmtTime(pc, w.fetchedAt);
  return { text: `${head} — ${w.stale ? t('wp.weatherStale', { time: when }) : t('wp.weatherWhere', { place: d.location.name || placeLabel(pc, d.location), time: when })}`, kind: w.stale ? 'warning' : 'ok', icon: weatherIcon(w) };
}
function weatherIcon(w) {
  const night = w?.isDay === false;
  switch (w?.kind) {
    case 'clouds':
      return w.intensity === 'light' ? (night ? 'weather_partly_cloudy_night' : 'weather_partly_cloudy_day') : 'weather_cloudy';
    case 'rain':
      return 'weather_rain';
    case 'snow':
      return 'weather_snow';
    case 'fog':
      return 'weather_fog';
    case 'storm':
      return 'weather_thunderstorm';
    default:
      return night ? 'weather_moon' : 'weather_sunny';
  }
}

export function dynamicControls(pc, { tryWeather } = {}) {
  const { h, t, kit, settings } = pc;
  const source = pc.ui.segmented({
    options: [
      { value: 'time', label: t('wp.source_time') },
      { value: 'weather', label: t('wp.source_weather') },
    ],
    value: dyn(pc).source === 'weather' ? 'weather' : 'time',
    onchange: (v) => settings.set('dynamicWallpaper.source', v),
  });
  source.classList.add('wp-source');
  source.setAttribute('aria-label', t('wp.source'));
  const locText = h('span', { class: 'wp-loc-text' });
  const locBtn = kit.button('', async () => {
    const r = await pickLocation(pc);
    if (r === 'clear') await settings.set('dynamicWallpaper.location', null);
    else if (r && typeof r === 'object') await settings.set('dynamicWallpaper.location', r);
  });
  locBtn.classList.add('wp-loc-btn');
  const sun = h('span', { class: 'wp-sun-text' });
  const follow = kit.toggle({
    value: dyn(pc).followTheme === true,
    label: t('wp.follow'),
    // following the sun replaces the fixed-hours "Auto" mode of the Colors page
    onChange: (v) => setMany(pc, v && settings.get('autoTheme')?.enabled ? { 'dynamicWallpaper.followTheme': true, 'autoTheme.enabled': false } : { 'dynamicWallpaper.followTheme': v }),
  });
  const followNote = h('div', { class: 'caption text-2 wp-note', hidden: true }, t('wp.followAuto'));
  const wxIcon = h('span', { class: 'wp-wx-icon' });
  const wxText = h('span', { class: 'wp-wx-text' });
  const wxRow = kit.row({
    icon: wxIcon,
    title: t('wp.weather'),
    desc: wxText,
    section: 'weather',
    control: kit.button(t('wp.refresh'), () => engine(pc)?.refresh?.(), { icon: 'arrow_clockwise' }),
  });
  let sourceVal = dyn(pc).source === 'weather' ? 'weather' : 'time';
  const paint = () => {
    const d = dyn(pc);
    const sv = d.source === 'weather' ? 'weather' : 'time';
    if (sv !== sourceVal) source.setValue((sourceVal = sv));
    locText.textContent = d.location ? placeLabel(pc, d.location) : t('wp.locationNone', { rise: clockText(pc, FIXED.sunrise), set: clockText(pc, FIXED.sunset) });
    locBtn.textContent = d.location ? t('wp.change') : t('wp.setLocation');
    sun.textContent = sunText(pc);
    follow.set(d.followTheme === true);
    followNote.hidden = !(d.followTheme && settings.get('autoTheme')?.enabled);
    wxRow.hidden = d.source !== 'weather';
    if (d.source === 'weather') {
      const w = weatherText(pc);
      wxText.textContent = w.text;
      wxRow.dataset.state = w.kind;
      wxIcon.replaceChildren(pc.icon(w.icon || 'weather_partly_cloudy_day', { size: 20 }));
    }
  };
  paint();
  pc.onDispose(settings.on('dynamicWallpaper', paint));
  pc.onDispose(settings.on('autoTheme', paint));
  pc.onDispose(pc.shell.on?.('wallpaper:weather', paint));
  pc.every(30000, paint);
  // "Preview a weather" (only in the preview above)
  let tryRow = null;
  if (tryWeather) {
    const seg = pc.ui.segmented({ options: WEATHER_KINDS.map((k) => ({ value: k, label: t(`wp.k_${k}`) })), value: tryWeather.get(), onchange: (v) => tryWeather.set(v) });
    seg.classList.add('wp-try');
    seg.setAttribute('aria-label', t('wp.tryWeather'));
    tryRow = kit.row({ icon: 'weather_partly_cloudy_day', title: t('wp.tryWeather'), desc: t('wp.tryWeatherDesc'), section: 'tryWeather', control: seg, className: 'wp-row-wrap' });
  }
  return kit.group(
    null,
    kit.row({ icon: 'weather_sunny_low', title: t('wp.source'), desc: t('wp.sourceDesc'), section: 'source', control: source, className: 'wp-row-wrap' }),
    kit.row({ icon: 'location', title: t('wp.location'), desc: h('span', null, h('span', { class: 'wp-loc-sub' }, t('wp.locationDesc')), h('br'), locText), section: 'location', control: locBtn }),
    kit.row({ icon: 'clock', title: t('wp.today'), desc: sun, section: 'sun' }),
    kit.row({ icon: 'dark_theme', title: t('wp.follow'), desc: h('span', null, t('wp.followDesc'), followNote), section: 'follow', control: follow }),
    wxRow,
    tryRow,
  );
}

// ------------------------------------------------------------------ pages
async function background(pc) {
  const { h, t, kit, L } = pc;
  pc.ui.loadCss(CSS);
  const root = h('div', { class: 'wp-page' });
  const hero = heroPreview(pc);
  const body = h('div');
  let shown = null;
  function paintBody(force) {
    const k = kindOf(pc);
    if (k === shown && !force) return;
    // leaving a kind disposes nothing global (the page's disposers clean up when the page is left)
    shown = k;
    body.dataset.kind = k;
    if (k === 'picture') body.replaceChildren(pictureBody(pc, () => paintBody(true)));
    else if (k === 'solid') body.replaceChildren(solidBody(pc));
    else if (k === 'slideshow') body.replaceChildren(slideshowControls(pc));
    else if (k === 'animated') body.replaceChildren(h('section', { class: 'st-group', dataset: { section: 'animated' } }, h('h3', { class: 'st-group-title' }, t('wp.effects')), effectGallery(pc)), animatedControls(pc));
    else body.replaceChildren(h('section', { class: 'st-group', dataset: { section: 'dynamic' } }, h('h3', { class: 'st-group-title' }, t('wp.sets')), setGallery(pc)), dynamicControls(pc));
  }
  paintBody();
  root.append(
    hero,
    kit.group(null, kindControl(pc, { onKind: () => paintBody() })),
    body,
    kit.related([
      { icon: PAGES.wallpaperEffects.icon, title: pc.pageTitle('wallpaperEffects'), desc: t('wp.relatedEffects'), onClick: () => pc.go('wallpaperEffects') },
      { icon: 'lock_closed', title: pc.pageTitle('lockscreen'), desc: L(PAGES.lockscreen.desc), onClick: () => pc.go('lockscreen') },
      { icon: 'color', title: pc.pageTitle('colors'), desc: L(PAGES.colors.desc), onClick: () => pc.go('colors') },
    ]),
  );
  return root;
}

async function wallpaperEffects(pc) {
  const { h, t, kit, settings, L } = pc;
  pc.ui.loadCss(CSS);
  let tryKind = 'live';
  let hero = null;
  const tryWeather = {
    get: () => tryKind,
    set: (v) => {
      tryKind = v;
      hero?.repaint();
    },
  };
  hero = heroPreview(pc, { tryWeather: () => tryKind });
  // picking an effect or a set also switches the desktop to that mode
  const gallery = effectGallery(pc, { activeMode: 'animated', onPick: (id) => setMany(pc, { 'animatedWallpaper.id': id, wallpaperMode: 'animated' }) });
  const sets = setGallery(pc, { activeMode: 'dynamic', onPick: (id) => setMany(pc, { 'dynamicWallpaper.set': id, wallpaperMode: 'dynamic' }) });
  return h(
    'div',
    { class: 'wp-page' },
    hero,
    kit.group(null, kindControl(pc)),
    h('section', { class: 'st-group', dataset: { section: 'animated' } }, h('h3', { class: 'st-group-title' }, t('wp.effects')), h('div', { class: 'caption text-2 wp-group-desc' }, t('wp.effectsDesc')), gallery),
    animatedControls(pc),
    h('section', { class: 'st-group', dataset: { section: 'dynamic' } }, h('h3', { class: 'st-group-title' }, t('wp.sets')), h('div', { class: 'caption text-2 wp-group-desc' }, t('wp.setsDesc')), sets),
    dynamicControls(pc, { tryWeather }),
    kit.related([
      { icon: 'image', title: pc.pageTitle('background'), desc: t('wp.relatedBackground'), onClick: () => pc.go('background') },
      { icon: 'lock_closed', title: pc.pageTitle('lockscreen'), desc: L(PAGES.lockscreen.desc), onClick: () => pc.go('lockscreen') },
      { icon: 'eye', title: pc.pageTitle('visualEffects'), desc: L(PAGES.visualEffects.desc), onClick: () => pc.go('visualEffects') },
    ]),
  );
}

async function lockscreen(pc) {
  const { h, t, kit, settings, i18n, L } = pc;
  pc.ui.loadCss(CSS);
  const pic = h('div', { class: 'wp-hero-pic' });
  const sceneBox = h('div', { class: 'wp-hero-layer' });
  const lockPv = h('div', { class: 'st-preview st-lock-preview wp-lock-pv', 'aria-hidden': 'true' }, pic, sceneBox, h('div', { class: 'st-lock-time' }), h('div', { class: 'st-lock-date' }));
  let scene = null;
  const paintPv = () => {
    const c = lockCfg(pc);
    const now = new Date();
    lockPv.dataset.mode = c.mode;
    lockPv.querySelector('.st-lock-time').textContent = i18n.formatTime(now, { hour: 'numeric', minute: '2-digit', hour12: settings.get('clock24h') == null ? undefined : !settings.get('clock24h') });
    lockPv.querySelector('.st-lock-date').textContent = i18n.formatDate(now, { weekday: 'long', month: 'long', day: 'numeric' });
    if (c.mode === 'animated') {
      const params = { mode: 'dark', accent: accentFor(pc), intensity: 0.5, speed: 1 };
      if (!scene) {
        scene = miniScene(pc, { effect: effectById(c.effect), params, fps: 15 });
        sceneBox.append(scene);
      } else scene.update({ effect: effectById(c.effect), params });
      sceneBox.hidden = false;
      return;
    }
    sceneBox.hidden = true;
    const url = c.mode === 'spotlight' ? spotlightPick(now).url : settings.get('lockWallpaper') ? resolveWallpaper(settings.get('lockWallpaper'), modeOf(pc)) : engine(pc)?.state?.overrideUrl || resolveWallpaper(settings.get('wallpaper'), modeOf(pc));
    bgImage(pic, url);
  };
  paintPv();
  pc.onDispose(settings.on('*', () => queueMicrotask(paintPv)));
  pc.every(15000, paintPv);

  const body = h('div');
  let shown = null;
  async function paintBody(force) {
    const c = lockCfg(pc);
    if (c.mode === shown && !force) return;
    shown = c.mode;
    body.dataset.mode = c.mode;
    if (c.mode === 'picture') {
      const grid = await wallGrid(pc, { key: 'lockWallpaper', includeSame: true });
      if (shown !== 'picture') return;
      body.replaceChildren(
        kit.group(
          null,
          h('div', { class: 'st-expander open' }, kit.row({ icon: 'image', title: t('wp.lock_picture'), desc: t('pers.lockPictureDesc'), className: 'st-exp-head' }), h('div', { class: 'st-exp-body' }, h('div', { class: 'wp-pad' }, grid))),
          kit.row({
            icon: 'folder_open',
            title: t('pers.choosePhoto'),
            control: kit.button(t('pers.browse'), async () => {
              const p = await browseImage(pc, t('pers.lockPicture'));
              if (!p) return;
              await rememberCustom(pc, p);
              await settings.set('lockWallpaper', p);
              paintBody(true);
            }),
          }),
        ),
      );
    } else if (c.mode === 'spotlight') {
      const today = spotlightPick(new Date());
      const next = [1, 2, 3, 4].map((i) => spotlightPick(new Date(), i));
      const strip = h(
        'div',
        { class: 'wp-spot-strip' },
        next.map((p) => {
          const el = h('div', { class: 'wp-spot', 'data-tip': L(p.name), 'aria-label': L(p.name), role: 'img' });
          bgImage(el, p.url);
          return el;
        }),
      );
      body.replaceChildren(
        kit.group(
          null,
          kit.row({ icon: 'image_sparkle', title: t('wp.spotlightToday', { name: L(today.name) }), desc: t('wp.spotlightDesc'), section: 'spotlight' }),
          h('div', { class: 'st-row wp-spot-row' }, h('div', { class: 'wp-spot-head caption text-2' }, t('wp.spotlightNext')), strip),
        ),
      );
    } else {
      body.replaceChildren(h('section', { class: 'st-group', dataset: { section: 'lockEffect' } }, h('h3', { class: 'st-group-title' }, t('wp.lockEffect')), h('div', { class: 'caption text-2 wp-group-desc' }, t('wp.lockEffectDesc')), effectGallery(pc, { key: 'lockScreen.effect' })));
    }
  }
  const modeCombo = kit.combo({
    options: ['picture', 'spotlight', 'animated'].map((v) => ({ value: v, label: t(`wp.lock_${v}`) })),
    value: lockCfg(pc).mode,
    label: t('pers.lockPicture'),
    onChange: async (v) => {
      await settings.set('lockScreen.mode', v);
      paintBody();
    },
  });
  pc.onDispose(
    settings.on('lockScreen', () => {
      modeCombo.setValue(lockCfg(pc).mode);
      paintBody();
    }),
  );
  await paintBody();
  const opts = [0, 1, 2, 3, 5, 10, 15, 30, 60].map((m) => ({ value: m, label: m === 0 ? t('power.never') : m >= 60 ? t('power.h', { count: m / 60 }) : t('power.m', { count: m }) }));
  return h(
    'div',
    { class: 'wp-page' },
    h('div', { class: 'st-pers-hero' }, lockPv),
    kit.group(null, kit.row({ icon: 'lock_closed', title: t('pers.lockPicture'), desc: t('wp.lockKindDesc'), section: 'mode', control: modeCombo })),
    body,
    kit.group(null, kit.row({ icon: 'timer', title: t('power.lockAfter'), desc: t('power.lockAfterDesc'), control: kit.combo({ options: opts, value: Number(settings.get('lockTimeout')) || 0, label: t('power.lockAfter'), onChange: (v) => settings.set('lockTimeout', Number(v)) }) })),
    kit.related([
      { icon: 'image', title: pc.pageTitle('background'), desc: t('wp.relatedBackground'), onClick: () => pc.go('background') },
      { icon: PAGES.wallpaperEffects.icon, title: pc.pageTitle('wallpaperEffects'), desc: t('wp.relatedEffects'), onClick: () => pc.go('wallpaperEffects') },
    ]),
  );
}

export default { background, lockscreen, wallpaperEffects };
