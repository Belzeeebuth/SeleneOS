// Store tests — catalog JSON, aggregator parsers (sanitize / merge / rank), admin action validation, helper syntax, and
// the real Electron shell (dev mode) with the multi-source catalogue (docs/STORE-SOURCES.md): stub Ubuntu + Flathub
// modules from test/fixtures/store-ui-sources (AURORA_STORE_SOURCES_DIR), simulated apt through the UAC prompt.
// Home / featured / categories / search merge + badges / Load more / details + source picker / install from a
// non-default source with progress / Open / Installed / Sources (refresh, Flathub on/off, no-network error) /
// French + dark + live note / narrow window / console errors. When shell/main/lib/sources/{ubuntu,flathub}.js exist,
// a last run checks the Store against their own dev fixtures.
//   Documentation screenshots: aurora-os/docs/screenshots/store-light-en.png, store-dark-fr.png
// Usage:  cd aurora-os/shell && xvfb-run -a -s "-screen 0 1600x900x24" node test/store.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { launchShell, ROOT } from './lib.mjs';

const require = createRequire(import.meta.url);
const DOCS = path.join(ROOT, '..', 'docs', 'screenshots');
const CATALOG = path.join(ROOT, '..', 'rootfs', 'usr', 'share', 'aurora', 'store', 'catalog.json');
const HELPER = path.join(ROOT, '..', 'rootfs', 'usr', 'lib', 'aurora', 'helpers', 'aurora-admin');
const STUBS = path.join(ROOT, 'test', 'fixtures', 'store-ui-sources');
const REAL_SOURCES = ['ubuntu', 'flathub'].every((id) => fs.existsSync(path.join(ROOT, 'main', 'lib', 'sources', `${id}.js`)));
fs.mkdirSync(DOCS, { recursive: true });

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
async function uac(s, password = 'aurora') {
  await s.page.waitForSelector('.uac-dialog', { timeout: 10000 });
  const pw = s.page.locator('.uac-dialog input[type=password]');
  if (await pw.count()) await pw.fill(password);
  await s.page.locator('.uac-dialog .dialog-footer .btn.primary').click();
  await s.page.waitForSelector('.uac-dialog', { state: 'detached', timeout: 10000 }).catch(() => {});
}
const W = '.app-store';

// ------------------------------------------------------------------ static checks (no Electron)
{
  const cat = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));
  const items = cat.items;
  check('catalog: at least 25 items', items.length >= 25, true);
  check('catalog: every apt package matches the strict pattern', items.every((i) => /^[a-z0-9][a-z0-9+.-]{1,62}$/.test(i.apt)), true);
  check('catalog: unique ids', new Set(items.map((i) => i.id)).size, items.length);
  check('catalog: EN + FR descriptions everywhere', items.every((i) => i.description?.en && i.description?.fr), true);
  // Phosphor names, or old Fluent names through the aliases (same rule as core/icons.js resolveIcon)
  const knownIcon = ((j) => (n) => { n = String(n).replace(/_filled$/, ''); const a = j.aliases[n]; if (a) return !!j.glyphs[a.split(':')[0]]; if (j.glyphs[n]) return true; const m = /^(.+)-(fill|bold|regular)$/.exec(n); return !!(m && j.glyphs[m[1]]); })(require(path.join(ROOT, 'renderer', 'assets', 'icons', 'phosphor.json')));
  check('catalog: every icon exists', items.filter((i) => !knownIcon(i.icon)).map((i) => i.id), []);
  check('catalog: graphical apps declare gui + their .desktop file, no snaps', items.filter((i) => i.gui).every((i) => /^[A-Za-z0-9][A-Za-z0-9._-]*\.desktop$/.test(i.desktop) && !/^(firefox|chromium|thunderbird)/.test(i.apt)) && items.some((i) => i.gui), true);
  const { parsers } = require(path.join(ROOT, 'main', 'ipc', 'store.js'));
  const parsed = parsers.parseCatalog({ items: [...items, { id: 'bad', apt: '-oops' }, { id: 'git', apt: 'git' }, null, { apt: 'x;rm' }] });
  check('parseCatalog drops invalid / duplicate entries', parsed.length, items.length);
  check('parseDpkgQuery keeps only installed (ii) packages', parsers.parseDpkgQuery('git\tii \t1:2.43\nhtop\tun \t\nvim:amd64\tii \t2:9.1\nbad line\n'), { git: '1:2.43', vim: '2:9.1' });
  const admin = require(path.join(ROOT, 'main', 'ipc', 'admin.js'));
  check('admin: store-install validates a catalog-style name', admin.parsers.validate('store-install', ['fd-find']).args, ['fd-find']);
  let code = null;
  try {
    admin.parsers.validate('store-remove', ['--purge']);
  } catch (e) {
    code = e.code;
  }
  check('admin: store-remove refuses option-like names', code, 'EINVAL');
  code = null;
  try {
    admin.parsers.validate('store-install', ['git', 'vim']);
  } catch (e) {
    code = e.code;
  }
  check('admin: store-install takes exactly one package', code, 'EINVAL');
  check('admin: store actions stream progress', !!admin.parsers.ACTIONS['store-install'].stream && !!admin.parsers.ACTIONS['store-remove'].stream, true);
  let syntax = true;
  try {
    execFileSync('bash', ['-n', HELPER]);
  } catch {
    syntax = false;
  }
  check('helper: bash syntax ok', syntax, true);
  const helper = fs.readFileSync(HELPER, 'utf8');
  check('helper: store block uses --no-install-recommends and the root-owned catalog', /store-install \| store-remove\)[\s\S]*--no-install-recommends[\s\S]*END store actions/.test(helper) && helper.includes('/usr/share/aurora/store/catalog.json'), true);
  // The helper's catalog filter (grep/sed) on the real catalog: listed packages pass, others don't.
  const filter = (pkg) => {
    try {
      execFileSync('bash', ['-c', `grep -Eo '"apt"[[:space:]]*:[[:space:]]*"[a-z0-9][a-z0-9+.-]{1,62}"' "$1" | sed -E 's/.*"([^"]+)"$/\\1/' | grep -qxF -- "$2"`, '_', CATALOG, pkg]);
      return true;
    } catch {
      return false;
    }
  };
  check('helper filter: listed packages accepted', ['htop', 'fd-find', 'p7zip-full', 'openssh-server'].every(filter), true);
  check('helper filter: unlisted packages refused', ['sudo', 'bash', 'htop2', 'htop;id'].some(filter), false);
  // aggregator parsers
  check('parseCatalog: curated GUI apps carry their AppStream id', parsed.find((i) => i.id === 'gimp')?.appId, 'org.gimp.GIMP');
  check('parseCatalog: CLI tools have no AppStream id', parsed.find((i) => i.id === 'htop')?.appId, null);
  const sItem = parsers.sanitizeItem({ id: 'org.gimp.GIMP', appId: 'org.gimp.GIMP', name: 'GIMP', icon: 'javascript:alert(1)', categories: ['Graphics', 'Bogus'], desktopId: 'org.gimp.GIMP.desktop' }, 'flathub');
  check('sanitizeItem: appId kept as given (org.telegram.desktop is a real id)', [sItem?.appId, parsers.sanitizeItem({ id: 'org.telegram.desktop', appId: 'org.telegram.desktop', name: 'Telegram' }, 'flathub')?.appId], ['org.gimp.GIMP', 'org.telegram.desktop']);
  check('sanitizeItem: unsafe icon URL dropped, unknown categories dropped', [sItem?.icon, sItem?.categories], [null, ['Graphics']]);
  check('sanitizeItem: invalid flatpak id refused', parsers.sanitizeItem({ id: 'gimp;rm -rf', name: 'x' }, 'flathub'), null);
  const merged = parsers.mergeItems([
    parsers.sanitizeItem({ id: 'org.gnome.Chess', appId: 'org.gnome.Chess', name: 'Chess', summary: 'flat', icon: 'https://x/y.png', categories: ['Game'] }, 'flathub'),
    parsers.sanitizeItem({ id: 'gnome-chess', appId: 'org.gnome.Chess', name: 'Chess', summary: 'ubuntu', categories: ['Game'], installed: true, desktopId: 'org.gnome.Chess.desktop' }, 'ubuntu'),
    parsers.sanitizeItem({ id: 'geany', appId: 'org.geany.Geany', name: 'Geany', categories: ['Development'] }, 'ubuntu'),
  ]);
  const chess = merged.get('org.gnome.chess');
  check('mergeItems: one entry per AppStream id', merged.size, 2);
  check('mergeItems: sources ordered ubuntu > flathub, default ubuntu', [chess?.sources.map((x) => x.source), chess?.defaultSource], [['ubuntu', 'flathub'], 'ubuntu']);
  check('mergeItems: icon taken from any source, installed state kept', [chess?.icon, chess?.installed, chess?.installedSource, chess?.desktopId], ['https://x/y.png', true, 'ubuntu', 'org.gnome.Chess.desktop']);
  const ranked = parsers.rankEntries([{ key: 'b', name: 'Super Chess', sources: [1], icon: 'x' }, { key: 'a', name: 'Chessboard', sources: [1], icon: 'x' }, { key: 'c', name: 'Other', sources: [1, 2], icon: null }], 'chess');
  check('rankEntries: name prefix first, then name match, then others', ranked.map((e) => e.key), ['a', 'b', 'c']);
  check('featured list: the 13 well-known ids, Chromium right after Firefox', [parsers.FEATURED.length, parsers.FEATURED.slice(0, 2)], [13, ['org.mozilla.firefox', 'org.chromium.Chromium']]);
  const ui = await import(path.join(ROOT, 'renderer', 'apps', 'store', 'main.js'));
  check('parseStatus: dlstatus line', ui.parseStatus('dlstatus:1:33.3333:Retrieving file 1 of 3'), { phase: 'download', percent: 33.3333, pkg: '', message: 'Retrieving file 1 of 3' });
  check('formatSize: EN and FR units', [ui.formatSize(52428800, 'en'), ui.formatSize(1536, 'fr')], ['50 MB', '1,5 Ko']);
  const i18n = JSON.parse(fs.readFileSync(path.join(ROOT, 'renderer', 'apps', 'store', 'i18n.json'), 'utf8'));
  check('i18n: same keys in EN and FR', Object.keys(i18n.en).sort(), Object.keys(i18n.fr).sort());
}

// ------------------------------------------------------------------ English, light (stub sources)
const ENV = { AURORA_STORE_SOURCES_DIR: STUBS, AURORA_STORE_DEV_FAIL: 'btop', AURORA_STORE_STUB_OFFLINE: 'flathub' };
const keys = (page, sel = `${W} .st-card`) => page.locator(sel).evaluateAll((els) => els.map((e) => e.dataset.key));
const view = (page) => page.locator(`${W} .st-page`).getAttribute('data-view');
async function search(page, q) {
  await page.fill(`${W} .st-search-input`, q);
  await until(async () => (await view(page)) === 'search' && (await page.locator(`${W} .st-page-title`).innerText()).includes(q) && (await page.locator(`${W} .st-loading`).count()) === 0, { timeout: 8000 });
}
let s = await launchShell({ open: ['store'], lang: 'en', theme: 'light', env: ENV });
const errors = [];
s.page.on('pageerror', (e) => errors.push(e.message));
s.page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
try {
  const { page } = s;
  await page.waitForSelector(`${W} .st-card`, { timeout: 30000 });
  check('home: hero title', (await page.locator(`${W} .st-hero h1`).innerText()).trim(), 'Apps for Selene');
  check('home: no live note outside the live session', await page.locator(`${W} .st-live`).count(), 0);
  const featured = await keys(page, `${W} .st-section[data-row=featured] .st-card`);
  check('home: featured row in the fixed order, only apps a source has', featured.slice(0, 5), ['org.mozilla.firefox', 'org.chromium.chromium', 'org.gimp.gimp', 'org.videolan.vlc', 'org.libreoffice.libreoffice']);
  check('home: all 13 featured apps exist in the stubs', featured.length, 13);
  check('card: GIMP merged from three sources (three badges)', await page.locator(`${W} .st-section[data-row=featured] .st-card[data-key="org.gimp.gimp"] .st-badge`).allInnerTexts(), ['Selene', 'Ubuntu', 'Flathub']);
  check('card: Firefox is Flathub only', await page.locator(`${W} .st-section[data-row=featured] .st-card[data-key="org.mozilla.firefox"] .st-badge`).allInnerTexts(), ['Flathub']);
  check('card: real icon shown when a source has one', await page.locator(`${W} .st-section[data-row=featured] .st-card[data-key="org.mozilla.firefox"] img.st-icon`).count(), 1);
  check('home: per-category rows', await page.locator(`${W} .st-section[data-category]`).evaluateAll((els) => els.map((e) => e.dataset.category)), (v) => ['Game', 'Graphics', 'Office', 'Science'].every((c) => v.includes(c)));
  check('home: command-line tools row', await page.locator(`${W} .st-section[data-row=tools] .st-card`).count(), (n) => n > 0);
  check('nav: Home, Categories, Installed, Sources + categories', await page.locator(`${W} .st-nav-item`).evaluateAll((els) => els.map((e) => e.dataset.nav).slice(0, 4)), ['home', 'categories', 'installed', 'sources']);
  check('nav: installed count badge (5 simulated)', (await page.locator(`${W} [data-nav=installed] .st-count`).innerText()).trim(), '5');
  check('home: no null/undefined text', await page.locator(W).innerText(), (v) => !/\bundefined\b|\bnull\b|NaN/.test(v));
  await s.shot('store-home-en');
  fs.copyFileSync(path.join(ROOT, 'test', 'out', 'store-home-en.png'), path.join(DOCS, 'store-light-en.png'));

  // categories
  await page.click(`${W} [data-nav=categories]`);
  check('Categories page: one tile per category + tools', await page.locator(`${W} .st-cat-tile`).evaluateAll((els) => els.map((e) => e.dataset.category)), (v) => v.includes('Game') && v.includes('tools') && v.length >= 8);
  await page.click(`${W} .st-cat-tile[data-category=Game]`);
  await until(async () => (await page.locator(`${W} .st-results .st-card`).count()) > 0);
  check('category Games: merged entries', (await keys(page)).sort(), ['net.supertuxkart.supertuxkart', 'org.gnome.chess']);
  check('category: nav item selected', await page.locator(`${W} [data-nav="cat:Game"]`).getAttribute('aria-current'), 'page');
  // Load more (30 command-line tools, pages of 24)
  await page.click(`${W} [data-nav=categories]`);
  await page.click(`${W} .st-cat-tile[data-category=tools]`);
  await until(async () => (await page.locator(`${W} .st-results .st-card`).count()) > 0);
  check('tools: first page of 24', await page.locator(`${W} .st-results .st-card`).count(), 24);
  check('tools: Load more shows the count', (await page.locator(`${W} .st-more`).innerText()).trim(), 'Load more (24 of 30)');
  await page.locator(`${W} .st-more`).focus();
  await page.keyboard.press('Enter');
  await until(async () => (await page.locator(`${W} .st-results .st-card`).count()) === 30);
  check('Load more: next page appended', await page.locator(`${W} .st-results .st-card`).count(), 30);
  check('Load more: button gone at the end', await page.locator(`${W} .st-more`).count(), 0);
  check('Load more: focus moves to the first new card', await page.evaluate(() => [...document.querySelectorAll('.app-store .st-results .st-card')].indexOf(document.activeElement)), 24);

  // search merges an app present in two sources
  await page.keyboard.press('Control+f');
  check('Ctrl+F focuses search', await page.evaluate(() => document.activeElement?.classList.contains('st-search-input')), true);
  await search(page, 'chess');
  check('search "chess": one merged card', await keys(page), ['org.gnome.chess']);
  check('search: card shows Ubuntu + Flathub badges', await page.locator(`${W} .st-card[data-key="org.gnome.chess"] .st-badge`).allInnerTexts(), ['Ubuntu', 'Flathub']);
  await search(page, 'nvim');
  check('search finds curated tools by command', await keys(page), ['selene:neovim']);
  await search(page, 'zzzqqq');
  check('search: empty state', await page.locator(`${W} .st-empty`).innerText(), (v) => /No results/.test(v));
  await page.press(`${W} .st-search-input`, 'Escape');
  check('Escape clears search and leaves the results', [await page.locator(`${W} .st-search-input`).inputValue(), await view(page)], ['', 'tools']);

  // details + source picker + install from a non-default source (Flathub) with progress
  await search(page, 'chess');
  await page.click(`${W} .st-card[data-key="org.gnome.chess"]`);
  await page.waitForSelector(`${W} .st-detail-head .st-picker`, { timeout: 8000 });
  check('detail: title', (await page.locator(`${W} .st-detail-title h1`).innerText()).trim(), 'Chess');
  check('picker: two sources, Ubuntu selected by default', await page.locator(`${W} .st-src-opt`).evaluateAll((els) => els.map((e) => `${e.dataset.source}:${e.getAttribute('aria-checked')}`)), ['ubuntu:true', 'flathub:false']);
  check('detail: apt source says it needs admin + size', await page.locator(`${W} .st-hint`).innerText(), (v) => /Requires administrator permission/.test(v) && /50 MB to download/.test(v));
  check('detail: Install from Ubuntu', (await page.locator(`${W} .st-install`).innerText()).trim(), 'Install from Ubuntu');
  check('detail: description paragraphs', await page.locator(`${W} .st-desc`).count(), 2);
  check('detail: screenshots strip (https + data URLs)', await page.locator(`${W} .st-shots`).count(), 1);
  await page.locator(`${W} .st-src-opt[data-source=ubuntu]`).focus();
  await page.keyboard.press('ArrowRight');
  await until(async () => (await page.locator(`${W} .st-src-opt[data-source=flathub]`).getAttribute('aria-checked')) === 'true');
  check('picker: arrow keys choose Flathub', await page.locator(`${W} .st-src-opt[data-source=flathub]`).getAttribute('aria-checked'), 'true');
  check('picker: focus follows', await page.evaluate(() => document.activeElement?.dataset?.source), 'flathub');
  check('detail (Flathub): per-user hint', await page.locator(`${W} .st-hint`).innerText(), (v) => /no administrator permission/.test(v));
  check('detail (Flathub): App ID in the information', await page.locator(`${W} .st-info`).innerText(), (v) => /App ID\s+org\.gnome\.Chess/.test(v) && /GPL-3\.0/.test(v));
  await page.click(`${W} .st-install`);
  check('install (Flathub): no UAC prompt', await page.locator('.uac-dialog').count(), 0);
  const sawProgress = await until(async () => (await page.locator(`${W} .st-actions .st-progress`).count()) > 0, { timeout: 5000, every: 30 });
  check('install: progress bar shown', !!sawProgress, true);
  const pct = await until(async () => Number((await page.locator(`${W} .st-actions .st-progress`).getAttribute('aria-valuenow').catch(() => '0')) || 0) || 0, { timeout: 5000, every: 30 });
  check('install: progress advances', pct, (v) => v > 0);
  check('install: picker locked while busy', await page.locator(`${W} .st-src-opt[disabled]`).count(), 2);
  await page.waitForSelector(`${W} .st-detail-head .st-open`, { timeout: 20000 });
  check('install: Installed chip', await page.locator(`${W} .st-detail-head .st-chip.ok`).count(), 1);
  check('install: picker marks the installed source', await page.locator(`${W} .st-src-opt[data-source=flathub] .st-src-inst`).count(), 1);
  check('install: badge now 6', (await page.locator(`${W} [data-nav=installed] .st-count`).innerText()).trim(), '6');
  check('install: notification', await page.evaluate(() => window.__aurora.notifications.list().some((n) => /Chess is installed/.test(n.title))), true);
  // Open launches the Linux app through the registry
  await page.evaluate(() => {
    const reg = window.__aurora.shell.registry;
    window.__storeLaunches = [];
    reg.__get = reg.get;
    reg.__launch = reg.launch;
    reg.get = (id) => (String(id).startsWith('linux.org.gnome.Chess') ? { id } : reg.__get(id));
    reg.launch = (id, args) => (window.__storeLaunches.push({ id, args }), String(id).startsWith('linux.') || id === 'terminal' ? null : reg.__launch(id, args));
  });
  await page.click(`${W} .st-detail-head .st-open`);
  check('Open: launches linux.<desktop id>', await page.evaluate(() => window.__storeLaunches.map((l) => l.id)), ['linux.org.gnome.Chess']);

  // keyboard back + focus
  await page.locator(`${W} .st-back`).focus();
  await page.keyboard.press('Alt+ArrowLeft');
  check('Alt+Left: back to the results', await view(page), 'search');
  check('back: focus returns to the card that was open', await page.evaluate(() => document.activeElement?.dataset?.key || ''), 'org.gnome.chess');
  await page.keyboard.press('Enter');
  await page.waitForSelector(`${W} .st-detail-head`);
  check('Enter on a card opens its page', (await page.locator(`${W} .st-detail-title h1`).innerText().catch(() => '')).trim(), 'Chess');

  // curated CLI tool through the UAC prompt (cancel, then install with progress)
  await search(page, 'ncdu');
  await page.click(`${W} .st-card[data-key="selene:ncdu"]`);
  await page.waitForSelector(`${W} .st-install`);
  check('selene detail: single source, how-to command', [(await page.locator(`${W} .st-single-src`).innerText()).trim(), (await page.locator(`${W} .st-cmd`).innerText()).trim()], ['From Selene', 'ncdu']);
  await page.click(`${W} .st-install`);
  await page.waitForSelector('.uac-dialog', { timeout: 10000 });
  check('UAC: reason names the package', await page.locator('.uac-dialog').innerText(), (v) => /install ncdu \(ncdu\)/.test(v));
  await page.keyboard.press('Escape');
  await page.waitForSelector('.uac-dialog', { state: 'detached', timeout: 8000 }).catch(() => {});
  await until(async () => (await page.locator(`${W} .st-install`).count()) === 1);
  check('cancel: Install button back, no error', (await page.locator(`${W} .st-install`).count()) === 1 && (await page.locator(`${W} .st-error`).count()) === 0, true);
  await page.click(`${W} .st-install`);
  await uac(s);
  check('apt install: progress bar', !!(await until(async () => (await page.locator(`${W} .st-actions .st-progress`).count()) > 0, { timeout: 5000, every: 30 })), true);
  await page.waitForSelector(`${W} .st-detail-head .st-open`, { timeout: 20000 });
  await page.click(`${W} .st-detail-head .st-open`);
  check('Open in Terminal: runs ncdu', await page.evaluate(() => window.__storeLaunches.at(-1)), { id: 'terminal', args: { command: 'ncdu' } });

  // failure (simulated for btop)
  await search(page, 'btop');
  await page.click(`${W} .st-card[data-key="selene:btop"]`);
  await page.click(`${W} .st-install`);
  await uac(s);
  await page.waitForSelector(`${W} .st-error`, { timeout: 15000 }).catch(() => {});
  check('failure: error infobar', await page.locator(`${W} .st-error`).innerText().catch(() => ''), (v) => /could not install btop/.test(v));
  check('failure: Install offered again', await page.locator(`${W} .st-install`).count(), 1);

  // Installed page across sources
  await page.click(`${W} [data-nav=installed]`);
  await until(async () => (await page.locator(`${W} .st-row`).count()) > 0);
  check('Installed: rows from every source', (await keys(page, `${W} .st-row`)).sort(), ['org.gnome.chess', 'selene:curl', 'selene:git', 'selene:ncdu', 'selene:rsync', 'selene:unzip', 'selene:wget']);
  check('Installed: source badge on the row', (await page.locator(`${W} .st-row[data-key="org.gnome.chess"] .st-badge`).innerText()).trim(), 'Flathub');
  check('Installed: shipped tools say so', (await page.locator(`${W} .st-row[data-key="selene:git"] .st-builtin`).innerText().catch(() => '')).trim(), 'Included with Selene OS');
  await page.click(`${W} .st-row[data-key="org.gnome.chess"] .st-remove`);
  check('remove (Flathub): no UAC prompt', await page.locator('.uac-dialog').count(), 0);
  await until(async () => (await page.locator(`${W} .st-row[data-key="org.gnome.chess"]`).count()) === 0, { timeout: 15000 });
  check('remove: row gone', await page.locator(`${W} .st-row[data-key="org.gnome.chess"]`).count(), 0);
  check('remove: badge back to 6', (await page.locator(`${W} [data-nav=installed] .st-count`).innerText()).trim(), '6');

  // Sources page: status, refresh, no-network error, Flathub on/off
  await page.click(`${W} [data-nav=sources]`);
  await page.waitForSelector(`${W} .st-src`);
  check('Sources: three sources', await page.locator(`${W} .st-src`).evaluateAll((els) => els.map((e) => e.dataset.source)), ['selene', 'ubuntu', 'flathub']);
  check('Sources: Ubuntu ready with its count', (await page.locator(`${W} .st-src[data-source=ubuntu] .st-src-state`).innerText()).trim(), 'Ready · 10 apps');
  check('Sources: only Flathub can be turned off', [await page.locator(`${W} .st-src[data-source=selene] input`).count(), await page.locator(`${W} .st-src[data-source=flathub] .st-src-toggle input`).count()], [0, 1]);
  const before = await page.locator(`${W} .st-src[data-source=ubuntu] .st-src-updated`).innerText();
  await page.click(`${W} .st-src[data-source=ubuntu] .st-refresh`);
  await until(async () => (await page.locator(`${W} .st-src[data-source=ubuntu] .st-refresh[disabled]`).count()) === 0 && (await page.locator(`${W} .st-src[data-source=ubuntu] .st-src-updated`).innerText()) !== before, { timeout: 8000 });
  check('Refresh: last refresh updated, no error', [(await page.locator(`${W} .st-src[data-source=ubuntu] .st-src-updated`).innerText()) !== before, await page.locator(`${W} .st-src[data-source=ubuntu] .st-error`).count()], [true, 0]);
  await page.click(`${W} .st-src[data-source=flathub] .st-refresh`);
  await page.waitForSelector(`${W} .st-src[data-source=flathub] .st-error`, { timeout: 8000 }).catch(() => {});
  check('Refresh offline: clear no-network error', await page.locator(`${W} .st-src[data-source=flathub] .st-error`).innerText().catch(() => ''), (v) => /No network connection/.test(v));
  await page.click(`${W} .st-src[data-source=flathub] .st-src-toggle input`);
  await until(async () => /Turned off/.test(await page.locator(`${W} .st-src[data-source=flathub] .st-src-state`).innerText()));
  check('Flathub off: state', (await page.locator(`${W} .st-src[data-source=flathub] .st-src-state`).innerText()).trim(), 'Turned off');
  await search(page, 'firefox');
  check('Flathub off: its apps are hidden', await page.locator(`${W} .st-empty`).count(), 1);
  await page.press(`${W} .st-search-input`, 'Escape');
  await page.click(`${W} [data-nav=sources]`);
  await page.click(`${W} .st-src[data-source=flathub] .st-src-toggle input`);
  await until(async () => !/Turned off/.test(await page.locator(`${W} .st-src[data-source=flathub] .st-src-state`).innerText()));
  await search(page, 'firefox');
  check('Flathub on again: Firefox back', await keys(page), ['org.mozilla.firefox']);
  await page.press(`${W} .st-search-input`, 'Escape');

  // backend validation
  const inv = (...a) => page.evaluate((a) => window.__aurora.api.invoke(...a).then((r) => r, (e) => ({ code: e.code })), a);
  check('backend: invalid flatpak id refused', (await inv('store:install', 'flathub', 'bad id; rm')).code, 'EINVAL');
  check('backend: apt sources only through the UAC prompt', (await inv('store:install', 'ubuntu', 'geany')).code, 'EADMIN');
  check('backend: pages capped at 60', (await inv('store:search', { query: '', category: '', limit: 1000 })).items?.length, (n) => n > 0 && n <= 60);
  check('backend: unlisted apt package still refused by the dev helper', (await inv('admin:run', 'pw', 'store-install', ['sudo'])).code, 'EPERM');

  // narrow window: compact navigation, no horizontal overflow
  await page.evaluate(() => window.__aurora.wm.byApp('store')[0].setSize(560, 520));
  await sleep(400);
  await page.click(`${W} [data-nav=home]`);
  check('narrow: nav labels hidden', await page.locator(`${W} [data-nav=home] .st-nav-label`).isVisible(), false);
  check('narrow: no horizontal overflow', await page.locator(`${W} .st-content`).evaluate((el) => el.scrollWidth <= el.clientWidth + 1), true);
} catch (e) {
  failures.push(`EN run crashed: ${e.stack || e.message}`);
} finally {
  check('EN: no console errors', errors.filter((e) => !/favicon|ResizeObserver|ERR_NAME_NOT_RESOLVED|example\.invalid|net::/.test(e)), []);
  await s.close();
}

// ------------------------------------------------------------------ French, dark, live session
s = await launchShell({ lang: 'fr', theme: 'dark', live: true, env: { AURORA_STORE_SOURCES_DIR: STUBS } });
try {
  const { page } = s;
  await page.evaluate(() => window.__aurora.registry.launch('store', { id: 'org.gimp.GIMP' }));
  await page.waitForSelector(`${W} .st-detail-head .st-picker`, { timeout: 30000 });
  check('FR: launch args open the detail page', (await page.locator(`${W} .st-detail-title h1`).innerText()).trim(), 'GIMP');
  check('FR: three sources, Selene by default', await page.locator(`${W} .st-src-opt`).evaluateAll((els) => els.map((e) => `${e.dataset.source}:${e.getAttribute('aria-checked')}`)), ['selene:true', 'ubuntu:false', 'flathub:false']);
  check('FR: French description', await page.locator(`${W} .st-desc`).first().innerText(), (v) => /retouche|image/i.test(v));
  check('FR: Install button', (await page.locator(`${W} .st-install`).innerText()).trim(), 'Installer depuis Selene');
  check('FR: admin hint', await page.locator(`${W} .st-hint`).innerText(), (v) => /Nécessite l'autorisation d'un administrateur/.test(v));
  check('FR: dark theme', await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
  await page.click(`${W} .st-src-opt[data-source=flathub]`);
  await until(async () => (await page.locator(`${W} .st-src-opt[data-source=flathub]`).getAttribute('aria-checked')) === 'true');
  check('FR live: Flathub detail warns about the live session', await page.locator(`${W} .st-live`).innerText().catch(() => ''), (v) => /Session live/.test(v) && /perdues au redémarrage/.test(v));
  await page.click(`${W} .st-src-opt[data-source=selene]`);
  await until(async () => (await page.locator(`${W} .st-src-opt[data-source=selene]`).getAttribute('aria-checked')) === 'true');
  await sleep(300);
  await s.shot('store-dark-fr');
  fs.copyFileSync(path.join(ROOT, 'test', 'out', 'store-dark-fr.png'), path.join(DOCS, 'store-dark-fr.png'));
  await page.click(`${W} .st-back`).catch(() => {});
  await page.click(`${W} [data-nav=home]`);
  await page.waitForSelector(`${W} .st-section[data-row=featured]`);
  check('FR: home live note', await page.locator(`${W} .st-live`).innerText(), (v) => /Session live/.test(v));
  check('FR: nav in French', await page.locator(`${W} .st-nav`).innerText(), (v) => /Accueil/.test(v) && /Installés/.test(v) && /Catégories/.test(v) && /Jeux/.test(v));
  check('FR: featured row title', (await page.locator(`${W} .st-section[data-row=featured] h2`).innerText()).trim(), 'À la une');
  check('FR: localised summary from a source', await page.locator(`${W} .st-section[data-row=featured] .st-card[data-key="org.mozilla.firefox"] .st-card-desc`).innerText(), 'Navigateur web rapide, privé et sûr');
  check('FR: no English leftovers', await page.locator(W).innerText(), (v) => !/\b(Home|Installed|See all|Featured|Load more|Requires|Install from|Command-line)\b/.test(v) && !/\bundefined\b|\bnull\b|NaN/.test(v));
  const fg = await page.locator(`${W} .st-card-name`).first().evaluate((el) => getComputedStyle(el).color);
  check('FR dark: card text is light', fg, (v) => {
    const m = v.match(/\d+/g).map(Number);
    return m[0] > 180 && m[1] > 180 && m[2] > 180;
  });
  await page.click(`${W} [data-nav=sources]`);
  await page.waitForSelector(`${W} .st-src`);
  check('FR: Sources page in French', await page.locator(`${W} .st-page`).innerText(), (v) => /Archive Ubuntu/.test(v) && /Dernière actualisation/.test(v) && /Actualiser/.test(v) && /Prêt · 16 applications/.test(v));
} catch (e) {
  failures.push(`FR run crashed: ${e.stack || e.message}`);
} finally {
  await s.close();
}

// ------------------------------------------------------------------ the real source modules (their own dev fixtures)
if (REAL_SOURCES) {
  s = await launchShell({ open: ['store'], lang: 'en', theme: 'light' });
  const errs = [];
  s.page.on('pageerror', (e) => errs.push(e.message));
  s.page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
  try {
    const { page } = s;
    await page.waitForSelector(`${W} .st-card`, { timeout: 30000 });
    const st = await page.evaluate(() => window.__aurora.api.invoke('store:sources'));
    check('real modules: ubuntu + flathub loaded', st.sources.filter((x) => !x.missing).map((x) => x.id), ['selene', 'ubuntu', 'flathub']);
    await until(async () => (await page.evaluate(() => window.__aurora.api.invoke('store:sources'))).sources.every((x) => x.ready || !x.enabled), { timeout: 30000, every: 500 });
    const r = await page.evaluate(() => window.__aurora.api.invoke('store:search', { query: '', limit: 60 }));
    check('real modules: merged catalogue has apps from both sources', [r.total > 40, r.items.some((e) => e.sources.some((x) => x.source === 'flathub')), r.items.some((e) => e.sources.some((x) => x.source === 'ubuntu'))], [true, true, true]);
    await page.click(`${W} [data-nav=home]`);
    await page.waitForSelector(`${W} .st-section[data-row=featured] .st-card`, { timeout: 15000 });
    check('real modules: featured row', await page.locator(`${W} .st-section[data-row=featured] .st-card`).count(), (n) => n >= 3);
    await page.locator(`${W} .st-section[data-row=featured] .st-card`).first().click();
    await page.waitForSelector(`${W} .st-detail-head .st-actions .btn`, { timeout: 15000 });
    check('real modules: details open with an action', await page.locator(`${W} .st-detail-head .st-actions .btn`).count(), (n) => n >= 1);
    check('real modules: no null/undefined text', await page.locator(W).innerText(), (v) => !/\bundefined\b|\bnull\b|NaN/.test(v));
    // an Ubuntu-only app installs through the UAC prompt (admin.js simulation) and shows up as installed
    const ub = (await page.evaluate(() => window.__aurora.api.invoke('store:search', { source: 'ubuntu', limit: 60 }))).items.find((e) => e.sources.length === 1 && !e.installed);
    if (check('real modules: an Ubuntu-only app exists', !!ub, true)) {
      await page.evaluate((id) => window.__aurora.registry.launch('store', { id }), ub.key);
      await page.waitForSelector(`${W} .st-detail-head .st-install`, { timeout: 15000 });
      check('real modules (Ubuntu): Install from Ubuntu', (await page.locator(`${W} .st-install`).innerText()).trim(), 'Install from Ubuntu');
      await page.click(`${W} .st-install`);
      await uac(s);
      await page.waitForSelector(`${W} .st-detail-head .st-chip.ok`, { timeout: 20000 }).catch(() => {});
      check('real modules (Ubuntu): installed through the admin path', [await page.locator(`${W} .st-detail-head .st-chip.ok`).count(), await page.locator(`${W} .st-error`).count()], [1, 0]);
    }
  } catch (e) {
    failures.push(`real-modules run crashed: ${e.stack || e.message}`);
  } finally {
    check('real modules: no console errors', errs.filter((e) => !/favicon|ResizeObserver|net::|ERR_/.test(e)), []);
    await s.close();
  }
} else console.log('(real source modules not found: their run is skipped)');

// ------------------------------------------------------------------ « Annuler » a Flathub install (French, 1280x720, dark + light)
// The real flathub module on its dev fixtures, slowed down (AURORA_STORE_DEV_DELAY) so the install can be cancelled.
//   Screenshots: test/out/store-cancel-fr-{dark,light}.png (in progress), store-canceled-fr-{dark,light}.png (after)
if (REAL_SOURCES) {
  for (const theme of ['dark', 'light']) {
    s = await launchShell({ lang: 'fr', theme, size: '1280x720', env: { AURORA_STORE_DEV_DELAY: theme === 'dark' ? '1500' : '700' } });
    const errs = [];
    s.page.on('pageerror', (e) => errs.push(e.message));
    s.page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
    try {
      const { page } = s;
      const inv = (...a) => page.evaluate((a) => window.__aurora.api.invoke(...a).then((r) => r, (e) => ({ code: e.code })), a);
      await page.evaluate(() => window.__aurora.registry.launch('store', { id: 'org.mozilla.firefox' }));
      await page.waitForSelector(`${W} .st-detail-head .st-install`, { timeout: 30000 });
      await page.evaluate(() => window.__aurora.wm.byApp('store')[0].maximize?.());
      if (await page.locator(`${W} .st-src-opt[data-source=flathub]`).count()) await page.click(`${W} .st-src-opt[data-source=flathub]`);
      await until(async () => /Flathub/.test(await page.locator(`${W} .st-install`).innerText()));
      await page.click(`${W} .st-install`);
      await page.waitForSelector(`${W} .st-actions .st-cancel`, { timeout: 8000 });
      await until(async () => Number(await page.locator(`${W} .st-actions .st-progress`).getAttribute('aria-valuenow')) >= 20, { timeout: 8000, every: 50 });
      check(`cancel ${theme}: « Annuler » next to the progress`, [(await page.locator(`${W} .st-cancel`).innerText()).trim(), await page.locator(`${W} .st-cancel`).getAttribute('aria-label')], ['Annuler', "Annuler l'installation de Firefox"]);
      check(`cancel ${theme}: backend reports the cancelable operation`, (await inv('store:current')).op, (o) => o && o.id === 'org.mozilla.firefox' && o.cancelable === true && o.canceling === false);
      await s.shot(`store-cancel-fr-${theme}`);
      await page.click(`${W} .st-cancel`);
      check(`cancel ${theme}: button disabled, « Annulation en cours… »`, [await page.locator(`${W} .st-cancel`).isDisabled().catch(() => null), await page.locator(`${W} .st-step`).innerText().catch(() => '')], [true, 'Annulation en cours…']);
      await page.waitForSelector(`${W} .st-canceled`, { timeout: 10000 });
      check(`cancel ${theme}: calm notice, no error`, [await page.locator(`${W} .st-canceled`).innerText(), await page.locator(`${W} .st-error`).count()], (v) => /L'installation de Firefox a été annulée\. Rien n'a été modifié\./.test(v[0]) && v[1] === 0);
      check(`cancel ${theme}: Install offered again, not installed`, [await page.locator(`${W} .st-install`).count(), await page.locator(`${W} .st-detail-head .st-chip.ok`).count(), (await inv('store:installedAll')).items.some((e) => e.key === 'org.mozilla.firefox')], [1, 0, false]);
      check(`cancel ${theme}: state cleared (window + backend)`, [await page.evaluate(() => window.__aurora.registry.instance(window.__aurora.wm.byApp('store')[0].id).hooks.state.op), (await inv('store:current')).op], [null, null]);
      check(`cancel ${theme}: no « Installation… » chip left on the home cards`, await page.evaluate(() => document.querySelectorAll('.app-store .st-chip.busy').length), 0);
      await s.shot(`store-canceled-fr-${theme}`);
      if (theme === 'dark') {
        // nothing left behind: the same app installs right away
        await page.click(`${W} .st-install`);
        await page.waitForSelector(`${W} .st-detail-head .st-open`, { timeout: 20000 });
        check('cancel: installing again works, the notice is gone', [await page.locator(`${W} .st-detail-head .st-chip.ok`).count(), await page.locator(`${W} .st-canceled`).count()], [1, 0]);
        check('cancel: store:cancel with nothing running', await inv('store:cancel', 'flathub', 'org.mozilla.firefox'), { canceled: false });
        // an install started while the Logithèque was closed shows up with « Annuler » when it opens
        // an install started elsewhere (first sign-in gaming setup) shows up with « Annuler » in the open window…
        await page.evaluate(() => window.__aurora.registry.launch('store', { id: 'com.spotify.Client' }));
        await page.waitForSelector(`${W} .st-detail-head .st-install`, { timeout: 15000 });
        await page.evaluate(() => {
          window.__bg = undefined;
          window.__aurora.api.invoke('store:install', 'flathub', 'com.spotify.Client').then(() => (window.__bg = 'ok'), (e) => (window.__bg = e.code));
        });
        await page.waitForSelector(`${W} .st-actions .st-cancel`, { timeout: 8000 });
        check('adopted (open window): progress + « Annuler » for the running install', await page.locator(`${W} .st-actions .st-progress`).count(), 1);
        await page.click(`${W} .st-cancel`);
        check('adopted (open window): cancel stops it', await until(() => page.evaluate(() => window.__bg), { timeout: 10000 }), 'ECANCELED');
        await page.waitForSelector(`${W} .st-canceled`, { timeout: 10000 }).catch(() => {});
        check('adopted (open window): notice + Install offered again', [await page.locator(`${W} .st-canceled`).count(), await page.locator(`${W} .st-install`).count()], [1, 1]);
        // …and in a window opened while it runs (store:current)
        await page.evaluate(() => window.__aurora.wm.byApp('store')[0].close());
        await until(async () => (await page.evaluate(() => window.__aurora.wm.byApp('store').length)) === 0);
        await page.evaluate(() => {
          window.__bg = undefined;
          window.__aurora.api.invoke('store:install', 'flathub', 'org.inkscape.Inkscape').then(() => (window.__bg = 'ok'), (e) => (window.__bg = e.code));
        });
        await page.evaluate(() => window.__aurora.registry.launch('store', { id: 'org.inkscape.Inkscape' }));
        const adopted = await page.waitForSelector(`${W} .st-actions .st-cancel`, { timeout: 15000 }).then(() => true, async () => `bg=${await page.evaluate(() => window.__bg)}`);
        if (check('adopted (new window): « Annuler » shown', adopted, true)) {
          await page.click(`${W} .st-cancel`);
          check('adopted (new window): cancel stops it', await until(() => page.evaluate(() => window.__bg), { timeout: 10000 }), 'ECANCELED');
        }
      }
    } catch (e) {
      failures.push(`cancel ${theme} run crashed: ${e.stack || e.message}`);
    } finally {
      check(`cancel ${theme}: no console errors`, errs.filter((e) => !/favicon|ResizeObserver|net::|ERR_/.test(e)), []);
      await s.close();
    }
  }
}

// ------------------------------------------------------------------ « Mises à jour » (French, 1280x720, dark + light)
// The real flathub module on its dev fixtures with three installed apps that have an update (AURORA_STORE_DEV_UPDATES);
// the session-start check runs at once (AURORA_STORE_UPDATES_DELAY_MS=0). Badge, list, « Mettre à jour » with progress,
// « Tout mettre à jour » + « Annuler », calm empty state; an install whose clean-up is not confirmed gets an honest notice.
//   Screenshots: test/out/store-updates-fr-{dark,light}.png, store-updates-progress-fr-dark.png, store-updates-empty-fr-{dark,light}.png
if (REAL_SOURCES) {
  for (const theme of ['dark', 'light']) {
    s = await launchShell({ lang: 'fr', theme, size: '1280x720', env: { AURORA_STORE_DEV_UPDATES: 'org.gimp.GIMP:2.10.36,com.spotify.Client:1.2.40,org.inkscape.Inkscape:1.3.2', AURORA_STORE_UPDATES_DELAY_MS: '0', AURORA_STORE_DEV_DELAY: '500', AURORA_STORE_DEV_ROLLBACK_FAIL: 'org.mozilla.firefox' } });
    const errs = [];
    s.page.on('pageerror', (e) => errs.push(e.message));
    s.page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
    try {
      const { page } = s;
      const inv = (...a) => page.evaluate((a) => window.__aurora.api.invoke(...a).then((r) => r, (e) => ({ code: e.code })), a);
      check(`updates ${theme}: checked at session start (no window open)`, await until(async () => (await inv('store:updates')).checkedAt && (await inv('store:updates')).count === 3, { timeout: 15000 }), true);
      await page.evaluate(() => window.__aurora.registry.launch('store', { view: 'updates' }));
      await page.waitForSelector(`${W} .st-upd-row`, { timeout: 30000 });
      await page.evaluate(() => window.__aurora.wm.byApp('store')[0].maximize?.());
      await sleep(400);
      check(`updates ${theme}: nav entry « Mises à jour » with a badge of 3`, [(await page.locator(`${W} [data-nav=updates] .st-nav-label`).innerText()).trim(), (await page.locator(`${W} [data-nav=updates] .st-upd-count`).innerText()).trim(), await page.locator(`${W} [data-nav=updates] .st-upd-count`).getAttribute('aria-label')], ['Mises à jour', '3', '3 mises à jour disponibles']);
      check(`updates ${theme}: three rows, names and versions`, await page.locator(`${W} .st-upd-row .st-row-name`).allInnerTexts(), (n) => n.length === 3 && n.some((x) => /GNU|GIMP|Programme/.test(x)) && n.includes('Spotify') && n.includes('Inkscape'));
      check(`updates ${theme}: GIMP version 2.10.36 → 2.10.38 + size`, await page.locator(`${W} .st-upd-row[data-id="org.gimp.GIMP"] .st-upd-ver`).innerText(), (v) => /2\.10\.36 → 2\.10\.38 · \d/.test(v));
      check(`updates ${theme}: « Tout mettre à jour » + « Rechercher »`, [(await page.locator(`${W} .st-update-all`).innerText()).trim(), (await page.locator(`${W} .st-check`).innerText()).trim()], ['Tout mettre à jour', 'Rechercher']);
      await s.shot(`store-updates-fr-${theme}`);
      if (theme === 'dark') {
        // one app, with progress and « Annuler »
        await page.click(`${W} .st-upd-row[data-id="org.inkscape.Inkscape"] .st-update`);
        await page.waitForSelector(`${W} .st-upd-row[data-id="org.inkscape.Inkscape"] .st-cancel`, { timeout: 8000 });
        await until(async () => Number(await page.locator(`${W} .st-upd-row .st-progress`).getAttribute('aria-valuenow')) >= 20, { timeout: 8000, every: 50 });
        check('update one: progress + « Annuler » in its row, other buttons disabled', [await page.locator(`${W} .st-upd-row[data-id="org.inkscape.Inkscape"] .st-progress`).count(), await page.locator(`${W} .st-upd-row[data-id="org.gimp.GIMP"] .st-update`).isDisabled(), await page.locator(`${W} .st-update-all`).isDisabled()], [1, true, true]);
        await s.shot('store-updates-progress-fr-dark');
        await page.click(`${W} .st-upd-row[data-id="org.inkscape.Inkscape"] .st-cancel`);
        await page.waitForSelector(`${W} .st-upd-row[data-id="org.inkscape.Inkscape"] .st-canceled`, { timeout: 10000 });
        check('update one: cancelled calmly, version unchanged, still listed', [await page.locator(`${W} .st-upd-row[data-id="org.inkscape.Inkscape"] .st-canceled`).innerText(), (await inv('store:updates')).count], (v) => /La mise à jour de Inkscape a été annulée\. La version installée reste inchangée\./.test(v[0]) && v[1] === 3);
        await page.click(`${W} .st-upd-row[data-id="org.inkscape.Inkscape"] .st-update`);
        await until(async () => (await inv('store:updates')).count === 2, { timeout: 15000 });
        await until(async () => (await page.locator(`${W} [data-nav=updates] .st-upd-count`).innerText().catch(() => '')).trim() === '2');
        check('update one: done, badge 2, row gone', [(await page.locator(`${W} [data-nav=updates] .st-upd-count`).innerText()).trim(), await page.locator(`${W} .st-upd-row[data-id="org.inkscape.Inkscape"]`).count()], ['2', 0]);
        // « Tout mettre à jour », then « Annuler » on the first app stops the batch
        await page.click(`${W} .st-update-all`);
        await page.waitForSelector(`${W} .st-batch`, { timeout: 8000 });
        check('update all: « Mise à jour de l\'application 1 sur 2… »', (await page.locator(`${W} .st-batch`).innerText()).trim(), "Mise à jour de l'application 1 sur 2…");
        await page.waitForSelector(`${W} .st-upd-row .st-cancel`, { timeout: 8000 });
        await page.click(`${W} .st-upd-row .st-cancel`);
        await until(async () => !(await page.evaluate(() => window.__aurora.registry.instance(window.__aurora.wm.byApp('store')[0].id).hooks.state.batch)), { timeout: 10000 });
        check('update all + Annuler: batch stopped, both still listed', (await inv('store:updates')).count, 2);
        // « Tout mettre à jour » to the end -> calm empty state
        await page.click(`${W} .st-update-all`);
        await page.waitForSelector(`${W} .st-upd-empty`, { timeout: 20000 });
        check('update all: « Vos applications sont à jour », no badge', [(await page.locator(`${W} .st-upd-empty .subtitle`).innerText()).trim(), await page.locator(`${W} [data-nav=updates] .st-upd-count`).count(), (await inv('store:updates')).count], ['Vos applications sont à jour', 0, 0]);
        await s.shot('store-updates-empty-fr-dark');
        // « Rechercher » again: still up to date
        await page.click(`${W} .st-check`);
        await until(async () => !(await inv('store:updates')).checking && (await page.locator(`${W} .st-check`).innerText()).trim() === 'Rechercher');
        check('check: still up to date after « Rechercher »', await page.locator(`${W} .st-upd-empty`).count(), 1);
        // honest notice when the rollback of a cancelled install is not complete
        await page.evaluate(() => window.__aurora.registry.launch('store', { id: 'org.mozilla.firefox' }));
        await page.waitForSelector(`${W} .st-detail-head .st-install`, { timeout: 15000 });
        if (await page.locator(`${W} .st-src-opt[data-source=flathub]`).count()) await page.click(`${W} .st-src-opt[data-source=flathub]`);
        await page.click(`${W} .st-install`);
        await page.waitForSelector(`${W} .st-actions .st-cancel`, { timeout: 8000 });
        await page.click(`${W} .st-cancel`);
        await page.waitForSelector(`${W} .st-canceled`, { timeout: 10000 });
        const note = await page.locator(`${W} .st-canceled`).innerText();
        check('partial cancel: no « Rien n\'a été modifié », says what is left', [/Rien n'a été modifié/.test(note), /n'a pas pu être retirée/.test(note), (await inv('store:lastCancel', 'flathub', 'org.mozilla.firefox')).partial], [false, true, true]);
        await s.shot('store-canceled-partial-fr-dark');
      } else {
        await page.click(`${W} .st-update-all`);
        await page.waitForSelector(`${W} .st-upd-empty`, { timeout: 30000 });
        await sleep(300);
        await s.shot('store-updates-empty-fr-light');
        check('light: empty state after « Tout mettre à jour »', (await page.locator(`${W} .st-upd-empty .subtitle`).innerText()).trim(), 'Vos applications sont à jour');
      }
    } catch (e) {
      failures.push(`updates ${theme} run crashed: ${e.stack || e.message}`);
    } finally {
      check(`updates ${theme}: no console errors`, errs.filter((e) => !/favicon|ResizeObserver|net::|ERR_/.test(e)), []);
      await s.close();
    }
  }
}

console.log(`\n${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL ${f}`);
process.exit(failures.length ? 1 : 0);
