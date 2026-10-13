// First-login gaming apps (main/ipc/firstlogin.js + core/features/gaming-setup.js), requested by the installer's
// « Jeux » step through ~/.config/aurora/first-login/gaming.json.
//   Backend (no Electron): gaming.json validation, backoff, then the real Store path — main/ipc/store.js
//   (api.storeService) -> main/lib/sources/flathub.js in real mode against a stub `flatpak` (AURORA_FLATPAK, never the
//   machine's flatpak): success (argv, order, progress, gaming.done.json, runs once), offline then online, one app
//   failing then « Réessayer », cancel (stops after the current app, later sessions do not restart), already-done
//   file, invalid files, attempts cap, the Logithèque busy (EBUSY), the IPC channels.
//   Shell (Electron, dev): stub Flathub source (test/fixtures/gaming-setup, AURORA_STORE_SOURCES_DIR): one progress
//   notification « Installation des applications de jeu » / « Steam (2/4)… » with Masquer / Annuler, the notification
//   center, the ready notification, the Logithèque's Installées; offline wait, a failure with Réessayer / Ouvrir la
//   Logithèque, Annuler. Screenshots (FR, 1280x720) in test/out/gaming-setup-*.png.
// Usage:  cd aurora-os/shell && xvfb-run -a -s "-screen 0 1600x900x24" node test/gaming-setup.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const STUB_SOURCES = path.join(ROOT, 'test', 'fixtures', 'gaming-setup');

let passed = 0;
const failures = [];
function check(name, actual, expected) {
  const ok = typeof expected === 'function' ? !!expected(actual) : Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else failures.push(`${name}\n      expected: ${typeof expected === 'function' ? '(predicate)' : JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
  return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, { timeout = 10000, every = 50 } = {}) {
  const end = Date.now() + timeout;
  let v;
  while (Date.now() < end) {
    v = await Promise.resolve().then(fn).catch(() => null);
    if (v) return v;
    await sleep(every);
  }
  return v;
}

const STEAM = 'com.valvesoftware.Steam';
const HEROIC = 'com.heroicgameslauncher.hgl';
const LUTRIS = 'net.lutris.Lutris';
const PUP = 'net.davidotek.pupgui2';
const DEFAULT4 = [STEAM, HEROIC, LUTRIS, PUP];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-gaming-'));
const writeReq = (home, doc, name = 'gaming.json') => {
  const dir = path.join(home, '.config', 'aurora', 'first-login');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, typeof doc === 'string' ? doc : JSON.stringify(doc));
  return file;
};
const req = (apps = DEFAULT4, extra = {}) => ({ version: 1, apps, requestedAt: '2026-10-13T09:00:00.000Z', ...extra });
const fl = (home, name) => path.join(home, '.config', 'aurora', 'first-login', name);

try {
  // ------------------------------------------------------------------ pure helpers
  const FL = require(path.join(ROOT, 'main', 'ipc', 'firstlogin.js'));
  const { parseGaming, backoff, GAMING_APPS } = FL.parsers;
  check('allow-list: the six installer apps', GAMING_APPS.map((a) => a.id), [STEAM, HEROIC, LUTRIS, PUP, 'com.usebottles.bottles', 'com.discordapp.Discord']);
  check('parse: valid request', parseGaming(req()), { apps: DEFAULT4, requestedAt: '2026-10-13T09:00:00.000Z', attempts: 0, cancelledAt: null });
  check('parse: duplicates dropped, order kept', parseGaming(req([LUTRIS, STEAM, LUTRIS])).apps, [LUTRIS, STEAM]);
  check('parse: empty list is valid (nothing to do)', parseGaming(req([])).apps, []);
  check(
    'parse: invalid documents rejected',
    [null, [], 'x', { apps: [STEAM] }, req([STEAM], { version: 2 }), req(['org.evil.App']), req([STEAM, 'org.mozilla.firefox']), req([`${STEAM};rm -rf ~`]), req([42]), { version: 1, apps: 'com.valvesoftware.Steam' }, req(Array(13).fill(STEAM))].map((d) => parseGaming(d)),
    Array(11).fill(null),
  );
  check('parse: bad optional fields ignored', parseGaming(req([STEAM], { requestedAt: '<script>', attempts: -4, cancelledAt: 12 })), { apps: [STEAM], requestedAt: null, attempts: 0, cancelledAt: null });
  check('backoff: grows, capped at 5 minutes', [0, 1, 2, 3, 4, 9].map((n) => backoff(n)), [10000, 30000, 60000, 120000, 300000, 300000]);
  check('backoff: test base', [backoff(0, 100), backoff(1, 100)], [100, 300]);

  // ------------------------------------------------------------------ stub flatpak + the real Store path
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin);
  const FAKE = path.join(bin, 'flatpak');
  const LOG = path.join(tmp, 'flatpak.log');
  const STATE = path.join(tmp, 'flatpak.installed');
  const OFFLINE = path.join(tmp, 'offline');
  const FAILS = path.join(tmp, 'fail');
  fs.writeFileSync(
    FAKE,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_LOG"
net() { echo "error: Unable to load summary from remote flathub: Could not resolve hostname" >&2; exit 1; }
case "$1" in
  remote-add) [ -e "$FAKE_OFFLINE" ] && net; exit 0 ;;
  list) [ -f "$FAKE_STATE" ] && while read -r id; do printf '%s\\t1.0\\t1.0 GB\\n' "$id"; done < "$FAKE_STATE"; exit 0 ;;
  install) [ -e "$FAKE_OFFLINE" ] && net
           [ -f "$FAKE_FAIL" ] && grep -qx "$6" "$FAKE_FAIL" && { echo "Installing 1/1…"; echo "error: Failed to install $6: Error deploying" >&2; exit 1; }
           [ -n "$FAKE_SLEEP" ] && sleep "$FAKE_SLEEP"
           printf 'Looking for matches…\\nInstalling 1/1… 40%%\\rInstalling 1/1… 100%%\\n'
           echo "$6" >> "$FAKE_STATE"; exit 0 ;;
esac
exit 3
`,
  );
  fs.chmodSync(FAKE, 0o755);
  // store.js loads its source modules from AURORA_STORE_SOURCES_DIR (dev): only Flathub, the real module.
  const srcDir = path.join(tmp, 'sources');
  fs.mkdirSync(srcDir);
  fs.writeFileSync(path.join(srcDir, 'flathub.js'), `module.exports = require(${JSON.stringify(path.join(ROOT, 'main', 'lib', 'sources', 'flathub.js'))});\n`);
  const realHome = path.join(tmp, 'home');
  fs.mkdirSync(realHome);
  Object.assign(process.env, {
    HOME: realHome,
    AURORA_REAL_BACKENDS: '1',
    AURORA_STORE_SOURCES_DIR: srcDir,
    AURORA_FLATPAK: FAKE,
    FLATPAK_USER_DIR: path.join(realHome, '.local', 'share', 'flatpak'),
    FAKE_LOG: LOG,
    FAKE_STATE: STATE,
    FAKE_OFFLINE: OFFLINE,
    FAKE_FAIL: FAILS,
  });
  const registerStore = require(path.join(ROOT, 'main', 'ipc', 'store.js'));
  // A fresh "session": the Store registered on a fake IPC api (re-inits the flathub module), broadcasts recorded.
  function session() {
    const handlers = new Map();
    const events = [];
    const api = {
      DEV: true,
      env: { lang: 'fr', mode: 'shell', live: false },
      handle: (ch, fn) => handlers.set(ch, fn),
      on() {},
      broadcast: (ch, p) => events.push([ch, JSON.parse(JSON.stringify(p))]),
      error: (m, code) => Object.assign(new Error(m), { code }),
    };
    FL(api); // firstlogin.js loads before store.js (alphabetical): it must look the Store up at call time
    registerStore(api);
    return { api, handlers, events, call: (ch, ...a) => handlers.get(ch)(...a) };
  }
  const reset = () => {
    for (const f of [LOG, STATE, OFFLINE, FAILS]) fs.rmSync(f, { force: true });
    fs.rmSync(path.join(realHome, '.config'), { recursive: true, force: true });
    fs.writeFileSync(LOG, '');
  };
  const logLines = () => fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean);
  const installs = () => logLines().filter((l) => l.startsWith('install ')).map((l) => l.split(' ').at(-1));
  const gaming = (s, opts = {}) => FL.createGamingSetup({ home: realHome, store: s.api.storeService, broadcast: s.api.broadcast, retryBase: 80, startDelay: 0, ...opts });
  const states = (s) => s.events.filter(([ch]) => ch === 'firstlogin:gaming').map(([, p]) => p);

  // ---- success
  reset();
  let s = session();
  check('ipc: channels registered', ['status', 'start', 'retry', 'cancel', 'online'].every((c) => s.handlers.has(`firstlogin:gaming:${c}`)), true);
  check('ipc: no request -> state none, no auto start', await s.call('firstlogin:gaming:status'), (st) => st.state === 'none' && st.autoStart === false && st.apps.length === 0);
  writeReq(realHome, req());
  s = session();
  const st0 = await s.call('firstlogin:gaming:status');
  check('status: pending, 4 apps with their names, auto start', [st0.state, st0.total, st0.apps.map((a) => a.name), st0.autoStart], ['pending', 4, ['Steam', 'Heroic Games Launcher', 'Lutris', 'ProtonUp-Qt'], true]);
  const g1 = gaming(s);
  g1.start();
  await g1.idle();
  const end1 = g1.status();
  check('success: done, every app installed, 100 %', [end1.state, end1.apps.map((a) => a.status), end1.percent], ['done', Array(4).fill('installed'), 100]);
  check('success: remote added for the user first, then the apps one after the other (--user, no shell)', logLines().filter((l) => !l.startsWith('list')), [
    'remote-add --user --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo',
    ...DEFAULT4.map((id) => `install --user -y --noninteractive flathub ${id}`),
  ]);
  const runStates = states(s).filter((p) => p.state === 'running');
  check('success: progress states — index 1..4, overall percent never goes back', [[...new Set(runStates.map((p) => p.index))], runStates.map((p) => p.percent).every((v, i, a) => i === 0 || v >= a[i - 1])], [[1, 2, 3, 4], true]);
  check('success: "Steam (1/4)" then "Heroic Games Launcher (2/4)" data', runStates.find((p) => p.index === 2)?.apps[1], (a) => a.status === 'installing' && a.name === 'Heroic Games Launcher');
  check('success: same path as the Logithèque (store:progress per app, store:changed after each install)', [new Set(s.events.filter(([ch, p]) => ch === 'store:progress' && p.kind === 'install').map(([, p]) => p.id)).size, s.events.filter(([ch, p]) => ch === 'store:changed' && p.action === 'install').length], [4, 4]);
  check('success: gaming.json renamed to gaming.done.json (completedAt)', [fs.existsSync(fl(realHome, 'gaming.json')), JSON.parse(fs.readFileSync(fl(realHome, 'gaming.done.json'), 'utf8'))], (v) => v[0] === false && v[1].version === 1 && v[1].apps.length === 4 && !!v[1].completedAt);
  check('success: done file mode 0644', fs.statSync(fl(realHome, 'gaming.done.json')).mode & 0o777, 0o644);
  fs.writeFileSync(LOG, '');
  g1.start();
  await g1.idle();
  check('success: start again in the same session -> nothing runs', installs(), []);
  s = session();
  const st1 = await s.call('firstlogin:gaming:status');
  await s.call('firstlogin:gaming:start');
  check('next session: nothing pending, nothing installed again', [st1.state, st1.autoStart, installs()], ['none', false, []]);

  // ---- offline, then the network comes back
  reset();
  writeReq(realHome, req([STEAM, LUTRIS]));
  fs.writeFileSync(OFFLINE, '');
  s = session();
  const g2 = gaming(s, { retryBase: 60000 });
  g2.start();
  const waiting = await until(() => (g2.status().state === 'waiting' ? g2.status() : null));
  check('offline: waits (no app marked failed), next try scheduled', [waiting?.state, waiting?.apps.map((a) => a.status), waiting?.retryAt > Date.now()], ['waiting', ['pending', 'pending'], true]);
  check('offline: time spent offline is not counted as a failed attempt (attempts cap)', JSON.parse(fs.readFileSync(fl(realHome, 'gaming.json'), 'utf8')).attempts ?? 0, 0);
  g2.online();
  await sleep(150);
  check('offline: online() while still offline waits again (longer backoff)', [g2.status().state, logLines().filter((l) => l.startsWith('remote-add')).length >= 2], ['waiting', true]);
  fs.rmSync(OFFLINE);
  g2.online();
  await g2.idle();
  check('offline -> online: resumes at once and finishes', [g2.status().state, installs(), fs.existsSync(fl(realHome, 'gaming.done.json'))], ['done', [STEAM, LUTRIS], true]);
  // backoff timer alone (no online event)
  reset();
  writeReq(realHome, req([PUP]));
  fs.writeFileSync(OFFLINE, '');
  s = session();
  const g2b = gaming(s, { retryBase: 120 });
  g2b.start();
  await until(() => g2b.status().state === 'waiting');
  fs.rmSync(OFFLINE);
  await g2b.idle();
  check('offline: retried by the backoff timer alone', [g2b.status().state, installs()], ['done', [PUP]]);

  // ---- one app failing, then « Réessayer »
  reset();
  writeReq(realHome, req());
  fs.writeFileSync(FAILS, `${HEROIC}\n`);
  s = session();
  const g3 = gaming(s);
  g3.start();
  await g3.idle();
  const end3 = g3.status();
  check('failure: the other apps still installed, state failed', [end3.state, end3.apps.map((a) => a.status)], ['failed', ['installed', 'failed', 'installed', 'installed']]);
  check('failure: readable French error + code', end3.apps[1], (a) => a.code === 'EFLATPAK' && /Échec de Flatpak/.test(a.error));
  const kept = JSON.parse(fs.readFileSync(fl(realHome, 'gaming.json'), 'utf8'));
  check('failure: gaming.json kept (attempts, lastError), no done file', [kept.version, kept.apps, kept.attempts, kept.lastError.apps, fs.existsSync(fl(realHome, 'gaming.done.json'))], [1, DEFAULT4, 1, [{ id: HEROIC, code: 'EFLATPAK' }], false]);
  fs.rmSync(FAILS);
  fs.writeFileSync(LOG, '');
  await s.call('firstlogin:gaming:status');
  g3.retry();
  await g3.idle();
  check('retry: only the failed app installed again, then done', [g3.status().state, installs(), fs.existsSync(fl(realHome, 'gaming.done.json'))], ['done', [HEROIC], true]);
  // a later session retries on its own (attempts < 3), not after 3 attempts
  reset();
  writeReq(realHome, req([STEAM], { attempts: 3 }));
  s = session();
  check('attempts cap: 3 failed sessions -> no auto start', (await s.call('firstlogin:gaming:status')).autoStart, false);
  await s.call('firstlogin:gaming:start');
  await sleep(100);
  check('attempts cap: start does nothing', installs(), []);

  // ---- cancel: stops after the current app
  reset();
  writeReq(realHome, req());
  process.env.FAKE_SLEEP = '0.4';
  s = session();
  const g4 = gaming(s);
  g4.start();
  await until(() => g4.status().apps[0].status === 'installing');
  const c = g4.cancel();
  check('cancel: cancelling while Steam installs', c.state, 'cancelling');
  await g4.idle();
  const end4 = g4.status();
  check('cancel: Steam finished, the rest kept pending', [end4.state, end4.apps.map((a) => a.status), installs()], ['cancelled', ['installed', 'pending', 'pending', 'pending'], [STEAM]]);
  check('cancel: gaming.json kept with cancelledAt', JSON.parse(fs.readFileSync(fl(realHome, 'gaming.json'), 'utf8')), (d) => d.version === 1 && d.apps.length === 4 && !!d.cancelledAt);
  delete process.env.FAKE_SLEEP;
  s = session();
  const st4 = await s.call('firstlogin:gaming:status');
  await s.call('firstlogin:gaming:start');
  await sleep(150);
  check('cancel: next session does not restart on its own', [st4.state, st4.autoStart, installs()], ['cancelled', false, [STEAM]]);
  fs.writeFileSync(LOG, '');
  const g4b = gaming(s);
  g4b.retry();
  await g4b.idle();
  check('cancel: « Réessayer » installs the rest only', [g4b.status().state, installs()], ['done', [HEROIC, LUTRIS, PUP]]);
  // cancel while waiting for the network
  reset();
  writeReq(realHome, req([STEAM]));
  fs.writeFileSync(OFFLINE, '');
  s = session();
  const g4c = gaming(s, { retryBase: 60000 });
  g4c.start();
  await until(() => g4c.status().state === 'waiting');
  g4c.cancel();
  await g4c.idle();
  check('cancel while offline: stops at once', [g4c.status().state, g4c.status().apps[0].status], ['cancelled', 'pending']);

  // ---- already done / invalid files
  reset();
  writeReq(realHome, req());
  writeReq(realHome, { ...req(), completedAt: '2026-10-01T10:00:00Z' }, 'gaming.done.json');
  s = session();
  const st5 = await s.call('firstlogin:gaming:status');
  await s.call('firstlogin:gaming:start');
  await sleep(100);
  check('already done: gaming.done.json wins, nothing runs', [st5.state, st5.autoStart, installs()], ['none', false, []]);
  for (const [name, content] of [
    ['unknown app id', JSON.stringify(req([STEAM, 'org.evil.Miner']))],
    ['version 2', JSON.stringify({ ...req(), version: 2 })],
    ['not JSON', '{"version":1,"apps":['],
    ['apps not a list', JSON.stringify({ version: 1, apps: STEAM })],
  ]) {
    reset();
    writeReq(realHome, content);
    s = session();
    const st6 = await s.call('firstlogin:gaming:status');
    await s.call('firstlogin:gaming:start');
    await sleep(60);
    check(`invalid (${name}): nothing runs, set aside as gaming.invalid.json`, [st6.state, st6.autoStart, installs(), fs.existsSync(fl(realHome, 'gaming.json')), fs.existsSync(fl(realHome, 'gaming.invalid.json'))], ['invalid', false, [], false, true]);
  }
  reset();
  const target = path.join(tmp, 'elsewhere.json');
  fs.writeFileSync(target, JSON.stringify(req()));
  fs.mkdirSync(path.join(realHome, '.config', 'aurora', 'first-login'), { recursive: true });
  fs.symlinkSync(target, fl(realHome, 'gaming.json'));
  s = session();
  check('invalid (symlink): refused', (await s.call('firstlogin:gaming:status')).state, 'invalid');
  reset();
  writeReq(realHome, req([]));
  s = session();
  const g7 = gaming(s);
  g7.start();
  await g7.idle();
  check('empty list: marked done without any install', [g7.status().state, installs(), fs.existsSync(fl(realHome, 'gaming.done.json'))], ['done', [], true]);

  // ---- the Logithèque is busy with another install (EBUSY): waits, then goes on
  reset();
  writeReq(realHome, req([LUTRIS]));
  process.env.FAKE_SLEEP = '0.4';
  s = session();
  const other = s.api.storeService.install('flathub', 'org.gimp.GIMP');
  await sleep(50);
  const g8 = gaming(s, { retryBase: 100 });
  g8.start();
  await other;
  await g8.idle();
  check('busy: waits for the Logithèque, then installs', [g8.status().state, installs()], ['done', ['org.gimp.GIMP', LUTRIS]]);
  delete process.env.FAKE_SLEEP;
} catch (err) {
  failures.push(`unexpected error: ${err?.stack || err}`);
}

// ------------------------------------------------------------------ the shell (Electron, dev mode)
for (const k of ['AURORA_REAL_BACKENDS', 'AURORA_STORE_SOURCES_DIR', 'AURORA_FLATPAK', 'FLATPAK_USER_DIR', 'FAKE_SLEEP']) delete process.env[k];
if (process.env.GAMING_BACKEND_ONLY !== '1') {
  const { launchShell } = await import('./lib.mjs');
  const shells = [];
  const ctlDir = path.join(tmp, 'ctl');
  fs.mkdirSync(ctlDir);
  const ENV = { AURORA_STORE_SOURCES_DIR: STUB_SOURCES, AURORA_GAMING_STUB_CTL: ctlDir, AURORA_FIRSTLOGIN_DELAY_MS: '600', AURORA_FIRSTLOGIN_RETRY_MS: '1500', AURORA_GAMING_STUB_STEP_MS: '220' };
  const toastText = (s) => s.page.evaluate(() => [...document.querySelectorAll('#toasts .toast:not(.leaving)')].map((t) => t.innerText).join('\n---\n'));
  const toastWith = (s, re) => until(async () => re.test(await toastText(s)), { timeout: 30000, every: 100 });
  const toastBtn = (s, title, label) => s.page.locator('#toasts .toast:not(.leaving)', { hasText: title }).locator('.toast-actions button', { hasText: label });
  try {
    // ---- 1. four apps: progress, Masquer, notification center, ready, Logithèque › Installées
    const home1 = path.join(tmp, 'shell-home-1');
    writeReq(home1, req());
    let s = await launchShell({ home: home1, lang: 'fr', theme: 'light', size: '1280x720', env: ENV });
    shells.push(s);
    check('shell: progress notification « Installation des applications de jeu »', await toastWith(s, /Installation des applications de jeu/), true);
    check('shell: « Heroic Games Launcher (2/4)… » while the second app installs', await toastWith(s, /Heroic Games Launcher \(2\/4\)…/), true);
    const prog = s.page.locator('#toasts .toast:not(.leaving)', { hasText: 'Installation des applications de jeu' });
    check('shell: one progress notification, with a bar and Masquer / Annuler', [await prog.count(), await prog.locator('.notif-progress[role=progressbar]').count(), await prog.locator('.toast-actions button').allInnerTexts()], [1, 1, ['Masquer', 'Annuler']]);
    await s.page.waitForTimeout(300);
    await s.shot('gaming-setup-progress-fr');
    const pct1 = Number(await prog.locator('.notif-progress').getAttribute('aria-valuenow'));
    await s.page.waitForTimeout(900);
    const pct2 = Number(await prog.locator('.notif-progress').getAttribute('aria-valuenow'));
    check('shell: the bar moves (overall percent)', pct2 > pct1 && pct1 >= 25, true);
    check('shell: still one notification in the history while it moves', await s.aurora(() => window.__aurora.notifications.list().filter((n) => /applications de jeu/.test(n.title)).length), 1);
    await toastBtn(s, 'Installation des applications de jeu', 'Masquer').click();
    await s.page.waitForTimeout(400);
    check('shell: Masquer hides the toast, the notification stays in the center', [/Installation des applications de jeu/.test(await toastText(s)), await s.aurora(() => window.__aurora.notifications.list().some((n) => n.title === 'Installation des applications de jeu'))], [false, true]);
    await s.aurora(() => window.__aurora.shell.emit('notifications:open'));
    await s.page.waitForSelector('.nc-item', { timeout: 5000 });
    await s.page.waitForTimeout(500);
    const ncItem = s.page.locator('.nc-item', { hasText: 'Installation des applications de jeu' });
    check('shell: center item with progress and Annuler (no Masquer there)', [await ncItem.count(), await ncItem.locator('.notif-progress').count(), await ncItem.locator('.nc-actions button').allInnerTexts()], [1, 1, ['Annuler']]);
    await s.shot('gaming-setup-center-fr');
    await s.page.keyboard.press('Escape');
    await s.page.waitForTimeout(300);
    check('shell: ready notification at the end', await toastWith(s, /Vos applications de jeu sont prêtes/), true);
    check('shell: ready text lists the apps (Lanceur)', await toastText(s), (txt) => /Steam, Heroic Games Launcher, Lutris et ProtonUp-Qt vous attendent dans le Lanceur/.test(txt));
    check('shell: the progress notification is gone', await s.aurora(() => window.__aurora.notifications.list().filter((n) => n.title === 'Installation des applications de jeu').length), 0);
    await s.page.waitForTimeout(400);
    await s.shot('gaming-setup-done-fr');
    check('shell: gaming.done.json written, gaming.json gone', [fs.existsSync(fl(home1, 'gaming.done.json')), fs.existsSync(fl(home1, 'gaming.json'))], [true, false]);
    await s.page.locator('#toasts .toast:not(.leaving)', { hasText: 'Vos applications de jeu sont prêtes' }).locator('.toast-title').click();
    await s.page.waitForSelector('.app-store', { timeout: 15000 });
    const installedNames = await until(async () => {
      const txt = await s.page.locator('.app-store').innerText();
      return ['Steam', 'Heroic Games Launcher', 'Lutris', 'ProtonUp-Qt'].every((n) => txt.includes(n)) ? txt : null;
    }, { timeout: 15000 });
    check('shell: the apps are in the Logithèque › Installées', !!installedNames, true);
    await s.page.waitForTimeout(500);
    await s.shot('gaming-setup-store-installed-fr');
    const errors1 = s.logs.filter((l) => /^\[(error|pageerror)\]/.test(l) && !/favicon|net::ERR/.test(l));
    check('shell: no console errors', errors1, []);
    await s.close();
    shells.pop();
    // next session: nothing happens again
    s = await launchShell({ home: home1, lang: 'fr', size: '1280x720', env: ENV });
    shells.push(s);
    await s.page.waitForTimeout(1500);
    check('shell: next session shows nothing', /applications de jeu/.test(await toastText(s)), false);
    await s.close();
    shells.pop();

    // ---- 2. offline, then one app failing, Réessayer, Ouvrir la Logithèque
    const home2 = path.join(tmp, 'shell-home-2');
    writeReq(home2, req([STEAM, HEROIC]));
    fs.writeFileSync(path.join(ctlDir, 'offline'), '');
    fs.writeFileSync(path.join(ctlDir, 'fail'), `${HEROIC}\n`);
    s = await launchShell({ home: home2, lang: 'fr', theme: 'dark', size: '1280x720', env: ENV });
    shells.push(s);
    check('shell offline: waiting message', await toastWith(s, /En attente d’une connexion Internet/), true);
    await s.page.waitForTimeout(300);
    await s.shot('gaming-setup-offline-fr');
    fs.rmSync(path.join(ctlDir, 'offline'));
    check('shell offline -> online: installs again (backoff)', await toastWith(s, /Steam \(1\/2\)…/), true);
    check('shell failure: notification with Réessayer / Ouvrir la Logithèque', await toastWith(s, /L’installation de Heroic Games Launcher n’a pas abouti/), true);
    const failToast = s.page.locator('#toasts .toast:not(.leaving)', { hasText: 'n’a pas abouti' });
    check('shell failure: buttons and readable reason', [await failToast.locator('.toast-actions button').allInnerTexts(), /Échec de Flatpak/.test(await failToast.innerText()), /Les autres applications sont prêtes/.test(await failToast.innerText())], [['Réessayer', 'Ouvrir la Logithèque'], true, true]);
    await s.page.waitForTimeout(300);
    await s.shot('gaming-setup-failed-fr');
    fs.rmSync(path.join(ctlDir, 'fail'));
    await toastBtn(s, 'n’a pas abouti', 'Réessayer').click();
    check('shell retry: only Heroic, then ready', await toastWith(s, /Vos applications de jeu sont prêtes/), true);
    check('shell retry: done file', fs.existsSync(fl(home2, 'gaming.done.json')), true);
    await s.close();
    shells.pop();

    // ---- 3. Annuler, then « Ouvrir la Logithèque » from the notification center
    const home3 = path.join(tmp, 'shell-home-3');
    writeReq(home3, req([STEAM, LUTRIS, PUP]));
    s = await launchShell({ home: home3, lang: 'fr', theme: 'light', size: '1280x720', env: { ...ENV, AURORA_GAMING_STUB_STEP_MS: '300' } });
    shells.push(s);
    await toastWith(s, /Steam \(1\/3\)…/);
    await toastBtn(s, 'Installation des applications de jeu', 'Annuler').click();
    check('shell cancel: stopped notification after Steam', await toastWith(s, /Installation des applications de jeu arrêtée/), true);
    check('shell cancel: the rest is listed', await toastText(s), (txt) => /Il reste Lutris et ProtonUp-Qt à installer/.test(txt));
    await s.page.waitForTimeout(300);
    await s.shot('gaming-setup-cancelled-fr');
    check('shell cancel: gaming.json kept (cancelledAt)', JSON.parse(fs.readFileSync(fl(home3, 'gaming.json'), 'utf8')).cancelledAt, (v) => typeof v === 'string');
    await s.page.evaluate(() => document.querySelectorAll('#toasts .toast .toast-x').forEach((b) => b.click()));
    await s.aurora(() => window.__aurora.shell.emit('notifications:open'));
    const stopped = s.page.locator('.nc-item', { hasText: 'Installation des applications de jeu arrêtée' });
    await stopped.waitFor({ timeout: 5000 });
    check('shell cancel: Réessayer / Ouvrir la Logithèque in the center', await stopped.locator('.nc-actions button').allInnerTexts(), ['Réessayer', 'Ouvrir la Logithèque']);
    await stopped.locator('.nc-actions button', { hasText: 'Réessayer' }).click();
    check('shell cancel -> Réessayer: the rest installed', await toastWith(s, /Lutris et ProtonUp-Qt vous attendent|Steam, Lutris et ProtonUp-Qt vous attendent/), true);
    const errors3 = s.logs.filter((l) => /^\[(error|pageerror)\]/.test(l) && !/favicon|net::ERR/.test(l));
    check('shell: no console errors (cancel run)', errors3, []);
  } catch (err) {
    failures.push(`unexpected shell error: ${err?.stack || err}`);
  } finally {
    for (const s of shells) await s.close().catch(() => {});
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
for (const f of failures) console.log(`  ✗ ${f}`);
console.log(`${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
