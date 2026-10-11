'use strict';
// Store source 'flathub' (docs/STORE-SOURCES.md): the Flathub catalogue, installed per user with `flatpak --user`.
//
// Real mode: flatpak CLI (argv arrays, never a shell). The remote is added on first use
// (remote-add --user --if-not-exists), the AppStream data comes from `flatpak update --user --appstream flathub` and is
// turned into ~/.cache/aurora/store/flathub.json by the python helper aurora-catalog-flathub (iterparse, flat memory).
// A cache older than the AppStream XML is rebuilt without network on the next read.
//
// Dev / tests (DEV unless AURORA_REAL_BACKENDS=1): the fixture catalogue of shell/test/fixtures/store-flathub (parsed
// by the same helper, kept in memory), simulated install / remove with progress events, no flatpak call, no network.
// AURORA_STORE_DEV_FAIL=<id>[:CODE] makes install (and remove) of <id> fail with CODE (default EFLATPAK).
//
// Errors carry a code: EINVAL (bad id), ENOENT (unknown app), EBUSY (an operation already runs for this app),
// ENET (no network), ENOSPC (no space), EFLATPAK (flatpak missing or failed; remote-add failure). Messages follow the
// shell language (en / fr).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ID_RE = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+){2,}$/;
// A leading '-' would reach flatpak's argv as an option: rejected (flatpak ids never start with one).
const validId = (id) => typeof id === 'string' && id.length <= 255 && ID_RE.test(id) && id[0] !== '-';
const MAIN_CATEGORIES = ['AudioVideo', 'Development', 'Education', 'Game', 'Graphics', 'Network', 'Office', 'Science', 'Settings', 'System', 'Utility'];
const REMOTE = 'flathub';
const REMOTE_URL = 'https://dl.flathub.org/repo/flathub.flatpakrepo';
const REPO_ROOT = path.join(__dirname, '..', '..', '..', '..');
const SYS_HELPER = '/usr/lib/aurora/helpers/aurora-catalog-flathub';
const DEV_HELPER = path.join(REPO_ROOT, 'rootfs', 'usr', 'lib', 'aurora', 'helpers', 'aurora-catalog-flathub');
const FIXTURE_DIR = path.join(REPO_ROOT, 'shell', 'test', 'fixtures', 'store-flathub');
const ARCH = { x64: 'x86_64', arm64: 'aarch64', ia32: 'i386', arm: 'arm' }[process.arch] || process.arch;

const MSG = {
  EINVAL: { en: 'Invalid application id', fr: 'Identifiant d’application non valide' },
  ENOENT: { en: 'This app is not in the Flathub catalogue', fr: 'Cette application n’est pas dans le catalogue Flathub' },
  EBUSY: { en: 'An operation is already running for this app', fr: 'Une opération est déjà en cours pour cette application' },
  ENET: { en: 'No network connection: Flathub could not be reached', fr: 'Pas de connexion réseau : Flathub est injoignable' },
  ENOSPC: { en: 'Not enough disk space', fr: 'Espace disque insuffisant' },
  EFLATPAK: { en: 'Flatpak failed', fr: 'Échec de Flatpak' },
  NOFLATPAK: { en: 'Flatpak is not installed', fr: 'Flatpak n’est pas installé' },
  EREMOTE: { en: 'The Flathub remote could not be added', fr: 'Impossible d’ajouter le dépôt Flathub' },
  ECATALOG: { en: 'The Flathub catalogue could not be read', fr: 'Impossible de lire le catalogue Flathub' },
  // progress messages
  remote: { en: 'Connecting to Flathub…', fr: 'Connexion à Flathub…' },
  download: { en: 'Downloading…', fr: 'Téléchargement…' },
  install: { en: 'Installing…', fr: 'Installation…' },
  remove: { en: 'Uninstalling…', fr: 'Désinstallation…' },
  parse: { en: 'Reading the catalogue…', fr: 'Lecture du catalogue…' },
  done: { en: 'Done', fr: 'Terminé' },
};

// ------------------------------------------------------------------ pure helpers (unit-tested)
const deaccent = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** flatpak output (stdout + stderr) -> error code: ENET | ENOSPC | EFLATPAK */
function errorCode(text) {
  const t = String(text || '');
  if (/No space left on device|Not enough disk space|not enough space|ENOSPC|Disk quota exceeded/i.test(t)) return 'ENOSPC';
  if (/Could not resolve|Couldn't resolve|resolving|Name or service not known|Temporary failure in name resolution|Network is unreachable|No route to host|Could not connect|Couldn't connect|Connection refused|Connection timed out|Timeout was reached|Failed to connect|Server returned status|While fetching|Unable to load summary|Unable to connect|Error sending|\bSSL\b|\bTLS\b|Network error/i.test(t)) return 'ENET';
  return 'EFLATPAK';
}
/** Last meaningful line of flatpak's output ("error: ..." preferred), without the prefix. */
function errorDetail(text) {
  const lines = String(text || '').split(/[\r\n]+/).map((l) => cleanLine(l)).filter(Boolean);
  const err = [...lines].reverse().find((l) => /^(error|erreur)\s*:/i.test(l));
  return (err || lines[lines.length - 1] || '').replace(/^(error|erreur)\s*:\s*/i, '').slice(0, 300);
}
/** Strip ANSI sequences, progress-bar block characters and extra spaces. */
function cleanLine(l) {
  return String(l || '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/[▀-▟■-◿#]+/g, ' ')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
/**
 * One line of flatpak install / uninstall / update output -> { percent?, message } (percent is the overall
 * progress when a "n/m" step counter is present). null for an empty line.
 */
function parseProgress(line) {
  const msg = cleanLine(line);
  if (!msg) return null;
  const out = { message: msg.slice(0, 200) };
  const pct = /(\d{1,3}(?:\.\d+)?)\s?%/.exec(msg);
  const step = /\b(\d{1,3})\/(\d{1,3})\b/.exec(msg);
  let p = pct ? Math.min(100, Number(pct[1])) : null;
  if (/\bdone\b|terminé/i.test(msg) && p == null && step) p = 100;
  if (p != null && step && Number(step[2]) > 0) {
    const n = Math.max(1, Math.min(Number(step[1]), Number(step[2])));
    p = ((n - 1) * 100 + p) / Number(step[2]);
  }
  if (p != null) out.percent = Math.max(0, Math.min(100, Math.round(p)));
  return out;
}
/** "1.2 GB" / "850.3 MB" / "12 kB" / "1,5 Go" -> bytes (SI units, as g_format_size), or undefined */
function parseSize(s) {
  const m = /^([\d.,]+)\s*([kMGT]?)(?:B|o|bytes?)?$/i.exec(String(s || '').replace(/ /g, ' ').trim());
  if (!m) return undefined;
  const n = Number(m[1].replace(',', '.'));
  if (!Number.isFinite(n)) return undefined;
  return Math.round(n * { '': 1, k: 1e3, m: 1e6, g: 1e9, t: 1e12 }[m[2].toLowerCase()]);
}
/** `flatpak list --user --app --columns=application,version,size` -> [{ id, version?, size? }] (header lines skipped) */
function parseList(text) {
  const out = [];
  const seen = new Set();
  for (const line of String(text || '').split('\n')) {
    const cols = line.split('\t').map((c) => c.trim());
    const [id, version, size] = cols;
    if (!validId(id) || seen.has(id)) continue;
    seen.add(id);
    const it = { id };
    if (version) it.version = version.slice(0, 60);
    const bytes = parseSize(size);
    if (bytes != null) it.size = bytes;
    out.push(it);
  }
  return out;
}
/** Search score (lower is better) or -1 when the app does not match. q is deaccented + lowercased. */
function score(app, q) {
  if (!q) return 10;
  const names = app._names;
  if (names.some((n) => n === q)) return 0;
  if (names.some((n) => n.startsWith(q))) return 1;
  if (names.some((n) => n.split(/[\s\-_.:]+/).some((w) => w.startsWith(q)))) return 2;
  if (names.some((n) => n.includes(q))) return 3;
  if (app._id.includes(q)) return 4;
  if (app._kw.some((k) => k.startsWith(q))) return 5;
  if (app._hay.includes(q)) return 6;
  return -1;
}

// ------------------------------------------------------------------ module state
let ctx = {};
let useMock = true;
let home = os.homedir();
let catalog = null; // { apps, byId, updatedAt, file?, mtime? }
let loading = null;
let refreshing = null;
let installedMap = null; // Map id -> { id, version?, size? }
let lastError = null; // { code, message }
let remoteReady = false;
const busy = new Map(); // id -> 'install' | 'remove'
const devInstalled = new Map();

const env = () => process.env;
function lang() {
  try {
    const l = ctx.api?.settings?.get?.('lang') || ctx.env?.lang || 'en';
    return String(l).toLowerCase().startsWith('fr') ? 'fr' : 'en';
  } catch {
    return 'en';
  }
}
const t = (key, l = lang()) => (MSG[key] ? MSG[key][l] || MSG[key].en : key);
function fail(code, detail, key = code) {
  const base = t(key);
  const e = new Error(detail ? `${base}: ${detail}` : base);
  e.code = code;
  e.key = key;
  e.detail = detail || '';
  e.quiet = true;
  return e;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function userDir() {
  if (env().FLATPAK_USER_DIR) return env().FLATPAK_USER_DIR;
  return path.join(env().XDG_DATA_HOME || path.join(home, '.local', 'share'), 'flatpak');
}
const cacheFile = () => path.join(env().XDG_CACHE_HOME && !useMock ? env().XDG_CACHE_HOME : path.join(home, '.cache'), 'aurora', 'store', 'flathub.json');
function appstreamPaths() {
  const active = path.join(userDir(), 'appstream', REMOTE, ARCH, 'active');
  const gz = path.join(active, 'appstream.xml.gz');
  const plain = path.join(active, 'appstream.xml');
  const xml = fs.existsSync(gz) ? gz : fs.existsSync(plain) ? plain : null;
  return { xml, icons: path.join(active, 'icons') };
}
function which(cmd) {
  for (const d of (env().PATH || '/usr/local/bin:/usr/bin:/bin').split(':').concat(['/usr/bin', '/bin'])) {
    if (!d) continue;
    const f = path.join(d, cmd);
    try {
      fs.accessSync(f, fs.constants.X_OK);
      if (fs.statSync(f).isFile()) return f;
    } catch {}
  }
  return null;
}
// AURORA_FLATPAK=<path> replaces the flatpak binary (tests use a stub that records its argv).
function flatpakBin() {
  const forced = env().AURORA_FLATPAK;
  if (forced) {
    try {
      fs.accessSync(forced, fs.constants.X_OK);
      return forced;
    } catch {
      return null;
    }
  }
  return which('flatpak');
}
function isLive() {
  if (ctx.env && ctx.env.live === true) return true;
  if (env().AURORA_LIVE === '1') return true;
  if (useMock) return false;
  try {
    if (fs.existsSync('/run/casper')) return true;
    return /\bboot=casper\b/.test(fs.readFileSync('/proc/cmdline', 'utf8'));
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ catalogue
function runHelper(xml, icons, out) {
  return new Promise((resolve, reject) => {
    const helper = useMock ? (fs.existsSync(DEV_HELPER) ? DEV_HELPER : SYS_HELPER) : fs.existsSync(SYS_HELPER) ? SYS_HELPER : DEV_HELPER;
    const py = which('python3');
    if (!py) return reject(fail('EFLATPAK', 'python3 not found', 'ECATALOG'));
    const child = spawn(py, ['-I', helper, '--xml', xml, '--icons', icons, '--out', out], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...env(), LC_ALL: 'C.UTF-8' } });
    const chunks = [];
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 300000);
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => (err = (err + d).slice(-4000)));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(fail('EFLATPAK', e.message, 'ECATALOG'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(fail('EFLATPAK', errorDetail(err), 'ECATALOG'));
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}
function index(doc, updatedAt) {
  const apps = [];
  const byId = new Map();
  for (const a of Array.isArray(doc?.apps) ? doc.apps : []) {
    if (!a || !validId(a.id) || byId.has(a.id) || !a.name?.en) continue;
    a.categories = (Array.isArray(a.categories) ? a.categories : []).filter((c) => MAIN_CATEGORIES.includes(c));
    a.keywords = Array.isArray(a.keywords) ? a.keywords : [];
    a._names = [...new Set([a.name.en, a.name.fr].filter(Boolean).map(deaccent))];
    a._id = a.id.toLowerCase();
    a._kw = a.keywords.map(deaccent);
    a._hay = deaccent([a.summary?.en, a.summary?.fr, ...a.keywords].filter(Boolean).join('\n'));
    a._sort = deaccent(a.name.en);
    apps.push(a);
    byId.set(a.id, a);
  }
  apps.sort((x, y) => (x._sort < y._sort ? -1 : x._sort > y._sort ? 1 : x.id < y.id ? -1 : 1));
  return { apps, byId, updatedAt };
}
const EMPTY = { apps: [], byId: new Map(), updatedAt: null };

async function loadCatalog() {
  if (loading) return loading;
  loading = (async () => {
    if (useMock) {
      if (catalog) return catalog;
      const xml = path.join(FIXTURE_DIR, 'appstream.xml.gz');
      const doc = JSON.parse(await runHelper(xml, path.join(FIXTURE_DIR, 'icons'), '-'));
      catalog = index(doc, Date.UTC(2026, 0, 1));
      return catalog;
    }
    const file = cacheFile();
    const { xml, icons } = appstreamPaths();
    let st = null;
    try {
      st = fs.statSync(file);
    } catch {}
    // Rebuild without network when flatpak has newer AppStream data than the cache (or there is no cache yet).
    if (xml) {
      let xst = null;
      try {
        xst = fs.statSync(xml);
      } catch {}
      if (xst && (!st || xst.mtimeMs > st.mtimeMs)) {
        await runHelper(xml, icons, file);
        st = fs.statSync(file);
      }
    }
    if (!st) return (catalog = EMPTY);
    if (catalog && catalog.file === file && catalog.mtime === st.mtimeMs) return catalog;
    let doc;
    try {
      doc = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    } catch {
      // Corrupt or unreadable cache: rebuild it from flatpak's AppStream data (no network), else drop it.
      if (!xml) {
        try {
          fs.rmSync(file, { force: true });
        } catch {}
        return (catalog = EMPTY);
      }
      await runHelper(xml, icons, file);
      st = fs.statSync(file);
      doc = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    }
    catalog = Object.assign(index(doc, st.mtimeMs), { file, mtime: st.mtimeMs });
    return catalog;
  })();
  try {
    return await loading;
  } finally {
    loading = null;
  }
}

// ------------------------------------------------------------------ flatpak CLI
/**
 * Run flatpak with an argv array. onLine({ percent?, message }) gets parsed progress lines. Resolves { stdout };
 * rejects with ENET / ENOSPC / EFLATPAK.
 */
function flatpak(args, { onLine, timeout = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const bin = flatpakBin();
    if (!bin) return reject(fail('EFLATPAK', '', 'NOFLATPAK'));
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...env(), LC_ALL: 'C.UTF-8', LANGUAGE: '' } });
    } catch (e) {
      return reject(fail('EFLATPAK', e.message));
    }
    let stdout = '';
    let tail = '';
    let pending = '';
    const feed = (d, isOut) => {
      const s = d.toString('utf8');
      if (isOut) stdout = (stdout + s).slice(-4 * 1024 * 1024);
      tail = (tail + s).slice(-16000);
      if (!onLine) return;
      pending += s;
      const parts = pending.split(/[\r\n]/);
      pending = parts.pop();
      for (const p of parts) {
        const ev = parseProgress(p);
        if (ev) onLine(ev);
      }
      // A progress bar redrawn without a newline: report the partial line too.
      const ev = parseProgress(pending);
      if (ev && ev.percent != null) onLine(ev);
    };
    child.stdout.on('data', (d) => feed(d, true));
    child.stderr.on('data', (d) => feed(d, false));
    const timer = timeout ? setTimeout(() => child.kill('SIGTERM'), timeout) : null;
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(fail('EFLATPAK', e.message));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ stdout });
      const c = errorCode(tail);
      reject(fail(c, errorDetail(tail), c));
    });
  });
}

async function ensureRemote() {
  if (remoteReady) return;
  try {
    await flatpak(['remote-add', '--user', '--if-not-exists', REMOTE, REMOTE_URL], { timeout: 120000 });
  } catch (e) {
    if (e.code !== 'EFLATPAK' || e.key === 'NOFLATPAK') throw e;
    throw fail('EFLATPAK', e.detail, 'EREMOTE');
  }
  remoteReady = true;
}

async function installedSet() {
  if (useMock) return devInstalled;
  // A failed `flatpak list` counts as nothing installed until the next installed() call, so a store index build
  // (dozens of search pages) does not run flatpak once per page.
  if (!installedMap) await api.installed().catch(() => (installedMap = installedMap || new Map()));
  return installedMap || new Map();
}

function pick(obj, l) {
  if (!obj || typeof obj !== 'object') return '';
  return (l === 'fr' && obj.fr) || obj.en || '';
}
function toItem(a, inst, l) {
  const installed = inst.has(a.id);
  return {
    source: 'flathub',
    id: a.id,
    appId: a.appId || a.id,
    name: pick(a.name, l),
    summary: pick(a.summary, l),
    icon: typeof a.icon === 'string' && /^(media:\/\/local\/|https:\/\/)/.test(a.icon) ? a.icon : null,
    categories: a.categories.slice(),
    installed,
    desktopId: installed ? `${a.id}.desktop` : null,
  };
}

function devFailure(id) {
  const v = env().AURORA_STORE_DEV_FAIL || '';
  for (const part of v.split(',')) {
    const [fid, code] = part.trim().split(':');
    if (fid === id) return ['ENET', 'ENOSPC', 'EFLATPAK'].includes(code) ? code : 'EFLATPAK';
  }
  return null;
}
async function simulate(id, kind, onProgress) {
  const steps = [0, 20, 45, 70, 90, 100];
  const failCode = devFailure(id);
  for (const p of steps) {
    if (failCode && p >= 45) throw fail(failCode, failCode === 'EFLATPAK' ? `simulated failure for ${id}` : '', failCode);
    onProgress({ percent: p, message: p === 100 ? t('done') : t(kind) });
    await sleep(env().AURORA_STORE_DEV_DELAY != null ? Number(env().AURORA_STORE_DEV_DELAY) || 0 : 40);
  }
}

// ------------------------------------------------------------------ API
const api = {
  id: 'flathub',
  label: { en: 'Flathub', fr: 'Flathub' },

  init(c = {}) {
    ctx = c || {};
    const DEV = !!(ctx.DEV ?? ctx.api?.DEV);
    useMock = DEV && env().AURORA_REAL_BACKENDS !== '1';
    home = ctx.home || os.homedir();
    catalog = null;
    loading = null;
    refreshing = null;
    installedMap = null;
    lastError = null;
    remoteReady = false;
    busy.clear();
    devInstalled.clear();
    return api;
  },

  async status() {
    const live = isLive();
    const available = useMock ? true : !!flatpakBin();
    let c = EMPTY;
    let err = lastError;
    try {
      c = await loadCatalog();
    } catch (e) {
      err = err || { code: e.code || 'EFLATPAK', message: e.message };
    }
    if (!available) err = { code: 'EFLATPAK', message: t('NOFLATPAK') };
    const out = { available, ready: available && c.apps.length > 0, updatedAt: c.updatedAt || null, count: c.apps.length, live };
    if (useMock) out.simulated = true;
    if (err) {
      out.error = err.message;
      out.errorCode = err.code;
    }
    return out;
  },

  async refresh(onProgress = () => {}) {
    if (refreshing) return refreshing;
    const progress = (phase, percent) => {
      try {
        onProgress(percent == null ? { phase, message: t(phase) } : { phase, percent, message: t(phase) });
      } catch {}
    };
    refreshing = (async () => {
      try {
        if (useMock) {
          progress('remote', 0);
          await sleep(20);
          progress('download', 50);
          await sleep(20);
          progress('parse', 90);
          catalog = null;
          await loadCatalog();
        } else {
          if (!flatpakBin()) throw fail('EFLATPAK', '', 'NOFLATPAK');
          progress('remote');
          await ensureRemote();
          progress('download');
          await flatpak(['update', '--user', '--appstream', REMOTE], {
            timeout: 600000,
            onLine: (ev) => ev.percent != null && progress('download', ev.percent),
          });
          progress('parse');
          const { xml, icons } = appstreamPaths();
          if (!xml) throw fail('EFLATPAK', 'appstream.xml.gz', 'ECATALOG');
          await runHelper(xml, icons, cacheFile());
          catalog = null;
          await loadCatalog();
        }
        lastError = null;
        progress('done', 100);
        return api.status();
      } catch (e) {
        lastError = { code: e.code || 'EFLATPAK', message: e.message };
        throw e;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  },

  async search({ query = '', category = '', offset = 0, limit = 50, lang: l } = {}) {
    const L = l === 'fr' || l === 'en' ? l : lang();
    const c = await loadCatalog();
    const inst = await installedSet();
    const q = deaccent(String(query || '').trim()).slice(0, 200);
    const cat = MAIN_CATEGORIES.includes(category) ? category : '';
    const hits = [];
    for (const a of c.apps) {
      if (cat && !a.categories.includes(cat)) continue;
      const s = score(a, q);
      if (s >= 0) hits.push([s, a]);
    }
    hits.sort((x, y) => x[0] - y[0]); // stable: ties keep the alphabetical catalogue order
    const off = Math.max(0, Math.floor(Number(offset) || 0));
    const lim = Math.max(1, Math.min(500, Math.floor(Number(limit) || 50)));
    return { items: hits.slice(off, off + lim).map(([, a]) => toItem(a, inst, L)), total: hits.length };
  },

  async details(id) {
    if (!validId(id)) throw fail('EINVAL');
    const L = lang();
    const c = await loadCatalog();
    const a = c.byId.get(id);
    if (!a) throw fail('ENOENT');
    const inst = await installedSet();
    const item = toItem(a, inst, L);
    return {
      ...item,
      description: pick(a.description, L),
      screenshots: (Array.isArray(a.screenshots) ? a.screenshots : []).filter((u) => typeof u === 'string' && u.startsWith('https://')).slice(0, 4),
      homepage: typeof a.homepage === 'string' && /^https?:\/\//.test(a.homepage) ? a.homepage : '',
      license: a.license || '',
      developer: a.developer || '',
      version: a.version || '',
      installedVersion: inst.get(a.id)?.version || null,
    };
  },

  async installed() {
    if (useMock) return [...devInstalled.values()].map((x) => ({ ...x }));
    if (!flatpakBin()) {
      installedMap = new Map();
      return [];
    }
    const r = await flatpak(['list', '--user', '--app', '--columns=application,version,size'], { timeout: 30000 });
    const list = parseList(r.stdout);
    installedMap = new Map(list.map((x) => [x.id, x]));
    return list;
  },

  async install(id, onProgress = () => {}) {
    if (!validId(id)) throw fail('EINVAL');
    if (busy.has(id)) throw fail('EBUSY');
    busy.set(id, 'install');
    const report = (ev) => {
      try {
        onProgress(ev);
      } catch {}
    };
    try {
      if (useMock) {
        const c = await loadCatalog();
        const a = c.byId.get(id);
        if (!a) throw fail('ENOENT');
        if (!devInstalled.has(id)) {
          await simulate(id, 'install', report);
          devInstalled.set(id, { id, version: a.version || '1.0', size: 100e6 + a.id.length * 1e6 });
        }
        return { desktopId: `${id}.desktop` };
      }
      report({ message: t('remote') });
      await ensureRemote();
      report({ percent: 0, message: t('install') });
      await flatpak(['install', '--user', '-y', '--noninteractive', REMOTE, id], { onLine: report });
      await api.installed().catch(() => {});
      report({ percent: 100, message: t('done') });
      return { desktopId: `${id}.desktop` };
    } finally {
      busy.delete(id);
    }
  },

  async remove(id, onProgress = () => {}) {
    if (!validId(id)) throw fail('EINVAL');
    if (busy.has(id)) throw fail('EBUSY');
    busy.set(id, 'remove');
    const report = (ev) => {
      try {
        onProgress(ev);
      } catch {}
    };
    try {
      if (useMock) {
        if (devInstalled.has(id)) {
          await simulate(id, 'remove', report);
          devInstalled.delete(id);
        }
        return {};
      }
      report({ percent: 0, message: t('remove') });
      await flatpak(['uninstall', '--user', '-y', '--noninteractive', id], { onLine: report });
      await api.installed().catch(() => {});
      report({ percent: 100, message: t('done') });
      return {};
    } finally {
      busy.delete(id);
    }
  },
};

api.init({ DEV: false });
module.exports = api;
module.exports._internal = { validId, errorCode, errorDetail, parseProgress, parseList, parseSize, cleanLine, score, deaccent, FIXTURE_DIR, DEV_HELPER, MAIN_CATEGORIES };
