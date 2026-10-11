'use strict';
// Maps backend: OpenStreetMap raster tiles, Nominatim place search and the user's saved places ("My places").
// The renderer CSP has no https: connect-src, so every network request goes through here (Electron net.fetch).
//
// Channels:
//   maps:tile (z, x, y) -> { url: data URL, mock, cached }   z 0..19, 0 <= x,y < 2^z (rejects EINVAL otherwise)
//        Real: https://tile.openstreetmap.org/z/x/y.png with User-Agent "SeleneOS-Maps/1.0", at most 2 requests in
//        flight (queued), memory LRU + disk cache ~/.cache/aurora/maps-tiles/z/x/y.png (7 days; stale copy when offline).
//        Dev/tests (api.DEV unless AURORA_REAL_BACKENDS=1): a locally generated SVG tile (grid + "z/x/y"), never network.
//   maps:search (query, { lang: 'en'|'fr' }) -> [{ id, name, display, type, lat, lon, bbox: [s, n, w, e] | null }]
//        Nominatim (https://nominatim.openstreetmap.org/search), at most 1 request per second (serialized),
//        results cached 24 h per (lang, query). Dev/tests: a small built-in gazetteer, same rate limit.
//   maps:places () -> [{ id, name, display, lat, lon, zoom, added }]  (~/.local/share/aurora/maps.json)
//   maps:savePlace ({ name, display, lat, lon, zoom }) -> places   (same coordinates already saved: updated, not duplicated)
//   maps:renamePlace (id, name) -> places
//   maps:removePlace (id) -> places
//   maps:stats () -> { tileRequests, tileNetwork, tileCacheHits, maxParallel, searchRequests, searchNetwork,
//        searchCacheHits, searchTimes, mock, userAgent }   (diagnostics, tests)
// Env (tests): AURORA_MAPS_TILE_DELAY (ms, mock tiles only) slows the mock tiles so the queue is observable.
const fs = require('fs');
const path = require('path');
const os = require('os');

const USER_AGENT = 'SeleneOS-Maps/1.0';
const TILE_URL = (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
const SEARCH_URL = 'https://nominatim.openstreetmap.org/search';
const MAX_PARALLEL = 2;
const SEARCH_GAP_MS = 1000;
const SEARCH_TTL = 24 * 3600000;
const TILE_TTL = 7 * 24 * 3600000;
const MEM_TILES = 600;
const TIMEOUT_MS = 10000;

const DATA_FILE = () => path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'aurora', 'maps.json');
const TILE_DIR = () => path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'aurora', 'maps-tiles');

function err(message, code) {
  const e = new Error(message);
  e.code = code;
  e.quiet = true;
  return e;
}
const clean = (v, n = 200) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n) : '');

/** Validated integer tile coordinates, or null. */
function normTile(z, x, y) {
  z = Number(z);
  x = Number(x);
  y = Number(y);
  if (![z, x, y].every(Number.isInteger) || z < 0 || z > 19) return null;
  const n = 2 ** z;
  if (x < 0 || y < 0 || x >= n || y >= n) return null;
  return { z, x, y };
}

/** Deterministic mock tile (SVG) with a grid and its z/x/y label. */
function mockTile(z, x, y) {
  // soft "land / water" tint that changes per tile so panning is visible
  const h = (x * 73856093) ^ (y * 19349663) ^ (z * 83492791);
  const water = ((h >>> 3) & 7) === 0;
  const bg = water ? '#aad3df' : ['#f2efe9', '#eef0e4', '#f4f1ea', '#e8eedc'][(h >>> 5) & 3];
  const lines = [];
  for (let i = 0; i <= 256; i += 32) {
    const sw = i % 128 === 0 ? 1.2 : 0.5;
    lines.push(`<path d="M${i} 0V256M0 ${i}H256" stroke="#b9b4aa" stroke-width="${sw}"/>`);
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">` +
    `<rect width="256" height="256" fill="${bg}"/>${lines.join('')}` +
    `<path d="M0 ${40 + (h & 63)}C80 ${(h >>> 6) & 127} 170 ${128 + ((h >>> 9) & 127)} 256 ${60 + ((h >>> 12) & 63)}" fill="none" stroke="#ffffff" stroke-width="5"/>` +
    `<path d="M0 ${40 + (h & 63)}C80 ${(h >>> 6) & 127} 170 ${128 + ((h >>> 9) & 127)} 256 ${60 + ((h >>> 12) & 63)}" fill="none" stroke="#f7c873" stroke-width="3"/>` +
    `<rect x="0.5" y="0.5" width="255" height="255" fill="none" stroke="#8d8579" stroke-width="1"/>` +
    `<text x="128" y="134" text-anchor="middle" font-family="sans-serif" font-size="18" fill="#6b645a">${z}/${x}/${y}</text></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

// Built-in gazetteer for dev/tests (no network).
const GAZETTEER = [
  { id: 1, name: 'Paris', en: 'Paris, Île-de-France, Metropolitan France, France', fr: 'Paris, Île-de-France, France métropolitaine, France', type: 'city', lat: 48.8534951, lon: 2.3483915, bbox: [48.8155755, 48.9021560, 2.2241220, 2.4697602] },
  { id: 2, name: 'Paris', en: 'Paris, Lamar County, Texas, United States', fr: 'Paris, Comté de Lamar, Texas, États-Unis', type: 'town', lat: 33.6617962, lon: -95.555513, bbox: [33.6030, 33.7375, -95.6280, -95.4527] },
  { id: 3, name: 'Lyon', en: 'Lyon, Rhône, Auvergne-Rhône-Alpes, Metropolitan France, France', fr: 'Lyon, Rhône, Auvergne-Rhône-Alpes, France métropolitaine, France', type: 'city', lat: 45.7578137, lon: 4.8320114, bbox: [45.7073666, 45.8082628, 4.7718134, 4.8983774] },
  { id: 4, name: 'London', en: 'London, Greater London, England, United Kingdom', fr: 'Londres, Grand Londres, Angleterre, Royaume-Uni', type: 'city', lat: 51.5073219, lon: -0.1276474, bbox: [51.2867601, 51.6918741, -0.5103751, 0.3340155] },
  { id: 5, name: 'Montréal', en: 'Montreal, Urban agglomeration of Montreal, Quebec, Canada', fr: 'Montréal, Agglomération de Montréal, Québec, Canada', type: 'city', lat: 45.5031824, lon: -73.5698065, bbox: [45.4100756, 45.7047897, -73.9741567, -73.4742952] },
  { id: 6, name: 'Tokyo', en: 'Tokyo, Japan', fr: 'Tokyo, Japon', type: 'city', lat: 35.6768601, lon: 139.7638947, bbox: [35.5208, 35.8175, 139.5629, 139.9183] },
  { id: 7, name: 'New York', en: 'New York, United States', fr: 'New York, États-Unis', type: 'city', lat: 40.7127281, lon: -74.0060152, bbox: [40.476578, 40.91763, -74.258843, -73.700233] },
  { id: 8, name: 'Berlin', en: 'Berlin, Germany', fr: 'Berlin, Allemagne', type: 'city', lat: 52.5170365, lon: 13.3888599, bbox: [52.3382448, 52.6755087, 13.0883450, 13.7611609] },
  { id: 9, name: 'Eiffel Tower', fr_name: 'Tour Eiffel', en: 'Eiffel Tower, Avenue Gustave Eiffel, Paris, France', fr: 'Tour Eiffel, Avenue Gustave Eiffel, Paris, France', type: 'attraction', lat: 48.8582599, lon: 2.2945006, bbox: [48.8574753, 48.8590453, 2.2933119, 2.2956897] },
  { id: 10, name: 'Sydney', en: 'Sydney, New South Wales, Australia', fr: 'Sydney, Nouvelle-Galles du Sud, Australie', type: 'city', lat: -33.8698439, lon: 151.2082848, bbox: [-34.1732, -33.5781, 150.5209, 151.3430] },
];
const fold = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
function mockSearch(q, lang) {
  const f = fold(q);
  return GAZETTEER.filter((p) => fold(`${p.name} ${p.fr_name || ''} ${p.en} ${p.fr}`).includes(f)).map((p) => ({
    place_id: p.id,
    name: lang === 'fr' && p.fr_name ? p.fr_name : p.name,
    display_name: lang === 'fr' ? p.fr : p.en,
    type: p.type,
    lat: String(p.lat),
    lon: String(p.lon),
    boundingbox: p.bbox.map(String),
  }));
}

/** Nominatim jsonv2 answer -> results. */
function parseSearch(json) {
  const list = Array.isArray(json) ? json : [];
  return list
    .map((r) => {
      const bb = Array.isArray(r?.boundingbox) ? r.boundingbox.map(Number) : null;
      const display = clean(r?.display_name, 300);
      return {
        id: Number(r?.place_id) || null,
        name: clean(r?.name, 120) || display.split(',')[0] || '',
        display,
        type: clean(r?.type || r?.addresstype, 40),
        lat: Number(r?.lat),
        lon: Number(r?.lon),
        bbox: bb && bb.length === 4 && bb.every(Number.isFinite) ? bb : null,
      };
    })
    .filter((r) => r.name && Number.isFinite(r.lat) && Number.isFinite(r.lon) && Math.abs(r.lat) <= 90 && Math.abs(r.lon) <= 180)
    .slice(0, 10);
}

/** Validated saved place, or null. */
function normPlace(p) {
  if (!p || typeof p !== 'object') return null;
  const lat = Number(p.lat);
  const lon = Number(p.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const name = clean(p.name, 120);
  if (!name) return null;
  const zoom = Number(p.zoom);
  return {
    id: clean(p.id, 40) || `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    name,
    display: clean(p.display, 300),
    lat: Math.round(lat * 1e6) / 1e6,
    lon: Math.round(lon * 1e6) / 1e6,
    zoom: Number.isFinite(zoom) ? Math.max(2, Math.min(19, Math.round(zoom))) : 15,
    added: Number.isFinite(Number(p.added)) ? Number(p.added) : Date.now(),
  };
}

function register(api) {
  const mock = !!api.DEV && process.env.AURORA_REAL_BACKENDS !== '1';
  const stats = { tileRequests: 0, tileNetwork: 0, tileCacheHits: 0, maxParallel: 0, searchRequests: 0, searchNetwork: 0, searchCacheHits: 0, searchTimes: [], mock, userAgent: USER_AGENT };
  const mockDelay = Math.max(0, Number(process.env.AURORA_MAPS_TILE_DELAY) || 0);

  async function fetchUrl(url, accept) {
    const { net } = require('electron');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      let res;
      try {
        res = await net.fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': USER_AGENT, Accept: accept } });
      } catch (e) {
        throw ctrl.signal.aborted ? err('Request timed out', 'ETIMEDOUT') : err(`Network unreachable (${e.message})`, 'EOFFLINE');
      }
      if (!res.ok) throw err(`Server answered ${res.status}`, 'EHTTP');
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 2 * 1024 * 1024) throw err('Answer too large', 'EBADDATA');
      return { buf, type: res.headers.get('content-type') || '' };
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------------------------------------------------------------- tiles
  const mem = new Map(); // key -> data URL (LRU by insertion order)
  const inflight = new Map(); // key -> promise
  const queue = [];
  let active = 0;
  const remember = (key, url) => {
    mem.delete(key);
    mem.set(key, url);
    if (mem.size > MEM_TILES) mem.delete(mem.keys().next().value);
  };
  const pump = () => {
    while (active < MAX_PARALLEL && queue.length) {
      const job = queue.shift();
      active++;
      stats.maxParallel = Math.max(stats.maxParallel, active);
      job()
        .catch(() => {})
        .finally(() => {
          active--;
          pump();
        });
    }
  };
  const enqueue = (fn) =>
    new Promise((resolve, reject) => {
      queue.push(() => fn().then(resolve, reject));
      pump();
    });

  async function loadTile(t) {
    const key = `${t.z}/${t.x}/${t.y}`;
    if (mock) {
      if (mockDelay) await new Promise((r) => setTimeout(r, mockDelay));
      stats.tileNetwork++;
      return { url: mockTile(t.z, t.x, t.y), mock: true, cached: false };
    }
    const file = path.join(TILE_DIR(), String(t.z), String(t.x), `${t.y}.png`);
    let stale = null;
    try {
      const st = fs.statSync(file);
      const data = `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;
      if (Date.now() - st.mtimeMs < TILE_TTL) {
        stats.tileCacheHits++;
        return { url: data, mock: false, cached: true };
      }
      stale = data;
    } catch {}
    try {
      stats.tileNetwork++;
      const { buf, type } = await fetchUrl(TILE_URL(t.z, t.x, t.y), 'image/png,image/*');
      if (!/^image\//.test(type)) throw err('Not an image', 'EBADDATA');
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, buf);
      } catch {}
      return { url: `data:${type.split(';')[0]};base64,${buf.toString('base64')}`, mock: false, cached: false, key };
    } catch (e) {
      if (stale) return { url: stale, mock: false, cached: true, stale: true };
      throw e;
    }
  }

  async function tile(z, x, y) {
    const t = normTile(z, x, y);
    if (!t) throw err('Invalid tile', 'EINVAL');
    stats.tileRequests++;
    const key = `${t.z}/${t.x}/${t.y}`;
    if (mem.has(key)) {
      stats.tileCacheHits++;
      const url = mem.get(key);
      remember(key, url);
      return { url, mock, cached: true };
    }
    if (inflight.has(key)) return inflight.get(key);
    const p = enqueue(() => loadTile(t))
      .then((r) => {
        remember(key, r.url);
        return { url: r.url, mock: r.mock, cached: r.cached };
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  // ---------------------------------------------------------------- search (1 request / second, cached)
  const searches = new Map();
  let chain = Promise.resolve();
  let lastAt = 0;
  function rateLimited(fn) {
    const run = chain.then(async () => {
      const wait = lastAt + SEARCH_GAP_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastAt = Date.now();
      stats.searchTimes.push(lastAt);
      if (stats.searchTimes.length > 20) stats.searchTimes.shift();
      return fn();
    });
    chain = run.catch(() => {});
    return run;
  }
  async function search(query, { lang = 'en' } = {}) {
    const q = clean(String(query ?? ''), 200);
    if (q.length < 2) return [];
    const l = lang === 'fr' ? 'fr' : 'en';
    stats.searchRequests++;
    const key = `${l}|${q.toLowerCase()}`;
    const hit = searches.get(key);
    if (hit && Date.now() - hit.at < SEARCH_TTL) {
      stats.searchCacheHits++;
      return hit.results;
    }
    if (hit?.pending) return hit.pending;
    const pending = rateLimited(async () => {
      stats.searchNetwork++;
      if (mock) return parseSearch(mockSearch(q, l));
      const url = `${SEARCH_URL}?format=jsonv2&limit=8&q=${encodeURIComponent(q)}&accept-language=${l}`;
      const { buf } = await fetchUrl(url, 'application/json');
      let json;
      try {
        json = JSON.parse(buf.toString('utf8'));
      } catch {
        throw err('Unexpected search answer', 'EBADDATA');
      }
      return parseSearch(json);
    });
    searches.set(key, { at: 0, pending });
    try {
      const results = await pending;
      searches.set(key, { at: Date.now(), results });
      if (searches.size > 200) searches.delete(searches.keys().next().value);
      return results;
    } catch (e) {
      searches.delete(key);
      throw err(e.message || 'Search unavailable', ['ETIMEDOUT', 'EHTTP', 'EBADDATA'].includes(e.code) ? e.code : 'EOFFLINE');
    }
  }

  // ---------------------------------------------------------------- My places
  function readPlaces() {
    try {
      const json = JSON.parse(fs.readFileSync(DATA_FILE(), 'utf8'));
      const list = Array.isArray(json?.places) ? json.places : [];
      const seen = new Set();
      return list.map(normPlace).filter((p) => p && !seen.has(p.id) && seen.add(p.id)).slice(0, 500);
    } catch {
      return [];
    }
  }
  function writePlaces(places) {
    const file = DATA_FILE();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, places }, null, 1));
    fs.renameSync(tmp, file);
    return places;
  }

  api.handle('maps:tile', (z, x, y) => tile(z, x, y));
  api.handle('maps:search', (q, opts) => search(q, opts || {}));
  api.handle('maps:places', () => readPlaces());
  api.handle('maps:savePlace', (p) => {
    const place = normPlace({ ...(p && typeof p === 'object' ? p : {}), id: '' });
    if (!place) throw err('Invalid place', 'EINVAL');
    const places = readPlaces();
    const same = places.find((x) => Math.abs(x.lat - place.lat) < 1e-5 && Math.abs(x.lon - place.lon) < 1e-5);
    if (same) Object.assign(same, { name: place.name, display: place.display || same.display, zoom: place.zoom });
    else places.unshift(place);
    return writePlaces(places.slice(0, 500));
  });
  api.handle('maps:renamePlace', (id, name) => {
    const n = clean(String(name ?? ''), 120);
    if (!n) throw err('Invalid name', 'EINVAL');
    const places = readPlaces();
    const p = places.find((x) => x.id === id);
    if (!p) throw err('No such place', 'ENOENT');
    p.name = n;
    return writePlaces(places);
  });
  api.handle('maps:removePlace', (id) => writePlaces(readPlaces().filter((x) => x.id !== id)));
  api.handle('maps:stats', () => ({ ...stats, searchTimes: stats.searchTimes.slice(), queued: queue.length, active }));
}

module.exports = register;
module.exports.normTile = normTile;
module.exports.mockTile = mockTile;
module.exports.parseSearch = parseSearch;
module.exports.normPlace = normPlace;
module.exports.mockSearch = mockSearch;
module.exports.USER_AGENT = USER_AGENT;
