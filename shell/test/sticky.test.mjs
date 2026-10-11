// Sticky Notes tests — drive the real Electron shell with Playwright.
//   Hub (empty state, list with colour / first line / date, search), note windows (typing + autosave to
//   ~/.local/share/aurora/sticky.json, bold / italic / underline / strike / bullets, 6 colours, keep on top through
//   win.setAlwaysOnTop, minimum size), strict sanitizer (Notes sanitizer + allow-list), paste sanitizing, delete with
//   Undo (hub infobar + Ctrl+Z), Copy to Notes (notes:writeNote, file in ~/Documents/Notes), reopen of open notes on
//   the next start, backend atomic writes + .bak recovery, French + dark theme, keyboard, console errors.
//   Documentation screenshots: aurora-os/docs/screenshots/sticky-light-en.png, sticky-dark-fr.png
// Usage:  cd aurora-os/shell && xvfb-run -a -s "-screen 0 1600x900x24" node test/sticky.test.mjs
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
const HUB = '.win.app-sticky.sk-hub-win';
const NOTE = '.win.app-sticky.sk-note-win';

// Evaluate fn(S, arg) in the shell; S = { store, wins, ctx } of any Sticky window.
function SK(s, fn, arg) {
  return s.page.evaluate(`(async () => { const el = document.querySelector('.win.app-sticky'); return (${fn.toString()})(el && el.__sticky, ${JSON.stringify(arg ?? null)}); })()`);
}
async function until(s, fn, { timeout = 8000, label = 'condition', arg } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = await SK(s, fn, arg).catch((e) => `ERR ${e.message}`);
    if (last && !String(last).startsWith('ERR')) return last;
    await sleep(80);
  }
  throw new Error(`timeout waiting for ${label} (last: ${JSON.stringify(last)})`);
}
const dataFile = (home) => path.join(home, '.local', 'share', 'aurora', 'sticky.json');
const readData = (home) => {
  try {
    return JSON.parse(fs.readFileSync(dataFile(home), 'utf8'));
  } catch {
    return null;
  }
};
async function untilFile(home, pred, label, timeout = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const d = readData(home);
    if (d && pred(d)) return d;
    await sleep(100);
  }
  throw new Error(`timeout waiting for file: ${label} (last ${JSON.stringify(readData(home))?.slice(0, 300)})`);
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-sticky-'));
let s = null;
const errors = [];
const watchErrors = (sh) => sh.page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

console.log('Sticky Notes');
try {
  s = await launchShell({ open: ['sticky'], home, theme: 'light', lang: 'en' });
  watchErrors(s);
  await s.page.waitForSelector(HUB, { timeout: 30000 });

  await section('hub: empty state, title, keyboard focus', async () => {
    check('hub title', await s.page.textContent(`${HUB} .sk-hub-title`), 'Sticky Notes');
    check('empty state', await s.page.isVisible(`${HUB} .sk-empty`), true);
    check('empty text', await s.page.textContent(`${HUB} .sk-empty .subtitle`), 'No notes yet');
    check('no data file yet', readData(home), null);
    check('search focused on empty hub', await s.page.evaluate(() => document.activeElement?.classList.contains('sk-search')), true);
  });

  let id1;
  await section('new note window: type, autosave, title', async () => {
    await s.page.click(`${HUB} .sk-add`);
    await s.page.waitForSelector(`${NOTE} .sk-editor`, { timeout: 10000 });
    await sleep(300);
    check('editor focused', await s.page.evaluate(() => document.activeElement?.classList.contains('sk-editor')), true);
    await s.page.keyboard.type('Buy milk');
    await s.page.keyboard.press('Enter');
    await s.page.keyboard.type('and bread');
    const d = await untilFile(home, (x) => x.notes?.length === 1 && x.notes[0].html.includes('bread'), 'autosave');
    id1 = d.notes[0].id;
    check('saved html has first line', d.notes[0].html.includes('Buy milk'), true);
    check('saved as open', d.notes[0].open, true);
    check('default colour yellow', d.notes[0].color, 'yellow');
    check('window title is the first line', await s.page.textContent(`${NOTE} .win-title, ${NOTE} .titlebar .title`).catch(() => null), (v) => v == null || v.includes('Buy milk'));
    check('no temp files left', fs.readdirSync(path.dirname(dataFile(home))).filter((f) => f.endsWith('.tmp')).length, 0);
    const minW = await SK(s, (S, id) => S.wins.notes.get(id).win.opts.minWidth, id1);
    check('note min width 220', minW, 220);
  });

  await section('formatting: bold, italic, underline, strike, bullets', async () => {
    await s.page.click(`${NOTE} .sk-editor`);
    await s.page.keyboard.press('Control+End');
    await s.page.keyboard.press('Enter');
    await s.page.keyboard.press('Control+b');
    await s.page.keyboard.type('Bold');
    await s.page.keyboard.press('Control+b');
    await s.page.keyboard.press('Control+i');
    await s.page.keyboard.type(' it');
    await s.page.keyboard.press('Control+i');
    await s.page.keyboard.press('Control+u');
    await s.page.keyboard.type(' un');
    await s.page.keyboard.press('Control+u');
    await s.page.keyboard.press('Control+t');
    await s.page.keyboard.type(' st');
    await s.page.keyboard.press('Control+t');
    await s.page.keyboard.press('Enter');
    await s.page.click(`${NOTE} .sk-fmt[data-cmd="insertUnorderedList"]`);
    await s.page.keyboard.type('item one');
    const d = await untilFile(home, (x) => x.notes[0].html.includes('item one'), 'formatting saved');
    const html = d.notes[0].html;
    check('bold saved', /<b>Bold<\/b>/.test(html), true);
    check('italic saved', /<i>\s?it<\/i>/.test(html), true);
    check('underline saved', /<u>\s?un<\/u>/.test(html), true);
    check('strike saved', /<s>\s?st<\/s>/.test(html), true);
    check('bullets saved', /<ul><li>item one<\/li><\/ul>/.test(html), true);
    check('no style attributes', /style=|class=|<span/.test(html), false);
  });

  await section('colours and keep on top', async () => {
    await s.page.click(`${NOTE} .sk-more`);
    await s.page.waitForSelector('.menu', { timeout: 4000 });
    const labels = await s.page.$$eval('.menu .menu-item, .menu [role="menuitem"], .menu [role="menuitemcheckbox"]', (els) => els.map((e) => e.textContent.trim()));
    for (const c of ['Yellow', 'Green', 'Pink', 'Purple', 'Blue', 'Charcoal']) check(`menu has ${c}`, labels.some((l) => l.includes(c)), true);
    check('menu has Copy to Notes', labels.some((l) => l.includes('Copy to Notes')), true);
    await s.page.click('.menu >> text=Green');
    await sleep(200);
    check('note colour green', await s.page.getAttribute(`${NOTE} .sk-note`, 'data-color'), 'green');
    const bg = await s.page.$eval(`${NOTE} .sk-note`, (e) => getComputedStyle(e).backgroundColor);
    check('green background', bg, 'rgb(217, 245, 208)');
    await s.page.click(`${NOTE} .sk-pin`);
    check('always on top', await SK(s, (S, id) => S.wins.notes.get(id).win.alwaysOnTop, id1), true);
    check('pin pressed', await s.page.getAttribute(`${NOTE} .sk-pin`, 'aria-pressed'), 'true');
    await s.page.keyboard.press('Alt+t');
    check('Alt+T toggles off', await SK(s, (S, id) => S.wins.notes.get(id).win.alwaysOnTop, id1), false);
    await s.page.keyboard.press('Alt+t');
    const d = await untilFile(home, (x) => x.notes[0].color === 'green' && x.notes[0].onTop === true, 'colour + onTop saved');
    check('saved colour', d.notes[0].color, 'green');
    // a maximized rect must not become the note's remembered size
    await SK(s, (S, id) => S.wins.notes.get(id).win.maximize(), id1);
    await sleep(900);
    const mx = await SK(s, (S, id) => ({ w: S.store.get(id).w, state: S.wins.notes.get(id).win.state, ww: S.wins.notes.get(id).win.w }), id1);
    check('maximized size not remembered', mx.state === 'maximized' && mx.w !== mx.ww, true);
    await SK(s, (S, id) => S.wins.notes.get(id).win.restore(), id1);
    await sleep(300);
  });

  await section('hub list: dot, first line, preview, date, search', async () => {
    await s.page.waitForSelector(`${HUB} .sk-card`, { timeout: 5000 });
    check('one card', await s.page.$$eval(`${HUB} .sk-card`, (e) => e.length), 1);
    check('card first line', await s.page.textContent(`${HUB} .sk-card-title`), 'Buy milk');
    check('card preview', await s.page.textContent(`${HUB} .sk-card-preview`), (v) => v.startsWith('and bread'));
    check('card colour', await s.page.getAttribute(`${HUB} .sk-card`, 'data-color'), 'green');
    check('card date', await s.page.textContent(`${HUB} .sk-card-date`), (v) => /\d/.test(v));
    // a second note made through the store
    await SK(s, (S) => {
      const n = S.store.create({ color: 'blue' });
      S.store.update(n.id, { html: '<div>Café meeting</div><div>Room 4</div>' });
      return n.id;
    });
    await s.page.waitForFunction((sel) => document.querySelectorAll(sel).length === 2, `${HUB} .sk-card`, { timeout: 4000 });
    check('newest first', await s.page.textContent(`${HUB} .sk-card .sk-card-title`), 'Café meeting');
    await s.page.fill(`${HUB} .sk-search`, 'cafe');
    await sleep(200);
    check('search ignores accents', await s.page.$$eval(`${HUB} .sk-card`, (e) => e.map((x) => x.querySelector('.sk-card-title').textContent)), ['Café meeting']);
    await s.page.fill(`${HUB} .sk-search`, 'zzz');
    await sleep(200);
    check('no results', await s.page.textContent(`${HUB} .sk-empty .subtitle`), 'No matching notes');
    await s.page.focus(`${HUB} .sk-search`);
    await s.page.keyboard.press('Escape');
    await sleep(200);
    check('Escape clears search', await s.page.$$eval(`${HUB} .sk-card`, (e) => e.length), 2);
  });

  await section('sanitizer: strict allow-list on store and paste', async () => {
    const out = await SK(s, async (S) => {
      const { clean } = await import('app://shell/apps/sticky/lib/store.js');
      return [
        clean('<img src=x onerror="window.__pwn=1"><script>window.__pwn=2</script><b onclick="x()">ok</b>'),
        clean('<h1 style="color:red">T</h1><a href="javascript:alert(1)">link</a><ol><li>a</li></ol><table><tr><td>c</td></tr></table>'),
        clean('<span style="font-weight:bold">B</span><iframe src="https://x"></iframe><svg><circle/></svg>'),
        clean(null),
        window.__pwn ?? null,
      ];
    });
    check('img/script dropped, b kept, attrs removed', out[0], (v) => v.replace(/<\/?div>/g, '') === '<b>ok</b>');
    check('headings to div, links unwrapped, ol to ul, tables flattened', out[1], (v) => v.startsWith('<div>T</div><div>link</div><ul><li>a</li></ul>') && !/href|style|<a|<table|<td/.test(v) && v.includes('c'));
    check('inline style to b, iframe/svg dropped', out[2], (v) => v.replace(/<\/?div>/g, '') === '<b>B</b>');
    check('null gives empty string', out[3], '');
    check('nothing executed', out[4], null);
    // paste of hostile HTML in a note
    await s.page.click(`${NOTE} .sk-editor`);
    await s.page.keyboard.press('Control+End');
    await s.page.evaluate(() => {
      const ed = document.querySelector('.win.app-sticky.sk-note-win .sk-editor');
      const dt = new DataTransfer();
      dt.setData('text/html', '<p>pasted <img src=x onerror="window.__pwn=3"><u>under</u></p><script>window.__pwn=4</script>');
      dt.setData('text/plain', 'pasted under');
      ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    const d = await untilFile(home, (x) => x.notes.some((n) => n.html.includes('pasted')), 'paste saved');
    const html = d.notes.find((n) => n.id === id1).html;
    check('pasted kept underline', html.includes('<u>under</u>'), true);
    check('pasted dropped img/script', /<img|<script|onerror/.test(html), false);
    check('no script ran', await s.page.evaluate(() => window.__pwn ?? null), null);
  });

  await section('delete with undo (hub Delete key + Undo button + Ctrl+Z)', async () => {
    const before = await SK(s, (S) => S.store.notes.length);
    await s.page.focus(`${HUB} .sk-card[data-id="${id1}"]`);
    await s.page.keyboard.press('Delete');
    await sleep(500);
    check('note removed', await SK(s, (S, id) => !S.store.get(id), id1), true);
    check('note window closed', await s.page.$$eval(NOTE, (e) => e.length), 0);
    check('undo bar shown', await s.page.isVisible(`${HUB} .sk-undo`), true);
    check('undo bar text', await s.page.textContent(`${HUB} .sk-undo-text`), 'Note deleted');
    await untilFile(home, (x) => x.notes.length === before - 1, 'delete saved');
    await s.page.click(`${HUB} .sk-undo-btn`);
    await s.page.waitForSelector(NOTE, { timeout: 8000 });
    check('restored', await SK(s, (S, id) => !!S.store.get(id), id1), true);
    check('restored note reopened (was open)', await s.page.$$eval(NOTE, (e) => e.length), 1);
    check('restored keeps formatting', await s.page.$eval(`${NOTE} .sk-editor`, (e) => e.innerHTML.includes('<b>Bold</b>')), true);
    await untilFile(home, (x) => x.notes.length === before, 'undo saved');
    // Ctrl+Z in the hub
    const other = await SK(s, (S, id) => S.store.notes.find((n) => n.id !== id).id, id1);
    await s.page.focus(`${HUB} .sk-card[data-id="${other}"]`);
    await s.page.keyboard.press('Delete');
    await sleep(300);
    check('second note removed', await SK(s, (S, id) => !S.store.get(id), other), true);
    await s.page.focus(`${HUB} .sk-list`).catch(() => {});
    await s.page.evaluate((sel) => document.querySelector(sel).focus(), `${HUB} .sk-card`);
    await s.page.keyboard.press('Control+z');
    await sleep(300);
    check('Ctrl+Z restores', await SK(s, (S, id) => !!S.store.get(id), other), true);
    check('undo bar hidden', await s.page.isVisible(`${HUB} .sk-undo`), false);
  });

  await section('Copy to Notes', async () => {
    await s.page.click(`${NOTE} .sk-more`);
    await s.page.waitForSelector('.menu', { timeout: 4000 });
    await s.page.click('.menu >> text=Copy to Notes');
    const notesDir = path.join(home, 'Documents', 'Notes');
    let file = null;
    for (let i = 0; i < 60 && !file; i++) {
      await sleep(100);
      const dirs = fs.existsSync(notesDir) ? fs.readdirSync(notesDir).filter((d) => fs.existsSync(path.join(notesDir, d, 'note.html'))) : [];
      if (dirs.length) file = path.join(notesDir, dirs[0], 'note.html');
    }
    check('note file created in Notes', !!file, true);
    const page = file ? fs.readFileSync(file, 'utf8') : '';
    check('Notes page has the title', page.includes('<title>Buy milk</title>'), true);
    check('Notes page has the formatted body', page.includes('<b>Bold</b>'), true);
    check('Notes meta present', /name="aurora-note"/.test(page), true);
    const opened = await SK(s, async (S) => {
      const r = await S.ctx.api.invoke('notes:open');
      return r.notes.map((n) => n.meta?.title);
    });
    check('notes backend lists it', opened, (v) => Array.isArray(v) && v.includes('Buy milk'));
  });

  await section('close note window marks it closed; hub reopens it', async () => {
    await SK(s, (S, id) => S.wins.notes.get(id).win.close(), id1);
    await s.page.waitForFunction((sel) => !document.querySelector(sel), NOTE, { timeout: 5000 });
    await untilFile(home, (x) => x.notes.find((n) => n.id === id1)?.open === false, 'open=false saved');
    passed++;
    await s.page.dblclick(`${HUB} .sk-card[data-id="${id1}"]`);
    await s.page.waitForSelector(NOTE, { timeout: 8000 });
    await sleep(400);
    check('only one window for the note', await s.page.$$eval(NOTE, (e) => e.length), 1);
    check('reopened on top (onTop kept)', await SK(s, (S, id) => S.wins.notes.get(id).win.alwaysOnTop, id1), true);
    await SK(s, (S) => S.store.flush());
  });

  await section('light EN screenshot', async () => {
    const file = await s.shot('sticky-light-en');
    fs.copyFileSync(file, path.join(DOCS, 'sticky-light-en.png'));
    passed++;
  });

  await s.close();
  s = null;

  await section('restart: open notes reopen, hub shown; French + dark', async () => {
    s = await launchShell({ open: ['sticky'], home, theme: 'dark', lang: 'fr' });
    watchErrors(s);
    await s.page.waitForSelector(HUB, { timeout: 30000 });
    await s.page.waitForSelector(NOTE, { timeout: 10000 });
    await sleep(500);
    check('one note window reopened', await s.page.$$eval(NOTE, (e) => e.length), 1);
    check('reopened note is the open one', await s.page.getAttribute(`${NOTE} .sk-note`, 'data-id'), id1);
    check('reopened on top', await SK(s, (S, id) => S.wins.notes.get(id).win.alwaysOnTop, id1), true);
    check('FR hub title', await s.page.textContent(`${HUB} .sk-hub-title`), 'Pense-bêtes');
    check('FR search placeholder', await s.page.getAttribute(`${HUB} .sk-search`, 'placeholder'), 'Rechercher dans les notes');
    check('FR format tooltip', await s.page.getAttribute(`${NOTE} .sk-fmt[data-cmd="bold"]`, 'aria-label'), 'Gras');
    const bg = await s.page.$eval(`${NOTE} .sk-note`, (e) => getComputedStyle(e).backgroundColor);
    check('dark green note background', bg, 'rgb(33, 61, 39)');
    const ink = await s.page.$eval(`${NOTE} .sk-editor`, (e) => getComputedStyle(e).color);
    check('dark ink is light', ink, 'rgb(243, 243, 245)');
    const file = await s.shot('sticky-dark-fr');
    fs.copyFileSync(file, path.join(DOCS, 'sticky-dark-fr.png'));
  });

  await section('note delete from note window (Ctrl+D) + FR undo', async () => {
    await s.page.click(`${NOTE} .sk-editor`);
    await s.page.keyboard.press('Control+d');
    await sleep(500);
    check('window closed', await s.page.$$eval(NOTE, (e) => e.length), 0);
    check('FR undo text', await s.page.textContent(`${HUB} .sk-undo-text`), 'Note supprimée');
    await s.page.click(`${HUB} .sk-undo-btn`);
    await s.page.waitForSelector(NOTE, { timeout: 8000 });
    passed++;
  });

  await section('backend: validation and .bak recovery', async () => {
    const bad = await SK(s, async (S) => {
      const r = [];
      for (const v of [null, { notes: 'x' }, { notes: [{ id: 5 }] }]) {
        try {
          await S.ctx.api.invoke('sticky:save', v);
          r.push('ok');
        } catch (e) {
          r.push(e.code || 'ERR');
        }
      }
      return r;
    });
    check('invalid saves rejected', bad, (v) => v.every((x) => x !== 'ok'));
    await SK(s, (S) => S.store.flush());
    await sleep(300);
    fs.writeFileSync(dataFile(home), '{ broken');
    const res = await SK(s, (S) => S.ctx.api.invoke('sticky:load'));
    check('damaged file -> backup used', res.recovered && Array.isArray(res.data?.notes) && res.data.notes.length >= 1, true);
    await SK(s, (S) => S.store.flush());
    await untilFile(home, (x) => Array.isArray(x.notes), 'rewritten after recovery');
    passed++;
  });

  await section('no console errors', async () => {
    check('console errors', errors.filter((e) => !/favicon|ERR_FILE_NOT_FOUND|net::/.test(e)), []);
  });
} catch (err) {
  failures.push(`fatal: ${err?.stack || err}`);
} finally {
  if (s) await s.close();
  fs.rmSync(home, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  ✗ ${f}`);
process.exit(failures.length ? 1 : 0);
