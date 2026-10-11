// Hub window: every note (search, colour dot, first line, preview, date), new note, delete with Undo.
// Keyboard: Ctrl+N new note, Ctrl+F search, arrows move between notes, Enter opens, Delete deletes,
// Shift+F10 / context menu key opens the note menu, Ctrl+Z undoes the last delete.
import { store, lines } from '../lib/store.js';
import { wins, openNote, newNote, deleteNote, undoDelete, noteMenu, relDate } from './actions.js';

export function createHub(ctx) {
  const { win, h, icon, t, ui } = ctx;
  win.setTitle(t('appName'));
  let query = '';
  let undoNote = null;
  let undoTimer = null;

  const search = h('input', {
    class: 'input sk-search',
    type: 'search',
    placeholder: t('search'),
    'aria-label': t('search'),
    oninput: () => {
      query = search.value;
      render();
    },
  });
  const addBtn = h('button', { class: 'btn subtle sk-icon-btn sk-add', title: `${t('newNote')} (Ctrl+N)`, 'aria-label': t('newNote'), onclick: () => newNote(ctx) }, icon('add', { size: 18 }));
  const list = h('div', { class: 'sk-list', role: 'list', 'aria-label': t('appName') });
  const undoBar = h('div', { class: 'infobar sk-undo', hidden: true, role: 'status' });
  const errBar = h('div', { class: 'infobar error sk-error', hidden: true, role: 'alert' }, icon('error_circle', { size: 16 }), h('span', null, t('saveFailed')));
  const root = h(
    'div',
    { class: 'sk-hub' },
    h('div', { class: 'sk-hub-head' }, h('div', { class: 'sk-hub-title title' }, t('appName')), addBtn),
    h('div', { class: 'sk-search-row' }, icon('search', { size: 16 }), search),
    errBar,
    list,
    undoBar,
  );
  win.body.appendChild(root);

  function card(n) {
    const all = lines(n.html);
    const first = all[0] || '';
    const el = h(
      'div',
      {
        class: 'sk-card',
        role: 'listitem',
        tabindex: '0',
        dataset: { id: n.id, color: n.color },
        'aria-label': first || t('emptyNote'),
        onclick: () => openNote(ctx, n.id),
        oncontextmenu: (e) => ui.menu(e, noteMenu(ctx, n.id, { fromHub: true })),
        onkeydown: (e) => onCardKey(e, n.id),
      },
      h('span', { class: 'sk-dot', 'aria-hidden': 'true' }),
      h(
        'div',
        { class: 'sk-card-main' },
        h('div', { class: ['sk-card-title', first ? '' : 'sk-muted'] }, first || t('emptyNote')),
        all.length > 1 ? h('div', { class: 'sk-card-preview' }, all.slice(1).join(' ')) : null,
      ),
      h('div', { class: 'sk-card-date caption' }, relDate(ctx, n.modified)),
      h(
        'button',
        {
          class: 'btn subtle sk-icon-btn sk-card-more',
          title: t('more'),
          'aria-label': t('more'),
          tabindex: '-1',
          onclick: (e) => {
            e.stopPropagation();
            ui.menu(e, noteMenu(ctx, n.id, { fromHub: true }));
          },
        },
        icon('more_horizontal', { size: 16 }),
      ),
    );
    return el;
  }

  function render() {
    const focusedId = document.activeElement?.closest?.('.sk-card')?.dataset.id;
    const notes = store.list(query);
    list.replaceChildren(...notes.map(card));
    if (!notes.length) {
      list.appendChild(
        h(
          'div',
          { class: 'empty sk-empty' },
          icon(query ? 'search' : 'note', { size: 40 }),
          h('div', { class: 'subtitle' }, query ? t('noResults') : t('emptyTitle')),
          query ? null : h('div', { class: 'caption' }, t('emptyHint')),
        ),
      );
    }
    if (focusedId && root.contains(document.activeElement) === false) {
      list.querySelector(`.sk-card[data-id="${CSS.escape(focusedId)}"]`)?.focus();
    }
  }

  function onCardKey(e, id) {
    const cards = [...list.querySelectorAll('.sk-card')];
    const i = cards.findIndex((c) => c.dataset.id === id);
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openNote(ctx, id);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      cards[Math.max(0, Math.min(cards.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      cards[e.key === 'Home' ? 0 : cards.length - 1]?.focus();
    } else if (e.key === 'Delete') {
      e.preventDefault();
      const next = cards[i + 1] || cards[i - 1];
      deleteNote(ctx, id);
      (next ? list.querySelector(`.sk-card[data-id="${CSS.escape(next.dataset.id)}"]`) : search)?.focus();
    } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      e.preventDefault();
      const r = e.currentTarget.getBoundingClientRect();
      ui.menu({ x: r.left + 24, y: r.bottom - 4 }, noteMenu(ctx, id, { fromHub: true }));
    }
  }

  function showUndo(note) {
    undoNote = note;
    clearTimeout(undoTimer);
    undoBar.replaceChildren(
      icon('delete', { size: 16 }),
      h('span', { class: 'sk-undo-text' }, t('deleted')),
      h(
        'button',
        {
          class: 'btn sk-undo-btn',
          onclick: () => {
            const n = undoNote;
            hideUndo();
            if (n) undoDelete(ctx, n.id);
          },
        },
        t('undo'),
      ),
    );
    undoBar.hidden = false;
    undoTimer = setTimeout(hideUndo, 8000);
  }
  function hideUndo() {
    clearTimeout(undoTimer);
    undoNote = null;
    undoBar.hidden = true;
  }

  root.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      newNote(ctx);
    } else if (mod && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      search.focus();
      search.select();
    } else if (mod && e.key.toLowerCase() === 'z' && undoNote && e.target !== search) {
      e.preventDefault();
      const n = undoNote;
      hideUndo();
      undoDelete(ctx, n.id);
    } else if (e.key === 'ArrowDown' && e.target === search) {
      e.preventDefault();
      list.querySelector('.sk-card')?.focus();
    } else if (e.key === 'Escape' && e.target === search && search.value) {
      e.preventDefault();
      search.value = '';
      query = '';
      render();
    }
  });

  let raf = 0;
  const off = store.on((kind) => {
    if (kind === 'error' || kind === 'saved') {
      errBar.hidden = kind !== 'error';
      return;
    }
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(render);
  });
  win.on('close', () => {
    off();
    clearTimeout(undoTimer);
    cancelAnimationFrame(raf);
    if (wins.hub?.win === win) wins.hub = null;
  });
  ctx.onLangChange?.(() => {
    win.setTitle(t('appName'));
    render();
  });
  render();
  const view = { root, render, showUndo, hideUndo, search, focusSearch: () => search.focus() };
  wins.hub = { win, view };
  setTimeout(() => (store.notes.length ? list.querySelector('.sk-card') : search)?.focus(), 0);
  return view;
}
