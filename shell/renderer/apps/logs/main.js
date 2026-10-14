// « Journaux système » (System Logs): reads the systemd journal. Launch args: { unit } or { identifier } (a source,
// e.g. from the System Monitor's Services tab), { preset: 'errors' | 'previous' | 'kernel' | 'mine' | 'all' },
// { boot }, { priority }, { search }.
// Backend: main/ipc/journal.js (journal:* channels, journalctl with an argument vector; fixtures in dev).
// lib/: app.js (window, views, filters, loading, live view, export, context), list.js (virtualised list),
// detail.js (details pane), source.js (service / app box with suggestions), format.js (pure helpers).
import { LogsApp } from './lib/app.js';

export default {
  async launch(ctx) {
    const app = new LogsApp(ctx);
    ctx.win.logs = app; // tests and debugging
    await app.init();
    return {
      onRelaunch(args = {}) {
        app.onRelaunch(args);
      },
    };
  },
};
