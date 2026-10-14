// Network tools — the « later » items: OpenVPN import / connect with secrets, traceroute, port check + listening ports,
// speed test. Unit tests of the backend helpers (main/lib/nettools/*), the speed test against a local HTTP server
// implementing Cloudflare's __down / __up, then the real Electron shell in « real » backend mode
// (AURORA_NETTOOLS_REAL=1) with fake nmcli / tracepath / ss scripts first on PATH (test/fixtures/nettools/fakes: they
// never touch NetworkManager or the network), local TCP listeners and the local speed server; then French + dark in
// mock mode. Screenshots: test/out/nettools-<tab>-<theme>-<lang>.png.
// Usage:  cd aurora-os/shell && xvfb-run -a -s "-screen 0 1600x900x24" node test/nettools-extra.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { launchShell, ROOT, OUT } from './lib.mjs';

const require = createRequire(import.meta.url);
const ovpn = require('../main/lib/nettools/openvpn.js');
const tr = require('../main/lib/nettools/trace.js');
const ports = require('../main/lib/nettools/ports.js');
const speed = require('../main/lib/nettools/speed.js');
const WIN = '.win.app-nettools';
const FAKE_BIN = path.join(ROOT, 'test', 'fixtures', 'nettools', 'fakes');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

let passed = 0;
const failures = [];
function check(name, actual, expected) {
  const ok = typeof expected === 'function' ? !!expected(actual) : Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else failures.push(`${name}\n      expected: ${typeof expected === 'function' ? '(predicate)' : JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
  return ok;
}
async function section(name, fn) {
  const t0 = Date.now();
  const before = failures.length;
  try {
    await fn();
    console.log(`  ${failures.length === before ? '✓' : '✗'} ${name} (${Date.now() - t0} ms)`);
  } catch (err) {
    failures.push(`${name}: threw ${err?.stack || err}`);
    console.log(`  ✗ ${name}: ${err?.message || err}`);
  }
}
async function until(page, expr, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await page.evaluate(expr).catch(() => false)) return true;
    await sleep(50);
  }
  return false;
}
async function waitFor(fn, timeout = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await fn()) return true;
    await sleep(40);
  }
  return false;
}
const text = (page, sel) => page.evaluate(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? null`);
const invokeRaw = (page, channel, ...args) =>
  page.evaluate(
    `(async () => { const b = window.aurora; try { const r = b.invokeRaw ? await b.invokeRaw(${JSON.stringify(channel)}, ...${JSON.stringify(args)}) : { ok: true, value: await b.invoke(${JSON.stringify(channel)}, ...${JSON.stringify(args)}) }; return r; } catch (e) { return { ok: false, error: { message: e.message, code: e.code } }; } })()`,
  );
const hook = (fn) => `document.querySelector('${WIN} .nt-root').parentElement.__nettools.${fn}`;
const DLG = '.dialog-layer:not(.closing) .dialog';

// ---------------------------------------------------------------- local servers
function listen(server, host = '127.0.0.1') {
  return new Promise((resolve) => server.listen(0, host, () => resolve(server.address().port)));
}
async function closedPort() {
  const s = net.createServer();
  const p = await listen(s);
  await new Promise((r) => s.close(r));
  return p;
}

/** Cloudflare-like speed server: GET /__down?bytes=N, POST /__up; `rate` bytes/s per connection (0 = unlimited). */
function speedServer(opts = {}) {
  const st = { rate: opts.rate || 0, latency: opts.latency || [25, 35], timing: opts.timing ?? 5, reqs: [], active: 0, maxActive: 0, aborted: 0, li: 0 };
  const buf = Buffer.alloc(16384, 0x61);
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    st.active++;
    st.maxActive = Math.max(st.maxActive, st.active);
    let open = true;
    res.on('close', () => {
      if (!res.writableFinished) st.aborted++;
      if (open) (open = false), st.active--;
    });
    const headers = { 'cf-meta-colo': 'TST', 'cf-meta-city': 'Testville', 'cf-meta-country': 'FR', 'cf-meta-ip': '198.51.100.7', 'server-timing': `cfRequestDuration;dur=${st.timing}` };
    const t0 = Date.now();
    if (u.pathname === '/__down' && req.method === 'GET') {
      const n = Number(u.searchParams.get('bytes'));
      const rec = { m: 'GET', bytes: n, at: Date.now() };
      st.reqs.push(rec);
      if (!n) {
        const d = st.latency[st.li++ % st.latency.length];
        return setTimeout(() => (res.writeHead(200, { ...headers, 'content-length': 0 }), res.end()), d);
      }
      res.writeHead(200, { ...headers, 'content-type': 'application/octet-stream', 'content-length': n });
      let sent = 0;
      const pump = () => {
        while (sent < n) {
          if (res.destroyed) return;
          if (st.rate && sent >= (st.rate * (Date.now() - t0)) / 1000 + buf.length) return setTimeout(pump, 4);
          const k = Math.min(buf.length, n - sent);
          sent += k;
          if (!res.write(k === buf.length ? buf : buf.subarray(0, k))) return res.once('drain', pump);
        }
        res.end();
      };
      return pump();
    }
    if (u.pathname === '/__up' && req.method === 'POST') {
      const rec = { m: 'POST', bytes: 0, declared: Number(req.headers['content-length']), at: Date.now() };
      st.reqs.push(rec);
      req.on('data', (d) => {
        rec.bytes += d.length;
        if (!st.rate) return;
        const ahead = rec.bytes - (st.rate * (Date.now() - t0)) / 1000;
        if (ahead > 0) {
          req.pause();
          setTimeout(() => req.resume(), (ahead / st.rate) * 1000);
        }
      });
      req.on('end', () => (res.writeHead(200, { ...headers, 'content-type': 'text/plain' }), res.end('ok')));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return { server, st, async start() {
    st.port = await listen(server);
    st.url = `http://127.0.0.1:${st.port}`;
    return st;
  }, stop: () => new Promise((r) => (server.closeAllConnections?.(), server.close(r))) };
}

// ---------------------------------------------------------------- profiles
const CERT = '-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----';
const KEY = '-----BEGIN PRIVATE KEY-----\nMIIEfake\n-----END PRIVATE KEY-----';
function writeProfile(dir, name, { auth = true, ca = 'ca.crt', writeCa = true, remote = 'vpn.example.org 1194 udp', extra = '' } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  if (ca && writeCa) fs.writeFileSync(path.join(dir, ca), `${CERT}\n`);
  const lines = ['client', 'dev tun', 'proto udp', remote ? `remote ${remote}` : '', 'nobind', 'persist-key', ca ? `ca ${ca}` : '', auth ? 'auth-user-pass' : '', `<cert>\n${CERT}\n</cert>`, `<key>\n${KEY}\n</key>`, extra, 'verb 3'];
  const p = path.join(dir, `${name}.ovpn`);
  fs.writeFileSync(p, lines.filter(Boolean).join('\n') + '\n');
  return p;
}

// ================================================================= unit: OpenVPN helpers
await section('unit: .ovpn parsing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-ovpn-'));
  const p = writeProfile(dir, 'work', { extra: 'tls-auth "ta key.key" 1' });
  fs.writeFileSync(path.join(dir, 'ta key.key'), 'static key');
  const info = ovpn.parseOvpn(fs.readFileSync(p, 'utf8'), dir);
  check('profile ok', [info.ok, info.problem], [true, null]);
  check('remote parsed', info.remotes, [{ host: 'vpn.example.org', port: 1194, proto: 'udp' }]);
  check('auth-user-pass -> password-tls', [info.auth, info.needsAuth, info.needsKeyPass], ['password-tls', true, false]);
  check('inline blocks', info.inline, ['cert', 'key']);
  check('file references (quoted name kept)', info.files.map((f) => [f.directive, f.arg, f.path]), [['ca', 'ca.crt', path.join(dir, 'ca.crt')], ['tls-auth', 'ta key.key', path.join(dir, 'ta key.key')]]);
  const t = (s) => ovpn.parseOvpn(s, dir);
  check('no remote', t('client\nca ca.crt\n').problem, 'noRemote');
  check('server config', t('remote a\nca ca.crt\nmode server\n').problem, 'notClient');
  check('no ca', t('client\nremote a\n').problem, 'noCa');
  check('unclosed block', t('client\nremote a\n<ca>\nxx\n').problem, 'unclosed');
  check('binary', t('client\0remote a').problem, 'binary');
  check('pkcs12 needs a key password', [t('client\nremote a\npkcs12 me.p12\n').needsKeyPass, t('client\nremote a\npkcs12 me.p12\n').auth], [true, 'tls']);
  check('encrypted inline key', t(`client\nremote a\nca c\n<key>\n-----BEGIN ENCRYPTED PRIVATE KEY-----\nx\n</key>\n`).needsKeyPass, true);
  check('remote port / proto defaults', t('client\nremote a\nport 443\nproto tcp-client\nca c\n').remotes, [{ host: 'a', port: 443, proto: 'tcp' }]);
  check('tokenize quotes and escapes', ovpn.tokenize(`ca "my dir/ca.crt" 'x y' a\\ b # c`), ['ca', 'my dir/ca.crt', 'x y', 'a b', '#', 'c']);
  check('quoteArg', [ovpn.quoteArg('/a/b.crt'), ovpn.quoteArg('/a b/"c"')], ['/a/b.crt', '"/a b/\\"c\\""']);
  check('cleanName strips slashes / control chars', [ovpn.cleanName('../a/b\u0007c'), ovpn.cleanName('...'), ovpn.cleanName('x'.repeat(80)).length], ['a b c', 'VPN', 64]);
  fs.rmSync(dir, { recursive: true, force: true });
});

await section('unit: private copy of the profile and its files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-ovpn-'));
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-copy-'));
  const p = writeProfile(dir, 'work', { extra: 'auth-user-pass creds.txt' });
  fs.writeFileSync(path.join(dir, 'creds.txt'), 'user\npass\n');
  const info = ovpn.parseOvpn(fs.readFileSync(p, 'utf8'), dir);
  const copy = ovpn.prepareCopy(info, 'work', path.join(base, 'openvpn'));
  const text = fs.readFileSync(copy.file, 'utf8');
  const caLine = text.split('\n').find((l) => l.startsWith('ca '));
  check('ca rewritten to the private copy', caLine, `ca ${path.join(copy.dir, 'ca.crt')}`);
  check('copied certificate content', fs.readFileSync(path.join(copy.dir, 'ca.crt'), 'utf8'), `${CERT}\n`);
  check('folder 0700, files 0600', [fs.statSync(copy.dir).mode & 0o777, fs.statSync(copy.file).mode & 0o777, fs.statSync(path.join(copy.dir, 'ca.crt')).mode & 0o777], [0o700, 0o600, 0o600]);
  check('auth-user-pass loses its file (NetworkManager asks)', text.split('\n').filter((l) => l.startsWith('auth-user-pass')), ['auth-user-pass', 'auth-user-pass']);
  check('credentials file not copied', fs.existsSync(path.join(copy.dir, 'creds.txt')), false);
  check('inline blocks kept', text.includes('<cert>') && text.includes('<key>'), true);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(base, { recursive: true, force: true });
});

await section('unit: nmcli escaping, vpn.data, errors', async () => {
  check('nmOptEscape', ovpn.nmOptEscape('a b,c=d\\e'), 'a\\ b\\,c\\=d\\\\e');
  check('passwdFileEscape (space / tab octal, backslash doubled)', ovpn.passwdFileEscape('p w\t\\x'), 'p\\040w\\011\\\\x');
  check('parseVpnData', ovpn.parseVpnData('ca = /x/ca.crt, remote = a\\, b, password-flags = 1'), { ca: '/x/ca.crt', remote: 'a, b', 'password-flags': '1' });
  const d = ovpn.parseVpnDetails('vpn.service-type:org.freedesktop.NetworkManager.openvpn\nvpn.data:connection-type = password-tls, password-flags = 1, remote = vpn.example.org:1194, username = ana\n');
  check('details: service / remote / user', [d.service, d.remote, d.username], ['openvpn', 'vpn.example.org', 'ana']);
  check('details: password to ask', [d.needsPassword, d.passwordSaved, d.keyPass], [true, false, 'none']);
  const saved = ovpn.parseVpnDetails('vpn.service-type:org.freedesktop.NetworkManager.openvpn\nvpn.data:connection-type = password, password-flags = 0, cert-pass-flags = 2\n');
  check('details: saved password, key password asked', [saved.needsPassword, saved.passwordSaved, saved.keyPass], [false, true, 'ask']);
  check('details: not-required flag (4)', ovpn.parseVpnDetails('vpn.data:connection-type = password, password-flags = 4').needsPassword, false);
  const cls = (m) => ovpn.classifyNmError(m);
  check('classify', [cls('failed to load VPN plugin: unknown VPN plugin "x"'), cls('Connection activation failed: The VPN login failed.'), cls('Connection activation failed: Secrets were required, but not provided.'), cls('failed to import'), cls('Timeout expired (90 seconds)'), cls('other')], ['ENOPLUGIN', 'EAUTH', 'ENEEDAUTH', 'EBADFILE', 'ETIMEDOUT', 'ECMD']);
  const b = '/h/.local/share/aurora/nettools/openvpn';
  check('copyDirsIn: only our private copy folders', ovpn.copyDirsIn({ ca: `${b}/work-1a2b3c4d/ca.crt`, ta: `${b}/work-1a2b3c4d/ta.key`, cert: `${b}/../../x/y`, key: '/etc/ssl/k.pem', remote: 'a', x: `${b}/evil/k` }, b), [`${b}/work-1a2b3c4d`]);
  check('validSecret refuses newlines / empty / long', [ovpn.validSecret('a b'), ovpn.validSecret('a\nb'), ovpn.validSecret(''), ovpn.validSecret('x'.repeat(1025)), ovpn.validSecret(5)], [true, false, false, false, false]);
});

// ================================================================= unit: traceroute
await section('unit: tracepath / traceroute parsers and argument vectors', async () => {
  const p = tr.parseTracepathLine;
  check('LOCALHOST probe ignored', p(' 1?: [LOCALHOST]                      pmtu 1500'), null);
  check('hop with name', p(' 1:  _gateway (192.168.1.1)          0.512ms '), { n: 1, host: '_gateway', ip: '192.168.1.1', ms: [0.512], timeouts: 0, reached: false, note: '' });
  check('no reply', p(' 3:  no reply'), { n: 3, host: '', ip: '', ms: [], timeouts: 1, reached: false, note: '' });
  check('asymm note', p(' 3:  core1.example.net (203.0.113.9)   7.802ms asymm  4 ').note, 'asymm 4');
  check('reached', p(' 9:  example.com (93.184.215.14)   12.345ms reached').reached, true);
  check('IP only', [p(' 2:  10.0.0.1   4.2ms').ip, p(' 2:  10.0.0.1   4.2ms').host], ['10.0.0.1', '']);
  check('Resume line', p('     Resume: pmtu 1500 hops 9 back 9 '), { summary: { hops: 9, reached: true } });
  check('Too many hops', p('     Too many hops: pmtu 1500'), { summary: { hops: null, reached: false } });
  check('garbage', p('tracepath: x: Name or service not known'), null);
  const q = tr.parseTracerouteLine;
  check('traceroute header', q('traceroute to example.com (93.184.215.14), 30 hops max, 60 byte packets'), { header: { host: 'example.com', ip: '93.184.215.14', max: 30 } });
  check('traceroute hop', q(' 1  _gateway (192.168.1.1)  0.426 ms  0.398 ms  0.377 ms'), { n: 1, host: '_gateway', ip: '192.168.1.1', ms: [0.426, 0.398, 0.377], timeouts: 0, reached: false, note: '' });
  check('traceroute timeouts', q(' 2  * * *'), { n: 2, host: '', ip: '', ms: [], timeouts: 3, reached: false, note: '' });
  check('traceroute partial', [q(' 3  10.0.0.1 (10.0.0.1)  5.1 ms * 5.3 ms').timeouts, q(' 3  10.0.0.1 (10.0.0.1)  5.1 ms * 5.3 ms').host], [1, '']);
  check('tracepath argv', tr.traceArgs('tracepath', 'example.com', { maxHops: 12, family: '6' }), ['-6', '-b', '-m', '12', 'example.com']);
  check('traceroute argv', tr.traceArgs('traceroute', 'example.com', {}), ['-q', '3', '-w', '2', '-m', '30', 'example.com']);
  const m = tr.mockRoute('example.com', 'hostname', 30);
  check('mock route reaches the host', [m.reached, m.hops.length, m.hops[3].timeouts], [true, 7, 1]);
  check('mock route max hops', tr.mockRoute('192.0.2.1', 'ipv4', 9).hops.length, 9);
});

// ================================================================= unit: ports
await section('unit: port lists, ss parsing, TCP connect test', async () => {
  check('parsePorts', ports.parsePorts('22, 80;443 8000-8002 80'), [22, 80, 443, 8000, 8001, 8002]);
  check('parsePorts rejects', [ports.parsePorts('0'), ports.parsePorts('70000'), ports.parsePorts('1-100'), ports.parsePorts('22,abc'), ports.parsePorts(''), ports.parsePorts('9-3')], [null, null, null, null, null, null]);
  check('splitAddrPort', [ports.splitAddrPort('127.0.0.53%lo:53'), ports.splitAddrPort('[fe80::1%eth0]:546'), ports.splitAddrPort('*:5353')], [{ addr: '127.0.0.53', iface: 'lo', port: 53 }, { addr: 'fe80::1', iface: 'eth0', port: 546 }, { addr: '*', iface: '', port: 5353 }]);
  const ss = ports.parseSs(ports.MOCK_SS + '\ntcp ESTAB 0 0 10.0.0.2:4000 1.2.3.4:443 users:(("x",pid=1,fd=2))');
  check('ss: listening only', ss.items.length, 9);
  check('ss: hidden processes counted', ss.hidden, 7);
  check('ss: SO_REUSEPORT duplicates merged', ports.parseSs('udp UNCONN 0 0 0.0.0.0:5353 0.0.0.0:*\nudp UNCONN 0 0 0.0.0.0:5353 0.0.0.0:*').items.length, 1);
  const node = ss.items.find((i) => i.port === 5173);
  check('ss: process + scope', [node.processes, node.scope, node.proto], [[{ name: 'node', pid: 4242 }], 'local', 'tcp']);
  check('ss: all interfaces / service', [ss.items.find((i) => i.port === 22).scope, ss.items.find((i) => i.port === 22).service], ['all', 'SSH']);
  const srv = net.createServer((c) => c.end());
  const open = await listen(srv);
  const closed = await closedPort();
  const r = await ports.checkPorts('127.0.0.1', [open, closed], 2000);
  check('open port', [r[0].status, typeof r[0].ms === 'number' && r[0].ms >= 0], ['open', true]);
  check('closed port (refused)', [r[1].status, r[1].code, r[1].ms], ['closed', 'ECONNREFUSED', null]);
  // A listening socket that never accepts (python3, backlog 0) + filled accept queue: further SYNs are dropped.
  let hole = null;
  if (fs.existsSync('/usr/bin/python3')) {
    const py = spawn('/usr/bin/python3', ['-I', '-c', 'import socket,sys,time\ns=socket.socket()\ns.bind(("127.0.0.1",0))\ns.listen(0)\nprint(s.getsockname()[1],flush=True)\ntime.sleep(30)'], { stdio: ['ignore', 'pipe', 'inherit'] });
    const port = await new Promise((res) => py.stdout.once('data', (d) => res(Number(String(d).trim()))));
    const fillers = [];
    for (let i = 0; i < 4; i++) fillers.push(net.connect(port, '127.0.0.1').on('error', () => {}));
    await sleep(200);
    hole = { py, port, fillers };
  }
  const t0 = Date.now();
  const f = hole ? await ports.checkPort('127.0.0.1', hole.port, 400) : await ports.checkPort('192.0.2.1', 80, 400);
  check('no answer -> filtered (timeout)', hole ? f.status : ['filtered', 'unreachable'].includes(f.status) ? 'filtered' : f.status, 'filtered');
  check('timeout respected', Date.now() - t0 < 1500, true);
  if (hole) {
    hole.fillers.forEach((c) => c.destroy());
    hole.py.kill();
  }
  const ac = new AbortController();
  const pending = ports.checkPorts('192.0.2.1', [81, 82], 5000, { signal: ac.signal });
  setTimeout(() => ac.abort(), 100);
  check('abort -> cancelled', (await pending).map((x) => x.status).every((s) => s === 'cancelled' || s === 'unreachable'), true);
  srv.close();
});

// ================================================================= unit: speed test
await section('unit: speed test math', async () => {
  check('mbps', [speed.mbps(1e6, 1000), speed.mbps(4e6, 500), speed.mbps(1, 0)], [8, 64, 0]);
  check('latencyStats', speed.latencyStats([20, 30, 20, 30, 20]), { ping: 20, jitter: 10, min: 20, max: 30 });
  check('latencyStats even median', speed.latencyStats([10, 20, 30, 40]).ping, 25);
  check('latencyStats empty', speed.latencyStats([]).ping, null);
  check('pickSpeed: fastest long phase', speed.pickSpeed([{ bytes: 4e5, ms: 20 }, { bytes: 4e6, ms: 500 }, { bytes: 4e7, ms: 4000 }]), 80);
  check('pickSpeed: short phases only -> last', speed.pickSpeed([{ bytes: 4e5, ms: 100 }, { bytes: 4e6, ms: 200 }]), 160);
  check('pickSpeed: none', speed.pickSpeed([]), null);
  check('planSizes', [speed.planSizes(speed.DOWN_SIZES, 0), speed.planSizes(speed.DOWN_SIZES, 2e6), speed.planSizes(speed.UP_SIZES, 1e6)], [[1e5, 1e6, 1e7, 2.5e7], [1e5, 1e6, 2e6], [1e5, 1e6]]);
  check('serverTiming', [speed.serverTiming('cfRequestDuration;dur=12.5'), speed.serverTiming('cache;desc=x, cfRequestDuration;dur=3'), speed.serverTiming('')], [12.5, 3, 0]);
  check('baseUrl', [speed.baseUrl(''), speed.baseUrl('http://127.0.0.1:9/'), speed.baseUrl('ftp://x'), speed.baseUrl('https://u:p@x'), speed.baseUrl('nope')], ['https://speed.cloudflare.com', 'http://127.0.0.1:9', null, null, null]);
});

await section('unit: speed test against a local __down / __up server', async () => {
  const srv = speedServer({ rate: 2e6, latency: [25, 35], timing: 5 });
  const st = await srv.start();
  const events = [];
  const t0 = Date.now();
  const r = await speed.runSpeedTest({ base: st.url, maxBytes: 1e6, onProgress: (p) => events.push(p) });
  const took = Date.now() - t0;
  const gets = st.reqs.filter((x) => x.m === 'GET');
  check('11 latency requests (1 warm-up)', gets.filter((x) => x.bytes === 0).length, 11);
  check('progressive download sizes, 4 streams each', gets.filter((x) => x.bytes).map((x) => x.bytes), [1e5, 1e5, 1e5, 1e5, 1e6, 1e6, 1e6, 1e6]);
  const posts = st.reqs.filter((x) => x.m === 'POST');
  check('progressive upload sizes', posts.map((x) => x.declared), [1e5, 1e5, 1e5, 1e5, 1e6, 1e6, 1e6, 1e6]);
  check('upload bodies complete', posts.every((x) => x.bytes === x.declared), true);
  check('parallel streams', st.maxActive, 4);
  check('ping = median latency minus server time (~25 ms)', r.ping, (v) => v >= 23 && v <= 31);
  check('jitter ~10 ms', r.jitter, (v) => v >= 7 && v <= 13);
  check('download ~64 Mbit/s (4 × 2 MB/s)', r.download, (v) => v >= 38 && v <= 75);
  check('upload ~64 Mbit/s', r.upload, (v) => v >= 38 && v <= 75);
  check('server info from cf-meta headers', [r.server.colo, r.server.city, r.server.country, r.server.host, r.ip], ['TST', 'Testville', 'FR', '127.0.0.1', '198.51.100.7']);
  check('bytes counted', r.bytes, (v) => v >= 2 * 4.4e6 && v < 2 * 4.4e6 + 10000);
  check('phases reported', [r.phases.download.length, r.phases.upload.length], [2, 2]);
  const phases = [...new Set(events.map((e) => e.phase))];
  check('progress phases in order', phases, ['latency', 'download', 'upload']);
  check('download progress carries Mbit/s', events.filter((e) => e.phase === 'download' && e.mbps > 0).length, (n) => n >= 2);
  check('progress ends at 1', events.filter((e) => e.phase === 'upload').pop().progress, 1);
  check('took a few seconds at most', took, (v) => v < 8000);
  // a phase longer than PHASE_TARGET_MS stops the size ramp
  st.reqs.length = 0;
  st.rate = 4e6;
  const full = await speed.runSpeedTest({ base: st.url });
  check('no bigger size after a phase longer than 1.5 s (no 25 MB request)', [...new Set(st.reqs.filter((x) => x.m === 'GET' && x.bytes).map((x) => x.bytes))], [1e5, 1e6, 1e7]);
  check('full sizes: ~128 Mbit/s (4 × 4 MB/s)', full.download, (v) => v >= 80 && v <= 140);
  // cancel during the download
  st.reqs.length = 0;
  st.rate = 1e5;
  const ac = new AbortController();
  const p = speed.runSpeedTest({ base: st.url, maxBytes: 1e6, signal: ac.signal, onProgress: (e) => {
    if (e.phase === 'download' && !ac.signal.aborted) ac.abort();
  } });
  const err = await p.then(() => null, (e) => e);
  check('cancel rejects with ECANCELED', err?.code, 'ECANCELED');
  await waitFor(() => st.active === 0, 2000);
  check('connections closed after cancel', st.active, 0);
  const reqsAtAbort = st.reqs.length;
  await sleep(400);
  check('no request after cancel (11 latency + 4 downloads at most)', [st.reqs.length === reqsAtAbort, reqsAtAbort <= 15, st.reqs.some((x) => x.m === 'POST')], [true, true, false]);
  await srv.stop();
  const down = await speed.runSpeedTest({ base: st.url }).then(() => null, (e) => e);
  check('server gone -> ENET', down?.code, 'ENET');
});

// ================================================================= Electron, real backend mode with fakes (en, light)
check('fake nmcli is executable', (() => {
  try {
    fs.accessSync(path.join(FAKE_BIN, 'nmcli'), fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
})(), true);
const NM = fs.mkdtempSync(path.join(os.tmpdir(), 'nettools-nm-'));
const PASSDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nettools-pass-'));
fs.writeFileSync(
  path.join(NM, 'state.json'),
  JSON.stringify({
    good: 'correct horse',
    conns: [
      { name: 'Home WireGuard', uuid: '5b1e0c4a-1f7e-4c3b-9a43-0d2a6c1e8f01', type: 'wireguard', service: 'wireguard', device: 'wg-home', active: true, data: {}, secrets: {} },
      { name: 'Office VPN', uuid: '9d3f2b77-6a10-4e8d-b2c5-71f0a9e4d302', type: 'vpn', service: 'openvpn', device: '', active: false, data: { 'connection-type': 'tls', remote: 'vpn.example.org:1194' }, secrets: {} },
    ],
  }),
);
const nmLog = () =>
  fs.existsSync(path.join(NM, 'log.jsonl'))
    ? fs.readFileSync(path.join(NM, 'log.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
const setState = (fn) => {
  const f = path.join(NM, 'state.json');
  const st = JSON.parse(fs.readFileSync(f, 'utf8'));
  fn(st);
  fs.writeFileSync(f, JSON.stringify(st));
};
const tcpOpen = net.createServer((c) => c.end());
const OPEN = await listen(tcpOpen);
const CLOSED = await closedPort();
const sp = speedServer({ rate: 3e6, latency: [8, 12], timing: 1 });
const SP = await sp.start();

let s = await launchShell({
  open: ['nettools'],
  lang: 'en',
  theme: 'light',
  env: { PATH: `${FAKE_BIN}:${process.env.PATH}`, AURORA_NETTOOLS_REAL: '1', FAKE_NM_DIR: NM, FAKE_TRACE_MS: '150', AURORA_NETTOOLS_TMPDIR: PASSDIR, AURORA_NETTOOLS_SPEED_URL: SP.url, AURORA_NETTOOLS_SPEED_MAX: '1000000' },
});
let page = s.page;
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(e.message));
const rows = (pg) => pg.evaluate(`[...document.querySelectorAll('${WIN} .nt-vpn')].map((r) => ({ name: r.querySelector('.nt-vpn-name').textContent, badge: r.querySelector('.nt-badge').textContent, status: r.querySelector('.nt-status').textContent }))`);
const row = (name) => `[...document.querySelectorAll('${WIN} .nt-vpn')].find((r) => r.querySelector('.nt-vpn-name').textContent === ${JSON.stringify(name)})`;
const SECRETS = ['correct horse', 'wrong pass', 'correct\\040horse', 'correct\\ horse'];
const argvLeaks = () => nmLog().filter((e) => SECRETS.some((x) => e.argv.join(' ').includes(x) || e.argv.some((a) => a.includes(x))));

await section('real mode: VPN list from nmcli with the OpenVPN badge', async () => {
  check('window opened', await until(page, `document.querySelectorAll('${WIN} .nt-vpn').length === 2`, 20000), true);
  check('rows + badges', await rows(page), [
    { name: 'Home WireGuard', badge: 'WireGuard', status: 'Connected · wg-home' },
    { name: 'Office VPN', badge: 'OpenVPN', status: 'Not connected' },
  ]);
  check('not mock', (await invokeRaw(page, 'nettools:vpnList')).value?.mock, false);
  check('service asked with -e no -t -f', nmLog().some((e) => e.argv.join(' ') === '-e no -t -f vpn.service-type,vpn.data connection show uuid 9d3f2b77-6a10-4e8d-b2c5-71f0a9e4d302'), true);
  const info = (await invokeRaw(page, 'nettools:vpnInfo', '9d3f2b77-6a10-4e8d-b2c5-71f0a9e4d302')).value;
  check('vpnInfo (certificate only)', [info?.service, info?.remote, info?.needsPassword, info?.keyPass], ['openvpn', 'vpn.example.org', false, 'none']);
  await page.click(`${WIN} .nt-vpn:nth-child(2) [data-act=toggle]`);
  check('certificate-only profile connects without asking', await until(page, `${row('Office VPN')}?.querySelector('.nt-status').textContent === 'Connected · tun0'`), true);
  check('no dialog was shown', await page.evaluate(`!document.querySelector('${DLG}')`), true);
  await page.click(`${WIN} .nt-vpn:nth-child(2) [data-act=toggle]`);
  check('disconnects', await until(page, `${row('Office VPN')}?.querySelector('.nt-status').textContent === 'Not connected'`), true);
  check('down argv', nmLog().some((e) => e.argv.join(' ') === '--wait 25 connection down uuid 9d3f2b77-6a10-4e8d-b2c5-71f0a9e4d302'), true);
});

let workUuid = '';
await section('real mode: import an .ovpn (referenced certificate, inline key)', async () => {
  const dir = path.join(s.home, 'Downloads', 'work-vpn');
  const p = writeProfile(dir, 'work');
  await page.evaluate(`${hook('importPath')}(${JSON.stringify(p)})`);
  check('imported row', await until(page, `!!${row('work')}`), true);
  check('success message mentions the sign-in', await text(page, `${WIN} .nt-vpn-info .infobar.success`), '“work” was imported. You’ll be asked for your user name and password when you connect.');
  check('OpenVPN badge', await page.evaluate(`${row('work')}.querySelector('.nt-badge').textContent`), 'OpenVPN');
  const imp = nmLog().find((e) => e.argv[1] === 'import');
  const base = path.join(s.home, '.local', 'share', 'aurora', 'nettools', 'openvpn');
  check('nmcli import argument vector', imp?.argv.slice(0, 5), ['connection', 'import', 'type', 'openvpn', 'file']);
  check('imports the private copy', imp?.argv[5]?.startsWith(base + path.sep) && imp.argv[5].endsWith('/work.ovpn'), true);
  const copyDir = path.dirname(imp.argv[5]);
  check('copy references the copied ca', imp.content.split('\n').find((l) => l.startsWith('ca ')), `ca ${path.join(copyDir, 'ca.crt')}`);
  check('copied ca (0600) in a 0700 folder', [fs.statSync(path.join(copyDir, 'ca.crt')).mode & 0o777, fs.statSync(copyDir).mode & 0o777], [0o600, 0o700]);
  workUuid = JSON.parse(fs.readFileSync(path.join(NM, 'state.json'), 'utf8')).conns.find((c) => c.name === 'work').uuid;
  check('uuid returned', (await invokeRaw(page, 'nettools:vpnList')).value.items.some((c) => c.uuid === workUuid && c.service === 'openvpn'), true);
});

await section('real mode: connect asks for the password (passwd-file, never argv)', async () => {
  await page.click(`${WIN} .nt-vpn[data-uuid="${workUuid}"] [data-act=toggle]`);
  check('credentials dialog', await until(page, `!!document.querySelector('${DLG} #nt-cred-pass')`, 5000), true);
  await sleep(150);
  check('dialog title', await text(page, `${DLG} .dialog-title`), 'Sign in to the VPN');
  check('intro', await text(page, `${DLG} .nt-cred-intro`), '“work” needs your user name and password.');
  check('user field focused', await page.evaluate(`document.activeElement?.id`), 'nt-cred-user');
  await page.click(`${DLG} .dialog-footer .btn.primary`);
  check('empty user refused', await text(page, `${DLG} .nt-cred-error`), 'Enter your user name.');
  await page.fill(`${DLG} #nt-cred-user`, 'ana');
  await page.fill(`${DLG} #nt-cred-pass`, 'wrong pass');
  await page.uncheck(`${DLG} #nt-cred-remember`);
  await page.press(`${DLG} #nt-cred-pass`, 'Enter');
  check('login failed -> asked again with the reason', await until(page, `(document.querySelector('${DLG} .nt-cred-error')?.textContent || '') === 'The server refused the user name or password.'`, 6000), true);
  check('user name kept', await page.inputValue(`${DLG} #nt-cred-user`), 'ana');
  check('remember stays unchecked', await page.isChecked(`${DLG} #nt-cred-remember`), false);
  await page.fill(`${DLG} #nt-cred-pass`, 'correct horse');
  await page.click(`${DLG} .dialog-footer .btn.primary`);
  check('connected', await until(page, `${row('work')}?.querySelector('.nt-status').textContent === 'Connected · tun0'`, 6000), true);
  const ups = nmLog().filter((e) => e.argv.includes('up') && e.passwd);
  check('two attempts through a passwd-file', ups.length, 2);
  check('passwd-file 0600 in a 0700 folder', ups.map((u) => [u.passwd.mode, u.passwd.dirMode]), [['600', '700'], ['600', '700']]);
  check('passwd-file content (escaped)', ups[1].passwd.content, 'vpn.secrets.password:correct\\040horse\n');
  check('passwd-file under AURORA_NETTOOLS_TMPDIR', ups[1].passwd.file.startsWith(PASSDIR + path.sep), true);
  check('passwd-file deleted', ups.every((u) => !fs.existsSync(u.passwd.file) && !fs.existsSync(path.dirname(u.passwd.file))), true);
  check('up argv', ups[1].argv.slice(0, 6), ['--wait', '45', 'connection', 'up', 'uuid', workUuid]);
  const mod = nmLog().filter((e) => e.argv.includes('modify'));
  check('user name + « ask every time » flag stored with modify', mod.at(-1)?.argv, ['connection', 'modify', 'uuid', workUuid, '+vpn.data', 'username=ana, password-flags=2']);
  check('no secret on any nmcli command line', argvLeaks(), []);
  await page.click(`${WIN} .nt-vpn[data-uuid="${workUuid}"] [data-act=toggle]`);
  check('disconnected', await until(page, `${row('work')}?.querySelector('.nt-status').textContent === 'Not connected'`), true);
});

await section('real mode: « remember » keeps the password in NetworkManager (stdin, not argv)', async () => {
  await page.click(`${WIN} .nt-vpn[data-uuid="${workUuid}"] [data-act=toggle]`);
  check('asked again (flags 2)', await until(page, `!!document.querySelector('${DLG} #nt-cred-pass')`, 5000), true);
  await sleep(150);
  check('user name pre-filled from NetworkManager', await page.inputValue(`${DLG} #nt-cred-user`), 'ana');
  check('password field focused', await page.evaluate(`document.activeElement?.id`), 'nt-cred-pass');
  check('remember checked by default', await page.isChecked(`${DLG} #nt-cred-remember`), true);
  await page.fill(`${DLG} #nt-cred-pass`, 'correct horse');
  await page.click(`${DLG} .dialog-footer .btn.primary`);
  check('connected', await until(page, `${row('work')}?.querySelector('.nt-status').textContent === 'Connected · tun0'`, 6000), true);
  const edit = nmLog().filter((e) => e.argv.includes('edit')).pop();
  check('nmcli connection edit argv', edit?.argv, ['connection', 'edit', 'uuid', workUuid]);
  check('secret written through stdin', edit?.stdin, 'set vpn.secrets password=correct\\ horse\nsave persistent\nquit\n');
  check('flags 0 (kept by NetworkManager)', nmLog().filter((e) => e.argv.includes('modify')).pop()?.argv[5], 'username=ana, password-flags=0');
  check('last up without passwd-file', nmLog().filter((e) => e.argv.includes('up')).pop()?.argv.includes('passwd-file'), false);
  check('still no secret on a command line', argvLeaks(), []);
  await page.click(`${WIN} .nt-vpn[data-uuid="${workUuid}"] [data-act=toggle]`);
  await until(page, `${row('work')}?.querySelector('.nt-status').textContent === 'Not connected'`);
  await page.click(`${WIN} .nt-vpn[data-uuid="${workUuid}"] [data-act=toggle]`);
  check('saved password: connects without asking', await until(page, `${row('work')}?.querySelector('.nt-status').textContent === 'Connected · tun0'`, 6000), true);
  check('no dialog', await page.evaluate(`!document.querySelector('${DLG}')`), true);
  await page.click(`${WIN} .nt-vpn[data-uuid="${workUuid}"] [data-act=toggle]`);
  await until(page, `${row('work')}?.querySelector('.nt-status').textContent === 'Not connected'`);
  check('backend refuses a secret with a newline', (await invokeRaw(page, 'nettools:vpnUp', workUuid, { username: 'ana', password: 'a\nvpn.secrets.x:y' })).error?.code, 'EINVAL');
  check('backend refuses a non-string user', (await invokeRaw(page, 'nettools:vpnUp', workUuid, { username: 5, password: 'x' })).error?.code, 'EINVAL');
  check('vpnInfo validates the uuid', (await invokeRaw(page, 'nettools:vpnInfo', '--help')).error?.code, 'EINVAL');
  // Cancel in the dialog: nothing happens, no error.
  setState((st) => (st.conns.find((c) => c.uuid === workUuid).data['password-flags'] = '2'));
  await page.click(`${WIN} .nt-vpn[data-uuid="${workUuid}"] [data-act=toggle]`);
  await until(page, `!!document.querySelector('${DLG} #nt-cred-pass')`, 5000);
  await page.keyboard.press('Escape');
  await until(page, `!document.querySelector('${DLG}')`, 3000);
  await sleep(300);
  check('Escape cancels quietly', [await page.evaluate(`!!document.querySelector('${WIN} .nt-vpn-info .infobar.error')`), (await rows(page)).find((r) => r.name === 'work').status], [false, 'Not connected']);
});

await section('real mode: « secrets required » after connecting without asking -> dialog, then connected', async () => {
  const office = '9d3f2b77-6a10-4e8d-b2c5-71f0a9e4d302';
  setState((st) => Object.assign(st.conns.find((c) => c.uuid === office).data, { 'connection-type': 'password', 'password-flags': '0' }));
  await page.click(`${WIN} .nt-vpn[data-uuid="${office}"] [data-act=toggle]`);
  check('dialog after ENEEDAUTH', await until(page, `!!document.querySelector('${DLG} #nt-cred-pass')`, 5000), true);
  check('no error text on the first ask', await text(page, `${DLG} .nt-cred-error`), '');
  await page.fill(`${DLG} #nt-cred-user`, 'ana');
  await page.fill(`${DLG} #nt-cred-pass`, 'correct horse');
  await page.uncheck(`${DLG} #nt-cred-remember`);
  await page.click(`${DLG} .dialog-footer .btn.primary`);
  check('connected', await until(page, `${row('Office VPN')}?.querySelector('.nt-status').textContent === 'Connected · tun0'`, 6000), true);
  check('first attempt without secrets, then a passwd-file', nmLog().filter((e) => e.argv.includes('up') && e.argv.includes(office)).slice(-2).map((e) => !!e.passwd), [false, true]);
  await page.click(`${WIN} .nt-vpn[data-uuid="${office}"] [data-act=toggle]`);
  await until(page, `${row('Office VPN')}?.querySelector('.nt-status').textContent === 'Not connected'`);
  check('still no secret on a command line', argvLeaks(), []);
});

await section('real mode: import errors (plug-in, bad profile, missing file, backend validation)', async () => {
  const dir = path.join(s.home, 'Downloads', 'more');
  const before = fs.readdirSync(path.join(s.home, '.local', 'share', 'aurora', 'nettools', 'openvpn')).length;
  setState((st) => (st.noPlugin = true));
  await page.evaluate(`${hook('importPath')}(${JSON.stringify(writeProfile(dir, 'school'))})`);
  check('plug-in missing', await until(page, `document.querySelector('${WIN} .nt-vpn-info .infobar.error')?.textContent === 'The OpenVPN plug-in for NetworkManager isn’t installed (network-manager-openvpn).'`), true);
  check('private copy removed after a failed import', fs.readdirSync(path.join(s.home, '.local', 'share', 'aurora', 'nettools', 'openvpn')).length, before);
  setState((st) => (st.noPlugin = false));
  await page.evaluate(`${hook('importPath')}(${JSON.stringify(writeProfile(dir, 'noremote', { remote: '' }))})`);
  check('no remote', await until(page, `document.querySelector('${WIN} .nt-vpn-info .infobar.error')?.textContent === 'This isn’t a usable OpenVPN client profile: it has no server (“remote” line).'`), true);
  await page.evaluate(`${hook('importPath')}(${JSON.stringify(writeProfile(dir, 'lost', { ca: 'missing-ca.crt', writeCa: false }))})`);
  check('missing certificate named', await until(page, `(document.querySelector('${WIN} .nt-vpn-info .infobar.error')?.textContent || '').startsWith('Files used by the profile are missing: missing-ca.crt.')`), true);
  check('no import attempted for bad files', nmLog().filter((e) => e.argv[1] === 'import').map((e) => path.basename(e.argv[5])), ['work.ovpn', 'school.ovpn']);
  const fifoDir = path.join(dir, 'fifo');
  fs.mkdirSync(fifoDir, { recursive: true });
  const fifoProfile = writeProfile(fifoDir, 'fifo', { auth: false, extra: 'key fifo.key' });
  const mk = spawn('mkfifo', [path.join(fifoDir, 'fifo.key')]);
  await new Promise((r) => mk.on('close', r));
  const t0 = Date.now();
  const fr = await invokeRaw(page, 'nettools:vpnImport', fifoProfile);
  check('a FIFO named as key never blocks the import', [fr.error?.code, fr.error?.message, Date.now() - t0 < 3000], ['EBADREF', 'fifo.key: not a regular file', true]);
  await page.evaluate(`${hook('importPath')}(${JSON.stringify(fifoProfile)})`);
  check('EBADREF message', await until(page, `(document.querySelector('${WIN} .nt-vpn-info .infobar.error')?.textContent || '').startsWith('A file used by the profile can’t be used (fifo.key: not a regular file).')`), true);
  check('relative path refused', (await invokeRaw(page, 'nettools:vpnImport', 'work.ovpn')).error?.code, 'EINVAL');
  const big = path.join(dir, 'big.ovpn');
  fs.writeFileSync(big, 'x'.repeat(300 * 1024));
  check('oversized profile refused', (await invokeRaw(page, 'nettools:vpnImport', big)).error?.code, 'EINVAL');
  check('missing file', (await invokeRaw(page, 'nettools:vpnImport', path.join(dir, 'nope.ovpn'))).error?.code, 'ENOENT');
});

await section('real mode: drag and drop, open from Fichiers, delete', async () => {
  const conf = path.join(s.home, 'Downloads', 'travel.conf');
  fs.writeFileSync(conf, '[Interface]\nPrivateKey = x\nAddress = 10.0.0.2/32\n[Peer]\nPublicKey = y\nEndpoint = vpn.example.com:51820\nAllowedIPs = 0.0.0.0/0\n');
  await page.evaluate(`(() => {
    const panel = document.querySelector('${WIN} #nt-panel-vpn');
    const dt = new DataTransfer();
    dt.setData('application/x-aurora-paths', JSON.stringify([${JSON.stringify(conf)}]));
    panel.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }));
    window.__ntDropShown = !document.querySelector('${WIN} .nt-drop').hidden;
    panel.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
    panel.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  })()`);
  check('drop hint shown while dragging', await page.evaluate('window.__ntDropShown'), true);
  check('dropped .conf imported', await until(page, `!!${row('travel')}`), true);
  check('drop hint hidden after drop', await page.evaluate(`document.querySelector('${WIN} .nt-drop').hidden`), true);
  check('WireGuard import argv', nmLog().filter((e) => e.argv[1] === 'import').pop()?.argv, ['connection', 'import', 'type', 'wireguard', 'file', conf]);
  const home = writeProfile(path.join(s.home, 'Downloads', 'home'), 'Maison');
  await page.evaluate(`window.__aurora.shell.openFile(${JSON.stringify(home)})`);
  check('open from Fichiers asks first', await until(page, `document.querySelector('${DLG} .dialog-title')?.textContent === 'Import this VPN connection?'`, 5000), true);
  check('confirm body', (await text(page, `${DLG} .dialog-body`)).includes('“Maison.ovpn” will be added'), true);
  await page.click(`${DLG} .dialog-footer .btn.primary`);
  check('opened .ovpn imported', await until(page, `!!${row('Maison')}`), true);
  check('still one window', await page.evaluate(`document.querySelectorAll('${WIN}').length`), 1);
  await page.click(`${WIN} .nt-vpn[data-uuid] [aria-label="Delete “travel”"]`);
  await until(page, `!!document.querySelector('${DLG} .dialog-footer .btn.danger')`, 4000);
  await page.click(`${DLG} .dialog-footer .btn.danger`);
  check('deleted', await until(page, `!${row('travel')}`), true);
  check('delete argv', nmLog().filter((e) => e.argv.includes('delete')).pop()?.argv.slice(0, 3), ['connection', 'delete', 'uuid']);
  const base = path.join(s.home, '.local', 'share', 'aurora', 'nettools', 'openvpn');
  check('two private copies before deleting an OpenVPN connection', fs.readdirSync(base).sort().map((d) => d.replace(/-[0-9a-f]{8}$/, '')), ['Maison', 'work']);
  await page.click(`${WIN} .nt-vpn[data-uuid] [aria-label="Delete “Maison”"]`);
  await until(page, `!!document.querySelector('${DLG} .dialog-footer .btn.danger')`, 4000);
  await page.click(`${DLG} .dialog-footer .btn.danger`);
  check('OpenVPN connection deleted', await until(page, `!${row('Maison')}`), true);
  check('its private copy (certificates) removed, the other kept', fs.readdirSync(base).map((d) => d.replace(/-[0-9a-f]{8}$/, '')), ['work']);
  await sleep(200);
  await page.locator(WIN).screenshot({ path: path.join(OUT, 'nettools-vpn-light-en.png') });
});

await section('real mode: traceroute streams hop by hop', async () => {
  await page.click(`${WIN} #nt-tab-trace`);
  await page.fill(`${WIN} #nt-trace-host`, 'example.com');
  await page.press(`${WIN} #nt-trace-host`, 'Enter');
  check('running status', await text(page, `${WIN} #nt-panel-trace .nt-status-line`), 'Tracing the route to example.com (up to 30 hops)…');
  check('first hop before the end', await until(page, `document.querySelectorAll('${WIN} .nt-hop').length >= 1 && document.querySelector('${WIN} [data-act=trace]').disabled`, 4000), true);
  check('finished: reached', await until(page, `document.querySelector('${WIN} #nt-panel-trace .nt-status-line').textContent === 'example.com reached in 4 hops.'`, 6000), true);
  const hops = await page.evaluate(`[...document.querySelectorAll('${WIN} .nt-hop')].map((h) => ({ n: h.dataset.n, name: h.querySelector('.nt-hop-name').textContent, ip: h.querySelector('.nt-hop-ip')?.textContent || '', ms: h.querySelector('.nt-hop-ms').textContent, cls: h.className }))`);
  check('four hops, hop 1 printed twice shown once', hops.map((x) => x.n), ['1', '2', '3', '4']);
  check('hop 1', [hops[0].name, hops[0].ip, hops[0].ms], ['_gateway', '192.168.1.1', '0.50 ms']);
  check('hop 2 timeout', [hops[1].name, hops[1].ms, hops[1].cls.includes('timeout')], ['No reply', '*', true]);
  check('hop 4 reached', [hops[3].name, hops[3].cls.includes('reached'), hops[3].ms], ['example.com', true, '12.3 ms']);
  check('latency bars', await page.evaluate(`[...document.querySelectorAll('${WIN} .nt-hop-bar')].map((b) => !!b.firstChild)`), [true, false, true, true]);
  const tl = fs.readFileSync(path.join(NM, 'trace.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  check('tracepath argv', tl[0].argv, ['-b', '-m', '30', 'example.com']);
  await page.click(`${WIN} [data-act=trace-copy]`);
  await sleep(200);
  const clip = (await invokeRaw(page, 'clipboard:readText')).value || '';
  check('copied results', clip.startsWith('Route to example.com\n 1  _gateway (192.168.1.1)  0.498 ms') && clip.includes(' 2  *  *') && clip.includes('12.345 ms'), true);
  await page.selectOption(`${WIN} #nt-trace-family`, '4');
  await page.fill(`${WIN} #nt-trace-max`, '10');
  await page.fill(`${WIN} #nt-trace-host`, '2001:db8::1');
  await page.click(`${WIN} [data-act=trace]`);
  check('family mismatch in the UI', await text(page, `${WIN} #nt-panel-trace .nt-status-line`), 'This address doesn’t match the chosen protocol.');
  await page.fill(`${WIN} #nt-trace-host`, 'example.org');
  await page.click(`${WIN} [data-act=trace]`);
  await until(page, `!document.querySelector('${WIN} [data-act=trace]').disabled`, 6000);
  check('IPv4 + max hops argv', fs.readFileSync(path.join(NM, 'trace.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).pop().argv, ['-4', '-b', '-m', '10', 'example.org']);
  await page.selectOption(`${WIN} #nt-trace-family`, 'auto');
  await page.fill(`${WIN} #nt-trace-max`, '30');
  await page.fill(`${WIN} #nt-trace-host`, 'slow.example');
  await page.click(`${WIN} [data-act=trace]`);
  await until(page, `document.querySelectorAll('${WIN} .nt-hop').length >= 2`, 5000);
  await page.click(`${WIN} [data-act=trace-cancel]`);
  check('cancelled', await until(page, `document.querySelector('${WIN} #nt-panel-trace .nt-status-line').textContent === 'Cancelled.'`, 4000), true);
  const pid = fs.readFileSync(path.join(NM, 'trace.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).pop().pid;
  check('tracepath process stopped', await waitFor(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  }, 3000), true);
  const n = await page.evaluate(`document.querySelectorAll('${WIN} .nt-hop').length`);
  await sleep(600);
  check('no hop after cancel', await page.evaluate(`document.querySelectorAll('${WIN} .nt-hop').length`), n);
  await page.fill(`${WIN} #nt-trace-host`, 'nothing.invalid');
  await page.click(`${WIN} [data-act=trace]`);
  check('unknown host', await until(page, `document.querySelector('${WIN} #nt-panel-trace .nt-status-line').textContent === 'nothing.invalid doesn’t exist.'`, 4000), true);
  check('backend: option injection refused', (await invokeRaw(page, 'nettools:trace', '-n', {})).error?.code, 'EINVAL');
  check('backend: hop count range', (await invokeRaw(page, 'nettools:trace', 'example.com', { maxHops: 65 })).error?.code, 'EINVAL');
  check('backend: family mismatch', (await invokeRaw(page, 'nettools:trace', '1.2.3.4', { family: '6' })).error?.code, 'EINVAL');
  await page.fill(`${WIN} #nt-trace-host`, 'example.com');
  await page.click(`${WIN} [data-act=trace]`);
  await until(page, `document.querySelector('${WIN} #nt-panel-trace .nt-status-line').textContent === 'example.com reached in 4 hops.'`, 6000);
  await page.locator(WIN).screenshot({ path: path.join(OUT, 'nettools-trace-light-en.png') });
});

await section('real mode: port check (local listeners) and listening ports (ss)', async () => {
  await page.click(`${WIN} #nt-tab-ports`);
  check('listening ports loaded on first show', await until(page, `document.querySelectorAll('${WIN} .nt-listen-row').length === 7`, 5000), true);
  check('ss argv', JSON.parse(fs.readFileSync(path.join(NM, 'ss.jsonl'), 'utf8').trim().split('\n')[0]).argv, ['-H', '-tulpn']);
  const ls = await page.evaluate(`[...document.querySelectorAll('${WIN} .nt-listen-row')].map((r) => [r.querySelector('.nt-proto').textContent, r.dataset.port, r.querySelector('.nt-scope').textContent, r.querySelector('.nt-proc').textContent])`);
  check('node on localhost', ls.find((r) => r[1] === '5173'), ['TCP', '5173', 'This computer only', 'node (4242)']);
  check('python3 on one address', ls.find((r) => r[1] === '8000'), ['TCP', '8000', 'Address 192.168.1.20', 'python3 (5150)']);
  check('SSH on every network, process hidden', ls.filter((r) => r[1] === '22').sort(), [['TCP', '22', 'All networks · IPv6', 'hidden'], ['TCP', '22', 'All networks', 'hidden']]);
  check('count', await text(page, `${WIN} .nt-section:nth-child(2) .nt-status-line`), '7 listening ports.');
  check('hidden processes explained', await page.evaluate(`!document.querySelector('${WIN} .nt-section:nth-child(2) .nt-note').hidden`), true);
  await page.fill(`${WIN} #nt-port-host`, '127.0.0.1');
  await page.fill(`${WIN} #nt-port-list`, `${OPEN}, ${CLOSED}`);
  await page.click(`${WIN} [data-act=port-check]`);
  check('results', await until(page, `document.querySelectorAll('${WIN} .nt-port').length === 2`, 6000), true);
  const res = await page.evaluate(`[...document.querySelectorAll('${WIN} .nt-port')].map((r) => [r.dataset.port, r.dataset.status, r.querySelector('.nt-pill').textContent, r.querySelector('.nt-port-ms').textContent])`);
  check('open port + latency', [res[0][0], res[0][1], res[0][2], /^\d+([.,]\d+)? ms$/.test(res[0][3])], [String(OPEN), 'open', 'Open', true]);
  check('closed port', res[1].slice(0, 3), [String(CLOSED), 'closed', 'Closed']);
  check('summary', await text(page, `${WIN} .nt-section:nth-child(1) .nt-status-line`), '127.0.0.1: 1 of 2 ports open.');
  await page.fill(`${WIN} #nt-port-host`, 'localhost');
  await page.click(`${WIN} [data-act=port-check]`);
  check('host name resolved, IP shown', await until(page, `/^localhost \\((127\\.0\\.0\\.1|::1)\\): /.test(document.querySelector('${WIN} .nt-section:nth-child(1) .nt-status-line').textContent)`, 6000), true);
  const t0 = Date.now();
  const f = (await invokeRaw(page, 'nettools:portCheck', '192.0.2.1', [80], { timeout: 300 })).value;
  check('blackhole address: filtered (or no route), no latency', [['filtered', 'unreachable'].includes(f?.results[0].status), f?.results[0].ms], [true, null]);
  check('short timeout honoured', Date.now() - t0 < 2500, true);
  check('timeout clamped', (await invokeRaw(page, 'nettools:portCheck', '127.0.0.1', [CLOSED], { timeout: 1e9 })).value?.results[0].status, 'closed');
  await page.fill(`${WIN} #nt-port-list`, '0, 70000');
  await page.click(`${WIN} [data-act=port-check]`);
  check('invalid ports message', (await text(page, `${WIN} .nt-section:nth-child(1) .nt-status-line`)).startsWith('Enter ports from 1 to 65535'), true);
  check('aria-invalid on the ports field', await page.getAttribute(`${WIN} #nt-port-list`, 'aria-invalid'), 'true');
  check('backend: 65 ports refused', (await invokeRaw(page, 'nettools:portCheck', '127.0.0.1', '1-65')).error?.code, 'EINVAL');
  check('backend: host injection refused', (await invokeRaw(page, 'nettools:portCheck', '127.0.0.1;id', [22])).error?.code, 'EINVAL');
  await page.click(`${WIN} [data-act=services]`);
  check('common services menu', await until(page, `[...document.querySelectorAll('.menu .menu-item, .menu [role=menuitem]')].some((m) => m.textContent.includes('RDP — 3389'))`, 3000), true);
  await page.evaluate(`[...document.querySelectorAll('.menu .menu-item, .menu [role=menuitem]')].find((m) => m.textContent.includes('RDP — 3389')).click()`);
  check('menu fills the ports', await page.inputValue(`${WIN} #nt-port-list`), '3389');
  await page.fill(`${WIN} #nt-port-host`, '127.0.0.1');
  await page.fill(`${WIN} #nt-port-list`, `22, ${OPEN}, ${CLOSED}, 3389, 5900`);
  await page.click(`${WIN} [data-act=port-check]`);
  await until(page, `document.querySelectorAll('${WIN} .nt-port').length === 5`, 8000);
  await page.locator(WIN).screenshot({ path: path.join(OUT, 'nettools-ports-light-en.png') });
});

await section('real mode: speed test against the local server', async () => {
  await page.click(`${WIN} #nt-tab-speed`);
  check('data use explained', (await text(page, `${WIN} .nt-speed-note`)).includes('up to about 150\u00a0MB'), true);
  check('no history yet', await page.evaluate(`document.querySelector('${WIN} #nt-history-title').closest('section').hidden`), true);
  SP.reqs.length = 0;
  await page.click(`${WIN} [data-act=speed]`);
  check('cancel button replaces start', await page.evaluate(`[document.querySelector('${WIN} [data-act=speed]').hidden, document.querySelector('${WIN} [data-act=speed-cancel]').hidden]`), [true, false]);
  check('gauge moves during the download', await until(page, `document.querySelector('${WIN} .nt-gauge-phase').dataset.phase === 'download' && Number(document.querySelector('${WIN} .nt-gauge').getAttribute('aria-valuenow')) > 0`, 8000), true);
  check('finished', await until(page, `document.querySelector('${WIN} #nt-panel-speed .nt-status-line').classList.contains('ok')`, 15000), true);
  const vals = await page.evaluate(`Object.fromEntries([...document.querySelectorAll('${WIN} .nt-stat')].map((s) => [s.dataset.stat, s.querySelector('.nt-stat-value').textContent]))`);
  check('download ~96 Mbit/s (4 × 3 MB/s)', Number(vals.download), (v) => v >= 55 && v <= 115);
  check('upload measured', Number(vals.upload), (v) => v >= 55 && v <= 115);
  check('ping ~9 ms', Number(vals.ping), (v) => v >= 7 && v <= 16);
  check('jitter ~4 ms', Number(vals.jitter), (v) => v >= 2 && v <= 7);
  check('server line', await text(page, `${WIN} .nt-server`), 'Server: Testville, FR (TST)');
  check('status line', await text(page, `${WIN} #nt-panel-speed .nt-status-line`), `Download ${vals.download} Mbit/s, upload ${vals.upload} Mbit/s.`);
  check('requests went to the env server, sizes capped', [...new Set(SP.reqs.filter((x) => x.m === 'GET' && x.bytes).map((x) => x.bytes))], [1e5, 1e6]);
  check('history row', await page.evaluate(`document.querySelectorAll('${WIN} .nt-history-row').length`), 1);
  check('history saved in ctx.storage', (await invokeRaw(page, 'storage:get', 'nettools', 'speedHistory', [])).value?.map((r) => [r.download === Number(vals.download), r.server.colo]), [[true, 'TST']]);
  await page.locator(WIN).screenshot({ path: path.join(OUT, 'nettools-speed-light-en.png') });
  // cancel
  SP.rate = 2e5;
  await page.click(`${WIN} [data-act=speed]`);
  await until(page, `document.querySelector('${WIN} .nt-gauge-phase').dataset.phase === 'download'`, 8000);
  const busy = await invokeRaw(page, 'nettools:speed');
  check('one test at a time', busy.error?.code, 'EBUSY');
  await page.click(`${WIN} [data-act=speed-cancel]`);
  check('cancelled', await until(page, `document.querySelector('${WIN} #nt-panel-speed .nt-status-line').textContent === 'Cancelled.'`, 4000), true);
  check('start back, focus on it', await page.evaluate(`[document.querySelector('${WIN} [data-act=speed]').hidden, document.activeElement?.dataset?.act]`), [false, 'speed']);
  check('connections closed', await waitFor(() => SP.active === 0, 3000), true);
  check('history unchanged', await page.evaluate(`document.querySelectorAll('${WIN} .nt-history-row').length`), 1);
  check('previous result shown again', await page.evaluate(`document.querySelector('${WIN} .nt-stat[data-stat=download] .nt-stat-value').textContent`), vals.download);
  SP.rate = 3e6;
  check('no console errors', errors.filter((e) => !/favicon|ERR_FILE_NOT_FOUND/.test(e)), []);
});
await s.close();

// ================================================================= French, dark (mock backends)
s = await launchShell({ open: ['nettools'], lang: 'fr', theme: 'dark', env: { AURORA_NETTOOLS_PING_MS: '40', AURORA_NETTOOLS_SPEED_URL: SP.url, AURORA_NETTOOLS_SPEED_MAX: '1000000' } });
page = s.page;
await section('French + dark: OpenVPN in mock mode, strings, screenshots', async () => {
  check('window opened (fr)', await until(page, `document.querySelectorAll('${WIN} .nt-vpn').length === 2`, 20000), true);
  check('OpenVPN badge (mock)', (await rows(page))[1].badge, 'OpenVPN');
  const p = writeProfile(path.join(s.home, 'Téléchargements'), 'Bureau');
  await page.evaluate(`${hook('importPath')}(${JSON.stringify(p)})`);
  check('FR import message', await until(page, `document.querySelector('${WIN} .nt-vpn-info .infobar.success')?.textContent === '« Bureau » a été importée. Votre nom d’utilisateur et votre mot de passe vous seront demandés à la connexion.'`), true);
  await page.click(`${WIN} .nt-vpn:nth-child(1) [data-act=toggle]`);
  check('FR credentials dialog', await until(page, `document.querySelector('${DLG} .dialog-title')?.textContent === 'Connexion au VPN'`, 5000), true);
  check('FR labels', await page.evaluate(`[...document.querySelectorAll('${DLG} label')].map((l) => l.textContent)`), ['Nom d’utilisateur', 'Mot de passe', 'Mémoriser le mot de passe (conservé par NetworkManager)']);
  await page.fill(`${DLG} #nt-cred-user`, 'ana');
  await page.fill(`${DLG} #nt-cred-pass`, 'wrong');
  await page.locator('.dialog-layer:not(.closing) .dialog').screenshot({ path: path.join(OUT, 'nettools-credentials-dark-fr.png') });
  await page.click(`${DLG} .dialog-footer .btn.primary`);
  check('FR auth error', await until(page, `document.querySelector('${DLG} .nt-cred-error')?.textContent === 'Le serveur a refusé le nom d’utilisateur ou le mot de passe.'`, 5000), true);
  await page.fill(`${DLG} #nt-cred-pass`, 'right');
  await page.click(`${DLG} .dialog-footer .btn.primary`);
  check('mock connects', await until(page, `[...document.querySelectorAll('${WIN} .nt-vpn')].some((r) => r.textContent.includes('Bureau') && r.querySelector('.nt-status').textContent === 'Connecté · tun0')`, 5000), true);
  await page.locator(WIN).screenshot({ path: path.join(OUT, 'nettools-vpn-dark-fr.png') });

  await page.click(`${WIN} #nt-tab-trace`);
  await page.fill(`${WIN} #nt-trace-host`, 'example.com');
  await page.press(`${WIN} #nt-trace-host`, 'Enter');
  check('FR trace (mock route)', await until(page, `document.querySelector('${WIN} #nt-panel-trace .nt-status-line').textContent === 'example.com atteint en 7 sauts.'`, 8000), true);
  check('FR no reply', await page.evaluate(`document.querySelectorAll('${WIN} .nt-hop')[3].querySelector('.nt-hop-name').textContent`), 'Pas de réponse');
  check('FR decimal comma', await page.evaluate(`document.querySelectorAll('${WIN} .nt-hop')[0].querySelector('.nt-hop-ms').textContent`), '0,60 ms');
  await page.locator(WIN).screenshot({ path: path.join(OUT, 'nettools-trace-dark-fr.png') });

  await page.click(`${WIN} #nt-tab-ports`);
  check('FR listening (mock ss)', await until(page, `document.querySelector('${WIN} .nt-section:nth-child(2) .nt-status-line').textContent === '9 ports en écoute.'`, 5000), true);
  check('FR scope labels', await page.evaluate(`[...new Set([...document.querySelectorAll('${WIN} .nt-scope')].map((x) => x.textContent))]`), (v) => ['Tous les réseaux', 'Tous les réseaux · IPv6', 'Cet ordinateur uniquement'].every((x) => v.includes(x)));
  check('FR hidden process', await page.evaluate(`[...document.querySelectorAll('${WIN} .nt-proc')].some((x) => x.textContent === 'masqué')`), true);
  await page.fill(`${WIN} #nt-port-host`, 'nothing.invalid');
  await page.click(`${WIN} [data-act=port-check]`);
  check('FR DNS error', await until(page, `document.querySelector('${WIN} .nt-section:nth-child(1) .nt-status-line').textContent === 'nothing.invalid n’existe pas.'`, 5000), true);
  await page.fill(`${WIN} #nt-port-host`, '127.0.0.1');
  await page.fill(`${WIN} #nt-port-list`, `${OPEN}, ${CLOSED}`);
  await page.click(`${WIN} [data-act=port-check]`);
  check('FR results', await until(page, `document.querySelector('${WIN} .nt-section:nth-child(1) .nt-status-line').textContent === '127.0.0.1 : 1 port ouvert sur 2.'`, 6000), true);
  check('FR pills', await page.evaluate(`[...document.querySelectorAll('${WIN} .nt-pill')].map((p) => p.textContent)`), ['Ouvert', 'Fermé']);
  await page.locator(WIN).screenshot({ path: path.join(OUT, 'nettools-ports-dark-fr.png') });

  await page.click(`${WIN} #nt-tab-speed`);
  check('FR data note', (await text(page, `${WIN} .nt-speed-note`)).includes('cela consomme votre forfait'), true);
  await page.click(`${WIN} [data-act=speed]`);
  check('FR speed done', await until(page, `document.querySelector('${WIN} #nt-panel-speed .nt-status-line').textContent.startsWith('Réception ')`, 15000), true);
  check('FR stat labels', await page.evaluate(`[...document.querySelectorAll('${WIN} .nt-stat-label')].map((x) => x.textContent)`), ['Réception', 'Envoi', 'Latence', 'Gigue']);
  check('FR decimal comma in results', await page.evaluate(`document.querySelector('${WIN} .nt-stat[data-stat=ping] .nt-stat-value').textContent`), (v) => /^\d+,\d$/.test(v));
  check('FR server line', await text(page, `${WIN} .nt-server`), 'Serveur : Testville, FR (TST)');
  const dark = await page.evaluate(`(() => { const c = getComputedStyle(document.querySelector('${WIN} .nt-stat-value')).color.match(/\\d+/g).map(Number); return (c[0] + c[1] + c[2]) / 3; })()`);
  check('dark theme: light text', dark, (v) => v > 180);
  await page.locator(WIN).screenshot({ path: path.join(OUT, 'nettools-speed-dark-fr.png') });
  await sp.stop();
  await page.click(`${WIN} [data-act=speed]`);
  check('FR server unreachable', await until(page, `document.querySelector('${WIN} #nt-panel-speed .nt-status-line').textContent === 'Le serveur de test est injoignable. Vérifiez votre connexion à Internet.'`, 8000), true);
  check('history kept after a failure', await page.evaluate(`document.querySelectorAll('${WIN} .nt-history-row').length`), 1);
  await page.click(`${WIN} [data-act=speed-clear]`);
  await until(page, `!!document.querySelector('${DLG} .dialog-footer .btn.danger')`, 4000);
  check('FR clear confirmation', await text(page, `${DLG} .dialog-title`), 'Effacer l’historique ?');
  await page.click(`${DLG} .dialog-footer .btn.danger`);
  check('history cleared', await until(page, `document.querySelector('${WIN} #nt-history-title').closest('section').hidden`, 3000), true);
  // narrowest window: no horizontal overflow in any panel, selected tab scrolled into view
  await page.evaluate(`window.__aurora.wm.list().find((w) => w.el.classList.contains('app-nettools')).setSize(440, 560)`);
  await sleep(300);
  const overflow = [];
  for (const id of ['vpn', 'ping', 'trace', 'dns', 'ports', 'speed']) {
    await page.click(`${WIN} #nt-tab-${id}`);
    await sleep(120);
    overflow.push(await page.evaluate(`(() => { const p = document.querySelector('${WIN} #nt-panel-${id}'); return p.scrollWidth - p.clientWidth; })()`));
    if (id === 'ports' || id === 'speed' || id === 'trace') await page.locator(WIN).screenshot({ path: path.join(OUT, `nettools-${id}-narrow-dark-fr.png`) });
  }
  check('narrow window: no horizontal overflow', overflow, [0, 0, 0, 0, 0, 0]);
  check('selected last tab visible', await page.evaluate(`(() => { const t = document.querySelector('${WIN} #nt-tab-speed').getBoundingClientRect(); const l = document.querySelector('${WIN} .nt-tabs').getBoundingClientRect(); return t.right <= l.right + 1 && t.left >= l.left - 1; })()`), true);
});
await s.close();

tcpOpen.close();
fs.rmSync(NM, { recursive: true, force: true });
fs.rmSync(PASSDIR, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
process.exit(0);
