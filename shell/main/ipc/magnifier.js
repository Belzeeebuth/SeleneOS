'use strict';
// « Loupe » (screen magnifier, core/features/magnifier.js): the main-process side.
//
//   magnifier:cursor  -> { x, y, inside } | null   where the mouse pointer is, in CSS px of the shell page (0,0 = the
//                        page's top-left corner; inside: the point is on the page). The renderer asks for it, once per
//                        frame, only while the pointer is over something its page does not see: a Linux (X11)
//                        window reached through the shell's input shape (core/features/xwin.js), a client's menu, or
//                        outside the window (dev).
// Everything else (the magnified view, the copies of Linux windows, the X input shape through main/ipc/xwin.js) lives
// in the renderer.
const { screen } = require('electron');

module.exports = function register(api) {
  if (api.env?.mode && api.env.mode !== 'shell') return;
  api.handle('magnifier:cursor', () => {
    const w = api.getMainWindow();
    if (!w || w.isDestroyed()) return null;
    try {
      const p = screen.getCursorScreenPoint(); // DIP
      const cb = w.getContentBounds(); // DIP
      const zoom = w.webContents.getZoomFactor() || 1;
      const x = (p.x - cb.x) / zoom;
      const y = (p.y - cb.y) / zoom;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      const inside = p.x >= cb.x && p.y >= cb.y && p.x < cb.x + cb.width && p.y < cb.y + cb.height;
      return { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100, inside };
    } catch {
      return null;
    }
  });
};
