// Unit tests of main/lib/gpu-drivers.js (pure parsers) over real `lspci -nn -mm` / `ubuntu-drivers devices` /
// lsmod / /proc/driver/nvidia/version / `mokutil --sb-state` outputs (test/fixtures/gpu/*).
// Usage:  cd aurora-os/shell && node test/gpu-drivers.unit.mjs
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const G = require(path.join(here, '..', 'main', 'lib', 'gpu-drivers.js'));
const FIX = path.join(here, 'fixtures', 'gpu');
const read = (dir, f) => {
  try {
    return fs.readFileSync(path.join(FIX, dir, f), 'utf8');
  } catch {
    return '';
  }
};
let passed = 0;
const failures = [];
function check(name, ok, info) {
  if (ok) passed++;
  else failures.push(`${name}${info !== undefined ? `\n      got: ${typeof info === 'string' ? info : JSON.stringify(info)}` : ''}`);
}
const pkgs = (list) => list.map((d) => d.pkg);

// ---- detectGpus
{
  const g = G.detectGpus(read('rtx4070', 'lspci.txt'));
  check('RTX 4070: one display controller (audio, bridges, NVMe ignored)', g.length === 1, g);
  check('RTX 4070: vendor, ids, slot', g[0]?.vendor === 'nvidia' && g[0].vendorId === '10de' && g[0].deviceId === '2786' && g[0].slot === '01:00.0' && g[0].cls === '0300', g[0]);
  check('RTX 4070: marketing name', g[0]?.name === 'NVIDIA GeForce RTX 4070' && g[0].model === 'AD104 [GeForce RTX 4070]', g[0]);
}
{
  const g = G.detectGpus(read('gtx1060', 'lspci.txt'));
  check('GTX 1060: name', g.length === 1 && g[0].name === 'NVIDIA GeForce GTX 1060 6GB' && g[0].deviceId === '1c03', g);
}
{
  const g = G.detectGpus(read('rtx2060', 'lspci.txt'));
  check('RTX 2060 desktop with the Intel iGPU enabled (0380 display controller): both listed in bus order', g.length === 2 && g[0].vendor === 'intel' && g[0].cls === '0380' && g[1].vendor === 'nvidia', g);
  check('RTX 2060: names', g[0]?.name === 'Intel UHD Graphics 630' && g[1]?.name === 'NVIDIA GeForce RTX 2060 Rev. A', g.map((x) => x.name));
}
{
  const g = G.detectGpus(read('optimus', 'lspci.txt'));
  check('Optimus laptop: Intel VGA + NVIDIA 3D controller (0302)', g.length === 2 && g[0].vendor === 'intel' && g[1].vendor === 'nvidia' && g[1].cls === '0302', g);
  check('Optimus: names', g[0]?.name === 'Intel Iris Xe Graphics' && g[1]?.name === 'NVIDIA GeForce RTX 3050 Mobile', g.map((x) => x.name));
}
{
  const g = G.detectGpus(read('amd', 'lspci.txt'));
  check('AMD only: one AMD card, no NVIDIA', g.length === 1 && g[0].vendor === 'amd' && g[0].vendorId === '1002' && g[0].name.startsWith('AMD Radeon RX 6700'), g);
}
{
  const g = G.detectGpus(read('intel', 'lspci.txt'));
  check('Intel only', g.length === 1 && g[0].vendor === 'intel' && g[0].name === 'Intel UHD Graphics 770', g);
}
{
  const vm = '00:01.0 "VGA compatible controller [0300]" "Device [1234]" "Device [1111]" -r02 "Red Hat, Inc. [1af4]" "Device [1100]"\n00:02.0 "VGA compatible controller [0300]" "Red Hat, Inc. [1af4]" "Virtio 1.0 GPU [1050]" -r01 "Red Hat, Inc. [1af4]" "QEMU [1100]"\n';
  const g = G.detectGpus(vm);
  check('VM: QEMU std VGA / virtio-gpu are "other"', g.length === 2 && g.every((x) => x.vendor === 'other') && g[0].deviceId === '1111' && g[1].name.includes('Virtio 1.0 GPU'), g);
  const nv = G.detectGpus('01:00.0 "VGA compatible controller [0300]" "NVIDIA Corporation [10de]" "Device [2d04]" -ra1 "" ""\n');
  check('unknown NVIDIA device (pci.ids too old): still detected, name with the id', nv.length === 1 && nv[0].vendor === 'nvidia' && nv[0].name === 'NVIDIA 2d04', nv);
  check('garbage / empty input -> []', G.detectGpus('').length === 0 && G.detectGpus(null).length === 0 && G.detectGpus('lspci: command not found').length === 0);
}

// ---- parseUbuntuDrivers
{
  const d = G.parseUbuntuDrivers(read('rtx4070', 'ubuntu-drivers.txt'));
  check('RTX 4070: 6 NVIDIA drivers + nouveau, newest first', JSON.stringify(pkgs(d)) === JSON.stringify(['nvidia-driver-550', 'nvidia-driver-550-open', 'nvidia-driver-535', 'nvidia-driver-535-open', 'nvidia-driver-535-server', 'nvidia-driver-535-server-open', 'xserver-xorg-video-nouveau']), pkgs(d));
  check('RTX 4070: recommended 550 (one only)', d.filter((x) => x.recommended).length === 1 && G.recommendedDriver(d) === 'nvidia-driver-550');
  check('RTX 4070: kinds', d.find((x) => x.pkg === 'nvidia-driver-550').kind === 'proprietary' && d.find((x) => x.pkg === 'nvidia-driver-550-open').kind === 'open' && d.find((x) => x.pkg === 'nvidia-driver-535-server').kind === 'server' && d.find((x) => x.pkg === 'nvidia-driver-535-server-open').kind === 'server-open' && d.find((x) => x.pkg === 'xserver-xorg-video-nouveau').kind === 'free', d);
  check('RTX 4070: version numbers, nouveau builtin', d[0].version === 550 && d.at(-1).version === null && d.at(-1).builtin === true);
}
{
  const d = G.parseUbuntuDrivers(read('gtx1060', 'ubuntu-drivers.txt'));
  check('GTX 1060 (Pascal): no -open driver offered', d.length === 6 && !d.some((x) => x.kind === 'open' || x.kind === 'server-open'), pkgs(d));
  check('GTX 1060: recommended 550, 470 legacy listed', G.recommendedDriver(d) === 'nvidia-driver-550' && pkgs(d).includes('nvidia-driver-470'));
}
{
  const d = G.parseUbuntuDrivers(read('rtx2060', 'ubuntu-drivers.txt'));
  check('RTX 2060 (Turing): -open drivers available', pkgs(d).includes('nvidia-driver-550-open') && pkgs(d).includes('nvidia-driver-535-open') && G.recommendedDriver(d) === 'nvidia-driver-550', pkgs(d));
}
{
  const d = G.parseUbuntuDrivers(read('optimus', 'ubuntu-drivers.txt'));
  check('Optimus: the Wi-Fi driver of another device is not a graphics driver', !pkgs(d).includes('backport-iwlwifi-dkms') && d.length === 7, pkgs(d));
  check('Optimus: recommended 550-open', G.recommendedDriver(d) === 'nvidia-driver-550-open');
}
check('AMD only: empty output -> []', G.parseUbuntuDrivers(read('amd', 'ubuntu-drivers.txt')).length === 0);
check('Intel only: warning line only -> []', G.parseUbuntuDrivers(read('intel', 'ubuntu-drivers.txt')).length === 0);
check('recommendedDriver: none -> null; free recommended -> null', G.recommendedDriver([]) === null && G.recommendedDriver(G.parseUbuntuDrivers('driver   : xserver-xorg-video-nouveau - distro free builtin recommended\n')) === null);
check('parseUbuntuDrivers: third-party and duplicates', JSON.stringify(pkgs(G.parseUbuntuDrivers('driver   : nvidia-driver-560 - third-party non-free recommended\ndriver   : nvidia-driver-560 - distro non-free\n'))) === '["nvidia-driver-560"]');
check('parseUbuntuDrivers: an invalid package name is not a driver', G.parseUbuntuDrivers('driver   : nvidia-driver-550;reboot - distro non-free recommended\ndriver   : nvidia-driver-55 - distro non-free\n').length === 0);

// ---- validDriverPkg
for (const ok of ['nvidia-driver-550', 'nvidia-driver-550-open', 'nvidia-driver-535-server', 'nvidia-driver-535-server-open', 'nvidia-driver-470']) check(`validDriverPkg accepts ${ok}`, G.validDriverPkg(ok) === true);
for (const bad of ['nvidia-driver-55', 'nvidia-driver-5500', 'nvidia-driver-550-beta', 'nvidia-driver-550 ', ' nvidia-driver-550', 'nvidia-driver-550\n', 'nvidia-driver-550;reboot', 'nvidia-driver-550-open-server', 'xserver-xorg-video-nouveau', 'nvidia-dkms-550', '', null, 550, ['nvidia-driver-550']]) {
  check(`validDriverPkg refuses ${JSON.stringify(bad)}`, G.validDriverPkg(bad) === false);
}
check('driverSpec: ubuntu-drivers install argument', G.driverSpec('nvidia-driver-550') === 'nvidia:550' && G.driverSpec('nvidia-driver-550-open') === 'nvidia:550-open' && G.driverSpec('nvidia-driver-535-server-open') === 'nvidia:535-server-open' && G.driverSpec('bad') === null);

// ---- currentDriver
{
  const a = G.currentDriver(read('rtx4070', 'lsmod.txt'));
  check('lsmod with nouveau', a.module === 'nouveau' && a.version === null, a);
  const b = G.currentDriver(read('rtx2060', 'lsmod.txt'));
  check('lsmod with nvidia (nvidia_drm alone is not enough: the "nvidia" line)', b.module === 'nvidia' && b.version === null, b);
  const c = G.currentDriver(read('rtx2060', 'nvidia-version.txt'));
  check('/proc/driver/nvidia/version (proprietary)', c.module === 'nvidia' && c.version === '550.120' && c.open === false, c);
  const o = G.currentDriver('NVRM version: NVIDIA UNIX Open Kernel Module for x86_64  550.120  Release Build  (dvs-builder@U16-I3-B03-4-3)  Fri Sep 13 10:12:38 UTC 2024\nGCC version:  gcc version 13.2.0 (Ubuntu 13.2.0-23ubuntu4)\n');
  check('/proc/driver/nvidia/version (open kernel module)', o.module === 'nvidia' && o.version === '550.120' && o.open === true, o);
  check('no GPU module', G.currentDriver('Module                  Size  Used by\ni915  4268032  2\n').module === null && G.currentDriver('').module === null);
  check('nvidia_drm without nvidia is not "nvidia"', G.currentDriver('nvidia_drm 1 0\n').module === null);
}

// ---- parseSecureBoot
check('mokutil: enabled / disabled / unsupported', G.parseSecureBoot('SecureBoot enabled\n') === true && G.parseSecureBoot('SecureBoot disabled\nPlatform is in Setup Mode\n') === false && G.parseSecureBoot('EFI variables are not supported on this system\n') === null);
check('fixtures: Secure Boot states', G.parseSecureBoot(read('rtx4070', 'sb-state.txt')) === true && G.parseSecureBoot(read('gtx1060', 'sb-state.txt')) === false);

console.log(`\ngpu-drivers unit tests: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL ${f}`);
process.exit(failures.length ? 1 : 0);
