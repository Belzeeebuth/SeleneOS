'use strict';
// Session D-Bus integration: desktop notifications (org.freedesktop.Notifications) and the system tray
// (StatusNotifierWatcher + host), through the helper rootfs/usr/lib/aurora/helpers/aurora-sessionbus (python3-dbus,
// JSON lines; see its header). The renderer side is core/features/dbus-notify.js and core/features/tray.js.
//
//   events   notify:desktop ({ id, appName, appId, title, body, icon, image, actions: [{ key, label }], urgency,
//                              timeout, silent, transient, resident, replaces })
//            notify:desktopClose ({ id })                   the app called CloseNotification
//            tray:items ([{ key, id, title, status, icon, attention, tooltip: { title, body }, menu, itemIsMenu }])
//   handlers notify:desktopClosed (id, reason)  1 expired, 2 dismissed  -> NotificationClosed
//            notify:desktopAction (id, key)                             -> ActionInvoked
//            tray:list -> items        tray:activate|secondary (key, x, y)    tray:scroll (key, delta, orientation)
//            tray:menu (key) -> [menu entries]              tray:menuEvent (key, menuId)
//            sessionbus:status -> { running, notifications, tray, screensaver, power }
// Idle inhibitors (org.freedesktop.ScreenSaver + org.freedesktop.PowerManagement.Inhibit, owned by the helper):
//   event    power:inhibitors ({ count, apps: [names], list: [{ cookie, app, reason, kind: 'screen'|'power' }] })
//            power:userActivity ()                          SimulateUserActivity: the idle timers start again
//   handler  power:inhibitors -> the same object
//   core/features/power.js and lock.js treat count > 0 as activity (no screen off, lock or idle sleep). Chromium's own
//   wake locks (videos in the shell's webviews, the Navigateur) go through the bus to the helper like any other app's;
//   nothing in the shell calls Electron's powerSaveBlocker (it would reach the helper the same way).
// Icons: names resolved in the icon theme (the item's IconThemePath first) -> media:// URLs; pixmaps -> PNG data URLs.
// Dev mode: the helper is not started (no fixture items in the bar) unless AURORA_SESSIONBUS=1 (tests run it on a
// private dbus-daemon: DBUS_SESSION_BUS_ADDRESS).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const HELPER = process.env.AURORA_SESSIONBUS_HELPER || '/usr/lib/aurora/helpers/aurora-sessionbus';
const ICON_THEMES = ['Yaru', 'Adwaita', 'hicolor'];
const ICON_SIZES = ['scalable', '32x32', '24x24', '22x22', '48x48', '16x16', '64x64', '256x256', 'symbolic'];
const ICON_CATS = ['status', 'apps', 'panel', 'devices', 'actions', 'notifications', 'emblems', 'categories', 'mimetypes', 'places'];
const KEY_RE = /^[A-Za-z0-9_.:\-/]{1,300}$/;

const mediaUrl = (abs) => `media://local${abs.split('/').map(encodeURIComponent).join('/')}`;
const isFile = (f) => {
  try {
    return fs.statSync(f).isFile();
  } catch {
    return false;
  }
};

/** Icon name or absolute path -> absolute file, looked up in `extra` dirs (IconThemePath), then the themes. */
function findIcon(name, { bases, extra = [] } = {}) {
  if (!name) return null;
  if (path.isAbsolute(name)) return isFile(name) && /\.(png|svg|jpe?g|webp|ico)$/i.test(name) ? name : null;
  if (!/^[A-Za-z0-9._+-]{1,200}$/.test(name)) return null;
  const base = name.replace(/\.(png|svg|xpm)$/i, '');
  for (const d of extra) {
    for (const ext of ['.svg', '.png']) if (isFile(path.join(d, base + ext))) return path.join(d, base + ext);
    // a themed tree inside IconThemePath (hicolor/22x22/apps/x.png)
    for (const size of ICON_SIZES) for (const cat of ICON_CATS) for (const ext of ['.svg', '.png']) {
      const f = path.join(d, 'hicolor', size, cat, base + ext);
      if (isFile(f)) return f;
    }
  }
  for (const theme of ICON_THEMES) {
    for (const root of bases) {
      const tdir = path.join(root, theme);
      if (!fs.existsSync(tdir)) continue;
      for (const size of ICON_SIZES) for (const cat of ICON_CATS) for (const ext of size === 'scalable' || size === 'symbolic' ? ['.svg'] : ['.png', '.svg']) {
        const f = path.join(tdir, size, cat, base + ext);
        if (isFile(f)) return f;
      }
    }
  }
  for (const root of bases) for (const ext of ['.png', '.svg']) {
    const f = path.join(path.dirname(root), 'pixmaps', base + ext);
    if (isFile(f)) return f;
  }
  return null;
}

/** Helper notification -> renderer payload (pure; unit-tested). */
function toNotification(n, { iconUrl = () => null, entry = () => null } = {}) {
  const app = entry(n.entry) || null; // desktop entry named by the app (Flatpak apps through the portal)
  const icon = iconUrl(n.icon) || app?.icon || null;
  const image = n.image || iconUrl(n.imagePath) || null;
  const timeout = n.urgency === 2 ? 0 : n.timeout > 0 ? Math.max(2000, Math.min(n.timeout, 60000)) : n.timeout === 0 ? 0 : 6000;
  return {
    id: n.id,
    appName: n.app || app?.name || '',
    appId: app?.id || null,
    title: n.summary || n.app || '',
    body: n.body || '',
    // the image is the notification's own picture: shown as its icon when the app gave none, as a preview otherwise
    icon: icon || image || null,
    image: icon && image ? image : null,
    actions: (n.actions || []).map(([key, label]) => ({ key: String(key), label: String(label) })),
    urgency: n.urgency,
    timeout,
    silent: !!n.silent || n.urgency === 0,
    transient: !!n.transient,
    resident: !!n.resident,
    replaces: !!n.replaces,
  };
}

/** Helper tray item -> renderer payload (pure; unit-tested): Passive items are hidden by the renderer. */
function toItem(it, { iconUrl = () => null } = {}) {
  const extra = it.themePath ? [it.themePath] : [];
  const normal = it.iconPng || iconUrl(it.icon, extra) || null;
  const attention = it.status === 'NeedsAttention' ? it.attentionPng || iconUrl(it.attentionIcon, extra) || null : null;
  return {
    key: it.key,
    id: it.id,
    title: it.title || it.tooltip?.title || it.id || '',
    status: ['Passive', 'Active', 'NeedsAttention'].includes(it.status) ? it.status : 'Active',
    icon: attention || normal,
    tooltip: { title: it.tooltip?.title || it.title || it.id || '', body: it.tooltip?.body || '' },
    menu: !!it.menu,
    itemIsMenu: !!it.itemIsMenu,
  };
}

const parsers = { findIcon, toNotification, toItem };

function err(message, code) {
  return Object.assign(new Error(message), { code });
}

function register(api) {
  const real = !api.DEV || process.env.AURORA_SESSIONBUS === '1';
  const home = os.homedir();
  const dataDirs = [process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), path.join(home, '.local', 'share', 'flatpak', 'exports', 'share'), '/var/lib/flatpak/exports/share', ...(process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter(Boolean)];
  const bases = [...new Set([path.join(home, '.icons'), ...dataDirs.map((d) => path.join(d, 'icons'))])];
  const cache = new Map();
  const iconUrl = (name, extra = []) => {
    if (!name) return null;
    const k = `${extra.join(':')}|${name}`;
    if (!cache.has(k)) {
      const f = findIcon(name, { bases, extra: extra.filter((d) => path.isAbsolute(d)) });
      cache.set(k, f ? mediaUrl(f) : null);
      if (cache.size > 500) cache.delete(cache.keys().next().value);
    }
    return cache.get(k);
  };
  const entryCache = new Map();
  const entry = (id) => {
    id = String(id || '').replace(/\.desktop$/, '');
    if (!/^[A-Za-z0-9._-]{1,200}$/.test(id)) return null;
    if (entryCache.has(id)) return entryCache.get(id);
    let found = null;
    for (const d of dataDirs) {
      const f = path.join(d, 'applications', `${id}.desktop`);
      let text = null;
      try {
        text = fs.readFileSync(f, 'utf8');
      } catch {
        continue;
      }
      const lang = String(process.env.LANG || 'en').slice(0, 2);
      const get = (k) => (text.match(new RegExp(`^${k}\\[${lang}\\]=(.*)$`, 'm')) || text.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1]?.trim();
      found = { id, name: get('Name') || id, icon: iconUrl(get('Icon') || '') };
      break;
    }
    entryCache.set(id, found);
    return found;
  };

  let child = null;
  let seq = 0;
  const pending = new Map();
  let items = [];
  const NONE = { notifications: false, tray: false, screensaver: false, power: false };
  let ready = { ...NONE };
  const NO_INHIBITORS = { count: 0, apps: [], list: [] };
  let inhibitors = NO_INHIBITORS;
  const setInhibitors = (m) => {
    const list = Array.isArray(m?.list) ? m.list.slice(0, 256).map((i) => ({ cookie: Number(i.cookie) || 0, app: String(i.app || ''), reason: String(i.reason || ''), kind: i.kind === 'power' ? 'power' : 'screen' })) : [];
    const next = { count: Math.max(0, Number(m?.count) || 0), apps: Array.isArray(m?.apps) ? m.apps.map(String).slice(0, 50) : [], list };
    if (JSON.stringify(next) === JSON.stringify(inhibitors)) return;
    inhibitors = next;
    api.broadcast('power:inhibitors', inhibitors);
  };
  let restarts = 0;
  let stopping = false;

  function start() {
    if (!real || child || stopping) return child;
    const python = process.env.AURORA_SESSIONBUS_PYTHON || '/usr/bin/python3';
    if (!fs.existsSync(HELPER)) return null;
    child = spawn(python, ['-I', HELPER], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, LC_ALL: 'C.UTF-8', AURORA_VERSION: String(api.env?.version || '') } });
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try {
          onMessage(JSON.parse(line));
        } catch {}
      }
    });
    child.stderr.on('data', (d) => console.warn('[sessionbus]', String(d).trim()));
    child.on('error', () => {});
    child.on('exit', () => {
      child = null;
      for (const p of pending.values()) p.reject(err('Session bus helper stopped', 'EHELPER'));
      pending.clear();
      if (items.length) {
        items = [];
        api.broadcast('tray:items', []);
      }
      ready = { ...NONE };
      setInhibitors(NO_INHIBITORS); // the helper's cookies went with it
      if (restarts++ < 5 && !stopping) setTimeout(start, 2000);
    });
    return child;
  }

  function onMessage(m) {
    if (m.id != null && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.ok) p.resolve(m.result);
      else p.reject(err(m.error || m.code, m.code || 'EFAIL'));
      return;
    }
    if (m.event === 'ready') {
      ready = { notifications: !!m.notifications, tray: !!m.tray, screensaver: !!m.screensaver, power: !!m.power };
      if (!m.notifications) console.warn('[sessionbus] org.freedesktop.Notifications is owned by another program');
      if (!m.tray) console.warn('[sessionbus] org.kde.StatusNotifierWatcher is owned by another program');
      if (!m.screensaver) console.warn('[sessionbus] org.freedesktop.ScreenSaver is owned by another program: its inhibitors are not seen');
      if (!m.power) console.warn('[sessionbus] org.freedesktop.PowerManagement is owned by another program: its inhibitors are not seen');
    } else if (m.event === 'inhibitors') {
      setInhibitors(m);
    } else if (m.event === 'activity') {
      api.broadcast('power:userActivity', {});
    } else if (m.event === 'notify' && m.n) {
      api.broadcast('notify:desktop', toNotification(m.n, { iconUrl, entry }));
    } else if (m.event === 'notify-close') {
      api.broadcast('notify:desktopClose', { id: m.id });
    } else if (m.event === 'items') {
      items = (m.items || []).map((it) => toItem(it, { iconUrl }));
      api.broadcast('tray:items', items);
    }
  }

  function call(cmd, args = {}, timeout = 8000) {
    const c = start();
    if (!c) return Promise.reject(err('The session bus helper is not running', 'ENOTSUP'));
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(err('The application did not answer', 'ETIMEDOUT'));
      }, timeout);
      pending.set(id, { resolve: (v) => (clearTimeout(timer), resolve(v)), reject: (e) => (clearTimeout(timer), reject(e)) });
      c.stdin.write(`${JSON.stringify({ id, cmd, ...args })}\n`);
    });
  }
  const key = (k) => {
    if (typeof k !== 'string' || !KEY_RE.test(k)) throw err('Invalid tray item', 'EINVAL');
    return k;
  };
  const int = (v, max = 100000) => Math.max(-max, Math.min(max, Math.round(Number(v) || 0)));

  api.handle('sessionbus:status', () => ({ running: !!child, ...ready }));
  api.handle('notify:desktopClosed', (id, reason) => (child ? call('closed', { nid: int(id, 2 ** 31), reason: reason === 1 ? 1 : 2 }) : false));
  api.handle('notify:desktopAction', (id, k) => call('action', { nid: int(id, 2 ** 31), key: String(k ?? '').slice(0, 200) }));
  api.handle('tray:list', () => items);
  api.handle('power:inhibitors', () => inhibitors);
  api.handle('tray:activate', (k, x, y) => call('activate', { item: key(k), x: int(x), y: int(y) }));
  api.handle('tray:secondary', (k, x, y) => call('secondary', { item: key(k), x: int(x), y: int(y) }));
  api.handle('tray:context', (k, x, y) => call('context', { item: key(k), x: int(x), y: int(y) }));
  api.handle('tray:scroll', (k, delta, orientation) => call('scroll', { item: key(k), delta: int(delta, 1000), orientation: orientation === 'horizontal' ? 'horizontal' : 'vertical' }));
  api.handle('tray:menu', async (k) => {
    const r = await call('menu', { item: key(k) });
    const fix = (e) => ({ ...e, icon: e.icon ? iconUrl(e.icon) : null, children: (e.children || []).map(fix) });
    return (r?.items || []).map(fix);
  });
  api.handle('tray:menuEvent', (k, mid) => call('menu-event', { item: key(k), mid: int(mid, 2 ** 31) }));

  start();
  return {
    stop() {
      stopping = true;
      child?.kill();
    },
  };
}

module.exports = register;
module.exports.parsers = parsers;
