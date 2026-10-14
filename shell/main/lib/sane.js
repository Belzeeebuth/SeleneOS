'use strict';
// SANE helpers for main/ipc/scan.js: what scanimage (sane-utils 1.2.1) prints, read into plain objects, and the
// argument vectors given to it. Pure functions, unit-tested in test/scan.unit.mjs.
//
//   LIST_FORMAT                         -f format of `scanimage -f`: fields separated by U+001F, one device per line
//   parseDeviceList(stdout)             -> [{ name, vendor, model, type }]   (the -f output; -L lines are read too)
//   describeDevice(raw)                 -> Device | null (webcams of the v4l backend: null)
//       Device = { name, label, vendor, model, type, kind: flatbed|mfp|sheetfed|film|handheld, connection: usb|network,
//                  protocol: 'eSCL'|'WSD'|null, address, backend }
//   devicesOf(stdout)                   -> [Device]  described, webcams left out, duplicates merged (dedupeDevices)
//   parseOptions(stdout)                -> { name: { name, constraint, def, inactive, bool, button } }   (`-A` output)
//   summarizeOptions(options)           -> { resolutions: { list, range, def }, modes: [{ value, kind }], mode,
//                                           sources: [{ id, value, kind, adfMode }], source,
//                                           area: { unit, width, height } | null, adfMode: bool }
//   modeKind(v) / sourceKind(v)         -> color|gray|lineart|other  /  flatbed|adf|adf-duplex|film|other
//   nearestResolution(dpi, resolutions) -> a resolution the scanner accepts (closest; ties go to the higher one)
//   previewResolution(resolutions)      -> ~75 dpi (never under 50 when the scanner can do better)
//   scanArgs(device, o)                 -> argv for scanimage (see the function)
//   errorOf(stderr, code)               -> { code: EBUSY|ECOVER|ENODOCS|EJAM|EGONE|EACCES|ENOMEM|EINVAL|ESCAN, message }
//   pngInfo(buffer)                     -> { width, height, depth, colorType, dpiX, dpiY } | null
//   validDevice(name)                   -> boolean
const SEP = '\x1f';
const LIST_FORMAT = `%d${SEP}%v${SEP}%m${SEP}%t%n`;

// ------------------------------------------------------------------ devices
function parseDeviceList(stdout) {
  const out = [];
  for (const line of String(stdout || '').split('\n')) {
    if (line.includes(SEP)) {
      const [name, vendor = '', model = '', type = ''] = line.split(SEP);
      if (name && validDevice(name)) out.push({ name, vendor: vendor.trim(), model: model.trim(), type: type.trim() });
      continue;
    }
    // `scanimage -L`: device `NAME' is a VENDOR MODEL TYPE (vendor / model / type cannot be told apart reliably)
    const m = /^device `(.+)' is a (.*)$/.exec(line.trim());
    if (m && validDevice(m[1])) out.push({ name: m[1], vendor: '', model: m[2].trim(), type: '' });
  }
  return out;
}

const isLoopback = (a) => /^(127\.|::1$|localhost$|\[::1\])/i.test(String(a || ''));
const IPV4 = /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/;

function kindOfType(type) {
  const t = String(type || '').toLowerCase();
  if (/multi-?function|all-in-one|mfp/.test(t)) return 'mfp';
  if (/sheet-?fed|document scanner/.test(t)) return 'sheetfed';
  if (/film|slide/.test(t)) return 'film';
  if (/handheld|hand-held/.test(t)) return 'handheld';
  return 'flatbed';
}

function describeDevice(raw) {
  if (!raw || !validDevice(raw.name)) return null;
  const name = raw.name;
  const backend = name.slice(0, name.indexOf(':'));
  if (backend === 'v4l') return null; // webcams (the Camera app's job)
  const clean = (s) => String(s || '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  let vendor = clean(raw.vendor);
  let model = clean(raw.model);
  const type = String(raw.type || '').trim();
  let protocol = null;
  let address = '';
  let connection = 'usb';
  let kind = kindOfType(type);
  if (backend === 'airscan') {
    // vendor = protocol (eSCL / WSD), model = the network name, type = "ip=192.168.1.42, fe80::…"
    protocol = /wsd/i.test(vendor) || /^airscan:w/i.test(name) ? 'WSD' : 'eSCL';
    address = type.replace(/^ip=/i, '').split(',')[0].trim();
    connection = isLoopback(address) ? 'usb' : 'network'; // ipp-usb shares USB scanners on localhost
    kind = 'mfp';
    vendor = '';
  } else if (backend === 'escl') {
    protocol = 'eSCL';
    const m = /^escl:(?:https?:\/\/)?(\[[^\]]+\]|[^/:]+)/i.exec(name);
    address = m ? m[1].replace(/^\[|\]$/g, '') : '';
    connection = isLoopback(address) ? 'usb' : 'network';
  } else if (backend === 'net' || /:net:|\/net\/|bjnp|[?&]ip=/i.test(name) || (IPV4.test(name) && !/libusb/i.test(name))) {
    connection = 'network';
    address = (IPV4.exec(name) || [])[1] || '';
  }
  let label = model;
  if (vendor && !model.toLowerCase().startsWith(vendor.toLowerCase())) label = `${vendor} ${model}`.trim();
  if (!label) label = name;
  return { name, label, vendor: vendor || null, model, type, kind, connection, protocol, address: address || null, backend };
}

/** One entry per scanner: the escl backend and airscan both see eSCL scanners; airscan may see eSCL and WSD. */
function dedupeDevices(list) {
  const seen = new Set();
  const air = list.filter((d) => d.backend === 'airscan');
  const out = [];
  for (const d of list) {
    if (seen.has(d.name)) continue;
    if (d.backend === 'escl' && d.address && air.some((a) => a.address === d.address)) continue;
    if (d.backend === 'airscan' && d.protocol === 'WSD' && air.some((a) => a !== d && a.protocol === 'eSCL' && (a.address === d.address || a.model === d.model))) continue;
    seen.add(d.name);
    out.push(d);
  }
  return out;
}

const devicesOf = (stdout) => dedupeDevices(parseDeviceList(stdout).map(describeDevice).filter(Boolean));

// A SANE device name: "backend:rest", printable, no leading dash (it follows --device-name= anyway).
function validDevice(name) {
  return typeof name === 'string' && name.length >= 3 && name.length <= 255 && /^[A-Za-z0-9_.+-]+:[^\x00-\x1f\x7f]*$/.test(name) && !name.startsWith('-');
}

// ------------------------------------------------------------------ options (scanimage -A)
const NUM = '-?\\d+(?:\\.\\d+)?';

function parseConstraint(text) {
  let s = String(text || '').trim();
  let auto = false;
  if (/^auto\|/i.test(s)) {
    auto = true;
    s = s.slice(5);
  }
  let m = new RegExp(`^(${NUM})\\.\\.(${NUM})([a-z%]*)(?:\\s*\\(in steps of (${NUM})\\))?$`, 'i').exec(s);
  if (m) return { type: 'range', min: Number(m[1]), max: Number(m[2]), unit: m[3] || '', step: m[4] ? Number(m[4]) : 0, auto };
  const parts = s.split('|');
  const last = new RegExp(`^(${NUM})([a-z%]*)$`, 'i').exec(parts[parts.length - 1]);
  if (last && parts.slice(0, -1).every((p) => new RegExp(`^${NUM}$`).test(p))) {
    return { type: 'numbers', values: [...parts.slice(0, -1).map(Number), Number(last[1])], unit: last[2] || '', auto };
  }
  if (/^<\w+>$/.test(s) || s === '') return { type: 'any', unit: '', auto };
  return { type: 'strings', values: parts.filter((p) => p !== ''), unit: '', auto };
}

function parseOptions(stdout) {
  const options = {};
  for (const line of String(stdout || '').split('\n')) {
    const m = /^ {4}(-[a-zA-Z]|--[A-Za-z0-9][\w-]*)(.*)$/.exec(line.replace(/\s+$/, ''));
    if (!m) continue;
    const name = m[1].replace(/^-+/, '');
    let rest = m[2];
    const opt = { name, constraint: null, def: null, inactive: false, bool: false, button: false };
    const b = /^\[=\((.*?)\)\](.*)$/.exec(rest);
    if (b) {
      opt.bool = true;
      opt.constraint = { type: 'strings', values: b[1].split('|'), unit: '', auto: false };
      rest = b[2];
    }
    const d = /^(.*?) \[(.*)\]$/.exec(rest);
    if (d) {
      rest = d[1];
      opt.def = d[2];
      if (opt.def === 'inactive') {
        opt.inactive = true;
        opt.def = null;
      }
    }
    rest = rest.trim();
    if (!opt.bool) {
      if (rest) opt.constraint = parseConstraint(rest);
      else opt.button = !d;
    }
    options[name] = opt;
  }
  return options;
}

function modeKind(v) {
  const s = String(v || '').toLowerCase();
  if (/colou?r|rgb/.test(s)) return 'color';
  if (/gr[ae]y/.test(s)) return 'gray';
  if (/lineart|line art|binary|black ?(&|and) ?white|^bw$|mono|halftone|threshold|dither/.test(s)) return 'lineart';
  return 'other';
}

function sourceKind(v) {
  const s = String(v || '').toLowerCase();
  if (/back/.test(s) && !/duplex/.test(s)) return 'other';
  if (/duplex|both sides/.test(s)) return 'adf-duplex';
  if (/adf|feeder|automatic document/.test(s)) return 'adf';
  if (/flatbed|platen|glass|document table|^normal$/.test(s)) return 'flatbed';
  if (/transparen|film|slide|tma|negative|positive/.test(s)) return 'film';
  return 'other';
}

// The value of a kind the backend prefers: "Lineart" over "Halftone", "Color" over "24bit Color[Fast]".
const PREFERRED = { color: /^colou?r$/i, gray: /^gr[ae]y$/i, lineart: /^lineart$/i };

function summarizeOptions(options) {
  const res = options.resolution && !options.resolution.inactive ? options.resolution : null;
  const resolutions = { list: null, range: null, def: null };
  if (res?.constraint?.type === 'numbers') resolutions.list = [...new Set(res.constraint.values.filter((v) => v > 0).map(Math.round))].sort((a, b) => a - b);
  else if (res?.constraint?.type === 'range') resolutions.range = { min: Math.max(1, Math.round(res.constraint.min)), max: Math.round(res.constraint.max), step: Math.max(1, Math.round(res.constraint.step || 1)) };
  if (res?.def != null && /^\d+(\.\d+)?$/.test(res.def)) resolutions.def = Math.round(Number(res.def));

  const modeOpt = options.mode && !options.mode.inactive && options.mode.constraint?.type === 'strings' ? options.mode : null;
  const modes = [];
  for (const kind of ['color', 'gray', 'lineart']) {
    const values = (modeOpt?.constraint.values || []).filter((v) => modeKind(v) === kind);
    if (values.length) modes.push({ value: values.find((v) => PREFERRED[kind].test(v)) || values[0], kind });
  }

  const srcOpt = options.source && !options.source.inactive && options.source.constraint?.type === 'strings' ? options.source : null;
  const adfModeOpt = options['adf-mode'] && options['adf-mode'].constraint?.type === 'strings' ? options['adf-mode'] : null;
  const duplexValue = adfModeOpt?.constraint.values.find((v) => /duplex/i.test(v));
  const simplexValue = adfModeOpt?.constraint.values.find((v) => /simplex/i.test(v));
  const sources = [];
  for (const value of srcOpt?.constraint.values || []) {
    const kind = sourceKind(value);
    if (kind !== 'other' && sources.some((s) => s.kind === kind)) continue;
    sources.push({ id: kind === 'other' ? `other:${value}` : kind, value, kind, adfMode: kind === 'adf' && simplexValue ? simplexValue : null });
    // epson2 / epsonds: one "Automatic Document Feeder" source and an --adf-mode Simplex|Duplex option
    if (kind === 'adf' && duplexValue && !(srcOpt.constraint.values || []).some((v) => sourceKind(v) === 'adf-duplex')) sources.push({ id: 'adf-duplex', value, kind: 'adf-duplex', adfMode: duplexValue });
  }

  const geo = (k) => (options[k] && !options[k].inactive && options[k].constraint?.type === 'range' ? options[k].constraint : null);
  const x = geo('x');
  const y = geo('y');
  const area = x && y ? { unit: x.unit === 'mm' ? 'mm' : x.unit || 'px', width: x.max, height: y.max, left: geo('l')?.max ?? x.max, top: geo('t')?.max ?? y.max } : null;
  return {
    resolutions,
    modes,
    mode: modeOpt?.def ? modeKind(modeOpt.def) : modes[0]?.kind || null,
    sources,
    source: srcOpt?.def ? sources.find((s) => s.value === srcOpt.def)?.id || null : sources[0]?.id || null,
    area,
    adfMode: !!adfModeOpt,
  };
}

function nearestResolution(dpi, r) {
  const want = Number(dpi) || 300;
  if (r?.range) {
    const { min, max, step } = r.range;
    const v = Math.min(max, Math.max(min, want));
    return Math.min(max, min + Math.round((v - min) / step) * step);
  }
  const list = r?.list || [];
  if (!list.length) return r?.def || want;
  let best = list[0];
  for (const v of list) if (Math.abs(v - want) < Math.abs(best - want) || (Math.abs(v - want) === Math.abs(best - want) && v > best)) best = v;
  return best;
}

function previewResolution(r) {
  if (r?.range) return nearestResolution(75, r);
  const list = r?.list || [];
  if (!list.length) return r?.def || 75;
  const usable = list.filter((v) => v >= 50);
  return nearestResolution(75, { list: usable.length ? usable : list });
}

// ------------------------------------------------------------------ scanning
const mm = (v) => String(Math.round(Number(v) * 100) / 100);

/**
 * argv for one scan. o = { format: 'png'|'tiff'|'jpeg', resolution, mode, source, adfMode, area: { left, top, width,
 * height } in the scanner's unit, output (file) | batch (pattern with %03d), progress }. The device always comes first
 * (backend options are only known once it is open); values are separate argv entries or --opt=value, never a shell.
 */
function scanArgs(device, o = {}) {
  const args = [`--device-name=${device}`, `--format=${o.format || 'png'}`];
  if (o.progress !== false) args.push('--progress');
  if (o.source) args.push(`--source=${o.source}`);
  if (o.adfMode) args.push(`--adf-mode=${o.adfMode}`);
  if (o.mode) args.push(`--mode=${o.mode}`);
  if (o.resolution) args.push(`--resolution=${Math.round(o.resolution)}`);
  if (o.area) args.push('-l', mm(o.area.left), '-t', mm(o.area.top), '-x', mm(o.area.width), '-y', mm(o.area.height));
  if (o.batch) args.push(`--batch=${o.batch}`, '--batch-print');
  else if (o.output) args.push(`--output-file=${o.output}`);
  return args;
}

// SANE status messages (sane_strstatus) as scanimage prints them, and its exit codes (the SANE status).
const ERRORS = [
  ['ECOVER', /cover is open/i, 8],
  ['EJAM', /jammed/i, 6],
  ['ENODOCS', /out of documents|no documents|feeder.*empty|no paper/i, 7],
  ['EBUSY', /device busy|resource busy/i, 3],
  ['EACCES', /access to resource has been denied|permission denied|access denied/i, 11],
  ['ENOMEM', /out of memory/i, 10],
  ['EGONE', /error during device i\/o|open of device .* failed: (invalid argument|no such device)|no sane devices found|device not found|disconnected/i, 9],
];

function errorOf(stderr, code) {
  const text = String(stderr || '');
  const lines = text.split(/[\r\n]+/).map((l) => l.trim()).filter((l) => l && !/^Progress:|^Scanning page|^Scanned page|^Batch terminated|received signal|trying to stop/i.test(l));
  const message = (lines.filter((l) => /^scanimage:/.test(l)).pop() || lines.pop() || `scanimage exited with status ${code}`).replace(/^scanimage:\s*/, '').slice(0, 300);
  for (const [c, re] of ERRORS) if (re.test(text)) return { code: c, message };
  for (const [c, , status] of ERRORS) if (status === code) return { code: c, message };
  if (code === 4 || /invalid argument|setting of option .* failed|value for --/i.test(text)) return { code: 'EINVAL', message };
  return { code: 'ESCAN', message };
}

/** Size and pixel density of a PNG (pHYs in pixels per metre), from its first bytes. */
function pngInfo(buf) {
  if (!buf || buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47 || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  const info = { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), depth: buf[24], colorType: buf[25], dpiX: null, dpiY: null };
  for (let p = 8; p + 8 <= buf.length; ) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    if (type === 'pHYs' && p + 17 <= buf.length && buf[p + 16] === 1) {
      // pixels per metre back to dots per inch: 150 dpi is stored as 5906 (150.0124)
      const dpiOf = (ppm) => {
        const v = ppm * 0.0254;
        return Math.abs(v - Math.round(v)) < 0.05 ? Math.round(v) : Math.round(v * 100) / 100;
      };
      info.dpiX = dpiOf(buf.readUInt32BE(p + 8));
      info.dpiY = dpiOf(buf.readUInt32BE(p + 12));
    }
    if (type === 'IDAT' || type === 'IEND') break;
    p += 12 + len;
  }
  return info;
}

module.exports = {
  LIST_FORMAT,
  parseDeviceList,
  describeDevice,
  dedupeDevices,
  devicesOf,
  validDevice,
  parseConstraint,
  parseOptions,
  summarizeOptions,
  modeKind,
  sourceKind,
  nearestResolution,
  previewResolution,
  scanArgs,
  errorOf,
  pngInfo,
};
