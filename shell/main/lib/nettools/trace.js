'use strict';
// Traceroute helpers for main/ipc/nettools.js: tracepath (iputils-tracepath, the image's tool, no root) and
// traceroute (UDP, no root) output parsers, argument vectors and the dev/test mock route. Pure functions.

/**
 * One tracepath line (run with -b: "name (ip)") -> { n, host, ip, ms: [number], timeouts, reached, note } | { summary } | null.
 *   " 1?: [LOCALHOST]                      pmtu 1500"         -> null (local probe)
 *   " 1:  _gateway (192.168.1.1)                   0.512ms "  -> hop 1
 *   " 3:  no reply"                                          -> hop 3 timeout
 *   " 9:  example.com (93.184.215.14)              12.345ms reached"
 *   "     Resume: pmtu 1500 hops 9 back 9 "                  -> { summary: { hops: 9, reached: true } }
 *   "     Too many hops: pmtu 1500"                           -> { summary: { reached: false } }
 */
function parseTracepathLine(line) {
  const s = String(line || '');
  let m = /^\s*Resume:\s*pmtu\s+\d+(?:\s+hops\s+(\d+))?/i.exec(s);
  if (m) return { summary: { hops: m[1] ? Number(m[1]) : null, reached: !!m[1] } };
  if (/^\s*Too many hops/i.test(s)) return { summary: { hops: null, reached: false } };
  m = /^\s*(\d+)\??:\s+(.*)$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  const rest = m[2].trim();
  if (/^\[LOCALHOST\]/i.test(rest)) return null;
  if (/^no reply/i.test(rest)) return { n, host: '', ip: '', ms: [], timeouts: 1, reached: false, note: '' };
  if (/^send failed/i.test(rest)) return { n, host: '', ip: '', ms: [], timeouts: 1, reached: false, note: 'send failed' };
  m = /^(\S+)(?:\s+\(([^)]+)\))?\s+([\d.]+)\s*ms\b\s*(.*)$/.exec(rest);
  if (!m) {
    const only = /^(\S+)(?:\s+\(([^)]+)\))?/.exec(rest);
    if (!only) return null;
    const ip = only[2] || only[1];
    return { n, host: only[2] && only[1] !== only[2] ? only[1] : '', ip, ms: [], timeouts: 0, reached: /\breached\b/.test(rest), note: '' };
  }
  const ip = m[2] || m[1];
  const host = m[2] && m[1] !== m[2] ? m[1] : '';
  const tail = m[4] || '';
  const note = (/\b(asymm\s+\d+|pmtu\s+\d+)\b/.exec(tail) || [])[1] || '';
  return { n, host, ip, ms: [Number(m[3])], timeouts: 0, reached: /\breached\b/.test(tail), note: note.replace(/\s+/g, ' ') };
}

/**
 * One traceroute line -> hop | { header: { host, ip, max } } | null.
 *   "traceroute to example.com (93.184.215.14), 30 hops max, 60 byte packets"
 *   " 1  _gateway (192.168.1.1)  0.426 ms  0.398 ms  0.377 ms"
 *   " 2  * * *"
 *   " 3  10.0.0.1 (10.0.0.1)  5.123 ms * 5.301 ms"
 */
function parseTracerouteLine(line) {
  const s = String(line || '');
  let m = /^traceroute6? to (\S+) \(([^)]+)\),\s*(\d+) hops max/i.exec(s.trim());
  if (m) return { header: { host: m[1], ip: m[2], max: Number(m[3]) } };
  m = /^\s*(\d+)\s+(.*)$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  const tok = m[2].trim().split(/\s+/);
  let host = '';
  let ip = '';
  const ms = [];
  let timeouts = 0;
  let note = '';
  for (let i = 0; i < tok.length; i++) {
    const t = tok[i];
    if (t === '*') timeouts++;
    else if (/^[\d.]+$/.test(t) && tok[i + 1] === 'ms') {
      ms.push(Number(t));
      i++;
    } else if (/^!/.test(t)) note = t;
    else if (/^\(.+\)$/.test(t)) {
      if (!ip) ip = t.slice(1, -1);
    } else if (!host && !ip) host = t;
  }
  if (!ip && host) ip = host;
  if (host === ip) host = '';
  return { n, host, ip, ms, timeouts, reached: false, note };
}

/** Argument vector: tracepath [-4|-6] -b -m <max> <host>  |  traceroute [-4|-6] -q 3 -w 2 -m <max> <host> */
function traceArgs(tool, host, { maxHops = 30, family = 'auto' } = {}) {
  const fam = family === '4' ? ['-4'] : family === '6' ? ['-6'] : [];
  if (tool === 'traceroute') return [...fam, '-q', '3', '-w', '2', '-m', String(maxHops), host];
  return [...fam, '-b', '-m', String(maxHops), host];
}

/** Dev / tests (no real network): a plausible route. */
function mockRoute(host, kind, maxHops) {
  const lower = host.toLowerCase();
  if (lower.endsWith('.invalid')) return { error: `${host}: Name or service not known`, hops: [] };
  const ip = kind === 'hostname' ? (lower === 'localhost' ? '127.0.0.1' : '93.184.215.14') : host;
  if (ip === '127.0.0.1' || ip === '::1') return { hops: [{ n: 1, host: 'localhost', ip, ms: [0.05], timeouts: 0, reached: true, note: '' }], reached: true };
  const unreachable = host === '192.0.2.1' || lower === 'unreachable.test';
  const path = [
    { host: '_gateway', ip: '192.168.1.1', ms: 0.6 },
    { host: '', ip: '10.10.0.1', ms: 4.2 },
    { host: 'lyon-core1.example.net', ip: '203.0.113.9', ms: 7.8 },
    null,
    { host: 'par-ix.example.net', ip: '198.51.100.20', ms: 11.4 },
    { host: 'edge1.example.org', ip: '198.51.100.77', ms: 12.1 },
  ];
  const hops = [];
  for (let i = 0; i < maxHops; i++) {
    const n = i + 1;
    const p = path[i];
    if (i < path.length) {
      hops.push(p ? { n, host: p.host, ip: p.ip, ms: [p.ms], timeouts: 0, reached: false, note: '' } : { n, host: '', ip: '', ms: [], timeouts: 1, reached: false, note: '' });
      continue;
    }
    if (unreachable) {
      hops.push({ n, host: '', ip: '', ms: [], timeouts: 1, reached: false, note: '' });
      continue;
    }
    hops.push({ n, host: kind === 'hostname' ? host : '', ip, ms: [12.4], timeouts: 0, reached: true, note: '' });
    return { hops, reached: true };
  }
  return { hops, reached: false };
}

module.exports = { parseTracepathLine, parseTracerouteLine, traceArgs, mockRoute };
