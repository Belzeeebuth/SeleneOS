// « Loupe » — full-screen magnifier of the session (like Windows' Magnifier, full-screen view).
//
//   settings.magnifier = { enabled, zoom (100–1600, %), step (25 | 50 | 100), followPointer, followFocus, followCaret,
//                          smoothing, invert, toolbar, startAtLogin }   (docs/PERSONALIZATION.md §12.4)
//   Shortcuts (core/shortcuts.js, features/hotkeys.js): Super+= start / zoom in (also Super++ on the keypad and
//   Super+Shift+=), Super+- zoom out, Super+Escape stop, Super+Ctrl+M settings; Ctrl+Alt+wheel zooms while it runs.
//   ctx.magnifier = shell.magnifier = { start(), stop(), toggle(), zoomIn(), zoomOut(), setZoom(percent), active, zoom,
//                                       view() -> { z, x, y, tx, ty, mode, exact }, toScreen(rect), toPage(rect) }
//
// How it works
// • The whole page is magnified with one CSS transform on <body> (translate + scale; a composited layer, so panning
//   is cheap, painted again after each zoom step so text and icons stay sharp; fixed, so that focus() /
//   scrollIntoView() never scroll the page). Chromium hit-tests through transforms: a click always lands on what is
//   drawn under the pointer.
// • Page coordinates: while it runs, the DOM APIs that give or take viewport coordinates (MouseEvent / Touch clientX…,
//   getBoundingClientRect / getClientRects, elementFromPoint…, getScreenCTM) answer in the page's own, unmagnified
//   coordinates, so every app keeps working as it is (menus at the pointer, drags, drawing on a canvas, snapping).
//   The toolbar and the zoom pill sit in the top layer (popover): they are not magnified and keep real coordinates.
// • Pointer tracking is proportional: the view's origin is o = P × (1 − 1/z), so the point under the pointer P is
//   shown exactly where it really is on the screen.
// • Linux (X11) windows (core/features/xwin.js): a CSS transform cannot scale another X client. While the view is
//   magnified (or inverted) the shell covers them and shows a live copy of each one inside its frame (a
//   desktopCapturer window stream in a <video>). Because the point under the pointer is at its real place, the X
//   input shape of the shell window lets the pointer reach the real client exactly where its copy is shown under
//   the pointer: clicks, drags and the wheel go to the right place of the right window. When the view does not follow
//   the pointer (keyboard focus or text caret following, or pointer following turned off), Linux windows get no
//   pointer input at all (the shell takes it) until the pointer moves again. Their menus and tooltips (override-
//   redirect windows, drawn above the shell by the X server) are shown at their normal size.
// • Lock screen: it stays magnified (the person must be able to read it and type the password); the toolbar is
//   hidden, the copies of Linux windows stop, no pointer input reaches them, and only the zoom shortcuts work.
import { icon } from '../ui.js';
import { comboKeys } from '../shortcuts.js';

const MIN = 100;
const MAX = 1600;
const STEPS = [25, 50, 100];
const DEFAULTS = { enabled: false, zoom: 200, step: 100, followPointer: true, followFocus: true, followCaret: true, smoothing: true, invert: false, toolbar: true, startAtLogin: false };
const ANIM_MS = 160;
const POINTER_SLACK = 4; // px the pointer must move before the view leaves the focus / caret it was showing
const RESTORED_GRACE = 500; // ms after a Linux window comes back from minimised before it is captured again

const STRINGS = {
  en: {
    magnifier: {
      title: 'Magnifier',
      toolbar: 'Magnifier',
      zoomIn: 'Zoom in',
      zoomOut: 'Zoom out',
      level: 'Zoom level',
      settings: 'Magnifier settings',
      hide: 'Hide the toolbar',
      close: 'Turn off the magnifier',
      on: 'Magnifier on, {level}',
      off: 'Magnifier off',
      zoomed: 'Zoom {level}',
      hidden: 'Toolbar hidden. {keys} opens the magnifier settings.',
    },
  },
  fr: {
    magnifier: {
      title: 'Loupe',
      toolbar: 'Loupe',
      zoomIn: 'Zoom avant',
      zoomOut: 'Zoom arrière',
      level: 'Niveau de zoom',
      settings: 'Paramètres de la loupe',
      hide: 'Masquer la barre d’outils',
      close: 'Désactiver la loupe',
      on: 'Loupe activée, {level}',
      off: 'Loupe désactivée',
      zoomed: 'Zoom {level}',
      hidden: 'Barre d’outils masquée. {keys} ouvre les paramètres de la loupe.',
    },
  },
};

// Original DOM accessors, saved before anything patches them.
const proto = (o, n) => Object.getOwnPropertyDescriptor(o, n);
const RAW = {
  clientX: proto(MouseEvent.prototype, 'clientX').get,
  clientY: proto(MouseEvent.prototype, 'clientY').get,
  gbcr: Element.prototype.getBoundingClientRect,
};
const rawX = (e) => RAW.clientX.call(e);
const rawY = (e) => RAW.clientY.call(e);
const rawRect = (el) => RAW.gbcr.call(el);

const clampPct = (v) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(MIN, Math.min(MAX, n)) : DEFAULTS.zoom;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function mount(ctx) {
  const { api, settings, shell, i18n, t, ui, h, wm } = ctx;
  i18n.extend(STRINGS);
  ui.loadCss('app://shell/core/features/magnifier.css');
  const html = document.documentElement;
  const body = document.body;

  const conf = () => {
    const s = settings.get('magnifier') || {};
    const b = (k) => (typeof s[k] === 'boolean' ? s[k] : DEFAULTS[k]);
    return {
      enabled: s.enabled === true,
      zoom: clampPct(s.zoom ?? DEFAULTS.zoom),
      step: STEPS.includes(Number(s.step)) ? Number(s.step) : DEFAULTS.step,
      followPointer: b('followPointer'),
      followFocus: b('followFocus'),
      followCaret: b('followCaret'),
      smoothing: b('smoothing'),
      invert: b('invert'),
      toolbar: b('toolbar'),
      startAtLogin: s.startAtLogin === true,
    };
  };
  const reducedMotion = () => html.dataset.animations === 'off' || html.dataset.reducedMotion === 'on' || !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const locked = () => body.classList.contains('aurora-locked');
  const fmtPct = (pct) => {
    try {
      return new Intl.NumberFormat(i18n.lang === 'fr' ? 'fr-FR' : 'en-US', { style: 'percent', maximumFractionDigits: 0 }).format(pct / 100);
    } catch {
      return `${pct} %`;
    }
  };
  const combos = () => ctx.hotkeys?.combos?.() || {};
  const keysOf = (id) => {
    const c = combos()[id];
    return c ? comboKeys(c, i18n.lang).join(' + ') : '';
  };

  // ------------------------------------------------------------------ state
  let active = false;
  let z = 1; // current scale
  let zTarget = 1;
  const o = { x: 0, y: 0 }; // view origin, page coordinates
  const V = { z: 1, tx: 0, ty: 0 }; // applied transform: screen = page × z + t
  let P = null; // last pointer position (screen = viewport CSS px)
  let mode = 'pointer'; // 'pointer' | 'focus' | 'static'
  let anchor = null; // pointer position when the view left the pointer
  let anim = 0;
  let animating = false;
  let lastPointerDown = 0;
  let lastKey = 0;
  let saveTimer = 0;
  let startToken = 0;
  let patched = null; // restore() of the DOM patches
  const exempt = []; // unmagnified roots (toolbar, pill): real coordinates

  const W = () => window.innerWidth || 1;
  const H = () => window.innerHeight || 1;
  const isMagnified = () => active && (z !== 1 || zTarget !== 1 || conf().invert);
  const exact = () => active && (z === 1 ? !o.x && !o.y : mode === 'pointer' && !!P);

  // ------------------------------------------------------------------ coordinates
  const isExempt = (n) => {
    if (!n || typeof n !== 'object' || !(n instanceof Node)) return false;
    for (const r of exempt) if (r === n || r.contains(n)) return true;
    return false;
  };
  const identity = () => V.z === 1 && !V.tx && !V.ty;
  const toPage = (r) => new DOMRect((r.x - V.tx) / V.z, (r.y - V.ty) / V.z, r.width / V.z, r.height / V.z);
  const toScreen = (r) => new DOMRect(r.x * V.z + V.tx, r.y * V.z + V.ty, r.width * V.z, r.height * V.z);

  // Make the page believe it is not magnified (see the header). Every patch is the identity while the view is 1:1.
  function installPatches() {
    if (patched) return;
    const saved = [];
    const def = (target, name, make) => {
      const d = target && proto(target, name);
      if (!d) return;
      saved.push([target, name, d]);
      Object.defineProperty(target, name, { ...make(d), enumerable: d.enumerable, configurable: true });
    };
    const shifted = (e) => e.isTrusted && !identity() && !isExempt(e.target);
    const axisGetter = (axis) => (d) => ({
      get() {
        const v = d.get.call(this);
        if (!shifted(this)) return v;
        return axis === 'x' ? (v - V.tx) / V.z : (v - V.ty) / V.z;
      },
      set: undefined,
    });
    for (const [n, a] of [['clientX', 'x'], ['clientY', 'y'], ['x', 'x'], ['y', 'y'], ['pageX', 'x'], ['pageY', 'y']]) def(MouseEvent.prototype, n, axisGetter(a));
    for (const [n, a] of [['screenX', 'x'], ['screenY', 'y']]) {
      def(MouseEvent.prototype, n, (d) => ({
        get() {
          const v = d.get.call(this);
          if (!shifted(this)) return v;
          const c = a === 'x' ? rawX(this) : rawY(this);
          return v - c + (a === 'x' ? (c - V.tx) / V.z : (c - V.ty) / V.z);
        },
        set: undefined,
      }));
    }
    for (const n of ['movementX', 'movementY']) def(MouseEvent.prototype, n, (d) => ({ get() { const v = d.get.call(this); return shifted(this) ? v / V.z : v; }, set: undefined }));
    if (typeof Touch !== 'undefined') {
      for (const [n, a] of [['clientX', 'x'], ['clientY', 'y'], ['pageX', 'x'], ['pageY', 'y']]) {
        def(Touch.prototype, n, (d) => ({
          get() {
            const v = d.get.call(this);
            if (identity() || isExempt(this.target)) return v;
            return a === 'x' ? (v - V.tx) / V.z : (v - V.ty) / V.z;
          },
          set: undefined,
        }));
      }
    }
    const rectMethod = (owner) => (d) => ({
      value: function getBoundingClientRect() {
        const r = d.value.call(this);
        return identity() || isExempt(owner(this)) ? r : toPage(r);
      },
      writable: true,
    });
    const listMethod = (owner) => (d) => ({
      value: function getClientRects() {
        const list = d.value.call(this);
        if (identity() || isExempt(owner(this))) return list;
        const out = [...list].map(toPage);
        out.item = (i) => out[i] ?? null;
        return out;
      },
      writable: true,
    });
    def(Element.prototype, 'getBoundingClientRect', rectMethod((el) => el));
    def(Element.prototype, 'getClientRects', listMethod((el) => el));
    def(Range.prototype, 'getBoundingClientRect', rectMethod((r) => r.commonAncestorContainer));
    def(Range.prototype, 'getClientRects', listMethod((r) => r.commonAncestorContainer));
    const pointMethod = (d) => ({
      value: function (x, y, ...rest) {
        if (identity()) return d.value.call(this, x, y, ...rest);
        return d.value.call(this, x * V.z + V.tx, y * V.z + V.ty, ...rest);
      },
      writable: true,
    });
    for (const target of [Document.prototype, typeof ShadowRoot !== 'undefined' ? ShadowRoot.prototype : null]) {
      for (const n of ['elementFromPoint', 'elementsFromPoint', 'caretRangeFromPoint', 'caretPositionFromPoint']) def(target, n, pointMethod);
    }
    if (typeof SVGGraphicsElement !== 'undefined') {
      def(SVGGraphicsElement.prototype, 'getScreenCTM', (d) => ({
        value: function getScreenCTM() {
          const m = d.value.call(this);
          if (!m || identity() || isExempt(this)) return m;
          return new DOMMatrix([1 / V.z, 0, 0, 1 / V.z, -V.tx / V.z, -V.ty / V.z]).multiply(m);
        },
        writable: true,
      }));
    }
    patched = () => {
      for (const [target, name, d] of saved.reverse()) Object.defineProperty(target, name, d);
    };
  }
  function removePatches() {
    patched?.();
    patched = null;
  }

  // ------------------------------------------------------------------ view
  function clampOrigin() {
    const maxX = Math.max(0, W() - W() / z);
    const maxY = Math.max(0, H() - H() / z);
    o.x = Math.max(0, Math.min(maxX, o.x));
    o.y = Math.max(0, Math.min(maxY, o.y));
  }
  function pointerOrigin() {
    if (!P) return;
    const px = Math.max(0, Math.min(W(), P.x));
    const py = Math.max(0, Math.min(H(), P.y));
    o.x = px * (1 - 1 / z);
    o.y = py * (1 - 1 / z);
  }
  function apply() {
    if (!active) return;
    clampOrigin();
    if (z === 1) {
      o.x = 0;
      o.y = 0;
    }
    // Whole device pixels for the translation: crisp layers. (The patches use the values really applied.)
    const tx = Math.round(-o.x * z);
    const ty = Math.round(-o.y * z);
    V.z = z;
    V.tx = tx;
    V.ty = ty;
    if (z === 1) body.style.removeProperty('transform');
    else body.style.transform = `translate(${tx}px, ${ty}px) scale(${z})`;
    html.classList.toggle('mag-zoomed', z !== 1);
  }
  // <body> is a composited layer while magnified (panning is cheap), and Chromium keeps such a layer's raster
  // scale: after each zoom change it is painted again once, sharp at the new scale.
  let rasterRaf = 0;
  function sharpen() {
    cancelAnimationFrame(rasterRaf);
    body.style.willChange = 'auto';
    rasterRaf = requestAnimationFrame(() => {
      rasterRaf = requestAnimationFrame(() => {
        rasterRaf = 0;
        body.style.removeProperty('will-change');
      });
    });
  }
  function setView() {
    if (mode === 'pointer') pointerOrigin();
    apply();
  }

  // ------------------------------------------------------------------ zoom
  function cancelAnim() {
    if (anim) cancelAnimationFrame(anim);
    anim = 0;
    animating = false;
  }
  function zoomTo(pct, { animate = true, save = true, announce = true, center = null } = {}) {
    if (!active) return;
    const target = clampPct(pct) / 100;
    zTarget = target;
    if (save) saveZoom(Math.round(target * 100));
    const from = z;
    // The view keeps the pointer's point in place (pointer tracking), else its centre.
    const cx = center ? center.x : o.x + W() / z / 2;
    const cy = center ? center.y : o.y + H() / z / 2;
    const step = (zz) => {
      z = zz;
      if (mode !== 'pointer') {
        o.x = cx - W() / z / 2;
        o.y = cy - H() / z / 2;
      }
      setView();
    };
    cancelAnim();
    if (!animate || reducedMotion() || from === target) {
      step(target);
      sharpen();
    } else {
      const t0 = performance.now();
      animating = true;
      cancelAnimationFrame(rasterRaf);
      body.style.removeProperty('will-change'); // scaled as a picture during the animation, painted sharp at the end
      const frame = (now) => {
        const k = Math.min(1, (now - t0) / ANIM_MS);
        const e = 1 - (1 - k) ** 3;
        step(from + (target - from) * e);
        if (k < 1) anim = requestAnimationFrame(frame);
        else {
          anim = 0;
          animating = false;
          step(target);
          sharpen();
          changed();
        }
      };
      anim = requestAnimationFrame(frame);
    }
    changed();
    renderLevel();
    if (announce) {
      say(t('magnifier.zoomed', { level: fmtPct(Math.round(target * 100)) }));
      if (!toolbarShown()) pill(fmtPct(Math.round(target * 100)));
    }
  }
  function saveZoom(pct) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = 0;
      if (conf().zoom !== pct) settings.set('magnifier.zoom', pct).catch(() => {});
    }, 350);
  }
  const currentPct = () => Math.round(zTarget * 100);
  function zoomBy(dir) {
    if (!active) {
      if (dir > 0) start();
      return;
    }
    const step = conf().step;
    const cur = currentPct();
    const next = dir > 0 ? Math.min(MAX, cur + step) : Math.max(MIN, cur - step);
    if (next !== cur) zoomTo(next);
    else if (!toolbarShown()) pill(fmtPct(cur));
  }

  // ------------------------------------------------------------------ pointer
  let polling = false;
  let pollBusy = false;
  function onPointer(x, y) {
    P = { x, y };
    if (!active) return;
    if (mode === 'static' || !conf().followPointer) return;
    if (mode === 'focus') {
      if (anchor && Math.hypot(x - anchor.x, y - anchor.y) < POINTER_SLACK) return;
      mode = 'pointer';
      anchor = null;
      setView();
      changed(); // the view is exact again: Linux windows get pointer input back
      return;
    }
    setView();
  }
  function pollLoop() {
    if (!polling || !active) {
      polling = false;
      return;
    }
    requestAnimationFrame(async () => {
      if (!polling || !active) return void (polling = false);
      if (!pollBusy && isMagnified()) {
        pollBusy = true;
        try {
          const c = await api.invoke('magnifier:cursor');
          if (polling && c && Number.isFinite(c.x) && Number.isFinite(c.y) && (!P || c.x !== P.x || c.y !== P.y)) onPointer(c.x, c.y);
        } catch {}
        pollBusy = false;
      }
      pollLoop();
    });
  }
  function startPolling() {
    if (polling || !active) return;
    polling = true;
    pollLoop();
  }
  const onMove = (e) => {
    if (e.pointerType === 'touch') return;
    polling = false;
    onPointer(rawX(e), rawY(e));
  };
  const onOut = (e) => {
    if (!e.relatedTarget) startPolling(); // left the page: a Linux window, a client's menu, outside the window
  };
  const onDown = () => (lastPointerDown = Date.now());

  // ------------------------------------------------------------------ focus and caret
  let followSeq = 0;
  async function follow(rect, kind) {
    if (!active || z === 1 || !rect || !(rect.width >= 0) || !Number.isFinite(rect.x)) return;
    const vw = W() / z;
    const vh = H() / z;
    const m = Math.min(24, vw / 8, vh / 8);
    const inside = rect.left >= o.x + m && rect.right <= o.x + vw - m && rect.top >= o.y + m && rect.bottom <= o.y + vh - m;
    if (inside) return;
    let nx = o.x;
    let ny = o.y;
    if (kind === 'caret') {
      if (rect.left < o.x + m) nx = rect.left - m;
      else if (rect.right > o.x + vw - m) nx = rect.right - vw + m;
      if (rect.top < o.y + m) ny = rect.top - m;
      else if (rect.bottom > o.y + vh - m) ny = rect.bottom - vh + m;
    } else {
      nx = rect.width > vw - 2 * m ? rect.left - m : rect.left + rect.width / 2 - vw / 2;
      ny = rect.height > vh - 2 * m ? rect.top - m : rect.top + rect.height / 2 - vh / 2;
    }
    const seq = ++followSeq;
    if (mode === 'pointer') {
      mode = 'focus';
      anchor = P ? { ...P } : null;
      // Linux windows must stop taking the pointer before the view leaves it (the point under the pointer moves).
      await Promise.race([ctx.xwin?.blockInput?.(), sleep(150)]).catch(() => {});
      if (seq !== followSeq || !active) return;
    } else if (mode === 'static') anchor = null;
    o.x = nx;
    o.y = ny;
    apply();
  }
  function caretRect() {
    const el = document.activeElement;
    if (!el || isExempt(el)) return null;
    if (el.matches?.('textarea, input:not([type]), input[type="text"], input[type="search"], input[type="email"], input[type="url"], input[type="tel"], input[type="password"], input[type="number"]')) return fieldCaret(el);
    const sel = window.getSelection?.();
    if (!sel || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0).cloneRange();
    range.collapse(false);
    const rects = range.getClientRects();
    const r = rects.length ? rects[rects.length - 1] : null;
    if (r && (r.width || r.height)) return r;
    const host = (sel.focusNode?.nodeType === 1 ? sel.focusNode : sel.focusNode?.parentElement) || el;
    return host?.getBoundingClientRect?.() || null;
  }
  // The caret of an <input> / <textarea>: a hidden copy of the field with the text up to the caret.
  const MIRROR_PROPS = ['boxSizing', 'width', 'height', 'overflowX', 'overflowY', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch', 'fontSize', 'lineHeight', 'fontFamily', 'textAlign', 'textTransform', 'textIndent', 'letterSpacing', 'wordSpacing', 'tabSize'];
  function fieldCaret(el) {
    const box = el.getBoundingClientRect();
    let pos = 0;
    try {
      pos = el.selectionEnd ?? 0;
    } catch {
      return box;
    }
    if (pos == null) return box;
    const cs = getComputedStyle(el);
    const div = document.createElement('div');
    const st = div.style;
    for (const p of MIRROR_PROPS) st[p] = cs[p];
    st.position = 'fixed';
    st.left = '-10000px';
    st.top = '0';
    st.visibility = 'hidden';
    const area = el.tagName === 'TEXTAREA';
    st.whiteSpace = area ? 'pre-wrap' : 'pre';
    st.overflowWrap = area ? 'break-word' : 'normal';
    const value = el.type === 'password' ? '•'.repeat(el.value.length) : el.value;
    div.textContent = value.slice(0, pos);
    const span = document.createElement('span');
    span.textContent = value.slice(pos) || '.';
    div.appendChild(span);
    body.appendChild(div);
    const x = span.offsetLeft + parseFloat(cs.borderLeftWidth || 0) - el.scrollLeft;
    const y = span.offsetTop + parseFloat(cs.borderTopWidth || 0) - el.scrollTop;
    const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.25 || 16;
    div.remove();
    const cx = Math.max(box.left, Math.min(box.right, box.left + x));
    const cy = Math.max(box.top, Math.min(box.bottom - Math.min(lh, box.height), box.top + y));
    return new DOMRect(cx, cy, 2, Math.min(lh, box.height));
  }
  const onFocusIn = (e) => {
    if (!active || !conf().followFocus || isExempt(e.target)) return;
    if (Date.now() - lastPointerDown < 500) return; // the pointer moved the focus: it is where the pointer is
    const el = e.target;
    if (!(el instanceof Element) || el === body || el === html) return;
    // after layout (a window that just opened, a menu that just appeared)
    requestAnimationFrame(() => {
      if (!el.isConnected || document.activeElement !== el) return;
      const r = el.getBoundingClientRect();
      if (r.width || r.height) follow(r, 'focus');
    });
  };
  const onKeyDown = (e) => {
    if (e.key && !['Shift', 'Control', 'Alt', 'Meta', 'OS', 'Super'].includes(e.key)) lastKey = Date.now();
  };
  let caretRaf = 0;
  const onCaret = () => {
    if (!active || !conf().followCaret || Date.now() - lastKey > 700 || caretRaf) return;
    caretRaf = requestAnimationFrame(() => {
      caretRaf = 0;
      const r = caretRect();
      if (r) follow(r, 'caret');
    });
  };

  // ------------------------------------------------------------------ wheel (Ctrl+Alt)
  let wheelAcc = 0;
  let wheelAt = 0;
  const onWheel = (e) => {
    if (!active || !e.ctrlKey || !e.altKey || e.metaKey) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const now = Date.now();
    if (now - wheelAt > 300) wheelAcc = 0;
    wheelAt = now;
    const dy = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    wheelAcc += dy;
    if (Math.abs(wheelAcc) >= 40) {
      zoomBy(wheelAcc < 0 ? 1 : -1);
      wheelAcc = 0;
    }
  };

  // ------------------------------------------------------------------ toolbar, pill, announcements
  const live = h('div', { class: 'mag-live', role: 'status', 'aria-live': 'polite' });
  body.append(live);
  let sayTimer = 0;
  function say(text) {
    clearTimeout(sayTimer);
    live.textContent = '';
    sayTimer = setTimeout(() => (live.textContent = text), 60);
  }
  const btn = (act, ic) => h('button', { class: 'mag-btn', type: 'button', dataset: { act }, onmousedown: (e) => e.preventDefault() }, icon(ic, { size: 16 }));
  const bOut = btn('out', 'magnifying-glass-minus');
  const bIn = btn('in', 'magnifying-glass-plus');
  const level = h('span', { class: 'mag-level' });
  const bSettings = btn('settings', 'gear-six');
  const bHide = btn('hide', 'eye-slash');
  const bClose = btn('close', 'x');
  const buttons = [bOut, bIn, bSettings, bHide, bClose];
  const toolbar = h(
    'div',
    { class: 'mag-toolbar', popover: 'manual', role: 'toolbar', 'aria-orientation': 'horizontal' },
    h('span', { class: 'mag-mark', 'aria-hidden': 'true' }, icon('magnifying-glass', { size: 16 })),
    bOut,
    level,
    bIn,
    h('span', { class: 'mag-sep', 'aria-hidden': 'true' }),
    bSettings,
    bHide,
    bClose,
  );
  const pillEl = h('div', { class: 'mag-pill', popover: 'manual', 'aria-hidden': 'true' });
  body.append(toolbar, pillEl);
  exempt.push(toolbar, pillEl);
  let pillTimer = 0;
  function pill(text) {
    if (!active || locked()) return;
    pillEl.textContent = text;
    try {
      if (!pillEl.matches(':popover-open')) pillEl.showPopover();
    } catch {}
    pillEl.classList.add('show');
    clearTimeout(pillTimer);
    pillTimer = setTimeout(hidePill, 1400);
    ctx.xwin?.refresh?.();
  }
  function hidePill() {
    clearTimeout(pillTimer);
    pillEl.classList.remove('show');
    try {
      if (pillEl.matches(':popover-open')) pillEl.hidePopover();
    } catch {}
    ctx.xwin?.refresh?.();
  }
  function label(el, text, keys) {
    const full = keys ? `${text} (${keys})` : text;
    el.setAttribute('aria-label', full);
    el.dataset.label = full;
  }
  function renderLabels() {
    toolbar.setAttribute('aria-label', t('magnifier.toolbar'));
    label(bOut, t('magnifier.zoomOut'), keysOf('magnifierZoomOut'));
    label(bIn, t('magnifier.zoomIn'), keysOf('magnifierZoomIn'));
    label(bSettings, t('magnifier.settings'), keysOf('magnifierSettings'));
    label(bHide, t('magnifier.hide'));
    label(bClose, t('magnifier.close'), keysOf('magnifierStop'));
    level.setAttribute('aria-label', t('magnifier.level'));
    renderLevel();
  }
  function renderLevel() {
    level.textContent = fmtPct(currentPct());
    bOut.disabled = currentPct() <= MIN;
    bIn.disabled = currentPct() >= MAX;
  }
  const toolbarShown = () => toolbar.matches(':popover-open');
  function syncToolbar() {
    const want = active && conf().toolbar && !locked() && !document.querySelector('.sec-screen:not(.closing)');
    try {
      if (want && !toolbarShown()) {
        renderLabels();
        toolbar.showPopover();
      } else if (!want && toolbarShown()) {
        if (toolbar.contains(document.activeElement)) document.activeElement.blur();
        toolbar.hidePopover();
      }
    } catch {}
    if (locked()) hidePill();
    ctx.xwin?.refresh?.();
  }
  let returnFocus = null;
  toolbar.addEventListener('focusin', (e) => {
    if (!toolbar.contains(e.relatedTarget)) returnFocus = e.relatedTarget instanceof HTMLElement ? e.relatedTarget : null;
  });
  toolbar.addEventListener('keydown', (e) => {
    const list = buttons.filter((b) => !b.disabled);
    const i = list.indexOf(document.activeElement);
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      list[(i + (e.key === 'ArrowRight' ? 1 : -1) + list.length) % list.length]?.focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      (e.key === 'Home' ? list[0] : list[list.length - 1])?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      const back = returnFocus;
      document.activeElement?.blur?.();
      if (back?.isConnected) back.focus({ preventScroll: true });
    }
  });
  toolbar.addEventListener('click', (e) => {
    const act = e.target.closest?.('.mag-btn')?.dataset.act;
    if (act === 'in') zoomBy(1);
    else if (act === 'out') zoomBy(-1);
    else if (act === 'settings') openSettings();
    else if (act === 'hide') {
      settings.set('magnifier.toolbar', false).catch(() => {});
      const keys = keysOf('magnifierSettings');
      if (keys) say(t('magnifier.hidden', { keys }));
    } else if (act === 'close') stop();
  });
  function openSettings() {
    if (locked()) return;
    shell.emit('start:close');
    shell.emit('flyouts:close');
    shell.launch('settings', { page: 'magnifier' });
  }

  // ------------------------------------------------------------------ Linux (X11) windows
  // Live copies of the clients while the view is magnified (see the header); started one at a time, never for a
  // minimised window (a capture started on an iconic window made Chromium lose its X connection under Xvfb).
  const mirrors = new Map(); // xid -> { win, video, stream, starting, dropped }
  const restoredAt = new Map(); // xid -> time it was last seen minimised -> visible
  const wasMin = new Map();
  let queue = Promise.resolve();
  let syncTimer = 0;
  function framesWanted() {
    const out = new Map();
    const xw = ctx.xwin;
    if (!xw?.status?.enabled || !isMagnified() || locked()) return out;
    const now = Date.now();
    for (const rec of xw.frames.values()) {
      const w = rec.win;
      if (!w || w.closed || w._closing) continue;
      const min = !!w.minimized;
      if (wasMin.get(rec.id) && !min) restoredAt.set(rec.id, now);
      wasMin.set(rec.id, min);
      if (min || !w.isOnCurrentDesktop()) continue;
      if (now - (restoredAt.get(rec.id) || 0) < RESTORED_GRACE) continue;
      out.set(rec.id, w);
    }
    return out;
  }
  function syncMirrors() {
    const want = framesWanted();
    for (const [id, m] of mirrors) if (want.get(id) !== m.win) dropMirror(id);
    for (const [id, w] of want) if (!mirrors.has(id)) startMirror(id, w);
    const need = active && isMagnified() && ctx.xwin?.frames?.size;
    if (need && !syncTimer) syncTimer = setInterval(syncMirrors, 400);
    if (!need && syncTimer) {
      clearInterval(syncTimer);
      syncTimer = 0;
    }
  }
  function startMirror(id, w) {
    const video = h('video', { class: 'mag-mirror', 'aria-hidden': 'true', disablePictureInPicture: true });
    video.muted = true;
    video.playsInline = true;
    const m = { win: w, video, stream: null, starting: null, dropped: false };
    mirrors.set(id, m);
    w.body.append(video);
    m.starting = queue = queue.then(async () => {
      if (m.dropped || w.minimized || w.closed) return;
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: `window:${id}:0`, maxFrameRate: 30 } } });
        if (m.dropped) {
          stream.getTracks().forEach((tr) => tr.stop());
          return;
        }
        m.stream = stream;
        video.srcObject = stream;
        stream.getVideoTracks()[0]?.addEventListener('ended', () => mirrors.get(id) === m && dropMirror(id));
        await video.play().catch(() => {});
      } catch (err) {
        console.warn('[magnifier] no live copy of window', id, err?.message || err);
        m.failed = true;
      }
    });
    m.starting.finally(() => (m.starting = null));
  }
  function dropMirror(id) {
    const m = mirrors.get(id);
    if (!m) return null;
    mirrors.delete(id);
    m.dropped = true;
    m.stream?.getTracks().forEach((tr) => tr.stop());
    m.video.srcObject = null;
    m.video.remove();
    return m.starting;
  }
  function dropAllMirrors() {
    for (const id of [...mirrors.keys()]) dropMirror(id);
    if (syncTimer) clearInterval(syncTimer);
    syncTimer = 0;
  }
  // xwin.js asks before a client becomes iconic: no capture may be starting for it then.
  function beforeIconic(id) {
    wasMin.set(id, true);
    const p = dropMirror(id);
    return p ? p.then(() => sleep(60)) : null;
  }

  // Something that changes what Linux windows may get (magnified or not, exact or not): tell xwin.js.
  function changed() {
    ctx.xwin?.refresh?.();
    syncMirrors();
  }

  // ------------------------------------------------------------------ start / stop
  function applyLook() {
    const c = conf();
    html.classList.toggle('mag-invert', active && c.invert);
    html.classList.toggle('mag-crisp', active && !c.smoothing);
  }
  async function start({ save = true } = {}) {
    if (active) return;
    const token = ++startToken;
    active = true;
    const c = conf();
    mode = c.followPointer ? 'pointer' : 'static';
    anchor = null;
    installPatches();
    html.classList.add('mag-on');
    applyLook();
    z = 1;
    zTarget = 1;
    o.x = 0;
    o.y = 0;
    if (!P) {
      const cur = await api.invoke('magnifier:cursor').catch(() => null);
      if (token !== startToken || !active) return;
      P = cur && Number.isFinite(cur.x) ? { x: cur.x, y: cur.y } : { x: W() / 2, y: H() / 2 };
    }
    window.addEventListener('pointermove', onMove, { capture: true, passive: true });
    window.addEventListener('pointerover', onMove, { capture: true, passive: true });
    window.addEventListener('pointerout', onOut, { capture: true, passive: true });
    window.addEventListener('pointerdown', onDown, { capture: true, passive: true });
    window.addEventListener('wheel', onWheel, { capture: true, passive: false });
    window.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('selectionchange', onCaret);
    document.addEventListener('input', onCaret, true);
    api.send('xwin:cmd', { cmd: 'wheel-zoom', on: true });
    apply();
    syncToolbar();
    zoomTo(c.zoom, { save: false, announce: false, center: mode === 'static' ? P : null });
    say(t('magnifier.on', { level: fmtPct(currentPct()) }));
    shell.emit('magnifier:change', { active: true });
    if (save && !conf().enabled) settings.set('magnifier.enabled', true).catch(() => {});
  }
  function stop({ save = true } = {}) {
    if (!active) return;
    startToken++;
    active = false;
    cancelAnim();
    polling = false;
    clearTimeout(saveTimer);
    if (saveTimer) {
      saveTimer = 0;
      if (conf().zoom !== currentPct()) settings.set('magnifier.zoom', currentPct()).catch(() => {});
    }
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerover', onMove, true);
    window.removeEventListener('pointerout', onOut, true);
    window.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('wheel', onWheel, true);
    window.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('focusin', onFocusIn, true);
    document.removeEventListener('selectionchange', onCaret);
    document.removeEventListener('input', onCaret, true);
    api.send('xwin:cmd', { cmd: 'wheel-zoom', on: false });
    z = 1;
    zTarget = 1;
    o.x = 0;
    o.y = 0;
    V.z = 1;
    V.tx = 0;
    V.ty = 0;
    cancelAnimationFrame(rasterRaf);
    for (const [el, props] of [[body, ['transform', 'will-change']]]) {
      for (const p of props) el.style.removeProperty(p);
      if (el.getAttribute('style') === '') el.removeAttribute('style');
    }
    html.classList.remove('mag-on', 'mag-zoomed', 'mag-invert', 'mag-crisp');
    removePatches();
    dropAllMirrors();
    syncToolbar();
    hidePill();
    ctx.xwin?.refresh?.();
    say(t('magnifier.off'));
    shell.emit('magnifier:change', { active: false });
    if (save && conf().enabled) settings.set('magnifier.enabled', false).catch(() => {});
  }

  // ------------------------------------------------------------------ wiring
  settings.on('magnifier', () => {
    const c = conf();
    if (c.enabled && !active) start({ save: false });
    else if (!c.enabled && active) stop({ save: false });
    if (!active) return;
    applyLook();
    syncToolbar();
    const wantMode = c.followPointer ? (mode === 'static' ? 'pointer' : mode) : 'static';
    if (wantMode !== mode) {
      mode = wantMode;
      anchor = null;
      setView();
    }
    if (!saveTimer && c.zoom !== currentPct()) zoomTo(c.zoom, { save: false });
    changed();
  });
  shell.on('magnifier:zoomIn', () => zoomBy(1));
  shell.on('magnifier:zoomOut', () => zoomBy(-1));
  shell.on('magnifier:stop', () => stop());
  shell.on('magnifier:settings', () => openSettings());
  // While locked hotkeys.js runs nothing but the hardware keys: the zoom keys still work here (not the settings).
  // Ctrl+Alt+wheel over a Linux window or the shell arrives from aurora-xwm's grab as a combo.
  api.on('shell:hotkey', (p) => {
    const combo = p?.combo;
    if (!combo || p.repeat) return;
    if (combo === 'Ctrl+Alt+WheelUp' || combo === 'Ctrl+Alt+WheelDown') {
      if (active) zoomBy(combo.endsWith('Up') ? 1 : -1);
      return;
    }
    if (!locked()) return;
    const id = ctx.hotkeys?.bindings?.[ctx.hotkeys.normalize?.(combo) || combo];
    if (id === 'magnifierZoomIn') zoomBy(1);
    else if (id === 'magnifierZoomOut') zoomBy(-1);
    else if (id === 'magnifierStop') stop();
  });
  shell.on('lock', () => setTimeout(() => (syncToolbar(), changed()), 0));
  shell.on('unlock', () => setTimeout(() => (syncToolbar(), changed()), 0));
  try {
    new MutationObserver(() => {
      if (!active) return;
      syncToolbar();
      syncMirrors();
    }).observe(body, { attributes: true, attributeFilter: ['class'] });
  } catch {}
  for (const ev of ['open', 'close', 'desktop', 'change']) wm.on(ev, () => active && syncMirrors());
  window.addEventListener('resize', () => active && setView());
  i18n.on?.('change', () => active && renderLabels());
  settings.on('shortcuts', () => active && renderLabels());

  const api2 = {
    start: () => start(),
    stop: () => stop(),
    toggle: () => (active ? stop() : start()),
    zoomIn: () => zoomBy(1),
    zoomOut: () => zoomBy(-1),
    setZoom: (pct) => (active ? zoomTo(pct) : settings.set('magnifier.zoom', clampPct(pct))),
    get active() {
      return active;
    },
    get zoom() {
      return active ? currentPct() : conf().zoom;
    },
    view: () => ({ z, x: o.x, y: o.y, tx: V.tx, ty: V.ty, mode, exact: exact(), magnified: isMagnified(), pointer: P ? { ...P } : null }),
    toScreen,
    toPage,
    // core/features/xwin.js: what Linux windows may get now
    xwinState: () => ({ magnified: isMagnified(), exact: isMagnified() && exact() && !locked() }),
    beforeIconic,
    mirrors: () => [...mirrors.entries()].map(([id, m]) => ({ id, playing: !!m.stream && !m.video.paused, width: m.video.videoWidth, height: m.video.videoHeight, failed: !!m.failed })),
    toolbar,
  };
  ctx.magnifier = api2;
  shell.magnifier = api2;

  // At sign-in the magnifier starts when « Démarrer la loupe à l'ouverture de session » is on; after a crash restart
  // of the shell (same session) it comes back as it was.
  const firstStart = !sessionStorage.getItem('aurora-started');
  const c0 = conf();
  if (firstStart) {
    if (c0.enabled !== c0.startAtLogin) settings.set('magnifier.enabled', c0.startAtLogin).catch(() => {});
    if (c0.startAtLogin) start({ save: false });
  } else if (c0.enabled) start({ save: false });
}
