// DOM helpers for the Notes rich-text editor (contenteditable): blocks, selection save / restore,
// inline formatting that never nests the same format twice, fragment insertion with block splitting.
export const LEAF_BLOCKS = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'BLOCKQUOTE', 'PRE', 'LI', 'TD', 'TH']);
export const CONTAINERS = new Set(['UL', 'OL', 'TABLE', 'THEAD', 'TBODY', 'TR']);
export const INLINE_FORMATS = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'DEL', 'MARK', 'CODE', 'SPAN', 'FONT', 'SUB', 'SUP']);
export const ZWSP = '\u200b';

export function isBlock(n) {
  return n?.nodeType === 1 && (LEAF_BLOCKS.has(n.tagName) || CONTAINERS.has(n.tagName) || n.tagName === 'HR');
}

/** Nearest block element (p, div, h1-3, blockquote, pre, li, td, th) containing node, inside root. */
export function closestBlock(node, root) {
  let n = node?.nodeType === 1 ? node : node?.parentNode;
  while (n && n !== root) {
    if (n.nodeType === 1 && LEAF_BLOCKS.has(n.tagName)) return n;
    n = n.parentNode;
  }
  return null;
}

/** Direct child of root containing node. */
export function topBlock(node, root) {
  let n = node;
  while (n && n.parentNode !== root) n = n.parentNode;
  return n && n.parentNode === root ? n : null;
}

export function closest(node, sel, root) {
  const el = node?.nodeType === 1 ? node : node?.parentElement;
  const hit = el?.closest?.(sel);
  return hit && root.contains(hit) && hit !== root ? hit : null;
}

/** The editor's current range (only when the selection is inside root). */
export function editorRange(root) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  return root.contains(r.commonAncestorContainer) ? r : null;
}

// ---------------------------------------------------------------- selection by path (undo history)
function pathOf(node, root) {
  const path = [];
  let n = node;
  while (n && n !== root) {
    const p = n.parentNode;
    if (!p) return null;
    path.unshift(Array.prototype.indexOf.call(p.childNodes, n));
    n = p;
  }
  return n === root ? path : null;
}
function nodeAt(path, root) {
  let n = root;
  for (const i of path || []) {
    if (!n.childNodes[i]) return null;
    n = n.childNodes[i];
  }
  return n;
}

export function saveSelection(root) {
  const sel = window.getSelection();
  if (!sel?.rangeCount || !root.contains(sel.anchorNode) || !root.contains(sel.focusNode)) return null;
  const a = pathOf(sel.anchorNode, root);
  const f = pathOf(sel.focusNode, root);
  if (!a || !f) return null;
  return { a, ao: sel.anchorOffset, f, fo: sel.focusOffset };
}

export function restoreSelection(root, s) {
  const sel = window.getSelection();
  if (!s) return caretAtEnd(root);
  const an = nodeAt(s.a, root);
  const fn = nodeAt(s.f, root);
  if (!an || !fn) return caretAtEnd(root);
  const clamp = (n, o) => Math.min(o, n.nodeType === 3 ? n.length : n.childNodes.length);
  try {
    sel.setBaseAndExtent(an, clamp(an, s.ao), fn, clamp(fn, s.fo));
  } catch {
    caretAtEnd(root);
  }
}

// Selection by node references (survives moving nodes, not removing them).
export function saveRefs(root) {
  const sel = window.getSelection();
  if (!sel?.rangeCount || !root.contains(sel.anchorNode)) return null;
  return { an: sel.anchorNode, ao: sel.anchorOffset, fn: sel.focusNode, fo: sel.focusOffset };
}
export function restoreRefs(root, r) {
  if (!r || !root.contains(r.an) || !root.contains(r.fn)) return false;
  const clamp = (n, o) => Math.min(o, n.nodeType === 3 ? n.length : n.childNodes.length);
  try {
    window.getSelection().setBaseAndExtent(r.an, clamp(r.an, r.ao), r.fn, clamp(r.fn, r.fo));
    return true;
  } catch {
    return false;
  }
}

export function caretAtEnd(el) {
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}
export function caretAtStart(el) {
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}
export function setCaret(node, offset) {
  const r = document.createRange();
  r.setStart(node, offset);
  r.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}
export function selectNodes(first, last) {
  const r = document.createRange();
  r.setStartBefore(first);
  r.setEndAfter(last);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

// ---------------------------------------------------------------- structure
export function unwrap(el) {
  const p = el.parentNode;
  if (!p) return;
  while (el.firstChild) p.insertBefore(el.firstChild, el);
  el.remove();
}

/** Replace an element by a new tag, keeping its children (and their identity). */
export function retag(el, tag) {
  if (el.tagName === tag.toUpperCase()) return el;
  const n = document.createElement(tag);
  while (el.firstChild) n.appendChild(el.firstChild);
  el.replaceWith(n);
  return n;
}

/** Split `ancestor` around `node` so the returned element (the original ancestor) contains only node's path. */
export function isolate(node, ancestor) {
  let cur = node;
  while (cur !== ancestor) {
    const parent = cur.parentNode;
    if (!parent) break;
    if (cur.previousSibling) {
      const before = parent.cloneNode(false);
      while (parent.firstChild !== cur) before.appendChild(parent.firstChild);
      parent.parentNode.insertBefore(before, parent);
    }
    if (cur.nextSibling) {
      const after = parent.cloneNode(false);
      while (cur.nextSibling) after.appendChild(cur.nextSibling);
      parent.parentNode.insertBefore(after, parent.nextSibling);
    }
    cur = parent;
  }
  return ancestor;
}

/** Top-level runs of inline content are wrapped in <div>s (the browser sometimes leaves bare text). */
export function normalizeRoot(root) {
  let run = null;
  for (const n of [...root.childNodes]) {
    if (isBlock(n)) {
      run = null;
      continue;
    }
    if (n.nodeType === 3 && !n.data && !run) {
      n.remove();
      continue;
    }
    if (n.nodeType === 1 && n.tagName === 'BR') {
      if (run) {
        if (!run.firstChild) run.appendChild(n);
        else n.remove();
      } else {
        const d = document.createElement('div');
        root.insertBefore(d, n);
        d.appendChild(n);
      }
      run = null;
      continue;
    }
    if (!run) {
      run = document.createElement('div');
      root.insertBefore(run, n);
    }
    run.appendChild(n);
  }
  if (!root.firstChild) root.appendChild(emptyLine());
}

/**
 * Keep the body flat: Chromium's list commands can leave blocks nested in a top-level line
 * (<div><ul>…</ul><div>…</div></div>). Such wrappers are unwrapped; their inline runs become lines of their own.
 * Nodes are moved, never recreated, so node-based selections (saveRefs) survive. Returns true when changed.
 */
export function flattenRoot(root) {
  let changed = false;
  for (let guard = 0; guard < 50; guard++) {
    const host = [...root.children].find((n) => (n.tagName === 'DIV' || n.tagName === 'P') && [...n.children].some(isBlock));
    if (!host) break;
    changed = true;
    const out = [];
    let run = null;
    for (const k of [...host.childNodes]) {
      if (isBlock(k)) {
        run = null;
        out.push(k);
        continue;
      }
      if (k.nodeType === 3 && !k.data.trim() && !run) continue;
      if (!run) {
        run = host.cloneNode(false);
        out.push(run);
      }
      run.appendChild(k);
      if (k.nodeName === 'BR') run = null;
    }
    host.replaceWith(...out);
  }
  return changed;
}

/** Deepest last block where a caret can go at the end of el (last list item, last table cell...). */
export function lastLeaf(el) {
  let n = el;
  while (n?.nodeType === 1 && n.lastElementChild && (CONTAINERS.has(n.tagName) || LEAF_BLOCKS.has(n.lastElementChild.tagName) || CONTAINERS.has(n.lastElementChild.tagName))) n = n.lastElementChild;
  return n;
}

export function emptyLine(tag = 'div') {
  const d = document.createElement(tag);
  d.appendChild(document.createElement('br'));
  return d;
}

export function isEmptyBlock(el) {
  return !el.textContent.replace(/[\u200b\s]/g, '') && !el.querySelector('img, hr, table');
}

/** Leaf blocks touched by a range, in document order. Text directly in root is wrapped first. */
export function blocksInRange(root, range) {
  const out = [];
  const startB = closestBlock(range.startContainer, root);
  const endB = closestBlock(range.endContainer, root);
  if (startB && startB === endB) return [startB];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
    acceptNode: (n) => (LEAF_BLOCKS.has(n.tagName) && range.intersectsNode(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
  });
  const all = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) all.push(n);
  // keep only innermost blocks
  for (const n of all) if (!all.some((o) => o !== n && n.contains(o))) out.push(n);
  // a range ending at offset 0 of a block doesn't really select it
  if (out.length > 1 && range.endOffset === 0 && closestBlock(range.endContainer, root) === out[out.length - 1]) out.pop();
  return out.length ? out : [startB || endB].filter(Boolean);
}

// ---------------------------------------------------------------- inline formatting
function splitBoundaries(range) {
  let sc = range.startContainer;
  let so = range.startOffset;
  let ec = range.endContainer;
  let eo = range.endOffset;
  if (ec.nodeType === 3 && eo > 0 && eo < ec.length) ec.splitText(eo);
  if (sc.nodeType === 3 && so > 0 && so < sc.length) {
    const tail = sc.splitText(so);
    if (ec === sc) {
      ec = tail;
      eo -= so;
    }
    sc = tail;
    so = 0;
  }
  range.setStart(sc, so);
  range.setEnd(ec, eo);
}

export function textNodesIn(range, root) {
  const out = [];
  const anc = range.commonAncestorContainer;
  if (anc.nodeType === 3) return anc.length ? [anc] : [];
  const walker = document.createTreeWalker(anc, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.length || !range.intersectsNode(n) || !root.contains(n)) continue;
    if (n === range.startContainer && range.startOffset >= n.length) continue;
    if (n === range.endContainer && range.endOffset === 0) continue;
    out.push(n);
  }
  return out;
}

/** The word around a collapsed caret, as a range (or null). */
export function wordRange(range) {
  const n = range.startContainer;
  if (n.nodeType !== 3) return null;
  const s = n.data;
  let a = range.startOffset;
  let b = range.startOffset;
  const w = /[\p{L}\p{N}_'’-]/u;
  while (a > 0 && w.test(s[a - 1])) a--;
  while (b < s.length && w.test(s[b])) b++;
  if (a === b) return null;
  const r = document.createRange();
  r.setStart(n, a);
  r.setEnd(n, b);
  return r;
}

/**
 * Apply / change / remove an inline format on the selected text.
 *   match(el)  -> is this element the format (e.g. span[data-color])
 *   make()     -> a new element for the format, or null to remove the format
 *   update(el) -> change an existing format element in place (optional)
 * Returns false when nothing was selected.
 */
export function applyInline(root, range, { match, make, update }) {
  if (range.collapsed) return false;
  splitBoundaries(range);
  const nodes = textNodesIn(range, root);
  if (!nodes.length) return false;
  const touched = [];
  for (const t of nodes) {
    let anc = null;
    for (let p = t.parentNode; p && p !== root && !LEAF_BLOCKS.has(p.tagName); p = p.parentNode) if (match(p)) anc = p;
    const fresh = make();
    if (anc) {
      const piece = isolate(t, anc);
      if (!fresh) unwrap(piece);
      else if (update) update(piece);
      else {
        piece.replaceWith(fresh);
        while (piece.firstChild) fresh.appendChild(piece.firstChild);
      }
    } else if (fresh) {
      t.replaceWith(fresh);
      fresh.appendChild(t);
    }
    touched.push(t);
  }
  const blocks = new Set(touched.map((t) => closestBlock(t, root) || root));
  for (const b of blocks) mergeSiblings(b);
  const first = touched[0];
  const last = touched[touched.length - 1];
  const r = document.createRange();
  r.setStart(first, 0);
  r.setEnd(last, last.length);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
  return true;
}

/** Does every selected text node sit inside an element matching `match`? */
export function allInside(root, range, match) {
  const nodes = range.collapsed ? [range.startContainer] : textNodesIn(range, root);
  if (!nodes.length) return false;
  return nodes.every((t) => {
    for (let p = t.nodeType === 1 ? t : t.parentNode; p && p !== root; p = p.parentNode) if (p.nodeType === 1 && match(p)) return true;
    return false;
  });
}

function sameFormat(a, b) {
  if (!a || !b || a.nodeType !== 1 || b.nodeType !== 1 || a.tagName !== b.tagName || !INLINE_FORMATS.has(a.tagName)) return false;
  if (a.attributes.length !== b.attributes.length) return false;
  for (const at of a.attributes) if (b.getAttribute(at.name) !== at.value) return false;
  return true;
}

/** Merge adjacent identical inline elements and drop empty ones under el. */
export function mergeSiblings(el) {
  for (const c of [...el.querySelectorAll('b,i,u,s,mark,code,span,sub,sup,strike,strong,em')]) {
    if (!c.isConnected) continue;
    if (!c.firstChild) {
      c.remove();
      continue;
    }
    let next = c.nextSibling;
    while (next && sameFormat(c, next)) {
      while (next.firstChild) c.appendChild(next.firstChild);
      const n2 = next.nextSibling;
      next.remove();
      next = n2;
    }
  }
}

// ---------------------------------------------------------------- inserting content
/** Insert inline nodes at the caret (replacing the selection). Leaves the caret after them. */
export function insertInline(root, range, nodes) {
  range.deleteContents();
  const frag = document.createDocumentFragment();
  for (const n of nodes) frag.appendChild(n);
  const last = frag.lastChild;
  range.insertNode(frag);
  if (last) {
    const r = document.createRange();
    r.setStartAfter(last);
    r.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }
}

/**
 * Insert a fragment of sanitized blocks at the caret. The current top-level line is split around the
 * caret; inside lists, tables, quotes and code blocks the blocks are flattened to lines instead.
 */
export function insertFragment(root, range, frag) {
  const nodes = [...frag.childNodes];
  if (!nodes.length) return;
  if (!nodes.some(isBlock)) return insertInline(root, range, nodes);
  range.deleteContents();
  const top = topBlock(range.startContainer === root ? root.childNodes[range.startOffset] || root.lastChild : range.startContainer, root);
  const simple = top && ['DIV', 'P', 'H1', 'H2', 'H3'].includes(top.tagName) && !top.querySelector('ul, ol, table, pre, blockquote, div, p');
  // several plain lines pasted into a list item become list items (as in Word / OneNote)
  const li = closest(range.startContainer, 'li', root);
  const lineLike = (n) => !isBlock(n) || (['DIV', 'P', 'H1', 'H2', 'H3', 'LI'].includes(n.tagName) && ![...n.children].some(isBlock));
  if (li && !closest(range.startContainer, 'td, th, pre', root) && nodes.every(lineLike)) return insertListLines(range, li, nodes);
  if (!simple) {
    // flatten: block boundaries become line breaks
    const inline = [];
    nodes.forEach((n, i) => {
      if (isBlock(n)) {
        if (i) inline.push(document.createElement('br'));
        const lines = flattenBlock(n);
        lines.forEach((l, k) => {
          if (k) inline.push(document.createElement('br'));
          inline.push(...l);
        });
      } else inline.push(n);
    });
    return insertInline(root, range, inline);
  }
  // split the current line at the caret
  const tail = document.createRange();
  tail.setStart(range.startContainer, range.startOffset);
  tail.setEnd(top, top.childNodes.length);
  const after = top.cloneNode(false);
  after.appendChild(tail.extractContents());
  let anchor = top;
  let first = true;
  let lastInserted = null;
  for (const n of nodes) {
    const node = isBlock(n) ? n : wrapDiv(n);
    // the first pasted line continues the current one when both are plain lines
    if (first && (node.tagName === 'DIV' || node.tagName === 'P') && !isEmptyBlock(top) && !node.querySelector('div,p,ul,ol,table,pre,blockquote,h1,h2,h3')) {
      const kids = [...node.childNodes];
      for (const k of kids) top.appendChild(k);
      lastInserted = top;
      first = false;
      continue;
    }
    first = false;
    anchor.after(node);
    anchor = node;
    lastInserted = node;
  }
  if (isEmptyBlock(top) && lastInserted !== top) top.remove();
  if (!isEmptyBlock(after)) {
    anchor.after(after);
  }
  stripTrailingBr(lastInserted);
  if (lastInserted?.isConnected) {
    // caret at the end of the last pasted block: inside its last list item / table cell, or on the line
    // after a divider
    let target = lastLeaf(lastInserted);
    if (target.tagName === 'HR') {
      const next = target.nextElementSibling;
      if (next && !isBlock(next.firstElementChild) && ['DIV', 'P'].includes(next.tagName)) {
        caretAtStart(next);
        target = null;
      } else {
        const line = emptyLine();
        target.after(line);
        target = line;
      }
    }
    if (target) caretAtEnd(target);
  }
  if (!root.firstChild) root.appendChild(emptyLine());
}

function insertListLines(range, li, nodes) {
  // lines: each block is a line, consecutive inline nodes form one line
  const lines = [];
  let cur = null;
  for (const n of nodes) {
    if (isBlock(n)) {
      cur = null;
      const kids = [...n.childNodes];
      if (kids.length && kids[kids.length - 1].nodeName === 'BR' && kids.length > 1) kids.pop();
      lines.push(kids.filter((k) => !(k.nodeName === 'BR' && kids.length === 1)));
    } else {
      if (!cur) lines.push((cur = []));
      cur.push(n);
    }
  }
  if (!lines.length) return;
  // the rest of the item after the caret goes to the last new item (with its nested list, if any)
  const nested = [...li.children].find((c) => c.tagName === 'UL' || c.tagName === 'OL');
  const tail = document.createRange();
  tail.setStart(range.startContainer, range.startOffset);
  if (nested) tail.setEndBefore(nested);
  else tail.setEnd(li, li.childNodes.length);
  const rest = tail.extractContents();
  const before = nested || null;
  for (const k of lines[0]) li.insertBefore(k, before);
  let last = li;
  for (const line of lines.slice(1)) {
    const item = li.cloneNode(false);
    if (item.hasAttribute('data-checked')) item.setAttribute('data-checked', 'false');
    for (const k of line) item.appendChild(k);
    if (!item.firstChild) item.appendChild(document.createElement('br'));
    last.after(item);
    last = item;
  }
  const caretAfter = last === li ? (nested ? nested.previousSibling : li.lastChild) : last.lastChild;
  if (last !== li && nested) last.appendChild(nested);
  const restNodes = [...rest.childNodes];
  if (restNodes.length) last.insertBefore(rest, last === li && nested ? nested : null);
  if (!last.firstChild || last.firstChild === nested) last.insertBefore(document.createElement('br'), last.firstChild);
  const r = document.createRange();
  if (caretAfter && caretAfter.parentNode === last) r.setStartAfter(caretAfter);
  else r.setStart(last, 0);
  r.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

function stripTrailingBr(el) {
  if (el?.nodeType === 1 && el.lastChild?.nodeName === 'BR' && el.childNodes.length > 1 && el.tagName !== 'PRE') el.lastChild.remove();
}

function wrapDiv(n) {
  const d = document.createElement('div');
  d.appendChild(n);
  return d;
}

function flattenBlock(el) {
  // -> array of lines (arrays of inline nodes)
  const lines = [];
  const leaf = (b) => {
    const kids = [...b.childNodes];
    if (kids.some(isBlock)) {
      for (const k of kids) {
        if (isBlock(k)) leaf(k);
        else if (k.nodeType === 3 ? k.data.trim() : true) lines.push([k]);
      }
    } else lines.push(kids.filter((k) => k.nodeName !== 'BR' || k !== b.lastChild));
  };
  if (el.tagName === 'HR') return [[document.createTextNode('———')]];
  if (el.tagName === 'PRE') return el.textContent.split('\n').map((l) => [document.createTextNode(l)]);
  leaf(el);
  return lines.filter((l) => l.length);
}
