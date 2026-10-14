// Aide — pure helpers (no DOM): inline markup, text normalisation, search, article visibility.
// Importable from the app, the first-sign-in feature and the tests (app://shell/apps/help/lib.js).
//
// Inline markup inside article strings (content/*.js):
//   **Label**          a name shown on screen (bold)
//   {{Super+Shift+S}}  key caps of a literal combo (main/lib/hotkeys.js syntax; key names translated by comboKeys)
//   {{sc:actionId}}    key caps of the combo IN EFFECT for a core/shortcuts.js catalog action (the user's own
//                      shortcut when changed in Paramètres; « désactivé » when turned off)
//   [[articleId]]      link to another article (its title); [[articleId|text]] with other text
//
// Body blocks (an array per language):
//   'text'                       paragraph
//   { h: 'text' }                sub-heading
//   { steps: ['…', '…'] }        numbered steps          { list: ['…'] }   bullet list
//   { tip: 'text' }              tip (lightbulb)         { note: 'text' }  caution
//   { action: 'id' } / { actions: ['id', …] }   buttons of the article's `actions` (hidden when the target is missing)
//   { shortcuts: 'all' }         the live shortcut list (core/shortcuts.js + settings.shortcuts)
//   { howto: true }              how to open a feature found at run time (article.find, see resolveFind)
//
// Article: { id, topic, title: {en, fr}, summary: {en, fr}, keywords: {en: [], fr: []}, body: {en: [], fr: []},
//            related: [ids], actions: { id: { app, args, label?: {en, fr} } },
//            requires: [{ app } | { find }]  (shown only when one of them exists), find: { … } (see resolveFind) }

const INLINE = /\*\*(.+?)\*\*|\{\{(.+?)\}\}|\[\[(.+?)\]\]/g;

/** 'Press {{Super+S}} then **Search**' -> [{ t: 'text', v }, { t: 'keys', v }, …] */
export function parseInline(str) {
  const out = [];
  const s = String(str ?? '');
  let last = 0;
  INLINE.lastIndex = 0;
  let m;
  while ((m = INLINE.exec(s))) {
    if (m.index > last) out.push({ t: 'text', v: s.slice(last, m.index) });
    if (m[1] != null) out.push({ t: 'b', v: m[1] });
    else if (m[2] != null) {
      const v = m[2].trim();
      if (v.startsWith('sc:')) out.push({ t: 'sc', v: v.slice(3) });
      else out.push({ t: 'keys', v });
    } else {
      const [id, label] = m[3].split('|');
      out.push({ t: 'link', v: id.trim(), label: label != null ? label.trim() : null });
    }
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ t: 'text', v: s.slice(last) });
  return out;
}

/** Every string of a body (paragraphs, list items, tips…), for search and checks. */
export function blockStrings(blocks) {
  const out = [];
  for (const b of blocks || []) {
    if (typeof b === 'string') out.push(b);
    else if (b && typeof b === 'object') {
      for (const k of ['h', 'tip', 'note']) if (typeof b[k] === 'string') out.push(b[k]);
      for (const k of ['steps', 'list']) if (Array.isArray(b[k])) out.push(...b[k].map(String));
    }
  }
  return out;
}

/** Action ids a body refers to. */
export function blockActions(blocks) {
  const out = [];
  for (const b of blocks || []) {
    if (b && typeof b === 'object') {
      if (typeof b.action === 'string') out.push(b.action);
      if (Array.isArray(b.actions)) out.push(...b.actions);
    }
  }
  return out;
}

/** Inline tokens of every string of a body. */
export function bodyTokens(blocks) {
  return blockStrings(blocks).flatMap(parseInline);
}

/**
 * Lower case, no accents, ligatures spelled out, apostrophes as spaces, hyphens and dots dropped:
 * « Périphérique » -> 'peripherique', « Wi-Fi » -> 'wifi', « l’écran » -> 'l ecran', « cœur » -> 'coeur'.
 */
export function norm(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/œ/g, 'oe')
    .replace(/æ/g, 'ae')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’'`«»"“”]/g, ' ')
    .replace(/[-‐‑_.]/g, '')
    .replace(/[^\p{L}\p{N}+ ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Words that say nothing about what is looked for (ignored unless the query has nothing else).
const STOP = new Set(
  'a an and are can do does for from how i in is it my of on or the to what where why with your you ' +
    'au aux avec ce ces comment dans de des du elle en est et il je la le les leur ma mes mon ne ou par pas plus pour quoi qu que qui sa se ses son sur ta tes ton un une vos votre d l j s n c m t y'
      .split(' '),
);

// A very light stemmer for the query only (matching is by word prefix): « changer » -> « chang » also finds
// « change », « imprimantes » -> « imprimant », « printers » -> « printer », « installing » -> « install ».
const SUFFIX = /(ements|ement|ations|ation|ings|ing|ers|ez|er|es|ed|e|s)$/;
export function stem(w) {
  if (w.length < 5 || /\d/.test(w)) return w;
  const s = w.replace(SUFFIX, '');
  return s.length >= 4 ? s : w;
}

/** Query -> significant words (stemmed). */
export function queryTerms(q) {
  const words = norm(q).split(' ').filter(Boolean);
  const kept = words.filter((w) => !STOP.has(w));
  return (kept.length ? kept : words).map(stem);
}

/** Plain text of an inline string (markup removed), for search. */
export function plain(str, { titleOf = (id) => id } = {}) {
  return parseInline(str)
    .map((tk) => (tk.t === 'link' ? tk.label || titleOf(tk.v) : tk.t === 'keys' ? tk.v.replace(/\+/g, ' ') : tk.t === 'sc' ? '' : tk.v))
    .join('');
}

const L = (o, lang) => (o && typeof o === 'object' ? o[lang] ?? o.en ?? '' : o ?? '');

/**
 * Search index entries for a language: [{ id, fields: { title, keywords, summary, topic, body } }] (normalised).
 * extra(article, lang) may add text (the shortcut article adds the live catalog names).
 */
export function buildIndex(articles, lang, { topicTitle = () => '', titleOf = (id) => id, extra = () => '' } = {}) {
  return articles.map((a) => ({
    id: a.id,
    fields: {
      title: norm(L(a.title, lang)),
      keywords: norm((a.keywords?.[lang] || []).join(' ')),
      summary: norm(L(a.summary, lang)),
      topic: norm(topicTitle(a.topic, lang)),
      body: norm([...blockStrings(a.body?.[lang]).map((s) => plain(s, { titleOf: (id) => titleOf(id, lang) })), extra(a, lang) || ''].join(' ')),
    },
  }));
}

const WEIGHTS = { title: 10, keywords: 6, summary: 4, topic: 2, body: 1 };

function termScore(fields, term) {
  let best = 0;
  for (const [f, text] of Object.entries(fields)) {
    if (!text) continue;
    const w = WEIGHTS[f] || 1;
    // a word that starts with the term; a longer term may also sit inside a word (« clavier » in « raccourcisclavier »)
    const start = text === term || text.startsWith(term) || text.includes(` ${term}`);
    const inside = !start && term.length >= 4 && text.includes(term);
    const s = start ? w : inside ? w / 2 : 0;
    if (s > best) best = s;
  }
  return best;
}

/**
 * Ranked results: [{ id, score, matched, total }]. Articles holding every significant word come first; when none
 * does, the ones holding some of them (`partial: true` on the result list).
 */
export function search(index, q) {
  const terms = queryTerms(q);
  if (!terms.length) return Object.assign([], { partial: false, terms });
  const scored = [];
  for (const e of index) {
    let score = 0;
    let matched = 0;
    for (const t of terms) {
      const s = termScore(e.fields, t);
      if (s > 0) {
        matched++;
        score += s;
      }
    }
    // the whole query as typed, found in the title: best of all
    const whole = norm(q);
    if (whole.includes(' ') && e.fields.title.includes(whole)) score += 15;
    if (matched) scored.push({ id: e.id, score, matched, total: terms.length });
  }
  const full = scored.filter((r) => r.matched === r.total).sort((a, b) => b.score - a.score);
  if (full.length) return Object.assign(full, { partial: false, terms });
  const some = scored.sort((a, b) => b.matched - a.matched || b.score - a.score);
  return Object.assign(some, { partial: true, terms });
}

/**
 * Does a feature described by `find` exist right now? `env` = { hasApp(id), shortcuts: [{ id, combo, name }],
 * bindings: { combo: fn }, settingsEntries: [{ page, section, name: {en, fr} }] }.
 * find = { apps: ['id'…], names: [RegExp…] (matched on EN and FR names), combos: ['Super+Period'…] }
 * -> { app, shortcut: { id, combo? }, combo, settings: { page, section } } with what was found (null when nothing).
 */
export function resolveFind(find, env) {
  if (!find) return null;
  const out = {};
  const names = (find.names || []).map((r) => (r instanceof RegExp ? r : new RegExp(String(r), 'i')));
  const named = (n) => !!n && names.some((r) => r.test(n.en || '') || r.test(n.fr || ''));
  for (const id of find.apps || []) {
    if (env.hasApp?.(id)) {
      out.app = id;
      break;
    }
  }
  const sc = (env.shortcuts || []).find((s) => named(s.name) || (s.combo && (find.combos || []).includes(s.combo)));
  if (sc) out.shortcut = { id: sc.id };
  else {
    const combo = (find.combos || []).find((c) => env.bindings && env.bindings[c]);
    if (combo) out.combo = combo;
  }
  const entry = (env.settingsEntries || []).find((e) => named(e.name));
  if (entry) out.settings = { page: entry.page, section: entry.section || null };
  return Object.keys(out).length ? out : null;
}

/** Is the article shown? (no `requires` = always) */
export function isVisible(article, env) {
  if (!Array.isArray(article.requires) || !article.requires.length) return true;
  return article.requires.some((r) => (r.app ? !!env.hasApp?.(r.app) : r.find ? !!resolveFind(article.find, env) : false));
}
