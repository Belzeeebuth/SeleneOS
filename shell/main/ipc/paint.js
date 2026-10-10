'use strict';
// Paint backend.
//   paint:fonts                      -> ['DejaVu Sans', 'Inter', …]  (sorted, unique; [] when fontconfig is missing)
//   paint:clipboardWriteImage(png)   -> true        puts a PNG picture on the system clipboard
//   paint:clipboardReadImage()       -> Uint8Array | null   picture currently on the clipboard (PNG, or the
//                                                    platform's image type when no PNG is offered)
// The clipboard channels work with both the classic Electron clipboard API (readImage/writeImage)
// and the asynchronous W3C-style API of newer Electron releases (read/write of ClipboardItems).
const electron = require('electron');
const { run } = require('../lib/exec');

let fontCache = null;

async function writeImage(bytes) {
  const { clipboard, nativeImage } = electron;
  const buf = Buffer.from(bytes);
  if (typeof clipboard.writeImage === 'function') {
    clipboard.writeImage(nativeImage.createFromBuffer(buf));
    return true;
  }
  const Item = electron.ClipboardItem;
  if (!Item || typeof clipboard.write !== 'function') throw new Error('Clipboard images are not supported');
  await clipboard.write([new Item({ 'image/png': new Blob([buf], { type: 'image/png' }) })]);
  return true;
}

async function readImage() {
  const { clipboard } = electron;
  if (typeof clipboard.readImage === 'function') {
    const img = clipboard.readImage();
    return img.isEmpty() ? null : new Uint8Array(img.toPNG());
  }
  if (typeof clipboard.read !== 'function') return null;
  const items = await clipboard.read();
  for (const item of items || []) {
    const types = item.types || [];
    const type = types.includes('image/png') ? 'image/png' : types.find((t) => /^image\//.test(t));
    if (!type) continue;
    const blob = await item.getType(type);
    if (blob && typeof blob.arrayBuffer === 'function') return new Uint8Array(await blob.arrayBuffer());
  }
  return null;
}

module.exports = function register(api) {
  api.handle('paint:fonts', async () => {
    if (fontCache) return fontCache;
    try {
      const { stdout } = await run('fc-list', ['--format', '%{family[0]}\n', ':scalable=true'], { timeout: 15000 });
      const set = new Set();
      for (const line of stdout.split('\n')) {
        const f = line.trim();
        if (f && !f.startsWith('.') && !/emoji|symbol/i.test(f)) set.add(f);
      }
      fontCache = [...set].sort((a, b) => a.localeCompare(b));
    } catch {
      fontCache = [];
    }
    return fontCache;
  });
  api.handle('paint:clipboardWriteImage', (bytes) => writeImage(bytes));
  api.handle('paint:clipboardReadImage', () => readImage());
};
