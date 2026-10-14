// Routes for the Maps app (pure, no DOM; unit-tested from test/maps-routes.test.mjs): polyline decoding, French /
// English distances, durations and arrival times, turn-by-turn sentences built from OSRM maneuvers (type + modifier),
// the plain-text itinerary (copy) and the OpenStreetMap directions link.
// OSRM maneuvers: http://project-osrm.org/docs/v5.24.0/api/#stepmaneuver-object

export const MODES = ['car', 'bike', 'foot'];
export const MAX_WAYPOINTS = 10; // start + 8 stops + destination (the backend accepts the same)

// ---------------------------------------------------------------- polyline (Google's algorithm, any precision)
/** "polyline6" string -> [[lat, lon], ...]. Stops at the first malformed chunk (never throws). */
export function decodePolyline(str, precision = 6) {
  const out = [];
  if (typeof str !== 'string' || !str) return out;
  const factor = 10 ** precision;
  let i = 0;
  let lat = 0;
  let lon = 0;
  const next = () => {
    let result = 0;
    let shift = 0;
    let b;
    do {
      if (i >= str.length) return null;
      b = str.charCodeAt(i++) - 63;
      if (b < 0 || b > 63) return null;
      result += (b & 0x1f) * 2 ** shift; // no 32-bit overflow on long jumps
      shift += 5;
    } while (b >= 0x20 && shift < 60);
    return result % 2 ? -(result + 1) / 2 : result / 2;
  };
  while (i < str.length) {
    const dLat = next();
    const dLon = dLat == null ? null : next();
    if (dLat == null || dLon == null) break;
    lat += dLat;
    lon += dLon;
    out.push([lat / factor, lon / factor]);
  }
  return out;
}

/** [[lat, lon], ...] -> polyline string (tests and the dev mock route). */
export function encodePolyline(points, precision = 6) {
  const factor = 10 ** precision;
  let pLat = 0;
  let pLon = 0;
  let s = '';
  const enc = (v) => {
    let n = v < 0 ? -v * 2 - 1 : v * 2;
    let r = '';
    while (n >= 0x20) {
      r += String.fromCharCode((0x20 | (n % 32)) + 63);
      n = Math.floor(n / 32);
    }
    return r + String.fromCharCode(n + 63);
  };
  for (const [la, lo] of points || []) {
    const lat = Math.round(la * factor);
    const lon = Math.round(lo * factor);
    s += enc(lat - pLat) + enc(lon - pLon);
    pLat = lat;
    pLon = lon;
  }
  return s;
}

/** Bounding box [south, north, west, east] of [[lat, lon], ...] (null when empty). */
export function bboxOf(points) {
  let s = Infinity;
  let n = -Infinity;
  let w = Infinity;
  let e = -Infinity;
  for (const [la, lo] of points || []) {
    if (!Number.isFinite(la) || !Number.isFinite(lo)) continue;
    s = Math.min(s, la);
    n = Math.max(n, la);
    w = Math.min(w, lo);
    e = Math.max(e, lo);
  }
  return Number.isFinite(s) ? [s, n, w, e] : null;
}

/** Great-circle distance in metres. */
export function haversine(a, b) {
  const R = 6371008.8;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
}

/** "48.8566, 2.3522" / "48,8566 2,3522" / "48.85°N 2.35°E" -> { lat, lon } or null. */
export function parseCoords(text) {
  const s = String(text || '').trim();
  const m = /^(-?\d{1,2}(?:[.,]\d+)?)\s*°?\s*([NS])?\s*[,;\s]\s*(-?\d{1,3}(?:[.,]\d+)?)\s*°?\s*([EWO])?$/i.exec(s);
  if (!m) return null;
  let lat = Number(m[1].replace(',', '.'));
  let lon = Number(m[3].replace(',', '.'));
  if (m[2] && /s/i.test(m[2])) lat = -Math.abs(lat);
  if (m[4] && /[wo]/i.test(m[4])) lon = -Math.abs(lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

// ---------------------------------------------------------------- numbers, distances, durations
const LOCALE = { en: 'en-US', fr: 'fr-FR' };
const L = (lang) => (lang === 'fr' ? 'fr' : 'en');
const NBSP = ' ';
const num = (n, lang, d = 0) => new Intl.NumberFormat(LOCALE[L(lang)], { maximumFractionDigits: d }).format(n);

/** 41 -> "40 m", 1234 -> "1,2 km" (fr) / "1.2 km" (en), 46543 -> "47 km". */
export function formatDistance(m, lang = 'en') {
  m = Math.max(0, Number(m) || 0);
  if (m < 1000) {
    const r = m < 100 ? Math.max(m > 0 ? 5 : 0, Math.round(m / 5) * 5) : Math.round(m / 10) * 10;
    if (r < 1000) return `${num(r, lang)}${NBSP}m`;
    m = r;
  }
  const km = m / 1000;
  return `${num(km < 10 ? Math.round(km * 10) / 10 : Math.round(km), lang, km < 10 ? 1 : 0)}${NBSP}km`;
}

/** Seconds -> "25 min", "1 h 05" (fr) / "1 h 5 min" (en), "2 j 3 h" / "2 d 3 h". */
export function formatDuration(s, lang = 'en') {
  const mins = Math.max(1, Math.round((Number(s) || 0) / 60));
  const fr = L(lang) === 'fr';
  if (mins < 60) return `${mins}${NBSP}min`;
  const hTotal = Math.floor(mins / 60);
  const m = mins % 60;
  if (hTotal >= 24) {
    const d = Math.floor(hTotal / 24);
    const hh = hTotal % 24;
    return `${d}${NBSP}${fr ? 'j' : 'd'}${hh ? ` ${hh}${NBSP}h` : ''}`;
  }
  if (!m) return `${hTotal}${NBSP}h`;
  return fr ? `${hTotal}${NBSP}h${NBSP}${String(m).padStart(2, '0')}` : `${hTotal}${NBSP}h ${m}${NBSP}min`;
}

/** Arrival clock time ("14:35" / "2:35 PM"); another day adds the weekday ("mer. 08:10"). */
export function formatArrival(date, lang = 'en', now = new Date()) {
  const loc = LOCALE[L(lang)];
  const time = new Intl.DateTimeFormat(loc, { hour: 'numeric', minute: '2-digit' }).format(date);
  if (date.toDateString() === now.toDateString()) return time;
  return `${new Intl.DateTimeFormat(loc, { weekday: 'short' }).format(date)} ${time}`;
}

/** 1 -> "1st" / "1re", 2 -> "2nd" / "2e". */
export function ordinal(n, lang = 'en') {
  n = Math.max(1, Math.round(Number(n) || 1));
  if (L(lang) === 'fr') return n === 1 ? '1re' : `${n}e`;
  const t = n % 100;
  const suf = t >= 11 && t <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th';
  return `${n}${suf}`;
}

/** Bearing (degrees) -> 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw'. */
export function compass(bearing) {
  const b = (((Number(bearing) || 0) % 360) + 360) % 360;
  return ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'][Math.round(b / 45) % 8];
}

// ---------------------------------------------------------------- sentences
const STR = {
  en: {
    compass: { n: 'north', ne: 'northeast', e: 'east', se: 'southeast', s: 'south', sw: 'southwest', w: 'west', nw: 'northwest' },
    mod: { left: 'left', right: 'right', 'slight left': 'slightly left', 'slight right': 'slightly right', 'sharp left': 'sharp left', 'sharp right': 'sharp right', straight: 'straight' },
    side: { left: 'on the left', right: 'on the right' },
    onto: ' onto {way}',
    on: ' on {way}',
    towards: ' towards {dest}',
    depart: 'Head {dir}',
    turn: 'Turn {mod}',
    straight: 'Go straight',
    uturn: 'Make a U-turn',
    endOfRoad: 'At the end of the road, {inner}',
    continue: 'Continue',
    continueStraight: 'Continue straight',
    continueMod: 'Continue {mod}',
    merge: 'Merge {mod}',
    mergePlain: 'Merge',
    onRamp: 'Take the ramp {side}',
    onRampPlain: 'Take the ramp',
    offRamp: 'Take the exit {side}',
    offRampPlain: 'Take the exit',
    offRampNumber: 'Take exit {exit} {side}',
    offRampNumberPlain: 'Take exit {exit}',
    fork: 'Keep {mod} at the fork',
    forkStraight: 'Keep straight at the fork',
    roundabout: 'At the roundabout, take the {nth} exit',
    rotaryNamed: 'At {rotary}, take the {nth} exit',
    enterRoundabout: 'Enter the roundabout',
    enterRotaryNamed: 'Enter {rotary}',
    roundaboutTurn: 'At the roundabout, turn {mod}',
    roundaboutStraight: 'At the roundabout, continue straight',
    exitNth: 'Take the {nth} exit',
    exitRoundabout: 'Exit the roundabout',
    arrive: 'Arrive at your destination',
    arriveStop: 'Arrive at stop {n}',
    arriveSide: { left: ', on the left', right: ', on the right' },
    lasting: '{text} for {dist}',
  },
  fr: {
    compass: { n: 'le nord', ne: 'le nord-est', e: 'l’est', se: 'le sud-est', s: 'le sud', sw: 'le sud-ouest', w: 'l’ouest', nw: 'le nord-ouest' },
    mod: { left: 'à gauche', right: 'à droite', 'slight left': 'légèrement à gauche', 'slight right': 'légèrement à droite', 'sharp left': 'franchement à gauche', 'sharp right': 'franchement à droite', straight: 'tout droit' },
    side: { left: 'à gauche', right: 'à droite' },
    onto: ' sur {way}',
    on: ' sur {way}',
    towards: ' en direction de {dest}',
    depart: 'Dirigez-vous vers {dir}',
    turn: 'Tournez {mod}',
    straight: 'Continuez tout droit',
    uturn: 'Faites demi-tour',
    endOfRoad: 'Au bout de la route, {inner}',
    continue: 'Continuez',
    continueStraight: 'Continuez tout droit',
    continueMod: 'Continuez {mod}',
    merge: 'Insérez-vous {mod}',
    mergePlain: 'Insérez-vous dans la circulation',
    onRamp: 'Prenez la bretelle {side}',
    onRampPlain: 'Prenez la bretelle',
    offRamp: 'Prenez la sortie {side}',
    offRampPlain: 'Prenez la sortie',
    offRampNumber: 'Prenez la sortie {exit} {side}',
    offRampNumberPlain: 'Prenez la sortie {exit}',
    fork: 'À l’embranchement, restez {mod}',
    forkStraight: 'À l’embranchement, continuez tout droit',
    roundabout: 'Au rond-point, prenez la {nth} sortie',
    rotaryNamed: 'Au rond-point {rotary}, prenez la {nth} sortie',
    rotaryNamedSelf: 'Au {rotary}, prenez la {nth} sortie',
    enterRoundabout: 'Entrez dans le rond-point',
    enterRotaryNamed: 'Entrez dans le rond-point {rotary}',
    enterRotaryNamedSelf: 'Entrez dans le {rotary}',
    roundaboutTurn: 'Au rond-point, tournez {mod}',
    roundaboutStraight: 'Au rond-point, continuez tout droit',
    exitNth: 'Prenez la {nth} sortie',
    exitRoundabout: 'Sortez du rond-point',
    arrive: 'Vous arrivez à destination',
    arriveStop: 'Vous arrivez à l’étape {n}',
    arriveSide: { left: ', sur votre gauche', right: ', sur votre droite' },
    lasting: '{text} pendant {dist}',
  },
};
const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ''));
const lowerFirst = (s) => (s ? s[0].toLowerCase() + s.slice(1) : s);

/** "Rue de Rivoli (D 906)", the ref alone, or ''. */
export function wayName(step) {
  const name = String(step?.name || '').trim();
  const ref = String(step?.ref || '').trim();
  if (name && ref && !name.includes(ref)) return `${name} (${ref})`;
  return name || ref;
}
/** First three destinations ("A 6: Lyon, Melun, Évry, …" -> "Lyon, Melun, Évry"). */
function destinationsOf(step) {
  let d = String(step?.destinations || '').trim();
  if (!d) return '';
  const colon = d.indexOf(':');
  if (colon > 0 && colon < d.length - 1) d = d.slice(colon + 1);
  return d
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(', ');
}

const ROUND = new Set(['roundabout', 'rotary']);
const EXIT_ROUND = new Set(['exit roundabout', 'exit rotary']);
const CONTINUING = new Set(['new name', 'continue', 'notification', 'use lane']);

/**
 * OSRM route -> flat list of steps for the panel: every leg's steps, with each « exit roundabout / exit rotary » step
 * folded into the roundabout step before it (one instruction, distances added).
 * Step: { type, modifier, exit, name, ref, destinations, exits, rotary, mode, drivingSide, bearingAfter, distance,
 *         duration, location: { lat, lon }, geometries: [polyline6], leg, legCount }
 */
export function prepareSteps(route) {
  const legs = Array.isArray(route?.legs) ? route.legs : [];
  const out = [];
  legs.forEach((leg, li) => {
    let prev = null;
    for (const s of Array.isArray(leg?.steps) ? leg.steps : []) {
      const m = s?.maneuver || {};
      const loc = Array.isArray(m.location) ? m.location : [];
      const step = {
        type: String(m.type || 'turn'),
        modifier: String(m.modifier || ''),
        exit: Number(m.exit) || 0,
        name: s.name || '',
        ref: s.ref || '',
        destinations: s.destinations || '',
        exits: s.exits || '',
        rotary: s.rotary_name || '',
        mode: s.mode || '',
        drivingSide: s.driving_side || 'right',
        bearingAfter: Number(m.bearing_after) || 0,
        distance: Number(s.distance) || 0,
        duration: Number(s.duration) || 0,
        location: { lat: Number(loc[1]) || 0, lon: Number(loc[0]) || 0 },
        geometries: s.geometry ? [s.geometry] : [],
        leg: li,
        legCount: legs.length,
      };
      if (EXIT_ROUND.has(step.type) && prev && ROUND.has(prev.type)) {
        prev.distance += step.distance;
        prev.duration += step.duration;
        prev.geometries.push(...step.geometries);
        if (!prev.exit && step.exit) prev.exit = step.exit;
        if (!wayName(prev) && wayName(step)) Object.assign(prev, { name: step.name, ref: step.ref });
        continue;
      }
      out.push(step);
      prev = step;
    }
  });
  return out;
}

/** The maneuver sentence of a step ("Tournez à gauche sur Rue de Rivoli"). */
export function instruction(step, lang = 'en') {
  const S = STR[L(lang)];
  const fr = L(lang) === 'fr';
  const type = step?.type || 'turn';
  const mod = step?.modifier || '';
  const way = wayName(step);
  const onto = (s) => s + (way ? fill(S.onto, { way }) : '');
  const modText = S.mod[mod] || '';
  const side = /left/.test(mod) ? S.side.left : /right/.test(mod) ? S.side.right : '';
  const dest = destinationsOf(step);
  const towardsText = () => fill(fr && /^[aeiouyhàâäéèêëîïôöûü]/i.test(dest) ? ' en direction d’{dest}' : S.towards, { dest });
  const towards = (s) => (dest ? s + towardsText() : way ? s + fill(S.onto, { way }) : s);
  const turnLike = () => {
    if (mod === 'uturn') return onto(S.uturn);
    if (mod === 'straight' || !mod) return onto(S.straight);
    return onto(fill(S.turn, { mod: modText }));
  };
  const nth = step?.exit ? ordinal(step.exit, lang) : '';
  const rotary = String(step?.rotary || '').trim();
  switch (type) {
    case 'depart': {
      const s = fill(S.depart, { dir: S.compass[compass(step?.bearingAfter)] });
      return way ? s + fill(S.on, { way }) : s;
    }
    case 'arrive': {
      const last = (step?.leg ?? 0) >= (step?.legCount ?? 1) - 1;
      const s = last ? S.arrive : fill(S.arriveStop, { n: (step?.leg ?? 0) + 1 });
      const at = /left/.test(mod) ? S.arriveSide.left : /right/.test(mod) ? S.arriveSide.right : '';
      return s + at;
    }
    case 'turn':
      return turnLike();
    case 'end of road':
      return fill(S.endOfRoad, { inner: lowerFirst(turnLike()) });
    case 'merge':
      if (/left|right/.test(mod)) return onto(fill(S.merge, { mod: S.mod[mod.replace('slight ', '').replace('sharp ', '')] }));
      return way ? (fr ? `Insérez-vous${fill(S.onto, { way })}` : `${S.mergePlain}${fill(S.onto, { way })}`) : S.mergePlain;
    case 'on ramp':
    case 'ramp':
      return towards(side ? fill(S.onRamp, { side }) : S.onRampPlain);
    case 'off ramp': {
      const exit = String(step?.exits || '')
        .split(';')[0]
        .trim();
      let s;
      if (exit) s = side ? fill(S.offRampNumber, { exit, side }) : fill(S.offRampNumberPlain, { exit });
      else s = side ? fill(S.offRamp, { side }) : S.offRampPlain;
      return dest ? s + towardsText() : s;
    }
    case 'fork':
      if (/left|right/.test(mod)) return onto(fill(S.fork, { mod: S.mod[mod.replace('slight ', '').replace('sharp ', '')] }));
      return onto(S.forkStraight);
    case 'roundabout':
    case 'rotary': {
      const self = fr && /^rond-point\b/i.test(rotary);
      if (!nth) {
        if (type === 'rotary' && rotary) return fill(self ? S.enterRotaryNamedSelf : S.enterRotaryNamed, { rotary });
        return S.enterRoundabout;
      }
      if (type === 'rotary' && rotary) return onto(fill(self ? S.rotaryNamedSelf : S.rotaryNamed, { rotary, nth }));
      return onto(fill(S.roundabout, { nth }));
    }
    case 'roundabout turn':
      if (mod === 'straight' || !mod) return onto(S.roundaboutStraight);
      if (mod === 'uturn') return onto(S.uturn);
      return onto(fill(S.roundaboutTurn, { mod: modText }));
    case 'exit roundabout':
    case 'exit rotary':
      return onto(nth ? fill(S.exitNth, { nth }) : S.exitRoundabout);
    case 'continue':
    case 'new name':
    case 'notification':
    case 'use lane':
    default:
      if (mod === 'uturn') return onto(S.uturn);
      if (type === 'new name' || type === 'notification') {
        if (mod && mod !== 'straight' && S.mod[mod]) return onto(fill(S.continueMod, { mod: modText }));
        return onto(S.continue);
      }
      if (!mod || mod === 'straight') return way ? onto(S.continue) : S.continueStraight;
      return onto(fill(S.continueMod, { mod: modText }));
  }
}

/** The sentence plus « pendant 1,2 km » for steps that just follow a road. */
export function stepText(step, lang = 'en') {
  const text = instruction(step, lang);
  if (CONTINUING.has(step?.type) && step?.modifier !== 'uturn' && step?.distance >= 1) {
    return fill(STR[L(lang)].lasting, { text, dist: formatDistance(step.distance, lang) });
  }
  return text;
}
/** True when stepText already says the distance. */
export const textHasDistance = (step) => CONTINUING.has(step?.type) && step?.modifier !== 'uturn' && step?.distance >= 1;

/** Icon name for a step (Phosphor names; car / bicycle / walk / arrow-up-left / u-turns / flag-checkered are vendored in glyphs.js). */
export function stepIcon(step) {
  const type = step?.type;
  const mod = step?.modifier || '';
  if (type === 'depart') return 'map-pin';
  if (type === 'arrive') return (step?.leg ?? 0) >= (step?.legCount ?? 1) - 1 ? 'flag-checkered' : 'flag';
  if (ROUND.has(type) || EXIT_ROUND.has(type) || type === 'roundabout turn') return step?.drivingSide === 'left' ? 'arrow-clockwise' : 'arrow-counter-clockwise';
  if (mod === 'uturn') return step?.drivingSide === 'left' ? 'arrow-u-up-right' : 'arrow-u-up-left';
  if (mod === 'slight left') return 'arrow-up-left';
  if (mod === 'slight right') return 'arrow-up-right';
  if (/left/.test(mod)) return 'arrow-bend-up-left';
  if (/right/.test(mod)) return 'arrow-bend-up-right';
  return 'arrow-up';
}

// ---------------------------------------------------------------- whole itinerary
const MODE_TITLE = {
  en: { car: 'Directions by car', bike: 'Directions by bike', foot: 'Directions on foot' },
  fr: { car: 'Itinéraire en voiture', bike: 'Itinéraire à vélo', foot: 'Itinéraire à pied' },
};
const LINES = {
  en: { via: 'Via {summary}', arrival: 'arrival around {time}', credit: 'Route: OSRM (FOSSGIS servers) · Map data © OpenStreetMap contributors' },
  fr: { via: 'Par {summary}', arrival: 'arrivée vers {time}', credit: 'Itinéraire : OSRM (serveurs FOSSGIS) · Données © les contributeurs d’OpenStreetMap' },
};
export const modeTitle = (mode, lang = 'en') => MODE_TITLE[L(lang)][mode] || MODE_TITLE[L(lang)].car;
export const creditLine = (lang = 'en') => LINES[L(lang)].credit;

/** Road names of a route ("Quai d'Orsay, Quai Jacques Chirac"), every leg, without repeats. */
export function routeSummary(route) {
  const seen = new Set();
  const names = [];
  for (const leg of route?.legs || []) {
    for (const n of String(leg?.summary || '').split(',')) {
      const x = n.trim();
      if (x && !seen.has(x)) seen.add(x) && names.push(x);
    }
  }
  return names.slice(0, 4).join(', ');
}

/**
 * Plain-text itinerary for the clipboard.
 * { route, steps, names: [start, …stops, destination], mode, lang, now, url }
 */
export function itineraryText({ route, steps, names = [], mode = 'car', lang = 'en', now = new Date(), url = '' }) {
  const Ls = LINES[L(lang)];
  const lines = [`${modeTitle(mode, lang)}${L(lang) === 'fr' ? '\u00a0: ' : ': '}${names.filter(Boolean).join(' → ')}`];
  const arrival = formatArrival(new Date(now.getTime() + (route?.duration || 0) * 1000), lang, now);
  lines.push(`${formatDistance(route?.distance, lang)} · ${formatDuration(route?.duration, lang)} · ${fill(Ls.arrival, { time: arrival })}`);
  const sum = routeSummary(route);
  if (sum) lines.push(fill(Ls.via, { summary: sum }));
  lines.push('');
  (steps || []).forEach((s, i) => {
    const dist = s.type !== 'arrive' && !textHasDistance(s) && s.distance >= 1 ? ` (${formatDistance(s.distance, lang)})` : '';
    lines.push(`${i + 1}. ${stepText(s, lang)}${dist}`);
  });
  lines.push('', Ls.credit);
  if (url) lines.push(url);
  return lines.join('\n');
}

/** openstreetmap.org directions for the same start and destination (the site has no stops). */
export function osmDirectionsUrl(points, mode = 'car') {
  const pts = (points || []).filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon));
  if (pts.length < 2) return 'https://www.openstreetmap.org/directions';
  const engine = { car: 'fossgis_osrm_car', bike: 'fossgis_osrm_bike', foot: 'fossgis_osrm_foot' }[mode] || 'fossgis_osrm_car';
  const f = (p) => `${Math.round(p.lat * 1e5) / 1e5},${Math.round(p.lon * 1e5) / 1e5}`;
  return `https://www.openstreetmap.org/directions?engine=${engine}&route=${encodeURIComponent(`${f(pts[0])};${f(pts[pts.length - 1])}`)}`;
}
