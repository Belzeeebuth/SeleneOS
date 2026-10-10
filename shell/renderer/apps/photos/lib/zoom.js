// Zoom & pan math for the viewer (pure functions, unit tested).
// State: { s: scale (1 = 100 %), tx, ty: position of the image's top-left corner inside the stage }.
export const MAX_ZOOM = 20; // 2000 %
export const STEPS = [0.05, 0.1, 0.125, 0.17, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8, 12, 16, 20];

/** Scale that fits the image in the stage; small images are not enlarged (shown at 100 %). */
export function fitScale(nw, nh, vw, vh, { upscale = false, pad = 0 } = {}) {
  if (!(nw > 0 && nh > 0 && vw > 0 && vh > 0)) return 1;
  const s = Math.min((vw - pad * 2) / nw, (vh - pad * 2) / nh);
  return Math.max(0.0001, upscale ? s : Math.min(1, s));
}

export function minZoom(fit) {
  return Math.min(fit, 0.05);
}

/** Keep the image centered when smaller than the stage, else keep its edges outside the stage. */
export function clampPan({ s, tx, ty }, nw, nh, vw, vh) {
  const w = nw * s;
  const h = nh * s;
  const cx = w <= vw ? (vw - w) / 2 : Math.min(0, Math.max(vw - w, tx));
  const cy = h <= vh ? (vh - h) / 2 : Math.min(0, Math.max(vh - h, ty));
  return { s, tx: cx, ty: cy };
}

/** Zoom to `ns` keeping the stage point (cx, cy) over the same image pixel. */
export function zoomAt(state, ns, cx, cy) {
  const k = ns / state.s;
  return { s: ns, tx: cx - (cx - state.tx) * k, ty: cy - (cy - state.ty) * k };
}

/** Centered state at scale s. */
export function centered(s, nw, nh, vw, vh) {
  return { s, tx: (vw - nw * s) / 2, ty: (vh - nh * s) / 2 };
}

/** Image pixel under a stage point. */
export function toImage(state, x, y) {
  return { x: (x - state.tx) / state.s, y: (y - state.ty) / state.s };
}

/** Next zoom step in a direction (+1 in, -1 out), with the fit scale as an extra stop. */
export function stepZoom(s, dir, fit) {
  const stops = [...new Set([...STEPS, fit])].sort((a, b) => a - b);
  if (dir > 0) return stops.find((x) => x > s * 1.001) ?? MAX_ZOOM;
  for (let i = stops.length - 1; i >= 0; i--) if (stops[i] < s * 0.999) return stops[i];
  return stops[0];
}

/** Slider <-> scale (logarithmic between min and max). */
export function sliderToScale(v, min, max = MAX_ZOOM) {
  return min * Math.pow(max / min, Math.min(1, Math.max(0, v / 100)));
}
export function scaleToSlider(s, min, max = MAX_ZOOM) {
  if (max <= min) return 0;
  return (Math.log(s / min) / Math.log(max / min)) * 100;
}
