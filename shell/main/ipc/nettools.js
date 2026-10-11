'use strict';
// Network tools app backend (apps/nettools): VPN connections (NetworkManager), ping and DNS lookup.
// No root, never a shell: commands run through execFile/spawn with fixed argument lists, and every host goes
// through validHost() (hostname, IPv4 or IPv6 only). Mock data in dev/tests (api.DEV unless AURORA_REAL_BACKENDS=1).
//
// Channels:
//   nettools:vpnList () -> { available, mock, items: [{ uuid, name, type: 'vpn'|'wireguard', device, active }] }
//        available: false when nmcli is missing (items is then []).
//   nettools:vpnUp (uuid) / nettools:vpnDown (uuid) -> { ok: true }      (nmcli connection up|down uuid <uuid>)
//   nettools:vpnImport (path) -> { name }   imports a WireGuard .conf (nmcli connection import type wireguard file <path>)
//   nettools:vpnDelete (uuid) -> { ok: true }
//   nettools:ping (host) -> { id }   runs ping -c 4; streams (+nettools:ping) { id, line } then { id, done: true, code, cancelled }
//        to the asking window only.
//   nettools:pingCancel (id) -> { ok }
//   nettools:dns (host, type) -> { host, type, records: [string] }   type: A AAAA MX TXT NS CNAME (node dns, 5 s timeout)
// Errors: EINVAL (bad host / uuid / path / type), ENOTFOUND / ENODATA / ETIMEOUT (DNS), ECMD (nmcli failed, message = its stderr).
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { run } = require('../lib/exec');

const DNS_TYPES = ['A', 'AAAA', 'MX', 'TXT', 'NS', 'CNAME'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------- pure helpers (unit-tested)
/** 'hostname' | 'ipv4' | 'ipv6' | null. Strict: no ports, no zone ids, no leading dash, no trailing dot. */
function hostKind(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (!s || s.length > 253) return null;
  if (net.isIPv4(s)) return 'ipv4';
  if (/^[0-9a-fA-F:.]+$/.test(s) && s.includes(':') && net.isIPv6(s)) return 'ipv6';
  if (/^[\d.]+$/.test(s)) return null; // looks like a broken IPv4
  const labels = s.split('.');
  if (!labels.every((l) => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(l))) return null;
  return 'hostname';
}
const validHost = (s) => hostKind(s) !== null;

/** Split one nmcli -t line on unescaped ':' and unescape '\:' and '\\'. */
function splitTerse(line) {
  const out = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && i + 1 < line.length) cur += line[++i];
    else if (c === ':') out.push(cur), (cur = '');
    else cur += c;
  }
  out.push(cur);
  return out;
}

/** `nmcli -t -f NAME,UUID,TYPE,DEVICE,ACTIVE connection show` -> VPN + WireGuard items. */
function parseConnections(text) {
  const items = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    const [name, uuid, type, device, active] = splitTerse(line);
    if (!UUID_RE.test(uuid || '')) continue;
    if (type !== 'vpn' && type !== 'wireguard') continue;
    items.push({ uuid, name: name || uuid, type, device: device && device !== '--' ? device : '', active: active === 'yes' });
  }
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

function err(message, code) {
  const e = new Error(message);
  e.code = code;
  e.quiet = true;
  return e;
}

function checkUuid(uuid) {
  if (typeof uuid !== 'string' || !UUID_RE.test(uuid)) throw err('Invalid connection id', 'EINVAL');
  return uuid;
}

function checkConfPath(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p) || !/\.conf$/i.test(p) || p.includes('\0')) throw err('Choose a WireGuard .conf file', 'EINVAL');
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    throw err('File not found', 'ENOENT');
  }
  if (!st.isFile() || st.size > 64 * 1024) throw err('Choose a WireGuard .conf file', 'EINVAL');
  return p;
}

/** DNS answer -> printable strings. */
function formatRecords(type, res) {
  const list = Array.isArray(res) ? res : [];
  switch (type) {
    case 'MX':
      return list.sort((a, b) => a.priority - b.priority).map((r) => `${r.priority} ${r.exchange}`);
    case 'TXT':
      return list.map((r) => (Array.isArray(r) ? r.join('') : String(r)));
    default:
      return list.map(String);
  }
}

// ---------------------------------------------------------------- mocks (dev/tests: no NetworkManager, no internet)
function mockState() {
  return {
    conns: [
      { uuid: '5b1e0c4a-1f7e-4c3b-9a43-0d2a6c1e8f01', name: 'Home WireGuard', type: 'wireguard', device: 'wg-home', active: true },
      { uuid: '9d3f2b77-6a10-4e8d-b2c5-71f0a9e4d302', name: 'Office VPN', type: 'vpn', device: '', active: false },
    ],
    seq: 3,
  };
}
const MOCK_DNS = {
  A: ['93.184.215.14'],
  AAAA: ['2606:2800:21f:cb07:6820:80da:af6b:8b2c'],
  MX: ['0 .'],
  TXT: ['v=spf1 -all', '_k2n1y4vw3qtb4skdx9e7dxt97qrmmq9'],
  NS: ['a.iana-servers.net', 'b.iana-servers.net'],
  CNAME: [],
};
function mockDns(host, type) {
  const h = host.toLowerCase();
  if (h.endsWith('.invalid') || h === 'nonexistent.test') throw err(`${host}: domain not found`, 'ENOTFOUND');
  if (h.startsWith('www.') && type === 'CNAME') return [h.slice(4)];
  const recs = MOCK_DNS[type] || [];
  if (!recs.length) throw err(`${host}: no ${type} records`, 'ENODATA');
  return recs.slice();
}
function mockPingLines(host, kind) {
  const ip = kind === 'hostname' ? '93.184.215.14' : host;
  if (host.toLowerCase().endsWith('.invalid')) return { lines: [`ping: ${host}: Name or service not known`], code: 2 };
  if (host === '192.0.2.1' || host.toLowerCase() === 'unreachable.test') {
    return {
      lines: [`PING ${host} (${ip}) 56(84) bytes of data.`, '', `--- ${host} ping statistics ---`, '4 packets transmitted, 0 received, 100% packet loss, time 3060ms'],
      code: 1,
    };
  }
  const times = [12.4, 11.8, 13.1, 12.0];
  return {
    lines: [
      `PING ${host} (${ip}) 56(84) bytes of data.`,
      ...times.map((t, i) => `64 bytes from ${ip}: icmp_seq=${i + 1} ttl=56 time=${t} ms`),
      '',
      `--- ${host} ping statistics ---`,
      '4 packets transmitted, 4 received, 0% packet loss, time 3004ms',
      'rtt min/avg/max/mdev = 11.800/12.325/13.100/0.495 ms',
    ],
    code: 0,
  };
}

// ---------------------------------------------------------------- module
function register(api) {
  const MOCK = !!api.DEV && process.env.AURORA_REAL_BACKENDS !== '1';
  const mock = mockState();
  const pings = new Map(); // id -> { cancel() }
  let pingSeq = 0;

  async function nmcli(args) {
    const res = await run('nmcli', args, { timeout: 30000 });
    if (res.code !== 0) throw err((res.stderr || res.stdout || 'nmcli failed').trim().replace(/^Error:\s*/, '').slice(0, 300), 'ECMD');
    return res.stdout;
  }

  api.handle('nettools:vpnList', async () => {
    if (MOCK) return { available: true, mock: true, items: mock.conns.map((c) => ({ ...c })).sort((a, b) => a.name.localeCompare(b.name)) };
    try {
      const out = await nmcli(['-t', '-f', 'NAME,UUID,TYPE,DEVICE,ACTIVE', 'connection', 'show']);
      return { available: true, mock: false, items: parseConnections(out) };
    } catch (e) {
      if (e.code === 'ENOENT') return { available: false, mock: false, items: [] };
      throw e;
    }
  });

  async function setActive(uuid, up) {
    checkUuid(uuid);
    if (MOCK) {
      const c = mock.conns.find((x) => x.uuid === uuid);
      if (!c) throw err('Unknown connection', 'ENOENT');
      await new Promise((r) => setTimeout(r, 250));
      c.active = up;
      c.device = up ? (c.type === 'wireguard' ? c.name.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 12) || 'wg0' : 'tun0') : '';
      return { ok: true };
    }
    await nmcli(['--wait', '25', 'connection', up ? 'up' : 'down', 'uuid', uuid]); // nmcli times out before run()'s 30 s kill
    return { ok: true };
  }
  api.handle('nettools:vpnUp', (uuid) => setActive(uuid, true));
  api.handle('nettools:vpnDown', (uuid) => setActive(uuid, false));

  api.handle('nettools:vpnImport', async (file) => {
    const p = checkConfPath(file);
    const name = path.basename(p).replace(/\.conf$/i, '');
    if (MOCK) {
      if (!/^[a-zA-Z0-9_=+.-]{1,15}$/.test(name)) throw err('The file name must be a valid interface name (up to 15 letters, digits, - or _)', 'ECMD');
      if (mock.conns.some((c) => c.name === name)) throw err(`A connection named ${name} already exists`, 'ECMD');
      const n = String(mock.seq++).padStart(12, '0');
      mock.conns.push({ uuid: `00000000-0000-4000-8000-${n}`, name, type: 'wireguard', device: '', active: false });
      return { name };
    }
    await nmcli(['connection', 'import', 'type', 'wireguard', 'file', p]);
    return { name };
  });

  api.handle('nettools:vpnDelete', async (uuid) => {
    checkUuid(uuid);
    if (MOCK) {
      const i = mock.conns.findIndex((x) => x.uuid === uuid);
      if (i < 0) throw err('Unknown connection', 'ENOENT');
      mock.conns.splice(i, 1);
      return { ok: true };
    }
    await nmcli(['connection', 'delete', 'uuid', uuid]);
    return { ok: true };
  });

  api.handle('nettools:ping', async (...args) => {
    const event = args[args.length - 1];
    const host = typeof args[0] === 'string' ? args[0].trim() : '';
    const kind = hostKind(host);
    if (!kind) throw err('Enter a host name, IPv4 or IPv6 address', 'EINVAL');
    const sender = event?.sender;
    const id = ++pingSeq;
    const emit = (payload) => api.sendTo(sender, 'nettools:ping', { id, ...payload });
    let finished = false;
    const finish = (code, cancelled) => {
      if (finished) return;
      finished = true;
      pings.delete(id);
      emit({ done: true, code, cancelled: !!cancelled });
    };
    if (MOCK) {
      const { lines, code } = mockPingLines(host, kind);
      const step = Math.max(10, Number(process.env.AURORA_NETTOOLS_PING_MS) || 250);
      const timers = lines.map((line, i) => setTimeout(() => emit({ line }), step * (i + 1)));
      timers.push(setTimeout(() => finish(code, false), step * (lines.length + 1)));
      pings.set(id, { cancel: () => (timers.forEach(clearTimeout), finish(130, true)) });
      return { id, mock: true };
    }
    let child;
    try {
      child = spawn('ping', ['-c', '4', '-W', '3', host], { env: { ...process.env, LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      throw err(`ping: ${e.message}`, 'ENOENT');
    }
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        emit({ line: buf.slice(0, nl).slice(0, 500) });
        buf = buf.slice(nl + 1);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    let cancelled = false;
    const killer = setTimeout(() => child.kill('SIGKILL'), 30000);
    child.on('error', (e) => {
      clearTimeout(killer);
      emit({ line: e.code === 'ENOENT' ? 'ping: command not found' : `ping: ${e.message}` });
      finish(127, false);
    });
    child.on('close', (code) => {
      clearTimeout(killer);
      if (buf) emit({ line: buf.slice(0, 500) });
      finish(code ?? 1, cancelled);
    });
    pings.set(id, { cancel: () => ((cancelled = true), child.kill('SIGINT')) });
    return { id, mock: false };
  });

  api.handle('nettools:pingCancel', (id) => {
    const p = pings.get(Number(id));
    if (!p) return { ok: false };
    p.cancel();
    return { ok: true };
  });

  api.handle('nettools:dns', async (hostIn, typeIn) => {
    const host = typeof hostIn === 'string' ? hostIn.trim() : '';
    const type = String(typeIn || 'A').toUpperCase();
    if (hostKind(host) !== 'hostname') throw err('Enter a domain name', 'EINVAL');
    if (!DNS_TYPES.includes(type)) throw err('Unsupported record type', 'EINVAL');
    if (MOCK) {
      await new Promise((r) => setTimeout(r, 120));
      return { host, type, records: mockDns(host, type), mock: true };
    }
    const { Resolver } = require('dns').promises;
    const r = new Resolver({ timeout: 5000, tries: 2 });
    const fn = { A: 'resolve4', AAAA: 'resolve6', MX: 'resolveMx', TXT: 'resolveTxt', NS: 'resolveNs', CNAME: 'resolveCname' }[type];
    try {
      return { host, type, records: formatRecords(type, await r[fn](host)), mock: false };
    } catch (e) {
      const code = e.code === 'ENOTFOUND' || e.code === 'ENODATA' || e.code === 'ETIMEOUT' ? e.code : 'EDNS';
      throw err(`${host}: ${e.code || e.message}`, code);
    }
  });
}

module.exports = register;
module.exports.hostKind = hostKind;
module.exports.validHost = validHost;
module.exports.splitTerse = splitTerse;
module.exports.parseConnections = parseConnections;
module.exports.formatRecords = formatRecords;
module.exports.DNS_TYPES = DNS_TYPES;
