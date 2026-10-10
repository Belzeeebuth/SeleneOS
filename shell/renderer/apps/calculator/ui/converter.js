// Unit converter view (Windows "Converter" modes): two values with unit dropdowns, the active value
// is typed on the keypad and the other one updates live. Exact rational conversions (lib/units.js).
import { Num, ZERO, formatNum, formatEntry, LOCALES, parseLoose, toPlain, CalcError } from '../lib/num.js';
import { makeEntryOps } from '../lib/decimal.js';
import { category, unit, convert } from '../lib/units.js';
import { fitText } from './widgets.js';

const entryOps = makeEntryOps(16);

export function createConverterView(env, catId) {
  const { ctx, S, app } = env;
  const { h, icon, t, ui } = ctx;
  const cat = category(catId);
  const loc = () => LOCALES[ctx.lang] || LOCALES.en;
  const prefs = (S.conv[cat.id] ||= { from: cat.defaults[0], to: cat.defaults[1] });
  if (!cat.units.some((u) => u.id === prefs.from)) prefs.from = cat.defaults[0];
  if (!cat.units.some((u) => u.id === prefs.to)) prefs.to = cat.defaults[1];
  // per-window, per-category typing state kept by the controller
  const st = (app.convState[cat.id] ||= { entry: '0', active: 0, fresh: false, error: null });

  const unitName = (u) => u.name[ctx.lang] || u.name.en;
  const fmt = (v) => formatNum(v, { loc: loc() });

  const fields = [0, 1].map((i) => {
    const value = h('div', { class: 'calc-conv-value', role: 'button', tabindex: '0', 'data-field': String(i), onclick: () => activate(i), onkeydown: (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), activate(i)) });
    const valueWrap = h('div', { class: 'calc-conv-valuewrap' }, value);
    const unitText = h('span', { class: 'ellipsis' });
    const unitBtn = h(
      'button',
      { class: 'calc-conv-unit', type: 'button', 'data-unit-field': String(i), 'aria-haspopup': 'menu', onclick: (e) => pickUnit(i, e.currentTarget) },
      unitText,
      icon('chevron_down', { size: 12 }),
    );
    const el = h('div', { class: 'calc-conv-field', 'data-index': String(i) }, valueWrap, unitBtn);
    return { el, value, unitBtn, unitText };
  });
  const about = h('div', { class: 'calc-conv-about', 'aria-live': 'polite' });

  // keypad
  const keyEls = new Map();
  const key = (id, content, type = 'num') => {
    const el = h('button', { class: ['ck', `ck-${type}`], type: 'button', 'data-key': id, 'aria-label': /^\d$/.test(id) ? id : t(`aria.${id}`), onclick: () => run(id, el) });
    const lab = h('span', { class: 'ck-l' });
    if (content instanceof Node) lab.appendChild(content);
    else lab.innerHTML = content;
    el.appendChild(lab);
    keyEls.set(id, el);
    return el;
  };
  const rows = [
    [null, ['ce', 'CE', 'op'], ['back', icon('backspace', { size: 16 }), 'op']],
    [['7', '7'], ['8', '8'], ['9', '9']],
    [['4', '4'], ['5', '5'], ['6', '6']],
    [['1', '1'], ['2', '2'], ['3', '3']],
    [cat.signed ? ['negate', '<span class="k-pm"><sup>+</sup>/<sub>−</sub></span>'] : null, ['0', '0'], ['decimal', loc().decimal]],
  ];
  const pad = h('div', { class: 'calc-keypad calc-conv-pad', style: { gridTemplateColumns: 'repeat(3, 1fr)', gridTemplateRows: 'repeat(5, 1fr)' } });
  for (const row of rows) for (const k of row) pad.appendChild(k ? key(k[0], k[1], k[2] || 'num') : h('div', { class: 'ck-gap' }));

  const root = h(
    'div',
    { class: 'calc-view calc-converter', 'data-view': `conv-${cat.id}` },
    h('div', { class: 'calc-conv-fields' }, fields[0].el, fields[1].el, about),
    pad,
  );

  // ------------------------------------------------------------ logic
  function inputValue() {
    return entryOps.parseEntry(st.entry);
  }

  function values() {
    const v = inputValue();
    const units = [prefs.from, prefs.to];
    const a = st.active;
    const out = [null, null];
    out[a] = v;
    try {
      out[1 - a] = convert(cat.id, units[a], units[1 - a], v);
      st.error = null;
    } catch (err) {
      if (!(err instanceof CalcError || err?.calcError)) throw err;
      st.error = err.code;
    }
    return out;
  }

  function activate(i) {
    if (st.active === i) return;
    const vals = values();
    st.active = i;
    const v = vals[i] || ZERO;
    st.entry = entryFromValue(v);
    st.fresh = true;
    refresh();
  }

  function entryFromValue(v) {
    // "2.2e+41" is a valid entry too (it used to become 0 when a huge converted value was activated)
    const s = toPlain(v, 16);
    return /^-?\d+(\.\d+)?(e[+-]\d+)?$/.test(s) ? s : '0';
  }

  function pickUnit(i, anchor) {
    const cur = i === 0 ? prefs.from : prefs.to;
    ui.menu(
      anchor,
      cat.units.map((u) => ({
        label: unitName(u),
        checked: u.id === cur,
        action: () => {
          if (i === 0) prefs.from = u.id;
          else prefs.to = u.id;
          app.persist();
          refresh();
          anchor.focus({ preventScroll: true });
        },
      })),
      { class: 'calc-unit-menu' },
    );
  }

  function run(id, el) {
    if (el?.disabled) return false;
    switch (id) {
      case 'ce':
        st.entry = '0';
        st.fresh = false;
        break;
      case 'back':
        st.entry = st.fresh ? '0' : entryOps.backspace(st.entry);
        st.fresh = false;
        break;
      case 'negate': {
        if (!cat.signed) return false;
        const n = entryOps.negateEntry(st.entry);
        if (n != null) st.entry = n;
        st.fresh = false;
        break;
      }
      case 'decimal': {
        if (st.fresh) {
          st.entry = '0';
          st.fresh = false;
        }
        const n = entryOps.decimal(st.entry);
        if (n != null) st.entry = n;
        break;
      }
      default: {
        if (!/^\d$/.test(id)) return false;
        if (st.fresh) {
          st.entry = '0';
          st.fresh = false;
        }
        const n = entryOps.appendDigit(st.entry, id);
        if (n != null) st.entry = n;
      }
    }
    refresh();
    return true;
  }

  function refresh() {
    const vals = values();
    const units = [unit(cat, prefs.from), unit(cat, prefs.to)];
    fields.forEach((f, i) => {
      const active = i === st.active;
      let text;
      if (active) text = st.fresh ? fmt(vals[i]) : formatEntry(st.entry, { loc: loc() });
      else text = st.error ? t(`err.${st.error}`) : fmt(vals[i]);
      f.value.textContent = text;
      f.el.classList.toggle('active', active);
      f.value.setAttribute('aria-label', t('conv.valueIn', { value: text, unit: unitName(units[i]) }));
      f.value.setAttribute('aria-pressed', String(active));
      f.unitText.textContent = unitName(units[i]);
      f.unitBtn.setAttribute('aria-label', t('conv.unitFor', { unit: unitName(units[i]) }));
    });
    renderAbout(vals[st.active], units[st.active]);
    const neg = keyEls.get('negate');
    if (neg) neg.disabled = false;
    keyEls.get('decimal').firstChild.textContent = loc().decimal;
    fit();
  }

  function renderAbout(v, from) {
    about.textContent = '';
    if (!v || v.isZero()) return;
    const shown = new Set([prefs.from, prefs.to]);
    // pick the three other units whose value is the most readable (closest to the 1–100 range)
    const cands = [];
    cat.units.forEach((u, idx) => {
      if (shown.has(u.id)) return;
      let r;
      try {
        r = convert(cat.id, from.id, u.id, v);
      } catch {
        return;
      }
      const d = Math.abs(r.toNumber());
      if (!(d > 0) || (cat.id !== 'temperature' && (d < 0.01 || d >= 1e9))) return;
      cands.push({ u, r, idx, score: Math.abs(Math.log10(d) - 1) });
    });
    cands.sort((a, b) => a.score - b.score);
    const chips = cands
      .slice(0, 3)
      .sort((a, b) => a.idx - b.idx)
      .map(({ u, r }) => h('span', { class: 'calc-conv-chip' }, `${formatNum(round2(r), { loc: loc() })} ${u.sym}`));
    if (!chips.length) return;
    about.append(h('span', { class: 'calc-conv-about-label' }, t('conv.about')), ...chips);
  }

  function round2(r) {
    // two decimals, rounded half away from zero
    const x = r.mul(100).abs();
    let q = x.floor();
    if (x.sub(q).cmp(Num.frac(1, 2)) >= 0) q = q.add(1);
    q = q.div(100);
    return r.isNeg() ? q.neg() : q;
  }

  function fit() {
    const max = Math.max(26, Math.min(56, Math.round(root.clientHeight * 0.075) || 40));
    fields.forEach((f, i) => fitText(f.value, i === st.active ? max : Math.round(max * 0.92), 16));
  }

  function handleKey(e) {
    if (e.ctrlKey || e.altKey || e.metaKey) return false;
    let id = null;
    const k = e.key;
    if (/^\d$/.test(k)) id = k;
    else if (k === '.' || k === ',' || k === 'Decimal') id = 'decimal';
    else if (k === 'Backspace') id = 'back';
    else if (k === 'Delete' || k === 'Escape') id = 'ce';
    else if (k === 'F9' || (k === '-' && cat.signed)) id = 'negate';
    else if (k === 'ArrowUp' || k === 'ArrowDown') {
      activate(k === 'ArrowUp' ? 0 : 1);
      e.preventDefault();
      return true;
    }
    if (!id) return false;
    e.preventDefault();
    const el = keyEls.get(id);
    if (run(id, el) && el) {
      el.classList.remove('pressed');
      void el.offsetWidth;
      el.classList.add('pressed');
      clearTimeout(el._pt);
      el._pt = setTimeout(() => el.classList.remove('pressed'), 140);
    }
    return true;
  }

  function copyText() {
    const vals = values();
    const v = vals[st.active];
    return v ? formatNum(v, { loc: loc(), grouping: false }) : null;
  }

  function paste(text) {
    const v = parseLoose(text, ctx.lang);
    if (!v) return false;
    st.entry = entryFromValue(cat.signed ? v : v.abs());
    st.fresh = true;
    refresh();
    return true;
  }

  return {
    el: root,
    kind: `conv-${cat.id}`,
    title: t(`conv.cat.${cat.id}`),
    pane: null,
    refresh,
    layout: () => {
      const kh = pad.clientHeight / 5;
      root.style.setProperty('--key-fs', `${Math.max(14, Math.min(24, Math.round(kh * 0.36)))}px`);
      fit();
    },
    handleKey,
    copyText,
    paste,
    destroy() {},
  };
}
