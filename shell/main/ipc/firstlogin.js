'use strict';
// First login: work the installer left for the new user's first session.
//
// Gaming apps (installer step « Jeux », helper aurora-install --gaming APPID[,APPID...]):
//   ~/.config/aurora/first-login/gaming.json = { "version": 1, "apps": [flatpak ids], "requestedAt": "<ISO date>" }
//   apps must be a subset of GAMING_APPS (anything else: the file is set aside as gaming.invalid.json, nothing runs).
//   The apps are installed one after the other, per user, through the Store's own Flathub path
//   (main/ipc/store.js api.storeService.install -> lib/sources/flathub.js: flatpak --user, remote added if needed),
//   so they show up in the Logithèque (Installées) and in the Lanceur like any Flathub app.
//   Success -> the file becomes gaming.done.json (never runs twice; a gaming.done.json present wins over gaming.json).
//   No network -> waits and retries with backoff (and at once when the renderer reports it is back online).
//   One app failing does not stop the others; at the end the file stays (with attempts / lastError) and the next
//   session retries on its own, up to MAX_ATTEMPTS failed runs (time spent offline does not count). Cancel stops after the current app; the remaining apps
//   wait for « Réessayer » (cancelledAt is kept: later sessions do not restart on their own).
//
// Channels (renderer: core/features/gaming-setup.js):
//   firstlogin:gaming:status ()  -> State
//   firstlogin:gaming:start ()   -> State   start (or resume) when pending; no-op when running / done / nothing to do
//   firstlogin:gaming:retry ()   -> State   « Réessayer »: also after a cancel or failures
//   firstlogin:gaming:cancel ()  -> State   stop after the current app
//   firstlogin:gaming:online ()  -> State   the network is back: retry now when waiting
//   (+firstlogin:gaming State)   every change
//   State = { state: 'none'|'pending'|'running'|'cancelling'|'waiting'|'done'|'failed'|'cancelled'|'invalid',
//             apps: [{ id, name, status: 'pending'|'installing'|'installed'|'failed', percent, error, code }],
//             total, index (1-based, current app), current (id|null), percent (overall 0..100), retryAt (ms|null),
//             autoStart (start on its own at session start), startDelay (ms) }
//
// Dev / tests: AURORA_FIRSTLOGIN_RETRY_MS (first backoff delay), AURORA_FIRSTLOGIN_DELAY_MS (start delay).
const fs = require('fs');
const os = require('os');
const path = require('path');

const GAMING_APPS = [
  { id: 'com.valvesoftware.Steam', name: 'Steam' },
  { id: 'com.heroicgameslauncher.hgl', name: 'Heroic Games Launcher' },
  { id: 'net.lutris.Lutris', name: 'Lutris' },
  { id: 'net.davidotek.pupgui2', name: 'ProtonUp-Qt' },
  { id: 'com.usebottles.bottles', name: 'Bottles' },
  { id: 'com.discordapp.Discord', name: 'Discord' },
];
const ALLOWED = new Map(GAMING_APPS.map((a) => [a.id, a]));
const MAX_FILE = 64 * 1024;
const MAX_ATTEMPTS = 3;
const NET_CODES = new Set(['ENET', 'ENETWORK', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH']);
const ISO = /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:?\d{2})?$/;

/** Validate the gaming.json document (unit-tested). -> { apps, requestedAt, attempts, cancelledAt } or null */
function parseGaming(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || doc.version !== 1 || !Array.isArray(doc.apps)) return null;
  if (doc.apps.length > GAMING_APPS.length * 2) return null;
  const apps = [];
  for (const id of doc.apps) {
    if (typeof id !== 'string' || !ALLOWED.has(id)) return null;
    if (!apps.includes(id)) apps.push(id);
  }
  const iso = (v) => (typeof v === 'string' && v.length <= 40 && ISO.test(v) ? v : null);
  return {
    apps,
    requestedAt: iso(doc.requestedAt),
    attempts: Number.isInteger(doc.attempts) && doc.attempts >= 0 && doc.attempts < 1000 ? doc.attempts : 0,
    cancelledAt: iso(doc.cancelledAt),
  };
}

/** Backoff delays while offline: base, x3, x6, x12… capped at 5 minutes (unit-tested). */
function backoff(n, base = 10000) {
  const steps = [1, 3, 6, 12, 30];
  return Math.min(Math.max(base, 1) * steps[Math.min(n, steps.length - 1)], Math.max(base, 300000));
}

/**
 * The gaming setup, independent of Electron (tests build it with a fake store and a fake broadcast).
 * store = { install(source, id, onProgress) -> Promise, installedIds(source) -> Promise<Set>, available(source) }
 */
function createGamingSetup({ home = os.homedir(), store, broadcast = () => {}, isOnline = () => true, retryBase = 10000, startDelay = 4000, uid = process.getuid?.() } = {}) {
  const dir = path.join(home, '.config', 'aurora', 'first-login');
  const FILE = path.join(dir, 'gaming.json');
  const DONE = path.join(dir, 'gaming.done.json');
  const INVALID = path.join(dir, 'gaming.invalid.json');

  let st = { state: 'none', apps: [], total: 0, index: 0, current: null, percent: 0, retryAt: null, autoStart: false, startDelay };
  let doc = null; // parsed file
  let running = null; // promise of the current run
  let cancelRequested = false;
  let timer = null;
  let wake = null; // resolves the offline wait early
  let offlineRound = 0;

  const snapshot = () => ({ ...st, apps: st.apps.map((a) => ({ ...a })) });
  const emit = () => {
    try {
      broadcast('firstlogin:gaming', snapshot());
    } catch {}
  };
  const set = (patch) => {
    Object.assign(st, patch);
    const done = st.apps.filter((a) => a.status === 'installed' || a.status === 'failed').length;
    const cur = st.apps.find((a) => a.status === 'installing');
    st.percent = st.total ? Math.round(((done + (cur ? cur.percent / 100 : 0)) / st.total) * 100) : 0;
    emit();
  };

  function readFileSafe(file) {
    const ls = fs.lstatSync(file);
    if (!ls.isFile() || ls.size > MAX_FILE) throw Object.assign(new Error('not a regular file'), { code: 'EINVAL' });
    if (uid != null && ls.uid !== uid && ls.uid !== 0) throw Object.assign(new Error('not owned by the user'), { code: 'EPERM' });
    return fs.readFileSync(file, 'utf8');
  }
  function writeFile(file, data) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o644 });
    fs.renameSync(tmp, file);
  }
  const fileDoc = (extra = {}) => ({ version: 1, apps: doc.apps, requestedAt: doc.requestedAt || new Date().toISOString(), ...(doc.attempts ? { attempts: doc.attempts } : {}), ...(doc.cancelledAt ? { cancelledAt: doc.cancelledAt } : {}), ...extra });
  function save(extra) {
    try {
      writeFile(FILE, fileDoc(extra));
    } catch (e) {
      console.warn('[firstlogin] could not update gaming.json:', e?.message || e);
    }
  }

  /** Read the request from disk (once per session, again after a retry). */
  function load() {
    if (fs.existsSync(DONE)) {
      if (fs.existsSync(FILE)) console.warn('[firstlogin] gaming.done.json present: gaming.json ignored');
      st = { ...st, state: 'none', apps: [], total: 0, autoStart: false };
      doc = null;
      return st;
    }
    let text;
    try {
      text = readFileSafe(FILE);
    } catch (e) {
      if (e.code !== 'ENOENT') console.warn('[firstlogin] gaming.json unreadable:', e.message);
      st = { ...st, state: e.code === 'ENOENT' ? 'none' : 'invalid', apps: [], total: 0, autoStart: false };
      doc = null;
      return st;
    }
    let parsed = null;
    try {
      parsed = parseGaming(JSON.parse(text));
    } catch {}
    if (!parsed) {
      console.warn('[firstlogin] gaming.json is not valid: set aside as gaming.invalid.json');
      try {
        fs.renameSync(FILE, INVALID);
      } catch {}
      st = { ...st, state: 'invalid', apps: [], total: 0, autoStart: false };
      doc = null;
      return st;
    }
    doc = parsed;
    const apps = parsed.apps.map((id) => ({ id, name: ALLOWED.get(id).name, status: 'pending', percent: 0, error: null, code: null }));
    const state = parsed.cancelledAt ? 'cancelled' : 'pending';
    st = { ...st, state, apps, total: apps.length, index: 0, current: null, percent: 0, retryAt: null, autoStart: state === 'pending' && parsed.attempts < MAX_ATTEMPTS };
    return st;
  }

  function markDone() {
    try {
      writeFile(DONE, { ...fileDoc(), completedAt: new Date().toISOString() });
      fs.rmSync(FILE, { force: true });
    } catch (e) {
      console.warn('[firstlogin] could not mark the gaming apps as done:', e?.message || e);
    }
  }

  function waitOffline() {
    const ms = backoff(offlineRound++, retryBase);
    set({ state: 'waiting', retryAt: Date.now() + ms });
    return new Promise((resolve) => {
      wake = resolve;
      timer = setTimeout(resolve, ms);
    }).finally(() => {
      clearTimeout(timer);
      timer = null;
      wake = null;
      if (st.state === 'waiting') set({ retryAt: null });
    });
  }

  async function run() {
    if (!store) throw Object.assign(new Error('The Logithèque is not available'), { code: 'ENOSTORE' });
    // attempts counts the runs that ended with failed apps (not the ones spent offline, nor a session closed
    // mid-install): a user who is offline for their first sessions still gets the apps automatically later.
    doc.cancelledAt = null;
    save();
    cancelRequested = false;
    offlineRound = 0;
    let installed = new Set();
    try {
      installed = await store.installedIds('flathub');
    } catch {}
    for (const a of st.apps) if (installed.has(a.id)) Object.assign(a, { status: 'installed', percent: 100, error: null, code: null });
    set({ state: 'running', retryAt: null, current: null, index: Math.max(1, st.apps.findIndex((a) => a.status !== 'installed') + 1) });
    for (let i = 0; i < st.apps.length; i++) {
      const a = st.apps[i];
      if (a.status === 'installed' || a.status === 'failed') continue;
      if (cancelRequested) break;
      for (;;) {
        Object.assign(a, { status: 'installing', percent: 0, error: null, code: null });
        set({ state: cancelRequested ? 'cancelling' : 'running', index: i + 1, current: a.id });
        try {
          let last = 0;
          await store.install('flathub', a.id, (ev) => {
            const p = Math.max(0, Math.min(100, Number(ev?.percent) || 0));
            if (p === last) return;
            last = p;
            a.percent = p;
            set({});
          });
          Object.assign(a, { status: 'installed', percent: 100 });
          offlineRound = 0;
          break;
        } catch (e) {
          const code = String(e?.code || 'EFAIL');
          if (code === 'EBUSY') {
            // The Logithèque is installing something else: wait for it, then go on with this app.
            a.status = 'pending';
            set({});
            await new Promise((r) => setTimeout(r, Math.min(retryBase, 3000)));
            if (cancelRequested) break;
            continue;
          }
          if (NET_CODES.has(code)) {
            Object.assign(a, { status: 'pending', percent: 0 });
            if (cancelRequested) break;
            await waitOffline();
            if (cancelRequested) break;
            continue;
          }
          Object.assign(a, { status: 'failed', percent: 0, error: String(e?.message || e).slice(0, 300), code });
          break;
        }
      }
      set({});
    }
    const left = st.apps.filter((a) => a.status !== 'installed');
    if (!left.length) {
      markDone();
      set({ state: 'done', current: null, index: st.total, retryAt: null, autoStart: false });
    } else if (cancelRequested) {
      for (const a of left) if (a.status !== 'failed') Object.assign(a, { status: 'pending', percent: 0 });
      doc.cancelledAt = new Date().toISOString();
      save();
      set({ state: 'cancelled', current: null, retryAt: null, autoStart: false });
    } else {
      const failed = left.filter((a) => a.status === 'failed');
      doc.attempts = (doc.attempts || 0) + 1;
      save({ lastError: { at: new Date().toISOString(), apps: failed.map((a) => ({ id: a.id, code: a.code })) } });
      set({ state: 'failed', current: null, retryAt: null, autoStart: false });
    }
    cancelRequested = false;
  }

  function start({ retry = false } = {}) {
    if (running) return snapshot();
    const already = new Set(st.apps.filter((a) => a.status === 'installed').map((a) => a.id));
    if (retry || !doc) load();
    for (const a of st.apps) if (already.has(a.id)) Object.assign(a, { status: 'installed', percent: 100 });
    if (!doc || !st.apps.length) {
      if (doc && !st.apps.length) {
        markDone();
        set({ state: 'done' });
      }
      return snapshot();
    }
    if (!retry && st.state !== 'pending') return snapshot();
    if (!retry && !st.autoStart) return snapshot();
    for (const a of st.apps) if (a.status === 'failed') Object.assign(a, { status: 'pending', error: null, code: null });
    running = run()
      .catch((e) => {
        console.warn('[firstlogin] gaming setup failed:', e?.message || e);
        for (const a of st.apps) if (a.status !== 'installed') Object.assign(a, { status: 'failed', error: String(e?.message || e).slice(0, 300), code: e?.code || 'EFAIL' });
        set({ state: 'failed', current: null });
      })
      .finally(() => {
        running = null;
      });
    return snapshot();
  }

  return {
    FILE,
    DONE,
    INVALID,
    status() {
      if (!running && !doc && st.state === 'none') load();
      return snapshot();
    },
    start: () => start(),
    retry: () => start({ retry: true }),
    cancel() {
      if (!running) return snapshot();
      cancelRequested = true;
      if (st.state === 'waiting') wake?.();
      else set({ state: 'cancelling' });
      return snapshot();
    },
    online() {
      if (st.state === 'waiting' && isOnline()) wake?.();
      return snapshot();
    },
    /** Resolves when the current run (if any) has finished (tests). */
    idle: () => running || Promise.resolve(),
  };
}

function register(api) {
  if (api.env?.mode && api.env.mode !== 'shell') return;
  const devNum = (name, def) => {
    const v = api.DEV ? Number(process.env[name]) : NaN;
    return Number.isFinite(v) && v >= 0 ? v : def;
  };
  let isOnline = () => true;
  try {
    const { net } = require('electron');
    if (typeof net?.isOnline === 'function') isOnline = () => net.isOnline();
  } catch {}
  // api.storeService is set by store.js, which loads after this module: looked up at call time.
  const store = {
    install: (...a) => api.storeService.install(...a),
    installedIds: (...a) => api.storeService.installedIds(...a),
    available: (...a) => api.storeService.available(...a),
  };
  const g = createGamingSetup({
    home: os.homedir(),
    store,
    broadcast: (ch, p) => api.broadcast(ch, p),
    isOnline,
    retryBase: devNum('AURORA_FIRSTLOGIN_RETRY_MS', 10000),
    startDelay: devNum('AURORA_FIRSTLOGIN_DELAY_MS', 4000),
  });
  api.handle('firstlogin:gaming:status', async () => g.status());
  api.handle('firstlogin:gaming:start', async () => {
    if (!api.storeService) throw api.error('The Logithèque is not available', 'ENOSTORE');
    return g.start();
  });
  api.handle('firstlogin:gaming:retry', async () => {
    if (!api.storeService) throw api.error('The Logithèque is not available', 'ENOSTORE');
    return g.retry();
  });
  api.handle('firstlogin:gaming:cancel', async () => g.cancel());
  api.handle('firstlogin:gaming:online', async () => g.online());
}

module.exports = register;
module.exports.createGamingSetup = createGamingSetup;
module.exports.parsers = { parseGaming, backoff, GAMING_APPS };
