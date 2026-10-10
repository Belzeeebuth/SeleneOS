// Wallpaper helpers for the sign-in / lock screens.
//   await blurredImage(url, { blur, brightness, saturate, width }) -> blob: URL (cached per url+options) or ''
//   await topLuminance(url) -> mean relative luminance (0..1) of the top of the picture (where the clock is), or null
// The blur is rendered once on a small canvas (no live CSS backdrop blur: cheap with software rendering in a VM).
// Pictures are loaded in CORS mode: a user's own wallpaper comes from media:// (another origin than app://shell),
// and without it the canvas would be "tainted" and could not be read back (no blurred copy at all).
const cache = new Map();

function loadImage(url) {
  const img = new Image();
  img.decoding = 'async';
  if (!/^(data|blob):/i.test(url)) img.crossOrigin = 'anonymous';
  img.src = url;
  return img.decode().then(() => img);
}

export async function blurredImage(url, { blur = 26, brightness = 0.78, saturate = 1.25, width = 720 } = {}) {
  if (!url) return '';
  const key = `${url}|${blur}|${brightness}|${saturate}|${width}`;
  if (cache.has(key)) return cache.get(key);
  const job = (async () => {
    try {
      const img = await loadImage(url);
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

const lumCache = new Map();

/** Mean relative luminance of the top 45 % of the picture as shown (cover-fit to the screen), or null. */
export function topLuminance(url) {
  if (!url) return Promise.resolve(null);
  const key = `${url}|${Math.round((window.innerHeight / Math.max(1, window.innerWidth)) * 100)}`;
  if (lumCache.has(key)) return lumCache.get(key);
  const job = (async () => {
    try {
      const img = await loadImage(url);
      const w = 48;
      const hgt = Math.max(8, Math.round((w * window.innerHeight) / Math.max(1, window.innerWidth)));
      const c = document.createElement('canvas');
      c.width = w;
      c.height = hgt;
      const g = c.getContext('2d', { willReadFrequently: true });
      const k = Math.max(w / img.naturalWidth, hgt / img.naturalHeight);
      g.drawImage(img, (w - img.naturalWidth * k) / 2, (hgt - img.naturalHeight * k) / 2, img.naturalWidth * k, img.naturalHeight * k);
      const rows = Math.max(1, Math.round(hgt * 0.45));
      const d = g.getImageData(0, 0, w, rows).data;
      const lin = (v) => {
        const x = v / 255;
        return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
      };
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += 0.2126 * lin(d[i]) + 0.7152 * lin(d[i + 1]) + 0.0722 * lin(d[i + 2]);
      return sum / (d.length / 4);
    } catch {
      return null;
    }
  })();
  lumCache.set(key, job);
  return job;
}

/** Preload an image for a CSS background (plain, non-CORS load: resolves true when decoded, false on error). */
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
