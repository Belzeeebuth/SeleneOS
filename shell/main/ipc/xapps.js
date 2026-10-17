'use strict';
// Linux applications (.desktop entries) for the Start menu, search and the Store; see docs/XWINDOWS.md
// ("Desktop entries", "Theme").
//
//   xapps:list ()                    -> [{ id: 'linux.<desktop id>', kind: 'linux', name:{en,fr}, description:{en,fr},
//                                          iconUrl, categories, keywords:{en,fr}, desktopId, startupWMClass }]
//   xapps:launch (id, { files?, urls? }) -> { pid, argv } | { dryRun: true, argv }   (throws ENOENT / ENOEXEC)
//   xapps:match ({ wmClass:[instance,class], gtkAppId, pid }) -> id | null
//   (+xapps:changed)                 the application directories changed (fs.watch, debounced)
//
// Directories (none in dev unless AURORA_XWM / AURORA_XAPPS_HOST / AURORA_REAL_BACKENDS is 1): $AURORA_XAPPS_DIRS (dir1:dir2, tests) or ~/.local/share/applications, /usr/local/share/applications,
// /usr/share/applications, /var/lib/flatpak/exports/share/applications (the first desktop id found wins, so a
// Hidden=true copy in ~/.local masks the system entry). Icons: <data dir>/icons next to each applications dir plus the
// system icon dirs, themes hicolor / Adwaita / Yaru, then /usr/share/pixmaps, absolute Icon= paths; media:// URLs.
//
// Launch: Exec with the field codes and quoting rules of the Desktop Entry spec, no shell, detached in its own
// process group, stdio ignored, env DISPLAY + GTK_THEME (Adwaita or Adwaita:dark from the shell theme) +
// QT_QPA_PLATFORMTHEME=gtk3. In dev (api.DEV) programs really start only for entries read from AURORA_XAPPS_DIRS
// (test fixtures) or when AURORA_XWM=1; otherwise the argv is returned as { dryRun: true }. AURORA_XAPPS_DRYRUN=1
// forces the dry run everywhere.
//
// Theme: ~/.config/gtk-3.0/settings.ini and gtk-4.0/settings.ini get gtk-application-prefer-dark-theme following the
// "theme" setting (outside dev, or in dev with AURORA_XAPPS_DIRS / AURORA_XWM=1 so a developer's HOME is untouched).
// Same rule: gsettings org.gnome.desktop.interface color-scheme (prefer-dark / default) and gtk-theme (Adwaita-dark /
// Adwaita), which Flatpak apps read through xdg-desktop-portal-gtk. Flatpak Exec lines (@@u %U @@ / @@ %F @@ markers)
// keep their markers around the expanded files; an empty marker pair is dropped.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const DESKTOPS = ['Selene', 'X-Selene'];
const ICON_THEMES = ['hicolor', 'Adwaita', 'Yaru'];
const ICON_SIZES = ['48x48', '64x64', 'scalable', '256x256', '32x32', '128x128', '24x24', '16x16'];
const ICON_EXT = ['.svg', '.png'];
const LOCALIZED = ['Name', 'GenericName', 'Comment', 'Keywords'];

// ------------------------------------------------------------------ parsing (pure, unit-tested)
/** Unescape a desktop entry string value (\s \n \t \r \\). */
function unescapeValue(v) {
  return String(v).replace(/\\([sntr\\])/g, (_, c) => ({ s: ' ', n: '\n', t: '\t', r: '\r', '\\': '\\' })[c]);
}
/** Split a list value on unescaped ';' (\; is a literal semicolon), unescaping each item. */
function splitList(v) {
  const out = [];
  let cur = '';
  const s = String(v || '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) {
      const n = s[i + 1];
      if (n === ';') cur += ';';
      else cur += unescapeValue(`\\${n}`);
      i++;
    } else if (c === ';') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  if (cur) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}
/** Text of a .desktop file -> { [group]: { [key]: rawValue } } (comments and blank lines ignored, first key wins). */
function parseDesktop(text) {
  const groups = {};
  let cur = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const g = /^\[([^\[\]]+)\]$/.exec(line);
    if (g) {
      cur = groups[g[1]] || (groups[g[1]] = {});
      continue;
    }
    if (!cur) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z0-9-]+(\[[A-Za-z_@.0-9-]+\])?$/.test(key)) continue;
    if (!(key in cur)) cur[key] = line.slice(eq + 1).trim();
  }
  return groups;
}
/** Localized value for a language ('fr' -> Key[fr_FR] then Key[fr]; 'en' -> Key[en_US], Key[en], then Key). */
function localized(entry, key, lang) {
  const cands = lang === 'en' ? [`${key}[en_US]`, `${key}[en]`, key] : [`${key}[${lang}_${lang.toUpperCase()}]`, `${key}[${lang}]`, key];
  for (const k of cands) if (entry[k] != null && entry[k] !== '') return entry[k];
  return entry[key] ?? '';
}
const isTrue = (v) => v === 'true' || v === '1';

/**
 * Exec value -> argv template (array of strings, field codes still in place). Applies the string escapes first, then
 * the quoting rules: double-quoted arguments where \" \` \$ \\ are escapes; outside quotes, \x keeps x.
 * Throws on an unterminated quote.
 */
function splitExec(exec) {
  const s = unescapeValue(exec);
  const out = [];
  let cur = '';
  let has = false;
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '\\' && i + 1 < s.length && '"`$\\'.includes(s[i + 1])) {
        cur += s[++i];
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') {
      quoted = true;
      has = true;
    } else if (c === ' ' || c === '\t' || c === '\n') {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else if (c === '\\' && i + 1 < s.length) {
      cur += s[++i];
      has = true;
    } else {
      cur += c;
      has = true;
    }
  }
  if (quoted) throw Object.assign(new Error('Unterminated quote in Exec'), { code: 'ENOEXEC' });
  if (has || cur) out.push(cur);
  return out;
}

// (per segment: encodeURI would leave '#' and '?' in file names, which then read as a fragment / query)
const toUrl = (f) => (/^[a-z][a-z0-9+.-]*:/i.test(f) ? f : `file://${path.resolve(f).split('/').map(encodeURIComponent).join('/')}`);
const toPath = (u) => {
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) return u;
  if (/^file:\/\//i.test(u)) {
    try {
      return decodeURIComponent(new URL(u).pathname);
    } catch {
      return null;
    }
  }
  return null;
};

/**
 * Build the argv lists for one launch (pure). app: { exec, icon, name, file }. opts: { files, urls }.
 * Returns an array of argv (several when the program takes one file but several were given).
 */
function buildArgv(app, { files = [], urls = [] } = {}) {
  const tmpl = splitExec(app.exec || '');
  if (!tmpl.length) throw Object.assign(new Error('Empty Exec'), { code: 'ENOEXEC' });
  const items = [...files.map(String), ...urls.map(String)];
  const codes = tmpl.join(' ');
  const wantsList = /%[FU]/.test(codes);
  const wantsOne = /%[fu]/.test(codes);
  const asUrls = (list) => list.map(toUrl);
  const asPaths = (list) => list.map(toPath).filter((p) => p);
  const expand = (one) => {
    const argv = [];
    for (const tok of tmpl) {
      if (tok === '%F' || tok === '%U') {
        argv.push(...(tok === '%U' ? asUrls(items) : asPaths(items)));
        continue;
      }
      if (tok === '%i') {
        if (app.icon) argv.push('--icon', app.icon);
        continue;
      }
      let dropped = false;
      const v = tok.replace(/%(.)/g, (_, c) => {
        switch (c) {
          case '%':
            return '%';
          case 'f': {
            const p = one == null ? null : toPath(one);
            if (p == null) dropped = tok === '%f';
            return p ?? '';
          }
          case 'u':
            if (one == null) dropped = tok === '%u';
            return one == null ? '' : toUrl(one);
          case 'c':
            return app.name || '';
          case 'k':
            return app.file || '';
          default:
            return ''; // deprecated (%d %D %n %N %v %m) or unknown codes are removed
        }
      });
      // A lone code with nothing to substitute disappears; an empty quoted argument "" stays.
      if (dropped || (v === '' && /^(%[a-zA-Z])+$/.test(tok))) continue;
      argv.push(v);
    }
    return argv;
  };
  if (wantsOne && !wantsList && items.length > 1) return items.map((it) => dropEmptyMarkers(expand(it)));
  return [dropEmptyMarkers(expand(items[0] ?? null))];
}
/**
 * Flatpak exports Exec=flatpak run ... --file-forwarding <app> @@u %U @@ (or @@ %F @@): the files between the markers
 * go through the document portal. A marker pair left empty (no file given) is removed. Files are absolute paths and
 * URLs have a scheme, so an expanded file can never be a marker.
 */
function dropEmptyMarkers(argv) {
  if (!argv.includes('@@')) return argv;
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === '@@u' || argv[i] === '@@') && argv[i + 1] === '@@') {
      i++;
      continue;
    }
    out.push(argv[i]);
  }
  return out;
}

/** Desktop id (relative path, '/' -> '-', without .desktop) -> registry id 'linux.<sanitized>' (max 64 chars). */
function appIdOf(desktopId) {
  return `linux.${String(desktopId).replace(/[^A-Za-z0-9._-]/g, '_')}`.slice(0, 64);
}

function onPath(cmd, envPath = process.env.PATH || '') {
  const ok = (f) => {
    try {
      fs.accessSync(f, fs.constants.X_OK);
      return fs.statSync(f).isFile();
    } catch {
      return false;
    }
  };
  if (cmd.includes('/')) return ok(cmd);
  return envPath.split(':').some((d) => d && ok(path.join(d, cmd)));
}

/**
 * Parsed groups + context -> app entry or null (filtered). ctx: { desktopId, file, iconUrl(name) }.
 */
function toEntry(groups, { desktopId, file, iconUrl = () => null, envPath } = {}) {
  const e = groups['Desktop Entry'];
  if (!e) return null;
  if ((e.Type || '') !== 'Application') return null;
  if (isTrue(e.NoDisplay) || isTrue(e.Hidden) || isTrue(e.Terminal)) return null;
  const only = splitList(e.OnlyShowIn);
  if (only.length && !only.some((d) => DESKTOPS.includes(d))) return null;
  if (splitList(e.NotShowIn).some((d) => DESKTOPS.includes(d))) return null;
  if (!e.Exec) return null;
  if (e.TryExec && !onPath(unescapeValue(e.TryExec), envPath)) return null;
  const str = (k, lang) => unescapeValue(localized(e, k, lang));
  const name = { en: str('Name', 'en'), fr: str('Name', 'fr') };
  if (!name.en) return null;
  const comment = (lang) => str('Comment', lang) || str('GenericName', lang);
  const icon = unescapeValue(e.Icon || '');
  return {
    id: appIdOf(desktopId),
    kind: 'linux',
    name,
    description: { en: comment('en'), fr: comment('fr') },
    genericName: { en: str('GenericName', 'en'), fr: str('GenericName', 'fr') },
    iconUrl: icon ? iconUrl(icon) : null,
    categories: splitList(e.Categories),
    keywords: { en: splitList(localized(e, 'Keywords', 'en')), fr: splitList(localized(e, 'Keywords', 'fr')) },
    desktopId,
    startupWMClass: e.StartupWMClass ? unescapeValue(e.StartupWMClass) : null,
    mimeTypes: splitList(e.MimeType),
    // main-process only (stripped from xapps:list)
    _exec: e.Exec,
    _icon: icon,
    _path: e.Path ? unescapeValue(e.Path) : '',
    _file: file,
  };
}

/** settings.ini text -> same text with gtk-application-prefer-dark-theme set in [Settings]. */
function setIniDark(text, dark) {
  const val = `gtk-application-prefer-dark-theme=${dark ? 1 : 0}`;
  const lines = String(text || '').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  let start = lines.findIndex((l) => l.trim() === '[Settings]');
  if (start < 0) {
    if (lines.length) lines.push('');
    lines.push('[Settings]', val);
    return `${lines.join('\n')}\n`;
  }
  let end = lines.findIndex((l, i) => i > start && /^\s*\[/.test(l));
  if (end < 0) end = lines.length;
  const k = lines.findIndex((l, i) => i > start && i < end && /^\s*gtk-application-prefer-dark-theme\s*=/.test(l));
  if (k >= 0) lines[k] = val;
  else lines.splice(start + 1, 0, val);
  return `${lines.join('\n')}\n`;
}

/** gsettings argv lists for the theme (Flatpak apps follow color-scheme through xdg-desktop-portal-gtk). */
function gsettingsArgs(dark) {
  return [
    ['set', 'org.gnome.desktop.interface', 'color-scheme', dark ? 'prefer-dark' : 'default'],
    ['set', 'org.gnome.desktop.interface', 'gtk-theme', dark ? 'Adwaita-dark' : 'Adwaita'],
  ];
}

// ------------------------------------------------------------------ module
function register(api) {
  const DEV = !!api.DEV;
  const fixtureDirs = (process.env.AURORA_XAPPS_DIRS || '').split(':').filter(Boolean).map((d) => path.resolve(d));
  const home = os.homedir();
  // Dev without fixtures and without the X window manager: no host applications, so the shell (and its tests) do not
  // depend on whatever the development machine has installed. AURORA_XAPPS_HOST=1 lists them anyway.
  const hostInDev = process.env.AURORA_XWM === '1' || process.env.AURORA_XAPPS_HOST === '1' || process.env.AURORA_REAL_BACKENDS === '1';
  const appDirs = fixtureDirs.length
    ? fixtureDirs
    : DEV && !hostInDev
      ? []
      : [path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'applications'), '/usr/local/share/applications', '/usr/share/applications', '/var/lib/flatpak/exports/share/applications', path.join(home, '.local', 'share', 'flatpak', 'exports', 'share', 'applications')];
  const iconBases = [...new Set([...appDirs.map((d) => path.join(path.dirname(d), 'icons')), path.join(home, '.local', 'share', 'icons'), path.join(home, '.icons'), '/usr/local/share/icons', '/usr/share/icons'])];
  const pixmaps = [...appDirs.map((d) => path.join(path.dirname(d), 'pixmaps')), '/usr/share/pixmaps'];
  const mayWriteHome = !DEV || fixtureDirs.length > 0 || process.env.AURORA_XWM === '1';
  const dryRunAll = process.env.AURORA_XAPPS_DRYRUN === '1';

  const mediaUrl = (abs) => `media://local${abs.split('/').map(encodeURIComponent).join('/')}`;
  const exists = (f) => {
    try {
      return fs.statSync(f).isFile();
    } catch {
      return false;
    }
  };
  const iconCache = new Map();
  function iconUrl(name) {
    if (iconCache.has(name)) return iconCache.get(name);
    let found = null;
    if (path.isAbsolute(name)) {
      if (exists(name) && /\.(png|svg|jpe?g|webp|ico)$/i.test(name)) found = name;
    } else if (/^[A-Za-z0-9._+-]{1,200}$/.test(name)) {
      const base = name.replace(/\.(png|svg|xpm)$/i, '');
      outer: for (const theme of ICON_THEMES) {
        for (const root of iconBases) {
          const tdir = path.join(root, theme);
          if (!fs.existsSync(tdir)) continue;
          for (const size of ICON_SIZES) {
            for (const cat of ['apps', 'legacy', 'mimetypes', 'devices', 'places']) {
              for (const ext of size === 'scalable' ? ['.svg'] : ICON_EXT) {
                const f = path.join(tdir, size, cat, base + ext);
                if (exists(f)) {
                  found = f;
                  break outer;
                }
              }
            }
          }
        }
      }
      if (!found) for (const d of pixmaps) for (const ext of ICON_EXT) if (!found && exists(path.join(d, base + ext))) found = path.join(d, base + ext);
    }
    const url = found ? mediaUrl(found) : null;
    iconCache.set(name, url);
    return url;
  }

  let cache = null; // { list, byId }
  function scan() {
    iconCache.clear();
    const seen = new Set();
    const list = [];
    const byId = new Map();
    const walk = (root, dir, depth) => {
      let names = [];
      try {
        names = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const d of names) {
        const full = path.join(dir, d.name);
        if (d.isDirectory() && depth < 2) walk(root, full, depth + 1);
        else if (d.name.endsWith('.desktop') && (d.isFile() || d.isSymbolicLink())) {
          const desktopId = path.relative(root, full).replace(/\.desktop$/, '').split(path.sep).join('-');
          if (seen.has(desktopId)) continue;
          seen.add(desktopId);
          let text;
          try {
            if (fs.statSync(full).size > 256 * 1024) continue;
            text = fs.readFileSync(full, 'utf8');
          } catch {
            continue;
          }
          const entry = toEntry(parseDesktop(text), { desktopId, file: full, iconUrl });
          if (entry && !byId.has(entry.id)) {
            entry._fixture = fixtureDirs.some((f) => full.startsWith(f + path.sep));
            byId.set(entry.id, entry);
            list.push(entry);
          }
        }
      }
    };
    for (const d of appDirs) walk(d, d, 0);
    cache = { list, byId };
    return cache;
  }
  const get = () => cache || scan();
  const pub = (e) => {
    const out = {};
    for (const [k, v] of Object.entries(e)) if (!k.startsWith('_')) out[k] = v;
    return out;
  };

  // ---------------------------------------------------------------- watching
  let debounce = null;
  const changed = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      cache = null;
      api.broadcast('xapps:changed', {});
    }, 400);
  };
  const watchers = new Map();
  function nearestDir(d) {
    let t = d;
    for (let i = 0; i <= 4; i++, t = path.dirname(t)) {
      try {
        if (fs.statSync(t).isDirectory()) return t;
      } catch {}
      if (path.dirname(t) === t) break;
    }
    return null;
  }
  function watchDirs() {
    for (const d of appDirs) {
      if (watchers.has(d)) continue;
      // A missing directory is watched through its nearest existing ancestor (up to 4 levels: a fresh
      // ~/.local/share/flatpak/exports/share/applications appears with the first Flatpak install) until it appears.
      const target = nearestDir(d);
      if (!target) continue;
      try {
        const w = fs.watch(target, { persistent: false }, () => {
          if (target === d) changed();
          else if (nearestDir(d) !== target) {
            w.close();
            watchers.delete(d);
            if (fs.existsSync(d)) changed();
            watchDirs();
          }
        });
        w.on('error', () => {});
        watchers.set(d, w);
      } catch {}
    }
  }
  watchDirs();

  // ---------------------------------------------------------------- theme
  const isDark = () => {
    try {
      return api.settings?.get('theme') === 'dark';
    } catch {
      return false;
    }
  };
  function syncGtk(dark) {
    if (!mayWriteHome) return;
    for (const v of ['gtk-3.0', 'gtk-4.0']) {
      const f = path.join(home, '.config', v, 'settings.ini');
      try {
        const old = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
        const next = setIniDark(old, dark);
        if (next === old) continue;
        fs.mkdirSync(path.dirname(f), { recursive: true });
        const tmp = `${f}.tmp-${process.pid}`;
        fs.writeFileSync(tmp, next);
        fs.renameSync(tmp, f);
      } catch (err) {
        console.warn('[xapps] gtk settings', f, err?.message || err);
      }
    }
    syncGsettings(dark);
  }
  // Same rule as settings.ini (mayWriteHome); one gsettings run at a time, the latest theme wins.
  let gsBusy = false;
  let gsWanted = null;
  function syncGsettings(dark) {
    gsWanted = dark;
    if (gsBusy) return;
    gsBusy = true;
    const runAll = (list, done) => {
      if (!list.length) return done();
      let child;
      try {
        child = spawn('gsettings', list[0], { stdio: 'ignore' });
      } catch {
        return done();
      }
      // A missing gsettings emits 'error' then 'close': only the first one counts.
      let ended = false;
      child.once('error', () => !ended && ((ended = true), done()));
      child.once('close', () => !ended && ((ended = true), runAll(list.slice(1), done)));
    };
    const want = gsWanted;
    runAll(gsettingsArgs(want), () => {
      gsBusy = false;
      if (gsWanted !== want) syncGsettings(gsWanted);
    });
  }
  let lastDark = isDark();
  syncGtk(lastDark);
  // The main process has no settings event: follow the settings:changed broadcast (additive wrapper).
  const broadcast = api.broadcast;
  api.broadcast = function (channel, payload) {
    if (channel === 'settings:changed') {
      const dark = payload?.all?.theme === 'dark';
      if (dark !== lastDark) {
        lastDark = dark;
        syncGtk(dark);
      }
    }
    return broadcast.apply(this, arguments);
  };

  // ---------------------------------------------------------------- launch
  const launched = new Map(); // pid -> appId
  function launchEnv() {
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (/^(ELECTRON_|CHROME_|NODE_OPTIONS$|GOOGLE_API_KEY$)/.test(k)) delete env[k];
    env.DISPLAY = process.env.DISPLAY || ':0';
    env.GTK_THEME = lastDark ? 'Adwaita:dark' : 'Adwaita';
    env.QT_QPA_PLATFORMTHEME = env.QT_QPA_PLATFORMTHEME || 'gtk3';
    return env;
  }
  function spawnOne(argv, cwd, appId) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(argv[0], argv.slice(1), { detached: true, stdio: 'ignore', env: launchEnv(), cwd });
      } catch (err) {
        reject(api.error(`Cannot start ${argv[0]}: ${err.message}`, err.code || 'ENOENT'));
        return;
      }
      child.once('error', (err) => reject(api.error(`Cannot start ${argv[0]}: ${err.message}`, err.code || 'ENOENT')));
      child.once('spawn', () => {
        if (child.pid) {
          launched.set(child.pid, appId);
          if (launched.size > 500) launched.delete(launched.keys().next().value);
        }
        child.unref();
        resolve(child.pid);
      });
    });
  }

  api.handle('xapps:list', async () => get().list.map(pub));

  api.handle('xapps:launch', async (id, opts = {}) => {
    let e = get().byId.get(id);
    if (!e) e = scan().byId.get(id); // just installed: the watcher may not have fired yet
    if (!e) throw api.error(`Unknown application ${id}`, 'ENOENT');
    const o = opts && typeof opts === 'object' ? opts : {};
    // Files must be absolute paths: a relative "--option" would otherwise reach the program as an option.
    const files = (Array.isArray(o.files) ? o.files : []).filter((f) => typeof f === 'string' && path.isAbsolute(f)).slice(0, 100);
    const urls = (Array.isArray(o.urls) ? o.urls : []).filter((u) => typeof u === 'string' && /^[a-z][a-z0-9+.-]*:/i.test(u)).slice(0, 100);
    const argvs = buildArgv({ exec: e._exec, icon: e._icon, name: e.name.en, file: e._file }, { files, urls });
    const dry = dryRunAll || (DEV && !e._fixture && process.env.AURORA_XWM !== '1');
    if (dry) return { dryRun: true, argv: argvs[0], argvs };
    let cwd = e._path && fs.existsSync(e._path) ? e._path : home;
    if (!fs.existsSync(cwd)) cwd = '/';
    const pids = [];
    for (const argv of argvs) pids.push(await spawnOne(argv, cwd, e.id));
    return { pid: pids[0], pids, argv: argvs[0] };
  });

  function parentPid(pid) {
    try {
      const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const rest = st.slice(st.lastIndexOf(')') + 2).split(' ');
      return Number(rest[1]) || 0;
    } catch {
      return 0;
    }
  }
  function match(q = {}) {
    // 0. a window the shell opened itself (the Navigateur's sign-in pop-ups, main/lib/own-windows.js)
    const own = require('../lib/own-windows.js').appFor(q.id);
    if (own) return own;
    const { list, byId } = get();
    const wm = Array.isArray(q.wmClass) ? q.wmClass.filter((s) => typeof s === 'string' && s) : [];
    const lc = wm.map((s) => s.toLowerCase());
    // 1. StartupWMClass (exact, then case-insensitive)
    let hit = list.find((e) => e.startupWMClass && wm.includes(e.startupWMClass)) || list.find((e) => e.startupWMClass && lc.includes(e.startupWMClass.toLowerCase()));
    if (hit) return hit.id;
    // 2. _GTK_APPLICATION_ID = desktop id
    if (typeof q.gtkAppId === 'string' && q.gtkAppId) {
      hit = byId.get(appIdOf(q.gtkAppId)) || list.find((e) => e.desktopId.toLowerCase() === q.gtkAppId.toLowerCase());
      if (hit) return hit.id;
    }
    // 3. WM class / instance = desktop id (or its last reverse-DNS component), case-insensitive
    if (lc.length) {
      hit = list.find((e) => lc.includes(e.desktopId.toLowerCase())) || list.find((e) => lc.includes(e.desktopId.split('.').pop().toLowerCase()));
      if (hit) return hit.id;
    }
    // 4. the launched pid, or one of its ancestors
    let pid = Number(q.pid) || 0;
    for (let i = 0; pid > 1 && i < 12; i++) {
      const id = launched.get(pid);
      if (id && byId.has(id)) return id;
      pid = parentPid(pid);
    }
    return null;
  }
  api.handle('xapps:match', async (q) => match(q && typeof q === 'object' ? q : {}));
}

module.exports = register;
module.exports.parsers = { parseDesktop, splitList, unescapeValue, localized, splitExec, buildArgv, appIdOf, toEntry, setIniDark, gsettingsArgs, dropEmptyMarkers };
