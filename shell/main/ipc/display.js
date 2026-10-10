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
// ~/.config/aurora/display.json:
//   { "version": 1, "outputs": { "Virtual-1": { "width": 1920, "height": 1080, "rate": 60, "mode": "1920x1080" } } }
// rootfs/usr/lib/aurora/helpers/aurora-apply-display reads the same file in the X session before the shell starts.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run, which } = require('../lib/exec');

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
  const r = rate != null ? e.rates.find((x) => Math.abs(x - Number(rate)) < 0.05) : e.rates[0];
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
function xrandrBackend() {
  async function query() {
    const r = await run('xrandr', ['--query'], { timeout: 10000 });
    if (r.code !== 0) throw err((r.stderr || 'xrandr failed').trim(), 'EDISPLAY');
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
  return { query, apply };
}

function mockBackend() {
  const rates = (...r) => r;
  const out = {
    name: 'Virtual-1',
    primary: true,
    active: true,
    x: 0,
    y: 0,
    rotation: 'normal',
    mmWidth: 527,
    mmHeight: 296,
    cur: { width: 1920, height: 1080, rate: 60 },
    list: [
      [2560, 1440, rates(60, 59.95)],
      [1920, 1200, rates(60)],
      [1920, 1080, rates(60, 59.94, 50)],
      [1680, 1050, rates(59.95)],
      [1600, 900, rates(60)],
      [1440, 900, rates(59.89)],
      [1366, 768, rates(59.79)],
      [1280, 1024, rates(75.02, 60.02)],
      [1280, 800, rates(59.81)],
      [1024, 768, rates(75.03, 60)],
      [800, 600, rates(60.32, 56.25)],
    ],
  };
  let brightness = process.env.AURORA_MOCK_BRIGHTNESS ? Number(process.env.AURORA_MOCK_BRIGHTNESS) || 70 : null;
  const toOutput = () => {
    const o = {
      name: out.name,
      primary: out.primary,
      active: true,
      x: 0,
      y: 0,
      rotation: 'normal',
      mmWidth: out.mmWidth,
      mmHeight: out.mmHeight,
      width: out.cur.width,
      height: out.cur.height,
      rate: out.cur.rate,
      preferred: { width: 1920, height: 1080, rate: 60 },
      modes: out.list.map(([w, h, r]) => ({ width: w, height: h, rates: r, preferred: w === 1920 && h === 1080, names: Object.fromEntries(r.map((x) => [x, `${w}x${h}`])) })),
    };
    return o;
  };
  return {
    mock: true,
    async query() {
      return { screen: { width: out.cur.width, height: out.cur.height }, outputs: [toOutput()] };
    },
    async apply(name, width, height, rate) {
      if (name !== out.name) throw err(`Display ${name} is not connected`, 'ENOTFOUND');
      const o = toOutput();
      const m = modeName(o, width, height, rate);
      if (!m) throw err(`Mode ${width}x${height} is not supported by ${name}`, 'EINVAL');
      const previous = { ...out.cur };
      out.cur = { width: Number(width), height: Number(height), rate: m.rate };
      return { previous, current: { ...out.cur } };
    },
    brightness: () => brightness,
    setBrightness: async (n) => {
      if (brightness == null) throw err('This display has no adjustable backlight', 'ENOTSUP');
      brightness = Math.max(0, Math.min(100, Math.round(n)));
      return true;
    },
  };
}

// ------------------------------------------------------------------ registration
function register(api) {
  const useMock = api.DEV && process.env.AURORA_REAL_BACKENDS !== '1';
  const be = useMock ? mockBackend() : which('xrandr') ? xrandrBackend() : null;

  async function status() {
    let outputs = [];
    if (be) {
      try {
        outputs = (await be.query()).outputs.map(publicOutput);
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
    return { outputs, brightness: be?.mock ? be.brightness() : readBrightness() };
  }

  api.handle('display:status', status);
  api.handle('display:setMode', async (name, width, height, rate) => {
    if (!be) throw err('Changing the screen mode needs xrandr', 'ENOTSUP');
    if (!/^[\w.-]{1,32}$/.test(String(name)) || !(Number(width) > 0) || !(Number(height) > 0)) throw err('Invalid display mode', 'EINVAL');
    const res = await be.apply(String(name), Number(width), Number(height), rate == null ? null : Number(rate));
    api.broadcast('display:changed', await status());
    return res;
  });
  api.handle('display:save', async () => {
    const st = await status();
    const cfg = { version: 1, outputs: {} };
    for (const o of st.outputs) {
      if (o.readOnly || !o.width) continue;
      let mode = `${o.width}x${o.height}`;
      if (be && !be.mock) {
        const q = (await be.query().catch(() => ({ outputs: [] }))).outputs.find((x) => x.name === o.name);
        if (q?.mode) mode = q.mode;
      }
      cfg.outputs[o.name] = { width: o.width, height: o.height, rate: o.rate, mode, primary: !!o.primary };
    }
    fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
    fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2));
    return cfg;
  });
  api.handle('display:saved', () => readJson(CONFIG));
  api.handle('display:applySaved', async () => {
    const cfg = readJson(CONFIG);
    if (!cfg?.outputs || !be) return [];
    const applied = [];
    const { outputs } = await be.query();
    for (const o of outputs) {
      const want = cfg.outputs[o.name];
      if (!want) continue;
      if (o.width === want.width && o.height === want.height && (want.rate == null || Math.abs((o.rate || 0) - want.rate) < 0.05)) continue;
      try {
        await be.apply(o.name, want.width, want.height, want.rate);
        applied.push(o.name);
      } catch (e) {
        console.error(`[display] could not restore ${o.name}:`, e.message);
      }
    }
    if (applied.length) api.broadcast('display:changed', await status());
    return applied;
  });
  api.handle('display:setBrightness', async (n) => {
    const v = Math.max(0, Math.min(100, Math.round(Number(n))));
    if (Number.isNaN(v)) throw err('Invalid brightness', 'EINVAL');
    if (be?.mock) await be.setBrightness(v);
    else await writeBrightness(v);
    return v;
  });
}

module.exports = register;
module.exports.parsers = parsers;
