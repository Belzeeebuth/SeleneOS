// Window routing and actions shared by the hub and the note windows.
//   One hub window (the list) + one window per open note, all opened through shell.launch('sticky',
//   { newWindow: true, ... }) so each gets its own ctx, taskbar entry and WM features.
import { store, COLORS, firstLine, lines, plainText, newId } from '../lib/store.js';

export const wins = { hub: null, notes: new Map() }; // noteId -> { win, view }

export function openHub(ctx) {
  const hub = wins.hub;
  if (hub && !hub.win.closed) {
    hub.win.focus();
    return hub.win;
  }
  return ctx.shell.launch('sticky', { newWindow: true, hub: true });
}

export function openNote(ctx, id) {
  const cur = wins.notes.get(id);
  if (cur && !cur.win.closed) {
    cur.win.focus();
    cur.view?.focusEditor?.();
    return cur.win;
  }
  store.update(id, { open: true });
  return ctx.shell.launch('sticky', { newWindow: true, noteId: id });
}

export function newNote(ctx, from) {
  const n = store.create({ color: from?.color || 'yellow', open: true });
  openNote(ctx, n.id);
  return n;
}

/** Deletes a note: closes its window, offers Undo in the hub (if open) or in a notification. */
export function deleteNote(ctx, id) {
  const note = store.remove(id);
  if (!note) return;
  const w = wins.notes.get(id);
  if (w && !w.win.closed) {
    w.deleting = true;
    w.win.close(true);
  }
  const hub = wins.hub;
  if (hub && !hub.win.closed) hub.view?.showUndo?.(note);
  else {
    ctx.shell.notify({
      appId: 'sticky',
      title: ctx.t('deleted'),
      body: firstLine(note.html) || ctx.t('emptyNote'),
      actions: [{ label: ctx.t('undo'), onClick: () => undoDelete(ctx, note.id) }],
      silent: true,
    });
  }
}

export function undoDelete(ctx, id) {
  const note = store.undo(id);
  if (note && note.open) openNote(ctx, note.id);
  return note;
}

/** Copies a note into the Notes app (a new note file through the notes backend; Notes picks it up on load). */
export async function copyToNotes(ctx, id) {
  const n = store.get(id);
  if (!n) return null;
  const all = lines(n.html);
  const title = (all[0] || ctx.t('untitled')).slice(0, 200);
  const now = Date.now();
  const text = plainText(n.html);
  const noteId = newId().replace(/^s/, 'n');
  const meta = {
    id: noteId,
    title,
    notebookId: null,
    created: now,
    modified: now,
    pinned: false,
    preview: all.slice(1).join(' ').slice(0, 300),
    tags: [],
    words: text.split(/\s+/).filter(Boolean).length,
    chars: text.length,
  };
  try {
    await ctx.api.invoke('notes:writeNote', noteId, { html: n.html, meta, title, lang: ctx.lang });
    ctx.shell.notify({
      appId: 'sticky',
      title: ctx.t('copiedTitle'),
      body: ctx.t('copiedBody', { title }),
      actions: [{ label: ctx.t('openNotes'), onClick: () => ctx.shell.launch('notes', { noteId }) }],
      silent: true,
    });
    return noteId;
  } catch (err) {
    ctx.ui.alert(ctx.t('copyFailed'), { title: ctx.t('appName'), parent: ctx.win });
    console.error('[sticky] copy to Notes failed', err);
    return null;
  }
}

export function colorItems(ctx, id) {
  const n = store.get(id);
  return COLORS.map((c) => ({
    label: ctx.t(`color.${c}`),
    checked: n?.color === c,
    action: () => store.update(id, { color: c }),
  }));
}

export function noteMenu(ctx, id, { fromHub = false } = {}) {
  const n = store.get(id);
  if (!n) return [];
  return [
    fromHub ? { label: ctx.t('openNote'), icon: 'window_new', action: () => openNote(ctx, id) } : { label: ctx.t('notesList'), icon: 'list', action: () => openHub(ctx) },
    '-',
    ...colorItems(ctx, id),
    '-',
    { label: ctx.t('copyToNotes'), icon: 'notebook', action: () => copyToNotes(ctx, id) },
    { label: ctx.t('delete'), icon: 'delete', danger: true, shortcut: fromHub ? 'Del' : 'Ctrl+D', action: () => deleteNote(ctx, id) },
  ];
}

export function relDate(ctx, ms) {
  const d = new Date(ms);
  const now = new Date();
  const locale = ctx.lang === 'fr' ? 'fr-FR' : 'en-US';
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  const opts = d.getFullYear() === now.getFullYear() ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' };
  return d.toLocaleDateString(locale, opts);
}
