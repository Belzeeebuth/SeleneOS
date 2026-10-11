// Weather app tests — pure helpers (forecast URL / parsing / deterministic mock, units) and the real Electron shell:
// first run, city search (keyboard + mouse, no result), saved places (switch, keyboard, Delete), current conditions,
// 24 h strip, 7-day list, °C/°F and km/h|mph, "Use for the wallpaper and widgets" (settings.dynamicWallpaper.location,
// read back by weather:current), backend cache, persistence across relaunch, French + dark theme, narrow window,
// first run from the wallpaper's place, offline error + Retry (AURORA_WEATHER_MOCK), console errors.
// Usage:  cd aurora-os/shell && xvfb-run -a -s "-screen 0 1600x900x24" node test/weather.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { launchShell, ROOT } from './lib.mjs';

const require = createRequire(import.meta.url);
const DOCS = path.join(ROOT, '..', 'docs', 'screenshots');
fs.mkdirSync(DOCS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
function check(ok, name, detail = '') {
  if (ok) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
  return ok;
}
async function waitFor(fn, ms = 10000, step = 100) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) return v;
    await sleep(step);
  }
}
const W = '.win.app-weather';
const inv = (s, ch, ...a) => s.aurora(([c, args]) => window.__aurora.api.invoke(c, ...args).then((v) => ({ v }), (e) => ({ err: e.code || e.message })), [ch, a]);
const text = (s, sel) => s.aurora((q) => document.querySelector(q)?.textContent ?? null, sel);
const all = (s, sel) => s.aurora((q) => [...document.querySelectorAll(q)].map((e) => e.textContent), sel);
const winText = (s) => s.aurora((q) => document.querySelector(q)?.innerText || '', W);
const consoleErrors = (s) => s.logs.filter((l) => /^\[(error|pageerror)\]/.test(l) && !/favicon|ERR_FILE_NOT_FOUND|Autofill/.test(l));

// ------------------------------------------------------------------ unit
console.log('\n# Unit: backend helpers and app helpers');
{
  const wx = require(path.join(ROOT, 'main/ipc/weather.js'));
  const url = wx.forecastFullUrl({ lat: 48.8566, lon: 2.3522 });
  check(url.startsWith('https://api.open-meteo.com/v1/forecast?latitude=48.8566&longitude=2.3522') && /hourly=weather_code,is_day,temperature_2m,precipitation_probability/.test(url) && /daily=weather_code,temperature_2m_max,temperature_2m_min/.test(url) && /apparent_temperature,relative_humidity_2m,wind_speed_10m/.test(url) && /forecast_days=7/.test(url), 'forecast URL asks for current + hourly + daily');
  const j = wx.mockForecastJson(48.8566, 2.3522);
  const f = wx.parseFullForecast(j, { lat: 48.8566, lon: 2.3522, name: 'Paris' }, 'mock');
  check(f.hourly.length === 24 && f.daily.length === 7, `24 hours and 7 days (${f.hourly.length}, ${f.daily.length})`);
  check(Number.isFinite(f.current.temperature) && Number.isFinite(f.current.apparent) && Number.isFinite(f.current.humidity) && Number.isFinite(f.current.wind) && Number.isFinite(f.current.windDir) && f.current.describe && f.location.name === 'Paris', 'current conditions: temperature, feels like, humidity, wind, description');
  check(f.daily.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.date) && d.max >= d.min && d.describe) && f.hourly.every((x) => /T\d{2}:00$/.test(x.time) && x.describe), 'daily and hourly entries are well formed');
  const j2 = wx.mockForecastJson(48.8566, 2.3522);
  check(JSON.stringify(j2.hourly.temperature_2m) === JSON.stringify(j.hourly.temperature_2m) && JSON.stringify(j2.daily) === JSON.stringify(j.daily), 'the mock is deterministic');
  const lyon = wx.parseFullForecast(wx.mockForecastJson(45.7485, 4.8467), { lat: 45.75, lon: 4.85 });
  check(JSON.stringify(lyon.daily.map((d) => d.code)) !== JSON.stringify(f.daily.map((d) => d.code)) || lyon.current.temperature !== f.current.temperature, 'different places get different mock weather');
  // the hourly series starts at the current hour even when Open-Meteo sends earlier hours
  const early = { current: { ...j.current, time: j.hourly.time[3] }, hourly: j.hourly, daily: j.daily };
  const fe = wx.parseFullForecast(early, { lat: 1, lon: 2 });
  check(fe.hourly[0].time === j.hourly.time[3] && fe.hourly.length === 22, `hourly starts at the current hour (${fe.hourly[0].time}, ${fe.hourly.length})`);
  let bad = null;
  try {
    wx.parseFullForecast({ current: { weather_code: 'x' } }, { lat: 0, lon: 0 });
  } catch (e) {
    bad = e.code;
  }
  check(bad === 'EBADDATA', 'malformed answer → EBADDATA');
  const g = wx.mockGeocoding('https://geocoding-api.open-meteo.com/v1/search?name=montreal&count=8');
  check(g.results.length === 1 && g.results[0].name === 'Montréal' && wx.parseGeocoding(g)[0].countryCode === 'CA', 'mock search ignores accents (montreal → Montréal)');
  const app = await import(pathToFileURL(path.join(ROOT, 'renderer/apps/weather/main.js')).href);
  check(app.tempIn(20, 'f') === '68' && app.tempIn(-0.3, 'c') === '0' && app.tempIn(null, 'c') === '' && app.tempIn(-40, 'f') === '-40', 'temperature units (°F conversion, no "-0", unknown → empty)');
  check(app.windIn(16.09344, 'mph') === '10' && app.windIn(12.4, 'kmh') === '12' && app.compass(350) === 'N' && app.compass(200) === 'S' && app.compass(-90) === 'W' && app.compass(null) === '', 'wind units and compass points');
  const i18n = JSON.parse(fs.readFileSync(path.join(ROOT, 'renderer/apps/weather/i18n.json'), 'utf8'));
  const keys = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? keys(v, `${p}${k}.`) : [`${p}${k}`])).sort();
  check(JSON.stringify(keys(i18n.en)) === JSON.stringify(keys(i18n.fr)), 'every string exists in English and French');
  const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'renderer/apps/weather/manifest.json'), 'utf8'));
  check(man.id === 'weather' && man.name.en === 'Weather' && man.name.fr === 'Météo' && fs.existsSync(path.join(ROOT, 'renderer/apps/weather/icon.svg')), 'manifest (Weather / Météo) and icon');
}

// ------------------------------------------------------------------ English, light
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-weather-'));
let s = null;
let lyonC = null;
try {
  console.log('\n# Shell (English, light): first run, search, places, units, wallpaper');
  s = await launchShell({ home, open: ['weather'], lang: 'en', theme: 'light', env: { AURORA_WEATHER_TIMEOUT: '1500' } });
  const A = (fn, a) => s.aurora(fn, a);
  check(!!(await waitFor(() => A((q) => !!document.querySelector(q + ' .wx'), W), 15000)), 'Weather window opens');
  check((await text(s, `${W} .wx-welcome h2`)) === 'Welcome to Weather', 'first run: welcome state (no place yet)');
  check(await waitFor(() => A((q) => document.activeElement === document.querySelector(q + ' .wx-search-input'), W), 4000), 'the search box has the focus');
  check((await text(s, `${W} .wx-places-empty`)) === 'Search for a city to add it here.', 'empty places list explains what to do');

  // search with the keyboard
  await s.page.fill(`${W} .wx-search-input`, 'ly');
  const res = await waitFor(async () => {
    const r = await all(s, `${W} .wx-result .wx-result-name`);
    return r.length ? r : null;
  });
  check(JSON.stringify(res) === '["Lyon"]', `search "ly" → ${JSON.stringify(res)}`);
  check((await A((q) => document.querySelector(q + ' .wx-search-input').getAttribute('aria-expanded'), W)) === 'true' && (await A((q) => document.querySelector(q + ' .wx-search-input').getAttribute('aria-activedescendant'), W)) === 'wx-result-0', 'combobox: expanded with an active option');
  await s.page.press(`${W} .wx-search-input`, 'Enter');
  await waitFor(() => A((q) => !!document.querySelector(q + ' .wx-hero'), W), 10000);
  check((await text(s, `${W} .wx-title`)) === 'Lyon', 'Enter adds the city and shows it');
  check((await A((q) => document.querySelector(q + ' .wx-results').hidden, W)) && (await A((q) => document.querySelector(q + ' .wx-search-input').value, W)) === '', 'results closed and search box cleared');

  // conditions match the backend
  const fl = (await inv(s, 'weather:forecast', { lat: 45.7485, lon: 4.8467, name: 'Lyon' })).v;
  lyonC = fl;
  const hero = await A((q) => {
    const r = document.querySelector(q);
    const g = (x) => r.querySelector(x)?.textContent || '';
    return { temp: g('.wx-temp-val'), unit: g('.wx-temp-unit'), desc: g('.wx-hero-desc'), feels: g('.wx-hero-feels'), wind: g('.wx-stat-wind .wx-stat-value'), hum: g('.wx-stat-humidity .wx-stat-value'), icon: r.querySelector('.wx-hero-icon')?.dataset.iconName, svg: !!r.querySelector('.wx-hero-icon svg, .wx-hero-icon .icon') };
  }, W);
  check(hero.temp === String(Math.round(fl.current.temperature)) && hero.unit === '°C', `temperature ${hero.temp} ${hero.unit}`);
  check(hero.feels === `Feels like ${Math.round(fl.current.apparent)}°`, `feels like (${hero.feels})`);
  check(new RegExp(`^${Math.round(fl.current.wind)} km/h [NSEW]{1,2}$`).test(hero.wind), `wind (${hero.wind})`);
  check(hero.hum === `${Math.round(fl.current.humidity)} %`, `humidity (${hero.hum})`);
  check(hero.desc.length > 2 && !!hero.icon && hero.icon.startsWith('weather_') && hero.svg, `condition text and icon (${hero.desc}, ${hero.icon})`);
  const hours = await all(s, `${W} .wx-hour .wx-hour-time`);
  const htemps = await all(s, `${W} .wx-hour .wx-hour-temp`);
  check(hours.length === 24 && hours[0] === 'Now' && /^\d{1,2}\s?(AM|PM)$/.test(hours[1]), `24 h strip (${hours.length}: ${hours.slice(0, 3).join(', ')})`);
  check(htemps[5] === `${Math.round(fl.hourly[5].temperature)}°` && (await A((q) => document.querySelectorAll(q + ' .wx-hour-icon svg').length, W)) === 24, `hourly temperatures and icons (${htemps[5]} vs ${fl.hourly[5].temperature})`);
  const days = await all(s, `${W} .wx-day .wx-day-name`);
  check(days.length === 7 && days[0] === 'Today' && /^[A-Z][a-z]{2} \d{1,2}$/.test(days[1]), `7-day list (${days.slice(0, 3).join(', ')})`);
  const d3 = await A((q) => [...document.querySelectorAll(q + ' .wx-day')][3]?.querySelector('.wx-day-max')?.textContent, W);
  check(d3 === `${Math.round(fl.daily[3].max)}°`, `daily high (${d3})`);
  const bars = await A((q) => [...document.querySelectorAll(q + ' .wx-day-fill')].map((e) => [parseFloat(e.style.left), parseFloat(e.style.right)]), W);
  check(bars.length === 7 && bars.every(([l, r]) => l >= 0 && r >= 0 && l + r < 100), 'temperature range bars stay inside the track');

  // add a second place with the mouse
  await s.page.fill(`${W} .wx-search-input`, 'Par');
  await waitFor(() => A((q) => !!document.querySelector(q + ' .wx-result'), W));
  await s.page.click(`${W} .wx-result`);
  await waitFor(async () => (await text(s, `${W} .wx-title`)) === 'Paris' && (await A((q) => !!document.querySelector(q + ' .wx-hero'), W)));
  const places = await all(s, `${W} .wx-place .wx-place-name`);
  check(JSON.stringify(places) === '["Lyon","Paris"]' && (await text(s, `${W} .wx-place.selected .wx-place-name`)) === 'Paris', `clicking a result saves and selects it (${places})`);
  check(await waitFor(async () => (await all(s, `${W} .wx-place-temp`)).every((x) => /^-?\d+°$/.test(x))), 'saved places show their temperature');
  // adding the same city again does not duplicate it
  await s.page.fill(`${W} .wx-search-input`, 'lyon');
  await waitFor(() => A((q) => !!document.querySelector(q + ' .wx-result'), W));
  await s.page.press(`${W} .wx-search-input`, 'Enter');
  await waitFor(async () => (await text(s, `${W} .wx-title`)) === 'Lyon');
  const dup = await all(s, `${W} .wx-place .wx-place-name`);
  check(dup.length === 2 && (await text(s, `${W} .wx-place.selected .wx-place-name`)) === 'Lyon', `an existing city is selected, not duplicated (${dup}; ${await text(s, `${W} .wx-title`)})`);

  // no result + Escape
  await s.page.fill(`${W} .wx-search-input`, 'zzzz');
  check(!!(await waitFor(async () => (await text(s, `${W} .wx-result-empty`)) === 'No city found')), 'unknown city → "No city found"');
  await s.page.press(`${W} .wx-search-input`, 'Escape');
  check(await A((q) => document.querySelector(q + ' .wx-results').hidden, W), 'Escape closes the results');
  await s.page.press(`${W} .wx-search-input`, 'Escape');
  check((await A((q) => document.querySelector(q + ' .wx-search-input').value, W)) === '', 'a second Escape clears the search');

  // switch places with the keyboard
  await s.page.focus(`${W} .wx-place.selected .wx-place-btn`);
  await s.page.keyboard.press('ArrowDown');
  const fk = await A(() => document.activeElement?.closest('.wx-place')?.dataset.key || document.activeElement?.className);
  check(fk === '48.86,2.35', `ArrowDown moves to the next place (${fk})`);
  await s.page.keyboard.press('Enter');
  await waitFor(async () => (await text(s, `${W} .wx-title`)) === 'Paris');
  check((await text(s, `${W} .wx-title`)) === 'Paris' && (await A((q) => document.querySelector(q + ' .wx-place.selected .wx-place-btn')?.getAttribute('aria-current'), W)) === 'true', 'Enter switches to the focused place');
  await s.page.click(`${W} .wx-place[data-key="45.75,4.85"] .wx-place-btn`);
  await waitFor(async () => (await text(s, `${W} .wx-title`)) === 'Lyon');
  check((await text(s, `${W} .wx-temp-val`)) === String(Math.round(lyonC.current.temperature)), 'clicking a place switches back');

  // units
  await s.page.click(`${W} .wx-seg-temp button[data-value="f"]`);
  const fTemp = await text(s, `${W} .wx-temp-val`);
  check(fTemp === String(Math.round((lyonC.current.temperature * 9) / 5 + 32)) && (await text(s, `${W} .wx-temp-unit`)) === '°F', `°F (${fTemp} °F)`);
  check((await all(s, `${W} .wx-hour-temp`))[5] === `${Math.round((lyonC.hourly[5].temperature * 9) / 5 + 32)}°` && (await all(s, `${W} .wx-place-temp`))[0] === `${fTemp}°`, 'hourly and saved-place temperatures follow °F');
  check((await A((q) => document.querySelector(q + ' .wx-seg-temp button[data-value="f"]').getAttribute('aria-pressed'), W)) === 'true' && (await A(() => document.activeElement?.dataset.value)) === 'f', 'the unit button is pressed and keeps the focus');
  await s.page.click(`${W} .wx-seg-wind button[data-value="mph"]`);
  const mph = await text(s, `${W} .wx-stat-wind .wx-stat-value`);
  check(new RegExp(`^${Math.round(lyonC.current.wind / 1.609344)} mph`).test(mph), `mph (${mph})`);

  // wallpaper and widgets
  const btn0 = await A((q) => ({ t: document.querySelector(q + ' .wx-wallpaper')?.textContent, p: document.querySelector(q + ' .wx-wallpaper')?.getAttribute('aria-pressed') }), W);
  check(btn0.t === 'Use for the wallpaper and widgets' && btn0.p === 'false', `wallpaper button (${btn0.t})`);
  await s.page.click(`${W} .wx-wallpaper`);
  const loc = await waitFor(async () => {
    const v = (await inv(s, 'settings:get', 'dynamicWallpaper.location')).v;
    return v?.name ? v : null;
  });
  check(loc?.name === 'Lyon' && Math.abs(loc.lat - 45.7485) < 0.001 && Math.abs(loc.lon - 4.8467) < 0.001, `settings.dynamicWallpaper.location = ${JSON.stringify(loc)}`);
  check(await waitFor(async () => (await A((q) => document.querySelector(q + ' .wx-wallpaper')?.getAttribute('aria-pressed'), W)) === 'true' && (await text(s, `${W} .wx-wallpaper`)) === 'Used for the wallpaper and widgets'), 'the button shows the place is in use');
  // weather:current keeps its real request in dev (no network here): it must at least ask for Lyon
  const cur = await inv(s, 'weather:current');
  const curUrl = (await inv(s, 'weather:stats')).v.lastUrl || '';
  check(cur.v ? cur.v.location?.name === 'Lyon' : ['EOFFLINE', 'ETIMEDOUT', 'EHTTP'].includes(cur.err) && curUrl.includes('latitude=45.7485&longitude=4.8467&current='), `weather:current (wallpaper and widgets) now uses Lyon (${cur.v ? cur.v.location?.name : cur.err})`);
  await s.page.click(`${W} .wx-place[data-key="48.86,2.35"] .wx-place-btn`);
  await waitFor(async () => (await text(s, `${W} .wx-title`)) === 'Paris');
  check((await A((q) => document.querySelector(q + ' .wx-wallpaper')?.getAttribute('aria-pressed'), W)) === 'false', 'another place is not marked as used');
  await s.page.click(`${W} .wx-place[data-key="45.75,4.85"] .wx-place-btn`);

  // backend: mock, URL, cache
  const st = (await inv(s, 'weather:stats')).v;
  check(st.builtinMock === true && st.urls.some((u) => u.includes('&hourly=') && u.includes('latitude=45.7485')), 'dev backend uses the deterministic mock (Open-Meteo forecast URL)');
  const r0 = st.requests;
  await inv(s, 'weather:forecast', { lat: 45.7485, lon: 4.8467, name: 'Lyon' });
  const st2 = (await inv(s, 'weather:stats')).v;
  check(st2.requests === r0 && st2.cacheHits > st.cacheHits, 'forecasts are cached (no new request)');
  const bad = await inv(s, 'weather:forecast', { lat: 999, lon: 0 });
  check(bad.v?.location?.lat === 45.7485, 'an invalid place falls back to the wallpaper place');

  // refresh button keeps the view
  await s.page.click(`${W} .wx-refresh`);
  await sleep(300);
  check((await text(s, `${W} .wx-title`)) === 'Lyon' && !!(await text(s, `${W} .wx-temp-val`)), 'Refresh keeps the forecast on screen');

  // hourly strip scrolls with the keyboard
  await s.page.focus(`${W} .wx-hours`);
  await s.page.keyboard.press('ArrowRight');
  check(!!(await waitFor(() => A((q) => document.querySelector(q + ' .wx-hours').scrollLeft > 0, W), 3000)), 'the 24 h strip scrolls with the arrow keys');

  // quality
  const wt = await winText(s);
  check(!/\bnull\b|\bundefined\b|NaN/.test(wt), 'no "null", "undefined" or "NaN" in the window');
  const ov = await A((q) => {
    const c = document.querySelector(q + ' .wx-content');
    return c.scrollWidth - c.clientWidth;
  }, W);
  check(ov <= 1, `no horizontal overflow (${ov}px)`);

  // persistence (written before the relaunch)
  const saved = (await inv(s, 'storage:get', 'weather', 'state', null)).v;
  check(saved?.places?.length === 2 && saved.temp === 'f' && saved.wind === 'mph' && saved.current === '45.75,4.85', 'places, selection and units are saved');

  // back to °C / km/h for the screenshot
  await s.page.click(`${W} .wx-seg-temp button[data-value="c"]`);
  await s.page.click(`${W} .wx-seg-wind button[data-value="kmh"]`);
  await sleep(400);
  const errs = consoleErrors(s);
  check(errs.length === 0, `no console errors${errs.length ? `: ${errs.slice(0, 3).join(' | ')}` : ''}`);
  const shot = await s.page.locator(W).screenshot();
  fs.writeFileSync(path.join(DOCS, 'weather-light-en.png'), shot);
  // set units again so the relaunch checks restore °F / mph
  await s.page.click(`${W} .wx-seg-temp button[data-value="f"]`);
  await s.page.click(`${W} .wx-seg-wind button[data-value="mph"]`);
  await sleep(300);
  // remove a place with Delete
  await s.page.focus(`${W} .wx-place[data-key="48.86,2.35"] .wx-place-btn`);
  await s.page.keyboard.press('Delete');
  check(!!(await waitFor(async () => JSON.stringify(await all(s, `${W} .wx-place .wx-place-name`)) === '["Lyon"]')), 'Delete removes the focused place');
  check(!!(await waitFor(async () => (await text(s, `${W} .wx-live`)) === 'Paris removed', 3000)), 'the removal is announced');
  await sleep(300);
} catch (e) {
  check(false, 'English session', e.stack || String(e));
} finally {
  await s?.close();
}

// ------------------------------------------------------------------ French, dark (same home: persistence)
try {
  console.log('\n# Shell (French, dark): relaunch, persistence, strings, narrow window');
  s = await launchShell({ home, keepHome: true, open: ['weather'], lang: 'fr', theme: 'dark' });
  const A = (fn, a) => s.aurora(fn, a);
  await waitFor(() => A((q) => !!document.querySelector(q + ' .wx-hero'), W), 15000);
  check((await all(s, `${W} .wx-place .wx-place-name`)).join() === 'Lyon' && (await text(s, `${W} .wx-title`)) === 'Lyon', 'saved places restored after a relaunch');
  check((await text(s, `${W} .wx-temp-unit`)) === '°F' && /mph/.test((await text(s, `${W} .wx-stat-wind .wx-stat-value`)) || ''), 'units restored (°F, mph)');
  const fr = await A((q) => {
    const r = document.querySelector(q);
    return {
      sections: [...r.querySelectorAll('.wx-section-title')].map((e) => e.textContent),
      now: r.querySelector('.wx-hour-time')?.textContent,
      h1: r.querySelectorAll('.wx-hour-time')[1]?.textContent,
      today: r.querySelector('.wx-day-name')?.textContent,
      wp: r.querySelector('.wx-wallpaper')?.textContent,
      ph: r.querySelector('.wx-search-input')?.placeholder,
      places: r.querySelector('.wx-side-title')?.textContent,
      feels: r.querySelector('.wx-hero-feels')?.textContent,
      labels: [...r.querySelectorAll('.wx-stat-label')].map((e) => e.textContent),
    };
  }, W);
  check(fr.sections.join('|') === 'Prochaines 24 heures|Prévisions sur 7 jours' && fr.now === 'Maintenant' && fr.today === 'Aujourd’hui', `French sections (${fr.sections.join(', ')}, ${fr.now}, ${fr.today})`);
  check(/^\d{1,2}\sh$/.test(fr.h1 || ''), `French hours (${fr.h1})`);
  check(fr.wp === 'Utilisé pour le fond d’écran et les widgets' && fr.ph === 'Rechercher une ville' && fr.places === 'Lieux' && /^Ressenti -?\d+°$/.test(fr.feels || ''), `French labels (${fr.wp}; ${fr.feels})`);
  check(fr.labels.slice(0, 3).join('|') === 'Vent|Humidité|Risque de pluie', `French stats (${fr.labels.join(', ')})`);
  const desc = await text(s, `${W} .wx-hero-desc`);
  const { WEATHER_TEXT } = await import(pathToFileURL(path.join(ROOT, 'renderer/core/wallpaper/weather-text.js')).href);
  check(Object.values(WEATHER_TEXT.fr).includes(desc), `French condition (${desc})`);
  await s.page.fill(`${W} .wx-search-input`, 'zzzz');
  check(!!(await waitFor(async () => (await text(s, `${W} .wx-result-empty`)) === 'Aucune ville trouvée')), 'French "no city found"');
  await s.page.press(`${W} .wx-search-input`, 'Escape');
  await s.page.press(`${W} .wx-search-input`, 'Escape');
  await s.page.click(`${W} .wx-seg-temp button[data-value="c"]`);
  await s.page.click(`${W} .wx-seg-wind button[data-value="kmh"]`);
  await sleep(400);
  const dark = await A((q) => getComputedStyle(document.querySelector(q + ' .wx-title')).color, W);
  check(/rgb\(2[0-5]\d, 2[0-5]\d, 2[0-5]\d\)/.test(dark), `dark theme: light text (${dark})`);
  check(!/\bnull\b|\bundefined\b|NaN/.test(await winText(s)), 'no "null", "undefined" or "NaN" (French)');
  const shot = await s.page.locator(W).screenshot();
  fs.writeFileSync(path.join(DOCS, 'weather-dark-fr.png'), shot);

  // narrow window: one column, no horizontal scroll
  await A((q) => {
    const w = document.querySelector(q).__weather.win;
    w.restore?.();
    w.setSize(440, 600);
    return true;
  }, W);
  await sleep(600);
  const narrow = await A((q) => {
    const r = document.querySelector(q);
    const l = r.querySelector('.wx-layout');
    return { dir: getComputedStyle(l).flexDirection, over: l.scrollWidth - l.clientWidth, w: r.getBoundingClientRect().width };
  }, W);
  check(narrow.w > 500 || (narrow.dir === 'column' && narrow.over <= 1), `narrow window: single column without horizontal scroll (${JSON.stringify(narrow)})`);
  const errs = consoleErrors(s);
  check(errs.length === 0, `no console errors (French)${errs.length ? `: ${errs.slice(0, 3).join(' | ')}` : ''}`);
} catch (e) {
  check(false, 'French session', e.stack || String(e));
} finally {
  await s?.close();
  fs.rmSync(home, { recursive: true, force: true });
}

// ------------------------------------------------------------------ first run from the wallpaper's place, offline
try {
  console.log('\n# Shell: first run from the wallpaper place, offline error, Retry');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-weather-mock-'));
  const MOCK = path.join(tmp, 'mock.json');
  fs.writeFileSync(MOCK, JSON.stringify({ offline: true }));
  s = await launchShell({ open: ['weather'], lang: 'en', theme: 'light', settings: { dynamicWallpaper: { source: 'time', set: 'bloom', location: { name: 'Rennes', lat: 48.1173, lon: -1.6778 }, followTheme: false } }, env: { AURORA_WEATHER_MOCK: MOCK, AURORA_WEATHER_TIMEOUT: '1500' } });
  const A = (fn, a) => s.aurora(fn, a);
  await waitFor(() => A((q) => !!document.querySelector(q + ' .wx-error'), W), 15000);
  check((await all(s, `${W} .wx-place .wx-place-name`)).join() === 'Rennes' && (await text(s, `${W} .wx-title`)) === 'Rennes', 'first run starts with the place of the dynamic wallpaper');
  check((await text(s, `${W} .wx-error h2`)) === 'Weather is unavailable' && (await text(s, `${W} .wx-error p`)) === 'Check your internet connection, then try again.', 'offline: error state with advice');
  await s.page.fill(`${W} .wx-search-input`, 'Paris');
  check(!!(await waitFor(async () => (await text(s, `${W} .wx-result-empty`)) === 'Search is unavailable (offline)')), 'offline: search says it is unavailable');
  await s.page.press(`${W} .wx-search-input`, 'Escape');
  fs.writeFileSync(MOCK, JSON.stringify({ current: { weather_code: 61, is_day: 1, temperature_2m: 12.4, time: '2026-10-10T14:00' } }));
  await s.page.click(`${W} .wx-retry`);
  await waitFor(() => A((q) => !!document.querySelector(q + ' .wx-hero'), W), 10000);
  check((await text(s, `${W} .wx-temp-val`)) === '12' && (await text(s, `${W} .wx-hero-desc`)) === 'Rain', `Retry loads the forecast (${await text(s, `${W} .wx-temp-val`)}, ${await text(s, `${W} .wx-hero-desc`)})`);
  check((await all(s, `${W} .wx-hour`)).length === 24 && (await all(s, `${W} .wx-day`)).length === 7, 'forecast from the mock file (24 h + 7 days)');
  check((await A((q) => document.querySelector(q + ' .wx-wallpaper')?.getAttribute('aria-pressed'), W)) === 'true', 'the wallpaper place is marked as used');
  const errs = consoleErrors(s);
  check(errs.length === 0, `no console errors (offline)${errs.length ? `: ${errs.slice(0, 3).join(' | ')}` : ''}`);
  fs.rmSync(tmp, { recursive: true, force: true });
} catch (e) {
  check(false, 'Offline session', e.stack || String(e));
} finally {
  await s?.close();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
