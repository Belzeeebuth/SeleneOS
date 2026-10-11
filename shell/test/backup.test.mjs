// Backup tests — drive the real Electron shell with Playwright and real rsync on temporary folders.
//   Defaults and empty state, path validation (sources outside home, missing destination, destination inside a
//   source, traversal in browse / restore / delete), first backup through the UI (excludes, manifest, config file),
//   incremental second backup (hard links to unchanged files), progress events + cancel (no partial left),
//   snapshots list, browsing with the keyboard, restore to the original place (with the overwrite question) and to
//   a chosen folder, keep last N (automatic prune + "keep only" button), delete with confirmation, reminder in
//   shell.reminders, French + dark theme, console errors.
// Usage:  cd aurora-os/shell && xvfb-run -a -s "-screen 0 1600x900x24" node test/backup.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchShell, ROOT } from './lib.mjs';

const DOCS = path.join(ROOT, '..', 'docs', 'screenshots');
fs.mkdirSync(DOCS, { recursive: true });

let passed = 0;
const failures = [];
function check(name, actual, expected) {
  const ok = typeof expected === 'function' ? !!expected(actual) : Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else failures.push(`${name}\n      expected: ${typeof expected === 'function' ? '(predicate)' : JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
  return ok;
}
async function section(name, fn) {
  const t0 = Date.now();
  const before = failures.length;
  try {
    await fn();
    console.log(`  ${failures.length === before ? '✓' : '✗'} ${name} (${Date.now() - t0} ms)`);
  } catch (err) {
    failures.push(`${name}: threw ${err?.stack || err}`);
    console.log(`  ✗ ${name}: ${err?.message || err}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WIN = '.win.app-backup';
const DLG = `${WIN} .dialog-layer:not(.closing) .dialog, .dialog-layer:not(.closing) .dialog`;

function BK(s, fn, arg) {
  return s.page.evaluate(`(async () => { const el = document.querySelector(${JSON.stringify(WIN)}); return (${fn.toString()})(el && el.__backup, ${JSON.stringify(arg ?? null)}); })()`);
}
const invoke = (s, ch, ...args) => BK(s, (app, a) => app.api.invoke(a.ch, ...a.args).then((v) => ({ ok: true, v }), (e) => ({ ok: false, code: e.code, message: e.message })), { ch, args });
async function until(s, fn, { timeout = 20000, step = 100, label = 'condition', arg } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = await BK(s, fn, arg).catch((e) => `ERR ${e.message}`);
    if (last && !(typeof last === 'string' && last.startsWith('ERR'))) return last;
    await sleep(step);
  }
  throw new Error(`timed out waiting for ${label} (last: ${JSON.stringify(last)})`);
}
const text = (s, sel) => s.page.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(`${WIN} ${sel}`)}); return e ? e.textContent.trim() : null; })()`);
const count = (s, sel) => s.page.evaluate(`document.querySelectorAll(${JSON.stringify(`${WIN} ${sel}`)}).length`);
async function shot(s, name) {
  await sleep(400);
  const rect = await s.page.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(WIN)}).getBoundingClientRect(); return { x: Math.max(0, r.x - 1), y: Math.max(0, r.y - 1), width: r.width + 2, height: r.height + 2 }; })()`);
  await s.page.screenshot({ path: path.join(DOCS, `backup-${name}.png`), clip: rect });
}
async function dialogButton(s, label) {
  await s.page.waitForSelector('.dialog-layer:not(.closing) .dialog', { timeout: 6000 });
  await s.page.locator('.dialog-layer:not(.closing) .dialog .dialog-footer .btn', { hasText: label }).first().click();
  await sleep(300);
}
const ino = (p) => fs.statSync(p).ino;
const snapRoot = (dest) => path.join(dest, 'AuroraBackup');
const snaps = (dest) => (fs.existsSync(snapRoot(dest)) ? fs.readdirSync(snapRoot(dest)).sort() : []);

// ---------------------------------------------------------------- fixtures
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-bk-home-'));
const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-bk-dest-'));
const other = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-bk-other-'));
for (const d of ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Music', 'Videos']) fs.mkdirSync(path.join(home, d), { recursive: true });
fs.mkdirSync(path.join(home, 'Documents', 'Work', 'node_modules', 'pkg'), { recursive: true });
fs.mkdirSync(path.join(home, 'Documents', '.cache'), { recursive: true });
fs.writeFileSync(path.join(home, 'Documents', 'report.txt'), 'version 1');
fs.writeFileSync(path.join(home, 'Documents', 'Work', 'plan.md'), '# plan');
fs.writeFileSync(path.join(home, 'Documents', 'Work', 'node_modules', 'pkg', 'index.js'), 'x');
fs.writeFileSync(path.join(home, 'Documents', '.cache', 'junk'), 'junk');
fs.writeFileSync(path.join(home, 'Pictures', 'photo.jpg'), Buffer.alloc(64 * 1024, 7));
fs.writeFileSync(path.join(home, 'Music', 'song.mp3'), Buffer.alloc(32 * 1024, 3));

console.log('Backup tests');
let s = await launchShell({ home, keepHome: true, open: ['backup'], lang: 'en', theme: 'light', env: { AURORA_BACKUP_BWLIMIT: '' } });
await s.page.waitForSelector(`${WIN} .bk-home`, { timeout: 20000 });

await section('defaults and empty state', async () => {
  check('window open', await count(s, '.bk'), 1);
  check('three nav items', await count(s, '.bk-nav .nav-item'), 3);
  check('five default folders', await count(s, '.bk-src'), 5);
  check('default folder names', await BK(s, (app) => app.cfg.sources.map((p) => p.split('/').pop())), ['Documents', 'Pictures', 'Music', 'Videos', 'Desktop']);
  check('never backed up', await text(s, '.bk-last'), 'Never backed up');
  check('back up disabled without destination', await s.page.locator(`${WIN} .bk-start`).isDisabled(), true);
  check('no destination text', await text(s, '.bk-dest-path'), 'No destination chosen');
  check('rsync detected', await BK(s, (app) => app.rsync), true);
});

await section('path validation', async () => {
  let r = await invoke(s, 'backup:setConfig', { sources: ['/etc'] });
  check('source outside home refused', r.code, 'EOUTSIDE');
  r = await invoke(s, 'backup:setConfig', { sources: [`${home}/Documents/../../`] });
  check('source escaping home with .. refused', r.code, 'EOUTSIDE');
  r = await invoke(s, 'backup:setConfig', { sources: [home] });
  check('home itself refused', r.code, 'EOUTSIDE');
  r = await invoke(s, 'backup:setConfig', { sources: [`${home}/Nope`] });
  check('missing source refused', r.code, 'ESOURCE');
  r = await invoke(s, 'backup:setConfig', { dest: path.join(dest, 'missing') });
  check('missing destination refused', r.code, 'EDEST');
  r = await invoke(s, 'backup:setConfig', { dest: path.join(home, 'Documents') });
  check('destination inside a source refused', r.code, 'EINSIDE');
  fs.mkdirSync(path.join(home, 'Pictures', 'bk'), { recursive: true });
  r = await invoke(s, 'backup:setConfig', { dest: path.join(home, 'Pictures', 'bk') });
  check('destination in a sub-folder of a source refused', r.code, 'EINSIDE');
  r = await invoke(s, 'backup:setConfig', { dest: 'relative/path' });
  check('relative destination refused', r.code, 'EDEST');
  r = await invoke(s, 'backup:start', {});
  check('start without destination', r.code, 'ENODEST');
  // through the UI: an error infobar in plain words
  await BK(s, (app) => app.addSourcePath('/usr'));
  check('UI error infobar', await text(s, '.bk-msg'), (t) => /outside your home folder/.test(t || ''));
  check('sources unchanged', await BK(s, (app) => app.cfg.sources.length), 5);
  fs.rmSync(path.join(home, 'Pictures', 'bk'), { recursive: true });
});

await section('choose destination + add folder', async () => {
  check('setDest ok', await BK(s, (app, d) => app.setDest(d), dest), true);
  check('destination shown', await text(s, '.bk-dest-path'), dest);
  check('back up enabled', await s.page.locator(`${WIN} .bk-start`).isDisabled(), false);
  fs.mkdirSync(path.join(home, 'Projects'), { recursive: true });
  fs.writeFileSync(path.join(home, 'Projects', 'main.c'), 'int main(){}');
  check('add folder', await BK(s, (app, p) => app.addSourcePath(p), path.join(home, 'Projects')), true);
  check('six folders', await count(s, '.bk-src'), 6);
  // remove through the row button
  await s.page.click(`${WIN} .bk-src[data-path="${path.join(home, 'Videos')}"] .bk-remove`);
  await sleep(400);
  check('folder removed', await count(s, '.bk-src'), 5);
  const cfg = JSON.parse(fs.readFileSync(path.join(home, '.config', 'aurora', 'backup.json'), 'utf8'));
  check('settings file has destination', cfg.dest, dest);
  check('settings file has sources', cfg.sources.map((p) => path.basename(p)), ['Documents', 'Pictures', 'Music', 'Desktop', 'Projects']);
});

let first;
await section('first backup through the UI', async () => {
  await s.page.click(`${WIN} .bk-start`);
  await until(s, (app) => !app.run && app.message, { label: 'backup end' });
  check('success message', await text(s, '.bk-msg'), (t) => /Backup finished/.test(t || ''));
  const list = snaps(dest);
  check('one snapshot folder', list.length, 1);
  first = path.join(snapRoot(dest), list[0]);
  check('snapshot name is dated', list[0], (n) => /^\d{4}-\d{2}-\d{2}_\d{6}$/.test(n));
  check('file copied', fs.readFileSync(path.join(first, 'Documents', 'report.txt'), 'utf8'), 'version 1');
  check('nested file copied', fs.existsSync(path.join(first, 'Documents', 'Work', 'plan.md')), true);
  check('added folder copied', fs.existsSync(path.join(first, 'Projects', 'main.c')), true);
  check('node_modules excluded', fs.existsSync(path.join(first, 'Documents', 'Work', 'node_modules')), false);
  check('.cache excluded', fs.existsSync(path.join(first, 'Documents', '.cache')), false);
  check('removed folder not copied', fs.existsSync(path.join(first, 'Videos')), false);
  const m = JSON.parse(fs.readFileSync(path.join(first, '.aurora-snapshot.json'), 'utf8'));
  check('manifest file count', m.files, 5);
  check('manifest size', m.bytes, 9 + 6 + 64 * 1024 + 32 * 1024 + 12);
  check('no partial left', fs.readdirSync(snapRoot(dest)).some((n) => n.endsWith('.partial')), false);
  check('last backup line', await text(s, '.bk-last'), (t) => /^Last backup:/.test(t || ''));
  check('lastRun saved', JSON.parse(fs.readFileSync(path.join(home, '.config', 'aurora', 'backup.json'), 'utf8')).lastRun, (v) => v > 0);
});

let second;
await section('incremental second backup (hard links)', async () => {
  await sleep(1100); // a new second → a new snapshot name
  fs.writeFileSync(path.join(home, 'Documents', 'report.txt'), 'version 2');
  const r = await invoke(s, 'backup:start', { opId: 'two' });
  check('second backup ok', r.ok, true);
  second = r.v.path;
  check('two snapshots', snaps(dest).length, 2);
  check('unchanged file is a hard link', ino(path.join(second, 'Pictures', 'photo.jpg')), ino(path.join(first, 'Pictures', 'photo.jpg')));
  check('changed file is new', ino(path.join(second, 'Documents', 'report.txt')) !== ino(path.join(first, 'Documents', 'report.txt')), true);
  check('changed content', fs.readFileSync(path.join(second, 'Documents', 'report.txt'), 'utf8'), 'version 2');
  check('old snapshot keeps old content', fs.readFileSync(path.join(first, 'Documents', 'report.txt'), 'utf8'), 'version 1');
  check('new data is small', r.v.newBytes, 9);
});
await s.close();

// ---------------------------------------------------------------- progress + cancel (slowed rsync)
s = await launchShell({ home, keepHome: true, open: ['backup'], lang: 'en', theme: 'light', env: { AURORA_BACKUP_BWLIMIT: '1500' } });
await s.page.waitForSelector(`${WIN} .bk-home`, { timeout: 20000 });
await section('progress and cancel', async () => {
  fs.writeFileSync(path.join(home, 'Videos', 'big.bin'), Buffer.alloc(1)); // Videos is not a source any more
  fs.writeFileSync(path.join(home, 'Music', 'big.wav'), Buffer.alloc(24 * 1024 * 1024, 1));
  await BK(s, (app) => {
    app.events = [];
    app.api.on('backup:progress', (p) => app.events.push(p));
    return true;
  });
  await s.page.click(`${WIN} .bk-start`);
  await until(s, (app) => app.events.some((e) => e.phase === 'copy' && e.percent > 0 && e.percent < 1), { label: 'progress', timeout: 30000 });
  check('progress bar visible', await count(s, '.bk-progress'), 1);
  check('cancel button visible', await count(s, '.bk-cancel'), 1);
  check('progress text', await text(s, '.bk-line'), (t) => /% · .* copied/.test(t || ''));
  check('progress has bytes', await BK(s, (app) => app.events.filter((e) => e.phase === 'copy').pop().bytes), (b) => b > 0);
  const busy = await invoke(s, 'backup:start', {});
  check('second start refused while running', busy.code, 'EBUSY');
  await s.page.click(`${WIN} .bk-cancel`);
  await until(s, (app) => !app.run, { label: 'cancel end', timeout: 15000 });
  check('canceled message', await text(s, '.bk-msg'), (t) => /canceled/.test(t || ''));
  check('still two snapshots', snaps(dest).length, 2);
  check('partial removed', fs.readdirSync(snapRoot(dest)).some((n) => n.endsWith('.partial')), false);
  fs.rmSync(path.join(home, 'Music', 'big.wav'));
});
await s.close();

s = await launchShell({ home, keepHome: true, open: ['backup'], lang: 'en', theme: 'light' });
await s.page.waitForSelector(`${WIN} .bk-home`, { timeout: 20000 });

await section('snapshots list + browse with the keyboard', async () => {
  await s.page.click(`${WIN} .bk-nav .nav-item[data-page="snapshots"]`);
  await s.page.waitForSelector(`${WIN} .bk-snap`, { timeout: 6000 });
  check('two snapshot rows', await count(s, '.bk-snap'), 2);
  check('row info', await text(s, '.bk-snap .caption'), (t) => /5 files · .* · .* new/.test(t || ''));
  await s.page.click(`${WIN} .bk-snap .bk-browse`);
  await s.page.waitForSelector(`${WIN} .bk-entry`, { timeout: 6000 });
  check('top-level entries', await BK(s, (app) => app.browse.entries.map((e) => e.name)), ['Desktop', 'Documents', 'Music', 'Pictures', 'Projects']);
  check('manifest hidden', await count(s, '.bk-entry[data-rel=".aurora-snapshot.json"]'), 0);
  // keyboard: focus first, ArrowDown to Documents, Enter opens it
  await s.page.focus(`${WIN} .bk-entry`);
  await s.page.keyboard.press('ArrowDown');
  await s.page.keyboard.press('Enter');
  await until(s, (app) => app.browse.rel === 'Documents', { label: 'open Documents' });
  check('inside Documents', await BK(s, (app) => app.browse.entries.map((e) => e.name)), ['Work', 'report.txt']);
  check('breadcrumb', await s.page.evaluate(`[...document.querySelectorAll('${WIN} .bk-crumb')].length`), 2);
  await s.page.keyboard.press('Backspace');
  await until(s, (app) => app.browse.rel === '', { label: 'back to root' });
  check('Backspace goes up', true, true);
  const bad = await invoke(s, 'backup:browse', await BK(s, (app) => app.browse.id), '../..');
  check('browse traversal refused', bad.code, 'EINVAL');
});

await section('restore to the original place', async () => {
  await BK(s, (app) => app.openDir('Documents'));
  fs.rmSync(path.join(home, 'Documents', 'report.txt'));
  await s.page.click(`${WIN} .bk-entry[data-rel="Documents/report.txt"]`);
  check('selected', await count(s, '.bk-entry.selected'), 1);
  await s.page.click(`${WIN} .bk-restore`);
  await until(s, (app) => app.message?.kind === 'success', { label: 'restored' });
  check('file restored', fs.readFileSync(path.join(home, 'Documents', 'report.txt'), 'utf8'), 'version 2');
  // existing file → asks before overwriting
  fs.writeFileSync(path.join(home, 'Documents', 'report.txt'), 'edited');
  await BK(s, (app) => (app.setMessage(null), app.render(), true));
  await s.page.click(`${WIN} .bk-entry[data-rel="Documents/report.txt"]`);
  await s.page.click(`${WIN} .bk-restore`);
  await s.page.waitForSelector('.dialog-layer:not(.closing) .dialog', { timeout: 6000 });
  check('overwrite question', await s.page.evaluate(`document.querySelector('.dialog-layer:not(.closing) .dialog').textContent`), (t) => /already exist/.test(t));
  await dialogButton(s, 'Cancel');
  check('kept after cancel', fs.readFileSync(path.join(home, 'Documents', 'report.txt'), 'utf8'), 'edited');
  await s.page.click(`${WIN} .bk-restore`);
  await dialogButton(s, 'Replace');
  await until(s, (app) => app.message?.kind === 'success', { label: 'replaced' });
  check('replaced', fs.readFileSync(path.join(home, 'Documents', 'report.txt'), 'utf8'), 'version 2');
  // a whole folder
  fs.rmSync(path.join(home, 'Documents', 'Work'), { recursive: true });
  const r = await BK(s, (app) => app.restoreItems(['Documents/Work']));
  check('folder restored', r?.restored, 1);
  check('folder content back', fs.readFileSync(path.join(home, 'Documents', 'Work', 'plan.md'), 'utf8'), '# plan');
});

await section('restore to a chosen folder + traversal', async () => {
  const r = await BK(s, (app, f) => app.restoreItems(['Documents/report.txt'], { to: 'folder', folder: f }), other);
  check('restored to folder', r?.restored, 1);
  check('file in chosen folder', fs.readFileSync(path.join(other, 'report.txt'), 'utf8'), 'version 2');
  const id = await BK(s, (app) => app.browse.id);
  let x = await invoke(s, 'backup:restore', id, ['../../etc/passwd'], {});
  check('restore traversal refused', x.code, 'EINVAL');
  x = await invoke(s, 'backup:restore', id, ['Documents/report.txt'], { to: 'folder', folder: path.join(other, 'nope') });
  check('restore to missing folder refused', x.code, 'EDEST');
  x = await invoke(s, 'backup:delete', ['../../tmp']);
  check('delete with a bad id refused', x.code, 'EINVAL');
  x = await invoke(s, 'backup:browse', 'not-a-snapshot', '');
  check('browse bad id refused', x.code, 'EINVAL');
  await s.page.click(`${WIN} .bk-back`);
  await s.page.waitForSelector(`${WIN} .bk-snap`, { timeout: 6000 });
  check('back to list', await count(s, '.bk-snap'), 2);
});

await section('keep last N + delete', async () => {
  await s.page.click(`${WIN} .bk-nav .nav-item[data-page="settings"]`);
  await s.page.waitForSelector(`${WIN} .bk-keep`, { timeout: 6000 });
  await s.page.selectOption(`${WIN} .bk-keep`, '3');
  await until(s, (app) => app.cfg.keep === 3, { label: 'keep saved' });
  for (let i = 0; i < 2; i++) {
    await sleep(1100);
    const r = await invoke(s, 'backup:start', {});
    check(`extra backup ${i + 1}`, r.ok, true);
  }
  check('pruned to 3 after backups', snaps(dest).length, 3);
  check('oldest pruned', snaps(dest).includes(path.basename(first)), false);
  await s.page.selectOption(`${WIN} .bk-keep`, '0');
  await until(s, (app) => app.cfg.keep === 0, { label: 'keep all' });
  await sleep(1100);
  await invoke(s, 'backup:start', {});
  check('keep all: 4 snapshots', snaps(dest).length, 4);
  await s.page.selectOption(`${WIN} .bk-keep`, '3');
  await until(s, (app) => app.cfg.keep === 3, { label: 'keep 3 again' });
  await s.page.click(`${WIN} .bk-nav .nav-item[data-page="snapshots"]`);
  await s.page.waitForSelector(`${WIN} .bk-cleanup`, { timeout: 6000 });
  check('cleanup button label', await text(s, '.bk-cleanup'), 'Keep only the last 3');
  await s.page.click(`${WIN} .bk-cleanup`);
  await dialogButton(s, 'Delete');
  await until(s, (app) => app.snapshots.length === 3, { label: 'cleanup' });
  check('cleanup kept 3', snaps(dest).length, 3);
  const newest = snaps(dest).pop();
  await s.page.click(`${WIN} .bk-snap[data-id="${newest}"] .bk-delete`);
  await dialogButton(s, 'Delete');
  await until(s, (app) => app.snapshots.length === 2, { label: 'delete' });
  check('snapshot deleted', snaps(dest).includes(newest), false);
  check('rows after delete', await count(s, '.bk-snap'), 2);
});

await section('reminder via shell.reminders', async () => {
  await s.page.click(`${WIN} .bk-nav .nav-item[data-page="settings"]`);
  await s.page.waitForSelector(`${WIN} .bk-reminder`, { timeout: 6000 });
  await s.page.locator(`${WIN} .bk-reminder button`, { hasText: 'Weekly' }).click();
  await until(s, (app) => app.cfg.reminder === 'weekly', { label: 'weekly saved' });
  let rem = await s.page.evaluate(`window.__aurora.shell.reminders.list('backup').map((r) => ({ id: r.id, repeat: r.repeat, future: r.at > Date.now(), day: new Date(r.at).getDay() }))`);
  check('weekly reminder set', rem, [{ id: 'backup-reminder', repeat: 'weekly', future: true, day: 0 }]);
  await s.page.locator(`${WIN} .bk-reminder button`, { hasText: 'Daily' }).click();
  await until(s, (app) => app.cfg.reminder === 'daily', { label: 'daily saved' });
  rem = await s.page.evaluate(`window.__aurora.shell.reminders.list('backup').map((r) => r.repeat)`);
  check('daily reminder replaces it', rem, ['daily']);
  await s.page.locator(`${WIN} .bk-reminder button`, { hasText: 'Off' }).click();
  await until(s, (app) => app.cfg.reminder === 'off', { label: 'off saved' });
  rem = await s.page.evaluate(`window.__aurora.shell.reminders.list('backup').length`);
  check('reminder removed', rem, 0);
  check('excluded patterns listed', await count(s, '.bk-excl code'), 5);
});

await section('keyboard navigation + light screenshot', async () => {
  await s.page.focus(`${WIN} .bk-nav .nav-item[data-page="settings"]`);
  await s.page.keyboard.press('Shift+Tab');
  await s.page.keyboard.press('Enter');
  await sleep(500);
  check('keyboard: Snapshots page via Enter', await BK(s, (app) => app.page), 'snapshots');
  await s.page.click(`${WIN} .bk-nav .nav-item[data-page="home"]`);
  await BK(s, (app) => (app.setMessage(null), app.render(), true));
  await shot(s, 'light-en');
  const errs = s.logs.filter((l) => /^\[(error|pageerror)\]/.test(l) && /backup/i.test(l));
  check('no console errors', errs, []);
});
await s.close();

s = await launchShell({ home, keepHome: true, open: ['backup'], lang: 'fr', theme: 'dark' });
await s.page.waitForSelector(`${WIN} .bk-home`, { timeout: 20000 });
await section('French + dark theme', async () => {
  check('French nav', await text(s, '.bk-nav .nav-item[data-page="snapshots"]'), 'Instantanés');
  check('French status', await text(s, '.bk-last'), (t) => /^Dernière sauvegarde/.test(t || ''));
  check('French button', await text(s, '.bk-start'), 'Sauvegarder maintenant');
  check('dark theme', await s.page.evaluate(`document.documentElement.dataset.theme`), 'dark');
  const color = await s.page.evaluate(`getComputedStyle(document.querySelector('${WIN} .bk-last')).color`);
  check('light text on dark', color, (c) => {
    const m = c.match(/\d+/g).map(Number);
    return m[0] > 180 && m[1] > 180 && m[2] > 180;
  });
  check('no null/undefined text', await s.page.evaluate(`/\\b(null|undefined)\\b/.test(document.querySelector('${WIN} .bk').textContent)`), false);
  await shot(s, 'dark-fr');
  await s.page.click(`${WIN} .bk-nav .nav-item[data-page="snapshots"]`);
  await s.page.waitForSelector(`${WIN} .bk-snap`, { timeout: 6000 });
  check('French snapshot info', await text(s, '.bk-snap .caption'), (t) => /fichiers · .* nouveaux/.test(t || ''));
  check('no console errors (fr)', s.logs.filter((l) => /^\[(error|pageerror)\]/.test(l) && /backup/i.test(l)), []);
});
await s.close();

for (const d of [home, dest, other]) fs.rmSync(d, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  ✗ ${f}`);
process.exit(failures.length ? 1 : 0);
