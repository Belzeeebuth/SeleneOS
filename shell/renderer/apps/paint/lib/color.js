// Colour helpers shared by the Paint app (hex / RGB / HSV conversions).
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function hexToRgb(hex) {
  let s = String(hex ?? '').trim().replace(/^#/, '');
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(s)) return null;
  const n = parseInt(s, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex(r, g, b) {
  return `#${[r, g, b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('')}`;
}

/** h in [0, 360), s and v in [0, 1]. */
export function rgbToHsv(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, max ? d / max : 0, max];
}

export function hsvToRgb(h, s, v) {
  h = ((h % 360) + 360) % 360;
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let rgb;
  if (h < 60) rgb = [c, x, 0];
  else if (h < 120) rgb = [x, c, 0];
  else if (h < 180) rgb = [0, c, x];
  else if (h < 240) rgb = [0, x, c];
  else if (h < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return rgb.map((n) => Math.round((n + m) * 255));
}

/** Accepts #rgb, #rrggbb, rrggbb and rgb(r, g, b). Returns '#rrggbb' or null. */
export function parseColor(str) {
  const s = String(str ?? '').trim();
  const m = /^rgba?\(\s*(\d+)\s*[, ]\s*(\d+)\s*[, ]\s*(\d+)/i.exec(s);
  if (m) return rgbToHex(+m[1], +m[2], +m[3]);
  const rgb = hexToRgb(s);
  return rgb ? rgbToHex(...rgb) : null;
}

/** Relative luminance (0..1) — used to pick readable overlay colours. */
export function luminance(hex) {
  const [r, g, b] = (hexToRgb(hex) || [0, 0, 0]).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Mix a colour towards white (amt > 0) or black (amt < 0). */
export function shade(hex, amt) {
  const [r, g, b] = hexToRgb(hex) || [0, 0, 0];
  const t = amt < 0 ? 0 : 255;
  const p = Math.abs(amt);
  return rgbToHex(r + (t - r) * p, g + (t - g) * p, b + (t - b) * p);
}
