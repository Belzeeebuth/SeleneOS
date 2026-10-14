// Small helpers shared by the Podcasts & News modules (no DOM, no imports).

/** FNV-1a (52 bits) of a string, base 36: stable short ids for feeds and items. */
export function hashId(s) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const str = String(s ?? '');
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return ((h2 & 0x1fffff) * 0x100000000 + h1).toString(36);
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** 75 -> "1:15", 3723 -> "1:02:03" (player clock). */
export function clock(s) {
  const t = Math.max(0, Math.floor(Number(s) || 0));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

/** Duration in words: { h, m, s } parts for the i18n strings ("1 h 02 min", "34 min", "45 s"). */
export function durationParts(s) {
  const t = Math.max(0, Math.round(Number(s) || 0));
  return { h: Math.floor(t / 3600), m: Math.floor((t % 3600) / 60), s: t % 60, total: t };
}

/** Normalise what the person typed into an http(s) URL (adds https:// when there is no scheme), or null. */
export function normaliseUrl(input) {
  let s = String(input ?? '').trim();
  if (!s) return null;
  if (/^feed:\/\//i.test(s)) s = s.replace(/^feed:\/\//i, 'https://');
  else if (/^feed:/i.test(s)) s = s.slice(5);
  if (/^(itpc|pcast|podcast):\/\//i.test(s)) s = s.replace(/^[a-z]+:\/\//i, 'https://');
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s.replace(/^\/+/, '')}`;
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname || /\s/.test(u.hostname)) return null;
    return u.href;
  } catch {
    return null;
  }
}

export function hostOf(url) {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Debounce with flush(). */
export function debounce(fn, ms) {
  let t = null;
  const run = () => {
    clearTimeout(t);
    t = null;
    fn();
  };
  const d = () => {
    clearTimeout(t);
    t = setTimeout(run, ms);
  };
  d.flush = () => {
    if (t) run();
  };
  d.cancel = () => clearTimeout(t);
  return d;
}

/** Run `fn` over `list` with at most `limit` at once (and at most `perHost` per host when hostOf(key(x)) is given). */
export async function pool(list, limit, fn, { key, perHost = 2 } = {}) {
  const queue = [...list];
  const hosts = new Map();
  let active = 0;
  return new Promise((resolve) => {
    if (!queue.length) return resolve();
    const next = () => {
      if (!queue.length && !active) return resolve();
      while (active < limit && queue.length) {
        const i = key ? queue.findIndex((x) => (hosts.get(hostOf(key(x))) || 0) < perHost) : 0;
        if (i < 0) break;
        const x = queue.splice(i, 1)[0];
        const h = key ? hostOf(key(x)) : '';
        hosts.set(h, (hosts.get(h) || 0) + 1);
        active++;
        Promise.resolve()
          .then(() => fn(x))
          .catch(() => {})
          .finally(() => {
            active--;
            hosts.set(h, hosts.get(h) - 1);
            next();
          });
      }
    };
    next();
  });
}
