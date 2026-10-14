// Disks › « Santé du disque » (SMART) tests.
//  1. pure parsers (main/ipc/disks-smart.js): busctl JSON decoding, argument vectors, udisks error classification,
//     smartctl -j -a reports (NVMe enclosure, ATA, SCSI);
//  2. the backend in-process (main/ipc/disks.js with a fake api, AURORA_DISKS_FIXTURE=health, fake busctl): status of
//     every fixture drive, « Inconnu » reasons, notified-once alerts, self-test start / progress / result / abort and
//     refusals, smartctl import, argument validation;
//  3. aurora-admin smart-info: syntax, delimited block, argument check, smart_report run with a fake smartctl (exact
//     argv, -d sat retry, exit codes), no smartctl option that changes the drive;
//  4. the real Electron shell (dev, health fixture) EN light: notifications shown once (daily-check feature + app),
//     list markers, every drive's health view (explanations, figures, detailed tables), self-tests from the UI,
//     the administrator read (smart-info, simulated), notification click -> the drive's health view, screenshots;
//  5. FR dark: strings, screenshots.
// Usage:  cd aurora-os/shell && xvfb-run -a -s "-screen 0 1600x900x24" node test/disks-health.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { launchShell, ROOT } from './lib.mjs';

const require = createRequire(import.meta.url);
const HELPER = path.join(ROOT, '..', 'rootfs', 'usr', 'lib', 'aurora', 'helpers', 'aurora-admin');
const FIX = path.join(ROOT, 'test', 'fixtures', 'disks', 'health');
const DOCS = path.join(ROOT, '..', 'docs', 'screenshots');

let passed = 0;
const failures = [];
function check(cond, name, extra) {
  if (cond) passed++;
  else {
    failures.push(`${name}${extra !== undefined ? ` (got ${JSON.stringify(extra)})` : ''}`);
    console.log(`  ✗ ${name}${extra !== undefined ? ` — got ${JSON.stringify(extra)}` : ''}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WIN = '.win.app-disks';

// ---------------------------------------------------------------- 1. pure parsers
const smart = require('../main/ipc/disks-smart.js');
{
  console.log('# parsers');
  // busctl --json=short prints variants as { type, data } and byte arrays (ay) as numbers ending with 0.
  const sample = '{"type":"a{sv}","data":[{"Device":{"type":"ay","data":[47,100,101,118,47,115,100,97,0]},"SmartUpdated":{"type":"t","data":1792000000},"SmartCriticalWarning":{"type":"as","data":["spare"]}}]}\n';
  const j = smart.parseBusctlJson(sample);
  const d = smart.decodeDict(j.data[0]);
  check(d.Device === '/dev/sda' && d.SmartUpdated === 1792000000 && d.SmartCriticalWarning[0] === 'spare', 'busctl JSON: ay -> string, t and as kept', d);
  check(smart.parseBusctlJson('').data.length === 0, 'busctl: a void method (empty output) parses as no data');
  let threw = false;
  try {
    smart.parseBusctlJson('{"nope":1}');
  } catch {
    threw = true;
  }
  check(threw, 'busctl: unexpected JSON is refused');

  const ATA = smart.IFACE.ata;
  const NVME = smart.IFACE.nvme;
  const obj = '/org/freedesktop/UDisks2/drives/WDC_X';
  const up = smart.argv.smartUpdate(obj, ATA);
  check(up.join(' ') === `--system --json=short --timeout=30 --allow-interactive-authorization=no call org.freedesktop.UDisks2 ${obj} ${ATA} SmartUpdate a{sv} 2 nowakeup b true auth.no_user_interaction b true`, 'argv: ATA SmartUpdate never wakes a sleeping disk, no interaction', up.join(' '));
  check(!smart.argv.smartUpdate(obj, ATA, { wake: true }).includes('nowakeup'), 'argv: « Read now » drops nowakeup');
  check(!smart.argv.smartUpdate(obj, NVME).includes('nowakeup'), 'argv: NVMe SmartUpdate has no nowakeup option');
  const stv = smart.argv.selftestStart(obj, NVME, 'extended');
  check(stv.slice(-7).join(' ') === 'SmartSelftestStart sa{sv} extended 1 auth.no_user_interaction b true', 'argv: SmartSelftestStart type + options', stv.slice(-7));
  check(smart.argv.smartAttributes(obj, ATA).includes('SmartGetAttributes') && smart.argv.managedObjects().includes('GetManagedObjects'), 'argv: SmartGetAttributes / GetManagedObjects');
  const allArgv = [up, stv, smart.argv.selftestAbort(obj, ATA), smart.argv.getAll(obj, ATA)].flat();
  check(allArgv.every((a) => typeof a === 'string' && !/[;&|`$]/.test(a)), 'argv: plain strings, nothing a shell would interpret');

  const cls = (m) => smart.classifyBusError(m);
  check(cls('Not authorized to perform operation') === 'ENOTAUTH', 'udisks error: not authorized -> ENOTAUTH');
  check(cls('Disk is in sleep mode and the nowakeup option was passed') === 'EASLEEP', 'udisks error: sleep mode -> EASLEEP');
  check(cls('There is already SMART self-test running') === 'EBUSY' && cls('There is already device self-test running') === 'EBUSY', 'udisks error: self-test running -> EBUSY');
  check(cls('The NVMe controller has no support for self-test operations') === 'ENOTSUP' && cls('SMART is not supported or enabled') === 'ENOTSUP', 'udisks error: no self-test -> ENOTSUP');
  check(cls('The name org.freedesktop.UDisks2 was not provided by any .service files') === 'ENOSERVICE', 'udisks error: no service -> ENOSERVICE');
  check(cls('Something else went wrong') === 'EFAIL', 'udisks error: anything else -> EFAIL');

  // smartctl -j -a: the USB NVMe enclosure of the fixture
  const sc = JSON.parse(fs.readFileSync(path.join(FIX, 'smartctl.json'), 'utf8'))['/dev/sdd'];
  const hs = smart.healthFromSmartctl(sc, { path: '/dev/sdd', rotational: false, size: 1e12 });
  check(hs.source === 'smartctl' && hs.kind === 'nvme' && hs.status === 'good', 'smartctl: NVMe behind a USB bridge -> good', [hs.source, hs.kind, hs.status]);
  check(hs.ssd.used === 4 && hs.temperature === 36 && hs.ssd.dataWritten > 1e13 && hs.nvmeLog.some((r) => r.key === 'percent_used'), 'smartctl: NVMe figures (wear, temperature, TB written, log rows)', [hs.ssd.used, hs.temperature, hs.ssd.dataWritten]);
  const worn = JSON.parse(JSON.stringify(sc));
  worn.nvme_smart_health_information_log.critical_warning = 0x09; // spare + read-only
  worn.nvme_smart_health_information_log.percentage_used = 103;
  const hw = smart.healthFromSmartctl(worn, { path: '/dev/sdd' });
  check(hw.status === 'failing' && hw.criticalWarnings.join() === 'spare,readonly' && hw.problems.some((p) => p.code === 'wear'), 'smartctl: critical warning bits decoded (read-only -> failing)', [hw.status, hw.criticalWarnings]);
  // ATA report (smartctl's JSON layout): a pending sector + the drive's own FAILED verdict
  const ata = {
    device: { protocol: 'ATA' }, rotation_rate: 7200, smart_status: { passed: false }, temperature: { current: 41 }, power_on_time: { hours: 1000 }, power_cycle_count: 50,
    ata_smart_data: { self_test: { status: { value: 0xf9, string: 'in progress, 90% remaining', remaining_percent: 90 } }, capabilities: { self_tests_supported: true } },
    ata_smart_attributes: { table: [
      { id: 5, name: 'Reallocated_Sector_Ct', value: 100, worst: 100, thresh: 10, when_failed: '', flags: { prefailure: true }, raw: { value: 8, string: '8' } },
      { id: 197, name: 'Current_Pending_Sector', value: 200, worst: 200, thresh: 0, when_failed: '', flags: { prefailure: false }, raw: { value: 2, string: '2' } },
    ] },
    ata_smart_self_test_log: { standard: { table: [{ type: { value: 2 }, status: { value: 0x74, passed: false }, lifetime_hours: 990 }] } },
  };
  const ha = smart.healthFromSmartctl(ata, { path: '/dev/sdb' });
  check(ha.kind === 'ata' && ha.status === 'failing' && ha.sectors.reallocated === 8 && ha.sectors.pending === 2, 'smartctl: ATA report -> failing, sector counts', [ha.kind, ha.status, ha.sectors]);
  check(ha.selftest.running && ha.selftest.percentRemaining === 90 && ha.selftest.log[0].result === 'failed' && ha.selftest.log[0].detail === 'read', 'smartctl: ATA self-test in progress + log (read failure)', ha.selftest);
  const scsi = smart.healthFromSmartctl({ device: { protocol: 'SCSI' }, smart_status: { passed: true }, scsi_grown_defect_list: 3, temperature: { current: 30 } }, { path: '/dev/sdf' });
  check(scsi.kind === 'scsi' && scsi.status === 'warning' && scsi.sectors.reallocated === 3, 'smartctl: SAS / SCSI grown defects -> warning', [scsi.kind, scsi.status]);
  const nos = smart.healthFromSmartctl({ device: { protocol: 'ATA' }, smart_support: { available: false } }, { path: '/dev/sdf', type: 'disk' });
  check(nos.status === 'unknown' && nos.reason === 'unsupported', 'smartctl: no SMART support -> unknown (unsupported)', [nos.status, nos.reason]);
  check(smart.unknownReason({ name: 'mmcblk0', tran: '' }) === 'card' && smart.unknownReason({ name: 'vda', tran: 'virtio' }) === 'virtual' && smart.unknownReason({ name: 'sdx', model: 'QEMU HARDDISK', tran: 'sata' }) === 'virtual' && smart.unknownReason({ name: 'sr0', type: 'rom' }) === 'optical', 'unknown reasons: card / virtual (virtio, QEMU) / optical');
  check(!smart.smartctlMayHelp({ type: 'disk', path: '/dev/sdc', removableMedia: true }, 'usb') && smart.smartctlMayHelp({ type: 'disk', path: '/dev/sdd', removableMedia: false }, 'usb'), 'administrator read offered for a USB enclosure, not for a USB stick');
}

// ---------------------------------------------------------------- 2. backend in-process (fixture « health »)
const backendHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-disks-health-'));
{
  console.log('# backend');
  process.env.HOME = backendHome;
  process.env.AURORA_DISKS_FIXTURE = 'health';
  process.env.AURORA_DISKS_SELFTEST_MS = '500,900';
  delete process.env.AURORA_REAL_BACKENDS;
  const register = require('../main/ipc/disks.js');
  const H = {};
  const events = [];
  register({ DEV: true, handle: (ch, fn) => (H[ch] = fn), broadcast: (ch, p) => events.push([ch, p]) });
  const call = async (ch, ...a) => {
    try {
      return { ok: await H[ch](...a) };
    } catch (e) {
      return { error: { code: e.code, message: e.message } };
    }
  };

  const list = (await call('disks:list')).ok;
  check(list?.drives.length === 8, 'fixture « health »: 8 drives from its lsblk.json', list?.drives.map((d) => d.name));
  const r1 = (await call('disks:healthCheck')).ok;
  const by = Object.fromEntries((r1?.drives || []).map((x) => [x.device, x]));
  const expect = {
    '/dev/nvme0n1': ['good', 'nvme'], '/dev/nvme1n1': ['warning', 'nvme'], '/dev/sda': ['good', 'ata'], '/dev/sdb': ['failing', 'ata'],
    '/dev/sdc': ['unknown', null], '/dev/sdd': ['unknown', null], '/dev/sde': ['good', 'ata'], '/dev/vda': ['unknown', null],
  };
  for (const [dev, [st, kind]] of Object.entries(expect)) check(by[dev]?.status === st && by[dev]?.kind === kind, `status of ${dev}: ${st}`, [by[dev]?.status, by[dev]?.kind]);
  const n1 = by['/dev/nvme1n1'];
  check(n1?.ssd.used === 98 && n1.ssd.spare === 7 && n1.criticalWarnings.includes('spare') && ['spareLow', 'wear', 'mediaErrors'].every((c) => n1.problems.some((p) => p.code === c)), 'worn NVMe: 98 % used, spare below its limit (critical warning bit), integrity errors', n1?.problems);
  check(n1?.ssd.dataWritten > 2e14 && n1.ssd.unsafeShutdowns === 412 && n1.powerOnHours === 21940 && n1.temperature === 41, 'worn NVMe: TB written, unsafe shutdowns, hours, temperature');
  const b = by['/dev/sdb'];
  check(b && b.sectors.reallocated === 1856 && b.sectors.pending === 48 && b.sectors.uncorrectable === 37 && b.sectors.crc === 2, 'failing HDD: reallocated / pending / uncorrectable / CRC counts', b?.sectors);
  check(b && ['predictsFailure', 'attrFailing', 'selftestFailed', 'badSectors'].every((c) => b.problems.some((p) => p.code === c)) && b.problems.find((p) => p.code === 'crc')?.level === 'info', 'failing HDD: its own verdict, failing attribute, failed self-test, bad sectors (CRC only informative)', b?.problems.map((p) => p.code));
  check(b?.attributes.some((a) => a.id === 5 && a.failingNow) && b.attributes.every((a) => a.id && a.name && a.raw), 'failing HDD: attribute 5 below its threshold, every row complete');
  const sa = by['/dev/sda'];
  check(sa && sa.ssd.used === 1 && sa.ssd.dataWritten > 1e13 && sa.problems.length === 0 && sa.temperature === 35, 'SATA SSD: wear from its life attribute, data written, no problem', sa?.ssd);
  check(by['/dev/sde']?.selftest.running && by['/dev/sde'].selftest.percentRemaining === 60, 'HDD with a self-test in progress: 60 % left', by['/dev/sde']?.selftest);
  check(by['/dev/sdc']?.reason === 'usb' && !by['/dev/sdc'].canSmartctl, 'USB stick: « Inconnu » (usb), no administrator read');
  check(by['/dev/sdd']?.reason === 'usb' && by['/dev/sdd'].canSmartctl, 'USB enclosure: « Inconnu » (usb), administrator read offered');
  check(by['/dev/vda']?.reason === 'virtual' && !by['/dev/vda'].canSmartctl, 'virtio disk: « Inconnu » (virtual)');
  check(by['/dev/nvme0n1']?.source === 'udisks' && by['/dev/nvme0n1'].updated > Date.now() - 10 * 60000, 'udisks source + update time');

  // notified once
  const alerts1 = (r1?.alerts || []).map((a) => `${a.device}:${a.status}`).sort();
  check(alerts1.join() === '/dev/nvme1n1:warning,/dev/sdb:failing', 'first check: one alert per drive at « Attention » or worse', alerts1);
  check(events.filter(([c]) => c === 'disks:health-alert').length === 1 && events[0][1].alerts.length === 2, 'alerts broadcast once (disks:health-alert)', events.length);
  check(r1?.alerts.find((a) => a.device === '/dev/sdb')?.name === 'WDC WD10EZEX-08WN4A0', 'alert carries the drive name');
  const stateFile = path.join(backendHome, '.config', 'aurora', 'apps', 'disks', 'health-notified.json');
  check(fs.existsSync(stateFile) && Object.keys(JSON.parse(fs.readFileSync(stateFile, 'utf8'))).length === 2, 'notified drives remembered in ~/.config/aurora/apps/disks/health-notified.json');
  const r2 = (await call('disks:healthCheck')).ok;
  check(r2?.alerts.length === 0 && events.length === 1, 'second check: no new alert', r2?.alerts);
  // worse than before (warning -> failing) is announced again; healthy again is forgotten
  await call('disks:devHealth', '/dev/nvme1n1', { nvme: { SmartCriticalWarning: ['spare', 'readonly'] } });
  const r3 = (await call('disks:healthCheck')).ok;
  check(r3?.alerts.length === 1 && r3.alerts[0].device === '/dev/nvme1n1' && r3.alerts[0].status === 'failing', 'worse status (read-only NVMe) announced again', r3?.alerts);
  await call('disks:devHealth', '/dev/nvme1n1', { nvme: { SmartCriticalWarning: [] }, nvmeAttrs: { percent_used: 20, avail_spare: 90, media_errors: 0 } });
  await call('disks:healthCheck');
  check(!JSON.parse(fs.readFileSync(stateFile, 'utf8'))['WD Blue SN570 500GB|22184F801234'], 'a drive back to « Bon » is forgotten');
  await call('disks:devHealth', '/dev/nvme1n1', { nvmeAttrs: { percent_used: 98, avail_spare: 7, media_errors: 3 }, nvme: { SmartCriticalWarning: ['spare'] } });
  const r4 = (await call('disks:healthCheck')).ok;
  check(r4?.alerts.length === 1 && r4.alerts[0].status === 'warning', '…and a new problem after that is announced again', r4?.alerts);

  // single-drive read
  const one = (await call('disks:health', '/dev/sda', { refresh: true })).ok;
  check(one?.status === 'good' && one.updated >= Date.now() - 5000, 'disks:health refresh: SmartUpdate then fresh data', one?.updated);
  const bad = await call('disks:health', '/dev/../etc/passwd');
  check(bad.error?.code === 'EINVAL', 'disks:health rejects a bad device path', bad);
  const none = await call('disks:health', '/dev/sdz');
  check(none.error?.code === 'EINVAL', 'disks:health rejects an unknown drive', none);
  // a sleeping disk is never woken by a plain read
  await call('disks:devHealth', '/dev/sdb', { asleep: true, ata: { SmartUpdated: 0 } });
  const asleep = (await call('disks:health', '/dev/sdb', { refresh: true })).ok;
  check(asleep?.status === 'unknown' && asleep.reason === 'asleep', 'sleeping ATA disk without data: « Inconnu » (asleep), not woken up', [asleep?.status, asleep?.reason]);
  const woken = (await call('disks:health', '/dev/sdb', { refresh: true, wake: true })).ok;
  check(woken?.status === 'failing', '« Read now » (wake) reads it', woken?.status);

  // self-tests
  const t0 = (await call('disks:selftestStart', '/dev/sda', 'short')).ok;
  check(t0?.selftest.running && t0.selftest.percentRemaining === 90, 'short self-test starts (ATA reports 90 % left)', t0?.selftest);
  const busy = await call('disks:selftestStart', '/dev/sda', 'extended');
  check(busy.error?.code === 'EBUSY', 'a second self-test on the same drive -> EBUSY', busy);
  await sleep(300);
  const mid = (await call('disks:health', '/dev/sda')).ok;
  check(mid?.selftest.running && mid.selftest.percentRemaining < 90 && mid.selftest.percentRemaining >= 10, 'progress moves', mid?.selftest.percentRemaining);
  await sleep(400);
  const done = (await call('disks:health', '/dev/sda')).ok;
  check(!done?.selftest.running && done.selftest.last === 'success', 'self-test finished: success', done?.selftest);
  const n0 = (await call('disks:selftestStart', '/dev/nvme0n1', 'extended')).ok;
  check(n0?.selftest.running && n0.selftest.percentRemaining === 100, 'NVMe extended self-test starts', n0?.selftest);
  const ab = (await call('disks:selftestAbort', '/dev/nvme0n1')).ok;
  check(!ab?.selftest.running && ab.selftest.last === 'aborted', 'self-test stopped -> aborted', ab?.selftest);
  check((await call('disks:selftestStart', '/dev/sde', 'short')).error?.code === 'EBUSY', 'drive with a test already in progress -> EBUSY');
  check((await call('disks:selftestStart', '/dev/sdc', 'short')).error?.code === 'ENOTSUP', 'USB stick: no self-test (ENOTSUP)');
  check((await call('disks:selftestStart', '/dev/sda', 'conveyance; rm')).error?.code === 'EINVAL', 'unknown self-test type rejected');
  await call('disks:devHealth', '/dev/sda', { denySelftest: true });
  check((await call('disks:selftestStart', '/dev/sda', 'short')).error?.code === 'ENOTAUTH', 'polkit refusal -> ENOTAUTH');
  const fb = (await call('disks:selftestStart', '/dev/sdb', 'short')).ok;
  check(fb?.selftest.running, 'failing HDD: self-test runs');
  await sleep(700);
  const fbr = (await call('disks:health', '/dev/sdb')).ok;
  check(fbr?.selftest.last === 'failed' && fbr.selftest.lastDetail === 'read' && fbr.problems.some((p) => p.code === 'selftestFailed'), 'failing HDD: self-test result « failed (read) »', fbr?.selftest);

  // smartctl import (aurora-admin smart-info, simulated)
  const out = await register.devSmartInfo(['/dev/sdd']);
  const imp = (await call('disks:smartctlImport', '/dev/sdd', out)).ok;
  check(imp?.status === 'good' && imp.source === 'smartctl', 'smart-info report imported for the USB enclosure', [imp?.status, imp?.source]);
  const again = (await call('disks:health', '/dev/sdd')).ok;
  check(again?.source === 'smartctl' && again.status === 'good', 'the administrator read is kept for the session');
  check((await call('disks:smartctlImport', '/dev/sdd', 'not json')).error?.code === 'EINVAL', 'import: invalid JSON rejected');
  check((await call('disks:smartctlImport', '/dev/sdd', 'x'.repeat(5 * 1024 * 1024))).error?.code === 'EINVAL', 'import: oversized report rejected');
  check((await call('disks:smartctlImport', '/dev/vda', '{}')).error?.code === 'EINVAL', 'import: only /dev/sdX and /dev/nvmeNnM');
  let siErr = null;
  await register.devSmartInfo(['/dev/sdc']).catch((e) => (siErr = e.code));
  check(siErr === 'ENOTFOUND', 'smart-info simulation: a USB stick gives no health data (ENOTFOUND = exit 3)', siErr);
  siErr = null;
  await register.devSmartInfo(['/dev/sda1']).catch((e) => (siErr = e.code));
  check(siErr === 'EINVAL', 'smart-info simulation: a partition is refused');
  const sched = (await call('disks:healthSchedule')).ok;
  check(sched && sched.enabled === false && sched.pollMs === 1000 && sched.interval >= 86400000, 'daily check: off in dev unless AURORA_DISK_HEALTH_DELAY_MS, interval one day', sched);
  await call('disks:devReset');
  fs.rmSync(backendHome, { recursive: true, force: true });
}

// ---------------------------------------------------------------- 3. aurora-admin smart-info
{
  console.log('# aurora-admin smart-info');
  const src = fs.readFileSync(HELPER, 'utf8');
  check(spawnSync('bash', ['-n', HELPER]).status === 0, 'aurora-admin passes bash -n');
  const m = /# -+ BEGIN smart[^\n]*\n([\s\S]*?)# -+ END smart/.exec(src);
  check(!!m && /\nsmart-info\)/.test(m[1]), 'aurora-admin has the delimited smart-info block');
  check(/smart-info <whole disk>/.test(src.split('set -euo pipefail')[0]), 'smart-info listed in the helper header');
  const block = m ? m[1] : '';
  const smartArgs = [...block.matchAll(/"\$\{SMART_CMD\[@\]\}"([^\n]*)/g)].map((x) => x[1].trim());
  check(smartArgs.length === 2 && smartArgs.every((a) => /^-j -a (-d sat )?-- "\$dev"/.test(a)), 'smartctl only ever runs with -j -a (and -d sat), the device after --', smartArgs);
  check(!/smartctl[^\n]*\s-(t|X|s|o|S)\b|--test|--abort|--smart=|--offlineauto|--saveauto/.test(block), 'no self-test / SMART on-off / offline option anywhere in the block');
  check(/\^\/dev\/\(sd\[a-z\]\{1,2\}\|nvme\[0-9\]\{1,2\}n\[0-9\]\{1,2\}\)\$/.test(block) && /lsblk -dno TYPE/.test(block), 'whole disks only (name pattern + lsblk TYPE disk)');
  const adminSrc = fs.readFileSync(path.join(ROOT, 'main', 'ipc', 'admin.js'), 'utf8');
  check(/ACTIONS\['smart-info'\] = \{ args: \[\/\^\\\/dev\\\/\(sd\[a-z\]\{1,2\}\|nvme\[0-9\]\{1,2\}n\[0-9\]\{1,2\}\)\$\/\]/.test(adminSrc), 'admin.js allow-lists smart-info with the same whole-disk pattern');

  // smart_report run with a fake smartctl
  const fn = /\n( {2}smart_report\(\) \{\n[\s\S]*?\n {2}\}\n)/.exec(block)?.[1];
  check(!!fn, 'smart_report function found');
  if (fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-smartinfo-'));
    const fake = path.join(dir, 'smartctl');
    const logf = path.join(dir, 'argv.log');
    fs.writeFileSync(fake, `#!/bin/bash
printf '%s\\n' "$*" >> "${logf}"
case "$FAKE_MODE" in
ok) echo '{"device":{"protocol":"ATA"}}' ;;
failing) echo '{"smart_status":{"passed":false}}'; exit 8 ;;
bridge) if [[ " $* " == *" -d sat "* ]]; then echo '{"device":{"type":"sat"}}'; else exit 2; fi ;;
nodata) exit 2 ;;
badcmd) exit 1 ;;
garbage) echo 'Smartctl open device failed' ;;
esac
`);
    fs.chmodSync(fake, 0o755);
    const script = path.join(dir, 'run.sh');
    fs.writeFileSync(script, `set -euo pipefail\nSMART_CMD=("${fake}")\n${fn}\nrc=0\nsmart_report "$1" || rc=$?\necho "rc=$rc"\n`);
    const runIt = (mode, dev) => {
      fs.rmSync(logf, { force: true });
      const r = spawnSync('bash', [script, dev], { encoding: 'utf8', env: { ...process.env, FAKE_MODE: mode } });
      const argv = fs.existsSync(logf) ? fs.readFileSync(logf, 'utf8').trim().split('\n') : [];
      return { out: r.stdout, rc: Number(/rc=(\d+)/.exec(r.stdout)?.[1]), argv };
    };
    const a = runIt('ok', '/dev/sdb');
    check(a.rc === 0 && a.argv.join('|') === '-j -a -- /dev/sdb' && /"protocol":"ATA"/.test(a.out), 'smart_report: smartctl -j -a -- <disk>, JSON printed', a);
    const f = runIt('failing', '/dev/nvme0n1');
    check(f.rc === 0 && /passed":false/.test(f.out), 'smart_report: a failing disk (status bit 3) still gives its report', f);
    const br = runIt('bridge', '/dev/sdd');
    check(br.rc === 0 && br.argv.join('|') === '-j -a -- /dev/sdd|-j -a -d sat -- /dev/sdd', 'smart_report: unknown USB bridge -> one retry with -d sat', br.argv);
    const nb = runIt('bridge', '/dev/nvme0n1');
    check(nb.rc === 3 && nb.argv.length === 1, 'smart_report: no -d sat retry for NVMe', nb);
    check(runIt('nodata', '/dev/sdc').rc === 3, 'smart_report: no health data -> 3');
    check(runIt('badcmd', '/dev/sdb').rc === 5, 'smart_report: smartctl command-line error -> 5');
    check(runIt('garbage', '/dev/sdb').rc === 5, 'smart_report: non-JSON output -> 5');
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (process.getuid?.() === 0) {
    const r = spawnSync(HELPER, ['smart-info', '/dev/sda1'], { encoding: 'utf8', input: '' });
    check(r.status === 2, 'real helper (root) refuses a partition', [r.status, r.stderr]);
  } else console.log('  (not root: real helper refusal skipped)');
}

// ---------------------------------------------------------------- 4. app, EN light
const errors = [];
const ENV = { AURORA_DISKS_FIXTURE: 'health', AURORA_DISK_HEALTH_DELAY_MS: '400', AURORA_DISKS_SELFTEST_MS: '3500,6000' };
const watch = (s) => {
  s.page.on('pageerror', (e) => errors.push(e.message));
  s.page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
};
async function until(page, expr, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await page.evaluate(expr).catch(() => false)) return true;
    await sleep(80);
  }
  return false;
}
const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
const text = (page, sel) => page.evaluate(`${q(sel)}?.innerText || ''`);
async function pick(page, dev) {
  await page.locator(`${WIN} .dk-drive[data-path="${dev}"]`).click();
  return until(page, `${q(`${WIN} .dk-drive.selected`)}?.dataset.path === '${dev}' && !!${q(`${WIN} .dk-hero`)} && !${q(`${WIN} .dk-hero-busy`)}`, 8000);
}
const diskToasts = (page) => page.evaluate(`window.__aurora.notifications.list().filter((n) => n.appId === 'disks').map((n) => n.title)`);

let s = await launchShell({ open: ['disks'], lang: 'en', theme: 'light', env: ENV, keepHome: true });
const home = s.home;
watch(s);
try {
  const { page } = s;
  console.log('# app (EN, light)');
  check(await until(page, `document.querySelectorAll('${WIN} .dk-drive').length === 8`, 15000), 'eight fixture drives listed');
  // notifications: the app's check and the daily-check feature both ran; each problem drive is announced once
  check(await until(page, `window.__aurora.notifications.list().filter((n) => n.appId === 'disks').length >= 2`, 8000), 'health notifications shown');
  await sleep(1500);
  const titles = await diskToasts(page);
  check(titles.length === 2 && titles.includes('WDC WD10EZEX-08WN4A0 may fail soon') && titles.includes('WD Blue SN570 500GB shows signs of wear'), 'one notification per drive at « Attention » or worse', titles);
  check(await page.evaluate(`[...document.querySelectorAll('#toasts .toast')].some((t) => /Back up your files now/.test(t.innerText))`), 'toast tells the user to back up');
  await s.shot('disks-health-toast-en');
  const markers = await page.evaluate(`[...document.querySelectorAll('${WIN} .dk-drive')].filter((d) => d.querySelector('.dk-drive-health')).map((d) => d.dataset.path + ':' + d.querySelector('.dk-drive-health').className)`);
  check(markers.length === 2 && markers.some((m) => m.startsWith('/dev/sdb:') && /st-failing/.test(m)) && markers.some((m) => m.startsWith('/dev/nvme1n1:') && /st-warning/.test(m)), 'list markers on the two problem drives', markers);
  check(await page.evaluate(`[...document.querySelectorAll('${WIN} .dk-drive-health')].every((m) => m.getAttribute('aria-label'))`), 'list markers have an accessible label');

  // the volumes view's « Health (SMART) » row links to the health view
  await pick(page, '/dev/sdb').catch(() => {});
  await page.locator(`${WIN} .dk-tab[data-view="volumes"]`).click();
  check(await until(page, `${q(`${WIN} .dk-smart`)}?.textContent.includes('Failure likely')`), 'drive details: « Health (SMART) » shows the status', await text(page, `${WIN} .dk-smart`));
  await page.locator(`${WIN} .dk-smart-link`).click();
  check(await until(page, `${q(`${WIN} .dk-tab[data-view="health"]`)}?.getAttribute('aria-selected') === 'true' && !!${q(`${WIN} .dk-hero`)}`), 'clicking it opens the Health tab');
  // tabs keyboard
  await page.keyboard.press('ArrowLeft');
  check(await until(page, `${q(`${WIN} .dk-tab[data-view="volumes"]`)}?.getAttribute('aria-selected') === 'true' && document.activeElement?.dataset.view === 'volumes'`), 'tabs: ArrowLeft goes to Volumes (focus follows)');
  await page.keyboard.press('ArrowRight');
  check(await until(page, `${q(`${WIN} .dk-tab[data-view="health"]`)}?.getAttribute('aria-selected') === 'true'`), 'tabs: ArrowRight back to Health');

  // failing HDD
  check(await pick(page, '/dev/sdb'), 'failing HDD selected');
  check(await page.evaluate(`${q(`${WIN} .dk-hero`)}.dataset.status === 'failing'`), 'failing HDD: hero status failing');
  const heroB = await text(page, `${WIN} .dk-hero`);
  check(/Failure likely/.test(heroB) && /Back up your files now/.test(heroB), 'failing HDD: « Failure likely » + back-up advice', heroB);
  const codes = await page.evaluate(`[...document.querySelectorAll('${WIN} .dk-problems li')].map((l) => l.dataset.code)`);
  check(['predictsFailure', 'attrFailing', 'selftestFailed', 'badSectors'].every((c) => codes.includes(c)) && !codes.includes('crc'), 'failing HDD: problems listed (CRC only as an indicator)', codes);
  check(/Damaged sectors: 1,904 \(replaced: 1,856, waiting: 48\)/.test(heroB) && /The last self-test failed \(read error\)|failed \(read/.test(heroB), 'failing HDD: plain-language problem texts', heroB);
  const indB = await page.evaluate(`Object.fromEntries([...document.querySelectorAll('${WIN} .dk-ind')].map((r) => [r.dataset.ind, { v: r.querySelector('.dk-ind-value').textContent, lv: [...r.classList].find((c) => c.startsWith('lv-')), x: r.querySelector('.dk-ind-x').textContent }]))`);
  check(indB.reallocated?.v === '1,856' && indB.pending?.v === '48' && indB.uncorrectable?.v === '37' && indB.crc?.v === '2', 'failing HDD: reallocated / pending / uncorrectable / CRC indicators', indB);
  check(indB.pending?.lv === 'lv-bad' && indB.reallocated?.lv === 'lv-bad' && indB.crc?.lv === 'lv-watch', 'failing HDD: indicator levels (problem / watch)', [indB.pending?.lv, indB.reallocated?.lv, indB.crc?.lv]);
  check(Object.values(indB).every((r) => r.x.length > 30) && /cable/.test(indB.crc?.x || '') && /spare/.test(indB.reallocated?.x || ''), 'every indicator has a plain-language explanation');
  const tilesB = await page.evaluate(`Object.fromEntries([...document.querySelectorAll('${WIN} .dk-tile')].map((t) => [t.dataset.tile, t.querySelector('.dk-tile-value').textContent]))`);
  check(tilesB.temperature === '45 °C' && tilesB.powerOn === '38,211 h' && tilesB.powerCycles === '2,589', 'failing HDD: temperature, power-on hours, power cycles', tilesB);
  check(!tilesB.lifeUsed, 'HDD: no SSD wear tile');
  // detailed attributes table
  check(await page.evaluate(`!!${q(`${WIN} details[data-expert="ata"]`)} && !${q(`${WIN} details[data-expert="ata"]`)}.open`), 'detailed attributes: collapsed by default');
  await page.locator(`${WIN} details[data-expert="ata"] summary`).click();
  check(await until(page, `${q(`${WIN} details[data-expert="ata"]`)}.open`), 'detailed attributes open');
  const heads = await page.evaluate(`[...document.querySelectorAll('${WIN} details[data-expert="ata"] th')].map((t) => t.textContent)`);
  check(heads.join('|') === 'ID|Attribute|Value|Worst|Threshold|Raw value|Type', 'detailed table columns: id, name, value, worst, threshold, raw', heads);
  const r5 = await page.evaluate(`(() => { const r = ${q(`${WIN} tr[data-id="5"]`)}; return r && { cls: r.className, cells: [...r.cells].map((c) => c.innerText.replace(/\\s+/g, ' ').trim()) }; })()`);
  check(r5 && /failing/.test(r5.cls) && r5.cells[0] === '5' && /Reallocated sectors/.test(r5.cells[1]) && /reallocated-sector-count/.test(r5.cells[1]) && r5.cells[5] === '1,856 sectors', 'detailed table: attribute 5 flagged, translated + raw name, raw value', r5);
  const rowCount = await page.evaluate(`document.querySelectorAll('${WIN} details[data-expert="ata"] tbody tr').length`);
  check(rowCount === 17, 'detailed table: every attribute of the drive', rowCount);
  check(await page.evaluate(`${q(`${WIN} tr[data-id="194"] .c-raw`)}?.textContent === '45 °C'`), 'detailed table: temperature raw value converted from mK');
  const lastB = await text(page, `${WIN} .dk-st-last`);
  check(/Last result: failed \(read error\)|Last result: failed/.test(lastB), 'failing HDD: last self-test result shown', lastB);
  await page.locator(`${WIN} .dk-main`).evaluate((m) => (m.scrollTop = 0));
  await s.shot('disks-health-failing-light-en');

  // worn NVMe
  check(await pick(page, '/dev/nvme1n1'), 'worn NVMe selected');
  check(await page.evaluate(`${q(`${WIN} .dk-hero`)}.dataset.status === 'warning'`), 'worn NVMe: « Warning »');
  const heroN = await text(page, `${WIN} .dk-hero`);
  check(/98 % of the expected lifespan is used/.test(heroN) && /7 % left, limit 10 %/.test(heroN) && /Data integrity errors: 3/.test(heroN), 'worn NVMe: wear, spare and integrity problems explained', heroN);
  const tilesN = await page.evaluate(`Object.fromEntries([...document.querySelectorAll('${WIN} .dk-tile')].map((t) => [t.dataset.tile, t.querySelector('.dk-tile-value').textContent]))`);
  check(tilesN.lifeUsed === '98 %' && tilesN.written === '297 TB' && tilesN.read === '181 TB' && tilesN.powerCycles === '3,120', 'worn NVMe: lifespan used, TB written / read, power cycles', tilesN);
  check(await page.evaluate(`${q(`${WIN} [data-tile="lifeUsed"] .dk-meter`)}?.getAttribute('aria-valuenow') === '98'`), 'lifespan meter (aria-valuenow 98)');
  const indN = await page.evaluate(`Object.fromEntries([...document.querySelectorAll('${WIN} .dk-ind')].map((r) => [r.dataset.ind, r.querySelector('.dk-ind-value').textContent]))`);
  check(indN.lifeUsed === '98 %' && indN.spare === '7 % (limit 10 %)' && indN.mediaErrors === '3' && indN.unsafe === '412' && /spare blocks/i.test(indN.critical || ''), 'worn NVMe: lifespan, spare, integrity errors, unsafe shutdowns, drive alerts', indN);
  await page.locator(`${WIN} details[data-expert="nvme"] summary`).click();
  const nv = await page.evaluate(`[...document.querySelectorAll('${WIN} details[data-expert="nvme"] tbody tr')].map((r) => r.dataset.key + '=' + r.querySelector('.c-raw').textContent)`);
  check(nv.includes('percent_used=98 %') && nv.includes('avail_spare=7 %') && nv.includes('media_errors=3') && nv.includes('total_data_written=297 TB') && nv.includes('ctrl_busy_time=18,233 min'), 'NVMe health log table', nv);
  await page.locator(`${WIN} .dk-main`).evaluate((m) => (m.scrollTop = 0));
  await s.shot('disks-health-nvme-light-en');

  // SATA SSD + self-test from the UI
  check(await pick(page, '/dev/sda'), 'SATA SSD selected');
  check(await page.evaluate(`${q(`${WIN} .dk-hero`)}.dataset.status === 'good' && /No problem found/.test(${q(`${WIN} .dk-hero`)}.innerText)`), 'SATA SSD: « Good », no problem found');
  const indS = await page.evaluate(`Object.fromEntries([...document.querySelectorAll('${WIN} .dk-ind')].map((r) => [r.dataset.ind, r.querySelector('.dk-ind-value').textContent]))`);
  check(indS.lifeUsed === '1 %' && indS.reallocated === '0' && indS.crc === '0', 'SATA SSD: wear + key sector indicators', indS);
  check(await page.evaluate(`!!${q(`${WIN} [data-fid="st-short"]`)} && !${q(`${WIN} [data-fid="st-short"]`)}.disabled && !!${q(`${WIN} [data-fid="st-extended"]`)}`), 'self-test buttons offered (administrator)');
  await page.locator(`${WIN} [data-fid="st-short"]`).click();
  check(await until(page, `/Quick test started on Samsung SSD 870 EVO 1TB/.test(${q(`${WIN} .dk-hnote`)}?.innerText || '')`), 'self-test: « started » note');
  check(await until(page, `!!${q(`${WIN} .dk-st-running`)} && /Quick test in progress… \\d+ % left/.test(${q(`${WIN} .dk-st-running`)}.innerText)`), 'self-test: progress text');
  const pv = Number(await page.evaluate(`${q(`${WIN} .dk-st-running [role="progressbar"]`)}?.getAttribute('aria-valuenow')`));
  check(pv >= 10 && pv < 100, 'self-test: progress bar value', pv);
  check(await page.evaluate(`!!${q(`${WIN} [data-fid="st-stop"]`)}`), 'self-test: Stop offered while running');
  await s.shot('disks-health-selftest-light-en');
  check(await until(page, `/Self-test finished on Samsung SSD 870 EVO 1TB: passed/.test(${q(`${WIN} .dk-hnote`)}?.innerText || '')`, 12000), 'self-test: result note when it ends');
  check(await until(page, `/Last result: passed/.test(${q(`${WIN} .dk-st-last`)}?.innerText || '') && document.querySelectorAll('${WIN} .dk-st-history li').length === 1`), 'self-test: last result + history entry');
  // stop a running test
  await page.locator(`${WIN} [data-fid="st-extended"]`).click();
  check(await until(page, `!!${q(`${WIN} [data-fid="st-stop"]`)}`), 'extended self-test running');
  await page.locator(`${WIN} [data-fid="st-stop"]`).click();
  check(await until(page, `/Self-test stopped/.test(${q(`${WIN} .dk-hnote`)}?.innerText || '') && !!${q(`${WIN} [data-fid="st-short"]`)}`), 'Stop: test stopped, buttons back');
  // a refusal (not allowed by polkit)
  await page.evaluate(`window.aurora.invokeRaw('disks:devHealth', '/dev/sda', { denySelftest: true })`);
  await page.locator(`${WIN} [data-fid="st-short"]`).click();
  check(await until(page, `/isn't allowed to start a self-test/.test(${q(`${WIN} .dk-hnote.error`)}?.innerText || '')`), 'refused self-test: clear error');
  await page.evaluate(`window.aurora.invokeRaw('disks:devHealth', '/dev/sda', { denySelftest: false })`);

  // HDD with a test already in progress
  check(await pick(page, '/dev/sde'), 'HDD with a running test selected');
  check(await until(page, `/Self-test in progress… 60 % left/.test(${q(`${WIN} .dk-st-running`)}?.innerText || '')`), 'self-test in progress (started elsewhere): 60 % left', await text(page, `${WIN} .dk-selftest`));
  check(await page.evaluate(`${q(`${WIN} .dk-st-running [role="progressbar"]`)}?.getAttribute('aria-valuenow') === '40'`), 'progress bar at 40 %');

  // « Inconnu »: USB stick, virtual disk, USB enclosure (+ administrator read)
  check(await pick(page, '/dev/sdc'), 'USB stick selected');
  const heroU = await text(page, `${WIN} .dk-hero`);
  check(await page.evaluate(`${q(`${WIN} .dk-hero`)}.dataset.status === 'unknown'`) && /Unknown/.test(heroU) && /USB sticks and most USB adapters/.test(heroU), 'USB stick: « Unknown » with the USB explanation', heroU);
  check(await page.evaluate(`!${q(`${WIN} .dk-smartctl`)} && !${q(`${WIN} .dk-selftest`)} && !${q(`${WIN} .dk-tiles`)}`), 'USB stick: no administrator read, no self-test, no figures');
  check(await pick(page, '/dev/vda'), 'virtual disk selected');
  check(/virtual disk/.test(await text(page, `${WIN} .dk-hero`)), 'virtio disk: virtual machine explanation');
  check(await pick(page, '/dev/sdd'), 'USB enclosure selected');
  check(await page.evaluate(`!!${q(`${WIN} .dk-smartctl`)} && /deeper query/.test(${q(`${WIN} .dk-hero`)}.innerText)`), 'USB enclosure: « Read with administrator rights… » offered with a hint');
  await s.shot('disks-health-unknown-light-en');
  await page.locator(`${WIN} .dk-smartctl`).click();
  await page.waitForSelector('.uac-dialog', { timeout: 8000 });
  check(/Disks wants to read the health report of Realtek RTL9210B-CG/.test(await text(page, '.uac-dialog')), 'elevation prompt explains the read', await text(page, '.uac-dialog'));
  const pw = page.locator('.uac-dialog input[type=password]');
  if (await pw.count()) await pw.fill('aurora');
  await page.locator('.uac-dialog .dialog-footer .btn.primary').click();
  check(await until(page, `${q(`${WIN} .dk-hero`)}?.dataset.status === 'good' && /smartctl/.test(${q(`${WIN} .dk-hero`)}.innerText)`, 10000), 'administrator read: « Good », source smartctl');
  check(await page.evaluate(`${q(`${WIN} [data-tile="lifeUsed"] .dk-tile-value`)}?.textContent === '4 %' && /can't be started through this connection/.test(${q(`${WIN} .dk-selftest`)}?.innerText || '')`), 'administrator read: figures shown, no self-test through the enclosure');

  check(await page.evaluate(`!${q(WIN)}.innerText.match(/\\bnull\\b|\\bundefined\\b|NaN|\\{\\w+\\}/)`), 'no null / undefined / NaN / raw placeholders');
  // keyboard: Tab reaches the self-test buttons from the tab bar
  await pick(page, '/dev/nvme0n1');
  await page.locator(`${WIN} .dk-tab[data-view="health"]`).focus();
  let reached = false;
  for (let i = 0; i < 12 && !reached; i++) {
    await page.keyboard.press('Tab');
    reached = await page.evaluate(`document.activeElement?.dataset?.fid === 'st-short'`);
  }
  check(reached, 'keyboard: Tab reaches « Quick test »');
  // narrow window: no horizontal overflow of the health view
  await page.evaluate(`(() => { const w = [].concat(window.__aurora.wm.byApp('disks') || [])[0]; w?.setSize?.(640, 560); })()`);
  await sleep(400);
  check(await page.evaluate(`(() => { const m = ${q(`${WIN} .dk-main`)}; return m.scrollWidth <= m.clientWidth + 1; })()`), 'narrow window: no horizontal overflow');

  // close + reopen the app: no second notification
  await page.evaluate(`[].concat(window.__aurora.wm.byApp('disks') || []).forEach((w) => w.close())`);
  await until(page, `!${q(WIN)}`, 5000);
  await page.evaluate(`window.__aurora.shell.launch('disks')`);
  check(await until(page, `document.querySelectorAll('${WIN} .dk-drive').length === 8`, 10000), 'app reopened');
  await sleep(1500);
  check((await diskToasts(page)).length === 2, 'reopening the app: no new notification', await diskToasts(page));
  // the notification opens the drive's health view
  await page.evaluate(`[].concat(window.__aurora.wm.byApp('disks') || []).forEach((w) => w.close())`);
  await until(page, `!${q(WIN)}`, 5000);
  const nid = await page.evaluate(`window.__aurora.notifications.list().find((n) => n.appId === 'disks' && /may fail soon/.test(n.title))?.id`);
  await page.evaluate(`window.__aurora.notifications.activate(${JSON.stringify(nid)})`);
  check(await until(page, `${q(`${WIN} .dk-drive.selected`)}?.dataset.path === '/dev/sdb' && ${q(`${WIN} .dk-tab[data-view="health"]`)}?.getAttribute('aria-selected') === 'true' && ${q(`${WIN} .dk-hero`)}?.dataset.status === 'failing'`, 10000), 'notification click: Disks opens on the failing drive\'s health view');
} catch (e) {
  failures.push(`EN run threw: ${e?.stack || e}`);
  console.log(e);
}
await s.close();

// a new session with the same home: still no repeated notification
s = await launchShell({ open: [], lang: 'en', theme: 'light', env: ENV, home });
watch(s);
try {
  await sleep(2500);
  check((await diskToasts(s.page)).length === 0, 'next session: problems already announced are not repeated', await diskToasts(s.page));
} catch (e) {
  failures.push(`second session threw: ${e?.stack || e}`);
}
await s.close();
fs.rmSync(home, { recursive: true, force: true });

// ---------------------------------------------------------------- 5. French + dark
s = await launchShell({ open: ['disks'], lang: 'fr', theme: 'dark', env: ENV });
watch(s);
try {
  const { page } = s;
  console.log('# app (FR, dark)');
  check(await until(page, `document.querySelectorAll('${WIN} .dk-drive').length === 8`, 15000), 'FR: drives listed');
  check(await until(page, `window.__aurora.notifications.list().filter((n) => n.appId === 'disks').length === 2`, 8000), 'FR: two notifications');
  const ft = await diskToasts(page);
  check(ft.includes('WDC WD10EZEX-08WN4A0 risque de tomber en panne') && ft.includes('WD Blue SN570 500GB montre des signes de faiblesse'), 'FR: notification titles', ft);
  await page.evaluate(`window.__aurora.notifications.list().forEach((n) => window.__aurora.notifications.hide?.(n.id))`);
  await pick(page, '/dev/sdb');
  await page.locator(`${WIN} .dk-tab[data-view="health"]`).click();
  await until(page, `!!${q(`${WIN} .dk-hero`)}`);
  const tabs = await page.evaluate(`[...document.querySelectorAll('${WIN} .dk-tab')].map((t) => t.textContent.trim())`);
  check(tabs.join('|') === 'Volumes|Santé', 'FR: tabs', tabs);
  const hb = await text(page, `${WIN} .dk-hero`);
  check(/Défaillance imminente/.test(hb) && /Sauvegardez vos fichiers dès maintenant/.test(hb) && /Secteurs abîmés : 1 904|Secteurs abîmés : 1 904/.test(hb), 'FR: « Défaillance imminente » + explanations', hb);
  const bt = await text(page, `${WIN} .dk-view`);
  check(/Secteurs en attente/.test(bt) && /Autotest/.test(bt) && /Test rapide/.test(bt) && /Dernier résultat : échec/.test(bt) && /Attributs détaillés/.test(bt), 'FR: indicators, self-test, detailed attributes translated');
  check(await page.evaluate(`document.documentElement.dataset.theme === 'dark'`), 'dark theme active');
  const bg = await page.evaluate(`getComputedStyle(${q(`${WIN} .dk-hero`)}).backgroundColor`);
  const lum = (bg.match(/\d+(\.\d+)?/g) || []).slice(0, 3).map(Number).reduce((a, c) => a + c, 0) / 3;
  check(lum < 110, 'dark theme: health card is dark', bg);
  await page.locator(`${WIN} details[data-expert="ata"] summary`).click();
  await page.locator(`${WIN} .dk-main`).evaluate((m) => (m.scrollTop = 0));
  await sleep(200);
  await s.shot('disks-health-failing-dark-fr');
  fs.mkdirSync(DOCS, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'test', 'out', 'disks-health-failing-dark-fr.png'), path.join(DOCS, 'disks-health-dark-fr.png'));
  await page.locator(`${WIN} .dk-main`).evaluate((m) => (m.scrollTop = m.scrollHeight));
  await sleep(200);
  await s.shot('disks-health-table-dark-fr');

  await pick(page, '/dev/nvme1n1');
  const hn = await text(page, `${WIN} .dk-view`);
  check(/Attention/.test(hn) && /Durée de vie utilisée/.test(hn) && /Réserve disponible|Réserve de secours|réserve/i.test(hn) && /Données écrites/.test(hn) && /To/.test(hn), 'FR: worn NVMe (« Attention », durée de vie utilisée, To)', hn.slice(0, 400));
  await page.locator(`${WIN} .dk-main`).evaluate((m) => (m.scrollTop = 0));
  await s.shot('disks-health-nvme-dark-fr');
  await pick(page, '/dev/sdc');
  const hu = await text(page, `${WIN} .dk-hero`);
  check(/Inconnu/.test(hu) && /clés USB/.test(hu), 'FR: « Inconnu » with the USB explanation', hu);
  await s.shot('disks-health-unknown-dark-fr');
  await pick(page, '/dev/sda');
  await page.locator(`${WIN} [data-fid="st-short"]`).click();
  check(await until(page, `/Test rapide en cours… \\d+ % restants/.test(${q(`${WIN} .dk-st-running`)}?.innerText || '')`), 'FR: self-test progress');
  await s.shot('disks-health-selftest-dark-fr');
  check(await page.evaluate(`!${q(WIN)}.innerText.match(/\\bnull\\b|\\bundefined\\b|NaN|\\{\\w+\\}/)`), 'FR: no raw placeholders');
} catch (e) {
  failures.push(`FR run threw: ${e?.stack || e}`);
  console.log(e);
}
await s.close();

// EN light screenshot for the docs (the failing drive)
fs.mkdirSync(DOCS, { recursive: true });
if (fs.existsSync(path.join(ROOT, 'test', 'out', 'disks-health-failing-light-en.png'))) fs.copyFileSync(path.join(ROOT, 'test', 'out', 'disks-health-failing-light-en.png'), path.join(DOCS, 'disks-health-light-en.png'));

const relevant = errors.filter((e) => !/favicon|DevTools|Autofill/i.test(e));
check(relevant.length === 0, 'no renderer errors', relevant.slice(0, 5));

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
