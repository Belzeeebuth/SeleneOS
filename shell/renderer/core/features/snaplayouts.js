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
//   multitasking.snapAssist    Snap Assist after snapping
//   multitasking.shake         title bar window shake (minimise the other windows)
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
  hideFlyout();
  if (!win || win._closing) return;
  pendingLayout = LAYOUTS[li];
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
  LAYOUTS.forEach((zones, i) =>
    grid.appendChild(
      layoutTile(zones, {
        index: i,
        numbered: keyboard,
        onZone: pick,
        onHover: (z, li) => {
          if (fly) {
            fly.sel = [li, LAYOUTS[li].indexOf(z)];
            paintSel();
          }
        },
      }),
    ),
  );
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
  fly = { win, el, kb: keyboard, sel: [0, 0], digits: null };
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
  const W = r.width - 12 - pad * 2;
  const H = r.height - 12 - pad * 2 - 28;
  const n = cands.length;
  let best = { tw: 0, cols: 1 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const cellW = (W - 12 * (cols - 1)) / cols;
    const cellH = (H - 12 * (rows - 1)) / rows - 30;
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
  const grid = h('div', { class: 'snapa-grid', style: { maxWidth: `${best.cols * (tw + 12) + (best.cols - 1) * 12}px` } }, cards);
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
  LAYOUTS.forEach((zones, i) => el.appendChild(layoutTile(zones, { index: i })));
  document.getElementById('overlays').appendChild(el);
  bar = { el, win, zone: null, layout: null };
}

function onDragMove(win, { x, y }) {
  if (!win.opts.resizable || assist || !opt('snap')) return;
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
  bar.layout = hit ? LAYOUTS[Number(hit.dataset.layout)] : null;
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
    if (source === 'assist' || source === 'refit' || source === 'api' || source === 'border' || !opt('snapAssist')) return;
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
  ctx.snap = {
    open: (win, o) => openFlyout(win || wm.focused(), o),
    close: hideFlyout,
    assist: startAssist,
    endAssist,
    layouts: LAYOUTS,
    get flyoutOpen() {
      return !!fly;
    },
    get assistOpen() {
      return !!assist;
    },
  };
}
