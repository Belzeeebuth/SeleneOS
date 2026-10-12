// Profile icons (16px artwork) as inline SVG strings.
//   profileIconSvg(kind, look?)  -> SVG markup ('shell' | 'python' | 'root'; look = a core/app-icon-art.js lookKey)
//   profileIcon(h, kind, size)   -> <span class="tm-picon" data-picon="kind"> holding it
//
// The colours follow the look of the Selene app icons (core/app-icon-art.js: the ambiance, the mode, Contraste élevé):
// the cold look (Nocturne) keeps the original artwork; neutral (Éclipse) and warm (Clair de lune) draw the same shapes
// from their own palette (base and hue slots), so no blue shows outside the cold ambiance. A change of
// <html data-ambiance / data-theme / data-style> (theme.js, inside its cross-fade) redraws every profile icon on
// screen at once, like core/packs.js does for the app icons.
import { lookKey, iconLook, mix } from '../../../core/app-icon-art.js';

let seq = 0;

function svg(body, defs) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" aria-hidden="true"><defs>${defs}</defs>${body}</svg>`;
}
const grad = (id, [x1, y1, x2, y2], stops) =>
  `<linearGradient id="${id}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" gradientUnits="userSpaceOnUse">${stops.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join('')}</linearGradient>`;

// The cold look: the original artwork, unchanged.
const COLD = {
  shell: (u) =>
    svg(
      `<rect x="1" y="1.5" width="14" height="13" rx="3" fill="url(#${u}a)"/>
       <rect x="1" y="1.5" width="14" height="3" rx="1.5" fill="url(#${u}b)" opacity=".95"/>
       <rect x="1" y="3" width="14" height="1.5" fill="url(#${u}b)" opacity=".95"/>
       <path d="M4.2 7.2l2.3 1.9-2.3 1.9" fill="none" stroke="#fff" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/>
       <path d="M8 11.1h3.6" stroke="#7fe3d4" stroke-width="1.35" stroke-linecap="round"/>`,
      `<linearGradient id="${u}a" x1="2" y1="2" x2="14" y2="15" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#3a4254"/><stop offset="1" stop-color="#151922"/></linearGradient>
       <linearGradient id="${u}b" x1="1" y1="2" x2="15" y2="4" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#2ec6c0"/><stop offset="1" stop-color="#3b82f6"/></linearGradient>`,
    ),
  python: (u) =>
    svg(
      `<rect x="1" y="1.5" width="14" height="13" rx="3" fill="url(#${u}a)"/>
       <path d="M3.6 5.6l2 2.4-2 2.4M6.9 5.6l2 2.4-2 2.4M10.2 5.6l2 2.4-2 2.4" fill="none" stroke="#fff" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>`,
      `<linearGradient id="${u}a" x1="2" y1="2" x2="14" y2="15" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#2f6fb8"/><stop offset=".62" stop-color="#3f86cf"/><stop offset="1" stop-color="#e6b422"/></linearGradient>`,
    ),
  root: (u) =>
    svg(
      `<path d="M8 1.2l5.6 2.1v4.2c0 3.4-2.3 5.9-5.6 7.3-3.3-1.4-5.6-3.9-5.6-7.3V3.3z" fill="url(#${u}a)"/>
       <path d="M5.3 6.3l2 1.7-2 1.7" fill="none" stroke="#fff" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
       <path d="M8.4 10.4h2.4" stroke="#ffe1c2" stroke-width="1.3" stroke-linecap="round"/>`,
      `<linearGradient id="${u}a" x1="3" y1="1" x2="13" y2="15" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#f0743e"/><stop offset="1" stop-color="#c42b1c"/></linearGradient>`,
    ),
};

const SHIELD = 'M8 1.2l5.6 2.1v4.2c0 3.4-2.3 5.9-5.6 7.3-3.3-1.4-5.6-3.9-5.6-7.3V3.3z';
const CHEVRONS = 'M3.6 5.6l2 2.4-2 2.4M6.9 5.6l2 2.4-2 2.4M10.2 5.6l2 2.4-2 2.4';

// Neutral and warm: the same shapes, coloured from the look (base = the app-icon tile, hues = its symbol slots).
//   shell:  the app-icon tile, a teal -> "blue" slot title band (moss -> bone, eucalyptus -> lavender), a light prompt
//   python: a "blue" slot -> amber tile (bone -> amber, lavender -> honey) with chevrons in the tile's dark base; in
//           the light looks (pale tab strip and menus) the gradient ends on a deeper amber and the tile gets a hairline
//           edge in the dark base, so it keeps its outline
//   root:   a terra shield (copper, peach) with the prompt in the dark base
function paletteArt(kind, u, look, light = false) {
  const [top, bottom] = look.base;
  const hue = look.hues;
  const ink = bottom; // dark symbols on the light hues (>= 4.5:1, like the app icons' symbols on their base)
  if (kind === 'python') {
    const edge = light ? `<rect x="1.4" y="1.9" width="13.2" height="12.2" rx="2.6" fill="none" stroke="${bottom}" stroke-opacity=".45" stroke-width=".8"/>` : '';
    const stops = light
      ? [[0, mix(hue.blue, bottom, 0.08)], [0.55, mix(hue.blue, hue.amber, 0.5)], [1, mix(hue.amber, bottom, 0.3)]]
      : [[0, mix(hue.blue, '#ffffff', 0.12)], [0.62, hue.blue], [1, hue.amber]];
    return svg(
      `<rect x="1" y="1.5" width="14" height="13" rx="3" fill="url(#${u}a)"/>${edge}
       <path d="${CHEVRONS}" fill="none" stroke="${ink}" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>`,
      grad(`${u}a`, [2, 2, 14, 15], stops),
    );
  }
  if (kind === 'root') {
    return svg(
      `<path d="${SHIELD}" fill="url(#${u}a)"/>
       <path d="M5.3 6.3l2 1.7-2 1.7" fill="none" stroke="${ink}" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
       <path d="M8.4 10.4h2.4" stroke="${ink}" stroke-width="1.3" stroke-linecap="round"/>`,
      grad(`${u}a`, [3, 1, 13, 15], [[0, mix(hue.terra, '#ffffff', 0.18)], [1, mix(hue.terra, bottom, 0.18)]]),
    );
  }
  return svg(
    `<rect x="1" y="1.5" width="14" height="13" rx="3" fill="url(#${u}a)"/>
     <rect x="1" y="1.5" width="14" height="3" rx="1.5" fill="url(#${u}b)" opacity=".95"/>
     <rect x="1" y="3" width="14" height="1.5" fill="url(#${u}b)" opacity=".95"/>
     <path d="M4.2 7.2l2.3 1.9-2.3 1.9" fill="none" stroke="${mix(hue.silver, '#ffffff', 0.32)}" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/>
     <path d="M8 11.1h3.6" stroke="${mix(hue.teal, '#ffffff', 0.2)}" stroke-width="1.35" stroke-linecap="round"/>`,
    grad(`${u}a`, [2, 2, 14, 15], [[0, mix(top, '#ffffff', 0.1)], [1, bottom]]) + grad(`${u}b`, [1, 2, 15, 4], [[0, hue.teal], [1, hue.blue]]),
  );
}

// Contraste élevé: flat, the style's own colours (a tile in the base colour with an ink edge, ink symbols).
function contrastArt(kind, look) {
  const [base] = look.base;
  const ink = look.edge;
  if (kind === 'root') {
    return svg(
      `<path d="${SHIELD}" fill="${base}" stroke="${ink}" stroke-width="1.2" stroke-linejoin="round"/>
       <path d="M5.3 6.3l2 1.7-2 1.7" fill="none" stroke="${ink}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
       <path d="M8.4 10.4h2.4" stroke="${ink}" stroke-width="1.4" stroke-linecap="round"/>`,
      '',
    );
  }
  const sym =
    kind === 'python'
      ? `<path d="${CHEVRONS}" fill="none" stroke="${ink}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>`
      : `<rect x="1.6" y="2.1" width="12.8" height="2.4" fill="${ink}"/>
         <path d="M4.2 7.2l2.3 1.9-2.3 1.9" fill="none" stroke="${ink}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
         <path d="M8 11.1h3.6" stroke="${ink}" stroke-width="1.4" stroke-linecap="round"/>`;
  return svg(`<rect x="1.6" y="2.1" width="12.8" height="11.8" rx="2.6" fill="${base}" stroke="${ink}" stroke-width="1.2"/>${sym}`, '');
}

/** The look on screen: read from <html> (theme.js sets data-style / data-ambiance / data-theme). */
export function currentLook() {
  const d = document.documentElement.dataset;
  return lookKey({ style: d.style, ambiance: d.ambiance, theme: d.theme });
}

export function profileIconSvg(kind, look = currentLook()) {
  const k = COLD[kind] ? kind : 'shell';
  const u = `tmi${++seq}`;
  const l = iconLook(look);
  if (l.flat) return contrastArt(k, l);
  if (String(look).startsWith('cold-') || !String(look).includes('-')) return COLD[k](u);
  return paletteArt(k, u, l, String(look).endsWith('-light'));
}

// One observer for the whole page (ES modules load once per shell page): when the look changes, every profile icon
// on screen (tabs, the profile menu, the settings tab) is redrawn.
let watching = false;
let drawnLook = '';
function watchLook() {
  if (watching || typeof MutationObserver === 'undefined') return;
  watching = true;
  drawnLook = currentLook();
  new MutationObserver(() => {
    const look = currentLook();
    if (look === drawnLook) return;
    drawnLook = look;
    for (const el of document.querySelectorAll('[data-picon]')) el.innerHTML = profileIconSvg(el.dataset.picon, look);
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-ambiance', 'data-theme', 'data-style'] });
}

export function profileIcon(h, kind, size = 16) {
  watchLook();
  return h('span', { class: 'tm-picon', dataset: { picon: kind || 'shell' }, style: { width: `${size}px`, height: `${size}px` }, html: profileIconSvg(kind) });
}

/** Mark an element (e.g. a menu row's icon) as a profile icon: drawn now and redrawn when the look changes. */
export function drawProfileIcon(el, kind) {
  watchLook();
  el.dataset.picon = kind || 'shell';
  el.innerHTML = profileIconSvg(kind);
}
