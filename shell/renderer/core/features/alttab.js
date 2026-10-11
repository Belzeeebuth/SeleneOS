// Alt+Tab window switcher (Windows 11 style) + the window thumbnail service shared with Snap Assist.
//
//   Hotkeys (wired in features/hotkeys.js): Alt+Tab / Alt+Shift+Tab cycle, releasing Alt switches,
//   Ctrl+Alt+Tab opens a "sticky" switcher that stays open after Alt is released.
//   Inside the switcher: Tab / Shift+Tab / arrow keys move, Enter or Space switches, Esc cancels,
//   Delete closes the selected window, clicking a card switches, the X on a card closes that window.
//   A quick Alt+Tab tap (released before the panel appears) switches straight to the previous window.
//
//   export alttab = { open(dir, {sticky}), step(dir), commit(), cancel(), altUp(), get isOpen }
//   export thumbs = {
//     captureAll()          -> Promise; one screenshot of the shell, cropped into a thumbnail for every
//                              window that is fully visible (not covered by another window / flyout)
//     get(win)              -> cached ImageBitmap | null
//     node(win, w, h)       -> element fitted in w x h: a fresh screen crop, else a live (inert) copy of the
//                              window's DOM, else an older crop, else an app-icon placeholder
//   }
// Screen crops come from api.invoke('shell:capture'): the focused window is re-captured shortly after it
// gets focus (when nothing covers it), and every fully visible window when the switcher opens. Covered
// or minimised windows use the DOM copy (input values and canvas pixels copied; windows showing web
// content or video keep their last crop instead, since <webview>s cannot be copied).
import { api } from '../api.js';
import { h, icon, ui } from '../ui.js';
import { i18n, t } from '../i18n.js';
import { wm } from '../wm.js';
import { registry } from '../registry.js';
import { shell } from '../services.js';

i18n.extend({
  en: { alttab: { label: 'Window switcher', closeWindow: 'Close window' } },
  fr: { alttab: { label: 'Sélecteur de fenêtres', closeWindow: 'Fermer la fenêtre' } },
});

// ------------------------------------------------------------------ thumbnails
const cache = new Map(); // winId -> { bmp, w, h, at }
const MAX_THUMB_W = 480;
let captureGen = 0;
let lastAllAt = 0; // when the last full-screen capture started (crops newer than this are "fresh")
let captureBlocked = false; // set while our own UI is on screen (it must never end up in a thumbnail)
let captureAvailable = true;

function blockers() {
  // Shell surfaces drawn above windows that would pollute a crop.
  const sel = ['#start.open', '#flyouts > *', '#toasts > *', 'body > .menu', '#overlays > *', '.snap-preview.show', '.tooltip'];
  const out = [];
  for (const el of document.querySelectorAll(sel.join(','))) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
    out.push(r);
  }
  return out;
}

function intersects(a, b) {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

function visibleRect(win) {
  if (win.minimized || win._closing || !win.isOnCurrentDesktop() || !win.el.isConnected) return null;
  if (win.xwin != null) return null; // external X11 window: the shell's pixels hold no content (icon placeholder instead)
  if (document.body.classList.contains('tv-on')) return null; // Task View has the windows scaled
  if (win.el.getAnimations().length) return null; // mid open/minimize/snap animation
  const r = win.el.getBoundingClientRect();
  if (r.width < 40 || r.height < 30) return null;
  const z = Number(win.el.style.zIndex || 0);
  for (const o of wm.listDesktop()) {
    if (o === win || o.minimized || o._closing) continue;
    if (Number(o.el.style.zIndex || 0) > z && intersects(r, o.el.getBoundingClientRect())) return null;
  }
  for (const b of blockers()) if (intersects(r, b)) return null;
  return r;
}

async function grab(rect) {
  if (!captureAvailable) return null;
  try {
    const bytes = await api.invoke('shell:capture', rect || undefined);
    return await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  } catch (err) {
    if (err?.code === 'ENOHANDLER') captureAvailable = false;
    return null;
  }
}

async function store(win, source, sx, sy, sw, sh) {
  const scale = Math.min(1, MAX_THUMB_W / sw);
  const w = Math.max(1, Math.round(sw * scale));
  const hh = Math.max(1, Math.round(sh * scale));
  try {
    const bmp = await createImageBitmap(source, Math.round(sx), Math.round(sy), Math.round(sw), Math.round(sh), { resizeWidth: w, resizeHeight: hh, resizeQuality: 'medium' });
    cache.get(win.id)?.bmp.close?.();
    cache.set(win.id, { bmp, w, h: hh, at: Date.now() });
  } catch {}
}

export const thumbs = {
  get(win) {
    return cache.get(win.id)?.bmp || null;
  },
  async captureAll() {
    if (captureBlocked) return;
    const gen = ++captureGen;
    lastAllAt = Date.now();
    const targets = wm.listDesktop().map((w) => [w, visibleRect(w)]).filter(([, r]) => r);
    if (!targets.length) return;
    const shot = await grab(null);
    if (!shot || gen !== captureGen || captureBlocked) {
      shot?.close?.();
      return;
    }
    const k = shot.width / window.innerWidth;
    await Promise.all(targets.map(([w, r]) => store(w, shot, r.left * k, r.top * k, r.width * k, r.height * k)));
    shot.close?.();
  },
  async captureOne(win) {
    if (captureBlocked) return;
    const r = visibleRect(win);
    if (!r) return;
    const gen = ++captureGen;
    const bmp = await grab({ x: r.left, y: r.top, width: r.width, height: r.height });
    if (!bmp) return;
    if (gen === captureGen && !captureBlocked && visibleRect(win)) await store(win, bmp, 0, 0, bmp.width, bmp.height);
    bmp.close?.();
  },
  // Thumbnail element for `win`, fitted into w x h CSS pixels. Preference: a crop taken just now (window
  // fully visible) > a live DOM copy (not for windows showing web content / video) > an older crop >
  // an app-icon placeholder.
  node(win, w, hgt) {
    const c = cache.get(win.id);
    const fresh = c && c.at >= lastAllAt - 50;
    if (!fresh && !hasEmbedded(win)) {
      const live = cloneThumb(win, w, hgt);
      if (live) return live;
    }
    if (c) {
      // Letterbox (contain) the capture into the box.
      const k = Math.min(w / c.w, hgt / c.h);
      const cw = Math.max(1, Math.round(c.w * k));
      const ch = Math.max(1, Math.round(c.h * k));
      const dpr = window.devicePixelRatio || 1;
      const canvas = h('canvas', { class: 'wthumb-img', style: { width: `${cw}px`, height: `${ch}px` } });
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
      canvas.getContext('2d').drawImage(c.bmp, 0, 0, canvas.width, canvas.height);
      return h('div', { class: 'wthumb-fit', style: { width: `${w}px`, height: `${hgt}px` } }, canvas);
    }
    return h(
      'div',
      { class: 'wthumb-ph', style: { width: `${w}px`, height: `${hgt}px` } },
      h('img', { src: win.iconUrl || registry.iconUrl(win.appId), alt: '', draggable: false }),
    );
  },
  block(on) {
    captureBlocked = !!on;
    if (on) captureGen++;
  },
  drop(win) {
    cache.get(win.id)?.bmp.close?.();
    cache.delete(win.id);
  },
};

function hasEmbedded(win) {
  return !!win.el.querySelector('webview, iframe, video, object, embed');
}

// A scaled, inert copy of the window's DOM (form values and canvas pixels copied over).
function cloneThumb(win, w, hgt) {
  try {
    const src = win.el;
    const W = win.fullscreen ? window.innerWidth : win.w;
    const H = win.fullscreen ? window.innerHeight : win.h;
    if (!W || !H) return null;
    if (src.getElementsByTagName('*').length > 6000) return null; // too heavy to copy
    const s = Math.min(w / W, hgt / H);
    const clone = src.cloneNode(true);
    clone.classList.remove('minimized', 'off-desktop', 'closing', 'tv-win', 'tv-out', 'kb-moving', 'fullscreen');
    for (const e of clone.querySelectorAll('[id]')) e.removeAttribute('id');
    for (const e of clone.querySelectorAll('.win-resize, audio')) e.remove();
    const srcF = src.querySelectorAll('input, textarea, select, canvas');
    const dstF = clone.querySelectorAll('input, textarea, select, canvas');
    srcF.forEach((a, i) => {
      const b = dstF[i];
      if (!b || a.tagName !== b.tagName) return;
      if (a.tagName === 'CANVAS') {
        b.width = a.width;
        b.height = a.height;
        try {
          if (a.width && a.height) b.getContext('2d')?.drawImage(a, 0, 0);
        } catch {}
      } else if (a.type === 'checkbox' || a.type === 'radio') b.checked = a.checked;
      else if (a.type !== 'file') b.value = a.value;
    });
    Object.assign(clone.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      width: `${W}px`,
      height: `${H}px`,
      transform: `scale(${s})`,
      transformOrigin: '0 0',
      zIndex: '0',
      opacity: '1',
      transition: 'none',
      animation: 'none',
      visibility: 'visible',
      boxShadow: 'none',
      borderRadius: '0',
    });
    clone.setAttribute('aria-hidden', 'true');
    const inner = h('div', { class: 'wthumb-clone-inner', style: { width: `${Math.round(W * s)}px`, height: `${Math.round(H * s)}px` } }, clone);
    const wrap = h('div', { class: 'wthumb-clone', inert: true, style: { width: `${w}px`, height: `${hgt}px` } }, inner);
    // Scroll positions only apply once the copy is laid out.
    const scrolled = [];
    const walkA = document.createTreeWalker(src, NodeFilter.SHOW_ELEMENT);
    const walkB = document.createTreeWalker(clone, NodeFilter.SHOW_ELEMENT);
    let a = walkA.currentNode;
    let b = walkB.currentNode;
    while (a && b) {
      if ((a.scrollTop || a.scrollLeft) && a.tagName === b.tagName) scrolled.push([b, a.scrollTop, a.scrollLeft]);
      a = walkA.nextNode();
      b = walkB.nextNode();
    }
    if (scrolled.length)
      requestAnimationFrame(() => {
        for (const [el, st, sl] of scrolled) {
          el.scrollTop = st;
          el.scrollLeft = sl;
        }
      });
    return wrap;
  } catch {
    return null;
  }
}

// Refresh the focused window's thumbnail once it has settled, and now and then while it stays focused.
let focusTimer = 0;
let refreshTimer = 0;
function scheduleFocusCapture() {
  clearTimeout(focusTimer);
  focusTimer = setTimeout(() => {
    const w = wm.focused();
    if (w && !document.body.classList.contains('wm-dragging')) thumbs.captureOne(w);
  }, 900);
}

// ------------------------------------------------------------------ switcher
let state = null; // { list, index, sticky, shown, prevFocus, layer, panel, cards, showTimer }

function aspectOf(win) {
  const w = win.w || 800;
  const hh = win.h || 600;
  return Math.max(0.55, Math.min(2.2, w / hh));
}

function layoutSize(n) {
  // Thumbnail height shrinks when there are many windows (Windows keeps cards on at most 3 rows).
  const maxW = window.innerWidth * 0.86;
  let th = 168;
  for (; th > 64; th -= 8) {
    const widths = state.list.map((w) => Math.max(Math.round(th * aspectOf(w)) + 16, 176));
    let rows = 1;
    let acc = 0;
    for (const cw of widths) {
      if (acc && acc + cw + 8 > maxW) {
        rows++;
        acc = 0;
      }
      acc += cw + 8;
    }
    if (rows <= 3 && rows * (th + 52) < window.innerHeight * 0.8) break;
  }
  return { th, maxW, n };
}

function render() {
  const { th, maxW } = layoutSize(state.list.length);
  const cards = h('div', { class: 'alttab-cards', style: { maxWidth: `${Math.round(maxW)}px` } });
  state.cards = state.list.map((win, i) => {
    const tw = Math.round(th * aspectOf(win));
    const card = h(
      'div',
      {
        class: ['alttab-card', i === state.index && 'sel'],
        role: 'option',
        'aria-selected': String(i === state.index),
        dataset: { id: win.id },
        onpointerdown: (e) => e.preventDefault(),
        onclick: (e) => {
          if (e.target.closest('.alttab-x')) return;
          state.index = i;
          commit();
        },
        onpointerenter: () => card.classList.add('hover'),
        onpointerleave: () => card.classList.remove('hover'),
      },
      h(
        'div',
        { class: 'alttab-head' },
        h('img', { class: 'alttab-icon', src: win.iconUrl || registry.iconUrl(win.appId), alt: '', draggable: false }),
        h('span', { class: 'alttab-title ellipsis' }, win.title || registry.name(win.appId)),
        h(
          'button',
          {
            class: 'alttab-x',
            'aria-label': t('alttab.closeWindow'),
            'data-tip': t('alttab.closeWindow'),
            tabindex: '-1',
            onclick: (e) => {
              e.stopPropagation();
              closeAt(i);
            },
          },
          icon('x', { size: 12 }),
        ),
      ),
      h('div', { class: 'alttab-thumb', style: { width: `${tw}px`, height: `${th}px` } }, thumbs.node(win, tw, th)),
    );
    card.style.width = `${Math.max(tw + 16, 176)}px`;
    return card;
  });
  cards.append(...state.cards);
  state.panel.replaceChildren(cards);
}

function select(i) {
  if (!state?.cards) {
    if (state) state.index = i;
    return;
  }
  state.cards[state.index]?.classList.remove('sel');
  state.cards[state.index]?.setAttribute('aria-selected', 'false');
  state.index = i;
  const c = state.cards[i];
  c?.classList.add('sel');
  c?.setAttribute('aria-selected', 'true');
  c?.scrollIntoView?.({ block: 'nearest' });
}

function step(dir) {
  if (!state) return;
  const n = state.list.length;
  if (!n) return;
  select((state.index + dir + n) % n);
}

// Arrow up/down jump to the card visually above/below the current one.
function stepRow(dir) {
  if (!state?.cards) return step(dir);
  const cur = state.cards[state.index].getBoundingClientRect();
  const cx = cur.left + cur.width / 2;
  let best = -1;
  let bestD = Infinity;
  state.cards.forEach((c, i) => {
    const r = c.getBoundingClientRect();
    if (dir > 0 ? r.top <= cur.top + 4 : r.top >= cur.top - 4) return;
    const d = Math.abs(r.top - cur.top) * 4 + Math.abs(r.left + r.width / 2 - cx);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  if (best >= 0) select(best);
}

function show() {
  if (!state || state.shown) return;
  state.shown = true;
  thumbs.block(true);
  const panel = h('div', { class: 'alttab', role: 'listbox', 'aria-label': t('alttab.label'), tabindex: '-1' });
  const layer = h('div', { class: 'alttab-layer wm-keep-focus', onpointerdown: (e) => e.target === layer && cancel() }, panel);
  state.layer = layer;
  state.panel = panel;
  render();
  document.getElementById('overlays').appendChild(layer);
  panel.focus({ preventScroll: true });
}

function teardown() {
  const s = state;
  state = null;
  clearTimeout(s.showTimer);
  document.removeEventListener('keydown', onKey, true);
  document.removeEventListener('keyup', onKeyUp, true);
  window.removeEventListener('blur', onBlur);
  if (document.activeElement === sink) sink.blur();
  if (s.layer) {
    s.panel?.blur();
    const layer = s.layer;
    layer.classList.add('closing');
    setTimeout(() => layer.remove(), 120);
  }
  thumbs.block(false);
  return s;
}

function commit() {
  if (!state) return;
  const s = teardown();
  const win = s.list[s.index];
  const target = win && !win._closing && wm.get(win.id) ? win : s.prevFocus && wm.get(s.prevFocus.id) ? s.prevFocus : null;
  if (!target) return;
  target.focus();
  // focus() is a no-op for the already active window: put the keyboard back explicitly.
  setTimeout(() => wm.focused() === target && target.focusContent(), 0);
}

function cancel() {
  if (!state) return;
  const s = teardown();
  if (s.prevFocus && wm.get(s.prevFocus.id)) s.prevFocus.focusContent();
}

async function closeAt(i) {
  if (!state) return;
  const win = state.list[i];
  if (!win) return;
  const ok = await win.close();
  if (!ok || !state) return;
  state.list = state.list.filter((w) => w !== win);
  if (!state.list.length) return cancel();
  state.index = Math.min(state.index > i ? state.index - 1 : state.index, state.list.length - 1);
  if (state.shown) render();
}

function onKey(e) {
  if (!state) return;
  const k = e.key;
  let handled = true;
  if (k === 'Escape') cancel();
  else if (k === 'Enter' || k === ' ') commit();
  else if (k === 'Tab') step(e.shiftKey ? -1 : 1);
  else if (k === 'ArrowRight') step(1);
  else if (k === 'ArrowLeft') step(-1);
  else if (k === 'ArrowDown') stepRow(1);
  else if (k === 'ArrowUp') stepRow(-1);
  else if (k === 'Delete') closeAt(state.index);
  else if (k === 'Alt' || k === 'Shift' || k === 'Control') handled = false;
  else handled = false;
  if (handled) {
    e.preventDefault();
    e.stopPropagation();
  }
}
function onKeyUp(e) {
  if (e.key === 'Alt') altUp();
}
function onBlur() {
  // The shell window itself lost focus (e.g. another X client): don't leave the switcher stuck open.
  setTimeout(() => {
    if (state && !document.hasFocus() && !state.sticky) commit();
  }, 50);
}

function open(dir = 1, { sticky = false } = {}) {
  if (state) {
    if (sticky) state.sticky = true;
    step(dir);
    return;
  }
  const list = wm.mru();
  if (!list.length) return;
  shell.emit('start:close');
  shell.emit('flyouts:close');
  ui.closeMenus();
  wm.endKeyboardMove?.(); // arrow keys now belong to the switcher
  const focused = wm.focused();
  let index = 0;
  if (list.length > 1) index = dir > 0 ? (focused && list[0] === focused ? 1 : 0) : list.length - 1;
  state = { list, index, sticky, shown: false, prevFocus: focused };
  // Take the keyboard from any webview right away so the Alt release reaches the shell page.
  focusSink().focus({ preventScroll: true });
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('blur', onBlur);
  // Windows shows the switcher only if Alt is still held after a short moment. Grab fresh thumbnails
  // first (before our panel is on screen), then show.
  const started = performance.now();
  const ready = thumbs.captureAll().catch(() => {});
  const delay = sticky ? 0 : 140;
  const s = state;
  Promise.race([ready, new Promise((r) => setTimeout(r, 450))]).then(() => {
    if (state !== s) return;
    const wait = Math.max(0, delay - (performance.now() - started));
    s.showTimer = setTimeout(show, wait);
  });
}

let sink = null;
function focusSink() {
  if (!sink?.isConnected) {
    sink = h('div', { class: 'alttab-sink', tabindex: '-1', 'aria-hidden': 'true' });
    document.getElementById('overlays').appendChild(sink);
  }
  return sink;
}

function altUp() {
  if (state && !state.sticky) commit();
}

export const alttab = {
  open,
  step,
  commit,
  cancel,
  altUp,
  get isOpen() {
    return !!state;
  },
  get shown() {
    return !!state?.shown;
  },
  get selected() {
    return state ? state.list[state.index] : null;
  },
};

export function mount(ctx) {
  ui.loadCss('app://shell/core/features/alttab.css');
  wm.on('focus', (w) => {
    if (w) scheduleFocusCapture();
  });
  // Another shell surface taking over (Task View, a flyout, the lock screen) dismisses the switcher.
  shell.on('flyouts:close', () => cancel());
  shell.on('lock', () => cancel());
  wm.on('desktop', () => cancel()); // its list belongs to the desktop it was opened on
  wm.on('close', (w) => {
    thumbs.drop(w);
    if (state) {
      const i = state.list.indexOf(w);
      if (i >= 0) {
        state.list.splice(i, 1);
        if (!state.list.length) cancel();
        else {
          if (state.index >= state.list.length) state.index = state.list.length - 1;
          if (state.shown) render();
        }
      }
    }
  });
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    const w = wm.focused();
    if (w && !document.hidden && !state && !document.body.classList.contains('wm-dragging')) thumbs.captureOne(w);
  }, 20000);
  ctx.alttab = alttab;
  ctx.thumbs = thumbs;
}
