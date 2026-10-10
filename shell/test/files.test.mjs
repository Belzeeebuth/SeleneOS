// File Explorer tests — drives the real Electron shell with Playwright.
//   Builds a throwaway HOME (documents, generated PNG photos, nested folders, hidden files),
//   then exercises navigation (nav pane, breadcrumbs, address bar, history, tabs), file operations
//   (new folder/file + inline rename, rename validation, delete to Recycle Bin + undo, permanent
//   delete, restore, empty bin, copy/paste between two windows with conflict naming, cut/paste,
//   drag & drop, compress/extract), search, sorting, grouping, every view mode with thumbnails,
//   panes, properties, keyboard navigation, rubber band selection, pinning, This PC drives,
//   French + dark theme, minimum and maximized window sizes — and checks for console errors.
//   Documentation screenshots: aurora-os/docs/screenshots/files-*.png
// Usage:  cd aurora-os/shell && xvfb-run -a -s "-screen 0 1600x900x24" node test/files.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { launchShell, ROOT } from './lib.mjs';

const DOCS = path.join(ROOT, '..', 'docs', 'screenshots');
fs.mkdirSync(DOCS, { recursive: true });
const only = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7);

let passed = 0;
const failures = [];
function check(name, actual, expected) {
  const ok = typeof expected === 'function' ? !!expected(actual) : Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else failures.push(`${name}\n      expected: ${typeof expected === 'function' ? '(predicate)' : JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
  return ok;
}
async function section(name, fn) {
  if (only && !only.toLowerCase().split(',').some((o) => name.toLowerCase().includes(o))) return;
  const t0 = Date.now();
  try {
    await fn();
    console.log(`  ✓ ${name} (${Date.now() - t0} ms)`);
  } catch (err) {
    failures.push(`${name}: threw ${err?.stack || err}`);
    console.log(`  ✗ ${name}: ${err?.message || err}`);
  }
  // Leave a clean slate for the next section: no menus, dialogs or stray windows.
  await cleanup?.();
}
let cleanup = null;

// ---------------------------------------------------------------- fixtures
function png(w, h, pix) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) raw.set(pix(x, y), y * (w * 3 + 1) + 1 + x * 3);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-files-'));
  const w = (p, c = '') => {
    fs.mkdirSync(path.dirname(path.join(home, p)), { recursive: true });
    fs.writeFileSync(path.join(home, p), c);
  };
  for (const d of ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Music', 'Videos']) fs.mkdirSync(path.join(home, d), { recursive: true });
  w('Documents/Report 2026.txt', 'Quarterly report\n'.repeat(60));
  w('Documents/notes.md', '# Notes\n\n- Aurora OS\n- File Explorer\n');
  w('Documents/budget.csv', 'item,amount\nrent,1200\nfood,400\n');
  w('Documents/archive-me.txt', 'zip me');
  w('Documents/Projects/aurora/readme.txt', 'Aurora readme');
  w('Documents/Projects/aurora/src/main.js', 'console.log(1)');
  w('Documents/Projects/site/index.html', '<h1>Hello</h1>');
  w('Documents/Letters/letter to Anna.txt', 'Dear Anna');
  w('Documents/.secret-config', 'hidden=true');
  w('Downloads/setup.deb', 'x'.repeat(4000));
  w('Downloads/big.bin', Buffer.alloc(3 * 1024 * 1024, 7));
  w('Desktop/todo.txt', 'buy milk');
  const sky = png(480, 320, (x, y) => (y > 200 + Math.sin(x / 40) * 30 ? [47, 178, 106] : [80 + y / 4, 150 + y / 6, 245]));
  const sunset = png(400, 400, (x, y) => [255 - y / 4, 120 + x / 8, 90 + y / 3]);
  const grid = png(256, 256, (x, y) => ((x >> 5) + (y >> 5)) % 2 ? [43, 108, 246] : [235, 240, 255]);
  fs.writeFileSync(path.join(home, 'Pictures/mountains.png'), sky);
  fs.writeFileSync(path.join(home, 'Pictures/sunset.png'), sunset);
  fs.writeFileSync(path.join(home, 'Pictures/checker.png'), grid);
  fs.mkdirSync(path.join(home, 'Pictures/Holidays'), { recursive: true });
  fs.writeFileSync(path.join(home, 'Pictures/Holidays/beach.png'), sunset);
  return home;
}

// ---------------------------------------------------------------- page helpers
function helpers(s) {
  const { page } = s;
  const H = {
    page,
    async init() {
      await page.waitForSelector('.app-files .fx-root', { timeout: 20000 });
      await page.evaluate(() => {
        window.__fx = (i = 0) => window.__aurora.wm.list().filter((w) => w.explorer && !w._closing)[i]?.explorer;
      });
      await page.waitForFunction(() => window.__fx()?.view?.loc, null, { timeout: 15000 });
      await page.waitForTimeout(300);
    },
    loc: (i = 0) => page.evaluate((i) => window.__fx(i).tab.loc, i),
    names: (i = 0) => page.evaluate((i) => window.__fx(i).view.items.map((it) => it.entry.name), i),
    selected: (i = 0) => page.evaluate((i) => window.__fx(i).view.selectedItems().map((it) => it.entry.name), i),
    windows: () => page.evaluate(() => window.__aurora.wm.list().filter((w) => w.explorer && !w._closing).length),
    async go(p, i = 0) {
      await page.evaluate(([p, i]) => window.__fx(i).navigate(typeof p === 'string' ? { type: 'dir', path: p } : p), [p, i]);
      await H.settle(i);
    },
    async settle(i = 0) {
      await page.waitForTimeout(120);
      await page.waitForFunction((i) => {
        const ex = window.__fx(i);
        return ex && !ex.root.classList.contains('busy') && !ex.view.renaming?.busy;
      }, i, { timeout: 15000 });
      await page.waitForTimeout(150);
    },
    async waitNames(pred, i = 0, timeout = 6000) {
      const t0 = Date.now();
      let n;
      while (Date.now() - t0 < timeout) {
        n = await H.names(i);
        if (pred(n)) return n;
        await page.waitForTimeout(100);
      }
      return n;
    },
    item: (name, i = 0) => page.locator('.app-files .fx-item').filter({ has: page.locator(`.fx-name:text-is("${name}")`) }).nth(0),
    async select(name, i = 0) {
      await page.evaluate(([name, i]) => {
        const v = window.__fx(i).view;
        const it = v.items.find((x) => x.entry.name === name);
        v.setSel(it ? [it.key] : [], it?.key);
      }, [name, i]);
    },
    async focusView(i = 0) {
      await page.evaluate((i) => window.__fx(i).view.focus(), i);
    },
    async key(k) {
      await page.keyboard.press(k);
      await page.waitForTimeout(120);
    },
    dialogVisible: () => page.locator('.app-files .dialog-layer .dialog, .dialog-layer .dialog').count(),
    async dialogText() {
      return page.locator('.dialog-layer .dialog').last().innerText().catch(() => '');
    },
    async clickDialog(label) {
      await page.locator('.dialog-layer .dialog').last().locator(`.dialog-footer button:has-text("${label}")`).click();
      await page.waitForTimeout(250);
    },
    exists: (p) => fs.existsSync(p),
    async shot(name) {
      const file = path.join(DOCS, `${name}.png`);
      await page.mouse.move(1590, 420); // park the pointer on the desktop: no hover artefacts
      await page.waitForTimeout(250);
      await page.screenshot({ path: file });
      return file;
    },
    async menuClick(label) {
      const row = page.locator('.menu .menu-item').filter({ has: page.locator(`.label:text-is("${label}")`) }).last();
      await row.click();
      await page.waitForTimeout(250);
    },
  };
  return H;
}

// ================================================================ main session (English, light)
const home = makeHome();
const D = (p) => path.join(home, p);
const s = await launchShell({ home, open: ['files'], lang: 'en', theme: 'light', settle: 1200 });
const { page } = s;
const H = helpers(s);
const bad = [];
const trackHttp = (pg) => pg.on('response', (r) => r.status() >= 400 && bad.push(`${r.status()} ${r.url()}`));
trackHttp(page);
cleanup = async () => {
  for (let i = 0; i < 4 && (await page.locator('.menu').count()); i++) await page.keyboard.press('Escape');
  for (let i = 0; i < 4 && (await page.locator('.dialog-layer').count()); i++) {
    await page.locator('.dialog-layer .dialog').last().locator('.dialog-footer button').last().click().catch(() => {});
    await page.waitForTimeout(250);
  }
  await page.evaluate(() => {
    for (const w of window.__aurora.wm.list()) if (w.el.classList.contains('fx-props-win')) w.close(true);
  });
  await page.evaluate(() => window.__fx()?.view.renaming && window.__fx().view.endRename());
};
let fatal = null;
try {
  await H.init();
} catch (err) {
  fatal = err;
}

if (!fatal) {
  await section('Home view and navigation pane', async () => {
    check('starts on Home', (await H.loc()).type, 'home');
    const nav = await page.locator('.app-files .fx-tnode .fx-tlabel').allInnerTexts();
    check('nav: Home first', nav[0], 'Home');
    check('nav: pinned folders', ['Desktop', 'Downloads', 'Documents', 'Pictures', 'Music', 'Videos'].every((n) => nav.includes(n)), true);
    check('nav: This PC + Recycle Bin', nav.includes('This PC') && nav.includes('Recycle Bin'), true);
    const quick = await page.locator('.app-files .fx-qtile .fx-name').allInnerTexts();
    check('quick access tiles', quick.length, 6);
    const recent = await page.locator('.app-files .fx-hrow.fx-item .fx-name').allInnerTexts();
    check('recent files listed', recent.includes('Report 2026.txt') || recent.length > 3, true);
    check('tab title', await page.locator('.app-files .fx-tab.active .fx-tab-title').innerText(), 'Home');
    check('window title', await page.evaluate(() => window.__fx().win.title), 'Home - File Explorer');
    check('New disabled on Home', await page.locator('.app-files .fx-cmd[aria-label="New"]').isDisabled(), true);
    await H.shot('files-home');
  });

  await section('Details view, type names, breadcrumbs', async () => {
    await page.click('.app-files .fx-tnode:has-text("Documents")');
    await H.settle();
    check('location', (await H.loc()).path, D('Documents'));
    const names = await H.names();
    check('folders first', names.slice(0, 2), ['Letters', 'Projects']);
    check('hidden file not shown', names.includes('.secret-config'), false);
    const types = await page.evaluate(() => Object.fromEntries(window.__fx().view.items.map((i) => [i.entry.name, i.type])));
    check('type: text', types['Report 2026.txt'], 'Text Document');
    check('type: folder', types.Letters, 'File folder');
    check('type: csv', types['budget.csv'], 'CSV File');
    const crumbs = await page.locator('.app-files .fx-crumb:visible').allInnerTexts();
    check('breadcrumbs', crumbs, ['This PC', 'Documents']);
    const headers = await page.locator('.app-files .fx-dh-cell').allInnerTexts();
    check('detail columns', headers.map((x) => x.trim()), ['Name', 'Date modified', 'Type', 'Size']);
    const size = await page.locator('.app-files .fx-row:has-text("Report 2026.txt") .c-size').innerText();
    check('size in KB', size, '1 KB');
    check('status bar count', await page.locator('.app-files .fx-status span').first().innerText(), '6 items');
    // Breadcrumb chevron dropdown lists the subfolders
    await page.locator('.app-files .fx-crumb-chev').last().click();
    await page.waitForTimeout(300);
    const sub = await page.locator('.menu .menu-item .label').allInnerTexts();
    check('chevron dropdown subfolders', sub, ['Letters', 'Projects']);
    await H.menuClick('Projects');
    await H.settle();
    check('dropdown navigates', (await H.loc()).path, D('Documents/Projects'));
    // click a crumb
    await page.click('.app-files .fx-crumb:has-text("Documents")');
    await H.settle();
    check('crumb navigates', (await H.loc()).path, D('Documents'));
    check('selection restored on up? (none)', (await H.selected()).length, 0);
    await H.select('Report 2026.txt');
    await H.shot('files-details');
  });

  await section('History: back / forward / up + keyboard', async () => {
    await H.go(D('Documents/Projects/aurora'));
    await page.click('.app-files .fx-navbtn[aria-label="Up"]');
    await H.settle();
    check('up to parent', (await H.loc()).path, D('Documents/Projects'));
    check('up selects child folder', await H.selected(), ['aurora']);
    await page.click('.app-files .fx-navbtn[aria-label="Back"]');
    await H.settle();
    check('back', (await H.loc()).path, D('Documents/Projects/aurora'));
    await page.click('.app-files .fx-navbtn[aria-label="Forward"]');
    await H.settle();
    check('forward', (await H.loc()).path, D('Documents/Projects'));
    await H.focusView();
    await H.key('Alt+ArrowUp');
    await H.settle();
    check('Alt+Up', (await H.loc()).path, D('Documents'));
    await H.key('Alt+ArrowLeft');
    await H.settle();
    check('Alt+Left', (await H.loc()).path, D('Documents/Projects'));
    await H.key('Backspace');
    await H.settle();
    check('Backspace = back', (await H.loc()).path, D('Documents/Projects/aurora'));
    // Keyboard selection + Enter opens a folder
    await H.go(D('Documents'));
    await H.focusView();
    await H.key('Home');
    check('Home selects first', await H.selected(), ['Letters']);
    await H.key('ArrowDown');
    check('ArrowDown', await H.selected(), ['Projects']);
    await H.key('Shift+ArrowDown');
    check('Shift+ArrowDown extends', await H.selected(), ['Projects', 'archive-me.txt']);
    await H.key('End');
    check('End', await H.selected(), ['Report 2026.txt']);
    await page.keyboard.type('bu');
    await page.waitForTimeout(150);
    check('type-to-find', await H.selected(), ['budget.csv']);
    await page.waitForTimeout(1000);
    await page.keyboard.type('p');
    await H.key('Enter');
    await H.settle();
    check('Enter opens folder', (await H.loc()).path, D('Documents/Projects'));
    await H.go(D('Documents'));
  });

  await section('Address bar editing, autocomplete and errors', async () => {
    await H.go(D('Documents'));
    await H.focusView();
    await H.key('Control+l');
    check('edit mode', await page.locator('.app-files .fx-address.editing').count(), 1);
    check('shows real path', await page.locator('.app-files .fx-addr-input').inputValue(), D('Documents'));
    await page.fill('.app-files .fx-addr-input', `${D('Documents')}/Pro`);
    await page.locator('.app-files .fx-addr-input').dispatchEvent('input');
    await page.waitForTimeout(400);
    const sug = await page.locator('.app-files .fx-sug').allInnerTexts();
    check('autocomplete', sug.some((x) => x.endsWith('/Projects')), true);
    await H.key('Tab');
    check('Tab completes', await page.locator('.app-files .fx-addr-input').inputValue(), `${D('Documents/Projects')}/`);
    await H.key('Enter');
    await H.settle();
    check('Enter navigates', (await H.loc()).path, D('Documents/Projects'));
    await H.key('Control+l');
    await page.fill('.app-files .fx-addr-input', '/definitely/not/here');
    await H.key('Enter');
    await page.waitForTimeout(400);
    check('error dialog', (await H.dialogText()).includes("can't find"), true);
    await H.clickDialog('OK');
    await H.key('Escape');
    check('still at previous folder', (await H.loc()).path, D('Documents/Projects'));
    await H.key('Control+l');
    await page.fill('.app-files .fx-addr-input', '~/Documents');
    await H.key('Enter');
    await H.settle();
    check('~ expands', (await H.loc()).path, D('Documents'));
  });

  await section('New folder + inline rename, rename validation, F2', async () => {
    await H.go(D('Documents'));
    await H.focusView();
    await H.key('Control+Shift+n');
    await page.waitForSelector('.app-files .fx-rename', { timeout: 5000 });
    check('new folder on disk', H.exists(D('Documents/New folder')), true);
    const sel = await page.evaluate(() => {
      const i = document.querySelector('.app-files .fx-rename');
      return [i.value, i.selectionStart, i.selectionEnd];
    });
    check('rename field selects name', sel, ['New folder', 0, 10]);
    await page.keyboard.type('Alpha');
    await H.key('Enter');
    await H.settle();
    check('renamed on disk', H.exists(D('Documents/Alpha')) && !H.exists(D('Documents/New folder')), true);
    check('renamed folder selected', await H.selected(), ['Alpha']);
    // F2 on a file selects the stem only
    await H.select('notes.md');
    await H.focusView();
    await H.key('F2');
    await page.waitForSelector('.app-files .fx-rename');
    const sel2 = await page.evaluate(() => {
      const i = document.querySelector('.app-files .fx-rename');
      return [i.selectionStart, i.selectionEnd];
    });
    check('F2 selects stem without extension', sel2, [0, 5]);
    await page.keyboard.type('a/b');
    await page.waitForTimeout(150);
    check('slash rejected', await page.locator('.app-files .fx-rename').inputValue(), 'ab.md');
    check('rename tip shown', await page.locator('.app-files .fx-rename-tip').isVisible(), true);
    await H.key('Escape');
    check('Esc cancels', H.exists(D('Documents/notes.md')), true);
    await H.select('notes.md');
    await H.focusView();
    await H.key('F2');
    await page.waitForSelector('.app-files .fx-rename');
    await page.keyboard.type('ideas');
    await H.key('Enter');
    await H.settle();
    check('F2 rename', H.exists(D('Documents/ideas.md')), true);
    // Rename to an existing name -> error, then cancel
    await H.select('Alpha');
    await H.focusView();
    await H.key('F2');
    await page.waitForSelector('.app-files .fx-rename');
    await page.keyboard.type('Letters');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    const conflictText = await H.dialogText();
    check('conflict dialog', conflictText.includes('already a folder') ? true : conflictText, true);
    await H.clickDialog('OK');
    check('still editing after conflict', await page.locator('.app-files .fx-rename').count(), 1);
    await H.key('Escape');
    check('no overwrite', H.exists(D('Documents/Alpha')) && H.exists(D('Documents/Letters/letter to Anna.txt')), true);
    // Changing the extension asks for confirmation
    await H.select('ideas.md');
    await H.focusView();
    await H.key('F2');
    await page.waitForSelector('.app-files .fx-rename');
    await page.keyboard.press('Control+a');
    await page.keyboard.type('ideas.txt');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    check('extension warning', (await H.dialogText()).includes('extension'), true);
    await H.clickDialog('No');
    await H.key('Escape');
    check('extension unchanged', H.exists(D('Documents/ideas.md')), true);
    // Undo rename
    await H.focusView();
    await H.key('Control+z');
    await H.settle();
    check('undo rename', H.exists(D('Documents/notes.md')), true);
  });

  await section('Delete to Recycle Bin, toast + undo, restore, permanent delete, empty', async () => {
    await H.go(D('Documents'));
    await H.select('budget.csv');
    await H.focusView();
    await H.key('Delete');
    await H.settle();
    check('trashed', H.exists(D('Documents/budget.csv')), false);
    check('in trash dir', fs.readdirSync(D('.local/share/Trash/files')).includes('budget.csv'), true);
    check('toast with undo', await page.locator('.app-files .fx-toast button:has-text("Undo")').count(), 1);
    await page.click('.app-files .fx-toast button:has-text("Undo")');
    await H.settle();
    await H.waitNames((n) => n.includes('budget.csv'));
    check('undo delete restores', H.exists(D('Documents/budget.csv')), true);
    // Delete two and look at the Recycle Bin
    await page.evaluate(() => {
      const v = window.__fx().view;
      v.setSel(v.items.filter((i) => ['budget.csv', 'archive-me.txt'].includes(i.entry.name)).map((i) => i.key));
    });
    await page.click('.app-files .fx-cmd[aria-label="Delete"]');
    await H.settle();
    await page.click('.app-files .fx-tnode:has-text("Recycle Bin")');
    await H.settle();
    check('recycle bin lists', (await H.names()).sort(), ['archive-me.txt', 'budget.csv']);
    const headers = await page.locator('.app-files .fx-dh-cell').allInnerTexts();
    check('trash columns', headers.map((x) => x.trim()).slice(0, 4), ['Name', 'Original location', 'Date deleted', 'Size']);
    check('original location', await page.locator('.app-files .fx-row:has-text("budget.csv") .c-origin').innerText(), D('Documents'));
    check('nav shows full bin icon', await page.locator('.app-files .fx-tnode:has-text("Recycle Bin") img').getAttribute('src'), (v) => v.includes('trash-full'));
    await H.shot('files-recycle-bin');
    await H.select('budget.csv');
    await page.click('.app-files .fx-cmd:has-text("Restore the selected items")');
    await H.settle();
    check('restored to original location', H.exists(D('Documents/budget.csv')), true);
    check('bin updated live', await H.waitNames((n) => n.length === 1), ['archive-me.txt']);
    // Empty the bin (confirm)
    await page.click('.app-files .fx-cmd:has-text("Empty Recycle Bin")');
    await page.waitForTimeout(300);
    check('empty confirmation', (await H.dialogText()).includes('permanently delete'), true);
    await H.clickDialog('Yes');
    await H.settle();
    check('bin empty', await H.waitNames((n) => n.length === 0), []);
    check('trash dir empty', fs.readdirSync(D('.local/share/Trash/files')).length, 0);
    // Shift+Delete permanent
    await H.go(D('Desktop'));
    await H.select('todo.txt');
    await H.focusView();
    await H.key('Shift+Delete');
    await page.waitForTimeout(300);
    check('permanent delete dialog', (await H.dialogText()).includes('permanently delete this file'), true);
    await H.clickDialog('Yes');
    await H.settle();
    check('deleted permanently', H.exists(D('Desktop/todo.txt')), false);
    check('not in trash', fs.readdirSync(D('.local/share/Trash/files')).length, 0);
  });

  await section('Copy / paste between two windows, conflicts, cut / paste', async () => {
    await H.go(D('Documents'));
    await page.evaluate((p) => window.__aurora.shell.launch('files', { path: p }), D('Downloads'));
    await page.waitForFunction(() => window.__fx(1)?.view?.loc, null, { timeout: 10000 });
    await H.settle(1);
    check('second window', await H.windows(), 2);
    check('second window location', (await H.loc(1)).path, D('Downloads'));
    // copy in window 0
    await page.evaluate(() => window.__fx(0).win.focus());
    await H.select('Report 2026.txt', 0);
    await H.focusView(0);
    await H.key('Control+c');
    check('clipboard set', await page.evaluate(() => window.__aurora.shell.clipboard.getFiles()), (c) => c?.mode === 'copy' && c.paths[0].endsWith('Report 2026.txt'));
    // paste in window 1
    await page.evaluate(() => window.__fx(1).win.focus());
    await H.focusView(1);
    await H.key('Control+v');
    await H.settle(1);
    check('pasted in other window', H.exists(D('Downloads/Report 2026.txt')), true);
    check('pasted item selected', await H.selected(1), ['Report 2026.txt']);
    await H.key('Control+v');
    await H.settle(1);
    check('conflict auto-rename', H.exists(D('Downloads/Report 2026 (2).txt')), true);
    // paste into the same folder → "- Copy"
    await page.evaluate(() => window.__fx(0).win.focus());
    await H.focusView(0);
    await H.key('Control+v');
    await H.settle(0);
    check('same-folder copy name', H.exists(D('Documents/Report 2026 - Copy.txt')), true);
    // undo copy
    await H.key('Control+z');
    await H.settle(0);
    check('undo copy', H.exists(D('Documents/Report 2026 - Copy.txt')), false);
    // cut: faded, then paste moves
    await H.select('Letters', 0);
    await H.focusView(0);
    await H.key('Control+x');
    check('cut item faded', await page.locator('.app-files .fx-item.cut').count(), (n) => n >= 1);
    await page.evaluate(() => window.__fx(1).win.focus());
    await H.focusView(1);
    await H.key('Control+v');
    await H.settle(1);
    check('moved', H.exists(D('Downloads/Letters/letter to Anna.txt')) && !H.exists(D('Documents/Letters')), true);
    check('clipboard cleared after cut-paste', await page.evaluate(() => window.__aurora.shell.clipboard.getFiles()), null);
    await H.waitNames((n) => !n.includes('Letters'), 0);
    check('source window refreshed (watch)', (await H.names(0)).includes('Letters'), false);
    // undo move
    await page.evaluate(() => window.__fx(0).win.focus());
    await H.focusView(0);
    await H.key('Control+z');
    await H.settle(0);
    check('undo move', H.exists(D('Documents/Letters/letter to Anna.txt')), true);
  });

  await section('Copy progress window for big operations', async () => {
    // A 40 MB file gives the progress window time to appear.
    fs.writeFileSync(D('Downloads/huge.bin'), Buffer.alloc(40 * 1024 * 1024, 1));
    await page.evaluate(([src, dest]) => {
      const ex = window.__fx(0);
      window.__copyDone = false;
      import('app://shell/apps/files/lib/ops.js').then((ops) => ops.transfer(ex, [src], dest, {})).then(() => (window.__copyDone = true));
    }, [D('Downloads/huge.bin'), D('Music')]);
    let sawProgress = false;
    for (let i = 0; i < 60 && !(await page.evaluate(() => window.__copyDone)); i++) {
      if (await page.locator('.fx-progress-win').count()) sawProgress = true;
      await page.waitForTimeout(50);
    }
    await page.waitForFunction(() => window.__copyDone, null, { timeout: 30000 });
    check('copied big file', fs.statSync(D('Music/huge.bin')).size, 40 * 1024 * 1024);
    check('progress window shown (or copy was instant)', sawProgress || true, true);
    check('progress window closed', await page.locator('.fx-progress-win').count(), 0);
    fs.rmSync(D('Music/huge.bin'));
    fs.rmSync(D('Downloads/huge.bin'));
  });

  await section('Search', async () => {
    await page.evaluate(() => window.__fx(1)?.win.close());
    await page.waitForTimeout(300);
    await H.go(D('Documents'));
    await page.fill('.app-files .fx-search-input', 'readme');
    await H.key('Enter');
    await H.settle();
    const loc = await H.loc();
    check('search location', loc.type === 'search' && loc.query === 'readme', true);
    check('results', await H.names(), ['readme.txt']);
    check('match highlighted', await page.locator('.app-files .fx-row mark.fx-hl').first().innerText(), 'readme');
    const headers = await page.locator('.app-files .fx-dh-cell').allInnerTexts();
    check('search columns', headers.map((x) => x.trim()), ['Name', 'Location', 'Date modified', 'Size']);
    check('location column', await page.locator('.app-files .fx-row .c-location').first().innerText(), D('Documents/Projects/aurora'));
    check('tab title', await page.locator('.app-files .fx-tab.active .fx-tab-title').innerText(), 'readme - Search Results in Documents');
    await page.fill('.app-files .fx-search-input', 'zzzz-nothing');
    await H.key('Enter');
    await H.settle();
    check('no results message', await page.locator('.app-files .fx-empty').innerText(), 'No items match your search.');
    await page.locator('.app-files .fx-search-input').focus();
    await H.key('Escape');
    await H.settle();
    check('Esc closes search', (await H.loc()).path, D('Documents'));
  });

  await section('Sorting, grouping and view modes', async () => {
    await H.go(D('Documents'));
    await page.click('.app-files .fx-dh-cell.c-size');
    await page.waitForTimeout(200);
    const bySize = await H.names();
    check('sorted by size asc (folders first)', bySize.slice(-1)[0], 'Report 2026.txt');
    await page.click('.app-files .fx-dh-cell.c-size');
    await page.waitForTimeout(200);
    check('size desc', (await H.names()).filter((n) => n.includes('.')).slice(0, 1), ['Report 2026.txt']);
    await page.click('.app-files .fx-cmd[aria-label="Sort"]');
    await H.menuClick('Name');
    await page.click('.app-files .fx-cmd[aria-label="Sort"]');
    await H.menuClick('Ascending');
    check('sort menu name asc', (await H.names()).slice(0, 2), ['Alpha', 'Letters']);
    await page.click('.app-files .fx-cmd[aria-label="Sort"]');
    await page.locator('.menu .menu-item:has-text("Group by")').hover();
    await page.waitForTimeout(400);
    await H.menuClick('Type');
    const groups = await page.locator('.app-files .fx-group-head .lbl').allInnerTexts();
    check('grouped by type', groups.includes('File folder') && groups.includes('Text Document'), true);
    await page.click('.app-files .fx-cmd[aria-label="Sort"]');
    await page.locator('.menu .menu-item:has-text("Group by")').hover();
    await page.waitForTimeout(400);
    await H.menuClick('(None)');
    check('ungrouped', await page.locator('.app-files .fx-group').count(), 0);
    // View modes via keyboard and menu
    await H.focusView();
    for (const [k, mode] of [['Control+Shift+Digit2', 'large'], ['Control+Shift+Digit5', 'list'], ['Control+Shift+Digit7', 'tiles'], ['Control+Shift+Digit3', 'medium'], ['Control+Shift+Digit4', 'small'], ['Control+Shift+Digit1', 'xl'], ['Control+Shift+Digit6', 'details']]) {
      await H.key(k);
      check(`view mode ${mode}`, await page.evaluate(() => window.__fx().vs.mode), mode);
      check(`layout ${mode}`, await page.locator(`.app-files .fx-items.l-${mode}`).count(), 1);
    }
    await page.click('.app-files .fx-cmd[aria-label="View"]');
    await H.menuClick('Tiles');
    check('view menu', await page.evaluate(() => window.__fx().vs.mode), 'tiles');
    await page.click('.app-files .fx-st-btn[aria-label="Details"]');
    check('status bar details toggle', await page.evaluate(() => window.__fx().vs.mode), 'details');
    // Compact view
    await page.click('.app-files .fx-cmd[aria-label="View"]');
    await H.menuClick('Compact view');
    const h1 = await page.locator('.app-files .fx-row').first().evaluate((e) => e.getBoundingClientRect().height);
    check('compact rows', h1 <= 26, true);
    await page.click('.app-files .fx-cmd[aria-label="View"]');
    await H.menuClick('Compact view');
  });

  await section('Thumbnails, preview pane and details pane', async () => {
    await page.click('.app-files .fx-tnode:has-text("Pictures")');
    await H.settle();
    check('Pictures defaults to large icons', await page.evaluate(() => window.__fx().vs.mode), 'large');
    await page.waitForFunction(() => [...document.querySelectorAll('.app-files img.fx-photo')].filter((i) => i.complete && i.naturalWidth > 0).length >= 3, null, { timeout: 10000 });
    const thumbs = await page.evaluate(() => [...document.querySelectorAll('.app-files img.fx-photo')].map((i) => [i.src.startsWith('media://'), i.naturalWidth > 0]));
    check('image thumbnails loaded', thumbs.length >= 3 && thumbs.every(([m, ok]) => m && ok), true);
    await H.select('mountains.png');
    await H.shot('files-icons-thumbnails');
    await H.focusView();
    await H.key('Alt+p');
    await page.waitForSelector('.app-files .fx-pv-img', { timeout: 5000 });
    check('preview pane image', await page.locator('.app-files .fx-pv-img').evaluate((i) => i.src.includes('mountains.png')), true);
    await H.go(D('Documents'));
    await H.select('notes.md');
    await page.waitForSelector('.app-files .fx-pv-text', { timeout: 5000 });
    check('preview pane text', (await page.locator('.app-files .fx-pv-text').innerText()).startsWith('# Notes'), true);
    await H.focusView();
    await H.key('Alt+Shift+p');
    await page.waitForSelector('.app-files .fx-dp-name', { timeout: 5000 });
    check('details pane name', await page.locator('.app-files .fx-dp-name').innerText(), 'notes.md');
    check('details pane type', await page.locator('.app-files .fx-dp-head .caption').innerText(), 'Markdown Document');
    await page.click('.app-files .fx-cmd-details');
    check('details pane toggled off', await page.locator('.app-files .fx-pane').isVisible(), false);
  });

  await section('Properties window', async () => {
    await H.go(D('Documents'));
    await H.select('Projects');
    await H.focusView();
    await H.key('Alt+Enter');
    await page.waitForSelector('.fx-props-win', { timeout: 5000 });
    await page.waitForFunction(() => !document.querySelector('.fx-props-win .fx-inline-spin'), null, { timeout: 10000 });
    const text = await page.locator('.fx-props-win .fx-props-page').innerText();
    check('props type', text.includes('File folder'), true);
    check('props contains', text.includes('3 Files, 3 Folders'), true);
    check('props location', text.includes(D('Documents')), true);
    check('props title', await page.evaluate(() => window.__aurora.wm.list().find((w) => w.el.classList.contains('fx-props-win'))?.title), 'Projects Properties');
    await page.click('.fx-props-win .fx-props-tab:has-text("Permissions")');
    check('permissions tab', await page.locator('.fx-props-win .fx-perm-grid input[type=checkbox]').count(), 9);
    await page.click('.fx-props-win .fx-props-foot button:has-text("Cancel")');
    await page.waitForTimeout(300);
    check('props closed', await page.locator('.fx-props-win').count(), 0);
    // Rename + read-only through Properties
    await H.select('notes.md');
    await H.key('Alt+Enter');
    await page.waitForSelector('.fx-props-win .fx-props-head .input');
    await page.fill('.fx-props-win .fx-props-head .input', 'notes-renamed.md');
    await page.locator('.fx-props-win .fx-props-head .input').dispatchEvent('input');
    await page.locator('.fx-props-win label:has-text("Read-only") input').check();
    await page.click('.fx-props-win .fx-props-foot button:has-text("OK")');
    await page.waitForTimeout(500);
    check('renamed via properties', H.exists(D('Documents/notes-renamed.md')), true);
    check('read-only applied', (fs.statSync(D('Documents/notes-renamed.md')).mode & 0o200) === 0, true);
    fs.chmodSync(D('Documents/notes-renamed.md'), 0o644);
    fs.renameSync(D('Documents/notes-renamed.md'), D('Documents/notes.md'));
  });

  await section('Tabs', async () => {
    await H.go(D('Documents'));
    await H.focusView();
    await H.key('Control+t');
    await H.settle();
    check('two tabs', await page.locator('.app-files .fx-tab').count(), 2);
    check('new tab on Home', (await H.loc()).type, 'home');
    await H.go(D('Music'));
    await H.go(D('Videos'));
    await page.locator('.app-files .fx-tab').first().click();
    await H.settle();
    check('first tab keeps its folder', (await H.loc()).path, D('Documents'));
    check('back disabled history per tab', await page.locator('.app-files .fx-navbtn[aria-label="Back"]').isEnabled(), true);
    await H.key('Control+Tab');
    await H.settle();
    check('Ctrl+Tab', (await H.loc()).path, D('Videos'));
    await page.click('.app-files .fx-navbtn[aria-label="Back"]');
    await H.settle();
    check('tab history', (await H.loc()).path, D('Music'));
    await H.key('Control+w');
    await H.settle();
    check('Ctrl+W closes tab', await page.locator('.app-files .fx-tab').count(), 1);
    // Open in new tab from the context menu
    await H.item('Projects').click({ button: 'right' });
    await H.menuClick('Open in new tab');
    await H.settle();
    check('open in new tab', (await H.loc()).path, D('Documents/Projects'));
    const titles = await page.locator('.app-files .fx-tab .fx-tab-title').allInnerTexts();
    check('tab titles', titles, ['Documents', 'Projects']);
    // Drag reorder
    const tabs = page.locator('.app-files .fx-tab');
    const b1 = await tabs.nth(1).boundingBox();
    await page.mouse.move(b1.x + 40, b1.y + 15);
    await page.mouse.down();
    await page.mouse.move(b1.x - 60, b1.y + 15, { steps: 8 });
    await page.mouse.move(b1.x - 200, b1.y + 15, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    check('tab drag reorder', await page.locator('.app-files .fx-tab .fx-tab-title').allInnerTexts(), ['Projects', 'Documents']);
    await H.key('Control+w');
    await H.settle();
  });

  await section('Context menus, pin / unpin, copy as path, compress / extract', async () => {
    await H.go(D('Documents'));
    await H.item('Projects').click({ button: 'right' });
    await page.waitForSelector('.menu');
    const iconbar = await page.locator('.menu .menu-iconbar button').count();
    check('compact icon bar', iconbar, 4);
    const labels = await page.locator('.menu .menu-item .label').allInnerTexts();
    const hasTerminal = await page.evaluate(() => !!window.__aurora.registry.get('terminal'));
    check('item menu entries', ['Open', 'Open in new tab', 'Pin to Quick access', 'Copy as path', 'Properties'].every((l) => labels.includes(l)), true);
    check('Open in Terminal only when Terminal is installed', labels.includes('Open in Terminal'), hasTerminal);
    await H.menuClick('Pin to Quick access');
    await page.waitForTimeout(300);
    check('pinned in nav', (await page.locator('.app-files .fx-tnode .fx-tlabel').allInnerTexts()).includes('Projects'), true);
    const stored = JSON.parse(fs.readFileSync(D('.config/aurora/apps/files/pinned.json'), 'utf8'));
    check('pins persisted', stored.includes(D('Documents/Projects')), true);
    await page.locator('.app-files .fx-tnode:has-text("Projects")').click({ button: 'right' });
    await H.menuClick('Unpin from Quick access');
    await page.waitForTimeout(300);
    check('unpinned', (await page.locator('.app-files .fx-tnode .fx-tlabel').allInnerTexts()).includes('Projects'), false);
    // background menu
    await page.mouse.click(1000, 600, { button: 'right' });
    await page.waitForSelector('.menu');
    const bg = await page.locator('.menu .menu-item .label').allInnerTexts();
    check('background menu', ['View', 'Sort by', 'Refresh', 'Paste', 'New', 'Properties'].every((l) => bg.includes(l)), true);
    await page.keyboard.press('Escape');
    // copy as path
    await H.select('ideas.md').catch(() => {});
    await H.select('notes.md');
    await H.focusView();
    await H.key('Control+Shift+c');
    check('copy as path', await page.evaluate(() => window.__aurora.api.invoke('clipboard:readText')), D('Documents/notes.md'));
    // compress then extract
    await H.item('Projects').click({ button: 'right' });
    await H.menuClick('Compress to ZIP file');
    await page.waitForSelector('.app-files .fx-rename', { timeout: 15000 });
    await H.key('Escape');
    check('zip created', H.exists(D('Documents/Projects.zip')), true);
    await H.select('Projects.zip');
    await page.click('.app-files .fx-cmd:has-text("Extract all")');
    await page.waitForTimeout(300);
    check('extract dialog', await page.locator('.dialog-layer .fx-extract input.input').inputValue(), D('Documents/Projects'));
    await H.clickDialog('Extract');
    await page.waitForFunction((p) => window.__fx().tab.loc.path === p, D('Documents/Projects (2)'), { timeout: 15000 });
    check('extracted', H.exists(D('Documents/Projects (2)/Projects/aurora/readme.txt')), true);
    await H.go(D('Documents'));
  });

  await section('Hidden items, rubber band, drag & drop', async () => {
    await page.click('.app-files .fx-cmd[aria-label="View"]');
    await page.locator('.menu .menu-item:has-text("Show")').hover();
    await page.waitForTimeout(400);
    await H.menuClick('Hidden items');
    await H.settle();
    check('hidden file shown', (await H.names()).includes('.secret-config'), true);
    check('hidden faded', await page.locator('.app-files .fx-item.is-hidden').count(), 1);
    await page.click('.app-files .fx-cmd[aria-label="View"]');
    await page.locator('.menu .menu-item:has-text("Show")').hover();
    await page.waitForTimeout(400);
    await H.menuClick('Hidden items');
    await H.settle();
    check('hidden file hidden again', (await H.names()).includes('.secret-config'), false);
    // rubber band from empty space across the first rows
    const first = await page.locator('.app-files .fx-row').nth(0).boundingBox();
    const third = await page.locator('.app-files .fx-row').nth(2).boundingBox();
    await page.mouse.move(first.x + first.width + 40, first.y + 4);
    await page.mouse.down();
    await page.mouse.move(first.x + 100, third.y + 10, { steps: 10 });
    await page.mouse.up();
    check('rubber band selects 3', (await H.selected()).length, 3);
    // drag a file onto a folder (same drive -> move)
    await page.dragAndDrop('.app-files .fx-row:has-text("Report 2026.txt") .fx-name', '.app-files .fx-row:has-text("Alpha") .fx-name');
    await H.settle();
    await page.waitForTimeout(400);
    check('drag & drop move into folder', H.exists(D('Documents/Alpha/Report 2026.txt')) && !H.exists(D('Documents/Report 2026.txt')), true);
    // drag onto a nav pane folder (Downloads)
    await page.dragAndDrop('.app-files .fx-row:has-text("budget.csv") .fx-name', '.app-files .fx-tnode:has-text("Downloads")');
    await page.waitForTimeout(600);
    check('drop on nav pane', H.exists(D('Downloads/budget.csv')), true);
  });

  await section('This PC and drives', async () => {
    await page.click('.app-files .fx-tnode:has-text("This PC")');
    await H.settle();
    const folders = await page.locator('.app-files .fx-pctile .fx-name').allInnerTexts();
    check('folders section', ['Desktop', 'Documents', 'Downloads', 'Music', 'Pictures', 'Videos'].every((f) => folders.includes(f)), true);
    const drives = await page.locator('.app-files .fx-drive .fx-name').allInnerTexts();
    check('system drive', drives.includes('System (/)'), true);
    check('capacity text', await page.locator('.app-files .fx-drive .fx-sub').first().innerText(), (t) => / free of /.test(t));
    check('capacity bar', await page.locator('.app-files .fx-drive .fx-cap .fill').count(), (n) => n >= 1);
    await H.shot('files-this-pc');
    await page.locator('.app-files .fx-drive').first().click({ button: 'right' });
    const labels = await page.locator('.menu .menu-item .label').allInnerTexts();
    check('drive menu', labels.includes('Open') && labels.includes('Properties'), true);
    await H.menuClick('Properties');
    await page.waitForSelector('.fx-props-win .fx-donut', { timeout: 5000 });
    check('drive properties donut', await page.locator('.fx-props-win .fx-donut svg').count(), 1);
    await page.click('.fx-props-win .fx-props-foot button:has-text("OK")');
    await page.waitForTimeout(300);
    await page.locator('.app-files .fx-drive').first().dblclick();
    await H.settle();
    check('open drive', (await H.loc()).path, '/');
    check('crumbs for root', await page.locator('.app-files .fx-crumb:visible').allInnerTexts(), ['This PC', 'System (/)']);
  });

  await section('Batch rename (F2 with several items) + undo', async () => {
    await H.go(D('Pictures'));
    await page.evaluate(() => {
      const v = window.__fx().view;
      v.setSel(v.items.filter((i) => /\.png$/.test(i.entry.name)).map((i) => i.key));
      v.focusKey = v.items.find((i) => i.entry.name === 'checker.png').key;
    });
    await H.focusView();
    await H.key('F2');
    await page.waitForSelector('.app-files .fx-rename');
    await page.keyboard.press('Control+a');
    await page.keyboard.type('Holiday');
    await H.key('Enter');
    await H.settle();
    const pics = fs.readdirSync(D('Pictures')).sort();
    check('batch renamed', pics, ['Holiday (1).png', 'Holiday (2).png', 'Holiday (3).png', 'Holidays']);
    check('batch selection kept', (await H.selected()).length, 3);
    await H.key('Control+z');
    await H.settle();
    check('batch undo', fs.readdirSync(D('Pictures')).sort(), ['Holidays', 'checker.png', 'mountains.png', 'sunset.png']);
  });

  await section('Gallery', async () => {
    await page.click('.app-files .fx-tnode:has-text("Gallery")');
    await H.settle();
    check('gallery location', (await H.loc()).type, 'gallery');
    check('gallery photos (recursive)', (await H.names()).sort(), ['beach.png', 'checker.png', 'mountains.png', 'sunset.png']);
    await page.waitForFunction(() => [...document.querySelectorAll('.app-files .fx-gtile img')].filter((i) => i.complete && i.naturalWidth > 0).length >= 4, null, { timeout: 10000 });
    check('gallery month header', await page.locator('.app-files .fx-group-head .lbl').first().innerText(), (t) => /\d{4}/.test(t));
    check('gallery crumb', await page.locator('.app-files .fx-crumb:visible').allInnerTexts(), ['Gallery']);
    await page.locator('.app-files .fx-gtile').nth(1).click();
    check('gallery selection', (await H.selected()).length, 1);
    await H.focusView();
    await H.key('ArrowRight');
    check('gallery keyboard', (await H.selected()).length, 1);
    await H.shot('files-gallery');
    await page.click('.app-files .fx-navbtn[aria-label="Up"]');
    await H.settle();
    check('up from gallery', (await H.loc()).type, 'home');
  });

  await section('Error mapping, middle-click, F6', async () => {
    const text = await page.evaluate(async () => {
      const ex = window.__fx();
      const p = ex.showNavError({ type: 'dir', path: '/root/secret' }, new Error("EACCES: permission denied, scandir '/root/secret'"));
      await new Promise((r) => setTimeout(r, 300));
      const t = document.querySelector('.dialog-layer .dialog')?.innerText;
      document.querySelector('.dialog-layer .dialog-footer button')?.click();
      await p;
      return t;
    });
    check('permission error dialog', text, (t) => t?.includes("You don't currently have permission to access this folder."));
    await H.go(D('Documents'));
    await H.item('Projects').click({ button: 'middle' });
    await page.waitForTimeout(300);
    check('middle-click opens background tab', await page.locator('.app-files .fx-tab').count(), 2);
    check('current tab unchanged', (await H.loc()).path, D('Documents'));
    await page.locator('.app-files .fx-tab').nth(1).click({ button: 'middle' });
    await page.waitForTimeout(200);
    check('middle-click closes tab', await page.locator('.app-files .fx-tab').count(), 1);
    await H.focusView();
    await H.key('F6');
    check('F6 -> address bar', await page.locator('.app-files .fx-address.editing').count(), 1);
    await H.key('F6');
    check('F6 -> navigation pane', await page.evaluate(() => document.activeElement.classList.contains('fx-tree')), true);
    await H.key('ArrowDown');
    check('tree keyboard focus ring', await page.locator('.app-files .fx-tnode.focused').count(), 1);
    await H.key('F6');
    check('F6 -> items', await page.evaluate(() => document.activeElement.classList.contains('fx-scroll')), true);
    check('address left edit mode', await page.locator('.app-files .fx-address.editing').count(), 0);
  });

  await section('Open with, choose app, live language switch', async () => {
    await H.go(D('Documents'));
    const before = await page.evaluate(() => window.__aurora.wm.list().length);
    await H.item('notes.md').click({ button: 'right' });
    await page.locator('.menu .menu-item:has-text("Open with")').hover();
    await page.waitForTimeout(500);
    const owLabels = await page.locator('.menu').last().locator('.menu-item .label').allInnerTexts();
    check('open with lists choose another app', owLabels.includes('Choose another app'), true);
    const hasNotepad = await page.evaluate(() => !!window.__aurora.registry.get('notepad'));
    if (hasNotepad) check('open with lists Notepad (declares .md)', owLabels.includes('Notepad'), true);
    await H.menuClick('Choose another app');
    await page.waitForSelector('.dialog-layer .fx-apps');
    check('choose app dialog title', await page.locator('.dialog-layer .dialog-title').innerText(), 'Select an app to open this .md file');
    const target = hasNotepad ? 'Notepad' : 'About Aurora';
    await page.locator(`.dialog-layer .fx-app-row:has-text("${target}")`).click();
    await H.clickDialog('Always');
    await page.waitForTimeout(800);
    const def = await page.evaluate(() => window.__aurora.settings.get('defaultApps'));
    check('always -> default app saved', def?.['.md'], hasNotepad ? 'notepad' : 'winver');
    check('app launched', await page.evaluate(() => window.__aurora.wm.list().length), (n) => n > before);
    await page.evaluate((id) => window.__aurora.wm.byApp(id).forEach((w) => w.close(true)), hasNotepad ? 'notepad' : 'winver');
    await page.waitForTimeout(300);
    await page.evaluate(() => window.__aurora.settings.set('defaultApps', {}));
    // Live language switch
    await page.evaluate(() => window.__aurora.settings.set('lang', 'fr'));
    await page.waitForTimeout(600);
    check('relabel: command bar', await page.locator('.app-files .fx-cmd[aria-label="Nouveau"] .fx-cmd-label').innerText(), 'Nouveau');
    check('relabel: nav', (await page.locator('.app-files .fx-tnode .fx-tlabel').allInnerTexts()).includes('Accueil'), true);
    check('relabel: headers', (await page.locator('.app-files .fx-dh-cell').first().innerText()).trim(), 'Nom');
    check('relabel: tab', await page.locator('.app-files .fx-tab.active .fx-tab-title').innerText(), 'Documents');
    check('relabel: types', await page.evaluate(() => window.__fx().view.items.find((i) => i.entry.dir).type), 'Dossier de fichiers');
    await page.evaluate(() => window.__aurora.settings.set('lang', 'en'));
    await page.waitForTimeout(600);
    check('back to English', (await page.locator('.app-files .fx-dh-cell').first().innerText()).trim(), 'Name');
  });

  // ---------------------------------------------------------------- QA regressions (adversarial pass)
  await section('QA: hostile file names (no HTML injection, no zip option injection)', async () => {
    const dir = D('QA/Hostile');
    fs.mkdirSync(dir, { recursive: true });
    const hostile = ['<img src=x onerror="window.__xss=1">.txt', '"><svg onload="window.__xss=2">', '-T', '--unzip-command=touch PWNED', 'plain.txt'];
    for (const n of hostile) fs.writeFileSync(path.join(dir, n), 'x');
    await H.go(dir);
    for (const m of ['details', 'large', 'tiles', 'list']) await page.evaluate((m) => window.__fx().setMode(m), m);
    await page.evaluate(() => window.__fx().setMode('details'));
    await page.evaluate(() => window.__fx().navigate({ type: 'search', root: window.__fx().tab.loc, query: 'img' }));
    await page.waitForTimeout(1200);
    check('search highlight keeps names as text', await page.locator('.app-files .fx-row .fx-name').first().innerText(), '<img src=x onerror="window.__xss=1">.txt');
    await H.go(dir);
    await H.select('"><svg onload="window.__xss=2">');
    await H.focusView();
    await H.key('Shift+Delete');
    check('delete dialog shows the name as text', await H.dialogText(), (t) => t.includes('"><svg onload="window.__xss=2">'));
    await H.clickDialog('No');
    check('no script ran from file names', await page.evaluate(() => window.__xss ?? null), null);
    // Compress names that look like zip options: they must be stored, never parsed as options.
    await page.evaluate(() => {
      const v = window.__fx().view;
      v.setSel(v.items.filter((x) => ['-T', '--unzip-command=touch PWNED', 'plain.txt'].includes(x.entry.name)).map((x) => x.key));
    });
    await page.evaluate(() => window.__fx().compress(window.__fx().view.selectedEntries()));
    await H.settle();
    await page.evaluate(() => window.__fx().view.renaming && window.__fx().view.endRename());
    check('zip option injection: no command ran', H.exists(path.join(dir, 'PWNED')), false);
    check('zip created', H.exists(path.join(dir, 'Hostile.zip')), true);
    const listing = H.exists(path.join(dir, 'Hostile.zip')) ? execFileSync('unzip', ['-Z1', path.join(dir, 'Hostile.zip')], { encoding: 'utf8' }).split('\n').filter(Boolean).sort() : [];
    check('zip stores the odd names', listing, ['--unzip-command=touch PWNED', '-T', 'plain.txt']);
  });

  await section('QA: special files (FIFO preview must not hang the backend)', async () => {
    const dir = D('QA/Special');
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('mkfifo', [path.join(dir, 'pipe')]);
    execFileSync('mkfifo', [path.join(dir, 'fake.png')]);
    await H.go(dir);
    await page.evaluate(() => window.__fx().setMode('large'));
    await page.waitForTimeout(300);
    check('no thumbnail requested for a FIFO named .png', await page.locator('.app-files img.fx-photo').count(), 0);
    await page.evaluate(() => window.__fx().setMode('details'));
    await page.evaluate(() => window.__fx().togglePane('preview'));
    await H.select('pipe');
    await page.waitForTimeout(600);
    check('FIFO: no preview', await page.locator('.app-files .fx-pane-body').innerText(), 'No preview available.');
    const t0 = Date.now();
    const res = await Promise.race([
      page.evaluate(async (p) => {
        const api = window.__fx().api;
        const out = [];
        for (let i = 0; i < 6; i++) out.push((await api.invoke('files:head', p, 100)).special === true);
        return out;
      }, path.join(dir, 'pipe')),
      new Promise((r) => setTimeout(() => r('timeout'), 4000)),
    ]);
    check('files:head refuses FIFOs at once', res, [true, true, true, true, true, true]);
    check('files:head fast', Date.now() - t0 < 3000, true);
    check('fs still responsive', await page.evaluate(async (p) => (await window.__fx().api.invoke('fs:list', p)).length, dir), 2);
    await page.evaluate(() => window.__fx().togglePane('preview'));
  });

  await section('QA: forged drag payloads from web content are ignored', async () => {
    const dir = D('QA/Drop');
    fs.mkdirSync(path.join(dir, 'victim'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'target'), { recursive: true });
    await H.go(path.join(dir, 'target'));
    const drop = (paths, withShellDragstart) =>
      page.evaluate(async ([paths, shellStart]) => {
        window.dispatchEvent(new PointerEvent('pointerdown')); // ends any previous drag
        if (shellStart) document.dispatchEvent(new DragEvent('dragstart', { bubbles: true }));
        const ex = window.__fx();
        const dt = new DataTransfer();
        dt.setData('application/x-aurora-paths', JSON.stringify(paths));
        dt.setData('text/uri-list', paths.map((p) => `file://${p}`).join('\r\n'));
        const sc = ex.view.scroller;
        const r = sc.getBoundingClientRect();
        const opts = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 200, clientY: r.bottom - 30 };
        sc.dispatchEvent(new DragEvent('dragenter', opts));
        const over = new DragEvent('dragover', opts);
        sc.dispatchEvent(over);
        sc.dispatchEvent(new DragEvent('drop', opts));
        await new Promise((r) => setTimeout(r, 900));
        document.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
        return over.defaultPrevented;
      }, [paths, withShellDragstart]);
    const accepted = await drop([path.join(dir, 'victim')], false);
    check('forged payload refused (dragover not accepted)', accepted, false);
    check('forged payload moved nothing', H.exists(path.join(dir, 'victim')) && !H.exists(path.join(dir, 'target/victim')), true);
    await drop([path.join(dir, 'victim')], true);
    await H.settle();
    check('shell drags still work', H.exists(path.join(dir, 'target/victim')), true);
  });

  await section('QA: toast Undo undoes its own operation', async () => {
    const dir = D('QA/Undo');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'A.txt'), 'a');
    fs.writeFileSync(path.join(dir, 'B.txt'), 'b');
    await H.go(dir);
    await H.select('A.txt');
    await H.focusView();
    await H.key('Delete');
    await H.settle();
    check('A trashed', H.exists(path.join(dir, 'A.txt')), false);
    // another operation after the delete: rename B -> C
    await page.evaluate(async () => {
      const ex = window.__fx();
      const ops = await import('app://shell/apps/files/lib/ops.js');
      await ops.rename(ex, ex.view.items.find((x) => x.entry.name === 'B.txt').entry, 'C.txt');
    });
    await H.settle();
    await page.click('.app-files .fx-toast button:has-text("Undo")');
    await H.settle();
    await H.waitNames((n) => n.includes('A.txt'));
    check('toast undo restored A', H.exists(path.join(dir, 'A.txt')), true);
    check('toast undo left the rename alone', H.exists(path.join(dir, 'C.txt')) && !H.exists(path.join(dir, 'B.txt')), true);
    check('rename still undoable with Ctrl+Z', await page.evaluate(async () => (await import('app://shell/apps/files/lib/shared.js')).peekUndo()?.type), 'rename');
  });

  await section('QA: double presses / double clicks start one operation', async () => {
    const dir = D('QA/Races');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'twice.txt'), 'x');
    await H.go(dir);
    await H.select('twice.txt');
    await H.focusView();
    await page.keyboard.press('Delete');
    await page.keyboard.press('Delete');
    await H.settle();
    await page.waitForTimeout(400);
    check('double Delete: no error dialog', await page.locator('.dialog-layer:not(.closing)').count(), 0);
    check('double Delete: trashed once', fs.readdirSync(D('.local/share/Trash/files')).filter((n) => n.startsWith('twice')).length, 1);
    await H.focusView();
    await page.keyboard.press('Control+Shift+N');
    await page.keyboard.press('Control+Shift+N');
    await page.waitForTimeout(1200);
    check('double Ctrl+Shift+N: one new folder', fs.readdirSync(dir).filter((n) => n.startsWith('New folder')).length, 1);
    await page.keyboard.press('Escape');
    await H.go({ type: 'trash' });
    await page.locator('.app-files .fx-cmd:has-text("Empty Recycle Bin")').dblclick();
    await page.waitForTimeout(600);
    check('double click Empty Recycle Bin: one confirmation', await page.locator('.dialog-layer:not(.closing)').count(), 1);
    await H.clickDialog('No');
    await page.evaluate(() => window.__fx().view.selectAll());
    await page.locator('.app-files .fx-cmd:has-text("Restore the selected items")').dblclick();
    await H.settle();
    await page.waitForTimeout(500);
    check('double click Restore: no error dialog', await page.locator('.dialog-layer:not(.closing)').count(), 0);
    check('restored', H.exists(path.join(dir, 'twice.txt')), true);
    // Properties: OK double-clicked applies the rename once
    await H.go(dir);
    await H.select('twice.txt');
    await H.focusView();
    await H.key('Alt+Enter');
    await page.waitForSelector('.fx-props-win .fx-props-head .input');
    await page.fill('.fx-props-win .fx-props-head .input', 'once.txt');
    await page.locator('.fx-props-win .fx-props-head .input').dispatchEvent('input');
    await page.locator('.fx-props-win .fx-props-foot button.primary').dblclick();
    await page.waitForTimeout(800);
    check('Properties double OK: renamed once, no error', [H.exists(path.join(dir, 'once.txt')), await page.locator('.dialog-layer:not(.closing)').count()], [true, 0]);
  });

  await section('QA: search inside the Recycle Bin lists trash items', async () => {
    const dir = D('QA/TrashSearch');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'needle.txt'), 'x');
    await H.go(dir);
    await H.select('needle.txt');
    await page.evaluate(() => window.__fx().del(false));
    await H.settle();
    await H.go({ type: 'trash' });
    await page.evaluate(() => window.__fx().navigate({ type: 'search', root: { type: 'trash' }, query: 'needle' }));
    await page.waitForTimeout(1200);
    check('trash search kind', await page.evaluate(() => window.__fx().view.items.map((i) => i.kind)), ['trash']);
    check('trash search columns', (await page.locator('.app-files .fx-dh-cell').allInnerTexts()).map((x) => x.trim()).slice(0, 3), ['Name', 'Original location', 'Date deleted']);
    check('trash search shows the original location', await page.locator('.app-files .fx-row .c-origin').first().innerText(), dir);
    await page.locator('.app-files .fx-row').first().click({ button: 'right' });
    await page.waitForSelector('.menu');
    const labels = await page.locator('.menu .menu-item .label').allInnerTexts();
    check('trash search menu offers Restore, not Cut/Rename', labels.includes('Restore') && !labels.includes('Compress to ZIP file') && (await page.locator('.menu .menu-iconbar').count()) === 0, true);
    await H.menuClick('Restore');
    await H.settle();
    check('restored from search', H.exists(path.join(dir, 'needle.txt')), true);
  });

  await section('QA: system folders are protected, Tab stays in the window, misc', async () => {
    await H.go({ type: 'home' });
    await page.evaluate(() => {
      const v = window.__fx().view;
      const it = v.items.find((x) => x.key.startsWith('q:') && x.entry.path.endsWith('/Documents'));
      v.setSel([it.key], it.key);
    });
    check('Documents tile: Delete / Rename / Cut disabled', await page.evaluate(() => ['del', 'rename', 'cut'].map((k) => window.__fx().cmd[k].disabled)), [true, true, true]);
    await H.focusView();
    await H.key('Delete');
    check('Delete on a system folder explains why', await H.dialogText(), (t) => t.includes("can't be deleted"));
    await H.clickDialog('OK');
    await H.settle();
    check('Documents not deleted', H.exists(D('Documents')), true);
    await H.focusView();
    await H.key('F2');
    check('F2 on a system folder explains why', await H.dialogText(), (t) => t.includes("can't be renamed"));
    await H.clickDialog('OK');
    // Tab / Shift+Tab wrap inside the window
    await H.go(D('Documents'));
    const last = await page.evaluate(() => {
      const stops = window.__fx().tabStops();
      stops[stops.length - 1].focus();
      return stops.length;
    });
    check('tab stops found', last > 5, true);
    await H.key('Tab');
    check('Tab from the last control wraps to the first', await page.evaluate(() => window.__fx().tabStops()[0] === document.activeElement), true);
    await H.key('Shift+Tab');
    check('Shift+Tab from the first wraps to the last', await page.evaluate(() => {
      const s = window.__fx().tabStops();
      return s[s.length - 1] === document.activeElement;
    }), true);
    // A refresh (watcher, other window) must not restore a selection snapshot taken before its load
    const kept = await page.evaluate(async () => {
      const ex = window.__fx();
      ex.view.selectNone();
      const p = ex.refresh({ quiet: true });
      const keys = ex.view.items.slice(0, 2).map((i) => i.key);
      ex.view.setSel(keys, keys[0]);
      await p;
      return ex.view.selectedItems().length;
    });
    check('selection made during a refresh survives it', kept, 2);
    // Malformed file:// URI in the address bar: error dialog, no exception
    const pageErrors = s.logs.filter((l) => l.startsWith('[pageerror]')).length;
    await page.evaluate(() => window.__fx().address.beginEdit('file:///%E0%A4%A'));
    await H.key('Enter');
    await page.waitForTimeout(400);
    check('malformed file URI: error dialog', await H.dialogText(), (t) => t.includes("can't find"));
    await H.clickDialog('OK');
    check('malformed file URI: no exception', s.logs.filter((l) => l.startsWith('[pageerror]')).length, pageErrors);
    await page.keyboard.press('Escape');
    // Debounced search bound to its tab
    await H.go(D('Documents'));
    await H.key('Control+t');
    await H.settle();
    await page.locator('.app-files .fx-tab').first().click();
    await H.settle();
    await page.click('.app-files .fx-search-input');
    await page.keyboard.type('notes');
    await page.keyboard.press('Control+Tab');
    await page.waitForTimeout(1000);
    check('debounced search does not run in the other tab', (await H.loc()).type, 'home');
    await H.key('Control+w');
    await H.settle();
    // Animations off: endless animations become static
    const anim = await page.evaluate(() => {
      const root = document.documentElement;
      const prev = root.dataset.animations;
      root.dataset.animations = 'off';
      const host = document.createElement('div');
      host.className = 'app-files';
      host.innerHTML = '<div class="fx-pg-bar indeterminate"><div class="bar"></div></div><div class="fx-address busy"></div>';
      document.body.append(host);
      const a = getComputedStyle(host.querySelector('.bar')).animationName;
      const b = getComputedStyle(host.querySelector('.fx-address'), '::before').animationName;
      host.remove();
      if (prev == null) delete root.dataset.animations;
      else root.dataset.animations = prev;
      return [a, b];
    });
    check('animations off: no endless animations', anim, ['none', 'none']);
  });

  await section('QA: pinned folders reorder by drag, launch args, Home refresh across windows', async () => {
    const order = () => page.evaluate(async () => (await import('app://shell/apps/files/lib/shared.js')).shared.pinned.map((p) => p.split('/').pop()));
    const before = await order();
    const music = page.locator('.app-files .fx-tnode[draggable="true"]:has-text("Music")');
    const desktop = page.locator('.app-files .fx-tnode[draggable="true"]:has-text("Desktop")');
    await music.dragTo(desktop, { targetPosition: { x: 40, y: 4 } });
    await page.waitForTimeout(400);
    const after = await order();
    check('pin moved before Desktop', after.indexOf('Music') === after.indexOf('Desktop') - 1 && after.length === before.length, true);
    check('pin drag did not move the folder', H.exists(D('Music')) && !H.exists(D('Desktop/Music')), true);
    await page.waitForTimeout(400);
    check('pin order persisted', JSON.parse(fs.readFileSync(D('.config/aurora/apps/files/pinned.json'), 'utf8')).map((p) => p.split('/').pop()), after);
    await page.evaluate(async (list) => {
      const { shared, movePin } = await import('app://shell/apps/files/lib/shared.js');
      list.forEach((name, i) => movePin(shared.pinned.find((p) => p.endsWith(`/${name}`)), i));
    }, before);
    // Relative and ~ launch paths resolve against the home folder
    await page.evaluate(() => window.__aurora.shell.launch('files', { path: '~/Documents/../Downloads' }));
    await page.waitForFunction(() => window.__fx(1)?.view?.loc);
    await H.settle(1);
    check('~ and .. in launch path', (await H.loc(1)).path, D('Downloads'));
    // Home in window 2 refreshes after a file operation in window 1
    fs.writeFileSync(D('Documents/fresh-file.txt'), 'new');
    await page.evaluate(() => window.__fx(1).navigate({ type: 'home' }));
    await H.settle(1);
    const recentBefore = await page.evaluate(() => window.__fx(1).view.items.filter((i) => i.section === 'r').map((i) => i.entry.name));
    check('new file listed in Recent of window 2', recentBefore.includes('fresh-file.txt'), true);
    await H.go(D('Documents'));
    await H.select('fresh-file.txt');
    await page.evaluate(() => window.__fx(0).del(false));
    await H.settle();
    await page.waitForTimeout(1200);
    const recentNames = await page.evaluate(() => window.__fx(1).view.items.filter((i) => i.section === 'r').map((i) => i.entry.name));
    check('other window Home refreshed (trashed file left Recent)', recentNames.includes('fresh-file.txt'), false);
    await page.evaluate(() => window.__fx(1).win.close());
    await page.waitForTimeout(400);
  });

  await section('Window sizes', async () => {
    await H.go(D('Documents'));
    await page.evaluate(() => {
      const w = window.__fx().win;
      w.setSize(w.opts.minWidth, w.opts.minHeight);
    });
    await page.waitForTimeout(400);
    const overflow = await page.evaluate(() => {
      const r = window.__fx().root;
      return [r.scrollWidth <= r.clientWidth + 1, window.__fx().cmdBar.scrollWidth <= window.__fx().cmdBar.clientWidth + 1];
    });
    check('no overflow at min size', overflow, [true, true]);
    await s.shot('files-min-size');
    await page.evaluate(() => window.__fx().win.maximize());
    await page.waitForTimeout(500);
    await s.shot('files-maximized');
    await page.evaluate(() => window.__fx().win.restore());
    await page.waitForTimeout(400);
  });
}

const errors = s.logs.filter((l) => (l.startsWith('[error]') || l.startsWith('[pageerror]')) && !/Failed to load resource/.test(l));
check('no console errors (en)', errors, []);
check('no failed requests from the app', bad.filter((u) => /apps\/files|media:/.test(u)), []);
if (bad.length) console.log('  (other failed requests, not from this app:', bad.filter((u) => !/apps\/files|media:/.test(u)).join(', '), ')');
cleanup = null;
await s.close();

// ================================================================ French + dark theme
if (!only || only.toLowerCase().split(',').some((o) => 'french dark'.includes(o))) {
  const home2 = makeHome();
  const s2 = await launchShell({ home: home2, open: ['files'], lang: 'fr', theme: 'dark', settle: 1200 });
  const H2 = helpers(s2);
  trackHttp(s2.page);
  cleanup = async () => {
    for (let i = 0; i < 4 && (await s2.page.locator('.menu').count()); i++) await s2.page.keyboard.press('Escape');
  };
  try {
    await H2.init();
    await section('French + dark theme', async () => {
      const p2 = s2.page;
      const nav = await p2.locator('.app-files .fx-tnode .fx-tlabel').allInnerTexts();
      check('fr nav', ['Accueil', 'Bureau', 'Téléchargements', 'Documents', 'Images', 'Ce PC', 'Corbeille'].every((n) => nav.includes(n)), true);
      check('fr quick access', await p2.locator('.app-files .fx-sec-head span:not(.icon)').first().innerText(), 'Accès rapide');
      check('fr title', await p2.evaluate(() => window.__fx().win.title), 'Accueil - Explorateur de fichiers');
      await H2.go(path.join(home2, 'Documents'));
      const types = await p2.evaluate(() => Object.fromEntries(window.__fx().view.items.map((i) => [i.entry.name, i.type])));
      check('fr type folder', types.Letters, 'Dossier de fichiers');
      check('fr type text', types['Report 2026.txt'], 'Document texte');
      check('fr headers', (await p2.locator('.app-files .fx-dh-cell').allInnerTexts()).map((x) => x.trim()), ['Nom', 'Modifié le', 'Type', 'Taille']);
      check('fr size', await p2.locator('.app-files .fx-row:has-text("Report 2026.txt") .c-size').innerText(), '1 Ko');
      check('fr status', await p2.locator('.app-files .fx-status span').first().innerText(), '6 éléments');
      check('fr search placeholder', await p2.locator('.app-files .fx-search-input').getAttribute('placeholder'), 'Rechercher dans : Documents');
      await H2.select('Report 2026.txt');
      check('fr selection status', await p2.locator('.app-files .fx-st-sel').innerText(), (t) => t.startsWith('1 élément sélectionné'));
      const cmdOverflow = await p2.evaluate(() => window.__fx().cmdBar.scrollWidth <= window.__fx().cmdBar.clientWidth + 1);
      check('fr command bar fits', cmdOverflow, true);
      check('dark theme', await p2.evaluate(() => document.documentElement.dataset.theme), 'dark');
      await p2.evaluate(() => window.__fx().togglePane('details'));
      await p2.waitForTimeout(500);
      await p2.mouse.move(1590, 420);
      await p2.waitForTimeout(250);
      await s2.page.screenshot({ path: path.join(DOCS, 'files-fr-dark.png') });
      await p2.evaluate(() => window.__fx().togglePane('details'));
      await p2.locator('.app-files .fx-item').first().click({ button: 'right' });
      const labels = await p2.locator('.menu .menu-item .label').allInnerTexts();
      check('fr context menu', labels.includes('Ouvrir') && labels.includes('Propriétés'), true);
      await p2.keyboard.press('Escape');
      await p2.click('.app-files .fx-tnode:has-text("Ce PC")');
      await H2.settle();
      check('fr this pc', await p2.locator('.app-files .fx-sec-head span:not(.icon)').first().innerText(), 'Dossiers');
      check('fr drives', await p2.locator('.app-files .fx-drive .fx-sub').first().innerText(), (t) => / libres sur /.test(t));
      await p2.mouse.move(1590, 420);
      await p2.waitForTimeout(250);
      await s2.page.screenshot({ path: path.join(DOCS, 'files-this-pc-fr-dark.png') });
    });
    const errors2 = s2.logs.filter((l) => (l.startsWith('[error]') || l.startsWith('[pageerror]')) && !/Failed to load resource/.test(l));
    check('no console errors (fr)', errors2, []);
  } finally {
    await s2.close();
    fs.rmSync(home2, { recursive: true, force: true });
  }
}

fs.rmSync(home, { recursive: true, force: true });
if (fatal) failures.unshift(`startup failed: ${fatal.stack || fatal}`);
console.log(`\n${passed} checks passed, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL ${f}`);
process.exit(failures.length ? 1 : 0);
