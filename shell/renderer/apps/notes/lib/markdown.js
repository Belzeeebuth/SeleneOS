// Markdown <-> Notes HTML.
//   htmlToMarkdown(rootElement, { image(img) -> url }) -> string   (GitHub-flavoured: tables, task lists, ~~, ```)
//   markdownToHtml(text) -> HTML string (to be passed through the sanitizer before use)
//   markdownTitle(text) -> { title, body }   a leading "# Heading" becomes the note title
// Supported on import: ATX headings, paragraphs (soft line breaks joined, hard breaks kept), > quotes
// (nested content), - * + and 1. lists with nesting, - [ ] / - [x] task lists, ``` / ~~~ fences,
// indented code, --- *** ___ rules, pipe tables, **bold** __bold__ *italic* _italic_ ~~strike~~
// ==highlight== `code` [links](url) <autolinks> ![images](src), <u>…</u>, backslash escapes.
import { escapeHtml } from './sanitize.js';

// ---------------------------------------------------------------- HTML -> Markdown
function escText(s, { table = false } = {}) {
  // characters that would start Markdown syntax; ~~ and == only when doubled (single ones are harmless)
  let out = s.replace(table ? /([\\`*_[\]<|])/g : /([\\`*_[\]<])/g, '\\$1');
  out = out.replace(/~~/g, '\\~\\~').replace(/==/g, '\\=\\=');
  return out;
}

function escLineStart(s) {
  // block markers at the start of a line would change the structure on import
  return s
    .replace(/^(\s*)(\d+)([.)])(\s|$)/, '$1$2\\$3$4')
    .replace(/^(\s*)(#{1,6}(?:\s|$)|>|[-+](?:\s|$)|-{3,}\s*$)/, (m, sp, mk) => `${sp}\\${mk}`);
}

export function htmlToMarkdown(root, opts = {}) {
  const image = opts.image || ((img) => img.getAttribute('src') || '');
  // scratch elements live in the root's document (an inert one for exports: pictures are never fetched)
  const doc = root.ownerDocument || document;

  const inline = (node, ctx = {}) => {
    let out = '';
    for (let n = node.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3) {
        const t = n.data.replace(/\u200b/g, '');
        out += ctx.code ? t : escText(t, ctx);
        continue;
      }
      if (n.nodeType !== 1) continue;
      const tag = n.tagName;
      const inner = () => inline(n, ctx);
      switch (tag) {
        case 'BR':
          out += ctx.table ? '<br>' : '\\\n';
          break;
        case 'B':
        case 'STRONG':
          out += wrapMark(inner(), '**');
          break;
        case 'I':
        case 'EM':
          out += wrapMark(inner(), '*');
          break;
        case 'S':
        case 'DEL':
        case 'STRIKE':
          out += wrapMark(inner(), '~~');
          break;
        case 'U':
          out += `<u>${inner()}</u>`;
          break;
        case 'MARK':
          out += wrapMark(inner(), '==');
          break;
        case 'CODE': {
          const t = n.textContent.replace(/\u200b/g, '');
          const ticks = t.includes('`') ? '``' : '`';
          out += t ? `${ticks}${ticks.length > 1 ? ' ' : ''}${t}${ticks.length > 1 ? ' ' : ''}${ticks}` : '';
          break;
        }
        case 'A': {
          const href = n.getAttribute('href') || '';
          const text = inner();
          out += href ? `[${text || href}](${href.replace(/[()\s]/g, (c) => encodeURIComponent(c))})` : text;
          break;
        }
        case 'IMG': {
          const src = image(n);
          if (src) out += `![${escText(n.getAttribute('alt') || '')}](${src.replace(/[()\s]/g, (c) => encodeURIComponent(c))})`;
          break;
        }
        default:
          if (isBlockEl(n)) out += inline(n, ctx); // stray block inside inline content
          else out += inner();
      }
    }
    return out;
  };

  const blocks = (node, indent = '') => {
    const parts = [];
    let pendingInline = null;
    const flushInline = () => {
      if (pendingInline != null) {
        const t = pendingInline.trim();
        if (t) parts.push(t.split('\n').map((l, i) => (i ? indent : '') + escLineStart(l)).join('\n'));
      }
      pendingInline = null;
    };
    for (let n = node.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3 || (n.nodeType === 1 && !isBlockEl(n))) {
        const box = doc.createElement('span');
        box.appendChild(n.cloneNode(true));
        pendingInline = (pendingInline || '') + inline(box);
        continue;
      }
      if (n.nodeType !== 1) continue;
      flushInline();
      const tag = n.tagName;
      if (tag === 'H1' || tag === 'H2' || tag === 'H3') {
        const t = inline(n).trim();
        if (t) parts.push(`${'#'.repeat(Number(tag[1]))} ${t.replace(/\n/g, ' ')}`);
      } else if (tag === 'P' || tag === 'DIV') {
        if (hasBlockChild(n)) {
          const inner = blocks(n, indent);
          if (inner) parts.push(inner);
        } else {
          const t = inline(n).replace(/\s+$/, '');
          if (t.trim()) parts.push(t.split('\n').map((l, i) => (i ? indent : '') + escLineStart(l)).join('\n'));
        }
      } else if (tag === 'BLOCKQUOTE') {
        const inner = hasBlockChild(n) ? blocks(n) : escLineStart(inline(n).trim());
        if (inner.trim()) parts.push(inner.split('\n').map((l) => (l ? `${indent}> ${l}` : `${indent}>`)).join('\n').replace(/^ +/, ''));
      } else if (tag === 'PRE') {
        const code = n.textContent.replace(/\u200b/g, '').replace(/\n$/, '');
        const fence = code.includes('```') ? '~~~' : '```';
        parts.push(`${fence}\n${code}\n${fence}`.split('\n').map((l, i) => (i ? indent + l : l)).join('\n'));
      } else if (tag === 'UL' || tag === 'OL') {
        parts.push(list(n, indent));
      } else if (tag === 'HR') {
        parts.push('---');
      } else if (tag === 'TABLE') {
        const t = table(n);
        if (t) parts.push(t);
      } else if (tag === 'LI') {
        parts.push(inline(n).trim());
      } else {
        const inner = blocks(n, indent);
        if (inner) parts.push(inner);
      }
    }
    flushInline();
    return parts.join(`\n\n${indent}`);
  };

  const list = (el, indent) => {
    const ordered = el.tagName === 'OL';
    const check = el.dataset?.type === 'checklist';
    let num = Number(el.getAttribute('start') || 1);
    const lines = [];
    for (const li of el.children) {
      if (li.tagName !== 'LI') continue;
      const marker = ordered ? `${num++}.` : '-';
      const box = check ? (li.dataset.checked === 'true' ? '[x] ' : '[ ] ') : '';
      const pad = ' '.repeat(marker.length + 1);
      // the item's own text (paragraph children joined by line breaks), then nested lists / blocks
      const own = doc.createElement('div');
      const nested = [];
      for (const c of li.childNodes) {
        if (c.nodeType === 1 && (c.tagName === 'UL' || c.tagName === 'OL')) nested.push(list(c, indent + pad));
        else if (c.nodeType === 1 && /^(P|DIV|H[1-6])$/.test(c.tagName) && !hasBlockChild(c)) {
          if (own.childNodes.length) own.appendChild(doc.createElement('br'));
          for (const k of c.childNodes) own.appendChild(k.cloneNode(true));
        } else if (c.nodeType === 1 && isBlockEl(c)) {
          const b = blocks(wrapIn(c), indent + pad);
          if (b) nested.push(`${indent}${pad}${b}`);
        } else own.appendChild(c.cloneNode(true));
      }
      const text = inline(own).trim().replace(/\n/g, `\n${indent}${pad}`);
      lines.push(`${indent}${marker} ${box}${text}`.replace(/ +$/, ''));
      for (const n of nested) lines.push(n);
    }
    return lines.join('\n');
  };

  const table = (el) => {
    const rows = [...el.querySelectorAll('tr')].filter((tr) => tr.closest('table') === el);
    if (!rows.length) return '';
    const grid = rows.map((tr) => [...tr.children].filter((c) => c.tagName === 'TD' || c.tagName === 'TH').map((c) => inline(c, { table: true }).replace(/\n/g, '<br>').trim()));
    const cols = Math.max(...grid.map((r) => r.length), 1);
    for (const r of grid) while (r.length < cols) r.push('');
    const line = (r) => `| ${r.map((c) => c || ' ').join(' | ')} |`;
    return [line(grid[0]), `| ${Array(cols).fill('---').join(' | ')} |`, ...grid.slice(1).map(line)].join('\n');
  };

  return `${blocks(root).replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

function wrapIn(el) {
  const d = (el.ownerDocument || document).createElement('div');
  d.appendChild(el.cloneNode(true));
  return d;
}

function wrapMark(s, mark) {
  if (!s.trim()) return s;
  // markers must hug the text: move surrounding spaces outside
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s);
  return `${m[1]}${mark}${m[2]}${mark}${m[3]}`;
}

const BLOCK_EL = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'UL', 'OL', 'LI', 'HR', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH']);
function isBlockEl(n) {
  return n.nodeType === 1 && BLOCK_EL.has(n.tagName);
}
function hasBlockChild(n) {
  for (const c of n.children) if (isBlockEl(c)) return true;
  return false;
}

// ---------------------------------------------------------------- Markdown -> HTML
export function markdownTitle(text) {
  const src = String(text || '').replace(/^\ufeff/, '');
  const m = /^\s*#[ \t]+(.+?)[ \t]*#*[ \t]*(?:\n|$)/.exec(src);
  if (!m) return { title: '', body: src };
  return { title: m[1].replace(/\\([\\`*_[\]{}()#+\-.!<>~=|])/g, '$1').trim(), body: src.slice(m[0].length) };
}

export function markdownToHtml(text) {
  const lines = String(text || '')
    .replace(/^\ufeff/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '    ')
    .split('\n');
  return parseBlocks(lines);
}

const RE = {
  heading: /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/,
  headingEmpty: /^ {0,3}(#{1,6})[ \t]*$/,
  hr: /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/,
  fence: /^( {0,3})(`{3,}|~{3,})[ \t]*([\w+-]*)[^`]*$/,
  quote: /^ {0,3}> ?(.*)$/,
  bullet: /^( *)([-*+])[ \t]+(.*)$/,
  ordered: /^( *)(\d{1,9})[.)][ \t]+(.*)$/,
  bulletEmpty: /^( *)([-*+]|\d{1,9}[.)])[ \t]*$/,
  tableSep: /^ {0,3}\|?[ \t]*:?-{1,}:?[ \t]*(\|[ \t]*:?-{1,}:?[ \t]*)*\|?[ \t]*$/,
  indentedCode: /^ {4}(.*)$/,
};

function parseBlocks(lines) {
  const out = [];
  let i = 0;
  let para = [];
  const flushPara = () => {
    if (!para.length) return;
    // soft breaks join with a space; a trailing backslash or two spaces is a hard break
    let html = '';
    para.forEach((l, k) => {
      const hard = /(\\| {2,})$/.test(l) && k < para.length - 1;
      const clean = l.replace(/(\\| {2,})$/, '').trim();
      html += inlineMd(clean) + (k < para.length - 1 ? (hard ? '<br>' : ' ') : '');
    });
    out.push(`<p>${html}</p>`);
    para = [];
  };
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      flushPara();
      i++;
      continue;
    }
    let m;
    if ((m = RE.fence.exec(line))) {
      flushPara();
      const fence = m[2];
      const code = [];
      i++;
      while (i < lines.length && !new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}[ \\t]*$`).test(lines[i])) {
        code.push(lines[i].replace(new RegExp(`^ {0,${m[1].length}}`), ''));
        i++;
      }
      i++; // closing fence (or EOF)
      out.push(`<pre>${escapeHtml(code.join('\n'))}</pre>`);
      continue;
    }
    if ((m = RE.heading.exec(line)) || (m = RE.headingEmpty.exec(line))) {
      flushPara();
      const level = Math.min(3, m[1].length);
      out.push(`<h${level}>${inlineMd((m[2] || '').trim())}</h${level}>`);
      i++;
      continue;
    }
    if (RE.hr.test(line) && !(para.length && /^ {0,3}-+[ \t]*$/.test(line))) {
      flushPara();
      out.push('<hr>');
      i++;
      continue;
    }
    if (para.length && /^ {0,3}(=+|-+)[ \t]*$/.test(line)) {
      // setext heading
      const level = line.trim()[0] === '=' ? 1 : 2;
      const title = para.join(' ').trim();
      para = [];
      out.push(`<h${level}>${inlineMd(title)}</h${level}>`);
      i++;
      continue;
    }
    if (RE.quote.test(line)) {
      flushPara();
      const inner = [];
      while (i < lines.length && lines[i].trim() && (m = RE.quote.exec(lines[i]))) {
        inner.push(m[1]);
        i++;
      }
      const html = parseBlocks(inner);
      // a quote with a single paragraph stays flat (<blockquote>text</blockquote>)
      const single = /^<p>([\s\S]*)<\/p>$/.exec(html);
      out.push(`<blockquote>${single && !single[1].includes('<p>') ? single[1] : html}</blockquote>`);
      continue;
    }
    if (RE.bullet.test(line) || RE.ordered.test(line)) {
      flushPara();
      const res = parseList(lines, i);
      out.push(res.html);
      i = res.next;
      continue;
    }
    if (!para.length && RE.indentedCode.test(line)) {
      const code = [];
      while (i < lines.length && (RE.indentedCode.test(lines[i]) || !lines[i].trim())) {
        code.push(lines[i].replace(/^ {4}/, ''));
        i++;
      }
      while (code.length && !code[code.length - 1].trim()) code.pop();
      out.push(`<pre>${escapeHtml(code.join('\n'))}</pre>`);
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && RE.tableSep.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      flushPara();
      const rows = [splitRow(line)];
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      const cols = Math.max(...rows.map((r) => r.length));
      const tr = (r, tag) => `<tr>${Array.from({ length: cols }, (_, k) => `<${tag}>${inlineMd(r[k] || '')}</${tag}>`).join('')}</tr>`;
      out.push(`<table><tbody>${tr(rows[0], 'th')}${rows.slice(1).map((r) => tr(r, 'td')).join('')}</tbody></table>`);
      continue;
    }
    para.push(line);
    i++;
  }
  flushPara();
  return out.join('');
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let k = 0; k < s.length; k++) {
    if (s[k] === '\\' && s[k + 1] === '|') {
      cur += '\\|';
      k++;
    } else if (s[k] === '|') {
      cells.push(cur.trim());
      cur = '';
    } else cur += s[k];
  }
  cells.push(cur.trim());
  return cells.map((c) => c.replace(/<br\s*\/?>/gi, '\u0001'));
}

function parseList(lines, start) {
  const first = RE.bullet.exec(lines[start]) || RE.ordered.exec(lines[start]);
  const baseIndent = first[1].length;
  const ordered = !RE.bullet.test(lines[start]);
  const items = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    const m = ordered ? RE.ordered.exec(line) : RE.bullet.exec(line);
    if (m && m[1].length === baseIndent) {
      items.push({ text: [m[3]], children: [], start: ordered ? Number(m[2]) : 1 });
      i++;
      continue;
    }
    if (!items.length) break;
    if (!line.trim()) {
      // a blank line ends the list unless the next line continues it (same marker or indented content)
      const next = lines[i + 1] || '';
      const nm = RE.bullet.exec(next) || RE.ordered.exec(next);
      if ((nm && nm[1].length >= baseIndent && (nm[1].length > baseIndent || (ordered ? RE.ordered : RE.bullet).test(next))) || (/^ +\S/.test(next) && next.match(/^ */)[0].length > baseIndent)) {
        i++;
        continue;
      }
      break;
    }
    const indent = line.match(/^ */)[0].length;
    if (indent > baseIndent) {
      items[items.length - 1].children.push(line.slice(Math.min(indent, baseIndent + 2 + (ordered ? 1 : 0))));
      i++;
      continue;
    }
    // lazy continuation of the item's paragraph
    if (!RE.bullet.test(line) && !RE.ordered.test(line) && !RE.heading.test(line) && !RE.quote.test(line) && !RE.fence.test(line) && !RE.hr.test(line)) {
      items[items.length - 1].text.push(line.trim());
      i++;
      continue;
    }
    break;
  }
  let task = false;
  const lis = items.map((it) => {
    let text = it.text.join(' ');
    let attr = '';
    const tm = /^\[([ xX])\][ \t]+(.*)$/.exec(text) || /^\[([ xX])\]$/.exec(text);
    if (!ordered && tm) {
      task = true;
      attr = ` data-checked="${tm[1] === ' ' ? 'false' : 'true'}"`;
      text = tm[2] || '';
    }
    let nested = '';
    if (it.children.length) {
      // dedent children to their common indentation
      const min = Math.min(...it.children.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length));
      nested = parseBlocks(it.children.map((l) => l.slice(Number.isFinite(min) ? min : 0)));
    }
    return `<li${attr}>${inlineMd(text)}${nested}</li>`;
  });
  const startAttr = ordered && items[0]?.start !== 1 ? ` start="${items[0].start}"` : '';
  const html = ordered ? `<ol${startAttr}>${lis.join('')}</ol>` : `<ul${task ? ' data-type="checklist"' : ''}>${lis.map((l) => (task && !l.startsWith('<li data-checked') ? l.replace('<li>', '<li data-checked="false">') : l)).join('')}</ul>`;
  return { html, next: i };
}

// Inline Markdown -> HTML. Code spans and escapes are protected first, then links / images, then emphasis.
export function inlineMd(src) {
  const slots = [];
  const keep = (html) => `\u0002${slots.push(html) - 1}\u0003`;
  let s = String(src || '');
  // code spans
  s = s.replace(/(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g, (m, ticks, code) => keep(`<code>${escapeHtml(code.replace(/^ (.*) $/, '$1'))}</code>`));
  // backslash escapes
  s = s.replace(/\\([\\`*_[\]{}()#+\-.!<>~=|])/g, (m, c) => keep(escapeHtml(c)));
  // table-cell line breaks
  s = s.replace(/\u0001/g, () => keep('<br>'));
  // images then links
  s = s.replace(/!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"([^"]*)")?\s*\)/g, (m, alt, url) => keep(`<img src="${escapeHtml(decodeSafe(url))}" alt="${escapeHtml(alt)}">`));
  s = s.replace(/\[((?:[^\[\]]|\[[^\]]*\])+)\]\(\s*<?([^)\s>]+)>?(?:\s+"([^"]*)")?\s*\)/g, (m, text, url) => keep(`<a href="${escapeHtml(decodeSafe(url))}">${inlineRest(text, keep)}</a>`));
  s = s.replace(/<((?:https?:\/\/|mailto:)[^>\s]+)>/g, (m, url) => keep(`<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`));
  // the few raw inline tags we accept
  s = s.replace(/<(\/?)(u|mark|br|sub|sup)\s*\/?>/gi, (m, close, tag) => keep(`<${close}${tag.toLowerCase()}>`));
  return inlineRest(s, keep, slots);
}

function decodeSafe(u) {
  try {
    return decodeURI(u);
  } catch {
    return u;
  }
}

function inlineRest(s, keep, slots) {
  let h = escapeHtml(s);
  h = h.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<b>$1</b>');
  h = h.replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, '$1<b>$2</b>');
  h = h.replace(/(^|[^*])\*(?=[^\s*])([^*]*?[^\s*])?\*(?!\*)/g, (m, pre, body) => (body === undefined ? m : `${pre}<i>${body}</i>`));
  h = h.replace(/(^|[^*])\*([^\s*])\*(?!\*)/g, '$1<i>$2</i>');
  h = h.replace(/(^|[^\w])_(?=\S)([^_]*?\S)_(?!\w)/g, '$1<i>$2</i>');
  h = h.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<s>$1</s>');
  h = h.replace(/==(?=\S)([\s\S]*?\S)==/g, '<mark>$1</mark>');
  if (slots) {
    // restore protected pieces (nested: a link text may itself contain slots)
    for (let k = 0; k < 3 && h.includes('\u0002'); k++) h = h.replace(/\u0002(\d+)\u0003/g, (m, n) => slots[Number(n)] ?? '');
  }
  return h;
}
