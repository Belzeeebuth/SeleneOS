#!/usr/bin/env node
// Builds the data of the emoji and symbols panel (renderer/core/features/emoji.js, Super+. / Super+;):
//   renderer/assets/emoji/emoji.json          (loaded lazily the first time the panel opens)
//   renderer/assets/emoji/LICENSE-unicode.txt (Unicode License v3: emoji-test.txt and the CLDR annotations)
//
//   node tools/gen-emoji.mjs [--emoji 15.1] [--max 15.1] [--cldr 48.2.3] [--cache DIR] [--offline]
//
// Sources (downloaded once into --cache, default ~/.cache/selene-dev/emoji-src, checked against the SHA-256 below
// for the default versions):
//   - Unicode emoji-test.txt <emoji>: order, groups, versions and skin-tone variants (fully-qualified forms only).
//   - CLDR <cldr> JSON (github.com/unicode-org/cldr-json): cldr-annotations-full (names + keywords of single
//     characters, emoji and symbols) and cldr-annotations-derived-full (sequences: tones, ZWJ, flags, keycaps), en + fr.
// Only emoji up to --max (default: the --emoji version) are kept, so every one renders with the image's Noto Color
// Emoji: fonts-noto-color-emoji 2.042 (noble) and 2.047 (noble-updates, what the image installs) both draw Emoji 15.1
// (phoenix, lime, broken chain, head shaking, people facing right…) but not 16.0. test/emoji.test.mjs checks every
// emoji and tone variant against 2.042 (one coloured glyph each) when that font is at hand.
// The « Symboles » groups, the kaomoji and the popular emoji (shown in « Récents » before anything was inserted)
// are written by hand below; symbol names come from CLDR when it has them, else from the tables below.
//
// Output (compact JSON, ~250 KB):
//   { v: 1, emoji: '15.1', max: '15.1', cldr: '48.2.3',
//     groups: ['smileys', 'people', 'nature', 'food', 'travel', 'activities', 'objects', 'symbols', 'flags'],
//     e: [[char, group, enName, frName, enKeywords, frKeywords, tone, popular], …]   (trailing empty fields dropped)
//        keywords: '|'-joined, without the words already in the name; tone: 0 = none, 1 = the modifier goes right
//        after the first code point (a following U+FE0F is dropped), or the light-skin variant (U+1F3FB stands for
//        the chosen modifier); popular: rank (1 = most used) or 0
//     symbols: [{ id, en, fr, items: [[char, enName, frName, enKeywords, frKeywords], …] }, …]
//     kaomoji: [{ id, en, fr, items: [[text, enName, frName], …] }, …] }
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SHELL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(SHELL, 'renderer', 'assets', 'emoji');

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const EMOJI = arg('emoji', '15.1');
const MAX_STR = arg('max', EMOJI);
const MAX = Number(MAX_STR);
const CLDR = arg('cldr', '48.2.3');
const CACHE = arg('cache', path.join(os.homedir(), '.cache', 'selene-dev', 'emoji-src'));
const OFFLINE = process.argv.includes('--offline');

const CLDR_RAW = `https://raw.githubusercontent.com/unicode-org/cldr-json/${CLDR}`;
const SOURCES = {
  [`emoji-test-${EMOJI}.txt`]: { url: `https://unicode.org/Public/emoji/${EMOJI}/emoji-test.txt`, sha256: { '15.0': '8445f23ac8388e096be19d0262e14fceff856ff52093f2356dc89485f1a853db', '15.1': 'd876ee249aa28eaa76cfa6dfaa702847a8d13b062aa488d465d0395ee8137ed9' }[EMOJI] },
  ...Object.fromEntries(
    ['en', 'fr'].flatMap((l) => [
      [`cldr-${CLDR}-annotations-${l}.json`, { url: `${CLDR_RAW}/cldr-json/cldr-annotations-full/annotations/${l}/annotations.json`, sha256: CLDR === '48.2.3' ? { en: 'f22083cb86dffb63a643d5bacb5d9899f82d2fa5d388ad4f3aed72184acef505', fr: '33da052f74782791989e6226d60871c846799e077a5a7fb4e87ecfa7ca385733' }[l] : null }],
      [`cldr-${CLDR}-derived-${l}.json`, { url: `${CLDR_RAW}/cldr-json/cldr-annotations-derived-full/annotationsDerived/${l}/annotations.json`, sha256: CLDR === '48.2.3' ? { en: '15c9457afa703a32dcc78d54626418a91e820fe0ddd67b7d491c4c4d9f5846ab', fr: '012bb08af81a2ea0686e8fe069388f02dbd025d62b02d7423067c452b37e8855' }[l] : null }],
    ]),
  ),
  [`cldr-${CLDR}-LICENSE`]: { url: `${CLDR_RAW}/LICENSE`, sha256: CLDR === '48.2.3' ? '220ba0e1c43b99530d2d5bdb892a99dca0989414f51ab695ecd90163eaa1ec3b' : null },
};

async function source(name) {
  const { url, sha256 } = SOURCES[name];
  const file = path.join(CACHE, name);
  if (!fs.existsSync(file)) {
    if (OFFLINE) throw new Error(`${name} is not in ${CACHE} (--offline)`);
    fs.mkdirSync(CACHE, { recursive: true });
    console.log(`downloading ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    fs.writeFileSync(`${file}.part`, Buffer.from(await res.arrayBuffer()));
    fs.renameSync(`${file}.part`, file);
  }
  const buf = fs.readFileSync(file);
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  if (sha256 && hash !== sha256) throw new Error(`${name}: SHA-256 ${hash}, expected ${sha256} (delete ${file} to download it again)`);
  if (!sha256) console.log(`note: ${name} not pinned (sha256 ${hash})`);
  return buf.toString('utf8');
}

// ------------------------------------------------------------------ emoji-test.txt
const GROUPS = { 'Smileys & Emotion': 'smileys', 'People & Body': 'people', 'Animals & Nature': 'nature', 'Food & Drink': 'food', 'Travel & Places': 'travel', Activities: 'activities', Objects: 'objects', Symbols: 'symbols', Flags: 'flags' };
const GROUP_IDS = Object.values(GROUPS);
const TONES = ['\u{1F3FB}', '\u{1F3FC}', '\u{1F3FD}', '\u{1F3FE}', '\u{1F3FF}'];
const TONE_RE = /[\u{1F3FB}-\u{1F3FF}]/gu;
const noVS = (s) => s.replace(/\uFE0F/g, '');

/** The default tone rule (same code in core/features/emoji.js): the modifier right after the first code point. */
export function defaultTone(seq, mod) {
  const cps = [...seq];
  return cps[0] + mod + cps.slice(cps[1] === '\uFE0F' ? 2 : 1).join('');
}

function parseEmojiTest(text) {
  const list = []; // { char, group, name, version }
  const variants = new Map(); // base char (no FE0F) -> Map(tone -> char) (uniform tones only)
  let group = null;
  let skipped = 0;
  for (const line of text.split('\n')) {
    const g = /^# group: (.+)$/.exec(line);
    if (g) {
      group = GROUPS[g[1].trim()] || null; // 'Component' -> null
      continue;
    }
    const m = /^([0-9A-F ]+?)\s*;\s*fully-qualified\s*#\s*\S+\s+E(\d+\.\d+)\s+(.+)$/.exec(line);
    if (!m || !group) continue;
    const char = String.fromCodePoint(...m[1].split(/\s+/).map((h) => parseInt(h, 16)));
    const version = Number(m[2]);
    if (version > MAX) {
      skipped++;
      continue;
    }
    const tones = char.match(TONE_RE);
    if (tones) {
      if (new Set(tones).size !== 1) continue; // mixed tones (two people): not offered
      const base = noVS(char.replace(TONE_RE, ''));
      if (!variants.has(base)) variants.set(base, new Map());
      variants.get(base).set(tones[0], char);
      continue;
    }
    list.push({ char, group, name: m[3].trim(), version });
  }
  return { list, variants, skipped };
}

// ------------------------------------------------------------------ CLDR annotations
function annotations(lang, full, derived) {
  return { ...JSON.parse(full).annotations.annotations, ...JSON.parse(derived).annotationsDerived.annotations };
}
const fold = (s) =>
  String(s)
    .toLowerCase()
    .replace(/œ/g, 'oe')
    .replace(/æ/g, 'ae')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’']/g, ' ');
const words = (s) => fold(s).split(/[^a-z0-9#*]+/).filter(Boolean);

/** Name and keywords ('|'-joined, without the ones whose words are all in the name). */
function describe(ann, char, fallbackName) {
  const a = ann[char] || ann[noVS(char)];
  const name = (a?.tts?.[0] || fallbackName || '').trim();
  const inName = new Set(words(name));
  const kws = [];
  for (const k of a?.default || []) {
    const ws = words(k);
    if (!ws.length || ws.every((w) => inName.has(w))) continue;
    if (!kws.some((x) => fold(x) === fold(k))) kws.push(k.trim());
  }
  return { name, kws: kws.join('|'), known: !!a };
}

// ------------------------------------------------------------------ hand-written data
// Most used emoji (Unicode's emoji frequency list): « Récents » before anything was inserted, and a tie-breaker in search.
const POPULAR = ['😂', '❤️', '🤣', '👍', '😭', '🙏', '😘', '🥰', '😍', '😊', '🎉', '😁', '💕', '🥺', '😅', '🔥', '☺️', '🤦', '♥️', '🤷', '🙄', '😆', '🤗', '😉', '🎂', '🤔', '👏', '🙂', '😳', '🥳', '😎', '👌', '💜', '😔', '💪', '✨', '💖', '👀', '😋', '😏', '😢', '👉', '💗', '😩', '💯', '🌹', '💞', '🎈', '💙', '😃', '😡', '💐', '😜', '🙈', '🤞', '😄', '🤤', '🙌', '🤪', '❣️', '😀', '💋', '💀', '👇', '💔', '😌', '💓', '🤩', '🙃', '😬', '😱', '😴', '🤭', '😐', '🌞', '😒', '😇', '🌸', '😈', '🎶', '✌️', '🎊', '🥵', '😞', '💚', '☀️', '🖤', '💰', '😚', '👑', '🎁', '💥', '🙋', '☹️', '😑', '🥴', '👈', '💩', '✅'];

// Symbol groups (`extra`: characters that cannot be written in `chars`, e.g. the invisible French spaces, which
// core/features/emoji.js labels with a short localized word).
const SYMBOL_GROUPS = [
  { id: 'punctuation', en: 'Punctuation', fr: 'Ponctuation', chars: '«»‹›“”„‘’‚—–‐…·•‣¡¿‽†‡′″¦⁂※', extra: ['\u00A0', '\u202F'] },
  { id: 'currency', en: 'Currency', fr: 'Devises', chars: '€£$¥¢¤₣₤₹₽₩₪₺₿₫₴₦₱₸₼฿₡₲₵₭₮₾' },
  { id: 'letters', en: 'Accented letters', fr: 'Lettres accentuées', chars: 'ÉÈÊËÀÂÄÇÎÏÔÖÙÛÜŸŒÆéèêëàâäçîïôöùûüÿœæßẞñÑãõÃÕáíóúÁÍÓÚåÅøØıłŁšŠžŽčČğşőű' },
  { id: 'math', en: 'Mathematics', fr: 'Mathématiques', chars: '±×÷−≠≈≡≤≥∞√∛∑∏∫∂∆∇∈∉⊂⊃⊆⊇∩∪∅∀∃¬∧∨⊕∝∠⊥∥°%‰½⅓⅔¼¾⅛⅜⅝⅞⁰¹²³⁴⁵⁶⁷⁸⁹ⁿ₀₁₂₃₄₅₆₇₈₉µℕℤℚℝℂ' },
  { id: 'arrows', en: 'Arrows', fr: 'Flèches', chars: '→←↑↓↔↕↖↗↘↙⇒⇐⇑⇓⇔⇕⟶⟵⟷⟹↩↪↺↻➜➔' },
  { id: 'greek', en: 'Greek letters', fr: 'Lettres grecques', chars: 'αβγδεζηθικλμνξοπρσςτυφχψωΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩ' },
  { id: 'shapes', en: 'Bullets and shapes', fr: 'Puces et formes', chars: '◦▪▫■□●○◆◇◊▲△▼▽►◄★☆✦✧❖' },
  { id: 'signs', en: 'Signs', fr: 'Signes', chars: '©®™℗§¶№℃℉ℓ℮♀♂⚥✓✔✗✘♠♣♥♦♤♧♡♢♪♫♭♯☐☑☒☎✉✂✎⌘⌥⇧⌫⏎⌨☀☁☂☃☼☾✈☮☯∴∵' },
];

// Names CLDR lacks (or that read better here): char -> [en, fr, enKeywords, frKeywords].
const SYMBOL_NAMES = {
  '‹': ['single left-pointing angle quotation mark', 'guillemet simple ouvrant', 'quote', 'guillemet'],
  '›': ['single right-pointing angle quotation mark', 'guillemet simple fermant', 'quote', 'guillemet'],
  '«': ['left-pointing double angle quotation mark', 'guillemet ouvrant', 'quote|guillemet', 'chevron'],
  '»': ['right-pointing double angle quotation mark', 'guillemet fermant', 'quote|guillemet', 'chevron'],
  '“': ['left double quotation mark', 'guillemet anglais ouvrant', 'quote', ''],
  '”': ['right double quotation mark', 'guillemet anglais fermant', 'quote', ''],
  '‘': ['left single quotation mark', 'apostrophe ouvrante', 'quote', 'guillemet simple'],
  '’': ['right single quotation mark', 'apostrophe typographique', 'apostrophe|quote', 'guillemet simple'],
  '‐': ['hyphen', 'trait d’union', 'dash', 'tiret'],
  '‣': ['triangular bullet', 'puce triangulaire', '', ''],
  '‽': ['interrobang', 'point exclarogatif', '', 'point d’interrogation|point d’exclamation'],
  '⁂': ['asterism', 'astérisme', '', ''],
  '※': ['reference mark', 'marque de référence', '', ''],
  '¦': ['broken bar', 'barre verticale discontinue', '', ''],
  '\u00A0': ['no-break space', 'espace insécable', 'nbsp|space', 'espace'],
  '\u202F': ['narrow no-break space', 'espace fine insécable', 'space|french', 'espace|typographie'],
  '¤': ['currency sign', 'symbole monétaire', '', ''],
  '₤': ['lira sign', 'lire', '', ''],
  '₪': ['new shekel sign', 'nouveau shekel', '', ''],
  '₺': ['Turkish lira sign', 'livre turque', '', ''],
  '₫': ['dong sign', 'dong', '', ''],
  '₴': ['hryvnia sign', 'hryvnia', '', ''],
  '₦': ['naira sign', 'naira', '', ''],
  '₱': ['peso sign', 'peso', '', ''],
  '₸': ['tenge sign', 'tenge', '', ''],
  '₼': ['manat sign', 'manat', '', ''],
  '฿': ['baht sign', 'baht', '', ''],
  '₡': ['colon sign', 'colón', '', ''],
  '₲': ['guarani sign', 'guarani', '', ''],
  '₵': ['cedi sign', 'cedi', '', ''],
  '₭': ['kip sign', 'kip', '', ''],
  '₮': ['tugrik sign', 'tugrik', '', ''],
  '₾': ['lari sign', 'lari', '', ''],
  '−': ['minus sign', 'signe moins', 'minus', 'moins'],
  '≡': ['identical to', 'identique à', '', 'équivalent'],
  '∛': ['cube root', 'racine cubique', '', ''],
  '∏': ['n-ary product', 'produit', '', ''],
  '∇': ['nabla', 'nabla', '', ''],
  '∉': ['not an element of', 'n’appartient pas à', '', ''],
  '⊂': ['subset of', 'sous-ensemble de', '', 'inclus'],
  '⊃': ['superset of', 'sur-ensemble de', '', 'contient'],
  '⊆': ['subset of or equal to', 'sous-ensemble ou égal', '', 'inclus'],
  '⊇': ['superset of or equal to', 'sur-ensemble ou égal', '', 'contient'],
  '∅': ['empty set', 'ensemble vide', '', ''],
  '∀': ['for all', 'pour tout', '', 'quel que soit'],
  '∃': ['there exists', 'il existe', '', ''],
  '¬': ['not sign', 'négation', '', 'non'],
  '∧': ['logical and', 'et logique', '', ''],
  '∨': ['logical or', 'ou logique', '', ''],
  '⊕': ['circled plus', 'plus cerclé', 'xor', 'ou exclusif'],
  '∝': ['proportional to', 'proportionnel à', '', ''],
  '∠': ['angle', 'angle', '', ''],
  '⊥': ['perpendicular', 'perpendiculaire', '', ''],
  '∥': ['parallel to', 'parallèle à', '', ''],
  'ⁿ': ['superscript n', 'exposant n', '', ''],
  'ℕ': ['natural numbers', 'entiers naturels', '', ''],
  'ℤ': ['integers', 'entiers relatifs', '', ''],
  'ℚ': ['rational numbers', 'nombres rationnels', '', ''],
  'ℝ': ['real numbers', 'nombres réels', '', ''],
  'ℂ': ['complex numbers', 'nombres complexes', '', ''],
  'µ': ['micro sign', 'symbole micro', 'mu', 'mu'],
  '⇐': ['leftwards double arrow', 'flèche double vers la gauche', '', ''],
  '⇑': ['upwards double arrow', 'flèche double vers le haut', '', ''],
  '⇓': ['downwards double arrow', 'flèche double vers le bas', '', ''],
  '⇕': ['up down double arrow', 'flèche double vers le haut et le bas', '', ''],
  '⟶': ['long rightwards arrow', 'longue flèche vers la droite', '', ''],
  '⟵': ['long leftwards arrow', 'longue flèche vers la gauche', '', ''],
  '⟷': ['long left right arrow', 'longue flèche gauche droite', '', ''],
  '⟹': ['long rightwards double arrow', 'longue flèche double vers la droite', 'implies', 'implique'],
  '↺': ['anticlockwise open circle arrow', 'flèche circulaire sens antihoraire', '', ''],
  '↻': ['clockwise open circle arrow', 'flèche circulaire sens horaire', '', ''],
  '➜': ['heavy round-tipped rightwards arrow', 'flèche épaisse vers la droite', '', ''],
  '➔': ['heavy wide-headed rightwards arrow', 'flèche large vers la droite', '', ''],
  '◦': ['white bullet', 'puce blanche', '', ''],
  '▪': ['black small square', 'petit carré noir', '', 'puce'],
  '▫': ['white small square', 'petit carré blanc', '', 'puce'],
  '■': ['black square', 'carré noir', '', ''],
  '□': ['white square', 'carré blanc', '', ''],
  '●': ['black circle', 'disque noir', '', 'rond'],
  '○': ['white circle', 'cercle blanc', '', 'rond'],
  '◆': ['black diamond', 'losange noir', '', ''],
  '◇': ['white diamond', 'losange blanc', '', ''],
  '◊': ['lozenge', 'losange', '', ''],
  '▲': ['black up-pointing triangle', 'triangle noir vers le haut', '', ''],
  '△': ['white up-pointing triangle', 'triangle blanc vers le haut', '', ''],
  '▼': ['black down-pointing triangle', 'triangle noir vers le bas', '', ''],
  '▽': ['white down-pointing triangle', 'triangle blanc vers le bas', '', ''],
  '►': ['black right-pointing pointer', 'pointeur noir vers la droite', '', ''],
  '◄': ['black left-pointing pointer', 'pointeur noir vers la gauche', '', ''],
  '★': ['black star', 'étoile noire', 'star', 'étoile'],
  '☆': ['white star', 'étoile blanche', 'star', 'étoile'],
  '✦': ['black four-pointed star', 'étoile noire à quatre branches', '', ''],
  '✧': ['white four-pointed star', 'étoile blanche à quatre branches', '', ''],
  '❖': ['black diamond minus white X', 'losange à quatre losanges', '', ''],
  '℗': ['sound recording copyright', 'droit d’auteur phonographique', '', ''],
  '№': ['numero sign', 'symbole numéro', 'number', 'numéro'],
  '℃': ['degree Celsius', 'degré Celsius', '', ''],
  '℉': ['degree Fahrenheit', 'degré Fahrenheit', '', ''],
  'ℓ': ['script small l', 'l cursif', 'litre', 'litre'],
  '℮': ['estimated symbol', 'symbole estimé', '', ''],
  '⚥': ['male and female sign', 'symbole homme et femme', '', ''],
  '✓': ['check mark', 'coche', 'tick', ''],
  '✗': ['ballot X', 'croix', '', ''],
  '✘': ['heavy ballot X', 'croix épaisse', '', ''],
  '♤': ['white spade suit', 'pique blanc', '', 'cartes'],
  '♧': ['white club suit', 'trèfle blanc', '', 'cartes'],
  '♡': ['white heart suit', 'cœur blanc', '', 'cartes'],
  '♢': ['white diamond suit', 'carreau blanc', '', 'cartes'],
  '♫': ['beamed eighth notes', 'doubles croches', 'music', 'musique'],
  '♭': ['music flat sign', 'bémol', '', 'musique'],
  '♯': ['music sharp sign', 'dièse', '', 'musique'],
  '☐': ['ballot box', 'case à cocher', 'checkbox', ''],
  '☑': ['ballot box with check', 'case cochée', 'checkbox', ''],
  '☒': ['ballot box with X', 'case avec une croix', 'checkbox', ''],
  '✉': ['envelope', 'enveloppe', 'mail', 'courrier'],
  '✎': ['lower right pencil', 'crayon', '', ''],
  '⌘': ['place of interest sign', 'touche Commande', 'command', 'commande'],
  '⌥': ['option key', 'touche Option', '', ''],
  '⇧': ['upwards white arrow', 'flèche blanche vers le haut', 'shift', 'majuscule'],
  '⌫': ['erase to the left', 'effacement arrière', 'backspace', 'retour arrière'],
  '⏎': ['return symbol', 'symbole Entrée', 'enter|return', 'entrée'],
  '⌨': ['keyboard', 'clavier', '', ''],
  '☃': ['snowman', 'bonhomme de neige', '', ''],
  '☼': ['white sun with rays', 'soleil', '', ''],
  '☾': ['last quarter moon', 'croissant de lune', 'moon', 'lune'],
  '∴': ['therefore', 'donc', '', ''],
  '∵': ['because', 'parce que', '', ''],
};
const FRACTIONS = { '½': ['one half', 'un demi'], '⅓': ['one third', 'un tiers'], '⅔': ['two thirds', 'deux tiers'], '¼': ['one quarter', 'un quart'], '¾': ['three quarters', 'trois quarts'], '⅛': ['one eighth', 'un huitième'], '⅜': ['three eighths', 'trois huitièmes'], '⅝': ['five eighths', 'cinq huitièmes'], '⅞': ['seven eighths', 'sept huitièmes'] };
const DIGITS = [['zero', 'zéro'], ['one', 'un'], ['two', 'deux'], ['three', 'trois'], ['four', 'quatre'], ['five', 'cinq'], ['six', 'six'], ['seven', 'sept'], ['eight', 'huit'], ['nine', 'neuf']];
const GREEK = ['alpha', 'beta|bêta', 'gamma', 'delta', 'epsilon', 'zeta|zêta', 'eta|êta', 'theta|thêta', 'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'omicron', 'pi', 'rho|rhô', 'final sigma|sigma final', 'sigma', 'tau', 'upsilon', 'phi', 'chi|khi', 'psi', 'omega|oméga'];
const ACCENTS = { '\u0301': ['acute accent', 'accent aigu'], '\u0300': ['grave accent', 'accent grave'], '\u0302': ['circumflex', 'accent circonflexe'], '\u0308': ['diaeresis', 'tréma'], '\u0327': ['cedilla', 'cédille'], '\u0303': ['tilde', 'tilde'], '\u030A': ['ring above', 'rond en chef'], '\u030C': ['caron', 'caron'], '\u0306': ['breve', 'brève'], '\u030B': ['double acute accent', 'double accent aigu'] };
const LETTERS = { Œ: ['capital OE', 'E dans l’O majuscule', 'ligature', 'ligature|oe'], œ: ['oe', 'e dans l’o', 'ligature', 'ligature|oe'], Æ: ['capital AE', 'E dans l’A majuscule', 'ligature', 'ligature|ae'], æ: ['ae', 'e dans l’a', 'ligature', 'ligature|ae'], ß: ['sharp s', 'eszett', 'german', 'allemand'], ẞ: ['capital sharp s', 'eszett majuscule', 'german', 'allemand'], ø: ['o with stroke', 'o barré', '', ''], Ø: ['capital O with stroke', 'O barré majuscule', '', ''], ı: ['dotless i', 'i sans point', 'turkish', 'turc'], ł: ['l with stroke', 'l barré', 'polish', 'polonais'], Ł: ['capital L with stroke', 'L barré majuscule', 'polish', 'polonais'] };

function generatedName(c) {
  if (SYMBOL_NAMES[c]) return SYMBOL_NAMES[c];
  if (FRACTIONS[c]) return [FRACTIONS[c][0], FRACTIONS[c][1], 'fraction', 'fraction'];
  if (LETTERS[c]) return LETTERS[c];
  const sup = '⁰¹²³⁴⁵⁶⁷⁸⁹'.indexOf(c);
  if (sup >= 0) return [`superscript ${DIGITS[sup][0]}`, `exposant ${DIGITS[sup][1]}`, 'power', 'puissance'];
  const sub = '₀₁₂₃₄₅₆₇₈₉'.indexOf(c);
  if (sub >= 0) return [`subscript ${DIGITS[sub][0]}`, `indice ${DIGITS[sub][1]}`, '', ''];
  const g = 'αβγδεζηθικλμνξοπρςστυφχψω'.indexOf(c);
  const G = 'ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡ΢ΣΤΥΦΧΨΩ'.indexOf(c);
  if (g >= 0 || G >= 0) {
    const [en, fr = en] = GREEK[g >= 0 ? g : G].split('|');
    return g >= 0 ? [`Greek small letter ${en}`, `lettre grecque minuscule ${fr}`, 'greek', 'grec'] : [`Greek capital letter ${en}`, `lettre grecque majuscule ${fr}`, 'greek', 'grec'];
  }
  const d = c.normalize('NFD');
  if (d.length === 2 && ACCENTS[d[1]]) {
    const upper = d[0] !== d[0].toLowerCase();
    const [en, fr] = ACCENTS[d[1]];
    return [upper ? `capital ${d[0]} with ${en}` : `${d[0]} with ${en}`, upper ? `${d[0]} majuscule ${fr}` : `${d[0]} ${fr}`, 'accent', 'accent'];
  }
  return null;
}

// Kaomoji (only characters the image's fonts draw: Noto Sans, Noto CJK, DejaVu).
const KAOMOJI = [
  { id: 'joy', en: 'Joy', fr: 'Joie', items: [['(^_^)', 'happy', 'content'], ['(^o^)/', 'cheering', 'hourra'], ['＼(^o^)／', 'hooray', 'youpi'], ['(≧▽≦)', 'delighted', 'ravi'], ['(*^‿^*)', 'smiling', 'souriant'], ['(✿◠‿◠)', 'cheerful', 'joyeux'], ['(ﾉ◕ヮ◕)ﾉ*:･ﾟ✧', 'sparkles of joy', 'joie scintillante'], ['ヽ(•‿•)ノ', 'yay', 'youpi'], ['(^_−)☆', 'wink', 'clin d’œil'], ['( ˘▽˘)っ♨', 'hot drink', 'boisson chaude']] },
  { id: 'love', en: 'Love', fr: 'Affection', items: [['(♥‿♥)', 'in love', 'amoureux'], ['(づ｡◕‿‿◕｡)づ', 'hug', 'câlin'], ['(っ˘з˘)っ', 'kiss', 'bisou'], ['(｡♥‿♥｡)', 'adoring', 'adorable'], ['(*˘︶˘*)', 'blissful', 'aux anges'], ['♡(ˆ▽ˆ)♡', 'love', 'amour']] },
  { id: 'sad', en: 'Sadness', fr: 'Tristesse', items: [['(T_T)', 'crying', 'pleurs'], ['(;_;)', 'tears', 'larmes'], ['(╥﹏╥)', 'sobbing', 'sanglots'], ['ಥ_ಥ', 'weeping', 'en larmes'], ['(._.)', 'sad', 'triste'], ['(ノ_<。)', 'upset', 'chagrin']] },
  { id: 'angry', en: 'Anger', fr: 'Colère', items: [['(╯°□°)╯︵ ┻━┻', 'table flip', 'renverser la table'], ['┬─┬ノ( º _ ºノ)', 'putting the table back', 'remettre la table'], ['(ಠ_ಠ)', 'disapproval', 'désapprobation'], ['(¬_¬)', 'annoyed', 'agacé'], ['(>_<)', 'frustrated', 'contrarié'], ['ᕦ(ò_óˇ)ᕤ', 'flexing', 'costaud'], ['(ง •̀_•́)ง', 'ready to fight', 'prêt à se battre']] },
  { id: 'surprise', en: 'Surprise', fr: 'Surprise', items: [['(°ロ°)!', 'shocked', 'choqué'], ['(o_O)', 'confused', 'perplexe'], ['(⊙_⊙)', 'stunned', 'stupéfait'], ['(・_・;)', 'nervous', 'gêné'], ['(＠_＠)', 'dizzy', 'étourdi'], ['Σ(°△°)', 'startled', 'surpris']] },
  { id: 'other', en: 'Other', fr: 'Divers', items: [['¯\\_(ツ)_/¯', 'shrug', 'haussement d’épaules'], ['( ͡° ͜ʖ ͡°)', 'lenny face', 'visage malicieux'], ['( •_•)>⌐■-■', 'putting on sunglasses', 'mettre ses lunettes'], ['(⌐■_■)', 'cool', 'cool'], ['ʕ•ᴥ•ʔ', 'bear', 'ourson'], ['(=^･ω･^=)', 'cat', 'chat'], ['(•_•)', 'neutral', 'neutre'], ['ʘ‿ʘ', 'wide eyes', 'yeux écarquillés'], ['(￣ー￣)ゞ', 'salute', 'salut'], ['(－‸ლ)', 'facepalm', 'consterné'], ['\\(°_o)/', 'who knows', 'aucune idée']] },
];

// ------------------------------------------------------------------ build
const emojiTest = await source(`emoji-test-${EMOJI}.txt`);
const ann = {};
for (const l of ['en', 'fr']) ann[l] = annotations(l, await source(`cldr-${CLDR}-annotations-${l}.json`), await source(`cldr-${CLDR}-derived-${l}.json`));
const license = await source(`cldr-${CLDR}-LICENSE`);

const { list, variants, skipped } = parseEmojiTest(emojiTest);
const popRank = new Map(POPULAR.map((c, i) => [noVS(c), i + 1]));
const missing = { en: [], fr: [] };
let toned = 0;
let explicitTone = 0;
const e = list.map((x) => {
  const en = describe(ann.en, x.char, x.name);
  const fr = describe(ann.fr, x.char, en.name);
  if (!en.known) missing.en.push(x.char);
  if (!fr.known) missing.fr.push(x.char);
  let tone = 0;
  const v = variants.get(noVS(x.char));
  if (v && TONES.every((t) => v.has(t))) {
    toned++;
    const light = v.get(TONES[0]);
    if (defaultTone(x.char, TONES[0]) === light) tone = 1;
    else {
      tone = light;
      explicitTone++;
    }
    for (const t of TONES) if ((tone === 1 ? defaultTone(x.char, t) : light.replaceAll(TONES[0], t)) !== v.get(t)) throw new Error(`tone rule fails for ${x.char} ${t}`);
  }
  const row = [x.char, GROUP_IDS.indexOf(x.group), en.name, fr.name, en.kws, fr.kws, tone, popRank.get(noVS(x.char)) || 0];
  while (row.length > 4 && !row[row.length - 1]) row.pop();
  return row;
});
for (const c of POPULAR) if (!list.some((x) => noVS(x.char) === noVS(c))) throw new Error(`popular emoji ${c} not in the list`);

// emoji with an emoji presentation by default (they would draw in colour in the Symboles tab)
const emojiPresentation = new Set(list.map((x) => x.char).filter((c) => [...c].length === 1));
const symbols = SYMBOL_GROUPS.map((g) => {
  const items = [];
  for (const c of [...g.chars, ...(g.extra || [])]) {
    if (emojiPresentation.has(c)) throw new Error(`symbol ${c} (${g.id}) draws as an emoji by default`);
    if (items.some((it) => it[0] === c)) throw new Error(`symbol ${c} twice in ${g.id}`);
    const gen = generatedName(c);
    const en = describe(ann.en, c, gen?.[0]);
    const fr = describe(ann.fr, c, gen?.[1]);
    const name = { en: gen && SYMBOL_NAMES[c] ? gen[0] : en.name, fr: gen && SYMBOL_NAMES[c] ? gen[1] : fr.name };
    if (!name.en || !name.fr) throw new Error(`no name for symbol ${c} (U+${c.codePointAt(0).toString(16)})`);
    const kw = (base, extra) => [...new Set([...(base ? base.split('|') : []), ...(extra ? extra.split('|') : [])])].filter((k) => !words(k).every((w) => words(name.en + ' ' + name.fr).includes(w))).join('|');
    const row = [c, name.en, name.fr, kw(en.kws, gen?.[2]), kw(fr.kws, gen?.[3])];
    while (row.length > 3 && !row[row.length - 1]) row.pop();
    items.push(row);
  }
  return { id: g.id, en: g.en, fr: g.fr, items };
});
const allSymbols = symbols.flatMap((g) => g.items.map((i) => i[0]));
if (new Set(allSymbols).size !== allSymbols.length) throw new Error('a symbol is in two groups');

const out = {
  v: 1,
  emoji: EMOJI,
  max: MAX_STR,
  cldr: CLDR,
  source: 'Unicode emoji-test.txt + CLDR annotations (en, fr): Unicode License v3, see LICENSE-unicode.txt',
  groups: GROUP_IDS,
  e,
  symbols,
  kaomoji: KAOMOJI.map((g) => ({ id: g.id, en: g.en, fr: g.fr, items: g.items })),
};
fs.mkdirSync(OUT_DIR, { recursive: true });
const json = JSON.stringify(out);
fs.writeFileSync(path.join(OUT_DIR, 'emoji.json'), `${json}\n`);
fs.writeFileSync(
  path.join(OUT_DIR, 'LICENSE-unicode.txt'),
  `emoji.json is built by shell/tools/gen-emoji.mjs from Unicode data files:\n` +
    `  - emoji-test.txt, Emoji ${EMOJI} (https://unicode.org/Public/emoji/${EMOJI}/emoji-test.txt)\n` +
    `  - CLDR ${CLDR} annotations and derived annotations, en and fr (https://github.com/unicode-org/cldr-json)\n` +
    `The symbol groups, kaomoji, popular list and the names CLDR lacks are written by the Selene OS contributors (MIT).\n` +
    `The Unicode data is distributed under the following licence.\n\n${license.trim()}\n`,
);
console.log(`emoji ${EMOJI} (≤ ${MAX}): ${e.length} emoji (${toned} with skin tones, ${explicitTone} by explicit variant), ${skipped} newer skipped`);
console.log(`symbols: ${allSymbols.length} in ${symbols.length} groups; kaomoji: ${KAOMOJI.reduce((n, g) => n + g.items.length, 0)}`);
console.log(`no CLDR entry: en ${missing.en.length} ${missing.en.join(' ')} / fr ${missing.fr.length} ${missing.fr.join(' ')}`);
console.log(`wrote ${path.relative(SHELL, path.join(OUT_DIR, 'emoji.json'))} (${(Buffer.byteLength(json) / 1024).toFixed(0)} KB)`);
