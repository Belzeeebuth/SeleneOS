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
  const CMDS = new Set(['C', 'CE', 'BS', '=', '%', '(', ')', '.', 'neg', 'exp', 'pi', 'e']);
  for (const tok of seq.split(/\s+/).filter(Boolean)) {
    if (!CMDS.has(tok) && !(tok in OPS) && /^-?[0-9A-F]+(\.[0-9]*)?$/.test(tok)) {
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
    else if (tok === 'epow') e.unary('exp');
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
    ['2 log', '0.3010299956639812'],
    ['100 ln', '4.605170185988091'],
    ['e ln', '1'],
    ['0 ln', 'ERR:invalid'],
    ['5 fact', '120'],
    ['0 fact', '1'],
    ['20 fact', '2.43290200817664e+18'],
    ['3 neg fact', 'ERR:invalid'],
    ['0.5 fact', '0.886226925452758'],
    ['1.5 fact', '1.329340388179137'],
    ['0.5 neg fact', '1.772453850905516'],
    ['1.5 neg fact', '-3.544907701811032'],
    ['0.3 fact', '0.8974706963062772'],
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
    ['1 sinh', '1.175201193643801'],
    ['0 cosh', '1'],
    ['2 acosh', '1.316957896924817'],
    ['1 atanh', 'ERR:invalid'],
    // references computed independently with Python's decimal module (correctly rounded to 16 digits)
    ['2 ln', '0.6931471805599453'],
    ['10 ln', '2.302585092994046'],
    ['0.5 ln', '-0.6931471805599453'],
    ['2 epow', '7.38905609893065'],
    ['1 neg epow', '0.3678794411714423'],
    ['1000 epow', '1.970071114017047e+434'],
    ['0.001 epow', '1.001000500166708'],
    ['3 log', '0.4771212547196624'],
    ['0.5 pow10', '3.162277660168379'],
    ['2 pow 0.3 =', '1.231144413344916'],
    ['2 pow 100.5 =', '1.792728671193156e+30'],
    ['3 pow 1.1 =', '3.348369522101713'],
    ['10 pow 0.123 =', '1.32739445772974'],
    ['1.5 pow 2.5 =', '2.755675960631075'],
    ['7 root 2.5 =', '2.17790642448278'],
    ['2 logy 3 =', '0.6309297535714574'],
    ['50 logy 7 =', '2.010382137801854'],
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
    ['rad', '1 sin', '0.8414709848078965'],
    ['rad', '1 asin', '1.570796326794897'],
    ['grad', '100 sin', '1'],
    ['grad', '50 tan', '1'],
    ['grad', '1 asin', '100'],
    // independent Taylor-series references (Python decimal, 70 digits)
    ['rad', '1 cos', '0.5403023058681397'],
    ['rad', '1 tan', '1.557407724654902'],
    ['rad', '1 atan', '0.7853981633974483'],
    ['rad', '10 sin', '-0.5440211108893698'],
    ['deg', '37 sin', '0.6018150231520483'],
    ['deg', '1000 cos', '0.1736481776669303'],
    ['deg', '89 tan', '57.28996163075942'],
    ['deg', '2 atan', '63.43494882292201'],
    ['deg', '0.3 asin', '17.45760312372209'],
    ['deg', '0.3 acos', '72.54239687627791'],
    ['grad', '50 sin', '0.7071067811865475'],
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
    ['length', 'km', 'mi', '1', '0.621371192237334'],
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

// ================================================================ Part 1b: QA regressions (engine)
// Bugs found in QA: huge exact powers froze the whole shell (all apps share one renderer), BigInt
// RangeErrors and out-of-range exponent entries escaped as "unexpected error" alerts, asinh/acosh
// and mod overflowed on large but valid inputs. References from Python's decimal module.
function part1qa() {
  const timed = (seq, prec = SCI_PREC) => {
    const t = performance.now();
    const r = feed(seq, { prec });
    return { ...r, ms: performance.now() - t };
  };
  const HEAVY = [
    ['1.0000001 pow 99999 =', '1.010050065574136'],
    ['1.0000001 neg pow 99999 =', '-1.010050065574136'],
    ['0.9999999999999999 pow 9999999999999999 =', '0.3678794411714423'],
    ['1.000000000000001 pow 999999999999999 =', '2.718281828459041'],
    ['1.23456789 pow 12345 =', '5.654486280073803e+1129'],
    ['1.23456789 pow 1234 neg =', '1.176300206120295e-113'],
    ['1.0000001 root 0.00001 =', '1.010050166579143'],
    ['3 pow 20000 =', '2.66130342721742e+9542'],
    ['1.5 pow 9999999999999999 =', 'ERR:overflow'],
    ['1 exp 9999 mod 0.0000007 =', '0.0000004'],
    ['1 exp 9999 asinh', '23,024.24149202802'],
    ['1 exp 9999 acosh', '23,024.24149202802'],
    ['1 exp 30 = neg asinh', '-69.77069997038132'],
    ['1 exp 30 neg asinh', '1.e-30'], // ± while typing the exponent flips the exponent's sign
  ];
  for (const [seq, disp] of HEAVY) {
    const r = timed(seq);
    check(`qa engine: ${seq}`, r.display, disp);
    check(`qa engine: ${seq} is fast (no freeze)`, r.ms, (ms) => ms < 1500);
  }
  // exponent entry can no longer leave the representable range (it threw out of the engine)
  for (const [seq, disp] of [
    ['99 exp 9999 +', '9.9e+1000'],
    ['99 exp 9999 sqrt', '3.146426544510455e+500'],
    ['99 exp 9999 =', '9.9e+1000'],
    ['0.01 exp neg 9999 =', '1.e-1001'],
  ]) {
    let r;
    try {
      r = feed(seq, { prec: SCI_PREC }).display;
    } catch (err) {
      r = `THROWS ${err.message}`;
    }
    check(`qa engine: ${seq} (no exception)`, r, disp);
  }
  // any RangeError from a number system becomes "Overflow" instead of escaping
  const sys = decimalSystem();
  const eng = new Engine({ ...sys, binary: () => { throw new RangeError('Maximum BigInt size exceeded'); } }, { prec: SCI_PREC });
  eng.digit('2');
  eng.op('pow');
  eng.digit('3');
  let threw = null;
  try {
    eng.equals();
  } catch (err) {
    threw = err.message;
  }
  check('qa engine: RangeError -> Overflow state', [threw, eng.error], [null, 'overflow']);
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
  check('layout: no hamburger, the mode switcher is a dropdown that shows the mode', await p.$eval(`${A} [data-key="nav"]`, (b) => b.classList.contains('calc-modebtn') && b.getAttribute('aria-haspopup') === 'menu' && b.querySelector('.calc-title')?.textContent === 'Standard' && !document.querySelector('.app-calculator .calc-ham')), true);
  check('mem: the memory keys stay hidden until the Memory button shows them', await p.$eval(`${A} .calc-memrow`, (e) => getComputedStyle(e).display), 'none');
  await p.click(`${A} .calc-mem-btn`);
  check('mem: the Memory button in the header shows the memory keys', await p.$eval(`${A} .calc-memrow`, (e) => getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().height > 20), true);
  check('mem: the Memory button reports its state', await p.$eval(`${A} .calc-mem-btn`, (b) => b.getAttribute('aria-expanded')), 'true');
  check('keys: operator column tinted with the accent, equals filled with it', await s.aurora(() => {
    const cs = (k) => getComputedStyle(document.querySelector(`.app-calculator .ck[data-key="${k}"]`));
    const acc = getComputedStyle(document.querySelector('.app-calculator')).getPropertyValue('--accent').trim();
    return cs('add').backgroundColor !== cs('7').backgroundColor && cs('add').backgroundColor !== cs('percent').backgroundColor && cs('equals').backgroundColor !== cs('add').backgroundColor && !!acc;
  }), true);
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
  await typeSeq('4095<4=');
  check('prog: 4095 << 4', await radixVals(), { hex: 'FFF0', dec: '65,520', oct: '177 760', bin: '1111 1111 1111 0000' });
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
  check('conv: marathon 42.195 km in miles', lv, ['42.195', '26.21875745645431']);
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
  await setSize(340, 560);

  // keyboard focus: Tab reaches the controls (focus ring via :focus-visible)
  await s.aurora(() => document.querySelector('.app-calculator .calc').focus());
  await p.keyboard.press('Tab');
  check('a11y: Tab moves focus to the navigation button', await s.aurora(() => document.activeElement?.dataset?.key), 'nav');
  await p.keyboard.press('Enter');
  await p.waitForTimeout(400);
  check('a11y: Enter on the mode dropdown opens the list of modes', await p.$eval(`${A} .calc`, (e) => e.classList.contains('nav-open')), true);
  check('a11y: keyboard focus lands on the current mode', await s.aurora(() => document.activeElement?.dataset?.mode), 'standard');
  await p.keyboard.press('ArrowDown');
  await p.keyboard.press('Enter');
  await p.waitForTimeout(400);
  check('a11y: ArrowDown + Enter selects Scientific', await p.$eval(`${A} .calc`, (e) => e.dataset.mode), 'scientific');
  check('a11y: navigation pane closed after selection', await p.$eval(`${A} .calc`, (e) => e.classList.contains('nav-open')), false);
  check('a11y: each mode keeps its own pending calculation', await expr(), '1,5 ^ 2 + √(4)');
  await p.keyboard.press('Escape');
  await typeSeq('2+2\n');
  check('a11y: typing works right after keyboard navigation', await display(), '4');
  await p.keyboard.press('Alt+1');
  await p.waitForTimeout(300);
  check('a11y: keys have accessible names', await p.$eval(`${A} [data-key="sqrt"]`, (b) => b.getAttribute('aria-label')), 'Racine carrée');
  check('a11y: display is a live region', await p.$eval(`${A} .calc-result`, (e) => e.getAttribute('aria-live')), 'polite');

  // a second, independent calculator window
  await s.aurora(() => window.__aurora.registry.launch('calculator'));
  await p.waitForTimeout(800);
  check('multi: two calculator windows', await s.aurora(() => window.__aurora.wm.byApp('calculator').length), 2);
  await typeSeq('77');
  const both = await s.aurora(() => window.__aurora.wm.byApp('calculator').map((w) => w.el.querySelector('.calc-result')?.textContent));
  check('multi: typing only affects the focused window', both[1] === '77' && both[0] !== '77', true);
  await s.aurora(() => window.__aurora.wm.byApp('calculator')[1].close());
  await p.waitForTimeout(400);

  // reduced motion: everything still works with animations off
  await s.aurora(() => window.__aurora.settings.set('animations', false));
  await p.waitForTimeout(300);
  check('motion: data-animations="off"', await s.aurora(() => document.documentElement.dataset.animations), 'off');
  await s.aurora(() => window.__aurora.wm.byApp('calculator')[0].focus());
  await mode('scientific');
  await press('trig');
  check('motion: flyout opens', !!(await p.$(`${A} .calc-flyout`)), true);
  await p.keyboard.press('Escape');
  await p.waitForTimeout(50);
  check('motion: flyout closes immediately', await p.$(`${A} .calc-flyout`), null);
  await mode('standard');
  check('motion: mode switch', await p.$eval(`${A} .calc`, (e) => e.dataset.mode), 'standard');
  await s.aurora(() => window.__aurora.settings.set('animations', true));

  // live language switch rebuilds the UI and keeps the state
  await press('clear');
  await typeSeq('1234,5');
  await s.aurora(() => window.__aurora.settings.set('lang', 'en'));
  await p.waitForTimeout(500);
  check('lang: switch to English keeps the value, re-formatted', await display(), '1,234.5');
  check('lang: window title follows', await s.aurora(() => window.__aurora.wm.byApp('calculator')[0].title), 'Calculator');
  check('lang: decimal key follows', (await p.textContent(`${A} [data-key="decimal"]`)).trim(), '.');
  await s.aurora(() => window.__aurora.settings.set('lang', 'fr'));
  await p.waitForTimeout(400);
  const errs2 = errorsOf(s);
  check('console: no calculator errors (FR dark session)', errs2, []);
  const otherErrors = [...s.logs].filter((l) => l.startsWith('[error]') && !/calculator/i.test(l));
  if (otherErrors.length) console.log(`note: ${otherErrors.length} unrelated renderer error(s) from other shell components, e.g. ${otherErrors[0]}`);
  await s.close();
  fs.rmSync(home, { recursive: true, force: true });
}

// ================================================================ Part 3: QA regressions (UI)
async function part3() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-calc-qa-'));
  const sdir = path.join(home, '.config', 'aurora', 'apps', 'calculator');
  const stateFile = path.join(sdir, 'state.json');
  fs.mkdirSync(sdir, { recursive: true });
  // hostile saved state (the file is user-writable): markup, wrong types, prototype keys
  fs.writeFileSync(
    stateFile,
    '{"mode":"<img src=x onerror=window.__pwned=1>","angle":"<b>","fe":"yes","prog":{"radix":"16","bits":7,"shift":"x","keypad":"<x>"},' +
      '"conv":{"__proto__":{"from":"km","to":"mi"},"constructor":{"from":"a","to":"b"},"length":{"from":"<img>","to":"mi"},"weight":{"from":"lb","to":"kg"}},"date":{"mode":"__proto__"}}',
  );
  const s = await launchShell({ open: ['calculator'], lang: 'en', theme: 'light', home });
  const p = s.page;
  const errorsOf = () => s.logs.filter((l) => l.startsWith('[pageerror]') || (l.startsWith('[error]') && /calculator|apps\/calc/i.test(l)));
  const calcWin = (i = 0) => s.aurora((i) => window.__aurora.wm.byApp('calculator')[i], i);
  const winInfo = () =>
    s.aurora(() => {
      const w = window.__aurora.wm.byApp('calculator')[0];
      return { state: w.state, snap: w.snap, top: w.alwaysOnTop, rect: w.rect(), maxHidden: w.btnMax.hidden, maximizable: w.opts.maximizable, compact: w.body.querySelector('.calc').classList.contains('compact') };
    });
  const display = async () => (await p.textContent(`${A} .calc-result`)).trim();
  const press = async (...keys) => {
    for (const k of keys) await p.click(`${A} [data-key="${k}"]`);
  };
  const typeSeq = async (str) => {
    for (const ch of str) await p.keyboard.press(ch === '\n' ? 'Enter' : ch);
  };
  const setSize = (w, h) => s.aurora(([w, h]) => window.__aurora.wm.byApp('calculator')[0].setRect({ width: w, height: h }), [w, h]);
  const mode = async (id) => {
    await press('nav');
    await p.waitForTimeout(350);
    await p.click(`${A} .calc-nav-item[data-mode="${id}"]`);
    await p.waitForTimeout(400);
  };
  const clip = (text) => s.app.evaluate(({ clipboard }, t) => clipboard.writeText(t), text);
  const cdp = await p.context().newCDPSession(p);
  const listeners = async () => {
    const { result } = await cdp.send('Runtime.evaluate', { expression: 'document' });
    const { listeners: ls } = await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId });
    const { result: w } = await cdp.send('Runtime.evaluate', { expression: 'window' });
    const { listeners: wl } = await cdp.send('DOMDebugger.getEventListeners', { objectId: w.objectId });
    return { doc: ls.length, keydown: ls.filter((l) => l.type === 'keydown').length, win: wl.length };
  };
  const focusInside = (sel) => s.aurora((sel) => !!document.activeElement?.closest(sel), sel);

  await p.waitForSelector(`${A} .ck[data-key="7"]`, { timeout: 20000 });
  // --- hostile saved state
  check('qa state: hostile mode falls back to Standard', await p.$eval(`${A} .calc`, (e) => e.dataset.mode), 'standard');
  check('qa state: no markup injected', await s.aurora(() => [window.__pwned, document.querySelectorAll('.app-calculator .calc img, .app-calculator .calc b').length]), [undefined, 0]);
  check('qa state: Object.prototype untouched', await s.aurora(() => Object.keys(Object.getPrototypeOf({})).length), 0);
  await mode('conv-weight');
  check('qa state: valid saved units kept', await p.$$eval(`${A} .calc-conv-unit`, (b) => b.map((x) => x.textContent.trim())), ['Pounds', 'Kilograms']);
  await mode('conv-length');
  check('qa state: invalid saved units replaced by defaults', await p.$$eval(`${A} .calc-conv-unit`, (b) => b.map((x) => x.textContent.trim())), ['Centimeters', 'Inches']);
  // converter: huge values stay values (they used to become 0 when activated or pasted)
  await clip('1e50');
  await p.keyboard.press('Control+v');
  await p.waitForTimeout(200);
  check('qa conv: paste 1e50', await p.$$eval(`${A} .calc-conv-value`, (e) => e.map((x) => x.textContent)), ['1.e+50', '3.937007874015748e+49']);
  await p.click(`${A} .calc-conv-value[data-field="1"]`);
  check('qa conv: activating a huge converted value keeps it', await p.$$eval(`${A} .calc-conv-value`, (e) => e.map((x) => x.textContent)), ['1.e+50', '3.937007874015748e+49']);
  await p.keyboard.press('Alt+1');
  await p.waitForTimeout(700);
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  check('qa state: only known converter categories persisted', Object.keys(saved.conv).sort(), ['length', 'weight']);
  check('qa state: angle/fe/prog sanitized ("fe":"yes" is not true)', [saved.angle, saved.fe, saved.prog.radix, saved.prog.bits, saved.prog.shift, saved.prog.keypad], ['deg', false, 10, 64, 'arith', 'full']);

  // --- shell freeze regressions through the UI (scientific)
  await p.keyboard.press('Alt+2');
  await p.waitForTimeout(300);
  let t = Date.now();
  await typeSeq('1.0000001^99999=');
  check('qa ui: 1.0000001^99999 computed (no freeze)', [await display(), Date.now() - t < 4000], ['1.010050065574136', true]);
  await p.keyboard.press('Escape');
  await typeSeq('99x9999+');
  check('qa ui: out-of-range exponent entry -> no "unexpected error" dialog', [await display(), await p.$(`${A} .dialog-layer`)], ['9.9e+1000', null]);
  await p.keyboard.press('Escape');
  await p.keyboard.press('Alt+1');
  await p.waitForTimeout(300);

  // --- paste is limited like Windows (512 characters)
  await clip('1'.repeat(600));
  await p.keyboard.press('Control+v');
  await p.waitForTimeout(200);
  check('qa paste: > 512 characters -> Invalid input', await display(), 'Invalid input');
  await clip('<img src=x onerror=window.__pwned=2>');
  await p.keyboard.press('Control+v');
  await p.waitForTimeout(200);
  check('qa paste: markup is just invalid input', [await display(), await s.aurora(() => window.__pwned)], ['Invalid input', undefined]);
  await p.keyboard.press('Escape');

  // --- Tab stays inside the window (it walked out into the taskbar, after which every key was ignored)
  await s.aurora(() => document.querySelector('.app-calculator .calc').focus());
  let inside = true;
  for (let i = 0; i < 45; i++) {
    await p.keyboard.press('Tab');
    inside &&= await focusInside('.app-calculator');
  }
  check('qa focus: 45 x Tab stays in the calculator', inside, true);
  inside = true;
  for (let i = 0; i < 12; i++) {
    await p.keyboard.press('Shift+Tab');
    inside &&= await focusInside('.app-calculator');
  }
  check('qa focus: Shift+Tab stays in the calculator', inside, true);
  await s.aurora(() => document.querySelector('.app-calculator .calc').focus());
  await typeSeq('9*9=');
  check('qa focus: typing still works after tabbing around', await display(), '81');
  await p.focus(`${A} .calc-header [data-key="nav"]`);
  await p.keyboard.press('Enter');
  await p.waitForTimeout(400);
  inside = true;
  for (let i = 0; i < 20; i++) {
    await p.keyboard.press('Tab');
    inside &&= await focusInside('.app-calculator .calc-nav');
  }
  check('qa focus: Tab cycles inside the open navigation pane', inside, true);
  await p.keyboard.press('Escape');
  await p.waitForTimeout(300);
  await typeSeq('1+2=');
  await p.keyboard.press('Control+h');
  await p.waitForTimeout(300);
  inside = true;
  for (let i = 0; i < 6; i++) {
    await p.keyboard.press('Tab');
    inside &&= await focusInside('.app-calculator .calc-panefly-panel');
  }
  check('qa focus: Tab cycles inside the history flyout', inside, true);
  await p.keyboard.press('Escape');
  await p.waitForTimeout(300);
  check('qa focus: Esc closes the history flyout', await p.$(`${A} .calc-panefly`), null);
  await typeSeq('6*7=');
  check('qa focus: keys work after the flyout', await display(), '42');
  await p.keyboard.press('Escape');

  // --- programmer: long BIN values wrap instead of being cut with an ellipsis
  await setSize(320, 480);
  await p.keyboard.press('Alt+4');
  await p.waitForTimeout(300);
  await typeSeq('1');
  await p.keyboard.press('F9');
  await p.waitForTimeout(300);
  const bin = await p.$eval(`${A} .calc-radix[data-radix="bin"] .calc-radix-val`, (e) => ({ ones: (e.textContent.match(/1/g) || []).length, clipped: e.scrollWidth > e.clientWidth + 1, lines: Math.round(e.getBoundingClientRect().height / parseFloat(getComputedStyle(e).lineHeight)) }));
  check('qa prog: BIN of -1 shows all 64 bits, wrapped, not clipped', [bin.ones, bin.clipped, bin.lines > 1], [64, false, true]);
  check(
    'qa prog: keypad still inside the window at min size',
    await s.aurora(() => {
      const w = document.querySelector('.app-calculator');
      return w.querySelector('.calc-keypad').getBoundingClientRect().bottom <= w.querySelector('.win-body').getBoundingClientRect().bottom + 1;
    }),
    true,
  );
  await p.keyboard.press('Escape');
  await setSize(340, 560);

  // --- date: an open calendar no longer survives a mode switch
  await p.keyboard.press('Alt+5');
  await p.waitForTimeout(300);
  await p.click(`${A} .calc-dp[data-picker="from"]`);
  await p.waitForTimeout(300);
  check('qa date: calendar flyout open', !!(await p.$(`${A} .calc-cal-flyout`)), true);
  await p.keyboard.press('Alt+1');
  await p.waitForTimeout(400);
  check('qa date: Alt+1 closes the calendar (no orphan flyout)', await p.$(`${A} .calc-cal-flyout`), null);

  // --- keep on top (compact overlay): no maximize / snap, title-bar back button, restores snap
  await s.aurora(() => window.__aurora.wm.byApp('calculator')[0].snapTo('right'));
  await p.waitForTimeout(400);
  await press('compact');
  await p.waitForTimeout(500);
  let wi = await winInfo();
  check('qa compact: on, on top, maximize button hidden', [wi.compact, wi.top, wi.maxHidden, wi.maximizable, wi.state], [true, true, true, false, 'normal']);
  check('qa compact: "Back to full view" sits in the title bar', !!(await p.$(`${A} .win-titlebar .win-tb-slot [data-key="fullview"]`)), true);
  const tb = await s.aurora(() => {
    const r = window.__aurora.wm.byApp('calculator')[0].titlebar.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await p.mouse.dblclick(tb.x, tb.y);
  await p.waitForTimeout(400);
  await s.aurora(() => {
    const w = window.__aurora.wm.byApp('calculator')[0];
    w.maximize();
    w.snapTo('left');
  });
  await p.waitForTimeout(400);
  wi = await winInfo();
  check('qa compact: title double-click / maximize / snap ignored', [wi.state, wi.compact, wi.rect.width, wi.rect.height], ['normal', true, 296, 400]);
  await s.aurora(async () => {
    const n = await window.__aurora.registry.launch('notepad');
    n.maximize();
    n.focus();
  });
  await p.waitForTimeout(700);
  check(
    'qa compact: stays above a maximized, focused window',
    await s.aurora(() => {
      const r = window.__aurora.wm.byApp('calculator')[0].el.getBoundingClientRect();
      return !!document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('.app-calculator');
    }),
    true,
  );
  await s.aurora(() => window.__aurora.wm.byApp('calculator')[0].focus());
  await p.waitForTimeout(200);
  await p.keyboard.press('Escape');
  await typeSeq('7*6=');
  check('qa compact: keypad works', await display(), '42');
  await s.aurora(() => window.__aurora.wm.byApp('calculator')[0].el.scrollIntoView());
  {
    await p.waitForTimeout(300);
    const r = await s.aurora(() => window.__aurora.wm.byApp('calculator')[0].rect());
    const m = 24;
    const clipR = { x: Math.max(0, r.x - m), y: Math.max(0, r.y - m), width: r.width + 2 * m, height: r.height + 2 * m };
    await p.screenshot({ path: path.join(DOCS, 'calculator-compact.png'), clip: clipR });
  }
  await press('fullview');
  await p.waitForTimeout(500);
  wi = await winInfo();
  check('qa compact: back to full view restores the snapped layout', [wi.compact, wi.top, wi.maxHidden, wi.maximizable, wi.state, wi.snap], [false, false, false, true, 'snapped', 'right']);
  await s.aurora(() => {
    window.__aurora.wm.byApp('notepad')[0]?.close(true);
    window.__aurora.wm.byApp('calculator')[0].restore();
  });
  await p.waitForTimeout(500);

  // --- leaks: 15 open/close cycles (with flyouts, menus, nav, calendar and compact open at close time)
  const launch = () => s.aurora(async () => (await window.__aurora.registry.launch('calculator', { newWindow: true })).id);
  const closeWin = (id) => s.aurora((id) => window.__aurora.wm.get(id).close(), id);
  const warm = await launch();
  await p.waitForTimeout(300);
  await closeWin(warm);
  await p.waitForTimeout(600);
  const before = await listeners();
  // two calculator windows are open: scope every selector to the new one
  const scenarios = [
    async () => {},
    async (W) => p.click(`${W} [data-key="nav"]`),
    async (W) => {
      await p.keyboard.press('Alt+2');
      await p.click(`${W} [data-key="trig"]`);
    },
    async (W) => {
      await p.keyboard.press('Alt+5');
      await p.click(`${W} .calc-dp[data-picker="from"]`);
    },
    async (W) => {
      await p.keyboard.press('Alt+1');
      await p.click(`${W} [data-key="compact"]`);
    },
    async (W) => {
      await p.keyboard.press('Alt+4');
      await p.click(`${W} [data-key="bitshift"]`);
    },
  ];
  let scenarioErrors = 0;
  for (let i = 0; i < 15; i++) {
    const id = await launch();
    await p.waitForTimeout(250);
    await s.aurora((id) => window.__aurora.wm.get(id).focus(), id);
    await scenarios[i % scenarios.length](`${A}[data-id="${id}"]`).catch(() => scenarioErrors++);
    await p.waitForTimeout(150);
    await closeWin(id);
    await p.waitForTimeout(450);
  }
  await p.mouse.click(5, 5);
  await p.waitForTimeout(500);
  const after = await listeners();
  check('qa leaks: every open/close scenario ran', scenarioErrors, 0);
  check('qa leaks: document/window listeners unchanged after 15 open/close', after, before);
  check(
    'qa leaks: no stray flyouts, menus or windows',
    await s.aurora(() => [document.querySelectorAll('.calc-flyout').length, document.querySelectorAll('body > .menu').length, window.__aurora.wm.byApp('calculator').length]),
    [0, 0, 1],
  );
  // closing a window while it still loads its saved state
  const b2 = await listeners();
  await s.aurora(async () => {
    const pr = window.__aurora.registry.launch('calculator', { newWindow: true });
    await new Promise((r) => setTimeout(r, 0));
    const ws = window.__aurora.wm.byApp('calculator');
    ws[ws.length - 1].close(true);
    await pr;
  });
  await p.waitForTimeout(700);
  check('qa leaks: closing during startup leaves no keydown listener', (await listeners()).keydown, b2.keydown);

  // --- storage write failure (state.json replaced by a directory): the app keeps working
  fs.rmSync(stateFile, { force: true });
  fs.mkdirSync(stateFile);
  await s.aurora(() => window.__aurora.wm.byApp('calculator')[0].focus());
  await p.keyboard.press('Alt+2');
  await p.waitForTimeout(600);
  await p.keyboard.press('Alt+1');
  await p.waitForTimeout(600);
  await typeSeq('2+2=');
  check('qa storage: unwritable state -> still calculates', await display(), '4');
  const id3 = await launch();
  await p.waitForTimeout(500);
  check('qa storage: unreadable state -> new window starts in Standard', await s.aurora((id) => window.__aurora.wm.get(id).body.querySelector('.calc').dataset.mode, id3), 'standard');
  await closeWin(id3);
  await p.waitForTimeout(400);

  check('console: no calculator errors (QA session)', errorsOf(), []);
  await s.close();
  fs.rmSync(home, { recursive: true, force: true });
}

// ================================================================ run
const t0 = Date.now();
if (!args.has('--ui-only')) {
  part1();
  part1qa();
}
console.log(`engine table: ${passed} checks passed${failures.length ? `, ${failures.length} failed` : ''}`);
if (!args.has('--engine-only')) {
  try {
    if (!args.has('--qa-only')) await part2();
  } catch (err) {
    failures.push(`UI test crashed: ${err.stack || err}`);
  }
  try {
    await part3();
  } catch (err) {
    failures.push(`QA UI test crashed: ${err.stack || err}`);
  }
}
console.log(`\n${passed} passed, ${failures.length} failed (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
if (failures.length) {
  console.log(`\nFAILURES:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log('OK');
