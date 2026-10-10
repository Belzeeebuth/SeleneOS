// Task Manager — Windows 11 style process / performance monitor.
// Opened from Start, Ctrl+Shift+Esc or the Run box (taskmgr). Launch args: { page: 'performance' | … }.
// Backend: main/ipc/taskmgr.js (proc:* and perf:* channels, read straight from /proc).
// lib/: app.js (window, navigation, command bar), store.js (polling + history), table.js (virtual
// tree-grid), chart.js (canvas charts), actions.js (end task, priority, properties, run new task),
// pages/*.js (one per navigation entry).
import { TaskManager } from './lib/app.js';

export default {
  async launch(ctx) {
    const tm = new TaskManager(ctx);
    await tm.init();
    ctx.win.taskmgr = tm; // handy for tests and debugging
    return {
      onRelaunch(args = {}) {
        if (args.page && tm.pages[args.page]) tm.go(args.page);
      },
    };
  },
};
