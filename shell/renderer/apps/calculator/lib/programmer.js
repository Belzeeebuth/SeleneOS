// Programmer number system: integers in two's complement (QWORD/DWORD/WORD/BYTE) on BigInt,
// typed and displayed in HEX / DEC / OCT / BIN, bitwise operators and four shift modes.
import { CalcError, groupInt } from './num.js';

export const WORDS = [
  { id: 'qword', bits: 64, label: 'QWORD' },
  { id: 'dword', bits: 32, label: 'DWORD' },
  { id: 'word', bits: 16, label: 'WORD' },
  { id: 'byte', bits: 8, label: 'BYTE' },
];
export const RADIXES = [
  { id: 'hex', radix: 16, label: 'HEX' },
  { id: 'dec', radix: 10, label: 'DEC' },
  { id: 'oct', radix: 8, label: 'OCT' },
  { id: 'bin', radix: 2, label: 'BIN' },
];
export const SHIFTS = ['arith', 'logical', 'rotate', 'carry'];
const PREFIX = { 16: '0x', 8: '0o', 2: '0b' };

export function programmerSystem({ radix = 10, bits = 64, shift = 'arith' } = {}) {
  const sys = {
    kind: 'prog',
    radix,
    bits,
    shift,
    carry: 0n,
    zero: 0n,
    wrap: (v) => BigInt.asIntN(sys.bits, v),
    unsigned: (v) => BigInt.asUintN(sys.bits, v),
    isZero: (v) => v === 0n,
    validDigit(d) {
      const n = parseInt(d, 16);
      return /^[0-9A-F]$/i.test(d) && n < sys.radix;
    },
    appendDigit(entry, d) {
      if (!sys.validDigit(d)) return null;
      d = d.toUpperCase();
      const neg = entry.startsWith('-');
      const body = neg ? entry.slice(1) : entry;
      const next = (body === '0' ? '' : body) + d;
      if (next.length > sys.bits) return null;
      const mag = BigInt((PREFIX[sys.radix] || '') + next);
      if (sys.radix === 10) {
        const lim = 1n << BigInt(sys.bits - 1);
        if (neg ? mag > lim : mag > lim - 1n) return null;
      } else if (mag > (1n << BigInt(sys.bits)) - 1n) return null;
      return (neg ? '-' : '') + next;
    },
    negateEntry(entry) {
      if (sys.radix !== 10 || /^-?0$/.test(entry)) return null;
      if (entry.startsWith('-')) {
        const mag = BigInt(entry.slice(1));
        if (mag > (1n << BigInt(sys.bits - 1)) - 1n) return null; // -2^63 has no positive twin
        return entry.slice(1);
      }
      return `-${entry}`;
    },
    backspace(entry) {
      const s = entry.slice(0, -1);
      return s === '' || s === '-' ? '0' : s;
    },
    parseEntry(entry) {
      if (sys.radix === 10) return sys.wrap(BigInt(entry));
      return sys.wrap(BigInt((PREFIX[sys.radix] || '') + entry.replace(/^-/, '')));
    },
    /** Raw digits of a value in a radix (unsigned two's complement unless DEC). */
    toRadix(v, radix = sys.radix) {
      if (radix === 10) return sys.wrap(v).toString(10);
      return sys.unsigned(v).toString(radix).toUpperCase();
    },
    format(v, radix = sys.radix, { group = ',' } = {}) {
      return groupDigits(sys.toRadix(v, radix), radix, group);
    },
    formatEntry(entry, { group = ',' } = {}) {
      const neg = entry.startsWith('-');
      return (neg ? '-' : '') + groupDigits(entry.replace(/^-/, ''), sys.radix, group);
    },
    binary(op, a, b) {
      const W = sys.wrap;
      switch (op) {
        case '+':
          return W(a + b);
        case '-':
          return W(a - b);
        case '*':
          return W(a * b);
        case '/':
          if (b === 0n) throw new CalcError(a === 0n ? 'undefined' : 'divzero');
          return W(a / b);
        case '%':
        case 'mod':
          if (b === 0n) throw new CalcError(a === 0n ? 'undefined' : 'divzero');
          return W(a % b);
        case 'and':
          return W(a & b);
        case 'or':
          return W(a | b);
        case 'xor':
          return W(a ^ b);
        case 'nand':
          return W(~(a & b));
        case 'nor':
          return W(~(a | b));
        case 'lsh':
        case 'rsh':
          return sys.shiftBy(op === 'lsh' ? 'left' : 'right', a, b);
        default:
          throw new Error(`unknown operator ${op}`);
      }
    },
    shiftBy(dir, a, b) {
      if (b < 0n) throw new CalcError('invalid');
      const bits = BigInt(sys.bits);
      const W = sys.wrap;
      const U = sys.unsigned;
      const mode = sys.shift;
      if (mode === 'rotate') {
        const n = b % bits;
        if (n === 0n) return W(a);
        const u = U(a);
        const r = dir === 'left' ? (u << n) | (u >> (bits - n)) : (u >> n) | (u << (bits - n));
        return W(r);
      }
      if (mode === 'carry') {
        // rotate through carry: (bits + 1)-bit rotation of [carry | value]
        const width = bits + 1n;
        const mask = (1n << width) - 1n;
        const n = b % width;
        let c = (sys.carry << bits) | U(a);
        if (n !== 0n) c = dir === 'left' ? ((c << n) | (c >> (width - n))) & mask : ((c >> n) | (c << (width - n))) & mask;
        sys.carry = c >> bits;
        return W(c & ((1n << bits) - 1n));
      }
      if (dir === 'left') return b >= bits ? 0n : W(a << b);
      if (mode === 'logical') return b >= bits ? 0n : W(U(a) >> b);
      // arithmetic right shift keeps the sign
      if (b >= bits) return a < 0n ? -1n : 0n;
      return W(a >> b);
    },
    unary(name, x) {
      if (name === 'not') return sys.wrap(~x);
      if (name === 'negate') return sys.wrap(-x);
      throw new Error(`unknown function ${name}`);
    },
    percentOf: () => 0n,
  };
  return sys;
}

export function groupDigits(digits, radix, decGroup = ',') {
  if (radix === 10) {
    const neg = digits.startsWith('-');
    return (neg ? '-' : '') + groupInt(digits.replace(/^-/, ''), decGroup, 3);
  }
  return groupInt(digits, ' ', radix === 8 ? 3 : 4);
}

/** Parse pasted text for the programmer mode ("0xFF", "1010", "-42", "FF FF"). */
export function parseProgrammer(text, sys) {
  let s = String(text || '').trim().replace(/[\s_,'  ]/g, '');
  if (!s) return null;
  let radix = sys.radix;
  const m = /^(-?)0([xob])(.+)$/i.exec(s);
  if (m) {
    radix = { x: 16, o: 8, b: 2 }[m[2].toLowerCase()];
    s = m[1] + m[3];
  }
  const neg = s.startsWith('-');
  const body = neg ? s.slice(1) : s;
  const re = { 16: /^[0-9a-f]+$/i, 10: /^\d+$/, 8: /^[0-7]+$/, 2: /^[01]+$/ }[radix];
  if (!re.test(body)) return null;
  let v = BigInt((PREFIX[radix] || '') + body);
  if (neg) v = -v;
  return sys.wrap(v);
}
