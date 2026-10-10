// High-precision transcendental functions on BigInt fixed point (60 decimal digits).
// Results are returned as Num (num.js) rounded to 40 significant digits, so the 16-digit display is
// exact in practice: sin(30°) = 0.5, ln(2) = 0.6931471805599453, Γ(1.3) = 0.8974706963062772 …
import { Num, ZERO, ONE, PI, CalcError, iroot, pow10, bitLen } from './num.js';

const P = 60;
const S = 10n ** BigInt(P); // fixed-point scale
const OUT_DIGITS = 40;

const babs = (a) => (a < 0n ? -a : a);
const mul = (a, b) => (a * b) / S;
const div = (a, b) => (a * S) / b;
function roundDiv(a, b) {
  // round(a / b) for bigints, b > 0
  const q = a / b;
  const r = a - q * b;
  if (2n * babs(r) >= b) return q + (a < 0n ? -1n : 1n);
  return q;
}
const sqrtF = (a) => iroot(a * S, 2);

/** Num -> fixed point (only for values of moderate magnitude). */
export function toFixed(x) {
  return roundDiv(x.n * S, x.d);
}
/** fixed point -> Num (40 significant digits). */
export function fromFixed(f) {
  if (f === 0n) return ZERO;
  return Num.make(f, S).approx(OUT_DIGITS);
}

// ---------------------------------------------------------------- constants
function atanhInv(n) {
  // atanh(1/n) for integer n >= 2
  const N = BigInt(n);
  const n2 = N * N;
  let term = S / N;
  let sum = 0n;
  for (let k = 1n; term !== 0n; k += 2n) {
    sum += term / k;
    term /= n2;
  }
  return sum;
}
const LN2 = 2n * atanhInv(3);
const LN10 = 3n * LN2 + 2n * atanhInv(9); // ln 10 = ln 8 + ln 1.25
const PIF = toFixed(PI);
const HALF_PI = PIF / 2n;
export const LN10_NUM = fromFixed(LN10);

// ---------------------------------------------------------------- ln / exp
function lnF(a) {
  // natural log of a fixed-point value a > 0
  let k = bitLen(a) - bitLen(S);
  let m = k >= 0 ? a >> BigInt(k) : a << BigInt(-k);
  while (m >= 2n * S) {
    m >>= 1n;
    k++;
  }
  while (m < S) {
    m <<= 1n;
    k--;
  }
  const t = div(m - S, m + S);
  const t2 = mul(t, t);
  let sum = 0n;
  let term = t;
  for (let i = 1n; term !== 0n; i += 2n) {
    sum += term / i;
    term = mul(term, t2);
  }
  return 2n * sum + BigInt(k) * LN2;
}

function expF(a) {
  // e^a for a fixed-point a of moderate size (|a| <= ~ 300)
  const k = roundDiv(a, LN2);
  const r = a - k * LN2;
  let sum = S;
  let term = S;
  for (let i = 1n; term !== 0n; i++) {
    term = mul(term, r) / i;
    sum += term;
  }
  return k >= 0n ? sum << k : sum >> -k;
}

/** Natural logarithm of a positive Num (any magnitude). */
export function lnNum(x) {
  if (x.sign <= 0) throw new CalcError('invalid');
  if (x.eq(ONE)) return ZERO;
  const { digits, exp } = x.toSig(P + 6);
  // x = 0.d1d2… × 10^(exp+1)  ->  m = d1.d2… in [1, 10)
  const m = BigInt(digits.padEnd(P + 1, '0').slice(0, P + 1));
  return fromFixed(lnF(m) + BigInt(exp) * LN10);
}

export function log10Num(x) {
  if (x.sign <= 0) throw new CalcError('invalid');
  const { digits, exp } = x.toSig(P + 6);
  const m = BigInt(digits.padEnd(P + 1, '0').slice(0, P + 1));
  return fromFixed(div(lnF(m), LN10) + BigInt(exp) * S);
}

/** e^y for any Num y (overflow beyond 1e±10000). */
export function expNum(y) {
  if (y.isZero()) return ONE;
  if (babs(y.n) > 24000n * y.d) throw new CalcError('overflow');
  const yF = toFixed(y);
  if (babs(yF) < 300n * S) return fromFixed(expF(yF));
  // e^y = 10^k × e^f with f = y − k·ln10 in [0, ln10)
  let k = yF / LN10;
  if (yF < 0n && k * LN10 !== yF) k -= 1n;
  const f = yF - k * LN10;
  const m = Num.make(expF(f), S).approx(OUT_DIGITS);
  const kk = Number(k);
  return kk >= 0 ? m.mul(Num.make(pow10(kk), 1n)) : m.div(Num.make(pow10(-kk), 1n));
}

/** a^b for a > 0 and any rational b. */
export function powReal(a, b) {
  return expNum(lnNum(a).mul(b));
}

// ---------------------------------------------------------------- trigonometry (radians)
const TINY = Num.parse('1e-20');
const HUGE = Num.parse('1e25');

function sinCosF(a) {
  const q = roundDiv(a, HALF_PI);
  const r = a - q * HALF_PI; // |r| <= π/4
  const r2 = mul(r, r);
  let s = r;
  let term = r;
  for (let i = 2n; term !== 0n; i += 2n) {
    term = -mul(term, r2) / (i * (i + 1n));
    s += term;
  }
  let c = S;
  term = S;
  for (let i = 1n; term !== 0n; i += 2n) {
    term = -mul(term, r2) / (i * (i + 1n));
    c += term;
  }
  switch (Number(((q % 4n) + 4n) % 4n)) {
    case 0:
      return [s, c];
    case 1:
      return [c, -s];
    case 2:
      return [-s, -c];
    default:
      return [-c, s];
  }
}

const NOISE = 10n ** BigInt(P - 48); // |value| below 1e-48 after reduction is rounding noise

/** sin / cos / tan of an angle in radians (Num). */
export function trigRad(name, x) {
  if (x.abs().cmp(TINY) < 0) {
    if (name === 'cos') return ONE;
    return x; // sin x ≈ tan x ≈ x
  }
  if (babs(x.n) > 10n ** 40n * x.d) throw new CalcError('invalid');
  const [s, c] = sinCosF(toFixed(x));
  const cs = babs(c) < NOISE ? 0n : c;
  const ss = babs(s) < NOISE ? 0n : s;
  if (name === 'sin') return fromFixed(ss);
  if (name === 'cos') return fromFixed(cs);
  if (cs === 0n) throw new CalcError('invalid');
  return Num.make(ss, cs).approx(OUT_DIGITS);
}

function atanF(x) {
  if (x < 0n) return -atanF(-x);
  if (x > S) return HALF_PI - atanF(div(S, x));
  let k = 0n;
  while (x > S / 16n) {
    x = div(x, S + sqrtF(S + mul(x, x)));
    k++;
  }
  const x2 = mul(x, x);
  let sum = 0n;
  let term = x;
  let sign = 1n;
  for (let i = 1n; term !== 0n; i += 2n) {
    sum += (sign * term) / i;
    term = mul(term, x2);
    sign = -sign;
  }
  return sum << k;
}

/** asin / acos / atan, result in radians (Num). */
export function inverseTrigRad(name, x) {
  if (name !== 'atan' && x.abs().cmp(ONE) > 0) throw new CalcError('invalid');
  if (name !== 'acos' && x.abs().cmp(TINY) < 0) return x;
  let r;
  if (name === 'atan') {
    if (babs(x.n) > 10n ** 50n * x.d) r = x.isNeg() ? -HALF_PI : HALF_PI;
    else r = atanF(toFixed(x));
  } else {
    const xf = toFixed(x);
    let as;
    if (babs(xf) === S) as = xf > 0n ? HALF_PI : -HALF_PI;
    else as = atanF(div(xf, sqrtF(S - mul(xf, xf))));
    r = name === 'asin' ? as : HALF_PI - as;
  }
  return fromFixed(r);
}

// ---------------------------------------------------------------- hyperbolic
export function hyperbolic(name, x) {
  switch (name) {
    case 'sinh':
    case 'cosh': {
      if (x.abs().cmp(TINY) < 0) return name === 'sinh' ? x : ONE;
      const e = expNum(x);
      const ei = ONE.div(e);
      const r = name === 'sinh' ? e.sub(ei) : e.add(ei);
      return r.div(2).approx(OUT_DIGITS);
    }
    case 'tanh': {
      if (x.abs().cmp(TINY) < 0) return x;
      if (x.abs().cmp(Num.of(60)) > 0) return x.isNeg() ? ONE.neg() : ONE;
      const e = expNum(x.mul(2));
      return e.sub(1).div(e.add(1)).approx(OUT_DIGITS);
    }
    case 'asinh': {
      if (x.abs().cmp(TINY) < 0) return x;
      const a = x.abs();
      // for |x| > 1e25, asinh x = ln 2|x| + 1/(4x²) − … : the correction is below 40 digits (and x² could overflow)
      const r = a.cmp(HUGE) > 0 ? lnNum(a.mul(2)) : lnNum(a.add(sqrtNum(a.mul(a).add(1))));
      return x.isNeg() ? r.neg() : r;
    }
    case 'acosh':
      if (x.cmp(ONE) < 0) throw new CalcError('invalid');
      if (x.cmp(HUGE) > 0) return lnNum(x.mul(2));
      return lnNum(x.add(sqrtNum(x.mul(x).sub(1))));
    case 'atanh':
      if (x.abs().cmp(ONE) >= 0) throw new CalcError('invalid');
      if (x.abs().cmp(TINY) < 0) return x;
      return lnNum(ONE.add(x).div(ONE.sub(x))).div(2);
    default:
      throw new CalcError('invalid');
  }
}

function sqrtNum(x) {
  if (x.isZero()) return ZERO;
  // sqrt(n/d) = sqrt(n·d)/d with ~50 digits
  const k = 50 + Math.max(0, Math.ceil(-x.log10Approx() / 2));
  const r = iroot(x.n * x.d * pow10(2 * k), 2);
  return Num.make(r, x.d * pow10(k)).approx(OUT_DIGITS + 4);
}

// ---------------------------------------------------------------- gamma
// Bernoulli numbers B2..B30 for the Stirling series of ln Γ.
const BERN = [
  [1n, 6n],
  [-1n, 30n],
  [1n, 42n],
  [-1n, 30n],
  [5n, 66n],
  [-691n, 2730n],
  [7n, 6n],
  [-3617n, 510n],
  [43867n, 798n],
  [-174611n, 330n],
  [854513n, 138n],
  [-236364091n, 2730n],
  [8553103n, 6n],
  [-23749461029n, 870n],
  [8615841276005n, 14322n],
];
const HALF_LN_2PI = (lnF(2n * PIF)) / 2n;

function lnGammaF(w) {
  // w: Num >= 40 ; returns fixed ln Γ(w)
  const wf = toFixed(w);
  let r = mul(wf - S / 2n, lnF(wf)) - wf + HALF_LN_2PI;
  const winv = div(S, wf);
  const winv2 = mul(winv, winv);
  let pw = winv; // w^-(2k-1)
  for (let k = 1; k <= BERN.length; k++) {
    const [bn, bd] = BERN[k - 1];
    const kk = BigInt(k);
    r += (bn * pw) / (bd * 2n * kk * (2n * kk - 1n));
    pw = mul(pw, winv2);
  }
  return r;
}

/** Γ(z) for a non-integer rational z (|z| up to a few thousand). */
export function gammaNum(z) {
  const zd = z.toNumber();
  if (zd > 3300) throw new CalcError('overflow');
  if (zd < -3300) throw new CalcError('overflow');
  const N = Math.max(0, Math.ceil(40 - zd));
  const w = z.add(N);
  const lg = lnGammaF(w);
  let g = expNum(fromFixed(lg));
  let prod = ONE;
  for (let i = 0; i < N; i++) prod = prod.mul(z.add(i));
  g = g.div(prod);
  return g.approx(OUT_DIGITS);
}
