// File Explorer — Windows 11 style file manager with tabs.
// Launch args: { path: '/abs/path' | 'home' | 'thispc' | 'trash', select?: '/abs/path/of/item' }
// Every launch opens a new window (not singleInstance). The heavy lifting lives in lib/:
//   explorer.js (window, tabs, navigation, commands)  view.js (content views, selection, rename)
//   navpane.js (tree)  address.js (breadcrumbs, search)  panes.js (details / preview)
//   ops.js (copy/move/trash/undo)  dialogs.js (properties, open with, options)  dnd.js  shared.js  types.js
import { initShared } from './lib/shared.js';
import { Explorer } from './lib/explorer.js';

export default {
  async launch(ctx) {
    await initShared(ctx);
    const ex = new Explorer(ctx);
    await ex.init(ctx.args || {});
    // Handy for tests and debugging: the explorer instance of this window.
    ctx.win.explorer = ex;
    return {
      onRelaunch: (args) => ex.openArgs(args),
    };
  },
};
