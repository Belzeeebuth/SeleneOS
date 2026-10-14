'use strict';
// External X11 windows (docs/XWINDOWS.md): runs the aurora-xwm helper and bridges it to the renderer.
//
// Starts only in shell mode on Linux when the helper exists; in dev / tests only with AURORA_XWM=1.
// AURORA_XWM_HELPER=<path> selects another helper executable (tests use test/fixtures/xwm-fake).
//
// Renderer API (all geometry in CSS px of the shell page):
//   xwin:status            -> { enabled, running, ready, screen, restarts }
//   xwin:list              -> [client]   clients the helper reported so far (latest 'new' + updates)
//   send xwin:cmd (cmd)    -> { cmd: 'place'|'stack'|'focus'|'close'|'kill'|'state'|'paste', … } (place in CSS px)
//                             osk-key: { id, name | char, mods: ['ctrl','alt','super','shift'], action: 'tap'|'press'|
//                             'release' } types one key of the on-screen keyboard into client id with XTest; osk-area:
//                             { rects: [{x,y,width,height}] } CSS rects of the on-screen keyboard: a press there never
//                             takes the X focus from the client (core/features/osk.js, docs/XWINDOWS.md)
//                             paste: { id, keys: 'ctrl+v' | 'ctrl+shift+v' | 'shift+insert' } (XTest, answered by
//                             the event { ev: 'paste', id, ok, code }; features/emoji.js)
//   send xwin:shape (holes)-> [{x,y,width,height}] CSS rects; the shell window gets screen − holes
//   xwin:input (holes|null)-> « Loupe » (core/features/magnifier.js): the shell window's X INPUT shape becomes
//                             window − holes (CSS rects), or the default again (null: input follows the cut). Answers
//                             once the helper has applied it (ping / pong), so the renderer can move the view after.
//                             If the helper exits with an input shape set, it is reset here.
//   send xwin:cmd { cmd: 'wheel-zoom', on } -> while the magnifier runs, Ctrl+Alt+wheel anywhere comes back as the
//                             combos 'Ctrl+Alt+WheelUp' / 'Ctrl+Alt+WheelDown' (helper grab; replayed after a restart)
//   xwin:debug             -> { shape, holes, factors }  (tests)
//   (+xwin:event)          -> helper events: new / title / icon / hints / configure-request / state-request /
//                             drag / focus / click / gone, plus { ev: 'reset' } when the helper restarted.
//                             x/y/width/height converted to CSS px.
// 'key' events are re-broadcast as shell:hotkey { combo, repeat }, exactly like main/lib/hotkeys.js.
const { app, screen } = require('electron');
const fs = require('fs');
const { spawn } = require('child_process');
const { helperPath } = require('../lib/exec');
const region = require('../lib/region');

const COMMANDS = new Set(['place', 'stack', 'focus', 'close', 'kill', 'state', 'ping', 'paste', 'osk-key', 'osk-area', 'wheel-zoom']);
// « Clavier visuel » (osk-key): key names (X keysyms) and modifiers the on-screen keyboard may send
const OSK_NAMES = new Set(['Return', 'BackSpace', 'Tab', 'Escape', 'Delete', 'Insert', 'Home', 'End', 'Prior', 'Next', 'Left', 'Right', 'Up', 'Down', 'space', 'Menu', 'Shift_L', 'Control_L', 'Alt_L', 'Super_L', 'ISO_Level3_Shift', ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`)]);
const OSK_MODS = new Set(['ctrl', 'alt', 'super', 'shift']);
const PASTE_KEYS = new Set(['ctrl+v', 'ctrl+shift+v', 'shift+insert']);

module.exports = function register(api) {
  const DEV = api.DEV;
  const wanted = process.platform === 'linux' && api.env.mode === 'shell' && (!DEV || process.env.AURORA_XWM === '1');
  const helper = process.env.AURORA_XWM_HELPER || helperPath('aurora-xwm');
  const enabled = wanted && fs.existsSync(helper);

  let proc = null;
  let ready = false;
  let scr = null;
  let starts = [];
  let stopped = false;
  const clients = new Map(); // id -> latest info (CSS px)
  const placed = new Map(); // id -> last device geometry sent
  let lastShape = null;
  let lastHoles = [];

  const log = (...a) => console.log('[xwin]', ...a);

  function win() {
    const w = api.getMainWindow();
    return w && !w.isDestroyed() ? w : null;
  }

  function factors() {
    const w = win();
    if (!w) return { zoom: 1, scale: 1, ox: 0, oy: 0 };
    let zoom = 1;
    try {
      zoom = w.webContents.getZoomFactor() || 1;
    } catch {}
    let scale = 1;
    try {
      scale = screen.getDisplayMatching(w.getBounds()).scaleFactor || 1;
    } catch {}
    const cb = w.getContentBounds();
    return { zoom, scale, ox: Math.round(cb.x * scale), oy: Math.round(cb.y * scale) };
  }

  // CSS px -> root-window device px
  function toDevice(r, f = factors()) {
    const k = f.zoom * f.scale;
    const out = {};
    if (r.x != null) out.x = Math.round(r.x * k + f.ox);
    if (r.y != null) out.y = Math.round(r.y * k + f.oy);
    if (r.width != null) out.width = Math.max(1, Math.round(r.width * k));
    if (r.height != null) out.height = Math.max(1, Math.round(r.height * k));
    return out;
  }
  // device px -> CSS px
  function fromDevice(r, f = factors()) {
    const k = f.zoom * f.scale;
    const out = {};
    if (r.x != null) out.x = Math.round((r.x - f.ox) / k);
    if (r.y != null) out.y = Math.round((r.y - f.oy) / k);
    if (r.width != null) out.width = Math.round(r.width / k);
    if (r.height != null) out.height = Math.round(r.height / k);
    for (const key of ['minWidth', 'minHeight', 'maxWidth', 'maxHeight']) if (r[key]) out[key] = Math.round(r[key] / k);
    return out;
  }

  function write(obj) {
    if (!proc || !proc.stdin.writable) return false;
    try {
      proc.stdin.write(`${JSON.stringify(obj)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  function onEvent(msg) {
    if (!msg || typeof msg !== 'object' || typeof msg.ev !== 'string') return;
    const ev = { ...msg, ...fromDevice(msg) };
    switch (msg.ev) {
      case 'ready':
        ready = true;
        scr = msg.screen || null;
        log(`helper ready (${msg.version || '?'})`);
        if (wheelZoom) write({ cmd: 'wheel-zoom', on: true });
        api.broadcast('xwin:event', { ev: 'ready', screen: scr });
        return;
      case 'fatal':
        log(`helper fatal ${msg.code}: ${msg.message || ''}`);
        return;
      case 'log':
        if (DEV || msg.level === 'error') log(`helper ${msg.level || 'info'}: ${msg.message}`);
        return;
      case 'pong': {
        const done = pongs.get(Number(msg.seq));
        if (done) done();
        return;
      }
      case 'key':
        if (typeof msg.combo === 'string') api.broadcast('shell:hotkey', { combo: msg.combo, repeat: !!msg.repeat });
        return;
      case 'new':
        clients.set(msg.id, ev);
        break;
      case 'title':
      case 'icon':
      case 'hints': {
        const c = clients.get(msg.id);
        if (c) Object.assign(c, ev, { ev: 'new' });
        break;
      }
      case 'gone':
        clients.delete(msg.id);
        placed.delete(msg.id);
        break;
      default:
        break;
    }
    api.broadcast('xwin:event', ev);
  }

  function start() {
    if (!enabled || proc || stopped) return;
    const w = win();
    if (!w) return;
    const h = w.getNativeWindowHandle();
    const xid = h.length >= 8 ? h.readBigUInt64LE(0) : BigInt(h.readUInt32LE(0));
    starts = starts.filter((t) => Date.now() - t < 60000);
    starts.push(Date.now());
    ready = false;
    log(`starting ${helper} --shell-xid ${xid}`);
    let child;
    try {
      child = spawn(helper, ['--shell-xid', String(xid)], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    } catch (err) {
      log(`cannot start helper: ${err.message}`);
      return;
    }
    proc = child;
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          log(`malformed line from helper: ${line.slice(0, 200)}`);
          continue;
        }
        try {
          onEvent(msg);
        } catch (err) {
          log(`event failed: ${err.message}`);
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => DEV && process.stderr.write(`[aurora-xwm] ${d}`));
    child.stdin.on('error', () => {});
    child.on('error', (err) => log(`helper error: ${err.message}`));
    child.on('exit', (code, signal) => {
      if (proc === child) proc = null;
      ready = false;
      log(`helper exited (${code ?? signal})`);
      // Its clients are unmanaged now: the renderer drops every frame (a restarted helper re-announces them).
      if (clients.size) {
        clients.clear();
        placed.clear();
        api.broadcast('xwin:event', { ev: 'reset' });
      }
      applyShape([]);
      if (inputSet) {
        // nobody can reset the input shape any more: Electron's own reset (a full input rect, harmless: input is
        // always clipped by the cut)
        inputSet = false;
        lastInputCss = null;
        try {
          const w = win();
          w?.setIgnoreMouseEvents(true);
          w?.setIgnoreMouseEvents(false);
        } catch {}
      }
      for (const done of pongs.values()) done();
      if (stopped || code === 3 || code === 4) return;
      const recent = starts.filter((t) => Date.now() - t < 60000);
      if (recent.length > 3) {
        log('helper keeps exiting: not restarting');
        return;
      }
      setTimeout(start, 500);
    });
  }

  // ---- « Loupe »: X input shape of the shell window (window-relative device px), Ctrl+Alt+wheel grab
  let inputSet = false;
  let lastInputCss = null;
  let wheelZoom = false;
  let pingSeq = 0;
  const pongs = new Map(); // seq -> resolve
  function helperSync(ms = 300) {
    if (!proc) return Promise.resolve(false);
    const seq = ++pingSeq;
    return new Promise((resolve) => {
      const done = (v = true) => {
        clearTimeout(timer);
        pongs.delete(seq);
        resolve(v);
      };
      const timer = setTimeout(() => done(false), ms);
      pongs.set(seq, done);
      if (!write({ cmd: 'ping', seq })) done(false);
    });
  }
  function applyInput(holesCss) {
    const w = win();
    if (!w || !enabled || !proc) return Promise.resolve(false);
    if (holesCss == null) {
      lastInputCss = null;
      if (!inputSet) return Promise.resolve(true);
      inputSet = false;
      write({ cmd: 'input-shape', rects: null });
      return helperSync();
    }
    const f = factors();
    const k = f.zoom * f.scale; // CSS px -> window-relative device px
    const cb = w.getContentBounds();
    const bounds = { x: 0, y: 0, width: Math.round(cb.width * f.scale), height: Math.round(cb.height * f.scale) };
    const holes = (Array.isArray(holesCss) ? holesCss : [])
      .slice(0, 200)
      .map((r) => (r && [r.x, r.y, r.width, r.height].every(Number.isFinite) ? region.norm({ x: r.x * k, y: r.y * k, width: r.width * k, height: r.height * k }) : null))
      .filter(Boolean);
    // (complement() drops the smallest holes first when it needs too many rects: the shell keeps that input)
    const rects = region.complement(bounds, holes, { max: 250 });
    lastInputCss = holesCss;
    inputSet = true;
    write({ cmd: 'input-shape', rects: rects.map((r) => [r.x, r.y, r.width, r.height]) });
    return helperSync();
  }

  let lastHolesCss = [];
  let shapeStale = false; // window resized: the last shape (even the full rect) no longer fits
  function applyShape(holesCss) {
    const w = win();
    if (!w || !enabled) return;
    lastHolesCss = Array.isArray(holesCss) ? holesCss : [];
    // Never shaped yet and nothing to cut: leave the window alone.
    if (!lastShape && !lastHolesCss.length) return;
    const f = factors();
    const k = f.zoom; // setShape works in window DIPs
    const cb = w.getContentBounds();
    const holes = (Array.isArray(holesCss) ? holesCss : []).map((r) => region.norm({ x: r.x * k, y: r.y * k, width: r.width * k, height: r.height * k })).filter(Boolean);
    const shape = holes.length ? region.complement({ x: 0, y: 0, width: cb.width, height: cb.height }, holes, { max: 250 }) : [];
    lastHoles = holes;
    if (lastShape && !shapeStale && region.equal(lastShape, shape)) return;
    shapeStale = false;
    // Keep at least one pixel so a fully-covered screen never turns into "no shape" (= rectangular).
    // No holes: the full window rect. (setShape([]) does not reliably give the area back on X11: the
    // old hole kept showing the client.)
    const out = !holes.length ? [{ x: 0, y: 0, width: cb.width, height: cb.height }] : shape.length ? shape : [{ x: 0, y: 0, width: 1, height: 1 }];
    lastShape = shape;
    try {
      w.setShape(out);
      // Areas given back to the shell are exposed with stale client pixels: repaint the whole page.
      w.webContents.invalidate();
    } catch (err) {
      log(`setShape failed: ${err.message}`);
    }
  }

  function command(cmd) {
    if (!cmd || typeof cmd !== 'object' || !COMMANDS.has(cmd.cmd)) return false;
    const out = { cmd: cmd.cmd };
    if (cmd.id !== undefined) out.id = cmd.id === null ? null : Number(cmd.id);
    switch (cmd.cmd) {
      case 'place': {
        const d = toDevice({ x: Number(cmd.x) || 0, y: Number(cmd.y) || 0, width: Math.max(1, Number(cmd.width) || 1), height: Math.max(1, Number(cmd.height) || 1) });
        const prev = placed.get(out.id);
        if (prev && !cmd.force && prev.x === d.x && prev.y === d.y && prev.width === d.width && prev.height === d.height) return true;
        placed.set(out.id, d);
        Object.assign(out, d);
        break;
      }
      case 'stack':
        out.ids = (Array.isArray(cmd.ids) ? cmd.ids : []).map(Number).filter(Number.isFinite);
        break;
      case 'state':
        for (const key of ['fullscreen', 'maximized', 'minimized']) if (key in cmd) out[key] = !!cmd[key];
        break;
      case 'ping':
        out.seq = Number(cmd.seq) || 0;
        break;
      case 'paste':
        if (!Number.isFinite(out.id)) return false;
        out.keys = PASTE_KEYS.has(cmd.keys) ? cmd.keys : 'ctrl+v';
        break;
      case 'osk-key': {
        if (!Number.isFinite(out.id)) return false;
        out.action = ['press', 'release'].includes(cmd.action) ? cmd.action : 'tap';
        if (typeof cmd.name === 'string' && OSK_NAMES.has(cmd.name)) out.name = cmd.name;
        else if (typeof cmd.char === 'string' && [...cmd.char].length === 1 && cmd.char.codePointAt(0) >= 0x20 && out.action === 'tap') out.char = cmd.char;
        else return false;
        out.mods = [...new Set((Array.isArray(cmd.mods) ? cmd.mods : []).filter((m) => OSK_MODS.has(m)))];
        break;
      }
      case 'wheel-zoom':
        out.on = !!cmd.on;
        wheelZoom = out.on;
        break;
      case 'osk-area':
        out.rects = (Array.isArray(cmd.rects) ? cmd.rects : [])
          .slice(0, 8)
          .filter((r) => r && [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0)
          .map((r) => toDevice(r));
        break;
      default:
        break;
    }
    return write(out);
  }

  api.handle('xwin:status', () => ({ enabled, running: !!proc, ready, screen: scr, restarts: Math.max(0, starts.length - 1) }));
  api.handle('xwin:list', () => [...clients.values()]);
  api.handle('xwin:debug', () => ({ shape: lastShape, holes: lastHoles, factors: factors(), placed: Object.fromEntries(placed) }));
  api.on('xwin:cmd', (cmd) => command(cmd));
  api.on('xwin:shape', (holes) => applyShape(holes));
  api.handle('xwin:input', (holes) => applyInput(holes));

  if (!enabled) {
    if (wanted) log(`helper not found (${helper}): Linux applications will not be managed`);
    return;
  }
  app.on('browser-window-created', (_e, w) => {
    // The shape is in window coordinates: rebuild it when the window changes size.
    w.on('resize', () => {
      if (w !== win()) return;
      if (lastInputCss) applyInput(lastInputCss);
      if (!lastShape) return;
      shapeStale = true;
      applyShape(lastHolesCss);
    });
    w.once('show', () => setTimeout(() => {
      if (w === win()) start();
    }, 100));
  });
  app.on('will-quit', () => {
    stopped = true;
    try {
      proc?.stdin.end();
    } catch {}
  });
};
