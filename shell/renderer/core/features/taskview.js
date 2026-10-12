// Task View (Super+Tab, taskbar button) and virtual desktops.
//   The REAL window elements are scaled/translated (CSS transform, no cloning, content stays live) into a
//   non-overlapping grid with icon + title UNDER each; click to switch (animated back), a small round
//   close button on hover, right-click for Snap / Move to desktop / Close; arrow keys + Enter / Delete,
//   Esc or Super+Tab exits.
//   Top strip: one card per desktop (live miniature of its windows, name under it, the current one
//   highlighted) and a discreet round "+" at the end. With a single desktop the strip is compact (72 px, no
//   divider): a small chip for the desktop and a "+ New desktop" button, and the windows hang just under it.
//   Hover a card to preview that desktop's windows, click to switch, click the name (or right-click) to rename inline, X to close it (its windows move to
//   the neighbour). Drag a window onto a desktop card (or the "+") to move it there.
//   Super+Ctrl+←/→ switch desktops (with a slide animation and a name pill), Super+Ctrl+D new desktop,
//   Super+Ctrl+F4 closes the current one. Desktop names persist in storage 'shell' / 'desktops'.
//   Shell bus: 'taskview:toggle' 'taskview:open' 'taskview:close'; closes itself on 'start:toggle',
//   'flyouts:close', 'lock'.   window.__aurora.taskview = { open, close, toggle, isOpen, layout }
import { api } from '../api.js';
import { h, icon, ui } from '../ui.js';
import { i18n, t } from '../i18n.js';
import { wm } from '../wm.js';
import { registry } from '../registry.js';
import { shell } from '../services.js';
import { thumbs } from './alttab.js';

i18n.extend({
  en: {
    taskview: {
      label: 'Overview',
      newDesktop: 'New desktop',
      closeDesktop: 'Close desktop',
      rename: 'Rename',
      moveTo: 'Move to',
      close: 'Close',
      snapLeft: 'Place on the left',
      snapRight: 'Place on the right',
      empty: 'No open windows on this desktop',
      desktops: 'Desktops',
    },
  },
  fr: {
    taskview: {
      label: "Vue d'ensemble",
      newDesktop: 'Nouveau bureau',
      closeDesktop: 'Fermer le bureau',
      rename: 'Renommer',
      moveTo: 'Déplacer vers',
      close: 'Fermer',
      snapLeft: 'Placer à gauche',
      snapRight: 'Placer à droite',
      empty: 'Aucune fenêtre ouverte sur ce bureau',
      desktops: 'Bureaux',
    },
  },
});

const DUR = 300;
const EASE = 'cubic-bezier(0.1, 0.9, 0.2, 1)';
const TITLE = 34; // room for the icon + title under each thumbnail
const STRIP_H = 156; // the desktops strip at the top
const SOLO_H = 72; // the same strip, compact, while there is only one desktop
const stripH = () => (wm.desktops.length > 1 ? STRIP_H : SOLO_H);
const reduceMotion = () => document.documentElement.dataset.animations === 'off';
const dur = () => (reduceMotion() ? 0 : DUR);

let tv = null;

// ------------------------------------------------------------------ layout
// Rows of equal-height thumbnails, centred; picks the row count that gives the largest thumbnails.
export function computeLayout(items, area, { gapX = 28, gapY = 24, title = TITLE, maxScale = 0.72, valign = 0.5 } = {}) {
  const n = items.length;
  if (!n) return new Map();
  let best = null;
  let tiny = null; // best layout whose thumbnails are under 24 px (only used when nothing better fits)
  for (let rows = 1; rows <= Math.min(n, 12); rows++) {
    const per = Math.ceil(n / rows);
    const rowsArr = [];
    for (let i = 0; i < n; i += per) rowsArr.push(items.slice(i, i + per));
    const fits = (th) =>
      rowsArr.every((r) => r.reduce((a, it) => a + Math.min(th, it.h * maxScale) * (it.w / it.h), 0) <= area.width - gapX * (r.length - 1));
    let hi = Math.min((area.height - gapY * (rowsArr.length - 1)) / rowsArr.length - title, area.height * 0.62);
    let lo = 0;
    if (fits(hi)) lo = hi;
    else for (let k = 0; k < 24; k++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) lo = mid;
      else hi = mid;
    }
    const th = lo;
    if (th <= 1) continue;
    const sizes = rowsArr.map((r) => r.map((it) => {
      const ih = Math.min(th, it.h * maxScale);
      return { id: it.id, iw: ih * (it.w / it.h), ih };
    }));
    const area2 = sizes.flat().reduce((a, s) => a + s.iw * s.ih, 0);
    if (th < 24) {
      if (!tiny || area2 > tiny.score) tiny = { score: area2, sizes, th };
      continue;
    }
    if (!best || area2 > best.score * 1.02) best = { score: area2, sizes, th };
  }
  best = best || tiny;
  if (!best) return new Map();
  const out = new Map();
  const rowHs = best.sizes.map((r) => Math.max(...r.map((s) => s.ih)) + title);
  const totalH = rowHs.reduce((a, b) => a + b, 0) + gapY * (rowHs.length - 1);
  let y = area.y + Math.max(0, (area.height - totalH) * valign);
  best.sizes.forEach((r, ri) => {
    const rowW = r.reduce((a, s) => a + s.iw, 0) + gapX * (r.length - 1);
    let x = area.x + (area.width - rowW) / 2;
    const maxIh = rowHs[ri] - title;
    for (const s of r) {
      // Thumbnails share the row's bottom line; the title sits under each one.
      out.set(s.id, { x: Math.round(x), y: Math.round(y + (maxIh - s.ih)), width: Math.round(s.iw), height: Math.round(s.ih) });
      x += s.iw + gapX;
    }
    y += rowHs[ri] + gapY;
  });
  return out;
}

function elementBox(win) {
  if (win.fullscreen) return { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
  return { x: win.x, y: win.y, width: win.w, height: win.h };
}

function gridArea() {
  const L = wm.layer.getBoundingClientRect();
  const top = stripH() + (wm.desktops.length > 1 ? 28 : 12);
  return { x: 56, y: top, width: L.width - 112, height: L.height - top - 32 };
}

// ------------------------------------------------------------------ desktops strip
function deskThumb(id) {
  const L = wm.layer.getBoundingClientRect();
  const box = h('div', { class: 'tv-desk-thumb', style: { aspectRatio: String(L.width / Math.max(1, L.height)) } });
  const k = 1 / Math.max(1, L.width);
  const wins = wm
    .listDesktop(id)
    .filter((w) => !w.minimized && !w._closing)
    .sort((a, b) => Number(a.el.style.zIndex || 0) - Number(b.el.style.zIndex || 0));
  for (const w of wins) {
    const b = elementBox(w);
    const bmp = thumbs.get(w);
    const pic = bmp && Math.abs(bmp.width / bmp.height - b.width / b.height) < 0.04 ? miniCanvas(bmp, (b.width * k * 192) | 0) : null;
    box.appendChild(
      h(
        'div',
        {
          class: ['tv-mini', pic && 'pic'],
          style: {
            left: `${b.x * k * 100}%`,
            top: `${(b.y / L.height) * 100}%`,
            width: `${b.width * k * 100}%`,
            height: `${(b.height / L.height) * 100}%`,
          },
        },
        pic || h('img', { src: w.iconUrl || registry.iconUrl(w.appId), alt: '', draggable: false }),
      ),
    );
  }
  return box;
}

// A small canvas with a window's last screen capture (desktop tile miniatures).
function miniCanvas(bmp, cssW) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.min(bmp.width, Math.round(Math.max(8, cssW) * dpr)));
  const c = h('canvas', { class: 'tv-mini-img' });
  c.width = w;
  c.height = Math.max(1, Math.round((w * bmp.height) / bmp.width));
  try {
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  } catch {
    return null;
  }
  return c;
}

function renderStrip() {
  if (!tv) return;
  // Never rebuild under an open rename box (a hover preview or a window event would destroy it).
  if (tv.strip.querySelector('.tv-rename')) {
    tv.stripDirty = true;
    return;
  }
  tv.stripDirty = false;
  const desks = wm.desktops.map((d, i) => {
    const current = d.id === wm.currentDesktop;
    const name = h('span', { class: 'tv-desk-name ellipsis' }, wm.desktopName(d.id));
    const tile = h(
      'div',
      {
        class: ['tv-desk', current && 'current', tv.shown === d.id && 'shown', tv.sel?.area === 'desks' && tv.sel.index === i && 'sel'],
        role: 'button',
        tabindex: '-1',
        'aria-label': wm.desktopName(d.id),
        dataset: { desk: d.id },
        onclick: (e) => {
          if (e.target.closest('.tv-desk-x, input, .tv-desk-name')) return;
          exit(null, { desktop: d.id });
        },
        onpointerenter: () => {
          clearTimeout(tv?.previewTimer);
          if (tv && !tv.drag) tv.previewTimer = setTimeout(() => preview(d.id), 260);
        },
        oncontextmenu: (e) => deskMenu(e, d.id, name),
      },
      h(
        'div',
        { class: 'tv-desk-pic' },
        deskThumb(d.id),
        wm.desktops.length > 1
          ? h(
              'button',
              {
                class: 'tv-desk-x',
                'aria-label': t('taskview.closeDesktop'),
                'data-tip': t('taskview.closeDesktop'),
                tabindex: '-1',
                onclick: (e) => {
                  e.stopPropagation();
                  wm.removeDesktop(d.id, { animate: false });
                },
              },
              icon('x', { size: 12 }),
            )
          : null,
      ),
      h('div', { class: 'tv-desk-head' }, name),
    );
    // Clicking the name renames it inline; clicking the picture switches.
    name.title = t('taskview.rename');
    name.addEventListener('click', (e) => {
      e.stopPropagation();
      renameInline(d.id, name);
    });
    return tile;
  });
  const add = h(
    'div',
    {
      class: ['tv-desk', 'tv-new', tv.sel?.area === 'desks' && tv.sel.index === wm.desktops.length && 'sel'],
      role: 'button',
      tabindex: '-1',
      'aria-label': t('taskview.newDesktop'),
      'data-tip': t('taskview.newDesktop'),
      dataset: { desk: '__new' },
      onclick: () => {
        wm.createDesktop();
      },
    },
    // With one desktop the strip is compact and the button says what it does.
    h('span', { class: 'tv-new-btn', 'aria-hidden': 'true' }, icon('plus', { size: 18 }), h('span', { class: 'tv-new-label' }, t('taskview.newDesktop'))),
  );
  tv.strip.classList.toggle('solo', wm.desktops.length < 2);
  tv.strip.replaceChildren(h('div', { class: 'tv-desks', role: 'list', 'aria-label': t('taskview.desktops') }, desks, add));
}

function renameInline(id, nameEl) {
  if (!tv) return;
  const input = h('input', { class: 'input tv-rename', value: wm.desktopName(id), spellcheck: false, maxlength: 60, 'aria-label': t('taskview.rename') });
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    input.remove();
    if (commit) wm.renameDesktop(id, input.value);
    if (tv && (!commit || tv.stripDirty)) renderStrip();
    tv?.root.focus({ preventScroll: true });
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('pointerdown', (e) => e.stopPropagation());
  nameEl.replaceWith(input);
  input.focus();
  input.select();
}

function deskMenu(e, id, nameEl) {
  ui.menu(e, [
    { label: t('taskview.rename'), icon: 'rename', action: () => renameInline(id, nameEl) },
    { label: t('taskview.closeDesktop'), icon: 'dismiss', disabled: wm.desktops.length < 2, action: () => wm.removeDesktop(id, { animate: false }) },
  ]);
}

// ------------------------------------------------------------------ cards
function cardMenu(e, win) {
  const others = wm.desktops.filter((d) => d.id !== win.desktop);
  ui.menu(e, [
    { label: t('taskview.snapLeft'), icon: 'layout_column_two_focus_left', disabled: !win.opts.resizable, action: () => exit(win, { then: () => win.snapTo('left', { source: 'keyboard' }) }) },
    { label: t('taskview.snapRight'), icon: 'layout_column_two_focus_right', disabled: !win.opts.resizable, action: () => exit(win, { then: () => win.snapTo('right', { source: 'keyboard' }) }) },
    '-',
    {
      label: t('taskview.moveTo'),
      icon: 'window_arrow_up',
      submenu: [
        ...others.map((d) => ({ label: wm.desktopName(d.id), action: () => moveWin(win, d.id) })),
        { label: t('taskview.newDesktop'), icon: 'add', action: () => moveWin(win, wm.createDesktop().id) },
      ],
    },
    '-',
    { label: t('taskview.close'), icon: 'dismiss', action: () => closeWin(win) },
  ]);
}

function moveWin(win, deskId) {
  if (!tv) return;
  const from = win.desktop;
  win.el.classList.add('tv-out');
  setTimeout(() => {
    wm.moveToDesktop(win, deskId);
    if (tv && deskId !== tv.shown) {
      win.el.classList.remove('tv-win');
      win.el.classList.remove('tv-out');
    }
    if (from !== deskId) layout();
  }, dur() ? 160 : 0);
}

async function closeWin(win) {
  if (!tv) return;
  if (win._beforeClose.length) {
    // The app may ask something (unsaved changes): leave Task View and let it.
    exit(win, { then: () => win.close() });
    return;
  }
  win.el.classList.add('tv-out');
  tv.cards.get(win.id)?.card.classList.add('closing');
  setTimeout(() => win.close(), dur() ? 150 : 0);
}

function buildCard(win) {
  const titleEl = h('span', { class: 'tv-title ellipsis' }, win.title || registry.name(win.appId));
  const card = h(
    'div',
    {
      class: 'tv-card',
      role: 'option',
      'aria-label': win.title || registry.name(win.appId),
      dataset: { id: win.id },
      oncontextmenu: (e) => cardMenu(e, win),
    },
    h('div', { class: 'tv-hit' }),
    h(
      'button',
      {
        class: 'tv-x',
        tabindex: '-1',
        'aria-label': t('taskview.close'),
        'data-tip': t('taskview.close'),
        onpointerdown: (e) => e.stopPropagation(),
        onclick: (e) => {
          e.stopPropagation();
          closeWin(win);
        },
      },
      icon('x', { size: 12 }),
    ),
    h('div', { class: 'tv-head' }, h('img', { class: 'tv-icon', src: win.iconUrl || registry.iconUrl(win.appId), alt: '', draggable: false }), titleEl),
  );
  const plate = h('div', { class: 'tv-plate' });
  card.addEventListener('pointerenter', () => plate.classList.add('hover'));
  card.addEventListener('pointerleave', () => plate.classList.remove('hover'));
  card.addEventListener('pointerdown', (e) => {
    if (e.button === 0 && !e.target.closest('.tv-x')) startCardDrag(e, win, card);
  });
  card.addEventListener('click', (e) => {
    if (e.target.closest('.tv-x') || tv?.justDragged) return;
    exit(win);
  });
  return { card, plate, titleEl };
}

// Place every window of the shown desktop; windows of other desktops fade out in place.
function layout({ instant = false, appear = false } = {}) {
  if (!tv) return;
  const shownWins = wm.mru({ desktop: tv.shown }).filter((w) => !w._closing).reverse();
  // Keep a stable, Windows-like order: by creation time.
  shownWins.sort((a, b) => a.createdAt - b.createdAt);
  const items = shownWins.map((w) => {
    const b = elementBox(w);
    return { id: w.id, w: b.width, h: b.height };
  });
  // One desktop: the spare height goes mostly under the windows, so they hang close to the compact strip.
  const rects = computeLayout(items, gridArea(), { valign: wm.desktops.length > 1 ? 0.5 : 0.3 });
  const d = instant ? 0 : dur();
  const alive = new Set();
  for (const w of shownWins) {
    const r = rects.get(w.id);
    if (!r) continue;
    alive.add(w.id);
    let c = tv.cards.get(w.id);
    if (!c) {
      c = buildCard(w);
      tv.cards.set(w.id, c);
      tv.cardsLayer.appendChild(c.card);
      tv.plates.appendChild(c.plate);
    }
    c.titleEl.textContent = w.title || registry.name(w.appId);
    const b = elementBox(w);
    const s = r.width / b.width;
    c.target = { tx: r.x, ty: r.y, s, ex: b.x, ey: b.y, r };
    const el = w.el;
    const fresh = !el.classList.contains('tv-win');
    el.classList.add('tv-win');
    el.classList.remove('tv-out');
    el.style.transformOrigin = '0 0';
    const T = `translate(${r.x - b.x}px, ${r.y - b.y}px) scale(${s})`;
    if (fresh && (appear || w.minimized || w.desktop !== wm.currentDesktop) && d) {
      // Not on screen before: appear in place with a fade/zoom.
      el.style.transition = 'none';
      el.style.opacity = '0';
      el.style.transform = `translate(${r.x - b.x + r.width * 0.04}px, ${r.y - b.y + r.height * 0.04}px) scale(${s * 0.92})`;
      el.getBoundingClientRect();
    }
    el.style.transition = d ? `transform ${d}ms ${EASE}, opacity ${Math.round(d * 0.6)}ms linear` : 'none';
    el.style.transform = T;
    el.style.opacity = '';
    const pad = 8;
    const box = { left: r.x - pad, top: r.y - pad, width: r.width + pad * 2, height: r.height + pad + TITLE };
    for (const node of [c.card, c.plate]) {
      Object.assign(node.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });
    }
  }
  // Remove cards for windows no longer shown.
  for (const [id, c] of tv.cards) {
    if (alive.has(id)) continue;
    c.card.remove();
    c.plate.remove();
    tv.cards.delete(id);
    const w = wm.get(id);
    if (w && w.el.classList.contains('tv-win')) {
      w.el.classList.add('tv-out');
      const el = w.el;
      setTimeout(() => {
        if (tv && !tv.cards.has(id)) el.classList.remove('tv-win');
      }, d ? 200 : 0);
    }
  }
  tv.order = shownWins.filter((w) => alive.has(w.id));
  tv.empty.hidden = tv.order.length > 0;
  if (tv.sel?.area === 'cards') tv.sel.index = Math.min(tv.sel.index, Math.max(0, tv.order.length - 1));
  paintSel();
  renderStrip();
}

function preview(deskId) {
  if (!tv || tv.shown === deskId || tv.exiting || tv.drag) return;
  tv.shown = deskId;
  layout();
}

function paintSel() {
  if (!tv) return;
  tv.order?.forEach((w, i) => {
    const c = tv.cards.get(w.id);
    const on = tv.sel?.area === 'cards' && tv.sel.index === i;
    c?.plate.classList.toggle('sel', on);
    c?.card.classList.toggle('sel', on);
  });
  for (const [i, el] of [...tv.strip.querySelectorAll('.tv-desk')].entries()) el.classList.toggle('sel', tv.sel?.area === 'desks' && tv.sel.index === i);
}

// ------------------------------------------------------------------ drag a card onto a desktop
function startCardDrag(e, win, card) {
  const c = tv.cards.get(win.id);
  if (!c?.target) return;
  const sx = e.clientX;
  const sy = e.clientY;
  const base = c.target;
  let dragging = false;
  let over = null;
  card.setPointerCapture?.(e.pointerId);
  const stripBottom = tv.strip.getBoundingClientRect().bottom;
  const move = (ev) => {
    const dx = ev.clientX - sx;
    const dy = ev.clientY - sy;
    if (!dragging) {
      if (Math.hypot(dx, dy) < 8) return;
      dragging = true;
      tv.drag = win;
      clearTimeout(tv.previewTimer);
      tv.root.classList.add('dragging');
      card.classList.add('dragging');
      c.plate.classList.add('hide');
      win.el.style.transition = 'transform 90ms linear';
      win.el.style.zIndex = String(Number(win.el.style.zIndex || 0) + 1000000);
    }
    const small = ev.clientY < stripBottom + 30;
    const s = small ? Math.min(base.s, 150 / Math.max(1, elementBox(win).width)) : base.s;
    const gx = (sx - base.tx) / base.s;
    const gy = (sy - base.ty) / base.s;
    win.el.style.transform = `translate(${ev.clientX - gx * s - base.ex}px, ${ev.clientY - gy * s - base.ey}px) scale(${s})`;
    over = null;
    for (const tile of tv.strip.querySelectorAll('.tv-desk')) {
      const r = tile.getBoundingClientRect();
      const hit = ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
      tile.classList.toggle('drop', hit && tile.dataset.desk !== win.desktop);
      if (hit) over = tile.dataset.desk;
    }
  };
  const up = () => {
    card.removeEventListener('pointermove', move);
    card.removeEventListener('pointerup', up);
    card.removeEventListener('pointercancel', up);
    if (!dragging || !tv) return;
    tv.justDragged = true;
    setTimeout(() => tv && (tv.justDragged = false), 0);
    tv.drag = null;
    tv.root.classList.remove('dragging');
    card.classList.remove('dragging');
    c.plate.classList.remove('hide');
    for (const tile of tv.strip.querySelectorAll('.tv-desk.drop')) tile.classList.remove('drop');
    win.el.style.zIndex = String(Number(win.el.style.zIndex || 0) - 1000000);
    if (over && over !== win.desktop) {
      const target = over === '__new' ? wm.createDesktop().id : over;
      moveWin(win, target);
    } else {
      win.el.style.transition = `transform ${dur()}ms ${EASE}`;
      win.el.style.transform = `translate(${base.tx - base.ex}px, ${base.ty - base.ey}px) scale(${base.s})`;
    }
  };
  card.addEventListener('pointermove', move);
  card.addEventListener('pointerup', up);
  card.addEventListener('pointercancel', up);
}

// ------------------------------------------------------------------ keyboard
function moveSel(dx, dy) {
  if (!tv) return;
  const sel = tv.sel || { area: 'cards', index: 0 };
  if (sel.area === 'cards' && tv.order.length) {
    if (dx) sel.index = (sel.index + dx + tv.order.length) % tv.order.length;
    else if (dy) {
      const cur = tv.cards.get(tv.order[sel.index].id).target.r;
      let bi = -1;
      let bd = Infinity;
      tv.order.forEach((w, i) => {
        const r = tv.cards.get(w.id).target.r;
        if (dy > 0 ? r.y <= cur.y + 4 : r.y >= cur.y - 4) return;
        const d = Math.abs(r.y - cur.y) * 4 + Math.abs(r.x + r.width / 2 - (cur.x + cur.width / 2));
        if (d < bd) {
          bd = d;
          bi = i;
        }
      });
      if (bi >= 0) sel.index = bi;
      else if (dy < 0) {
        sel.area = 'desks';
        sel.index = Math.max(0, wm.desktopIndex(tv.shown));
      }
    }
  } else if (sel.area === 'desks') {
    const n = wm.desktops.length + 1;
    if (dx) sel.index = (sel.index + dx + n) % n;
    if (dy > 0 && tv.order.length) {
      sel.area = 'cards';
      sel.index = 0;
    }
  } else if (!tv.order.length) {
    sel.area = 'desks';
    sel.index = 0;
  }
  tv.sel = sel;
  if (sel.area === 'desks' && sel.index < wm.desktops.length) preview(wm.desktops[sel.index].id);
  paintSel();
}

function onKey(e) {
  if (!tv || e.target.closest?.('.tv-rename')) return;
  if (document.querySelector('body > .menu')) return;
  const k = e.key;
  let handled = true;
  if (k === 'Escape') exit(null);
  else if (k === 'ArrowRight') moveSel(1, 0);
  else if (k === 'ArrowLeft') moveSel(-1, 0);
  else if (k === 'ArrowDown') moveSel(0, 1);
  else if (k === 'ArrowUp') moveSel(0, -1);
  else if (k === 'Tab') {
    const s = tv.sel || { area: 'cards', index: 0 };
    tv.sel = s.area === 'cards' ? { area: 'desks', index: Math.max(0, wm.desktopIndex(tv.shown)) } : { area: 'cards', index: 0 };
    paintSel();
  } else if (k === 'Enter' || k === ' ') {
    const s = tv.sel;
    if (s?.area === 'cards' && tv.order[s.index]) exit(tv.order[s.index]);
    else if (s?.area === 'desks') {
      if (s.index < wm.desktops.length) exit(null, { desktop: wm.desktops[s.index].id });
      else wm.createDesktop();
    }
  } else if (k === 'Delete') {
    const s = tv.sel;
    if (s?.area === 'cards' && tv.order[s.index]) closeWin(tv.order[s.index]);
  } else if (k === 'F2') {
    const s = tv.sel;
    if (s?.area === 'desks' && s.index < wm.desktops.length) {
      const name = tv.strip.querySelectorAll('.tv-desk')[s.index]?.querySelector('.tv-desk-name');
      if (name) renameInline(wm.desktops[s.index].id, name);
    }
  } else handled = false;
  if (handled) {
    e.preventDefault();
    e.stopPropagation();
  }
}

// ------------------------------------------------------------------ open / exit
export function open() {
  if (tv || !wm.layer) return;
  shell.emit('start:close');
  shell.emit('flyouts:close');
  ui.closeMenus();
  wm.endKeyboardMove?.();
  const plates = h('div', { class: 'tv-plates' });
  const backdrop = h('div', { class: 'tv-backdrop', onclick: () => exit(null) }, plates);
  const cardsLayer = h('div', { class: 'tv-cards' });
  const strip = h('div', { class: 'tv-strip', onpointerleave: () => {
    clearTimeout(tv?.previewTimer);
    if (tv && !tv.drag) tv.previewTimer = setTimeout(() => preview(wm.currentDesktop), 260);
  } });
  const empty = h('div', { class: 'tv-empty', hidden: true }, t('taskview.empty'));
  const root = h(
    'div',
    {
      class: 'tv-chrome wm-keep-focus',
      role: 'listbox',
      'aria-label': t('taskview.label'),
      tabindex: '-1',
      onclick: (e) => {
        if (e.target === root || e.target === cardsLayer) exit(null);
      },
    },
    strip,
    cardsLayer,
    empty,
  );
  tv = { root, backdrop, plates, cardsLayer, strip, empty, cards: new Map(), shown: wm.currentDesktop, order: [], sel: null, prevFocus: wm.focused(), exiting: false };
  document.body.classList.add('tv-on');
  document.querySelector('#taskbar .tb-taskview')?.classList.add('open');
  wm.layer.append(backdrop, root);
  const f = wm.focused();
  layout();
  const fi = f ? tv.order.indexOf(f) : -1;
  if (tv.order.length) tv.sel = { area: 'cards', index: fi >= 0 ? fi : 0 };
  paintSel();
  document.addEventListener('keydown', onKey, true);
  root.focus({ preventScroll: true });
  shell.emit('taskview:opened');
}

export function exit(selected = null, { desktop = null, then = null, instant = false } = {}) {
  if (!tv || tv.exiting) return;
  tv.exiting = true;
  const s = tv;
  clearTimeout(s.previewTimer);
  document.removeEventListener('keydown', onKey, true);
  const target = desktop || selected?.desktop || wm.currentDesktop;
  // Show the target desktop's windows before animating back.
  if (s.shown !== target) {
    s.shown = target;
    s.exiting = false;
    layout({ instant: true });
    s.exiting = true;
    void document.body.offsetWidth; // flush so the way back is animated
  }
  if (target !== wm.currentDesktop) wm.switchDesktop(target, { animate: false, focus: selected });
  const d = instant ? 0 : dur();
  for (const [id] of s.cards) {
    const w = wm.get(id);
    if (!w) continue;
    const el = w.el;
    el.style.transition = d ? `transform ${d}ms ${EASE}, opacity ${Math.round(d * 0.6)}ms linear` : 'none';
    if (w.minimized && w !== selected) {
      el.style.opacity = '0'; // fades out where it is, then hides again
    } else {
      if (w === selected && w.minimized) w.restoreFromMinimize({ animate: false });
      el.style.transform = 'none';
      el.style.opacity = '';
    }
  }
  if (selected && wm.get(selected.id)) selected.focus();
  else if (s.prevFocus && wm.get(s.prevFocus.id) && s.prevFocus.desktop === wm.currentDesktop && !s.prevFocus.minimized) s.prevFocus.focus();
  s.root.classList.add('closing');
  s.backdrop.classList.add('closing');
  document.querySelector('#taskbar .tb-taskview')?.classList.remove('open');
  const cleanup = () => {
    for (const w of wm.list()) {
      if (!w.el.classList.contains('tv-win') && !w.el.classList.contains('tv-out')) continue;
      w.el.classList.remove('tv-win', 'tv-out');
      Object.assign(w.el.style, { transition: '', transform: '', transformOrigin: '', opacity: '' });
    }
    s.root.remove();
    s.backdrop.remove();
    document.body.classList.remove('tv-on');
    wm.focused()?.focusContent(); // the chrome had the keyboard; hand it back to the active window
    if (tv === s) tv = null;
    try {
      then?.();
    } catch (err) {
      console.error(err);
    }
    shell.emit('taskview:closed');
    if (s.reopen && !tv) open();
  };
  if (d) setTimeout(cleanup, d + 20);
  else cleanup();
}

export function toggle() {
  if (tv && !tv.exiting) exit(null);
  else if (tv) tv.reopen = !tv.reopen; // pressed again while the exit animation runs: come back after it
  else open();
}

export function isOpen() {
  return !!tv && !tv.exiting;
}

// ------------------------------------------------------------------ desktop switch pill
let pill = null;
let pillTimer = 0;
function showPill(bump = 0) {
  if (tv) return;
  clearTimeout(pillTimer);
  if (!pill) {
    pill = h('div', { class: 'tv-pill', role: 'status', 'aria-live': 'polite' });
    document.getElementById('overlays').appendChild(pill);
  }
  const i = wm.desktopIndex(wm.currentDesktop);
  pill.replaceChildren(
    h('div', { class: 'tv-pill-dots' }, wm.desktops.map((d, j) => h('span', { class: j === i ? 'on' : '' }))),
    h('span', { class: 'tv-pill-name' }, wm.desktopName(wm.currentDesktop)),
  );
  pill.classList.remove('hide', 'bump-l', 'bump-r');
  void pill.offsetWidth;
  if (bump) pill.classList.add(bump < 0 ? 'bump-l' : 'bump-r');
  pillTimer = setTimeout(() => {
    pill?.classList.add('hide');
    const p = pill;
    pillTimer = setTimeout(() => {
      if (p === pill) {
        p.remove();
        pill = null;
      }
    }, 300);
  }, 1300);
}

// ------------------------------------------------------------------ persistence
let saveTimer = 0;
function saveDesktops() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    api.invoke('storage:set', 'shell', 'desktops', wm.desktops.map((d) => ({ name: d.name }))).catch(() => {});
  }, 300);
}

async function restoreDesktops() {
  try {
    const saved = await api.invoke('storage:get', 'shell', 'desktops', null);
    if (!Array.isArray(saved) || !saved.length) return;
    wm.renameDesktop(wm.desktops[0].id, saved[0]?.name);
    for (const d of saved.slice(1, 20)) wm.createDesktop(d?.name);
  } catch {}
}

export function mount(ctx) {
  ui.loadCss('app://shell/core/features/taskview.css');
  shell.on('taskview:toggle', toggle);
  shell.on('taskview:open', open);
  shell.on('taskview:close', () => exit(null));
  shell.on('start:toggle', () => tv && exit(null, { instant: true }));
  shell.on('flyouts:close', () => tv && exit(null));
  shell.on('lock', () => tv && exit(null, { instant: true }));
  shell.on('desktop:bump', (d) => showPill(d));
  wm.on('desktop', () => {
    if (tv && !tv.exiting) {
      // Super+Ctrl+←/→ / Super+Ctrl+D inside Task View: show the newly active desktop.
      clearTimeout(tv.previewTimer);
      tv.shown = wm.currentDesktop;
      tv.sel = tv.sel?.area === 'desks' ? { area: 'desks', index: wm.desktopIndex(wm.currentDesktop) } : null;
      layout({ appear: true });
      if (!tv.sel && tv.order.length) tv.sel = { area: 'cards', index: Math.max(0, tv.order.indexOf(wm.focused())) };
      paintSel();
    } else showPill();
  });
  wm.on('desktops', () => {
    saveDesktops();
    if (tv) {
      if (!wm.desktops.some((d) => d.id === tv.shown)) tv.shown = wm.currentDesktop;
      layout();
    }
  });
  const relayout = () => {
    if (tv && !tv.exiting && !tv.drag) {
      clearTimeout(tv.relayoutTimer);
      tv.relayoutTimer = setTimeout(() => tv && !tv.exiting && layout(), 0);
    }
  };
  wm.on('open', relayout);
  wm.on('close', relayout);
  wm.on('change', (w) => {
    if (!tv || !w) return;
    const c = tv.cards.get(w.id);
    if (c) c.titleEl.textContent = w.title || registry.name(w.appId);
  });
  window.addEventListener('resize', relayout);
  restoreDesktops();
  ctx.taskview = {
    open,
    close: () => exit(null),
    exit,
    toggle,
    computeLayout,
    get isOpen() {
      return !!tv;
    },
    get state() {
      return tv;
    },
  };
}
