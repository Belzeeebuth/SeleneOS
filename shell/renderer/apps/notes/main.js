// Notes — OneNote / Apple Notes-style note taking with Windows 11 styling.
//   Notebooks + smart views (All notes, Pinned, Recently deleted, #tags), full-text search with highlights,
//   rich text editor with Markdown shortcuts, checklists, tables and pictures, autosave, export / import.
//   Storage: ~/Documents/Notes (notes.json index + <id>/note.html + attachments), see main/ipc/notes.js.
//   Launch args: { noteId } opens a note; { newNote: true, title, text } creates one; { file: '/a.md' } imports.
//   Code: lib/ (sanitizer, Markdown, text, data model + retrying writes), ui/ (app controller, editor, lists,
//   DOM helpers, undo history, dialogs, popovers, key names).
import { NotesApp } from './ui/app.js';

export default {
  async launch(ctx) {
    const app = new NotesApp(ctx);
    ctx.win.el.__notes = app; // test / debugging hook
    ctx.win.onBeforeClose(() => app.beforeClose());
    await app.init();
    return {
      notes: app,
      onRelaunch(args = {}) {
        app.handleArgs(args || {});
      },
    };
  },
};
