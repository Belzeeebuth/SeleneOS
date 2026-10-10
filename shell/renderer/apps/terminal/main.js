// Aurora Terminal — a Windows Terminal-style terminal emulator (xterm.js + real PTYs via
// main/ipc/pty.js and the aurora-pty helper). Tabs, split panes, profiles, find, settings.
//   shell.launch('terminal', { cwd: '/home/me/src', command: 'htop', profile: 'python', settings: true })
//   Each launch opens a new window (like wt.exe); command is run by the user's shell.
import { TerminalApp } from './lib/window.js';

export default {
  async launch(ctx) {
    const app = new TerminalApp(ctx);
    await app.init();
    return { app };
  },
};
