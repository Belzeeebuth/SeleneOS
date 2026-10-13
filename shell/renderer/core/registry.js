// App registry: discovers apps (renderer/apps/<id>/manifest.json) and launches them.
//
// manifest.json:
// {
//   "id": "calculator",
//   "name": { "en": "Calculator", "fr": "Calculatrice" },
//   "description": { "en": "...", "fr": "..." },
//   "icon": "icon.svg",                 // relative to the app folder
//   "entry": "main.js",                 // ES module, default export { launch(ctx) }
//   "styles": ["style.css"],            // optional, injected once
//   "window": { "width": 360, "height": 560, "minWidth": 320, "minHeight": 480,
//               "resizable": true, "titlebar": "default", "background": "mica" },
//   "category": "utilities",            // system | utilities | productivity | internet | media | games
//   "keywords": { "en": ["math"], "fr": ["calcul"] },
//   "singleInstance": false,            // true -> relaunch focuses the existing window (and calls onRelaunch);
//                                       //         launch(id, { newWindow: true }) still opens another window
//   "fileTypes": [".txt", ".md"],       // extensions this app can open (ctx.args.file)
//   "defaultFor": [".txt"],             // extensions this app should open by default (beats other fileTypes)
//   "hidden": false,                    // hide from Start "All apps"
//   "liveOnly": false,                  // only in the live session (installer)
//   "alias": { "app": "media", "args": { "view": "music" } }  // optional: a Lanceur / search entry with its own name
//                                       // and icon that launches another app with these args (no entry module)
// }
//
// The entry module's launch(ctx) receives:
//   ctx.win        Win (see wm.js) — put your UI in ctx.win.body
//   ctx.args       launch arguments, e.g. { file: '/home/u/a.txt' } or { url: 'https://…' }
//   ctx.t(key, vars)  translator (apps/<id>/i18n.json first, then core dictionary)
//   ctx.lang       'en' | 'fr' ;  ctx.onLangChange(fn)
//   ctx.api        { invoke, on, send, mediaUrl }  (backend bridge)
//   ctx.ui, ctx.h, ctx.icon   UI kit
//   ctx.shell      shell services (launch, openFile, openUrl, notify, runAdmin, settings, ...)
//   ctx.storage    { get(name, fallback), set(name, value) } per-app JSON storage
//   ctx.manifest   the manifest ; ctx.appUrl(rel) -> 'app://shell/apps/<id>/<rel>'
//   ctx.onClose(fn)  cleanup hook (also: ctx.win.on('close', fn))
// launch(ctx) may return an object with optional hooks: { onRelaunch(args), onFocus() }.
import { api, env } from './api.js';
import { i18n } from './i18n.js';
import { wm } from './wm.js';
import { h, icon, ui } from './ui.js';
import { settings } from './settings.js';

const apps = new Map();
const loadedStyles = new Set();
const dictCache = new Map();
const instances = new Map(); // winId -> { appId, hooks }
const pendingLaunches = new Map(); // appId -> Promise<Win> while a singleInstance app is starting
let shellServices = null;
let xappsWatch = false;
i18n.extend({ en: { registry: { linuxFailed: '{app} could not be started' } }, fr: { registry: { linuxFailed: "Impossible de démarrer {app}" } } });

export function setShellServices(s) {
  shellServices = s;
}

// Extension -> MIME type of office documents (handlerFor's Linux-app fallback; same table as core/features/office.js).
const OFFICE_MIME = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
  '.rtf': 'application/rtf',
};

export const registry = {
  async load() {
    const list = await api.invoke('apps:list');
    // Linux applications (.desktop entries, main/ipc/xapps.js): kind 'linux', ids 'linux.<desktop id>', so they
    // never clash with built-in apps; merged after them. Missing backend (greeter) -> none.
    const linux = await api.invoke('xapps:list').catch(() => []);
    const transient = [...apps.values()].filter((m) => m.transient);
    apps.clear();
    for (const m of list) apps.set(m.id, m);
    for (const m of Array.isArray(linux) ? linux : []) if (m?.id && !apps.has(m.id)) apps.set(m.id, { ...m, kind: 'linux' });
    for (const m of transient) if (!apps.has(m.id)) apps.set(m.id, m);
    if (!xappsWatch) {
      xappsWatch = true;
      // Newly installed / removed Linux apps: reload, then tell Start, search and the Store.
      api.on?.('xapps:changed', () => {
        registry
          .load()
          .then(() => window.dispatchEvent(new CustomEvent('aurora:apps-changed')))
          .catch((err) => console.warn('[registry] reload failed', err));
      });
    }
    return list;
  },
  list({ includeHidden = false } = {}) {
    return [...apps.values()].filter((m) => includeHidden || !m.hidden).sort((a, b) => i18n.name(a.name).localeCompare(i18n.name(b.name), i18n.locale));
  },
  get(id) {
    return apps.get(id);
  },
  name(id) {
    const m = apps.get(id);
    return m ? i18n.name(m.name) : id;
  },
  iconUrl(id) {
    const m = apps.get(id);
    // Linux apps carry their own icon (a media:// URL resolved in the icon theme by main/ipc/xapps.js).
    if (m?.kind === 'linux') return m.iconUrl || 'app://shell/assets/app-default.svg';
    // Icon packs (core/packs.js, settings iconPack) may provide another picture for the app.
    const packed = m && registry.iconResolver ? registry.iconResolver(id, m) : null;
    if (packed) return packed;
    return m?.icon ? `app://shell/apps/${id}/${m.icon}` : 'app://shell/assets/app-default.svg';
  },
  /** (appId, manifest) -> URL | null — set by core/packs.js for icon packs. */
  iconResolver: null,
  /**
   * Register a hidden, session-only entry (external X11 window of an app with no manifest, see
   * core/features/xwin.js) so the taskbar, Alt+Tab and Task view show its name and icon.
   * manifest: { id, name: string | {en, fr}, icon: absolute URL (data:, media:, app:) | null }.
   * Never launchable; an existing entry with the same id is left alone. Returns the stored manifest.
   */
  addTransient(manifest) {
    const id = manifest && String(manifest.id || '');
    if (!id) return null;
    if (apps.has(id)) return apps.get(id);
    const m = { category: 'utilities', ...manifest, id, hidden: true, transient: true };
    apps.set(id, m);
    // Absolute icon URLs are served as-is (wraps the icon-pack resolver, which still wins for its own apps).
    if (!registry._transientIcons) {
      registry._transientIcons = true;
      const prev = registry.iconResolver;
      registry.iconResolver = (appId, man) => (man?.transient && /^(data|media|app|file):/i.test(man.icon || '') ? man.icon : prev ? prev(appId, man) : null);
    }
    return m;
  },
  running(id) {
    return wm.byApp(id);
  },
  handlerFor(path) {
    const ext = (/\.[^./]+$/.exec(path || '')?.[0] || '').toLowerCase();
    const def = settings.get('defaultApps')?.[ext];
    if (def && apps.has(def)) return def;
    // An app that declares the extension in "defaultFor" wins over apps that merely support it.
    for (const m of apps.values()) if ((m.defaultFor || []).includes(ext)) return m.id;
    for (const m of apps.values()) if ((m.fileTypes || []).includes(ext)) return m.id;
    // Linux apps declare MIME types, not extensions: office documents open in an installed office suite.
    const mime = OFFICE_MIME[ext];
    if (mime) for (const m of apps.values()) if (m.kind === 'linux' && (m.mimeTypes || []).includes(mime)) return m.id;
    return null;
  },
  async openFile(path, opts = {}) {
    const id = opts.appId || registry.handlerFor(path);
    if (!id) return null;
    return registry.launch(id, { file: path });
  },
  async launch(id, args = {}) {
    const m = apps.get(id);
    if (!m) {
      console.error(`[registry] unknown app ${id}`);
      return null;
    }
    // Launcher alias (e.g. Musique -> the Lecteur on its music library): launches the target app instead.
    if (m.alias && typeof m.alias.app === 'string' && m.alias.app !== id && apps.has(m.alias.app) && !apps.get(m.alias.app).alias) {
      return registry.launch(m.alias.app, { ...(m.alias.args && typeof m.alias.args === 'object' ? m.alias.args : {}), ...(args || {}) });
    }
    if (m.kind === 'linux') {
      // An external program: its window arrives later through core/features/xwin.js (matched by xapps:match).
      const a = args && typeof args === 'object' ? args : {};
      const files = [...(typeof a.file === 'string' && a.file ? [a.file] : []), ...(Array.isArray(a.files) ? a.files : [])];
      const urls = [...(typeof a.url === 'string' && a.url ? [a.url] : []), ...(Array.isArray(a.urls) ? a.urls : [])];
      try {
        await api.invoke('xapps:launch', id, { files, urls });
      } catch (err) {
        console.warn(`[registry] launching ${id} failed`, err);
        shellServices?.notify?.({ title: i18n.t('registry.linuxFailed', { app: i18n.name(m.name) }), body: String(err?.message || err), appId: id });
      }
      return null;
    }
    if (m.singleInstance && !args?.newWindow) {
      // (a window playing its close animation is gone for the user: open a new one instead)
      const existing = wm.byApp(id).find((w) => !w._closing);
      if (existing) {
        existing.focus();
        const inst = instances.get(existing.id);
        try {
          inst?.hooks?.onRelaunch?.(args);
        } catch (err) {
          console.error(err);
        }
        return existing;
      }
      // A launch of this app is already in flight (e.g. two clicks in the same tick): reuse it.
      if (pendingLaunches.has(id)) {
        const w = await pendingLaunches.get(id);
        if (w && !w._closing) {
          w.focus();
          try {
            instances.get(w.id)?.hooks?.onRelaunch?.(args);
          } catch (err) {
            console.error(err);
          }
        }
        return w;
      }
      const p = registry._open(id, args, m);
      pendingLaunches.set(id, p);
      try {
        return await p;
      } finally {
        pendingLaunches.delete(id);
      }
    }
    return registry._open(id, args, m);
  },
  // Creates the window and runs the app (no single-instance logic).
  async _open(id, args, m) {
    for (const css of m.styles || []) {
      const href = `app://shell/apps/${id}/${css}`;
      if (!loadedStyles.has(href)) {
        loadedStyles.add(href);
        document.head.appendChild(h('link', { rel: 'stylesheet', href }));
      }
    }
    let dict = dictCache.get(id);
    if (!dict) {
      dict = await fetch(`app://shell/apps/${id}/i18n.json`)
        .then((r) => (r.ok ? r.json() : {}))
        .catch(() => ({}));
      dictCache.set(id, dict);
    }
    const w = m.window || {};
    const win = wm.create({
      appId: id,
      title: i18n.name(m.name),
      icon: registry.iconUrl(id),
      width: w.width,
      height: w.height,
      minWidth: w.minWidth,
      minHeight: w.minHeight,
      resizable: w.resizable !== false,
      maximizable: w.maximizable !== false,
      minimizable: w.minimizable !== false,
      titlebar: w.titlebar || 'default',
      background: w.background || 'mica',
      maximized: !!w.maximized,
      className: `app-${id}`,
    });
    const closers = [];
    const langSubs = [];
    const ctx = {
      appId: id,
      win,
      args: args || {},
      manifest: m,
      env,
      get lang() {
        return i18n.lang;
      },
      t: i18n.scoped(dict),
      i18n,
      api,
      ui,
      h,
      icon,
      shell: shellServices,
      settings,
      storage: {
        get: (name, fallback = null) => api.invoke('storage:get', id, name, fallback),
        set: (name, value) => api.invoke('storage:set', id, name, value),
        delete: (name) => api.invoke('storage:delete', id, name),
      },
      appUrl: (rel) => `app://shell/apps/${id}/${rel}`,
      onClose: (fn) => closers.push(fn),
      onLangChange: (fn) => langSubs.push(i18n.on('change', fn)),
    };
    win.on('close', () => {
      instances.delete(win.id);
      for (const fn of closers) {
        try {
          fn();
        } catch (err) {
          console.error(err);
        }
      }
      for (const off of langSubs) off();
    });
    try {
      const mod = await import(`../apps/${id}/${m.entry || 'main.js'}`);
      const launch = mod.default?.launch || mod.launch || mod.default;
      if (typeof launch !== 'function') throw new Error(`App ${id} has no launch(ctx) export`);
      const hooks = (await launch(ctx)) || {};
      instances.set(win.id, { appId: id, hooks, ctx });
      win.on('focus', () => hooks.onFocus?.());
    } catch (err) {
      console.error(`[registry] launching ${id} failed`, err);
      ui.clear(win.body);
      win.body.appendChild(
        h(
          'div',
          { class: 'empty' },
          icon('error_circle', { size: 48 }),
          h('div', { class: 'subtitle' }, i18n.t('registry.crashed', { app: i18n.name(m.name) })),
          h('div', { class: 'caption selectable mono', style: { maxWidth: '90%', whiteSpace: 'pre-wrap' } }, String(err?.stack || err)),
        ),
      );
    }
    return win;
  },
  instance(winId) {
    return instances.get(winId);
  },
};
