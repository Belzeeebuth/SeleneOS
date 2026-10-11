// Personalization area B1 — wallpaper engine: animated wallpapers (6 effects), dynamic wallpapers (time of day + sun
// maths + weather), slideshow, lock screen / sign-in screen backgrounds, Settings pages (Background, Lock screen,
// Animated & dynamic wallpapers), profiles. See docs/PERSONALIZATION.md §9.
//
//   xvfb-run -a -s "-screen 0 1600x900x24" node test/wallpapers.test.mjs [--no-shots] [--only=unit,engine,dynamic,ui,lock,sizes,restart]
//
// Weather is tested with the mock backend (AURORA_WEATHER_MOCK) — the build container has no access to Open-Meteo;
// a real request is attempted at the end and reported (not required).
// Screenshots: docs/screenshots/wallpaper-*.png
import { launchShell, ROOT } from './lib.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const ARGS = process.argv.slice(2);
const NO_SHOTS = ARGS.includes('--no-shots');
const ONLY = (ARGS.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const run = (part) => !ONLY.length || ONLY.includes(part);
const DOCS = path.join(ROOT, '..', 'docs', 'screenshots');
const R = (p) => pathToFileURL(path.join(ROOT, 'renderer', p)).href;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const failures = [];
function check(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  ok  ${msg}`);
  } else {
    failures.push(msg);
    console.log(`  FAIL ${msg}`);
  }
}
const S = (sel) => `.app-settings ${sel}`;
async function docShot(s, name) {
  if (NO_SHOTS) return;
  const f = await s.shot(name);
  fs.mkdirSync(DOCS, { recursive: true });
  fs.copyFileSync(f, path.join(DOCS, `${name}.png`));
}
const errorsOf = (s) => s.logs.filter((l) => /^\[(error|pageerror)\]/.test(l) && !/Failed to load resource/.test(l));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-wp-test-'));
const MOCK = path.join(tmp, 'weather-mock.json');
const mock = (o) => fs.writeFileSync(MOCK, JSON.stringify(o));
const WX = (code, isDay = 1, temp = 12.4) => ({ current: { weather_code: code, is_day: isDay, temperature_2m: temp, time: '2026-10-10T14:00' } });
const GEO = [
  { id: 2988507, name: 'Paris', latitude: 48.85341, longitude: 2.3488, country: 'France', country_code: 'FR', admin1: 'Île-de-France', timezone: 'Europe/Paris' },
  { id: 4717560, name: 'Paris', latitude: 33.66094, longitude: -95.55551, country: 'United States', country_code: 'US', admin1: 'Texas', timezone: 'America/Chicago' },
];
const ENV = { AURORA_WEATHER_MOCK: MOCK, AURORA_WEATHER_TTL: '2500', AURORA_WEATHER_TIMEOUT: '1200' };
const PARIS = { name: 'Paris', lat: 48.8566, lon: 2.3522 };

// settings page helpers
async function go(s, page, section) {
  await s.aurora(([p, sec]) => window.__aurora.registry.launch('settings', { page: p, section: sec }), [page, section]);
  await s.page.waitForSelector(S(`.st-page[data-page="${page}"]`), { timeout: 10000 });
  await sleep(600);
}
async function rowOf(s, title) {
  const row = s.page.locator(S('.st-row, .st-exp-head')).filter({ has: s.page.locator('.st-row-title', { hasText: title }) }).first();
  await row.waitFor({ timeout: 5000 });
  return row;
}
async function pickCombo(s, rowTitle, optionText) {
  const row = await rowOf(s, rowTitle);
  await row.locator('.st-combo').first().click();
  await s.page.locator('.menu .menu-item', { hasText: optionText }).first().click();
  await sleep(350);
}
const get = (s, key) => s.aurora((k) => window.__aurora.settings.get(k), key);
const set = (s, key, v) => s.aurora(([k, val]) => window.__aurora.settings.set(k, val), [key, v]);
const setMany = (s, patch) => s.aurora((p) => window.__aurora.api.invoke('settings:setMany', p), patch);
const inv = (s, ch, ...a) => s.aurora(([c, args]) => window.__aurora.api.invoke(c, ...args).then((v) => ({ v }), (e) => ({ err: e.code || e.message })), [ch, a]);
const state = (s) => s.aurora(() => window.__aurora.wallpaperEngine.state);
const frames = (s) => s.aurora(() => window.__aurora.wallpaperEngine.state.frames);
async function waitFor(fn, ms = 5000, step = 100) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(step);
  }
}

// =====================================================================================================================
async function unit() {
  console.log('\n# Unit: solar maths, time-of-day sets, weather mapping, cities, defaults, assets');
  const solar = await import(R('core/wallpaper/solar.js'));
  const dyn = await import(R('core/wallpaper/dynamic.js'));
  const cities = await import(R('core/wallpaper/cities.js'));
  const wx = require(path.join(ROOT, 'main/ipc/weather.js'));
  const hm = (d, tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
  const mins = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const near = (d, tz, want, tol = 2) => d && Math.abs(mins(hm(d, tz)) - mins(want)) <= tol;

  const paris = solar.sunTimes(new Date('2026-06-21T12:00:00+02:00'), 48.8566, 2.3522);
  check(near(paris.sunrise, 'Europe/Paris', '05:47'), `Paris sunrise on 2026-06-21 ≈ 05:47 local (got ${hm(paris.sunrise, 'Europe/Paris')})`);
  check(near(paris.sunset, 'Europe/Paris', '21:58'), `Paris sunset on 2026-06-21 ≈ 21:58 (got ${hm(paris.sunset, 'Europe/Paris')})`);
  check(near(paris.noon, 'Europe/Paris', '13:52'), `Paris solar noon ≈ 13:52 (got ${hm(paris.noon, 'Europe/Paris')})`);
  check(near(paris.dawn, 'Europe/Paris', '05:05', 3) && near(paris.dusk, 'Europe/Paris', '22:40', 3), `Paris civil dawn / dusk ≈ 05:05 / 22:40 (got ${hm(paris.dawn, 'Europe/Paris')} / ${hm(paris.dusk, 'Europe/Paris')})`);
  const pw = solar.sunTimes(new Date('2026-12-21T12:00:00+01:00'), 48.8566, 2.3522);
  check(near(pw.sunrise, 'Europe/Paris', '08:42') && near(pw.sunset, 'Europe/Paris', '16:56'), `Paris winter solstice 08:42 → 16:56 (got ${hm(pw.sunrise, 'Europe/Paris')} → ${hm(pw.sunset, 'Europe/Paris')})`);
  const ny = solar.sunTimes(new Date('2026-03-20T12:00:00-04:00'), 40.7128, -74.006);
  check(near(ny.sunrise, 'America/New_York', '06:59') && near(ny.sunset, 'America/New_York', '19:08'), `New York equinox 06:59 → 19:08 (got ${hm(ny.sunrise, 'America/New_York')} → ${hm(ny.sunset, 'America/New_York')})`);
  const syd = solar.sunTimes(new Date('2026-06-21T12:00:00+10:00'), -33.8688, 151.2093);
  check(near(syd.sunrise, 'Australia/Sydney', '07:00') && near(syd.sunset, 'Australia/Sydney', '16:54'), `Sydney (southern winter) 07:00 → 16:54 (got ${hm(syd.sunrise, 'Australia/Sydney')} → ${hm(syd.sunset, 'Australia/Sydney')})`);
  const trS = solar.sunTimes(new Date('2026-06-21T12:00:00+02:00'), 69.6492, 18.9553);
  const trW = solar.sunTimes(new Date('2026-12-21T12:00:00+01:00'), 69.6492, 18.9553);
  check(trS.polar === 'day' && !trS.sunrise && trW.polar === 'night' && !trW.sunrise, 'Tromsø: midnight sun in June, polar night in December');
  check(solar.sunTimes(new Date(), 91, 0) === null && solar.sunTimes(new Date(), 'x', 0) === null, 'invalid coordinates → null');
  // phases (Paris, 21 June 2026 — UTC instants: sunrise 03:47, sunset 19:58)
  const P = (iso) => solar.phaseAt(new Date(iso), { lat: 48.8566, lon: 2.3522 });
  const ph = ['2026-06-21T02:00:00Z', '2026-06-21T03:30:00Z', '2026-06-21T05:30:00Z', '2026-06-21T12:00:00Z', '2026-06-21T19:00:00Z', '2026-06-21T20:20:00Z', '2026-06-21T21:30:00Z'].map((i) => P(i).phase);
  check(ph.join(',') === 'night,dawn,day,day,dusk,dusk,night', `Paris phases through the day: ${ph.join(', ')}`);
  const pn = P('2026-06-21T12:00:00Z');
  check(pn.next && Math.abs(pn.next.getTime() - (paris.sunset.getTime() - 80 * 60000)) < 1000 && pn.source === 'sun', `next change from "day" = sunset − 80 min (${pn.next.toISOString()})`);
  const pl = P('2026-06-21T21:30:00Z');
  check(pl.next > new Date('2026-06-22T03:00:00Z') && pl.next < new Date('2026-06-22T03:15:00Z'), `after dusk the next change is tomorrow's dawn (${pl.next.toISOString()})`);
  // fixed hours (no location), local clock
  const F = (h, m = 0) => solar.phaseAt(new Date(2026, 9, 10, h, m), null);
  const fx = [[5, 0], [6, 40], [12, 0], [18, 0], [19, 30], [21, 0]].map(([h, m]) => F(h, m).phase);
  check(fx.join(',') === 'night,dawn,day,dusk,dusk,night' && F(12).source === 'fixed', `fixed hours without a location (sunrise ${solar.FIXED.sunrise}, sunset ${solar.FIXED.sunset}): ${fx.join(', ')}`);
  check(solar.daylightAt(new Date(2026, 9, 10, 12), null) && !solar.daylightAt(new Date(2026, 9, 10, 22), null) && solar.daylightAt(new Date('2026-06-21T12:00:00Z'), { lat: 48.85, lon: 2.35 }) && !solar.daylightAt(new Date('2026-06-21T21:00:00Z'), { lat: 48.85, lon: 2.35 }), 'daylightAt: light from sunrise to sunset');
  check(solar.phaseAt(new Date('2026-06-21T12:00:00Z'), { lat: 69.65, lon: 18.96 }).phase === 'day' && solar.phaseAt(new Date('2026-12-21T12:00:00Z'), { lat: 69.65, lon: 18.96 }).phase === 'night', 'polar day / night phases');
  // short winter day far north: no overlap, dawn then dusk
  const short = solar.phaseAt(new Date('2026-12-15T11:00:00Z'), { lat: 64.15, lon: -21.94 });
  check(['dawn', 'dusk', 'day'].includes(short.phase), `Reykjavik in December: phases stay ordered (${short.phase})`);

  // time-of-day sets
  check(dyn.DYNAMIC_SETS.map((s) => s.id).join() === dyn.SET_IDS.join(), 'SET_IDS matches DYNAMIC_SETS');
  let allOk = true;
  for (const s of dyn.DYNAMIC_SETS) {
    for (const ph of solar.PHASES) {
      const file = path.join(ROOT, 'renderer/assets/wallpapers', s.variants[ph]);
      const buf = fs.existsSync(file) ? fs.readFileSync(file) : null;
      const jpeg = buf && buf[0] === 0xff && buf[1] === 0xd8;
      let w = 0;
      let h = 0;
      for (let i = 2; buf && i < buf.length - 9; ) {
        if (buf[i] !== 0xff) break;
        const marker = buf[i + 1];
        const len = buf.readUInt16BE(i + 2);
        if (marker === 0xc0 || marker === 0xc2) {
          h = buf.readUInt16BE(i + 5);
          w = buf.readUInt16BE(i + 7);
          break;
        }
        i += 2 + len;
      }
      if (!jpeg || w !== 2560 || h !== 1600 || buf.length > 700 * 1024) {
        allOk = false;
        console.log(`    ${file}: jpeg ${jpeg} ${w}x${h} ${buf?.length}`);
      }
    }
  }
  check(allOk, 'every time-of-day variant exists (3 sets × 4 phases), JPEG 2560×1600, < 700 KB');
  check(dyn.dynamicPick('lake', new Date('2026-06-21T19:30:00Z'), PARIS).url.endsWith('dynamic/lake-dusk.jpg') && dyn.dynamicPick('lake', new Date('2026-06-21T22:00:00Z'), PARIS).url.endsWith('/aurora.jpg') && dyn.dynamicPick('dunes', new Date('2026-06-21T03:30:00Z'), PARIS).url.endsWith('dunes-dawn.jpg'), 'dynamicPick: the right variant for given times and a location');
  const spots = dyn.spotlightList();
  const d0 = dyn.spotlightPick(new Date(2026, 9, 10, 9));
  const d0b = dyn.spotlightPick(new Date(2026, 9, 10, 23));
  const d1 = dyn.spotlightPick(new Date(2026, 9, 11, 9));
  check(spots.length >= 20 && spots.every((x) => fs.existsSync(path.join(ROOT, 'renderer/assets/wallpapers', x.url.replace('app://shell/assets/wallpapers/', '')))), `spotlight: ${spots.length} built-in pictures, every file exists`);
  check(d0.url === d0b.url && d0.url !== d1.url && dyn.spotlightPick(new Date(2026, 9, 10), 1).url === d1.url, 'spotlight: one picture per calendar day, a new one the next day');
  const fam = spots.map((x) => dyn.pictureFamily(x.url));
  const repeats = fam.filter((f, i) => f === fam[(i + 1) % fam.length]);
  check(new Set(spots.map((x) => x.url)).size === spots.length && !repeats.length && new Set(fam).size >= 5, `spotlight: consecutive days never repeat a family, wrap-around included (${[...new Set(fam)].join(', ')})`);

  // weather mapping + URLs + parsing
  const k = (c) => wx.weatherKind(c);
  const table = [[0, 'clear'], [1, 'clear'], [2, 'clouds', 'light'], [3, 'clouds', 'heavy'], [45, 'fog'], [48, 'fog', 'heavy'], [51, 'rain', 'light'], [55, 'rain'], [61, 'rain', 'light'], [63, 'rain', 'moderate'], [65, 'rain', 'heavy'], [67, 'rain', 'heavy'], [71, 'snow', 'light'], [75, 'snow', 'heavy'], [77, 'snow'], [80, 'rain', 'light'], [82, 'rain', 'heavy'], [85, 'snow'], [86, 'snow', 'heavy'], [95, 'storm'], [96, 'storm', 'heavy'], [99, 'storm', 'heavy'], [1234, 'clear']];
  const bad = table.filter(([c, kind, inten]) => k(c).kind !== kind || (inten && k(c).intensity !== inten));
  check(!bad.length, `WMO weather codes → kind / intensity (${table.length} codes)${bad.length ? ` bad: ${bad.map((b) => b[0])}` : ''}`);
  check(k(95).describe === 'thunderstorm' && k(99).describe === 'hail' && k(2).describe === 'partlyCloudy' && k(56).describe === 'freezingDrizzle', 'weather codes → description keys');
  const fu = wx.forecastUrl({ lat: 48.8566, lon: 2.3522 });
  check(fu === 'https://api.open-meteo.com/v1/forecast?latitude=48.8566&longitude=2.3522&current=weather_code,is_day,temperature_2m&timezone=auto', `forecast URL (${fu})`);
  check(wx.geocodeUrl('Saint-Étienne & co', 'fr', 5) === 'https://geocoding-api.open-meteo.com/v1/search?name=Saint-%C3%89tienne%20%26%20co&count=5&language=fr&format=json' && wx.geocodeUrl('x', 'de').includes('language=en'), 'geocoding URL: encoded query, language en|fr');
  const pf = wx.parseForecast(WX(63, 0, 7.25), { name: 'Paris', lat: 48.85, lon: 2.35 });
  check(pf.kind === 'rain' && pf.intensity === 'moderate' && pf.isDay === false && pf.temperature === 7.3 && pf.location.name === 'Paris' && pf.stale === false, 'parseForecast: conditions object');
  let threw = null;
  try {
    wx.parseForecast({ current: { weather_code: 'x' } }, { lat: 0, lon: 0 });
  } catch (e) {
    threw = e.code;
  }
  check(threw === 'EBADDATA', 'parseForecast refuses malformed data (EBADDATA)');
  const geo = wx.parseGeocoding({ results: [...GEO, { name: '', latitude: 1, longitude: 1 }, { name: 'Evil\u0000<b>', latitude: 999, longitude: 0 }] });
  check(geo.length === 2 && geo[0].countryCode === 'FR' && geo[0].lat === 48.85341, 'parseGeocoding: keeps valid places only');
  check(wx.normPlace({ lat: '48.8566', lon: 2.35, name: 'A\nB' })?.name === 'A B' && wx.normPlace({ lat: 100, lon: 0 }) === null && wx.normPlace(null) === null, 'normPlace validates coordinates and cleans names');
  // cities
  const c1 = cities.searchCities('par', 'fr');
  const c2 = cities.searchCities('montr', 'fr');
  const c3 = cities.searchCities('geneve', 'en');
  check(c1[0]?.name === 'Paris' && c2[0]?.name === 'Montréal' && c3[0]?.name === 'Geneva' && cities.searchCities('z', 'en').length === 0, 'offline cities: prefix, accent-insensitive, localized names');
  check(cities.samePlace(c1[0], { name: 'Paris', lat: 48.85341, lon: 2.3488 }) && cities.samePlace({ name: 'Montreal', lat: 45.5, lon: -73.57 }, c2[0]) && !cities.samePlace(c1[0], { name: 'Paris', lat: 33.66, lon: -95.56 }) && !cities.samePlace(c1[0], { name: 'Lyon', lat: 48.85, lon: 2.35 }), 'samePlace: same town in the built-in and online lists (name + ~25 km), Paris (Texas) kept apart');
  // defaults
  const { DEFAULTS } = require(path.join(ROOT, 'main/ipc/settings.js'));
  check(DEFAULTS.wallpaperMode === 'static' && DEFAULTS.animatedWallpaper.id === 'aurora' && DEFAULTS.animatedWallpaper.fps === 30 && DEFAULTS.animatedWallpaper.pauseOnMaximized === true && DEFAULTS.dynamicWallpaper.followTheme === false && DEFAULTS.slideshow.interval === 30 && DEFAULTS.lockScreen.mode === 'picture', 'DEFAULTS: every B1 key has a default');
  // strings: every wp.* key used by the page exists in English and French
  const i18n = JSON.parse(fs.readFileSync(path.join(ROOT, 'renderer/apps/settings/i18n.json'), 'utf8'));
  const src = fs.readFileSync(path.join(ROOT, 'renderer/apps/settings/pages/personalization-wallpaper.js'), 'utf8');
  const used = new Set([...src.matchAll(/t\('wp\.([A-Za-z0-9_]+)'/g)].map((m) => m[1]));
  for (const m of src.matchAll(/t\(`wp\.([a-z]+)_\$\{/g)) used.add(`${m[1]}_*`);
  const missing = [...used].filter((key) => !key.endsWith('_*') && ['en', 'fr'].some((l) => !(key in i18n[l].wp) && !(`${key}_one` in i18n[l].wp)));
  const dyn_ = [...used].filter((key) => key.endsWith('_*')).every((p) => ['en', 'fr'].every((l) => Object.keys(i18n[l].wp).some((x) => x.startsWith(p.slice(0, -1)))));
  check(!missing.length && dyn_ && Object.keys(i18n.en.wp).sort().join() === Object.keys(i18n.fr.wp).sort().join(), `wp.* strings: ${used.size} keys used, all in English and French${missing.length ? ` (missing ${missing})` : ''}`);
  check(['w_clear', 'w_mainlyClear', 'w_partlyCloudy', 'w_overcast', 'w_fog', 'w_drizzle', 'w_freezingDrizzle', 'w_rain', 'w_freezingRain', 'w_snow', 'w_snowGrains', 'w_showers', 'w_snowShowers', 'w_thunderstorm', 'w_hail'].every((x) => i18n.en.wp[x] && i18n.fr.wp[x]), 'every weather description is translated');
  const wt = await import(R('core/wallpaper/weather-text.js'));
  const fluent = JSON.parse(fs.readFileSync(path.join(ROOT, 'renderer/assets/icons/fluent.json'), 'utf8'));
  const allCodes = [0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99];
  const wtOk = allCodes.every((c) => [true, false].every((isDay) => {
    const w = { ...wx.weatherKind(c), isDay };
    return !!fluent[wt.weatherIconName(w)] && wt.weatherDescribe(w, 'en') !== wt.weatherDescribe(w, 'fr');
  }));
  check(wtOk && Object.keys(wt.WEATHER_TEXT.en).sort().join() === Object.keys(wt.WEATHER_TEXT.fr).sort().join(), 'weather-text: every WMO code has an existing icon (day / night) and an EN + FR description');
  check(wt.weatherIconName({ describe: 'clear', isDay: false }) === 'weather_moon' && wt.weatherIconName({ describe: 'showers', isDay: true }) === 'weather_rain_showers_day' && wt.formatTemperature({ temperature: 12.4, unit: '°C' }) === '12 °C' && wt.formatTemperature({ temperature: -0.3 }) === '0 °C' && wt.formatTemperature({ temperature: null }) === '', 'weather-text: night icons, temperatures (rounded, no "-0", unknown → empty)');
}

// =====================================================================================================================
async function effectsAndEngine() {
  console.log('\n# Effects (render, change over time, fps cap, no per-frame allocations) + desktop engine (dark, en)');
  mock(WX(63));
  const s = await launchShell({ theme: 'dark', lang: 'en', env: ENV, settings: { wallpaperMode: 'animated' } });
  try {
    const A = (fn, a) => s.aurora(fn, a);
    // ---- each effect, light and dark, offscreen
    const res = await A(async () => {
      const { WallpaperRenderer } = await import('app://shell/core/wallpaper/engine.js');
      const { EFFECTS } = await import('app://shell/core/wallpaper/effects/index.js');
      const { EFFECT_IDS } = await import('app://shell/core/wallpaper/dynamic.js');
      const stats = (canvas) => {
        const c = document.createElement('canvas');
        c.width = 160;
        c.height = 90;
        const g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(canvas, 0, 0, 160, 90);
        const d = g.getImageData(0, 0, 160, 90).data;
        let sum = 0;
        let sq = 0;
        for (let i = 0; i < d.length; i += 4) {
          const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
          sum += l;
          sq += l * l;
        }
        const n = d.length / 4;
        return { mean: sum / n, sd: Math.sqrt(Math.max(0, sq / n - (sum / n) ** 2)) };
      };
      const pixels = (canvas) => canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      const out = { ids: EFFECTS.map((e) => e.id), idsMatch: EFFECTS.map((e) => e.id).join() === EFFECT_IDS.join(), fx: {} };
      for (const mode of ['dark', 'light']) {
        for (const e of EFFECTS) {
          const host = document.createElement('div');
          host.style.cssText = 'position:fixed;left:0;top:0;width:480px;height:270px;z-index:-1';
          document.body.append(host);
          const r = new WallpaperRenderer({ host, effect: e, params: { mode, accent: '#0078d4', intensity: 0.6, speed: 1 } });
          r.renderStill(1);
          const a = pixels(r.anim).slice();
          const comp = stats(await new Promise((res) => {
            const c = document.createElement('canvas');
            c.width = 480;
            c.height = 270;
            const g = c.getContext('2d');
            if (r.bg) g.drawImage(r.bg, 0, 0, 480, 270);
            g.drawImage(r.anim, 0, 0, 480, 270);
            if (r.fg) g.drawImage(r.fg, 0, 0, 480, 270);
            res(c);
          }));
          r.renderStill(3.7);
          const b = pixels(r.anim);
          let diff = 0;
          for (let i = 0; i < a.length; i++) diff += Math.abs(a[i] - b[i]);
          // per-frame allocations: gradients / canvases / patterns created while frames run
          const P = CanvasRenderingContext2D.prototype;
          const orig = { lg: P.createLinearGradient, rg: P.createRadialGradient, pat: P.createPattern, ce: document.createElement, id: P.getImageData };
          let allocs = 0;
          P.createLinearGradient = function (...x) {
            allocs++;
            return orig.lg.apply(this, x);
          };
          P.createRadialGradient = function (...x) {
            allocs++;
            return orig.rg.apply(this, x);
          };
          P.createPattern = function (...x) {
            allocs++;
            return orig.pat.apply(this, x);
          };
          document.createElement = function (...x) {
            allocs++;
            return orig.ce.apply(this, x);
          };
          for (let i = 0; i < 30; i++) r.inst.frame(r.g, 5 + i / 30, 1 / 30);
          Object.assign(P, { createLinearGradient: orig.lg, createRadialGradient: orig.rg, createPattern: orig.pat });
          document.createElement = orig.ce;
          out.fx[`${e.id}-${mode}`] = { sd: comp.sd, mean: comp.mean, diff: diff / a.length, allocs, layered: !!(r.bg || r.fg), w: r.anim.width };
          r.destroy();
          host.remove();
        }
      }
      return out;
    });
    check(res.ids.length >= 5 && res.idsMatch, `${res.ids.length} effects registered (${res.ids.join(', ')}); EFFECT_IDS matches`);
    for (const [key, v] of Object.entries(res.fx)) {
      check(v.sd > 4 && v.mean > 3, `${key}: a real picture (luminance mean ${v.mean.toFixed(0)}, spread ${v.sd.toFixed(1)})`);
      check(v.diff > 0.05, `${key}: the frame changes over time (mean diff ${v.diff.toFixed(2)})`);
      check(v.allocs === 0, `${key}: no gradient / canvas / element created in 30 frames (${v.allocs})`);
    }
    check(res.fx['aurora-dark'].layered && res.fx['starfield-dark'].layered && !res.fx['bloom-dark'].layered, 'layered effects draw static full-resolution layers (aurora, night sky)');
    check(res.fx['fluid-dark'].w === 120 || res.fx['fluid-dark'].w === 480, `low-resolution canvas (fluid ${res.fx['fluid-dark'].w}px for a 480px host at small size)`);

    // ---- fps cap
    const fps = await A(async () => {
      const { WallpaperRenderer } = await import('app://shell/core/wallpaper/engine.js');
      const { effectById } = await import('app://shell/core/wallpaper/effects/index.js');
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;left:0;top:0;width:640px;height:360px;z-index:-1';
      document.body.append(host);
      const out = {};
      for (const f of [15, 30]) {
        const r = new WallpaperRenderer({ host, effect: effectById('fluid'), params: { mode: 'dark' }, fps: f });
        r.start();
        await new Promise((res) => setTimeout(res, 300));
        const f0 = r.frames;
        const t0 = performance.now();
        await new Promise((res) => setTimeout(res, 2000));
        out[f] = ((r.frames - f0) * 1000) / (performance.now() - t0);
        r.setPaused('test', true);
        const p0 = r.frames;
        await new Promise((res) => setTimeout(res, 500));
        out[`paused${f}`] = r.frames - p0;
        r.destroy();
      }
      host.remove();
      return out;
    });
    check(fps[15] <= 16.5 && fps[15] >= 5, `fps cap 15: measured ${fps[15].toFixed(1)} fps`);
    check(fps[30] <= 31.5 && fps[30] > fps[15], `fps cap 30: measured ${fps[30].toFixed(1)} fps`);
    check(fps.paused15 === 0 && fps.paused30 === 0, 'a paused renderer draws no frame');

    // ---- desktop engine: animated
    await waitFor(async () => (await state(s)).overrideUrl);
    let st = await state(s);
    const layers = await A(() => [...document.getElementById('desktop').children].map((e) => e.className));
    check(st.mode === 'animated' && st.effect === 'aurora' && st.running && st.fps === 30, `animated wallpaper running (effect ${st.effect}, ${st.fps} fps)`);
    check(layers.indexOf('wallpaper') === 0 && layers[1] === 'wp-engine' && layers.includes('desk-icons') && layers.indexOf('desk-icons') > 1, `engine layer sits between the picture and the icons (${layers.join(' > ')})`);
    const th = await A(() => ({ wp: window.__aurora.theme.wallpaperUrl, ov: window.__aurora.theme.wallpaperOverride, mica: window.__aurora.theme.micaUrl, layer: document.querySelector('#desktop .wallpaper-layer:last-child')?.style.backgroundImage || '' }));
    check(st.overrideUrl.startsWith('blob:') && th.wp === st.overrideUrl && th.ov === st.overrideUrl && th.layer.includes(st.overrideUrl), 'a still frame of the scene is the desktop picture (theme.setWallpaperOverride)');
    await waitFor(async () => (await A(() => window.__aurora.theme.micaUrl)) !== th.mica || th.mica, 3000);
    check(!!(await A(() => window.__aurora.theme.micaUrl)) && (await A(() => getComputedStyle(document.documentElement).getPropertyValue('--mica-image'))).includes('blob:'), 'Mica is derived from the still frame');
    const f0 = await frames(s);
    await sleep(1500);
    const f1 = await frames(s);
    check(f1 - f0 >= 8 && f1 - f0 <= 50, `desktop scene renders frames (${f1 - f0} in 1.5 s, cap 45)`);
    const drawn = await A(() => {
      const c = document.querySelector('#desktop .wp-engine .wp-anim');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let a = 0;
      for (let i = 3; i < d.length; i += 4) a += d[i] > 0 ? 1 : 0;
      return { px: a / (d.length / 4), w: c.width, cw: c.clientWidth };
    });
    check(drawn.px > 0.05 && drawn.w <= Math.ceil(drawn.cw * 0.5) + 1, `the curtains are drawn on a half-resolution canvas (${drawn.w}px for ${drawn.cw}px, ${(drawn.px * 100).toFixed(0)} % covered)`);
    await docShot(s, 'wallpaper-animated-aurora-dark');

    // pause: maximized window
    await A(() => window.__aurora.registry.launch('notepad'));
    await waitFor(() => A(() => window.__aurora.wm.byApp('notepad').length > 0));
    await sleep(500);
    await A(() => window.__aurora.wm.byApp('notepad')[0].maximize());
    await sleep(400);
    st = await state(s);
    let g0 = await frames(s);
    await sleep(1000);
    let g1 = await frames(s);
    check(st.paused.includes('covered') && g1 - g0 <= 1, `paused while a maximized window covers the desktop (${st.paused}, ${g1 - g0} frames in 1 s)`);
    await set(s, 'animatedWallpaper.pauseOnMaximized', false);
    await sleep(400);
    g0 = await frames(s);
    await sleep(800);
    g1 = await frames(s);
    check(!(await state(s)).paused.includes('covered') && g1 - g0 >= 4, `"Pause when apps are maximized" off: keeps running (${g1 - g0} frames)`);
    await set(s, 'animatedWallpaper.pauseOnMaximized', true);
    await sleep(300);
    await A(() => window.__aurora.wm.byApp('notepad')[0].minimize());
    await sleep(500);
    check(!(await state(s)).paused.length && (await state(s)).running, 'resumes when the window is minimized');
    await A(() => {
      const w = window.__aurora.wm.byApp('notepad')[0];
      w.restoreFromMinimize?.({ animate: false });
      w.restore?.();
      w.setFullscreen(true);
    });
    await sleep(400);
    check((await state(s)).paused.includes('covered'), 'paused while a window is full screen');
    // a maximized window on another virtual desktop does not count
    await A(() => {
      const wm = window.__aurora.wm;
      const w = wm.byApp('notepad')[0];
      w.setFullscreen(false);
      w.maximize();
      const d2 = wm.createDesktop();
      wm.moveToDesktop(w, d2.id);
    });
    await sleep(500);
    check(!(await state(s)).paused.includes('covered'), 'a maximized window on another virtual desktop does not pause it');
    await A(() => {
      const wm = window.__aurora.wm;
      wm.byApp('notepad')[0].close(true);
    });
    await sleep(400);

    // pause: locked
    await A(() => window.__aurora.shell.lock());
    await sleep(800);
    st = await state(s);
    g0 = await frames(s);
    await sleep(700);
    g1 = await frames(s);
    const lockInfo = await A(() => ({ wall: document.querySelector('.lockui')?.style.getPropertyValue('--lk-wall-img') || '', scene: document.querySelector('.lockui .lk-wall .wp-lock .wp-scene')?.dataset.effect || null }));
    check(st.paused.includes('locked') && g1 - g0 <= 1, `paused while the session is locked (${st.paused})`);
    check(lockInfo.wall.includes('blob:') && lockInfo.scene === 'aurora', `lock screen "same as desktop" shows the animated scene (${lockInfo.scene}) over its still frame`);
    const lf0 = await A(() => window.__aurora.lockScreen.el.querySelector('.wp-lock canvas.wp-anim') && 1);
    await docShot(s, 'wallpaper-lock-same-as-desktop-animated');
    await A(() => window.__aurora.shell.emit('unlock'));
    await sleep(900);
    check(!(await state(s)).paused.includes('locked') && lf0 === 1 && !(await A(() => !!document.querySelector('.wp-lock'))), 'resumes after unlocking; the lock screen scene is removed');

    // pause: document hidden
    await A(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await sleep(200);
    const hid = (await state(s)).paused.includes('hidden');
    await A(() => {
      delete document.hidden;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await sleep(200);
    check(hid && !(await state(s)).paused.includes('hidden'), 'paused while the shell is hidden');

    // reduced motion: a still frame
    await set(s, 'reducedMotion', true);
    await sleep(600);
    st = await state(s);
    g0 = await frames(s);
    await sleep(700);
    g1 = await frames(s);
    const still = await A(() => {
      const c = document.querySelector('#desktop .wp-engine .wp-anim');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let a = 0;
      for (let i = 3; i < d.length; i += 4) a += d[i] > 0 ? 1 : 0;
      return a;
    });
    check(st.paused.includes('motion') && g1 - g0 === 0 && still > 0 && st.overrideUrl, 'reduced motion: no frames, a still frame stays on screen');
    await set(s, 'reducedMotion', false);
    await sleep(500);
    check((await state(s)).running, 'animations back on: running again');

    // live changes: effect, speed, intensity, fps
    const before = (await state(s)).overrideUrl;
    await set(s, 'animatedWallpaper.id', 'bloom');
    await waitFor(async () => (await state(s)).effect === 'bloom' && (await state(s)).overrideUrl !== before, 4000);
    st = await state(s);
    check(st.effect === 'bloom' && st.overrideUrl !== before && (await A(() => window.__aurora.theme.wallpaperUrl)) === st.overrideUrl, 'changing the effect applies live (new scene + new still frame)');
    await setMany(s, { 'animatedWallpaper.speed': 100, 'animatedWallpaper.intensity': 90, 'animatedWallpaper.fps': 15 });
    await sleep(400);
    const p = await A(() => ({ ...window.__aurora.wallpaperEngine.renderer.params, fps: window.__aurora.wallpaperEngine.renderer.fps }));
    check(p.speed === 2.5 && Math.abs(p.intensity - 0.9) < 1e-6 && p.fps === 15, `speed / intensity / fps apply live (×${p.speed}, ${p.intensity}, ${p.fps} fps)`);
    await setMany(s, { 'animatedWallpaper.speed': 50, 'animatedWallpaper.intensity': 50, 'animatedWallpaper.fps': 30 });
    // the accent recolours accent effects; accent-from-wallpaper does not feed back
    const ov1 = (await state(s)).overrideUrl;
    await set(s, 'accent', '#e3008c');
    await waitFor(async () => (await state(s)).overrideUrl !== ov1, 4000);
    check((await A(() => window.__aurora.wallpaperEngine.renderer.params.accent)) === '#e3008c' && (await state(s)).overrideUrl !== ov1, 'bloom follows the accent colour (new still frame)');
    await set(s, 'accentFromWallpaper', true);
    await sleep(1500);
    check((await A(() => window.__aurora.wallpaperEngine.renderer.params.accent)) === '#0078d4', 'accent from wallpaper: accent-coloured effects use the default blue (no feedback loop)');
    await setMany(s, { accentFromWallpaper: false, accent: '#0078d4' });
    // every effect on the desktop (screenshots)
    for (const id of ['aurora', 'bloom', 'fluid', 'bokeh', 'starfield', 'waves']) {
      await set(s, 'animatedWallpaper.id', id);
      await waitFor(async () => (await state(s)).effect === id);
      await sleep(1300);
      if (id !== 'aurora') await docShot(s, `wallpaper-animated-${id}-dark`);
    }
    await set(s, 'theme', 'light');
    await sleep(1500);
    check((await A(() => window.__aurora.wallpaperEngine.renderer.params.mode)) === 'light', 'light mode: effects switch to their light palette');
    for (const id of ['bloom', 'fluid']) {
      await set(s, 'animatedWallpaper.id', id);
      await sleep(1300);
      await docShot(s, `wallpaper-animated-${id}-light`);
    }
    await set(s, 'theme', 'dark');

    // profiles: save and restore the wallpaper keys
    await setMany(s, { 'animatedWallpaper.id': 'starfield', 'animatedWallpaper.fps': 15, 'lockScreen.mode': 'spotlight' });
    const prof = await A(() => window.__aurora.theme.profiles.saveCurrent('Night sky'));
    await setMany(s, { wallpaperMode: 'static', 'animatedWallpaper.id': 'waves', 'lockScreen.mode': 'picture' });
    await sleep(500);
    check((await state(s)).mode === 'static' && (await A(() => window.__aurora.theme.wallpaperOverride)) === null, 'static mode: no override, the plain picture');
    await A((id) => window.__aurora.theme.profiles.apply(id), prof.id);
    await sleep(1200);
    st = await state(s);
    check(st.mode === 'animated' && st.effect === 'starfield' && (await get(s, 'animatedWallpaper.fps')) === 15 && (await get(s, 'lockScreen.mode')) === 'spotlight', 'a profile saves and restores the wallpaper engine (mode, effect, fps, lock screen)');
    const val = await A(async () => {
      const pr = await import('app://shell/core/profiles.js');
      const v = pr.sanitizeValues({ wallpaperMode: 'evil', animatedWallpaper: { id: 'x' }, dynamicWallpaper: { source: 'weather', set: 'dunes', location: { name: 'P', lat: 999, lon: 0 } }, slideshow: { folder: '/home/u/../../etc', interval: 5 }, lockScreen: { mode: 'spotlight', effect: 'nope' } });
      const ok = pr.sanitizeValues({ wallpaperMode: 'dynamic', animatedWallpaper: { id: 'waves', speed: 300, fps: 60 }, dynamicWallpaper: { source: 'weather', set: 'lake', location: { name: 'P\u0007', lat: 48.8, lon: 2.3 }, followTheme: true }, slideshow: { folder: null, interval: 10, shuffle: false } });
      return { v, ok, keys: pr.PROFILE_KEYS.filter((k) => ['wallpaperMode', 'animatedWallpaper', 'dynamicWallpaper', 'slideshow', 'lockScreen'].includes(k)).length };
    });
    check(val.keys === 5 && !('wallpaperMode' in val.v) && !('animatedWallpaper' in val.v) && !('dynamicWallpaper' in val.v) && !('slideshow' in val.v) && val.v.lockScreen?.effect === 'aurora', 'profile import: invalid wallpaper values are dropped');
    check(val.ok.wallpaperMode === 'dynamic' && val.ok.animatedWallpaper.speed === 50 && val.ok.animatedWallpaper.fps === 30 && val.ok.dynamicWallpaper.location.name === 'P ' && val.ok.slideshow.interval === 10, 'profile import: valid wallpaper values are normalised');

    // ---- slideshow
    const dir = path.join(s.home, 'Pictures', 'Slides');
    fs.mkdirSync(dir, { recursive: true });
    for (const [f, src] of [['b-dunes.jpg', 'dunes.jpg'], ['a-sunrise.jpg', 'sunrise.jpg'], ['c-flow.jpg', 'flow-light.jpg']]) fs.copyFileSync(path.join(ROOT, 'renderer/assets/wallpapers', src), path.join(dir, f));
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a picture');
    await setMany(s, { wallpaperMode: 'slideshow', slideshow: { folder: dir, interval: 1, shuffle: false } });
    await waitFor(async () => (await state(s)).slideshow.count === 3, 4000);
    // the list is known before the first picture is decoded and shown
    await waitFor(async () => /a-sunrise\.jpg/.test(decodeURIComponent(await A(() => window.__aurora.theme.wallpaperUrl))), 5000);
    st = await state(s);
    const u0 = await A(() => window.__aurora.theme.wallpaperUrl);
    check(st.mode === 'slideshow' && st.slideshow.count === 3 && st.slideshow.index === 0 && /a-sunrise\.jpg/.test(decodeURIComponent(u0)), `slideshow: the folder's 3 pictures in name order (first: ${decodeURIComponent(u0).split('/').pop()})`);
    await A(() => window.__aurora.shell.emit('wallpaper:next'));
    await waitFor(async () => /b-dunes\.jpg/.test(decodeURIComponent(await A(() => window.__aurora.theme.wallpaperUrl))), 4000);
    const fade = await A(() => document.querySelectorAll('#desktop .wp-fades .wp-fade').length);
    const nextUrl = decodeURIComponent(await A(() => window.__aurora.theme.wallpaperUrl));
    check((await state(s)).slideshow.index === 1 && /b-dunes\.jpg/.test(nextUrl) && fade === 1, 'next picture with a cross-fade');
    await set(s, 'slideshow.folder', path.join(s.home, 'Pictures', 'Empty'));
    await waitFor(async () => (await state(s)).slideshow.count > 3, 4000);
    check((await state(s)).slideshow.count >= 20, `an empty / missing folder falls back to the built-in pictures (${(await state(s)).slideshow.count})`);
    await set(s, 'slideshow.folder', null);
    await sleep(500);

    // ---- lock screen modes (shell)
    await setMany(s, { wallpaperMode: 'static', wallpaper: 'builtin:bloom', 'lockScreen.mode': 'spotlight' });
    await sleep(500);
    await A(() => window.__aurora.shell.lock());
    await sleep(700);
    const spot = await A(async () => {
      const { spotlightPick } = await import('app://shell/core/wallpaper/dynamic.js');
      return { want: spotlightPick(new Date()).url, got: document.querySelector('.lockui').style.getPropertyValue('--lk-wall-img') };
    });
    check(spot.got.includes(spot.want), `lock screen "picture of the day" (${spot.want.split('/').pop()})`);
    await docShot(s, 'wallpaper-lock-spotlight');
    await A(() => window.__aurora.shell.emit('unlock'));
    await sleep(700);
    await setMany(s, { 'lockScreen.mode': 'animated', 'lockScreen.effect': 'starfield' });
    await sleep(2500); // the still frame is prepared ahead of time
    await A(() => window.__aurora.shell.lock());
    await sleep(1200);
    const la = await A(() => {
      const ls = window.__aurora.lockScreen.el;
      const sc = ls.querySelector('.lk-wall .wp-lock .wp-scene');
      return { effect: sc?.dataset.effect, wall: ls.style.getPropertyValue('--lk-wall-img') };
    });
    check(la.effect === 'starfield' && la.wall.includes('blob:'), `lock screen "animated": the ${la.effect} scene, with a still frame for the blurred sign-in view`);
    await docShot(s, 'wallpaper-lock-animated');
    await s.page.keyboard.press('Space');
    await sleep(900);
    const signin = await A(() => window.__aurora.lockScreen.el.classList.contains('stage-signin'));
    check(signin, 'the lock screen moves to the sign-in view');
    await A(() => window.__aurora.shell.emit('unlock'));
    await sleep(800);
    await setMany(s, { 'lockScreen.mode': 'picture', lockWallpaper: 'builtin:dunes' });
    await A(() => window.__aurora.shell.lock());
    await sleep(600);
    check((await A(() => document.querySelector('.lockui').style.getPropertyValue('--lk-wall-img'))).includes('dunes.jpg'), 'lock screen "picture" keeps using lockWallpaper');
    await A(() => window.__aurora.shell.emit('unlock'));
    await sleep(600);
    await set(s, 'lockWallpaper', null);
    const errs = errorsOf(s);
    check(!errs.length, `no console errors (effects + engine)${errs.length ? `: ${errs.slice(0, 3).join(' | ')}` : ''}`);
  } finally {
    await s.close();
  }
}

// =====================================================================================================================
async function dynamicAndWeather() {
  console.log('\n# Dynamic wallpaper: time of day, theme follows the sun, weather (mocked backend), cache, offline');
  mock({ ...WX(63), geocoding: GEO });
  const s = await launchShell({ theme: 'light', lang: 'en', env: ENV, settings: { wallpaperMode: 'dynamic', dynamicWallpaper: { source: 'time', set: 'dunes', location: PARIS } } });
  try {
    const A = (fn, a) => s.aurora(fn, a);
    const clock = (iso) => A((d) => window.__aurora.wallpaperEngine.setClock(d), iso);
    const expect = [['2026-06-21T02:00:00Z', 'night'], ['2026-06-21T03:30:00Z', 'dawn'], ['2026-06-21T12:00:00Z', 'day'], ['2026-06-21T19:30:00Z', 'dusk'], ['2026-06-21T21:30:00Z', 'night']];
    for (const [iso, ph] of expect) {
      await clock(iso);
      await waitFor(async () => (await A(() => window.__aurora.theme.wallpaperUrl)).endsWith(`dynamic/dunes-${ph}.jpg`), 5000);
      await sleep(300);
      const st = await state(s);
      const wp = await A(() => window.__aurora.theme.wallpaperUrl);
      check(st.dynamic?.phase === ph && wp.endsWith(`dynamic/dunes-${ph}.jpg`) && st.dynamic.source === 'sun', `Paris ${iso.slice(11, 16)} UTC → ${ph} (${wp.split('/').pop()})`);
      if ((ph === 'dawn' || ph === 'dusk') && !NO_SHOTS) {
        // the 4 s cross-fade still shows the previous variant at first: shoot the settled picture
        await waitFor(async () => (await A(() => document.querySelectorAll('#desktop .wp-fades .wp-fade').length)) === 0, 6000);
        await docShot(s, `wallpaper-dynamic-dunes-${ph}`);
      }
    }
    // cross-fade on change
    await clock('2026-06-21T12:00:00Z');
    await sleep(150);
    const fades = await A(() => document.querySelectorAll('#desktop .wp-fades .wp-fade').length);
    check(fades === 1, 'a smooth cross-fade between variants');
    await sleep(4300);
    check((await A(() => document.querySelectorAll('#desktop .wp-fades .wp-fade').length)) === 0, 'the cross-fade layer is removed after 4 s');
    await docShot(s, 'wallpaper-dynamic-dunes-day');
    // the set changes live; Mica follows the variant
    const mica0 = await A(() => window.__aurora.theme.micaUrl);
    await set(s, 'dynamicWallpaper.set', 'lake');
    await waitFor(async () => (await A(() => window.__aurora.theme.wallpaperUrl)).endsWith('lake-day.jpg'), 4000);
    await waitFor(async () => (await A(() => window.__aurora.theme.micaUrl)) !== mica0, 4000);
    check((await A(() => window.__aurora.theme.wallpaperUrl)).endsWith('lake-day.jpg') && (await A(() => window.__aurora.theme.micaUrl)) !== mica0, 'changing the set applies live; Mica follows the picture');
    // fixed hours without a location
    await set(s, 'dynamicWallpaper.location', null);
    for (const [h, ph] of [[6, 'dawn'], [13, 'day'], [18, 'dusk'], [23, 'night']]) {
      await A((hh) => window.__aurora.wallpaperEngine.setClock(new Date(2026, 9, 10, hh, 50)), h);
      await sleep(700);
      const st = await state(s);
      check(st.dynamic.phase === ph && st.dynamic.source === 'fixed', `no location: ${h}:50 → ${ph} (fixed hours)`);
    }
    // the widgets board (weather:current without a place = the dynamic wallpaper's place) asks for a location
    await A(() => window.__aurora.shell.emit('widgets:open'));
    await waitFor(async () => /location/i.test((await A(() => document.querySelector('.wg-weather .btn')?.textContent)) || ''), 4000);
    const wgNo = await A(() => ({ text: document.querySelector('.wg-weather .wg-weather-body')?.innerText, btn: document.querySelector('.wg-weather .btn')?.textContent }));
    check(/Choose a location/.test(wgNo.text || '') && wgNo.btn === 'Choose a location', `widgets board without a place: "${wgNo.text}" + "${wgNo.btn}"`);
    await s.page.click('.wg-weather .btn');
    await s.page.waitForSelector(S('.st-page[data-page="wallpaperEffects"]'), { timeout: 10000 }).catch(() => {});
    await sleep(600);
    const wins = await A(() => window.__aurora.wm.list().map((w) => w.appId));
    check(wins.includes('settings') && !wins.includes('browser') && (await s.page.locator(S('.st-page[data-page="wallpaperEffects"]')).count()) === 1, `"Choose a location" opens Settings > Animated & dynamic wallpapers only (windows: ${wins.join(', ')})`);
    await A(() => window.__aurora.wm.list().forEach((w) => w.close()));
    await sleep(600);
    await set(s, 'dynamicWallpaper.location', PARIS);
    // theme follows the sun
    await setMany(s, { 'dynamicWallpaper.followTheme': true, 'autoTheme.enabled': false });
    await clock('2026-06-21T21:30:00Z');
    await waitFor(async () => (await get(s, 'theme')) === 'dark', 3000);
    check((await get(s, 'theme')) === 'dark', 'theme follows the sun: dark after sunset');
    await clock('2026-06-21T12:00:00Z');
    await waitFor(async () => (await get(s, 'theme')) === 'light', 3000);
    check((await get(s, 'theme')) === 'light', 'theme follows the sun: light in the day');
    await setMany(s, { 'autoTheme.enabled': true, 'autoTheme.light': '07:00', 'autoTheme.dark': '19:00' });
    await clock('2026-06-21T21:30:00Z');
    await sleep(1200);
    const th = await get(s, 'theme');
    const want = (await A(() => import('app://shell/core/theme.js').then((m) => m.autoThemeAt(window.__aurora.settings.get('autoTheme')))));
    check(th === want, `Auto mode (Colors) wins over the sun when both are on (theme ${th})`);
    await setMany(s, { 'autoTheme.enabled': false, 'dynamicWallpaper.followTheme': false, theme: 'light' });
    await clock('2026-06-21T12:00:00Z');

    // ---- weather (mock: rain)
    const stats0 = (await inv(s, 'weather:stats')).v;
    check(stats0.mock === true, 'weather backend runs on the mock (no network in tests)');
    await set(s, 'dynamicWallpaper.source', 'weather');
    await waitFor(async () => (await state(s)).weatherFx?.kind === 'rain', 5000);
    let st = await state(s);
    const tint = await A(() => getComputedStyle(document.querySelector('#desktop .wp-tint')).backgroundImage);
    check(st.weather?.kind === 'rain' && st.weather.describe === 'rain' && st.weather.temperature === 12.4 && st.weatherFx?.running, `weather "rain" on the time-of-day picture (${st.weather?.describe}, ${st.weather?.temperature} °C)`);
    check(/gradient/.test(tint), 'rain: a colour wash over the picture');
    const wf0 = st.weatherFx.frames;
    await sleep(800);
    check((await state(s)).weatherFx.frames > wf0, 'rain particles are animated');
    await docShot(s, 'wallpaper-weather-rain');
    const urls = (await inv(s, 'weather:stats')).v.urls;
    check(urls.some((u) => u.startsWith('https://api.open-meteo.com/v1/forecast?latitude=48.8566&longitude=2.3522&current=weather_code,is_day,temperature_2m')), 'the Open-Meteo forecast URL is requested for the location');
    // cache: a second request within the TTL is served from memory (the test TTL is 2.5 s, so warm the cache first:
    // the screenshot above may take longer than that on a loaded machine)
    await inv(s, 'weather:current', PARIS);
    const s1 = (await inv(s, 'weather:stats')).v;
    const again = (await inv(s, 'weather:current', PARIS)).v;
    const s2 = (await inv(s, 'weather:stats')).v;
    check(again.kind === 'rain' && s2.requests === s1.requests && s2.cacheHits === s1.cacheHits + 1, 'cached: no new request within the cache time');
    const cacheFile = path.join(s.home, '.cache', 'aurora', 'weather.json');
    await waitFor(() => fs.existsSync(cacheFile), 2000);
    check(fs.existsSync(cacheFile) && JSON.parse(fs.readFileSync(cacheFile, 'utf8')).entries?.[0]?.code === 63, 'conditions persisted to ~/.cache/aurora/weather.json (offline after a restart)');
    // the widgets board reuses weather:current (same place)
    await A(() => window.__aurora.shell.emit('widgets:open'));
    await waitFor(async () => !!(await A(() => document.querySelector('.wg-weather .wg-weather-temp')?.textContent)), 4000);
    const wg = await A(() => ({ temp: document.querySelector('.wg-weather .wg-weather-temp')?.textContent, text: document.querySelector('.wg-weather .wg-weather-now')?.innerText, icon: document.querySelector('.wg-weather .wg-weather-art [data-icon]')?.dataset.icon, kind: document.querySelector('.wg-weather')?.dataset.kind }));
    check(/^12\s°C$/.test(wg.temp || '') && /Rain/.test(wg.text || '') && /Paris/.test(wg.text || '') && wg.icon === 'weather_rain' && wg.kind === 'rain', `widgets board: live weather card (${wg.temp}, ${(wg.text || '').replace(/\n/g, ' / ')}, ${wg.icon})`);
    await docShot(s, 'wallpaper-widgets-weather');
    await A(() => window.__aurora.shell.emit('widgets:close'));
    await sleep(400);
    // an event for other consumers (widgets, Weather app)
    await A(() => {
      window.__wxEvents = [];
      window.__aurora.api.on('weather:changed', (w) => window.__wxEvents.push(w.kind));
    });
    // each weather kind (new places, so no cache)
    const kinds = [[73, 'snow', 'Lyon', 45.764, 4.8357], [95, 'storm', 'Lille', 50.6292, 3.0573], [45, 'fog', 'Nantes', 47.2184, -1.5536], [3, 'clouds', 'Brest', 48.39, -4.49], [0, 'clear', 'Nice', 43.7102, 7.262]];
    for (const [code, kind, name, lat, lon] of kinds) {
      mock({ ...WX(code), geocoding: GEO });
      await set(s, 'dynamicWallpaper.location', { name, lat, lon });
      await waitFor(async () => (await state(s)).weather?.kind === kind, 5000);
      await sleep(900);
      st = await state(s);
      const tk = await A(() => document.querySelector('#desktop .wp-tint').dataset.kind || '');
      if (kind === 'clear') check(st.weather?.kind === 'clear' && !st.weatherFx && !tk, 'clear sky: no overlay at all');
      else {
        check(st.weather?.kind === kind && st.weatherFx?.kind === kind && st.weatherFx.running && tk === kind, `weather "${kind}" → animated overlay + tint`);
        await docShot(s, `wallpaper-weather-${kind}`);
      }
    }
    check((await A(() => window.__wxEvents.join())) === 'snow,storm,fog,clouds,clear', `"weather:changed" broadcast for every fresh fetch (${await A(() => window.__wxEvents.join())})`);
    // reduced motion: static tint only
    mock({ ...WX(63), geocoding: GEO });
    await set(s, 'dynamicWallpaper.location', { name: 'Rennes', lat: 48.1173, lon: -1.6778 });
    await waitFor(async () => (await state(s)).weather?.kind === 'rain', 5000);
    await set(s, 'reducedMotion', true);
    await sleep(700);
    st = await state(s);
    const rm = await A(() => ({ hidden: !!document.querySelector('#desktop .wp-overlay .wp-scene')?.hidden, tint: document.querySelector('#desktop .wp-tint').style.background }));
    check(rm.hidden && /gradient/.test(rm.tint) && st.weatherFx.paused.includes('motion'), 'reduced motion: weather is a static tint (no particles)');
    await set(s, 'reducedMotion', false);
    await sleep(400);
    // stale after the cache time + offline → last known conditions
    await sleep(2700); // AURORA_WEATHER_TTL = 2.5 s in this test
    mock({ offline: true });
    const stale = await inv(s, 'weather:current', { name: 'Rennes', lat: 48.1173, lon: -1.6778 });
    check(stale.v?.stale === true && stale.v.kind === 'rain' && stale.v.error === 'EOFFLINE', 'offline: the last known conditions, marked stale');
    const none = await inv(s, 'weather:current', { name: 'Quimper', lat: 47.99, lon: -4.1 });
    check(none.err === 'EOFFLINE', `offline without a cache: EOFFLINE (${none.err})`);
    await set(s, 'dynamicWallpaper.location', { name: 'Quimper', lat: 47.99, lon: -4.1 });
    await waitFor(async () => (await state(s)).weatherError === 'EOFFLINE', 4000);
    st = await state(s);
    check(st.weatherError === 'EOFFLINE' && !st.weather && !st.weatherFx && st.dynamic.url.endsWith('lake-day.jpg'), 'offline: the wallpaper falls back to the time of day only (no other place\'s weather)');
    // timeout
    mock({ ...WX(61), delayMs: 4000 });
    const t0 = Date.now();
    const slow = await inv(s, 'weather:current', { name: 'Brest2', lat: 48.4, lon: -4.5 });
    check(slow.err === 'ETIMEDOUT' && Date.now() - t0 < 3500, `a slow answer times out (${slow.err} after ${Date.now() - t0} ms)`);
    // search
    mock({ ...WX(0), geocoding: GEO });
    const found = (await inv(s, 'weather:search', 'Paris', { lang: 'fr', count: 5 })).v;
    const lastUrl = (await inv(s, 'weather:stats')).v.lastUrl;
    check(found?.length === 2 && found[0].countryCode === 'FR' && lastUrl.includes('language=fr') && lastUrl.includes('name=Paris'), 'weather:search: geocoding results (language fr)');
    check(((await inv(s, 'weather:search', 'P')).v || []).length === 0 && (await inv(s, 'weather:search', 'Par\u0000is\n')).v?.length === 2, 'weather:search: short queries ignored, control characters stripped');
    mock({ offline: true });
    check((await inv(s, 'weather:search', 'Toulouse')).err === 'EOFFLINE', 'weather:search offline: EOFFLINE (Settings falls back to the built-in cities)');
    await set(s, 'dynamicWallpaper.source', 'time');
    await sleep(400);
    check(!(await state(s)).weatherFx && !(await state(s)).weather, 'source "time of day": no weather overlay');
    const errs = errorsOf(s);
    check(!errs.length, `no console errors (dynamic + weather)${errs.length ? `: ${errs.slice(0, 3).join(' | ')}` : ''}`);
  } finally {
    await s.close();
  }
}

// =====================================================================================================================
async function settingsUi({ theme, lang, size = '1600x900', shots = true }) {
  console.log(`\n# Settings pages (${theme}, ${lang}, ${size})`);
  mock({ ...WX(61), geocoding: GEO });
  const s = await launchShell({ theme, lang, size, env: ENV, settings: { wallpaperMode: 'static' } });
  const fr = lang === 'fr';
  const L = (en, frs) => (fr ? frs : en);
  try {
    const A = (fn, a) => s.aurora(fn, a);
    await go(s, 'background');
    await A(() => {
      const w = window.__aurora.wm.byApp('settings')[0];
      w.focus();
      if (w.state !== 'maximized') w.maximize();
    });
    await sleep(800);
    // kind combo with five choices
    const row = await rowOf(s, L('Personalize your background', 'Personnaliser votre arrière-plan'));
    await row.locator('.st-combo').click();
    const opts = await s.page.locator('.menu .menu-item').allInnerTexts();
    await s.page.keyboard.press('Escape');
    const want = L(['Picture', 'Solid color', 'Slideshow', 'Animated', 'Dynamic (time of day)'], ['Image', 'Couleur unie', 'Diaporama', 'Animé', 'Dynamique (heure du jour)']);
    check(want.every((w) => opts.some((o) => o.trim() === w)), `Background: Picture / Solid color / Slideshow / Animated / Dynamic (${opts.map((o) => o.trim()).join(', ')})`);
    // Animated
    await pickCombo(s, L('Personalize your background', 'Personnaliser votre arrière-plan'), L('Animated', 'Animé'));
    await s.page.waitForSelector(S('.wp-gallery .wp-card'), { timeout: 5000 });
    check((await get(s, 'wallpaperMode')) === 'animated' && (await s.page.locator(S('.wp-gallery .wp-card')).count()) === 6, 'Background → Animated: wallpaperMode animated + gallery of 6 effects');
    await sleep(1500);
    const minis = await A(() => [...document.querySelectorAll('.app-settings .wp-gallery .wp-card .wp-mini canvas.wp-anim')].length);
    check(minis >= 3, `live mini previews in the gallery (${minis} running scenes)`);
    const mf = await A(async () => {
      const a = [...document.querySelectorAll('.app-settings .wp-gallery .wp-card .wp-mini canvas.wp-anim')].map((c) => c.getContext('2d').getImageData(0, 0, c.width, c.height).data.slice(0, 4000).join());
      await new Promise((r) => setTimeout(r, 900));
      const b = [...document.querySelectorAll('.app-settings .wp-gallery .wp-card .wp-mini canvas.wp-anim')].map((c) => c.getContext('2d').getImageData(0, 0, c.width, c.height).data.slice(0, 4000).join());
      return a.filter((x, i) => x !== b[i]).length;
    });
    check(mf >= 1 || (await A(() => document.documentElement.dataset.animations === 'off')), `mini previews move (${mf} changed)`);
    const bloomName = L('Bloom', 'Floraison');
    await s.page.locator(S(`.wp-gallery .wp-card[aria-label="${bloomName}"]`)).click();
    await sleep(500);
    check((await get(s, 'animatedWallpaper.id')) === 'bloom' && (await A(() => window.__aurora.wallpaperEngine.state.effect)) === 'bloom' && (await s.page.locator(S('.wp-card[data-effect="bloom"][aria-checked="true"]')).count()) === 1, 'clicking an effect card applies it to the desktop');
    // keyboard: arrows move in the gallery
    await s.page.locator(S('.wp-card[data-effect="bloom"]')).focus();
    await s.page.keyboard.press('ArrowRight');
    await sleep(400);
    check((await get(s, 'animatedWallpaper.id')) === 'fluid', 'arrow keys move between effects (radio group)');
    // sliders, fps, pause toggle
    const speed = s.page.locator(S('[data-section="speed"] .slider, [data-section="speed"] input[type=range]')).first();
    await speed.focus();
    await s.page.keyboard.press('End');
    await sleep(500);
    check((await get(s, 'animatedWallpaper.speed')) === 100, `speed slider (keyboard End → ${await get(s, 'animatedWallpaper.speed')})`);
    await s.page.keyboard.press('Home');
    await sleep(400);
    await pickCombo(s, L('Frame rate', 'Fréquence d’images'), L('15 frames per second', '15 images par seconde'));
    check((await get(s, 'animatedWallpaper.fps')) === 15 && (await A(() => window.__aurora.wallpaperEngine.renderer?.fps)) === 15, 'frame rate 15 fps applies live');
    await (await rowOf(s, L('Pause when apps are maximized', 'Mettre en pause quand une application est agrandie'))).locator('.toggle input').click();
    await sleep(300);
    check((await get(s, 'animatedWallpaper.pauseOnMaximized')) === false, '"Pause when apps are maximized" toggle');
    await (await rowOf(s, L('Pause when apps are maximized', 'Mettre en pause quand une application est agrandie'))).locator('.toggle input').click();
    await setMany(s, { 'animatedWallpaper.id': 'aurora', 'animatedWallpaper.fps': 30, 'animatedWallpaper.speed': 50 });
    await sleep(800);
    const status = await s.page.locator(S('.wp-hero-status')).innerText();
    check(status.includes(L('paused', 'en pause')) && status.includes(L('an app fills the screen', 'une application occupe l’écran')), `hero status explains the pause ("${status}")`);
    // reduced motion note
    await set(s, 'reducedMotion', true);
    await sleep(500);
    const noteShown = await s.page.locator(S('.wp-motion-note:not([hidden])')).count();
    await set(s, 'reducedMotion', false);
    await sleep(300);
    check(noteShown === 1 && (await s.page.locator(S('.wp-motion-note:not([hidden])')).count()) === 0, 'reduced motion: a note explains the still frame');
    if (shots) await docShot(s, `wallpaper-settings-background-animated-${theme}-${lang}`);
    // Dynamic
    await pickCombo(s, L('Personalize your background', 'Personnaliser votre arrière-plan'), L('Dynamic', 'Dynamique'));
    await s.page.waitForSelector(S('.wp-sets .wp-set'), { timeout: 5000 });
    check((await get(s, 'wallpaperMode')) === 'dynamic' && (await s.page.locator(S('.wp-sets .wp-set')).count()) === 3, 'Background → Dynamic: 3 picture sets');
    await s.page.locator(S('.wp-set[data-set="dunes"]')).click();
    // the engine decodes the 2560×1600 variant before showing it: wait for it rather than a fixed delay
    await waitFor(async () => (await A(() => window.__aurora.theme.wallpaperUrl)).includes('dynamic/dunes-'), 5000);
    check((await get(s, 'dynamicWallpaper.set')) === 'dunes' && (await A(() => window.__aurora.theme.wallpaperUrl)).includes('dynamic/dunes-'), 'clicking a set applies it');
    // source: time + weather
    await s.page.locator(S('.wp-source button'), { hasText: L('Time of day and weather', 'L’heure du jour et la météo') }).click();
    await sleep(400);
    check((await get(s, 'dynamicWallpaper.source')) === 'weather', 'source: time of day and weather');
    const noLoc = await s.page.locator(S('[data-section="weather"] .st-row-desc')).innerText();
    check(noLoc.includes(L('Set a location', 'Définissez un lieu')), `weather needs a location ("${noLoc}")`);
    // location dialog: offline + online results, choose Paris
    await (await rowOf(s, L('Location', 'Lieu'))).locator('.btn').click();
    await s.page.waitForSelector('.wp-loc-dialog input[type=search]');
    if (shots) await docShot(s, `wallpaper-settings-location-empty-${theme}-${lang}`);
    await s.page.locator('.wp-loc-dialog input[type=search]').fill('Par');
    await s.page.waitForSelector('.wp-loc-item', { timeout: 4000 });
    await sleep(700);
    const items = await s.page.locator('.wp-loc-item').allInnerTexts();
    check(items.length >= 2 && items.some((x) => /Texas/.test(x)) && items[0].includes('Paris'), `location search: online (mock) + built-in results (${items.length})`);
    check(items.filter((x) => /Paris/.test(x) && /France/.test(x)).length === 1, `location search: the built-in Paris merges with the online one (${items.map((x) => x.replace(/\s+/g, ' ')).join(' | ')})`);
    const dlgFit = await s.aurora(() => {
      const b = document.querySelector('.wp-loc-dlg .dialog-body');
      const d = document.querySelector('.wp-loc-dlg').getBoundingClientRect();
      const out = [...b.querySelectorAll('input, button')].filter((el) => el.getBoundingClientRect().right > d.right - 8).length;
      return { sw: b.scrollWidth, cw: b.clientWidth, out };
    });
    check(dlgFit.sw <= dlgFit.cw && dlgFit.out === 0, `location dialog: no horizontal overflow (scroll ${dlgFit.sw} / ${dlgFit.cw}, ${dlgFit.out} controls past the edge)`);
    if (shots) await docShot(s, `wallpaper-settings-location-${theme}-${lang}`);
    await s.page.locator('.wp-loc-item').first().click();
    await sleep(800);
    const loc = await get(s, 'dynamicWallpaper.location');
    check(loc?.name === 'Paris' && Math.abs(loc.lat - 48.8534) < 0.01, `location saved (${JSON.stringify(loc)})`);
    await waitFor(async () => /12|11|13/.test(await s.page.locator(S('[data-section="weather"] .st-row-desc')).innerText()), 5000);
    const wxText = await s.page.locator(S('[data-section="weather"] .st-row-desc')).innerText();
    check(wxText.includes(L('Rain', 'Pluie')) && wxText.includes('°C') && wxText.includes('Paris'), `current weather shown ("${wxText}")`);
    const sun = await s.page.locator(S('[data-section="sun"] .st-row-desc')).innerText();
    check(sun.includes(L('Sunrise', 'Lever')) && sun.includes(L('Now:', 'Maintenant')), `today's sun times and phase ("${sun}")`);
    // manual coordinates: invalid then valid
    await (await rowOf(s, L('Location', 'Lieu'))).locator('.btn').click();
    await s.page.waitForSelector('.wp-loc-dialog');
    const coords = s.page.locator('.wp-loc-grid input');
    await coords.nth(0).fill('123');
    await coords.nth(1).fill('2');
    await s.page.locator('.wp-use-coords').click();
    await sleep(300);
    check(await s.page.locator('.wp-loc-err').isVisible(), 'invalid coordinates are refused with a message');
    await coords.nth(0).fill('45,75');
    await coords.nth(1).fill('4.85');
    await coords.nth(2).fill('Chez moi');
    await s.page.locator('.wp-use-coords').click();
    await sleep(600);
    const loc2 = await get(s, 'dynamicWallpaper.location');
    check(loc2?.name === 'Chez moi' && loc2.lat === 45.75 && loc2.lon === 4.85, `manual coordinates (decimal comma accepted): ${JSON.stringify(loc2)}`);
    // offline search falls back to the built-in cities
    mock({ offline: true });
    await (await rowOf(s, L('Location', 'Lieu'))).locator('.btn').click();
    await s.page.waitForSelector('.wp-loc-dialog');
    await s.page.locator('.wp-loc-dialog input[type=search]').fill('Montr');
    await sleep(1000);
    const off = await s.page.locator('.wp-loc-item').allInnerTexts();
    const msg = await s.page.locator('.wp-loc-msg').innerText();
    check(off.some((x) => x.includes(L('Montreal', 'Montréal'))) && msg.includes(L('Offline', 'Hors connexion')), `offline: built-in cities ("${msg}")`);
    // clear location
    await s.page.locator('.wp-loc-dlg .dialog-footer .btn', { hasText: L('Clear location', 'Effacer le lieu') }).click();
    await sleep(500);
    check((await get(s, 'dynamicWallpaper.location')) === null, 'clear location');
    mock({ ...WX(61), geocoding: GEO });
    await set(s, 'dynamicWallpaper.location', PARIS);
    // theme follows the sun (turns the fixed-hours Auto off)
    await set(s, 'autoTheme.enabled', true);
    await sleep(300);
    await (await rowOf(s, L('Light and dark mode follow the sun', 'Les modes clair et sombre suivent le soleil'))).locator('.toggle input').click();
    await sleep(500);
    check((await get(s, 'dynamicWallpaper.followTheme')) === true && (await get(s, 'autoTheme.enabled')) === false, 'theme follows the sun (and the fixed-hours Auto mode is turned off)');
    await setMany(s, { 'dynamicWallpaper.followTheme': false, theme });
    await sleep(600);
    if (shots) await docShot(s, `wallpaper-settings-background-dynamic-${theme}-${lang}`);
    // Slideshow
    await pickCombo(s, L('Personalize your background', 'Personnaliser votre arrière-plan'), L('Slideshow', 'Diaporama'));
    await sleep(800);
    check((await get(s, 'wallpaperMode')) === 'slideshow' && (await s.page.locator(S('[data-section="slideshow"]')).count()) === 1, 'Background → Slideshow');
    await pickCombo(s, L('Change picture every', 'Changer d’image toutes les'), L('1 hour', '1 heure'));
    check((await get(s, 'slideshow.interval')) === 60, 'slideshow interval');
    await (await rowOf(s, L('Shuffle the picture order', 'Lire les images dans un ordre aléatoire'))).locator('.toggle input').click();
    await sleep(300);
    check((await get(s, 'slideshow.shuffle')) === false, 'slideshow shuffle toggle');
    const i0 = (await state(s)).slideshow.index;
    await (await rowOf(s, L('Next picture', 'Image suivante'))).locator('.btn').click();
    await waitFor(async () => (await state(s)).slideshow.index !== i0, 4000);
    check((await state(s)).slideshow.index === i0 + 1, '"Next picture" button');
    const dir = path.join(s.home, 'Pictures', 'Album');
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'renderer/assets/wallpapers/dunes.jpg'), path.join(dir, 'one.jpg'));
    fs.copyFileSync(path.join(ROOT, 'renderer/assets/wallpapers/glow-dark.jpg'), path.join(dir, 'two.jpg'));
    await (await rowOf(s, L('Picture album for your slideshow', 'Album d’images pour votre diaporama'))).locator('.btn', { hasText: L('Browse', 'Parcourir') }).click();
    await s.page.waitForSelector('.fp-dialog');
    await s.page.locator('.fp-dialog .fp-row', { hasText: 'Album' }).first().dblclick().catch(() => {});
    await sleep(600);
    await s.page.locator('.fp-dialog .dialog-footer .btn.primary').click();
    await sleep(900);
    const folder = await get(s, 'slideshow.folder');
    check(folder === dir || folder === path.join(s.home, 'Pictures'), `slideshow folder picked with the folder dialog (${folder})`);
    await set(s, 'slideshow.folder', dir);
    await sleep(900);
    const cnt = await s.page.locator(S('[data-section="slideshow"] .st-row-desc')).innerText();
    check(cnt.includes(L('2 pictures', '2 images')), `slideshow shows the album and its picture count ("${cnt}")`);
    // Picture / Solid still work (picture tiles, solid swatches)
    await pickCombo(s, L('Personalize your background', 'Personnaliser votre arrière-plan'), L('Picture', 'Image'));
    await sleep(600);
    await s.page.locator(S('.st-wall[aria-label="Flow"], .st-wall[aria-label="Flux"]')).first().click();
    await sleep(400);
    check((await get(s, 'wallpaperMode')) === 'static' && (await get(s, 'wallpaper')) === 'builtin:flow', 'Background → Picture: a static picture');
    await pickCombo(s, L('Personalize your background', 'Personnaliser votre arrière-plan'), L('Solid color', 'Couleur unie'));
    await s.page.locator(S('.st-solid-grid .st-swatch')).nth(3).click();
    await sleep(400);
    check(String(await get(s, 'wallpaper')).startsWith('data:image/svg+xml') && (await get(s, 'wallpaperMode')) === 'static', 'Background → Solid color');
    await setMany(s, { wallpaper: 'builtin:bloom', wallpaperMode: 'static' });

    // ---- Animated & dynamic wallpapers page
    await go(s, 'wallpaperEffects');
    await sleep(700);
    check((await s.page.locator(S('.wp-gallery.wp-inactive')).count()) === 1, 'effects page: the chosen effect is shown as inactive while the desktop is static');
    await s.page.locator(S('.wp-gallery .wp-card[data-effect="waves"]')).click();
    await sleep(600);
    check((await get(s, 'wallpaperMode')) === 'animated' && (await get(s, 'animatedWallpaper.id')) === 'waves' && (await s.page.locator(S('.wp-gallery.wp-inactive')).count()) === 0, 'effects page: picking an effect switches the desktop to it');
    if (shots) await docShot(s, `wallpaper-settings-effects-${theme}-${lang}`);
    await s.page.locator(S('.wp-sets .wp-set[data-set="lake"]')).click();
    await sleep(600);
    check((await get(s, 'wallpaperMode')) === 'dynamic' && (await get(s, 'dynamicWallpaper.set')) === 'lake', 'effects page: picking a set switches to the dynamic wallpaper');
    // preview a weather (preview only)
    await set(s, 'dynamicWallpaper.source', 'weather');
    await sleep(600);
    await s.page.locator(S('.wp-try button'), { hasText: L('Snow', 'Neige') }).click();
    await sleep(800);
    const prev = await A(() => ({ kind: document.querySelector('.app-settings .wp-hero-tint').dataset.kind, desk: window.__aurora.wallpaperEngine.state.weather?.kind }));
    check(prev.kind === 'snow' && prev.desk === 'rain', `"Preview a weather" changes the preview only (preview ${prev.kind}, desktop ${prev.desk})`);
    await s.page.locator(S('[data-section="tryWeather"]')).scrollIntoViewIfNeeded();
    await A(() => document.querySelector('.app-settings .st-scroll').scrollTo(0, 0));
    await sleep(500);
    if (shots) await docShot(s, `wallpaper-settings-effects-weather-preview-${theme}-${lang}`);
    await s.page.locator(S('.wp-try button'), { hasText: L('Live', 'En direct') }).click();
    // no overflow, no raw keys
    for (const page of ['background', 'wallpaperEffects', 'lockscreen']) {
      await go(s, page);
      const ov = await A(() => {
        const sc = document.querySelector('.app-settings .st-scroll');
        const text = document.querySelector('.app-settings .st-content').innerText;
        const wide = [...document.querySelectorAll('.app-settings .st-content *')].filter((e) => e.getBoundingClientRect().right > sc.getBoundingClientRect().right + 1 && e.offsetParent).length;
        return { x: sc.scrollWidth - sc.clientWidth, raw: /\bwp\.[a-zA-Z_]+/.test(text), wide };
      });
      check(ov.x <= 1 && !ov.raw && ov.wide === 0, `${page}: no horizontal overflow, no untranslated keys (${size})`);
    }
    // ---- Lock screen page
    await go(s, 'lockscreen');
    const lockRow = L('Personalize your lock screen', 'Personnaliser l’écran de verrouillage');
    await pickCombo(s, lockRow, L('Picture of the day', 'Image du jour'));
    await sleep(600);
    check((await get(s, 'lockScreen.mode')) === 'spotlight' && (await s.page.locator(S('.wp-spot-strip .wp-spot')).count()) === 4, 'Lock screen → Picture of the day (today + 4 coming days)');
    if (shots) await docShot(s, `wallpaper-settings-lock-spotlight-${theme}-${lang}`);
    await pickCombo(s, lockRow, L('Animated', 'Animé'));
    await s.page.waitForSelector(S('[data-section="lockEffect"] .wp-card'));
    await s.page.locator(S(`[data-section="lockEffect"] .wp-card[data-effect="starfield"]`)).click();
    await sleep(500);
    check((await get(s, 'lockScreen.mode')) === 'animated' && (await get(s, 'lockScreen.effect')) === 'starfield', 'Lock screen → Animated: effect gallery bound to lockScreen.effect');
    await sleep(800);
    check((await s.page.locator(S('.wp-lock-pv .wp-mini[data-effect="starfield"]')).count()) === 1, 'the lock preview shows the animated scene');
    if (shots) await docShot(s, `wallpaper-settings-lock-animated-${theme}-${lang}`);
    await pickCombo(s, lockRow, L('Picture', 'Image'));
    await s.page.waitForSelector(S('.st-wall[aria-label="Dunes"]'));
    await s.page.locator(S('.st-wall[aria-label="Dunes"]')).click();
    await sleep(400);
    check((await get(s, 'lockScreen.mode')) === 'picture' && (await get(s, 'lockWallpaper')) === 'builtin:dunes', 'Lock screen → Picture: the picture grid');
    await set(s, 'lockWallpaper', null);
    // search
    const found = await A((q) => import('app://shell/apps/settings/lib/index.js').then((m) => m.searchIndex(q[0], q[1]).map((e) => `${e.page}/${e.section}`)), [L('weather', 'météo'), lang]);
    check(found.includes('wallpaperEffects/weather'), `"Find a setting" finds the weather wallpaper (${found.slice(0, 3)})`);
    const errs = errorsOf(s);
    check(!errs.length, `no console errors (Settings ${theme} ${lang})${errs.length ? `: ${errs.slice(0, 3).join(' | ')}` : ''}`);
  } finally {
    await s.close();
  }
}

// =====================================================================================================================
async function sizes() {
  for (const [size, theme, lang] of [['1280x720', 'dark', 'fr'], ['1920x1080', 'light', 'en']]) {
    console.log(`\n# Layout ${size} (${theme}, ${lang})`);
    const s = await launchShell({ theme, lang, size, env: ENV, settings: { wallpaperMode: 'animated', animatedWallpaper: { id: 'bloom' } } });
    try {
      const A = (fn, a) => s.aurora(fn, a);
      await go(s, 'wallpaperEffects');
      await A(() => {
        const w = window.__aurora.wm.byApp('settings')[0];
        if (w.state !== 'maximized') w.maximize();
      });
      await sleep(1200);
      for (const page of ['background', 'wallpaperEffects', 'lockscreen']) {
        await go(s, page);
        const ov = await A(() => {
          const sc = document.querySelector('.app-settings .st-scroll');
          return { x: sc.scrollWidth - sc.clientWidth, cards: getComputedStyle(document.querySelector('.app-settings .wp-gallery') || document.body).gridTemplateColumns.split(' ').length };
        });
        check(ov.x <= 1, `${page} at ${size}: no horizontal overflow`);
      }
      await go(s, 'wallpaperEffects');
      await sleep(600);
      await docShot(s, `wallpaper-settings-effects-${size}-${theme}-${lang}`);
      // desktop scene fills the screen at this size
      await A(() => window.__aurora.wm.byApp('settings')[0].minimize());
      await sleep(1200);
      const dims = await A(() => {
        const c = document.querySelector('#desktop .wp-engine .wp-anim');
        return { cw: c.clientWidth, ch: c.clientHeight, w: innerWidth, h: innerHeight };
      });
      check(dims.cw === dims.w && dims.ch === dims.h, `the scene covers the whole screen (${dims.cw}×${dims.ch})`);
      await docShot(s, `wallpaper-animated-bloom-${size}-${theme}`);
      const errs = errorsOf(s);
      check(!errs.length, `no console errors (${size})`);
    } finally {
      await s.close();
    }
  }
}

// =====================================================================================================================
async function restartAndGreeter() {
  console.log('\n# Persistence across a restart + sign-in screen (greeter)');
  mock({ ...WX(71), geocoding: GEO });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-wp-home-'));
  const s1 = await launchShell({ home, theme: 'dark', env: ENV, settings: {} });
  await setMany(s1, { wallpaperMode: 'dynamic', dynamicWallpaper: { source: 'weather', set: 'bloom', location: PARIS, followTheme: false }, 'animatedWallpaper.id': 'bokeh', 'lockScreen.mode': 'animated', 'lockScreen.effect': 'aurora' });
  await sleep(1200);
  await s1.close();
  const s2 = await launchShell({ home, env: ENV });
  try {
    await waitFor(async () => (await state(s2)).weather?.kind === 'snow', 6000);
    const st = await state(s2);
    check(st.mode === 'dynamic' && st.dynamic?.set === 'bloom' && st.weather?.kind === 'snow' && (await get(s2, 'animatedWallpaper.id')) === 'bokeh' && (await get(s2, 'lockScreen.mode')) === 'animated', 'wallpaper settings are restored at boot (dynamic + weather, effect, lock screen)');
    await s2.aurora(() => window.__aurora.wallpaperEngine.setClock(new Date('2026-10-10T20:30:00')));
    await sleep(1200);
    await docShot(s2, 'wallpaper-weather-snow-night');
    check(!errorsOf(s2).length, 'restart: no console errors');
  } finally {
    await s2.close();
  }
  // sign-in screen: animated and picture-of-the-day lock modes (it reads the settings available before login)
  const g = await launchShell({ home, mode: 'greeter' });
  try {
    await g.page.waitForSelector('.lockui', { timeout: 15000 });
    await sleep(2500);
    const r = await g.page.evaluate(() => ({ scene: document.querySelector('.lockui .lk-wall .wp-lock .wp-scene')?.dataset.effect || null, wall: document.querySelector('.lockui').style.getPropertyValue('--lk-wall-img') }));
    check(r.scene === 'aurora' && r.wall.includes('blob:'), `sign-in screen: animated background (${r.scene})`);
    if (!NO_SHOTS) {
      const f = await g.shot('wallpaper-greeter-animated');
      fs.copyFileSync(f, path.join(DOCS, 'wallpaper-greeter-animated.png'));
    }
    check(!errorsOf(g).length, `sign-in screen: no console errors${errorsOf(g).length ? `: ${errorsOf(g).slice(0, 2).join(' | ')}` : ''}`);
  } finally {
    await g.close();
  }
  const sf = path.join(home, '.config', 'aurora', 'settings.json');
  const cur = JSON.parse(fs.readFileSync(sf, 'utf8'));
  cur.lockScreen = { mode: 'spotlight', effect: 'aurora' };
  fs.writeFileSync(sf, JSON.stringify(cur));
  const g2 = await launchShell({ home, mode: 'greeter' });
  try {
    await g2.page.waitForSelector('.lockui', { timeout: 15000 });
    await sleep(1200);
    const want = (await import(R('core/wallpaper/dynamic.js'))).spotlightPick(new Date()).url;
    const wall = await g2.page.evaluate(() => document.querySelector('.lockui').style.getPropertyValue('--lk-wall-img'));
    check(wall.includes(want), `sign-in screen: picture of the day (${want.split('/').pop()})`);
  } finally {
    await g2.close();
  }
  fs.rmSync(home, { recursive: true, force: true });
}

// =====================================================================================================================
async function realNetwork() {
  // Not required: the build container usually blocks outbound requests. Reported for information.
  console.log('\n# Real Open-Meteo request (informational)');
  const s = await launchShell({ env: { AURORA_WEATHER_TIMEOUT: '6000' } });
  try {
    const r = await inv(s, 'weather:current', PARIS);
    console.log(r.v ? `  info: live weather in Paris: ${r.v.describe}, ${r.v.temperature} °C` : `  info: Open-Meteo unreachable here (${r.err}) — the mock covers the code path`);
    check(r.v ? r.v.source === 'open-meteo' && Number.isInteger(r.v.code) : ['EOFFLINE', 'ETIMEDOUT', 'EHTTP'].includes(r.err), `real request: ${r.v ? 'answered' : `clean ${r.err} error`}`);
  } finally {
    await s.close();
  }
}

try {
  if (run('unit')) await unit();
  if (run('engine')) await effectsAndEngine();
  if (run('dynamic')) await dynamicAndWeather();
  if (run('ui')) {
    await settingsUi({ theme: 'light', lang: 'en' });
    await settingsUi({ theme: 'dark', lang: 'fr' });
  }
  if (run('sizes')) await sizes();
  if (run('restart')) await restartAndGreeter();
  if (run('net')) await realNetwork();
} catch (err) {
  failures.push(`crash: ${err.stack || err}`);
  console.log(err);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
