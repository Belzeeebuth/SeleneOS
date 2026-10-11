// Cloud tests — drive the real Electron shell with Playwright against the in-memory mock WebDAV backend.
//   Setup screen (services, "more services later", URL / https / credential errors), account saved with an
//   obfuscated app password, PROPFIND listing (folders first), keyboard navigation (arrows, Enter, Backspace, Delete),
//   breadcrumb, new folder, upload with progress + replace confirmation, download to ~/Downloads with progress, no
//   overwrite (Keep both / Cancel), delete with confirmation, backend path checks, persistence across relaunch,
//   French + dark theme, add / remove account, narrow layout, console errors.
// Usage:  cd aurora-os/shell && xvfb-run -a -s "-screen 0 1600x900x24" node test/cloud.test.mjs
import fs from 'node:fs';
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

const WIN = '.win.app-cloud';
const DLG = `${WIN} .dialog-layer:not(.closing) .dialog`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function CL(s, fn, arg) {
  return s.page.evaluate(`(async () => { const el = document.querySelector(${JSON.stringify(WIN)}); return (${fn.toString()})(el && el.__cloud, ${JSON.stringify(arg ?? null)}); })()`);
}
async function until(s, fn, { timeout = 10000, label = 'condition', arg } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = await CL(s, fn, arg).catch((e) => `ERR ${e.message}`);
    if (last && !(typeof last === 'string' && last.startsWith('ERR'))) return last;
    await sleep(80);
  }
  throw new Error(`timed out waiting for ${label} (last: ${JSON.stringify(last)})`);
}
const rowNames = (s) => s.page.$$eval(`${WIN} .cl-row .cl-text`, (els) => els.map((e) => e.textContent));
async function dialogButton(s, label) {
  await s.page.waitForSelector(DLG, { timeout: 6000 });
  await s.page.locator(`${DLG} .btn`, { hasText: label }).first().click();
  await sleep(300);
}
async function dialogText(s) {
  await s.page.waitForSelector(DLG, { timeout: 6000 });
  return s.page.$eval(DLG, (d) => d.textContent);
}
async function shot(s, name) {
  await sleep(400);
  const rect = await s.page.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(WIN)}).getBoundingClientRect(); return { x: Math.max(0, r.x - 1), y: Math.max(0, r.y - 1), width: r.width + 2, height: r.height + 2 }; })()`);
  const file = path.join(DOCS, `${name}.png`);
  await s.page.screenshot({ path: file, clip: rect });
  return file;
}
const cloudErrors = (s) => s.logs.filter((l) => /^\[(error|pageerror)\]/.test(l) && /cloud/i.test(l));
async function fill(s, id, value) {
  await s.page.fill(`${WIN} #cl-${id}`, value);
}
async function submit(s) {
  await s.page.click(`${WIN} .cl-connect`);
}
async function selectRow(s, name) {
  await s.page.locator(`${WIN} .cl-row`, { hasText: name }).first().click();
  await sleep(120);
}

let home = null;

// ================================================================== English, light
async function runEnglish() {
  const s = await launchShell({ open: ['cloud'], lang: 'en', theme: 'light', keepHome: true });
  home = s.home;
  try {
    await section('window and setup screen', async () => {
      await s.page.waitForSelector(`${WIN} .cl-setup`, { timeout: 20000 });
      check('setup shown with no account', await s.page.isVisible(`${WIN} .cl-setup-card`), true);
      check('title', await s.page.textContent(`${WIN} .cl-setup-card h1`), 'Connect your cloud storage');
      const seg = await s.page.$$eval(`${WIN} .segmented button`, (b) => b.map((x) => x.textContent));
      check('services', seg, ['Nextcloud', 'WebDAV']);
      check('more services later', await s.page.textContent(`${WIN} .cl-more`), (t) => /more services later/i.test(t));
      await sleep(200);
      check('server field focused', await s.page.evaluate(`document.activeElement && document.activeElement.id`), 'cl-server');
      check('no cancel without accounts', await s.page.$$eval(`${WIN} .cl-actions .btn`, (b) => b.length), 1);
      await s.page.click(`${WIN} .segmented button:has-text("WebDAV")`);
      check('webdav hint', await s.page.textContent(`${WIN} .cl-form .field-hint`), (t) => /full WebDAV address/.test(t));
      await s.page.click(`${WIN} .segmented button:has-text("Nextcloud")`);
    });

    await section('setup errors', async () => {
      await submit(s);
      await until(s, (app) => app.setup && !app.setup.busy && app.setup.error, { label: 'empty url error' });
      check('empty url', await s.page.textContent(`${WIN} .cl-form .cl-error`), 'This server address is not valid.');
      await fill(s, 'server', 'http://cloud.example.com');
      await fill(s, 'user', 'anna');
      await fill(s, 'password', 'secret');
      await submit(s);
      await until(s, (app) => app.setup && !app.setup.busy && /https/.test(app.setup.error), { label: 'insecure error' });
      check('http refused', await s.page.textContent(`${WIN} .cl-form .cl-error`), (t) => /Only secure \(https\)/.test(t));
      check('server refocused', await s.page.evaluate(`document.activeElement && document.activeElement.id`), 'cl-server');
      await fill(s, 'server', 'cloud.example.com');
      await fill(s, 'password', 'wrong');
      await submit(s);
      await until(s, (app) => app.setup && !app.setup.busy && /wrong/.test(app.setup.error), { label: 'auth error' });
      check('auth error', await s.page.textContent(`${WIN} .cl-form .cl-error`), 'The user name or app password is wrong.');
      check('password refocused', await s.page.evaluate(`document.activeElement && document.activeElement.id`), 'cl-password');
      await fill(s, 'server', 'https://offline.example.com');
      await fill(s, 'password', 'app-pass-123');
      await submit(s);
      await until(s, (app) => app.setup && !app.setup.busy && /reached/.test(app.setup.error), { label: 'net error' });
      check('network error', await s.page.textContent(`${WIN} .cl-form .cl-error`), (t) => /cannot be reached/.test(t));
      const accs = await CL(s, (app) => app.ctx.api.invoke('cloud:accounts'));
      check('nothing saved after errors', accs.length, 0);
    });

    await section('connect and list', async () => {
      await fill(s, 'server', 'cloud.example.com/');
      await fill(s, 'user', 'anna');
      await fill(s, 'password', 'app-pass-123');
      await s.page.press(`${WIN} #cl-password`, 'Enter');
      await until(s, (app) => app.mode === 'browser' && !app.loading && app.entries.length, { label: 'root listing' });
      check('root rows (folders first)', await rowNames(s), ['Documents', 'Photos', 'Shared with me', 'Nextcloud intro.txt', 'Readme.md']);
      check('folder flagged', await s.page.$eval(`${WIN} .cl-row[data-path="/Documents"]`, (r) => r.dataset.dir), '1');
      check('sizes shown', await s.page.$eval(`${WIN} .cl-row[data-path="/Nextcloud intro.txt"] .cl-size`, (r) => r.textContent), (t) => /KB/.test(t));
      check('item count', await s.page.textContent(`${WIN} .cl-status`), (t) => t.includes('5 items'));
      check('account label', await s.page.textContent(`${WIN} .cl-account-name`), 'anna@cloud.example.com');
      check('window title', await CL(s, (app) => app.win.el.querySelector('.titlebar, .win-title, .title')?.textContent || document.title), (t) => /Cloud/.test(t));
      check('list focused', await s.page.evaluate(`document.activeElement && document.activeElement.classList.contains('cl-list')`), true);
      const file = path.join(home, '.config', 'aurora', 'cloud', 'accounts.json');
      const raw = fs.readFileSync(file, 'utf8');
      check('accounts file written', raw.includes('"anna"'), true);
      check('password not stored in clear', raw.includes('app-pass-123'), false);
      check('password sealed', JSON.parse(raw).accounts[0].secret?.v?.length > 20, true);
      check('accounts file 0600', (fs.statSync(file).mode & 0o777).toString(8), '600');
      const pub = await CL(s, (app) => app.ctx.api.invoke('cloud:accounts'));
      check('public account has no secret', pub[0].secret, undefined);
      check('nextcloud dav url', pub[0].davUrl, 'https://cloud.example.com/remote.php/dav/files/anna/');
    });

    await section('keyboard navigation and breadcrumb', async () => {
      await s.page.focus(`${WIN} .cl-list`);
      await s.page.keyboard.press('ArrowDown');
      check('first row selected', await CL(s, (app) => app.selected), '/Documents');
      check('aria-selected', await s.page.$eval(`${WIN} .cl-row[data-path="/Documents"]`, (r) => r.getAttribute('aria-selected')), 'true');
      check('download disabled for folder', await s.page.$eval(`${WIN} .cl-download`, (b) => b.disabled), true);
      await s.page.keyboard.press('End');
      check('End selects last', await CL(s, (app) => app.selected), '/Readme.md');
      check('download enabled for file', await s.page.$eval(`${WIN} .cl-download`, (b) => b.disabled), false);
      await s.page.keyboard.press('Home');
      await s.page.keyboard.press('Enter');
      await until(s, (app) => app.path === '/Documents' && !app.loading, { label: 'open Documents' });
      check('Documents rows', await rowNames(s), ['Budget 2026.csv', 'Meeting notes.md']);
      const crumbs = await s.page.$$eval(`${WIN} .cl-crumb`, (b) => b.map((x) => x.textContent));
      check('breadcrumb', crumbs, ['Home', 'Documents']);
      check('current crumb', await s.page.$eval(`${WIN} .cl-crumb[aria-current="page"]`, (b) => b.dataset.path), '/Documents');
      check('up enabled', await s.page.$eval(`${WIN} .cl-up`, (b) => b.disabled), false);
      await s.page.keyboard.press('Backspace');
      await until(s, (app) => app.path === '/' && app.selected === '/Documents', { label: 'back to root' });
      check('Backspace goes up and reselects', await CL(s, (app) => app.selected), '/Documents');
      await s.page.dblclick(`${WIN} .cl-row[data-path="/Photos"]`);
      await until(s, (app) => app.path === '/Photos' && !app.loading, { label: 'open Photos' });
      check('double-click opens folder', await rowNames(s), ['Lake.svg']);
      await s.page.click(`${WIN} .cl-crumb[data-path="/"]`);
      await until(s, (app) => app.path === '/' && !app.loading && app.entries.length === 5, { label: 'home crumb' });
      check('home crumb', await CL(s, (app) => app.path), '/');
      check('up disabled at root', await s.page.$eval(`${WIN} .cl-up`, (b) => b.disabled), true);
    });

    await section('new folder', async () => {
      await s.page.click(`${WIN} .cl-mkdir`);
      await s.page.waitForSelector(`${DLG} input`, { timeout: 6000 });
      await s.page.fill(`${DLG} input`, 'Documents');
      await s.page.keyboard.press('Enter');
      await sleep(250);
      check('duplicate name refused', await s.page.textContent(`${DLG} .field-hint`), 'This name is already taken.');
      await s.page.fill(`${DLG} input`, 'Projects');
      await s.page.keyboard.press('Enter');
      await until(s, (app) => app.entries.some((e) => e.path === '/Projects'), { label: 'Projects created' });
      check('folder listed', (await rowNames(s)).slice(0, 4), ['Documents', 'Photos', 'Projects', 'Shared with me']);
      check('new folder selected', await CL(s, (app) => app.selected), '/Projects');
      const bad = await CL(s, (app) => app.ctx.api.invoke('cloud:mkdir', app.accountId, '/', 'a/b').then(() => 'ok', (e) => e.code));
      check('backend rejects slash in name', bad, 'ENAME');
      const trav = await CL(s, (app) => app.ctx.api.invoke('cloud:list', app.accountId, '/../../etc').then(() => 'ok', (e) => e.code));
      check('backend rejects ..', trav, 'EPATH');
    });

    await section('upload with progress', async () => {
      const local = path.join(home, 'Documents', 'report.txt');
      fs.writeFileSync(local, 'Quarterly report\n'.repeat(20000));
      await s.page.dblclick(`${WIN} .cl-row[data-path="/Projects"]`);
      await until(s, (app) => app.path === '/Projects' && !app.loading, { label: 'open Projects' });
      check('empty folder state', await s.page.textContent(`${WIN} .cl-empty`), (t) => /This folder is empty/.test(t));
      await CL(s, (app) => {
        app._prog = [];
        const orig = app.onProgress.bind(app);
        app.onProgress = (p) => {
          app._prog.push(p.done);
          orig(p);
        };
        return true;
      });
      await s.page.click(`${WIN} .cl-upload`);
      await s.page.waitForSelector('.dialog-layer:not(.closing) .dialog', { timeout: 6000 });
      check('upload opens a file picker', await s.page.isVisible('.dialog-layer:not(.closing) .dialog'), true);
      await s.page.keyboard.press('Escape');
      await sleep(300);
      CL(s, (app, f) => app.uploadPaths([f]), local);
      await s.page.waitForSelector(`${WIN} .cl-tr[data-status="run"]`, { timeout: 6000 });
      check('progress bar visible while uploading', await s.page.isVisible(`${WIN} .cl-tr .cl-bar-track`), true);
      await until(s, (app) => app.transfers[0]?.status === 'done' && app.entries.some((e) => e.name === 'report.txt'), { label: 'upload done' });
      const prog = await CL(s, (app) => app._prog);
      check('several progress events', prog.length >= 3, true);
      check('progress increases', prog.every((v, i) => i === 0 || v >= prog[i - 1]), true);
      check('uploaded size', await CL(s, (app) => app.entries.find((e) => e.name === 'report.txt').size), 17 * 20000);
      check('transfer done text', await s.page.textContent(`${WIN} .cl-tr .cl-tr-status`), 'Done');
      check('progress at 100', await s.page.$eval(`${WIN} .cl-tr .cl-bar-track`, (b) => b.getAttribute('aria-valuenow')), '100');
      // same file again → asks before replacing
      CL(s, (app, f) => app.uploadPaths([f]), local);
      check('replace confirmation', await dialogText(s), (t) => /already in this folder/.test(t));
      await dialogButton(s, 'Replace');
      await until(s, (app) => app.transfers[0]?.status === 'done' && app.transfers.length === 2, { label: 'replace upload' });
      check('still one report.txt', (await rowNames(s)).filter((n) => n === 'report.txt').length, 1);
      CL(s, (app, f) => app.uploadPaths([f]), local);
      await dialogButton(s, 'Cancel');
      await until(s, (app) => app.transfers[0]?.status === 'error', { label: 'upload canceled' });
      check('canceled upload reported', await s.page.textContent(`${WIN} .cl-tr .cl-tr-status`), (t) => /Canceled/.test(t));
      await s.page.click(`${WIN} .cl-clear`);
      check('clear finished hides transfers', await s.page.$$eval(`${WIN} .cl-tr`, (r) => r.length), 0);
    });

    await section('download to Downloads, no overwrite', async () => {
      await s.page.click(`${WIN} .cl-crumb[data-path="/"]`);
      await until(s, (app) => app.path === '/' && !app.loading && app.entries.length, { label: 'root' });
      await selectRow(s, 'Nextcloud intro.txt');
      await s.page.click(`${WIN} .cl-download`);
      await until(s, (app) => app.transfers[0]?.status === 'done', { label: 'download done' });
      const dl = path.join(home, 'Downloads', 'Nextcloud intro.txt');
      check('file downloaded', fs.existsSync(dl), true);
      const expected = 'Nextcloud keeps your files, contacts and calendars on a server you trust.\n'.repeat(400);
      check('content intact', fs.readFileSync(dl, 'utf8') === expected, true);
      check('no .part left', fs.readdirSync(path.join(home, 'Downloads')).filter((f) => f.endsWith('.part')), []);
      check('saved-to text', await s.page.textContent(`${WIN} .cl-tr .cl-tr-status`), (t) => t.startsWith('Saved to') && t.includes('Downloads'));
      check('show in folder button', await s.page.isVisible(`${WIN} .cl-tr .cl-open`), true);
      fs.writeFileSync(dl, 'local edit');
      await s.page.focus(`${WIN} .cl-list`);
      await s.page.keyboard.press('Enter');
      check('conflict dialog', await dialogText(s), (t) => /already in your Downloads folder/.test(t));
      await dialogButton(s, 'Keep both');
      await until(s, (app) => app.transfers[0]?.status === 'done' && app.transfers.length === 2, { label: 'keep both' });
      check('original kept', fs.readFileSync(dl, 'utf8'), 'local edit');
      check('second copy', fs.existsSync(path.join(home, 'Downloads', 'Nextcloud intro (2).txt')), true);
      await s.page.keyboard.press('Enter');
      await dialogButton(s, 'Cancel');
      await until(s, (app) => app.transfers[0]?.status === 'error', { label: 'download canceled' });
      check('no third copy', fs.existsSync(path.join(home, 'Downloads', 'Nextcloud intro (3).txt')), false);
      check('original still kept', fs.readFileSync(dl, 'utf8'), 'local edit');
      await s.page.keyboard.press('Enter');
      await dialogButton(s, 'Replace');
      await until(s, (app) => app.transfers[0]?.status === 'done', { label: 'replace download' });
      check('replace overwrites when asked', fs.readFileSync(dl, 'utf8') === expected, true);
      check('window progress cleared', await CL(s, (app) => app.transfers.filter((x) => x.status === 'run').length), 0);
    });

    await section('delete with confirmation', async () => {
      await selectRow(s, 'Projects');
      await s.page.keyboard.press('Delete');
      check('folder delete warns', await dialogText(s), (t) => /Delete the folder "Projects" and everything in it/.test(t));
      await dialogButton(s, 'Cancel');
      check('cancel keeps folder', await CL(s, (app) => app.entries.some((e) => e.path === '/Projects')), true);
      await s.page.click(`${WIN} .cl-delete`);
      await dialogButton(s, 'Delete');
      await until(s, (app) => !app.entries.some((e) => e.path === '/Projects'), { label: 'Projects deleted' });
      check('folder deleted', (await rowNames(s)).includes('Projects'), false);
      check('selection moves to next row', await CL(s, (app) => app.selected), '/Shared with me');
      const gone = await CL(s, (app) => app.ctx.api.invoke('cloud:list', app.accountId, '/Projects').then(() => 'ok', (e) => e.code));
      check('server no longer has it', gone, 'ENOENT');
    });

    await section('narrow layout and screenshot', async () => {
      await CL(s, (app) => (app.win.setSize(500, 520), true));
      await sleep(400);
      check('narrow class', await s.page.$eval(WIN, (w) => w.classList.contains('cl-narrow')), true);
      check('labels hidden when narrow', await s.page.$eval(`${WIN} .cl-upload .cl-lbl`, (e) => getComputedStyle(e).display), 'none');
      const overflow = await s.page.$eval(WIN, (w) => {
        const wr = w.getBoundingClientRect();
        return [...w.querySelectorAll('.cl-bar .btn, .cl-row')].filter((e) => e.getBoundingClientRect().right > wr.right + 1).length;
      });
      check('nothing sticks out when narrow', overflow, 0);
      await CL(s, (app) => (app.win.setSize(960, 640), true));
      await sleep(400);
      await selectRow(s, 'Documents');
      await shot(s, 'cloud-light-en');
      check('no console errors', cloudErrors(s), []);
    });
  } finally {
    await s.close();
  }
}

// ================================================================== French, dark, relaunch
async function runFrench() {
  const s = await launchShell({ open: ['cloud'], lang: 'fr', theme: 'dark', home });
  try {
    await section('relaunch keeps the account (FR, dark)', async () => {
      await s.page.waitForSelector(WIN, { timeout: 20000 });
      await until(s, (app) => app && app.mode === 'browser' && !app.loading && app.entries.length, { label: 'root listing after relaunch' });
      check('account restored', await s.page.textContent(`${WIN} .cl-account-name`), 'anna@cloud.example.com');
      check('french toolbar', await s.page.textContent(`${WIN} .cl-upload`), 'Envoyer');
      check('french new folder', await s.page.textContent(`${WIN} .cl-mkdir`), 'Nouveau dossier');
      check('french crumb', await s.page.textContent(`${WIN} .cl-crumb`), 'Accueil');
      check('french count', await s.page.textContent(`${WIN} .cl-status`), (t) => t.includes('5 éléments'));
      check('french size unit', await s.page.$eval(`${WIN} .cl-row[data-path="/Nextcloud intro.txt"] .cl-size`, (r) => r.textContent), (t) => /Ko/.test(t));
      check('dark theme', await s.page.evaluate(`document.documentElement.dataset.theme`), 'dark');
      const bg = await s.page.$eval(`${WIN} .cl-row[data-path="/Documents"] .cl-text`, (e) => getComputedStyle(e).color);
      check('light text in dark mode', bg, (c) => {
        const [r, g, b] = c.match(/\d+/g).map(Number);
        return r + g + b > 450;
      });
    });

    await section('french download + delete dialogs', async () => {
      await selectRow(s, 'Readme.md');
      await s.page.click(`${WIN} .cl-download`);
      await until(s, (app) => app.transfers[0]?.status === 'done', { label: 'fr download' });
      check('fr saved text', await s.page.textContent(`${WIN} .cl-tr .cl-tr-status`), (t) => t.startsWith('Enregistré dans'));
      await s.page.keyboard.press('Delete');
      check('fr delete text', await dialogText(s), (t) => /Supprimer « Readme\.md » du serveur/.test(t));
      await dialogButton(s, 'Annuler');
      await selectRow(s, 'Documents');
      await shot(s, 'cloud-dark-fr');
    });

    await section('add and remove accounts (FR)', async () => {
      await s.page.click(`${WIN} .cl-account`);
      await s.page.waitForSelector('.menu .menu-item', { timeout: 4000 });
      check('menu lists account', await s.page.locator('.menu .menu-item', { hasText: 'anna@cloud.example.com' }).count(), 1);
      await s.page.locator('.menu .menu-item', { hasText: 'Ajouter un compte' }).first().click();
      await s.page.waitForSelector(`${WIN} .cl-setup`, { timeout: 4000 });
      check('fr setup title', await s.page.textContent(`${WIN} .cl-setup-card h1`), 'Connectez votre stockage en ligne');
      check('fr more services', await s.page.textContent(`${WIN} .cl-more`), (t) => /plus tard/.test(t));
      check('cancel offered', await s.page.isVisible(`${WIN} .cl-actions .btn:has-text("Annuler")`), true);
      await s.page.click(`${WIN} .segmented button:has-text("WebDAV")`);
      await fill(s, 'server', 'http://localhost:8080/dav');
      await fill(s, 'user', 'bob');
      await fill(s, 'password', 'pw');
      await submit(s);
      await until(s, (app) => app.mode === 'browser' && app.accounts.length === 2 && !app.loading && app.entries.length, { label: 'second account' });
      const accs = await CL(s, (app) => app.ctx.api.invoke('cloud:accounts'));
      check('localhost http allowed', accs[1].davUrl, 'http://localhost:8080/dav/');
      check('switched to new account', await s.page.textContent(`${WIN} .cl-account-name`), 'bob@localhost:8080');
      await s.page.click(`${WIN} .cl-account`);
      await s.page.locator('.menu .menu-item', { hasText: 'Supprimer ce compte' }).first().click();
      check('remove confirm', await dialogText(s), (t) => /Vos fichiers restent sur le serveur/.test(t));
      await dialogButton(s, 'Supprimer');
      await until(s, (app) => app.accounts.length === 1 && app.mode === 'browser' && !app.loading, { label: 'removed' });
      check('back on first account', await s.page.textContent(`${WIN} .cl-account-name`), 'anna@cloud.example.com');
      await s.page.click(`${WIN} .cl-account`);
      await s.page.locator('.menu .menu-item', { hasText: 'Supprimer ce compte' }).first().click();
      await dialogButton(s, 'Supprimer');
      await until(s, (app) => app.mode === 'setup', { label: 'setup after last removal' });
      const raw = JSON.parse(fs.readFileSync(path.join(home, '.config', 'aurora', 'cloud', 'accounts.json'), 'utf8'));
      check('accounts file emptied', raw.accounts.length, 0);
      check('no console errors (fr)', cloudErrors(s), []);
    });
  } finally {
    await s.close();
  }
}

try {
  await runEnglish();
  await runFrench();
} catch (e) {
  failures.push(`fatal: ${e?.stack || e}`);
}
if (home) fs.rmSync(home, { recursive: true, force: true });
for (const f of failures) console.log(`  FAIL ${f}`);
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
