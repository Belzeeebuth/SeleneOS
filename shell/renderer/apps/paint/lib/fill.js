// Scanline flood fill with colour tolerance.
//   const m = fillMask(imageData, x, y, tolerancePercent)  -> { mask, minX, minY, maxX, maxY, count } | null
//   applyMask(imageData, m, [r, g, b, a])
// The mask is computed against the original pixels, so filling with a colour that matches
// the target (within tolerance) can never loop forever.

export function fillMask(img, sx, sy, tolerance = 0) {
  const W = img.width;
  const H = img.height;
  sx = Math.floor(sx);
  sy = Math.floor(sy);
  if (sx < 0 || sy < 0 || sx >= W || sy >= H) return null;
  const d = img.data;
  const u32 = new Uint32Array(d.buffer, d.byteOffset, W * H);
  const mask = new Uint8Array(W * H);
  const seed = sy * W + sx;
  const tol = Math.round((Math.max(0, Math.min(100, tolerance)) / 100) * 255);
  const target = u32[seed];
  const o = seed * 4;
  const tr = d[o];
  const tg = d[o + 1];
  const tb = d[o + 2];
  const ta = d[o + 3];
  const match =
    tol === 0
      ? (i) => u32[i] === target || (ta === 0 && d[i * 4 + 3] === 0)
      : (i) => {
          const p = i * 4;
          const a = d[p + 3];
          if (ta === 0 && a === 0) return true;
          return Math.abs(d[p] - tr) <= tol && Math.abs(d[p + 1] - tg) <= tol && Math.abs(d[p + 2] - tb) <= tol && Math.abs(a - ta) <= tol;
        };
  let minX = sx;
  let maxX = sx;
  let minY = sy;
  let maxY = sy;
  let count = 0;
  const stack = [sx, sy];
  while (stack.length) {
    const y = stack.pop();
    let x = stack.pop();
    const row = y * W;
    if (mask[row + x] || !match(row + x)) continue;
    while (x > 0 && !mask[row + x - 1] && match(row + x - 1)) x--;
    let up = false;
    let down = false;
    for (; x < W; x++) {
      const i = row + x;
      if (mask[i] || !match(i)) break;
      mask[i] = 1;
      count++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y > 0) {
        const j = i - W;
        const m = !mask[j] && match(j);
        if (m && !up) {
          stack.push(x, y - 1);
          up = true;
        } else if (!m) up = false;
      }
      if (y < H - 1) {
        const j = i + W;
        const m = !mask[j] && match(j);
        if (m && !down) {
          stack.push(x, y + 1);
          down = true;
        } else if (!m) down = false;
      }
    }
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return count ? { mask, minX, minY, maxX, maxY, count, width: W, height: H } : null;
}

/** Writes `rgba` into every masked pixel of `img` (an ImageData of the same size as the mask). */
export function applyMask(img, m, rgba) {
  const W = img.width;
  const d = img.data;
  const [r, g, b, a = 255] = rgba;
  for (let y = m.minY; y <= m.maxY; y++) {
    let i = y * W + m.minX;
    for (let x = m.minX; x <= m.maxX; x++, i++) {
      if (!m.mask[i]) continue;
      const p = i * 4;
      d[p] = r;
      d[p + 1] = g;
      d[p + 2] = b;
      d[p + 3] = a;
    }
  }
}
