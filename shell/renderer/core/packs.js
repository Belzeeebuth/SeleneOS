// Cursor packs and icon packs (docs/PERSONALIZATION.md §11). Applied live, saved by profiles.
//
//   import { packs, CURSOR_PACKS, ICON_PACKS } from './packs.js';
//   packs.init()                       boot: applies settings.cursorPack / cursorSize / iconPack and follows changes
//                                      (also starts the system-sound hooks of core/sounds.js)
//   packs.cursorPreview(packId, shape, size?) -> data: URL of one cursor of a pack (Settings previews)
//   packs.cursorInfo(packId, shape)    -> { url, x, y, size } (hot spot in image pixels)
//   packs.appIcon(packId, appId)       -> URL of an app icon in a pack (Settings previews; mark such <img> with
//                                         data-icon-fixed so switching packs does not swap them)
//   packs.specialIcon(packId, 'thispc' | 'trash') -> URL of a shell special icon in a pack
//
// Cursors: every plain cursor keyword of the shell and app style sheets (`cursor: pointer`, `ns-resize`…) is rewritten
// once to `var(--cur-pointer, pointer)`; a pack only sets those variables on <html> (PNG cursors drawn on a canvas),
// so the system pack ("default") at 100 % is simply "no variables". Inline cursors set from JS (el.style.cursor =
// 'grabbing') are mapped to the same variables. The root gets the pack's arrow, editable fields its I-beam. Cursors
// inside web pages (browser tabs) stay the page's own. settings.cursorSize (100–300 %) scales every pack; the system
// pack cannot be scaled, so above 100 % it is drawn as "Aurora light".
// Icons: registry.iconUrl() asks packs for the icon of the current pack (an SVG or PNG built from the app's Fluent
// glyph); images already on screen are swapped in place (taskbar, Start, windows, desktop…), and a style sheet maps
// the apps' own icon files and the This PC / Recycle Bin pictures to the pack (`img[src=…] { content: url(…) }`),
// so pictures an app or File Explorer draws from those files follow too. "fluent" = the apps' own icons.
// File-type icons follow too: <html data-icon-pack> (shell-personalize.css tints them per pack).
import { settings } from './settings.js';
import { registry } from './registry.js';
import { iconSvg } from './icons.js';
import { wm } from './wm.js';
import { sounds } from './sounds.js';

// ------------------------------------------------------------------ cursors
export const CURSOR_PACKS = [
  { id: 'default', name: { en: 'System', fr: 'Système' } },
  { id: 'classic', name: { en: 'Aurora light', fr: 'Aurora clair' }, fill: '#ffffff', stroke: '#000000', size: 24 },
  { id: 'midnight', name: { en: 'Aurora dark', fr: 'Aurora sombre' }, fill: '#161616', stroke: '#ffffff', size: 24 },
  { id: 'accent', name: { en: 'Accent color', fr: 'Couleur d’accentuation' }, fill: 'accent', stroke: '#ffffff', size: 24 },
  { id: 'large', name: { en: 'Large', fr: 'Grand' }, fill: '#ffffff', stroke: '#000000', size: 40 },
  { id: 'highvis', name: { en: 'High visibility', fr: 'Haute visibilité' }, fill: '#ffeb00', stroke: '#000000', size: 32 },
  { id: 'retro', name: { en: 'Retro pixel', fr: 'Pixel rétro' }, fill: '#ffffff', stroke: '#000000', size: 32, pixel: true },
];
export const CURSOR_SIZES = [100, 125, 150, 200, 250, 300];
// Shapes on a 32 × 32 grid: [paths, hotspot x, hotspot y, rotation°, fill rule]
const P_ARROW = 'M5 2.5V25l5.6-5.2 3.6 8.4 3.6-1.5-3.5-8.3h7.6z';
const P_HAND =
  'M11.5 2.6c1.2 0 2.1.9 2.1 2.1v8.1l.9-.1c1 0 1.8.6 2.1 1.5.4-.3.9-.5 1.5-.5 1 0 1.8.7 2 1.6.4-.3.9-.4 1.4-.4 1.2 0 2.1.9 2.1 2.1v5.6c0 3.8-3.1 6.9-6.9 6.9h-2.3c-2.1 0-4-1-5.3-2.6l-4.4-5.9c-.7-.9-.5-2.2.4-2.9.9-.7 2.2-.5 2.9.4l1.4 1.8V4.7c0-1.2 1-2.1 2.1-2.1z';
// open palm (grab): four fingers, the palm and the thumb (sub-paths overlap: drawn with the non-zero rule)
const P_PALM = [
  'M9.6 17V7.9a1.85 1.85 0 0 1 3.7 0V17z',
  'M13.3 16V5.9a1.85 1.85 0 0 1 3.7 0V16z',
  'M17 16V6.9a1.85 1.85 0 0 1 3.7 0V16z',
  'M20.7 17V9.6a1.75 1.75 0 0 1 3.5 0V17z',
  'M9.6 14.5h14.6v6c0 4.4-3.4 7.7-7.8 7.7h-1.5c-2.6 0-4.8-1.2-6.2-3.3l-4-5.6c-.7-1-.4-2.4.6-3 1-.6 2.2-.4 2.9.5l1.4 1.9z',
].join('');
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
  palm: [[P_PALM], 16, 13, 0, 'nonzero'],
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
export const CURSOR_SHAPES = Object.keys(SHAPES);
// CSS keyword -> shape
const KEYWORDS = {
  default: 'arrow', pointer: 'hand', text: 'text', 'vertical-text': 'text', move: 'move', 'all-scroll': 'move', grab: 'palm', grabbing: 'fist',
  crosshair: 'cross', cell: 'cross', 'not-allowed': 'no', 'no-drop': 'no', wait: 'wait', progress: 'progress', help: 'help',
  'ew-resize': 'ew', 'e-resize': 'ew', 'w-resize': 'ew', 'ns-resize': 'ns', 'n-resize': 'ns', 's-resize': 'ns',
  'nwse-resize': 'nwse', 'nw-resize': 'nwse', 'se-resize': 'nwse', 'nesw-resize': 'nesw', 'ne-resize': 'nesw', 'sw-resize': 'nesw',
  'col-resize': 'col', 'row-resize': 'row', alias: 'arrow', copy: 'arrow', 'context-menu': 'arrow', 'zoom-in': 'cross', 'zoom-out': 'cross',
};
export const CURSOR_KEYWORDS = Object.keys(KEYWORDS);

const accentHex = () => {
  const a = String(settings.get('accent') || '#0078d4');
  return /^#[0-9a-f]{6}$/i.test(a) ? a : '#0078d4';
};
const cursorScale = () => {
  const v = Number(settings.get('cursorSize'));
  return Number.isFinite(v) ? Math.max(100, Math.min(300, v)) / 100 : 1;
};
const cursorCache = new Map();
/** PNG data URL of one cursor shape in a pack: { url, x, y, size } */
function drawCursor(pack, shape, scale = 1) {
  const fill = pack.fill === 'accent' ? accentHex() : pack.fill;
  // Chromium ignores cursor images over 128 px
  const size = Math.max(16, Math.min(128, Math.round((pack.size || 24) * scale)));
  const key = `${pack.id}|${shape}|${fill}|${size}`;
  if (cursorCache.has(key)) return cursorCache.get(key);
  if (cursorCache.size > 600) cursorCache.clear(); // accent changes: keep the cache bounded
  const [paths, hx, hy, rot = 0, rule = 'evenodd'] = SHAPES[shape] || SHAPES.arrow;
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
    g.fill(p, rule);
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
  const val = { url: out.toDataURL('image/png'), x: Math.min(size - 1, Math.round(hx * s)), y: Math.min(size - 1, Math.round(hy * s)), size };
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
    for (const r of recs) {
      for (const n of r.addedNodes) {
        if (n.tagName === 'LINK') {
          if (n.sheet) rewriteSheet(n.sheet);
          else n.addEventListener('load', () => rewriteSheet(n.sheet), { once: true });
        } else if (n.tagName === 'STYLE' && n.id !== CURSOR_VARS_ID && n.id !== ICON_CSS_ID) setTimeout(() => rewriteSheet(n.sheet), 0);
      }
    }
  }).observe(document.head, { childList: true });
}
// Cursors set from JS as inline styles (el.style.cursor = 'grabbing', h(…, { style: { cursor: 'move' } })) use the
// pack's variables too: while a pack is drawn, a MutationObserver on style attributes maps plain keywords to
// var(--cur-x, x) (url() cursors of apps, e.g. Paint brushes, are untouched). Chromium keeps the CSS properties of
// element.style as own properties, so the setter cannot be patched instead. The observer only reads one property
// per changed element (a window drag changes left/top ~60 times a second: negligible) and stops with the system pack.
let inlineObs = null;
const mapInline = (v) => {
  const k = typeof v === 'string' ? v.trim() : '';
  return k && KW.test(k) ? `var(--cur-${k}, ${k})` : null;
};
function fixInline(el) {
  const st = el.style;
  if (!st) return;
  const v = st.getPropertyValue('cursor');
  if (!v) return;
  const m = mapInline(v);
  if (m) st.setProperty('cursor', m, st.getPropertyPriority('cursor'));
}
function watchInlineCursors(on) {
  if (!on) {
    inlineObs?.disconnect();
    inlineObs = null;
    return;
  }
  if (inlineObs) return;
  for (const el of document.querySelectorAll('[style*="cursor"]')) fixInline(el);
  inlineObs = new MutationObserver((recs) => {
    for (const r of recs) {
      if (r.type === 'attributes') fixInline(r.target);
      else for (const n of r.addedNodes) if (n.nodeType === 1) {
        if (n.hasAttribute('style')) fixInline(n);
        if (n.firstElementChild) for (const c of n.querySelectorAll('[style*="cursor"]')) fixInline(c);
      }
    }
  });
  inlineObs.observe(document.documentElement, { attributes: true, attributeFilter: ['style'], subtree: true, childList: true });
}
const cursorPackId = () => {
  const id = settings.get('cursorPack');
  return CURSOR_PACKS.some((p) => p.id === id) ? id : 'default';
};
/** The pack actually drawn: the system pack cannot be scaled, so a larger size draws "Aurora light". */
const drawnPack = () => {
  const id = cursorPackId();
  return CURSOR_PACKS.find((p) => p.id === (id === 'default' && cursorScale() > 1 ? 'classic' : id));
};
function applyCursors() {
  const pack = drawnPack();
  let el = document.getElementById(CURSOR_VARS_ID);
  document.documentElement.dataset.cursorPack = cursorPackId();
  if (pack.id === 'default') {
    el?.remove();
    watchInlineCursors(false);
    return;
  }
  rewriteAll();
  watchInlineCursors(true);
  if (!el) {
    el = document.createElement('style');
    el.id = CURSOR_VARS_ID;
    document.head.appendChild(el);
  }
  const k = cursorScale();
  const decl = [];
  for (const kw of CURSOR_KEYWORDS) {
    const c = drawCursor(pack, KEYWORDS[kw], k);
    decl.push(`--cur-${kw}: url("${c.url}") ${c.x} ${c.y}, ${kw};`);
  }
  const arrow = drawCursor(pack, 'arrow', k);
  const beam = drawCursor(pack, 'text', k);
  const hand = drawCursor(pack, 'hand', k);
  // (Chromium's own style sheet gives buttons and form controls `cursor: default`, the system arrow: the :where() rule
  // gives them the pack's arrow with no specificity, so any author `cursor:` on them still wins)
  el.textContent = `:root { ${decl.join(' ')} }
:root, :root body { cursor: url("${arrow.url}") ${arrow.x} ${arrow.y}, default; }
:where(button, select, input:is([type=button], [type=checkbox], [type=radio], [type=range], [type=color], [type=submit], [type=reset], [type=file], [type=image])) { cursor: url("${arrow.url}") ${arrow.x} ${arrow.y}, default; }
:root :is(input:not([type=button], [type=checkbox], [type=radio], [type=range], [type=color], [type=submit], [type=reset], [type=file], [type=image]), textarea, [contenteditable=""], [contenteditable="true"]) { cursor: url("${beam.url}") ${beam.x} ${beam.y}, text; }
:root a[href] { cursor: url("${hand.url}") ${hand.x} ${hand.y}, pointer; }`;
}

// ------------------------------------------------------------------ icon packs
export const ICON_PACKS = [
  { id: 'fluent', name: { en: 'Fluent color (app icons)', fr: 'Fluent couleur (icônes des applications)' } },
  { id: 'tiles', name: { en: 'Aurora tiles', fr: 'Tuiles Aurora' } },
  { id: 'accent', name: { en: 'Accent tiles', fr: 'Tuiles d’accentuation' } },
  { id: 'glass', name: { en: 'Glass', fr: 'Verre' } },
  { id: 'graphite', name: { en: 'Graphite', fr: 'Graphite' } },
  { id: 'mono', name: { en: 'Monochrome', fr: 'Monochrome' } },
  { id: 'outline', name: { en: 'Outline', fr: 'Contour' } },
  { id: 'retro', name: { en: 'Retro pixel', fr: 'Pixel rétro' } },
];
// The Fluent glyph that stands for each app (unknown apps: their first letter), and the shell's special icons.
const GLYPHS = {
  browser: 'globe', files: 'folder', mail: 'mail', notepad: 'notepad', terminal: 'window_console', settings: 'settings', calculator: 'calculator',
  paint: 'paint_brush', media: 'play_circle', snipping: 'cut', taskmgr: 'data_histogram', minesweeper: 'flag', solitaire: 'playing_cards',
  snake: 'games', game2048: 'grid', chess: 'chess', installer: 'arrow_download', photos: 'image', pdf: 'document_pdf', archive: 'folder_zip',
  notes: 'note', calendar: 'calendar_ltr', clock: 'clock', todo: 'task_list_ltr', winver: 'info',
  'special:thispc': 'desktop', 'special:trash': 'delete',
};
const TILE_COLORS = {
  browser: '#0f6cbd', files: '#c08a00', mail: '#0a5aa8', notepad: '#3a6ea5', terminal: '#2b2b2b', settings: '#5c6670', calculator: '#4d5a66',
  paint: '#c43e8b', media: '#d1452f', snipping: '#b83c6b', taskmgr: '#2f7d4f', minesweeper: '#8a5a2b', solitaire: '#1f7a46', snake: '#3e8f2f',
  game2048: '#c67a12', chess: '#5b4636', installer: '#0063b1', photos: '#1f7ab8', pdf: '#c4262e', archive: '#9a6b12', notes: '#c19c00',
  calendar: '#0f6cbd', clock: '#3b5bdb', todo: '#2564cf', winver: '#5c6670', 'special:thispc': '#0f6cbd', 'special:trash': '#5c6670',
};
// The pictures the shell and File Explorer draw for This PC and the Recycle Bin.
export const SPECIAL_ICONS = { 'special:thispc': 'app://shell/assets/icons/this-pc.svg', 'special:trash': 'app://shell/assets/icons/recycle-bin.svg' };
const PALETTE = ['#0f6cbd', '#8764b8', '#c43e1c', '#038387', '#498205', '#ca5010', '#5c2e91', '#b146c2', '#2d7d9a', '#986f0b'];
const hashColor = (id) => PALETTE[[...String(id)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % PALETTE.length];
const colorOf = (id) => TILE_COLORS[id] || hashColor(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const modeOf = () => (settings.get('theme') === 'dark' ? 'dark' : 'light');

function glyphInner(appId, filled) {
  const name = GLYPHS[appId];
  if (!name) return null;
  const svg = iconSvg(name, { filled });
  const m = /viewBox="0 0 (\d+) (\d+)"[^>]*>([\s\S]*)<\/svg>$/.exec(svg);
  return m ? { vb: Number(m[1]) || 20, inner: m[3] } : null;
}
const nameOf = (appId) => (appId.startsWith('special:') ? appId.slice(8) : registry.name(appId) || appId);
const svgUrl = (svg) => `data:image/svg+xml,${encodeURIComponent(svg)}`;

/** SVG tile packs: tiles, accent, graphite, outline, mono, glass. */
function svgIcon(packId, appId) {
  const outline = packId === 'outline';
  const mono = packId === 'mono';
  const glass = packId === 'glass';
  const g = glyphInner(appId, !outline);
  const app = colorOf(appId);
  const bg = packId === 'tiles' ? app : packId === 'accent' ? accentHex() : packId === 'graphite' ? '#4a5260' : null;
  // Monochrome: one colour that reads on the current mode (a window or taskbar of the other mode inverts it in CSS)
  const fg = outline ? app : mono ? (modeOf() === 'dark' ? '#f3f3f3' : '#1f1f1f') : '#ffffff';
  const letter = esc(nameOf(appId).trim().charAt(0).toUpperCase() || '?');
  const glyphSize = mono ? 40 : 32;
  const off = (48 - glyphSize) / 2;
  const glyph = g
    ? `<g transform="translate(${off} ${off}) scale(${glyphSize / g.vb})" fill="${fg}"${glass ? ' filter="url(#s)"' : ''}>${g.inner}</g>`
    : `<text x="24" y="${mono ? 34 : 32}" text-anchor="middle" font-family="Inter, sans-serif" font-size="${mono ? 28 : 22}" font-weight="600" fill="${fg}"${glass ? ' filter="url(#s)"' : ''}>${letter}</text>`;
  let tile = '';
  if (glass) {
    // frosted glass: a tinted, see-through square with a bright edge and a glossy top
    tile = `<defs><linearGradient id="t" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${app}" stop-opacity=".9"/><stop offset="1" stop-color="${app}" stop-opacity=".5"/></linearGradient><linearGradient id="h" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".55"/><stop offset=".48" stop-color="#fff" stop-opacity=".12"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/></linearGradient><filter id="s" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="1" stdDeviation="1" flood-color="#000" flood-opacity=".35"/></filter></defs><rect x="3" y="3" width="42" height="42" rx="12" fill="url(#t)"/><rect x="3" y="3" width="42" height="42" rx="12" fill="url(#h)"/><rect x="3.5" y="3.5" width="41" height="41" rx="11.5" fill="none" stroke="#fff" stroke-opacity=".75"/><rect x="2.5" y="2.5" width="43" height="43" rx="12.5" fill="none" stroke="#000" stroke-opacity=".14"/>`;
  } else if (bg) {
    tile = `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".18"/><stop offset="1" stop-color="#000" stop-opacity=".12"/></linearGradient></defs><rect x="2" y="2" width="44" height="44" rx="11" fill="${bg}"/><rect x="2" y="2" width="44" height="44" rx="11" fill="url(#g)"/>`;
  } else if (outline) {
    tile = `<rect x="3" y="3" width="42" height="42" rx="11" fill="#ffffff" fill-opacity=".92" stroke="${fg}" stroke-opacity=".55" stroke-width="2"/>`;
  }
  // the marker comment lets shell-personalize.css invert monochrome icons inside a window / taskbar of the other mode
  return svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">${mono ? '<!--aurora-mono-->' : ''}${tile}${glyph}</svg>`);
}

// Retro: the glyph drawn on a 24 px grid without anti-aliasing, in a 16-colour VGA palette with a black outline,
// upscaled ×2 (48 px PNG) so it stays crisp at the taskbar's 24 px.
const VGA = ['#800000', '#008000', '#808000', '#000080', '#800080', '#008080', '#808080', '#ff0000', '#00a800', '#a8a800', '#0000ff', '#ff00ff', '#00a8a8'];
function nearestVga(hex) {
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [r, g, b] = p(hex);
  let best = VGA[0];
  let bd = Infinity;
  for (const c of VGA) {
    const [R, G, B] = p(c);
    const d = (r - R) ** 2 * 0.3 + (g - G) ** 2 * 0.59 + (b - B) ** 2 * 0.11;
    if (d < bd) {
      bd = d;
      best = c;
    }
  }
  return best;
}
function retroIcon(appId) {
  const N = 24;
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const g = c.getContext('2d');
  const gl = glyphInner(appId, true);
  g.fillStyle = '#fff';
  if (gl) {
    g.save();
    g.translate(2, 2);
    g.scale(20 / gl.vb, 20 / gl.vb);
    for (const m of gl.inner.matchAll(/<path\b[^>]*\bd="([^"]+)"[^>]*>/g)) {
      const rule = /fill-rule="evenodd"/.test(m[0]) ? 'evenodd' : 'nonzero';
      g.fill(new Path2D(m[1]), rule);
    }
    g.restore();
  } else {
    g.font = 'bold 18px monospace';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(nameOf(appId).trim().charAt(0).toUpperCase() || '?', N / 2, N / 2 + 1);
  }
  const src = g.getImageData(0, 0, N, N).data;
  const on = (x, y) => x >= 0 && y >= 0 && x < N && y < N && src[(y * N + x) * 4 + 3] >= 110;
  const color = nearestVga(colorOf(appId));
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [cr, cg, cb] = rgb(color);
  const out = g.createImageData(N, N);
  const d = out.data;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = (y * N + x) * 4;
      if (on(x, y)) {
        // a lighter band on the upper-left edge of the shape: the bevel of the old icons
        const lit = !on(x - 1, y) || !on(x, y - 1);
        d[i] = lit ? Math.min(255, cr + 80) : cr;
        d[i + 1] = lit ? Math.min(255, cg + 80) : cg;
        d[i + 2] = lit ? Math.min(255, cb + 80) : cb;
        d[i + 3] = 255;
      } else if (on(x - 1, y) || on(x + 1, y) || on(x, y - 1) || on(x, y + 1)) {
        d[i + 3] = 255; // black outline
      } else if (on(x - 1, y - 1) && !on(x, y)) {
        d[i] = d[i + 1] = d[i + 2] = 96; // hard drop shadow
        d[i + 3] = 150;
      }
    }
  }
  g.putImageData(out, 0, 0);
  const big = document.createElement('canvas');
  big.width = big.height = N * 2;
  const bg = big.getContext('2d');
  bg.imageSmoothingEnabled = false;
  bg.drawImage(c, 0, 0, N * 2, N * 2);
  return big.toDataURL('image/png');
}

const iconCache = new Map();
/** URL of an app (or special:*) icon in a pack, or null for the app's own icon ("fluent"). */
function packIcon(packId, appId) {
  if (!packId || packId === 'fluent' || !ICON_PACKS.some((p) => p.id === packId)) return null;
  if (!appId.startsWith('special:') && !registry.get(appId)) return null;
  const key = `${packId}|${appId}|${packId === 'accent' ? accentHex() : packId === 'mono' ? modeOf() : ''}`;
  if (iconCache.has(key)) return iconCache.get(key);
  if (iconCache.size > 800) iconCache.clear();
  let url = null;
  try {
    url = packId === 'retro' ? retroIcon(appId) : svgIcon(packId, appId);
  } catch (err) {
    console.warn('[packs] icon failed', appId, err);
  }
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
// Pictures drawn straight from an app's icon file or a special icon (apps, File Explorer, the desktop's This PC and
// Recycle Bin): mapped to the pack with CSS (Chromium replaces an <img>'s picture with `content: url()`).
const ICON_CSS_ID = 'aurora-iconpack-css';
const cssUrl = (u) => `url("${String(u).replace(/["\\\n]/g, (c) => `\\${c.charCodeAt(0).toString(16)} `)}")`;
function applyIconCss() {
  const id = iconPackId();
  let el = document.getElementById(ICON_CSS_ID);
  if (id === 'fluent') {
    el?.remove();
    return;
  }
  const rules = [];
  for (const m of registry.list({ includeHidden: true })) {
    const url = packIcon(id, m.id);
    if (!url || !m.icon || !/^[\w.-]+$/.test(m.icon) || !/^[\w.-]+$/.test(m.id)) continue;
    rules.push(`img[src="app://shell/apps/${m.id}/${m.icon}"]:not([data-icon-fixed]) { content: ${cssUrl(url)}; }`);
  }
  for (const [sid, file] of Object.entries(SPECIAL_ICONS)) {
    const url = packIcon(id, sid);
    if (url) rules.push(`img[src="${file}"]:not([data-icon-fixed]) { content: ${cssUrl(url)}; }`);
  }
  if (!el) {
    el = document.createElement('style');
    el.id = ICON_CSS_ID;
    document.head.appendChild(el);
  }
  el.textContent = rules.join('\n');
}
function applyIcons() {
  document.documentElement.dataset.iconPack = iconPackId();
  swapIcons();
  applyIconCss();
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
    settings.on('cursorSize', applyCursors);
    settings.on('iconPack', applyIcons);
    settings.on('accent', () => {
      if (drawnPack().id === 'accent') applyCursors();
      if (iconPackId() === 'accent') applyIcons();
    });
    settings.on('theme', () => {
      if (iconPackId() === 'mono') applyIcons();
    });
    // the system-sound hooks (device connected, recycle bin emptied…) start with the shell
    try {
      sounds.watchSystem?.();
    } catch (err) {
      console.warn('[packs] sounds', err);
    }
  },
  /** Re-scan the icons on screen (e.g. after the app list was reloaded). */
  refreshIcons: applyIcons,
  cursorPreview(packId, shape = 'arrow', size) {
    const pack = CURSOR_PACKS.find((p) => p.id === packId);
    if (!pack || pack.id === 'default') return null;
    return drawCursor(pack, shape, size ? Math.max(1, Math.min(3, size / 100)) : 1).url;
  },
  cursorInfo(packId, shape = 'arrow', size) {
    const pack = CURSOR_PACKS.find((p) => p.id === packId);
    return pack && pack.id !== 'default' ? { ...drawCursor(pack, shape, size ? Math.max(1, Math.min(3, size / 100)) : 1) } : null;
  },
  appIcon(packId, appId) {
    return packIcon(packId, appId) || (registry.get(appId)?.icon ? `app://shell/apps/${appId}/${registry.get(appId).icon}` : 'app://shell/assets/app-default.svg');
  },
  specialIcon(packId, which) {
    const sid = `special:${which}`;
    return packIcon(packId, sid) || SPECIAL_ICONS[sid] || null;
  },
  get cursorPack() {
    return cursorPackId();
  },
  get cursorDrawn() {
    return drawnPack().id;
  },
  get iconPack() {
    return iconPackId();
  },
};
