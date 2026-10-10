// Standard / Scientific / Programmer views: display, memory row, keypads and flyouts.
// The engines (lib/engine.js) live in the app controller so their state survives mode switches,
// language changes and compact-overlay toggles; a view is only DOM + bindings.
import { renderItems } from '../lib/engine.js';
import { formatNum, formatEntry, LOCALES } from '../lib/num.js';
import { CONSTANTS, randomNum } from '../lib/decimal.js';
import { RADIXES, WORDS, SHIFTS } from '../lib/programmer.js';
import { openFlyout, fitText } from './widgets.js';

const ANGLES = ['deg', 'rad', 'grad'];
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// Key labels (math notation, identical in every language). `null` = localized via i18n "key.*".
const LABELS = {
  percent: '%',
  ce: 'CE',
  clear: 'C',
  recip: '<span class="k-frac"><sup>1</sup>/<i>x</i></span>',
  sqr: '<i>x</i><sup>2</sup>',
  cube: '<i>x</i><sup>3</sup>',
  sqrt: '<sup class="k-idx">2</sup>√<i>x</i>',
  cbrt: '<sup class="k-idx">3</sup>√<i>x</i>',
  div: '÷',
  mul: '×',
  sub: '−',
  add: '+',
  equals: '=',
  negate: '<span class="k-pm"><sup>+</sup>/<sub>−</sub></span>',
  pi: 'π',
  econst: '<i>e</i>',
  abs: '|<i>x</i>|',
  expEntry: 'exp',
  mod: 'mod',
  lparen: '(',
  rparen: ')',
  fact: '<i>n</i>!',
  pow: '<i>x</i><sup><i>y</i></sup>',
  root: '<sup class="k-idx"><i>y</i></sup>√<i>x</i>',
  pow10: '10<sup><i>x</i></sup>',
  pow2: '2<sup><i>x</i></sup>',
  log: 'log',
  logy: 'log<sub><i>y</i></sub><i>x</i>',
  ln: 'ln',
  epow: '<i>e</i><sup><i>x</i></sup>',
  lsh: '&lt;&lt;',
  rsh: '&gt;&gt;',
  pmod: '%',
  floor: '⌊<i>x</i>⌋',
  ceil: '⌈<i>x</i>⌉',
  rand: 'rand',
  dms: '→dms',
  degrees: '→deg',
  and: 'AND',
  or: 'OR',
  xor: 'XOR',
  nand: 'NAND',
  nor: 'NOR',
  not: 'NOT',
};

const STD_KEYS = [
  ['percent', 'ce', 'clear', 'back'],
  ['recip', 'sqr', 'sqrt', 'div'],
  ['7', '8', '9', 'mul'],
  ['4', '5', '6', 'sub'],
  ['1', '2', '3', 'add'],
  ['negate', '0', 'decimal', 'equals'],
];
const SCI_KEYS = [
  ['second', 'pi', 'econst', 'clearSmart', 'back'],
  ['sqr|cube', 'recip', 'abs', 'expEntry', 'mod'],
  ['sqrt|cbrt', 'lparen', 'rparen', 'fact', 'div'],
  ['pow|root', '7', '8', '9', 'mul'],
  ['pow10|pow2', '4', '5', '6', 'sub'],
  ['log|logy', '1', '2', '3', 'add'],
  ['ln|epow', 'negate', '0', 'decimal', 'equals'],
];
const PROG_KEYS = [
  ['A', 'lsh', 'rsh', 'clearSmart', 'back'],
  ['B', 'lparen', 'rparen', 'pmod', 'div'],
  ['C', '7', '8', '9', 'mul'],
  ['D', '4', '5', '6', 'sub'],
  ['E', '1', '2', '3', 'add'],
  ['F', 'negate', '0', 'decimal', 'equals'],
];
const NUM_KEYS = new Set([...'0123456789ABCDEF', 'decimal', 'negate']);
const TRIG = ['sin', 'cos', 'tan', 'sec', 'csc', 'cot'];

export function createCalcView(env, kind) {
  const { ctx, S, app } = env;
  const { h, icon, t } = ctx;
  const engine = app.engines[kind];
  const sys = engine.sys;
  const isStd = kind === 'standard';
  const isSci = kind === 'scientific';
  const isProg = kind === 'programmer';
  const loc = () => LOCALES[ctx.lang] || LOCALES.en;
  const local = { second: false, trig2nd: false, hyp: false, flyout: null, flyoutKind: null };

  // ------------------------------------------------------------ formatting
  const fmt = (v, radix) => (isProg ? sys.format(v, radix ?? sys.radix, { group: loc().group }) : formatNum(v, { fe: isSci && S.fe, loc: loc() }));
  const fmtEntry = (e) => (isProg ? sys.formatEntry(e, { group: loc().group }) : formatEntry(e, { loc: loc() }));
  const opText = (op) => t(`op.${op}`);
  const fnText = (name, x) => t(`fx.${name}`, { x });
  const constText = (name) => t(`const.${name}`);
  const renderExpr = (items) => renderItems(items, { fmt, opText, fnText, constText });

  // ------------------------------------------------------------ actions
  const A = {};
  const def = (id, run, opts = {}) => {
    A[id] = { id, run, errOff: true, ...opts };
  };
  for (const d of '0123456789ABCDEF') def(d, () => engine.digit(d), { errOff: false });
  def('decimal', () => engine.decimal());
  def('add', () => engine.op('+'));
  def('sub', () => engine.op('-'));
  def('mul', () => engine.op('*'));
  def('div', () => engine.op('/'));
  def('equals', () => engine.equals(), { errOff: false });
  def('ce', () => engine.clearEntry(), { errOff: false });
  def('clear', () => engine.clear(), { errOff: false });
  const smartIsCE = () => engine.isEntering() && !engine.done && engine.entry !== '0';
  def('clearSmart', () => (smartIsCE() ? engine.clearEntry() : engine.clear()), { errOff: false });
  def('back', () => engine.backspace(), { errOff: false });
  def('negate', () => engine.negate());
  def('percent', () => engine.percent());
  for (const f of ['recip', 'sqr', 'cube', 'sqrt', 'cbrt', 'pow10', 'pow2', 'log', 'ln', 'fact', 'abs', 'floor', 'ceil', 'dms', 'degrees', 'not']) def(f, () => engine.unary(f));
  def('epow', () => engine.unary('exp'));
  for (const f of TRIG) for (const v of [f, `a${f}`, `${f}h`, `a${f}h`]) def(v, () => engine.unary(v));
  def('pow', () => engine.op('pow'));
  def('root', () => engine.op('root'));
  def('logy', () => engine.op('logy'));
  def('mod', () => engine.op('mod'));
  def('pmod', () => engine.op('%'));
  for (const o of ['and', 'or', 'xor', 'nand', 'nor', 'lsh', 'rsh']) def(o, () => engine.op(o));
  def('lparen', () => engine.lparen());
  def('rparen', () => engine.rparen());
  def('expEntry', () => engine.exp());
  def('pi', () => engine.constant('pi', CONSTANTS.pi));
  def('econst', () => engine.constant('e', CONSTANTS.e));
  def('rand', () => engine.constant(null, randomNum()));
  def('second', () => {
    local.second = !local.second;
    renderKeys();
  }, { errOff: false, ui: true });
  def('angle', () => {
    S.angle = ANGLES[(ANGLES.indexOf(S.angle) + 1) % ANGLES.length];
    sys.angle = S.angle;
    app.persist();
  }, { errOff: false, ui: true });
  for (const a of ANGLES)
    def(`angle-${a}`, () => {
      S.angle = a;
      sys.angle = a;
      app.persist();
    }, { errOff: false, ui: true });
  def('fe', () => {
    S.fe = !S.fe;
    app.persist();
  }, { errOff: false, ui: true });
  for (const m of ['mc', 'mr', 'mplus', 'mminus', 'ms']) def(m, () => app.memory(m), { mem: true });
  def('mlist', () => app.openPaneFlyout('memory'), { ui: true });
  // programmer
  for (const r of RADIXES) def(`radix-${r.id}`, () => setRadix(r.radix), { errOff: false, ui: true });
  def('word', () => {
    const i = WORDS.findIndex((w) => w.bits === sys.bits);
    setWord(WORDS[(i + 1) % WORDS.length].bits);
  }, { ui: true });
  for (const w of WORDS) def(`word-${w.id}`, () => setWord(w.bits), { ui: true });

  // ------------------------------------------------------------ DOM
  const exprEl = h('div', { class: 'calc-expr selectable', 'aria-label': t('a11y.expression') });
  const resultEl = h('div', { class: 'calc-result', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const resultWrap = h('div', { class: 'calc-result-wrap' }, resultEl);
  const display = h('div', { class: 'calc-display', oncontextmenu: (e) => displayMenu(e) }, exprEl, resultWrap);
  const keyEls = new Map(); // action id -> button (current)
  const slots = []; // { el, ids: [primary, secondary] }

  function keyButton(spec, type) {
    const ids = spec.split('|');
    const el = h('button', { class: ['ck', `ck-${type}`], type: 'button' });
    const slot = { el, ids };
    el.addEventListener('click', () => run(slot.cur || ids[0], el));
    slots.push(slot);
    return el;
  }

  function keypad(rows) {
    const cols = rows[0].length;
    const grid = h('div', { class: 'calc-keypad', style: { gridTemplateColumns: `repeat(${cols}, 1fr)`, gridTemplateRows: `repeat(${rows.length}, 1fr)` } });
    for (const row of rows) {
      for (const spec of row) {
        const base = spec.split('|')[0];
        const type = base === 'equals' ? 'eq' : NUM_KEYS.has(base) ? 'num' : 'op';
        grid.appendChild(keyButton(spec, type));
      }
    }
    return grid;
  }

  function memRow() {
    const items = isProg ? ['ms', 'mlist'] : ['mc', 'mr', 'mplus', 'mminus', 'ms', 'mlist'];
    return h(
      'div',
      { class: 'calc-memrow', role: 'toolbar', 'aria-label': t('a11y.memoryControls') },
      items.map((id) => {
        const el = h('button', { class: 'calc-mem', type: 'button', 'data-key': id, 'aria-label': t(`aria.${id}`), 'data-tip': tipFor(id), onclick: () => run(id, el) }, t(`mem.${id}`));
        if (id === 'mlist') el.append(icon('chevron_down', { size: 12 }));
        keyEls.set(id, el);
        return el;
      }),
    );
  }

  function toolButton(id, content, { tip, cls, onclick } = {}) {
    const el = h('button', { class: ['calc-tool', cls], type: 'button', 'data-key': id, 'aria-label': tip || (typeof content === 'string' ? content : ''), 'data-tip': tip, onclick: onclick || (() => run(id, el)) }, content);
    keyEls.set(id, el);
    return el;
  }

  function dropButton(id, iconName, label, onOpen) {
    const el = h(
      'button',
      { class: 'calc-drop', type: 'button', 'data-key': id, 'aria-haspopup': 'dialog', 'aria-expanded': 'false', onclick: () => onOpen(el) },
      icon(iconName, { size: 16 }),
      h('span', { class: 'ellipsis' }, label),
      icon('chevron_down', { size: 12, class: 'calc-drop-chev' }),
    );
    keyEls.set(id, el);
    return el;
  }

  const root = h('div', { class: ['calc-view', `calc-${kind}`], 'data-view': kind });
  root.appendChild(display);
  let radixRows = [];
  let keypadHost = null;
  let bitHost = null;

  if (isSci) {
    root.appendChild(
      h(
        'div',
        { class: 'calc-toolrow' },
        toolButton('angle', h('span', { class: 'calc-angle-label' }), { tip: t('aria.angle') }),
        toolButton('fe', 'F-E', { tip: t('aria.fe'), cls: 'calc-fe' }),
      ),
    );
    root.appendChild(memRow());
    root.appendChild(
      h(
        'div',
        { class: 'calc-funcrow' },
        dropButton('trig', 'triangle', t('sci.trigonometry'), (el) => toggleFlyout('trig', el, trigFlyout)),
        dropButton('func', 'math_formula', t('sci.function'), (el) => toggleFlyout('func', el, funcFlyout)),
      ),
    );
    root.appendChild(keypad(SCI_KEYS));
  } else if (isProg) {
    radixRows = RADIXES.map((r) => {
      const val = h('span', { class: 'calc-radix-val' });
      const row = h(
        'button',
        { class: 'calc-radix', type: 'button', 'data-key': `radix-${r.id}`, 'data-radix': r.id, onclick: () => run(`radix-${r.id}`, row), 'aria-label': t(`radix.${r.id}`) },
        h('span', { class: 'calc-radix-name' }, r.label),
        val,
      );
      keyEls.set(`radix-${r.id}`, row);
      return { r, row, val };
    });
    root.appendChild(h('div', { class: 'calc-radixes', role: 'radiogroup', 'aria-label': t('a11y.radix') }, radixRows.map((x) => x.row)));
    const kpFull = toolButton('kp-full', icon('grid_dots', { size: 16 }), { tip: t('prog.fullKeypad'), onclick: () => setKeypad('full') });
    const kpBits = toolButton('kp-bits', icon('number_row', { size: 16 }), { tip: t('prog.bitKeypad'), onclick: () => setKeypad('bits') });
    const word = toolButton('word', h('span', { class: 'calc-word-label' }), { tip: t('aria.word'), cls: 'calc-word' });
    const mem = memRow();
    root.appendChild(h('div', { class: 'calc-toolrow prog' }, kpFull, kpBits, word, h('div', { class: 'grow' }), ...mem.children));
    root.appendChild(
      h(
        'div',
        { class: 'calc-funcrow' },
        dropButton('bitwise', 'braces', t('prog.bitwise'), (el) => toggleFlyout('bitwise', el, bitwiseFlyout)),
        dropButton('bitshift', 'arrow_sort', t('prog.bitshift'), (el) => toggleFlyout('bitshift', el, shiftFlyout)),
      ),
    );
    keypadHost = h('div', { class: 'calc-keypad-host' });
    root.appendChild(keypadHost);
  } else {
    root.appendChild(memRow());
    root.appendChild(keypad(STD_KEYS));
  }

  function setKeypad(mode) {
    S.prog.keypad = mode;
    app.persist();
    buildProgKeypad();
    refresh();
  }

  function buildProgKeypad() {
    if (!isProg) return;
    keypadHost.textContent = '';
    for (const s of [...slots]) if (!s.el.isConnected) slots.splice(slots.indexOf(s), 1);
    if (S.prog.keypad === 'bits') {
      bitHost = h('div', { class: 'calc-bits', role: 'group', 'aria-label': t('prog.bitKeypad') });
      for (let row = 0; row < 4; row++) {
        const line = h('div', { class: 'calc-bits-row' });
        for (let nib = 0; nib < 4; nib++) {
          const hi = 63 - row * 16 - nib * 4;
          const group = h('div', { class: 'calc-bits-nib' });
          const bits = h('div', { class: 'calc-bits-nib-bits' });
          for (let b = hi; b > hi - 4; b--) {
            const bit = h('button', { class: 'calc-bit', type: 'button', 'data-bit': String(b), 'aria-label': t('prog.bitN', { n: b }), onclick: () => toggleBit(b) }, '0');
            bits.appendChild(bit);
          }
          group.append(bits, h('div', { class: 'calc-bits-idx' }, String(hi - 3)));
          line.appendChild(group);
        }
        bitHost.appendChild(line);
      }
      keypadHost.appendChild(bitHost);
    } else {
      bitHost = null;
      keypadHost.appendChild(keypad(PROG_KEYS));
    }
    renderKeys();
  }

  function toggleBit(b) {
    if (engine.error) engine.clear();
    if (b >= sys.bits) return;
    const u = sys.unsigned(engine.value());
    engine.setValue(sys.wrap(u ^ (1n << BigInt(b))));
    refresh();
  }

  function setRadix(radix) {
    engine.freeze();
    sys.radix = radix;
    S.prog.radix = radix;
    app.persist();
    renderKeys();
  }

  function setWord(bits) {
    engine.freeze();
    sys.bits = bits;
    S.prog.bits = bits;
    engine.mapValues((v) => sys.wrap(v));
    app.memoryWrap?.();
    app.persist();
  }

  // ------------------------------------------------------------ flyouts
  function toggleFlyout(name, anchor, build) {
    if (local.flyout && !local.flyout.closed) {
      const same = local.flyoutKind === name;
      local.flyout.close();
      if (same) return;
    }
    local.flyoutKind = name;
    local.flyout = openFlyout({ h, anchor, host: app.flyoutHost(), content: build(), className: `calc-fly-${name}`, onClose: () => anchor.focus({ preventScroll: true }) });
  }

  function flyKey(id, label, { type = 'op', toggle = false, onclick } = {}) {
    const el = h('button', { class: ['ck', `ck-${type}`, toggle && 'ck-toggle'], type: 'button', 'data-key': id, 'aria-label': t(`aria.${id}`), onclick: onclick || (() => run(id, el)) });
    el.innerHTML = `<span class="ck-l">${label}</span>`;
    return el;
  }

  function trigFlyout() {
    const wrap = h('div', { class: 'calc-fly-grid cols-4' });
    const paint = () => {
      wrap.textContent = '';
      const t2 = flyKey('trig2nd', t('key.second'), { toggle: true, onclick: () => ((local.trig2nd = !local.trig2nd), paint()) });
      t2.classList.toggle('on', local.trig2nd);
      t2.setAttribute('aria-pressed', String(local.trig2nd));
      const hy = flyKey('hyp', 'hyp', { toggle: true, onclick: () => ((local.hyp = !local.hyp), paint()) });
      hy.classList.toggle('on', local.hyp);
      hy.setAttribute('aria-pressed', String(local.hyp));
      const name = (f) => `${local.trig2nd ? 'a' : ''}${f}${local.hyp ? 'h' : ''}`;
      const label = (f) => `${f}${local.hyp ? 'h' : ''}${local.trig2nd ? '<sup>−1</sup>' : ''}`;
      wrap.append(t2, ...TRIG.slice(0, 3).map((f) => flyKey(name(f), label(f), { onclick: () => runAndClose(name(f)) })));
      wrap.append(hy, ...TRIG.slice(3).map((f) => flyKey(name(f), label(f), { onclick: () => runAndClose(name(f)) })));
      for (const b of wrap.querySelectorAll('button')) b.disabled = !!engine.error && !b.classList.contains('ck-toggle');
    };
    paint();
    return wrap;
  }

  function funcFlyout() {
    const wrap = h('div', { class: 'calc-fly-grid cols-3' });
    for (const id of ['abs', 'floor', 'ceil', 'rand', 'dms', 'degrees']) {
      const b = flyKey(id, LABELS[id], { onclick: () => runAndClose(id) });
      b.disabled = !!engine.error && id !== 'rand';
      wrap.appendChild(b);
    }
    return wrap;
  }

  function bitwiseFlyout() {
    const wrap = h('div', { class: 'calc-fly-grid cols-3' });
    for (const id of ['and', 'or', 'not', 'nand', 'nor', 'xor']) {
      const b = flyKey(id, LABELS[id], { onclick: () => runAndClose(id) });
      b.disabled = !!engine.error;
      wrap.appendChild(b);
    }
    return wrap;
  }

  function shiftFlyout() {
    const wrap = h('div', { class: 'calc-fly-list', role: 'radiogroup', 'aria-label': t('prog.bitshift') });
    for (const id of SHIFTS) {
      const on = sys.shift === id;
      wrap.appendChild(
        h(
          'button',
          {
            class: ['calc-radio', on && 'on'],
            type: 'button',
            role: 'radio',
            'aria-checked': String(on),
            'data-key': `shift-${id}`,
            onclick: () => {
              sys.shift = id;
              S.prog.shift = id;
              app.persist();
              local.flyout?.close();
              refresh();
            },
          },
          h('span', { class: 'calc-radio-dot' }),
          t(`prog.shift.${id}`),
        ),
      );
    }
    return wrap;
  }

  // ------------------------------------------------------------ run / render
  function runAndClose(id) {
    local.flyout?.close();
    run(id);
  }

  function run(id, el) {
    const a = A[id];
    if (!a) return false;
    if (isDisabled(id)) return false;
    try {
      a.run();
    } catch (err) {
      console.error('[calculator]', err);
      app.reportError(err);
    }
    refresh();
    return true;
  }

  function isDisabled(id) {
    const a = A[id];
    if (!a) return true;
    if (engine.error && a.errOff) return true;
    if (isProg) {
      if (/^[0-9A-F]$/.test(id) && !sys.validDigit(id)) return true;
      if (id === 'decimal' || id === 'expEntry') return true;
      if (id === 'radix-hex' || id === 'radix-dec' || id === 'radix-oct' || id === 'radix-bin') return false;
    }
    if (a.mem) {
      const has = app.memoryList().length > 0;
      if ((id === 'mc' || id === 'mr') && !has) return true;
    }
    if (id === 'mlist') return app.memoryList().length === 0 || !!engine.error;
    if (id === 'rparen' && !engine.openParens()) return true;
    return false;
  }

  function renderKeys() {
    for (const slot of slots) {
      const id = slot.ids.length > 1 && local.second ? slot.ids[1] : slot.ids[0];
      slot.cur = id;
      const el = slot.el;
      el.dataset.key = id;
      keyEls.set(id, el);
      let html = LABELS[id];
      if (id === 'back') html = '<span class="k-icon"></span>';
      else if (id === 'decimal') html = esc(loc().decimal);
      else if (id === 'second') html = t('key.second');
      else if (id === 'clearSmart') html = smartIsCE() ? 'CE' : 'C';
      else if (/^[0-9A-F]$/.test(id)) html = id;
      else if (id === 'lparen') {
        const n = engine.openParens();
        html = n ? `(<sub class="k-count">${n}</sub>` : '(';
      }
      if (html != null && el._html !== html) {
        el._html = html;
        el.innerHTML = `<span class="ck-l">${html}</span>`;
        if (id === 'back') el.querySelector('.k-icon').replaceWith(icon('backspace', { size: 16 }));
      }
      el.setAttribute('aria-label', /^[0-9A-F]$/.test(id) ? id : t(`aria.${id}`));
      const tip = tipFor(id);
      if (tip) el.dataset.tip = tip;
      else delete el.dataset.tip;
      el.disabled = isDisabled(id);
      el.classList.toggle('on', id === 'second' && local.second);
      if (id === 'second') el.setAttribute('aria-pressed', String(local.second));
    }
    for (const [id, el] of keyEls) {
      if (!A[id] || slots.some((s) => s.el === el)) continue;
      el.disabled = isDisabled(id);
    }
    if (isSci) {
      keyEls.get('angle').querySelector('.calc-angle-label').textContent = t(`angle.${S.angle}`);
      const fe = keyEls.get('fe');
      fe.classList.toggle('on', !!S.fe);
      fe.setAttribute('aria-pressed', String(!!S.fe));
    }
    if (isProg) {
      keyEls.get('word').querySelector('.calc-word-label').textContent = WORDS.find((w) => w.bits === sys.bits)?.label || 'QWORD';
      keyEls.get('kp-full').classList.toggle('on', S.prog.keypad !== 'bits');
      keyEls.get('kp-bits').classList.toggle('on', S.prog.keypad === 'bits');
      keyEls.get('kp-full').setAttribute('aria-pressed', String(S.prog.keypad !== 'bits'));
      keyEls.get('kp-bits').setAttribute('aria-pressed', String(S.prog.keypad === 'bits'));
    }
    const ml = keyEls.get('mlist');
    if (ml) ml.hidden = app.isDocked();
  }

  function tipFor(id) {
    const k = `tip.${id}`;
    const s = t(k);
    return s === k ? '' : s;
  }

  function refresh() {
    let text;
    if (engine.error) text = t(`err.${engine.error}`);
    else if (engine.entry != null) text = fmtEntry(engine.entry);
    else text = fmt(engine.value());
    resultEl.textContent = text;
    resultEl.classList.toggle('is-error', !!engine.error);
    resultEl.setAttribute('aria-label', t('a11y.display', { value: text }));
    exprEl.textContent = renderExpr(engine.exprItems());
    exprEl.scrollLeft = exprEl.scrollWidth;
    root.classList.toggle('has-error', !!engine.error);
    if (isProg) {
      const v = engine.error ? null : engine.value();
      for (const { r, row, val } of radixRows) {
        val.textContent = v == null ? '' : fmt(v, r.radix);
        const sel = r.radix === sys.radix;
        row.classList.toggle('selected', sel);
        row.setAttribute('aria-checked', String(sel));
        row.setAttribute('role', 'radio');
      }
      if (bitHost) {
        const u = v == null ? 0n : sys.unsigned(v);
        for (const b of bitHost.querySelectorAll('.calc-bit')) {
          const i = Number(b.dataset.bit);
          const on = (u >> BigInt(i)) & 1n;
          b.textContent = on ? '1' : '0';
          b.classList.toggle('one', !!on);
          b.disabled = i >= sys.bits;
        }
      }
    }
    renderKeys();
    fit();
  }

  function fit() {
    const max = Math.max(28, Math.min(72, Math.round(root.clientHeight * (isStd ? 0.09 : 0.075)) || 46));
    resultEl.classList.remove('wrap');
    const size = fitText(resultEl, max, isProg ? 14 : 18);
    if (isProg && resultEl.scrollWidth > resultEl.clientWidth + 1 && size <= 14) resultEl.classList.add('wrap');
  }

  function layout() {
    const r = root.getBoundingClientRect();
    const kp = root.querySelector('.calc-keypad');
    if (kp) {
      const rows = kp.style.gridTemplateRows.match(/repeat\((\d+)/)?.[1] || 6;
      const keyH = kp.clientHeight / rows;
      const keyW = kp.clientWidth / (kp.style.gridTemplateColumns.match(/repeat\((\d+)/)?.[1] || 4);
      const base = Math.min(keyH, keyW * 0.62);
      root.style.setProperty('--key-fs', `${Math.max(14, Math.min(26, Math.round(base * 0.38)))}px`);
      root.style.setProperty('--key-fs-op', `${Math.max(13, Math.min(22, Math.round(base * 0.31)))}px`);
    }
    root.classList.toggle('roomy', r.height > 640);
    fit();
  }

  // ------------------------------------------------------------ keyboard
  function keyToAction(e) {
    const k = e.key;
    const lower = k.length === 1 ? k.toLowerCase() : k;
    if (e.ctrlKey && !e.altKey && !e.metaKey) {
      const m = { m: 'ms', p: 'mplus', q: 'mminus', r: 'mr', l: 'mc' }[lower];
      if (m && !e.shiftKey) return m;
      if (isSci) {
        const sci = { g: 'pow10', n: 'epow', y: 'root', b: 'cbrt', s: e.shiftKey ? 'asinh' : 'sinh', o: e.shiftKey ? 'acosh' : 'cosh', t: e.shiftKey ? 'atanh' : 'tanh' }[lower];
        if (sci) return sci;
      }
      return null;
    }
    if (e.altKey || e.metaKey) return null;
    if (/^[0-9]$/.test(k)) return k;
    if (isProg && /^[a-f]$/i.test(k) && sys.radix === 16) return k.toUpperCase();
    switch (k) {
      case '.':
      case ',':
      case 'Decimal':
        return 'decimal';
      case '+':
        return 'add';
      case '-':
        return 'sub';
      case '*':
        return 'mul';
      case '/':
        return 'div';
      case 'Enter':
      case '=':
        return 'equals';
      case 'Backspace':
        return 'back';
      case 'Escape':
        return 'clear';
      case 'Delete':
        return 'ce';
      case 'F9':
        return 'negate';
      case '%':
        return isStd ? 'percent' : isSci ? 'mod' : 'pmod';
      case '(':
        return isStd ? null : 'lparen';
      case ')':
        return isStd ? null : 'rparen';
      case '@':
        return isProg ? null : 'sqrt';
      default:
    }
    if (isProg) {
      const p = { '&': 'and', '|': 'or', '^': 'xor', '~': 'not', '<': 'lsh', '>': 'rsh', F5: 'radix-hex', F6: 'radix-dec', F7: 'radix-oct', F8: 'radix-bin', F12: 'word-qword', F2: 'word-dword', F3: 'word-word', F4: 'word-byte' }[k];
      return p || null;
    }
    if (lower === 'r') return 'recip';
    if (lower === 'q') return 'sqr';
    if (isSci) {
      const s = {
        '^': 'pow',
        y: 'pow',
        '!': 'fact',
        '#': 'cube',
        '|': 'abs',
        x: 'expEntry',
        p: 'pi',
        e: 'econst',
        l: 'log',
        n: 'ln',
        v: 'fe',
        s: e.shiftKey ? 'asin' : 'sin',
        o: e.shiftKey ? 'acos' : 'cos',
        t: e.shiftKey ? 'atan' : 'tan',
        F3: 'angle-deg',
        F4: 'angle-rad',
        F5: 'angle-grad',
      }[k.length === 1 && k !== '^' && k !== '!' && k !== '#' && k !== '|' ? lower : k];
      return s || null;
    }
    return null;
  }

  function handleKey(e) {
    const id = keyToAction(e);
    if (!id) return false;
    e.preventDefault();
    const el = keyEls.get(id);
    const handled = run(id, el);
    if (handled && el?.isConnected) {
      el.classList.remove('pressed');
      void el.offsetWidth;
      el.classList.add('pressed');
      clearTimeout(el._pt);
      el._pt = setTimeout(() => el.classList.remove('pressed'), 140);
    }
    return true;
  }

  // ------------------------------------------------------------ clipboard
  function displayMenu(e) {
    e.preventDefault();
    ctx.ui.menu(e, [
      { label: t('menu.copy'), icon: 'copy', shortcut: 'Ctrl+C', disabled: !!engine.error, action: () => app.copy() },
      { label: t('menu.paste'), icon: 'clipboard_paste', shortcut: 'Ctrl+V', action: () => app.paste() },
    ]);
  }

  function copyText() {
    if (engine.error) return null;
    const v = engine.value();
    if (isProg) return sys.toRadix(v);
    return formatNum(v, { fe: isSci && S.fe, loc: loc(), grouping: false });
  }

  if (isProg) buildProgKeypad();
  else renderKeys();

  return {
    el: root,
    kind,
    engine,
    pane: isProg ? 'memory' : 'both',
    memoryKind: isProg ? 'prog' : 'dec',
    historyKind: isProg ? null : kind,
    fmt,
    renderExpr,
    refresh,
    layout,
    handleKey,
    copyText,
    value: () => engine.value(),
    setValue: (v) => {
      engine.setValue(v);
      refresh();
    },
    freeze: () => engine.freeze(),
    recall: (item) => {
      engine.recall(item);
      refresh();
    },
    closeFlyouts: () => {
      if (local.flyout && !local.flyout.closed) {
        local.flyout.close();
        return true;
      }
      return false;
    },
    destroy() {
      local.flyout?.close();
    },
  };
}
