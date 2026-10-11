'use strict';
// Pure rectangle algebra for the X shape of the shell window (docs/XWINDOWS.md, "Shape").
// A rect is { x, y, width, height } in integer pixels; empty rects are dropped everywhere.
//
//   norm(r)                    -> integer rect or null when empty / invalid
//   subtract(a, b)             -> a − b as up to 4 disjoint rects
//   subtractAll(rects, cuts)   -> ⋃rects − ⋃cuts (disjoint pieces)
//   complement(bounds, holes, { max }) -> bounds − ⋃holes as a small set of disjoint rects
//       (band decomposition + vertical merge). When more than `max` rects would be needed, the
//       smallest holes are dropped first (a dropped hole only means the shell keeps covering that
//       client area — the safe failure).
//   area(rects), equal(a, b)

function norm(r) {
  if (!r) return null;
  const x = Math.round(Number(r.x));
  const y = Math.round(Number(r.y));
  const x2 = Math.round(Number(r.x) + Number(r.width));
  const y2 = Math.round(Number(r.y) + Number(r.height));
  if (![x, y, x2, y2].every(Number.isFinite) || x2 <= x || y2 <= y) return null;
  return { x, y, width: x2 - x, height: y2 - y };
}

function intersect(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  return x2 > x && y2 > y ? { x, y, width: x2 - x, height: y2 - y } : null;
}

function subtract(a, b) {
  const A = norm(a);
  if (!A) return [];
  const B = norm(b);
  const i = B && intersect(A, B);
  if (!i) return [A];
  const out = [];
  const ax2 = A.x + A.width;
  const ay2 = A.y + A.height;
  const ix2 = i.x + i.width;
  const iy2 = i.y + i.height;
  if (i.y > A.y) out.push({ x: A.x, y: A.y, width: A.width, height: i.y - A.y }); // top band
  if (iy2 < ay2) out.push({ x: A.x, y: iy2, width: A.width, height: ay2 - iy2 }); // bottom band
  if (i.x > A.x) out.push({ x: A.x, y: i.y, width: i.x - A.x, height: i.height }); // left
  if (ix2 < ax2) out.push({ x: ix2, y: i.y, width: ax2 - ix2, height: i.height }); // right
  return out;
}

function subtractAll(rects, cuts) {
  let cur = (rects || []).map(norm).filter(Boolean);
  for (const c of (cuts || []).map(norm).filter(Boolean)) {
    const next = [];
    for (const r of cur) next.push(...subtract(r, c));
    cur = next;
    if (!cur.length) break;
  }
  return cur;
}

function area(rects) {
  return (rects || []).reduce((s, r) => s + r.width * r.height, 0);
}

// bounds − ⋃holes with horizontal bands; identical spans in touching bands are merged vertically.
function bandComplement(B, holes) {
  const ys = new Set([B.y, B.y + B.height]);
  for (const h of holes) {
    ys.add(h.y);
    ys.add(h.y + h.height);
  }
  const edges = [...ys].sort((a, b) => a - b);
  const out = [];
  let open = new Map(); // "x,width" -> rect still growing downwards
  for (let k = 0; k < edges.length - 1; k++) {
    const y = edges[k];
    const y2 = edges[k + 1];
    if (y2 <= y) continue;
    // x intervals covered by holes in this band
    const iv = holes
      .filter((h) => h.y < y2 && h.y + h.height > y)
      .map((h) => [h.x, h.x + h.width])
      .sort((a, b) => a[0] - b[0]);
    const spans = [];
    let x = B.x;
    for (const [s, e] of iv) {
      if (s > x) spans.push([x, s]);
      x = Math.max(x, e);
    }
    if (x < B.x + B.width) spans.push([x, B.x + B.width]);
    const next = new Map();
    for (const [s, e] of spans) {
      const key = `${s},${e - s}`;
      const prev = open.get(key);
      if (prev && prev.y + prev.height === y) {
        prev.height += y2 - y;
        next.set(key, prev);
        open.delete(key);
      } else {
        const r = { x: s, y, width: e - s, height: y2 - y };
        out.push(r);
        next.set(key, r);
      }
    }
    open = next;
  }
  return out;
}

function complement(bounds, holes, { max = 250 } = {}) {
  const B = norm(bounds);
  if (!B) return [];
  let hs = (holes || [])
    .map(norm)
    .filter(Boolean)
    .map((h) => intersect(B, h))
    .filter(Boolean);
  // biggest first, so that dropping from the end drops the smallest holes
  hs.sort((a, b) => b.width * b.height - a.width * a.height);
  for (;;) {
    const out = bandComplement(B, hs);
    if (out.length <= max || !hs.length) return out;
    hs = hs.slice(0, -1);
  }
}

function equal(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((r, i) => r.x === b[i].x && r.y === b[i].y && r.width === b[i].width && r.height === b[i].height);
}

module.exports = { norm, intersect, subtract, subtractAll, complement, area, equal };
