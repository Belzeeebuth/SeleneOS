// Livres — one open book on the renderer side: chapters turned into safe documents for the reading frame.
//
// Book content is untrusted HTML. Every chapter (spine item) goes through:
//   1. books:resource -> bytes -> text (declared encoding) -> DOMParser (XHTML first, HTML when the XML is
//      broken). DOMParser documents are inert: nothing loads or runs while we work on them.
//   2. Import into an inert HTML document and clean it (sanitize): no script, noscript, iframe / frame,
//      object / embed / applet, form and form controls, base / meta / link / title, SVG set / animate on
//      links, event-handler attributes (on*), srcdoc, target, ping, contenteditable, javascript: / vbscript:
//      values, and no data-books-* attribute coming from the book (those are ours).
//   3. renderChapter() rewrites the resources: images / audio / video -> blob: URLs, fonts -> data: URLs (the
//      shell's own policy, which a srcdoc frame inherits, allows data: fonts only), style sheets inlined with
//      their url() and @import rewritten; anything outside the book (http, https, file, blob, …) is dropped.
//   4. Links keep their target in data-books-href / data-books-frag (inside the book) or data-books-url
//      (http, https, mailto) and get an inert href="#"; the reader handles every click.
//   5. The srcdoc carries a Content-Security-Policy meta (no remote load of any kind, no script) and goes into
//      <iframe sandbox="allow-same-origin"> (no allow-scripts: nothing in the book ever runs; same origin only
//      so the reader can measure, paginate and listen to clicks from outside).
export const CSP = "default-src 'none'; img-src blob: data:; style-src 'unsafe-inline' blob:; font-src blob: data:; media-src blob:; form-action 'none'; base-uri 'none'";
const XHTML_NS = 'http://www.w3.org/1999/xhtml';
const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';

const DROP = new Set([
  'script', 'noscript', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'form', 'input', 'button', 'select',
  'textarea', 'option', 'optgroup', 'datalist', 'output', 'keygen', 'base', 'meta', 'link', 'style', 'title', 'portal',
  'fencedframe', 'template', 'slot', 'dialog', 'param', 'noembed', 'noframes', 'isindex', 'handler', 'listener',
]);
const DROP_ATTRS = new Set(['srcdoc', 'formaction', 'action', 'ping', 'http-equiv', 'autofocus', 'contenteditable', 'target', 'background', 'dynsrc', 'lowsrc', 'manifest', 'codebase', 'classid', 'archive', 'longdesc', 'xml:base', 'is', 'nonce', 'integrity', 'crossorigin', 'srcset', 'sizes', 'imagesrcset', 'attributionsrc']);
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const XML_ENTITIES = new Set(['amp', 'lt', 'gt', 'quot', 'apos']);
const FONT_MAX = 8 * 1024 * 1024; // larger embedded fonts are skipped (the reader falls back to its own fonts)
const CHAPTER_MAX = 20 * 1024 * 1024; // a larger chapter document is shown as a damaged part (keeps the reader responsive)

const badScheme = (v) => /^(?:javascript|vbscript|livescript|data|file|blob|filesystem|about|chrome|app|media):/i.test(String(v).replace(/[\u0000- \u007f- ]/g, ''));

/** Resolve a URL reference found in the book file `base` -> { path, frag } inside the book, or null. */
export function resolveRef(base, ref) {
  ref = String(ref ?? '').trim();
  if (!ref) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref.replace(/[\u0000- ]/g, '')) || ref.startsWith('//')) return null;
  let u;
  try {
    u = new URL(ref, `https://book.invalid/${String(base || '').split('/').map(encodeURIComponent).join('/')}`);
  } catch {
    return null;
  }
  if (u.host !== 'book.invalid') return null;
  let p = u.pathname.slice(1);
  let frag = u.hash.slice(1);
  try {
    p = decodeURIComponent(p);
  } catch {}
  try {
    frag = decodeURIComponent(frag);
  } catch {}
  return p ? { path: p, frag } : null;
}

/** External link target we accept (http, https, mailto) or null. */
export function externalUrl(ref) {
  const raw = String(ref ?? '').trim();
  const probe = raw.replace(/[\u0000- ]/g, '').toLowerCase();
  if (!/^(https?:|mailto:|\/\/)/.test(probe)) return null;
  try {
    const u = new URL(probe.startsWith('//') ? `https:${raw}` : raw);
    return ['http:', 'https:', 'mailto:'].includes(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

let entityBox = null;
const entityCache = new Map();
/** Named HTML entities (&eacute; &nbsp;…) -> numeric references, so the XML parser accepts the chapter. */
function numericEntities(text) {
  return text.replace(/&([a-zA-Z][a-zA-Z0-9]{1,31});/g, (m, name) => {
    if (XML_ENTITIES.has(name)) return m;
    if (entityCache.has(name)) return entityCache.get(name);
    entityBox ||= document.createElement('textarea');
    entityBox.innerHTML = m; // RCDATA: decodes the reference, nothing else
    const v = entityBox.value;
    const out = !v || v === m ? m : [...v].map((c) => `&#${c.codePointAt(0)};`).join('');
    if (entityCache.size < 500) entityCache.set(name, out);
    return out;
  });
}

function decodeText(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));
  const head = new TextDecoder('latin1').decode(b.subarray(0, 1024));
  const enc = /^\s*<\?xml[^>]*encoding\s*=\s*["']([A-Za-z0-9._-]+)["']/.exec(head)?.[1] || /<meta[^>]+charset\s*=\s*["']?([A-Za-z0-9._-]+)/i.exec(head)?.[1];
  if (enc && !/^utf-?8$/i.test(enc)) {
    try {
      return new TextDecoder(enc).decode(b);
    } catch {}
  }
  return new TextDecoder('utf-8').decode(b);
}

async function replaceAsync(str, re, fn) {
  const jobs = [];
  str.replace(re, (...args) => {
    jobs.push(fn(...args));
    return '';
  });
  if (!jobs.length) return str;
  const vals = await Promise.all(jobs);
  let i = 0;
  return str.replace(re, () => vals[i++]);
}

const URL_RE = /url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)'"\s]*))\s*\)/gi;

/** Clean an inert document in place (step 2). */
export function sanitize(root) {
  for (const el of [...root.querySelectorAll('*')]) {
    if (!el.isConnected && el !== root) continue;
    const tag = el.localName.toLowerCase();
    if (DROP.has(tag)) {
      el.remove();
      continue;
    }
    if ((tag === 'set' || tag.startsWith('animate')) && /href|xlink/i.test(el.getAttribute('attributeName') || '')) {
      el.remove();
      continue;
    }
    for (const a of [...el.attributes]) {
      const n = a.name.toLowerCase();
      const local = a.localName.toLowerCase();
      if (local.startsWith('on') || n.startsWith('on') || n.startsWith('data-books') || DROP_ATTRS.has(n) || DROP_ATTRS.has(local)) el.removeAttributeNode(a);
      else if (/javascript:|vbscript:/i.test(a.value.replace(/[\u0000- \u007f- ]/g, ''))) el.removeAttributeNode(a);
    }
  }
}

const BLOCKS = 'p, div, h1, h2, h3, h4, h5, h6, li, dt, dd, blockquote, pre, section, article, aside, header, footer, nav, figure, figcaption, table, tr, td, th, caption, ul, ol, dl, address, main, details, summary';
/**
 * Text of a chapter as a reader sees it, for search and excerpts: the text nodes in order, with a space where
 * one block ends and another begins. -> { text, nodes: [{ node, at }] } (at = index of the node's text in text).
 * The reader runs it on the live page and on the parsed chapter: same markup, same text, same match numbers.
 */
export function textMap(root) {
  const out = { text: '', nodes: [] };
  if (!root) return out;
  const w = root.ownerDocument.createTreeWalker(root, 4); // NodeFilter.SHOW_TEXT
  let last = null;
  while (w.nextNode()) {
    const n = w.currentNode;
    const block = n.parentElement?.closest(BLOCKS) || root;
    if (last && block !== last && out.text && !/\s$/.test(out.text) && !/^\s/.test(n.data)) out.text += ' ';
    last = block;
    out.nodes.push({ node: n, at: out.text.length });
    out.text += n.data;
  }
  return out;
}

export class BookSession {
  constructor(api, book) {
    this.api = api;
    this.book = book;
    this.path = book.path;
    this.blobs = new Map(); // path -> Promise<string|null>
    this.datas = new Map(); // path -> Promise<string|null>
    this.cssFiles = new Map(); // path -> Promise<string>
    this.parsed = new Map(); // spine index -> Promise<Parsed>
    this.texts = new Map(); // spine index -> text (search: kept for the whole session, text is small)
    this.urls = [];
    this.closed = false;
    this.spineIndex = new Map();
    book.spine.forEach((s, i) => {
      if (!this.spineIndex.has(s.href)) this.spineIndex.set(s.href, i);
      if (!this.spineIndex.has(s.href.toLowerCase())) this.spineIndex.set(s.href.toLowerCase(), i);
    });
  }

  indexOf(p) {
    if (!p) return -1;
    return this.spineIndex.get(p) ?? this.spineIndex.get(p.toLowerCase()) ?? -1;
  }

  resource(p) {
    return this.api.invoke('books:resource', this.path, p);
  }

  /** blob: URL for an image / audio / video of the book (null when missing or not a media file). */
  blobUrl(p) {
    if (!p) return Promise.resolve(null);
    if (!this.blobs.has(p)) {
      this.blobs.set(
        p,
        this.resource(p)
          .then(({ data, mime }) => {
            if (this.closed || !/^(image|audio|video)\//i.test(mime || '')) return null;
            const url = URL.createObjectURL(new Blob([data], { type: mime }));
            this.urls.push(url);
            return url;
          })
          .catch(() => null),
      );
    }
    return this.blobs.get(p);
  }

  /** data: URL for an embedded font. */
  dataUrl(p) {
    if (!p) return Promise.resolve(null);
    if (!this.datas.has(p)) {
      this.datas.set(
        p,
        this.resource(p)
          .then(({ data, mime }) => {
            if (data.length > FONT_MAX) return null;
            const type = /font|opentype|truetype|woff|octet-stream/i.test(mime || '') ? (/^font\//.test(mime) ? mime : 'font/ttf') : null;
            if (!type) return null;
            return new Promise((resolve) => {
              const fr = new FileReader();
              fr.onload = () => resolve(typeof fr.result === 'string' ? fr.result : null);
              fr.onerror = () => resolve(null);
              fr.readAsDataURL(new Blob([data], { type }));
            });
          })
          .catch(() => null),
      );
    }
    return this.datas.get(p);
  }

  // ---------------------------------------------------------------- CSS
  async cssUrl(raw, base, font) {
    const u = raw.replace(/\\(.)/g, '$1').trim();
    if (/^data:/i.test(u)) return /^data:(image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml)|font\/|application\/(font|x-font|vnd\.ms-opentype))/i.test(u) ? `url("${u.replace(/"/g, '%22')}")` : 'none';
    const r = resolveRef(base, u);
    if (!r) return 'none';
    const url = font ? await this.dataUrl(r.path) : await this.blobUrl(r.path);
    return url ? `url("${url}")` : 'none';
  }

  /** Rewrite a style sheet found in `base` (step 3). */
  async css(text, base, depth = 0) {
    text = String(text || '');
    if (text.length > 2000000) text = text.slice(0, 2000000);
    text = text.replace(/\/\*[\s\S]*?\*\//g, '');
    // @namespace names a namespace, it loads nothing: its url() becomes a string so the rewriting below keeps it
    text = text.replace(/@namespace\s+([\w-]+\s+)?url\(\s*(['"]?)([^'")]*)\2\s*\)/gi, (m, prefix, q, uri) => `@namespace ${prefix || ''}"${uri.replace(/"/g, '%22')}"`);
    // chapters are shown as HTML, where epub:type is a plain attribute: [epub|type…] -> [epub\:type…]
    text = text.replace(/\[\s*epub\|/gi, '[epub\\:');
    // @import: inline the book's own style sheets, drop the rest
    text = await replaceAsync(text, /@import\s+(?:url\(\s*(['"]?)([^'")]*?)\1\s*\)|(['"])([^'"]*?)\3)\s*([^;{}]*);?/gi, async (m, q1, u1, q2, u2, media) => {
      const r = resolveRef(base, u1 ?? u2 ?? '');
      if (!r || depth >= 3) return '';
      const inner = await this.cssFile(r.path, depth + 1);
      return media && media.trim() ? `@media ${media.trim()} {\n${inner}\n}` : inner;
    });
    text = text
      .replace(/expression\s*\(/gi, 'x(')
      .replace(/(java|vb)script\s*:/gi, 'x:')
      .replace(/-moz-binding/gi, 'x')
      .replace(/behavior\s*:/gi, 'x:')
      // image-set("a.png" 1x) loads pictures without url(): keep its first url(), else nothing
      .replace(/(?:-webkit-)?image-set\s*\(((?:[^()]|\([^()]*\))*)\)/gi, (m, inner) => /url\(/i.exec(inner) ? inner.slice(inner.search(/url\(/i)).replace(/\).*$/s, ')') : 'none');
    // @font-face blocks: fonts as data: URLs; everything else: blob: URLs
    const segs = [];
    let last = 0;
    for (const m of text.matchAll(/@font-face\s*\{[^}]*\}/gi)) {
      segs.push([text.slice(last, m.index), false], [m[0], true]);
      last = m.index + m[0].length;
    }
    segs.push([text.slice(last), false]);
    const out = await Promise.all(segs.map(([s, font]) => replaceAsync(s, URL_RE, (m, a, b, c) => this.cssUrl(a ?? b ?? c ?? '', base, font))));
    return out.join('');
  }

  cssFile(p, depth = 0) {
    if (!this.cssFiles.has(p)) {
      this.cssFiles.set(
        p,
        this.resource(p)
          .then(({ data }) => this.css(decodeText(data), p, depth))
          .catch(() => ''),
      );
    }
    return this.cssFiles.get(p);
  }

  // ---------------------------------------------------------------- chapters
  /** Parsed and cleaned chapter (no resources yet): { doc, styles, lang, dir, text }. Cached. */
  parse(i) {
    if (!this.parsed.has(i)) {
      const p = this.parseUncached(i);
      this.parsed.set(i, p);
      p.catch(() => this.parsed.get(i) === p && this.parsed.delete(i));
      // keep the memory bounded on long books: the 12 most recent chapters
      if (this.parsed.size > 12) this.parsed.delete(this.parsed.keys().next().value);
    }
    return this.parsed.get(i);
  }

  async parseUncached(i) {
    const item = this.book.spine[i];
    if (!item) throw Object.assign(new Error('No such chapter'), { code: 'ENOENT' });
    const out = document.implementation.createHTMLDocument('');
    const styles = [];
    let lang = this.book.language || '';
    let dir = '';
    const type = (item.mediaType || '').toLowerCase();
    if (/^image\//.test(type) && !type.includes('svg')) {
      // an image as a page of the book
      const img = out.createElement('img');
      img.setAttribute('src', item.href.split('/').pop());
      img.setAttribute('alt', '');
      img.className = 'books-image-page';
      out.body.appendChild(img);
      return { doc: out, styles, lang, dir, text: '', base: item.href };
    }
    const { data } = await this.resource(item.href);
    if (data.length > CHAPTER_MAX) throw Object.assign(new Error('Chapter too large'), { code: 'ETOOBIG' });
    const raw = decodeText(data);
    let src = null;
    const svg = type.includes('svg') || /\.svg$/i.test(item.href);
    if (svg || /xml|xhtml/.test(type) || /\.(xhtml|xht|xml)$/i.test(item.href)) {
      src = new DOMParser().parseFromString(numericEntities(raw), svg ? 'image/svg+xml' : 'application/xhtml+xml');
      const root = src.documentElement;
      if (src.getElementsByTagName('parsererror').length || !root || root.namespaceURI !== (svg ? SVG_NS : XHTML_NS)) src = null;
    }
    if (!src) {
      // broken XML: the HTML parser, with <tag/> of non-void elements closed first
      const html = raw.replace(/<([a-zA-Z][\w:-]*)((?:\s+[^<>]*?)?)\s*\/>/g, (m, tag, attrs) => (VOID.has(tag.toLowerCase()) ? m : `<${tag}${attrs}></${tag}>`));
      src = new DOMParser().parseFromString(html, 'text/html');
    }
    const root = src.documentElement;
    // style sheets, in document order
    for (const el of src.querySelectorAll('style, link')) {
      const tag = el.localName.toLowerCase();
      const media = (el.getAttribute('media') || '').trim();
      if (tag === 'style') styles.push({ text: el.textContent || '', media });
      else if (/\bstylesheet\b/i.test(el.getAttribute('rel') || '') && !/\balternate\b/i.test(el.getAttribute('rel') || '')) {
        const r = resolveRef(item.href, el.getAttribute('href') || '');
        if (r) styles.push({ href: r.path, media });
      }
    }
    lang = root.getAttribute('lang') || root.getAttributeNS(XML_NS, 'lang') || root.getAttribute('xml:lang') || lang;
    dir = root.getAttribute('dir') || '';
    const htmlClass = root.getAttribute('class') || '';
    if (svg) {
      out.body.appendChild(out.importNode(root, true));
    } else {
      const body = src.body || src.getElementsByTagName('body')[0] || root;
      for (const child of [...body.childNodes]) out.body.appendChild(out.importNode(child, true));
      if (body !== root) {
        for (const a of [...body.attributes]) {
          const n = a.name.toLowerCase();
          if (['class', 'id', 'dir', 'lang', 'style', 'epub:type', 'xml:lang', 'role'].includes(n)) out.body.setAttribute(n === 'xml:lang' ? 'lang' : n, a.value);
        }
        if (!lang) lang = body.getAttribute('lang') || body.getAttributeNS(XML_NS, 'lang') || '';
        if (!dir) dir = body.getAttribute('dir') || '';
      }
    }
    if (htmlClass) out.documentElement.setAttribute('class', htmlClass);
    sanitize(out.documentElement);
    return { doc: out, styles, lang: lang.slice(0, 35), dir: /^(ltr|rtl|auto)$/i.test(dir) ? dir.toLowerCase() : '', text: textMap(out.body).text, base: item.href };
  }

  /** Rewrite links and resources of a (cloned) cleaned document found in `base` (steps 3 and 4). */
  async rewrite(doc, base) {
    const jobs = [];
    const all = [doc.body, ...doc.body.querySelectorAll('*')];
    for (const el of all) {
      const tag = el.localName.toLowerCase();
      if (tag === 'a' || tag === 'area') {
        const raw = el.getAttribute('href') ?? el.getAttributeNS(XLINK_NS, 'href');
        el.removeAttribute('href');
        el.removeAttributeNS(XLINK_NS, 'href');
        if (raw != null) {
          const ext = externalUrl(raw);
          const r = ext ? null : resolveRef(base, raw);
          if (ext) el.setAttribute('data-books-url', ext);
          else if (r) {
            el.setAttribute('data-books-href', r.path);
            if (r.frag) el.setAttribute('data-books-frag', r.frag);
          }
          if (ext || r) el.setAttribute('href', '#');
        }
      } else {
        for (const name of ['src', 'poster']) {
          if (!el.hasAttribute(name)) continue;
          const v = el.getAttribute(name);
          const r = badScheme(v) ? null : resolveRef(base, v);
          el.removeAttribute(name);
          if (r) jobs.push(this.blobUrl(r.path).then((u) => u && el.setAttribute(name, u)));
        }
        const href = el.getAttribute('href') ?? el.getAttributeNS(XLINK_NS, 'href');
        if (href != null) {
          const xlink = el.hasAttributeNS(XLINK_NS, 'href');
          el.removeAttribute('href');
          el.removeAttributeNS(XLINK_NS, 'href');
          const keep = href.trim().startsWith('#') && !/[()\s]/.test(href.trim()); // same-document SVG reference
          const set = (u) => (xlink ? el.setAttributeNS(XLINK_NS, 'xlink:href', u) : el.setAttribute('href', u));
          if (keep) set(href.trim());
          else if (tag === 'image' || tag === 'feimage') {
            const r = badScheme(href) ? null : resolveRef(base, href);
            if (r) jobs.push(this.blobUrl(r.path).then((u) => u && set(u)));
          }
        }
        el.removeAttribute('data');
        if (tag === 'video' || tag === 'audio') {
          el.removeAttribute('autoplay');
          el.setAttribute('controls', '');
          el.setAttribute('preload', 'metadata');
        }
      }
      const style = el.getAttribute('style');
      if (style && /url\(|image-set|@import|expression|binding|behavior/i.test(style)) jobs.push(this.css(style, base).then((t) => el.setAttribute('style', t)));
    }
    await Promise.all(jobs);
  }

  /** The full srcdoc of chapter i: { srcdoc, lang, dir }. `userCss` is the reader's own style sheet. */
  async render(i, userCss = '', baseCss = '') {
    const p = await this.parse(i);
    const doc = p.doc.cloneNode(true);
    await this.rewrite(doc, p.base);
    const sheets = await Promise.all(
      p.styles.map(async (s) => {
        const t = s.href ? await this.cssFile(s.href) : await this.css(s.text, p.base);
        return s.media && !/^all$/i.test(s.media) ? `@media ${s.media.replace(/[{}<>]/g, '')} {\n${t}\n}` : t;
      }),
    );
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    const style = (t, tag) => `<style${tag ? ` data-books="${tag}"` : ''}>${String(t).replace(/<\/(style)/gi, '<\\/$1')}</style>`;
    const htmlAttrs = [p.lang && ` lang="${esc(p.lang)}"`, p.dir && ` dir="${esc(p.dir)}"`, doc.documentElement.getAttribute('class') && ` class="${esc(doc.documentElement.getAttribute('class'))}"`].filter(Boolean).join('');
    const srcdoc =
      `<!DOCTYPE html><html${htmlAttrs}><head><meta charset="utf-8">` +
      `<meta http-equiv="Content-Security-Policy" content="${CSP}"><meta name="referrer" content="no-referrer">` +
      style(baseCss, 'base') +
      sheets.map((t) => style(t)).join('') +
      style(userCss, 'user') +
      style('', 'layout') +
      `</head>${doc.body.outerHTML}</html>`;
    return { srcdoc, lang: p.lang, dir: p.dir };
  }

  /** Chapter text (search, excerpts), or '' when the chapter cannot be read. */
  async text(i) {
    if (this.texts.has(i)) return this.texts.get(i);
    let t = '';
    try {
      t = (await this.parse(i)).text;
    } catch {}
    if (!this.closed) this.texts.set(i, t);
    return t;
  }

  close() {
    this.closed = true;
    for (const u of this.urls) URL.revokeObjectURL(u);
    this.urls = [];
    this.blobs.clear();
    this.datas.clear();
    this.cssFiles.clear();
    this.parsed.clear();
    this.texts.clear();
  }
}

// ---------------------------------------------------------------- search helpers
/** Case- and accent-insensitive form of `text` with the index of each output character in `text`. */
export function foldMap(text) {
  let s = '';
  const map = [];
  let space = false;
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i);
    const len = cp > 0xffff ? 2 : 1;
    let t;
    if (cp < 128) t = String.fromCharCode(cp).toLowerCase();
    else t = String.fromCodePoint(cp).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
    if (/^\s+$/.test(t) || cp === 0xa0) {
      if (space) t = '';
      else t = ' ';
      space = true;
    } else if (t) space = false;
    for (let k = 0; k < t.length; k++) {
      s += t[k];
      map.push(i);
    }
    i += len;
  }
  map.push(text.length);
  return { s, map };
}
export function fold(text) {
  return foldMap(String(text || '')).s.trim();
}

/** All matches of `needle` (folded) in `text` -> [{ start, end }] (indices in text). */
export function findAll(text, needle, max = 1000) {
  const { s, map } = foldMap(text);
  const out = [];
  if (!needle) return out;
  let from = 0;
  while (out.length < max) {
    const k = s.indexOf(needle, from);
    if (k < 0) break;
    const start = map[k];
    const lastIdx = k + needle.length - 1;
    let end = map[lastIdx + 1] ?? text.length;
    if (end <= start) end = start + 1;
    out.push({ start, end });
    from = k + Math.max(1, needle.length);
  }
  return out;
}
