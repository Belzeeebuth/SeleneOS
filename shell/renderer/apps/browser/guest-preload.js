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
