// Clock — solar geometry for the world map: sun declination / subsolar point (NOAA approximation,
// accurate to a fraction of a degree), sun altitude anywhere, and the day/night terminator as SVG paths
// in an equirectangular map (x = lon + 180, y = 90 - lat, viewBox 0 0 360 180).
const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

/** { decl, subLat, subLon, eqTime } in degrees / minutes for a moment (epoch ms). */
export function solarPosition(at = Date.now()) {
  const d = new Date(at);
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  const doy = Math.floor((at - start) / 86400000) + 1;
  const hours = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
  const leap = new Date(Date.UTC(d.getUTCFullYear(), 1, 29)).getUTCMonth() === 1;
  const g = ((2 * Math.PI) / (leap ? 366 : 365)) * (doy - 1 + (hours - 12) / 24);
  const eqTime = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl =
    (0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g)) * DEG;
  let subLon = -15 * (hours - 12 + eqTime / 60);
  subLon = ((((subLon + 180) % 360) + 360) % 360) - 180;
  return { decl, subLat: decl, subLon, eqTime };
}

/** Sun altitude in degrees at (lat, lon). */
export function sunAltitude(lat, lon, at = Date.now(), pos = solarPosition(at)) {
  const s = Math.sin(lat * RAD) * Math.sin(pos.decl * RAD) + Math.cos(lat * RAD) * Math.cos(pos.decl * RAD) * Math.cos((lon - pos.subLon) * RAD);
  return Math.asin(Math.max(-1, Math.min(1, s))) * DEG;
}

/** 'day' | 'twilight' | 'night' (sun below -0.833° = after sunset, below -6° = civil dusk over). */
export function daylight(lat, lon, at = Date.now()) {
  const a = sunAltitude(lat, lon, at);
  if (a > -0.833) return 'day';
  if (a > -6) return 'twilight';
  return 'night';
}

// Point at angular distance `dist` (deg) and bearing `brg` (deg) from (lat, lon).
function destination(lat, lon, dist, brg) {
  const p1 = lat * RAD;
  const d = dist * RAD;
  const b = brg * RAD;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = lon * RAD + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [p2 * DEG, l2 * DEG];
}

/**
 * Region where the sun is below `alt` degrees (0 = night, -6/-12/-18 = twilight limits), as an SVG
 * path string for the equirectangular map. The region is a spherical cap around the antisolar point
 * with radius 90° + alt; its outline is projected and repeated at ±360° so it wraps seamlessly.
 */
export function nightPath(at = Date.now(), alt = 0, steps = 180) {
  const pos = solarPosition(at);
  let cLat = -pos.decl;
  if (Math.abs(cLat) < 1e-3) cLat = cLat < 0 ? -1e-3 : 1e-3; // equinox: avoid a boundary through both poles
  const cLon = pos.subLon + 180;
  const radius = 90 + alt;
  const pts = [];
  let prev = null;
  let shift = 0;
  for (let i = 0; i <= steps; i++) {
    const [lat, lon0] = destination(cLat, cLon, radius, (360 * i) / steps);
    let lon = lon0 + shift;
    if (prev != null) {
      while (lon - prev > 180) {
        lon -= 360;
        shift -= 360;
      }
      while (prev - lon > 180) {
        lon += 360;
        shift += 360;
      }
    }
    prev = lon;
    pts.push([lat, lon]);
  }
  const north = 90 - cLat < radius; // the cap contains the north pole
  const south = 90 + cLat < radius;
  const ring = pts.slice();
  if (north || south) {
    const poleLat = north ? 90 : -90;
    const first = ring[0];
    const last = ring[ring.length - 1];
    ring.push([poleLat, last[1]], [poleLat, first[1]]);
  }
  const r = (v) => Math.round(v * 100) / 100;
  let d = '';
  for (const off of [-360, 0, 360]) {
    d += `M${ring.map(([lat, lon]) => `${r(lon + off + 180)} ${r(90 - lat)}`).join('L')}Z`;
  }
  return d;
}

/** Map coordinates of a lat/lon. */
export function project(lat, lon) {
  return { x: lon + 180, y: 90 - lat };
}
