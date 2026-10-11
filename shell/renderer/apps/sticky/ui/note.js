// One note window: coloured header (new note, keep on top, menu), contenteditable body, formatting bar.
// Keyboard: Ctrl+B / I / U bold / italic / underline, Ctrl+T strikethrough, Ctrl+Shift+L bullets, Ctrl+N new
// note, Ctrl+D delete, Ctrl+H notes list, Alt+T keep on top. Saves 500 ms after typing stops and on blur / close.
import { store, clean, firstLine } from '../lib/store.js';
import { wins, newNote, deleteNote, openHub, noteMenu } from './actions.js';

const FORMATS = [
  { cmd: 'bold', icon: 'text_bold', key: 'formatBold', short: 'Ctrl+B' },
  { cmd: 'italic', icon: 'text_italic', key: 'formatItalic', short: 'Ctrl+I' },
  { cmd: 'underline', icon: 'text_underline', key: 'formatUnderline', short: 'Ctrl+U' },
  { cmd: 'strikeThrough', icon: 'text_strikethrough', key: 'formatStrike', short: 'Ctrl+T' },
  { cmd: 'insertUnorderedList', icon: 'text_bullet_list_ltr', key: 'formatBullets', short: 'Ctrl+Shift+L' },
];

export function createNoteWindow(ctx, id) {
  const { win, h, icon, t, ui } = ctx;
  const note = store.get(id);
  win.setMinSize(220, 200);
  const area = typeof window !== 'undefined' ? { w: window.innerWidth, h: window.innerHeight } : null;
  const w = Math.max(220, Math.min(note.w || 320, area?.w || 9999));
  const hgt = Math.max(200, Math.min(note.h || 320, area?.h || 9999));
  if (Number.isFinite(note.x) && Number.isFinite(note.y) && area && note.x < area.w - 60 && note.y < area.h - 60 && note.x > -w + 60 && note.y >= 0) {
    win.setRect({ x: note.x, y: note.y, width: w, height: hgt });
  } else win.setSize(w, hgt);
  if (note.onTop) win.setAlwaysOnTop(true);

  let saveTimer = null;
  const editor = h('div', {
    class: 'sk-editor',
    contenteditable: 'true',
    role: 'textbox',
    'aria-multiline': 'true',
    'aria-label': t('noteBody'),
    spellcheck: 'true',
    'data-placeholder': t('placeholder'),
  });
  editor.innerHTML = note.html; // already cleaned by the store
  const pinBtn = h('button', { class: 'btn subtle sk-icon-btn sk-pin', onclick: () => toggleTop() });
  const formatBtns = FORMATS.map((f) =>
    h(
      'button',
      {
        class: 'btn subtle sk-icon-btn sk-fmt',
        dataset: { cmd: f.cmd },
        title: `${t(f.key)} (${f.short})`,
        'aria-label': t(f.key),
        'aria-pressed': 'false',
        onmousedown: (e) => e.preventDefault(), // keep the selection in the editor
        onclick: () => format(f.cmd),
      },
      icon(f.icon, { size: 16 }),
    ),
  );
  const moreBtn = h(
    'button',
    {
      class: 'btn subtle sk-icon-btn sk-more',
      title: t('more'),
      'aria-label': t('more'),
      'aria-haspopup': 'menu',
      onclick: (e) => openMenu(e),
    },
    icon('more_horizontal', { size: 16 }),
  );
  const root = h(
    'div',
    { class: 'sk-note', dataset: { color: note.color, id } },
    h(
      'div',
      { class: 'sk-note-head' },
      h('button', { class: 'btn subtle sk-icon-btn sk-new', title: `${t('newNote')} (Ctrl+N)`, 'aria-label': t('newNote'), onclick: () => newNote(ctx, store.get(id)) }, icon('add', { size: 16 })),
      h('div', { class: 'sk-grow' }),
      pinBtn,
      moreBtn,
    ),
    editor,
    h('div', { class: 'sk-format', role: 'toolbar', 'aria-label': t('formatting') }, formatBtns),
  );
  win.body.appendChild(root);

  function updateTitle() {
    const n = store.get(id);
    win.setTitle(firstLine(n?.html || '') || t('appName'));
  }
  function updatePin() {
    const on = !!store.get(id)?.onTop;
    pinBtn.replaceChildren(icon('pin', { size: 16, filled: on }));
    pinBtn.title = `${on ? t('unpin') : t('pin')} (Alt+T)`;
    pinBtn.setAttribute('aria-label', on ? t('unpin') : t('pin'));
    pinBtn.setAttribute('aria-pressed', String(on));
    pinBtn.classList.toggle('on', on);
  }
  function toggleTop() {
    const on = !store.get(id)?.onTop;
    store.update(id, { onTop: on });
    win.setAlwaysOnTop(on);
    updatePin();
  }
  function save() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!store.get(id)) return;
    store.update(id, { html: editor.innerHTML });
    updateTitle();
  }
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 500);
  }
  function format(cmd) {
    editor.focus();
    document.execCommand(cmd, false, null);
    scheduleSave();
    updateStates();
  }
  function updateStates() {
    for (const b of formatBtns) {
      let on = false;
      try {
        on = editor.contains(document.getSelection()?.anchorNode) && document.queryCommandState(b.dataset.cmd);
      } catch {}
      b.setAttribute('aria-pressed', String(!!on));
      b.classList.toggle('on', !!on);
    }
  }
  function openMenu(e) {
    save();
    ui.menu(e, noteMenu(ctx, id));
  }

  editor.addEventListener('input', scheduleSave);
  editor.addEventListener('blur', () => saveTimer && save());
  editor.addEventListener('keyup', updateStates);
  editor.addEventListener('mouseup', updateStates);
  editor.addEventListener('paste', (e) => {
    e.preventDefault();
    const html = e.clipboardData?.getData('text/html');
    const text = e.clipboardData?.getData('text/plain') || '';
    const safe = html ? clean(html) : text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]).replace(/\r?\n/g, '<br>');
    document.execCommand('insertHTML', false, safe);
    scheduleSave();
  });
  editor.addEventListener('drop', (e) => e.preventDefault()); // dropped HTML would skip the sanitizer
  root.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && e.shiftKey && k === 'l') format('insertUnorderedList');
    else if (mod && !e.shiftKey && k === 't') format('strikeThrough');
    else if (mod && !e.shiftKey && (k === 'b' || k === 'i' || k === 'u')) format({ b: 'bold', i: 'italic', u: 'underline' }[k]);
    else if (mod && !e.shiftKey && k === 'n') newNote(ctx, store.get(id));
    else if (mod && !e.shiftKey && k === 'd') deleteNote(ctx, id);
    else if (mod && !e.shiftKey && k === 'h') openHub(ctx);
    else if (e.altKey && !mod && k === 't') toggleTop();
    else if (e.key === 'Escape' && document.activeElement !== editor && root.contains(document.activeElement)) editor.focus();
    else return;
    e.preventDefault();
    e.stopPropagation();
  });

  // geometry is remembered per note
  let geoTimer = null;
  const saveGeo = () => {
    clearTimeout(geoTimer);
    geoTimer = setTimeout(() => {
      // maximized / snapped / fullscreen rects are not the note's own size (Win has no .maximized property)
      if (win.closed || win.minimized || (win.state && win.state !== 'normal')) return;
      const r = win.rect?.() || { x: win.x, y: win.y, width: win.w, height: win.h };
      store.update(id, { x: r.x, y: r.y, w: r.width, h: r.height });
    }, 400);
  };
  win.on('move', saveGeo);
  win.on('resize', saveGeo);

  const entry = { win, view: null };
  win.onBeforeClose(() => {
    if (!entry.deleting && store.get(id)) {
      save();
      store.update(id, { open: false });
      store.flush();
    }
    return true;
  });
  const off = store.on((kind, data) => {
    if (data?.note?.id !== id) return;
    const n = store.get(id);
    if (!n) return;
    root.dataset.color = n.color;
    updatePin();
    // a change made elsewhere (undo, another window): reload the body unless the user is typing in it
    if (data.touched && document.activeElement !== editor && n.html !== clean(editor.innerHTML)) {
      editor.innerHTML = n.html;
      updateTitle();
    }
  });
  win.on('close', () => {
    off();
    clearTimeout(saveTimer);
    clearTimeout(geoTimer);
    if (wins.notes.get(id) === entry) wins.notes.delete(id);
  });
  ctx.onLangChange?.(() => {
    updatePin();
    updateTitle();
  });

  updatePin();
  updateTitle();
  const view = {
    root,
    editor,
    save,
    toggleTop,
    focusEditor() {
      editor.focus();
      const sel = document.getSelection();
      sel.selectAllChildren(editor);
      sel.collapseToEnd();
    },
  };
  entry.view = view;
  wins.notes.set(id, entry);
  setTimeout(() => view.focusEditor(), 0);
  return view;
}
