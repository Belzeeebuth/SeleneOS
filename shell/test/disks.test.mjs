// Disks tests — backend parser (lsblk fixture), aurora-admin format-removable refusals (early checks only, nothing is
// written), then the real Electron shell in dev mode (mocked drives: NVMe system disk + SanDisk USB stick):
// drive list, partition bar to scale, details (SMART "not available"), keyboard, mount / unmount, refusals on the
// system disk, Format with the typed-name confirmation + elevation prompt (cancel and success), Eject, change events,
// French + dark theme, console errors. Screenshots: docs/screenshots/disks-light-en.png, disks-dark-fr.png.
// Usage:  cd aurora-os/shell && xvfb-run -a -s "-screen 0 1600x900x24" node test/disks.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { launchShell, ROOT } from './lib.mjs';

const require = createRequire(import.meta.url);
const DOCS = path.join(ROOT, '..', 'docs', 'screenshots');
fs.mkdirSync(DOCS, { recursive: true });
const HELPER = path.join(ROOT, '..', 'rootfs', 'usr', 'lib', 'aurora', 'helpers', 'aurora-admin');

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

async function until(page, expr, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await page.evaluate(expr).catch(() => false)) return true;
    await sleep(80);
  }
  return false;
}
const invoke = (page, ch, ...args) =>
  page.evaluate(`(async () => { const r = await window.aurora.invokeRaw(${JSON.stringify(ch)}, ...${JSON.stringify(args)}); return r && r.ok ? { ok: r.value } : { error: (r && r.error) || { code: 'EFAIL' } }; })()`);

// ---------------------------------------------------------------- 1. parser (pure)
{
  const { parsers } = require('../main/ipc/disks.js');
  const fixture = {
    blockdevices: [
      { name: 'loop0', path: '/dev/loop0', type: 'loop', size: 1000, fstype: 'squashfs', mountpoints: ['/rofs'] },
      {
        name: 'sda', path: '/dev/sda', type: 'disk', size: 256e9, model: 'Samsung_SSD_870', vendor: 'ATA     ', tran: 'sata', rm: false, rota: false, pttype: 'gpt', 'log-sec': 512,
        children: [
          { name: 'sda1', path: '/dev/sda1', type: 'part', size: 536870912, start: 2048, fstype: 'vfat', mountpoints: ['/boot/efi'] },
          { name: 'sda2', path: '/dev/sda2', type: 'part', size: 255e9, start: 1050624, fstype: 'ext4', label: 'root', mountpoints: ['/'], fsused: 1e9, fsavail: 2e9 },
        ],
      },
      {
        name: 'sdb', path: '/dev/sdb', type: 'disk', size: 16e9, model: 'Cruzer Blade', vendor: 'SanDisk', tran: 'usb', rm: true, pttype: 'dos',
        children: [{ name: 'sdb1', path: '/dev/sdb1', type: 'part', size: 15.9e9, start: 2048, fstype: 'exfat', label: 'STICK', mountpoints: ['/media/u/STICK'] }],
      },
      { name: 'sdc', path: '/dev/sdc', type: 'disk', size: 4e9, model: 'Live', tran: 'usb', rm: true, children: [{ name: 'sdc1', path: '/dev/sdc1', type: 'part', size: 4e9, fstype: 'iso9660', mountpoints: ['/cdrom'] }] },
      { name: 'zram0', path: '/dev/zram0', type: 'disk', size: 8e9, mountpoints: ['[SWAP]'] },
    ],
  };
  const df = new Map([['/dev/sdb1', { size: 15.8e9, used: 5e9, avail: 10.8e9, target: '/media/u/STICK' }]]);
  const drives = parsers.parseLsblk(fixture, df);
  check(drives.length === 3 && drives.map((d) => d.name).join() === 'sda,sdb,sdc', 'parser keeps whole disks only (no loop / zram)', drives.map((d) => d.name));
  const [sda, sdb, sdc] = drives;
  check(sda.system && !sda.formattable && !sda.removable, 'parser: disk holding / is the system, not formattable');
  check(sda.partitions[1].start === 1050624 * 512, 'parser: partition start converted from sectors to bytes', sda.partitions[1].start);
  check(sda.model === 'Samsung SSD 870', 'parser: model underscores become spaces (padded vendor ignored)', sda.model);
  check(sdb.removable && sdb.formattable && !sdb.system && sdb.model === 'SanDisk Cruzer Blade', 'parser: USB stick is removable + formattable, vendor prefixed', sdb.model);
  check(sdb.partitions[0].used === 5e9 && sdb.partitions[0].avail === 10.8e9 && sdb.partitions[0].mountpoint === '/media/u/STICK', 'parser: usage comes from df');
  check(sdc.system && !sdc.formattable, 'parser: the live medium (/cdrom) is never formattable');
}

// ---------------------------------------------------------------- 2. helper refusals (exit before touching any disk)
{
  const syntax = spawnSync('bash', ['-n', HELPER]);
  check(syntax.status === 0, 'aurora-admin passes bash -n', String(syntax.stderr));
  const src = fs.readFileSync(HELPER, 'utf8');
  check(/BEGIN disks[\s\S]*format-removable\)[\s\S]*END disks/.test(src), 'aurora-admin has the delimited format-removable block');
  check(/removable[\s\S]*TRAN|tran" = usb/.test(src) && /\/cdrom/.test(src) && /mklabel msdos/.test(src), 'helper checks removable / live medium and uses mklabel msdos');
  if (process.getuid?.() === 0) {
    const runH = (...a) => spawnSync('bash', [HELPER, 'format-removable', ...a], { encoding: 'utf8', input: '' });
    const r1 = runH('/dev/nvme0n1', 'vfat', 'X');
    check(r1.status === 2, 'helper refuses a non-USB/SD device name (exit 2)', [r1.status, r1.stderr]);
    const r2 = runH('/dev/sdzz', 'vfat', 'X');
    check(r2.status === 3, 'helper: missing disk → exit 3', [r2.status, r2.stderr]);
    const r3 = runH('/dev/sdzz', 'ntfs', 'X');
    check(r3.status === 2, 'helper refuses an unknown file system', [r3.status, r3.stderr]);
    const r4 = runH('/dev/sdzz', 'vfat', 'BAD;LABEL');
    check(r4.status === 2, 'helper refuses a label with shell characters', [r4.status, r4.stderr]);
    const r5 = runH('/dev/sdzz', 'vfat', 'TWELVECHARSX');
    check(r5.status === 2 && /11/.test(r5.stderr), 'helper refuses a FAT label over 11 characters', [r5.status, r5.stderr]);
    const r6 = runH('/dev/sdb1', 'vfat', 'X');
    check(r6.status === 2, 'helper refuses a partition (whole disks only)', [r6.status, r6.stderr]);
  } else {
    console.log('  (not root: helper refusal checks skipped)');
  }
}

// ---------------------------------------------------------------- 3. app (EN, light)
const errors = [];
let s = await launchShell({ open: ['disks'], lang: 'en', theme: 'light' });
s.page.on('pageerror', (e) => errors.push(e.message));
s.page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
try {
  const { page } = s;
  check(await until(page, `document.querySelectorAll('${WIN} .dk-drive').length === 2`, 15000), 'two mocked drives listed');
  check((await page.locator(`${WIN} .titlebar, ${WIN} .win-title`).first().innerText().catch(() => '')).includes('Disks') || (await page.evaluate(`document.querySelector('${WIN}')?.innerText.includes('Disks')`)), 'window titled Disks');
  const names = await page.evaluate(`[...document.querySelectorAll('${WIN} .dk-drive-name')].map((e) => e.textContent)`);
  check(names.includes('Aurora NVMe SSD 512GB') && names.includes('SanDisk Ultra'), 'drive names shown', names);
  check(await page.evaluate(`document.querySelector('${WIN} .dk-drive.selected')?.dataset.path === '/dev/sdb'`), 'removable drive selected first');
  check(await page.evaluate(`!!document.querySelector('${WIN} .dk-sim:not([hidden])')`), 'simulated-drives note shown in dev');
  const usbBar = await page.evaluate(`[...document.querySelectorAll('${WIN} .dk-bar .dk-seg')].map((e) => e.className)`);
  check(usbBar.length === 1 && /mounted/.test(usbBar[0]), 'USB stick: one mounted partition in the bar', usbBar);
  check(await page.evaluate(`document.querySelector('${WIN} .dk-part')?.innerText.includes('/media/user/USB STICK')`), 'volume details show the mount point');
  check(await page.evaluate(`/9\\.1 GB used of 30\\.\\d GB/.test(document.querySelector('${WIN} .dk-part')?.innerText || '')`), 'usage shown (used / size)', await page.evaluate(`document.querySelector('${WIN} .dk-usage')?.innerText`));
  check(await page.evaluate(`document.querySelector('${WIN} .dk-smart')?.textContent === 'Not available'`), 'SMART shown as not available');
  check(await page.evaluate(`!!document.querySelector('${WIN} .dk-eject') && !!document.querySelector('${WIN} .dk-format')`), 'Eject and Format offered for the USB stick');
  await s.shot('disks-light-en');
  fs.copyFileSync(path.join(ROOT, 'test', 'out', 'disks-light-en.png'), path.join(DOCS, 'disks-light-en.png'));

  // keyboard: list navigation
  await page.locator(`${WIN} .dk-drive.selected`).focus();
  await page.keyboard.press('Home');
  check(await until(page, `document.querySelector('${WIN} .dk-drive.selected')?.dataset.path === '/dev/nvme0n1' && document.activeElement?.dataset.path === '/dev/nvme0n1'`), 'Home selects + focuses the first drive');
  await page.keyboard.press('ArrowDown');
  check(await until(page, `document.querySelector('${WIN} .dk-drive.selected')?.dataset.path === '/dev/sdb'`), 'ArrowDown selects the next drive');
  await page.keyboard.press('ArrowUp');
  check(await until(page, `document.querySelector('${WIN} .dk-drive.selected')?.dataset.path === '/dev/nvme0n1'`), 'ArrowUp selects the previous drive');

  // system disk: bar to scale, refusals
  const segs = await page.evaluate(`[...document.querySelectorAll('${WIN} .dk-bar .dk-seg')].map((e) => ({ w: e.getBoundingClientRect().width, path: e.dataset.path || '' }))`);
  check(segs.length === 3, 'system disk: three partitions in the bar', segs.length);
  const w = Object.fromEntries(segs.map((x) => [x.path, x.w]));
  check(w['/dev/nvme0n1p2'] > 8 * w['/dev/nvme0n1p3'] && w['/dev/nvme0n1p3'] >= w['/dev/nvme0n1p1'], 'partition widths follow their sizes', w);
  const barW = await page.evaluate(`document.querySelector('${WIN} .dk-bar').getBoundingClientRect().width`);
  check(w['/dev/nvme0n1p2'] / barW > 0.85, 'root partition takes ~96% of the bar', w['/dev/nvme0n1p2'] / barW);
  check(await page.evaluate(`!!document.querySelector('${WIN} .dk-syshint') && !document.querySelector('${WIN} .dk-eject') && !document.querySelector('${WIN} .dk-format')`), 'system disk: hint, no Eject / Format');
  check(await page.evaluate(`document.querySelector('${WIN} .dk-info')?.innerText.includes('GPT')`), 'drive details show the partition table');
  // segment keyboard
  await page.locator(`${WIN} .dk-seg.selected`).focus();
  await page.keyboard.press('ArrowRight');
  check(await until(page, `document.querySelector('${WIN} .dk-seg.selected')?.dataset.path === '/dev/nvme0n1p2' && document.activeElement?.dataset.path === '/dev/nvme0n1p2'`), 'ArrowRight moves to the next partition');
  check(await page.evaluate(`!document.querySelector('${WIN} .dk-unmount') && document.querySelector('${WIN} .dk-part').innerText.includes('Aurora')`), 'root partition: details, no Unmount button');
  await page.keyboard.press('End');
  check(await until(page, `document.querySelector('${WIN} .dk-part')?.innerText.includes('Swap')`), 'End selects the swap partition');
  const busy = await invoke(page, 'disks:unmount', '/dev/nvme0n1p2');
  check(busy.error?.code === 'EBUSY', 'backend refuses to unmount /', busy);
  const bad = await invoke(page, 'disks:mount', '/dev/../etc/passwd');
  check(bad.error?.code === 'EINVAL', 'backend rejects a bad device path', bad);
  const sysEject = await invoke(page, 'disks:powerOff', '/dev/nvme0n1');
  check(!!sysEject.error, 'backend refuses to eject the system disk', sysEject);
  const fmtSys = await invoke(page, 'admin:run', 'pw', 'format-removable', ['/dev/nvme0n1', 'vfat', 'X']);
  check(fmtSys.error?.code === 'EINVAL', 'admin:run refuses format-removable on an NVMe disk', fmtSys);
  const fmtPart = await invoke(page, 'admin:run', 'pw', 'format-removable', ['/dev/sdb1', 'vfat', 'X']);
  check(fmtPart.error?.code === 'EINVAL', 'admin:run refuses a partition', fmtPart);
  const fmtFs = await invoke(page, 'admin:run', 'pw', 'format-removable', ['/dev/sdb', 'ntfs', 'X']);
  check(fmtFs.error?.code === 'EINVAL', 'admin:run refuses an unknown file system', fmtFs);
  const fmtLab = await invoke(page, 'admin:run', 'pw', 'format-removable', ['/dev/sdb', 'vfat', 'a;rm -rf']);
  check(fmtLab.error?.code === 'EINVAL', 'admin:run refuses a label with shell characters', fmtLab);

  // mount / unmount the USB partition
  await page.locator(`${WIN} .dk-drive[data-path="/dev/sdb"]`).click();
  await page.locator(`${WIN} .dk-unmount`).click();
  check(await until(page, `document.querySelector('${WIN} .dk-note.success')?.innerText.includes('unmounted') && !!document.querySelector('${WIN} .dk-mount')`), 'Unmount: success note, Mount offered');
  check(await page.evaluate(`document.querySelector('${WIN} .dk-part').innerText.includes('Not mounted')`), 'partition shows Not mounted');
  await page.locator(`${WIN} .dk-mount`).click();
  check(await until(page, `document.querySelector('${WIN} .dk-note.success')?.innerText.includes('mounted at') && !!document.querySelector('${WIN} .dk-unmount')`), 'Mount: success note, Unmount offered');

  // format: typed-name confirmation, cancel at the UAC prompt
  await page.locator(`${WIN} .dk-format`).click();
  await page.waitForSelector('.dk-format-dialog');
  check(await page.evaluate(`document.querySelector('.dk-format-dialog .dk-format-go')?.disabled === true`), 'Format button disabled until the name is typed');
  check(await page.evaluate(`document.querySelector('.dk-format-dialog').innerText.includes('erases everything on SanDisk Ultra')`), 'format dialog warns about erasing');
  await page.locator('.dk-format-dialog .dk-confirm').fill('SanDisk');
  check(await until(page, `document.querySelector('.dk-format-dialog .dk-format-go').disabled && document.querySelector('.dk-format-dialog .dk-format-err').textContent.includes("doesn't match")`), 'wrong name: still disabled + mismatch hint');
  await page.keyboard.press('Enter');
  check(await page.evaluate(`!!document.querySelector('.dk-format-dialog')`), 'Enter does not format with a wrong name');
  await page.locator('.dk-format-dialog .dk-confirm').fill('SanDisk Ultra');
  await page.locator('.dk-format-dialog .dk-label').fill('MY;STICK');
  check(await until(page, `document.querySelector('.dk-format-dialog .dk-format-go').disabled && document.querySelector('.dk-format-dialog .dk-format-err').textContent.includes('letters')`), 'invalid label blocks formatting');
  await page.locator('.dk-format-dialog .dk-label').fill('TWELVE CHARS');
  await page.locator('.dk-format-dialog .dk-fs').selectOption('vfat');
  check(await until(page, `document.querySelector('.dk-format-dialog .dk-format-go').disabled && document.querySelector('.dk-format-dialog .dk-format-err').textContent.includes('11')`), 'FAT label limited to 11 characters');
  await page.locator('.dk-format-dialog .dk-fs').selectOption('ext4');
  await page.locator('.dk-format-dialog .dk-label').fill('Backup');
  check(await until(page, `document.querySelector('.dk-format-dialog .dk-format-go').disabled === false`), 'right name + valid label enables Format');
  await page.locator('.dk-format-dialog .dk-format-go').click();
  await page.waitForSelector('.uac-dialog', { timeout: 8000 });
  check(await page.evaluate(`document.querySelector('.uac-dialog').innerText.includes('Disks wants to erase and format SanDisk Ultra')`), 'elevation prompt explains the format');
  await page.locator('.uac-dialog .dialog-footer .btn:not(.primary)').click();
  await page.waitForSelector('.uac-dialog', { state: 'detached', timeout: 8000 }).catch(() => {});
  check(await until(page, `!document.querySelector('${WIN} .dk-busy') && !!document.querySelector('${WIN} .dk-format')`), 'cancel at the elevation prompt: back to normal');
  check(await page.evaluate(`!document.querySelector('${WIN} .dk-note.error') && document.querySelector('${WIN} .dk-seg')?.title.includes('FAT32')`), 'cancel: no error, drive untouched');

  // format for real (simulated)
  await page.locator(`${WIN} .dk-format`).click();
  await page.waitForSelector('.dk-format-dialog');
  await page.locator('.dk-format-dialog .dk-fs').selectOption('ext4');
  await page.locator('.dk-format-dialog .dk-label').fill('Backup');
  await page.locator('.dk-format-dialog .dk-confirm').fill('SanDisk Ultra');
  await page.locator('.dk-format-dialog .dk-format-go').click();
  await page.waitForSelector('.uac-dialog', { timeout: 8000 });
  const pw = page.locator('.uac-dialog input[type=password]');
  if (await pw.count()) await pw.fill('aurora');
  await page.locator('.uac-dialog .dialog-footer .btn.primary').click();
  check(await until(page, `!!document.querySelector('${WIN} .dk-busy')`, 4000), 'formatting shows a busy indicator');
  check(await until(page, `document.querySelector('${WIN} .dk-note.success')?.innerText.includes('was formatted')`, 12000), 'format succeeds with a success note');
  check(await until(page, `/Backup/.test(document.querySelector('${WIN} .dk-part')?.innerText || '') && /ext4/.test(document.querySelector('${WIN} .dk-part')?.innerText || '')`), 'new ext4 partition labelled Backup shown');
  check(await page.evaluate(`document.querySelector('${WIN} .dk-info').innerText.includes('MBR')`), 'partition table is now MBR (msdos)');

  // change events: reset the mock from the backend → the window refreshes by itself
  await invoke(page, 'disks:devReset');
  check(await until(page, `/USB STICK/.test(document.querySelector('${WIN} .dk-part')?.innerText || '')`), 'disks:changed refreshes the window');

  // refresh button + F5
  await page.locator(`${WIN} .dk-refresh`).click();
  check(await until(page, `document.querySelectorAll('${WIN} .dk-drive').length === 2`), 'Refresh keeps the list');

  // eject
  await page.locator(`${WIN} .dk-eject`).click();
  check(await until(page, `document.querySelectorAll('${WIN} .dk-drive').length === 1 && document.querySelector('${WIN} .dk-drive.selected')?.dataset.path === '/dev/nvme0n1'`), 'Eject removes the stick and selects the system disk');
  await invoke(page, 'disks:devReset');
  check(await until(page, `document.querySelectorAll('${WIN} .dk-drive').length === 2`), 'stick back after reset (plug-in event)');
  check(await page.evaluate(`!document.querySelector('${WIN}').innerText.match(/\\bnull\\b|\\bundefined\\b|\\{\\w+\\}/)`), 'no null / undefined / raw placeholders in the window');

  // narrow window: no horizontal overflow
  await page.evaluate(`(() => { const wm = window.__aurora?.wm; const w = wm && [].concat(wm.byApp?.('disks') || [])[0]; w?.setSize?.(600, 480); })()`);
  await sleep(300);
  check(await page.evaluate(`(() => { const m = document.querySelector('${WIN} .dk-main'); return m.scrollWidth <= m.clientWidth + 1; })()`), 'no horizontal overflow at a narrow size');
} catch (e) {
  failures.push(`EN run threw: ${e?.stack || e}`);
  console.log(e);
}
await s.close();

// ---------------------------------------------------------------- 4. French + dark
s = await launchShell({ open: ['disks'], lang: 'fr', theme: 'dark' });
s.page.on('pageerror', (e) => errors.push(e.message));
try {
  const { page } = s;
  check(await until(page, `document.querySelectorAll('${WIN} .dk-drive').length === 2`, 15000), 'FR: drives listed');
  const txt = await page.evaluate(`document.querySelector('${WIN}').innerText`);
  check(txt.includes('Lecteurs') && txt.includes('Éjecter') && txt.includes('Formater') && txt.includes('Non disponible'), 'FR: strings translated');
  check(/30,8 Go/.test(txt), 'FR: sizes use Go and a decimal comma', (txt.match(/[\d,]+ Go/g) || []).slice(0, 3));
  check(await page.evaluate(`document.documentElement.dataset.theme === 'dark'`), 'dark theme active');
  const bg = await page.evaluate(`getComputedStyle(document.querySelector('${WIN} .dk-seg')).backgroundColor`);
  const lum = (bg.match(/\d+(\.\d+)?/g) || []).slice(0, 3).map(Number).reduce((a, b) => a + b, 0) / 3;
  check(lum < 128, 'dark theme: partition segment is dark', bg);
  await page.locator(`${WIN} .dk-format`).click();
  await page.waitForSelector('.dk-format-dialog');
  check(await page.evaluate(`document.querySelector('.dk-format-dialog').innerText.includes('tapez le nom du lecteur')`), 'FR: format confirmation translated');
  await page.keyboard.press('Escape');
  await sleep(250);
  await s.shot('disks-dark-fr');
  fs.copyFileSync(path.join(ROOT, 'test', 'out', 'disks-dark-fr.png'), path.join(DOCS, 'disks-dark-fr.png'));
} catch (e) {
  failures.push(`FR run threw: ${e?.stack || e}`);
  console.log(e);
}
await s.close();

const relevant = errors.filter((e) => !/favicon|DevTools|Autofill/i.test(e));
check(relevant.length === 0, 'no renderer errors', relevant.slice(0, 5));

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
