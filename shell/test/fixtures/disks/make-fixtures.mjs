// Writes the Disks app's health fixtures: what `busctl --system --json=short` prints for udisks2 2.10 (Ubuntu 24.04)
// on a few typical machines, plus `lsblk -J -b -O` and `smartctl -j -a` answers. Property names, D-Bus types and
// values follow the udisks2 D-Bus API (data/org.freedesktop.UDisks2.xml of udisks-2.10.1) and what libatasmart /
// libblockdev-nvme put in them (SmartGetAttributes a(ysqiiixia{sv}) rows: id, name, flags, value, worst, threshold,
// pretty, pretty_unit, expansion; NVMe a{sv} keys); busctl's JSON wraps every variant as { "type", "data" } and
// prints byte arrays ('ay', e.g. Block.Device) as arrays of numbers ending with 0.
//
//   node test/fixtures/disks/make-fixtures.mjs        (rewrites default/ and health/; the JSON files are committed)
//
// default/  the dev desktop's two drives (main/ipc/disks.js freshMock): healthy NVMe + USB stick without SMART.
// health/   AURORA_DISKS_FIXTURE=health (test/disks-health.test.mjs): healthy NVMe (system), worn NVMe (98 % used,
//           spare below its threshold: critical warning "spare"), healthy SATA SSD, failing HDD (pending + reallocated
//           sectors, the drive's own verdict FAILED, last self-test read error), USB stick (no SMART), USB NVMe
//           enclosure (nothing in udisks; smartctl -j -a answer in smartctl.json), HDD with an extended self-test in
//           progress, virtio disk (virtual machine).
// The "fake" key of udisks.json is not busctl output: it tells test/fixtures/disks/fake-busctl.js how to simulate a
// drive (self-test result, a test that stays in progress).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MiB = 1048576;
const UPDATED = 1792000000; // SmartUpdated as udisks sets it (seconds); fake-busctl.js moves it to "2 minutes ago"

// ---------------------------------------------------------------- D-Bus types of the properties we emit
const TYPES = {
  'org.freedesktop.UDisks2.Manager': { Version: 's', SupportedFilesystems: 'as', SupportedEncryptionTypes: 'as', DefaultEncryptionType: 's' },
  'org.freedesktop.UDisks2.Drive': {
    Vendor: 's', Model: 's', Revision: 's', Serial: 's', WWN: 's', Id: 's', Media: 's', MediaCompatibility: 'as', MediaRemovable: 'b',
    MediaAvailable: 'b', MediaChangeDetected: 'b', Size: 't', TimeDetected: 't', TimeMediaDetected: 't', Optical: 'b', OpticalBlank: 'b',
    RotationRate: 'i', ConnectionBus: 's', Seat: 's', Removable: 'b', Ejectable: 'b', SortKey: 's', CanPowerOff: 'b', SiblingId: 's',
  },
  'org.freedesktop.UDisks2.Drive.Ata': {
    SmartSupported: 'b', SmartEnabled: 'b', SmartUpdated: 't', SmartFailing: 'b', SmartPowerOnSeconds: 't', SmartTemperature: 'd',
    SmartNumAttributesFailing: 'i', SmartNumAttributesFailedInThePast: 'i', SmartNumBadSectors: 'x', SmartSelftestStatus: 's',
    SmartSelftestPercentRemaining: 'i', PmSupported: 'b', PmEnabled: 'b', ApmSupported: 'b', ApmEnabled: 'b', AamSupported: 'b',
    AamEnabled: 'b', AamVendorRecommendedValue: 'i', WriteCacheSupported: 'b', WriteCacheEnabled: 'b', ReadLookaheadSupported: 'b',
    ReadLookaheadEnabled: 'b', SecurityEraseUnitMinutes: 'i', SecurityEnhancedEraseUnitMinutes: 'i', SecurityFrozen: 'b',
  },
  'org.freedesktop.UDisks2.NVMe.Controller': {
    State: 's', ControllerID: 'q', SubsystemNQN: 'ay', FGUID: 's', NVMeRevision: 's', UnallocatedCapacity: 't', SmartUpdated: 't',
    SmartCriticalWarning: 'as', SmartPowerOnHours: 't', SmartTemperature: 'q', SmartSelftestStatus: 's', SmartSelftestPercentRemaining: 'i',
    SanitizeStatus: 's', SanitizePercentRemaining: 'i',
  },
  'org.freedesktop.UDisks2.Block': {
    Device: 'ay', PreferredDevice: 'ay', Symlinks: 'aay', DeviceNumber: 't', Id: 's', Size: 't', ReadOnly: 'b', Drive: 'o', MDRaid: 'o',
    MDRaidMember: 'o', IdUsage: 's', IdType: 's', IdVersion: 's', IdLabel: 's', IdUUID: 's', CryptoBackingDevice: 'o', HintPartitionable: 'b',
    HintSystem: 'b', HintIgnore: 'b', HintAuto: 'b', HintName: 's', HintIconName: 's', HintSymbolicIconName: 's', UserspaceMountOptions: 'as',
  },
  'org.freedesktop.UDisks2.PartitionTable': { Partitions: 'ao', Type: 's' },
  'org.freedesktop.UDisks2.Partition': { Number: 'u', Type: 's', Flags: 't', Offset: 't', Size: 't', Name: 's', UUID: 's', Table: 'o', IsContainer: 'b', IsContained: 'b' },
  'org.freedesktop.UDisks2.Filesystem': { MountPoints: 'aay', Size: 't' },
  'org.freedesktop.UDisks2.Swapspace': { Active: 'b' },
  'org.freedesktop.UDisks2.NVMe.Namespace': { NSID: 'u', NGUID: 's', EUI64: 's', UUID: 's', WWN: 's', NamespaceSize: 't', NamespaceCapacity: 't', NamespaceUtilization: 't', FormatPercentRemaining: 'i' },
};
const NVME_ATTR_TYPES = {
  avail_spare: 'y', spare_thresh: 'y', percent_used: 'y', total_data_read: 't', total_data_written: 't', ctrl_busy_time: 't', power_cycles: 't',
  unsafe_shutdowns: 't', media_errors: 't', num_err_log_entries: 't', temp_sensors: 'aq', wctemp: 'q', cctemp: 'q', warning_temp_time: 'u', critical_temp_time: 'u',
};
const bytes = (s) => [...Buffer.from(String(s), 'utf8'), 0];
function wrap(type, value) {
  if (type === 'ay') return { type, data: bytes(value) };
  if (type === 'aay') return { type, data: value.map(bytes) };
  return { type, data: value };
}
function iface(name, props) {
  const t = TYPES[name];
  const out = {};
  for (const [k, v] of Object.entries(props)) {
    if (!t[k]) throw new Error(`no D-Bus type for ${name}.${k}`);
    out[k] = wrap(t[k], v);
  }
  return out;
}
const escapeId = (s) => s.replace(/[^A-Za-z0-9]/g, '_');

// ---------------------------------------------------------------- ATA SMART attribute rows (libatasmart)
// pretty units: 0 unknown (no pretty value), 1 none, 2 ms, 3 sectors, 4 mK, 5 small %, 6 %, 7 MB.
const NAMES = {
  1: 'raw-read-error-rate', 3: 'spin-up-time', 4: 'start-stop-count', 5: 'reallocated-sector-count', 7: 'seek-error-rate', 9: 'power-on-hours',
  10: 'spin-retry-count', 11: 'calibration-retry-count', 12: 'power-cycle-count', 177: 'wear-leveling-count', 179: 'used-reserved-blocks-total',
  181: 'program-fail-count-total', 182: 'erase-fail-count-total', 183: 'runtime-bad-block-total', 187: 'reported-uncorrect',
  190: 'airflow-temperature-celsius', 192: 'power-off-retract-count', 193: 'load-cycle-count', 194: 'temperature-celsius-2',
  195: 'hardware-ecc-recovered', 196: 'reallocated-event-count', 197: 'current-pending-sector', 198: 'offline-uncorrectable',
  199: 'udma-crc-error-count', 200: 'multi-zone-error-rate', 235: 'good-block-rate', 241: 'total-lbas-written',
};
const UNITS = { 3: 2, 5: 3, 9: 2, 187: 3, 190: 4, 194: 4, 197: 3, 198: 3, 235: 0, 241: 7 };
const H = 3600000;
const mK = (c) => c * 1000 + 273150;
const lbasToMB = (lbas) => Math.floor((lbas * 33554432) / 1e6); // libatasmart's (wrong for most drives) 32 MiB-unit guess
function attr(id, flags, value, worst, threshold, raw) {
  const unit = UNITS[id] ?? 1;
  const pretty = unit === 0 ? 0 : id === 9 ? raw * H : id === 190 || id === 194 ? mK(raw) : id === 241 ? lbasToMB(raw) : raw;
  return [id, NAMES[id] || `attribute-${id}`, flags, value, worst, threshold, pretty, unit, {}];
}

// ---------------------------------------------------------------- drives
function nvmeDrive({ name, model, serial, rev, size, poh, tempK, warnings = [], selftest = 'success', pct = -1, a }) {
  return {
    name, model, serial, rev, size, bus: '', rotation: 0, removable: false, vendor: '',
    nvme: {
      State: 'live', ControllerID: 1, SubsystemNQN: `nqn.2014.08.org.nvmexpress:144d144d${serial}${model}`, FGUID: '', NVMeRevision: '2.0',
      UnallocatedCapacity: 0, SmartUpdated: UPDATED, SmartCriticalWarning: warnings, SmartPowerOnHours: poh, SmartTemperature: tempK,
      SmartSelftestStatus: selftest, SmartSelftestPercentRemaining: pct, SanitizeStatus: 'never_sanitized', SanitizePercentRemaining: -1,
    },
    nvmeAttrs: Object.fromEntries(Object.entries(a).map(([k, v]) => [k, { type: NVME_ATTR_TYPES[k], data: v }])),
  };
}
function ataDrive({ name, model, serial, rev, size, rotation, poh, tempC, failing = false, failingAttrs = 0, failedPast = 0, bad = 0, selftest = 'success', pct = 0, attrs }) {
  return {
    name, model, serial, rev, size, bus: '', rotation, removable: false, vendor: '',
    ata: {
      SmartSupported: true, SmartEnabled: true, SmartUpdated: UPDATED, SmartFailing: failing, SmartPowerOnSeconds: poh * 3600,
      SmartTemperature: tempC + 273.15, SmartNumAttributesFailing: failingAttrs, SmartNumAttributesFailedInThePast: failedPast,
      SmartNumBadSectors: bad, SmartSelftestStatus: selftest, SmartSelftestPercentRemaining: pct, PmSupported: true, PmEnabled: true,
      ApmSupported: rotation > 0, ApmEnabled: false, AamSupported: false, AamEnabled: false, AamVendorRecommendedValue: 0,
      WriteCacheSupported: true, WriteCacheEnabled: true, ReadLookaheadSupported: true, ReadLookaheadEnabled: true,
      SecurityEraseUnitMinutes: rotation > 0 ? 112 : 2, SecurityEnhancedEraseUnitMinutes: rotation > 0 ? 0 : 8, SecurityFrozen: true,
    },
    attrs,
  };
}

function buildObjects(lsblk, drives) {
  const objects = {
    '/org/freedesktop/UDisks2/Manager': {
      'org.freedesktop.UDisks2.Manager': iface('org.freedesktop.UDisks2.Manager', {
        Version: '2.10.1', SupportedFilesystems: ['nilfs2', 'btrfs', 'swap', 'ext3', 'udf', 'xfs', 'f2fs', 'ext2', 'exfat', 'ntfs', 'ext4', 'vfat', 'reiserfs'],
        SupportedEncryptionTypes: ['luks1', 'luks2'], DefaultEncryptionType: 'luks1',
      }),
    },
  };
  const attributes = {};
  const fake = {};
  let devnum = 2049;
  for (const b of lsblk.blockdevices) {
    const d = drives[b.name] || null;
    let drivePath = '/';
    if (d) {
      drivePath = `/org/freedesktop/UDisks2/drives/${escapeId([d.vendor, d.model, d.serial].filter(Boolean).join('_'))}`;
      const o = {
        'org.freedesktop.UDisks2.Drive': iface('org.freedesktop.UDisks2.Drive', {
          Vendor: d.vendor, Model: d.model, Revision: d.rev, Serial: d.serial, WWN: d.nvme ? `eui.${d.serial.toLowerCase().padEnd(16, '0').slice(0, 16)}` : '',
          Id: escapeId([d.vendor, d.model, d.serial].filter(Boolean).join('-')).replace(/_/g, '-'), Media: d.removable ? 'thumb' : '',
          MediaCompatibility: d.removable ? ['thumb'] : [], MediaRemovable: !!d.removable, MediaAvailable: true, MediaChangeDetected: true,
          Size: d.size, TimeDetected: 1791990000000000, TimeMediaDetected: 1791990000000000, Optical: false, OpticalBlank: false,
          RotationRate: d.rotation, ConnectionBus: d.bus, Seat: 'seat0', Removable: !!d.removable || d.bus === 'usb', Ejectable: d.bus === 'usb',
          SortKey: `01hotplug/${b.name}`, CanPowerOff: d.bus === 'usb', SiblingId: '',
        }),
      };
      if (d.ata) {
        o['org.freedesktop.UDisks2.Drive.Ata'] = iface('org.freedesktop.UDisks2.Drive.Ata', d.ata);
        attributes[drivePath] = { type: 'a(ysqiiixia{sv})', data: [d.attrs] };
      }
      if (d.nvme) {
        o['org.freedesktop.UDisks2.NVMe.Controller'] = iface('org.freedesktop.UDisks2.NVMe.Controller', d.nvme);
        attributes[drivePath] = { type: 'a{sv}', data: [d.nvmeAttrs] };
      }
      if (d.fake) fake[drivePath] = d.fake;
      objects[drivePath] = o;
    }
    const blockPath = `/org/freedesktop/UDisks2/block_devices/${b.name}`;
    const children = b.children || [];
    const blk = {
      'org.freedesktop.UDisks2.Block': iface('org.freedesktop.UDisks2.Block', {
        Device: b.path, PreferredDevice: b.path, Symlinks: d?.serial ? [`/dev/disk/by-id/${escapeId(d.model)}_${d.serial}`] : [], DeviceNumber: devnum,
        Id: d ? `by-id-${escapeId(d.model)}_${d.serial}` : '', Size: b.size, ReadOnly: false, Drive: drivePath, MDRaid: '/', MDRaidMember: '/',
        IdUsage: '', IdType: '', IdVersion: '', IdLabel: '', IdUUID: '', CryptoBackingDevice: '/', HintPartitionable: true,
        HintSystem: !(d?.bus === 'usb' || d?.removable), HintIgnore: false, HintAuto: d?.bus === 'usb', HintName: '', HintIconName: '',
        HintSymbolicIconName: '', UserspaceMountOptions: [],
      }),
      'org.freedesktop.UDisks2.PartitionTable': iface('org.freedesktop.UDisks2.PartitionTable', {
        Partitions: children.map((c) => `/org/freedesktop/UDisks2/block_devices/${c.name}`), Type: b.pttype || 'gpt',
      }),
    };
    if (d?.nvme) {
      blk['org.freedesktop.UDisks2.NVMe.Namespace'] = iface('org.freedesktop.UDisks2.NVMe.Namespace', {
        NSID: 1, NGUID: '', EUI64: '', UUID: '', WWN: '', NamespaceSize: b.size / 512, NamespaceCapacity: b.size / 512, NamespaceUtilization: Math.floor(b.size / 1024), FormatPercentRemaining: -1,
      });
    }
    objects[blockPath] = blk;
    devnum += 16;
    children.forEach((c, i) => {
      const p = {
        'org.freedesktop.UDisks2.Block': iface('org.freedesktop.UDisks2.Block', {
          Device: c.path, PreferredDevice: c.path, Symlinks: c.uuid ? [`/dev/disk/by-uuid/${c.uuid}`] : [], DeviceNumber: devnum + i + 1, Id: c.uuid ? `by-uuid-${c.uuid}` : '',
          Size: c.size, ReadOnly: false, Drive: drivePath, MDRaid: '/', MDRaidMember: '/', IdUsage: c.fstype === 'swap' ? 'other' : 'filesystem',
          IdType: c.fstype || '', IdVersion: c.fsver || '', IdLabel: c.label || '', IdUUID: c.uuid || '', CryptoBackingDevice: '/', HintPartitionable: true,
          HintSystem: !(d?.bus === 'usb' || d?.removable), HintIgnore: false, HintAuto: d?.bus === 'usb', HintName: '', HintIconName: '',
          HintSymbolicIconName: '', UserspaceMountOptions: [],
        }),
        'org.freedesktop.UDisks2.Partition': iface('org.freedesktop.UDisks2.Partition', {
          Number: i + 1, Type: c.parttype || '0fc63daf-8483-4772-8e79-3d69d8477de4', Flags: 0, Offset: c.start * 512, Size: c.size, Name: c.partlabel || '',
          UUID: c.partuuid || '', Table: blockPath, IsContainer: false, IsContained: false,
        }),
      };
      if (c.fstype === 'swap') p['org.freedesktop.UDisks2.Swapspace'] = iface('org.freedesktop.UDisks2.Swapspace', { Active: true });
      else if (c.fstype) p['org.freedesktop.UDisks2.Filesystem'] = iface('org.freedesktop.UDisks2.Filesystem', { MountPoints: (c.mountpoints || []).filter(Boolean), Size: c.fssize || 0 });
      objects[`/org/freedesktop/UDisks2/block_devices/${c.name}`] = p;
    });
  }
  return { managedObjects: { type: 'a{oa{sa{sv}}}', data: [objects] }, attributes, fake };
}

// ---------------------------------------------------------------- lsblk helpers
function part(disk, n, { start, size, fstype = '', fsver = '', label = null, uuid = null, partlabel = null, parttypename = 'Linux filesystem', mount = null, used = null }) {
  const sep = /\d$/.test(disk) ? 'p' : '';
  const fssize = mount && fstype !== 'swap' ? size - MiB : null;
  return {
    name: `${disk}${sep}${n}`, path: `/dev/${disk}${sep}${n}`, type: 'part', size, start, fstype, fsver, label, uuid, partlabel, parttypename,
    mountpoints: mount ? [mount] : [null], fssize, fsused: mount && used != null ? used : null, fsavail: mount && used != null ? fssize - used : null,
  };
}
function disk(name, { size, model, vendor = null, serial, rev, tran, rm = false, hotplug = false, rota = false, pttype = 'gpt', parts = [] }) {
  return { name, path: `/dev/${name}`, type: 'disk', size, model, vendor, serial, rev, tran, rm, hotplug, rota, ro: false, pttype, 'log-sec': 512, children: parts };
}
const GB = 1e9;
const write = (rel, data) => {
  fs.mkdirSync(path.dirname(path.join(HERE, rel)), { recursive: true });
  // Arrays of numbers (byte arrays, attribute rows) on one line each, to keep the files readable.
  const text = JSON.stringify(data, null, 1).replace(/\[\s*(-?[\d.]+(?:,\s*-?[\d.]+)*)\s*\]/g, (m, inner) => `[${inner.replace(/\s+/g, '')}]`);
  fs.writeFileSync(path.join(HERE, rel), `${text}\n`);
  console.log(`wrote ${rel}`);
};

// ================================================================ default: the dev desktop (freshMock in disks.js)
{
  const lsblk = {
    blockdevices: [
      disk('nvme0n1', { size: 512110190592, model: 'Aurora NVMe SSD 512GB', serial: 'AUR0NVME00042', rev: '2B2QEXM7', tran: 'nvme', parts: [
        part('nvme0n1', 1, { start: 2048, size: 536870912, fstype: 'vfat', fsver: 'FAT32', uuid: '6A1C-0F3E', partlabel: 'EFI System Partition', parttypename: 'EFI System', mount: '/boot/efi', used: 6553600 }),
        part('nvme0n1', 2, { start: 1050624, size: 494927642624, fstype: 'ext4', fsver: '1.0', label: 'Aurora', uuid: '3f1d2a5e-8a1b-4c77-9d2e-4b1f6e0c2a11', mount: '/', used: 41231686041 }),
        part('nvme0n1', 3, { start: 967710720, size: 16644997120, fstype: 'swap', fsver: '1', uuid: '0b7f4c2d-1e55-4a0f-9a3a-5c2b9e1d7f60', parttypename: 'Linux swap', mount: '[SWAP]' }),
      ] }),
      disk('sdb', { size: 30752636928, model: 'Ultra', vendor: 'SanDisk', serial: '4C530001230817115384', rev: '1.00', tran: 'usb', rm: true, pttype: 'dos', parts: [
        part('sdb', 1, { start: 2048, size: 30751588352, fstype: 'vfat', fsver: 'FAT32', label: 'USB STICK', uuid: 'B2E4-91C7', parttypename: 'W95 FAT32 (LBA)', mount: '/media/user/USB STICK', used: 9126805504 }),
      ] }),
    ],
  };
  const drives = {
    nvme0n1: nvmeDrive({
      name: 'nvme0n1', model: 'Aurora NVMe SSD 512GB', serial: 'AUR0NVME00042', rev: '2B2QEXM7', size: 512110190592, poh: 1530, tempK: 310,
      a: { avail_spare: 100, spare_thresh: 10, percent_used: 3, total_data_read: 12754000000000, total_data_written: 9631000000000, ctrl_busy_time: 912, power_cycles: 688, unsafe_shutdowns: 14, media_errors: 0, num_err_log_entries: 0, temp_sensors: [310, 316, 0, 0, 0, 0, 0, 0], wctemp: 357, cctemp: 361, warning_temp_time: 0, critical_temp_time: 0 },
    }),
    sdb: { name: 'sdb', vendor: 'SanDisk', model: 'Ultra', serial: '4C530001230817115384', rev: '1.00', size: 30752636928, bus: 'usb', rotation: -1, removable: true },
  };
  // freshMock() in disks.js keeps its own literal drives in this mode; lsblk.json is only used to build the udisks answer.
  write('default/udisks.json', buildObjects(lsblk, drives));
}

// ================================================================ health: AURORA_DISKS_FIXTURE=health
{
  const TB1 = 1000204886016;
  const lsblk = {
    blockdevices: [
      disk('sda', { size: TB1, model: 'Samsung SSD 870 EVO 1TB', vendor: 'ATA     ', serial: 'S75BNL0W123456A', rev: 'SVT02B6Q', tran: 'sata', parts: [
        part('sda', 1, { start: 2048, size: TB1 - 2 * MiB, fstype: 'ext4', fsver: '1.0', label: 'Projets', uuid: '5b9e1c2d-3a4f-4e6b-8c7d-9e0f1a2b3c4d', mount: '/media/user/Projets', used: 412e9 }),
      ] }),
      disk('sdb', { size: TB1, model: 'WDC WD10EZEX-08WN4A0', vendor: 'ATA     ', serial: 'WD-WCC6Y5KX1234', rev: '01.01A01', tran: 'sata', rota: true, parts: [
        part('sdb', 1, { start: 2048, size: TB1 - 2 * MiB, fstype: 'ntfs', label: 'Archives', uuid: '4E1A2B3C4D5E6F70', parttypename: 'Microsoft basic data', mount: '/media/user/Archives', used: 731e9 }),
      ] }),
      disk('sdc', { size: 30752636928, model: 'Ultra', vendor: 'SanDisk', serial: '4C530001230817115384', rev: '1.00', tran: 'usb', rm: true, pttype: 'dos', parts: [
        part('sdc', 1, { start: 2048, size: 30751588352, fstype: 'vfat', fsver: 'FAT32', label: 'USB STICK', uuid: 'B2E4-91C7', parttypename: 'W95 FAT32 (LBA)', mount: '/media/user/USB STICK', used: 9126805504 }),
      ] }),
      disk('sdd', { size: TB1, model: 'RTL9210B-CG', vendor: 'Realtek', serial: '012345678906', rev: '1.00', tran: 'usb', hotplug: true, parts: [
        part('sdd', 1, { start: 2048, size: TB1 - 2 * MiB, fstype: 'exfat', fsver: '1.0', label: 'SAUVEGARDE', uuid: '64A1-2B3C', parttypename: 'Microsoft basic data', mount: '/media/user/SAUVEGARDE', used: 388e9 }),
      ] }),
      disk('sde', { size: 4000787030016, model: 'WDC WD40EFRX-68N32N0', vendor: 'ATA     ', serial: 'WD-WCC7K1234567', rev: '82.00A82', tran: 'sata', rota: true, parts: [
        part('sde', 1, { start: 2048, size: 4000787030016 - 2 * MiB, fstype: 'ext4', fsver: '1.0', label: 'Médias', uuid: '8c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f', mount: '/media/user/Médias', used: 2.61e12 }),
      ] }),
      disk('vda', { size: 34359738368, model: null, vendor: '0x1af4', serial: null, rev: null, tran: 'virtio', parts: [
        part('vda', 1, { start: 2048, size: 34359738368 - 2 * MiB, fstype: 'ext4', fsver: '1.0', label: 'vm-data', uuid: '1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b' }),
      ] }),
      disk('nvme0n1', { size: TB1, model: 'Samsung SSD 990 PRO 1TB', serial: 'S6Z1NJ0W412345X', rev: '4B2QJXD7', tran: 'nvme', parts: [
        part('nvme0n1', 1, { start: 2048, size: 536870912, fstype: 'vfat', fsver: 'FAT32', uuid: '7C2D-1E4F', partlabel: 'EFI System Partition', parttypename: 'EFI System', mount: '/boot/efi', used: 6553600 }),
        part('nvme0n1', 2, { start: 1050624, size: 982487367680, fstype: 'ext4', fsver: '1.0', label: 'Selene', uuid: '2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d', mount: '/', used: 61e9 }),
        part('nvme0n1', 3, { start: 1050624 + 982487367680 / 512, size: 17179869184, fstype: 'swap', fsver: '1', uuid: '9e8d7c6b-5a49-4382-9172-6a5b4c3d2e1f', parttypename: 'Linux swap', mount: '[SWAP]' }),
      ] }),
      disk('nvme1n1', { size: 500107862016, model: 'WD Blue SN570 500GB', serial: '22184F801234', rev: '234110WD', tran: 'nvme', parts: [
        part('nvme1n1', 1, { start: 2048, size: 500107862016 - 2 * MiB, fstype: 'ext4', fsver: '1.0', label: 'Données', uuid: '6d5c4b3a-2918-4f7e-8d6c-5b4a39281706', mount: '/media/user/Données', used: 377e9 }),
      ] }),
    ],
  };
  const drives = {
    nvme0n1: nvmeDrive({
      name: 'nvme0n1', model: 'Samsung SSD 990 PRO 1TB', serial: 'S6Z1NJ0W412345X', rev: '4B2QJXD7', size: TB1, poh: 2841, tempK: 312,
      a: { avail_spare: 100, spare_thresh: 10, percent_used: 2, total_data_read: 21337500000000, total_data_written: 14812000000000, ctrl_busy_time: 1630, power_cycles: 1204, unsafe_shutdowns: 37, media_errors: 0, num_err_log_entries: 0, temp_sensors: [312, 318, 0, 0, 0, 0, 0, 0], wctemp: 355, cctemp: 358, warning_temp_time: 0, critical_temp_time: 0 },
    }),
    nvme1n1: nvmeDrive({
      name: 'nvme1n1', model: 'WD Blue SN570 500GB', serial: '22184F801234', rev: '234110WD', size: 500107862016, poh: 21940, tempK: 314, warnings: ['spare'],
      a: { avail_spare: 7, spare_thresh: 10, percent_used: 98, total_data_read: 181406000000000, total_data_written: 296512000000000, ctrl_busy_time: 18233, power_cycles: 3120, unsafe_shutdowns: 412, media_errors: 3, num_err_log_entries: 57, temp_sensors: [314, 323, 0, 0, 0, 0, 0, 0], wctemp: 353, cctemp: 358, warning_temp_time: 12, critical_temp_time: 0 },
    }),
    sda: ataDrive({
      name: 'sda', model: 'Samsung SSD 870 EVO 1TB', serial: 'S75BNL0W123456A', rev: 'SVT02B6Q', size: TB1, rotation: 0, poh: 6211, tempC: 35,
      attrs: [
        attr(5, 0x0033, 100, 100, 10, 0), attr(9, 0x0032, 98, 98, 0, 6211), attr(12, 0x0032, 99, 99, 0, 845), attr(177, 0x0013, 99, 99, 0, 12),
        attr(179, 0x0013, 100, 100, 10, 0), attr(181, 0x0032, 100, 100, 10, 0), attr(182, 0x0032, 100, 100, 10, 0), attr(183, 0x0013, 100, 100, 10, 0),
        attr(187, 0x0032, 100, 100, 0, 0), attr(190, 0x0032, 65, 52, 0, 35), attr(195, 0x001a, 200, 200, 0, 0), attr(199, 0x003e, 100, 100, 0, 0),
        attr(235, 0x0012, 99, 99, 0, 0), attr(241, 0x0032, 99, 99, 0, 24592812345),
      ],
    }),
    sdb: ataDrive({
      name: 'sdb', model: 'WDC WD10EZEX-08WN4A0', serial: 'WD-WCC6Y5KX1234', rev: '01.01A01', size: TB1, rotation: 7200, poh: 38211, tempC: 45,
      failing: true, failingAttrs: 1, failedPast: 1, bad: 1904, selftest: 'error_read', pct: 90,
      attrs: [
        attr(1, 0x002f, 176, 163, 51, 2915), attr(3, 0x0027, 171, 170, 21, 4425), attr(4, 0x0032, 98, 98, 0, 2611), attr(5, 0x0033, 3, 3, 140, 1856),
        attr(7, 0x002e, 200, 200, 0, 0), attr(9, 0x0032, 48, 48, 0, 38211), attr(10, 0x0032, 100, 100, 0, 0), attr(11, 0x0032, 100, 100, 0, 0),
        attr(12, 0x0032, 98, 98, 0, 2589), attr(192, 0x0032, 200, 200, 0, 97), attr(193, 0x0032, 199, 199, 0, 3802), attr(194, 0x0022, 98, 85, 0, 45),
        attr(196, 0x0032, 1, 1, 0, 412), attr(197, 0x0032, 200, 199, 0, 48), attr(198, 0x0030, 100, 253, 0, 37), attr(199, 0x0032, 200, 200, 0, 2),
        attr(200, 0x0008, 100, 253, 0, 0),
      ],
    }),
    sde: ataDrive({
      name: 'sde', model: 'WDC WD40EFRX-68N32N0', serial: 'WD-WCC7K1234567', rev: '82.00A82', size: 4000787030016, rotation: 5400, poh: 28634, tempC: 34,
      selftest: 'inprogress', pct: 60,
      attrs: [
        attr(1, 0x002f, 200, 200, 51, 0), attr(3, 0x0027, 178, 176, 21, 8075), attr(4, 0x0032, 100, 100, 0, 312), attr(5, 0x0033, 200, 200, 140, 0),
        attr(7, 0x002e, 200, 200, 0, 0), attr(9, 0x0032, 61, 61, 0, 28634), attr(10, 0x0032, 100, 100, 0, 0), attr(11, 0x0032, 100, 253, 0, 0),
        attr(12, 0x0032, 100, 100, 0, 312), attr(192, 0x0032, 200, 200, 0, 104), attr(193, 0x0032, 200, 200, 0, 1823), attr(194, 0x0022, 116, 105, 0, 34),
        attr(196, 0x0032, 200, 200, 0, 0), attr(197, 0x0032, 200, 200, 0, 0), attr(198, 0x0030, 100, 253, 0, 0), attr(199, 0x0032, 200, 200, 0, 0),
        attr(200, 0x0008, 100, 253, 0, 0),
      ],
    }),
    sdc: { name: 'sdc', vendor: 'SanDisk', model: 'Ultra', serial: '4C530001230817115384', rev: '1.00', size: 30752636928, bus: 'usb', rotation: -1, removable: true },
    // A USB enclosure whose bridge udisks cannot talk SMART through: a plain Drive, no Drive.Ata / NVMe.Controller.
    sdd: { name: 'sdd', vendor: 'Realtek', model: 'RTL9210B-CG', serial: '012345678906', rev: '1.00', size: TB1, bus: 'usb', rotation: 0, removable: false },
    // vda: no udisks Drive at all (Block.Drive = "/"), as for a virtio disk without a serial number.
  };
  drives.sdb.fake = { selftestResult: 'error_read' };
  drives.sde.fake = { selftestStatic: true };
  write('health/lsblk.json', lsblk);
  write('health/udisks.json', buildObjects(lsblk, drives));
  // smartctl 7.4 -j -a through the Realtek RTL9210 bridge (-d sntrealtek, chosen by smartctl's USB id table).
  write('health/smartctl.json', {
    '/dev/sdd': {
      json_format_version: [1, 0],
      smartctl: { version: [7, 4], pre_release: false, svn_revision: '5530', platform_info: 'x86_64-linux-6.8.0-45-generic', build_info: '(local build)', argv: ['smartctl', '-j', '-a', '--', '/dev/sdd'], exit_status: 0 },
      local_time: { time_t: UPDATED, asctime: 'Wed Oct 14 10:00:00 2026 CEST' },
      device: { name: '/dev/sdd', info_name: '/dev/sdd [USB NVMe Realtek]', type: 'sntrealtek', protocol: 'NVMe' },
      model_name: 'Samsung SSD 980 1TB', serial_number: 'S649NF0R123456K', firmware_version: '1B4QFXO7',
      nvme_pci_vendor: { id: 5197, subsystem_id: 5197 }, nvme_ieee_oui_identifier: 9528, nvme_total_capacity: TB1, nvme_unallocated_capacity: 0,
      nvme_controller_id: 5, nvme_version: { string: '1.4', value: 66560 }, nvme_number_of_namespaces: 1,
      smart_support: { available: true, enabled: true },
      smart_status: { passed: true, nvme: { value: 0 } },
      nvme_smart_health_information_log: {
        critical_warning: 0, temperature: 36, available_spare: 100, available_spare_threshold: 10, percentage_used: 4, data_units_read: 25812345,
        data_units_written: 19876543, host_reads: 412345678, host_writes: 301234567, controller_busy_time: 412, power_cycles: 318, power_on_hours: 1204,
        unsafe_shutdowns: 21, media_errors: 0, num_err_log_entries: 0, warning_temp_time: 0, critical_comp_time: 0, temperature_sensors: [36, 41],
      },
      temperature: { current: 36 },
      power_cycle_count: 318,
      power_on_time: { hours: 1204 },
    },
  });
}
