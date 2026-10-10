// Media Player: small pure helpers (no DOM, importable from Node tests).
export const AUDIO_EXT = ['.mp3', '.wav', '.ogg', '.oga', '.opus', '.flac', '.m4a', '.aac'];
export const VIDEO_EXT = ['.mp4', '.m4v', '.webm', '.ogv', '.mkv', '.mov'];
export const MEDIA_EXT = [...AUDIO_EXT, ...VIDEO_EXT];

export function extOf(p) {
  const m = /\.[^./]+$/.exec(String(p || ''));
  return m ? m[0].toLowerCase() : '';
}
export function kindOf(p) {
  const e = extOf(p);
  if (AUDIO_EXT.includes(e)) return 'audio';
  if (VIDEO_EXT.includes(e)) return 'video';
  return null;
}
export const isMedia = (p) => kindOf(p) !== null;
export function baseName(p) {
  const s = String(p || '').replace(/\/+$/, '');
  return s.slice(s.lastIndexOf('/') + 1);
}
export function dirName(p) {
  const s = String(p || '').replace(/\/+$/, '');
  const i = s.lastIndexOf('/');
  return i <= 0 ? '/' : s.slice(0, i);
}
export function stem(p) {
  const b = baseName(p);
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(0, i) : b;
}

/** Guess { title, artist, track } from a file name like "01 - Artist - Title.mp3". */
export function guessFromName(p) {
  let s = stem(p).replace(/_/g, ' ').trim();
  let track = null;
  const tm = /^(\d{1,3})\s*(?:[-.)]\s*|\s+)(.+)$/.exec(s);
  if (tm && Number(tm[1]) < 300) {
    track = Number(tm[1]);
    s = tm[2];
  }
  const parts = s.split(/\s+[-–—]\s+/);
  if (parts.length >= 2) return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim(), track };
  return { artist: null, title: s, track };
}

/** 75.4 -> "1:15", 3725 -> "1:02:05". Non-finite -> "0:00". */
export function formatTime(sec, { hours = false } = {}) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const ss = String(s).padStart(2, '0');
  if (h > 0 || hours) return `${h}:${String(m).padStart(2, '0')}:${ss}`;
  return `${m}:${ss}`;
}

/** FNV-1a 32-bit hash -> 8 hex chars. Accepts a string or a Uint8Array. */
export function hash(input) {
  let h = 0x811c9dc5;
  if (typeof input === 'string') {
    for (let i = 0; i < input.length; i++) {
      h ^= input.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  } else {
    const step = input.length > 262144 ? Math.ceil(input.length / 131072) : 1;
    for (let i = 0; i < input.length; i += step) {
      h ^= input[i];
      h = Math.imul(h, 0x01000193);
    }
    h ^= input.length;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

export function debounce(fn, ms) {
  let t = null;
  const d = (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
  d.flush = (...a) => {
    clearTimeout(t);
    fn(...a);
  };
  d.cancel = () => clearTimeout(t);
  return d;
}

/** Locale-aware comparison that keeps "Track 2" before "Track 10". */
export function compareText(a, b, locale) {
  return String(a ?? '').localeCompare(String(b ?? ''), locale, { numeric: true, sensitivity: 'base' });
}

/** Run async fn over items with at most `n` in flight. Returns when all settle. */
export async function pool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        await fn(items[idx], idx);
      } catch {}
    }
  });
  await Promise.all(workers);
}

/** Two pleasant gradient colours derived from a string (for generated artwork). */
export function artColors(key) {
  const h = parseInt(hash(String(key || '')), 16);
  const hue = h % 360;
  const hue2 = (hue + 35 + ((h >>> 9) % 50)) % 360;
  return [`hsl(${hue} 56% 56%)`, `hsl(${hue2} 62% 40%)`, hue];
}
