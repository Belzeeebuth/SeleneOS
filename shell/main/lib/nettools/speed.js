'use strict';
// Speed test for main/ipc/nettools.js (Outils réseau): latency + jitter, download and upload against Cloudflare's
// speed endpoints (https://speed.cloudflare.com/__down?bytes=N and POST /__up), from the main process with Node's
// http/https (no browser, no proxy settings). Progressive sizes, parallel streams, cancel through an AbortSignal.
// The base URL is overridable for tests with AURORA_NETTOOLS_SPEED_URL (http or https only), the largest request
// with AURORA_NETTOOLS_SPEED_MAX (bytes). Pure helpers (latencyStats, mbps, pickSpeed, planSizes, serverTiming,
// baseUrl) are unit-tested in test/nettools-extra.test.mjs.
const http = require('http');
const https = require('https');

const DEFAULT_BASE = 'https://speed.cloudflare.com';
const DOWN_SIZES = [100e3, 1e6, 10e6, 25e6]; // bytes per request; 4 streams -> at most 100 MB for the last phase
const UP_SIZES = [100e3, 1e6, 10e6]; // at most 40 MB
const STREAMS = 4;
const LATENCY_COUNT = 10; // + 1 warm-up request (TCP / TLS handshake) that is not counted
const PHASE_TARGET_MS = 1500; // a phase that lasts this long is long enough: no bigger size
const MIN_PHASE_MS = 250; // shorter phases are too noisy to be the result (unless they are all short)
const TOTAL_BUDGET_MS = 25000; // per direction
const REQUEST_TIMEOUT_MS = 30000;
const CHUNK = Buffer.alloc(64 * 1024);

function err(message, code) {
  const e = new Error(message);
  e.code = code;
  e.quiet = true;
  return e;
}

/** env value -> normalized base URL (no trailing slash), or the default; null when the override is not http(s). */
function baseUrl(value) {
  const raw = String(value || '').trim() || DEFAULT_BASE;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

/** Sizes not above `max` (bytes); `max` itself is the last size when it cuts the list. */
function planSizes(sizes, max) {
  const m = Number(max);
  if (!Number.isFinite(m) || m <= 0) return sizes.slice();
  const out = sizes.filter((s) => s < m);
  out.push(Math.round(Math.min(m, sizes[sizes.length - 1])));
  return out;
}

/** bytes in ms -> Mbit/s (decimal megabits, like every speed test). */
function mbps(bytes, ms) {
  if (!(ms > 0) || !(bytes >= 0)) return 0;
  return (bytes * 8) / (ms * 1000);
}

const round1 = (v) => Math.round(v * 10) / 10;
const round2 = (v) => Math.round(v * 100) / 100;

/** Latency samples (ms) -> { ping: median, jitter: mean |difference| between consecutive samples, min, max }. */
function latencyStats(samples) {
  const s = (samples || []).filter((x) => Number.isFinite(x) && x >= 0);
  if (!s.length) return { ping: null, jitter: null, min: null, max: null };
  const sorted = s.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  let jitter = 0;
  for (let i = 1; i < s.length; i++) jitter += Math.abs(s[i] - s[i - 1]);
  jitter = s.length > 1 ? jitter / (s.length - 1) : 0;
  return { ping: round2(median), jitter: round2(jitter), min: round2(sorted[0]), max: round2(sorted[sorted.length - 1]) };
}

/** Phases [{ bytes, ms }] -> Mbit/s: the fastest phase that lasted MIN_PHASE_MS, else the last (largest) phase. */
function pickSpeed(phases) {
  const ok = (phases || []).filter((p) => p && p.ms > 0);
  if (!ok.length) return null;
  const long = ok.filter((p) => p.ms >= MIN_PHASE_MS);
  const pool = long.length ? long : [ok[ok.length - 1]];
  return round1(Math.max(...pool.map((p) => mbps(p.bytes, p.ms))));
}

/** "cfRequestDuration;dur=12.5, other;dur=1" -> 12.5 (the server's own time, removed from the latency). */
function serverTiming(header) {
  const m = /(?:^|,)\s*cfRequestDuration;\s*dur=([\d.]+)/i.exec(String(header || ''));
  return m ? Number(m[1]) : 0;
}

/** Response headers -> { colo, city, country, ip } (Cloudflare's cf-meta-* headers; empty strings elsewhere). */
function serverInfo(headers) {
  const g = (k) => String(headers?.[k] || '').slice(0, 64);
  return { colo: g('cf-meta-colo'), city: g('cf-meta-city'), country: g('cf-meta-country'), ip: g('cf-meta-ip') };
}

/**
 * Run a full test. opts: { base, maxBytes, streams, signal, onProgress({ phase, progress, mbps, ping, jitter }) }
 * -> { download, upload, ping, jitter, server: { colo, city, country, host }, ip, bytes, at }
 */
async function runSpeedTest(opts = {}) {
  const base = opts.base || DEFAULT_BASE;
  const url = new URL(base);
  const lib = url.protocol === 'https:' ? https : http;
  const streams = Math.max(1, Math.min(8, Number(opts.streams) || STREAMS));
  const agent = new lib.Agent({ keepAlive: true, maxSockets: streams });
  const signal = opts.signal;
  const emit = (p) => {
    try {
      opts.onProgress?.(p);
    } catch {}
  };
  const inflight = new Set();
  const onAbort = () => inflight.forEach((r) => r.destroy(err('Cancelled', 'ECANCELED')));
  signal?.addEventListener?.('abort', onAbort);
  let totalBytes = 0;
  const checkAbort = () => {
    if (signal?.aborted) throw err('Cancelled', 'ECANCELED');
  };
  const path = (p) => `${url.pathname.replace(/\/+$/, '')}${p}`;

  // One request. onBytes(n) counts transferred bytes; resolves { status, headers, tHeaders } after the body.
  function request(method, p, { body = 0, onBytes, onHeaders } = {}) {
    return new Promise((resolve, reject) => {
      checkAbort();
      const t0 = performance.now();
      const req = lib.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || undefined,
          method,
          path: path(p),
          agent,
          headers: { 'Accept-Encoding': 'identity', 'User-Agent': 'SeleneOS-NetworkTools/1', ...(body ? { 'Content-Type': 'application/octet-stream', 'Content-Length': String(body) } : {}) },
        },
        (res) => {
          const tHeaders = performance.now() - t0;
          onHeaders?.(res, tHeaders);
          if (res.statusCode < 200 || res.statusCode >= 300) {
            res.resume();
            return reject(err(`The test server answered ${res.statusCode}`, 'EHTTP'));
          }
          res.on('data', (d) => {
            totalBytes += d.length;
            if (method === 'GET') onBytes?.(d.length);
          });
          res.on('end', () => {
            inflight.delete(req);
            resolve({ status: res.statusCode, headers: res.headers, tHeaders });
          });
          res.on('error', reject);
        },
      );
      inflight.add(req);
      req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(err('The test server stopped answering', 'ETIMEDOUT')));
      req.on('error', (e) => {
        inflight.delete(req);
        if (signal?.aborted) return reject(err('Cancelled', 'ECANCELED'));
        reject(e.code === 'ETIMEDOUT' || e.code === 'EHTTP' ? e : err(`${url.hostname}: ${e.code || e.message}`, e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN' ? 'ENOTFOUND' : 'ENET'));
      });
      if (!body) return req.end();
      let left = body;
      const pump = () => {
        while (left > 0) {
          const n = Math.min(left, CHUNK.length);
          left -= n;
          const more = req.write(n === CHUNK.length ? CHUNK : CHUNK.subarray(0, n), () => {
            totalBytes += n;
            onBytes?.(n);
          });
          if (!more) return req.once('drain', pump);
        }
        req.end();
      };
      pump();
    });
  }

  try {
    // ---- latency: sequential empty downloads on a kept-alive connection; the first one (handshake) is a warm-up.
    const samples = [];
    let server = { colo: '', city: '', country: '', ip: '' };
    for (let i = 0; i <= LATENCY_COUNT; i++) {
      checkAbort();
      const r = await request('GET', '/__down?bytes=0');
      if (i === 0) server = serverInfo(r.headers);
      else samples.push(Math.max(0, r.tHeaders - serverTiming(r.headers['server-timing'])));
      const st = latencyStats(samples);
      emit({ phase: 'latency', progress: i / LATENCY_COUNT, ping: st.ping, jitter: st.jitter });
    }
    const lat = latencyStats(samples);

    // ---- one direction: progressive sizes, `streams` parallel requests per size.
    async function direction(phase, sizes) {
      const phases = [];
      const t0 = performance.now();
      for (let i = 0; i < sizes.length; i++) {
        checkAbort();
        const size = sizes[i];
        let bytes = 0;
        const start = performance.now();
        let last = 0;
        const onBytes = (n) => {
          bytes += n;
          const now = performance.now();
          if (now - last >= 120) {
            last = now;
            const done = Math.min(1, bytes / (size * streams));
            emit({ phase, progress: Math.min(0.99, (i + done) / sizes.length), mbps: round1(mbps(bytes, now - start)) });
          }
        };
        const jobs = [];
        for (let s = 0; s < streams; s++) jobs.push(phase === 'download' ? request('GET', `/__down?bytes=${size}`, { onBytes }) : request('POST', '/__up', { body: size, onBytes }));
        await Promise.all(jobs);
        const ms = performance.now() - start;
        phases.push({ size, bytes: size * streams, ms });
        emit({ phase, progress: (i + 1) / sizes.length, mbps: round1(mbps(size * streams, ms)) });
        if (ms >= PHASE_TARGET_MS || performance.now() - t0 >= TOTAL_BUDGET_MS) break;
      }
      return { speed: pickSpeed(phases), phases };
    }

    const down = await direction('download', planSizes(DOWN_SIZES, opts.maxBytes));
    const up = await direction('upload', planSizes(UP_SIZES, opts.maxBytes));
    return {
      download: down.speed,
      upload: up.speed,
      ping: lat.ping,
      jitter: lat.jitter,
      server: { colo: server.colo, city: server.city, country: server.country, host: url.hostname },
      ip: server.ip,
      bytes: totalBytes,
      phases: { download: down.phases.map((p) => ({ size: p.size, ms: Math.round(p.ms) })), upload: up.phases.map((p) => ({ size: p.size, ms: Math.round(p.ms) })) },
      at: Date.now(),
    };
  } finally {
    signal?.removeEventListener?.('abort', onAbort);
    inflight.forEach((r) => r.destroy());
    agent.destroy();
  }
}

module.exports = { DEFAULT_BASE, DOWN_SIZES, UP_SIZES, STREAMS, LATENCY_COUNT, PHASE_TARGET_MS, MIN_PHASE_MS, baseUrl, planSizes, mbps, latencyStats, pickSpeed, serverTiming, serverInfo, runSpeedTest };
