// Translator tests — backend helpers (language detection, offline glossary, MyMemory / dictionary parsing, URL checks)
// + the real Electron shell with Playwright (mock backend in dev mode): translate with auto-detect, swap, Spanish
// target, character counter and provider limits, LibreTranslate settings, copy, offline glossary fallback with its note,
// history (restore, 50 cap, clear with confirmation), dictionary (definitions, not found, invalid, offline), keyboard
// tabs, persistence across launches, FR + dark theme.
// Usage:  cd aurora-os/shell && xvfb-run -a -s "-screen 0 1600x900x24" node test/translate.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { launchShell, ROOT } from './lib.mjs';

const require = createRequire(import.meta.url);
const DOCS = path.join(ROOT, '..', 'docs', 'screenshots');
fs.mkdirSync(DOCS, { recursive: true });
const WIN = '.win.app-translate';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
async function until(page, expr, timeout = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await page.evaluate(expr).catch(() => false)) return true;
    await sleep(60);
  }
  return false;
}
const text = (page, sel) => page.evaluate(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? null`);
const HOST = `[...document.querySelectorAll('${WIN} *')].find((e) => e.__translate)`;
const state = (page) => page.evaluate(`${HOST}?.__translate.state`);
const invoke = (page, channel, ...args) =>
  page.evaluate(`(async () => { try { const r = await window.aurora.invokeRaw(${JSON.stringify(channel)}, ...${JSON.stringify(args)}); return r.ok ? { ok: true, value: r.value } : { ok: false, code: r.error?.code, message: r.error?.message }; } catch (e) { return { ok: false, message: e.message }; } })()`);
const notice = (page) => text(page, `${WIN} .tr-notice`);
async function typeAndTranslate(page, value) {
  const before = (await state(page)).done;
  await page.fill(`${WIN} #tr-input`, value);
  await page.press(`${WIN} #tr-input`, 'Control+Enter');
  await until(page, `${HOST}?.__translate.state.done > ${before}`, 10000);
  return text(page, `${WIN} #tr-output`);
}

// ---------------------------------------------------------------- backend helpers
await section('backend helpers: detection, glossary, parsers', async () => {
  const m = require('../main/ipc/translate.js');
  const g = require('../renderer/apps/translate/glossary.json');
  check('glossary has about 1000+ entries', Object.keys(g.en_fr).length, (n) => n >= 1000);
  check('languages', m.LANGS, ['en', 'fr', 'es', 'de', 'it', 'pt', 'nl']);
  check('limits', m.LIMITS, { mymemory: 500, libre: 5000 });
  const samples = { en: 'Hello, how are you today?', fr: 'Bonjour, comment allez-vous ?', es: 'Hola, ¿cómo estás? Muy bien, gracias', de: 'Guten Tag, wie geht es dir? Danke sehr', it: 'Ciao, come stai? Molto bene grazie', pt: 'Olá, tudo bem? Muito obrigado', nl: 'Hallo, hoe gaat het met je? Dank je wel' };
  for (const [l, s] of Object.entries(samples)) check(`detectLang ${l}`, m.detectLang(s), l);
  check('glossary EN->FR phrase + case', m.glossaryTranslate('Good morning, my friend!', 'en', 'fr').text, 'Bonjour, mon ami!');
  check('glossary FR->EN', m.glossaryTranslate('Je ne sais pas où est la gare.', 'fr', 'en').text, 'I don’t know where is the train station.'.replace('’', "'"));
  const unk = m.glossaryTranslate('The zorblax cat', 'en', 'fr');
  check('glossary keeps unknown words', [unk.text, unk.unknown], ['Le zorblax chat', ['zorblax']]);
  check('glossary plural fallback', m.glossaryTranslate('books', 'en', 'fr').text, 'livres');
  let code = null;
  try {
    m.glossaryTranslate('hola', 'es', 'fr');
  } catch (e) {
    code = e.code;
  }
  check('glossary rejects non EN/FR pair', code, 'EOFFLINE');
  check('MyMemory URL', m.myMemoryUrl('a b&c', 'en', 'fr'), 'https://api.mymemory.translated.net/get?q=a%20b%26c&langpair=en|fr');
  check('parseMyMemory ok + entities', m.parseMyMemory({ responseStatus: 200, responseData: { translatedText: 'l&#39;eau &amp; le feu' } }), "l'eau & le feu");
  const codeOf = (fn) => {
    try {
      fn();
      return null;
    } catch (e) {
      return e.code;
    }
  };
  check('parseMyMemory quota', codeOf(() => m.parseMyMemory({ responseStatus: 200, responseData: { translatedText: 'MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY' } })), 'EQUOTA');
  check('parseMyMemory bad pair', codeOf(() => m.parseMyMemory({ responseStatus: 403, responseDetails: "'XX' IS AN INVALID TARGET LANGUAGE" })), 'EHTTP');
  const d = m.parseDictionary([{ word: 'run', phonetics: [{ text: '/ɹʌn/' }], meanings: [{ partOfSpeech: 'verb', definitions: [{ definition: 'To move swiftly.', example: 'Run!' }], synonyms: ['sprint'] }] }, { word: 'run', meanings: [{ partOfSpeech: 'verb', definitions: [{ definition: 'To manage.' }] }, { partOfSpeech: 'noun', definitions: [{ definition: 'An act of running.' }] }] }], 'run');
  check('parseDictionary merges parts of speech', d.meanings.map((x) => [x.partOfSpeech, x.definitions.length]), [['verb', 2], ['noun', 1]]);
  check('parseDictionary phonetic fallback', d.phonetic, '/ɹʌn/');
  check('parseDictionary not found', codeOf(() => m.parseDictionary({ title: 'No Definitions Found' }, 'zz')), 'ENOTFOUND');
  check('libreBase ok', m.libreBase('https://lt.example.org/'), 'https://lt.example.org');
  check('libreBase rejects file: and credentials', [m.libreBase('file:///etc/passwd'), m.libreBase('https://u:p@x.org'), m.libreBase('nope')], [null, null, null]);
});

// ---------------------------------------------------------------- English, light
let s = await launchShell({ open: ['translate'], lang: 'en', theme: 'light', keepHome: true });
const home = s.home;
let page = s.page;
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(e.message));

await section('launch: window, tabs, defaults', async () => {
  check('window opened', await until(page, `!!document.querySelector('${WIN} #tr-input')`, 30000), true);
  check('three tabs', await page.evaluate(`[...document.querySelectorAll('${WIN} [role=tab]')].map((t) => t.textContent)`), ['Translate', 'Dictionary', 'Settings']);
  check('title shows app name', await page.evaluate(`document.querySelector('${WIN}').textContent.includes('Translator')`), true);
  check('source defaults to auto', await page.inputValue(`${WIN} #tr-source`), 'auto');
  check('target defaults to French', await page.inputValue(`${WIN} #tr-target`), 'fr');
  check('source options', await page.evaluate(`[...document.querySelectorAll('${WIN} #tr-source option')].map((o) => o.textContent)`), ['Detect language', 'English', 'French', 'Spanish', 'German', 'Italian', 'Portuguese', 'Dutch']);
  check('counter 0 / 500', await text(page, `${WIN} .tr-counter`), '0 / 500');
  check('translate disabled when empty', await page.evaluate(`document.querySelector('${WIN} [data-act=translate]').disabled`), true);
  check('copy disabled when empty', await page.evaluate(`document.querySelector('${WIN} [data-act=copy]').disabled`), true);
  check('history empty state', await text(page, `${WIN} .tr-hist-empty`), 'Your last 50 translations appear here.');
  check('input focused', await page.evaluate(`document.activeElement?.id`), 'tr-input');
  check('no "null"/"undefined" text', await page.evaluate(`/\\b(null|undefined)\\b/.test(document.querySelector('${WIN} .tr-root').textContent)`), false);
});

await section('translate EN -> FR with auto-detect', async () => {
  const out = await typeAndTranslate(page, 'Hello my friend');
  check('output', out, 'Bonjour mon ami');
  check('detected language', await text(page, `${WIN} .tr-detected`), 'Detected: English');
  check('provider caption', await text(page, `${WIN} .tr-via`), 'Translated with the test service');
  check('counter updated', await text(page, `${WIN} .tr-counter`), '15 / 500');
  check('no notice online', await notice(page), '');
  check('history has the entry', await page.evaluate(`[...document.querySelectorAll('${WIN} .tr-hist-btn')].map((b) => b.querySelector('.tr-hist-langs').textContent + '|' + b.querySelector('.tr-hist-text').textContent + '|' + b.querySelector('.tr-hist-result').textContent)`), ['EN → FR|Hello my friend|Bonjour mon ami']);
});

await section('copy translation to the clipboard', async () => {
  await page.click(`${WIN} [data-act=copy]`);
  check('copied notice', await until(page, `document.querySelector('${WIN} .tr-notice').textContent === 'Copied to the clipboard'`, 4000), true);
  check('clipboard content', (await invoke(page, 'clipboard:readText')).value, 'Bonjour mon ami');
});

await section('swap languages and texts', async () => {
  await page.click(`${WIN} [data-act=swap]`);
  check('source is now French', await page.inputValue(`${WIN} #tr-source`), 'fr');
  check('target is now English', await page.inputValue(`${WIN} #tr-target`), 'en');
  check('translation moved to input', await page.inputValue(`${WIN} #tr-input`), 'Bonjour mon ami');
  check('output cleared', await text(page, `${WIN} #tr-output`), '');
  check('focus stays on swap', await page.evaluate(`document.activeElement?.dataset?.act`), 'swap');
  const out = await typeAndTranslate(page, 'Bonjour mon ami');
  check('FR -> EN output', out, 'Hello my friend');
  check('no detected label with a fixed source', await text(page, `${WIN} .tr-detected`), '');
});

await section('other target languages (mock)', async () => {
  await page.selectOption(`${WIN} #tr-source`, 'en');
  await page.selectOption(`${WIN} #tr-target`, 'es');
  check('Spanish target', await typeAndTranslate(page, 'Good night'), '[ES] Good night');
  await page.selectOption(`${WIN} #tr-target`, 'nl');
  check('Dutch target', await typeAndTranslate(page, 'Thank you'), '[NL] Thank you');
  await page.selectOption(`${WIN} #tr-target`, 'en');
  check('same language returns the text', await typeAndTranslate(page, 'Same text'), 'Same text');
});

await section('character counter and provider limits', async () => {
  await page.fill(`${WIN} #tr-input`, 'a'.repeat(501));
  check('counter over limit', await text(page, `${WIN} .tr-counter`), '501 / 500');
  check('counter flagged', await page.evaluate(`document.querySelector('${WIN} .tr-counter').classList.contains('over')`), true);
  check('translate disabled over limit', await page.evaluate(`document.querySelector('${WIN} [data-act=translate]').disabled`), true);
  check('too long notice', await notice(page), 'The text is longer than 500 characters. Shorten it to translate.');
  check('backend enforces the limit too', (await invoke(page, 'translate:text', { text: 'a'.repeat(501), source: 'en', target: 'fr' })).code, 'ETOOLONG');
  check('backend rejects bad language', (await invoke(page, 'translate:text', { text: 'hi', source: 'xx', target: 'fr' })).code, 'EINVAL');
  check('backend rejects empty text', (await invoke(page, 'translate:text', { text: '   ', source: 'en', target: 'fr' })).code, 'EINVAL');
  await page.fill(`${WIN} #tr-input`, 'a'.repeat(499));
  check('notice cleared under limit', await notice(page), '');
  check('translate enabled again', await page.evaluate(`document.querySelector('${WIN} [data-act=translate]').disabled`), false);
});

await section('settings: LibreTranslate provider', async () => {
  await page.click(`${WIN} #tr-tab-settings`);
  check('settings panel visible', await page.evaluate(`!document.querySelector('${WIN} #tr-panel-settings').hidden`), true);
  check('MyMemory selected by default', await page.evaluate(`document.querySelector('${WIN} input[value=mymemory]').checked`), true);
  check('Libre fields hidden', await page.evaluate(`document.querySelector('${WIN} .tr-libre').hidden`), true);
  await page.click(`${WIN} input[value=libre]`);
  check('Libre fields shown', await page.evaluate(`document.querySelector('${WIN} .tr-libre').hidden`), false);
  await page.fill(`${WIN} #tr-libre-url`, 'ftp://bad');
  await page.press(`${WIN} #tr-libre-url`, 'Tab');
  check('invalid URL message', await text(page, `${WIN} .tr-url-error`), 'Enter an address that starts with http:// or https://');
  await page.click(`${WIN} #tr-tab-translate`);
  await page.fill(`${WIN} #tr-input`, 'a'.repeat(501));
  check('Libre limit is 5000', await text(page, `${WIN} .tr-counter`), '501 / 5000');
  await page.selectOption(`${WIN} #tr-source`, 'en');
  await page.selectOption(`${WIN} #tr-target`, 'fr');
  await page.fill(`${WIN} #tr-input`, 'water');
  await page.press(`${WIN} #tr-input`, 'Control+Enter');
  check('missing server address error', await until(page, `document.querySelector('${WIN} .tr-notice').textContent.includes('LibreTranslate server address is not valid')`, 6000), true);
  await page.click(`${WIN} #tr-tab-settings`);
  await page.fill(`${WIN} #tr-libre-url`, 'https://lt.example.org');
  await page.fill(`${WIN} #tr-libre-key`, 'secret');
  await page.press(`${WIN} #tr-libre-key`, 'Tab');
  check('settings saved', await text(page, `${WIN} .tr-set-status`), 'Settings saved');
  check('state keeps URL', (await state(page))?.libreUrl, 'https://lt.example.org');
  await page.click(`${WIN} #tr-tab-translate`);
  check('Libre (mock) translates', await typeAndTranslate(page, 'water'), 'eau');
  await page.click(`${WIN} #tr-tab-settings`);
  await page.click(`${WIN} input[value=mymemory]`);
  check('back to MyMemory', (await state(page))?.provider, 'mymemory');
  await page.click(`${WIN} #tr-tab-translate`);
});

await section('offline: glossary fallback with a visible note', async () => {
  check('mock offline on', (await invoke(page, 'translate:mock', { offline: true })).value?.offline, true);
  await page.selectOption(`${WIN} #tr-source`, 'auto');
  await page.selectOption(`${WIN} #tr-target`, 'fr');
  const out = await typeAndTranslate(page, 'The cat and the qwzx');
  check('glossary translation', out, 'Le chat et le qwzx');
  check('offline note', await notice(page), (v) => v.includes('Offline: translated word by word') && v.includes('1 word was not in the glossary'));
  check('offline note is a warning', await page.evaluate(`!!document.querySelector('${WIN} .tr-notice .infobar.warning')`), true);
  check('provider caption offline', await text(page, `${WIN} .tr-via`), 'Translated with the offline glossary');
  check('history marks offline', await text(page, `${WIN} .tr-hist-item:first-child .tr-hist-off`), ' · offline');
  await page.selectOption(`${WIN} #tr-target`, 'de');
  await page.fill(`${WIN} #tr-input`, 'Hello');
  await page.press(`${WIN} #tr-input`, 'Control+Enter');
  check('offline + non EN/FR pair error', await until(page, `document.querySelector('${WIN} .tr-notice').textContent.startsWith('You are offline')`, 6000), true);
  check('error is an alert', await page.evaluate(`document.querySelector('${WIN} .tr-notice .infobar')?.getAttribute('role')`), 'alert');
  await invoke(page, 'translate:mock', { offline: false });
  await page.selectOption(`${WIN} #tr-target`, 'fr');
});

await section('history: restore, 50 cap, clear with confirmation', async () => {
  const before = (await state(page)).history.length;
  check('history count so far', before, (n) => n >= 6);
  await page.click(`${WIN} .tr-hist-btn[data-id="${(await state(page)).history.at(-1).id}"]`);
  check('restored text', await page.inputValue(`${WIN} #tr-input`), 'Hello my friend');
  check('restored result', await text(page, `${WIN} #tr-output`), 'Bonjour mon ami');
  check('restored languages', [await page.inputValue(`${WIN} #tr-source`), await page.inputValue(`${WIN} #tr-target`)], ['auto', 'fr']);
  await page.evaluate(`(async () => { const host = [...document.querySelectorAll('${WIN} *')].find((e) => e.__translate); const inp = document.querySelector('${WIN} #tr-input');
    for (let i = 0; i < 52; i++) { inp.value = 'word ' + i; inp.dispatchEvent(new Event('input')); await host.__translate.translate(); } })()`);
  const st = await state(page);
  check('history capped at 50', st.history.length, 50);
  check('newest first', st.history[0].text, 'word 51');
  check('history rendered', await page.evaluate(`document.querySelectorAll('${WIN} .tr-hist-btn').length`), 50);
  await page.click(`${WIN} [data-act=clear-history]`);
  check('confirm dialog', await until(page, `!!document.querySelector('.dialog-layer:not(.closing) .dialog-footer .btn.danger')`, 5000), true);
  check('dialog title', await text(page, '.dialog-layer:not(.closing) .dialog-title'), 'Clear history?');
  await page.click('.dialog-layer:not(.closing) .dialog-footer .btn:not(.danger)');
  await sleep(400);
  check('cancel keeps history', (await state(page)).history.length, 50);
  await page.click(`${WIN} [data-act=clear-history]`);
  await until(page, `!!document.querySelector('.dialog-layer:not(.closing) .dialog-footer .btn.danger')`, 5000);
  await page.click('.dialog-layer:not(.closing) .dialog-footer .btn.danger');
  check('history cleared', await until(page, `!!document.querySelector('${WIN} .tr-hist-empty')`, 5000), true);
  check('clear button disabled', await page.evaluate(`document.querySelector('${WIN} [data-act=clear-history]').disabled`), true);
  await page.selectOption(`${WIN} #tr-source`, 'en');
  await typeAndTranslate(page, 'Good morning');
  await typeAndTranslate(page, 'Thank you very much');
  check('two new entries', (await state(page)).history.map((x) => x.result), ['Merci beaucoup', 'Bonjour']);
});

await section('dictionary: definitions, not found, invalid, offline', async () => {
  await page.click(`${WIN} #tr-tab-dictionary`);
  await page.fill(`${WIN} #tr-word`, 'Book');
  await page.press(`${WIN} #tr-word`, 'Enter');
  check('word shown', await until(page, `document.querySelector('${WIN} .tr-dict-word')?.textContent === 'book'`, 6000), true);
  check('phonetic', await text(page, `${WIN} .tr-dict-phon`), '/bʊk/');
  check('parts of speech', await page.evaluate(`[...document.querySelectorAll('${WIN} .tr-pos')].map((x) => x.textContent)`), ['noun', 'verb']);
  check('noun has 2 definitions', await page.evaluate(`document.querySelectorAll('${WIN} .tr-meaning:first-of-type .tr-defs li').length`), 2);
  check('example quoted', await text(page, `${WIN} .tr-example`), '“I read a good book yesterday.”');
  check('synonyms', await text(page, `${WIN} .tr-syn`), 'Synonyms: volume, tome');
  check('French from glossary', await text(page, `${WIN} .tr-dict-fr`), 'In French: livre');
  await page.fill(`${WIN} #tr-word`, 'zzzz');
  await page.click(`${WIN} [data-act=lookup]`);
  check('not found', await until(page, `document.querySelector('${WIN} .tr-dict-status').textContent === 'No definition found for “zzzz”.'`, 6000), true);
  check('results cleared', await page.evaluate(`document.querySelector('${WIN} .tr-dict-out').children.length`), 0);
  await page.fill(`${WIN} #tr-word`, '123');
  await page.press(`${WIN} #tr-word`, 'Enter');
  check('invalid word', await text(page, `${WIN} .tr-dict-status`), 'Enter a single English word.');
  check('invalid flagged', await page.getAttribute(`${WIN} #tr-word`, 'aria-invalid'), 'true');
  check('backend rejects injection', (await invoke(page, 'translate:define', '../../etc')).code, 'EINVAL');
  await invoke(page, 'translate:mock', { offline: true });
  await page.fill(`${WIN} #tr-word`, 'water');
  await page.press(`${WIN} #tr-word`, 'Enter');
  check('offline dictionary note', await until(page, `document.querySelector('${WIN} .tr-dict-status').textContent.startsWith('Offline: definitions are not available')`, 6000), true);
  check('offline French fallback', await text(page, `${WIN} .tr-dict-fr`), 'In French: eau');
  await page.fill(`${WIN} #tr-word`, 'qwzx');
  await page.press(`${WIN} #tr-word`, 'Enter');
  check('offline unknown word', await until(page, `document.querySelector('${WIN} .tr-dict-status').textContent === 'You are offline and “qwzx” is not in the built-in glossary.'`, 6000), true);
  await invoke(page, 'translate:mock', { offline: false });
});

await section('keyboard: tabs with arrows', async () => {
  await page.focus(`${WIN} #tr-tab-dictionary`);
  await page.keyboard.press('ArrowRight');
  check('ArrowRight -> Settings', (await state(page)).tab, 'settings');
  check('focus follows', await page.evaluate(`document.activeElement?.id`), 'tr-tab-settings');
  await page.keyboard.press('Home');
  check('Home -> Translate', (await state(page)).tab, 'translate');
  await page.keyboard.press('ArrowLeft');
  check('ArrowLeft wraps -> Settings', (await state(page)).tab, 'settings');
  await page.keyboard.press('ArrowRight');
  check('roving tabindex', await page.evaluate(`[...document.querySelectorAll('${WIN} [role=tab]')].map((t) => t.tabIndex)`), [0, -1, -1]);
});

await section('screenshot + console', async () => {
  await page.selectOption(`${WIN} #tr-source`, 'auto');
  await page.selectOption(`${WIN} #tr-target`, 'fr');
  await typeAndTranslate(page, 'Good morning, how are you? I love music and books.');
  await sleep(300);
  await page.locator(WIN).screenshot({ path: path.join(DOCS, 'translate-light-en.png') });
  check('light screenshot written', fs.existsSync(path.join(DOCS, 'translate-light-en.png')), true);
  check('no "null"/"undefined" text', await page.evaluate(`/\\b(null|undefined)\\b/.test(document.querySelector('${WIN} .tr-root').textContent)`), false);
  check('no console errors', errors.filter((e) => !/favicon|ERR_FILE_NOT_FOUND/.test(e)), []);
});
await s.close();

// ---------------------------------------------------------------- French, dark (same home: persistence)
s = await launchShell({ open: ['translate'], lang: 'fr', theme: 'dark', home });
page = s.page;
await section('French + dark theme, persisted state', async () => {
  check('window opened (fr)', await until(page, `!!document.querySelector('${WIN} #tr-input')`, 30000), true);
  check('FR tabs', await page.evaluate(`[...document.querySelectorAll('${WIN} [role=tab]')].map((t) => t.textContent)`), ['Traduire', 'Dictionnaire', 'Paramètres']);
  const st = await state(page);
  check('history persisted', st.history.length, 3);
  check('languages persisted', [st.source, st.target], ['auto', 'fr']);
  check('FR history label', await text(page, `${WIN} .tr-hist-head h2`), 'Historique');
  await page.selectOption(`${WIN} #tr-target`, 'en');
  check('FR -> EN translation', await typeAndTranslate(page, 'Bonjour, je suis très heureux'), 'Hello, I am very happy');
  check('FR detected label', await text(page, `${WIN} .tr-detected`), 'Langue détectée : Français');
  check('FR counter', await page.getAttribute(`${WIN} .tr-counter`, 'aria-label'), '29 caractères sur 500');
  check('FR source option', await page.evaluate(`document.querySelector('${WIN} #tr-source option').textContent`), 'Détecter la langue');
  const dark = await page.evaluate(`(() => { const c = getComputedStyle(document.querySelector('${WIN} #tr-output')).color.match(/\\d+/g).map(Number); return (c[0] + c[1] + c[2]) / 3; })()`);
  check('dark theme: light text', dark, (v) => v > 180);
  await page.locator(WIN).screenshot({ path: path.join(DOCS, 'translate-dark-fr.png') });
  check('dark screenshot written', fs.existsSync(path.join(DOCS, 'translate-dark-fr.png')), true);
  await page.click(`${WIN} #tr-tab-dictionary`);
  await page.fill(`${WIN} #tr-word`, 'hello');
  await page.press(`${WIN} #tr-word`, 'Enter');
  check('FR part of speech', await until(page, `[...document.querySelectorAll('${WIN} .tr-pos')].map((x) => x.textContent).join(',') === 'nom,interjection'`, 6000), true);
  check('FR glossary chip', await text(page, `${WIN} .tr-dict-fr`), 'En français : bonjour');
  check('no "null"/"undefined" text (fr)', await page.evaluate(`/\\b(null|undefined)\\b/.test(document.querySelector('${WIN} .tr-root').textContent)`), false);
});
await s.close();
fs.rmSync(home, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
process.exit(0);
