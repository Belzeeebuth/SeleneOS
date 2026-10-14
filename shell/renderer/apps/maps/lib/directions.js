// Directions (« Itinéraire ») for the Maps app.
//   Side-panel view: travel mode (car / bike / foot), start, optional stops and destination fields (Nominatim search
//   on Enter, My places, the selected place, coordinates, « Choisir sur la carte »), swap, add / move / remove
//   stops, route choices (up to 3), summary (distance, duration, arrival), turn-by-turn steps (click: zoom to the
//   step), copy, print (shell print dialog), « Ouvrir dans OpenStreetMap », errors with « Réessayer ».
//   Map overlay: the route lines in an SVG layer (alternatives clickable), draggable start / stop / destination
//   markers (dropping one recomputes the route).
// Routing: maps:route (main/ipc/maps.js: FOSSGIS OSRM, one request per user action, cached). Pure helpers: route.js.
import { MODES, MAX_WAYPOINTS, decodePolyline, bboxOf, parseCoords, haversine, formatDistance, formatDuration, formatArrival, arrivalDate, prepareSteps, stepText, textHasDistance, stepIcon, modeTitle, creditLine, routeSummary, itineraryText, osmDirectionsUrl } from './route.js';
import { project } from './geo.js';
import { glyph } from './glyphs.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const MODE_ICON = { car: 'car', bike: 'bicycle', foot: 'person-simple-walk' };
const RETRY_CODES = new Set(['ERATELIMIT', 'EOFFLINE', 'EUNREACHABLE', 'EBADDATA', 'ETIMEDOUT', 'EFAIL', 'EHTTP']);
const ERROR_CODES = new Set(['ENOROUTE', 'ENOSEGMENT', 'ETOOBIG', 'ERATELIMIT', 'EOFFLINE', 'EUNREACHABLE']);
const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
function svgEl(tag, attrs = {}) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

/**
 * deps: { h, icon, ui, t, api, shell, lang, win, storage, mapEl, fmtCoords(lat, lon), getPlaces(), getSelected(),
 *         geoToScreen(lat, lon), screenToGeo(x, y), getSize() -> { W, H }, getView() -> { lat, lon, zoom },
 *         fitBounds(bbox), setView(lat, lon, zoom), scheduleRender(), onOpenChange(open), onPickChange(picking) }
 */
export function createDirections(d) {
  const { h, icon, ui, t, api, shell, lang } = d;
  const gl = (name) => glyph(name, icon);

  // ---------------------------------------------------------------- state
  let seq = 0;
  const newPoint = (place = null) => ({ id: `w${++seq}`, place, text: place ? place.name : '', dirty: false });
  let points = [newPoint(), newPoint()];
  let mode = 'car';
  let routes = []; // backend routes + { latlon, world, steps, bbox }
  let sel = 0;
  let state = 'idle'; // idle | loading | ok | error
  let error = null; // { code, message }
  let gen = 0;
  let lastKey = '';
  let activeStep = -1;
  let picking = null; // point id waiting for a map click
  let open = false;
  let requests = 0;
  let lines = []; // last rendered screen polylines (flat [x, y, …]) per route, for hit tests
  let closed = false;

  const roleOf = (i, n = points.length) => (i === 0 ? 'from' : i === n - 1 ? 'to' : 'stop');
  const labelOf = (i) => (roleOf(i) === 'stop' ? t('route.stopLabel', { n: i }) : t(`route.${roleOf(i)}Label`));
  const usedPoints = () => points.filter((p) => p.place);
  const ready = () => !!points[0].place && !!points[points.length - 1].place;

  // ---------------------------------------------------------------- panel DOM
  const backBtn = h('button', { class: 'btn subtle mp-icon-btn mp-route-back', type: 'button', title: t('route.close'), 'aria-label': t('route.close'), onclick: () => close(true) }, icon('arrow-left'));
  const head = h('div', { class: 'mp-route-head' }, backBtn, h('h2', { class: 'mp-route-title subtitle' }, t('route.title')));

  const modeBtns = {};
  const modeGroup = h('div', { class: 'mp-modes', role: 'radiogroup', 'aria-label': t('route.modes') });
  MODES.forEach((m, i) => {
    modeBtns[m] = h(
      'button',
      {
        class: 'mp-mode',
        type: 'button',
        role: 'radio',
        dataset: { mode: m },
        title: t(`route.mode.${m}`),
        onclick: () => setMode(m),
        onkeydown: (e) => {
          const k = e.key;
          if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(k)) return;
          e.preventDefault();
          let j = k === 'Home' ? 0 : k === 'End' ? MODES.length - 1 : i + (k === 'ArrowLeft' || k === 'ArrowUp' ? -1 : 1);
          j = (j + MODES.length) % MODES.length;
          setMode(MODES[j]);
          modeBtns[MODES[j]].focus();
        },
      },
      gl(MODE_ICON[m]),
      h('span', null, t(`route.mode.${m}`)),
    );
    modeGroup.append(modeBtns[m]);
  });
  function syncModes() {
    for (const [m, b] of Object.entries(modeBtns)) {
      const on = m === mode;
      b.classList.toggle('selected', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    }
  }

  const fieldsEl = h('div', { class: 'mp-wps' });
  const swapBtn = h('button', { class: 'btn subtle mp-icon-btn mp-swap', type: 'button', title: t('route.swap'), 'aria-label': t('route.swap'), onclick: () => swap() }, icon('arrows-down-up'));
  const addBtn = h('button', { class: 'btn subtle mp-add-stop', type: 'button', onclick: () => addStop() }, icon('plus'), h('span', null, t('route.addStop')));
  const live = h('div', { class: 'mp-route-live caption', role: 'status', 'aria-live': 'polite' });
  const resultEl = h('div', { class: 'mp-route-result' });
  const panel = h(
    'section',
    { class: 'mp-route', 'aria-label': t('route.title'), hidden: true },
    head,
    modeGroup,
    h('div', { class: 'mp-wpbox' }, fieldsEl, swapBtn),
    h('div', { class: 'mp-route-tools' }, addBtn),
    live,
    resultEl,
  );
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && picking) {
      e.preventDefault();
      e.stopPropagation();
      cancelPick(true);
    }
  });

  // ---------------------------------------------------------------- fields
  let cur = null; // open suggestion list: { p, input, list, items, active, message }
  let searchGen = 0;

  function badge(i, n, cls) {
    const role = roleOf(i, n);
    const el = h('span', { class: [cls, role], 'aria-hidden': 'true' });
    if (role === 'stop') el.textContent = String(i);
    else if (role === 'to') el.append(gl('flag-checkered'));
    return el;
  }

  function fieldRow(p, i) {
    const role = roleOf(i);
    const label = labelOf(i);
    const listId = `mp-sugg-${p.id}`;
    const input = h('input', {
      class: 'input mp-wp-input',
      type: 'text',
      value: p.text,
      placeholder: t(`route.${role}Placeholder`),
      'aria-label': label,
      autocomplete: 'off',
      spellcheck: 'false',
      maxlength: '200',
      role: 'combobox',
      'aria-autocomplete': 'list',
      'aria-expanded': 'false',
      'aria-controls': listId,
    });
    const list = h('ul', { class: 'mp-sugg', id: listId, role: 'listbox', 'aria-label': t('route.sugg.label'), hidden: true });
    input.addEventListener('focus', () => openSugg(p, input, list));
    input.addEventListener('click', () => {
      if (!cur || cur.input !== input) openSugg(p, input, list);
    });
    input.addEventListener('input', () => {
      p.text = input.value;
      p.dirty = true;
      openSugg(p, input, list);
    });
    input.addEventListener('blur', () => {
      setTimeout(() => {
        if (closed || document.activeElement === input) return;
        if (cur && cur.input === input) closeSugg();
        if (p.dirty && p.place && input.isConnected) {
          p.text = p.place.name;
          p.dirty = false;
          input.value = p.text;
        }
      }, 0);
    });
    input.addEventListener('keydown', (e) => fieldKey(e, p, input, list));
    const menuBtn = h(
      'button',
      { class: 'btn subtle mp-icon-btn mp-wp-menu', type: 'button', title: t('route.pointMenu', { name: label }), 'aria-label': t('route.pointMenu', { name: label }), 'aria-haspopup': 'menu', onclick: (e) => pointMenu(e, p) },
      icon('dots-three-vertical'),
    );
    return h('div', { class: ['mp-wp', role], dataset: { id: p.id } }, badge(i, points.length, 'mp-wp-badge'), h('div', { class: 'mp-wp-field' }, input, list), menuBtn);
  }

  function renderFields(focusId) {
    const a = document.activeElement;
    const keep = focusId || (a && fieldsEl.contains(a) && a.classList.contains('mp-wp-input') ? a.closest('.mp-wp')?.dataset.id : null);
    cur = null;
    fieldsEl.replaceChildren(...points.map(fieldRow));
    const full = points.length >= MAX_WAYPOINTS;
    addBtn.disabled = full;
    addBtn.title = full ? t('route.maxStops') : '';
    swapBtn.disabled = !points.some((p) => p.place);
    if (keep) focusField(keep);
  }
  function focusField(id) {
    fieldsEl.querySelector(`.mp-wp[data-id="${id}"] .mp-wp-input`)?.focus();
  }

  function fieldKey(e, p, input, list) {
    const k = e.key;
    if (e.altKey && (k === 'ArrowUp' || k === 'ArrowDown')) {
      e.preventDefault();
      movePoint(p.id, k === 'ArrowUp' ? -1 : 1);
      return;
    }
    if (k === 'ArrowDown' || k === 'ArrowUp') {
      e.preventDefault();
      if (!cur || cur.input !== input) openSugg(p, input, list);
      if (!cur.items.length) return;
      const n = cur.items.length;
      cur.active = k === 'ArrowDown' ? (cur.active + 1) % n : cur.active <= 0 ? n - 1 : cur.active - 1;
      renderSugg();
      return;
    }
    if (k === 'Enter') {
      e.preventDefault();
      if (cur && cur.input === input && cur.active >= 0 && cur.items[cur.active]) return choose(cur.active);
      const q = input.value.trim();
      const c = parseCoords(q);
      if (c) return setPoint(p, { name: d.fmtCoords(c.lat, c.lon), lat: c.lat, lon: c.lon });
      if (q.length >= 2) {
        if (!cur || cur.input !== input) openSugg(p, input, list);
        fieldSearch(cur, q);
      }
      return;
    }
    if (k === 'Escape') {
      if (cur && cur.input === input && !list.hidden) {
        e.preventDefault();
        e.stopPropagation();
        closeSugg();
        if (p.dirty && p.place) {
          p.text = p.place.name;
          p.dirty = false;
          input.value = p.text;
        }
      }
    }
  }

  function defaultItems(q) {
    const items = [];
    const text = String(q || '').trim();
    const f = fold(text);
    if (!f) {
      const s = d.getSelected();
      if (s) items.push({ kind: 'place', icon: 'map-pin', label: s.name, sub: t('route.sugg.selected'), place: s });
      items.push({ kind: 'pick', icon: 'cursor-click', label: t('route.sugg.pick') });
    } else {
      const c = parseCoords(text);
      if (c) items.push({ kind: 'place', icon: 'map-pin', label: d.fmtCoords(c.lat, c.lon), sub: t('route.sugg.coords'), place: { name: d.fmtCoords(c.lat, c.lon), lat: c.lat, lon: c.lon } });
      if (text.length >= 2) items.push({ kind: 'search', icon: 'search', label: t('route.sugg.search', { q: text }) });
    }
    for (const pl of d.getPlaces()) {
      if (f && !fold(`${pl.name} ${pl.display || ''}`).includes(f)) continue;
      items.push({ kind: 'place', icon: 'star', saved: true, label: pl.name, sub: pl.display || '', place: pl });
    }
    return items.slice(0, 9);
  }
  function openSugg(p, input, list) {
    if (cur && cur.input !== input) closeSugg();
    cur = { p, input, list, items: defaultItems(input.value), active: -1, message: '' };
    renderSugg();
  }
  function closeSugg() {
    if (!cur) return;
    searchGen++;
    cur.list.hidden = true;
    cur.list.replaceChildren();
    cur.input.setAttribute('aria-expanded', 'false');
    cur.input.removeAttribute('aria-activedescendant');
    cur = null;
  }
  function renderSugg() {
    if (!cur) return;
    const { list, input, items, active, message } = cur;
    const lis = items.map((it, i) =>
      h(
        'li',
        {
          class: ['mp-sugg-item', i === active ? 'active' : '', it.kind],
          id: `${list.id}-${i}`,
          role: 'option',
          'aria-selected': i === active ? 'true' : 'false',
          onmousedown: (e) => e.preventDefault(),
          onclick: () => choose(i),
        },
        h('span', { class: ['mp-sugg-icon', it.saved ? 'star' : ''] }, icon(it.icon)),
        h('span', { class: 'mp-sugg-text' }, h('span', { class: 'mp-sugg-name' }, it.label), it.sub ? h('span', { class: 'mp-sugg-sub caption' }, it.sub) : null),
      ),
    );
    if (message) lis.push(h('li', { class: 'mp-sugg-msg caption', role: 'presentation' }, message));
    list.replaceChildren(...lis);
    list.hidden = !lis.length;
    input.setAttribute('aria-expanded', list.hidden ? 'false' : 'true');
    if (active >= 0) {
      input.setAttribute('aria-activedescendant', `${list.id}-${active}`);
      // scroll the list only (scrollIntoView would also scroll the window's hidden-overflow ancestors)
      const li = list.children[active];
      if (li && li.offsetTop < list.scrollTop) list.scrollTop = li.offsetTop;
      else if (li && li.offsetTop + li.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = li.offsetTop + li.offsetHeight - list.clientHeight;
    } else input.removeAttribute('aria-activedescendant');
  }
  function choose(i) {
    const c = cur;
    const it = c?.items[i];
    if (!it) return;
    if (it.kind === 'search') return fieldSearch(c, c.input.value.trim());
    if (it.kind === 'pick') return startPick(c.p);
    setPoint(c.p, it.place);
  }
  async function fieldSearch(c, q) {
    if (!c || q.length < 2) return;
    const g = ++searchGen;
    c.items = [];
    c.active = -1;
    c.message = t('route.sugg.searching');
    renderSugg();
    let res;
    try {
      res = await api.invoke('maps:search', q, { lang });
    } catch {
      if (g !== searchGen || cur !== c) return;
      c.message = t('route.sugg.error');
      return renderSugg();
    }
    if (g !== searchGen || cur !== c || closed) return;
    c.items = (Array.isArray(res) ? res : []).map((r) => ({ kind: 'place', icon: 'location', label: r.name, sub: r.display || '', place: r }));
    c.message = c.items.length ? '' : t('route.sugg.none', { q });
    c.active = c.items.length ? 0 : -1;
    renderSugg();
  }

  // ---------------------------------------------------------------- point edits
  const placeOf = (pl) => {
    const lat = Number(pl.lat);
    const lon = Number(pl.lon);
    return { name: String(pl.name || '').trim() || d.fmtCoords(lat, lon), display: pl.display || '', lat, lon };
  };
  function setPoint(p, place, { fit = true, focusNext = true } = {}) {
    if (!p || !place || !Number.isFinite(Number(place.lat)) || !Number.isFinite(Number(place.lon))) return;
    p.place = placeOf(place);
    p.text = p.place.name;
    p.dirty = false;
    closeSugg();
    if (picking === p.id) cancelPick(false);
    renderFields();
    const next = focusNext ? points.find((x) => !x.place && (x === points[0] || x === points[points.length - 1])) : null;
    if (next && open) focusField(next.id);
    compute({ fit });
  }
  function swap() {
    points = points.slice().reverse();
    renderFields();
    compute({ fit: false });
  }
  function addStop(place) {
    if (points.length >= MAX_WAYPOINTS) return null;
    const p = newPoint();
    points.splice(points.length - 1, 0, p);
    renderFields();
    if (place) setPoint(p, place, { fit: false, focusNext: false });
    else focusField(p.id);
    return p;
  }
  function removePoint(id) {
    const i = points.findIndex((p) => p.id === id);
    if (i < 0) return;
    if (points.length <= 2) {
      points[i] = newPoint();
    } else points.splice(i, 1);
    renderFields();
    const next = points[Math.min(i, points.length - 1)];
    if (next) focusField(next.id);
    compute({ fit: false });
  }
  function movePoint(id, delta) {
    const i = points.findIndex((p) => p.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= points.length) return;
    const arr = points.slice();
    [arr[i], arr[j]] = [arr[j], arr[i]];
    points = arr;
    renderFields(id);
    compute({ fit: false });
    live.textContent = t('route.moved', { name: points[j].text || labelOf(j), pos: labelOf(j) });
  }
  function pointMenu(e, p) {
    const i = points.findIndex((x) => x.id === p.id);
    const n = points.length;
    ui.menu(e.currentTarget || e, [
      { label: t('route.sugg.pick'), icon: 'cursor-click', action: () => startPick(p) },
      '-',
      { label: t('route.moveUp'), icon: 'arrow-up', disabled: i <= 0, action: () => movePoint(p.id, -1) },
      { label: t('route.moveDown'), icon: 'arrow-down', disabled: i >= n - 1, action: () => movePoint(p.id, 1) },
      '-',
      n > 2 ? { label: t('route.remove'), icon: 'delete', action: () => removePoint(p.id) } : { label: t('route.clear'), icon: 'dismiss', disabled: !p.place && !p.text, action: () => removePoint(p.id) },
    ]);
  }

  // ---------------------------------------------------------------- picking on the map
  function startPick(p) {
    picking = p.id;
    closeSugg();
    d.onPickChange?.(true);
    live.textContent = t('route.pickHint', { name: labelOf(points.indexOf(p)) });
    d.mapEl.focus({ preventScroll: true });
  }
  function cancelPick(focus) {
    if (!picking) return;
    const id = picking;
    picking = null;
    d.onPickChange?.(false);
    live.textContent = '';
    if (focus) focusField(id);
  }

  /** A click (no drag) on the map at a point relative to it: picking, or choosing an alternative. -> handled */
  function mapClick(pt) {
    if (!open) return false;
    if (picking) {
      const p = points.find((x) => x.id === picking);
      const g = d.screenToGeo(pt.x, pt.y);
      cancelPick(false);
      if (p) setPoint(p, { lat: g.lat, lon: g.lon });
      return true;
    }
    const k = hitRoute(pt.x, pt.y);
    if (k >= 0 && k !== sel) {
      selectRoute(k);
      return true;
    }
    return false;
  }
  function hitRoute(x, y, tol = 10) {
    const dist = lines.map((flat) => {
      let m = Infinity;
      for (let i = 2; i < flat.length; i += 2) {
        const ax = flat[i - 2];
        const ay = flat[i - 1];
        const dx = flat[i] - ax;
        const dy = flat[i + 1] - ay;
        const l2 = dx * dx + dy * dy;
        const u = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
        m = Math.min(m, Math.hypot(ax + u * dx - x, ay + u * dy - y));
      }
      return m;
    });
    if (dist[sel] <= tol) return sel; // shared parts belong to the chosen route
    let best = -1;
    dist.forEach((v, k) => {
      if (v <= tol && (best < 0 || v < dist[best])) best = k;
    });
    return best;
  }

  /** Right-click (or the menu key) on the map at geo. */
  function contextMenu(at, geo) {
    const place = { lat: geo.lat, lon: geo.lon };
    const items = [
      { label: t('route.here.from'), icon: 'map-pin', action: () => (show(), setPoint(points[0], place)) },
      { label: t('route.here.to'), icon: 'flag', action: () => (show(), setPoint(points[points.length - 1], place)) },
    ];
    if (open && ready()) items.push({ label: t('route.here.stop'), icon: 'plus', disabled: points.length >= MAX_WAYPOINTS, action: () => insertStop(place) });
    return ui.menu(at, items);
  }
  /** Adds a stop where it makes the smallest detour between two consecutive placed points. */
  function insertStop(place) {
    if (points.length >= MAX_WAYPOINTS) return;
    const placed = points.map((p, i) => ({ p, i })).filter((x) => x.p.place);
    let at = points.length - 1;
    let best = Infinity;
    for (let k = 1; k < placed.length; k++) {
      const a = placed[k - 1].p.place;
      const b = placed[k].p.place;
      const detour = haversine(a, place) + haversine(place, b) - haversine(a, b);
      if (detour < best) {
        best = detour;
        at = placed[k].i;
      }
    }
    const p = newPoint();
    points.splice(at, 0, p);
    setPoint(p, place, { fit: false, focusNext: false });
  }

  // ---------------------------------------------------------------- routing
  function setMode(m, { recompute = true } = {}) {
    if (!MODES.includes(m)) return;
    const changed = m !== mode;
    mode = m;
    syncModes();
    if (!changed) return;
    d.storage?.set?.('routeMode', m)?.catch?.(() => {});
    if (recompute) compute({ fit: true });
  }

  function compute({ fit = true, force = false } = {}) {
    if (!ready()) {
      gen++;
      routes = [];
      lines = [];
      state = 'idle';
      error = null;
      lastKey = '';
      renderResult();
      d.scheduleRender();
      return;
    }
    const used = usedPoints();
    const key = `${mode}|${used.map((p) => `${p.place.lat.toFixed(6)},${p.place.lon.toFixed(6)}`).join(';')}`;
    if (!force && key === lastKey && (state === 'ok' || state === 'loading')) {
      renderResult();
      return;
    }
    lastKey = key;
    const usedIdx = points.map((p, i) => (p.place ? i : -1)).filter((i) => i >= 0);
    const g = ++gen;
    state = 'loading';
    error = null;
    if (!picking) live.textContent = '';
    renderResult();
    requests++;
    api
      .invoke(
        'maps:route',
        used.map((p) => ({ lat: p.place.lat, lon: p.place.lon })),
        { mode },
      )
      .then((res) => {
        if (g !== gen || closed) return;
        routes = (res?.routes || []).map((r) => {
          const latlon = decodePolyline(r.geometry);
          const steps = prepareSteps(r);
          for (const s of steps) if (s.type === 'arrive' && s.leg < s.legCount - 1) s.stopNo = usedIdx[s.leg + 1];
          return { ...r, latlon, world: latlon.map(([la, lo]) => { const w = project(la, lo, 0); return [w.x, w.y]; }), steps, bbox: bboxOf(latlon) };
        }).filter((r) => r.latlon.length > 1);
        if (!routes.length) throw Object.assign(new Error('No route'), { code: 'ENOROUTE' });
        sel = 0;
        activeStep = -1;
        state = 'ok';
        if (fit) fitRoutes();
        renderResult();
        d.scheduleRender();
      })
      .catch((e) => {
        if (g !== gen || closed) return;
        routes = [];
        lines = [];
        state = 'error';
        lastKey = '';
        error = { code: e?.code || 'EFAIL', message: String(e?.message || '') };
        renderResult();
        d.scheduleRender();
      });
  }
  function fitRoutes() {
    let bb = null;
    for (const r of routes) {
      if (!r.bbox) continue;
      bb = bb ? [Math.min(bb[0], r.bbox[0]), Math.max(bb[1], r.bbox[1]), Math.min(bb[2], r.bbox[2]), Math.max(bb[3], r.bbox[3])] : r.bbox.slice();
    }
    if (bb) d.fitBounds(bb);
  }
  function selectRoute(k) {
    if (!routes[k] || k === sel) return;
    sel = k;
    activeStep = -1;
    renderResult();
    d.scheduleRender();
    live.textContent = t('route.chosen', { duration: formatDuration(routes[k].duration, lang), distance: formatDistance(routes[k].distance, lang) });
  }
  function showStep(i) {
    const s = routes[sel]?.steps[i];
    if (!s) return;
    activeStep = i;
    for (const b of resultEl.querySelectorAll('.mp-step')) {
      const on = Number(b.dataset.index) === i;
      b.classList.toggle('active', on);
      if (on) b.setAttribute('aria-current', 'step');
      else b.removeAttribute('aria-current');
    }
    d.setView(s.location.lat, s.location.lon, Math.max(16, Math.min(17, Math.round(d.getView().zoom))));
  }

  // ---------------------------------------------------------------- result area
  const names = () => usedPoints().map((p) => p.place.name);
  function errorText(code) {
    return t(`route.err.${ERROR_CODES.has(code) ? code : 'EUNREACHABLE'}`);
  }
  function renderResult() {
    // keep the focus on the same route choice / step button across re-renders
    const a = document.activeElement;
    const refocus = a && resultEl.contains(a) && a.dataset.index != null ? `.${a.classList.contains('mp-ropt') ? 'mp-ropt' : 'mp-step'}[data-index="${a.dataset.index}"]` : '';
    const out = [];
    if (state === 'idle') {
      out.push(h('p', { class: 'mp-route-hint caption' }, t('route.hint')));
    } else if (state === 'loading') {
      out.push(h('div', { class: 'mp-route-loading', role: 'status' }, h('span', { class: 'spinner small' }), h('span', null, t('route.loading'))));
    } else if (state === 'error') {
      const retry = RETRY_CODES.has(error?.code) || !ERROR_CODES.has(error?.code);
      out.push(
        h(
          'div',
          { class: 'mp-route-error', role: 'alert', dataset: { code: error?.code || '' } },
          h('span', { class: 'mp-route-error-icon' }, icon(error?.code === 'EOFFLINE' ? 'wifi-slash' : 'warning')),
          h('div', { class: 'mp-route-error-body' }, h('p', null, errorText(error?.code)), retry ? h('button', { class: 'btn mp-retry', type: 'button', onclick: () => compute({ fit: true, force: true }) }, icon('arrow-clockwise'), h('span', null, t('route.retry'))) : null),
        ),
      );
    } else if (state === 'ok' && routes[sel]) {
      const now = new Date();
      const opt = (r, k) => {
        const arrival = t('route.arrival', { time: formatArrival(arrivalDate(now, r.duration), lang, now) });
        const via = routeSummary(r);
        const body = [
          h('span', { class: 'mp-ropt-top' }, h('span', { class: 'mp-ropt-dur' }, formatDuration(r.duration, lang)), h('span', { class: 'mp-ropt-dist' }, formatDistance(r.distance, lang))),
          h('span', { class: 'mp-ropt-sub caption' }, arrival),
          via ? h('span', { class: 'mp-ropt-sub caption' }, t('route.via', { summary: via })) : null,
        ];
        if (routes.length < 2) return h('div', { class: 'mp-ropt single selected', dataset: { index: String(k) } }, ...body);
        return h(
          'button',
          {
            class: ['mp-ropt', k === sel ? 'selected' : ''],
            type: 'button',
            dataset: { index: String(k) },
            'aria-pressed': k === sel ? 'true' : 'false',
            'aria-label': t('route.choose', { n: k + 1, duration: formatDuration(r.duration, lang), distance: formatDistance(r.distance, lang) }),
            onclick: () => selectRoute(k),
          },
          ...body,
        );
      };
      out.push(h('div', { class: 'mp-ropts', role: routes.length > 1 ? 'group' : null, 'aria-label': t('route.routes') }, routes.map(opt)));
      const osmTip = usedPoints().length > 2 ? t('route.osmStopsTip') : t('route.osmTip');
      out.push(
        h(
          'div',
          { class: 'mp-route-actions' },
          h('button', { class: 'btn mp-copy', type: 'button', onclick: () => copy() }, icon('copy'), h('span', null, t('route.copy'))),
          h('button', { class: 'btn mp-print', type: 'button', onclick: () => print() }, icon('printer'), h('span', null, t('route.print'))),
        ),
        h('button', { class: 'mp-osm-link', type: 'button', title: osmTip, onclick: () => shell.openUrl?.(osmUrl()) }, icon('arrow-square-out'), h('span', null, t('route.osm'))),
      );
      const steps = routes[sel].steps;
      out.push(h('h3', { class: 'mp-steps-title body-strong' }, t('route.steps')));
      out.push(
        h(
          'ol',
          { class: 'mp-steps', 'aria-label': t('route.steps') },
          steps.map((s, i) => {
            const dist = s.type !== 'arrive' && !textHasDistance(s) && s.distance >= 1 ? formatDistance(s.distance, lang) : '';
            return h(
              'li',
              null,
              h(
                'button',
                { class: ['mp-step', s.type === 'arrive' ? 'arrive' : '', i === activeStep ? 'active' : ''], type: 'button', title: t('route.stepTip'), dataset: { index: String(i) }, 'aria-current': i === activeStep ? 'step' : null, onclick: () => showStep(i) },
                h('span', { class: 'mp-step-icon' }, gl(stepIcon(s))),
                h('span', { class: 'mp-step-text' }, stepText(s, lang)),
                dist ? h('span', { class: 'mp-step-dist caption' }, dist) : null,
              ),
            );
          }),
        ),
      );
      out.push(h('p', { class: 'mp-route-credit caption' }, creditLine(lang)));
    }
    resultEl.replaceChildren(...out);
    if (refocus) resultEl.querySelector(refocus)?.focus();
  }
  const osmUrl = () => osmDirectionsUrl(usedPoints().map((p) => p.place), mode);
  function text() {
    const r = routes[sel];
    return r ? itineraryText({ route: r, steps: r.steps, names: names(), mode, lang, url: osmUrl() }) : '';
  }
  async function copy() {
    const s = text();
    if (!s) return;
    try {
      await api.invoke('clipboard:writeText', s);
      live.textContent = t('route.copied');
    } catch {
      live.textContent = t('route.copyError');
    }
  }
  let printing = false;
  async function print() {
    const r = routes[sel];
    if (!r || printing) return null;
    printing = true;
    try {
      const { printDialog, printDocument, escapeHtml: esc } = await import('../../../core/print.js');
      const title = `${modeTitle(mode, lang)} — ${names().join(' → ')}`;
      const now = new Date();
      const arrival = t('route.arrival', { time: formatArrival(arrivalDate(now, r.duration), lang, now) });
      const via = routeSummary(r);
      const rows = r.steps
        .map((s, i) => {
          const dist = s.type !== 'arrive' && !textHasDistance(s) && s.distance >= 1 ? formatDistance(s.distance, lang) : '';
          return `<tr><td class="n">${i + 1}</td><td>${esc(stepText(s, lang))}</td><td class="d">${esc(dist)}</td></tr>`;
        })
        .join('');
      const css =
        'body{padding:0}h1{font-family:Manrope,Inter,sans-serif;font-size:17pt;margin:0 0 2pt}.places{font-size:12pt;margin:0 0 8pt}' +
        '.sum{font-weight:600;margin:0}.via{color:#444;margin:2pt 0 12pt}table{width:100%;border-collapse:collapse}' +
        'td{padding:4pt 6pt;border-bottom:0.5pt solid #ccc;vertical-align:top}tr{break-inside:avoid}td.n{width:2em;color:#555;text-align:right}' +
        'td.d{white-space:nowrap;text-align:right;color:#333}.credit{margin-top:14pt;font-size:8.5pt;color:#555}';
      const body =
        `<h1>${esc(modeTitle(mode, lang))}</h1><p class="places">${esc(names().join(' → '))}</p>` +
        `<p class="sum">${esc(`${formatDistance(r.distance, lang)} · ${formatDuration(r.duration, lang)} · ${arrival}`)}</p>` +
        (via ? `<p class="via">${esc(t('route.via', { summary: via }))}</p>` : '<p class="via"></p>') +
        `<table>${rows}</table><p class="credit">${esc(creditLine(lang))}<br>${esc(osmUrl())}</p>`;
      return await printDialog({ title, parent: d.win, appId: 'maps', shell, render: 'webcontents', html: () => printDocument({ title, css, body }) });
    } finally {
      printing = false;
    }
  }

  // ---------------------------------------------------------------- map overlay
  const svg = svgEl('svg', { class: 'mp-route-layer', 'aria-hidden': 'true' });
  const gAlt = svgEl('g', { class: 'mp-rt-alts' });
  const gSel = svgEl('g', { class: 'mp-rt-sel' });
  const gHi = svgEl('g', { class: 'mp-rt-hi' });
  svg.append(gAlt, gSel, gHi);
  const markersEl = h('div', { class: 'mp-rmarkers' });
  const markerEls = new Map(); // point id -> element
  let drag = null;

  function screenLine(r, z) {
    const k = 2 ** z;
    const s0 = d.geoToScreen(r.latlon[0][0], r.latlon[0][1]);
    const [wx0, wy0] = r.world[0];
    const n = r.world.length;
    const out = [];
    let lx = Infinity;
    let ly = Infinity;
    for (let i = 0; i < n; i++) {
      const x = s0.x + (r.world[i][0] - wx0) * k;
      const y = s0.y + (r.world[i][1] - wy0) * k;
      if (i && i < n - 1 && Math.abs(x - lx) < 1 && Math.abs(y - ly) < 1) continue;
      out.push(x, y);
      lx = x;
      ly = y;
    }
    return out;
  }
  function pathD(flat, W, H) {
    const M = 64;
    const code = (x, y) => (x < -M ? 1 : x > W + M ? 2 : 0) | (y < -M ? 4 : y > H + M ? 8 : 0);
    let s = '';
    let pen = false;
    for (let i = 2; i < flat.length; i += 2) {
      const ax = flat[i - 2];
      const ay = flat[i - 1];
      const bx = flat[i];
      const by = flat[i + 1];
      if (code(ax, ay) & code(bx, by)) {
        pen = false;
        continue;
      }
      if (!pen) {
        s += `M${ax.toFixed(1)} ${ay.toFixed(1)}`;
        pen = true;
      }
      s += `L${bx.toFixed(1)} ${by.toFixed(1)}`;
    }
    return s;
  }
  function pathPair(g, k, cls) {
    let pair = g.querySelector(`[data-k="${k}"]`);
    if (!pair) {
      pair = svgEl('g', { 'data-k': String(k) });
      const title = svgEl('title');
      pair.append(svgEl('path', { class: `${cls}-casing` }), svgEl('path', { class: `${cls}-line` }), title);
      g.append(pair);
    }
    return pair;
  }
  function render() {
    if (!open || closed) {
      svg.style.display = 'none';
      markersEl.hidden = true;
      return;
    }
    svg.style.display = '';
    markersEl.hidden = false;
    const { W, H } = d.getSize();
    const z = d.getView().zoom;
    svg.setAttribute('width', String(W));
    svg.setAttribute('height', String(H));
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    lines = routes.map((r) => screenLine(r, z));
    // alternatives under the chosen route
    const altKeys = new Set();
    routes.forEach((r, k) => {
      if (k === sel) return;
      altKeys.add(String(k));
      const pair = pathPair(gAlt, k, 'mp-rt-alt');
      const dd = pathD(lines[k], W, H);
      pair.children[0].setAttribute('d', dd);
      pair.children[1].setAttribute('d', dd);
      pair.children[2].textContent = t('route.altTip', { duration: formatDuration(r.duration, lang), distance: formatDistance(r.distance, lang) });
    });
    for (const g of [...gAlt.children]) if (!altKeys.has(g.getAttribute('data-k'))) g.remove();
    if (routes[sel]) {
      const pair = pathPair(gSel, 0, 'mp-rt');
      const dd = pathD(lines[sel], W, H);
      pair.children[0].setAttribute('d', dd);
      pair.children[1].setAttribute('d', dd);
      pair.children[2].textContent = '';
    } else gSel.replaceChildren();
    // the step shown on the map
    const s = routes[sel]?.steps[activeStep];
    if (s) {
      const p = d.geoToScreen(s.location.lat, s.location.lon);
      let c = gHi.firstChild;
      if (!c) gHi.append((c = svgEl('circle', { class: 'mp-rt-step', r: '7' })));
      c.setAttribute('cx', p.x.toFixed(1));
      c.setAttribute('cy', p.y.toFixed(1));
    } else gHi.replaceChildren();
    renderMarkers(W, H);
  }
  function renderMarkers(W, H) {
    const keep = new Set();
    const n = points.length;
    points.forEach((p, i) => {
      if (!p.place) return;
      keep.add(p.id);
      let el = markerEls.get(p.id);
      if (!el) {
        el = makeMarker(p.id);
        markerEls.set(p.id, el);
        markersEl.append(el);
      }
      const key = `${roleOf(i, n)}${i}`;
      if (el.dataset.key !== key) {
        el.dataset.key = key;
        el.className = `mp-rmarker ${roleOf(i, n)}`;
        el.replaceChildren(...badge(i, n, 'mp-rmarker-in').childNodes);
      }
      el.title = `${labelOf(i)}${lang === 'fr' ? '\u00a0: ' : ': '}${p.place.name}`;
      if (drag?.id === p.id && drag.moved) return;
      const s = d.geoToScreen(p.place.lat, p.place.lon);
      el.style.transform = `translate(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px)`;
      el.style.visibility = s.x < -40 || s.y < -40 || s.x > W + 40 || s.y > H + 40 ? 'hidden' : '';
    });
    for (const [id, el] of markerEls) {
      if (!keep.has(id)) {
        el.remove();
        markerEls.delete(id);
      }
    }
    // DOM (and stacking) order = route order; never while dragging (moving the node would drop its pointer capture)
    if (!drag) {
      let k = 0;
      for (const p of points) {
        const el = p.place && markerEls.get(p.id);
        if (!el) continue;
        if (markersEl.children[k] !== el) markersEl.insertBefore(el, markersEl.children[k] || null);
        k++;
      }
    }
  }
  function makeMarker(id) {
    const el = h('div', { class: 'mp-rmarker', dataset: { id } });
    const local = (e) => {
      const r = d.mapEl.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      e.stopPropagation();
      e.preventDefault();
      el.setPointerCapture?.(e.pointerId);
      drag = { id, x0: e.clientX, y0: e.clientY, moved: false };
      el.classList.add('dragging');
    });
    el.addEventListener('pointermove', (e) => {
      if (!drag || drag.id !== id) return;
      if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 3) return;
      const p = local(e);
      drag.moved = true;
      drag.x = p.x;
      drag.y = p.y;
      el.style.transform = `translate(${p.x}px, ${p.y}px)`;
    });
    const end = (e) => {
      if (!drag || drag.id !== id) return;
      const dr = drag;
      drag = null;
      el.classList.remove('dragging');
      if (dr.moved && e.type === 'pointerup') {
        const g = d.screenToGeo(dr.x, dr.y);
        const p = points.find((x) => x.id === id);
        if (p) setPoint(p, { lat: g.lat, lon: g.lon }, { fit: false, focusNext: false });
      }
      d.scheduleRender();
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('dblclick', (e) => e.stopPropagation());
    return el;
  }

  // ---------------------------------------------------------------- open / close
  function show() {
    if (!open) {
      open = true;
      panel.hidden = false;
      d.onOpenChange(true);
    }
    d.scheduleRender();
  }
  /** Opens the directions view; { to, from } prefill a field. */
  function openView({ to = null, from = null } = {}) {
    show();
    const fill = (p, pl) => Object.assign(p, { place: placeOf(pl), dirty: false }, { text: placeOf(pl).name });
    if (to) fill(points[points.length - 1], to);
    if (from) fill(points[0], from);
    renderFields();
    const empty = points.find((p) => !p.place);
    focusField((empty || points[0]).id);
    if (to || from) compute({ fit: true });
  }
  function close(focusBack) {
    if (!open) return;
    cancelPick(false);
    closeSugg();
    open = false;
    panel.hidden = true;
    d.onOpenChange(false, focusBack);
    d.scheduleRender();
  }

  // ---------------------------------------------------------------- start
  (async () => {
    try {
      const m = await d.storage?.get?.('routeMode', 'car');
      if (MODES.includes(m) && !closed) setMode(m, { recompute: false });
    } catch {}
  })();
  syncModes();
  renderFields();
  renderResult();

  return {
    panel,
    svg,
    markersEl,
    render,
    mapClick,
    contextMenu,
    open: openView,
    close,
    cancelPick,
    get isOpen() {
      return open;
    },
    get picking() {
      return !!picking;
    },
    destroy() {
      closed = true;
    },
    // test hooks (body.__maps.route)
    debug: {
      get points() {
        return points.map((p) => ({ id: p.id, text: p.text, place: p.place ? { ...p.place } : null }));
      },
      get mode() {
        return mode;
      },
      get state() {
        return state;
      },
      get error() {
        return error ? { ...error } : null;
      },
      get requests() {
        return requests;
      },
      get selected() {
        return sel;
      },
      get activeStep() {
        return activeStep;
      },
      get open() {
        return open;
      },
      get picking() {
        return picking;
      },
      get routes() {
        return routes.map((r) => ({ distance: r.distance, duration: r.duration, points: r.latlon.length, steps: r.steps.length, bbox: r.bbox }));
      },
      get steps() {
        return (routes[sel]?.steps || []).map((s) => stepText(s, lang));
      },
      get text() {
        return text();
      },
      get osmUrl() {
        return osmUrl();
      },
      /** A screen point (relative to the map) on route k, far from the other routes when possible. */
      routePoint(k) {
        const flat = lines[k];
        if (!flat || flat.length < 4) return null;
        let best = null;
        let bestD = -1;
        for (let i = 0; i < flat.length; i += 2) {
          const x = flat[i];
          const y = flat[i + 1];
          let dmin = Infinity;
          lines.forEach((o, j) => {
            if (j === k) return;
            for (let q = 0; q < o.length; q += 2) dmin = Math.min(dmin, Math.hypot(o[q] - x, o[q + 1] - y));
          });
          const { W, H } = d.getSize();
          if (x < 20 || y < 20 || x > W - 20 || y > H - 20) continue;
          if (dmin > bestD) {
            bestD = dmin;
            best = { x, y };
          }
        }
        return best;
      },
      markerPos(id) {
        const el = markerEls.get(id);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const m = d.mapEl.getBoundingClientRect();
        return { x: r.left + r.width / 2 - m.left, y: r.top + r.height / 2 - m.top };
      },
      setPoint: (i, place) => setPoint(points[i], place),
      addStop: (place) => addStop(place)?.id || null,
      movePoint: (i, delta) => movePoint(points[i]?.id, delta),
      removePoint: (i) => removePoint(points[i]?.id),
      setMode: (m) => setMode(m),
      selectRoute: (k) => selectRoute(k),
      swap: () => swap(),
    },
  };
}
