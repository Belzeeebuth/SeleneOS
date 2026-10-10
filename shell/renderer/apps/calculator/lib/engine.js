// Calculator engine shared by Standard, Scientific and Programmer modes.
//
// The expression is kept as a token list and evaluated with a shunting-yard parser (no eval).
// Standard mode gives every operator the same precedence, which yields the Windows "immediate
// execution" behaviour (2 + 3 × 4 = 20); Scientific/Programmer use real precedence tables.
//
//   const eng = new Engine(decimalSystem(), { prec: SCI_PREC });
//   eng.digit('2'); eng.op('+'); eng.digit('3'); eng.equals();  eng.value() -> Num(5)
//   eng.exprItems() -> render items for the expression line, eng.error -> error code or null
//
// Number systems (decimal.js / programmer.js) supply the value type, entry editing and operators.
import { CalcError } from './num.js';

export const STD_PREC = {}; // everything equal -> left-to-right
// Windows calculator precedence (CalcEngine): OR/XOR < AND/NAND/NOR < +,- < ×,÷,mod,shifts < ^,yroot,logy
export const SCI_PREC = { or: 0, xor: 0, and: 1, nand: 1, nor: 1, '+': 2, '-': 2, '*': 3, '/': 3, mod: 3, '%': 3, lsh: 3, rsh: 3, pow: 4, root: 4, logy: 4 };

const isCalcError = (e) => e instanceof CalcError || e?.calcError;
// "Maximum BigInt size exceeded" / "Invalid array length": a value too large to represent.
const asCalcError = (e) => (isCalcError(e) ? e : e instanceof RangeError ? new CalcError('overflow') : null);

export class Engine {
  constructor(sys, { prec = STD_PREC, percent = false, maxHistory = 100 } = {}) {
    this.sys = sys;
    this.prec = prec;
    this.percentMode = percent;
    this.maxHistory = maxHistory;
    this.onHistory = null; // ({ items, v }) => void
    this.clear();
  }

  clear() {
    this.tokens = []; // committed: {k:'val', v, node} | {k:'op', op} | {k:'('}
    this.entry = null; // string being typed
    this.operand = null; // { v, node, show } value waiting for an operator
    this.display = this.sys.zero; // last intermediate / final result
    this.error = null;
    this.errorExpr = null;
    this.done = false; // '=' was just pressed
    this.doneExpr = null;
    this.last = null; // { op, v } repeated by '='
  }

  // ------------------------------------------------------------ queries
  value() {
    if (this.entry != null) return this.sys.parseEntry(this.entry);
    if (this.operand) return this.operand.v;
    return this.display;
  }
  isEntering() {
    return this.entry != null && !this.error;
  }
  openParens() {
    return this.tokens.filter((t) => t.k === '(').length;
  }
  /** Items for the expression line: {k:'val', node} | {k:'op', op} | {k:'('} | {k:'eq'} */
  exprItems() {
    if (this.error) return this.errorExpr || [];
    if (this.done) return this.doneExpr ? [...this.doneExpr, { k: 'eq' }] : [];
    const items = [...this.tokens];
    if (this.operand?.show) items.push({ k: 'val', v: this.operand.v, node: this.operand.node });
    return items;
  }

  // ------------------------------------------------------------ internals
  _p(op) {
    return this.prec[op] ?? 1;
  }
  _lastTok() {
    return this.tokens[this.tokens.length - 1];
  }
  _hasFresh() {
    return this.entry != null || this.operand != null;
  }
  _num(v) {
    return { t: 'num', v };
  }
  _guard(fn, exprOnFail) {
    try {
      fn();
      return true;
    } catch (err) {
      const e = asCalcError(err);
      if (!e) throw err;
      this.errorExpr = typeof exprOnFail === 'function' ? exprOnFail() : exprOnFail || [...this.tokens];
      this.error = e.code;
      this.entry = null;
      this.operand = null;
      this.tokens = [];
      this.done = false;
      this.doneExpr = null;
      this.last = null;
      return false;
    }
  }
  _resetAfterDone() {
    if (this.done) {
      this.tokens = [];
      this.done = false;
      this.doneExpr = null;
    }
  }
  _current() {
    if (this.entry != null) {
      const v = this.sys.parseEntry(this.entry);
      return { v, node: this._num(v) };
    }
    if (this.operand) return { v: this.operand.v, node: this.operand.node };
    return { v: this.display, node: this._num(this.display) };
  }
  _commit() {
    const c = this._current();
    this.tokens.push({ k: 'val', v: c.v, node: c.node });
    this.entry = null;
    this.operand = null;
  }

  /** Shunting-yard evaluation of a token list. final=false keeps pending operators (partial display). */
  evaluate(tokens, final = true) {
    const vals = [];
    const ops = [];
    let last = null;
    const reduce = () => {
      const op = ops.pop();
      const b = vals.pop();
      const a = vals.pop();
      vals.push(this.sys.binary(op, a, b));
      last = { op, v: b };
    };
    for (const t of tokens) {
      if (t.k === 'val') vals.push(t.v);
      else if (t.k === '(') ops.push('(');
      else if (t.k === 'op') {
        while (ops.length && ops[ops.length - 1] !== '(' && this._p(ops[ops.length - 1]) >= this._p(t.op) && vals.length >= 2) reduce();
        ops.push(t.op);
      }
    }
    if (final) {
      while (ops.length) {
        if (ops[ops.length - 1] === '(') ops.pop();
        else if (vals.length >= 2) reduce();
        else ops.pop();
      }
    }
    return { value: vals.length ? vals[vals.length - 1] : this.display, last };
  }

  _emitHistory(items, v) {
    try {
      this.onHistory?.({ items, v });
    } catch (err) {
      console.error(err);
    }
  }

  // ------------------------------------------------------------ input
  digit(d) {
    if (this.sys.validDigit && !this.sys.validDigit(d)) return false;
    if (this.error) this.clear();
    if (this.done) {
      this._resetAfterDone();
      this.entry = null;
    }
    if (this.entry == null) {
      this.operand = null;
      this.entry = '0';
    }
    const next = this.sys.appendDigit(this.entry, d);
    if (next == null) return false;
    this.entry = next;
    return true;
  }

  decimal() {
    if (!this.sys.decimal) return false;
    if (this.error) this.clear();
    if (this.done) this._resetAfterDone();
    if (this.entry == null) {
      this.operand = null;
      this.entry = '0';
    }
    const next = this.sys.decimal(this.entry);
    if (next != null) this.entry = next;
    return next != null;
  }

  /** "exp" key: start typing a power-of-ten exponent. */
  exp() {
    if (this.error || !this.sys.exp) return false;
    if (this.done) this._resetAfterDone();
    if (this.entry == null) {
      this.operand = null;
      this.entry = '0';
    }
    const next = this.sys.exp(this.entry);
    if (next != null) this.entry = next;
    return next != null;
  }

  backspace() {
    if (this.error) {
      this.clear();
      return;
    }
    if (this.done) {
      this.doneExpr = null; // Windows: backspace after '=' clears the expression line
      return;
    }
    if (this.entry != null) this.entry = this.sys.backspace(this.entry);
  }

  /** CE: clear the current entry (or everything after an error / a result). */
  clearEntry() {
    if (this.error || this.done) {
      const last = this.done ? this.last : null;
      this.clear();
      this.last = last;
      return;
    }
    this.entry = '0';
    this.operand = null;
  }

  negate() {
    if (this.error) return;
    if (this.entry != null && !this.done) {
      const e = this.sys.negateEntry?.(this.entry);
      if (e != null) {
        this.entry = e;
        return;
      }
      if (this.sys.isZero(this.sys.parseEntry(this.entry))) return;
    }
    this.unary('negate');
  }

  unary(name) {
    if (this.error) return;
    let base;
    if (this.done) {
      base = { v: this.display, node: this._num(this.display) };
      this._resetAfterDone();
    } else base = this._current();
    const exprOnFail = () => [...this.tokens, { k: 'val', node: { t: 'fn', name, arg: base.node } }];
    this._guard(() => {
      const r = this.sys.unary(name, base.v);
      this.operand = { v: r, node: { t: 'fn', name, arg: base.node }, show: true };
      this.entry = null;
    }, exprOnFail);
  }

  /** π, e, rand… : replaces the current operand. */
  constant(name, v) {
    if (this.error) this.clear();
    if (this.done) this._resetAfterDone();
    this.entry = null;
    this.operand = { v, node: name ? { t: 'const', name } : this._num(v), show: false };
  }

  percent() {
    if (this.error) return;
    const cur = this._current();
    const lt = this._lastTok();
    let r;
    let ok = true;
    if (!this.done && lt && lt.k === 'op') {
      ok = this._guard(() => {
        const a = this.evaluate(this.tokens, false).value;
        r = this.sys.percentOf(a, cur.v, lt.op);
      });
    } else {
      this._resetAfterDone();
      r = this.sys.zero;
    }
    if (!ok) return;
    this.entry = null;
    this.operand = { v: r, node: this._num(r), show: true };
  }

  op(o) {
    if (this.error) return;
    if (this.done) {
      const v = this.display;
      this._resetAfterDone();
      this.operand = { v, node: this._num(v), show: false };
    }
    const lt = this._lastTok();
    if (!this._hasFresh() && lt && lt.k === 'op') {
      lt.op = o; // pressing another operator replaces the pending one
      return;
    }
    this._commit();
    this.tokens.push({ k: 'op', op: o });
    this._guard(
      () => {
        this.display = this.evaluate(this.tokens, false).value;
      },
      () => [...this.tokens],
    );
  }

  lparen() {
    if (this.error) return;
    if (this.done) {
      this._resetAfterDone();
      this.entry = null;
      this.operand = null;
    }
    const lt = this._lastTok();
    if (this._hasFresh() && (!lt || lt.k === 'op' || lt.k === '(')) {
      // "5 (" -> implicit multiplication
      this._commit();
      this.tokens.push({ k: 'op', op: '*' });
    }
    this.tokens.push({ k: '(' });
  }

  rparen() {
    if (this.error || this.done || !this.openParens()) return;
    this._closeGroup();
  }

  _closeGroup() {
    this._commit();
    let idx = this.tokens.length - 1;
    while (idx >= 0 && this.tokens[idx].k !== '(') idx--;
    const group = this.tokens.slice(idx + 1);
    this._guard(
      () => {
        const { value } = this.evaluate(group, true);
        this.tokens.splice(idx);
        this.operand = { v: value, node: { t: 'group', items: group }, show: true };
        this.display = value;
      },
      () => [...this.tokens],
    );
  }

  equals() {
    if (this.error) {
      this.clear();
      return;
    }
    if (this.done) {
      if (!this.last) return;
      const a = this.display;
      const { op, v } = this.last;
      this._guard(
        () => {
          const r = this.sys.binary(op, a, v);
          this.doneExpr = [
            { k: 'val', v: a, node: this._num(a) },
            { k: 'op', op },
            { k: 'val', v, node: this._num(v) },
          ];
          this.display = r;
          this._emitHistory(this.doneExpr, r);
        },
        () => [{ k: 'val', node: this._num(a) }, { k: 'op', op }, { k: 'val', node: this._num(v) }, { k: 'eq' }],
      );
      return;
    }
    if (!this.tokens.length) {
      const cur = this._current();
      if (this.last && this.entry != null) {
        // "2 + 3 =" then "7 =" repeats "+ 3"
        const { op, v } = this.last;
        this._guard(
          () => {
            const r = this.sys.binary(op, cur.v, v);
            this.doneExpr = [
              { k: 'val', v: cur.v, node: cur.node },
              { k: 'op', op },
              { k: 'val', v, node: this._num(v) },
            ];
            this.display = r;
            this.done = true;
            this.entry = null;
            this.operand = null;
            this._emitHistory(this.doneExpr, r);
          },
          () => [{ k: 'val', node: cur.node }, { k: 'op', op }, { k: 'val', node: this._num(v) }, { k: 'eq' }],
        );
        return;
      }
      const shown = this.operand?.show;
      this.doneExpr = [{ k: 'val', v: cur.v, node: cur.node }];
      this.display = cur.v;
      this.done = true;
      this.entry = null;
      this.operand = null;
      if (shown) this._emitHistory(this.doneExpr, cur.v);
      return;
    }
    this._commit();
    let ok = true;
    while (ok && this.openParens()) {
      // auto-close open parentheses: "(2 + 3 =" -> "(2 + 3) ="
      let idx = this.tokens.length - 1;
      while (idx >= 0 && this.tokens[idx].k !== '(') idx--;
      const group = this.tokens.slice(idx + 1);
      ok = this._guard(
        () => {
          const { value } = this.evaluate(group, true);
          this.tokens.splice(idx, this.tokens.length - idx, { k: 'val', v: value, node: { t: 'group', items: group } });
        },
        () => [...this.tokens, { k: 'eq' }],
      );
    }
    if (!ok) return;
    const items = [...this.tokens];
    this._guard(
      () => {
        const { value, last } = this.evaluate(items, true);
        this.display = value;
        if (last) this.last = last;
        this.doneExpr = items;
        this.done = true;
        this.tokens = [];
        this._emitHistory(items, value);
      },
      () => [...items, { k: 'eq' }],
    );
  }

  /** Replace the current operand by a value (MR, paste, bit toggling…). */
  setValue(v, { show = false, node = null } = {}) {
    if (this.error) this.clear();
    if (this.done) this._resetAfterDone();
    this.entry = null;
    this.operand = { v, node: node || this._num(v), show };
  }

  /** Make the typed entry final (after MS / M+ …) so the next digit starts a new number. */
  freeze() {
    if (this.entry != null) {
      const v = this.sys.parseEntry(this.entry);
      this.entry = null;
      this.operand = { v, node: this._num(v), show: false };
    }
  }

  /** History recall: show a past expression and its result. */
  recall({ items, v }) {
    this.clear();
    this.display = v;
    this.doneExpr = items;
    this.done = true;
  }

  /** Re-map every stored value (programmer word-size change). */
  mapValues(fn) {
    const mapNode = (n) => {
      if (!n) return n;
      if (n.t === 'num') return { t: 'num', v: fn(n.v) };
      if (n.t === 'fn') return { ...n, arg: mapNode(n.arg) };
      if (n.t === 'group') return { ...n, items: n.items.map(mapTok) };
      return n;
    };
    const mapTok = (t) => (t.k === 'val' ? { ...t, v: fn(t.v), node: mapNode(t.node) } : t);
    this.tokens = this.tokens.map(mapTok);
    if (this.operand) this.operand = { ...this.operand, v: fn(this.operand.v), node: mapNode(this.operand.node) };
    this.display = fn(this.display);
    if (this.doneExpr) this.doneExpr = this.doneExpr.map(mapTok);
    if (this.last) this.last = { ...this.last, v: fn(this.last.v) };
  }
}

// ---------------------------------------------------------------- expression rendering

/**
 * Render expression items to text.
 *   fmt(v) formats a value; opText(op) the operator symbol; fnText(name, inner) a function call;
 *   constText(name) a constant ('π').
 */
export function renderItems(items, { fmt, opText, fnText, constText }) {
  const node = (n) => {
    if (!n) return '';
    if (n.t === 'num') return fmt(n.v);
    if (n.t === 'const') return constText(n.name);
    if (n.t === 'group') return `(${renderItems(n.items, { fmt, opText, fnText, constText })})`;
    if (n.t === 'fn') {
      const inner = node(n.arg);
      const bare = n.arg?.t === 'group' ? inner.slice(1, -1) : inner;
      return fnText(n.name, bare);
    }
    return '';
  };
  let out = '';
  let glue = false;
  for (const it of items) {
    let s;
    if (it.k === 'val') s = node(it.node || { t: 'num', v: it.v });
    else if (it.k === 'op') s = opText(it.op);
    else if (it.k === '(') s = '(';
    else if (it.k === 'eq') s = '=';
    else continue;
    out += out && !glue ? ` ${s}` : s;
    glue = it.k === '(';
  }
  return out;
}
