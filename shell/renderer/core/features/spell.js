// Spell check in the shell's own apps (Courrier, Notes, Éditeur de texte) with the local dictionaries of
// main/ipc/spell.js. Only prose fields are checked: the whole shell defaults to spellcheck=false and an app marks
// its editors with `data-prose` (Notepad also sets data-prose="code" for source files, which stay unchecked).
// Setting `spellcheck` (default on): Paramètres > Heure et langue > « Vérifier l'orthographe ».
// Right-click on an underlined word (Chromium selects it): suggestions, « Ajouter au dictionnaire », cut / copy / paste.
let ctx = null;

const STR = {
  en: { add: 'Add to dictionary', none: 'No suggestions', cut: 'Cut', copy: 'Copy', paste: 'Paste' },
  fr: { add: 'Ajouter au dictionnaire', none: 'Aucune suggestion', cut: 'Couper', copy: 'Copier', paste: 'Coller' },
};
const s = (k) => (STR[ctx?.i18n?.lang === 'fr' || String(ctx?.i18n?.lang || '').startsWith('fr') ? 'fr' : 'en'] || STR.en)[k];

export const enabled = () => ctx?.settings?.get('spellcheck') !== false;

function apply(el) {
  el.spellcheck = enabled() && el.dataset.prose !== 'code';
}

function applyAll(root = document) {
  for (const el of root.querySelectorAll('[data-prose]')) apply(el);
}

function editableOf(t) {
  const el = t instanceof Element ? t : t?.parentElement;
  if (!el) return null;
  if (el.matches('textarea, input[type=text], input:not([type])')) return el;
  const ce = el.closest('[contenteditable=""], [contenteditable=true], [contenteditable=plaintext-only]');
  return ce || null;
}

/** The selected word in `el` (Chromium selects a misspelled word on right-click) and how to put it back. */
function selectedWord(el) {
  if (el.matches('textarea, input')) {
    const a = el.selectionStart;
    const b = el.selectionEnd;
    if (a == null || b == null || a === b) return null;
    return { word: el.value.slice(a, b), restore: () => (el.focus(), el.setSelectionRange(a, b)) };
  }
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0).cloneRange();
  return {
    word: sel.toString(),
    restore: () => {
      el.focus();
      const s2 = window.getSelection();
      s2.removeAllRanges();
      s2.addRange(range);
    },
  };
}

const LETTER = /[\p{L}\p{M}'’-]/u;

/** The word under the pointer (Chromium does not always select it on right-click): selects it and returns it. */
function wordAtPoint(el, x, y) {
  const pos = document.caretPositionFromPoint?.(x, y);
  if (!pos) return null;
  let text = '';
  let off = pos.offset;
  const field = el.matches('textarea, input');
  if (field) text = el.value;
  else if (pos.offsetNode?.nodeType === Node.TEXT_NODE && el.contains(pos.offsetNode)) text = pos.offsetNode.data;
  else return null;
  let a = off;
  let b = off;
  while (a > 0 && LETTER.test(text[a - 1])) a--;
  while (b < text.length && LETTER.test(text[b])) b++;
  if (a === b) return null;
  if (field) {
    el.focus();
    el.setSelectionRange(a, b);
  } else {
    const r = document.createRange();
    r.setStart(pos.offsetNode, a);
    r.setEnd(pos.offsetNode, b);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }
  return selectedWord(el);
}

function onContextMenu(e) {
  const el = editableOf(e.target);
  if (!el || !el.spellcheck || !enabled()) return;
  let sw = selectedWord(el);
  if (!sw || /\s/.test(sw.word.trim()) === false && !window.aurora?.spell?.misspelled(sw.word.trim())) sw = wordAtPoint(el, e.clientX, e.clientY) || sw;
  const word = sw?.word?.trim();
  if (!word || /\s/.test(word) || word.length > 64 || !window.aurora?.spell?.misspelled(word)) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  const replace = (text) => {
    sw.restore();
    document.execCommand('insertText', false, text);
  };
  const sugg = window.aurora.spell.suggestions(word);
  const items = sugg.length ? sugg.map((w) => ({ label: w, action: () => replace(w) })) : [{ label: s('none'), disabled: true }];
  items.push(
    '-',
    {
      label: s('add'),
      icon: 'book',
      action: () =>
        ctx.api
          .invoke('spell:add', word)
          .then(() => replace(word)) // re-typing the word drops the red underline at once
          .catch((err) => console.warn('[spell] add failed', err)),
    },
    '-',
    { label: s('cut'), icon: 'cut', action: () => (sw.restore(), document.execCommand('cut')) },
    { label: s('copy'), icon: 'copy', action: () => (sw.restore(), document.execCommand('copy')) },
    { label: s('paste'), icon: 'clipboard_paste', action: () => (sw.restore(), document.execCommand('paste')) },
  );
  ctx.ui.menu({ x: e.clientX, y: e.clientY }, items, { className: 'spell-menu' });
}

export function mount(c) {
  ctx = c;
  document.documentElement.spellcheck = false;
  applyAll();
  new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (!(n instanceof Element)) continue;
        if (n.hasAttribute('data-prose')) apply(n);
        if (n.firstElementChild) applyAll(n);
      }
      if (m.type === 'attributes' && m.target instanceof Element && m.target.hasAttribute('data-prose')) apply(m.target);
    }
  }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-prose'] });
  ctx.settings.on?.('spellcheck', () => applyAll());
  ctx.settings.on?.('lang', (l) => ctx.api.invoke('spell:languages', l || ctx.env.lang).catch(() => {}));
  window.addEventListener('contextmenu', onContextMenu, true);
}
