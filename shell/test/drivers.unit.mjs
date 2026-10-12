// Graphics drivers (Paramètres > Pilotes graphiques): unit tests, no Electron, nothing run as root.
//
//   node test/drivers.unit.mjs
//
// 1. admin.js allow-list for drivers-install / drivers-remove (the UAC path).
// 2. aurora-admin's own checks, run on fixtures: drivers_listed (is the package offered by `ubuntu-drivers devices`?),
//    drivers_nvidia_pkgs (which packages "Revenir au pilote libre" purges) and drivers_status_filter; argument
//    rejection by the real helper when we are root (only cases refused before anything runs).
// 3. main/ipc/drivers.js: summarize() on the shared fixtures (test/fixtures/gpu/*) and on its dev machines,
//    installed / loaded driver, "restart to finish" detection.
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(here, '..', '..');
const HELPER = path.join(REPO, 'rootfs/usr/lib/aurora/helpers/aurora-admin');
const FIX = path.join(here, 'fixtures', 'gpu');
let passed = 0;
const failures = [];
function check(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  ok  ${msg}`);
  } else {
    failures.push(msg);
    console.log(`  FAIL ${msg}`);
  }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fixture = (m, f) => {
  try {
    return fs.readFileSync(path.join(FIX, m, f), 'utf8');
  } catch {
    return null;
  }
};

// ===================================================================== 1. admin.js allow-list
console.log('# admin.js: drivers-install / drivers-remove');
{
  const { parsers: ad } = require('../main/ipc/admin.js');
  const ok = (a, args) => {
    try {
      return ad.validate(a, args).args;
    } catch (e) {
      return e.code;
    }
  };
  check(['nvidia-driver-580', 'nvidia-driver-580-open', 'nvidia-driver-535-server', 'nvidia-driver-535-server-open', 'nvidia-driver-470'].every((p) => eq(ok('drivers-install', [p]), [p])), 'drivers-install accepts the four NVIDIA flavours');
  const bad = ['nvidia-driver-58', 'nvidia-driver-5800', 'nvidia-driver-580-beta', 'nvidia-driver-580;reboot', 'nvidia-driver-580 ', '-nvidia-driver-580', 'xserver-xorg-video-nouveau', 'nvidia-driver-580-open-', 'linux-modules-nvidia-580-generic', '', 'nvidia-driver-580\n'];
  check(bad.every((p) => ok('drivers-install', [p]) === 'EINVAL'), 'drivers-install refuses anything else (other packages, options, separators, line breaks)');
  check(ok('drivers-install', []) === 'EINVAL' && ok('drivers-install', ['nvidia-driver-580', 'nvidia-driver-570']) === 'EINVAL', 'drivers-install takes exactly one package');
  check(eq(ok('drivers-remove', []), []) && ok('drivers-remove', ['nvidia-driver-580']) === 'EINVAL', 'drivers-remove takes no argument');
  check(ad.ACTIONS['drivers-install'].stream && ad.ACTIONS['drivers-install'].timeout === 0 && ad.ACTIONS['drivers-remove'].stream, 'both stream their progress and have no time limit (downloads)');
  const he = (stderr, exit) => ad.helperError(Object.assign(new Error('x'), { code: 'ECMD', result: { code: exit, stderr, stdout: '' } }));
  const e4 = he('aurora-admin: nvidia-driver-999 is not offered for the graphics card of this computer\n', 4);
  check(e4.code === 'EPERM' && /not offered/.test(e4.message) && he('aurora-admin: removing the NVIDIA driver would also remove: cuda-12\n', 6).message.includes('would also remove: cuda-12'), 'helper refusals become readable errors');
}

// ===================================================================== 2. aurora-admin on fixtures
console.log('\n# aurora-admin: drivers checks on fixtures');
const src = fs.readFileSync(HELPER, 'utf8');
const fnOf = (name) => new RegExp(`^ {2}${name}\\(\\) \\{\\n[\\s\\S]*?\\n {2}\\}\\n`, 'm').exec(src)?.[0];
const fns = ['drivers_listed', 'drivers_nvidia_pkgs', 'drivers_status_filter'].map(fnOf);
check(fns.every(Boolean), 'aurora-admin defines drivers_listed, drivers_nvidia_pkgs, drivers_status_filter');
const bash = (script, input, ...args) => spawnSync('bash', ['-c', `set -euo pipefail\n${fns.join('')}\n${script}`, 'x', ...args], { input, encoding: 'utf8' });
const listed = (text, pkg) => bash('drivers_listed "$1"', text, pkg).status === 0;
{
  const gd = require('../main/lib/gpu-drivers.js');
  const machines = fs.existsSync(FIX) ? fs.readdirSync(FIX).filter((m) => fs.existsSync(path.join(FIX, m, 'ubuntu-drivers.txt'))) : [];
  check(machines.length >= 6, `shared fixtures present (${machines.join(', ')})`);
  const mismatch = [];
  for (const m of machines) {
    const text = fixture(m, 'ubuntu-drivers.txt');
    const offered = gd.parseUbuntuDrivers(text).filter((d) => gd.validDriverPkg(d.pkg)).map((d) => d.pkg);
    for (const p of offered) if (!listed(text, p)) mismatch.push(`${m}: ${p} refused`);
    for (const p of ['nvidia-driver-999', 'nvidia-driver-580-server-open-x', 'distro', 'non-free', 'recommended', ':']) if (listed(text, p)) mismatch.push(`${m}: ${p} accepted`);
  }
  check(!mismatch.length, `drivers_listed accepts exactly the drivers ubuntu-drivers offers, on every fixture${mismatch.length ? ` (${mismatch.join('; ')})` : ''}`);
  const g1060 = fixture('gtx1060', 'ubuntu-drivers.txt') || '';
  check(!listed(g1060, 'nvidia-driver-580-open') && !listed(fixture('amd', 'ubuntu-drivers.txt') || '', 'nvidia-driver-580') && !listed('', 'nvidia-driver-580'), 'GTX 1060: no -open driver offered; AMD / no output: nothing offered');
  const r2060 = fixture('rtx2060', 'ubuntu-drivers.txt') || '';
  check(gd.parseUbuntuDrivers(r2060).some((d) => d.kind === 'open' && listed(r2060, d.pkg)), 'RTX 2060 (Turing): an -open driver is offered and accepted');

  const dpkg = [
    'install ok installed nvidia-driver-580-open',
    'install ok installed libnvidia-gl-580',
    'install ok installed libnvidia-cfg1-580',
    'install ok installed nvidia-kernel-common-580',
    'install ok installed nvidia-firmware-580-580.95.05',
    'install ok installed nvidia-utils-580',
    'install ok installed xserver-xorg-video-nvidia-580',
    'install ok installed linux-modules-nvidia-580-open-generic',
    'install ok installed linux-modules-nvidia-580-open-6.8.0-85-generic',
    'install ok installed linux-objects-nvidia-580-open-6.8.0-85-generic',
    'install ok installed linux-signatures-nvidia-6.8.0-85-generic',
    'install ok installed nvidia-prime',
    'install ok installed nvidia-settings',
    'deinstall ok config-files nvidia-kernel-common-570',
    'install ok installed nvidia-cuda-toolkit',
    'install ok installed ubuntu-drivers-common',
    'install ok installed xserver-xorg-video-nouveau',
    'install ok installed libnvidia-container1',
    'install ok installed screen-resolution-extra',
    'install ok not-installed nvidia-driver-570',
  ].join('\n');
  const purged = bash('drivers_nvidia_pkgs', `${dpkg}\n`).stdout.trim().split('\n');
  check(
    eq(purged, [
      'nvidia-driver-580-open',
      'libnvidia-gl-580',
      'libnvidia-cfg1-580',
      'nvidia-kernel-common-580',
      'nvidia-firmware-580-580.95.05',
      'nvidia-utils-580',
      'xserver-xorg-video-nvidia-580',
      'linux-modules-nvidia-580-open-generic',
      'linux-modules-nvidia-580-open-6.8.0-85-generic',
      'linux-objects-nvidia-580-open-6.8.0-85-generic',
      'linux-signatures-nvidia-6.8.0-85-generic',
      'nvidia-prime',
      'nvidia-settings',
      'nvidia-kernel-common-570',
    ]),
    `drivers_nvidia_pkgs: the driver packages (and left-over configuration), never CUDA, nouveau, ubuntu-drivers or container tools${eq(purged, []) ? '' : ` (${purged.join(' ')})`}`,
  );
  const f = bash('drivers_status_filter', 'Reading package lists...\ndlstatus:1:10.0000:Retrieving file 1 of 9\npmstatus:nvidia-utils-580:42.0000:Unpacking nvidia-utils-580\nSetting up nvidia-utils-580 ...\npmerror:x:1:failed\n');
  check(f.stdout === 'dlstatus:1:10.0000:Retrieving file 1 of 9\npmstatus:nvidia-utils-580:42.0000:Unpacking nvidia-utils-580\npmerror:x:1:failed\n' && /Reading package lists/.test(f.stderr) && /Setting up/.test(f.stderr), 'drivers_status_filter: APT status lines on stdout (progress bar), apt chatter on stderr');
  check(/ubuntu-drivers install "nvidia:\$\{pkg#nvidia-driver-\}"/.test(src) && gd.driverSpec('nvidia-driver-535-server-open') === 'nvidia:535-server-open', 'install goes through `ubuntu-drivers install nvidia:NNN[-flavour]` (Canonical-signed prebuilt modules)');
  const block = src.slice(src.indexOf('\ndrivers-install | drivers-remove)'));
  const order = ['[[ $pkg =~ ^nvidia-driver-[0-9]{3}(-open|-server|-server-open)?$ ]]', 'apt-get -q -o DPkg::Lock::Timeout=120 update', 'drivers_listed "$pkg"', 'ubuntu-drivers install'].map((x) => block.indexOf(x));
  check(order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1])), 'helper order: strict name check, apt-get update, offered by ubuntu-drivers, then install');
  if (spawnSync('which', ['shellcheck']).status === 0) check(spawnSync('shellcheck', [HELPER]).status === 0, 'aurora-admin passes shellcheck');
  if (process.getuid?.() === 0) {
    // Only cases refused before anything runs (no apt, no dpkg).
    const run = (...a) => spawnSync(HELPER, a, { encoding: 'utf8', input: '' });
    const cases = [
      [['drivers-install'], 2],
      [['drivers-install', 'nvidia-driver-580;reboot'], 2],
      [['drivers-install', 'xserver-xorg-video-nouveau'], 2],
      [['drivers-install', '--reinstall'], 2],
      [['drivers-install', 'nvidia-driver-580', 'extra'], 2],
      [['drivers-remove', 'nvidia-driver-580'], 2],
    ];
    const wrong = cases.filter(([a, code]) => run(...a).status !== code);
    check(!wrong.length, `aurora-admin refuses bad drivers arguments (exit 2)${wrong.length ? ` (wrong: ${wrong.map((w) => w[0].join(' ')).join(' | ')})` : ''}`);
    check(/invalid driver package name/.test(run('drivers-install', 'nvidia-driver-1').stderr), 'readable reason on stderr');
  }
}

// ===================================================================== 3. drivers.js
console.log('\n# drivers.js: detect summary');
{
  const d = require('../main/ipc/drivers.js');
  const { summarize, installedDriver, loadedDriver } = d.parsers;
  const lsmodNouveau = 'Module                  Size  Used by\nnouveau              3096576  12\nttm                   110592  2 drm_ttm_helper,nouveau\n';
  const lsmodNvidia = 'Module                  Size  Used by\nnvidia_drm            135168  4\nnvidia              104071168  52 nvidia_modeset\n';
  const proc = 'NVRM version: NVIDIA UNIX Open Kernel Module for x86_64  580.95.05  Release Build  (dvs-builder@U16-I3-B03-4-3)  Tue Sep 23 09:42:05 UTC 2025\nGCC version:  gcc version 13.3.0 (Ubuntu 13.3.0-6ubuntu2~24.04)\n';
  check(installedDriver('install ok installed nvidia-driver-580-open\n') === 'nvidia-driver-580-open' && installedDriver('deinstall ok config-files nvidia-driver-570\n') === null && installedDriver('install ok installed nvidia-driver-580-beta\n') === null && installedDriver('') === null, 'installed driver from dpkg-query (installed only, strict names)');
  check(eq(loadedDriver(proc, lsmodNvidia), { module: 'nvidia', version: '580.95.05', open: true }) && loadedDriver(null, lsmodNouveau).module === 'nouveau' && loadedDriver(null, '').module === null, 'loaded driver: version from /proc/driver/nvidia/version, else lsmod');

  const S = (m, o = {}) => summarize({ lspci: fixture(m, 'lspci.txt'), devices: fixture(m, 'ubuntu-drivers.txt'), lsmod: fixture(m, 'lsmod.txt') ?? lsmodNouveau, procVersion: fixture(m, 'nvidia-version.txt'), dpkg: '', ...o });
  const r4070 = S('rtx4070');
  check(r4070.gpus.length === 1 && r4070.gpus[0].vendor === 'nvidia' && /RTX 4070/.test(r4070.gpus[0].name) && r4070.recommended && r4070.available.some((x) => x.kind === 'open') && r4070.available.every((x) => x.kind !== 'free'), 'RTX 4070: one NVIDIA card, a recommended driver, -open offered, the free driver kept out of the NVIDIA list');
  check(!r4070.installed && r4070.current.module === 'nouveau' && !r4070.rebootPending, 'RTX 4070 on Nouveau: nothing installed, no restart pending');
  const g = S('gtx1060');
  check(g.available.length > 0 && g.available.every((x) => !/open/.test(x.kind)), 'GTX 1060: proprietary / server drivers only');
  const opt = S('optimus');
  check(opt.gpus.length === 2 && opt.gpus.map((x) => x.vendor).sort().join() === 'intel,nvidia', 'Optimus laptop: Intel + NVIDIA');
  for (const m of ['amd', 'intel']) {
    const x = S(m, { lsmod: '' });
    check(x.gpus.length === 1 && x.gpus[0].vendor === m && !x.available.length && !x.recommended && !x.rebootPending, `${m} only: nothing to install`);
  }
  // restart detection: installed but not loaded, removed but still loaded, another version loaded
  const inst = (pkg) => `install ok installed ${pkg}\n`;
  check(S('rtx4070', { dpkg: inst('nvidia-driver-580-open') }).rebootPending, 'installed, still on Nouveau -> restart pending');
  check(!S('rtx4070', { dpkg: inst('nvidia-driver-580-open'), procVersion: proc, lsmod: lsmodNvidia }).rebootPending, 'installed and loaded -> no restart pending');
  check(S('rtx4070', { dpkg: inst('nvidia-driver-570'), procVersion: proc, lsmod: lsmodNvidia }).rebootPending, 'switched to 570 while 580 is loaded -> restart pending');
  check(S('rtx4070', { dpkg: '', procVersion: proc, lsmod: lsmodNvidia }).rebootPending, 'removed while still loaded -> restart pending');
  check(S('rtx4070', { dpkg: inst('nvidia-driver-580'), procVersion: proc, lsmod: lsmodNvidia }).rebootPending, 'switched from 580 Open to 580 (same version, other kernel modules) -> restart pending');
  check(S('rtx4070', { dpkg: inst('nvidia-driver-580-open'), procVersion: proc.replace('Open Kernel Module for ', ''), lsmod: lsmodNvidia }).rebootPending, 'switched from 580 to 580 Open -> restart pending');
  // dev machines go through the same parsers
  const bad = Object.entries(d.MACHINES).filter(([k, m]) => {
    const x = summarize({ lspci: m.lspci, devices: m.devices, lsmod: '', procVersion: null, dpkg: '' });
    const nv = x.gpus.some((gg) => gg.vendor === 'nvidia');
    return !x.gpus.length || (nv && k !== 'nolists' && !x.recommended) || (!nv && x.available.length);
  });
  check(!bad.length, `dev machines parse like the real ones${bad.length ? ` (${bad.map((b) => b[0]).join(', ')})` : ''}`);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) console.log(failures.map((f) => ` - ${f}`).join('\n'));
process.exit(failures.length ? 1 : 0);
