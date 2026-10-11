// Web Mercator math for the Maps viewer (pure, unit-tested from test/maps.test.mjs).
export const TILE = 256;
export const MIN_ZOOM = 2;
export const MAX_ZOOM = 19;
export const MAX_LAT = 85.05112878;

export const clampZoom = (z) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Number.isFinite(z) ? z : MIN_ZOOM));
export const clampLat = (lat) => Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
export const wrapLon = (lon) => {
  const w = ((((lon + 180) % 360) + 360) % 360) - 180;
  return w === -180 && lon > 0 ? 180 : w;
};

/** lat/lon -> world pixel at (fractional) zoom z. */
export function project(lat, lon, z) {
  const size = TILE * 2 ** z;
  const s = Math.sin((clampLat(lat) * Math.PI) / 180);
  return {
    x: ((lon + 180) / 360) * size,
    y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * size,
  };
}

/** world pixel at zoom z -> lat/lon. */
export function unproject(x, y, z) {
  const size = TILE * 2 ** z;
  const lon = (x / size) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / size;
  const lat = (180 / Math.PI) * Math.atan(Math.sinh(n));
  return { lat: clampLat(lat), lon };
}

/** Ground resolution (metres per screen pixel) at a latitude and zoom. */
export const metersPerPixel = (lat, z) => (156543.03392 * Math.cos((clampLat(lat) * Math.PI) / 180)) / 2 ** z;

/** Scale bar: the largest 1/2/5 x 10^n distance that fits in maxPx. -> { meters, px, value, unit: 'm'|'km' } */
export function scaleBar(lat, z, maxPx = 100) {
  const mpp = metersPerPixel(lat, z);
  const maxM = mpp * maxPx;
  const p = 10 ** Math.floor(Math.log10(maxM));
  const d = maxM / p;
  const nice = (d >= 5 ? 5 : d >= 2 ? 2 : 1) * p;
  const px = nice / mpp;
  return nice >= 1000 ? { meters: nice, px, value: nice / 1000, unit: 'km' } : { meters: nice, px, value: nice, unit: 'm' };
}

/** Tiles covering a w x h viewport centred on (lat, lon) at fractional zoom. -> { tz, scale, tiles: [{ z, x, y, wx, left, top, size }] } */
export function visibleTiles(lat, lon, zoom, w, h) {
  const tz = Math.max(0, Math.min(MAX_ZOOM, Math.round(zoom)));
  const scale = 2 ** (zoom - tz);
  const c = project(lat, lon, tz);
  const left = c.x - w / 2 / scale;
  const top = c.y - h / 2 / scale;
  const n = 2 ** tz;
  const tiles = [];
  const x0 = Math.floor(left / TILE);
  const x1 = Math.floor((left + w / scale) / TILE);
  const y0 = Math.max(0, Math.floor(top / TILE));
  const y1 = Math.min(n - 1, Math.floor((top + h / scale) / TILE));
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      const wx = ((tx % n) + n) % n;
      tiles.push({ z: tz, x: wx, y: ty, rawX: tx, left: (tx * TILE - left) * scale, top: (ty * TILE - top) * scale, size: TILE * scale });
    }
  }
  // load from the centre outwards
  const cx = w / 2;
  const cy = h / 2;
  tiles.sort((a, b) => Math.hypot(a.left + a.size / 2 - cx, a.top + a.size / 2 - cy) - Math.hypot(b.left + b.size / 2 - cx, b.top + b.size / 2 - cy));
  return { tz, scale, tiles };
}

/** Zoom that fits a bounding box [south, north, west, east] in a w x h viewport (integer, clamped). */
export function fitZoom(bbox, w, h, pad = 40) {
  if (!Array.isArray(bbox) || bbox.length !== 4) return null;
  const [s, n, west, e] = bbox.map(Number);
  if (![s, n, west, e].every(Number.isFinite)) return null;
  const a = project(n, west, 0);
  const b = project(s, e, 0);
  const dx = Math.max(1e-9, Math.abs(b.x - a.x));
  const dy = Math.max(1e-9, Math.abs(b.y - a.y));
  const z = Math.min(Math.log2(Math.max(1, w - pad * 2) / dx), Math.log2(Math.max(1, h - pad * 2) / dy));
  return clampZoom(Math.floor(z));
}

/** Formats coordinates as "48.85350° N, 2.34839° E". */
export function formatCoords(lat, lon, digits = 5, dirs = { n: 'N', s: 'S', e: 'E', w: 'W' }) {
  const f = (v) => Math.abs(v).toFixed(digits);
  return `${f(lat)}° ${lat >= 0 ? dirs.n : dirs.s}, ${f(lon)}° ${lon >= 0 ? dirs.e : dirs.w}`;
}
