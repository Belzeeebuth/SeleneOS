// External X11 windows (docs/XWINDOWS.md). Each client top-level reported by aurora-xwm (through
// main/ipc/xwin.js) gets a wm window with class 'xwin' whose content area stays empty and transparent;
// the shell window is cut (X Shape) where that content area is visible, so the client shows through.
//
//   ctx.xwin = { frames: Map(xid -> { id, win, info }), holes() -> CSS rects, refresh() }
//   win.xwin = xid  on every external frame (taskbar / Alt+Tab / Task view use the window icon).
const OCCLUDERS = ['#taskbar', '#start.open', '#flyouts > *', '#toasts > *', 'body > .menu', 'body > .flyout', '#overlays > *', '.snap-preview.show', '.tooltip'];
const STUCK_MS = 5000;

export async function mount(ctx) {
  const { api, wm, registry, i18n, t, ui, h } = ctx;
  i18n.extend({
    en: { xwin: { notResponding: '{name} is not responding', notRespondingBody: 'The program did not close. If you end it, you might lose unsaved information.', endTask: 'End task', wait: 'Wait', app: 'Linux application' } },
    fr: { xwin: { notResponding: '{name} ne répond pas', notRespondingBody: "Le programme ne s'est pas fermé. Si vous l'arrêtez, les informations non enregistrées risquent d'être perdues.", endTask: 'Fin de tâche', wait: 'Attendre', app: 'Application Linux' } },
  });
  ui.loadCss('app://shell/core/features/xwin.css');

  const frames = new Map(); // xid -> rec
  const send = (cmd) => api.send('xwin:cmd', cmd);
  let xFocus = null; // XID with X input focus (null: the shell)
  let lastHoles = '';
  let lastStack = '';
  let timer = 0;
  let raf = 0;

  const status = await api.invoke('xwin:status').catch(() => null);
  if (!status?.enabled) {
    ctx.xwin = { frames, holes: () => [], refresh() {}, status, xFocus: null };
    return; // no helper: nothing to manage, no listeners or timers
  }

  // ---------------------------------------------------------------- geometry
  function contentRect(rec) {
    const { win } = rec;
    const L = wm.layer.getBoundingClientRect();
    const b = win.body;
    return { x: Math.round(L.left + win.el.offsetLeft + win.el.clientLeft + b.offsetLeft), y: Math.round(L.top + win.el.offsetTop + win.el.clientTop + b.offsetTop), width: b.clientWidth, height: b.clientHeight };
  }
  // Frame size around a client of w x h (title bar and borders measured on the live frame).
  function frameDelta(rec) {
    const { win } = rec;
    return { dw: Math.max(0, win.el.offsetWidth - win.body.clientWidth), dh: Math.max(0, win.el.offsetHeight - win.body.clientHeight), dx: win.el.clientLeft + win.body.offsetLeft, dy: win.el.clientTop + win.body.offsetTop };
  }

  function place(rec, force = false) {
    const { win } = rec;
    if (rec.dragging || win.minimized || win.closed || !win.isOnCurrentDesktop()) return;
    const r = contentRect(rec);
    if (r.width < 1 || r.height < 1) return;
    const key = `${r.x},${r.y},${r.width},${r.height}`;
    if (!force && key === rec.placed) return;
    rec.placed = key;
    send({ cmd: 'place', id: rec.id, ...r, force });
  }

  function sendState(rec) {
    const { win } = rec;
    const st = { fullscreen: !!win.fullscreen, maximized: win.state === 'maximized', minimized: !!win.minimized };
    const key = JSON.stringify(st);
    if (key === rec.stateKey) return;
    rec.stateKey = key;
    send({ cmd: 'state', id: rec.id, ...st });
  }

  function setXFocus(id) {
    if (xFocus === id) return;
    xFocus = id;
    send({ cmd: 'focus', id });
  }

  // ---------------------------------------------------------------- shape
  function visible(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return null;
    return r;
  }
  function occluders() {
    const out = [];
    for (const el of document.querySelectorAll(OCCLUDERS.join(','))) {
      const r = visible(el);
      if (r) out.push({ x: r.left, y: r.top, width: r.width, height: r.height });
    }
    return out;
  }
  function holes() {
    if (!frames.size || document.body.classList.contains('tv-on') || document.body.classList.contains('aurora-locked')) return [];
    const stack = wm.stack().filter((w) => !w.minimized && !w._closing && w.isOnCurrentDesktop() && !w.el.classList.contains('off-desktop'));
    let occ = null;
    const out = [];
    stack.forEach((w, i) => {
      const rec = w.xwin != null && frames.get(w.xwin);
      if (!rec || rec.win !== w) return;
      if (w.el.getAnimations().length) return; // opening / minimizing / snapping: shown once settled
      const b = w.body.getBoundingClientRect();
      if (b.width < 1 || b.height < 1) return;
      occ = occ || occluders();
      const above = stack.slice(0, i).map((o) => {
        const r = o.el.getBoundingClientRect();
        return { x: r.left, y: r.top, width: r.width, height: r.height };
      });
      out.push(...subtractAll([{ x: b.left, y: b.top, width: b.width, height: b.height }], [...above, ...occ]));
    });
    return out;
  }
  function refresh() {
    raf = 0;
    const hs = holes();
    const key = JSON.stringify(hs);
    if (key !== lastHoles) {
      lastHoles = key;
      api.send('xwin:shape', hs);
    }
    // keep the X stacking order in step with the frames (bottom -> top)
    const ids = wm
      .stack()
      .reverse()
      .map((w) => w.xwin)
      .filter((id) => id != null && frames.has(id));
    const sk = ids.join(',');
    if (sk !== lastStack && ids.length) {
      lastStack = sk;
      send({ cmd: 'stack', ids });
    }
  }
  function schedule() {
    if (!raf) raf = requestAnimationFrame(refresh);
  }
  function syncTimer() {
    if (frames.size && !timer) timer = setInterval(refresh, 250);
    if (!frames.size && timer) {
      clearInterval(timer);
      timer = 0;
      refresh();
    }
  }

  // ---------------------------------------------------------------- app identity
  function transientApp(info) {
    const cls = (info.wmClass && (info.wmClass[1] || info.wmClass[0])) || '';
    const id = `x11:${(cls || info.gtkAppId || 'app').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 64)}`;
    if (!registry.get(id)) {
      const name = cls || info.title || t('xwin.app');
      registry.addTransient?.({ id, name: { en: name, fr: name }, icon: info.icon || null, kind: 'x11' });
    }
    return id;
  }
  function iconFor(rec) {
    return rec.info.icon || registry.iconUrl(rec.appId);
  }

  // ---------------------------------------------------------------- frames
  async function create(info) {
    if (frames.has(info.id)) return update(info);
    const rec = { id: info.id, info, win: null, placed: '', stateKey: '' };
    frames.set(info.id, rec);
    let appId = null;
    try {
      appId = await api.invoke('xapps:match', info);
    } catch {}
    if (frames.get(info.id) !== rec) return; // gone meanwhile
    if (typeof appId !== 'string' || !registry.get(appId)) appId = transientApp(info);
    rec.appId = appId;
    const decorated = info.decorated !== false;
    const minW = Math.max(1, info.minWidth || 0);
    const minH = Math.max(1, info.minHeight || 0);
    const fixed = info.maxWidth > 0 && info.maxHeight > 0 && info.maxWidth <= minW && info.maxHeight <= minH;
    const parent = info.transientFor != null ? frames.get(info.transientFor)?.win : null;
    const W = Math.max(minW, info.width || 640);
    const H = Math.max(minH, info.height || 480);
    const win = wm.create({
      appId,
      title: info.title || registry.name(appId),
      icon: info.icon || registry.iconUrl(appId),
      width: W + 2,
      height: H + (decorated ? 33 : 2),
      minWidth: Math.min(minW + 2, 4000),
      minHeight: Math.min(minH + (decorated ? 33 : 2), 4000),
      resizable: !fixed,
      maximizable: !fixed && info.type !== 'dialog' && info.type !== 'utility',
      titlebar: decorated ? 'default' : 'none',
      background: 'transparent',
      className: ['xwin', decorated ? null : 'xwin-undecorated', `xwin-${info.type || 'normal'}`].filter(Boolean).join(' '),
      skipTaskbar: ['utility', 'splash', 'toolbar'].includes(info.type) || (!!parent && info.type === 'dialog'),
    });
    win.xwin = info.id;
    rec.win = win;
    win.body.classList.add('xwin-content');
    win.body.append(h('div', { class: 'xwin-ph', 'aria-hidden': 'true' }, h('img', { src: iconFor(rec), alt: '', draggable: false })));
    // Exact frame around the client size, then position: dialogs centred over their parent, explicit
    // positions kept, (0,0) requests cascaded by the wm.
    const d = frameDelta(rec);
    const geo = { width: W + d.dw, height: H + d.dh };
    if (parent && !parent.closed) {
      geo.x = parent.x + (parent.w - geo.width) / 2;
      geo.y = parent.y + (parent.h - geo.height) / 2;
    } else if (info.x || info.y) {
      geo.x = info.x - d.dx;
      geo.y = info.y - d.dy;
    }
    win.setRect(geo);
    if (info.fullscreen) win.setFullscreen(true);
    const onGeom = () => {
      place(rec);
      schedule();
    };
    for (const ev of ['move', 'resize', 'maximize', 'restore', 'snap', 'fullscreen']) win.on(ev, onGeom);
    for (const ev of ['maximize', 'restore', 'minimize', 'fullscreen']) win.on(ev, () => sendState(rec));
    win.on('restore', () => setTimeout(() => place(rec), 0));
    win.onBeforeClose(() => {
      if (rec.gone) return true;
      requestClose(rec);
      return false;
    });
    win.on('close', () => {
      clearTimeout(rec.stuck);
      if (frames.get(rec.id) === rec) frames.delete(rec.id);
      if (xFocus === rec.id) xFocus = null;
      syncTimer();
      schedule();
    });
    place(rec, true);
    sendState(rec);
    if (wm.focused() === win) setXFocus(info.id);
    syncTimer();
    schedule();
  }

  function update(info) {
    const rec = frames.get(info.id);
    if (!rec) return;
    Object.assign(rec.info, info);
    if (!rec.win) return;
    if (info.title != null) rec.win.setTitle(info.title || registry.name(rec.appId));
    if ('icon' in info) {
      const url = iconFor(rec);
      rec.win.setIcon(url);
      const img = rec.win.body.querySelector('.xwin-ph img');
      if (img) img.src = url;
    }
  }

  function remove(id) {
    const rec = frames.get(id);
    if (!rec) return;
    rec.gone = true;
    frames.delete(id);
    if (xFocus === id) xFocus = null;
    clearTimeout(rec.stuck);
    rec.dialog?.close?.();
    if (rec.win && !rec.win.closed) {
      rec.win.el.style.transform = 'translateZ(0)'; // no close animation
      rec.win.close(true);
    }
    syncTimer();
    schedule();
  }

  function requestClose(rec) {
    send({ cmd: 'close', id: rec.id });
    if (rec.stuck) return;
    rec.stuck = setTimeout(async () => {
      rec.stuck = 0;
      if (rec.gone || !frames.has(rec.id)) return;
      const name = rec.win?.title || registry.name(rec.appId);
      const v = await ui.dialog({
        title: t('xwin.notResponding', { name }),
        body: t('xwin.notRespondingBody'),
        className: 'xwin-stuck',
        onOpen: (_dlg, done) => (rec.dialog = { close: () => done(null) }),
        buttons: [
          { label: t('xwin.endTask'), value: 'kill', danger: true },
          { label: t('xwin.wait'), value: 'wait', primary: true },
        ],
      });
      rec.dialog = null;
      if (v === 'kill' && !rec.gone) send({ cmd: 'kill', id: rec.id });
    }, STUCK_MS);
  }

  function onEvent(e) {
    if (!e || typeof e !== 'object') return;
    const rec = e.id != null ? frames.get(e.id) : null;
    const win = rec?.win;
    switch (e.ev) {
      case 'new':
        create(e).catch((err) => console.error('[xwin] frame failed', err));
        break;
      case 'title':
        update({ id: e.id, title: e.title });
        break;
      case 'icon':
        update({ id: e.id, icon: e.icon || null });
        break;
      case 'hints':
        if (rec) Object.assign(rec.info, e);
        if (win && (e.minWidth || e.minHeight)) {
          const d = frameDelta(rec);
          win.setMinSize(e.minWidth ? e.minWidth + d.dw : null, e.minHeight ? e.minHeight + d.dh : null);
        }
        break;
      case 'configure-request':
        if (!win) break;
        if (win.state === 'normal' && !win.fullscreen) {
          const d = frameDelta(rec);
          const geo = {};
          if (e.width) geo.width = e.width + d.dw;
          if (e.height) geo.height = e.height + d.dh;
          if (e.x != null && e.y != null && (e.x || e.y)) {
            geo.x = e.x - d.dx;
            geo.y = e.y - d.dy;
          }
          win.setRect(geo);
        }
        place(rec, true); // ICCCM: always answer
        break;
      case 'state-request':
        if (!win) break;
        if ('fullscreen' in e) win.setFullscreen(!!e.fullscreen);
        if ('maximized' in e) (e.maximized ? win.maximize() : win.state === 'maximized' && win.restore());
        if (e.minimized) win.minimize();
        if (e.activate) win.focus();
        sendState(rec);
        break;
      case 'drag': {
        if (!win) break;
        rec.dragging = !e.done;
        const d = frameDelta(rec);
        if (win.state !== 'normal' && !win.fullscreen) {
          win.state = 'normal';
          win.snap = null;
          win.el.classList.remove('maximized', 'snapped');
        }
        win.setRect({ x: e.x - d.dx, y: e.y - d.dy, width: e.width + d.dw, height: e.height + d.dh });
        if (e.done) {
          win.restoreRect = win.rect();
          rec.placed = '';
          place(rec);
        }
        schedule();
        break;
      }
      case 'focus':
        xFocus = e.id ?? null;
        if (win && wm.focused() !== win) win.focus();
        break;
      case 'click':
        if (win) win.focus();
        break;
      case 'gone':
        remove(e.id);
        break;
      case 'reset':
        for (const id of [...frames.keys()]) remove(id);
        xFocus = null;
        break;
      default:
        break;
    }
  }

  // ---------------------------------------------------------------- focus hand-off
  wm.on('focus', (w) => {
    if (!frames.size) return;
    if (w && w.xwin != null && frames.get(w.xwin)?.win === w) setXFocus(w.xwin);
    else if (xFocus != null) setXFocus(null);
  });
  document.addEventListener(
    'focusin',
    (e) => {
      if (!frames.size) return;
      const el = e.target?.closest?.('.win.xwin');
      const w = el && wm.get(el.dataset.id);
      if (w && w.xwin != null && wm.focused() === w) setXFocus(w.xwin);
      else if (!w && xFocus != null) setXFocus(null);
    },
    true,
  );

  // ---------------------------------------------------------------- wiring
  for (const ev of ['change', 'focus', 'desktop', 'open', 'close', 'drag-move', 'drag-end', 'snap']) wm.on(ev, schedule);
  try {
    const mo = new MutationObserver(schedule);
    for (const id of ['flyouts', 'overlays', 'toasts', 'start', 'taskbar']) {
      const el = document.getElementById(id);
      if (el) mo.observe(el, { childList: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
    }
    mo.observe(document.body, { childList: true, attributes: true, attributeFilter: ['class'] });
  } catch {}
  window.addEventListener('resize', () => {
    for (const rec of frames.values()) if (rec.win) place(rec);
    schedule();
  });

  ctx.xwin = { frames, holes, refresh, status, get xFocus() { return xFocus; } };
  api.on('xwin:event', onEvent);
  const list = await api.invoke('xwin:list').catch(() => []);
  for (const info of Array.isArray(list) ? list : []) if (!frames.has(info.id)) onEvent({ ...info, ev: 'new' });
}

// ---------------------------------------------------------------- rect algebra (same as main/lib/region.js)
function subtract(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  if (x2 <= x || y2 <= y) return [a];
  const out = [];
  const ax2 = a.x + a.width;
  const ay2 = a.y + a.height;
  if (y > a.y) out.push({ x: a.x, y: a.y, width: a.width, height: y - a.y });
  if (y2 < ay2) out.push({ x: a.x, y: y2, width: a.width, height: ay2 - y2 });
  if (x > a.x) out.push({ x: a.x, y, width: x - a.x, height: y2 - y });
  if (x2 < ax2) out.push({ x: x2, y, width: ax2 - x2, height: y2 - y });
  return out;
}
function subtractAll(rects, cuts) {
  const R = (r) => {
    const x = Math.round(r.x);
    const y = Math.round(r.y);
    return { x, y, width: Math.round(r.x + r.width) - x, height: Math.round(r.y + r.height) - y };
  };
  let cur = rects.map(R).filter((r) => r.width > 0 && r.height > 0);
  for (const c of cuts.map(R)) {
    if (c.width <= 0 || c.height <= 0) continue;
    cur = cur.flatMap((r) => subtract(r, c));
    if (!cur.length) break;
  }
  return cur;
}
