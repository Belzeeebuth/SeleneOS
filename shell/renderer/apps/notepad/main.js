// Notepad — a Windows 11-style plain text editor with tabs.
// One module instance serves every Notepad window: lib/shared.js holds preferences, recent files
// and the restorable session; lib/window.js is one window (tabs, menus, editor, find, status bar).
// Backend: main/ipc/notepad.js (installed font families). Files go through fs:readBytes/writeBytes.
import { shared } from './lib/shared.js';
import { NotepadWindow } from './lib/window.js';

export default {
  async launch(ctx) {
    await shared.init(ctx);
    const npw = new NotepadWindow(ctx);
    ctx.win.el.__notepad = npw; // test / debugging hook
    await npw.init();
    return {
      notepad: npw,
      // Single instance: a file opened from elsewhere goes to a new tab of the most recent window
      // (or to a new window when "Opening files: new window" is chosen). { newWindow: true } never
      // reaches here — the registry opens another window for it.
      onRelaunch(args = {}) {
        const target = shared.relaunchTarget() || npw;
        if (args.file) {
          if (shared.prefs.openFiles === 'window' && !shared.findDoc(args.file)) {
            ctx.shell.launch('notepad', { ...args, newWindow: true });
            return;
          }
          target.win.focus();
          target.openPath(args.file);
          return;
        }
        target.win.focus();
      },
    };
  },
};
