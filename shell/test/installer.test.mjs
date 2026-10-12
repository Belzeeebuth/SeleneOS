// Installer tests ("Install Selene OS": renderer/apps/installer, main/ipc/installer.js,
// rootfs/usr/lib/aurora/helpers/aurora-install, rootfs/usr/lib/aurora/autoinstall).
//   Part 1 (pure Node): lsblk / zone.tab parsers, option validation -> helper argv, keyboard ids against
//          xkb, EN/FR dictionaries, the helper's --dry-run JSON protocol, argument validation and
//          --fail-at errors (never a real installation), the automated-install unit and script.
//   Part 2 (Electron, EN light, live session simulated, dry run): desktop icon, live language switch,
//          keyboard search/selection, disk selection (too-small disk refused), account validation
//          (derived user/host names, reserved names, password match + strength), time zone search,
//          summary + Change links, erase confirmation, progress events -> done page, restart (simulated),
//          Enter key navigation, close guard while installing.
//   Part 3: failure (AURORA_INSTALLER_FAIL_AT) -> error page with log excerpt + retry; cancellation.
//   Part 4 (FR dark): French strings, French defaults (fr keyboard, Europe/Paris), no raw i18n keys.
//   Part 5 (FR, 1280x720, fake graphics cards from test/fixtures/gpu): the « Pilote graphique » step for an
//          NVIDIA card (RTX 4070 online + Secure Boot: recommended driver installed during the dry run; GTX 1060
//          offline: switch disabled, « Vérifier à nouveau »; Optimus laptop: hybrid note, driver failure reported
//          on the done page without failing the installation), none for AMD / Intel; the helper's --nvidia-driver
//          (validation, dry run, its ubuntu-drivers / APT status parsers) and the session's GPU mode with nvidia.
// No screenshots are written unless --shots is given (test/out/installer-*.png).
// Usage:  cd aurora-os/shell && xvfb-run -a -s "-screen 0 1600x900x24" node test/installer.test.mjs [--node-only] [--shots]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { launchShell, ROOT } from './lib.mjs';

const require = createRequire(import.meta.url);
const args = new Set(process.argv.slice(2));
const OS_ROOT = path.join(ROOT, '..');
const HELPER = path.join(OS_ROOT, 'rootfs/usr/lib/aurora/helpers/aurora-install');
const AUTO = path.join(OS_ROOT, 'rootfs/usr/lib/aurora/autoinstall/aurora-autoinstall');
const UNIT = path.join(OS_ROOT, 'rootfs/usr/lib/systemd/system/aurora-autoinstall.service');
let passed = 0;
const failures = [];
function check(name, ok, info) {
  if (ok) passed++;
  else failures.push(`${name}${info !== undefined ? `\n      got: ${typeof info === 'string' ? info : JSON.stringify(info)}` : ''}`);
  return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeout = 10000, step = 100 } = {}) {
  const t0 = Date.now();
  for (;;) {
    let v;
    try {
      v = await fn();
    } catch {
      v = null;
    }
    if (v) return v;
    if (Date.now() - t0 > timeout) return v;
    await sleep(step);
  }
}

// ================================================================ Part 1: pure Node
{
  const be = require(path.join(ROOT, 'main/ipc/installer.js'));
  const lsblk = {
    blockdevices: [
      { name: '/dev/sda', path: '/dev/sda', type: 'disk', size: 256060514304, model: 'Samsung SSD 870', tran: 'sata', rm: false, ro: false, children: [{ name: '/dev/sda1', path: '/dev/sda1', type: 'part', size: 536870912, fstype: 'vfat', label: null, mountpoints: [null] }, { name: '/dev/sda2', path: '/dev/sda2', type: 'part', size: 255520000000, fstype: 'ntfs', label: 'Windows', mountpoints: [null] }] },
      { name: '/dev/sdb', path: '/dev/sdb', type: 'disk', size: 16008609792, model: 'Flash Disk', tran: 'usb', rm: '1', ro: '0', children: [{ name: '/dev/sdb1', path: '/dev/sdb1', type: 'part', size: 800000000, fstype: 'iso9660', label: 'AURORA_OS', mountpoints: ['/cdrom'] }] },
      { name: '/dev/vda', path: '/dev/vda', type: 'disk', size: 34359738368, model: null, tran: 'virtio', rm: false, ro: false, mountpoints: [null] },
      { name: '/dev/vdb', path: '/dev/vdb', type: 'disk', size: 274877906944, model: null, tran: 'virtio', rm: false, ro: false, mountpoints: ['/'] },
      { name: '/dev/vdc', path: '/dev/vdc', type: 'disk', size: 10000000, model: null, tran: 'virtio', rm: false, ro: true, mountpoints: [null] },
      { name: '/dev/sdc', path: '/dev/sdc', type: 'disk', size: 8004304896, model: 'Cruzer', tran: 'usb', rm: true, ro: false, children: [{ name: '/dev/sdc1', path: '/dev/sdc1', type: 'part', size: 8003256320, fstype: 'exfat', label: 'USB', mountpoints: ['/media/aurora/USB'] }] },
      { name: '/dev/loop0', path: '/dev/loop0', type: 'loop', size: 700000000, mountpoints: ['/rofs'] },
      { name: '/dev/sr0', path: '/dev/sr0', type: 'rom', size: 800000000, mountpoints: [null] },
      { name: '/dev/zram0', path: '/dev/zram0', type: 'disk', size: 4000000000, mountpoints: ['[SWAP]'] },
      { name: '/dev/nvme0n1', path: '/dev/nvme0n1', type: 'disk', size: 512110190592, model: 'WD Black SN770', tran: 'nvme', rm: false, ro: false, children: [{ name: '/dev/nvme0n1p1', path: '/dev/nvme0n1p1', type: 'part', size: 512000000000, fstype: 'LVM2_member', children: [{ name: '/dev/mapper/vg-root', type: 'lvm', size: 500000000000, mountpoints: [null] }] }] },
    ],
  };
  const disks = be.parseLsblk(JSON.stringify(lsblk));
  const names = disks.map((d) => d.path);
  check('lsblk: installable disks only (no live medium, root disk, ro, loop, rom, zram, LVM member)', JSON.stringify(names) === JSON.stringify(['/dev/sda', '/dev/vda', '/dev/sdc']), names);
  const sda = disks.find((d) => d.path === '/dev/sda');
  check('lsblk: model, size, transport, partitions', sda?.model === 'Samsung SSD 870' && sda.size === 256060514304 && sda.transport === 'sata' && sda.partitions.length === 2 && sda.partitions[1].label === 'Windows' && sda.partitions[1].fstype === 'ntfs', sda);
  check('lsblk: a USB stick is removable and too small (8 GB < 12 GB)', disks.find((d) => d.path === '/dev/sdc')?.removable === true && disks.find((d) => d.path === '/dev/sdc').tooSmall === true);
  check('lsblk: 32 GiB disk is large enough, model may be empty', disks.find((d) => d.path === '/dev/vda')?.tooSmall === false && disks.find((d) => d.path === '/dev/vda').model === '');
  check('lsblk: garbage input -> []', Array.isArray(be.parseLsblk('not json')) && be.parseLsblk('not json').length === 0);
  const old = be.parseLsblk({ blockdevices: [{ name: 'sdx', type: 'disk', size: '20000000000', ro: '0', rm: '0', mountpoint: null }] });
  check('lsblk: old util-linux (mountpoint, "0"/"1" flags, no path)', old.length === 1 && old[0].path === '/dev/sdx' && old[0].removable === false, old);

  const zones = be.parseZoneTab('# comment\nFR\t+4852+00220\tEurope/Paris\nUS\t+404251-0740023\tAmerica/New_York\tEastern (most areas)\nAR\t-3436-05827\tAmerica/Argentina/Buenos_Aires\nXX\tbad\t../etc/passwd\n');
  check('zone.tab parsed, sorted, UTC added, bad names dropped', JSON.stringify(zones) === JSON.stringify(['America/Argentina/Buenos_Aires', 'America/New_York', 'Europe/Paris', 'UTC']), zones);

  const ok = { disk: '/dev/vda', user: 'jane', fullname: 'Jane Doe', password: 'p@ss word', hostname: 'jane-pc', lang: 'fr', keyboard: 'fr(oss)', timezone: 'Europe/Paris', autologin: true };
  const argv = be.buildArgs(ok);
  check('buildArgs: helper argv', argv.join(' ') === '--json --password-stdin --disk /dev/vda --user jane --fullname Jane Doe --hostname jane-pc --lang fr --keyboard fr(oss) --timezone Europe/Paris --autologin', argv.join(' '));
  check('buildArgs: the password is never in argv', !argv.some((a) => a.includes('p@ss')));
  const dry = be.buildArgs(ok, { dryRun: true, delay: '0.05', failAt: 'copy' });
  check('buildArgs: dry run, delay, fail-at', dry.slice(-5).join(' ') === '--dry-run --dry-run-delay 0.05 --fail-at copy', dry.slice(-5));
  check('buildArgs: bad delay / fail-at ignored', !be.buildArgs(ok, { dryRun: true, delay: '1; rm', failAt: 'nope' }).some((a) => a === '1; rm' || a === 'nope'));
  const rejects = (o, field) => {
    try {
      be.buildArgs({ ...ok, ...o });
      return false;
    } catch (e) {
      return e.code === 'EINVAL' && e.field === field;
    }
  };
  check('buildArgs rejects: user "Root"', rejects({ user: 'Root' }, 'user'));
  check('buildArgs rejects: reserved user "root" and "_greetd"', rejects({ user: 'root' }, 'user') && rejects({ user: '_greetd' }, 'user'));
  check('buildArgs rejects: disk path injection', rejects({ disk: '/dev/../etc/passwd' }, 'disk') && rejects({ disk: 'vda' }, 'disk') && rejects({ disk: '/dev/vda;reboot' }, 'disk'));
  check('buildArgs rejects: hostname', rejects({ hostname: '-pc' }, 'hostname') && rejects({ hostname: 'my pc' }, 'hostname'));
  check('buildArgs rejects: full name with : or newline', rejects({ fullname: 'a:b' }, 'fullname') && rejects({ fullname: 'a\nb' }, 'fullname'));
  check('buildArgs rejects: password empty / newline', rejects({ password: '' }, 'password') && rejects({ password: 'a\nb' }, 'password'));
  check('buildArgs rejects: keyboard / timezone / lang', rejects({ keyboard: 'fr oss' }, 'keyboard') && rejects({ timezone: 'Europe/../x' }, 'timezone') && rejects({ lang: 'de' }, 'lang'));
  check('buildArgs: default hostname <user>-pc', be.buildArgs({ ...ok, hostname: '' }).includes('jane-pc'));
  check('buildArgs: --nvidia-driver PACKAGE / recommended', be.buildArgs({ ...ok, nvidiaDriver: 'nvidia-driver-550-open' }).join(' ').endsWith('--autologin --nvidia-driver nvidia-driver-550-open') && be.buildArgs({ ...ok, nvidiaDriver: 'recommended' }).includes('recommended'));
  check('buildArgs: no driver -> no --nvidia-driver', !be.buildArgs({ ...ok, nvidiaDriver: '' }).includes('--nvidia-driver') && !be.buildArgs({ ...ok, nvidiaDriver: false }).includes('--nvidia-driver') && !be.buildArgs(ok).includes('--nvidia-driver'));
  check('buildArgs rejects: driver package injection', rejects({ nvidiaDriver: 'nvidia-driver-550;reboot' }, 'nvidiaDriver') && rejects({ nvidiaDriver: 'nvidia-dkms-550' }, 'nvidiaDriver') && rejects({ nvidiaDriver: '--purge' }, 'nvidiaDriver'));
  check('backend stages include drivers (between configure and bootloader)', be.STAGES.join(' ') === 'partition format copy configure drivers bootloader cleanup done', be.STAGES);

  const xkb = '/usr/share/X11/xkb/symbols';
  if (fs.existsSync(xkb)) {
    const missing = be.KEYBOARDS.filter((k) => !fs.existsSync(path.join(xkb, k.layout)) || (k.variant && !fs.readFileSync(path.join(xkb, k.layout), 'utf8').includes(`xkb_symbols "${k.variant}"`)));
    check('every keyboard layout/variant exists in xkb-data', missing.length === 0, missing.map((k) => k.id));
  }
  check('keyboards have EN and FR names', be.KEYBOARDS.length >= 15 && be.KEYBOARDS.every((k) => k.name.en && k.name.fr), be.KEYBOARDS.length);
  for (const id of ['us', 'gb', 'fr', 'fr(oss)', 'be', 'ch(fr)', 'ca(fr)', 'de', 'es', 'it']) check(`keyboard ${id} offered`, be.KEYBOARDS.some((k) => k.id === id));

  const dict = JSON.parse(fs.readFileSync(path.join(ROOT, 'renderer/apps/installer/i18n.json'), 'utf8'));
  const keys = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? keys(v, `${p}${k}.`) : [`${p}${k}`]));
  const en = keys(dict.en).sort();
  const fr = keys(dict.fr).sort();
  check('i18n: EN and FR have the same keys', JSON.stringify(en) === JSON.stringify(fr), { onlyEn: en.filter((k) => !fr.includes(k)), onlyFr: fr.filter((k) => !en.includes(k)) });
  check('i18n: no empty strings', [...keys(dict.en).map((k) => k.split('.').reduce((o, x) => o[x], dict.en)), ...keys(dict.fr).map((k) => k.split('.').reduce((o, x) => o[x], dict.fr))].every((v) => typeof v === 'string' && v.trim()));
  const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'renderer/apps/installer/manifest.json'), 'utf8'));
  check('manifest: liveOnly, names, entry', man.liveOnly === true && man.name.en === 'Install Selene OS' && man.name.fr === 'Installer Selene OS' && man.id === 'installer' && man.entry === 'main.js', man);

  // ---- the root helper: syntax, dry-run protocol, validation (never a real installation here)
  check('helper: bash -n', spawnSync('bash', ['-n', HELPER]).status === 0);
  const runHelper = (argvH, input = 'S3cret pass\n') => {
    const r = spawnSync('bash', [HELPER, ...argvH], { input, encoding: 'utf8', timeout: 60000 });
    const events = r.stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return { bad: l };
        }
      });
    return { status: r.status, events, stderr: r.stderr };
  };
  const base = ['--json', '--password-stdin', '--disk', '/dev/aurora-test-nonexistent', '--user', 'jane', '--fullname', 'Jane Doe', '--hostname', 'jane-pc', '--lang', 'fr', '--keyboard', 'fr(oss)', '--timezone', 'Europe/Paris'];
  const d = runHelper([...base, '--dry-run', '--dry-run-delay', '0']);
  const prog = d.events.filter((e) => typeof e.progress === 'number');
  const stages = [...new Set(d.events.map((e) => e.stage).filter(Boolean))];
  check('helper dry run: exit 0, every line is JSON', d.status === 0 && d.events.every((e) => !e.bad), { status: d.status, bad: d.events.filter((e) => e.bad), err: d.stderr.slice(-300) });
  check('helper dry run: stages in order', JSON.stringify(stages) === JSON.stringify(['partition', 'format', 'copy', 'configure', 'bootloader', 'cleanup', 'done']), stages);
  check('helper dry run: progress 0..100, never decreasing, ends at 100', prog.length > 15 && prog.every((e, i) => e.progress >= 0 && e.progress <= 100 && (i === 0 || e.progress >= prog[i - 1].progress)) && prog.at(-1).progress === 100, prog.map((e) => e.progress));
  check('helper dry run: human log on stderr, no password', /DRY RUN/.test(d.stderr) && !d.stderr.includes('S3cret'), d.stderr.slice(0, 200));
  const f = runHelper([...base, '--dry-run', '--dry-run-delay', '0', '--fail-at', 'configure']);
  const fe = f.events.at(-1);
  check('helper --fail-at configure: exit 5 + {"error"} with the stage', f.status === 5 && fe?.error?.includes('configure') && fe.stage === 'configure' && fe.code === 5, { status: f.status, fe });
  const bad = (extra, input) => runHelper([...base.filter((x, i) => !extra.drop?.includes(base[i]) && !extra.drop?.includes(base[i - 1])), ...(extra.add || []), '--dry-run', '--dry-run-delay', '0'], input);
  for (const [name, extra, input] of [
    ['invalid user name', { drop: ['--user'], add: ['--user', 'Jane'] }],
    ['reserved user name', { drop: ['--user'], add: ['--user', 'root'] }],
    ['invalid keyboard', { drop: ['--keyboard'], add: ['--keyboard', 'fr oss'] }],
    ['invalid time zone', { drop: ['--timezone'], add: ['--timezone', '../../etc/passwd'] }],
    ['invalid computer name', { drop: ['--hostname'], add: ['--hostname', 'my_pc'] }],
    ['full name with a colon', { drop: ['--fullname'], add: ['--fullname', 'a:b'] }],
    ['missing password', {}, ''],
    ['relative source path', { add: ['--source', 'rel/path'] }],
    ['unknown option', { add: ['--yes-really'] }],
  ]) {
    const r = bad(extra, input);
    check(`helper refuses ${name} (exit 2 + {"error"})`, r.status === 2 && r.events.length >= 1 && typeof r.events.at(-1).error === 'string', { status: r.status, ev: r.events.at(-1) });
  }
  if (process.getuid?.() === 0) {
    const r = spawnSync('su', ['nobody', '-s', '/bin/bash', '-c', `printf 'x\\n' | bash ${HELPER} ${base.join(' ').replace('fr(oss)', "'fr(oss)'").replace('Jane Doe', "'Jane Doe'")}`], { encoding: 'utf8', timeout: 30000 });
    check('helper (real mode) refuses to run without root (exit 4)', r.status === 4 && /must be run as root/.test(r.stdout + r.stderr), { status: r.status, out: (r.stdout + r.stderr).slice(-200) });
  }

  // ---- graphics driver (--nvidia-driver): dry runs, validation, the real stage's parsers
  {
    const dd = runHelper([...base, '--nvidia-driver', 'recommended', '--dry-run', '--dry-run-delay', '0']);
    const dst = [...new Set(dd.events.map((e) => e.stage).filter(Boolean))];
    const dpr = dd.events.filter((e) => typeof e.progress === 'number');
    check('helper dry run + driver: drivers stage between configure and bootloader', dd.status === 0 && dst.join(' ') === 'partition format copy configure drivers bootloader cleanup done', { status: dd.status, dst });
    check('helper dry run + driver: progress monotonic, drivers 76..88', dpr.every((e, i) => i === 0 || e.progress >= dpr[i - 1].progress) && dpr.filter((e) => e.stage === 'drivers').every((e) => e.progress >= 76 && e.progress <= 88) && dpr.at(-1).progress === 100, dpr.map((e) => `${e.stage}:${e.progress}`).join(' '));
    check('helper dry run + driver: {"driver":"installed"} with the package', dd.events.some((e) => e.driver === 'installed' && e.package === 'nvidia-driver-550'), dd.events.filter((e) => e.driver));
    const df = runHelper([...base, '--nvidia-driver', 'nvidia-driver-470', '--dry-run', '--dry-run-delay', '0', '--fail-at', 'drivers']);
    check('helper --fail-at drivers: the driver fails, the installation does not (exit 0, done)', df.status === 0 && df.events.some((e) => e.driver === 'failed' && e.package === 'nvidia-driver-470' && /package lists/.test(e.message)) && df.events.some((e) => e.stage === 'done') && !df.events.some((e) => e.error), df.events.filter((e) => e.driver || e.error));
    const dn = runHelper([...base, '--dry-run', '--dry-run-delay', '0']);
    check('helper without --nvidia-driver: no drivers stage', !dn.events.some((e) => e.stage === 'drivers' || e.driver));
    for (const bad of ['nvidia-driver-550;reboot', 'nvidia-dkms-550', 'nvidia-driver-55', '$(reboot)']) {
      const r = runHelper([...base, '--nvidia-driver', bad, '--dry-run', '--dry-run-delay', '0']);
      check(`helper refuses --nvidia-driver ${bad} (exit 2)`, r.status === 2 && /invalid --nvidia-driver/.test(r.events.at(-1)?.error || ''), { status: r.status, ev: r.events.at(-1) });
    }
    // The real stage's parsers, extracted from the helper and run on fixtures.
    const fn = (name) => {
      const m = new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}$`, 'm').exec(helperSrc);
      return m ? m[0] : '';
    };
    const helperSrc = fs.readFileSync(HELPER, 'utf8');
    const ud = fs.readFileSync(path.join(ROOT, 'test/fixtures/gpu/optimus/ubuntu-drivers.txt'), 'utf8');
    const off = spawnSync('bash', ['-c', `${fn('nvidia_offered')}\nnvidia_offered`], { input: ud, encoding: 'utf8' });
    check('helper nvidia_offered: NVIDIA drivers + the recommended mark, not the Wi-Fi driver', off.stdout.split('\n').filter(Boolean).length === 6 && /^nvidia-driver-550-open recommended$/m.test(off.stdout) && !/iwlwifi|nouveau/.test(off.stdout), off.stdout);
    const off2 = spawnSync('bash', ['-c', `${fn('nvidia_offered')}\nnvidia_offered`], { input: 'driver   : nvidia-driver-550;reboot - distro non-free recommended\n', encoding: 'utf8' });
    check('helper nvidia_offered: an invalid name is not offered', off2.stdout.trim() === '', off2.stdout);
    const apt = 'Reading package lists...\ndlstatus:1:0.0000:Retrieving file 1 of 40\ndlstatus:20:51.2340:Retrieving file 20 of 40\ndlstatus:40:100.0000:Retrieving file 40 of 40\npmstatus:dpkg-exec:0.0000:Running dpkg\nSetting up nvidia-driver-550 (550.120-0ubuntu0.24.04.1) ...\npmstatus:nvidia-driver-550:99.9:Installed nvidia-driver-550\n';
    const dp = spawnSync('bash', ['-c', `JSON=1; PROGRESS=76; STAGE=drivers; NVIDIA_DRIVER=x; exec 3>&1; ${fn('json_str')}\n${fn('log')}\n${fn('progress')}\n${fn('driver_progress')}\ndriver_progress`], { input: apt, encoding: 'utf8' });
    const dpe = dp.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    check('helper driver_progress: APT status -> drivers 80..88, other lines to the log', dpe.length >= 5 && dpe.every((e) => e.stage === 'drivers' && e.progress >= 80 && e.progress <= 88) && dpe.some((e) => e.message === 'Downloading the NVIDIA driver') && dpe.some((e) => e.message === 'Installing the NVIDIA driver') && dpe.at(-1).progress === 87 && /Setting up nvidia-driver-550/.test(dp.stderr), { out: dpe, err: dp.stderr });
    check('helper: the target gets nvidia-drm modeset=1 when the driver package does not set it', /options nvidia-drm modeset=1/.test(helperSrc) && /nvidia-graphics-drivers-kms\.conf/.test(helperSrc));
  }

  // ---- session: GPU mode with the NVIDIA driver (aurora-common on fake /sys and /proc trees)
  {
    const COMMON = path.join(OS_ROOT, 'rootfs/usr/lib/aurora/aurora-common');
    const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'aurora-gpu-'));
    const tree = (name, { drm = [], nvidia = false, cmdline = 'quiet splash' } = {}) => {
      const sys = path.join(tmp, name, 'sys');
      const proc = path.join(tmp, name, 'proc');
      fs.mkdirSync(path.join(sys, 'class/drm'), { recursive: true });
      fs.mkdirSync(proc, { recursive: true });
      fs.writeFileSync(path.join(proc, 'cmdline'), `${cmdline}\n`);
      drm.forEach(([drv, features], i) => {
        const dev = path.join(sys, 'devices', `card${i}`);
        fs.mkdirSync(path.join(sys, 'bus/pci/drivers', drv), { recursive: true });
        fs.mkdirSync(dev, { recursive: true });
        fs.symlinkSync(path.join(sys, 'bus/pci/drivers', drv), path.join(dev, 'driver'));
        if (features) fs.writeFileSync(path.join(dev, 'features'), features);
        fs.mkdirSync(path.join(sys, 'class/drm', `card${i}`), { recursive: true });
        fs.symlinkSync(dev, path.join(sys, 'class/drm', `card${i}`, 'device'));
      });
      if (nvidia) {
        fs.mkdirSync(path.join(sys, 'module/nvidia'), { recursive: true });
        fs.mkdirSync(path.join(proc, 'driver/nvidia'), { recursive: true });
        fs.writeFileSync(path.join(proc, 'driver/nvidia/version'), 'NVRM version: NVIDIA UNIX x86_64 Kernel Module  550.120  Fri Sep 13 10:10:01 UTC 2024\n');
      }
      return { sys, proc };
    };
    const mode = (t, env = {}) => spawnSync('sh', ['-c', `. "${COMMON}"; aurora_gpu_mode; aurora_nvidia_loaded && echo nvidia || echo no-nvidia`], { encoding: 'utf8', env: { PATH: process.env.PATH, AURORA_SYSFS: t.sys, AURORA_PROCFS: t.proc, ...env } }).stdout.trim().split('\n');
    const nv = tree('nvidia', { drm: [['simple-framebuffer'], ['nvidia']], nvidia: true });
    check('GPU mode: nvidia driver loaded -> on', mode(nv).join(' ') === 'on nvidia', mode(nv));
    const nvEarly = tree('nvidia-early', { drm: [['simple-framebuffer']], nvidia: true });
    check('GPU mode: nvidia module loaded before its DRM device (only simpledrm) -> on', mode(nvEarly).join(' ') === 'on nvidia', mode(nvEarly));
    check('GPU mode: AURORA_GPU=off still wins with nvidia', mode(nv, { AURORA_GPU: 'off' })[0] === 'off');
    check('GPU mode: nomodeset (safe graphics) still off with nvidia', mode(tree('nvidia-nomodeset', { drm: [['nvidia']], nvidia: true, cmdline: 'quiet nomodeset' }))[0] === 'off');
    const fb = tree('simpledrm', { drm: [['simple-framebuffer']] });
    check('GPU mode: simpledrm only -> off (unchanged)', mode(fb).join(' ') === 'off no-nvidia', mode(fb));
    check('GPU mode: QEMU virtio-gpu without virgl -> off, with virgl -> on (unchanged)', mode(tree('virtio', { drm: [['virtio-pci', '0000000000000000000000000000000000000000000000000000000000000000']] }))[0] === 'off' && mode(tree('virgl', { drm: [['virtio-pci', '1000000000000000000000000000000000000000000000000000000000000000']] }))[0] === 'on');
    check('GPU mode: nouveau / i915 / amdgpu -> on (unchanged)', ['nouveau', 'i915', 'amdgpu'].every((d) => mode(tree(`drv-${d}`, { drm: [[d]] }))[0] === 'on'));
    const xstart = fs.readFileSync(path.join(OS_ROOT, 'rootfs/usr/lib/aurora/aurora-xstart'), 'utf8');
    check('aurora-xstart: noaccel.conf (forces modesetting) never with the nvidia driver loaded', /if aurora_wait_nvidia; then[\s\S]*?elif \[ "\$\(aurora_gpu_mode\)" = off \]; then\s*config="-config \/usr\/share\/aurora\/xorg\/noaccel\.conf"/.test(xstart));
    const xconfs = fs.readdirSync(path.join(OS_ROOT, 'rootfs/etc/X11/xorg.conf.d')).map((f) => fs.readFileSync(path.join(OS_ROOT, 'rootfs/etc/X11/xorg.conf.d', f), 'utf8')).join('\n');
    check('xorg.conf.d: no Selene Device section forcing a driver (modesetting / noaccel)', !/Driver\s+"|AccelMethod/.test(xconfs));
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ---- automated install (live media only)
  check('autoinstall script: bash -n', fs.existsSync(AUTO) && spawnSync('bash', ['-n', AUTO]).status === 0);
  const unit = fs.existsSync(UNIT) ? fs.readFileSync(UNIT, 'utf8') : '';
  check('autoinstall unit: gated on aurora.autoinstall=1 AND boot=casper AND /cdrom/casper', /^ConditionKernelCommandLine=aurora\.autoinstall=1$/m.test(unit) && /^ConditionKernelCommandLine=boot=casper$/m.test(unit) && /^ConditionPathIsDirectory=\/cdrom\/casper$/m.test(unit), unit);
  check('autoinstall unit: runs before the sign-in screen, no start timeout', /^Before=.*greetd\.service/m.test(unit) && /^TimeoutStartSec=infinity$/m.test(unit));
  const autoTxt = fs.existsSync(AUTO) ? fs.readFileSync(AUTO, 'utf8') : '';
  check('autoinstall script: re-checks the live medium itself', /boot=casper/.test(autoTxt) && /\/cdrom\/casper/.test(autoTxt));
  const helperTxt = fs.readFileSync(HELPER, 'utf8');
  check('loop guard: the helper writes AURORA_INSTALL_COMPLETE last, the autoinstall checks it', /AURORA_INSTALL_COMPLETE=/.test(helperTxt) && /debugfs -R 'cat \/etc\/aurora\/install-info'/.test(autoTxt) && /\^AURORA_INSTALL_COMPLETE=/.test(autoTxt));
  check('installer removes the autoinstall unit from the installed system', /\*\.wants\/aurora-autoinstall\.service/.test(helperTxt));
}

if (args.has('--node-only')) {
  finish();
} else {
  await uiTests();
  finish();
}

function finish() {
  console.log(`\ninstaller tests: ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log(`  FAIL ${f}`);
  process.exit(failures.length ? 1 : 0);
}

// ================================================================ Part 2..4: Electron
async function uiTests() {
  const shots = args.has('--shots');
  const ins = (page) => page.locator('.app-installer').last();
  const stepIs = (page, step) => waitFor(() => page.evaluate((s) => document.querySelector('.app-installer .ins')?.dataset.step === s, step), { timeout: 5000 });
  const phaseIs = (page, phase, timeout = 30000) => waitFor(() => page.evaluate((p) => document.querySelector('.app-installer .ins')?.dataset.phase === p, phase), { timeout });
  const text = (page, sel) => page.evaluate((s) => document.querySelector(`.app-installer ${s}`)?.textContent ?? null, sel);
  const nextDisabled = (page) => page.evaluate(() => document.querySelector('.app-installer [data-act="next"]')?.disabled);
  const clickNext = (page) => page.click('.app-installer [data-act="next"]');
  const state = (page) => page.evaluate(() => window.__installer.state);

  // ---------------------------------------------------------------- Part 2: EN light, full happy path
  {
    // 0.15 s per dry-run step: the install must still be running when the test closes the window (on a loaded
    // machine a 0.02 s dry run used to finish first, so no "Cancel the installation?" prompt appeared).
    const s = await launchShell({ open: ['installer'], live: true, lang: 'en', theme: 'light', env: { AURORA_INSTALLER_DRYRUN_DELAY: '0.15' } });
    const { page } = s;
    // Failed loads of the installer's own files (other apps' resources are not this test's business).
    const badLoads = [];
    page.on('response', (r) => {
      if (r.status() >= 400 && r.url().includes('/apps/installer/')) badLoads.push(`${r.status()} ${r.url()}`);
    });
    await page.waitForSelector('.app-installer .ins[data-step="welcome"]', { timeout: 20000 });
    const icon404 = await page.evaluate(() => fetch('app://shell/apps/installer/icon.svg').then((r) => r.status));
    check('installer icon, styles and strings load', icon404 === 200 && (await page.evaluate(() => [...document.styleSheets].some((ss) => (ss.href || '').includes('/apps/installer/style.css')))));
    check('installer registered (liveOnly app visible in the live session)', await s.aurora(() => !!window.__aurora.registry.get('installer')));
    check('desktop shows the "Install Selene OS" icon in the live session', await waitFor(() => page.evaluate(() => !!document.querySelector('.desk-icon[data-id="special:installer"]'))));
    check('window title EN', (await page.locator('.app-installer .win-title').textContent()) === 'Install Selene OS');
    check('welcome title EN', (await text(page, '.ins-title')) === 'Welcome to Selene OS');
    check('dry-run badge shown in dev mode', !!(await text(page, '.ins-badge'))?.includes('Simulation'));
    check('welcome: Back hidden, Next enabled', (await page.locator('.app-installer [data-act="back"]').count()) === 0 && (await nextDisabled(page)) === false);
    check('footer has no stray text', (await page.evaluate(() => document.querySelector('.app-installer .ins-foot-right').textContent)) === 'Next');

    // language switches the installer live
    await page.click('.app-installer .ins-option[data-lang="fr"]');
    check('FR: title switches live', (await text(page, '.ins-title')) === 'Bienvenue dans Selene OS', await text(page, '.ins-title'));
    check('FR: window title + Next label', (await page.locator('.app-installer .win-title').textContent()) === 'Installer Selene OS' && (await text(page, '[data-act="next"]')) === 'Suivant');
    check('FR: stepper translated', (await text(page, '.ins-step:nth-child(5) .ins-step-label')) === 'Fuseau horaire');
    check('FR: defaults follow the language (fr keyboard, Europe/Paris)', (await state(page)).keyboard === 'fr' && (await state(page)).timezone === 'Europe/Paris');
    check('FR option is checked', (await page.getAttribute('.app-installer .ins-option[data-lang="fr"]', 'aria-checked')) === 'true');
    await page.click('.app-installer .ins-option[data-lang="en"]');
    check('EN again', (await text(page, '.ins-title')) === 'Welcome to Selene OS' && (await state(page)).keyboard === 'us' && (await state(page)).timezone === 'America/New_York');

    // Enter = Next
    await page.focus('.app-installer .ins-option[data-lang="en"]');
    await page.keyboard.press('Tab');
    await page.evaluate(() => document.querySelector('.app-installer .ins-content').focus?.());
    await page.evaluate(() => document.querySelector('.app-installer .ins').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    check('Enter goes to the keyboard step', await stepIs(page, 'keyboard'));
    check('keyboard: kicker "Step 2 of 6"', (await text(page, '.ins-kicker')) === 'Step 2 of 6');
    check('keyboard: us preselected', (await page.getAttribute('.app-installer .ins-row[data-id="us"]', 'aria-selected')) === 'true');
    await page.fill('.app-installer .ins-search', 'french');
    const kbRows = await page.evaluate(() => [...document.querySelectorAll('.app-installer .ins-list .ins-row')].map((r) => r.dataset.id));
    check('keyboard search "french" filters', kbRows.length >= 4 && kbRows.every((id) => /^(fr|ch\(fr\)|ca\(fr\))/.test(id)), kbRows);
    await page.click('.app-installer .ins-row[data-id="fr(oss)"]');
    check('keyboard: fr(oss) selected', (await state(page)).keyboard === 'fr(oss)' && (await page.getAttribute('.app-installer .ins-row[data-id="fr(oss)"]', 'aria-selected')) === 'true');
    await page.fill('.app-installer .ins-search', 'zzzz');
    check('keyboard: empty search result message', (await text(page, '.ins-empty'))?.includes('zzzz'));
    await page.fill('.app-installer .ins-search', '');
    await page.fill('.app-installer .ins-test input', 'Hello àé');
    check('keyboard: test field accepts text', (await page.inputValue('.app-installer .ins-test input')) === 'Hello àé');
    await page.press('.app-installer .ins-test input', 'Enter');
    check('Enter in the test field does not leave the page', await stepIs(page, 'keyboard'));
    await page.focus('.app-installer .ins-list');
    await page.keyboard.press('ArrowDown');
    check('keyboard: arrow keys move the selection', (await state(page)).keyboard !== 'fr(oss)');
    await page.click('.app-installer .ins-row[data-id="fr(oss)"]');
    await clickNext(page);

    // disk
    check('disk step', await stepIs(page, 'disk'));
    await page.waitForSelector('.app-installer .ins-disks .ins-row');
    check('disk: Next disabled until a disk is chosen', (await nextDisabled(page)) === true);
    check('disk: erase warning shown', (await text(page, '.ins-warning'))?.includes('will be erased'));
    check('disk: too-small USB stick is disabled with a reason', (await page.getAttribute('.app-installer .ins-row[data-id="/dev/sdb"]', 'aria-disabled')) === 'true' && (await text(page, '.ins-row[data-id="/dev/sdb"]'))?.includes('Too small'));
    await page.click('.app-installer .ins-row[data-id="/dev/sdb"]', { force: true });
    check('disk: clicking a too-small disk does nothing', (await state(page)).disk === null);
    check('disk: Windows partitions listed', (await text(page, '.ins-row[data-id="/dev/nvme0n1"]'))?.includes('Windows'));
    await page.click('.app-installer .ins-row[data-id="/dev/vda"]');
    check('disk: /dev/vda selected, Next enabled', (await state(page)).disk === '/dev/vda' && (await nextDisabled(page)) === false);
    check('disk: size shown in decimal GB', (await text(page, '.ins-row[data-id="/dev/vda"] .ins-row-size')) === '34 GB');
    await page.click('.app-installer [data-act="refresh"]');
    await page.waitForSelector('.app-installer .ins-disks .ins-row');
    check('disk: selection survives Refresh', (await state(page)).disk === '/dev/vda');
    await clickNext(page);

    // account
    check('account step', await stepIs(page, 'account'));
    check('account: Next disabled while empty', (await nextDisabled(page)) === true);
    await page.fill('.app-installer input[name="fullname"]', 'Élodie Dupont');
    check('account: user name derived (accents removed)', (await page.inputValue('.app-installer input[name="user"]')) === 'elodie');
    check('account: computer name derived', (await page.inputValue('.app-installer input[name="hostname"]')) === 'elodie-pc');
    await page.fill('.app-installer input[name="user"]', 'Root!');
    check('account: invalid user name message', (await text(page, '[data-field="user"] .ins-err'))?.includes('lowercase'));
    await page.fill('.app-installer input[name="user"]', 'root');
    check('account: reserved user name message', (await text(page, '[data-field="user"] .ins-err'))?.includes('reserved'));
    await page.fill('.app-installer input[name="user"]', 'jane');
    await page.fill('.app-installer input[name="fullname"]', 'Jane Doe');
    check('account: a typed user name is no longer derived', (await page.inputValue('.app-installer input[name="user"]')) === 'jane');
    await page.fill('.app-installer input[name="password"]', 'abc');
    check('account: strength weak', (await page.getAttribute('.app-installer .ins-meter', 'data-level')) === 'weak');
    await page.fill('.app-installer input[name="password"]', 'Abcdefgh1');
    check('account: strength fair', (await page.getAttribute('.app-installer .ins-meter', 'data-level')) === 'fair');
    await page.fill('.app-installer input[name="password"]', 'S3cret pass:word!');
    check('account: strength strong', (await page.getAttribute('.app-installer .ins-meter', 'data-level')) === 'strong');
    await page.fill('.app-installer input[name="confirm"]', 'S3cret pass:wordX');
    check('account: password mismatch message + Next disabled', (await text(page, '[data-field="confirm"] .ins-err'))?.includes("don't match") && (await nextDisabled(page)) === true);
    await page.fill('.app-installer input[name="confirm"]', 'S3cret pass:word!');
    await page.fill('.app-installer input[name="hostname"]', 'bad host');
    check('account: invalid computer name', (await text(page, '[data-field="hostname"] .ins-err'))?.includes('hyphens') && (await nextDisabled(page)) === true);
    await page.fill('.app-installer input[name="hostname"]', 'jane-laptop');
    await page.click('.app-installer [data-field="password"] .ins-eye');
    check('account: show password toggles both fields', (await page.getAttribute('.app-installer input[name="password"]', 'type')) === 'text' && (await page.getAttribute('.app-installer input[name="confirm"]', 'type')) === 'text');
    await page.click('.app-installer .ins-autologin');
    check('account: autologin on, valid, Next enabled', (await state(page)).autologin === true && (await nextDisabled(page)) === false);
    check('account: no visible errors when valid', (await page.evaluate(() => [...document.querySelectorAll('.app-installer .ins-err')].map((e) => e.textContent).join(''))) === '');
    if (shots) await ins(page).screenshot({ path: path.join(ROOT, 'test/out/installer-account-en.png') });
    await clickNext(page);

    // time zone
    check('time zone step', await stepIs(page, 'timezone'));
    check('time zone: America/New_York preselected (EN)', (await page.getAttribute('.app-installer .ins-row[data-id="America/New_York"]', 'aria-selected')) === 'true');
    check('time zone: rows show a UTC offset', /^UTC[+−]\d\d:\d\d$/.test((await text(page, '.ins-row[data-id="Europe/Paris"] .ins-row-offset')) || ''), await text(page, '.ins-row[data-id="Europe/Paris"] .ins-row-offset'));
    await page.fill('.app-installer .ins-search', 'paris');
    const tzRows = await page.evaluate(() => [...document.querySelectorAll('.app-installer .ins-list .ins-row')].map((r) => r.dataset.id));
    check('time zone search "paris"', tzRows.includes('Europe/Paris') && tzRows.length <= 3, tzRows);
    await page.click('.app-installer .ins-row[data-id="Europe/Paris"]');
    check('time zone: Europe/Paris selected', (await state(page)).timezone === 'Europe/Paris');
    await page.fill('.app-installer .ins-search', 'zzzz');
    check('time zone: no-match message', (await text(page, '.ins-empty'))?.includes('zzzz'));
    await page.fill('.app-installer .ins-search', 'europe');
    check('time zone: search by region', (await page.locator('.app-installer .ins-list .ins-row').count()) > 20);
    await clickNext(page);

    // summary
    check('summary step', await stepIs(page, 'summary'));
    check('summary: Install button', (await text(page, '[data-act="next"]')) === 'Install');
    const sum = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.app-installer .ins-sum-row')].map((r) => [r.dataset.row, r.textContent])));
    check('summary: language', sum.language?.includes('English (United States)'), sum.language);
    check('summary: keyboard', sum.keyboard?.includes('French (alternative)') && sum.keyboard.includes('fr(oss)'), sum.keyboard);
    check('summary: disk erase warning', sum.disk?.includes('/dev/vda') && sum.disk.includes('completely erased') && sum.disk.includes('QEMU HARDDISK'), sum.disk);
    check('summary: account', sum.account?.includes('Jane Doe') && sum.account.includes('jane'), sum.account);
    check('summary: sign-in automatic', sum.signin?.includes('automatically'), sum.signin);
    check('summary: computer name', sum.hostname?.includes('jane-laptop'), sum.hostname);
    check('summary: time zone', sum.timezone?.includes('Paris'), sum.timezone);
    await page.click('.app-installer .ins-sum-row[data-row="hostname"] .btn');
    check('summary: Change goes back to the account step', await stepIs(page, 'account'));
    check('account: values kept', (await page.inputValue('.app-installer input[name="hostname"]')) === 'jane-laptop' && (await page.inputValue('.app-installer input[name="password"]')) === 'S3cret pass:word!');
    await page.click('.app-installer .ins-step:nth-child(2) .ins-step-btn');
    check('stepper: a done step is clickable', await stepIs(page, 'keyboard'));
    for (let i = 0; i < 4; i++) await clickNext(page);
    check('back on the summary', await stepIs(page, 'summary'));

    // erase confirmation
    await clickNext(page);
    await page.waitForSelector('.dialog');
    check('confirmation dialog names the disk', (await page.textContent('.dialog'))?.includes('/dev/vda') && (await page.textContent('.dialog')).includes('permanently erased'));
    await page.click('.dialog .btn:not(.danger)');
    await sleep(250);
    check('Cancel keeps the summary', (await state(page)).phase === 'setup' && (await stepIs(page, 'summary')));

    // install (dry run): record the progress events
    await page.evaluate(() => {
      window.__insEvents = [];
      window.aurora.on('installer:progress', (e) => window.__insEvents.push(e));
    });
    await clickNext(page);
    await page.waitForSelector('.dialog');
    await page.click('.dialog .btn.danger');
    check('installing phase', await phaseIs(page, 'installing', 5000));
    check('installing: Cancel button only', (await page.locator('.app-installer [data-act="cancel"]').count()) === 1 && (await page.locator('.app-installer [data-act="next"]').count()) === 0);
    check('installing: six stages listed', (await page.locator('.app-installer .ins-stage').count()) === 6);
    await page.click('.app-installer [data-act="details"]');
    check('installing: details toggle shows the live log', await waitFor(() => page.evaluate(() => !document.querySelector('.app-installer .ins-log').hidden && document.querySelector('.app-installer .ins-log').textContent.includes('DRY RUN'))));
    // closing while installing asks first
    await page.click('.app-installer .win-close');
    await page.waitForSelector('.dialog');
    check('close while installing asks to cancel', (await page.textContent('.dialog'))?.includes('Cancel the installation?'));
    await page.click('.dialog .btn:not(.danger)');
    check('choosing "Continue installing" keeps the window', (await page.locator('.app-installer').count()) === 1);
    check('done phase reached', await phaseIs(page, 'done', 60000));
    const evs = await page.evaluate(() => window.__insEvents);
    const pr = evs.filter((e) => e.type === 'progress');
    check('progress events: monotonic, all stages, 100%', pr.length > 15 && pr.every((e, i) => i === 0 || e.progress >= pr[i - 1].progress) && pr.at(-1).progress === 100 && ['partition', 'format', 'copy', 'configure', 'bootloader', 'cleanup'].every((st) => pr.some((e) => e.stage === st)), pr.map((e) => `${e.stage}:${e.progress}`).join(' '));
    check('events: log lines, done, exit 0', evs.some((e) => e.type === 'log') && evs.some((e) => e.type === 'done') && evs.some((e) => e.type === 'exit' && e.code === 0));
    check('events: the password never appears', !JSON.stringify(evs).includes('S3cret'));
    const st = await state(page);
    check('done: ring at 100%', (await text(page, '.ins-ring-pct')) === null && st.progress === 100);
    check('done page: title + remove-media reminder', (await text(page, '.ins-title')) === 'Selene OS is installed' && (await page.textContent('.app-installer .ins-content'))?.includes('Remove the installation media'));
    check('done page: account reminder', (await text(page, '.ins-done-account'))?.includes('Jane Doe (jane)'));
    check('done page: stepper all done', (await page.locator('.app-installer .ins-step.done').count()) === 7);
    await page.click('.app-installer [data-act="restart"]');
    check('restart is simulated in dev mode', await waitFor(() => page.evaluate(() => document.querySelector('.app-installer .ins-done-msg')?.textContent.includes('simulation'))));
    if (shots) await ins(page).screenshot({ path: path.join(ROOT, 'test/out/installer-done-en.png') });
    const logTxt = await page.evaluate(() => window.aurora.invoke('installer:log'));
    check('installer:log returns the log', typeof logTxt === 'string' && logTxt.includes('DRY RUN'));
    await page.click('.app-installer [data-act="later"]');
    check('"Keep using the live session" closes the window', await waitFor(() => page.evaluate(() => !document.querySelector('.app-installer'))));
    check('no page errors, no failed installer resources (EN)', !s.logs.some((l) => /pageerror/.test(l)) && badLoads.length === 0, { pageErrors: s.logs.filter((l) => /pageerror/.test(l)), badLoads });
    check('no console errors other than resource loads', !s.logs.some((l) => /\[error\]/.test(l) && !/Failed to load resource/.test(l)), s.logs.filter((l) => /\[error\]/.test(l)));
    await s.close();
  }

  // ---------------------------------------------------------------- Part 3: failure + cancellation
  const fastSetup = async (page) => {
    await page.waitForSelector('.app-installer .ins[data-step="welcome"]', { timeout: 20000 });
    await clickNext(page);
    await clickNext(page);
    await page.waitForSelector('.app-installer .ins-disks .ins-row');
    await page.click('.app-installer .ins-row[data-id="/dev/vda"]');
    await clickNext(page);
    await page.fill('.app-installer input[name="fullname"]', 'Jane Doe');
    await page.fill('.app-installer input[name="password"]', 'pw');
    await page.fill('.app-installer input[name="confirm"]', 'pw');
    await clickNext(page);
    await clickNext(page);
    await clickNext(page);
    await page.waitForSelector('.dialog');
    await page.click('.dialog .btn.danger');
  };
  {
    const s = await launchShell({ open: ['installer'], live: true, lang: 'en', env: { AURORA_INSTALLER_DRYRUN_DELAY: '0.02', AURORA_INSTALLER_FAIL_AT: 'bootloader' } });
    const { page } = s;
    await fastSetup(page);
    check('failure: error phase', await phaseIs(page, 'error', 30000));
    check('failure: error title + message', (await text(page, '.ins-title')) === 'The installation failed' && (await text(page, '.ins-error-msg'))?.includes("simulated failure at stage 'bootloader'"));
    check('failure: log excerpt shown (ends with the error)', (await text(page, '.ins-log-excerpt'))?.includes('Updating the initramfs') && (await text(page, '.ins-log-excerpt')).includes('ERROR: simulated failure'), await text(page, '.ins-log-excerpt'));
    await page.click('.app-installer [data-act="retry"]');
    check('failure: Try again returns to the summary with the choices kept', (await stepIs(page, 'summary')) && (await state(page)).disk === '/dev/vda' && (await state(page)).user === 'jane');
    // sudo refuses a standard account (simulated: same stderr as sudo) -> ENOTADMIN, clear localized message.
    await s.app.evaluate(() => {
      process.env.AURORA_INSTALLER_FAIL_AT = 'notadmin';
    });
    await clickNext(page);
    await page.waitForSelector('.dialog');
    await page.click('.dialog .btn.danger');
    check('not admin: error phase with code ENOTADMIN', (await phaseIs(page, 'error', 15000)) && (await state(page)).error?.code === 'ENOTADMIN', (await state(page)).error);
    check('not admin: clear message instead of the raw sudo error', (await text(page, '.ins-error-msg')) === "This account isn't an administrator, so it can't install Selene OS. Sign in with an administrator account, or ask an administrator to make your account one.", await text(page, '.ins-error-msg'));
    check('not admin: not shown as cancelled', (await text(page, '.ins-title')) === 'The installation failed');
    await s.close();
  }
  {
    const s = await launchShell({ open: ['installer'], live: true, lang: 'en', env: { AURORA_INSTALLER_DRYRUN_DELAY: '0.4' } });
    const { page } = s;
    await fastSetup(page);
    check('cancel: installing', await phaseIs(page, 'installing', 5000));
    await waitFor(() => page.evaluate(() => window.__installer.state.progress >= 7), { timeout: 15000 });
    await page.click('.app-installer [data-act="cancel"]');
    await page.waitForSelector('.dialog');
    await page.click('.dialog .btn.danger');
    check('cancel: cancelled page', (await phaseIs(page, 'error', 15000)) && (await text(page, '.ins-title')) === 'Installation cancelled');
    check('cancel: helper stopped', await waitFor(async () => (await page.evaluate(() => window.aurora.invoke('installer:status'))).running === false));
    await s.close();
  }

  // ---------------------------------------------------------------- Part 4: FR dark + not live
  {
    const s = await launchShell({ open: ['installer'], live: true, lang: 'fr', theme: 'dark', env: { AURORA_INSTALLER_DRYRUN_DELAY: '0.02' } });
    const { page } = s;
    await page.waitForSelector('.app-installer .ins[data-step="welcome"]', { timeout: 20000 });
    check('FR: installer starts in French', (await text(page, '.ins-title')) === 'Bienvenue dans Selene OS');
    const st = await state(page);
    check('FR: defaults fr keyboard + Europe/Paris', st.lang === 'fr' && st.keyboard === 'fr' && st.timezone === 'Europe/Paris', st);
    const rawKeys = [];
    for (let i = 0; i < 6; i++) {
      const found = await page.evaluate(() =>
        [...document.querySelectorAll('.app-installer *')]
          .filter((e) => e.children.length === 0 && /^[a-z]+(\.[a-zA-Z]+)+$/.test(e.textContent.trim()))
          .map((e) => e.textContent.trim()),
      );
      rawKeys.push(...found);
      if (i === 2) {
        await page.waitForSelector('.app-installer .ins-disks .ins-row');
        check('FR: disk sizes in Go', (await text(page, '.ins-row[data-id="/dev/vda"] .ins-row-size')) === '34 Go');
        await page.click('.app-installer .ins-row[data-id="/dev/vda"]');
      }
      if (i === 3) {
        await page.fill('.app-installer input[name="fullname"]', 'Élodie Dupont');
        await page.fill('.app-installer input[name="password"]', 'a');
        await page.fill('.app-installer input[name="confirm"]', 'b');
        check('FR: mismatch message in French', (await text(page, '[data-field="confirm"] .ins-err')) === 'Les mots de passe ne correspondent pas.');
        await page.fill('.app-installer input[name="confirm"]', 'a');
      }
      if (i < 5) await clickNext(page);
    }
    check('FR: no untranslated keys on any page', rawKeys.length === 0, rawKeys);
    check('FR: summary in French', (await text(page, '.ins-title')) === "Prêt pour l'installation" && (await text(page, '[data-act="next"]')) === 'Installer');
    if (shots) await ins(page).screenshot({ path: path.join(ROOT, 'test/out/installer-summary-fr-dark.png') });
    await s.close();
  }
  // ---------------------------------------------------------------- Part 5: graphics driver step (FR, 1280x720)
  const toSummaryFr = async (page, { drivers = true } = {}) => {
    await page.waitForSelector('.app-installer .ins[data-step="welcome"]', { timeout: 20000 });
    await clickNext(page);
    await clickNext(page);
    await page.waitForSelector('.app-installer .ins-disks .ins-row');
    await page.click('.app-installer .ins-row[data-id="/dev/vda"]');
    await clickNext(page);
    await page.fill('.app-installer input[name="fullname"]', 'Élodie Dupont');
    await page.fill('.app-installer input[name="password"]', 'pw');
    await page.fill('.app-installer input[name="confirm"]', 'pw');
    await clickNext(page);
    await clickNext(page);
    if (drivers) {
      await stepIs(page, 'drivers');
      await clickNext(page);
    }
    return stepIs(page, 'summary');
  };
  const confirmInstall = async (page) => {
    await clickNext(page);
    await page.waitForSelector('.dialog');
    await page.click('.dialog .btn.danger');
  };
  {
    // RTX 4070, online, Secure Boot on: the recommended driver (nvidia-driver-550) is installed during the (dry) run.
    const s = await launchShell({ open: ['installer'], live: true, lang: 'fr', theme: 'light', size: '1280x720', env: { AURORA_INSTALLER_DRYRUN_DELAY: '0.03', AURORA_GPU_FIXTURE: 'rtx4070' } });
    const { page } = s;
    await page.waitForSelector('.app-installer .ins[data-step="welcome"]', { timeout: 20000 });
    check('RTX 4070: the « Pilote graphique » step is added before the summary', await waitFor(async () => (await page.evaluate(() => window.__installer.steps.join(' '))) === 'welcome keyboard disk account timezone drivers summary'), await page.evaluate(() => window.__installer.steps));
    check('RTX 4070: stepper has 8 entries (7 steps + installation), step 6 is « Pilote graphique »', (await page.locator('.app-installer .ins-step').count()) === 8 && (await text(page, '.ins-step:nth-child(6) .ins-step-label')) === 'Pilote graphique');
    await clickNext(page);
    check('RTX 4070: kicker counts 7 steps', (await text(page, '.ins-kicker')) === 'Étape 2 sur 7');
    await clickNext(page);
    await page.waitForSelector('.app-installer .ins-disks .ins-row');
    await page.click('.app-installer .ins-row[data-id="/dev/vda"]');
    await clickNext(page);
    await page.fill('.app-installer input[name="fullname"]', 'Élodie Dupont');
    await page.fill('.app-installer input[name="password"]', 'pw');
    await page.fill('.app-installer input[name="confirm"]', 'pw');
    await clickNext(page);
    await clickNext(page);
    check('RTX 4070: drivers step reached from the time zone', await stepIs(page, 'drivers'));
    check('RTX 4070: title, kicker « Étape 6 sur 7 »', (await text(page, '.ins-title')) === 'Votre carte graphique NVIDIA' && (await text(page, '.ins-kicker')) === 'Étape 6 sur 7');
    check('RTX 4070: card name and current driver', (await text(page, '.ins-gpu-row[data-slot="01:00.0"] .ins-row-title')) === 'NVIDIA GeForce RTX 4070' && (await text(page, '.ins-gpu-row[data-slot="01:00.0"] .ins-row-sub')) === 'Pilote actuel : pilote libre (nouveau)');
    check('RTX 4070: recommended driver', (await text(page, '.ins-gpu-driver .ins-row-title')) === 'Pilote NVIDIA 550' && (await text(page, '.ins-gpu-driver .ins-row-sub')) === 'nvidia-driver-550');
    check('RTX 4070: switch « Installer le pilote NVIDIA recommandé » on by default (online)', (await text(page, '.ins-driver-toggle .toggle-label')) === 'Installer le pilote NVIDIA recommandé' && (await page.isChecked('.app-installer .ins-driver-toggle input')) && !(await page.isDisabled('.app-installer .ins-driver-toggle input')));
    check('RTX 4070: download hint + Secure Boot note (Secure Boot on)', (await text(page, '.ins-driver-hint'))?.includes('dépôts Ubuntu') && (await text(page, '.ins-secureboot'))?.includes('signé par Canonical'));
    check('RTX 4070: no offline note, no hybrid note (single card)', (await page.locator('.app-installer .ins-offline, .app-installer .ins-hybrid').count()) === 0);
    await s.shot('installer-drivers-fr');
    // keyboard: Space toggles the switch, the hint follows; Space again turns it back on
    await page.focus('.app-installer .ins-driver-toggle input');
    await page.keyboard.press('Space');
    check('RTX 4070: Space turns the switch off -> free driver hint, no Secure Boot note', (await state(page)).driverWanted === false && (await text(page, '.ins-driver-hint'))?.includes('pilote libre') && (await page.locator('.app-installer .ins-secureboot').count()) === 0);
    check('RTX 4070: focus stays on the switch', await page.evaluate(() => document.activeElement?.closest('.ins-driver-toggle') != null));
    await page.keyboard.press('Space');
    check('RTX 4070: Space turns it back on', (await state(page)).driverWanted === true);
    await page.keyboard.press('Enter');
    check('RTX 4070: Enter on the switch = Next (summary)', await stepIs(page, 'summary'));
    check('RTX 4070: summary kicker « Étape 7 sur 7 »', (await text(page, '.ins-kicker')) === 'Étape 7 sur 7');
    const drvRow = await text(page, '.ins-sum-row[data-row="driver"]');
    check('RTX 4070: summary row « Pilote graphique »', drvRow?.includes('Pilote NVIDIA recommandé · Pilote NVIDIA 550') && drvRow.includes("Téléchargé pendant l'installation"), drvRow);
    await page.evaluate(() => document.querySelector('.app-installer .ins-sum-row[data-row="driver"]')?.scrollIntoView({ block: 'end' }));
    await s.shot('installer-drivers-summary-fr');
    await page.click('.app-installer .ins-sum-row[data-row="driver"] .btn');
    check('RTX 4070: Change goes back to the drivers step', await stepIs(page, 'drivers'));
    await clickNext(page);
    await page.evaluate(() => {
      window.__insEvents = [];
      window.aurora.on('installer:progress', (e) => window.__insEvents.push(e));
    });
    await confirmInstall(page);
    check('RTX 4070: installing with a « Installation du pilote graphique » stage (7 stages)', (await phaseIs(page, 'installing', 5000)) && (await page.locator('.app-installer .ins-stage').count()) === 7 && (await text(page, '.ins-stage[data-stage="drivers"]')) === 'Installation du pilote graphique');
    check('RTX 4070: done', await phaseIs(page, 'done', 60000));
    const evs = await page.evaluate(() => window.__insEvents);
    check('RTX 4070: the helper got --nvidia-driver nvidia-driver-550 (log)', (await page.evaluate(() => window.aurora.invoke('installer:log'))).includes('nvidia-driver=nvidia-driver-550'));
    check('RTX 4070: driver event installed', evs.some((e) => e.type === 'driver' && e.status === 'installed' && e.pkg === 'nvidia-driver-550'), evs.filter((e) => e.type === 'driver'));
    check('RTX 4070: drivers stage progress 76..88, monotonic overall', evs.filter((e) => e.type === 'progress' && e.stage === 'drivers').length >= 5 && evs.filter((e) => e.type === 'progress').every((e, i, a) => i === 0 || e.progress >= a[i - 1].progress));
    check('RTX 4070: done page says the driver is installed', (await text(page, '.ins-driver-result[data-status="installed"]'))?.includes('Le pilote NVIDIA (nvidia-driver-550) est installé'));
    await s.shot('installer-drivers-done-fr');
    check('RTX 4070: no page errors', !s.logs.some((l) => /pageerror/.test(l)), s.logs.filter((l) => /pageerror/.test(l)));
    await s.close();
  }
  {
    // GTX 1060 (Pascal), offline: switch disabled, clear note, « Vérifier à nouveau »; nothing is downloaded.
    const s = await launchShell({ open: ['installer'], live: true, lang: 'fr', theme: 'light', size: '1280x720', env: { AURORA_INSTALLER_DRYRUN_DELAY: '0.02', AURORA_GPU_FIXTURE: 'gtx1060', AURORA_GPU_ONLINE: '0' } });
    const { page } = s;
    await page.waitForSelector('.app-installer .ins[data-step="welcome"]', { timeout: 20000 });
    await waitFor(() => page.evaluate(() => window.__installer.steps.includes('drivers')));
    await page.evaluate(() => window.__installer.go(window.__installer.steps.indexOf('drivers')));
    check('GTX 1060: drivers step', await stepIs(page, 'drivers'));
    check('GTX 1060: card name', (await text(page, '.ins-gpu-row .ins-row-title')) === 'NVIDIA GeForce GTX 1060 6GB');
    check('GTX 1060 offline: switch off and disabled', !(await page.isChecked('.app-installer .ins-driver-toggle input')) && (await page.isDisabled('.app-installer .ins-driver-toggle input')));
    check('GTX 1060 offline: « Connectez-vous à Internet… » note', (await text(page, '.ins-offline'))?.includes("Connectez-vous à Internet pour l'installer maintenant, ou plus tard dans Paramètres > Pilotes graphiques."), await text(page, '.ins-offline'));
    check('GTX 1060: no Secure Boot note (Secure Boot off / offline)', (await page.locator('.app-installer .ins-secureboot').count()) === 0);
    await s.shot('installer-drivers-offline-fr');
    // The connection comes back: « Vérifier à nouveau » turns the switch on.
    await s.app.evaluate(() => {
      process.env.AURORA_GPU_ONLINE = '1';
    });
    await page.click('.app-installer [data-act="recheck"]');
    check('GTX 1060: back online after « Vérifier à nouveau »: switch enabled and on', await waitFor(async () => (await page.isChecked('.app-installer .ins-driver-toggle input')) && !(await page.isDisabled('.app-installer .ins-driver-toggle input'))));
    check('GTX 1060: the offline note is gone once online', (await page.locator('.app-installer .ins-offline').count()) === 0);
    // The user turns the driver off: the free driver is kept, nothing is downloaded.
    await page.click('.app-installer .ins-driver-toggle .toggle-label');
    check('GTX 1060: switch turned off by the user', (await state(page)).driverWanted === false && (await text(page, '.ins-driver-hint'))?.includes('Paramètres > Pilotes graphiques'));
    await page.evaluate(() => window.__installer.go(0));
    check('GTX 1060: summary', await toSummaryFr(page));
    check('GTX 1060: summary row « Pilote libre »', (await text(page, '.ins-sum-row[data-row="driver"]'))?.includes('Pilote libre') && (await text(page, '.ins-sum-row[data-row="driver"]')).includes('plus tard, dans Paramètres > Pilotes graphiques'), await text(page, '.ins-sum-row[data-row="driver"]'));
    await confirmInstall(page);
    check('GTX 1060 driver off: no driver stage, done, no driver note', (await phaseIs(page, 'done', 60000)) && (await state(page)).driverRequested === null && (await page.locator('.app-installer .ins-driver-result').count()) === 0 && !(await page.evaluate(() => window.aurora.invoke('installer:log'))).includes('nvidia-driver='));
    // AMD-only / Intel-only machines: nothing offered.
    for (const fx of ['amd', 'intel']) {
      await s.app.evaluate((_, f) => {
        process.env.AURORA_GPU_FIXTURE = f;
      }, fx);
      const g = await page.evaluate(() => window.aurora.invoke('installer:gpu', { refresh: true }));
      check(`${fx} only: a card, no NVIDIA, no driver offered`, g.gpus.length === 1 && g.gpus[0].vendor === fx && g.nvidia.length === 0 && g.recommended === null, g);
    }
    await s.close();
  }
  {
    // Optimus laptop (Intel + RTX 3050 Mobile): hybrid note; the driver download fails -> installed anyway, note.
    const s = await launchShell({ open: ['installer'], live: true, lang: 'fr', theme: 'dark', size: '1280x720', env: { AURORA_INSTALLER_DRYRUN_DELAY: '0.02', AURORA_GPU_FIXTURE: 'optimus', AURORA_INSTALLER_FAIL_AT: 'drivers' } });
    const { page } = s;
    await page.waitForSelector('.app-installer .ins[data-step="welcome"]', { timeout: 20000 });
    await waitFor(() => page.evaluate(() => window.__installer.steps.includes('drivers')));
    await page.evaluate(() => window.__installer.go(window.__installer.steps.indexOf('drivers')));
    check('Optimus: only the NVIDIA card is listed, recommended 550 open', (await page.locator('.app-installer .ins-gpu-row[data-slot]').count()) === 1 && (await text(page, '.ins-gpu-row .ins-row-title')) === 'NVIDIA GeForce RTX 3050 Mobile' && (await text(page, '.ins-gpu-driver .ins-row-title')) === 'Pilote NVIDIA 550 (modules du noyau ouverts)');
    check('Optimus: hybrid note names the Intel chip', (await text(page, '.ins-hybrid'))?.includes('puce graphique Intel'));
    await s.shot('installer-drivers-optimus-fr-dark');
    await page.evaluate(() => window.__installer.go(0));
    check('Optimus: summary', await toSummaryFr(page));
    await confirmInstall(page);
    check('Optimus: the installation still succeeds when the driver fails', await phaseIs(page, 'done', 60000));
    check('Optimus: « Le pilote n\'a pas pu être installé… » on the done page', (await text(page, '.ins-driver-result[data-status="failed"]')) === "Le pilote n'a pas pu être installé ; vous pourrez l'installer plus tard dans Paramètres > Pilotes graphiques.", await text(page, '.ins-driver-result'));
    await s.shot('installer-drivers-failed-fr-dark');
    check('Optimus: no page errors', !s.logs.some((l) => /pageerror/.test(l)), s.logs.filter((l) => /pageerror/.test(l)));
    await s.close();
  }
  {
    const s = await launchShell({ live: false, lang: 'en' });
    const { page } = s;
    await sleep(500);
    check('not live: no "Install Selene OS" desktop icon', !(await page.evaluate(() => !!document.querySelector('.desk-icon[data-id="special:installer"]'))));
    await s.close();
  }
}
