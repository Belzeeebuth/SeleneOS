// Clock — World clock page: world map with the real day/night terminator (civil / nautical /
// astronomical twilight bands) and city pins, local time card with an analog clock (smooth second
// hand), city cards (time, date, offset vs local, day/night), compare mode (shift the time and see every
// city at that moment), add-city search over the bundled list, delete and drag / keyboard reorder.
import { zoneParts, offsetFromLocal, shortOffset, longOffset, dayDelta, localZone, zoneOffset, formatDate } from './time.js';
import { nightPath, solarPosition, daylight, sunTimes } from './sun.js';
import { cityById, cityName, cityPlace, searchCities, localCity } from './cities.js';
import { analogClock, commandBar, enter, reduceMotion, svg } from './widgets.js';

const MAP_TOP = 6; // the map shows latitudes 84°N .. 58°S
const MAP_H = 142;
const WRAP = [-360, 0, 360];
let worldData = null;

export class WorldPage {
  constructor(app) {
    this.app = app;
    this.editing = false;
    this.compare = false;
    this.shift = 0; // minutes added to "now" in compare mode
    this.cards = new Map();
    this.lastMapMinute = null;
  }

  get store() {
    return this.app.store;
  }

  at(now = Date.now()) {
    return now + (this.compare ? this.shift * 60000 : 0);
  }

  build() {
    const { h, t, icon } = this.app;
    this.tz = localZone();
    // ---- map
    // The map wraps around: on a window wider than the map's 360° x 142° aspect, the view widens
    // (layoutMap) and the copies of the land and of the sun at ±360° fill the sides seamlessly, so
    // the map never stretches or shows empty bands. The night paths already repeat at ±360°.
    this.lands = WRAP.map((dx) => svg('path', { class: 'ck-land', d: '', transform: dx ? `translate(${dx} 0)` : null }));
    this.land = this.lands[1];
    this.nights = [0, -6, -12, -18].map((a, i) => svg('path', { class: `ck-night n${i}`, d: '', 'fill-rule': 'nonzero' }));
    this.suns = WRAP.map(() => svg('g', { class: 'ck-sun' }, svg('circle', { r: 7, class: 'ck-sun-glow' }), svg('circle', { r: 2.4, class: 'ck-sun-core' })));
    this.sun = this.suns[1];
    this.view = { x: 0, w: 360 };
    this.mapSvg = svg(
      'svg',
      { class: 'ck-map-svg', viewBox: `0 ${MAP_TOP} 360 ${MAP_H}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': t('world.mapLabel') },
      svg('rect', { class: 'ck-ocean', x: -360, y: 0, width: 1080, height: 180 }),
      ...this.lands,
      ...this.nights,
      ...this.suns,
    );
    this.pins = h('div', { class: 'ck-pins' });
    this.map = h('div', { class: 'ck-map' }, this.mapSvg, this.pins);
    this.mapCard = h('div', { class: 'card ck-map-card' }, this.map);
    // the map's own size (not only the window's) decides the view and the pin positions
    this.mapRO = new ResizeObserver(() => this.layoutPins());
    this.mapRO.observe(this.map);
    this.loadMap();
    // ---- compare bar
    this.cmpLabel = h('div', { class: 'ck-cmp-label body-strong' });
    this.cmpSub = h('div', { class: 'ck-cmp-sub caption text-2' });
    this.cmpSlider = this.app.ui.slider({ min: -1440, max: 1440, step: 15, value: 0, oninput: (v) => this.setShift(v) });
    this.cmpSlider.classList.add('ck-cmp-slider');
    this.cmpSlider.setAttribute('aria-label', t('world.compareSlider'));
    this.cmpBar = h(
      'div',
      { class: 'card ck-compare', hidden: true },
      h('div', { class: 'ck-cmp-head' }, icon('clock', { size: 18 }), h('div', { class: 'grow' }, this.cmpLabel, this.cmpSub), h('button', { type: 'button', class: 'btn', onclick: () => this.setShift(0, true) }, t('world.now'))),
      h('div', { class: 'ck-cmp-row' }, h('span', { class: 'caption text-2' }, t('world.minus24')), this.cmpSlider, h('span', { class: 'caption text-2' }, t('world.plus24'))),
    );
    // ---- cards
    this.grid = h('div', { class: 'ck-grid ck-city-grid', role: 'list' });
    this.error = h('div', { class: 'infobar error', hidden: !this.app.citiesError, role: 'alert' }, icon('error_circle', { filled: true }), h('div', null, t('world.loadError')));
    this.cmd = commandBar(h, [
      { icon: icon('timeline'), label: t('world.compare'), className: 'ck-cmd-compare', ref: (el) => (this.cmpBtn = el), onclick: () => this.setCompare(!this.compare) },
      { icon: icon('edit'), label: t('world.edit'), className: 'ck-cmd-edit', ref: (el) => (this.editBtn = el), onclick: () => this.setEditing(!this.editing) },
      { icon: icon('add'), label: t('world.add'), className: 'ck-cmd-add', onclick: () => this.openSearch() },
    ]);
    this.el = h('section', { class: 'ck-world' }, this.error, this.mapCard, this.cmpBar, this.grid, this.cmd);
    this.render();
    return this.el;
  }

  async loadMap() {
    try {
      if (!worldData) {
        const r = await fetch(this.app.ctx.appUrl('data/world.json'));
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        worldData = await r.json();
      }
      for (const l of this.lands) l.setAttribute('d', worldData.land || '');
    } catch (err) {
      console.error('[clock] world map failed to load', err);
    }
  }

  show() {
    this.render();
  }

  hide() {
    if (this.compare) this.setCompare(false);
  }

  onResize() {
    this.layoutPins();
  }

  // ------------------------------------------------------------------ modes
  setEditing(on) {
    const { t, icon } = this.app;
    this.editing = !!on && this.store.cities.length > 0;
    this.el.classList.toggle('editing', this.editing);
    this.editBtn.replaceChildren(icon(this.editing ? 'checkmark' : 'edit'));
    const label = this.editing ? t('common.done') : t('world.edit');
    this.editBtn.dataset.tip = label;
    this.editBtn.setAttribute('aria-label', label);
    this.editBtn.classList.toggle('primary', this.editing);
    this.editBtn.classList.toggle('subtle', !this.editing);
    for (const c of this.cards.values()) c.handle && (c.handle.tabIndex = this.editing ? 0 : -1);
  }

  setCompare(on) {
    this.compare = !!on;
    this.cmpBar.hidden = !this.compare;
    this.el.classList.toggle('comparing', this.compare);
    this.cmpBtn.classList.toggle('primary', this.compare);
    this.cmpBtn.classList.toggle('subtle', !this.compare);
    this.cmpBtn.setAttribute('aria-pressed', String(this.compare));
    if (!this.compare) this.shift = 0;
    this.cmpSlider.setValue(this.shift);
    if (this.compare) {
      enter(this.cmpBar, { y: -8 });
      this.cmpSlider.focus();
    }
    this.lastMapMinute = null;
    this.tick(Date.now(), true);
  }

  setShift(mins, focus = false) {
    this.shift = Math.max(-1440, Math.min(1440, Math.round(mins / 15) * 15));
    this.cmpSlider.setValue(this.shift);
    if (focus) this.cmpSlider.focus();
    this.lastMapMinute = null;
    this.tick(Date.now(), true);
  }

  // ------------------------------------------------------------------ cards
  entries() {
    const local = localCity(this.tz);
    const list = [{ key: 'local', city: local, local: true }];
    for (const id of this.store.cities) {
      const c = cityById(id);
      if (c) list.push({ key: id, city: c, local: false });
    }
    return list;
  }

  render() {
    if (!this.el) return;
    this.tz = localZone();
    const entries = this.entries();
    const keys = new Set(entries.map((e) => e.key));
    for (const [k, c] of this.cards) {
      if (!keys.has(k)) {
        c.el.remove();
        this.cards.delete(k);
      }
    }
    entries.forEach((e, i) => {
      let c = this.cards.get(e.key);
      if (!c || c.city !== e.city) {
        c?.el.remove();
        c = this.makeCard(e);
        this.cards.set(e.key, c);
      }
      if (this.grid.children[i] !== c.el) this.grid.insertBefore(c.el, this.grid.children[i] || null);
    });
    if (!this.store.cities.length && this.editing) this.setEditing(false);
    this.renderPins();
    this.lastMapMinute = null;
    this.tick(Date.now(), true);
  }

  makeCard(e) {
    const { h, t, icon, lang } = this.app;
    const c = { key: e.key, city: e.city, local: e.local, tz: e.local ? this.tz : e.city.tz };
    c.face = analogClock({ className: e.local ? 'big' : 'small', seconds: e.local });
    c.time = h('span', { class: 'ck-city-clock' });
    c.period = h('span', { class: 'ck-city-period' });
    c.rel = h('div', { class: 'ck-city-rel caption text-2' });
    c.date = h('div', { class: 'ck-city-date caption text-2' });
    const name = e.local ? t('world.local') : cityName(e.city, lang);
    const place = e.local ? (e.city.synthetic ? e.city.tz.replace(/_/g, ' ') : `${cityName(e.city, lang)}, ${cityPlace(e.city, lang)}`) : cityPlace(e.city, lang);
    if (!e.local) {
      c.handle = h('span', { class: 'ck-city-handle', 'aria-hidden': 'true', tabindex: '-1' }, icon('re_order_dots_vertical', { size: 16 }));
      c.handle.addEventListener('pointerdown', (ev) => this.startDrag(ev, c));
      c.del = h(
        'button',
        { type: 'button', class: 'btn subtle icon-btn ck-card-del', 'aria-label': t('world.remove'), 'data-tip': t('world.remove'), onclick: (ev) => (ev.stopPropagation(), this.store.removeCity(e.key)) },
        icon('delete'),
      );
    }
    c.el = h(
      'div',
      {
        class: ['card', 'ck-card', 'ck-city', e.local && 'local'],
        role: 'listitem',
        tabindex: '0',
        dataset: { id: e.key, tz: c.tz },
        'aria-label': `${name}, ${place}`,
        oncontextmenu: e.local ? null : (ev) => this.menu(ev, e.key),
        onkeydown: (ev) => {
          if (e.local || ev.target !== c.el) return;
          if (ev.altKey && (ev.key === 'ArrowUp' || ev.key === 'ArrowLeft')) {
            ev.preventDefault();
            this.move(e.key, -1);
          } else if (ev.altKey && (ev.key === 'ArrowDown' || ev.key === 'ArrowRight')) {
            ev.preventDefault();
            this.move(e.key, 1);
          } else if (ev.key === 'Delete') {
            ev.preventDefault();
            this.store.removeCity(e.key);
          }
        },
      },
      c.handle,
      h('div', { class: 'ck-city-face' }, c.face),
      h(
        'div',
        { class: 'ck-city-body' },
        h('div', { class: 'ck-city-name ellipsis' }, name),
        h('div', { class: 'ck-city-place caption text-2 ellipsis' }, place),
        h('div', { class: 'ck-city-time' }, c.time, c.period),
        c.rel,
        c.date,
      ),
      e.local && e.city.lat != null ? (c.sun = h('div', { class: 'ck-sun-info' })) : null,
      c.del,
    );
    enter(c.el, { y: 12 });
    return c;
  }

  // sunrise / sunset / day length of the local city (shown on wide windows)
  fillSun(c, at) {
    const { h, t, icon } = this.app;
    const d = new Date(at);
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
    if (c.sunDay === start) return;
    c.sunDay = start;
    const st = sunTimes(c.city.lat, c.city.lon, start, end);
    const row = (ic, label, v) => h('div', { class: 'ck-sun-row' }, icon(ic), h('div', null, h('div', { class: 'caption text-2' }, label), h('div', { class: 'v' }, v)));
    const rows = [];
    if (st.polar) rows.push(row(st.polar === 'day' ? 'weather_sunny' : 'weather_moon', t(st.polar === 'day' ? 'world.polarDay' : 'world.polarNight'), '—'));
    else {
      rows.push(row('weather_sunny_high', t('world.sunrise'), st.rise ? this.app.timeText(st.rise) : '—'));
      rows.push(row('weather_sunny_low', t('world.sunset'), st.set ? this.app.timeText(st.set) : '—'));
      if (st.rise && st.set && st.set > st.rise) rows.push(row('clock', t('world.dayLength'), durText(t, Math.round((st.set - st.rise) / 60000))));
    }
    c.sun.replaceChildren(...rows);
  }

  move(id, d) {
    const i = this.store.cities.indexOf(id);
    if (i < 0) return;
    this.store.moveCity(id, i + d);
    setTimeout(() => this.cards.get(id)?.el.focus(), 0);
  }

  menu(e, id) {
    const { t, ui } = this.app;
    const i = this.store.cities.indexOf(id);
    ui.menu(e, [
      { label: t('world.moveUp'), icon: 'arrow_up', disabled: i <= 0, action: () => this.move(id, -1) },
      { label: t('world.moveDown'), icon: 'arrow_down', disabled: i >= this.store.cities.length - 1, action: () => this.move(id, 1) },
      '-',
      { label: t('world.remove'), icon: 'delete', danger: true, action: () => this.store.removeCity(id) },
    ]);
  }

  // pointer reorder (edit mode handle or long press): the card follows the pointer, others make room
  startDrag(ev, c) {
    if (ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    const el = c.el;
    const start = { x: ev.clientX, y: ev.clientY };
    let rect = el.getBoundingClientRect();
    let off = { x: 0, y: 0 };
    el.classList.add('dragging');
    // capture on the grid: the card itself moves in the DOM while dragging, which would drop its capture
    const host = this.grid;
    try {
      host.setPointerCapture(ev.pointerId);
    } catch {}
    const move = (e) => {
      off = { x: e.clientX - start.x, y: e.clientY - start.y };
      el.style.transform = `translate(${off.x}px, ${off.y}px)`;
      const cx = e.clientX;
      const cy = e.clientY;
      const others = [...this.grid.children].filter((x) => x !== el && !x.classList.contains('local'));
      for (const o of others) {
        const r = o.getBoundingClientRect();
        if (cx > r.left && cx < r.right && cy > r.top && cy < r.bottom) {
          const before = [...this.grid.children].indexOf(o) < [...this.grid.children].indexOf(el);
          const prev = el.getBoundingClientRect();
          this.grid.insertBefore(el, before ? o : o.nextSibling);
          const now = el.getBoundingClientRect();
          // keep the card under the pointer after it changed slot
          start.x += now.left - prev.left;
          start.y += now.top - prev.top;
          rect = { left: rect.left + now.left - prev.left, top: rect.top + now.top - prev.top, width: rect.width, height: rect.height };
          off = { x: e.clientX - start.x, y: e.clientY - start.y };
          el.style.transform = `translate(${off.x}px, ${off.y}px)`;
          if (!reduceMotion()) o.animate([{ transform: `translate(${prev.left - o.getBoundingClientRect().left}px, ${prev.top - o.getBoundingClientRect().top}px)` }, { transform: 'none' }], { duration: 200, easing: 'cubic-bezier(0.1, 0.9, 0.2, 1)' });
          break;
        }
      }
    };
    let ended = false;
    const up = () => {
      if (ended) return;
      ended = true;
      host.removeEventListener('pointermove', move);
      host.removeEventListener('pointerup', up);
      host.removeEventListener('pointercancel', up);
      host.removeEventListener('lostpointercapture', up);
      el.classList.remove('dragging');
      el.style.transform = '';
      const order = [...this.grid.children].map((x) => x.dataset.id).filter((k) => k && k !== 'local');
      const idx = order.indexOf(c.key);
      if (idx >= 0) this.store.moveCity(c.key, idx);
    };
    host.addEventListener('pointermove', move);
    host.addEventListener('pointerup', up);
    host.addEventListener('pointercancel', up);
    host.addEventListener('lostpointercapture', up);
  }

  // ------------------------------------------------------------------ map pins
  renderPins() {
    const { h, lang } = this.app;
    this.pins.replaceChildren();
    this.pinEls = [];
    for (const e of this.entries()) {
      const c = e.city;
      if (c.lat == null) continue;
      const x = ((c.lon + 180 - this.view.x) / this.view.w) * 100;
      const y = ((90 - c.lat - MAP_TOP) / MAP_H) * 100;
      if (y < 0 || y > 100) continue;
      const label = h('span', { class: 'ck-pin-label' }, h('span', { class: 'ck-pin-name' }, e.local ? cityName(c, lang) : cityName(c, lang)), h('span', { class: 'ck-pin-time' }));
      const pin = h('div', { class: ['ck-pin', e.local && 'local'], style: { left: `${x}%`, top: `${y}%` }, dataset: { id: e.key } }, h('span', { class: 'ck-pin-dot' }), label);
      pin.tz = e.local ? this.tz : c.tz;
      pin.lon = c.lon;
      this.pins.appendChild(pin);
      this.pinEls.push(pin);
    }
    requestAnimationFrame(() => this.layoutPins());
  }

  // widen the view to the map's box (no stretching on wide windows), centred on Greenwich
  layoutMap() {
    const r = this.map.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const w = Math.min(1080, Math.max(360, (MAP_H * r.width) / r.height));
    if (Math.abs(w - this.view.w) > 0.05) {
      this.view = { x: 180 - w / 2, w };
      this.mapSvg.setAttribute('viewBox', `${this.view.x.toFixed(2)} ${MAP_TOP} ${w.toFixed(2)} ${MAP_H}`);
    }
    for (const pin of this.pinEls || []) pin.style.left = `${((pin.lon + 180 - this.view.x) / this.view.w) * 100}%`;
  }

  // hide labels that would overlap one already placed (the local pin first), flip near the right edge
  layoutPins() {
    this.layoutMap();
    if (!this.pinEls?.length) return;
    const box = this.pins.getBoundingClientRect();
    if (!box.width) return;
    const placed = [];
    for (const pin of this.pinEls) {
      const label = pin.querySelector('.ck-pin-label');
      pin.classList.remove('left', 'nolabel');
      let r = label.getBoundingClientRect();
      if (r.right > box.right - 2) {
        pin.classList.add('left');
        r = label.getBoundingClientRect();
      }
      const hit = placed.some((p) => !(r.right < p.left || r.left > p.right || r.bottom < p.top || r.top > p.bottom));
      if (hit) pin.classList.add('nolabel');
      else placed.push(r);
    }
  }

  drawMap(at) {
    const minute = Math.floor(at / 60000);
    if (minute === this.lastMapMinute) return;
    this.lastMapMinute = minute;
    [0, -6, -12, -18].forEach((a, i) => this.nights[i].setAttribute('d', nightPath(at, a)));
    const p = solarPosition(at);
    this.suns.forEach((g, i) => g.setAttribute('transform', `translate(${(p.subLon + 180 + WRAP[i]).toFixed(2)} ${(90 - p.subLat).toFixed(2)})`));
  }

  // ------------------------------------------------------------------ ticking
  tick(now, force = false) {
    const at = this.at(now);
    this.drawMap(at);
    const sec = Math.floor(at / 1000);
    const full = force || sec !== this.lastSec;
    this.lastSec = sec;
    for (const c of this.cards.values()) {
      if (full) this.fillTime(c, at);
      if (c.local && c.parts) {
        const s = reduceMotion() ? Math.floor((at / 1000) % 60) : (at / 1000) % 60;
        c.face.set(c.parts.h, c.parts.mi, s);
      }
    }
    if (full) {
      for (const pin of this.pinEls || []) {
        const el = pin.querySelector('.ck-pin-time');
        const txt = this.app.timeParts(at, { tz: pin.tz }).full;
        if (el.textContent !== txt) el.textContent = txt;
      }
      if (this.compare) this.fillCompare(now);
    }
  }

  fillTime(c, at) {
    const { t, locale } = this.app;
    const tz = c.local ? this.tz : c.city.tz;
    const p = zoneParts(tz, at);
    c.parts = p;
    const tp = this.app.timeParts(at, { tz });
    if (c.time.textContent !== tp.main) c.time.textContent = tp.main;
    if (c.period.textContent !== tp.period) c.period.textContent = tp.period;
    if (!c.local) c.face.set(p.h, p.mi, p.s);
    let light;
    if (c.city.lat != null) light = daylight(c.city.lat, c.city.lon, at);
    else light = p.h >= 7 && p.h < 19 ? 'day' : p.h >= 6 && p.h < 20 ? 'twilight' : 'night';
    if (c.light !== light) {
      c.light = light;
      c.el.dataset.light = light;
      c.face.classList.toggle('night', light === 'night');
      c.face.classList.toggle('twilight', light === 'twilight');
    }
    let rel;
    if (c.local) {
      const off = zoneOffset(tz, at);
      rel = t('world.utc', { off: utcText(off) });
      const d = formatDate(at, locale, { weekday: 'long', day: 'numeric', month: 'long', timeZone: tz });
      if (c.date.textContent !== d) c.date.textContent = d;
    } else {
      const dd = dayDelta(tz, at, this.tz);
      const day = dd === 0 ? t('world.today') : dd === 1 ? t('world.tomorrow') : dd === -1 ? t('world.yesterday') : formatDate(at, locale, { weekday: 'short', timeZone: tz });
      const off = offsetFromLocal(tz, at, this.tz);
      rel = `${day}, ${shortOffset(t, off)}`;
      c.el.title = longOffset(t, off);
      const d = formatDate(at, locale, { weekday: 'short', day: 'numeric', month: 'short', timeZone: tz });
      if (c.date.textContent !== d) c.date.textContent = d;
    }
    if (c.rel.textContent !== rel) c.rel.textContent = rel;
    if (c.sun) this.fillSun(c, at);
  }

  fillCompare(now) {
    const { t, locale } = this.app;
    const at = this.at(now);
    this.cmpLabel.textContent = `${formatDate(at, locale, { weekday: 'long', day: 'numeric', month: 'long' })} · ${this.app.timeText(at)}`;
    const s = this.shift;
    this.cmpSub.textContent = s === 0 ? t('world.cmpNow') : t(s > 0 ? 'world.cmpLater' : 'world.cmpEarlier', { d: durText(t, Math.abs(s)) });
  }

  wantsFrames() {
    return !reduceMotion();
  }

  onStore(kind, extra) {
    if (kind === 'cities' || kind === 'all') {
      this.render();
      if (extra?.added) this.highlight(extra.added);
    }
  }

  highlight(id) {
    const c = this.cards.get(id);
    if (!c) return;
    c.el.scrollIntoView({ block: 'nearest' });
    c.el.classList.remove('flash');
    void c.el.offsetWidth;
    c.el.classList.add('flash');
  }

  onKey(e) {
    if (e.ctrlKey && e.key.toLowerCase() === 'n') {
      this.openSearch();
      return true;
    }
    if (e.key === 'Escape' && this.compare) {
      this.setCompare(false);
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ add city
  async openSearch() {
    if (this.dialogOpen) return null;
    const { h, t, icon, ui, win, lang } = this.app;
    if (this.app.citiesError) {
      ui.alert(t('world.loadError'), { title: t('errors.title'), parent: win });
      return null;
    }
    const input = h('input', { class: 'input', type: 'search', placeholder: t('world.searchPlaceholder'), 'aria-label': t('world.searchPlaceholder'), autocomplete: 'off', spellcheck: 'false' });
    const list = h('div', { class: 'ck-search-list', role: 'listbox', 'aria-label': t('world.results') });
    const hint = h('div', { class: 'ck-search-hint caption text-2' }, t('world.searchHint'));
    let results = [];
    let sel = -1;
    let addBtn = null;
    const paintSel = () => {
      [...list.children].forEach((el, i) => {
        el.classList.toggle('selected', i === sel);
        el.setAttribute('aria-selected', String(i === sel));
      });
      list.children[sel]?.scrollIntoView({ block: 'nearest' });
      if (addBtn) addBtn.disabled = sel < 0;
    };
    let done = null;
    const run = () => {
      const q = input.value;
      results = searchCities(q, lang, 40);
      sel = results.length ? 0 : -1;
      list.replaceChildren();
      const now = Date.now();
      results.forEach((c, i) => {
        const already = this.store.cities.includes(c.id);
        const off = offsetFromLocal(c.tz, now, this.tz);
        list.appendChild(
          h(
            'div',
            {
              class: ['ck-search-item', already && 'added'],
              role: 'option',
              dataset: { id: c.id },
              onclick: () => ((sel = i), paintSel()),
              ondblclick: () => ((sel = i), done?.('add')),
            },
            icon('location', { size: 16 }),
            h('div', { class: 'grow' }, h('div', { class: 'ellipsis' }, cityName(c, lang)), h('div', { class: 'caption text-2 ellipsis' }, cityPlace(c, lang))),
            h('div', { class: 'ck-search-time' }, h('div', null, this.app.timeText(now, { tz: c.tz })), h('div', { class: 'caption text-2' }, already ? t('world.alreadyAdded') : shortOffset(t, off))),
          ),
        );
      });
      hint.textContent = !q.trim() ? t('world.searchHint') : results.length ? '' : t('world.noResults');
      hint.hidden = !hint.textContent;
      paintSel();
    };
    input.addEventListener('input', run);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!results.length) return;
        sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
        paintSel();
      }
    });
    const body = h('div', { class: 'ck-dlg ck-dlg-search' }, h('div', { class: 'search-box' }, input, icon('search')), hint, list);
    this.dialogOpen = true;
    const res = await this.app.dialog({
      title: t('world.addTitle'),
      body,
      className: 'ck-search-dialog',
      buttons: [
        { label: t('world.addBtn'), value: 'add', primary: true },
        { label: t('common.cancel'), value: null },
      ],
      onOpen: (dlg, d) => {
        done = d;
        addBtn = dlg.querySelector('.dialog-footer .btn.primary');
        dlg._validate = (v) => (v === 'add' ? sel >= 0 : true);
        paintSel();
        setTimeout(() => input.focus(), 40);
      },
    });
    this.dialogOpen = false;
    if (res !== 'add' || sel < 0) return null;
    const city = results[sel];
    if (!this.store.addCity(city.id)) this.highlight(city.id);
    return city;
  }

  destroy() {
    this.mapRO?.disconnect();
  }
}

function utcText(mins) {
  const sign = mins < 0 ? '−' : '+';
  const a = Math.abs(mins);
  return `${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

function durText(t, mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h && m) return t('units.hMin', { h, m });
  if (h) return t('units.hOnly', { h });
  return t('units.mOnly', { m });
}
