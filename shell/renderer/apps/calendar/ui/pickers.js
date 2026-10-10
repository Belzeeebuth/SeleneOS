// Popovers (Fluent flyouts) and the date / time pickers used by the event editor.
//   openPopover({ anchor, content, className, placement: 'below'|'side', owner, onClose, focus, label })
//       -> { el, close(reason), reposition() }. Closes on outside click, Esc, owner window close/blur.
//   dateField(app, { value: Date, onChange(Date), label }) -> button + mini-month flyout
//   timeField(app, { value: minutes, onChange(min), from: () => minutes|null (show durations), label })
//       -> editable combobox (type "9", "9:30", "21h15", "9pm"…) with a 30-minute list
//   parseTime(text) -> minutes | null
import { miniMonth } from './minical.js';

const stack = [];

function onDocPointer(e) {
  for (let i = stack.length - 1; i >= 0; i--) {
    const p = stack[i];
    if (p.el.contains(e.target) || p.anchorEl?.contains?.(e.target)) return;
    if (e.target.closest?.('.menu, .tooltip')) return;
    p.close('outside');
  }
}
function onDocKey(e) {
  if (e.key !== 'Escape' || !stack.length) return;
  if (document.querySelector('body > .menu')) return; // a context menu above us handles it
  e.preventDefault();
  e.stopPropagation();
  stack[stack.length - 1].close('escape');
}
function onResize() {
  for (const p of [...stack]) p.close('resize');
}
let listening = false;
function listen(on) {
  if (on && !listening) {
    document.addEventListener('pointerdown', onDocPointer, true);
    document.addEventListener('keydown', onDocKey, true);
    window.addEventListener('resize', onResize);
    listening = true;
  } else if (!on && listening && !stack.length) {
    document.removeEventListener('pointerdown', onDocPointer, true);
    document.removeEventListener('keydown', onDocKey, true);
    window.removeEventListener('resize', onResize);
    listening = false;
  }
}

export function closeAllPopovers(reason = 'api') {
  for (const p of [...stack].reverse()) p.close(reason);
}

export function openPopover({ anchor, content, className, placement = 'below', owner, onClose, focus, label, role = 'dialog' }) {
  const el = document.createElement('div');
  // the flyout lives in <body> (it may overflow the window): .app-calendar keeps our scoped styles
  el.className = `app-calendar ac-pop ${className || ''}`;
  el.setAttribute('role', role);
  el.tabIndex = -1;
  if (label) el.setAttribute('aria-label', label);
  el.appendChild(content);
  // follow the per-app theme of the owning window (core/theme.js decorates .win elements)
  const ownerEl = owner?.el;
  if (ownerEl?.hasAttribute?.('data-theme-scope') && ownerEl.dataset.theme) {
    el.setAttribute('data-theme-scope', '');
    el.dataset.theme = ownerEl.dataset.theme;
    for (const k of ['--accent', '--accent-hover', '--accent-pressed', '--accent-text', '--accent-subtle', '--on-accent', '--accent-base']) {
      const v = ownerEl.style.getPropertyValue(k);
      if (v) el.style.setProperty(k, v);
    }
  }
  document.body.appendChild(el);
  const anchorEl = anchor instanceof Element ? anchor : null;
  const offs = [];
  let closed = false;
  const prevFocus = document.activeElement;
  const handle = {
    el,
    anchorEl,
    close(reason = 'api') {
      if (closed) return;
      closed = true;
      const i = stack.indexOf(handle);
      if (i >= 0) stack.splice(i, 1);
      for (const off of offs) off?.();
      listen(false);
      el.classList.add('closing');
      setTimeout(() => el.remove(), 120);
      // give focus back to where it was when the flyout closes from the keyboard
      if ((reason === 'escape' || reason === 'pick') && prevFocus?.isConnected) prevFocus.focus({ preventScroll: true });
      onClose?.(reason);
    },
    reposition() {
      const r = anchorEl ? anchorEl.getBoundingClientRect() : anchor;
      const pr = el.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight - 4;
      let x;
      let y;
      if (placement === 'side') {
        x = r.right + 8;
        if (x + pr.width > vw - 4) x = r.left - pr.width - 8;
        if (x < 4) x = Math.max(4, Math.min(vw - pr.width - 4, r.left + r.width / 2 - pr.width / 2));
        y = Math.max(4, Math.min(vh - pr.height, r.top));
        el.classList.toggle('from-left', x < r.left);
      } else {
        x = Math.max(4, Math.min(vw - pr.width - 4, r.left));
        y = r.bottom + 4;
        if (y + pr.height > vh) {
          const up = r.top - pr.height - 4;
          if (up >= 4) {
            y = up;
            el.classList.add('up');
          } else y = Math.max(4, vh - pr.height);
        }
      }
      el.style.left = `${Math.round(x)}px`;
      el.style.top = `${Math.round(y)}px`;
    },
  };
  handle.reposition();
  stack.push(handle);
  // let the click that opened us finish before listening for outside clicks
  setTimeout(() => !closed && listen(true));
  listen(true);
  if (owner) {
    offs.push(owner.on?.('close', () => handle.close('owner')));
    offs.push(owner.on?.('minimize', () => handle.close('owner')));
    offs.push(owner.on?.('move', () => handle.close('owner')));
    offs.push(owner.on?.('resize', () => handle.close('owner')));
  }
  if (focus !== false) {
    setTimeout(() => {
      if (closed) return;
      const f = typeof focus === 'function' ? focus() : el.querySelector('[autofocus], input, select, textarea, button');
      (f || el).focus({ preventScroll: true });
    }, 20);
  }
  return handle;
}

// ------------------------------------------------------------------ date field
export function dateField(app, { value, onChange, label }) {
  const { h, icon } = app.ctx;
  let current = new Date(value);
  let pop = null;
  const text = h('span', { class: 'ellipsis' });
  const btn = h(
    'button',
    {
      type: 'button',
      class: 'btn ac-datefield',
      'aria-haspopup': 'dialog',
      'aria-label': label,
      onclick: () => (pop ? pop.close('toggle') : open()),
      onkeydown: (e) => {
        if (e.key === 'ArrowDown' && e.altKey) {
          e.preventDefault();
          open();
        }
      },
    },
    text,
    icon('calendar', { size: 16 }),
  );
  const paint = () => {
    text.textContent = app.fmt.dayMed(current);
    btn.title = app.fmt.dayLong(current);
  };
  function open() {
    const mm = miniMonth(app, {
      month: current,
      selected: current,
      onPick: (d) => {
        current = new Date(d);
        paint();
        pop?.close('pick');
        onChange?.(new Date(current));
      },
    });
    pop = openPopover({ anchor: btn, content: mm, className: 'ac-pop-date', owner: app.win, label, focus: () => mm.querySelector('.ac-mini-day.selected') || mm.querySelector('.ac-mini-day[tabindex="0"]'), onClose: () => (pop = null) });
    btn.setAttribute('aria-expanded', 'true');
    pop.el.addEventListener('transitionend', () => {}, { once: true });
  }
  paint();
  btn.getValue = () => new Date(current);
  btn.setValue = (d) => {
    current = new Date(d);
    paint();
  };
  return btn;
}

// ------------------------------------------------------------------ time field
export function parseTime(text) {
  let s = String(text || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/\./g, ':');
  if (!s) return null;
  let pm = null;
  const ap = /(a|am|a:m:|p|pm|p:m:)$/.exec(s);
  if (ap) {
    pm = ap[1].startsWith('p');
    s = s.slice(0, -ap[1].length);
  }
  s = s.replace(/h$/, '').replace('h', ':');
  let hh;
  let mm = 0;
  let m = /^(\d{1,2}):(\d{1,2})$/.exec(s);
  if (m) {
    hh = Number(m[1]);
    mm = Number(m[2]);
  } else if ((m = /^(\d{1,2})$/.exec(s))) hh = Number(m[1]);
  else if ((m = /^(\d{3,4})$/.exec(s))) {
    hh = Number(m[1].slice(0, -2));
    mm = Number(m[1].slice(-2));
  } else return null;
  if (mm > 59) return null;
  if (pm !== null) {
    if (hh < 1 || hh > 12) return null;
    if (pm && hh !== 12) hh += 12;
    if (!pm && hh === 12) hh = 0;
  }
  if (hh === 24 && mm === 0) hh = 0;
  if (hh > 23) return null;
  return hh * 60 + mm;
}

export function timeField(app, { value, onChange, from, label }) {
  const { h } = app.ctx;
  let current = value;
  let pop = null;
  let list = null;
  let active = -1;
  const input = h('input', {
    class: 'input ac-timefield',
    type: 'text',
    role: 'combobox',
    'aria-label': label,
    'aria-autocomplete': 'none',
    'aria-expanded': 'false',
    spellcheck: false,
    autocomplete: 'off',
  });
  const fmtMin = (min) => app.fmt.time(new Date(2026, 0, 5, Math.floor(min / 60), min % 60).getTime());
  const paint = () => {
    input.value = fmtMin(current);
    input.classList.remove('invalid');
  };
  const commit = () => {
    const v = parseTime(input.value);
    if (v == null) {
      input.classList.add('invalid');
      setTimeout(paint, 900);
      return false;
    }
    const changed = v !== current;
    current = v;
    paint();
    if (changed) onChange?.(current);
    return true;
  };
  function options() {
    const base = from?.();
    const out = [];
    if (base != null) {
      // end-time list: from the start time on, with the duration (Outlook)
      for (let d = 0; d <= 24 * 60; d += d < 60 ? 15 : 30) {
        const min = base + d;
        if (min >= 24 * 60) break;
        out.push({ min, extra: d === 0 ? app.t('durMin', { n: 0 }) : app.fmt.duration(d) });
      }
    } else for (let min = 0; min < 24 * 60; min += 30) out.push({ min });
    return out;
  }
  function highlight(i, scroll = true) {
    const items = list ? [...list.children] : [];
    if (!items.length) return;
    active = Math.max(0, Math.min(items.length - 1, i));
    items.forEach((x, j) => {
      x.classList.toggle('active', j === active);
      x.setAttribute('aria-selected', j === active ? 'true' : 'false');
    });
    if (scroll) items[active].scrollIntoView({ block: 'nearest' });
    input.setAttribute('aria-activedescendant', items[active].id);
  }
  let opts = [];
  let downOn = -1;
  function open() {
    if (pop) return;
    opts = options();
    downOn = -1;
    list = h(
      'div',
      { class: 'ac-timelist', role: 'listbox', id: `tl${Math.random().toString(36).slice(2, 8)}` },
      opts.map((o, i) =>
        h(
          'div',
          {
            class: ['ac-timeopt', o.min === current && 'current'],
            role: 'option',
            id: `${Math.random().toString(36).slice(2, 8)}-${i}`,
            // a pointer that went down elsewhere (e.g. on the input) never picks an option on release
            onpointerdown: (e) => {
              e.preventDefault();
              downOn = i;
            },
            onclick: () => downOn === i && pick(o.min),
          },
          h('span', null, fmtMin(o.min)),
          o.extra ? h('span', { class: 'text-2' }, o.extra) : null,
        ),
      ),
    );
    pop = openPopover({ anchor: input, content: list, className: 'ac-pop-time', owner: app.win, focus: false, role: 'presentation', onClose: () => ((pop = null), (list = null), input.setAttribute('aria-expanded', 'false')) });
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-controls', list.id);
    // show the current (or nearest following) time at the top of the list
    let idx = opts.findIndex((o) => o.min >= current);
    if (idx < 0) idx = opts.length - 1;
    highlight(idx, false);
    list.scrollTop = Math.max(0, list.children[idx].offsetTop - 4);
  }
  function pick(min) {
    pop?.close('pick-silent');
    const changed = min !== current;
    current = min;
    paint();
    if (changed) onChange?.(current);
    input.focus();
  }
  input.addEventListener('click', () => open());
  input.addEventListener('focus', () => setTimeout(() => input.select(), 0));
  input.addEventListener('blur', () => {
    setTimeout(() => {
      if (document.activeElement === input) return;
      pop?.close('blur');
      commit();
    }, 120);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!pop) return open();
      highlight(active + (e.key === 'ArrowDown' ? 1 : -1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (pop && active >= 0 && opts[active] && parseTime(input.value) === current) {
        pick(opts[active].min);
        return;
      }
      pop?.close('enter');
      commit();
    } else if (e.key === 'Escape' && pop) {
      e.preventDefault();
      e.stopPropagation();
      pop.close('escape-silent');
    } else if (e.key === 'Tab') {
      pop?.close('tab');
    }
  });
  paint();
  input.getValue = () => current;
  input.setValue = (min) => {
    current = min;
    paint();
  };
  input.commit = commit;
  return input;
}
