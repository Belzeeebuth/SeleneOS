// Feed parsing for Podcasts & News (renderer side, DOMParser documents are inert: nothing loads or runs).
//
//   parseFeed(text, url) -> { format: 'rss'|'atom'|'rdf'|'json', title, siteUrl, description, image, author, language,
//        ttl (minutes|null), podcast (bool), items: [item] }       throws Error with code ENOTFEED (an HTML page…) or EPARSE
//   item: { guid, title, link, date (ms|null), author, html (content or description), summary (plain text ≤ 300),
//        image, enclosure: { url, type, length } | null, duration (s|null), episode, season, chapters (url|null),
//        inlineChapters: [{ start, title }] | null }
//   discover(html, pageUrl) -> [{ url, title, type }]   <link rel="alternate" type="application/rss+xml|atom+xml|…">
//   guessFeedLinks(html, pageUrl) -> [url]               <a href> on the same site whose address looks like a feed
//   looksLikeHtml(text, contentType), parseDate(s) -> ms|null, parseDuration(v) -> s|null, textOf(html) -> plain text
//   parseOpml(text) -> [{ url, title, siteUrl, folder }] ;  buildOpml(feeds, title) -> OPML 2.0 text
//   parseChapters(jsonText) -> [{ start, title, url }]  (Podcasting 2.0 JSON chapters)
// Supported: RSS 2.0 (+ content:encoded, dc:*, itunes:*, media:*, podcast:chapters, psc:chapters), Atom 1.0 (text,
// html and xhtml content, xml:base), RSS 1.0 / RDF, JSON Feed 1.x. Undefined HTML entities (&nbsp; …), stray "&" and
// control characters are repaired before a second try; a feed that is still not well-formed is read leniently.

const NS = {
  'http://www.w3.org/2005/Atom': 'atom',
  'http://purl.org/atom/ns#': 'atom',
  'http://purl.org/rss/1.0/modules/content/': 'content',
  'http://purl.org/dc/elements/1.1/': 'dc',
  'http://purl.org/dc/terms/': 'dcterms',
  'http://www.itunes.com/dtds/podcast-1.0.dtd': 'itunes',
  'http://www.itunes.com/DTDs/Podcast-1.0.dtd': 'itunes',
  'http://search.yahoo.com/mrss/': 'media',
  'http://search.yahoo.com/mrss': 'media',
  'https://podcastindex.org/namespace/1.0': 'podcast',
  'http://podcastindex.org/namespace/1.0': 'podcast',
  'https://github.com/Podcastindex-org/podcast-namespace/blob/main/docs/1.0.md': 'podcast',
  'http://www.w3.org/1999/02/22-rdf-syntax-ns#': 'rdf',
  'http://purl.org/rss/1.0/': '',
  'http://purl.org/net/rss1.1#': '',
  'http://my.netscape.com/rdf/simple/0.9/': '',
  'http://podlove.org/simple-chapters': 'psc',
  'http://purl.org/rss/1.0/modules/syndication/': 'sy',
  'http://www.google.com/schemas/play-podcasts/1.0': 'googleplay',
};
const XML_NS = 'http://www.w3.org/XML/1998/namespace';

function fail(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/** Canonical "prefix:local" key of an element (known namespaces get their usual prefix; lenient mode keeps the tag). */
function key(el) {
  const ln = el.localName || '';
  if (ln.includes(':')) return ln.toLowerCase();
  const ns = el.namespaceURI;
  let p = '';
  if (ns && ns in NS) p = NS[ns];
  else if (ns && ns !== 'http://www.w3.org/1999/xhtml') p = (el.prefix || 'x').toLowerCase();
  return (p ? `${p}:` : '') + ln.toLowerCase();
}
const kids = (el) => (el ? [...el.children] : []);
/** First child whose key is one of `keys`. */
function child(el, ...keys) {
  for (const c of kids(el)) if (keys.includes(key(c))) return c;
  return null;
}
function children(el, ...keys) {
  return kids(el).filter((c) => keys.includes(key(c)));
}
const clean = (s, n = 1000) =>
  String(s ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, n);

let inertDoc = null;
function inert() {
  if (!inertDoc) inertDoc = document.implementation.createHTMLDocument('');
  return inertDoc;
}

/** Plain text of an HTML fragment (tags dropped, entities decoded), whitespace collapsed. */
export function textOf(html, max = 100000) {
  const s = String(html ?? '');
  if (!/[<&]/.test(s)) return clean(s, max);
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${s.slice(0, 2000000)}`, 'text/html');
  for (const el of doc.querySelectorAll('script, style, noscript, template')) el.remove();
  // block elements end with a space so words do not run together
  for (const el of doc.querySelectorAll('p, div, br, li, h1, h2, h3, h4, h5, h6, tr, blockquote')) el.append(' ');
  return clean(doc.body?.textContent || '', max);
}

/** Titles may carry entities or markup: plain text. */
function titleText(s) {
  return textOf(s, 500);
}

function resolveUrl(u, base) {
  const s = String(u ?? '').trim();
  if (!s) return '';
  try {
    const url = new URL(s, base || undefined);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

/** Effective base URL of an element (xml:base on it or its ancestors, resolved against the document URL). */
function baseOf(el, docUrl) {
  const chain = [];
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    const b = n.getAttributeNS?.(XML_NS, 'base') || n.getAttribute?.('xml:base');
    if (b) chain.unshift(b);
  }
  let base = docUrl;
  for (const b of chain) {
    try {
      base = new URL(b, base).href;
    } catch {}
  }
  return base;
}

const serializer = () => new XMLSerializer();
/** Inner markup of an element whose children are XHTML elements (atom type="xhtml", RSS with raw markup). */
function innerMarkup(el) {
  const s = serializer();
  return [...el.childNodes].map((n) => (n.nodeType === 1 ? s.serializeToString(n) : n.nodeType === 3 || n.nodeType === 4 ? escapeHtml(n.nodeValue) : '')).join('');
}
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** HTML of an RSS description / content element (escaped HTML, CDATA, or raw child markup). */
function htmlOfRss(el) {
  if (!el) return '';
  if (el.children.length) return innerMarkup(el);
  return el.textContent || '';
}
/** HTML of an Atom text construct (type text | html | xhtml). */
function htmlOfAtom(el) {
  if (!el) return '';
  const type = (el.getAttribute('type') || 'text').toLowerCase();
  if (type === 'xhtml' || type === 'application/xhtml+xml') {
    const div = kids(el).find((c) => c.localName === 'div') || el;
    return innerMarkup(div);
  }
  if (type === 'html' || type === 'text/html') return el.children.length ? innerMarkup(el) : el.textContent || '';
  if (el.children.length) return innerMarkup(el);
  return escapeHtml(el.textContent || '').replace(/\n/g, '<br>');
}
function textOfAtom(el) {
  if (!el) return '';
  const type = (el.getAttribute('type') || 'text').toLowerCase();
  return type === 'text' && !el.children.length ? clean(el.textContent, 500) : textOf(htmlOfAtom(el), 500);
}

// ---------------------------------------------------------------- dates and durations
const MONTHS = {
  jan: 0, january: 0, janv: 0, janvier: 0, ene: 0,
  feb: 1, february: 1, fev: 1, fevr: 1, fevrier: 1, févr: 1, février: 1,
  mar: 2, march: 2, mars: 2,
  apr: 3, april: 3, avr: 3, avril: 3,
  may: 4, mai: 4,
  jun: 5, june: 5, juin: 5,
  jul: 6, july: 6, juil: 6, juillet: 6,
  aug: 7, august: 7, aou: 7, aout: 7, août: 7,
  sep: 8, sept: 8, september: 8, septembre: 8,
  oct: 9, october: 9, octobre: 9,
  nov: 10, november: 10, novembre: 10,
  dec: 11, december: 11, déc: 11, decembre: 11, décembre: 11,
};
const ZONES = {
  ut: 0, utc: 0, gmt: 0, z: 0, wet: 0, bst: 60, ist: 60, cet: 60, met: 60, mez: 60, west: 60, cest: 120, mesz: 120, eet: 120, eest: 180, msk: 180,
  est: -300, edt: -240, cst: -360, cdt: -300, mst: -420, mdt: -360, pst: -480, pdt: -420, akst: -540, akdt: -480, hst: -600,
  ast: -240, adt: -180, nst: -210, ndt: -150, jst: 540, kst: 540, aest: 600, aedt: 660, acst: 570, awst: 480, nzst: 720, nzdt: 780,
};
function zoneOffset(z) {
  if (!z) return 0;
  const s = z.trim().toLowerCase();
  const m = /^([+-])(\d{1,2}):?(\d{2})?$/.exec(s);
  if (m) return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0));
  const g = /^(?:gmt|utc)([+-])(\d{1,2}):?(\d{2})?$/.exec(s);
  if (g) return (g[1] === '-' ? -1 : 1) * (Number(g[2]) * 60 + Number(g[3] || 0));
  return ZONES[s] ?? 0;
}
const fold = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** A date in any common feed format (RFC 822 and its variants, ISO 8601 / RFC 3339, French month names, Unix time). */
export function parseDate(input) {
  if (input == null) return null;
  let s = String(input).trim();
  if (!s) return null;
  const ok = (ms) => (Number.isFinite(ms) && ms > 0 && ms < 4102444800000 ? ms : null);
  if (/^\d{9,10}$/.test(s)) return ok(Number(s) * 1000);
  if (/^\d{12,13}$/.test(s)) return ok(Number(s));
  // ISO 8601 / RFC 3339 (also "2026-10-13 14:05", "20261013T140500Z", "2026/10/13")
  let m = /^(\d{4})[-/]?(\d{2})[-/]?(\d{2})(?:[T\s]+(\d{1,2}):?(\d{2})(?::?(\d{2})(?:[.,]\d+)?)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?|UTC|GMT|[A-Z]{2,5})?$/i.exec(s);
  if (m) {
    const [, y, mo, d, hh = 0, mm = 0, ss = 0, z] = m;
    return ok(Date.UTC(+y, +mo - 1, +d, +hh, +mm, +ss) - zoneOffset(z) * 60000);
  }
  // RFC 822 and friends: "Tue, 13 Oct 2026 14:05:00 +0200", "13 Oct 26 14:05 GMT", "Tuesday, October 13, 2026 2:05 PM EST",
  // "mar., 13 oct. 2026 14:05:00 +0200", "mardi 13 octobre 2026"
  s = s
    .replace(/^(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?|(?:lun|mar|mer|jeu|ven|sam|dim)[a-z]*\.?,|(?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche),?)\s*/i, '')
    .replace(/\s*\([a-z][a-z ]*\)$/i, '')
    .replace(/\s+/g, ' ');
  m = /^(\d{1,2})(?:er)?[\s-]+([a-zà-ü]+)\.?[\s-]+(\d{2,4})(?:,?\s+(?:à\s+)?(\d{1,2})[:h](\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(am|pm)?)?\s*(\(?[a-z]{1,5}\)?|[+-]\d{2}:?\d{2}|(?:gmt|utc)[+-]\d{1,2}(?::?\d{2})?)?\)?$/i.exec(s);
  let parts = null;
  if (m) parts = { d: m[1], mon: m[2], y: m[3], hh: m[4], mm: m[5], ss: m[6], ap: m[7], z: m[8] };
  else {
    m = /^([a-zà-ü]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})(?:,?\s+(?:at\s+)?(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?)?\s*([a-z]{1,5}|[+-]\d{2}:?\d{2})?$/i.exec(s);
    if (m) parts = { mon: m[1], d: m[2], y: m[3], hh: m[4], mm: m[5], ss: m[6], ap: m[7], z: m[8] };
  }
  if (parts) {
    const mon = MONTHS[fold(parts.mon)] ?? MONTHS[parts.mon.toLowerCase()] ?? MONTHS[fold(parts.mon).slice(0, 3)];
    if (mon != null) {
      let y = Number(parts.y);
      if (y < 100) y += y < 70 ? 2000 : 1900;
      let hh = Number(parts.hh || 0);
      if (parts.ap) {
        const pm = parts.ap.toLowerCase() === 'pm';
        if (hh === 12) hh = pm ? 12 : 0;
        else if (pm) hh += 12;
      }
      const z = (parts.z || '').replace(/[()]/g, '');
      return ok(Date.UTC(y, mon, Number(parts.d), hh, Number(parts.mm || 0), Number(parts.ss || 0)) - zoneOffset(z) * 60000);
    }
  }
  return ok(Date.parse(String(input)));
}

/** itunes:duration and friends: "1:02:03", "62:03", "3723", "3723.5", "1h 02m 03s", "PT1H2M3S" -> seconds. */
export function parseDuration(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  let n = null;
  let m;
  if (/^\d+(\.\d+)?$/.test(s)) n = Math.round(Number(s));
  else if ((m = /^(?:(\d+):)?(\d{1,3}):(\d{1,2})(?:[.,]\d+)?$/.exec(s))) n = Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  else if ((m = /^P?T?(?:(\d+(?:\.\d+)?)\s*h(?:ours?)?)?\s*(?:(\d+(?:\.\d+)?)\s*m(?:in(?:utes?)?)?)?\s*(?:(\d+(?:\.\d+)?)\s*s(?:ec(?:onds?)?)?)?$/i.exec(s)) && (m[1] || m[2] || m[3])) {
    n = Math.round(Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0));
  }
  return Number.isFinite(n) && n > 0 && n < 7 * 86400 ? n : null;
}
function intOf(v) {
  const n = parseInt(String(v ?? '').trim(), 10);
  return Number.isFinite(n) && n >= 0 && n < 100000 ? n : null;
}

// ---------------------------------------------------------------- XML repair
let entityCache = null;
/** Named HTML entities (except the five XML ones) as numeric references, bare "&" escaped, control characters out. */
function repairXml(text) {
  entityCache ||= new Map();
  const ta = inert().createElement('textarea');
  return text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>|&(#\d+;|#x[0-9a-f]+;|[a-z][a-z0-9]{1,31};)?/gi, (m, ent) => {
      if (m.startsWith('<![CDATA[')) return m;
      if (!ent) return '&amp;';
      if (ent[0] === '#') return m;
      const name = ent.slice(0, -1);
      if (['amp', 'lt', 'gt', 'quot', 'apos'].includes(name)) return m;
      if (!entityCache.has(name)) {
        ta.innerHTML = `&${name};`;
        const v = ta.value;
        entityCache.set(name, v === `&${name};` ? null : v);
      }
      const v = entityCache.get(name);
      return v == null ? `&amp;${name};` : [...v].map((c) => `&#${c.codePointAt(0)};`).join('');
    });
}

function xmlDoc(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const bad = doc.getElementsByTagName('parsererror').length > 0 || !doc.documentElement || doc.documentElement.localName === 'parsererror';
  return bad ? null : doc;
}

/** Last resort for feeds that are not well-formed: the HTML parser, with RSS tags that HTML treats specially renamed. */
function lenientDoc(text) {
  const prepared = text
    .replace(/<\?xml[^>]*\?>/i, '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (m, c) => escapeHtml(c))
    .replace(/<([A-Za-z][\w:.-]*)((?:\s[^<>]*?)?)\/>/g, '<$1$2></$1>')
    .replace(/<(\/?)(link|image|source|title|base|meta|track|embed|param|area|textarea|style|script|template|noscript|iframe|frame|object|input|select|option|head|body|html)(?=[\s>/])/gi, '<$1x-$2');
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${prepared}`, 'text/html');
  return doc;
}

// ---------------------------------------------------------------- feed parsing
export function looksLikeHtml(text, contentType = '') {
  const ct = String(contentType).toLowerCase();
  const head = String(text || '').slice(0, 2048).replace(/^﻿/, '').trimStart().toLowerCase();
  if (/^<\?xml/.test(head) && /<(rss|feed|rdf:rdf)[\s>]/.test(String(text || '').slice(0, 8192).toLowerCase())) return false;
  if (/^<(rss|feed|rdf:rdf)[\s>]/.test(head)) return false;
  return ct.includes('text/html') || ct.includes('xhtml') || /^<!doctype html|^<html[\s>]|^<head[\s>]|^<body[\s>]/.test(head);
}

/** Parse a feed document (string) fetched from `url`. */
export function parseFeed(text, url = '') {
  const src = String(text ?? '').replace(/^﻿/, '');
  const head = src.trimStart();
  if (head.startsWith('{')) return parseJsonFeed(head, url);
  let doc = xmlDoc(src);
  if (!doc && /<(rss|feed|rdf:rdf)[\s>]/i.test(src.slice(0, 20000))) doc = xmlDoc(repairXml(src));
  let lenient = false;
  if (!doc) {
    if (!/<(rss|feed|rdf:rdf)[\s>]/i.test(src.slice(0, 20000))) throw fail(looksLikeHtml(src) ? 'This is a web page, not a feed' : 'Not a feed', looksLikeHtml(src) ? 'ENOTFEED' : 'EPARSE');
    doc = lenientDoc(src);
    lenient = true;
  }
  const root = lenient ? doc.body?.querySelector('rss, feed, rdf\\:rdf') : doc.documentElement;
  if (!root) throw fail('Not a feed', looksLikeHtml(src) ? 'ENOTFEED' : 'EPARSE');
  const rk = key(root);
  let feed;
  if (rk === 'rss' || rk === 'x:rss') feed = parseRss(root, url, lenient);
  else if (rk === 'atom:feed' || rk === 'feed') feed = parseAtom(root, url, lenient);
  else if (rk === 'rdf:rdf') feed = parseRdf(root, url, lenient);
  else if (rk === 'html' || rk === 'xhtml:html') throw fail('This is a web page, not a feed', 'ENOTFEED');
  else throw fail('Not a feed', 'EPARSE');
  if (lenient && !feed.items.some((i) => i.title || i.link)) throw fail('The feed is not readable', 'EPARSE');
  feed.podcast = feed.items.some((i) => i.enclosure) && (feed.items.filter((i) => i.enclosure).length >= Math.max(1, feed.items.length / 3));
  return feed;
}

function enclosureOf(url, type, length, base) {
  const u = resolveUrl(url, base);
  if (!u) return null;
  let t = String(type || '').toLowerCase().split(';')[0].trim();
  if (!t) {
    const ext = (/\.([a-z0-9]{2,4})(?:$|[?#])/i.exec(new URL(u).pathname) || [])[1]?.toLowerCase();
    t = { mp3: 'audio/mpeg', m4a: 'audio/mp4', m4b: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac', wav: 'audio/wav', mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime' }[ext] || '';
  }
  if (!/^(audio|video)\//.test(t)) return null;
  const len = Number(length);
  return { url: u, type: t, length: Number.isFinite(len) && len > 0 ? Math.round(len) : null };
}

function mediaImage(el, base) {
  const thumb = child(el, 'media:thumbnail');
  if (thumb) return resolveUrl(thumb.getAttribute('url'), base);
  for (const c of [...children(el, 'media:content'), ...children(child(el, 'media:group'), 'media:content')]) {
    const t = (c.getAttribute('type') || '').toLowerCase();
    if (c.getAttribute('medium') === 'image' || t.startsWith('image/')) return resolveUrl(c.getAttribute('url'), base);
  }
  const gthumb = child(child(el, 'media:group'), 'media:thumbnail');
  return gthumb ? resolveUrl(gthumb.getAttribute('url'), base) : '';
}
function mediaEnclosure(el, base) {
  for (const c of [...children(el, 'media:content'), ...children(child(el, 'media:group'), 'media:content')]) {
    const enc = enclosureOf(c.getAttribute('url'), c.getAttribute('type') || (/^(audio|video)$/.test(c.getAttribute('medium') || '') ? '' : 'x/none'), c.getAttribute('fileSize'), base);
    if (enc) return { enc, duration: parseDuration(c.getAttribute('duration')) };
  }
  return null;
}
function inlineChapters(el) {
  const list = children(child(el, 'psc:chapters'), 'psc:chapter');
  if (!list.length) return null;
  return list
    .map((c) => ({ start: parseDuration(String(c.getAttribute('start') || '').replace(/\.\d+$/, '')) ?? (/^0?0:00(:00)?/.test(c.getAttribute('start') || '') ? 0 : null), title: clean(c.getAttribute('title'), 200) }))
    .filter((c) => c.start != null && c.title)
    .slice(0, 500);
}

function finishItem(it) {
  it.title = it.title || (it.summary ? it.summary.slice(0, 90) : '');
  return it;
}

function parseRss(root, url, lenient) {
  const ch = child(root, 'channel', 'x:channel') || root;
  const base = baseOf(ch, url);
  const L = lenient ? ['x-link', 'link'] : ['link'];
  const T = lenient ? ['x-title', 'title'] : ['title'];
  const I = lenient ? ['x-image', 'image'] : ['image'];
  let siteUrl = resolveUrl(child(ch, ...L)?.textContent, url);
  if (!siteUrl) {
    const al = children(ch, 'atom:link', 'atom:x-link').find((l) => (l.getAttribute('rel') || 'alternate') === 'alternate');
    siteUrl = resolveUrl(al?.getAttribute('href'), url);
  }
  const img = child(ch, ...I);
  const feed = {
    format: 'rss',
    title: titleText(child(ch, ...T)?.textContent) || '',
    siteUrl,
    description: textOf(child(ch, 'description', 'itunes:summary', 'itunes:subtitle')?.textContent, 1000),
    image: resolveUrl(child(ch, 'itunes:image', 'itunes:x-image')?.getAttribute('href'), base) || resolveUrl(child(img, 'url')?.textContent, base) || mediaImage(ch, base) || resolveUrl(child(ch, 'googleplay:image')?.getAttribute('href'), base),
    author: clean(child(ch, 'itunes:author', 'dc:creator', 'managingeditor', 'googleplay:author')?.textContent, 200),
    language: clean(child(ch, 'language', 'dc:language')?.textContent, 20),
    ttl: intOf(child(ch, 'ttl')?.textContent),
    items: [],
  };
  const itemEls = children(ch, 'item', 'x:item');
  // RSS 0.9x / odd feeds put items next to the channel
  if (!itemEls.length) itemEls.push(...children(root, 'item'));
  for (const el of itemEls.slice(0, 2000)) {
    const ib = baseOf(el, siteUrl || url);
    const guidEl = child(el, 'guid');
    const guid = clean(guidEl?.textContent, 500);
    let link = resolveUrl(child(el, ...L)?.textContent, ib);
    if (!link) {
      const al = children(el, 'atom:link', 'atom:x-link').find((l) => (l.getAttribute('rel') || 'alternate') === 'alternate');
      link = resolveUrl(al?.getAttribute('href'), ib);
    }
    if (!link && guid && guidEl.getAttribute('isPermaLink') !== 'false') link = resolveUrl(guid, ib);
    const content = child(el, 'content:encoded');
    const desc = child(el, 'description');
    const html = htmlOfRss(content) || htmlOfRss(desc) || htmlOfRss(child(el, 'itunes:summary'));
    const summarySrc = htmlOfRss(desc) || html || child(el, 'itunes:subtitle')?.textContent || '';
    const encEl = child(el, 'enclosure');
    let enclosure = encEl ? enclosureOf(encEl.getAttribute('url'), encEl.getAttribute('type'), encEl.getAttribute('length'), ib) : null;
    let duration = parseDuration(child(el, 'itunes:duration')?.textContent);
    if (!enclosure) {
      const me = mediaEnclosure(el, ib);
      if (me) {
        enclosure = me.enc;
        duration ??= me.duration;
      }
    }
    if (!enclosure) {
      const al = children(el, 'atom:link', 'atom:x-link').find((l) => l.getAttribute('rel') === 'enclosure');
      if (al) enclosure = enclosureOf(al.getAttribute('href'), al.getAttribute('type'), al.getAttribute('length'), ib);
    }
    feed.items.push(
      finishItem({
        guid,
        title: titleText(child(el, ...T)?.textContent),
        link,
        date: parseDate(child(el, 'pubdate', 'dc:date', 'dcterms:issued', 'dcterms:created', 'atom:updated', 'atom:published', 'published', 'updated')?.textContent),
        author: clean(child(el, 'dc:creator', 'author', 'itunes:author')?.textContent, 200),
        html,
        summary: textOf(summarySrc, 300),
        image: resolveUrl(child(el, 'itunes:image', 'itunes:x-image')?.getAttribute('href'), ib) || mediaImage(el, ib),
        enclosure,
        duration,
        episode: intOf(child(el, 'itunes:episode', 'podcast:episode')?.textContent),
        season: intOf(child(el, 'itunes:season', 'podcast:season')?.textContent),
        chapters: resolveUrl(child(el, 'podcast:chapters')?.getAttribute('url'), ib) || null,
        inlineChapters: inlineChapters(el),
      }),
    );
  }
  return feed;
}

function atomLink(el, rel, base, preferType = 'text/html') {
  const links = children(el, 'atom:link', 'link', 'atom:x-link', 'x-link').filter((l) => (l.getAttribute('rel') || 'alternate') === rel);
  const best = links.find((l) => (l.getAttribute('type') || preferType) === preferType) || links[0];
  return best ? resolveUrl(best.getAttribute('href'), baseOf(best, base)) : '';
}

function parseAtom(root, url, lenient) {
  const base = baseOf(root, url);
  const A = (n) => [`atom:${n}`, n, `x-${n}`, `atom:x-${n}`];
  const author = (el) => clean(child(child(el, ...A('author')), ...A('name'))?.textContent, 200);
  const feed = {
    format: 'atom',
    title: textOfAtom(child(root, ...A('title'))),
    siteUrl: atomLink(root, 'alternate', base),
    description: textOfAtom(child(root, ...A('subtitle'))),
    image: resolveUrl(child(root, ...A('logo'))?.textContent, base) || resolveUrl(child(root, 'itunes:image', 'itunes:x-image')?.getAttribute('href'), base) || resolveUrl(child(root, ...A('icon'))?.textContent, base),
    author: author(root),
    language: clean(root.getAttributeNS?.(XML_NS, 'lang') || root.getAttribute('xml:lang'), 20),
    ttl: null,
    items: [],
  };
  for (const el of children(root, ...A('entry')).slice(0, 2000)) {
    const eb = baseOf(el, base);
    const content = child(el, ...A('content'));
    const summary = child(el, ...A('summary'));
    let html = '';
    if (content && !content.getAttribute('src')) html = htmlOfAtom(content);
    if (!html && summary) html = htmlOfAtom(summary);
    const encLink = children(el, ...A('link')).find((l) => l.getAttribute('rel') === 'enclosure');
    let enclosure = encLink ? enclosureOf(encLink.getAttribute('href'), encLink.getAttribute('type'), encLink.getAttribute('length'), baseOf(encLink, eb)) : null;
    let duration = parseDuration(child(el, 'itunes:duration')?.textContent);
    if (!enclosure) {
      const me = mediaEnclosure(el, eb);
      if (me) {
        enclosure = me.enc;
        duration ??= me.duration;
      }
    }
    feed.items.push(
      finishItem({
        guid: clean(child(el, ...A('id'))?.textContent, 500),
        title: textOfAtom(child(el, ...A('title'))),
        link: atomLink(el, 'alternate', eb) || (content?.getAttribute('src') ? resolveUrl(content.getAttribute('src'), eb) : ''),
        date: parseDate(child(el, ...A('published'), ...A('issued'))?.textContent) ?? parseDate(child(el, ...A('updated'), ...A('modified'))?.textContent),
        author: author(el) || feed.author,
        html,
        summary: textOf(summary ? htmlOfAtom(summary) : html, 300),
        image: resolveUrl(child(el, 'itunes:image', 'itunes:x-image')?.getAttribute('href'), eb) || mediaImage(el, eb),
        enclosure,
        duration,
        episode: intOf(child(el, 'itunes:episode')?.textContent),
        season: intOf(child(el, 'itunes:season')?.textContent),
        chapters: resolveUrl(child(el, 'podcast:chapters')?.getAttribute('url'), eb) || null,
        inlineChapters: inlineChapters(el),
      }),
    );
  }
  return feed;
}

function parseRdf(root, url, lenient) {
  const ch = child(root, 'channel', 'x:channel');
  const L = lenient ? ['x-link', 'link'] : ['link'];
  const T = lenient ? ['x-title', 'title'] : ['title'];
  const I = lenient ? ['x-image', 'image'] : ['image'];
  const siteUrl = resolveUrl(child(ch, ...L)?.textContent, url);
  const img = child(root, ...I) || child(ch, ...I);
  const feed = {
    format: 'rdf',
    title: titleText(child(ch, ...T)?.textContent),
    siteUrl,
    description: textOf(child(ch, 'description')?.textContent, 1000),
    image: resolveUrl(child(img, 'url')?.textContent || img?.getAttributeNS('http://www.w3.org/1999/02/22-rdf-syntax-ns#', 'resource'), url),
    author: clean(child(ch, 'dc:creator', 'dc:publisher')?.textContent, 200),
    language: clean(child(ch, 'dc:language')?.textContent, 20),
    ttl: null,
    items: [],
  };
  for (const el of children(root, 'item', 'x:item').slice(0, 2000)) {
    const link = resolveUrl(child(el, ...L)?.textContent, siteUrl || url);
    const content = child(el, 'content:encoded');
    const desc = child(el, 'description');
    const html = htmlOfRss(content) || htmlOfRss(desc);
    feed.items.push(
      finishItem({
        guid: clean(el.getAttributeNS('http://www.w3.org/1999/02/22-rdf-syntax-ns#', 'about') || el.getAttribute('rdf:about') || link, 500),
        title: titleText(child(el, ...T)?.textContent),
        link,
        date: parseDate(child(el, 'dc:date', 'dcterms:issued', 'pubdate')?.textContent),
        author: clean(child(el, 'dc:creator')?.textContent, 200),
        html,
        summary: textOf(htmlOfRss(desc) || html, 300),
        image: mediaImage(el, link || url),
        enclosure: null,
        duration: null,
        episode: null,
        season: null,
        chapters: null,
        inlineChapters: null,
      }),
    );
  }
  return feed;
}

function parseJsonFeed(text, url) {
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw fail('The feed is not readable', 'EPARSE');
  }
  if (!j || typeof j !== 'object' || !/jsonfeed\.org\/version/.test(String(j.version || '')) || !Array.isArray(j.items)) throw fail('Not a feed', 'EPARSE');
  const str = (v, n) => (typeof v === 'string' ? clean(v, n) : '');
  const base = resolveUrl(j.home_page_url, url) || url;
  const feed = {
    format: 'json',
    title: str(j.title, 300),
    siteUrl: resolveUrl(j.home_page_url, url),
    description: str(j.description, 1000),
    image: resolveUrl(j.icon, url) || resolveUrl(j.favicon, url),
    author: str(j.author?.name || j.authors?.[0]?.name, 200),
    language: str(j.language, 20),
    ttl: null,
    items: [],
  };
  for (const it of j.items.slice(0, 2000)) {
    if (!it || typeof it !== 'object') continue;
    const att = (Array.isArray(it.attachments) ? it.attachments : []).map((a) => ({ enc: enclosureOf(a?.url, a?.mime_type, a?.size_in_bytes, base), dur: parseDuration(a?.duration_in_seconds) })).find((a) => a.enc);
    const html = typeof it.content_html === 'string' ? it.content_html : typeof it.content_text === 'string' ? escapeHtml(it.content_text).replace(/\n/g, '<br>') : '';
    feed.items.push(
      finishItem({
        guid: str(String(it.id ?? ''), 500),
        title: str(it.title, 500),
        link: resolveUrl(it.url, base) || resolveUrl(it.external_url, base),
        date: parseDate(it.date_published) ?? parseDate(it.date_modified),
        author: str(it.author?.name || it.authors?.[0]?.name, 200) || feed.author,
        html,
        summary: str(it.summary, 300) || textOf(html, 300),
        image: resolveUrl(it.image, base) || resolveUrl(it.banner_image, base),
        enclosure: att?.enc || null,
        duration: att?.dur ?? null,
        episode: null,
        season: null,
        chapters: null,
        inlineChapters: null,
      }),
    );
  }
  return feed;
}

// ---------------------------------------------------------------- autodiscovery
const FEED_TYPES = ['application/rss+xml', 'application/atom+xml', 'application/rdf+xml', 'application/feed+json', 'application/x.atom+xml', 'application/x-atom+xml', 'application/x-rss+xml', 'text/xml', 'application/xml'];

function pageBase(doc, pageUrl) {
  const b = doc.querySelector('base[href]')?.getAttribute('href');
  return b ? resolveUrl(b, pageUrl) || pageUrl : pageUrl;
}

/** Feeds announced by a web page (<link rel="alternate" type="application/rss+xml" href="…">), main feed first. */
export function discover(html, pageUrl) {
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  const base = pageBase(doc, pageUrl);
  const out = [];
  const seen = new Set();
  for (const l of doc.querySelectorAll('link[href]')) {
    const rel = (l.getAttribute('rel') || '').toLowerCase().split(/\s+/);
    const type = (l.getAttribute('type') || '').toLowerCase().split(';')[0].trim();
    if (!rel.includes('alternate') || rel.includes('stylesheet') || !FEED_TYPES.includes(type)) continue;
    if ((type === 'text/xml' || type === 'application/xml') && !/rss|atom|feed/i.test(`${l.getAttribute('title') || ''} ${l.getAttribute('href')}`)) continue;
    const url = resolveUrl(l.getAttribute('href'), base);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, title: clean(l.getAttribute('title'), 200), type });
  }
  // comment feeds (WordPress "Comments Feed") after the main ones
  const isComments = (f) => /comment/i.test(`${f.title} ${f.url}`);
  return [...out.filter((f) => !isComments(f)), ...out.filter(isComments)];
}

/** Links on the page that look like a feed of the same site (for pages without <link rel="alternate">). */
export function guessFeedLinks(html, pageUrl) {
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  const base = pageBase(doc, pageUrl);
  let host = '';
  try {
    host = new URL(pageUrl).host;
  } catch {}
  const out = [];
  for (const a of doc.querySelectorAll('a[href]')) {
    const url = resolveUrl(a.getAttribute('href'), base);
    if (!url || out.includes(url)) continue;
    let u;
    try {
      u = new URL(url);
    } catch {
      continue;
    }
    if (u.host !== host) continue;
    if (/(^|[/._-])(rss|atom|feed)([/._-]|$)|\.(rss|atom|xml)$/i.test(u.pathname) || /^(rss|atom|feed)$/i.test(clean(a.textContent, 20))) out.push(url);
    if (out.length >= 3) break;
  }
  return out;
}

/** The usual feed addresses of a site, tried when a page announces none. */
export function commonFeedPaths(pageUrl) {
  let u;
  try {
    u = new URL(pageUrl);
  } catch {
    return [];
  }
  return ['/feed', '/rss.xml', '/feed.xml', '/atom.xml', '/index.xml'].map((p) => new URL(p, u.origin).href).filter((x) => x !== u.href);
}

// ---------------------------------------------------------------- chapters (Podcasting 2.0 JSON)
export function parseChapters(text) {
  let j;
  try {
    j = JSON.parse(String(text || ''));
  } catch {
    return [];
  }
  const list = Array.isArray(j?.chapters) ? j.chapters : [];
  return list
    .filter((c) => c && c.toc !== false && Number.isFinite(Number(c.startTime)) && typeof c.title === 'string' && c.title.trim())
    .map((c) => ({ start: Math.max(0, Number(c.startTime)), title: clean(c.title, 200), url: resolveUrl(c.url, '') || null }))
    .sort((a, b) => a.start - b.start)
    .slice(0, 500);
}

// ---------------------------------------------------------------- OPML
/** Subscriptions of an OPML file: [{ url, title, siteUrl, folder }] (nested folders are named "A / B"). */
export function parseOpml(text) {
  let doc = xmlDoc(String(text || '').replace(/^﻿/, ''));
  if (!doc) doc = xmlDoc(repairXml(String(text || '')));
  if (!doc || doc.documentElement.localName.toLowerCase() !== 'opml') {
    const e = fail('Not an OPML file', 'EPARSE');
    throw e;
  }
  const body = [...doc.documentElement.children].find((c) => c.localName.toLowerCase() === 'body');
  const out = [];
  const seen = new Set();
  const walk = (el, folder, depth) => {
    if (depth > 8) return;
    for (const o of [...el.children].filter((c) => c.localName.toLowerCase() === 'outline')) {
      const xmlUrl = o.getAttribute('xmlUrl') || o.getAttribute('xmlurl') || o.getAttribute('url');
      const name = clean(o.getAttribute('title') || o.getAttribute('text'), 200);
      const url = resolveUrl(xmlUrl, '');
      if (url && (!o.getAttribute('type') || /rss|atom|feed|xml|podcast/i.test(o.getAttribute('type')) || xmlUrl)) {
        if (!seen.has(url)) {
          seen.add(url);
          out.push({ url, title: name, siteUrl: resolveUrl(o.getAttribute('htmlUrl') || o.getAttribute('htmlurl'), ''), folder: folder || '' });
        }
      } else if (o.children.length) walk(o, [folder, name].filter(Boolean).join(' / ').slice(0, 120), depth + 1);
    }
  };
  if (body) walk(body, '', 0);
  return out.slice(0, 5000);
}

/** OPML 2.0 for a list of { url, title, siteUrl, folder }: feeds in folders become nested outlines. */
export function buildOpml(feeds, title = 'Podcasts & News', date = new Date()) {
  const a = (s) => escapeHtml(String(s ?? '')).replace(/\n/g, '&#10;');
  const line = (f, pad) => `${pad}<outline type="rss" text="${a(f.title || f.url)}" title="${a(f.title || f.url)}" xmlUrl="${a(f.url)}"${f.siteUrl ? ` htmlUrl="${a(f.siteUrl)}"` : ''}/>`;
  const loose = feeds.filter((f) => !f.folder);
  const folders = [...new Set(feeds.filter((f) => f.folder).map((f) => f.folder))].sort((x, y) => x.localeCompare(y));
  const body = [
    ...folders.map((name) => [`    <outline text="${a(name)}" title="${a(name)}">`, ...feeds.filter((f) => f.folder === name).map((f) => line(f, '      ')), '    </outline>'].join('\n')),
    ...loose.map((f) => line(f, '    ')),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n  <head>\n    <title>${a(title)}</title>\n    <dateCreated>${date.toUTCString()}</dateCreated>\n  </head>\n  <body>\n${body.join('\n')}\n  </body>\n</opml>\n`;
}
