// Article / show notes HTML for the reading pane of Podcasts & News.
//
// buildArticle({ html, base, allowImages, colors, lang }) -> { srcdoc, remote, embeds }
//   The result goes into <iframe sandbox="allow-popups allow-popups-to-escape-sandbox" srcdoc=…>: scripts never run and
//   the document gets an opaque origin. On top of that the content is REBUILT from an allow-list in an inert document
//   (only known tags and attributes are copied; no scripts, styles, event handlers, forms, frames, objects, meta / base /
//   link, javascript: or data: links), relative addresses are resolved against `base`, and the document carries its own
//   Content-Security-Policy: nothing remote loads except, once the person clicks « Afficher les images » for that
//   feed, http(s) images. While images are blocked their addresses are not even in the markup (a placeholder with the
//   alternative text takes their place), so nothing is requested. Tracking pixels (≤ 2 px) are dropped. Embedded
//   players (<iframe>, <video>, <audio>) become links. Links open through <base target="_blank">: the shell's main
//   process sends http(s) pop-ups to the Navigateur.

const KEEP = new Set(['a', 'abbr', 'b', 'bdi', 'bdo', 'blockquote', 'br', 'caption', 'cite', 'code', 'col', 'colgroup', 'dd', 'del', 'details', 'dfn', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'small', 'span', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'time', 'tr', 'u', 'ul', 'var', 'wbr']);
const RENAME = { center: 'div', font: 'span', strike: 's', tt: 'code', big: 'span', article: 'div', section: 'div', header: 'div', footer: 'div', main: 'div', nav: 'div', aside: 'div', address: 'div', hgroup: 'div', picture: 'span', listing: 'pre', xmp: 'pre', plaintext: 'pre', dir: 'ul', menu: 'ul' };
// dropped with everything inside
const SKIP = new Set(['script', 'style', 'noscript', 'template', 'head', 'title', 'meta', 'link', 'base', 'object', 'embed', 'applet', 'param', 'svg', 'math', 'canvas', 'map', 'area', 'input', 'button', 'select', 'textarea', 'option', 'optgroup', 'datalist', 'output', 'progress', 'meter', 'dialog', 'frameset', 'frame', 'source', 'track', 'slot', 'portal', 'fencedframe', 'search']);
const ATTRS = {
  a: ['href', 'title'],
  img: ['alt', 'title', 'width', 'height'],
  td: ['colspan', 'rowspan', 'headers', 'scope'],
  th: ['colspan', 'rowspan', 'headers', 'scope'],
  col: ['span'],
  colgroup: ['span'],
  ol: ['start', 'type', 'reversed'],
  li: ['value'],
  time: ['datetime'],
  abbr: ['title'],
  dfn: ['title'],
  q: ['cite'],
  blockquote: ['cite'],
  del: ['cite', 'datetime'],
  ins: ['cite', 'datetime'],
  details: ['open'],
};
const COMMON = ['dir', 'lang'];
const MAX_NODES = 40000;

function resolve(u, base) {
  const s = String(u ?? '').trim();
  if (!s) return null;
  try {
    return new URL(s, base || undefined);
  } catch {
    return null;
  }
}
function safeHref(v, base) {
  const s = String(v ?? '').trim();
  if (s.startsWith('#')) return null; // in-page anchors do not survive the rebuild; drop them
  if (/^mailto:/i.test(s)) return s.slice(0, 2000);
  const u = resolve(s, base);
  return u && (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : null;
}
const DATA_IMG = /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i;

/** The picture an <img> really shows (lazy-loading attributes first, then src, then the first srcset candidate). */
function imageSource(el, base) {
  const cands = [el.getAttribute('data-src'), el.getAttribute('data-lazy-src'), el.getAttribute('data-original'), el.getAttribute('src')];
  const srcset = el.getAttribute('srcset') || el.getAttribute('data-srcset');
  if (srcset) cands.push(srcset.split(',').map((x) => x.trim().split(/\s+/)[0]).filter(Boolean).pop());
  for (const c of cands) {
    const s = String(c ?? '').trim();
    if (!s) continue;
    if (/^data:/i.test(s)) {
      if (DATA_IMG.test(s) && s.length < 300000 && s.length > 200) return { url: s, remote: false };
      continue; // tiny data: placeholders of lazy loaders
    }
    const u = resolve(s, base);
    if (u && (u.protocol === 'http:' || u.protocol === 'https:')) return { url: u.href, remote: true };
  }
  return null;
}

const dim = (v) => {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) && n > 0 && n <= 5000 ? n : null;
};

/** Allow-list rebuild of `html` into a fragment of the inert document `out`. */
export function cleanHtml(html, { base = '', allowImages = false, out = document.implementation.createHTMLDocument('') } = {}) {
  const src = new DOMParser().parseFromString(`<!doctype html><body>${String(html ?? '').slice(0, 3000000)}`, 'text/html');
  const frag = out.createDocumentFragment();
  const stats = { remote: 0, embeds: 0, nodes: 0 };
  const host = (u) => {
    try {
      return new URL(u).host.replace(/^www\./, '');
    } catch {
      return '';
    }
  };
  const embedLink = (url, parent, kind) => {
    stats.embeds++;
    const p = out.createElement('p');
    p.className = 'sl-embed';
    const a = out.createElement('a');
    a.href = url;
    a.rel = 'noopener noreferrer';
    a.textContent = `${kind === 'video' ? '▶ ' : ''}${host(url) || url}`;
    a.dataset.kind = kind;
    p.appendChild(a);
    parent.appendChild(p);
  };
  const copy = (node, parent, depth) => {
    if (depth > 64) return;
    for (const c of [...node.childNodes]) {
      if (++stats.nodes > MAX_NODES) return;
      if (c.nodeType === 3) {
        parent.appendChild(out.createTextNode(c.nodeValue));
        continue;
      }
      if (c.nodeType !== 1) continue;
      let tag = c.localName;
      if (tag === 'iframe' || tag === 'video' || tag === 'audio') {
        const u = safeHref(c.getAttribute('src') || c.querySelector?.('source[src]')?.getAttribute('src'), base);
        if (u) embedLink(u, parent, tag === 'audio' ? 'audio' : 'video');
        continue;
      }
      if (SKIP.has(tag)) continue;
      if (tag === 'form' || tag === 'fieldset' || tag === 'label' || tag === 'legend') {
        copy(c, parent, depth + 1); // keep the text, never the form
        continue;
      }
      if (RENAME[tag]) tag = RENAME[tag];
      if (!KEEP.has(tag)) {
        copy(c, parent, depth + 1); // unknown element: its content only
        continue;
      }
      if (tag === 'img') {
        const w = dim(c.getAttribute('width'));
        const hgt = dim(c.getAttribute('height'));
        if ((w && w <= 2) || (hgt && hgt <= 2)) continue; // tracking pixel
        const pic = imageSource(c, base);
        if (!pic) {
          const alt = (c.getAttribute('alt') || '').trim();
          if (alt) parent.appendChild(out.createTextNode(alt));
          continue;
        }
        if (pic.remote) stats.remote++;
        if (pic.remote && !allowImages) {
          const ph = out.createElement('span');
          ph.className = 'sl-img-blocked';
          ph.setAttribute('role', 'img');
          const alt = (c.getAttribute('alt') || c.getAttribute('title') || '').trim().slice(0, 300);
          ph.setAttribute('aria-label', alt || '');
          ph.textContent = alt;
          if (w && hgt && w >= 40 && hgt >= 40) ph.style.aspectRatio = `${w} / ${hgt}`;
          parent.appendChild(ph);
          continue;
        }
        const img = out.createElement('img');
        img.setAttribute('src', pic.url);
        for (const a of ['alt', 'title']) if (c.hasAttribute(a)) img.setAttribute(a, c.getAttribute(a).slice(0, 300));
        if (w) img.setAttribute('width', String(w));
        if (hgt) img.setAttribute('height', String(hgt));
        img.setAttribute('loading', 'lazy');
        img.setAttribute('referrerpolicy', 'no-referrer');
        parent.appendChild(img);
        continue;
      }
      const el = out.createElement(tag);
      for (const name of [...(ATTRS[tag] || []), ...COMMON]) {
        if (!c.hasAttribute(name)) continue;
        let v = c.getAttribute(name);
        if (name === 'href') v = safeHref(v, base);
        else if (name === 'cite') v = safeHref(v, base);
        else if (['colspan', 'rowspan', 'span', 'start', 'value'].includes(name)) v = /^-?\d{1,4}$/.test(v.trim()) ? v.trim() : null;
        else if (name === 'dir') v = /^(ltr|rtl|auto)$/i.test(v) ? v : null;
        else if (name === 'type') v = /^[1aAiI]$/.test(v) ? v : null;
        else if (name === 'reversed' || name === 'open') v = '';
        else v = String(v).slice(0, 500);
        if (v != null) el.setAttribute(name, v);
      }
      if (tag === 'a') {
        if (el.hasAttribute('href')) el.setAttribute('rel', 'noopener noreferrer');
      }
      copy(c, el, depth + 1);
      parent.appendChild(el);
    }
  };
  if (src.body) copy(src.body, frag, 0);
  return { frag, ...stats };
}

const CSS_VALUE = /^[#\w\s(),.%/+-]{1,80}$/;
const css = (v, fallback) => (typeof v === 'string' && CSS_VALUE.test(v.trim()) ? v.trim() : fallback);

/**
 * The reading pane document.
 * colors: { text, text2, accent, line, code, scheme: 'light'|'dark' } (the app's tokens, read with getComputedStyle)
 */
export function buildArticle({ html, base = '', allowImages = false, colors = {}, lang = 'en', empty = '' } = {}) {
  const out = document.implementation.createHTMLDocument('');
  const { frag, remote, embeds } = cleanHtml(html, { base, allowImages, out });
  const wrap = out.createElement('div');
  wrap.className = 'sl-article';
  wrap.appendChild(frag);
  if (!wrap.textContent.trim() && !wrap.querySelector('img, .sl-img-blocked, .sl-embed')) {
    const p = out.createElement('p');
    p.className = 'sl-empty';
    p.textContent = empty;
    wrap.replaceChildren(p);
  }
  const scheme = colors.scheme === 'dark' ? 'dark' : 'light';
  // (system colours only if a token could not be read)
  const text = css(colors.text, 'CanvasText');
  const text2 = css(colors.text2, 'GrayText');
  const accent = css(colors.accent, 'LinkText');
  const line = css(colors.line, 'GrayText');
  const code = css(colors.code, 'transparent');
  const imgSrc = allowImages ? 'data: https: http:' : 'data:';
  const policy = `default-src 'none'; img-src ${imgSrc}; style-src 'unsafe-inline'; font-src 'none'; media-src 'none'; frame-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'`;
  const style = `:root{color-scheme:${scheme}}html,body{background:transparent}
body{margin:0;padding:4px 28px 40px;font:15px/1.65 Inter,"Noto Sans","DejaVu Sans",system-ui,sans-serif;color:${text};word-wrap:break-word;overflow-wrap:anywhere}
.sl-article{max-width:72ch}
a{color:${accent}}a:focus-visible{outline:2px solid ${accent};outline-offset:2px;border-radius:2px}
h1,h2,h3,h4,h5,h6{line-height:1.3;margin:1.4em 0 .5em}h1{font-size:1.5em}h2{font-size:1.3em}h3{font-size:1.15em}h4,h5,h6{font-size:1em}
p{margin:0 0 1em}img{max-width:100%;height:auto;border-radius:6px}figure{margin:1em 0}figcaption{color:${text2};font-size:.87em;margin-top:.3em}
blockquote{margin:1em 0;padding:.1em 0 .1em 1em;border-left:3px solid ${line};color:${text2}}
pre{overflow:auto;padding:12px 14px;border-radius:6px;background:${code};font-size:.9em;line-height:1.5}
code,kbd,samp{font-family:"Cascadia Code","DejaVu Sans Mono",monospace;font-size:.92em}:not(pre)>code{background:${code};padding:.1em .3em;border-radius:4px}
table{border-collapse:collapse;max-width:100%;display:block;overflow:auto}td,th{border:1px solid ${line};padding:4px 8px;vertical-align:top}
hr{border:0;border-top:1px solid ${line};margin:1.5em 0}
.sl-img-blocked{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;min-width:48px;min-height:32px;max-width:100%;padding:6px 10px;border:1px dashed ${line};border-radius:6px;color:${text2};font-size:.8em;vertical-align:middle;overflow:hidden}
.sl-embed{margin:1em 0}.sl-embed a{display:inline-block;padding:6px 12px;border:1px solid ${line};border-radius:6px;text-decoration:none}
.sl-empty{color:${text2}}`;
  const safeLang = /^[a-z]{2}(-[A-Za-z]{2})?$/.test(lang) ? lang : 'en';
  const srcdoc = `<!doctype html><html lang="${safeLang}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer"><meta http-equiv="x-dns-prefetch-control" content="off"><base target="_blank"><style>${style}</style></head><body>${wrap.outerHTML}</body></html>`;
  return { srcdoc, remote, embeds };
}
