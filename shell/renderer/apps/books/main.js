// Livres (Books) — EPUB reader: a library of the books you opened or added (and those found in Documents and
// Téléchargements), and a reader with a table of contents, bookmarks, search, paginated or scrolled reading,
// text settings and reading themes. lib/app.js is one window, lib/library.js the home view, lib/reader.js the
// reader, lib/content.js turns chapters into safe documents (sandboxed frames, no script), lib/store.js keeps
// the library, positions, bookmarks and settings. Backend: main/ipc/books.js (ZIP + EPUB parsing).
// args: { file } opens that book (and adds it to the library).
import { BooksApp } from './lib/app.js';

export default {
  async launch(ctx) {
    const app = new BooksApp(ctx);
    return app.init();
  },
};
