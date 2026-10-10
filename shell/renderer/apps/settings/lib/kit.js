// Settings app — Windows 11 Settings building blocks (cards, rows, expanders, combo boxes, toggles).
// createKit(pc) is called once per window; pc = page context (h, icon, ui, t, settings, …).
//
//   kit.group(title, ...rows)                         titled stack of rows
//   kit.row({ icon, title, desc, control, onClick, chevron, section, disabled, badge })
//   kit.expander({ icon, title, desc, control, body: () => Node, open, section })
//   kit.subRow({ title, desc, control })              a line inside an expander
//   kit.toggle({ value, onChange, label })            switch with the On / Off text before it
//   kit.settingToggleRow({ icon, title, desc, key, invert, section })   row bound to a settings key
//   kit.combo({ options: [{ value, label }], value, onChange, width, disabled })   Fluent combo box (menu)
//   kit.picker({ items, value, onChange, placeholder, format })  combo with a searchable popup (time zones)
//   kit.slider({ min, max, step, value, onInput, onChange, icons, format })
//   kit.infobar({ kind, title, message, action })     kind: info | success | warning | error
//   kit.link(label, onClick)  kit.button(label, onClick, { primary, icon })
//   kit.busy(button, promiseFn)                       disables the button with a spinner while running
//   kit.spinnerRow(text)
export function createKit(pc) {
  const { h, icon, ui, t } = pc;

  function iconBox(ic, opts = {}) {
    if (!ic) return null;
    if (ic instanceof Node) return h('span', { class: 'st-row-icon' }, ic);
    return h('span', { class: 'st-row-icon' }, icon(ic, { size: opts.size || 20, filled: opts.filled }));
  }

  function textBlock(title, desc) {
    return h(
      'div',
      { class: 'st-row-text' },
      h('div', { class: 'st-row-title' }, title),
      desc ? (desc instanceof Node ? h('div', { class: 'st-row-desc' }, desc) : h('div', { class: 'st-row-desc' }, desc)) : null,
    );
  }

  function group(title, ...rows) {
    return h('section', { class: 'st-group' }, title ? h('h3', { class: 'st-group-title' }, title) : null, h('div', { class: 'st-group-rows' }, rows));
  }

  function row({ icon: ic, iconFilled, title, desc, control, onClick, chevron, section, disabled, className, badge, ariaLabel } = {}) {
    const clickable = typeof onClick === 'function' && !disabled;
    const right = h('div', { class: 'st-row-right' }, badge || null, control || null, clickable && chevron !== false ? h('span', { class: 'st-chev' }, icon(chevron === 'external' ? 'open' : 'chevron_right', { size: 16 })) : null);
    // A row holding its own control can't be a <button> (no nested interactive content): use role=button.
    const asButton = clickable && !control;
    const el = h(
      asButton ? 'button' : 'div',
      {
        class: ['st-row', clickable && 'clickable', disabled && 'disabled', className],
        dataset: section ? { section } : null,
        type: asButton ? 'button' : null,
        role: clickable && !asButton ? 'button' : null,
        tabindex: clickable && !asButton ? '0' : null,
        'aria-label': ariaLabel || null,
        'aria-disabled': disabled ? 'true' : null,
        onclick: clickable
          ? (e) => {
              if (e.target.closest('.st-row-right .toggle, .st-row-right .st-combo, .st-row-right .btn, .st-row-right input, .st-row-right select, .st-row-right .st-link')) return;
              onClick(e);
            }
          : null,
        onkeydown:
          clickable && !asButton
            ? (e) => {
                if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
                  e.preventDefault();
                  onClick(e);
                }
              }
            : null,
      },
      iconBox(ic, { filled: iconFilled }),
      textBlock(title, desc),
      right,
    );
    return el;
  }

  function expander({ icon: ic, title, desc, control, body, open = false, section, className } = {}) {
    let built = null;
    const content = h('div', { class: 'st-exp-body', hidden: true });
    const head = h(
      'div',
      {
        class: 'st-row st-exp-head clickable',
        role: 'button',
        tabindex: '0',
        'aria-expanded': 'false',
        onclick: (e) => {
          if (e.target.closest('.st-row-right .toggle, .st-row-right .st-combo, .st-row-right .btn, .st-row-right input')) return;
          toggle();
        },
        onkeydown: (e) => {
          if ((e.key === 'Enter' || e.key === ' ') && e.target === head) {
            e.preventDefault();
            toggle();
          }
        },
      },
      iconBox(ic),
      textBlock(title, desc),
      h('div', { class: 'st-row-right' }, control || null, h('span', { class: 'st-chev st-exp-chev' }, icon('chevron_down', { size: 16 }))),
    );
    const el = h('div', { class: ['st-expander', className], dataset: section ? { section } : null }, head, content);
    function toggle(force) {
      const next = force ?? content.hidden;
      if (next === !content.hidden) return;
      if (next && !built) {
        built = typeof body === 'function' ? body() : body;
        if (built instanceof Promise) {
          const ph = h('div', { class: 'st-sub' }, h('span', { class: 'spinner small' }));
          content.appendChild(ph);
          built.then((n) => ph.replaceWith(n || h('span'))).catch((err) => ph.replaceWith(infobar({ kind: 'error', message: err.message })));
        } else if (built) content.appendChild(built);
      }
      content.hidden = !next;
      el.classList.toggle('open', next);
      head.setAttribute('aria-expanded', String(next));
      if (next && !reduceMotion()) content.animate([{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: 'cubic-bezier(0.1, 0.9, 0.2, 1)' });
    }
    el.toggle = toggle;
    el.rebuild = () => {
      built = null;
      ui.clear(content);
      if (!content.hidden) {
        content.hidden = true;
        toggle(true);
      }
    };
    if (open) toggle(true);
    return el;
  }

  function subRow({ title, desc, control, className, icon: ic } = {}) {
    return h('div', { class: ['st-sub', className] }, ic ? iconBox(ic, { size: 16 }) : null, textBlock(title, desc), control ? h('div', { class: 'st-row-right' }, control) : null);
  }

  function toggle({ value = false, onChange, disabled, label } = {}) {
    const text = h('span', { class: 'st-toggle-text' }, value ? t('common.on') : t('common.off'));
    const input = h('input', { type: 'checkbox', role: 'switch', checked: !!value, disabled: !!disabled, 'aria-label': label || null });
    const el = h('label', { class: ['toggle', 'st-toggle', disabled && 'disabled'] }, text, input);
    input.addEventListener('change', async () => {
      const v = input.checked;
      text.textContent = v ? t('common.on') : t('common.off');
      try {
        const r = await onChange?.(v);
        if (r === false) throw new Error('canceled');
      } catch (err) {
        // revert on failure / cancel
        input.checked = !v;
        text.textContent = !v ? t('common.on') : t('common.off');
        if (err && err.message !== 'canceled' && err.code !== 'ECANCELED') pc.toastError(err);
      }
    });
    el.input = input;
    el.set = (v) => {
      input.checked = !!v;
      text.textContent = v ? t('common.on') : t('common.off');
    };
    return el;
  }

  function settingToggleRow({ icon: ic, title, desc, key, invert = false, section, def = false, onChange } = {}) {
    const raw = pc.settings.get(key);
    const cur = raw == null ? def : !!raw;
    const tg = toggle({
      value: invert ? !cur : cur,
      label: title,
      onChange: (v) => {
        const val = invert ? !v : v;
        onChange?.(val);
        return pc.settings.set(key, val);
      },
    });
    const off = pc.settings.on(key, (v) => tg.set(invert ? !(v ?? def) : !!(v ?? def)));
    pc.onDispose(off);
    return row({ icon: ic, title, desc, control: tg, section });
  }

  function combo({ options = [], value, onChange, width, disabled, label, className } = {}) {
    let cur = value;
    const text = h('span', { class: 'st-combo-text ellipsis' });
    const btn = h(
      'button',
      {
        class: ['st-combo', className],
        type: 'button',
        disabled: !!disabled,
        'aria-haspopup': 'listbox',
        'aria-label': label || null,
        style: width ? { minWidth: `${width}px` } : null,
        onclick: async (e) => {
          e.stopPropagation();
          btn.classList.add('open');
          const shown = ui.menu(
            btn,
            options.map((o) =>
              o === '-'
                ? '-'
                : {
                    label: o.label,
                    checked: String(o.value) === String(cur),
                    disabled: o.disabled,
                    action: () => pick(o.value),
                  },
            ),
            { class: 'st-combo-menu' },
          );
          placeComboMenu(btn);
          await shown;
          btn.classList.remove('open');
        },
        onkeydown: (e) => {
          if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
          // while the list is open the arrows move in the list (core menu), they must not also pick
          if (btn.classList.contains('open')) return;
          e.preventDefault();
          const real = options.filter((o) => o !== '-' && !o.disabled);
          const i = real.findIndex((o) => String(o.value) === String(cur));
          const n = real[Math.max(0, Math.min(real.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
          if (n && String(n.value) !== String(cur)) pick(n.value);
        },
      },
      text,
      icon('chevron_down', { size: 12 }),
    );
    async function pick(v) {
      const prev = cur;
      cur = v;
      paint();
      try {
        const r = await onChange?.(v, prev);
        if (r === false) {
          cur = prev;
          paint();
        }
      } catch (err) {
        cur = prev;
        paint();
        if (err?.code !== 'ECANCELED') pc.toastError(err);
      }
    }
    function paint() {
      const o = options.find((x) => x !== '-' && String(x.value) === String(cur));
      text.textContent = o ? o.label : '';
    }
    paint();
    btn.setValue = (v) => {
      cur = v;
      paint();
    };
    btn.setOptions = (opts, v = cur) => {
      options = opts;
      cur = v;
      paint();
    };
    btn.getValue = () => cur;
    return btn;
  }

  // Like a WinUI ComboBox: the list is at least as wide as the control and opens with the selected
  // item over the button (clamped to the screen; long lists scroll to it).
  function placeComboMenu(btn) {
    const menus = document.querySelectorAll('.menu.st-combo-menu');
    const m = menus[menus.length - 1];
    if (!m) return;
    const r = btn.getBoundingClientRect();
    m.style.minWidth = `${Math.round(r.width)}px`;
    const sel = [...m.querySelectorAll('.menu-item')].find((el) => el.querySelector('.check .icon'));
    if (sel && m.scrollHeight > m.clientHeight) m.scrollTop = Math.max(0, sel.offsetTop - m.clientHeight / 2);
    const selTop = sel ? sel.offsetTop - m.scrollTop : 0;
    const top = Math.max(8, Math.min(window.innerHeight - m.offsetHeight - 8, r.top - selTop - 4));
    m.style.top = `${Math.round(top)}px`;
    m.style.left = `${Math.round(Math.max(4, Math.min(window.innerWidth - m.offsetWidth - 4, r.left - 4)))}px`;
  }

  // Combo box whose popup has a search field (long lists: time zones, keyboard layouts).
  function picker({ items = [], value, onChange, format = (x) => String(x), width = 280, placeholder, label } = {}) {
    let cur = value;
    const text = h('span', { class: 'st-combo-text ellipsis' });
    const btn = h('button', { class: 'st-combo', type: 'button', 'aria-haspopup': 'listbox', 'aria-label': label || null, style: { minWidth: `${width}px` }, onclick: (e) => (e.stopPropagation(), open()) }, text, icon('chevron_down', { size: 12 }));
    const paint = () => (text.textContent = cur == null ? placeholder || '' : format(cur));
    paint();
    function open() {
      const r = btn.getBoundingClientRect();
      const input = h('input', { class: 'input st-picker-input', placeholder: t('settings.searchList'), 'aria-label': t('settings.searchList') });
      const list = h('div', { class: 'st-picker-list', role: 'listbox' });
      const pop = h('div', { class: 'st-picker menu', role: 'dialog' }, h('div', { class: 'search-box' }, input, icon('search', { size: 14 })), list);
      let shown = [];
      let active = -1;
      const render = () => {
        const q = input.value.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
        shown = items.filter((x) => !q || format(x).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').includes(q) || String(x).toLowerCase().includes(q)).slice(0, 400);
        ui.clear(list);
        if (!shown.length) list.appendChild(h('div', { class: 'st-picker-empty caption text-2' }, t('settings.noMatches')));
        shown.forEach((x, i) =>
          list.appendChild(
            h(
              'div',
              { class: ['menu-item', String(x) === String(cur) && 'current', i === active && 'active'], role: 'option', 'aria-selected': String(String(x) === String(cur)), onclick: () => choose(x) },
              h('span', { class: 'check' }, String(x) === String(cur) ? icon('checkmark', { size: 16 }) : null),
              h('span', { class: 'label ellipsis' }, format(x)),
            ),
          ),
        );
      };
      const close = () => {
        pop.remove();
        document.removeEventListener('pointerdown', outside, true);
      };
      const outside = (e) => {
        if (!pop.contains(e.target)) close();
      };
      async function choose(x) {
        close();
        const prev = cur;
        cur = x;
        paint();
        try {
          const res = await onChange?.(x, prev);
          if (res === false) {
            cur = prev;
            paint();
          }
        } catch (err) {
          cur = prev;
          paint();
          if (err?.code !== 'ECANCELED') pc.toastError(err);
        }
        btn.focus();
      }
      input.addEventListener('input', () => {
        active = -1;
        render();
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          close();
          btn.focus();
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          active = Math.max(0, Math.min(shown.length - 1, active + (e.key === 'ArrowDown' ? 1 : -1)));
          render();
          list.children[active]?.scrollIntoView({ block: 'nearest' });
        } else if (e.key === 'Enter') {
          e.preventDefault();
          const x = shown[active >= 0 ? active : 0];
          if (x != null) choose(x);
        }
      });
      document.body.appendChild(pop);
      const pw = Math.max(width + 40, r.width);
      const ph = Math.min(380, window.innerHeight - 40);
      let top = r.bottom + 4;
      if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 4);
      Object.assign(pop.style, { left: `${Math.max(8, Math.min(window.innerWidth - pw - 8, r.left))}px`, top: `${top}px`, width: `${pw}px`, maxHeight: `${ph}px` });
      render();
      const sel = list.querySelector('.current');
      sel?.scrollIntoView({ block: 'center' });
      setTimeout(() => {
        input.focus();
        document.addEventListener('pointerdown', outside, true);
      }, 0);
    }
    btn.setValue = (v) => {
      cur = v;
      paint();
    };
    btn.setItems = (list) => (items = list);
    return btn;
  }

  function slider({ min = 0, max = 100, step = 1, value = 0, onInput, onChange, iconStart, iconEnd, format, label, disabled } = {}) {
    const val = h('span', { class: 'st-slider-val' }, format ? format(value) : String(value));
    const s = ui.slider({
      min,
      max,
      step,
      value,
      oninput: (v) => {
        val.textContent = format ? format(v) : String(v);
        onInput?.(v);
      },
      onchange: (v) => onChange?.(v),
    });
    if (label) s.setAttribute('aria-label', label);
    if (disabled) s.disabled = true;
    const el = h('div', { class: 'st-slider' }, iconStart ? icon(iconStart, { size: 16 }) : null, s, iconEnd ? icon(iconEnd, { size: 16 }) : null, val);
    el.input = s;
    el.set = (v) => {
      s.setValue(v);
      val.textContent = format ? format(v) : String(v);
    };
    return el;
  }

  function infobar({ kind = 'info', title, message, action, className } = {}) {
    const ic = { info: 'info', success: 'checkmark_circle', warning: 'warning', error: 'error_circle' }[kind] || 'info';
    return h(
      'div',
      { class: ['infobar', 'st-infobar', kind, className], role: kind === 'error' || kind === 'warning' ? 'alert' : 'status' },
      icon(ic, { filled: true }),
      h('div', { class: 'grow' }, title ? h('span', { class: 'body-strong' }, `${title} `) : null, message ? h('span', null, message) : null),
      action || null,
    );
  }

  function link(label, onClick, opts = {}) {
    return h('button', { class: ['st-link', opts.className], type: 'button', onclick: onClick }, opts.icon ? icon(opts.icon, { size: 14 }) : null, label);
  }

  function button(label, onClick, { primary, icon: ic, disabled, className, danger } = {}) {
    return h('button', { class: ['btn', primary && 'primary', danger && 'st-danger', className], type: 'button', disabled: !!disabled, onclick: onClick }, ic ? icon(ic, { size: 16 }) : null, label);
  }

  async function busy(btn, fn) {
    if (btn.disabled) return;
    const prev = [...btn.childNodes];
    const w = btn.getBoundingClientRect().width;
    btn.disabled = true;
    btn.style.minWidth = `${w}px`;
    btn.replaceChildren(h('span', { class: 'spinner small' }));
    try {
      return await fn();
    } finally {
      if (btn.isConnected) {
        btn.replaceChildren(...prev);
        btn.disabled = false;
        btn.style.minWidth = '';
      }
    }
  }

  function spinnerRow(text) {
    return h('div', { class: 'st-loading' }, h('span', { class: 'spinner small' }), text ? h('span', { class: 'text-2' }, text) : null);
  }

  // A "Related settings" block of link rows.
  function related(items) {
    return group(t('settings.related'), ...items.map((it) => row({ icon: it.icon, title: it.title, desc: it.desc, onClick: it.onClick, chevron: it.external ? 'external' : true })));
  }

  function reduceMotion() {
    return document.documentElement.dataset.animations === 'off';
  }

  return { group, row, expander, subRow, toggle, settingToggleRow, combo, picker, slider, infobar, link, button, busy, spinnerRow, related, iconBox, reduceMotion };
}
