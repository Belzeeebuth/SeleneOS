'use strict';
// Drive health (SMART) for the Disks app: pure code used by main/ipc/disks.js and the tests. No IPC channels here
// (the ipc loader skips modules without a register function).
//
// Sources, in this order:
//   1. udisks2 over D-Bus, read with `busctl --system --json=short …` (systemd; an argument vector, never a shell):
//      org.freedesktop.UDisks2.Drive.Ata (ATA / SATA disks, libatasmart) and org.freedesktop.UDisks2.NVMe.Controller
//      (udisks 2.10, libblockdev-nvme). Reading the cached properties and SmartGetAttributes needs no authorization;
//      SmartUpdate is allowed for the active session's user (polkit org.freedesktop.udisks2.{ata,nvme}-smart-update:
//      allow_active yes). Self-tests need org.freedesktop.udisks2.{ata,nvme}-smart-selftest (auth_admin_keep), which
//      rootfs/etc/polkit-1/rules.d/50-aurora.rules grants to administrators in an active local session.
//   2. smartctl -j -a, only through aurora-admin smart-info (administrator prompt) and only for drives udisks has no
//      health data for (USB enclosures whose bridge only smartctl knows, SAS / SCSI disks).
//
// Health = {
//   device, key, source: 'udisks'|'smartctl'|null, kind: 'ata'|'nvme'|'scsi'|null, rotational, updated (ms|null),
//   status: 'good'|'warning'|'failing'|'unknown',
//   reason (unknown only): 'usb'|'virtual'|'card'|'optical'|'unsupported'|'disabled'|'asleep'|'noService'|'noData'|'other',
//   detail (error text|null), asleep (true: cached data of a sleeping disk, nothing was woken up),
//   problems: [{ code, level: 'failing'|'warning'|'info', …values }]   (codes: see assessAta / assessNvme)
//   temperature (°C|null), powerOnHours, powerCycles,
//   ssd: { used %, spare %, spareThreshold %, mediaErrors, unsafeShutdowns, dataWritten B, dataRead B, errorLogEntries,
//          warningTempMinutes, criticalTempMinutes } | null,
//   sectors: { reallocated, pending, uncorrectable, reportedUncorrect, crc } | null           (ATA)
//   attributes: [{ id, name, value, worst, threshold, raw: { value, unit, text }, prefail, failingNow, failedPast }]
//   nvmeLog: [{ key, value, unit }]   (NVMe health log, for the expert table)     criticalWarnings: [string] (NVMe)
//   selftest: { supported, running, percentRemaining, last: 'success'|'aborted'|'interrupted'|'fatal'|'failed'|null,
//               lastDetail: 'read'|'electrical'|'servo'|'handling'|'segment'|'unknown'|null, lastCode, log: [{ type,
//               result, detail, hours }] (smartctl only) },
//   canSmartctl (the administrator read through aurora-admin smart-info may give data),
// }

const DEST = 'org.freedesktop.UDisks2';
const IFACE = {
  block: 'org.freedesktop.UDisks2.Block',
  partition: 'org.freedesktop.UDisks2.Partition',
  drive: 'org.freedesktop.UDisks2.Drive',
  ata: 'org.freedesktop.UDisks2.Drive.Ata',
  nvme: 'org.freedesktop.UDisks2.NVMe.Controller',
  props: 'org.freedesktop.DBus.Properties',
  manager: 'org.freedesktop.DBus.ObjectManager',
};
const DRIVE_OBJ_RE = /^\/org\/freedesktop\/UDisks2\/drives\/[A-Za-z0-9_]{1,255}$/;
const SMARTCTL_DEVICE_RE = /^\/dev\/(sd[a-z]{1,2}|nvme[0-9]{1,2}n[0-9]{1,2})$/; // = admin.js / aurora-admin smart-info
const VIRTUAL_RE = /\b(QEMU|VBOX|VirtualBox|VMware|Virtual ?disk|Msft|Xen|Red Hat VirtIO)\b/i;
const RANK = { unknown: -1, good: 0, warning: 1, failing: 2 };

// ------------------------------------------------------------------ busctl argument vectors
const BUSCTL_BASE = ['--system', '--json=short', '--timeout=30', '--allow-interactive-authorization=no'];
/** a{sv} of booleans as busctl arguments: { nowakeup: true } -> ['1', 'nowakeup', 'b', 'true'] */
function optionArgs(opts = {}) {
  const e = Object.entries(opts);
  return [String(e.length), ...e.flatMap(([k, v]) => [k, 'b', v ? 'true' : 'false'])];
}
const NO_UI = { 'auth.no_user_interaction': true };
const argv = {
  managedObjects: () => [...BUSCTL_BASE, 'call', DEST, '/org/freedesktop/UDisks2', IFACE.manager, 'GetManagedObjects'],
  getAll: (obj, iface) => [...BUSCTL_BASE, 'call', DEST, obj, IFACE.props, 'GetAll', 's', iface],
  smartUpdate: (obj, iface, { wake = false } = {}) =>
    [...BUSCTL_BASE, 'call', DEST, obj, iface, 'SmartUpdate', 'a{sv}', ...optionArgs(iface === IFACE.ata && !wake ? { nowakeup: true, ...NO_UI } : NO_UI)],
  smartAttributes: (obj, iface) => [...BUSCTL_BASE, 'call', DEST, obj, iface, 'SmartGetAttributes', 'a{sv}', ...optionArgs(NO_UI)],
  selftestStart: (obj, iface, type) => [...BUSCTL_BASE, 'call', DEST, obj, iface, 'SmartSelftestStart', 'sa{sv}', type, ...optionArgs(NO_UI)],
  selftestAbort: (obj, iface) => [...BUSCTL_BASE, 'call', DEST, obj, iface, 'SmartSelftestAbort', 'a{sv}', ...optionArgs(NO_UI)],
};

/** busctl's error text ("Call failed: <message>") -> an error code the app understands. */
function classifyBusError(text) {
  const s = String(text || '');
  if (/Not authori[sz]ed|Authentication is required|Access denied|NotAuthorized/i.test(s)) return 'ENOTAUTH';
  if (/sleep mode|nowakeup|WouldWakeup/i.test(s)) return 'EASLEEP';
  if (/already .*(self-test|selftest|sanitize).*running|is already running/i.test(s)) return 'EBUSY';
  if (/no support for self-test|not supported or enabled|Unknown self-test type|not supported/i.test(s)) return 'ENOTSUP';
  if (/not provided by any \.service|ServiceUnknown|Failed to connect to bus|Could not activate|No such file or directory|Unknown object|UnknownObject|Connection refused|command not found/i.test(s)) return 'ENOSERVICE';
  return 'EFAIL';
}

// ------------------------------------------------------------------ busctl JSON decoding
/** busctl --json=short output -> { type, data: [out args] } (a void method prints nothing). */
function parseBusctlJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return { type: '', data: [] };
  const j = JSON.parse(text);
  if (!j || typeof j !== 'object' || !Array.isArray(j.data)) throw new Error('unexpected busctl output');
  return j;
}
const bytesToString = (a) => {
  if (!Array.isArray(a)) return '';
  const end = a.indexOf(0);
  return Buffer.from((end >= 0 ? a.slice(0, end) : a).filter((b) => Number.isInteger(b) && b >= 0 && b < 256)).toString('utf8');
};
/** One variant { type, data } -> a plain value ('ay' becomes a string: device paths). */
function decodeVariant(v) {
  if (!v || typeof v !== 'object' || typeof v.type !== 'string') return v;
  if (v.type === 'ay') return bytesToString(v.data);
  if (v.type === 'v') return decodeVariant(Array.isArray(v.data) ? v.data[0] : v.data);
  return v.data;
}
/** a{sv} as busctl prints it -> { key: plain value } */
function decodeDict(dict) {
  const out = {};
  if (!dict || typeof dict !== 'object') return out;
  for (const [k, v] of Object.entries(dict)) out[k] = decodeVariant(v);
  return out;
}
/** GetManagedObjects (a{oa{sa{sv}}}) -> Map(objectPath -> { interface -> { property -> value } }) */
function parseManagedObjects(j) {
  const map = new Map();
  const root = j?.data?.[0];
  if (!root || typeof root !== 'object') return map;
  for (const [obj, ifaces] of Object.entries(root)) {
    const o = {};
    for (const [iface, props] of Object.entries(ifaces || {})) o[iface] = decodeDict(props);
    map.set(obj, o);
  }
  return map;
}
/** The udisks drive behind a whole-disk device node: { blockPath, drivePath, drive, ata, nvme } or null. */
function findUdisksDrive(objects, devPath) {
  if (!objects) return null;
  for (const [obj, ifaces] of objects) {
    const blk = ifaces[IFACE.block];
    if (!blk || ifaces[IFACE.partition]) continue;
    if (blk.Device !== devPath && blk.PreferredDevice !== devPath) continue;
    const drivePath = typeof blk.Drive === 'string' && DRIVE_OBJ_RE.test(blk.Drive) ? blk.Drive : null;
    const d = (drivePath && objects.get(drivePath)) || {};
    return { blockPath: obj, drivePath, drive: d[IFACE.drive] || null, ata: d[IFACE.ata] || null, nvme: d[IFACE.nvme] || null };
  }
  return null;
}

// ------------------------------------------------------------------ helpers
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const kToC = (k) => (num(k) && k > 200 ? Math.round(k - 273.15) : null);
const prob = (code, level, extra = {}) => ({ code, level, ...extra });
const ATA_SELFTEST = {
  success: ['success', null], aborted: ['aborted', null], interrupted: ['interrupted', null], fatal: ['fatal', null],
  error_unknown: ['failed', 'unknown'], error_electrical: ['failed', 'electrical'], error_servo: ['failed', 'servo'],
  error_read: ['failed', 'read'], error_handling: ['failed', 'handling'],
};
const NVME_SELFTEST = {
  success: ['success', null], aborted: ['aborted', null], ctrl_reset: ['aborted', null], ns_removed: ['aborted', null],
  aborted_format: ['aborted', null], aborted_unknown: ['aborted', null], aborted_sanitize: ['aborted', null],
  fatal_error: ['fatal', null], unknown_seg_fail: ['failed', 'segment'], known_seg_fail: ['failed', 'segment'],
};
const NVME_CRITICAL_BITS = [[0x01, 'spare'], [0x02, 'temperature'], [0x04, 'degraded'], [0x08, 'readonly'], [0x10, 'volatile_mem'], [0x20, 'pmr_readonly']];

function emptyHealth(device, extra = {}) {
  return {
    device, key: null, source: null, kind: null, rotational: null, updated: null, status: 'unknown', reason: null, detail: null, asleep: false,
    problems: [], temperature: null, powerOnHours: null, powerCycles: null, ssd: null, sectors: null, attributes: [], nvmeLog: [],
    criticalWarnings: [], selftest: { supported: false, running: false, percentRemaining: null, last: null, lastDetail: null, lastCode: '', log: [] },
    canSmartctl: false, ...extra,
  };
}
function finish(h) {
  let status = 'good';
  for (const p of h.problems) {
    if (p.level === 'failing') status = 'failing';
    else if (p.level === 'warning' && status !== 'failing') status = 'warning';
  }
  h.status = status;
  return h;
}

/** Why a drive has no health data, from the lsblk drive and its udisks Drive properties. */
function unknownReason(d, udisksDrive) {
  const name = String(d?.name || '');
  if (d?.type === 'rom') return 'optical';
  if (/^mmcblk/.test(name) || d?.tran === 'mmc') return 'card';
  const ident = [d?.model, d?.vendor, udisksDrive?.Model, udisksDrive?.Vendor].filter(Boolean).join(' ');
  if (d?.tran === 'virtio' || /^(vd|xvd)[a-z]/.test(name) || VIRTUAL_RE.test(ident)) return 'virtual';
  if (d?.tran === 'usb' || udisksDrive?.ConnectionBus === 'usb') return 'usb';
  return 'other';
}
/** The administrator read (aurora-admin smart-info) can only help a whole SATA/SAS/USB/NVMe disk that is not a stick. */
function smartctlMayHelp(d, reason) {
  if (!d || d.type !== 'disk' || !SMARTCTL_DEVICE_RE.test(String(d.path || ''))) return false;
  if (reason === 'usb') return !d.removableMedia; // USB sticks have no SMART; enclosures (removable flag 0) often do
  return ['other', 'noService', 'noData'].includes(reason);
}
function unknownHealth(d, reason, extra = {}) {
  const h = emptyHealth(d?.path || null, { reason, rotational: d ? !!d.rotational : null, ...extra });
  h.canSmartctl = smartctlMayHelp(d, reason);
  return h;
}

// ------------------------------------------------------------------ ATA (udisks + smartctl share the assessment)
const UDISKS_UNITS = { 0: null, 1: 'none', 2: 'ms', 3: 'sectors', 4: 'mK', 5: 'percent', 6: 'percent', 7: 'MB' };
/** SmartGetAttributes a(ysqiiixia{sv}) as busctl prints it -> normalized attributes. */
function ataAttributesFromUdisks(j) {
  const rows = Array.isArray(j?.data?.[0]) ? j.data[0] : [];
  return rows
    .filter((r) => Array.isArray(r) && r.length >= 8)
    .map(([id, name, flags, value, worst, threshold, pretty, prettyUnit]) => {
      let unit = UDISKS_UNITS[prettyUnit] ?? null;
      let raw = unit ? num(pretty) : null;
      // libatasmart turns 241 / 242 (total LBAs written / read) into "MB" assuming 32 MiB units; undo it to get the raw count.
      if (unit === 'MB' && /^total-lbas-(written|read)$/.test(name) && raw != null) {
        raw = Math.round((raw * 1e6) / 33554432);
        unit = 'none';
      }
      return normAttr({ id, name, flags, value, worst, threshold, raw: { value: raw, unit, text: null } });
    });
}
function normAttr(a) {
  const value = num(a.value) ?? -1;
  const worst = num(a.worst) ?? -1;
  const threshold = num(a.threshold) ?? -1;
  const prefail = a.prefail != null ? !!a.prefail : !!(Number(a.flags) & 1);
  const failingNow = a.failingNow != null ? !!a.failingNow : value > 0 && threshold > 0 && value <= threshold;
  const failedPast = a.failedPast != null ? !!a.failedPast : !failingNow && worst > 0 && threshold > 0 && worst <= threshold;
  return { id: Number(a.id), name: String(a.name || `attribute-${a.id}`), value, worst, threshold, raw: a.raw, prefail, failingNow, failedPast };
}
const attrById = (attrs, id) => attrs.find((a) => a.id === id) || null;
const rawCount = (a) => (a && a.raw && (a.raw.unit === 'none' || a.raw.unit === 'sectors') && a.raw.value != null ? Math.max(0, a.raw.value) : null);

/**
 * Common ATA assessment. input = { device, rotational, overallFailing, temperature, powerOnHours, powerCycles,
 * attributes (normalized), selftest, size }. Adds sectors / ssd figures and problems, returns the health.
 */
function assessAta(h, input) {
  const attrs = input.attributes || [];
  h.kind = 'ata';
  h.attributes = attrs;
  h.temperature = input.temperature ?? null;
  h.powerOnHours = input.powerOnHours ?? null;
  h.powerCycles = input.powerCycles ?? rawCount(attrById(attrs, 12));
  const sectors = {
    reallocated: rawCount(attrById(attrs, 5)),
    pending: rawCount(attrById(attrs, 197)),
    uncorrectable: rawCount(attrById(attrs, 198)),
    reportedUncorrect: rawCount(attrById(attrs, 187)),
    crc: rawCount(attrById(attrs, 199)),
  };
  h.sectors = sectors;
  if (h.rotational === false) {
    // Wear: the normalized value of the vendor's "life left" attribute (100 = new): Samsung 177, Crucial / Micron 202,
    // Kingston / SandForce 231, Intel 233, 232 / 169 on others.
    let used = null;
    for (const id of [177, 202, 231, 233, 232, 169]) {
      const a = attrById(attrs, id);
      if (a && a.value >= 0 && a.value <= 100) {
        used = 100 - a.value;
        break;
      }
    }
    const spareA = attrById(attrs, 170);
    let written = rawCount(attrById(attrs, 241));
    let read = rawCount(attrById(attrs, 242));
    // 241 / 242 count 512-byte LBAs on most drives; a few (Intel) count 32 MiB units: a figure smaller than the disk
    // after more than 500 hours of use cannot be LBAs.
    const unitOf = (lbas) => (lbas != null && input.size && lbas * 512 < input.size && (h.powerOnHours || 0) > 500 ? 33554432 : 512);
    if (written != null) written *= unitOf(written);
    if (read != null) read *= unitOf(read);
    const unsafeA = attrById(attrs, 192) || attrById(attrs, 174);
    h.ssd = {
      used, spare: spareA && spareA.value >= 0 ? spareA.value : null, spareThreshold: spareA && spareA.threshold > 0 ? spareA.threshold : null,
      mediaErrors: null, unsafeShutdowns: rawCount(unsafeA), dataWritten: written, dataRead: read, errorLogEntries: null,
      warningTempMinutes: null, criticalTempMinutes: null,
    };
  }
  const P = h.problems;
  if (input.overallFailing) P.push(prob('predictsFailure', 'failing'));
  const failingNow = attrs.filter((a) => a.failingNow);
  const failingPre = failingNow.filter((a) => a.prefail);
  const failingOld = failingNow.filter((a) => !a.prefail);
  if (failingPre.length) P.push(prob('attrFailing', 'failing', { ids: failingPre.map((a) => a.id), names: failingPre.map((a) => a.name) }));
  if (failingOld.length) P.push(prob('attrFailing', 'warning', { ids: failingOld.map((a) => a.id), names: failingOld.map((a) => a.name) }));
  const st = h.selftest;
  if (!st.running && st.last === 'failed') P.push(prob('selftestFailed', 'failing', { detail: st.lastDetail || 'unknown' }));
  if (!st.running && st.last === 'fatal') P.push(prob('selftestFatal', 'warning'));
  const bad = (sectors.reallocated || 0) + (sectors.pending || 0);
  if (bad > 0 || (sectors.uncorrectable || 0) > 0) {
    P.push(prob('badSectors', 'warning', { count: bad, reallocated: sectors.reallocated || 0, pending: sectors.pending || 0, uncorrectable: sectors.uncorrectable || 0 }));
  }
  if ((sectors.reportedUncorrect || 0) > 0) P.push(prob('readErrors', 'warning', { count: sectors.reportedUncorrect }));
  const hot = h.rotational === false ? 75 : 60;
  if (h.temperature != null && h.temperature >= hot) P.push(prob('hot', 'warning', { celsius: h.temperature }));
  if (h.ssd?.used != null && h.ssd.used >= 90) P.push(prob('wear', 'warning', { percent: h.ssd.used }));
  if (h.ssd?.spare != null && h.ssd.spareThreshold != null && h.ssd.spare <= h.ssd.spareThreshold) P.push(prob('spareLow', 'warning', { spare: h.ssd.spare, threshold: h.ssd.spareThreshold }));
  if ((sectors.crc || 0) > 0) P.push(prob('crc', 'info', { count: sectors.crc }));
  const past = attrs.filter((a) => a.failedPast);
  if (past.length) P.push(prob('pastThreshold', 'info', { ids: past.map((a) => a.id), names: past.map((a) => a.name) }));
  return finish(h);
}

/** udisks Drive.Ata properties + SmartGetAttributes -> health. */
function healthFromUdisksAta({ device, rotational, size, ata, attributes, asleep = false }) {
  const h = emptyHealth(device, { source: 'udisks', rotational, asleep });
  h.updated = num(ata.SmartUpdated) ? ata.SmartUpdated * 1000 : null;
  const code = String(ata.SmartSelftestStatus || '');
  const [last, detail] = ATA_SELFTEST[code] || [null, null];
  const pct = num(ata.SmartSelftestPercentRemaining);
  h.selftest = {
    supported: !!(ata.SmartSupported && ata.SmartEnabled), running: code === 'inprogress',
    percentRemaining: code === 'inprogress' && pct != null && pct >= 0 ? pct : null, last, lastDetail: detail, lastCode: code, log: [],
  };
  const poh = num(ata.SmartPowerOnSeconds);
  return assessAta(h, {
    overallFailing: !!ata.SmartFailing, temperature: kToC(ata.SmartTemperature), powerOnHours: poh ? Math.floor(poh / 3600) : null,
    attributes: attributes || [], size,
  });
}

// ------------------------------------------------------------------ NVMe
function assessNvme(h, log) {
  h.kind = 'nvme';
  h.rotational = false;
  const P = h.problems;
  const w = h.criticalWarnings;
  const crit = w.filter((x) => ['degraded', 'readonly', 'volatile_mem', 'pmr_readonly'].includes(x));
  if (crit.length) P.push(prob('critical', 'failing', { warnings: crit }));
  const st = h.selftest;
  if (!st.running && st.last === 'failed') P.push(prob('selftestFailed', 'failing', { detail: st.lastDetail || 'segment' }));
  if (!st.running && st.last === 'fatal') P.push(prob('selftestFatal', 'warning'));
  const s = h.ssd;
  if (w.includes('spare') || (s.spare != null && s.spareThreshold != null && s.spare < s.spareThreshold)) {
    P.push(prob('spareLow', 'warning', { spare: s.spare, threshold: s.spareThreshold }));
  }
  if (s.used != null && s.used >= 90) P.push(prob('wear', 'warning', { percent: s.used }));
  if ((s.mediaErrors || 0) > 0) P.push(prob('mediaErrors', 'warning', { count: s.mediaErrors }));
  const cctemp = kToC(log.cctemp);
  if (w.includes('temperature') || (h.temperature != null && h.temperature >= (cctemp || 80))) P.push(prob('hot', 'warning', { celsius: h.temperature }));
  return finish(h);
}
function nvmeLogRows(a, temperatureK) {
  const rows = [];
  const add = (key, value, unit = 'none') => value != null && rows.push({ key, value, unit });
  add('temperature', kToC(temperatureK), 'celsius');
  add('avail_spare', num(a.avail_spare), 'percent');
  add('spare_thresh', num(a.spare_thresh), 'percent');
  add('percent_used', num(a.percent_used), 'percent');
  add('total_data_read', num(a.total_data_read), 'bytes');
  add('total_data_written', num(a.total_data_written), 'bytes');
  add('ctrl_busy_time', num(a.ctrl_busy_time), 'minutes');
  add('power_cycles', num(a.power_cycles));
  add('unsafe_shutdowns', num(a.unsafe_shutdowns));
  add('media_errors', num(a.media_errors));
  add('num_err_log_entries', num(a.num_err_log_entries));
  add('warning_temp_time', num(a.warning_temp_time), 'minutes');
  add('critical_temp_time', num(a.critical_temp_time), 'minutes');
  add('wctemp', kToC(a.wctemp), 'celsius');
  add('cctemp', kToC(a.cctemp), 'celsius');
  (Array.isArray(a.temp_sensors) ? a.temp_sensors : []).forEach((k, i) => kToC(k) != null && add(`temp_sensor_${i + 1}`, kToC(k), 'celsius'));
  return rows;
}
/** udisks NVMe.Controller properties + SmartGetAttributes (a{sv}) -> health. */
function healthFromUdisksNvme({ device, nvme, attrs }) {
  const a = attrs || {};
  const h = emptyHealth(device, { source: 'udisks' });
  h.updated = num(nvme.SmartUpdated) ? nvme.SmartUpdated * 1000 : null;
  h.temperature = kToC(nvme.SmartTemperature);
  h.powerOnHours = num(nvme.SmartPowerOnHours);
  h.powerCycles = num(a.power_cycles);
  h.criticalWarnings = Array.isArray(nvme.SmartCriticalWarning) ? nvme.SmartCriticalWarning.map(String) : [];
  h.ssd = {
    used: num(a.percent_used), spare: num(a.avail_spare), spareThreshold: num(a.spare_thresh), mediaErrors: num(a.media_errors),
    unsafeShutdowns: num(a.unsafe_shutdowns), dataWritten: num(a.total_data_written), dataRead: num(a.total_data_read),
    errorLogEntries: num(a.num_err_log_entries), warningTempMinutes: num(a.warning_temp_time), criticalTempMinutes: num(a.critical_temp_time),
  };
  const code = String(nvme.SmartSelftestStatus || '');
  const [last, detail] = NVME_SELFTEST[code] || [null, null];
  const pct = num(nvme.SmartSelftestPercentRemaining);
  // udisks only reads the self-test log of controllers that support self-tests: an empty status means "not supported".
  h.selftest = { supported: code !== '', running: code === 'inprogress', percentRemaining: code === 'inprogress' && pct != null && pct >= 0 ? pct : null, last, lastDetail: detail, lastCode: code, log: [] };
  h.nvmeLog = nvmeLogRows(a, nvme.SmartTemperature);
  return assessNvme(h, a);
}

// ------------------------------------------------------------------ smartctl -j -a (aurora-admin smart-info)
const ATA_ST_CODES = { 0: ['success', null], 1: ['aborted', null], 2: ['interrupted', null], 3: ['fatal', null], 4: ['failed', 'unknown'], 5: ['failed', 'electrical'], 6: ['failed', 'servo'], 7: ['failed', 'read'], 8: ['failed', 'handling'] };
const NVME_ST_CODES = { 0: ['success', null], 1: ['aborted', null], 2: ['aborted', null], 3: ['aborted', null], 4: ['aborted', null], 5: ['fatal', null], 6: ['failed', 'segment'], 7: ['failed', 'segment'], 8: ['aborted', null], 9: ['aborted', null] };

/** smartctl's JSON report -> health (source 'smartctl'). `d` is the lsblk drive (rotational, size). */
function healthFromSmartctl(json, d = {}) {
  const device = d.path || json?.device?.name || null;
  if (!json || typeof json !== 'object') return unknownHealth(d, 'noData');
  const protocol = String(json.device?.protocol || '').toUpperCase();
  const h = emptyHealth(device, { source: 'smartctl', rotational: json.rotation_rate != null ? json.rotation_rate > 0 : d.rotational ?? null, updated: num(json.local_time?.time_t) ? json.local_time.time_t * 1000 : null });
  if (json.smart_support && json.smart_support.available === false) return unknownHealth(d, 'unsupported', { source: 'smartctl' });
  const temperature = num(json.temperature?.current);
  const powerOnHours = num(json.power_on_time?.hours);
  const powerCycles = num(json.power_cycle_count);
  if (protocol === 'NVME' || json.nvme_smart_health_information_log) {
    const l = json.nvme_smart_health_information_log || {};
    const bits = num(l.critical_warning) || 0;
    h.criticalWarnings = NVME_CRITICAL_BITS.filter(([b]) => bits & b).map(([, n]) => n);
    h.temperature = temperature ?? num(l.temperature);
    h.powerOnHours = powerOnHours ?? num(l.power_on_hours);
    h.powerCycles = powerCycles ?? num(l.power_cycles);
    const units = (v) => (num(v) != null ? num(v) * 512000 : null); // NVMe data units are 1000 × 512 bytes
    h.ssd = {
      used: num(l.percentage_used), spare: num(l.available_spare), spareThreshold: num(l.available_spare_threshold), mediaErrors: num(l.media_errors),
      unsafeShutdowns: num(l.unsafe_shutdowns), dataWritten: units(l.data_units_written), dataRead: units(l.data_units_read),
      errorLogEntries: num(l.num_err_log_entries), warningTempMinutes: num(l.warning_temp_time), criticalTempMinutes: num(l.critical_comp_time),
    };
    const k = (c) => (c != null ? c + 273.15 : null);
    h.nvmeLog = nvmeLogRows({
      avail_spare: l.available_spare, spare_thresh: l.available_spare_threshold, percent_used: l.percentage_used, total_data_read: h.ssd.dataRead,
      total_data_written: h.ssd.dataWritten, ctrl_busy_time: l.controller_busy_time, power_cycles: l.power_cycles, unsafe_shutdowns: l.unsafe_shutdowns,
      media_errors: l.media_errors, num_err_log_entries: l.num_err_log_entries, warning_temp_time: l.warning_temp_time, critical_temp_time: l.critical_comp_time,
      temp_sensors: (l.temperature_sensors || []).map(k),
    }, k(h.temperature));
    const stl = json.nvme_self_test_log;
    const table = Array.isArray(stl?.table) ? stl.table : [];
    const log = table.map((e) => {
      const [result, detail] = NVME_ST_CODES[num(e.self_test_result?.value)] || ['failed', 'unknown'];
      return { type: num(e.self_test_code?.value) === 2 ? 'extended' : num(e.self_test_code?.value) === 1 ? 'short' : 'other', result, detail, hours: num(e.power_on_hours) };
    });
    const running = !!stl && num(stl.current_self_test_operation?.value) > 0;
    h.selftest = {
      supported: !!stl, running, percentRemaining: running && num(stl.current_self_test_completion_percent) != null ? 100 - stl.current_self_test_completion_percent : null,
      last: log[0]?.result || null, lastDetail: log[0]?.detail || null, lastCode: '', log,
    };
    return assessNvme(h, { cctemp: null });
  }
  if (protocol === 'ATA' || json.ata_smart_attributes) {
    const rows = Array.isArray(json.ata_smart_attributes?.table) ? json.ata_smart_attributes.table : [];
    const attributes = rows.map((r) =>
      normAttr({
        id: r.id, name: r.name, value: r.value, worst: r.worst, threshold: r.thresh, prefail: r.flags?.prefailure,
        failingNow: r.when_failed === 'now' ? true : undefined, failedPast: r.when_failed === 'past' ? true : undefined,
        raw: { value: num(r.raw?.value), unit: 'none', text: r.raw?.string != null ? String(r.raw.string) : null },
      }),
    );
    const st = json.ata_smart_data?.self_test?.status || {};
    const stv = num(st.value);
    const running = stv != null && stv >> 4 === 15;
    const [last, detail] = stv != null && !running ? ATA_ST_CODES[stv >> 4] || [null, null] : [null, null];
    const log = (json.ata_smart_self_test_log?.standard?.table || []).map((e) => {
      const [result, det] = ATA_ST_CODES[num(e.status?.value) >> 4] || (e.status?.passed ? ['success', null] : ['failed', 'unknown']);
      const tv = num(e.type?.value);
      return { type: tv === 1 || tv === 129 ? 'short' : tv === 2 || tv === 130 ? 'extended' : 'other', result, detail: det, hours: num(e.lifetime_hours) };
    });
    h.selftest = {
      supported: json.ata_smart_data?.capabilities?.self_tests_supported !== false, running, percentRemaining: running ? num(st.remaining_percent) : null,
      last, lastDetail: detail, lastCode: String(st.string || ''), log,
    };
    return assessAta(h, {
      overallFailing: json.smart_status?.passed === false, temperature, powerOnHours, powerCycles, attributes, size: d.size,
    });
  }
  // SCSI / SAS: overall status, grown defects (= reallocated sectors), temperature.
  h.kind = 'scsi';
  h.temperature = temperature;
  h.powerOnHours = powerOnHours;
  h.powerCycles = num(json.scsi_start_stop_cycle_counter?.accumulated_start_stop_cycles) ?? powerCycles;
  const grown = num(json.scsi_grown_defect_list);
  h.sectors = { reallocated: grown, pending: null, uncorrectable: null, reportedUncorrect: null, crc: null };
  if (json.smart_status?.passed === false) h.problems.push(prob('predictsFailure', 'failing'));
  if (grown) h.problems.push(prob('badSectors', 'warning', { count: grown, reallocated: grown, pending: 0, uncorrectable: 0 }));
  if (!json.smart_status && grown == null && temperature == null) return unknownHealth(d, 'unsupported', { source: 'smartctl' });
  return finish(h);
}

module.exports = {
  DEST, IFACE, RANK, DRIVE_OBJ_RE, SMARTCTL_DEVICE_RE, argv, optionArgs, classifyBusError,
  parseBusctlJson, decodeVariant, decodeDict, parseManagedObjects, findUdisksDrive,
  ataAttributesFromUdisks, healthFromUdisksAta, healthFromUdisksNvme, healthFromSmartctl,
  unknownReason, unknownHealth, smartctlMayHelp, emptyHealth,
};
