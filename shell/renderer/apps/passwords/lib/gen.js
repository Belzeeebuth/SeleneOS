// Password / passphrase generator (crypto.getRandomValues, unbiased) and strength estimate.
import { WORDS } from './words.js';

export const SETS = {
  upper: 'ABCDEFGHJKLMNPQRSTUVWXYZ',
  lower: 'abcdefghijkmnopqrstuvwxyz',
  digits: '23456789',
  symbols: '!#$%&*+-=?@^_~.:;',
};

/** Uniform integer in [0, n). */
export function randInt(n) {
  if (n <= 1) return 0;
  const limit = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % n;
  }
}

/** opts: { length (4-128), upper, lower, digits, symbols } -> string with at least one character of each chosen set. */
export function generatePassword(opts = {}) {
  const length = Math.max(4, Math.min(128, Math.round(opts.length || 20)));
  let sets = ['upper', 'lower', 'digits', 'symbols'].filter((k) => opts[k] !== false).map((k) => SETS[k]);
  if (!sets.length) sets = [SETS.lower];
  const all = sets.join('');
  const out = sets.slice(0, length).map((s) => s[randInt(s.length)]);
  while (out.length < length) out.push(all[randInt(all.length)]);
  for (let i = out.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.join('');
}

/** opts: { words (3-12), separator, capitalize, number } -> passphrase. */
export function generatePassphrase(opts = {}) {
  const n = Math.max(3, Math.min(12, Math.round(opts.words || 5)));
  const sep = typeof opts.separator === 'string' ? opts.separator : '-';
  const words = [];
  for (let i = 0; i < n; i++) {
    let w = WORDS[randInt(WORDS.length)];
    if (opts.capitalize) w = w[0].toUpperCase() + w.slice(1);
    words.push(w);
  }
  if (opts.number) words[randInt(n)] += String(randInt(10));
  return words.join(sep);
}

/** Rough entropy estimate in bits and a 0-4 score (0 very weak … 4 very strong). */
export function strength(pw) {
  const s = String(pw || '');
  if (!s) return { bits: 0, score: 0 };
  let pool = 0;
  if (/[a-z]/.test(s)) pool += 26;
  if (/[A-Z]/.test(s)) pool += 26;
  if (/[0-9]/.test(s)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(s)) pool += 33;
  // Repeated characters and simple runs add little.
  let eff = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const p = s.charCodeAt(i - 1);
    if (i > 0 && (c === p || c === p + 1 || c === p - 1)) eff += 0.35;
    else eff += 1;
  }
  let bits = eff * Math.log2(Math.max(pool, 2));
  const lower = s.toLowerCase();
  if (/^(password|motdepasse|azerty|qwerty|123456|letmein|admin|welcome|bonjour|soleil)/.test(lower)) bits = Math.min(bits, 12);
  bits = Math.round(bits);
  const score = bits < 28 ? 0 : bits < 40 ? 1 : bits < 60 ? 2 : bits < 80 ? 3 : 4;
  return { bits, score };
}
