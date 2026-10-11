// Snap layouts (Windows 11):
//   * hovering a window's maximize button (~450 ms) shows the layouts flyout; hovering a zone highlights
//     it, clicking snaps the window there. Super+Z opens the same flyout for the focused window with
//     keyboard navigation (arrows, Enter, or the layout number then the zone number).
//   * dragging a window to the top centre of the screen drops down a compact layouts bar; releasing over
//     a zone snaps the window there (the wm's edge snapping and its preview keep working everywhere else).
//   * Snap Assist: after a window is snapped to part of the screen (drag, Super+arrows, a layout), the
//     remaining zone shows thumbnails of the other windows; clicking one snaps it there, then the next
//     empty zone of the layout is offered. Esc / clicking elsewhere dismisses it.
//   shell.on('snaplayouts:open', win)       window.__aurora.snap = { open, close, assist, layouts }
// Settings (Windows "Multitasking" page; all default on except shake):
//   multitasking.snap          edge snapping, Super+arrows snapping zones, the drag bar
//   multitasking.snapLayouts   flyout when hovering the maximize button
//   multitasking.snapBar       layouts bar when a window is dragged to the top of the screen
//   multitasking.snapAssist    Snap Assist after snapping
//   multitasking.shake         title bar window shake (minimise the other windows)
// Personalization (docs/PERSONALIZATION.md §12.2): settings.snapLayouts = ordered ids of the layouts the flyouts show
// (BUILTIN_LAYOUTS ids and snapPresets ids; null = DEFAULT_LAYOUT_IDS then every preset); settings.snapPresets = the
// user's own layouts [{ id, name, zones: [{ x, y, w, h }] }].
import { h, icon, ui } from '../ui.js';
import { i18n, t } from '../i18n.js';
import { wm } from '../wm.js';
import { registry } from '../registry.js';
import { shell } from '../services.js';
import { settings } from '../settings.js';
import { thumbs } from './alttab.js';

const opt = (k, def = true) => {
  const v = settings.get(`multitasking.${k}`);
  return v == null ? def : v !== false;
};

i18n.extend({
  en: { snap: { label: 'Snap layouts', assist: 'Snap Assist', chooseWindow: 'Choose a window to snap here' } },
  fr: { snap: { label: "Dispositions d'ancrage", assist: "Assistance à l'ancrage", chooseWindow: 'Choisissez une fenêtre à ancrer ici' } },
});

export const LAYOUTS = [
  ['left', 'right'],
  ['two-thirds-l', 'third-r'],
  ['third-l', 'third-c', 'third-r'],
  ['left', 'tr', 'br'],
  ['tl', 'tr', 'bl', 'br'],
  ['quarter-l', 'half-c', 'quarter-r'],
];

// The user's own layouts (settings snapPresets: [{ id, name, zones: [{ x, y, w, h }] }], fractions of the work area,
// edited in Settings > Personalization > Snap layouts) are 'z:x,y,w,h' zones (wm.zoneRect).
const r4 = (n) => Math.round(Math.max(0, Math.min(1, Number(n) || 0)) * 10000) / 10000;
const frac = (n) => String(r4(n));
const zoneOf = (x, y, w, h) => `z:${frac(x)},${frac(y)},${frac(w)},${frac(h)}`;
export function presetZones(p) {
  return (p?.zones || [])
    .filter((z) => z && z.w > 0 && z.h > 0 && z.x >= 0 && z.y >= 0 && z.x + z.w <= 1.001 && z.y + z.h <= 1.001)
    .slice(0, 16)
    .map((z) => zoneOf(z.x, z.y, z.w, z.h));
}
const cols = (n) => Array.from({ length: n }, (_, i) => zoneOf(i / n, 0, i === n - 1 ? 1 - r4(i / n) : 1 / n, 1));
const rows = (n) => Array.from({ length: n }, (_, i) => zoneOf(0, i / n, 1, i === n - 1 ? 1 - r4(i / n) : 1 / n));

/** Every built-in layout: { id, zones, name } — the first six are Windows 11's (shown by default). */
export const BUILTIN_LAYOUTS = [
  { id: 'halves', zones: LAYOUTS[0], name: { en: 'Two halves', fr: 'Deux moitiés' } },
  { id: 'twoThirds', zones: LAYOUTS[1], name: { en: 'Two thirds and one third', fr: 'Deux tiers et un tiers' } },
  { id: 'thirds', zones: LAYOUTS[2], name: { en: 'Three columns', fr: 'Trois colonnes' } },
  { id: 'mainStack', zones: LAYOUTS[3], name: { en: 'Half and two quarters', fr: 'Une moitié et deux quarts' } },
  { id: 'quad', zones: LAYOUTS[4], name: { en: 'Four quarters', fr: 'Quatre quarts' } },
  { id: 'wideCenter', zones: LAYOUTS[5], name: { en: '25 / 50 / 25', fr: '25 / 50 / 25' } },
  { id: 'seventyThirty', zones: [zoneOf(0, 0, 0.7, 1), zoneOf(0.7, 0, 0.3, 1)], name: { en: '70 / 30', fr: '70 / 30' } },
  { id: 'thirtySeventy', zones: [zoneOf(0, 0, 0.3, 1), zoneOf(0.3, 0, 0.7, 1)], name: { en: '30 / 70', fr: '30 / 70' } },
  { id: 'thirdTwoThirds', zones: ['third-l', 'two-thirds-r'], name: { en: 'One third and two thirds', fr: 'Un tiers et deux tiers' } },
  { id: 'stackMain', zones: ['tl', 'bl', 'right'], name: { en: 'Two quarters and half', fr: 'Deux quarts et une moitié' } },
  { id: 'fourColumns', zones: cols(4), name: { en: 'Four columns', fr: 'Quatre colonnes' } },
  { id: 'twoRows', zones: rows(2), name: { en: 'Two rows', fr: 'Deux lignes' } },
  { id: 'threeRows', zones: rows(3), name: { en: 'Three rows', fr: 'Trois lignes' } },
  { id: 'sixGrid', zones: [0, 1].flatMap((j) => [0, 1, 2].map((i) => zoneOf(i / 3, j / 2, i === 2 ? 1 - r4(2 / 3) : 1 / 3, 0.5))), name: { en: 'Six tiles', fr: 'Six tuiles' } },
];
export const DEFAULT_LAYOUT_IDS = BUILTIN_LAYOUTS.slice(0, 6).map((l) => l.id);
export const MAX_SHOWN_LAYOUTS = 18;
const presets = () => (Array.isArray(settings.get('snapPresets')) ? settings.get('snapPresets') : []).slice(0, 12);
/** The layouts the flyouts show, in order: [{ id, zones, custom }] (never empty). */
export function shownLayouts() {
  const byId = new Map(BUILTIN_LAYOUTS.map((l) => [l.id, { id: l.id, zones: l.zones, custom: false }]));
  for (const p of presets()) {
    const zones = presetZones(p);
    if (zones.length && typeof p.id === 'string' && !byId.has(p.id)) byId.set(p.id, { id: p.id, zones, custom: true });
  }
  const order = settings.get('snapLayouts');
  const ids = Array.isArray(order) ? order : [...DEFAULT_LAYOUT_IDS, ...presets().map((p) => p.id)];
  const out = [];
  for (const id of ids) {
    const l = byId.get(id);
    if (l && !out.includes(l)) out.push(l);
  }
  return (out.length ? out : DEFAULT_LAYOUT_IDS.map((id) => byId.get(id))).slice(0, MAX_SHOWN_LAYOUTS);
}
/** Zones of the layouts shown (arrays of zone names), in order. */
export function allLayouts() {
  return shownLayouts().map((l) => l.zones);
}
/** Fractions { x, y, w, h } of a zone name (for previews outside the shell's work area, e.g. Settings). */
export function zoneFractions(zone) {
  const F = {
    left: [0, 0, 0.5, 1], right: [0.5, 0, 0.5, 1], tl: [0, 0, 0.5, 0.5], tr: [0.5, 0, 0.5, 0.5], bl: [0, 0.5, 0.5, 0.5], br: [0.5, 0.5, 0.5, 0.5],
    'third-l': [0, 0, 1 / 3, 1], 'third-c': [1 / 3, 0, 1 / 3, 1], 'third-r': [2 / 3, 0, 1 / 3, 1], 'two-thirds-l': [0, 0, 2 / 3, 1], 'two-thirds-r': [1 / 3, 0, 2 / 3, 1],
    'quarter-l': [0, 0, 0.25, 1], 'half-c': [0.25, 0, 0.5, 1], 'quarter-r': [0.75, 0, 0.25, 1], max: [0, 0, 1, 1],
  }[zone];
  if (F) return { x: F[0], y: F[1], w: F[2], h: F[3] };
  const m = /^z:([\d.]+),([\d.]+),([\d.]+),([\d.]+)$/.exec(String(zone || ''));
  return m ? { x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]) } : null;
}

// What Snap Assist offers after a snap that did not come from a layout.
const COMPLEMENT = {
  left: ['right'],
  right: ['left'],
  tl: ['tr', 'bl', 'br'],
  tr: ['tl', 'bl', 'br'],
  bl: ['tl', 'tr', 'br'],
  br: ['tl', 'tr', 'bl'],
  'third-l': ['third-c', 'third-r'],
  'third-c': ['third-l', 'third-r'],
  'third-r': ['third-l', 'third-c'],
  'two-thirds-l': ['third-r'],
  'two-thirds-r': ['third-l'],
  'quarter-l': ['half-c', 'quarter-r'],
  'half-c': ['quarter-l', 'quarter-r'],
  'quarter-r': ['quarter-l', 'half-c'],
};

const reduceMotion = () => document.documentElement.dataset.animations === 'off';

// Mini picture of a layout: zones positioned in % of the work area.
function layoutTile(zones, { onZone, onHover, numbered, index } = {}) {
  const wa = wm.workarea();
  const tile = h('div', { class: 'snapl-layout', dataset: { layout: String(index) }, style: { aspectRatio: String(wa.width / wa.height) } });
  zones.forEach((z, zi) => {
    const r = wm.zoneRect(z);
    const el = h(
      'div',
      {
        class: 'snapl-zone',
        role: 'button',
        'aria-label': `${t('snap.label')} ${index + 1}.${zi + 1}`,
        dataset: { zone: z, layout: String(index), zi: String(zi) },
        style: {
          left: `${((r.x - wa.x) / wa.width) * 100}%`,
          top: `${((r.y - wa.y) / wa.height) * 100}%`,
          width: `${(r.width / wa.width) * 100}%`,
          height: `${(r.height / wa.height) * 100}%`,
        },
        onpointerenter: () => onHover?.(z, index, el),
        onclick: (e) => {
          e.stopPropagation();
          onZone?.(z, index);
        },
      },
      numbered ? h('span', { class: 'snapl-num' }, String(zi + 1)) : null,
    );
    tile.appendChild(el);
  });
  if (numbered) tile.appendChild(h('span', { class: 'snapl-lnum' }, String(index + 1)));
  return tile;
}

// ------------------------------------------------------------------ flyout (max-button hover / Super+Z)
let fly = null; // { win, el, kb, sel: [layout, zone], digits }
let showTimer = 0;
let hideTimer = 0;
let pendingLayout = null; // layout chosen in the flyout, for Snap Assist

function hideFlyout() {
  clearTimeout(showTimer);
  clearTimeout(hideTimer);
  if (!fly) return;
  const f = fly;
  fly = null;
  f.off?.();
  document.removeEventListener('pointerdown', onOutside, true);
  document.removeEventListener('keydown', onFlyKey, true);
  f.el.classList.add('closing');
  setTimeout(() => f.el.remove(), 140);
  if (f.kb && wm.focused() === f.win) f.win.focusContent();
}

function onOutside(e) {
  if (fly && !fly.el.contains(e.target) && !fly.win.btnMax.contains(e.target)) hideFlyout();
}

function pick(z, li) {
  const win = fly?.win;
  const layouts = fly?.layouts || LAYOUTS;
  hideFlyout();
  if (!win || win._closing) return;
  pendingLayout = layouts[li];
  if (win.minimized) win.restoreFromMinimize();
  win.focus();
  win.snapTo(z, { source: 'layout' });
  pendingLayout = null;
}

function paintSel() {
  if (!fly) return;
  for (const z of fly.el.querySelectorAll('.snapl-zone')) {
    const on = Number(z.dataset.layout) === fly.sel[0] && Number(z.dataset.zi) === fly.sel[1];
    z.classList.toggle('kb', on);
  }
}

function onFlyKey(e) {
  if (!fly) return;
  const LAYOUTS = fly.layouts;
  const [li, zi] = fly.sel;
  const k = e.key;
  let handled = true;
  if (k === 'Escape') hideFlyout();
  else if (k === 'Enter' || k === ' ') pick(LAYOUTS[li][zi], li);
  else if (k === 'ArrowRight' || k === 'ArrowLeft') {
    const d = k === 'ArrowRight' ? 1 : -1;
    let nl = li;
    let nz = zi + d;
    if (nz >= LAYOUTS[li].length) {
      nl = (li + 1) % LAYOUTS.length;
      nz = 0;
    } else if (nz < 0) {
      nl = (li - 1 + LAYOUTS.length) % LAYOUTS.length;
      nz = LAYOUTS[nl].length - 1;
    }
    fly.sel = [nl, nz];
  } else if (k === 'ArrowDown' || k === 'ArrowUp') {
    const nl = (li + (k === 'ArrowDown' ? 3 : -3) + LAYOUTS.length) % LAYOUTS.length;
    fly.sel = [nl, Math.min(zi, LAYOUTS[nl].length - 1)];
  } else if (/^[1-9]$/.test(k)) {
    const n = Number(k) - 1;
    if (fly.digits == null) {
      if (n < LAYOUTS.length) {
        fly.digits = n;
        fly.sel = [n, 0];
      }
    } else if (n < LAYOUTS[fly.digits].length) {
      pick(LAYOUTS[fly.digits][n], fly.digits);
      handled = true;
    }
  } else handled = false;
  if (handled) {
    e.preventDefault();
    e.stopPropagation();
    paintSel();
  }
}

export function openFlyout(win, { keyboard = false, anchor } = {}) {
  if (!win || !win.opts.resizable || !win.opts.maximizable || win.fullscreen || win._closing) return;
  if (fly?.win === win) {
    if (keyboard && !fly.kb) hideFlyout();
    else return;
  }
  hideFlyout();
  shell.emit('flyouts:close');
  if (keyboard) wm.endKeyboardMove?.();
  const grid = h('div', { class: 'snapl-grid' });
  const el = h(
    'div',
    {
      class: ['snapl-fly', keyboard && 'kbd'],
      role: 'menu',
      'aria-label': t('snap.label'),
      tabindex: '-1',
      onpointerenter: () => clearTimeout(hideTimer),
      onpointerleave: () => {
        if (!fly?.kb) hideTimer = setTimeout(hideFlyout, 320);
      },
    },
    grid,
  );
  const layouts = allLayouts();
  layouts.forEach((zones, i) =>
    grid.appendChild(
      layoutTile(zones, {
        index: i,
        numbered: keyboard && i < 9,
        onZone: pick,
        onHover: (z, li) => {
          if (fly) {
            fly.sel = [li, layouts[li].indexOf(z)];
            paintSel();
          }
        },
      }),
    ),
  );
  const shown = shownLayouts();
  [...grid.children].forEach((tile, i) => {
    tile.classList.toggle('custom', !!shown[i]?.custom);
    tile.dataset.id = shown[i]?.id || '';
  });
  document.getElementById('overlays').appendChild(el);
  // Under the maximize button, kept on screen.
  const b = (anchor || win.btnMax).getBoundingClientRect();
  const r = el.getBoundingClientRect();
  let x = b.left + b.width / 2 - r.width / 2;
  x = Math.max(8, Math.min(window.innerWidth - r.width - 8, x));
  let y = b.bottom + 6;
  if (!b.width) {
    const wr = win.el.getBoundingClientRect();
    x = Math.max(8, Math.min(window.innerWidth - r.width - 8, wr.right - r.width - 8));
    y = wr.top + 38;
  }
  if (y + r.height > window.innerHeight - 8) y = Math.max(8, b.top - r.height - 6);
  el.style.left = `${Math.round(x)}px`;
  el.style.top = `${Math.round(y)}px`;
  fly = { win, el, kb: keyboard, sel: [0, 0], digits: null, layouts };
  setTimeout(() => document.addEventListener('pointerdown', onOutside, true));
  if (keyboard) {
    document.addEventListener('keydown', onFlyKey, true);
    el.focus({ preventScroll: true });
    paintSel();
  }
  fly.off = win.on('close', hideFlyout);
}

// ------------------------------------------------------------------ Snap Assist
let assist = null; // { win, zones, group:Set, el, cards, index, keyHandler }

function endAssist(refocus = true) {
  if (!assist) return;
  const a = assist;
  assist = null;
  document.removeEventListener('keydown', a.onKey, true);
  document.removeEventListener('pointerdown', a.onOutside, true);
  thumbs.block(false);
  if (a.el) {
    a.el.classList.add('closing');
    const el = a.el;
    setTimeout(() => el.remove(), 160);
  }
  if (refocus && a.win && wm.get(a.win.id) && wm.focused() === a.win) a.win.focusContent();
}

function assistCandidates(a) {
  return wm.mru().filter((w) => !a.group.has(w) && !w._closing && w.opts.resizable && !w.fullscreen);
}

function zoneTaken(z, group) {
  return wm.listDesktop().some((w) => !group.has(w) && w.state === 'snapped' && w.snap === z && !w.minimized);
}

function renderAssist() {
  const a = assist;
  if (!a) return;
  while (a.zones.length && zoneTaken(a.zones[0], a.group)) a.zones.shift();
  const cands = assistCandidates(a);
  if (!a.zones.length || !cands.length) return endAssist();
  const zone = a.zones[0];
  const r = wm.zoneRect(zone);
  const pad = 16;
  const W = r.width - 12 - pad * 2 - 4; // a little slack against sub-pixel rounding
  const H = r.height - 12 - pad * 2 - 32; // minus the hint line and its gap
  const n = cands.length;
  let best = { tw: 0, cols: 1 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const cellW = (W - 12 * (cols - 1)) / cols;
    const cellH = (H - 12 * (rows - 1)) / rows - 38; // card chrome: 2 x 6 px padding, 20 px title, 6 px gap
    const tw = Math.min(cellW - 12, cellH * 1.6, 300);
    if (tw > best.tw) best = { tw, cols };
  }
  const tw = Math.max(72, Math.floor(best.tw));
  const th = Math.round(tw / 1.6);
  const cards = cands.map((w, i) => {
    // Each thumbnail keeps its window's shape inside a uniform cell.
    const ar = Math.max(0.5, Math.min(2.4, (w.w || 4) / (w.h || 3)));
    const fw = Math.round(Math.min(tw, th * ar));
    const fh = Math.round(Math.min(th, tw / ar));
    return h(
      'button',
      {
        class: ['snapa-card', i === a.index && 'sel'],
        dataset: { id: w.id },
        style: { width: `${fw + 12}px` },
        onpointerdown: (e) => e.preventDefault(),
        onclick: () => choose(w),
      },
      h('div', { class: 'snapa-head' }, h('img', { src: w.iconUrl || registry.iconUrl(w.appId), alt: '', draggable: false }), h('span', { class: 'ellipsis' }, w.title || registry.name(w.appId))),
      h('div', { class: 'snapa-cell', style: { height: `${th}px` } }, h('div', { class: 'snapa-thumb', style: { width: `${fw}px`, height: `${fh}px` } }, thumbs.node(w, fw, fh))),
    );
  });
  // Explicit rows of best.cols cards (a wrapping flex box could break rows differently than computed).
  const rows = [];
  for (let i = 0; i < cards.length; i += best.cols) rows.push(h('div', { class: 'snapa-row' }, cards.slice(i, i + best.cols)));
  const grid = h('div', { class: 'snapa-grid' }, rows);
  const fresh = !a.el;
  const el =
    a.el ||
    h('div', {
      class: 'snapa wm-keep-focus',
      role: 'listbox',
      'aria-label': t('snap.assist'),
      tabindex: '-1',
    });
  el.replaceChildren(h('div', { class: 'snapa-hint' }, t('snap.chooseWindow')), grid);
  Object.assign(el.style, { left: `${r.x + 6}px`, top: `${r.y + 6}px`, width: `${r.width - 12}px`, height: `${r.height - 12}px` });
  if (!fresh && !reduceMotion()) el.animate([{ opacity: 0.4 }, { opacity: 1 }], { duration: 180 });
  a.el = el;
  a.cards = cards;
  a.cands = cands;
  a.index = Math.min(a.index, cards.length - 1); // -1 = nothing selected until the keyboard is used
  if (fresh) {
    document.getElementById('overlays').appendChild(el);
    el.focus({ preventScroll: true });
  }
  function paint() {
    a.cards.forEach((c, i) => c.classList.toggle('sel', i === a.index));
  }
  a.paint = paint;
  paint();
}

function choose(w) {
  const a = assist;
  if (!a) return;
  const zone = a.zones.shift();
  a.group.add(w);
  a.index = -1;
  if (w.minimized) w.restoreFromMinimize();
  w.focus();
  w.snapTo(zone, { source: 'assist' });
  if (!a.zones.length) return endAssist(false);
  // Offer the next empty zone (thumbnails of the remaining windows are already cached).
  renderAssist();
  a.el?.focus({ preventScroll: true });
}

export async function startAssist(win, zones) {
  endAssist(false);
  hideFlyout();
  const a = { win, zones: [...zones], group: new Set([win]), index: -1, el: null };
  while (a.zones.length && zoneTaken(a.zones[0], a.group)) a.zones.shift();
  if (!a.zones.length || !assistCandidates(a).length) return;
  assist = a;
  a.onKey = (e) => {
    if (assist !== a || !a.cards) return;
    const k = e.key;
    let handled = true;
    if (k === 'Escape') endAssist();
    else if (a.index < 0 && ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Tab', 'Enter', ' '].includes(k)) a.index = 0;
    else if (k === 'Enter' || k === ' ') a.cands[a.index] && choose(a.cands[a.index]);
    else if (k === 'ArrowRight' || k === 'Tab') a.index = (a.index + 1) % a.cards.length;
    else if (k === 'ArrowLeft') a.index = (a.index - 1 + a.cards.length) % a.cards.length;
    else if (k === 'ArrowDown' || k === 'ArrowUp') {
      const cur = a.cards[a.index].getBoundingClientRect();
      const dir = k === 'ArrowDown' ? 1 : -1;
      let bi = -1;
      let bd = Infinity;
      a.cards.forEach((c, i) => {
        const r = c.getBoundingClientRect();
        if (dir > 0 ? r.top <= cur.top + 4 : r.top >= cur.top - 4) return;
        const d = Math.abs(r.top - cur.top) * 4 + Math.abs(r.left - cur.left);
        if (d < bd) {
          bd = d;
          bi = i;
        }
      });
      if (bi >= 0) a.index = bi;
    } else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
      a.paint?.();
    }
  };
  a.onOutside = (e) => {
    if (assist === a && a.el && !a.el.contains(e.target)) endAssist(false);
  };
  await thumbs.captureAll().catch(() => {});
  if (assist !== a) return;
  thumbs.block(true);
  renderAssist();
  document.addEventListener('keydown', a.onKey, true);
  setTimeout(() => assist === a && document.addEventListener('pointerdown', a.onOutside, true));
}

// ------------------------------------------------------------------ top-of-screen bar while dragging
let bar = null; // { el, win, zone, layout }

function hideBar() {
  if (!bar) return;
  const b = bar;
  bar = null;
  wm.dragSnapOverride = null;
  b.el.classList.add('closing');
  setTimeout(() => b.el.remove(), 160);
}

function showBar(win) {
  const el = h('div', { class: 'snapl-bar' });
  const layouts = allLayouts();
  layouts.forEach((zones, i) => el.appendChild(layoutTile(zones, { index: i })));
  document.getElementById('overlays').appendChild(el);
  bar = { el, win, zone: null, layout: null, layouts };
}

function onDragMove(win, { x, y }) {
  if (!win.opts.resizable || assist || !opt('snap') || !opt('snapBar')) {
    if (bar) hideBar();
    return;
  }
  const wa = wm.workarea();
  const cx = wa.x + wa.width / 2;
  const near = y <= wa.y + 56 && y > wa.y + 2 && Math.abs(x - cx) < 300;
  if (!bar) {
    if (near) showBar(win);
    else return;
  }
  const br = bar.el.getBoundingClientRect();
  const inside = x >= br.left - 40 && x <= br.right + 40 && y <= br.bottom + 40;
  if (!inside && !near) return hideBar();
  let hit = null;
  for (const z of bar.el.querySelectorAll('.snapl-zone')) {
    const r = z.getBoundingClientRect();
    const on = x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    z.classList.toggle('hot', on);
    if (on) hit = z;
  }
  bar.zone = hit ? hit.dataset.zone : null;
  bar.layout = hit ? bar.layouts[Number(hit.dataset.layout)] : null;
  wm.dragSnapOverride = bar.zone;
}

let barLayout = null;

export function mount(ctx) {
  ui.loadCss('app://shell/core/features/snaplayouts.css');
  const applySettings = () => {
    wm.snapEnabled = opt('snap');
    wm.shakeToMinimize = opt('shake', false);
  };
  applySettings();
  settings.on('multitasking', applySettings);
  wm.on('max-hover', (win, btn) => {
    clearTimeout(hideTimer);
    if (!opt('snapLayouts') || !opt('snap')) return;
    if (fly?.win === win) return;
    clearTimeout(showTimer);
    if (document.body.classList.contains('wm-dragging')) return;
    showTimer = setTimeout(() => {
      if (btn.matches(':hover')) openFlyout(win, { anchor: btn });
    }, 450);
  });
  wm.on('max-leave', () => {
    clearTimeout(showTimer);
    if (fly && !fly.kb) {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        if (fly && !fly.el.matches(':hover')) hideFlyout();
      }, 320);
    }
  });
  // Clicking maximize while the flyout is up: just maximize.
  document.addEventListener(
    'click',
    (e) => {
      if (fly && fly.win.btnMax.contains(e.target)) hideFlyout();
    },
    true,
  );
  shell.on('snaplayouts:open', (win) => openFlyout(win || wm.focused(), { keyboard: true }));
  shell.on('flyouts:close', () => {
    hideFlyout();
    endAssist(false);
  });
  shell.on('lock', () => {
    hideFlyout();
    endAssist(false);
  });

  wm.on('drag-move', (win, p) => {
    onDragMove(win, p);
    barLayout = bar?.layout || null;
  });
  wm.on('drag-end', () => {
    hideBar();
    setTimeout(() => (barLayout = null));
  });
  wm.on('snap', (win, zone, { source } = {}) => {
    if (source === 'assist' || source === 'refit' || source === 'api' || source === 'border' || source === 'restore' || !opt('snapAssist')) return;
    let zones = null;
    if (source === 'layout' && pendingLayout?.includes(zone)) zones = pendingLayout.filter((z) => z !== zone);
    else if (source === 'drag' && barLayout?.includes(zone)) zones = barLayout.filter((z) => z !== zone);
    else if (source === 'keyboard') zones = zone === 'left' || zone === 'right' ? COMPLEMENT[zone] : null;
    else zones = COMPLEMENT[zone] || null;
    if (!zones?.length) return;
    const z = [...zones];
    setTimeout(() => {
      if (wm.get(win.id) && win.state === 'snapped' && win.snap === zone) startAssist(win, z);
    }, reduceMotion() ? 30 : 320);
  });
  wm.on('close', (w) => {
    if (assist && (assist.win === w || assist.cands?.includes(w))) {
      if (assist.win === w) endAssist(false);
      else setTimeout(renderAssist);
    }
  });
  wm.on('focus', (w) => {
    if (assist && w && !assist.group.has(w) && !assist.cands?.includes(w)) endAssist(false);
  });
  // Switching virtual desktops takes the windows these surfaces belong to off screen.
  wm.on('desktop', () => {
    hideFlyout();
    endAssist(false);
  });
  ctx.snap = {
    open: (win, o) => openFlyout(win || wm.focused(), o),
    close: hideFlyout,
    assist: startAssist,
    endAssist,
    layouts: LAYOUTS,
    allLayouts,
    shownLayouts,
    builtins: BUILTIN_LAYOUTS,
    get flyoutOpen() {
      return !!fly;
    },
    get assistOpen() {
      return !!assist;
    },
  };
}
