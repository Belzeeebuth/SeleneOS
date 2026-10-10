// PDF Reader — a Windows 11-style PDF viewer built on pdf.js (pdfjs-dist).
// One module instance serves every window: lib/shared.js holds the preferences and the Recent list,
// lib/window.js is one window (tabs, command bar, sidebar, find, tools, presentation) and
// lib/doc.js one open document. pdf.js is loaded on first use by lib/engine.js.
import { shared } from './lib/shared.js';
import { PdfWindow } from './lib/window.js';

export default {
  async launch(ctx) {
    await shared.init(ctx);
    const w = new PdfWindow(ctx);
    ctx.win.el.__pdf = w; // test / debugging hook
    await w.init();
    return {
      pdf: w,
      // Single instance: a file opened from elsewhere becomes a tab (or is brought to the front when it
      // is already open). { newWindow: true } never reaches here — the registry opens another window.
      onRelaunch(args = {}) {
        if (args.file) {
          const found = shared.findOpen(args.file);
          if (found) {
            found.win.win.focus();
            found.win.activate(found.tab);
            return;
          }
          const target = shared.target() || w;
          target.win.focus();
          target.openPath(args.file);
          return;
        }
        (shared.target() || w).win.focus();
      },
    };
  },
};
