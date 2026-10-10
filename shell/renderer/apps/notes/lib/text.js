// Text helpers for Notes: plain text of a note body, #tags, word counts, accent-insensitive search with
// highlight ranges, snippets, ids and list date groups. DOM helpers take an Element (or a fragment).
const BLOCKS = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'BLOCKQUOTE', 'PRE', 'UL', 'OL', 'LI', 'TABLE', 'TR', 'HR', 'THEAD', 'TBODY']);
export const ZWSP_RE = /\u200b/g;

/** Plain text of an HTML body element: one line per block, table cells separated by tabs. */
export function plainText(root, { checklistMarks = false, bullets = false } = {}) {
  let out = '';
  const nl = () => {
    if (out && !out.endsWith('\n')) out += '\n';
  };
  const walk = (node, listDepth) => {
    for (let n = node.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3) {
        out += n.data.replace(ZWSP_RE, '');
        continue;
      }
      if (n.nodeType !== 1) continue;
      const tag = n.tagName;
      if (tag === 'BR') {
        out += '\n';
        continue;
      }
      if (tag === 'IMG') continue;
      if (tag === 'HR') {
        nl();
        if (bullets) out += '———\n';
        continue;
      }
      if (tag === 'TD' || tag === 'TH') {
        if (n.previousElementSibling) out += '\t';
        walk(n, listDepth);
        continue;
      }
      if (BLOCKS.has(tag)) nl();
      if (tag === 'LI') {
        const list = n.parentElement;
        if (checklistMarks && list?.dataset?.type === 'checklist') out += `${'  '.repeat(Math.max(0, listDepth - 1))}${n.dataset.checked === 'true' ? '☑' : '☐'} `;
        else if (bullets && list?.tagName === 'OL') out += `${'  '.repeat(Math.max(0, listDepth - 1))}${[...list.children].indexOf(n) + Number(list.getAttribute('start') || 1)}. `;
        else if (bullets) out += `${'  '.repeat(Math.max(0, listDepth - 1))}• `;
      }
      walk(n, tag === 'UL' || tag === 'OL' ? listDepth + 1 : listDepth);
      if (BLOCKS.has(tag)) nl();
    }
  };
  walk(root, 0);
  return out.replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '');
}

const TAG_RE = /(^|[\s([{,;])#([\p{L}\p{N}_][\p{L}\p{N}_-]{0,49})/gu;
/** #tags found in a text (lower-cased, unique, at least one letter, not a heading marker). */
export function extractTags(text) {
  const set = new Set();
  for (const m of String(text || '').matchAll(TAG_RE)) {
    const tag = m[2].replace(/[-_]+$/, '');
    if (tag && /\p{L}/u.test(tag)) set.add(tag.toLocaleLowerCase());
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

let segmenter = null;
export function countWords(text, locale = 'en') {
  const s = String(text || '');
  if (!s.trim()) return 0;
  try {
    segmenter ||= new Intl.Segmenter(locale, { granularity: 'word' });
    let n = 0;
    for (const seg of segmenter.segment(s)) if (seg.isWordLike) n++;
    return n;
  } catch {
    return s.split(/\s+/).filter(Boolean).length;
  }
}

export function countChars(text) {
  return [...String(text || '').replace(/\n/g, '')].length;
}

/** Fold a string for accent / case-insensitive search, with a map from folded index -> original index. */
export function fold(s) {
  const src = String(s || '');
  let out = '';
  const map = [];
  let i = 0;
  for (const ch of src) {
    const f = ch.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();
    for (let k = 0; k < f.length; k++) map.push(i);
    out += f;
    i += ch.length;
  }
  map.push(src.length);
  return { text: out, map };
}

export function foldText(s) {
  return fold(s).text;
}

/** Split a search query into terms: words, "quoted phrases" and #tags. */
export function parseQuery(q) {
  const terms = [];
  const tags = [];
  const re = /"([^"]+)"|(\S+)/g;
  for (const m of String(q || '').matchAll(re)) {
    const raw = m[1] ?? m[2];
    if (!m[1] && /^#[\p{L}\p{N}_-]+$/u.test(raw)) tags.push(raw.slice(1).toLocaleLowerCase());
    else if (raw.trim()) terms.push(foldText(raw.trim()));
  }
  return { terms, tags, empty: !terms.length && !tags.length };
}

/** Ranges [start, end) in the ORIGINAL string where any of the (folded) terms occur. */
export function findRanges(text, terms, limit = 500) {
  if (!terms?.length) return [];
  const { text: f, map } = fold(text);
  const ranges = [];
  for (const term of terms) {
    if (!term) continue;
    let from = 0;
    while (ranges.length < limit) {
      const i = f.indexOf(term, from);
      if (i < 0) break;
      ranges.push([map[i], map[i + term.length - 1] + 1 + (text.codePointAt(map[i + term.length - 1]) > 0xffff ? 1 : 0)]);
      from = i + Math.max(1, term.length);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  // merge overlaps
  const out = [];
  for (const r of ranges) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([...r]);
  }
  return out;
}

/** Does a note match a parsed query? (all terms in title or text, all tags present) */
export function matches(note, query) {
  if (query.empty) return true;
  for (const t of query.tags) if (!(note.tags || []).includes(t)) return false;
  if (!query.terms.length) return true;
  const hay = `${foldText(note.title || '')}\n${note.foldedText ?? foldText(note.text || '')}`;
  return query.terms.every((t) => hay.includes(t));
}

/** A short excerpt of `text` around the first match, as [{ text, hit }] segments. */
export function snippet(text, terms, max = 140) {
  const src = String(text || '').replace(/\s+/g, ' ').trim();
  const ranges = findRanges(src, terms, 50);
  if (!ranges.length) return [{ text: src.slice(0, max), hit: false }];
  let start = Math.max(0, ranges[0][0] - 30);
  if (start > 0) {
    const sp = src.lastIndexOf(' ', start);
    start = sp > ranges[0][0] - 50 ? sp + 1 : start;
  }
  const end = Math.min(src.length, start + max);
  const segs = [];
  if (start > 0) segs.push({ text: '…', hit: false });
  let pos = start;
  for (const [a, b] of ranges) {
    if (b <= start) continue;
    if (a >= end) break;
    const s = Math.max(a, start);
    if (s > pos) segs.push({ text: src.slice(pos, s), hit: false });
    segs.push({ text: src.slice(s, Math.min(b, end)), hit: true });
    pos = Math.min(b, end);
  }
  if (pos < end) segs.push({ text: src.slice(pos, end), hit: false });
  return segs;
}

export function newId(prefix = 'n') {
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => (b % 36).toString(36)).join('');
  return `${prefix}${Date.now().toString(36)}${rand}`;
}

/** Bucket for the notes list date headers. */
export function dateGroup(ms, now = Date.now()) {
  const d = new Date(ms);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const t0 = today.getTime();
  if (ms >= t0) return { key: 'today', order: 0 };
  if (ms >= t0 - 86400000) return { key: 'yesterday', order: 1 };
  if (ms >= t0 - 6 * 86400000) return { key: 'week', order: 2 };
  if (ms >= t0 - 29 * 86400000) return { key: 'month', order: 3 };
  if (d.getFullYear() === today.getFullYear()) return { key: `m${d.getMonth()}`, order: 4 + (11 - d.getMonth()), month: d.getMonth(), year: d.getFullYear() };
  return { key: `y${d.getFullYear()}`, order: 100 + (today.getFullYear() - d.getFullYear()), year: d.getFullYear() };
}

/** File-name friendly version of a title (exports). */
export function fileNameOf(title, fallback = 'Note') {
  const s = String(title || '')
    .replace(/[\/\\:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .replace(/[. ]+$/, '');
  return s || fallback;
}
