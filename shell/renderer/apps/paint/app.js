// Paint controller: document, tools, selection, history, files, view.
//
// Rendering model
//   docCanvas  committed image (image pixels; CSS-scaled for zoom, `zoom / devicePixelRatio`
//              CSS px per image px so 100 % shows real device pixels)
//   live       same size, on top: the stroke / shape / text being edited (cleared on commit)
//   floatBox   floating selection content (moved / scaled with CSS until dropped)
//   ovl        overlay in CSS px: marching ants (SVG), handles, text box, canvas resize grips
import { History, clipRect, cloneCanvas } from './lib/history.js';
import { fillMask, applyMask } from './lib/fill.js';
import { applyFinish, bresenham, createEngine, finishFor, finishRect, previewStyle } from './lib/brushes.js';
import { hitShape, isOpen, normBox, renderShape, shapeBounds } from './lib/shapes.js';
import { layoutText, metrics, fontString, renderText, PT_TO_PX } from './lib/text.js';
import { decodeImage, encodeCanvas, formatOf, FORMATS, OPEN_EXTS } from './lib/codecs.js';
import { clamp, hexToRgb, luminance, rgbToHex } from './lib/color.js';
import { createChrome } from './chrome.js';
import { cursorFor } from './art.js';
import { aboutDialog, editColorsDialog, MAX_AREA, MAX_DIM, propertiesDialog, resizeDialog } from './dialogs.js';

export const DEFAULT_W = 1152;
export const DEFAULT_H = 648;
const ZOOMS = [0.125, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 5, 6, 7, 8];
const MIN_ZOOM = 0.02;
const MAX_ZOOM = 8;
const MARGIN = 28;
const SVGNS = 'http://www.w3.org/2000/svg';
const FALLBACK_FONTS = ['Inter', 'DejaVu Sans', 'DejaVu Serif', 'DejaVu Sans Mono', 'Liberation Sans', 'Liberation Serif', 'Liberation Mono', 'Noto Sans', 'sans-serif', 'serif', 'monospace'];
const BRUSH_TOOLS = new Set(['brush', 'calli1', 'calli2', 'airbrush', 'oil', 'crayon', 'marker', 'natural', 'watercolor']);

const rnd = () => (Math.random() * 2 ** 31) | 0;
const baseName = (p) => String(p || '').split('/').pop();
const dirOf = (p) => (p ? p.replace(/\/[^/]*$/, '') || '/' : null);
const extOf = (p) => (/\.[^./]+$/.exec(String(p || ''))?.[0] || '').toLowerCase();

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

function scaledCanvas(src, w, h) {
  const c = makeCanvas(w, h);
  const cc = c.getContext('2d');
  cc.imageSmoothingQuality = 'high';
  cc.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

function union(a, b) {
  if (!a) return b ? { ...b } : null;
  if (!b) return { ...a };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

function subImage(img, r) {
  const out = new ImageData(r.w, r.h);
  const src = new Uint32Array(img.data.buffer);
  const dst = new Uint32Array(out.data.buffer);
  for (let y = 0; y < r.h; y++) dst.set(src.subarray((r.y + y) * img.width + r.x, (r.y + y) * img.width + r.x + r.w), y * r.w);
  return out;
}

/** Copy `src` (covering srcRect in image coords) into `dst` (covering dstRect) where they overlap. */
function blit(dst, dstRect, src, srcRect) {
  const x0 = Math.max(dstRect.x, srcRect.x);
  const y0 = Math.max(dstRect.y, srcRect.y);
  const x1 = Math.min(dstRect.x + dstRect.w, srcRect.x + srcRect.w);
  const y1 = Math.min(dstRect.y + dstRect.h, srcRect.y + srcRect.h);
  if (x1 <= x0 || y1 <= y0) return;
  const d = new Uint32Array(dst.data.buffer);
  const s = new Uint32Array(src.data.buffer);
  for (let y = y0; y < y1; y++) {
    const so = (y - srcRect.y) * src.width + (x0 - srcRect.x);
    d.set(s.subarray(so, so + (x1 - x0)), (y - dstRect.y) * dst.width + (x0 - dstRect.x));
  }
}

const rectD = (r) => `M${r.x} ${r.y}h${r.w}v${r.h}h${-r.w}Z`;
const polyD = (pts, close) => (pts.length ? `M${pts.map(([x, y]) => `${+x.toFixed(2)} ${+y.toFixed(2)}`).join('L')}${close ? 'Z' : ''}` : '');

export async function createPaint(ctx) {
  const { win, h, ui, api, shell } = ctx;
  const t = (k, v) => ctx.t(k, v);
  const i18n = ctx.i18n;

  // ------------------------------------------------------------------ state
  const S = {
    tool: 'pencil',
    prevTool: 'pencil',
    brush: 'brush',
    shape: 'rect',
    sizes: { pencil: 1, brush: 6, eraser: 10, shape: 3 },
    primary: '#000000',
    secondary: '#ffffff',
    slot: 'primary',
    custom: Array(10).fill(null),
    outline: 'solid',
    fill: 'none',
    tolerance: 12,
    selMode: 'rect',
    transparentSel: false,
    text: { family: 'Inter', sizePt: 24, bold: false, italic: false, underline: false, strike: false, opaque: false },
    rulers: false,
    grid: false,
    statusbar: true,
    zoom: 1,
  };
  const prefs = await ctx.storage.get('prefs', null).catch(() => null);
  if (prefs && typeof prefs === 'object') mergePrefs(prefs);
  let recent = [];
  ctx.storage
    .get('recent', [])
    .then((r) => (recent = Array.isArray(r) ? r.filter((x) => typeof x === 'string') : []))
    .catch(() => {});
  let fonts = FALLBACK_FONTS;

  const file = { path: null, name: null, format: 'png', size: null, mtime: null };
  let savedState = 0;
  let gesture = null;
  let sel = null; // { x, y, w, h, ow, oh, rings, float, disp, hole, liftRect, beforeLift }
  let pend = null; // pending (editable) shape
  let poly = null; // polygon being drawn
  let textEdit = null; // { x, y, w, h, wrap, ta }
  let marquee = null; // selection being dragged
  let ghost = null; // dashed preview rect (canvas resize, text box)
  let fullscreen = false;
  let liveSpec = null;
  const L = { scale: 1, dpr: 1, left: 0, top: 0, pw: 0, ph: 0 };

  // ------------------------------------------------------------------ document
  const docCanvas = h('canvas', { class: 'pt-doc' });
  const docCtx = docCanvas.getContext('2d', { willReadFrequently: true });
  const live = h('canvas', { class: 'pt-live' });
  const liveCtx = live.getContext('2d');
  const hitCtx = document.createElement('canvas').getContext('2d');
  const scratchList = [];
  const W = () => docCanvas.width;
  const H = () => docCanvas.height;
  function scratch(i) {
    let c = scratchList[i];
    if (!c) c = scratchList[i] = document.createElement('canvas');
    if (c.width !== W() || c.height !== H()) {
      c.width = W();
      c.height = H();
    }
    return c;
  }
  const env = { scratch };
  function setSize(w, hgt) {
    docCanvas.width = w;
    docCanvas.height = hgt;
    live.width = w;
    live.height = hgt;
    layout();
  }
  const doc = { canvas: docCanvas, ctx: docCtx, resize: setSize };
  const history = new History(doc, { onChange: () => changed() });

  // ------------------------------------------------------------------ app facade for chrome / tests
  const app = {
    ctx,
    win,
    S,
    cmd,
    can,
    setTool,
    setBrush,
    setShape,
    setSize: setStrokeSize,
    getSize,
    sizeKey,
    setOutline,
    setFillStyle,
    setColor,
    setSlot,
    setTextOpt,
    setTolerance,
    setSelMode,
    setZoom: (z) => setZoom(z),
    zoom: () => S.zoom,
    fonts: () => fonts,
    recent: () => recent,
  };

  // ------------------------------------------------------------------ DOM
  let chrome = createChrome(app).build();
  const floatBox = h('div', { class: 'pt-float', hidden: true });
  const gridEl = h('div', { class: 'pt-grid', hidden: true });
  const page = h('div', { class: 'pt-page' }, docCanvas, live, floatBox, gridEl);
  const svg = (tag, attrs) => {
    const el = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
    return el;
  };
  const antsSvg = svg('svg', { class: 'pt-ants', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
  const antsA = svg('path', { class: 'pt-ants-a' });
  const antsB = svg('path', { class: 'pt-ants-b' });
  const dashA = svg('path', { class: 'pt-dash-a' });
  const dashB = svg('path', { class: 'pt-dash-b' });
  antsSvg.append(dashA, dashB, antsA, antsB);
  const handles = h('div', { class: 'pt-handles' });
  const cvHandles = ['e', 's', 'se'].map((d) => h('div', { class: `pt-cvh pt-cvh-${d}`, dataset: { h: d, kind: 'canvas' }, 'data-tip': t('canvasResize') }));
  const ovl = h('div', { class: 'pt-ovl' }, antsSvg, handles, ...cvHandles);
  const stage = h('div', { class: 'pt-stage' }, page, ovl);
  const scroller = h('div', { class: 'pt-scroll', tabindex: '0', 'aria-label': t('canvas'), 'aria-roledescription': t('canvas') }, stage);
  const rulerH = h('canvas', { class: 'pt-ruler pt-ruler-h', 'aria-hidden': 'true' });
  const rulerV = h('canvas', { class: 'pt-ruler pt-ruler-v', 'aria-hidden': 'true' });
  const markH = h('div', { class: 'pt-rmark h' });
  const markV = h('div', { class: 'pt-rmark v' });
  const dropEl = h('div', { class: 'pt-drop' }, h('div', { class: 'pt-drop-card' }, ctx.icon('image_add', { size: 32 }), h('div', { class: 'pt-drop-txt' }, t('dropHint'))));
  const fsExit = h('button', { type: 'button', class: 'btn pt-fs-exit', onclick: () => setFullscreen(false) }, ctx.icon('full_screen_minimize'), t('view.exitFullscreen'));
  const main = h('div', { class: 'pt-main' }, h('div', { class: 'pt-ruler-corner' }), rulerH, rulerV, markH, markV, scroller, dropEl, fsExit);
  const root = h('div', { class: 'pt' }, chrome.cmdbar, chrome.ctxbar, main, chrome.status);
  win.body.appendChild(root);
  win.titlebarSlot.appendChild(chrome.titlebar);

  // ------------------------------------------------------------------ helpers
  const insideDoc = (p) => p.x >= 0 && p.y >= 0 && p.x < W() && p.y < H();
  function imgPt(e) {
    const r = docCanvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * W()) / (r.width || 1), y: ((e.clientY - r.top) * H()) / (r.height || 1) };
  }
  function pointsOf(e) {
    const list = e.getCoalescedEvents?.() || [];
    return (list.length ? list : [e]).map(imgPt);
  }
  function mergePrefs(p) {
    const str = (v, ok) => (typeof v === 'string' && (!ok || ok.includes(v)) ? v : undefined);
    const hex = (v) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : undefined);
    S.tool = str(p.tool, ['pencil', 'brush', 'eraser', 'fill', 'text', 'select', 'shape', 'zoom']) || S.tool;
    S.brush = str(p.brush) && BRUSH_TOOLS.has(p.brush) ? p.brush : S.brush;
    S.shape = str(p.shape) || S.shape;
    if (p.sizes && typeof p.sizes === 'object') for (const k of Object.keys(S.sizes)) if (Number(p.sizes[k]) >= 1) S.sizes[k] = Math.min(50, Math.round(p.sizes[k]));
    S.primary = hex(p.primary) || S.primary;
    S.secondary = hex(p.secondary) || S.secondary;
    if (Array.isArray(p.custom)) S.custom = Array.from({ length: 10 }, (_, i) => hex(p.custom[i]) || null);
    S.outline = str(p.outline) || S.outline;
    S.fill = str(p.fill) || S.fill;
    if (Number.isFinite(p.tolerance)) S.tolerance = clamp(Math.round(p.tolerance), 0, 100);
    S.selMode = str(p.selMode, ['rect', 'free']) || S.selMode;
    S.transparentSel = !!p.transparentSel;
    if (p.text && typeof p.text === 'object') {
      if (typeof p.text.family === 'string') S.text.family = p.text.family;
      if (Number(p.text.sizePt) >= 1) S.text.sizePt = Math.min(400, Number(p.text.sizePt));
      for (const k of ['bold', 'italic', 'underline', 'strike', 'opaque']) S.text[k] = !!p.text[k];
    }
    S.rulers = !!p.rulers;
    S.grid = !!p.grid;
    S.statusbar = p.statusbar !== false;
  }
  let prefTimer = null;
  function savePrefs() {
    clearTimeout(prefTimer);
    prefTimer = setTimeout(() => {
      const { tool, brush, shape, sizes, primary, secondary, custom, outline, fill, tolerance, selMode, transparentSel, text, rulers, grid, statusbar } = S;
      ctx.storage
        .set('prefs', { tool: tool === 'picker' ? S.prevTool : tool, brush, shape, sizes, primary, secondary, custom, outline, fill, tolerance, selMode, transparentSel, text, rulers, grid, statusbar })
        .catch(() => {});
    }, 400);
  }
  function setRecent(list) {
    recent = list.slice(0, 10);
    ctx.storage.set('recent', recent).catch(() => {});
  }
  const addRecent = (p) => setRecent([p, ...recent.filter((x) => x !== p)]);

  async function showError(msg, err) {
    if (err) console.warn('[paint]', err);
    await ui.alert(err?.message ? `${msg}\n\n${err.message}` : msg, { title: 'Paint', parent: win });
  }

  // ------------------------------------------------------------------ layout / zoom
  function layout() {
    const dpr = window.devicePixelRatio || 1;
    L.dpr = dpr;
    L.scale = S.zoom / dpr;
    const snap = (v) => Math.round(v * dpr) / dpr;
    const pw = Math.max(1 / dpr, snap(W() * L.scale));
    const ph = Math.max(1 / dpr, snap(H() * L.scale));
    const vw = scroller.clientWidth;
    const vh = scroller.clientHeight;
    const left = pw + MARGIN * 2 <= vw ? snap((vw - pw) / 2) : MARGIN;
    const top = ph + MARGIN * 2 <= vh ? snap((vh - ph) / 2) : MARGIN;
    Object.assign(L, { left, top, pw, ph });
    stage.style.width = `${Math.max(vw, Math.ceil(pw + MARGIN * 2))}px`;
    stage.style.height = `${Math.max(vh, Math.ceil(ph + MARGIN * 2))}px`;
    for (const el of [page, ovl]) Object.assign(el.style, { left: `${left}px`, top: `${top}px`, width: `${pw}px`, height: `${ph}px` });
    page.classList.toggle('pixelated', L.scale >= 1);
    antsSvg.setAttribute('viewBox', `0 0 ${W()} ${H()}`);
    applyLiveStyle();
    updateGrid();
    overlay();
    positionText();
    updateCursor();
    drawRulers();
    chrome.setZoom(S.zoom);
    updateStatus();
  }

  function setZoom(z, anchor) {
    z = clamp(Number(z) || 1, MIN_ZOOM, MAX_ZOOM);
    const rect = scroller.getBoundingClientRect();
    const ax = anchor ? anchor.x - rect.left : scroller.clientWidth / 2;
    const ay = anchor ? anchor.y - rect.top : scroller.clientHeight / 2;
    const ix = (scroller.scrollLeft + ax - L.left) / L.scale;
    const iy = (scroller.scrollTop + ay - L.top) / L.scale;
    S.zoom = z;
    layout();
    scroller.scrollLeft = L.left + ix * L.scale - ax;
    scroller.scrollTop = L.top + iy * L.scale - ay;
    drawRulers();
  }

  function zoomStep(dir, anchor) {
    const z = S.zoom;
    let next = dir > 0 ? ZOOMS.find((v) => v > z * 1.001) : [...ZOOMS].reverse().find((v) => v < z * 0.999);
    if (next == null) next = dir > 0 ? MAX_ZOOM : Math.max(MIN_ZOOM, z / 2);
    setZoom(next, anchor);
  }

  function zoomFit() {
    const vw = Math.max(40, scroller.clientWidth - MARGIN * 2);
    const vh = Math.max(40, scroller.clientHeight - MARGIN * 2);
    const z = Math.min(vw / W(), vh / H()) * (window.devicePixelRatio || 1);
    S.zoom = clamp(Math.floor(z * 1000) / 1000, MIN_ZOOM, MAX_ZOOM);
    layout();
    scroller.scrollTo(0, 0);
  }

  function initialZoom() {
    S.zoom = 1;
    layout();
    const dpr = window.devicePixelRatio || 1;
    if (W() / dpr > scroller.clientWidth - MARGIN * 2 || H() / dpr > scroller.clientHeight - MARGIN * 2) zoomFit();
    else scroller.scrollTo(0, 0);
  }

  function updateGrid() {
    if (!S.grid) {
      gridEl.hidden = true;
      return;
    }
    const step = [1, 2, 5, 10, 20, 50, 100, 200, 500].find((v) => v * L.scale >= 8) || 1000;
    gridEl.hidden = false;
    gridEl.style.backgroundSize = `${step * L.scale}px ${step * L.scale}px`;
  }

  function applyLiveStyle() {
    const st = liveSpec ? previewStyle(liveSpec.spec, liveSpec.size, L.scale) : { opacity: '', filter: '', mask: '' };
    live.style.opacity = st.opacity;
    live.style.filter = st.filter;
    live.style.mask = st.mask;
    live.style.webkitMask = st.mask;
  }
  function setLiveStyle(spec, size) {
    liveSpec = spec ? { spec, size } : null;
    applyLiveStyle();
  }
  function clearLive() {
    liveCtx.setTransform(1, 0, 0, 1, 0, 0);
    liveCtx.globalAlpha = 1;
    liveCtx.globalCompositeOperation = 'source-over';
    liveCtx.clearRect(0, 0, live.width, live.height);
    if (liveSpec) setLiveStyle(null);
  }

  function updateCursor() {
    scroller.style.setProperty('--pt-cursor', cursorFor(S.tool, { size: getSize(), scale: L.scale }));
  }

  // ------------------------------------------------------------------ rulers
  function drawRulers() {
    if (!S.rulers) return;
    const dpr = window.devicePixelRatio || 1;
    const cs = getComputedStyle(root);
    const fg = cs.getPropertyValue('--text-2').trim() || '#666';
    const line = cs.getPropertyValue('--text-3').trim() || '#999';
    const s = L.scale;
    const major = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000].find((v) => v * s >= 64) || 20000;
    let minor = major / 10;
    if (minor * s < 5) minor = major / 5;
    if (minor * s < 5) minor = major / 2;
    for (const [cv, horiz] of [
      [rulerH, true],
      [rulerV, false],
    ]) {
      const len = horiz ? scroller.clientWidth : scroller.clientHeight;
      const th = 20;
      cv.width = Math.max(1, Math.round(len * dpr));
      cv.height = Math.round(th * dpr);
      cv.style.width = horiz ? `${len}px` : `${th}px`;
      cv.style.height = horiz ? `${th}px` : `${len}px`;
      if (!horiz) {
        cv.width = Math.round(th * dpr);
        cv.height = Math.max(1, Math.round(len * dpr));
      }
      const c = cv.getContext('2d');
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, horiz ? len : th, horiz ? th : len);
      const origin = horiz ? L.left - scroller.scrollLeft : L.top - scroller.scrollTop;
      c.fillStyle = line;
      c.font = '10px var(--font), sans-serif';
      c.textBaseline = 'top';
      const start = Math.floor(-origin / s / minor) * minor;
      for (let v = start; v * s + origin <= len; v += minor) {
        const pos = Math.round(origin + v * s) + 0.5;
        const isMajor = Math.abs(v / major - Math.round(v / major)) < 1e-6;
        const isHalf = !isMajor && Math.abs((v * 2) / major - Math.round((v * 2) / major)) < 1e-6;
        const tl = isMajor ? th : isHalf ? th * 0.45 : th * 0.25;
        if (horiz) c.fillRect(pos - 0.5, th - tl, 1, tl);
        else c.fillRect(th - tl, pos - 0.5, tl, 1);
        if (isMajor) {
          c.fillStyle = fg;
          if (horiz) c.fillText(String(Math.round(v)), pos + 3, 2);
          else {
            c.save();
            c.translate(2, pos + 3);
            c.rotate(Math.PI / 2);
            c.fillText(String(Math.round(v)), 0, -10);
            c.restore();
          }
          c.fillStyle = line;
        }
      }
    }
  }
  function moveRulerMarks(p) {
    if (!S.rulers || !p) {
      markH.hidden = markV.hidden = true;
      return;
    }
    const r = scroller.getBoundingClientRect();
    const mr = main.getBoundingClientRect();
    const pr = docCanvas.getBoundingClientRect();
    markH.hidden = markV.hidden = false;
    markH.style.left = `${pr.left - mr.left + p.x * L.scale}px`;
    markV.style.top = `${pr.top - mr.top + p.y * L.scale}px`;
    markH.style.display = pr.left + p.x * L.scale < r.left ? 'none' : '';
    markV.style.display = pr.top + p.y * L.scale < r.top ? 'none' : '';
  }

  // ------------------------------------------------------------------ status / title
  const fmtSize = (w, hh) => `${w} × ${hh}px`;
  function selSizeText() {
    if (marquee && !marquee.lasso) return fmtSize(marquee.w, marquee.h);
    if (sel) return fmtSize(Math.round(sel.w), Math.round(sel.h));
    const s = pend || poly;
    if (s) {
      if (s.type === 'polygon') return '';
      const b = normBox(s);
      return fmtSize(Math.round(Math.abs(b.r - b.l)), Math.round(Math.abs(b.b - b.t)));
    }
    if (textEdit) return fmtSize(textEdit.w, textEdit.h);
    return '';
  }
  function updateStatus() {
    chrome.setStatus({
      size: fmtSize(W(), H()),
      sel: selSizeText(),
      file: file.size != null ? t('status.fileSize', { size: i18n.formatSize(file.size) }) : '',
    });
  }
  function updatePos(p) {
    chrome.setStatus({ pos: p && insideDoc(p) ? `${Math.floor(p.x)}, ${Math.floor(p.y)}px` : '' });
    moveRulerMarks(p);
  }
  const hasPendingEdits = () => !!(pend || poly || sel?.float || (textEdit && textEdit.ta.value.trim()));
  const isDirty = () => history.state !== savedState || hasPendingEdits();
  function updateTitle() {
    const title = t('titleFmt', { name: `${isDirty() ? '*' : ''}${file.name || t('untitled')}` });
    if (win.title !== title) win.setTitle(title);
    chrome.setTitle(title);
  }
  function changed() {
    updateTitle();
    chrome.update();
    updateStatus();
  }

  // ------------------------------------------------------------------ overlay (ants, handles)
  function handle(kind, id, x, y, cls) {
    const s = L.scale;
    handles.appendChild(h('div', { class: ['pt-h', `pt-h-${id.replace(/\d+$/, '')}`, cls], dataset: { h: id, kind }, style: { left: `${x * s}px`, top: `${y * s}px` } }));
  }
  function boxHandles(kind, r) {
    const { x, y, w, h: hh } = r;
    const pts = { nw: [x, y], n: [x + w / 2, y], ne: [x + w, y], e: [x + w, y + hh / 2], se: [x + w, y + hh], s: [x + w / 2, y + hh], sw: [x, y + hh], w: [x, y + hh / 2] };
    for (const [id, [hx, hy]] of Object.entries(pts)) handle(kind, id, hx, hy);
  }
  function ringsAt(s) {
    const kx = s.w / (s.ow || s.w || 1);
    const ky = s.h / (s.oh || s.h || 1);
    return s.rings.map((r) => r.map(([x, y]) => [s.x + x * kx, s.y + y * ky]));
  }
  function selPath(s = sel) {
    const p = new Path2D();
    if (!s.rings) p.rect(s.x, s.y, s.w, s.h);
    else
      for (const ring of ringsAt(s)) {
        ring.forEach(([x, y], i) => (i ? p.lineTo(x, y) : p.moveTo(x, y)));
        p.closePath();
      }
    return p;
  }

  function overlay() {
    const s = L.scale;
    handles.replaceChildren();
    let ants = '';
    let dash = '';
    if (marquee) ants = marquee.lasso ? polyD(marquee.lasso, false) : rectD(marquee);
    else if (sel) {
      ants = sel.rings ? ringsAt(sel).map((r) => polyD(r, true)).join('') : rectD(sel);
      boxHandles('sel', sel);
    }
    const shp = pend || poly;
    if (shp) {
      if (shp.type === 'line') {
        handle('shape', 'p0', shp.x0, shp.y0, 'pt-hp');
        handle('shape', 'p1', shp.x1, shp.y1, 'pt-hp');
      } else if (shp.type === 'curve') {
        dash += polyD([[shp.x0, shp.y0], shp.c1], false) + polyD([[shp.x1, shp.y1], shp.c2], false);
        handle('shape', 'p0', shp.x0, shp.y0, 'pt-hp');
        handle('shape', 'p1', shp.x1, shp.y1, 'pt-hp');
        handle('shape', 'c1', shp.c1[0], shp.c1[1], 'pt-hc');
        handle('shape', 'c2', shp.c2[0], shp.c2[1], 'pt-hc');
      } else if (shp.type === 'polygon') {
        if (pend) shp.pts.forEach(([x, y], i) => handle('shape', `v${i}`, x, y, 'pt-hp'));
      } else {
        const b = normBox(shp);
        const r = { x: b.l, y: b.t, w: b.r - b.l, h: b.b - b.t };
        dash += rectD(r);
        if (pend) boxHandles('shape', r);
      }
    }
    if (ghost) dash += rectD(ghost);
    antsA.setAttribute('d', ants);
    antsB.setAttribute('d', ants);
    dashA.setAttribute('d', dash);
    dashB.setAttribute('d', dash);
    antsSvg.classList.toggle('marching', !!sel && !marquee);
    if (sel?.float) {
      floatBox.hidden = false;
      Object.assign(floatBox.style, { left: `${sel.x * s}px`, top: `${sel.y * s}px`, width: `${sel.w * s}px`, height: `${sel.h * s}px` });
    } else floatBox.hidden = true;
    const [e, so, se] = cvHandles;
    e.style.left = `${L.pw}px`;
    e.style.top = `${L.ph / 2}px`;
    so.style.left = `${L.pw / 2}px`;
    so.style.top = `${L.ph}px`;
    se.style.left = `${L.pw}px`;
    se.style.top = `${L.ph}px`;
    updateStatus();
  }

  // ------------------------------------------------------------------ pointer input
  function onScrollbar(e) {
    if (e.target !== scroller) return false;
    const r = scroller.getBoundingClientRect();
    return e.clientX - r.left >= scroller.clientWidth || e.clientY - r.top >= scroller.clientHeight;
  }
  scroller.addEventListener('pointerdown', (e) => {
    chrome.closeFlyout();
    if (gesture) {
      cancelGesture();
      e.preventDefault();
      return;
    }
    if (onScrollbar(e)) return;
    if (textEdit && textEdit.ta === e.target) return;
    if (e.button === 1) {
      e.preventDefault();
      beginGesture(panGesture(e), e);
      return;
    }
    if (e.button !== 0 && e.button !== 2) return;
    if (!textEdit || !textEdit.wrap.contains(e.target)) scroller.focus({ preventScroll: true });
    const p = imgPt(e);
    const hEl = e.target.closest?.('[data-h]');
    const g = hEl && e.button === 0 ? startHandle(hEl.dataset.kind, hEl.dataset.h, e, p) : startTool(e, p);
    if (g) {
      e.preventDefault();
      beginGesture(g, e);
    }
  });
  function beginGesture(g, e) {
    g.button = e.button;
    g.pointerId = e.pointerId;
    gesture = g;
    try {
      scroller.setPointerCapture(e.pointerId);
    } catch {}
  }
  scroller.addEventListener('pointermove', (e) => {
    const p = imgPt(e);
    updatePos(p);
    if (!gesture) {
      hoverCursor(p);
      return;
    }
    const mask = { 0: 1, 1: 4, 2: 2 }[gesture.button] ?? 1;
    if ((e.buttons & mask) === 0) {
      finishGesture(e);
      return;
    }
    if (gesture.button !== 1 && e.buttons & ~mask & 3) {
      cancelGesture();
      return;
    }
    gesture.move?.(pointsOf(e), e);
  });
  scroller.addEventListener('pointerup', (e) => {
    if (gesture && e.button === gesture.button) finishGesture(e);
  });
  scroller.addEventListener('pointercancel', () => cancelGesture());
  scroller.addEventListener('pointerleave', () => {
    if (!gesture) updatePos(null);
  });
  scroller.addEventListener('contextmenu', (e) => {
    if (!(textEdit && textEdit.ta === e.target)) e.preventDefault();
  });
  scroller.addEventListener('dblclick', () => {
    if (poly) finishPolygon();
  });
  scroller.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const f = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015));
      setZoom(S.zoom * f, { x: e.clientX, y: e.clientY });
    },
    { passive: false },
  );
  scroller.addEventListener('scroll', () => drawRulers(), { passive: true });

  function finishGesture(e) {
    const g = gesture;
    gesture = null;
    try {
      scroller.releasePointerCapture(g.pointerId);
    } catch {}
    try {
      g.up?.(imgPt(e), e);
    } catch (err) {
      console.error('[paint] gesture failed', err);
    }
  }
  function cancelGesture() {
    const g = gesture;
    gesture = null;
    if (!g) return;
    try {
      scroller.releasePointerCapture(g.pointerId);
    } catch {}
    g.cancel?.();
  }

  function hoverCursor(p) {
    let move = false;
    if (S.tool === 'select' && sel && hitSel(p)) move = true;
    else if (S.tool === 'shape' && pend && hitShape(pend, p.x, p.y, 5 / L.scale)) move = true;
    scroller.classList.toggle('over-move', move);
  }

  function panGesture(e) {
    const sx = e.clientX;
    const sy = e.clientY;
    const l = scroller.scrollLeft;
    const tp = scroller.scrollTop;
    scroller.classList.add('panning');
    const end = () => scroller.classList.remove('panning');
    return {
      move(_, ev) {
        scroller.scrollLeft = l - (ev.clientX - sx);
        scroller.scrollTop = tp - (ev.clientY - sy);
      },
      up: end,
      cancel: end,
    };
  }

  function startHandle(kind, id, e, p) {
    if (kind === 'canvas') return canvasResizeGesture(id);
    if (kind === 'sel' && sel) return selHandle(id);
    if (kind === 'shape' && pend) return shapeHandle(id, p);
    if (kind === 'text' && textEdit) return textHandle(id, p);
    return null;
  }

  function startTool(e, p) {
    const right = e.button === 2;
    if (S.tool === 'select') return startSelect(e, p, right);
    if (S.tool === 'shape') return startShape(e, p, right);
    if (S.tool === 'text') return startText(p);
    commitPending();
    const inside = insideDoc(p);
    switch (S.tool) {
      case 'pencil':
      case 'brush':
        return inside ? startStroke(p, right) : null;
      case 'eraser':
        return inside ? (right ? startColorEraser(p) : startStroke(p, false)) : null;
      case 'fill':
        if (inside) floodFill(p, right);
        return null;
      case 'picker':
        if (inside) pick(p, right);
        return null;
      case 'zoom':
        zoomStep(right ? -1 : 1, { x: e.clientX, y: e.clientY });
        return null;
      default:
        return null;
    }
  }

  // ------------------------------------------------------------------ strokes
  function startStroke(p, right) {
    const kind = S.tool === 'brush' ? S.brush : S.tool;
    const color = S.tool === 'eraser' ? S.secondary : right ? S.secondary : S.primary;
    const size = getSize();
    const spec = finishFor(kind);
    clearLive();
    setLiveStyle(spec, size);
    const eng = createEngine(kind, liveCtx, { color, size, seed: rnd() });
    eng.add(p.x, p.y);
    const timer = kind === 'airbrush' ? setInterval(() => eng.tick(), 35) : null;
    return {
      move(pts) {
        for (const q of pts) eng.add(q.x, q.y);
      },
      up() {
        clearInterval(timer);
        eng.end();
        commitLive(eng.rect, spec, size);
      },
      cancel() {
        clearInterval(timer);
        clearLive();
      },
    };
  }

  function commitLive(rect, spec, size) {
    if (rect) {
      const rec = history.recordRegion(spec ? finishRect(rect, spec, size) : rect);
      if (rec) {
        if (spec) applyFinish(docCtx, live, rect, spec, size, scratch(1), scratch(2));
        else {
          const r = rec.rect;
          docCtx.drawImage(live, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
        }
      }
    }
    clearLive();
    changed();
  }

  // Right-drag with the eraser replaces only the primary colour with the secondary one.
  function startColorEraser(p) {
    const s = Math.max(1, Math.round(S.sizes.eraser));
    const from = hexToRgb(S.primary);
    const to = hexToRgb(S.secondary);
    const before = docCtx.getImageData(0, 0, W(), H());
    let box = null;
    let last = null;
    const stamp = (ix, iy) => {
      const o = Math.floor((s - 1) / 2);
      const r = clipRect({ x: ix - o, y: iy - o, w: s, h: s }, W(), H());
      if (!r) return;
      const img = docCtx.getImageData(r.x, r.y, r.w, r.h);
      const d = img.data;
      let hit = false;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] === from[0] && d[i + 1] === from[1] && d[i + 2] === from[2] && d[i + 3] === 255) {
          d[i] = to[0];
          d[i + 1] = to[1];
          d[i + 2] = to[2];
          hit = true;
        }
      }
      if (hit) {
        docCtx.putImageData(img, r.x, r.y);
        box = union(box, r);
      }
    };
    const add = (q) => {
      const ix = Math.floor(q.x);
      const iy = Math.floor(q.y);
      if (!last) stamp(ix, iy);
      else bresenham(last[0], last[1], ix, iy, stamp);
      last = [ix, iy];
    };
    add(p);
    return {
      move(pts) {
        pts.forEach(add);
      },
      up() {
        if (box) history.pushRegionData(box, subImage(before, box));
        changed();
      },
      cancel() {
        if (box) docCtx.putImageData(before, 0, 0, box.x, box.y, box.w, box.h);
      },
    };
  }

  function floodFill(p, right) {
    const rgb = hexToRgb(right ? S.secondary : S.primary);
    const img = docCtx.getImageData(0, 0, W(), H());
    const i = (Math.floor(p.y) * W() + Math.floor(p.x)) * 4;
    const d = img.data;
    if (d[i] === rgb[0] && d[i + 1] === rgb[1] && d[i + 2] === rgb[2] && d[i + 3] === 255 && S.tolerance === 0) return;
    const m = fillMask(img, p.x, p.y, S.tolerance);
    if (!m) return;
    const rect = { x: m.minX, y: m.minY, w: m.maxX - m.minX + 1, h: m.maxY - m.minY + 1 };
    const before = subImage(img, rect);
    applyMask(img, m, [...rgb, 255]);
    history.pushRegionData(rect, before);
    docCtx.putImageData(img, 0, 0, rect.x, rect.y, rect.w, rect.h);
    changed();
  }

  function pick(p, right) {
    const d = docCtx.getImageData(Math.floor(p.x), Math.floor(p.y), 1, 1).data;
    const hex = d[3] < 8 ? '#ffffff' : rgbToHex(d[0], d[1], d[2]);
    setColor(right ? 'secondary' : 'primary', hex);
    if (S.prevTool && S.prevTool !== 'picker') setTool(S.prevTool);
  }

  // ------------------------------------------------------------------ shapes
  const shapeColors = (right) => (right ? { stroke: S.secondary, fillColor: S.primary } : { stroke: S.primary, fillColor: S.secondary });
  const cloneShape = (s) => ({ ...s, c1: s.c1 && [...s.c1], c2: s.c2 && [...s.c2], pts: s.pts && s.pts.map((p) => [...p]) });
  function drawPending(s = pend || poly) {
    clearLive();
    if (s) renderShape(liveCtx, s, env);
  }
  function constrain(a, b, shift, open) {
    if (!shift) return b;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    if (open) {
      const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(dx, dy);
      return { x: a.x + Math.round(Math.cos(ang) * len), y: a.y + Math.round(Math.sin(ang) * len) };
    }
    const d = Math.max(Math.abs(dx), Math.abs(dy));
    return { x: a.x + Math.sign(dx || 1) * d, y: a.y + Math.sign(dy || 1) * d };
  }

  function startShape(e, p, right) {
    if (poly) return polyClick(p);
    if (pend) {
      if (hitShape(pend, p.x, p.y, 5 / L.scale)) return moveShape(p);
      commitShape();
    }
    if (S.shape === 'polygon') return startPolygon(p, right);
    const open = isOpen(S.shape);
    const snap = (q) => (open ? { x: Math.floor(q.x) + 0.5, y: Math.floor(q.y) + 0.5 } : { x: Math.round(q.x), y: Math.round(q.y) });
    const s0 = snap(p);
    const shape = { type: S.shape, x0: s0.x, y0: s0.y, x1: s0.x, y1: s0.y, ...shapeColors(right), size: S.sizes.shape, outline: S.outline, fill: S.fill, seed: rnd() };
    let moved = false;
    return {
      move(pts, ev) {
        const c = constrain(s0, snap(pts[pts.length - 1]), ev.shiftKey, open);
        shape.x1 = c.x;
        shape.y1 = c.y;
        if (shape.type === 'curve') {
          shape.c1 = [shape.x0 + (shape.x1 - shape.x0) / 3, shape.y0 + (shape.y1 - shape.y0) / 3];
          shape.c2 = [shape.x0 + ((shape.x1 - shape.x0) * 2) / 3, shape.y0 + ((shape.y1 - shape.y0) * 2) / 3];
        }
        moved = moved || Math.abs(shape.x1 - shape.x0) >= 1 || Math.abs(shape.y1 - shape.y0) >= 1;
        poly = null;
        drawPending(shape);
        chrome.setStatus({ sel: fmtSize(Math.round(Math.abs(shape.x1 - shape.x0)), Math.round(Math.abs(shape.y1 - shape.y0))) });
      },
      up() {
        if (!moved) {
          clearLive();
          return;
        }
        pend = shape;
        drawPending();
        overlay();
        changed();
      },
      cancel() {
        clearLive();
        overlay();
      },
    };
  }

  function translateShape(s, o, dx, dy) {
    s.x0 = o.x0 + dx;
    s.y0 = o.y0 + dy;
    s.x1 = o.x1 + dx;
    s.y1 = o.y1 + dy;
    if (o.c1) s.c1 = [o.c1[0] + dx, o.c1[1] + dy];
    if (o.c2) s.c2 = [o.c2[0] + dx, o.c2[1] + dy];
    if (o.pts) s.pts = o.pts.map(([x, y]) => [x + dx, y + dy]);
  }

  function moveShape(p) {
    const s = pend;
    const o = cloneShape(s);
    return {
      move(pts) {
        const q = pts[pts.length - 1];
        translateShape(s, o, Math.round(q.x - p.x), Math.round(q.y - p.y));
        drawPending();
        overlay();
      },
      cancel() {
        Object.assign(s, o);
        drawPending();
        overlay();
      },
    };
  }

  function shapeHandle(id, p) {
    const s = pend;
    const o = cloneShape(s);
    const nb = normBox(o);
    return {
      move(pts, ev) {
        const q = pts[pts.length - 1];
        if (id === 'p0' || id === 'p1') {
          const fixed = id === 'p0' ? { x: o.x1, y: o.y1 } : { x: o.x0, y: o.y0 };
          const c = constrain(fixed, { x: Math.floor(q.x) + 0.5, y: Math.floor(q.y) + 0.5 }, ev.shiftKey && s.type === 'line', true);
          if (id === 'p0') [s.x0, s.y0] = [c.x, c.y];
          else [s.x1, s.y1] = [c.x, c.y];
        } else if (id === 'c1' || id === 'c2') s[id] = [q.x, q.y];
        else if (id[0] === 'v') s.pts[Number(id.slice(1))] = [Math.floor(q.x) + 0.5, Math.floor(q.y) + 0.5];
        else {
          let { l, t: tp, r, b } = nb;
          const x = Math.round(q.x);
          const y = Math.round(q.y);
          if (id.includes('w')) l = x;
          if (id.includes('e')) r = x;
          if (id.includes('n')) tp = y;
          if (id.includes('s')) b = y;
          if (ev.shiftKey && id.length === 2) {
            const ratio = (nb.r - nb.l) / (nb.b - nb.t || 1);
            const w = r - l;
            const hh = b - tp;
            if (Math.abs(w) / ratio > Math.abs(hh)) {
              const nh = Math.round((Math.abs(w) / ratio) * Math.sign(hh || 1));
              if (id.includes('n')) tp = b - nh;
              else b = tp + nh;
            } else {
              const nw = Math.round(Math.abs(hh) * ratio * Math.sign(w || 1));
              if (id.includes('w')) l = r - nw;
              else r = l + nw;
            }
          }
          s.x0 = Math.min(l, r);
          s.x1 = Math.max(l, r);
          s.y0 = Math.min(tp, b);
          s.y1 = Math.max(tp, b);
        }
        drawPending();
        overlay();
      },
      cancel() {
        Object.assign(s, o);
        drawPending();
        overlay();
      },
    };
  }

  function startPolygon(p, right) {
    const x = Math.floor(p.x) + 0.5;
    const y = Math.floor(p.y) + 0.5;
    poly = { type: 'polygon', pts: [[x, y], [x, y]], closed: false, ...shapeColors(right), size: S.sizes.shape, outline: S.outline, fill: S.fill, seed: rnd() };
    return polyDrag();
  }
  function polyDrag() {
    return {
      move(pts, ev) {
        if (!poly) return;
        const q = pts[pts.length - 1];
        const prev = poly.pts[poly.pts.length - 2];
        const c = constrain({ x: prev[0], y: prev[1] }, { x: Math.floor(q.x) + 0.5, y: Math.floor(q.y) + 0.5 }, ev.shiftKey, true);
        poly.pts[poly.pts.length - 1] = [c.x, c.y];
        drawPending(poly);
      },
      up() {
        drawPending(poly);
        changed();
      },
      cancel() {
        poly = null;
        clearLive();
        changed();
      },
    };
  }
  function polyClick(p) {
    const first = poly.pts[0];
    if (poly.pts.length >= 3 && Math.hypot((p.x - first[0]) * L.scale, (p.y - first[1]) * L.scale) < 8) {
      poly.pts.pop();
      finishPolygon();
      return null;
    }
    poly.pts.push([Math.floor(p.x) + 0.5, Math.floor(p.y) + 0.5]);
    drawPending(poly);
    return polyDrag();
  }
  function finishPolygon() {
    if (!poly) return;
    const s = poly;
    poly = null;
    s.pts = s.pts.filter((pt, i, a) => i === 0 || Math.hypot(pt[0] - a[i - 1][0], pt[1] - a[i - 1][1]) >= 1);
    if (s.pts.length < 2) {
      clearLive();
      overlay();
      changed();
      return;
    }
    if (s.pts.length === 2) {
      const [[x0, y0], [x1, y1]] = s.pts;
      pend = { ...s, type: 'line', x0, y0, x1, y1, pts: undefined };
    } else {
      s.closed = true;
      pend = s;
    }
    drawPending();
    overlay();
    changed();
  }

  function commitShape() {
    if (!pend) return;
    const s = pend;
    pend = null;
    history.recordRegion(shapeBounds(s));
    renderShape(docCtx, s, env);
    clearLive();
    overlay();
    changed();
  }

  // ------------------------------------------------------------------ selection
  function hitSel(p) {
    if (!sel) return false;
    if (p.x < sel.x || p.y < sel.y || p.x > sel.x + sel.w || p.y > sel.y + sel.h) return false;
    if (!sel.rings || sel.float) return true;
    return hitCtx.isPointInPath(selPath(), p.x, p.y, 'evenodd');
  }

  function startSelect(e, p, right) {
    if (right) {
      selContextMenu(e);
      return null;
    }
    if (sel && hitSel(p)) return moveSel(p, e.ctrlKey);
    commitPending();
    return S.selMode === 'free' ? lassoGesture(p) : marqueeGesture(p);
  }

  function marqueeGesture(p) {
    const sx = clamp(Math.round(p.x), 0, W());
    const sy = clamp(Math.round(p.y), 0, H());
    let r = null;
    return {
      move(pts, ev) {
        const q = pts[pts.length - 1];
        let ex = clamp(Math.round(q.x), 0, W());
        let ey = clamp(Math.round(q.y), 0, H());
        if (ev.shiftKey) {
          const d = Math.min(Math.max(Math.abs(ex - sx), Math.abs(ey - sy)), ex >= sx ? W() - sx : sx, ey >= sy ? H() - sy : sy);
          ex = sx + (ex >= sx ? d : -d);
          ey = sy + (ey >= sy ? d : -d);
        }
        r = { x: Math.min(sx, ex), y: Math.min(sy, ey), w: Math.abs(ex - sx), h: Math.abs(ey - sy) };
        marquee = r;
        overlay();
      },
      up() {
        marquee = null;
        if (r && r.w >= 1 && r.h >= 1) sel = { ...r, ow: r.w, oh: r.h, rings: null };
        overlay();
        changed();
      },
      cancel() {
        marquee = null;
        overlay();
      },
    };
  }

  function lassoGesture(p) {
    const pts = [[clamp(p.x, 0, W()), clamp(p.y, 0, H())]];
    marquee = { lasso: pts };
    return {
      move(list) {
        for (const q of list) pts.push([clamp(q.x, 0, W()), clamp(q.y, 0, H())]);
        overlay();
      },
      up() {
        marquee = null;
        let x0 = Infinity;
        let y0 = Infinity;
        let x1 = -Infinity;
        let y1 = -Infinity;
        for (const [x, y] of pts) {
          x0 = Math.min(x0, x);
          y0 = Math.min(y0, y);
          x1 = Math.max(x1, x);
          y1 = Math.max(y1, y);
        }
        const x = Math.floor(x0);
        const y = Math.floor(y0);
        const w = Math.ceil(x1) - x;
        const hh = Math.ceil(y1) - y;
        if (pts.length > 2 && w >= 2 && hh >= 2) sel = { x, y, w, h: hh, ow: w, oh: hh, rings: [pts.map(([px, py]) => [px - x, py - y])] };
        overlay();
        changed();
      },
      cancel() {
        marquee = null;
        overlay();
      },
    };
  }

  function lift(dup) {
    const r = clipRect(sel, W(), H());
    if (!r) return false;
    const c = makeCanvas(r.w, r.h);
    const cc = c.getContext('2d');
    cc.drawImage(docCanvas, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
    if (sel.rings) {
      cc.globalCompositeOperation = 'destination-in';
      cc.translate(-r.x, -r.y);
      cc.fill(selPath(), 'evenodd');
    }
    if (!dup) {
      sel.beforeLift = docCtx.getImageData(r.x, r.y, r.w, r.h);
      sel.liftRect = r;
      sel.hole = true;
      docCtx.save();
      docCtx.fillStyle = S.secondary;
      docCtx.fill(selPath(), 'evenodd');
      docCtx.restore();
    } else sel.hole = false;
    if (sel.rings) {
      const kx = sel.w / (sel.ow || sel.w);
      const ky = sel.h / (sel.oh || sel.h);
      sel.rings = sel.rings.map((ring) => ring.map(([x, y]) => [sel.x + x * kx - r.x, sel.y + y * ky - r.y]));
    }
    Object.assign(sel, { x: r.x, y: r.y, w: r.w, h: r.h, ow: r.w, oh: r.h, float: c });
    refreshDisp();
    return true;
  }

  function refreshDisp() {
    if (!sel?.float) {
      floatBox.hidden = true;
      floatBox.replaceChildren();
      return;
    }
    let d = sel.float;
    if (S.transparentSel) {
      d = cloneCanvas(sel.float);
      const dc = d.getContext('2d');
      const img = dc.getImageData(0, 0, d.width, d.height);
      const [r, g, b] = hexToRgb(S.secondary);
      const px = img.data;
      for (let i = 0; i < px.length; i += 4) if (px[i] === r && px[i + 1] === g && px[i + 2] === b) px[i + 3] = 0;
      dc.putImageData(img, 0, 0);
    }
    d.className = 'pt-float-cv';
    sel.disp = d;
    floatBox.replaceChildren(d);
    overlay();
  }

  function dropFloat() {
    const s = sel;
    if (!s?.float) return;
    const dst = { x: s.x, y: s.y, w: s.w, h: s.h };
    const U = clipRect(s.hole ? union(dst, s.liftRect) : dst, W(), H());
    if (U) {
      const before = docCtx.getImageData(U.x, U.y, U.w, U.h);
      if (s.hole) blit(before, U, s.beforeLift, s.liftRect);
      history.pushRegionData(U, before);
      docCtx.save();
      docCtx.imageSmoothingEnabled = s.w !== s.disp.width || s.h !== s.disp.height;
      docCtx.imageSmoothingQuality = 'high';
      docCtx.drawImage(s.disp, dst.x, dst.y, dst.w, dst.h);
      docCtx.restore();
    }
    Object.assign(s, { float: null, disp: null, hole: false, beforeLift: null, liftRect: null, ow: s.w, oh: s.h });
    floatBox.hidden = true;
    floatBox.replaceChildren();
  }

  function commitSelection() {
    if (!sel) return;
    if (sel.float) dropFloat();
    sel = null;
    overlay();
    changed();
  }

  function cancelFloat() {
    const s = sel;
    if (s.hole) docCtx.putImageData(s.beforeLift, s.liftRect.x, s.liftRect.y);
    sel = null;
    floatBox.hidden = true;
    floatBox.replaceChildren();
    overlay();
    changed();
  }

  function moveSel(p, dup) {
    const ox = sel.x;
    const oy = sel.y;
    let started = false;
    return {
      move(pts) {
        if (!sel) return;
        const q = pts[pts.length - 1];
        const dx = Math.round(q.x - p.x);
        const dy = Math.round(q.y - p.y);
        if (!started) {
          if (!dx && !dy) return;
          started = true;
          if (dup && sel.float) {
            dropFloat(); // leave a copy behind, keep moving a duplicate
            lift(true);
          } else if (!sel.float && !lift(dup)) return;
        }
        sel.x = ox + dx;
        sel.y = oy + dy;
        overlay();
        changed();
      },
      cancel() {
        if (sel) {
          sel.x = ox;
          sel.y = oy;
          overlay();
        }
      },
    };
  }

  function selHandle(id) {
    if (!sel.float && !lift(false)) return null;
    const o = { x: sel.x, y: sel.y, w: sel.w, h: sel.h };
    return {
      move(pts, ev) {
        const q = pts[pts.length - 1];
        let l = o.x;
        let tp = o.y;
        let r = o.x + o.w;
        let b = o.y + o.h;
        if (id.includes('w')) l = Math.min(r - 1, Math.round(q.x));
        if (id.includes('e')) r = Math.max(l + 1, Math.round(q.x));
        if (id.includes('n')) tp = Math.min(b - 1, Math.round(q.y));
        if (id.includes('s')) b = Math.max(tp + 1, Math.round(q.y));
        if (ev.shiftKey && id.length === 2) {
          const k = Math.max((r - l) / o.w, (b - tp) / o.h);
          const nw = Math.max(1, Math.round(o.w * k));
          const nh = Math.max(1, Math.round(o.h * k));
          if (id.includes('w')) l = r - nw;
          else r = l + nw;
          if (id.includes('n')) tp = b - nh;
          else b = tp + nh;
        }
        Object.assign(sel, { x: l, y: tp, w: r - l, h: b - tp });
        overlay();
        changed();
      },
      cancel() {
        Object.assign(sel, o);
        overlay();
      },
    };
  }

  function selectionCanvas() {
    if (!sel) return null;
    if (sel.float) return sel.w === sel.disp.width && sel.h === sel.disp.height ? sel.disp : scaledCanvas(sel.disp, sel.w, sel.h);
    const r = clipRect(sel, W(), H());
    if (!r) return null;
    const c = makeCanvas(r.w, r.h);
    const cc = c.getContext('2d');
    cc.drawImage(docCanvas, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
    if (sel.rings) {
      cc.globalCompositeOperation = 'destination-in';
      cc.translate(-r.x, -r.y);
      cc.fill(selPath(), 'evenodd');
    }
    return c;
  }

  function selectAll() {
    commitPending();
    if (S.tool !== 'select') setTool('select');
    sel = { x: 0, y: 0, w: W(), h: H(), ow: W(), oh: H(), rings: null };
    overlay();
    changed();
  }

  function invertSelection() {
    if (!sel) return;
    if (sel.float) dropFloat();
    const inner = sel.rings ? ringsAt(sel) : [[[sel.x, sel.y], [sel.x + sel.w, sel.y], [sel.x + sel.w, sel.y + sel.h], [sel.x, sel.y + sel.h]]];
    const outer = [[0, 0], [W(), 0], [W(), H()], [0, H()]];
    sel = { x: 0, y: 0, w: W(), h: H(), ow: W(), oh: H(), rings: [outer, ...inner] };
    overlay();
    changed();
  }

  function deleteSelection() {
    if (!sel) return;
    if (sel.float) {
      if (sel.hole) history.pushRegionData(sel.liftRect, sel.beforeLift);
    } else {
      const r = clipRect(sel, W(), H());
      if (r) {
        history.recordRegion(r);
        docCtx.save();
        docCtx.fillStyle = S.secondary;
        docCtx.fill(selPath(), 'evenodd');
        docCtx.restore();
      }
    }
    sel = null;
    floatBox.hidden = true;
    floatBox.replaceChildren();
    overlay();
    changed();
  }

  function crop() {
    if (!sel) return;
    const content = selectionCanvas();
    if (!content) return;
    const s = sel;
    if (s.float && s.hole) docCtx.putImageData(s.beforeLift, s.liftRect.x, s.liftRect.y);
    sel = null;
    floatBox.hidden = true;
    floatBox.replaceChildren();
    history.recordFull();
    const c = makeCanvas(content.width, content.height);
    const cc = c.getContext('2d');
    if (s.rings) {
      cc.fillStyle = S.secondary;
      cc.fillRect(0, 0, c.width, c.height);
    }
    cc.drawImage(content, 0, 0);
    setDocFrom(c);
    changed();
  }

  function selContextMenu(e) {
    const c = (k) => can(k);
    ui.menu(e, [
      { label: t('edit.cut'), icon: 'cut', shortcut: 'Ctrl+X', disabled: !c('cut'), action: () => cmd('cut') },
      { label: t('edit.copy'), icon: 'copy', shortcut: 'Ctrl+C', disabled: !c('copy'), action: () => cmd('copy') },
      { label: t('edit.paste'), icon: 'clipboard_paste', shortcut: 'Ctrl+V', action: () => cmd('paste') },
      '-',
      { label: t('edit.selectAll'), icon: 'select_all_on', shortcut: 'Ctrl+A', action: () => cmd('selectAll') },
      { label: t('edit.invert'), icon: 'select_all_off', disabled: !c('invertSel'), action: () => cmd('invertSel') },
      { label: t('edit.delete'), icon: 'delete', shortcut: 'Del', disabled: !c('deleteSel'), action: () => cmd('deleteSel') },
      { label: t('edit.crop'), icon: 'crop', disabled: !c('crop'), action: () => cmd('crop') },
      '-',
      {
        label: t('image.rotate'),
        icon: 'arrow_rotate_clockwise',
        submenu: [
          { label: t('image.rotR'), icon: 'rotate_right', action: () => cmd('rotR') },
          { label: t('image.rotL'), icon: 'rotate_left', action: () => cmd('rotL') },
          { label: t('image.rot180'), action: () => cmd('rot180') },
        ],
      },
      {
        label: t('image.flip'),
        icon: 'flip_horizontal',
        submenu: [
          { label: t('image.flipV'), icon: 'flip_vertical', action: () => cmd('flipV') },
          { label: t('image.flipH'), icon: 'flip_horizontal', action: () => cmd('flipH') },
        ],
      },
      { label: t('image.resize'), icon: 'resize_image', shortcut: 'Ctrl+W', action: () => cmd('resize') },
    ]);
  }

  // ------------------------------------------------------------------ text
  function textOpts() {
    const o = S.text;
    return { family: o.family, sizePx: o.sizePt * PT_TO_PX, bold: o.bold, italic: o.italic, underline: o.underline, strike: o.strike, color: S.primary, background: o.opaque ? S.secondary : null };
  }

  function startText(p) {
    if (textEdit) {
      commitText();
      return null;
    }
    commitPending();
    if (!insideDoc(p)) return null;
    const sx = Math.round(p.x);
    const sy = Math.round(p.y);
    let r = null;
    return {
      move(pts) {
        const q = pts[pts.length - 1];
        const ex = clamp(Math.round(q.x), 0, W());
        const ey = clamp(Math.round(q.y), 0, H());
        r = { x: Math.min(sx, ex), y: Math.min(sy, ey), w: Math.abs(ex - sx), h: Math.abs(ey - sy) };
        ghost = r;
        overlay();
      },
      up() {
        ghost = null;
        const lh = metrics(liveCtx, textOpts()).lineHeight;
        if (!r || r.w < 12 || r.h < 8) {
          const w = Math.min(W(), clamp(lh * 8, 160, 480));
          r = { x: Math.max(0, Math.min(sx, W() - w)), y: Math.max(0, Math.min(sy, H() - lh)), w, h: lh };
        }
        r.h = Math.min(Math.max(r.h, lh), H() - r.y);
        createTextBox(r);
      },
      cancel() {
        ghost = null;
        overlay();
      },
    };
  }

  function createTextBox(r) {
    const ta = h('textarea', { class: 'pt-ta', spellcheck: false, 'aria-label': t('tools.text'), autocomplete: 'off' });
    const frame = h('div', { class: 'pt-tb-frame', dataset: { h: 'move', kind: 'text' } });
    const wrap = h('div', { class: 'pt-textbox' }, frame, ta);
    for (const d of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) wrap.appendChild(h('div', { class: `pt-h pt-h-${d}`, dataset: { h: d, kind: 'text' } }));
    ovl.appendChild(wrap);
    textEdit = { ...r, wrap, ta };
    ta.addEventListener('input', () => {
      renderTextLive();
      updateTitle();
    });
    ta.addEventListener('keydown', (e) => {
      const k = e.key.toLowerCase();
      if (e.key === 'Escape' || (e.key === 'Enter' && e.ctrlKey)) {
        e.preventDefault();
        e.stopPropagation();
        commitText();
        scroller.focus({ preventScroll: true });
      } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && ['b', 'i', 'u'].includes(k)) {
        e.preventDefault();
        e.stopPropagation();
        const key = { b: 'bold', i: 'italic', u: 'underline' }[k];
        setTextOpt(key, !S.text[key]);
      }
    });
    renderTextLive();
    changed();
    setTimeout(() => ta.focus({ preventScroll: true }), 0);
  }

  function positionText() {
    if (!textEdit) return;
    const te = textEdit;
    const s = L.scale;
    const o = textOpts();
    Object.assign(te.wrap.style, { left: `${te.x * s}px`, top: `${te.y * s}px`, width: `${te.w * s}px`, height: `${te.h * s}px` });
    const met = metrics(liveCtx, o);
    te.ta.style.font = fontString(o, s);
    te.ta.style.lineHeight = `${met.lineHeight * s}px`;
    te.ta.style.caretColor = luminance(S.primary) > 0.8 ? '#000000' : S.primary;
  }

  function renderTextLive() {
    if (!textEdit) return;
    const te = textEdit;
    const o = textOpts();
    const lay = layoutText(liveCtx, te.ta.value, te.w, o);
    const need = Math.max(lay.lineHeight, lay.lines.length * lay.lineHeight);
    if (need > te.h) te.h = Math.min(need, H() - te.y);
    clearLive();
    renderText(liveCtx, te, te.ta.value, o);
    positionText();
    overlay();
  }

  function textHandle(id, p) {
    const te = textEdit;
    const o = { x: te.x, y: te.y, w: te.w, h: te.h };
    return {
      move(pts) {
        const q = pts[pts.length - 1];
        const dx = Math.round(q.x - p.x);
        const dy = Math.round(q.y - p.y);
        if (id === 'move') {
          te.x = clamp(o.x + dx, 0, Math.max(0, W() - te.w));
          te.y = clamp(o.y + dy, 0, Math.max(0, H() - te.h));
        } else {
          let l = o.x;
          let tp = o.y;
          let r = o.x + o.w;
          let b = o.y + o.h;
          if (id.includes('w')) l = clamp(o.x + dx, 0, r - 10);
          if (id.includes('e')) r = clamp(o.x + o.w + dx, l + 10, W());
          if (id.includes('n')) tp = clamp(o.y + dy, 0, b - 8);
          if (id.includes('s')) b = clamp(o.y + o.h + dy, tp + 8, H());
          Object.assign(te, { x: l, y: tp, w: r - l, h: b - tp });
        }
        renderTextLive();
      },
      up() {
        textEdit?.ta.focus({ preventScroll: true });
      },
      cancel() {
        Object.assign(te, o);
        renderTextLive();
      },
    };
  }

  function commitText() {
    if (!textEdit) return;
    const te = textEdit;
    textEdit = null;
    const hadFocus = te.wrap.contains(document.activeElement);
    te.wrap.remove();
    clearLive();
    const text = te.ta.value;
    if (text.trim()) {
      const r = { x: te.x, y: te.y, w: te.w, h: te.h };
      history.recordRegion(r);
      renderText(docCtx, r, text, textOpts());
    }
    if (hadFocus) scroller.focus({ preventScroll: true });
    overlay();
    changed();
  }

  function cancelText() {
    if (!textEdit) return;
    textEdit.wrap.remove();
    textEdit = null;
    clearLive();
    scroller.focus({ preventScroll: true });
    overlay();
    changed();
  }

  // ------------------------------------------------------------------ pending edits
  function commitPending() {
    commitText();
    if (poly) finishPolygon();
    if (pend) commitShape();
    if (sel) commitSelection();
  }

  function resetEditing() {
    cancelGesture();
    if (textEdit) {
      textEdit.wrap.remove();
      textEdit = null;
    }
    pend = poly = sel = marquee = ghost = null;
    floatBox.hidden = true;
    floatBox.replaceChildren();
    clearLive();
    overlay();
  }

  // ------------------------------------------------------------------ whole-image operations
  function setDocFrom(c) {
    setSize(c.width, c.height);
    docCtx.clearRect(0, 0, c.width, c.height);
    docCtx.drawImage(c, 0, 0);
  }

  function resizeRaw(nw, nh, anchor = 'tl') {
    const old = cloneCanvas(docCanvas);
    setSize(nw, nh);
    docCtx.fillStyle = S.secondary;
    docCtx.fillRect(0, 0, nw, nh);
    const ax = /l$/.test(anchor) ? 0 : /r$/.test(anchor) ? 1 : 0.5;
    const ay = anchor.startsWith('t') ? 0 : anchor.startsWith('b') ? 1 : 0.5;
    docCtx.clearRect(Math.round((nw - old.width) * ax), Math.round((nh - old.height) * ay), old.width, old.height);
    docCtx.drawImage(old, Math.round((nw - old.width) * ax), Math.round((nh - old.height) * ay));
  }

  function resizeCanvas(nw, nh, anchor = 'tl') {
    commitPending();
    nw = clamp(Math.round(nw), 1, MAX_DIM);
    nh = clamp(Math.round(nh), 1, MAX_DIM);
    if (nw === W() && nh === H()) return;
    history.recordFull();
    resizeRaw(nw, nh, anchor);
    changed();
  }

  function canvasResizeGesture(id) {
    commitPending();
    const ow = W();
    const oh = H();
    let nw = ow;
    let nh = oh;
    return {
      move(pts) {
        const q = pts[pts.length - 1];
        if (id.includes('e')) nw = clamp(Math.round(q.x), 1, MAX_DIM);
        if (id.includes('s')) nh = clamp(Math.round(q.y), 1, MAX_DIM);
        ghost = { x: 0, y: 0, w: nw, h: nh };
        overlay();
        chrome.setStatus({ size: fmtSize(nw, nh) });
      },
      up() {
        ghost = null;
        overlay();
        if (nw !== ow || nh !== oh) resizeCanvas(nw, nh, 'tl');
      },
      cancel() {
        ghost = null;
        overlay();
      },
    };
  }

  const XF = {
    rotR: { canvas: (src) => xform(src, src.height, src.width, [0, 1, -1, 0, src.height, 0]), ring: (x, y, w, hh) => [hh - y, x], swap: true },
    rotL: { canvas: (src) => xform(src, src.height, src.width, [0, -1, 1, 0, 0, src.width]), ring: (x, y, w) => [y, w - x], swap: true },
    rot180: { canvas: (src) => xform(src, src.width, src.height, [-1, 0, 0, -1, src.width, src.height]), ring: (x, y, w, hh) => [w - x, hh - y] },
    flipH: { canvas: (src) => xform(src, src.width, src.height, [-1, 0, 0, 1, src.width, 0]), ring: (x, y, w) => [w - x, y] },
    flipV: { canvas: (src) => xform(src, src.width, src.height, [1, 0, 0, -1, 0, src.height]), ring: (x, y, w, hh) => [x, hh - y] },
  };
  function xform(src, w, hh, m) {
    const c = makeCanvas(w, hh);
    const cc = c.getContext('2d');
    cc.imageSmoothingEnabled = false;
    cc.setTransform(...m);
    cc.drawImage(src, 0, 0);
    return c;
  }

  function transform(id) {
    const x = XF[id];
    if (sel && S.tool === 'select') {
      if (!sel.float && !lift(false)) return;
      let src = sel.float;
      if (sel.w !== src.width || sel.h !== src.height) src = scaledCanvas(src, sel.w, sel.h);
      const out = x.canvas(src);
      if (sel.rings) {
        const ow = sel.ow;
        const oh = sel.oh;
        const kx = sel.w / ow;
        const ky = sel.h / oh;
        sel.rings = sel.rings.map((r) => r.map(([px, py]) => x.ring(px * kx, py * ky, sel.w, sel.h)));
      }
      Object.assign(sel, { float: out, w: out.width, h: out.height, ow: out.width, oh: out.height });
      refreshDisp();
      changed();
      return;
    }
    commitPending();
    history.recordFull();
    setDocFrom(x.canvas(cloneCanvas(docCanvas)));
    changed();
  }

  function resizeSkewCanvas(src, nw, nh, skH, skV, bg) {
    let c = scaledCanvas(src, nw, nh);
    if (skH || skV) {
      const tx = Math.tan((skH * Math.PI) / 180);
      const ty = Math.tan((skV * Math.PI) / 180);
      const ow = Math.round(nw + Math.abs(tx) * nh);
      const oh = Math.round(nh + Math.abs(ty) * nw);
      if (ow > MAX_DIM || oh > MAX_DIM || ow * oh > MAX_AREA) throw new Error(t('resize.errTooBig', { max: MAX_DIM }));
      const o = makeCanvas(ow, oh);
      const oc = o.getContext('2d');
      if (bg) {
        oc.fillStyle = bg;
        oc.fillRect(0, 0, ow, oh);
      }
      oc.imageSmoothingQuality = 'high';
      oc.setTransform(1, ty, tx, 1, tx < 0 ? -tx * nh : 0, ty < 0 ? -ty * nw : 0);
      oc.drawImage(c, 0, 0);
      c = o;
    }
    return c;
  }

  async function resizeImageDlg() {
    const onSel = !!(sel && S.tool === 'select');
    const w = onSel ? Math.round(sel.w) : W();
    const hh = onSel ? Math.round(sel.h) : H();
    const r = await resizeDialog(app, { w, h: hh, selection: onSel });
    if (!r) return;
    if (r.w === w && r.h === hh && !r.skewH && !r.skewV) return;
    if (onSel && sel) {
      if (!sel.float && !lift(false)) return;
      const src = sel.w !== sel.float.width || sel.h !== sel.float.height ? scaledCanvas(sel.float, sel.w, sel.h) : sel.float;
      const out = resizeSkewCanvas(src, r.w, r.h, r.skewH, r.skewV, null);
      Object.assign(sel, { float: out, w: out.width, h: out.height, ow: out.width, oh: out.height, rings: r.skewH || r.skewV ? null : sel.rings });
      refreshDisp();
      changed();
      return;
    }
    commitPending();
    const out = resizeSkewCanvas(cloneCanvas(docCanvas), r.w, r.h, r.skewH, r.skewV, S.secondary);
    history.recordFull();
    setDocFrom(out);
    changed();
  }

  async function imageProps() {
    commitPending();
    const r = await propertiesDialog(app, { w: W(), h: H(), file, defaults: { w: DEFAULT_W, h: DEFAULT_H } });
    if (r) resizeCanvas(r.w, r.h, r.anchor);
  }

  // ------------------------------------------------------------------ clipboard
  async function copy() {
    const c = selectionCanvas();
    if (!c) return false;
    try {
      const bytes = await encodeCanvas(c, 'png');
      await api.invoke('clipboard:writeImage', bytes);
      return true;
    } catch (err) {
      await showError(t('err.copy'), err);
      return false;
    }
  }
  async function cut() {
    if (await copy()) deleteSelection();
  }
  async function paste() {
    let bmp = null;
    try {
      const bytes = await api.invoke('clipboard:readImage');
      if (bytes?.length) bmp = await decodeImage(bytes);
    } catch (err) {
      console.warn('[paint] clipboard read failed', err);
    }
    if (!bmp) {
      const files = shell?.clipboard?.getFiles?.();
      const img = files?.paths?.find((p) => OPEN_EXTS.includes(extOf(p)));
      if (img) return pasteFromPath(img);
      await ui.alert(t('err.noImage'), { title: 'Paint', parent: win });
      return;
    }
    pasteBitmap(bmp);
  }
  function pasteBitmap(bmp) {
    commitPending();
    const c = makeCanvas(bmp.width, bmp.height);
    c.getContext('2d').drawImage(bmp, 0, 0);
    bmp.close?.();
    if (c.width > W() || c.height > H()) {
      history.recordFull();
      resizeRaw(Math.max(W(), c.width), Math.max(H(), c.height), 'tl');
    }
    if (S.tool !== 'select') setTool('select');
    const vx = clamp(Math.floor((scroller.scrollLeft - L.left) / L.scale), 0, Math.max(0, W() - c.width));
    const vy = clamp(Math.floor((scroller.scrollTop - L.top) / L.scale), 0, Math.max(0, H() - c.height));
    sel = { x: vx, y: vy, w: c.width, h: c.height, ow: c.width, oh: c.height, rings: null, float: c, hole: false };
    refreshDisp();
    overlay();
    changed();
    scroller.focus({ preventScroll: true });
  }
  async function pasteFromPath(path) {
    try {
      pasteBitmap(await decodeImage(await api.invoke('fs:readBytes', path)));
    } catch (err) {
      await showError(t('err.open', { name: baseName(path) }), err);
    }
  }
  async function pasteFromFile() {
    const path = await ui.filePicker({ mode: 'open', filters: [{ name: t('fmt.all'), ext: OPEN_EXTS }], path: dirOf(file.path) || shell?.xdg?.pictures, parent: win });
    if (path) await pasteFromPath(path);
  }

  // ------------------------------------------------------------------ files
  function blank(w = DEFAULT_W, hh = DEFAULT_H) {
    resetEditing();
    setSize(w, hh);
    docCtx.fillStyle = '#ffffff';
    docCtx.fillRect(0, 0, w, hh);
    Object.assign(file, { path: null, name: null, format: 'png', size: null, mtime: null });
    history.clear();
    savedState = history.state;
    initialZoom();
    changed();
  }

  async function statFile() {
    if (!file.path) return;
    try {
      const st = await api.invoke('fs:stat', file.path);
      file.size = st?.size ?? null;
      file.mtime = st?.mtime ?? null;
    } catch {
      file.size = null;
    }
    updateStatus();
  }

  async function openPath(path, { prompt = true } = {}) {
    if (prompt && !(await confirmDiscard())) return false;
    let bmp;
    try {
      const bytes = await api.invoke('fs:readBytes', path);
      bmp = await decodeImage(bytes);
    } catch (err) {
      await showError(t('err.open', { name: baseName(path) }), err.code === 'ENOENT' ? new Error(t('err.notFound')) : err);
      return false;
    }
    if (bmp.width * bmp.height > MAX_AREA || bmp.width > MAX_DIM || bmp.height > MAX_DIM) {
      bmp.close?.();
      await showError(t('err.tooBig', { name: baseName(path) }));
      return false;
    }
    resetEditing();
    setSize(bmp.width, bmp.height);
    docCtx.clearRect(0, 0, bmp.width, bmp.height);
    docCtx.drawImage(bmp, 0, 0);
    bmp.close?.();
    Object.assign(file, { path, name: baseName(path), format: formatOf(path) || 'png', size: null, mtime: null });
    history.clear();
    savedState = history.state;
    addRecent(path);
    initialZoom();
    changed();
    statFile();
    return true;
  }

  async function openDialog() {
    if (!(await confirmDiscard())) return;
    const path = await ui.filePicker({ mode: 'open', filters: [{ name: t('fmt.all'), ext: OPEN_EXTS }], path: dirOf(file.path) || shell?.xdg?.pictures, parent: win });
    if (path) await openPath(path, { prompt: false });
  }

  async function newImage() {
    if (!(await confirmDiscard())) return;
    blank();
  }

  async function writeFile(path, fmt) {
    try {
      const bytes = await encodeCanvas(docCanvas, fmt);
      await api.invoke('fs:writeBytes', path, bytes);
    } catch (err) {
      await showError(t('err.save', { name: baseName(path) }), err);
      return false;
    }
    Object.assign(file, { path, name: baseName(path), format: fmt });
    savedState = history.state;
    addRecent(path);
    changed();
    await statFile();
    return true;
  }

  async function save() {
    commitPending();
    if (!file.path || !FORMATS[file.format]) return saveAs();
    return writeFile(file.path, file.format);
  }

  async function saveAs(fmt) {
    commitPending();
    const order = ['png', 'jpeg', 'bmp', 'gif', 'webp'];
    const first = fmt && FORMATS[fmt] ? fmt : FORMATS[file.format] ? file.format : 'png';
    const fmts = fmt ? [first] : [first, ...order.filter((f) => f !== first)];
    const base = file.path ? baseName(file.path).replace(/\.[^.]+$/, '') : t('untitled');
    const path = await ui.filePicker({
      mode: 'save',
      title: t('file.saveAs'),
      filters: fmts.map((f) => ({ name: t(`fmt.${f}`), ext: FORMATS[f].exts })),
      name: base + FORMATS[first].ext,
      path: dirOf(file.path) || shell?.xdg?.pictures,
      parent: win,
    });
    if (!path) return false;
    return writeFile(path, formatOf(path) || first);
  }

  function askSave() {
    return ui.dialog({
      title: 'Paint',
      body: t('ask.save', { name: file.name || t('untitled') }),
      parent: win,
      className: 'pt-ask',
      buttons: [
        { label: t('ask.saveBtn'), value: 'save', primary: true },
        { label: t('ask.dontSave'), value: 'discard' },
        { label: t('common.cancel'), value: null },
      ],
    });
  }

  async function confirmDiscard() {
    cancelGesture();
    commitPending();
    if (!isDirty()) return true;
    const r = await askSave();
    if (r === 'save') return save();
    return r === 'discard';
  }

  async function setWallpaper(fit) {
    commitPending();
    if (!file.path || isDirty()) {
      const ok = await ui.confirm(t('wp.mustSave'), { title: 'Paint', okLabel: t('file.save'), parent: win });
      if (!ok || !(await save())) return;
    }
    await ctx.settings.set('wallpaperFit', fit === 'tile' ? 'tile' : fit === 'center' ? 'center' : 'fill');
    await ctx.settings.set('wallpaper', file.path);
  }

  async function openFileObject(f) {
    try {
      const bmp = await decodeImage(f);
      if (!(await confirmDiscard())) return bmp.close?.();
      resetEditing();
      setSize(bmp.width, bmp.height);
      docCtx.drawImage(bmp, 0, 0);
      bmp.close?.();
      Object.assign(file, { path: null, name: f.name || null, format: formatOf(f.name) || 'png', size: f.size ?? null, mtime: null });
      history.clear();
      savedState = -1; // unsaved copy
      initialZoom();
      changed();
    } catch (err) {
      await showError(t('err.open', { name: f.name || '' }), err);
    }
  }

  // ------------------------------------------------------------------ undo / redo
  async function undo() {
    cancelGesture();
    if (textEdit) return cancelText();
    if (poly) {
      poly = null;
      clearLive();
      return changed();
    }
    if (pend) {
      pend = null;
      clearLive();
      overlay();
      return changed();
    }
    if (sel?.float) return cancelFloat();
    if (sel) {
      sel = null;
      overlay();
    }
    if (!history.canUndo) return changed();
    try {
      await history.undo();
    } catch (err) {
      await showError(t('err.undo'), err);
    }
    overlay();
    changed();
  }
  async function redo() {
    cancelGesture();
    if (pend || poly || sel?.float || textEdit || !history.canRedo) return;
    if (sel) {
      sel = null;
      overlay();
    }
    try {
      await history.redo();
    } catch (err) {
      await showError(t('err.undo'), err);
    }
    overlay();
    changed();
  }

  // ------------------------------------------------------------------ setters used by the chrome
  function sizeKey(tool = S.tool) {
    if (tool === 'pencil' || tool === 'eraser') return tool;
    if (tool === 'brush') return 'brush';
    if (tool === 'shape') return 'shape';
    return null;
  }
  function getSize() {
    return S.sizes[sizeKey() || 'brush'];
  }
  function setStrokeSize(n) {
    const k = sizeKey() || 'brush';
    S.sizes[k] = clamp(Math.round(n), 1, 50);
    if (pend && k === 'shape') {
      pend.size = S.sizes.shape;
      drawPending();
      overlay();
    }
    if (poly && k === 'shape') {
      poly.size = S.sizes.shape;
      drawPending(poly);
    }
    updateCursor();
    chrome.update();
    savePrefs();
  }
  function setTool(tool) {
    if (gesture) cancelGesture();
    if (tool === S.tool) {
      chrome.update();
      return;
    }
    commitPending();
    if (tool === 'picker') S.prevTool = S.tool;
    S.tool = tool;
    scroller.classList.remove('over-move');
    updateCursor();
    overlay();
    changed();
    savePrefs();
  }
  function setBrush(id) {
    if (!BRUSH_TOOLS.has(id)) return;
    S.brush = id;
    setTool('brush');
    chrome.update();
    savePrefs();
  }
  function setShape(id) {
    if (S.tool === 'shape' && S.shape !== id) commitPending();
    S.shape = id;
    setTool('shape');
    chrome.update();
    savePrefs();
  }
  function setOutline(v) {
    S.outline = v;
    for (const s of [pend, poly]) if (s) s.outline = v;
    if (pend || poly) drawPending();
    savePrefs();
    chrome.update();
  }
  function setFillStyle(v) {
    S.fill = v;
    for (const s of [pend, poly]) if (s) s.fill = v;
    if (pend || poly) drawPending();
    savePrefs();
    chrome.update();
  }
  function setColor(slot, hex) {
    S[slot === 'secondary' ? 'secondary' : 'primary'] = hex.toLowerCase();
    for (const s of [pend, poly]) {
      if (s) {
        s.stroke = S.primary;
        s.fillColor = S.secondary;
      }
    }
    if (pend || poly) drawPending();
    if (textEdit) renderTextLive();
    if (sel?.float && S.transparentSel && slot === 'secondary') refreshDisp();
    chrome.update();
    savePrefs();
  }
  function setSlot(slot) {
    S.slot = slot === 'secondary' ? 'secondary' : 'primary';
    chrome.update();
  }
  function setTextOpt(key, v) {
    S.text[key] = v;
    if (textEdit) {
      renderTextLive();
      textEdit.ta.focus({ preventScroll: true });
    }
    chrome.update();
    savePrefs();
  }
  function setTolerance(v) {
    S.tolerance = clamp(Math.round(v), 0, 100);
    savePrefs();
  }
  function setSelMode(m) {
    S.selMode = m === 'free' ? 'free' : 'rect';
    if (S.tool !== 'select') setTool('select');
    chrome.update();
    savePrefs();
  }

  async function editColors() {
    const slot = S.slot;
    const c = await editColorsDialog(app, S[slot]);
    if (!c) return;
    setColor(slot, c);
    S.custom = [c, ...S.custom.filter((x) => x && x !== c)].slice(0, 10);
    while (S.custom.length < 10) S.custom.push(null);
    chrome.renderCustom();
    savePrefs();
  }

  function toggleView(k) {
    if (k === 'statusbar') S.statusbar = S.statusbar === false;
    else S[k] = !S[k];
    applyView();
    savePrefs();
  }
  function applyView() {
    main.classList.toggle('rulers', !!S.rulers);
    markH.hidden = markV.hidden = true;
    chrome.update();
    layout();
  }

  function setFullscreen(on) {
    fullscreen = !!on;
    win.setFullscreen?.(fullscreen);
    root.classList.toggle('fs', fullscreen);
    requestAnimationFrame(() => layout());
  }

  // ------------------------------------------------------------------ commands
  const commands = {
    new: newImage,
    open: openDialog,
    openRecent: (p) => openPath(p),
    clearRecent: () => setRecent([]),
    save,
    saveAs,
    pasteFrom: pasteFromFile,
    wallpaper: setWallpaper,
    props: imageProps,
    about: () => aboutDialog(app),
    exit: () => win.close(),
    undo,
    redo,
    cut,
    copy,
    paste,
    selectAll,
    invertSel: invertSelection,
    deleteSel: () => {
      if (sel) deleteSelection();
      else if (pend) {
        pend = null;
        clearLive();
        overlay();
        changed();
      }
    },
    transparentSel: () => {
      S.transparentSel = !S.transparentSel;
      refreshDisp();
      savePrefs();
      changed();
    },
    crop,
    resize: resizeImageDlg,
    rotR: () => transform('rotR'),
    rotL: () => transform('rotL'),
    rot180: () => transform('rot180'),
    flipH: () => transform('flipH'),
    flipV: () => transform('flipV'),
    zoomIn: () => zoomStep(1),
    zoomOut: () => zoomStep(-1),
    zoom100: () => setZoom(1),
    zoomFit,
    rulers: () => toggleView('rulers'),
    grid: () => toggleView('grid'),
    statusbar: () => toggleView('statusbar'),
    fullscreen: () => setFullscreen(!fullscreen),
    editColors,
    swapColors: () => {
      const p = S.primary;
      setColor('primary', S.secondary);
      setColor('secondary', p);
    },
  };

  async function cmd(id, arg) {
    chrome.closeFlyout();
    const fn = commands[id];
    if (!fn) return undefined;
    try {
      return await fn(arg);
    } catch (err) {
      console.error(`[paint] ${id} failed`, err);
      await showError(t('err.generic'), err);
      return undefined;
    }
  }

  function can(id) {
    switch (id) {
      case 'undo':
        return history.canUndo || !!(pend || poly || textEdit || sel?.float);
      case 'redo':
        return history.canRedo && !(pend || poly || sel?.float || textEdit);
      case 'cut':
      case 'copy':
      case 'crop':
      case 'deleteSel':
      case 'invertSel':
        return !!sel;
      default:
        return true;
    }
  }

  // ------------------------------------------------------------------ keyboard
  function nudge(dx, dy) {
    if (sel) {
      if (!sel.float && !lift(false)) return false;
      sel.x += dx;
      sel.y += dy;
      overlay();
      changed();
      return true;
    }
    if (pend) {
      translateShape(pend, cloneShape(pend), dx, dy);
      drawPending();
      overlay();
      return true;
    }
    return false;
  }

  const TOOL_KEYS = { p: 'pencil', b: 'brush', e: 'eraser', f: 'fill', t: 'text', s: 'select', i: 'picker', z: 'zoom' };
  win.el.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.target.closest?.('.dialog-layer, .pt-flyout')) return;
    const inText = e.target.matches?.('input, textarea, select, [contenteditable="true"]');
    const k = e.key;
    const kl = k.length === 1 ? k.toLowerCase() : k;
    const ctrl = e.ctrlKey || e.metaKey;
    let done = true;
    if (gesture && k === 'Escape') cancelGesture();
    else if (ctrl && !e.altKey) {
      if (inText && ['a', 'c', 'x', 'v', 'z', 'y'].includes(kl)) return;
      if (kl === 's') cmd(e.shiftKey ? 'saveAs' : 'save');
      else if (kl === 'o') cmd('open');
      else if (kl === 'n') cmd('new');
      else if (kl === 'e') cmd('props');
      else if (kl === 'w') cmd('resize');
      else if (kl === 'z') cmd(e.shiftKey ? 'redo' : 'undo');
      else if (kl === 'y') cmd('redo');
      else if (kl === 'a') cmd('selectAll');
      else if (kl === 'c') cmd('copy');
      else if (kl === 'x') cmd(e.shiftKey ? 'crop' : 'cut');
      else if (kl === 'v') cmd('paste');
      else if (kl === 'r') cmd('rulers');
      else if (kl === 'g') cmd('grid');
      else if (k === '+' || k === '=' || k === 'PageUp' || k === 'Add') cmd('zoomIn');
      else if (k === '-' || k === '_' || k === 'PageDown' || k === 'Subtract') cmd('zoomOut');
      else if (k === '0') cmd('zoomFit');
      else if (k === '1') cmd('zoom100');
      else done = false;
    } else if (k === 'F11') cmd('fullscreen');
    else if (k === 'F12') cmd('saveAs');
    else if (inText) return;
    else if (e.altKey) done = false;
    else if (k === 'Escape') {
      if (fullscreen) setFullscreen(false);
      else if (poly) finishPolygon();
      else if (pend || sel || textEdit) commitPending();
      else done = false;
    } else if (k === 'Enter' && (poly || pend)) commitPending();
    else if (k === 'Delete') cmd('deleteSel');
    else if (k.startsWith('Arrow') && (sel || pend)) {
      const d = e.shiftKey ? 10 : 1;
      done = nudge(k === 'ArrowLeft' ? -d : k === 'ArrowRight' ? d : 0, k === 'ArrowUp' ? -d : k === 'ArrowDown' ? d : 0);
    } else if (k === '[' || k === ']') {
      if (sizeKey()) setStrokeSize(getSize() + (k === ']' ? 1 : -1));
    } else if (kl === 'x') cmd('swapColors');
    else if (TOOL_KEYS[kl] && !e.shiftKey) setTool(TOOL_KEYS[kl]);
    else done = false;
    if (done) {
      e.preventDefault();
      e.stopPropagation();
    }
  });

  // ------------------------------------------------------------------ drag & drop
  const dragHasFile = (e) => [...(e.dataTransfer?.types || [])].some((x) => x === 'Files' || x === 'text/uri-list');
  main.addEventListener('dragenter', (e) => {
    if (!dragHasFile(e)) return;
    e.preventDefault();
    main.classList.add('dropping');
  });
  main.addEventListener('dragover', (e) => {
    if (!dragHasFile(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    main.classList.add('dropping');
  });
  main.addEventListener('dragleave', (e) => {
    if (!main.contains(e.relatedTarget)) main.classList.remove('dropping');
  });
  main.addEventListener('drop', (e) => {
    e.preventDefault();
    main.classList.remove('dropping');
    const f = e.dataTransfer?.files?.[0];
    let path = f ? api.pathForFile(f) : '';
    if (!path) {
      const uri = (e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain') || '').split('\n')[0].trim();
      if (uri.startsWith('file://')) path = decodeURIComponent(new URL(uri).pathname);
      else if (uri.startsWith('/')) path = uri;
    }
    if (path) openPath(path);
    else if (f) openFileObject(f);
  });

  // ------------------------------------------------------------------ lifecycle
  win.onBeforeClose(() => confirmDiscard());
  let roFrame = 0;
  const ro = new ResizeObserver(() => {
    cancelAnimationFrame(roFrame);
    roFrame = requestAnimationFrame(() => {
      layout();
      chrome.fit();
    });
  });
  ro.observe(scroller);
  ro.observe(root);
  let mq = null;
  const onDpr = () => {
    layout();
    watchDpr();
  };
  function watchDpr() {
    mq?.removeEventListener('change', onDpr);
    mq = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    mq.addEventListener('change', onDpr);
  }
  watchDpr();
  const offTheme = ctx.settings?.on?.('theme', () => requestAnimationFrame(drawRulers));
  win.on('fullscreen', (on) => {
    if (!on && fullscreen) {
      fullscreen = false;
      root.classList.remove('fs');
      requestAnimationFrame(() => layout());
    }
  });
  ctx.onClose(() => {
    ro.disconnect();
    mq?.removeEventListener('change', onDpr);
    offTheme?.();
    clearTimeout(prefTimer);
    cancelGesture();
  });
  ctx.onLangChange(() => {
    const next = createChrome(app).build();
    chrome.closeFlyout();
    chrome.cmdbar.replaceWith(next.cmdbar);
    chrome.ctxbar.replaceWith(next.ctxbar);
    chrome.status.replaceWith(next.status);
    chrome.titlebar.replaceWith(next.titlebar);
    chrome = next;
    scroller.setAttribute('aria-label', t('canvas'));
    for (const c of cvHandles) c.dataset.tip = t('canvasResize');
    dropEl.querySelector('.pt-drop-txt').textContent = t('dropHint');
    fsExit.lastChild.textContent = t('view.exitFullscreen');
    chrome.refreshFonts();
    layout();
    changed();
    chrome.fit();
  });

  api
    .invoke('paint:fonts')
    .then((list) => {
      if (Array.isArray(list) && list.length) {
        fonts = list;
        if (!fonts.includes(S.text.family)) S.text.family = fonts.includes('Inter') ? 'Inter' : fonts[0];
        chrome.refreshFonts();
        chrome.update();
      }
    })
    .catch(() => {});

  // ------------------------------------------------------------------ start
  main.classList.toggle('rulers', !!S.rulers);
  updateCursor();
  blank();
  chrome.fit();
  if (ctx.args?.file) await openPath(ctx.args.file, { prompt: false });

  // Test / automation hook (not used by the UI).
  const testApi = {
    S,
    app,
    get file() {
      return { ...file };
    },
    get size() {
      return { w: W(), h: H() };
    },
    get sel() {
      return sel && { x: sel.x, y: sel.y, w: sel.w, h: sel.h, floating: !!sel.float };
    },
    get pending() {
      return !!(pend || poly || textEdit);
    },
    get history() {
      return { undo: history.undoStack.length, redo: history.redoStack.length, state: history.state, raw: history.rawBytes() };
    },
    dirty: isDirty,
    pixel(x, y) {
      return [...docCtx.getImageData(x, y, 1, 1).data];
    },
    hash() {
      const d = docCtx.getImageData(0, 0, W(), H()).data;
      let hsh = 2166136261 >>> 0;
      for (let i = 0; i < d.length; i += 1) hsh = Math.imul(hsh ^ d[i], 16777619) >>> 0;
      return `${W()}x${H()}:${hsh.toString(16)}`;
    },
    dataUrl: () => docCanvas.toDataURL('image/png'),
    clientPoint(x, y) {
      const r = docCanvas.getBoundingClientRect();
      return { x: r.left + ((x + 0.5) * r.width) / W(), y: r.top + ((y + 0.5) * r.height) / H() };
    },
    openPath: (p) => openPath(p, { prompt: false }),
    writeFile,
    commitPending,
    setZoom: (z) => setZoom(z),
    layout,
    zoom: () => S.zoom,
  };
  Object.defineProperty(win.el, '__paint', { value: testApi, configurable: true });

  return {
    onFocus() {},
  };
}
