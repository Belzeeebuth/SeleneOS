// HTML sanitizer for Notes: every piece of HTML that reaches the editor (pasted, dropped, imported, or
// read back from a note file) goes through here.
//
//   sanitizeFragment(html, opts) -> DocumentFragment built in opts.doc (default: the live document; pass
//                                   inertDocument() when the tree is only analysed: <img> elements of the live
//                                   document start loading as soon as they get a src, even detached)
//   sanitizeHtml(html, opts)     -> string (always built in the inert document: nothing is fetched)
//   inertDocument()              -> a document without a browsing context (no loads, no scripts)
//
// How it works: the input is parsed into an *inert* document (DOMParser: no scripts run, no images load,
// no event handlers fire), then a brand-new tree is rebuilt node by node in the live document from an
// allow-list. Nothing from the source is ever moved or cloned, so unknown attributes can't leak through.
//   - allowed tags are mapped to a small vocabulary (strong -> b, h4-h6 -> h3, font -> span, ...)
//   - unknown tags are unwrapped (their text is kept); dangerous ones are dropped with their content
//     (script, style, iframe, object, embed, svg, math, template, form controls, media, ...)
//   - attributes: only a[href,title], img[src,alt,width,data-att (opts.attachments only)], ol[start], ul[data-type], li[data-checked],
//     td/th[colspan,rowspan], span[data-color], mark[data-hl]; no style, no class, no id, no on*
//   - URLs: links http(s)/mailto/tel only; pictures data:image/*, media: (opts.allowMedia), http(s)
//     (opts.allowRemote) or a bare attachment name (opts.attachments)
//   - pasted inline styles (font-weight / font-style / text-decoration) become b / i / u / s
//   - GitHub-style task lists (<li><input type=checkbox checked>) become checklist items
// Options: { attachments, allowMedia, allowRemote, collapseWhitespace, maxDepth, doc }
export const TEXT_COLORS = ['red', 'orange', 'green', 'blue', 'purple', 'gray'];
export const HIGHLIGHTS = ['yellow', 'green', 'blue', 'pink', 'orange', 'purple'];
export const ATTACHMENT_RE = /^att-[a-z0-9]{8}(?:-[a-z0-9-]{1,40})?\.[a-z0-9]{2,5}$/;

const MAP = {
  B: 'b', STRONG: 'b',
  I: 'i', EM: 'i', CITE: 'i', DFN: 'i', VAR: 'i',
  U: 'u', INS: 'u',
  S: 's', STRIKE: 's', DEL: 's',
  MARK: 'mark',
  CODE: 'code', KBD: 'code', SAMP: 'code', TT: 'code',
  SUB: 'sub', SUP: 'sup',
  A: 'a', IMG: 'img', BR: 'br', HR: 'hr',
  SPAN: 'span', FONT: 'span',
  P: 'p', DIV: 'div',
  H1: 'h1', H2: 'h2', H3: 'h3', H4: 'h3', H5: 'h3', H6: 'h3',
  BLOCKQUOTE: 'blockquote', PRE: 'pre', XMP: 'pre', LISTING: 'pre', PLAINTEXT: 'pre',
  UL: 'ul', OL: 'ol', LI: 'li', MENU: 'ul', DIR: 'ul',
  TABLE: 'table', THEAD: 'thead', TBODY: 'tbody', TFOOT: 'tbody', TR: 'tr', TD: 'td', TH: 'th',
  SECTION: 'div', ARTICLE: 'div', HEADER: 'div', FOOTER: 'div', MAIN: 'div', ASIDE: 'div', NAV: 'div',
  ADDRESS: 'div', FIGURE: 'div', FIGCAPTION: 'div', CAPTION: 'div', CENTER: 'div', DETAILS: 'div', SUMMARY: 'div',
  DL: 'div', DT: 'div', DD: 'div', HGROUP: 'div', LEGEND: 'div', FIELDSET: 'div', FORM: 'div',
};
// dropped together with everything inside them
const DROP = new Set([
  'SCRIPT', 'STYLE', 'IFRAME', 'FRAME', 'FRAMESET', 'OBJECT', 'EMBED', 'APPLET', 'NOSCRIPT', 'NOEMBED', 'NOFRAMES',
  'TEMPLATE', 'SVG', 'MATH', 'CANVAS', 'AUDIO', 'VIDEO', 'SOURCE', 'TRACK', 'PICTURE', 'MAP', 'AREA', 'PARAM',
  'INPUT', 'BUTTON', 'SELECT', 'OPTION', 'OPTGROUP', 'TEXTAREA', 'DATALIST', 'OUTPUT', 'PROGRESS', 'METER',
  'LINK', 'META', 'BASE', 'TITLE', 'HEAD', 'DIALOG', 'PORTAL', 'SLOT', 'COLGROUP', 'COL',
]);
export const BLOCK_TAGS = new Set(['p', 'div', 'h1', 'h2', 'h3', 'blockquote', 'pre', 'ul', 'ol', 'li', 'hr', 'table', 'thead', 'tbody', 'tr', 'td', 'th']);
const INLINE_FORMAT = new Set(['b', 'i', 'u', 's', 'mark', 'code', 'sub', 'sup', 'span', 'a']);

const LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:']);
const DATA_IMAGE_RE = /^data:image\/(png|jpe?g|gif|webp|bmp|avif|svg\+xml|x-icon|vnd\.microsoft\.icon);base64,[a-z0-9+/=\s]+$/i;

// strip control characters / whitespace that browsers ignore inside URLs ("java\nscript:")
function cleanUrl(v) {
  return String(v || '')
    .replace(/[\u0000-\u0020\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g, '')
    .trim();
}

export function safeLinkUrl(v) {
  const s = cleanUrl(v);
  if (!s) return null;
  let u;
  try {
    u = new URL(s);
  } catch {
    // bare domains typed by the user ("example.com/page")
    if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/i.test(s)) {
      try {
        u = new URL(`https://${s}`);
      } catch {
        return null;
      }
    } else return null;
  }
  if (!LINK_PROTOCOLS.has(u.protocol)) return null;
  return u.href;
}

export function safeImageUrl(v, opts = {}) {
  const raw = String(v || '').trim();
  if (opts.attachments && ATTACHMENT_RE.test(raw)) return raw;
  const s = cleanUrl(raw);
  if (!s) return null;
  if (/^data:/i.test(s)) return DATA_IMAGE_RE.test(s) ? s.replace(/\s+/g, '') : null;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol === 'media:' && opts.allowMedia) return u.href;
  if ((u.protocol === 'https:' || u.protocol === 'http:') && opts.allowRemote) return u.href;
  return null;
}

function styleFormats(el) {
  // Only read a handful of properties from the (inert) source style; never copy the style itself.
  const st = el.style;
  if (!st) return [];
  const out = [];
  const w = st.fontWeight;
  if (w === 'bold' || w === 'bolder' || Number(w) >= 600) out.push('b');
  if (st.fontStyle === 'italic' || st.fontStyle === 'oblique') out.push('i');
  const deco = `${st.textDecorationLine || ''} ${st.textDecoration || ''}`;
  if (/underline/.test(deco)) out.push('u');
  if (/line-through/.test(deco)) out.push('s');
  return out;
}

function collapseWs(s) {
  return s.replace(/[\t\n\r\f ]+/g, ' ');
}

let inert = null;
export function inertDocument() {
  inert ||= document.implementation.createHTMLDocument('');
  return inert;
}

export function sanitizeFragment(html, opts = {}) {
  const doc = opts.doc || document;
  const maxDepth = opts.maxDepth || 64;
  const src = new DOMParser().parseFromString(`<!doctype html><html><body>${String(html ?? '')}</body></html>`, 'text/html');
  const frag = doc.createDocumentFragment();

  const build = (node, out, depth, ctx) => {
    for (let n = node.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3) {
        let text = n.data;
        if (opts.collapseWhitespace && !ctx.pre) text = collapseWs(text);
        if (text) out.appendChild(doc.createTextNode(text));
        continue;
      }
      if (n.nodeType !== 1) continue; // comments, processing instructions, CDATA
      const tag = n.tagName.toUpperCase();
      if (DROP.has(tag) || n.namespaceURI !== 'http://www.w3.org/1999/xhtml') {
        // a task-list checkbox is the one form control that means something
        if (tag === 'INPUT' && ctx.li && String(n.getAttribute('type')).toLowerCase() === 'checkbox') {
          ctx.li.setAttribute('data-checked', n.hasAttribute('checked') ? 'true' : 'false');
          ctx.li._task = true;
        }
        continue;
      }
      let mapped = MAP[tag];
      // Google Docs wraps whole pastes in <b style="font-weight:normal">; Word uses <i style="font-style:normal">
      if ((mapped === 'b' && /^(normal|lighter|[1-5]00)$/.test(n.style?.fontWeight || '')) || (mapped === 'i' && n.style?.fontStyle === 'normal')) mapped = null;
      if (!mapped || depth >= maxDepth) {
        // unknown element (or absurd nesting): keep the content only
        build(n, out, depth + 1, ctx);
        continue;
      }
      const el = createClean(n, mapped, ctx);
      if (!el) continue;
      const kind = el.tagName.toLowerCase(); // createClean may downgrade (unsafe link -> span)
      let target = el;
      // pasted CSS formatting on spans -> semantic tags (never the style itself)
      if (opts.convertStyles !== false && kind === 'span') {
        for (const f of styleFormats(n)) {
          const w = doc.createElement(f);
          target.appendChild(w);
          target = w;
        }
      }
      if (kind !== 'br' && kind !== 'hr' && kind !== 'img') {
        build(n, target, depth + 1, { ...ctx, pre: ctx.pre || kind === 'pre', li: kind === 'li' ? el : ctx.li });
      }
      if (kind === 'li' && el._task) {
        delete el._task;
        out._tasks = true;
      }
      if (kind === 'span' && !el.attributes.length) {
        // a plain span is just noise: keep its children
        while (el.firstChild) out.appendChild(el.firstChild);
        continue;
      }
      if (INLINE_FORMAT.has(kind) && !el.textContent && !el.querySelector('img, br')) continue; // empty formatting / empty link
      out.appendChild(el);
      if ((kind === 'ul' || kind === 'ol') && el._tasks) {
        if (kind === 'ul') el.setAttribute('data-type', 'checklist');
        delete el._tasks;
      }
    }
  };

  const createClean = (n, tag, ctx) => {
    const el = doc.createElement(tag);
    const attr = (k) => n.getAttribute(k);
    switch (tag) {
      case 'a': {
        const href = safeLinkUrl(attr('href'));
        if (href) el.setAttribute('href', href);
        const title = attr('title');
        if (title) el.setAttribute('title', title.slice(0, 500));
        if (!href) return doc.createElement('span'); // keep the text, drop the link
        break;
      }
      case 'img': {
        const src = safeImageUrl(attr('src'), opts);
        if (!src) return null;
        el.setAttribute('src', src);
        const alt = attr('alt');
        if (alt) el.setAttribute('alt', alt.slice(0, 500));
        const w = parseInt(attr('width') || '', 10);
        if (w >= 16 && w <= 4000) el.setAttribute('width', String(w));
        // an attachment name only means something inside the note it was read from: pasted / dropped HTML
        // (copied from another note) must not keep it, or the picture would point at the other note's file
        const att = attr('data-att');
        if (opts.attachments && att && ATTACHMENT_RE.test(att)) el.setAttribute('data-att', att);
        break;
      }
      case 'ol': {
        const s = parseInt(attr('start') || '', 10);
        if (Number.isFinite(s) && s !== 1 && s >= 0 && s < 1e6) el.setAttribute('start', String(s));
        break;
      }
      case 'ul':
        if (attr('data-type') === 'checklist') el.setAttribute('data-type', 'checklist');
        break;
      case 'li': {
        const c = attr('data-checked');
        if (c === 'true' || c === 'false') el.setAttribute('data-checked', c);
        break;
      }
      case 'td':
      case 'th': {
        for (const k of ['colspan', 'rowspan']) {
          const v = parseInt(attr(k) || '', 10);
          if (v > 1 && v <= 20) el.setAttribute(k, String(v));
        }
        break;
      }
      case 'span': {
        const c = attr('data-color');
        if (c && TEXT_COLORS.includes(c)) el.setAttribute('data-color', c);
        break;
      }
      case 'mark': {
        const c = attr('data-hl');
        el.setAttribute('data-hl', c && HIGHLIGHTS.includes(c) ? c : 'yellow');
        break;
      }
      default:
        break;
    }
    return el;
  };

  build(src.body, frag, 0, { pre: false, li: null });
  fixStructure(frag, opts);
  return frag;
}

// Structural clean-up so the editor and the Markdown exporter always see a sane tree:
// orphan <li> -> <div>, <tr>/<td> outside a table -> unwrapped, top-level inline runs wrapped in <div>.
function fixStructure(root, opts) {
  const doc = root.ownerDocument || document;
  const walk = (parent) => {
    for (const el of [...parent.children]) {
      const tag = el.tagName.toLowerCase();
      const ptag = parent.nodeType === 1 ? parent.tagName.toLowerCase() : '';
      if (tag === 'li' && ptag !== 'ul' && ptag !== 'ol') {
        const div = doc.createElement('div');
        while (el.firstChild) div.appendChild(el.firstChild);
        el.replaceWith(div);
        walk(div);
        continue;
      }
      if ((tag === 'tr' && !['table', 'thead', 'tbody'].includes(ptag)) || ((tag === 'td' || tag === 'th') && ptag !== 'tr') || ((tag === 'thead' || tag === 'tbody') && ptag !== 'table')) {
        const kids = [...el.childNodes];
        el.replaceWith(...kids);
        for (const k of kids) if (k.nodeType === 1) walk(k.parentNode);
        continue;
      }
      if ((tag === 'ul' || tag === 'ol') && opts.collapseWhitespace) {
        // whitespace between <li>s
        for (const n of [...el.childNodes]) if (n.nodeType === 3 && !n.data.trim()) n.remove();
      }
      if (tag === 'table' || tag === 'thead' || tag === 'tbody' || tag === 'tr') {
        for (const n of [...el.childNodes]) if (n.nodeType === 3) n.remove();
      }
      walk(el);
    }
  };
  walk(root);
  if (opts.collapseWhitespace) trimBlocks(root);
  wrapInlineRuns(root);
}

function isBlock(n) {
  return n.nodeType === 1 && BLOCK_TAGS.has(n.tagName.toLowerCase());
}

// Remove leading / trailing spaces inside blocks and whitespace-only text between blocks (pasted HTML
// is full of source indentation; the editor uses white-space: pre-wrap, so it would show).
function trimBlocks(root) {
  const blocks = [root, ...root.querySelectorAll('*')].filter((b) => b === root || isBlock(b));
  for (const b of blocks) {
    if (b.nodeType === 1 && b.tagName === 'PRE') continue;
    for (const n of [...b.childNodes]) {
      if (n.nodeType === 3 && !n.data.trim() && (isBlock(n.previousSibling || {}) || isBlock(n.nextSibling || {}) || !n.previousSibling || !n.nextSibling)) n.remove();
    }
    const first = firstText(b);
    if (first) first.data = first.data.replace(/^ +/, '');
    const last = lastText(b);
    if (last) last.data = last.data.replace(/ +$/, '');
  }
}
function firstText(b) {
  for (let n = b.firstChild; n; ) {
    if (n.nodeType === 3) return n;
    if (isBlock(n) || n.tagName === 'BR' || n.tagName === 'IMG') return null;
    n = n.firstChild || n.nextSibling;
  }
  return null;
}
function lastText(b) {
  for (let n = b.lastChild; n; ) {
    if (n.nodeType === 3) return n;
    if (isBlock(n) || n.tagName === 'BR' || n.tagName === 'IMG') return null;
    n = n.lastChild || n.previousSibling;
  }
  return null;
}

function wrapInlineRuns(root) {
  const doc = root.ownerDocument || document;
  let run = null;
  for (const n of [...root.childNodes]) {
    if (isBlock(n)) {
      run = null;
      continue;
    }
    if (n.nodeType === 3 && !n.data.trim() && !run) {
      n.remove();
      continue;
    }
    if (n.nodeType === 1 && n.tagName === 'BR') {
      // a top-level <br> ends a line
      if (run) run.appendChild(n);
      else n.remove();
      run = null;
      continue;
    }
    if (!run) {
      run = doc.createElement('div');
      root.insertBefore(run, n);
    }
    run.appendChild(n);
  }
  // a <br> that ended a run is redundant at the end of a div
  for (const d of root.children) {
    if (d.tagName === 'DIV' && d.lastChild?.nodeName === 'BR' && d.childNodes.length > 1) d.lastChild.remove();
  }
}

export function sanitizeHtml(html, opts = {}) {
  const doc = inertDocument();
  const box = doc.createElement('div');
  box.appendChild(sanitizeFragment(html, { ...opts, doc }));
  return box.innerHTML;
}

// Escape text for HTML (used by the Markdown importer and exporters).
export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
