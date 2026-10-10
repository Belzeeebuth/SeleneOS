// Photos: gallery, viewer, editor and slideshow for local pictures (Windows 11 Photos-like).
// args: { file } opens a viewer for that image with its folder in the filmstrip; no args opens the gallery.
import { PhotosApp } from './lib/app.js';

export default {
  async launch(ctx) {
    const app = new PhotosApp(ctx);
    return app.init();
  },
};
