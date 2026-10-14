// Polices (Fonts): browse the installed fonts, preview them, install fonts for the current user and remove them.
//
//   Main window   lib/manager.js: filters (Toutes, Serif, Sans serif, Chasse fixe, Manuscrites, Décoratives, Symboles,
//                 Installées par moi), search, editable sample text, size slider, light / dark preview background,
//                 grid or list; a family page (lib/family.js) with every style, a size waterfall, the character map
//                 (click to copy) and the details (file, format, version, licence…).
//   Preview       lib/preview.js: a font file opened from Fichiers (ctx.args.file) gets its own window with
//                 « Installer pour moi » or « Déjà installée ».
//   Install       lib/install.js: per user only (~/.local/share/fonts, main/ipc/fonts.js); dropping font files on any
//                 window installs them after a confirmation. System-wide installs are not offered.
//   Faces         lib/pool.js: previews use FontFace objects built from the file bytes under unique aliases,
//                 released when the cards leave the screen and when the window closes.
//
// Launch args: { file, index } (preview), { family } (main window on that family's page).
// Test hook: the window element carries `__fonts` (the Manager or Preview object).
import { Manager } from './lib/manager.js';
import { Preview } from './lib/preview.js';

export default {
  async launch(ctx) {
    const app = ctx.args && typeof ctx.args.file === 'string' && ctx.args.file ? new Preview(ctx) : new Manager(ctx);
    const winEl = ctx.win.el || ctx.win.body.closest('.win');
    if (winEl) winEl.__fonts = app;
    await app.init();
    return {
      onRelaunch(args) {
        ctx.win.focus();
        if (app instanceof Manager && typeof args?.family === 'string') app.openFamily(args.family);
      },
    };
  },
};
