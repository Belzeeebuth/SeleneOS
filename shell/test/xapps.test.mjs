// Linux applications (.desktop entries, main/ipc/xapps.js): Desktop Entry parsing (groups, escapes, localized keys,
// filters), Exec field codes and quoting, icon theme lookup, xapps:list / xapps:launch / xapps:match / xapps:changed,
// GTK settings.ini theme sync, the registry merge (Start "All apps", search, launch from Start) and the Store's
// graphical apps (French strings, simulated install, Open). Fixtures: test/fixtures/xapps (AURORA_XAPPS_DIRS).
// Usage:  cd aurora-os/shell && xvfb-run -a -s "-screen 0 1600x900x24" node test/xapps.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { launchShell, ROOT } from './lib.mjs';

const require = createRequire(import.meta.url);
const FIX = path.join(ROOT, 'test', 'fixtures', 'xapps');
const APPS = path.join(FIX, 'share', 'applications');

let passed = 0;
const failures = [];
function check(name, actual, expected) {
  const ok = typeof expected === 'function' ? !!expected(actual) : Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else failures.push(`${name}\n      expected: ${typeof expected === 'function' ? '(predicate)' : JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
  return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, { timeout = 10000, every = 100 } = {}) {
  const end = Date.now() + timeout;
  let v;
  while (Date.now() < end) {
    v = await fn().catch(() => null);
    if (v) return v;
    await sleep(every);
  }
  return v;
}

// ------------------------------------------------------------------ pure parsers (no Electron)
const { parsers: P } = require(path.join(ROOT, 'main', 'ipc', 'xapps.js'));
{
  const g = P.parseDesktop(fs.readFileSync(path.join(APPS, 'org.selene.Fixture.desktop'), 'utf8'));
  check('parse: groups', Object.keys(g), ['Desktop Entry', 'Desktop Action new']);
  const e = g['Desktop Entry'];
  check('localized: fr_FR wins over fr', P.localized(e, 'Name', 'fr'), 'Peinture test');
  check('localized: en falls back to the plain key', P.localized(e, 'Name', 'en'), 'Fixture Paint');
  check('localized: missing fr falls back to the plain key', P.localized(e, 'Comment', 'xx'), 'Draw\\spictures\\nwith a fixture');
  check('escapes: \\s \\n \\t \\\\', P.unescapeValue('a\\sb\\nc\\td\\\\e'), 'a b\nc\td\\e');
  check('lists: ; separators, \\; escape, trailing ;', P.splitList(e.Keywords), ['draw', 'sketch', 'semi;colon']);
  check('Exec quoting: \\\\" and \\\\$ inside quotes', P.splitExec(e.Exec).slice(0, 3), ['selene-fixture-record', '--title', 'Fixture "Paint" $HOME']);
  check('Exec quoting: empty quoted argument kept', P.splitExec('a "" b'), ['a', '', 'b']);
  let threw = null;
  try {
    P.splitExec('a "unterminated');
  } catch (err) {
    threw = err.code;
  }
  check('Exec quoting: unterminated quote rejected', threw, 'ENOEXEC');
  const app = { exec: e.Exec, icon: 'selene-fixture', name: 'Fixture Paint', file: '/x/org.selene.Fixture.desktop' };
  check('field codes: %F files, %% literal, %c name, %d dropped', P.buildArgv(app, { files: ['/tmp/a b.png', '/tmp/c.png'] }), [
    ['selene-fixture-record', '--title', 'Fixture "Paint" $HOME', '/tmp/a b.png', '/tmp/c.png', '--pct=100%', 'Fixture Paint'],
  ]);
  check('field codes: no file -> %F expands to nothing', P.buildArgv(app, {})[0].length, 5);
  check('field codes: %f with two files -> one launch per file', P.buildArgv({ exec: 'prog %f' }, { files: ['/a', '/b'] }), [
    ['prog', '/a'],
    ['prog', '/b'],
  ]);
  check('field codes: %U turns paths into file:// URLs', P.buildArgv({ exec: 'prog %U' }, { files: ['/tmp/a b'], urls: ['https://example.org/'] }), [['prog', 'file:///tmp/a%20b', 'https://example.org/']]);
  check('field codes: %f turns a file:// URL into a path, drops other URLs', P.buildArgv({ exec: 'prog %F' }, { urls: ['file:///tmp/x%20y', 'https://e.org/'] }), [['prog', '/tmp/x y']]);
  check('field codes: %i %k', P.buildArgv({ exec: 'prog %i --from=%k', icon: 'ic', file: '/d/p.desktop' }), [['prog', '--icon', 'ic', '--from=/d/p.desktop']]);
  check('field codes: %i without Icon disappears', P.buildArgv({ exec: 'prog %i x' }), [['prog', 'x']]);
  check('appIdOf: sanitized + linux. prefix', P.appIdOf('org.gnome.Foo Bar+1'), 'linux.org.gnome.Foo_Bar_1');
  check('appIdOf: at most 64 characters', P.appIdOf('x'.repeat(100)).length, 64);
  check('settings.ini: key added to [Settings]', P.setIniDark('[Settings]\ngtk-theme-name=Yaru\n', true), '[Settings]\ngtk-application-prefer-dark-theme=1\ngtk-theme-name=Yaru\n');
  check('settings.ini: key replaced, other groups kept', P.setIniDark('[Other]\na=1\n[Settings]\ngtk-application-prefer-dark-theme=1\n', false), '[Other]\na=1\n[Settings]\ngtk-application-prefer-dark-theme=0\n');
  check('settings.ini: empty file', P.setIniDark('', true), '[Settings]\ngtk-application-prefer-dark-theme=1\n');
  const entry = (text) => P.toEntry(P.parseDesktop(text), { desktopId: 'x', envPath: '' });
  check('filter: Type=Application only', entry('[Desktop Entry]\nType=Link\nName=a\nExec=a\n'), null);
  check('filter: NotShowIn=X-Selene', entry('[Desktop Entry]\nType=Application\nName=a\nExec=a\nNotShowIn=X-Selene;\n'), null);
  check('filter: OnlyShowIn=Selene kept', entry('[Desktop Entry]\nType=Application\nName=a\nExec=a\nOnlyShowIn=Selene;\n')?.id, 'linux.x');
  check('filter: absolute TryExec that exists', entry('[Desktop Entry]\nType=Application\nName=a\nExec=a\nTryExec=/bin/sh\n')?.id, 'linux.x');
}

// ------------------------------------------------------------------ the shell
const extraDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xapps-extra-'));
const recDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xapps-rec-'));
const startedPids = [];
function records() {
  return fs
    .readdirSync(recDir)
    .filter((f) => f.endsWith('.args'))
    .map((f) => {
      const parts = fs.readFileSync(path.join(recDir, f), 'utf8').split('\0').slice(0, -1);
      const env = Object.fromEntries(parts.slice(0, 3).map((p) => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)]));
      return { pid: Number(f.split('.')[0]), env, argv: parts.slice(3) };
    });
}
const recordWith = (arg) => records().find((r) => r.argv.includes(arg));

const s = await launchShell({
  lang: 'fr',
  theme: 'dark',
  env: { AURORA_XAPPS_DIRS: `${APPS}:${extraDir}`, XAPPS_RECORD_DIR: recDir, PATH: `${path.join(FIX, 'bin')}:${process.env.PATH}` },
});
const { page } = s;
const A = (fn, arg) => page.evaluate(fn, arg);
const ID = 'linux.org.selene.Fixture';
try {
  // ---- xapps:list
  const list = await A(() => window.__aurora.api.invoke('xapps:list'));
  const ids = list.map((m) => m.id).sort();
  check('list: only the displayable entries', ids, ['linux.gimp', 'linux.org.selene.Fixture', 'linux.selene-only', 'linux.sub-nested']);
  const fx = list.find((m) => m.id === ID) || {};
  check('list: kind linux, desktop id', [fx.kind, fx.desktopId], ['linux', 'org.selene.Fixture']);
  check('list: localized names', fx.name, { en: 'Fixture Paint', fr: 'Peinture test' });
  check('list: description from Comment (escapes applied)', fx.description, { en: 'Draw pictures\nwith a fixture', fr: 'Dessinez des images' });
  check('list: keywords en + fr', fx.keywords, { en: ['draw', 'sketch', 'semi;colon'], fr: ['dessin', 'croquis'] });
  check('list: categories + StartupWMClass', [fx.categories, fx.startupWMClass], [['Graphics', '2DGraphics'], 'FixturePaint']);
  check('list: no private fields leak', Object.keys(fx).some((k) => k.startsWith('_')), false);
  check('icon: hicolor 48x48 PNG as media:// URL', fx.iconUrl, (u) => /^media:\/\/local\/.*\/hicolor\/48x48\/apps\/selene-fixture\.png$/.test(u));
  check('icon: scalable SVG', list.find((m) => m.id === 'linux.sub-nested')?.iconUrl, (u) => /scalable\/apps\/selene-svg\.svg$/.test(u || ''));
  check('icon: pixmaps fallback', list.find((m) => m.id === 'linux.selene-only')?.iconUrl, (u) => /share\/pixmaps\/selene-pix\.png$/.test(u || ''));
  const iconOk = await A(
    (u) =>
      new Promise((res) => {
        const img = new Image();
        img.onload = () => res(img.naturalWidth);
        img.onerror = () => res(0);
        img.src = u;
      }),
    fx.iconUrl,
  );
  check('icon: the media:// URL loads (48 px)', iconOk, 48);

  // ---- registry merge
  const reg = await A((id) => {
    const r = window.__aurora.registry;
    const m = r.get(id);
    return { kind: m?.kind, name: r.name(id), icon: r.iconUrl(id), builtIn: !!r.get('notepad'), listed: r.list().some((x) => x.id === id) };
  }, ID);
  check('registry: linux app merged after the built-in apps', [reg.kind, reg.builtIn, reg.listed], ['linux', true, true]);
  check('registry: French name + own icon', [reg.name, reg.icon], ['Peinture test', fx.iconUrl]);

  // ---- theme sync (dark at start)
  const ini3 = path.join(s.home, '.config', 'gtk-3.0', 'settings.ini');
  const ini4 = path.join(s.home, '.config', 'gtk-4.0', 'settings.ini');
  check('GTK settings.ini (3.0 + 4.0) prefer dark', [fs.readFileSync(ini3, 'utf8'), fs.readFileSync(ini4, 'utf8')].every((t) => /gtk-application-prefer-dark-theme=1/.test(t)), true);

  // ---- Start "All apps"
  await A(() => window.__aurora.shell.emit('start:open'));
  await page.waitForSelector('#start .start-head-btn', { timeout: 10000 });
  await page.locator('#start .start-head-btn').first().click();
  const row = page.locator(`#start .start-row[data-app="${ID}"]`);
  await row.waitFor({ timeout: 10000 });
  check('Start All apps: row with the French name', (await row.innerText()).trim(), 'Peinture test');
  check('Start All apps: row icon is the theme icon', await row.locator('img').getAttribute('src'), fx.iconUrl);
  await row.click();
  const rec1 = await until(async () => recordWith('--pct=100%'), { timeout: 15000 });
  check('launch from Start: the fixture program ran with the Exec argv', rec1?.argv, ['--title', 'Fixture "Paint" $HOME', '--pct=100%', 'Fixture Paint']);
  check('launch: GTK_THEME follows the dark theme', rec1?.env.GTK_THEME, 'Adwaita:dark');
  check('launch: Start closed', await A(() => !document.getElementById('start').classList.contains('open') || getComputedStyle(document.getElementById('start')).visibility === 'hidden'), true);

  // ---- search
  await A(() => window.__aurora.shell.emit('start:open'));
  await page.waitForSelector('#start .start-search', { timeout: 10000 });
  await page.locator('#start .start-search').fill('croquis');
  const hit = page.locator('#start [role=option]', { hasText: 'Peinture test' }).first();
  await hit.waitFor({ timeout: 10000 }).catch(() => {});
  check('search: French keyword finds the Linux app', await hit.count(), 1);
  check('search: result shows the app icon', await hit.locator('img').first().getAttribute('src').catch(() => null), fx.iconUrl);
  await A(() => window.__aurora.shell.emit('start:close'));

  // ---- launch with files (registry.launch -> xapps:launch), %f in Path=/tmp
  const before = records().length;
  const ret = await A(() => window.__aurora.registry.launch('linux.sub-nested', { file: '/tmp/some file.txt' }));
  check('registry.launch returns null for a Linux app', ret, null);
  const rec2 = await until(async () => records().length > before && recordWith('nested'), { timeout: 10000 });
  check('launch with a file: %f', rec2?.argv, ['nested', '/tmp/some file.txt']);
  check('launch: working directory from Path=', rec2?.env.PWD, '/tmp');

  // ---- xapps:match
  const match = (q) => A((q) => window.__aurora.api.invoke('xapps:match', q), q);
  check('match: StartupWMClass', await match({ wmClass: ['fixturepaint', 'FixturePaint'] }), ID);
  check('match: gtkAppId = desktop id', await match({ wmClass: ['x', 'Y'], gtkAppId: 'org.selene.Fixture' }), ID);
  check('match: WM class = desktop id, case-insensitive', await match({ wmClass: ['GIMP', 'Gimp-2.10'] }), 'linux.gimp');
  check('match: WM class = last part of a reverse-DNS desktop id', await match({ wmClass: ['fixture', 'Fixture'] }), ID);
  check('match: launched pid', await match({ wmClass: ['unknown', 'Unknown'], pid: rec2?.pid }), 'linux.sub-nested');
  await A(() => window.__aurora.registry.launch('linux.selene-only'));
  const rec3 = await until(async () => recordWith('--hold'), { timeout: 10000 });
  const child = Number(rec3?.env.CHILD) || 0;
  if (rec3?.pid) startedPids.push(rec3.pid);
  if (child) startedPids.push(child);
  check('match: child of a launched process (parent pids from /proc)', await match({ wmClass: ['sleep', 'Sleep'], pid: child }), 'linux.selene-only');
  check('match: nothing known -> null', await match({ wmClass: ['nothing', 'Nothing'], pid: 1 }), null);
  check('match: bad input -> null', await match(null), null);
  let err = null;
  try {
    await A(() => window.__aurora.api.invoke('xapps:launch', 'linux.nope'));
  } catch (e) {
    err = String(e.message || e);
  }
  check('launch: unknown id rejected', err, (v) => /Unknown application/.test(v || ''));

  // ---- xapps:changed (fs.watch) -> registry reload
  fs.writeFileSync(path.join(extraDir, 'late.desktop'), '[Desktop Entry]\nType=Application\nName=Late App\nName[fr]=Appli tardive\nExec=selene-fixture-record late\n');
  const late = await until(async () => A(() => window.__aurora.registry.name('linux.late')).then((n) => (n === 'Appli tardive' ? n : null)), { timeout: 10000 });
  check('watch: a new .desktop file appears in the registry', late, 'Appli tardive');
  fs.rmSync(path.join(extraDir, 'late.desktop'));
  const gone = await until(async () => A(() => !window.__aurora.registry.get('linux.late')), { timeout: 10000 });
  check('watch: a removed .desktop file disappears', gone, true);

  // ---- theme change -> settings.ini + GTK_THEME
  await A(() => window.__aurora.api.invoke('settings:set', 'theme', 'light'));
  const light = await until(async () => /gtk-application-prefer-dark-theme=0/.test(fs.readFileSync(ini3, 'utf8')) && /gtk-application-prefer-dark-theme=0/.test(fs.readFileSync(ini4, 'utf8')), { timeout: 5000 });
  check('theme light: settings.ini updated', !!light, true);

  // ---- Store: graphical apps in French, install (simulated), Open launches the Linux app
  const W = '.app-store';
  await A(() => window.__aurora.shell.launch('store'));
  await page.waitForSelector(`${W} .st-card`, { timeout: 15000 });
  check('Store FR: Graphics category in the nav', await page.locator(`${W} [data-nav="cat:graphics"]`).innerText(), (v) => /Graphisme et dessin/.test(v));
  check('Store FR: Office category', await page.locator(`${W} [data-nav="cat:office"]`).innerText(), (v) => /Bureautique/.test(v));
  await page.click(`${W} [data-nav="cat:graphics"]`);
  check('Store: GIMP, Inkscape, Krita listed', await page.locator(`${W} .st-card`).evaluateAll((els) => els.map((e) => e.dataset.id).sort()), ['gimp', 'inkscape', 'krita']);
  check('Store FR: description in French', await page.locator(`${W} .st-card[data-id=gimp] .st-card-desc`).innerText(), (v) => /Retouche photo/.test(v));
  await page.click(`${W} .st-card[data-id=gimp]`);
  await page.waitForSelector(`${W} .st-install`, { timeout: 10000 });
  check('Store detail: graphical app explains how to open it (FR)', await page.locator(`${W} .st-page`).innerText(), (v) => /application graphique/.test(v) && !/--help/.test(v));
  await page.click(`${W} .st-install`);
  await page.waitForSelector('.uac-dialog', { timeout: 10000 });
  const pw = page.locator('.uac-dialog input[type=password]');
  if (await pw.count()) await pw.fill('aurora');
  await page.locator('.uac-dialog .dialog-footer .btn.primary').click();
  const openBtn = page.locator(`${W} .st-actions .st-open[data-gui]`);
  await openBtn.waitFor({ timeout: 30000 }).catch(() => {});
  check('Store: installed graphical app offers Open (FR)', (await openBtn.innerText().catch(() => '')).trim(), 'Ouvrir');
  await openBtn.click();
  const rec4 = await until(async () => recordWith('gimp'), { timeout: 10000 });
  check('Store Open: launches the Linux app through the registry', rec4?.argv, ['gimp']);
  check('Store Open: GTK_THEME follows the light theme now', rec4?.env.GTK_THEME, 'Adwaita');
  await page.click(`${W} [data-nav=installed]`);
  check('Store Installed: GUI row has Open, not Terminal', await page.locator(`${W} .st-row[data-id=gimp] .st-open[data-gui]`).count(), 1);

  const errs = s.logs.filter((l) => /^\[(error|pageerror)\]/.test(l) && !/favicon|ERR_FILE_NOT_FOUND/.test(l));
  check('no renderer errors', errs, []);
} catch (e) {
  failures.push(`exception: ${e.stack || e}`);
} finally {
  for (const pid of startedPids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
  }
  await s.close();
  fs.rmSync(extraDir, { recursive: true, force: true });
  fs.rmSync(recDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL ${f}`);
process.exit(failures.length ? 1 : 0);
