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
//   "hidden": false,                    // hide from Start "All apps"
//   "liveOnly": false                   // only in the live session (installer)
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
let shellServices = null;

export function setShellServices(s) {
  shellServices = s;
}

export const registry = {
  async load() {
    const list = await api.invoke('apps:list');
    apps.clear();
    for (const m of list) apps.set(m.id, m);
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
    return m?.icon ? `app://shell/apps/${id}/${m.icon}` : 'app://shell/assets/app-default.svg';
  },
  running(id) {
    return wm.byApp(id);
  },
  handlerFor(path) {
    const ext = (/\.[^./]+$/.exec(path || '')?.[0] || '').toLowerCase();
    const def = settings.get('defaultApps')?.[ext];
    if (def && apps.has(def)) return def;
    for (const m of apps.values()) if ((m.fileTypes || []).includes(ext)) return m.id;
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
    }
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
