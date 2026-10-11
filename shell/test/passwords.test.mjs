// Passwords tests: drive the real Electron shell with Playwright.
//   Libraries in the page (generator classes / length / passphrase, strength scores, CSV round trip with quotes and
//   newlines, vault seal/open, wrong password, tampered header, newer version, fresh IV per save), backend validation,
//   create vault (too short, mismatch, strength meter), the vault file (0600, folder 0700, header, no plaintext),
//   add / edit / favourite / search / delete entries, reveal, copy + clipboard cleared after the delay only when
//   unchanged, generator dialog (password, passphrase, "Use password"), lock / wrong / right unlock, Ctrl+L,
//   auto-lock when idle, lock when the session locks, CSV import / export with warning, persistence across a
//   relaunch, no secrets in app storage or console logs, French + dark theme.
//   Screenshots: aurora-os/docs/screenshots/passwords-light-en.png, passwords-dark-fr.png
// Usage:  cd aurora-os/shell && xvfb-run -a -s "-screen 0 1600x900x24" node test/passwords.test.mjs
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

const WIN = '.win.app-passwords';
const DLG = `${WIN} .dialog-layer:not(.closing) .dialog`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MASTER = 'Correct-Horse-Battery-42!';
const SECRET = 'S3cr3t!Pa55-word-xyz';

function P(s, fn, arg) {
  return s.page.evaluate(`(async () => { const el = document.querySelector(${JSON.stringify(WIN)}); return (${fn.toString()})(el && el.__passwords, ${JSON.stringify(arg ?? null)}); })()`);
}
async function until(s, fn, { timeout = 15000, step = 80, label = 'condition', arg } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = await P(s, fn, arg).catch((e) => `ERR ${e.message}`);
    if (last && !(typeof last === 'string' && last.startsWith('ERR'))) return last;
    await sleep(step);
  }
  throw new Error(`timed out waiting for ${label} (last: ${JSON.stringify(last)})`);
}
async function waitText(s, sel, re, timeout = 8000) {
  const t0 = Date.now();
  let last = '';
  while (Date.now() - t0 < timeout) {
    last = await s.page.evaluate(`document.querySelector(${JSON.stringify(sel)})?.textContent || ''`).catch(() => '');
    if (re.test(last)) return last;
    await sleep(80);
  }
  throw new Error(`timed out waiting for ${sel} to match ${re} (last: ${JSON.stringify(last)})`);
}
const clipboard = (s) => s.app.evaluate(({ clipboard: c }) => c.readText());
const setClipboard = (s, text) => s.app.evaluate(({ clipboard: c }, t) => c.writeText(t), text);
const vaultPath = (home) => path.join(home, '.local', 'share', 'aurora', 'passwords.vault');
async function dialogButton(s, label) {
  await s.page.waitForSelector(DLG, { timeout: 8000 });
  await s.page.locator(`${DLG} .dialog-footer .btn`, { hasText: label }).first().click();
  await sleep(300);
}
async function shot(s, name) {
  await sleep(500);
  const rect = await s.page.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(WIN)}).getBoundingClientRect(); return { x: Math.max(0, r.x - 1), y: Math.max(0, r.y - 1), width: r.width + 2, height: r.height + 2 }; })()`);
  const file = path.join(DOCS, `passwords-${name}.png`);
  await s.page.screenshot({ path: file, clip: rect });
  return file;
}
async function createVault(s, pw = MASTER) {
  await s.page.waitForSelector(`${WIN} .pw-setup #pw-master`, { timeout: 20000 });
  await s.page.fill(`${WIN} #pw-master`, pw);
  await s.page.fill(`${WIN} #pw-confirm`, pw);
  await s.page.click(`${WIN} .pw-go`);
  await until(s, (app) => app.state === 'open', { label: 'vault open', timeout: 30000 });
}
async function addEntry(s, e) {
  await s.page.click(`${WIN} .pw-new`);
  await s.page.waitForSelector(`${WIN} #pw-f-title`);
  await s.page.fill(`${WIN} #pw-f-title`, e.title);
  await s.page.fill(`${WIN} #pw-f-username`, e.username || '');
  await s.page.fill(`${WIN} #pw-f-password`, e.password || '');
  await s.page.fill(`${WIN} #pw-f-url`, e.url || '');
  await s.page.fill(`${WIN} #pw-f-notes`, e.notes || '');
  await s.page.click(`${WIN} .pw-save`);
  await until(s, (app, t) => !app.editing && app.model.entries.some((x) => x.title === t), { arg: e.title, label: `entry ${e.title}` });
  await P(s, (app) => app.saving);
}

// ---------------------------------------------------------------------------------------------- launch 1 (EN, light)
const s = await launchShell({ open: ['passwords'], lang: 'en', theme: 'light', size: '1600x900' });
const home = s.home;
try {
  await s.page.waitForSelector(WIN, { timeout: 30000 });

  await section('libraries', async () => {
    const r = await s.page.evaluate(`(async () => {
      const gen = await import('app://shell/apps/passwords/lib/gen.js');
      const csv = await import('app://shell/apps/passwords/lib/csv.js');
      const v = await import('app://shell/apps/passwords/lib/vault.js');
      const out = {};
      const pws = Array.from({ length: 30 }, () => gen.generatePassword({ length: 24, upper: true, lower: true, digits: true, symbols: true }));
      out.len = pws.every((p) => p.length === 24);
      out.classes = pws.every((p) => /[A-Z]/.test(p) && /[a-z]/.test(p) && /[0-9]/.test(p) && /[^A-Za-z0-9]/.test(p));
      out.unique = new Set(pws).size === 30;
      out.digitsOnly = /^[0-9]{12}$/.test(gen.generatePassword({ length: 12, upper: false, lower: false, digits: true, symbols: false }));
      const pp = gen.generatePassphrase({ words: 6, separator: '-' });
      out.pp = pp.split('-').length === 6 && pp.split('-').every((w) => /^[a-z]+$/.test(w));
      out.weak = gen.strength('password1').score;
      out.strong = gen.strength(pws[0]).score;
      out.empty = gen.strength('').score;
      const entries = [{ title: 'A, "quoted"', username: 'u1', password: 'p,1"x', url: 'https://a.example', notes: 'line1\\nline2', favorite: true }, { title: 'B', username: 'u2', password: 'p2', url: '', notes: '', favorite: false }];
      const back = csv.importCsv(csv.exportCsv(entries));
      out.csv = JSON.stringify(back) === JSON.stringify(entries);
      out.csvChrome = csv.importCsv('name,url,username,password\\nSite,https://www.site.example/login,bob,pw\\n')[0];
      try { csv.importCsv('foo,bar\\n1,2'); out.csvBad = 'no error'; } catch (e) { out.csvBad = e.code; }
      const sess = await v.createSession('master-pass', 1000);
      const model = { entries: [v.normalizeEntry({ title: 'T', password: 'hunter2' })] };
      const b1 = await v.seal(sess, model);
      const b2 = await v.seal(sess, model);
      out.ivDiffers = JSON.parse(b1).cipher.iv !== JSON.parse(b2).cipher.iv;
      out.noPlain = !b1.includes('hunter2');
      out.roundTrip = (await v.openVault(b1, 'master-pass')).model.entries[0].password;
      try { await v.openVault(b1, 'wrong-pass'); out.wrong = 'opened'; } catch (e) { out.wrong = e.code; }
      const tampered = JSON.parse(b1); tampered.kdf.iterations = 999;
      try { await v.openVault(JSON.stringify(tampered), 'master-pass'); out.tampered = 'opened'; } catch (e) { out.tampered = e.code; }
      const newer = JSON.parse(b1); newer.version = 99;
      try { await v.openVault(JSON.stringify(newer), 'master-pass'); out.newer = 'opened'; } catch (e) { out.newer = e.code; }
      const huge = JSON.parse(b1); huge.kdf.iterations = 1e12;
      const t0 = performance.now();
      try { await v.openVault(JSON.stringify(huge), 'master-pass'); out.huge = 'opened'; } catch (e) { out.huge = e.code; }
      out.hugeFast = performance.now() - t0 < 2000;
      const badSalt = JSON.parse(b1); badSalt.kdf.salt = '%%not base64%%';
      try { await v.openVault(JSON.stringify(badSalt), 'master-pass'); out.badSalt = 'opened'; } catch (e) { out.badSalt = e.code; }
      return out;
    })()`);
    check('generated passwords have the requested length', r.len, true);
    check('generated passwords contain every chosen class', r.classes, true);
    check('generated passwords are all different', r.unique, true);
    check('digits only generator', r.digitsOnly, true);
    check('passphrase has 6 words from the list', r.pp, true);
    check('"password1" is very weak', r.weak, 0);
    check('a 24-char random password is very strong', r.strong, 4);
    check('empty password scores 0', r.empty, 0);
    check('CSV export / import round trip (quotes, commas, newlines)', r.csv, true);
    check('CSV import of a browser export (name,url,username,password)', r.csvChrome, (e) => e?.title === 'Site' && e.username === 'bob' && e.password === 'pw' && e.url.includes('site.example'));
    check('CSV without username / password column is refused', r.csvBad, 'ECSV');
    check('a new random IV for every save', r.ivDiffers, true);
    check('the blob holds no plaintext', r.noPlain, true);
    check('seal / open round trip', r.roundTrip, 'hunter2');
    check('wrong master password -> EBADPASS', r.wrong, 'EBADPASS');
    check('tampered header -> EBADPASS (bound as additional data)', r.tampered, 'EBADPASS');
    check('vault from a newer version -> ENEWER', r.newer, 'ENEWER');
    check('absurd PBKDF2 iteration count refused fast -> EFORMAT', [r.huge, r.hugeFast], ['EFORMAT', true]);
    check('non-base64 salt -> EFORMAT (not a generic error)', r.badSalt, 'EFORMAT');
  });

  await section('backend validation', async () => {
    await until(s, (app) => app && app.state === 'setup', { label: 'setup state' });
    const bad = await P(s, (app) => app.api.invoke('passwords:write', '{"secret":"plain"}').then(() => 'ok', (e) => e.code || e.message));
    check('backend refuses anything that is not an encrypted vault', bad, (v) => /EINVAL|Not an encrypted vault/.test(String(v)));
    check('no vault file was written', fs.existsSync(vaultPath(home)), false);
    const st = await P(s, (app) => app.api.invoke('passwords:status'));
    check('status: no vault yet', st.exists, false);
  });

  await section('create vault', async () => {
    await s.page.waitForSelector(`${WIN} .pw-setup #pw-master`);
    check('setup screen title', await s.page.textContent(`${WIN} .pw-gate-card h1`), 'Create your password vault');
    check('window title', await s.page.evaluate(`document.querySelector('${WIN}').querySelector('.title, .win-title')?.textContent || ''`), (v) => v.includes('Passwords'));
    await s.page.fill(`${WIN} #pw-master`, 'short');
    await s.page.fill(`${WIN} #pw-confirm`, 'short');
    check('strength meter reacts', await s.page.getAttribute(`${WIN} .pw-meter`, 'data-score'), '0');
    await s.page.click(`${WIN} .pw-go`);
    await waitText(s, `${WIN} .pw-error`, /./, 8000);
    check('too short master password refused', await s.page.textContent(`${WIN} .pw-error`), (v) => v.includes('at least 8'));
    await s.page.fill(`${WIN} #pw-master`, MASTER);
    await s.page.fill(`${WIN} #pw-confirm`, MASTER + 'x');
    check('strength meter shows a strong master password', Number(await s.page.getAttribute(`${WIN} .pw-meter`, 'data-score')), (v) => v >= 3);
    await s.page.click(`${WIN} .pw-go`);
    await waitText(s, `${WIN} .pw-error`, /match/, 8000);
    check('mismatched confirmation refused', true, true);
    check('nothing written yet', fs.existsSync(vaultPath(home)), false);
    await s.page.fill(`${WIN} #pw-confirm`, MASTER);
    await s.page.click(`${WIN} .pw-go`);
    await until(s, (app) => app.state === 'open', { label: 'vault open', timeout: 30000 });
    const file = vaultPath(home);
    check('vault file created', fs.existsSync(file), true);
    check('vault file mode is 0600', (fs.statSync(file).mode & 0o777).toString(8), '600');
    check('vault folder mode is 0700', (fs.statSync(path.dirname(file)).mode & 0o777).toString(8), '700');
    const blob = JSON.parse(fs.readFileSync(file, 'utf8'));
    check('version header', [blob.format, blob.version], ['aurora-vault', 1]);
    check('PBKDF2-SHA256 600000 iterations, 16-byte salt', [blob.kdf.name, blob.kdf.hash, blob.kdf.iterations, Buffer.from(blob.kdf.salt, 'base64').length], ['PBKDF2', 'SHA-256', 600000, 16]);
    check('AES-GCM 256 with a 12-byte IV', [blob.cipher.name, blob.cipher.bits, Buffer.from(blob.cipher.iv, 'base64').length], ['AES-GCM', 256, 12]);
    check('empty vault message', await s.page.textContent(`${WIN} .pw-empty`), (v) => v.includes('empty'));
  });

  let ivBefore;
  await section('add, view, edit entries', async () => {
    ivBefore = JSON.parse(fs.readFileSync(vaultPath(home), 'utf8')).cipher.iv;
    await addEntry(s, { title: 'Example Mail', username: 'alice@example.com', password: SECRET, url: 'mail.example.com', notes: 'Recovery codes in the safe' });
    await addEntry(s, { title: 'Bank', username: 'alice-bank', password: 'b4nk-Pass!word', url: 'https://bank.example' });
    await addEntry(s, { title: 'Zeta forum', username: 'zed', password: 'zz-123456', url: '' });
    const raw = fs.readFileSync(vaultPath(home), 'utf8');
    check('vault on disk never contains the secrets', [SECRET, 'alice@example.com', 'Example Mail'].some((x) => raw.includes(x)), false);
    check('a new IV after saving', JSON.parse(raw).cipher.iv !== ivBefore, true);
    check('three entries listed, sorted', await s.page.$$eval(`${WIN} .pw-item .pw-item-title`, (els) => els.map((e) => e.textContent)), ['Bank', 'Example Mail', 'Zeta forum']);
    await s.page.click(`${WIN} .pw-item:has-text("Example Mail")`);
    check('detail shows username', await s.page.textContent(`${WIN} .pw-user`), 'alice@example.com');
    check('password is masked', await s.page.textContent(`${WIN} .pw-secret`), (v) => !v.includes(SECRET) && /^•+$/.test(v));
    await s.page.click(`${WIN} .pw-reveal`);
    check('reveal shows the password', await s.page.textContent(`${WIN} .pw-secret`), SECRET);
    await s.page.click(`${WIN} .pw-reveal`);
    check('hide again', await s.page.textContent(`${WIN} .pw-secret`), (v) => !v.includes(SECRET));
    check('notes shown', await s.page.textContent(`${WIN} .pw-notes`), 'Recovery codes in the safe');
    check('host shown for a URL without scheme', await s.page.textContent(`${WIN} .pw-view-title .caption`), 'mail.example.com');
    check('a URL without scheme is a link', await s.page.textContent(`${WIN} .pw-link`), 'mail.example.com');
    const unsafe = await P(s, (app) => {
      const e = app.entry(app.selectedId);
      const keep = e.url;
      const out = {};
      for (const u of ['javascript:alert(1)', 'file:///etc/passwd', 'example.com:8080/x']) {
        e.url = u;
        app.render();
        const a = app.root.querySelector('.pw-link');
        out[u] = a ? 'link' : app.root.querySelector('.pw-row .selectable.ellipsis')?.textContent || 'none';
      }
      e.url = keep;
      app.render();
      return out;
    });
    check('javascript: / file: URLs are plain text, host:port stays a link', unsafe, { 'javascript:alert(1)': 'javascript:alert(1)', 'file:///etc/passwd': 'file:///etc/passwd', 'example.com:8080/x': 'link' });
    // Edit
    await s.page.click(`${WIN} .pw-edit`);
    await s.page.fill(`${WIN} #pw-f-username`, 'alice2@example.com');
    await s.page.keyboard.press('Enter');
    await until(s, (app) => !app.editing, { label: 'edit saved' });
    check('edited username shown', await s.page.textContent(`${WIN} .pw-user`), 'alice2@example.com');
    // Escape cancels an edit
    await s.page.click(`${WIN} .pw-edit`);
    await s.page.fill(`${WIN} #pw-f-username`, 'should-not-save');
    await s.page.keyboard.press('Escape');
    check('Escape cancels editing', await s.page.textContent(`${WIN} .pw-user`), 'alice2@example.com');
  });

  await section('favourites and search', async () => {
    await s.page.click(`${WIN} .pw-item:has-text("Zeta forum")`);
    await s.page.click(`${WIN} .pw-star`);
    await P(s, (app) => app.saving);
    check('favourite goes to the top', await s.page.$$eval(`${WIN} .pw-item .pw-item-title`, (els) => els[0].textContent), 'Zeta forum');
    await s.page.click(`${WIN} .pw-filter button:nth-child(2)`);
    check('favourites filter', await s.page.$$eval(`${WIN} .pw-item`, (els) => els.length), 1);
    await s.page.click(`${WIN} .pw-filter button:nth-child(1)`);
    await s.page.fill(`${WIN} .pw-search`, 'bank');
    check('search by title / url', await s.page.$$eval(`${WIN} .pw-item .pw-item-title`, (els) => els.map((e) => e.textContent)), ['Bank']);
    await s.page.fill(`${WIN} .pw-search`, 'safe');
    check('search in notes', await s.page.$$eval(`${WIN} .pw-item .pw-item-title`, (els) => els.map((e) => e.textContent)), ['Example Mail']);
    await s.page.fill(`${WIN} .pw-search`, 'nothing-like-this');
    check('no match message', await s.page.textContent(`${WIN} .pw-empty`), (v) => v.includes('No entries'));
    await s.page.fill(`${WIN} .pw-search`, '');
    check('search cleared', await s.page.$$eval(`${WIN} .pw-item`, (els) => els.length), 3);
  });

  await section('keyboard navigation', async () => {
    await s.page.click(`${WIN} .pw-item:has-text("Bank")`);
    await s.page.focus(`${WIN} .pw-item.selected`);
    await s.page.keyboard.press('ArrowDown');
    check('ArrowDown selects the next entry', await P(s, (app) => app.entry(app.selectedId).title), 'Example Mail');
    check('focus follows the selection', await s.page.evaluate(`document.activeElement?.classList.contains('pw-item') && document.activeElement.classList.contains('selected')`), true);
    await s.page.keyboard.press('Home');
    check('Home selects the first entry', await P(s, (app) => app.entry(app.selectedId).title), 'Zeta forum');
  });

  await section('copy to clipboard and clear', async () => {
    await P(s, (app) => app.setClipboardDelay(1500));
    await s.page.click(`${WIN} .pw-item:has-text("Example Mail")`);
    await s.page.click(`${WIN} .pw-copy-password`);
    await sleep(200);
    check('password copied', await clipboard(s), SECRET);
    check('toast tells when it is cleared', await s.page.textContent(`${WIN} .pw-toast`), (v) => /cleared in 2 seconds/.test(v));
    await sleep(2200);
    check('clipboard cleared after the delay', await clipboard(s), '');
    await s.page.click(`${WIN} .pw-copy-username`);
    await sleep(200);
    check('username copied', await clipboard(s), 'alice2@example.com');
    await setClipboard(s, 'something the user copied');
    await sleep(2200);
    check('clipboard left alone when it changed', await clipboard(s), 'something the user copied');
  });

  await section('generator', async () => {
    await s.page.click(`${WIN} .pw-gen`);
    await s.page.waitForSelector(`${DLG} .pw-gen-out`);
    const pw1 = await s.page.inputValue(`${DLG} .pw-gen-out`);
    check('generated password (default length 20)', pw1.length, 20);
    await s.page.click(`${DLG} .pw-gen-again`);
    check('regenerate gives another one', (await s.page.inputValue(`${DLG} .pw-gen-out`)) !== pw1, true);
    await s.page.click(`${DLG} .pw-gen-symbols`);
    check('symbols can be turned off', /^[A-Za-z0-9]+$/.test(await s.page.inputValue(`${DLG} .pw-gen-out`)), true);
    await s.page.click(`${DLG} .pw-gen-symbols`);
    await s.page.click(`${DLG} .pw-gen-mode button:nth-child(2)`);
    const pp = await s.page.inputValue(`${DLG} .pw-gen-out`);
    check('passphrase mode: 5 words', pp.split('-').length, 5);
    await s.page.click(`${DLG} .pw-gen-mode button:nth-child(1)`);
    await dialogButton(s, 'Close');
    // From the editor: "Use password" fills the field
    await s.page.click(`${WIN} .pw-new`);
    await s.page.fill(`${WIN} #pw-f-title`, 'Generated');
    await s.page.click(`${WIN} .pw-f-gen`);
    await s.page.waitForSelector(`${DLG} .pw-gen-out`);
    const g = await s.page.inputValue(`${DLG} .pw-gen-out`);
    await dialogButton(s, 'Use password');
    check('"Use password" fills the editor', await s.page.inputValue(`${WIN} #pw-f-password`), g);
    check('editor meter shows it is strong', Number(await s.page.getAttribute(`${WIN} .pw-editor .pw-meter`, 'data-score')), (v) => v >= 3);
    await s.page.click(`${WIN} .pw-save`);
    await until(s, (app) => !app.editing, { label: 'generated saved' });
    check('entry with generated password saved', await P(s, (app) => app.entry(app.selectedId).password.length), 20);
  });

  await section('delete entry', async () => {
    await s.page.click(`${WIN} .pw-item:has-text("Generated")`);
    await s.page.click(`${WIN} .pw-delete`);
    await dialogButton(s, 'Delete');
    await P(s, (app) => app.saving);
    check('entry deleted', await P(s, (app) => app.model.entries.map((e) => e.title).sort()), ['Bank', 'Example Mail', 'Zeta forum']);
  });

  await section('CSV import and export', async () => {
    const csvIn = path.join(home, 'Documents', 'import.csv');
    fs.writeFileSync(csvIn, 'name,url,username,password,note\n"Cloud, Inc.",https://cloud.example,carol,"pa""ss",multi\nForum,forum.example,dave,d4ve!,\nBank,https://bank.example,alice-bank,b4nk-Pass!word,\n');
    const res = await P(s, (app, p) => app.importCsv(p), csvIn);
    check('CSV import adds the new rows and skips duplicates', [res?.added, res?.skipped], [2, 1]);
    check('imported values kept (quotes, commas)', await P(s, (app) => app.model.entries.find((e) => e.title === 'Cloud, Inc.')?.password), 'pa"ss');
    const out = path.join(home, 'Documents', 'export.csv');
    s.page.evaluate(`document.querySelector('${WIN}').__passwords.exportCsv(${JSON.stringify(out)})`).catch(() => {});
    await s.page.waitForSelector(DLG);
    check('export warns that the file is not encrypted', await s.page.textContent(`${DLG} .dialog-body`), (v) => /NOT encrypted/.test(v));
    await dialogButton(s, 'Export anyway');
    await sleep(500);
    const text = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
    check('export file written with a header', text.split(/\r?\n/)[0], 'title,username,password,url,notes,favorite');
    check('export contains every entry', text.trim().split(/\r?\n/).length, 6);
    check('export keeps quotes escaped', text.includes('"Cloud, Inc.",carol,"pa""ss"'), true);
    await P(s, (app) => app.saving);
  });

  await section('lock and unlock', async () => {
    await s.page.click(`${WIN} .pw-lock`);
    await until(s, (app) => app.state === 'locked', { label: 'locked' });
    check('secrets dropped on lock', await P(s, (app) => [app.model, app.session]), [null, null]);
    check('locked screen shown', await s.page.textContent(`${WIN} .pw-gate-card h1`), 'Passwords are locked');
    await s.page.fill(`${WIN} #pw-master`, 'not-the-password');
    await s.page.click(`${WIN} .pw-go`);
    await waitText(s, `${WIN} .pw-error`, /Wrong master password/, 30000);
    check('wrong master password refused', await P(s, (app) => app.state), 'locked');
    await s.page.fill(`${WIN} #pw-master`, MASTER);
    await s.page.keyboard.press('Enter');
    await until(s, (app) => app.state === 'open', { label: 'unlocked', timeout: 30000 });
    check('entries back after unlock', await P(s, (app) => app.model.entries.length), 5);
    await s.page.focus(`${WIN} .pw-search`);
    await s.page.keyboard.press('Control+l');
    await until(s, (app) => app.state === 'locked', { label: 'Ctrl+L locked' });
    check('Ctrl+L locks', true, true);
  });

  await section('auto-lock and session lock', async () => {
    await s.page.fill(`${WIN} #pw-master`, MASTER);
    await s.page.click(`${WIN} .pw-go`);
    await until(s, (app) => app.state === 'open', { label: 'unlocked', timeout: 30000 });
    check('not locked while active', await P(s, (app) => app.checkIdle(Date.now() + 60000)), false);
    check('locks after 5 idle minutes', await P(s, (app) => app.checkIdle(Date.now() + 5 * 60000 + 1000)), true);
    check('idle message', await s.page.textContent(`${WIN} .pw-gate-sub`), (v) => v.includes('inactivity'));
    await s.page.fill(`${WIN} #pw-master`, MASTER);
    await s.page.click(`${WIN} .pw-go`);
    await until(s, (app) => app.state === 'open', { label: 'unlocked', timeout: 30000 });
    await P(s, (app) => app.setAutoLock(0));
    check('"Never" disables auto-lock', await P(s, (app) => app.checkIdle(Date.now() + 10 * 3600000)), false);
    await P(s, (app) => app.setAutoLock(15));
    // App storage holds only the preferences: no secrets.
    const dir = path.join(home, '.config', 'aurora', 'apps', 'passwords');
    const stored = fs.existsSync(dir) ? fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n') : '';
    check('preferences saved', stored, (v) => v.includes('"autoLockMinutes":15') || v.includes('"autoLockMinutes": 15'));
    check('no secrets in app storage or settings', [SECRET, MASTER, 'alice'].some((x) => stored.includes(x) || fs.readFileSync(path.join(home, '.config', 'aurora', 'settings.json'), 'utf8').includes(x)), false);
    await shot(s, 'light-en');
    await s.aurora(() => window.__aurora.shell.lock());
    await until(s, (app) => app.state === 'locked', { label: 'session lock' });
    check('locks when the session locks', await P(s, (app) => app.lockReason), 'session');
  });

  await section('no secrets in logs', async () => {
    check('console never shows secrets', s.logs.some((l) => [SECRET, MASTER, 'b4nk-Pass!word'].some((x) => l.includes(x))), false);
    check('no errors from the app', s.logs.filter((l) => /^\[(error|pageerror)\]/.test(l) && /passwords/i.test(l)), []);
  });
} finally {
  await s.app.close().catch(() => {});
}

// ---------------------------------------------------------------------------------------------- launch 2 (FR, dark)
const s2 = await launchShell({ open: ['passwords'], lang: 'fr', theme: 'dark', home, keepHome: true });
try {
  await section('relaunch in French + dark: persistence', async () => {
    await s2.page.waitForSelector(`${WIN} .pw-locked #pw-master`, { timeout: 30000 });
    check('locked screen in French', await s2.page.textContent(`${WIN} .pw-gate-card h1`), 'Les mots de passe sont verrouillés');
    check('unlock button in French', await s2.page.textContent(`${WIN} .pw-go`), 'Déverrouiller');
    await s2.page.fill(`${WIN} #pw-master`, MASTER);
    await s2.page.click(`${WIN} .pw-go`);
    await until(s2, (app) => app.state === 'open', { label: 'unlocked', timeout: 30000 });
    check('entries persisted across relaunch', await P(s2, (app) => app.model.entries.length), 5);
    check('auto-lock preference persisted', await P(s2, (app) => app.prefs.autoLockMinutes), 15);
    check('toolbar in French', await s2.page.textContent(`${WIN} .pw-new`), 'Nouvelle entrée');
    await s2.page.click(`${WIN} .pw-item:has-text("Example Mail")`);
    check('detail labels in French', await s2.page.$$eval(`${WIN} .pw-row-label`, (els) => els.map((e) => e.textContent)), ['Nom d’utilisateur', 'Mot de passe', 'Site web', 'Notes']);
    const bg = await s2.page.evaluate(`getComputedStyle(document.querySelector('${WIN} .pw-card')).color`);
    check('dark theme: light text', bg, (v) => { const m = v.match(/\d+/g).map(Number); return m[0] > 180 && m[1] > 180; });
    await shot(s2, 'dark-fr');
    check('no errors from the app (FR)', s2.logs.filter((l) => /^\[(error|pageerror)\]/.test(l) && /passwords/i.test(l)), []);
  });
} finally {
  await s2.close();
  fs.rmSync(home, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  ✗ ${f}`);
process.exit(failures.length ? 1 : 0);
