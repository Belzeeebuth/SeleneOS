// Store source "ubuntu" (backend level, no Electron window): the DEP-11 helper aurora-catalog-apt on the fixture
// (French strings, icons, traversal-safe tar extraction, console apps skipped, suite merge), APT sources parsing
// (deb822 + one-line), download plan, conditional HTTP download, the module in dev mode (search, pagination,
// categories, details, installed, simulated install / remove), admin.js dev simulation, and aurora-admin's DEP-11
// check (the shell function itself, run on a test lists directory) + shellcheck.
// Usage:  cd aurora-os/shell && xvfb-run -a -s "-screen 0 1600x900x24" node test/store-ubuntu.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'test', 'fixtures', 'store-ubuntu');
const HELPERS = path.join(ROOT, '..', 'rootfs', 'usr', 'lib', 'aurora', 'helpers');
const CATALOG_HELPER = path.join(HELPERS, 'aurora-catalog-apt');
const ADMIN_HELPER = path.join(HELPERS, 'aurora-admin');

let passed = 0;
const failures = [];
function check(name, actual, expected) {
  const ok = typeof expected === 'function' ? !!expected(actual) : Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else failures.push(`${name}\n      expected: ${typeof expected === 'function' ? '(predicate)' : JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)?.slice(0, 600)}`);
  return ok;
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-store-ubuntu-'));
const t0 = Date.now();

try {
  // ------------------------------------------------------------------ helper: fixture
  const out = path.join(tmp, 'out');
  const r = spawnSync('python3', ['-I', CATALOG_HELPER, 'build', '--out', out, '--source', path.join(FIX, 'Components-amd64.yml.gz'), path.join(FIX, 'icons-64x64.tar.gz')], { encoding: 'utf8', cwd: tmp });
  check('helper exits 0', r.status, 0);
  check('helper reports progress phases', ['parse', 'icons', 'write'].every((p) => r.stdout.includes(`progress ${p} `)), true);
  check('helper prints done <count>', /^done 21$/m.test(r.stdout), true);
  const cat = JSON.parse(fs.readFileSync(path.join(out, 'catalog.json'), 'utf8'));
  const by = Object.fromEntries(cat.items.map((i) => [i.package, i]));
  check('20 apps + the icon fixture', cat.items.length, 21);
  check('console application skipped (fwupd)', 'fwupd' in by, false);
  const gimp = by.gimp;
  check('gimp: AppStream id', gimp?.id, 'org.gimp.GIMP');
  check('gimp: French name', gimp?.name, { C: 'GNU Image Manipulation Program', fr: 'Éditeur d’image GIMP' });
  check('gimp: French summary', gimp?.summary?.fr, 'Créer des images et modifier des photographies');
  check('gimp: description is plain text paragraphs', gimp?.description?.C, (d) => typeof d === 'string' && !d.includes('<') && d.split('\n\n').length === 3);
  check('gimp: French description', gimp?.description?.fr, (d) => /^GIMP est l’acronyme/.test(d || ''));
  check('gimp: categories', gimp?.categories, (c) => c.includes('Graphics'));
  check('gimp: desktop id', gimp?.desktopId, 'gimp.desktop');
  check('gimp: homepage / license / developer', [gimp?.homepage, gimp?.license, gimp?.developer], (v) => /^https?:\/\//.test(v[0]) && v[1].includes('GPL') && v[2] === 'The GIMP team');
  check('screenshots: absolute https, at most 4', cat.items.flatMap((i) => i.screenshots), (s) => s.length > 5 && s.every((u) => u.startsWith('https://appstream.ubuntu.com/media/noble/')) && cat.items.every((i) => i.screenshots.length <= 4));
  check('lists in description become bullets (audacity)', by.audacity?.description?.C, (d) => d.includes('\n• Record live audio'));
  check('keywords kept (C + fr)', by.kate?.keywords, (k) => Array.isArray(k) && k.length > 0);
  const icons = fs.readdirSync(path.join(out, 'icons')).sort();
  check('20 icons extracted, all referenced', icons.length === 20 && cat.items.filter((i) => i.icon).every((i) => icons.includes(i.icon)), true);
  check('icons are PNG files', icons.every((f) => fs.readFileSync(path.join(out, 'icons', f)).subarray(0, 4).toString('latin1') === '\x89PNG'), true);
  check('tar: symlink member not extracted (icon-fixture has no icon)', by['icon-fixture']?.icon, null);
  check('tar: no path traversal (../, /abs, sub/)', [fs.existsSync(path.join(out, 'aurora-escape.png')), fs.existsSync(path.join(tmp, 'aurora-escape.png')), fs.existsSync('/tmp/aurora-abs.png'), fs.existsSync(path.join(out, 'icons', 'sub'))], [false, false, false, false]);

  // ------------------------------------------------------------------ helper: newer suite wins, keeps older icon
  const newer = path.join(tmp, 'updates.yml.gz');
  fs.writeFileSync(
    newer,
    zlib.gzipSync(`---\nFile: DEP-11\nVersion: '0.14'\nOrigin: ubuntu-noble-updates-universe\nMediaBaseUrl: https://appstream.ubuntu.com/media/noble\n---\nType: desktop-application\nID: org.gimp.GIMP\nPackage: gimp\nName:\n  C: GIMP Updated\nSummary:\n  C: Newer summary\nIcon:\n  cached:\n  - name: gimp_gimp.png\n    width: 64\n    height: 64\nCategories:\n- Graphics\n---\nType: console-application\nID: org.example.cli\nPackage: cli-tool\nName:\n  C: CLI\nSummary:\n  C: x\n`),
  );
  const out2 = path.join(tmp, 'out2');
  const r2 = spawnSync('python3', ['-I', CATALOG_HELPER, 'build', '--out', out2, '--source', path.join(FIX, 'Components-amd64.yml.gz'), path.join(FIX, 'icons-64x64.tar.gz'), '--source', newer, '-'], { encoding: 'utf8' });
  const cat2 = JSON.parse(fs.readFileSync(path.join(out2, 'catalog.json'), 'utf8'));
  const g2 = cat2.items.find((i) => i.package === 'gimp');
  check('merge: newer suite replaces the package entry', [r2.status, g2?.name?.C, g2?.summary?.C], [0, 'GIMP Updated', 'Newer summary']);
  check('merge: icon of the older suite kept', g2?.icon, 'gimp_gimp.png');
  const bad = spawnSync('python3', ['-I', CATALOG_HELPER, 'build', '--out', path.join(tmp, 'out3')], { encoding: 'utf8' });
  check('helper: missing --source -> exit 2', bad.status, 2);

  // ------------------------------------------------------------------ parsers
  const ub = require('../main/lib/sources/ubuntu.js');
  const P = ub.parsers;
  const deb822 = `# comment\nTypes: deb\nURIs: http://archive.ubuntu.com/ubuntu/\nSuites: noble noble-updates noble-backports\nComponents: main universe restricted multiverse\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n\nTypes: deb\nURIs: http://security.ubuntu.com/ubuntu/\nSuites: noble-security\nComponents: main universe\n\nTypes: deb-src\nURIs: http://archive.ubuntu.com/ubuntu/\nSuites: noble\nComponents: main\n\nTypes: deb\nEnabled: no\nURIs: http://example.org/ubuntu/\nSuites: noble-proposed\nComponents: main\n`;
  const e1 = P.parseDeb822(deb822);
  check('deb822: deb stanzas only, disabled skipped', e1, [
    { uris: ['http://archive.ubuntu.com/ubuntu/'], suites: ['noble', 'noble-updates', 'noble-backports'], components: ['main', 'universe', 'restricted', 'multiverse'] },
    { uris: ['http://security.ubuntu.com/ubuntu/'], suites: ['noble-security'], components: ['main', 'universe'] },
  ]);
  const e2 = P.parseOneLine('# deb http://x/ubuntu noble main\ndeb [arch=amd64 signed-by=/k.gpg] http://fr.archive.ubuntu.com/ubuntu noble main universe # tail\ndeb-src http://archive.ubuntu.com/ubuntu noble main\ndeb http://security.ubuntu.com/ubuntu noble-security main\n');
  check('one-line: options and comments handled, deb-src skipped', e2, [
    { uris: ['http://fr.archive.ubuntu.com/ubuntu'], suites: ['noble'], components: ['main', 'universe'] },
    { uris: ['http://security.ubuntu.com/ubuntu'], suites: ['noble-security'], components: ['main'] },
  ]);
  const plan = P.planDownloads([...e1, { uris: ['file:///srv/mirror', 'http://evil host/'], suites: ['noble'], components: ['main'] }, { uris: ['http://archive.ubuntu.com/ubuntu/'], suites: ['noble-proposed', '../x'], components: ['main', 'bogus'] }]);
  check('plan: 4 suites x components, oldest first, updates last', [plan.length, plan[0].suite, plan.at(-1).suite], [14, 'noble', 'noble-updates']);
  check('plan: URL layout', plan.find((p) => p.suite === 'noble-security' && p.comp === 'universe'), (p) => p.components === 'http://security.ubuntu.com/ubuntu/dists/noble-security/universe/dep11/Components-amd64.yml.gz' && p.icons.endsWith('/dep11/icons-64x64.tar.gz'));
  check('plan: no proposed / bad suites / bad URIs / unknown components', plan.every((p) => /^noble(-(updates|security|backports))?$/.test(p.suite) && p.components.startsWith('http://') && p.comp !== 'bogus'), true);
  check('one-line URI without trailing slash', P.planDownloads(e2)[0].components, 'http://fr.archive.ubuntu.com/ubuntu/dists/noble/main/dep11/Components-amd64.yml.gz');
  const fixPkgs = P.dep11Packages(zlib.gunzipSync(fs.readFileSync(path.join(FIX, 'Components-amd64.yml.gz'))).toString('utf8'));
  check('dep11Packages: desktop apps only', [fixPkgs.has('gimp'), fixPkgs.has('krita'), fixPkgs.has('fwupd'), fixPkgs.size], [true, true, false, 21]);
  check('parseAptStatus', [P.parseAptStatus('dlstatus:1:33.3:Retrieving file 1 of 3'), P.parseAptStatus('pmstatus:gimp:50:Unpacking gimp'), P.parseAptStatus('junk')], [{ phase: 'download', percent: 33.3, message: 'Retrieving file 1 of 3' }, { phase: 'install', percent: 50, message: 'Unpacking gimp' }, null]);
  check('mainCategories', [P.mainCategories(['Audio', 'Video', 'Player']), P.mainCategories(['X-Foo'])], [['AudioVideo'], ['Utility']]);

  // ------------------------------------------------------------------ conditional download (local HTTP server)
  const body = Buffer.from('payload-1234');
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    if (req.url === '/redir') return res.writeHead(302, { location: '/file' }).end();
    if (req.url !== '/file') return res.writeHead(404).end();
    if (req.headers['if-none-match'] === '"v1"') return res.writeHead(304).end();
    res.writeHead(200, { etag: '"v1"', 'last-modified': 'Sun, 12 Nov 2023 22:43:55 GMT', 'content-length': body.length }).end(body);
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dest = path.join(tmp, 'dl.bin');
  const d1 = await P.download(`${base}/redir`, dest);
  check('download: redirect followed, 200 + etag', [d1.status, d1.etag, fs.readFileSync(dest, 'utf8')], [200, '"v1"', 'payload-1234']);
  const d2 = await P.download(`${base}/file`, dest, { etag: d1.etag, lastModified: d1.lastModified });
  check('download: If-None-Match -> 304, file kept', [d2.status, fs.readFileSync(dest, 'utf8')], [304, 'payload-1234']);
  const d3 = await P.download(`${base}/missing`, path.join(tmp, 'missing.bin'));
  check('download: 404 reported, nothing written', [d3.status, fs.existsSync(path.join(tmp, 'missing.bin'))], [404, false]);
  check('download: non-http URL refused', await P.download('file:///etc/passwd', path.join(tmp, 'x')).then(() => 'ok', (e) => e.message), (m) => /unsupported/.test(m));
  server.close();

  // ------------------------------------------------------------------ module (dev mode)
  delete process.env.AURORA_REAL_BACKENDS;
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home);
  ub.init({ DEV: true, env: { lang: 'en' }, home, api: { env: { lang: 'en' } } });
  check('status before first use: not ready', (await ub.status()).ready, false);
  const all = await ub.search({});
  check('search(): fixture built on first use, 21 apps', all.total, 21);
  const st = await ub.status();
  check('status after: ready, count, updatedAt', [st.available, st.ready, st.count, typeof st.updatedAt], [true, true, 21, 'number']);
  check('cache under ~/.cache/aurora/store/ubuntu', fs.existsSync(path.join(home, '.cache', 'aurora', 'store', 'ubuntu', 'catalog.json')), true);
  const it0 = all.items.find((i) => i.id === 'gimp');
  check('item shape', it0, (i) => i.source === 'ubuntu' && i.appId === 'org.gimp.GIMP' && i.desktopId === 'gimp.desktop' && i.installed === false && i.categories.includes('Graphics') && /^media:\/\/local\/.+gimp_gimp\.png$/.test(i.icon));
  check('icon-fixture: icon null (never undefined)', all.items.find((i) => i.id === 'icon-fixture')?.icon, null);
  const p1 = await ub.search({ offset: 0, limit: 8 });
  const p2 = await ub.search({ offset: 8, limit: 8 });
  const p3 = await ub.search({ offset: 16, limit: 8 });
  check('pagination: 8 + 8 + 5, no overlap', [p1.items.length, p2.items.length, p3.items.length, new Set([...p1.items, ...p2.items, ...p3.items].map((i) => i.id)).size, p1.total], [8, 8, 5, 21, 21]);
  check('search "gimp" ranks gimp first', (await ub.search({ query: 'gimp' })).items[0]?.id, 'gimp');
  check('search by keyword (IRC -> hexchat)', (await ub.search({ query: 'irc' })).items.map((i) => i.id), (ids) => ids.includes('hexchat'));
  check('search with no match', (await ub.search({ query: 'zzzqqq' })).total, 0);
  const games = await ub.search({ category: 'Game', limit: 50 });
  check('category Game', games.items.map((i) => i.id), (ids) => ids.includes('gnome-chess') && ids.includes('supertux') && !ids.includes('gimp'));
  check('category + query', (await ub.search({ category: 'Game', query: 'chess' })).items.map((i) => i.id), ['gnome-chess']);
  check('French summary with lang fr', (await ub.search({ query: 'gimp', lang: 'fr' })).items[0]?.summary, 'Créer des images et modifier des photographies');
  const det = await ub.details('gimp');
  check('details: description, homepage, license, developer', det, (d) => d.description.length > 100 && d.homepage.startsWith('http') && d.license && d.developer === 'The GIMP team');
  check('details (dev): local screenshots, no network', det.screenshots, (u) => u.length >= 1 && u.every((x) => /^media:\/\/local\/.+\/store-ubuntu\/screenshot-[12]\.png$/.test(x)));
  check('details fr', (await ub.details('gimp', { lang: 'fr' })).description, (d) => d.startsWith('GIMP est'));
  check('details: unknown -> ENOTFOUND', await ub.details('nope-nope').then(() => 'ok', (e) => e.code), 'ENOTFOUND');
  check('installed(): none of the fixture', await ub.installed(), []);
  const prog = [];
  const res = await ub.install('krita', (p) => prog.push(p));
  check('install: progress events rise to 100', [prog.length > 3, prog.at(-1)?.percent, prog.every((p, i) => i === 0 || p.percent >= prog[i - 1].percent)], [true, 100, true]);
  check('install: resolves desktopId', res.desktopId, 'org.kde.krita.desktop');
  check('installed() after install', (await ub.installed()).map((x) => x.id), ['krita']);
  check('search marks it installed', (await ub.search({ query: 'krita' })).items[0]?.installed, true);
  check('shared dev state (admin.js)', require('../main/ipc/admin.js').dev.storeState().installed.has('krita'), true);
  await ub.remove('krita', () => {});
  check('remove', (await ub.installed()).length, 0);
  check('install: unknown package -> ENOTFOUND', await ub.install('not-in-catalogue').then(() => 'ok', (e) => e.code), 'ENOTFOUND');
  check('install: invalid id -> EINVAL', await ub.install('x; rm -rf /').then(() => 'ok', (e) => e.code), 'EINVAL');
  process.env.AURORA_STORE_DEV_FAIL = 'vlc';
  check('install: AURORA_STORE_DEV_FAIL makes it fail', await ub.install('vlc').then(() => 'ok', (e) => e.code), 'ECMD');
  delete process.env.AURORA_STORE_DEV_FAIL;
  check('adminAction', [ub.adminAction('install', 'gimp'), ub.adminAction('remove', 'gimp')], [{ action: 'store-install', args: ['gimp'] }, { action: 'store-remove', args: ['gimp'] }]);
  check('adminAction validates', (() => { try { ub.adminAction('install', '../x'); return 'ok'; } catch (e) { return e.code; } })(), 'EINVAL');
  check('refresh() again (dev, from the fixture)', await ub.refresh(() => {}).then(() => 'ok', (e) => e.message), 'ok');

  // Real mode: install / remove need the UAC prompt -> EADMIN with the admin action.
  ub.init({ DEV: false, env: {}, home, api: { env: {} } });
  check('real mode: install -> EADMIN + admin action', await ub.install('gimp').then(() => null, (e) => [e.code, e.admin]), ['EADMIN', { action: 'store-install', args: ['gimp'] }]);

  // ------------------------------------------------------------------ admin.js (dev simulation + validation)
  const admin = require('../main/ipc/admin.js');
  check('admin validate store-install of an ubuntu package', admin.parsers.validate('store-install', ['gimp']).args, ['gimp']);
  check('admin dev: fixture package accepted', await admin.dev.storeRun('store-install', ['geany'], () => {}).then(() => admin.dev.storeState().installed.has('geany'), (e) => e.message), true);
  await admin.dev.storeRun('store-remove', ['geany'], () => {});
  check('admin dev: unknown package refused', await admin.dev.storeRun('store-install', ['not-a-store-pkg'], () => {}).then(() => 'ok', (e) => e.code), 'EPERM');
  check('admin dev: Selene catalog package still accepted (jq)', await admin.dev.storeRun('store-install', ['jq'], () => {}).then(() => admin.dev.storeState().installed.has('jq'), (e) => e.code), true);
  await admin.dev.storeRun('store-remove', ['jq'], () => {});
  check('admin dev: fixed Selene package still not removable (git)', await admin.dev.storeRun('store-remove', ['git'], () => {}).then(() => 'ok', (e) => e.code), 'EPERM');

  // ------------------------------------------------------------------ aurora-admin: the DEP-11 check itself
  const src = fs.readFileSync(ADMIN_HELPER, 'utf8');
  const fn = /^ {2}store_dep11_has\(\) \{\n[\s\S]*?\n {2}\}\n/m.exec(src)?.[0];
  check('aurora-admin defines store_dep11_has', !!fn, true);
  check('aurora-admin: lists dir is fixed (no env override)', /STORE_APT_LISTS=\/var\/lib\/apt\/lists\n/.test(src) && !/\$\{?AURORA_[A-Z_]*LISTS/.test(src), true);
  const lists = path.join(tmp, 'lists');
  fs.mkdirSync(lists);
  fs.copyFileSync(path.join(FIX, 'Components-amd64.yml.gz'), path.join(lists, 'archive.ubuntu.com_ubuntu_dists_noble_universe_dep11_Components-amd64.yml.gz'));
  const has = (pkg, dir = lists) => spawnSync('bash', ['-c', `set -euo pipefail\n${fn}\nstore_dep11_has "$1" "$2"`, 'x', pkg, dir]).status;
  const root = process.getuid() === 0;
  check('dep11 check: desktop app found', has('gimp'), root ? 0 : 1);
  check('dep11 check: console app refused', has('fwupd'), 1);
  check('dep11 check: unknown package refused', has('no-such-package'), 1);
  check('dep11 check: name is matched exactly (prefix)', has('gim'), 1);
  const linkDir = path.join(tmp, 'lists-link');
  fs.mkdirSync(linkDir);
  fs.symlinkSync(path.join(lists, 'archive.ubuntu.com_ubuntu_dists_noble_universe_dep11_Components-amd64.yml.gz'), path.join(linkDir, 'evil_dep11_Components-amd64.yml.gz'));
  check('dep11 check: symlinked file ignored', has('gimp', linkDir), 1);
  if (root) {
    const userDir = path.join(tmp, 'lists-user');
    fs.mkdirSync(userDir);
    const f = path.join(userDir, 'archive_dists_noble_main_dep11_Components-amd64.yml.gz');
    fs.copyFileSync(path.join(FIX, 'Components-amd64.yml.gz'), f);
    fs.chownSync(f, 65534, 65534);
    check('dep11 check: file not owned by root ignored', has('gimp', userDir), 1);
  }
  check('aurora-admin still refuses non-root callers', root ? 'skipped (root)' : spawnSync(ADMIN_HELPER, ['store-install', 'gimp']).status, (v) => v === 'skipped (root)' || v === 4);
  if (spawnSync('which', ['shellcheck']).status === 0) check('aurora-admin passes shellcheck', spawnSync('shellcheck', [ADMIN_HELPER], { encoding: 'utf8' }).stdout, '');
  check('aurora-catalog-apt compiles', spawnSync('python3', ['-I', '-c', 'import sys; compile(open(sys.argv[1]).read(), sys.argv[1], "exec")', CATALOG_HELPER]).status, 0);
  check('aurora-catalog-apt is executable', (fs.statSync(CATALOG_HELPER).mode & 0o111) !== 0, true);
} catch (e) {
  failures.push(`uncaught: ${e.stack || e}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

for (const f of failures) console.log(`FAIL ${f}`);
console.log(`store-ubuntu: ${((Date.now() - t0) / 1000).toFixed(1)} s`);
console.log(`${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
