// Paint — a Windows 11-style raster editor for Aurora OS.
// The controller lives in app.js; chrome.js draws the command bar, dialogs.js the dialogs and
// lib/ holds the drawing engines (brushes, shapes, fill, text, history, codecs).
import { createPaint } from './app.js';

export default {
  async launch(ctx) {
    return createPaint(ctx);
  },
};
