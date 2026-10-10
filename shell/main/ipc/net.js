'use strict';
// Network backend (NetworkManager through nmcli).
//
//   net:status                  -> { connectivity: 'full'|'limited'|'none', wifiEnabled, airplane, wifiHardware,
//                                    primary: { type: 'wifi'|'ethernet'|null, name, strength, device },
//                                    devices: [{ device, type, state, connection }] }
//   net:wifiList (rescan)       -> [{ ssid, signal, security, active, saved, bssid, freq, chan, rate }]  (strongest first)
//   net:wifiConnect (ssid, password?, { hidden }?)   errors: EAUTH (wrong / missing key), ENOTFOUND
//   net:wifiDisconnect ()       net:wifiForget (ssid)
//   net:known                   -> [{ ssid, name, uuid }]  saved Wi-Fi networks (in range or not)
//   net:setWifi (bool)          net:setAirplane (bool)   (airplane = every radio off; the previous Wi-Fi state is restored)
//   net:details (device?)       -> one device (or all): { device, type, state, connection, mac, mtu, speed,
//                                    ipv4: ['192.168.1.5/24'], gateway4, dns4: [], ipv6: [], gateway6, dns6: [],
//                                    ssid, signal, security, freq, chan, rate }   (Settings > Ethernet / Wi-Fi properties)
//   net:usage                   -> [{ iface, type, rx, tx }]  bytes since boot (/proc/net/dev)
//   event net:changed (status)  pushed when NetworkManager reports a change (nmcli monitor, debounced)
//
// nmcli is always used in terse mode (-t): fields are separated by ':' and a literal ':' or '\' inside a
// value is escaped with a backslash (SSIDs and MAC addresses contain colons) — see splitTerse().
// Without nmcli: in dev mode (--dev) a mock network is simulated; otherwise the status is derived from
// /sys/class/net and the routing table and the control channels fail with ENOTSUP.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { run, which } = require('../lib/exec');

// ------------------------------------------------------------------ parsers (unit-tested)
/** Split one nmcli terse line into fields, honouring '\:' and '\\' escapes. `max` limits the number of fields. */
function splitTerse(line, max = Infinity) {
  const out = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && i + 1 < line.length) {
      cur += line[++i];
      continue;
    }
    if (c === ':' && out.length < max - 1) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

function lines(text) {
  return String(text || '')
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.length);
}

const TYPE_MAP = { wifi: 'wifi', '802-11-wireless': 'wifi', ethernet: 'ethernet', '802-3-ethernet': 'ethernet', gsm: 'wwan', cdma: 'wwan', bt: 'bluetooth', bluetooth: 'bluetooth' };
const IGNORED_TYPES = new Set(['loopback', 'wifi-p2p', 'bridge', 'tun', 'dummy', 'veth', 'ip-tunnel', 'wireguard', 'macvlan', 'vlan', 'bond', 'team', 'ovs-port', 'ovs-bridge', 'ovs-interface', 'unknown']);

/** `nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device status` */
function parseDeviceStatus(text) {
  const out = [];
  for (const l of lines(text)) {
    const [device, type, state, connection] = splitTerse(l, 4);
    if (!device || IGNORED_TYPES.has(type)) continue;
    out.push({ device, type: TYPE_MAP[type] || type, state: state || 'unknown', connection: connection && connection !== '--' ? connection : null });
  }
  return out;
}

function normSecurity(s) {
  const v = String(s || '').trim();
  return v === '--' ? '' : v;
}

/** `nmcli -t -f IN-USE,SSID,BSSID,SIGNAL,SECURITY,FREQ,CHAN,RATE device wifi list` -> deduplicated by SSID */
function parseWifiList(text, savedSsids = new Set()) {
  const bySsid = new Map();
  for (const l of lines(text)) {
    const f = splitTerse(l);
    if (f.length < 5) continue;
    const [inUse, ssid, bssid, signal, security, freq, chan, rate] = f;
    if (!ssid || ssid === '--') continue; // hidden network (no broadcast SSID)
    const n = {
      ssid,
      signal: Math.max(0, Math.min(100, parseInt(signal, 10) || 0)),
      security: normSecurity(security),
      active: inUse.trim() === '*',
      saved: savedSsids.has(ssid),
      bssid: bssid || null,
      freq: freq ? parseInt(freq, 10) || null : null,
      chan: chan ? parseInt(chan, 10) || null : null,
      rate: rate || null,
    };
    const prev = bySsid.get(ssid);
    if (!prev) bySsid.set(ssid, n);
    else {
      // Keep the access point we are associated with, otherwise the strongest one.
      if (n.active || (!prev.active && n.signal > prev.signal)) bySsid.set(ssid, { ...n, active: n.active || prev.active });
      else if (n.active) prev.active = true;
    }
  }
  return [...bySsid.values()].sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0) || b.signal - a.signal || a.ssid.localeCompare(b.ssid));
}

/** `nmcli -t -f NAME,UUID,TYPE,DEVICE connection show` */
function parseConnections(text) {
  return lines(text).map((l) => {
    const [name, uuid, type, device] = splitTerse(l, 4);
    return { name, uuid, type: TYPE_MAP[type] || type, device: device && device !== '--' ? device : null };
  });
}

/** `nmcli -t device show <dev>` (key:value lines, multi-values as KEY[n]) */
function parseDeviceShow(text) {
  const kv = {};
  for (const l of lines(text)) {
    const [k, v = ''] = splitTerse(l, 2);
    if (!k) continue;
    const key = k.replace(/\[\d+\]$/, '');
    if (/\[\d+\]$/.test(k)) (kv[key] = kv[key] || []).push(v);
    else kv[key] = v;
  }
  const arr = (k) => (Array.isArray(kv[k]) ? kv[k] : kv[k] ? [kv[k]] : []).filter((x) => x && x !== '--');
  const one = (k) => (kv[k] && kv[k] !== '--' ? (Array.isArray(kv[k]) ? kv[k][0] : kv[k]) : null);
  const stateRaw = one('GENERAL.STATE') || '';
  const m = /^\d+\s*\((.*)\)$/.exec(stateRaw);
  const type = one('GENERAL.TYPE');
  return {
    device: one('GENERAL.DEVICE'),
    type: TYPE_MAP[type] || type,
    state: m ? m[1] : stateRaw || null,
    connection: one('GENERAL.CONNECTION'),
    mac: one('GENERAL.HWADDR'),
    mtu: one('GENERAL.MTU') ? parseInt(one('GENERAL.MTU'), 10) : null,
    ipv4: arr('IP4.ADDRESS'),
    gateway4: one('IP4.GATEWAY'),
    dns4: arr('IP4.DNS'),
    ipv6: arr('IP6.ADDRESS').filter((a) => !/^fe80:/i.test(a) || arr('IP6.ADDRESS').length === 1),
    gateway6: one('IP6.GATEWAY'),
    dns6: arr('IP6.DNS'),
    domains: arr('IP4.DOMAIN'),
    speed: parseSpeed(one('CAPABILITIES.SPEED')),
    carrier: one('WIRED-PROPERTIES.CARRIER') ? one('WIRED-PROPERTIES.CARRIER') === 'on' : null,
  };
}

function parseSpeed(s) {
  const m = /^(\d+)\s*Mb/.exec(String(s || ''));
  return m ? Number(m[1]) : null;
}

/** /proc/net/route -> name of the interface carrying the default route (lowest metric) */
function parseDefaultRoute(text) {
  let best = null;
  for (const l of lines(text).slice(1)) {
    const f = l.trim().split(/\s+/);
    if (f.length < 8) continue;
    const [iface, dest, , flags, , , metric, mask] = f;
    if (dest !== '00000000' || mask !== '00000000') continue;
    if (!(parseInt(flags, 16) & 1)) continue; // RTF_UP
    const m = parseInt(metric, 10) || 0;
    if (!best || m < best.metric) best = { iface, metric: m };
  }
  return best?.iface || null;
}

/** /proc/net/dev -> [{ iface, rx, tx }] (without lo) */
function parseProcNetDev(text) {
  const out = [];
  for (const l of lines(text).slice(2)) {
    const i = l.indexOf(':');
    if (i < 0) continue;
    const iface = l.slice(0, i).trim();
    if (iface === 'lo') continue;
    const v = l.slice(i + 1).trim().split(/\s+/).map(Number);
    out.push({ iface, rx: v[0] || 0, tx: v[8] || 0 });
  }
  return out;
}

function mapConnectivity(conn, state) {
  const c = String(conn || '').trim();
  if (c === 'full') return 'full';
  if (c === 'limited' || c === 'portal') return 'limited';
  if (c === 'none') return /^connected/.test(state || '') ? 'limited' : 'none';
  // 'unknown' (connectivity checking disabled): fall back on the global state
  if (state === 'connected') return 'full';
  if (/^connected/.test(state || '')) return 'limited';
  return 'none';
}

function isAuthError(msg) {
  return /secrets were required|psk: property is invalid|802-11-wireless-security|invalid passphrase|wrong password|no secrets|key-mgmt/i.test(String(msg || ''));
}

const parsers = { splitTerse, parseDeviceStatus, parseWifiList, parseConnections, parseDeviceShow, parseDefaultRoute, parseProcNetDev, mapConnectivity, isAuthError };

// ------------------------------------------------------------------ helpers
function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

const STATE_FILE = path.join(os.homedir(), '.config', 'aurora', 'network.json');
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}
function saveState(st) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2));
  } catch {}
}

function err(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// ------------------------------------------------------------------ real backend (nmcli)
function nmBackend() {
  const nm = async (args, opts = {}) => {
    const r = await run('nmcli', args, { timeout: opts.timeout ?? 20000 });
    if (r.code !== 0 && !opts.allowFail) {
      const msg = (r.stderr || r.stdout || `nmcli ${args.join(' ')} failed`).trim().replace(/^Error:\s*/, '');
      throw err(msg, isAuthError(msg) ? 'EAUTH' : /no network with ssid|not found/i.test(msg) ? 'ENOTFOUND' : 'ENET');
    }
    return r.stdout;
  };
  const ssidCache = new Map(); // uuid -> ssid

  async function wifiProfiles() {
    const conns = parseConnections(await nm(['-t', '-f', 'NAME,UUID,TYPE,DEVICE', 'connection', 'show']));
    const wifi = conns.filter((c) => c.type === 'wifi');
    await Promise.all(
      wifi.map(async (c) => {
        if (!ssidCache.has(c.uuid)) {
          const out = await nm(['-t', '-g', '802-11-wireless.ssid', 'connection', 'show', 'uuid', c.uuid], { allowFail: true }).catch(() => '');
          const ssid = splitTerse(lines(out)[0] || '', 1)[0];
          ssidCache.set(c.uuid, ssid || c.name);
        }
        c.ssid = ssidCache.get(c.uuid);
      }),
    );
    return wifi;
  }

  async function wifiDevices() {
    return parseDeviceStatus(await nm(['-t', '-f', 'DEVICE,TYPE,STATE,CONNECTION', 'device', 'status'])).filter((d) => d.type === 'wifi');
  }

  async function scan(rescan) {
    const fields = ['-t', '-f', 'IN-USE,SSID,BSSID,SIGNAL,SECURITY,FREQ,CHAN,RATE', 'device', 'wifi', 'list'];
    if (rescan) {
      try {
        return await nm([...fields, '--rescan', 'yes'], { timeout: 25000 });
      } catch {
        // "Scanning not allowed immediately following previous scan" etc.: use the cached results
      }
    }
    return nm([...fields, '--rescan', 'no']);
  }

  async function status() {
    const [gen, radio, devText] = await Promise.all([
      nm(['-t', '-f', 'STATE,CONNECTIVITY', 'general', 'status']),
      nm(['-t', '-f', 'WIFI-HW,WIFI,WWAN-HW,WWAN', 'radio'], { allowFail: true }).catch(() => ''),
      nm(['-t', '-f', 'DEVICE,TYPE,STATE,CONNECTION', 'device', 'status']),
    ]);
    const [state, conn] = splitTerse(lines(gen)[0] || '');
    const [wifiHw, wifi, , wwan] = splitTerse(lines(radio)[0] || '');
    const devices = parseDeviceStatus(devText);
    const wifiEnabled = wifi === 'enabled';
    const saved = loadState();
    // NetworkManager has no airplane state: it is ours (network.json), cleared when something else
    // turned every radio back on (WWAN is only switched back on when airplane mode ends).
    const airplane = !!saved.airplane && wwan !== 'enabled';
    const defIface = parseDefaultRoute(readText('/proc/net/route'));
    const connected = devices.filter((d) => /^connected/.test(d.state) && (d.type === 'wifi' || d.type === 'ethernet' || d.type === 'wwan'));
    const primDev = connected.find((d) => d.device === defIface) || connected[0] || null;
    let primary = { type: null, name: null, strength: null, device: null };
    if (primDev) {
      primary = { type: primDev.type === 'wifi' ? 'wifi' : primDev.type === 'ethernet' ? 'ethernet' : primDev.type, name: primDev.connection, strength: null, device: primDev.device };
      if (primDev.type === 'wifi') {
        const list = parseWifiList(await scan(false).catch(() => ''));
        const act = list.find((n) => n.active);
        if (act) {
          primary.name = act.ssid;
          primary.strength = act.signal;
        }
      }
    }
    return {
      connectivity: mapConnectivity(conn, state),
      wifiEnabled,
      wifiHardware: devices.some((d) => d.type === 'wifi') && wifiHw !== 'missing',
      airplane,
      primary,
      devices,
    };
  }

  async function wifiList(rescan) {
    const [text, profiles] = await Promise.all([scan(!!rescan), wifiProfiles().catch(() => [])]);
    return parseWifiList(text, new Set(profiles.map((p) => p.ssid)));
  }

  async function wifiConnect(ssid, password, opts = {}) {
    if (typeof ssid !== 'string' || !ssid || ssid.length > 32 * 4) throw err('Invalid network name', 'EINVAL');
    const before = await wifiProfiles().catch(() => []);
    const known = before.filter((p) => p.ssid === ssid);
    if (known.length && !password) {
      await nm(['-w', '45', 'connection', 'up', 'uuid', known[0].uuid], { timeout: 60000 });
      return true;
    }
    // A new key for a saved network: start from a fresh profile.
    for (const p of known) await nm(['connection', 'delete', 'uuid', p.uuid], { allowFail: true }).catch(() => {});
    const args = ['-w', '45', 'device', 'wifi', 'connect', ssid];
    // nmcli has no stdin option for the key: it is passed as an argument (visible to local users in
    // /proc for the few seconds the command runs), like every NetworkManager front-end that uses nmcli.
    if (password) args.push('password', String(password));
    if (opts.hidden) args.push('hidden', 'yes');
    const dev = (await wifiDevices().catch(() => []))[0];
    if (dev) args.push('ifname', dev.device);
    try {
      await nm(args, { timeout: 60000 });
      ssidCache.clear();
      return true;
    } catch (e) {
      // Don't leave a broken profile behind (Windows forgets a network whose key was wrong).
      const after = await wifiProfiles().catch(() => []);
      const keep = new Set(before.map((p) => p.uuid));
      for (const p of after) if (!keep.has(p.uuid) && p.ssid === ssid) await nm(['connection', 'delete', 'uuid', p.uuid], { allowFail: true }).catch(() => {});
      ssidCache.clear();
      if (!password && e.code !== 'ENOTFOUND' && /secrets|psk|password/i.test(e.message)) e.code = 'EAUTH';
      throw e;
    }
  }

  async function wifiDisconnect() {
    const devs = (await wifiDevices()).filter((d) => /^connect/.test(d.state));
    for (const d of devs) await nm(['device', 'disconnect', d.device]);
    return true;
  }

  async function wifiForget(ssid) {
    const profiles = (await wifiProfiles()).filter((p) => p.ssid === ssid);
    for (const p of profiles) await nm(['connection', 'delete', 'uuid', p.uuid]);
    ssidCache.clear();
    return profiles.length > 0;
  }

  async function setWifi(on) {
    await nm(['radio', 'wifi', on ? 'on' : 'off']);
    return true;
  }

  async function setAirplane(on) {
    const st = loadState();
    if (on) {
      const radio = await nm(['-t', '-f', 'WIFI', 'radio'], { allowFail: true }).catch(() => '');
      st.wifiBeforeAirplane = splitTerse(lines(radio)[0] || '')[0] !== 'disabled';
      st.airplane = true;
      saveState(st);
      await nm(['radio', 'all', 'off']);
      if (which('rfkill')) await run('rfkill', ['block', 'bluetooth']).catch(() => {});
    } else {
      st.airplane = false;
      saveState(st);
      await nm(['radio', 'wwan', 'on'], { allowFail: true }).catch(() => {});
      if (st.wifiBeforeAirplane !== false) await nm(['radio', 'wifi', 'on']);
      if (which('rfkill')) await run('rfkill', ['unblock', 'bluetooth']).catch(() => {});
    }
    return true;
  }

  async function details(device) {
    const devs = parseDeviceStatus(await nm(['-t', '-f', 'DEVICE,TYPE,STATE,CONNECTION', 'device', 'status']));
    const wanted = device ? devs.filter((d) => d.device === device) : devs;
    if (device && !wanted.length) throw err(`No such network device: ${device}`, 'ENOTFOUND');
    const out = [];
    for (const d of wanted) {
      const info = parseDeviceShow(await nm(['-t', 'device', 'show', d.device], { allowFail: true }).catch(() => ''));
      info.device = info.device || d.device;
      info.type = d.type;
      info.state = d.state;
      info.connection = d.connection;
      if (info.speed == null) {
        const sp = parseInt(readText(`/sys/class/net/${d.device}/speed`), 10);
        if (sp > 0) info.speed = sp;
      }
      if (d.type === 'wifi') {
        const act = parseWifiList(await scan(false).catch(() => '')).find((n) => n.active);
        if (act) Object.assign(info, { ssid: act.ssid, signal: act.signal, security: act.security, freq: act.freq, chan: act.chan, rate: act.rate });
      }
      out.push(info);
    }
    return device ? out[0] : out;
  }

  async function known() {
    return (await wifiProfiles()).map((p) => ({ ssid: p.ssid, name: p.name, uuid: p.uuid }));
  }

  return { status, wifiList, wifiConnect, wifiDisconnect, wifiForget, setWifi, setAirplane, details, known, monitorCmd: ['nmcli', ['monitor']] };
}

// ------------------------------------------------------------------ fallback without NetworkManager (read-only)
function sysfsBackend() {
  const notSupported = async () => {
    throw err('NetworkManager (nmcli) is not available', 'ENOTSUP');
  };
  function devices() {
    let names = [];
    try {
      names = fs.readdirSync('/sys/class/net').filter((n) => n !== 'lo');
    } catch {}
    return names
      .filter((n) => !fs.existsSync(`/sys/class/net/${n}/bridge`) && !/^(docker|veth|virbr|br-|tun|tap)/.test(n))
      .map((n) => {
        const up = readText(`/sys/class/net/${n}/operstate`).trim() === 'up';
        return { device: n, type: fs.existsSync(`/sys/class/net/${n}/wireless`) ? 'wifi' : 'ethernet', state: up ? 'connected' : 'disconnected', connection: null };
      });
  }
  async function status() {
    const devs = devices();
    const def = parseDefaultRoute(readText('/proc/net/route'));
    const prim = devs.find((d) => d.device === def) || null;
    return {
      connectivity: prim ? 'full' : devs.some((d) => d.state === 'connected') ? 'limited' : 'none',
      wifiEnabled: false,
      wifiHardware: false,
      airplane: false,
      primary: prim ? { type: prim.type, name: prim.device, strength: null, device: prim.device } : { type: null, name: null, strength: null, device: null },
      devices: devs,
    };
  }
  async function details(device) {
    const all = devices().map((d) => {
      const ifs = os.networkInterfaces()[d.device] || [];
      const sp = parseInt(readText(`/sys/class/net/${d.device}/speed`), 10);
      return {
        ...d,
        mac: readText(`/sys/class/net/${d.device}/address`).trim() || null,
        mtu: parseInt(readText(`/sys/class/net/${d.device}/mtu`), 10) || null,
        speed: sp > 0 ? sp : null,
        ipv4: ifs.filter((a) => a.family === 'IPv4').map((a) => a.cidr),
        ipv6: ifs.filter((a) => a.family === 'IPv6').map((a) => a.cidr),
        gateway4: null,
        gateway6: null,
        dns4: lines(readText('/etc/resolv.conf')).filter((l) => /^nameserver\s/.test(l)).map((l) => l.split(/\s+/)[1]),
        dns6: [],
      };
    });
    if (!device) return all;
    const d = all.find((x) => x.device === device);
    if (!d) throw err(`No such network device: ${device}`, 'ENOTFOUND');
    return d;
  }
  return { status, known: async () => [], wifiList: async () => [], wifiConnect: notSupported, wifiDisconnect: notSupported, wifiForget: notSupported, setWifi: notSupported, setAirplane: notSupported, details };
}

// ------------------------------------------------------------------ dev mock
function mockBackend(onChange) {
  const mode = process.env.AURORA_MOCK_NET || 'both'; // both | wifi | ethernet | none
  const st = {
    wifiEnabled: mode !== 'ethernet' && mode !== 'none',
    airplane: false,
    eth: mode === 'both' || mode === 'ethernet',
    networks: [
      { ssid: 'Aurora-Home', signal: 86, security: 'WPA2', saved: true, key: 'aurora', bssid: 'A4:3E:51:0C:22:10', freq: 5180, chan: 36, rate: '540 Mbit/s' },
      { ssid: 'Livebox-4F2A', signal: 67, security: 'WPA2', saved: false, bssid: '7C:26:64:4F:2A:01', freq: 2437, chan: 6, rate: '195 Mbit/s' },
      { ssid: 'SFR_9C3E', signal: 54, security: 'WPA3', saved: false, bssid: '00:24:D4:9C:3E:7B', freq: 5240, chan: 48, rate: '270 Mbit/s' },
      { ssid: 'FreeWifi_secure', signal: 41, security: 'WPA2 802.1X', saved: false, bssid: '68:A3:78:11:90:3C', freq: 2412, chan: 1, rate: '130 Mbit/s' },
      { ssid: 'Café du Coin', signal: 33, security: '', saved: false, bssid: 'C0:4A:00:55:21:9E', freq: 2462, chan: 11, rate: '65 Mbit/s' },
      { ssid: 'Bbox-12AB34', signal: 18, security: 'WPA1 WPA2', saved: false, bssid: '30:7C:B2:12:AB:34', freq: 2422, chan: 3, rate: '54 Mbit/s' },
    ],
    active: mode === 'none' || mode === 'ethernet' ? null : 'Aurora-Home',
  };
  const jitter = () => {
    for (const n of st.networks) n.signal = Math.max(5, Math.min(99, n.signal + Math.round((Math.random() - 0.5) * 4)));
  };
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const changed = () => setTimeout(async () => onChange(await status()), 30);
  async function status() {
    const wifiOn = st.wifiEnabled;
    const act = wifiOn && st.active ? st.networks.find((n) => n.ssid === st.active) : null;
    const devices = [
      { device: 'enp0s3', type: 'ethernet', state: st.eth ? 'connected' : 'unavailable', connection: st.eth ? 'Wired connection 1' : null },
      { device: 'wlp2s0', type: 'wifi', state: !wifiOn ? 'unavailable' : act ? 'connected' : 'disconnected', connection: act ? act.ssid : null },
    ];
    const primary = st.eth
      ? { type: 'ethernet', name: 'Wired connection 1', strength: null, device: 'enp0s3' }
      : act
        ? { type: 'wifi', name: act.ssid, strength: act.signal, device: 'wlp2s0' }
        : { type: null, name: null, strength: null, device: null };
    return { connectivity: st.eth || act ? 'full' : 'none', wifiEnabled: wifiOn, wifiHardware: true, airplane: st.airplane, primary, devices };
  }
  async function wifiList(rescan) {
    if (!st.wifiEnabled) return [];
    if (rescan) {
      await delay(900);
      jitter();
    }
    return parseWifiList(
      st.networks.map((n) => [n.ssid === st.active ? '*' : ' ', n.ssid, n.bssid, n.signal, n.security, n.freq, n.chan, n.rate].map((v) => String(v).replace(/\\/g, '\\\\').replace(/:/g, '\\:')).join(':')).join('\n'),
      new Set(st.networks.filter((n) => n.saved).map((n) => n.ssid)),
    );
  }
  async function wifiConnect(ssid, password) {
    const n = st.networks.find((x) => x.ssid === ssid);
    await delay(1200);
    if (!st.wifiEnabled) throw err('Wi-Fi is disabled', 'ENET');
    if (!n) throw err(`No network with SSID '${ssid}' found.`, 'ENOTFOUND');
    const secured = !!n.security;
    if (secured) {
      if (!password && !n.saved) throw err('Secrets were required, but not provided.', 'EAUTH');
      if (password === 'wrong' || (password && password.length < 8)) throw err('Secrets were required, but not provided.', 'EAUTH');
    }
    n.saved = true;
    st.active = ssid;
    changed();
    return true;
  }
  async function wifiDisconnect() {
    st.active = null;
    changed();
    return true;
  }
  async function wifiForget(ssid) {
    const n = st.networks.find((x) => x.ssid === ssid);
    if (n) n.saved = false;
    if (st.active === ssid) st.active = null;
    changed();
    return !!n;
  }
  async function setWifi(on) {
    st.wifiEnabled = !!on;
    changed();
    return true;
  }
  async function setAirplane(on) {
    st.airplane = !!on;
    if (on) {
      st.wifiBefore = st.wifiEnabled;
      st.wifiEnabled = false;
    } else st.wifiEnabled = st.wifiBefore !== false;
    changed();
    return true;
  }
  async function details(device) {
    const s = await status();
    const act = st.wifiEnabled && st.active ? st.networks.find((n) => n.ssid === st.active) : null;
    const all = [
      {
        device: 'enp0s3',
        type: 'ethernet',
        state: s.devices[0].state,
        connection: s.devices[0].connection,
        mac: '52:54:00:12:34:56',
        mtu: 1500,
        speed: 1000,
        carrier: st.eth,
        ipv4: st.eth ? ['10.0.2.15/24'] : [],
        gateway4: st.eth ? '10.0.2.2' : null,
        dns4: st.eth ? ['10.0.2.3'] : [],
        ipv6: st.eth ? ['fec0::5054:ff:fe12:3456/64', 'fe80::5054:ff:fe12:3456/64'] : [],
        gateway6: st.eth ? 'fe80::2' : null,
        dns6: [],
        domains: [],
      },
      {
        device: 'wlp2s0',
        type: 'wifi',
        state: s.devices[1].state,
        connection: s.devices[1].connection,
        mac: '3C:6A:A7:1E:90:4D',
        mtu: 1500,
        speed: null,
        ipv4: act ? ['192.168.1.42/24'] : [],
        gateway4: act ? '192.168.1.1' : null,
        dns4: act ? ['192.168.1.1', '9.9.9.9'] : [],
        ipv6: act ? ['2a01:cb00:8d2:4f00:3e6a:a7ff:fe1e:904d/64'] : [],
        gateway6: act ? 'fe80::7e26:64ff:fe4f:2a01' : null,
        dns6: [],
        domains: act ? ['home'] : [],
        ...(act ? { ssid: act.ssid, signal: act.signal, security: act.security, freq: act.freq, chan: act.chan, rate: act.rate } : {}),
      },
    ];
    if (!device) return all;
    const d = all.find((x) => x.device === device);
    if (!d) throw err(`No such network device: ${device}`, 'ENOTFOUND');
    return d;
  }
  const extraKnown = [{ ssid: 'Hotel-Lumiere-Guest', name: 'Hotel-Lumiere-Guest', uuid: '6b1e3c1a-5f0e-4c1b-9d3e-2a7f0c9e8b11' }];
  async function known() {
    return [...st.networks.filter((n) => n.saved).map((n, i) => ({ ssid: n.ssid, name: n.ssid, uuid: `0a9c7e52-1d4b-4f7a-8c3e-${String(i).padStart(12, '0')}` })), ...extraKnown];
  }
  const forget0 = wifiForget;
  async function forgetAny(ssid) {
    const i = extraKnown.findIndex((k) => k.ssid === ssid);
    if (i >= 0) {
      extraKnown.splice(i, 1);
      return true;
    }
    return forget0(ssid);
  }
  return { status, wifiList, wifiConnect, wifiDisconnect, wifiForget: forgetAny, setWifi, setAirplane, details, known, mock: true };
}

// ------------------------------------------------------------------ registration
function register(api) {
  const hasNm = !!which('nmcli');
  const useMock = api.DEV && process.env.AURORA_REAL_BACKENDS !== '1'; // dev: simulated network (never touch the developer's)
  let lastJson = '';
  const push = (st) => {
    const j = JSON.stringify(st);
    if (j === lastJson) return;
    lastJson = j;
    api.broadcast('net:changed', st);
  };
  const be = useMock ? mockBackend(push) : hasNm ? nmBackend() : sysfsBackend();

  api.handle('net:status', async () => {
    const st = await be.status();
    lastJson = JSON.stringify(st);
    return st;
  });
  api.handle('net:wifiList', (rescan) => be.wifiList(!!rescan));
  api.handle('net:wifiConnect', async (ssid, password, opts) => {
    await be.wifiConnect(String(ssid ?? ''), password ? String(password) : undefined, opts || {});
    refreshSoon();
    return true;
  });
  api.handle('net:wifiDisconnect', async () => {
    await be.wifiDisconnect();
    refreshSoon();
    return true;
  });
  api.handle('net:wifiForget', async (ssid) => {
    const r = await be.wifiForget(String(ssid ?? ''));
    refreshSoon();
    return r;
  });
  api.handle('net:setWifi', async (on) => {
    await be.setWifi(!!on);
    refreshSoon();
    return true;
  });
  api.handle('net:setAirplane', async (on) => {
    await be.setAirplane(!!on);
    refreshSoon();
    return true;
  });
  api.handle('net:details', (device) => be.details(device ? String(device) : undefined));
  api.handle('net:known', () => be.known());
  api.handle('net:usage', async () => {
    const st = await be.status().catch(() => ({ devices: [] }));
    const typeOf = new Map((st.devices || []).map((d) => [d.device, d.type]));
    if (be.mock) {
      const up = os.uptime();
      return [
        { iface: 'enp0s3', type: 'ethernet', rx: Math.round(up * 41234 + 734003200), tx: Math.round(up * 5120 + 52428800) },
        { iface: 'wlp2s0', type: 'wifi', rx: Math.round(up * 9000 + 157286400), tx: Math.round(up * 1800 + 20971520) },
      ];
    }
    return parseProcNetDev(readText('/proc/net/dev'))
      .filter((d) => typeOf.has(d.iface) || !/^(docker|veth|virbr|br-|tun|tap)/.test(d.iface))
      .map((d) => ({ ...d, type: typeOf.get(d.iface) || (fs.existsSync(`/sys/class/net/${d.iface}/wireless`) ? 'wifi' : 'ethernet') }));
  });

  // Push status changes: "nmcli monitor" prints a line for every NetworkManager event.
  let timer = null;
  function refreshSoon(ms = 400) {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        push(await be.status());
      } catch {}
    }, ms);
  }
  if (!useMock && hasNm && be.monitorCmd) {
    let child = null;
    let restarts = 0;
    const start = () => {
      try {
        child = spawn(which('nmcli'), ['monitor'], { stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, LC_ALL: 'C' } });
      } catch {
        return;
      }
      child.stdout.on('data', () => refreshSoon());
      child.on('exit', () => {
        child = null;
        if (restarts++ < 20) setTimeout(start, Math.min(30000, 1000 * restarts));
      });
    };
    start();
    process.on('exit', () => child?.kill());
  }
}

module.exports = register;
module.exports.parsers = parsers;
