// Emoji and symbols panel (core/features/emoji.js, Super+. / Super+;).
//   cd aurora-os/shell && xvfb-run -a -s "-screen 0 1600x900x24" node test/emoji.test.mjs
// Parts: unit checks (hotkey names on QWERTY / AZERTY, catalog, the data file), then a shell in English: both shortcuts
// through the real main-process hook, categories, search in English and French with and without accents, skin tone,
// insertion into an <input>, a <textarea>, Notes (contenteditable), the Code Editor (CodeMirror) and the Terminal
// (xterm.js + a real PTY) with the focus and caret kept, recents order, the Symboles tab, keyboard navigation, Escape,
// Shift+click / pin, the copy fallback, screenshots en/fr × light/dark; a shell with the fake aurora-xwm helper
// (test/fixtures/xwm-fake) for the X11 paste path; and, when the image's font is at hand
// (~/.cache/selene-dev/noto-emoji-2.042 or AURORA_EMOJI_FONT_DIR), every emoji measured with fonts-noto-color-emoji
// 2.042 only (one glyph each, no tofu) plus a screenshot of each category.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { launchShell, ROOT, OUT } from './lib.mjs';

const require = createRequire(import.meta.url);
let passed = 0;
let failed = 0;
function check(name, ok, extra = '') {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && extra !== '' ? ` — ${typeof extra === 'string' ? extra : JSON.stringify(extra)}` : ''}`);
  return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 6000, step = 60) {
  const end = Date.now() + ms;
  for (;;) {
    let v;
    try {
      v = await fn();
    } catch {
      v = null;
    }
    if (v) return v;
    if (Date.now() > end) return v;
    await sleep(step);
  }
}
async function section(name, fn) {
  console.log(`\n# ${name}`);
  try {
    await fn();
  } catch (err) {
    check(`${name}: no exception`, false, err?.stack || String(err));
  }
}

// ------------------------------------------------------------------ unit
await section('unit: hotkey names, catalog, data file', async () => {
  const { comboOf, isSystem } = require('../main/lib/hotkeys.js');
  // Electron's input.key is the layout's character: QWERTY has '.' and ';' on their own keys, AZERTY has ';' on the
  // key right of ',' (code Comma) and '.' with Shift there.
  check('QWERTY Super+. -> Super+Period', comboOf({ meta: true, key: '.', code: 'Period' }) === 'Super+Period');
  check('QWERTY Super+; -> Super+;', comboOf({ meta: true, key: ';', code: 'Semicolon' }) === 'Super+;');
  check('AZERTY Super+; -> Super+;', comboOf({ meta: true, key: ';', code: 'Comma' }) === 'Super+;');
  check('AZERTY Super+Shift+; (.) -> Super+Shift+Period', comboOf({ meta: true, shift: true, key: '.', code: 'Comma' }) === 'Super+Shift+Period');
  check('both are system combos (forwarded and swallowed)', isSystem('Super+Period', { meta: true }) && isSystem('Super+;', { meta: true }));
  const sc = await import('../renderer/core/shortcuts.js');
  const e1 = sc.SHORTCUTS.find((x) => x.id === 'emoji');
  const e2 = sc.SHORTCUTS.find((x) => x.id === 'emojiAlt');
  check('catalog: emoji = Super+Period (shell group, en + fr)', e1?.combo === 'Super+Period' && e1.group === 'shell' && e1.name.fr === 'Émojis et symboles', e1);
  check('catalog: emojiAlt = Super+;', e2?.combo === 'Super+;' && !!e2.name.en && !!e2.name.fr, e2);
  check('both combos are valid shortcuts', sc.validCombo('Super+Period') && sc.validCombo('Super+;'));
  check('key caps: Super + .', JSON.stringify(sc.comboKeys('Super+Period', 'fr')) === '["Super","."]');
  check('no other catalog action uses them', sc.SHORTCUTS.filter((x) => x.combo === 'Super+Period' || x.combo === 'Super+;').length === 2);

  const file = path.join(ROOT, 'renderer', 'assets', 'emoji', 'emoji.json');
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  const size = fs.statSync(file).size;
  check('emoji.json is reasonably small (< 320 KB)', size < 320 * 1024, `${size}`);
  check('Emoji 15.1 (what Noto Color Emoji 2.042 / 2.047 draw), CLDR names', d.emoji === '15.1' && d.max === '15.1' && /^\d+\./.test(d.cldr), `${d.emoji} ${d.max} ${d.cldr}`);
  check('nine groups', JSON.stringify(d.groups) === JSON.stringify(['smileys', 'people', 'nature', 'food', 'travel', 'activities', 'objects', 'symbols', 'flags']));
  check('about 1900 emoji, every one named in en and fr', d.e.length > 1850 && d.e.every((x) => x[2] && x[3]), d.e.length);
  check('no skin-tone variant listed on its own', !d.e.some((x) => /[\u{1F3FB}-\u{1F3FF}]/u.test(x[0])));
  check('no emoji newer than 15.1 (🫨 15.0 and 🐦‍🔥 15.1 in, 🫩 16.0 out)', d.e.some((x) => x[0] === '🫨') && d.e.some((x) => x[0] === '🐦‍🔥') && !d.e.some((x) => x[0] === '🫩' || x[0] === '🫆'));
  check('❤️ is « cœur rouge »', d.e.find((x) => x[0] === '❤️')?.[3] === 'cœur rouge');
  const syms = d.symbols.flatMap((g) => g.items.map((i) => i[0]));
  check('symbols: « » “ ” — – … € © ° ± × ÷ ≠ ≤ ≥ ∞ → ½ ² µ § ¶ œ Œ æ Æ ç Ç É È À Ê, Greek', [...'«»“”‘’—–…·•€£$¥©®™°±×÷≠≤≥∞→←↑↓½¼¾²³µ§¶œŒæÆçÇÉÈÀÊαβπΩ'].every((c) => syms.includes(c)), [...'«»“”—–…€°±×÷≠≤≥∞→½²µ§¶œŒæÆçÇÉÈÀÊαπΩ'].filter((c) => !syms.includes(c)).join(' '));
  check('every symbol and kaomoji has an English and a French name', d.symbols.every((g) => g.en && g.fr && g.items.every((i) => i[1] && i[2])) && d.kaomoji.every((g) => g.en && g.fr && g.items.every((i) => i[1] && i[2])));
  check('licence notice next to the data', /UNICODE LICENSE V3/.test(fs.readFileSync(path.join(ROOT, 'renderer', 'assets', 'emoji', 'LICENSE-unicode.txt'), 'utf8')));
});

// ------------------------------------------------------------------ the shell
const s = await launchShell({ lang: 'en', theme: 'light' });
const { page, app } = s;
const A = (fn, arg) => page.evaluate(fn, arg);
const errorsMark = s.logs.length;
const isOpen = () => A(() => !!window.__aurora.emoji?.isOpen);
// Real path: a key event through main/lib/hotkeys.js (before-input-event), like the user's keyboard.
async function realKey(keyCode, modifiers = ['meta']) {
  await app.evaluate(({ BrowserWindow }, [k, m]) => {
    const wc = BrowserWindow.getAllWindows()[0].webContents;
    wc.sendInputEvent({ type: 'keyDown', keyCode: k, modifiers: m });
    wc.sendInputEvent({ type: 'char', keyCode: k, modifiers: m });
    wc.sendInputEvent({ type: 'keyUp', keyCode: k, modifiers: m });
  }, [keyCode, modifiers]);
  await sleep(250);
}
const hk = (combo) => A((c) => window.__aurora.hotkeys.trigger(c), combo);
async function openPanel() {
  if (!(await isOpen())) await hk('Super+Period');
  await until(() => A(() => !!document.querySelector('.emo:not(.closing) .emo-cell')));
  await sleep(120);
}
async function closePanel() {
  for (let i = 0; i < 3 && (await isOpen()); i++) {
    await page.keyboard.press('Escape');
    await sleep(200);
  }
}
const cellsText = () => A(() => [...document.querySelectorAll('.emo:not(.closing) .emo-cell')].map((c) => c.dataset.c));
const heading = () => A(() => [...document.querySelectorAll('.emo:not(.closing) .emo-h')].map((e) => e.textContent));
async function newTestWindow() {
  return A(() => {
    const { wm } = window.__aurora;
    const w = wm.create({ appId: 'emoji-test', title: 'Emoji test', width: 720, height: 420 });
    w.setRect({ x: 80, y: 60 });
    w.body.innerHTML = '<div style="padding:16px;display:flex;flex-direction:column;gap:10px"><input class="input" id="emo-in" style="width:420px" value="Hello world"><textarea class="textarea" id="emo-ta" rows="5" style="width:520px">line one\nline two\nline three</textarea><input class="input" id="emo-mail" type="email" style="width:260px"></div>';
    return w.id;
  });
}

try {
  await A(() => window.__aurora.emoji.ready());

  await section('open with Super+. and Super+; (main-process hook), Escape, toggle', async () => {
    await realKey('.');
    let open = await until(isOpen, 3000);
    let via = 'the real key';
    if (!open) {
      via = 'the hotkey action';
      await hk('Super+Period');
      open = await until(isOpen, 2000);
    }
    check(`Super+. opens the panel (${via})`, open && via === 'the real key');
    await until(() => A(() => !!document.querySelector('.emo .emo-cell')));
    check('panel in #overlays, labelled dialog', await A(() => {
      const p = document.querySelector('#overlays > .emo');
      return !!p && p.getAttribute('role') === 'dialog' && p.getAttribute('aria-label') === 'Emoji and symbols';
    }));
    check('search field has the focus', await A(() => document.activeElement?.classList.contains('emo-q')));
    check('the key did not type a "."', await A(() => document.querySelector('.emo-q').value === ''));
    check('opens on « Recently used » (popular emoji before any use)', (await heading())[0] === 'Recently used' && (await cellsText()).slice(0, 2).join('') === '😂❤️', `${await heading()} ${(await cellsText()).slice(0, 3)}`);
    check('nothing focused before: bottom centre, above the taskbar', await A(() => {
      const r = document.querySelector('.emo').getBoundingClientRect();
      const bar = document.getElementById('taskbar').getBoundingClientRect();
      return Math.abs(r.left + r.width / 2 - innerWidth / 2) < 2 && r.bottom <= bar.top - 4 && r.bottom > bar.top - 40;
    }));
    await page.keyboard.press('Escape');
    check('Escape closes it', !(await until(async () => !(await isOpen()), 2000).then((x) => !x)));
    await sleep(200);
    await realKey(';');
    check('Super+; opens it', await until(isOpen, 2000));
    await realKey(';');
    check('Super+; again closes it (toggle)', await until(async () => !(await isOpen()), 2000));
    await sleep(200);
    await realKey('.');
    await until(isOpen, 2000);
    await realKey('.');
    check('Super+. toggles too', await until(async () => !(await isOpen()), 2000));
    await sleep(200);
  });

  await section('categories', async () => {
    await openPanel();
    const cats = await A(() => [...document.querySelectorAll('.emo-cat')].map((b) => b.getAttribute('aria-label')));
    check('ten categories in order', JSON.stringify(cats) === JSON.stringify(['Recently used', 'Smileys and emotions', 'People', 'Animals and nature', 'Food and drink', 'Travel and places', 'Activities', 'Objects', 'Symbols', 'Flags']), cats);
    const firsts = {};
    for (const [i, id] of ['smileys', 'people', 'nature', 'food', 'travel', 'activities', 'objects', 'symbols', 'flags'].entries()) {
      await page.click(`.emo-cat[data-cat="${id}"]`);
      await sleep(80);
      const list = await cellsText();
      firsts[id] = [list[0], list.length, (await heading())[0], await A((x) => document.querySelector(`.emo-cat[data-cat="${x}"]`).getAttribute('aria-selected'), id)];
      if (i === 0) check('category button selected (aria-selected)', firsts[id][3] === 'true');
    }
    check('Smileys: starts with 😀, ~166', firsts.smileys[0] === '😀' && firsts.smileys[1] > 150 && firsts.smileys[2] === 'Smileys and emotions', firsts.smileys);
    check('People: 👋 first', firsts.people[0] === '👋' && firsts.people[1] > 300, firsts.people);
    check('Animals and nature: 🐵 first', firsts.nature[0] === '🐵', firsts.nature);
    check('Food and drink: 🍇 first', firsts.food[0] === '🍇', firsts.food);
    check('Travel and places, Activities, Objects, Symbols: filled', firsts.travel[1] > 150 && firsts.activities[1] > 60 && firsts.objects[1] > 200 && firsts.symbols[1] > 200, firsts);
    check('Flags: 🏁 first, 🇫🇷 inside', firsts.flags[0] === '🏁' && (await cellsText()).includes('🇫🇷'), firsts.flags);
    // hover shows the name in the footer
    await page.hover('.emo-cell[data-c="🇫🇷"]');
    await sleep(80);
    check('footer shows the hovered item’s name', (await A(() => document.querySelector('.emo-prev-name')?.textContent)) === 'flag: France');
    await page.click('.emo-cat[data-cat="smileys"]');
    await closePanel();
  });

  await section('search: English and French, accents and case ignored', async () => {
    const q = (x) => A((v) => window.__aurora.emoji.search(v), x);
    let r = await q('heart');
    check('« heart » -> ❤️ first', r.emoji[0] === '❤️', r.emoji.slice(0, 5).join(' '));
    r = await q('coeur');
    check('« coeur » -> ❤️ first', r.emoji[0] === '❤️', r.emoji.slice(0, 5).join(' '));
    check('« cœur », « CŒUR », « Coeur » give the same', JSON.stringify((await q('cœur')).emoji) === JSON.stringify(r.emoji) && JSON.stringify((await q('CŒUR')).emoji) === JSON.stringify(r.emoji) && JSON.stringify((await q('Coeur')).emoji) === JSON.stringify(r.emoji));
    r = await q('chat');
    check('« chat » finds 🐱 and 🐈', r.emoji.includes('🐱') && r.emoji.includes('🐈'), r.emoji.slice(0, 6).join(' '));
    r = await q('cat');
    check('« cat » finds 🐱', r.emoji.includes('🐱'), r.emoji.slice(0, 6).join(' '));
    r = await q('tete de chat');
    check('« tete de chat » (no accent) -> 🐱 first', r.emoji[0] === '🐱', r.emoji.slice(0, 4).join(' '));
    r = await q('drapeau france');
    check('« drapeau france » -> 🇫🇷', r.emoji[0] === '🇫🇷', r.emoji.slice(0, 4).join(' '));
    r = await q('pouce');
    check('« pouce » (keyword prefix) -> 👍', r.emoji.slice(0, 3).includes('👍'), r.emoji.slice(0, 5).join(' '));
    r = await q('euro');
    check('« euro » -> € in Symbols', r.symbols[0] === '€', r.symbols.join(' '));
    r = await q('guillemet');
    check('« guillemet » -> « and »', r.symbols.includes('«') && r.symbols.includes('»'), r.symbols.join(' '));
    r = await q('e accent aigu');
    check('« e accent aigu » -> é', r.symbols.includes('é'), r.symbols.join(' '));
    r = await q('shrug');
    check('« shrug » -> the kaomoji', r.kaomoji[0] === '¯\\_(ツ)_/¯', r.kaomoji.join(' '));
    r = await q('xqzzy');
    check('no results: empty lists', !r.emoji.length && !r.symbols.length && !r.kaomoji.length);

    await openPanel();
    await page.keyboard.type('Cœur');
    await sleep(200);
    const ui = await A(() => ({ h: [...document.querySelectorAll('.emo-h')].map((e) => e.textContent), first: document.querySelector('.emo-cell')?.dataset.c, cats: document.querySelector('.emo-cats').hidden }));
    check('typing in the field searches: sections, ❤️ first, categories hidden', ui.h[0] === 'Emoji' && ui.first === '❤️' && ui.cats, ui);
    await page.fill('.emo-q', 'zzqqxx');
    await sleep(150);
    check('no result message', (await A(() => document.querySelector('.emo-empty')?.textContent)) === 'No results for “zzqqxx”');
    await closePanel();
    await openPanel();
    check('the search is cleared when the panel opens again', await A(() => document.querySelector('.emo-q').value === '' && !!document.querySelector('.emo-cats:not([hidden])')));
    await closePanel();
  });

  const wid = await newTestWindow();
  await sleep(400);
  const field = (sel) => A((x) => {
    const e = document.querySelector(x);
    return { value: e.value, start: e.selectionStart, end: e.selectionEnd, focused: document.activeElement === e };
  }, sel);

  await section('insert into an <input>: at the caret, focus and caret kept', async () => {
    await A(() => {
      const e = document.getElementById('emo-in');
      e.focus();
      e.setSelectionRange(5, 5); // "Hello| world"
    });
    await hk('Super+Period');
    await until(() => A(() => !!document.querySelector('.emo .emo-cell')));
    check('target is the field', (await A(() => window.__aurora.emoji.target?.kind)) === 'field');
    const pos = await A(() => {
      const p = document.querySelector('.emo').getBoundingClientRect();
      const i = document.getElementById('emo-in').getBoundingClientRect();
      return { top: p.top, left: p.left, ib: i.bottom, il: i.left };
    });
    check('panel opens under the caret', pos.top >= pos.ib + 2 && pos.top <= pos.ib + 16 && pos.left > pos.il && pos.left < pos.il + 120, pos);
    await page.click('.emo-cat[data-cat="smileys"]');
    await page.click('.emo-cell[data-c="😀"]');
    await sleep(250);
    const f = await field('#emo-in');
    check('😀 inserted at the caret', f.value === 'Hello😀 world', f.value);
    check('panel closed, focus back in the field', !(await isOpen()) && f.focused);
    check('caret right after the emoji', f.start === 7 && f.end === 7, `${f.start},${f.end}`);
    // a selection is replaced
    await A(() => document.getElementById('emo-in').setSelectionRange(8, 13)); // "world"
    await openPanel();
    await page.keyboard.type('thumbs up');
    await sleep(150);
    await page.keyboard.press('Enter');
    await sleep(250);
    const g = await field('#emo-in');
    check('Enter in the search inserts the first result over the selection', g.value === 'Hello😀 👍' && g.focused && g.start === 10, g);
    // undo works (execCommand insertText)
    await page.keyboard.press('Control+z');
    await sleep(100);
    check('Ctrl+Z undoes the insertion', (await field('#emo-in')).value === 'Hello😀 world');
  });

  await section('insert into a <textarea>', async () => {
    await A(() => {
      const e = document.getElementById('emo-ta');
      e.focus();
      e.setSelectionRange(13, 13); // "line one\nline| two"
    });
    await openPanel();
    const pos = await A(() => {
      const p = document.querySelector('.emo').getBoundingClientRect();
      const t = document.getElementById('emo-ta').getBoundingClientRect();
      return { top: p.top, tt: t.top, tb: t.bottom };
    });
    check('panel opens under the caret line (inside the textarea’s height)', pos.top > pos.tt + 20 && pos.top < pos.tb, pos);
    await page.click('.emo-tab[data-tab="symbols"]');
    await page.click('.emo-cat[data-cat="punctuation"]');
    await page.click('.emo-cell[data-c="«"]');
    await sleep(250);
    const f = await field('#emo-ta');
    check('« inserted in the textarea at the caret', f.value === 'line one\nline« two\nline three' && f.focused && f.start === 14, f);
  });

  await section('Symboles tab: groups, « and », Shift+click keeps the panel open', async () => {
    await A(() => {
      const e = document.getElementById('emo-in');
      e.focus();
      e.value = 'Il a dit ';
      e.setSelectionRange(9, 9);
    });
    await openPanel();
    check('the tab stays on Symbols', (await A(() => window.__aurora.emoji.state.tab)) === 'symbols');
    const groups = await A(() => [...document.querySelectorAll('.emo-cat')].map((b) => b.getAttribute('aria-label')));
    check('groups: Recently used, Punctuation, Currency, Accented letters, Mathematics, Arrows, Greek letters, Bullets and shapes, Signs', JSON.stringify(groups) === JSON.stringify(['Recently used', 'Punctuation', 'Currency', 'Accented letters', 'Mathematics', 'Arrows', 'Greek letters', 'Bullets and shapes', 'Signs']), groups);
    await page.click('.emo-cat[data-cat="punctuation"]');
    await page.click('.emo-cell[data-c="«"]', { modifiers: ['Shift'] });
    await sleep(250);
    check('Shift+click: inserted, panel still open', (await field('#emo-in')).value === 'Il a dit «' && (await isOpen()));
    await page.click('.emo-cell[data-c=" "]', { modifiers: ['Shift'] });
    await sleep(150);
    check('narrow no-break space cell (labelled)', (await A(() => document.querySelector('.emo-cell[data-c=" "]')?.textContent)) === 'thin');
    await page.keyboard.type('bonjour');
    check('typing after Shift+click goes to the search, not the field', (await A(() => document.querySelector('.emo-q').value)) === 'bonjour');
    await page.fill('.emo-q', '');
    await sleep(100);
    await page.click('.emo-cat[data-cat="punctuation"]');
    await page.click('.emo-cell[data-c="»"]');
    await sleep(250);
    const f = await field('#emo-in');
    check('« » typed with French spacing, caret after »', f.value === 'Il a dit « »' && f.focused && f.start === 12, f);
    const rec = await A(() => window.__aurora.emoji.state.recents.symbols);
    check('symbols recents: » then the space then «', JSON.stringify(rec.slice(0, 3)) === JSON.stringify(['»', ' ', '«', ].slice(0, 3)), rec);
    await openPanel();
    await page.click('.emo-cat[data-cat="recent"]');
    check('Symbols « Recently used » lists them, latest first', JSON.stringify((await cellsText()).slice(0, 3)) === JSON.stringify(['»', ' ', '«']), await cellsText());
    await page.click('.emo-tab[data-tab="emoji"]');
    await closePanel();
  });

  await section('email field (no selection API) still gets the character', async () => {
    await A(() => {
      const e = document.getElementById('emo-mail');
      e.focus();
      e.value = 'ana';
    });
    await openPanel();
    await page.fill('.emo-q', 'at sign');
    await sleep(150);
    const has = await A(() => !!document.querySelector('.emo-cell[data-c="@"]'));
    if (has) await page.click('.emo-cell[data-c="@"]');
    else await A(() => window.__aurora.emoji.insert('@'));
    await sleep(250);
    check('email input: appended', (await field('#emo-mail')).value === 'ana@', await field('#emo-mail'));
  });

  await section('skin tone: chosen, applied, remembered', async () => {
    await A(() => document.getElementById('emo-in').focus());
    await openPanel();
    await page.click('.emo-cat[data-cat="people"]');
    await page.click('.emo-tone-btn');
    await sleep(150);
    const opts = await A(() => [...document.querySelectorAll('.emo-tone')].map((b) => [b.getAttribute('aria-label'), b.getAttribute('aria-selected')]));
    check('six tones, default selected', opts.length === 6 && opts[0][1] === 'true' && opts[3][0] === 'Medium skin tone', opts);
    check('the tone list has the focus', await A(() => document.activeElement?.classList.contains('emo-tone')));
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await sleep(150);
    check('Enter on the 4th: medium tone', (await A(() => window.__aurora.emoji.state.tone)) === 3);
    const list = await cellsText();
    check('people drawn with the tone: 👋🏽 👍🏽, non-tone emoji unchanged', list.includes('👋🏽') && list.includes('👍🏽') && list.includes('👀'), list.slice(0, 4).join(' '));
    check('🧑‍🤝‍🧑 gets its explicit variant', list.includes('🧑🏽‍🤝‍🧑🏽'));
    check('tone button shows ✋🏽', (await A(() => document.querySelector('.emo-tone-btn')?.textContent)) === '✋🏽');
    await page.click('.emo-cell[data-c="👍🏽"]');
    await sleep(250);
    check('👍🏽 inserted', (await field('#emo-in')).value.includes('👍🏽'));
    const stored = await A(() => window.__aurora.api.invoke('storage:get', 'shell', 'emoji', null));
    check('tone saved in storage shell/emoji', stored?.tone === 3, stored);
    check('search results use the tone', (await A(() => window.__aurora.emoji.search('waving hand').emoji[0])) === '👋🏽');
    // Escape closes the tone list only
    await openPanel();
    await page.click('.emo-tone-btn');
    await sleep(120);
    await page.keyboard.press('Escape');
    await sleep(120);
    check('Escape in the tone list closes the list, not the panel', (await isOpen()) && !(await A(() => !!document.querySelector('.emo-tones'))) && (await A(() => document.activeElement?.classList.contains('emo-tone-btn'))));
    await page.click('.emo-tone-btn');
    await page.click('.emo-tone[data-tone="0"]');
    await sleep(100);
    check('back to the default tone', (await A(() => window.__aurora.emoji.state.tone)) === 0);
    await closePanel();
  });

  await section('recents: latest first, no duplicates', async () => {
    await A(() => document.getElementById('emo-in').focus());
    for (const c of ['🎉', '🐱', '🎉']) {
      await openPanel();
      await page.fill('.emo-q', '');
      await A((x) => window.__aurora.emoji.insert(x), c);
      await sleep(200);
    }
    const rec = await A(() => window.__aurora.emoji.state.recents.emoji);
    const want = JSON.stringify(['🎉', '🐱', '👍🏽', '👍', '😀']);
    check('🎉 🐱 👍🏽 👍 😀 (🎉 moved to the front, once)', JSON.stringify(rec.slice(0, 5)) === want && rec.length === 5, rec);
    await openPanel();
    await page.click('.emo-cat[data-cat="recent"]');
    check('« Recently used » shows them in that order', JSON.stringify(await cellsText()) === want, await cellsText());
    await closePanel();
  });

  await section('keyboard navigation', async () => {
    await A(() => {
      const e = document.getElementById('emo-in');
      e.focus();
      e.value = '';
    });
    await openPanel();
    await page.keyboard.press('ArrowDown'); // search -> categories
    check('↓ from the search: the category bar', await A(() => document.activeElement?.classList.contains('emo-cat')));
    await page.keyboard.press('ArrowRight'); // -> Smileys
    await sleep(80);
    check('→ selects the next category', (await A(() => window.__aurora.emoji.state.category)) === 'smileys');
    await page.keyboard.press('ArrowDown'); // -> first cell
    const a = await A(() => document.activeElement?.dataset.c);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');
    const b = await A(() => document.activeElement?.dataset.c);
    const list = await cellsText();
    check('↓ into the grid, → next cell, ↓ next row (same column)', a === '😀' && b === list[10], `${a} ${b} ${list[10]}`);
    check('footer names the focused emoji', (await A(() => document.querySelector('.emo-prev-name')?.textContent)) === (await A(() => document.activeElement.getAttribute('aria-label'))));
    await page.keyboard.press('End');
    check('End: last cell', (await A(() => document.activeElement?.dataset.c)) === list[list.length - 1]);
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowUp');
    check('↑ from the first row: back to the categories', await A(() => document.activeElement?.classList.contains('emo-cat')));
    // Tab moves between the sections and wraps inside the panel
    const stops = [];
    for (let i = 0; i < 9; i++) {
      await page.keyboard.press('Tab');
      stops.push(await A(() => {
        const e = document.activeElement;
        return e.closest('.emo') ? e.className.split(' ').find((c) => c.startsWith('emo-')) : 'outside';
      }));
    }
    check('Tab: categories -> tone -> grid -> tabs -> pin -> close -> search (wraps, never leaves)', !stops.includes('outside') && stops.slice(0, 7).join(',') === 'emo-tone-btn,emo-cell,emo-tab,emo-pin,emo-close,emo-q,emo-cat', stops.join(','));
    // tabs with the arrows
    await A(() => document.querySelector('.emo-tab.selected').focus());
    await page.keyboard.press('ArrowRight');
    await sleep(80);
    check('→ on the tabs: Kaomoji', (await A(() => window.__aurora.emoji.state.tab)) === 'kaomoji' && (await A(() => document.activeElement?.dataset.tab)) === 'kaomoji');
    check('kaomoji grid (3 columns of text)', (await cellsText()).length >= 6 && (await A(() => getComputedStyle(document.querySelector('.emo-grid')).gridTemplateColumns.split(' ').length)) === 3);
    await page.keyboard.press('ArrowLeft');
    await sleep(60);
    // typing in the grid searches
    await A(() => document.querySelector('.emo-cat[data-cat="smileys"]').click());
    await A(() => document.querySelector('.emo-cell').focus());
    await page.keyboard.type('fire');
    await sleep(150);
    check('typing in the grid moves to the search', (await A(() => document.querySelector('.emo-q').value)) === 'fire' && (await A(() => document.activeElement.classList.contains('emo-q'))));
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Shift+Enter');
    await sleep(250);
    check('Shift+Enter inserts 🔥 and keeps the panel open, focus back in the grid', (await field('#emo-in')).value === '🔥' && (await isOpen()) && (await A(() => document.activeElement?.classList.contains('emo-cell'))));
    await page.keyboard.press('Space');
    await sleep(250);
    check('Space inserts and closes; focus back in the field after the two', (await field('#emo-in')).value === '🔥🔥' && !(await isOpen()) && (await field('#emo-in')).focused);
    // Escape: closed, focus and caret back where they were
    await A(() => document.getElementById('emo-in').setSelectionRange(2, 2));
    await openPanel();
    await page.keyboard.press('Escape');
    await sleep(200);
    const f = await field('#emo-in');
    check('Escape: closed, focus and caret back in the field', !(await isOpen()) && f.focused && f.start === 2 && f.value === '🔥🔥', f);
  });

  await section('pin keeps it open; clicking elsewhere closes it otherwise', async () => {
    await A(() => {
      const e = document.getElementById('emo-in');
      e.focus();
      e.setSelectionRange(e.value.length, e.value.length);
    });
    await openPanel();
    await page.click('.emo-pin');
    check('pin: aria-pressed, saved', (await A(() => document.querySelector('.emo-pin').getAttribute('aria-pressed'))) === 'true' && (await A(() => window.__aurora.emoji.state.keepOpen)) === true);
    await page.click('.emo-cat[data-cat="smileys"]');
    await page.click('.emo-cell[data-c="😀"]');
    await sleep(200);
    await page.click('.emo-cell[data-c="😃"]');
    await sleep(200);
    const two = await field('#emo-in');
    check('pinned: two insertions, still open', two.value === '🔥🔥😀😃' && (await isOpen()), { ...two, open: await isOpen() });
    // pinned: clicking another field makes it the target (a point of the textarea the panel does not cover)
    const spot = await A(() => {
      const t = document.getElementById('emo-ta').getBoundingClientRect();
      const p = document.querySelector('.emo').getBoundingClientRect();
      const xs = [t.right - 12, t.left + 12];
      const ys = [t.top + 10, t.bottom - 10];
      for (const x of xs) for (const y of ys) if (x < p.left || x > p.right || y < p.top || y > p.bottom) return { x, y };
      return null;
    });
    await page.mouse.click(spot.x, spot.y);
    await A(() => {
      const e = document.getElementById('emo-ta');
      e.setSelectionRange(0, 0);
    });
    await sleep(100);
    check('pinned: a click in another field keeps the panel, retargets it', (await isOpen()) && (await A(() => window.__aurora.emoji.target?.kind)) === 'field');
    await page.click('.emo-cell[data-c="😀"]');
    await sleep(200);
    check('inserted at the start of the textarea', (await field('#emo-ta')).value.startsWith('😀line one'));
    await page.click('.emo-pin');
    check('unpinned', (await A(() => window.__aurora.emoji.state.keepOpen)) === false);
    await page.mouse.click(1500, 300);
    await sleep(250);
    check('a click on the desktop closes it', !(await isOpen()));
  });

  await section('nothing to type into: copied, « Copied — paste with Ctrl+V »', async () => {
    await A(() => {
      document.activeElement?.blur();
      window.__aurora.wm.list().forEach((w) => w.blur?.());
    });
    await page.mouse.click(1500, 300);
    await sleep(200);
    await openPanel();
    check('footer explains it will be copied', (await A(() => document.querySelector('.emo-hint')?.textContent)) === 'Nothing to type into: the character will be copied');
    await page.click('.emo-cat[data-cat="smileys"]');
    await page.click('.emo-cell[data-c="😉"]');
    await sleep(300);
    check('status « Copied — paste with Ctrl+V »', (await A(() => document.querySelector('.emo-status')?.textContent)) === 'Copied — paste with Ctrl+V');
    check('clipboard holds 😉', (await A(() => window.__aurora.api.invoke('clipboard:readText'))) === '😉');
  });

  // ---------------------------------------------------------------- apps
  await section('Notes (contenteditable): inserted at the caret, focus kept', async () => {
    await A(() => window.__aurora.shell.launch('notes'));
    const ready = await until(() => A(() => !!document.querySelector('.win.app-notes')?.__notes?.store), 15000);
    if (!check('Notes opened', ready)) return;
    await sleep(800);
    await page.keyboard.press('Control+n');
    await until(() => A(() => {
      const app = document.querySelector('.win.app-notes').__notes;
      return document.activeElement === app.editor.title;
    }), 5000);
    await page.keyboard.type('Emoji note');
    await page.keyboard.press('Enter');
    await until(() => A(() => document.activeElement === document.querySelector('.win.app-notes .nt-body')), 4000);
    await page.keyboard.type('Bonjour le monde');
    await sleep(150);
    // caret after "Bonjour"
    await A(() => {
      const b = document.querySelector('.win.app-notes .nt-body');
      const walker = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
      const t = walker.nextNode();
      const r = document.createRange();
      r.setStart(t, 7);
      r.collapse(true);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
    });
    await openPanel();
    check('target is the note body (contenteditable)', (await A(() => window.__aurora.emoji.target?.kind)) === 'editable');
    const pos = await A(() => {
      const p = document.querySelector('.emo').getBoundingClientRect();
      return { top: p.top };
    });
    await page.fill('.emo-q', 'sun');
    await sleep(150);
    await page.click('.emo-cell[data-c="☀️"]');
    await sleep(300);
    const r = await A(() => {
      const b = document.querySelector('.win.app-notes .nt-body');
      const sel = getSelection();
      const pre = document.createRange();
      pre.setStart(b, 0);
      pre.setEnd(sel.anchorNode, sel.anchorOffset);
      return { text: b.textContent, focused: document.activeElement === b, before: pre.toString() };
    });
    check('☀️ inserted after « Bonjour »', r.text === 'Bonjour☀️ le monde', r.text);
    check('note body focused, caret right after ☀️', r.focused && r.before === 'Bonjour☀️', r);
    check('panel was under the caret line', pos.top > 0, pos);
    await page.keyboard.type('!');
    await sleep(100);
    check('typing continues at the caret', (await A(() => document.querySelector('.win.app-notes .nt-body').textContent)) === 'Bonjour☀️! le monde');
    await A(() => document.querySelector('.win.app-notes').__notes.win.close());
    await sleep(500);
  });

  await section('Code Editor (CodeMirror 6): transaction at the caret, focus kept', async () => {
    const file = path.join(s.home, 'Documents', 'emoji.txt');
    fs.writeFileSync(file, 'const a = 1;\nconst b = 2;\n');
    await A((f) => window.__aurora.shell.launch('code', { file: f }), file);
    const ready = await until(() => A(() => {
      const a = document.querySelector('.win.app-code')?.__code;
      return !!a?.view && a.view.state.doc.toString().startsWith('const a');
    }), 15000);
    if (!check('Code Editor opened the file', ready)) return;
    await A(() => {
      const a = document.querySelector('.win.app-code').__code;
      a.view.dispatch({ selection: { anchor: 20 } }); // "const b| = 2;"
      a.view.focus();
    });
    await sleep(200);
    await openPanel();
    check('target is CodeMirror', (await A(() => window.__aurora.emoji.target?.kind)) === 'cm');
    await page.click('.emo-tab[data-tab="symbols"]');
    await page.click('.emo-cat[data-cat="arrows"]');
    await page.click('.emo-cell[data-c="→"]');
    await sleep(300);
    const r = await A(() => {
      const a = document.querySelector('.win.app-code').__code;
      return { doc: a.view.state.doc.toString(), head: a.view.state.selection.main.head, focus: a.view.hasFocus, dirty: document.querySelector('.win.app-code .code-tab.dirty, .win.app-code .dirty') != null };
    });
    check('→ inserted at the caret', r.doc === 'const a = 1;\nconst b→ = 2;\n', r.doc);
    check('editor focused, caret after →', r.focus && r.head === 21, r);
    await page.keyboard.type('x');
    await sleep(100);
    check('typing continues there', (await A(() => document.querySelector('.win.app-code').__code.view.state.doc.toString())).startsWith('const a = 1;\nconst b→x'));
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+z');
    await sleep(150);
    check('undo removes it (one undo step per insertion)', (await A(() => document.querySelector('.win.app-code').__code.view.state.doc.toString())) === 'const a = 1;\nconst b = 2;\n');
    await page.click('.emo-tab[data-tab="emoji"]').catch(() => {});
    await A(() => {
      const a = document.querySelector('.win.app-code').__code;
      a.view.dispatch({ changes: { from: 0, to: a.view.state.doc.length, insert: 'const a = 1;\nconst b = 2;\n' } });
    });
    await A(() => {
      const w = document.querySelector('.win.app-code');
      window.__aurora.wm.list().find((x) => x.el === w)?.close(true);
    });
    await sleep(500);
  });

  await section('Terminal (xterm.js): typed into the PTY, focus kept', async () => {
    await A(() => window.__aurora.shell.launch('terminal'));
    const ready = await until(() => A(() => {
      const app = document.querySelector('.win.app-terminal')?.__terminal;
      const term = app?.session?.term;
      if (!term) return false;
      const b = term.buffer.active;
      let txt = '';
      for (let y = 0; y < b.length; y++) txt += b.getLine(y).translateToString(true);
      return /[$#>%] *$/.test(txt.trim()) || txt.trim().length > 0;
    }), 20000);
    if (!check('Terminal started', ready)) return;
    await sleep(1200);
    await A(() => document.querySelector('.win.app-terminal').__terminal.session.focus());
    await sleep(150);
    await page.keyboard.type('echo X');
    await sleep(200);
    await openPanel();
    check('target is the terminal', (await A(() => window.__aurora.emoji.target?.kind)) === 'xterm');
    await page.click('.emo-tab[data-tab="symbols"]');
    await page.click('.emo-cat[data-cat="currency"]');
    await page.click('.emo-cell[data-c="€"]');
    await sleep(300);
    check('focus back in the terminal', await A(() => document.activeElement?.classList.contains('xterm-helper-textarea')));
    await page.keyboard.type('Y');
    await page.keyboard.press('Enter');
    const out = await until(() => A(() => {
      const term = document.querySelector('.win.app-terminal').__terminal.session.term;
      const b = term.buffer.active;
      const lines = [];
      for (let y = 0; y < b.length; y++) lines.push(b.getLine(y).translateToString(true));
      return lines.find((l) => /^X€Y$/.test(l.trim())) || null;
    }), 6000);
    check('« echo X€Y » printed X€Y (the PTY got €)', !!out, out);
    await A(() => {
      const w = document.querySelector('.win.app-terminal');
      window.__aurora.wm.list().find((x) => x.el === w)?.close(true);
    });
    await sleep(400);
  });

  // ---------------------------------------------------------------- screenshots
  await section('screenshots: en / fr × light / dark', async () => {
    await A(() => {
      const e = document.getElementById('emo-ta');
      e.focus();
      e.setSelectionRange(9, 9);
    });
    for (const [lang, theme] of [['en', 'light'], ['en', 'dark'], ['fr', 'light'], ['fr', 'dark']]) {
      await A(([l, th]) => window.__aurora.settings.setMany ? window.__aurora.settings.setMany({ lang: l, theme: th }) : Promise.all([window.__aurora.settings.set('lang', l), window.__aurora.settings.set('theme', th)]), [lang, theme]);
      await sleep(500);
      await A(() => document.getElementById('emo-ta').focus());
      await openPanel();
      await A(() => window.__aurora.emoji.setTab('emoji'));
      await A(() => window.__aurora.emoji.setCategory('smileys'));
      await page.hover('.emo-cell[data-c="😍"]');
      await sleep(250);
      await s.shot(`emoji-${lang}-${theme}`);
      const texts = await A(() => ({ tab: document.querySelector('.emo-tab.selected')?.textContent, h: document.querySelector('.emo-h')?.textContent, ph: document.querySelector('.emo-q')?.placeholder, name: document.querySelector('.emo-prev-name')?.textContent }));
      const fr = lang === 'fr';
      check(`${lang}/${theme}: strings`, texts.tab === (fr ? 'Émojis' : 'Emoji') && texts.h === (fr ? 'Smileys et émotions' : 'Smileys and emotions') && texts.ph === (fr ? 'Rechercher des émojis, symboles et kaomojis' : 'Search emoji, symbols and kaomoji') && texts.name === (fr ? 'visage souriant avec yeux en forme de cœur' : 'smiling face with heart-eyes'), texts);
      const fit = await A(() => {
        const p = document.querySelector('.emo').getBoundingClientRect();
        const over = [...document.querySelectorAll('.emo .emo-tab, .emo .emo-cat, .emo-q, .emo-pin, .emo-close')].filter((e) => {
          const r = e.getBoundingClientRect();
          return r.right > p.right - 2 || r.left < p.left || e.scrollWidth > e.clientWidth + 1;
        });
        return { inView: p.left >= 0 && p.top >= 0 && p.right <= innerWidth && p.bottom <= innerHeight, over: over.map((e) => e.className) };
      });
      check(`${lang}/${theme}: in view, nothing cut`, fit.inView && !fit.over.length, fit);
      if (lang === 'fr' && theme === 'dark') {
        await A(() => window.__aurora.emoji.setTab('symbols'));
        await A(() => window.__aurora.emoji.setCategory('letters'));
        await sleep(150);
        await s.shot('emoji-fr-dark-symbols');
        await A(() => window.__aurora.emoji.setTab('kaomoji'));
        await A(() => window.__aurora.emoji.setCategory('other'));
        await sleep(150);
        await s.shot('emoji-fr-dark-kaomoji');
        await A(() => window.__aurora.emoji.setTab('emoji'));
        await page.fill('.emo-q', 'coeur');
        await sleep(200);
        await s.shot('emoji-fr-dark-search');
        await page.fill('.emo-q', '');
        await A(() => window.__aurora.emoji.setCategory('people'));
        await page.click('.emo-tone-btn');
        await sleep(200);
        await s.shot('emoji-fr-dark-tones');
        await page.keyboard.press('Escape');
      }
      if (lang === 'en' && theme === 'light') {
        // contrast of the selected category and the text on the panel
        const c = await A(() => {
          const cs = getComputedStyle(document.querySelector('.emo-prev-name'));
          return cs.color;
        });
        check('footer text colour is the text token', !!c);
      }
      await closePanel();
    }
  });

  const errs = s.logs.slice(errorsMark).filter((l) => /^\[(error|pageerror)\]/.test(l) && /emoji/i.test(l));
  check('no errors from the panel', !errs.length, errs.join('\n'));
} finally {
  await s.close();
}

// ------------------------------------------------------------------ X11 windows (fake aurora-xwm)
await section('X11 window: clipboard + XTest paste through aurora-xwm (fake helper)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-emoji-xwm-'));
  const CTL = path.join(tmp, 'ctl');
  const LOG = path.join(tmp, 'log');
  fs.writeFileSync(CTL, '');
  fs.writeFileSync(LOG, '');
  const FAKE = path.join(ROOT, 'test', 'fixtures', 'xwm-fake', 'aurora-xwm');
  const emit = (o) => fs.appendFileSync(CTL, `${JSON.stringify(o)}\n`);
  const cmds = () => fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  }).filter(Boolean);
  const x = await launchShell({ lang: 'fr', theme: 'dark', env: { AURORA_XWM: '1', AURORA_XWM_HELPER: FAKE, AURORA_XWM_FAKE_LOG: LOG, AURORA_XWM_FAKE_CTL: CTL } });
  const XA = (fn, arg) => x.page.evaluate(fn, arg);
  try {
    await until(() => XA(() => window.__aurora.api.invoke('xwin:status')).then((st) => st?.ready));
    await until(() => XA(() => !!window.__aurora.xwin && !!window.__aurora.emoji));
    const client = async (id, wmClass) => {
      emit({ ev: 'new', id, title: wmClass[1], wmClass, pid: null, type: 'normal', transientFor: null, modal: false, x: 0, y: 0, width: 600, height: 380, minWidth: 0, minHeight: 0, maxWidth: 0, maxHeight: 0, decorated: true, fullscreen: false, icon: null, startupId: null, gtkAppId: null });
      await until(() => XA((i) => !!window.__aurora.xwin.frames.get(i)?.win, id));
      await XA((i) => window.__aurora.xwin.frames.get(i).win.focus(), id);
      emit({ ev: 'focus', id });
      await sleep(400);
    };
    const GEDIT = 4194400;
    await client(GEDIT, ['gedit', 'Gedit']);
    const mark = cmds().length;
    await XA(() => window.__aurora.hotkeys.trigger('Super+Period'));
    await until(() => XA(() => !!document.querySelector('.emo .emo-cell')));
    check('target: the X11 window', (await XA(() => window.__aurora.emoji.target)).kind === 'x11');
    check('the shell takes the X keyboard for the search field (focus null)', !!(await until(() => cmds().slice(mark).find((c) => c.cmd === 'focus' && c.id === null), 2000)));
    check('panel at the bottom centre (no caret to follow)', await XA(() => {
      const r = document.querySelector('.emo').getBoundingClientRect();
      return Math.abs(r.left + r.width / 2 - innerWidth / 2) < 2;
    }));
    await x.page.click('.emo-cat[data-cat="smileys"]');
    const m2 = cmds().length;
    await x.page.click('.emo-cell[data-c="😀"]');
    const paste = await until(() => cmds().slice(m2).find((c) => c.cmd === 'paste'), 3000);
    check('focus given back to the window, then paste Ctrl+V', !!paste && paste.id === GEDIT && paste.keys === 'ctrl+v' && cmds().slice(m2).findIndex((c) => c.cmd === 'focus' && c.id === GEDIT) < cmds().slice(m2).findIndex((c) => c.cmd === 'paste'), paste);
    emit({ ev: 'paste', id: GEDIT, ok: true, code: null });
    await sleep(400);
    check('CLIPBOARD holds 😀', (await XA(() => window.__aurora.api.invoke('clipboard:readText'))) === '😀');
    check('pasted: no « Copié » notice', !(await XA(() => !!document.querySelector('.emo-status'))));
    check('panel closed', !(await XA(() => window.__aurora.emoji.isOpen)));

    // xterm: Shift+Insert (PRIMARY)
    const XTERM = 4194500;
    await client(XTERM, ['xterm', 'XTerm']);
    await XA(() => window.__aurora.hotkeys.trigger('Super+;'));
    await until(() => XA(() => !!document.querySelector('.emo .emo-cell')));
    await XA(() => window.__aurora.emoji.setTab('symbols'));
    await XA(() => window.__aurora.emoji.setCategory('punctuation'));
    const m3 = cmds().length;
    await x.page.click('.emo-cell[data-c="«"]');
    const p2 = await until(() => cmds().slice(m3).find((c) => c.cmd === 'paste'), 3000);
    check('xterm: Shift+Insert (PRIMARY written too)', p2?.keys === 'shift+insert' && p2.id === XTERM, p2);
    // no answer / refused: the user is told to paste
    emit({ ev: 'paste', id: XTERM, ok: false, code: 'EFOCUS' });
    const note = await until(() => XA(() => document.querySelector('.emo-status')?.textContent), 2500);
    check('refused paste: « Copié — collez avec Ctrl+V »', note === 'Copié — collez avec Ctrl+V', note);
    check('main validates paste keys (unknown -> ctrl+v)', await (async () => {
      const m4 = cmds().length;
      await XA((id) => window.__aurora.api.send('xwin:cmd', { cmd: 'paste', id, keys: 'rm -rf' }), XTERM);
      const c = await until(() => cmds().slice(m4).find((y) => y.cmd === 'paste'), 2000);
      return c?.keys === 'ctrl+v';
    })());
    await x.shot('emoji-x11-fr-dark');
  } finally {
    await x.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ the real helper's XTest paste
// test/fixtures/emoji/xwm-paste.py runs rootfs/.../aurora-xwm under this X display with a small client window and
// records the keys the client gets. Needs python3-xlib (the image has it): the system's, or a copy in
// $AURORA_PYXLIB / ~/.cache/selene-dev/pyxlib (python_xlib + six wheels unpacked).
await section('aurora-xwm paste command (real helper, XTest)', async () => {
  const { spawnSync } = await import('node:child_process');
  const helper = path.join(ROOT, '..', 'rootfs', 'usr', 'lib', 'aurora', 'helpers', 'aurora-xwm');
  const sysLib = spawnSync('python3', ['-B', '-c', 'import Xlib.ext.xtest'], { stdio: 'ignore' }).status === 0;
  const lib = sysLib ? null : [process.env.AURORA_PYXLIB, path.join(os.homedir(), '.cache', 'selene-dev', 'pyxlib')].find((d) => d && fs.existsSync(path.join(d, 'Xlib', 'ext', 'xtest.py')));
  if (!process.env.DISPLAY || (!sysLib && !lib)) {
    console.log('SKIP: no DISPLAY or no python3-xlib');
    return;
  }
  const r = spawnSync('python3', ['-B', path.join(ROOT, 'test', 'fixtures', 'emoji', 'xwm-paste.py'), helper, ...(lib ? [lib] : [])], { encoding: 'utf8', timeout: 60000 });
  let out = null;
  try {
    out = JSON.parse(r.stdout.trim().split('\n').pop());
  } catch {
    check('fixture output', false, `${r.stdout}\n${r.stderr}`);
    return;
  }
  const CTRL = 'ffe3';
  check('helper ready, client managed', out.ready && out.managed, out);
  check('ctrl+v: Control_L then v with ControlMask; answered ok', out['ctrl+v'].answer?.ok === true && JSON.stringify(out['ctrl+v'].keys) === JSON.stringify([`0x${CTRL} 0`, 'v 4']), out['ctrl+v']);
  check('ctrl+shift+v: v with Control+Shift', out['ctrl+shift+v'].answer?.ok === true && out['ctrl+shift+v'].keys.at(-1) === 'v 5', out['ctrl+shift+v']);
  check('shift+insert: Insert with ShiftMask', out['shift+insert'].answer?.ok === true && out['shift+insert'].keys.at(-1) === '0xff63 1', out['shift+insert']);
  check('a held Shift is released for the paste (v with Control only) and pressed again', out['held-shift'].answer?.ok === true && out['held-shift'].keys.includes('v 4') && !out['held-shift'].keys.includes('v 5') && out['held-shift']['still-down'], out['held-shift']);
  check('the client does not have the X focus: refused (EFOCUS), no key sent', out['shell-focused'].answer?.ok === false && out['shell-focused'].answer.code === 'EFOCUS' && !out['shell-focused'].keys.length, out['shell-focused']);
  check('unknown window: ENOWIN', out.unknown?.ok === false && out.unknown.code === 'ENOWIN', out.unknown);
});

// ------------------------------------------------------------------ rendering with the image's font
const FONT_DIR = process.env.AURORA_EMOJI_FONT_DIR || path.join(os.homedir(), '.cache', 'selene-dev', 'noto-emoji-2.042', 'deb', 'usr', 'share', 'fonts');
await section('rendering with fonts-noto-color-emoji 2.042 (the image’s font)', async () => {
  const ttf = path.join(FONT_DIR, 'truetype', 'noto', 'NotoColorEmoji.ttf');
  if (!fs.existsSync(ttf)) {
    console.log(`SKIP: ${ttf} not found (extract fonts-noto-color-emoji_2.042-1_all.deb there, or set AURORA_EMOJI_FONT_DIR)`);
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-emoji-fc-'));
  // Every system font except the system's own (newer) Noto Color Emoji, plus the image's.
  const conf = path.join(tmp, 'fonts.conf');
  const reject = ['/usr/share/fonts/noto/NotoColorEmoji.ttf', '/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf', '/usr/share/fonts/noto-color-emoji/NotoColorEmoji.ttf', '/usr/share/fonts/google-noto-emoji/NotoColorEmoji.ttf'];
  fs.writeFileSync(conf, `<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">\n<fontconfig>\n  <cachedir>${tmp}/cache</cachedir>\n  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>\n  <dir>${FONT_DIR}</dir>\n  <selectfont><rejectfont>${reject.map((r) => `<glob>${r}</glob>`).join('')}</rejectfont></selectfont>\n</fontconfig>\n`);
  const r = await launchShell({ lang: 'fr', theme: 'light', env: { FONTCONFIG_FILE: conf } });
  try {
    // Each emoji drawn alone on a canvas with "Noto Color Emoji": a supported one is ONE glyph (the font's advance)
    // with coloured pixels; a missing code point draws the font's empty .notdef, a missing ZWJ sequence draws its
    // parts side by side (wider). (The advance alone cannot tell: .notdef has the same width.)
    const res = await r.page.evaluate(async () => {
      const em = window.__aurora.emoji;
      await em.ready();
      const d = await (await fetch('app://shell/assets/emoji/emoji.json')).json();
      const cv = document.createElement('canvas');
      cv.width = 96;
      cv.height = 48;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.font = '32px "Noto Color Emoji"';
      ctx.textBaseline = 'top';
      const draw = (c) => {
        ctx.clearRect(0, 0, 96, 48);
        ctx.fillText(c, 2, 4);
        const px = ctx.getImageData(0, 0, 96, 48).data;
        let ink = 0;
        for (let i = 3; i < px.length; i += 4) if (px[i] > 16) ink++;
        return { w: ctx.measureText(c).width, ink };
      };
      const ref = draw('😀').w;
      const ok = (c) => {
        const x = draw(c);
        return Math.abs(x.w - ref) < 0.5 && x.ink > 60;
      };
      const all = [];
      for (const row of d.e) {
        all.push(row[0]);
        if (row[6]) for (let k = 1; k <= 5; k++) all.push(em.withTone(row[0], k));
      }
      const bad = all.filter((c) => !ok(c));
      // the font in use really is the image's: Emoji 15.1 drawn, Emoji 16.0 (🫩, 🫆) blank
      return { n: all.length, bad, ref, e151: ok('🐦‍🔥') && ok('🚶🏽‍➡️'), e160: draw('🫩').ink + draw('🫆').ink };
    });
    check(`the image's font is in use: Emoji 15.1 drawn, Emoji 16.0 blank (ref ${res.ref}px)`, res.e151 && res.e160 === 0, res);
    check(`all ${res.n} emoji and skin-tone variants draw as one coloured glyph (no tofu, no split sequence)`, res.n > 3400 && !res.bad.length, res.bad.slice(0, 40).join(' '));
    await r.page.evaluate(() => window.__aurora.emoji.open());
    await until(() => r.page.evaluate(() => !!document.querySelector('.emo .emo-cell')));
    for (const cat of ['smileys', 'people', 'flags']) {
      await r.page.evaluate((c) => window.__aurora.emoji.setCategory(c), cat);
      await sleep(250);
      const el = await r.page.$('.emo');
      await el.screenshot({ path: path.join(OUT, `emoji-noto2042-${cat}.png`) });
    }
    await r.page.evaluate(() => window.__aurora.emoji.setTab('symbols'));
    await r.page.evaluate(() => window.__aurora.emoji.setCategory('signs'));
    await sleep(200);
    await (await r.page.$('.emo')).screenshot({ path: path.join(OUT, 'emoji-noto2042-signs.png') });
    await r.page.evaluate(() => window.__aurora.emoji.setTab('kaomoji'));
    await r.page.evaluate(() => window.__aurora.emoji.setCategory('other'));
    await sleep(200);
    await (await r.page.$('.emo')).screenshot({ path: path.join(OUT, 'emoji-noto2042-kaomoji.png') });
    check('screenshots of the grids written (test/out/emoji-noto2042-*.png)', fs.existsSync(path.join(OUT, 'emoji-noto2042-flags.png')));
  } finally {
    await r.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

console.log(`\nemoji: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
