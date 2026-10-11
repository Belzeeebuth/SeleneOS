// Cursor packs and icon packs (docs/PERSONALIZATION.md §11). Applied live, saved by profiles.
//
//   import { packs, CURSOR_PACKS, ICON_PACKS } from './packs.js';
//   packs.init()                       boot: applies settings.cursorPack + settings.iconPack and follows changes
//   packs.cursorPreview(packId, shape) -> data: URL of one cursor of a pack (Settings previews)
//   packs.appIcon(packId, appId)       -> URL of an app icon in a pack (Settings previews; mark such <img> with
//                                         data-icon-fixed so switching packs does not swap them)
//
// Cursors: every plain cursor keyword of the shell and app style sheets (`cursor: pointer`, `ns-resize`…) is rewritten
// once to `var(--cur-pointer, pointer)`; a pack only sets those variables on <html> (PNG cursors drawn on a canvas),
// so the system pack ("default") is simply "no variables". The root gets the pack's arrow, editable fields its
// I-beam. Cursors inside web pages (browser tabs) stay the page's own.
// Icons: registry.iconUrl() asks packs for the icon of the current pack (an SVG built from the app's Fluent glyph);
// images already on screen are swapped in place (taskbar, Start, windows, desktop…). "fluent" = the apps' own icons.
// File-type icons follow too: <html data-icon-pack> (shell-personalize.css tints them per pack).
import { settings } from './settings.js';
import { registry } from './registry.js';
import { iconSvg } from './icons.js';
import { wm } from './wm.js';

// ------------------------------------------------------------------ cursors
export const CURSOR_PACKS = [
  { id: 'default', name: { en: 'System', fr: 'Système' } },
  { id: 'classic', name: { en: 'Aurora light', fr: 'Aurora clair' }, fill: '#ffffff', stroke: '#000000', size: 24 },
  { id: 'midnight', name: { en: 'Midnight', fr: 'Minuit' }, fill: '#161616', stroke: '#ffffff', size: 24 },
  { id: 'accent', name: { en: 'Accent color', fr: 'Couleur d’accentuation' }, fill: 'accent', stroke: '#ffffff', size: 24 },
  { id: 'large', name: { en: 'Large', fr: 'Grand' }, fill: '#ffffff', stroke: '#000000', size: 40 },
  { id: 'highvis', name: { en: 'High visibility', fr: 'Haute visibilité' }, fill: '#ffeb00', stroke: '#000000', size: 32 },
  { id: 'retro', name: { en: 'Retro pixel', fr: 'Pixel rétro' }, fill: '#ffffff', stroke: '#000000', size: 32, pixel: true },
];
// Shapes on a 32 × 32 grid: [path, hotspot x, hotspot y, rotation°]
const P_ARROW = 'M5 2.5V25l5.6-5.2 3.6 8.4 3.6-1.5-3.5-8.3h7.6z';
const P_HAND =
  'M11.5 2.6c1.2 0 2.1.9 2.1 2.1v8.1l.9-.1c1 0 1.8.6 2.1 1.5.4-.3.9-.5 1.5-.5 1 0 1.8.7 2 1.6.4-.3.9-.4 1.4-.4 1.2 0 2.1.9 2.1 2.1v5.6c0 3.8-3.1 6.9-6.9 6.9h-2.3c-2.1 0-4-1-5.3-2.6l-4.4-5.9c-.7-.9-.5-2.2.4-2.9.9-.7 2.2-.5 2.9.4l1.4 1.8V4.7c0-1.2 1-2.1 2.1-2.1z';
const P_FIST =
  'M9.4 12.6c0-1.1.9-2 2-2s2 .9 2 2v-.9c0-1.1.9-2 2-2s2 .9 2 2v.5c0-1.1.9-2 2-2s2 .9 2 2v.9c0-1.1.9-2 2-2s2 .9 2 2v6.3c0 4-3.2 7.2-7.2 7.2h-2.9c-2.4 0-4.6-1.3-5.8-3.4l-2.6-4.6c-.5-1 0-2.2 1-2.6.9-.4 1.9 0 2.3.8l1.2 1.9z';
const P_BEAM = 'M10 4h4l2 1.6L18 4h4v2.6h-3.7v18.8H22V28h-4l-2-1.6L14 28h-4v-2.6h3.7V6.6H10z';
const P_DOUBLE = 'M2.5 16l6.5-6.5v4.3h14V9.5l6.5 6.5-6.5 6.5v-4.3H9v4.3z';
const P_SPLIT = 'M1.5 16l5.5-5.5v3.7h6V6h2v20h-2v-8.2H7v3.7zM30.5 16l-5.5 5.5v-3.7h-6V26h-2V6h2v8.2h6v-3.7z';
const P_MOVE = 'M16 1.5l5.5 5.5h-3.8v7.3H25v-3.8l5.5 5.5-5.5 5.5v-3.8h-7.3V25h3.8L16 30.5 10.5 25h3.8v-7.3H7v3.8L1.5 16 7 10.5v3.8h7.3V7h-3.8z';
const P_CROSS = 'M14.8 3h2.4v10.6h-2.4zM14.8 18.4h2.4V29h-2.4zM3 14.8h10.6v2.4H3zM18.4 14.8H29v2.4H18.4z';
const P_NO = 'M16 3.5A12.5 12.5 0 1 0 16 28.5 12.5 12.5 0 1 0 16 3.5zm0 3.6c1.9 0 3.6.6 5 1.6L8.7 21A8.9 8.9 0 0 1 16 7.1zm7.3 3.9a8.9 8.9 0 0 1-12.3 12.3z';
const P_RING = 'M16 3.5A12.5 12.5 0 1 0 16 28.5 12.5 12.5 0 1 0 16 3.5zm0 3.6a8.9 8.9 0 1 1 0 17.8 8.9 8.9 0 0 1 0-17.8z';
const SHAPES = {
  arrow: [[P_ARROW], 5, 2.5],
  hand: [[P_HAND], 11.5, 3],
  fist: [[P_FIST], 16, 12],
  text: [[P_BEAM], 16, 16],
  ew: [[P_DOUBLE], 16, 16, 0],
  ns: [[P_DOUBLE], 16, 16, 90],
  nwse: [[P_DOUBLE], 16, 16, 45],
  nesw: [[P_DOUBLE], 16, 16, -45],
  col: [[P_SPLIT], 16, 16, 0],
  row: [[P_SPLIT], 16, 16, 90],
  move: [[P_MOVE], 16, 16],
  cross: [[P_CROSS], 16, 16],
  no: [[P_NO], 16, 16],
  wait: [[P_RING], 16, 16],
  progress: [[P_ARROW], 5, 2.5],
  help: [[P_ARROW], 5, 2.5],
};
// CSS keyword -> shape
const KEYWORDS = {
  default: 'arrow', pointer: 'hand', text: 'text', 'vertical-text': 'text', move: 'move', 'all-scroll': 'move', grab: 'hand', grabbing: 'fist',
  crosshair: 'cross', cell: 'cross', 'not-allowed': 'no', 'no-drop': 'no', wait: 'wait', progress: 'progress', help: 'help',
  'ew-resize': 'ew', 'e-resize': 'ew', 'w-resize': 'ew', 'ns-resize': 'ns', 'n-resize': 'ns', 's-resize': 'ns',
  'nwse-resize': 'nwse', 'nw-resize': 'nwse', 'se-resize': 'nwse', 'nesw-resize': 'nesw', 'ne-resize': 'nesw', 'sw-resize': 'nesw',
  'col-resize': 'col', 'row-resize': 'row',
};
export const CURSOR_KEYWORDS = Object.keys(KEYWORDS);

const accentHex = () => {
  const a = String(settings.get('accent') || '#0078d4');
  return /^#[0-9a-f]{6}$/i.test(a) ? a : '#0078d4';
};
const cursorCache = new Map();
/** PNG data URL of one cursor shape in a pack: { url, x, y, size } */
function drawCursor(pack, shape) {
  const fill = pack.fill === 'accent' ? accentHex() : pack.fill;
  const key = `${pack.id}|${shape}|${fill}`;
  if (cursorCache.has(key)) return cursorCache.get(key);
  const [paths, hx, hy, rot = 0] = SHAPES[shape] || SHAPES.arrow;
  const size = pack.size || 24;
  // retro: drawn on a 16 px grid, then scaled up without smoothing (crisp pixels)
  const res = pack.pixel ? 16 : size;
  const c = document.createElement('canvas');
  c.width = c.height = res;
  const g = c.getContext('2d');
  const k = res / 32;
  g.save();
  g.scale(k, k);
  if (rot) {
    g.translate(16, 16);
    g.rotate((rot * Math.PI) / 180);
    g.translate(-16, -16);
  }
  g.lineJoin = 'round';
  g.lineWidth = pack.pixel ? 2.6 : Math.max(1.6, 1.5 / k);
  for (const d of paths) {
    const p = new Path2D(d);
    g.fillStyle = fill;
    g.strokeStyle = pack.stroke;
    g.stroke(p);
    g.fill(p, 'evenodd');
  }
  g.restore();
  // badges: busy ring (wait / progress) and "?" (help)
  if (shape === 'wait' || shape === 'progress') {
    const cx = shape === 'wait' ? res / 2 : res * 0.72;
    const cy = shape === 'wait' ? res / 2 : res * 0.72;
    const r = shape === 'wait' ? res * 0.3 : res * 0.17;
    g.lineWidth = Math.max(2, res * 0.09);
    g.strokeStyle = pack.stroke;
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.stroke();
    g.lineWidth = Math.max(1.4, res * 0.06);
    g.strokeStyle = pack.fill === 'accent' || pack.id === 'midnight' ? '#ffffff' : accentHex();
    g.beginPath();
    g.arc(cx, cy, r, -Math.PI / 2, Math.PI * 0.6);
    g.stroke();
  } else if (shape === 'help') {
    g.font = `bold ${Math.round(res * 0.42)}px sans-serif`;
    g.lineWidth = Math.max(2, res * 0.08);
    g.strokeStyle = pack.stroke;
    g.fillStyle = fill;
    g.strokeText('?', res * 0.62, res * 0.92);
    g.fillText('?', res * 0.62, res * 0.92);
  }
  let out = c;
  if (pack.pixel) {
    out = document.createElement('canvas');
    out.width = out.height = size;
    const o = out.getContext('2d');
    o.imageSmoothingEnabled = false;
    o.drawImage(c, 0, 0, size, size);
  }
  const s = size / 32;
  const val = { url: out.toDataURL('image/png'), x: Math.round(hx * s), y: Math.round(hy * s), size };
  cursorCache.set(key, val);
  return val;
}

const CURSOR_VARS_ID = 'aurora-cursor-vars';
const rewritten = new WeakSet();
const KW = new RegExp(`^(${CURSOR_KEYWORDS.join('|')})$`);
function rewriteRules(rules) {
  for (const rule of rules) {
    if (rule.style) {
      const v = rule.style.getPropertyValue('cursor').trim();
      if (KW.test(v)) {
        try {
          rule.style.setProperty('cursor', `var(--cur-${v}, ${v})`, rule.style.getPropertyPriority('cursor'));
        } catch {}
      }
    }
    if (rule.cssRules) rewriteRules(rule.cssRules);
  }
}
function rewriteSheet(sheet) {
  if (!sheet || rewritten.has(sheet)) return;
  const href = sheet.href || '';
  if (href && !href.startsWith('app://shell/')) return;
  try {
    rewriteRules(sheet.cssRules);
    rewritten.add(sheet);
  } catch {}
}
let watching = false;
function rewriteAll() {
  for (const s of document.styleSheets) rewriteSheet(s);
  if (watching) return;
  watching = true;
  // style sheets loaded later (apps, features)
  new MutationObserver((recs) => {
    if (!cursorPackId() || cursorPackId() === 'default') return;
    for (const r of recs) {
      for (const n of r.addedNodes) {
        if (n.tagName === 'LINK') {
          if (n.sheet) rewriteSheet(n.sheet);
          else n.addEventListener('load', () => rewriteSheet(n.sheet), { once: true });
        } else if (n.tagName === 'STYLE' && n.id !== CURSOR_VARS_ID) setTimeout(() => rewriteSheet(n.sheet), 0);
      }
    }
  }).observe(document.head, { childList: true });
}
const cursorPackId = () => {
  const id = settings.get('cursorPack');
  return CURSOR_PACKS.some((p) => p.id === id) ? id : 'default';
};
function applyCursors() {
  const pack = CURSOR_PACKS.find((p) => p.id === cursorPackId());
  let el = document.getElementById(CURSOR_VARS_ID);
  document.documentElement.dataset.cursorPack = pack.id;
  if (pack.id === 'default') {
    el?.remove();
    return;
  }
  rewriteAll();
  if (!el) {
    el = document.createElement('style');
    el.id = CURSOR_VARS_ID;
    document.head.appendChild(el);
  }
  const decl = [];
  for (const kw of CURSOR_KEYWORDS) {
    const c = drawCursor(pack, KEYWORDS[kw]);
    decl.push(`--cur-${kw}: url("${c.url}") ${c.x} ${c.y}, ${kw};`);
  }
  const arrow = drawCursor(pack, 'arrow');
  const beam = drawCursor(pack, 'text');
  const hand = drawCursor(pack, 'hand');
  el.textContent = `:root { ${decl.join(' ')} }
:root, :root body { cursor: url("${arrow.url}") ${arrow.x} ${arrow.y}, default; }
:root :is(input:not([type=button], [type=checkbox], [type=radio], [type=range], [type=color], [type=submit], [type=reset], [type=file], [type=image]), textarea, [contenteditable=""], [contenteditable="true"]) { cursor: url("${beam.url}") ${beam.x} ${beam.y}, text; }
:root a[href] { cursor: url("${hand.url}") ${hand.x} ${hand.y}, pointer; }`;
}

// ------------------------------------------------------------------ icon packs
export const ICON_PACKS = [
  { id: 'fluent', name: { en: 'Fluent (app icons)', fr: 'Fluent (icônes des applications)' } },
  { id: 'tiles', name: { en: 'Aurora tiles', fr: 'Tuiles Aurora' } },
  { id: 'accent', name: { en: 'Accent tiles', fr: 'Tuiles d’accentuation' } },
  { id: 'graphite', name: { en: 'Graphite', fr: 'Graphite' } },
  { id: 'outline', name: { en: 'Outline', fr: 'Contour' } },
];
// The Fluent glyph that stands for each app (unknown apps: their first letter).
const GLYPHS = {
  browser: 'globe', files: 'folder', mail: 'mail', notepad: 'notepad', terminal: 'window_console', settings: 'settings', calculator: 'calculator',
  paint: 'paint_brush', media: 'play_circle', snipping: 'cut', taskmgr: 'data_histogram', minesweeper: 'flag', solitaire: 'playing_cards',
  snake: 'games', game2048: 'grid', chess: 'chess', installer: 'arrow_download', photos: 'image', pdf: 'document_pdf', archive: 'folder_zip',
  notes: 'note', calendar: 'calendar_ltr', clock: 'clock', todo: 'task_list_ltr', winver: 'info',
};
const TILE_COLORS = {
  browser: '#0f6cbd', files: '#c08a00', mail: '#0a5aa8', notepad: '#3a6ea5', terminal: '#2b2b2b', settings: '#5c6670', calculator: '#4d5a66',
  paint: '#c43e8b', media: '#d1452f', snipping: '#b83c6b', taskmgr: '#2f7d4f', minesweeper: '#8a5a2b', solitaire: '#1f7a46', snake: '#3e8f2f',
  game2048: '#c67a12', chess: '#5b4636', installer: '#0063b1', photos: '#1f7ab8', pdf: '#c4262e', archive: '#9a6b12', notes: '#c19c00',
  calendar: '#0f6cbd', clock: '#3b5bdb', todo: '#2564cf', winver: '#5c6670',
};
const PALETTE = ['#0f6cbd', '#8764b8', '#c43e1c', '#038387', '#498205', '#ca5010', '#5c2e91', '#b146c2', '#2d7d9a', '#986f0b'];
const hashColor = (id) => PALETTE[[...String(id)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % PALETTE.length];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function glyphInner(appId, filled) {
  const name = GLYPHS[appId];
  if (!name) return null;
  const svg = iconSvg(name, { filled });
  const m = /viewBox="0 0 (\d+) (\d+)"[^>]*>([\s\S]*)<\/svg>$/.exec(svg);
  return m ? { vb: Number(m[1]) || 20, inner: m[3] } : null;
}
const iconCache = new Map();
/** URL of an app icon in a pack, or null for the app's own icon ("fluent"). */
function packIcon(packId, appId) {
  if (!packId || packId === 'fluent' || !ICON_PACKS.some((p) => p.id === packId)) return null;
  const m = registry.get(appId);
  if (!m) return null;
  const accent = accentHex();
  const key = `${packId}|${appId}|${packId === 'accent' ? accent : ''}`;
  if (iconCache.has(key)) return iconCache.get(key);
  const outline = packId === 'outline';
  const g = glyphInner(appId, !outline);
  const bg = packId === 'tiles' ? TILE_COLORS[appId] || hashColor(appId) : packId === 'accent' ? accent : packId === 'graphite' ? '#4a5260' : null;
  const fg = outline ? TILE_COLORS[appId] || hashColor(appId) : '#ffffff';
  const letter = esc((registry.name(appId) || appId).trim().charAt(0).toUpperCase() || '?');
  const glyph = g
    ? `<g transform="translate(8 8) scale(${32 / g.vb})" fill="${fg}">${g.inner}</g>`
    : `<text x="24" y="32" text-anchor="middle" font-family="Inter, sans-serif" font-size="22" font-weight="600" fill="${fg}">${letter}</text>`;
  const tile = bg
    ? `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".18"/><stop offset="1" stop-color="#000" stop-opacity=".12"/></linearGradient></defs><rect x="2" y="2" width="44" height="44" rx="11" fill="${bg}"/><rect x="2" y="2" width="44" height="44" rx="11" fill="url(#g)"/>`
    : `<rect x="3" y="3" width="42" height="42" rx="11" fill="#ffffff" fill-opacity=".92" stroke="${fg}" stroke-opacity=".55" stroke-width="2"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">${tile}${glyph}</svg>`;
  const url = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  iconCache.set(key, url);
  return url;
}
const iconPackId = () => {
  const id = settings.get('iconPack');
  return ICON_PACKS.some((p) => p.id === id) ? id : 'fluent';
};

// The URL each app's icon had in the pack shown on screen, to swap the images in place.
let shownUrls = new Map(); // url -> appId
function rememberUrls() {
  shownUrls = new Map();
  for (const m of registry.list({ includeHidden: true })) shownUrls.set(registry.iconUrl(m.id), m.id);
}
function swapIcons() {
  const before = shownUrls;
  rememberUrls();
  // img[data-icon-fixed]: a picture of one given pack (Settings previews) — never swapped
  for (const img of document.querySelectorAll('img[src]:not([data-icon-fixed])')) {
    const id = before.get(img.getAttribute('src'));
    if (id) img.setAttribute('src', registry.iconUrl(id));
  }
  for (const w of wm.list?.() || []) {
    const id = before.get(w.iconUrl);
    if (id && typeof w.setIcon === 'function') w.setIcon(registry.iconUrl(id));
  }
}
function applyIcons() {
  document.documentElement.dataset.iconPack = iconPackId();
  swapIcons();
}

// ------------------------------------------------------------------ init
let inited = false;
export const packs = {
  init() {
    if (inited) return;
    inited = true;
    registry.iconResolver = (appId) => packIcon(iconPackId(), appId);
    applyCursors();
    applyIcons();
    settings.on('cursorPack', applyCursors);
    settings.on('iconPack', applyIcons);
    settings.on('accent', () => {
      if (cursorPackId() === 'accent') applyCursors();
      if (iconPackId() === 'accent') applyIcons();
    });
  },
  /** Re-scan the icons on screen (e.g. after the app list was reloaded). */
  refreshIcons: applyIcons,
  cursorPreview(packId, shape = 'arrow') {
    const pack = CURSOR_PACKS.find((p) => p.id === packId);
    return pack && pack.id !== 'default' ? drawCursor(pack, shape).url : null;
  },
  appIcon(packId, appId) {
    return packIcon(packId, appId) || (registry.get(appId)?.icon ? `app://shell/apps/${appId}/${registry.get(appId).icon}` : 'app://shell/assets/app-default.svg');
  },
  get cursorPack() {
    return cursorPackId();
  },
  get iconPack() {
    return iconPackId();
  },
};
