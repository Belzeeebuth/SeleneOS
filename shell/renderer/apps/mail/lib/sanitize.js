// E-mail HTML handling.
//
// buildMailDocument(): the reading pane. The result goes into
//   <iframe sandbox="allow-popups allow-popups-to-escape-sandbox" srcdoc=…>
// so scripts never run and the content gets an opaque origin. On top of that the document is
// cleaned (no scripts, frames, plugins, meta refresh, <base>, event handlers or javascript: URLs)
// and carries a Content-Security-Policy that blocks every remote load except, once the user
// clicks "Show pictures", remote images. Remote image URLs are also removed from the markup while
// blocked, so nothing is even requested. Links open through <base target="_blank">; the shell's
// main process routes http(s) pop-ups to Aurora Browser and mailto: ones back to Mail.
//
// sanitizeForCompose(): quoting a message in the composer. The composer lives in the shell's own
// document, so this is a strict allow-list REBUILD (new nodes are created from scratch in an inert
// document; only known tags, attributes and CSS properties are copied) — never innerHTML of the
// original markup.
import { escapeHtml, textToHtml } from './util.js';

const DROP = new Set(['script', 'noscript', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'meta', 'link', 'base', 'template', 'portal', 'audio', 'video', 'source', 'track', 'canvas', 'param', 'dialog', 'slot']);
const REMOTE_RE = /^\s*(https?:)?\/\//i;
const URL_IN_CSS = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;

function safeHref(v) {
  const s = String(v || '').trim();
  if (/^(https?:|mailto:|tel:)/i.test(s)) return s;
  if (s.startsWith('#')) return s;
  return null;
}

function cleanCss(css, allowRemote, cids, counter) {
  return String(css || '')
    .replace(/@import[^;]*;?/gi, '')
    .replace(/expression\s*\(/gi, 'x(')
    .replace(/(java|vb)script\s*:/gi, 'x:')
    .replace(URL_IN_CSS, (m, q, u) => {
      const url = u.trim();
      if (/^cid:/i.test(url)) {
        const data = cids?.[url.slice(4)];
        return data ? `url("${data}")` : 'none';
      }
      if (/^data:image\//i.test(url)) return m;
      if (REMOTE_RE.test(url)) {
        counter.remote++;
        return allowRemote ? `url("${url.replace(/"/g, '%22')}")` : 'none';
      }
      return 'none';
    });
}

/**
 * @param {object} o
 * @param {string|null} o.html   raw HTML body (null for plain-text mail)
 * @param {string} o.text        plain text body
 * @param {object} o.cids        { contentId: dataUrl } for inline images
 * @param {boolean} o.allowRemote load remote images
 * @param {'light'|'dark'} o.theme  theme for plain-text rendering
 * @param {boolean} o.adapt      dark adaptation of HTML mail (invert)
 * @param {string} o.accent      accent color for plain-text links
 * @returns {{ srcdoc: string, remote: number, isHtml: boolean }}
 */
export function buildMailDocument({ html, text, cids = {}, allowRemote = false, theme = 'light', adapt = false, accent = '#005fb8', accentDark = '#60cdff' }) {
  const counter = { remote: 0 };
  const isHtml = !!(html && html.trim());
  let head = '';
  let body = '';
  if (isHtml) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    // Drop dangerous elements (DOMParser documents are inert: nothing loads or runs here).
    for (const el of [...doc.querySelectorAll('*')]) {
      const tag = el.localName;
      if (DROP.has(tag)) {
        el.remove();
        continue;
      }
      if (tag === 'form') {
        const div = doc.createElement('div');
        div.append(...el.childNodes);
        el.replaceWith(div);
        continue;
      }
      if (tag === 'input' || tag === 'button' || tag === 'select' || tag === 'textarea') {
        el.setAttribute('disabled', '');
      }
      for (const attr of [...el.attributes]) {
        const n = attr.name.toLowerCase();
        const v = attr.value;
        if (n.startsWith('on') || n === 'srcdoc' || n === 'formaction' || n === 'action' || n === 'ping' || n === 'http-equiv' || n === 'autofocus') {
          el.removeAttribute(attr.name);
        } else if (n === 'href' || n === 'xlink:href') {
          const ok = tag === 'a' || tag === 'area' ? safeHref(v) : null;
          if (ok) el.setAttribute(attr.name, ok);
          else el.removeAttribute(attr.name);
        } else if (n === 'src' || n === 'srcset' || n === 'background' || n === 'poster' || n === 'lowsrc' || n === 'dynsrc') {
          if (n === 'src' && /^cid:/i.test(v.trim())) {
            const data = cids[v.trim().slice(4)];
            if (data) el.setAttribute('src', data);
            else el.removeAttribute('src');
          } else if (n === 'src' && /^data:image\//i.test(v.trim())) {
            // keep
          } else if (REMOTE_RE.test(v) || (n === 'srcset' && /https?:/i.test(v))) {
            counter.remote++;
            if (!allowRemote) {
              el.removeAttribute(attr.name);
              el.setAttribute(`data-blocked-${n}`, '');
            } else if (n === 'src' || n === 'srcset' || n === 'background') {
              // keep remote image
            } else el.removeAttribute(attr.name);
          } else el.removeAttribute(attr.name);
        } else if (n === 'style') {
          el.setAttribute('style', cleanCss(v, allowRemote, cids, counter));
        } else if (n === 'target') {
          el.removeAttribute(attr.name);
        } else if (/^(java|vb)script:/i.test(v.trim())) {
          el.removeAttribute(attr.name);
        }
      }
      if (tag === 'a' && el.hasAttribute('href')) el.setAttribute('rel', 'noopener noreferrer');
      if (tag === 'img' && !el.hasAttribute('src') && el.hasAttribute('data-blocked-src')) {
        el.setAttribute('alt', el.getAttribute('alt') || '');
      }
      if (tag === 'style') el.textContent = cleanCss(el.textContent, allowRemote, cids, counter);
    }
    for (const st of doc.head ? [...doc.head.querySelectorAll('style')] : []) head += `<style>${st.textContent.replace(/<\/style/gi, '<\\/style')}</style>`;
    body = doc.body ? doc.body.innerHTML : '';
    const bodyAttrs = doc.body ? [...doc.body.attributes].filter((a) => ['style', 'bgcolor', 'text', 'link', 'class', 'dir'].includes(a.name)) : [];
    body = `<div class="aurora-mail-body"${bodyAttrs.map((a) => ` ${a.name === 'bgcolor' ? 'data-bgcolor' : a.name}="${escapeHtml(a.value)}"`).join('')}>${body}</div>`;
  } else {
    body = `<div class="aurora-text">${textToHtml(text || '')}</div>`;
  }
  const dark = theme === 'dark';
  const imgSrc = allowRemote ? 'data: https: http:' : 'data:';
  const csp = `default-src 'none'; img-src ${imgSrc}; style-src 'unsafe-inline'; font-src data:; media-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'`;
  const font = '"Segoe UI Variable Text","Segoe UI","Inter","Noto Sans","DejaVu Sans",system-ui,sans-serif';
  const base = isHtml
    ? `:root{color-scheme:light}html{background:#fff}body{margin:0;padding:16px 20px;font:14px/1.45 ${font};color:#1b1b1b;background:#fff;word-wrap:break-word;overflow-wrap:anywhere}
img{max-width:100%;height:auto}table{max-width:100%}pre{white-space:pre-wrap}a{color:#0f6cbd}
img[data-blocked-src]{display:inline-block;min-width:24px;min-height:24px;background:#f0f0f0;border:1px dashed #c8c8c8;border-radius:4px}
blockquote{margin:6px 0 6px 2px;padding-left:12px;border-left:3px solid #c8c8c8;color:#555}
${adapt ? 'html{filter:invert(1) hue-rotate(180deg);background:#fff}img,picture,video,[style*="background-image"],[data-bgimg]{filter:invert(1) hue-rotate(180deg)}' : ''}`
    : `:root{color-scheme:${dark ? 'dark' : 'light'}}html,body{background:transparent}body{margin:0;padding:16px 20px;font:14px/1.5 ${font};color:${dark ? '#ffffff' : '#1b1b1b'}}
.aurora-text{white-space:pre-wrap;word-wrap:break-word;overflow-wrap:anywhere}a{color:${dark ? accentDark : accent}}
blockquote.q{margin:2px 0;padding-left:10px;border-left:3px solid ${dark ? '#5c5c5c' : '#c8c8c8'};color:${dark ? '#c5c5c5' : '#5c5c5c'}}`;
  const srcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"><base target="_blank"><style>${base}</style>${head}</head><body>${body}</body></html>`;
  return { srcdoc, remote: counter.remote, isHtml };
}

// ---------------------------------------------------------------- composer quoting (allow-list rebuild)
const KEEP = new Set(['a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'cite', 'code', 'col', 'colgroup', 'dd', 'del', 'div', 'dl', 'dt', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 'q', 's', 'small', 'span', 'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul']);
const RENAME = { center: 'div', font: 'span', strike: 's', tt: 'code', big: 'span', article: 'div', section: 'div', header: 'div', footer: 'div', main: 'div', nav: 'div', aside: 'div', figure: 'div', figcaption: 'div', address: 'div' };
const SKIP = new Set(['script', 'style', 'head', 'title', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'noscript', 'template', 'svg', 'math', 'input', 'button', 'select', 'textarea', 'option', 'video', 'audio', 'canvas', 'meta', 'link', 'base', 'map', 'area', 'form', 'dialog']);
const CSS_PROPS = new Set([
  'color', 'background-color', 'font-weight', 'font-style', 'font-size', 'font-family', 'font-variant', 'text-decoration', 'text-decoration-line', 'text-align', 'text-indent', 'text-transform',
  'line-height', 'letter-spacing', 'word-spacing', 'white-space', 'vertical-align', 'list-style-type', 'margin', 'margin-top', 'margin-bottom', 'margin-left', 'margin-right', 'padding', 'padding-top',
  'padding-bottom', 'padding-left', 'padding-right', 'border', 'border-top', 'border-bottom', 'border-left', 'border-right', 'border-color', 'border-style', 'border-width', 'border-collapse',
  'border-spacing', 'border-radius', 'width', 'max-width', 'min-width', 'height', 'direction',
]);
const ATTRS = { a: ['href', 'title'], img: ['src', 'alt', 'title', 'width', 'height'], td: ['colspan', 'rowspan', 'align', 'valign', 'width', 'bgcolor'], th: ['colspan', 'rowspan', 'align', 'valign', 'width', 'bgcolor'], table: ['width', 'align', 'border', 'cellpadding', 'cellspacing', 'bgcolor'], col: ['span', 'width'], colgroup: ['span', 'width'], ol: ['start', 'type'], li: ['value'], p: ['align'], div: ['align'], h1: ['align'], h2: ['align'], h3: ['align'], tr: ['align', 'valign', 'bgcolor'] };
const COMMON = ['dir', 'lang', 'title'];
// Class names the composer itself uses (signature, quote header…); any other class is dropped.
const OWN_CLASSES = new Set(['ml-signature', 'ml-quote-head', 'ml-quote', 'ml-forwarded']);

function cleanStyle(value) {
  const out = [];
  for (const decl of String(value || '').split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    const val = decl.slice(i + 1).trim();
    if (!CSS_PROPS.has(prop) || !val || val.length > 200) continue;
    if (/url\s*\(|expression|javascript|behavior|@import|[<>\\]|-moz-binding/i.test(val)) continue;
    out.push(`${prop}: ${val}`);
  }
  return out.join('; ');
}

function cleanAttr(tag, name, value, cids) {
  const v = String(value || '').trim();
  if (name === 'href') return tag === 'a' ? safeHref(v) : null;
  if (name === 'src') {
    if (/^cid:/i.test(v)) return cids?.[v.slice(4)] || null;
    if (/^data:image\/(png|jpe?g|gif|webp|bmp);base64,[a-z0-9+/=\s]+$/i.test(v)) return v;
    return null; // remote images are never loaded into the shell document
  }
  if (['width', 'height', 'colspan', 'rowspan', 'border', 'cellpadding', 'cellspacing', 'span', 'start', 'value'].includes(name)) return /^\d{1,4}%?$/.test(v) ? v : null;
  if (name === 'bgcolor') return /^#?[0-9a-f]{3,8}$|^[a-z]{3,20}$/i.test(v) ? v : null;
  if (['align', 'valign', 'dir', 'type'].includes(name)) return /^[a-z0-9-]{1,12}$/i.test(v) ? v : null;
  if (['alt', 'title', 'lang'].includes(name)) return v.slice(0, 300);
  return null;
}

/** Rebuild untrusted HTML into a DocumentFragment of `target` document (allow-list only). */
export function sanitizeForCompose(html, cids = {}, target = document) {
  const src = new DOMParser().parseFromString(String(html || ''), 'text/html');
  const frag = target.createDocumentFragment();
  let count = 0;
  const copy = (node, parent, depth) => {
    if (depth > 60 || count > 20000) return;
    for (const child of [...node.childNodes]) {
      count++;
      if (child.nodeType === 3) {
        parent.appendChild(target.createTextNode(child.nodeValue));
        continue;
      }
      if (child.nodeType !== 1) continue;
      let tag = child.localName;
      if (SKIP.has(tag)) continue;
      if (RENAME[tag]) tag = RENAME[tag];
      if (!KEEP.has(tag)) {
        copy(child, parent, depth + 1); // unknown element: keep its content
        continue;
      }
      const el = target.createElement(tag);
      for (const name of [...(ATTRS[tag] || []), ...COMMON]) {
        if (!child.hasAttribute(name)) continue;
        const v = cleanAttr(tag, name, child.getAttribute(name), cids);
        if (v != null) el.setAttribute(name, v);
      }
      const style = child.getAttribute('style');
      let css = style ? cleanStyle(style) : '';
      if (child.localName === 'font') {
        const color = child.getAttribute('color');
        if (color && /^#?[0-9a-f]{3,8}$|^[a-z]{3,20}$/i.test(color)) css = `color: ${color}${css ? `; ${css}` : ''}`;
        const face = child.getAttribute('face');
        if (face && /^[\w\s,'"-]{1,80}$/.test(face)) css = `font-family: ${face}${css ? `; ${css}` : ''}`;
      }
      if (css) el.setAttribute('style', css);
      const cls = (child.getAttribute('class') || '').split(/\s+/).filter((c) => OWN_CLASSES.has(c));
      if (cls.length) el.className = cls.join(' ');
      if (tag === 'img' && !el.hasAttribute('src')) {
        const alt = child.getAttribute('alt');
        if (alt) parent.appendChild(target.createTextNode(`[${alt.slice(0, 100)}]`));
        continue;
      }
      if (tag === 'a' && el.hasAttribute('href')) el.setAttribute('rel', 'noopener noreferrer');
      copy(child, el, depth + 1);
      parent.appendChild(el);
    }
  };
  if (src.body) copy(src.body, frag, 0);
  return frag;
}

// Serialize composer content for sending (it only ever holds allow-listed or user-typed markup).
export function plainToComposeHtml(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => `<div>${l ? escapeHtml(l) : '<br>'}</div>`)
    .join('');
}
