'use strict';
// CUPS / Avahi output parsers and print-option validation for main/ipc/printers.js (pure: no I/O, unit-tested
// by test/printers.unit.mjs). All outputs are the C-locale (LC_ALL=C) texts of CUPS 2.4 and avahi-utils 0.8.
//
//   parseLpstatPrinters(text)  `lpstat -l -p`  -> [{ name, state: idle|printing|paused, message, reasons[], description,
//                                                   location, job }]
//   parseLpstatDefault(text)   `lpstat -d`     -> name | null
//   parseLpstatDevices(text)   `lpstat -v`     -> { name: uri }
//   parseLpstatAccepting(text) `lpstat -a`     -> { name: bool }
//   parseLpstatJobs(text)      `lpstat -o`     -> [{ id, printer, number, user, size, date }]
//   parseLpq(text)             `lpq -a`        -> { number: { rank, title } }
//   parseLpinfo(text)          `lpinfo -l -v`  -> [{ uri, cls, info, model, deviceId, location }]
//   parseAvahiBrowse(text)     `avahi-browse -rtp _ipp._tcp` (+ _ipps._tcp) -> resolved services
//   parseIppAttributes(text)   `ipptool -tv … get-printer-attributes.test` -> { attribute: [values] }
//   markersOf(attrs)           marker-names / -levels / -colors / -types -> [{ name, level, color, type }]
//   summarize(...)             one printer object per queue (state, ink, reasons said simply)
//   discoveredPrinters(...)    avahi + lpinfo results -> addable printers (driverless IPP Everywhere), deduplicated
//   lpArgs(file, options)      validated `lp` argv for printers:print
const QUEUE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
const JOB_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}-[1-9][0-9]{0,9}$/;
// Device URIs a driverless (IPP Everywhere) queue can use. Same pattern as aurora-admin's printer-add.
const URI_RE = /^(ipp|ipps|dnssd):\/\/[A-Za-z0-9._~%:/?=&+@[\]-]{1,480}$/;
const INFO_RE = /^[^\x00-\x1f\x7f"\\]{1,127}$/;
// aurora-admin checks a label's length in BYTES (bash ${#v} under LC_ALL=C): « Imprimante de l’étage » is 21
// characters but 24 bytes. Same limit here, in UTF-8 bytes.
const LABEL_MAX_BYTES = 127;
const labelBytes = (s) => Buffer.byteLength(String(s), 'utf8');

const validQueue = (n) => typeof n === 'string' && QUEUE_RE.test(n);
const validJob = (j) => typeof j === 'string' && JOB_RE.test(j);
const validUri = (u) => typeof u === 'string' && URI_RE.test(u) && !/\s/.test(u);
const validInfo = (s) => typeof s === 'string' && INFO_RE.test(s) && s.trim() === s && labelBytes(s) <= LABEL_MAX_BYTES;
/** Cut a label to LABEL_MAX_BYTES UTF-8 bytes without splitting a character. */
function fitLabel(s) {
  let out = String(s || '').trim();
  while (labelBytes(out) > LABEL_MAX_BYTES) out = [...out].slice(0, -1).join('');
  return out.trim();
}

const lines = (text) => String(text || '').split('\n');

function parseLpstatPrinters(text) {
  const out = [];
  let cur = null;
  let inMessage = false;
  for (const raw of lines(text)) {
    const line = raw.replace(/\r$/, '');
    // "printer NAME is idle.  enabled since …" | "printer NAME now printing NAME-12.  enabled since …"
    // | "printer NAME disabled since … -"
    const m = /^printer (\S+) (?:is (idle)\.|(?:is )?now (printing) (\S+-\d+)\.|(disabled) since)/.exec(line);
    if (m) {
      cur = { name: m[1], state: m[2] ? 'idle' : m[3] ? 'printing' : 'paused', job: m[4] || null, message: '', reasons: [], description: '', location: '' };
      out.push(cur);
      inMessage = true;
      continue;
    }
    if (!cur) continue;
    // The printer-state-message comes right after the status line, on a line of its own (one tab).
    const f = /^\t([A-Za-z][A-Za-z ]*?):\s?(.*)$/.exec(line);
    if (f && /^(Form mounted|Content types|Printer types|Description|Alerts|Location|Connection|Interface|On fault|After fault|Users allowed|Users denied|Forms allowed|Banner required|Charset sets|Default pitch|Default page size|Default port settings)$/.test(f[1])) {
      inMessage = false;
      if (f[1] === 'Description') cur.description = f[2].trim();
      else if (f[1] === 'Location') cur.location = f[2].trim();
      else if (f[1] === 'Alerts') cur.reasons = f[2].trim() && f[2].trim() !== 'none' ? f[2].trim().split(/\s+/) : [];
      continue;
    }
    if (inMessage && /^\t\S/.test(line)) {
      cur.message = cur.message ? `${cur.message} ${line.trim()}` : line.trim();
      continue;
    }
    inMessage = false;
  }
  return out;
}

function parseLpstatDefault(text) {
  const m = /^system default destination: (\S+)/m.exec(String(text || ''));
  return m ? m[1] : null;
}

function parseLpstatDevices(text) {
  const out = {};
  for (const line of lines(text)) {
    const m = /^device for (\S+): (\S+)\s*$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function parseLpstatAccepting(text) {
  const out = {};
  for (const line of lines(text)) {
    const m = /^(\S+) (not )?accepting requests/.exec(line);
    if (m) out[m[1]] = !m[2];
  }
  return out;
}

// "Office-12            anna            102400   Tue 13 Oct 2026 10:05:00 AM CEST"
function parseLpstatJobs(text) {
  const out = [];
  for (const line of lines(text)) {
    const m = /^(\S+)-(\d+)\s+(\S+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    out.push({ id: `${m[1]}-${m[2]}`, printer: m[1], number: Number(m[2]), user: m[3], size: Number(m[4]), date: m[5] });
  }
  return out;
}

// "Rank    Owner   Job     File(s)                         Total Size" then
// "active  anna    12      rapport.pdf                     102400 bytes"
function parseLpq(text) {
  const out = {};
  for (const line of lines(text)) {
    const m = /^(active|\d+(?:st|nd|rd|th))\s+(\S+)\s+(\d+)\s+(.*?)\s+(\d+) bytes\s*$/.exec(line);
    if (m) out[m[3]] = { rank: m[1], owner: m[2], title: m[4].trim() };
  }
  return out;
}

function parseLpinfo(text) {
  const out = [];
  let cur = null;
  for (const line of lines(text)) {
    const d = /^Device: uri = (\S+)\s*$/.exec(line);
    if (d) {
      cur = { uri: d[1], cls: '', info: '', model: '', deviceId: '', location: '' };
      out.push(cur);
      continue;
    }
    const f = /^\s+(class|info|make-and-model|device-id|location) = ?(.*)$/.exec(line);
    if (f && cur) cur[{ class: 'cls', info: 'info', 'make-and-model': 'model', 'device-id': 'deviceId', location: 'location' }[f[1]]] = f[2].trim();
  }
  return out;
}

/** avahi_escape_label: "\." "\\" and "\DDD" (decimal) escapes. */
function unescapeAvahi(s) {
  return String(s).replace(/\\(\d{3}|.)/g, (_, x) => (x.length === 3 ? String.fromCharCode(Number(x)) : x));
}

/** TXT records as avahi-browse -p prints them: "key=value" "key2=value2" */
function parseTxt(s) {
  const txt = {};
  const re = /"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(String(s || '')))) {
    const kv = m[1].replace(/\\(.)/g, '$1');
    const i = kv.indexOf('=');
    if (i > 0) txt[kv.slice(0, i).toLowerCase()] = kv.slice(i + 1);
  }
  return txt;
}

// Resolved lines: "=;eth0;IPv4;HP\032LaserJet\032M110w;_ipp._tcp;local;HPLJ.local;192.168.1.20;631;"txtvers=1" …"
function parseAvahiBrowse(text) {
  const out = [];
  for (const line of lines(text)) {
    if (!line.startsWith('=;')) continue;
    const parts = line.split(';');
    if (parts.length < 9) continue;
    const [, iface, proto, name, type, domain, host, address, port] = parts;
    const txt = parseTxt(parts.slice(9).join(';'));
    out.push({ iface, proto, name: unescapeAvahi(name), type, domain, host, address, port: Number(port), txt });
  }
  return out;
}

/** CUPS's dnssd URI for a service ("dnssd://HP%20LaserJet._ipp._tcp.local/?uuid=…"). */
function dnssdUri(name, type, domain, uuid) {
  const enc = encodeURIComponent(name).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `dnssd://${enc}.${type}.${domain || 'local'}/${uuid ? `?uuid=${encodeURIComponent(uuid)}` : ''}`;
}

/** Queue name from a model / service name: "HP LaserJet M110w [4F2A1B]" -> "HP_LaserJet_M110w". Unique among `taken`. */
function queueName(label, taken = []) {
  let base = String(label || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s*\[[^\]]*\]\s*$/, '')
    .replace(/[^A-Za-z0-9_.-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_.-]+|[_.-]+$/g, '')
    .slice(0, 40);
  if (!validQueue(base)) base = 'Imprimante';
  const used = new Set(taken.map((n) => n.toLowerCase()));
  let name = base;
  for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base}_${i}`;
  return name;
}

// ipptool -tv: "        marker-levels (1setOf integer) = 80,60,55,40"
function parseIppAttributes(text) {
  const out = {};
  for (const line of lines(text)) {
    const m = /^\s+([a-z][a-z0-9-]*) \(([^)]+)\) = (.*)$/.exec(line);
    if (!m) continue;
    out[m[1]] = /^1setOf/.test(m[2]) ? m[3].split(',') : [m[3]];
  }
  return out;
}

function markersOf(attrs = {}) {
  const names = attrs['marker-names'] || [];
  const levels = attrs['marker-levels'] || [];
  const colors = attrs['marker-colors'] || [];
  const types = attrs['marker-types'] || [];
  const out = [];
  for (let i = 0; i < names.length; i++) {
    const lv = Number(levels[i]);
    // -1 = unavailable, -2 = unknown, -3 = "some remaining" (no exact level)
    out.push({ name: names[i].trim(), level: Number.isFinite(lv) && lv >= 0 ? Math.min(100, lv) : lv === -3 ? -3 : null, color: /^#[0-9A-Fa-f]{6}/.test(colors[i] || '') ? colors[i].slice(0, 7) : null, type: (types[i] || '').trim() });
  }
  return out;
}

// printer-state-reasons that matter to a person (suffixes -error / -warning / -report are dropped).
const REASONS = ['media-empty', 'media-jam', 'media-needed', 'toner-low', 'toner-empty', 'marker-supply-low', 'marker-supply-empty', 'cover-open', 'door-open', 'offline', 'connecting-to-device', 'paused', 'stopped', 'shutdown', 'other', 'cups-missing-filter', 'cups-insecure-filter', 'input-tray-missing', 'output-area-full', 'spool-area-full', 'timed-out'];
function reasonsOf(list = []) {
  const out = [];
  for (const r of list) {
    const base = r.replace(/-(error|warning|report)$/, '');
    if (base === 'none' || base === 'paused') continue;
    if (REASONS.includes(base) && !out.includes(base)) out.push(base);
  }
  return out;
}

/**
 * One object per queue: { name, label, description, location, uri, connection, isDefault, state, accepting, message,
 *   reasons, error, jobs, markers }. state: idle | printing | paused | error | offline.
 */
function summarize({ printers = [], def = null, devices = {}, accepting = {}, jobs = [], markers = {} }) {
  return printers.map((p) => {
    const reasons = reasonsOf(p.reasons);
    const uri = devices[p.name] || '';
    let state = p.state;
    const hardError = p.reasons.some((r) => /-error$/.test(r)) || reasons.some((r) => ['media-jam', 'cover-open', 'door-open', 'media-empty', 'toner-empty', 'marker-supply-empty', 'cups-missing-filter', 'stopped'].includes(r));
    if (reasons.includes('offline') || reasons.includes('timed-out')) state = state === 'paused' ? 'paused' : 'offline';
    else if (hardError && state !== 'paused') state = 'error';
    return {
      name: p.name,
      label: p.description || p.name,
      description: p.description,
      location: p.location,
      uri,
      connection: /^usb:/.test(uri) || /localhost|127\.0\.0\.1|\[::1\]/.test(uri) ? 'usb' : uri ? 'network' : null,
      isDefault: p.name === def,
      state,
      accepting: accepting[p.name] !== false,
      message: p.message,
      reasons,
      jobs: jobs.filter((j) => j.printer === p.name).length,
      markers: markers[p.name] || [],
    };
  });
}

/**
 * Addable printers from DNS-SD (avahi-browse) and `lpinfo` (when CUPS lets this user list devices).
 * IPP services become driverless IPP Everywhere candidates; lpinfo usb:// devices without IPP are listed as
 * needing a driver (not addable here). Printers that already have a queue (same URI or UUID) are left out.
 */
function discoveredPrinters({ services = [], lpinfo = [], queues = [] } = {}) {
  const takenUris = new Set(queues.map((q) => q.uri).filter(Boolean));
  const takenUuids = new Set(queues.map((q) => /[?&]uuid=([0-9a-fA-F-]{8,})/.exec(q.uri || '')?.[1]?.toLowerCase()).filter(Boolean));
  // Queues made with a plain ipp:// address (host:port): an ipp-usb printer is ipp://localhost:60000/…
  const LOOP = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
  const takenHosts = new Set();
  for (const q of queues) {
    const m = /^ipps?:\/\/(\[[^\]]+\]|[^/:?]+)(?::(\d+))?/i.exec(q.uri || '');
    if (m) takenHosts.add(`${LOOP.has(m[1].toLowerCase()) ? 'loopback' : m[1].toLowerCase().replace(/\.$/, '')}:${m[2] || 631}`);
  }
  const hostTaken = (s) => [s.iface === 'lo' || LOOP.has(s.address) ? 'loopback' : null, (s.host || '').toLowerCase().replace(/\.$/, ''), (s.address || '').toLowerCase()].some((h) => h && takenHosts.has(`${h}:${s.port}`));
  const byKey = new Map();
  for (const s of services) {
    if (!/^_ipps?\._tcp$/.test(s.type) || hostTaken(s)) continue;
    const uuid = (s.txt.uuid || '').toLowerCase();
    const key = uuid || s.name.toLowerCase();
    const prev = byKey.get(key);
    // One entry per printer: IPPS preferred over IPP, a real interface over loopback (ipp-usb) only when both exist.
    if (prev && !(s.type === '_ipps._tcp' && prev.type === '_ipp._tcp')) continue;
    const model = (s.txt.ty || s.txt.product || '').replace(/^\((.*)\)$/, '$1').trim();
    byKey.set(key, {
      key,
      type: s.type,
      uri: dnssdUri(s.name, s.type, s.domain, s.txt.uuid),
      info: s.name,
      model: model || s.name,
      location: s.txt.note || '',
      host: s.host,
      address: s.address,
      connection: s.iface === 'lo' || /^(127\.|::1$)/.test(s.address) ? 'usb' : 'network',
      uuid,
      driverless: true,
      color: s.txt.color === 'T' ? true : s.txt.color === 'F' ? false : null,
      duplex: s.txt.duplex === 'T' ? true : s.txt.duplex === 'F' ? false : null,
    });
  }
  for (const d of lpinfo) {
    const uuid = (/[?&]uuid=([0-9a-fA-F-]{8,})/.exec(d.uri)?.[1] || '').toLowerCase();
    if (/^dnssd:/.test(d.uri)) {
      const key = uuid || decodeURIComponent(/^dnssd:\/\/([^/]+?)\._ipps?\._tcp/.exec(d.uri)?.[1] || d.info).toLowerCase();
      if (byKey.has(key)) continue;
      byKey.set(key, { key, type: /\._ipps\._tcp/.test(d.uri) ? '_ipps._tcp' : '_ipp._tcp', uri: d.uri, info: d.info, model: d.model || d.info, location: d.location, host: '', address: '', connection: 'network', uuid, driverless: true, color: null, duplex: null });
    } else if (/^usb:/.test(d.uri)) {
      // An IPP-over-USB printer is also announced by ipp-usb on the loopback interface: keep that one.
      const model = (d.model || d.info).toLowerCase();
      if ([...byKey.values()].some((x) => x.connection === 'usb' && x.model.toLowerCase() === model)) continue;
      byKey.set(`usb:${d.uri}`, { key: `usb:${d.uri}`, type: 'usb', uri: d.uri, info: d.info, model: d.model || d.info, location: '', host: '', address: '', connection: 'usb', uuid, driverless: false, color: null, duplex: null });
    }
  }
  const taken = queues.map((q) => q.name);
  const out = [];
  for (const p of byKey.values()) {
    if (takenUris.has(p.uri) || (p.uuid && takenUuids.has(p.uuid))) continue;
    if (p.driverless && !validUri(p.uri)) continue;
    const queue = queueName(p.model || p.info, taken);
    taken.push(queue);
    const info = fitLabel((p.model || p.info).replace(/[\x00-\x1f\x7f"\\]/g, '')) || queue;
    out.push({ ...p, queue, label: info });
  }
  out.sort((a, b) => Number(b.driverless) - Number(a.driverless) || a.label.localeCompare(b.label));
  return out;
}

// ------------------------------------------------------------------ printers:print options -> lp argv
const SIDES = { 'one-sided': 'one-sided', 'two-sided-long-edge': 'two-sided-long-edge', 'two-sided-short-edge': 'two-sided-short-edge', long: 'two-sided-long-edge', short: 'two-sided-short-edge' };
const ORIENT = { portrait: '3', landscape: '4', 'reverse-landscape': '5', 'reverse-portrait': '6' };
const MEDIA = { a4: 'A4', a5: 'A5', a3: 'A3', letter: 'Letter', legal: 'Legal' };

function bad(message) {
  const e = new Error(message);
  e.code = 'EINVAL';
  return e;
}

/** "1-3, 5" -> "1-3,5"; null when empty; throws EINVAL on anything else. */
function pageRanges(s) {
  if (s == null || s === '') return null;
  if (typeof s !== 'string' || s.length > 200) throw bad('Invalid page range');
  const parts = s
    .replace(/[–—]/g, '-')
    .split(',')
    .map((p) => p.replace(/\s+/g, ''))
    .filter(Boolean);
  if (!parts.length || parts.length > 50) throw bad('Invalid page range');
  for (const p of parts) {
    const m = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(p);
    if (!m || Number(m[1]) < 1 || (m[2] && Number(m[2]) < Number(m[1]))) throw bad(`Invalid page range: ${p}`);
  }
  return parts.join(',');
}

/**
 * `lp` argv for printers:print. options: { printer, copies 1–999, pages "1-3,5", duplex (true | false | 'long' | 'short' |
 * a CUPS sides value) or sides, orientation ('portrait' | 'landscape' | …) or landscape (bool), media / pageSize
 * ('A4' | 'A5' | 'A3' | 'Letter' | 'Legal'), color ('color' | 'monochrome' | bool), collate (bool), fitToPage (bool),
 * title }. Throws EINVAL. The file is the last argument, after "--".
 */
function lpArgs(file, o = {}) {
  if (!o || typeof o !== 'object') throw bad('Invalid print options');
  const args = [];
  if (o.printer != null && o.printer !== '') {
    if (!validQueue(o.printer)) throw bad('Invalid printer name');
    args.push('-d', o.printer);
  }
  if (o.copies != null && o.copies !== '') {
    const n = Number(o.copies);
    if (!Number.isInteger(n) || n < 1 || n > 999) throw bad('Invalid number of copies');
    args.push('-n', String(n));
  }
  if (o.title != null && o.title !== '') {
    if (typeof o.title !== 'string' || o.title.length > 255 || /[\x00-\x1f\x7f]/.test(o.title)) throw bad('Invalid title');
    args.push('-t', o.title);
  }
  const ranges = pageRanges(o.pages ?? o.pageRanges);
  if (ranges) args.push('-o', `page-ranges=${ranges}`);
  let sides = o.sides ?? o.duplex;
  if (sides === true) sides = o.landscape === true || o.orientation === 'landscape' ? 'short' : 'long';
  if (sides === false) sides = 'one-sided';
  if (sides != null && sides !== '') {
    if (!Object.prototype.hasOwnProperty.call(SIDES, sides)) throw bad('Invalid duplex mode');
    args.push('-o', `sides=${SIDES[sides]}`);
  }
  const orientation = o.orientation ?? (o.landscape === true ? 'landscape' : o.landscape === false ? 'portrait' : null);
  if (orientation != null && orientation !== '') {
    if (!Object.prototype.hasOwnProperty.call(ORIENT, orientation)) throw bad('Invalid orientation');
    args.push('-o', `orientation-requested=${ORIENT[orientation]}`);
  }
  const media = o.media ?? o.pageSize ?? o.paper;
  if (media != null && media !== '') {
    const m = typeof media === 'string' && Object.prototype.hasOwnProperty.call(MEDIA, media.toLowerCase()) ? MEDIA[media.toLowerCase()] : null;
    if (!m) throw bad('Invalid paper size');
    args.push('-o', `media=${m}`);
  }
  if (o.color != null && o.color !== '') {
    const c = o.color === true || o.color === 'color' ? 'color' : o.color === false || o.color === 'monochrome' ? 'monochrome' : null;
    if (!c) throw bad('Invalid color mode');
    args.push('-o', `print-color-mode=${c}`);
  }
  if (o.collate != null) args.push('-o', `collate=${o.collate ? 'true' : 'false'}`);
  if (o.fitToPage === true) args.push('-o', 'fit-to-page');
  args.push('--', file);
  return args;
}

/** "request id is Office-12 (1 file(s))" -> "Office-12" */
function parseRequestId(text) {
  return /request id is (\S+)/.exec(String(text || ''))?.[1] || null;
}

module.exports = {
  QUEUE_RE,
  URI_RE,
  LABEL_MAX_BYTES,
  labelBytes,
  fitLabel,
  validQueue,
  validJob,
  validUri,
  validInfo,
  parseLpstatPrinters,
  parseLpstatDefault,
  parseLpstatDevices,
  parseLpstatAccepting,
  parseLpstatJobs,
  parseLpq,
  parseLpinfo,
  parseAvahiBrowse,
  unescapeAvahi,
  dnssdUri,
  queueName,
  parseIppAttributes,
  markersOf,
  reasonsOf,
  summarize,
  discoveredPrinters,
  pageRanges,
  lpArgs,
  parseRequestId,
};
