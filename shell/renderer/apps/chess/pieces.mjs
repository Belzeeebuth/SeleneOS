// Aurora Chess — original piece set ("Aurora Staunton"), drawn for this app.
// Each piece is a set of simple shapes (pedestal, body, collar, head) filled with a vertical
// material gradient plus a horizontal shading layer for a soft turned-wood/ivory look, and a crisp
// outline. pieceSvg('wN') -> SVG markup ; pieceUrl('bQ') -> data: URL (cached).

const PALETTE = {
  w: {
    top: '#ffffff',
    mid: '#f3efe8',
    bottom: '#d6cfc3',
    stroke: '#2b2722',
    detail: '#2b2722',
    detailOpacity: 0.9,
    shadeLight: 0.75,
    shadeDark: 0.16,
  },
  b: {
    top: '#6a6a72',
    mid: '#3a3a40',
    bottom: '#18181c',
    stroke: '#0b0b0d',
    detail: '#e9e6f0',
    detailOpacity: 0.62,
    shadeLight: 0.3,
    shadeDark: 0.3,
  },
};

// Shared pedestal: a wide rounded slab and a narrower step above it.
const base = (x1, x2, y1 = 80, y2 = 91, step = 6, inset = 6) => [
  `M${x1} ${y1 + 5}C${x1} ${y1 + 2} ${x1 + 3} ${y1} ${x1 + 7} ${y1}H${x2 - 7}C${x2 - 3} ${y1} ${x2} ${y1 + 2} ${x2} ${y1 + 5}V${y2 - 3}C${x2} ${y2 - 1} ${x2 - 1.5} ${y2} ${x2 - 3.5} ${y2}H${x1 + 3.5}C${x1 + 1.5} ${y2} ${x1} ${y2 - 1} ${x1} ${y2 - 3}Z`,
  `M${x1 + inset} ${y1}C${x1 + inset} ${y1 - step + 2} ${x1 + inset + 3} ${y1 - step} ${x1 + inset + 7} ${y1 - step}H${x2 - inset - 7}C${x2 - inset - 3} ${y1 - step} ${x2 - inset} ${y1 - step + 2} ${x2 - inset} ${y1}Z`,
];
// A flat disc (collar) between body and head.
const disc = (x1, x2, y1, y2) => {
  const r = (y2 - y1) / 2;
  return `M${x1 + r} ${y1}H${x2 - r}A${r} ${r} 0 0 1 ${x2 - r} ${y2}H${x1 + r}A${r} ${r} 0 0 1 ${x1 + r} ${y1}Z`;
};

// shapes: drawn back to front. details: strokes in the detail colour (no fill).
const SHAPES = {
  p: {
    shapes: [
      'M36 75C38 67 41.5 61 43.5 55H56.5C58.5 61 62 67 64 75Z',
      ...base(25, 75, 81, 91, 6, 5),
      disc(36, 64, 49, 57),
      'M50 22.5A13.5 13.5 0 1 1 49.99 22.5Z',
    ],
    details: [],
  },
  r: {
    shapes: [
      'M33 75L35.5 45H64.5L67 75Z',
      ...base(19, 81, 81, 91, 6, 6),
      disc(30, 70, 39, 46.5),
      'M28 39.5V22C28 20.9 28.9 20 30 20H36.5C37.6 20 38.5 20.9 38.5 22V27H45V22C45 20.9 45.9 20 47 20H53C54.1 20 55 20.9 55 22V27H61.5V22C61.5 20.9 62.4 20 63.5 20H70C71.1 20 72 20.9 72 22V39.5Z',
    ],
    details: ['M36.5 57H63.5', 'M30.5 33H69.5'],
  },
  n: {
    shapes: [
      ...base(20, 80, 81, 91, 6, 6),
      'M31 75C30.5 66 35 58.5 44 52.5C40 53 35 55.5 30 57.5C25 59.5 18.5 58 17 52.5C15.8 48.5 18 45.5 20.5 42.5L33 26C36 22 40 19.5 44 18.5L47.5 8.5L54 17.5C67 20.5 77 32 78 47C78.8 58 75.5 67.5 72 75Z',
    ],
    details: ['M56 19.5C67 24.5 73 34.5 73.2 47.5C73.3 56 71.5 63 69 69', 'M18.5 53.5C21.5 54 25 53.5 28.5 51.5', 'M61 22.5C64.5 25 66.5 28 67.5 31.5'],
    dots: [
      [37.5, 31, 2.6, 2],
      [22.5, 47.5, 1.7, 1.7],
    ],
  },
  b: {
    shapes: [
      'M37.5 75C39.5 67.5 42.5 62.5 44.5 58H55.5C57.5 62.5 60.5 67.5 62.5 75Z',
      ...base(22, 78, 81, 91, 6, 6),
      disc(35, 65, 52, 59.5),
      'M50 15C42 21.5 34 31 34 41C34 49 41 54 50 54C59 54 66 49 66 41C66 31 58 21.5 50 15Z',
      'M50 6.5A4.6 4.6 0 1 1 49.99 6.5Z',
    ],
    details: ['M57.5 27L48.5 38.5', 'M39 48.5C46 51 54 51 61 48.5'],
  },
  q: {
    shapes: [
      'M35 75C37 68.5 40 63.5 42 58H58C60 63.5 63 68.5 65 75Z',
      ...base(19, 81, 81, 91, 6, 6),
      disc(33, 67, 51.5, 59),
      'M34 53L22 28L33.5 41L36 22.5L44.5 38.5L50 18.5L55.5 38.5L64 22.5L66.5 41L78 28L66 53C56 50 44 50 34 53Z',
      'M22 22A4 4 0 1 1 21.99 22Z',
      'M36 16.5A4 4 0 1 1 35.99 16.5Z',
      'M50 12A4.6 4.6 0 1 1 49.99 12Z',
      'M64 16.5A4 4 0 1 1 63.99 16.5Z',
      'M78 22A4 4 0 1 1 77.99 22Z',
    ],
    details: ['M36 47.5C45 45.5 55 45.5 64 47.5'],
  },
  k: {
    shapes: [
      'M36 75C38 68 41 63 43 58H57C59 63 62 68 64 75Z',
      ...base(19, 81, 81, 91, 6, 6),
      disc(33, 67, 51.5, 59),
      'M34.5 53C28 45.5 28.5 34.5 38 32C43 30.7 47.5 32.5 50 36C52.5 32.5 57 30.7 62 32C71.5 34.5 72 45.5 65.5 53C56 50.5 44 50.5 34.5 53Z',
      'M47 9.5C47 8.7 47.7 8 48.5 8H51.5C52.3 8 53 8.7 53 9.5V15H58.5C59.3 15 60 15.7 60 16.5V19.5C60 20.3 59.3 21 58.5 21H53V31.5H47V21H41.5C40.7 21 40 20.3 40 19.5V16.5C40 15.7 40.7 15 41.5 15H47Z',
    ],
    details: ['M50 37V49', 'M37 47.5C45.5 45.5 54.5 45.5 63 47.5'],
  },
};

function build(code) {
  const color = code[0] === 'b' ? 'b' : 'w';
  const type = code[1].toLowerCase();
  const P = PALETTE[color];
  const S = SHAPES[type];
  const sw = 2.6;
  const defs = `
    <linearGradient id="m" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${P.top}"/><stop offset=".55" stop-color="${P.mid}"/><stop offset="1" stop-color="${P.bottom}"/>
    </linearGradient>
    <linearGradient id="s" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#fff" stop-opacity="${P.shadeLight}"/>
      <stop offset=".38" stop-color="#fff" stop-opacity="0"/>
      <stop offset=".7" stop-color="#000" stop-opacity="0"/>
      <stop offset="1" stop-color="#000" stop-opacity="${P.shadeDark}"/>
    </linearGradient>
    <radialGradient id="sh" cx=".5" cy=".5" r=".5">
      <stop offset="0" stop-color="#000" stop-opacity=".32"/><stop offset="1" stop-color="#000" stop-opacity="0"/>
    </radialGradient>`;
  let body = `<ellipse cx="50" cy="91.5" rx="34" ry="5" fill="url(#sh)"/>`;
  for (const d of S.shapes) {
    body += `<path d="${d}" fill="url(#m)"/><path d="${d}" fill="url(#s)"/><path d="${d}" fill="none" stroke="${P.stroke}" stroke-width="${sw}" stroke-linejoin="round"/>`;
  }
  for (const d of S.details) body += `<path d="${d}" fill="none" stroke="${P.detail}" stroke-opacity="${P.detailOpacity}" stroke-width="2.4" stroke-linecap="round"/>`;
  for (const [cx, cy, rx, ry] of S.dots || []) body += `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${P.detail}" fill-opacity="${Math.min(1, P.detailOpacity + 0.1)}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs>${defs}</defs>${body}</svg>`;
}

const svgCache = new Map();
const urlCache = new Map();

export const PIECE_CODES = ['wK', 'wQ', 'wR', 'wB', 'wN', 'wP', 'bK', 'bQ', 'bR', 'bB', 'bN', 'bP'];

export function pieceSvg(code) {
  if (!svgCache.has(code)) svgCache.set(code, build(code));
  return svgCache.get(code);
}

export function pieceUrl(code) {
  if (!urlCache.has(code)) urlCache.set(code, `data:image/svg+xml;charset=utf-8,${encodeURIComponent(pieceSvg(code))}`);
  return urlCache.get(code);
}
