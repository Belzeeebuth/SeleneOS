// Store source 'flathub' (main/lib/sources/flathub.js, docs/STORE-SOURCES.md), backend level, no Electron window:
// the python helper aurora-catalog-flathub on the fixture AppStream (fr strings, icons, categories, skipped
// components), the module in dev mode (search, pagination, categories, details, installed, install / remove with
// progress, AURORA_STORE_DEV_FAIL, id validation), the module in real mode against a stub flatpak binary
// (AURORA_FLATPAK: argv, progress parsing, error codes), and xapps argv building for flatpak Exec lines.
// Usage:  cd aurora-os/shell && xvfb-run -a -s "-screen 0 1600x900x24" node test/store-flathub.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'test', 'fixtures', 'store-flathub');
const HELPER = path.join(ROOT, '..', 'rootfs', 'usr', 'lib', 'aurora', 'helpers', 'aurora-catalog-flathub');

let passed = 0;
const failures = [];
function check(name, actual, expected) {
  const ok = typeof expected === 'function' ? !!expected(actual) : Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else failures.push(`${name}\n      expected: ${typeof expected === 'function' ? '(predicate)' : JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
  return ok;
}
async function rejects(name, promise, code) {
  try {
    await promise;
    check(name, 'resolved', `rejects ${code}`);
  } catch (e) {
    check(name, e.code, code);
    return e;
  }
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-flathub-'));
const mediaUrl = (abs) => `media://local${abs.split('/').map(encodeURIComponent).join('/')}`;
const helper = (args) => execFileSync('python3', ['-I', HELPER, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

try {
  // ---------------------------------------------------------------- python helper
  const t0 = Date.now();
  const doc = JSON.parse(helper(['--xml', path.join(FIX, 'appstream.xml.gz'), '--out', '-']));
  const by = Object.fromEntries(doc.apps.map((a) => [a.id, a]));
  check('helper: 22 desktop apps kept', doc.count, 22);
  check('helper: runtime, addon, console app, end-of-life, bad id and merge entries skipped', ['org.gnome.Platform', 'org.freedesktop.Platform.GL.default', 'org.example.Cli', 'org.example.OldApp'].some((i) => by[i]) || doc.apps.some((a) => /\s/.test(a.id) || a.name.en === 'Merge entry'), false);
  check('helper: the required apps are present', ['org.mozilla.firefox', 'org.gimp.GIMP', 'com.spotify.Client', 'com.discordapp.Discord', 'org.videolan.VLC'].every((i) => by[i]), true);
  check('helper: French name (xml:lang="fr")', by['org.gimp.GIMP'].name, { en: 'GNU Image Manipulation Program', fr: 'Programme de manipulation d’images GNU' });
  check('helper: French summary (xml:lang="fr_FR"), x-test name ignored', [by['org.mozilla.firefox'].summary.fr, by['org.videolan.VLC'].name], ['Navigateur web rapide, privé et sûr', { en: 'VLC' }]);
  check('helper: old-style <id>x.desktop</id> + type="desktop" kept, id from the bundle ref', [by['org.videolan.VLC'].appId, by['org.blender.Blender'] != null], ['org.videolan.VLC', true]);
  const gimpIcon = path.join(FIX, 'icons', '128x128', 'org.gimp.GIMP.png');
  check('helper: cached 128 px icon -> media:// URL', by['org.gimp.GIMP'].icon, mediaUrl(gimpIcon));
  check('helper: 64 px icon when there is no 128 px one', by['org.gnome.Calculator'].icon, mediaUrl(path.join(FIX, 'icons', '64x64', 'org.gnome.Calculator.png')));
  check('helper: remote https icon when nothing is cached', by['md.obsidian.Obsidian'].icon, (v) => /^https:\/\/dl\.flathub\.org\//.test(v));
  check('helper: icon name with ../ rejected', by['io.github.example.Notes'].icon, null);
  check('helper: main categories only (Audio -> AudioVideo, no duplicates)', [by['com.spotify.Client'].categories, by['org.stellarium.Stellarium'].categories, by['org.gnome.Calculator'].categories], [['AudioVideo'], ['Science', 'Education'], ['Utility']]);
  check('helper: description <p>/<li> to text, per-language <description>', by['org.gimp.GIMP'].description, { en: 'GIMP is an image editor.\n\nFeatures:\n\n• Layers and masks\n• Plug-ins', fr: 'GIMP est un éditeur d’images.\n\nFonctions :\n\n• Calques et masques\n• Greffons' });
  check('helper: description with xml:lang per paragraph, inline markup and whitespace flattened', by['org.mozilla.firefox'].description, { en: 'Firefox is a fast browser.\n\nIt respects your privacy.', fr: 'Firefox est un navigateur rapide.\n\nIl respecte votre vie privée.' });
  check('helper: description capped at 3000 characters', by['org.inkscape.Inkscape'].description.en, (d) => d.length <= 3000 && d.length > 2900 && d.endsWith('…'));
  check('helper: first 4 screenshots, 624 px thumbnails, https only', [by['org.gimp.GIMP'].screenshots.length, by['org.gimp.GIMP'].screenshots[0], by['org.mozilla.firefox'].screenshots.length], [4, 'https://dl.flathub.org/media/org.gimp.GIMP/624/0.png', 2]);
  check('helper: latest release, developer (<developer><name> and <developer_name>), license, homepage', [by['org.gimp.GIMP'].version, by['com.spotify.Client'].developer, by['org.gimp.GIMP'].developer, by['org.gimp.GIMP'].license, by['org.gimp.GIMP'].homepage], ['2.10.38', 'Spotify', 'The GIMP team', 'GPL-3.0+', 'https://example.org/org.gimp.GIMP']);
  check('helper: keywords (all languages, lowercase)', by['org.gimp.GIMP'].keywords, ['photo', 'paint', 'gimp', 'motclé-photo']);
  // plain appstream.xml (no .gz) in a directory with a space: --out file, icons next to it, URL encoding
  const act = path.join(tmp, 'my active');
  fs.mkdirSync(act, { recursive: true });
  fs.writeFileSync(path.join(act, 'appstream.xml'), zlib.gunzipSync(fs.readFileSync(path.join(FIX, 'appstream.xml.gz'))));
  fs.cpSync(path.join(FIX, 'icons'), path.join(act, 'icons'), { recursive: true });
  const out = path.join(tmp, 'cache', 'flathub.json');
  helper(['--xml', path.join(act, 'appstream.xml'), '--out', out]);
  const doc2 = JSON.parse(fs.readFileSync(out, 'utf8'));
  check('helper: plain appstream.xml parsed, --out written', doc2.count, 22);
  check('helper: icon URL encoded like the preload mediaUrl (space -> %20)', doc2.apps.find((a) => a.id === 'org.gimp.GIMP').icon, (u) => u === mediaUrl(path.join(act, 'icons', '128x128', 'org.gimp.GIMP.png')) && u.includes('my%20active'));
  let code = 0;
  try {
    helper(['--xml', path.join(tmp, 'missing.xml'), '--out', '-']);
  } catch (e) {
    code = e.status;
  }
  check('helper: unreadable input -> exit 2', code, 2);
  check('helper: fast on the fixture', Date.now() - t0, (ms) => ms < 15000);

  // ---------------------------------------------------------------- module, dev mode
  const F = require(path.join(ROOT, 'main', 'lib', 'sources', 'flathub.js'));
  const I = F._internal;
  check('module: contract shape', [F.id, F.label.fr, ...['init', 'status', 'refresh', 'search', 'details', 'installed', 'install', 'remove'].map((k) => typeof F[k])], ['flathub', 'Flathub', ...Array(8).fill('function')]);
  check('ids: valid flatpak ids', ['org.gimp.GIMP', 'com.spotify.Client', 'io.github.foo_bar.App-1'].every(I.validId), true);
  check('ids: invalid ids rejected', ['org.gimp', '../org.gimp.GIMP', 'org.gimp.GIMP;rm -rf ~', 'org..gimp.GIMP', '-x', `a.b.${'c'.repeat(260)}`, '', null, 42, 'org.gimp.GIMP\n'].some(I.validId), false);

  let lang = 'en';
  F.init({ DEV: true, home: tmp, env: { lang: 'en', live: false }, api: { settings: { get: (k) => (k === 'lang' ? lang : null) } } });
  const st = await F.status();
  check('dev status: available, ready, 22 apps, simulated, not live', [st.available, st.ready, st.count, st.simulated, st.live], [true, true, 22, true, false]);
  const all = await F.search({});
  check('dev search: everything, alphabetical', [all.total, all.items[0].name, all.items.length], [22, 'Audacity', 22]);
  check('dev search: Item shape', Object.keys(all.items[0]).sort(), ['appId', 'categories', 'desktopId', 'icon', 'id', 'installed', 'name', 'source', 'summary']);
  const p1 = await F.search({ offset: 0, limit: 10 });
  const p3 = await F.search({ offset: 20, limit: 10 });
  check('dev search: pagination (offset / limit, total kept)', [p1.items.length, p3.items.length, p3.total, p3.items[0].id === all.items[20].id], [10, 2, 22, true]);
  check('dev search: category filter', (await F.search({ category: 'Game' })).items.map((i) => i.id).sort(), ['com.valvesoftware.Steam', 'net.lutris.Lutris']);
  check('dev search: category + query', (await F.search({ category: 'AudioVideo', query: 'video' })).items.map((i) => i.id), (ids) => ids[0] === 'org.kde.kdenlive' || ids.includes('org.videolan.VLC'));
  check('dev search: unknown category ignored', (await F.search({ category: 'Bogus' })).total, 22);
  check('dev search: case-insensitive, prefix name first', (await F.search({ query: 'FIRE' })).items[0]?.id, 'org.mozilla.firefox');
  check('dev search: word prefix in the name ranks before keywords', (await F.search({ query: 'code' })).items.map((i) => i.id), (ids) => ids[0] === 'com.visualstudio.code' && ids.includes('org.gnome.Builder'));
  check('dev search: exact name first', (await F.search({ query: 'steam' })).items[0]?.id, 'com.valvesoftware.Steam');
  check('dev search: by id and summary', [(await F.search({ query: 'com.spotify' })).items[0]?.id, (await F.search({ query: 'planetarium' })).items[0]?.id], ['com.spotify.Client', 'org.stellarium.Stellarium']);
  check('dev search: nothing found', (await F.search({ query: 'zzzz-nope' })).total, 0);
  const gimp = await F.details('org.gimp.GIMP');
  check('dev details: description, screenshots, homepage, license, developer, version', [gimp.description.startsWith('GIMP is an image editor.'), gimp.screenshots.length, gimp.homepage, gimp.license, gimp.developer, gimp.version, gimp.source, gimp.installed], [true, 4, 'https://example.org/org.gimp.GIMP', 'GPL-3.0+', 'The GIMP team', '2.10.38', 'flathub', false]);
  lang = 'fr';
  const gimpFr = await F.details('org.gimp.GIMP');
  check('dev details fr: name, summary and description in French', [gimpFr.name, gimpFr.summary, gimpFr.description.split('\n')[0]], ['Programme de manipulation d’images GNU', 'Créer des images et retoucher des photos', 'GIMP est un éditeur d’images.']);
  check('dev search fr: French name, accent-insensitive query', [(await F.search({ query: 'calculatrice' })).items[0]?.name, (await F.search({ query: 'creer des images' })).items[0]?.id], ['Calculatrice', 'org.gimp.GIMP']);
  check('dev search fr: English kept when there is no translation', (await F.search({ query: 'spotify' })).items[0]?.summary, 'Service de musique en ligne');
  lang = 'en';
  await rejects('dev details: unknown app -> ENOENT', F.details('org.example.Unknown'), 'ENOENT');
  await rejects('dev details: bad id -> EINVAL', F.details('../../etc'), 'EINVAL');
  check('dev installed: empty at start', await F.installed(), []);

  const events = [];
  const inst = F.install('org.gimp.GIMP', (e) => events.push(e));
  await rejects('dev install: one operation at a time per app (EBUSY)', F.install('org.gimp.GIMP'), 'EBUSY');
  const res = await inst;
  check('dev install: resolves the exported desktop id', res, { desktopId: 'org.gimp.GIMP.desktop' });
  check('dev install: progress events 0..100, increasing, with a message', events.map((e) => e.percent), (p) => p[0] === 0 && p[p.length - 1] === 100 && p.every((v, i) => i === 0 || v > p[i - 1]) && events.every((e) => typeof e.message === 'string' && e.message));
  check('dev installed: lists the app with its version', (await F.installed()).map((x) => [x.id, x.version]), [['org.gimp.GIMP', '2.10.38']]);
  const hit = (await F.search({ query: 'gimp' })).items[0];
  check('dev search: installed item marked, desktopId set', [hit.installed, hit.desktopId], [true, 'org.gimp.GIMP.desktop']);
  check('dev details: installedVersion', (await F.details('org.gimp.GIMP')).installedVersion, '2.10.38');
  process.env.AURORA_STORE_DEV_FAIL = 'com.spotify.Client,com.discordapp.Discord:ENOSPC';
  await rejects('dev install: AURORA_STORE_DEV_FAIL -> EFLATPAK', F.install('com.spotify.Client', () => {}), 'EFLATPAK');
  await rejects('dev install: AURORA_STORE_DEV_FAIL=<id>:ENOSPC', F.install('com.discordapp.Discord', () => {}), 'ENOSPC');
  delete process.env.AURORA_STORE_DEV_FAIL;
  check('dev install: a failed install is not installed, and the app is free again', [(await F.installed()).length, (await F.install('com.spotify.Client')).desktopId], [1, 'com.spotify.Client.desktop']);
  await rejects('dev install: bad id -> EINVAL', F.install('a;b', () => {}), 'EINVAL');
  await rejects('dev install: unknown app -> ENOENT', F.install('org.example.Unknown', () => {}), 'ENOENT');
  const rmEvents = [];
  await F.remove('org.gimp.GIMP', (e) => rmEvents.push(e));
  check('dev remove: progress and the app is gone', [rmEvents.at(-1)?.percent, (await F.installed()).map((x) => x.id)], [100, ['com.spotify.Client']]);
  const phases = [];
  const st2 = await F.refresh((e) => phases.push(e.phase));
  check('dev refresh: phases and status', [phases.at(-1), st2.count, st2.ready], ['done', 22, true]);
  check('dev: nothing written under HOME', fs.existsSync(path.join(tmp, '.cache')), false);

  // ---------------------------------------------------------------- pure parsers
  check('progress: n/m steps + percent -> overall percent', [I.parseProgress('Installing 1/2… ████ 50%  2.0 MB/s')?.percent, I.parseProgress('Installing 2/2… 100%')?.percent, I.parseProgress('Installing 2/2… done')?.percent], [25, 100, 100]);
  check('progress: no percent -> message only (indeterminate)', I.parseProgress('\x1b[1mLooking for matches…\x1b[0m'), { message: 'Looking for matches…' });
  check('errors: network / space / other', [I.errorCode("error: Unable to load summary from remote flathub: Could not resolve hostname"), I.errorCode('error: Not enough disk space to complete this operation'), I.errorCode('error: org.gnome.NetworkDisplays not installed')], ['ENET', 'ENOSPC', 'EFLATPAK']);
  check('errors: detail is the last "error:" line', I.errorDetail('Looking for matches…\nerror: Nothing matches foo\n'), 'Nothing matches foo');
  check('list: tab columns, header skipped, SI sizes', I.parseList('Application ID\tVersion\tInstalled size\norg.gimp.GIMP\t2.10.38\t1.2 GB\ncom.spotify.Client\t\t850.3 MB\n'), [{ id: 'org.gimp.GIMP', version: '2.10.38', size: 1.2e9 }, { id: 'com.spotify.Client', size: 850300000 }]);

  // ---------------------------------------------------------------- module, real mode against a stub flatpak
  const stubDir = path.join(tmp, 'bin');
  fs.mkdirSync(stubDir);
  const stub = path.join(stubDir, 'flatpak');
  const log = path.join(tmp, 'flatpak.log');
  fs.writeFileSync(
    stub,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_LOG"
case "$1" in
  remote-add) [ -n "$FAKE_REMOTE_FAIL" ] && { echo "error: Can't load uri https://dl.flathub.org/repo/flathub.flatpakrepo: Could not resolve hostname" >&2; exit 1; }; exit 0 ;;
  update) d="$FLATPAK_USER_DIR/appstream/flathub/x86_64/active"; mkdir -p "$d"; cp "$FAKE_FIXTURE/appstream.xml.gz" "$d/"; cp -r "$FAKE_FIXTURE/icons" "$d/"; echo "Updating appstream data for user remote flathub"; printf '50%%\\r100%%\\n'; exit 0 ;;
  list) printf 'org.gimp.GIMP\\t2.10.38\\t1.2 GB\\n'; exit 0 ;;
  install) [ "$6" = "com.spotify.Client" ] && { echo "Installing 1/1…" ; echo "error: Not enough disk space to complete this operation" >&2; exit 1; }
           printf 'Looking for matches…\\nInstalling 1/2… 50%%\\rInstalling 1/2… 100%%\\nInstalling 2/2… 30%%\\rInstalling 2/2… done\\n'; exit 0 ;;
  uninstall) echo "Uninstalling 1/1…"; exit 0 ;;
esac
exit 3
`,
  );
  fs.chmodSync(stub, 0o755);
  const realHome = path.join(tmp, 'real-home');
  fs.mkdirSync(realHome);
  Object.assign(process.env, { AURORA_FLATPAK: stub, FAKE_LOG: log, FAKE_FIXTURE: FIX, FLATPAK_USER_DIR: path.join(realHome, '.local', 'share', 'flatpak') });
  delete process.env.XDG_CACHE_HOME;
  F.init({ DEV: false, home: realHome, env: { lang: 'en', live: true } });
  const rs = await F.status();
  check('real status: flatpak available, catalogue not ready yet, live flag', [rs.available, rs.ready, rs.count, rs.live], [true, false, 0, true]);
  const rph = [];
  const rs2 = await F.refresh((e) => rph.push(e.phase));
  check('real refresh: remote-add --user --if-not-exists, then update --user --appstream', fs.readFileSync(log, 'utf8').trim().split('\n'), ['remote-add --user --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo', 'update --user --appstream flathub']);
  check('real refresh: phases, cache written under ~/.cache/aurora/store, 22 apps', [rph.includes('download') && rph.includes('parse') && rph.at(-1) === 'done', fs.existsSync(path.join(realHome, '.cache', 'aurora', 'store', 'flathub.json')), rs2.count, rs2.ready], [true, true, 22, true]);
  check('real search: installed state from flatpak list', (await F.search({ query: 'gimp' })).items[0], (i) => i.installed === true && i.desktopId === 'org.gimp.GIMP.desktop' && i.icon.includes('/active/icons/128x128/'));
  check('real installed: id, version, size in bytes', await F.installed(), [{ id: 'org.gimp.GIMP', version: '2.10.38', size: 1.2e9 }]);
  fs.writeFileSync(log, '');
  const rev = [];
  const r1 = await F.install('org.videolan.VLC', (e) => rev.push(e));
  check('real install: argv (no shell, --user, -y, --noninteractive)', fs.readFileSync(log, 'utf8').split('\n')[0], 'install --user -y --noninteractive flathub org.videolan.VLC');
  check('real install: parsed overall progress', rev.filter((e) => e.percent != null).map((e) => e.percent), (p) => p.includes(25) && p.includes(50) && p.includes(65) && p.at(-1) === 100);
  check('real install: resolves the desktop id', r1, { desktopId: 'org.videolan.VLC.desktop' });
  const enospc = await rejects('real install: "Not enough disk space" -> ENOSPC', F.install('com.spotify.Client', () => {}), 'ENOSPC');
  check('real install: readable message', enospc?.message, (m) => /disk space/i.test(m));
  await F.remove('org.videolan.VLC', () => {});
  check('real remove: argv', fs.readFileSync(log, 'utf8').trim().split('\n').find((l) => l.startsWith('uninstall')), 'uninstall --user -y --noninteractive org.videolan.VLC');
  // remote-add failure (network) on a fresh init
  process.env.FAKE_REMOTE_FAIL = '1';
  F.init({ DEV: false, home: realHome });
  await rejects('real: remote-add failure without network -> ENET', F.install('org.videolan.VLC', () => {}), 'ENET');
  check('real: catalogue cache reused without network', (await F.status()).count, 22);
  delete process.env.FAKE_REMOTE_FAIL;
  // flatpak missing
  process.env.AURORA_FLATPAK = path.join(tmp, 'no-such-flatpak');
  F.init({ DEV: false, home: realHome });
  const ms = await F.status();
  check('real: flatpak missing -> available false + error', [ms.available, ms.ready, ms.errorCode, /not installed/i.test(ms.error)], [false, false, 'EFLATPAK', true]);
  await rejects('real: install without flatpak -> EFLATPAK', F.install('org.videolan.VLC', () => {}), 'EFLATPAK');
  check('real: installed() without flatpak is empty', await F.installed(), []);
  delete process.env.AURORA_FLATPAK;

  // ---------------------------------------------------------------- xapps: flatpak Exec lines, theme
  const { parsers: X } = require(path.join(ROOT, 'main', 'ipc', 'xapps.js'));
  const gimpExec = { exec: '/usr/bin/flatpak run --branch=stable --arch=x86_64 --command=gimp-2.10 --file-forwarding org.gimp.GIMP @@u %U @@' };
  const base = ['/usr/bin/flatpak', 'run', '--branch=stable', '--arch=x86_64', '--command=gimp-2.10', '--file-forwarding', 'org.gimp.GIMP'];
  check('xapps: flatpak @@u %U @@ with files -> URLs between the markers', X.buildArgv(gimpExec, { files: ['/tmp/a b.png', '/tmp/c.png'] }), [[...base, '@@u', 'file:///tmp/a%20b.png', 'file:///tmp/c.png', '@@']]);
  check('xapps: flatpak @@u %U @@ without files -> markers dropped', X.buildArgv(gimpExec, {}), [base]);
  check('xapps: flatpak @@ %F @@ keeps paths, drops non-file URLs and the empty pair', [X.buildArgv({ exec: 'flatpak run --file-forwarding org.x.Y @@ %F @@' }, { files: ['/a'] })[0].slice(-3), X.buildArgv({ exec: 'flatpak run --file-forwarding org.x.Y @@ %F @@' }, { urls: ['https://e.org/'] })[0].at(-1)], [['@@', '/a', '@@'], 'org.x.Y']);
  check('xapps: flatpak @@u %u @@ with two files -> one launch each', X.buildArgv({ exec: 'flatpak run --file-forwarding org.x.Y @@u %u @@' }, { files: ['/a', '/b'] }).map((a) => a.slice(-3)), [['@@u', 'file:///a', '@@'], ['@@u', 'file:///b', '@@']]);
  check('xapps: gsettings color-scheme + gtk-theme', [X.gsettingsArgs(true), X.gsettingsArgs(false)[0]], [[['set', 'org.gnome.desktop.interface', 'color-scheme', 'prefer-dark'], ['set', 'org.gnome.desktop.interface', 'gtk-theme', 'Adwaita-dark']], ['set', 'org.gnome.desktop.interface', 'color-scheme', 'default']]);
} catch (err) {
  failures.push(`unexpected error: ${err?.stack || err}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

for (const f of failures) console.log(`  ✗ ${f}`);
console.log(`${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
