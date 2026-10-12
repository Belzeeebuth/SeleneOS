// Settings > Personalization: preview + themes and the index of every personalization page, Background,
// Colors, Themes, Lock screen. (Taskbar + Start: personalization-taskbar.js; Theme designer, Visual style,
// Profiles, App themes: personalization-designer.js; see docs/PERSONALIZATION.md.)
import { wallpaperChoices, ACCENTS, ACCENT_PRESETS, accentPreset, resolveWallpaper, theme as coreTheme } from '../../../core/theme.js';
import { PAGES } from '../lib/index.js';
import { modeControl, accentControls, taskbarColorControls, rovingFocus, ambianceControl } from './personalization-designer.js';
import { ensureStrings } from './personalization-strings.js';
import { finishSection, customizeSection } from './personalization-finish.js';

ensureStrings();

export const THEMES = [
  { id: 'dark', name: { en: 'Nocturne', fr: 'Nocturne' }, wallpaper: 'builtin:nocturne', theme: 'dark', accent: '#c9d3e6' },
  { id: 'light', name: { en: 'Nocturne, light', fr: 'Nocturne clair' }, wallpaper: 'builtin:nocturne', theme: 'light', accent: '#c9d3e6' },
  { id: 'eclipse', name: { en: 'Eclipse', fr: 'Éclipse' }, wallpaper: 'builtin:eclipse', theme: 'dark', accent: '#e9b566' },
  { id: 'eclipse-light', name: { en: 'Eclipse, light', fr: 'Éclipse clair' }, wallpaper: 'builtin:eclipse', theme: 'light', accent: '#e9b566' },
  { id: 'clairdelune', name: { en: 'Clair de lune', fr: 'Clair de lune' }, wallpaper: 'builtin:clairdelune', theme: 'dark', accent: '#a58bf2' },
  { id: 'clairdelune-light', name: { en: 'Clair de lune, dawn', fr: 'Clair de lune, aube' }, wallpaper: 'builtin:clairdelune', theme: 'light', accent: '#6f8de6' },
];

const SOLIDS = ['#0b5394', '#1e3a5f', '#004e8c', '#0063b1', '#2d7d9a', '#038387', '#107c10', '#498205', '#5c2e91', '#8764b8', '#881798', '#c30052', '#a4262c', '#ca5010', '#986f0b', '#7a7574', '#4c4a48', '#1f1f1f'];
const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif', '.avif'];

// ------------------------------------------------------------------ helpers
const thumbCache = new Map();
/** Downscaled (320×200, cover) copy of an image as a blob URL — 2560px wallpapers make heavy thumbnails. */
export function thumb(url, w = 320, h = 200) {
  if (!url || url.startsWith('data:')) return Promise.resolve(url);
  const key = `${url}|${w}`;
  if (!thumbCache.has(key)) {
    thumbCache.set(
      key,
      (async () => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.src = url;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const g = c.getContext('2d');
        const s = Math.max(w / img.naturalWidth, h / img.naturalHeight);
        g.drawImage(img, (w - img.naturalWidth * s) / 2, (h - img.naturalHeight * s) / 2, img.naturalWidth * s, img.naturalHeight * s);
        const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.86));
        return blob ? URL.createObjectURL(blob) : url;
      })().catch(() => url),
    );
  }
  return thumbCache.get(key);
}

export function solidWallpaper(color) {
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="10"><rect width="16" height="10" fill="${color}"/></svg>`)}`;
}
export function solidColorOf(value) {
  if (!String(value || '').startsWith('data:image/svg+xml')) return null;
  try {
    const m = /fill="(#[0-9a-fA-F]{6})"/.exec(decodeURIComponent(String(value).slice(String(value).indexOf(',') + 1)));
    return m ? m[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

function bgImage(el, url) {
  if (!url) return;
  if (url.startsWith('data:')) el.style.backgroundImage = `url("${url}")`;
  else thumb(url).then((u) => (el.style.backgroundImage = `url("${u}")`));
}

/** Mini desktop preview (wallpaper, a window with the accent color, taskbar) that follows the settings. */
function preview(pc, { start = false, big = false } = {}) {
  const { h, settings } = pc;
  const el = h('div', { class: 'st-preview', style: big ? { width: '360px' } : null, 'aria-hidden': 'true' }, h('div', { class: 'pv-win' }), start ? h('div', { class: 'pv-start' }) : null, h('div', { class: 'pv-taskbar' }, h('i'), h('i'), h('i'), h('i'), h('i')));
  const paint = () => {
    const all = settings.all();
    const mode = all.theme === 'dark' ? 'dark' : 'light';
    el.dataset.mode = mode;
    el.dataset.fit = all.wallpaperFit || 'fill';
    el.style.setProperty('--pv-accent', all.accent || ACCENTS[0]);
    el.style.backgroundImage = `url("${resolveWallpaper(all.wallpaper, mode)}")`;
  };
  paint();
  pc.onDispose(settings.on('*', paint));
  return el;
}

function themeTile(pc, th, { large = false } = {}) {
  const { h, settings, L } = pc;
  const el = h(
    'button',
    {
      class: 'st-theme',
      type: 'button',
      dataset: { mode: th.theme, theme: th.id },
      style: { '--th-accent': th.accent },
      'aria-label': L(th.name),
      'data-tip': large ? null : L(th.name),
      onclick: () => applyTheme(pc, th),
    },
    h('div', { class: 'th-win' }),
  );
  el.style.setProperty('--th-accent', th.accent);
  bgImage(el, resolveWallpaper(th.wallpaper, th.theme));
  const mark = () => {
    const all = settings.all();
    const on = all.wallpaper === th.wallpaper && (all.theme === 'dark' ? 'dark' : 'light') === th.theme && String(all.accent || '').toLowerCase() === th.accent;
    el.classList.toggle('selected', on);
    el.setAttribute('aria-pressed', String(on));
  };
  mark();
  pc.onDispose(settings.on('*', mark));
  return large ? h('div', { class: 'st-theme-cell' }, el, h('div', { class: 'st-theme-label' }, L(th.name))) : el;
}

// A theme preset changes the wallpaper, accent and mode at once: one atomic settings:setMany inside a single
// cross-fade of the whole screen (core/theme.js theme.transition), and Auto mode is turned off.
let applying = null;
async function applyTheme(pc, th) {
  const { settings, api } = pc;
  if (applying) await applying.catch(() => {});
  const patch = { wallpaper: th.wallpaper, accent: th.accent, theme: th.theme };
  if (settings.get('accentFromWallpaper')) patch.accentFromWallpaper = false;
  if (settings.get('autoTheme')?.enabled) patch['autoTheme.enabled'] = false;
  applying = coreTheme.transition(() => api.invoke('settings:setMany', patch));
  try {
    return await applying;
  } finally {
    applying = null;
  }
}

async function rememberCustom(pc, path) {
  const list = ((await pc.storage.get('recent-wallpapers', [])) || []).filter((p) => p !== path);
  list.unshift(path);
  await pc.storage.set('recent-wallpapers', list.slice(0, 5));
}

async function browseImage(pc, title) {
  const xdg = pc.shell.xdg || {};
  return pc.ui.filePicker({ mode: 'open', title, path: xdg.pictures, filters: [{ name: pc.t('pers.images'), ext: IMAGE_EXT }], parent: pc.win });
}

/** Grid of wallpapers (built-in + recent custom) bound to a settings key. */
async function wallGrid(pc, { key, includeSame = false }) {
  const { h, t, settings, icon, L } = pc;
  const grid = h('div', { class: 'st-wall-grid', role: 'listbox', 'aria-label': t('pers.choosePhoto') });
  const recents = ((await pc.storage.get('recent-wallpapers', [])) || []).filter((p) => typeof p === 'string');
  const exists = await Promise.all(recents.map((p) => pc.api.invoke('fs:exists', p).catch(() => false)));
  const items = [];
  if (includeSame) items.push({ value: null, label: t('pers.sameAsDesktop') });
  for (const w of wallpaperChoices()) items.push({ value: `builtin:${w.id}`, label: L(w.name) });
  recents.forEach((p, i) => exists[i] && items.push({ value: p, label: p.split('/').pop() }));
  const mode = () => (settings.get('theme') === 'dark' ? 'dark' : 'light');
  const tiles = items.map((it) => {
    const el = h('button', { class: 'st-wall', type: 'button', role: 'option', 'aria-label': it.label, 'data-tip': it.label, onclick: () => settings.set(key, it.value) });
    if (it.value === null) {
      el.classList.add('st-wall-same');
      el.append(h('span', { class: 'st-wall-same-label' }, icon('desktop', { size: 20 }), h('span', { class: 'caption' }, it.label)));
      bgImage(el, resolveWallpaper(settings.get('wallpaper'), mode()));
    } else bgImage(el, resolveWallpaper(it.value, mode()));
    return { el, it };
  });
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
  mark();
  pc.onDispose(settings.on(key, mark));
  pc.onDispose(
    settings.on('theme', () => {
      for (const { el, it } of tiles) bgImage(el, resolveWallpaper(it.value ?? settings.get('wallpaper'), mode()));
    }),
  );
  return grid;
}

// ------------------------------------------------------------------ Personalization home
const HOME_GROUPS = [
  ['pz.groupLook', ['themeDesigner', 'visualStyle', 'profiles', 'colors', 'appThemes']],
  ['pz.groupDesktop', ['background', 'wallpaperEffects', 'lockscreen', 'themes']],
  ['pz.groupTaskbar', ['taskbar', 'start', 'focus']],
  ['pz.groupPacks', ['cursors', 'iconPacks', 'soundPacks']],
  ['pz.groupInput', ['shortcuts', 'snapPresets']],
];
// On top: « Thème » (Halo, Prisme, Sobre) and « Personnaliser le thème » (personalization-finish.js), then every page.
async function personalization(pc) {
  const { h, t, kit, L } = pc;
  pc.ui.loadCss('app://shell/apps/settings/pages/personalization.css');
  return h(
    'div',
    { class: 'pz-home' },
    await finishSection(pc),
    customizeSection(pc),
    ...HOME_GROUPS.map(([title, ids]) => kit.group(t(title), ...ids.filter((id) => PAGES[id]).map((id) => kit.row({ icon: PAGES[id].icon, title: L(PAGES[id].title), desc: L(PAGES[id].desc), onClick: () => pc.go(id) })))),
  );
}

// ------------------------------------------------------------------ Background
async function background(pc) {
  const { h, t, kit, settings, ui, icon } = pc;
  const root = h('div');
  const pv = preview(pc, { big: true });
  const isSolid = () => !!solidColorOf(settings.get('wallpaper'));
  let kind = isSolid() ? 'solid' : 'picture';
  const body = h('div');

  async function paintBody() {
    ui.clear(body);
    if (kind === 'picture') {
      const grid = await wallGrid(pc, { key: 'wallpaper' });
      const fitOpts = ['fill', 'fit', 'stretch', 'center', 'tile'].map((v) => ({ value: v, label: t(`pers.fit_${v}`) }));
      body.append(
        kit.group(
          null,
          h('div', { class: 'st-expander open' }, kit.row({ icon: 'image_multiple', title: t('pers.recentImages'), className: 'st-exp-head' }), h('div', { class: 'st-exp-body' }, h('div', { style: { padding: '12px 16px 16px 56px' } }, grid))),
          kit.row({
            icon: 'folder_open',
            title: t('pers.choosePhoto'),
            control: kit.button(t('pers.browse'), async () => {
              const p = await browseImage(pc, t('pers.choosePhoto'));
              if (!p) return;
              await rememberCustom(pc, p);
              await settings.set('wallpaper', p);
              paintBody();
            }),
          }),
          kit.row({ icon: 'scale_fill', title: t('pers.fit'), section: 'fit', control: kit.combo({ options: fitOpts, value: settings.get('wallpaperFit') || 'fill', label: t('pers.fit'), onChange: (v) => settings.set('wallpaperFit', v) }) }),
        ),
      );
    } else {
      const cur = solidColorOf(settings.get('wallpaper'));
      const sw = h(
        'div',
        { class: 'st-solid-grid', role: 'listbox', 'aria-label': t('pers.backgroundColors') },
        SOLIDS.map((c) =>
          h('button', {
            class: ['st-swatch', c === cur && 'selected'],
            type: 'button',
            role: 'option',
            'aria-selected': String(c === cur),
            'aria-label': c,
            style: { '--sw': c },
            onclick: async () => {
              await settings.set('wallpaper', solidWallpaper(c));
              paintBody();
            },
          }),
        ),
      );
      for (const b of sw.children) b.style.setProperty('--sw', b.getAttribute('aria-label'));
      body.append(
        kit.group(
          null,
          h('div', { class: 'st-expander open' }, kit.row({ icon: 'color_background', title: t('pers.backgroundColors'), className: 'st-exp-head' }), h('div', { class: 'st-exp-body' }, h('div', { style: { padding: '12px 16px 16px 56px' } }, sw))),
          kit.row({
            icon: 'color',
            title: t('pers.customColor'),
            control: kit.button(t('pers.viewColors'), async () => {
              const c = await pickColor(pc, cur || '#0b5394');
              if (c) {
                await settings.set('wallpaper', solidWallpaper(c));
                paintBody();
              }
            }),
          }),
        ),
      );
    }
  }
  const kindCombo = kit.combo({
    options: [
      { value: 'picture', label: t('pers.picture') },
      { value: 'solid', label: t('pers.solid') },
    ],
    value: kind,
    label: t('pers.personalizeBg'),
    onChange: async (v) => {
      kind = v;
      if (v === 'solid' && !isSolid()) await settings.set('wallpaper', solidWallpaper(SOLIDS[0]));
      if (v === 'picture' && isSolid()) await settings.set('wallpaper', 'builtin:nocturne');
      paintBody();
    },
  });
  await paintBody();
  root.append(
    h('div', { class: 'st-pers-hero' }, pv),
    kit.group(null, kit.row({ icon: 'image', title: t('pers.personalizeBg'), desc: t('pers.personalizeBgDesc'), control: kindCombo })),
    body,
    kit.related([{ icon: 'color', title: pc.pageTitle('colors'), desc: L(pc, PAGES.colors.desc), onClick: () => pc.go('colors') }]),
  );
  return root;
}
const L = (pc, o) => pc.L(o);

async function pickColor(pc, initial) {
  const { h, t, ui } = pc;
  const input = h('input', { type: 'color', value: initial, class: 'st-color-input', style: { width: '100%', height: '120px', border: '0', padding: '0', background: 'transparent' } });
  const hex = h('input', { class: 'input', value: initial, maxLength: 7, 'aria-label': t('pers.hex'), style: { width: '120px' } });
  input.addEventListener('input', () => (hex.value = input.value));
  hex.addEventListener('input', () => /^#[0-9a-f]{6}$/i.test(hex.value) && (input.value = hex.value));
  const body = h('div', { class: 'col', style: { minWidth: '320px', gap: '12px' } }, input, h('label', { class: 'row' }, h('span', { class: 'text-2' }, t('pers.hex')), hex));
  const v = await ui.dialog({
    title: t('pers.pickColor'),
    body,
    parent: pc.win,
    buttons: [
      { label: t('common.done'), value: 'ok', primary: true },
      { label: t('common.cancel'), value: null },
    ],
  });
  return v === 'ok' && /^#[0-9a-f]{6}$/i.test(input.value) ? input.value.toLowerCase() : null;
}

// ------------------------------------------------------------------ Colors
async function colors(pc) {
  const { h, t, kit, settings, ui } = pc;
  pc.ui.loadCss('app://shell/apps/settings/pages/personalization.css');
  // Light / Dark / Auto (time of day) — shared with the Theme designer
  const { seg: mode, autoRow } = modeControl(pc);
  const { fromRow } = accentControls(pc);
  const { colorRow } = taskbarColorControls(pc);
  const amb = ambianceControl(pc);
  const modeNow = () => (settings.get('theme') === 'dark' ? 'dark' : 'light');

  // the four Selene accents, named (lunar silver, night blue, violet, amber), drawn as they look in this mode
  const swatches = h(
    'div',
    { class: 'st-swatches', role: 'listbox', 'aria-label': t('pers.accent') },
    ACCENT_PRESETS.map((a) => {
      const name = L(pc, a.name);
      return h('button', { class: 'st-swatch', type: 'button', role: 'option', 'aria-label': name, 'data-tip': name, dataset: { hex: a.hex, accent: a.id }, onclick: () => pickAccent(a.hex) });
    }),
  );
  const syncFocus = rovingFocus(swatches, '.st-swatch');
  // updated in place (rebuilding the buttons would drop the keyboard focus)
  const paintSw = () => {
    const cur = String(settings.get('accent') || ACCENTS[0]).toLowerCase();
    for (const b of swatches.children) {
      b.style.setProperty('--sw', accentPreset(b.dataset.hex)?.[modeNow()].accent || b.dataset.hex);
      const on = b.dataset.hex === cur;
      b.classList.toggle('selected', on);
      b.setAttribute('aria-selected', String(on));
    }
    syncFocus();
  };
  // choosing a colour by hand turns "accent from wallpaper" off
  async function pickAccent(c) {
    if (settings.get('accentFromWallpaper')) await settings.set('accentFromWallpaper', false);
    await settings.set('accent', c);
  }
  paintSw();
  pc.onDispose(settings.on('accent', paintSw));
  pc.onDispose(settings.on('theme', paintSw));
  return h(
    'div',
    null,
    h('div', { class: 'st-pers-hero' }, preview(pc, { start: true, big: true })),
    kit.group(
      null,
      kit.row({ icon: 'dark_theme', title: t('pers.mode'), desc: t('pers.modeDesc'), section: 'mode', control: mode }),
      autoRow,
      amb.row,
      kit.settingToggleRow({ icon: 'blur', title: t('pers.transparency'), desc: t('pers.transparencyDesc'), key: 'transparency', def: true, section: 'transparency' }),
      kit.expander({
        icon: 'color',
        title: t('pers.accent'),
        desc: t('pers.accentDesc'),
        section: 'accent',
        open: true,
        body: () =>
          h(
            'div',
            { class: 'st-sub-pad col', style: { gap: '12px' } },
            h('div', { class: 'body-strong' }, t('pers.accentColors')),
            swatches,
            h(
              'div',
              { class: 'row', style: { gap: '12px' } },
              h('span', null, t('pers.customColors')),
              kit.button(t('pers.viewColors'), async () => {
                const c = await pickColor(pc, settings.get('accent') || ACCENTS[0]);
                if (c) pickAccent(c);
              }),
            ),
          ),
      }),
      fromRow,
      colorRow,
    ),
    kit.related([
      { icon: 'window_brush', title: pc.pageTitle('themeDesigner'), desc: L(pc, PAGES.themeDesigner.desc), onClick: () => pc.go('themeDesigner') },
      { icon: 'window_apps', title: pc.pageTitle('appThemes'), desc: L(pc, PAGES.appThemes.desc), onClick: () => pc.go('appThemes') },
    ]),
  );
}

// ------------------------------------------------------------------ Themes
async function themes(pc) {
  const { h, t, kit, settings } = pc;
  const current = () => THEMES.find((th) => settings.get('wallpaper') === th.wallpaper && (settings.get('theme') === 'dark' ? 'dark' : 'light') === th.theme && String(settings.get('accent') || '').toLowerCase() === th.accent);
  const curName = h('span');
  const paintName = () => (curName.textContent = current() ? pc.L(current().name) : t('pers.customTheme'));
  paintName();
  pc.onDispose(settings.on('*', paintName));
  const sizeOpts = ['small', 'medium', 'large'].map((v) => ({ value: v, label: t(`pers.icons_${v}`) }));
  return h(
    'div',
    null,
    h('div', { class: 'st-pers-hero' }, preview(pc, { big: true }), h('div', { class: 'st-hero-text', style: { justifyContent: 'center' } }, h('div', { class: 'caption text-2' }, t('pers.currentTheme')), h('div', { class: 'st-hero-title' }, curName))),
    h('section', { class: 'st-group' }, h('h3', { class: 'st-group-title' }, t('pers.applyTheme')), h('div', { class: 'st-theme-grid large' }, THEMES.map((th) => themeTile(pc, th, { large: true })))),
    kit.group(
      t('pers.related'),
      kit.expander({
        icon: 'desktop',
        title: t('pers.desktopIcons'),
        desc: t('pers.desktopIconsDesc'),
        section: 'desktopIcons',
        open: pc.section === 'desktopIcons',
        body: () =>
          h(
            'div',
            null,
            kit.subRow({ title: t('pers.showDesktopIcons'), control: bindToggle(pc, 'desktopIcons', true, t('pers.showDesktopIcons')) }),
            kit.subRow({ title: t('pers.iconSize'), control: kit.combo({ options: sizeOpts, value: settings.get('desktopIconSize') || 'medium', label: t('pers.iconSize'), onChange: (v) => settings.set('desktopIconSize', v) }) }),
          ),
      }),
    ),
  );
}

function bindToggle(pc, key, def, label) {
  const v = pc.settings.get(key);
  const tg = pc.kit.toggle({ value: v == null ? def : v !== false, label, onChange: (x) => pc.settings.set(key, x) });
  pc.onDispose(pc.settings.on(key, (x) => tg.set(x == null ? def : x !== false)));
  return tg;
}

// ------------------------------------------------------------------ Lock screen
async function lockscreen(pc) {
  const { h, t, kit, settings, i18n } = pc;
  const lockPv = h('div', { class: 'st-preview st-lock-preview', style: { width: '360px' }, 'aria-hidden': 'true' }, h('div', { class: 'st-lock-time' }), h('div', { class: 'st-lock-date' }));
  const paintPv = () => {
    const mode = settings.get('theme') === 'dark' ? 'dark' : 'light';
    const lw = settings.get('lockWallpaper');
    lockPv.style.backgroundImage = `url("${resolveWallpaper(lw || settings.get('wallpaper'), mode)}")`;
    const now = new Date();
    lockPv.querySelector('.st-lock-time').textContent = i18n.formatTime(now, { hour: 'numeric', minute: '2-digit', hour12: settings.get('clock24h') == null ? undefined : !settings.get('clock24h') });
    lockPv.querySelector('.st-lock-date').textContent = i18n.formatDate(now, { weekday: 'long', month: 'long', day: 'numeric' });
  };
  paintPv();
  pc.onDispose(settings.on('*', paintPv));
  pc.every(15000, paintPv);
  const grid = await wallGrid(pc, { key: 'lockWallpaper', includeSame: true });
  const opts = [0, 1, 2, 3, 5, 10, 15, 30, 60].map((m) => ({ value: m, label: m === 0 ? t('power.never') : m >= 60 ? t('power.h', { count: m / 60 }) : t('power.m', { count: m }) }));
  return h(
    'div',
    null,
    h('div', { class: 'st-pers-hero' }, lockPv),
    kit.group(
      null,
      h('div', { class: 'st-expander open' }, kit.row({ icon: 'image', title: t('pers.lockPicture'), desc: t('pers.lockPictureDesc'), className: 'st-exp-head' }), h('div', { class: 'st-exp-body' }, h('div', { style: { padding: '12px 16px 16px 56px' } }, grid))),
      kit.row({
        icon: 'folder_open',
        title: t('pers.choosePhoto'),
        control: kit.button(t('pers.browse'), async () => {
          const p = await browseImage(pc, t('pers.lockPicture'));
          if (!p) return;
          await rememberCustom(pc, p);
          await settings.set('lockWallpaper', p);
          pc.refresh();
        }),
      }),
      kit.row({ icon: 'timer', title: t('power.lockAfter'), desc: t('power.lockAfterDesc'), control: kit.combo({ options: opts, value: Number(settings.get('lockTimeout')) || 0, label: t('power.lockAfter'), onChange: (v) => settings.set('lockTimeout', Number(v)) }) }),
    ),
  );
}

export default { personalization, background, colors, themes, lockscreen };
