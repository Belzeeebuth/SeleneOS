// Original card artwork for Aurora Solitaire, generated as SVG strings (no DOM needed).
//   faceSvg(card)            -> SVG markup of a card face (card = 0..51, see rules.mjs)
//   backSvg(design, accent)  -> SVG markup of a card back ('aurora' uses the accent colour)
//   svgUrl(svg)              -> data: URL usable in CSS / <img> / canvas
// Card geometry: 250 x 350 units (5:7), corner radius 16.
import { suitOf, rankOf, isRed, RANK_LABELS } from './rules.mjs';

export const CARD_W = 250;
export const CARD_H = 350;
export const BACKS = ['aurora', 'crimson', 'ocean', 'midnight'];

const RED = '#cc2236';
const BLACK = '#1a2130';
const GOLD = '#e2a93b';
const GOLD_DARK = '#a9761a';
const SKIN = '#f6d5b5';
const SKIN_SHADE = '#e3b48f';
const FONT = "Inter, 'Segoe UI', 'Noto Sans', 'DejaVu Sans', Arial, sans-serif";

// Suit shapes drawn in a 100 x 100 box.
const SUIT_PATHS = [
  // spade
  'M50 4C57 17 93 37 93 61C93 75 82 83 70 83C62 83 56 79 53 74C54 83 58 91 67 96H33C42 91 46 83 47 74C44 79 38 83 30 83C18 83 7 75 7 61C7 37 43 17 50 4Z',
  // heart
  'M50 94C44 86 6 63 6 33C6 17 18 6 31 6C40 6 46 11 50 19C54 11 60 6 69 6C82 6 94 17 94 33C94 63 56 86 50 94Z',
  // diamond
  'M50 3Q63 29 86 50Q63 71 50 97Q37 71 14 50Q37 29 50 3Z',
  // club
  'M31 30a19 19 0 1 1 38 0a19 19 0 1 1-38 0ZM9 59a19 19 0 1 1 38 0a19 19 0 1 1-38 0ZM53 59a19 19 0 1 1 38 0a19 19 0 1 1-38 0ZM38 52a12 12 0 1 1 24 0a12 12 0 1 1-24 0ZM46 58H54C54 76 58 88 67 96H33C42 88 46 76 46 58Z',
];

export const suitPath = (suit) => SUIT_PATHS[suit];
const colorOf = (c) => (isRed(c) ? RED : BLACK);

function pip(suit, cx, cy, size, { flip = false, fill } = {}) {
  const s = size / 100;
  const rot = flip ? `rotate(180 ${cx} ${cy}) ` : '';
  return `<use href="#s" transform="${rot}translate(${(cx - size / 2).toFixed(2)} ${(cy - size / 2).toFixed(2)}) scale(${s.toFixed(4)})"${fill ? ` fill="${fill}"` : ''}/>`;
}

function index(c) {
  const r = rankOf(c);
  const label = RANK_LABELS[r];
  const ten = r === 10;
  const text = `<text x="27" y="58" text-anchor="middle" font-family="${FONT}" font-weight="700" font-size="${ten ? 42 : 46}"${
    ten ? ' textLength="44" lengthAdjust="spacingAndGlyphs"' : ''
  } letter-spacing="-1">${label}</text>`;
  return `<g>${text}${pip(suitOf(c), 27, 80, 27)}</g>`;
}

const L = 80;
const C = 125;
const R = 170;
const Y = [75, 141.67, 208.33, 275];
const PIP_LAYOUT = {
  2: [[C, 75], [C, 275]],
  3: [[C, 75], [C, 175], [C, 275]],
  4: [[L, 75], [R, 75], [L, 275], [R, 275]],
  5: [[L, 75], [R, 75], [C, 175], [L, 275], [R, 275]],
  6: [[L, 75], [R, 75], [L, 175], [R, 175], [L, 275], [R, 275]],
  7: [[L, 75], [R, 75], [C, 125], [L, 175], [R, 175], [L, 275], [R, 275]],
  8: [[L, 75], [R, 75], [C, 125], [L, 175], [R, 175], [C, 225], [L, 275], [R, 275]],
  9: [[L, Y[0]], [R, Y[0]], [L, Y[1]], [R, Y[1]], [C, 175], [L, Y[2]], [R, Y[2]], [L, Y[3]], [R, Y[3]]],
  10: [[L, Y[0]], [R, Y[0]], [C, 108.33], [L, Y[1]], [R, Y[1]], [L, Y[2]], [R, Y[2]], [C, 241.67], [L, Y[3]], [R, Y[3]]],
};

function pipsBody(c) {
  const r = rankOf(c);
  const suit = suitOf(c);
  if (r === 1) {
    const tint = isRed(c) ? '#fbe8eb' : '#e9edf4';
    const big = suit === 0 ? 124 : 104;
    let s = `<circle cx="125" cy="175" r="${suit === 0 ? 82 : 74}" fill="${tint}"/>`;
    if (suit === 0) s += `<circle cx="125" cy="175" r="82" fill="none" stroke="${GOLD}" stroke-width="2.5"/><circle cx="125" cy="175" r="76" fill="none" stroke="${BLACK}" stroke-opacity=".25" stroke-width="1"/>`;
    return s + pip(suit, 125, 177, big);
  }
  return PIP_LAYOUT[r].map(([x, y]) => pip(suit, x, y, 46, { flip: y > 175 })).join('');
}

// Palette for the court cards' robes (the corner indices stay red / black).
const ROBES = [
  { main: '#25335a', trim: '#4a6aa8', hair: '#6b6f7a', qhair: '#3b2a24' }, // spades
  { main: '#bf2a3d', trim: '#ea7183', hair: '#8e4a2c', qhair: '#c98a2b' }, // hearts
  { main: '#b5432b', trim: '#ee9465', hair: '#5a3a28', qhair: '#7a3f22' }, // diamonds
  { main: '#1e5a4a', trim: '#46a088', hair: '#4b3a2e', qhair: '#2f241f' }, // clubs
];

// Upper half of a court card portrait (mirrored for the lower half), drawn in card coordinates.
function courtHalf(c) {
  const r = rankOf(c);
  const suit = suitOf(c);
  const p = ROBES[suit];
  const parts = [];
  // Held item, behind the figure.
  if (r === 13) {
    // sword
    parts.push(
      `<path d="M163 175V104" stroke="#c9d1dc" stroke-width="5" stroke-linecap="round"/>`,
      `<path d="M163 104l-3-10h6z" fill="#c9d1dc"/>`,
      `<rect x="153" y="150" width="20" height="5" rx="2.5" fill="${GOLD}"/>`,
      `<circle cx="163" cy="165" r="4" fill="${GOLD}"/>`,
    );
  } else if (r === 12) {
    // flower
    parts.push(
      `<path d="M86 175C86 160 90 146 88 128" stroke="#4d8a4a" stroke-width="3.5" fill="none" stroke-linecap="round"/>`,
      `<path d="M88 150c-9-2-13-8-12-13 7 0 11 5 12 13z" fill="#5fa35a"/>`,
      `<g transform="translate(88 122)">${[0, 72, 144, 216, 288]
        .map((a) => `<ellipse rx="5.5" ry="8" cy="-7" transform="rotate(${a})" fill="${p.trim}"/>`)
        .join('')}<circle r="4.5" fill="${GOLD}"/></g>`,
    );
  } else {
    // staff with a banner tip
    parts.push(
      `<path d="M88 175V100" stroke="${GOLD_DARK}" stroke-width="4" stroke-linecap="round"/>`,
      `<path d="M88 100l-6-12h12z" fill="#c9d1dc"/>`,
      `<path d="M90 106h18l-6 7 6 7H90z" fill="${p.trim}"/>`,
    );
  }
  // Long hair for the queen sits behind the shoulders.
  if (r === 12) parts.push(`<path d="M106 92C102 112 100 128 96 140H154C150 128 148 112 144 92C142 74 108 74 106 92Z" fill="${p.qhair}"/>`);
  // Robe and shoulders.
  parts.push(
    `<path d="M64 175V161C64 139 86 126 104 123H146C164 126 186 139 186 161V175Z" fill="${p.main}"/>`,
    `<path d="M64 175V161C64 150 70 141 79 135L92 175Z" fill="#000" fill-opacity=".12"/>`,
    `<path d="M186 175V161C186 150 180 141 171 135L158 175Z" fill="#fff" fill-opacity=".08"/>`,
  );
  if (r === 13) {
    // ermine collar
    parts.push(
      `<path d="M92 128C104 138 146 138 158 128L162 140C146 150 104 150 88 140Z" fill="#f7f4ee"/>`,
      `<g fill="${BLACK}">${[100, 113, 125, 137, 150].map((x, i) => `<rect x="${x - 1.2}" y="${136 + (i % 2) * 3}" width="2.4" height="5" rx="1"/>`).join('')}</g>`,
    );
  } else if (r === 12) {
    parts.push(`<path d="M104 123L125 146L146 123L139 123L125 138L111 123Z" fill="${GOLD}"/>`, `<circle cx="125" cy="146" r="4" fill="${p.trim}" stroke="${GOLD}" stroke-width="1.5"/>`);
  } else {
    parts.push(`<path d="M104 123H146L140 133H110Z" fill="${p.trim}"/>`, `<path d="M110 133H140" stroke="${GOLD}" stroke-width="2"/>`);
  }
  // Chest emblem.
  parts.push(`<g>${pip(suit, 125, 162, 20, { fill: '#fff' })}</g>`);
  // Neck and head.
  parts.push(
    `<rect x="117" y="108" width="16" height="17" rx="4" fill="${SKIN_SHADE}"/>`,
    `<ellipse cx="125" cy="95" rx="17" ry="19.5" fill="${SKIN}"/>`,
    `<circle cx="119" cy="95" r="1.9" fill="#2a2a33"/><circle cx="131" cy="95" r="1.9" fill="#2a2a33"/>`,
    `<path d="M121 104.5q4 2.6 8 0" stroke="#b5675a" stroke-width="1.6" fill="none" stroke-linecap="round"/>`,
    `<circle cx="115.5" cy="101" r="2.6" fill="#f29c8f" fill-opacity=".45"/><circle cx="134.5" cy="101" r="2.6" fill="#f29c8f" fill-opacity=".45"/>`,
  );
  if (r === 13) {
    parts.push(
      `<path d="M107 96C107 112 114 124 125 126C136 124 143 112 143 96C140 104 134 108 125 108C116 108 110 104 107 96Z" fill="${p.hair}"/>`,
      `<path d="M118 107.5q7 -3 14 0" stroke="${SKIN}" stroke-width="2" fill="none" stroke-linecap="round"/>`,
      `<path d="M108 88C108 78 116 74 125 74C134 74 142 78 142 88C138 82 130 80 125 80C120 80 112 82 108 88Z" fill="${p.hair}"/>`,
      // crown
      `<path d="M104 79V56L114 67L125 51L136 67L146 56V79Z" fill="${GOLD}" stroke="${GOLD_DARK}" stroke-width="1.2" stroke-linejoin="round"/>`,
      `<rect x="103" y="75" width="44" height="7" rx="2" fill="${GOLD_DARK}"/>`,
      `<circle cx="125" cy="66" r="3.4" fill="${p.trim}"/><circle cx="114" cy="72" r="2.2" fill="#fff"/><circle cx="136" cy="72" r="2.2" fill="#fff"/>`,
    );
  } else if (r === 12) {
    parts.push(
      `<path d="M107 92C107 79 115 74 125 74C135 74 143 79 143 92C137 84 131 82 125 82C119 82 113 84 107 92Z" fill="${p.qhair}"/>`,
      // tiara
      `<path d="M107 81C109 70 116 64 125 62C134 64 141 70 143 81C136 77 131 76 125 76C119 76 114 77 107 81Z" fill="${GOLD}" stroke="${GOLD_DARK}" stroke-width="1.2"/>`,
      `<circle cx="125" cy="60" r="4" fill="${p.trim}" stroke="${GOLD}" stroke-width="1.5"/><circle cx="111" cy="70" r="2.6" fill="${GOLD}"/><circle cx="139" cy="70" r="2.6" fill="${GOLD}"/>`,
    );
  } else {
    parts.push(
      `<path d="M108 94C106 84 112 77 125 77C138 77 144 84 142 94C139 88 132 86 125 86C118 86 111 88 108 94Z" fill="${p.hair}"/>`,
      // cap and feather
      `<path d="M150 70C160 56 172 50 182 49C178 58 168 68 154 75Z" fill="#fff" stroke="${p.trim}" stroke-width="1.5"/>`,
      `<path d="M104 84C101 70 113 61 128 61C143 61 152 69 148 84C138 79 116 79 104 84Z" fill="${p.main}"/>`,
      `<path d="M104 84C116 79 138 79 148 84L147 88C136 84 116 84 105 88Z" fill="${GOLD}"/>`,
    );
  }
  return parts.join('');
}

function courtBody(c) {
  const suit = suitOf(c);
  const tint = isRed(c) ? '#fdf1f2' : '#f0f3f8';
  const col = colorOf(c);
  const half = `<g transform="translate(125 175) scale(1.08) translate(-125 -175)">${courtHalf(c)}</g>`;
  return (
    `<clipPath id="fr"><rect x="52" y="34" width="146" height="282" rx="10"/></clipPath>` +
    `<rect x="52" y="34" width="146" height="282" rx="10" fill="${tint}"/>` +
    `<g clip-path="url(#fr)"><g>${half}</g><g transform="rotate(180 125 175)">${half}</g></g>` +
    `<path d="M52 175H198" stroke="${col}" stroke-opacity=".35" stroke-width="1.5"/>` +
    `<rect x="52" y="34" width="146" height="282" rx="10" fill="none" stroke="${col}" stroke-width="2.2"/>` +
    `<rect x="57" y="39" width="136" height="272" rx="7" fill="none" stroke="${GOLD}" stroke-opacity=".7" stroke-width="1.2"/>` +
    `<g>${pip(suit, 70, 52, 16)}${pip(suit, 180, 298, 16, { flip: true })}</g>`
  );
}

/** SVG markup for a card face. */
export function faceSvg(c) {
  const suit = suitOf(c);
  const r = rankOf(c);
  const col = colorOf(c);
  const body = r >= 11 ? courtBody(c) : pipsBody(c);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CARD_W} ${CARD_H}" width="${CARD_W}" height="${CARD_H}">` +
    `<defs><path id="s" d="${SUIT_PATHS[suit]}"/>` +
    `<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#f4f5f8"/></linearGradient></defs>` +
    `<rect x="0.5" y="0.5" width="249" height="349" rx="16" fill="url(#bg)" stroke="#c9ced8" stroke-width="1"/>` +
    `<g fill="${col}">${body}${index(c)}<g transform="rotate(180 125 175)">${index(c)}</g></g>` +
    `</svg>`
  );
}

// ---------------------------------------------------------------- backs
function clampHex(hex) {
  return /^#[0-9a-f]{6}$/i.test(hex || '') ? hex : '#c9d3e6';
}
function mix(hex, other, t) {
  const a = parseInt(clampHex(hex).slice(1), 16);
  const b = parseInt(clampHex(other).slice(1), 16);
  const ch = (n, s) => (n >> s) & 255;
  const m = (s) => Math.round(ch(a, s) + (ch(b, s) - ch(a, s)) * t);
  return `#${((1 << 24) | (m(16) << 16) | (m(8) << 8) | m(0)).toString(16).slice(1)}`;
}

function backFrame(inner, { frame = '#ffffff', line = 'rgba(255,255,255,.55)' } = {}) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CARD_W} ${CARD_H}" width="${CARD_W}" height="${CARD_H}">` +
    `<rect x="0.5" y="0.5" width="249" height="349" rx="16" fill="${frame}" stroke="#c9ced8"/>` +
    `<clipPath id="in"><rect x="12" y="12" width="226" height="326" rx="9"/></clipPath>` +
    `<g clip-path="url(#in)">${inner}</g>` +
    `<rect x="19" y="19" width="212" height="312" rx="6" fill="none" stroke="${line}" stroke-width="1.5"/>` +
    `</svg>`
  );
}

function auroraBack(accent) {
  // Selene: a night sky tinted with the accent, a few stars and the crescent-and-dot logo.
  const a = clampHex(accent);
  const top = mix(a, '#16203a', 0.72);
  const bottom = mix(a, '#0a0f1c', 0.86);
  const moon = mix(a, '#f4f6fb', 0.7);
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  let stars = '';
  for (let i = 0; i < 34; i++) {
    const x = 16 + rnd() * 218;
    const y = 16 + rnd() * 318;
    if (Math.abs(x - 125) < 60 && Math.abs(y - 175) < 60) continue;
    stars += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(0.6 + rnd() * 1.1).toFixed(2)}" fill="#fff" fill-opacity="${(0.25 + rnd() * 0.45).toFixed(2)}"/>`;
  }
  return backFrame(
    `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient>` +
      `<radialGradient id="glow" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="${moon}" stop-opacity=".22"/><stop offset="1" stop-color="${moon}" stop-opacity="0"/></radialGradient></defs>` +
      `<rect width="250" height="350" fill="url(#g)"/>${stars}<circle cx="125" cy="175" r="78" fill="url(#glow)"/>` +
      `<circle cx="125" cy="175" r="64" fill="none" stroke="${a}" stroke-opacity=".45" stroke-width="1.5"/>` +
      `<g transform="translate(125 175) scale(2.3) translate(-24 -24)"><path d="M15.04 10.58A17 17 0 1 0 36.92 32.46A15.6 15.6 0 0 1 15.04 10.58Z" fill="${moon}"/>` +
      `<circle cx="37.2" cy="10.6" r="2.7" fill="${moon}"/></g>`,
    { line: `${moon}55` },
  );
}

function crimsonBack() {
  return backFrame(
    `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#c22a40"/><stop offset="1" stop-color="#8f1428"/></linearGradient>` +
      `<pattern id="l" width="22" height="22" patternUnits="userSpaceOnUse"><path d="M0 0L22 22M22 0L0 22" stroke="#ff8fa0" stroke-opacity=".38" stroke-width="1.6"/><circle cx="11" cy="11" r="2.2" fill="#ffd1d8" fill-opacity=".55"/><circle cx="0" cy="0" r="1.6" fill="#ffd1d8" fill-opacity=".4"/><circle cx="22" cy="0" r="1.6" fill="#ffd1d8" fill-opacity=".4"/><circle cx="0" cy="22" r="1.6" fill="#ffd1d8" fill-opacity=".4"/><circle cx="22" cy="22" r="1.6" fill="#ffd1d8" fill-opacity=".4"/></pattern></defs>` +
      `<rect width="250" height="350" fill="url(#g)"/><rect width="250" height="350" fill="url(#l)"/>` +
      `<g transform="translate(125 175)"><path d="M0 -62L44 0L0 62L-44 0Z" fill="#8f1428" stroke="#ffd1d8" stroke-opacity=".8" stroke-width="2.5"/>` +
      `<path d="M0 -46L32 0L0 46L-32 0Z" fill="none" stroke="#ffd1d8" stroke-opacity=".5" stroke-width="1.5"/>` +
      `${[0, 90, 180, 270].map((a) => `<ellipse rx="7" ry="15" cy="-14" transform="rotate(${a})" fill="#ffd1d8" fill-opacity=".85"/>`).join('')}<circle r="6" fill="${GOLD}"/></g>`,
  );
}

function oceanBack() {
  return backFrame(
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2a78d8"/><stop offset="1" stop-color="#0f3a85"/></linearGradient>` +
      `<pattern id="w" width="40" height="20" patternUnits="userSpaceOnUse">` +
      `<g fill="none" stroke="#bfe0ff" stroke-opacity=".33" stroke-width="1.5"><circle cx="20" cy="20" r="18"/><circle cx="20" cy="20" r="12"/><circle cx="20" cy="20" r="6"/><circle cx="0" cy="10" r="18"/><circle cx="0" cy="10" r="12"/><circle cx="40" cy="10" r="18"/><circle cx="40" cy="10" r="12"/></g></pattern></defs>` +
      `<rect width="250" height="350" fill="url(#g)"/><rect width="250" height="350" fill="url(#w)"/>` +
      `<g transform="translate(125 175)"><circle r="44" fill="#123f8f" stroke="#e4f2ff" stroke-opacity=".8" stroke-width="2.5"/>` +
      `<path d="M-30 6C-20 -6 -10 -6 0 6S20 18 30 6" fill="none" stroke="#e4f2ff" stroke-width="5" stroke-linecap="round"/>` +
      `<path d="M-30 -10C-20 -22 -10 -22 0 -10S20 2 30 -10" fill="none" stroke="#e4f2ff" stroke-opacity=".55" stroke-width="4" stroke-linecap="round"/>` +
      `<path d="M-24 22C-16 14 -8 14 0 22S16 30 24 22" fill="none" stroke="#e4f2ff" stroke-opacity=".55" stroke-width="4" stroke-linecap="round"/></g>`,
  );
}

function midnightBack() {
  // Deterministic star field.
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  let stars = '';
  for (let i = 0; i < 70; i++) {
    const x = 12 + rnd() * 226;
    const y = 12 + rnd() * 326;
    const r = 0.6 + rnd() * 1.6;
    stars += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(2)}" fill="#fff" fill-opacity="${(0.35 + rnd() * 0.6).toFixed(2)}"/>`;
  }
  const sparkle = (x, y, s) => `<path transform="translate(${x} ${y}) scale(${s})" d="M0 -10L2.2 -2.2L10 0L2.2 2.2L0 10L-2.2 2.2L-10 0L-2.2 -2.2Z" fill="#ffe6a8"/>`;
  return backFrame(
    `<defs><radialGradient id="g" cx=".5" cy=".4" r=".75"><stop offset="0" stop-color="#34407a"/><stop offset="1" stop-color="#121733"/></radialGradient></defs>` +
      `<rect width="250" height="350" fill="url(#g)"/>${stars}` +
      sparkle(60, 70, 1) +
      sparkle(196, 112, 0.7) +
      sparkle(74, 270, 0.8) +
      sparkle(188, 290, 1.1) +
      `<g transform="translate(125 175)"><circle r="46" fill="none" stroke="${GOLD}" stroke-opacity=".7" stroke-width="2"/>` +
      `<path d="M10 -32A34 34 0 1 0 10 32A26 26 0 1 1 10 -32Z" fill="${GOLD}"/></g>`,
    { line: 'rgba(226,169,59,.6)' },
  );
}

export function backSvg(design, accent) {
  if (design === 'crimson') return crimsonBack();
  if (design === 'ocean') return oceanBack();
  if (design === 'midnight') return midnightBack();
  return auroraBack(accent);
}

export function svgUrl(svg) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
