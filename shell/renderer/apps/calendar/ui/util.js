// Small DOM helpers. ctx.h() assigns style objects with Object.assign, which ignores custom
// properties (--ev, --cols…): css() turns an object into a style string that keeps them.
export function css(obj) {
  if (!obj) return null;
  return Object.entries(obj)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${k.startsWith('--') ? k : k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}: ${v}`)
    .join('; ');
}
