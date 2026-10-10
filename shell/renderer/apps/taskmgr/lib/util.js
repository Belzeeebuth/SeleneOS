// Shared helpers for Task Manager: number/size formatting, process classification, icons.
import { h, icon } from '../../../core/ui.js';

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function debounce(fn, ms) {
  let tm = null;
  const d = (...a) => {
    clearTimeout(tm);
    tm = setTimeout(() => fn(...a), ms);
  };
  d.flush = (...a) => {
    clearTimeout(tm);
    fn(...a);
  };
  return d;
}

// Formatting bound to the current language (units come from i18n.json: u.*).
export function createFormat(ctx) {
  const { t, i18n } = ctx;
  const cache = new Map();
  const nf = (min, max) => {
    const key = `${i18n.locale}|${min}|${max}`;
    let f = cache.get(key);
    if (!f) {
      f = new Intl.NumberFormat(i18n.locale, { minimumFractionDigits: min, maximumFractionDigits: max });
      cache.set(key, f);
    }
    return f;
  };
  const num = (v, min = 0, max = min) => nf(min, max).format(Number.isFinite(v) ? v : 0);
  const pctSign = () => t('u.pct');
  const withUnit = (n, unit) => `${n} ${unit}`;
  const UNITS = () => [t('u.B'), t('u.KB'), t('u.MB'), t('u.GB'), t('u.TB')];
  const fmt = {
    num,
    int: (v) => num(Math.round(v || 0)),
    // 12 % style (French uses a non-breaking space before %, English does not).
    pct(v, d = 0) {
      return `${num(v, d, d)}${pctSign()}`;
    },
    // Processes/Details CPU cell: 0%, 0.1%, 12.3%
    cpu(v) {
      if (!v || v < 0.05) return `${num(0)}${pctSign()}`;
      return `${num(v, 1, 1)}${pctSign()}`;
    },
    // Processes memory column: always megabytes with one decimal (Windows style).
    mb(bytes) {
      return withUnit(num((bytes || 0) / 1048576, 1, 1), t('u.MB'));
    },
    // Details memory column: kilobytes.
    kb(bytes) {
      return withUnit(num(Math.round((bytes || 0) / 1024)), t('u.K'));
    },
    size(bytes, digits) {
      let v = Math.max(0, bytes || 0);
      let i = 0;
      const u = UNITS();
      while (v >= 1024 && i < u.length - 1) {
        v /= 1024;
        i++;
      }
      const d = digits ?? (i === 0 ? 0 : v < 10 ? 1 : v < 100 ? 1 : 0);
      return withUnit(num(v, i === 0 ? 0 : d, i === 0 ? 0 : d), u[i]);
    },
    // GB with one decimal: "3.2/15.7 GB"
    gbPair(a, b) {
      return withUnit(`${num(a / 1073741824, 1, 1)}/${num(b / 1073741824, 1, 1)}`, t('u.GB'));
    },
    // Processes disk column: MB/s with one decimal.
    mbps(bps) {
      return withUnit(num((bps || 0) / 1048576, 1, 1), t('u.MBs'));
    },
    rate(bps) {
      const v = Math.max(0, bps || 0);
      if (v < 1024 * 1024) return withUnit(num(v / 1024, v < 10240 ? 1 : 0, v < 10240 ? 1 : 0), t('u.KBs'));
      if (v < 1024 ** 3) return withUnit(num(v / 1048576, 1, 1), t('u.MBs'));
      return withUnit(num(v / 1024 ** 3, 1, 1), t('u.GBs'));
    },
    bits(bps) {
      const v = Math.max(0, bps || 0);
      if (v < 1e6) return withUnit(num(v / 1000, 1, 1), t('u.Kbps'));
      if (v < 1e9) return withUnit(num(v / 1e6, 1, 1), t('u.Mbps'));
      return withUnit(num(v / 1e9, 1, 1), t('u.Gbps'));
    },
    ghz(mhz) {
      return withUnit(num((mhz || 0) / 1000, 2, 2), t('u.GHz'));
    },
    ms(v) {
      return withUnit(num(v || 0, v && v < 10 ? 1 : 0, v && v < 10 ? 1 : 0), t('u.ms'));
    },
    // d:hh:mm:ss
    uptime(sec) {
      const s = Math.floor(sec || 0);
      const d = Math.floor(s / 86400);
      const hh = String(Math.floor((s % 86400) / 3600)).padStart(2, '0');
      const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
      const ss = String(s % 60).padStart(2, '0');
      return `${d}:${hh}:${mm}:${ss}`;
    },
    // h:mm:ss
    duration(sec) {
      const s = Math.floor(sec || 0);
      const hh = Math.floor(s / 3600);
      const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
      const ss = String(s % 60).padStart(2, '0');
      return `${hh}:${mm}:${ss}`;
    },
    date(ms) {
      return i18n.formatDate(ms, { dateStyle: 'medium', timeStyle: 'medium' });
    },
  };
  return fmt;
}

// Heat-map level 0..7 from a 0..1 share of the machine, on a square-root curve so small but
// noticeable usage still warms the cell (Windows: pale yellow -> orange).
export function heat(share) {
  if (!(share > 0)) return 0;
  return clamp(Math.ceil(Math.sqrt(clamp(share, 0, 1)) * 7), 1, 7);
}

// Niceness <-> Windows-style priority classes.
export const PRIORITIES = [
  { id: 'realtime', nice: -20 },
  { id: 'high', nice: -10 },
  { id: 'aboveNormal', nice: -5 },
  { id: 'normal', nice: 0 },
  { id: 'belowNormal', nice: 5 },
  { id: 'low', nice: 19 },
];
export function priorityOf(nice) {
  if (nice <= -15) return 'realtime';
  if (nice <= -8) return 'high';
  if (nice < 0) return 'aboveNormal';
  if (nice === 0) return 'normal';
  if (nice < 15) return 'belowNormal';
  return 'low';
}

// Processes that end the session (or the machine) when killed.
export const CRITICAL = new Set(['Xorg', 'Xwayland', 'X', 'greetd', 'systemd', 'systemd-logind', 'dbus-daemon', 'dbus-broker', 'aurora-session', 'aurora-xsession', 'aurora-xstart', 'login', 'gdm', 'lightdm', 'sddm']);

const SHELLS = new Set(['bash', 'sh', 'dash', 'zsh', 'fish', 'ksh', 'tcsh', 'csh', 'tmux', 'screen', 'node', 'python3', 'python', 'perl', 'ruby']);

// Icon element for a row descriptor: { src } (image URL) or { name, tone } (Fluent icon).
export function rowIcon(desc) {
  if (!desc) return h('span', { class: 'tm-ico' });
  if (desc.src) return h('span', { class: 'tm-ico' }, h('img', { src: desc.src, alt: '', draggable: false }));
  const el = icon(desc.name || 'app_generic', { filled: desc.filled });
  el.classList.add('tm-ico', `tone-${desc.tone || 'neutral'}`);
  return el;
}

export function processIcon(p, { system } = {}) {
  if (!p) return { name: 'app_generic' };
  if (p.kernel) return { name: 'developer_board', tone: 'kernel' };
  if (SHELLS.has(p.name) || SHELLS.has(p.comm)) return { name: 'window_console', tone: 'console' };
  if (system) return { name: 'window_settings', tone: 'system' };
  return { name: 'app_generic', tone: 'user' };
}

export function iconKey(desc) {
  return desc ? desc.src || `${desc.name}|${desc.tone || ''}|${desc.filled ? 1 : 0}` : '';
}

// Case-insensitive match for the search box: name, PID prefix, user, command line.
export function matcher(q) {
  const s = String(q || '').trim().toLowerCase();
  if (!s) return null;
  const isNum = /^\d+$/.test(s);
  return (fields) => {
    for (const f of fields) {
      if (f == null) continue;
      if (typeof f === 'number') {
        if (isNum && String(f).startsWith(s)) return true;
      } else if (String(f).toLowerCase().includes(s)) return true;
    }
    return false;
  };
}

export function compare(a, b) {
  if (typeof a === 'number' || typeof b === 'number') return (a || 0) - (b || 0);
  return String(a ?? '').localeCompare(String(b ?? ''), undefined, { sensitivity: 'base', numeric: true });
}

export function copyText(api, text) {
  return api.invoke('clipboard:writeText', text);
}
