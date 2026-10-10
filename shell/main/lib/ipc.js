'use strict';
// Minimal IPC framework shared by every main-process module in main/ipc/*.js.
//
// A module looks like:
//   module.exports = function register(api) {
//     api.handle('fs:list', async (dir) => {...});          // renderer: aurora.invoke('fs:list', dir)
//     api.broadcast('fs:changed', {...});                    // renderer: aurora.on('fs:changed', cb)
//     api.on('pty:write', (id, data) => {...});             // renderer: aurora.send('pty:write', id, data)
//   };
// Errors thrown by handlers reach the renderer as Error objects (message + code preserved).
const { ipcMain, BrowserWindow, webContents } = require('electron');
const fs = require('fs');
const path = require('path');

function createIpc({ env, getMainWindow, RENDERER, ROOT, DEV }) {
  const handlers = new Map();
  const listeners = new Map();

  ipcMain.handle('aurora:invoke', async (event, channel, args) => {
    const fn = handlers.get(channel);
    if (!fn) return { ok: false, error: { message: `No handler for ${channel}`, code: 'ENOHANDLER' } };
    try {
      const value = await fn(...(Array.isArray(args) ? args : []), event);
      return { ok: true, value };
    } catch (err) {
      if (DEV && !err?.quiet) console.error(`[ipc] ${channel} failed:`, err?.message || err);
      return { ok: false, error: { message: String(err?.message || err), code: err?.code || 'EFAIL' } };
    }
  });

  ipcMain.on('aurora:send', (event, channel, args) => {
    const set = listeners.get(channel);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(...(Array.isArray(args) ? args : []), event);
      } catch (err) {
        console.error(`[ipc] listener ${channel} failed:`, err);
      }
    }
  });

  // Synchronous env lookup used by the sandboxed preload as a fallback.
  ipcMain.on('aurora:env-sync', (event) => {
    event.returnValue = env;
  });

  const api = {
    env,
    DEV,
    RENDERER,
    ROOT,
    getMainWindow,
    handle(channel, fn) {
      if (handlers.has(channel)) console.warn(`[ipc] handler ${channel} redefined`);
      handlers.set(channel, fn);
    },
    on(channel, fn) {
      if (!listeners.has(channel)) listeners.set(channel, new Set());
      listeners.get(channel).add(fn);
    },
    // Send an event to every shell/greeter window (not to webviews).
    broadcast(channel, payload) {
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send('aurora:event', channel, payload);
      }
    },
    // Send to one specific renderer (e.g. the one that started a stream).
    sendTo(sender, channel, payload) {
      if (sender && !sender.isDestroyed()) sender.send('aurora:event', channel, payload);
    },
    webContents,
    // filter(fileName) -> boolean limits which modules load (the sign-in screen loads only a few).
    async loadModules(dir, filter = () => true) {
      const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.js') && filter(f)).sort() : [];
      for (const f of files) {
        try {
          const mod = require(path.join(dir, f));
          const reg = typeof mod === 'function' ? mod : mod.register;
          if (typeof reg === 'function') await reg(api);
        } catch (err) {
          console.error(`[ipc] failed to load module ${f}:`, err);
        }
      }
    },
    error(message, code) {
      const e = new Error(message);
      e.code = code;
      return e;
    },
  };
  return api;
}

module.exports = { createIpc };
