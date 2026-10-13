'use strict';
// Bluetooth backend: BlueZ over D-Bus through the session helper rootfs/usr/lib/aurora/helpers/aurora-bluetooth
// (python3-dbus, JSON lines; it also is the pairing agent), rfkill for the radio switch.
//
//   bluetooth:status            -> { available, reason?, powered, blocked: 'soft'|'hard'|null, discovering, name, address,
//                                    devices: [{ address, name, kind, icon, paired, connected, battery, rssi }] }
//   bluetooth:setPowered (bool)   unblocks rfkill (the session user may: 70-uaccess.rules tags /dev/rfkill) then Powered
//   bluetooth:scan (bool)         discovery for 30 s (« Rechercher des appareils »)
//   bluetooth:pair|connect|disconnect|forget (address)
//   bluetooth:agentReply ({ req, accept, value })   answer to a pairing request
//   event bluetooth:changed (status)    event bluetooth:agent ({ req, kind, address, name, kind, passkey })
//
// No root: Ubuntu's bluez D-Bus policy lets any local user talk to org.bluez (see the helper's header).
// Dev mode (and AURORA_BT_DEV=1) simulates an adapter; AURORA_BT_DEV=none|off|blocked|hard picks a fixture.
const fs = require('fs');
const { spawn } = require('child_process');
const { run, which } = require('../lib/exec');

const HELPER = process.env.AURORA_BT_HELPER || '/usr/lib/aurora/helpers/aurora-bluetooth';
const ADDR_RE = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/;
const SCAN_SECONDS = 30;

// ------------------------------------------------------------------ parsers (unit-tested)
// BlueZ "Icon" (freedesktop names) first, then the Class of Device, then the LE Appearance.
const ICON_KINDS = {
  'audio-headphones': 'headphones',
  'audio-headset': 'headset',
  'audio-card': 'speaker',
  'audio-speakers': 'speaker',
  'input-mouse': 'mouse',
  'input-keyboard': 'keyboard',
  'input-gaming': 'gamepad',
  'input-tablet': 'tablet',
  phone: 'phone',
  computer: 'computer',
  printer: 'printer',
  'camera-photo': 'camera',
  'camera-video': 'camera',
  'video-display': 'display',
  'multimedia-player': 'speaker',
};
function deviceKind(d = {}) {
  if (ICON_KINDS[d.icon]) return ICON_KINDS[d.icon];
  const cls = Number(d.class);
  if (Number.isFinite(cls) && cls > 0) {
    const major = (cls >> 8) & 0x1f;
    const minor = (cls >> 2) & 0x3f;
    if (major === 0x01) return 'computer';
    if (major === 0x02) return 'phone';
    if (major === 0x04) return [0x01, 0x02].includes(minor) ? 'headset' : minor === 0x06 ? 'headphones' : 'speaker';
    if (major === 0x05) {
      if (minor & 0x10) return 'keyboard';
      if (minor & 0x20) return 'mouse';
      if ([0x01, 0x02].includes(minor & 0x0f)) return 'gamepad';
      return 'input';
    }
    if (major === 0x06) return 'printer';
  }
  const app = Number(d.appearance);
  if (Number.isFinite(app) && app > 0) {
    const cat = app >> 6;
    if (cat === 0x0f) return [0x3c1].includes(app) ? 'keyboard' : app === 0x3c2 ? 'mouse' : [0x3c3, 0x3c4].includes(app) ? 'gamepad' : 'input';
    if (cat === 0x01) return 'phone';
    if (cat === 0x02) return 'computer';
    if (cat === 0x25 || cat === 0x21) return 'headphones';
  }
  return 'other';
}

/** `rfkill --json` (util-linux 2.39) -> { soft, hard } for the bluetooth switches (any blocked counts). */
function parseRfkill(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  const list = (doc && (doc.rfkilldevices || doc[''])) || [];
  const bt = list.filter((r) => r && r.type === 'bluetooth');
  if (!bt.length) return null;
  return { soft: bt.some((r) => r.soft === 'blocked'), hard: bt.some((r) => r.hard === 'blocked') };
}

/** Helper state + rfkill -> the status the renderer gets. Paired devices first, then by name. */
function normalizeState(raw, rf) {
  if (!raw || !raw.available || !raw.adapter) return { available: false, reason: raw?.reason || 'noadapter', powered: false, blocked: null, discovering: false, devices: [] };
  const a = raw.adapter;
  const blocked = rf?.hard ? 'hard' : rf?.soft || a.powerState === 'off-blocked' ? 'soft' : null;
  const devices = (raw.devices || [])
    .filter((d) => d && ADDR_RE.test(String(d.address || '').toUpperCase()) && !d.blocked)
    // nearby devices without a name (just an address) are noise in the list
    .filter((d) => d.paired || d.hasName !== false)
    .map((d) => ({
      address: String(d.address).toUpperCase(),
      name: String(d.name || d.address),
      kind: deviceKind(d),
      icon: d.icon || '',
      paired: !!d.paired,
      connected: !!d.connected,
      battery: Number.isFinite(d.battery) ? Math.max(0, Math.min(100, d.battery)) : null,
      rssi: Number.isFinite(d.rssi) ? d.rssi : null,
    }))
    .sort((x, y) => Number(y.paired) - Number(x.paired) || Number(y.connected) - Number(x.connected) || (y.rssi ?? -999) - (x.rssi ?? -999) || x.name.localeCompare(y.name));
  return { available: true, powered: !!a.powered && !blocked, blocked, discovering: !!a.discovering && !!a.powered, name: a.name || '', address: a.address || '', devices };
}

const parsers = { deviceKind, parseRfkill, normalizeState };

function err(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}
function checkAddr(address) {
  const a = String(address || '').toUpperCase();
  if (!ADDR_RE.test(a)) throw err('Invalid Bluetooth address', 'EINVAL');
  return a;
}

// ------------------------------------------------------------------ real backend (helper process)
function helperBackend(api) {
  let child = null;
  let seq = 0;
  const pending = new Map();
  let raw = null;
  let rf = null;
  let fatal = null;
  let restarts = 0;

  async function readRfkill() {
    if (!which('rfkill')) return null;
    const r = await run('rfkill', ['--json'], { timeout: 4000 }).catch(() => null);
    return r && r.code === 0 ? parseRfkill(r.stdout) : null;
  }
  const status = () => (fatal && !raw ? { ...normalizeState(null), reason: fatal } : normalizeState(raw, rf));
  const push = () => api.broadcast('bluetooth:changed', status());

  function start() {
    if (child) return child;
    const python = process.env.AURORA_BT_PYTHON || '/usr/bin/python3';
    if (!fs.existsSync(HELPER) || !which(python)) {
      fatal = 'nohelper';
      return null;
    }
    child = spawn(python, ['-I', HELPER], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, LC_ALL: 'C.UTF-8' } });
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        onMessage(m);
      }
    });
    child.stderr.on('data', (d) => api.DEV && console.warn('[bluetooth]', String(d).trim()));
    child.on('exit', (code) => {
      child = null;
      for (const p of pending.values()) p.reject(err('Bluetooth helper stopped', 'EHELPER'));
      pending.clear();
      if (code === 3) fatal = 'nobus';
      // restart once in a while (bluetoothd restarts are handled inside the helper)
      if (restarts++ < 5 && !stopping) setTimeout(start, 2000);
    });
    child.on('error', () => {
      fatal = 'nohelper';
    });
    return child;
  }
  let stopping = false;

  function onMessage(m) {
    if (m.id != null && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.ok) p.resolve(m.result);
      else p.reject(err(m.error || m.code, m.code || 'EFAIL'));
      return;
    }
    if (m.event === 'state') {
      raw = m.state;
      fatal = null;
      push();
    } else if (m.event === 'agent') {
      api.broadcast('bluetooth:agent', { req: m.req, kind: m.kind, address: m.address, name: m.name, deviceKind: deviceKind({ icon: m.icon }), passkey: m.passkey ?? null });
    } else if (m.event === 'fatal') {
      fatal = m.code === 'ENOBUS' ? 'nobus' : 'nohelper';
    }
  }

  function call(cmd, args = {}, timeout = 130000) {
    const c = start();
    if (!c) return Promise.reject(err('Bluetooth is not available', 'ENOTSUP'));
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(err('Bluetooth did not answer', 'ETIMEDOUT'));
      }, timeout);
      pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      c.stdin.write(`${JSON.stringify({ id, cmd, ...args })}\n`);
    });
  }

  return {
    async status() {
      rf = await readRfkill();
      if (!start()) return status();
      raw = await call('state', {}, 8000).catch(() => raw);
      return status();
    },
    async setPowered(on) {
      if (on) {
        rf = await readRfkill();
        if (rf?.hard) throw err('Bluetooth is switched off by a hardware switch', 'EHARDBLOCK');
        if (rf?.soft || raw?.adapter?.powerState === 'off-blocked') {
          const r = await run('rfkill', ['unblock', 'bluetooth'], { timeout: 5000 }).catch((e) => ({ code: 1, stderr: e.message }));
          if (r.code !== 0) throw err(`rfkill: ${(r.stderr || '').trim() || 'permission denied'}`, 'ERFKILL');
          await new Promise((res) => setTimeout(res, 400)); // bluetoothd sees the unblock
        }
      }
      await call('power', { on: !!on });
      rf = await readRfkill();
      return true;
    },
    scan: (on) => call('scan', { on: !!on, timeout: SCAN_SECONDS }),
    pair: (a) => call('pair', { address: a }),
    connect: (a) => call('connect', { address: a }, 70000),
    disconnect: (a) => call('disconnect', { address: a }, 70000),
    forget: (a) => call('remove', { address: a }),
    agentReply: (r) => call('agent-reply', r, 5000),
    stop() {
      stopping = true;
      child?.kill();
    },
  };
}

// ------------------------------------------------------------------ dev mock
function mockBackend(api, variant) {
  const st = {
    adapter: variant === 'none' ? null : { path: '/org/bluez/hci0', address: '00:1A:7D:DA:71:13', name: 'selene', powered: !['off', 'blocked', 'hard'].includes(variant), discovering: false, powerState: variant === 'blocked' ? 'off-blocked' : 'on' },
    devices: [
      { address: 'AC:80:0A:12:34:56', name: 'Casque WH-1000XM4', icon: 'audio-headphones', paired: true, connected: true, battery: 80 },
      { address: 'F4:73:35:2A:9B:01', name: 'Souris MX Master 3', icon: 'input-mouse', paired: true, connected: true, battery: 45 },
      { address: 'E4:17:D8:00:00:01', name: 'Clavier K380', icon: 'input-keyboard', paired: true, connected: false, battery: null },
    ],
  };
  const NEARBY = [
    { address: '11:22:33:44:55:66', name: 'Pixel 8 de Camille', icon: 'phone', rssi: -48 },
    { address: '77:88:99:AA:BB:CC', name: 'Manette sans fil', icon: 'input-gaming', rssi: -60 },
    { address: '40:EF:4C:01:02:03', name: 'JBL Flip 6', icon: 'audio-card', rssi: -71 },
  ];
  let rf = variant === 'hard' ? { soft: false, hard: true } : variant === 'blocked' ? { soft: true, hard: false } : { soft: false, hard: false };
  let scanTimer = null;
  let req = 0;
  const waiting = new Map();
  const raw = () => ({ available: !!st.adapter, adapter: st.adapter, devices: st.devices.map((d) => ({ ...d })) });
  const status = () => normalizeState(raw(), rf);
  const push = () => api.broadcast('bluetooth:changed', status());
  const find = (a) => {
    const d = st.devices.find((x) => x.address === a);
    if (!d) throw err('No such device', 'ENOTFOUND');
    return d;
  };
  const need = () => {
    if (!st.adapter) throw err('no Bluetooth adapter', 'ENOADAPTER');
    if (!st.adapter.powered) throw err('Bluetooth is off', 'ENOTREADY');
  };
  return {
    mock: true,
    status: async () => status(),
    async setPowered(on) {
      if (!st.adapter) throw err('no Bluetooth adapter', 'ENOADAPTER');
      if (on && rf.hard) throw err('Bluetooth is switched off by a hardware switch', 'EHARDBLOCK');
      if (on) rf = { ...rf, soft: false };
      st.adapter.powered = !!on;
      st.adapter.powerState = on ? 'on' : 'off';
      if (!on) {
        st.adapter.discovering = false;
        for (const d of st.devices) d.connected = false;
      }
      push();
      return true;
    },
    async scan(on) {
      need();
      clearTimeout(scanTimer);
      st.adapter.discovering = !!on;
      push();
      if (!on) return true;
      NEARBY.forEach((n, i) =>
        setTimeout(() => {
          if (!st.adapter.discovering || st.devices.some((d) => d.address === n.address)) return;
          st.devices.push({ ...n, paired: false, connected: false, battery: null });
          push();
        }, 300 + i * 250),
      );
      scanTimer = setTimeout(() => {
        st.adapter.discovering = false;
        push();
      }, (Number(process.env.AURORA_BT_SCAN_MS) || SCAN_SECONDS * 1000));
      return true;
    },
    async pair(a) {
      need();
      const d = find(a);
      if (d.paired) throw err('Already paired', 'EEXIST');
      const id = ++req;
      const kind = d.icon === 'input-gaming' ? 'pin' : 'confirm';
      const answer = new Promise((resolve) => waiting.set(id, resolve));
      api.broadcast('bluetooth:agent', { req: id, kind, address: d.address, name: d.name, deviceKind: deviceKind(d), passkey: kind === 'confirm' ? '123456' : null });
      const r = await answer;
      if (!r.accept) throw err('Authentication Rejected', 'EREJECTED');
      if (kind === 'pin' && r.value !== '0000') throw err('Authentication Failed', 'EAUTH');
      Object.assign(d, { paired: true, connected: true, battery: d.icon === 'input-gaming' ? 60 : d.battery });
      push();
      return true;
    },
    async connect(a) {
      need();
      find(a).connected = true;
      push();
      return true;
    },
    async disconnect(a) {
      find(a).connected = false;
      push();
      return true;
    },
    async forget(a) {
      find(a);
      st.devices = st.devices.filter((d) => d.address !== a);
      push();
      return true;
    },
    async agentReply(r) {
      const fn = waiting.get(r.req);
      if (!fn) return false;
      waiting.delete(r.req);
      fn(r);
      return true;
    },
    stop() {},
  };
}

function register(api) {
  const dev = process.env.AURORA_BT_DEV;
  const useMock = (api.DEV && process.env.AURORA_REAL_BACKENDS !== '1') || (dev && dev !== '0' && dev !== 'real');
  const be = useMock ? mockBackend(api, dev && dev !== '1' ? dev : 'on') : helperBackend(api);
  const reply = (r) => {
    if (!r || typeof r !== 'object' || !Number.isInteger(r.req)) throw err('Invalid reply', 'EINVAL');
    const value = r.value == null ? '' : String(r.value);
    if (!/^[0-9A-Za-z]{0,16}$/.test(value)) throw err('Invalid PIN', 'EINVAL');
    return be.agentReply({ req: r.req, accept: !!r.accept, value });
  };
  api.handle('bluetooth:status', () => be.status());
  api.handle('bluetooth:setPowered', (on) => be.setPowered(!!on));
  api.handle('bluetooth:scan', (on) => be.scan(!!on));
  api.handle('bluetooth:pair', (a) => be.pair(checkAddr(a)));
  api.handle('bluetooth:connect', (a) => be.connect(checkAddr(a)));
  api.handle('bluetooth:disconnect', (a) => be.disconnect(checkAddr(a)));
  api.handle('bluetooth:forget', (a) => be.forget(checkAddr(a)));
  api.handle('bluetooth:agentReply', (r) => reply(r));
  // The agent must be registered from the start of the session (a phone may ask to pair at any time).
  if (!useMock && fs.existsSync(HELPER) && fs.existsSync('/sys/class/bluetooth')) be.status().catch(() => null);
  return be;
}

module.exports = register;
module.exports.parsers = parsers;
