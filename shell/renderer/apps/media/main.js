// Media Player (Windows 11 style): music & video library, play queue, playlists, now playing
// view with visualizer, video playback with auto-hiding controls, mini player and full screen.
// See lib/app.js for the application, lib/queue.js for the (unit-tested) play queue logic.
import { MediaApp } from './lib/app.js';

export default {
  async launch(ctx) {
    const app = new MediaApp(ctx);
    // The hooks are handed back before init() finishes: the registry only routes a relaunch
    // (another file opened while the window is starting) once launch() has returned, so
    // returning late would silently drop that file. Relaunches wait for init, in order.
    const ready = app.init();
    ready.catch((err) => app.fail(err));
    return {
      onRelaunch: (args) => ready.then(() => app.openArgs(args || {})).catch(() => {}),
    };
  },
};
