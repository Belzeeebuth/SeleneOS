'use strict';
// Display backend: screen modes through xrandr, backlight brightness through /sys/class/backlight.
//
//   display:status                 -> { outputs: [{ name, primary, width, height, rate, x, y, rotation, mmWidth, mmHeight,
//                                        preferred: { width, height, rate } | null,
//                                        modes: [{ width, height, rates: [60, 59.94, …], preferred }] }],   (largest first)
//                                       brightness: null | 0-100 }
//   display:setMode (name, width, height, rate?)  -> { previous: {width, height, rate}, current: {…} }  (not saved)
//   display:save ()                -> saves every output's current mode in ~/.config/aurora/display.json
//                                     (Settings calls it once the user clicked "Keep changes")
//   display:applySaved ()          -> re-applies display.json (also done by aurora-apply-display at login)
//   display:setBrightness (n)      -> sets the backlight (0-100); errors with ENOTSUP when there is none
//
// Several screens (main/lib/display-layout.js does the maths):
//   display:status also returns { layout: { mode, primary, position }, key, lid: 'open' | 'closed' | null }
//   display:setLayout (cfg)        -> applies { mode: extend|mirror|external|internal, primary, position: right|left|above|below }
//                                     (not saved; Settings asks « Conserver ? » then calls display:saveLayout)
//                                     -> { previous: cfg, current: plan }
//   display:saveLayout (cfg?)      -> remembers the layout for the set of connected screens (names + EDID)
//   display:project (mode)         -> Super+P picker: applies and remembers at once
//   display:monitors ()            -> { monitors: [{ id, x, y, width, height, primary }], union } in CSS px of the shell window
//                                     (broadcast as 'display:monitors' when screens change; renderer core/monitors.js)
// The saved layout is re-applied at sign-in (the shell starts) and when a screen is plugged in / out (xrandr --current
// polled every few seconds). Lid: with an external screen connected, closing the lid switches to « external only »;
// opening it restores the remembered layout (/proc/acpi/button/lid/*/state, else logind's LidClosed). Without an
// external screen the lid action stays logind's (Alimentation > « Quand je ferme le capot »).
//
// ~/.config/aurora/display.json (version 2):
//   { "version": 2, "layouts": { "HDMI-1:1a2b3c4d|eDP-1:99aa00ff": { "mode": "extend", "primary": "HDMI-1", "position": "left",
//       "outputs": { "eDP-1": { "width": 1920, "height": 1080, "rate": 60 }, … } } } }
// Version 1 ({ "outputs": {…} }, one screen) is still read. rootfs/usr/lib/aurora/helpers/aurora-apply-display applies
// version 1 files before the shell starts and leaves version 2 files to the shell.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run, which } = require('../lib/exec');
const layout = require('../lib/display-layout');

const CONFIG = path.join(os.homedir(), '.config', 'aurora', 'display.json');
const BACKLIGHT = '/sys/class/backlight';

// ------------------------------------------------------------------ parser (unit-tested)
/** Parse `xrandr --query`. Returns { screen: {width, height}, outputs: [...] } (connected outputs only). */
function parseXrandr(text) {
  const outputs = [];
  let screen = null;
  let cur = null;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    let m = /^Screen \d+:.*current (\d+) x (\d+)/.exec(line);
    if (m) {
      screen = { width: Number(m[1]), height: Number(m[2]) };
      continue;
    }
    m = /^(\S+)\s+(connected|disconnected|unknown connection)(\s+primary)?(?:\s+(\d+)x(\d+)\+(-?\d+)\+(-?\d+))?(?:\s+(normal|left|inverted|right))?/.exec(line);
    if (m) {
      cur = null;
      if (m[2] !== 'connected') continue;
      const mm = /(\d+)mm x (\d+)mm\s*$/.exec(line);
      cur = {
        name: m[1],
        primary: !!m[3],
        active: m[4] != null,
        width: m[4] ? Number(m[4]) : null,
        height: m[5] ? Number(m[5]) : null,
        x: m[6] ? Number(m[6]) : 0,
        y: m[7] ? Number(m[7]) : 0,
        rotation: m[8] || 'normal',
        mmWidth: mm ? Number(mm[1]) : null,
        mmHeight: mm ? Number(mm[2]) : null,
        rawModes: [],
      };
      outputs.push(cur);
      continue;
    }
    if (!cur) continue;
    m = /^\s+(\d+)x(\d+)(i?)(\S*)\s+(.*)$/.exec(line);
    if (!m) {
      if (/^\S/.test(line)) cur = null;
      continue;
    }
    const mode = { name: `${m[1]}x${m[2]}${m[3]}${m[4]}`, width: Number(m[1]), height: Number(m[2]), interlaced: !!m[3], rates: [] };
    for (const tok of m[5].trim().split(/\s+/)) {
      const r = /^(\d+(?:\.\d+)?)([*+]*)$/.exec(tok);
      if (r) mode.rates.push({ rate: Number(r[1]), current: r[2].includes('*'), preferred: r[2].includes('+') });
      else if (/^[*+]+$/.test(tok) && mode.rates.length) {
        const last = mode.rates[mode.rates.length - 1];
        if (tok.includes('*')) last.current = true;
        if (tok.includes('+')) last.preferred = true;
      }
    }
    cur.rawModes.push(mode);
  }
  for (const o of outputs) finishOutput(o);
  if (!screen && outputs.length) screen = { width: outputs[0].width, height: outputs[0].height };
  return { screen, outputs };
}

function finishOutput(o) {
  // Merge modes by size (several names may share one size: "1920x1080", "1920x1080_60.00", "1920x1080i").
  const bySize = new Map();
  let current = null;
  let preferred = null;
  for (const m of o.rawModes) {
    const key = `${m.width}x${m.height}`;
    if (!bySize.has(key)) bySize.set(key, { width: m.width, height: m.height, rates: [], preferred: false, names: {} });
    const e = bySize.get(key);
    for (const r of m.rates) {
      // Interlaced modes only when the size has no progressive rate at all.
      if (m.interlaced && o.rawModes.some((x) => !x.interlaced && x.width === m.width && x.height === m.height)) continue;
      const rate = Math.round(r.rate * 100) / 100;
      if (!e.rates.includes(rate)) {
        e.rates.push(rate);
        e.names[rate] = m.name;
      }
      if (r.current) current = { width: m.width, height: m.height, rate, mode: m.name };
      if (r.preferred) {
        e.preferred = true;
        if (!preferred) preferred = { width: m.width, height: m.height, rate };
      }
    }
  }
  o.modes = [...bySize.values()]
    .filter((e) => e.rates.length)
    .map((e) => ({ ...e, rates: e.rates.sort((a, b) => b - a) }))
    .sort((a, b) => b.width * b.height - a.width * a.height || b.width - a.width);
  o.preferred = preferred;
  if (current) {
    o.width = current.width;
    o.height = current.height;
    o.rate = current.rate;
    o.mode = current.mode;
  } else o.rate = null;
  delete o.rawModes;
}

/** Name of the xrandr mode to use for a size/rate on a parsed output (null when unknown). */
function modeName(output, width, height, rate) {
  const e = output.modes.find((m) => m.width === Number(width) && m.height === Number(height));
  if (!e) return null;
  let r = e.rates[0];
  if (rate != null) {
    // closest advertised rate (59.96 and 60.00 are both common: never take the first "close enough" one)
    r = e.rates.reduce((best, x) => (Math.abs(x - Number(rate)) < Math.abs(best - Number(rate)) ? x : best), e.rates[0]);
    if (Math.abs(r - Number(rate)) > 0.05) return null;
  }
  if (r == null) return null;
  return { name: e.names[r], rate: r };
}

const parsers = { parseXrandr, modeName };

function err(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function publicOutput(o) {
  return {
    name: o.name,
    primary: o.primary,
    width: o.width,
    height: o.height,
    rate: o.rate,
    x: o.x,
    y: o.y,
    rotation: o.rotation,
    mmWidth: o.mmWidth,
    mmHeight: o.mmHeight,
    preferred: o.preferred,
    modes: o.modes.map(({ width, height, rates, preferred }) => ({ width, height, rates, preferred })),
  };
}

// ------------------------------------------------------------------ backlight
function backlightDevice() {
  let names = [];
  try {
    names = fs.readdirSync(BACKLIGHT);
  } catch {
    return null;
  }
  const rank = { firmware: 0, platform: 1, raw: 2 };
  const devs = names
    .map((n) => {
      const d = path.join(BACKLIGHT, n);
      let type = 'raw';
      try {
        type = fs.readFileSync(path.join(d, 'type'), 'utf8').trim();
      } catch {}
      return { name: n, dir: d, type };
    })
    .sort((a, b) => (rank[a.type] ?? 3) - (rank[b.type] ?? 3));
  return devs[0] || null;
}

function readBrightness() {
  const d = backlightDevice();
  if (!d) return null;
  try {
    const max = Number(fs.readFileSync(path.join(d.dir, 'max_brightness'), 'utf8'));
    let curText;
    try {
      curText = fs.readFileSync(path.join(d.dir, 'actual_brightness'), 'utf8');
    } catch {
      curText = fs.readFileSync(path.join(d.dir, 'brightness'), 'utf8');
    }
    if (!(max > 0)) return null;
    return Math.round((Number(curText) / max) * 100);
  } catch {
    return null;
  }
}

async function writeBrightness(pct) {
  const d = backlightDevice();
  if (!d) throw err('This display has no adjustable backlight', 'ENOTSUP');
  const max = Number(fs.readFileSync(path.join(d.dir, 'max_brightness'), 'utf8'));
  const value = Math.max(Math.ceil(max * 0.01), Math.round((Math.max(0, Math.min(100, pct)) / 100) * max));
  // 1. writable sysfs node (udev rule for the video group)  2. systemd-logind SetBrightness (active session)
  // 3. brightnessctl
  try {
    fs.writeFileSync(path.join(d.dir, 'brightness'), String(value));
    return true;
  } catch {}
  if (which('busctl')) {
    const r = await run('busctl', ['call', 'org.freedesktop.login1', '/org/freedesktop/login1/session/auto', 'org.freedesktop.login1.Session', 'SetBrightness', 'ssu', 'backlight', d.name, String(value)], { timeout: 5000 });
    if (r.code === 0) return true;
  }
  if (which('brightnessctl')) {
    const r = await run('brightnessctl', ['-q', '-d', d.name, 'set', String(value)], { timeout: 5000 });
    if (r.code === 0) return true;
  }
  throw err('Not allowed to change the brightness', 'EPERM');
}

// ------------------------------------------------------------------ backends
/** Outputs xrandr lists as disconnected that still hold a picture (a screen just unplugged: X keeps its CRTC, so the
 *  X screen and the shell window would still span it). */
function staleOutputs(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const m = /^(\S+)\s+disconnected(?:\s+primary)?\s+\d+x\d+\+-?\d+\+-?\d+/.exec(line);
    if (m && /^[\w.-]{1,32}$/.test(m[1])) out.push(m[1]);
  }
  return out;
}
parsers.staleOutputs = staleOutputs;

function xrandrBackend() {
  let stale = [];
  async function query({ probe = true } = {}) {
    const r = await run('xrandr', [probe ? '--query' : '--current'], { timeout: 10000 });
    if (r.code !== 0) throw err((r.stderr || 'xrandr failed').trim(), 'EDISPLAY');
    stale = staleOutputs(r.stdout);
    return parseXrandr(r.stdout);
  }
  async function apply(outName, width, height, rate) {
    const { outputs } = await query();
    const o = outputs.find((x) => x.name === outName);
    if (!o) throw err(`Display ${outName} is not connected`, 'ENOTFOUND');
    const m = modeName(o, width, height, rate);
    if (!m) throw err(`Mode ${width}x${height}${rate ? `@${rate}` : ''} is not supported by ${outName}`, 'EINVAL');
    const previous = { width: o.width, height: o.height, rate: o.rate };
    const args = ['--output', outName, '--mode', m.name];
    // xrandr matches --rate loosely; omit it for single-rate (e.g. cvt-created) modes.
    const e = o.modes.find((x) => x.width === Number(width) && x.height === Number(height));
    if (e.rates.length > 1) args.push('--rate', String(m.rate));
    const r = await run('xrandr', args, { timeout: 15000 });
    if (r.code !== 0) throw err((r.stderr || 'xrandr failed').trim(), 'EDISPLAY');
    return { previous, current: { width: Number(width), height: Number(height), rate: m.rate } };
  }
  async function applyArgs(argsIn) {
    // switch off unplugged screens that still hold a picture, so the desktop shrinks to the screens really there
    const off = stale.filter((n) => !argsIn.includes(n)).flatMap((n) => ['--output', n, '--off']);
    const args = [...off, ...argsIn];
    if (!args.length) return;
    const r = await run('xrandr', args, { timeout: 20000 });
    if (r.code !== 0) throw err((r.stderr || 'xrandr failed').trim(), 'EDISPLAY');
  }
  async function edids() {
    const r = await run('xrandr', ['--current', '--prop'], { timeout: 10000 });
    return r.code === 0 ? layout.parseEdids(r.stdout) : {};
  }
  return { query, apply, applyArgs, edids };
}

function mockBackend() {
  // Dev / tests: one virtual screen, or AURORA_MOCK_DISPLAYS=2 for a laptop panel (eDP-1) plus an external screen
  // (HDMI-1); display:devPlug plugs / unplugs the external one.
  const sizes = (list) => list.map(([w, h, r]) => ({ width: w, height: h, rates: r, preferred: false, names: Object.fromEntries(r.map((x) => [x, `${w}x${h}`])) }));
  const mk = (name, primary, mm, list, pref, pos) => {
    const modes = sizes(list);
    for (const m of modes) m.preferred = m.width === pref[0] && m.height === pref[1];
    return { name, primary, active: true, x: pos[0], y: pos[1], rotation: 'normal', mmWidth: mm[0], mmHeight: mm[1], width: pref[0], height: pref[1], rate: pref[2], preferred: { width: pref[0], height: pref[1], rate: pref[2] }, modes };
  };
  const two = process.env.AURORA_MOCK_DISPLAYS === '2';
  const main = two
    ? mk('eDP-1', true, [344, 194], [[1920, 1080, [60, 48]], [1600, 900, [60]], [1366, 768, [60]], [1280, 720, [60]]], [1920, 1080, 60], [0, 0])
    : mk('Virtual-1', true, [527, 296], [[2560, 1440, [60, 59.95]], [1920, 1200, [60]], [1920, 1080, [60, 59.94, 50]], [1680, 1050, [59.95]], [1600, 900, [60]], [1440, 900, [59.89]], [1366, 768, [59.79]], [1280, 1024, [75.02, 60.02]], [1280, 800, [59.81]], [1024, 768, [75.03, 60]], [800, 600, [60.32, 56.25]]], [1920, 1080, 60], [0, 0]);
  const ext = () => mk('HDMI-1', false, [598, 336], [[2560, 1440, [59.95]], [1920, 1080, [60, 50]], [1280, 1024, [75.02, 60.02]], [1280, 720, [60]]], [2560, 1440, 59.95], [1920, 0]);
  let outs = two ? [main, ext()] : [main];
  let brightness = process.env.AURORA_MOCK_BRIGHTNESS ? Number(process.env.AURORA_MOCK_BRIGHTNESS) || 70 : null;
  const copy = () => outs.map((o) => ({ ...o, modes: o.modes.map((m) => ({ ...m })) }));
  return {
    mock: true,
    log: [],
    async query() {
      const on = outs.filter((o) => o.active && o.width);
      const width = Math.max(1, ...on.map((o) => o.x + o.width));
      const height = Math.max(1, ...on.map((o) => o.y + o.height));
      return { screen: { width, height }, outputs: copy() };
    },
    async apply(name, width, height, rate) {
      const o = outs.find((x) => x.name === name);
      if (!o) throw err(`Display ${name} is not connected`, 'ENOTFOUND');
      const m = modeName(o, width, height, rate);
      if (!m) throw err(`Mode ${width}x${height} is not supported by ${name}`, 'EINVAL');
      const previous = { width: o.width, height: o.height, rate: o.rate };
      Object.assign(o, { width: Number(width), height: Number(height), rate: m.rate, active: true });
      return { previous, current: { width: o.width, height: o.height, rate: o.rate } };
    },
    async applyArgs(args) {
      this.log.push(args);
      outs = layout.simulate(outs, args);
    },
    async edids() {
      return Object.fromEntries(outs.map((o) => [o.name, o.name === 'HDMI-1' ? 'e4f1a2b3' : '0c0ffee0']));
    },
    plug(on) {
      if (on && !outs.some((o) => o.name === 'HDMI-1')) outs.push({ ...ext(), active: false, width: null, height: null, rate: null, x: 0, y: 0 });
      if (!on) outs = outs.filter((o) => o.name !== 'HDMI-1');
    },
    brightness: () => brightness,
    setBrightness: async (n) => {
      if (brightness == null) throw err('This display has no adjustable backlight', 'ENOTSUP');
      brightness = Math.max(0, Math.min(100, Math.round(n)));
      return true;
    },
  };
}

// ------------------------------------------------------------------ monitors for the shell window
/** Bounds of the shell window: every screen (their union), in Electron DIP. */
function shellBounds() {
  const { screen } = require('electron');
  const all = screen.getAllDisplays();
  if (!all.length) return { ...screen.getPrimaryDisplay().bounds };
  const x = Math.min(...all.map((d) => d.bounds.x));
  const y = Math.min(...all.map((d) => d.bounds.y));
  const right = Math.max(...all.map((d) => d.bounds.x + d.bounds.width));
  const bottom = Math.max(...all.map((d) => d.bounds.y + d.bounds.height));
  return { x, y, width: right - x, height: bottom - y };
}

/** '1920x1080+0+0*,2560x1440+1920+0' (dev / tests: AURORA_DEV_MONITORS; '*' = main screen). */
function parseMonitorSpec(spec) {
  const list = [];
  for (const part of String(spec || '').split(',')) {
    const m = /^\s*(\d+)x(\d+)\+(\d+)\+(\d+)(\*)?\s*$/.exec(part);
    if (m) list.push({ id: `m${list.length + 1}`, width: +m[1], height: +m[2], x: +m[3], y: +m[4], primary: !!m[5] });
  }
  if (list.length && !list.some((d) => d.primary)) list[0].primary = true;
  return list;
}

function electronMonitors() {
  const { screen } = require('electron');
  const u = shellBounds();
  const primary = screen.getPrimaryDisplay().id;
  const monitors = screen.getAllDisplays().map((d) => ({
    id: String(d.id),
    x: d.bounds.x - u.x,
    y: d.bounds.y - u.y,
    width: d.bounds.width,
    height: d.bounds.height,
    primary: d.id === primary,
    scale: d.scaleFactor,
  }));
  return { monitors, union: { x: 0, y: 0, width: u.width, height: u.height } };
}

// ------------------------------------------------------------------ lid
const LID_DIR = process.env.AURORA_LID_DIR || '/proc/acpi/button/lid';
function readLidProc() {
  let names;
  try {
    names = fs.readdirSync(LID_DIR);
  } catch {
    return undefined;
  }
  let seen = false;
  for (const n of names) {
    try {
      const txt = fs.readFileSync(path.join(LID_DIR, n, 'state'), 'utf8');
      seen = true;
      if (/closed/i.test(txt)) return 'closed';
    } catch {}
  }
  return seen ? 'open' : undefined;
}

// ------------------------------------------------------------------ registration
function register(api) {
  const useMock = api.DEV && process.env.AURORA_REAL_BACKENDS !== '1';
  const be = useMock ? mockBackend() : which('xrandr') ? xrandrBackend() : null;
  let devMonitors = api.DEV ? parseMonitorSpec(process.env.AURORA_DEV_MONITORS) : [];
  let lidState = null; // 'open' | 'closed' | null (no lid)
  let lidSwitched = false; // the lid closing turned the laptop panel off: opening it restores the layout
  let busy = Promise.resolve();
  const serial = (fn) => (busy = busy.then(fn, fn));

  async function query(opts) {
    return be ? (await be.query(opts)).outputs : [];
  }
  async function keyOf(outputs) {
    let edids = {};
    try {
      edids = (await be?.edids?.()) || {};
    } catch {}
    return layout.setKey(outputs, edids);
  }

  async function status() {
    let outputs = [];
    let raw = [];
    if (be) {
      try {
        raw = await query();
        outputs = raw.map(publicOutput);
      } catch (e) {
        if (!api.DEV) console.error('[display] xrandr:', e.message);
      }
    }
    if (!outputs.length) {
      // No xrandr (or no X): describe the Electron screen so Settings can still show something.
      try {
        const { screen } = require('electron');
        const d = screen.getPrimaryDisplay();
        outputs = [{ name: 'default', primary: true, width: d.size.width, height: d.size.height, rate: d.displayFrequency || null, x: 0, y: 0, rotation: 'normal', mmWidth: null, mmHeight: null, preferred: null, modes: [], readOnly: true }];
      } catch {}
    }
    for (const o of outputs) {
      const r = raw.find((x) => x.name === o.name);
      o.active = r ? !!(r.active && r.width) : true;
      o.internal = layout.isInternal(o.name);
    }
    const cur = layout.currentLayout(raw.length ? raw : outputs);
    return { outputs, brightness: be?.mock ? be.brightness() : readBrightness(), layout: cur, lid: lidState, key: raw.length ? await keyOf(raw) : null };
  }

  // ---- remembered layouts
  function readCfg() {
    const c = readJson(CONFIG);
    if (!c || typeof c !== 'object') return { version: 2, layouts: {} };
    if (c.version === 2 && c.layouts && typeof c.layouts === 'object') return c;
    // version 1: one set of modes (one screen); kept as the layout of any set until something new is saved
    return { version: 2, layouts: {}, legacy: c.outputs && typeof c.outputs === 'object' ? { mode: 'extend', outputs: c.outputs } : null };
  }
  function writeCfg(c) {
    const out = { version: 2, layouts: c.layouts || {} };
    fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
    fs.writeFileSync(CONFIG, JSON.stringify(out, null, 2));
    return out;
  }
  async function savedFor(outputs) {
    const c = readCfg();
    return c.layouts[await keyOf(outputs)] || c.legacy || null;
  }
  function snapshot(outputs, plan) {
    const cur = layout.currentLayout(outputs);
    const modes = {};
    for (const o of outputs) if (o.active && o.width) modes[o.name] = { width: o.width, height: o.height, rate: o.rate };
    return { mode: plan?.mode || cur.mode, primary: plan?.primary || cur.primary, position: plan?.position || cur.position, outputs: modes };
  }
  async function saveCurrent(cfg) {
    const outputs = await query();
    const c = readCfg();
    const key = await keyOf(outputs);
    const snap = snapshot(outputs);
    const prev = c.layouts[key] || {};
    // per-screen modes of screens switched off are kept for when they come back
    c.layouts[key] = { ...snap, ...(cfg && typeof cfg === 'object' ? layout.normaliseCfg(cfg) : {}), outputs: { ...(prev.outputs || {}), ...snap.outputs } };
    if (cfg?.mode) c.layouts[key].mode = layout.normaliseCfg(cfg).mode;
    writeCfg(c);
    return c.layouts[key];
  }
  async function applyCfg(cfg, outputs) {
    const list = outputs || (await query());
    const plan = layout.planLayout(list, cfg);
    await be.applyArgs(plan.args);
    api.broadcast('display:changed', await status());
    setTimeout(pushMonitors, 300);
    return plan;
  }

  function validCfg(cfg) {
    if (!cfg || typeof cfg !== 'object') throw err('Invalid display layout', 'EINVAL');
    const c = layout.normaliseCfg(cfg);
    if (cfg.mode != null && !layout.MODES.includes(cfg.mode)) throw err('Invalid display mode', 'EINVAL');
    if (cfg.position != null && !layout.POSITIONS.includes(cfg.position)) throw err('Invalid position', 'EINVAL');
    if (c.primary != null && !/^[\w.-]{1,32}$/.test(c.primary)) throw err('Invalid display name', 'EINVAL');
    const outs = {};
    for (const [n, m] of Object.entries(c.outputs)) {
      if (!/^[\w.-]{1,32}$/.test(n) || !m || !(Number(m.width) > 0) || !(Number(m.height) > 0)) continue;
      outs[n] = { width: Number(m.width), height: Number(m.height), rate: m.rate == null ? null : Number(m.rate) };
    }
    return { ...c, outputs: outs };
  }

  api.handle('display:status', status);
  api.handle('display:setMode', async (name, width, height, rate) => {
    if (!be) throw err('Changing the screen mode needs xrandr', 'ENOTSUP');
    if (!/^[\w.-]{1,32}$/.test(String(name)) || !(Number(width) > 0) || !(Number(height) > 0)) throw err('Invalid display mode', 'EINVAL');
    const res = await be.apply(String(name), Number(width), Number(height), rate == null ? null : Number(rate));
    api.broadcast('display:changed', await status());
    setTimeout(pushMonitors, 300);
    return res;
  });
  api.handle('display:save', async () => {
    if (!be) return null;
    return saveCurrent(null);
  });
  api.handle('display:saved', () => readJson(CONFIG));
  api.handle('display:setLayout', (cfgIn) =>
    serial(async () => {
      if (!be) throw err('Changing the screen layout needs xrandr', 'ENOTSUP');
      const cfg = validCfg(cfgIn);
      const outputs = await query();
      const previous = snapshot(outputs);
      const current = await applyCfg({ ...previous, ...cfg, outputs: { ...previous.outputs, ...cfg.outputs } }, outputs);
      lidSwitched = false;
      return { previous, current };
    }),
  );
  api.handle('display:saveLayout', (cfg) => serial(async () => (be ? saveCurrent(cfg ? validCfg(cfg) : null) : null)));
  api.handle('display:project', (mode) =>
    serial(async () => {
      if (!be) throw err('Changing the screen layout needs xrandr', 'ENOTSUP');
      if (!layout.MODES.includes(mode)) throw err('Invalid display mode', 'EINVAL');
      const outputs = await query();
      const saved = (await savedFor(outputs)) || {};
      const plan = await applyCfg({ ...snapshot(outputs), ...saved, mode }, outputs);
      lidSwitched = false;
      await saveCurrent({ mode: plan.mode, primary: plan.primary, position: plan.position });
      return plan;
    }),
  );
  async function applySaved() {
    if (!be) return [];
    const outputs = await query();
    const cfg = await savedFor(outputs);
    const want = lidState === 'closed' && outputs.some((o) => !layout.isInternal(o.name)) && outputs.some((o) => layout.isInternal(o.name)) ? { ...(cfg || {}), mode: 'external' } : cfg;
    if (!want) return [];
    const plan = layout.planLayout(outputs, want);
    // nothing to do when every screen already shows what the layout asks for (no flicker at sign-in)
    const same = outputs.every((o) => {
      const r = plan.rects[o.name];
      if (!r) return !(o.active && o.width);
      const m = plan.modes[o.name];
      return o.active && o.x === r.x && o.y === r.y && o.width === m.width && o.height === m.height && (m.rate == null || Math.abs((o.rate || 0) - m.rate) < 0.05) && (!plan.primary || o.primary === (o.name === plan.primary));
    });
    if (same) return [];
    try {
      await applyCfg(want, outputs);
    } catch (e) {
      console.error('[display] could not restore the screen layout:', e.message);
      return [];
    }
    return plan.active;
  }
  api.handle('display:applySaved', () => serial(applySaved));
  api.handle('display:setBrightness', async (n) => {
    const v = Math.max(0, Math.min(100, Math.round(Number(n))));
    if (Number.isNaN(v)) throw err('Invalid brightness', 'EINVAL');
    if (be?.mock) await be.setBrightness(v);
    else await writeBrightness(v);
    return v;
  });

  // ---- monitors of the shell window (renderer core/monitors.js)
  // Electron gives DIP; the renderer works in CSS px, which differ when Paramètres > Écran > Mise à l'échelle zooms the
  // shell (theme.js -> shell:zoom -> setZoomFactor): divide by the zoom factor so the bar stays on screen at 125 %.
  function zoomed(d) {
    let z = 1;
    try {
      z = api.getMainWindow?.()?.webContents?.getZoomFactor?.() || 1;
    } catch {}
    if (!(z > 0) || Math.abs(z - 1) < 0.001 || !d.union) return d;
    const s = (v) => Math.round(v / z);
    return {
      monitors: d.monitors.map((m) => ({ ...m, x: s(m.x), y: s(m.y), width: s(m.width), height: s(m.height) })),
      union: { x: 0, y: 0, width: s(d.union.width), height: s(d.union.height) },
    };
  }
  function monitors() {
    if (api.DEV) {
      if (devMonitors.length) {
        const width = Math.max(...devMonitors.map((d) => d.x + d.width));
        const height = Math.max(...devMonitors.map((d) => d.y + d.height));
        return zoomed({ monitors: devMonitors, union: { x: 0, y: 0, width, height } });
      }
      return { monitors: [], union: null };
    }
    try {
      return zoomed(electronMonitors());
    } catch {
      return { monitors: [], union: null };
    }
  }
  function pushMonitors() {
    api.broadcast('display:monitors', monitors());
  }
  api.handle('display:monitors', monitors);
  if (!api.DEV) {
    try {
      const { app, screen } = require('electron');
      app.whenReady().then(() => {
        for (const ev of ['display-metrics-changed', 'display-added', 'display-removed']) screen.on(ev, () => setTimeout(pushMonitors, 120));
      });
    } catch {}
  }
  if (api.DEV) {
    // tests: replace the fake monitors (a screen unplugged…), plug / unplug the mock external screen
    api.handle('display:devMonitors', (spec) => {
      devMonitors = parseMonitorSpec(spec);
      pushMonitors();
      return monitors();
    });
    api.handle('display:devPlug', async (on) => {
      be?.plug?.(!!on);
      await tick();
      return status();
    });
    api.handle('display:devTick', async () => {
      await tick();
      return status();
    });
  }

  // ---- hot plug + lid: poll xrandr --current (no probing) and the lid state
  let lastSet = null;
  let lidWatch = true;
  async function readLid() {
    if (!lidWatch) return null;
    const p = readLidProc();
    if (p !== undefined) return p;
    if (process.env.AURORA_LID_DIR || !which('busctl')) {
      lidWatch = false;
      return null;
    }
    const r = await run('busctl', ['get-property', 'org.freedesktop.login1', '/org/freedesktop/login1', 'org.freedesktop.login1.Manager', 'LidClosed'], { timeout: 4000 });
    if (r.code !== 0 || !/^b /.test(r.stdout.trim())) {
      lidWatch = false; // no logind / no lid: stop asking
      return null;
    }
    return /\btrue\b/.test(r.stdout) ? 'closed' : 'open';
  }
  async function tick() {
    if (!be) return;
    await serial(async () => {
      let outputs;
      try {
        outputs = await query({ probe: false });
      } catch {
        return;
      }
      const lid = await readLid();
      const set = outputs.map((o) => o.name).sort().join('|');
      const hasExt = outputs.some((o) => !layout.isInternal(o.name));
      const hasInt = outputs.some((o) => layout.isInternal(o.name));
      const lidChanged = lid !== lidState;
      const setChanged = lastSet != null && set !== lastSet;
      const first = lastSet == null;
      lidState = lid;
      lastSet = set;
      try {
        if (lid === 'closed' && hasExt && hasInt && (lidChanged || setChanged)) {
          // The lid closed with an external screen: everything moves to the external screen.
          const cur = layout.currentLayout(outputs);
          if (cur.mode !== 'external') {
            await applyCfg({ ...((await savedFor(outputs)) || snapshot(outputs)), mode: 'external' }, outputs);
            lidSwitched = true;
          }
          return;
        }
        if (lid === 'open' && lidChanged && lidSwitched && !first) {
          lidSwitched = false;
          const cfg = (await savedFor(outputs)) || { mode: 'extend' };
          await applyCfg(cfg, outputs);
          return;
        }
        if (setChanged) {
          // A screen was plugged in or out: its remembered layout, else « Étendre » (new screen on the right).
          const cfg = await savedFor(outputs);
          await applyCfg(cfg || { ...snapshot(outputs), mode: 'extend' }, outputs);
        }
      } catch (e) {
        console.error('[display] screen change:', e.message);
      }
    });
  }
  const watch = !api.DEV || process.env.AURORA_DISPLAY_WATCH === '1';
  // Idle cost: `xrandr --current` is a process spawn and an X round trip every 3 s. With the real backend, run it only
  // when the kernel's connector state changed (/sys/class/drm/card*-*/status: DRM's cached state, reading it never
  // probes the screens) or the lid moved (/proc/acpi/button/lid), plus every 30 s as a safety net. Without DRM
  // connectors in sysfs (NVIDIA without nvidia-drm modeset) or a lid only logind knows about, xrandr is polled as before.
  // Same with the NVIDIA driver loaded at all (also PRIME laptops whose HDMI port is on the NVIDIA GPU): its X driver
  // handles hot-plug itself, and nvidia-drm only refreshes the cached sysfs status when a DRM client re-probes, so a
  // new monitor could wait for the 30 s safety net.
  const drmDir = process.env.AURORA_DRM_DIR || '/sys/class/drm';
  const nvidiaLoaded = fs.existsSync(process.env.AURORA_NVIDIA_MODULE_DIR || '/sys/module/nvidia');
  const drmSig = () => {
    let names = [];
    try {
      names = fs.readdirSync(drmDir).filter((n) => /^card\d+-/.test(n));
    } catch {}
    return names
      .sort()
      .map((n) => {
        try {
          return `${n}=${fs.readFileSync(path.join(drmDir, n, 'status'), 'utf8').trim()}`;
        } catch {
          return n;
        }
      })
      .join(',');
  };
  const SAFETY_MS = 30000;
  const cheap = !useMock && !nvidiaLoaded && !!drmSig() && (readLidProc() !== undefined || !which('busctl'));
  let lastSig = cheap ? `${drmSig()}|${readLidProc() ?? ''}` : '';
  let lastFull = Date.now();
  const cheapChanged = () => {
    const sig = `${drmSig()}|${readLidProc() ?? ''}`;
    const due = sig !== lastSig || Date.now() - lastFull >= SAFETY_MS;
    lastSig = sig;
    if (due) lastFull = Date.now();
    return due;
  };
  if (cheap) {
    try {
      const { app, screen } = require('electron');
      app.whenReady().then(() => {
        for (const ev of ['display-added', 'display-removed']) screen.on(ev, () => setTimeout(() => tick().catch(() => {}), 200));
      });
    } catch {}
  }
  if (watch && be) {
    const every = Number(process.env.AURORA_DISPLAY_WATCH_MS) || 3000;
    // at sign-in: the remembered layout first (aurora-apply-display leaves version 2 files to the shell)
    setTimeout(() => {
      readLid()
        .then((l) => {
          lidState = l;
          return serial(applySaved);
        })
        .catch(() => {})
        .finally(() => {
          const t = setInterval(() => {
            if (!cheap || cheapChanged()) tick().catch(() => {});
          }, every);
          t.unref?.();
          tick().catch(() => {});
        });
    }, api.DEV ? 50 : 400);
  }
  // No grey X root anywhere (between screens of different sizes, before the shell draws): a dark solid root.
  if (!api.DEV && which('xsetroot')) run('xsetroot', ['-solid', '#0b0d17'], { timeout: 5000 }).catch(() => {});
}

module.exports = register;
module.exports.parsers = parsers;
module.exports.shellBounds = shellBounds;
module.exports.parseMonitorSpec = parseMonitorSpec;
