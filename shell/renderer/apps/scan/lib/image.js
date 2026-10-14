// Numérisation — picture helpers without DOM (test/scan.unit.mjs imports them in Node).
//   detectDocument({ data, width, height }, { tolerance, minFill }) -> { x, y, w, h } (pixels) | null
//       The document on the glass in a preview: pixels that differ from the lid (the median colour of the border)
//       give rows and columns; the largest dense band of each is the document. null when nothing stands out or when
//       the whole glass differs (a lid as white as the paper, a full-page document).
//   nearestResolution(dpi, { list, range }) -> a resolution the scanner accepts (closest, ties to the higher one)
//   presetResolutions(resolutions, presets) -> [{ preset, dpi }] one entry per distinct dpi
//   clampArea(a, W, H, min) -> { left, top, width, height } inside 0..W × 0..H, at least min × min
//   PAPER: feeder page sizes in mm; paperArea(id, area) -> the size, cut to what the feeder can take
//   filterOf({ brightness, contrast }) -> a canvas / CSS filter string ('none' when untouched)

export function detectDocument(img, { tolerance = 30, minFill = 0.04 } = {}) {
  const { data, width: W, height: H } = img || {};
  if (!data || W < 8 || H < 8) return null;
  const ch = data.length >= W * H * 4 ? 4 : data.length >= W * H * 3 ? 3 : 1;
  // the lid: median of the outermost 2-pixel band, per channel
  const samples = [[], [], []];
  const take = (x, y) => {
    const o = (y * W + x) * ch;
    for (let c = 0; c < 3; c++) samples[c].push(data[o + (ch === 1 ? 0 : c)]);
  };
  for (let x = 0; x < W; x += 1) for (const y of [0, 1, H - 2, H - 1]) take(x, y);
  for (let y = 2; y < H - 2; y += 1) for (const x of [0, 1, W - 2, W - 1]) take(x, y);
  const bg = samples.map((s) => s.sort((a, b) => a - b)[s.length >> 1]);
  const fg = new Uint8Array(W * H);
  const rows = new Uint32Array(H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * ch;
      let d = 0;
      for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(data[o + (ch === 1 ? 0 : c)] - bg[c]));
      if (d > tolerance) {
        fg[y * W + x] = 1;
        rows[y]++;
      }
    }
  }
  const band = (counts, len, need) => {
    // largest run of dense lines; gaps up to 4 % of the length (the space between lines of text) are bridged
    const gap = Math.max(1, Math.round(len * 0.04));
    let best = null;
    let start = -1;
    let last = -1;
    for (let i = 0; i <= len; i++) {
      const on = i < len && counts[i] >= need;
      if (on) {
        if (start < 0 || i - last > gap + 1) {
          if (start >= 0 && (!best || last - start > best[1] - best[0])) best = [start, last];
          start = i;
        }
        last = i;
      }
    }
    if (start >= 0 && (!best || last - start > best[1] - best[0])) best = [start, last];
    return best;
  };
  const ry = band(rows, H, Math.max(2, Math.round(W * minFill)));
  if (!ry) return null;
  const cols = new Uint32Array(W);
  for (let y = ry[0]; y <= ry[1]; y++) for (let x = 0; x < W; x++) cols[x] += fg[y * W + x];
  const rx = band(cols, W, Math.max(2, Math.round((ry[1] - ry[0] + 1) * minFill)));
  if (!rx) return null;
  const box = { x: rx[0], y: ry[0], w: rx[1] - rx[0] + 1, h: ry[1] - ry[0] + 1 };
  const share = (box.w * box.h) / (W * H);
  if (share < 0.03 || (box.w >= W * 0.97 && box.h >= H * 0.97)) return null;
  return box;
}

export function nearestResolution(dpi, r) {
  const want = Number(dpi) || 300;
  if (r?.range) {
    const { min, max } = r.range;
    const step = r.range.step || 1;
    const v = Math.min(max, Math.max(min, want));
    return Math.min(max, min + Math.round((v - min) / step) * step);
  }
  const list = r?.list || [];
  if (!list.length) return r?.def || want;
  let best = list[0];
  for (const v of list) if (Math.abs(v - want) < Math.abs(best - want) || (Math.abs(v - want) === Math.abs(best - want) && v > best)) best = v;
  return best;
}

export function presetResolutions(r, presets = [150, 300, 600]) {
  const out = [];
  for (const p of presets) {
    const dpi = nearestResolution(p, r);
    if (!out.some((x) => x.dpi === dpi)) out.push({ preset: p, dpi });
  }
  return out;
}

export function clampArea(a, W, H, min = 5) {
  let width = Math.max(Math.min(min, W), Math.min(W, Number(a.width) || W));
  let height = Math.max(Math.min(min, H), Math.min(H, Number(a.height) || H));
  const left = Math.max(0, Math.min(W - width, Number(a.left) || 0));
  const top = Math.max(0, Math.min(H - height, Number(a.top) || 0));
  width = Math.min(width, W - left);
  height = Math.min(height, H - top);
  return { left, top, width, height };
}

export const PAPER = {
  a4: [210, 297],
  a5: [148, 210],
  letter: [215.9, 279.4],
  legal: [215.9, 355.6],
};

export function paperArea(id, area) {
  if (!area) return null;
  const size = PAPER[id];
  if (!size) return { left: 0, top: 0, width: area.width, height: area.height };
  return { left: 0, top: 0, width: Math.min(size[0], area.width), height: Math.min(size[1], area.height) };
}

export function filterOf(p) {
  const b = Number(p?.brightness) || 0;
  const c = Number(p?.contrast) || 0;
  if (!b && !c) return 'none';
  return `brightness(${Math.round((1 + b / 100) * 100) / 100}) contrast(${Math.round((1 + c / 100) * 100) / 100})`;
}
