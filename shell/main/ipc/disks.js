'use strict';
// Disks app backend: drives and partitions (lsblk + df), mount / unmount / power off (udisksctl, no root),
// udev change notifications. Formatting is privileged: the app calls shell.runAdmin('format-removable',
// [device, 'vfat'|'exfat'|'ext4', label]) -> admin.js -> aurora-admin (which re-checks everything).
//
// Channels:
//   disks:list ()            -> { drives: [Drive], simulated, smart: false }
//       Drive = { name, path, model, vendor, serial, rev, size, tran ('usb'|'sata'|'nvme'|'mmc'|…|''), type ('disk'|'rom'),
//                 removable, rotational, readonly, pttype ('gpt'|'dos'|null), system (holds / or the live medium),
//                 mounted (any partition mounted), formattable (removable whole disk that is not the system),
//                 partitions: [Part], fs: Part|null (file system directly on the disk, no partition table) }
//       Part  = { name, path, size, start (bytes, null if unknown), fstype, fsver, label, uuid, partlabel, parttypename,
//                 mountpoint, mountpoints[], size/used/avail of the file system (df, bytes or null), system, swap }
//   disks:mount (partPath)   -> mount point            errors: EINVAL, EMOUNT
//   disks:unmount (partPath) -> true                   errors: EINVAL, EBUSY, EMOUNT
//   disks:powerOff (diskPath)-> true (unmounts every partition first)   errors: EINVAL, EBUSY, EMOUNT
//   disks:watch ()           -> bool (true when udev events are watched; otherwise the app offers Refresh only)
//   disks:devReset ()        -> true (dev/tests only: restore the mocked drives)
// Event: disks:changed {}   (udev block add/remove/change, debounced; mocked actions in dev)
//
// Dev / tests (api.DEV unless AURORA_REAL_BACKENDS=1): a deterministic mocked system (NVMe system disk + SanDisk USB
// stick); actions change the mock. admin.js's simulation of 'format-removable' calls devFormat() below.
const { spawn } = require('child_process');
const { run } = require('../lib/exec');

const DEVICE_RE = /^\/dev\/[A-Za-z0-9._-]{1,64}(\/[A-Za-z0-9._-]{1,64})?$/;
const SYSTEM_MOUNT_RE = /^\/(|boot(\/.*)?|cdrom(\/.*)?|run\/live(\/.*)?|rofs|usr|var|home|media\/root-ro)$/;
const GB = 1e9;
const MiB = 1024 * 1024;

function err(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// ------------------------------------------------------------------ mock system (dev / tests)
function freshMock() {
  return {
    drives: [
      {
        name: 'nvme0n1', path: '/dev/nvme0n1', model: 'Aurora NVMe SSD 512GB', vendor: '', serial: 'AUR0NVME00042', rev: '2B2QEXM7',
        size: 512110190592, tran: 'nvme', type: 'disk', removable: false, rotational: false, readonly: false, pttype: 'gpt',
        partitions: [
          { name: 'nvme0n1p1', path: '/dev/nvme0n1p1', start: MiB, size: 536870912, fstype: 'vfat', fsver: 'FAT32', label: '', uuid: '6A1C-0F3E', partlabel: 'EFI System Partition', parttypename: 'EFI System', mountpoints: ['/boot/efi'], used: 6553600, avail: 530317312 },
          { name: 'nvme0n1p2', path: '/dev/nvme0n1p2', start: MiB + 536870912, size: 494927642624, fstype: 'ext4', fsver: '1.0', label: 'Aurora', uuid: '3f1d2a5e-8a1b-4c77-9d2e-4b1f6e0c2a11', partlabel: '', parttypename: 'Linux filesystem', mountpoints: ['/'], used: 41231686041, avail: 428652000000 },
          { name: 'nvme0n1p3', path: '/dev/nvme0n1p3', start: MiB + 536870912 + 494927642624, size: 16644997120, fstype: 'swap', fsver: '1', label: '', uuid: '0b7f4c2d-1e55-4a0f-9a3a-5c2b9e1d7f60', partlabel: '', parttypename: 'Linux swap', mountpoints: ['[SWAP]'], used: null, avail: null },
        ],
      },
      {
        name: 'sdb', path: '/dev/sdb', model: 'SanDisk Ultra', vendor: 'SanDisk', serial: '4C530001230817115384', rev: '1.00',
        size: 30752636928, tran: 'usb', type: 'disk', removable: true, rotational: false, readonly: false, pttype: 'dos',
        partitions: [
          { name: 'sdb1', path: '/dev/sdb1', start: MiB, size: 30751588352, fstype: 'vfat', fsver: 'FAT32', label: 'USB STICK', uuid: 'B2E4-91C7', partlabel: '', parttypename: 'W95 FAT32 (LBA)', mountpoints: ['/media/user/USB STICK'], used: 9126805504, avail: 21608185856 },
        ],
      },
    ],
  };
}
let mock = freshMock();
let mockNotify = () => {};

function mockFind(path) {
  for (const d of mock.drives) {
    if (d.path === path) return { drive: d, part: null };
    const p = d.partitions.find((x) => x.path === path);
    if (p) return { drive: d, part: p };
  }
  return null;
}

/** Called by admin.js (dev simulation of aurora-admin format-removable). Mirrors the helper's checks. */
async function devFormat(args) {
  const [device, fstype, label] = args;
  const hit = mockFind(device);
  if (!hit) throw err(`no such disk: ${device}`, 'ENOTFOUND');
  if (hit.part) throw err(`${device} is not a whole disk`, 'EINVAL');
  const d = hit.drive;
  if (!d.removable && d.tran !== 'usb') throw err(`${device} is not a removable drive`, 'EPERM');
  if (d.partitions.some((p) => p.mountpoints.some((m) => m === '[SWAP]' || SYSTEM_MOUNT_RE.test(m)))) throw err(`${device} holds the system or the live medium`, 'EPERM');
  await new Promise((r) => setTimeout(r, 600));
  const lab = fstype === 'vfat' ? String(label || '').toUpperCase() : String(label || '');
  d.pttype = 'dos';
  d.partitions = [
    {
      name: `${d.name}1`, path: `${d.path}1`, start: MiB, size: d.size - MiB, fstype, fsver: fstype === 'vfat' ? 'FAT32' : fstype === 'ext4' ? '1.0' : '1.0',
      label: lab, uuid: fstype === 'ext4' ? '9d4c1e2a-7b3f-4e10-8c55-2a6f0b9e1d33' : '5E1A-77C2', partlabel: '',
      parttypename: { vfat: 'W95 FAT32 (LBA)', exfat: 'HPFS/NTFS/exFAT', ext4: 'Linux' }[fstype], mountpoints: [], used: null, avail: null,
    },
  ];
  mock.lastFormat = { device, fstype, label: lab };
  mockNotify();
  return `ok ${d.path}1\n`;
}

// ------------------------------------------------------------------ real system
/** df -B1 -> Map(source -> { size, used, avail, target }) */
async function dfUsage() {
  const map = new Map();
  try {
    const { stdout } = await run('df', ['-B1', '--output=source,size,used,avail,target'], { timeout: 8000 });
    for (const line of stdout.split('\n').slice(1)) {
      const m = /^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line.trim());
      if (m && m[1].startsWith('/dev/')) map.set(m[1], { size: Number(m[2]), used: Number(m[3]), avail: Number(m[4]), target: m[5] });
    }
  } catch {}
  return map;
}

const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const str = (v) => (v == null ? '' : String(v).trim());

/** lsblk -J -b -O JSON + df map -> [Drive] (pure, unit-testable) */
function parseLsblk(json, df = new Map()) {
  const drives = [];
  const mountsOf = (n) => (Array.isArray(n.mountpoints) ? n.mountpoints : [n.mountpoint]).filter((m) => typeof m === 'string' && m);
  const toPart = (n, sector) => {
    const mps = mountsOf(n);
    const u = df.get(n.path);
    const swap = n.fstype === 'swap' && mps.includes('[SWAP]');
    const sys = mps.some((m) => SYSTEM_MOUNT_RE.test(m)) || swap;
    // A crypt / LVM child carries the real file system: report its mount points on the partition.
    const kids = (n.children || []).flatMap((c) => mountsOf(c));
    return {
      name: str(n.name), path: str(n.path), size: num(n.size) || 0, start: n.start != null ? Number(n.start) * sector : null,
      fstype: str(n.fstype), fsver: str(n.fsver), label: str(n.label), uuid: str(n.uuid), partlabel: str(n.partlabel), parttypename: str(n.parttypename),
      mountpoint: mps.find((m) => m !== '[SWAP]') || null, mountpoints: mps.length ? mps : kids,
      used: u ? u.used : num(n.fsused), avail: u ? u.avail : num(n.fsavail), fssize: u ? u.size : num(n.fssize),
      system: sys || kids.some((m) => SYSTEM_MOUNT_RE.test(m)), swap,
    };
  };
  for (const d of json?.blockdevices || []) {
    if (!['disk', 'rom'].includes(d.type)) continue; // loop (snaps, live squashfs), zram, ram…
    if (/^(zram|ram|loop)/.test(d.name || '')) continue;
    if (!num(d.size) && d.type === 'disk') continue;
    const sector = num(d['log-sec']) && d['log-sec'] >= 512 ? 512 : 512; // lsblk START is in 512-byte sectors
    const children = (d.children || []).filter((c) => c.type === 'part' || c.type === 'md');
    const partitions = children.map((c) => toPart(c, sector));
    const fs = !children.length && d.fstype ? toPart(d, sector) : null;
    const all = fs ? [fs] : partitions;
    const tran = str(d.tran).toLowerCase();
    const removable = !!(d.rm || d.hotplug || tran === 'usb' || tran === 'mmc' || /^mmcblk/.test(d.name || ''));
    const system = all.some((p) => p.system) || mountsOf(d).some((m) => SYSTEM_MOUNT_RE.test(m));
    const vendor = /^0x/i.test(str(d.vendor)) ? '' : str(d.vendor);
    let model = str(d.model).replace(/_/g, ' ');
    if (vendor && model && !model.toLowerCase().startsWith(vendor.toLowerCase())) model = `${vendor} ${model}`;
    drives.push({
      name: str(d.name), path: str(d.path), model, vendor, serial: str(d.serial), rev: str(d.rev), size: num(d.size) || 0, tran, type: d.type,
      removable, rotational: !!d.rota, readonly: !!d.ro, pttype: d.pttype || null, system,
      mounted: all.some((p) => p.mountpoints.length), formattable: d.type === 'disk' && removable && !system && !d.ro && /^(sd[a-z]{1,2}|mmcblk\d{1,2})$/.test(d.name || ''),
      partitions, fs,
    });
  }
  return drives;
}

function decorate(drives) {
  for (const d of drives) {
    const all = d.fs ? [d.fs] : d.partitions;
    for (const p of all) {
      p.mountpoint = p.mountpoint ?? (p.mountpoints.find((m) => m !== '[SWAP]') || null);
      p.system = p.system ?? p.mountpoints.some((m) => m === '[SWAP]' || SYSTEM_MOUNT_RE.test(m));
      p.swap = p.swap ?? p.mountpoints.includes('[SWAP]');
      p.fssize = p.fssize ?? (p.used != null && p.avail != null ? p.used + p.avail : null);
    }
    d.fs = d.fs || null;
    d.system = all.some((p) => p.system);
    d.mounted = all.some((p) => p.mountpoints.length);
    d.formattable = d.type === 'disk' && d.removable && !d.system && !d.readonly;
  }
  return drives;
}

// ------------------------------------------------------------------ registration
function register(api) {
  const useMock = api.DEV && process.env.AURORA_REAL_BACKENDS !== '1';
  let watcher = null;
  let timer = null;
  const changed = () => {
    clearTimeout(timer);
    timer = setTimeout(() => api.broadcast('disks:changed', {}), useMock ? 50 : 700);
  };
  if (useMock) mockNotify = changed;

  const checkDevice = (p) => {
    if (typeof p !== 'string' || !DEVICE_RE.test(p) || p.includes('..')) throw err('Invalid device', 'EINVAL');
    return p;
  };

  async function list() {
    if (useMock) return { drives: decorate(JSON.parse(JSON.stringify(mock.drives))), simulated: true, smart: false };
    const [lsblk, df] = await Promise.all([run('lsblk', ['-J', '-b', '-O'], { timeout: 10000 }), dfUsage()]);
    if (lsblk.code !== 0) throw err(lsblk.stderr.trim() || 'lsblk failed', 'ECMD');
    return { drives: parseLsblk(JSON.parse(lsblk.stdout), df), simulated: false, smart: false };
  }

  async function udisks(verb, dev) {
    const r = await run('udisksctl', [verb, '-b', dev, '--no-user-interaction'], { timeout: 30000 }).catch((e) => ({ code: 1, stdout: '', stderr: e.message }));
    if (r.code !== 0) {
      const msg = (r.stderr || r.stdout || `${verb} failed`).trim().replace(/^Error [^:]*:\s*/, '');
      throw err(msg, /busy|target is busy/i.test(msg) ? 'EBUSY' : 'EMOUNT');
    }
    return r.stdout;
  }

  api.handle('disks:list', () => list());

  api.handle('disks:mount', async (dev) => {
    checkDevice(dev);
    if (useMock) {
      const hit = mockFind(dev);
      if (!hit?.part) throw err('Invalid device', 'EINVAL');
      const p = hit.part;
      if (!p.fstype || p.fstype === 'swap') throw err('This partition has no file system that can be mounted', 'EMOUNT');
      if (!p.mountpoints.length) {
        p.mountpoints = [`/media/user/${p.label || p.uuid}`];
        p.used = p.used ?? Math.round(p.size * 0.004);
        p.avail = p.avail ?? p.size - MiB - p.used;
      }
      changed();
      return p.mountpoints[0];
    }
    const out = await udisks('mount', dev);
    const m = /at (.+?)\.?\s*$/.exec(out.trim());
    changed();
    return m ? m[1] : null;
  });

  api.handle('disks:unmount', async (dev) => {
    checkDevice(dev);
    if (useMock) {
      const hit = mockFind(dev);
      if (!hit?.part) throw err('Invalid device', 'EINVAL');
      if (hit.part.mountpoints.some((m) => m === '[SWAP]' || SYSTEM_MOUNT_RE.test(m))) throw err('target is busy', 'EBUSY');
      hit.part.mountpoints = [];
      changed();
      return true;
    }
    await udisks('unmount', dev);
    changed();
    return true;
  });

  api.handle('disks:powerOff', async (dev) => {
    checkDevice(dev);
    if (useMock) {
      const hit = mockFind(dev);
      if (!hit || hit.part) throw err('Invalid device', 'EINVAL');
      if (!hit.drive.removable) throw err('Only removable drives can be ejected', 'EINVAL');
      mock.drives = mock.drives.filter((d) => d !== hit.drive);
      changed();
      return true;
    }
    const { drives } = await list();
    const d = drives.find((x) => x.path === dev);
    if (!d) throw err('Invalid device', 'EINVAL');
    if (d.system) throw err('The system drive cannot be ejected', 'EBUSY');
    for (const p of d.fs ? [d.fs] : d.partitions) if (p.mountpoints.length && !p.swap) await udisks('unmount', p.path);
    await udisks('power-off', dev);
    changed();
    return true;
  });

  api.handle('disks:watch', () => {
    if (useMock) return true;
    if (watcher) return true;
    try {
      watcher = spawn('udevadm', ['monitor', '--udev', '--subsystem-match=block'], { stdio: ['ignore', 'pipe', 'ignore'] });
      watcher.on('error', () => {
        watcher = null;
      });
      watcher.on('exit', () => {
        watcher = null;
      });
      process.once('exit', () => watcher?.kill());
      watcher.stdout.on('data', (b) => {
        if (/\b(add|remove|change)\b/.test(String(b))) changed();
      });
      return true;
    } catch {
      watcher = null;
      return false;
    }
  });

  api.handle('disks:devReset', () => {
    if (!useMock) throw err('Not available', 'EPERM');
    mock = freshMock();
    changed();
    return true;
  });
}

module.exports = register;
module.exports.devFormat = devFormat;
module.exports.parsers = { parseLsblk, decorate };
