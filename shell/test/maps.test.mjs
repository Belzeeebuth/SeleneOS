// Maps tests — pure Web Mercator math + backend helpers, then the real Electron shell with Playwright (dev mode: mock
// SVG tiles and a built-in gazetteer, never network): tiles rendered with at most 2 requests in flight, zoom (buttons,
// keys, wheel, double-click, limits 2-19), pan (drag, arrows), scale bar, OSM attribution, search (Enter, results,
// marker, card, cache, 1 request / second), My places (save -> ~/.local/share/aurora/maps.json, list, rename, remove),
// backend validation, keyboard (Ctrl+F, ArrowDown into results), FR + dark theme, console errors.
// Screenshots: aurora-os/docs/screenshots/maps-light-en.png, maps-dark-fr.png
// Usage:  cd aurora-os/shell && xvfb-run -a -s "-screen 0 1600x900x24" node test/maps.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { launchShell, ROOT } from './lib.mjs';

const require = createRequire(import.meta.url);
const DOCS = path.join(ROOT, '..', 'docs', 'screenshots');
fs.mkdirSync(DOCS, { recursive: true });
const WIN = '.win.app-maps';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
// Evaluate fn(maps, arg) for the Maps window (expression string: the page CSP forbids eval).
function M(s, fn, arg) {
  return s.page.evaluate(`(async () => { const el = document.querySelector(${JSON.stringify(WIN)} + ' .win-body') || document.querySelector(${JSON.stringify(WIN)}); const body = el && (el.__maps ? el : [...document.querySelectorAll(${JSON.stringify(WIN)} + ' *')].find((x) => x.__maps)); return (${fn.toString()})(body && body.__maps, ${JSON.stringify(arg ?? null)}); })()`);
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
async function shot(s, name) {
  await sleep(500);
  const rect = await s.page.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(WIN)}).getBoundingClientRect(); return { x: Math.max(0, r.x - 1), y: Math.max(0, r.y - 1), width: r.width + 2, height: r.height + 2 }; })()`);
  await s.page.screenshot({ path: path.join(DOCS, `maps-${name}.png`), clip: rect });
}
const badText = (s) => s.page.evaluate(`(() => { const w = document.querySelector(${JSON.stringify(WIN)}); return /\\b(null|undefined|NaN)\\b|\\{[a-z]+\\}/.test(w.innerText) ? w.innerText.slice(0, 400) : ''; })()`);
const mapsErrors = (s) => s.logs.filter((l) => /^\[(error|pageerror)\]/.test(l) && /maps/i.test(l));

// ---------------------------------------------------------------- pure math + backend helpers
await section('geo math', async () => {
  const g = await import(pathToFileURL(path.join(ROOT, 'renderer/apps/maps/lib/geo.js')).href);
  const p = g.project(48.8566, 2.3522, 10);
  const u = g.unproject(p.x, p.y, 10);
  check('project/unproject round trip lat', Math.abs(u.lat - 48.8566) < 1e-9, true);
  check('project/unproject round trip lon', Math.abs(u.lon - 2.3522) < 1e-9, true);
  const o = g.project(0, 0, 0);
  check('0,0 is the centre of the z0 world', [o.x, o.y], [128, 128]);
  check('clampZoom low', g.clampZoom(0), 2);
  check('clampZoom high', g.clampZoom(25), 19);
  check('wrapLon 190 -> -170', g.wrapLon(190), -170);
  check('wrapLon -190 -> 170', g.wrapLon(-190), 170);
  const sb = g.scaleBar(0, 2, 100);
  check('scale bar at z2 equator in km', sb.unit, 'km');
  check('scale bar fits 100px', sb.px <= 100 && sb.px > 30, true);
  check('scale bar nice value', [1, 2, 5].includes(sb.value / 10 ** Math.floor(Math.log10(sb.value))), true);
  check('scale bar at z18 in metres', g.scaleBar(48.85, 18, 100).unit, 'm');
  const vt = g.visibleTiles(48.85, 2.35, 12, 1024, 768);
  check('visible tiles cover the viewport (5x4 or more)', vt.tiles.length >= 20 && vt.tiles.length <= 30, true);
  check('visible tiles at the rounded zoom', vt.tz, 12);
  check('visible tiles sorted centre first', vt.tiles[0].left <= 512 && vt.tiles[0].left + vt.tiles[0].size >= 512, true);
  const vt2 = g.visibleTiles(0, 179.9, 3, 800, 600);
  check('tiles wrap across the antimeridian', vt2.tiles.every((t) => t.x >= 0 && t.x < 8), true);
  check('fitZoom on Paris bbox', g.fitZoom([48.8155755, 48.902156, 2.224122, 2.4697602], 800, 600), 12);
  check('fitZoom invalid', g.fitZoom(null, 800, 600), null);
  check('formatCoords', g.formatCoords(48.85, -2.5, 2), '48.85° N, 2.50° W');
});

await section('backend helpers', async () => {
  const m = require('../main/ipc/maps.js');
  check('User-Agent', m.USER_AGENT, 'SeleneOS-Maps/1.0');
  check('normTile ok', m.normTile(3, 7, 0), { z: 3, x: 7, y: 0 });
  check('normTile x out of range', m.normTile(3, 8, 0), null);
  check('normTile z too high', m.normTile(20, 0, 0), null);
  check('normTile not integer', m.normTile(2, 1.5, 0), null);
  check('normTile negative', m.normTile(2, -1, 0), null);
  const svg = Buffer.from(m.mockTile(5, 16, 11).split(',')[1], 'base64').toString();
  check('mock tile is an SVG with z/x/y', svg.startsWith('<svg') && svg.includes('5/16/11'), true);
  check('mock tile deterministic', m.mockTile(5, 16, 11), m.mockTile(5, 16, 11));
  const parsed = m.parseSearch([{ place_id: 1, name: 'A', display_name: 'A, B', lat: '1.5', lon: '2.5', boundingbox: ['1', '2', '3', '4'], type: 'city' }, { name: 'bad', lat: 'x', lon: '1' }, { display_name: 'Only display, X', lat: '0', lon: '0' }]);
  check('parseSearch drops invalid rows', parsed.length, 2);
  check('parseSearch numbers + bbox', [parsed[0].lat, parsed[0].lon, parsed[0].bbox], [1.5, 2.5, [1, 2, 3, 4]]);
  check('parseSearch name from display', parsed[1].name, 'Only display');
  check('parseSearch not an array', m.parseSearch({ error: 'x' }), []);
  check('normPlace rejects bad lat', m.normPlace({ name: 'x', lat: 95, lon: 0 }), null);
  check('normPlace rejects empty name', m.normPlace({ name: '  ', lat: 1, lon: 0 }), null);
  check('normPlace strips control chars', m.normPlace({ name: 'a\u0000b', lat: 1, lon: 0 }).name, 'a b');
  check('mock search folds accents', m.mockSearch('montreal', 'fr').length, 1);
});

// ---------------------------------------------------------------- EN, light
let s = await launchShell({ open: ['maps'], lang: 'en', theme: 'light', env: { AURORA_MAPS_TILE_DELAY: '30' } });
try {
  await section('launch: window, tiles, attribution, scale bar', async () => {
    await s.page.waitForSelector(WIN, { timeout: 15000 });
    await until(s, (m) => m && m.tileStats.elements > 0 && document.querySelectorAll('.win.app-maps .mp-tile.loaded').length >= m.tileStats.elements, { label: 'all visible tiles loaded', timeout: 20000 });
    const ts = await M(s, (m) => m.tileStats);
    check('tiles visible', ts.elements >= 6, true);
    check('renderer: at most 2 tile requests in flight', ts.maxInFlight <= 2 && ts.maxInFlight >= 1, true);
    const st = (await invoke(s, 'maps:stats')).value;
    check('backend: at most 2 parallel tile loads', st.maxParallel <= 2, true);
    check('backend: mock mode in dev', st.mock, true);
    check('backend: no bulk prefetch (requests ~ visible tiles)', st.tileRequests <= ts.elements + 4, true);
    const src = await s.page.evaluate(`document.querySelector('.win.app-maps .mp-tile.loaded').getAttribute('src').slice(0, 26)`);
    check('tile is a local data: SVG', src, 'data:image/svg+xml;base64,');
    check('attribution text', await text(s, `${WIN} .mp-attrib`), '© OpenStreetMap contributors');
    check('scale bar label', await text(s, `${WIN} .mp-scale-text`), (v) => /^\d[\d,.]* (m|km)$/.test(v || ''));
    const w = await s.page.evaluate(`parseFloat(document.querySelector('.win.app-maps .mp-scale-bar').style.width)`);
    check('scale bar width', w > 20 && w <= 100, true);
    check('default view zoom', (await M(s, (m) => m.view)).zoom, 5);
    check('window title', await s.page.evaluate(`document.querySelector('.win.app-maps .win-title, .win.app-maps .title')?.textContent || ''`), (v) => v.includes('Maps'));
  });

  await section('zoom: buttons, keys, wheel, double-click, limits', async () => {
    await s.page.click(`${WIN} .mp-zoom-in`);
    await sleep(100);
    check('+ button zooms in', (await M(s, (m) => m.view)).zoom, 6);
    await s.page.focus(`${WIN} .mp-map`);
    await s.page.keyboard.press('Minus');
    await sleep(100);
    check('- key zooms out', (await M(s, (m) => m.view)).zoom, 5);
    await s.page.keyboard.press('Equal');
    await sleep(100);
    check('= key zooms in', (await M(s, (m) => m.view)).zoom, 6);
    const box = await s.page.locator(`${WIN} .mp-map`).boundingBox();
    const before = await M(s, (m) => m.view);
    await s.page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 60);
    const geoBefore = await M(s, (m, a) => m.screenToGeo(a.x, a.y), { x: box.width / 2 + 120, y: box.height / 2 + 60 });
    await s.page.mouse.wheel(0, -120);
    await sleep(150);
    const mid = await M(s, (m) => m.view);
    check('wheel zooms in', mid.zoom > before.zoom, true);
    const geoAfter = await M(s, (m, a) => m.screenToGeo(a.x, a.y), { x: box.width / 2 + 120, y: box.height / 2 + 60 });
    check('wheel zoom keeps the point under the cursor', Math.abs(geoAfter.lat - geoBefore.lat) < 0.01 && Math.abs(geoAfter.lon - geoBefore.lon) < 0.01, true);
    await sleep(450);
    check('wheel zoom snaps to a whole level', Number.isInteger((await M(s, (m) => m.view)).zoom), true);
    const z0 = (await M(s, (m) => m.view)).zoom;
    await s.page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
    await sleep(150);
    check('double-click zooms in', (await M(s, (m) => m.view)).zoom, z0 + 1);
    await M(s, (m) => (m.setView(48.85, 2.35, 19), m.renderNow(), true));
    check('max zoom 19 disables +', await s.page.evaluate(`document.querySelector('.win.app-maps .mp-zoom-in').disabled`), true);
    await s.page.focus(`${WIN} .mp-map`);
    await s.page.keyboard.press('Equal');
    await sleep(80);
    check('cannot zoom past 19', (await M(s, (m) => m.view)).zoom, 19);
    await M(s, (m) => (m.setView(20, 0, 2), m.renderNow(), true));
    check('min zoom 2 disables -', await s.page.evaluate(`document.querySelector('.win.app-maps .mp-zoom-out').disabled`), true);
    await s.page.keyboard.press('Minus');
    await sleep(80);
    check('cannot zoom below 2', (await M(s, (m) => m.view)).zoom, 2);
    await M(s, (m) => (m.setView(46.6, 2.4, 6), m.renderNow(), true));
    check('zoom label', await text(s, `${WIN} .mp-zlabel`), 'Zoom 6');
  });

  await section('pan: drag and arrow keys', async () => {
    const box = await s.page.locator(`${WIN} .mp-map`).boundingBox();
    const v0 = await M(s, (m) => m.view);
    await s.page.mouse.move(box.x + 300, box.y + 300);
    await s.page.mouse.down();
    await s.page.mouse.move(box.x + 200, box.y + 250, { steps: 5 });
    await s.page.mouse.up();
    await sleep(120);
    const v1 = await M(s, (m) => m.view);
    check('drag left moves the map east', v1.lon > v0.lon, true);
    check('drag up moves the map south', v1.lat < v0.lat, true);
    const mpp = (360 / (256 * 2 ** 6));
    check('drag distance matches 100px', Math.abs(v1.lon - v0.lon - 100 * mpp) < mpp * 2, true);
    await s.page.focus(`${WIN} .mp-map`);
    await s.page.keyboard.press('ArrowRight');
    await sleep(80);
    const v2 = await M(s, (m) => m.view);
    check('ArrowRight pans east', v2.lon > v1.lon, true);
    await s.page.keyboard.press('ArrowUp');
    await sleep(80);
    check('ArrowUp pans north', (await M(s, (m) => m.view)).lat > v2.lat, true);
    await until(s, (m) => m.tileStats.inFlight === 0 && m.tileStats.queued === 0, { label: 'tile queue drained' });
    check('renderer never exceeded 2 requests', (await M(s, (m) => m.tileStats)).maxInFlight <= 2, true);
    check('backend never exceeded 2 parallel', (await invoke(s, 'maps:stats')).value.maxParallel <= 2, true);
  });

  await section('search: results, marker, card, cache, rate limit', async () => {
    await s.page.fill(`${WIN} .mp-input`, 'paris');
    await s.page.press(`${WIN} .mp-input`, 'Enter');
    await until(s, (m) => m.results.length === 3, { label: '3 results' });
    check('status count', await text(s, `${WIN} .mp-status`), '3 results');
    const names = await s.page.evaluate(`[...document.querySelectorAll('.win.app-maps .mp-list .mp-item-name')].map((e) => e.textContent)`);
    check('result names', names, ['Paris', 'Paris', 'Eiffel Tower']);
    const sel = await M(s, (m) => m.selected);
    check('first result selected', sel && sel.display.includes('France'), true);
    const v = await M(s, (m) => m.view);
    check('map centred on Paris', Math.abs(v.lat - 48.8535) < 0.01 && Math.abs(v.lon - 2.3484) < 0.01, true);
    check('fit zoom from bbox', v.zoom >= 10 && v.zoom <= 13, true);
    await M(s, (m) => (m.renderNow(), true));
    check('marker shown', await s.page.evaluate(`document.querySelectorAll('.win.app-maps .mp-pin').length`), 1);
    const pin = await s.page.evaluate(`(() => { const p = document.querySelector('.win.app-maps .mp-pin').getBoundingClientRect(); const m = document.querySelector('.win.app-maps .mp-map').getBoundingClientRect(); return { x: p.left + 16 - m.left - m.width / 2, y: p.top + 43 - m.top - m.height / 2 }; })()`);
    check('marker tip at the map centre', Math.abs(pin.x) < 2 && Math.abs(pin.y) < 2, true);
    check('card title', await text(s, `${WIN} .mp-card-title`), 'Paris');
    check('card coordinates', await text(s, `${WIN} .mp-card-coords`), '48.85350° N, 2.34839° E');
    // second result by keyboard
    await s.page.focus(`${WIN} .mp-input`);
    await s.page.keyboard.press('ArrowDown');
    check('ArrowDown from search focuses the first result', await s.page.evaluate(`document.activeElement.classList.contains('mp-item-main')`), true);
    await s.page.keyboard.press('ArrowDown');
    await s.page.keyboard.press('Enter');
    await sleep(150);
    check('second result selected by keyboard', (await M(s, (m) => m.selected)).display, (d) => d.includes('Texas'));
    // cache + rate limit
    const st0 = (await invoke(s, 'maps:stats')).value;
    await invoke(s, 'maps:search', 'paris', { lang: 'en' });
    const st1 = (await invoke(s, 'maps:stats')).value;
    check('repeated search served from cache', [st1.searchCacheHits - st0.searchCacheHits, st1.searchNetwork - st0.searchNetwork], [1, 0]);
    const t0 = Date.now();
    const [a, b] = await Promise.all([invoke(s, 'maps:search', 'lyon', { lang: 'en' }), invoke(s, 'maps:search', 'berlin', { lang: 'en' })]);
    check('two searches answered', [a.value?.[0]?.name, b.value?.[0]?.name], ['Lyon', 'Berlin']);
    const times = (await invoke(s, 'maps:stats')).value.searchTimes.slice(-2);
    check('at most 1 search request per second', times[1] - times[0] >= 990, true);
    check('second search was delayed', Date.now() - t0 >= 900, true);
    await s.page.fill(`${WIN} .mp-input`, 'zzzxq');
    await s.page.press(`${WIN} .mp-input`, 'Enter');
    await until(s, () => /No places found/.test(document.querySelector('.win.app-maps .mp-status').textContent), { label: 'no results', timeout: 5000 });
    check('no results message', await text(s, `${WIN} .mp-status`), 'No places found for “zzzxq”');
    await s.page.focus(`${WIN} .mp-input`);
    await s.page.keyboard.press('Escape');
    check('Escape clears the search', await s.page.inputValue(`${WIN} .mp-input`), '');
    check('hint after clearing', await text(s, `${WIN} .mp-status`), (v) => /Type a city/.test(v));
  });

  await section('My places: save, list, rename, remove, file', async () => {
    await s.page.fill(`${WIN} .mp-input`, 'eiffel');
    await s.page.press(`${WIN} .mp-input`, 'Enter');
    await until(s, (m) => m.results.length === 1 && m.selected && m.selected.name === 'Eiffel Tower', { label: 'Eiffel Tower' });
    await s.page.click(`${WIN} .mp-save`);
    await until(s, (m) => m.places.length === 1, { label: 'saved' });
    check('Save button turns into Saved', await text(s, `${WIN} .mp-save`), 'Saved');
    check('Saved button disabled', await s.page.evaluate(`document.querySelector('.win.app-maps .mp-save').disabled`), true);
    const file = path.join(s.home, '.local', 'share', 'aurora', 'maps.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    check('maps.json has the place', [data.places.length, data.places[0].name, data.places[0].lat], [1, 'Eiffel Tower', 48.85826]);
    await M(s, (m) => (m.renderNow(), true));
    check('no dot under the pin of the selected place', await s.page.evaluate(`document.querySelectorAll('.win.app-maps .mp-dot').length`), 0);
    await s.page.click(`${WIN} .mp-card-close`);
    await M(s, (m) => (m.renderNow(), true));
    check('saved place dot on the map', await s.page.evaluate(`document.querySelectorAll('.win.app-maps .mp-dot').length`), 1);
    check('card closed', await s.page.evaluate(`document.querySelector('.win.app-maps .mp-card').hidden`), true);
    const again = await invoke(s, 'maps:savePlace', { name: 'Eiffel Tower', lat: 48.8582599, lon: 2.2945006 });
    check('saving the same spot does not duplicate', again.value.length, 1);
    await s.page.click(`${WIN} .mp-tab[data-tab=places]`);
    await sleep(150);
    check('My places tab selected', await M(s, (m) => m.tab), 'places');
    check('My places lists it', await s.page.evaluate(`[...document.querySelectorAll('.win.app-maps .mp-place .mp-item-name')].map((e) => e.textContent)`), ['Eiffel Tower']);
    await s.page.hover(`${WIN} .mp-place`);
    await s.page.click(`${WIN} .mp-place .mp-rename`);
    await s.page.waitForSelector('.dialog-layer:not(.closing) .dialog input', { timeout: 5000 });
    await s.page.fill('.dialog-layer:not(.closing) .dialog input', 'Tour <b>Eiffel</b>');
    await s.page.keyboard.press('Enter');
    await until(s, (m) => m.places[0]?.name === 'Tour <b>Eiffel</b>', { label: 'renamed' });
    check('rename shown as text, never HTML', await s.page.evaluate(`(() => { const n = document.querySelector('.win.app-maps .mp-place .mp-item-name'); return [n.textContent, n.querySelector('b') === null]; })()`), ['Tour <b>Eiffel</b>', true]);
    // go to the place from the list
    await M(s, (m) => (m.setView(0, 0, 3), true));
    await s.page.click(`${WIN} .mp-place .mp-item-main`);
    await sleep(150);
    const v = await M(s, (m) => m.view);
    check('clicking a saved place centres the map', Math.abs(v.lat - 48.85826) < 0.001 && v.zoom >= 10, true);
    await s.page.hover(`${WIN} .mp-place`);
    await s.page.click(`${WIN} .mp-place .mp-remove`);
    await until(s, (m) => m.places.length === 0, { label: 'removed' });
    check('empty state', await text(s, `${WIN} .mp-empty`), (t) => /No saved places/.test(t || ''));
    check('file updated', JSON.parse(fs.readFileSync(file, 'utf8')).places.length, 0);
  });

  await section('backend validation', async () => {
    check('tile z out of range', (await invoke(s, 'maps:tile', 20, 0, 0)).code, 'EINVAL');
    check('tile x out of range', (await invoke(s, 'maps:tile', 2, 4, 0)).code, 'EINVAL');
    check('tile not a number', (await invoke(s, 'maps:tile', 'a', 0, 0)).code, 'EINVAL');
    check('save invalid place', (await invoke(s, 'maps:savePlace', { name: 'x', lat: 'abc', lon: 1 })).code, 'EINVAL');
    check('save null', (await invoke(s, 'maps:savePlace', null)).code, 'EINVAL');
    check('rename unknown', (await invoke(s, 'maps:renamePlace', 'nope', 'x')).code, 'ENOENT');
    check('search too short', (await invoke(s, 'maps:search', 'a')).value, []);
    const st = (await invoke(s, 'maps:stats')).value;
    check('User-Agent reported', st.userAgent, 'SeleneOS-Maps/1.0');
  });

  await section('keyboard: Ctrl+F, tabs, panel toggle', async () => {
    await s.page.focus(`${WIN} .mp-map`);
    await s.page.keyboard.press('Control+f');
    check('Ctrl+F focuses the search box', await s.page.evaluate(`document.activeElement.classList.contains('mp-input')`), true);
    await s.page.focus(`${WIN} .mp-tab[data-tab=places]`);
    await s.page.keyboard.press('ArrowLeft');
    check('arrow keys switch tabs', await M(s, (m) => m.tab), 'results');
    await s.page.click(`${WIN} .mp-panel-btn`);
    await sleep(150);
    check('panel hidden', await s.page.evaluate(`getComputedStyle(document.querySelector('.win.app-maps .mp-side')).display`), 'none');
    check('aria-expanded false', await s.page.getAttribute(`${WIN} .mp-panel-btn`, 'aria-expanded'), 'false');
    await s.page.click(`${WIN} .mp-panel-btn`);
    await sleep(150);
    check('panel shown again', await s.page.evaluate(`getComputedStyle(document.querySelector('.win.app-maps .mp-side')).display`), 'flex');
  });

  await section('screenshot light EN + console', async () => {
    await s.page.fill(`${WIN} .mp-input`, 'paris');
    await s.page.press(`${WIN} .mp-input`, 'Enter');
    await until(s, (m) => m.results.length === 3, { label: 'results' });
    await s.page.click(`${WIN} .mp-save`);
    await until(s, (m) => m.places.length === 1, { label: 'saved' });
    await until(s, (m) => m.tileStats.inFlight === 0 && m.tileStats.queued === 0, { label: 'tiles' });
    check('no null/undefined text', await badText(s), '');
    await shot(s, 'light-en');
    check('no Maps console errors', mapsErrors(s), []);
  });
} finally {
  await s.close();
}

// ---------------------------------------------------------------- FR, dark
s = await launchShell({ open: ['maps'], lang: 'fr', theme: 'dark' });
try {
  await section('French + dark theme', async () => {
    await s.page.waitForSelector(WIN, { timeout: 15000 });
    await until(s, (m) => m && m.tileStats.elements > 0, { label: 'tiles' });
    check('FR tab', await text(s, `${WIN} .mp-tab[data-tab=places]`), 'Mes lieux');
    check('FR attribution', await text(s, `${WIN} .mp-attrib`), '© les contributeurs d’OpenStreetMap');
    check('FR placeholder', await s.page.getAttribute(`${WIN} .mp-input`, 'placeholder'), 'Rechercher un lieu ou une adresse');
    check('dark theme applied', await s.page.evaluate(`document.documentElement.dataset.theme`), 'dark');
    // the empty map shows the theme's sunken surface (--bg-alt), dark in dark mode
    const [mapBg, sunken] = await s.page.evaluate(() => {
      const m = document.querySelector('.win.app-maps .mp-map');
      const p = document.createElement('div');
      p.style.background = 'var(--bg-alt)';
      m.parentElement.appendChild(p);
      const t = getComputedStyle(p).backgroundColor;
      p.remove();
      return [getComputedStyle(m).backgroundColor, t];
    });
    check('dark map background is the sunken surface', mapBg, sunken);
    check('dark map background is dark', mapBg, (v) => v.match(/\d+/g).slice(0, 3).map(Number).reduce((a, b) => a + b, 0) / 3 < 60);
    await s.page.fill(`${WIN} .mp-input`, 'tour eiffel');
    await s.page.press(`${WIN} .mp-input`, 'Enter');
    await until(s, (m) => m.selected && m.selected.name === 'Tour Eiffel', { label: 'Tour Eiffel' });
    check('FR status', await text(s, `${WIN} .mp-status`), '1 résultat');
    check('FR card button', await text(s, `${WIN} .mp-save`), 'Enregistrer');
    await s.page.fill(`${WIN} .mp-input`, 'montreal');
    await s.page.press(`${WIN} .mp-input`, 'Enter');
    await until(s, (m) => m.selected && m.selected.name === 'Montréal', { label: 'Montréal', timeout: 6000 });
    check('FR coordinates (O = ouest)', await text(s, `${WIN} .mp-card-coords`), (v) => /° N, [\d.]+° O$/.test(v || ''));
    check('FR display name', (await M(s, (m) => m.selected)).display, (d) => d.includes('Québec'));
    await s.page.click(`${WIN} .mp-save`);
    await until(s, (m) => m.places.length === 1, { label: 'saved' });
    check('FR saved', await text(s, `${WIN} .mp-save`), 'Enregistré');
    await until(s, (m) => m.tileStats.inFlight === 0 && m.tileStats.queued === 0, { label: 'tiles' });
    const sc = await text(s, `${WIN} .mp-scale-text`);
    check('FR scale bar', sc, (v) => /^\d[\d\s ,]* (m|km)$/.test(v || ''));
    check('no null/undefined text (FR)', await badText(s), '');
    await shot(s, 'dark-fr');
    check('no Maps console errors (FR)', mapsErrors(s), []);
  });
} finally {
  await s.close();
}

console.log(`\n${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL ${f}`);
process.exit(failures.length ? 1 : 0);
