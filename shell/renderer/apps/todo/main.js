// To Do (Microsoft To Do style): My Day with suggestions, Important, Planned, All, Completed, Tasks and
// user lists (emoji icons, themes, groups), steps, reminders (shell.reminders), due dates, repeating tasks,
// notes, search, drag and drop, keyboard shortcuts.
//   lib/dates.js  pure date / repeat math        lib/store.js  model, migrations, queries, persistence
//   lib/seed.js   first-run examples (EN / FR)   ui/*.js       window, panes, pickers, drag & drop
// Launch arguments: { reminder: { id, data: { taskId } } } (notification click) or { taskId } / { view }.
import { TodoApp } from './ui/app.js';

export default {
  async launch(ctx) {
    const app = new TodoApp(ctx);
    await app.init();
    return {
      onRelaunch: (args) => app.onRelaunch(args),
    };
  },
};
