// Date calculation view: "Difference between dates" and "Add or subtract days".
import { today, diff, shift, sameDay } from '../lib/dates.js';
import { datePicker, capitalize } from './widgets.js';

export function createDateView(env) {
  const { ctx, S, app } = env;
  const { h, icon, t, ui } = ctx;
  const st = (app.dateState ||= { from: today(), to: today(), base: today(), sign: 1, years: 0, months: 0, days: 0 });
  const locale = () => (ctx.lang === 'fr' ? 'fr-FR' : 'en-US');
  const nf = (n) => new Intl.NumberFormat(locale()).format(n);

  const modeText = h('span', { class: 'ellipsis' });
  const modeBtn = h(
    'button',
    { class: 'calc-date-mode', type: 'button', 'data-key': 'date-mode', 'aria-haspopup': 'menu', onclick: (e) => pickMode(e.currentTarget) },
    modeText,
    icon('chevron_down', { size: 12 }),
  );
  const content = h('div', { class: 'calc-date-content' });
  const root = h('div', { class: 'calc-view calc-date', 'data-view': 'date' }, modeBtn, content);

  function pickMode(anchor) {
    ui.menu(
      anchor,
      ['diff', 'add'].map((m) => ({
        label: t(`date.mode.${m}`),
        checked: S.date.mode === m,
        action: () => {
          S.date.mode = m;
          app.persist();
          build(true);
          anchor.focus({ preventScroll: true });
        },
      })),
    );
  }

  let refreshFn = () => {};
  let pickers = []; // date pickers of the current sub-mode (their flyouts live in the app root)

  function field(label, control) {
    return h('div', { class: 'calc-date-field' }, h('div', { class: 'calc-date-label' }, label), control);
  }

  function buildDiff() {
    const result = h('div', { class: 'calc-date-result', 'data-result': 'diff', 'aria-live': 'polite' });
    const total = h('div', { class: 'calc-date-total', 'data-result': 'days' });
    const from = datePicker({ ctx, host: app.flyoutHost(), value: st.from, label: t('date.from'), onChange: (d) => ((st.from = d), refreshFn()) });
    const to = datePicker({ ctx, host: app.flyoutHost(), value: st.to, label: t('date.to'), onChange: (d) => ((st.to = d), refreshFn()) });
    from.el.dataset.picker = 'from';
    to.el.dataset.picker = 'to';
    pickers = [from, to];
    content.append(field(t('date.from'), from.el), field(t('date.to'), to.el), field(t('date.difference'), h('div', null, result, total)));
    refreshFn = () => {
      if (sameDay(st.from, st.to)) {
        result.textContent = t('date.same');
        total.textContent = '';
        return;
      }
      const d = diff(st.from, st.to);
      const parts = [];
      if (d.years) parts.push(t('date.years', { count: d.years, n: nf(d.years) }));
      if (d.months) parts.push(t('date.months', { count: d.months, n: nf(d.months) }));
      if (d.weeks) parts.push(t('date.weeks', { count: d.weeks, n: nf(d.weeks) }));
      if (d.days) parts.push(t('date.days', { count: d.days, n: nf(d.days) }));
      result.textContent = parts.join(', ');
      total.textContent = parts.length > 1 || d.weeks || d.months || d.years ? t('date.days', { count: d.totalDays, n: nf(d.totalDays) }) : '';
    };
  }

  function spin(name) {
    const input = h('input', {
      class: 'input calc-spin-input',
      type: 'text',
      inputmode: 'numeric',
      value: String(st[name]),
      'data-spin': name,
      'aria-label': t(`date.${name}Label`),
      oninput: () => {
        const v = input.value.replace(/\D/g, '').slice(0, 3);
        if (v !== input.value) input.value = v;
        st[name] = Math.min(999, Number(v || 0));
        refreshFn();
      },
      onblur: () => (input.value = String(st[name])),
      onkeydown: (e) => {
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          bump(e.key === 'ArrowUp' ? 1 : -1);
        }
      },
    });
    const bump = (d) => {
      st[name] = Math.max(0, Math.min(999, st[name] + d));
      input.value = String(st[name]);
      refreshFn();
    };
    const up = h('button', { class: 'calc-spin-btn', type: 'button', tabindex: '-1', 'aria-label': t('date.increase'), onclick: () => bump(1) }, icon('chevron_up', { size: 12 }));
    const down = h('button', { class: 'calc-spin-btn', type: 'button', tabindex: '-1', 'aria-label': t('date.decrease'), onclick: () => bump(-1) }, icon('chevron_down', { size: 12 }));
    return h('div', { class: 'calc-spin-field' }, h('div', { class: 'calc-date-label' }, t(`date.${name}Label`)), h('div', { class: 'calc-spin' }, input, h('div', { class: 'calc-spin-btns' }, up, down)));
  }

  function radio(value, label) {
    const input = h('input', {
      type: 'radio',
      name: `calc-date-op-${ctx.win.id}`,
      value: String(value),
      checked: st.sign === value,
      'data-op': value > 0 ? 'add' : 'sub',
      onchange: () => {
        st.sign = value;
        refreshFn();
      },
    });
    return h('label', { class: 'radio calc-radio-label' }, input, h('span', null, label));
  }

  function buildAdd() {
    const base = datePicker({ ctx, host: app.flyoutHost(), value: st.base, label: t('date.from'), onChange: (d) => ((st.base = d), refreshFn()) });
    base.el.dataset.picker = 'base';
    pickers = [base];
    const result = h('div', { class: 'calc-date-result', 'data-result': 'date', 'aria-live': 'polite' });
    content.append(
      field(t('date.from'), base.el),
      h('div', { class: 'calc-date-ops', role: 'radiogroup', 'aria-label': t('date.operation') }, radio(1, t('date.add')), radio(-1, t('date.subtract'))),
      h('div', { class: 'calc-spins' }, spin('years'), spin('months'), spin('days')),
      field(t('date.date'), result),
    );
    refreshFn = () => {
      const r = shift(st.base, { years: st.years, months: st.months, days: st.days }, st.sign);
      result.classList.toggle('is-error', !r);
      result.textContent = r ? capitalize(new Intl.DateTimeFormat(locale(), { timeZone: 'UTC', dateStyle: 'full' }).format(r)) : t('date.outOfBounds');
    };
  }

  function build(animate = false) {
    for (const p of pickers) p.close();
    pickers = [];
    content.textContent = '';
    modeText.textContent = t(`date.mode.${S.date.mode}`);
    if (S.date.mode === 'add') buildAdd();
    else buildDiff();
    refreshFn();
    if (animate && document.documentElement.dataset.animations !== 'off') {
      content.animate([{ opacity: 0, transform: 'translateY(12px)' }, { opacity: 1, transform: 'none' }], { duration: 250, easing: 'cubic-bezier(0.1, 0.9, 0.2, 1)' });
    }
  }
  build();

  return {
    el: root,
    kind: 'date',
    pane: null,
    refresh: () => refreshFn(),
    layout() {},
    handleKey: () => false,
    copyText: () => root.querySelector('.calc-date-result')?.textContent || null,
    closeFlyouts: () => {
      const open = !!app.flyoutHost().querySelector('.calc-cal-flyout:not(.closing)');
      for (const p of pickers) p.close();
      return open;
    },
    destroy() {
      for (const p of pickers) p.close();
    },
  };
}
