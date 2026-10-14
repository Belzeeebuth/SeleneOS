// Shared helpers for the Network tools tabs.

/** 'hostname' | 'ipv4' | 'ipv6' | null — mirror of the backend's hostKind (main/ipc/nettools.js), which has the last word. */
export function hostKind(s) {
  if (typeof s !== 'string' || !s || s.length > 253) return null;
  if (/^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(s)) return 'ipv4';
  if (s.includes(':')) return /^[0-9a-fA-F:.]+$/.test(s) && /^(?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F.]{0,15}$/.test(s) ? 'ipv6' : null;
  if (/^[\d.]+$/.test(s)) return null;
  return s.split('.').every((l) => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(l)) ? 'hostname' : null;
}

export const errMsg = (e) => String(e?.message || e || '').slice(0, 300);

/** Number formatter for the current language: fmt(12.345, 1) -> "12.3" / "12,3". */
export function numberFormat(ctx) {
  const cache = new Map();
  return (v, digits = 1) => {
    if (v == null || !Number.isFinite(Number(v))) return '–';
    const key = `${ctx.i18n?.locale || 'en-US'}|${digits}`;
    if (!cache.has(key)) cache.set(key, new Intl.NumberFormat(ctx.i18n?.locale || 'en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits }));
    return cache.get(key).format(Number(v));
  };
}

/** Copy text through the backend clipboard; the button's tooltip says « Copied ». */
export async function copyText(ctx, text, btn, copiedLabel) {
  try {
    await ctx.api.invoke('clipboard:writeText', text);
    if (btn && copiedLabel) btn.setAttribute('data-tip', copiedLabel);
    return true;
  } catch {
    return false;
  }
}

/**
 * Buffer stream events that arrive before the invoke reply gives us the id (ping, traceroute, speed test).
 * stream.start() before invoking, stream.attach(id) after, stream.handle(ev) from api.on.
 */
export function eventStream(onEvent) {
  let id = null;
  let waiting = false;
  let early = [];
  return {
    get id() {
      return id;
    },
    start() {
      id = null;
      waiting = true;
      early = [];
    },
    attach(newId) {
      id = newId;
      waiting = false;
      const list = early.filter((ev) => ev.id === newId);
      early = [];
      list.forEach(onEvent);
    },
    abort() {
      waiting = false;
      early = [];
    },
    clear() {
      id = null;
    },
    handle(ev) {
      if (!ev) return;
      if (id == null) {
        if (waiting) early.push(ev);
        return;
      }
      if (ev.id === id) onEvent(ev);
    },
  };
}
