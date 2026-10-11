// List editing for the Notes editor. Chromium's list commands (insertUnorderedList, indent, outdent) merge
// a new list into a neighbouring list of another kind (a checklist typed under a bullet list turned the
// whole bullet list into a checklist), nest lists directly in lists (<ul><ul>…), and drop the checklist
// flag, so lists are built by hand here. Nodes are moved, not recreated, so the caller's node-based
// selection (saveRefs / restoreRefs) survives.
//
//   kinds: 'ul' (bullets) | 'ol' (numbers) | 'check' (<ul data-type="checklist"> + li[data-checked])
//   toggleList(root, blocks, kind)   lines -> list items, items -> another kind, or items of that kind -> lines
//   indentItems(items) / outdentItems(root, items)
//   fixLists(root)                   structural clean-up after browser edits (ul > ul, stray flags, empty lists)
const LIST = new Set(['UL', 'OL']);
const LINE_TAGS = new Set(['DIV', 'P', 'H1', 'H2', 'H3', 'BLOCKQUOTE']);

export const isList = (el) => el?.nodeType === 1 && LIST.has(el.tagName);

export function listKind(list) {
  if (!isList(list)) return null;
  return list.tagName === 'OL' ? 'ol' : list.getAttribute('data-type') === 'checklist' ? 'check' : 'ul';
}

function newList(kind) {
  const el = document.createElement(kind === 'ol' ? 'ol' : 'ul');
  if (kind === 'check') el.setAttribute('data-type', 'checklist');
  return el;
}

function sameKind(a, b) {
  return isList(a) && isList(b) && listKind(a) === listKind(b);
}

/** Make the items' data-checked flags match their list (checklist items always have one). */
function fixFlags(list) {
  const check = listKind(list) === 'check';
  let n = 0;
  for (const li of list.children) {
    if (li.tagName !== 'LI') continue;
    const v = li.getAttribute('data-checked');
    if (check && v !== 'true' && v !== 'false') {
      li.setAttribute('data-checked', 'false');
      n++;
    } else if (!check && v !== null) {
      li.removeAttribute('data-checked');
      n++;
    }
  }
  return n;
}

/** Change a list to another kind (keeps the element when only the checklist flag changes). */
export function setListKind(list, kind) {
  let el = list;
  if ((kind === 'ol') !== (list.tagName === 'OL')) {
    el = newList(kind);
    while (list.firstChild) el.appendChild(list.firstChild);
    list.replaceWith(el);
  }
  if (kind === 'check') el.setAttribute('data-type', 'checklist');
  else el.removeAttribute('data-type');
  fixFlags(el);
  // nested lists of a checklist are checklists too (and stop being so when it changes)
  for (const sub of el.querySelectorAll(':scope > li > ul, :scope > li > ol')) {
    if (kind === 'check' && listKind(sub) !== 'check') setListKind(sub, 'check');
    else if (kind !== 'check' && listKind(sub) === 'check') setListKind(sub, 'ul');
  }
  return el;
}

/** Merge a list with its previous / next sibling when they are lists of the same kind. Returns the list. */
export function mergeAdjacent(list) {
  let el = list;
  const prev = el.previousElementSibling;
  if (sameKind(prev, el)) {
    while (el.firstChild) prev.appendChild(el.firstChild);
    el.remove();
    el = prev;
  }
  const next = el.nextElementSibling;
  if (sameKind(next, el)) {
    while (next.firstChild) el.appendChild(next.firstChild);
    next.remove();
  }
  return el;
}

function lineToItem(line, kind) {
  const li = document.createElement('li');
  while (line.firstChild) li.appendChild(line.firstChild);
  if (!li.firstChild || (li.childNodes.length === 1 && li.firstChild.nodeType === 3 && !li.firstChild.data)) li.appendChild(document.createElement('br'));
  if (kind === 'check') li.setAttribute('data-checked', 'false');
  return li;
}

/** A list item back to a line, splitting its list; its own sub-lists become top-level lists after it. */
function itemToLine(li) {
  const list = li.parentElement;
  const line = document.createElement('div');
  const nested = [];
  for (const c of [...li.childNodes]) {
    if (isList(c)) nested.push(c);
    else line.appendChild(c);
  }
  if (!line.firstChild) line.appendChild(document.createElement('br'));
  const rest = list.cloneNode(false);
  rest.removeAttribute('start');
  while (li.nextSibling) rest.appendChild(li.nextSibling);
  li.remove();
  const after = [line, ...nested];
  if (rest.children.length) after.push(rest);
  list.after(...after);
  if (!list.children.length) list.remove();
  for (const n of nested) mergeAdjacent(n);
  return line;
}

/**
 * Toggle a list kind on the selected blocks (leaf blocks from blocksInRange):
 *   - every block is an item of a list of that kind -> the items become lines
 *   - otherwise lines become items (joining a neighbouring list of the same kind) and the lists holding the
 *     selected items switch to that kind.
 * Returns the first affected element (for the caret when the selection was lost).
 */
export function toggleList(root, blocks, kind) {
  const items = blocks.filter((b) => b.tagName === 'LI');
  const lines = blocks.filter((b) => LINE_TAGS.has(b.tagName) && b.parentNode === root);
  if (!items.length && !lines.length) return null;
  if (!lines.length && items.every((li) => listKind(li.parentElement) === kind)) return itemsToLines(root, items).values().next().value || null;
  let first = null;
  const touched = new Set();
  for (const line of lines) {
    const li = lineToItem(line, kind);
    const prev = line.previousElementSibling;
    if (isList(prev) && listKind(prev) === kind && touched.has(prev)) {
      prev.appendChild(li);
      line.remove();
    } else {
      const list = newList(kind);
      list.appendChild(li);
      line.replaceWith(list);
      touched.add(list);
    }
    first ||= li;
  }
  for (const li of items) {
    const list = li.parentElement;
    if (!isList(list) || touched.has(list)) continue;
    touched.add(listKind(list) === kind ? list : setListKind(list, kind));
    first ||= li;
  }
  for (const list of touched) if (list.isConnected && list.parentNode === root) mergeAdjacent(list);
  return first;
}

/** List items -> lines (nested items move up to the top level first). Returns Map(li -> line). */
export function itemsToLines(root, items) {
  const out = new Map();
  for (const li of items) {
    while (li.parentElement?.parentElement?.tagName === 'LI') outdentItem(li);
    if (!isList(li.parentElement) || li.parentElement.parentNode !== root) continue;
    out.set(li, itemToLine(li));
  }
  return out;
}

/** Tab: each item moves into a sub-list of the item above it. */
export function indentItems(items) {
  let moved = 0;
  for (const li of items) {
    const prev = li.previousElementSibling;
    if (!prev || prev.tagName !== 'LI') continue;
    const list = li.parentElement;
    let sub = prev.lastElementChild;
    if (!isList(sub)) {
      sub = list.cloneNode(false);
      sub.removeAttribute('start');
      prev.appendChild(sub);
    }
    sub.appendChild(li);
    // li's own sub-list joins the new level's items that follow (keeps the order)
    fixFlags(sub);
    moved++;
  }
  return moved;
}

/** Shift+Tab: one level up; at the top level the item becomes a line. */
export function outdentItem(li, root) {
  const list = li.parentElement;
  const parentLi = list?.parentElement?.tagName === 'LI' ? list.parentElement : null;
  if (!parentLi) return root ? itemToLine(li) : null;
  // the items after it become its children (they stay below it, one level deeper than it now is)
  const followers = [];
  for (let n = li.nextElementSibling; n; n = n.nextElementSibling) followers.push(n);
  if (followers.length) {
    let sub = [...li.children].find(isList);
    if (!sub) {
      sub = list.cloneNode(false);
      sub.removeAttribute('start');
      li.appendChild(sub);
    }
    for (const f of followers) sub.appendChild(f);
  }
  parentLi.after(li);
  if (!list.children.length) list.remove();
  fixFlags(li.parentElement);
  return li;
}

export function outdentItems(root, items) {
  let first = null;
  for (const li of items) first ||= outdentItem(li, root);
  return first;
}

/** Clean-up after the browser edited lists: ul > ul -> inside the previous item, flags, empty lists. */
export function fixLists(root) {
  let changed = false;
  for (const sub of root.querySelectorAll(':is(ul, ol) > :is(ul, ol)')) {
    const prev = sub.previousElementSibling;
    if (prev?.tagName === 'LI') prev.appendChild(sub);
    else {
      const li = document.createElement('li');
      sub.replaceWith(li);
      li.appendChild(sub);
    }
    changed = true;
  }
  for (const list of root.querySelectorAll('ul, ol')) {
    if (!list.querySelector(':scope > li')) {
      if (!list.textContent.trim() && !list.querySelector('img')) {
        list.remove();
        changed = true;
      }
      continue;
    }
    // a checklist's nested lists are checklists
    if (listKind(list) !== 'check' && list.parentElement?.closest('ul[data-type="checklist"]') && list.tagName === 'UL') {
      list.setAttribute('data-type', 'checklist');
      changed = true;
    }
    if (fixFlags(list)) changed = true;
  }
  return changed;
}
