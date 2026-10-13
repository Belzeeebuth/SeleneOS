'use strict';
// Touchpad + power (inputpower track).
//
//   input:touchpad         -> { available, enabled, tap, natural, scrollSpeed 1..10, dwt, devices: [names] }
//                             available = a pointer with the libinput "Tapping Enabled" property (only touchpads have it)
//   input:setTouchpad ({ enabled?, tap?, natural?, scrollSpeed?, dwt? })  -> applies with xinput + persists settings.touchpad
//   power:profiles         -> null (power-profiles-daemon missing) | { active, profiles: ['power-saver', 'balanced', 'performance'?] }
//   power:setProfile (name)  -> powerprofilesctl set <name> (polkit allows the active session, no root)
//   power:lid              -> { action: 'suspend' | 'ignore' | 'poweroff' }  (/etc/systemd/logind.conf.d/50-aurora-lid.conf)
//                             changing it: shell.runAdmin('power-lid', [action]) (aurora-admin writes the drop-in)
//   power:screenOff        -> turns the screen off now (xset dpms force off; any input wakes it)
//
// The touchpad settings are re-applied at session start (shell mode). Tap-to-click is also on by default from
// /etc/X11/xorg.conf.d/40-aurora-touchpad.conf (sign-in screen, before the shell starts).
// Dev / tests: AURORA_XINPUT, AURORA_POWERPROFILESCTL, AURORA_XSET = fake binaries; AURORA_LOGIND_DIR = drop-in
// directory. Without them dev mode simulates: no touchpad, no power-profiles-daemon, screen-off only logged.
const fs = require('fs');
const path = require('path');
const { run, which } = require('../lib/exec');

const LID_ACTIONS = ['suspend', 'ignore', 'poweroff'];
const LID_FILE = '50-aurora-lid.conf';
// Scroll speed 1..10 -> libinput Scrolling Pixel Distance (pixels per wheel click; smaller = faster). 5 = libinput's 15.
const SCROLL_PX = [40, 32, 25, 20, 15, 12, 10, 8, 6, 5];
const TOUCHPAD_DEFAULTS = { enabled: true, tap: true, natural: false, scrollSpeed: 5, dwt: true };

// ------------------------------------------------------------------ parsers (unit-tested)
/** `xinput list` -> slave pointers [{ id, name }] */
function parsePointers(text) {
  const out = [];
  for (const l of String(text || '').split('\n')) {
    const m = /^\W*(.+?)\s+id=(\d+)\s+\[slave\s+pointer/.exec(l);
    if (m && !/XTEST/i.test(m[1])) out.push({ id: Number(m[2]), name: m[1].trim() });
  }
  return out;
}

/** `xinput list-props <id>` -> touchpad properties (null when the device lacks one). */
function parseTouchpadProps(text) {
  const s = String(text || '');
  const val = (name) => {
    const m = new RegExp(`^\\s*${name.replace(/ /g, '\\s')} \\(\\d+\\):\\s*([-\\d.]+)`, 'm').exec(s);
    return m ? Number(m[1]) : null;
  };
  const b = (v) => (v == null ? null : v === 1);
  return {
    enabled: b(val('Device Enabled')),
    tap: b(val('libinput Tapping Enabled')),
    natural: b(val('libinput Natural Scrolling Enabled')),
    dwt: b(val('libinput Disable While Typing Enabled')),
    scrollPx: val('libinput Scrolling Pixel Distance'),
  };
}
const isTouchpad = (p) => p.tap != null;
const scrollPxOf = (speed) => SCROLL_PX[Math.max(1, Math.min(10, Math.round(Number(speed) || 5))) - 1];
function scrollSpeedOf(px) {
  if (px == null) return null;
  let best = 5;
  SCROLL_PX.forEach((v, i) => {
    if (Math.abs(v - px) < Math.abs(SCROLL_PX[best - 1] - px)) best = i + 1;
  });
  return best;
}

/** `powerprofilesctl list` -> { active, profiles } (profiles in the daemon's order, power-saver first). */
function parseProfiles(text) {
  const profiles = [];
  let active = null;
  for (const l of String(text || '').split('\n')) {
    const m = /^(\*?)\s*([a-z][a-z-]*):\s*$/.exec(l);
    if (!m) continue;
    profiles.push(m[2]);
    if (m[1]) active = m[2];
  }
  const order = ['power-saver', 'balanced', 'performance'];
  const known = order.filter((p) => profiles.includes(p));
  return known.length ? { active: known.includes(active) ? active : 'balanced', profiles: known } : null;
}

/** logind drop-in text -> lid action (logind's default when unset: suspend). */
function parseLid(text) {
  const m = /^\s*HandleLidSwitch\s*=\s*(\w+)/m.exec(String(text || ''));
  return m && LID_ACTIONS.includes(m[1]) ? m[1] : 'suspend';
}

const parsers = { parsePointers, parseTouchpadProps, parseProfiles, parseLid, scrollPxOf, scrollSpeedOf, SCROLL_PX };

function err(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// Dev: simulated lid setting (admin.js delegates power-lid here).
const devState = { lid: 'suspend' };
async function devRun(action, args) {
  if (action !== 'power-lid' || !LID_ACTIONS.includes(args[0])) throw err(`Action not allowed: ${action}`, 'EINVAL');
  devState.lid = args[0];
  const dir = process.env.AURORA_LOGIND_DIR;
  if (dir) fs.writeFileSync(path.join(dir, LID_FILE), `[Login]\nHandleLidSwitch=${args[0]}\nHandleLidSwitchExternalPower=${args[0]}\n`);
  return 'ok\n';
}

function register(api) {
  const env = process.env;
  const DEV = !!api.DEV && env.AURORA_REAL_BACKENDS !== '1';
  const bin = (name, envName) => (DEV ? (env[envName] && fs.existsSync(env[envName]) ? env[envName] : null) : which(name));
  const getSetting = (k) => api.settings?.get(k);
  const setSetting = (k, v) => api.settings?.set(k, v);
  const saved = () => ({ ...TOUCHPAD_DEFAULTS, ...(getSetting('touchpad') || {}) });

  // ---------------------------------------------------------------- touchpad
  async function touchpads() {
    const x = bin('xinput', 'AURORA_XINPUT');
    if (!x) return [];
    const r = await run(x, ['list'], { timeout: 4000 }).catch(() => null);
    const out = [];
    for (const d of r?.code === 0 ? parsePointers(r.stdout) : []) {
      const p = await run(x, ['list-props', String(d.id)], { timeout: 4000 }).catch(() => null);
      const props = parseTouchpadProps(p?.stdout);
      if (isTouchpad(props)) out.push({ ...d, props });
    }
    return out;
  }
  async function applyTouchpad(patch) {
    const x = bin('xinput', 'AURORA_XINPUT');
    if (!x) return 0;
    const set = { enabled: 'Device Enabled', tap: 'libinput Tapping Enabled', natural: 'libinput Natural Scrolling Enabled', dwt: 'libinput Disable While Typing Enabled' };
    let n = 0;
    for (const d of await touchpads()) {
      for (const [k, prop] of Object.entries(set)) {
        if (patch[k] == null || d.props[k] == null) continue;
        await run(x, ['set-prop', String(d.id), prop, patch[k] ? '1' : '0'], { timeout: 4000 }).catch(() => {});
        n++;
      }
      if (patch.scrollSpeed != null && d.props.scrollPx != null) {
        await run(x, ['set-prop', String(d.id), 'libinput Scrolling Pixel Distance', String(scrollPxOf(patch.scrollSpeed))], { timeout: 4000 }).catch(() => {});
        n++;
      }
    }
    return n;
  }
  api.handle('input:touchpad', async () => {
    const s = saved();
    const tps = await touchpads();
    if (!tps.length) return { available: false, ...s, devices: [] };
    const p = tps[0].props;
    return {
      available: true,
      enabled: p.enabled ?? s.enabled,
      tap: p.tap ?? s.tap,
      natural: p.natural ?? s.natural,
      dwt: p.dwt ?? s.dwt,
      scrollSpeed: scrollSpeedOf(p.scrollPx) ?? s.scrollSpeed,
      hasScrollSpeed: p.scrollPx != null,
      devices: tps.map((d) => d.name),
    };
  });
  api.handle('input:setTouchpad', async (opts = {}) => {
    const cur = saved();
    const patch = {};
    for (const k of ['enabled', 'tap', 'natural', 'dwt']) if (opts[k] != null) patch[k] = cur[k] = !!opts[k];
    if (opts.scrollSpeed != null) {
      const v = Number(opts.scrollSpeed);
      if (!(Number.isInteger(v) && v >= 1 && v <= 10)) throw err('Scroll speed must be 1 to 10', 'EINVAL');
      patch.scrollSpeed = cur.scrollSpeed = v;
    }
    await applyTouchpad(patch);
    setSetting('touchpad', cur);
    return cur;
  });

  // ---------------------------------------------------------------- power profiles
  api.handle('power:profiles', async () => {
    const ppc = bin('powerprofilesctl', 'AURORA_POWERPROFILESCTL');
    if (!ppc) return null;
    const r = await run(ppc, ['list'], { timeout: 5000 }).catch(() => null);
    const st = r?.code === 0 ? parseProfiles(r.stdout) : null;
    return st && st.profiles.length > 1 ? st : null;
  });
  api.handle('power:setProfile', async (name) => {
    if (!['power-saver', 'balanced', 'performance'].includes(name)) throw err('Unknown power mode', 'EINVAL');
    const ppc = bin('powerprofilesctl', 'AURORA_POWERPROFILESCTL');
    if (!ppc) throw err('power-profiles-daemon is not installed', 'ENOTSUP');
    const r = await run(ppc, ['set', name], { timeout: 8000 });
    if (r.code !== 0) throw err((r.stderr || 'powerprofilesctl failed').trim(), 'ECMD');
    api.broadcast('power:profile', name);
    return name;
  });

  // ---------------------------------------------------------------- lid + screen
  api.handle('power:lid', () => {
    const dir = DEV ? env.AURORA_LOGIND_DIR : '/etc/systemd/logind.conf.d';
    if (DEV && !dir) return { action: devState.lid };
    let text = '';
    try {
      text = fs.readFileSync(path.join(dir, LID_FILE), 'utf8');
    } catch {}
    return { action: parseLid(text) };
  });
  api.handle('power:screenOff', async () => {
    const x = bin('xset', 'AURORA_XSET');
    if (!x) {
      if (DEV) console.log('[power] (dev) screen off');
      return !!DEV;
    }
    // DPMS on with no timeouts of its own (the shell decides when), then off now; any input turns it back on.
    await run(x, ['+dpms'], { timeout: 3000 }).catch(() => {});
    await run(x, ['dpms', '0', '0', '0'], { timeout: 3000 }).catch(() => {});
    const r = await run(x, ['dpms', 'force', 'off'], { timeout: 3000 }).catch(() => null);
    return r?.code === 0;
  });

  // Session start: the saved touchpad preferences (tap-to-click on by default).
  if (api.env?.mode === 'shell' && (!DEV || env.AURORA_XINPUT)) {
    // Never locks the person out: a touchpad turned off stays on at sign-in when it is the only pointer (no mouse).
    const atStart = async () => {
      const s = saved();
      if (s.enabled === false) {
        const x = bin('xinput', 'AURORA_XINPUT');
        const r = x ? await run(x, ['list'], { timeout: 4000 }).catch(() => null) : null;
        const tpIds = new Set((await touchpads()).map((d) => d.id));
        const others = r?.code === 0 ? parsePointers(r.stdout).filter((d) => !tpIds.has(d.id)) : [];
        if (!others.length) s.enabled = true;
      }
      return applyTouchpad(s);
    };
    setTimeout(() => atStart().catch(() => {}), DEV ? 300 : 3000).unref?.();
  }
}

module.exports = register;
module.exports.parsers = parsers;
module.exports.devRun = devRun;
module.exports.TOUCHPAD_DEFAULTS = TOUCHPAD_DEFAULTS;
