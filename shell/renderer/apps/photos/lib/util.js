// Small shared helpers for the Photos app (no DOM state).
export const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.avif', '.ico'];
// Formats the canvas can encode (Save / Save as copy keep these; others are saved as PNG).
export const ENCODABLE = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
// Formats whose pixels can be rotated/edited without losing something essential (animation, vectors).
export const EDITABLE = ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.avif', '.gif', '.ico', '.svg'];
export const DND_MIME = 'application/x-aurora-paths';

export const extOf = (p) => (/\.[^./]+$/.exec(p || '')?.[0] || '').toLowerCase();
export const isImage = (p) => IMAGE_EXT.includes(extOf(p));
export const baseName = (p) => String(p || '').replace(/\/+$/, '').split('/').pop() || '/';
export const dirName = (p) => {
  const s = String(p || '').replace(/\/+$/, '');
  const i = s.lastIndexOf('/');
  return i <= 0 ? '/' : s.slice(0, i);
};
export const stem = (p) => {
  const b = baseName(p);
  const e = extOf(b);
  return e && e !== b ? b.slice(0, -e.length) : b;
};
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const reduceMotion = () => document.documentElement.dataset.animations === 'off';
export const EASE = 'cubic-bezier(0.1, 0.9, 0.2, 1)';

export function debounce(fn, ms) {
  let t = null;
  const d = (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
  d.cancel = () => clearTimeout(t);
  d.flush = (...a) => {
    clearTimeout(t);
    fn(...a);
  };
  return d;
}

export function rafThrottle(fn) {
  let id = 0;
  let last = [];
  const r = (...a) => {
    last = a;
    if (!id) id = requestAnimationFrame(() => {
      id = 0;
      fn(...last);
    });
  };
  r.cancel = () => {
    cancelAnimationFrame(id);
    id = 0;
  };
  return r;
}

/** Date used for sorting/grouping: EXIF date taken, else the modification time. */
export const itemDate = (it) => it?.taken || it?.mtime || 0;

export function sortItems(items) {
  return items.sort((a, b) => itemDate(b) - itemDate(a) || a.name.localeCompare(b.name, undefined, { numeric: true }));
}

export function sortByName(items) {
  return items.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
}

const monthFmt = new Map();
export function monthLabel(ts, locale) {
  let f = monthFmt.get(locale);
  if (!f) monthFmt.set(locale, (f = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' })));
  return f.format(new Date(ts)); // locale casing: "October 2026" / "octobre 2026"
}
export function monthKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Group items (already sorted newest first) by month: [{ key, label, ts, items }]. */
export function groupByMonth(items, locale) {
  const groups = [];
  let cur = null;
  for (const it of items) {
    const ts = itemDate(it);
    const key = monthKey(ts);
    if (!cur || cur.key !== key) {
      cur = { key, ts, label: monthLabel(ts, locale), items: [] };
      groups.push(cur);
    }
    cur.items.push(it);
  }
  return groups;
}

/** Search by file name, folder name, or date text ("october", "oct 2026", "2026", "12/10/2026"). */
export function matcher(query, locale) {
  const q = norm(query);
  if (!q) return () => true;
  const words = q.split(/\s+/).filter(Boolean);
  const fmts = [
    new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }),
    new Intl.DateTimeFormat(locale, { dateStyle: 'long' }),
    new Intl.DateTimeFormat(locale, { dateStyle: 'short' }),
    new Intl.DateTimeFormat(locale, { month: 'short' }),
    new Intl.DateTimeFormat(locale, { weekday: 'long' }),
  ];
  if (!locale.startsWith('en')) fmts.push(new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }), new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' }));
  const cache = new Map();
  return (it) => {
    const ts = itemDate(it);
    const dayKey = Math.floor(ts / 86400000);
    let dateText = cache.get(dayKey);
    if (dateText === undefined) {
      const d = new Date(ts);
      dateText = norm(fmts.map((f) => f.format(d)).join(' ') + ` ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
      cache.set(dayKey, dateText);
    }
    const hay = `${norm(it.name)} ${norm(baseName(it.dir))} ${dateText}`;
    return words.every((w) => hay.includes(w));
  };
}
export function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();
}

/** Shared drag payload for dragging photos to File Explorer / the desktop / other apps. */
export function setDragPaths(dt, paths) {
  dt.effectAllowed = 'copyMove';
  dt.setData(DND_MIME, JSON.stringify(paths));
  dt.setData('text/uri-list', paths.map((p) => `file://${p.split('/').map(encodeURIComponent).join('/')}`).join('\r\n'));
  dt.setData('text/plain', paths.join('\n'));
}

export function formatExposure(v) {
  if (!v) return '';
  if (v >= 1) return `${Math.round(v * 10) / 10} s`;
  return `1/${Math.round(1 / v)} s`;
}

export function megapixels(w, h) {
  return Math.round((w * h) / 100000) / 10;
}

export function uid() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Load a local picture for pixel access: media:// images would taint canvases (cross-origin),
 *  so the bytes are fetched and shown through a same-origin blob: URL. */
export async function loadPixels(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  const obj = URL.createObjectURL(blob);
  try {
    const img = await loadImage(obj);
    try {
      await img.decode();
    } catch {}
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(obj), 1000);
  }
}

/** Load an image element from a URL (resolves once decoded). */
export function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('decode'));
    img.src = url;
  });
}
