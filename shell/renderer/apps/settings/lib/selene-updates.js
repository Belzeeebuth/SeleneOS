// Selene self-updates (docs/UPDATES.md): Selene's own packages in the « Mises à jour » list are shown as one entry
// (« Selene 1.0.1 ») instead of three package names. Pure, unit-tested (shell/test/selene-updates.unit.mjs).
export const SELENE_PACKAGES = ['aurora-shell', 'aurora-base', 'aurora-electron'];

/** "1.0.1-331" -> "1.0.1" (the build number after the last "-" is dropped; epochs too). */
export function upstreamVersion(v) {
  const s = String(v || '').replace(/^\d+:/, '');
  const i = s.lastIndexOf('-');
  return i > 0 ? s.slice(0, i) : s;
}

/**
 * parseAptSimulation() rows -> { others: [rows that are not Selene's], selene: null | { name, version, from,
 * electron (only aurora-electron changes), security, packages: [rows] } }.
 */
export function groupSelene(pkgs) {
  const list = Array.isArray(pkgs) ? pkgs : [];
  const mine = list.filter((p) => SELENE_PACKAGES.includes(p?.name));
  const others = list.filter((p) => !SELENE_PACKAGES.includes(p?.name));
  if (!mine.length) return { others, selene: null };
  const main = mine.find((p) => p.name === 'aurora-shell') || mine.find((p) => p.name === 'aurora-base');
  const electron = mine.find((p) => p.name === 'aurora-electron');
  const ref = main || electron;
  return {
    others,
    selene: {
      electron: !main,
      version: upstreamVersion(ref.to),
      from: ref.from ? upstreamVersion(ref.from) : null,
      security: mine.some((p) => p.security),
      shell: mine.some((p) => p.name === 'aurora-shell' || p.name === 'aurora-electron'),
      packages: mine,
    },
  };
}
