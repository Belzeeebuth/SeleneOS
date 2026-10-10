// Media Player (Windows 11 style): music & video library, play queue, playlists, now playing
// view with visualizer, video playback with auto-hiding controls, mini player and full screen.
// See lib/app.js for the application, lib/queue.js for the (unit-tested) play queue logic.
import { MediaApp } from './lib/app.js';

export default {
  async launch(ctx) {
    const app = new MediaApp(ctx);
    await app.init();
    return {
      onRelaunch: (args) => app.handleArgs(args || {}),
    };
  },
};
