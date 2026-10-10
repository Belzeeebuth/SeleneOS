// Profile icons (16px artwork, Fluent style) as inline SVG strings.
let seq = 0;

function svg(body, defs) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" aria-hidden="true"><defs>${defs}</defs>${body}</svg>`;
}

const ART = {
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

export function profileIconSvg(kind) {
  const fn = ART[kind] || ART.shell;
  return fn(`tmi${++seq}`);
}

export function profileIcon(h, kind, size = 16) {
  return h('span', { class: 'tm-picon', style: { width: `${size}px`, height: `${size}px` }, html: profileIconSvg(kind) });
}
