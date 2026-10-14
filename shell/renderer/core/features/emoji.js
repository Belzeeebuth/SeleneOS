// Emoji and symbols panel (like Windows' Win+.): Super+. or Super+; (catalog entries 'emoji' / 'emojiAlt' in
// core/shortcuts.js; features/hotkeys.js runs shell.emit('emoji:toggle')).
//
//   Tabs « Émojis » (Récents + the nine Unicode groups, skin tone remembered), « Kaomojis » and « Symboles » (French
//   typography, currency, accented letters, maths, arrows, Greek letters, shapes, signs). One search field for the
//   three: English and French names and keywords, accents and case ignored (« coeur » finds ❤️, « chat » 🐱).
//   Data: assets/emoji/emoji.json (built by tools/gen-emoji.mjs from Unicode emoji-test.txt + CLDR), fetched the first
//   time the panel opens.
//
// Where the character goes: the field that had the focus when the panel opened (or the one the user focuses while
// the panel is pinned), at its caret, which it keeps:
//   <input> / <textarea> / contenteditable (Notes…)   execCommand('insertText'): 'input' fires, undo works
//   CodeMirror 6 (Éditeur de code)                     a transaction on its EditorView (replaceSelection)
//   xterm.js (Terminal, the Code Editor's terminal)    an insertText InputEvent on its textarea, typed into the PTY
//                                                     the way an input method commits text
//   <webview> (Navigateur)                             webview.insertText()
//   an X11 window (features/xwin.js)                   CLIPBOARD (+ PRIMARY), then aurora-xwm's XTest paste: Ctrl+V,
//                                                     Ctrl+Shift+V in terminal emulators, Shift+Insert in xterm
//   nothing editable / no helper                       copied, « Copié — collez avec Ctrl+V »
// Shift+click or Shift+Enter keeps the panel open for one more character; the pin keeps it open.
// Preferences: storage 'shell' / 'emoji' = { tone: 0..5, keepOpen, recents: { emoji: [], symbols: [], kaomoji: [] } }.
//
// Test hooks: ctx.emoji (= window.__aurora.emoji) = { open(), close(), toggle(), isOpen, ready() -> data, search(q),
//   state: { tab, category, query, tone, keepOpen, recents }, target, insert(text, { keep }), setTone(n) }.
import { icon } from '../ui.js';

const DATA_URL = 'app://shell/assets/emoji/emoji.json';
const CM_URL = 'app://shell/apps/code/vendor/codemirror.js';
const MODS = ['', '\u{1F3FB}', '\u{1F3FC}', '\u{1F3FD}', '\u{1F3FE}', '\u{1F3FF}'];
// (written as `icon: '…'` so tools/vendor-icons.mjs keeps these glyphs packed)
const CATS = [
  { id: 'recent', icon: 'clock-counter-clockwise' }, { id: 'smileys', icon: 'smiley' }, { id: 'people', icon: 'hand' },
  { id: 'nature', icon: 'leaf' }, { id: 'food', icon: 'fork-knife' }, { id: 'travel', icon: 'airplane' },
  { id: 'activities', icon: 'soccer-ball' }, { id: 'objects', icon: 'lightbulb' }, { id: 'symbols', icon: 'heart' },
  { id: 'flags', icon: 'flag' },
];
// The button of each symbol / kaomoji group shows one of its characters.
const SYMBOL_LABELS = { punctuation: '«', currency: '€', letters: 'É', math: '±', arrows: '→', greek: 'Ω', shapes: '■', signs: '©' };
const KAOMOJI_LABELS = { joy: '^_^', love: '♥‿♥', sad: 'T_T', angry: '>_<', surprise: 'o_O', other: '¯\\_(ツ)_/¯' };
const RECENT_MAX = { emoji: 36, symbols: 18, kaomoji: 9 };
const SPACE_LABELS = { '\u00A0': 'emoji.lblNbsp', '\u202F': 'emoji.lblNnbsp' };
const DEFAULT_RECENT = { symbols: ['«', '»', '€', '…', '—', '–', '’', '“', '”', '°', '×', '·', 'œ', 'É', '±', '≤', '≥', '→'] };
const SEARCH_MAX = { emoji: 180, symbols: 54, kaomoji: 24 };
// X11 programs that paste with something else than Ctrl+V (wm class, lower case).
const TERMINALS = /^(gnome-terminal(-server)?|org\.gnome\.(console|ptyxis)|kgx|ptyxis|konsole|xfce4-terminal|tilix|terminator|mate-terminal|lxterminal|qterminal|alacritty|kitty|wezterm(-gui)?|org\.wezfurlong\.wezterm|terminology|foot|footclient|sakura|guake|tilda|deepin-terminal|blackbox|com\.raggesilver\.blackbox|cool-retro-term|terminal)$/;
const XTERMS = /^(xterm|uxterm|urxvt|rxvt|rxvt-unicode|st|st-256color|aterm|eterm)$/;

const fold = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/œ/g, 'oe')
    .replace(/æ/g, 'ae')
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’']/g, ' ');
const words = (s) => fold(s).split(/[^a-z0-9#*+]+/).filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The modifier right after the first code point (a following U+FE0F dropped): tools/gen-emoji.mjs defaultTone. */
function defaultTone(seq, mod) {
  const cps = [...seq];
  return cps[0] + mod + cps.slice(cps[1] === '️' ? 2 : 1).join('');
}
function withTone(item, tone) {
  if (!item.t || !tone) return item.c;
  return item.t === 1 ? defaultTone(item.c, MODS[tone]) : item.t.replaceAll(MODS[1], MODS[tone]);
}

// ------------------------------------------------------------------ data
function prepare(raw) {
  const all = [];
  const lookup = new Map(); // inserted text -> item (recents keep the toned form)
  const add = (it) => {
    const name = `${it.en} ${it.fr}`;
    it.f = { name: words(name), kw: words(`${it.kwEn || ''} ${it.kwFr || ''}`.replace(/\|/g, ' ')), nameStr: fold(name), kwStr: fold(`${it.kwEn || ''}|${it.kwFr || ''}`), full: [fold(it.en).trim(), fold(it.fr).trim()] };
    it.i = all.length;
    all.push(it);
    if (!lookup.has(it.c)) lookup.set(it.c, it);
  };
  const byGroup = new Map(raw.groups.map((g) => [g, []]));
  for (const [c, g, en, fr, kwEn = '', kwFr = '', t = 0, p = 0] of raw.e) {
    const it = { kind: 'emoji', c, g: raw.groups[g], en, fr, kwEn, kwFr, t, p };
    add(it);
    byGroup.get(it.g)?.push(it);
    if (t) for (let k = 1; k < MODS.length; k++) lookup.set(withTone(it, k), it);
  }
  const symbols = raw.symbols.map((g) => ({ id: g.id, en: g.en, fr: g.fr, items: g.items.map(([c, en, fr, kwEn = '', kwFr = '']) => ({ kind: 'symbols', c, en, fr, kwEn, kwFr, group: g.id })) }));
  for (const g of symbols) g.items.forEach(add);
  const kaomoji = raw.kaomoji.map((g) => ({ id: g.id, en: g.en, fr: g.fr, items: g.items.map(([c, en, fr]) => ({ kind: 'kaomoji', c, en, fr, group: g.id })) }));
  for (const g of kaomoji) g.items.forEach(add);
  const popular = all.filter((x) => x.kind === 'emoji' && x.p).sort((a, b) => a.p - b.p);
  return { raw, all, lookup, byGroup, symbols, kaomoji, popular, emojiVersion: raw.emoji };
}

function scoreToken(it, tk) {
  let best = 0;
  for (const w of it.f.name) {
    if (w === tk) return 4;
    if (w.startsWith(tk)) best = 3;
  }
  if (best) return best;
  for (const w of it.f.kw) {
    if (w === tk) best = Math.max(best, 2.5);
    else if (w.startsWith(tk)) best = Math.max(best, 2);
  }
  if (!best && tk.length >= 3) {
    if (it.f.nameStr.includes(tk)) best = 1;
    else if (it.f.kwStr.includes(tk)) best = 0.5;
  }
  return best;
}

/** Search every item: { emoji: [item], symbols: [item], kaomoji: [item] }, best first. */
function searchData(D, query, tone = 0) {
  const raw = String(query || '').trim();
  const out = { emoji: [], symbols: [], kaomoji: [] };
  if (!raw || !D) return out;
  const tokens = words(raw);
  const phrase = tokens.join(' ');
  const scored = { emoji: [], symbols: [], kaomoji: [] };
  for (const it of D.all) {
    let score = 0;
    if (raw === it.c || (it.t && raw === withTone(it, tone))) score = 100;
    else if (tokens.length) {
      for (const tk of tokens) {
        const s = scoreToken(it, tk);
        if (!s) {
          score = 0;
          break;
        }
        score += s;
      }
      // the whole name typed, or one of the most used emoji: a small lead (« coeur »: ❤️ before 🫀 « cœur »)
      if (score && it.f.full.some((f) => f.replace(/[^a-z0-9#*+]+/g, ' ').trim() === phrase)) score += 1;
      if (score && it.p) score += 1;
    } else if (it.kind !== 'emoji' && raw.length <= 3 && it.c.includes(raw)) score = 50;
    if (score > 0) scored[it.kind].push([score, it]);
  }
  for (const k of Object.keys(scored)) {
    scored[k].sort((a, b) => b[0] - a[0] || (a[1].p || 1e4) - (b[1].p || 1e4) || a[1].i - b[1].i);
    out[k] = scored[k].slice(0, SEARCH_MAX[k]).map((x) => x[1]);
  }
  return out;
}

// ------------------------------------------------------------------ caret position
const MIRROR = ['direction', 'boxSizing', 'width', 'height', 'overflowX', 'overflowY', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderStyle', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch', 'fontSize', 'lineHeight', 'fontFamily', 'textAlign', 'textTransform', 'textIndent', 'letterSpacing', 'wordSpacing', 'tabSize'];
function fieldCaret(el) {
  const r = el.getBoundingClientRect();
  let pos = null;
  try {
    pos = el.selectionEnd;
  } catch {}
  if (pos == null) return r;
  const doc = el.ownerDocument;
  const cs = getComputedStyle(el);
  const div = doc.createElement('div');
  for (const p of MIRROR) div.style[p] = cs[p];
  const input = el.tagName === 'INPUT';
  Object.assign(div.style, { position: 'fixed', visibility: 'hidden', top: '0', left: '-9999px', whiteSpace: input ? 'pre' : 'pre-wrap', overflowWrap: 'break-word', overflow: 'hidden' });
  div.textContent = el.value.slice(0, pos);
  const span = doc.createElement('span');
  span.textContent = el.value.slice(pos) || '.';
  div.appendChild(span);
  doc.body.appendChild(div);
  const left = r.left + span.offsetLeft + (parseFloat(cs.borderLeftWidth) || 0) - el.scrollLeft;
  const top = r.top + span.offsetTop + (parseFloat(cs.borderTopWidth) || 0) - el.scrollTop;
  const lh = parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) || 14) * 1.3;
  div.remove();
  const x = Math.min(Math.max(left, r.left), r.right);
  if (input) return { left: x, right: x, top: r.top, bottom: r.bottom, width: 0, height: r.height };
  const y = Math.min(Math.max(top, r.top), r.bottom - lh);
  return { left: x, right: x, top: y, bottom: y + lh, width: 0, height: lh };
}
function rangeCaret(range, el) {
  try {
    const rects = range.getClientRects();
    let r = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
    if (!r || (!r.width && !r.height)) {
      const c = range.startContainer;
      const n = c.nodeType === 1 ? c.childNodes[range.startOffset] || c : c.parentElement;
      r = n?.getBoundingClientRect?.();
    }
    if (r && (r.width || r.height)) return r;
  } catch {}
  return el.getBoundingClientRect();
}

// ------------------------------------------------------------------ the feature
export async function mount(ctx) {
  const { api, shell, wm, i18n, t, h, ui } = ctx;
  i18n.extend({
    en: {
      emoji: {
        title: 'Emoji and symbols',
        tabs: { emoji: 'Emoji', kaomoji: 'Kaomoji', symbols: 'Symbols' },
        search: 'Search emoji, symbols and kaomoji',
        cats: 'Categories',
        groups: 'Groups',
        cat: { recent: 'Recently used', smileys: 'Smileys and emotions', people: 'People', nature: 'Animals and nature', food: 'Food and drink', travel: 'Travel and places', activities: 'Activities', objects: 'Objects', symbols: 'Symbols', flags: 'Flags' },
        results: { emoji: 'Emoji', symbols: 'Symbols', kaomoji: 'Kaomoji' },
        noResults: 'No results for “{q}”',
        tone: 'Skin tone',
        toneIs: 'Skin tone: {tone}',
        tone0: 'Default', tone1: 'Light skin tone', tone2: 'Medium-light skin tone', tone3: 'Medium skin tone', tone4: 'Medium-dark skin tone', tone5: 'Dark skin tone',
        keepOpen: 'Keep open after inserting',
        close: 'Close',
        hint: 'Shift+click: insert and keep the panel open',
        hintCopy: 'Nothing to type into: the character will be copied',
        loading: 'Loading…',
        loadFailed: 'The emoji list could not be loaded.',
        copied: 'Copied — paste with Ctrl+V',
        lblNbsp: 'nbsp',
        lblNnbsp: 'thin',
      },
    },
    fr: {
      emoji: {
        title: 'Émojis et symboles',
        tabs: { emoji: 'Émojis', kaomoji: 'Kaomojis', symbols: 'Symboles' },
        search: 'Rechercher des émojis, symboles et kaomojis',
        cats: 'Catégories',
        groups: 'Groupes',
        cat: { recent: 'Récents', smileys: 'Smileys et émotions', people: 'Personnes', nature: 'Animaux et nature', food: 'Nourriture et boissons', travel: 'Voyages et lieux', activities: 'Activités', objects: 'Objets', symbols: 'Symboles', flags: 'Drapeaux' },
        results: { emoji: 'Émojis', symbols: 'Symboles', kaomoji: 'Kaomojis' },
        noResults: 'Aucun résultat pour « {q} »',
        tone: 'Couleur de peau',
        toneIs: 'Couleur de peau : {tone}',
        tone0: 'Par défaut', tone1: 'Peau claire', tone2: 'Peau moyennement claire', tone3: 'Peau légèrement mate', tone4: 'Peau mate', tone5: 'Peau foncée',
        keepOpen: 'Garder ouvert après l’insertion',
        close: 'Fermer',
        hint: 'Maj+clic : insérer sans fermer le panneau',
        hintCopy: 'Aucun champ de saisie : le caractère sera copié',
        loading: 'Chargement…',
        loadFailed: 'La liste des émojis n’a pas pu être chargée.',
        copied: 'Copié — collez avec Ctrl+V',
        lblNbsp: 'esp.',
        lblNnbsp: 'fine',
      },
    },
  });
  ui.loadCss('app://shell/core/features/emoji.css');
  const lang = () => (i18n.lang === 'fr' ? 'fr' : 'en');
  const nameOf = (it) => (lang() === 'fr' ? it.fr : it.en) || it.en;
  const toneName = (n) => t(`emoji.tone${n}`);

  // ---------------------------------------------------------------- state
  let D = null;
  let loading = null;
  let prefs = { tone: 0, keepOpen: false, recents: { emoji: [], symbols: [], kaomoji: [] } };
  let prefsLoaded = null;
  const state = { tab: 'emoji', category: 'recent', symGroup: 'recent', kaoGroup: 'recent', query: '' };
  let el = null; // the panel
  let target = null; // where characters go
  let opening = false;
  let inserting = 0;
  let lastCell = null; // cell to focus again after an insertion that keeps the panel open
  let statusEl = null;
  let statusTimer = 0;
  const pastes = new Map(); // xid -> resolve (aurora-xwm 'paste' answers)

  function load() {
    if (D) return Promise.resolve(D);
    if (!loading) {
      loading = fetch(DATA_URL)
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        })
        .then((raw) => (D = prepare(raw)))
        .catch((err) => {
          loading = null;
          console.error('[emoji] data', err);
          throw err;
        });
    }
    return loading;
  }
  function loadPrefs() {
    if (!prefsLoaded) {
      prefsLoaded = api
        .invoke('storage:get', 'shell', 'emoji', null)
        .then((p) => {
          if (!p || typeof p !== 'object') return;
          const tone = Number(p.tone);
          prefs.tone = Number.isInteger(tone) && tone >= 0 && tone < MODS.length ? tone : 0;
          prefs.keepOpen = p.keepOpen === true;
          for (const k of Object.keys(RECENT_MAX)) {
            const list = p.recents?.[k];
            prefs.recents[k] = Array.isArray(list) ? list.filter((x) => typeof x === 'string' && x.length <= 64).slice(0, RECENT_MAX[k]) : [];
          }
        })
        .catch(() => {});
    }
    return prefsLoaded;
  }
  const savePrefs = () => api.invoke('storage:set', 'shell', 'emoji', prefs).catch(() => {});
  function addRecent(kind, text) {
    const list = prefs.recents[kind] || (prefs.recents[kind] = []);
    prefs.recents[kind] = [text, ...list.filter((x) => x !== text)].slice(0, RECENT_MAX[kind]);
    savePrefs();
  }

  // ---------------------------------------------------------------- target
  function deepActive() {
    let a = document.activeElement;
    for (let i = 0; i < 8 && a; i++) {
      if (a.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
      else if (a.tagName === 'IFRAME') {
        let inner = null;
        try {
          inner = a.contentDocument?.activeElement;
        } catch {}
        if (!inner || inner === a.contentDocument.body) break;
        a = inner;
      } else break;
    }
    return a;
  }
  const TEXT_TYPES = new Set(['text', 'search', 'url', 'tel', 'email', 'password', '']);
  const isField = (a) => (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && TEXT_TYPES.has((a.getAttribute('type') || '').toLowerCase()))) && !a.readOnly && !a.disabled;

  /** Describe an element (or the X11 window that has the keyboard) as a target. */
  function describe(a) {
    if (!a || a === document.body || a === document.documentElement || el?.contains(a)) return null;
    // the Lanceur and the flyouts close when the panel opens: nothing to type into there
    if (a.closest?.('#start, #flyouts, .flyout')) return { kind: 'none', el: a };
    if (a.tagName === 'WEBVIEW') return { kind: 'webview', el: a };
    if (a.classList?.contains('xterm-helper-textarea')) return { kind: 'xterm', el: a };
    const cm = a.closest?.('.cm-editor');
    if (cm && a.closest('.cm-content')) return { kind: 'cm', el: a, editor: cm };
    if (isField(a)) return { kind: 'field', el: a }; // the field keeps its selection while blurred; focus() restores it
    if (a.isContentEditable) {
      const sel = a.ownerDocument.getSelection();
      const range = sel?.rangeCount && a.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
      return { kind: 'editable', el: a, range };
    }
    return { kind: 'none', el: a };
  }
  function findTarget() {
    const a = deepActive();
    const fw = wm.focused?.();
    const frame = fw && fw.xwin != null && !fw.minimized ? ctx.xwin?.frames?.get(fw.xwin) : null;
    const inFrame = frame && (!a || a === document.body || fw.el?.contains(a));
    if (frame && inFrame) return { kind: 'x11', id: fw.xwin, win: fw, wmClass: (frame.info?.wmClass || []).map((x) => String(x || '').toLowerCase()) };
    return describe(a);
  }
  const targetAlive = (tg) => tg && tg.kind !== 'none' && (tg.kind === 'x11' ? !!ctx.xwin?.frames?.get(tg.id) && !tg.win?.closed : tg.el?.isConnected);

  function caretRect(tg) {
    try {
      if (!tg || !targetAlive(tg)) return null;
      if (tg.kind === 'field') return fieldCaret(tg.el);
      if (tg.kind === 'editable' && tg.range) return rangeCaret(tg.range, tg.el);
      if (tg.kind === 'cm') {
        const sel = tg.el.ownerDocument.getSelection();
        if (sel?.rangeCount && tg.editor.contains(sel.anchorNode)) return rangeCaret(sel.getRangeAt(0), tg.editor);
        return tg.editor.querySelector('.cm-cursor')?.getBoundingClientRect() || tg.editor.getBoundingClientRect();
      }
      if (tg.kind === 'xterm') return tg.el.getBoundingClientRect(); // xterm keeps its textarea on the cursor cell
      if (tg.kind === 'editable') return tg.el.getBoundingClientRect();
    } catch {}
    return null;
  }

  // ---------------------------------------------------------------- inserting
  async function insertField(tg, text) {
    const a = tg.el;
    a.focus({ preventScroll: true });
    const before = a.value;
    let ok = false;
    try {
      ok = a.ownerDocument.execCommand('insertText', false, text);
    } catch {}
    if (!ok || a.value === before) {
      // fields without selection support (type=email) or an editor that refused the command
      let s = null;
      try {
        s = a.selectionStart;
      } catch {}
      if (s != null) a.setRangeText(text, s, a.selectionEnd, 'end');
      else a.value += text;
      a.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    }
    return true;
  }
  function insertEditable(tg, text, node = tg.el) {
    const doc = node.ownerDocument;
    node.focus({ preventScroll: true });
    const sel = doc.getSelection();
    if (tg.range && node.contains(tg.range.startContainer)) {
      sel.removeAllRanges();
      sel.addRange(tg.range);
    }
    doc.execCommand('insertText', false, text);
    tg.range = sel.rangeCount && node.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
    return true;
  }
  async function insertCodeMirror(tg, text) {
    let view = null;
    try {
      const CM = await import(CM_URL);
      view = CM.EditorView?.findFromDOM?.(tg.editor) || null;
    } catch {}
    if (!view) return insertEditable(tg, text, tg.editor.querySelector('.cm-content') || tg.el);
    view.focus();
    view.dispatch(view.state.replaceSelection(text), { scrollIntoView: true, userEvent: 'input.type' });
    return true;
  }
  function insertXterm(tg, text) {
    tg.el.focus({ preventScroll: true });
    // What xterm.js does with an input method's commit: the text goes to the PTY as typed (not as a paste).
    tg.el.dispatchEvent(new InputEvent('input', { data: text, inputType: 'insertText', bubbles: true, cancelable: true, composed: false }));
    return true;
  }
  async function insertX11(tg, text) {
    const st = ctx.xwin?.status;
    try {
      await api.invoke('clipboard:writeText', text);
    } catch {}
    const cls = tg.wmClass || [];
    const keys = cls.some((c) => XTERMS.test(c)) ? 'shift+insert' : cls.some((c) => TERMINALS.test(c)) ? 'ctrl+shift+v' : 'ctrl+v';
    if (keys === 'shift+insert') await api.invoke('pty:primaryWrite', text).catch(() => {});
    if (!st?.enabled) return false;
    // give the keyboard back to the program, then paste (the helper checks it really has the focus)
    api.send('xwin:cmd', { cmd: 'focus', id: tg.id });
    tg.win?.focus?.();
    await sleep(120);
    const answer = new Promise((resolve) => {
      pastes.get(tg.id)?.(false);
      pastes.set(tg.id, resolve);
      setTimeout(() => pastes.get(tg.id) === resolve && (pastes.delete(tg.id), resolve(false)), 1500);
    });
    api.send('xwin:cmd', { cmd: 'paste', id: tg.id, keys });
    return answer;
  }
  async function copyFallback(text) {
    try {
      await api.invoke('clipboard:writeText', text);
    } catch {}
    showStatus(t('emoji.copied'));
    return false;
  }
  /** Insert text into the target (true), or copy it (false). */
  async function insertInto(tg, text) {
    if (!targetAlive(tg)) return copyFallback(text);
    inserting++;
    try {
      switch (tg.kind) {
        case 'field':
          return await insertField(tg, text);
        case 'editable':
          return insertEditable(tg, text);
        case 'cm':
          return await insertCodeMirror(tg, text);
        case 'xterm':
          return insertXterm(tg, text);
        case 'webview':
          tg.el.focus();
          await tg.el.insertText(text);
          return true;
        case 'x11':
          if (await insertX11(tg, text)) return true;
          showStatus(t('emoji.copied'));
          return false;
        default:
          return copyFallback(text);
      }
    } catch (err) {
      console.warn('[emoji] insert failed', err);
      return copyFallback(text);
    } finally {
      setTimeout(() => inserting--, 0); // the focus events of the insertion itself are not a new target
    }
  }

  function showStatus(msg) {
    statusEl?.remove();
    clearTimeout(statusTimer);
    statusEl = h('div', { class: 'emo-status', role: 'status', 'aria-live': 'polite' }, msg);
    document.getElementById('overlays')?.appendChild(statusEl);
    const s = statusEl;
    statusTimer = setTimeout(() => {
      s.classList.add('closing');
      setTimeout(() => s.remove(), 200);
      if (statusEl === s) statusEl = null;
    }, 2600);
  }

  /** The user picked an item: insert it, remember it, close unless kept open. */
  async function choose(it, { keep = false } = {}) {
    const text = it.kind === 'emoji' ? withTone(it, prefs.tone) : it.c;
    addRecent(it.kind === 'emoji' ? 'emoji' : it.kind, text);
    const stay = keep || prefs.keepOpen;
    if (!stay) {
      const tg = target;
      close({ restore: false });
      await insertInto(tg, text);
      return text;
    }
    const back = el?.contains(document.activeElement) ? document.activeElement : lastCell;
    const backC = back?.classList.contains('emo-cell') ? back.dataset.c : null;
    await insertInto(target, text);
    if (!el) return text;
    if (state.tab === tabOf(it) && currentCat() === 'recent' && !state.query) renderBody(); // the new order
    if (target?.kind !== 'x11') {
      const again = backC != null ? [...bodyEl.querySelectorAll('.emo-cell')].find((c) => c.dataset.c === backC) : null;
      if (again) focusCell(again);
      else (back?.isConnected ? back : qInput)?.focus({ preventScroll: true });
    }
    return text;
  }
  const tabOf = (it) => (it.kind === 'emoji' ? 'emoji' : it.kind);
  const currentCat = () => (state.tab === 'emoji' ? state.category : state.tab === 'symbols' ? state.symGroup : state.kaoGroup);

  // ---------------------------------------------------------------- rendering
  let qInput = null;
  let catBar = null;
  let bodyEl = null;
  let footEl = null;
  let tonePop = null;
  let cellItems = new WeakMap();

  // invisible characters (the French spaces) show a short word instead
  const labelOf = (it) => (SPACE_LABELS[it.c] ? t(SPACE_LABELS[it.c]) : '');
  function cell(it) {
    const text = it.kind === 'emoji' ? withTone(it, prefs.tone) : it.c;
    const label = labelOf(it);
    const b = h('button', { class: ['emo-cell', `emo-${it.kind}`, label && 'emo-cell-label'], type: 'button', role: 'option', tabindex: '-1', 'aria-label': nameOf(it), dataset: { c: text } }, label || text);
    cellItems.set(b, it);
    return b;
  }
  function recentItems(kind) {
    const list = prefs.recents[kind] || [];
    if (kind === 'emoji') {
      const items = list.map((c) => D.lookup.get(c) && { ...D.lookup.get(c), c, t: 0 }).filter(Boolean);
      return items.length ? items : D.popular.slice(0, 27);
    }
    if (kind === 'symbols') {
      const items = (list.length ? list : DEFAULT_RECENT.symbols).map((c) => D.lookup.get(c)).filter((x) => x?.kind === 'symbols');
      return items;
    }
    const items = list.map((c) => D.lookup.get(c)).filter((x) => x?.kind === 'kaomoji');
    return items.length ? items : D.kaomoji.flatMap((g) => g.items).slice(0, 6);
  }
  function section(title, items, kind) {
    const grid = h('div', { class: ['emo-grid', `emo-grid-${kind}`], role: 'listbox', 'aria-label': title }, items.map(cell));
    return [h('div', { class: 'emo-h caption', 'aria-hidden': 'true' }, title), grid];
  }

  function renderCats() {
    if (!catBar) return;
    const btn = (id, label, content, selected, kind) =>
      h('button', { class: ['emo-cat', selected && 'selected', kind], type: 'button', role: 'tab', 'aria-selected': selected ? 'true' : 'false', 'aria-label': label, tabindex: selected ? '0' : '-1', dataset: { cat: id } }, content);
    const kids = [];
    if (state.tab === 'emoji') {
      for (const { id, icon: ic } of CATS) kids.push(btn(id, t(`emoji.cat.${id}`), icon(ic, { size: 18, filled: state.category === id }), state.category === id));
    } else if (state.tab === 'symbols') {
      kids.push(btn('recent', t('emoji.cat.recent'), icon('clock-counter-clockwise', { size: 18, filled: state.symGroup === 'recent' }), state.symGroup === 'recent'));
      for (const g of D?.symbols || []) kids.push(btn(g.id, g[lang()], SYMBOL_LABELS[g.id] || g.items[0]?.c, state.symGroup === g.id, 'emo-cat-text'));
    } else {
      kids.push(btn('recent', t('emoji.cat.recent'), icon('clock-counter-clockwise', { size: 18, filled: state.kaoGroup === 'recent' }), state.kaoGroup === 'recent'));
      for (const g of D?.kaomoji || []) kids.push(btn(g.id, g[lang()], KAOMOJI_LABELS[g.id] || g.items[0]?.c, state.kaoGroup === g.id, 'emo-cat-text emo-cat-kao'));
    }
    const list = h('div', { class: 'emo-cat-list', role: 'tablist', 'aria-label': state.tab === 'emoji' ? t('emoji.cats') : t('emoji.groups') }, kids);
    const toneBtn =
      state.tab === 'emoji'
        ? h('button', { class: 'emo-tone-btn', type: 'button', 'aria-label': t('emoji.toneIs', { tone: toneName(prefs.tone) }), 'aria-haspopup': 'listbox', 'aria-expanded': tonePop ? 'true' : 'false', onclick: () => toggleTones() }, h('span', { class: 'emo-glyph' }, `✋${MODS[prefs.tone]}`))
        : null;
    catBar.replaceChildren(...[list, toneBtn].filter(Boolean));
    catBar.hidden = !!state.query;
  }

  function renderBody() {
    if (!bodyEl) return;
    lastCell = null;
    cellItems = new WeakMap();
    if (!D) {
      bodyEl.replaceChildren(h('div', { class: 'emo-empty caption text-2' }, loading ? t('emoji.loading') : t('emoji.loadFailed')));
      return;
    }
    const parts = [];
    if (state.query.trim()) {
      const r = searchData(D, state.query, prefs.tone);
      for (const kind of ['emoji', 'symbols', 'kaomoji']) if (r[kind].length) parts.push(...section(t(`emoji.results.${kind}`), r[kind], kind));
      if (!parts.length) parts.push(h('div', { class: 'emo-empty caption text-2' }, t('emoji.noResults', { q: state.query.trim() })));
    } else if (state.tab === 'emoji') {
      const items = state.category === 'recent' ? recentItems('emoji') : D.byGroup.get(state.category) || [];
      parts.push(...section(t(`emoji.cat.${state.category}`), items, 'emoji'));
    } else if (state.tab === 'symbols') {
      const g = D.symbols.find((x) => x.id === state.symGroup);
      parts.push(...section(g ? g[lang()] : t('emoji.cat.recent'), g ? g.items : recentItems('symbols'), 'symbols'));
    } else {
      const g = D.kaomoji.find((x) => x.id === state.kaoGroup);
      parts.push(...section(g ? g[lang()] : t('emoji.cat.recent'), g ? g.items : recentItems('kaomoji'), 'kaomoji'));
    }
    bodyEl.replaceChildren(...parts);
    bodyEl.scrollTop = 0;
    const first = bodyEl.querySelector('.emo-cell');
    if (first) first.tabIndex = 0;
    preview(null);
  }

  function preview(it) {
    if (!footEl) return;
    if (!it) {
      const copy = !targetAlive(target);
      footEl.replaceChildren(h('span', { class: 'emo-hint caption text-2' }, copy ? t('emoji.hintCopy') : t('emoji.hint')));
      return;
    }
    const text = it.kind === 'emoji' ? withTone(it, prefs.tone) : labelOf(it) || it.c;
    footEl.replaceChildren(h('span', { class: ['emo-prev-c', `emo-${it.kind}`], 'aria-hidden': 'true' }, text), h('span', { class: 'emo-prev-name' }, nameOf(it)));
  }

  function renderAll() {
    if (!el) return;
    const tabs = h(
      'div',
      { class: 'tabs emo-tabs', role: 'tablist', 'aria-label': t('emoji.title') },
      ['emoji', 'kaomoji', 'symbols'].map((id) =>
        h('button', { class: ['tab', 'emo-tab', state.tab === id && 'selected'], type: 'button', role: 'tab', 'aria-selected': state.tab === id ? 'true' : 'false', tabindex: state.tab === id ? '0' : '-1', dataset: { tab: id }, onclick: () => setTab(id, { focus: false }) }, t(`emoji.tabs.${id}`)),
      ),
    );
    const pin = h('button', { class: ['btn', 'subtle', 'icon-btn', 'emo-pin', prefs.keepOpen && 'toggled'], type: 'button', 'aria-pressed': prefs.keepOpen ? 'true' : 'false', 'aria-label': t('emoji.keepOpen'), title: t('emoji.keepOpen'), onclick: () => setKeepOpen(!prefs.keepOpen) }, icon(prefs.keepOpen ? 'push-pin' : 'push-pin', { size: 16, filled: prefs.keepOpen }));
    const closeBtn = h('button', { class: 'btn subtle icon-btn emo-close', type: 'button', 'aria-label': t('emoji.close'), title: t('emoji.close'), onclick: () => close() }, icon('x', { size: 16 }));
    qInput = h('input', { class: 'input emo-q', type: 'search', spellcheck: false, autocomplete: 'off', placeholder: t('emoji.search'), 'aria-label': t('emoji.search'), value: state.query, oninput: () => setQuery(qInput.value) });
    catBar = h('div', { class: 'emo-cats' });
    bodyEl = h('div', { class: 'emo-body' });
    footEl = h('div', { class: 'emo-foot' });
    el.replaceChildren(
      h('div', { class: 'emo-head' }, tabs, h('div', { class: 'emo-head-tools' }, pin, closeBtn)),
      h('div', { class: 'emo-search' }, icon('magnifying-glass', { size: 16 }), qInput),
      catBar,
      bodyEl,
      footEl,
    );
    tonePop = null;
    renderCats();
    renderBody();
  }

  function setTab(id, { focus = true } = {}) {
    if (!['emoji', 'kaomoji', 'symbols'].includes(id)) return;
    state.tab = id;
    if (state.query) {
      state.query = '';
      if (qInput) qInput.value = '';
    }
    for (const b of el?.querySelectorAll('.emo-tab') || []) {
      const on = b.dataset.tab === id;
      b.classList.toggle('selected', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    }
    closeTones();
    renderCats();
    renderBody();
    if (focus) el?.querySelector(`.emo-tab[data-tab="${id}"]`)?.focus();
  }
  function setCategory(id, { focus = true } = {}) {
    if (state.tab === 'emoji') state.category = id;
    else if (state.tab === 'symbols') state.symGroup = id;
    else state.kaoGroup = id;
    renderCats();
    renderBody();
    if (focus) catBar?.querySelector(`.emo-cat[data-cat="${CSS.escape(id)}"]`)?.focus();
  }
  function setQuery(q) {
    state.query = String(q || '');
    if (catBar) catBar.hidden = !!state.query.trim();
    renderBody();
  }
  function setKeepOpen(on) {
    prefs.keepOpen = !!on;
    savePrefs();
    const pin = el?.querySelector('.emo-pin');
    if (pin) {
      pin.classList.toggle('toggled', prefs.keepOpen);
      pin.setAttribute('aria-pressed', prefs.keepOpen ? 'true' : 'false');
      pin.replaceChildren(icon('push-pin', { size: 16, filled: prefs.keepOpen }));
    }
  }
  function setTone(n) {
    const v = Number(n);
    prefs.tone = Number.isInteger(v) && v >= 0 && v < MODS.length ? v : 0;
    savePrefs();
    if (el) {
      renderCats();
      renderBody();
    }
  }

  // skin tone popover
  function toggleTones() {
    if (tonePop) return closeTones({ focusButton: true });
    const opts = MODS.map((m, i) =>
      h('button', { class: ['emo-tone', i === prefs.tone && 'selected'], type: 'button', role: 'option', 'aria-selected': i === prefs.tone ? 'true' : 'false', 'aria-label': toneName(i), title: toneName(i), tabindex: i === prefs.tone ? '0' : '-1', dataset: { tone: String(i) }, onclick: () => {
        closeTones();
        setTone(i);
        catBar?.querySelector('.emo-tone-btn')?.focus();
      } }, h('span', { class: 'emo-glyph' }, `✋${m}`)),
    );
    tonePop = h('div', { class: 'emo-tones', role: 'listbox', 'aria-label': t('emoji.tone') }, opts);
    el.appendChild(tonePop);
    const b = catBar?.querySelector('.emo-tone-btn');
    if (b) tonePop.style.top = `${b.offsetTop + b.offsetHeight + 4}px`;
    catBar?.querySelector('.emo-tone-btn')?.setAttribute('aria-expanded', 'true');
    (tonePop.querySelector('.emo-tone.selected') || opts[0]).focus();
  }
  function closeTones({ focusButton = false } = {}) {
    if (!tonePop) return;
    tonePop.remove();
    tonePop = null;
    const b = catBar?.querySelector('.emo-tone-btn');
    b?.setAttribute('aria-expanded', 'false');
    if (focusButton) b?.focus();
  }

  // ---------------------------------------------------------------- keyboard
  const cells = () => [...(bodyEl?.querySelectorAll('.emo-cell') || [])];
  function focusCell(c) {
    if (!c) return;
    for (const x of bodyEl.querySelectorAll('.emo-cell[tabindex="0"]')) x.tabIndex = -1;
    c.tabIndex = 0;
    c.focus({ preventScroll: true });
    c.scrollIntoView({ block: 'nearest' });
    lastCell = c;
    preview(cellItems.get(c));
  }
  // Up / Down move to the cell of the next row (sections included) nearest to the same column.
  function vertical(from, dir) {
    const r0 = from.getBoundingClientRect();
    const cx = r0.left + r0.width / 2;
    let rowTop = null;
    let best = null;
    for (const c of cells()) {
      const r = c.getBoundingClientRect();
      if (dir > 0 ? r.top < r0.bottom - 2 : r.bottom > r0.top + 2) continue;
      const rowKey = dir > 0 ? r.top : -r.top;
      if (rowTop == null || rowKey < rowTop - 2) {
        rowTop = rowKey;
        best = c;
      } else if (Math.abs(rowKey - rowTop) <= 2) {
        const d = Math.abs(r.left + r.width / 2 - cx);
        const bd = Math.abs(best.getBoundingClientRect().left + best.getBoundingClientRect().width / 2 - cx);
        if (d < bd) best = c;
      }
    }
    return best;
  }
  function rovingKeys(e, selector, onMove) {
    const list = [...el.querySelectorAll(selector)];
    const i = list.indexOf(e.target);
    if (i < 0) return false;
    let j = null;
    if (e.key === 'ArrowRight') j = (i + 1) % list.length;
    else if (e.key === 'ArrowLeft') j = (i - 1 + list.length) % list.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = list.length - 1;
    if (j == null) return false;
    e.preventDefault();
    onMove(list[j]);
    return true;
  }
  function focusables() {
    return [...el.querySelectorAll('button, input')].filter((x) => !x.disabled && x.tabIndex >= 0 && x.offsetParent !== null && !x.closest('[hidden]'));
  }
  function onKey(e) {
    if (!el || e.defaultPrevented) return;
    if (e.ctrlKey || e.metaKey || e.altKey) {
      if (e.key === 'Escape') e.preventDefault();
      return;
    }
    const tgt = e.target;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (tonePop) closeTones({ focusButton: true });
      else close();
      return;
    }
    if (e.key === 'Tab') {
      const list = focusables();
      if (!list.length) return;
      const i = list.indexOf(document.activeElement);
      if (e.shiftKey && i <= 0) {
        e.preventDefault();
        list[list.length - 1].focus();
      } else if (!e.shiftKey && i === list.length - 1) {
        e.preventDefault();
        list[0].focus();
      }
      return;
    }
    if (tonePop?.contains(tgt)) {
      if (rovingKeys(e, '.emo-tone', (b) => b.focus())) return;
      return;
    }
    if (tgt.classList.contains('emo-tab')) {
      rovingKeys(e, '.emo-tab', (b) => setTab(b.dataset.tab));
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        qInput?.focus();
      }
      return;
    }
    if (tgt.classList.contains('emo-cat')) {
      if (rovingKeys(e, '.emo-cat', (b) => setCategory(b.dataset.cat))) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        focusCell(bodyEl.querySelector('.emo-cell[tabindex="0"]') || cells()[0]);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        qInput?.focus();
      }
      return;
    }
    if (tgt === qInput) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (!catBar.hidden && !state.query.trim()) catBar.querySelector('.emo-cat[tabindex="0"]')?.focus();
        else focusCell(cells()[0]);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const first = cells()[0];
        if (first) choose(cellItems.get(first), { keep: e.shiftKey });
      }
      return;
    }
    if (tgt.classList.contains('emo-cell')) {
      const list = cells();
      const i = list.indexOf(tgt);
      let next = null;
      if (e.key === 'ArrowRight') next = list[i + 1];
      else if (e.key === 'ArrowLeft') next = list[i - 1];
      else if (e.key === 'ArrowDown') next = vertical(tgt, 1);
      else if (e.key === 'ArrowUp') {
        next = vertical(tgt, -1);
        if (!next) {
          e.preventDefault();
          if (!catBar.hidden) catBar.querySelector('.emo-cat[tabindex="0"]')?.focus();
          else qInput?.focus();
          return;
        }
      } else if (e.key === 'Home') next = list[0];
      else if (e.key === 'End') next = list[list.length - 1];
      else if (e.key === 'PageDown' || e.key === 'PageUp') {
        next = tgt;
        for (let k = 0; k < 5; k++) next = vertical(next, e.key === 'PageDown' ? 1 : -1) || next;
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        choose(cellItems.get(tgt), { keep: e.shiftKey });
        return;
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        qInput.focus();
        qInput.value = qInput.value.slice(0, -1);
        setQuery(qInput.value);
        return;
      } else if (e.key.length === 1 && e.key !== ' ') {
        // typing searches (the character lands in the field, which now has the focus)
        qInput.focus();
        return;
      }
      if (next) {
        e.preventDefault();
        focusCell(next);
      } else if (/^Arrow|Home|End|Page/.test(e.key)) e.preventDefault();
    }
  }

  // ---------------------------------------------------------------- open / close / place
  function place(rect) {
    const W = el.offsetWidth;
    const H = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // above the taskbar (its top edge when it is shown; it may auto-hide)
    const bar = document.getElementById('taskbar')?.getBoundingClientRect();
    const bottom = (bar && bar.height > 8 && bar.top > vh / 2 && bar.top < vh ? bar.top : vh - 60) - 8;
    let x = (vw - W) / 2;
    let y = bottom - H;
    if (rect && (rect.width || rect.height || rect.left || rect.top)) {
      x = rect.left - 24;
      y = rect.bottom + 8 + H <= bottom ? rect.bottom + 8 : rect.top - H - 8;
      if (y < 8) y = Math.max(8, Math.min(bottom - H, rect.bottom + 8));
    }
    x = Math.min(Math.max(8, x), vw - W - 8);
    el.style.left = `${Math.round(x)}px`;
    el.style.top = `${Math.round(Math.max(8, y))}px`;
  }

  async function open() {
    if (el || opening) return;
    opening = true;
    try {
      target = findTarget();
      shell.emit('start:close');
      shell.emit('flyouts:close');
      ui.closeMenus?.();
      await loadPrefs();
      el = h('div', { class: 'emo', role: 'dialog', 'aria-label': t('emoji.title'), tabindex: '-1' });
      el.addEventListener('keydown', onKey);
      el.addEventListener('click', onClick);
      el.addEventListener('pointerover', (e) => {
        const c = e.target.closest?.('.emo-cell');
        if (c) preview(cellItems.get(c));
      });
      el.addEventListener('focusin', (e) => {
        if (e.target.classList?.contains('emo-cell')) {
          lastCell = e.target;
          preview(cellItems.get(e.target));
        }
      });
      if (!D) load().then(() => el && (renderCats(), renderBody())).catch(() => el && renderBody());
      renderAll();
      document.getElementById('overlays').appendChild(el);
      place(caretRect(target));
      qInput?.focus({ preventScroll: true });
      const p = el;
      document.addEventListener('keydown', onDocKey, true);
      setTimeout(() => {
        if (el !== p) return; // closed meanwhile
        document.addEventListener('pointerdown', onOutside, true);
        document.addEventListener('focusin', onFocusOutside, true);
        document.addEventListener('selectionchange', onSelection);
      });
    } finally {
      opening = false;
    }
  }
  function close({ restore = true } = {}) {
    if (!el) return;
    const p = el;
    el = null;
    qInput = catBar = bodyEl = footEl = tonePop = null;
    lastCell = null;
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('focusin', onFocusOutside, true);
    document.removeEventListener('selectionchange', onSelection);
    document.removeEventListener('keydown', onDocKey, true);
    p.classList.add('closing');
    setTimeout(() => p.remove(), 150);
    if (state.query) state.query = '';
    if (!restore || !targetAlive(target)) return;
    const tg = target;
    if (tg.kind === 'x11') {
      api.send('xwin:cmd', { cmd: 'focus', id: tg.id });
      return;
    }
    if (p.contains(document.activeElement) || document.activeElement === document.body) {
      if (tg.kind === 'cm') tg.editor.querySelector('.cm-content')?.focus({ preventScroll: true });
      else tg.el.focus({ preventScroll: true });
      if (tg.kind === 'editable' && tg.range) {
        const sel = tg.el.ownerDocument.getSelection();
        sel.removeAllRanges();
        sel.addRange(tg.range);
      }
    }
  }
  function onClick(e) {
    const c = e.target.closest('.emo-cell');
    if (c && el.contains(c)) {
      const it = cellItems.get(c);
      if (it) choose(it, { keep: e.shiftKey });
      return;
    }
    const cat = e.target.closest('.emo-cat');
    if (cat) setCategory(cat.dataset.cat); // the bar is redrawn: the keyboard stays on the new button
  }
  // Escape also works when the keyboard focus fell out of the panel onto the page (nothing focused).
  function onDocKey(e) {
    if (!el || e.key !== 'Escape' || e.ctrlKey || e.altKey || e.metaKey) return;
    const a = document.activeElement;
    if (el.contains(a)) return; // the panel's own handler
    if (a && a !== document.body && a !== document.documentElement) return;
    e.preventDefault();
    e.stopPropagation();
    close();
  }
  function onOutside(e) {
    if (!el || el.contains(e.target) || e.target.closest?.('.menu')) return;
    if (prefs.keepOpen) return; // pinned: the click may pick another field (onFocusOutside)
    close({ restore: false });
  }
  // While the panel stays open, the field the user focuses becomes the target.
  function onFocusOutside(e) {
    if (!el || inserting || el.contains(e.target)) return;
    if (target?.el && target.el === e.target) return; // same field: its selection is followed (onSelection)
    const tg = describe(e.target);
    if (tg && tg.kind !== 'none') target = tg;
    else {
      const x = findTarget();
      if (x?.kind === 'x11') target = x;
    }
  }

  // The caret the user moves in the target (a click while the panel is pinned) is where the next character goes.
  function onSelection() {
    if (!el || inserting || !target) return;
    const sel = document.getSelection();
    if (!sel?.rangeCount) return;
    if (target.kind === 'editable' && target.el.contains(sel.anchorNode)) target.range = sel.getRangeAt(0).cloneRange();
  }

  // Answers of aurora-xwm to 'paste' (main/ipc/xwin.js broadcasts every helper event).
  api.on('xwin:event', (e) => {
    if (e?.ev !== 'paste') return;
    const resolve = pastes.get(e.id);
    if (!resolve) return;
    pastes.delete(e.id);
    resolve(e.ok === true);
  });
  shell.on('emoji:toggle', () => (el ? close() : open()));
  shell.on('flyouts:close', () => close({ restore: false }));
  shell.on('lock', () => close({ restore: false }));
  // A text change while the panel shows the old language: redraw it.
  i18n.on?.('change', () => el && renderAll());

  const api_ = {
    open,
    close,
    toggle: () => (el ? close() : open()),
    get isOpen() {
      return !!el;
    },
    ready: load,
    search: (q) => {
      const r = searchData(D, q, prefs.tone);
      return { emoji: r.emoji.map((x) => withTone(x, prefs.tone)), symbols: r.symbols.map((x) => x.c), kaomoji: r.kaomoji.map((x) => x.c) };
    },
    get state() {
      return { tab: state.tab, category: currentCat(), query: state.query, tone: prefs.tone, keepOpen: prefs.keepOpen, recents: JSON.parse(JSON.stringify(prefs.recents)) };
    },
    get target() {
      return target ? { kind: target.kind, id: target.id ?? null } : null;
    },
    insert: (text, opts) => {
      const it = D?.lookup.get(text) || { kind: 'symbols', c: String(text), en: '', fr: '' };
      return choose({ ...it, c: String(text), t: 0 }, opts);
    },
    setTone,
    setKeepOpen,
    setTab: (id) => setTab(id, { focus: false }),
    setCategory: (id) => setCategory(id, { focus: false }),
    withTone: (c, n) => {
      const it = D?.lookup.get(c);
      return it ? withTone(it, n) : c;
    },
  };
  ctx.emoji = api_;
}
