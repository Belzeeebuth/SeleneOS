// « Installer à côté » (dual boot): the root helpers' protocol, without root and without any disk.
//   rootfs/usr/lib/aurora/helpers/aurora-install --alongside … --dry-run   (validation + simulated stages, JSON lines)
//   rootfs/usr/lib/aurora/helpers/aurora-disk-probe                        (argument validation only: never run here
//                                                                          on a real disk; tools/test-alongside.sh runs it
//                                                                          as root on loop devices)
// Both argv spellings are accepted: --fingerprint/--free-space S:E/--new-size and --expect-table/--free-start S
// --root-size R/--shrink-to. Nothing here opens a block device (dry runs never do).
// Usage: cd aurora-os/shell && node test/installer-alongside.test.mjs
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from './lib.mjs';

const OS_ROOT = path.join(ROOT, '..');
const HELPER = path.join(OS_ROOT, 'rootfs/usr/lib/aurora/helpers/aurora-install');
const PROBE = path.join(OS_ROOT, 'rootfs/usr/lib/aurora/helpers/aurora-disk-probe');
const FP = 'a'.repeat(64);
let passed = 0;
const failures = [];
function check(name, ok, info) {
  if (ok) passed++;
  else failures.push(`${name}${info !== undefined ? `\n      got: ${typeof info === 'string' ? info : JSON.stringify(info)}` : ''}`);
}
function helper(args, env = {}) {
  const base = ['--json', '--password-stdin', '--disk', '/dev/nvme0n1', '--user', 'anna', '--lang', 'fr', '--keyboard', 'fr', '--timezone', 'Europe/Paris'];
  const r = spawnSync('bash', [HELPER, ...base, ...args, '--dry-run', '--dry-run-delay', '0'], { input: 'pw-123\n', encoding: 'utf8', env: { ...process.env, ...env, LC_ALL: 'C' } });
  const events = r.stdout.split('\n').filter(Boolean).map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return { raw: l };
    }
  });
  return { code: r.status, events, stderr: r.stderr, error: events.find((e) => e.error) };
}

// ---- dry runs (both spellings)
{
  const r = helper(['--alongside', '--fingerprint', FP, '--esp', '1', '--shrink', '3', '--new-size', '200000']);
  const stages = [...new Set(r.events.filter((e) => e.stage).map((e) => e.stage))];
  check('dry run --shrink: exit 0, stages partition..done', r.code === 0 && stages[0] === 'partition' && stages.at(-1) === 'done', { code: r.code, stages, stderr: r.stderr.slice(-300) });
  check('dry run --shrink: says the partition is shrunk and the files kept', r.events.some((e) => /Shrinking partition \/dev\/nvme0n1p3 to 200000 MiB \(your files are kept\)/.test(e.message || '')));
  check('dry run --shrink: never says it erases or formats the ESP', !r.events.some((e) => /wipefs|mkfs\.vfat|Partitioning \/dev/.test(e.message || '')) && !/mkfs\.vfat|wipefs --all/.test(r.stderr), r.stderr.slice(-400));
  check('dry run alongside: firmware boot entry event', r.events.some((e) => e.bootentry === 'added'));
  check('dry run alongside: UEFI only (no BIOS grub-install)', !/i386-pc/.test(r.stderr) && /x86_64-efi --bootloader-id=ubuntu --no-nvram/.test(r.stderr));
}
{
  const r = helper(['--alongside', '--expect-table', FP, '--esp', '1', '--free-start', '300000', '--root-size', '40000']);
  check('dry run --free-start/--root-size (other spelling): exit 0, plan free:300000:340000', r.code === 0 && /free:300000:340000/.test(r.stderr), { code: r.code, err: r.error });
}
{
  const r = helper(['--alongside', '--expect-table', FP, '--esp', '1', '--shrink', '3', '--shrink-to', '200000', '--root-size', '40000']);
  check('dry run --shrink-to/--root-size: exit 0, plan shrink:3:200000:40000', r.code === 0 && /shrink:3:200000:40000/.test(r.stderr), { code: r.code, err: r.error });
}
{
  const r = helper(['--alongside', '--fingerprint', FP, '--esp', '1', '--free-space', '300000:340000'], { AURORA_DRYRUN_BOOTENTRY_FAIL: '1' });
  check('dry run: a refused boot entry is reported, the installation still finishes', r.code === 0 && r.events.some((e) => e.bootentry === 'failed') && r.events.some((e) => e.stage === 'done'));
}
{
  const r = helper(['--alongside', '--fingerprint', FP, '--esp', '1', '--free-space', '300000:340000'], { AURORA_DRYRUN_PLAN_REFUSED: 'changed' });
  check('dry run: a changed partition table is refused (exit 4, nothing changed)', r.code === 4 && /changed since they were shown: nothing was changed/.test(r.error?.error || ''), r.error);
}
{
  const r = helper(['--alongside', '--fingerprint', FP, '--esp', '1', '--shrink', '3', '--new-size', '200000', '--fail-at', 'shrink']);
  check('--fail-at shrink (installer.js STAGES): accepted, fails at the shrink', r.code === 5 && /simulated failure at stage 'shrink'/.test(r.error?.error || ''), r.error);
}
{
  const r = helper([]);
  check('erase mode unchanged: wipefs + GPT + ESP formatted + BIOS GRUB', r.code === 0 && /wipefs --all \/dev\/nvme0n1/.test(r.stderr) && /mkfs\.vfat/.test(r.stderr) && /i386-pc/.test(r.stderr) && !r.events.some((e) => e.bootentry));
}

// ---- refusals (exit 2: invalid arguments; nothing is ever opened)
const bad = [
  ['no fingerprint', ['--alongside', '--esp', '1', '--free-space', '300000:340000']],
  ['short fingerprint', ['--alongside', '--fingerprint', 'abc', '--esp', '1', '--free-space', '300000:340000']],
  ['no ESP', ['--alongside', '--fingerprint', FP, '--free-space', '300000:340000']],
  ['ESP 0', ['--alongside', '--fingerprint', FP, '--esp', '0', '--free-space', '300000:340000']],
  ['no plan', ['--alongside', '--fingerprint', FP, '--esp', '1']],
  ['both plans', ['--alongside', '--fingerprint', FP, '--esp', '1', '--free-space', '300000:340000', '--shrink', '3', '--new-size', '9000']],
  ['Selene < 20 GB (free space)', ['--alongside', '--fingerprint', FP, '--esp', '1', '--free-space', '300000:310000']],
  ['Selene < 20 GB (--root-size)', ['--alongside', '--expect-table', FP, '--esp', '1', '--shrink', '3', '--shrink-to', '9000', '--root-size', '19000']],
  ['end before start', ['--alongside', '--fingerprint', FP, '--esp', '1', '--free-space', '340000:300000']],
  ['shrink the ESP', ['--alongside', '--fingerprint', FP, '--esp', '1', '--shrink', '1', '--new-size', '9000']],
  ['partition 129', ['--alongside', '--fingerprint', FP, '--esp', '1', '--shrink', '129', '--new-size', '9000']],
  ['new size < 1 GiB', ['--alongside', '--fingerprint', FP, '--esp', '1', '--shrink', '3', '--new-size', '512']],
  ['metacharacters', ['--alongside', '--fingerprint', FP, '--esp', '1', '--shrink', '3', '--new-size', '9000;reboot']],
  ['negative', ['--alongside', '--fingerprint', FP, '--esp', '1', '--free-space', '-1:30000']],
  ['--free-start without --root-size', ['--alongside', '--expect-table', FP, '--esp', '1', '--free-start', '300000']],
  ['--root-size not matching --free-space', ['--alongside', '--fingerprint', FP, '--esp', '1', '--free-space', '300000:340000', '--root-size', '30000']],
  ['plan options without --alongside', ['--shrink', '3', '--new-size', '9000']],
];
for (const [name, args] of bad) {
  const r = helper(args);
  check(`refused (exit 2): ${name}`, r.code === 2 && r.error && r.error.stage === 'init', { code: r.code, err: r.error });
}

// ---- aurora-disk-probe: argument validation happens before anything is read
for (const [name, args] of [
  ['bad disk path', ['--disk', '/dev/../etc/passwd']],
  ['unknown option', ['--erase']],
  ['bad --esp', ['--esp', '0']],
]) {
  const r = spawnSync('python3', ['-I', PROBE, ...args], { encoding: 'utf8' });
  check(`aurora-disk-probe refuses ${name} (exit 2)`, r.status === 2, { code: r.status, err: r.stderr });
}
{
  const r = spawnSync('python3', ['-I', PROBE, '--disk', '/dev/sda', '--plan', 'shrink:3:9000'], { encoding: 'utf8' });
  check('aurora-disk-probe --plan needs --fingerprint (exit 2)', r.status === 2, { code: r.status, err: r.stderr });
}

console.log(`installer-alongside: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL ${f}`);
process.exit(failures.length ? 1 : 0);
