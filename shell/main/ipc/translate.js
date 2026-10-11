'use strict';
// Translator app backend (apps/translate): text translation through a configurable provider and English dictionary
// definitions. Every request goes through Electron's net.fetch here (the renderer CSP allows no https connect-src).
//   - MyMemory (default, no key): GET https://api.mymemory.translated.net/get?q=…&langpair=en|fr  (500 characters max)
//   - LibreTranslate (URL + optional API key from the app settings): POST <url>/translate { q, source, target, format, api_key }
//   - Dictionary: GET https://api.dictionaryapi.dev/api/v2/entries/en/<word>
// Offline fallback: the built-in EN <-> FR glossary (renderer/apps/translate/glossary.json), word by word with
// phrases of up to 4 words matched first; results then carry offline: true.
// Dev / tests (api.DEV unless AURORA_REAL_BACKENDS=1): deterministic mock answers, no network. The mock can be
// switched offline with translate:mock({ offline: true }) (dev only) to exercise the fallback.
//
// Channels:
//   translate:languages () -> ['en','fr','es','de','it','pt','nl']
//   translate:text ({ text, source: 'auto'|lang, target: lang, provider: 'mymemory'|'libre', libreUrl, libreKey })
//        -> { text, source, detected (lang|null), target, provider: 'mymemory'|'libre'|'glossary'|'mock', offline, unknown: [words] }
//        Errors: EINVAL (bad language / empty text / bad URL), ETOOLONG (over the provider limit), EOFFLINE (offline and
//        not an EN <-> FR pair), EQUOTA (provider quota), EHTTP (provider error, message = its answer), ETIMEDOUT.
//   translate:define (word) -> { word, phonetic, meanings: [{ partOfSpeech, definitions: [{ definition, example }], synonyms }],
//        offline, glossary: 'fr translation'|null, source: 'dictionaryapi'|'mock'|'glossary' }
//        Offline: meanings is [] and glossary carries the French translation when the word is known. ENOTFOUND otherwise.
//   translate:mock ({ offline, delayMs }) -> state   (dev only)
//   translate:stats () -> { requests, failures, urls, mock, offline }
const fs = require('fs');
const path = require('path');

const LANGS = ['en', 'fr', 'es', 'de', 'it', 'pt', 'nl'];
const LIMITS = { mymemory: 500, libre: 5000 };
const GLOSSARY_FILE = path.join(__dirname, '..', '..', 'renderer', 'apps', 'translate', 'glossary.json');

// ---------------------------------------------------------------- pure helpers (unit-tested)
function err(message, code) {
  const e = new Error(message);
  e.code = code;
  e.quiet = true;
  return e;
}
const clean = (s, n = 5000) => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, n);

let glossaryCache = null;
/** { enFr: Map, frEn: Map } from glossary.json (phrases lower-case). */
function loadGlossary(file = GLOSSARY_FILE) {
  if (glossaryCache && glossaryCache.file === file) return glossaryCache;
  const enFr = new Map();
  const frEn = new Map();
  try {
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [en, fr] of Object.entries(json?.en_fr || {})) {
      const e = String(en).toLowerCase().trim();
      const f = String(fr).toLowerCase().trim();
      if (!e || !f) continue;
      if (!enFr.has(e)) enFr.set(e, f);
      if (!frEn.has(f)) frEn.set(f, e);
    }
    for (const [fr, en] of Object.entries(json?.fr_en || {})) frEn.set(String(fr).toLowerCase().trim(), String(en).toLowerCase().trim());
  } catch {}
  glossaryCache = { file, enFr, frEn };
  return glossaryCache;
}

const STOP = {
  en: ['the', 'and', 'is', 'are', 'you', 'of', 'to', 'it', 'this', 'that', 'with', 'what', 'have', 'i', 'my', 'hello', 'thank', 'please', 'good', 'where', 'how', 'was', 'for'],
  fr: ['le', 'la', 'les', 'et', 'est', 'je', 'vous', 'tu', 'un', 'une', 'des', 'du', 'que', 'qui', 'pas', 'bonjour', 'merci', 'avec', 'pour', 'mon', 'ma', 'où', 'suis', 'très', 'ce', 'il', 'elle', 'nous'],
  es: ['el', 'los', 'las', 'y', 'es', 'yo', 'usted', 'una', 'que', 'no', 'hola', 'gracias', 'por', 'con', 'para', 'muy', 'está', 'como', 'qué', 'buenos', 'del'],
  de: ['der', 'die', 'das', 'und', 'ist', 'ich', 'sie', 'ein', 'eine', 'nicht', 'hallo', 'danke', 'mit', 'für', 'wie', 'guten', 'auf', 'zu', 'bitte', 'sehr'],
  it: ['il', 'lo', 'gli', 'e', 'è', 'io', 'un', 'una', 'che', 'non', 'ciao', 'grazie', 'per', 'con', 'molto', 'come', 'sono', 'buongiorno', 'della'],
  pt: ['o', 'os', 'as', 'e', 'é', 'eu', 'você', 'um', 'uma', 'que', 'não', 'olá', 'obrigado', 'obrigada', 'por', 'com', 'para', 'muito', 'bom', 'dia'],
  nl: ['de', 'het', 'een', 'en', 'is', 'ik', 'je', 'u', 'niet', 'hallo', 'dank', 'met', 'voor', 'van', 'zijn', 'wat', 'goedemorgen', 'alstublieft', 'heel'],
};
const tokens = (s) => String(s).toLowerCase().match(/[\p{L}']+/gu) || [];
/** Best-guess language of a text among LANGS (stop words + accents + glossary hits); 'en' when unsure. */
function detectLang(text) {
  const words = tokens(text).flatMap((w) => w.split("'").filter(Boolean));
  if (!words.length) return 'en';
  const score = Object.fromEntries(LANGS.map((l) => [l, 0]));
  for (const w of words) for (const l of LANGS) if (STOP[l].includes(w)) score[l] += 2;
  const s = String(text).toLowerCase();
  if (/[àâçèêëîïôœùûÿ]/.test(s)) score.fr += 2;
  if (/[ñ¿¡]/.test(s)) score.es += 4;
  if (/[äöüß]/.test(s)) score.de += 4;
  if (/[ãõ]/.test(s)) score.pt += 4;
  if (/\bij\b|ij/.test(s)) score.nl += 1;
  const g = loadGlossary();
  for (const w of words) {
    if (g.enFr.has(w) && !g.frEn.has(w)) score.en += 1;
    else if (g.frEn.has(w) && !g.enFr.has(w)) score.fr += 1;
  }
  let best = 'en';
  for (const l of LANGS) if (score[l] > score[best]) best = l;
  return best;
}

const capitalize = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
/** Word-by-word EN <-> FR translation with the glossary. -> { text, unknown: [words] } */
function glossaryTranslate(text, source, target) {
  const g = loadGlossary();
  const dict = source === 'en' && target === 'fr' ? g.enFr : source === 'fr' && target === 'en' ? g.frEn : null;
  if (!dict) throw err('The offline glossary only covers English and French', 'EOFFLINE');
  const parts = String(text).split(/([\p{L}\p{M}'’-]+)/u); // odd indexes are words
  const out = [];
  const unknown = [];
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      out.push(parts[i]);
      continue;
    }
    // longest phrase first (up to 4 words separated by single spaces)
    let matched = false;
    for (let n = 4; n >= 1 && !matched; n--) {
      const idx = [];
      for (let k = 0; k < n; k++) idx.push(i + 2 * k);
      if (idx[idx.length - 1] >= parts.length) continue;
      if (idx.slice(1).some((j) => parts[j - 1] !== ' ')) continue;
      const phrase = idx.map((j) => parts[j]).join(' ');
      const key = phrase.toLowerCase().replace(/’/g, "'");
      let hit = dict.get(key);
      if (!hit && n === 1 && key.endsWith('s') && key.length > 3) {
        const sing = dict.get(key.slice(0, -1));
        if (sing) hit = sing.includes(' ') ? sing : `${sing}s`;
      }
      if (!hit && n === 1 && /^[ldjnmstc]'/.test(key)) {
        const rest = dict.get(key.slice(2));
        const pre = { "l'": 'the ', "d'": 'of ', "j'": 'I ', "n'": '', "m'": 'me ', "s'": '', "t'": 'you ', "c'": 'it ' }[key.slice(0, 2)];
        if (rest && source === 'fr') hit = `${pre}${rest}`.trim();
      }
      if (hit) {
        if (target === 'en') hit = hit.replace(/\bi\b/g, 'I');
        out.push(/^\p{Lu}/u.test(phrase) ? capitalize(hit) : hit);
        i = idx[idx.length - 1];
        matched = true;
      }
    }
    if (!matched) {
      out.push(parts[i]);
      unknown.push(parts[i]);
    }
  }
  return { text: out.join(''), unknown };
}

function normLang(l, { auto = false } = {}) {
  const s = String(l ?? '').toLowerCase();
  if (auto && s === 'auto') return 'auto';
  return LANGS.includes(s) ? s : null;
}
function myMemoryUrl(text, source, target) {
  return `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${source}|${target}`;
}
/** MyMemory JSON -> translated text (throws EQUOTA / EHTTP). */
function parseMyMemory(json) {
  const status = Number(json?.responseStatus);
  const out = json?.responseData?.translatedText;
  if (typeof out === 'string' && /MYMEMORY WARNING|USED ALL AVAILABLE FREE TRANSLATIONS/i.test(out)) throw err(out.slice(0, 300), 'EQUOTA');
  if (status === 429) throw err(String(json?.responseDetails || 'Quota exceeded').slice(0, 300), 'EQUOTA');
  if ((status && status !== 200) || typeof out !== 'string') throw err(String(json?.responseDetails || 'Unexpected answer from MyMemory').slice(0, 300), 'EHTTP');
  return decodeEntities(out);
}
function decodeEntities(s) {
  return s.replace(/&(#\d+|#x[0-9a-f]+|amp|lt|gt|quot|apos|#39);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k === 'amp') return '&';
    if (k === 'lt') return '<';
    if (k === 'gt') return '>';
    if (k === 'quot') return '"';
    if (k === 'apos' || k === '#39') return "'";
    const n = k.startsWith('#x') ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
  });
}
/** Validated LibreTranslate base URL (http/https, no credentials) or null. */
function libreBase(u) {
  try {
    const url = new URL(String(u || '').trim());
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
    return url.href.replace(/\/+$/, '');
  } catch {
    return null;
  }
}
/** dictionaryapi.dev JSON -> definition result. */
function parseDictionary(json, word) {
  const entries = Array.isArray(json) ? json : [];
  if (!entries.length) throw err(`No definitions found for "${word}"`, 'ENOTFOUND');
  const txt = (v, n = 600) => (typeof v === 'string' ? clean(v, n).trim() : '');
  const phonetic = txt(entries[0]?.phonetic, 80) || txt((entries[0]?.phonetics || []).find((p) => p?.text)?.text, 80);
  const byPos = new Map();
  for (const e of entries) {
    for (const m of Array.isArray(e?.meanings) ? e.meanings : []) {
      const pos = txt(m?.partOfSpeech, 40) || 'other';
      const slot = byPos.get(pos) || { partOfSpeech: pos, definitions: [], synonyms: [] };
      for (const d of Array.isArray(m?.definitions) ? m.definitions : []) {
        const definition = txt(d?.definition);
        if (definition && slot.definitions.length < 6) slot.definitions.push({ definition, example: txt(d?.example) });
      }
      for (const s of Array.isArray(m?.synonyms) ? m.synonyms : []) if (typeof s === 'string' && slot.synonyms.length < 8 && !slot.synonyms.includes(s)) slot.synonyms.push(txt(s, 60));
      byPos.set(pos, slot);
    }
  }
  const meanings = [...byPos.values()].filter((m) => m.definitions.length).slice(0, 8);
  if (!meanings.length) throw err(`No definitions found for "${word}"`, 'ENOTFOUND');
  return { word: txt(entries[0]?.word, 80) || word, phonetic, meanings };
}

// Deterministic mock answers for dev / tests.
const MOCK_DICT = {
  hello: [{ word: 'hello', phonetic: '/həˈləʊ/', meanings: [{ partOfSpeech: 'noun', definitions: [{ definition: '"Hello!" or an equivalent greeting.', example: 'She gave me a warm hello.' }], synonyms: ['greeting'] }, { partOfSpeech: 'interjection', definitions: [{ definition: 'A greeting (salutation) said when meeting someone or acknowledging someone’s arrival or presence.', example: 'Hello, everyone.' }], synonyms: ['hi', 'hey'] }] }],
  book: [{ word: 'book', phonetic: '/bʊk/', meanings: [{ partOfSpeech: 'noun', definitions: [{ definition: 'A collection of sheets of paper bound together to hinge at one edge, containing printed or written material.', example: 'I read a good book yesterday.' }, { definition: 'A long work fit for publication.', example: '' }], synonyms: ['volume', 'tome'] }, { partOfSpeech: 'verb', definitions: [{ definition: 'To reserve (something) for future use.', example: 'I booked a table for two.' }], synonyms: ['reserve'] }] }],
  water: [{ word: 'water', phonetic: '/ˈwɔːtə/', meanings: [{ partOfSpeech: 'noun', definitions: [{ definition: 'A substance found at room temperature and pressure as a clear liquid.', example: 'Drink plenty of water.' }], synonyms: [] }] }],
};
function mockTranslate(text, source, target) {
  if (source === target) return { text, unknown: [] };
  if ((source === 'en' && target === 'fr') || (source === 'fr' && target === 'en')) return glossaryTranslate(text, source, target);
  return { text: `[${target.toUpperCase()}] ${text}`, unknown: [] };
}

// ---------------------------------------------------------------- module
function register(api) {
  const useMock = api.DEV && process.env.AURORA_REAL_BACKENDS !== '1';
  const mock = { offline: false, delayMs: 0 };
  const stats = { requests: 0, failures: 0, urls: [], mock: useMock };
  const timeoutMs = Math.max(200, Number(process.env.AURORA_TRANSLATE_TIMEOUT) || 10000);

  async function fetchJson(url, init = {}, { allow404 = false } = {}) {
    stats.requests++;
    stats.urls.push(url.replace(/api_key=[^&]*/, 'api_key=…'));
    if (stats.urls.length > 20) stats.urls.shift();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const { net } = require('electron');
      let res;
      try {
        res = await net.fetch(url, { ...init, signal: ctrl.signal, headers: { Accept: 'application/json', 'User-Agent': `AuroraOS/${api.env?.version || '1'}`, ...(init.headers || {}) } });
      } catch (e) {
        throw ctrl.signal.aborted ? err('The request timed out', 'ETIMEDOUT') : err(`Network unreachable (${e.message})`, 'EOFFLINE');
      }
      const text = await res.text();
      if (text.length > 1024 * 1024) throw err('Answer too large', 'EHTTP');
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {}
      if (res.status === 404 && allow404) return { notFound: true };
      if (res.status === 429) throw err(String(json?.error || json?.responseDetails || 'Too many requests').slice(0, 300), 'EQUOTA');
      if (!res.ok) throw err(String(json?.error || json?.responseDetails || `The service answered ${res.status}`).slice(0, 300), 'EHTTP');
      if (json == null) throw err('Unexpected answer', 'EHTTP');
      return json;
    } finally {
      clearTimeout(timer);
    }
  }
  async function mockGate() {
    stats.requests++;
    if (mock.delayMs) await new Promise((r) => setTimeout(r, mock.delayMs));
    if (mock.offline) throw err('Network unreachable (mock)', 'EOFFLINE');
  }
  const isNetErr = (e) => e?.code === 'EOFFLINE' || e?.code === 'ETIMEDOUT';

  api.handle('translate:languages', () => LANGS.slice());

  api.handle('translate:text', async (opts) => {
    const o = opts && typeof opts === 'object' ? opts : {};
    const provider = o.provider === 'libre' ? 'libre' : 'mymemory';
    const text = clean(o.text, 20000);
    if (!text.trim()) throw err('Nothing to translate', 'EINVAL');
    if (text.length > LIMITS[provider]) throw err(`Text is longer than ${LIMITS[provider]} characters`, 'ETOOLONG');
    const source = normLang(o.source, { auto: true });
    const target = normLang(o.target);
    if (!source || !target) throw err('Unsupported language', 'EINVAL');
    const base = provider === 'libre' ? libreBase(o.libreUrl) : null;
    if (provider === 'libre' && !base) throw err('Invalid LibreTranslate server address', 'EINVAL');
    const guess = source === 'auto' ? detectLang(text) : source;
    const result = (out, extra) => ({ text: out, source, detected: source === 'auto' ? guess : null, target, provider, offline: false, unknown: [], ...extra });
    if (guess === target) return result(text, { provider: useMock ? 'mock' : provider });
    try {
      if (useMock) {
        await mockGate();
        const r = mockTranslate(text, guess, target);
        return result(r.text, { provider: 'mock' });
      }
      if (provider === 'libre') {
        const body = { q: text, source, target, format: 'text' };
        if (o.libreKey) body.api_key = clean(o.libreKey, 200);
        const json = await fetchJson(`${base}/translate`, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
        if (typeof json?.translatedText !== 'string') throw err(String(json?.error || 'Unexpected answer from LibreTranslate').slice(0, 300), 'EHTTP');
        const det = normLang(json?.detectedLanguage?.language);
        return { ...result(json.translatedText), detected: source === 'auto' ? det || guess : null };
      }
      const json = await fetchJson(myMemoryUrl(text, guess, target));
      return result(parseMyMemory(json));
    } catch (e) {
      stats.failures++;
      if (!isNetErr(e)) throw e;
      try {
        const r = glossaryTranslate(text, guess, target);
        return result(r.text, { provider: 'glossary', offline: true, unknown: r.unknown.slice(0, 50) });
      } catch (g) {
        throw err(g.message, 'EOFFLINE');
      }
    }
  });

  api.handle('translate:define', async (word) => {
    const w = clean(word, 80).trim().toLowerCase();
    if (!w || !/^[\p{L}][\p{L}' -]*$/u.test(w)) throw err('Enter a single English word', 'EINVAL');
    const gl = loadGlossary().enFr.get(w) || null;
    try {
      if (useMock) {
        await mockGate();
        if (!MOCK_DICT[w]) throw err(`No definitions found for "${w}"`, 'ENOTFOUND');
        return { ...parseDictionary(MOCK_DICT[w], w), offline: false, glossary: gl, source: 'mock' };
      }
      const json = await fetchJson(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(w)}`, {}, { allow404: true });
      if (json?.notFound) throw err(`No definitions found for "${w}"`, 'ENOTFOUND');
      return { ...parseDictionary(json, w), offline: false, glossary: gl, source: 'dictionaryapi' };
    } catch (e) {
      if (!isNetErr(e)) throw e;
      stats.failures++;
      if (!gl) throw err(e.message, 'EOFFLINE');
      return { word: w, phonetic: '', meanings: [], offline: true, glossary: gl, source: 'glossary' };
    }
  });

  api.handle('translate:mock', (state) => {
    if (!api.DEV) throw err('Not available', 'EPERM');
    if (state && typeof state === 'object') {
      if ('offline' in state) mock.offline = !!state.offline;
      if ('delayMs' in state) mock.delayMs = Math.max(0, Math.min(10000, Number(state.delayMs) || 0));
    }
    return { ...mock };
  });
  api.handle('translate:stats', () => ({ ...stats, urls: stats.urls.slice(), offline: mock.offline }));
}

module.exports = register;
Object.assign(module.exports, { LANGS, LIMITS, detectLang, glossaryTranslate, loadGlossary, normLang, myMemoryUrl, parseMyMemory, parseDictionary, libreBase, decodeEntities });
