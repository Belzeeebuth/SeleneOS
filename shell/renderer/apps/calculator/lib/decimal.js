// Decimal number system used by the Standard and Scientific modes (values are exact rationals, see num.js).
// Provides the entry-editing rules (16-digit limit, decimal point, "exp" exponent entry), the binary
// operators and every unary function shown on the keypad.
import { Num, ZERO, ONE, PI, E, CalcError, iroot, pow10, bitLen } from './num.js';
import { lnNum, log10Num, expNum, powReal, trigRad, inverseTrigRad, hyperbolic, gammaNum, LN10_NUM } from './hp.js';

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
// Transcendental functions use the 60-digit fixed-point routines of hp.js; exact rational paths are
// kept wherever possible (integer powers, perfect roots, exact angle reduction in DEG/GRAD).

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
  let res;
  if (k > 64 || bitLen(a.d) * k > 120000) {
    res = powReal(a, Num.frac(1, k));
  } else {
    const P = 40 + Math.max(0, Math.ceil(-a.log10Approx() / k));
    const N = a.n * a.d ** (K - 1n) * pow10(P * k);
    res = Num.make(iroot(N, k), a.d * pow10(P)).approx(40);
  }
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
  const p = b.n < 0n ? -b.n : b.n;
  const r = b.d <= 64n && p <= 64n ? nthRoot(base, Number(b.d)).powInt(b.n) : powReal(base, b);
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
  return lnNum(a).div(lnNum(b)).approx(40);
}

function isPow10(x) {
  // returns k if x == 10^k exactly, else null
  const s = (x.d === 1n ? x.n : x.n === 1n ? x.d : -1n).toString();
  if (!/^10*$/.test(s)) return null;
  return x.d === 1n ? s.length - 1 : -(s.length - 1);
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
  return gammaNum(x.add(1));
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
  if (angle === 'rad') return x;
  const full = angle === 'deg' ? 360 : 400;
  return x.mod(Num.of(full)).mul(PI).div(full / 2); // exact reduction, then convert
}

function fromRadians(r, angle) {
  if (angle === 'deg') return r.mul(180).div(PI).approx(40);
  if (angle === 'grad') return r.mul(200).div(PI).approx(40);
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
  return trigRad(name, toRadians(x, angle));
}

function recipOrInvalid(v) {
  if (v.isZero()) throw new CalcError('invalid');
  return ONE.div(v);
}

function inverseTrig(name, x, angle) {
  return fromRadians(inverseTrigRad(name, x), angle);
}

function hyper(name, x) {
  return hyperbolic(name, x);
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
      return x.isInt() ? Num.of(10).powInt(x.toBigInt()) : expNum(x.mul(LN10_NUM));
    case 'pow2':
      return power(Num.of(2), x);
    case 'exp':
      return x.eq(ONE) ? E : expNum(x);
    case 'ln':
      return lnNum(x);
    case 'log': {
      if (x.sign <= 0) throw new CalcError('invalid');
      const k = isPow10(x);
      if (k !== null) return Num.of(k);
      return log10Num(x);
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
      if (x.isZero()) return fromRadians(PI.div(2), angle);
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
