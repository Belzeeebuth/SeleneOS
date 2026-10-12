// Settings > Personnalisation, top of the page: « Thème » (the three finishes Halo, Prisme, Sobre, as large cards with
// a preview picture) and « Personnaliser le thème » right under it (style, ambiance, accent, wallpaper, window
// transparency, blur, tint from the wallpaper, icon set). docs/PERSONALIZATION.md §1.1 and §6.
//
// Choosing a card only writes settings.finish: core/theme.js and core/finishes.js apply the theme's defaults (accent,
// wallpaper, icon pack). The other controls reuse the builders of personalization-designer.js and the existing keys.
import { STYLES, chooseStyle, resolveWallpaper, theme as coreTheme } from '../../../core/theme.js';
import { ICON_PACKS } from '../../../core/packs.js';
import { FINISHES, DEFAULT_FINISH, finishOf as finishIdOf } from '../../../core/finishes.js';
import { ctl, bindToggle, rovingFocus, accentControls, ambianceControl, transparencyControls } from './personalization-designer.js';

/** { list: FINISHES, def: DEFAULT_FINISH } of core/finishes.js. */
export function loadFinishes() {
  return Promise.resolve({ list: FINISHES, def: DEFAULT_FINISH });
}

const S = {
  theme: { en: 'Theme', fr: 'Thème' },
  themeIntro: { en: 'A theme sets the material of windows and panels, the app icons and the wallpapers. You can adjust each part below.', fr: 'Un thème définit la matière des fenêtres et des panneaux, les icônes des applications et les fonds d’écran. Vous pouvez en ajuster chaque partie ci-dessous.' },
  current: { en: 'Current theme', fr: 'Thème actuel' },
  customize: { en: 'Customize the theme', fr: 'Personnaliser le thème' },
  style: { en: 'Style', fr: 'Style' },
  styleDesc: { en: 'The shape of the bar, the windows and the panels.', fr: 'La forme de la barre, des fenêtres et des panneaux.' },
  accent: { en: 'Accent colour', fr: 'Couleur d’accent' },
  accentDesc: { en: 'Selection, focus, the active app and buttons.', fr: 'Sélection, focus, application active et boutons.' },
  wallpaper: { en: 'Wallpaper', fr: 'Fond d’écran' },
  wallpaperDesc: { en: 'Each theme brings its own; you can choose another picture.', fr: 'Chaque thème a le sien ; vous pouvez choisir une autre image.' },
  change: { en: 'Change', fr: 'Changer' },
  tint: { en: 'Tint windows with the wallpaper', fr: 'Teinter les fenêtres selon le fond d’écran' },
  tintDesc: { en: 'Windows, the bar and panels take on the colours of the wallpaper.', fr: 'Les fenêtres, la barre et les panneaux prennent les couleurs du fond d’écran.' },
  tintOff: { en: 'Not available with the Plain theme, while transparency is off or with high contrast.', fr: 'Indisponible avec le thème Sobre, quand la transparence est désactivée ou avec le contraste élevé.' },
  icons: { en: 'Icon set', fr: 'Jeu d’icônes' },
  iconsDesc: { en: 'App icons in the bar, the Launcher and on the desktop.', fr: 'Icônes des applications dans la barre, le Lanceur et sur le bureau.' },
  auto: { en: 'Automatic (follows the theme)', fr: 'Automatique (suit le thème)' },
  morePacks: { en: 'More icon packs', fr: 'Autres jeux d’icônes' },
};
// the icon packs of the two new themes, named here until core/packs.js lists them (icon track)
const PACK_NAMES = { halo: { en: 'Halo', fr: 'Halo' }, prisme: { en: 'Prisme', fr: 'Prisme' } };
const PACK_ORDER = ['halo', 'prisme', 'selene'];

const finishOf = (pc, def) => pc.settings.get('finish') || def;

// ------------------------------------------------------------------ « Thème »: the three cards
export async function finishSection(pc) {
  const { h, settings, icon, L } = pc;
  const { list, def } = await loadFinishes();
  const grid = h('div', { class: 'pz-finish-grid', role: 'radiogroup', 'aria-label': L(S.theme) });
  const cards = list.map((f) =>
    h(
      'button',
      { type: 'button', class: 'pz-finish-card', role: 'radio', dataset: { finish: f.id }, 'aria-label': `${L(f.name)}. ${L(f.desc)}`, onclick: () => finishOf(pc, def) !== f.id && settings.set('finish', f.id) },
      h('span', { class: 'pz-finish-pv' }, h('img', { src: f.preview, alt: '', loading: 'lazy', decoding: 'async', draggable: false })),
      h(
        'span',
        { class: 'pz-finish-meta' },
        h('span', { class: 'pz-finish-name' }, L(f.name), h('span', { class: 'pz-finish-check', 'aria-hidden': 'true' }, icon('checkmark', { size: 12 }))),
        h('span', { class: 'pz-finish-desc caption text-2' }, L(f.desc)),
      ),
    ),
  );
  grid.append(...cards);
  let syncFocus = null;
  const mark = () => {
    const cur = finishOf(pc, def);
    for (const c of cards) {
      const on = c.dataset.finish === cur;
      c.classList.toggle('selected', on);
      c.setAttribute('aria-checked', String(on));
    }
    syncFocus?.();
  };
  syncFocus = rovingFocus(grid, '.pz-finish-card');
  mark();
  pc.onDispose(settings.on('finish', mark));
  return h('section', { class: 'pz-finish', dataset: { section: 'finish' } }, h('h2', { class: 'pz-finish-title' }, L(S.theme)), h('p', { class: 'pz-intro text-2' }, L(S.themeIntro)), grid);
}

// ------------------------------------------------------------------ « Personnaliser le thème »
function styleChoice(pc) {
  const { h, settings, L } = pc;
  const group = h('div', { class: 'pz-seg pz-style-seg', role: 'radiogroup', 'aria-label': L(S.style) });
  const btns = STYLES.map((st) =>
    h('button', { type: 'button', class: 'pz-seg-btn', role: 'radio', dataset: { styleId: st.id }, onclick: () => settings.get('style') !== st.id && chooseStyle(st.id).catch(pc.toastError) }, L(st.name)),
  );
  group.append(...btns);
  let syncFocus = null;
  const mark = () => {
    const cur = STYLES.some((s) => s.id === settings.get('style')) ? settings.get('style') : STYLES[0].id;
    for (const b of btns) {
      const on = b.dataset.styleId === cur;
      b.classList.toggle('selected', on);
      b.setAttribute('aria-checked', String(on));
    }
    syncFocus?.();
  };
  syncFocus = rovingFocus(group, '.pz-seg-btn');
  mark();
  pc.onDispose(settings.on('style', mark));
  return ctl(pc, { icon: 'style_guide', title: L(S.style), desc: L(S.styleDesc), control: group, stacked: true, section: 'style' });
}

function wallpaperRow(pc) {
  const { h, settings, kit, L } = pc;
  const thumb = h('span', { class: 'pz-wall-thumb' });
  const paint = () => (thumb.style.backgroundImage = `url("${coreTheme.wallpaperUrl || resolveWallpaper(settings.get('wallpaper'), settings.get('theme') === 'dark' ? 'dark' : 'light')}")`);
  paint();
  pc.onDispose(coreTheme.on('wallpaper', paint));
  pc.onDispose(settings.on('wallpaper', () => setTimeout(paint, 30)));
  return ctl(pc, { icon: 'image', title: L(S.wallpaper), desc: L(S.wallpaperDesc), control: h('div', { class: 'pz-inline' }, thumb, kit.button(L(S.change), () => pc.go('background'), { className: 'pz-wall-change' })), section: 'wallpaper' });
}

function tintRow(pc) {
  const { h, settings, L } = pc;
  const tg = bindToggle(pc, 'tintFromWallpaper', true, L(S.tint));
  const note = h('div', { class: 'pz-note caption', hidden: true });
  const row = ctl(pc, { icon: 'image_sparkle', title: L(S.tint), desc: L(S.tintDesc), control: tg, section: 'tintFromWallpaper', note });
  row.dataset.key = 'tintFromWallpaper';
  // nothing to tint when every surface is opaque (Sobre, transparency off, High contrast: core/theme.js glassOf)
  const paint = () => {
    const off = finishIdOf(settings.get('finish')) === 'sobre' || settings.get('transparency') === false || settings.get('style') === 'contrast';
    row.classList.toggle('pz-overridden', off);
    for (const i of tg.querySelectorAll('input, button')) i.disabled = off;
    note.hidden = !off;
    note.textContent = off ? L(S.tintOff) : '';
  };
  paint();
  pc.onDispose(settings.on('transparency', paint));
  pc.onDispose(settings.on('style', paint));
  pc.onDispose(settings.on('finish', paint));
  return row;
}

function iconPackRow(pc) {
  const { h, settings, kit, L } = pc;
  const known = new Map(ICON_PACKS.map((p) => [p.id, p.name]));
  // Halo, Prisme and Selene first (the packs of the three themes, core/packs.js ICON_PACKS), then the other packs
  const ids = [...PACK_ORDER, ...ICON_PACKS.map((p) => p.id).filter((id) => !PACK_ORDER.includes(id))];
  const options = [{ value: 'auto', label: L(S.auto) }, ...ids.map((id) => ({ value: id, label: L(known.get(id) || PACK_NAMES[id]) || id }))];
  const value = () => {
    const v = settings.get('iconPack') || 'auto';
    return v === 'fluent' ? 'selene' : v;
  };
  const combo = kit.combo({ label: L(S.icons), value: value(), options, width: 260, onChange: (v) => settings.set('iconPack', v) });
  combo.dataset.key = 'iconPack';
  pc.onDispose(settings.on('iconPack', () => combo.setValue(value())));
  return ctl(pc, { icon: 'icons', title: L(S.icons), desc: L(S.iconsDesc), control: h('div', { class: 'pz-inline pz-wrap' }, combo, h('button', { type: 'button', class: 'btn subtle pz-more-packs', onclick: () => pc.go('iconPacks') }, L(S.morePacks))), section: 'iconPack' });
}

export function customizeSection(pc) {
  const { h, L } = pc;
  const accent = accentControls(pc, { compact: true });
  const tr = transparencyControls(pc);
  return h(
    'section',
    { class: 'pz-finish-custom', dataset: { section: 'customizeTheme' } },
    h('h3', { class: 'st-group-title' }, L(S.customize)),
    h(
      'div',
      { class: 'pz-card' },
      styleChoice(pc),
      ambianceControl(pc).row,
      ctl(pc, { icon: 'color', title: L(S.accent), desc: L(S.accentDesc), control: accent.body, stacked: true, section: 'accent' }),
      wallpaperRow(pc),
      tr.levelRow,
      tr.blurRow,
      tintRow(pc),
      iconPackRow(pc),
    ),
  );
}
