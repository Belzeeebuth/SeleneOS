// Maps: OpenStreetMap raster tiles in a custom viewer, Nominatim place search and "My places".
// Backend: main/ipc/maps.js (tiles, search and saved places; mock tiles + gazetteer in dev/tests, never network).
// Test hooks: the window body element gets __maps.
import { MIN_ZOOM, MAX_ZOOM, clampZoom, clampLat, wrapLon, project, unproject, scaleBar, visibleTiles, fitZoom, formatCoords } from './lib/geo.js';

const OSM_COPYRIGHT = 'https://www.openstreetmap.org/copyright';
const MAX_TILE_REQUESTS = 2; // OSM tile usage policy: at most 2 parallel requests
const TILE_CACHE = 400;
const DEFAULT_VIEW = { lat: 46.6, lon: 2.4, zoom: 5 };
const PIN_SVG =
  '<svg viewBox="0 0 32 44" width="32" height="44" aria-hidden="true"><path d="M16 1C7.7 1 1 7.6 1 15.8 1 27 16 43 16 43s15-16 15-27.2C31 7.6 24.3 1 16 1z" fill="var(--mp-pin, #d13438)" stroke="#fff" stroke-width="2"/><circle cx="16" cy="15.5" r="5.5" fill="#fff"/></svg>';

export default {
  async launch(ctx) {
    const { win, h, icon, ui, t, api, shell, storage } = ctx;
    const lang = ctx.lang === 'fr' ? 'fr' : 'en';
    const nf = (n, d = 0) => new Intl.NumberFormat(lang === 'fr' ? 'fr-FR' : 'en-US', { maximumFractionDigits: d }).format(n);
    const dirs = { n: t('dir.n'), s: t('dir.s'), e: t('dir.e'), w: t('dir.w') };
    const cleanups = [];
    let closed = false;

    // ------------------------------------------------------------ state
    const view = { ...DEFAULT_VIEW };
    let tab = 'results';
    try {
      const saved = await storage?.get?.('view', null);
      if (saved && Number.isFinite(saved.lat) && Number.isFinite(saved.lon) && Number.isFinite(saved.zoom)) {
        view.lat = clampLat(saved.lat);
        view.lon = wrapLon(saved.lon);
        view.zoom = clampZoom(saved.zoom);
      }
      if (saved?.tab === 'places') tab = 'places';
    } catch {}
    let results = [];
    let places = [];
    let selected = null; // { name, display, lat, lon, zoom?, bbox? }
    let searchGen = 0;
    let lastQuery = '';
    let tileErrors = 0;

    // ------------------------------------------------------------ DOM
    const input = h('input', {
      class: 'input mp-input',
      type: 'search',
      placeholder: t('search.placeholder'),
      'aria-label': t('search.label'),
      autocomplete: 'off',
      spellcheck: 'false',
      maxlength: '200',
    });
    const clearBtn = h('button', { class: 'btn subtle mp-icon-btn mp-clear', type: 'button', title: t('search.clear'), 'aria-label': t('search.clear'), hidden: true, onclick: () => clearSearch() }, icon('dismiss'));
    const goBtn = h('button', { class: 'btn primary mp-icon-btn mp-go', type: 'submit', title: t('search.go'), 'aria-label': t('search.go') }, icon('search'));
    const form = h('form', { class: 'mp-search', role: 'search', onsubmit: (e) => (e.preventDefault(), runSearch(input.value)) }, input, clearBtn, goBtn);
    input.addEventListener('input', () => (clearBtn.hidden = !input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' && tab === 'results') {
        const first = list.querySelector('.mp-item-main');
        if (first) (e.preventDefault(), first.focus());
      } else if (e.key === 'Escape' && input.value) {
        e.preventDefault();
        e.stopPropagation();
        clearSearch();
      }
    });

    const tabBtns = {};
    const tabList = h('div', { class: 'mp-tabs', role: 'tablist', 'aria-label': t('tabs.label') });
    for (const id of ['results', 'places']) {
      tabBtns[id] = h(
        'button',
        {
          class: 'mp-tab',
          type: 'button',
          role: 'tab',
          id: `mp-tab-${id}`,
          'aria-controls': 'mp-list',
          dataset: { tab: id },
          onclick: () => selectTab(id, true),
          onkeydown: (e) => {
            if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
              e.preventDefault();
              selectTab(id === 'results' ? 'places' : 'results', true);
            }
          },
        },
        t(`tabs.${id}`),
      );
      tabList.append(tabBtns[id]);
    }
    const status = h('div', { class: 'mp-status caption', role: 'status', 'aria-live': 'polite' });
    const list = h('ul', { class: 'mp-list', id: 'mp-list', role: 'tabpanel' });
    list.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const items = [...list.querySelectorAll('.mp-item-main')];
      const i = items.indexOf(document.activeElement);
      if (i < 0) return;
      e.preventDefault();
      if (e.key === 'ArrowUp' && i === 0 && tab === 'results') input.focus();
      else items[Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))].focus();
    });
    const side = h('aside', { class: 'mp-side' }, form, tabList, status, list);

    const tilesLayer = h('div', { class: 'mp-tiles', 'aria-hidden': 'true' });
    const markersLayer = h('div', { class: 'mp-markers', 'aria-hidden': 'true' });
    const map = h('div', { class: 'mp-map', tabindex: '0', role: 'application', 'aria-roledescription': t('app'), 'aria-label': t('map.label') }, tilesLayer, markersLayer);
    const panelBtn = h('button', { class: 'btn mp-float mp-icon-btn mp-panel-btn', type: 'button', title: t('map.togglePanel'), 'aria-label': t('map.togglePanel'), 'aria-expanded': 'true', onclick: () => togglePanel() }, icon('navigation'));
    const zoomInBtn = h('button', { class: 'mp-zbtn mp-zoom-in', type: 'button', title: `${t('map.zoomIn')} (+)`, 'aria-label': t('map.zoomIn'), onclick: () => zoomBy(1) }, icon('add'));
    const zoomOutBtn = h('button', { class: 'mp-zbtn mp-zoom-out', type: 'button', title: `${t('map.zoomOut')} (-)`, 'aria-label': t('map.zoomOut'), onclick: () => zoomBy(-1) }, icon('subtract'));
    const zoomLabel = h('div', { class: 'mp-zlabel caption', 'aria-hidden': 'true' });
    const zoomBox = h('div', { class: 'mp-zoom mp-float' }, zoomInBtn, h('div', { class: 'mp-zsep' }), zoomOutBtn);
    const scaleLine = h('div', { class: 'mp-scale-bar' });
    const scaleText = h('span', { class: 'mp-scale-text' });
    const scale = h('div', { class: 'mp-scale', 'aria-hidden': 'true' }, scaleText, scaleLine);
    const attrib = h('button', { class: 'mp-attrib', type: 'button', title: t('map.attributionTip'), onclick: () => shell.openUrl?.(OSM_COPYRIGHT) }, t('map.attribution'));
    const card = h('div', { class: 'mp-card mp-float', role: 'region', 'aria-label': t('map.selected'), hidden: true });
    const mapWrap = h('div', { class: 'mp-mapwrap' }, map, panelBtn, card, h('div', { class: 'mp-zoomwrap' }, zoomBox, zoomLabel), h('div', { class: 'mp-bottom' }, scale, attrib));
    const root = h('div', { class: 'mp-root' }, side, mapWrap);
    win.body.append(root);

    // ------------------------------------------------------------ geometry
    let W = 1;
    let H = 1;
    const measure = () => {
      const r = map.getBoundingClientRect();
      W = Math.max(1, Math.round(r.width));
      H = Math.max(1, Math.round(r.height));
    };
    const worldCenter = (z = view.zoom) => project(view.lat, view.lon, z);
    /** screen point (relative to the map) -> lat/lon */
    function screenToGeo(px, py) {
      const c = worldCenter();
      const g = unproject(c.x + (px - W / 2), c.y + (py - H / 2), view.zoom);
      return { lat: g.lat, lon: wrapLon(g.lon) };
    }
    /** lat/lon -> screen point, choosing the world copy closest to the centre */
    function geoToScreen(lat, lon) {
      const c = worldCenter();
      const p = project(lat, lon, view.zoom);
      const size = 256 * 2 ** view.zoom;
      let dx = p.x - c.x;
      dx -= Math.round(dx / size) * size;
      return { x: W / 2 + dx, y: H / 2 + (p.y - c.y) };
    }
    function setCenterWorld(x, y, z = view.zoom) {
      const g = unproject(x, y, z);
      view.lat = clampLat(g.lat);
      view.lon = wrapLon(g.lon);
    }
    function panBy(dx, dy) {
      const c = worldCenter();
      setCenterWorld(c.x + dx, c.y + dy);
      changed();
    }
    function zoomAround(px, py, z) {
      z = clampZoom(z);
      if (z === view.zoom) return;
      const g = screenToGeo(px, py);
      view.zoom = z;
      const p = project(g.lat, g.lon, z);
      setCenterWorld(p.x - (px - W / 2), p.y - (py - H / 2), z);
      changed();
    }
    function zoomBy(step, at) {
      const base = Math.round(view.zoom);
      const z = clampZoom(step > 0 ? (view.zoom > base ? Math.ceil(view.zoom) : base + 1) : view.zoom < base ? Math.floor(view.zoom) : base - 1);
      zoomAround(at ? at.x : W / 2, at ? at.y : H / 2, z);
    }
    function setView(lat, lon, zoom) {
      view.lat = clampLat(Number(lat));
      view.lon = wrapLon(Number(lon));
      if (zoom != null) view.zoom = clampZoom(Number(zoom));
      changed();
    }

    // ------------------------------------------------------------ tiles (max 2 requests in flight, no prefetch)
    const tileCache = new Map(); // "z/x/y" -> data URL
    const tileEls = new Map(); // "z/rawX/y" -> { img, key }
    const queue = []; // keys waiting
    const loading = new Set();
    let wanted = new Set();
    const stats = { requested: 0, maxInFlight: 0, errors: 0 };
    function cacheTile(key, url) {
      tileCache.delete(key);
      tileCache.set(key, url);
      if (tileCache.size > TILE_CACHE) tileCache.delete(tileCache.keys().next().value);
    }
    function pumpTiles() {
      while (!closed && loading.size < MAX_TILE_REQUESTS && queue.length) {
        const key = queue.shift();
        if (!wanted.has(key) || tileCache.has(key) || loading.has(key)) continue;
        loading.add(key);
        stats.requested++;
        stats.maxInFlight = Math.max(stats.maxInFlight, loading.size);
        const [z, x, y] = key.split('/').map(Number);
        api
          .invoke('maps:tile', z, x, y)
          .then((r) => {
            if (closed || !r?.url) return;
            cacheTile(key, r.url);
            for (const e of tileEls.values()) if (e.key === key) setTileSrc(e, r.url);
          })
          .catch(() => {
            stats.errors++;
            tileErrors++;
            for (const e of tileEls.values()) if (e.key === key) e.img.classList.add('error');
            updateStatusTiles();
          })
          .finally(() => {
            loading.delete(key);
            pumpTiles();
          });
      }
    }
    function setTileSrc(e, url) {
      if (e.img.getAttribute('src') === url) return;
      e.img.classList.remove('error');
      e.img.src = url;
    }
    function renderTiles() {
      const { tiles } = visibleTiles(view.lat, view.lon, view.zoom, W, H);
      const keep = new Set();
      wanted = new Set();
      queue.length = 0;
      for (const tl of tiles) {
        const key = `${tl.z}/${tl.x}/${tl.y}`;
        const elKey = `${tl.z}/${tl.rawX}/${tl.y}`;
        keep.add(elKey);
        wanted.add(key);
        let e = tileEls.get(elKey);
        if (!e) {
          const img = h('img', { class: 'mp-tile', alt: '', draggable: 'false', decoding: 'async', dataset: { key } });
          img.addEventListener('load', () => img.classList.add('loaded'));
          e = { img, key };
          tileEls.set(elKey, e);
          tilesLayer.append(img);
        }
        const sz = Math.ceil(tl.size * 100) / 100 + 0.5;
        e.img.style.transform = `translate(${tl.left}px, ${tl.top}px)`;
        e.img.style.width = `${sz}px`;
        e.img.style.height = `${sz}px`;
        const url = tileCache.get(key);
        if (url) setTileSrc(e, url);
        else if (!loading.has(key)) queue.push(key);
      }
      for (const [k, e] of tileEls) {
        if (!keep.has(k)) {
          e.img.remove();
          tileEls.delete(k);
        }
      }
      pumpTiles();
    }

    // ------------------------------------------------------------ markers, scale, zoom label
    function renderMarkers() {
      markersLayer.replaceChildren();
      for (const p of places) {
        if (selected && Math.abs(selected.lat - p.lat) < 1e-5 && Math.abs(selected.lon - p.lon) < 1e-5) continue; // under the pin
        const s = geoToScreen(p.lat, p.lon);
        if (s.x < -20 || s.y < -20 || s.x > W + 20 || s.y > H + 20) continue;
        markersLayer.append(h('div', { class: 'mp-dot', style: { transform: `translate(${s.x}px, ${s.y}px)` }, dataset: { id: p.id }, title: p.name }));
      }
      if (selected) {
        const s = geoToScreen(selected.lat, selected.lon);
        const pin = h('div', { class: 'mp-pin', html: PIN_SVG });
        pin.style.transform = `translate(${s.x}px, ${s.y}px)`;
        markersLayer.append(pin);
      }
    }
    function renderChrome() {
      const sb = scaleBar(view.lat, view.zoom, 100);
      scaleLine.style.width = `${Math.round(sb.px)}px`;
      scaleText.textContent = t(`scale.${sb.unit}`, { n: nf(sb.value) });
      zoomLabel.textContent = t('map.zoomLevel', { z: nf(view.zoom, 1) });
      zoomInBtn.disabled = view.zoom >= MAX_ZOOM;
      zoomOutBtn.disabled = view.zoom <= MIN_ZOOM;
    }
    let raf = 0;
    function renderNow() {
      cancelAnimationFrame(raf);
      raf = 0;
      if (closed) return;
      measure();
      renderTiles();
      renderMarkers();
      renderChrome();
    }
    const scheduleRender = () => {
      if (!raf && !closed) raf = requestAnimationFrame(renderNow);
    };
    let saveTimer = 0;
    function changed() {
      scheduleRender();
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => storage?.set?.('view', { lat: view.lat, lon: view.lon, zoom: Math.round(view.zoom * 100) / 100, tab })?.catch?.(() => {}), 500);
    }

    // ------------------------------------------------------------ pointer: drag to pan, pinch to zoom
    const pointers = new Map();
    let pinch = null;
    let dragged = false;
    const local = (e) => {
      const r = map.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    map.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      map.focus({ preventScroll: true });
      map.setPointerCapture?.(e.pointerId);
      pointers.set(e.pointerId, local(e));
      dragged = false;
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, zoom: view.zoom };
      }
      map.classList.add('dragging');
    });
    map.addEventListener('pointermove', (e) => {
      const prev = pointers.get(e.pointerId);
      if (!prev) return;
      const p = local(e);
      pointers.set(e.pointerId, p);
      if (pointers.size >= 2 && pinch) {
        const [a, b] = [...pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        zoomAround((a.x + b.x) / 2, (a.y + b.y) / 2, pinch.zoom + Math.log2(dist / pinch.dist));
        dragged = true;
        return;
      }
      const dx = p.x - prev.x;
      const dy = p.y - prev.y;
      if (dx || dy) {
        dragged = true;
        panBy(-dx, -dy);
      }
    });
    const endPointer = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (!pointers.size) map.classList.remove('dragging');
    };
    map.addEventListener('pointerup', endPointer);
    map.addEventListener('pointercancel', endPointer);
    map.addEventListener('dblclick', (e) => {
      e.preventDefault();
      zoomBy(e.shiftKey ? -1 : 1, local(e));
    });
    // wheel / trackpad pinch (ctrl+wheel): fractional zoom, snapped to a whole level when the wheel stops
    let snapTimer = 0;
    map.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const at = local(e);
        const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 400 : 1;
        let dz = (-e.deltaY * unit) / (e.ctrlKey ? 100 : 120);
        dz = Math.max(-1, Math.min(1, dz));
        zoomAround(at.x, at.y, view.zoom + dz);
        clearTimeout(snapTimer);
        snapTimer = setTimeout(() => zoomAround(at.x, at.y, Math.round(view.zoom)), 220);
      },
      { passive: false },
    );
    // keyboard: arrows pan, + / - zoom
    map.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      const step = e.shiftKey ? 300 : 100;
      const k = e.key;
      if (k === 'ArrowLeft') panBy(-step, 0);
      else if (k === 'ArrowRight') panBy(step, 0);
      else if (k === 'ArrowUp') panBy(0, -step);
      else if (k === 'ArrowDown') panBy(0, step);
      else if (k === '+' || k === '=' || k === 'Add') zoomBy(1);
      else if (k === '-' || k === '_' || k === 'Subtract') zoomBy(-1);
      else return;
      e.preventDefault();
    });
    win.body.addEventListener('keydown', (e) => {
      if ((e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') || (e.key === '/' && document.activeElement === map)) {
        e.preventDefault();
        openPanel(true);
        input.focus();
        input.select();
      }
    });
    const ro = new ResizeObserver(() => {
      root.classList.toggle('narrow', root.getBoundingClientRect().width < 640);
      scheduleRender();
    });
    ro.observe(map);
    ro.observe(root);
    cleanups.push(() => ro.disconnect());

    // ------------------------------------------------------------ side panel
    function togglePanel() {
      openPanel(root.classList.contains('collapsed'));
    }
    function openPanel(open) {
      root.classList.toggle('collapsed', !open);
      panelBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      scheduleRender();
    }
    function selectTab(id, focus) {
      tab = id;
      for (const [k, b] of Object.entries(tabBtns)) {
        const on = k === id;
        b.classList.toggle('selected', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
        b.tabIndex = on ? 0 : -1;
      }
      list.setAttribute('aria-labelledby', `mp-tab-${id}`);
      if (focus) tabBtns[id].focus();
      renderList();
      showTabStatus();
      changed();
    }
    const isSaved = (p) => !!p && places.some((x) => Math.abs(x.lat - p.lat) < 1e-5 && Math.abs(x.lon - p.lon) < 1e-5);
    function renderList() {
      const items = [];
      if (tab === 'results') {
        results.forEach((r, i) => {
          items.push(
            h(
              'li',
              { class: ['mp-item', selected && selected.id === r.id && selected.lat === r.lat ? 'selected' : ''], dataset: { index: String(i) } },
              h(
                'button',
                { class: 'mp-item-main', type: 'button', onclick: () => select(r) },
                h('span', { class: 'mp-item-icon' }, icon('location')),
                h('span', { class: 'mp-item-text' }, h('span', { class: 'mp-item-name' }, r.name), h('span', { class: 'mp-item-sub caption' }, r.display || '')),
              ),
            ),
          );
        });
      } else {
        if (!places.length) items.push(h('li', { class: 'mp-empty caption' }, t('places.empty')));
        for (const p of places) {
          items.push(
            h(
              'li',
              { class: 'mp-item mp-place', dataset: { id: p.id } },
              h(
                'button',
                { class: 'mp-item-main', type: 'button', onclick: () => select({ ...p, saved: true }, { useZoom: true }) },
                h('span', { class: 'mp-item-icon star' }, icon('star')),
                h('span', { class: 'mp-item-text' }, h('span', { class: 'mp-item-name' }, p.name), h('span', { class: 'mp-item-sub caption' }, p.display || formatCoords(p.lat, p.lon, 4, dirs))),
              ),
              h('button', { class: 'btn subtle mp-icon-btn mp-rename', type: 'button', title: t('places.rename'), 'aria-label': `${t('places.rename')} ${p.name}`, onclick: () => renamePlace(p) }, icon('edit')),
              h('button', { class: 'btn subtle mp-icon-btn mp-remove', type: 'button', title: t('places.removeTip', { name: p.name }), 'aria-label': t('places.removeTip', { name: p.name }), onclick: () => removePlace(p) }, icon('delete')),
            ),
          );
        }
      }
      list.replaceChildren(...items);
    }
    let resultStatus = '';
    function showTabStatus() {
      if (tab === 'places') status.textContent = '';
      else if (!status.dataset.busy) status.textContent = resultStatus || t('search.hint');
    }

    // ------------------------------------------------------------ search
    async function runSearch(q) {
      q = String(q || '').trim();
      if (q.length < 2) return;
      const gen = ++searchGen;
      lastQuery = q;
      selectTab('results');
      status.dataset.busy = '1';
      status.textContent = t('search.searching');
      root.classList.add('busy');
      try {
        const res = await api.invoke('maps:search', q, { lang });
        if (gen !== searchGen || closed) return;
        results = Array.isArray(res) ? res : [];
        delete status.dataset.busy;
        resultStatus = results.length ? t('search.results', { count: results.length }) : t('search.none', { q });
        status.textContent = resultStatus;
        renderList();
        if (results.length) select(results[0], { focusList: false });
      } catch {
        if (gen !== searchGen || closed) return;
        results = [];
        delete status.dataset.busy;
        resultStatus = t('search.error');
        status.textContent = resultStatus;
        renderList();
      } finally {
        if (gen === searchGen) root.classList.remove('busy');
      }
    }
    function clearSearch() {
      searchGen++;
      input.value = '';
      clearBtn.hidden = true;
      results = [];
      lastQuery = '';
      resultStatus = '';
      delete status.dataset.busy;
      root.classList.remove('busy');
      status.textContent = t('search.hint');
      renderList();
      input.focus();
    }

    // ------------------------------------------------------------ selection card
    function select(place, { useZoom = false } = {}) {
      selected = place;
      measure();
      let z = useZoom && place.zoom ? place.zoom : fitZoom(place.bbox, W, H);
      if (z == null) z = place.zoom || 15;
      setView(place.lat, place.lon, Math.min(17, z));
      renderCard();
      for (const li of list.querySelectorAll('.mp-item')) li.classList.toggle('selected', li.dataset.index != null && results[li.dataset.index] === place);
    }
    function renderCard() {
      if (!selected) {
        card.hidden = true;
        card.replaceChildren();
        return;
      }
      const saved = isSaved(selected);
      const saveBtn = h(
        'button',
        { class: ['btn', saved ? '' : 'primary', 'mp-save'], type: 'button', title: t('places.saveTip'), 'aria-pressed': saved ? 'true' : 'false', disabled: saved, onclick: () => savePlace(selected) },
        icon('star'),
        h('span', null, saved ? t('places.saved') : t('places.save')),
      );
      card.replaceChildren(
        h(
          'div',
          { class: 'mp-card-head' },
          h('div', { class: 'mp-card-title body-strong' }, selected.name),
          h('button', { class: 'btn subtle mp-icon-btn mp-card-close', type: 'button', title: t('map.close'), 'aria-label': t('map.close'), onclick: () => closeCard() }, icon('dismiss')),
        ),
        selected.display ? h('div', { class: 'mp-card-sub caption' }, selected.display) : '',
        h('div', { class: 'mp-card-coords caption' }, formatCoords(selected.lat, selected.lon, 5, dirs)),
        h('div', { class: 'mp-card-actions' }, saveBtn, h('button', { class: 'btn mp-center', type: 'button', onclick: () => setView(selected.lat, selected.lon) }, icon('location'), h('span', null, t('map.center')))),
      );
      card.hidden = false;
    }
    function closeCard() {
      selected = null;
      renderCard();
      scheduleRender();
      map.focus();
    }

    // ------------------------------------------------------------ My places
    async function loadPlaces() {
      try {
        const r = await api.invoke('maps:places');
        places = Array.isArray(r) ? r : [];
      } catch {
        places = [];
      }
      if (closed) return;
      renderList();
      renderCard();
      scheduleRender();
    }
    async function savePlace(p) {
      if (!p) return;
      try {
        places = await api.invoke('maps:savePlace', { name: p.name, display: p.display || '', lat: p.lat, lon: p.lon, zoom: Math.round(view.zoom) });
        status.textContent = t('places.savedToast', { name: p.name });
      } catch {
        status.textContent = t('places.error');
      }
      if (closed) return;
      renderCard();
      renderList();
      scheduleRender();
      card.querySelector('.mp-center')?.focus();
    }
    async function removePlace(p) {
      try {
        places = await api.invoke('maps:removePlace', p.id);
      } catch {
        status.textContent = t('places.error');
      }
      if (closed) return;
      renderList();
      renderCard();
      scheduleRender();
      (list.querySelector('.mp-item-main') || tabBtns.places).focus();
    }
    async function renamePlace(p) {
      const name = await ui.prompt({ title: t('places.renameTitle'), label: t('places.nameLabel'), value: p.name, parent: win });
      if (closed || name == null || !String(name).trim()) return;
      try {
        places = await api.invoke('maps:renamePlace', p.id, String(name).trim());
      } catch {
        status.textContent = t('places.error');
      }
      renderList();
      scheduleRender();
    }
    function updateStatusTiles() {
      root.classList.toggle('tile-errors', tileErrors > 0);
      attrib.title = tileErrors ? `${t('map.attributionTip')} — ${t('map.tileError')}` : t('map.attributionTip');
    }

    // ------------------------------------------------------------ start
    win.on?.('close', () => {
      closed = true;
      cancelAnimationFrame(raf);
      clearTimeout(saveTimer);
      clearTimeout(snapTimer);
      for (const fn of cleanups) fn();
    });
    selectTab(tab);
    renderNow();
    loadPlaces();
    setTimeout(() => !closed && map.focus({ preventScroll: true }), 0);

    win.body.__maps = {
      get view() {
        return { ...view };
      },
      get selected() {
        return selected ? { ...selected } : null;
      },
      get results() {
        return results.slice();
      },
      get places() {
        return places.slice();
      },
      get tab() {
        return tab;
      },
      get tileStats() {
        return { ...stats, cached: tileCache.size, elements: tileEls.size, inFlight: loading.size, queued: queue.length };
      },
      get size() {
        return { W, H };
      },
      setView,
      renderNow,
      runSearch,
      selectTab,
      screenToGeo,
      geoToScreen,
    };
    return {
      onRelaunch() {
        win.focus?.();
      },
    };
  },
};
