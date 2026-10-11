'use strict';
// Store source "ubuntu": every desktop application of the Ubuntu archive that has AppStream (DEP-11) metadata.
// Contract: docs/STORE-SOURCES.md. Loaded by main/ipc/store.js.
//
// Catalogue (no root): for each suite / component of the APT sources (deb822 /etc/apt/sources.list.d/ubuntu.sources,
// else the one-line /etc/apt/sources.list), dists/<suite>/<comp>/dep11/Components-<arch>.yml.gz and
// icons-64x64.tar.gz are downloaded (If-None-Match / If-Modified-Since) into ~/.cache/aurora/store/ubuntu/dl/, then
// the python helper rootfs/usr/lib/aurora/helpers/aurora-catalog-apt builds catalog.json + icons/ (desktop
// applications only, C + fr strings). Install / remove: aurora-admin store-install / store-remove (UAC prompt), the
// same admin path as the Selene picks — the renderer calls shell.runAdmin(...adminAction(op, id)); the helper accepts
// a package listed as a desktop application in the root-owned DEP-11 files of /var/lib/apt/lists.
// Dev / tests (DEV unless AURORA_REAL_BACKENDS=1): the catalogue is built from shell/test/fixtures/store-ubuntu (no
// network) and install / remove are simulated (admin.js dev.storeState(), shared with the Selene picks).
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { spawn } = require('child_process');
const { run, helperPath } = require('../exec');

const PKG = /^[a-z0-9][a-z0-9+.-]{1,62}$/;
const SUITE = /^[a-z]+(-(updates|security|backports))?$/;
const COMPONENTS = new Set(['main', 'universe', 'restricted', 'multiverse']);
const MAX_FILE = 64 * 1024 * 1024;
const FIXTURE_DIR = path.join(__dirname, '..', '..', '..', 'test', 'fixtures', 'store-ubuntu');
const MAIN_CATEGORIES = ['AudioVideo', 'Development', 'Education', 'Game', 'Graphics', 'Network', 'Office', 'Science', 'Settings', 'System', 'Utility'];
const CATEGORY_ALIASES = { Audio: 'AudioVideo', Video: 'AudioVideo' };
// refresh() errors: err.code + a message in the shell language (status() returns both).
const ERRORS = {
  ENOSOURCES: { en: 'No Ubuntu archive is configured in the APT sources', fr: 'Aucune archive Ubuntu n’est configurée dans les sources APT' },
  ENETWORK: { en: 'Could not download the Ubuntu catalogue (check the network connection)', fr: 'Impossible de télécharger le catalogue Ubuntu (vérifiez la connexion réseau)' },
  ENODATA: { en: 'The Ubuntu archive has no AppStream data', fr: 'L’archive Ubuntu ne fournit pas de données AppStream' },
  EHELPER: { en: 'Could not read the Ubuntu catalogue', fr: 'Impossible de lire le catalogue Ubuntu' },
};

// ------------------------------------------------------------------ parsers (unit-tested)

/** deb822 APT sources -> [{ uris, suites, components }] (only enabled "deb" stanzas). */
function parseDeb822(text) {
  const out = [];
  for (const block of String(text || '').split(/\n\s*\n/)) {
    const f = {};
    let last = null;
    for (const line of block.split('\n')) {
      if (/^\s*#/.test(line) || !line.trim()) continue;
      const m = /^([A-Za-z0-9-]+):\s*(.*)$/.exec(line);
      if (m) {
        last = m[1].toLowerCase();
        f[last] = m[2].trim();
      } else if (last && /^\s/.test(line)) f[last] += ` ${line.trim()}`;
    }
    if (!f.types || !f.types.split(/\s+/).includes('deb') || /^(no|false|0)$/i.test(f.enabled || '')) continue;
    const words = (v) => String(v || '').split(/\s+/).filter(Boolean);
    out.push({ uris: words(f.uris), suites: words(f.suites), components: words(f.components) });
  }
  return out;
}

/** One-line sources.list -> same shape. "deb [opts] uri suite comp..." */
function parseOneLine(text) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = /^deb\s+(?:\[[^\]]*\]\s+)?(\S+)\s+(\S+)\s*(.*)$/.exec(line);
    if (m) out.push({ uris: [m[1]], suites: [m[2]], components: m[3].split(/\s+/).filter(Boolean) });
  }
  return out;
}

const SUITE_RANK = { '': 0, backports: 1, security: 2, updates: 3 };
/** Sources -> download plan, oldest suite first (a later entry wins per package). Only http(s) mirrors, the
 *  release / -updates / -security / -backports suites and the four Ubuntu components. */
function planDownloads(entries, arch = 'amd64') {
  const seen = new Set();
  const plan = [];
  for (const e of entries || []) {
    for (const uri0 of e.uris || []) {
      if (!/^https?:\/\/[A-Za-z0-9.-]+(:\d+)?(\/[A-Za-z0-9._~%/-]*)?$/.test(uri0)) continue;
      const uri = uri0.endsWith('/') ? uri0 : `${uri0}/`;
      for (const suite of e.suites || []) {
        if (!SUITE.test(suite)) continue;
        for (const comp of e.components || []) {
          if (!COMPONENTS.has(comp)) continue;
          const key = `${suite}/${comp}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const base = `${uri}dists/${suite}/${comp}/dep11/`;
          plan.push({ suite, comp, rank: SUITE_RANK[suite.split('-')[1] || ''] ?? 0, components: `${base}Components-${arch}.yml.gz`, icons: `${base}icons-64x64.tar.gz` });
        }
      }
    }
  }
  return plan.sort((a, b) => a.rank - b.rank);
}

/** DEP-11 YAML text -> Set of packages that ship a desktop application (mirrors aurora-admin's check). */
function dep11Packages(text) {
  const out = new Set();
  for (const doc of String(text || '').split(/^---.*$/m)) {
    if (!/^Type: desktop-application\s*$/m.test(doc)) continue;
    const m = /^Package: ([a-z0-9][a-z0-9+.-]{1,62})\s*$/m.exec(doc);
    if (m) out.add(m[1]);
  }
  return out;
}

/** APT status line (APT::Status-Fd) -> { phase: 'download'|'install'|'error', percent, message } or null */
function parseAptStatus(line) {
  const m = /^(dlstatus|pmstatus|pmerror):([^:]*):([0-9.]+):(.*)$/.exec(String(line || '').trim());
  if (!m) return null;
  return { phase: m[1] === 'dlstatus' ? 'download' : m[1] === 'pmerror' ? 'error' : 'install', percent: Math.max(0, Math.min(100, Number(m[3]) || 0)), message: m[4] };
}

/** freedesktop categories -> the Store's main categories (at least one). */
function mainCategories(cats) {
  const out = [];
  for (const c of cats || []) {
    const m = CATEGORY_ALIASES[c] || c;
    if (MAIN_CATEGORIES.includes(m) && !out.includes(m)) out.push(m);
  }
  return out.length ? out : ['Utility'];
}

const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');
const pick = (o, lang) => (o && typeof o === 'object' ? (lang === 'fr' && o.fr) || o.C || '' : '');

// ------------------------------------------------------------------ HTTP download (main process only)

/** GET url into dest (atomic), following redirects. prev = { etag, lastModified } -> 304 keeps dest. */
function download(url, dest, prev = {}, { timeout = 30000, redirects = 5, onBytes } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : u.protocol === 'http:' ? http : null;
    if (!lib) return reject(new Error(`unsupported URL: ${url}`));
    const headers = { 'user-agent': 'SeleneOS-Store/1' };
    if (prev.etag && fs.existsSync(dest)) headers['if-none-match'] = prev.etag;
    if (prev.lastModified && fs.existsSync(dest)) headers['if-modified-since'] = prev.lastModified;
    const req = lib.get(u, { headers, timeout }, (res) => {
      const code = res.statusCode;
      if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
        res.resume();
        if (redirects <= 0) return reject(new Error('too many redirects'));
        const next = new URL(res.headers.location, u).toString();
        if (!/^https?:/.test(next)) return reject(new Error('bad redirect'));
        return download(next, dest, prev, { timeout, redirects: redirects - 1, onBytes }).then(resolve, reject);
      }
      if (code === 304) {
        res.resume();
        return resolve({ status: 304, etag: prev.etag, lastModified: prev.lastModified });
      }
      if (code !== 200) {
        res.resume();
        return resolve({ status: code });
      }
      if (Number(res.headers['content-length']) > MAX_FILE) {
        res.destroy();
        return reject(new Error('file too large'));
      }
      const tmp = `${dest}.part`;
      const out = fs.createWriteStream(tmp);
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        onBytes?.(chunk.length);
        if (size > MAX_FILE) {
          res.destroy(new Error('file too large'));
        }
      });
      res.on('error', (e) => {
        out.destroy();
        fs.rm(tmp, { force: true }, () => reject(e));
      });
      res.pipe(out);
      out.on('finish', () => {
        if (size > MAX_FILE || !res.complete) return fs.rm(tmp, { force: true }, () => reject(new Error('download interrupted')));
        fs.rename(tmp, dest, (e) => (e ? reject(e) : resolve({ status: 200, etag: res.headers.etag || null, lastModified: res.headers['last-modified'] || null, size })));
      });
      out.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
  });
}

// ------------------------------------------------------------------ module
const state = {
  ctx: null,
  useMock: true,
  dir: null,
  catalog: null, // { mtime, items: [raw], byPkg: Map, index: [{ raw, hay }] }
  refreshing: null,
  phase: null,
  error: null,
  errorCode: null,
  installed: { at: 0, map: new Map() },
};

function cacheDir() {
  return state.dir;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function loadCatalog() {
  const file = path.join(cacheDir(), 'catalog.json');
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    state.catalog = null;
    return null;
  }
  if (state.catalog && state.catalog.mtime === st.mtimeMs) return state.catalog;
  const data = readJson(file, null);
  const items = Array.isArray(data?.items) ? data.items.filter((r) => r && PKG.test(r.package) && r.name?.C) : [];
  const byPkg = new Map(items.map((r) => [r.package, r]));
  const index = items.map((r) => ({
    raw: r,
    name: `${r.name.C}\n${r.name.fr || ''}`.toLowerCase(),
    hay: [r.package, r.id, r.summary?.C, r.summary?.fr, ...(r.keywords || [])].join('\n').toLowerCase(),
    cats: mainCategories(r.categories),
  }));
  state.catalog = { mtime: st.mtimeMs, updatedAt: Math.round(st.mtimeMs), items, byPkg, index };
  return state.catalog;
}

function lang(opts) {
  if (opts?.lang === 'fr' || opts?.lang === 'en') return opts.lang;
  let l = null;
  try {
    l = state.ctx?.api?.settings?.get('lang');
  } catch {}
  if (l === 'fr' || l === 'en') return l;
  if (state.ctx?.env?.lang === 'fr' || state.ctx?.env?.lang === 'en') return state.ctx.env.lang;
  return /^fr/i.test(process.env.LANG || process.env.LC_ALL || '') ? 'fr' : 'en';
}

function toItem(r, l, full) {
  const icon = r.icon && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,200}\.png$/.test(r.icon) ? path.join(cacheDir(), 'icons', r.icon) : null;
  const item = {
    source: 'ubuntu',
    id: r.package,
    appId: r.id || null,
    name: (l === 'fr' && r.name.fr) || r.name.C,
    summary: pick(r.summary, l),
    icon: icon ? `media://local${encodePath(icon)}` : null,
    categories: mainCategories(r.categories),
    installed: state.installed.map.has(r.package),
    desktopId: r.desktopId || null,
  };
  if (full) {
    Object.assign(item, {
      description: pick(r.description, l),
      // Dev / tests never touch the network: local stand-ins replace the archive's screenshots.
      screenshots: state.useMock
        ? (r.screenshots || []).slice(0, 2).map((u, i) => `media://local${encodePath(path.join(FIXTURE_DIR, `screenshot-${i + 1}.png`))}`)
        : (r.screenshots || []).filter((u) => typeof u === 'string' && u.startsWith('https://')).slice(0, 4),
      homepage: typeof r.homepage === 'string' && /^https?:\/\//.test(r.homepage) ? r.homepage : '',
      license: r.license || '',
      developer: r.developer || '',
      version: state.installed.map.get(r.package) || '',
      keywords: r.keywords || [],
    });
  }
  return item;
}

async function ensureLoaded() {
  if (loadCatalog()) return state.catalog;
  // Dev: the fixture catalogue is built on first use (fast, no network). Real: store.js calls refresh().
  if (state.useMock) {
    await refresh().catch(() => {});
    return loadCatalog();
  }
  return null;
}

async function refreshInstalled(force) {
  if (!force && Date.now() - state.installed.at < 15000) return state.installed.map;
  const cat = loadCatalog();
  const pkgs = cat ? cat.items.map((r) => r.package) : [];
  const map = new Map();
  if (state.useMock) {
    const st = require('../../ipc/admin').dev.storeState();
    for (const p of pkgs) if (st.installed.has(p)) map.set(p, st.installed.get(p));
  } else {
    // Batched: one dpkg-query per 400 packages (exit 1 when some are unknown: the known ones are still printed).
    for (let i = 0; i < pkgs.length; i += 400) {
      const r = await run('dpkg-query', ['-W', '-f=${Package}\t${db:Status-Abbrev}\t${Version}\n', '--', ...pkgs.slice(i, i + 400)], { timeout: 20000 }).catch(() => null);
      for (const line of String(r?.stdout || '').split('\n')) {
        const [p, s, v] = line.split('\t');
        const name = (p || '').replace(/:.*$/, '');
        if (PKG.test(name) && /^ii/.test(s || '')) map.set(name, (v || '').trim());
      }
    }
  }
  state.installed = { at: Date.now(), map };
  return map;
}

function readSources() {
  const deb822 = '/etc/apt/sources.list.d/ubuntu.sources';
  try {
    const entries = parseDeb822(fs.readFileSync(deb822, 'utf8'));
    if (entries.length) return entries;
  } catch {}
  try {
    return parseOneLine(fs.readFileSync('/etc/apt/sources.list', 'utf8'));
  } catch {
    return [];
  }
}

function aptArch() {
  return { x64: 'amd64', arm64: 'arm64', ia32: 'i386', arm: 'armhf', ppc64: 'ppc64el', s390x: 's390x', riscv64: 'riscv64' }[process.arch] || 'amd64';
}

function runHelper(sources, onProgress) {
  return new Promise((resolve, reject) => {
    const args = ['-I', helperPath('aurora-catalog-apt'), 'build', '--out', cacheDir()];
    for (const s of sources) args.push('--source', s.components, s.icons || '-');
    const child = spawn('python3', args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LC_ALL: 'C.UTF-8' } });
    try {
      os.setPriority(child.pid, 10); // the parse is long on big archives: keep the desktop responsive
    } catch {}
    let buf = '';
    let err = '';
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const m = /^progress (\w+) (\d+)$/.exec(line);
        if (m) onProgress?.({ phase: m[1] === 'icons' ? 'icons' : m[1] === 'write' ? 'write' : 'parse', percent: Number(m[2]) });
      }
    });
    child.stderr.on('data', (d) => {
      err = (err + d).slice(-4000);
    });
    child.on('error', (e) => reject(Object.assign(e, { code: 'EHELPER' })));
    child.on('close', (code) => {
      if (code === 0) return resolve();
      const detail = (err.trim().split('\n').pop() || `aurora-catalog-apt exited with ${code}`).replace(/^aurora-catalog-apt:\s*/, '');
      reject(Object.assign(new Error(`${ERRORS.EHELPER[lang()]}: ${detail.slice(0, 200)}`), { code: 'EHELPER' }));
    });
  });
}

async function doRefresh(onProgress) {
  const emit = (p) => {
    state.phase = p.phase;
    try {
      onProgress?.(p);
    } catch {}
  };
  fs.mkdirSync(cacheDir(), { recursive: true });
  let sources;
  let commit = null;
  if (state.useMock) {
    sources = [{ components: path.join(FIXTURE_DIR, 'Components-amd64.yml.gz'), icons: path.join(FIXTURE_DIR, 'icons-64x64.tar.gz') }];
    emit({ phase: 'download', percent: 100 });
  } else {
    emit({ phase: 'sources', percent: 0 });
    const plan = planDownloads(readSources(), aptArch());
    if (!plan.length) throw Object.assign(new Error(ERRORS.ENOSOURCES[lang()]), { code: 'ENOSOURCES' });
    const dl = path.join(cacheDir(), 'dl');
    fs.mkdirSync(dl, { recursive: true });
    const metaFile = path.join(dl, 'meta.json');
    const meta = readJson(metaFile, {});
    sources = [];
    let done = 0;
    let failures = 0;
    let changed = false;
    for (const p of plan) {
      const entry = { components: path.join(dl, `${p.suite}_${p.comp}_Components.yml.gz`), icons: path.join(dl, `${p.suite}_${p.comp}_icons-64x64.tar.gz`) };
      let have = false;
      for (const kind of ['components', 'icons']) {
        try {
          const r = await download(p[kind], entry[kind], meta[p[kind]] || {});
          if (r.status === 200 || r.status === 304) {
            if (r.status === 200) changed = true;
            meta[p[kind]] = { etag: r.etag || null, lastModified: r.lastModified || null };
            if (kind === 'components') have = true;
          } else if (r.status === 404 || r.status === 410) {
            // e.g. no dep11 data for this suite/component: drop a stale copy
            if (fs.existsSync(entry[kind])) changed = true;
            fs.rmSync(entry[kind], { force: true });
            delete meta[p[kind]];
          } else failures++;
        } catch {
          failures++;
          // offline: keep using the copy downloaded last time
        }
        if (kind === 'components' && !have && fs.existsSync(entry.components) && meta[p.components]) have = true;
      }
      if (have) sources.push({ components: entry.components, icons: fs.existsSync(entry.icons) ? entry.icons : '-' });
      done++;
      emit({ phase: 'download', percent: Math.round((done / plan.length) * 100) });
    }
    // Nothing new on the mirror (every file answered 304) and the same sources: keep the parsed catalogue.
    const signature = JSON.stringify(sources);
    const catalogFile = path.join(cacheDir(), 'catalog.json');
    if (!changed && sources.length && meta.__sources === signature && fs.existsSync(catalogFile)) {
      const now = new Date();
      fs.utimesSync(catalogFile, now, now);
      state.catalog = null;
      loadCatalog();
      await refreshInstalled(true);
      emit({ phase: 'done', percent: 100 });
      return;
    }
    delete meta.__sources; // set again once the helper has parsed these sources
    try {
      fs.writeFileSync(metaFile, JSON.stringify(meta));
    } catch {}
    commit = () => {
      meta.__sources = signature;
      fs.writeFileSync(metaFile, JSON.stringify(meta));
    };
    if (!sources.length) {
      const code = failures ? 'ENETWORK' : 'ENODATA';
      throw Object.assign(new Error(ERRORS[code][lang()]), { code });
    }
  }
  await runHelper(sources, (p) => emit({ phase: p.phase, percent: p.percent }));
  try {
    commit?.();
  } catch {}
  state.catalog = null;
  loadCatalog();
  await refreshInstalled(true);
  emit({ phase: 'done', percent: 100 });
}

function refresh(onProgress) {
  if (state.refreshing) {
    // Join the running refresh; still report its progress.
    return state.refreshing;
  }
  state.error = null;
  state.errorCode = null;
  state.refreshing = doRefresh(onProgress)
    .catch((e) => {
      state.error = e.message || String(e);
      state.errorCode = /^E[A-Z]{2,15}$/.test(e?.code || '') ? e.code : null;
      throw e;
    })
    .finally(() => {
      state.refreshing = null;
      state.phase = null;
    });
  return state.refreshing;
}

function check(id) {
  const pkg = String(id || '');
  if (!PKG.test(pkg)) throw Object.assign(new Error(`invalid package name: ${pkg.slice(0, 80)}`), { code: 'EINVAL' });
  const cat = loadCatalog();
  if (!cat || !cat.byPkg.has(pkg)) throw Object.assign(new Error(`not in the Ubuntu catalogue: ${pkg}`), { code: 'ENOTFOUND' });
  return pkg;
}

/** The admin action that installs / removes an Ubuntu package (the renderer runs it through shell.runAdmin). */
function adminAction(op, id) {
  const pkg = String(id || '');
  if (!PKG.test(pkg)) throw Object.assign(new Error('invalid package name'), { code: 'EINVAL' });
  return { action: op === 'remove' ? 'store-remove' : 'store-install', args: [pkg] };
}

async function operate(op, id, onProgress) {
  const pkg = check(id);
  const { action, args } = adminAction(op, pkg);
  if (!state.useMock) {
    // Root is needed: only the renderer can show the UAC prompt (shell.runAdmin(action, args)).
    throw Object.assign(new Error('this operation needs administrator rights (shell.runAdmin)'), { code: 'EADMIN', admin: { action, args } });
  }
  const admin = require('../../ipc/admin');
  await admin.dev.storeRun(action, args, (chunk) => {
    for (const line of String(chunk).split('\n')) {
      const s = parseAptStatus(line);
      if (!s || s.phase === 'error') continue;
      const percent = op === 'install' ? Math.round(s.phase === 'download' ? s.percent * 0.4 : 40 + s.percent * 0.6) : Math.round(s.percent);
      try {
        onProgress?.({ percent, message: s.message });
      } catch {}
    }
  });
  await refreshInstalled(true);
  return op === 'install' ? { desktopId: state.catalog?.byPkg.get(pkg)?.desktopId || null } : {};
}

module.exports = {
  id: 'ubuntu',
  label: { en: 'Ubuntu', fr: 'Ubuntu' },
  init(ctx) {
    state.ctx = ctx || {};
    state.useMock = !!state.ctx.DEV && (state.ctx.env?.AURORA_REAL_BACKENDS ?? process.env.AURORA_REAL_BACKENDS) !== '1';
    const home = state.ctx.home || os.homedir();
    state.dir = path.join(process.env.XDG_CACHE_HOME && !state.ctx.home ? process.env.XDG_CACHE_HOME : path.join(home, '.cache'), 'aurora', 'store', 'ubuntu');
    state.catalog = null;
    state.installed = { at: 0, map: new Map() };
  },
  async status() {
    const cat = loadCatalog();
    let available = true;
    if (!state.useMock) available = fs.existsSync('/usr/bin/python3') && fs.existsSync(helperPath('aurora-catalog-apt'));
    const out = { available, ready: !!cat, updatedAt: cat ? cat.updatedAt : null, count: cat ? cat.items.length : 0, live: !!state.ctx?.api?.env?.live, refreshing: !!state.refreshing };
    if (state.phase) out.phase = state.phase;
    if (state.error) out.error = state.error;
    if (state.errorCode) out.errorCode = state.errorCode;
    return out;
  },
  refresh,
  async search({ query = '', category = '', offset = 0, limit = 50, lang: l0 } = {}) {
    const cat = await ensureLoaded();
    if (!cat) return { items: [], total: 0 };
    await refreshInstalled(false);
    const l = lang({ lang: l0 });
    const q = String(query || '').trim().toLowerCase().slice(0, 100);
    const words = q.split(/\s+/).filter(Boolean);
    let rows = cat.index;
    if (category) rows = rows.filter((r) => r.cats.includes(category));
    if (words.length) {
      const scored = [];
      for (const r of rows) {
        let score = 0;
        let ok = true;
        for (const w of words) {
          if (r.name.includes(w)) score += r.name.startsWith(w) || r.name.includes(`\n${w}`) ? 3 : 2;
          else if (r.hay.includes(w)) score += 1;
          else {
            ok = false;
            break;
          }
        }
        if (ok) {
          if (r.name.split('\n').includes(q) || r.raw.package === q) score += 10;
          scored.push({ r, score });
        }
      }
      scored.sort((a, b) => b.score - a.score || a.r.raw.name.C.localeCompare(b.r.raw.name.C));
      rows = scored.map((s) => s.r);
    }
    const off = Math.max(0, Number(offset) | 0);
    const lim = Math.max(1, Math.min(200, Number(limit) | 0 || 50));
    return { items: rows.slice(off, off + lim).map((r) => toItem(r.raw, l)), total: rows.length };
  },
  async details(id, opts) {
    const cat = await ensureLoaded();
    const r = cat?.byPkg.get(String(id || ''));
    if (!r) throw Object.assign(new Error(`not in the Ubuntu catalogue: ${String(id || '').slice(0, 80)}`), { code: 'ENOTFOUND' });
    await refreshInstalled(false);
    return toItem(r, lang(opts), true);
  },
  async installed() {
    await ensureLoaded();
    const map = await refreshInstalled(true);
    return [...map].map(([id, version]) => ({ id, version }));
  },
  install: (id, onProgress) => operate('install', id, onProgress),
  remove: (id, onProgress) => operate('remove', id, onProgress),
  adminAction,
  /** Dev: packages of the fixture catalogue (admin.js accepts them in its store-install / store-remove simulation). */
  devPackages() {
    try {
      return dep11Packages(zlib.gunzipSync(fs.readFileSync(path.join(FIXTURE_DIR, 'Components-amd64.yml.gz'))).toString('utf8'));
    } catch {
      return new Set();
    }
  },
  parsers: { parseDeb822, parseOneLine, planDownloads, dep11Packages, parseAptStatus, mainCategories, download },
};
