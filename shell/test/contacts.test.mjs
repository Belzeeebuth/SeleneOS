// Contacts tests: vCard helpers (pure), then the real shell: A–Z list + favourites, search, details, Send e-mail
// (Mail launch args), favourite toggle, new / edit / validation, photo, delete with confirmation, vCard import and
// export (3.0 + 4.0, several contacts per file), launch with a .vcf, keyboard, narrow layout, Mail recipient
// autocomplete fed by contacts:search, persistence across relaunch, French + dark theme.
// Usage:  cd aurora-os/shell && xvfb-run -a -s "-screen 0 1600x900x24" node test/contacts.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { launchShell, ROOT } from './lib.mjs';

const require = createRequire(import.meta.url);
const backend = require('../main/ipc/contacts.js');
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
const WIN = '.win.app-contacts';
const DLG = `${WIN} .dialog-layer:not(.closing) .dialog`;

// Evaluate fn(app, arg) in the page for the Contacts window (string expression: the page CSP forbids eval).
function CT(s, fn, arg) {
  return s.page.evaluate(`(async () => { const el = document.querySelector(${JSON.stringify(WIN)}); return (${fn.toString()})(el && el.__contacts, ${JSON.stringify(arg ?? null)}); })()`);
}
async function until(s, fn, { timeout = 8000, label = 'condition', arg } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = await CT(s, fn, arg).catch((e) => `ERR ${e.message}`);
    if (last && !(typeof last === 'string' && last.startsWith('ERR'))) return last;
    await sleep(80);
  }
  throw new Error(`timed out waiting for ${label} (last: ${JSON.stringify(last)})`);
}
const names = (s) => s.page.$$eval(`${WIN} .ct-row`, (els) => els.map((e) => `${e.dataset.group}:${e.querySelector('.ct-row-name').textContent}`));
async function shotWin(s, file) {
  await sleep(400);
  const rect = await s.page.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(WIN)}).getBoundingClientRect(); return { x: Math.max(0, r.x - 1), y: Math.max(0, r.y - 1), width: r.width + 2, height: r.height + 2 }; })()`);
  await s.page.screenshot({ path: file, clip: rect });
}

// ---------------------------------------------------------------- fixtures
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-contacts-'));
const dataFile = path.join(home, '.local', 'share', 'aurora', 'contacts.json');
fs.mkdirSync(path.dirname(dataFile), { recursive: true });
const seed = [
  { id: 'c-alice', name: 'Alice Martin', first: 'Alice', last: 'Martin', company: 'Contoso', emails: [{ type: 'work', value: 'alice@contoso.example' }], phones: [{ type: 'mobile', value: '+33 6 12 34 56 78' }], address: '12 rue de la Paix\n75002 Paris', birthday: '1990-05-04', notes: 'Met at the Aurora launch', favorite: true },
  { id: 'c-bob', name: 'Bob Leroy', first: 'Bob', last: 'Leroy', emails: [{ type: 'home', value: 'bob@leroy.example' }], phones: [] },
  { id: 'c-eloise', name: 'Éloïse Durand', first: 'Éloïse', last: 'Durand', company: 'Fabrikam', emails: [{ type: 'work', value: 'eloise@fabrikam.example' }], phones: [{ type: 'work', value: '01 23 45 67 89' }] },
  { id: 'c-zoe', name: 'Zoé Bernard', emails: [], phones: [{ type: 'home', value: '04 11 22 33 44' }] },
  { id: 'c-num', name: '42 Pizza', company: '42 Pizza', emails: [], phones: [{ type: 'work', value: '05 55 55 55 55' }] },
];
fs.writeFileSync(dataFile, JSON.stringify({ version: 1, contacts: seed }));
const docs = path.join(home, 'Documents');
fs.mkdirSync(docs, { recursive: true });
const importFile = path.join(docs, 'friends.vcf');
fs.writeFileSync(
  importFile,
  [
    'BEGIN:VCARD', 'VERSION:3.0', 'FN:Carla Gómez', 'N:Gómez;Carla;;;', 'EMAIL;TYPE=INTERNET,HOME:carla@gomez.example', 'TEL;TYPE=CELL:+34 600 000 000', 'ORG:Adatum', 'BDAY:1985-12-24', 'NOTE:Line one\\nLine two\\, with comma', 'END:VCARD',
    'BEGIN:VCARD', 'VERSION:4.0', 'FN:David Okafor', 'N:Okafor;David;;;', 'EMAIL;TYPE=work:david@okafor.example', 'TEL;TYPE=work;VALUE=uri:tel:+44-20-7946-0000', 'ADR;TYPE=work:;;1 Long Road;London;;SW1A 1AA;UK', 'END:VCARD',
  ].join('\r\n'),
);
// 1x1 PNG
const png = path.join(home, 'Pictures', 'face.png');
fs.mkdirSync(path.dirname(png), { recursive: true });
fs.writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));

console.log('Contacts tests');

// ---------------------------------------------------------------- pure helpers
await section('vCard parse / serialize (pure)', async () => {
  const cards = backend.parseVCards(fs.readFileSync(importFile, 'utf8'));
  check('two cards parsed', cards.length, 2);
  check('3.0 name', cards[0].name, 'Carla Gómez');
  check('3.0 mobile phone', cards[0].phones[0], { type: 'mobile', value: '+34 600 000 000' });
  check('3.0 escaped note', cards[0].notes, 'Line one\nLine two, with comma');
  check('3.0 birthday', cards[0].birthday, '1985-12-24');
  check('4.0 tel: uri stripped', cards[1].phones[0].value, '+44-20-7946-0000');
  check('4.0 address', cards[1].address, '1 Long Road\nSW1A 1AA London\nUK');
  const v21 = backend.parseVCards('BEGIN:VCARD\nVERSION:2.1\nN:Doe;John\nTEL;CELL:123\nEMAIL;INTERNET:j@d.example\nNOTE;ENCODING=QUOTED-PRINTABLE;CHARSET=UTF-8:caf=C3=A9\nEND:VCARD');
  check('2.1 quoted-printable + N fallback name', [backend.normalize(v21[0]).name, v21[0].notes], ['John Doe', 'café']);
  const c = backend.normalize({ ...seed[0], photo: 'data:image/png;base64,AAAA', notes: 'a;b,c\nd' });
  for (const ver of ['3.0', '4.0']) {
    const txt = backend.toVCards([c, backend.normalize(seed[1])], ver);
    check(`${ver}: two cards`, (txt.match(/BEGIN:VCARD/g) || []).length, 2);
    check(`${ver}: version line`, txt.includes(`VERSION:${ver}`), true);
    check(`${ver}: lines folded at 75`, txt.split('\r\n').every((l) => l.length <= 75), true);
    const back = backend.parseVCards(txt)[0];
    check(`${ver}: round trip`, [back.name, back.emails[0].value, back.phones[0], back.address, back.birthday, back.notes, back.favorite, back.photo], [c.name, c.emails[0].value, c.phones[0], c.address, c.birthday, c.notes, true, c.photo]);
  }
  const hits = backend.search(seed.map((x) => backend.normalize(x)), 'elo');
  check('search folds accents', hits.map((x) => x.address), ['eloise@fabrikam.example']);
  check('search favourites first', backend.search(seed.map((x) => backend.normalize(x)), 'example').slice(0, 1).map((x) => x.address), ['alice@contoso.example']);
});

// ---------------------------------------------------------------- shell (EN, light)
let s = await launchShell({ home, keepHome: true, open: ['contacts'], lang: 'en', theme: 'light' });
const appErrors = () => s.logs.filter((l) => /^\[(error|pageerror)\]/.test(l) && /contacts/i.test(l));

await section('list: A–Z groups and favourites', async () => {
  await s.page.waitForSelector(`${WIN} .ct-row`, { timeout: 20000 });
  check('rows (favourite + 5 A–Z)', await names(s), ['fav:Alice Martin', 'A:Alice Martin', 'B:Bob Leroy', 'E:Éloïse Durand', 'Z:Zoé Bernard', '#:42 Pizza']);
  check('group headers', await s.page.$$eval(`${WIN} .ct-group`, (els) => els.map((e) => e.textContent)), ['Favourites', 'A', 'B', 'E', 'Z', '#']);
  check('count', await s.page.textContent(`${WIN} .ct-count`), '5 contacts');
  check('empty detail prompt', await s.page.textContent(`${WIN} .ct-empty .subtitle`), 'Select a contact');
});

await section('search', async () => {
  await s.page.fill(`${WIN} .ct-search`, 'fabrik');
  check('company match', await names(s), ['E:Éloïse Durand']);
  await s.page.fill(`${WIN} .ct-search`, 'eloise');
  check('accent-insensitive', await names(s), ['E:Éloïse Durand']);
  await s.page.fill(`${WIN} .ct-search`, '0411');
  check('phone digits', await names(s), ['Z:Zoé Bernard']);
  await s.page.fill(`${WIN} .ct-search`, 'nobody here');
  check('no results text', await s.page.textContent(`${WIN} .ct-list-empty`), 'No contacts match “nobody here”');
  await s.page.focus(`${WIN} .ct-search`);
  await s.page.keyboard.press('Escape');
  check('Esc clears search', [await s.page.inputValue(`${WIN} .ct-search`), (await names(s)).length], ['', 6]);
});

await section('details + Send e-mail', async () => {
  await s.page.click(`${WIN} .ct-row[data-id="c-alice"][data-group="A"]`);
  await s.page.waitForSelector(`${WIN} .ct-detail[data-id="c-alice"]`);
  check('name', await s.page.textContent(`${WIN} .ct-name`), 'Alice Martin');
  check('company', await s.page.textContent(`${WIN} .ct-company`), 'Contoso');
  const fields = await s.page.$$eval(`${WIN} .ct-field`, (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
  check('e-mail field', fields[0], 'E-mail · Work alice@contoso.example');
  check('phone field', fields[1], 'Phone · Mobile +33 6 12 34 56 78');
  check('address multiline', await s.page.textContent(`${WIN} .ct-field:nth-child(3) .ct-value`), '12 rue de la Paix\n75002 Paris');
  check('birthday formatted', fields[3], 'Birthday May 4, 1990');
  await CT(s, (app) => {
    window.__ctLaunch = [];
    app.__origLaunch = app.ctx.shell.launch;
    app.ctx.shell.launch = (id, args) => (window.__ctLaunch.push([id, args]), null);
    return true;
  });
  await s.page.click(`${WIN} .ct-mail`);
  check('Send e-mail launches Mail compose', await s.page.evaluate('window.__ctLaunch'), [['mail', { to: '"Alice Martin" <alice@contoso.example>' }]]);
  await s.page.click(`${WIN} .ct-row[data-id="c-zoe"]`);
  check('no e-mail: button disabled', await s.page.isDisabled(`${WIN} .ct-mail`), true);
  await CT(s, (app) => ((app.ctx.shell.launch = app.__origLaunch), true));
});

await section('favourite toggle persists', async () => {
  await s.page.click(`${WIN} .ct-fav`);
  await until(s, () => !!document.querySelector('.win.app-contacts .ct-row[data-id="c-zoe"][data-group="fav"]'), { label: 'zoe in favourites' });
  check('aria-pressed', await s.page.getAttribute(`${WIN} .ct-fav`, 'aria-pressed'), 'true');
  const disk = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  check('saved to disk', disk.contacts.find((c) => c.id === 'c-zoe').favorite, true);
  await s.page.click(`${WIN} .ct-fav`);
  await until(s, () => !document.querySelector('.win.app-contacts .ct-row[data-id="c-zoe"][data-group="fav"]'), { label: 'zoe unfavourited' });
  check('unfavourite', JSON.parse(fs.readFileSync(dataFile, 'utf8')).contacts.find((c) => c.id === 'c-zoe').favorite, false);
});

await section('new contact: validation, photo, save', async () => {
  await s.page.click(`${WIN} .ct-new`);
  await s.page.waitForSelector(`${WIN} .ct-form`);
  check('title', await s.page.textContent(`${WIN} .ct-form-title`), 'New contact');
  check('first name focused', await s.page.evaluate(`document.activeElement?.name`), 'first');
  await s.page.click(`${WIN} .ct-save`);
  check('empty form refused', await s.page.textContent(`${WIN} .ct-form-error`), 'Enter a name, an e-mail address or a phone number.');
  await s.page.fill(`${WIN} input[name="first"]`, 'Hugo');
  await s.page.fill(`${WIN} input[name="last"]`, 'Petit');
  await s.page.fill(`${WIN} input[name="company"]`, 'Northwind');
  await s.page.fill(`${WIN} input[name="emails-0"]`, 'hugo@northwind.example');
  await s.page.click(`${WIN} .ct-multi[data-key="emails"] .ct-add`);
  check('add e-mail focuses new row', await s.page.evaluate(`document.activeElement?.name`), 'emails-1');
  await s.page.keyboard.type('h.petit@home.example');
  await s.page.locator(`${WIN} .ct-multi[data-key="emails"] .ct-multi-row`).nth(1).locator('select').selectOption('other');
  await s.page.fill(`${WIN} input[name="phones-0"]`, '06 00 00 00 01');
  await s.page.fill(`${WIN} input[name="birthday"]`, '2001-02-03');
  await s.page.fill(`${WIN} textarea[name="address"]`, '1 Main St\nSpringfield');
  await s.page.fill(`${WIN} textarea[name="notes"]`, '<b>not html</b>');
  await CT(s, (app, p) => {
    app.__origPicker = app.ctx.ui.filePicker;
    app.ctx.ui.filePicker = async () => p;
    return true;
  }, png);
  await s.page.click(`${WIN} .ct-photo-pick`);
  await s.page.waitForSelector(`${WIN} .ct-photo .ct-avatar img`);
  check('photo preview is a data URL', await s.page.getAttribute(`${WIN} .ct-photo .ct-avatar img`, 'src'), (v) => /^data:image\/png;base64,/.test(v));
  check('remove photo button shown', await s.page.isVisible(`${WIN} .ct-photo-remove`), true);
  await s.page.keyboard.press('Control+s');
  await s.page.waitForSelector(`${WIN} .ct-detail`);
  check('saved + selected', await s.page.textContent(`${WIN} .ct-name`), 'Hugo Petit');
  check('in list under H', (await names(s)).includes('H:Hugo Petit'), true);
  check('status toast', await s.page.textContent(`${WIN} .ct-status`), 'Contact saved');
  check('notes shown as text', await s.page.textContent(`${WIN} .ct-field:last-child .ct-value`), '<b>not html</b>');
  const disk = JSON.parse(fs.readFileSync(dataFile, 'utf8')).contacts.find((c) => c.name === 'Hugo Petit');
  check('disk: fields', [disk.company, disk.emails, disk.phones[0].value, disk.birthday, disk.address], ['Northwind', [{ type: 'home', value: 'hugo@northwind.example' }, { type: 'other', value: 'h.petit@home.example' }], '06 00 00 00 01', '2001-02-03', '1 Main St\nSpringfield']);
  check('disk: photo', disk.photo.startsWith('data:image/png;base64,'), true);
  check('atomic write leaves no temp file', fs.readdirSync(path.dirname(dataFile)).filter((f) => f.includes('.tmp')), []);
});

await section('edit + cancel with discard prompt', async () => {
  await s.page.click(`${WIN} .ct-edit`);
  await s.page.waitForSelector(`${WIN} .ct-form`);
  check('edit title', await s.page.textContent(`${WIN} .ct-form-title`), 'Edit contact');
  check('prefilled', await s.page.inputValue(`${WIN} input[name="first"]`), 'Hugo');
  await s.page.fill(`${WIN} input[name="company"]`, 'Tailspin');
  await s.page.click(`${WIN} .ct-cancel`);
  await s.page.waitForSelector(DLG);
  check('discard confirmation', await s.page.textContent(`${DLG}`), (t) => t.includes('Discard changes?'));
  await s.page.keyboard.press('Escape');
  await sleep(300);
  check('still editing after Esc on prompt', await s.page.inputValue(`${WIN} input[name="company"]`), 'Tailspin');
  await s.page.click(`${WIN} .ct-save`);
  await s.page.waitForSelector(`${WIN} .ct-detail`);
  check('company updated', await s.page.textContent(`${WIN} .ct-company`), 'Tailspin');
  // Edit an imported-style contact with only a display name: name split into first / last.
  await s.page.click(`${WIN} .ct-row[data-id="c-num"]`);
  await s.page.keyboard.press('Control+e');
  await s.page.waitForSelector(`${WIN} .ct-form`);
  check('name split into first / last', [await s.page.inputValue(`${WIN} input[name="first"]`), await s.page.inputValue(`${WIN} input[name="last"]`)], ['42', 'Pizza']);
  await s.page.keyboard.press('Escape');
  await s.page.waitForSelector(`${WIN} .ct-detail`);
  check('Esc leaves an unchanged form', await s.page.textContent(`${WIN} .ct-name`), '42 Pizza');
});

await section('delete with confirmation', async () => {
  await s.page.click(`${WIN} .ct-row[data-id="c-bob"]`);
  await s.page.click(`${WIN} .ct-delete`);
  await s.page.waitForSelector(DLG);
  check('confirm text', await s.page.textContent(`${DLG}`), (t) => t.includes('Delete “Bob Leroy”?'));
  await s.page.locator(`${DLG} .dialog-footer .btn`, { hasText: 'Cancel' }).click();
  await sleep(300);
  check('cancel keeps the contact', (await names(s)).includes('B:Bob Leroy'), true);
  await s.page.click(`${WIN} .ct-delete`);
  await s.page.waitForSelector(DLG);
  await s.page.locator(`${DLG} .dialog-footer .btn`, { hasText: 'Delete' }).click();
  await until(s, () => !document.querySelector('.win.app-contacts .ct-row[data-id="c-bob"]'), { label: 'bob deleted' });
  check('deleted on disk', JSON.parse(fs.readFileSync(dataFile, 'utf8')).contacts.some((c) => c.id === 'c-bob'), false);
  check('next contact selected', await s.page.getAttribute(`${WIN} .ct-row.selected`, 'data-id'), 'c-eloise');
  check('focus on the next row', await s.page.evaluate(`document.activeElement?.dataset?.id`), 'c-eloise');
});

await section('vCard import + export', async () => {
  await CT(s, (app, p) => ((app.ctx.ui.filePicker = async () => p), true), importFile);
  await s.page.click(`${WIN} .ct-more`);
  await s.page.locator('.menu .menu-item', { hasText: 'Import vCard' }).click();
  await until(s, () => document.querySelectorAll('.win.app-contacts .ct-row').length === 8, { label: 'imported rows' });
  check('import status', await s.page.textContent(`${WIN} .ct-status`), 'Imported 2 new and updated 0 contacts.');
  check('imported names', (await names(s)).filter((n) => /Carla|David/.test(n)), ['C:Carla Gómez', 'D:David Okafor']);
  await s.page.click(`${WIN} .ct-more`);
  await s.page.locator('.menu .menu-item', { hasText: 'Import vCard' }).click();
  await until(s, () => /updated 2/.test(document.querySelector('.win.app-contacts .ct-status')?.textContent || ''), { label: 're-import status' });
  check('re-import updates, no duplicates', (await names(s)).length, 8);
  for (const [label, ver] of [['Export all (vCard 3.0)', '3.0'], ['Export all (vCard 4.0)', '4.0']]) {
    const out = path.join(docs, `all-${ver}.vcf`);
    // Clear the previous export's toast so the wait below sees this export's own result.
    await CT(s, (app, p) => ((app.ctx.ui.filePicker = async () => p), (app.status.textContent = ''), true), out);
    await s.page.click(`${WIN} .ct-more`);
    await s.page.locator('.menu .menu-item', { hasText: label }).click();
    await until(s, () => /Exported 7 contacts/.test(document.querySelector('.win.app-contacts .ct-status')?.textContent || ''), { label: `export ${ver}` });
    for (let i = 0; i < 50 && !fs.existsSync(out); i++) await sleep(100);
    const txt = fs.readFileSync(out, 'utf8');
    check(`export ${ver}: 7 cards`, (txt.match(/BEGIN:VCARD/g) || []).length, 7);
    check(`export ${ver}: version`, (txt.match(new RegExp(`VERSION:${ver.replace('.', '\\.')}`, 'g')) || []).length, 7);
    check(`export ${ver}: re-parses`, backend.parseVCards(txt).map((c) => c.name).sort().join('|'), (v) => v.includes('Hugo Petit') && v.includes('Carla Gómez'));
  }
  const one = path.join(docs, 'one.vcf');
  await CT(s, (app, p) => ((app.ctx.ui.filePicker = async () => p), true), one);
  await s.page.click(`${WIN} .ct-row[data-id="c-alice"][data-group="A"]`);
  await s.page.click(`${WIN} .ct-export`);
  await until(s, () => /Exported 1 contact\./.test(document.querySelector('.win.app-contacts .ct-status')?.textContent || ''), { label: 'export one' });
  check('single export', backend.parseVCards(fs.readFileSync(one, 'utf8')).map((c) => c.name), ['Alice Martin']);
  await CT(s, (app, p) => ((app.ctx.ui.filePicker = async () => p), true), png);
  await s.page.click(`${WIN} .ct-more`);
  await s.page.locator('.menu .menu-item', { hasText: 'Import vCard' }).click();
  await until(s, () => /Could not import/.test(document.querySelector('.win.app-contacts .ct-status')?.textContent || ''), { label: 'import error' });
  check('bad file: error toast', await s.page.getAttribute(`${WIN} .ct-status`, 'class'), (c) => c.includes('error'));
  await CT(s, (app) => ((app.ctx.ui.filePicker = app.__origPicker), true));
});

await section('keyboard', async () => {
  await s.page.focus(`${WIN} .ct-row[data-id="c-alice"][data-group="A"]`);
  await s.page.keyboard.press('ArrowDown');
  check('ArrowDown: focus and selection move together', await s.page.evaluate(`document.activeElement?.classList.contains('selected') && document.activeElement.dataset.group`), 'C');
  check('selection follows focus', await s.page.textContent(`${WIN} .ct-name`), 'Carla Gómez');
  await s.page.keyboard.press('End');
  check('End: last row', await s.page.textContent(`${WIN} .ct-name`), '42 Pizza');
  await s.page.keyboard.press('Home');
  check('Home: first row (favourite)', await s.page.textContent(`${WIN} .ct-name`), 'Alice Martin');
  check('one tab stop in the list', await s.page.$$eval(`${WIN} .ct-row`, (els) => els.filter((e) => e.tabIndex === 0).length), 1);
  await s.page.keyboard.press('Control+f');
  check('Ctrl+F focuses search', await s.page.evaluate(`document.activeElement?.classList.contains('ct-search')`), true);
  await s.page.keyboard.type('okafor');
  await s.page.keyboard.press('ArrowDown');
  check('ArrowDown from search enters the list', await s.page.textContent(`${WIN} .ct-name`), 'David Okafor');
  await s.page.keyboard.press('Delete');
  await s.page.waitForSelector(DLG);
  check('Delete key asks first', await s.page.textContent(DLG), (t) => t.includes('David Okafor'));
  await s.page.keyboard.press('Escape');
  await sleep(300);
  await s.page.keyboard.press('Control+n');
  await s.page.waitForSelector(`${WIN} .ct-form`);
  check('Ctrl+N opens a new form', await s.page.textContent(`${WIN} .ct-form-title`), 'New contact');
  await s.page.keyboard.press('Escape');
  await s.page.waitForSelector(`${WIN} .ct-form`, { state: 'detached' });
  await s.page.fill(`${WIN} .ct-search`, '');
  check('no contacts errors in console', appErrors(), []);
});

await section('Mail recipient autocomplete uses contacts:search', async () => {
  check('backend search', await s.page.evaluate(`window.__aurora.api.invoke('contacts:search', 'carl')`), [{ id: (await CT(s, (app) => app.contacts.find((c) => c.name === 'Carla Gómez').id)), name: 'Carla Gómez', address: 'carla@gomez.example', favorite: false }]);
  await s.page.evaluate(`(async () => {
    const { AddressField } = await import(new URL('apps/mail/lib/chips.js', location.href).href);
    const a = window.__aurora;
    const { icon } = await import(new URL('core/icons.js', location.href).href);
    const f = new AddressField({ h: a.h, icon, ui: a.ui, api: a.api, t: (k) => k }, { label: 'To', name: 'to' });
    f.el.id = 'ct-mail-probe';
    Object.assign(f.el.style, { position: 'fixed', left: '20px', top: '20px', width: '400px', zIndex: 99999, background: 'white' });
    document.body.appendChild(f.el);
    window.__ctField = f;
  })()`);
  await s.page.focus('#ct-mail-probe input');
  await s.page.keyboard.type('okaf');
  await s.page.waitForSelector('#ct-mail-probe .ml-suggest-item', { timeout: 5000 });
  check('contact suggested', await s.page.textContent('#ct-mail-probe .ml-suggest-item'), (t) => t.includes('David Okafor') && t.includes('david@okafor.example'));
  await s.page.keyboard.press('Enter');
  check('picked as a chip', await s.page.evaluate(`JSON.stringify(window.__ctField.value)`), JSON.stringify([{ name: 'David Okafor', address: 'david@okafor.example' }]));
  await s.page.evaluate(`document.getElementById('ct-mail-probe').remove()`);
});

await section('launch with a .vcf + narrow layout + screenshot', async () => {
  const extra = path.join(docs, 'extra.vcf');
  fs.writeFileSync(extra, 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Inès Laurent\r\nEMAIL:ines@laurent.example\r\nEND:VCARD\r\n');
  await s.page.evaluate(`window.__aurora.shell.launch('contacts', { file: ${JSON.stringify(extra)} })`);
  await until(s, () => document.querySelector('.win.app-contacts .ct-name')?.textContent === 'Inès Laurent', { label: 'opened vcf' });
  check('one window (singleInstance)', await s.page.$$eval(WIN, (e) => e.length), 1);
  check('imported from launch args', (await names(s)).includes('I:Inès Laurent'), true);
  await s.page.click(`${WIN} .ct-row[data-id="c-alice"][data-group="A"]`);
  await sleep(200);
  await shotWin(s, path.join(DOCS, 'contacts-light-en.png'));
  const id = await s.page.evaluate(`window.__aurora.wm.windows ? [...window.__aurora.wm.windows.values()].find((w) => w.el.classList.contains('app-contacts'))?.id : null`).catch(() => null);
  await CT(s, (app) => (app.ctx.win.setSize(440, 560), true));
  await until(s, () => document.querySelector('.win.app-contacts .ct').classList.contains('narrow'), { label: 'narrow' });
  check('narrow: detail shown alone', [await s.page.isVisible(`${WIN} .ct-side`), await s.page.isVisible(`${WIN} .ct-main`)], [false, true]);
  await s.page.click(`${WIN} .ct-back`);
  check('back to list', [await s.page.isVisible(`${WIN} .ct-side`), await s.page.isVisible(`${WIN} .ct-main`)], [true, false]);
  check('focus returns to the row', await s.page.evaluate(`document.activeElement?.dataset?.id`), 'c-alice');
  void id;
});

await s.close();

// ---------------------------------------------------------------- relaunch (FR, dark)
s = await launchShell({ home, keepHome: true, open: ['contacts'], lang: 'fr', theme: 'dark' });
await section('persistence + French + dark theme', async () => {
  await s.page.waitForSelector(`${WIN} .ct-row`, { timeout: 20000 });
  check('contacts persisted', (await names(s)).length, 9);
  check('French count', await s.page.textContent(`${WIN} .ct-count`), '8 contacts');
  check('French favourites group', await s.page.textContent(`${WIN} .ct-group[data-group="fav"]`), 'Favoris');
  await s.page.click(`${WIN} .ct-row[data-id="c-alice"][data-group="A"]`);
  check('French Send e-mail', (await s.page.textContent(`${WIN} .ct-mail`)).trim(), 'Envoyer un e-mail');
  check('French birthday', await s.page.textContent(`${WIN} .ct-field:nth-child(4) .ct-value`), '4 mai 1990');
  check('French phone type', await s.page.textContent(`${WIN} .ct-field:nth-child(2) .caption`), 'Téléphone · Mobile');
  check('dark theme applied', await s.page.evaluate(`document.documentElement.dataset.theme`), 'dark');
  const bg = await s.page.evaluate(`getComputedStyle(document.querySelector('.win.app-contacts .ct-name')).color`);
  check('light text on dark', bg, (c) => {
    const m = c.match(/\d+/g).map(Number);
    return m[0] > 180 && m[1] > 180 && m[2] > 180;
  });
  await shotWin(s, path.join(DOCS, 'contacts-dark-fr.png'));
  await s.page.click(`${WIN} .ct-edit`);
  await s.page.waitForSelector(`${WIN} .ct-form`);
  check('French form labels', await s.page.$$eval(`${WIN} .ct-input > .caption`, (els) => els.map((e) => e.textContent).slice(0, 4)), ['Prénom', 'Nom', 'Entreprise', 'Anniversaire']);
  check('French type options', await s.page.$$eval(`${WIN} .ct-multi[data-key="phones"] option`, (els) => els.map((e) => e.textContent)), ['Domicile', 'Travail', 'Mobile', 'Autre']);
  await s.page.keyboard.press('Escape');
  check('no contacts errors in console (fr)', appErrors(), []);
});
await s.close();
fs.rmSync(home, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  ✗ ${f}`);
process.exit(failures.length ? 1 : 0);
