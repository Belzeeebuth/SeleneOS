// Installer illustrations (inline SVG, 240x240). Shapes use classes styled in style.css (.s-surface, .s-line,
// .s-accent…) and the gradients' stops use classes too (.g-hi, .g-lo, .g-night…), so every colour comes from
// the theme tokens (accent, ambiance, light/dark). Only LOGO keeps the logo's own silver (crescent + dot-star).
const GRAD = `
  <defs>
    <linearGradient id="ins-g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" class="g-hi"/><stop offset="1" class="g-lo"/>
    </linearGradient>
    <linearGradient id="ins-g2" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" class="g-night-hi"/><stop offset="1" class="g-night-lo"/>
    </linearGradient>
    <radialGradient id="ins-glow" cx=".5" cy=".5" r=".5">
      <stop offset="0" class="g-glow"/><stop offset="1" class="g-glow g-end"/>
    </radialGradient>
    <linearGradient id="ins-moon" x1="10" y1="10" x2="26" y2="44" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#f4f6fb"/><stop offset="1" stop-color="#a9b4ca"/>
    </linearGradient>
  </defs>`;

const glow = '<circle cx="120" cy="120" r="112" fill="url(#ins-glow)"/>';
const svg = (body, cls = '') => `<svg class="ins-svg ${cls}" viewBox="0 0 240 240" aria-hidden="true">${GRAD}${glow}${body}</svg>`;

// Selene logo (crescent and dot-star, 48 grid): same geometry as assets/aurora-logo.svg and LOGO in core/app-glyphs.js.
const LOGO = (x, y, s) => `
  <g transform="translate(${x} ${y}) scale(${s / 48})">
    <path d="M15.04 10.58A17 17 0 1 0 36.92 32.46A15.6 15.6 0 0 1 15.04 10.58Z" fill="url(#ins-moon)" stroke="#4d5a75" stroke-opacity=".85" stroke-width=".9" stroke-linejoin="round"/>
    <circle cx="37.2" cy="10.6" r="2.7" fill="#dfe5f0" stroke="#4d5a75" stroke-opacity=".85" stroke-width=".9"/>
  </g>`;

/** The logo alone (side panel brand), `size` px square. */
export const BRAND = (size = 28) =>
  `<svg class="ins-brand-logo" width="${size}" height="${size}" viewBox="0 0 48 48" aria-hidden="true"><defs><linearGradient id="ins-brand-m" x1="10" y1="10" x2="26" y2="44" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#f4f6fb"/><stop offset="1" stop-color="#a9b4ca"/></linearGradient></defs><path d="M15.04 10.58A17 17 0 1 0 36.92 32.46A15.6 15.6 0 0 1 15.04 10.58Z" fill="url(#ins-brand-m)" stroke="#4d5a75" stroke-opacity=".85" stroke-width=".9" stroke-linejoin="round"/><circle cx="37.2" cy="10.6" r="2.7" fill="#dfe5f0" stroke="#4d5a75" stroke-opacity=".85" stroke-width=".9"/></svg>`;

export const ART = {
  welcome: () =>
    svg(`
    <g>
      <circle cx="120" cy="120" r="78" class="s-ring" fill="none" stroke-width="2" stroke-dasharray="4 8"/>
      <circle cx="120" cy="120" r="98" class="s-ring" fill="none" stroke-width="1.5" stroke-dasharray="2 10" opacity=".6"/>
      ${LOGO(76, 74, 92)}
      <g transform="translate(150 46)">
        <rect width="58" height="38" rx="10" class="s-surface"/><path d="M14 38l-2 12 12-12z" class="s-surface"/>
        <text x="29" y="25" text-anchor="middle" class="s-text">EN</text>
      </g>
      <g transform="translate(30 150)">
        <rect width="58" height="38" rx="10" fill="url(#ins-g)"/><path d="M44 38l2 12-12-12z" class="s-accent"/>
        <text x="29" y="25" text-anchor="middle" class="s-text-on">FR</text>
      </g>
    </g>`),

  keyboard: () =>
    svg(`
    <g>
      <rect x="22" y="76" width="196" height="96" rx="14" class="s-surface"/>
      ${[0, 1, 2]
        .map((r) =>
          Array.from({ length: 10 - (r === 2 ? 2 : 0) }, (_, c) => {
            const x = 36 + c * 17 + (r === 1 ? 6 : r === 2 ? 22 : 0);
            const hl = r === 1 && c === 0;
            return `<rect x="${x}" y="${90 + r * 20}" width="13" height="14" rx="3" class="${hl ? 's-accent' : 's-key'}"/>`;
          }).join(''),
        )
        .join('')}
      <rect x="70" y="150" width="100" height="12" rx="3" class="s-key"/>
      <g transform="translate(150 28)">
        <rect width="58" height="40" rx="10" fill="url(#ins-g)"/>
        <text x="29" y="27" text-anchor="middle" class="s-text-on">Aa</text>
      </g>
    </g>`),

  disk: () =>
    svg(`
    <g>
      <rect x="40" y="120" width="160" height="62" rx="12" class="s-surface"/>
      <rect x="58" y="146" width="70" height="9" rx="4.5" class="s-line"/>
      <circle cx="176" cy="151" r="7" class="s-accent"/>
      <path d="M120 36a10 10 0 0 1 10 10v40l12-12a10 10 0 1 1 14 14l-29 29a10 10 0 0 1-14 0l-29-29a10 10 0 1 1 14-14l12 12V46a10 10 0 0 1 10-10z" fill="url(#ins-g)"/>
    </g>`),

  account: () =>
    svg(`
    <g>
      <circle cx="120" cy="112" r="70" class="s-surface"/>
      <circle cx="120" cy="96" r="24" fill="url(#ins-g)"/>
      <path d="M78 156c6-22 24-34 42-34s36 12 42 34" fill="url(#ins-g)" opacity=".85"/>
      <g transform="translate(156 142)">
        <circle cx="20" cy="20" r="22" class="s-surface s-stroke"/>
        <rect x="10" y="18" width="20" height="15" rx="3" class="s-accent"/>
        <path d="M14 18v-4a6 6 0 0 1 12 0v4" fill="none" class="s-accent-stroke" stroke-width="3"/>
      </g>
    </g>`),

  timezone: () =>
    svg(`
    <g>
      <circle cx="112" cy="116" r="72" fill="url(#ins-g)" opacity=".92"/>
      <g fill="none" class="s-on-stroke" stroke-opacity=".55" stroke-width="2">
        <ellipse cx="112" cy="116" rx="30" ry="72"/><path d="M40 116h144M50 80h124M50 152h124M112 44v144"/>
      </g>
      <g transform="translate(140 136)">
        <circle cx="30" cy="30" r="32" class="s-surface s-stroke"/>
        <path d="M30 14v17l11 8" fill="none" class="s-accent-stroke" stroke-width="4" stroke-linecap="round"/>
      </g>
    </g>`),

  drivers: () =>
    svg(`
    <g>
      <rect x="30" y="74" width="180" height="100" rx="14" class="s-surface"/>
      <rect x="30" y="174" width="56" height="12" rx="3" class="s-key"/>
      <rect x="100" y="174" width="96" height="9" rx="3" class="s-line"/>
      ${[82, 154]
        .map(
          (cx) => `<circle cx="${cx}" cy="124" r="34" class="s-surface s-stroke"/>
        <circle cx="${cx}" cy="124" r="26" fill="none" class="s-accent-stroke" stroke-width="3" stroke-dasharray="14 7" opacity=".7"/>
        <circle cx="${cx}" cy="124" r="9" fill="url(#ins-g)"/>`,
        )
        .join('')}
      <g transform="translate(150 22)">
        <rect width="58" height="40" rx="10" fill="url(#ins-g)"/>
        <path d="M29 9v16m-7-7 7 7 7-7M19 31h20" fill="none" class="s-on-stroke" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>
      </g>
    </g>`),

  // A game controller, a sparkle and a download cloud (the apps arrive at the first sign-in).
  games: () =>
    svg(`
    <g>
      <path d="M62 92h116c22 0 36 18 40 42l6 34c3 18-16 30-30 18l-20-18H66l-20 18c-14 12-33 0-30-18l6-34c4-24 18-42 40-42z" class="s-surface s-stroke"/>
      <path d="M70 126h28M84 112v28" fill="none" class="s-accent-stroke" stroke-width="7" stroke-linecap="round"/>
      <circle cx="160" cy="116" r="8" fill="url(#ins-g)"/>
      <circle cx="180" cy="134" r="8" fill="url(#ins-g)"/>
      <circle cx="142" cy="134" r="6" class="s-line"/>
      <circle cx="160" cy="152" r="6" class="s-line"/>
      <rect x="106" y="150" width="28" height="8" rx="4" class="s-key"/>
      <g transform="translate(150 26)">
        <rect width="58" height="40" rx="10" fill="url(#ins-g)"/>
        <path d="M29 9v16m-7-7 7 7 7-7M19 31h20" fill="none" class="s-on-stroke" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>
      </g>
      <path d="M48 44l4 10 10 4-10 4-4 10-4-10-10-4 10-4z" class="s-accent"/>
    </g>`),

  summary: () =>
    svg(`
    <g>
      <rect x="56" y="36" width="128" height="166" rx="14" class="s-surface"/>
      <rect x="92" y="28" width="56" height="18" rx="6" fill="url(#ins-g)"/>
      ${[0, 1, 2, 3]
        .map(
          (i) => `<circle cx="82" cy="${78 + i * 30}" r="9" fill="url(#ins-g)"/>
        <path d="M78 ${78 + i * 30}l3 3 6-6" fill="none" class="s-on-stroke" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
        <rect x="100" y="${73 + i * 30}" width="${[64, 52, 60, 44][i]}" height="10" rx="5" class="s-line"/>`,
        )
        .join('')}
    </g>`),

  installing: () =>
    svg(
      `
    <circle cx="120" cy="120" r="88" fill="none" class="s-track" stroke-width="6"/>
    <circle cx="120" cy="120" r="70" fill="none" class="s-track" stroke-width="3"/>
    <g class="ins-spin-slow" style="transform-origin:120px 120px">
      <circle cx="120" cy="120" r="88" fill="none" stroke="url(#ins-g)" stroke-width="6" stroke-linecap="round" stroke-dasharray="120 433"/>
    </g>
    <g class="ins-spin-rev" style="transform-origin:120px 120px">
      <circle cx="120" cy="120" r="70" fill="none" class="s-accent-stroke" stroke-width="3" stroke-linecap="round" stroke-dasharray="60 380" opacity=".5"/>
    </g>
    ${LOGO(88, 88, 64)}`,
      'ins-busy',
    ),

  done: () =>
    svg(`
    <g class="ins-pop" style="transform-origin:120px 120px">
      <circle cx="120" cy="120" r="66" fill="url(#ins-g)"/>
      <path d="M90 121l20 20 40-42" fill="none" class="s-on-stroke" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/>
    </g>
    <g class="ins-stars">
      <circle cx="44" cy="70" r="3" class="s-star"/><circle cx="196" cy="64" r="2.5" class="s-star"/>
      <circle cx="190" cy="170" r="3" class="s-star"/><circle cx="46" cy="174" r="2" class="s-star"/>
      <circle cx="120" cy="30" r="2.5" class="s-star"/><circle cx="212" cy="120" r="2" class="s-star"/><circle cx="28" cy="122" r="2" class="s-star"/>
    </g>`),

  error: () =>
    svg(`
    <g>
      <path d="M120 44c6 0 11 3 14 8l66 114c6 11-2 24-14 24H54c-12 0-20-13-14-24l66-114c3-5 8-8 14-8z" class="s-surface s-stroke"/>
      <path d="M120 92v46" stroke="var(--ins-danger)" stroke-width="12" stroke-linecap="round"/>
      <circle cx="120" cy="160" r="7" fill="var(--ins-danger)"/>
    </g>`),
};
