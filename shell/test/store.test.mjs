// Store tests — catalog JSON, backend parsers, admin action validation, helper syntax, and the real Electron shell
// (dev mode, simulated apt): home / categories / search / detail / Installed views, install + remove through the UAC
// prompt with progress, cancel, failure, Open in Terminal, keyboard, French + dark theme, narrow window, console errors.
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
  const icons = require(path.join(ROOT, 'renderer', 'assets', 'icons', 'fluent.json'));
  check('catalog: every icon is a Fluent icon', items.filter((i) => !icons[i.icon]).map((i) => i.id), []);
  check('catalog: no graphical (X11) apps', items.some((i) => /^(firefox|gimp|vlc|libreoffice|thunderbird)/.test(i.apt)), false);
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
}

// ------------------------------------------------------------------ English, light
let s = await launchShell({ open: ['store'], lang: 'en', theme: 'light', env: { AURORA_STORE_DEV_FAIL: 'btop' } });
const errors = [];
s.page.on('pageerror', (e) => errors.push(e.message));
s.page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
try {
  const { page } = s;
  await page.waitForSelector(`${W} .st-card`, { timeout: 30000 });
  check('home: hero title', (await page.locator(`${W} .st-hero h1`).innerText()).trim(), 'Tools for your Terminal');
  check('home: says graphical apps come later', await page.locator(`${W} .st-notice`).innerText(), (v) => /Graphical apps are coming later/.test(v));
  check('home: one section per category', await page.locator(`${W} .st-section[data-category]`).count(), 7);
  check('nav: home + installed + 7 categories', await page.locator(`${W} .st-nav-item`).count(), 9);
  check('nav: installed count badge (5 simulated)', (await page.locator(`${W} [data-nav=installed] .st-count`).innerText()).trim(), '5');
  check('card: git shows Installed', await page.locator(`${W} .st-card[data-id=git] .st-chip`).innerText(), (v) => /Installed/.test(v));
  check('card: htop shows Free', (await page.locator(`${W} .st-card[data-id=htop] .st-chip`).innerText()).trim(), 'Free');
  check('home: no null/undefined text', await page.locator(W).innerText(), (v) => !/\bundefined\b|\bnull\b/.test(v));
  await s.shot('store-home-en');
  fs.copyFileSync(path.join(ROOT, 'test', 'out', 'store-home-en.png'), path.join(DOCS, 'store-light-en.png'));

  // categories
  await page.click(`${W} [data-nav="cat:multimedia"]`);
  check('category: Multimedia lists ffmpeg + imagemagick', await page.locator(`${W} .st-card`).evaluateAll((els) => els.map((e) => e.dataset.id).sort()), ['ffmpeg', 'imagemagick']);
  check('category: nav item selected', await page.locator(`${W} [data-nav="cat:multimedia"]`).getAttribute('aria-current'), 'page');
  await page.click(`${W} [data-nav=home]`);
  await page.click(`${W} .st-section[data-category=editors] .st-see-all`);
  check('see all: Editors page', await page.locator(`${W} .st-page`).getAttribute('data-view'), 'category');

  // search
  await page.keyboard.press('Control+f');
  check('Ctrl+F focuses search', await page.evaluate(() => document.activeElement?.classList.contains('st-search-input')), true);
  await page.keyboard.type('rip');
  await until(async () => (await page.locator(`${W} .st-page`).getAttribute('data-view')) === 'search');
  check('search "rip": ripgrep ranked first', (await page.locator(`${W} .st-card`).evaluateAll((els) => els.map((e) => e.dataset.id)))[0], 'ripgrep');
  await page.fill(`${W} .st-search-input`, 'json');
  check('search in descriptions: "json" finds jq', await page.locator(`${W} .st-card`).evaluateAll((els) => els.map((e) => e.dataset.id)), ['jq']);
  await page.fill(`${W} .st-search-input`, 'nvim');
  check('search by command "nvim": Neovim', await page.locator(`${W} .st-card`).evaluateAll((els) => els.map((e) => e.dataset.id)), ['neovim']);
  await page.fill(`${W} .st-search-input`, 'zzzqqq');
  check('search: empty state', await page.locator(`${W} .st-empty`).innerText(), (v) => /No results/.test(v));
  await page.press(`${W} .st-search-input`, 'Escape');
  check('Escape clears search', await page.locator(`${W} .st-search-input`).inputValue(), '');
  check('Escape: window still open', await page.locator(W).count(), 1);

  // detail + install canceled
  await page.click(`${W} [data-nav="cat:system"]`);
  await page.click(`${W} .st-card[data-id=htop]`);
  await page.waitForSelector(`${W} .st-detail-head`);
  check('detail: title', (await page.locator(`${W} .st-detail-title h1`).innerText()).trim(), 'htop');
  check('detail: info shows package + not installed', await page.locator(`${W} .st-info`).innerText(), (v) => /htop/.test(v) && /Not installed/.test(v));
  check('detail: how-to shows the command', (await page.locator(`${W} .st-cmd`).innerText()).trim(), 'htop');
  check('detail: window title', await page.evaluate(() => window.__aurora.wm.byApp('store')[0]?.title || document.querySelector('.app-store')?.closest('.window')?.querySelector('.title, .win-title')?.textContent || ''), (v) => /htop/.test(v));
  await page.click(`${W} .st-install`);
  await page.waitForSelector('.uac-dialog', { timeout: 10000 });
  check('UAC: reason names the package', await page.locator('.uac-dialog').innerText(), (v) => /install htop \(htop\)/.test(v));
  await page.keyboard.press('Escape');
  await page.waitForSelector('.uac-dialog', { state: 'detached', timeout: 8000 }).catch(() => {});
  await sleep(300);
  check('cancel: Install button back, no error', (await page.locator(`${W} .st-install`).count()) === 1 && (await page.locator(`${W} .st-error`).count()) === 0, true);

  // install with progress
  await page.click(`${W} .st-install`);
  await uac(s);
  const sawProgress = await until(async () => (await page.locator(`${W} .st-progress`).count()) > 0, { timeout: 5000, every: 50 });
  check('install: progress bar shown', !!sawProgress, true);
  const pct = await until(async () => Number((await page.locator(`${W} .st-progress`).getAttribute('aria-valuenow').catch(() => '0')) || 0) > 0 && Number(await page.locator(`${W} .st-progress`).getAttribute('aria-valuenow')), { timeout: 5000, every: 50 });
  check('install: progress advances', pct, (v) => v > 0);
  await page.waitForSelector(`${W} .st-detail-head .st-open`, { timeout: 20000 });
  check('install: Installed chip', await page.locator(`${W} .st-detail-head .st-chip.ok`).count(), 1);
  check('install: version shown', await page.locator(`${W} .st-info`).innerText(), (v) => !/Not installed/.test(v));
  check('install: badge now 6', (await page.locator(`${W} [data-nav=installed] .st-count`).innerText()).trim(), '6');
  check('install: notification', await page.evaluate(() => window.__aurora.notifications.list().some((n) => /htop is installed/.test(n.title))), true);

  // Open in Terminal (launch intercepted)
  await page.evaluate(() => {
    window.__storeLaunches = [];
    const sh = window.__aurora.shell;
    sh.__origLaunch = sh.launch;
    sh.launch = (id, args) => (window.__storeLaunches.push({ id, args }), null);
  });
  await page.click(`${W} .st-detail-head .st-open`);
  check('Open in Terminal: runs htop', await page.evaluate(() => window.__storeLaunches), [{ id: 'terminal', args: { command: 'htop' } }]);

  // keyboard back
  await page.locator(`${W} .st-back`).focus();
  await page.keyboard.press('Alt+ArrowLeft');
  check('Alt+Left: back to the category', await page.locator(`${W} .st-page`).getAttribute('data-view'), 'category');
  await page.locator(`${W} .st-card[data-id=ncdu]`).focus();
  await page.keyboard.press('Enter');
  check('Enter on a card opens its page', (await page.locator(`${W} .st-detail-title h1`).innerText().catch(() => '')).trim(), 'ncdu');
  await page.keyboard.press('Backspace');
  check('Backspace: back', await page.locator(`${W} .st-page`).getAttribute('data-view'), 'category');
  check('back: focus returns to the card that was open', await page.evaluate(() => document.activeElement?.dataset?.id || ''), 'ncdu');

  // failure (simulated for btop)
  await page.click(`${W} .st-card[data-id=btop]`);
  await page.click(`${W} .st-install`);
  await uac(s);
  await page.waitForSelector(`${W} .st-error`, { timeout: 15000 }).catch(() => {});
  check('failure: error infobar', await page.locator(`${W} .st-error`).innerText().catch(() => ''), (v) => /could not install btop/.test(v));
  check('failure: Install offered again', await page.locator(`${W} .st-install`).count(), 1);

  // Installed view + remove from a row
  await page.click(`${W} [data-nav=installed]`);
  check('Installed: rows', await page.locator(`${W} .st-row`).evaluateAll((els) => els.map((e) => e.dataset.id).sort()), ['curl', 'git', 'htop', 'rsync', 'unzip', 'wget']);
  await page.click(`${W} .st-row[data-id=git] .st-open`);
  check('Installed: Open on a CLI tool opens a plain Terminal', await page.evaluate(() => window.__storeLaunches.at(-1)), { id: 'terminal', args: {} });
  await page.click(`${W} .st-row[data-id=htop] .st-remove`);
  check('UAC: remove reason', await page.locator('.uac-dialog').innerText().catch(() => ''), (v) => /remove htop/.test(v));
  await uac(s);
  await until(async () => (await page.locator(`${W} .st-row[data-id=htop]`).count()) === 0, { timeout: 15000 });
  check('remove: row gone', await page.locator(`${W} .st-row[data-id=htop]`).count(), 0);
  check('remove: badge back to 5', (await page.locator(`${W} [data-nav=installed] .st-count`).innerText()).trim(), '5');

  // backend refuses packages that are not in the catalog
  const refused = await page.evaluate(() => window.__aurora.api.invoke('admin:run', 'pw', 'store-install', ['sudo']).then(() => 'ok', (e) => e.code || e.message));
  check('backend: unlisted package refused', refused, (v) => /EPERM|not in the store catalog/.test(String(v)));
  const bad = await page.evaluate(() => window.__aurora.api.invoke('admin:run', 'pw', 'store-install', ['a b']).then(() => 'ok', (e) => e.code || e.message));
  check('backend: invalid name refused', bad, (v) => /EINVAL|invalid argument/.test(String(v)));

  // narrow window: compact navigation, no horizontal overflow
  await page.evaluate(() => window.__aurora.wm.byApp('store')[0].setSize(560, 520));
  await sleep(400);
  await page.click(`${W} [data-nav=home]`);
  check('narrow: nav labels hidden', await page.locator(`${W} [data-nav=home] .st-nav-label`).isVisible(), false);
  check('narrow: no horizontal overflow', await page.locator(`${W} .st-content`).evaluate((el) => el.scrollWidth <= el.clientWidth + 1), true);
  await page.evaluate(() => {
    const sh = window.__aurora.shell;
    if (sh.__origLaunch) sh.launch = sh.__origLaunch;
  });
} catch (e) {
  failures.push(`EN run crashed: ${e.stack || e.message}`);
} finally {
  check('EN: no console errors', errors.filter((e) => !/favicon|ResizeObserver/.test(e)), []);
  await s.close();
}

// ------------------------------------------------------------------ French, dark
s = await launchShell({ lang: 'fr', theme: 'dark' });
try {
  const { page } = s;
  await page.evaluate(() => window.__aurora.registry.launch('store', { id: 'tmux' }));
  await page.waitForSelector(`${W} .st-detail-head`, { timeout: 30000 });
  check('FR: launch args open the detail page', (await page.locator(`${W} .st-detail-title h1`).innerText()).trim(), 'tmux');
  check('FR: French description', await page.locator(`${W} .st-desc`).innerText(), (v) => /Multiplexeur de terminal/.test(v));
  check('FR: Install button', (await page.locator(`${W} .st-install`).innerText()).trim(), 'Installer');
  check('FR: dark theme', await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
  await page.click(`${W} .st-back`);
  check('FR: back to home', await page.locator(`${W} .st-page`).getAttribute('data-view'), 'home');
  check('FR: nav in French', await page.locator(`${W} .st-nav`).innerText(), (v) => /Accueil/.test(v) && /Installés/.test(v) && /Développement/.test(v));
  check('FR: notice in French', await page.locator(`${W} .st-notice`).innerText(), (v) => /applications graphiques arriveront plus tard/.test(v));
  check('FR: no English leftovers', await page.locator(W).innerText(), (v) => !/\b(Home|Installed|See all|Free|Graphical)\b/.test(v) && !/\bundefined\b|\bnull\b/.test(v));
  const fg = await page.locator(`${W} .st-card-name`).first().evaluate((el) => getComputedStyle(el).color);
  check('FR dark: card text is light', fg, (v) => {
    const m = v.match(/\d+/g).map(Number);
    return m[0] > 180 && m[1] > 180 && m[2] > 180;
  });
  await page.click(`${W} .st-card[data-id=btop]`);
  await page.waitForSelector(`${W} .st-detail-head`);
  await s.shot('store-dark-fr');
  fs.copyFileSync(path.join(ROOT, 'test', 'out', 'store-dark-fr.png'), path.join(DOCS, 'store-dark-fr.png'));
} catch (e) {
  failures.push(`FR run crashed: ${e.stack || e.message}`);
} finally {
  await s.close();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL ${f}`);
process.exit(failures.length ? 1 : 0);
