'use strict';
// Weather for the dynamic wallpaper, the widgets board and a future Weather app (docs/PERSONALIZATION.md §B1).
// Source: Open-Meteo (free, no API key) through Electron's net.fetch (Chromium network stack, system proxy).
//
// Channels:
//   weather:current (place?, { force }) -> conditions (below). place = { lat, lon, name? }; omitted → the
//        location of settings.dynamicWallpaper.location. Cached 30 min per place (memory + ~/.cache/aurora/weather.json);
//        offline / timeout → the last known conditions with stale: true (any age up to 24 h), else rejects EOFFLINE.
//        force: true refetches unless the last fetch is less than a minute old.
//   weather:search (query, { lang: 'en'|'fr', count }) -> [{ id, name, admin1, country, countryCode, lat, lon, timezone }]
//        (Open-Meteo geocoding; cached 1 h; rejects EOFFLINE when the network is unreachable)
//   weather:stats () -> { requests, cacheHits, failures, lastUrl, urls, mock, builtinMock }   (diagnostics, tests)
//   weather:forecast (place?, { force }) -> forecast (below), for the Weather app. Same place rules, 30 min cache per
//        place and offline fallback (stale: true) as weather:current; separate cache (memory only), no broadcast.
//        Forecast: { location, current: conditions + { apparent (°C), humidity (%), wind (km/h), windDir (°), precip (mm) },
//          hourly: [24 × { time (ISO local), code, kind, intensity, describe, isDay, temperature, precipProb }] from the
//          current hour, daily: [7 × { date (YYYY-MM-DD), code, kind, intensity, describe, max, min, precipProb, sunrise,
//          sunset }], timezone, fetchedAt, stale, source }
// Event:
//   weather:changed  conditions   broadcast whenever fresh conditions arrive (not for cache hits)
//
// Conditions: { location: { name, lat, lon }, code (WMO), kind: 'clear'|'clouds'|'fog'|'rain'|'snow'|'storm',
//   intensity: 'light'|'moderate'|'heavy', describe (i18n key: clear, mainlyClear, partlyCloudy, overcast, fog, drizzle,
//   freezingDrizzle, rain, freezingRain, snow, snowGrains, showers, snowShowers, thunderstorm, hail), isDay, temperature (°C),
//   observed (ISO local time of the observation), fetchedAt (ms), stale, source: 'open-meteo'|'mock' }
//
// Testing without network: AURORA_WEATHER_MOCK=/path/mock.json replaces the HTTP requests (the file is re-read on every
// request, so a test can change it live):
//   { "offline": false, "delayMs": 0, "current": { "weather_code": 61, "is_day": 1, "temperature_2m": 12.5, "time": "…" },
//     "geocoding": [ { "id": 1, "name": "Paris", "latitude": 48.85, "longitude": 2.35, "country": "France", … } ] }
// The forecast call synthesises hourly / daily series from the mock's "current" unless the file has a "forecast" object
// (an Open-Meteo forecast answer). Dev mode (api.DEV, unless AURORA_REAL_BACKENDS=1) without AURORA_WEATHER_MOCK uses a
// built-in deterministic mock (no network): conditions derived from the coordinates, a few cities for the search.
// AURORA_WEATHER_TIMEOUT (ms, default 8000) shortens the request timeout; AURORA_WEATHER_TTL (ms) the cache freshness.
const fs = require('fs');
const path = require('path');
const os = require('os');

const FRESH_MS = Math.max(1000, Number(process.env.AURORA_WEATHER_TTL) || 30 * 60000); // AURORA_WEATHER_TTL: tests only
const STALE_MAX_MS = 24 * 3600000;
const FORCE_MIN_MS = 60000;
const SEARCH_TTL = 3600000;
const CACHE_FILE = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'aurora', 'weather.json');

// ---------------------------------------------------------------- pure helpers (unit-tested)
/** WMO weather code → { kind, intensity, describe }. */
function weatherKind(code) {
  const c = Number(code);
  const k = (kind, intensity, describe) => ({ kind, intensity, describe });
  switch (c) {
    case 0: return k('clear', 'light', 'clear');
    case 1: return k('clear', 'light', 'mainlyClear');
    case 2: return k('clouds', 'light', 'partlyCloudy');
    case 3: return k('clouds', 'heavy', 'overcast');
    case 45: return k('fog', 'moderate', 'fog');
    case 48: return k('fog', 'heavy', 'fog');
    case 51: return k('rain', 'light', 'drizzle');
    case 53: return k('rain', 'light', 'drizzle');
    case 55: return k('rain', 'moderate', 'drizzle');
    case 56: return k('rain', 'light', 'freezingDrizzle');
    case 57: return k('rain', 'moderate', 'freezingDrizzle');
    case 61: return k('rain', 'light', 'rain');
    case 63: return k('rain', 'moderate', 'rain');
    case 65: return k('rain', 'heavy', 'rain');
    case 66: return k('rain', 'light', 'freezingRain');
    case 67: return k('rain', 'heavy', 'freezingRain');
    case 71: return k('snow', 'light', 'snow');
    case 73: return k('snow', 'moderate', 'snow');
    case 75: return k('snow', 'heavy', 'snow');
    case 77: return k('snow', 'light', 'snowGrains');
    case 80: return k('rain', 'light', 'showers');
    case 81: return k('rain', 'moderate', 'showers');
    case 82: return k('rain', 'heavy', 'showers');
    case 85: return k('snow', 'light', 'snowShowers');
    case 86: return k('snow', 'heavy', 'snowShowers');
    case 95: return k('storm', 'moderate', 'thunderstorm');
    case 96: return k('storm', 'heavy', 'hail');
    case 99: return k('storm', 'heavy', 'hail');
    default: return k('clear', 'light', 'clear');
  }
}

const round = (n, d = 4) => Math.round(n * 10 ** d) / 10 ** d;
/** { lat, lon, name } with valid coordinates, or null. */
function normPlace(p) {
  if (!p || typeof p !== 'object') return null;
  const lat = Number(p.lat);
  const lon = Number(p.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const name = typeof p.name === 'string' ? p.name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 120) : '';
  return { lat: round(lat), lon: round(lon), name };
}
const placeKey = (p) => `${p.lat.toFixed(2)},${p.lon.toFixed(2)}`;

function forecastUrl(p) {
  return `https://api.open-meteo.com/v1/forecast?latitude=${p.lat}&longitude=${p.lon}&current=weather_code,is_day,temperature_2m&timezone=auto`;
}
function geocodeUrl(query, lang = 'en', count = 8) {
  const l = lang === 'fr' ? 'fr' : 'en';
  const n = Math.max(1, Math.min(20, Number(count) || 8));
  return `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=${n}&language=${l}&format=json`;
}

function forecastFullUrl(p) {
  return (
    `https://api.open-meteo.com/v1/forecast?latitude=${p.lat}&longitude=${p.lon}` +
    '&current=weather_code,is_day,temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,wind_direction_10m,precipitation' +
    '&hourly=weather_code,is_day,temperature_2m,precipitation_probability' +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset' +
    '&forecast_days=7&forecast_hours=25&timezone=auto'
  );
}

const num1 = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 10) / 10);
const isoTxt = (v) => (typeof v === 'string' ? v.replace(/[^0-9T:\-]/g, '').slice(0, 20) : null);

/** Open-Meteo full forecast JSON (current + hourly + daily) → forecast (throws EBADDATA on a malformed answer). */
function parseFullForecast(json, place, source = 'open-meteo') {
  const now = parseForecast(json, place, source);
  const cur = json.current;
  const current = { ...now, apparent: num1(cur.apparent_temperature), humidity: num1(cur.relative_humidity_2m), wind: num1(cur.wind_speed_10m), windDir: num1(cur.wind_direction_10m), precip: num1(cur.precipitation) };
  const H = json.hourly && typeof json.hourly === 'object' ? json.hourly : {};
  const times = Array.isArray(H.time) ? H.time : [];
  const startHour = typeof cur.time === 'string' ? cur.time.slice(0, 13) : '';
  const hourly = [];
  for (let i = 0; i < times.length && hourly.length < 24; i++) {
    const time = isoTxt(times[i]);
    if (!time || (startHour && time.slice(0, 13) < startHour)) continue;
    const code = Number(H.weather_code?.[i]);
    if (!Number.isInteger(code) || code < 0 || code > 99) continue;
    hourly.push({ time, code, ...weatherKind(code), isDay: H.is_day?.[i] == null ? null : Number(H.is_day[i]) === 1, temperature: num1(H.temperature_2m?.[i]), precipProb: num1(H.precipitation_probability?.[i]) });
  }
  const D = json.daily && typeof json.daily === 'object' ? json.daily : {};
  const days = Array.isArray(D.time) ? D.time : [];
  const daily = [];
  for (let i = 0; i < days.length && daily.length < 7; i++) {
    const date = isoTxt(days[i]);
    const code = Number(D.weather_code?.[i]);
    if (!date || !Number.isInteger(code) || code < 0 || code > 99) continue;
    daily.push({ date: date.slice(0, 10), code, ...weatherKind(code), max: num1(D.temperature_2m_max?.[i]), min: num1(D.temperature_2m_min?.[i]), precipProb: num1(D.precipitation_probability_max?.[i]), sunrise: isoTxt(D.sunrise?.[i]), sunset: isoTxt(D.sunset?.[i]) });
  }
  const tz = typeof json.timezone === 'string' ? json.timezone.replace(/[^A-Za-z0-9_+\-/]/g, '').slice(0, 64) : '';
  return { location: now.location, current, hourly, daily, timezone: tz, fetchedAt: now.fetchedAt, stale: false, source };
}

// ---------------------------------------------------------------- deterministic mock (dev / tests, no network)
const MOCK_CITIES = [
  [2988507, 'Paris', 'Île-de-France', 'France', 'FR', 48.8566, 2.3522, 'Europe/Paris'],
  [2996944, 'Lyon', 'Auvergne-Rhône-Alpes', 'France', 'FR', 45.7485, 4.8467, 'Europe/Paris'],
  [2995469, 'Marseille', "Provence-Alpes-Côte d'Azur", 'France', 'FR', 43.2965, 5.3698, 'Europe/Paris'],
  [2983990, 'Rennes', 'Bretagne', 'France', 'FR', 48.1173, -1.6778, 'Europe/Paris'],
  [2643743, 'London', 'England', 'United Kingdom', 'GB', 51.5085, -0.1257, 'Europe/London'],
  [2950159, 'Berlin', 'Land Berlin', 'Germany', 'DE', 52.5244, 13.4105, 'Europe/Berlin'],
  [6077243, 'Montréal', 'Quebec', 'Canada', 'CA', 45.5088, -73.5878, 'America/Toronto'],
  [5128581, 'New York', 'New York', 'United States', 'US', 40.7143, -74.006, 'America/New_York'],
  [1850147, 'Tokyo', 'Tokyo', 'Japan', 'JP', 35.6895, 139.6917, 'Asia/Tokyo'],
  [2147714, 'Sydney', 'New South Wales', 'Australia', 'AU', -33.8679, 151.2073, 'Australia/Sydney'],
];
const MOCK_CODES = [0, 1, 2, 3, 61, 63, 80, 2, 1, 45, 71, 95];
const pad2 = (n) => String(n).padStart(2, '0');
const localIso = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:00`;
/** Deterministic Open-Meteo-shaped forecast for a place (values depend only on the coordinates and the step). */
function mockForecastJson(lat, lon, currentOverride, nowMs = Date.now()) {
  const seed = Math.abs(Math.round(lat * 7 + lon * 13)) % MOCK_CODES.length;
  const base = Math.round((24 - Math.abs(lat) * 0.35) * 10) / 10;
  const now = new Date(nowMs);
  now.setMinutes(0, 0, 0);
  const hour = now.getHours();
  const tempAt = (h, dayIdx) => Math.round((base - dayIdx * 0.6 + 5 * Math.sin(((h - 9) / 24) * 2 * Math.PI)) * 10) / 10;
  const hourly = { time: [], weather_code: [], is_day: [], temperature_2m: [], precipitation_probability: [] };
  for (let i = 0; i < 25; i++) {
    const d = new Date(now.getTime() + i * 3600000);
    const h = d.getHours();
    const code = MOCK_CODES[(seed + Math.floor((hour + i) / 6)) % MOCK_CODES.length];
    hourly.time.push(localIso(d));
    hourly.weather_code.push(code);
    hourly.is_day.push(h >= 7 && h < 19 ? 1 : 0);
    hourly.temperature_2m.push(tempAt(h, Math.floor((hour + i) / 24)));
    hourly.precipitation_probability.push(code >= 51 ? 40 + ((seed * 7 + i * 3) % 50) : (seed + i) % 15);
  }
  const daily = { time: [], weather_code: [], temperature_2m_max: [], temperature_2m_min: [], precipitation_probability_max: [], sunrise: [], sunset: [] };
  for (let i = 0; i < 7; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
    const day = localIso(d).slice(0, 10);
    const code = MOCK_CODES[(seed + i * 5) % MOCK_CODES.length];
    daily.time.push(day);
    daily.weather_code.push(code);
    daily.temperature_2m_max.push(Math.round((base + 5 - i * 0.6 + ((seed + i) % 3)) * 10) / 10);
    daily.temperature_2m_min.push(Math.round((base - 5 - i * 0.6 - ((seed + i) % 2)) * 10) / 10);
    daily.precipitation_probability_max.push(code >= 51 ? 60 + ((seed + i) % 4) * 10 : ((seed + i * 3) % 4) * 5);
    daily.sunrise.push(`${day}T07:${pad2(30 + (i % 5))}`);
    daily.sunset.push(`${day}T19:${pad2(10 - (i % 5))}`);
  }
  const current = {
    weather_code: hourly.weather_code[0],
    is_day: hourly.is_day[0],
    temperature_2m: hourly.temperature_2m[0],
    apparent_temperature: Math.round((hourly.temperature_2m[0] - 1.8) * 10) / 10,
    relative_humidity_2m: 55 + (seed * 3) % 35,
    wind_speed_10m: 8 + ((seed * 5) % 20),
    wind_direction_10m: (seed * 37) % 360,
    precipitation: hourly.weather_code[0] >= 51 ? 0.6 : 0,
    ...(currentOverride && typeof currentOverride === 'object' ? currentOverride : {}),
    time: hourly.time[0], // the hourly series starts at the current hour
  };
  return { timezone: 'auto', current, hourly, daily };
}
function mockGeocoding(url) {
  const q = (decodeURIComponent((/[?&]name=([^&]*)/.exec(url) || [])[1] || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')).toLowerCase();
  const fold = (x) => x.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const results = MOCK_CITIES.filter((c) => q && fold(c[1]).startsWith(q)).map(([id, name, admin1, country, cc, lat, lon, timezone]) => ({ id, name, admin1, country, country_code: cc, latitude: lat, longitude: lon, timezone }));
  return { results };
}

/** Open-Meteo forecast JSON → conditions (throws EBADDATA on a malformed answer). */
function parseForecast(json, place, source = 'open-meteo') {
  const cur = json && typeof json === 'object' ? json.current : null;
  const code = Number(cur?.weather_code);
  const temp = Number(cur?.temperature_2m);
  if (!cur || !Number.isInteger(code) || code < 0 || code > 99) {
    const e = new Error('Unexpected weather data');
    e.code = 'EBADDATA';
    throw e;
  }
  return {
    location: { name: place.name || '', lat: place.lat, lon: place.lon },
    code,
    ...weatherKind(code),
    isDay: cur.is_day == null ? null : Number(cur.is_day) === 1,
    temperature: Number.isFinite(temp) ? Math.round(temp * 10) / 10 : null,
    unit: '°C',
    observed: typeof cur.time === 'string' ? cur.time.slice(0, 32) : null,
    fetchedAt: Date.now(),
    stale: false,
    source,
  };
}

/** Open-Meteo geocoding JSON → places. */
function parseGeocoding(json) {
  const list = Array.isArray(json?.results) ? json.results : Array.isArray(json) ? json : [];
  const txt = (v, n = 120) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n) : '');
  return list
    .map((r) => ({
      id: Number(r?.id) || null,
      name: txt(r?.name),
      admin1: txt(r?.admin1),
      country: txt(r?.country),
      countryCode: txt(r?.country_code, 4).toUpperCase(),
      lat: Number(r?.latitude),
      lon: Number(r?.longitude),
      timezone: txt(r?.timezone, 64),
    }))
    .filter((r) => r.name && Number.isFinite(r.lat) && Number.isFinite(r.lon) && Math.abs(r.lat) <= 90 && Math.abs(r.lon) <= 180)
    .slice(0, 20);
}

function err(message, code) {
  const e = new Error(message);
  e.code = code;
  e.quiet = true; // expected (offline): no stack in the dev console
  return e;
}

// ---------------------------------------------------------------- module
function register(api) {
  // built-in dev mock: forecast + search only (weather:current keeps its real request in dev, see wallpapers.test.mjs)
  const builtinMock = !process.env.AURORA_WEATHER_MOCK && !!api.DEV && process.env.AURORA_REAL_BACKENDS !== '1';
  const stats = { requests: 0, cacheHits: 0, failures: 0, lastUrl: null, urls: [], mock: !!process.env.AURORA_WEATHER_MOCK, builtinMock };
  const timeoutMs = Math.max(50, Number(process.env.AURORA_WEATHER_TIMEOUT) || 8000);
  const cache = new Map(); // placeKey -> conditions
  const inflight = new Map();
  const searches = new Map(); // `${lang}|${q}` -> { at, results }
  try {
    const saved = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    for (const c of Array.isArray(saved?.entries) ? saved.entries : []) {
      const p = normPlace(c?.location);
      if (p && Number.isFinite(c.fetchedAt) && Number.isInteger(c.code)) cache.set(placeKey(p), { ...c, ...weatherKind(c.code), location: { ...p, name: p.name } });
    }
  } catch {}
  let saveTimer = null;
  const persist = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
        const entries = [...cache.values()].sort((a, b) => b.fetchedAt - a.fetchedAt).slice(0, 8);
        fs.writeFileSync(CACHE_FILE, JSON.stringify({ version: 1, entries }));
      } catch {}
    }, 200);
  };

  // GET a JSON document (Electron net.fetch, or the mock file), with a timeout.
  async function getJson(url) {
    stats.requests++;
    stats.lastUrl = url;
    stats.urls.push(url);
    if (stats.urls.length > 20) stats.urls.shift();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const latLon = () => [Number((/latitude=([-0-9.]+)/.exec(url) || [])[1]) || 0, Number((/longitude=([-0-9.]+)/.exec(url) || [])[1]) || 0];
      if (builtinMock && url.includes('geocoding-api')) return mockGeocoding(url);
      if (builtinMock && url.includes('&hourly=')) return mockForecastJson(...latLon());
      const mockFile = process.env.AURORA_WEATHER_MOCK;
      if (mockFile) {
        let mock = {};
        try {
          mock = JSON.parse(fs.readFileSync(mockFile, 'utf8'));
        } catch {}
        const delay = Math.max(0, Number(mock.delayMs) || 0);
        if (delay) {
          await new Promise((resolve, reject) => {
            const t = setTimeout(resolve, delay);
            ctrl.signal.addEventListener('abort', () => (clearTimeout(t), reject(err('Weather request timed out', 'ETIMEDOUT'))), { once: true });
          });
        }
        if (mock.offline) throw err('Network unreachable', 'EOFFLINE');
        if (url.includes('geocoding-api')) return { results: Array.isArray(mock.geocoding) ? mock.geocoding : [] };
        if (url.includes('&hourly=')) return mock.forecast && typeof mock.forecast === 'object' ? mock.forecast : mockForecastJson(...latLon(), mock.current);
        return { current: mock.current || { weather_code: 0, is_day: 1, temperature_2m: 20, time: new Date().toISOString().slice(0, 16) } };
      }
      const { net } = require('electron');
      let res;
      try {
        res = await net.fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json', 'User-Agent': `SeleneOS/${api.env?.version || '1'}` } });
      } catch (e) {
        throw ctrl.signal.aborted ? err('Weather request timed out', 'ETIMEDOUT') : err(`Network unreachable (${e.message})`, 'EOFFLINE');
      }
      if (!res.ok) throw err(`Weather service answered ${res.status}`, 'EHTTP');
      const text = await res.text();
      if (text.length > 512 * 1024) throw err('Weather answer too large', 'EBADDATA');
      return JSON.parse(text);
    } finally {
      clearTimeout(timer);
    }
  }

  async function current(place, { force = false } = {}) {
    const p = normPlace(place) || normPlace(api.settings?.get?.('dynamicWallpaper.location'));
    if (!p) throw err('No location set', 'ENOLOCATION');
    const key = placeKey(p);
    const hit = cache.get(key);
    const age = hit ? Date.now() - hit.fetchedAt : Infinity;
    if (hit && !hit.stale && (age < FRESH_MS) && !(force && age > FORCE_MIN_MS)) {
      stats.cacheHits++;
      return { ...hit, location: { ...hit.location, name: p.name || hit.location.name } };
    }
    if (inflight.has(key)) return inflight.get(key);
    const job = (async () => {
      try {
        const json = await getJson(forecastUrl(p));
        const c = parseForecast(json, p, stats.mock ? 'mock' : 'open-meteo');
        cache.set(key, c);
        persist();
        api.broadcast('weather:changed', c);
        return c;
      } catch (e) {
        stats.failures++;
        // offline: the last known conditions, marked stale
        if (hit && Date.now() - hit.fetchedAt < STALE_MAX_MS) return { ...hit, stale: true, error: e.code || 'EFAIL' };
        throw err(e.message || 'Weather unavailable', ['ETIMEDOUT', 'EHTTP', 'EBADDATA'].includes(e.code) ? e.code : 'EOFFLINE');
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, job);
    return job;
  }

  async function search(query, { lang = 'en', count = 8 } = {}) {
    const q = String(query ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80);
    if (q.length < 2) return [];
    lang = lang === 'fr' ? 'fr' : 'en';
    count = Math.max(1, Math.min(20, Math.round(Number(count)) || 8));
    const key = `${lang}|${q.toLowerCase()}|${count}`;
    const hit = searches.get(key);
    if (hit && Date.now() - hit.at < SEARCH_TTL) {
      stats.cacheHits++;
      return hit.results;
    }
    try {
      const results = parseGeocoding(await getJson(geocodeUrl(q, lang, count)));
      searches.set(key, { at: Date.now(), results });
      if (searches.size > 100) searches.delete(searches.keys().next().value);
      return results;
    } catch (e) {
      stats.failures++;
      throw err(e.message || 'Search unavailable', e.code === 'ETIMEDOUT' ? 'ETIMEDOUT' : 'EOFFLINE');
    }
  }

  const fcache = new Map(); // placeKey -> forecast
  const finflight = new Map();
  async function forecast(place, { force = false } = {}) {
    const p = normPlace(place) || normPlace(api.settings?.get?.('dynamicWallpaper.location'));
    if (!p) throw err('No location set', 'ENOLOCATION');
    const key = placeKey(p);
    const hit = fcache.get(key);
    const age = hit ? Date.now() - hit.fetchedAt : Infinity;
    if (hit && age < FRESH_MS && !(force && age > FORCE_MIN_MS)) {
      stats.cacheHits++;
      return { ...hit, location: { ...hit.location, name: p.name || hit.location.name } };
    }
    if (finflight.has(key)) return finflight.get(key);
    const job = (async () => {
      try {
        const f = parseFullForecast(await getJson(forecastFullUrl(p)), p, stats.mock || builtinMock ? 'mock' : 'open-meteo');
        fcache.set(key, f);
        if (fcache.size > 32) fcache.delete(fcache.keys().next().value);
        return f;
      } catch (e) {
        stats.failures++;
        if (hit && Date.now() - hit.fetchedAt < STALE_MAX_MS) return { ...hit, location: { ...hit.location, name: p.name || hit.location.name }, stale: true, error: e.code || 'EFAIL' };
        throw err(e.message || 'Weather unavailable', ['ETIMEDOUT', 'EHTTP', 'EBADDATA'].includes(e.code) ? e.code : 'EOFFLINE');
      } finally {
        finflight.delete(key);
      }
    })();
    finflight.set(key, job);
    return job;
  }

  api.handle('weather:current', (place, opts) => current(place, opts || {}));
  api.handle('weather:forecast', (place, opts) => forecast(place, opts || {}));
  api.handle('weather:search', (query, opts) => search(query, opts || {}));
  api.handle('weather:stats', () => ({ ...stats, urls: stats.urls.slice() }));
}

module.exports = register;
module.exports.weatherKind = weatherKind;
module.exports.forecastUrl = forecastUrl;
module.exports.geocodeUrl = geocodeUrl;
module.exports.parseForecast = parseForecast;
module.exports.parseGeocoding = parseGeocoding;
module.exports.normPlace = normPlace;
module.exports.forecastFullUrl = forecastFullUrl;
module.exports.parseFullForecast = parseFullForecast;
module.exports.mockForecastJson = mockForecastJson;
module.exports.mockGeocoding = mockGeocoding;
