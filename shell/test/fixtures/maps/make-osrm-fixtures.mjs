// Generates the OSRM answers the Maps route tests serve from their fake server (test/maps-routes.test.mjs):
//   osrm-car.json  two routes Paris centre -> Eiffel Tower (along the quays with a roundabout at Place de la Concorde;
//                  alternative through the Étoile rotary « Place Charles de Gaulle »)
//   osrm-bike.json one route (cycling), osrm-foot.json one route (walking: unnamed path, fork, arrival on the left)
//   osrm-noroute.json the error body OSRM answers (HTTP 400) when no route exists
// Hand-drawn approximate geometry (not real OSRM output), in the exact OSRM v5 answer format
// (overview=full, geometries=polyline6, steps=true). Regenerate:  node test/fixtures/maps/make-osrm-fixtures.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { encodePolyline, haversine } = await import(pathToFileURL(path.join(here, '../../../renderer/apps/maps/lib/route.js')).href);

const START = [48.853495, 2.348392]; // the « Paris » result of the dev gazetteer
const END = [48.85826, 2.2945]; // « Eiffel Tower »

function bearing(a, b) {
  const r = Math.PI / 180;
  const y = Math.sin((b[1] - a[1]) * r) * Math.cos(b[0] * r);
  const x = Math.cos(a[0] * r) * Math.sin(b[0] * r) - Math.sin(a[0] * r) * Math.cos(b[0] * r) * Math.cos((b[1] - a[1]) * r);
  return Math.round((Math.atan2(y, x) / r + 360) % 360);
}
const len = (c) => c.slice(1).reduce((s, p, i) => s + haversine({ lat: c[i][0], lon: c[i][1] }, { lat: p[0], lon: p[1] }), 0);
const r1 = (v) => Math.round(v * 10) / 10;

/** steps: [{ type, modifier, exit, name, ref, rotary_name, destinations, coords: [[lat, lon], …] }] -> OSRM route */
function route(steps, speed, mode, summary) {
  const out = [];
  let prevEnd = null;
  steps.forEach((s, i) => {
    const c = s.type === 'arrive' ? [prevEnd, prevEnd] : s.coords;
    const before = i && out[i - 1] ? (() => { const pc = steps[i - 1].coords; return bearing(pc[pc.length - 2], pc[pc.length - 1]); })() : 0;
    const after = s.type === 'arrive' ? 0 : bearing(c[0], c[1]);
    const distance = s.type === 'arrive' ? 0 : r1(len(c));
    const maneuver = { bearing_after: after, bearing_before: before, location: [c[0][1], c[0][0]], type: s.type };
    if (s.modifier) maneuver.modifier = s.modifier;
    if (s.exit) maneuver.exit = s.exit;
    const step = {
      geometry: encodePolyline(c),
      maneuver,
      mode,
      driving_side: 'right',
      name: s.name || '',
      intersections: [{ out: 0, entry: [true], bearings: [after], location: [c[0][1], c[0][0]] }],
      weight: r1(distance / speed),
      duration: r1(distance / speed),
      distance,
    };
    if (s.ref) step.ref = s.ref;
    if (s.rotary_name) step.rotary_name = s.rotary_name;
    if (s.destinations) step.destinations = s.destinations;
    out.push(step);
    prevEnd = c[c.length - 1];
  });
  const all = [];
  for (const s of steps) if (s.coords) for (const p of s.coords) if (!all.length || all[all.length - 1][0] !== p[0] || all[all.length - 1][1] !== p[1]) all.push(p);
  const distance = r1(out.reduce((a, s) => a + s.distance, 0));
  const duration = r1(out.reduce((a, s) => a + s.duration, 0));
  return { geometry: encodePolyline(all), legs: [{ steps: out, summary, weight: duration, duration, distance }], weight_name: 'routability', weight: duration, duration, distance };
}

const QUAYS = [
  { type: 'depart', name: 'Rue d’Arcole', coords: [START, [48.85455, 2.3492], [48.856, 2.34985]] },
  { type: 'turn', modifier: 'left', name: 'Quai de Gesvres', coords: [[48.856, 2.34985], [48.8564, 2.347], [48.857, 2.3442]] },
  { type: 'new name', modifier: 'straight', name: 'Quai de la Mégisserie', coords: [[48.857, 2.3442], [48.8577, 2.3413], [48.8584, 2.339]] },
  { type: 'new name', modifier: 'straight', name: 'Quai du Louvre', coords: [[48.8584, 2.339], [48.8596, 2.3348], [48.8608, 2.331]] },
  { type: 'continue', modifier: 'straight', name: 'Quai François Mitterrand', coords: [[48.8608, 2.331], [48.8619, 2.3275], [48.863, 2.3242]] },
  { type: 'new name', modifier: 'straight', name: 'Quai des Tuileries', coords: [[48.863, 2.3242], [48.8642, 2.3223], [48.8653, 2.3211]] },
  { type: 'roundabout', modifier: 'straight', exit: 2, name: 'Cours la Reine', coords: [[48.8653, 2.3211], [48.8659, 2.3208], [48.8661, 2.3201], [48.8657, 2.3194]] },
  { type: 'exit roundabout', modifier: 'straight', exit: 2, name: 'Cours la Reine', coords: [[48.8657, 2.3194], [48.865, 2.318]] },
  { type: 'turn', modifier: 'slight right', name: 'Cours Albert-Ier', coords: [[48.865, 2.318], [48.8643, 2.313], [48.8637, 2.308], [48.8632, 2.3035]] },
  { type: 'turn', modifier: 'left', name: 'Pont de l’Alma', coords: [[48.8632, 2.3035], [48.862, 2.3023], [48.8608, 2.3013]] },
  { type: 'turn', modifier: 'right', name: 'Quai Branly', coords: [[48.8608, 2.3013], [48.8601, 2.299], [48.8594, 2.297], [48.8587, 2.2953], END] },
  { type: 'arrive', modifier: 'left', name: 'Quai Branly' },
];
const ETOILE = [
  { type: 'depart', name: 'Rue d’Arcole', coords: [START, [48.85455, 2.3492], [48.856, 2.34985]] },
  { type: 'continue', modifier: 'straight', name: 'Pont d’Arcole', coords: [[48.856, 2.34985], [48.8568, 2.3503], [48.8574, 2.3506]] },
  { type: 'turn', modifier: 'left', name: 'Rue de Rivoli', coords: [[48.8574, 2.3506], [48.8586, 2.3464], [48.86, 2.341], [48.8615, 2.336], [48.8632, 2.33], [48.8648, 2.325], [48.8656, 2.323]] },
  { type: 'turn', modifier: 'slight right', name: 'Avenue des Champs-Élysées', coords: [[48.8656, 2.323], [48.8662, 2.32], [48.868, 2.314], [48.87, 2.308], [48.872, 2.3015], [48.8733, 2.2969]] },
  { type: 'rotary', modifier: 'right', exit: 5, rotary_name: 'Place Charles de Gaulle', name: 'Avenue d’Iéna', coords: [[48.8733, 2.2969], [48.8741, 2.2959], [48.8738, 2.2942], [48.873, 2.2942]] },
  { type: 'exit rotary', modifier: 'right', exit: 5, name: 'Avenue d’Iéna', coords: [[48.873, 2.2942], [48.872, 2.2943]] },
  { type: 'new name', modifier: 'straight', name: 'Avenue d’Iéna', coords: [[48.872, 2.2943], [48.869, 2.2945], [48.8665, 2.294], [48.865, 2.2938]] },
  { type: 'fork', modifier: 'slight right', name: 'Avenue des Nations Unies', coords: [[48.865, 2.2938], [48.863, 2.2918], [48.8615, 2.29]] },
  { type: 'continue', modifier: 'straight', name: 'Pont d’Iéna', coords: [[48.8615, 2.29], [48.86, 2.2918], [48.859, 2.293]] },
  { type: 'end of road', modifier: 'left', name: 'Quai Branly', coords: [[48.859, 2.293], [48.8587, 2.2938], END] },
  { type: 'arrive', modifier: 'right', name: 'Quai Branly' },
];
const FOOT = [
  { type: 'depart', name: 'Rue d’Arcole', coords: [START, [48.85455, 2.3492], [48.856, 2.34985]] },
  { type: 'turn', modifier: 'left', name: 'Quai de Gesvres', coords: [[48.856, 2.34985], [48.8564, 2.347], [48.857, 2.3442]] },
  { type: 'new name', modifier: 'straight', name: 'Quai de la Mégisserie', coords: [[48.857, 2.3442], [48.8577, 2.3413], [48.8584, 2.339]] },
  { type: 'new name', modifier: 'straight', name: 'Quai du Louvre', coords: [[48.8584, 2.339], [48.8596, 2.3348], [48.8608, 2.331]] },
  { type: 'turn', modifier: 'slight right', name: '', coords: [[48.8608, 2.331], [48.8625, 2.328], [48.864, 2.324]] },
  { type: 'fork', modifier: 'slight left', name: 'Passerelle Léopold-Sédar-Senghor', coords: [[48.864, 2.324], [48.863, 2.323], [48.8615, 2.3225]] },
  { type: 'turn', modifier: 'right', name: 'Quai d’Orsay', coords: [[48.8615, 2.3225], [48.862, 2.315], [48.8625, 2.307], [48.862, 2.303]] },
  { type: 'continue', modifier: 'slight left', name: 'Quai Branly', coords: [[48.862, 2.303], [48.8608, 2.3013], [48.8594, 2.297], END] },
  { type: 'arrive', modifier: 'left', name: 'Quai Branly' },
];

const waypoints = (a, b) => [
  { hint: 'fixture-start', distance: 2.1, name: 'Rue d’Arcole', location: [START[1], START[0]] },
  { hint: 'fixture-end', distance: 3.4, name: 'Quai Branly', location: [END[1], END[0]] },
];
const write = (name, json) => fs.writeFileSync(path.join(here, name), `${JSON.stringify(json, null, 1)}\n`);
write('osrm-car.json', { code: 'Ok', routes: [route(QUAYS, 8.5, 'driving', 'Quai du Louvre, Cours Albert-Ier'), route(ETOILE, 8.0, 'driving', 'Rue de Rivoli, Avenue des Champs-Élysées')], waypoints: waypoints() });
write('osrm-bike.json', { code: 'Ok', routes: [route(QUAYS, 4.2, 'cycling', 'Quai du Louvre, Cours Albert-Ier')], waypoints: waypoints() });
write('osrm-foot.json', { code: 'Ok', routes: [route(FOOT, 1.4, 'walking', 'Quai du Louvre, Quai d’Orsay')], waypoints: waypoints() });
write('osrm-noroute.json', { code: 'NoRoute', message: 'Impossible route between points' });
console.log('written', fs.readdirSync(here).filter((f) => f.endsWith('.json')).join(' '));
