'use strict';
// Graphics cards and NVIDIA drivers: pure parsers shared by the installer (main/ipc/installer.js) and
// Settings > Graphics drivers (main/ipc/drivers.js). No I/O here: callers run the commands and pass their
// output in (unit-tested with real outputs: shell/test/fixtures/gpu/*, shell/test/gpu-drivers.unit.mjs).
//
//   detectGpus(text of `lspci -nn -mm`)
//       -> [{ vendor: 'nvidia'|'amd'|'intel'|'other', vendorId, deviceId, name, slot, model, cls }]
//          display controllers only (PCI class 03xx: VGA, 3D, display), in bus order.
//          name: 'NVIDIA GeForce RTX 4070' (marketing name when lspci knows it), model: the raw lspci device name.
//   parseUbuntuDrivers(text of `ubuntu-drivers devices`)
//       -> [{ pkg, recommended, kind: 'proprietary'|'open'|'server'|'server-open'|'free', version, builtin }]
//          graphics drivers only (nvidia-driver-NNN… and the free xserver-xorg-video-* driver); newest first.
//   validDriverPkg(name)  -> strict /^nvidia-driver-\d{3}(-open|-server|-server-open)?$/
//   currentDriver(text of `lsmod` or of /proc/driver/nvidia/version)
//       -> { module: 'nvidia'|'nouveau'|null, version: '550.120'|null, open: true|false|null }
//   driverSpec('nvidia-driver-550-open') -> 'nvidia:550-open'   (argument of `ubuntu-drivers install`)
//   recommendedDriver(list)  -> the recommended NVIDIA package of a parseUbuntuDrivers() list (or null)
//   parseSecureBoot(text of `mokutil --sb-state`) -> true | false | null (unknown / BIOS)

const DRIVER_RE = /^nvidia-driver-\d{3}(-open|-server|-server-open)?$/;
const VENDORS = { '10de': 'nvidia', '1002': 'amd', '1022': 'amd', '8086': 'intel' };
const VENDOR_NAMES = { nvidia: 'NVIDIA', amd: 'AMD', intel: 'Intel' };

/** Split one `lspci -mm` line into its fields (quoted strings and bare -rXX / -pXX options). */
function lspciFields(line) {
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
  let m;
  while ((m = re.exec(line))) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2]);
  return out;
}

/** 'NVIDIA Corporation [10de]' -> { text: 'NVIDIA Corporation', id: '10de' } */
function splitId(field) {
  const m = /^(.*?)\s*\[([0-9a-fA-F]{4})\]\s*$/.exec(String(field || ''));
  return m ? { text: m[1].trim(), id: m[2].toLowerCase() } : { text: String(field || '').trim(), id: '' };
}

/** 'AD104 [GeForce RTX 4070]' -> 'GeForce RTX 4070'; 'Device 2786' -> '' */
function marketingName(model) {
  const m = /\[([^\]]+)\]\s*$/.exec(model);
  if (m && !/^[0-9a-f]{4}$/i.test(m[1])) return m[1].trim();
  return /^Device\b/.test(model) ? '' : model;
}

function detectGpus(text) {
  const gpus = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const f = lspciFields(line);
    if (f.length < 4) continue;
    const [slot, clsField, vendorField, deviceField] = f;
    const cls = splitId(clsField);
    // PCI class 03: display controllers (0300 VGA compatible, 0302 3D controller, 0380 display controller).
    if (!/^03[0-9a-f]{2}$/.test(cls.id)) continue;
    const ven = splitId(vendorField);
    const dev = splitId(deviceField);
    const vendor = VENDORS[ven.id] || 'other';
    const marketing = marketingName(dev.text);
    const prefix = VENDOR_NAMES[vendor] || ven.text.replace(/,? (Inc\.|Corporation|Corp\.|Co\., Ltd\.|Ltd\.)$/i, '');
    const name = marketing ? (marketing.toLowerCase().startsWith(prefix.toLowerCase()) ? marketing : `${prefix} ${marketing}`) : `${prefix} ${dev.id || ''}`.trim();
    gpus.push({ vendor, vendorId: ven.id, deviceId: dev.id, name, slot, model: dev.text, cls: cls.id });
  }
  return gpus;
}

function kindOf(pkg) {
  const m = /^nvidia-driver-\d{3}(-open|-server|-server-open)?$/.exec(pkg);
  if (!m) return 'free';
  return { '-open': 'open', '-server': 'server', '-server-open': 'server-open' }[m[1]] || 'proprietary';
}
const KIND_ORDER = { proprietary: 0, open: 1, server: 2, 'server-open': 3, free: 4 };

function parseUbuntuDrivers(text) {
  const out = [];
  const seen = new Set();
  for (const raw of String(text || '').split('\n')) {
    // driver   : nvidia-driver-550 - distro non-free recommended
    const m = /^\s*driver\s*:\s*(\S+)\s+-\s+(.*)$/.exec(raw);
    if (!m) continue;
    const pkg = m[1];
    const flags = m[2].trim().split(/\s+/);
    const nvidia = DRIVER_RE.test(pkg);
    if (!nvidia && !/^xserver-xorg-video-[a-z0-9-]+$/.test(pkg)) continue; // not a graphics driver (Wi-Fi, firmware…)
    if (seen.has(pkg)) continue;
    seen.add(pkg);
    out.push({
      pkg,
      recommended: flags.includes('recommended'),
      kind: kindOf(pkg),
      version: nvidia ? Number(/\d{3}/.exec(pkg)[0]) : null,
      builtin: flags.includes('builtin'),
    });
  }
  return out.sort((a, b) => (b.version ?? -1) - (a.version ?? -1) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
}

function validDriverPkg(name) {
  return typeof name === 'string' && DRIVER_RE.test(name);
}

function currentDriver(text) {
  const s = String(text || '');
  // /proc/driver/nvidia/version: "NVRM version: NVIDIA UNIX x86_64 Kernel Module  550.120  Fri Sep 13 …"
  //                              "NVRM version: NVIDIA UNIX Open Kernel Module for x86_64  550.120  Release Build …"
  const v = /^NVRM version:.*?\b(\d{2,4}\.\d{1,3}(?:\.\d{1,3})?)\b/m.exec(s);
  if (v) return { module: 'nvidia', version: v[1], open: /Open Kernel Module/.test(s) };
  const mods = new Set(
    s
      .split('\n')
      .map((l) => l.trim().split(/\s+/)[0])
      .filter(Boolean),
  );
  if (mods.has('nvidia')) return { module: 'nvidia', version: null, open: null };
  if (mods.has('nouveau')) return { module: 'nouveau', version: null, open: null };
  return { module: null, version: null, open: null };
}

function driverSpec(pkg) {
  if (!validDriverPkg(pkg)) return null;
  return `nvidia:${pkg.slice('nvidia-driver-'.length)}`;
}

function recommendedDriver(list) {
  const nv = (list || []).filter((d) => validDriverPkg(d.pkg));
  return (nv.find((d) => d.recommended) || null)?.pkg ?? null;
}

function parseSecureBoot(text) {
  const s = String(text || '');
  if (/SecureBoot enabled/i.test(s)) return true;
  if (/SecureBoot disabled/i.test(s)) return false;
  return null;
}

module.exports = { detectGpus, parseUbuntuDrivers, validDriverPkg, currentDriver, driverSpec, recommendedDriver, parseSecureBoot, DRIVER_RE };
