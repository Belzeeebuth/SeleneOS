// Clock — reusable widgets: progress ring, analog clock face, spin picker (time / duration wheels),
// weekday toggles, floating command bar. Everything is styled with the shell's CSS tokens.
const SVGNS = 'http://www.w3.org/2000/svg';
export const reduceMotion = () => document.documentElement.dataset.animations === 'off';
export const EASE = 'cubic-bezier(0.1, 0.9, 0.2, 1)';

export function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, String(v));
  for (const c of children) if (c) el.appendChild(c);
  return el;
}

/** Circular progress ring. ring.set(0..1) */
export function progressRing({ className = '', stroke = 6, value = 1 } = {}) {
  const r = 50 - stroke / 2 - 1;
  const track = svg('circle', { class: 'ck-ring-track', cx: 50, cy: 50, r, 'stroke-width': stroke, fill: 'none' });
  const bar = svg('circle', { class: 'ck-ring-bar', cx: 50, cy: 50, r, 'stroke-width': stroke, fill: 'none', pathLength: 1000, transform: 'rotate(-90 50 50)', 'stroke-linecap': 'round' });
  const el = svg('svg', { class: `ck-ring ${className}`, viewBox: '0 0 100 100', 'aria-hidden': 'true' }, track, bar);
  let last = -1;
  el.set = (v) => {
    v = Math.max(0, Math.min(1, Number(v) || 0));
    const len = Math.round(v * 1000 * 10) / 10;
    if (len === last) return;
    last = len;
    bar.setAttribute('stroke-dasharray', `${len} 1000`);
    bar.style.opacity = len < 0.5 ? '0' : '1';
  };
  el.set(value);
  return el;
}

/** Analog clock face. face.set(h, m, s) with fractional seconds for a smooth hand. */
export function analogClock({ className = '', seconds = true } = {}) {
  const ticks = svg('g', { class: 'ck-face-ticks' });
  for (let i = 0; i < 12; i++) {
    const major = i % 3 === 0;
    ticks.appendChild(svg('line', { x1: 50, y1: major ? 8 : 9, x2: 50, y2: major ? 15 : 13, class: major ? 'major' : 'minor', transform: `rotate(${i * 30} 50 50)` }));
  }
  const hh = svg('line', { class: 'ck-hand-h', x1: 50, y1: 52, x2: 50, y2: 28 });
  const mh = svg('line', { class: 'ck-hand-m', x1: 50, y1: 54, x2: 50, y2: 16 });
  const sh = seconds ? svg('line', { class: 'ck-hand-s', x1: 50, y1: 58, x2: 50, y2: 12 }) : null;
  const el = svg(
    'svg',
    { class: `ck-face ${className}`, viewBox: '0 0 100 100', 'aria-hidden': 'true' },
    svg('circle', { class: 'ck-face-bg', cx: 50, cy: 50, r: 47 }),
    ticks,
    hh,
    mh,
    sh,
    svg('circle', { class: 'ck-face-pin', cx: 50, cy: 50, r: seconds ? 2.6 : 3 }),
  );
  el.set = (h, m, s = 0) => {
    hh.setAttribute('transform', `rotate(${((h % 12) + m / 60) * 30} 50 50)`);
    mh.setAttribute('transform', `rotate(${(m + s / 60) * 6} 50 50)`);
    sh?.setAttribute('transform', `rotate(${s * 6} 50 50)`);
  };
  return el;
}

/**
 * Spin picker column (role=spinbutton). Larger values sit above, like the Windows 11 Clock pickers:
 * the up chevron / ArrowUp / wheel up / dragging down increase the value.
 *   spinner({ h, icon, values: [{ value, label }], value, wrap, label, onchange, pageStep, className })
 *   el.value  el.setValue(v)
 */
export function spinner({ h, icon, values, value, wrap = true, label = '', onchange, pageStep = 10, className = '', tipUp, tipDown }) {
  let idx = Math.max(0, values.findIndex((x) => x.value === value));
  const cell = (cls) => h('div', { class: `ck-spin-cell ${cls}` });
  const above = cell('above');
  const cur = cell('cur');
  const below = cell('below');
  const strip = h('div', { class: 'ck-spin-strip' }, above, cur, below);
  const up = h('button', { type: 'button', class: 'ck-spin-btn up', tabindex: '-1', 'aria-hidden': 'true', 'data-tip': tipUp || null }, icon('chevron_up', { size: 12 }));
  const down = h('button', { type: 'button', class: 'ck-spin-btn down', tabindex: '-1', 'aria-hidden': 'true', 'data-tip': tipDown || null }, icon('chevron_down', { size: 12 }));
  const el = h('div', { class: `ck-spin ${className}`, role: 'spinbutton', tabindex: '0', 'aria-label': label }, up, h('div', { class: 'ck-spin-view' }, strip), down);
  const at = (i) => {
    const n = values.length;
    if (wrap) return values[((i % n) + n) % n];
    return i >= 0 && i < n ? values[i] : null;
  };
  const paint = () => {
    const v = values[idx];
    cur.textContent = v.label;
    above.textContent = at(idx + 1)?.label ?? '';
    below.textContent = at(idx - 1)?.label ?? '';
    el.setAttribute('aria-valuenow', String(typeof v.value === 'number' ? v.value : idx));
    el.setAttribute('aria-valuetext', v.text || v.label);
    if (!wrap) {
      up.disabled = idx >= values.length - 1;
      down.disabled = idx <= 0;
    }
  };
  const step = (d, animate = true) => {
    let n = idx + d;
    if (wrap) n = ((n % values.length) + values.length) % values.length;
    else n = Math.max(0, Math.min(values.length - 1, n));
    if (n === idx) return;
    idx = n;
    paint();
    if (animate && !reduceMotion()) {
      // the new value slides in from the side it came from (larger values sit above)
      const dy = (cur.offsetHeight + above.offsetHeight) / 2 || 30;
      cur.getAnimations().forEach((a) => a.cancel());
      cur.animate([{ transform: `translateY(${d > 0 ? -dy : dy}px)`, opacity: 0.2 }, { transform: 'none', opacity: 1 }], { duration: 167, easing: EASE });
    }
    onchange?.(values[idx].value);
  };
  up.addEventListener('click', () => (step(1), el.focus()));
  down.addEventListener('click', () => (step(-1), el.focus()));
  above.addEventListener('click', () => step(1));
  below.addEventListener('click', () => step(-1));
  let wheelAcc = 0;
  el.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      wheelAcc += e.deltaY;
      while (Math.abs(wheelAcc) >= 40) {
        step(wheelAcc < 0 ? 1 : -1);
        wheelAcc -= Math.sign(wheelAcc) * 40;
      }
    },
    { passive: false },
  );
  // drag: pulling the strip down brings the larger (upper) value into the middle
  let drag = null;
  strip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    drag = { y: e.clientY, moved: false };
    strip.setPointerCapture(e.pointerId);
  });
  strip.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dy = e.clientY - drag.y;
    if (Math.abs(dy) >= 28) {
      step(dy > 0 ? 1 : -1);
      drag.y = e.clientY;
      drag.moved = true;
    }
  });
  let swallowClick = false;
  const endDrag = () => {
    swallowClick = !!drag?.moved;
    drag = null;
    if (swallowClick) setTimeout(() => (swallowClick = false), 0);
  };
  strip.addEventListener('pointerup', endDrag);
  strip.addEventListener('pointercancel', endDrag);
  // a drag ends with a click on a neighbour cell: don't count it as one more step
  strip.addEventListener(
    'click',
    (e) => {
      if (swallowClick) {
        e.stopPropagation();
        swallowClick = false;
      }
    },
    true,
  );
  // typing digits ("0", "7" -> 07) or letters (a/p for AM/PM)
  let typed = '';
  let typedAt = 0;
  el.addEventListener('keydown', (e) => {
    const k = e.key;
    if (k === 'ArrowUp') step(1);
    else if (k === 'ArrowDown') step(-1);
    else if (k === 'PageUp') step(pageStep);
    else if (k === 'PageDown') step(-pageStep);
    else if (k === 'Home' && !wrap) step(-values.length);
    else if (k === 'End' && !wrap) step(values.length);
    else if (/^[0-9]$/.test(k)) {
      const now = Date.now();
      typed = now - typedAt < 1200 ? typed + k : k;
      typedAt = now;
      let i = values.findIndex((x) => Number(x.value) === Number(typed) && typeof x.value === 'number');
      if (i < 0 && typed.length > 1) {
        typed = k;
        i = values.findIndex((x) => Number(x.value) === Number(k) && typeof x.value === 'number');
      }
      if (i >= 0 && i !== idx) {
        const d = i - idx;
        idx = i;
        paint();
        if (!reduceMotion()) cur.animate([{ opacity: 0.4, transform: `translateY(${d > 0 ? -12 : 12}px)` }, { opacity: 1, transform: 'none' }], { duration: 167, easing: EASE });
        onchange?.(values[idx].value);
      }
    } else if (/^[a-z]$/i.test(k) && !e.ctrlKey && !e.altKey && !e.metaKey) {
      const i = values.findIndex((x) => String(x.label).toLowerCase().startsWith(k.toLowerCase()));
      if (i >= 0 && i !== idx) {
        idx = i;
        paint();
        onchange?.(values[idx].value);
      }
    } else return;
    e.preventDefault();
    e.stopPropagation();
  });
  paint();
  Object.defineProperty(el, 'value', { get: () => values[idx].value });
  el.setValue = (v) => {
    const i = values.findIndex((x) => x.value === v);
    if (i >= 0) {
      idx = i;
      paint();
    }
  };
  el.step = step;
  return el;
}

/** Hour/minute(/AM-PM) picker built from spinners. picker.get() -> { hour, minute } (24 h) */
export function timePicker({ h, icon, t, hour = 7, minute = 0, h12 = false, periods = ['AM', 'PM'], onchange }) {
  const pad = (n) => String(n).padStart(2, '0');
  let H = hour;
  let M = minute;
  const fire = () => onchange?.({ hour: H, minute: M });
  const hours = h12 ? Array.from({ length: 12 }, (_, i) => ({ value: i + 1, label: String(i + 1) })) : Array.from({ length: 24 }, (_, i) => ({ value: i, label: pad(i) }));
  const minutes = Array.from({ length: 60 }, (_, i) => ({ value: i, label: pad(i) }));
  const hourSpin = spinner({
    h,
    icon,
    values: hours,
    value: h12 ? H % 12 || 12 : H,
    label: t('picker.hours'),
    pageStep: h12 ? 3 : 6,
    tipUp: t('picker.increase'),
    tipDown: t('picker.decrease'),
    onchange: (v) => {
      H = h12 ? (v % 12) + (H >= 12 ? 12 : 0) : v;
      fire();
    },
  });
  const minSpin = spinner({
    h,
    icon,
    values: minutes,
    value: M,
    label: t('picker.minutes'),
    pageStep: 10,
    tipUp: t('picker.increase'),
    tipDown: t('picker.decrease'),
    onchange: (v) => {
      M = v;
      fire();
    },
  });
  const cols = [hourSpin, h('div', { class: 'ck-spin-colon', 'aria-hidden': 'true' }, ':'), minSpin];
  let perSpin = null;
  if (h12) {
    perSpin = spinner({
      h,
      icon,
      values: [
        { value: 'am', label: periods[0] },
        { value: 'pm', label: periods[1] },
      ],
      value: H >= 12 ? 'pm' : 'am',
      wrap: false,
      label: t('picker.period'),
      className: 'period',
      onchange: (v) => {
        H = (H % 12) + (v === 'pm' ? 12 : 0);
        fire();
      },
    });
    cols.push(perSpin);
  }
  const el = h('div', { class: 'ck-picker', role: 'group', 'aria-label': t('picker.time') }, cols);
  el.get = () => ({ hour: H, minute: M });
  el.spins = { hour: hourSpin, minute: minSpin, period: perSpin };
  return el;
}

/** Duration picker hh : mm : ss. picker.get() -> ms */
export function durationPicker({ h, icon, t, ms = 5 * 60000, onchange }) {
  const pad = (n) => String(n).padStart(2, '0');
  const total = Math.round(ms / 1000);
  let H = Math.min(99, Math.floor(total / 3600));
  let M = Math.floor((total % 3600) / 60);
  let S = total % 60;
  const fire = () => onchange?.(el.get());
  const mk = (n, val, label, unit, set) =>
    h(
      'div',
      { class: 'ck-dur-col' },
      spinner({ h, icon, values: Array.from({ length: n }, (_, i) => ({ value: i, label: pad(i) })), value: val, label, pageStep: 10, tipUp: t('picker.increase'), tipDown: t('picker.decrease'), onchange: (v) => (set(v), fire()) }),
      h('div', { class: 'ck-dur-unit caption text-2' }, unit),
    );
  const el = h(
    'div',
    { class: 'ck-picker ck-dur', role: 'group', 'aria-label': t('picker.duration') },
    mk(100, H, t('picker.hours'), t('units.hrShort'), (v) => (H = v)),
    h('div', { class: 'ck-spin-colon', 'aria-hidden': 'true' }, ':'),
    mk(60, M, t('picker.minutes'), t('units.minShort'), (v) => (M = v)),
    h('div', { class: 'ck-spin-colon', 'aria-hidden': 'true' }, ':'),
    mk(60, S, t('picker.seconds'), t('units.secShort'), (v) => (S = v)),
  );
  el.get = () => (H * 3600 + M * 60 + S) * 1000;
  el.set = (msv) => {
    const tt = Math.round(msv / 1000);
    H = Math.min(99, Math.floor(tt / 3600));
    M = Math.floor((tt % 3600) / 60);
    S = tt % 60;
    const spins = el.querySelectorAll('.ck-spin');
    spins[0].setValue(H);
    spins[1].setValue(M);
    spins[2].setValue(S);
  };
  return el;
}

/** Weekday toggle buttons in locale order. el.get() -> [0..6] */
export function dayToggles({ h, order, names, longNames, days = [], onchange }) {
  const sel = new Set(days);
  const el = h('div', { class: 'ck-days', role: 'group' });
  for (const d of order) {
    const b = h(
      'button',
      {
        type: 'button',
        class: ['ck-day', sel.has(d) && 'on'],
        'aria-pressed': String(sel.has(d)),
        'aria-label': longNames[d],
        'data-tip': longNames[d],
        dataset: { day: String(d) },
        onclick: () => {
          if (sel.has(d)) sel.delete(d);
          else sel.add(d);
          b.classList.toggle('on', sel.has(d));
          b.setAttribute('aria-pressed', String(sel.has(d)));
          onchange?.(el.get());
        },
      },
      names[d],
    );
    el.appendChild(b);
  }
  el.get = () => [...sel].sort();
  el.set = (list) => {
    sel.clear();
    list.forEach((d) => sel.add(d));
    el.querySelectorAll('.ck-day').forEach((b) => {
      const on = sel.has(Number(b.dataset.day));
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
  };
  return el;
}

/** Floating command bar (bottom-right of a page), like the Windows 11 Clock "Edit" / "Add" buttons. */
export function commandBar(h, buttons) {
  return h(
    'div',
    { class: 'ck-cmdbar', role: 'toolbar' },
    buttons.filter(Boolean).map((b) => {
      const el = h('button', { type: 'button', class: ['btn', 'subtle', 'ck-cmd', b.className], 'aria-label': b.label, 'data-tip': b.label, onclick: b.onclick, dataset: b.dataset || null }, b.icon);
      b.ref?.(el);
      return el;
    }),
  );
}

/** Run a short entrance animation (respects animations off). */
export function enter(el, { y = 16, duration = 250, delay = 0 } = {}) {
  if (reduceMotion() || !el?.animate) return;
  el.animate([{ opacity: 0, transform: `translateY(${y}px)` }, { opacity: 1, transform: 'none' }], { duration, delay, easing: EASE, fill: 'backwards' });
}
