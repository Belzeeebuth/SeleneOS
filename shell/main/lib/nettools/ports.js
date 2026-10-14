'use strict';
// Port helpers for main/ipc/nettools.js: TCP connect test (Node net, no tool, no root) and the listening sockets
// of this computer (`ss -H -tulpn` as the user: other accounts' process names are hidden by the kernel).
const net = require('net');
const dns = require('dns');

// Well-known services, for labels (the UI's « Services courants » menu has its own list of ports).
const SERVICES = {
  20: 'FTP-DATA', 21: 'FTP', 22: 'SSH', 23: 'Telnet', 25: 'SMTP', 53: 'DNS', 67: 'DHCP', 68: 'DHCP', 80: 'HTTP', 110: 'POP3',
  123: 'NTP', 137: 'NetBIOS', 138: 'NetBIOS', 139: 'SMB', 143: 'IMAP', 161: 'SNMP', 389: 'LDAP', 443: 'HTTPS', 445: 'SMB',
  465: 'SMTPS', 546: 'DHCPv6', 547: 'DHCPv6', 587: 'SMTP', 631: 'IPP', 993: 'IMAPS', 995: 'POP3S', 1194: 'OpenVPN', 1883: 'MQTT',
  3306: 'MySQL', 3389: 'RDP', 5353: 'mDNS', 5355: 'LLMNR', 5432: 'PostgreSQL', 5900: 'VNC', 5901: 'VNC', 6379: 'Redis',
  8080: 'HTTP', 8443: 'HTTPS', 9100: 'JetDirect', 25565: 'Minecraft', 27017: 'MongoDB', 32400: 'Plex', 51820: 'WireGuard',
};

/** "22, 80,443 8000-8003" -> [22, 80, 443, 8000, 8001, 8002, 8003] (null when invalid or more than `max`). */
function parsePorts(input, max = 64) {
  const out = [];
  const seen = new Set();
  const parts = String(input ?? '')
    .split(/[\s,;]+/)
    .filter(Boolean);
  if (!parts.length) return null;
  for (const p of parts) {
    const m = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(p);
    if (!m) return null;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b > 65535 || b < a || b - a > max) return null;
    for (let x = a; x <= b; x++) {
      if (seen.has(x)) continue;
      seen.add(x);
      out.push(x);
      if (out.length > max) return null;
    }
  }
  return out;
}

/** Resolve a host name once (getaddrinfo, like ping and the browser). -> { ip, family } ; throws with e.code. */
async function resolveHost(host, kind, family = 0) {
  if (kind === 'ipv4') return { ip: host, family: 4 };
  if (kind === 'ipv6') return { ip: host, family: 6 };
  const res = await dns.promises.lookup(host, { family, all: true });
  if (!res.length) throw Object.assign(new Error(`${host}: no address`), { code: 'ENOTFOUND' });
  return { ip: res[0].address, family: res[0].family };
}

/**
 * One TCP connect test -> { port, status: 'open'|'closed'|'filtered'|'unreachable'|'error', ms, code }.
 * open = the connection was accepted; closed = refused (RST: nothing listens); filtered = no answer before the
 * timeout (a firewall drops the packets); unreachable = no route to the host / network.
 */
function checkPort(ip, port, timeoutMs, signal) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const ms = () => Math.round(Number(process.hrtime.bigint() - t0) / 1e4) / 100;
    let done = false;
    const sock = net.connect({ host: ip, port });
    const finish = (status, code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      sock.destroy();
      resolve({ port, status, ms: status === 'open' ? ms() : null, code: code || null });
    };
    const onAbort = () => finish('cancelled', 'ECANCELED');
    const timer = setTimeout(() => finish('filtered', 'ETIMEDOUT'), timeoutMs);
    signal?.addEventListener?.('abort', onAbort);
    sock.once('connect', () => finish('open'));
    sock.once('error', (e) => {
      const c = e.code || '';
      if (c === 'ECONNREFUSED') finish('closed', c);
      else if (c === 'ETIMEDOUT') finish('filtered', c);
      else if (c === 'EHOSTUNREACH' || c === 'ENETUNREACH' || c === 'EADDRNOTAVAIL' || c === 'EHOSTDOWN') finish('unreachable', c);
      else finish('error', c || 'EFAIL');
    });
  });
}

/** Run checkPort over many ports, `concurrency` at a time, in the input order. */
async function checkPorts(ip, ports, timeoutMs, { concurrency = 8, signal, onResult } = {}) {
  const results = new Array(ports.length);
  let next = 0;
  async function worker() {
    while (next < ports.length) {
      const i = next++;
      if (signal?.aborted) {
        results[i] = { port: ports[i], status: 'cancelled', ms: null, code: 'ECANCELED' };
        continue;
      }
      results[i] = await checkPort(ip, ports[i], timeoutMs, signal);
      onResult?.(results[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, ports.length) }, worker));
  return results;
}

/** "127.0.0.53%lo:53" / "[::]:22" / "*:5353" / "[fe80::1%eth0]:546" -> { addr, iface, port } */
function splitAddrPort(s) {
  const str = String(s || '');
  const i = str.lastIndexOf(':');
  if (i < 0) return null;
  let addr = str.slice(0, i);
  const port = str.slice(i + 1);
  if (addr.startsWith('[') && addr.endsWith(']')) addr = addr.slice(1, -1);
  let iface = '';
  const pct = addr.indexOf('%');
  if (pct >= 0) {
    iface = addr.slice(pct + 1);
    addr = addr.slice(0, pct);
  }
  return { addr, iface, port: /^\d+$/.test(port) ? Number(port) : null };
}

/** Who can reach a listening address: 'local' (this computer only), 'all' (every interface) or 'address'. */
function scopeOf(addr, iface) {
  if (iface === 'lo') return 'local';
  if (/^127\./.test(addr) || addr === '::1' || /^::ffff:127\./i.test(addr)) return 'local';
  if (addr === '*' || addr === '0.0.0.0' || addr === '::' || addr === '') return 'all';
  return 'address';
}

/**
 * `ss -H -tulpn` -> { items: [{ proto, addr, iface, port, scope, service, processes: [{ name, pid }] }], hidden }
 * hidden: number of sockets whose process isn't shown (owned by the system or another account).
 */
function parseSs(text) {
  const items = [];
  const seen = new Set();
  let hidden = 0;
  for (const line of String(text || '').split('\n')) {
    const t = line.trim();
    if (!t || /^Netid\b/.test(t)) continue;
    const cols = t.split(/\s+/);
    if (cols.length < 5) continue;
    const proto = cols[0].toLowerCase();
    if (proto !== 'tcp' && proto !== 'udp') continue;
    const state = cols[1];
    if (proto === 'tcp' && state !== 'LISTEN') continue;
    const local = splitAddrPort(cols[4]);
    if (!local || local.port == null) continue;
    const rest = cols.slice(6).join(' ');
    const processes = [];
    const re = /\("([^"]*)",pid=(\d+)/g;
    let m;
    while ((m = re.exec(rest))) if (!processes.some((p) => p.name === m[1] && p.pid === Number(m[2]))) processes.push({ name: m[1], pid: Number(m[2]) });
    const key = `${proto}|${local.addr}|${local.iface}|${local.port}`;
    if (seen.has(key)) continue; // SO_REUSEPORT duplicates (two avahi sockets on 5353…)
    seen.add(key);
    if (!processes.length) hidden++;
    items.push({ proto, addr: local.addr === '*' ? '' : local.addr, iface: local.iface, port: local.port, scope: scopeOf(local.addr, local.iface), service: SERVICES[local.port] || '', processes });
  }
  items.sort((a, b) => a.port - b.port || a.proto.localeCompare(b.proto) || a.addr.localeCompare(b.addr));
  return { items, hidden };
}

const MOCK_SS = [
  'udp   UNCONN 0      0          127.0.0.53%lo:53         0.0.0.0:*',
  'udp   UNCONN 0      0                0.0.0.0:5353       0.0.0.0:*',
  'udp   UNCONN 0      0                   [::]:5353          [::]:*',
  'tcp   LISTEN 0      4096       127.0.0.53%lo:53         0.0.0.0:*',
  'tcp   LISTEN 0      128              0.0.0.0:22         0.0.0.0:*',
  'tcp   LISTEN 0      128                 [::]:22            [::]:*',
  'tcp   LISTEN 0      4096           127.0.0.1:631        0.0.0.0:*',
  'tcp   LISTEN 0      511            127.0.0.1:5173       0.0.0.0:*    users:(("node",pid=4242,fd=21))',
  'tcp   LISTEN 0      10             0.0.0.0:8000       0.0.0.0:*    users:(("python3",pid=5150,fd=3))',
].join('\n');

module.exports = { SERVICES, parsePorts, resolveHost, checkPort, checkPorts, splitAddrPort, scopeOf, parseSs, MOCK_SS };
