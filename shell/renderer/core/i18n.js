// Internationalisation (English + French).
//   import { i18n, t } from '../../core/i18n.js';
//   t('common.ok')                       -> "OK" / "OK"
//   t('files.itemCount', { count: 3 })   -> picks 'files.itemCount_one' / '_other' when present, fills {count}
//   i18n.name({ en: 'Paint', fr: 'Paint' })  -> localized string from an {en, fr} object
//   i18n.on('change', (lang) => ...)     -> re-render on language switch
// Dictionaries: core/i18n/en.json, core/i18n/fr.json (flat or nested objects).
// Apps get a scoped ctx.t() that also searches apps/<id>/i18n.json ({ "en": {...}, "fr": {...} }).
import { Emitter } from './api.js';

export const LANGS = [
  { id: 'en', name: 'English', native: 'English', locale: 'en-US' },
  { id: 'fr', name: 'French', native: 'Français', locale: 'fr-FR' },
];

const dicts = { en: {}, fr: {} };
const emitter = new Emitter();
let current = 'en';

function lookup(dict, key) {
  if (!dict) return undefined;
  if (Object.prototype.hasOwnProperty.call(dict, key)) return dict[key];
  let o = dict;
  for (const part of key.split('.')) {
    if (o == null || typeof o !== 'object') return undefined;
    o = o[part];
  }
  return o;
}

function deepAssign(target, src) {
  for (const [k, v] of Object.entries(src || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (!target[k] || typeof target[k] !== 'object') target[k] = {};
      deepAssign(target[k], v);
    } else target[k] = v;
  }
}

function interpolate(str, vars) {
  if (!vars || typeof str !== 'string') return str;
  return str.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));
}

function resolve(dictsInOrder, key, vars) {
  const count = vars?.count;
  for (const lang of [current, 'en']) {
    for (const d of dictsInOrder) {
      const dict = d[lang];
      if (count !== undefined) {
        const cat = new Intl.PluralRules(localeOf(lang)).select(count);
        const p = lookup(dict, `${key}_${cat}`) ?? lookup(dict, `${key}_other`);
        if (typeof p === 'string') return interpolate(p, vars);
      }
      const v = lookup(dict, key);
      if (typeof v === 'string') return interpolate(v, vars);
    }
  }
  return key;
}

function localeOf(lang) {
  return LANGS.find((l) => l.id === lang)?.locale || 'en-US';
}

export function t(key, vars) {
  return resolve([dicts], key, vars);
}

export const i18n = {
  get lang() {
    return current;
  },
  get locale() {
    return localeOf(current);
  },
  langs: LANGS,
  t,
  async load(base = 'core/i18n') {
    const [en, fr] = await Promise.all(
      ['en', 'fr'].map((l) =>
        fetch(`app://shell/${base}/${l}.json`)
          .then((r) => (r.ok ? r.json() : {}))
          .catch(() => ({})),
      ),
    );
    deepAssign(dicts.en, en);
    deepAssign(dicts.fr, fr);
  },
  /** Merge extra strings into the core dictionaries: i18n.extend({ en: {...}, fr: {...} }).
   *  Core feature modules bundle their own strings this way instead of editing en.json/fr.json. */
  extend(dict) {
    for (const lang of Object.keys(dict || {})) {
      if (!dicts[lang]) dicts[lang] = {};
      deepAssign(dicts[lang], dict[lang]);
    }
  },
  setLang(lang) {
    const next = LANGS.some((l) => l.id === lang) ? lang : 'en';
    if (next === current) return;
    current = next;
    document.documentElement.lang = current;
    emitter.emit('change', current);
  },
  init(lang) {
    current = LANGS.some((l) => l.id === lang) ? lang : 'en';
    document.documentElement.lang = current;
  },
  on: (ev, fn) => emitter.on(ev, fn),
  /** Localize an {en, fr} object (or return a plain string unchanged). */
  name(obj) {
    if (obj == null) return '';
    if (typeof obj === 'string') return obj;
    return obj[current] ?? obj.en ?? Object.values(obj)[0] ?? '';
  },
  /** Create a t() that searches an app dictionary ({en:{}, fr:{}}) first, then core. */
  scoped(appDict) {
    const scope = [appDict || {}, dicts];
    return (key, vars) => resolve(scope, key, vars);
  },
  formatDate(d, opts = { dateStyle: 'medium' }) {
    return new Intl.DateTimeFormat(localeOf(current), opts).format(d instanceof Date ? d : new Date(d));
  },
  formatTime(d, opts = { hour: '2-digit', minute: '2-digit' }) {
    return new Intl.DateTimeFormat(localeOf(current), opts).format(d instanceof Date ? d : new Date(d));
  },
  formatNumber(n, opts) {
    return new Intl.NumberFormat(localeOf(current), opts).format(n);
  },
  formatSize(bytes) {
    if (bytes == null || Number.isNaN(bytes)) return '';
    const units = current === 'fr' ? ['o', 'Ko', 'Mo', 'Go', 'To'] : ['bytes', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = bytes;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    // "1 byte" / "2 bytes" (English plural); French "o" is invariable.
    const unit = i === 0 && current !== 'fr' && v === 1 ? 'byte' : units[i];
    return `${new Intl.NumberFormat(localeOf(current), { maximumFractionDigits: i === 0 ? 0 : v < 10 ? 1 : 0 }).format(v)} ${unit}`;
  },
  relativeTime(ms) {
    const rtf = new Intl.RelativeTimeFormat(localeOf(current), { numeric: 'auto' });
    const diff = (ms - Date.now()) / 1000;
    const abs = Math.abs(diff);
    if (abs < 60) return rtf.format(Math.round(diff), 'second');
    if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
    if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
    return rtf.format(Math.round(diff / 86400), 'day');
  },
};
