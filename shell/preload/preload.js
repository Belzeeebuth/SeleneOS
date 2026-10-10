'use strict';
// Exposes the `window.aurora` bridge to the shell / greeter renderer.
//   aurora.env                         -> { mode, dev, lang, user, home, hostname, live, version, ... }
//   aurora.invoke(channel, ...args)    -> Promise (rejects with Error{message, code})
//   aurora.on(channel, cb)             -> unsubscribe function
//   aurora.send(channel, ...args)      -> fire-and-forget message to main
//   aurora.mediaUrl(absPath)           -> 'media://local/...' URL usable in <img>/<video>/<audio>
//   aurora.pathForFile(file)           -> absolute path of a File from drag & drop
const { contextBridge, ipcRenderer, webUtils } = require('electron');

function readEnv() {
  const a = (process.argv || []).find((x) => x.startsWith('--aurora-env='));
  if (a) {
    try {
      return JSON.parse(atob(a.slice('--aurora-env='.length)));
    } catch {}
  }
  return ipcRenderer.sendSync('aurora:env-sync');
}

const env = Object.freeze(readEnv());
const subs = new Map();

ipcRenderer.on('aurora:event', (_e, channel, payload) => {
  const set = subs.get(channel);
  if (!set) return;
  for (const cb of [...set]) {
    try {
      cb(payload);
    } catch (err) {
      console.error(`[aurora] event handler for ${channel} failed`, err);
    }
  }
});

function encodePath(p) {
  return String(p)
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
}

contextBridge.exposeInMainWorld('aurora', {
  env,
  async invoke(channel, ...args) {
    const res = await ipcRenderer.invoke('aurora:invoke', channel, args);
    if (res && res.ok) return res.value;
    const err = new Error(res?.error?.message || 'IPC error');
    err.code = res?.error?.code || 'EFAIL';
    throw err;
  },
  // Same call, resolving to the raw result { ok: true, value } | { ok: false, error: { message, code } }.
  // Errors lose their custom properties (code) when they cross the context bridge, so core/api.js
  // builds the Error on the page side from this.
  invokeRaw(channel, ...args) {
    return ipcRenderer.invoke('aurora:invoke', channel, args);
  },
  on(channel, cb) {
    if (!subs.has(channel)) subs.set(channel, new Set());
    subs.get(channel).add(cb);
    return () => subs.get(channel)?.delete(cb);
  },
  send(channel, ...args) {
    ipcRenderer.send('aurora:send', channel, args);
  },
  mediaUrl(absPath) {
    return `media://local${encodePath(absPath)}`;
  },
  pathForFile(file) {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
});
