'use strict';
// Network tools app backend (apps/nettools): VPN connections (NetworkManager: WireGuard, OpenVPN), ping, traceroute,
// DNS lookup, port checks, listening sockets and a speed test.
// No root, never a shell: commands run through execFile/spawn with fixed argument lists, and every host goes
// through validHost() (hostname, IPv4 or IPv6 only). Mock data in dev/tests (api.DEV unless AURORA_REAL_BACKENDS=1).
//
// Channels:
//   nettools:vpnList () -> { available, mock, items: [{ uuid, name, type: 'vpn'|'wireguard', service, device, active }] }
//        available: false when nmcli is missing (items is then []). service: 'openvpn', 'wireguard', other VPN plugin
//        names ('' when unknown).
//   nettools:vpnInfo (uuid) -> { service, remote, username, auth, needsPassword, passwordSaved, keyPass: 'none'|'saved'|'ask' }
//   nettools:vpnUp (uuid) / nettools:vpnDown (uuid) -> { ok: true }      (nmcli connection up|down uuid <uuid>)
//   nettools:vpnImport (path) -> { name }   imports a WireGuard .conf (nmcli connection import type wireguard file <path>)
//   nettools:vpnDelete (uuid) -> { ok: true }
//   nettools:ping (host) -> { id }   runs ping -c 4; streams (+nettools:ping) { id, line } then { id, done: true, code, cancelled }
//        to the asking window only.
//   nettools:pingCancel (id) -> { ok }
//   nettools:dns (host, type) -> { host, type, records: [string] }   type: A AAAA MX TXT NS CNAME (node dns, 5 s timeout)
//   nettools:vpnUp (uuid, { username?, password?, keyPassword?, remember? }?) — secrets never go on a command line:
//        remember false: nmcli passwd-file (0600 file in a 0700 folder of $XDG_RUNTIME_DIR, deleted as soon as nmcli
//        exits), flags 2 (« ask every time »); remember true: flags 0 and `nmcli connection edit` with the
//        `set vpn.secrets …` / `save` commands on its stdin, so NetworkManager keeps the secret (root-only keyfile).
//        The user name is not a secret: `nmcli connection modify uuid U +vpn.data username=…`.
//   nettools:vpnImport (path) also takes an OpenVPN .ovpn: the profile and the files it references are copied to
//        ~/.local/share/aurora/nettools/openvpn/<name>-<hex>/ (0700) then `nmcli connection import type openvpn file …`
//        -> { name, uuid, type: 'openvpn', needsAuth, needsKeyPass }.
//   nettools:trace (host, { maxHops 1-64, family 'auto'|'4'|'6' }) -> { id, tool }; streams (+nettools:trace)
//        { id, hop: { n, host, ip, ms: [], timeouts, reached } } then { id, done, code, cancelled, reached, error }.
//   nettools:traceCancel (id)
//   nettools:portCheck (host, ports: [n] | "22,80,8000-8010", { timeout ms }) -> { host, ip, family,
//        results: [{ port, status: 'open'|'closed'|'filtered'|'unreachable'|'error', ms, code, service }] }  (Node net)
//   nettools:listening () -> { items: [{ proto, addr, iface, port, scope: 'local'|'all'|'address', service,
//        processes: [{ name, pid }] }], hidden }   (ss -H -tulpn as the user: other accounts' processes hidden)
//   nettools:speed () -> { id, host }; streams (+nettools:speed) { id, phase: 'latency'|'download'|'upload', progress 0-1,
//        mbps?, ping?, jitter? } then { id, done, result?: { download, upload, ping, jitter, server, ip, bytes, at },
//        error?, code?, cancelled }. Cloudflare's __down / __up endpoints (AURORA_NETTOOLS_SPEED_URL overrides the base
//        URL, AURORA_NETTOOLS_SPEED_MAX the largest request in bytes). One test at a time (EBUSY).
//   nettools:speedCancel (id)
// Dev/tests: mock unless AURORA_REAL_BACKENDS=1 or AURORA_NETTOOLS_REAL=1 (port checks and the speed test are always
// real; the speed test goes to AURORA_NETTOOLS_SPEED_URL in tests).
// Errors: EINVAL (bad host / uuid / path / type), ENOTFOUND / ENODATA / ETIMEOUT (DNS), ECMD (nmcli failed, message = its stderr),
//   ENOPLUGIN (NetworkManager-openvpn missing), EBADFILE (profile refused), EMISSING (referenced files missing or
//   unreadable: message lists them), EBADREF (a referenced file is not a regular file or too large), ENEEDAUTH
//   (secrets needed), EAUTH (secrets refused).
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const os = require('os');
const { run, which } = require('../lib/exec');
const ovpn = require('../lib/nettools/openvpn');
const tr = require('../lib/nettools/trace');
const ports = require('../lib/nettools/ports');
const speed = require('../lib/nettools/speed');

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

function checkOvpnPath(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p) || !/\.ovpn$/i.test(p) || p.includes('\0')) throw err('Choose an OpenVPN .ovpn file', 'EINVAL');
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    throw err('File not found', 'ENOENT');
  }
  if (!st.isFile() || st.size > ovpn.MAX_OVPN) throw err('Choose an OpenVPN .ovpn file', 'EINVAL');
  return p;
}
// Regular files only: a FIFO or device named by `key` must never block the main process.
const readSmall = (p) => {
  try {
    const st = fs.statSync(p);
    return st.isFile() && st.size <= 1024 * 1024 ? fs.readFileSync(p, 'utf8') : null;
  } catch {
    return null;
  }
};
/** .ovpn -> parsed info + missing referenced files (EBADFILE / EMISSING errors). */
function inspectOvpn(p) {
  const info = ovpn.parseOvpn(fs.readFileSync(p, 'utf8'), path.dirname(p), readSmall);
  if (!info.ok) throw err(`Not a usable OpenVPN client profile (${info.problem})`, 'EBADFILE');
  const missing = info.files.filter((f) => !f.optional && !fs.existsSync(f.path)).map((f) => f.arg);
  if (missing.length) throw err(missing.join(', '), 'EMISSING');
  return info;
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
      { uuid: '9d3f2b77-6a10-4e8d-b2c5-71f0a9e4d302', name: 'Office VPN', type: 'vpn', service: 'openvpn', device: '', active: false, remote: 'vpn.example.org' },
    ],
    seq: 3,
  };
}
const publicConn = (c) => ({ uuid: c.uuid, name: c.name, type: c.type, service: c.service || (c.type === 'wireguard' ? 'wireguard' : ''), device: c.device, active: c.active });
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
  const MOCK = !!api.DEV && process.env.AURORA_REAL_BACKENDS !== '1' && process.env.AURORA_NETTOOLS_REAL !== '1';
  const mock = mockState();
  const pings = new Map(); // id -> { cancel() }
  let pingSeq = 0;

  async function nmcli(args, timeout = 30000) {
    const res = await run('nmcli', args, { timeout });
    if (res.code !== 0) {
      const lines = (res.stderr || res.stdout || 'nmcli failed').trim().split('\n').filter((l) => !/^Hint:|^Warning:/.test(l));
      const msg = (lines.find((l) => /^Error:/.test(l)) || lines[0] || 'nmcli failed').replace(/^Error:\s*/, '').slice(0, 300);
      throw err(msg, ovpn.classifyNmError(msg));
    }
    return res.stdout;
  }

  api.handle('nettools:vpnList', async () => {
    if (MOCK) return { available: true, mock: true, items: mock.conns.map(publicConn).sort((a, b) => a.name.localeCompare(b.name)) };
    try {
      const out = await nmcli(['-t', '-f', 'NAME,UUID,TYPE,DEVICE,ACTIVE', 'connection', 'show']);
      const items = parseConnections(out);
      // VPN plugin name (OpenVPN, …) for the badge: one small nmcli call per VPN connection (at most 24).
      await Promise.all(
        items
          .filter((c) => c.type === 'vpn')
          .slice(0, 24)
          .map(async (c) => {
            try {
              c.service = (await vpnDetails(c.uuid)).service;
            } catch {
              c.service = '';
            }
          }),
      );
      for (const c of items) if (c.service == null) c.service = c.type === 'wireguard' ? 'wireguard' : '';
      return { available: true, mock: false, items };
    } catch (e) {
      if (e.code === 'ENOENT') return { available: false, mock: false, items: [] };
      throw e;
    }
  });

  async function vpnDetails(uuid) {
    const out = await nmcli(['-e', 'no', '-t', '-f', 'vpn.service-type,vpn.data', 'connection', 'show', 'uuid', uuid]);
    return ovpn.parseVpnDetails(out);
  }

  api.handle('nettools:vpnInfo', async (uuid) => {
    checkUuid(uuid);
    if (MOCK) {
      const m = mock.conns.find((x) => x.uuid === uuid);
      if (!m) throw err('Unknown connection', 'ENOENT');
      const pass = m.type === 'vpn' && !!m.needsAuth;
      return { service: publicConn(m).service, remote: m.remote || '', username: m.username || '', auth: pass ? 'password' : m.type === 'vpn' ? 'tls' : '', needsPassword: pass && !m.saved, passwordSaved: pass && !!m.saved, keyPass: m.needsKeyPass ? 'ask' : 'none' };
    }
    const d = await vpnDetails(uuid);
    return { service: d.service, remote: d.remote, username: d.username, auth: d.auth, needsPassword: d.needsPassword, passwordSaved: d.passwordSaved, keyPass: d.keyPass };
  });

  // creds (OpenVPN): { username?, password?, keyPassword?, remember? } -> username stored with nmcli modify (not a
  // secret). Secrets: remember -> flags 0 + `nmcli connection edit` reading `set vpn.secrets …` / `save` on stdin
  // (NetworkManager keeps them); otherwise nmcli's own agent answers from a passwd-file (0600, private 0700 folder,
  // deleted as soon as nmcli exits) with flags 2 ("ask every time"). Never on a command line.
  async function setActive(uuid, up, creds) {
    checkUuid(uuid);
    const c = creds && typeof creds === 'object' ? creds : null;
    if (c) {
      if (c.username != null && !ovpn.validSecret(c.username, 256)) throw err('Invalid user name', 'EINVAL');
      if (c.password != null && !ovpn.validSecret(c.password)) throw err('Invalid password', 'EINVAL');
      if (c.keyPassword != null && !ovpn.validSecret(c.keyPassword)) throw err('Invalid password', 'EINVAL');
    }
    if (MOCK) {
      const m = mock.conns.find((x) => x.uuid === uuid);
      if (!m) throw err('Unknown connection', 'ENOENT');
      await new Promise((r) => setTimeout(r, 250));
      if (up && m.needsAuth) {
        if (!c?.password && !m.saved) throw err('No valid secrets', 'ENEEDAUTH');
        if (c?.password === 'wrong') throw err('Invalid secrets', 'EAUTH');
        if (c?.username) m.username = c.username;
        if (c?.password) m.saved = !!c.remember;
      }
      m.active = up;
      m.device = up ? (m.type === 'wireguard' ? m.name.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 12) || 'wg0' : 'tun0') : '';
      return { ok: true };
    }
    if (!up) {
      await nmcli(['--wait', '25', 'connection', 'down', 'uuid', uuid]);
      return { ok: true };
    }
    const args = ['--wait', '45', 'connection', 'up', 'uuid', uuid];
    let tmp = null;
    try {
      if (c && (c.username || c.password || c.keyPassword)) {
        const keep = !!c.remember;
        const flags = keep ? '0' : '2';
        const data = [];
        if (c.username) data.push(`username=${ovpn.nmOptEscape(c.username)}`);
        if (c.password) data.push(`password-flags=${flags}`);
        if (c.keyPassword) data.push(`cert-pass-flags=${flags}`);
        if (data.length) await nmcli(['connection', 'modify', 'uuid', uuid, '+vpn.data', data.join(', ')]);
        const secrets = [];
        if (c.password) secrets.push(`password=${ovpn.nmOptEscape(c.password)}`);
        if (c.keyPassword) secrets.push(`cert-pass=${ovpn.nmOptEscape(c.keyPassword)}`);
        if (keep && secrets.length) {
          // nmcli's editor reads its commands from stdin: the secret never appears in /proc/<pid>/cmdline.
          const res = await run('nmcli', ['connection', 'edit', 'uuid', uuid], { timeout: 30000, input: `set vpn.secrets ${secrets.join(', ')}\nsave persistent\nquit\n` });
          const bad = `${res.stdout}\n${res.stderr}`.split('\n').find((l) => /^Error:/.test(l.trim()));
          if (res.code !== 0 || bad) {
            const msg = (bad || res.stderr || 'nmcli failed').trim().replace(/^Error:\s*/, '').slice(0, 300);
            throw err(msg, ovpn.classifyNmError(msg));
          }
        }
        const lines = [];
        if (!keep && c.password) lines.push(`vpn.secrets.password:${ovpn.passwdFileEscape(c.password)}`);
        if (!keep && c.keyPassword) lines.push(`vpn.secrets.cert-pass:${ovpn.passwdFileEscape(c.keyPassword)}`);
        if (lines.length) {
          const base = process.env.AURORA_NETTOOLS_TMPDIR || process.env.XDG_RUNTIME_DIR || os.tmpdir();
          const dir = fs.mkdtempSync(path.join(base, 'aurora-nettools-'));
          tmp = { dir, file: path.join(dir, 'secrets') };
          fs.writeFileSync(tmp.file, lines.join('\n') + '\n', { mode: 0o600, flag: 'wx' });
          args.push('passwd-file', tmp.file);
        }
      }
      await nmcli(args, 50000);
    } finally {
      if (tmp) fs.rmSync(tmp.dir, { recursive: true, force: true });
    }
    return { ok: true };
  }
  api.handle('nettools:vpnUp', (uuid, creds) => setActive(uuid, true, creds));
  api.handle('nettools:vpnDown', (uuid) => setActive(uuid, false));

  // .conf -> WireGuard, .ovpn -> OpenVPN (private copy of the profile + referenced certificates, then nmcli import)
  api.handle('nettools:vpnImport', async (file) => {
    if (typeof file === 'string' && /\.ovpn$/i.test(file)) {
      const p = checkOvpnPath(file);
      const info = inspectOvpn(p);
      const name = ovpn.cleanName(path.basename(p).replace(/\.ovpn$/i, ''));
      if (MOCK) {
        if (process.env.AURORA_NETTOOLS_MOCK_NO_OPENVPN === '1') throw err('failed to find VPN plugin for openvpn.', 'ENOPLUGIN');
        const n = String(mock.seq++).padStart(12, '0');
        const uuid = `00000000-0000-4000-8000-${n}`;
        mock.conns.push({ uuid, name, type: 'vpn', service: 'openvpn', device: '', active: false, needsAuth: info.needsAuth, needsKeyPass: info.needsKeyPass, remote: info.remotes[0]?.host || '' });
        return { name, uuid, type: 'openvpn', needsAuth: info.needsAuth, needsKeyPass: info.needsKeyPass };
      }
      const base = path.join(os.homedir(), '.local', 'share', 'aurora', 'nettools', 'openvpn');
      let copy;
      try {
        copy = ovpn.prepareCopy(info, name, base);
      } catch (e) {
        throw err(e.code === 'EINVAL' ? e.message : `${e.path ? path.basename(e.path) : name} (${e.code || e.message})`, e.code === 'EINVAL' ? 'EBADREF' : 'EMISSING');
      }
      let out;
      try {
        out = await nmcli(['connection', 'import', 'type', 'openvpn', 'file', copy.file]);
      } catch (e) {
        fs.rmSync(copy.dir, { recursive: true, force: true });
        throw e;
      }
      const uuid = (/\(([0-9a-f-]{36})\)/i.exec(out || '') || [])[1] || '';
      return { name, uuid, type: 'openvpn', needsAuth: info.needsAuth, needsKeyPass: info.needsKeyPass };
    }
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
    // OpenVPN profiles imported here keep their certificates in a private copy folder: removed with the connection.
    const base = path.join(os.homedir(), '.local', 'share', 'aurora', 'nettools', 'openvpn');
    let copies = [];
    try {
      const out = await nmcli(['-e', 'no', '-t', '-f', 'vpn.data', 'connection', 'show', 'uuid', uuid]);
      copies = ovpn.copyDirsIn(ovpn.parseVpnData(out.replace(/^vpn\.data:/m, '')), base);
    } catch {}
    await nmcli(['connection', 'delete', 'uuid', uuid]);
    for (const d of copies) fs.rmSync(d, { recursive: true, force: true });
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

  // ---------------------------------------------------------------- traceroute (tracepath, else traceroute)
  const traces = new Map();
  let traceSeq = 0;
  api.handle('nettools:trace', async (...args) => {
    const event = args[args.length - 1];
    const host = typeof args[0] === 'string' ? args[0].trim() : '';
    const opts = args.length > 2 && args[1] && typeof args[1] === 'object' ? args[1] : {};
    const kind = hostKind(host);
    if (!kind) throw err('Enter a host name, IPv4 or IPv6 address', 'EINVAL');
    const maxHops = Math.round(Number(opts.maxHops) || 30);
    if (maxHops < 1 || maxHops > 64) throw err('Invalid hop count', 'EINVAL');
    const family = ['auto', '4', '6'].includes(String(opts.family || 'auto')) ? String(opts.family || 'auto') : 'auto';
    if ((family === '4' && kind === 'ipv6') || (family === '6' && kind === 'ipv4')) throw err('Address family mismatch', 'EINVAL');
    const id = ++traceSeq;
    const emit = (payload) => api.sendTo(event?.sender, 'nettools:trace', { id, ...payload });
    let finished = false;
    const finish = (payload) => {
      if (finished) return;
      finished = true;
      traces.delete(id);
      emit({ done: true, ...payload });
    };
    if (MOCK) {
      const route = tr.mockRoute(host, kind, maxHops);
      const step = Math.max(10, Number(process.env.AURORA_NETTOOLS_PING_MS) || 250);
      if (route.error) {
        const t = setTimeout(() => finish({ code: 2, error: route.error, reached: false }), step);
        traces.set(id, { cancel: () => (clearTimeout(t), finish({ code: 130, cancelled: true, reached: false })) });
        return { id, tool: 'tracepath', mock: true };
      }
      const timers = route.hops.map((hop, i) => setTimeout(() => emit({ hop }), step * (i + 1)));
      timers.push(setTimeout(() => finish({ code: 0, reached: route.reached }), step * (route.hops.length + 1)));
      traces.set(id, { cancel: () => (timers.forEach(clearTimeout), finish({ code: 130, cancelled: true, reached: false })) });
      return { id, tool: 'tracepath', mock: true };
    }
    const tool = which('tracepath') ? 'tracepath' : which('traceroute') ? 'traceroute' : null;
    if (!tool) throw err('tracepath is not installed', 'ENOENT');
    const child = spawn(which(tool), tr.traceArgs(tool, host, { maxHops, family }), { env: { ...process.env, LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    let reached = false;
    let errText = '';
    const parse = tool === 'tracepath' ? tr.parseTracepathLine : tr.parseTracerouteLine;
    const onLine = (line) => {
      const r = parse(line);
      if (r?.n) {
        if (r.reached) reached = true;
        emit({ hop: r });
      } else if (r?.summary) reached = reached || r.summary.reached;
      else if (line.trim() && !r) errText = line.trim().slice(0, 300);
    };
    const onData = (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        onLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    let cancelled = false;
    const killer = setTimeout(() => child.kill('SIGKILL'), Math.min(300000, maxHops * 8000 + 10000));
    child.on('error', (e) => (clearTimeout(killer), finish({ code: 127, error: e.message, reached: false })));
    child.on('close', (code) => {
      clearTimeout(killer);
      if (buf) onLine(buf);
      finish({ code: code ?? 1, cancelled, reached, error: code && !cancelled && !reached ? errText : '' });
    });
    traces.set(id, { cancel: () => ((cancelled = true), child.kill('SIGINT')) });
    return { id, tool, mock: false };
  });
  api.handle('nettools:traceCancel', (id) => {
    const t = traces.get(Number(id));
    if (!t) return { ok: false };
    t.cancel();
    return { ok: true };
  });

  // ---------------------------------------------------------------- port check (Node net) + listening sockets (ss)
  api.handle('nettools:portCheck', async (hostIn, portsIn, optsIn) => {
    const host = typeof hostIn === 'string' ? hostIn.trim() : '';
    const kind = hostKind(host);
    if (!kind) throw err('Enter a host name, IPv4 or IPv6 address', 'EINVAL');
    const list = Array.isArray(portsIn) ? portsIn : ports.parsePorts(portsIn);
    if (!list || !list.length || list.length > 64 || !list.every((x) => Number.isInteger(x) && x >= 1 && x <= 65535)) throw err('Invalid port', 'EINVAL');
    const timeout = Math.min(15000, Math.max(200, Math.round(Number(optsIn?.timeout) || 3000)));
    let target;
    try {
      if (MOCK && kind === 'hostname' && /\.invalid$/i.test(host)) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
      target = await ports.resolveHost(host, kind);
    } catch (e) {
      throw err(`${host}: ${e.code || e.message}`, e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN' || e.code === 'ENODATA' ? 'ENOTFOUND' : 'EDNS');
    }
    const results = await ports.checkPorts(target.ip, list, timeout);
    return { host, ip: target.ip, family: target.family, results: results.map((r) => ({ ...r, service: ports.SERVICES[r.port] || '' })) };
  });

  api.handle('nettools:listening', async () => {
    if (MOCK) return { ...ports.parseSs(ports.MOCK_SS), mock: true };
    let res;
    try {
      res = await run('ss', ['-H', '-tulpn'], { timeout: 10000 });
    } catch (e) {
      if (e.code === 'ENOENT') throw err('ss is not installed', 'ENOENT');
      throw e;
    }
    if (res.code !== 0) throw err((res.stderr || 'ss failed').trim().slice(0, 300), 'ECMD');
    return { ...ports.parseSs(res.stdout), mock: false };
  });

  // ---------------------------------------------------------------- speed test (Cloudflare __down / __up)
  let speedRun = null; // { id, ctrl }
  let speedSeq = 0;
  api.handle('nettools:speed', async (...args) => {
    const event = args[args.length - 1];
    if (speedRun) throw err('A speed test is already running', 'EBUSY');
    const base = speed.baseUrl(process.env.AURORA_NETTOOLS_SPEED_URL);
    if (!base) throw err('Invalid speed test server', 'EINVAL');
    const id = ++speedSeq;
    const ctrl = new AbortController();
    speedRun = { id, ctrl };
    const emit = (payload) => api.sendTo(event?.sender, 'nettools:speed', { id, ...payload });
    const maxBytes = Number(process.env.AURORA_NETTOOLS_SPEED_MAX) || 0;
    // Started after the reply so the window knows the id before the first progress event.
    setTimeout(() => {
      speed
        .runSpeedTest({ base, maxBytes, signal: ctrl.signal, onProgress: (p) => emit(p) })
        .then((result) => emit({ done: true, result, cancelled: false }))
        .catch((e) => emit({ done: true, cancelled: ctrl.signal.aborted, error: ctrl.signal.aborted ? '' : String(e.message || e).slice(0, 300), code: ctrl.signal.aborted ? 'ECANCELED' : e.code || 'ENET' }))
        .finally(() => {
          if (speedRun?.id === id) speedRun = null;
        });
    }, 0);
    return { id, host: new URL(base).hostname };
  });
  api.handle('nettools:speedCancel', (id) => {
    if (!speedRun || speedRun.id !== Number(id)) return { ok: false };
    speedRun.ctrl.abort();
    return { ok: true };
  });

}

module.exports = register;
module.exports.hostKind = hostKind;
module.exports.validHost = validHost;
module.exports.splitTerse = splitTerse;
module.exports.parseConnections = parseConnections;
module.exports.formatRecords = formatRecords;
module.exports.DNS_TYPES = DNS_TYPES;
