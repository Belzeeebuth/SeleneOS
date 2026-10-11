'use strict';
// Store backend: one catalogue merged from three sources (docs/STORE-SOURCES.md):
//   selene  — the curated catalog.json (tools, services, hand-picked GUI apps; apt, installed through the UAC prompt)
//   ubuntu  — shell/main/lib/sources/ubuntu.js  (DEP-11 desktop apps of the Ubuntu archive; apt, UAC prompt)
//   flathub — shell/main/lib/sources/flathub.js (Flathub; flatpak --user, no privileges)
// Source modules are loaded inside try/catch: a missing or broken module only hides that source.
//
// Curated catalog (unchanged, used by the selene source and older callers):
//   store:catalog ()   -> { items: [{ id, apt, name, category, icon, command, interactive,
//                                     description: { en, fr }, gui, desktop, linuxId, appId }], simulated }
//                         gui: true for graphical apps; desktop = their .desktop file in the package, linuxId = the
//                         registry id of the matching Linux app ('linux.<desktop id>', main/ipc/xapps.js).
//                         from /usr/share/aurora/store/catalog.json (dev: the copy in rootfs/ of the repo)
//   store:installed () -> { packages: { [apt]: version }, simulated }   (dpkg-query; only catalog packages)
//
// Merged catalogue (Entry = one app, merged by AppStream id across sources):
//   Entry = { key, appId, name, summary, icon (https:|media:|data: URL or null), fluentIcon (selene tile icon),
//             categories: [freedesktop main category], sources: [{ source, id, installed, desktopId, version }]
//             (ordered selene > ubuntu > flathub), defaultSource, installed, installedSource, desktopId,
//             selene?: { apt, command, interactive, removable, gui, linuxId, category } }
//   store:sources ()                    -> { sources: [{ id, label, admin, enabled, toggleable, available, ready,
//                                            updatedAt, count, error, errorCode, refreshing }], live }
//   store:setEnabled (id, on)           -> same as store:sources (only toggleable sources: flathub)
//   store:refresh (id)                  -> { ok } ; (+store:progress { kind: 'refresh', source, phase, percent })
//   store:home ()                       -> { featured: [Entry], picks: [Entry], tools: [Entry], toolsTotal,
//                                            rows: [{ category, items, total }], total }
//   store:search ({ query, category, source, offset, limit<=60 }) -> { items: [Entry], total, offset }
//   store:details (key, source?)        -> { entry, source, details: { description, screenshots, homepage,
//                                            license, developer, version, downloadSize, admin } }
//   store:install (source, id) / store:remove (source, id)   (non-admin sources only: flathub)
//                                       -> { desktopId } ; (+store:progress { kind, source, id, percent, message })
//                                       Admin sources (selene, ubuntu) are installed by the app through
//                                       shell.runAdmin('store-install' | 'store-remove', [apt]) (UAC prompt).
//   store:installedAll ()               -> { items: [Entry] }   installed apps of every source
//   store:invalidate ()                 -> drop the merged index (after a UAC install); broadcasts store:changed
//   (+store:changed { source?, id?, action? })  the catalogue or installed state changed
//
// Dev / tests (api.DEV unless AURORA_REAL_BACKENDS=1): installed state of apt packages is the in-memory
// simulation shared with admin.js (dev.storeState()), so a simulated install is immediately visible here.
// AURORA_STORE_SOURCES_DIR (DEV only) loads the source modules from another directory (test stubs).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run } = require('../lib/exec');

const SYS_CATALOG = '/usr/share/aurora/store/catalog.json';
const DEV_CATALOG = path.join(__dirname, '..', '..', '..', 'rootfs', 'usr', 'share', 'aurora', 'store', 'catalog.json');
const PKG = /^[a-z0-9][a-z0-9+.-]{1,62}$/;
const ID = /^[a-z0-9][a-z0-9+._-]{0,62}$/;
const CATEGORIES = new Set(['development', 'editors', 'shells', 'system', 'utilities', 'multimedia', 'network', 'graphics', 'office']);
const DESKTOP = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.desktop$/;
const APPID = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;
const FLATPAK_ID = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+){2,}$/;
// AppStream ids of the curated GUI apps whose .desktop file name is not their component id (merge key).
const SELENE_APPID = {
  gimp: 'org.gimp.GIMP',
  vlc: 'org.videolan.VLC',
  audacity: 'org.audacityteam.Audacity',
  filezilla: 'org.filezillaproject.Filezilla',
  'libreoffice-writer': 'org.libreoffice.LibreOffice.writer',
  'libreoffice-calc': 'org.libreoffice.LibreOffice.calc',
  'libreoffice-impress': 'org.libreoffice.LibreOffice.impress',
};
const SOURCE_IDS = ['ubuntu', 'flathub'];
const ORDER = { selene: 0, ubuntu: 1, flathub: 2 };
const ADMIN_SOURCES = new Set(['selene', 'ubuntu']);
const FD_CATEGORIES = ['AudioVideo', 'Development', 'Education', 'Game', 'Graphics', 'Network', 'Office', 'Science', 'Settings', 'System', 'Utility'];
const SELENE_FD = { development: 'Development', editors: 'Development', shells: 'System', system: 'System', utilities: 'Utility', multimedia: 'AudioVideo', network: 'Network', graphics: 'Graphics', office: 'Office' };
const FEATURED = ['org.mozilla.firefox', 'org.gimp.GIMP', 'org.videolan.VLC', 'org.libreoffice.LibreOffice', 'com.spotify.Client', 'com.discordapp.Discord', 'org.inkscape.Inkscape', 'org.kde.krita', 'com.obsproject.Studio', 'org.blender.Blender', 'org.audacityteam.Audacity', 'org.telegram.desktop'];
const MAX_PAGE = 60;
const SOURCE_CAP = 20000; // items read from one source to build the merged index

const str = (v, max = 400) => (typeof v === 'string' ? v.slice(0, max) : '');

/** Validate and normalize the catalog JSON (unit-tested). Drops invalid entries. */
function parseCatalog(json) {
  const items = [];
  const seen = new Set();
  for (const it of Array.isArray(json?.items) ? json.items : []) {
    if (!it || typeof it !== 'object') continue;
    const apt = str(it.apt, 64);
    const id = str(it.id, 64) || apt;
    if (!PKG.test(apt) || !ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    const d = it.description && typeof it.description === 'object' ? it.description : {};
    const gui = it.gui === true && DESKTOP.test(it.desktop || '');
    items.push({
      id,
      apt,
      name: str(it.name, 80) || apt,
      category: CATEGORIES.has(it.category) ? it.category : 'utilities',
      icon: /^[a-z0-9_]{1,64}$/.test(it.icon || '') ? it.icon : 'apps',
      command: /^[A-Za-z0-9][A-Za-z0-9+._-]{0,63}$/.test(it.command || '') ? it.command : '',
      interactive: it.interactive === true,
      removable: it.removable !== false,
      description: { en: str(d.en), fr: str(d.fr) || str(d.en) },
      gui,
      desktop: gui ? it.desktop : '',
      linuxId: gui ? require('./xapps').parsers.appIdOf(it.desktop.replace(/\.desktop$/, '')) : '',
      appId: APPID.test(it.appId || '') ? it.appId : SELENE_APPID[id] || (gui ? it.desktop.replace(/\.desktop$/, '') : null),
    });
  }
  return items;
}

/** dpkg-query -W -f '${Package}\t${db:Status-Abbrev}\t${Version}\n' output -> { pkg: version } (unit-tested) */
function parseDpkgQuery(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const [pkg, status, version] = line.split('\t');
    if (pkg && PKG.test(pkg.replace(/:.*$/, '')) && /^ii/.test(status || '')) out[pkg.replace(/:.*$/, '')] = (version || '').trim();
  }
  return out;
}


const ICON_URL = /^(https:\/\/|media:\/\/|data:image\/(png|svg\+xml|jpeg|webp);)/;
const safeUrl = (v, re = ICON_URL, max = 4096) => (typeof v === 'string' && v.length <= (v.startsWith('data:') ? 262144 : max) && re.test(v) ? v : null);

/** Validate one Item of a source module (unit-tested). Returns null when unusable. */
function sanitizeItem(it, source) {
  if (!it || typeof it !== 'object') return null;
  const id = str(it.id, 255);
  if (!id) return null;
  if (source === 'flathub' && !FLATPAK_ID.test(id)) return null;
  if ((source === 'ubuntu' || source === 'selene') && !PKG.test(id) && !ID.test(id)) return null;
  // Modules give the AppStream id without a '.desktop' suffix (contract); 'org.telegram.desktop' is a real id.
  const appId = str(it.appId, 255);
  return {
    source,
    id,
    appId: APPID.test(appId) ? appId : null,
    name: str(it.name, 120) || id,
    summary: str(it.summary, 300),
    icon: safeUrl(it.icon),
    categories: Array.isArray(it.categories) ? [...new Set(it.categories.filter((c) => FD_CATEGORIES.includes(c)))] : [],
    installed: it.installed === true,
    desktopId: DESKTOP.test(it.desktopId || '') ? it.desktopId : null,
    version: str(it.version, 80),
  };
}

/** The selene (curated) source as Items. */
function seleneItems(catalog, packages) {
  return catalog.map((c) => ({
    source: 'selene',
    id: c.id,
    appId: c.appId,
    name: c.name,
    summary: '',
    icon: null,
    categories: [SELENE_FD[c.category] || 'Utility'],
    installed: Object.prototype.hasOwnProperty.call(packages, c.apt),
    desktopId: c.gui ? c.desktop : null,
    version: packages[c.apt] || '',
    _c: c,
  }));
}

const keyOf = (it) => (it.appId ? it.appId.toLowerCase() : `${it.source}:${it.id}`);

/** Merge Items of every source into Entries, one per AppStream id (unit-tested). */
function mergeItems(items, { lang = 'en' } = {}) {
  const map = new Map();
  for (const it of items) {
    if (!it) continue;
    const key = keyOf(it);
    let e = map.get(key);
    if (!e) {
      e = { key, appId: it.appId, name: it.name, summary: it.summary, icon: null, fluentIcon: null, categories: [], sources: [], _items: [] };
      map.set(key, e);
    }
    if (e._items.some((x) => x.source === it.source)) continue;
    e._items.push(it);
  }
  for (const e of map.values()) {
    e._items.sort((a, b) => ORDER[a.source] - ORDER[b.source]);
    const first = e._items[0];
    e.name = first.name;
    e.summary = e._items.map((i) => (i.source === 'selene' ? i._c?.description?.[lang] || i._c?.description?.en || '' : i.summary)).find(Boolean) || '';
    e.icon = e._items.map((i) => i.icon).find(Boolean) || null;
    e.categories = [...new Set(e._items.flatMap((i) => i.categories))];
    e.sources = e._items.map((i) => ({ source: i.source, id: i.id, installed: i.installed, desktopId: i.desktopId, version: i.version || '' }));
    e.defaultSource = e.sources[0].source;
    const inst = e.sources.find((s) => s.installed);
    e.installed = !!inst;
    e.installedSource = inst ? inst.source : null;
    e.desktopId = (inst || e.sources.find((s) => s.desktopId) || {}).desktopId || null;
    const sel = e._items.find((i) => i.source === 'selene');
    if (sel) {
      const c = sel._c;
      e.fluentIcon = c.icon;
      e.selene = { apt: c.apt, command: c.command, interactive: c.interactive, removable: c.removable, gui: c.gui, linuxId: c.linuxId, category: c.category };
    }
    delete e._items;
  }
  return map;
}

/** Search ranking: name prefix > name match > other; featured and multi-source apps first (unit-tested). */
function rankEntries(list, query) {
  const q = String(query || '').toLowerCase().trim();
  const feat = new Map(FEATURED.map((id, i) => [id.toLowerCase(), i]));
  const score = (e) => {
    const n = e.name.toLowerCase();
    const text = q ? (n.startsWith(q) ? 0 : n.includes(q) ? 1 : 2) : 0;
    return [text, feat.has(e.key) ? feat.get(e.key) : 99, -e.sources.length, e.icon || e.fluentIcon ? 0 : 1];
  };
  const scored = list.map((e) => [score(e), e]);
  scored.sort((a, b) => {
    for (let i = 0; i < a[0].length; i++) if (a[0][i] !== b[0][i]) return a[0][i] - b[0][i];
    return a[1].name.localeCompare(b[1].name);
  });
  return scored.map((s) => s[1]);
}

function register(api) {
  const useMock = api.DEV && process.env.AURORA_REAL_BACKENDS !== '1';
  let cache = null;

  function loadCatalog() {
    // Real system: the root-owned copy (the one the helper checks); dev: the repo copy when present.
    const [first, second] = useMock ? [DEV_CATALOG, SYS_CATALOG] : [SYS_CATALOG, DEV_CATALOG];
    const file = fs.existsSync(first) ? first : second;
    try {
      const st = fs.statSync(file);
      if (cache && cache.file === file && cache.mtime === st.mtimeMs) return cache.items;
      const items = parseCatalog(JSON.parse(fs.readFileSync(file, 'utf8')));
      cache = { file, mtime: st.mtimeMs, items };
      return items;
    } catch {
      return [];
    }
  }

  async function installedPackages() {
    const pkgs = loadCatalog().map((i) => i.apt);
    if (useMock) {
      const st = require('./admin').dev.storeState();
      const packages = {};
      for (const p of pkgs) if (st.installed.has(p)) packages[p] = st.installed.get(p);
      return packages;
    }
    if (!pkgs.length) return {};
    // Exit code 1 when some packages are unknown to dpkg: the known ones are still printed.
    const r = await run('dpkg-query', ['-W', '-f=${Package}\t${db:Status-Abbrev}\t${Version}\n', '--', ...pkgs], { timeout: 15000 }).catch(() => null);
    return parseDpkgQuery(r?.stdout);
  }

  api.handle('store:catalog', async () => ({ items: loadCatalog(), simulated: useMock }));
  api.handle('store:installed', async () => ({ packages: await installedPackages(), simulated: useMock }));

  // ------------------------------------------------------------------ source modules
  const devDir = api.DEV && process.env.AURORA_STORE_SOURCES_DIR && path.isAbsolute(process.env.AURORA_STORE_SOURCES_DIR) ? process.env.AURORA_STORE_SOURCES_DIR : null;
  const SRC_DIR = devDir || path.join(__dirname, '..', 'lib', 'sources');
  const modules = new Map();
  for (const id of SOURCE_IDS) {
    try {
      const file = path.join(SRC_DIR, `${id}.js`);
      if (!fs.existsSync(file)) continue;
      const mod = require(file);
      if (!mod || typeof mod.search !== 'function') continue;
      mod.init?.({ api, DEV: api.DEV, env: api.env, home: os.homedir(), broadcast: (ch, p) => api.broadcast(ch, p) });
      modules.set(id, mod);
    } catch (e) {
      console.warn(`[store] source ${id} not loaded:`, e?.message || e);
    }
  }
  const PREFS = path.join(os.homedir(), '.config', 'aurora', 'store-sources.json');
  let prefs = { disabled: [] };
  try {
    const p = JSON.parse(fs.readFileSync(PREFS, 'utf8'));
    if (Array.isArray(p?.disabled)) prefs.disabled = p.disabled.filter((x) => SOURCE_IDS.includes(x));
  } catch {}
  const enabled = (id) => id === 'selene' || (modules.has(id) && !prefs.disabled.includes(id));
  const refreshing = new Map(); // id -> promise
  const lastError = new Map(); // id -> { message, code } of the last failed refresh
  // Same order as the source modules: the shell setting, then env.lang.
  const lang = () => ((api.settings?.get?.('lang') || api.env?.lang) === 'fr' ? 'fr' : 'en');
  const quiet = (msg, code) => Object.assign(new Error(msg), { code, quiet: true });

  async function fetchAll(mod, source, params) {
    const out = [];
    let offset = 0;
    for (let guard = 0; guard < 2000 && out.length < SOURCE_CAP; guard++) {
      const r = await mod.search({ query: '', category: '', ...params, offset, limit: MAX_PAGE });
      const items = Array.isArray(r?.items) ? r.items : [];
      for (const it of items) {
        const s = sanitizeItem(it, source);
        if (s) out.push(s);
      }
      offset += items.length;
      if (!items.length || offset >= (Number(r?.total) || 0)) break;
    }
    return out;
  }

  // Merged index of every enabled source (rebuilt after installs, refreshes and source changes).
  // gen counts invalidations: a build that started before an invalidation never becomes the cached index.
  let index = null;
  let building = null;
  let gen = 0;
  async function getIndex() {
    if (index) return index;
    if (building && building.gen === gen) return building.p;
    const myGen = gen;
    const p = (async () => {
      const packages = await installedPackages();
      const all = seleneItems(loadCatalog(), packages);
      const dev = useMock ? require('./admin').dev.storeState() : null;
      for (const [id, mod] of modules) {
        if (!enabled(id)) continue;
        try {
          const items = await fetchAll(mod, id, {});
          if (dev && ADMIN_SOURCES.has(id)) for (const it of items) if (dev.installed.has(it.id)) it.installed = true;
          // Installed state from installed() when the module reports more than its items do.
          const inst = new Map(((await mod.installed?.().catch(() => [])) || []).filter((x) => x && typeof x.id === 'string').map((x) => [x.id, x]));
          for (const it of items) if (inst.has(it.id)) (it.installed = true), (it.version = str(inst.get(it.id).version, 80) || it.version);
          all.push(...items);
        } catch (e) {
          console.warn(`[store] source ${id} search failed:`, e?.message || e);
        }
      }
      const map = mergeItems(all, { lang: lang() });
      const built = { map, list: [...map.values()] };
      if (myGen === gen) index = built;
      return built;
    })().finally(() => {
      if (building?.p === p) building = null;
    });
    building = { gen: myGen, p };
    return p;
  }
  const searches = new Map(); // signature -> ranked keys (Load more without searching again)
  function invalidate(payload = {}) {
    gen++;
    index = null;
    searches.clear();
    api.broadcast('store:changed', payload);
  }

  async function sourcesStatus() {
    const out = [{ id: 'selene', label: { en: 'Selene', fr: 'Selene' }, admin: true, enabled: true, toggleable: false, available: true, ready: true, updatedAt: null, count: loadCatalog().length, error: null, refreshing: false }];
    for (const id of SOURCE_IDS) {
      const mod = modules.get(id);
      if (!mod) {
        out.push({ id, label: { en: id === 'flathub' ? 'Flathub' : 'Ubuntu', fr: id === 'flathub' ? 'Flathub' : 'Ubuntu' }, admin: ADMIN_SOURCES.has(id), enabled: false, toggleable: false, available: false, ready: false, updatedAt: null, count: 0, error: null, refreshing: false, missing: true });
        continue;
      }
      let st = {};
      try {
        st = (await mod.status()) || {};
      } catch (e) {
        st = { available: false, error: e?.message || String(e) };
      }
      out.push({
        id,
        label: mod.label && typeof mod.label === 'object' ? { en: str(mod.label.en, 40) || id, fr: str(mod.label.fr, 40) || str(mod.label.en, 40) || id } : { en: id, fr: id },
        admin: ADMIN_SOURCES.has(id),
        enabled: enabled(id),
        toggleable: id === 'flathub',
        available: st.available !== false,
        ready: !!st.ready,
        updatedAt: Number(st.updatedAt) || null,
        count: Number(st.count) || 0,
        error: lastError.has(id) ? lastError.get(id).message : st.error ? str(String(st.error), 300) : null,
        errorCode: lastError.has(id) ? lastError.get(id).code : /^E[A-Z]{2,15}$/.test(st.errorCode || '') ? st.errorCode : null,
        refreshing: refreshing.has(id),
      });
    }
    return { sources: out, live: !!api.env?.live };
  }

  api.handle('store:sources', sourcesStatus);

  api.handle('store:setEnabled', async (id, on) => {
    if (id !== 'flathub' || !modules.has(id)) throw quiet('this source cannot be turned off', 'EINVAL');
    prefs.disabled = prefs.disabled.filter((x) => x !== id);
    if (!on) prefs.disabled.push(id);
    try {
      fs.mkdirSync(path.dirname(PREFS), { recursive: true });
      fs.writeFileSync(PREFS, JSON.stringify(prefs));
    } catch {}
    invalidate({ source: id, action: 'enabled' });
    return sourcesStatus();
  });

  api.handle('store:refresh', async (id) => {
    const mod = modules.get(id);
    if (!mod || typeof mod.refresh !== 'function') throw quiet(`unknown source: ${id}`, 'EINVAL');
    if (!refreshing.has(id)) {
      const p = (async () => {
        api.broadcast('store:progress', { kind: 'refresh', source: id, phase: 'start', percent: 0 });
        try {
          await mod.refresh((ev) => api.broadcast('store:progress', { kind: 'refresh', source: id, phase: str(ev?.phase, 40), percent: Math.max(0, Math.min(100, Number(ev?.percent) || 0)) }));
          lastError.delete(id);
        } catch (e) {
          lastError.set(id, { message: str(e?.message || String(e), 300), code: /^E[A-Z]{2,15}$/.test(e?.code || '') ? e.code : null });
          throw quiet(e?.message || String(e), e?.code || 'EREFRESH');
        } finally {
          refreshing.delete(id);
          invalidate({ source: id, action: 'refresh' });
        }
        return { ok: true };
      })();
      refreshing.set(id, p);
    }
    return refreshing.get(id);
  });

  const page = (list, offset, limit) => {
    const o = Math.max(0, Math.floor(Number(offset) || 0));
    const l = Math.max(1, Math.min(MAX_PAGE, Math.floor(Number(limit) || 30)));
    return { items: list.slice(o, o + l), total: list.length, offset: o };
  };

  api.handle('store:home', async () => {
    const { map, list } = await getIndex();
    const featured = FEATURED.map((id) => map.get(id.toLowerCase())).filter(Boolean);
    const picks = list.filter((e) => e.selene?.gui);
    const rows = FD_CATEGORIES.map((category) => {
      const all = rankEntries(list.filter((e) => e.categories.includes(category) && !(e.selene && !e.selene.gui)), '');
      return { category, items: all.slice(0, 10), total: all.length };
    }).filter((r) => r.total);
    const tools = list.filter((e) => e.selene && !e.selene.gui);
    return { featured, picks, tools: tools.slice(0, 10), toolsTotal: tools.length, rows, total: list.length };
  });

  api.handle('store:search', async (opts = {}) => {
    const query = str(opts?.query, 200).trim();
    const category = FD_CATEGORIES.includes(opts?.category) ? opts.category : '';
    const source = ['selene', ...SOURCE_IDS].includes(opts?.source) ? opts.source : '';
    const tools = opts?.tools === true;
    const sig = JSON.stringify([query, category, source, tools]);
    const idx = await getIndex();
    const myGen = gen;
    let keys = searches.get(sig);
    if (!keys) {
      let list;
      if (!query) {
        list = idx.list.filter((e) => (!category || e.categories.includes(category)) && (!source || e.sources.some((s) => s.source === source)) && (!tools || (e.selene && !e.selene.gui)));
      } else {
        // Each source searches its own data (names, keywords, translations); hits are mapped to merged entries.
        const hits = new Set();
        const words = query.toLowerCase().split(/\s+/).filter(Boolean);
        for (const e of idx.list) {
          if (!e.selene) continue;
          const hay = [e.name, e.summary, e.selene.apt, e.selene.command, e.appId].join(' ').toLowerCase();
          if (words.every((w) => hay.includes(w))) hits.add(e.key);
        }
        for (const [id, mod] of modules) {
          if (!enabled(id)) continue;
          try {
            for (const it of await fetchAll(mod, id, { query, category })) hits.add(keyOf(it));
          } catch (e) {
            console.warn(`[store] ${id} search failed:`, e?.message || e);
          }
        }
        list = [...hits].map((k) => idx.map.get(k)).filter((e) => e && (!category || e.categories.includes(category)) && (!source || e.sources.some((s) => s.source === source)) && (!tools || (e.selene && !e.selene.gui)));
      }
      keys = rankEntries(list, query).map((e) => e.key);
      if (searches.size > 20) searches.delete(searches.keys().next().value);
      if (myGen === gen) searches.set(sig, keys);
    }
    const p = page(keys, opts?.offset, opts?.limit);
    return { ...p, items: p.items.map((k) => idx.map.get(k)).filter(Boolean) };
  });

  api.handle('store:details', async (key, wanted) => {
    const idx = await getIndex();
    const entry = idx.map.get(String(key || '').toLowerCase()) || idx.map.get(String(key || ''));
    if (!entry) throw quiet('This app is not in the catalogue.', 'ENOENT');
    const src = entry.sources.find((s) => s.source === wanted) || entry.sources[0];
    let d = {};
    if (src.source === 'selene') {
      const c = loadCatalog().find((i) => i.id === src.id) || {};
      d = { description: c.description?.[lang()] || c.description?.en || '', version: src.version };
    } else {
      try {
        d = (await modules.get(src.source)?.details(src.id)) || {};
      } catch (e) {
        d = { error: e?.message || String(e) };
      }
    }
    const details = {
      description: str(d.description, 20000),
      screenshots: (Array.isArray(d.screenshots) ? d.screenshots : []).map((u) => safeUrl(u, /^(https:\/\/|data:image\/(png|svg\+xml|jpeg|webp);|media:\/\/)/)).filter(Boolean).slice(0, 8),
      homepage: safeUrl(d.homepage, /^https?:\/\/[^\s]+$/, 500),
      license: str(d.license, 200),
      developer: str(typeof d.developer === 'object' ? d.developer?.name : d.developer, 200),
      version: str(d.version, 80) || src.version || '',
      downloadSize: Number(d.downloadSize) > 0 ? Number(d.downloadSize) : null,
      installedSize: Number(d.installedSize) > 0 ? Number(d.installedSize) : null,
      admin: ADMIN_SOURCES.has(src.source),
      error: d.error ? str(d.error, 300) : null,
    };
    return { entry, source: src.source, details };
  });

  let op = null;
  async function runOp(action, source, id) {
    const mod = modules.get(source);
    if (ADMIN_SOURCES.has(source)) throw quiet(`${source} apps are installed through the administrator prompt (store-${action})`, 'EADMIN');
    if (!mod || !enabled(source)) throw quiet(`unknown source: ${source}`, 'EINVAL');
    if (typeof id !== 'string' || !(source === 'flathub' ? FLATPAK_ID.test(id) && id.length <= 255 : PKG.test(id))) throw quiet('invalid app id', 'EINVAL');
    if (op) throw quiet('Another installation is in progress.', 'EBUSY');
    op = { action, source, id };
    const send = (ev) => api.broadcast('store:progress', { kind: action, source, id, percent: Math.max(0, Math.min(100, Number(ev?.percent) || 0)), message: str(ev?.message, 200) });
    send({ percent: 0 });
    try {
      const r = (await mod[action](id, send)) || {};
      return { desktopId: DESKTOP.test(r.desktopId || '') ? r.desktopId : null };
    } catch (e) {
      throw quiet(e?.message || String(e), e?.code || 'ECMD');
    } finally {
      op = null;
      invalidate({ source, id, action });
    }
  }
  api.handle('store:install', (source, id) => runOp('install', source, id));
  api.handle('store:remove', (source, id) => runOp('remove', source, id));

  api.handle('store:installedAll', async () => {
    const { list } = await getIndex();
    return { items: list.filter((e) => e.installed).sort((a, b) => a.name.localeCompare(b.name)) };
  });

  api.handle('store:invalidate', async () => {
    invalidate({ action: 'invalidate' });
    return true;
  });
}

module.exports = register;
module.exports.parsers = { parseCatalog, parseDpkgQuery, sanitizeItem, mergeItems, rankEntries, FEATURED, FD_CATEGORIES };
