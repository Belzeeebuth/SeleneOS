'use strict';
// XDG autostart (Desktop Application Autostart spec 0.5) for the Selene session.
//
//   autostart:run   -> { started: [{ id, argv }], skipped: [{ id, reason }] }
//       Called by the shell once it is ready (core/features/tray.js, on the 'ready' event): starts the enabled entries
//       of ~/.config/autostart and $XDG_CONFIG_DIRS/autostart (/etc/xdg/autostart) once per sign-in (marker in
//       $XDG_RUNTIME_DIR, so a shell restart after a crash does not start them twice).
//   An entry in a more important directory (user first) replaces the files with the same name. Skipped: Hidden=true,
//   X-GNOME-Autostart-enabled=false (what Moniteur système > Démarrage writes), OnlyShowIn / NotShowIn against
//   XDG_CURRENT_DESKTOP (+ Selene, X-Selene), TryExec or the program not found, and DENY: things Selene already runs
//   (aurora-xsession starts spice-vdagent and xdg-user-dirs-update, Paramètres runs Orca) or that do not fit here
//   (other desktops' applets for network, Bluetooth, printers, updates; other tray / notification daemons).
// Dev mode: nothing runs unless AURORA_AUTOSTART=1 (tests, with XDG_CONFIG_HOME / XDG_CONFIG_DIRS fixtures).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { parsers: X } = require('./xapps.js');

const DENY = new Set([
  'spice-vdagent', 'xdg-user-dirs', 'user-dirs-update-gtk', 'orca-autostart',
  'nm-applet', 'blueman', 'org.blueman.Applet', 'print-applet', 'system-config-printer-applet', 'update-notifier',
  'pulseaudio', 'snixembed', 'xembedsniproxy', 'org.kde.xembedsniproxy', 'dunst', 'xfce4-notifyd', 'mate-notification-daemon',
  'gnome-shell-overrides-migration', 'org.gnome.SettingsDaemon.XSettings', 'xscreensaver', 'light-locker', 'xfce4-power-manager',
]);

function isExecutable(f) {
  try {
    fs.accessSync(f, fs.constants.X_OK);
    return fs.statSync(f).isFile();
  } catch {
    return false;
  }
}
function whichIn(prog, envPath) {
  if (!prog) return null;
  if (prog.includes('/')) return path.isAbsolute(prog) && isExecutable(prog) ? prog : null;
  for (const d of String(envPath || '').split(':').filter(Boolean)) if (isExecutable(path.join(d, prog))) return path.join(d, prog);
  return null;
}

/**
 * Pure planning (unit-tested): which entries to start.
 * dirs: most important first ([~/.config/autostart, /etc/xdg/autostart, …]); read(file) -> text | null;
 * list(dir) -> file names; desktops: XDG_CURRENT_DESKTOP names; which(prog) -> path | null.
 */
function plan({ dirs, read, list, desktops, which, deny = DENY }) {
  const seen = new Set();
  const started = [];
  const skipped = [];
  const names = new Set(desktops.map((d) => d.toLowerCase()));
  for (const dir of dirs) {
    let files = [];
    try {
      files = list(dir).filter((f) => f.endsWith('.desktop')).sort();
    } catch {}
    for (const f of files) {
      if (seen.has(f)) continue; // a more important directory already decided
      seen.add(f);
      const id = f.replace(/\.desktop$/, '');
      const skip = (reason) => skipped.push({ id, reason });
      const e = X.parseDesktop(read(path.join(dir, f)) || '')['Desktop Entry'];
      if (!e) {
        skip('invalid');
        continue;
      }
      if (/^true$/i.test(e.Hidden || '')) {
        skip('hidden');
        continue;
      }
      if (/^false$/i.test(e['X-GNOME-Autostart-enabled'] || '')) {
        skip('disabled');
        continue;
      }
      if ((e.Type || 'Application') !== 'Application') {
        skip('type');
        continue;
      }
      const only = X.splitList(e.OnlyShowIn || '').map((d) => d.toLowerCase());
      const not = X.splitList(e.NotShowIn || '').map((d) => d.toLowerCase());
      if ((only.length && !only.some((d) => names.has(d))) || not.some((d) => names.has(d))) {
        skip('desktop');
        continue;
      }
      if (deny.has(id)) {
        skip('deny');
        continue;
      }
      if (e.TryExec && !which(X.unescapeValue(e.TryExec))) {
        skip('tryexec');
        continue;
      }
      let argv;
      try {
        argv = X.buildArgv({ exec: e.Exec || '', icon: e.Icon || '', name: e.Name || id, file: path.join(dir, f) })[0];
      } catch {
        skip('exec');
        continue;
      }
      if (!argv?.length || !which(argv[0])) {
        skip('missing');
        continue;
      }
      started.push({ id, argv, cwd: e.Path || null, terminal: /^true$/i.test(e.Terminal || '') });
    }
  }
  return { started, skipped };
}

function register(api) {
  let done = null;
  const configHome = () => process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  const runtime = process.env.XDG_RUNTIME_DIR;
  const marker = runtime ? path.join(runtime, 'aurora', 'autostart.done') : null;

  api.handle('autostart:run', () => {
    if (done) return done;
    if (api.DEV && process.env.AURORA_AUTOSTART !== '1') return (done = { started: [], skipped: [], dev: true });
    if (marker && fs.existsSync(marker) && process.env.AURORA_AUTOSTART !== '1') return (done = { started: [], skipped: [], already: true });
    const dirs = [configHome(), ...(process.env.XDG_CONFIG_DIRS || '/etc/xdg').split(':').filter(Boolean)].map((d) => path.join(d, 'autostart'));
    const desktops = [...(process.env.XDG_CURRENT_DESKTOP || '').split(':').filter(Boolean), 'Selene', 'X-Selene', 'Aurora'];
    const envPath = process.env.PATH || '/usr/local/bin:/usr/bin:/bin';
    const r = plan({
      dirs,
      read: (f) => {
        try {
          return fs.readFileSync(f, 'utf8');
        } catch {
          return null;
        }
      },
      list: (d) => fs.readdirSync(d),
      desktops,
      which: (p) => whichIn(p, envPath),
    });
    const started = [];
    // same clean environment as apps started from the menu (xapps.js launchEnv): no Electron / Node variables
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (/^(ELECTRON_|CHROME_|NODE_OPTIONS$|GOOGLE_API_KEY$)/.test(k)) delete env[k];
    env.QT_QPA_PLATFORMTHEME = env.QT_QPA_PLATFORMTHEME || 'gtk3';
    for (const it of r.started) {
      if (it.terminal) {
        r.skipped.push({ id: it.id, reason: 'terminal' });
        continue;
      }
      try {
        const cwd = it.cwd && fs.existsSync(it.cwd) ? it.cwd : os.homedir();
        const child = spawn(it.argv[0], it.argv.slice(1), { cwd, env, detached: true, stdio: 'ignore' });
        child.on('error', () => {});
        child.unref();
        started.push({ id: it.id, argv: it.argv });
      } catch {
        r.skipped.push({ id: it.id, reason: 'spawn' });
      }
    }
    if (marker) {
      try {
        fs.mkdirSync(path.dirname(marker), { recursive: true, mode: 0o700 });
        fs.writeFileSync(marker, `${Date.now()}\n`);
      } catch {}
    }
    done = { started, skipped: r.skipped };
    if (api.DEV) console.log('[autostart]', JSON.stringify(done));
    return done;
  });
}

module.exports = register;
module.exports.parsers = { plan, DENY };
