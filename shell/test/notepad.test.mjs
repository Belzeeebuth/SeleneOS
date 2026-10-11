// Notepad tests — drives the real Electron shell with Playwright (keyboard, mouse, dialogs, files).
//   Typing + status bar, undo/redo (incl. replace all), tab key, Time/Date, find/replace (match case,
//   whole word, wrap around, counts, replace all), go to line, word wrap, zoom (keys, wheel, menu),
//   status bar toggle, open/save roundtrips (CRLF, BOM, ANSI fallback, UTF-16), Save as (+ .txt),
//   recent files, relaunch with {file} (new tab, no duplicate, new window), tabs (context menu,
//   middle click, drag reorder, Ctrl+Tab), unsaved prompts (tab + window list), external changes,
//   big file guard, drag & drop, menu bar keyboard access, French + dark theme, app theme override,
//   session restore, minimum and maximized sizes — and checks for console errors.
//   QA regressions: one prompt for repeated close / save / open / exit requests, devices and pipes
//   refused, relative paths refused, file:// URLs, minimised window raised for its prompt, keyboard
//   context menu, French key names in shortcuts, screen-level dialogs in small windows (placed over
//   the window, app theme kept), themed tooltips, narrow notice / find status layout, corrupted
//   storage, open/close x15 leak check.
//   Documentation screenshots: aurora-os/docs/screenshots/notepad-*.png
// Usage:  cd aurora-os/shell && xvfb-run -a -s "-screen 0 1600x900x24" node test/notepad.test.mjs [--only=find]
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { launchShell, ROOT } from './lib.mjs';

const DOCS = path.join(ROOT, '..', 'docs', 'screenshots');
fs.mkdirSync(DOCS, { recursive: true });
const only = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7).toLowerCase();

let passed = 0;
const failures = [];
function check(name, actual, expected) {
  const ok = typeof expected === 'function' ? !!expected(actual) : Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else failures.push(`${name}\n      expected: ${typeof expected === 'function' ? '(predicate)' : JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
  return ok;
}
async function section(name, fn) {
  if (only && !name.toLowerCase().includes(only)) return;
  const t0 = Date.now();
  const before = failures.length;
  try {
    await fn();
    console.log(`  ${failures.length === before ? '✓' : '✗'} ${name} (${Date.now() - t0} ms)`);
  } catch (err) {
    failures.push(`${name}: threw ${err?.stack || err}`);
    console.log(`  ✗ ${name}: ${err?.message || err}`);
  }
  await recover?.();
}
// After a failed section: close leftover menus and dialogs so the next section starts clean.
let recover = null;
function setRecover(s) {
  recover = async () => {
    for (let i = 0; i < 6; i++) {
      const busy = await s.page.evaluate(`!!document.querySelector('.np-menu, .win.app-notepad > .dialog-layer:not(.closing), #overlays > .dialog-layer:not(.closing)')`).catch(() => false);
      if (!busy) break;
      await s.page.keyboard.press('Escape').catch(() => {});
      await sleep(250);
    }
  };
}

// ---------------------------------------------------------------- helpers
const WIN = '.win.app-notepad';
const FP = `${WIN} > .dialog-layer:not(.closing) .dialog`; // the open (not closing) dialog
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Evaluate fn(np, el, arg) in the shell for the last (or index-th) Notepad window.
// Built as an expression string: the shell's CSP forbids eval/new Function inside the page.
function NP(s, fn, arg, index = -1) {
  const expr = `(() => { const all = [...document.querySelectorAll(${JSON.stringify(WIN)})]; const el = all.at(${index}); return (${fn.toString()})(el && el.__notepad, el, ${JSON.stringify(arg ?? null)}); })()`;
  return s.page.evaluate(expr);
}
const run = (s, expr) => s.page.evaluate(expr);
async function until(fn, { timeout = 5000, step = 50, label = 'condition' } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = await fn();
    if (last) return last;
    await sleep(step);
  }
  throw new Error(`timed out waiting for ${label} (last: ${JSON.stringify(last)})`);
}
const text = (s) => NP(s, (np) => np.active.text);
const status = (s) => NP(s, (np) => ({ pos: np.st.pos.textContent, chars: np.st.chars.textContent, zoom: np.st.zoom.textContent, eol: np.st.eol.textContent, enc: np.st.enc.textContent }));
const tabs = (s, index = -1) => NP(s, (np) => np.docs.map((d) => ({ title: d.title, dirty: d.dirty, active: d === np.active, path: d.path })), null, index);
const winCount = (s) => run(s, `document.querySelectorAll(${JSON.stringify(WIN)}).length`);
// Notepad's dialogs are window-modal, or screen-level (#overlays) when the window is too small for them.
const LAYER = `:is(${WIN}, #overlays) > .dialog-layer:not(.closing)`;
const dialogOpen = (s) => run(s, `!!document.querySelector('${LAYER}')`);
const dialogCount = (s) => run(s, `document.querySelectorAll('${LAYER}').length`);
const dialogText = (s) => run(s, `(document.querySelector('${LAYER} .dialog-body')||{}).innerText || ''`);
async function dialogButton(s, label) {
  await until(() => dialogOpen(s), { label: 'dialog' });
  const btn = s.page.locator(`${LAYER} .dialog-footer .btn`, { hasText: label }).first();
  await btn.click();
  await sleep(220);
}
// The file picker focuses its path box, then its name box, a few ms after opening: wait for that.
async function pickerReady(s) {
  await until(() => run(s, `!!document.querySelector('${FP}.fp-dialog')`), { label: 'file picker', timeout: 8000 });
  await until(() => run(s, `!!document.activeElement?.matches('${FP} .fp-bottom input')`), { label: 'picker name box focused', timeout: 8000 });
  await sleep(60);
}
async function focusEditor(s) {
  await NP(s, (np) => np.active.focus());
  await sleep(30);
}
async function setText(s, value, caret = 0) {
  // Replace the whole document (one undo step) and put the caret somewhere.
  await NP(s, (np, el, a) => {
    const d = np.active;
    d.replaceRange(0, d.text.length, a.value);
    d.ta.setSelectionRange(a.caret, a.caret);
    d.focus();
    np.updateStatus();
  }, { value, caret });
}
const sel = (s) => NP(s, (np) => [np.active.ta.selectionStart, np.active.ta.selectionEnd]);
const prefsFile = (home) => path.join(home, '.config', 'aurora', 'apps', 'notepad', 'prefs.json');
const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};
async function shot(s, name, clipToWindow = false) {
  await sleep(300); // let open animations (dialogs, menus) settle
  const file = path.join(DOCS, `notepad-${name}.png`);
  if (clipToWindow) {
    const r = await run(s, `(() => { const r = [...document.querySelectorAll('${WIN}')].pop().getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
    await s.page.screenshot({ path: file, clip: { x: Math.max(0, r.x - 24), y: Math.max(0, r.y - 24), width: Math.min(1600, r.width + 48), height: Math.min(900, r.height + 48) } });
  } else await s.page.screenshot({ path: file });
  return file;
}
async function openNotepad(s, args) {
  const n = await winCount(s);
  await run(s, `window.__aurora.shell.launch('notepad', ${JSON.stringify(args || {})}); 0`);
  await until(async () => (await winCount(s)) > n || (args?.file && (await NP(s, (np, el, f) => !!np?.docs.some((d) => d.path === f), args.file))), { label: 'notepad window', timeout: 8000 });
  await until(() => NP(s, (np) => !!np?.active), { label: 'active document' });
  await sleep(250);
}
let browserErrorsFrom = 0;
function errorsSince(s, mark) {
  return s.logs.slice(mark).filter((l) => /^\[(error|pageerror)\]/.test(l) && !/status of 404/.test(l) && !/\[browser\]|net::ERR_|webview/i.test(l));
}

// ---------------------------------------------------------------- fixtures
function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-np-'));
  for (const d of ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Music', 'Videos']) fs.mkdirSync(path.join(home, d), { recursive: true });
  const docs = path.join(home, 'Documents');
  fs.writeFileSync(path.join(docs, 'crlf.txt'), 'first line\r\nsecond line\r\nthird line\r\n');
  fs.writeFileSync(path.join(docs, 'bom.txt'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Ça va? Ünïcödé ✓\n', 'utf8')]));
  fs.writeFileSync(path.join(docs, 'latin1.txt'), Buffer.from([0x43, 0x61, 0x66, 0xe9, 0x20, 0x63, 0x72, 0xe8, 0x6d, 0x65, 0x0a])); // "Café crème\n" in Latin-1
  const u16 = Buffer.from('UTF-16 text: ñ €\r\n', 'utf16le');
  fs.writeFileSync(path.join(docs, 'utf16.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), u16]));
  fs.writeFileSync(path.join(docs, 'mac.txt'), 'old\rmac\rfile');
  fs.writeFileSync(path.join(docs, 'notes.md'), '# Notes\n\n- one\n- two\n');
  fs.writeFileSync(path.join(docs, 'config.json'), '{\n  "name": "aurora",\n  "tabs": true\n}\n');
  fs.writeFileSync(path.join(docs, 'external.txt'), 'version 1\n');
  const lines = [];
  for (let i = 1; i <= 200; i++) lines.push(`Line ${i}: ${'lorem ipsum '.repeat((i % 7) + 1)}`);
  fs.writeFileSync(path.join(docs, 'long.txt'), `${lines.join('\n')}\n`);
  return home;
}

const SAMPLE = 'The quick brown fox jumps over the lazy dog.\nA fox is quick; foxes are quicker.\nFOX in capitals. Firefox is a fox too.\n';

// ================================================================== main run (English, light)
async function mainRun() {
  const home = makeHome();
  const docs = path.join(home, 'Documents');
  const s = await launchShell({ theme: 'light', lang: 'en', home });
  setRecover(s);
  const mark = s.logs.length;
  try {
    await openNotepad(s);

    await section('opens with an Untitled tab, tall title bar and menu bar', async () => {
      check('one window', await winCount(s), 1);
      check('window title', await run(s, `window.__aurora.wm.byApp('notepad')[0].title`), 'Untitled - Text Editor');
      check('tab title', (await tabs(s))[0].title, 'Untitled');
      check('tall title bar', await run(s, `document.querySelector('${WIN}').classList.contains('tb-tall')`), true);
      check('tabs live in the title bar', await run(s, `!!document.querySelector('${WIN} .win-titlebar .np-tabs .np-tab')`), true);
      check('menus', await run(s, `[...document.querySelectorAll('${WIN} .np-menu-btn .np-menu-label')].map((b) => b.textContent)`), ['File', 'Edit', 'View']);
      check('status bar', await status(s), { pos: 'Ln 1, Col 1', chars: '0 characters', zoom: '100%', eol: 'Unix (LF)', enc: 'UTF-8' });
      check('editor focused', await run(s, `document.activeElement?.classList.contains('np-text')`), true);
    });

    await section('typing, dirty state and status bar', async () => {
      await focusEditor(s);
      await s.page.keyboard.type('Hello world');
      await s.page.keyboard.press('Enter');
      await s.page.keyboard.type('Second line');
      await sleep(120);
      check('text', await text(s), 'Hello world\nSecond line');
      check('position', (await status(s)).pos, 'Ln 2, Col 12');
      check('chars', (await status(s)).chars, '23 characters');
      check('dirty tab', (await tabs(s))[0].dirty, true);
      check('dirty dot shown', await run(s, `document.querySelector('${WIN} .np-tab.active').classList.contains('dirty')`), true);
      check('title has *', await run(s, `window.__aurora.wm.byApp('notepad')[0].title`), '*Untitled - Text Editor');
      await s.page.keyboard.down('Shift');
      await s.page.keyboard.press('Home');
      await s.page.keyboard.up('Shift');
      await sleep(80);
      check('selection count', (await status(s)).chars, '11 of 23 characters');
      check('caret at selection start (backward)', (await status(s)).pos, 'Ln 2, Col 1');
    });

    await section('undo / redo, tab key, Time/Date', async () => {
      await setText(s, '', 0);
      await NP(s, (np) => np.active.history.clear());
      await focusEditor(s);
      await s.page.keyboard.type('alpha beta gamma');
      await s.page.keyboard.press('Control+z');
      check('undo removes last word', await text(s), 'alpha beta ');
      await s.page.keyboard.press('Control+z');
      await s.page.keyboard.press('Control+z');
      check('undo to empty', await text(s), '');
      await s.page.keyboard.press('Control+y');
      check('redo word', await text(s), 'alpha ');
      await s.page.keyboard.press('Control+Shift+z');
      await s.page.keyboard.press('Control+y');
      check('redo all', await text(s), 'alpha beta gamma');
      await s.page.keyboard.press('End');
      await s.page.keyboard.press('Backspace');
      await s.page.keyboard.press('Backspace');
      check('backspace', await text(s), 'alpha beta gam');
      await s.page.keyboard.press('Control+z');
      check('backspaces undone in one step', await text(s), 'alpha beta gamma');
      await s.page.keyboard.press('Home');
      await s.page.keyboard.press('Tab');
      check('tab inserts a tab', await text(s), '\talpha beta gamma');
      check('focus stays in editor', await run(s, `document.activeElement?.classList.contains('np-text')`), true);
      await s.page.keyboard.press('End');
      await s.page.keyboard.press('Enter');
      await s.page.keyboard.press('F5');
      const t = await text(s);
      check('F5 inserts time and date', t.split('\n')[1], (v) => /^\d{1,2}:\d{2}\s?(AM|PM)\s\d{1,2}\/\d{1,2}\/\d{4}$/.test(v));
      await s.page.keyboard.press('Control+z');
      check('Time/Date undoable', await text(s), '\talpha beta gamma\n');
      // Edit menu: Select all + Delete, then undo through the menu.
      await s.page.click(`${WIN} .np-menu-btn[data-menu="edit"]`);
      await s.page.locator('.np-menu .menu-item', { hasText: 'Select all' }).click();
      await s.page.click(`${WIN} .np-menu-btn[data-menu="edit"]`);
      await s.page.locator('.np-menu .menu-item', { hasText: 'Delete' }).click();
      check('menu delete', await text(s), '');
      await s.page.click(`${WIN} .np-menu-btn[data-menu="edit"]`);
      await s.page.locator('.np-menu .menu-item', { hasText: 'Undo' }).click();
      check('menu undo', await text(s), '\talpha beta gamma\n');
    });

    await section('cut / copy / paste through the clipboard', async () => {
      await setText(s, 'copy me please', 0);
      await NP(s, (np) => np.active.ta.setSelectionRange(0, 7));
      await NP(s, (np) => np.copy());
      await sleep(100);
      check('clipboard after copy', await run(s, `window.__aurora.api.invoke('clipboard:readText')`), 'copy me');
      await NP(s, (np) => np.cut());
      await sleep(100);
      check('cut removes text', await text(s), ' please');
      await NP(s, (np) => np.active.ta.setSelectionRange(7, 7));
      await NP(s, (np) => np.paste());
      await sleep(120);
      check('paste at end', await text(s), ' pleasecopy me');
      await s.page.keyboard.press('Control+z');
      check('paste undo', await text(s), ' please');
    });

    await section('find: counts, match case, whole word, wrap around', async () => {
      await setText(s, SAMPLE, 0);
      await s.page.keyboard.press('Control+f');
      await sleep(100);
      check('find bar open', await run(s, `!document.querySelector('${WIN} .np-find').hidden`), true);
      check('find input focused', await run(s, `document.activeElement?.classList.contains('np-find-input')`), true);
      check('replace row hidden', await run(s, `document.querySelector('${WIN} .np-find-row2').hidden`), true);
      await s.page.keyboard.type('fox');
      await sleep(150);
      check('count (case-insensitive)', await run(s, `document.querySelector('${WIN} .np-find-count').textContent`), '1 of 6');
      check('first match selected', await sel(s), [16, 19]);
      check('highlights drawn', await run(s, `document.querySelectorAll('${WIN} .np-hl mark.np-m').length`), 6);
      check('current highlight', await run(s, `document.querySelectorAll('${WIN} .np-hl mark.np-m.cur').length`), 1);
      await s.page.keyboard.press('Enter');
      check('enter = next', await run(s, `document.querySelector('${WIN} .np-find-count').textContent`), '2 of 6');
      await s.page.keyboard.press('Shift+Enter');
      check('shift+enter = previous', await run(s, `document.querySelector('${WIN} .np-find-count').textContent`), '1 of 6');
      await s.page.keyboard.press('Shift+Enter');
      check('wraps to last', await run(s, `document.querySelector('${WIN} .np-find-count').textContent`), '6 of 6');
      check('wrapped status', await run(s, `document.querySelector('${WIN} .np-find-status').textContent`), 'Search wrapped around');
      // Options menu: match case
      await s.page.click(`${WIN} .np-find-opts`);
      await s.page.locator('.np-menu .menu-item', { hasText: 'Match case' }).click();
      await sleep(120);
      check('match case count (FOX excluded)', await NP(s, (np) => np.find.matches.length), 5);
      check('pref saved', await NP(s, (np) => np.prefs.matchCase), true);
      await s.page.click(`${WIN} .np-find-opts`);
      await s.page.locator('.np-menu .menu-item', { hasText: 'Match whole word' }).click();
      await sleep(120);
      check('whole word excludes foxes/Firefox', await NP(s, (np) => np.find.matches.length), 3);
      await s.page.click(`${WIN} .np-find-opts`);
      await s.page.locator('.np-menu .menu-item', { hasText: 'Wrap around' }).click();
      await sleep(100);
      await NP(s, (np) => {
        np.find.selectMatch(np.find.matches.length - 1);
      });
      await NP(s, (np) => np.find.next(1));
      check('no wrap: stays on last', await NP(s, (np) => np.find.current === np.find.matches.length - 1), true);
      check('end reached message', await run(s, `document.querySelector('${WIN} .np-find-status').textContent`), 'No more results');
      // restore options
      await NP(s, (np) => {
        np.shared.setPref('matchCase', false);
        np.shared.setPref('wholeWord', false);
        np.shared.setPref('wrapAround', true);
        np.find.search();
      });
      await s.page.fill(`${WIN} .np-find-input`, 'zebra');
      await sleep(120);
      check('no results', await run(s, `document.querySelector('${WIN} .np-find-count').textContent`), 'No results');
      check('invalid style', await run(s, `document.querySelector('${WIN} .np-find-input').classList.contains('invalid')`), true);
      await s.page.fill(`${WIN} .np-find-input`, 'fox');
      await sleep(100);
      await shot(s, 'find-replace-light-en', true);
      await s.page.keyboard.press('Escape');
      check('escape closes', await run(s, `document.querySelector('${WIN} .np-find').hidden`), true);
      check('highlights cleared', await run(s, `document.querySelectorAll('${WIN} .np-hl mark').length`), 0);
      check('editor focused again', await run(s, `document.activeElement?.classList.contains('np-text')`), true);
      // F3 / Shift+F3 with the bar closed
      await NP(s, (np) => np.active.ta.setSelectionRange(0, 0));
      await s.page.keyboard.press('F3');
      check('F3 finds next', await sel(s), [16, 19]);
      await s.page.keyboard.press('F3');
      check('F3 again', await sel(s), [47, 50]);
      await s.page.keyboard.press('Shift+F3');
      check('Shift+F3', await sel(s), [16, 19]);
    });

    await section('replace and replace all (count + single undo)', async () => {
      await setText(s, SAMPLE, 0);
      await s.page.keyboard.press('Control+h');
      await sleep(100);
      check('replace row visible', await run(s, `!document.querySelector('${WIN} .np-find-row2').hidden`), true);
      await s.page.fill(`${WIN} .np-find-input`, 'fox');
      await s.page.fill(`${WIN} .np-replace-input`, 'cat');
      await sleep(100);
      await NP(s, (np) => np.find.selectMatch(0));
      await s.page.click(`${WIN} .np-replace-one`);
      await sleep(80);
      check('replace one', (await text(s)).split('\n')[0], 'The quick brown cat jumps over the lazy dog.');
      check('moved to next', await NP(s, (np) => np.find.current), 0);
      check('remaining count', await NP(s, (np) => np.find.matches.length), 5);
      await NP(s, (np) => np.shared.setPref('matchCase', true));
      await NP(s, (np) => np.find.search());
      await s.page.click(`${WIN} .np-replace-all`);
      await sleep(120);
      check('replace all result', await text(s), 'The quick brown cat jumps over the lazy dog.\nA cat is quick; cates are quicker.\nFOX in capitals. Firecat is a cat too.\n');
      check('replace all count', await run(s, `document.querySelector('${WIN} .np-find-status').textContent`), 'Replaced 4 occurrences');
      await NP(s, (np) => np.shared.setPref('matchCase', false));
      await s.page.keyboard.press('Escape');
      await s.page.keyboard.press('Control+z');
      check('replace all undone in one step', (await text(s)).split('\n')[1], 'A fox is quick; foxes are quicker.');
      await s.page.keyboard.press('Control+z');
      check('single replace undone', await text(s), SAMPLE);
      await s.page.keyboard.press('Control+y');
      await s.page.keyboard.press('Control+y');
      check('redo replace all', (await text(s)).split('\n')[2], 'FOX in capitals. Firecat is a cat too.');
    });

    await section('go to line', async () => {
      const long = fs.readFileSync(path.join(docs, 'long.txt'), 'utf8');
      await setText(s, long, 0);
      await s.page.keyboard.press('Control+g');
      await until(() => dialogOpen(s), { label: 'go to dialog' });
      await until(() => run(s, `!!document.activeElement?.closest('${WIN} > .dialog-layer')`), { label: 'dialog focus' });
      check('go to dialog', await dialogText(s), (v) => v.includes('Line number'));
      await s.page.keyboard.press('Control+a');
      await s.page.keyboard.type('999');
      await s.page.keyboard.press('Enter');
      await sleep(150);
      check('out of range keeps dialog', await dialogOpen(s), true);
      check('range message', await dialogText(s), (v) => v.includes('between 1 and 201'));
      await s.page.keyboard.press('Control+a');
      await s.page.keyboard.type('150');
      await s.page.keyboard.press('Enter');
      await sleep(250);
      check('dialog closed', await dialogOpen(s), false);
      check('caret on line 150', (await status(s)).pos, 'Ln 150, Col 1');
      check('scrolled into view', await NP(s, (np) => np.active.ta.scrollTop > 0), true);
      check('line text at caret', await NP(s, (np) => np.active.text.slice(np.active.ta.selectionStart, np.active.ta.selectionStart + 9)), 'Line 150:');
    });

    await section('word wrap, zoom, status bar toggle (persisted)', async () => {
      await setText(s, `${'wide '.repeat(120)}\nshort`, 0);
      check('wrap on by default', await NP(s, (np) => np.active.ta.wrap), 'soft');
      check('no horizontal scroll with wrap', await NP(s, (np) => np.active.ta.scrollWidth <= np.active.ta.clientWidth + 1), true);
      await s.page.click(`${WIN} .np-menu-btn[data-menu="view"]`);
      await s.page.locator('.np-menu .menu-item', { hasText: 'Word wrap' }).click();
      await sleep(120);
      check('wrap off', await NP(s, (np) => np.active.ta.wrap), 'off');
      check('nowrap class', await run(s, `document.querySelector('${WIN} .np-root').classList.contains('nowrap')`), true);
      check('horizontal scroll without wrap', await NP(s, (np) => np.active.ta.scrollWidth > np.active.ta.clientWidth + 50), true);
      await s.page.click(`${WIN} .np-menu-btn[data-menu="view"]`);
      check('menu shows wrap unchecked', await run(s, `[...document.querySelectorAll('.np-menu .menu-item')].find((r) => r.textContent.includes('Word wrap')).getAttribute('aria-checked')`), 'false');
      await s.page.keyboard.press('Escape');
      await NP(s, (np) => np.shared.setPref('wordWrap', true));
      const fs0 = await NP(s, (np) => parseFloat(getComputedStyle(np.active.ta).fontSize));
      await focusEditor(s);
      await s.page.keyboard.press('Control+=');
      await s.page.keyboard.press('Control+=');
      check('zoom in x2', (await status(s)).zoom, '120%');
      check('font grows', await NP(s, (np) => parseFloat(getComputedStyle(np.active.ta).fontSize)), (v) => Math.abs(v - fs0 * 1.2) < 0.2);
      await s.page.keyboard.press('Control+-');
      check('zoom out', (await status(s)).zoom, '110%');
      const box = await run(s, `(() => { const r = document.querySelector('${WIN} .np-doc:not([hidden])').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      await s.page.mouse.move(box.x, box.y);
      await s.page.keyboard.down('Control');
      await s.page.mouse.wheel(0, -100);
      await sleep(80);
      await s.page.keyboard.up('Control');
      check('ctrl+wheel zooms in', (await status(s)).zoom, '120%');
      await s.page.keyboard.press('Control+0');
      check('restore zoom', (await status(s)).zoom, '100%');
      await s.page.keyboard.press('Control+=');
      await sleep(600);
      check('zoom persisted', readJson(prefsFile(home))?.zoom, 110);
      await s.page.keyboard.press('Control+0');
      await s.page.click(`${WIN} .np-st-zoom`);
      check('zoom menu from status bar', await run(s, `[...document.querySelectorAll('.np-menu .menu-item .label')].map((x) => x.textContent)`), ['Zoom in', 'Zoom out', 'Restore default zoom']);
      await s.page.keyboard.press('Escape');
      await s.page.click(`${WIN} .np-menu-btn[data-menu="view"]`);
      await s.page.locator('.np-menu .menu-item', { hasText: 'Status bar' }).click();
      await sleep(80);
      check('status bar hidden', await run(s, `document.querySelector('${WIN} .np-status').hidden`), true);
      await sleep(600);
      check('status bar pref persisted', readJson(prefsFile(home))?.statusBar, false);
      await NP(s, (np) => np.shared.setPref('statusBar', true));
      check('status bar back', await run(s, `document.querySelector('${WIN} .np-status').hidden`), false);
    });

    await section('open CRLF file, edit, save: CRLF preserved', async () => {
      const f = path.join(docs, 'crlf.txt');
      await openNotepad(s, { file: f });
      check('one window still', await winCount(s), 1);
      const t = await tabs(s);
      check('opened in a new tab', t.map((x) => x.title).includes('crlf.txt'), true);
      check('active is crlf.txt', t.find((x) => x.active)?.title, 'crlf.txt');
      check('eol detected', (await status(s)).eol, 'Windows (CRLF)');
      check('text normalised', await text(s), 'first line\nsecond line\nthird line\n');
      check('title', await run(s, `window.__aurora.wm.byApp('notepad')[0].title`), 'crlf.txt - Text Editor');
      await focusEditor(s);
      await s.page.keyboard.press('Control+End');
      await s.page.keyboard.type('fourth line');
      await s.page.keyboard.press('Enter');
      await s.page.keyboard.press('Control+s');
      await until(() => NP(s, (np) => !np.active.dirty), { label: 'saved' });
      check('file on disk keeps CRLF', fs.readFileSync(f, 'utf8'), 'first line\r\nsecond line\r\nthird line\r\nfourth line\r\n');
      check('clean after save', (await tabs(s)).find((x) => x.active).dirty, false);
      // switch to LF through the status bar menu
      await s.page.click(`${WIN} .np-st-eol`);
      await s.page.locator('.np-menu .menu-item', { hasText: 'Unix (LF)' }).click();
      check('eol change marks dirty', (await tabs(s)).find((x) => x.active).dirty, true);
      check('status eol', (await status(s)).eol, 'Unix (LF)');
      await s.page.keyboard.press('Control+s');
      await until(() => NP(s, (np) => !np.active.dirty), { label: 'saved LF' });
      check('file converted to LF', fs.readFileSync(f, 'utf8'), 'first line\nsecond line\nthird line\nfourth line\n');
      await NP(s, (np) => np.setEol(np.active, 'crlf'));
      await s.page.keyboard.press('Control+s');
      await until(() => NP(s, (np) => !np.active.dirty), { label: 'saved CRLF' });
      check('back to CRLF', fs.readFileSync(f, 'utf8').includes('\r\n'), true);
      // Macintosh (CR)
      await openNotepad(s, { file: path.join(docs, 'mac.txt') });
      check('CR detected', (await status(s)).eol, 'Macintosh (CR)');
      check('CR text', await text(s), 'old\nmac\nfile');
      await NP(s, (np) => np.active.replaceRange(np.active.text.length, np.active.text.length, '!'));
      await s.page.keyboard.press('Control+s');
      await until(() => NP(s, (np) => !np.active.dirty), { label: 'saved CR' });
      check('CR preserved', fs.readFileSync(path.join(docs, 'mac.txt'), 'utf8'), 'old\rmac\rfile!');
    });

    await section('encodings: BOM, ANSI fallback, UTF-16', async () => {
      const bom = path.join(docs, 'bom.txt');
      await openNotepad(s, { file: bom });
      check('BOM detected', (await status(s)).enc, 'UTF-8 with BOM');
      check('BOM not in text', await text(s), 'Ça va? Ünïcödé ✓\n');
      await NP(s, (np) => np.active.replaceRange(0, 0, '>'));
      await s.page.keyboard.press('Control+s');
      await until(() => NP(s, (np) => !np.active.dirty), { label: 'saved bom' });
      const b = fs.readFileSync(bom);
      check('BOM preserved', [...b.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
      check('content preserved', b.subarray(3).toString('utf8'), '>Ça va? Ünïcödé ✓\n');
      await s.page.click(`${WIN} .np-st-enc`);
      await s.page.locator('.np-menu .menu-item', { hasText: /^UTF-8$/ }).first().click();
      check('encoding change marks dirty', (await tabs(s)).find((x) => x.active).dirty, true);
      await s.page.keyboard.press('Control+s');
      await until(() => NP(s, (np) => !np.active.dirty), { label: 'saved no bom' });
      check('BOM removed', fs.readFileSync(bom)[0], 0x3e);
      // Latin-1 / ANSI fallback
      const l1 = path.join(docs, 'latin1.txt');
      await openNotepad(s, { file: l1 });
      check('ANSI detected', (await status(s)).enc, 'ANSI');
      check('decoded é è', await text(s), 'Café crème\n');
      await NP(s, (np) => np.active.replaceRange(np.active.text.length, np.active.text.length, 'Noël\n'));
      await s.page.keyboard.press('Control+s');
      await until(() => NP(s, (np) => !np.active.dirty), { label: 'saved ansi' });
      check('ANSI bytes', [...fs.readFileSync(l1)], [0x43, 0x61, 0x66, 0xe9, 0x20, 0x63, 0x72, 0xe8, 0x6d, 0x65, 0x0a, 0x4e, 0x6f, 0xeb, 0x6c, 0x0a]);
      // unencodable character in ANSI -> asks, "Save as UTF-8"
      await NP(s, (np) => np.active.replaceRange(0, 0, '★ '));
      await s.page.keyboard.press('Control+s');
      await until(() => dialogOpen(s), { label: 'lossy dialog' });
      check('lossy warning', await dialogText(s), (v) => v.includes('★') && v.includes('ANSI'));
      await dialogButton(s, 'Save as UTF-8');
      await until(() => NP(s, (np) => !np.active.dirty), { label: 'saved utf8' });
      check('now UTF-8', (await status(s)).enc, 'UTF-8');
      check('utf-8 on disk', fs.readFileSync(l1, 'utf8').startsWith('★ Café'), true);
      // UTF-16 LE
      const u = path.join(docs, 'utf16.txt');
      await openNotepad(s, { file: u });
      check('UTF-16 LE detected', (await status(s)).enc, 'UTF-16 LE');
      check('UTF-16 text', await text(s), 'UTF-16 text: ñ €\n');
      check('UTF-16 eol', (await status(s)).eol, 'Windows (CRLF)');
      await NP(s, (np) => np.active.replaceRange(0, 0, '#'));
      await s.page.keyboard.press('Control+s');
      await until(() => NP(s, (np) => !np.active.dirty), { label: 'saved utf16' });
      const ub = fs.readFileSync(u);
      check('UTF-16 BOM kept', [ub[0], ub[1]], [0xff, 0xfe]);
      check('UTF-16 content', ub.subarray(2).toString('utf16le'), '#UTF-16 text: ñ €\r\n');
      // Reopen with encoding (status bar menu > submenu)
      await openNotepad(s, { file: bom });
      await s.page.click(`${WIN} .np-st-enc`);
      await s.page.locator('.np-menu .menu-item', { hasText: 'Reopen with encoding' }).click();
      await s.page.locator('.np-menu').last().locator('.menu-item', { hasText: 'ANSI (Windows-1252)' }).click();
      await until(async () => (await status(s)).enc === 'ANSI', { label: 'reopened as ANSI' });
      check('reopened as ANSI shows the raw bytes', (await text(s)).startsWith('>Ã‡a va'), true);
      check('reopen keeps the tab clean', (await tabs(s)).find((x) => x.active).dirty, false);
      await NP(s, (np) => np.reopenWith(np.active, 'utf-8'));
      check('reopened as UTF-8', await text(s), '>Ça va? Ünïcödé ✓\n');
    });

    await section('save all (Ctrl+Alt+S)', async () => {
      for (const n of ['notes.md', 'crlf.txt']) {
        await openNotepad(s, { file: path.join(docs, n) });
        await NP(s, (np) => np.active.replaceRange(np.active.text.length, np.active.text.length, 'saved by save all\n'));
      }
      check('two dirty tabs', (await tabs(s)).filter((x) => x.dirty && x.path).length, 2);
      await focusEditor(s);
      check('an unsaved Untitled tab exists too', (await tabs(s)).some((x) => !x.path && x.dirty), true);
      await s.page.keyboard.press('Control+Alt+s');
      await until(() => NP(s, (np) => np.docs.filter((d) => d.path && d.dirty).length === 0), { label: 'saved all' });
      // Files are saved first, then Save as is asked for the Untitled tab: cancel it.
      await until(() => run(s, `!!document.querySelector('${FP}.fp-dialog')`), { label: 'save as for Untitled' });
      await s.page.keyboard.press('Escape');
      await sleep(250);
      check('untitled still unsaved', (await tabs(s)).some((x) => !x.path && x.dirty), true);
      check('notes.md saved', fs.readFileSync(path.join(docs, 'notes.md'), 'utf8').endsWith('saved by save all\n'), true);
      check('crlf.txt saved with CRLF', fs.readFileSync(path.join(docs, 'crlf.txt'), 'utf8').endsWith('saved by save all\r\n'), true);
    });

    await section('save as: new file, .txt added, name from first line', async () => {
      await s.page.keyboard.press('Control+n');
      await sleep(150);
      check('new tab is Untitled and active', (await tabs(s)).find((x) => x.active).title, 'Untitled');
      await s.page.keyboard.type('Shopping list\nmilk\neggs');
      await s.page.keyboard.press('Control+s');
      await pickerReady(s);
      check('suggested name from first line', await run(s, `document.querySelector('${FP} .fp-bottom input').value`), 'Shopping list.txt');
      check('default folder Documents', await run(s, `document.querySelector('${FP} .fp-path').value`), docs);
      await shot(s, 'save-as-light-en', true);
      await s.page.fill(`${FP} .fp-bottom input`, 'groceries');
      await s.page.keyboard.press('Enter');
      const target = path.join(docs, 'groceries.txt');
      await until(() => fs.existsSync(target) && fs.statSync(target).size > 0, { label: 'saved file', timeout: 10000 });
      await sleep(150);
      check('content', fs.readFileSync(target, 'utf8'), 'Shopping list\nmilk\neggs');
      check('tab renamed', (await tabs(s)).find((x) => x.active).title, 'groceries.txt');
      check('path set', (await tabs(s)).find((x) => x.active).path, target);
      // Save as again with an explicit name -> copy
      await s.page.keyboard.press('Control+Shift+s');
      await pickerReady(s);
      check('save as proposes current name', await run(s, `document.querySelector('${FP} .fp-bottom input').value`), 'groceries.txt');
      await s.page.fill(`${FP} .fp-bottom input`, 'groceries-copy.md');
      await s.page.keyboard.press('Enter');
      await until(() => fs.existsSync(path.join(docs, 'groceries-copy.md')), { label: 'copy saved', timeout: 10000 });
      await sleep(150);
      check('tab follows new name', (await tabs(s)).find((x) => x.active).title, 'groceries-copy.md');
      // Cancel save as keeps the tab dirty
      await s.page.keyboard.press('Control+n');
      await s.page.keyboard.type('x');
      await s.page.keyboard.press('Control+s');
      await pickerReady(s);
      await s.page.keyboard.press('Escape');
      await sleep(250);
      check('still dirty after cancel', (await tabs(s)).find((x) => x.active).dirty, true);
      await NP(s, (np) => np.closeTab(np.active, { prompt: false }));
    });

    await section('recent files menu, open recent, clear', async () => {
      await s.page.click(`${WIN} .np-menu-btn[data-menu="file"]`);
      await s.page.locator('.np-menu .menu-item', { hasText: 'Recent' }).hover();
      await until(() => run(s, `document.querySelectorAll('.np-menu').length === 2`), { label: 'recent submenu' });
      const items = await run(s, `[...document.querySelectorAll('.np-menu')[1].querySelectorAll('.menu-item .label')].map((x) => x.textContent)`);
      check('recent lists saved/opened files (most recent first)', items.slice(0, 3), ['groceries-copy.md', 'groceries.txt', 'notes.md']);
      check('recent has clear entry', items.includes('Clear recent files'), true);
      await shot(s, 'menu-recent-light-en', true);
      await s.page.keyboard.press('Escape');
      await s.page.keyboard.press('Escape');
      await sleep(400);
      check('recent persisted', readJson(path.join(home, '.config', 'aurora', 'apps', 'notepad', 'recent.json'))?.[0], path.join(docs, 'groceries-copy.md'));
      // open a recent file that is not open
      await NP(s, (np) => np.closeTab(np.docs.find((d) => d.title === 'notes.md') || null));
      await NP(s, (np, el, p) => np.shared.addRecent(p), path.join(docs, 'notes.md'));
      await s.page.click(`${WIN} .np-menu-btn[data-menu="file"]`);
      await s.page.locator('.np-menu .menu-item', { hasText: 'Recent' }).click();
      await s.page.locator('.np-menu .menu-item', { hasText: 'notes.md' }).click();
      await until(() => NP(s, (np) => np.active.title === 'notes.md'), { label: 'recent opened' });
      check('recent opened', (await tabs(s)).find((x) => x.active).title, 'notes.md');
      // missing recent file -> offer to remove
      await NP(s, (np, el, p) => np.shared.addRecent(p), path.join(docs, 'gone.txt'));
      NP(s, (np, el, p) => {
        np.openRecent(p);
      }, path.join(docs, 'gone.txt')).catch(() => {});
      await until(() => dialogOpen(s), { label: 'missing dialog' });
      check('missing message', await dialogText(s), (v) => v.includes('gone.txt'));
      await dialogButton(s, 'Remove');
      check('removed from recent', await NP(s, (np) => np.shared.recent.some((p) => p.endsWith('gone.txt'))), false);
      await s.page.click(`${WIN} .np-menu-btn[data-menu="file"]`);
      await s.page.locator('.np-menu .menu-item', { hasText: 'Recent' }).click();
      await s.page.locator('.np-menu .menu-item', { hasText: 'Clear recent files' }).click();
      check('recent cleared', await NP(s, (np) => np.shared.recent.length), 0);
      await s.page.click(`${WIN} .np-menu-btn[data-menu="file"]`);
      await s.page.locator('.np-menu .menu-item', { hasText: 'Recent' }).click();
      check('empty recent placeholder', await run(s, `document.querySelectorAll('.np-menu')[1]?.innerText.trim()`), 'No recent files');
      await s.page.keyboard.press('Escape');
      await s.page.keyboard.press('Escape');
    });

    await section('relaunch with {file}: new tab, no duplicate; {newWindow} opens a window', async () => {
      const before = (await tabs(s)).length;
      await openNotepad(s, { file: path.join(docs, 'config.json') });
      check('still one window', await winCount(s), 1);
      check('one more tab', (await tabs(s)).length, before + 1);
      check('active config.json', (await tabs(s)).find((x) => x.active).title, 'config.json');
      await NP(s, (np) => np.activate(np.docs[0]));
      await run(s, `window.__aurora.shell.launch('notepad', { file: ${JSON.stringify(path.join(docs, 'config.json'))} }); 0`);
      await sleep(400);
      check('no duplicate tab', (await tabs(s)).filter((x) => x.title === 'config.json').length, 1);
      check('existing tab activated', (await tabs(s)).find((x) => x.active).title, 'config.json');
      // shell.openFile uses the fileTypes association
      await run(s, `window.__aurora.shell.openFile(${JSON.stringify(path.join(docs, 'notes.md'))}); 0`);
      await sleep(400);
      check('openFile .md -> notepad', (await tabs(s)).find((x) => x.active).title, 'notes.md');
      await s.page.keyboard.press('Control+Shift+n');
      await until(async () => (await winCount(s)) === 2, { label: 'second window' });
      await sleep(300);
      check('new window has one Untitled tab', (await tabs(s, -1)).map((x) => x.title), ['Untitled']);
      // {file} goes to the most recently used window (the new one)
      await openNotepad(s, { file: path.join(docs, 'long.txt') });
      check('file opened in focused window', (await tabs(s, -1)).map((x) => x.title), ['long.txt']);
      check('pristine Untitled replaced', (await tabs(s, -1)).length, 1);
      await NP(s, (np) => np.active.focus(), null, -1);
      await s.page.keyboard.press('Control+Shift+w');
      await until(async () => (await winCount(s)) === 1, { label: 'second window closed (Ctrl+Shift+W)' });
      check('Ctrl+Shift+W closes the window', await winCount(s), 1);
    });

    await section('tabs: context menu, copy path, middle click, drag reorder, Ctrl+Tab', async () => {
      // Make a clean set of tabs: crlf.txt, notes.md, config.json
      await NP(s, (np) => {
        for (const d of [...np.docs]) if (!['crlf.txt', 'notes.md', 'config.json'].includes(d.title)) np.removeTab(d, { animate: false });
      });
      for (const n of ['crlf.txt', 'notes.md', 'config.json']) await openNotepad(s, { file: path.join(docs, n) });
      await NP(s, (np) => {
        const order = ['crlf.txt', 'notes.md', 'config.json'];
        for (const [i, n] of order.entries()) np.moveTab(np.docs.find((d) => d.title === n), i);
      });
      check('order', (await tabs(s)).map((x) => x.title), ['crlf.txt', 'notes.md', 'config.json']);
      await NP(s, (np) => np.activate(np.docs[0]));
      await s.page.keyboard.press('Control+Tab');
      check('ctrl+tab', (await tabs(s)).find((x) => x.active).title, 'notes.md');
      await s.page.keyboard.press('Control+Shift+Tab');
      check('ctrl+shift+tab', (await tabs(s)).find((x) => x.active).title, 'crlf.txt');
      await s.page.keyboard.press('Control+3');
      check('ctrl+3', (await tabs(s)).find((x) => x.active).title, 'config.json');
      // drag notes.md after config.json
      const r = await run(s, `[...document.querySelectorAll('${WIN} .np-tab')].map((t) => { const b = t.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width }; })`);
      await s.page.mouse.move(r[1].x, r[1].y);
      await s.page.mouse.down();
      await s.page.mouse.move(r[1].x + 30, r[1].y, { steps: 3 });
      await s.page.mouse.move(r[2].x + r[2].w / 2 - 4, r[1].y, { steps: 8 });
      await s.page.mouse.up();
      await sleep(250);
      check('drag reorder', (await tabs(s)).map((x) => x.title), ['crlf.txt', 'config.json', 'notes.md']);
      check('dragged tab active', (await tabs(s)).find((x) => x.active).title, 'notes.md');
      // context menu on first tab
      await s.page.click(`${WIN} .np-tab:nth-child(1)`, { button: 'right' });
      const labels = await run(s, `[...document.querySelectorAll('.np-menu .menu-item .label')].map((x) => x.textContent)`);
      check('tab menu', labels, ['Close tab', 'Close other tabs', 'Close tabs to the right', 'Copy path', 'Open containing folder']);
      await shot(s, 'tab-menu-light-en', true);
      await s.page.locator('.np-menu .menu-item', { hasText: 'Copy path' }).click();
      await sleep(150);
      check('copy path', await run(s, `window.__aurora.api.invoke('clipboard:readText')`), path.join(docs, 'crlf.txt'));
      await s.page.click(`${WIN} .np-tab:nth-child(1)`, { button: 'right' });
      await s.page.locator('.np-menu .menu-item', { hasText: 'Close tabs to the right' }).click();
      await sleep(300);
      check('closed tabs to the right', (await tabs(s)).map((x) => x.title), ['crlf.txt']);
      for (const n of ['notes.md', 'config.json']) await openNotepad(s, { file: path.join(docs, n) });
      await s.page.click(`${WIN} .np-tab:nth-child(2)`, { button: 'right' });
      await s.page.locator('.np-menu .menu-item', { hasText: 'Close other tabs' }).click();
      await sleep(300);
      check('close other tabs', (await tabs(s)).map((x) => x.title), ['notes.md']);
      await openNotepad(s, { file: path.join(docs, 'config.json') });
      await s.page.click(`${WIN} .np-tab:nth-child(1)`, { button: 'middle' });
      await sleep(300);
      check('middle click closes', (await tabs(s)).map((x) => x.title), ['config.json']);
      check('middle click did not paste into the editor', (await tabs(s))[0].dirty, false);
      // open containing folder -> File Explorer with the file selected
      const filesBefore = await run(s, `window.__aurora.wm.byApp('files').length`);
      await NP(s, (np) => np.openFolder(np.active));
      await until(async () => (await run(s, `window.__aurora.wm.byApp('files').length`)) > filesBefore, { label: 'files window', timeout: 8000 });
      check('explorer opened', true, true);
      await sleep(600);
      await run(s, `window.__aurora.wm.byApp('files').forEach((w) => w.close(true)); 0`);
      await sleep(300);
      await NP(s, (np) => np.win.focus());
      // new tab button + close button on tab
      await s.page.click(`${WIN} .np-newtab`);
      await sleep(200);
      check('+ adds a tab', (await tabs(s)).length, 2);
      await s.page.hover(`${WIN} .np-tab.active`);
      await s.page.click(`${WIN} .np-tab.active .np-tab-close`);
      await sleep(300);
      check('close button closes pristine tab', (await tabs(s)).length, 1);
    });

    await section('unsaved changes: tab prompt and window prompt with list', async () => {
      await NP(s, (np) => np.active.replaceRange(0, 0, 'edit '));
      await s.page.keyboard.press('Control+w');
      await until(() => dialogOpen(s), { label: 'tab prompt' });
      check('prompt text', await dialogText(s), (v) => v.includes('Do you want to save changes to') && v.includes('config.json'));
      await shot(s, 'unsaved-prompt-light-en', true);
      await dialogButton(s, 'Cancel');
      check('cancel keeps tab', (await tabs(s)).map((x) => x.title), ['config.json']);
      await s.page.keyboard.press('Control+n');
      await s.page.keyboard.type('draft one');
      await s.page.keyboard.press('Control+n');
      await s.page.keyboard.type('draft two');
      await s.page.keyboard.press('Control+w');
      await dialogButton(s, "Don't save");
      check("don't save closes tab", (await tabs(s)).length, 2);
      // window close: two unsaved tabs (config.json + draft one)
      await NP(s, (np) => {
        np.win.close();
      });
      await until(() => dialogOpen(s), { label: 'window prompt' });
      check('list prompt', await dialogText(s), (v) => v.includes('following files') && v.includes('config.json') && v.includes('Untitled'));
      check('two checkboxes', await run(s, `document.querySelectorAll('${WIN} .np-ask-item input:checked').length`), 2);
      await shot(s, 'unsaved-list-light-en', true);
      await dialogButton(s, 'Cancel');
      check('window still open', await winCount(s), 1);
      // Save only config.json: uncheck the Untitled one
      await NP(s, (np) => {
        np.win.close();
      });
      await until(() => dialogOpen(s), { label: 'window prompt 2' });
      await run(s, `[...document.querySelectorAll('${WIN} .np-ask-item')].find((x) => x.textContent.includes('Untitled')).querySelector('input').click()`);
      await dialogButton(s, 'Save');
      await until(async () => (await winCount(s)) === 0, { label: 'window closed' });
      check('config.json saved', fs.readFileSync(path.join(docs, 'config.json'), 'utf8').slice(0, 6), 'edit {');
      check('unchecked draft not saved', fs.readdirSync(docs).filter((f) => /draft/.test(f)), []);
      await openNotepad(s);
    });

    await section('external changes: reload clean tabs, notice for modified ones', async () => {
      const f = path.join(docs, 'external.txt');
      await openNotepad(s, { file: f });
      fs.writeFileSync(f, 'version 2 from another program\n');
      await NP(s, (np) => np.checkExternal(np.active));
      await until(async () => (await text(s)) === 'version 2 from another program\n', { label: 'reload' });
      check('clean tab reloaded', (await tabs(s)).find((x) => x.active).dirty, false);
      await NP(s, (np) => np.active.replaceRange(0, 0, 'mine: '));
      await sleep(50);
      fs.writeFileSync(f, 'version 3\n');
      fs.utimesSync(f, new Date(), new Date(Date.now() + 5000));
      await NP(s, (np) => np.checkExternal(np.active));
      await until(() => run(s, `!document.querySelector('${WIN} .np-notice').hidden`), { label: 'notice' });
      check('notice text', await run(s, `document.querySelector('${WIN} .np-notice').innerText`), (v) => v.includes('changed by another program'));
      await shot(s, 'external-change-light-en', true);
      await s.page.locator(`${WIN} .np-notice .btn`, { hasText: 'Reload' }).click();
      await until(async () => (await text(s)) === 'version 3\n', { label: 'reloaded' });
      check('notice hidden', await run(s, `document.querySelector('${WIN} .np-notice').hidden`), true);
      fs.rmSync(f);
      await NP(s, (np) => np.checkExternal(np.active));
      await until(() => run(s, `!document.querySelector('${WIN} .np-notice').hidden`), { label: 'deleted notice' });
      check('deleted notice', await run(s, `document.querySelector('${WIN} .np-notice').innerText`), (v) => v.includes('deleted or moved'));
      await s.page.locator(`${WIN} .np-notice .btn`, { hasText: 'Save' }).click();
      await until(() => fs.existsSync(f) && fs.readFileSync(f, 'utf8') === 'version 3\n', { label: 'resaved' });
      check('saving recreates file', fs.readFileSync(f, 'utf8'), 'version 3\n');
      check('notice gone after save', await run(s, `document.querySelector('${WIN} .np-notice').hidden`), true);
    });

    await section('big file guard: >16 MB asks, >64 MB refused', async () => {
      const big = path.join(docs, 'big.log');
      const huge = path.join(docs, 'huge.log');
      fs.writeFileSync(big, Buffer.alloc(17 * 1024 * 1024, 0x61));
      fs.writeFileSync(huge, Buffer.alloc(65 * 1024 * 1024, 0x61));
      NP(s, (np, el, p) => {
        np.openPath(p);
      }, big).catch(() => {});
      await until(() => dialogOpen(s), { label: 'big dialog' });
      check('big warning', await dialogText(s), (v) => v.includes('big.log') && v.includes('MB'));
      await dialogButton(s, 'Cancel');
      check('not opened', (await tabs(s)).some((x) => x.title === 'big.log'), false);
      NP(s, (np, el, p) => {
        np.openPath(p);
      }, huge).catch(() => {});
      await until(() => dialogOpen(s), { label: 'huge dialog' });
      check('huge refused', await dialogText(s), (v) => v.includes('too large') && v.includes('64 MB'));
      await dialogButton(s, 'OK');
      check('huge not opened', (await tabs(s)).some((x) => x.title === 'huge.log'), false);
      NP(s, (np, el, p) => {
        np.openPath(p);
      }, big).catch(() => {});
      await until(() => dialogOpen(s), { label: 'big dialog 2' });
      await dialogButton(s, 'Open anyway');
      await until(() => NP(s, (np) => np.active.title === 'big.log'), { label: 'big opened', timeout: 20000 });
      check('big text length', await NP(s, (np) => np.active.text.length), 17 * 1024 * 1024);
      await NP(s, (np) => np.closeTab(np.active));
      fs.rmSync(big);
      fs.rmSync(huge);
    });

    await section('drag & drop files onto the window', async () => {
      // A drag started in web content (forged paths payload, no 'dragstart' in the shell) is ignored.
      const forged = path.join(docs, 'forged.txt');
      fs.writeFileSync(forged, 'forged');
      await run(s, `(() => {
        window.dispatchEvent(new PointerEvent('pointerdown'));
        const el = [...document.querySelectorAll('${WIN}')].pop();
        const target = el.querySelector('.np-text:not([hidden])') || el;
        const dt = new DataTransfer();
        dt.setData('application/x-aurora-paths', JSON.stringify([${JSON.stringify(forged)}]));
        for (const type of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
      })()`);
      await sleep(600);
      check('forged drop (not started in the shell) opens nothing', await NP(s, (np) => np.docs.some((d) => d.title === 'forged.txt')), false);
      fs.rmSync(forged);
      // A real shell drag (Files, the desktop): 'dragstart' fired in the shell document first.
      await run(s, `(() => {
        document.dispatchEvent(new DragEvent('dragstart', { bubbles: true }));
        const el = [...document.querySelectorAll('${WIN}')].pop();
        const target = el.querySelector('.np-text:not([hidden])') || el;
        const dt = new DataTransfer();
        dt.setData('application/x-aurora-paths', JSON.stringify([${JSON.stringify(path.join(docs, 'notes.md'))}, ${JSON.stringify(path.join(docs, 'groceries.txt'))}]));
        target.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
        target.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
        window.__npDropShown = !el.querySelector('.np-drop').hidden;
        target.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
        document.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
      })()`);
      check('drop overlay shown while dragging', await run(s, 'window.__npDropShown'), true);
      await until(() => NP(s, (np) => np.docs.some((d) => d.title === 'groceries.txt') && np.docs.some((d) => d.title === 'notes.md')), { label: 'dropped files' });
      check('drop overlay hidden', await run(s, `document.querySelector('${WIN} .np-drop').hidden`), true);
    });

    await section('menu bar keyboard: Alt+F, arrows, Escape, F10, key tips', async () => {
      await focusEditor(s);
      await s.page.keyboard.press('Alt+f');
      await sleep(120);
      check('Alt+F opens File', await run(s, `document.querySelector('${WIN} .np-menu-btn[data-menu="file"]').classList.contains('open')`), true);
      check('first item active', await run(s, `document.querySelector('.np-menu .menu-item.active .label')?.textContent`), 'New tab');
      await s.page.keyboard.press('ArrowRight');
      await sleep(80);
      check('right -> Edit', await run(s, `document.querySelector('${WIN} .np-menu-btn[data-menu="edit"]').classList.contains('open')`), true);
      await s.page.keyboard.press('ArrowRight');
      await s.page.keyboard.press('Enter');
      await sleep(80);
      check('Zoom submenu opens', await run(s, `document.querySelectorAll('.np-menu').length`), 2);
      await s.page.keyboard.press('ArrowLeft');
      check('left closes submenu', await run(s, `document.querySelectorAll('.np-menu').length`), 1);
      await s.page.keyboard.press('Escape');
      check('escape -> menu bar focused', await run(s, `document.activeElement?.dataset?.menu`), 'view');
      await s.page.keyboard.press('Escape');
      check('escape -> editor', await run(s, `document.activeElement?.classList.contains('np-text')`), true);
      await s.page.keyboard.press('F10');
      check('F10 shows key tips', await run(s, `document.querySelector('${WIN} .np-menus').classList.contains('keytips')`), true);
      await shot(s, 'keytips-light-en', true);
      await s.page.keyboard.press('e');
      await sleep(80);
      check('key tip opens Edit', await run(s, `document.querySelector('${WIN} .np-menu-btn[data-menu="edit"]').classList.contains('open')`), true);
      await s.page.keyboard.press('Escape');
      await s.page.keyboard.press('Escape');
      // Mouse: hovering another menu while one is open switches
      await s.page.click(`${WIN} .np-menu-btn[data-menu="file"]`);
      await s.page.hover(`${WIN} .np-menu-btn[data-menu="view"]`);
      await sleep(100);
      check('hover switches menus', await run(s, `document.querySelector('${WIN} .np-menu-btn[data-menu="view"]').classList.contains('open')`), true);
      await s.page.click(`${WIN} .np-menu-btn[data-menu="view"]`);
      check('click again closes', await run(s, `document.querySelectorAll('.np-menu').length`), 0);
    });

    await section('search the web opens the browser with the selection', async () => {
      await setText(s, 'Aurora borealis facts', 0);
      await NP(s, (np) => np.active.ta.setSelectionRange(0, 15));
      const before = await run(s, `window.__aurora.wm.byApp('browser').length`);
      await s.page.keyboard.press('Control+e');
      await until(async () => (await run(s, `window.__aurora.wm.byApp('browser').length`)) > before, { label: 'browser window', timeout: 10000 });
      const url = await until(() => run(s, `(() => { const w = window.__aurora.wm.byApp('browser').at(-1); return window.__aurora.registry.instance(w.id)?.ctx.args.url; })()`), { label: 'browser instance', timeout: 10000 });
      check('search URL carries the selection', url, (u) => /^https:\/\/[^ ]+\?(q|query)=Aurora\+borealis$/.test(u || ''));
      await sleep(500);
      await run(s, `window.__aurora.wm.byApp('browser').forEach((w) => w.close(true)); 0`);
      await sleep(400);
      await NP(s, (np) => np.win.focus());
      browserErrorsFrom = s.logs.length;
    });

    await section('font dialog applies font and persists', async () => {
      await NP(s, (np) => {
        np.fontDialog();
      });
      await until(() => dialogOpen(s), { label: 'font dialog' });
      const fams = await run(s, `[...document.querySelectorAll('${WIN} .np-font-family option')].map((o) => o.value)`);
      check('family list has Cascadia Mono and DejaVu Sans Mono', fams.includes('Cascadia Mono') && fams.includes('DejaVu Sans Mono'), true);
      await s.page.selectOption(`${WIN} .np-font-family`, 'DejaVu Sans Mono');
      await s.page.selectOption(`${WIN} .np-font-style`, 'boldItalic');
      await s.page.selectOption(`${WIN} .np-font-size`, '14');
      check('preview follows', await run(s, `(() => { const p = document.querySelector('${WIN} .np-font-sample'); return [p.style.fontWeight, p.style.fontStyle, p.style.fontSize]; })()`), ['700', 'italic', '18.6667px']);
      await shot(s, 'font-dialog-light-en', true);
      await dialogButton(s, 'OK');
      const cs = await NP(s, (np) => {
        const c = getComputedStyle(np.active.ta);
        return [c.fontFamily.split(',')[0], c.fontWeight, c.fontStyle, c.fontSize];
      });
      check('editor font applied', cs, ['"DejaVu Sans Mono"', '700', 'italic', '18.6667px']);
      await sleep(500);
      check('font persisted', readJson(prefsFile(home))?.font, { family: 'DejaVu Sans Mono', weight: 700, italic: true, size: 14 });
      await NP(s, (np) => np.shared.setPref('font', { family: 'Cascadia Mono', weight: 400, italic: false, size: 11 }));
    });

    await section('settings page: theme override, opening files in a new window', async () => {
      await s.page.click(`${WIN} .np-gear`);
      await until(() => run(s, `!document.querySelector('${WIN} .np-settings').hidden`), { label: 'settings' });
      check('settings title', await run(s, `document.querySelector('${WIN} .np-set-title').textContent`), 'Settings');
      await s.page.click(`${WIN} .np-set-card[data-key="theme"] .np-set-head`);
      await s.page.click(`${WIN} .np-set-card[data-key="theme"] input[value="dark"]`);
      await sleep(150);
      check('app theme dark while system light', await run(s, `document.querySelector('${WIN}').classList.contains('np-theme-dark')`), true);
      check('dark text color', await run(s, `getComputedStyle(document.querySelector('${WIN} .np-set-title')).color`), 'rgb(230, 234, 242)');
      await shot(s, 'settings-app-dark', true);
      await s.page.click(`${WIN} .np-set-card[data-key="theme"] input[value="system"]`);
      await sleep(100);
      check('back to system theme', await run(s, `document.querySelector('${WIN}').classList.contains('np-theme-dark')`), false);
      await s.page.selectOption(`${WIN} select[data-key="openFiles"]`, 'window');
      check('open files pref', await NP(s, (np) => np.prefs.openFiles), 'window');
      await s.page.keyboard.press('Escape');
      check('escape leaves settings', await run(s, `document.querySelector('${WIN} .np-settings').hidden`), true);
      await run(s, `window.__aurora.shell.launch('notepad', { file: ${JSON.stringify(path.join(docs, 'long.txt'))} }); 0`);
      await until(async () => (await winCount(s)) === 2, { label: 'file in new window' });
      await until(() => NP(s, (np) => np?.active?.title === 'long.txt'), { label: 'long.txt in new window' });
      check('file opened in a new window', (await tabs(s, -1)).map((x) => x.title), ['long.txt']);
      await NP(s, (np) => np.win.close(), null, -1);
      await until(async () => (await winCount(s)) === 1, { label: 'closed' });
      await NP(s, (np) => np.shared.setPref('openFiles', 'tab'));
    });

    await section('screenshots: light EN document, menus, min size, maximized', async () => {
      await NP(s, (np) => {
        for (const d of [...np.docs]) np.removeTab(d, { animate: false });
      });
      await openNotepad(s, { file: path.join(docs, 'notes.md') });
      await openNotepad(s, { file: path.join(docs, 'config.json') });
      await s.page.keyboard.press('Control+n');
      await s.page.keyboard.type('Meeting notes — Aurora OS\n\n• Ship the Notepad app with tabs\n• Test light and dark themes\n• French translation: « Bloc-notes »\n\nTODO: review find & replace.');
      await sleep(200);
      await shot(s, 'light-en');
      await s.page.click(`${WIN} .np-menu-btn[data-menu="file"]`);
      await sleep(250);
      await shot(s, 'menu-file-light-en', true);
      await s.page.keyboard.press('ArrowRight');
      await sleep(250);
      await shot(s, 'menu-edit-light-en', true);
      await s.page.keyboard.press('ArrowRight');
      await s.page.keyboard.press('Enter');
      await sleep(250);
      await shot(s, 'menu-view-light-en', true);
      await s.page.keyboard.press('Escape');
      await s.page.keyboard.press('Escape');
      await s.page.keyboard.press('Escape');
      await NP(s, (np) => np.win.setSize(400, 300));
      await sleep(300);
      const ov = await run(s, `(() => { const el = [...document.querySelectorAll('${WIN}')].pop(); const q = (c) => el.querySelector(c); return { menubar: q('.np-menubar').scrollWidth <= q('.np-menubar').clientWidth + 1, status: q('.np-st-right').getBoundingClientRect().right <= q('.np-status').getBoundingClientRect().right + 1, w: el.getBoundingClientRect().width }; })()`);
      check('min size window', ov.w, 400);
      check('menubar fits at min size', ov.menubar, true);
      check('status bar fits at min size', ov.status, true);
      const tabVisible = await run(s, `(() => { const el = [...document.querySelectorAll('${WIN}')].pop(); const t = el.querySelector('.np-tabs').getBoundingClientRect(); const a = el.querySelector('.np-tab.active').getBoundingClientRect(); return a.left >= t.left - 1 && a.right <= t.right + 1; })()`);
      check('active tab visible at min size', tabVisible, true);
      await s.page.keyboard.press('Control+h');
      await sleep(200);
      const fo = await run(s, `(() => { const el = [...document.querySelectorAll('${WIN}')].pop(); const f = el.querySelector('.np-find'); const r = f.getBoundingClientRect(); return [...f.querySelectorAll('button, input')].filter((b) => b.offsetParent).every((b) => b.getBoundingClientRect().right <= r.right + 1); })()`);
      check('find bar fits at min size', fo, true);
      await shot(s, 'minsize-light-en', true);
      await s.page.keyboard.press('Escape');
      await NP(s, (np) => np.win.maximize());
      await sleep(400);
      await shot(s, 'maximized-light-en');
      await NP(s, (np) => np.win.restore());
      await sleep(300);
    });

    await section('QA: one prompt for repeated close / exit requests', async () => {
      await NP(s, (np) => {
        const keep = np.newTab();
        for (const d of [...np.docs]) if (d !== keep) np.removeTab(d, { animate: false });
        keep.replaceRange(0, 0, 'unsaved draft');
      });
      // Alt+F4 twice / taskbar "Close window" while the prompt is up
      await NP(s, (np) => {
        np.win.close();
        np.win.close();
      });
      await until(() => dialogOpen(s), { label: 'close prompt' });
      await sleep(300);
      check('two close requests -> one prompt', await dialogCount(s), 1);
      await dialogButton(s, 'Cancel');
      check('window kept after Cancel', await winCount(s), 1);
      check('nothing left waiting', await NP(s, (np) => np._closeBusy), false);
      await NP(s, (np) => {
        np.exitAll();
        np.exitAll();
      });
      await until(() => dialogOpen(s), { label: 'exit prompt' });
      await sleep(300);
      check('File > Exit twice -> one prompt', await dialogCount(s), 1);
      await dialogButton(s, 'Cancel');
      check('window kept after Exit cancelled', await winCount(s), 1);
      // tab prompt up, then Ctrl+W again and a window close request: still one prompt at a time
      await NP(s, (np) => {
        np.closeTab(np.active);
        np.closeTab(np.active);
        np.win.close();
      });
      await until(() => dialogOpen(s), { label: 'tab prompt' });
      await sleep(300);
      check('tab prompt + close requests -> one prompt', await dialogCount(s), 1);
      await dialogButton(s, 'Cancel');
      // the window close request asks next (one prompt)
      await until(() => dialogOpen(s), { label: 'window prompt after tab prompt' });
      await sleep(250);
      check('then the window asks, once', await dialogCount(s), 1);
      await dialogButton(s, 'Cancel');
      check('still open', await winCount(s), 1);
    });

    await section('QA: one Save as / Open dialog for repeated requests', async () => {
      await NP(s, (np) => {
        np.save();
        np.save();
        np.saveAs();
      });
      await until(() => run(s, `!!document.querySelector('.fp-dialog')`), { label: 'save as picker', timeout: 8000 });
      await sleep(600);
      check('Ctrl+S x2 + Save as -> one picker', await run(s, `document.querySelectorAll('.fp-dialog').length`), 1);
      await s.page.keyboard.press('Escape');
      await until(async () => !(await run(s, `!!document.querySelector('.dialog-layer:not(.closing) .fp-dialog')`)), { label: 'picker closed' });
      check('save promise released', await NP(s, (np) => np.active._saveP), null);
      await NP(s, (np) => {
        np.openDialog();
        np.openDialog();
      });
      await until(() => run(s, `!!document.querySelector('.fp-dialog')`), { label: 'open picker', timeout: 8000 });
      await sleep(600);
      check('Ctrl+O x2 -> one picker', await run(s, `document.querySelectorAll('.fp-dialog').length`), 1);
      await s.page.keyboard.press('Escape');
      await sleep(300);
    });

    await section('QA: devices / pipes and relative paths are refused; file:// URLs work', async () => {
      const fifo = path.join(docs, 'pipe.txt');
      execFileSync('mkfifo', [fifo]);
      try {
        NP(s, (np, el, p) => {
          np.openPath(p);
        }, fifo).catch(() => {});
        await until(() => dialogOpen(s), { label: 'pipe refused', timeout: 4000 });
        check('pipe refused with a message', await dialogText(s), (v) => v.includes("isn't a regular file"));
        await dialogButton(s, 'OK');
        check('no tab for the pipe', (await tabs(s)).some((x) => x.title === 'pipe.txt'), false);
      } finally {
        // (if the guard ever regresses, unblock the backend's read of the pipe)
        try {
          fs.closeSync(fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK));
        } catch {}
        fs.rmSync(fifo, { force: true });
      }
      await run(s, `window.__aurora.shell.launch('notepad', { file: '../../etc/hostname' }); 0`);
      await until(() => dialogOpen(s), { label: 'relative path refused' });
      check('relative path refused', await dialogText(s), (v) => v.includes("isn't a valid file path"));
      await dialogButton(s, 'OK');
      check('no relative path tab', (await tabs(s)).some((x) => x.path && !x.path.startsWith('/')), false);
      await run(s, `window.__aurora.shell.launch('notepad', { file: ${JSON.stringify(`file://${encodeURI(path.join(docs, 'notes.md'))}`)} }); 0`);
      await until(() => NP(s, (np) => np.active.title === 'notes.md'), { label: 'file:// opened' });
      check('file:// URL opens the file', (await tabs(s)).find((x) => x.active).path, path.join(docs, 'notes.md'));
      await run(s, `window.__aurora.shell.launch('notepad', { file: ${JSON.stringify(`${docs}/../Documents/./notes.md`)} }); 0`);
      await sleep(400);
      check('"..", "." collapsed: same tab, no duplicate', (await tabs(s)).filter((x) => x.title === 'notes.md').length, 1);
    });

    await section('QA: a minimised window comes back for its unsaved prompt', async () => {
      await NP(s, (np) => {
        np.active.replaceRange(0, 0, 'changed ');
        np.win.minimize();
      });
      await sleep(400);
      NP(s, (np) => {
        np.win.close();
      }).catch(() => {});
      await until(() => dialogOpen(s), { label: 'prompt' });
      check('window restored to show the prompt', await NP(s, (np) => np.win.minimized), false);
      await dialogButton(s, 'Cancel');
      check('still open after Cancel', await winCount(s), 1);
    });

    await section('QA: keyboard context menu (Shift+F10) highlights the first item', async () => {
      await focusEditor(s);
      await s.page.keyboard.press('Shift+F10');
      await until(() => run(s, `!!document.querySelector('.np-menu')`), { label: 'context menu' });
      check('an item is highlighted', await run(s, `!!document.querySelector('.np-menu .menu-item.active')`), true);
      await s.page.keyboard.press('Escape');
      await sleep(150);
      check('focus back in the editor', await run(s, `document.activeElement?.classList.contains('np-text')`), true);
    });

    await section('QA: tooltips follow the app theme override', async () => {
      await NP(s, (np) => np.shared.setPref('theme', 'dark'));
      await sleep(150);
      await s.page.mouse.move(5, 5);
      await sleep(200);
      await s.page.hover(`${WIN} .np-gear`);
      await until(() => run(s, `!!document.querySelector('.tooltip')`), { label: 'tooltip', timeout: 4000 });
      check('tooltip gets the dark theme', await run(s, `(() => { const t = document.querySelector('.tooltip'); return t.classList.contains('np-theme-dark') && getComputedStyle(t).color; })()`), 'rgb(230, 234, 242)');
      await s.page.mouse.move(5, 5);
      await NP(s, (np) => np.shared.setPref('theme', 'system'));
      await sleep(200);
    });

    await section('QA: small window: dialogs at screen level over the window; notice and find status fit', async () => {
      await NP(s, (np) => np.win.setSize(400, 300));
      await NP(s, (np) => np.shared.setPref('theme', 'dark'));
      await sleep(250);
      NP(s, (np) => {
        np.fontDialog();
      }).catch(() => {});
      await until(() => run(s, `!!document.querySelector('#overlays > .dialog-layer.global:not(.closing) .np-font-dlg')`), { label: 'screen-level font dialog' });
      await sleep(350);
      const g = await run(s, `(() => { const d = document.querySelector('#overlays > .dialog-layer.global:not(.closing) .np-font-dlg'); const r = d.getBoundingClientRect(); const w = document.querySelector('${WIN}').getBoundingClientRect(); return { themed: d.classList.contains('np-theme-dark'), color: getComputedStyle(d).color, onScreen: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, overlaps: r.left < w.right && r.right > w.left && r.top < w.bottom && r.bottom > w.top, preview: d.querySelector('.np-font-preview').getBoundingClientRect().bottom <= r.bottom }; })()`);
      check('font dialog keeps the app theme', [g.themed, g.color], [true, 'rgb(230, 234, 242)']);
      check('font dialog on screen, over the window, preview visible', [g.onScreen, g.overlaps, g.preview], [true, true, true]);
      await s.page.keyboard.press('Escape');
      await sleep(300);
      check('focus back in the editor after a screen-level dialog', await run(s, `document.activeElement?.classList.contains('np-text')`), true);
      // a short question still fits in the window
      await NP(s, (np) => np.active.replaceRange(0, 0, 'x'));
      NP(s, (np) => {
        np.closeTab(np.active);
      }).catch(() => {});
      await until(() => dialogOpen(s), { label: 'tab prompt' });
      check('save prompt stays window-modal', await run(s, `!!document.querySelector('${WIN} > .dialog-layer:not(.closing) .np-ask')`), true);
      await dialogButton(s, 'Cancel');
      await NP(s, (np) => np.shared.setPref('theme', 'system'));
      // file changed on disk: the message keeps the whole line, the buttons wrap underneath
      await NP(s, (np) => {
        np.active.notice = { kind: 'changed' };
        np.renderNotice();
      });
      await sleep(200);
      const n = await run(s, `(() => { const el = document.querySelector('${WIN}'); const m = el.querySelector('.np-notice-msg').getBoundingClientRect(); const bar = el.querySelector('.np-notice-bar').getBoundingClientRect(); const btns = [...el.querySelectorAll('.np-notice .btn')].map((b) => b.getBoundingClientRect()); return { msgH: m.height, barW: bar.width, msgW: m.width, btnsInside: btns.every((b) => b.right <= bar.right + 1 && b.top >= m.bottom - 1) }; })()`);
      check('notice message on at most two lines', n.msgH, (v) => v <= 40);
      check('notice buttons under the message, inside the bar', n.btnsInside, true);
      await NP(s, (np) => {
        np.active.notice = null;
        np.renderNotice();
      });
      // find status ("Replaced N occurrences") still shown at this width, all find buttons inside the bar
      await setText(s, 'aaa bbb aaa', 0);
      await s.page.keyboard.press('Control+h');
      await s.page.fill(`${WIN} .np-find-input`, 'aaa');
      await s.page.fill(`${WIN} .np-replace-input`, 'c');
      await s.page.click(`${WIN} .np-replace-all`);
      await sleep(200);
      const f = await run(s, `(() => { const el = document.querySelector('${WIN}'); const st = el.querySelector('.np-find-status'); const bar = el.querySelector('.np-find').getBoundingClientRect(); const row = el.querySelector('.np-find-row'); const top = el.querySelector('.np-find-input').getBoundingClientRect().top; return { text: st.offsetParent ? st.textContent : null, inside: [...el.querySelectorAll('.np-find button, .np-find input')].filter((b) => b.offsetParent).every((b) => b.getBoundingClientRect().right <= bar.right + 1), oneRow: [...row.querySelectorAll(':scope > button')].every((b) => Math.abs(b.getBoundingClientRect().top - top) < 8) }; })()`);
      check('replace all count shown in a narrow window', f.text, 'Replaced 2 occurrences');
      check('find buttons fit', f.inside, true);
      check('find buttons stay on the first row', f.oneRow, true);
      await shot(s, 'minsize-find-status-light-en', true);
      await s.page.keyboard.press('Escape');
      await NP(s, (np) => np.win.setSize(960, 640));
      await sleep(200);
    });

    await section('QA: open and close Notepad 15 times leaves nothing behind', async () => {
      await run(s, `window.__aurora.wm.byApp('notepad').forEach((w) => w.close(true)); 0`);
      await until(async () => (await winCount(s)) === 0, { label: 'all closed' });
      await sleep(300);
      const snap = () =>
        run(s, `(async () => {
          const { shared } = await import('app://shell/apps/notepad/lib/shared.js');
          const wm = window.__aurora.wm;
          const hm = wm._h || wm.emitter?._h;
          return { windows: shared.windows.length, mru: shared.mru.length, subs: [...shared._subs.values()].reduce((a, x) => a + x.size, 0), wm: hm ? [...hm.values()].reduce((a, x) => a + x.size, 0) : -1, body: document.body.children.length, menus: document.querySelectorAll('.np-menu').length };
        })()`);
      const before = await snap();
      for (let i = 0; i < 15; i++) {
        await openNotepad(s);
        await NP(s, (np) => {
          np.find.open();
          np.bar.open('file');
        });
        await NP(s, (np) => np.win.close(true));
        await until(async () => (await winCount(s)) === 0, { label: 'closed' });
      }
      await sleep(400);
      check('no Notepad state, listeners or popups left after 15 open/close', await snap(), before);
      await openNotepad(s);
    });

    await section('no console errors from Notepad (EN light run)', async () => {
      check('console errors', errorsSince(s, mark), []);
    });
  } finally {
    await s.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// ================================================================== French + dark theme
async function frenchDarkRun() {
  const home = makeHome();
  const docs = path.join(home, 'Documents');
  const s = await launchShell({ theme: 'dark', lang: 'fr', home });
  setRecover(s);
  const mark = s.logs.length;
  try {
    await openNotepad(s);
    await section('French labels, plurals and dark theme', async () => {
      check('window title', await run(s, `window.__aurora.wm.byApp('notepad')[0].title`), 'Sans titre - Éditeur de texte');
      check('menus', await run(s, `[...document.querySelectorAll('${WIN} .np-menu-btn .np-menu-label')].map((b) => b.textContent)`), ['Fichier', 'Modifier', 'Affichage']);
      check('status FR', await status(s), { pos: 'Ln 1, col 1', chars: '0 caractère', zoom: '100 %', eol: 'Unix (LF)', enc: 'UTF-8' });
      await focusEditor(s);
      await s.page.keyboard.type('Bonjour');
      await sleep(80);
      check('plural', (await status(s)).chars, '7 caractères');
      check('dark text color', await NP(s, (np) => getComputedStyle(np.active.ta).color), 'rgb(230, 234, 242)');
      await s.page.keyboard.press('Alt+m');
      await sleep(150);
      check('Alt+M opens Modifier', await run(s, `document.querySelector('${WIN} .np-menu-btn[data-menu="edit"]').classList.contains('open')`), true);
      check('French edit items', await run(s, `[...document.querySelectorAll('.np-menu .menu-item .label')].map((x) => x.textContent).slice(0, 3)`), ['Annuler', 'Rétablir', 'Couper']);
      const menuFits = await run(s, `(() => { const m = document.querySelector('.np-menu'); return [...m.querySelectorAll('.menu-item')].every((r) => r.scrollWidth <= r.clientWidth + 1); })()`);
      check('French menu items fit', menuFits, true);
      await shot(s, 'menu-edit-dark-fr', true);
      await s.page.keyboard.press('Escape');
      await s.page.keyboard.press('Escape');
    });
    await section('French dark screenshots: document, find, prompts, settings, min size', async () => {
      await openNotepad(s, { file: path.join(docs, 'notes.md') });
      await openNotepad(s, { file: path.join(docs, 'crlf.txt') });
      await s.page.keyboard.press('Control+n');
      await s.page.keyboard.type('Liste de courses\n\n– pain\n– fromage\n– café\n\nNe pas oublier : « Bloc-notes » en français !');
      await sleep(200);
      await shot(s, 'dark-fr');
      await s.page.keyboard.press('Control+h');
      await s.page.keyboard.type('pain');
      await s.page.fill(`${WIN} .np-replace-input`, 'baguette');
      await sleep(200);
      check('FR count', await run(s, `document.querySelector('${WIN} .np-find-count').textContent`), '1 sur 1');
      await s.page.click(`${WIN} .np-replace-all`);
      await sleep(150);
      check('FR replaced message', await run(s, `document.querySelector('${WIN} .np-find-status').textContent`), '1 occurrence remplacée');
      await shot(s, 'find-replace-dark-fr', true);
      await s.page.keyboard.press('Escape');
      await s.page.keyboard.press('Control+w');
      await until(() => dialogOpen(s), { label: 'FR prompt' });
      check('FR prompt', await dialogText(s), (v) => v.includes('Voulez-vous enregistrer les modifications apportées à Sans titre'));
      await shot(s, 'unsaved-prompt-dark-fr', true);
      await dialogButton(s, 'Annuler');
      await s.page.click(`${WIN} .np-gear`);
      await sleep(400);
      await s.page.click(`${WIN} .np-set-card[data-key="font"] .np-set-head`);
      await sleep(300);
      await shot(s, 'settings-dark-fr', true);
      await s.page.keyboard.press('Escape');
      await NP(s, (np) => np.win.setSize(400, 300));
      await sleep(300);
      const fits = await run(s, `(() => { const el = [...document.querySelectorAll('${WIN}')].pop(); const q = (c) => el.querySelector(c); return q('.np-menubar').scrollWidth <= q('.np-menubar').clientWidth + 1 && q('.np-st-right').getBoundingClientRect().right <= q('.np-status').getBoundingClientRect().right + 1; })()`);
      check('FR fits at min size', fits, true);
      await shot(s, 'minsize-dark-fr', true);
      await NP(s, (np) => np.win.maximize());
      await sleep(400);
      await shot(s, 'maximized-dark-fr');
    });
    await section('QA (FR): French key names in shortcuts and tooltips; save list shows folders', async () => {
      await NP(s, (np) => {
        if (np.win.state === 'maximized') np.win.restore();
        np.win.setSize(960, 640);
      });
      await sleep(200);
      await NP(s, (np) => np.bar.open('file'));
      await sleep(200);
      const fileKeys = await run(s, `[...document.querySelectorAll('.np-menu .menu-item .shortcut')].map((x) => x.textContent)`);
      check('File menu uses Maj', fileKeys.includes('Ctrl+Maj+N') && fileKeys.includes('Ctrl+Maj+S') && fileKeys.includes('Ctrl+Maj+W'), true);
      check('no "Shift" in French menus', fileKeys.some((k) => /Shift/.test(k)), false);
      await s.page.keyboard.press('ArrowRight');
      await sleep(150);
      const editKeys = await run(s, `[...document.querySelectorAll('.np-menu .menu-item .shortcut')].map((x) => x.textContent)`);
      check('Edit menu: Maj+F3 and Suppr', editKeys.includes('Maj+F3') && editKeys.includes('Suppr'), true);
      await s.page.keyboard.press('Escape');
      await s.page.keyboard.press('Escape');
      check('find tooltips', await NP(s, (np) => [np.find.prevBtn.dataset.tip, np.find.closeBtn.dataset.tip]), ['Rechercher le précédent (Maj+F3)', 'Fermer (Échap)']);
      // two unsaved tabs, one of them a file: the list shows the file's folder
      await NP(s, (np) => {
        for (const d of np.docs) if (d.path) d.replaceRange(0, 0, '!');
      });
      NP(s, (np) => {
        np.win.close();
      }).catch(() => {});
      await until(() => run(s, `!!document.querySelector('${LAYER} .np-ask-many')`), { label: 'save list' });
      check('folder under the file name', await run(s, `[...document.querySelectorAll('${LAYER} .np-ask-path')].map((x) => x.textContent)`), (v) => v.length >= 1 && v.every((x) => x === docs));
      await dialogButton(s, 'Annuler');
    });

    await section('no console errors from Notepad (FR dark run)', async () => {
      check('console errors', errorsSince(s, mark), []);
    });
  } finally {
    await s.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// ================================================================== session restore ("Continue previous session")
async function sessionRun() {
  const home = makeHome();
  const docs = path.join(home, 'Documents');
  const dir = path.join(home, '.config', 'aurora', 'apps', 'notepad');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'prefs.json'), JSON.stringify({ startup: 'restore' }));
  const s = await launchShell({ theme: 'light', lang: 'en', home });
  const mark = s.logs.length;
  try {
    await section('continue previous session restores unsaved tabs without prompting', async () => {
      await openNotepad(s);
      await focusEditor(s);
      await s.page.keyboard.type('unsaved scratch text');
      await openNotepad(s, { file: path.join(docs, 'notes.md') });
      await NP(s, (np) => np.active.replaceRange(0, 0, 'EDITED '));
      await NP(s, (np) => {
        np.win.close();
      });
      await until(async () => (await winCount(s)) === 0, { label: 'closed without prompt', timeout: 4000 });
      check('closed without prompt', await winCount(s), 0);
      check('file untouched on disk', fs.readFileSync(path.join(docs, 'notes.md'), 'utf8').startsWith('# Notes'), true);
      const stored = readJson(path.join(dir, 'session.json'));
      check('session stored', stored?.windows?.[0]?.tabs?.length, 2);
      await openNotepad(s);
      await until(() => NP(s, (np) => np.docs.length === 2), { label: 'restored tabs' });
      const t = await tabs(s);
      check('restored titles', t.map((x) => x.title), ['Untitled', 'notes.md']);
      check('restored dirty', t.map((x) => x.dirty), [true, true]);
      check('restored active', t.find((x) => x.active).title, 'notes.md');
      check('restored text', await text(s), 'EDITED # Notes\n\n- one\n- two\n');
      await NP(s, (np) => np.activate(np.docs[0]));
      check('restored untitled text', await text(s), 'unsaved scratch text');
    });
    await section('File > Exit closes every Notepad window', async () => {
      await s.page.keyboard.press('Control+Shift+n');
      await until(async () => (await winCount(s)) === 2, { label: 'second window' });
      await until(() => NP(s, (np) => !!np?.active, null, -1), { label: 'second window ready' });
      await NP(s, (np) => np.bar.open('file'), null, -1);
      await s.page.locator('.np-menu .menu-item', { hasText: 'Exit' }).click();
      await until(async () => (await winCount(s)) === 0, { label: 'all closed', timeout: 6000 });
      check('all Notepad windows closed', await winCount(s), 0);
      await openNotepad(s);
      check('next start restores the session again', (await tabs(s)).map((x) => x.title), ['Untitled', 'notes.md']);
    });
    await section('no console errors (session run)', async () => {
      check('console errors', errorsSince(s, mark), []);
    });
  } finally {
    await s.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// ================================================================== corrupted storage
async function storageRun() {
  const home = makeHome();
  const dir = path.join(home, '.config', 'aurora', 'apps', 'notepad');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'prefs.json'), JSON.stringify({ zoom: 'abc', font: { family: 'x"; } body { display:none', size: -4, weight: 'bold' }, theme: 'purple', startup: 'restore', wordWrap: 'yes', defaultEol: 'weird' }));
  fs.writeFileSync(path.join(dir, 'recent.json'), JSON.stringify(['relative.txt', 42, '/abs/ok.txt', null]));
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ windows: [{ key: 'k1', tabs: [{ text: 'restored text', encoding: 'evil', eol: 'zz', sel: ['a', 9999], dirty: true }, { path: '../rel.txt' }, 'junk', null], active: 'x' }, null, { tabs: 'nope' }] }));
  const s = await launchShell({ theme: 'light', lang: 'en', home });
  const mark = s.logs.length;
  try {
    await section('corrupted prefs / recent / session files are sanitised', async () => {
      await openNotepad(s);
      const p = await NP(s, (np) => np.prefs);
      check('bad values fall back to defaults', [p.zoom, p.font.size, p.font.weight, p.theme, p.wordWrap, p.defaultEol, p.startup], [100, 11, 400, 'system', true, 'lf', 'restore']);
      check('font family cannot inject CSS', /[";{}]/.test(p.font.family), false);
      check('recent keeps absolute paths only', await NP(s, (np) => np.shared.recent), ['/abs/ok.txt']);
      const t = await NP(s, (np) => np.docs.map((d) => [d.title, d.encoding, d.eol, d.text, d.dirty]));
      check('session: valid tab restored, junk ignored', t, [['Untitled', 'utf-8', 'lf', 'restored text', true]]);
      check('status bar sane', await status(s), (v) => v.zoom === '100%' && v.enc === 'UTF-8' && v.eol === 'Unix (LF)');
      check('editor font size sane', await NP(s, (np) => getComputedStyle(np.active.ta).fontSize), '14.6667px');
    });
    await section('no console errors (storage run)', async () => {
      check('console errors', errorsSince(s, mark), []);
    });
  } finally {
    await s.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const t0 = Date.now();
console.log('Notepad — English, light');
await mainRun();
console.log('Notepad — French, dark');
await frenchDarkRun();
console.log('Notepad — session restore');
await sessionRun();
console.log('Notepad — corrupted storage');
await storageRun();
console.log(`\n${passed} checks passed, ${failures.length} failed (${Math.round((Date.now() - t0) / 1000)} s)`);
if (failures.length) {
  console.log(`\nFailures:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
