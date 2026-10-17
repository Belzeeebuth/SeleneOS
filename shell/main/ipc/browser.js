'use strict';
// Aurora Browser backend: everything the browser app needs from the main process.
//
// Guest hooks (only for <webview>s whose session is a browser partition: persist:browser or
// an in-memory browser-private-<n> partition prepared with browser:initPartition):
//   setWindowOpenHandler  -> pop-ups with window features (window.open(url, name, 'width=…'): sign-in with Google /
//                            Microsoft / Apple…) become a real window (BrowserWindow) in the same session that keeps
//                            window.opener / postMessage and closes on window.close(); aurora-xwm frames it as a
//                            Navigateur window (main/lib/own-windows.js). Everything else: deny + broadcast
//                            'browser:open' {url, disposition, features, sourceId} (tabs). Events of a pop-up are
//                            reported with its opener tab's id as sourceId (dialogs, permissions, downloads).
//   context-menu          -> broadcast 'browser:context-menu' {sourceId, params}
//   before-input-event    -> browser shortcuts: broadcast 'browser:shortcut' {sourceId, combo} (+ preventDefault)
//   zoom-changed          -> 'browser:shortcut' {combo: 'ZoomIn' | 'ZoomOut'} (Ctrl+wheel)
// Sessions: the identity of a stable Google Chrome on Linux (main/lib/chrome-identity.js: user agent, Sec-CH-UA*
// request headers, navigator.userAgentData through the DevTools protocol), Accept-Language, downloads into
// ~/Downloads ('browser:download' events), permission prompts ('browser:permission'), HTTP auth
// ('browser:auth'), Do Not Track header, optional third-party cookie blocking.
//
// Channels:
//   browser:initPartition(partition)             -> { ua }
//   browser:disposePartition(partition)          -> clears an in-memory private partition
//   browser:setPrefs({ dnt, block3p, lang })
//   browser:info()                               -> { chrome, electron, v8, ua }
//   browser:favicon(url, partition)              -> data: URL | null (fetched with the tab's session)
//   browser:downloadUrl({ sourceId, partition, url, savePath })
//   browser:downloadPause(id) / downloadResume(id) / downloadCancel(id) / downloads()
//   browser:permissionReply(id, { allow, remember })
//   browser:sitePermissions() / browser:resetSitePermissions(origin?)
//   browser:authReply(id, { username, password } | null)   (+ 'browser:auth-done' {id} when a request goes away)
//   browser:clearData({ partition, cookies, cache, origin })
//   browser:copyImageAt(sourceId, x, y) / browser:inspect(sourceId, x, y)
//   browser:navHistory(sourceId)                 -> { index, entries: [{ url, title }] }
//   browser:jsDialogReply(id, { ok, value, suppress })  answers 'browser:js-dialog' {id, sourceId, kind, message, def, origin, offerSuppress}
//   browser:displayMediaReply(id, sourceId|null) / browser:stopShare(sourceId) / browser:activeShares()  (screen sharing)
const { app, session, webContents } = require('electron');
const identity = require('../lib/chrome-identity.js');
const ownWindows = require('../lib/own-windows.js');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PERSIST = 'persist:browser';
// Session preload giving pages working alert/confirm/prompt (see that file: it exposes nothing else).
const GUEST_PRELOAD = path.join(__dirname, '..', '..', 'renderer', 'apps', 'browser', 'guest-preload.js');
const PRIVATE_RE = /^browser-private-[A-Za-z0-9_-]{1,64}$/;
const HOME = os.homedir();
const PERM_FILE = path.join(HOME, '.config', 'aurora', 'apps', 'browser', 'site-permissions.json');

const ALLOW = new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock']);
const ASK = new Set(['notifications', 'geolocation', 'media', 'midi', 'midiSysex']);

// Shortcuts the browser handles even when a web page has focus.
const COMBOS = new Set([
  'Ctrl+T', 'Ctrl+W', 'Ctrl+F4', 'Ctrl+N', 'Ctrl+Shift+N', 'Ctrl+Shift+T', 'Ctrl+Shift+W', 'Ctrl+L', 'Alt+D', 'F6',
  'Ctrl+F', 'F3', 'Shift+F3', 'Ctrl+G', 'Ctrl+Shift+G', 'Ctrl+R', 'F5', 'Ctrl+F5', 'Shift+F5', 'Ctrl+Shift+R', 'Ctrl+H', 'Ctrl+J',
  'Ctrl+D', 'Ctrl+Shift+O', 'Ctrl+Shift+B', 'Ctrl+Tab', 'Ctrl+Shift+Tab', 'Ctrl+PageDown', 'Ctrl+PageUp', 'Ctrl+1', 'Ctrl+2',
  'Ctrl+3', 'Ctrl+4', 'Ctrl+5', 'Ctrl+6', 'Ctrl+7', 'Ctrl+8', 'Ctrl+9', 'Alt+ArrowLeft', 'Alt+ArrowRight', 'Alt+Home',
  'Ctrl+Plus', 'Ctrl+Minus', 'Ctrl+0', 'F11', 'Ctrl+U', 'Ctrl+Shift+Delete', 'Alt+F', 'BrowserBack', 'BrowserForward',
  'BrowserRefresh', 'BrowserHome', 'BrowserSearch', 'Ctrl+P', 'Ctrl+S',
]);
const DEV_COMBOS = new Set(['F12', 'Ctrl+Shift+I', 'Ctrl+Shift+J', 'Ctrl+Shift+C']);
// Forwarded to the app but still delivered to the page (pages rely on Escape).
const PASS_THROUGH = new Set(['Escape']);
// data: URLs a page may open in a new tab (non-scriptable images only).
const SAFE_DATA = /^data:image\/(png|jpe?g|gif|webp|bmp|avif|x-icon)[;,]/i;

// Rough registrable-domain ("site") computation for third-party cookie blocking.
const MULTI = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'com.au', 'net.au', 'org.au', 'co.jp', 'ne.jp', 'or.jp', 'co.nz', 'com.br',
  'com.cn', 'com.mx', 'co.in', 'co.za', 'com.tr', 'com.tw', 'co.kr', 'gouv.fr', 'asso.fr', 'github.io', 'gitlab.io',
  'herokuapp.com', 'blogspot.com', 'appspot.com', 'vercel.app', 'netlify.app', 'pages.dev', 'web.app', 'firebaseapp.com',
]);
function siteOf(host) {
  const h = String(host || '').toLowerCase();
  if (!h || /^[\d.]+$/.test(h) || h.includes(':')) return h;
  const parts = h.split('.');
  if (parts.length <= 2) return h;
  const two = parts.slice(-2).join('.');
  return MULTI.has(two) ? parts.slice(-3).join('.') : two;
}
function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}
function originOf(url) {
  try {
    const o = new URL(url).origin;
    return o === 'null' ? '' : o;
  } catch {
    return '';
  }
}

function comboOf(input) {
  const parts = [];
  if (input.control) parts.push('Ctrl');
  if (input.alt) parts.push('Alt');
  if (input.shift) parts.push('Shift');
  if (input.meta) parts.push('Super');
  let key = input.key;
  if (['Control', 'Alt', 'Shift', 'Meta', 'OS', 'Super', 'Hyper'].includes(key)) return '';
  if (input.control && !input.alt && (key === '=' || key === '+' || input.code === 'NumpadAdd')) return 'Ctrl+Plus';
  if (input.control && !input.alt && (key === '-' || key === '_' || input.code === 'NumpadSubtract')) return 'Ctrl+Minus';
  if (input.control && !input.alt && !input.shift && (key === '0' || input.code === 'Numpad0')) return 'Ctrl+0';
  if (input.control && /^Digit\d$/.test(input.code || '')) key = input.code.slice(5);
  if (key === 'Esc') key = 'Escape';
  if (key && key.length === 1) key = key.toUpperCase();
  return [...parts, key].join('+');
}

function xdgDownloads() {
  let dir = path.join(HOME, 'Downloads');
  try {
    const txt = fs.readFileSync(path.join(HOME, '.config', 'user-dirs.dirs'), 'utf8');
    const m = /^XDG_DOWNLOAD_DIR="(.*)"/m.exec(txt);
    if (m) dir = m[1].replace('$HOME', HOME);
  } catch {}
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
  return dir;
}

// Accept-Language: Electron computes the q-values itself (a list with q-values came out as « fr;q=0.9;q=0.9 »).
const acceptLanguages = identity.acceptLanguages;
// Pop-up size limits (window features are the page's wish; Chrome clamps them to the screen too).
const POPUP_MIN = { width: 360, height: 300 };
const POPUP_MAX = { width: 1400, height: 1000 };
const MAX_POPUPS = 3;

module.exports = function register(api) {
  const sessions = new Map(); // partition -> Session
  const partitionOf = new Map(); // Session -> partition
  const downloads = new Map(); // id -> { item, info }
  const reservedPaths = new Set();
  const pendingSaveAs = new Map(); // url -> savePath (from "Save link as…")
  const pendingPerms = new Map();
  const pendingAuth = new Map();
  const privatePerms = new Map(); // partition -> { origin: { kind: 'allow'|'block' } }
  const faviconCache = new Map();
  let prefs = { dnt: false, block3p: false, lang: api.env?.lang || 'en' };
  let seq = 0;
  let sitePerms = {};
  try {
    sitePerms = JSON.parse(fs.readFileSync(PERM_FILE, 'utf8')) || {};
  } catch {}

  const saveSitePerms = () => {
    try {
      fs.mkdirSync(path.dirname(PERM_FILE), { recursive: true });
      fs.writeFileSync(PERM_FILE, JSON.stringify(sitePerms, null, 2));
    } catch (err) {
      console.error('[browser] saving site permissions failed', err);
    }
  };

  const isPrivate = (partition) => partition !== PERSIST;
  const permStore = (partition) => {
    if (!isPrivate(partition)) return sitePerms;
    if (!privatePerms.has(partition)) privatePerms.set(partition, {});
    return privatePerms.get(partition);
  };

  function validPartition(p) {
    return p === PERSIST || PRIVATE_RE.test(String(p || ''));
  }

  // ------------------------------------------------------------------ sessions
  function setup(partition) {
    if (!validPartition(partition)) throw api.error('Invalid browser partition', 'EINVAL');
    if (sessions.has(partition)) return sessions.get(partition);
    const ses = session.fromPartition(partition);
    sessions.set(partition, ses);
    partitionOf.set(ses, partition);
    // The same reduced user agent string Chrome sends: no Electron or app tokens.
    ses.setUserAgent(identity.userAgent(), acceptLanguages(prefs.lang));
    // Spell check with the local dictionaries only (main/ipc/spell.js): nothing is fetched from Google servers.
    try {
      require('./spell.js').prepare(ses, api.env.lang);
    } catch {
      try {
        ses.setSpellCheckerEnabled(false);
      } catch {}
    }
    try {
      if (fs.existsSync(GUEST_PRELOAD)) ses.registerPreloadScript({ type: 'frame', id: 'aurora-browser-dialogs', filePath: GUEST_PRELOAD });
    } catch (err) {
      console.error('[browser] guest preload not registered', err?.message || err);
    }
    ses.on('will-download', (event, item, wc) => onWillDownload(partition, item, wc));
    ses.setPermissionRequestHandler((wc, permission, callback, details) => onPermissionRequest(partition, wc, permission, callback, details || {}));
    ses.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => onPermissionCheck(partition, permission, requestingOrigin, details || {}));
    // Screen sharing (getDisplayMedia): a Selene picker in the tab's window (« Écran entier » or a window); cancel = deny.
    try {
      ses.setDisplayMediaRequestHandler((request, callback) => onDisplayMedia(request, callback));
    } catch (err) {
      console.warn('[browser] no display media handler', err?.message || err);
    }
    applyWebRequest(ses);
    return ses;
  }

  // Client hints a site asked for with Accept-CH, per session and origin (Chrome remembers them the same way).
  const askedHints = new WeakMap(); // Session -> Map(origin -> Set(hint))
  const criticalRetries = new Map(); // url -> time of the Critical-CH retry (one retry per URL, like Chrome)
  function hintsFor(ses, url) {
    const map = askedHints.get(ses);
    return (map && map.get(originOf(url))) || new Set();
  }
  function rememberHints(ses, details) {
    if (details.resourceType !== 'mainFrame' && details.resourceType !== 'subFrame') return false;
    const hdr = (name) => Object.entries(details.responseHeaders || {}).filter(([k]) => k.toLowerCase() === name).flatMap(([, v]) => v);
    const accept = hdr('accept-ch');
    if (!accept.length) return false;
    const origin = originOf(details.url);
    if (!origin || !identity.isSecureUrl(details.url)) return false;
    if (!askedHints.has(ses)) askedHints.set(ses, new Map());
    const map = askedHints.get(ses);
    const before = map.get(origin) || new Set();
    const now = identity.parseHintList(accept);
    map.set(origin, now);
    if (map.size > 500) map.delete(map.keys().next().value);
    // Critical-CH: the page needs a hint it did not get: Chrome retries the request once with it.
    const critical = [...identity.parseHintList(hdr('critical-ch'))].filter((h) => now.has(h) && !before.has(h) && identity.HIGH.includes(h));
    if (!critical.length || details.method !== 'GET' || details.resourceType !== 'mainFrame') return false;
    const last = criticalRetries.get(details.url);
    if (last && Date.now() - last < 10000) return false;
    criticalRetries.set(details.url, Date.now());
    if (criticalRetries.size > 200) criticalRetries.delete(criticalRetries.keys().next().value);
    return true;
  }

  function applyWebRequest(ses) {
    const filter = { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] };
    const thirdParty = (details) => {
      if (!prefs.block3p || details.resourceType === 'mainFrame') return false;
      let top = '';
      try {
        top = details.webContents?.getURL?.() || details.referrer || '';
      } catch {}
      const a = siteOf(hostOf(top));
      const b = siteOf(hostOf(details.url));
      return !!a && !!b && a !== b;
    };
    ses.webRequest.onBeforeSendHeaders(filter, (details, cb) => {
      // Chrome's Sec-CH-UA* hints (Electron sends none): low-entropy ones always, the others when the site asked.
      const headers = identity.withHints(details.requestHeaders, details.url, hintsFor(ses, details.url));
      if (prefs.dnt) headers.DNT = '1';
      if (thirdParty(details)) {
        delete headers.Cookie;
        delete headers.cookie;
      }
      cb({ requestHeaders: headers });
    });
    ses.webRequest.onHeadersReceived(filter, (details, cb) => {
      // Critical-CH retry: answered as a redirect to the same address (webRequest cannot restart a request).
      if (rememberHints(ses, details)) return cb({ statusLine: 'HTTP/1.1 307 Internal Redirect', responseHeaders: { Location: [details.url], 'Non-Authoritative-Reason': ['Critical-CH'] } });
      if (!thirdParty(details)) return cb({});
      const headers = {};
      for (const [k, v] of Object.entries(details.responseHeaders || {})) if (k.toLowerCase() !== 'set-cookie') headers[k] = v;
      cb({ responseHeaders: headers });
    });
  }

  setup(PERSIST);

  // ------------------------------------------------------------------ guests
  app.on('web-contents-created', (_e, wc) => {
    const partition = partitionOf.get(wc.session);
    if (!partition) return; // mail bodies and other webviews are not ours
    const type = wc.getType();
    if (type === 'webview') {
      applyIdentity(wc);
      hookGuest(wc, partition);
    } else if (type === 'window') {
      // A sign-in pop-up a tab opened (allowed by the window open handler): Chrome's identity before it loads
      // anything; the rest is set up in onPopupCreated. A web page: shell events are never sent to it (main/lib/ipc.js).
      wc.__auroraWebPage = true;
      applyIdentity(wc);
    }
  });

  // ------------------------------------------------------------------ Chrome identity in pages
  // navigator.userAgentData (brands with « Google Chrome », getHighEntropyValues), navigator.platform and
  // navigator.languages as in Chrome, set through the DevTools protocol so frames and workers get them natively
  // (no page-visible script). Out-of-process frames and workers are attached as they start (paused until they
  // have the override, then released).
  const identityFailures = new Set();
  function overrideParams() {
    return { userAgent: identity.userAgent(), acceptLanguage: acceptLanguages(prefs.lang), platform: identity.navigatorPlatform(), userAgentMetadata: identity.metadata() };
  }
  function applyIdentity(wc) {
    if (process.env.AURORA_BROWSER_NO_CDP === '1') return;
    const dbg = wc.debugger;
    const send = (method, params, sessionId) => {
      try {
        return dbg.sendCommand(method, params || {}, sessionId).catch(() => null);
      } catch {
        return Promise.resolve(null);
      }
    };
    try {
      if (!dbg.isAttached()) dbg.attach('1.3');
    } catch (err) {
      if (!identityFailures.has(String(err?.message))) console.warn('[browser] identity override unavailable', err?.message || err);
      identityFailures.add(String(err?.message));
      return;
    }
    if (!wc.__auroraIdentity) {
      wc.__auroraIdentity = true;
      dbg.on('message', (_ev, method, params, sessionId) => {
        if (method !== 'Target.attachedToTarget' || !params?.sessionId) return;
        const sid = params.sessionId;
        const type = params.targetInfo?.type || '';
        const steps = [];
        if (type === 'iframe' || type === 'page') {
          steps.push(send('Emulation.setUserAgentOverride', overrideParams(), sid));
          steps.push(send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sid));
        } else if (/worker/.test(type)) steps.push(send('Network.setUserAgentOverride', overrideParams(), sid));
        Promise.all(steps).finally(() => send('Runtime.runIfWaitingForDebugger', {}, sid));
      });
    }
    send('Emulation.setUserAgentOverride', overrideParams());
    send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  }
  function refreshIdentity() {
    for (const wc of webContents.getAllWebContents()) {
      if (wc.isDestroyed() || !partitionOf.has(wc.session) || !wc.__auroraIdentity) continue;
      try {
        if (wc.debugger.isAttached()) wc.debugger.sendCommand('Emulation.setUserAgentOverride', overrideParams()).catch(() => {});
      } catch {}
    }
  }

  const popupTimes = new Map(); // wc.id -> [timestamps]
  // Pop-up windows: popup wc.id -> the id of the tab (webview) that opened it, directly or through other pop-ups.
  const popupRoute = new Map();
  const routeOf = (id) => popupRoute.get(id) ?? id;

  /** window.open with window features (a sign-in pop-up): a real window, not a tab. */
  function isPopupRequest(url, disposition, features) {
    if (disposition !== 'new-window') return false;
    if (!/\b(width|height|left|top|popup)\b/i.test(features || '')) return false;
    return url === '' || /^(https?:|about:blank)/i.test(url);
  }
  function popupOptions(features) {
    const num = (k) => {
      const m = new RegExp(`(?:^|[,\\s])${k}\\s*=\\s*(\\d+)`, 'i').exec(features || '');
      return m ? Number(m[1]) : null;
    };
    const clamp = (v, lo, hi, def) => Math.max(lo, Math.min(hi, v || def));
    return {
      width: clamp(num('width'), POPUP_MIN.width, POPUP_MAX.width, 500),
      height: clamp(num('height'), POPUP_MIN.height, POPUP_MAX.height, 600),
      minWidth: POPUP_MIN.width,
      minHeight: POPUP_MIN.height,
      // left / top from the page are ignored: centred on the screen (pages compute them from the tab's own
      // window.screenX, which inside the shell is not where the tab is); the shell places the frame.
      x: undefined,
      y: undefined,
      center: true,
      useContentSize: true,
      show: true,
      frame: true, // aurora-xwm: the shell draws the frame (title bar, close button)
      autoHideMenuBar: true,
      backgroundColor: '#ffffff',
      title: '',
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webviewTag: false, spellcheck: true, nodeIntegrationInSubFrames: false },
    };
  }
  function popupTitle(url, title) {
    const host = hostOf(url) || (/^about:/i.test(url) ? '' : String(url || '').slice(0, 60));
    const t = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!host) return t || ' ';
    // While loading, the title is the address itself (« localhost:8080/authorize?… »): the site name alone then.
    const bare = String(url || '').replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
    return t && t !== url && t !== bare ? `${host} — ${t}` : host;
  }
  function onPopupCreated(win, openerId, partition) {
    const wc = win.webContents;
    popupRoute.set(wc.id, routeOf(openerId));
    try {
      win.removeMenu();
    } catch {}
    ownWindows.register(win, 'browser');
    // The frame title always starts with the real site (pages cannot pretend to be another one).
    const setTitle = () => {
      if (!win.isDestroyed()) win.setTitle(popupTitle(wc.getURL(), wc.getTitle()));
    };
    win.on('page-title-updated', (ev) => {
      ev.preventDefault();
      setTitle();
    });
    wc.on('did-navigate', setTitle);
    wc.on('did-navigate-in-page', setTitle);
    setTitle();
    hookGuest(wc, partition, { popup: win });
    wc.once('destroyed', () => popupRoute.delete(wc.id));
    api.broadcast('browser:popup-window', { sourceId: routeOf(openerId), popupId: wc.id, url: wc.getURL() });
  }

  function hookGuest(wc, partition, { popup = null } = {}) {
    const id = wc.id;
    // A pop-up this page (tab or pop-up) opened: see onPopupCreated.
    wc.on('did-create-window', (win) => {
      try {
        onPopupCreated(win, id, partition);
      } catch (err) {
        console.error('[browser] pop-up window setup failed', err);
      }
    });
    const src = () => routeOf(id);
    wc.setWindowOpenHandler(({ url, disposition, features, frameName }) => {
      // Simple pop-up flood protection: at most 3 new tabs per second from one page.
      const now = Date.now();
      const times = (popupTimes.get(id) || []).filter((t) => now - t < 1000);
      if (times.length >= 3) {
        if (/^(https?|ftp):/i.test(url)) api.broadcast('browser:popup-blocked', { sourceId: src(), url });
        return { action: 'deny' };
      }
      times.push(now);
      popupTimes.set(id, times);
      if (/^(mailto|tel|sms|callto|magnet|webcal|xmpp|sip|irc|ircs):/i.test(url)) {
        api.broadcast('browser:external', { sourceId: src(), url });
        return { action: 'deny' };
      }
      if (!/^(https?|ftp|data|about|view-source):/i.test(url) && url !== '') return { action: 'deny' };
      // Like Chrome, pages may not open data: documents (phishing vector); plain images are fine.
      if (/^data:/i.test(url) && !SAFE_DATA.test(url)) return { action: 'deny' };
      // Sign-in pop-ups (window features): a real window that keeps window.opener, in this tab's session.
      // At most MAX_POPUPS such windows open at once per tab (a page cannot cover the screen with windows): the rest
      // open as tabs, as before.
      const openPopups = [...popupRoute.values()].filter((t) => t === src()).length;
      if (isPopupRequest(url, disposition, features) && openPopups < MAX_POPUPS) return { action: 'allow', outlivesOpener: false, overrideBrowserWindowOptions: popupOptions(features) };
      api.broadcast('browser:open', { url: url || 'about:blank', disposition, features: features || '', frameName: frameName || '', sourceId: src(), partition });
      return { action: 'deny' };
    });
    wc.on('context-menu', (_ev, p) => {
      if (popup) return; // the tab's menu would show at the pop-up's coordinates in the tab
      api.broadcast('browser:context-menu', {
        sourceId: id,
        params: {
          x: p.x,
          y: p.y,
          linkURL: p.linkURL || '',
          linkText: p.linkText || '',
          srcURL: p.srcURL || '',
          mediaType: p.mediaType || 'none',
          hasImageContents: !!p.hasImageContents,
          isEditable: !!p.isEditable,
          selectionText: p.selectionText || '',
          pageURL: p.pageURL || '',
          frameURL: p.frameURL || '',
          titleText: p.titleText || '',
          editFlags: p.editFlags || {},
          mediaFlags: p.mediaFlags || {},
          misspelledWord: p.misspelledWord || '',
          dictionarySuggestions: p.dictionarySuggestions || [],
        },
      });
    });
    wc.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      const combo = comboOf(input);
      if (!combo) return;
      if (popup) {
        // A pop-up window has no tabs: close / reload / zoom only, the rest goes to the page.
        if (combo === 'Ctrl+W' || combo === 'Ctrl+F4') {
          event.preventDefault();
          if (!popup.isDestroyed()) popup.close();
        } else if (combo === 'F5' || combo === 'Ctrl+R') {
          event.preventDefault();
          wc.reload();
        }
        return;
      }
      if (COMBOS.has(combo) || (api.DEV && DEV_COMBOS.has(combo))) {
        event.preventDefault();
        api.broadcast('browser:shortcut', { sourceId: id, combo, repeat: !!input.isAutoRepeat });
      } else if (PASS_THROUGH.has(combo)) {
        api.broadcast('browser:shortcut', { sourceId: id, combo, passThrough: true });
      }
    });
    if (!popup) wc.on('zoom-changed', (_ev, dir) => api.broadcast('browser:shortcut', { sourceId: id, combo: dir === 'in' ? 'ZoomIn' : 'ZoomOut' }));
    // Pages may never navigate a tab to local or privileged schemes.
    wc.on('will-navigate', (ev, url) => {
      if (/^(file|app|media|chrome|devtools|chrome-extension):/i.test(url)) ev.preventDefault();
    });
    wc.on('will-frame-navigate', (ev) => {
      if (/^(file|app|media|chrome|devtools|chrome-extension):/i.test(ev.url || '')) ev.preventDefault();
    });
    // alert / confirm / prompt from the page (guest-preload.js): the page waits for the answer.
    wc.ipc.on('browser:js-dialog', (event, p) => onJsDialog(wc, event, p || {}));
    // Screen capture state from guest-preload.js (the indicator goes away when the page ends its capture).
    wc.ipc.on('browser:share-state', (event, live) => onShareState(wc, event, live === true));
    // A new navigation (or closing the tab) abandons any sign-in or page dialog the previous one was waiting for.
    wc.on('did-start-navigation', (details) => {
      if (details?.isMainFrame && !details.isSameDocument) {
        cancelAuthFor(id);
        cancelDialogsFor(id);
        dialogState.delete(id);
      }
    });
    wc.once('destroyed', () => {
      popupTimes.delete(id);
      cancelAuthFor(id);
      cancelDialogsFor(id);
      dialogState.delete(id);
    });
  }

  function guest(sourceId) {
    const wc = webContents.fromId(Number(sourceId));
    if (!wc || wc.isDestroyed() || !partitionOf.has(wc.session)) throw api.error('Tab not found', 'ENOTAB');
    return wc;
  }

  // ------------------------------------------------------------------ downloads
  function uniquePath(dir, name) {
    // The name comes from the server: no path separators, control characters or leading dots, and
    // short enough for any file system (255 bytes) once " (n)" is added.
    let safe = String(name || 'download').replace(/[/\\\0]/g, '_').replace(/[\u0000-\u001f\u007f]/g, '').replace(/^[.\s]+/, '').trim() || 'download';
    while (Buffer.byteLength(safe) > 200) {
      const e = path.extname(safe);
      const stem = safe.slice(0, safe.length - e.length);
      safe = stem.length > 1 ? `${stem.slice(0, -1)}${e}` : safe.slice(0, -1);
    }
    const ext = path.extname(safe);
    const stem = ext && ext !== safe ? safe.slice(0, -ext.length) : safe;
    let candidate = path.join(dir, safe);
    for (let i = 2; fs.existsSync(candidate) || reservedPaths.has(candidate); i++) candidate = path.join(dir, `${stem} (${i})${ext}`);
    return candidate;
  }

  function info(d) {
    const { item } = d;
    let state = d.state;
    try {
      state = d.done ? d.state : item.getState();
    } catch {}
    return {
      id: d.id,
      url: d.url,
      filename: path.basename(d.path),
      path: d.path,
      mime: d.mime,
      total: d.done ? d.total : safe(() => item.getTotalBytes(), d.total),
      received: d.done ? d.received : safe(() => item.getReceivedBytes(), d.received),
      state,
      paused: d.done ? false : safe(() => item.isPaused(), false),
      canResume: d.done ? false : safe(() => item.canResume(), false),
      startTime: d.startTime,
      endTime: d.endTime || null,
      private: isPrivate(d.partition),
      partition: d.partition,
      sourceId: d.sourceId,
    };
  }
  function safe(fn, fallback) {
    try {
      return fn();
    } catch {
      return fallback;
    }
  }

  function onWillDownload(partition, item, wc) {
    const url = item.getURL();
    const chain = safe(() => item.getURLChain(), null) || [url];
    const key = [url, ...chain].find((u) => pendingSaveAs.has(u));
    const pending = key ? pendingSaveAs.get(key) : null;
    if (key) pendingSaveAs.delete(key);
    const savePath = pending || uniquePath(xdgDownloads(), item.getFilename());
    item.setSavePath(savePath);
    reservedPaths.add(savePath);
    const d = {
      id: `dl${Date.now().toString(36)}${(++seq).toString(36)}`,
      item,
      url,
      path: savePath,
      mime: item.getMimeType(),
      partition,
      sourceId: wc && !wc.isDestroyed() ? routeOf(wc.id) : null,
      startTime: Date.now(),
      total: item.getTotalBytes(),
      received: 0,
      state: 'progressing',
      done: false,
    };
    downloads.set(d.id, d);
    let last = 0;
    const emit = (force) => {
      const now = Date.now();
      if (!force && now - last < 250) return;
      last = now;
      api.broadcast('browser:download', info(d));
    };
    item.on('updated', () => emit(false));
    item.once('done', (_e, state) => {
      d.done = true;
      d.state = state; // completed | cancelled | interrupted
      d.total = safe(() => item.getTotalBytes(), d.total);
      d.received = safe(() => item.getReceivedBytes(), d.received);
      d.endTime = Date.now();
      reservedPaths.delete(savePath);
      emit(true);
    });
    emit(true);
  }

  api.handle('browser:downloads', () => [...downloads.values()].map(info));
  api.handle('browser:downloadPause', (id) => {
    const d = downloads.get(id);
    if (d && !d.done) d.item.pause();
    if (d) api.broadcast('browser:download', info(d));
    return true;
  });
  api.handle('browser:downloadResume', (id) => {
    const d = downloads.get(id);
    if (!d || d.done) return false;
    if (!d.item.canResume()) throw api.error('This download cannot be resumed', 'ENORESUME');
    d.item.resume();
    api.broadcast('browser:download', info(d));
    return true;
  });
  api.handle('browser:downloadCancel', (id) => {
    const d = downloads.get(id);
    if (d && !d.done) d.item.cancel();
    return true;
  });
  api.handle('browser:downloadUrl', ({ sourceId, partition, url, savePath } = {}) => {
    if (!/^(https?|ftp|data|blob):/i.test(String(url || ''))) throw api.error('This address cannot be downloaded', 'EINVAL');
    if (savePath) {
      if (!path.isAbsolute(savePath)) throw api.error('Invalid destination', 'EINVAL');
      pendingSaveAs.set(url, savePath);
      // Forget it if this download never starts, so a later download of the same URL by a page
      // does not silently land at that path.
      setTimeout(() => {
        if (pendingSaveAs.get(url) === savePath) pendingSaveAs.delete(url);
      }, 60000);
    }
    let wc = null;
    try {
      wc = sourceId ? guest(sourceId) : null;
    } catch {}
    if (wc) wc.downloadURL(url);
    else setup(partition || PERSIST).downloadURL(url);
    return true;
  });

  // ------------------------------------------------------------------ permissions
  function kindsOf(permission, details) {
    if (permission === 'media') {
      const types = details.mediaTypes || [];
      const kinds = [];
      if (types.includes('video')) kinds.push('camera');
      if (types.includes('audio')) kinds.push('microphone');
      return kinds.length ? kinds : ['camera', 'microphone'];
    }
    if (permission === 'midiSysex') return ['midi'];
    return [permission];
  }

  // Storage Access API (document.requestStorageAccess, used by sign-in and embedded widgets): granted like Chrome
  // does while third-party cookies are allowed (its default); refused when the user blocks them.
  const STORAGE_ACCESS = new Set(['storage-access', 'top-level-storage-access']);
  function onPermissionRequest(partition, wc, permission, callback, details) {
    // HTML fullscreen in a pop-up window would cover the whole screen, taskbar included, with nothing saying it is a
    // web page (a fake Selene screen): pop-ups stay windows; tabs go fullscreen inside the Navigateur as before.
    if (permission === 'fullscreen' && wc && popupRoute.has(wc.id)) return callback(false);
    if (ALLOW.has(permission)) return callback(true);
    if (STORAGE_ACCESS.has(permission)) return callback(!prefs.block3p);
    // getDisplayMedia asks for 'media' with no camera / microphone type: the screen sharing picker (onDisplayMedia)
    // is where the user consents, so no second « caméra / micro » prompt here.
    if (permission === 'media' && Array.isArray(details.mediaTypes) && details.mediaTypes.length === 0) return callback(true);
    if (permission === 'openExternal') {
      const ext = details.externalURL || '';
      if (/^(mailto|tel|sms|webcal|magnet):/i.test(ext)) api.broadcast('browser:external', { sourceId: wc ? routeOf(wc.id) : undefined, url: ext });
      return callback(false);
    }
    if (!ASK.has(permission)) return callback(false);
    const origin = originOf(details.requestingUrl || wc?.getURL?.() || '');
    if (!origin) return callback(false);
    const kinds = kindsOf(permission, details);
    const store = permStore(partition)[origin] || {};
    if (kinds.every((k) => store[k] === 'allow')) return callback(true);
    if (kinds.some((k) => store[k] === 'block')) return callback(false);
    const id = `p${++seq}`;
    const timer = setTimeout(() => finishPermission(id, { allow: false, remember: false }), 180000);
    pendingPerms.set(id, { callback, origin, kinds, partition, timer });
    api.broadcast('browser:permission', { id, sourceId: wc ? routeOf(wc.id) : undefined, origin, permission, kinds });
  }

  function finishPermission(id, { allow, remember } = {}) {
    const p = pendingPerms.get(id);
    if (!p) return false;
    pendingPerms.delete(id);
    clearTimeout(p.timer);
    if (remember) {
      const store = permStore(p.partition);
      store[p.origin] = store[p.origin] || {};
      for (const k of p.kinds) store[p.origin][k] = allow ? 'allow' : 'block';
      if (!isPrivate(p.partition)) saveSitePerms();
    }
    try {
      p.callback(!!allow);
    } catch {}
    api.broadcast('browser:permission-done', { id });
    return true;
  }

  function onPermissionCheck(partition, permission, requestingOrigin, details) {
    if (ALLOW.has(permission)) return true;
    if (STORAGE_ACCESS.has(permission)) return !prefs.block3p;
    const origin = originOf(requestingOrigin || details.requestingUrl || '');
    const store = permStore(partition)[origin] || {};
    if (permission === 'media') {
      const kind = details.mediaType === 'video' ? 'camera' : details.mediaType === 'audio' ? 'microphone' : null;
      return kind ? store[kind] === 'allow' : false;
    }
    if (ASK.has(permission)) return kindsOf(permission, details).every((k) => store[k] === 'allow');
    return false;
  }

  api.handle('browser:permissionReply', (id, decision) => finishPermission(id, decision || {}));

  // ------------------------------------------------------------------ screen sharing
  //   browser:display-media { id, sourceId, origin, sources: [{ id, name, kind: 'screen'|'window', thumb }] }
  //   browser:displayMediaReply (id, sourceId | null) -> true   (null / unknown source / 2 min = denied)
  //   browser:display-share { sourceId, origin, active }        a tab started / stopped sharing (indicator)
  //   browser:stopShare (sourceId) -> true                       « Arrêter le partage »
  // A share is known here from the grant (trusted) until the page's tracks have all ended (guest-preload.js
  // reports it), the tab navigates away or closes. Stopping asks the page hook to end the tracks; if the share
  // is still there 1.5 s later (no hook in that frame), the tab is reloaded so the capture always ends.
  const pendingShares = new Map(); // id -> { callback, sources, timer, wc, frameKey, origin }
  const activeShares = new Map(); // wc.id -> { origin, frames: Set<frameKey>, stopTimer }
  const frameKeyOf = (f) => (f ? `${f.processId}:${f.routingId}` : '');
  const deny = (callback) => {
    try {
      callback(null);
    } catch (err) {
      console.warn('[browser] display media refusal failed', err?.message || err);
    }
  };
  function shareStarted(wc, frameKey, origin) {
    if (!wc || wc.isDestroyed()) return;
    const id = wc.id;
    let sh = activeShares.get(id);
    if (!sh) {
      sh = { origin, frames: new Set(), stopTimer: null };
      activeShares.set(id, sh);
      // A new document in the tab (did-navigate: main frame, committed, not in-page), a crash or closing the tab
      // ends every capture of that document.
      const end = () => shareEnded(id);
      wc.on('did-navigate', end);
      wc.once('destroyed', end);
      wc.once('render-process-gone', end);
      sh.off = () => {
        if (wc.isDestroyed()) return;
        wc.off('did-navigate', end);
        wc.off('destroyed', end);
        wc.off('render-process-gone', end);
      };
    }
    sh.frames.add(frameKey);
    api.broadcast('browser:display-share', { sourceId: id, origin: sh.origin, active: true });
  }
  function shareEnded(id) {
    const sh = activeShares.get(id);
    if (!sh) return;
    activeShares.delete(id);
    clearTimeout(sh.stopTimer);
    sh.off?.();
    api.broadcast('browser:display-share', { sourceId: id, origin: sh.origin, active: false });
  }
  // From guest-preload.js: the page's shared tracks are live (true) or have all ended (false).
  function onShareState(wc, event, live) {
    const sh = activeShares.get(wc.id);
    if (!sh) return;
    const key = frameKeyOf(event.senderFrame);
    if (live) sh.frames.add(key);
    else {
      sh.frames.delete(key);
      if (!sh.frames.size) shareEnded(wc.id);
    }
  }
  function finishShare(id, chosen) {
    const p = pendingShares.get(id);
    if (!p) return false;
    pendingShares.delete(id);
    clearTimeout(p.timer);
    const src = chosen ? p.sources.find((x) => x.id === chosen) : null;
    if (src && p.wc && !p.wc.isDestroyed()) {
      try {
        p.callback({ video: src });
        shareStarted(p.wc, p.frameKey, p.origin);
      } catch (err) {
        console.warn('[browser] display media answer failed', err?.message || err);
      }
    } else deny(p.callback);
    api.broadcast('browser:display-media-done', { id });
    return true;
  }
  // desktopCapturer on X11: a window enumeration running at the same time as a screen enumeration makes the
  // screen capturer fail ("screen_capturer_x11: Failed to initialize pixel buffer") and the screen list comes
  // back empty, and getSources({ types: ['screen', 'window'] }) does exactly that, intermittently (more often
  // under load). So: screens alone first (retried once), then windows, never two enumerations at once (queue);
  // the picker does not wait more than WINDOW_WAIT for windows (X11 without a window list takes 3 s to give up).
  const WINDOW_WAIT = 1200;
  let capturerQueue = Promise.resolve();
  const capture = (types) => {
    const run = capturerQueue.then(() => {
      const { desktopCapturer } = require('electron');
      return desktopCapturer.getSources({ types, thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: false });
    });
    capturerQueue = run.catch(() => []);
    return run.catch((err) => {
      console.warn(`[browser] desktopCapturer (${types}) failed`, err?.message || err);
      return [];
    });
  };
  async function listSources() {
    let screens = await capture(['screen']);
    if (!screens.length) screens = await new Promise((r) => setTimeout(r, 150)).then(() => capture(['screen']));
    const windows = await Promise.race([capture(['window']), new Promise((r) => setTimeout(() => r([]), WINDOW_WAIT))]);
    return [...screens, ...windows];
  }
  async function onDisplayMedia(request, callback) {
    try {
      let wc = null;
      try {
        wc = request.frame ? webContents.fromFrame(request.frame) : null;
      } catch {}
      const origin = originOf(request.securityOrigin || request.frame?.url || wc?.getURL?.() || '');
      if (!wc || !origin) {
        console.warn(`[browser] display media request refused: ${!wc ? 'no tab for the frame' : 'no origin'}`);
        return deny(callback);
      }
      const sources = await listSources();
      if (api.DEV) console.log(`[browser] display media request from ${origin} (tab ${wc.id}): ${sources.length} source(s)`);
      if (!sources.length || wc.isDestroyed()) {
        console.warn('[browser] display media request refused: no screen or window to share');
        return deny(callback);
      }
      const id = `d${++seq}`;
      const timer = setTimeout(() => finishShare(id, null), 120000);
      pendingShares.set(id, { callback, sources, timer, wc, frameKey: frameKeyOf(request.frame), origin });
      api.broadcast('browser:display-media', {
        id,
        sourceId: wc.id,
        origin,
        sources: sources.map((x) => ({ id: x.id, name: String(x.name || '').slice(0, 200), kind: x.id.startsWith('screen:') ? 'screen' : 'window', thumb: x.thumbnail && !x.thumbnail.isEmpty() ? x.thumbnail.toDataURL() : '' })),
      });
    } catch (err) {
      console.warn('[browser] display media request failed', err?.message || err);
      deny(callback);
    }
  }
  api.handle('browser:displayMediaReply', (id, sourceId) => finishShare(String(id || ''), typeof sourceId === 'string' ? sourceId : null));
  api.handle('browser:stopShare', (sourceId) => {
    const id = Number(sourceId);
    const sh = activeShares.get(id);
    const wc = webContents.fromId(id);
    if (!sh || !wc || wc.isDestroyed()) {
      shareEnded(id);
      return true;
    }
    for (const f of wc.mainFrame?.framesInSubtree || []) {
      try {
        f.send('browser:share-stop');
      } catch {}
    }
    clearTimeout(sh.stopTimer);
    sh.stopTimer = setTimeout(() => {
      if (activeShares.get(id) !== sh || wc.isDestroyed()) return;
      console.warn('[browser] the page did not end its screen capture: reloading the tab');
      wc.reload();
    }, 1500);
    return true;
  });
  api.handle('browser:activeShares', () => [...activeShares].map(([sourceId, sh]) => ({ sourceId, origin: sh.origin })));
  // Note: the IPC layer appends the event as the last argument, so optional parameters are type-checked.
  const optPartition = (p) => (typeof p === 'string' && validPartition(p) ? p : PERSIST);
  api.handle('browser:sitePermissions', (partition) => {
    const part = optPartition(partition);
    return isPrivate(part) ? privatePerms.get(part) || {} : sitePerms;
  });
  api.handle('browser:resetSitePermissions', (origin, partition) => {
    const part = optPartition(partition);
    const store = permStore(part);
    if (typeof origin === 'string' && origin) delete store[origin];
    else for (const k of Object.keys(store)) delete store[k];
    if (!isPrivate(part)) saveSitePerms();
    return true;
  });

  // ------------------------------------------------------------------ HTTP authentication
  app.on('login', (event, wc, details, authInfo, callback) => {
    if (!wc || wc.isDestroyed?.() || !partitionOf.has(wc.session) || (wc.getType() !== 'webview' && !popupRoute.has(wc.id))) return;
    event.preventDefault();
    const id = `a${++seq}`;
    const timer = setTimeout(() => cancelAuth(id), 300000);
    pendingAuth.set(id, { callback, timer, wcId: wc.id });
    api.broadcast('browser:auth', {
      id,
      sourceId: routeOf(wc.id),
      url: details?.url || '',
      host: authInfo?.host || hostOf(details?.url || ''),
      realm: authInfo?.realm || '',
      isProxy: !!authInfo?.isProxy,
    });
  });
  // ------------------------------------------------------------------ page dialogs (alert / confirm / prompt)
  const pendingDialogs = new Map(); // id -> { event, wcId, kind }
  const dialogState = new Map(); // wc.id -> { count, suppressed } since the last navigation
  const dialogDefault = (kind) => (kind === 'confirm' ? false : kind === 'prompt' ? null : true);

  function onJsDialog(wc, event, p) {
    const kind = ['alert', 'confirm', 'prompt'].includes(p.kind) ? p.kind : 'alert';
    const st = dialogState.get(wc.id) || { count: 0, suppressed: false };
    dialogState.set(wc.id, st);
    if (st.suppressed || wc.isDestroyed()) {
      event.returnValue = dialogDefault(kind);
      return;
    }
    st.count++;
    const id = `j${++seq}`;
    pendingDialogs.set(id, { event, wcId: wc.id, kind });
    let frameUrl = '';
    try {
      frameUrl = event.senderFrame?.url || '';
    } catch {}
    api.broadcast('browser:js-dialog', {
      id,
      sourceId: routeOf(wc.id),
      kind,
      message: String(p.message || '').slice(0, 10000),
      def: String(p.def || '').slice(0, 2000),
      origin: originOf(frameUrl || wc.getURL()),
      offerSuppress: st.count > 1,
    });
  }

  function finishDialog(id, { ok = false, value = null, suppress = false } = {}) {
    const d = pendingDialogs.get(id);
    if (!d) return false;
    pendingDialogs.delete(id);
    if (suppress) {
      const st = dialogState.get(d.wcId);
      if (st) st.suppressed = true;
    }
    let ret = dialogDefault(d.kind);
    if (ok && d.kind === 'confirm') ret = true;
    if (ok && d.kind === 'prompt') ret = String(value ?? '');
    try {
      d.event.returnValue = ret;
    } catch {}
    api.broadcast('browser:js-dialog-done', { id });
    return true;
  }
  function cancelDialogsFor(wcId) {
    for (const [id, d] of pendingDialogs) if (d.wcId === wcId) finishDialog(id);
  }
  api.handle('browser:jsDialogReply', (id, answer) => finishDialog(id, answer && typeof answer === 'object' ? answer : {}));

  // The request went away (timeout, tab navigated or closed): answer it and close the app's dialog.
  function cancelAuth(id) {
    const p = pendingAuth.get(id);
    if (!p) return;
    pendingAuth.delete(id);
    clearTimeout(p.timer);
    try {
      p.callback();
    } catch {}
    api.broadcast('browser:auth-done', { id });
  }
  function cancelAuthFor(wcId) {
    for (const [id, p] of pendingAuth) if (p.wcId === wcId) cancelAuth(id);
  }

  api.handle('browser:authReply', (id, creds) => {
    const p = pendingAuth.get(id);
    if (!p) return false;
    pendingAuth.delete(id);
    clearTimeout(p.timer);
    if (creds && typeof creds.username === 'string') p.callback(creds.username, String(creds.password || ''));
    else p.callback();
    return true;
  });

  // ------------------------------------------------------------------ misc
  api.handle('browser:initPartition', (partition) => {
    const ses = setup(partition);
    return { ua: ses.getUserAgent() };
  });

  api.handle('browser:disposePartition', async (partition) => {
    if (!PRIVATE_RE.test(String(partition || ''))) return false;
    const ses = sessions.get(partition);
    privatePerms.delete(partition);
    for (const [id, d] of downloads) if (d.partition === partition && d.done) downloads.delete(id);
    if (!ses) return true;
    await ses.clearStorageData().catch(() => {});
    await ses.clearCache().catch(() => {});
    await ses.clearAuthCache?.().catch?.(() => {});
    return true;
  });

  api.handle('browser:setPrefs', (p = {}) => {
    const langChanged = p.lang && p.lang !== prefs.lang;
    prefs = { ...prefs, ...p };
    for (const ses of sessions.values()) {
      if (langChanged) ses.setUserAgent(identity.userAgent(), acceptLanguages(prefs.lang));
      applyWebRequest(ses);
    }
    if (langChanged) refreshIdentity();
    return prefs;
  });

  api.handle('browser:info', () => ({
    chrome: process.versions.chrome,
    electron: process.versions.electron,
    v8: process.versions.v8,
    ua: sessions.get(PERSIST)?.getUserAgent() || '',
    hints: identity.hintValues(),
  }));

  api.handle('browser:clearData', async ({ partition = PERSIST, cookies = false, cache = false, origin } = {}) => {
    const ses = setup(partition);
    if (cookies) {
      const opts = {
        storages: ['cookies', 'filesystem', 'indexdb', 'localstorage', 'shadercache', 'websql', 'serviceworkers', 'cachestorage'],
      };
      if (origin) opts.origin = originOf(origin);
      await ses.clearStorageData(opts);
    }
    if (cache && !origin) {
      await ses.clearCache();
      await ses.clearHostResolverCache?.();
    }
    if (cookies && !origin) faviconCache.clear();
    return true;
  });

  api.handle('browser:favicon', async (url, partitionArg) => {
    const partition = typeof partitionArg === 'string' ? partitionArg : PERSIST;
    const u = String(url || '');
    if (/^data:image\//i.test(u)) return u.length < 300000 ? u : null;
    if (!/^https?:\/\//i.test(u)) return null;
    if (faviconCache.has(u)) return faviconCache.get(u);
    const ses = sessions.get(partition) || sessions.get(PERSIST);
    try {
      const res = await ses.fetch(u, { signal: AbortSignal.timeout(10000), credentials: 'omit', cache: 'force-cache' });
      if (!res.ok) throw new Error(String(res.status));
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length || buf.length > 256 * 1024) throw new Error('size');
      let type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!type.startsWith('image/')) {
        if (buf[0] === 0x89 && buf[1] === 0x50) type = 'image/png';
        else if (buf[0] === 0 && buf[1] === 0 && buf[2] === 1) type = 'image/x-icon';
        else if (buf[0] === 0x47 && buf[1] === 0x49) type = 'image/gif';
        else if (buf[0] === 0xff && buf[1] === 0xd8) type = 'image/jpeg';
        else if (/^\s*(<\?xml|<svg)/i.test(buf.subarray(0, 200).toString('utf8'))) type = 'image/svg+xml';
        else if (buf.subarray(8, 12).toString() === 'WEBP') type = 'image/webp';
        else throw new Error('not an image');
      }
      const data = `data:${type};base64,${buf.toString('base64')}`;
      faviconCache.set(u, data);
      if (faviconCache.size > 600) faviconCache.delete(faviconCache.keys().next().value);
      return data;
    } catch {
      faviconCache.set(u, null);
      return null;
    }
  });

  // Back / forward list of a tab (long-press or right-click on the arrows), with page titles.
  api.handle('browser:navHistory', (sourceId) => {
    const wc = guest(sourceId);
    const nh = wc.navigationHistory;
    const entries = safe(() => nh.getAllEntries(), []).map((e) => ({ url: String(e.url || ''), title: String(e.title || '') }));
    return { index: safe(() => nh.getActiveIndex(), entries.length - 1), entries };
  });

  api.handle('browser:copyImageAt', (sourceId, x, y) => {
    guest(sourceId).copyImageAt(Math.round(x), Math.round(y));
    return true;
  });

  api.handle('browser:inspect', (sourceId, x, y) => {
    if (!api.DEV) throw api.error('Developer tools are disabled', 'EPERM');
    const wc = guest(sourceId);
    if (typeof x !== 'number' || typeof y !== 'number') wc.openDevTools({ mode: 'detach' });
    else wc.inspectElement(Math.round(x), Math.round(y));
    return true;
  });
};
