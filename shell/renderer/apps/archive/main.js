// Archive Manager — a Windows 11-style "compressed folder" view with 7-Zip / File Roller power:
// browse ZIP, 7z, RAR, TAR (gz/xz/bz2/zst), CAB and JAR archives, extract all or part of them (safely),
// create archives (with AES encryption for ZIP / 7z), add and delete items, test and inspect them.
// Backend: main/ipc/archive.js (7z + bsdtar). Modules in lib/: window.js (one window), list.js (details
// view), navtree.js, preview.js, welcome.js, dialogs.js, ops.js (progress / errors), shared.js, util.js.
//
// Launch args:
//   { file: '/path/a.zip' }                      open an archive (an archive already open is focused)
//   { extract: '/path/a.zip', dest?, overwrite?: 'rename'|'replace'|'skip', show?: true }
//        "Extract here" without the full UI: a small progress window, then File Explorer shows the result
//        (dest defaults to a folder named after the archive, or next to it when it holds a single item)
//   { compress: ['/path/a', '/path/b'], format?: 'zip'|'7z'|'tar'|'tar.gz'|'tar.xz'|'tar.zst'|'tar.bz2',
//     dest?, level?: 0-9, show?: false }
//        with a format: creates <name>.<ext> next to the items (unique name) with a small progress window;
//        without: opens the "Create an archive" dialog pre-filled with the items.
import { shared } from './lib/shared.js';
import { ArchiveWindow } from './lib/window.js';

export default {
  async launch(ctx) {
    await shared.init(ctx);
    const w = new ArchiveWindow(ctx);
    ctx.win.el.__archive = w; // tests / debugging
    await w.init(ctx.args || {});
    return { archive: w };
  },
};
