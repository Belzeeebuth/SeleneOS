// System updates on real PCs (image track): background update check, apt-autoremove after « Mettre à jour »,
// unattended-upgrades configuration, Secure Boot EFI image of the ISO build.
//   Unit (no Electron): main/ipc/updates.js against a fake apt-get (AURORA_APT_GET, never the machine's apt), live
//   session, apt failure; admin.js (apt-autoremove spec, follow-up of apt-upgrade); aurora-admin (syntax, action);
//   rootfs APT::Periodic / unattended-upgrades / live drop-ins; iso/config.sh defaults (HWE kernel, firmware);
//   iso/build.sh make_secureboot_efi + its xorriso wrapper (signed shim / GRUB from the host's shim-signed and
//   grub-efi-amd64-signed when present).
//   Shell (Electron, dev, 1280x720 FR): the notification « 5 mises à jour disponibles » after the first delay, its
//   action opens Paramètres > Mises à jour with the count badge and the list; « Tout installer » runs apt-upgrade then
//   apt-autoremove (one prompt), the badge goes away; the live session never checks.
// Usage:  cd aurora-os/shell && xvfb-run -a -s "-screen 0 1600x900x24" node test/update-check.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.join(ROOT, '..');

let passed = 0;
const failures = [];
function check(name, actual, expected = true) {
  const ok = typeof expected === 'function' ? !!expected(actual) : Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else failures.push(`${name}\n      expected: ${typeof expected === 'function' ? '(predicate)' : JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
  return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-updcheck-'));

function fakeApi({ live = false, DEV = false } = {}) {
  const handlers = {};
  const sent = [];
  return { DEV, env: { live }, handlers, sent, handle: (ch, fn) => (handlers[ch] = fn), broadcast: (ch, p) => sent.push([ch, p]), sendTo() {} };
}

try {
  // ------------------------------------------------------------------ updates.js
  const U = require(path.join(ROOT, 'main', 'ipc', 'updates.js'));
  const SIM = [
    'NOTE: This is only a simulation!',
    'Reading package lists...',
    'Inst libssl3t64 [3.0.13-0ubuntu3.5] (3.0.13-0ubuntu3.6 Ubuntu:24.04/noble-security [amd64])',
    'Inst tzdata [2025b-0ubuntu0.24.04] (2025c-0ubuntu0.24.04 Ubuntu:24.04/noble-updates [all])',
    'Inst linux-image-7.0.0-36-generic (7.0.0-36.36~24.04.1 Ubuntu:24.04/noble-updates, Ubuntu:24.04/noble-security [amd64])',
    'Conf libssl3t64 (3.0.13-0ubuntu3.6 Ubuntu:24.04/noble-security [amd64])',
  ].join('\n');
  check('parse: Inst lines only', U.parsers.parseSimulation(SIM).map((p) => [p.name, p.from, p.to, p.security]), [
    ['libssl3t64', '3.0.13-0ubuntu3.5', '3.0.13-0ubuntu3.6', true],
    ['tzdata', '2025b-0ubuntu0.24.04', '2025c-0ubuntu0.24.04', false],
    ['linux-image-7.0.0-36-generic', null, '7.0.0-36.36~24.04.1', true],
  ]);
  check('parse: garbage', U.parsers.parseSimulation('Inst\nfoo bar\n'), []);

  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin);
  const fakeApt = path.join(bin, 'apt-get');
  const argsFile = path.join(tmp, 'apt-args');
  fs.writeFileSync(fakeApt, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\n[ -n "$FAKE_APT_FAIL" ] && { echo "E: Could not open lock file" >&2; exit 100; }\ncat <<'EOF'\n${SIM}\nEOF\n`, { mode: 0o755 });
  process.env.AURORA_APT_GET = fakeApt;
  {
    const api = fakeApi();
    U(api);
    const r = await api.handlers['updates:pending']();
    check('real path: count / security from apt-get -s', [r.count, r.security, r.live, r.error], [3, 2, false, null]);
    check('real path: simulation only, as the user (no lock, no install)', fs.readFileSync(argsFile, 'utf8').trim().split('\n'), ['-s', '-q', '-o', 'Debug::NoLocking=1', 'upgrade', '--with-new-pkgs']);
    check('broadcast updates:changed', api.sent.map((x) => x[0]), ['updates:changed']);
    check('updates:last returns the result', (await api.handlers['updates:last']()).count, 3);
    check('updates:clear -> 0', (await api.handlers['updates:clear']()).count, 0);
    check('schedule: 5 min then daily', await api.handlers['updates:schedule'](), { live: false, firstDelay: 300000, interval: 86400000 });
    process.env.FAKE_APT_FAIL = '1';
    const e = await api.handlers['updates:pending']();
    check('apt failure: count 0 + error', [e.count, /lock/.test(e.error || '')], [0, true]);
    delete process.env.FAKE_APT_FAIL;
  }
  {
    const api = fakeApi({ live: true });
    U(api);
    fs.rmSync(argsFile, { force: true });
    const r = await api.handlers['updates:pending']();
    check('live session: never runs apt', [r.live, r.count, fs.existsSync(argsFile)], [true, 0, false]);
    check('live session: schedule says live', (await api.handlers['updates:schedule']()).live, true);
  }
  delete process.env.AURORA_APT_GET;
  {
    const lines = [];
    const out = await U.devRun('apt-autoremove', [], (l) => lines.push(l.trim()));
    check('dev apt-autoremove: APT status lines + done', [out, lines.every((l) => /^pmstatus:linux-/.test(l)), lines.length > 0], ['done\n', true, true]);
  }

  // ------------------------------------------------------------------ admin.js / aurora-admin
  const A = require(path.join(ROOT, 'main', 'ipc', 'admin.js'));
  const { ACTIONS, validate } = A.parsers;
  check('admin.js: apt-autoremove allowed, no arguments, streamed', [ACTIONS['apt-autoremove']?.stream, ACTIONS['apt-autoremove']?.args.length], [true, 0]);
  check('admin.js: apt-upgrade is followed by apt-autoremove', ACTIONS['apt-upgrade'].then, 'apt-autoremove');
  let threw = null;
  try {
    validate('apt-autoremove', ['--purge']);
  } catch (e) {
    threw = e.code;
  }
  check('admin.js: apt-autoremove refuses arguments', threw, 'EINVAL');
  const helper = path.join(REPO, 'rootfs', 'usr', 'lib', 'aurora', 'helpers', 'aurora-admin');
  check('aurora-admin: bash syntax', spawnSync('bash', ['-n', helper]).status, 0);
  const htxt = fs.readFileSync(helper, 'utf8');
  check('aurora-admin: apt-autoremove action (no arguments, autoremove only)', /\napt-autoremove\)\n  need_args \$# 0\n[\s\S]*?apt-get -q -y -o DPkg::Lock::Timeout=120 -o APT::Status-Fd=3 autoremove 3>&1 1>&2/.test(htxt));
  check('aurora-admin: documented in the header', /^#   apt-autoremove /m.test(htxt));

  // ------------------------------------------------------------------ image configuration
  const rf = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');
  const periodic = rf('rootfs/etc/apt/apt.conf.d/21aurora-auto-upgrades');
  for (const k of ['APT::Periodic::Update-Package-Lists "1"', 'APT::Periodic::Unattended-Upgrade "1"', 'APT::Periodic::AutocleanInterval "7"']) check(`APT::Periodic: ${k}`, periodic.includes(k));
  check('unattended-upgrades: old kernels removed', rf('rootfs/etc/apt/apt.conf.d/52aurora-unattended-upgrades').includes('Unattended-Upgrade::Remove-Unused-Kernel-Packages "true"'));
  for (const u of ['apt-daily.service', 'apt-daily-upgrade.service', 'unattended-upgrades.service', 'apt-daily.timer', 'apt-daily-upgrade.timer']) {
    check(`${u}: skipped in the live session`, rf(`rootfs/etc/systemd/system/${u}.d/aurora-live.conf`).includes('ConditionKernelCommandLine=!boot=casper'));
  }
  check('release.list: unattended-upgrades', /^unattended-upgrades$/m.test(rf('iso/packages.d/release.list')));
  const cfg = execFileSync('bash', ['-c', 'unset WITH_FIRMWARE KERNEL_PACKAGE; source iso/config.sh; echo "$WITH_FIRMWARE $KERNEL_PACKAGE"'], { cwd: REPO, encoding: 'utf8' }).trim();
  check('config.sh: firmware + HWE kernel by default', cfg, '1 linux-image-generic-hwe-24.04');
  const cfg0 = execFileSync('bash', ['-c', 'source iso/config.sh; echo "$WITH_FIRMWARE"'], { cwd: REPO, encoding: 'utf8', env: { ...process.env, WITH_FIRMWARE: '0' } }).trim();
  check('config.sh: WITH_FIRMWARE=0 still works (quick VM builds)', cfg0, '0');

  // ------------------------------------------------------------------ Secure Boot EFI image (build.sh)
  const build = rf('iso/build.sh');
  const m = /(# ---- Secure Boot EFI boot image[\s\S]*?)\nstage_iso\(\) \{/.exec(build);
  check('build.sh: Secure Boot EFI block', !!m);
  check('build.sh: grub-mkrescue goes through the wrapper', /grub-mkrescue --xorriso="\$WORK\/secureboot\/xorriso"/.test(build));
  const haveSigned = fs.existsSync('/usr/lib/shim/shimx64.efi.signed') && fs.existsSync('/usr/lib/grub/x86_64-efi-signed/gcdx64.efi.signed') && spawnSync('sh', ['-c', 'command -v mkfs.vfat || test -x /usr/sbin/mkfs.vfat']).status === 0 && spawnSync('sh', ['-c', 'command -v mcopy']).status === 0;
  if (m && haveSigned) {
    const fns = path.join(tmp, 'sb-fns.sh');
    fs.writeFileSync(fns, m[1]);
    const sb = path.join(tmp, 'sb');
    const r = spawnSync('bash', ['-c', `set -Eeuo pipefail; die() { echo "DIE $*" >&2; exit 1; }; PKG_LAYER=""; SOURCE_DATE_EPOCH=1791897972; PATH=$PATH:/usr/sbin; source "${fns}"; make_secureboot_efi "${sb}"`], { encoding: 'utf8' });
    check('make_secureboot_efi runs (host shim-signed / grub-efi-amd64-signed)', r.status, 0) || console.log(r.stderr);
    const dir = execFileSync('mdir', ['-b', '-/', '-i', path.join(sb, 'efi.img'), '::/EFI'], { encoding: 'utf8' }).split('\n').map((l) => l.trim().toLowerCase()).filter(Boolean).sort();
    check('EFI image: shim as BOOTX64.EFI, signed CD GRUB, MokManager, grub.cfg stubs', dir, ['::/efi/boot/', '::/efi/boot/bootx64.efi', '::/efi/boot/grub.cfg', '::/efi/boot/grubx64.efi', '::/efi/boot/mmx64.efi', '::/efi/ubuntu/', '::/efi/ubuntu/grub.cfg']);
    check('EFI image: BOOTX64.EFI is the signed shim', fs.readFileSync(path.join(sb, 'boot', 'bootx64.efi')).equals(fs.readFileSync(fs.realpathSync('/usr/lib/shim/shimx64.efi.signed'))));
    check('EFI image: grubx64.efi is gcdx64.efi.signed', fs.readFileSync(path.join(sb, 'boot', 'grubx64.efi')).equals(fs.readFileSync('/usr/lib/grub/x86_64-efi-signed/gcdx64.efi.signed')));
    check('grub.cfg stub: finds the ISO and reads its menu', fs.readFileSync(path.join(sb, 'boot', 'grub.cfg'), 'utf8'), (s) => s.includes('search --no-floppy --set=root --file /.disk/aurora-build-id') && s.includes('configfile $prefix/grub.cfg'));
    // The wrapper: swaps grub-mkrescue's efi.img and /efi/boot, then runs xorriso (a fake one here).
    const tree = path.join(tmp, 'grub.mkrescue');
    fs.mkdirSync(path.join(tree, 'efi', 'boot'), { recursive: true });
    fs.writeFileSync(path.join(tree, 'efi.img'), 'unsigned');
    fs.writeFileSync(path.join(tree, 'efi', 'boot', 'bootx64.efi'), 'unsigned');
    const fx = path.join(tmp, 'fakebin');
    fs.mkdirSync(fx);
    fs.writeFileSync(path.join(fx, 'xorriso'), `#!/bin/sh\necho "xorriso $*" > "${tmp}/xorriso-args"\n`, { mode: 0o755 });
    const w = spawnSync(path.join(sb, 'xorriso'), ['-as', 'mkisofs', '--efi-boot', 'efi.img', '-efi-boot-part', '-r', tree, '/nonexistent'], { encoding: 'utf8', env: { ...process.env, PATH: `${fx}:${process.env.PATH}`, AURORA_SB_DIR: sb } });
    check('wrapper: exit 0 and xorriso called with the same arguments', [w.status, fs.readFileSync(path.join(tmp, 'xorriso-args'), 'utf8').trim()], [0, `xorriso -as mkisofs --efi-boot efi.img -efi-boot-part -r ${tree} /nonexistent`]);
    check('wrapper: efi.img replaced by the signed one', fs.readFileSync(path.join(tree, 'efi.img')).equals(fs.readFileSync(path.join(sb, 'efi.img'))));
    check('wrapper: /efi/boot holds shim + GRUB', fs.readdirSync(path.join(tree, 'efi', 'boot')).sort(), ['bootx64.efi', 'grub.cfg', 'grubx64.efi', 'mmx64.efi']);
    const w2 = spawnSync(path.join(sb, 'xorriso'), ['-as', 'mkisofs', '--efi-boot', 'efi.img', '/nonexistent'], { encoding: 'utf8', env: { ...process.env, PATH: `${fx}:${process.env.PATH}`, AURORA_SB_DIR: sb } });
    check('wrapper: refuses to build without swapping the EFI image', w2.status, 1);
  } else if (m) {
    console.log('  (skipped: no shim-signed / grub-efi-amd64-signed / dosfstools / mtools on this host)');
  }

  // ------------------------------------------------------------------ shell (Electron, dev)
  const { launchShell } = await import('./lib.mjs');
  const toastText = (s) => s.page.evaluate(() => [...document.querySelectorAll('#toasts .toast:not(.leaving)')].map((t) => t.innerText).join('\n---\n'));
  const ENV = { AURORA_UPDATE_CHECK_DELAY_MS: '1500', AURORA_DEV_NOPASSWD: '1' };
  for (const theme of ['dark', 'light']) {
    const s = await launchShell({ lang: 'fr', theme, size: '1280x720', env: ENV });
    try {
      const got = await s.page.waitForFunction(() => /5 mises à jour disponibles/.test(document.querySelector('#toasts')?.innerText || ''), null, { timeout: 15000 }).then(() => true, () => false);
      check(`[${theme}] notification « 5 mises à jour disponibles » after the first delay`, got);
      const tt = await toastText(s);
      check(`[${theme}] notification mentions the 2 security updates, warm « vous » copy`, tt, (x) => /dont 2 mises à jour de sécurité/.test(x) && /votre ordinateur/.test(x));
      await s.shot(`update-check-toast-fr-${theme}`);
      await s.page.locator('#toasts .toast button', { hasText: 'Voir les mises à jour' }).first().click();
      await s.page.waitForSelector('.app-settings .st-nav-item[data-page="update"] .st-nav-badge', { timeout: 10000 });
      check(`[${theme}] Paramètres opened on Mises à jour`, await s.page.evaluate(() => document.querySelector('.app-settings .st-title')?.textContent), 'Mises à jour');
      check(`[${theme}] badge « 5 » on the Mises à jour entry`, await s.page.locator('.app-settings .st-nav-item[data-page="update"] .st-nav-badge').innerText(), '5');
      check(`[${theme}] the page lists the pending updates without « Rechercher »`, await s.page.locator('.app-settings .st-pkg').count(), 5);
      await sleep(400);
      await s.shot(`update-check-settings-fr-${theme}`);
      if (theme === 'dark') {
        const steps = [];
        await s.page.exposeFunction('__updStep', (x) => steps.push(x));
        await s.page.evaluate(() => {
          const obs = new MutationObserver(() => {
            const el = document.querySelector('.app-settings .st-upd-progress .caption');
            if (el) window.__updStep(el.textContent);
          });
          obs.observe(document.body, { subtree: true, childList: true, characterData: true });
        });
        await s.page.locator('.app-settings .btn.primary', { hasText: 'Tout installer' }).click();
        await s.page.waitForSelector('.uac-dialog', { timeout: 8000 });
        await s.page.locator('.uac-dialog .dialog-footer .btn.primary').click();
        const done = await s.page.waitForFunction(() => /à jour/.test(document.querySelector('.app-settings .st-hero-title')?.textContent || '') && !document.querySelector('.app-settings .st-upd-progress'), null, { timeout: 20000 }).then(() => true, () => false);
        check('[dark] « Tout installer »: update then clean-up, one prompt', done);
        check('[dark] the clean-up step « Nettoyage des anciennes versions… » showed', steps, (a) => a.some((x) => /Nettoyage des anciennes versions/.test(x)));
        check('[dark] no second prompt', await s.page.locator('.uac-dialog').count(), 0);
        const gone = await s.page.waitForFunction(() => !document.querySelector('.app-settings .st-nav-item[data-page="update"] .st-nav-badge'), null, { timeout: 5000 }).then(() => true, () => false);
        check('[dark] the badge goes away once updated', gone);
      }
    } finally {
      await s.close();
    }
  }
  {
    const s = await launchShell({ lang: 'fr', size: '1280x720', live: true, env: ENV });
    try {
      await sleep(3500);
      check('live session: no update notification', await toastText(s), (x) => !/mises à jour disponibles/.test(x));
      check('live session: the feature did not start', await s.aurora(() => !window.__aurora.updateCheck), true);
    } finally {
      await s.close();
    }
  }
} catch (err) {
  failures.push(`crashed: ${err.stack || err}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\nupdate-check: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL ${f}`);
process.exit(failures.length ? 1 : 0);
