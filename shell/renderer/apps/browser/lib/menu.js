// Aurora Browser — Fluent menus that can show favicons (favorites folders, "…" menu) and
// anchored flyouts (favorite editor, downloads, site info, permission bubble, zoom).
// Menus live in document.body (they may overflow the window, like real context menus);
// flyouts live inside the window body so they move with it.
import { h, icon } from './dom.js';

const open = []; // stack of { el, close } for the current menu tree
let restoreFocus = null; // a page (<webview>) that had the keyboard focus when the menu opened

export function closeMenus() {
  while (open.length) open.pop().destroy();
  const back = restoreFocus;
  restoreFocus = null;
  const ae = document.activeElement;
  if (back?.isConnected && (!ae || ae === document.body)) back.focus();
}

export function menusOpen() {
  return open.length > 0;
}

function itemIcon(it) {
  if (it.img) return h('img', { class: 'bw-menu-img', src: it.img, alt: '', draggable: false });
  if (it.icon) return icon(it.icon, { filled: it.iconFilled });
  return h('span', { class: 'icon' });
}

/**
 * showMenu(at, items, { className, align: 'left'|'right' })
 *   at: Element (anchored below) | {x, y} | MouseEvent
 *   item: { label, icon, img, shortcut, action, disabled, checked, danger, submenu: [] | () => [], custom: Element, keepOpen }
 */
export function showMenu(at, items, opts = {}) {
  closeMenus();
  const prev = document.activeElement;
  const root = build(at, items, opts, 0);
  // Opened from the keyboard while a page has the focus (e.g. Alt+F): keys must reach the menu.
  if (prev?.tagName === 'WEBVIEW') {
    restoreFocus = prev;
    root.el.focus({ preventScroll: true });
  }
  setTimeout(() => {
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('blur', closeMenus);
    document.addEventListener('keydown', keys, true);
  });
  return root;
}

function outside(e) {
  if (!open.some((m) => m.el.contains(e.target))) {
    closeMenus();
    cleanup();
  }
}
function cleanup() {
  document.removeEventListener('pointerdown', outside, true);
  window.removeEventListener('blur', closeMenus);
  document.removeEventListener('keydown', keys, true);
}

function keys(e) {
  const top = open[open.length - 1];
  if (!top) return cleanup();
  if (e.target?.closest?.('.bw-menu input')) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeMenus();
      cleanup();
    }
    return;
  }
  const rows = top.rows.filter((r) => !r.it.disabled);
  const cur = rows.findIndex((r) => r.el.classList.contains('active'));
  const set = (i) => {
    top.rows.forEach((r) => r.el.classList.remove('active'));
    if (rows[i]) {
      rows[i].el.classList.add('active');
      rows[i].el.scrollIntoView({ block: 'nearest' });
    }
  };
  if (e.key === 'ArrowDown') set(cur < 0 ? 0 : (cur + 1) % rows.length);
  else if (e.key === 'ArrowUp') set(cur < 0 ? rows.length - 1 : (cur - 1 + rows.length) % rows.length);
  else if (e.key === 'Home') set(0);
  else if (e.key === 'End') set(rows.length - 1);
  else if ((e.key === 'Enter' || e.key === ' ') && cur >= 0) rows[cur].activate(true);
  else if (e.key === 'ArrowRight' && cur >= 0 && rows[cur].it.submenu) rows[cur].activate(true);
  else if (e.key === 'ArrowLeft' && open.length > 1) open.pop().destroy();
  else if (e.key === 'Escape') {
    if (open.length > 1) open.pop().destroy();
    else {
      closeMenus();
      cleanup();
    }
  } else if (e.key === 'Tab') {
    closeMenus();
    cleanup();
    return;
  } else return;
  e.preventDefault();
  e.stopPropagation();
}

function build(at, items, opts, level) {
  const el = h('div', { class: ['menu', 'bw-menu', 'app-browser', opts.className], role: 'menu', tabindex: '-1' });
  const rows = [];
  const list = typeof items === 'function' ? items() : items;
  const hasIcons = list.some((i) => i && i !== '-' && (i.icon || i.img));
  for (const it of list) {
    if (!it || it.hidden) continue;
    if (it === '-' || it.separator) {
      el.appendChild(h('div', { class: 'menu-sep' }));
      continue;
    }
    if (it.header) {
      el.appendChild(h('div', { class: 'menu-header' }, it.header));
      continue;
    }
    if (it.custom) {
      el.appendChild(it.custom);
      continue;
    }
    if (it.empty) {
      el.appendChild(h('div', { class: 'menu-item disabled bw-menu-empty' }, h('span', { class: 'label' }, it.empty)));
      continue;
    }
    const row = h(
      'div',
      { class: ['menu-item', it.disabled && 'disabled', it.danger && 'danger'], role: 'menuitem', 'aria-disabled': it.disabled ? 'true' : null, title: it.title || null },
      it.checked !== undefined ? h('span', { class: 'check' }, it.checked ? icon('checkmark', { size: 16 }) : null) : null,
      hasIcons ? itemIcon(it) : null,
      h('span', { class: 'label' }, it.label),
      it.shortcut ? h('span', { class: 'shortcut' }, it.shortcut) : null,
      it.submenu ? icon('chevron_right', { size: 12 }) : null,
    );
    let subTimer = null;
    const openSub = (focus) => {
      while (open.length > level + 1) open.pop().destroy();
      const r = row.getBoundingClientRect();
      const sub = build({ x: r.right - 2, y: r.top - 5, sub: r }, it.submenu, opts, level + 1);
      if (focus) sub.rows.find((x) => !x.it.disabled)?.el.classList.add('active');
    };
    const activate = (fromKey) => {
      if (it.disabled) return;
      if (it.submenu) return openSub(fromKey);
      if (!it.keepOpen) {
        closeMenus();
        cleanup();
      }
      try {
        it.action?.();
      } catch (err) {
        console.error(err);
      }
    };
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      activate(false);
    });
    row.addEventListener('auxclick', (e) => {
      if (e.button === 1 && it.middle) {
        e.preventDefault();
        closeMenus();
        cleanup();
        it.middle();
      }
    });
    row.addEventListener('mouseenter', () => {
      rows.forEach((x) => x.el.classList.remove('active'));
      row.classList.add('active');
      clearTimeout(subTimer);
      if (it.submenu) subTimer = setTimeout(() => openSub(false), 180);
      else if (open.length > level + 1) subTimer = setTimeout(() => {
        while (open.length > level + 1) open.pop().destroy();
      }, 180);
    });
    rows.push({ el: row, it, activate });
    el.appendChild(row);
  }
  el.style.visibility = 'hidden';
  document.body.appendChild(el);
  const r = el.getBoundingClientRect();
  let x;
  let y;
  let anchor = null;
  if (at instanceof Element) {
    anchor = at.getBoundingClientRect();
    x = opts.align === 'right' ? anchor.right - r.width : anchor.left;
    y = anchor.bottom + 4;
  } else if (at && typeof at.clientX === 'number') {
    x = at.clientX;
    y = at.clientY;
  } else {
    x = at?.x ?? 0;
    y = at?.y ?? 0;
  }
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (x + r.width > vw - 4) x = at?.sub ? at.sub.left - r.width + 2 : vw - r.width - 4;
  if (y + r.height > vh - 4) {
    if (anchor && anchor.top - r.height - 4 > 4) {
      y = anchor.top - r.height - 4;
      el.classList.add('up');
    } else y = Math.max(4, vh - r.height - 4);
  }
  el.style.left = `${Math.max(4, x)}px`;
  el.style.top = `${Math.max(4, y)}px`;
  el.style.maxHeight = `${vh - 8}px`;
  el.style.visibility = '';
  const handle = {
    el,
    rows,
    destroy() {
      el.remove();
      if (level === 0) opts.onClose?.();
    },
    close() {
      closeMenus();
      cleanup();
    },
  };
  open.push(handle);
  return handle;
}

// ------------------------------------------------------------------ flyouts
/**
 * Flyout anchored to an element inside a window body.
 *   const f = flyout({ host: win.body, anchor, content, align: 'right', className, onClose, focus })
 *   f.close()
 */
export function flyout({ host, anchor, content, align = 'right', className, onClose, width, arrow = false }) {
  const el = h('div', { class: ['bw-flyout', className], role: 'dialog', tabindex: '-1' }, content);
  if (width) el.style.width = `${width}px`;
  host.appendChild(el);
  const place = () => {
    const hr = host.getBoundingClientRect();
    const ar = anchor.getBoundingClientRect();
    const fr = el.getBoundingClientRect();
    let left = align === 'right' ? ar.right - hr.left - fr.width : ar.left - hr.left;
    if (align === 'center') left = ar.left - hr.left + ar.width / 2 - fr.width / 2;
    left = Math.max(8, Math.min(left, hr.width - fr.width - 8));
    const top = ar.bottom - hr.top + 6;
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
    el.style.maxHeight = `${Math.max(120, hr.height - top - 12)}px`;
    if (arrow) el.style.setProperty('--arrow-x', `${Math.round(ar.left - hr.left + ar.width / 2 - left)}px`);
  };
  place();
  let closed = false;
  const outsideDown = (e) => {
    if (el.contains(e.target) || anchor.contains(e.target)) return;
    if (e.target.closest?.('.bw-menu, .menu, .dialog-layer')) return;
    close();
  };
  const esc = (e) => {
    if (e.key === 'Escape' && !e.defaultPrevented) {
      e.preventDefault();
      e.stopPropagation();
      close();
      anchor.focus?.();
    }
  };
  setTimeout(() => {
    if (closed) return;
    document.addEventListener('pointerdown', outsideDown, true);
  });
  el.addEventListener('keydown', esc);
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('pointerdown', outsideDown, true);
    el.classList.add('leaving');
    const done = () => el.remove();
    if (document.documentElement.dataset.animations === 'off') done();
    else setTimeout(done, 120);
    onClose?.();
  }
  return { el, close, place, get closed() {
    return closed;
  } };
}
