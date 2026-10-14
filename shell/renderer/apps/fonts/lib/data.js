// Polices: shared constants and small helpers (no DOM).

export const FONT_EXT = ['.ttf', '.otf', '.ttc', '.otc', '.woff', '.woff2'];
export const INSTALL_EXT = ['.ttf', '.otf', '.ttc', '.otc'];
export const DND_MIME = 'application/x-aurora-paths';

export const SIZE_MIN = 10;
export const SIZE_MAX = 120;
export const SIZE_DEFAULT = 32;
export const WATERFALL = [10, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 64, 72, 96];

// Filters of the sidebar, in order. Categories with no family are hidden (except « Toutes » and « Installées par moi »).
export const FILTERS = ['all', 'serif', 'sans', 'mono', 'script', 'decorative', 'symbol'];

// Pangrams for families that do not cover Latin (fontconfig languages, first match wins).
export const SCRIPT_SAMPLES = [
  ['el', 'Ζαφείρι δέξου πάγκαλο, βαθῶν ψυχῆς τὸ σῆμα'],
  ['ru', 'Съешь же ещё этих мягких французских булок'],
  ['uk', 'Чуєш їх, доцю, га? Кумедна ж ти, прощайся без ґольфів!'],
  ['ar', 'نص حكيم له سر قاطع وذو شأن عظيم'],
  ['he', 'דג סקרן שט בים מאוכזב ולפתע מצא חברה'],
  ['hi', 'ऋषियों को सताने वाले दुष्ट राक्षसों के राजा रावण का सर्वनाश'],
  ['th', 'เป็นมนุษย์สุดประเสริฐเลิศคุณค่า'],
  ['ja', 'いろはにほへと ちりぬるを わかよたれそ'],
  ['ko', '다람쥐 헌 쳇바퀴에 타고파'],
  ['zh-cn', '我能吞下玻璃而不伤身体'],
  ['zh-tw', '我能吞下玻璃而不傷身體'],
];
const LATIN = ['en', 'fr', 'de', 'es', 'it'];

/** Sample for a family: the user's text, the UI pangram for Latin fonts, another script's pangram, or null (symbols). */
export function sampleFor(fam, text, custom) {
  if (custom) return text;
  const langs = fam?.langs || [];
  if (!langs.length) return null; // covers no language: a symbol / icon font (its own glyphs are shown)
  if (langs.some((l) => LATIN.includes(l))) return text;
  for (const [l, s] of SCRIPT_SAMPLES) if (langs.includes(l)) return s;
  return text;
}

// Character map groups. Each lists code point ranges; only the characters the font maps are shown.
export const BLOCKS = [
  { id: 'upper', ranges: [[0x41, 0x5a]] },
  { id: 'lower', ranges: [[0x61, 0x7a]] },
  { id: 'digits', ranges: [[0x30, 0x39], [0xb2, 0xb3], [0xb9, 0xb9], [0xbc, 0xbe], [0x2070, 0x2070], [0x2074, 0x2079], [0x2080, 0x2089]] },
  { id: 'accents', ranges: [[0xc0, 0xd6], [0xd8, 0xf6], [0xf8, 0xff], [0x152, 0x153], [0x178, 0x178]] },
  {
    id: 'punct',
    ranges: [
      [0x21, 0x2f], [0x3a, 0x40], [0x5b, 0x60], [0x7b, 0x7e], [0xa1, 0xa1], [0xab, 0xab], [0xbb, 0xbb], [0xbf, 0xbf],
      [0x2010, 0x2011], [0x2013, 0x2014], [0x2018, 0x201a], [0x201c, 0x201e], [0x2020, 0x2022], [0x2026, 0x2026],
      [0x2030, 0x2030], [0x2039, 0x203a],
    ],
  },
  {
    id: 'symbols',
    ranges: [
      [0xa2, 0xa9], [0xae, 0xb1], [0xb4, 0xb7], [0xd7, 0xd7], [0xf7, 0xf7], [0x20ac, 0x20ac], [0x2116, 0x2116], [0x2122, 0x2122],
      [0x2190, 0x2193], [0x2212, 0x2212], [0x221e, 0x221e], [0x2248, 0x2248], [0x2260, 0x2260], [0x2264, 0x2265],
    ],
  },
  { id: 'latinExt', ranges: [[0x100, 0x151], [0x154, 0x177], [0x179, 0x17f]] },
  { id: 'greek', ranges: [[0x386, 0x386], [0x388, 0x38a], [0x38c, 0x38c], [0x38e, 0x3a1], [0x3a3, 0x3ce]] },
  { id: 'cyrillic', ranges: [[0x400, 0x45f]] },
];
const OTHER_MAX = 512;

/** Not shown as a character: controls, spaces, joiners, surrogates, variation selectors, combining marks, BOM. */
export function invisible(c) {
  return (
    c < 0x21 ||
    (c >= 0x7f && c <= 0xa0) ||
    c === 0xad ||
    (c >= 0x300 && c <= 0x36f) ||
    (c >= 0x2000 && c <= 0x200f) ||
    (c >= 0x2028 && c <= 0x202f) ||
    (c >= 0x205f && c <= 0x206f) ||
    (c >= 0xd800 && c <= 0xdfff) ||
    (c >= 0xfe00 && c <= 0xfe0f) ||
    c === 0xfeff ||
    (c >= 0xfff0 && c <= 0xffff) ||
    (c >= 0xe0000 && c <= 0xe01ef)
  );
}

/** Does the [[a, z], …] coverage (sorted) contain c? (binary search) */
export function covers(ranges, c) {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, z] = ranges[mid];
    if (c < a) hi = mid - 1;
    else if (c > z) lo = mid + 1;
    else return true;
  }
  return false;
}

/**
 * Groups of the character map for a coverage: [{ id, chars: [cp], total }] for every group with at least one character,
 * then 'other' (up to 512 more mapped characters outside the groups, e.g. symbol or CJK fonts).
 */
export function charGroups(ranges) {
  const seen = new Set();
  const out = [];
  for (const b of BLOCKS) {
    const chars = [];
    let total = 0;
    for (const [a, z] of b.ranges) {
      for (let c = a; c <= z; c++) {
        total++;
        seen.add(c);
        if (covers(ranges, c)) chars.push(c);
      }
    }
    if (chars.length) out.push({ id: b.id, chars, total });
  }
  const other = [];
  for (const [a, z] of ranges) {
    for (let c = a; c <= z && other.length < OTHER_MAX; c++) if (!seen.has(c) && !invisible(c)) other.push(c);
    if (other.length >= OTHER_MAX) break;
  }
  if (other.length) out.push({ id: 'other', chars: other, total: other.length });
  return out;
}

/**
 * First visible characters a symbol font maps (its own sample when it covers no language). The ASCII / Latin-1 part
 * (digits and punctuation most symbol fonts carry) is skipped when the font has enough characters beyond it.
 */
export function glyphSample(ranges, max = 24) {
  const pick = (from) => {
    const out = [];
    for (const [a, z] of ranges) {
      if (z < from) continue;
      for (let c = Math.max(a, from); c <= z && out.length < max; c++) if (!invisible(c)) out.push(String.fromCodePoint(c));
      if (out.length >= max) break;
    }
    return out;
  };
  const beyond = pick(0x100);
  return (beyond.length >= Math.min(max, 8) ? beyond : pick(0)).join(' ');
}

export const codeOf = (c) => `U+${c.toString(16).toUpperCase().padStart(4, '0')}`;

/** Search key: lower case, without accents. */
export const fold = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim();

export const extOf = (p) => (/\.[^./]+$/.exec(String(p || ''))?.[0] || '').toLowerCase();
export const baseName = (p) => String(p || '').split('/').pop();
export const dirName = (p) => String(p || '').replace(/\/[^/]*$/, '') || '/';
export const isFontPath = (p) => FONT_EXT.includes(extOf(p));
export const isInstallable = (p) => INSTALL_EXT.includes(extOf(p));

/** The style closest to Regular (same rule as the backend). */
export function regularStyle(fam) {
  let best = fam?.styles?.[0] || null;
  let score = Infinity;
  for (const s of fam?.styles || []) {
    const v = Math.abs(s.weight - 400) + (s.italic || s.oblique ? 1000 : 0) + Math.abs(s.stretch - 100) * 10;
    if (v < score) {
      score = v;
      best = s;
    }
  }
  return best;
}

/** Error code of a backend failure -> key of the reason string. */
export function reasonKey(code) {
  if (code === 'ENOTFONT' || code === 'EINVAL') return 'install.notFont';
  if (code === 'ETOOBIG') return 'install.tooBig';
  if (code === 'EUNSUPPORTED') return 'install.webFont';
  if (code === 'ENOENT') return 'install.missing';
  return null;
}
