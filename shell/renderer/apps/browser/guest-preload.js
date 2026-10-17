'use strict';
// Aurora Browser — session preload for web pages (browser partitions only, registered by
// main/ipc/browser.js). Runs sandboxed in an isolated world and exposes NOTHING to pages except
// working window.alert / confirm / prompt: they block the page (like in Chrome) until the user
// answers the app's dialog. The page never gets ipcRenderer or any other Aurora API.
const { contextBridge, ipcRenderer } = require('electron');

function ask(kind, message, def) {
  try {
    return ipcRenderer.sendSync('browser:js-dialog', {
      kind: String(kind),
      message: String(message ?? '').slice(0, 10000),
      def: String(def ?? '').slice(0, 2000),
    });
  } catch {
    return null;
  }
}

try {
  contextBridge.executeInMainWorld({
    func: (bridge) => {
      const define = (name, fn) => {
        try {
          Object.defineProperty(window, name, { value: fn, writable: true, configurable: true, enumerable: true });
        } catch {}
      };
      define('alert', function alert(message) {
        bridge('alert', arguments.length ? String(message) : '', '');
      });
      define('confirm', function confirm(message) {
        return bridge('confirm', arguments.length ? String(message) : '', '') === true;
      });
      define('prompt', function prompt(message, defaultValue) {
        const r = bridge('prompt', arguments.length ? String(message) : '', defaultValue === undefined ? '' : String(defaultValue));
        return typeof r === 'string' ? r : null;
      });
    },
    args: [ask],
  });
} catch {}

// window.chrome as in Google Chrome on a web page (chrome.app, chrome.csi, chrome.loadTimes): Electron leaves it empty,
// one of the signs sign-in pages use to spot an embedded browser. Only what is missing is added.
try {
  contextBridge.executeInMainWorld({
    func: () => {
      const c = window.chrome && typeof window.chrome === 'object' ? window.chrome : {};
      if (!window.chrome) Object.defineProperty(window, 'chrome', { value: c, writable: true, configurable: true, enumerable: true });
      const define = (name, value) => {
        if (!(name in c)) Object.defineProperty(c, name, { value, writable: true, configurable: true, enumerable: true });
      };
      const perf = () => (window.performance && performance.timing) || {};
      const nav = () => (window.performance && performance.getEntriesByType && performance.getEntriesByType('navigation')[0]) || {};
      define('app', {
        isInstalled: false,
        InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
        RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
        getDetails: function getDetails() {
          return null;
        },
        getIsInstalled: function getIsInstalled() {
          return false;
        },
        runningState: function runningState() {
          return 'cannot_run';
        },
      });
      define('csi', function csi() {
        const t = perf();
        return { onloadT: t.domContentLoadedEventEnd || Date.now(), pageT: performance.now(), startE: t.navigationStart || Date.now(), tran: 15 };
      });
      define('loadTimes', function loadTimes() {
        const t = perf();
        const n = nav();
        const s = (v) => (v || 0) / 1000;
        const proto = n.nextHopProtocol || 'http/1.1';
        return {
          commitLoadTime: s(t.responseStart),
          connectionInfo: proto,
          finishDocumentLoadTime: s(t.domContentLoadedEventEnd),
          finishLoadTime: s(t.loadEventEnd),
          firstPaintAfterLoadTime: 0,
          firstPaintTime: s(t.responseEnd),
          navigationType: 'Other',
          npnNegotiatedProtocol: proto === 'h2' || proto === 'h3' ? proto : 'unknown',
          requestTime: s(t.navigationStart),
          startLoadTime: s(t.navigationStart),
          wasAlternateProtocolAvailable: false,
          wasFetchedViaSpdy: proto === 'h2' || proto === 'h3',
          wasNpnNegotiated: proto === 'h2' || proto === 'h3',
        };
      });
    },
    args: [],
  });
} catch {}

// Screen sharing indicator (main/ipc/browser.js): tells the browser when the tracks this frame got from
// getDisplayMedia have all ended (the page stopped sharing), and ends them on « Arrêter le partage » (with an
// 'ended' event, like Chrome's « Arrêter le partage »). The page cannot reach these functions; the originals
// are kept at load time so a page redefining MediaStreamTrack / Set methods cannot fool the check.
let stopShares = null;
try {
  stopShares = contextBridge.executeInMainWorld({
    func: (report) => {
      const MD = window.MediaDevices && window.MediaDevices.prototype;
      const MST = window.MediaStreamTrack && window.MediaStreamTrack.prototype;
      if (!MD || !MST || typeof MD.getDisplayMedia !== 'function') return null;
      const call = Function.prototype.call.bind(Function.prototype.call);
      const orig = MD.getDisplayMedia;
      const origClone = MST.clone;
      const stop = MST.stop;
      const readyState = Object.getOwnPropertyDescriptor(MST, 'readyState').get;
      const getTracks = window.MediaStream.prototype.getTracks;
      const then = Promise.prototype.then;
      const dispatch = EventTarget.prototype.dispatchEvent;
      const Ev = window.Event;
      const S = Set.prototype;
      const [add, del, has, values] = [S.add, S.delete, S.has, S.values];
      const size = Object.getOwnPropertyDescriptor(S, 'size').get;
      const live = new Set();
      const list = () => [...call(values, live)];
      let timer = 0;
      const check = () => {
        for (const tr of list()) if (call(readyState, tr) === 'ended') call(del, live, tr);
        if (!call(size, live) && timer) {
          clearInterval(timer);
          timer = 0;
          report(false);
        }
      };
      const keep = (tr) => {
        call(add, live, tr);
        if (!timer) timer = setInterval(check, 1000);
      };
      const define = (obj, name, fn) => Object.defineProperty(obj, name, { value: fn, writable: true, configurable: true, enumerable: true });
      define(MD, 'getDisplayMedia', function getDisplayMedia(...args) {
        return call(then, call(orig, this, ...args), (stream) => {
          for (const tr of call(getTracks, stream)) keep(tr);
          report(true);
          return stream;
        });
      });
      // A clone of a shared track keeps the capture going.
      define(MST, 'clone', function clone() {
        const c = call(origClone, this);
        if (call(has, live, this)) keep(c);
        return c;
      });
      return () => {
        for (const tr of list()) {
          if (call(readyState, tr) === 'ended') continue;
          call(stop, tr);
          try {
            call(dispatch, tr, new Ev('ended'));
          } catch {}
        }
        check();
      };
    },
    args: [(live) => ipcRenderer.send('browser:share-state', live === true)],
  });
} catch {}
ipcRenderer.on('browser:share-stop', () => {
  try {
    if (typeof stopShares === 'function') stopShares();
  } catch {}
});
