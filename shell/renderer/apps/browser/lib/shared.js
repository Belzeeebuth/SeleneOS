// Aurora Browser — state shared by every browser window: the data store, the list of open
// windows, live downloads, and the routing of backend events (which arrive tagged with the
// webContents id of the tab that caused them) to the right window/tab.
import { Store } from './store.js';

const listeners = new Map();

export const shared = {
  ready: null,
  ctx: null,
  t: (k) => k,
  api: null,
  shell: null,
  ui: null,
  store: new Store(),
  windows: [], // BrowserWindowCtl instances
  downloads: new Map(), // id -> download info (live + persisted)
  info: null,
  privateSeq: 0,
  privatePartition: null, // shared by every open Private window
  lastExternal: 0,
  restoredOnce: false,
  dev: false,

  on(ev, fn) {
    if (!listeners.has(ev)) listeners.set(ev, new Set());
    listeners.get(ev).add(fn);
    return () => listeners.get(ev)?.delete(fn);
  },
  /** Number of live subscriptions (tests use it to check that closed windows release theirs). */
  listenerCount() {
    let n = 0;
    for (const set of listeners.values()) n += set.size;
    for (const set of shared.store._h.values()) n += set.size;
    return n;
  },
  emit(ev, ...a) {
    for (const fn of [...(listeners.get(ev) || [])]) {
      try {
        fn(...a);
      } catch (err) {
        console.error(`[browser] ${ev} handler failed`, err);
      }
    }
  },

  findTab(wcId) {
    if (wcId == null) return null;
    for (const bw of shared.windows) {
      const tab = bw.tabs.find((x) => x.wcId === wcId);
      if (tab) return { bw, tab };
    }
    return null;
  },

  /** Most recently focused window (normal windows first unless allowPrivate). */
  mostRecent({ allowPrivate = false } = {}) {
    const list = shared.windows.filter((w) => !w.closing && (allowPrivate || !w.private));
    return list.sort((a, b) => b.lastFocus - a.lastFocus)[0] || null;
  },

  saveSession() {
    const wins = shared.windows.filter((w) => !w.private && !w.closing);
    shared.store.session = { windows: wins.sort((a, b) => b.lastFocus - a.lastFocus).map((w) => w.sessionState()), saved: Date.now() };
    shared.store.save('session', 800);
  },

  /** Downloads a window may show: Private windows see everything, normal windows never see Private ones. */
  activeDownloads(bw = null) {
    return shared.downloadList(bw).filter((d) => d.state === 'progressing');
  },

  downloadList(bw = null) {
    const list = [...shared.downloads.values()].filter((d) => !bw || bw.private || !d.private);
    return list.sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
  },

  removeDownload(id) {
    shared.downloads.delete(id);
    shared.store.removeDownload(id);
    shared.emit('downloads');
  },

  clearDownloads() {
    for (const [id, d] of shared.downloads) if (d.state !== 'progressing') shared.downloads.delete(id);
    shared.store.clearDownloads(true);
    shared.emit('downloads');
  },

  /** User-facing (translated) text for a failed backend call. */
  errorText(err) {
    const t = shared.t;
    const key = {
      ENORESUME: 'errors.noResume',
      ENOTAB: 'errors.tabGone',
      EINVAL: 'errors.invalid',
      EACCES: 'errors.denied',
      EPERM: 'errors.denied',
      EROFS: 'errors.denied',
      ENOSPC: 'errors.diskFull',
      ENOENT: 'errors.notFound',
    }[err?.code];
    if (key) return t(key);
    return t('errors.generic', { msg: String(err?.message || err || '').slice(0, 300) });
  },

  showInFolder(path) {
    const dir = path.replace(/\/[^/]+$/, '') || '/';
    shared.shell.launch('files', { path: dir, select: path });
  },

  async openDownload(d, parent) {
    try {
      const exists = await shared.api.invoke('fs:exists', d.path);
      if (!exists) {
        await shared.ui.alert(shared.t('dl.missing', { name: d.filename }), { title: shared.t('dl.title'), parent });
        return;
      }
      await shared.shell.openFile(d.path);
    } catch (err) {
      shared.ui.alert(shared.errorText(err), { title: shared.t('dl.title'), parent });
    }
  },
};

export function initShared(ctx) {
  if (shared.ready) return shared.ready;
  shared.ready = (async () => {
    Object.assign(shared, { ctx, t: ctx.t, api: ctx.api, shell: ctx.shell, ui: ctx.ui, dev: !!ctx.env?.dev });
    const { api, store } = shared;
    await store.load(ctx.storage, ctx.t);
    for (const d of store.downloads) shared.downloads.set(d.id, { ...d, state: d.state === 'progressing' ? 'interrupted' : d.state });
    try {
      for (const d of await api.invoke('browser:downloads')) shared.downloads.set(d.id, d);
    } catch {}
    api.invoke('browser:info').then((i) => (shared.info = i), () => {});
    const pushPrefs = () =>
      api.invoke('browser:setPrefs', { dnt: !!store.prefs.dnt, block3p: !!store.prefs.block3p, lang: ctx.i18n?.lang || ctx.lang }).catch(() => {});
    pushPrefs();
    store.on('prefs', (key) => {
      if (key === 'dnt' || key === 'block3p') pushPrefs();
      for (const w of shared.windows) w.onPrefs(key);
    });
    store.on('bookmarks', () => shared.windows.forEach((w) => w.onBookmarks()));
    ctx.i18n?.on?.('change', () => pushPrefs());

    api.on('browser:open', (p) => {
      const hit = shared.findTab(p.sourceId);
      if (hit) hit.bw.handleOpen(hit.tab, p);
    });
    api.on('browser:context-menu', (p) => {
      const hit = shared.findTab(p.sourceId);
      if (hit) hit.bw.showPageMenu(hit.tab, p.params);
    });
    api.on('browser:shortcut', (p) => {
      const hit = shared.findTab(p.sourceId);
      if (hit) hit.bw.handleCombo(p.combo, { tab: hit.tab, fromPage: true, passThrough: p.passThrough });
    });
    api.on('browser:permission', (p) => {
      const hit = shared.findTab(p.sourceId);
      if (hit) hit.bw.queuePermission(hit.tab, p);
      else api.invoke('browser:permissionReply', p.id, { allow: false }).catch(() => {});
    });
    api.on('browser:permission-done', (p) => shared.windows.forEach((w) => w.dropPermission(p.id)));
    // Screen sharing picker (lib/screenshare.js); no window for the tab -> denied.
    api.on('browser:display-media', (p) => {
      const hit = shared.findTab(p.sourceId);
      if (hit) import('./screenshare.js').then((m) => m.pickSource(hit.bw, hit.tab, p)).catch(() => api.invoke('browser:displayMediaReply', p.id, null).catch(() => {}));
      else api.invoke('browser:displayMediaReply', p.id, null).catch(() => {});
    });
    api.on('browser:display-media-done', (p) => import('./screenshare.js').then((m) => m.dropPicker(p.id)).catch(() => {}));
    api.on('browser:auth', (p) => {
      const hit = shared.findTab(p.sourceId);
      if (hit) hit.bw.showAuth(hit.tab, p);
      else api.invoke('browser:authReply', p.id, null).catch(() => {});
    });
    api.on('browser:auth-done', (p) => shared.windows.forEach((w) => w.dropAuth(p.id)));
    api.on('browser:js-dialog', (p) => {
      const hit = shared.findTab(p.sourceId);
      if (hit) hit.bw.showJsDialog(hit.tab, p);
      else api.invoke('browser:jsDialogReply', p.id, { ok: false }).catch(() => {});
    });
    api.on('browser:js-dialog-done', (p) => shared.windows.forEach((w) => w.dropAuth(p.id)));
    api.on('browser:external', (p) => {
      const hit = shared.findTab(p.sourceId);
      (hit?.bw || shared.mostRecent({ allowPrivate: true }))?.openExternal(p.url);
    });
    api.on('browser:popup-blocked', (p) => {
      const hit = shared.findTab(p.sourceId);
      if (hit) hit.bw.popupBlocked(hit.tab, p.url);
    });
    api.on('browser:download', (d) => onDownload(d));
  })();
  return shared.ready;
}

function onDownload(d) {
  const { store, t, shell } = shared;
  const prev = shared.downloads.get(d.id);
  const now = Date.now();
  // Smoothed speed for "x s left".
  if (prev && d.state === 'progressing') {
    const dt = (now - (prev._at || now)) / 1000;
    const db = (d.received || 0) - (prev.received || 0);
    const inst = dt > 0 ? db / dt : 0;
    d.speed = prev.speed ? prev.speed * 0.7 + inst * 0.3 : inst;
  }
  d._at = now;
  shared.downloads.set(d.id, { ...prev, ...d });
  store.upsertDownload(d);
  if (!prev) {
    const hit = shared.findTab(d.sourceId);
    const bw = hit?.bw || shared.windows.find((w) => w.partition === d.partition) || shared.mostRecent({ allowPrivate: true });
    bw?.onDownloadStarted(d, hit?.tab);
    // The download can be reported before a brand-new tab learns its webContents id: look again.
    if (!hit && d.sourceId != null) {
      for (const delay of [150, 600]) {
        setTimeout(() => {
          const late = shared.findTab(d.sourceId);
          if (late) late.bw.closeDownloadTab(late.tab);
        }, delay);
      }
    }
  }
  if (prev && prev.state === 'progressing' && d.state === 'completed') {
    shell.notify({
      title: t('dl.doneTitle'),
      body: d.filename,
      appId: 'browser',
      actions: [
        { label: t('dl.open'), onClick: () => shared.openDownload(d) },
        { label: t('dl.showInFolder'), onClick: () => shared.showInFolder(d.path) },
      ],
      onClick: () => shared.openDownload(d),
    });
  } else if (prev && prev.state === 'progressing' && d.state === 'interrupted') {
    shell.notify({ title: t('dl.failedTitle'), body: d.filename, appId: 'browser', icon: 'warning' });
  }
  shared.emit('downloads', d);
}
