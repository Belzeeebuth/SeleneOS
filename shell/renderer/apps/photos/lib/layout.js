// Justified-row and square-grid layout (pure functions, unit tested).
//
//   justify(aspects, width, { rowHeight, gap, maxScale })
//     -> { rows: [{ y, h, cells: [{ i, x, w }] }], height }
//   squares(count, width, { size, gap }) -> same shape
//
// aspects[i] = width / height of item i. Rows are filled until they are wider than `width` at the
// target height, then scaled down to fit exactly. The last (incomplete) row keeps the target height
// and stays left-aligned, like Windows Photos.
export const MIN_ASPECT = 0.3;
export const MAX_ASPECT = 4;

export function safeAspect(w, h) {
  const a = w > 0 && h > 0 ? w / h : 1;
  return Math.min(MAX_ASPECT, Math.max(MIN_ASPECT, a));
}

export function justify(aspects, width, { rowHeight = 200, gap = 4, maxScale = 1.6, y0 = 0 } = {}) {
  const rows = [];
  let y = y0;
  let start = 0;
  let sum = 0;
  width = Math.max(1, width);
  const flush = (end, last) => {
    const n = end - start;
    if (!n) return;
    const avail = width - gap * (n - 1);
    let h = last ? rowHeight : avail / sum;
    if (last && sum * rowHeight > avail) h = avail / sum; // a last row that is already too wide
    const cells = [];
    let x = 0;
    for (let i = start; i < end; i++) {
      const isLastCell = i === end - 1;
      // Full rows: snap the last cell to the right edge so rows line up exactly.
      const w = isLastCell && !last ? Math.max(1, width - x) : Math.max(1, aspects[i] * h);
      cells.push({ i, x: Math.round(x), w: Math.round(w) });
      x += w + gap;
    }
    // Rounding: make widths consistent with rounded x positions.
    for (let k = 0; k < cells.length - 1; k++) cells[k].w = Math.max(1, cells[k + 1].x - gap - cells[k].x);
    rows.push({ y: Math.round(y), h: Math.round(h), cells });
    y += Math.round(h) + gap;
    start = end;
    sum = 0;
  };
  for (let i = 0; i < aspects.length; i++) {
    sum += aspects[i];
    const n = i - start + 1;
    if (sum * rowHeight + gap * (n - 1) < width) continue;
    // The row overflows with item i: keep it, or end the row before it when that row's height is
    // closer to the target (balanced rows, like Windows Photos).
    if (n > 1) {
      const hWith = (width - gap * (n - 1)) / sum;
      const sumWithout = sum - aspects[i];
      const hWithout = (width - gap * (n - 2)) / sumWithout;
      if (hWithout <= rowHeight * maxScale && Math.abs(hWithout - rowHeight) < Math.abs(hWith - rowHeight)) {
        sum = sumWithout;
        flush(i, false);
        sum = aspects[i];
        if (sum * rowHeight >= width) flush(i + 1, false);
        continue;
      }
    }
    flush(i + 1, false);
  }
  flush(aspects.length, true);
  return { rows, height: rows.length ? y - gap - y0 : 0 };
}

export function squares(count, width, { size = 180, gap = 4, y0 = 0 } = {}) {
  width = Math.max(1, width);
  const perRow = Math.max(1, Math.floor((width + gap) / (size + gap)));
  const cellW = (width - gap * (perRow - 1)) / perRow;
  const rows = [];
  let y = y0;
  for (let i = 0; i < count; i += perRow) {
    const cells = [];
    for (let k = 0; k < perRow && i + k < count; k++) {
      const x = Math.round(k * (cellW + gap));
      const x2 = Math.round((k + 1) * (cellW + gap) - gap);
      cells.push({ i: i + k, x, w: x2 - x });
    }
    rows.push({ y: Math.round(y), h: Math.round(cellW), cells });
    y += Math.round(cellW) + gap;
  }
  return { rows, height: rows.length ? y - gap - y0 : 0 };
}

/** Index of the last element of a sorted array of tops that is <= y (binary search). */
export function findBlock(tops, y) {
  let lo = 0;
  let hi = tops.length - 1;
  if (hi < 0) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tops[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
