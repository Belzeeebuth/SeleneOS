// Robustness (track "robust"): main/lib/robust.js, main/ipc/robust.js, main/ipc/settings.js (backup / restore,
// ENOSPC-safe writes, safe-mode look), core/features/robust.js (banner + notices), aurora-xsession (safe mode after
// 2 crashes), earlyoom options, installer low-RAM warning, Paramètres > À propos « Créer un rapport de diagnostic ».
//   1. unit: settings backup / restore, ENOSPC, low disk rule, report scrubbing, app name of a renderer error,
//      earlyoom regexes, aurora-xsession crash loop with a fake shell
//   2. Electron (dev): hang -> restart, crash while locked -> back LOCKED, 3 crashes -> safe mode banner, « Redémarrer
//      normalement », renderer errors in the journal (stderr), corrupt settings.json restored + told once,
//      AURORA_SAFE_MODE=1 launch, low disk notification, diagnostic report, installer under 4 GB
//   screenshots 1280x720 FR, Halo dark + light -> test/out/robust-*.png
// Usage:  cd aurora-os/shell && xvfb-run -a -s "-screen 0 1600x900x24" node test/robust.test.mjs [--unit]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { launchShell, ROOT } from './lib.mjs';

const require = createRequire(import.meta.url);
const REPO = path.join(ROOT, '..');
const ARGS = new Set(process.argv.slice(2));
let passed = 0;
const failures = [];
function check(name, actual, expected = true) {
  const ok = typeof expected === 'function' ? !!expected(actual) : Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else failures.push(`${name}\n      expected: ${typeof expected === 'function' ? '(predicate)' : JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}`);
  return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    // each probe is bounded: a busy / crashed renderer never answers executeJavaScript
    const v = await Promise.race([fn().catch(() => null), sleep(2000).then(() => null)]);
    if (v) return v;
    await sleep(100);
  }
  return null;
}
const tmpdir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

// ===================================================================== 1. unit
console.log('\n# settings.json backup / restore, ENOSPC');
{
  const S = require(path.join(ROOT, 'main', 'ipc', 'settings.js'));
  const d = tmpdir('aurora-robust-');
  const f = path.join(d, 'settings.json');
  fs.writeFileSync(f, JSON.stringify({ theme: 'light', accent: '#123456' }));
  let r = S.loadUserSettings(f);
  check('valid file: loaded, no recovery', [r.user.theme, r.recovered], ['light', null]);
  check('valid file: last-good backup written', JSON.parse(fs.readFileSync(`${f}.last-good`, 'utf8')).accent, '#123456');
  fs.writeFileSync(f, '{ "theme": "dark", '); // truncated write
  r = S.loadUserSettings(f);
  check('corrupt file: restored from the backup', [r.user.theme, r.user.accent, r.recovered], ['light', '#123456', 'backup']);
  check('corrupt file: kept as settings.json.corrupt, settings.json valid again', [fs.readFileSync(`${f}.corrupt`, 'utf8'), JSON.parse(fs.readFileSync(f, 'utf8')).theme], ['{ "theme": "dark", ', 'light']);
  fs.writeFileSync(f, '');
  fs.writeFileSync(`${f}.last-good`, 'nope');
  r = S.loadUserSettings(f);
  check('empty file + bad backup: defaults', [r.user, r.recovered], [{}, 'defaults']);
  check('missing file: defaults, no notice', S.loadUserSettings(path.join(d, 'none.json')), { user: {}, recovered: null });

  // ENOSPC: the temp file is written partly then the disk is full -> temp removed, old file intact, error thrown.
  fs.writeFileSync(f, JSON.stringify({ theme: 'light' }));
  const real = fs.writeFileSync;
  fs.writeFileSync = (file, data, ...rest) => {
    if (String(file).endsWith('.tmp')) {
      real(file, String(data).slice(0, 5));
      const e = new Error('ENOSPC: no space left on device, write');
      e.code = 'ENOSPC';
      throw e;
    }
    return real(file, data, ...rest);
  };
  let code = null;
  try {
    S.writeJsonAtomic(f, { theme: 'dark', big: 'x'.repeat(1000) });
  } catch (err) {
    code = err.code;
  } finally {
    fs.writeFileSync = real;
  }
  check('ENOSPC: error reported', code, 'ENOSPC');
  check('ENOSPC: old settings.json kept', JSON.parse(fs.readFileSync(f, 'utf8')), { theme: 'light' });
  check('ENOSPC: no temp file left', fs.readdirSync(d).filter((x) => x.endsWith('.tmp')), []);
  const look = S.safeLook(S.DEFAULTS);
  check('safe look: Sobre, Nocturne, default wallpaper, static, no packs', [look.finish, look.style, look.wallpaper, look.wallpaperMode, look.iconPack, look.cursorPack, look.autoTheme.enabled], ['sobre', 'nocturne', 'builtin:nocturne', 'static', 'auto', 'default', false]);
  check('safe look keys never include theme / lang / scale', ['theme', 'lang', 'scale', 'textScale'].some((k) => S.SAFE_LOOK_KEYS.includes(k)), false);
  fs.rmSync(d, { recursive: true, force: true });
}

console.log('\n# low disk rule, report scrubbing, renderer error source');
{
  const R = require(path.join(ROOT, 'main', 'ipc', 'robust.js'));
  const GB = 1024 ** 3;
  check('low disk: 0.5 GB free of 100 GB', R.isLowDisk({ avail: 0.5 * GB, total: 100 * GB }), true);
  check('low disk: 4 GB free of 100 GB (4 %)', R.isLowDisk({ avail: 4 * GB, total: 100 * GB }), true);
  check('not low: 20 GB free of 100 GB', R.isLowDisk({ avail: 20 * GB, total: 100 * GB }), false);
  check('not low: bad numbers', R.isLowDisk({ avail: NaN, total: 0 }), false);
  const scrubbed = R.scrub({ theme: 'dark', mail: { password: 'x', token: 'y' }, weather: { location: { lat: 1, lon: 2 } }, translate: true, accent: '#fff' });
  check('report settings: secrets and places removed, the rest kept', scrubbed, { theme: 'dark', mail: { password: '(removed)', token: '(removed)' }, weather: { location: '(removed)' }, translate: true, accent: '#fff' });
  check('report notice lists every file', ['README.txt', 'versions.txt', 'journal.txt', 'settings.json', 'lsusb.txt', 'lspci.txt'].every((x) => R.REPORT_NOTICE.includes(x)), true);
  const L = require(path.join(ROOT, 'main', 'lib', 'robust.js'));
  check('renderer error source -> app name', [L.appOfSource('app://shell/apps/calculator/main.js'), L.appOfSource('app://shell/core/boot.js'), L.appOfSource('')], ['calculator', 'shell', 'shell']);
}

console.log('\n# earlyoom options');
{
  const txt = fs.readFileSync(path.join(REPO, 'rootfs', 'etc', 'default', 'aurora-earlyoom'), 'utf8');
  const args = /^EARLYOOM_ARGS="(.*)"$/m.exec(txt)?.[1] || '';
  check('no quotes inside EARLYOOM_ARGS (systemd passes them literally)', /['"]/.test(args), false);
  const words = args.split(/\s+/);
  const avoid = new RegExp(words[words.indexOf('--avoid') + 1]);
  const prefer = new RegExp(words[words.indexOf('--prefer') + 1]);
  check('avoid: Xorg, electron (shell + greeter), greetd, aurora-xwm, systemd-logind', ['Xorg', 'electron', 'greetd', 'aurora-xwm', 'systemd-logind'].every((n) => avoid.test(n)), true);
  check('avoid: not chromium / steam / python3', ['chromium', 'steam', 'python3'].some((n) => avoid.test(n)), false);
  check('prefer: browsers, steam, wine', ['chromium', 'firefox', 'steam', 'wine64-preloader'].every((n) => prefer.test(n)), true);
  check('drop-in reads it after the Ubuntu file', fs.readFileSync(path.join(REPO, 'rootfs', 'etc', 'systemd', 'system', 'earlyoom.service.d', 'aurora.conf'), 'utf8').includes('EnvironmentFile=-/etc/default/aurora-earlyoom'), true);
  check('robust.list installs earlyoom', /^earlyoom$/m.test(fs.readFileSync(path.join(REPO, 'iso', 'packages.d', 'robust.list'), 'utf8')), true);
}

console.log('\n# aurora-xsession: safe mode after 2 crashes in a row');
{
  const d = tmpdir('aurora-xs-');
  const common = path.join(d, 'common');
  fs.writeFileSync(common, `aurora_log() { printf 'aurora: %s\\n' "$*" >&2; }\naurora_x_setup() { :; }\naurora_cmdline() { return 1; }\naurora_gpu_mode() { echo off; }\n`);
  const fake = path.join(d, 'shell');
  fs.writeFileSync(fake, `#!/bin/sh\necho "run safe=\${AURORA_SAFE_MODE:-}" >>"${d}/runs"\nn=$(wc -l <"${d}/runs")\n[ -f "${d}/ok-at-$n" ] && exit 0\nexit 3\n`, { mode: 0o755 });
  const env = { ...process.env, AURORA_COMMON: common, AURORA_SHELL_BIN: fake, PATH: process.env.PATH };
  delete env.AURORA_SAFE_MODE;
  const xs = path.join(REPO, 'rootfs', 'usr', 'lib', 'aurora', 'aurora-xsession');
  let r = spawnSync('sh', [xs], { env, encoding: 'utf8', timeout: 20000 });
  const runs = fs.readFileSync(path.join(d, 'runs'), 'utf8').trim().split('\n');
  check('3 failing starts: normal, normal, then safe mode; session ends with the shell status', [runs, r.status], [['run safe=', 'run safe=', 'run safe=1'], 3]);
  check('safe mode logged', /starting the shell in safe mode/.test(r.stderr), true);
  fs.rmSync(path.join(d, 'runs'));
  fs.writeFileSync(path.join(d, 'ok-at-3'), '');
  r = spawnSync('sh', [xs], { env, encoding: 'utf8', timeout: 20000 });
  check('safe-mode shell signs out normally -> session ends with 0', [fs.readFileSync(path.join(d, 'runs'), 'utf8').trim().split('\n').at(-1), r.status], ['run safe=1', 0]);
  fs.rmSync(d, { recursive: true, force: true });
}

if (ARGS.has('--unit')) finish();

// ===================================================================== 2. Electron
const wcEval = (s, code) =>
  s.app.evaluate(({ BrowserWindow }, js) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('shell.html'));
    return w.webContents.executeJavaScript(js, true);
  }, code);
const mainDo = (s, what) =>
  s.app.evaluate(({ BrowserWindow }, op) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('shell.html'));
    if (op === 'crash') w.webContents.forcefullyCrashRenderer();
    else w.webContents.emit(op);
    return true;
  }, what);
const ready = (s) => until(() => wcEval(s, `document.body.classList.contains('ready') && !window.__robustMarker`), 30000);

console.log('\n# crash / hang recovery, lock kept, safe mode (FR, Halo dark)');
{
  const s = await launchShell({ lang: 'fr', theme: 'dark', size: '1280x720', settings: { finish: 'halo', iconPack: 'prisme' }, env: { AURORA_UNRESPONSIVE_GRACE: '1500' } });
  let err = '';
  s.app.process().stderr.on('data', (b) => (err += b));
  try {
    // Hang: 'unresponsive' then 'responsive' within the grace -> nothing happens.
    await wcEval(s, 'window.__robustMarker = 1');
    await mainDo(s, 'unresponsive');
    await sleep(300);
    await mainDo(s, 'responsive');
    await sleep(1800);
    check('hang: responsive again within the grace -> no restart', await wcEval(s, 'window.__robustMarker'), 1);
    // Hang for real: a busy renderer, 'unresponsive', no 'responsive' -> killed and reloaded after the grace.
    await wcEval(s, 'setTimeout(() => { for (;;) {} }, 100); 1');
    await sleep(300);
    await mainDo(s, 'unresponsive');
    check('hang: renderer restarted after the grace', !!(await ready(s)), true);
    check('hang: logged', /still unresponsive: restarting it/.test(err), true);

    // Crash while locked -> back LOCKED (never unlocked by a crash).
    await wcEval(s, 'window.__aurora.lockScreen.lock(), 1');
    await until(() => wcEval(s, 'window.__aurora.lockScreen.locked'));
    await wcEval(s, 'window.__robustMarker = 1');
    await mainDo(s, 'crash');
    check('crash: renderer reloaded', !!(await ready(s)), true);
    check('crash while locked: the reloaded shell is locked', !!(await until(() => wcEval(s, 'window.__aurora.lockScreen?.locked === true && document.body.classList.contains("aurora-locked")'))), true);
    check('crash: logged with the reason', /\[robust\] shell renderer gone \(crashed|killed/.test(err), true);

    // Renderer errors reach stderr (= the session journal through systemd-cat).
    await wcEval(s, "setTimeout(() => { throw new Error('robust-test-uncaught') }, 0); Promise.reject(new Error('robust-test-rejection')); console.error('robust-test-console'); 1");
    await until(async () => /robust-test-rejection/.test(err) && /robust-test-uncaught/.test(err), 5000);
    check('renderer errors logged: uncaught, unhandled rejection, console.error, with the app name', ['robust-test-uncaught', 'robust-test-rejection', 'robust-test-console'].every((m) => new RegExp(`\\[renderer:shell\\] .*${m}`).test(err)), true);

    // Third crash within 2 minutes -> safe mode (unlock first so the banner shows).
    await wcEval(s, "window.__aurora.api.invoke('auth:setLocked', false)");
    await wcEval(s, 'window.__robustMarker = 1');
    await mainDo(s, 'crash');
    await ready(s);
    const st = await until(() => wcEval(s, "window.__aurora.api.invoke('robust:status')"));
    check('3 crashes within 2 minutes -> safe mode', [st?.safeMode, st?.safeReason], [true, 'renderer-crashes']);
    check('safe mode banner', await until(() => wcEval(s, "document.querySelector('.safe-banner')?.innerText")), (t) => /Selene a démarré en mode sans échec/.test(t) && /Réinitialiser l’apparence/.test(t) && /Redémarrer normalement/.test(t));
    check('safe mode: Sobre finish, default wallpaper, packs off (user file untouched)', await wcEval(s, "[window.__aurora.settings.get('finish'), window.__aurora.settings.get('wallpaper'), window.__aurora.settings.get('iconPack'), document.documentElement.dataset.finish]"), ['sobre', 'builtin:nocturne', 'auto', 'sobre']);
    check('safe mode: settings.json keeps the user look', JSON.parse(fs.readFileSync(path.join(s.home, '.config/aurora/settings.json'), 'utf8')).iconPack, 'prisme');
    await sleep(600);
    await s.shot('robust-safemode-fr-dark');
    // « Réinitialiser l'apparence » resets the look keys; « Redémarrer normalement » leaves safe mode.
    await s.page.locator('.safe-banner button', { hasText: 'Réinitialiser' }).click();
    await until(async () => !('iconPack' in JSON.parse(fs.readFileSync(path.join(s.home, '.config/aurora/settings.json'), 'utf8'))), 5000);
    const after = JSON.parse(fs.readFileSync(path.join(s.home, '.config/aurora/settings.json'), 'utf8'));
    check('« Réinitialiser l’apparence »: look keys removed, theme / lang kept', [after.iconPack, after.finish, after.theme, after.lang], [undefined, undefined, 'dark', 'fr']);
    await wcEval(s, 'window.__robustMarker = 1');
    await s.page.locator('.safe-banner button', { hasText: 'Redémarrer normalement' }).click();
    await ready(s);
    const st2 = await until(() => wcEval(s, "window.__aurora.api.invoke('robust:status')"));
    check('« Redémarrer normalement »: safe mode off, no banner, Halo again', [st2?.safeMode, await wcEval(s, "!!document.querySelector('.safe-banner')"), await wcEval(s, "window.__aurora.settings.get('finish')")], [false, false, 'halo']);
  } finally {
    await s.close();
  }
}

console.log('\n# corrupt settings.json restored and told once');
{
  const home = tmpdir('aurora-home-');
  const dir = path.join(home, '.config', 'aurora');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), '{"theme": "light", "lang": "fr", ');
  fs.writeFileSync(path.join(dir, 'settings.json.last-good'), JSON.stringify({ theme: 'light', lang: 'fr', accent: '#a58bf2' }));
  const s = await launchShell({ home, size: '1280x720' });
  try {
    const toast = await until(() => s.page.evaluate(() => [...document.querySelectorAll('#toasts .toast:not(.leaving)')].map((t) => t.innerText).join('\n')).then((t) => (/Vos réglages ont été restaurés/.test(t) ? t : null)));
    check('notification « Vos réglages ont été restaurés » (FR from the restored file)', !!toast && /dernière copie valide/.test(toast), true);
    check('restored values in use', await s.aurora(() => [window.__aurora.settings.get('theme'), window.__aurora.settings.get('accent')]), ['light', '#a58bf2']);
    check('settings.json valid again, the damaged copy kept', [JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).accent, fs.existsSync(path.join(dir, 'settings.json.corrupt'))], ['#a58bf2', true]);
    await wcEval(s, 'window.__robustMarker = 1');
    await mainDo(s, 'crash');
    await ready(s);
    await sleep(2500);
    check('told once: no second notice after a reload', await s.page.evaluate(() => [...document.querySelectorAll('#toasts .toast')].some((t) => /Vos réglages ont été restaurés/.test(t.innerText))), false);
  } finally {
    await s.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

console.log('\n# AURORA_SAFE_MODE=1 launch (Halo light), low disk, diagnostic report, installer under 4 GB');
{
  const s = await launchShell({
    lang: 'fr',
    theme: 'light',
    size: '1280x720',
    settings: { finish: 'prisme', wallpaperMode: 'animated', cursorPack: 'retro' },
    env: { AURORA_SAFE_MODE: '1', AURORA_FAKE_DISK: `${600 * 1024 ** 2},${64 * 1024 ** 3}`, AURORA_FAKE_RAM: String(2 * 1024 ** 3) },
  });
  try {
    check('safe mode from the session: banner', !!(await until(() => wcEval(s, "!!document.querySelector('.safe-banner')"))), true);
    check('safe mode: Prisme / animated wallpaper / cursor pack ignored', await s.aurora(() => ['finish', 'wallpaperMode', 'cursorPack', 'theme'].map((k) => window.__aurora.settings.get(k))), ['sobre', 'static', 'default', 'light']);
    const toast = await until(() => s.page.evaluate(() => [...document.querySelectorAll('#toasts .toast:not(.leaving)')].map((t) => t.innerText).join('\n')).then((t) => (/Espace disque faible/.test(t) ? t : null)));
    check('low disk notification (600 Mo of 64 Go)', !!toast && /600 Mo/.test(toast) && /Ouvrir Stockage/.test(toast), true);
    await sleep(400);
    await s.shot('robust-safemode-fr-light');
    await s.aurora(() => window.__aurora.notifications?.clear?.());

    // Paramètres > À propos > Créer un rapport de diagnostic
    await s.aurora(() => window.__aurora.shell.launch('settings', { page: 'about' }));
    const btn = s.page.locator('.st-diag-row button', { hasText: 'Créer un rapport de diagnostic' });
    await btn.waitFor({ timeout: 15000 });
    check('À propos: the notice says what is inside', await s.page.locator('.st-diag-row').innerText(), (t) => /journal/.test(t) && /sans mots de passe/.test(t) && /USB et PCI/.test(t));
    await btn.scrollIntoViewIfNeeded();
    await btn.click();
    const res = await until(() => s.page.locator('.st-diag-result').innerText().then((t) => (/Rapport enregistré/.test(t) ? t : null)), 60000);
    check('report created message', res, (t) => /selene-diagnostic-.*\.tar\.gz/.test(t || ''));
    const tgz = fs.readdirSync(s.home).find((f) => /^selene-diagnostic-.*\.tar\.gz$/.test(f));
    const list = tgz ? spawnSync('tar', ['-tzf', path.join(s.home, tgz)], { encoding: 'utf8' }).stdout : '';
    check('~/selene-diagnostic-*.tar.gz holds README, versions, journal, settings, lsusb, lspci', ['README.txt', 'versions.txt', 'journal.txt', 'settings.json', 'lsusb.txt', 'lspci.txt'].every((f) => list.includes(`/${f}`)), true);
    if (tgz) {
      const x = tmpdir('aurora-diag-x-');
      spawnSync('tar', ['-xzf', path.join(s.home, tgz), '-C', x]);
      const sub = fs.readdirSync(x)[0];
      const ver = fs.readFileSync(path.join(x, sub, 'versions.txt'), 'utf8');
      check('versions.txt: Selene, Electron, safe mode noted', /Selene shell/.test(ver) && /Electron \d/.test(ver) && /SAFE MODE/.test(ver), true);
      check('settings.json in the report is the user file', JSON.parse(fs.readFileSync(path.join(x, sub, 'settings.json'), 'utf8')).finish, 'prisme');
      fs.rmSync(x, { recursive: true, force: true });
    }
    await sleep(300);
    await s.shot('robust-diagnostic-fr-light');

    // Installer: under 4 GB of RAM -> a warning on the first step, Next still enabled.
    await s.aurora(() => window.__aurora.shell.launch('installer'));
    const warnEl = s.page.locator('.ins-lowram');
    await warnEl.waitFor({ timeout: 15000 }).catch(() => {});
    check('installer: low RAM warning (2,0 Go), not blocking', (await warnEl.count()) ? await warnEl.innerText() : '', (t) => /2,0 Go/.test(t) && /4 Go ou plus/.test(t));
    await sleep(300);
    await s.shot('robust-installer-lowram-fr-light');
  } finally {
    await s.close();
  }
}

console.log('\n# diagnostic page in Halo dark');
{
  const s = await launchShell({ lang: 'fr', theme: 'dark', size: '1280x720' });
  try {
    await s.aurora(() => window.__aurora.shell.launch('settings', { page: 'about' }));
    await s.page.locator('.st-diag-row').waitFor({ timeout: 15000 });
    await s.page.locator('.st-diag-row').scrollIntoViewIfNeeded();
    await sleep(500);
    await s.shot('robust-diagnostic-fr-dark');
    check('no safe-mode banner in a normal session', await s.page.locator('.safe-banner').count(), 0);
  } finally {
    await s.close();
  }
}

finish();

function finish() {
  console.log(`\n${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log(`  FAIL ${f}`);
  process.exit(failures.length ? 1 : 0);
}
