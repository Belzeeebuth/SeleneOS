// Maps « Itinéraire » (directions) tests.
//   Pure: polyline6 decoding (known vector), distances / durations (fr / en), turn-by-turn sentences built from OSRM
//   maneuvers, roundabout folding, plain-text itinerary, OpenStreetMap link; backend helpers (request URL, point
//   validation, OSRM answer parsing and errors, Retry-After).
//   Shell (real Electron, dev mode, mock tiles): a local fake OSRM server (AURORA_MAPS_OSRM_URL, fixtures in
//   test/fixtures/maps/: car with an alternative and a roundabout / rotary, bike, foot, NoRoute) — never the real
//   routing.openstreetmap.de, tile or Nominatim servers. Checks the request URLs / parameters / User-Agent, one
//   request per action and per second, the cache, drawing (lines, alternatives, markers, fit), choosing an
//   alternative on the map and in the panel, steps in English and French, zoom to a step, travel modes, stops
//   (add, reorder, remove, map menu, drag a marker to recompute), swap, picking on the map, copy, print dialog,
//   OpenStreetMap link, errors (no route, 503 + retry, 429 + Retry-After, offline, unreachable).
// Screenshots: test/out/maps-route-{light-en,dark-en,light-fr,dark-fr}.png
// Usage:  cd aurora-os/shell && xvfb-run -a -s "-screen 0 1600x900x24" node test/maps-routes.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { launchShell, ROOT, OUT } from './lib.mjs';

const require = createRequire(import.meta.url);
const FIX = path.join(ROOT, 'test', 'fixtures', 'maps');
const WIN = '.win.app-maps';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const R = await import(pathToFileURL(path.join(ROOT, 'renderer/apps/maps/lib/route.js')).href);
const backend = require('../main/ipc/maps.js');

let passed = 0;
const failures = [];
function check(name, actual, expected) {
  const ok = typeof expected === 'function' ? !!expected(actual) : Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else failures.push(`${name}\n      expected: ${typeof expected === 'function' ? '(predicate)' : JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
  return ok;
}
async function section(name, fn) {
  const t0 = Date.now();
  const before = failures.length;
  try {
    await fn();
    console.log(`  ${failures.length === before ? '✓' : '✗'} ${name} (${Date.now() - t0} ms)`);
  } catch (err) {
    failures.push(`${name}: threw ${err?.stack || err}`);
    console.log(`  ✗ ${name}: ${err?.message || err}`);
  }
}

// ---------------------------------------------------------------- pure helpers
await section('polyline6 decoding', async () => {
  // Google's documented example (precision 5): (38.5, -120.2), (40.7, -120.95), (43.252, -126.453)
  const g = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';
  check('known polyline, precision 5', R.decodePolyline(g, 5), [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]]);
  check('same string read as polyline6 is 10x smaller', R.decodePolyline(g, 6), [[3.85, -12.02], [4.07, -12.095], [4.3252, -12.6453]]);
  check('default precision is 6', R.decodePolyline(g), R.decodePolyline(g, 6));
  const pts = [[48.853495, 2.348392], [48.85826, 2.2945], [-33.869844, 151.208285], [0, -179.999999]];
  const enc = R.encodePolyline(pts);
  check('round trip polyline6', R.decodePolyline(enc).map(([a, b]) => [Math.round(a * 1e6) / 1e6, Math.round(b * 1e6) / 1e6]), pts);
  check('backend mock route geometry decodes (same algorithm)', R.decodePolyline(backend.mockRoute([{ lat: 48.85, lon: 2.35 }, { lat: 48.86, lon: 2.29 }], 'car', false).routes[0].geometry).length, 17);
  check('empty / non-string', [R.decodePolyline(''), R.decodePolyline(null)], [[], []]);
  check('truncated string stops cleanly', R.decodePolyline(enc.slice(0, enc.length - 3)).length, 3);
  check('bad character stops cleanly', R.decodePolyline('_p~iF ~ps|U', 5), []);
  check('bboxOf', R.bboxOf([[1, 2], [3, -4], [2, 5]]), [1, 3, -4, 5]);
  check('parseCoords FR decimal comma', R.parseCoords('48,8566 2,3522'), { lat: 48.8566, lon: 2.3522 });
  check('parseCoords hemisphere letters (O = ouest)', R.parseCoords('33.86° S, 151.2° E'), { lat: -33.86, lon: 151.2 });
  check('parseCoords rejects out of range', R.parseCoords('95, 10'), null);
});

await section('distances, durations, ordinals', async () => {
  const nb = (s) => s.replace(/\u00a0|\u202f/g, ' ');
  check('m (rounded to 5 m)', nb(R.formatDistance(41, 'fr')), '40 m');
  check('m (rounded to 10 m)', nb(R.formatDistance(347, 'en')), '350 m');
  check('km fr', nb(R.formatDistance(1234, 'fr')), '1,2 km');
  check('km en', nb(R.formatDistance(1234, 'en')), '1.2 km');
  check('km > 10 rounded', nb(R.formatDistance(46543, 'fr')), '47 km');
  check('995 m -> 1 km', nb(R.formatDistance(996, 'fr')), '1 km');
  check('thousands fr', nb(R.formatDistance(1234567, 'fr')), '1 235 km');
  check('duration min', nb(R.formatDuration(1490, 'fr')), '25 min');
  check('duration h fr', nb(R.formatDuration(3900, 'fr')), '1 h 05');
  check('duration h en', nb(R.formatDuration(3900, 'en')), '1 h 5 min');
  check('duration days', [nb(R.formatDuration(2 * 86400 + 3 * 3600, 'fr')), nb(R.formatDuration(2 * 86400 + 3 * 3600, 'en'))], ['2 j 3 h', '2 d 3 h']);
  check('ordinals', [R.ordinal(1, 'fr'), R.ordinal(2, 'fr'), R.ordinal(1, 'en'), R.ordinal(2, 'en'), R.ordinal(3, 'en'), R.ordinal(11, 'en'), R.ordinal(22, 'en')], ['1re', '2e', '1st', '2nd', '3rd', '11th', '22nd']);
  const now = new Date(2026, 9, 14, 13, 0);
  check('arrival fr', R.formatArrival(new Date(2026, 9, 14, 14, 35), 'fr', now), '14:35');
  check('arrival en', nb(R.formatArrival(new Date(2026, 9, 14, 14, 35), 'en', now)), '2:35 PM');
  check('arrival another day has the weekday', R.formatArrival(new Date(2026, 9, 15, 8, 10), 'fr', now), (v) => /^\S+ 0?8:10$/.test(v));
  check('arrival rounded to the minute', R.arrivalDate(new Date(2026, 9, 14, 13, 0, 0), 584.4).getMinutes(), 10);
});

await section('turn-by-turn sentences (OSRM maneuvers)', async () => {
  const S = (type, modifier = '', extra = {}) => ({ type, modifier, name: '', ref: '', exit: 0, distance: 1200, leg: 0, legCount: 1, bearingAfter: 0, ...extra });
  const both = (s) => [R.stepText(s, 'en'), R.stepText(s, 'fr')].map((v) => v.replace(/\u00a0/g, ' '));
  check('turn left onto', both(S('turn', 'left', { name: 'Rue X' })), ['Turn left onto Rue X', 'Tournez à gauche sur Rue X']);
  check('turn sharp right, no name', both(S('turn', 'sharp right')), ['Turn sharp right', 'Tournez franchement à droite']);
  check('roundabout 2nd exit', both(S('roundabout', '', { exit: 2, name: 'Cours la Reine' })), ['At the roundabout, take the 2nd exit onto Cours la Reine', 'Au rond-point, prenez la 2e sortie sur Cours la Reine']);
  check('roundabout 1st exit (fr: 1re)', R.stepText(S('roundabout', '', { exit: 1 }), 'fr'), 'Au rond-point, prenez la 1re sortie');
  check('named rotary', both(S('rotary', '', { exit: 5, rotary: 'Place Charles de Gaulle', name: 'Avenue d’Iéna' })), ['At Place Charles de Gaulle, take the 5th exit onto Avenue d’Iéna', 'Au rond-point Place Charles de Gaulle, prenez la 5e sortie sur Avenue d’Iéna']);
  check('rotary named « Rond-point … » (fr)', R.stepText(S('rotary', '', { exit: 3, rotary: 'Rond-point des Champs-Élysées' }), 'fr'), 'Au Rond-point des Champs-Élysées, prenez la 3e sortie');
  check('continue for 1,2 km', both(S('new name', 'straight', { name: 'Quai X' })), ['Continue onto Quai X for 1.2 km', 'Continuez sur Quai X pendant 1,2 km']);
  check('continue straight, no name', both(S('continue', 'straight', { name: '' })), ['Continue straight for 1.2 km', 'Continuez tout droit pendant 1,2 km']);
  check('u-turn', both(S('continue', 'uturn', { name: 'Rue Y' })), ['Make a U-turn onto Rue Y', 'Faites demi-tour sur Rue Y']);
  check('end of road', both(S('end of road', 'left', { name: 'Quai Branly' })), ['At the end of the road, turn left onto Quai Branly', 'Au bout de la route, tournez à gauche sur Quai Branly']);
  check('fork', both(S('fork', 'slight left', { name: 'A 6' })), ['Keep left at the fork onto A 6', 'À l’embranchement, restez à gauche sur A 6']);
  check('off ramp with exit number and destinations', both(S('off ramp', 'slight right', { exits: '14', destinations: 'A 6: Lyon, Évry, Melun, Sens' })), ['Take exit 14 on the right towards Lyon, Évry, Melun', 'Prenez la sortie 14 à droite en direction de Lyon, Évry, Melun']);
  check('« en direction d’ » before a vowel', R.stepText(S('on ramp', 'right', { destinations: 'Orly' }), 'fr'), 'Prenez la bretelle à droite en direction d’Orly');
  check('merge', both(S('merge', 'slight left', { name: 'Boulevard Périphérique' })), ['Merge left onto Boulevard Périphérique', 'Insérez-vous à gauche sur Boulevard Périphérique']);
  check('depart with compass', both(S('depart', '', { name: 'Rue d’Arcole', bearingAfter: 10 })), ['Head north on Rue d’Arcole', 'Dirigez-vous vers le nord sur Rue d’Arcole']);
  check('name + ref', R.stepText(S('turn', 'right', { name: 'Rue de Rivoli', ref: 'D 906' }), 'fr'), 'Tournez à droite sur Rue de Rivoli (D 906)');
  check('arrive at a stop (leg 0 of 2)', both(S('arrive', 'right', { leg: 0, legCount: 2 })), ['Arrive at stop 1, on the right', 'Vous arrivez à l’étape 1, sur votre droite']);
  check('arrive: stop number from the panel', R.stepText(S('arrive', '', { leg: 0, legCount: 3, stopNo: 2 }), 'fr'), 'Vous arrivez à l’étape 2');
  check('arrive at the destination', both(S('arrive', '', { leg: 1, legCount: 2 })), ['Arrive at your destination', 'Vous arrivez à destination']);
  check('step icons', [R.stepIcon(S('turn', 'left')), R.stepIcon(S('turn', 'slight right')), R.stepIcon(S('roundabout')), R.stepIcon(S('arrive'))], ['arrow-bend-up-left', 'arrow-up-right', 'arrow-counter-clockwise', 'flag-checkered']);

  const car = JSON.parse(fs.readFileSync(path.join(FIX, 'osrm-car.json'), 'utf8'));
  const steps = R.prepareSteps(car.routes[0]);
  check('exit roundabout folded into the roundabout step', [car.routes[0].legs[0].steps.length, steps.length], [12, 11]);
  const rb = steps.find((s) => s.type === 'roundabout');
  check('folded distance', Math.round(rb.distance), Math.round(car.routes[0].legs[0].steps[6].distance + car.routes[0].legs[0].steps[7].distance));
  const txt = R.itineraryText({ route: car.routes[0], steps, names: ['Paris', 'Tour Eiffel'], mode: 'car', lang: 'fr', now: new Date(2026, 9, 14, 13, 0), url: R.osmDirectionsUrl([{ lat: 48.853495, lon: 2.348392 }, { lat: 48.85826, lon: 2.2945 }], 'car') });
  const lines = txt.split('\n');
  check('itinerary title (fr)', lines[0], 'Itinéraire en voiture\u00a0: Paris → Tour Eiffel');
  check('itinerary summary (fr)', lines[1].replace(/\u00a0|\u202f/g, ' '), '5 km · 10 min · arrivée vers 13:10');
  check('itinerary via', lines[2], 'Par Quai du Louvre, Cours Albert-Ier');
  check('itinerary roundabout line', lines.find((l) => l.startsWith('7. ')).replace(/\u00a0/g, ' '), '7. Au rond-point, prenez la 2e sortie sur Cours la Reine (320 m)');
  check('itinerary credit + link', lines.slice(-2), ['Itinéraire : OSRM (serveurs FOSSGIS) · Données © les contributeurs d’OpenStreetMap', 'https://www.openstreetmap.org/directions?engine=fossgis_osrm_car&route=48.8535%2C2.34839%3B48.85826%2C2.2945']);
  check('OSM link per mode', R.osmDirectionsUrl([{ lat: 1, lon: 2 }, { lat: 3, lon: 4 }], 'foot'), 'https://www.openstreetmap.org/directions?engine=fossgis_osrm_foot&route=1%2C2%3B3%2C4');
});

await section('backend helpers: URL, validation, parsing, Retry-After', async () => {
  const pts = [{ lat: 48.853495, lon: 2.348392 }, { lat: 48.85826, lon: 2.2945 }];
  check('car URL', backend.routeUrl('https://routing.openstreetmap.de', 'car', pts, true), 'https://routing.openstreetmap.de/routed-car/route/v1/driving/2.348392,48.853495;2.294500,48.858260?overview=full&geometries=polyline6&steps=true&alternatives=true');
  check('bike URL', backend.routeUrl('X', 'bike', pts, true), (u) => u.startsWith('X/routed-bike/route/v1/cycling/'));
  check('foot URL without alternatives', backend.routeUrl('X', 'foot', pts, false), (u) => u.startsWith('X/routed-foot/route/v1/foot/') && u.endsWith('alternatives=false'));
  check('default server is FOSSGIS', backend.OSRM_URL, 'https://routing.openstreetmap.de');
  check('points: one is not enough', backend.normRoutePoints([pts[0]]), null);
  check('points: 11 are too many', backend.normRoutePoints(Array(11).fill(pts[0])), null);
  check('points: lat out of range', backend.normRoutePoints([pts[0], { lat: 91, lon: 0 }]), null);
  check('points: strings are numbers', backend.normRoutePoints([{ lat: '1.5', lon: '2' }, pts[1]])[0], { lat: 1.5, lon: 2 });
  check('points: not an array', backend.normRoutePoints('1,2;3,4'), null);
  const car = JSON.parse(fs.readFileSync(path.join(FIX, 'osrm-car.json'), 'utf8'));
  const p = backend.parseRoute(car);
  check('parse: 2 routes, steps kept', [p.routes.length, p.routes[0].legs[0].steps.length, p.waypoints.length], [2, 12, 2]);
  check('parse: rotary name + exit', p.routes[1].legs[0].steps.find((s) => s.maneuver.type === 'rotary'), (s) => s.rotary_name === 'Place Charles de Gaulle' && s.maneuver.exit === 5);
  const code = (fn) => {
    try {
      fn();
      return 'ok';
    } catch (e) {
      return e.code;
    }
  };
  check('parse: NoRoute -> ENOROUTE', code(() => backend.parseRoute(JSON.parse(fs.readFileSync(path.join(FIX, 'osrm-noroute.json'), 'utf8')))), 'ENOROUTE');
  check('parse: NoSegment -> ENOSEGMENT', code(() => backend.parseRoute({ code: 'NoSegment' })), 'ENOSEGMENT');
  check('parse: TooBig -> ETOOBIG', code(() => backend.parseRoute({ code: 'TooBig' })), 'ETOOBIG');
  check('parse: garbage -> EBADDATA', code(() => backend.parseRoute('x')), 'EBADDATA');
  check('parse: Ok without usable route -> ENOROUTE', code(() => backend.parseRoute({ code: 'Ok', routes: [{ geometry: 'a b', legs: [{}] }] })), 'ENOROUTE');
  const evil = JSON.parse(JSON.stringify(car));
  evil.routes[0].legs[0].steps[1].name = 'Rue\u0000<b>X</b>';
  evil.routes[0].legs[0].steps[1].maneuver.type = 'teleport';
  evil.routes[0].legs[0].steps[1].maneuver.modifier = 'sideways';
  evil.routes.push(car.routes[0], car.routes[0], car.routes[0]);
  const pe = backend.parseRoute(evil);
  check('parse: control chars cleaned, unknown maneuver -> turn, at most 3 routes', [pe.routes[0].legs[0].steps[1].name, pe.routes[0].legs[0].steps[1].maneuver.type, pe.routes[0].legs[0].steps[1].maneuver.modifier, pe.routes.length], ['Rue <b>X</b>', 'turn', '', 3]);
  check('Retry-After seconds', backend.retryAfterMs('5'), 5000);
  check('Retry-After clamped', [backend.retryAfterMs('0'), backend.retryAfterMs('99999')], [1000, 600000]);
  check('Retry-After missing -> 30 s', backend.retryAfterMs(null), 30000);
});

// ---------------------------------------------------------------- fake OSRM server
const FIXTURES = { car: 'osrm-car.json', bike: 'osrm-bike.json', foot: 'osrm-foot.json' };
const PROFILES = { car: 'driving', bike: 'cycling', foot: 'foot' };
const fake = { log: [], queue: [] };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const m = /^\/routed-(car|bike|foot)\/route\/v1\/(driving|cycling|foot)\/([^/]+)$/.exec(u.pathname);
  fake.log.push({ path: u.pathname, query: u.search, url: req.url, ua: req.headers['user-agent'], accept: req.headers.accept, at: Date.now() });
  const send = (status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  if (!m || PROFILES[m[1]] !== m[2]) return send(400, { code: 'InvalidUrl', message: 'bad path' });
  const coords = decodeURIComponent(m[3]).split(';').map((c) => c.split(',').map(Number));
  const next = fake.queue.shift();
  if (next) {
    if (next.file) return send(next.status || 200, fs.readFileSync(path.join(FIX, next.file), 'utf8'), next.headers);
    return send(next.status, next.body || 'Service unavailable', next.headers);
  }
  if (coords.length === 2) return send(200, fs.readFileSync(path.join(FIX, FIXTURES[m[1]]), 'utf8'));
  // stops: an L-shaped route through the requested points (OSRM format, one leg per pair)
  return send(200, backend.mockRoute(coords.map(([lon, lat]) => ({ lat, lon })), m[1], false));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const OSRM = `http://127.0.0.1:${server.address().port}`;

// ---------------------------------------------------------------- shell helpers
function M(s, fn, arg) {
  return s.page.evaluate(`(async () => { const el = [...document.querySelectorAll(${JSON.stringify(WIN)} + ' *')].find((x) => x.__maps); return (${fn.toString()})(el && el.__maps, ${JSON.stringify(arg ?? null)}); })()`);
}
async function until(s, fn, { timeout = 10000, label = 'condition', arg } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = await M(s, fn, arg).catch((e) => `ERR ${e.message}`);
    if (last && !(typeof last === 'string' && last.startsWith('ERR'))) return last;
    await sleep(80);
  }
  throw new Error(`timed out waiting for ${label} (last: ${JSON.stringify(last)})`);
}
const invoke = (s, channel, ...args) =>
  s.page.evaluate(`(async () => { const r = await window.aurora.invokeRaw(${JSON.stringify(channel)}, ...${JSON.stringify(args)}); return r.ok ? { ok: true, value: r.value } : { ok: false, code: r.error?.code, message: r.error?.message }; })()`);
const text = (s, sel) => s.page.evaluate(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? null`);
const texts = (s, sel) => s.page.evaluate(`[...document.querySelectorAll(${JSON.stringify(sel)})].map((e) => e.textContent)`);
const nb = (v) => (typeof v === 'string' ? v.replace(/\u00a0|\u202f/g, ' ') : v);
const routeState = (s) => M(s, (m) => ({ state: m.route.state, error: m.route.error, requests: m.route.requests, routes: m.route.routes.length, sel: m.route.selected }));
async function waitRoute(s, label, state = 'ok') {
  return until(s, (m, st) => m.route.state === st && m.route, { label: `${label} (${state})`, arg: state, timeout: 12000 });
}
async function mapBox(s) {
  return s.page.locator(`${WIN} .mp-map`).boundingBox();
}
async function shot(s, name) {
  await sleep(450);
  const rect = await s.page.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(WIN)}).getBoundingClientRect(); return { x: Math.max(0, r.x - 1), y: Math.max(0, r.y - 1), width: r.width + 2, height: r.height + 2 }; })()`);
  fs.mkdirSync(OUT, { recursive: true });
  await s.page.screenshot({ path: path.join(OUT, `maps-route-${name}.png`), clip: rect });
}
const badText = (s) => s.page.evaluate(`(() => { const w = document.querySelector(${JSON.stringify(WIN)}); return /\\b(null|undefined|NaN)\\b|\\{[a-z]+\\}|route\\.[a-z]/.test(w.innerText) ? w.innerText.slice(0, 600) : ''; })()`);
const mapsErrors = (s) => s.logs.filter((l) => /^\[(error|pageerror)\]/.test(l) && /maps|directions|route/i.test(l));
const r6 = (v) => (Math.round(v * 1e6) / 1e6).toFixed(6);
const coordsOf = (pts) => pts.map((p) => `${r6(p.lon)},${r6(p.lat)}`).join(';');
const PARIS = { lat: 48.8534951, lon: 2.3483915 };
const EIFFEL = { lat: 48.85826, lon: 2.2945 };
const QUERY = (alt) => `?overview=full&geometries=polyline6&steps=true&alternatives=${alt}`;

function makeHome(placeName) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-home-'));
  const dir = path.join(home, '.local', 'share', 'aurora');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'maps.json'), JSON.stringify({ version: 1, places: [{ id: 'eiffel', name: placeName, display: 'Avenue Gustave Eiffel, Paris, France', lat: EIFFEL.lat, lon: EIFFEL.lon, zoom: 16, added: 1 }] }));
  return home;
}
/** Start = « paris » searched in the field (first result), destination = the saved place. */
async function fillFromTo(s, savedName) {
  await s.page.click(`${WIN} .mp-dir-btn`);
  await until(s, (m) => m.route.open, { label: 'directions open' });
  const from = `${WIN} .mp-wp.from .mp-wp-input`;
  await s.page.waitForFunction((sel) => document.activeElement === document.querySelector(sel), from, { timeout: 5000 });
  await s.page.keyboard.type('paris');
  await s.page.keyboard.press('Enter');
  await s.page.waitForSelector(`${WIN} .mp-wp.from .mp-sugg-item.active`, { timeout: 8000 });
  const sugg = await texts(s, `${WIN} .mp-wp.from .mp-sugg-name`);
  await s.page.keyboard.press('Enter');
  await until(s, (m) => m.route.points[0].place, { label: 'start set' });
  await s.page.waitForFunction(() => document.activeElement?.closest('.mp-wp')?.classList.contains('to'), null, { timeout: 5000 });
  await s.page.waitForSelector(`${WIN} .mp-wp.to .mp-sugg-item`, { timeout: 5000 });
  const toSugg = await texts(s, `${WIN} .mp-wp.to .mp-sugg-name`);
  await s.page.click(`${WIN} .mp-wp.to .mp-sugg-item.place:has-text("${savedName}")`);
  return { sugg, toSugg };
}

// ---------------------------------------------------------------- EN, light
let home = makeHome('Eiffel Tower');
let s = await launchShell({ open: ['maps'], lang: 'en', theme: 'light', home, env: { AURORA_MAPS_OSRM_URL: OSRM } });
try {
  await s.page.waitForSelector(WIN, { timeout: 15000 });
  await until(s, (m) => m && m.places.length === 1, { label: 'saved place loaded' });

  await section('open the directions view, start and destination fields', async () => {
    await s.page.click(`${WIN} .mp-dir-btn`);
    await until(s, (m) => m.route.open, { label: 'open' });
    check('search box hidden while routing', await s.page.evaluate(`getComputedStyle(document.querySelector('.win.app-maps .mp-search')).display`), 'none');
    check('title', await text(s, `${WIN} .mp-route-title`), 'Directions');
    check('placeholders', await s.page.evaluate(`[...document.querySelectorAll('.win.app-maps .mp-wp-input')].map((i) => i.placeholder)`), ['Choose a starting point', 'Choose a destination']);
    check('modes', await texts(s, `${WIN} .mp-mode span:last-child`), ['Car', 'Bike', 'Walk']);
    check('car selected by default', await s.page.getAttribute(`${WIN} .mp-mode[data-mode=car]`, 'aria-checked'), 'true');
    check('hint', await text(s, `${WIN} .mp-route-hint`), (v) => /right-click the map/.test(v || ''));
    check('no request yet', fake.log.length, 0);
    await s.page.click(`${WIN} .mp-route-back`);
    await until(s, (m) => !m.route.open, { label: 'closed' });
    check('back to search', await s.page.evaluate(`getComputedStyle(document.querySelector('.win.app-maps .mp-search')).display`), 'flex');
    check('focus back on the directions button', await s.page.evaluate(`document.activeElement.classList.contains('mp-dir-btn')`), true);
  });

  await section('route request: URL, parameters, User-Agent, one request', async () => {
    const { sugg, toSugg } = await fillFromTo(s, 'Eiffel Tower');
    check('field search lists Nominatim results', sugg, ['Paris', 'Paris', 'Eiffel Tower']);
    check('destination suggestions: pick on map + My places', toSugg, ['Choose on the map', 'Eiffel Tower']);
    await waitRoute(s, 'first route');
    check('one request to the fake OSRM', fake.log.length, 1);
    const req = fake.log[0];
    check('car profile path + lon,lat order', req.path, `/routed-car/route/v1/driving/${coordsOf([PARIS, EIFFEL])}`);
    check('query parameters', req.query, QUERY('true'));
    check('User-Agent', req.ua, 'SeleneOS-Maps/1.0');
    check('Accept JSON', req.accept, 'application/json');
    const st = (await invoke(s, 'maps:stats')).value;
    check('backend stats', [st.routeRequests, st.routeNetwork, st.lastRouteUrl.startsWith(OSRM)], [1, 1, true]);
    check('two routes (best + alternative)', (await routeState(s)).routes, 2);
    check('field texts', await s.page.evaluate(`[...document.querySelectorAll('.win.app-maps .mp-wp-input')].map((i) => i.value)`), ['Paris', 'Eiffel Tower']);
  });

  await section('drawing: lines, alternative, markers, fit', async () => {
    await M(s, (m) => (m.renderNow(), true));
    const g = await s.page.evaluate(() => {
      const w = document.querySelector('.win.app-maps');
      const d = (sel) => [...w.querySelectorAll(sel)].map((p) => p.getAttribute('d') || '');
      const line = w.querySelector('.mp-rt-line');
      return { sel: d('.mp-rt-sel .mp-rt-line'), casing: d('.mp-rt-sel .mp-rt-casing'), alt: d('.mp-rt-alts .mp-rt-alt-line'), stroke: line && getComputedStyle(line).stroke, width: line && getComputedStyle(line).strokeWidth, markers: [...w.querySelectorAll('.mp-rmarker')].map((e) => e.className) };
    });
    check('chosen route drawn (casing + line)', [g.sel.length, g.casing.length, g.sel[0]?.split('L').length > 20], [1, 1, true]);
    check('alternative drawn underneath', [g.alt.length, g.alt[0]?.startsWith('M')], [1, true]);
    const accent = await s.page.evaluate(() => { const p = document.createElement('div'); p.style.color = 'var(--accent)'; document.querySelector('.win.app-maps').append(p); const c = getComputedStyle(p).color; p.remove(); return c; });
    check('line uses the accent token', g.stroke, accent);
    check('line width', g.width, '6px');
    check('start + destination markers', g.markers, ['mp-rmarker from', 'mp-rmarker to']);
    const box = await mapBox(s);
    const pos = await M(s, (m) => m.route.points.map((p) => m.route.markerPos(p.id)));
    check('markers inside the map after fit', pos.every((p) => p && p.x > 20 && p.y > 20 && p.x < box.width - 20 && p.y < box.height - 20), true);
    const exp = await M(s, (m) => [m.geoToScreen(48.853495, 2.348392), m.geoToScreen(48.85826, 2.2945)]);
    check('marker at its coordinates', Math.hypot(pos[0].x - exp[0].x, pos[0].y - exp[0].y) < 2 && Math.hypot(pos[1].x - exp[1].x, pos[1].y - exp[1].y) < 2, true);
    check('fit zoom', (await M(s, (m) => m.view)).zoom, (z) => z >= 12 && z <= 16);
  });

  await section('summary + steps in English', async () => {
    const opts = await s.page.evaluate(() => [...document.querySelectorAll('.win.app-maps .mp-ropt')].map((o) => ({ dur: o.querySelector('.mp-ropt-dur').textContent, dist: o.querySelector('.mp-ropt-dist').textContent, sub: [...o.querySelectorAll('.mp-ropt-sub')].map((x) => x.textContent), pressed: o.getAttribute('aria-pressed') })));
    check('two route choices', opts.length, 2);
    check('best route summary', [nb(opts[0].dur), nb(opts[0].dist), opts[0].pressed], ['10 min', '5 km', 'true']);
    check('alternative summary', [nb(opts[1].dur), nb(opts[1].dist), opts[1].pressed], ['15 min', '7 km', 'false']);
    check('arrival time', opts[0].sub[0], (v) => /^Arrival around \d{1,2}:\d\d\s?[AP]M$/.test(nb(v)));
    check('via', opts[0].sub[1], 'Via Quai du Louvre, Cours Albert-Ier');
    const steps = (await texts(s, `${WIN} .mp-step-text`)).map(nb);
    check('steps (exit roundabout folded)', steps, [
      'Head northeast on Rue d’Arcole',
      'Turn left onto Quai de Gesvres',
      'Continue onto Quai de la Mégisserie for 410 m',
      'Continue onto Quai du Louvre for 640 m',
      'Continue onto Quai François Mitterrand for 550 m',
      'Continue onto Quai des Tuileries for 340 m',
      'At the roundabout, take the 2nd exit onto Cours la Reine',
      'Turn slightly right onto Cours Albert-Ier',
      'Turn left onto Pont de l’Alma',
      'Turn right onto Quai Branly',
      'Arrive at your destination, on the left',
    ]);
    check('step distances (only where the text has none)', (await texts(s, `${WIN} .mp-step-dist`)).map(nb), ['300 m', '430 m', '320 m', '1.1 km', '310 m', '570 m']);
    check('credit', await text(s, `${WIN} .mp-route-credit`), 'Route: OSRM (FOSSGIS servers) · Map data © OpenStreetMap contributors');
    check('no null/undefined/missing strings', await badText(s), '');
  });

  await section('choose the alternative on the map and in the panel', async () => {
    const box = await mapBox(s);
    const p = await M(s, (m) => m.route.routePoint(1));
    check('alternative has a clickable point', !!p, true);
    const n0 = fake.log.length;
    await s.page.mouse.click(box.x + p.x, box.y + p.y);
    await until(s, (m) => m.route.selected === 1, { label: 'alternative chosen' });
    check('no new request when choosing', fake.log.length, n0);
    check('panel follows', await s.page.evaluate(`[...document.querySelectorAll('.win.app-maps .mp-ropt')].map((o) => o.getAttribute('aria-pressed'))`), ['false', 'true']);
    const steps = (await texts(s, `${WIN} .mp-step-text`)).map(nb);
    check('alternative steps: named rotary, fork, end of road', [steps[4], steps[6], steps[8], steps.at(-1)], ['At Place Charles de Gaulle, take the 5th exit onto Avenue d’Iéna', 'Keep right at the fork onto Avenue des Nations Unies', 'At the end of the road, turn left onto Quai Branly', 'Arrive at your destination, on the right']);
    await M(s, (m) => (m.renderNow(), true));
    check('former best route now drawn as the alternative', await s.page.evaluate(`document.querySelectorAll('.win.app-maps .mp-rt-alts .mp-rt-alt-line').length`), 1);
    await s.page.click(`${WIN} .mp-ropt[data-index="0"]`);
    await until(s, (m) => m.route.selected === 0, { label: 'best chosen again' });
    check('choice by keyboard-focusable buttons', await s.page.evaluate(`document.activeElement.classList.contains('mp-ropt')`), true);
    // clicking on the map elsewhere (not on a line) keeps the choice
    await s.page.mouse.click(box.x + 30, box.y + box.height - 60);
    await sleep(150);
    check('click away keeps the route', (await routeState(s)).sel, 0);
  });

  await section('click a step: zoom to it', async () => {
    await s.page.click(`${WIN} .mp-step[data-index="6"]`);
    await sleep(150);
    const v = await M(s, (m) => m.view);
    check('centred on the roundabout', Math.abs(v.lat - 48.8653) < 1e-4 && Math.abs(v.lon - 2.3211) < 1e-4, true);
    check('zoomed in', v.zoom, (z) => z >= 16 && z <= 17);
    check('active step', [await M(s, (m) => m.route.activeStep), await s.page.getAttribute(`${WIN} .mp-step[data-index="6"]`, 'aria-current')], [6, 'step']);
    await M(s, (m) => (m.renderNow(), true));
    check('step highlighted on the map', await s.page.evaluate(`!!document.querySelector('.win.app-maps .mp-rt-step')`), true);
  });

  await section('travel modes: bike, walk, back to car (cache)', async () => {
    await s.page.click(`${WIN} .mp-mode[data-mode=bike]`);
    await waitRoute(s, 'bike');
    check('bike request', fake.log.at(-1).path, `/routed-bike/route/v1/cycling/${coordsOf([PARIS, EIFFEL])}`);
    check('bike: one route', (await routeState(s)).routes, 1);
    check('bike duration', nb(await text(s, `${WIN} .mp-ropt-dur`)), '20 min');
    await s.page.focus(`${WIN} .mp-mode[data-mode=bike]`);
    await s.page.keyboard.press('ArrowRight');
    await waitRoute(s, 'foot');
    check('arrow key selects walk', await s.page.getAttribute(`${WIN} .mp-mode[data-mode=foot]`, 'aria-checked'), 'true');
    check('foot request', fake.log.at(-1).path, `/routed-foot/route/v1/foot/${coordsOf([PARIS, EIFFEL])}`);
    const steps = (await texts(s, `${WIN} .mp-step-text`)).map(nb);
    check('foot steps: unnamed path, fork', [steps[4], steps[5]], ['Turn slightly right', 'Keep left at the fork onto Passerelle Léopold-Sédar-Senghor']);
    const times = (await invoke(s, 'maps:stats')).value.routeTimes;
    check('at most one request per second', times.slice(1).every((t, i) => t - times[i] >= 990), true);
    const n0 = fake.log.length;
    const st0 = (await invoke(s, 'maps:stats')).value;
    await s.page.click(`${WIN} .mp-mode[data-mode=car]`);
    await waitRoute(s, 'car again');
    const st1 = (await invoke(s, 'maps:stats')).value;
    check('car again from the cache: no network', [fake.log.length - n0, st1.routeCacheHits - st0.routeCacheHits], [0, 1]);
    await sleep(200);
    check('mode remembered (app storage)', (await invoke(s, 'storage:get', 'maps', 'routeMode', null)).value, 'car');
  });

  await section('copy, OpenStreetMap link, print dialog', async () => {
    await s.page.click(`${WIN} .mp-copy`);
    await until(s, () => /copied/.test(document.querySelector('.win.app-maps .mp-route-live').textContent), { label: 'copied' });
    const clip = (await invoke(s, 'clipboard:readText')).value;
    const lines = clip.split('\n');
    check('clipboard title', lines[0], 'Directions by car: Paris → Eiffel Tower');
    check('clipboard steps', lines.filter((l) => /^\d+\. /.test(l)).length, 11);
    check('clipboard roundabout line', nb(lines.find((l) => l.startsWith('7. '))), '7. At the roundabout, take the 2nd exit onto Cours la Reine (320 m)');
    check('clipboard ends with the OSM link', lines.at(-1), 'https://www.openstreetmap.org/directions?engine=fossgis_osrm_car&route=48.8535%2C2.34839%3B48.85826%2C2.2945');
    await s.page.evaluate(() => {
      window.__opened = [];
      window.__aurora.shell.openUrl = (u) => (window.__opened.push(u), null);
    });
    await s.page.click(`${WIN} .mp-osm-link`);
    check('OSM link opened', await s.page.evaluate(() => window.__opened), ['https://www.openstreetmap.org/directions?engine=fossgis_osrm_car&route=48.8535%2C2.34839%3B48.85826%2C2.2945']);
    await s.page.click(`${WIN} .mp-print`);
    await s.page.waitForSelector('.pd-dialog', { timeout: 10000 });
    await s.page.waitForSelector('.pd-dialog .pd-thumb canvas', { timeout: 25000 }).catch(() => {});
    check('print dialog title', await text(s, '.pd-dialog .dialog-title'), 'Print');
    check('print preview rendered', await s.page.evaluate(() => !!document.querySelector('.pd-dialog .pd-thumb canvas')), true);
    await s.page.keyboard.press('Escape');
    await s.page.waitForSelector('.pd-dialog', { state: 'detached', timeout: 5000 });
    check('dialog closed', await s.page.evaluate(() => !!document.querySelector('.pd-dialog')), false);
  });

  await section('stops: add, reorder, remove', async () => {
    await s.page.click(`${WIN} .mp-add-stop`);
    await until(s, (m) => m.route.points.length === 3, { label: 'stop row' });
    check('stop row focused', await s.page.evaluate(`document.activeElement.closest('.mp-wp')?.className`), 'mp-wp stop');
    check('stop placeholder + badge', [await s.page.getAttribute(`${WIN} .mp-wp.stop .mp-wp-input`, 'aria-label'), await text(s, `${WIN} .mp-wp.stop .mp-wp-badge`)], ['Stop 1', '1']);
    const n0 = fake.log.length;
    await s.page.keyboard.type('48.8738, 2.2950');
    await s.page.keyboard.press('Enter');
    await until(s, (m) => m.route.requests > 0 && m.route.points[1].place, { label: 'stop set' });
    await waitRoute(s, 'with stop');
    const STOP = { lat: 48.8738, lon: 2.295 };
    check('one request with 3 points, no alternatives', [fake.log.length - n0, fake.log.at(-1).path, fake.log.at(-1).query], [1, `/routed-car/route/v1/driving/${coordsOf([PARIS, STOP, EIFFEL])}`, QUERY('false')]);
    check('stop field shows the coordinates', await s.page.inputValue(`${WIN} .mp-wp.stop .mp-wp-input`), '48.87380° N, 2.29500° E');
    const steps = (await texts(s, `${WIN} .mp-step-text`)).map(nb);
    check('arrive at stop 1, then destination', [steps.filter((x) => x === 'Arrive at stop 1').length, steps.at(-1)], [1, 'Arrive at your destination']);
    await M(s, (m) => (m.renderNow(), true));
    check('3 markers (start, stop 1, destination)', await s.page.evaluate(`[...document.querySelectorAll('.win.app-maps .mp-rmarker')].map((e) => e.className.replace('mp-rmarker ', '') + ':' + e.textContent)`), ['from:', 'stop:1', 'to:']);
    // reorder with the row menu (Move up): the stop becomes the start
    await s.page.click(`${WIN} .mp-wp.stop .mp-wp-menu`);
    await s.page.click('.menu .menu-item:has-text("Move up")');
    await waitRoute(s, 'moved up');
    check('moved up: new order in the request', fake.log.at(-1).path, `/routed-car/route/v1/driving/${coordsOf([STOP, PARIS, EIFFEL])}`);
    check('fields reordered', await s.page.evaluate(`[...document.querySelectorAll('.win.app-maps .mp-wp-input')].map((i) => i.value)`), ['48.87380° N, 2.29500° E', 'Paris', 'Eiffel Tower']);
    // and back with Alt+ArrowDown in its field
    const hits0 = (await invoke(s, 'maps:stats')).value.routeCacheHits;
    const n2 = fake.log.length;
    await s.page.focus(`${WIN} .mp-wp.from .mp-wp-input`);
    await s.page.keyboard.press('Alt+ArrowDown');
    await until(s, (m) => m.route.points[1].text.startsWith('48.87'), { label: 'moved down' });
    await waitRoute(s, 'moved down');
    check('Alt+ArrowDown moves it back', await s.page.evaluate(`[...document.querySelectorAll('.win.app-maps .mp-wp-input')].map((i) => i.value)`), ['Paris', '48.87380° N, 2.29500° E', 'Eiffel Tower']);
    check('same 3 points as before: answered from the cache', [fake.log.length - n2, (await invoke(s, 'maps:stats')).value.routeCacheHits - hits0], [0, 1]);
    check('focus follows the moved field', await s.page.evaluate(`document.activeElement.closest('.mp-wp')?.className`), 'mp-wp stop');
    // remove: same 2 points as before -> served from the cache
    const st0 = (await invoke(s, 'maps:stats')).value;
    const n1 = fake.log.length;
    await s.page.click(`${WIN} .mp-wp.stop .mp-wp-menu`);
    await s.page.click('.menu .menu-item:has-text("Remove")');
    await until(s, (m) => m.route.points.length === 2 && m.route.state === 'ok', { label: 'removed' });
    const st1 = (await invoke(s, 'maps:stats')).value;
    check('removed: back to 2 points from the cache', [fake.log.length - n1, st1.routeCacheHits - st0.routeCacheHits], [0, 1]);
  });

  await section('map menu: add a stop here; drag a marker to recompute', async () => {
    const box = await mapBox(s);
    await M(s, (m) => (m.setView(48.8635, 2.3215, 14), m.renderNow(), true));
    const here = await M(s, (m) => m.screenToGeo(m.size.W / 2 + 40, m.size.H / 2 - 30));
    await s.page.mouse.click(box.x + box.width / 2 + 40, box.y + box.height / 2 - 30, { button: 'right' });
    await s.page.waitForSelector('.menu .menu-item', { timeout: 5000 });
    check('map menu items', await texts(s, '.menu .menu-item .label'), ['Directions from here', 'Directions to here', 'Add a stop here']);
    await s.page.click('.menu .menu-item:has-text("Add a stop here")');
    await until(s, (m) => m.route.points.length === 3 && m.route.points[1].place, { label: 'stop from the menu' });
    await waitRoute(s, 'menu stop');
    const pts = await M(s, (m) => m.route.points.map((p) => p.place));
    check('stop inserted between start and destination at the clicked point', Math.abs(pts[1].lat - here.lat) < 1e-6 && Math.abs(pts[1].lon - here.lon) < 1e-6, true);
    check('request with the menu stop', fake.log.at(-1).path, `/routed-car/route/v1/driving/${coordsOf([PARIS, pts[1], EIFFEL])}`);
    // drag the stop marker 80 px right
    const v0 = await M(s, (m) => m.view);
    await M(s, (m) => (m.renderNow(), true));
    const stopId = await M(s, (m) => m.route.points[1].id);
    const mp = await M(s, (m, id) => m.route.markerPos(id), stopId);
    const n0 = fake.log.length;
    await s.page.mouse.move(box.x + mp.x, box.y + mp.y);
    await s.page.mouse.down();
    await s.page.mouse.move(box.x + mp.x + 40, box.y + mp.y + 10, { steps: 4 });
    await s.page.mouse.move(box.x + mp.x + 80, box.y + mp.y + 20, { steps: 4 });
    check('no request while dragging', fake.log.length, n0);
    await s.page.mouse.up();
    await until(s, (m, lat) => m.route.points[1].place.lat !== lat, { arg: pts[1].lat, label: 'dragged' });
    await waitRoute(s, 'after drag');
    const v1 = await M(s, (m) => m.view);
    check('dragging a marker does not pan the map', [v1.lat, v1.lon, v1.zoom], [v0.lat, v0.lon, v0.zoom]);
    const exp = await M(s, (m, p) => m.screenToGeo(p.x + 80, p.y + 20), mp);
    const moved = await M(s, (m) => m.route.points[1].place);
    check('dropped at the pointer', Math.abs(moved.lat - exp.lat) < 1e-5 && Math.abs(moved.lon - exp.lon) < 1e-5, true);
    check('exactly one request for the drag', fake.log.length - n0, 1);
    check('request with the dragged stop', fake.log.at(-1).path, `/routed-car/route/v1/driving/${coordsOf([PARIS, moved, EIFFEL])}`);
    await M(s, (m) => (m.route.removePoint(1), true));
    await until(s, (m) => m.route.points.length === 2 && m.route.state === 'ok', { label: 'stop removed' });
  });

  await section('swap, choose on the map', async () => {
    const n0 = fake.log.length;
    await s.page.click(`${WIN} .mp-swap`);
    await waitRoute(s, 'swapped');
    check('swap reverses the request', [fake.log.length - n0, fake.log.at(-1).path], [1, `/routed-car/route/v1/driving/${coordsOf([EIFFEL, PARIS])}`]);
    check('fields swapped', await s.page.evaluate(`[...document.querySelectorAll('.win.app-maps .mp-wp-input')].map((i) => i.value)`), ['Eiffel Tower', 'Paris']);
    await s.page.click(`${WIN} .mp-swap`);
    await waitRoute(s, 'swapped back');
    // « Choose on the map » for the destination
    await s.page.click(`${WIN} .mp-wp.to .mp-wp-menu`);
    await s.page.click('.menu .menu-item:has-text("Choose on the map")');
    await until(s, (m) => m.route.picking, { label: 'picking' });
    check('crosshair while picking', await s.page.evaluate(`getComputedStyle(document.querySelector('.win.app-maps .mp-map')).cursor`), 'crosshair');
    check('pick hint', await text(s, `${WIN} .mp-route-live`), 'Click the map to place the point “Destination”. Press Escape to cancel.');
    await s.page.keyboard.press('Escape');
    check('Escape cancels picking', await M(s, (m) => m.route.picking), null);
    await s.page.click(`${WIN} .mp-wp.to .mp-wp-menu`);
    await s.page.click('.menu .menu-item:has-text("Choose on the map")');
    await until(s, (m) => m.route.picking, { label: 'picking again' });
    const box = await mapBox(s);
    const target = await M(s, (m) => m.screenToGeo(m.size.W / 2 - 50, m.size.H / 2 + 20));
    await s.page.mouse.click(box.x + box.width / 2 - 50, box.y + box.height / 2 + 20);
    await waitRoute(s, 'picked');
    const to = await M(s, (m) => m.route.points[1].place);
    check('destination picked on the map', Math.abs(to.lat - target.lat) < 1e-6 && Math.abs(to.lon - target.lon) < 1e-6, true);
    check('picking ended', await M(s, (m) => m.route.picking), null);
    await M(s, (m) => (m.route.setPoint(1, { name: 'Eiffel Tower', lat: 48.85826, lon: 2.2945 }), true));
    await waitRoute(s, 'eiffel again');
  });

  await section('errors: no route, 503 + retry, 429 + Retry-After, offline, unreachable', async () => {
    const setTo = (lat, lon) => M(s, (m, p) => (m.route.setPoint(1, { lat: p[0], lon: p[1] }), true), [lat, lon]);
    // NoRoute (HTTP 400 + OSRM code)
    fake.queue.push({ status: 400, file: 'osrm-noroute.json' });
    await setTo(48.9, 2.4);
    await waitRoute(s, 'no route', 'error');
    check('ENOROUTE', (await routeState(s)).error.code, 'ENOROUTE');
    check('no route message', await text(s, `${WIN} .mp-route-error p`), 'No route found between these places with this travel mode.');
    check('no retry for a missing route', await s.page.evaluate(`!!document.querySelector('.win.app-maps .mp-route-error .mp-retry')`), false);
    await M(s, (m) => (m.renderNow(), true));
    check('nothing drawn after an error', await s.page.evaluate(`document.querySelectorAll('.win.app-maps .mp-rt-line, .win.app-maps .mp-rt-alt-line').length`), 0);
    // 503 -> retry
    fake.queue.push({ status: 503 });
    await setTo(48.91, 2.41);
    await waitRoute(s, '503', 'error');
    check('5xx -> EUNREACHABLE', (await routeState(s)).error.code, 'EUNREACHABLE');
    check('unreachable message', await text(s, `${WIN} .mp-route-error p`), 'The route service cannot be reached. Check your connection and try again.');
    let n0 = fake.log.length;
    await s.page.click(`${WIN} .mp-retry`);
    await waitRoute(s, 'retried');
    check('retry: one new request, route shown', [fake.log.length - n0, (await routeState(s)).routes], [1, 2]);
    // 429 with Retry-After: 2 -> blocked locally until then
    fake.queue.push({ status: 429, body: '{"message":"Too Many Requests"}', headers: { 'Retry-After': '2' } });
    await setTo(48.92, 2.42);
    await waitRoute(s, '429', 'error');
    check('429 -> ERATELIMIT', (await routeState(s)).error.code, 'ERATELIMIT');
    check('rate limit message', await text(s, `${WIN} .mp-route-error p`), 'The route service is receiving too many requests. Wait a moment, then try again.');
    n0 = fake.log.length;
    const t429 = Date.now();
    await s.page.click(`${WIN} .mp-retry`);
    await until(s, (m) => m.route.state === 'error', { label: 'still blocked' });
    await sleep(100);
    if (Date.now() - t429 < 1800) check('retry while blocked: still rate limited, server not asked', [(await routeState(s)).error.code, fake.log.length - n0], ['ERATELIMIT', 0]);
    await sleep(Math.max(0, 2150 - (Date.now() - t429)));
    await s.page.click(`${WIN} .mp-retry`);
    await waitRoute(s, 'after Retry-After');
    check('after Retry-After: one request, OK', fake.log.length - n0, 1);
    // offline
    await s.app.evaluate(() => (process.env.AURORA_MAPS_OFFLINE = '1'));
    n0 = fake.log.length;
    await setTo(48.93, 2.43);
    await waitRoute(s, 'offline', 'error');
    check('EOFFLINE', [(await routeState(s)).error.code, fake.log.length - n0], ['EOFFLINE', 0]);
    check('offline message', await text(s, `${WIN} .mp-route-error p`), 'You are offline. Connect to the Internet to get directions.');
    await s.app.evaluate(() => delete process.env.AURORA_MAPS_OFFLINE);
    await s.page.click(`${WIN} .mp-retry`);
    await waitRoute(s, 'back online');
    // server down (nothing listening)
    const dead = http.createServer();
    await new Promise((r) => dead.listen(0, '127.0.0.1', r));
    const deadUrl = `http://127.0.0.1:${dead.address().port}`;
    await new Promise((r) => dead.close(r));
    await s.app.evaluate((_e, u) => (process.env.AURORA_MAPS_OSRM_URL = u), deadUrl);
    await setTo(48.94, 2.44);
    await waitRoute(s, 'unreachable', 'error');
    check('connection refused -> EUNREACHABLE', (await routeState(s)).error.code, 'EUNREACHABLE');
    await s.app.evaluate((_e, u) => (process.env.AURORA_MAPS_OSRM_URL = u), OSRM);
    await s.page.click(`${WIN} .mp-retry`);
    await waitRoute(s, 'server back');
    const v = (await invoke(s, 'maps:route', [{ lat: 1, lon: 1 }], { mode: 'car' })).code;
    check('backend validation: one point', v, 'EINVAL');
    check('backend validation: bad mode', (await invoke(s, 'maps:route', [{ lat: 1, lon: 1 }, { lat: 2, lon: 2 }], { mode: 'plane' })).code, 'EINVAL');
    check('backend validation: 11 points', (await invoke(s, 'maps:route', Array.from({ length: 11 }, (_, i) => ({ lat: i, lon: i })), {})).code, 'EINVAL');
    await setTo(EIFFEL.lat, EIFFEL.lon);
    await waitRoute(s, 'eiffel');
  });

  await section('screenshots light EN + dark EN, console', async () => {
    await M(s, (m) => (m.route.setPoint(1, { name: 'Eiffel Tower', lat: 48.85826, lon: 2.2945 }), true));
    await waitRoute(s, 'final');
    await until(s, (m) => m.tileStats.inFlight === 0 && m.tileStats.queued === 0, { label: 'tiles' });
    check('no null/undefined/missing strings', await badText(s), '');
    await shot(s, 'light-en');
    await s.aurora(() => window.__aurora.settings.set('theme', 'dark'));
    await sleep(400);
    await M(s, (m) => (m.renderNow(), true));
    const casing = await s.page.evaluate(() => getComputedStyle(document.querySelector('.win.app-maps .mp-rt-casing')).stroke);
    const onAccent = await s.page.evaluate(() => { const p = document.createElement('div'); p.style.color = 'var(--on-accent)'; document.querySelector('.win.app-maps').append(p); const c = getComputedStyle(p).color; p.remove(); return c; });
    check('dark: casing follows --on-accent', casing, onAccent);
    await shot(s, 'dark-en');
    await s.aurora(() => window.__aurora.settings.set('theme', 'light'));
    await s.page.evaluate(() => {
      document.querySelector('.win.app-maps .mp-route').scrollTop = 0;
      document.querySelector('.win.app-maps .mp-wp.to .mp-wp-input').focus();
    });
    await s.page.keyboard.press('Control+a');
    await s.page.keyboard.type('Eif');
    await s.page.waitForSelector(`${WIN} .mp-wp.to .mp-sugg-item`, { timeout: 5000 });
    check('typing filters My places, offers the search', await texts(s, `${WIN} .mp-wp.to .mp-sugg-name`), ['Search for “Eif”', 'Eiffel Tower']);
    await s.page.keyboard.press('ArrowDown');
    await s.page.keyboard.press('ArrowDown');
    check('arrow keys move in the suggestions', await s.page.getAttribute(`${WIN} .mp-wp.to .mp-wp-input`, 'aria-activedescendant'), (v) => /-1$/.test(v || ''));
    check('window content never scrolled by focus / lists', await s.page.evaluate(() => [document.querySelector('.win.app-maps'), ...document.querySelector('.win.app-maps').querySelectorAll('*')].filter((e) => e.scrollTop && !e.matches('.mp-route, .mp-list, .mp-sugg')).map((e) => `${e.className}:${e.scrollTop}`)), []);
    await shot(s, 'suggestions-en');
    await s.page.keyboard.press('Escape');
    check('Escape closes the list and restores the field', [await s.page.evaluate(`document.querySelector('.win.app-maps .mp-wp.to .mp-sugg').hidden`), await s.page.inputValue(`${WIN} .mp-wp.to .mp-wp-input`)], [true, 'Eiffel Tower']);
    check('no Maps console errors', mapsErrors(s), []);
  });
} finally {
  await s.close();
  fs.rmSync(home, { recursive: true, force: true });
}

// ---------------------------------------------------------------- FR, dark (then light)
fake.log.length = 0;
home = makeHome('Tour Eiffel');
s = await launchShell({ open: ['maps'], lang: 'fr', theme: 'dark', home, env: { AURORA_MAPS_OSRM_URL: OSRM } });
try {
  await s.page.waitForSelector(WIN, { timeout: 15000 });
  await until(s, (m) => m && m.places.length === 1, { label: 'saved place loaded' });

  await section('French: fields, steps, roundabout, stops, errors', async () => {
    check('FR directions button', await s.page.getAttribute(`${WIN} .mp-dir-btn`, 'aria-label'), 'Itinéraire');
    const { toSugg } = await fillFromTo(s, 'Tour Eiffel');
    check('FR suggestions', toSugg, ['Choisir sur la carte', 'Tour Eiffel']);
    await waitRoute(s, 'FR route');
    check('FR title + modes', [await text(s, `${WIN} .mp-route-title`), await texts(s, `${WIN} .mp-mode span:last-child`)], ['Itinéraire', ['Voiture', 'Vélo', 'À pied']]);
    const opts = await s.page.evaluate(() => [...document.querySelectorAll('.win.app-maps .mp-ropt')].map((o) => [o.querySelector('.mp-ropt-dur').textContent, o.querySelector('.mp-ropt-dist').textContent, ...[...o.querySelectorAll('.mp-ropt-sub')].map((x) => x.textContent)]));
    check('FR summary', opts[0].map(nb), (v) => v[0] === '10 min' && v[1] === '5 km' && /^Arrivée vers \d\d:\d\d$/.test(v[2]) && v[3] === 'Par Quai du Louvre, Cours Albert-Ier');
    const steps = (await texts(s, `${WIN} .mp-step-text`)).map(nb);
    check('FR steps', steps, [
      'Dirigez-vous vers le nord-est sur Rue d’Arcole',
      'Tournez à gauche sur Quai de Gesvres',
      'Continuez sur Quai de la Mégisserie pendant 410 m',
      'Continuez sur Quai du Louvre pendant 640 m',
      'Continuez sur Quai François Mitterrand pendant 550 m',
      'Continuez sur Quai des Tuileries pendant 340 m',
      'Au rond-point, prenez la 2e sortie sur Cours la Reine',
      'Tournez légèrement à droite sur Cours Albert-Ier',
      'Tournez à gauche sur Pont de l’Alma',
      'Tournez à droite sur Quai Branly',
      'Vous arrivez à destination, sur votre gauche',
    ]);
    check('FR distances (decimal comma)', (await texts(s, `${WIN} .mp-step-dist`)).map(nb), ['300 m', '430 m', '320 m', '1,1 km', '310 m', '570 m']);
    check('FR headings + actions', [await text(s, `${WIN} .mp-steps-title`), await text(s, `${WIN} .mp-copy`), await text(s, `${WIN} .mp-print`), await text(s, `${WIN} .mp-osm-link`)], ['Instructions détaillées', 'Copier', 'Imprimer', 'Ouvrir dans OpenStreetMap']);
    await s.page.click(`${WIN} .mp-ropt[data-index="1"]`);
    await until(s, (m) => m.route.selected === 1, { label: 'FR alternative' });
    const alt = (await texts(s, `${WIN} .mp-step-text`)).map(nb);
    check('FR named rotary + fork + end of road', [alt[4], alt[6], alt[8]], ['Au rond-point Place Charles de Gaulle, prenez la 5e sortie sur Avenue d’Iéna', 'À l’embranchement, restez à droite sur Avenue des Nations Unies', 'Au bout de la route, tournez à gauche sur Quai Branly']);
    await s.page.click(`${WIN} .mp-ropt[data-index="0"]`);
    await s.page.click(`${WIN} .mp-add-stop`);
    await s.page.keyboard.type('48,8738 2,2950');
    await s.page.keyboard.press('Enter');
    await until(s, (m) => m.route.points.length === 3 && m.route.points[1].place && m.route.state === 'ok', { label: 'FR stop' });
    const ss = (await texts(s, `${WIN} .mp-step-text`)).map(nb);
    check('FR arrive at stop', ss.includes('Vous arrivez à l’étape 1'), true);
    check('FR stop label + coordinates (O = ouest only west)', [await s.page.getAttribute(`${WIN} .mp-wp.stop .mp-wp-input`, 'aria-label'), await s.page.inputValue(`${WIN} .mp-wp.stop .mp-wp-input`)], ['Étape 1', '48.87380° N, 2.29500° E']);
    await s.page.click(`${WIN} .mp-wp.stop .mp-wp-menu`);
    check('FR row menu', await texts(s, '.menu .menu-item .label'), ['Choisir sur la carte', 'Monter', 'Descendre', 'Supprimer']);
    await s.page.keyboard.press('Escape');
    await M(s, (m) => (m.route.removePoint(1), true));
    await waitRoute(s, 'FR stop removed');
    fake.queue.push({ status: 503 });
    await M(s, (m) => (m.route.setPoint(1, { lat: 48.95, lon: 2.45 }), true));
    await waitRoute(s, 'FR error', 'error');
    check('FR error + retry', [await text(s, `${WIN} .mp-route-error p`), nb(await text(s, `${WIN} .mp-retry`))], ['Le service d’itinéraires est injoignable. Vérifiez votre connexion et réessayez.', 'Réessayer']);
    await M(s, (m) => (m.route.setPoint(1, { name: 'Tour Eiffel', lat: 48.85826, lon: 2.2945 }), true));
    await waitRoute(s, 'FR back');
    await s.page.click(`${WIN} .mp-copy`);
    await until(s, () => /copié/.test(document.querySelector('.win.app-maps .mp-route-live').textContent), { label: 'FR copied' });
    const clip = (await invoke(s, 'clipboard:readText')).value.split('\n');
    check('FR clipboard', [clip[0], nb(clip[1]).replace(/\d\d:\d\d/, 'HH:MM')], ['Itinéraire en voiture\u00a0: Paris → Tour Eiffel', '5 km · 10 min · arrivée vers HH:MM']);
    const box = await mapBox(s);
    await s.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
    await s.page.waitForSelector('.menu .menu-item', { timeout: 5000 });
    check('FR map menu', await texts(s, '.menu .menu-item .label'), ['Itinéraire depuis ici', 'Itinéraire vers ici', 'Ajouter une étape ici']);
    await s.page.keyboard.press('Escape');
    check('no null/undefined/missing strings (FR)', await badText(s), '');
  });

  await section('screenshots dark FR + light FR, narrow window, console', async () => {
    await M(s, (m) => (m.route.selectRoute(0), m.fitBounds([48.853, 48.8742, 2.2885, 2.3505]), true));
    await until(s, (m) => m.tileStats.inFlight === 0 && m.tileStats.queued === 0, { label: 'tiles' });
    await shot(s, 'dark-fr');
    await s.aurora(() => window.__aurora.settings.set('theme', 'light'));
    await sleep(400);
    await shot(s, 'light-fr');
    // narrow window: the panel overlays the map, nothing overflows horizontally
    await s.page.evaluate(() => window.__aurora.wm.byApp('maps')[0].setSize(520, 640));
    await sleep(500);
    const ov = await s.page.evaluate(() => { const p = document.querySelector('.win.app-maps .mp-route'); return p.scrollWidth - p.clientWidth; });
    check('no horizontal overflow in the panel', ov <= 1, true);
    await shot(s, 'narrow-fr');
    check('no Maps console errors (FR)', mapsErrors(s), []);
  });
} finally {
  await s.close();
  fs.rmSync(home, { recursive: true, force: true });
  server.close();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL ${f}`);
process.exit(failures.length ? 1 : 0);
