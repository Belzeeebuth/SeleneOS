'use strict';
// Store backend: the curated catalog of command-line tools and their installed state (no privileges).
// Install / remove go through the elevation prompt: shell.runAdmin('store-install' | 'store-remove', [apt])
// (actions of main/ipc/admin.js + the aurora-admin helper, which only accept packages of this catalog).
//
//   store:catalog ()   -> { items: [{ id, apt, name, category, icon, command, interactive,
//                                     description: { en, fr } }], simulated }
//                         from /usr/share/aurora/store/catalog.json (dev: the copy in rootfs/ of the repo)
//   store:installed () -> { packages: { [apt]: version }, simulated }   (dpkg-query; only catalog packages)
//
// Dev / tests (api.DEV unless AURORA_REAL_BACKENDS=1): installed state is the in-memory simulation shared
// with admin.js (dev.storeState()), so a simulated install is immediately visible here.
const fs = require('fs');
const path = require('path');
const { run } = require('../lib/exec');

const SYS_CATALOG = '/usr/share/aurora/store/catalog.json';
const DEV_CATALOG = path.join(__dirname, '..', '..', '..', 'rootfs', 'usr', 'share', 'aurora', 'store', 'catalog.json');
const PKG = /^[a-z0-9][a-z0-9+.-]{1,62}$/;
const ID = /^[a-z0-9][a-z0-9+._-]{0,62}$/;
const CATEGORIES = new Set(['development', 'editors', 'shells', 'system', 'utilities', 'multimedia', 'network']);

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
    items.push({
      id,
      apt,
      name: str(it.name, 80) || apt,
      category: CATEGORIES.has(it.category) ? it.category : 'utilities',
      icon: /^[a-z0-9_]{1,64}$/.test(it.icon || '') ? it.icon : 'apps',
      command: /^[A-Za-z0-9][A-Za-z0-9+._-]{0,63}$/.test(it.command || '') ? it.command : '',
      interactive: it.interactive === true,
      description: { en: str(d.en), fr: str(d.fr) || str(d.en) },
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

  api.handle('store:catalog', async () => ({ items: loadCatalog(), simulated: useMock }));

  api.handle('store:installed', async () => {
    const pkgs = loadCatalog().map((i) => i.apt);
    if (useMock) {
      const st = require('./admin').dev.storeState();
      const packages = {};
      for (const p of pkgs) if (st.installed.has(p)) packages[p] = st.installed.get(p);
      return { packages, simulated: true };
    }
    if (!pkgs.length) return { packages: {}, simulated: false };
    // Exit code 1 when some packages are unknown to dpkg: the known ones are still printed.
    const r = await run('dpkg-query', ['-W', '-f=${Package}\t${db:Status-Abbrev}\t${Version}\n', '--', ...pkgs], { timeout: 15000 }).catch(() => null);
    return { packages: parseDpkgQuery(r?.stdout), simulated: false };
  });
}

module.exports = register;
module.exports.parsers = { parseCatalog, parseDpkgQuery };
