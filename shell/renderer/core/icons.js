// Fluent UI System Icons (MIT) packed in assets/icons/fluent.json by tools/vendor-icons.mjs.
//   icon('folder')                       -> <span class="icon">…regular svg…</span>
//   icon('folder', { filled: true, size: 20, class: 'x' })
//   hasIcon('wifi_1')
// Unknown names render an empty box (and warn once in dev).
let MAP = {};
const warned = new Set();

export async function loadIcons() {
  try {
    MAP = await (await fetch('app://shell/assets/icons/fluent.json')).json();
  } catch (err) {
    console.error('[icons] failed to load', err);
  }
}

export function hasIcon(name) {
  return !!MAP[name];
}

export function iconSvg(name, { filled = false } = {}) {
  const e = MAP[name];
  if (!e) {
    if (!warned.has(name)) {
      warned.add(name);
      console.warn(`[icons] unknown icon "${name}"`);
    }
    return '<svg viewBox="0 0 20 20"></svg>';
  }
  const inner = (filled ? e.f || e.r : e.r || e.f) || '';
  const vb = e.v || 20;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${vb} ${vb}" aria-hidden="true">${inner}</svg>`;
}

export function icon(name, opts = {}) {
  const span = document.createElement('span');
  span.className = `icon${opts.class ? ` ${opts.class}` : ''}`;
  if (opts.size) {
    span.style.width = `${opts.size}px`;
    span.style.height = `${opts.size}px`;
  }
  if (opts.color) span.style.color = opts.color;
  span.innerHTML = iconSvg(name, opts);
  span.dataset.icon = name;
  return span;
}
