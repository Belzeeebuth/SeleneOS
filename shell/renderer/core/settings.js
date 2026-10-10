// Renderer-side settings cache (backed by main/ipc/settings.js).
//   import { settings } from '../../core/settings.js';
//   settings.get('theme')                   -> sync read from cache
//   await settings.set('theme', 'dark')     -> persists + notifies every listener
//   settings.on('theme', (value) => ...)    -> per-key subscription ('*' for any change)
import { api } from './api.js';

let cache = {};
const subs = new Map();

function getPath(obj, key) {
  if (!key) return obj;
  return key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function fire(key, value) {
  for (const [k, set] of subs) {
    if (k === '*' || k === key || key.startsWith(`${k}.`) || k.startsWith(`${key}.`) || key === '*') {
      for (const fn of [...set]) {
        try {
          fn(k === '*' ? value : getPath(cache, k), key);
        } catch (err) {
          console.error('[settings] listener failed', err);
        }
      }
    }
  }
}

export const settings = {
  async load() {
    cache = await api.invoke('settings:all');
    api.on('settings:changed', ({ key, all }) => {
      cache = all;
      fire(key, getPath(all, key));
    });
    return cache;
  },
  get(key) {
    return getPath(cache, key);
  },
  all() {
    return cache;
  },
  async set(key, value) {
    return api.invoke('settings:set', key, value);
  },
  async reset(key) {
    return api.invoke('settings:reset', key);
  },
  on(key, fn) {
    if (!subs.has(key)) subs.set(key, new Set());
    subs.get(key).add(fn);
    return () => subs.get(key)?.delete(fn);
  },
};
