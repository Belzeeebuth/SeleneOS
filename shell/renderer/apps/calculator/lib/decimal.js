// Decimal number system used by the Standard and Scientific modes (values are exact rationals, see num.js).
// Provides the entry-editing rules (16-digit limit, decimal point, "exp" exponent entry), the binary
// operators and every unary function shown on the keypad.
import { Num, ZERO, ONE, PI, E, CalcError, iroot, pow10, bitLen } from './num.js';

const LN10 = Math.LN10;

// ---------------------------------------------------------------- entry editing
// Entry grammar (canonical, independent of the UI locale):  -?  int  (. frac)?  (e [+-] digits)?
function split(entry) {
  const m = /^(-?)(\d*)(\.?)(\d*)(?:e([+-])(\d*))?$/.exec(entry) || [];
  return { sign: m[1] || '', int: m[2] || '0', dot: m[3] || '', frac: m[4] || '', esign: m[5] || '', edigits: m[6] || '' };
}

export function makeEntryOps(maxDigits = 16) {
  return {
    validDigit: (d) => /^[0-9]$/.test(d),
    appendDigit(entry, d) {
      if (!/^[0-9]$/.test(d)) return null;
      const p = split(entry);
      if (p.esign) {
        const ed = (p.edigits === '0' ? '' : p.edigits) + d;
        if (ed.length > 4 || Number(ed) > 9999) return null;
        return `${p.sign}${p.int}${p.dot}${p.frac}e${p.esign}${ed.replace(/^0+(?=\d)/, '')}`;
      }
      const sig = p.int.replace(/^0+/, '').length + p.frac.length;
      if (sig >= maxDigits) return null;
      if (!p.dot && p.int === '0') return `${p.sign}${d}`;
      return entry + d;
    },
    decimal(entry) {
      const p = split(entry);
      if (p.dot || p.esign) return null;
      return `${entry}.`;
    },
    exp(entry) {
      const p = split(entry);
      if (p.esign) return null;
      return `${entry}e+`;
    },
    negateEntry(entry) {
      const p = split(entry);
      if (p.esign) return `${p.sign}${p.int}${p.dot}${p.frac}e${p.esign === '+' ? '-' : '+'}${p.edigits}`;
      if (!p.dot && /^0*$/.test(p.int)) return null; // nothing to negate
      return p.sign ? entry.slice(1) : `-${entry}`;
    },
    backspace(entry) {
      if (/e[+-]$/.test(entry)) return entry.slice(0, -2);
      const s = entry.slice(0, -1);
      return s === '' || s === '-' || s === '-0' ? '0' : s;
    },
    parseEntry(entry) {
      return Num.parse(entry) || ZERO;
    },
  };
}

// ---------------------------------------------------------------- real helpers

/** 10^t for a double t, valid far beyond the double range (|t| <= 10000). */
export function pow10Real(t) {
  if (!Number.isFinite(t)) throw new CalcError(Number.isNaN(t) ? 'invalid' : 'overflow');
  if (Math.abs(t) > 10000) throw new CalcError('overflow');
  if (Math.abs(t) < 300) return Num.fromDouble(10 ** t);
  const k = Math.floor(t);
  const m = 10 ** (t - k);
  return Num.parse(`${m.toPrecision(15)}e${k}`);
}

function lnNum(x) {
  const d = x.toNumber();
  if (d > 1e-300 && d < 1e300) return Math.log(d);
  return x.log10Approx() * LN10;
}

/** k-th root (k >= 1 integer) with ~40 significant digits; exact for perfect powers. */
export function nthRoot(x, k) {
  if (k === 1) return x;
  if (x.isZero()) return ZERO;
  const neg = x.isNeg();
  if (neg && k % 2 === 0) throw new CalcError('invalid');
  const a = x.abs();
  const K = BigInt(k);
  const rn = iroot(a.n, k);
  const rd = iroot(a.d, k);
  if (rn ** K === a.n && rd ** K === a.d) return Num.make(neg ? -rn : rn, rd);
  if (k > 64 || bitLen(a.d) * k > 120000) {
    const r = pow10Real(a.log10Approx() / k);
    return neg ? r.neg() : r;
  }
  const P = 40 + Math.max(0, Math.ceil(-a.log10Approx() / k));
  const N = a.n * a.d ** (K - 1n) * pow10(P * k);
  const r = iroot(N, k);
  const res = Num.make(r, a.d * pow10(P)).approx(40);
  return neg ? res.neg() : res;
}

/** a^b for rationals. */
export function power(a, b) {
  if (b.isInt()) {
    const k = b.toBigInt();
    if (a.isZero() && k < 0n) throw new CalcError('divzero');
    return a.powInt(k);
  }
  if (a.isZero()) {
    if (b.isNeg()) throw new CalcError('divzero');
    return ZERO;
  }
  let neg = false;
  if (a.isNeg()) {
    // Only rational exponents with an odd denominator have a real result.
    if (b.d % 2n === 0n) throw new CalcError('invalid');
    neg = b.n % 2n !== 0n;
  }
  const base = a.abs();
  let r;
  const p = b.n < 0n ? -b.n : b.n;
  if (b.d <= 64n && p <= 64n) {
    r = nthRoot(base, Number(b.d)).powInt(b.n);
  } else {
    const t = b.toNumber() * base.log10Approx();
    if (Math.abs(t) < 300) r = Num.fromDouble(base.toNumber() ** b.toNumber());
    else r = pow10Real(t);
  }
  return neg ? r.neg() : r;
}

/** y-th root of x (the "y√x" operator). */
export function root(a, b) {
  if (b.isZero()) throw new CalcError('invalid');
  if (b.isInt()) {
    const k = b.toBigInt();
    const kk = k < 0n ? -k : k;
    if (kk <= 100000n) {
      const r = nthRoot(a, Number(kk));
      return k < 0n ? ONE.div(r) : r;
    }
  }
  return power(a, ONE.div(b));
}

export function logBase(a, b) {
  if (a.sign <= 0 || b.sign <= 0 || b.eq(ONE)) throw new CalcError('invalid');
  return Num.fromDouble(lnNum(a) / lnNum(b));
}

function isPow10(x) {
  // returns k if x == 10^k exactly, else null
  const s = (x.d === 1n ? x.n : x.n === 1n ? x.d : -1n).toString();
  if (!/^10*$/.test(s)) return null;
  return x.d === 1n ? s.length - 1 : -(s.length - 1);
}

function expE(x) {
  if (x.isZero()) return ONE;
  if (x.eq(ONE)) return E;
  const d = x.toNumber();
  if (Math.abs(d) < 690) return Num.fromDouble(Math.exp(d));
  return pow10Real(d / LN10);
}

// Lanczos approximation (g = 7) – double precision Γ and ln Γ.
const LG = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
function gamma(z) {
  if (z < 0.5) return Math.PI / (Math.sin(Math.PI * z) * gamma(1 - z));
  z -= 1;
  let x = LG[0];
  for (let i = 1; i < 9; i++) x += LG[i] / (z + i);
  const t = z + 7.5;
  return Math.sqrt(2 * Math.PI) * t ** (z + 0.5) * Math.exp(-t) * x;
}
function lnGamma(z) {
  // z > 0.5
  z -= 1;
  let x = LG[0];
  for (let i = 1; i < 9; i++) x += LG[i] / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

export function factorial(x) {
  if (x.isInt()) {
    const n = x.toBigInt();
    if (n < 0n) throw new CalcError('invalid');
    if (n > 3248n) throw new CalcError('overflow');
    let r = 1n;
    for (let i = 2n; i <= n; i++) r *= i;
    return Num.make(r, 1n);
  }
  const z = x.toNumber() + 1;
  if (z > 171) return pow10Real(lnGamma(z) / LN10);
  if (z < -170) throw new CalcError('overflow');
  return Num.fromDouble(gamma(z));
}

// ---------------------------------------------------------------- trigonometry

function quarterIndex(x, angle) {
  // k in 0..3 when x is an exact multiple of a right angle, else -1
  if (angle === 'rad') return x.isZero() ? 0 : -1;
  const r = x.div(Num.of(angle === 'deg' ? 90 : 100));
  if (!r.isInt()) return -1;
  return Number(((r.toBigInt() % 4n) + 4n) % 4n);
}

function toRadians(x, angle) {
  if (angle === 'rad') return x.toNumber();
  const full = angle === 'deg' ? 360 : 400;
  const r = x.mod(Num.of(full));
  return (r.toNumber() * Math.PI) / (full / 2);
}

function fromRadians(r, angle) {
  if (angle === 'deg') return (r * 180) / Math.PI;
  if (angle === 'grad') return (r * 200) / Math.PI;
  return r;
}

function trig(name, x, angle) {
  const k = quarterIndex(x, angle);
  if (k >= 0) {
    if (name === 'sin') return Num.of([0, 1, 0, -1][k]);
    if (name === 'cos') return Num.of([1, 0, -1, 0][k]);
    if (k % 2) throw new CalcError('invalid');
    return ZERO;
  }
  const rad = toRadians(x, angle);
  if (!Number.isFinite(rad)) throw new CalcError('invalid');
  let v = name === 'sin' ? Math.sin(rad) : name === 'cos' ? Math.cos(rad) : Math.tan(rad);
  if (Math.abs(v) < 1e-15 && Math.abs(rad) > 1e-6) v = 0;
  return Num.fromDouble(v);
}

function recipOrInvalid(v) {
  if (v.isZero()) throw new CalcError('invalid');
  return ONE.div(v);
}

function inverseTrig(name, x, angle) {
  const d = x.toNumber();
  let r;
  if (name === 'asin' || name === 'acos') {
    if (Math.abs(d) > 1) throw new CalcError('invalid');
    r = name === 'asin' ? Math.asin(d) : Math.acos(d);
  } else r = Math.atan(d);
  return Num.fromDouble(fromRadians(r, angle));
}

function hyper(name, x) {
  const d = x.toNumber();
  let v;
  switch (name) {
    case 'sinh':
      v = Math.sinh(d);
      break;
    case 'cosh':
      v = Math.cosh(d);
      break;
    case 'tanh':
      v = Math.tanh(d);
      break;
    case 'asinh':
      v = Math.asinh(d);
      break;
    case 'acosh':
      if (d < 1) throw new CalcError('invalid');
      v = Math.acosh(d);
      break;
    case 'atanh':
      if (Math.abs(d) >= 1) throw new CalcError('invalid');
      v = Math.atanh(d);
      break;
    default:
      throw new CalcError('invalid');
  }
  return Num.fromDouble(v);
}

function dms(x) {
  // decimal degrees -> D.MMSSss
  const neg = x.isNeg();
  const a = x.abs();
  const deg = a.floor();
  const minsTotal = a.sub(deg).mul(60);
  const mins = minsTotal.floor();
  const secs = minsTotal.sub(mins).mul(60);
  const r = deg.add(mins.div(100)).add(secs.div(10000));
  return neg ? r.neg() : r;
}

function degrees(x) {
  // D.MMSSss -> decimal degrees
  const neg = x.isNeg();
  const a = x.abs();
  const deg = a.floor();
  const mm = a.sub(deg).mul(100);
  const mins = mm.floor();
  const secs = mm.sub(mins).mul(100);
  const r = deg.add(mins.div(60)).add(secs.div(3600));
  return neg ? r.neg() : r;
}

export function randomNum() {
  let digits = '';
  const buf = new Uint32Array(4);
  (globalThis.crypto || { getRandomValues: (b) => b.map(() => Math.floor(Math.random() * 2 ** 32)) }).getRandomValues(buf);
  for (const v of buf) digits += String(v % 10000).padStart(4, '0');
  if (/^0+$/.test(digits)) digits = '0000000000000001';
  return Num.parse(`0.${digits}`);
}

// ---------------------------------------------------------------- operators

export const BINARY_DEC = ['+', '-', '*', '/', 'mod', 'pow', 'root', 'logy'];

export function binaryDec(op, a, b) {
  switch (op) {
    case '+':
      return a.add(b);
    case '-':
      return a.sub(b);
    case '*':
      return a.mul(b);
    case '/':
      return a.div(b);
    case 'mod':
      return a.mod(b);
    case 'pow':
      return power(a, b);
    case 'root':
      return root(a, b);
    case 'logy':
      return logBase(a, b);
    default:
      throw new Error(`unknown operator ${op}`);
  }
}

export function unaryDec(name, x, angle = 'deg') {
  switch (name) {
    case 'negate':
      return x.neg();
    case 'recip':
      return ONE.div(x);
    case 'sqr':
      return x.mul(x);
    case 'cube':
      return x.mul(x).mul(x);
    case 'sqrt':
      if (x.isNeg()) throw new CalcError('invalid');
      return nthRoot(x, 2);
    case 'cbrt':
      return nthRoot(x, 3);
    case 'pow10':
      return x.isInt() ? Num.of(10).powInt(x.toBigInt()) : pow10Real(x.toNumber());
    case 'pow2':
      return power(Num.of(2), x);
    case 'exp':
      return expE(x);
    case 'ln':
      if (x.sign <= 0) throw new CalcError('invalid');
      if (x.eq(ONE)) return ZERO;
      return Num.fromDouble(lnNum(x));
    case 'log': {
      if (x.sign <= 0) throw new CalcError('invalid');
      const k = isPow10(x);
      if (k !== null) return Num.of(k);
      const d = x.toNumber();
      return Num.fromDouble(d > 1e-300 && d < 1e300 ? Math.log10(d) : x.log10Approx());
    }
    case 'fact':
      return factorial(x);
    case 'abs':
      return x.abs();
    case 'floor':
      return x.floor();
    case 'ceil':
      return x.ceil();
    case 'dms':
      return dms(x);
    case 'degrees':
      return degrees(x);
    case 'sin':
    case 'cos':
    case 'tan':
      return trig(name, x, angle);
    case 'sec':
      return recipOrInvalid(trig('cos', x, angle));
    case 'csc':
      return recipOrInvalid(trig('sin', x, angle));
    case 'cot': {
      const k = quarterIndex(x, angle);
      if (k === 1 || k === 3) return ZERO;
      return recipOrInvalid(trig('tan', x, angle));
    }
    case 'asin':
    case 'acos':
    case 'atan':
      return inverseTrig(name, x, angle);
    case 'asec':
      return inverseTrig('acos', recipOrInvalid(x), angle);
    case 'acsc':
      return inverseTrig('asin', recipOrInvalid(x), angle);
    case 'acot':
      if (x.isZero()) return Num.fromDouble(fromRadians(Math.PI / 2, angle));
      return inverseTrig('atan', ONE.div(x), angle);
    case 'sinh':
    case 'cosh':
    case 'tanh':
    case 'asinh':
    case 'acosh':
    case 'atanh':
      return hyper(name, x);
    case 'sech':
      return recipOrInvalid(hyper('cosh', x));
    case 'csch':
      return recipOrInvalid(hyper('sinh', x));
    case 'coth':
      return recipOrInvalid(hyper('tanh', x));
    case 'asech':
      return hyper('acosh', recipOrInvalid(x));
    case 'acsch':
      return hyper('asinh', recipOrInvalid(x));
    case 'acoth':
      return hyper('atanh', recipOrInvalid(x));
    default:
      throw new Error(`unknown function ${name}`);
  }
}

export const CONSTANTS = { pi: PI, e: E };

/** Number system object consumed by Engine (engine.js). */
export function decimalSystem({ angle = 'deg', maxDigits = 16 } = {}) {
  const sys = {
    kind: 'dec',
    angle,
    zero: ZERO,
    ...makeEntryOps(maxDigits),
    binary: (op, a, b) => binaryDec(op, a, b),
    unary: (name, x) => unaryDec(name, x, sys.angle),
    isZero: (v) => v.isZero(),
    percentOf: (a, b, op) => (op === '+' || op === '-' ? a.mul(b).div(100) : b.div(100)),
  };
  return sys;
}
