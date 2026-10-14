// « Clavier visuel » — key layouts and dead keys of the on-screen keyboard (pure data + logic: no DOM, importable
// from Node tests). Used by osk/keyboard.js (the panel), core/features/osk.js (desktop) and core/greeter/greeter.js.
//
//   LAYOUTS: { [id]: { id, name: { en, fr }, xkb: ['fr', …], noAltGr, r0, r1, r1x, r2, r3 } }
//     r0 = the 13 keys right of Esc (²/` and the digit row), r1 = 12 letter keys + r1x (the wide key at the end of
//     the second row), r2 = 11 keys (home row), r3 = the bottom letter row (11 keys on ISO keyboards: the < > key
//     first; 10 on QWERTY US). Each key is [level 1, level 2 (Shift), level 3 (AltGr), level 4 (AltGr + Shift)]:
//     a character, a dead key 'dead_<name>' (see DEAD) or null. The levels follow X11's xkeyboard-config symbols
//     (fr, fr(oss), us, ch(fr)), so the X11 path finds most characters on the server's own keymap.
//     One deliberate addition: AltGr+O gives œ / Œ on the basic French AZERTY (as in fr(oss) and the Swiss layout).
//   PAGES: the symbol pages ('sym': numbers and symbols, 'acc': French accented letters and typography), same shape.
//   layoutFor(xkbId)  'fr' | 'fr(oss)' | 'ch(fr)' | 'ch:fr' | 'us' | 'us(intl)' … -> a LAYOUTS id ('us' when unknown)
//   levelOf({ shift, caps, altgr }, key) -> 0..3        output(key, state) -> character | 'dead_x' | null
//   compose(dead, ch) -> the composed character, or null when the pair does not compose
//   deadSpacing(dead) -> the character a dead key gives on its own (dead key then Space, or pressed twice)
//   isLetter(ch)

// Dead keys: the combining mark they add and the spacing character they give on their own.
export const DEAD = {
  circumflex: { mark: '̂', spacing: '^' },
  diaeresis: { mark: '̈', spacing: '¨' },
  grave: { mark: '̀', spacing: '`' },
  acute: { mark: '́', spacing: '´' },
  tilde: { mark: '̃', spacing: '~' },
  cedilla: { mark: '̧', spacing: '¸' },
  abovering: { mark: '̊', spacing: '°' },
  caron: { mark: '̌', spacing: 'ˇ' },
  macron: { mark: '̄', spacing: '¯' },
  breve: { mark: '̆', spacing: '˘' },
  ogonek: { mark: '̨', spacing: '˛' },
  doubleacute: { mark: '̋', spacing: '˝' },
};

export const isDead = (v) => typeof v === 'string' && v.startsWith('dead_') && !!DEAD[v.slice(5)];
export const deadName = (v) => (isDead(v) ? v.slice(5) : null);
export function deadSpacing(dead) {
  return DEAD[deadName(dead) || dead]?.spacing || '';
}
/** Letter (cased or not): Caps Lock acts on these. */
export function isLetter(ch) {
  return typeof ch === 'string' && [...ch].length === 1 && /\p{L}/u.test(ch);
}
/** Dead key + character -> one precomposed character (NFC), or null (the pair does not exist). */
export function compose(dead, ch) {
  const d = DEAD[deadName(dead) || dead];
  if (!d || typeof ch !== 'string' || [...ch].length !== 1) return null;
  if (ch === ' ') return d.spacing;
  const out = (ch + d.mark).normalize('NFC');
  return [...out].length === 1 ? out : null;
}

// ------------------------------------------------------------------ layouts
const k = (...levels) => levels;

const FR = {
  id: 'fr',
  name: { en: 'French (AZERTY)', fr: 'Français (AZERTY)' },
  xkb: ['fr', 'fr(latin9)', 'fr(nodeadkeys)', 'fr(azerty)', 'be', 'be(oss)'],
  r0: [k('²', '~', '¬'), k('&', '1', '¹', '¡'), k('é', '2', '~', '⅛'), k('"', '3', '#', '£'), k("'", '4', '{', '$'), k('(', '5', '[', '⅜'), k('-', '6', '|', '⅝'), k('è', '7', '`', '⅞'), k('_', '8', '\\', '™'), k('ç', '9', '^', '±'), k('à', '0', '@', '°'), k(')', '°', ']', '¿'), k('=', '+', '}')],
  r1: [k('a', 'A', 'æ', 'Æ'), k('z', 'Z', '«', '<'), k('e', 'E', '€', '¢'), k('r', 'R', '¶', '®'), k('t', 'T', 'ŧ', 'Ŧ'), k('y', 'Y', '←', '¥'), k('u', 'U', '↓', '↑'), k('i', 'I', '→', 'ı'), k('o', 'O', 'œ', 'Œ'), k('p', 'P', 'þ', 'Þ'), k('dead_circumflex', 'dead_diaeresis', 'dead_diaeresis', 'dead_abovering'), k('$', '£', '¤')],
  r1x: k('*', 'µ', 'dead_grave', 'dead_breve'),
  r2: [k('q', 'Q', '@', 'Ω'), k('s', 'S', 'ß', 'ẞ'), k('d', 'D', 'ð', 'Ð'), k('f', 'F', 'đ', 'ª'), k('g', 'G', 'ŋ', 'Ŋ'), k('h', 'H', 'ħ', 'Ħ'), k('j', 'J'), k('k', 'K', 'ĸ', '&'), k('l', 'L', 'ł', 'Ł'), k('m', 'M', 'µ', 'º'), k('ù', '%', 'dead_circumflex', 'dead_caron')],
  r3: [k('<', '>', '|', '¦'), k('w', 'W', 'ł', 'Ł'), k('x', 'X', '»', '>'), k('c', 'C', '¢', '©'), k('v', 'V', '„', '‚'), k('b', 'B', '“', '‘'), k('n', 'N', '”', '’'), k(',', '?', 'dead_acute', 'dead_doubleacute'), k(';', '.', '•', '×'), k(':', '/', '·', '÷'), k('!', '§')],
};

const FR_OSS = {
  id: 'fr-oss',
  name: { en: 'French (alternative)', fr: 'Français (variante)' },
  xkb: ['fr(oss)', 'fr(oss_latin9)', 'fr(oss_nodeadkeys)'],
  r0: [k('²', '³', '¹', 'dead_cedilla'), k('&', '1', 'dead_caron', 'dead_ogonek'), k('é', '2', '~', 'É'), k('"', '3', '#', 'dead_breve'), k("'", '4', '{', '—'), k('(', '5', '[', '–'), k('-', '6', '|', '‑'), k('è', '7', '`', 'È'), k('_', '8', '\\', '™'), k('ç', '9', '^', 'Ç'), k('à', '0', '@', 'À'), k(')', '°', ']', '≠'), k('=', '+', '}', '±')],
  r1: [k('a', 'A', 'æ', 'Æ'), k('z', 'Z', 'â', 'Â'), k('e', 'E', '€', '¢'), k('r', 'R', 'ê', 'Ê'), k('t', 'T', 'þ', 'Þ'), k('y', 'Y', 'ÿ', 'Ÿ'), k('u', 'U', 'û', 'Û'), k('i', 'I', 'î', 'Î'), k('o', 'O', 'œ', 'Œ'), k('p', 'P', 'ô', 'Ô'), k('dead_circumflex', 'dead_diaeresis', 'dead_tilde', 'dead_abovering'), k('$', '£', 'ø', 'Ø')],
  r1x: k('*', 'µ', 'dead_grave', 'dead_macron'),
  r2: [k('q', 'Q', 'ä', 'Ä'), k('s', 'S', 'ß', '„'), k('d', 'D', 'ë', 'Ë'), k('f', 'F', '‘', '‚'), k('g', 'G', '’', '¥'), k('h', 'H', 'ð', 'Ð'), k('j', 'J', 'ü', 'Ü'), k('k', 'K', 'ï', 'Ï'), k('l', 'L', 'ŀ', 'Ŀ'), k('m', 'M', 'ö', 'Ö'), k('ù', '%', 'dead_acute', 'Ù')],
  r3: [k('<', '>', '≤', '≥'), k('w', 'W', '«', '“'), k('x', 'X', '»', '”'), k('c', 'C', '©', '®'), k('v', 'V', ' ', '←'), k('b', 'B', '↓', '↑'), k('n', 'N', '¬', '→'), k(',', '?', '¿', '…'), k(';', '.', '×', '⋅'), k(':', '/', '÷', '∕'), k('!', '§', '¡', '−')],
};

const US = {
  id: 'us',
  name: { en: 'English (US, QWERTY)', fr: 'Anglais (États-Unis, QWERTY)' },
  xkb: ['us', 'us(intl)', 'us(altgr-intl)', 'gb', 'ca(eng)'],
  noAltGr: true,
  r0: [k('`', '~'), k('1', '!'), k('2', '@'), k('3', '#'), k('4', '$'), k('5', '%'), k('6', '^'), k('7', '&'), k('8', '*'), k('9', '('), k('0', ')'), k('-', '_'), k('=', '+')],
  r1: [k('q', 'Q'), k('w', 'W'), k('e', 'E'), k('r', 'R'), k('t', 'T'), k('y', 'Y'), k('u', 'U'), k('i', 'I'), k('o', 'O'), k('p', 'P'), k('[', '{'), k(']', '}')],
  r1x: k('\\', '|'),
  r2: [k('a', 'A'), k('s', 'S'), k('d', 'D'), k('f', 'F'), k('g', 'G'), k('h', 'H'), k('j', 'J'), k('k', 'K'), k('l', 'L'), k(';', ':'), k("'", '"')],
  r3: [k('z', 'Z'), k('x', 'X'), k('c', 'C'), k('v', 'V'), k('b', 'B'), k('n', 'N'), k('m', 'M'), k(',', '<'), k('.', '>'), k('/', '?')],
};

const CH_FR = {
  id: 'ch-fr',
  name: { en: 'French (Switzerland, QWERTZ)', fr: 'Français (Suisse, QWERTZ)' },
  xkb: ['ch(fr)', 'ch:fr', 'ch(fr_nodeadkeys)', 'ch(fr_mac)', 'ch', 'ch(de_nodeadkeys)'],
  r0: [k('§', '°'), k('1', '+', '|', '¡'), k('2', '"', '@'), k('3', '*', '#'), k('4', 'ç'), k('5', '%'), k('6', '&', '¬'), k('7', '/', '|'), k('8', '(', '¢'), k('9', ')'), k('0', '='), k("'", '?', 'dead_acute'), k('dead_circumflex', 'dead_grave', 'dead_tilde')],
  r1: [k('q', 'Q', '@', 'Ω'), k('w', 'W'), k('e', 'E', '€'), k('r', 'R', '¶', '®'), k('t', 'T', 'ŧ', 'Ŧ'), k('z', 'Z'), k('u', 'U', '↓', '↑'), k('i', 'I', '→', 'ı'), k('o', 'O', 'œ', 'Œ'), k('p', 'P', 'þ', 'Þ'), k('è', 'ü', '['), k('dead_diaeresis', '!', ']')],
  r1x: k('$', '£', '}'),
  r2: [k('a', 'A', 'æ', 'Æ'), k('s', 'S', 'ß', 'ẞ'), k('d', 'D', 'ð', 'Ð'), k('f', 'F', 'đ', 'ª'), k('g', 'G', 'ŋ', 'Ŋ'), k('h', 'H', 'ħ', 'Ħ'), k('j', 'J'), k('k', 'K', 'ĸ', '&'), k('l', 'L', 'ł', 'Ł'), k('é', 'ö'), k('à', 'ä', '{')],
  r3: [k('<', '>', '\\', '¦'), k('y', 'Y'), k('x', 'X', '»', '>'), k('c', 'C', '¢', '©'), k('v', 'V', '„', '‚'), k('b', 'B', '“', '‘'), k('n', 'N', '”', '’'), k('m', 'M', 'µ', 'º'), k(',', ';'), k('.', ':'), k('-', '_')],
};

export const LAYOUTS = { fr: FR, 'fr-oss': FR_OSS, us: US, 'ch-fr': CH_FR };
export const LAYOUT_IDS = Object.keys(LAYOUTS);

// Symbol pages: the same rows, without levels (Shift does nothing there).
const p = (s) => [...s].map((c) => k(c));
export const PAGES = {
  sym: { r0: p('1234567890-+='), r1: p('@#€$£%&*()_/'), r1x: k('\\'), r2: p('"\':;!?[]{}|'), r3: p('<>~^`«»°§µ²') },
  acc: { r0: p('àâäæçéèêëîïôö'), r1: p('œùûüÿñß¡¿…–—'), r1x: k('·'), r2: p('ÀÂÇÉÈÊËÎÔÙÛ'), r3: p('ŒÆ“”‘’„×÷±≠') },
};

/** The layout id for an XKB layout ('fr', 'fr(oss)', 'ch(fr)', the greeter's 'ch:fr'…); 'us' when unknown. */
export function layoutFor(xkb) {
  const v = String(xkb || '')
    .trim()
    .toLowerCase();
  if (LAYOUTS[v]) return v;
  for (const L of Object.values(LAYOUTS)) if (L.xkb.includes(v)) return L.id;
  const base = v.split(/[(:+]/)[0];
  for (const L of Object.values(LAYOUTS)) if (L.xkb.includes(base)) return L.id;
  return 'us';
}

/** Level (0 plain, 1 Shift, 2 AltGr, 3 AltGr + Shift) of a key for a modifier state; Caps Lock inverts Shift on letters. */
export function levelOf(state, key) {
  let shift = !!state.shift;
  const altgr = !!state.altgr;
  if (state.caps && isLetter(key?.[altgr ? 2 : 0] ?? key?.[0])) shift = !shift;
  return (altgr ? 2 : 0) + (shift ? 1 : 0);
}

/**
 * What a key gives in a state: a character, a dead key ('dead_x') or null. Caps Lock on a key whose plain level is a
 * lowercase letter with no Shift twin that is its capital (é on AZERTY, Shift gives 2) gives the capital (É), as
 * fr(oss) does. AltGr levels fall back to nothing (never to the plain character).
 */
export function output(key, state) {
  if (!Array.isArray(key)) return null;
  const lvl = levelOf(state, key);
  let v = key[lvl] ?? null;
  // one-level keys (symbol pages): Shift gives the capital of a letter, else the same character
  if (v == null && lvl === 1 && typeof key[0] === 'string' && !isDead(key[0])) {
    const up = key[0].toLocaleUpperCase();
    v = [...up].length === 1 ? up : key[0];
  }
  if (state.caps && !state.altgr && isLetter(key[0]) && key[1] !== key[0].toLocaleUpperCase()) {
    const up = key[0].toLocaleUpperCase();
    if ([...up].length === 1) v = state.shift ? key[1] ?? key[0] : up;
  }
  return v;
}
