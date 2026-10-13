'use strict';
// Installer backend (live session): disks, keyboard layouts, time zones and the installation itself.
// The installation runs the root helper /usr/lib/aurora/helpers/aurora-install through `sudo -n`
// (casper gives the live user passwordless sudo: /etc/sudoers.d/casper). The account password is
// written to the helper's stdin (--password-stdin), never on a command line.
//
//   installer:status               -> { live, dev, dryRun, minSize, running, finished, helper, firmware: 'uefi'|'bios' }
//   installer:disks                -> [{ path, name, model, vendor, size, transport, removable, tooSmall, table,
//                                        partitions: [{ path, number, size, fstype, label, mountpoints, os }],
//                                        alongside }]
//                                     whole disks only: no live medium, loop, zram, sr, read-only or in-use disk.
//                                     alongside (analyzeDisk, unit-tested): can Selene be installed next to the
//                                     systems already on this disk, and how (sizes in MiB) —
//                                       { possible, reason, reasonPart, reasonFs, reasonOs, os, menuName, systems: [{ name, kind, part }],
//                                         esp: { number, path, freeMiB }, fingerprint, bitlocker, rootMinMiB, rootSuggestedMiB,
//                                         options: [ { method: 'reuse', number, part, sizeMiB, rootMinMiB, rootMaxMiB } (the « Selene OS »
//                                                    partition an installation that stopped left behind: offered first)
//                                                  | { method: 'free', startMiB, endMiB, sizeMiB, rootMinMiB, rootMaxMiB }
//                                                  | { method: 'shrink', number, part, fstype, os, kind, label, sizeMiB, usedMiB,
//                                                      newMinMiB, newMaxMiB, spaceMiB, rootMinMiB, rootMaxMiB, rootSuggestedMiB } ],
//                                         blocked: [{ part, number, reason, code, fstype, os }] }
//                                     menuName: the other system's entry in Selene OS's 5 s boot menu (the probe's chain
//                                     name: the Linux started through its own boot loader, e.g. « CachyOS »; else os)
//                                     reason (when !possible): empty | bios | mbr | noEsp | espFull | espUbuntu | bitlocker |
//                                     hibernated | dirty | mounted | fsUnsupported | noSpace | probeFailed
//
// ---- dual boot: the root helpers' contract — AGREED, matches rootfs/usr/lib/aurora/helpers as of 2026-10-13 18:00:
//   Survey (read-only, root): sudo -n aurora-disk-probe [--disk DEV]…  -> one JSON document (see its header):
//     { firmware, minSeleneMiB, suggestedSeleneMiB, disks: [{ path, table, fingerprint, partitions: [{ number, path,
//       sizeMiB, fstype, os, usedMiB, flags, shrink: { possible, reason, minSizeMiB, maxSizeMiB, spaceMiB } }], free,
//       esp, systems, bitlocker, alongside: { possible, reason, plans } }] }
//   The rules (20 GiB minimum, a shrunk partition keeps max(5 GiB, 10 %) free, UEFI + GPT, ESP reused) live there;
//   analyzeDisk only reshapes them for the UI. Dev mode reads the same shape from test/fixtures/installer/.
//   Install: installer:start opts.mode 'alongside', opts.alongside = { method, fingerprint, esp, start, end | part, newSize | part }
//   -> aurora-install … --alongside --fingerprint SHA256 --esp N (--free-space S:E | --shrink N --new-size MIB | --reuse-partition N);
//   the helper re-checks the plan (`aurora-disk-probe --plan`, fresh survey + fingerprint) before anything is written.
//   Events: an optional 'shrink' stage before 'partition'; {"bootentry":"added|failed|skipped"} -> { type: 'bootentry' }.
//   installer:keyboards            -> [{ id: 'fr(oss)', layout: 'fr', variant: 'oss', name: { en, fr } }]
//   installer:timezones            -> ['Africa/Abidjan', …, 'UTC']
//   installer:applyKeyboard (id)   -> true when the layout was applied to the live X session (setxkbmap)
//   installer:gpu                  -> { gpus, nvidia, current, available, recommended, online, secureBoot }
//                                     graphics cards (lspci -nn -mm, main/lib/gpu-drivers.js); for an NVIDIA card the
//                                     NVIDIA drivers the archive offers (`ubuntu-drivers devices`: empty while the live
//                                     system has no package lists, the helper then picks the recommended one itself),
//                                     whether the computer is online (NetworkManager) and the Secure Boot state.
//                                     No root needed. Dev: AURORA_GPU_FIXTURE=<test/fixtures/gpu/NAME> (default: no
//                                     graphics card offered a driver), AURORA_GPU_ONLINE=0 (offline).
//   installer:start (opts)         -> { dryRun }   opts: { disk, mode, alongside, user, fullname, password, hostname,
//                                                          lang, keyboard, timezone, autologin, nvidiaDriver, gaming }
//                                     mode 'alongside': the plan is checked against the last installer:disks
//                                     analysis of that disk (method, partition, bounds, fingerprint) before the helper runs
//                                     nvidiaDriver: 'nvidia-driver-NNN[-open|-server|-server-open]' or 'recommended'
//                                     (downloaded from the Ubuntu archive during the installation; optional)
//                                     gaming: Flathub ids from GAMING_APPS (optional; nothing is downloaded during the
//                                     installation: the helper writes <home>/.config/aurora/first-login/gaming.json and
//                                     the session installs them per user at the first sign-in)
//       events 'installer:progress' (to the window that started it):
//         { type: 'progress', stage, progress, message }   stage: partition|format|copy|configure|drivers|bootloader|
//                                                                 cleanup|done
//         { type: 'driver', status: 'installed'|'failed', pkg, message }   (graphics driver; never an error)
//         { type: 'gaming', status: 'saved'|'failed', apps, message }      (gaming apps request; never an error)
//         { type: 'log', line }      { type: 'error', message, stage, code }      { type: 'done' }
//                                    code: EAUTH (sudo wants a password), ENOTADMIN (sudo refuses this account), exit code
//         { type: 'exit', code, cancelled }
//   installer:cancel               -> true when a running installation was signalled (SIGTERM; the helper cleans up)
//   installer:log                  -> last lines of the installation log (string)
//   installer:reboot               -> { simulated }   restarts the computer (systemctl reboot)
//
// Outside the live session, and always in --dev mode, the helper runs with --dry-run (it only simulates
// the stages: nothing is written) and the disk list is simulated (AURORA_REAL_BACKENDS=1: real lsblk):
// test/fixtures/installer/<AURORA_INSTALLER_FIXTURE>.json (default: an empty VM disk, Windows 11, Arch Linux with
// free space, a too-small USB stick; also bitlocker, hibernated, bios, refusals).
// Test hooks (dev only): AURORA_INSTALLER_DRYRUN_DELAY=<seconds per step>, AURORA_INSTALLER_FAIL_AT=<stage>
// (or 'notadmin': sudo refuses the account, as for a standard user; error code ENOTADMIN).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { run, which, helperPath } = require('../lib/exec');
const gpu = require('../lib/gpu-drivers');

const MIN_SIZE = 12e9; // bytes, same as the helper
const HELPER = 'aurora-install';
const STAGES = ['partition', 'format', 'copy', 'configure', 'drivers', 'bootloader', 'cleanup', 'done'];
const GPU_FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures', 'gpu');
const RE = {
  disk: /^\/dev\/[A-Za-z0-9/_.:-]+$/,
  user: /^[a-z_][a-z0-9_-]{0,31}$/,
  fullName: /^[^\x00-\x1f\x7f:,=\\]{0,128}$/,
  hostname: /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/,
  keyboard: /^[a-z]{2,3}(\([a-z0-9_-]{1,32}\))?$/,
  timezone: /^[A-Za-z0-9_+-]+(\/[A-Za-z0-9_+-]+){0,2}$/,
};
// Names the helper refuses (system accounts); the UI checks them as you type.
const RESERVED_USERS = new Set(
  ('root daemon bin sys sync games man lp mail news uucp proxy www-data backup list irc gnats nobody systemd-network ' +
    'systemd-resolve systemd-timesync systemd-coredump messagebus syslog _apt tss uuidd tcpdump sshd polkitd _greetd ' +
    'greeter aurora-greeter admin sudo adm users wheel staff operator ubuntu').split(' '),
);
// Gaming apps the installer may ask the first sign-in to install (Flathub, per user): the « Jeux » step. The helper
// accepts exactly these ids (--gaming), nothing else.
const GAMING_APPS = Object.freeze(['com.valvesoftware.Steam', 'com.heroicgameslauncher.hgl', 'net.lutris.Lutris', 'net.davidotek.pupgui2', 'com.usebottles.bottles', 'com.discordapp.Discord']);
// Mount points that mark a disk as the running system or the live medium (never offered).
const SYSTEM_MOUNTS = new Set(['/', '/cdrom', '/rofs', '/isodevice', '/run/live/medium', '/media/cdrom', '/run/initramfs/live', '/boot', '/boot/efi', '/usr', '/home', '/var']);

const KEYBOARDS = [
  ['us', 'English (US)', 'Anglais (États-Unis)'],
  ['us(intl)', 'English (US, international with dead keys)', 'Anglais (États-Unis, international avec touches mortes)'],
  ['gb', 'English (UK)', 'Anglais (Royaume-Uni)'],
  ['fr', 'French (AZERTY)', 'Français (AZERTY)'],
  ['fr(oss)', 'French (alternative)', 'Français (variante)'],
  ['fr(afnor)', 'French (AZERTY, AFNOR)', 'Français (AZERTY, AFNOR)'],
  ['fr(bepo)', 'French (BÉPO)', 'Français (BÉPO)'],
  ['fr(mac)', 'French (Macintosh)', 'Français (Macintosh)'],
  ['be', 'Belgian', 'Belge'],
  ['ch(fr)', 'French (Switzerland)', 'Français (Suisse)'],
  ['ch', 'German (Switzerland)', 'Allemand (Suisse)'],
  ['ca(fr)', 'French (Canada)', 'Français (Canada)'],
  ['ca(multix)', 'Canadian (multilingual)', 'Canadien (multilingue)'],
  ['de', 'German', 'Allemand'],
  ['es', 'Spanish', 'Espagnol'],
  ['latam', 'Spanish (Latin American)', 'Espagnol (Amérique latine)'],
  ['it', 'Italian', 'Italien'],
  ['pt', 'Portuguese', 'Portugais'],
  ['br', 'Portuguese (Brazil)', 'Portugais (Brésil)'],
  ['nl', 'Dutch', 'Néerlandais'],
  ['us(dvorak)', 'English (Dvorak)', 'Anglais (Dvorak)'],
].map(([id, en, fr]) => {
  const m = /^([a-z]+)(?:\(([^)]+)\))?$/.exec(id);
  return { id, layout: m[1], variant: m[2] || '', name: { en, fr } };
});

// Simulated disks (dev mode): test/fixtures/installer/<name>.json, in the shape of the probe's survey.
const DISK_FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures', 'installer');
const PROBE = 'aurora-disk-probe';
const MiB = 1048576;
const ROOT_MIN_MIB = 20480; // defaults when the survey does not say (aurora-disk-probe MIN_SELENE_MIB / SUGGESTED_SELENE_MIB)
const ROOT_SUGGESTED_MIB = 40960;
// aurora-disk-probe reason codes -> the installer's (one explanation + what to do, i18n why.<code>)
const REASONS = {
  bios: 'bios', 'no-table': 'empty', mbr: 'mbr', 'no-esp': 'noEsp', 'esp-unreadable': 'probeFailed', 'esp-full': 'espFull', 'ubuntu-folder': 'espUbuntu',
  'no-space': 'noSpace', 'too-full': 'noSpace', 'in-use': 'mounted', mounted: 'mounted', btrfs: 'fsUnsupported', xfs: 'fsUnsupported', luks: 'fsUnsupported',
  lvm: 'fsUnsupported', unsupported: 'fsUnsupported', bitlocker: 'bitlocker', hibernated: 'hibernated', dirty: 'dirty', 'needs-recovery': 'dirty', unreadable: 'probeFailed',
};
const FS_NAMES = { btrfs: 'Btrfs', xfs: 'XFS', crypto_LUKS: 'LUKS', LVM2_member: 'LVM', BitLocker: 'BitLocker', zfs_member: 'ZFS', f2fs: 'F2FS', exfat: 'exFAT', vfat: 'FAT32', ext3: 'ext3', ext2: 'ext2' };
const FS_OF_REASON = { btrfs: 'Btrfs', xfs: 'XFS', luks: 'LUKS', lvm: 'LVM' };
const int = (v) => (Number.isSafeInteger(Number(v)) ? Number(v) : 0);
const RE_FP = /^[0-9a-f]{64}$/;

/** A name people know: 'Windows Boot Manager' -> 'Windows', 'Fedora Linux 40 (Workstation Edition)' -> 'Fedora Linux 40'. */
function systemName(n) {
  const s = String(n || '').trim();
  if (/^windows boot manager$/i.test(s)) return 'Windows';
  return s.replace(/\s*\([^)]*\)$/, '').slice(0, 60);
}

/**
 * One disk of the probe's survey -> its dual boot analysis for the UI (pure, unit-tested). Sizes in MiB. The rules
 * (minimum sizes, free space kept) are the probe's: its plans are only reshaped here.
 */
function analyzeDisk(d, survey = {}) {
  const rootMin = int(survey.minSeleneMiB) || ROOT_MIN_MIB;
  const rootSug = int(survey.suggestedSeleneMiB) || ROOT_SUGGESTED_MIB;
  const parts = Array.isArray(d?.partitions) ? d.partitions : [];
  const al = d?.alongside || {};
  const res = { possible: false, reason: null, reasonPart: null, reasonFs: null, reasonOs: null, os: null, systems: [], esp: null, fingerprint: null, bitlocker: !!d?.bitlocker, rootMinMiB: rootMin, rootSuggestedMiB: rootSug, options: [], blocked: [] };
  // Systems: the ones found on partitions first (named), then the boot loaders of the EFI system partition.
  const seen = new Set();
  const sys = [...(d?.systems || [])].sort((x, y) => (x.loader ? 1 : 0) - (y.loader ? 1 : 0) || (/boot manager/i.test(x.name) ? 1 : 0) - (/boot manager/i.test(y.name) ? 1 : 0));
  const named = sys.some((x) => !x.loader && !/boot manager/i.test(x.name));
  for (const s of sys) {
    const name = systemName(s.name);
    if (!name || /^(boot|tools)$/i.test(name)) continue;
    if (s.loader && named) continue; // an ESP folder (« arch ») of a system already named by its partition (« Arch Linux »)
    // « Windows Boot Manager » next to a « Windows 11 » partition is the same system
    if ([...seen].some((x) => x === name.toLowerCase() || (name === 'Windows' && x.startsWith('windows')))) continue;
    seen.add(name.toLowerCase());
    const part = parts.find((p) => p.number === s.partition && !p.esp);
    res.systems.push({ name, kind: s.kind === 'windows' || /^windows/i.test(name) ? 'windows' : s.kind === 'linux' ? 'linux' : 'other', part: part?.path || null });
  }
  res.os = res.systems[0]?.name || null;
  res.menuName = (d?.chain?.name && systemName(d.chain.name)) || res.os;
  if (d?.esp) res.esp = { number: int(d.esp.number), path: String(d.esp.path || ''), freeMiB: d.esp.freeMiB == null ? null : int(d.esp.freeMiB) };
  res.fingerprint = RE_FP.test(String(d?.fingerprint || '')) ? d.fingerprint : null;
  for (const p of parts) {
    const sh = p.shrink || {};
    if (sh.possible || !sh.reason || p.esp || (sh.reason === 'unsupported' && !p.os)) continue;
    res.blocked.push({ part: p.path, number: p.number, reason: REASONS[sh.reason] || 'probeFailed', code: sh.reason, fstype: p.fstype || '', os: p.os ? systemName(p.os) : null });
  }
  if (!parts.length) {
    res.reason = 'empty';
    return res;
  }
  if (!al.possible) {
    let code = REASONS[al.reason] || 'probeFailed';
    // « Not enough room »: the partition of the system says why it can't be shrunk (BitLocker, Fast Startup, Btrfs…).
    const b = res.blocked.find((x) => x.os) || res.blocked[0];
    if (b && (code === 'noSpace' || (code === 'mounted' && b.reason === 'mounted'))) code = b.reason;
    const fs = b ? FS_OF_REASON[b.code] || FS_NAMES[b.fstype] || b.fstype || null : null;
    Object.assign(res, { reason: code, reasonPart: b?.part || null, reasonFs: fs, reasonOs: b?.os || res.os });
    return res;
  }
  if (!res.fingerprint || !res.esp?.number) {
    res.reason = 'probeFailed';
    return res;
  }
  for (const pl of al.plans || []) {
    if (pl.kind === 'reuse') {
      // The « Selene OS » partition an installation that stopped left behind: formatted again, nothing else changes.
      const p = parts.find((x) => x.number === pl.partition);
      const size = int(pl.sizeMiB);
      if (p && size >= rootMin) res.options.push({ method: 'reuse', number: int(pl.partition), part: String(pl.path || p.path), sizeMiB: size, rootMinMiB: size, rootMaxMiB: size, rootSuggestedMiB: size });
    } else if (pl.kind === 'free') {
      const start = int(pl.startMiB);
      const end = int(pl.endMiB);
      if (start >= 1 && end - start >= rootMin) res.options.push({ method: 'free', startMiB: start, endMiB: end, sizeMiB: end - start, rootMinMiB: rootMin, rootMaxMiB: end - start, rootSuggestedMiB: end - start });
    } else if (pl.kind === 'shrink') {
      const space = int(pl.spaceMiB);
      const newMin = int(pl.minSizeMiB);
      const newMax = int(pl.maxSizeMiB);
      const p = parts.find((x) => x.number === pl.partition);
      if (!p || newMin < 1 || newMax < newMin) continue;
      // Selene takes the space after the shrunk partition: spaceMiB - 1 (alignment) - its new size.
      const rootMax = space - 1 - newMin;
      const rootMinS = Math.max(rootMin, space - 1 - newMax);
      if (rootMax < rootMinS) continue;
      const os = pl.os ? systemName(pl.os) : null;
      res.options.push({
        method: 'shrink', number: int(pl.partition), part: String(pl.path || p.path), fstype: String(pl.fstype || ''), os,
        kind: /^windows/i.test(os || '') || (pl.fstype === 'ntfs' && res.systems.some((x) => x.kind === 'windows')) ? 'windows' : os ? 'linux' : 'other',
        label: String(pl.label || ''), sizeMiB: int(pl.currentSizeMiB), usedMiB: int(pl.usedMiB), newMinMiB: newMin, newMaxMiB: newMax, spaceMiB: space,
        rootMinMiB: rootMinS, rootMaxMiB: rootMax, rootSuggestedMiB: pl.suggestedSizeMiB ? Math.min(rootMax, Math.max(rootMinS, space - 1 - int(pl.suggestedSizeMiB))) : Math.min(rootMax, Math.max(rootMinS, rootSug)),
      });
    }
  }
  // The previous attempt's partition first, then free space (nothing is shrunk), then the systems' partitions.
  const rank = { reuse: 0, free: 1, shrink: 2 };
  res.options.sort((x, y) => rank[x.method] - rank[y.method] || (y.os ? 1 : 0) - (x.os ? 1 : 0) || y.rootMaxMiB - x.rootMaxMiB);
  res.possible = res.options.length > 0;
  if (!res.possible) res.reason = 'noSpace';
  return res;
}

/** Survey disk -> the disk list entry the renderer gets. */
function describeDisk(d, survey, { minSize = MIN_SIZE } = {}) {
  const size = Number(d.size) || 0;
  return {
    path: d.path,
    name: d.name || path.basename(String(d.path)),
    model: clean(d.model) || clean(d.vendor) || '',
    vendor: clean(d.vendor),
    size,
    transport: clean(d.transport),
    removable: !!d.removable,
    tooSmall: size < minSize,
    table: d.table || '',
    partitions: (d.partitions || []).map((p) => ({ path: p.path, number: p.number, size: (Number(p.sizeMiB) || 0) * MiB, fstype: clean(p.fstype), label: clean(p.label), mountpoints: Array.isArray(p.mounted) ? p.mounted : p.mounted ? ['(mounted)'] : [], os: p.os ? systemName(p.os) : null })),
    alongside: analyzeDisk(d, survey),
  };
}

function loadFixture(name) {
  const n = /^[a-z0-9-]+$/.test(String(name || '')) ? name : 'default';
  const f = fs.existsSync(path.join(DISK_FIXTURES, `${n}.json`)) ? `${n}.json` : 'default.json';
  return parseSurvey(fs.readFileSync(path.join(DISK_FIXTURES, f), 'utf8'));
}

/** aurora-disk-probe stdout -> the survey ({ firmware, minSeleneMiB, disks }) or null. */
function parseSurvey(text) {
  try {
    const o = JSON.parse(String(text || ''));
    if (o && typeof o === 'object' && Array.isArray(o.disks)) return o;
  } catch {}
  return null;
}

const bool = (v) => v === true || v === 1 || v === '1' || v === 'true';
const clean = (s) => String(s ?? '').trim();

/** lsblk -J -b -p output -> installable disks (unit-tested). opts: { minSize } */
function parseLsblk(json, { minSize = MIN_SIZE } = {}) {
  let data;
  try {
    data = typeof json === 'string' ? JSON.parse(json) : json;
  } catch {
    return [];
  }
  const out = [];
  const mountsOf = (d) => (Array.isArray(d.mountpoints) ? d.mountpoints : [d.mountpoint]).filter((m) => typeof m === 'string' && m);
  const walk = (d, acc = []) => {
    acc.push(d);
    for (const c of d.children || []) walk(c, acc);
    return acc;
  };
  for (const d of data?.blockdevices || []) {
    const name = path.basename(String(d.name || d.kname || ''));
    if (d.type !== 'disk') continue;
    if (/^(loop|zram|sr|ram|fd|md|dm-)/.test(name)) continue;
    if (bool(d.ro)) continue;
    const size = Number(d.size) || 0;
    if (size <= 0) continue;
    const all = walk(d);
    // The running system or the live medium lives on this disk: never offer it.
    if (all.some((n) => mountsOf(n).some((m) => SYSTEM_MOUNTS.has(m) || m.startsWith('/rofs') || m.startsWith('/cdrom')))) continue;
    if (all.some((n) => n.type === 'rom' || (n.fstype === 'iso9660' && mountsOf(n).length))) continue;
    // Members of LVM/RAID/encrypted volumes are in use.
    if (all.some((n) => ['lvm', 'crypt', 'raid0', 'raid1', 'raid5', 'raid6', 'raid10', 'md'].includes(n.type))) continue;
    out.push({
      path: d.path || `/dev/${name}`,
      name,
      model: clean(d.model) || clean(d.vendor) || '',
      vendor: clean(d.vendor),
      size,
      transport: clean(d.tran),
      removable: bool(d.rm) || bool(d.hotplug),
      tooSmall: size < minSize,
      partitions: (d.children || [])
        .filter((c) => c.type === 'part')
        .map((c) => ({ path: c.path || `/dev/${path.basename(String(c.name))}`, size: Number(c.size) || 0, fstype: clean(c.fstype), label: clean(c.label || c.partlabel), mountpoints: mountsOf(c) })),
    });
  }
  return out;
}

/** zone1970.tab / zone.tab text -> sorted unique zone names + UTC (unit-tested) */
function parseZoneTab(text) {
  const set = new Set();
  for (const line of String(text || '').split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const z = line.split('\t')[2];
    if (z && RE.timezone.test(z)) set.add(z);
  }
  set.add('UTC');
  return [...set].sort();
}

const FALLBACK_ZONES = [
  'Africa/Abidjan', 'Africa/Algiers', 'Africa/Cairo', 'Africa/Casablanca', 'Africa/Dakar', 'Africa/Johannesburg', 'Africa/Lagos', 'Africa/Nairobi', 'Africa/Tunis',
  'America/Anchorage', 'America/Argentina/Buenos_Aires', 'America/Bogota', 'America/Chicago', 'America/Denver', 'America/Halifax', 'America/Los_Angeles',
  'America/Mexico_City', 'America/Montreal', 'America/New_York', 'America/Phoenix', 'America/Sao_Paulo', 'America/Toronto', 'America/Vancouver',
  'Asia/Bangkok', 'Asia/Dubai', 'Asia/Hong_Kong', 'Asia/Jakarta', 'Asia/Kolkata', 'Asia/Seoul', 'Asia/Shanghai', 'Asia/Singapore', 'Asia/Tokyo',
  'Atlantic/Reykjavik', 'Australia/Melbourne', 'Australia/Perth', 'Australia/Sydney', 'Europe/Amsterdam', 'Europe/Athens', 'Europe/Berlin', 'Europe/Brussels',
  'Europe/Dublin', 'Europe/Helsinki', 'Europe/Istanbul', 'Europe/Lisbon', 'Europe/London', 'Europe/Luxembourg', 'Europe/Madrid', 'Europe/Monaco', 'Europe/Moscow',
  'Europe/Oslo', 'Europe/Paris', 'Europe/Prague', 'Europe/Rome', 'Europe/Stockholm', 'Europe/Vienna', 'Europe/Warsaw', 'Europe/Zurich', 'Indian/Reunion',
  'Pacific/Auckland', 'Pacific/Honolulu', 'Pacific/Noumea', 'Pacific/Tahiti', 'America/Guadeloupe', 'America/Martinique', 'America/Cayenne', 'UTC',
].sort();

/** Validate installer:start options -> helper argv (without the password). Throws EINVAL. (unit-tested) */
function buildArgs(opts, { dryRun = false, delay, failAt } = {}) {
  const o = opts || {};
  const bad = (field) => {
    const e = new Error(`Invalid ${field}`);
    e.code = 'EINVAL';
    e.field = field;
    throw e;
  };
  const disk = String(o.disk || '');
  if (!RE.disk.test(disk) || disk.includes('..')) bad('disk');
  const user = String(o.user || '');
  if (!RE.user.test(user) || RESERVED_USERS.has(user)) bad('user');
  const fullname = String(o.fullname ?? '').trim();
  if (!RE.fullName.test(fullname)) bad('fullname');
  const hostname = String(o.hostname || `${user}-pc`);
  if (!RE.hostname.test(hostname)) bad('hostname');
  const lang = o.lang === 'fr' ? 'fr' : o.lang === 'en' || o.lang == null ? 'en' : bad('lang');
  const keyboard = String(o.keyboard || (lang === 'fr' ? 'fr' : 'us'));
  if (!RE.keyboard.test(keyboard)) bad('keyboard');
  const timezone = String(o.timezone || 'UTC');
  if (!RE.timezone.test(timezone) || timezone.includes('..')) bad('timezone');
  const password = o.password;
  if (typeof password !== 'string' || !password.length || password.length > 256 || /[\x00-\x1f\x7f]/.test(password)) bad('password');
  const args = ['--json', '--password-stdin', '--disk', disk, '--user', user, '--fullname', fullname, '--hostname', hostname, '--lang', lang, '--keyboard', keyboard, '--timezone', timezone];
  const mode = o.mode == null || o.mode === 'erase' ? 'erase' : o.mode === 'alongside' ? 'alongside' : bad('mode');
  if (mode === 'alongside') args.push(...alongsideArgs(o.alongside, bad));
  if (bool(o.autologin)) args.push('--autologin');
  if (o.nvidiaDriver != null && o.nvidiaDriver !== false && o.nvidiaDriver !== '') {
    const drv = String(o.nvidiaDriver);
    if (drv !== 'recommended' && !gpu.validDriverPkg(drv)) bad('nvidiaDriver');
    args.push('--nvidia-driver', drv);
  }
  if (o.gaming != null && o.gaming !== false && o.gaming !== '') {
    // An array of ids (or 'id,id'); each one must be in the allow-list. Duplicates are dropped, catalog order kept.
    const list = Array.isArray(o.gaming) ? o.gaming : typeof o.gaming === 'string' ? o.gaming.split(',') : bad('gaming');
    if (list.length > GAMING_APPS.length * 2 || !list.every((id) => typeof id === 'string' && GAMING_APPS.includes(id))) bad('gaming');
    const ids = GAMING_APPS.filter((id) => list.includes(id));
    if (ids.length) args.push('--gaming', ids.join(','));
  }
  if (dryRun) {
    args.push('--dry-run');
    if (delay != null && /^[0-9]{1,2}(\.[0-9]{1,3})?$/.test(String(delay))) args.push('--dry-run-delay', String(delay));
  }
  if (failAt && STAGES.includes(failAt) && failAt !== 'done') args.push('--fail-at', failAt);
  return args;
}

/**
 * Dual boot plan -> helper argv (aurora-install --alongside …). Structure and bounds only: whole MiB, partition numbers
 * 1..128, a sha256 fingerprint; checkPlan() matches it against the disk's analysis. (unit-tested)
 *   { method: 'free', fingerprint, esp, start, end }        -> --alongside --fingerprint H --esp N --free-space S:E
 *   { method: 'shrink', fingerprint, esp, part, newSize[, rootSize] }
 *                                                  -> --alongside --fingerprint H --esp N --shrink N --new-size MIB [--root-size MIB]
 *   rootSize: the exact size of Selene OS (the UI's); without it the helper takes all the space freed.
 *   { method: 'reuse', fingerprint, esp, part }     -> --alongside --fingerprint H --esp N --reuse-partition N
 */
const isInt = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
const MAX_MIB = 999999999; // the helper's 9 digits
function alongsideArgs(a, bad) {
  if (!a || typeof a !== 'object') bad('alongside');
  if (typeof a.fingerprint !== 'string' || !RE_FP.test(a.fingerprint)) bad('alongside.fingerprint');
  if (!isInt(a.esp, 1, 128)) bad('alongside.esp');
  const args = ['--alongside', '--fingerprint', a.fingerprint, '--esp', String(a.esp)];
  if (a.method === 'shrink') {
    if (!isInt(a.part, 1, 128) || a.part === a.esp) bad('alongside.part');
    if (!isInt(a.newSize, 1024, MAX_MIB)) bad('alongside.newSize');
    args.push('--shrink', String(a.part), '--new-size', String(a.newSize));
    if (a.rootSize !== undefined) {
      if (!isInt(a.rootSize, 19074, MAX_MIB)) bad('alongside.rootSize');
      args.push('--root-size', String(a.rootSize));
    }
  } else if (a.method === 'reuse') {
    if (!isInt(a.part, 1, 128) || a.part === a.esp) bad('alongside.part');
    args.push('--reuse-partition', String(a.part));
  } else if (a.method === 'free') {
    if (!isInt(a.start, 1, MAX_MIB) || !isInt(a.end, 1, MAX_MIB) || a.end - a.start < ROOT_MIN_MIB) bad('alongside.free');
    args.push('--free-space', `${a.start}:${a.end}`);
  } else bad('alongside.method');
  return args;
}

/** Is this plan one the analysis of the disk offers (method, partition, bounds, fingerprint, ESP)? Throws EPLAN. (unit-tested) */
function checkPlan(a, analysis) {
  const no = (why) => {
    const e = new Error(`This dual boot plan is not possible: ${why}`);
    e.code = 'EPLAN';
    throw e;
  };
  if (!analysis?.possible) no(analysis?.reason || 'no analysis of this disk');
  if (a.fingerprint !== analysis.fingerprint) no('the partition table changed');
  if (a.esp !== analysis.esp?.number) no('EFI system partition');
  if (a.method === 'reuse') {
    const opt = analysis.options.find((x) => x.method === 'reuse' && x.number === a.part);
    if (!opt) no('partition');
    return opt;
  }
  if (a.method === 'free') {
    const opt = analysis.options.find((x) => x.method === 'free' && x.startMiB <= a.start && a.end <= x.endMiB);
    if (!opt) no('free space');
    if (a.end - a.start < opt.rootMinMiB) no('Selene OS is too small');
    return opt;
  }
  const opt = analysis.options.find((x) => x.method === 'shrink' && x.number === a.part);
  if (!opt) no('partition');
  if (a.newSize < opt.newMinMiB || a.newSize > opt.newMaxMiB) no('new size out of bounds');
  if (a.rootSize !== undefined && (a.rootSize < analysis.rootMinMiB || a.rootSize > opt.spaceMiB - 1 - a.newSize)) no('Selene OS size');
  return opt;
}

/** Split a stream into lines (keeps a partial trailing line). */
function lineSplitter(onLine) {
  let buf = '';
  return {
    push(chunk) {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        onLine(line);
      }
    },
    flush() {
      if (buf) onLine(buf);
      buf = '';
    },
  };
}

function register(api) {
  const DEV = !!api.DEV;
  const live = !!api.env?.live;
  const dryRun = DEV || !live;
  const useMockDisks = DEV && process.env.AURORA_REAL_BACKENDS !== '1';
  const LOG_MAX = 2000;
  let job = null; // { child, sender, cancelled }
  let finished = false;
  const logLines = [];
  const pushLog = (line) => {
    logLines.push(line);
    if (logLines.length > LOG_MAX) logLines.splice(0, logLines.length - LOG_MAX);
  };

  // UEFI or legacy BIOS boot of the live session (dual boot needs UEFI). Dev: the fixture says.
  const fixtureName = () => process.env.AURORA_INSTALLER_FIXTURE || 'default';
  const firmware = () => (useMockDisks ? (loadFixture(fixtureName()).firmware === 'uefi' ? 'uefi' : 'bios') : fs.existsSync('/sys/firmware/efi') ? 'uefi' : 'bios');
  // Last analysis of each disk (installer:disks): installer:start only accepts a dual boot plan it offered.
  const analyses = new Map();

  api.handle('installer:status', () => ({
    live,
    dev: DEV,
    firmware: firmware(),
    dryRun,
    minSize: MIN_SIZE,
    running: !!job,
    finished,
    helper: dryRun ? helperPath(HELPER) : path.join('/usr/lib/aurora/helpers', HELPER),
    // RAM of this computer (the installer warns under 4 GB, never blocks; AURORA_FAKE_RAM=<bytes> in tests).
    memTotal: Number(process.env.AURORA_FAKE_RAM) || require('os').totalmem(),
  }));

  api.handle('installer:disks', async () => {
    let list;
    if (useMockDisks) {
      const sv = loadFixture(fixtureName());
      const delay = Number(process.env.AURORA_INSTALLER_PROBE_DELAY) || 0;
      if (delay > 0) await new Promise((r) => setTimeout(r, Math.min(delay, 10000)));
      list = (sv?.disks || []).map((d) => describeDisk(d, sv));
    } else {
      const r = await run('lsblk', ['-J', '-b', '-p', '-o', 'NAME,KNAME,PATH,TYPE,SIZE,MODEL,VENDOR,TRAN,RM,RO,HOTPLUG,FSTYPE,LABEL,PARTLABEL,MOUNTPOINTS'], { timeout: 10000 }).catch(
        (e) => ({ code: 1, stdout: '', stderr: e.message }),
      );
      if (r.code !== 0) throw api.error(`lsblk failed: ${r.stderr.trim()}`, 'ECMD');
      list = parseLsblk(r.stdout);
      // Dual boot facts need root (ntfsresize --info, dumpe2fs, the ESP's folders): the read-only probe. Outside the
      // live session (dry run) there is none: erasing stays the only choice for a disk with partitions.
      let sv = null;
      const withParts = list.filter((d) => d.partitions.length);
      if (!dryRun && withParts.length && which('sudo')) {
        const pr = await run('sudo', ['-n', '--', path.join('/usr/lib/aurora/helpers', PROBE), ...withParts.flatMap((d) => ['--disk', d.path])], { timeout: 180000 }).catch(() => ({ code: 1, stdout: '' }));
        if (pr.code === 0) sv = parseSurvey(pr.stdout);
      }
      list = list.map((d) => {
        const pd = sv?.disks.find((x) => x.path === d.path);
        if (pd) {
          const out = describeDisk({ ...pd, model: d.model, vendor: d.vendor, transport: d.transport, removable: d.removable, size: d.size }, sv);
          return { ...out, partitions: out.partitions.map((p) => ({ ...p, mountpoints: d.partitions.find((x) => x.path === p.path)?.mountpoints || [] })) };
        }
        // No survey for this disk: erasing only (a disk with partitions says why).
        return { ...d, table: '', alongside: { ...analyzeDisk({ partitions: [] }), reason: d.partitions.length ? 'probeFailed' : 'empty' } };
      });
    }
    analyses.clear();
    for (const d of list) analyses.set(d.path, d.alongside);
    return list;
  });

  api.handle('installer:keyboards', () => KEYBOARDS.map((k) => ({ ...k, name: { ...k.name } })));

  api.handle('installer:timezones', async () => {
    for (const f of ['/usr/share/zoneinfo/zone1970.tab', '/usr/share/zoneinfo/zone.tab']) {
      try {
        const zones = parseZoneTab(await fs.promises.readFile(f, 'utf8'));
        if (zones.length > 10) return zones;
      } catch {}
    }
    return FALLBACK_ZONES;
  });

  // ---- graphics card + NVIDIA driver offer (no root; cached for the session, `refresh` probes again)
  let gpuCache = null;
  const readText = (f) => fs.promises.readFile(f, 'utf8').catch(() => '');
  const cmdOut = (cmd, args, timeout = 10000) =>
    run(cmd, args, { timeout })
      .then((r) => r.stdout || '')
      .catch(() => '');
  async function isOnline() {
    // NetworkManager: CONNECTIVITY full (or unknown, when the connectivity check is off, while connected).
    const nm = (await cmdOut('nmcli', ['-t', '-f', 'CONNECTIVITY,STATE', 'general'], 5000)).trim();
    if (nm) {
      const [conn, st] = nm.split('\n')[0].split(':');
      if (conn === 'full') return true;
      if (conn === 'unknown') return /^connected/.test(st || '');
      return false;
    }
    // No NetworkManager: a default route.
    return /^\S+\t00000000\t/m.test(await readText('/proc/net/route'));
  }
  async function probeGpu() {
    const fixture = DEV && process.env.AURORA_REAL_BACKENDS !== '1' ? String(process.env.AURORA_GPU_FIXTURE || '') : null;
    let lspci;
    let drivers;
    let mods;
    let sb;
    let online;
    if (fixture != null) {
      const dir = /^[a-z0-9-]+$/.test(fixture) ? path.join(GPU_FIXTURES, fixture) : null;
      const rd = (f) => (dir ? readText(path.join(dir, f)) : Promise.resolve(''));
      [lspci, drivers, sb] = await Promise.all([rd('lspci.txt'), rd('ubuntu-drivers.txt'), rd('sb-state.txt')]);
      mods = (await rd('nvidia-version.txt')) || (await rd('lsmod.txt'));
      online = process.env.AURORA_GPU_ONLINE !== '0';
      const delay = Number(process.env.AURORA_GPU_DELAY) || 0;
      if (delay > 0) await new Promise((r) => setTimeout(r, Math.min(delay, 10000)));
    } else {
      lspci = await cmdOut('lspci', ['-nn', '-mm'], 8000);
    }
    const gpus = gpu.detectGpus(lspci);
    const nvidia = gpus.filter((g) => g.vendor === 'nvidia');
    const res = { gpus, nvidia, current: { module: null, version: null, open: null }, available: [], recommended: null, online: false, secureBoot: null };
    if (!nvidia.length) return res; // nothing to offer: AMD / Intel / virtual machines
    if (fixture == null) {
      [drivers, sb, online] = await Promise.all([cmdOut('ubuntu-drivers', ['devices'], 60000), cmdOut('mokutil', ['--sb-state'], 5000), isOnline()]);
      mods = (await readText('/proc/driver/nvidia/version')) || (await readText('/proc/modules'));
    }
    res.current = gpu.currentDriver(mods);
    res.available = gpu.parseUbuntuDrivers(drivers);
    res.recommended = gpu.recommendedDriver(res.available);
    res.online = !!online;
    res.secureBoot = gpu.parseSecureBoot(sb);
    return res;
  }
  api.handle('installer:gpu', async (opts) => {
    if (!gpuCache || opts?.refresh) gpuCache = probeGpu().catch(() => ({ gpus: [], nvidia: [], current: { module: null, version: null, open: null }, available: [], recommended: null, online: false, secureBoot: null }));
    const r = await gpuCache;
    return JSON.parse(JSON.stringify(r));
  });

  api.handle('installer:applyKeyboard', async (id) => {
    const k = KEYBOARDS.find((x) => x.id === id);
    if (!k) throw api.error('Unknown keyboard layout', 'EINVAL');
    if (DEV || !live || !process.env.DISPLAY || !which('setxkbmap')) return false;
    const args = ['-layout', k.layout];
    if (k.variant) args.push('-variant', k.variant);
    const r = await run('setxkbmap', args, { timeout: 5000 }).catch(() => ({ code: 1 }));
    return r.code === 0;
  });

  api.handle('installer:log', () => logLines.join('\n'));

  api.handle('installer:start', async (opts, event) => {
    if (job) throw api.error('An installation is already running', 'EBUSY');
    const delay = DEV ? process.env.AURORA_INSTALLER_DRYRUN_DELAY : undefined;
    const failAt = DEV ? process.env.AURORA_INSTALLER_FAIL_AT : undefined;
    const args = buildArgs(opts, { dryRun, delay, failAt });
    if (opts?.mode === 'alongside') {
      try {
        checkPlan(opts.alongside, analyses.get(String(opts.disk)));
      } catch (e) {
        throw api.error(e.message, e.code || 'EPLAN');
      }
    }
    const helper = dryRun ? helperPath(HELPER) : path.join('/usr/lib/aurora/helpers', HELPER);
    if (!fs.existsSync(helper)) throw api.error(`The installer helper is missing (${helper})`, 'ENOENT');
    let cmd;
    let argv;
    if (DEV && failAt === 'notadmin') {
      // Simulates sudo refusing a standard account (same stderr as the real sudo; nothing runs).
      cmd = which('bash') || '/bin/bash';
      argv = ['-c', 'echo "sudo: $1 is not in the sudoers file." >&2; exit 1', 'sudo', String(opts?.user || 'user')];
    } else if (dryRun) {
      cmd = which('bash') || '/bin/bash';
      argv = [helper, ...args];
    } else {
      cmd = which('sudo');
      if (!cmd) throw api.error('sudo is not available', 'ENOENT');
      argv = ['-n', '--', helper, ...args];
    }
    const sender = event?.sender;
    const send = (payload) => api.sendTo(sender, 'installer:progress', payload);
    logLines.length = 0;
    finished = false;
    const child = spawn(cmd, argv, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, LC_ALL: 'C' } });
    job = { child, cancelled: false };
    let sawDone = false;
    let sawError = false;
    let authError = false;
    let notAdmin = false;
    const out = lineSplitter((line) => {
      if (!line.trim()) return;
      let ev = null;
      try {
        ev = JSON.parse(line);
      } catch {}
      if (ev && typeof ev === 'object' && typeof ev.driver === 'string') {
        // Graphics driver result: never fails the installation.
        const status = ev.driver === 'installed' ? 'installed' : 'failed';
        send({ type: 'driver', status, pkg: gpu.validDriverPkg(ev.package) ? ev.package : null, message: String(ev.message || '') });
      } else if (ev && typeof ev === 'object' && typeof ev.gaming === 'string') {
        // Gaming apps request for the first sign-in: never fails the installation either.
        const apps = String(ev.apps || '').split(',').filter((id) => GAMING_APPS.includes(id));
        send({ type: 'gaming', status: ev.gaming === 'saved' ? 'saved' : 'failed', apps, message: String(ev.message || '') });
      } else if (ev && typeof ev === 'object' && typeof ev.bootentry === 'string') {
        // Firmware boot entry « Selene » (dual boot): never fails the installation, the done page says what to do.
        send({ type: 'bootentry', status: ['added', 'failed', 'skipped'].includes(ev.bootentry) ? ev.bootentry : 'failed', message: String(ev.message || '') });
      } else if (ev && typeof ev === 'object' && ev.error) {
        sawError = true;
        send({ type: 'error', message: String(ev.error), stage: ev.stage || null, code: ev.code ?? null });
      } else if (ev && typeof ev === 'object' && typeof ev.stage === 'string') {
        const progress = Math.max(0, Math.min(100, Number(ev.progress) || 0));
        send({ type: 'progress', stage: ev.stage, progress, message: String(ev.message || '') });
        if (ev.stage === 'done') {
          sawDone = true;
          send({ type: 'done' });
        }
      } else {
        pushLog(line);
        send({ type: 'log', line });
      }
    });
    const err = lineSplitter((line) => {
      if (/^sudo: .*(not allowed|not in the sudoers|may not run sudo)/i.test(line)) notAdmin = true;
      else if (/^sudo: .*(password is required|a terminal is required)/i.test(line)) authError = true;
      pushLog(line);
      send({ type: 'log', line });
    });
    child.stdout.on('data', (d) => out.push(String(d)));
    child.stderr.on('data', (d) => err.push(String(d)));
    child.stdin.on('error', () => {});
    child.stdin.end(`${opts.password}\n`);
    child.on('error', (e) => {
      pushLog(`aurora-install: ${e.message}`);
      if (!sawError) send({ type: 'error', message: e.message, stage: null, code: null });
      sawError = true;
    });
    child.on('close', (code, signal) => {
      out.flush();
      err.flush();
      const cancelled = job?.cancelled || false;
      job = null;
      const rc = code ?? (signal ? 128 : 1);
      if (rc === 0 && sawDone) finished = true;
      else if (!sawError) {
        const message = notAdmin
          ? 'This account is not allowed to make administrator changes (sudo refused it)'
          : authError
            ? 'Administrator rights are required to install (sudo refused the request)'
            : cancelled
              ? 'installation cancelled'
              : `the installer stopped unexpectedly (exit ${rc})`;
        send({ type: 'error', message, stage: null, code: notAdmin ? 'ENOTADMIN' : authError ? 'EAUTH' : rc });
      }
      send({ type: 'exit', code: rc, cancelled });
    });
    return { dryRun };
  });

  api.handle('installer:cancel', () => {
    if (!job) return false;
    job.cancelled = true;
    // sudo relays SIGTERM to the helper, which stops the current step and unmounts everything.
    try {
      job.child.kill('SIGTERM');
    } catch {}
    return true;
  });

  api.handle('installer:reboot', async () => {
    if (dryRun) return { simulated: true };
    const r = await run('systemctl', ['reboot'], { timeout: 15000 }).catch((e) => ({ code: 1, stderr: e.message }));
    if (r.code !== 0) {
      const s = await run('sudo', ['-n', 'systemctl', 'reboot'], { timeout: 15000 }).catch((e) => ({ code: 1, stderr: e.message }));
      if (s.code !== 0) throw api.error(`Restart failed: ${(r.stderr || s.stderr || '').trim()}`, 'ECMD');
    }
    return { simulated: false };
  });
}

module.exports = register;
module.exports.register = register;
module.exports.parseLsblk = parseLsblk;
module.exports.parseZoneTab = parseZoneTab;
module.exports.buildArgs = buildArgs;
module.exports.KEYBOARDS = KEYBOARDS;
module.exports.RESERVED_USERS = RESERVED_USERS;
module.exports.MIN_SIZE = MIN_SIZE;
module.exports.STAGES = STAGES;
module.exports.GAMING_APPS = GAMING_APPS;
module.exports.analyzeDisk = analyzeDisk;
module.exports.describeDisk = describeDisk;
module.exports.checkPlan = checkPlan;
module.exports.parseSurvey = parseSurvey;
module.exports.loadFixture = loadFixture;
module.exports.MiB = MiB;
