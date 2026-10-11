// Weather: current conditions (temperature, feels like, wind, humidity), the next 24 hours, a 7-day forecast, city
// search (weather:search), saved places, °C / °F and km/h / mph, and "Use for the wallpaper and widgets"
// (settings.dynamicWallpaper.location). Data: weather:forecast (main/ipc/weather.js, Open-Meteo, 30 min cache,
// deterministic mock in dev / tests).
// Storage (ctx.storage 'state'): { places: [{ name, admin1, country, lat, lon }], current: 'lat,lon' key, temp: 'c'|'f',
//   wind: 'kmh'|'mph' }.
// Test / automation hook: the window element exposes this object as `el.__weather`.
import { WEATHER_TEXT, weatherIconName } from '../../core/wallpaper/weather-text.js';

export const placeKey = (p) => `${Number(p.lat).toFixed(2)},${Number(p.lon).toFixed(2)}`;
/** °C → the display unit, rounded, never "-0". null → ''. */
export function tempIn(c, unit) {
  if (c == null || !Number.isFinite(Number(c))) return '';
  const v = Math.round(unit === 'f' ? (Number(c) * 9) / 5 + 32 : Number(c));
  return String(Object.is(v, -0) ? 0 : v);
}
/** km/h → the display unit, rounded. */
export function windIn(kmh, unit) {
  if (kmh == null || !Number.isFinite(Number(kmh))) return '';
  return String(Math.round(unit === 'mph' ? Number(kmh) / 1.609344 : Number(kmh)));
}
export function compass(deg) {
  if (deg == null || !Number.isFinite(Number(deg))) return '';
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round((((Number(deg) % 360) + 360) % 360) / 45) % 8];
}
// "2026-10-11T16:00" → a UTC Date with the same wall-clock fields (formatted with timeZone UTC: no DST surprises)
function wall(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(String(iso || ''));
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0))) : null;
}
function sanitizePlace(p) {
  if (!p || typeof p !== 'object') return null;
  const lat = Number(p.lat);
  const lon = Number(p.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const s = (v) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80) : '');
  return { name: s(p.name) || `${lat.toFixed(2)}, ${lon.toFixed(2)}`, admin1: s(p.admin1), country: s(p.country), lat, lon };
}

class WeatherApp {
  constructor(ctx) {
    this.ctx = ctx;
    this.win = ctx.win;
    this.h = ctx.h;
    this.t = ctx.t;
    this.state = { places: [], current: null, temp: 'c', wind: 'kmh' };
    this.forecasts = new Map(); // key -> forecast
    this.errors = new Map(); // key -> error code
    this.loading = new Set();
    this.results = [];
    this.active = -1;
    this.searchSeq = 0;
    this.searchTimer = 0;
    this.unsubs = [];
    this.win.el.__weather = this;
  }

  get locale() {
    return this.ctx.lang === 'fr' ? 'fr-FR' : 'en-US';
  }
  get place() {
    return this.state.places.find((p) => placeKey(p) === this.state.current) || null;
  }

  async init() {
    const saved = await this.ctx.storage.get('state', null).catch(() => null);
    if (saved && typeof saved === 'object') {
      this.state.places = (Array.isArray(saved.places) ? saved.places : []).map(sanitizePlace).filter(Boolean).slice(0, 30);
      this.state.temp = saved.temp === 'f' ? 'f' : 'c';
      this.state.wind = saved.wind === 'mph' ? 'mph' : 'kmh';
      this.state.current = typeof saved.current === 'string' ? saved.current : null;
    }
    // first run: start with the place of the dynamic wallpaper, if one is set
    if (!this.state.places.length) {
      const wp = sanitizePlace(this.ctx.settings.get('dynamicWallpaper.location'));
      if (wp) this.state.places.push(wp);
    }
    if (!this.place && this.state.places.length) this.state.current = placeKey(this.state.places[0]);
    this.build();
    this.unsubs.push(this.ctx.settings.on('dynamicWallpaper', () => this.renderWallpaperButton()));
    this.ctx.onLangChange(() => {
      this.build();
      this.renderAll();
    });
    this.ctx.onClose(() => {
      clearTimeout(this.searchTimer);
      for (const u of this.unsubs) u?.();
    });
    this.renderAll();
    if (this.place) await this.load(this.place);
    else this.input.focus();
    for (const p of this.state.places) if (placeKey(p) !== this.state.current) this.load(p, { quiet: true });
  }

  save() {
    return this.ctx.storage.set('state', this.state).catch(() => {});
  }

  announce(text) {
    if (!this.live) return;
    this.live.textContent = '';
    setTimeout(() => (this.live.textContent = text), 30);
  }

  // ------------------------------------------------------------------ chrome
  build() {
    const { h, t, ui, icon } = { ...this.ctx, h: this.h, t: this.t };
    this.input = h('input', {
      class: 'input wx-search-input',
      type: 'search',
      placeholder: t('search.placeholder'),
      'aria-label': t('search.label'),
      role: 'combobox',
      'aria-autocomplete': 'list',
      'aria-expanded': 'false',
      'aria-controls': 'wx-results',
      autocomplete: 'off',
      spellcheck: 'false',
      oninput: () => this.onSearchInput(),
      onkeydown: (e) => this.onSearchKey(e),
      onblur: () => setTimeout(() => this.root?.contains(document.activeElement) && document.activeElement === this.input ? null : this.closeResults(), 150),
    });
    this.resultsEl = h('ul', { class: 'wx-results', id: 'wx-results', role: 'listbox', 'aria-label': t('search.results'), hidden: true });
    this.placesEl = h('ul', { class: 'wx-places', 'aria-label': t('places.title'), onkeydown: (e) => this.onPlacesKey(e) });
    this.tempSeg = ui.segmented({
      options: [
        { value: 'c', label: '°C' },
        { value: 'f', label: '°F' },
      ],
      value: this.state.temp,
      onchange: (v) => this.setUnit('temp', v),
    });
    this.tempSeg.classList.add('wx-seg-temp');
    this.tempSeg.setAttribute('role', 'group');
    this.tempSeg.setAttribute('aria-label', t('units.temp'));
    this.windSeg = ui.segmented({
      options: [
        { value: 'kmh', label: 'km/h' },
        { value: 'mph', label: 'mph' },
      ],
      value: this.state.wind,
      onchange: (v) => this.setUnit('wind', v),
    });
    this.windSeg.classList.add('wx-seg-wind');
    this.windSeg.setAttribute('role', 'group');
    this.windSeg.setAttribute('aria-label', t('units.wind'));
    this.markSegments();
    this.refreshBtn = h('button', { class: 'btn subtle wx-refresh', 'aria-label': t('refresh'), 'data-tip': t('refresh'), onclick: () => this.place && this.load(this.place, { force: true }) }, icon('arrow_sync'));
    this.titleEl = h('h1', { class: 'wx-title' });
    this.content = h('div', { class: 'wx-content' });
    this.live = h('div', { class: 'wx-live', 'aria-live': 'polite', role: 'status' });
    const root = h(
      'div',
      { class: 'wx', 'data-units': `${this.state.temp},${this.state.wind}` },
      h(
        'div',
        { class: 'wx-layout' },
        h(
        'aside',
        { class: 'wx-side' },
        h('div', { class: 'wx-search' }, h('span', { class: 'wx-search-icon', 'aria-hidden': 'true' }, icon('search')), this.input, this.resultsEl),
        h('h2', { class: 'wx-side-title' }, t('places.title')),
        this.placesEl,
      ),
        h('main', { class: 'wx-main' }, h('div', { class: 'wx-bar' }, this.titleEl, h('div', { class: 'wx-bar-tools' }, this.tempSeg, this.windSeg, this.refreshBtn)), this.content),
      ),
      this.live,
    );
    this.root = root;
    this.win.body.replaceChildren(root);
    this.win.setTitle?.(t('app'));
  }

  markSegments() {
    for (const [seg, v] of [
      [this.tempSeg, this.state.temp],
      [this.windSeg, this.state.wind],
    ]) {
      seg.querySelectorAll('button').forEach((b, i) => {
        const val = seg === this.tempSeg ? ['c', 'f'][i] : ['kmh', 'mph'][i];
        b.dataset.value = val;
        b.setAttribute('aria-pressed', String(val === v));
      });
    }
  }

  setUnit(kind, v) {
    this.state[kind] = v;
    this.save();
    this.tempSeg.setValue(this.state.temp);
    this.windSeg.setValue(this.state.wind);
    this.markSegments();
    this.root.dataset.units = `${this.state.temp},${this.state.wind}`;
    this.renderAll();
    // keep the focus on the segment the user just used
    const seg = kind === 'temp' ? this.tempSeg : this.windSeg;
    seg.querySelector(`button[data-value="${v}"]`)?.focus();
  }

  renderAll() {
    this.renderPlaces();
    this.renderForecast();
  }

  // ------------------------------------------------------------------ search
  onSearchInput() {
    clearTimeout(this.searchTimer);
    this.pickOnResults = false;
    const q = this.input.value.trim();
    if (q.length < 2) {
      this.searchSeq++;
      this.closeResults();
      return;
    }
    this.searchTimer = setTimeout(() => this.search(q), 220);
  }

  async search(q) {
    const seq = ++this.searchSeq;
    this.showResults([], 'searching');
    let results = [];
    let state = 'ok';
    try {
      results = await this.ctx.api.invoke('weather:search', q, { lang: this.ctx.lang, count: 8 });
    } catch {
      state = 'offline';
    }
    if (seq !== this.searchSeq || this.win.closed) return;
    this.showResults(Array.isArray(results) ? results : [], state);
    // Enter pressed before the results arrived: take the first one
    if (this.pickOnResults) {
      this.pickOnResults = false;
      if (this.results.length) this.pick(0);
    }
  }

  showResults(list, state) {
    const { h, t } = this;
    this.results = list.map(sanitizePlace).filter(Boolean);
    this.active = this.results.length ? 0 : -1;
    const items = this.results.map((r, i) =>
      h(
        'li',
        {
          class: 'wx-result',
          id: `wx-result-${i}`,
          role: 'option',
          'aria-selected': String(i === this.active),
          onmousedown: (e) => e.preventDefault(),
          onclick: () => this.pick(i),
        },
        h('span', { class: 'wx-result-name' }, r.name),
        h('span', { class: 'wx-result-sub' }, [r.admin1, r.country].filter(Boolean).join(', ')),
      ),
    );
    if (!items.length) {
      const msg = state === 'searching' ? t('search.searching') : state === 'offline' ? t('search.offline') : t('search.none');
      items.push(h('li', { class: 'wx-result-empty', role: 'option', 'aria-disabled': 'true' }, msg));
    }
    this.resultsEl.replaceChildren(...items);
    this.resultsEl.hidden = false;
    this.input.setAttribute('aria-expanded', 'true');
    this.updateActive();
  }

  updateActive() {
    this.resultsEl.querySelectorAll('.wx-result').forEach((li, i) => {
      li.classList.toggle('active', i === this.active);
      li.setAttribute('aria-selected', String(i === this.active));
      if (i === this.active) li.scrollIntoView?.({ block: 'nearest' });
    });
    if (this.active >= 0) this.input.setAttribute('aria-activedescendant', `wx-result-${this.active}`);
    else this.input.removeAttribute('aria-activedescendant');
  }

  closeResults() {
    if (!this.resultsEl) return;
    this.resultsEl.hidden = true;
    this.resultsEl.replaceChildren();
    this.pickOnResults = false;
    this.results = [];
    this.active = -1;
    this.input.setAttribute('aria-expanded', 'false');
    this.input.removeAttribute('aria-activedescendant');
  }

  onSearchKey(e) {
    const open = !this.resultsEl.hidden && this.results.length;
    if (e.key === 'ArrowDown' && open) {
      e.preventDefault();
      this.active = (this.active + 1) % this.results.length;
      this.updateActive();
    } else if (e.key === 'ArrowUp' && open) {
      e.preventDefault();
      this.active = (this.active - 1 + this.results.length) % this.results.length;
      this.updateActive();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (open && this.active >= 0) this.pick(this.active);
      else if (this.input.value.trim().length >= 2) {
        clearTimeout(this.searchTimer);
        this.pickOnResults = true;
        this.search(this.input.value.trim());
      }
    } else if (e.key === 'Escape') {
      if (!this.resultsEl.hidden) {
        e.preventDefault();
        e.stopPropagation();
        this.closeResults();
      } else if (this.input.value) {
        e.preventDefault();
        e.stopPropagation();
        this.input.value = '';
      }
    }
  }

  pick(i) {
    const p = this.results[i];
    if (!p) return;
    this.input.value = '';
    this.searchSeq++;
    this.closeResults();
    this.addPlace(p);
  }

  // ------------------------------------------------------------------ places
  addPlace(p, { select = true } = {}) {
    const key = placeKey(p);
    if (!this.state.places.some((x) => placeKey(x) === key)) this.state.places.push(p);
    if (select) this.select(key);
    else {
      this.save();
      this.renderPlaces();
    }
  }

  select(key, { focus = false } = {}) {
    this.state.current = key;
    this.save();
    this.renderAll();
    if (focus) this.placesEl.querySelector(`[data-key="${key}"] .wx-place-btn`)?.focus();
    const p = this.place;
    if (p) this.load(p);
  }

  removePlace(key) {
    const i = this.state.places.findIndex((p) => placeKey(p) === key);
    if (i < 0) return;
    const [p] = this.state.places.splice(i, 1);
    this.forecasts.delete(key);
    if (this.state.current === key) {
      const next = this.state.places[Math.min(i, this.state.places.length - 1)];
      this.state.current = next ? placeKey(next) : null;
    }
    this.save();
    this.renderAll();
    this.announce(this.t('places.removed', { name: p.name }));
    const focusTo = this.placesEl.querySelectorAll('.wx-place-btn')[Math.min(i, this.state.places.length - 1)];
    if (focusTo) focusTo.focus();
    else this.input.focus();
    if (this.place && !this.forecasts.has(this.state.current)) this.load(this.place);
  }

  onPlacesKey(e) {
    const btns = [...this.placesEl.querySelectorAll('.wx-place-btn')];
    const idx = btns.indexOf(document.activeElement);
    if (idx < 0) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      btns[(idx + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length].focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      btns[e.key === 'Home' ? 0 : btns.length - 1].focus();
    } else if (e.key === 'Delete') {
      e.preventDefault();
      this.removePlace(btns[idx].closest('[data-key]').dataset.key);
    }
  }

  renderPlaces() {
    const { h, t } = this;
    const icon = this.ctx.icon;
    if (!this.state.places.length) {
      this.placesEl.replaceChildren(h('li', { class: 'wx-places-empty' }, t('places.empty')));
      return;
    }
    this.placesEl.replaceChildren(
      ...this.state.places.map((p) => {
        const key = placeKey(p);
        const f = this.forecasts.get(key);
        const sel = key === this.state.current;
        return h(
          'li',
          { class: ['wx-place', sel && 'selected'], 'data-key': key },
          h(
            'button',
            { class: 'wx-place-btn', 'aria-current': sel ? 'true' : null, onclick: () => this.select(key) },
            f ? h('span', { class: 'wx-place-icon', 'aria-hidden': 'true' }, icon(weatherIconName(f.current))) : h('span', { class: 'wx-place-icon', 'aria-hidden': 'true' }, icon('location')),
            h('span', { class: 'wx-place-text' }, h('span', { class: 'wx-place-name' }, p.name), h('span', { class: 'wx-place-sub' }, [p.admin1, p.country].filter(Boolean).join(', '))),
            h('span', { class: 'wx-place-temp' }, f ? `${tempIn(f.current.temperature, this.state.temp)}°` : ''),
          ),
          h('button', { class: 'btn subtle wx-place-del', 'aria-label': t('places.remove', { name: p.name }), 'data-tip': t('places.remove', { name: p.name }), tabindex: '-1', onclick: () => this.removePlace(key) }, icon('dismiss')),
        );
      }),
    );
  }

  // ------------------------------------------------------------------ data
  async load(p, { force = false, quiet = false } = {}) {
    const key = placeKey(p);
    if (this.loading.has(key) && !force) return;
    this.loading.add(key);
    if (!quiet && key === this.state.current && !this.forecasts.has(key)) this.renderForecast();
    try {
      const f = await this.ctx.api.invoke('weather:forecast', { lat: p.lat, lon: p.lon, name: p.name }, { force });
      if (this.win.closed) return;
      this.forecasts.set(key, f);
      this.errors.delete(key);
    } catch (e) {
      if (this.win.closed) return;
      this.errors.set(key, /EOFFLINE|ETIMEDOUT/.test(String(e?.code || e?.message)) ? 'offline' : 'generic');
    } finally {
      this.loading.delete(key);
    }
    if (!this.state.places.some((x) => placeKey(x) === key)) return;
    this.renderPlaces();
    if (key === this.state.current) this.renderForecast();
  }

  // ------------------------------------------------------------------ forecast view
  fmtT(c) {
    const v = tempIn(c, this.state.temp);
    return v === '' ? '–' : `${v}°`;
  }
  fmtHour(iso) {
    const d = wall(iso);
    return d ? new Intl.DateTimeFormat(this.locale, { hour: 'numeric', timeZone: 'UTC' }).format(d) : '';
  }
  fmtClock(iso) {
    const d = wall(iso);
    return d ? new Intl.DateTimeFormat(this.locale, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(d) : '';
  }
  describe(w) {
    const dict = WEATHER_TEXT[this.ctx.lang === 'fr' ? 'fr' : 'en'];
    return dict[w?.describe] || dict[w?.kind] || dict.clear;
  }

  renderForecast() {
    const { h, t } = this;
    const icon = this.ctx.icon;
    const p = this.place;
    this.titleEl.textContent = p ? p.name : t('app');
    this.refreshBtn.disabled = !p;
    if (!p) {
      this.content.replaceChildren(h('div', { class: 'empty wx-state wx-welcome' }, h('span', { class: 'wx-state-art', 'aria-hidden': 'true' }, icon('weather_partly_cloudy_day')), h('h2', {}, t('welcome.title')), h('p', {}, t('welcome.body'))));
      this.root.dataset.kind = '';
      return;
    }
    const key = placeKey(p);
    const f = this.forecasts.get(key);
    if (!f) {
      const err = this.errors.get(key);
      if (err && !this.loading.has(key)) {
        this.content.replaceChildren(
          h(
            'div',
            { class: 'empty wx-state wx-error' },
            h('span', { class: 'wx-state-art', 'aria-hidden': 'true' }, icon('cloud_dismiss')),
            h('h2', {}, t('error.title')),
            h('p', {}, t(err === 'offline' ? 'error.offline' : 'error.generic')),
            h('button', { class: 'btn primary wx-retry', onclick: () => this.load(p, { force: true }) }, t('error.retry')),
          ),
        );
      } else {
        this.content.replaceChildren(h('div', { class: 'wx-state wx-loading', role: 'status' }, h('div', { class: 'spinner' }), h('p', {}, t('loading'))));
      }
      this.root.dataset.kind = '';
      return;
    }
    const c = f.current;
    this.root.dataset.kind = c.kind || 'clear';
    this.root.dataset.day = c.isDay === false ? 'night' : 'day';
    const today = f.daily?.[0];
    const windUnit = this.state.wind === 'mph' ? 'mph' : 'km/h';
    const stat = (cls, ic, label, value) => h('div', { class: `wx-stat ${cls}` }, h('span', { class: 'wx-stat-icon', 'aria-hidden': 'true' }, icon(ic)), h('div', {}, h('div', { class: 'wx-stat-label' }, label), h('div', { class: 'wx-stat-value' }, value)));
    const updated = new Intl.DateTimeFormat(this.locale, { hour: 'numeric', minute: '2-digit' }).format(new Date(f.fetchedAt || Date.now()));
    this.wpBtn = h('button', { class: 'btn wx-wallpaper', onclick: () => this.useForWallpaper() });
    const hero = h(
      'section',
      { class: 'wx-hero', 'aria-label': p.name },
      h(
        'div',
        { class: 'wx-hero-main' },
        h('span', { class: 'wx-hero-icon', 'aria-hidden': 'true', 'data-icon-name': weatherIconName(c) }, icon(weatherIconName(c))),
        h('div', { class: 'wx-hero-temp' }, h('span', { class: 'wx-temp-val' }, tempIn(c.temperature, this.state.temp) || '–'), h('span', { class: 'wx-temp-unit' }, this.state.temp === 'f' ? '°F' : '°C')),
        h(
          'div',
          { class: 'wx-hero-text' },
          h('div', { class: 'wx-hero-desc' }, this.describe(c)),
          h('div', { class: 'wx-hero-feels' }, c.apparent == null ? '' : t('feelsLike', { temp: this.fmtT(c.apparent) })),
          today ? h('div', { class: 'wx-hero-range' }, t('dayRange', { min: this.fmtT(today.min), max: this.fmtT(today.max) })) : null,
        ),
      ),
      h(
        'div',
        { class: 'wx-stats' },
        stat('wx-stat-wind', 'weather_squalls', t('wind'), c.wind == null ? '–' : `${windIn(c.wind, this.state.wind)} ${windUnit}${c.windDir == null ? '' : ` ${t(`dirs.${compass(c.windDir)}`)}`}`),
        stat('wx-stat-humidity', 'weather_humidity', t('humidity'), c.humidity == null ? '–' : `${Math.round(c.humidity)} %`),
        stat('wx-stat-precip', 'drop', t('precip'), f.hourly?.[0]?.precipProb == null ? '–' : `${Math.round(f.hourly[0].precipProb)} %`),
        today?.sunrise ? stat('wx-stat-sunrise', 'weather_sunny_low', t('sunrise'), this.fmtClock(today.sunrise)) : null,
        today?.sunset ? stat('wx-stat-sunset', 'weather_moon', t('sunset'), this.fmtClock(today.sunset)) : null,
      ),
      h('div', { class: 'wx-hero-foot' }, h('span', { class: ['wx-updated', f.stale && 'stale'] }, f.stale ? t('stale', { time: updated }) : t('updated', { time: updated })), this.wpBtn),
    );
    const hours = h(
      'ol',
      { class: 'wx-hours', tabindex: '0', 'aria-label': t('hourly') },
      ...(f.hourly || []).map((x, i) =>
        h(
          'li',
          { class: 'wx-hour' },
          h('span', { class: 'wx-hour-time' }, i === 0 ? t('now') : this.fmtHour(x.time)),
          h('span', { class: 'wx-hour-icon', title: this.describe(x) }, icon(weatherIconName(x))),
          h('span', { class: 'wx-hour-temp' }, this.fmtT(x.temperature)),
          h('span', { class: 'wx-hour-precip', 'aria-label': `${t('precip')} ${Math.round(x.precipProb || 0)} %` }, x.precipProb >= 20 ? `${Math.round(x.precipProb)} %` : ''),
        ),
      ),
    );
    hours.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        hours.scrollBy({ left: e.key === 'ArrowRight' ? 160 : -160 });
      }
    });
    const daily = f.daily || [];
    const lo = Math.min(...daily.map((d) => d.min).filter(Number.isFinite));
    const hi = Math.max(...daily.map((d) => d.max).filter(Number.isFinite));
    const span = hi - lo || 1;
    const wdFmt = new Intl.DateTimeFormat(this.locale, { weekday: 'short', timeZone: 'UTC' });
    const days = h(
      'ol',
      { class: 'wx-days', 'aria-label': t('daily') },
      ...daily.map((d, i) => {
        const dt = wall(d.date);
        const label = i === 0 ? t('today') : `${wdFmt.format(dt)} ${dt.getUTCDate()}`;
        return h(
          'li',
          { class: 'wx-day' },
          h('span', { class: 'wx-day-name' }, label),
          h('span', { class: 'wx-day-icon', 'aria-hidden': 'true' }, icon(weatherIconName({ ...d, isDay: true }))),
          h('span', { class: 'wx-day-desc' }, this.describe(d)),
          h('span', { class: 'wx-day-precip' }, d.precipProb >= 20 ? h('span', {}, icon('drop'), `${Math.round(d.precipProb)} %`) : ''),
          h('span', { class: 'wx-day-min', 'aria-label': t('dayRange', { min: this.fmtT(d.min), max: this.fmtT(d.max) }) }, this.fmtT(d.min)),
          h('span', { class: 'wx-day-bar', 'aria-hidden': 'true' }, h('span', { class: 'wx-day-fill', style: { left: `${(((d.min ?? lo) - lo) / span) * 100}%`, right: `${((hi - (d.max ?? hi)) / span) * 100}%` } })),
          h('span', { class: 'wx-day-max', 'aria-hidden': 'true' }, this.fmtT(d.max)),
        );
      }),
    );
    this.content.replaceChildren(hero, h('section', { class: 'wx-section' }, h('h2', { class: 'wx-section-title' }, t('hourly')), hours), h('section', { class: 'wx-section' }, h('h2', { class: 'wx-section-title' }, t('daily')), days));
    this.renderWallpaperButton();
  }

  // ------------------------------------------------------------------ wallpaper and widgets
  isWallpaperPlace() {
    const loc = this.ctx.settings.get('dynamicWallpaper.location');
    const p = this.place;
    return !!(p && loc && Number.isFinite(Number(loc.lat)) && placeKey(loc) === placeKey(p));
  }

  renderWallpaperButton() {
    if (!this.wpBtn || !this.wpBtn.isConnected) return;
    const on = this.isWallpaperPlace();
    this.wpBtn.classList.toggle('on', on);
    this.wpBtn.setAttribute('aria-pressed', String(on));
    this.wpBtn.replaceChildren(this.ctx.icon(on ? 'checkmark' : 'image'), this.t(on ? 'usedWallpaper' : 'useWallpaper'));
  }

  async useForWallpaper() {
    const p = this.place;
    if (!p) return;
    await this.ctx.settings.set('dynamicWallpaper.location', { name: p.name, lat: p.lat, lon: p.lon });
    if (this.win.closed) return;
    this.renderWallpaperButton();
    this.announce(this.t('wallpaperSet', { name: p.name }));
  }
}

export default {
  async launch(ctx) {
    const app = new WeatherApp(ctx);
    await app.init();
    return {
      onRelaunch: () => app.input?.focus(),
    };
  },
};
