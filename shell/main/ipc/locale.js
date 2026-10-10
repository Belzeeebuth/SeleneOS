'use strict';
// Time, language and input settings.
//
//   locale:status          -> { timezone, ntp, ntpSynced, canNtp, locale, language, keyboard, systemKeyboard: { layout, variant } }
//                               keyboard = session layout as stored in settings.keyboardLayout: 'fr', 'ch(fr)', 'us(intl)'
//   locale:timezones       -> ['Africa/Abidjan', …, 'UTC']   (timedatectl list-timezones, else /usr/share/zoneinfo)
//   locale:setKeyboard (layout)  -> applies the layout to this session (setxkbmap) and persists it in
//                               settings.keyboardLayout (aurora-common re-applies it at every sign-in)
//   input:mouse            -> { available, speed -1..1, leftHanded, devices: [names] }
//   input:setMouse ({ speed?, leftHanded? })  -> applies with xinput (libinput properties) + persists settings.mouse
//
// Changing the time zone, NTP, the system locale or the system keyboard needs root: the Settings app
// uses shell.runAdmin('set-timezone' | 'set-ntp' | 'set-locale' | 'set-keyboard', …) (admin.js).
const fs = require('fs');
const path = require('path');
const { run, which } = require('../lib/exec');

const RE_LAYOUT = /^([a-z]{2,3})(?:\(([a-z0-9_-]{1,32})\))?$/;

// ------------------------------------------------------------------ parsers (unit-tested)
/** `timedatectl show` -> { timezone, ntp, ntpSynced, canNtp } */
function parseTimedatectl(text) {
  const kv = {};
  for (const l of String(text || '').split('\n')) {
    const i = l.indexOf('=');
    if (i > 0) kv[l.slice(0, i).trim()] = l.slice(i + 1).trim();
  }
  const yes = (v) => (v == null ? null : v === 'yes');
  return { timezone: kv.Timezone || null, ntp: yes(kv.NTP), ntpSynced: yes(kv.NTPSynchronized), canNtp: yes(kv.CanNTP) };
}

/** Shell-style KEY="value" file (/etc/default/locale, /etc/default/keyboard) */
function parseEnvFile(text) {
  const out = {};
  for (const l of String(text || '').split('\n')) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)=(["']?)(.*?)\2\s*$/.exec(l);
    if (m) out[m[1]] = m[3];
  }
  return out;
}

/** `setxkbmap -query` -> { layout, variant, options } */
function parseXkbQuery(text) {
  const kv = {};
  for (const l of String(text || '').split('\n')) {
    const m = /^(\w+):\s*(.*)$/.exec(l.trim());
    if (m) kv[m[1]] = m[2].trim();
  }
  return { layout: kv.layout || null, variant: kv.variant || '', options: kv.options || '' };
}

/** 'ch(fr)' -> { layout: 'ch', variant: 'fr' } ; also accepts 'fr+bepo' and 'fr:bepo' (as aurora-common does) */
function splitLayout(s) {
  const v = String(s || '').trim();
  let m = RE_LAYOUT.exec(v);
  if (m) return { layout: m[1], variant: m[2] || '' };
  m = /^([a-z]{2,3})[+:]([a-z0-9_-]{1,32})$/.exec(v);
  if (m) return { layout: m[1], variant: m[2] };
  return null;
}
const joinLayout = (layout, variant) => (variant ? `${layout}(${variant})` : layout);

/** `xinput list` -> slave pointer devices [{ id, name }] */
function parseXinputList(text) {
  const out = [];
  for (const l of String(text || '').split('\n')) {
    const m = /^\W*(.+?)\s+id=(\d+)\s+\[slave\s+pointer/.exec(l);
    if (m && !/XTEST/i.test(m[1])) out.push({ id: Number(m[2]), name: m[1].trim() });
  }
  return out;
}

/** `xinput list-props <id>` -> { accel: number|null, leftHanded: bool|null } */
function parseXinputProps(text) {
  const a = /libinput Accel Speed \(\d+\):\s*(-?[\d.]+)/.exec(text || '');
  const lh = /libinput Left Handed Enabled \(\d+\):\s*(\d)/.exec(text || '');
  return { accel: a ? Number(a[1]) : null, leftHanded: lh ? lh[1] === '1' : null };
}

function listZoneinfo(root = '/usr/share/zoneinfo') {
  const out = [];
  const walk = (dir, rel) => {
    let ents = [];
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (!rel && (/^[a-z]/.test(e.name) || ['posix', 'right', 'Etc', 'SystemV', 'US', 'Mideast', 'Canada', 'Brazil', 'Chile', 'Mexico'].includes(e.name))) continue;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else if (rel && /^[A-Z]/.test(e.name)) out.push(r);
    }
  };
  walk(root, '');
  out.push('UTC');
  return out.sort();
}

const parsers = { parseTimedatectl, parseEnvFile, parseXkbQuery, splitLayout, joinLayout, parseXinputList, parseXinputProps };

function err(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}
function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function register(api) {
  const useMock = api.DEV && process.env.AURORA_REAL_BACKENDS !== '1';
  const dev = useMock ? require('./admin').dev : null;
  const mockMouse = { speed: 0, leftHanded: false };
  const getSetting = (k) => api.settings?.get(k);
  const setSetting = (k, v) => api.settings?.set(k, v);

  function systemKeyboard() {
    if (useMock) return { ...dev.keyboard };
    const kb = parseEnvFile(readText('/etc/default/keyboard'));
    return { layout: (kb.XKBLAYOUT || 'us').split(',')[0], variant: (kb.XKBVARIANT || '').split(',')[0] };
  }

  async function sessionKeyboard() {
    const saved = getSetting('keyboardLayout');
    if (saved && splitLayout(saved)) return saved;
    if (!useMock && which('setxkbmap')) {
      const r = await run('setxkbmap', ['-query'], { timeout: 4000 }).catch(() => null);
      const q = r?.code === 0 ? parseXkbQuery(r.stdout) : null;
      if (q?.layout) return joinLayout(q.layout.split(',')[0], (q.variant || '').split(',')[0]);
    }
    const s = systemKeyboard();
    return joinLayout(s.layout, s.variant);
  }

  api.handle('locale:status', async () => {
    let td = { timezone: null, ntp: null, ntpSynced: null, canNtp: null };
    let loc = {};
    if (useMock) {
      td = { timezone: dev.timezone, ntp: dev.ntp, ntpSynced: dev.ntp, canNtp: true };
      loc = { LANG: dev.locale };
    } else {
      if (which('timedatectl')) {
        const r = await run('timedatectl', ['show'], { timeout: 5000 }).catch(() => null);
        if (r?.code === 0) td = parseTimedatectl(r.stdout);
      }
      if (!td.timezone) {
        td.timezone = readText('/etc/timezone').trim() || null;
        if (!td.timezone) {
          try {
            td.timezone = fs.readlinkSync('/etc/localtime').replace(/^.*zoneinfo\//, '') || null;
          } catch {}
        }
      }
      loc = parseEnvFile(readText('/etc/default/locale'));
    }
    const locale = loc.LANG || process.env.LANG || 'en_US.UTF-8';
    return {
      timezone: td.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      ntp: td.ntp,
      ntpSynced: td.ntpSynced,
      canNtp: td.canNtp,
      locale,
      language: loc.LANGUAGE || null,
      keyboard: await sessionKeyboard(),
      systemKeyboard: systemKeyboard(),
    };
  });

  let tzCache = null;
  api.handle('locale:timezones', async () => {
    if (tzCache) return tzCache;
    let list = [];
    if (!useMock && which('timedatectl')) {
      const r = await run('timedatectl', ['list-timezones'], { timeout: 8000 }).catch(() => null);
      if (r?.code === 0) list = r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    }
    if (!list.length) list = listZoneinfo();
    if (list.length <= 1) {
      try {
        list = Intl.supportedValuesOf('timeZone');
      } catch {}
    }
    tzCache = [...new Set(list)].sort();
    return tzCache;
  });

  api.handle('locale:setKeyboard', async (value) => {
    const kb = splitLayout(value);
    if (!kb) throw err('Invalid keyboard layout', 'EINVAL');
    if (!useMock) {
      if (!fs.existsSync(`/usr/share/X11/xkb/symbols/${kb.layout}`) && fs.existsSync('/usr/share/X11/xkb/symbols')) throw err(`Unknown keyboard layout: ${kb.layout}`, 'ENOTFOUND');
      if (!which('setxkbmap')) throw err('setxkbmap is not available', 'ENOTSUP');
      const r = await run('setxkbmap', ['-layout', kb.layout, '-variant', kb.variant], { timeout: 5000 });
      if (r.code !== 0) throw err((r.stderr || 'setxkbmap failed').trim(), 'ECMD');
    }
    const stored = joinLayout(kb.layout, kb.variant);
    setSetting('keyboardLayout', stored);
    return stored;
  });

  // ---------------------------------------------------------------- pointer (xinput / libinput)
  async function pointers() {
    if (!which('xinput')) return [];
    const r = await run('xinput', ['list'], { timeout: 4000 }).catch(() => null);
    return r?.code === 0 ? parseXinputList(r.stdout) : [];
  }
  async function applyMouse({ speed, leftHanded }) {
    const devs = await pointers();
    let applied = 0;
    for (const d of devs) {
      const props = await run('xinput', ['list-props', String(d.id)], { timeout: 4000 }).catch(() => null);
      const p = parseXinputProps(props?.stdout);
      if (speed != null && p.accel != null) {
        await run('xinput', ['set-prop', String(d.id), 'libinput Accel Speed', Number(speed).toFixed(2)], { timeout: 4000 }).catch(() => {});
        applied++;
      }
      if (leftHanded != null && p.leftHanded != null) {
        await run('xinput', ['set-prop', String(d.id), 'libinput Left Handed Enabled', leftHanded ? '1' : '0'], { timeout: 4000 }).catch(() => {});
        applied++;
      }
    }
    return applied;
  }
  api.handle('input:mouse', async () => {
    const saved = getSetting('mouse') || {};
    if (useMock) return { available: true, speed: mockMouse.speed, leftHanded: mockMouse.leftHanded, devices: ['ImExPS/2 Generic Explorer Mouse', 'QEMU USB Tablet'], simulated: true };
    const devs = await pointers();
    let live = { accel: null, leftHanded: null };
    for (const d of devs) {
      const props = await run('xinput', ['list-props', String(d.id)], { timeout: 4000 }).catch(() => null);
      live = parseXinputProps(props?.stdout);
      if (live.accel != null) break;
    }
    return {
      available: devs.length > 0 && (live.accel != null || live.leftHanded != null),
      speed: live.accel ?? saved.speed ?? 0,
      leftHanded: live.leftHanded ?? !!saved.leftHanded,
      devices: devs.map((d) => d.name),
    };
  });
  api.handle('input:setMouse', async (opts = {}) => {
    const cur = { speed: 0, leftHanded: false, ...(getSetting('mouse') || {}) };
    if (opts.speed != null) {
      const s = Number(opts.speed);
      if (!(s >= -1 && s <= 1)) throw err('Pointer speed must be between -1 and 1', 'EINVAL');
      cur.speed = Math.round(s * 100) / 100;
    }
    if (opts.leftHanded != null) cur.leftHanded = !!opts.leftHanded;
    if (useMock) Object.assign(mockMouse, cur);
    else await applyMouse({ speed: opts.speed != null ? cur.speed : null, leftHanded: opts.leftHanded != null ? cur.leftHanded : null });
    setSetting('mouse', cur);
    return cur;
  });

  // Re-apply the saved pointer preferences at session start (the X session does the keyboard).
  if (!useMock && api.env?.mode === 'shell') {
    setTimeout(() => {
      const m = getSetting('mouse');
      if (m && (m.speed || m.leftHanded)) applyMouse({ speed: m.speed || 0, leftHanded: !!m.leftHanded }).catch(() => {});
    }, 3000).unref?.();
  }
}

module.exports = register;
module.exports.parsers = parsers;
