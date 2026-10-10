// Thin wrapper over the preload bridge (window.aurora). Import from apps as:
//   import { api, env } from '../../core/api.js';
//   const entries = await api.invoke('fs:list', dir);
//   const off = api.on('fs:changed', (e) => ...);
const bridge = window.aurora;

if (!bridge) {
  // Only happens if a page is opened outside Electron.
  console.error('[aurora] preload bridge missing');
}

function unwrapResult(res) {
  if (res && res.ok) return res.value;
  const err = new Error(res?.error?.message || 'IPC error');
  err.code = res?.error?.code || 'EFAIL';
  throw err;
}

export const env = bridge?.env || { mode: 'shell', dev: true, lang: 'en', user: 'user', home: '/home/user', live: false };

export const api = {
  // Rejects with an Error carrying `code` (ENOHANDLER, EAUTH, ENOENT…): built here because Error objects
  // lose their custom properties when they cross Electron's context bridge.
  invoke: (channel, ...args) => (bridge.invokeRaw ? bridge.invokeRaw(channel, ...args).then(unwrapResult) : bridge.invoke(channel, ...args)),
  on: (channel, cb) => bridge.on(channel, cb),
  send: (channel, ...args) => bridge.send(channel, ...args),
  mediaUrl: (p) => bridge.mediaUrl(p),
  pathForFile: (f) => bridge.pathForFile(f),
};

// Small event emitter used across the shell core.
export class Emitter {
  constructor() {
    this._h = new Map();
  }
  on(ev, fn) {
    if (!this._h.has(ev)) this._h.set(ev, new Set());
    this._h.get(ev).add(fn);
    return () => this.off(ev, fn);
  }
  once(ev, fn) {
    const off = this.on(ev, (...a) => {
      off();
      fn(...a);
    });
    return off;
  }
  off(ev, fn) {
    this._h.get(ev)?.delete(fn);
  }
  emit(ev, ...args) {
    for (const fn of [...(this._h.get(ev) || [])]) {
      try {
        fn(...args);
      } catch (err) {
        console.error(`[emitter] ${ev} handler failed`, err);
      }
    }
  }
}
