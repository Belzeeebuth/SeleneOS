// Notepad menus: Fluent popup menus (styled by the core `.menu` classes) and a classic menu bar.
//
// Notepad renders its own menus instead of ui.menu so that:
//   - the menu bar works like Windows (hovering File → Edit switches menus, ←/→ move between them,
//     Alt / F10 focus the bar and show key tips, Alt+F/E/V open a menu directly);
//   - menus follow the app's own theme setting (light / dark override per window).
//
//   const menus = new Menus({ h, icon, themeClass: () => 'np-theme-dark' | '', kbd: (combo) => localisedCombo });
//   await menus.popup(eventOrPoint, [{ label, icon, shortcut, checked, disabled, action, submenu }, '-', …]);
//   const bar = menus.menubar(barEl, [{ id, label, key, items: () => [...] }], { restoreFocus: () => el });

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
    this.session = null; // { resolve, restore, bar, barId, keyboard }
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
      this._begin({ resolve, restore, bar: null, keyboard: !!opts.keyboard });
      this._openLevel(items, pointOf(at), 0, { keyboard: !!opts.keyboard, className: opts.className });
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
    if (s.bar) s.bar._closed(s.barId);
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
  _openLevel(items, pt, level, { keyboard = false, className } = {}) {
    for (const m of this.stack.splice(level)) this._removeEl(m.el);
    const { h, icon } = this;
    const visible = items.filter((it) => it && !it.hidden);
    const hasCheck = visible.some((it) => it !== '-' && it.checked !== undefined);
    const hasIcon = visible.some((it) => it !== '-' && it.icon);
    const el = h('div', { class: ['menu', 'np-menu', this.themeClass(), className], role: 'menu', tabindex: '-1' });
    const m = { el, entries: [], active: -1, level };
    let prevSep = true;
    for (const it of visible) {
      if (it === '-') {
        if (!prevSep) el.appendChild(h('div', { class: 'menu-sep', role: 'separator' }));
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
        it.submenu ? icon('chevron_right', { size: 12, class: 'np-menu-chev' }) : null,
      );
      const idx = m.entries.length;
      m.entries.push({ row, it });
      row.addEventListener('pointerenter', () => {
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
    // Position: inside the viewport, submenus flip to the left when needed.
    el.style.visibility = 'hidden';
    document.body.appendChild(el);
    const r = el.getBoundingClientRect();
    let x = pt.x;
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
    if (keyboard) this._move(m, 1, true);
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
    if (this.session?.bar?.el.contains(e.target) && e.target.closest('.np-menu-btn')) return; // the bar toggles itself
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
        else if (s.bar) s.bar.step(1, true);
        break;
      case 'ArrowLeft':
        if (m.level > 0) this._closeFrom(m.level);
        else if (s.bar) s.bar.step(-1, true);
        break;
      case 'Enter':
      case ' ':
        if (m.active >= 0) this._activate(m, m.active, true);
        break;
      case 'Escape':
        if (m.level > 0) this._closeFrom(m.level);
        else if (s.bar && s.keyboard) {
          const bar = s.bar;
          const id = s.barId;
          this.close(null, { restoreFocus: false });
          bar.focusButton(id);
        } else this.close();
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

  // ------------------------------------------------------------------ menu bar
  menubar(el, defs, { restoreFocus } = {}) {
    const menus = this;
    const { h } = this;
    const buttons = new Map();
    let altArmed = false;
    const bar = {
      el,
      defs,
      buttons,
      open(id, { keyboard = false } = {}) {
        const def = defs.find((d) => d.id === id);
        const btn = buttons.get(id);
        if (!def || !btn) return;
        const ae = document.activeElement;
        const restore = menus.session?.restore || (!ae || ae === document.body || el.contains(ae) ? restoreFocus?.() : ae);
        menus.close(null, { restoreFocus: false });
        bar.hideTips();
        btn.classList.add('open');
        btn.setAttribute('aria-expanded', 'true');
        const r = btn.getBoundingClientRect();
        new Promise((resolve) => {
          menus._begin({ resolve, restore, bar, barId: id, keyboard });
          menus._openLevel(def.items(), { x: r.left, y: r.bottom + 2, anchor: r }, 0, { keyboard });
        });
      },
      step(dir, keyboard) {
        const id = menus.session?.barId;
        const i = defs.findIndex((d) => d.id === id);
        const next = defs[(i + dir + defs.length) % defs.length];
        bar.open(next.id, { keyboard });
      },
      focusButton(id) {
        const btn = buttons.get(id) || buttons.get(defs[0].id);
        el.classList.add('kbd');
        btn?.focus({ preventScroll: true });
      },
      enterKeyboard() {
        el.classList.add('kbd', 'keytips');
        buttons.get(defs[0].id)?.focus({ preventScroll: true });
      },
      hideTips() {
        el.classList.remove('keytips');
      },
      leave() {
        el.classList.remove('kbd', 'keytips');
        const target = restoreFocus?.();
        if (target?.isConnected) target.focus({ preventScroll: true });
      },
      relabel() {
        for (const d of defs) {
          const b = buttons.get(d.id);
          if (!b) continue;
          b.querySelector('.np-menu-label').textContent = d.label();
          b.querySelector('.np-keytip').textContent = d.key();
        }
      },
      // Alt pressed and released on its own toggles the key tips (like Windows).
      altDown() {
        altArmed = true;
      },
      altCancel() {
        altArmed = false;
      },
      altUp() {
        if (!altArmed) return false;
        altArmed = false;
        if (menus.session) {
          menus.close();
          return true;
        }
        if (el.classList.contains('keytips') || el.contains(document.activeElement)) bar.leave();
        else bar.enterKeyboard();
        return true;
      },
      accessKey(ch) {
        const c = String(ch || '').toLocaleLowerCase();
        const def = defs.find((d) => d.key().toLocaleLowerCase() === c);
        if (def) bar.open(def.id, { keyboard: true });
        return !!def;
      },
      _closed(id) {
        const btn = buttons.get(id);
        btn?.classList.remove('open');
        btn?.setAttribute('aria-expanded', 'false');
      },
    };
    for (const d of defs) {
      const btn = h(
        'button',
        { type: 'button', class: 'np-menu-btn', role: 'menuitem', 'aria-haspopup': 'menu', 'aria-expanded': 'false', tabindex: '-1', dataset: { menu: d.id } },
        h('span', { class: 'np-menu-label' }, d.label()),
        h('span', { class: 'np-keytip', 'aria-hidden': 'true' }, d.key()),
      );
      btn.addEventListener('mousedown', (e) => e.preventDefault()); // keep the caret in the editor
      btn.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        if (menus.session?.bar === bar && menus.session.barId === d.id) menus.close();
        else bar.open(d.id, { keyboard: false });
      });
      btn.addEventListener('pointerenter', () => {
        if (menus.session?.bar === bar && menus.session.barId !== d.id) bar.open(d.id, { keyboard: false });
      });
      btn.addEventListener('keydown', (e) => {
        const ids = defs.map((x) => x.id);
        const i = ids.indexOf(d.id);
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault();
          bar.hideTips();
          buttons.get(ids[(i + (e.key === 'ArrowRight' ? 1 : -1) + ids.length) % ids.length]).focus();
        } else if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
          e.preventDefault();
          bar.open(d.id, { keyboard: true });
        } else if (e.key === 'Escape' || e.key === 'Tab') {
          e.preventDefault();
          bar.leave();
        } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          bar.accessKey(e.key);
        }
      });
      btn.addEventListener('blur', () => {
        setTimeout(() => {
          if (!el.contains(document.activeElement)) el.classList.remove('kbd', 'keytips');
        });
      });
      buttons.set(d.id, btn);
      el.appendChild(btn);
    }
    return bar;
  }
}
