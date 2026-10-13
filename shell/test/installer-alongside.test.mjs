// « Installer à côté » (dual boot): the root helpers' protocol, without root and without any disk.
//   rootfs/usr/lib/aurora/helpers/aurora-install --alongside … --dry-run   (validation + simulated stages, JSON lines)
//   rootfs/usr/lib/aurora/helpers/aurora-disk-probe                        (argument validation only: never run here
//                                                                          on a real disk; tools/test-alongside.sh runs it
//                                                                          as root on loop devices)
// Both argv spellings are accepted: --fingerprint/--free-space S:E/--new-size and --expect-table/--free-start S
// --root-size R/--shrink-to. Nothing here opens a block device (dry runs never do).
// Usage: cd aurora-os/shell && node test/installer-alongside.test.mjs
import fs from 'node:fs';
import os from 'node:os';
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
  const r = helper(['--alongside', '--fingerprint', FP, '--esp', '1', '--reuse-partition', '3']);
  check('dry run --reuse-partition 3: exit 0, reuses nvme0n1p3, the partition table is not written', r.code === 0 && r.events.some((e) => /Reusing the Selene OS partition \/dev\/nvme0n1p3 of the previous attempt/.test(e.message || '')) && /reuse:3/.test(r.stderr) && !/sfdisk --append|ntfsresize/.test(r.stderr), { code: r.code, err: r.error, stderr: r.stderr.slice(-300) });
}
{
  const r = helper(['--alongside', '--fingerprint', FP, '--esp', '1', '--shrink', '2', '--new-size', '200000']);
  check('dry run alongside: the other systems\' own boot loaders are read (efibootmgr -v) for the menu', r.code === 0 && /efibootmgr -v \(the other systems' own boot loaders/.test(r.stderr));
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
  ['--reuse-partition with --shrink', ['--alongside', '--fingerprint', FP, '--esp', '1', '--reuse-partition', '3', '--shrink', '3', '--new-size', '9000']],
  ['--reuse-partition with --free-space', ['--alongside', '--fingerprint', FP, '--esp', '1', '--reuse-partition', '3', '--free-space', '300000:340000']],
  ['--reuse-partition with --root-size', ['--alongside', '--fingerprint', FP, '--esp', '1', '--reuse-partition', '3', '--root-size', '30000']],
  ['--reuse-partition of the ESP', ['--alongside', '--fingerprint', FP, '--esp', '1', '--reuse-partition', '1']],
  ['--reuse-partition 0', ['--alongside', '--fingerprint', FP, '--esp', '1', '--reuse-partition', '0']],
  ['--reuse-partition metacharacters', ['--alongside', '--fingerprint', FP, '--esp', '1', '--reuse-partition', '3;reboot']],
  ['--reuse-partition without --alongside', ['--reuse-partition', '3']],
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

// ---- the other systems' own EFI boot loaders (GRUB chainload entries): aurora-disk-probe --chainload (no root: reads
// only the folder and the efibootmgr -v text it is given) and the /etc/grub.d/25_aurora_chainload script aurora-install
// writes. tools/test-alongside.sh runs the whole thing on loop devices (CachyOS-like disk, injected efibootmgr -v).
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-chain-'));
  const esp = path.join(tmp, 'esp');
  for (const f of ['EFI/limine/BOOTX64.EFI', 'EFI/BOOT/BOOTX64.EFI', 'EFI/Microsoft/Boot/bootmgfw.efi', 'EFI/arch/grubx64.efi', "EFI/evil/a'b.efi", 'EFI/ubuntu/shimx64.efi', 'EFI/systemd/systemd-bootx64.efi', 'limine.conf', 'vmlinuz-linux-cachyos']) {
    fs.mkdirSync(path.dirname(path.join(esp, f)), { recursive: true });
    fs.writeFileSync(path.join(esp, f), 'x');
  }
  const G = '4f8e2b1a-1111-2222-3333-444455556666';
  const nvram = [
    'BootCurrent: 0001', 'Timeout: 0 seconds', 'BootOrder: 0003,0001,0002,0000,0006',
    `Boot0000* Windows Boot Manager\tHD(1,GPT,${G},0x800,0x800000)/File(\\EFI\\Microsoft\\Boot\\bootmgfw.efi)WINDOWS..x...B.C.D`,
    `Boot0001* Limine\tHD(1,GPT,${G.toUpperCase()},0x800,0x800000)/\\EFI\\limine\\BOOTX64.EFI`,
    '      dp: 04 01 2a 00 01 00 00 00',
    `Boot0002* UEFI OS\tHD(1,GPT,${G},0x800,0x800000)/File(\\EFI\\BOOT\\BOOTX64.EFI)..BO`,
    `Boot0003* Evil'; reboot\tHD(1,GPT,${G},0x800,0x800000)/File(\\EFI\\evil\\a'b.efi)`,
    `Boot0004* Other disk\tHD(1,GPT,aaaaaaaa-1111-2222-3333-444455556666,0x800,0x800000)/File(\\EFI\\arch\\grubx64.efi)`,
    `Boot0005  Inactive\tHD(1,GPT,${G},0x800,0x800000)/File(\\EFI\\arch\\grubx64.efi)`,
    `Boot0006* Selene\tHD(1,GPT,${G},0x800,0x800000)/File(\\EFI\\ubuntu\\shimx64.efi)`,
    'Boot0007* EFI USB Device\tPciRoot(0x0)/Pci(0x14,0x0)/USB(16,0)',
  ].join('\n');
  const nvf = path.join(tmp, 'efibootmgr-v.txt');
  fs.writeFileSync(nvf, nvram);
  const chain = (...args) => {
    const r = spawnSync('python3', ['-I', PROBE, '--chainload', esp, '--esp-partuuid', G, ...args], { encoding: 'utf8' });
    return { code: r.status, lines: r.stdout.split('\n').filter(Boolean).map((l) => l.split('\t')), err: r.stderr };
  };
  let r = chain('--efibootmgr', nvf, '--name', 'CachyOS', '--os-id', 'cachyos');
  check('chainload: NVRAM -> one entry « CachyOS » -> /EFI/limine/BOOTX64.EFI (Windows, EFI/BOOT, Selene, inactive, other disk, bad path skipped)', r.code === 0 && JSON.stringify(r.lines) === JSON.stringify([['/EFI/limine/BOOTX64.EFI', 'CachyOS', '1']]), r);
  r = chain('--efibootmgr', nvf);
  check('chainload: without the probe\'s name -> the firmware label « Limine »', JSON.stringify(r.lines) === JSON.stringify([['/EFI/limine/BOOTX64.EFI', 'Limine', '0']]), r);
  r = chain('--name', 'Arch Linux (rolling)', '--os-id', 'arch');
  check('chainload: no NVRAM -> known paths (Limine, systemd-boot, EFI/arch/grubx64.efi); the name goes to EFI/<os-id>, « (…) » dropped', JSON.stringify(r.lines) === JSON.stringify([['/EFI/limine/BOOTX64.EFI', 'Limine', '0'], ['/EFI/systemd/systemd-bootx64.efi', 'Linux Boot Manager', '0'], ['/EFI/arch/grubx64.efi', 'Arch Linux', '1']]), r);
  fs.writeFileSync(path.join(tmp, 'evil.txt'), `BootOrder: 0001\nBoot0001* Bad"$(reboot)\`id\`;\\\tHD(1,GPT,${G},0x800,0x800000)/File(\\EFI\\limine\\BOOTX64.EFI)`);
  r = chain('--efibootmgr', path.join(tmp, 'evil.txt'), '--name', "Cachy'OS\n$(reboot)");
  check('chainload: quotes, $( ), backquotes, ; and newlines never reach a title', r.code === 0 && r.lines.length === 1 && r.lines.every(([p, t]) => /^[A-Za-z0-9][A-Za-z0-9 ._+(),/-]*$/.test(t) && p === '/EFI/limine/BOOTX64.EFI'), r);
  r = chain('--efibootmgr', path.join(tmp, 'evil.txt'));
  check('chainload: a firmware label with metacharacters is cleaned (« Bad(reboot)id »: no quote, $, backquote, ; or backslash)', JSON.stringify(r.lines) === JSON.stringify([['/EFI/limine/BOOTX64.EFI', 'Bad(reboot)id', '0']]), r);
  for (const [name, args] of [['a relative folder', ['--chainload', 'esp', '--esp-partuuid', G]], ['a bad PARTUUID', ['--chainload', esp, '--esp-partuuid', `${G};x`]], ['no PARTUUID', ['--chainload', esp]]]) {
    const q = spawnSync('python3', ['-I', PROBE, ...args], { encoding: 'utf8', cwd: tmp });
    check(`chainload refuses ${name} (exit 2)`, q.status === 2, { code: q.status, err: q.stderr });
  }
  // /etc/grub.d/25_aurora_chainload, as aurora-install writes it (list path pointed at a test file).
  const src = fs.readFileSync(HELPER, 'utf8');
  const m = /write_file "\$TARGET\/etc\/grub\.d\/25_aurora_chainload" 0755 <<'EOF'\n([\s\S]*?)\nEOF\n/.exec(src);
  check('aurora-install writes /etc/grub.d/25_aurora_chainload (quoted heredoc: nothing expanded at install time)', !!m);
  if (m) {
    const list = path.join(tmp, 'boot-chainload.list');
    const marker = path.join(tmp, 'pwned');
    fs.writeFileSync(list, ['# comment', 'ABCD-1234\t/EFI/limine/BOOTX64.EFI\tCachyOS', 'ABCD-1234\t/EFI/x/a b.efi\tSpace', `ABCD-1234\t/EFI/x/y.efi\tEvil'; touch ${marker}`, `ABCD-1234\t/EFI/x/$(touch ${marker}).efi\tX`, 'ABCD-1234\t/EFI/x/z.txt\tNot EFI', "ABCD';x\t/EFI/a/b.efi\tBad UUID", 'ABCD-1234\t/EFI/arch/grubx64.efi\tArch Linux', ''].join('\n'));
    const script = path.join(tmp, '25_aurora_chainload');
    fs.writeFileSync(script, m[1].replace(/^list=\/etc\/aurora\/boot-chainload\.list$/m, `list=${list}`), { mode: 0o755 });
    const g = spawnSync('sh', [script], { encoding: 'utf8' });
    const entries = [...g.stdout.matchAll(/^menuentry '([^']*)' [^{]*\{\n([\s\S]*?)\n\}/gm)].map((x) => [x[1], x[2]]);
    check('25_aurora_chainload: two entries (CachyOS, Arch Linux), each search --fs-uuid + chainloader <exact path>', g.status === 0 && entries.length === 2 && entries[0][0] === 'CachyOS' && /\tsearch --no-floppy --fs-uuid --set=root ABCD-1234\n\tchainloader \/EFI\/limine\/BOOTX64\.EFI$/.test(entries[0][1]) && entries[1][0] === 'Arch Linux' && /chainloader \/EFI\/arch\/grubx64\.efi$/.test(entries[1][1]), { out: g.stdout, err: g.stderr });
    check('25_aurora_chainload: the 5 bad lines skipped with a message, nothing executed', (g.stderr.match(/invalid line/g) || []).length === 5 && !fs.existsSync(marker) && !/Evil|Space|Bad UUID|Not EFI/.test(g.stdout), g.stderr);
    fs.rmSync(list);
    const g2 = spawnSync('sh', [script], { encoding: 'utf8' });
    check('25_aurora_chainload: no list -> no entry, exit 0', g2.status === 0 && g2.stdout === '');
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`installer-alongside: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL ${f}`);
process.exit(failures.length ? 1 : 0);
