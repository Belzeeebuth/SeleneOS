// Notepad popup menus (styled by the core `.menu` classes): the "…" menu of the title bar, the
// context menus and the pickers of the document info pill.
//
// Notepad renders its own menus instead of ui.menu so that:
//   - menus follow the app's own theme setting (light / dark override per window);
//   - the "…" menu can have section headings, on/off switches and keyboard entry points
//     (F10 / Alt open it on its first item, Alt+F / Alt+E / Alt+V on a section).
//
//   const menus = new Menus({ h, icon, themeClass: () => 'np-theme-dark' | '', kbd: (combo) => localisedCombo });
//   await menus.popup(eventOrPoint, [{ header }, { id, label, icon, shortcut, checked, disabled, action, submenu }, '-', …],
//                     { keyboard, focusId, toggle: anchorButton, restore, className });

function pointOf(at) {
  if (!at) return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  if (at instanceof Event) {
    if (typeof at.clientX === 'number' && (at.clientX || at.clientY)) return { x: at.clientX, y: at.clientY };
    const r = (at.currentTarget || at.target)?.getBoundingClientRect?.();
    return r ? { x: r.left, y: r.bottom + 2, anchor: r } : { x: 0, y: 0 };
  }
  if (at instanceof Element) {
    const r = at.getBoundingClientRect();
    return { x: r.left, y: r.bottom + 2, anchor: r };
  }
  return at;
}

export class Menus {
  constructor({ h, icon, themeClass, kbd }) {
    this.h = h;
    this.icon = icon;
    this.themeClass = themeClass || (() => '');
    this.kbd = kbd || ((k) => k);
    this.stack = []; // [{ el, entries, active, items }]
    this.session = null; // { resolve, restore, toggle, keyboard }
    this._onKey = this._onKey.bind(this);
    this._onOutside = this._onOutside.bind(this);
    this._onBlur = () => this.close();
  }

  get isOpen() {
    return !!this.session;
  }

  popup(at, items, opts = {}) {
    if (at instanceof Event) {
      at.preventDefault?.();
      at.stopPropagation?.();
    }
    const restore = opts.restore || this.session?.restore || document.activeElement;
    this.close(null, { restoreFocus: false });
    return new Promise((resolve) => {
      this._begin({ resolve, restore, toggle: opts.toggle || null, keyboard: !!opts.keyboard });
      if (opts.toggle) {
        opts.toggle.classList.add('open');
        opts.toggle.setAttribute('aria-expanded', 'true');
      }
      this._openLevel(items, pointOf(at), 0, { keyboard: !!opts.keyboard, className: opts.className, focusId: opts.focusId, alignRight: !!opts.alignRight });
    });
  }

  close(result = null, { restoreFocus = true } = {}) {
    const s = this.session;
    if (!s) return;
    this.session = null;
    for (const m of this.stack.splice(0)) this._removeEl(m.el);
    document.removeEventListener('keydown', this._onKey, true);
    document.removeEventListener('pointerdown', this._onOutside, true);
    window.removeEventListener('blur', this._onBlur);
    if (s.toggle) {
      s.toggle.classList.remove('open');
      s.toggle.setAttribute('aria-expanded', 'false');
    }
    if (restoreFocus && s.restore?.isConnected && (!document.activeElement || document.activeElement === document.body || document.activeElement.closest?.('.np-menu'))) {
      try {
        s.restore.focus({ preventScroll: true });
      } catch {}
    }
    s.resolve?.(result);
  }

  _removeEl(el) {
    clearTimeout(el._subTimer);
    el.remove();
  }

  _begin(session) {
    this.session = session;
    setTimeout(() => {
      if (this.session !== session) return;
      document.addEventListener('pointerdown', this._onOutside, true);
      window.addEventListener('blur', this._onBlur);
    });
    document.addEventListener('keydown', this._onKey, true);
  }

  // ------------------------------------------------------------------ rendering
  _openLevel(items, pt, level, { keyboard = false, className, focusId, alignRight = false } = {}) {
    for (const m of this.stack.splice(level)) this._removeEl(m.el);
    const { h, icon } = this;
    const visible = items.filter((it) => it && !it.hidden);
    const hasIcon = visible.some((it) => it !== '-' && it.icon);
    // With icons, on/off items show a small switch at the end of the row; without, a check mark column.
    const hasCheck = !hasIcon && visible.some((it) => it !== '-' && it.checked !== undefined);
    const el = h('div', { class: ['menu', 'np-menu', this.themeClass(), className], role: 'menu', tabindex: '-1' });
    // Opened from the keyboard: a pointer that merely rests where the menu appears (Chromium sends
    // it a synthetic enter) must not move the highlight; it does once the pointer really moves.
    const m = { el, entries: [], active: -1, level, still: keyboard ? null : false };
    // Until the pointer really moves, a resting pointer's :hover must not draw a second highlight.
    if (keyboard) el.classList.add('np-menu-still');
    let prevSep = true;
    for (const it of visible) {
      if (it === '-') {
        if (!prevSep) el.appendChild(h('div', { class: 'menu-sep', role: 'separator' }));
        prevSep = true;
        continue;
      }
      if (it.header) {
        if (el.lastChild?.classList?.contains('menu-sep')) el.lastChild.remove();
        el.appendChild(h('div', { class: 'menu-header np-menu-header', role: 'presentation' }, it.header));
        prevSep = true;
        continue;
      }
      prevSep = false;
      const checkable = it.checked !== undefined;
      const row = h(
        'div',
        {
          class: ['menu-item', it.disabled && 'disabled'],
          role: checkable ? 'menuitemcheckbox' : 'menuitem',
          'aria-checked': checkable ? String(!!it.checked) : null,
          'aria-disabled': it.disabled ? 'true' : null,
          'aria-haspopup': it.submenu ? 'menu' : null,
          'data-tip': it.tip || null,
          dataset: it.id ? { id: it.id } : null,
        },
        hasCheck ? h('span', { class: 'check' }, it.checked ? icon('checkmark', { size: 16 }) : null) : null,
        it.icon ? icon(it.icon) : hasIcon ? h('span', { class: 'icon' }) : null,
        h('span', { class: 'label' }, it.label),
        it.shortcut ? h('span', { class: 'shortcut' }, this.kbd(it.shortcut)) : null,
        checkable && !hasCheck ? h('span', { class: ['np-menu-switch', it.checked && 'on'], 'aria-hidden': 'true' }) : null,
        it.submenu ? icon('chevron_right', { size: 12, class: 'np-menu-chev' }) : null,
      );
      const idx = m.entries.length;
      m.entries.push({ row, it });
      row.addEventListener('pointerenter', (e) => {
        if (m.still !== false) {
          if (!m.still || (m.still[0] === e.clientX && m.still[1] === e.clientY)) {
            m.still = [e.clientX, e.clientY];
            return;
          }
          m.still = false;
          el.classList.remove('np-menu-still');
        }
        this._setActive(m, idx);
        clearTimeout(el._subTimer);
        if (it.submenu && !it.disabled) el._subTimer = setTimeout(() => this._openSub(m, idx, false), 220);
        else if (this.stack.length > level + 1) el._subTimer = setTimeout(() => this._closeFrom(level + 1), 220);
      });
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        this._activate(m, idx, false);
      });
      el.appendChild(row);
    }
    if (prevSep && el.lastChild?.classList?.contains('menu-sep')) el.lastChild.remove();
    // Position: inside the viewport, submenus flip to the left when needed. A menu taller than the
    // screen scrolls (np-menu has a max-height).
    el.style.visibility = 'hidden';
    document.body.appendChild(el);
    const r = el.getBoundingClientRect();
    let x = alignRight && pt.anchor ? pt.anchor.right - r.width : pt.x;
    let y = pt.y;
    if (x + r.width > window.innerWidth - 4) x = pt.sub ? pt.sub.left - r.width + 4 : window.innerWidth - r.width - 4;
    if (y + r.height > window.innerHeight - 4) {
      if (pt.anchor && pt.anchor.top - r.height - 2 >= 4) {
        y = pt.anchor.top - r.height - 2;
        el.classList.add('up');
      } else y = Math.max(4, window.innerHeight - r.height - 4);
    }
    el.style.left = `${Math.max(4, Math.round(x))}px`;
    el.style.top = `${Math.max(4, Math.round(y))}px`;
    el.style.visibility = '';
    this.stack.push(m);
    if (level === 0) el.focus({ preventScroll: true });
    const start = focusId ? m.entries.findIndex((e) => e.it.id === focusId && !e.it.disabled) : -1;
    if (start >= 0) {
      this._setActive(m, start);
      m.entries[start].row.scrollIntoView?.({ block: 'nearest' });
    } else if (keyboard) this._move(m, 1, true);
    return m;
  }

  _setActive(m, idx) {
    m.active = idx;
    m.entries.forEach((e, i) => e.row.classList.toggle('active', i === idx));
  }

  _move(m, dir, fromStart = false) {
    const n = m.entries.length;
    if (!n) return;
    let i = fromStart ? (dir > 0 ? -1 : n) : m.active;
    for (let k = 0; k < n; k++) {
      i = (i + dir + n) % n;
      if (!m.entries[i].it.disabled) {
        this._setActive(m, i);
        m.entries[i].row.scrollIntoView?.({ block: 'nearest' });
        return;
      }
    }
  }

  _openSub(m, idx, keyboard) {
    const { row, it } = m.entries[idx];
    if (!it.submenu || it.disabled) return;
    if (this.stack[m.level + 1]?.parentIdx === idx) {
      if (keyboard) this._move(this.stack[m.level + 1], 1, true);
      return;
    }
    const items = typeof it.submenu === 'function' ? it.submenu() : it.submenu;
    const r = row.getBoundingClientRect();
    const sub = this._openLevel(items, { x: r.right - 4, y: r.top - 5, sub: r }, m.level + 1, { keyboard });
    sub.parentIdx = idx;
    row.classList.add('sub-open');
  }

  _closeFrom(level) {
    for (const m of this.stack.splice(level)) this._removeEl(m.el);
    const parent = this.stack[level - 1];
    parent?.entries.forEach((e) => e.row.classList.remove('sub-open'));
  }

  _activate(m, idx, keyboard) {
    const { it } = m.entries[idx] || {};
    if (!it || it.disabled) return;
    if (it.submenu) return this._openSub(m, idx, keyboard);
    this.close(it);
    try {
      it.action?.();
    } catch (err) {
      console.error('[notepad] menu action failed', err);
    }
  }

  // ------------------------------------------------------------------ input
  _onOutside(e) {
    if (this.stack.some((m) => m.el.contains(e.target))) return;
    if (this.session?.toggle?.contains(e.target)) return; // the "…" button toggles its menu itself
    this.close();
  }

  _onKey(e) {
    const s = this.session;
    if (!s) return;
    const m = this.stack[this.stack.length - 1];
    if (!m) return;
    if (e.ctrlKey || e.metaKey) {
      // Shortcuts keep working: close the menu and let the key through.
      this.close();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const k = e.key;
    const cur = m.active >= 0 ? m.entries[m.active]?.it : null;
    switch (k) {
      case 'ArrowDown':
        this._move(m, 1);
        break;
      case 'ArrowUp':
        this._move(m, -1);
        break;
      case 'Home':
        this._move(m, 1, true);
        break;
      case 'End':
        this._move(m, -1, true);
        break;
      case 'ArrowRight':
        if (cur?.submenu && !cur.disabled) this._openSub(m, m.active, true);
        break;
      case 'ArrowLeft':
        if (m.level > 0) this._closeFrom(m.level);
        break;
      case 'Enter':
      case ' ':
        if (m.active >= 0) this._activate(m, m.active, true);
        break;
      case 'Escape':
        if (m.level > 0) this._closeFrom(m.level);
        else this.close();
        break;
      case 'Tab':
      case 'Alt':
      case 'F10':
        this.close();
        break;
      default:
        if (k.length === 1 && !e.altKey) this._jump(m, k);
    }
  }

  // Letter navigation: select the next item starting with the letter; activate it when unique.
  _jump(m, ch) {
    const c = ch.toLocaleLowerCase();
    const matches = m.entries.map((e, i) => [e, i]).filter(([e]) => !e.it.disabled && String(e.it.label || '').trim().toLocaleLowerCase().startsWith(c));
    if (!matches.length) return;
    if (matches.length === 1) {
      this._setActive(m, matches[0][1]);
      this._activate(m, matches[0][1], true);
      return;
    }
    const next = matches.find(([, i]) => i > m.active) || matches[0];
    this._setActive(m, next[1]);
  }
}
