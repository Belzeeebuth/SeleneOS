// Thumbnail worker: fetch an image, decode it off the main thread (EXIF orientation applied),
// downscale and encode a small WebP.  in: { id, url, height, maxWidth }  out: { id, blob, w, h } | { id, error }
self.onmessage = async (e) => {
  const { id, url, height = 320, maxWidth = 960 } = e.data || {};
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const full = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    const w = full.width;
    const h = full.height;
    let th = Math.min(height, h);
    let tw = Math.max(1, Math.round((w * th) / h));
    if (tw > maxWidth) {
      tw = maxWidth;
      th = Math.max(1, Math.round((h * tw) / w));
    }
    let bmp = full;
    if (tw !== w || th !== h) {
      // Halve in steps for big reductions: much better quality than one bilinear pass.
      let cur = full;
      let cw = w;
      let ch = h;
      while (cw / 2 >= tw * 1.5 && ch / 2 >= th * 1.5) {
        cw = Math.round(cw / 2);
        ch = Math.round(ch / 2);
        const next = await createImageBitmap(cur, { resizeWidth: cw, resizeHeight: ch, resizeQuality: 'medium' });
        if (cur !== full) cur.close();
        cur = next;
      }
      bmp = await createImageBitmap(cur, { resizeWidth: tw, resizeHeight: th, resizeQuality: 'high' });
      if (cur !== full) cur.close();
    }
    const canvas = new OffscreenCanvas(tw, th);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bmp, 0, 0);
    if (bmp !== full) bmp.close();
    full.close();
    const out = await canvas.convertToBlob({ type: 'image/webp', quality: 0.82 });
    self.postMessage({ id, blob: out, w, h });
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
