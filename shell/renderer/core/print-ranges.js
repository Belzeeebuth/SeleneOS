// Page ranges of the print dialog (pure: no DOM, unit-tested in test/print.unit.mjs).
//   parseRanges('1-3, 5', 12) -> { ok: true, ranges: [[1, 3], [5, 5]], text: '1-3,5', count: 4, first: 1 }
//   parseRanges('4-2', 12)    -> { ok: false, error: 'order' }      errors: 'empty' | 'syntax' | 'order' | 'zero' | 'past'
//   An open range "5-" runs to the last page (needs `max`). `max` = 0 / undefined: page count unknown.
export function parseRanges(input, max = 0) {
  const s = String(input ?? '')
    .replace(/[–—]/g, '-')
    .trim();
  if (!s) return { ok: false, error: 'empty' };
  const parts = s
    .split(/[,;]/)
    .map((p) => p.replace(/\s+/g, ''))
    .filter(Boolean);
  if (!parts.length) return { ok: false, error: 'syntax' };
  const ranges = [];
  for (const p of parts) {
    const m = /^(\d{1,5})(?:(-)(\d{1,5})?)?$/.exec(p);
    if (!m) return { ok: false, error: 'syntax' };
    const a = Number(m[1]);
    let b = m[2] ? (m[3] ? Number(m[3]) : max || 0) : a;
    if (a < 1) return { ok: false, error: 'zero' };
    if (m[2] && !m[3] && !max) return { ok: false, error: 'syntax' };
    if (b < a) return { ok: false, error: 'order' };
    if (max && b > max) return { ok: false, error: 'past', page: b };
    ranges.push([a, b]);
  }
  const text = ranges.map(([a, b]) => (a === b ? String(a) : `${a}-${b}`)).join(',');
  const count = ranges.reduce((n, [a, b]) => n + (b - a + 1), 0);
  return { ok: true, ranges, text, count, first: ranges[0][0] };
}

/** Default paper for a language: Letter in English (US), A4 everywhere else. */
export function defaultPaper(lang) {
  return lang === 'en' ? 'Letter' : 'A4';
}

/** Normalise what 'printers:list' returns (array or { printers }) into [{ name, label, isDefault, state, location }]. */
export function normalizePrinters(res) {
  const list = Array.isArray(res) ? res : Array.isArray(res?.printers) ? res.printers : [];
  const out = [];
  for (const p of list) {
    if (!p) continue;
    const name = typeof p === 'string' ? p : p.name || p.id || p.queue;
    if (!name || typeof name !== 'string') continue;
    out.push({
      name,
      label: (typeof p === 'object' && (p.label || p.info || p.description || p.displayName || p.model)) || name,
      isDefault: !!(typeof p === 'object' && (p.isDefault || p.default)),
      state: (typeof p === 'object' && p.state) || 'idle',
      location: (typeof p === 'object' && p.location) || '',
    });
  }
  return out;
}

/** Duplex value for CUPS ('sides'): two-sided long edge in portrait, short edge in landscape. */
export function sidesFor(duplex, landscape) {
  if (!duplex) return 'one-sided';
  return landscape ? 'two-sided-short-edge' : 'two-sided-long-edge';
}
