// Sticky Notes — a hub listing every note plus one small window per open note (Windows Sticky Notes style).
//   lib/store.js    shared data model (strict sanitizer reusing the Notes one), debounced atomic saves
//   ui/hub.js       the list window (search, colour, first line, date, delete with Undo)
//   ui/note.js      a note window (6 colours, B / I / U / S / bullets, keep on top, autosave)
//   ui/actions.js   window routing, delete / undo, "Copy to Notes" (notes:writeNote)
// Storage: ~/.local/share/aurora/sticky.json through main/ipc/sticky.js.
// Launch args: {} or { hub: true } -> the hub; { noteId } -> that note's window; { newNote: true } -> a new note.
// Notes that were open when the app was last used are reopened the first time the app starts in a session.
import { store } from './lib/store.js';
import { wins, openHub, openNote, newNote } from './ui/actions.js';
import { createHub } from './ui/hub.js';
import { createNoteWindow } from './ui/note.js';

export default {
  async launch(ctx) {
    await store.load(ctx.api);
    const args = ctx.args || {};
    const el = ctx.win.el;
    if (el) el.__sticky = { store, wins, ctx }; // test / debugging hook

    if (args.noteId) {
      const existing = wins.notes.get(args.noteId);
      if (!store.get(args.noteId) || (existing && !existing.win.closed)) {
        // unknown note or already shown (double click): focus the existing window, drop this one
        ctx.win.close(true);
        existing?.win.focus();
        return {};
      }
      el?.classList.add('sk-note-win');
      createNoteWindow(ctx, args.noteId);
      return {
        onRelaunch: (a) => route(ctx, a),
      };
    }

    if (wins.hub && !wins.hub.win.closed) {
      ctx.win.close(true);
      wins.hub.win.focus();
      return {};
    }
    el?.classList.add('sk-hub-win');
    createHub(ctx);
    if (!store.restored) {
      store.restored = true;
      for (const n of store.notes.filter((x) => x.open)) openNote(ctx, n.id);
    }
    if (args.newNote) newNote(ctx);
    return {
      onRelaunch: (a) => route(ctx, a),
    };
  },
};

function route(ctx, a = {}) {
  if (a?.noteId) return openNote(ctx, a.noteId);
  if (a?.newNote) return newNote(ctx);
  return openHub(ctx);
}
