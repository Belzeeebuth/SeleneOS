'use strict';
// Graphics drivers backend (Paramètres > Système > Pilotes graphiques). Parsers: main/lib/gpu-drivers.js.
//
//   drivers:detect ()  -> { gpus: [{ vendor, vendorId, deviceId, name, slot }],          (lspci -nn -mm, display class only)
//                           current: { module: 'nvidia'|'nouveau'|null, version, open },  (lsmod, /proc/driver/nvidia/version)
//                           available: [{ pkg, recommended, kind, version }],           (ubuntu-drivers devices: NVIDIA drivers)
//                           recommended: 'nvidia-driver-NNN…' | null,
//                           installed: 'nvidia-driver-NNN…' | null,                     (dpkg: the NVIDIA driver installed)
//                           rebootPending: bool,                                        (installed ≠ loaded: restart to finish)
//                           online, secureBoot: true|false|null, live, tools: { lspci, ubuntuDrivers }, simulated }
//                         No privileges needed.
//   drivers:install (pkg) -> { action: 'drivers-install', args: [pkg] }   checks pkg (strict name AND offered by
//   drivers:remove ()     -> { action: 'drivers-remove', args: [] }       ubuntu-drivers for this machine) and returns
//       the aurora-admin action the renderer runs with shell.runAdmin(action, args) (UAC prompt; progress arrives as
//       admin:progress { action, line } events: "step:…", APT status lines, then "reboot-required" / "done").
//       Errors: EINVAL (not a driver name / not offered here), ENOTSUP (no NVIDIA card or no driver installed).
//
// Dev mode (--dev): a simulated machine (real lspci / ubuntu-drivers outputs below) through the same parsers.
//   AURORA_DEV_GPU=rtx4070 (default) | gtx1060 | rtx2060 | optimus | amd | intel | nolists
//   AURORA_DEV_GPU_DRIVER=nvidia-driver-570   start with that NVIDIA driver installed and loaded
//   AURORA_DEV_OFFLINE=1                      no Internet connection
//   AURORA_DEV_SECUREBOOT=1                   Secure Boot on
//   AURORA_DRIVERS_DEV_FAIL=1                 the simulated install fails half-way
// admin.js routes the simulated drivers-install / drivers-remove actions to devRun() below.
const fs = require('fs');
const dns = require('dns');
const { run, which } = require('../lib/exec');

const PROC_NVIDIA = '/proc/driver/nvidia/version';

function err(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}
const lib = () => require('../lib/gpu-drivers');
// Dev: admin.js's simulated system (its apt-check marks the package lists as downloaded).
const adminDev = () => {
  try {
    return require('./admin').dev;
  } catch {
    return null;
  }
};

// ------------------------------------------------------------------ simulated machines (dev, tests)
// Real `lspci -nn -mm` and `ubuntu-drivers devices` outputs (Ubuntu 24.04).
const UD_HEAD = (slot, ids, vendor, model) => `== /sys/devices/pci0000:00/0000:00:01.0/0000:${slot} ==\nmodalias : pci:v0000${ids[0]}d0000${ids[1]}sv00001043sd000088E3bc03sc00i00\nvendor   : ${vendor}\nmodel    : ${model}\n`;
const UD = (pkgs) => pkgs.map(([p, rec]) => `driver   : ${p} - distro ${p.startsWith('xserver') ? 'free builtin' : `non-free${rec ? ' recommended' : ''}`}`).join('\n');
const NOUVEAU = ['xserver-xorg-video-nouveau'];
const MACHINES = {
  rtx4070: {
    lspci: [
      '00:00.0 "Host bridge [0600]" "Intel Corporation [8086]" "Raptor Lake-S Host Bridge/DRAM Controller [a703]" -r01 "ASUSTeK Computer Inc. [1043]" "Device [8882]"',
      '00:01.0 "PCI bridge [0604]" "Intel Corporation [8086]" "Raptor Lake PCI Express 5.0 Graphics Port (PEG010) [a70d]" -r01 "" ""',
      '01:00.0 "VGA compatible controller [0300]" "NVIDIA Corporation [10de]" "AD104 [GeForce RTX 4070] [2786]" -ra1 "ASUSTeK Computer Inc. [1043]" "Device [88e3]"',
      '01:00.1 "Audio device [0403]" "NVIDIA Corporation [10de]" "AD104 High Definition Audio Controller [22bc]" -ra1 "ASUSTeK Computer Inc. [1043]" "Device [88e3]"',
    ].join('\n'),
    devices: `${UD_HEAD('01:00.0', ['10DE', '2786'], 'NVIDIA Corporation', 'AD104 [GeForce RTX 4070]')}${UD([['nvidia-driver-570-server-open'], ['nvidia-driver-535-open'], ['nvidia-driver-580-open', true], ['nvidia-driver-570-open'], ['nvidia-driver-535-server-open'], ['nvidia-driver-580'], ['nvidia-driver-570'], ['nvidia-driver-535'], ['nvidia-driver-535-server'], ['nvidia-driver-570-server'], NOUVEAU])}\n`,
  },
  gtx1060: {
    // Pascal: proprietary only (no -open flavour); 580 is the last branch for it.
    lspci: [
      '00:02.0 "PCI bridge [0604]" "Intel Corporation [8086]" "6th-10th Gen Core Processor PCIe Controller (x16) [1901]" -r07 "" ""',
      '01:00.0 "VGA compatible controller [0300]" "NVIDIA Corporation [10de]" "GP106 [GeForce GTX 1060 6GB] [1c03]" -ra1 "Micro-Star International Co., Ltd. [MSI] [1462]" "Device [3283]"',
      '01:00.1 "Audio device [0403]" "NVIDIA Corporation [10de]" "GP106 High Definition Audio Controller [10f1]" -ra1 "Micro-Star International Co., Ltd. [MSI] [1462]" "Device [3283]"',
    ].join('\n'),
    devices: `${UD_HEAD('01:00.0', ['10DE', '1C03'], 'NVIDIA Corporation', 'GP106 [GeForce GTX 1060 6GB]')}${UD([['nvidia-driver-470'], ['nvidia-driver-580', true], ['nvidia-driver-570'], ['nvidia-driver-535'], ['nvidia-driver-470-server'], ['nvidia-driver-535-server'], ['nvidia-driver-570-server'], NOUVEAU])}\n`,
  },
  rtx2060: {
    // Turing: the -open flavour exists.
    lspci: '01:00.0 "VGA compatible controller [0300]" "NVIDIA Corporation [10de]" "TU106 [GeForce RTX 2060 Rev. A] [1f08]" -ra1 "Gigabyte Technology Co., Ltd [1458]" "Device [37ce]"\n01:00.1 "Audio device [0403]" "NVIDIA Corporation [10de]" "TU106 High Definition Audio Controller [10f9]" -ra1 "Gigabyte Technology Co., Ltd [1458]" "Device [37ce]"',
    devices: `${UD_HEAD('01:00.0', ['10DE', '1F08'], 'NVIDIA Corporation', 'TU106 [GeForce RTX 2060 Rev. A]')}${UD([['nvidia-driver-535-open'], ['nvidia-driver-580', true], ['nvidia-driver-580-open'], ['nvidia-driver-570'], ['nvidia-driver-570-open'], ['nvidia-driver-535'], ['nvidia-driver-535-server'], ['nvidia-driver-535-server-open'], NOUVEAU])}\n`,
  },
  optimus: {
    // Laptop: Intel integrated graphics drive the screen, the NVIDIA GPU is a "3D controller".
    lspci: [
      '00:00.0 "Host bridge [0600]" "Intel Corporation [8086]" "Alder Lake-P/U Host bridge [4621]" -r02 "Lenovo [17aa]" "Device [3b2f]"',
      '00:02.0 "VGA compatible controller [0300]" "Intel Corporation [8086]" "Alder Lake-P GT2 [Iris Xe Graphics] [46a6]" -r0c "Lenovo [17aa]" "Device [3b2f]"',
      '01:00.0 "3D controller [0302]" "NVIDIA Corporation [10de]" "GA107M [GeForce RTX 3050 Mobile] [25a2]" -ra1 "Lenovo [17aa]" "Device [3b2f]"',
    ].join('\n'),
    devices: `${UD_HEAD('01:00.0', ['10DE', '25A2'], 'NVIDIA Corporation', 'GA107M [GeForce RTX 3050 Mobile]')}${UD([['nvidia-driver-580-open', true], ['nvidia-driver-580'], ['nvidia-driver-570-open'], ['nvidia-driver-570'], ['nvidia-driver-535'], ['nvidia-driver-535-open'], NOUVEAU])}\n`,
  },
  amd: {
    lspci: '03:00.0 "VGA compatible controller [0300]" "Advanced Micro Devices, Inc. [AMD/ATI] [1002]" "Navi 32 [Radeon RX 7700 XT / 7800 XT] [747e]" -rc8 "Sapphire Technology Limited [1da2]" "Device [e445]"\n03:00.1 "Audio device [0403]" "Advanced Micro Devices, Inc. [AMD/ATI] [1002]" "Navi 31 HDMI/DP Audio [ab30]" "Sapphire Technology Limited [1da2]" "Device [e445]"',
    devices: '',
  },
  intel: {
    lspci: '00:02.0 "VGA compatible controller [0300]" "Intel Corporation [8086]" "Raptor Lake-S GT1 [UHD Graphics 770] [a780]" -r04 "Dell [1028]" "Device [0c3a]"',
    devices: '',
  },
};
// An NVIDIA card on a system whose package lists are empty (installed offline): ubuntu-drivers offers nothing yet.
MACHINES.nolists = { lspci: MACHINES.rtx2060.lspci, devices: '' };
const NVIDIA_VERSIONS = { 580: '580.95.05', 570: '570.195.03', 535: '535.274.02', 470: '470.256.02' };

// Dev: the simulated machine. `installed` = NVIDIA driver package, `loaded` = what the running kernel uses
// (an install / removal takes effect at the next start, like on a real system).
let devState = null;
function dev() {
  if (!devState) {
    const machine = MACHINES[process.env.AURORA_DEV_GPU] ? process.env.AURORA_DEV_GPU : 'rtx4070';
    const pre = /^nvidia-driver-\d{3}(-open|-server|-server-open)?$/.test(process.env.AURORA_DEV_GPU_DRIVER || '') ? process.env.AURORA_DEV_GPU_DRIVER : null;
    devState = { machine, installed: pre, loaded: pre, listsFetched: machine !== 'nolists' };
  }
  return devState;
}
function devLsmod(st) {
  const nv = /nvidia|nolists|optimus|rtx|gtx/.test(st.machine);
  const rows = ['Module                  Size  Used by'];
  if (st.loaded) rows.push('nvidia_drm            135168  4', 'nvidia_modeset       1638400  3 nvidia_drm', 'nvidia              104071168  52 nvidia_modeset');
  else if (nv) rows.push('nouveau              3096576  12', 'drm_ttm_helper         12288  1 nouveau', 'ttm                   110592  2 drm_ttm_helper,nouveau');
  if (st.machine === 'amd') rows.push('amdgpu              19767296  23');
  if (st.machine === 'intel' || st.machine === 'optimus') rows.push('i915                 4362240  31');
  return `${rows.join('\n')}\n`;
}
function devProcVersion(st) {
  if (!st.loaded) return null;
  const n = /-(\d{3})/.exec(st.loaded)[1];
  const open = /-open$/.test(st.loaded);
  return `NVRM version: NVIDIA UNIX ${open ? 'Open Kernel Module for ' : ''}x86_64 Kernel Module  ${NVIDIA_VERSIONS[n] || `${n}.00`}  Thu Sep 18 20:31:16 UTC 2025\nGCC version:  gcc version 13.3.0 (Ubuntu 13.3.0-6ubuntu2~24.04)\n`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Dev: simulated aurora-admin drivers-install / drivers-remove (called by admin.js). */
async function devRun(action, args, onLine) {
  const st = dev();
  const emit = (l) => onLine?.(`${l}\n`);
  if (process.env.AURORA_DEV_OFFLINE === '1' && action === 'drivers-install') {
    emit('step:refresh');
    await sleep(300);
    throw err('could not refresh the package lists (check the Internet connection)', 'ECMD');
  }
  if (action === 'drivers-install') {
    const pkg = args[0];
    emit('step:refresh');
    await sleep(250);
    st.listsFetched = true;
    emit('step:check');
    await sleep(150);
    const offered = lib().parseUbuntuDrivers(MACHINES[st.machine === 'nolists' ? 'rtx2060' : st.machine].devices).some((d) => d.pkg === pkg);
    if (!offered) throw err(`${pkg} is not offered for the graphics card of this computer`, 'EPERM');
    emit('step:install');
    const n = /-(\d{3})/.exec(pkg)[1];
    const files = 6;
    for (let i = 1; i <= files; i++) {
      emit(`dlstatus:${i}:${((i / files) * 100).toFixed(4)}:Retrieving file ${i} of ${files}`);
      await sleep(140);
    }
    const parts = [`libnvidia-gl-${n}`, `nvidia-kernel-common-${n}`, `linux-modules-nvidia-${n}${/-open/.test(pkg) ? '-open' : ''}-generic`, `nvidia-utils-${n}`, pkg];
    let k = 0;
    for (const p of parts) {
      for (const s of ['Preparing', 'Unpacking', 'Configuring']) {
        k++;
        if (process.env.AURORA_DRIVERS_DEV_FAIL === '1' && k === 5) throw err(`could not install ${pkg} (see the system journal)`, 'ECMD');
        emit(`pmstatus:${p}:${((k / (parts.length * 3)) * 100).toFixed(4)}:${s} ${p}`);
        await sleep(110);
      }
    }
    st.installed = pkg;
  } else if (action === 'drivers-remove') {
    if (!st.installed) throw err('no NVIDIA driver is installed', 'ENOTFOUND');
    emit('step:remove');
    const steps = ['Removing', 'Purging configuration files for'];
    for (let i = 0; i < steps.length; i++) {
      emit(`pmstatus:${st.installed}:${(((i + 1) / steps.length) * 100).toFixed(4)}:${steps[i]} ${st.installed}`);
      await sleep(200);
    }
    emit('step:initramfs');
    await sleep(300);
    st.installed = null;
  } else throw err(`Action not allowed: ${action}`, 'EINVAL');
  emit('reboot-required');
  return 'reboot-required\ndone\n';
}

// ------------------------------------------------------------------ real system
const readText = (f) => {
  try {
    return fs.readFileSync(f, 'utf8');
  } catch {
    return null;
  }
};
async function out(cmd, args, timeout = 20000) {
  try {
    const r = await run(cmd, args, { timeout });
    return r.code === 0 ? r.stdout : null;
  } catch {
    return null;
  }
}

async function isOnline() {
  if (process.env.AURORA_DEV_OFFLINE === '1') return false;
  const nm = (await out('nmcli', ['-t', 'networking', 'connectivity'], 4000))?.trim();
  if (nm === 'full' || nm === 'limited') return true;
  if (nm === 'none' || nm === 'portal') return false;
  // No NetworkManager answer: can the archive's name be resolved?
  return new Promise((resolve) => {
    const tm = setTimeout(() => resolve(false), 3000);
    dns.lookup('archive.ubuntu.com', (e) => {
      clearTimeout(tm);
      resolve(!e);
    });
  });
}

async function secureBootState() {
  const sb = lib().parseSecureBoot(await out('mokutil', ['--sb-state'], 5000));
  if (sb !== null) return sb;
  try {
    const dir = '/sys/firmware/efi/efivars';
    const f = fs.readdirSync(dir).find((n) => n.startsWith('SecureBoot-'));
    if (f) return fs.readFileSync(`${dir}/${f}`).at(-1) === 1;
  } catch {}
  return null;
}

/** The installed NVIDIA driver package from `dpkg-query -W -f='${Status} ${Package}\n' 'nvidia-driver-*'`. */
function installedDriver(text) {
  const { validDriverPkg } = lib();
  for (const line of String(text || '').split('\n')) {
    const m = /^install ok installed (\S+)$/.exec(line.trim());
    if (m && validDriverPkg(m[1])) return m[1];
  }
  return null;
}

/** What the running kernel uses: /proc/driver/nvidia/version first (gives the version), then lsmod. */
function loadedDriver(procText, lsmodText) {
  const { currentDriver } = lib();
  const fromProc = procText ? currentDriver(procText) : null;
  if (fromProc?.module) return { module: fromProc.module, version: fromProc.version || null, open: fromProc.open ?? null };
  const fromMods = currentDriver(lsmodText || '');
  return { module: fromMods?.module || null, version: fromMods?.version || null, open: fromMods?.open ?? null };
}

/** Assemble the drivers:detect answer from the raw outputs (pure: unit-tested). */
function summarize({ lspci, devices, lsmod, procVersion, dpkg }) {
  const { detectGpus, parseUbuntuDrivers, validDriverPkg, recommendedDriver } = lib();
  const gpus = detectGpus(lspci || '');
  const available = parseUbuntuDrivers(devices || '').filter((d) => validDriverPkg(d.pkg));
  const recommended = recommendedDriver(available);
  const current = loadedDriver(procVersion, lsmod);
  const installed = installedDriver(dpkg);
  const n = (p) => /-(\d{3})/.exec(p || '')?.[1] || null;
  // Installed but not running yet, removed but still running, or another version / flavour than the loaded one.
  // (Open vs proprietary kernel modules of the same version: /proc/driver/nvidia/version says which one is loaded.)
  const flavourDiffers = typeof current.open === 'boolean' && /-open$/.test(installed || '') !== current.open;
  const rebootPending = installed ? current.module !== 'nvidia' || (current.version && n(installed) !== current.version.split('.')[0]) || flavourDiffers : current.module === 'nvidia';
  return { gpus, current, available, recommended, installed, rebootPending: !!rebootPending };
}

function register(api) {
  const useMock = api.DEV && process.env.AURORA_REAL_BACKENDS !== '1';
  const live = !!api.env?.live;
  let lastAvailable = null;

  async function detect() {
    let raw;
    let secureBoot;
    let tools;
    if (useMock) {
      const st = dev();
      const m = MACHINES[st.machine];
      raw = {
        lspci: m.lspci,
        devices: st.machine === 'nolists' && (st.listsFetched || adminDev()?.aptListsFetched) ? MACHINES.rtx2060.devices : m.devices,
        lsmod: devLsmod(st),
        procVersion: devProcVersion(st),
        dpkg: st.installed ? `install ok installed ${st.installed}\n` : '',
      };
      secureBoot = process.env.AURORA_DEV_SECUREBOOT === '1';
      tools = { lspci: true, ubuntuDrivers: true };
    } else {
      const [lspci, devices, lsmod, dpkg] = await Promise.all([
        out('lspci', ['-nn', '-mm']),
        out('ubuntu-drivers', ['devices'], 60000),
        out('lsmod', []).then((t) => t ?? readText('/proc/modules')),
        out('dpkg-query', ['-W', '-f=${Status} ${Package}\n', 'nvidia-driver-*']),
      ]);
      raw = { lspci, devices, lsmod, procVersion: readText(PROC_NVIDIA), dpkg };
      secureBoot = await secureBootState();
      tools = { lspci: !!which('lspci'), ubuntuDrivers: !!which('ubuntu-drivers') };
    }
    const s = summarize(raw);
    lastAvailable = s.available;
    return { ...s, online: await isOnline(), secureBoot, live, tools, simulated: useMock };
  }

  api.handle('drivers:detect', detect);

  // Pre-flight of an install: the renderer then runs the returned aurora-admin action through shell.runAdmin
  // (the helper checks everything again as root, against a fresh `ubuntu-drivers devices`).
  api.handle('drivers:install', async (pkg) => {
    const { validDriverPkg } = lib();
    if (typeof pkg !== 'string' || !validDriverPkg(pkg)) throw err('Not an NVIDIA driver package name', 'EINVAL');
    const list = lastAvailable || (await detect()).available;
    if (!list.some((d) => d.pkg === pkg) && !(useMock && dev().machine === 'nolists')) throw err(`${pkg} is not offered for this computer`, 'EINVAL');
    return { action: 'drivers-install', args: [pkg] };
  });
  api.handle('drivers:remove', async () => {
    const st = await detect();
    if (!st.installed) throw err('No NVIDIA driver is installed', 'ENOTSUP');
    return { action: 'drivers-remove', args: [] };
  });

  // Dev helpers for tests: pick another simulated machine (resets the simulated install).
  if (useMock) {
    api.handle('drivers:devSet', async (o = {}) => {
      devState = null;
      if (adminDev()) adminDev().aptListsFetched = false;
      if (o.machine) process.env.AURORA_DEV_GPU = String(o.machine);
      if ('driver' in o) process.env.AURORA_DEV_GPU_DRIVER = o.driver || '';
      if ('offline' in o) process.env.AURORA_DEV_OFFLINE = o.offline ? '1' : '0';
      if ('secureBoot' in o) process.env.AURORA_DEV_SECUREBOOT = o.secureBoot ? '1' : '0';
      if ('fail' in o) process.env.AURORA_DRIVERS_DEV_FAIL = o.fail ? '1' : '0';
      return dev();
    });
  }
}

module.exports = register;
module.exports.devRun = devRun;
module.exports.MACHINES = MACHINES;
module.exports.parsers = { summarize, installedDriver, loadedDriver };
