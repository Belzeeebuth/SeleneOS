'use strict';
// Snipping Tool backend: image clipboard that works on every Electron release.
//   snipping:clipboardWriteImage(pngBytes) -> true          puts a PNG picture on the system clipboard
//   snipping:clipboardReadImage()          -> Uint8Array | null   the picture on the clipboard (PNG when offered)
// Electron dropped clipboard.writeImage/readImage in favour of the asynchronous W3C-style
// clipboard.write/read with ClipboardItems; the core clipboard:writeImage channel only knows the
// former, so these channels try the classic API first and fall back to the new one.
const electron = require('electron');

async function writeImage(bytes) {
  const { clipboard, nativeImage } = electron;
  if (!bytes || !bytes.length) throw new Error('No image data');
  const buf = Buffer.from(bytes);
  if (typeof clipboard.writeImage === 'function' && nativeImage) {
    const img = nativeImage.createFromBuffer(buf);
    if (img.isEmpty()) throw new Error('Invalid image data');
    clipboard.writeImage(img);
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
  api.handle('snipping:clipboardWriteImage', (bytes) => writeImage(bytes));
  api.handle('snipping:clipboardReadImage', () => readImage());
};
