// Aurora Terminal — a Windows Terminal-style terminal emulator (xterm.js + real PTYs via
// main/ipc/pty.js and the aurora-pty helper). Tabs, split panes, profiles, find, settings.
//   shell.launch('terminal', { cwd: '/home/me/src', command: 'htop', profile: 'python', settings: true })
import { TerminalApp } from './lib/window.js';

export default {
  async launch(ctx) {
    const app = new TerminalApp(ctx);
    await app.init();
    return {
      app,
      onRelaunch(args) {
        if (args?.cwd || args?.command) app.newTab(app.profileById(args.profile) || app.defaultProfile(), { cwd: args.cwd || null, command: args.command || null });
      },
    };
  },
};
