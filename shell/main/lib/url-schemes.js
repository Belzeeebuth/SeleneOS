'use strict';
// Links to other applications (custom URL schemes: claude://, zoommtg:, steam://, spotify:, magnet: …) for the
// Navigateur (main/ipc/browser.js). A page that navigates, redirects or opens a window to such a link does not
// navigate: the Navigateur asks « Ouvrir Claude ? » first, then hands the link to the application that handles
// x-scheme-handler/<scheme> through xdg-open (one argv entry, no shell).
//
//   externalScheme(url)  -> 'claude' | null    null: a scheme the browser handles (or refuses) itself
//   checkUrl(url)        -> 'claude' | null    the scheme when the link may be handed to an app (syntax, length, no
//                                              control characters), else null
//   handlerFor(scheme, lang) -> Promise<{ id, name } | null>   default app (xdg-mime query default
//                                              x-scheme-handler/<scheme>) and its localized Name from the .desktop file
//   launch(url)          -> Promise<void>      xdg-open <url> (rejects when xdg-open cannot start)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { run } = require('./exec.js');

const SCHEME_RE = /^[a-z][a-z0-9+.-]{1,31}$/;
const MAX_URL = 8192;
// Schemes the browser loads, refuses or routes itself (mailto goes to Courrier): never handed to another app.
const OWN = new Set([
  'http', 'https', 'ws', 'wss', 'ftp', 'about', 'data', 'blob', 'file', 'filesystem', 'view-source', 'javascript', 'vbscript',
  'chrome', 'chrome-extension', 'chrome-untrusted', 'chrome-error', 'chrome-search', 'chrome-native', 'devtools', 'app', 'media',
  'aurora', 'edge', 'mailto',
]);

function externalScheme(url) {
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(String(url || ''));
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  return OWN.has(scheme) ? null : scheme;
}

function checkUrl(url) {
  const u = String(url || '');
  if (!u || u.length > MAX_URL || /[\u0000-\u001f\u007f]/.test(u)) return null;
  const scheme = externalScheme(u);
  return scheme && SCHEME_RE.test(scheme) ? scheme : null;
}

/** XDG data directories, user first, Flatpak exports included. */
function dataDirs() {
  const home = os.homedir();
  const user = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  const sys = (process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter((d) => path.isAbsolute(d));
  return [...new Set([user, path.join(home, '.local', 'share', 'flatpak', 'exports', 'share'), '/var/lib/flatpak/exports/share', ...sys])];
}

function readDesktop(id) {
  // A desktop id « vendor-app.desktop » may also live at applications/vendor/app.desktop (Desktop Entry spec).
  const rel = [id];
  if (id.includes('-')) rel.push(id.replace('-', '/'));
  for (const dir of dataDirs()) {
    for (const r of rel) {
      try {
        return fs.readFileSync(path.join(dir, 'applications', r), 'utf8');
      } catch {}
    }
  }
  return null;
}

async function handlerFor(scheme, lang = 'en') {
  if (!SCHEME_RE.test(String(scheme || ''))) return null;
  let out = '';
  try {
    out = (await run('xdg-mime', ['query', 'default', `x-scheme-handler/${scheme}`], { timeout: 4000 })).stdout;
  } catch {
    return null; // no xdg-mime
  }
  const id = String(out || '').split('\n')[0].trim().split(';')[0];
  if (!/^[A-Za-z0-9_.+@-]+\.desktop$/.test(id)) return null;
  // Selene's own hand-off to the shell (aurora-open) only takes web and mail links: it is not an app for this link.
  if (/^aurora-/.test(id)) return null;
  const text = readDesktop(id);
  if (text == null) return null;
  const { parseDesktop, localized } = require('../ipc/xapps.js').parsers;
  const entry = parseDesktop(text)['Desktop Entry'];
  if (!entry || entry.Hidden === 'true') return null;
  const clean = (s) => String(s || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60);
  const name = clean(localized(entry, 'Name', lang === 'fr' ? 'fr' : 'en')) || clean(id.replace(/\.desktop$/, ''));
  return { id, name };
}

function launch(url) {
  return new Promise((resolve, reject) => {
    if (!checkUrl(url)) return reject(new Error('refused'));
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (/^(ELECTRON_|CHROME_|NODE_OPTIONS$|GOOGLE_API_KEY$)/.test(k)) delete env[k];
    if (!env.DISPLAY) env.DISPLAY = ':0';
    let child;
    try {
      child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore', env, cwd: os.homedir() });
    } catch (err) {
      return reject(err);
    }
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

module.exports = { externalScheme, checkUrl, handlerFor, launch, dataDirs, SCHEME_RE, MAX_URL };
