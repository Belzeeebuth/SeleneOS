// Aurora Browser — a Microsoft Edge / Chrome-like web browser built on <webview>.
// One module instance serves every browser window: lib/shared.js holds the data and routes
// backend events; lib/window.js is one window (tabs, toolbar, pages). Backend: main/ipc/browser.js.
import { initShared, shared } from './lib/shared.js';
import { BrowserWindowCtl } from './lib/window.js';

export default {
  async launch(ctx) {
    await initShared(ctx);
    const bw = new BrowserWindowCtl(ctx);
    await bw.init();
    return {
      ctl: bw,
      onRelaunch(args = {}) {
        // Private / explicit new windows always get their own window.
        if (args.private || args.newWindow) return ctx.shell.launch('browser', { ...args, newWindow: true });
        const target = shared.mostRecent() || null;
        if (!target) return ctx.shell.launch('browser', { ...args, newWindow: true });
        target.win.focus();
        if (args.url) target.openUrl(args.url, { active: true });
        else if (args.route) target.openInternal(args.route, args.query);
      },
    };
  },
};
