// Media Player (Windows 11 style): music & video library, play queue, playlists, now playing
// view with visualizer, video playback with auto-hiding controls, mini player and full screen.
// See lib/app.js for the application, lib/queue.js for the (unit-tested) play queue logic.
import { MediaApp } from './lib/app.js';

export default {
  async launch(ctx) {
    // The app is only reached through `ref` (emptied on close): the shell keeps these hooks on
    // the window object, which may outlive the window for a while.
    const ref = { app: new MediaApp(ctx) };
    // The hooks are handed back before init() finishes: the registry only routes a relaunch
    // (another file opened while the window is starting) once launch() has returned, so
    // returning late would silently drop that file. Relaunches wait for init, in order.
    const ready = ref.app.init();
    ready.catch((err) => ref.app?.fail(err));
    ctx.onClose(() => (ref.app = null));
    return {
      onRelaunch: (args) => ref.app?.openArgs(args || {}, ready).catch(() => {}),
    };
  },
};
