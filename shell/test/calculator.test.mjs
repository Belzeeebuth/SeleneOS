// Calculator tests.
//   Part 1 (pure Node): a large computation table against the engine modules (Standard semantics,
//          Scientific precedence & functions, Programmer integers, converters, dates, formatting).
//   Part 2 (Electron + Playwright): drives the real shell UI — clicks, keyboard, errors, memory,
//          history, docked pane, clipboard, compact overlay, persistence, FR formatting, sizes —
//          and writes the documentation screenshots to aurora-os/docs/screenshots/calculator-*.png.
// Usage:  cd aurora-os/shell && xvfb-run -a -s "-screen 0 1600x900x24" node test/calculator.test.mjs [--engine-only|--ui-only]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchShell, ROOT } from './lib.mjs';

const LIB = path.join(ROOT, 'renderer/apps/calculator/lib');
const imp = (f) => import(path.join(LIB, f));
const { Engine, STD_PREC, SCI_PREC, renderItems } = await imp('engine.js');
const { decimalSystem, CONSTANTS } = await imp('decimal.js');
const { programmerSystem, parseProgrammer } = await imp('programmer.js');
const { Num, formatNum, formatEntry, parseLoose, LOCALES } = await imp('num.js');
const { convert, CATEGORIES } = await imp('units.js');
const { ymd, diff, shift } = await imp('dates.js');

const DOCS = path.join(ROOT, '..', 'docs', 'screenshots');
const args = new Set(process.argv.slice(2));
let passed = 0;
const failures = [];
function check(name, actual, expected) {
  const ok = typeof expected === 'function' ? expected(actual) : Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else {
    failures.push(`${name}\n      expected: ${typeof expected === 'function' ? '(predicate)' : JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
  }
  return ok;
}
const NNBSP = ' ';

// ================================================================ Part 1: engine table
const OPS = { '+': '+', '-': '-', '*': '*', '/': '/', mod: 'mod', pow: 'pow', root: 'root', logy: 'logy', and: 'and', or: 'or', xor: 'xor', nand: 'nand', nor: 'nor', lsh: 'lsh', rsh: 'rsh', '%%': '%' };
const textOpts = (sys, fe = false) => ({
  fmt: (v) => (typeof v === 'bigint' ? sys.format(v) : formatNum(v, { fe })),
  opText: (o) => ({ '+': '+', '-': '−', '*': '×', '/': '÷', mod: 'Mod', pow: '^', root: 'yroot', logy: 'log base', '%': '%', and: 'AND', or: 'OR', xor: 'XOR', nand: 'NAND', nor: 'NOR', lsh: 'Lsh', rsh: 'Rsh' })[o] || o,
  fnText: (n, x) => ({ sqrt: `√(${x})`, recip: `1/(${x})`, sqr: `sqr(${x})`, negate: `negate(${x})` })[n] || `${n}(${x})`,
  constText: (n) => ({ pi: 'π', e: 'e' })[n],
});

/** Feed a token sequence ("12.5 + 3 =") to an engine; returns { display, expr, engine }. */
function feed(seq, { prec = STD_PREC, sys = decimalSystem(), fe = false, engine } = {}) {
  const e = engine || new Engine(sys, { prec });
  for (const tok of seq.split(/\s+/).filter(Boolean)) {
    if (/^-?[0-9A-F]+(\.[0-9]*)?$/.test(tok) && tok !== '-') {
      for (const ch of tok) ch === '.' ? e.decimal() : ch === '-' ? null : e.digit(ch);
      if (tok.startsWith('-')) e.negate();
    } else if (tok === '.') e.decimal();
    else if (tok in OPS) e.op(OPS[tok]);
    else if (tok === '=') e.equals();
    else if (tok === '%') e.percent();
    else if (tok === '(') e.lparen();
    else if (tok === ')') e.rparen();
    else if (tok === 'CE') e.clearEntry();
    else if (tok === 'C') e.clear();
    else if (tok === 'BS') e.backspace();
    else if (tok === 'neg') e.negate();
    else if (tok === 'exp') e.exp();
    else if (tok === 'pi' || tok === 'e') e.constant(tok, CONSTANTS[tok]);
    else e.unary(tok);
  }
  const s = e.sys;
  const display = e.error
    ? `ERR:${e.error}`
    : e.entry != null
      ? s.kind === 'prog'
        ? s.formatEntry(e.entry, { group: '' })
        : formatEntry(e.entry)
      : s.kind === 'prog'
        ? s.format(e.value(), s.radix, { group: '' })
        : formatNum(e.value(), { fe });
  return { display, expr: renderItems(e.exprItems(), textOpts(s, fe)), engine: e };
}

function part1() {
  const STD = [
    ['2 + 3 * 4 =', '20', '2 + 3 × 4 ='],
    ['2 + 3 *', '5', '2 + 3 ×'],
    ['2 + 3 = =', '8', '5 + 3 ='],
    ['5 + = =', '15', '10 + 5 ='],
    ['2 + 3 = 7 =', '10', '7 + 3 ='],
    ['1 / 3 * 3 =', '1'],
    ['0.1 + 0.2 =', '0.3', '0.1 + 0.2 ='],
    ['1 - 0.9 =', '0.1'],
    ['1.1 * 1.1 =', '1.21'],
    ['0.1 * 3 =', '0.3'],
    ['100 / 3 = * 3 =', '100'],
    ['200 + 10 %', '20', '200 + 20'],
    ['200 + 10 % =', '220', '200 + 20 ='],
    ['200 - 10 % =', '180'],
    ['200 * 10 % =', '20', '200 × 0.1 ='],
    ['50 / 10 % =', '500'],
    ['50 %', '0', '0'],
    ['1 / 0 =', 'ERR:divzero', '1 ÷ 0 ='],
    ['0 / 0 =', 'ERR:undefined'],
    ['1 / 0 = 5', '5', ''],
    ['1 / 0 = +', 'ERR:divzero'],
    ['1 / 0 = C', '0', ''],
    ['9 sqrt', '3', '√(9)'],
    ['2 + 9 sqrt =', '5', '2 + √(9) ='],
    ['4 neg sqrt', 'ERR:invalid', '√(-4)'],
    ['0 recip', 'ERR:divzero'],
    ['4 recip', '0.25', '1/(4)'],
    ['3 sqr', '9', 'sqr(3)'],
    ['3 sqr sqr', '81', 'sqr(sqr(3))'],
    ['5 neg', '-5', ''],
    ['5 = neg', '-5', 'negate(5)'],
    ['9 neg + 4 =', '-5'],
    ['123 BS BS', '1'],
    ['123 BS BS BS', '0'],
    ['1 + 2 = BS', '3', ''],
    ['2 + 3 CE 4 =', '6', '2 + 4 ='],
    ['2 + 3 C', '0', ''],
    ['2 + * 3 =', '6', '2 × 3 ='],
    ['12345678901234567', '1,234,567,890,123,456'],
    ['9999999999999999 + 1 =', '1.e+16'],
    ['1 / 7 =', '0.1428571428571429'],
    ['2 / 3 =', '0.6666666666666667'],
    ['1 / 7 / 1000 =', '1.428571428571429e-4'],
    ['1 / 7 / 10 =', '0.0142857142857143'],
    ['0.000001', '0.000001'],
    ['1.50', '1.50'],
    ['. 5', '0.5'],
    ['3 . . 2', '3.2'],
    ['2 sqrt', '1.414213562373095'],
    ['10 sqrt', '3.162277660168379'],
    ['1234567.89', '1,234,567.89'],
    ['5 =', '5', '5 ='],
    ['10 sqr sqr sqr sqr sqr sqr sqr sqr sqr sqr sqr sqr sqr sqr', 'ERR:overflow'],
    ['0.5 + 0.25 = * 4 =', '3'],
  ];
  for (const [seq, disp, ex] of STD) {
    const r = feed(seq);
    check(`standard: ${seq} -> display`, r.display, disp);
    if (ex !== undefined) check(`standard: ${seq} -> expression`, r.expr, ex);
  }

  const SCI = [
    ['2 + 3 * 4 =', '14', '2 + 3 × 4 ='],
    ['2 + 3 * 4 +', '14', '2 + 3 × 4 +'],
    ['2 * 3 +', '6'],
    ['2 + 3 *', '3'],
    ['( 2 + 3 ) * 4 =', '20', '(2 + 3) × 4 ='],
    ['2 * ( 3 + 4 =', '14', '2 × (3 + 4) ='],
    ['3 ( 4 + 1 ) =', '15', '3 × (4 + 1) ='],
    ['( 2 + 3 ) sqr', '25', 'sqr(2 + 3)'],
    ['( ( 1 + 2 ) * ( 3 + 4 ) ) =', '21'],
    ['1 + 2 ) =', '3'],
    ['10 - 4 - 3 =', '3'],
    ['100 / 10 / 5 =', '2'],
    ['2 pow 10 =', '1,024', '2 ^ 10 ='],
    ['2 pow 3 pow 2 =', '64'],
    ['2 + 2 pow 3 * 2 =', '18'],
    ['2 pow 0.5 =', '1.414213562373095'],
    ['8 root 3 =', '2', '8 yroot 3 ='],
    ['27 neg cbrt', '-3'],
    ['8 neg pow 3 recip =', '-2'],
    ['16 pow 0.25 =', '2'],
    ['2 neg pow 0.5 =', 'ERR:invalid'],
    ['0 pow 1 neg =', 'ERR:divzero'],
    ['7 mod 3 =', '1'],
    ['7 neg mod 3 =', '2'],
    ['5.5 mod 2 =', '1.5'],
    ['100 logy 10 =', '2'],
    ['8 logy 2 =', '3'],
    ['1000 log', '3'],
    ['0.001 log', '-3'],
    ['2 log', '0.301029995663981'],
    ['100 ln', '4.60517018598809'],
    ['e ln', '1'],
    ['0 ln', 'ERR:invalid'],
    ['5 fact', '120'],
    ['0 fact', '1'],
    ['20 fact', '2.43290200817664e+18'],
    ['3 neg fact', 'ERR:invalid'],
    ['0.5 fact', '0.886226925452758'],
    ['3249 fact', 'ERR:overflow'],
    ['2 exp 3 =', '2,000'],
    ['2 exp 3 neg =', '0.002'],
    ['1.5 exp 2', '1.5e+2'],
    ['pi', '3.141592653589793'],
    ['e', '2.718281828459045'],
    ['2 * pi =', '6.283185307179586', '2 × π ='],
    ['2 pow10', '100'],
    ['3 pow2', '8'],
    ['5 neg abs', '5'],
    ['2.7 floor', '2'],
    ['2.7 neg floor', '-3'],
    ['2.1 ceil', '3'],
    ['30.5 dms', '30.3'],
    ['30.3 degrees', '30.5'],
    ['10 pow 10000 =', 'ERR:overflow'],
    ['1 / 3 =', '0.3333333333333333'],
    ['1 sinh', '1.1752011936438'],
    ['0 cosh', '1'],
    ['2 acosh', '1.31695789692482'],
    ['1 atanh', 'ERR:invalid'],
  ];
  for (const [seq, disp, ex] of SCI) {
    const r = feed(seq, { prec: SCI_PREC });
    check(`scientific: ${seq} -> display`, r.display, disp);
    if (ex !== undefined) check(`scientific: ${seq} -> expression`, r.expr, ex);
  }
  // trigonometry in every angle unit
  const TRIG = [
    ['deg', '30 sin', '0.5'],
    ['deg', '90 sin', '1'],
    ['deg', '180 sin', '0'],
    ['deg', '270 sin', '-1'],
    ['deg', '390 sin', '0.5'],
    ['deg', '60 cos', '0.5'],
    ['deg', '90 cos', '0'],
    ['deg', '45 tan', '1'],
    ['deg', '90 tan', 'ERR:invalid'],
    ['deg', '0.5 asin', '30'],
    ['deg', '1 atan', '45'],
    ['deg', '0.5 acos', '60'],
    ['deg', '2 asin', 'ERR:invalid'],
    ['deg', '60 sec', '2'],
    ['deg', '30 csc', '2'],
    ['deg', '45 cot', '1'],
    ['deg', '90 sec', 'ERR:invalid'],
    ['rad', 'pi sin', '0'],
    ['rad', 'pi cos', '-1'],
    ['rad', '1 sin', '0.841470984807897'],
    ['rad', '1 asin', '1.5707963267949'],
    ['grad', '100 sin', '1'],
    ['grad', '50 tan', '1'],
    ['grad', '1 asin', '100'],
  ];
  for (const [angle, seq, disp] of TRIG) check(`scientific ${angle}: ${seq}`, feed(seq, { prec: SCI_PREC, sys: decimalSystem({ angle }) }).display, disp);
  check('scientific F-E: 123', feed('123 =', { prec: SCI_PREC, fe: true }).display, '1.23e+2');
  check('scientific F-E: 1', feed('1 =', { prec: SCI_PREC, fe: true }).display, '1.e+0');

  // programmer
  const P = (seq, opts = {}) => feed(seq, { prec: SCI_PREC, sys: programmerSystem({ radix: 10, bits: 64, ...opts }) });
  const PROG = [
    ['5 and 3 =', '1', '5 AND 3 ='],
    ['5 or 3 =', '7'],
    ['5 xor 3 =', '6'],
    ['5 nand 3 =', '-2'],
    ['5 nor 3 =', '-8'],
    ['5 not', '-6', 'not(5)'],
    ['1 lsh 4 =', '16', '1 Lsh 4 ='],
    ['256 rsh 2 =', '64'],
    ['8 neg rsh 1 =', '-4'],
    ['7 %% 3 =', '1'],
    ['7 neg %% 3 =', '-1'],
    ['7 / 2 =', '3'],
    ['7 neg / 2 =', '-3'],
    ['9223372036854775807 + 1 =', '-9223372036854775808'],
    ['1 + 2 * 3 =', '7'],
    ['1 or 2 and 3 =', '3'],
    ['( 1 + 2 ) * 3 =', '9'],
    ['1 / 0 =', 'ERR:divzero'],
    ['9223372036854775808', '922337203685477580'],
    ['1 lsh 64 =', '0'],
  ];
  for (const [seq, disp, ex] of PROG) {
    const r = P(seq);
    check(`programmer: ${seq}`, r.display, disp);
    if (ex) check(`programmer: ${seq} -> expression`, r.expr, ex);
  }
  check('programmer logical shift', P('8 neg rsh 1 =', { shift: 'logical' }).display, '9223372036854775804');
  check('programmer rotate right', P('1 rsh 1 =', { shift: 'rotate' }).display, '-9223372036854775808');
  check('programmer rotate left', P('1 neg lsh 4 =', { shift: 'rotate' }).display, '-1');
  {
    const sys = programmerSystem({ radix: 10, bits: 64, shift: 'carry' });
    const r1 = feed('1 rsh 1 =', { prec: SCI_PREC, sys });
    check('programmer rotate through carry (1)', r1.display, '0');
    check('programmer rotate through carry: carry set', sys.carry, 1n);
    const r2 = feed('C 0 rsh 1 =', { prec: SCI_PREC, sys, engine: r1.engine });
    check('programmer rotate through carry (2)', r2.display, '-9223372036854775808');
  }
  check('programmer BYTE overflow', P('127 + 1 =', { bits: 8 }).display, '-128');
  check('programmer BYTE entry limit', P('255', { bits: 8 }).display, '25');
  check('programmer WORD', P('65535', { bits: 16 }).display, '6553');
  {
    const sys = programmerSystem({ radix: 16, bits: 64 });
    const r = feed('F F', { prec: SCI_PREC, sys });
    check('programmer HEX entry', r.display, 'FF');
    check('programmer HEX value', r.engine.value(), 255n);
    check('programmer HEX->DEC', sys.format(255n, 10), '255');
    check('programmer HEX->OCT', sys.format(255n, 8), '377');
    check('programmer HEX->BIN', sys.format(255n, 2), '1111 1111');
    check('programmer -1 in HEX', sys.format(-1n, 16), 'FFFF FFFF FFFF FFFF');
    check('programmer -1 in OCT', sys.format(-1n, 8), '1 777 777 777 777 777 777 777');
    check('programmer -1 in BIN digits', sys.toRadix(-1n, 2), '1'.repeat(64));
    check('programmer HEX A + 6 = 10', feed('A + 6 =', { prec: SCI_PREC, sys: programmerSystem({ radix: 16 }) }).display, '10');
    check('programmer BIN 1010 + 1 = 1011', feed('1010 + 1 =', { prec: SCI_PREC, sys: programmerSystem({ radix: 2 }) }).display, '1011');
    check('programmer OCT 8 rejected', feed('78', { prec: SCI_PREC, sys: programmerSystem({ radix: 8 }) }).display, '7');
    check('programmer DEC grouping', programmerSystem({ radix: 10 }).format(1234567n, 10, { group: ',' }), '1,234,567');
    check('programmer paste 0xFF', parseProgrammer('0xFF', programmerSystem({ radix: 10 })), 255n);
    check('programmer paste BIN', parseProgrammer('1010', programmerSystem({ radix: 2 })), 10n);
    check('programmer paste -42', parseProgrammer('-42', programmerSystem({ radix: 10 })), -42n);
    check('programmer paste FF FF', parseProgrammer('FF FF', programmerSystem({ radix: 16 })), 65535n);
    check('programmer paste invalid', parseProgrammer('12G', programmerSystem({ radix: 16 })), null);
  }

  // converters
  const CONV = [
    ['temperature', 'c', 'f', '100', '212'],
    ['temperature', 'f', 'c', '32', '0'],
    ['temperature', 'c', 'k', '0', '273.15'],
    ['temperature', 'f', 'c', '-40', '-40'],
    ['temperature', 'k', 'f', '0', '-459.67'],
    ['temperature', 'f', 'c', '98.6', '37'],
    ['length', 'km', 'mi', '1', '0.6213711922373339'],
    ['length', 'mi', 'km', '1', '1.609344'],
    ['length', 'in', 'cm', '1', '2.54'],
    ['length', 'ft', 'm', '1', '0.3048'],
    ['length', 'nmi', 'm', '1', '1,852'],
    ['length', 'cm', 'in', '100', '39.37007874015748'],
    ['weight', 'lb', 'kg', '1', '0.45359237'],
    ['weight', 'kg', 'lb', '1', '2.204622621848776'],
    ['weight', 'st', 'lb', '1', '14'],
    ['weight', 'oz', 'g', '16', '453.59237'],
    ['volume', 'galus', 'l', '1', '3.785411784'],
    ['volume', 'l', 'ml', '1', '1,000'],
    ['volume', 'galuk', 'ptuk', '1', '8'],
    ['volume', 'cupus', 'flozus', '1', '8'],
    ['area', 'ha', 'm2', '1', '10,000'],
    ['area', 'ac', 'm2', '1', '4,046.8564224'],
    ['area', 'mi2', 'ac', '1', '640'],
    ['speed', 'kmh', 'ms', '36', '10'],
    ['speed', 'mph', 'kmh', '60', '96.56064'],
    ['speed', 'kn', 'kmh', '1', '1.852'],
    ['time', 'h', 'min', '1', '60'],
    ['time', 'd', 's', '1', '86,400'],
    ['time', 'wk', 'd', '2', '14'],
    ['data', 'gb', 'mb', '1', '1,000'],
    ['data', 'gib', 'mib', '1', '1,024'],
    ['data', 'byte', 'bit', '1', '8'],
    ['energy', 'kcal', 'kj', '1', '4.184'],
    ['energy', 'kwh', 'j', '1', '3,600,000'],
    ['pressure', 'atm', 'pa', '1', '101,325'],
    ['pressure', 'bar', 'kpa', '1', '100'],
    ['power', 'kw', 'w', '1', '1,000'],
    ['angle', 'deg', 'rad', '180', '3.141592653589793'],
    ['angle', 'grad', 'deg', '100', '90'],
  ];
  for (const [cat, from, to, v, exp] of CONV) check(`convert ${cat}: ${v} ${from} -> ${to}`, formatNum(convert(cat, from, to, Num.of(v))), exp);
  check('converter categories >= 8 incl. required', ['length', 'weight', 'temperature', 'volume', 'area', 'speed', 'time', 'data'].every((c) => CATEGORIES.some((x) => x.id === c)), true);
  for (const c of CATEGORIES) for (const u of c.units) check(`unit ${c.id}/${u.id} has EN+FR names`, !!(u.name.en && u.name.fr), true);

  // dates
  const D = (s) => {
    const [y, m, d] = s.split('-').map(Number);
    return ymd(y, m, d);
  };
  const iso = (d) => d && d.toISOString().slice(0, 10);
  check('date diff 2024-01-01..2024-12-31', diff(D('2024-01-01'), D('2024-12-31')), { years: 0, months: 11, weeks: 4, days: 2, totalDays: 365 });
  check('date diff 2020-02-29..2021-02-28', diff(D('2020-02-29'), D('2021-02-28')), { years: 1, months: 0, weeks: 0, days: 0, totalDays: 365 });
  check('date diff 2026-01-31..2026-03-01', diff(D('2026-01-31'), D('2026-03-01')), { years: 0, months: 1, weeks: 0, days: 1, totalDays: 29 });
  check('date diff reversed', diff(D('2026-03-01'), D('2026-01-31')), { years: 0, months: 1, weeks: 0, days: 1, totalDays: 29 });
  check('date diff same', diff(D('2026-10-10'), D('2026-10-10')).totalDays, 0);
  check('date diff 2000-01-01..2026-10-10', diff(D('2000-01-01'), D('2026-10-10')), { years: 26, months: 9, weeks: 1, days: 2, totalDays: 9779 });
  check('date add 1 month to Jan 31', iso(shift(D('2026-01-31'), { months: 1 })), '2026-02-28');
  check('date add 1 year to Feb 29', iso(shift(D('2024-02-29'), { years: 1 })), '2025-02-28');
  check('date subtract 10 days', iso(shift(D('2026-03-05'), { days: 10 }, -1)), '2026-02-23');
  check('date add 1y 2m 3d', iso(shift(D('2026-10-10'), { years: 1, months: 2, days: 3 })), '2027-12-13');
  check('date out of range', shift(D('9500-01-01'), { years: 999 }), null);

  // formatting & parsing
  const fr = { loc: LOCALES.fr };
  check('format EN grouping', formatNum(Num.of('1234567.89')), '1,234,567.89');
  check('format FR grouping', formatNum(Num.of('1234567.89'), fr), `1${NNBSP}234${NNBSP}567,89`);
  check('format FR negative', formatNum(Num.of('-0.5'), fr), '-0,5');
  check('format FR scientific', formatNum(Num.of('1e16'), fr), '1,e+16');
  check('format entry FR', formatEntry('1234.50', fr), `1${NNBSP}234,50`);
  check('format entry exponent', formatEntry('2.5e-3'), '2.5e-3');
  check('parse "1,234.5"', parseLoose('1,234.5')?.toString(), '1234.5');
  check('parse "1 234,5" (fr)', parseLoose(`1${NNBSP}234,5`, 'fr')?.toString(), '1234.5');
  check('parse "1.234,5"', parseLoose('1.234,5')?.toString(), '1234.5');
  check('parse "1,5" (fr)', parseLoose('1,5', 'fr')?.toString(), '1.5');
  check('parse "1,234" (en)', parseLoose('1,234', 'en')?.toString(), '1234');
  check('parse "-3e5"', parseLoose('-3e5')?.toString(), '-300000');
  check('parse "abc"', parseLoose('abc'), null);
}

// ================================================================ Part 2: UI
const A = '.app-calculator';
async function part2() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-calc-'));
  fs.mkdirSync(DOCS, { recursive: true });
  let s = await launchShell({ open: ['calculator'], lang: 'en', theme: 'light', home });
  let p = s.page;
  const errorsOf = (sh) => sh.logs.filter((l) => l.startsWith('[pageerror]') || (l.startsWith('[error]') && /calculator|apps\/calc/i.test(l)));
  const win = () => s.aurora(() => window.__aurora.wm.byApp('calculator')[0]?.rect());
  const setSize = (w, h) => s.aurora(([w, h]) => window.__aurora.wm.byApp('calculator')[0].setRect({ width: w, height: h }), [w, h]);
  const display = async () => (await p.textContent(`${A} .calc-result`)).trim();
  const expr = async () => (await p.textContent(`${A} .calc-expr`)).trim();
  const press = async (...keys) => {
    for (const k of keys) await p.click(`${A} [data-key="${k}"]`);
  };
  const typeSeq = async (str) => {
    for (const ch of str) await p.keyboard.press(ch === '\n' ? 'Enter' : ch);
  };
  const mode = async (id) => {
    await press('nav');
    await p.waitForTimeout(350);
    await p.click(`${A} .calc-nav-item[data-mode="${id}"]`);
    await p.waitForTimeout(400);
  };
  async function crop(name) {
    await p.waitForTimeout(500);
    const r = await win();
    const m = 24;
    const clip = { x: Math.max(0, r.x - m), y: Math.max(0, r.y - m), width: Math.min(1600 - Math.max(0, r.x - m), r.width + 2 * m), height: Math.min(900 - Math.max(0, r.y - m), r.height + 2 * m) };
    await p.screenshot({ path: path.join(DOCS, `${name}.png`), clip });
    await p.screenshot({ path: path.join(ROOT, 'test', 'out', `${name}.png`), clip });
  }

  await p.waitForSelector(`${A} .ck[data-key="7"]`, { timeout: 20000 });
  check('ui: window title', await s.aurora(() => window.__aurora.wm.byApp('calculator')[0].title), 'Calculator');
  check('ui: default size 340x560', await win(), (r) => r.width === 340 && r.height === 560);
  check('ui: starts in Standard', (await p.textContent(`${A} .calc-title`)).trim(), 'Standard');

  // --- standard by clicks
  await press('2', 'add', '3', 'mul');
  check('ui std: "2 + 3 ×" expression', await expr(), '2 + 3 ×');
  check('ui std: intermediate 5', await display(), '5');
  await press('4', 'equals');
  check('ui std: 2 + 3 × 4 = 20', await display(), '20');
  check('ui std: expression after =', await expr(), '2 + 3 × 4 =');
  await press('equals');
  check('ui std: repeated = (× 4)', await display(), '80');
  await press('clear', '2', '0', '0', 'add', '1', '0', 'percent');
  check('ui std: 200 + 10% shows 20', await display(), '20');
  await press('equals');
  check('ui std: 200 + 10% = 220', await display(), '220');
  await press('clear', '9', 'sqrt');
  check('ui std: sqrt(9)', [await display(), await expr()], ['3', '√(9)']);
  await press('sqr');
  check('ui std: sqr(√(9))', [await display(), await expr()], ['9', 'sqr(√(9))']);
  await press('clear', '4', 'recip');
  check('ui std: 1/x', await display(), '0.25');
  await press('clear', '5', 'negate');
  check('ui std: ± on entry', await display(), '-5');
  await press('clear', '1', '2', '3', 'back');
  check('ui std: backspace', await display(), '12');
  await press('ce');
  check('ui std: CE', await display(), '0');
  await press('clear', '1', 'decimal', '5', 'decimal', '2');
  check('ui std: decimal point once', await display(), '1.52');

  // errors disable operators
  await press('clear', '1', 'div', '0', 'equals');
  check('ui std: divide by zero message', await display(), 'Cannot divide by zero');
  check('ui std: operators disabled on error', await p.$eval(`${A} [data-key="add"]`, (b) => b.disabled), true);
  check('ui std: memory disabled on error', await p.$eval(`${A} [data-key="ms"]`, (b) => b.disabled), true);
  check('ui std: digits stay enabled on error', await p.$eval(`${A} [data-key="7"]`, (b) => b.disabled), false);
  await press('7');
  check('ui std: digit clears error', await display(), '7');
  check('ui std: operators re-enabled', await p.$eval(`${A} [data-key="add"]`, (b) => b.disabled), false);
  await press('clear', '4', 'negate', 'sqrt');
  check('ui std: invalid input', await display(), 'Invalid input');
  await press('clear');

  // --- keyboard
  await typeSeq('12.5*2\n');
  check('kbd: 12.5*2 Enter', await display(), '25');
  await p.keyboard.press('Escape');
  check('kbd: Esc clears', await display(), '0');
  await typeSeq('1,5+1=');
  check('kbd: comma as decimal separator', await display(), '2.5');
  await p.keyboard.press('Escape');
  await typeSeq('81@');
  check('kbd: @ = sqrt', await display(), '9');
  await typeSeq('q');
  check('kbd: q = x²', await display(), '81');
  await typeSeq('r');
  check('kbd: r = 1/x', await display(), '0.0123456790123457');
  await p.keyboard.press('Escape');
  await typeSeq('7');
  await p.keyboard.press('F9');
  check('kbd: F9 = ±', await display(), '-7');
  await p.keyboard.press('Escape');
  await typeSeq('50+10%');
  check('kbd: % key', await display(), '5');
  await p.keyboard.press('Escape');
  await typeSeq('123');
  await p.keyboard.press('Backspace');
  check('kbd: Backspace', await display(), '12');
  await typeSeq('+5');
  await p.keyboard.press('Delete');
  check('kbd: Delete = CE', [await display(), await expr()], ['0', '12 +']);
  await typeSeq('8=');
  check('kbd: after CE', await display(), '20');
  // visual press feedback
  await p.keyboard.down('7');
  const pressedClass = await p.$eval(`${A} [data-key="7"]`, (b) => b.classList.contains('pressed'));
  await p.keyboard.up('7');
  check('kbd: key press shows pressed state', pressedClass, true);
  await p.keyboard.press('Escape');

  // --- memory (keyboard + buttons)
  await typeSeq('5');
  await p.keyboard.press('Control+m');
  check('mem: MC/MR enabled after MS', await p.$eval(`${A} [data-key="mr"]`, (b) => !b.disabled), true);
  await typeSeq('3');
  await p.keyboard.press('Control+p');
  await p.keyboard.press('Escape');
  await p.keyboard.press('Control+r');
  check('mem: 5 MS, 3 M+, MR = 8', await display(), '8');
  await typeSeq('2');
  await p.keyboard.press('Control+q');
  await p.keyboard.press('Control+r');
  check('mem: M− (8 − 2 = 6)', await display(), '6');
  await press('ms');
  await press('mlist');
  await p.waitForTimeout(400);
  const memItems = await p.$$eval(`${A} .calc-panefly .calc-mitem .calc-mitem-val`, (els) => els.map((e) => e.textContent));
  check('mem: memory list (newest first)', memItems, ['6', '6']);
  // per-item M+ on the second item
  await p.click(`${A} .calc-panefly .calc-mitem[data-index="1"]`, { position: { x: 20, y: 10 } });
  await p.waitForTimeout(300);
  check('mem: click item recalls', await display(), '6');
  await press('mlist');
  await p.waitForTimeout(350);
  await p.hover(`${A} .calc-panefly .calc-mitem[data-index="1"]`);
  await p.click(`${A} .calc-panefly .calc-mitem[data-index="1"] .calc-mitem-btn:nth-child(2)`);
  await p.waitForTimeout(200);
  check('mem: per-item M+', await p.$$eval(`${A} .calc-panefly .calc-mitem .calc-mitem-val`, (els) => els.map((e) => e.textContent)), ['6', '12']);
  await p.click(`${A} .calc-panefly .calc-mitem[data-index="0"] .calc-mitem-btn:nth-child(1)`);
  await p.waitForTimeout(200);
  check('mem: per-item clear', await p.$$eval(`${A} .calc-panefly .calc-mitem .calc-mitem-val`, (els) => els.map((e) => e.textContent)), ['12']);
  await p.keyboard.press('Escape');
  await p.waitForTimeout(250);
  check('mem: flyout closes on Esc', await p.$(`${A} .calc-panefly`), null);
  await p.keyboard.press('Control+l');
  check('mem: Ctrl+L clears memory (MR disabled)', await p.$eval(`${A} [data-key="mr"]`, (b) => b.disabled), true);

  // --- history flyout (narrow)
  await p.keyboard.press('Escape');
  await typeSeq('6*7=');
  await typeSeq('1+1=');
  await p.keyboard.press('Control+h');
  await p.waitForTimeout(400);
  const hist = await p.$$eval(`${A} .calc-panefly .calc-hitem`, (els) => els.map((e) => [e.querySelector('.calc-hitem-expr').textContent, e.querySelector('.calc-hitem-val').textContent]));
  check('history: newest first, with expressions', hist.slice(0, 2), [['1 + 1 =', '2'], ['6 × 7 =', '42']]);
  await p.click(`${A} .calc-panefly .calc-hitem:nth-child(2)`);
  await p.waitForTimeout(300);
  check('history: click recalls result + expression', [await display(), await expr()], ['42', '6 × 7 =']);
  await typeSeq('+1=');
  check('history: continue from recalled value', await display(), '43');

  // --- clipboard
  await p.keyboard.press('Control+c');
  await p.waitForTimeout(200);
  check('clipboard: Ctrl+C copies result', await s.aurora(() => window.__aurora.api.invoke('clipboard:readText')), '43');
  await s.aurora(() => window.__aurora.api.invoke('clipboard:writeText', '1,234.5'));
  await p.keyboard.press('Control+v');
  await p.waitForTimeout(200);
  check('clipboard: Ctrl+V pastes number', await display(), '1,234.5');
  await s.aurora(() => window.__aurora.api.invoke('clipboard:writeText', 'hello'));
  await p.keyboard.press('Control+v');
  await p.waitForTimeout(200);
  check('clipboard: invalid paste -> Invalid input', await display(), 'Invalid input');
  await p.keyboard.press('Escape');

  // --- screenshot: standard light EN (narrow)
  await press('clear');
  await typeSeq('1234.5+6*');
  await crop('calculator-standard-light-en');

  // --- docked history pane (wide)
  await press('clear');
  await typeSeq('125/5=');
  await typeSeq('2.5*4=');
  await typeSeq('9');
  await p.keyboard.press('Control+m');
  await p.keyboard.press('Escape');
  await setSize(820, 600);
  await p.waitForTimeout(500);
  check('dock: pane docked at >= 560px', await p.$eval(`${A} .calc`, (e) => e.classList.contains('docked')), true);
  check('dock: pane visible', await p.$eval(`${A} .calc-pane`, (e) => getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 200), true);
  check('dock: history button hidden', await p.$eval(`${A} [data-key="history"]`, (e) => e.hidden), true);
  check('dock: M˅ hidden when docked', await p.$eval(`${A} [data-key="mlist"]`, (e) => e.hidden), true);
  check('dock: history items listed', await p.$$eval(`${A} .calc-pane .calc-hitem`, (e) => e.length), (n) => n >= 4);
  await typeSeq('2+2=');
  check('dock: new item appears at top', await p.$eval(`${A} .calc-pane .calc-hitem .calc-hitem-expr`, (e) => e.textContent), '2 + 2 =');
  await crop('calculator-history-docked');
  await p.click(`${A} .calc-pane-tab[data-tab="memory"]`);
  check('dock: memory tab', await p.$$eval(`${A} .calc-pane .calc-mitem`, (e) => e.length), 1);
  await p.click(`${A} .calc-pane-tab[data-tab="history"]`);
  await p.click(`${A} .calc-pane [data-key="clear-history"]`);
  check('dock: clear history', await p.$eval(`${A} .calc-pane .calc-pempty`, (e) => e.textContent), "There's no history yet");
  await setSize(340, 560);
  await p.waitForTimeout(300);
  check('dock: undocks when narrow', await p.$eval(`${A} .calc`, (e) => e.classList.contains('docked')), false);

  // --- compact overlay (keep on top)
  await press('compact');
  await p.waitForTimeout(500);
  const cr = await win();
  check('compact: window shrinks', cr.width <= 300 && cr.height <= 420, true);
  check('compact: always on top', await s.aurora(() => window.__aurora.wm.byApp('calculator')[0].alwaysOnTop), true);
  check('compact: compact class', await p.$eval(`${A} .calc`, (e) => e.classList.contains('compact')), true);
  check('compact: keypad still works', await (async () => (await press('clear', '6', 'mul', '7', 'equals'), display()))(), '42');
  await s.aurora(() => window.__aurora.registry.launch('winver'));
  await p.waitForTimeout(500);
  const z = await s.aurora(() => {
    const c = window.__aurora.wm.byApp('calculator')[0];
    const o = window.__aurora.wm.byApp('winver')[0];
    return [Number(c.el.style.zIndex), Number(o.el.style.zIndex)];
  });
  check('compact: stays above a newly focused window', z[0] > z[1], true);
  await s.aurora(() => window.__aurora.wm.byApp('winver')[0].close(true));
  await s.aurora(() => window.__aurora.wm.byApp('calculator')[0].focus());
  await p.waitForTimeout(300);
  await press('fullview');
  await p.waitForTimeout(500);
  check('compact: back to full view restores size', await win(), (r) => r.width === 340 && r.height === 560);
  check('compact: no longer on top', await s.aurora(() => window.__aurora.wm.byApp('calculator')[0].alwaysOnTop), false);

  // --- scientific
  await mode('scientific');
  check('sci: title', (await p.textContent(`${A} .calc-title`)).trim(), 'Scientific');
  await press('clearSmart');
  await typeSeq('2+3*4=');
  check('sci: precedence 2+3*4 = 14', await display(), '14');
  await typeSeq('(2+3)*4=');
  check('sci: parentheses', await display(), '20');
  await press('lparen', 'lparen');
  check('sci: open-paren counter on key', (await p.textContent(`${A} [data-key="lparen"]`)).replace(/\s/g, ''), '(2');
  await p.keyboard.press('Escape');
  await typeSeq('30');
  await press('trig');
  await p.waitForTimeout(300);
  await press('sin');
  await p.waitForTimeout(250);
  check('sci: sin(30°) via Trigonometry flyout', [await display(), await expr()], ['0.5', 'sin(30)']);
  check('sci: trig flyout closes after use', await p.$(`${A} .calc-flyout`), null);
  await p.keyboard.press('Escape');
  await press('angle');
  check('sci: DEG -> RAD toggle', (await p.textContent(`${A} [data-key="angle"]`)).trim(), 'RAD');
  await typeSeq('p');
  await typeSeq('s');
  check('sci: sin(π) in RAD = 0', await display(), '0');
  await press('angle', 'angle');
  check('sci: back to DEG', (await p.textContent(`${A} [data-key="angle"]`)).trim(), 'DEG');
  await p.keyboard.press('Escape');
  await typeSeq('0.5');
  await press('trig');
  await p.waitForTimeout(250);
  await press('trig2nd');
  await press('asin');
  await p.waitForTimeout(200);
  check('sci: 2nd -> sin⁻¹(0.5) = 30', await display(), '30');
  await p.keyboard.press('Escape');
  await press('second');
  check('sci: 2nd switches x² -> x³', await p.$eval(`${A} .calc-keypad [data-key="cube"]`, (e) => !!e), true);
  await typeSeq('3');
  await press('cube');
  check('sci: x³', await display(), '27');
  await press('second');
  check('sci: 2nd off restores x²', !!(await p.$(`${A} .calc-keypad [data-key="sqr"]`)), true);
  await p.keyboard.press('Escape');
  await typeSeq('5!');
  check('sci: n!', await display(), '120');
  await p.keyboard.press('Escape');
  await typeSeq('2^10=');
  check('sci: ^ = x^y', await display(), '1,024');
  await press('fe');
  check('sci: F-E toggles scientific notation', await display(), '1.024e+3');
  await press('fe');
  await p.keyboard.press('Escape');
  await typeSeq('2.7');
  await press('func');
  await p.waitForTimeout(250);
  await press('floor');
  check('sci: floor via Function flyout', await display(), '2');
  await p.keyboard.press('Escape');
  await typeSeq('7');
  await press('mod');
  await typeSeq('3=');
  check('sci: mod', await display(), '1');
  await p.keyboard.press('Escape');
  await typeSeq('1000l');
  check('sci: log', await display(), '3');
  await typeSeq('n');
  check('sci: ln(3)', await display(), '1.09861228866811');
  await p.keyboard.press('Escape');
  await typeSeq('2x3=');
  check('sci: exp entry 2e3', await display(), '2,000');
  await p.keyboard.press('Escape');
  await setSize(320, 480);
  await p.waitForTimeout(400);
  check('sci: min size, keypad visible', await p.$eval(`${A} .calc-keypad`, (e) => e.getBoundingClientRect().height > 180 && e.scrollWidth <= e.clientWidth + 1), true);
  check('sci: min size, no horizontal overflow', await p.$eval(`${A} .calc-view`, (e) => e.scrollWidth <= e.clientWidth + 1), true);
  await setSize(340, 560);

  // --- programmer
  await mode('programmer');
  await press('clearSmart');
  await typeSeq('255');
  const radixVals = async () => p.$$eval(`${A} .calc-radix`, (els) => Object.fromEntries(els.map((e) => [e.dataset.radix, e.querySelector('.calc-radix-val').textContent])));
  check('prog: 255 in all radixes', await radixVals(), { hex: 'FF', dec: '255', oct: '377', bin: '1111 1111' });
  check('prog: hex digits disabled in DEC', await p.$eval(`${A} [data-key="A"]`, (b) => b.disabled), true);
  check('prog: decimal point disabled', await p.$eval(`${A} [data-key="decimal"]`, (b) => b.disabled), true);
  await press('radix-hex');
  check('prog: HEX selected', await p.$eval(`${A} .calc-radix[data-radix="hex"]`, (e) => e.classList.contains('selected')), true);
  check('prog: display in HEX', await display(), 'FF');
  check('prog: hex digits enabled in HEX', await p.$eval(`${A} [data-key="A"]`, (b) => b.disabled), false);
  await press('clearSmart');
  await press('A', 'B');
  check('prog: typing AB in HEX', (await radixVals()).dec, '171');
  await press('bitwise');
  await p.waitForTimeout(250);
  await press('and');
  await p.waitForTimeout(150);
  await typeSeq('F');
  await typeSeq('=');
  check('prog: AB AND F = B', await display(), 'B');
  await press('radix-dec');
  await press('clearSmart');
  await typeSeq('5');
  await press('bitwise');
  await p.waitForTimeout(250);
  await press('not');
  check('prog: NOT 5 = -6', await display(), '-6');
  check('prog: -6 in HEX (QWORD two\'s complement)', (await radixVals()).hex, 'FFFF FFFF FFFF FFFA');
  await press('word');
  check('prog: word size DWORD', (await p.textContent(`${A} [data-key="word"]`)).trim(), 'DWORD');
  check('prog: -6 in HEX (DWORD)', (await radixVals()).hex, 'FFFF FFFA');
  await press('word', 'word', 'word');
  check('prog: back to QWORD', (await p.textContent(`${A} [data-key="word"]`)).trim(), 'QWORD');
  await press('clearSmart');
  await typeSeq('1<4=');
  check('prog: 1 << 4 = 16', await display(), '16');
  await typeSeq('&');
  await typeSeq('24=');
  check('prog: & key (16 AND 24)', await display(), '16');
  await press('kp-bits');
  await p.waitForTimeout(300);
  await p.click(`${A} .calc-bit[data-bit="0"]`);
  check('prog: bit toggling keypad sets bit 0', await display(), '17');
  await press('kp-full');
  await press('clearSmart');
  await typeSeq('1/0=');
  check('prog: divide by zero', await display(), 'Cannot divide by zero');
  await press('clearSmart');
  await crop('calculator-programmer');

  // --- converters
  await mode('conv-temperature');
  check('conv: title', (await p.textContent(`${A} .calc-title`)).trim(), 'Temperature');
  await typeSeq('100');
  const convVals = async () => p.$$eval(`${A} .calc-conv-value`, (els) => els.map((e) => e.textContent));
  check('conv: 100 °C = 212 °F', await convVals(), ['100', '212']);
  await p.keyboard.press('F9');
  check('conv: ± for temperature', await convVals(), ['-100', '-148']);
  await p.click(`${A} .calc-conv-value[data-field="1"]`);
  await p.keyboard.press('Escape');
  await typeSeq('32');
  check('conv: type in the second field (32 °F = 0 °C)', await convVals(), ['0', '32']);
  await mode('conv-length');
  await p.keyboard.press('Escape');
  await p.click(`${A} [data-unit-field="0"]`);
  await p.waitForTimeout(250);
  await p.click(`.menu.calc-unit-menu .menu-item:has-text("Kilometers")`);
  await p.click(`${A} [data-unit-field="1"]`);
  await p.waitForTimeout(250);
  await p.click(`.menu.calc-unit-menu .menu-item:has-text("Miles") >> nth=0`);
  await p.click(`${A} .calc-conv-value[data-field="0"]`);
  await p.keyboard.press('Escape');
  await typeSeq('42.195');
  const lv = await convVals();
  check('conv: marathon 42.195 km in miles', lv, ['42.195', '26.21875623418754']);
  check('conv: "about equal to" shown', await p.$$eval(`${A} .calc-conv-chip`, (e) => e.length), 3);
  await crop('calculator-converter');
  await mode('conv-data');
  await p.keyboard.press('Escape');
  await typeSeq('1');
  check('conv: data default 1 GB = 1,000 MB', await convVals(), ['1', '1,000']);

  // --- date calculation
  await mode('date');
  check('date: same dates by default', (await p.textContent(`${A} [data-result="diff"]`)).trim(), 'Same dates');
  await p.click(`${A} [data-picker="to"]`);
  await p.waitForTimeout(300);
  await p.click(`${A} .calc-cal-nav >> nth=1`);
  await p.waitForTimeout(300);
  const today = new Date();
  const pickDay = Math.min(today.getDate(), 28);
  await p.click(`${A} .calc-cal-day:not(.other) >> text="${pickDay}"`);
  await p.waitForTimeout(250);
  {
    const a = ymd(today.getFullYear(), today.getMonth() + 1, today.getDate());
    const b = ymd(today.getFullYear() + (today.getMonth() === 11 ? 1 : 0), ((today.getMonth() + 1) % 12) + 1, pickDay);
    const d = diff(a, b);
    const pl = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
    const want = [d.years && pl(d.years, 'year'), d.months && pl(d.months, 'month'), d.weeks && pl(d.weeks, 'week'), d.days && pl(d.days, 'day')].filter(Boolean).join(', ');
    check('date: difference after picking next month in the calendar', (await p.textContent(`${A} [data-result="diff"]`)).trim(), want);
  }
  check('date: total days shown', (await p.textContent(`${A} [data-result="days"]`)).trim(), (t) => /^\d+ days$/.test(t));
  await p.click(`${A} [data-key="date-mode"]`);
  await p.waitForTimeout(250);
  await p.click('.menu .menu-item:has-text("Add or subtract days")');
  await p.waitForTimeout(300);
  await p.fill(`${A} [data-spin="days"]`, '10');
  const expected = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate() + 10));
  const expText = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', dateStyle: 'full' }).format(expected);
  check('date: add 10 days', (await p.textContent(`${A} [data-result="date"]`)).trim(), expText);
  await p.check(`${A} [data-op="sub"]`);
  const expected2 = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate() - 10));
  check('date: subtract 10 days', (await p.textContent(`${A} [data-result="date"]`)).trim(), new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', dateStyle: 'full' }).format(expected2));
  await crop('calculator-date');

  // --- maximized, keyboard mode shortcut, persistence
  await p.keyboard.press('Alt+2');
  await p.waitForTimeout(400);
  check('kbd: Alt+2 -> Scientific', await p.$eval(`${A} .calc`, (e) => e.dataset.mode), 'scientific');
  await s.aurora(() => window.__aurora.wm.byApp('calculator')[0].maximize());
  await p.waitForTimeout(600);
  check('max: docked pane when maximized', await p.$eval(`${A} .calc`, (e) => e.classList.contains('docked')), true);
  check('max: keys grow', await p.$eval(`${A} .calc-keypad [data-key="7"]`, (e) => e.getBoundingClientRect().height > 60), true);
  await s.aurora(() => window.__aurora.wm.byApp('calculator')[0].restore());
  await p.keyboard.press('Alt+1');
  await p.waitForTimeout(400);
  await mode('programmer');
  await p.waitForTimeout(600);
  const stateFile = path.join(home, '.config', 'aurora', 'apps', 'calculator', 'state.json');
  check('persist: state file written', fs.existsSync(stateFile) && JSON.parse(fs.readFileSync(stateFile, 'utf8')).mode, 'programmer');
  const errs1 = errorsOf(s);
  check('console: no calculator errors (EN light session)', errs1, []);
  await s.close();

  s = await launchShell({ open: ['calculator'], lang: 'fr', theme: 'dark', home });
  p = s.page;
  await p.waitForSelector(`${A} .calc-view`, { timeout: 20000 });
  check('persist: last mode restored after relaunch', await p.$eval(`${A} .calc`, (e) => e.dataset.mode), 'programmer');
  check('fr: window title', await s.aurora(() => window.__aurora.wm.byApp('calculator')[0].title), 'Calculatrice');
  await p.keyboard.press('Alt+1');
  await p.waitForTimeout(400);
  check('fr: Standard title', (await p.textContent(`${A} .calc-title`)).trim(), 'Standard');
  check('fr: decimal key shows comma', (await p.textContent(`${A} [data-key="decimal"]`)).trim(), ',');
  await typeSeq('1234567.89');
  check('fr: grouping with narrow no-break space', await display(), `1${NNBSP}234${NNBSP}567,89`);
  await p.keyboard.press('Escape');
  await typeSeq('1,5+1,25=');
  check('fr: comma input', await display(), '2,75');
  await typeSeq('/0=');
  check('fr: divide by zero message', await display(), 'Impossible de diviser par zéro');
  await p.keyboard.press('Escape');
  await typeSeq('4');
  await p.keyboard.press('F9');
  await typeSeq('@');
  check('fr: invalid input message', await display(), 'Entrée non valide');
  await p.keyboard.press('Escape');
  await typeSeq('10');
  for (let i = 0; i < 14; i++) await typeSeq('q');
  check('fr: overflow message', await display(), 'Dépassement de capacité');
  await p.keyboard.press('Escape');
  await s.aurora(() => window.__aurora.api.invoke('clipboard:writeText', '1 234,5'));
  await p.keyboard.press('Control+v');
  await p.waitForTimeout(200);
  check('fr: paste "1 234,5"', await display(), `1${NNBSP}234,5`);
  await p.keyboard.press('Escape');
  // scientific dark FR screenshot (docked)
  await p.keyboard.press('Alt+2');
  await setSize(800, 620);
  await p.waitForTimeout(400);
  await typeSeq('2*(3+4)=');
  await typeSeq('30s');
  check('fr: sci sin(30) = 0,5', await display(), '0,5');
  await p.keyboard.press('Escape');
  await typeSeq('1,5^2+');
  await typeSeq('4@');
  await crop('calculator-scientific-dark-fr');
  check('fr: expression uses FR formatting', await expr(), '1,5 ^ 2 + √(4)');
  check('fr: history docked FR', (await p.textContent(`${A} .calc-pane-tab[data-tab="history"]`)).trim(), 'Historique');
  // converter in FR + min size of each mode
  await mode('conv-weight');
  await typeSeq('1');
  check('fr: converter units in French', (await p.textContent(`${A} [data-unit-field="0"]`)).trim(), 'Kilogrammes');
  check('fr: 1 kg en livres', (await p.$$eval(`${A} .calc-conv-value`, (els) => els.map((e) => e.textContent)))[1], '2,204622621848776');
  await setSize(320, 480);
  for (const m of ['standard', 'scientific', 'programmer', 'date', 'conv-volume', 'conv-temperature']) {
    await mode(m);
    const ov = await p.$eval(`${A} .calc`, (root) => {
      const bad = [];
      for (const el of root.querySelectorAll('.calc-header, .calc-view, .calc-view *')) {
        if (el.closest('.calc-expr, .calc-result, .calc-conv-value, .calc-nav, .calc-radix-val')) continue;
        if (el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflow !== 'hidden' && !el.classList.contains('ellipsis') && el.clientWidth > 0) bad.push(el.className || el.tagName);
      }
      return bad.slice(0, 5);
    });
    check(`fr min size: no overflow in ${m}`, ov, []);
  }
  await p.keyboard.press('Alt+1');
  await p.waitForTimeout(300);
  const errs2 = errorsOf(s);
  check('console: no calculator errors (FR dark session)', errs2, []);
  const otherErrors = [...s.logs].filter((l) => l.startsWith('[error]') && !/calculator/i.test(l));
  if (otherErrors.length) console.log(`note: ${otherErrors.length} unrelated renderer error(s) from other shell components, e.g. ${otherErrors[0]}`);
  await s.close();
  fs.rmSync(home, { recursive: true, force: true });
}

// ================================================================ run
const t0 = Date.now();
if (!args.has('--ui-only')) part1();
console.log(`engine table: ${passed} checks passed${failures.length ? `, ${failures.length} failed` : ''}`);
if (!args.has('--engine-only')) {
  try {
    await part2();
  } catch (err) {
    failures.push(`UI test crashed: ${err.stack || err}`);
  }
}
console.log(`\n${passed} passed, ${failures.length} failed (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
if (failures.length) {
  console.log(`\nFAILURES:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log('OK');
