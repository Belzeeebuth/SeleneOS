'use strict';
// Selene Shell — Electron main process.
// Modes:  --mode=shell (desktop session, default) | --mode=greeter (login screen)
// Flags:  --dev (windowed, mock backends where system tools are missing)
//         --open=<appId>[,<appId>]  launch apps at startup (testing)
//         --size=WxH  window size in dev mode      --lang=en|fr  force UI language
const { app, BrowserWindow, protocol, session } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { createIpc } = require('./lib/ipc');
const { registerProtocols, registerSchemes } = require('./lib/protocols');
const { installHotkeys } = require('./lib/hotkeys');

function arg(name, def) {
  const pre = `--${name}=`;
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(pre));
  if (!hit) return def;
  return hit === `--${name}` ? true : hit.slice(pre.length);
}

const MODE = arg('mode', 'shell');
const DEV = !!arg('dev', false) || process.env.AURORA_DEV === '1';
const OPEN = String(arg('open', '') || '').split(',').filter(Boolean);
const SIZE = String(arg('size', '1600x900')).split('x').map(Number);
const FORCE_LANG = arg('lang', process.env.AURORA_LANG || '');

const ROOT = path.join(__dirname, '..');
const RENDERER = path.join(ROOT, 'renderer');

if (process.env.AURORA_DISABLE_GPU === '1') app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling,MediaSessionService');
// Greeter runs as an unprivileged system user with a throwaway profile.
if (MODE === 'greeter') {
  const dir = process.env.AURORA_GREETER_DATA || path.join(os.tmpdir(), `aurora-greeter-${process.getuid?.() ?? 0}`);
  app.setPath('userData', dir);
} else {
  app.setPath('userData', path.join(os.homedir(), '.config', 'aurora', 'electron'));
}
app.setName('Selene Shell');

registerSchemes(protocol);

function detectLang() {
  if (FORCE_LANG) return String(FORCE_LANG).slice(0, 2);
  const env = process.env.LANGUAGE || process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || 'en';
  return env.toLowerCase().startsWith('fr') ? 'fr' : 'en';
}

function isLive() {
  try {
    return /\bboot=casper\b/.test(fs.readFileSync('/proc/cmdline', 'utf8'));
  } catch {
    return false;
  }
}

const env = {
  mode: MODE,
  dev: DEV,
  open: OPEN,
  lang: detectLang(),
  user: os.userInfo().username,
  uid: os.userInfo().uid,
  home: os.homedir(),
  hostname: os.hostname(),
  live: isLive() || process.env.AURORA_LIVE === '1',
  version: require(path.join(ROOT, 'package.json')).version,
  osName: 'Selene OS',
  rendererRoot: RENDERER,
};

let mainWindow = null;
const ipc = createIpc({ env, getMainWindow: () => mainWindow, RENDERER, ROOT, DEV });

function screenBounds() {
  const { screen } = require('electron');
  const { x, y, width, height } = screen.getPrimaryDisplay().bounds;
  return { x, y, width, height };
}

// Chromium never gives a window exactly the size of a display (it subtracts 1px so that window
// managers do not maximize it). With no window manager that leaves a 1px gap on the right and
// bottom edges, so the OS image's helper resizes the X window itself (absent in dev: no-op).
const XRESIZE = '/usr/lib/aurora/aurora-xresize';
function coverExactly(win, b) {
  if (process.platform !== 'linux' || win.isDestroyed() || !fs.existsSync(XRESIZE)) return;
  const cur = win.getBounds();
  if (cur.x === b.x && cur.y === b.y && cur.width === b.width && cur.height === b.height) return;
  const h = win.getNativeWindowHandle();
  const xid = h.length >= 8 ? h.readBigUInt64LE(0) : BigInt(h.readUInt32LE(0));
  require('child_process').execFile(XRESIZE, [xid, b.x, b.y, b.width, b.height].map(String), { timeout: 5000 }, (err) => {
    if (err) console.warn(`aurora: ${XRESIZE} failed: ${err.message}`);
  });
}

// Keep the shell window on the whole primary display when the resolution or monitors change.
function followScreen(win) {
  const { screen } = require('electron');
  const fit = () => {
    if (win.isDestroyed()) return;
    const b = screenBounds();
    const cur = win.getBounds();
    if (cur.x !== b.x || cur.y !== b.y || cur.width !== b.width || cur.height !== b.height) {
      win.setBounds(b);
      setTimeout(() => coverExactly(win, b), 100);
    }
  };
  for (const ev of ['display-metrics-changed', 'display-added', 'display-removed']) screen.on(ev, () => setTimeout(fit, 50));
  win.once('ready-to-show', fit);
  win.once('show', () => setTimeout(fit, 50));
}

function createWindow() {
  const opts = {
    show: false,
    frame: false,
    backgroundColor: '#000000',
    title: MODE === 'greeter' ? 'Selene Sign-in' : 'Selene Shell',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(ROOT, 'preload', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: MODE === 'shell',
      spellcheck: false,
      backgroundThrottling: false,
      additionalArguments: [`--aurora-env=${Buffer.from(JSON.stringify(env)).toString('base64')}`],
    },
  };
  if (DEV) {
    opts.width = SIZE[0] || 1600;
    opts.height = SIZE[1] || 900;
  } else {
    // No window manager runs under the shell (it *is* the window manager), so nothing would
    // honour a fullscreen request: cover the primary display explicitly and follow it.
    Object.assign(opts, screenBounds());
    opts.fullscreen = true;
    opts.kiosk = true;
  }
  mainWindow = new BrowserWindow(opts);
  mainWindow.setMenu(null);
  if (!DEV) followScreen(mainWindow);
  const page = MODE === 'greeter' ? 'greeter.html' : 'shell.html';
  mainWindow.loadURL(`app://shell/${page}`);
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  // Never navigate the shell itself away from app://
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://shell/')) e.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) ipc.broadcast('shell:open-url', { url });
    else if (/^mailto:/i.test(url)) ipc.broadcast('shell:open-mailto', { url }); // e-mail links in mail bodies -> Mail
    return { action: 'deny' };
  });
  if (DEV && process.env.AURORA_DEVTOOLS === '1') mainWindow.webContents.openDevTools({ mode: 'detach' });
  return mainWindow;
}

// Webviews (browser tabs, mail bodies) are untrusted content: lock them down.
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webviewTag = false;
    const part = params.partition || '';
    if (part && !/^(persist:)?(browser|mail|web)/.test(part)) event.preventDefault();
    if (params.src && /^(app|media|file):/i.test(params.src)) event.preventDefault();
  });
  installHotkeys(contents, ipc, MODE);
});

app.on('window-all-closed', () => app.quit());

const gotLock = DEV || app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.whenReady().then(async () => {
    registerProtocols(protocol, session.defaultSession, { RENDERER, ROOT });
    // The sign-in screen runs as the greeter system user: give it only the backends it uses
    // (no file system, terminal, mail, admin… channels before anyone has signed in).
    const GREETER_MODULES = new Set(['settings.js', 'sys.js', 'greetd.js', 'net.js', 'power-ext.js']);
    await ipc.loadModules(path.join(__dirname, 'ipc'), MODE === 'greeter' ? (f) => GREETER_MODULES.has(f) : undefined);
    createWindow();
  });
}

module.exports = { env };
