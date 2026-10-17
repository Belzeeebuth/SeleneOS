'use strict';
// Several screens: pure layout maths for main/ipc/display.js (unit-tested in test/displays.unit.mjs).
//
//   planLayout(outputs, cfg) -> { mode, primary, active: [names], off: [names], rects: { name: {x, y, width, height} }, args }
//     outputs: parsed xrandr outputs (display.js parseXrandr: name, primary, active, width, height, rate, modes…)
//     cfg: { mode: 'extend' | 'mirror' | 'external' | 'internal', primary?: name, position?: 'right' | 'left' | 'above' | 'below',
//            outputs?: { name: { width, height, rate } } }      (missing / unknown values fall back to sensible defaults)
//     args: the xrandr argv (outputs to switch off first, then each active output with --mode / --rate / --pos / --primary)
//   setKey(outputs, edids) -> 'HDMI-1:1a2b3c4d|eDP-1:99aa00ff'   the set of connected screens (layouts are remembered per set)
//   parseEdids(xrandrPropText) -> { name: 'sha1 prefix' }        EDID blocks of `xrandr --prop`
//   isInternal(name) -> the laptop's own panel (eDP / LVDS / DSI)
//   simulate(outputs, args) -> outputs after xrandr ran args (dev mock backend and tests)
const crypto = require('crypto');

const MODES = ['extend', 'mirror', 'external', 'internal'];
const POSITIONS = ['right', 'left', 'above', 'below'];

function isInternal(name) {
  return /^(eDP|LVDS|DSI)/i.test(String(name || ''));
}

/** xrandr mode name for a size / rate on a parsed output (closest rate), or null. */
function pickMode(o, want) {
  const sizes = o.modes || [];
  const find = (w, h) => sizes.find((m) => m.width === Number(w) && m.height === Number(h));
  let e = want && find(want.width, want.height);
  if (!e && o.active && o.width) e = find(o.width, o.height);
  if (!e && o.preferred) e = find(o.preferred.width, o.preferred.height);
  if (!e) e = sizes.find((m) => m.preferred) || sizes[0];
  if (!e) return null;
  let rate = e.rates[0];
  const wantRate = want && find(want.width, want.height) === e ? want.rate : o.active && o.width === e.width && o.height === e.height ? o.rate : null;
  if (wantRate != null) rate = e.rates.reduce((best, x) => (Math.abs(x - Number(wantRate)) < Math.abs(best - Number(wantRate)) ? x : best), e.rates[0]);
  const name = (e.names && e.names[rate]) || `${e.width}x${e.height}`;
  return { width: e.width, height: e.height, rate, name, multi: e.rates.length > 1 };
}

function normaliseCfg(cfg) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  return {
    mode: MODES.includes(c.mode) ? c.mode : 'extend',
    primary: typeof c.primary === 'string' ? c.primary : null,
    position: POSITIONS.includes(c.position) ? c.position : 'right',
    outputs: c.outputs && typeof c.outputs === 'object' ? c.outputs : {},
  };
}

function planLayout(outputs, cfgIn) {
  const cfg = normaliseCfg(cfgIn);
  const list = (outputs || []).filter((o) => o && o.name);
  const internal = list.filter((o) => isInternal(o.name));
  const external = list.filter((o) => !isInternal(o.name));
  let mode = cfg.mode;
  // A mode that would leave every screen dark falls back to « Étendre ».
  if ((mode === 'external' && !external.length) || (mode === 'internal' && !internal.length)) mode = 'extend';
  if (list.length < 2 && mode === 'mirror') mode = 'extend';
  const active = mode === 'external' ? external : mode === 'internal' ? internal : list;
  const off = list.filter((o) => !active.includes(o));
  const byName = (n) => active.find((o) => o.name === n);
  const primary =
    byName(cfg.primary) ||
    (mode === 'external' ? external[0] : null) ||
    active.find((o) => o.primary && o.active) ||
    active.find((o) => isInternal(o.name)) ||
    active[0] ||
    null;
  const chosen = new Map();
  for (const o of active) chosen.set(o.name, pickMode(o, cfg.outputs[o.name]));
  const rects = {};
  const scaleFrom = {};
  if (primary && mode === 'mirror') {
    // Same picture everywhere: the largest size every screen offers, else each screen scales the main one's picture.
    const common = (primary.modes || [])
      .filter((m) => active.every((o) => (o.modes || []).some((x) => x.width === m.width && x.height === m.height)))
      .sort((a, b) => b.width * b.height - a.width * a.height)[0];
    const main = common ? pickMode(primary, { width: common.width, height: common.height, rate: cfg.outputs[primary.name]?.rate }) : chosen.get(primary.name);
    for (const o of active) {
      const m = common ? pickMode(o, { width: common.width, height: common.height, rate: cfg.outputs[o.name]?.rate }) : chosen.get(o.name);
      chosen.set(o.name, m);
      rects[o.name] = { x: 0, y: 0, width: main.width, height: main.height };
      if (m && (m.width !== main.width || m.height !== main.height)) scaleFrom[o.name] = `${main.width}x${main.height}`;
    }
  } else if (primary) {
    const pm = chosen.get(primary.name);
    rects[primary.name] = { x: 0, y: 0, width: pm.width, height: pm.height };
    const others = active.filter((o) => o !== primary);
    others.forEach((o, i) => {
      const m = chosen.get(o.name);
      if (!m) return;
      const all = Object.values(rects);
      const right = Math.max(...all.map((r) => r.x + r.width));
      if (i > 0) {
        // a third screen and more: in a row on the right
        rects[o.name] = { x: right, y: 0, width: m.width, height: m.height };
        return;
      }
      const cx = Math.round((pm.width - m.width) / 2);
      const pos = {
        right: { x: pm.width, y: 0 },
        left: { x: -m.width, y: 0 },
        above: { x: cx, y: -m.height },
        below: { x: cx, y: pm.height },
      }[cfg.position];
      rects[o.name] = { x: pos.x, y: pos.y, width: m.width, height: m.height };
    });
    // X positions are never negative: shift everything so the top-left corner is 0,0.
    const minX = Math.min(...Object.values(rects).map((r) => r.x));
    const minY = Math.min(...Object.values(rects).map((r) => r.y));
    for (const r of Object.values(rects)) {
      r.x -= minX;
      r.y -= minY;
    }
  }
  const args = [];
  for (const o of off) args.push('--output', o.name, '--off');
  for (const o of active) {
    const m = chosen.get(o.name);
    const r = rects[o.name];
    if (!m || !r) continue;
    args.push('--output', o.name, '--mode', m.name);
    if (m.multi) args.push('--rate', String(m.rate));
    args.push('--pos', `${r.x}x${r.y}`);
    // --scale 1x1 clears a scaling left by « Dupliquer » on screens of different sizes
    if (scaleFrom[o.name]) args.push('--scale-from', scaleFrom[o.name]);
    else args.push('--scale', '1x1');
    if (o === primary) args.push('--primary');
  }
  return {
    mode,
    primary: primary ? primary.name : null,
    position: cfg.position,
    active: active.map((o) => o.name),
    off: off.map((o) => o.name),
    rects,
    modes: Object.fromEntries([...chosen].filter(([, m]) => m).map(([n, m]) => [n, { width: m.width, height: m.height, rate: m.rate }])),
    args,
  };
}

/** Current mode of the connected screens, read back from xrandr's answer (what Settings shows as selected). */
function currentLayout(outputs) {
  const list = (outputs || []).filter((o) => o && o.name);
  const on = list.filter((o) => o.active && o.width);
  const internal = list.filter((o) => isInternal(o.name));
  const external = list.filter((o) => !isInternal(o.name));
  let mode = 'extend';
  if (list.length > 1) {
    if (on.length > 1 && on.every((o) => o.x === on[0].x && o.y === on[0].y)) mode = 'mirror';
    else if (internal.length && external.length && on.length && on.every((o) => !isInternal(o.name))) mode = 'external';
    else if (internal.length && external.length && on.length && on.every((o) => isInternal(o.name))) mode = 'internal';
  }
  const primary = on.find((o) => o.primary) || on[0] || null;
  let position = 'right';
  const other = primary && on.find((o) => o !== primary);
  if (mode === 'extend' && other) {
    if (other.x >= primary.x + primary.width) position = 'right';
    else if (other.x + other.width <= primary.x) position = 'left';
    else if (other.y + other.height <= primary.y) position = 'above';
    else if (other.y >= primary.y + primary.height) position = 'below';
  }
  return { mode, primary: primary ? primary.name : null, position };
}

function parseEdids(text) {
  const out = {};
  let cur = null;
  let hex = null;
  const flush = () => {
    if (cur && hex) out[cur] = crypto.createHash('sha1').update(hex).digest('hex').slice(0, 8);
    hex = null;
  };
  for (const line of String(text || '').split('\n')) {
    const m = /^(\S+)\s+(connected|disconnected|unknown connection)\b/.exec(line);
    if (m) {
      flush();
      cur = m[2] === 'connected' ? m[1] : null;
      continue;
    }
    if (/^\s+EDID:\s*$/.test(line)) {
      flush();
      hex = '';
      continue;
    }
    if (hex != null) {
      const h = /^\s+([0-9a-f]{16,})\s*$/i.exec(line);
      if (h) hex += h[1].toLowerCase();
      else flush();
    }
  }
  flush();
  return out;
}

function setKey(outputs, edids = {}) {
  return (outputs || [])
    .map((o) => (edids[o.name] ? `${o.name}:${edids[o.name]}` : o.name))
    .sort()
    .join('|');
}

/** Apply an xrandr argv to parsed outputs (dev mock backend, tests). */
function simulate(outputs, args) {
  const list = outputs.map((o) => ({ ...o }));
  let cur = null;
  const primaryNext = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--output') {
      const name = args[++i];
      cur = list.find((o) => o.name === name) || null;
      continue;
    }
    if (!cur) continue;
    if (a === '--off') Object.assign(cur, { active: false, width: null, height: null, rate: null, primary: false });
    else if (a === '--mode') {
      const [w, h] = args[++i].split(/[x_i]/).map(Number);
      Object.assign(cur, { active: true, width: w, height: h });
      const e = (cur.modes || []).find((m) => m.width === w && m.height === h);
      cur.rate = e ? e.rates[0] : cur.rate;
    } else if (a === '--rate') cur.rate = Number(args[++i]);
    else if (a === '--pos') {
      const [x, y] = args[++i].split('x').map(Number);
      Object.assign(cur, { x, y });
    } else if (a === '--scale-from') {
      const [w, h] = args[++i].split('x').map(Number);
      Object.assign(cur, { width: w, height: h, scaled: true });
    } else if (a === '--scale') i++;
    else if (a === '--primary') primaryNext.push(cur.name);
  }
  if (primaryNext.length) for (const o of list) o.primary = o.name === primaryNext[primaryNext.length - 1];
  return list;
}

module.exports = { MODES, POSITIONS, isInternal, pickMode, planLayout, currentLayout, parseEdids, setKey, simulate, normaliseCfg };
