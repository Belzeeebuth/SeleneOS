// Wallpaper helpers for the sign-in / lock screens.
//   await blurredImage(url, { blur, brightness, saturate, width }) -> blob: URL (cached per url+options) or ''
// The blur is rendered once on a small canvas (no live CSS backdrop blur: cheap with software rendering in a VM).
const cache = new Map();

export async function blurredImage(url, { blur = 26, brightness = 0.78, saturate = 1.25, width = 720 } = {}) {
  if (!url) return '';
  const key = `${url}|${blur}|${brightness}|${saturate}|${width}`;
  if (cache.has(key)) return cache.get(key);
  const job = (async () => {
    try {
      const img = new Image();
      img.decoding = 'async';
      img.src = url;
      await img.decode();
      const w = width;
      const ratio = Math.max(0.3, window.innerHeight / Math.max(1, window.innerWidth));
      const hgt = Math.round(w * ratio);
      const c = document.createElement('canvas');
      c.width = w;
      c.height = hgt;
      const g = c.getContext('2d');
      // Cover-fit, slightly oversized so the blurred edges never show.
      const k = Math.max(w / img.naturalWidth, hgt / img.naturalHeight) * 1.12;
      const dw = img.naturalWidth * k;
      const dh = img.naturalHeight * k;
      g.fillStyle = '#10131a';
      g.fillRect(0, 0, w, hgt);
      g.filter = `blur(${blur}px) saturate(${saturate}) brightness(${brightness})`;
      g.drawImage(img, (w - dw) / 2, (hgt - dh) / 2, dw, dh);
      return await new Promise((res) => c.toBlob((b) => res(b ? URL.createObjectURL(b) : ''), 'image/jpeg', 0.92));
    } catch {
      return '';
    }
  })();
  cache.set(key, job);
  const out = await job;
  if (!out) cache.delete(key);
  return out;
}

/** Preload an image (resolves true when decoded, false on error). */
export async function preload(url) {
  if (!url) return false;
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return true;
  } catch {
    return false;
  }
}
