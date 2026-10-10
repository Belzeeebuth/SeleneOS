// Exact rational numbers on BigInt (numerator / denominator) + Windows-style decimal formatting.
//
// Like the Windows calculator engine (ratpak), + − × ÷ are exact: 0.1 + 0.2 = 0.3, 1 ÷ 3 × 3 = 1.
// Transcendental functions (sin, ln, …) are computed in double precision and rounded to 15
// significant digits so artefacts such as 0.49999999999999994 never reach the display.
// Pure module: no DOM, importable from Node for tests.

export class CalcError extends Error {
  /** code: 'divzero' | 'undefined' | 'invalid' | 'overflow' */
  constructor(code) {
    super(code);
    this.code = code;
    this.calcError = true;
  }
}

const MAX_EXP = 10000; // |x| >= 1e10000 (or nonzero |x| < 1e-10000) -> "Overflow"
const LIMIT_BITS = 4096; // denominators larger than this get rounded to APPROX_DIGITS
const APPROX_DIGITS = 64;
const pow10Cache = new Map();

export function pow10(k) {
  let v = pow10Cache.get(k);
  if (v === undefined) {
    v = 10n ** BigInt(k);
    if (k <= 4096) pow10Cache.set(k, v);
  }
  return v;
}

function babs(a) {
  return a < 0n ? -a : a;
}

function gcd(a, b) {
  a = babs(a);
  b = babs(b);
  while (b) [a, b] = [b, a % b];
  return a;
}

export function bitLen(a) {
  a = babs(a);
  if (a === 0n) return 0;
  const hex = a.toString(16);
  return (hex.length - 1) * 4 + (32 - Math.clz32(parseInt(hex[0], 16)));
}

function decLen(a) {
  return babs(a).toString().length;
}

/** floor(N^(1/k)) for N >= 0 (integer Newton iteration). */
export function iroot(N, k) {
  if (N < 2n) return N;
  const K = BigInt(k);
  let x = 1n << BigInt(Math.ceil(bitLen(N) / k));
  for (;;) {
    const y = ((K - 1n) * x + N / x ** (K - 1n)) / K;
    if (y >= x) return x;
    x = y;
  }
}

export class Num {
  constructor(n, d = 1n) {
    this.n = n;
    this.d = d;
  }

  /** Build a normalised Num (reduces, checks range, trims runaway precision). */
  static make(n, d = 1n) {
    if (d === 0n) throw new CalcError(n === 0n ? 'undefined' : 'divzero');
    if (d < 0n) {
      n = -n;
      d = -d;
    }
    if (n === 0n) return ZERO;
    const g = gcd(n, d);
    if (g !== 1n) {
      n /= g;
      d /= g;
    }
    const x = new Num(n, d);
    x.checkRange();
    if (d > 1n && bitLen(d) > LIMIT_BITS) return x.approx(APPROX_DIGITS);
    return x;
  }

  static of(v) {
    if (v instanceof Num) return v;
    if (typeof v === 'bigint') return Num.make(v, 1n);
    if (typeof v === 'number') {
      if (Number.isInteger(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER) return Num.make(BigInt(v), 1n);
      return Num.fromDouble(v, 17);
    }
    const p = Num.parse(String(v));
    if (!p) throw new Error(`Bad number: ${v}`);
    return p;
  }

  /** Parse "-123.45e-6" or "a/b" (canonical form: '.' decimal point, no grouping). null if invalid. */
  static parse(str) {
    const s = String(str).trim();
    if (s.includes('/')) {
      const [a, b] = s.split('/');
      const x = Num.parse(a);
      const y = Num.parse(b);
      return x && y ? x.div(y) : null;
    }
    const m = /^([+-])?(\d*)(?:\.(\d*))?(?:e([+-]?\d*))?$/i.exec(s);
    if (!m || (!m[2] && !m[3])) {
      if (m && (m[2] === '' || m[2] === undefined) && m[3] === '') return ZERO; // "."
      return null;
    }
    const int = m[2] || '';
    const frac = m[3] || '';
    let exp = m[4] && m[4] !== '+' && m[4] !== '-' ? parseInt(m[4], 10) : 0;
    if (!Number.isFinite(exp)) return null;
    let n = BigInt((int + frac).replace(/^0+(?=\d)/, '') || '0');
    if (m[1] === '-') n = -n;
    exp -= frac.length;
    if (n === 0n) return ZERO;
    if (exp > MAX_EXP + 40) throw new CalcError('overflow');
    if (exp < -(MAX_EXP + 80)) throw new CalcError('overflow');
    return exp >= 0 ? Num.make(n * pow10(exp), 1n) : Num.make(n, pow10(-exp));
  }

  /** From a double, rounded to `sig` significant digits (15 by default, like Windows' display of irrationals). */
  static fromDouble(x, sig = 15) {
    if (Number.isNaN(x)) throw new CalcError('invalid');
    if (!Number.isFinite(x)) throw new CalcError('overflow');
    if (x === 0) return ZERO;
    return Num.parse(x.toPrecision(sig));
  }

  /** Rational a/b from two bigints / numbers. */
  static frac(a, b) {
    return Num.make(BigInt(a), BigInt(b));
  }

  get sign() {
    return this.n === 0n ? 0 : this.n < 0n ? -1 : 1;
  }
  isZero() {
    return this.n === 0n;
  }
  isNeg() {
    return this.n < 0n;
  }
  isInt() {
    return this.d === 1n;
  }

  checkRange() {
    const nb = bitLen(this.n);
    const db = bitLen(this.d);
    const lim = 33219; // log2(10^10000) ~= 33219.28
    if (nb - db > lim + 2) throw new CalcError('overflow');
    if (nb - db >= lim - 2) {
      if (babs(this.n) >= this.d * pow10(MAX_EXP)) throw new CalcError('overflow');
    }
    if (db - nb > lim + 2) throw new CalcError('overflow');
    if (db - nb >= lim - 2) {
      if (babs(this.n) * pow10(MAX_EXP) < this.d) throw new CalcError('overflow');
    }
  }

  /** Round to `digits` significant digits (keeps the result rational with a power-of-ten denominator). */
  approx(digits) {
    const { neg, digits: ds, exp } = this.toSig(digits);
    const k = ds.length - 1 - exp;
    let n = BigInt(ds);
    if (neg) n = -n;
    const x = k >= 0 ? new Num(n, pow10(k)) : new Num(n * pow10(-k), 1n);
    const g = gcd(x.n, x.d);
    return g === 1n ? x : new Num(x.n / g, x.d / g);
  }

  neg() {
    return this.n === 0n ? this : new Num(-this.n, this.d);
  }
  abs() {
    return this.n < 0n ? new Num(-this.n, this.d) : this;
  }
  add(o) {
    o = Num.of(o);
    if (this.d === o.d) return Num.make(this.n + o.n, this.d);
    return Num.make(this.n * o.d + o.n * this.d, this.d * o.d);
  }
  sub(o) {
    return this.add(Num.of(o).neg());
  }
  mul(o) {
    o = Num.of(o);
    return Num.make(this.n * o.n, this.d * o.d);
  }
  div(o) {
    o = Num.of(o);
    if (o.n === 0n) throw new CalcError(this.n === 0n ? 'undefined' : 'divzero');
    return Num.make(this.n * o.d, this.d * o.n);
  }
  inv() {
    return ONE.div(this);
  }
  cmp(o) {
    o = Num.of(o);
    const l = this.n * o.d;
    const r = o.n * this.d;
    return l < r ? -1 : l > r ? 1 : 0;
  }
  eq(o) {
    return this.cmp(o) === 0;
  }
  floor() {
    let q = this.n / this.d;
    if (this.n < 0n && q * this.d !== this.n) q -= 1n;
    return Num.make(q, 1n);
  }
  ceil() {
    let q = this.n / this.d;
    if (this.n > 0n && q * this.d !== this.n) q += 1n;
    return Num.make(q, 1n);
  }
  trunc() {
    return Num.make(this.n / this.d, 1n);
  }
  /** Floored modulo (result has the sign of the divisor, like Windows' "mod"). */
  mod(o) {
    o = Num.of(o);
    if (o.isZero()) throw new CalcError('divzero');
    return this.sub(o.mul(this.div(o).floor()));
  }
  /** BigInt value (must be an integer). */
  toBigInt() {
    return this.n / this.d;
  }

  /** Exact integer power. */
  powInt(k) {
    k = BigInt(k);
    if (k === 0n) return ONE;
    if (this.n === 0n) {
      if (k < 0n) throw new CalcError('divzero');
      return ZERO;
    }
    const neg = k < 0n;
    const e = neg ? -k : k;
    if (babs(this.n) !== this.d) {
      // magnitude estimate to fail fast on overflow
      const l = this.log10Approx() * Number(e);
      if (Math.abs(l) > MAX_EXP + 1) throw new CalcError('overflow');
    } else if (this.n < 0n) {
      return e % 2n === 0n ? ONE : ONE.neg();
    } else return ONE;
    const r = Num.make(this.n ** e, this.d ** e);
    return neg ? r.inv() : r;
  }

  /** log10(|x|) as a double (works far beyond the double range). */
  log10Approx() {
    const a = babs(this.n);
    const la = decLen(a);
    const lb = decLen(this.d);
    const ma = Number(a.toString().slice(0, 17)) / 10 ** (Math.min(17, la) - 1);
    const mb = Number(this.d.toString().slice(0, 17)) / 10 ** (Math.min(17, lb) - 1);
    return la - 1 + Math.log10(ma) - (lb - 1) - Math.log10(mb);
  }

  toNumber() {
    const an = babs(this.n);
    if (an <= 9007199254740991n && this.d <= 9007199254740991n) return Number(this.n) / Number(this.d);
    const { neg, digits, exp } = this.toSig(20);
    return Number(`${neg ? '-' : ''}${digits[0]}.${digits.slice(1) || '0'}e${exp}`);
  }

  /**
   * Significant-digit decomposition, rounded half away from zero:
   * value = ±d.ddd × 10^exp with `digits` = "dddd" (no trailing zeros).
   */
  toSig(sig) {
    if (this.n === 0n) return { neg: false, digits: '0', exp: 0 };
    const neg = this.n < 0n;
    const a = babs(this.n);
    const b = this.d;
    let e = decLen(a) - decLen(b);
    // ensure 10^e <= a/b
    if (e >= 0 ? a < b * pow10(e) : a * pow10(-e) < b) e -= 1;
    const k = sig - 1 - e;
    let num = a;
    let den = b;
    if (k >= 0) num *= pow10(k);
    else den *= pow10(-k);
    let q = num / den;
    if ((num % den) * 2n >= den) q += 1n;
    let ds = q.toString();
    if (ds.length > sig) {
      ds = ds.slice(0, sig);
      e += 1;
    }
    ds = ds.replace(/0+$/, '') || '0';
    return { neg, digits: ds, exp: e };
  }

  /** Plain canonical string ("-1234.5", "1e-30" style avoided: always positional up to 40 digits). */
  toString() {
    return toPlain(this);
  }
}

export const ZERO = new Num(0n, 1n);
export const ONE = new Num(1n, 1n);
export const PI = Num.parse('3.14159265358979323846264338327950288419716939937510582097494459');
export const E = Num.parse('2.71828182845904523536028747135266249775724709369995957496696763');

/** Positional canonical string, used for clipboard copies and debugging. */
export function toPlain(x, sig = 32) {
  const { neg, digits, exp } = x.toSig(sig);
  if (digits === '0') return '0';
  let s;
  if (exp >= digits.length - 1) s = digits + '0'.repeat(exp - digits.length + 1);
  else if (exp >= 0) s = `${digits.slice(0, exp + 1)}.${digits.slice(exp + 1)}`;
  else s = `0.${'0'.repeat(-exp - 1)}${digits}`;
  if (exp > 40 || exp < -40) s = `${digits[0]}${digits.length > 1 ? `.${digits.slice(1)}` : ''}e${exp >= 0 ? '+' : ''}${exp}`;
  return (neg ? '-' : '') + s;
}

// ---------------------------------------------------------------- locale formatting

export const LOCALES = {
  en: { group: ',', decimal: '.' },
  fr: { group: ' ', decimal: ',' },
};

export function groupInt(int, sep, size = 3) {
  if (!sep || int.length <= size) return int;
  let out = '';
  for (let i = int.length; i > 0; i -= size) out = int.slice(Math.max(0, i - size), i) + (out ? sep + out : '');
  return out;
}

/**
 * Format like the Windows calculator display.
 *   sig: max significant digits (16), fe: force scientific notation,
 *   loc: { group, decimal }, grouping: digit grouping on/off.
 * Positional notation is used while the number fits in 16 digits; numbers >= 1e16 or with more than
 * two zeros after the decimal point that would not fit switch to "1.234e+20" / "1.e-17".
 */
export function formatNum(x, { sig = 16, fe = false, loc = LOCALES.en, grouping = true } = {}) {
  if (x.isZero()) return fe ? `0${loc.decimal}e+0` : '0';
  let { neg, digits, exp } = x.toSig(sig);
  let sci = fe || exp >= sig;
  if (!sci && exp < 0) {
    const zeros = -exp - 1;
    if (zeros + digits.length > sig) {
      if (zeros <= 2) {
        ({ neg, digits, exp } = x.toSig(sig - zeros));
      } else sci = true;
    }
  }
  const sgn = neg ? '-' : '';
  if (sci) {
    const mant = `${digits[0]}${loc.decimal}${digits.slice(1)}`;
    return `${sgn}${mant}e${exp >= 0 ? '+' : '-'}${Math.abs(exp)}`;
  }
  let int;
  let frac;
  if (exp >= 0) {
    int = digits.slice(0, exp + 1).padEnd(exp + 1, '0');
    frac = digits.slice(exp + 1);
  } else {
    int = '0';
    frac = '0'.repeat(-exp - 1) + digits;
  }
  return `${sgn}${grouping ? groupInt(int, loc.group) : int}${frac ? loc.decimal + frac : ''}`;
}

/** Format an entry being typed ("-1234.50", "2.5e-3", "7e+") keeping trailing zeros/point as typed. */
export function formatEntry(entry, { loc = LOCALES.en, grouping = true } = {}) {
  const m = /^(-?)(\d*)(\.?)(\d*)(?:e([+-])(\d*))?$/.exec(entry);
  if (!m) return entry;
  const [, sign, int, dot, frac, esign, edigits] = m;
  let s = `${sign}${grouping ? groupInt(int || '0', loc.group) : int || '0'}${dot ? loc.decimal : ''}${frac}`;
  if (esign) s += `${dot ? '' : loc.decimal}e${esign}${edigits || '0'}`;
  return s;
}

/**
 * Parse user-provided text (clipboard paste) in either locale: accepts "1,234.5", "1 234,5",
 * "1.234,5", "-3e5", "1.5E-3". Returns a Num or null.
 */
export function parseLoose(text, lang = 'en') {
  let s = String(text || '')
    .trim()
    .replace(/[   ' _]/g, '')
    .replace(/^−/, '-')
    .replace(/^\((.*)\)$/, '-$1');
  if (!s) return null;
  const em = /[eE]([+-]?\d+)$/.exec(s);
  let expPart = '';
  if (em) {
    expPart = `e${em[1]}`;
    s = s.slice(0, em.index);
  }
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    // the right-most separator is the decimal separator, the other one is grouping
    if (lastDot > lastComma) s = s.replace(/,/g, '');
    else s = s.replace(/\./g, '').replace(',', '.');
  } else if (lastComma >= 0) {
    const parts = s.split(',');
    // "1,234,567" -> grouping. A single comma is a decimal separator, except "1,234" in English.
    if (parts.length > 2 || (lang === 'en' && parts.length === 2 && parts[1].length === 3 && /^[+-]?\d{1,3}$/.test(parts[0]))) s = parts.join('');
    else s = s.replace(',', '.');
  } else if (lastDot >= 0 && s.split('.').length > 2) {
    s = s.replace(/\./g, '');
  }
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  try {
    return Num.parse(s + expPart);
  } catch {
    return null;
  }
}
