// Light-dismiss flyouts (colour palettes, link card, emoji grid) placed inside the app window, so they
// inherit the window's per-app theme. Closes on Esc, outside click, window blur or another popover.
let current = null;

export function closePopover() {
  current?.close();
}

export function popover(win, anchor, content, { className, onClose, focus = true, placement = 'below', role = 'dialog', label, keepOnScroll = false } = {}) {
  current?.close();
  const el = document.createElement('div');
  el.className = `nt-pop${className ? ` ${className}` : ''}`;
  el.setAttribute('role', role);
  if (label) el.setAttribute('aria-label', label);
  el.tabIndex = -1;
  el.appendChild(content);
  win.el.appendChild(el);
  const place = () => {
    const wr = win.el.getBoundingClientRect();
    const ar = anchor instanceof Element ? anchor.getBoundingClientRect() : anchor;
    const pr = el.getBoundingClientRect();
    let x = ar.left - wr.left;
    let y = placement === 'above' ? ar.top - wr.top - pr.height - 6 : ar.bottom - wr.top + 6;
    if (y + pr.height > wr.height - 8) y = Math.max(8, ar.top - wr.top - pr.height - 6);
    if (y < 8) y = 8;
    x = Math.max(8, Math.min(x, wr.width - pr.width - 8));
    el.style.left = `${Math.round(x)}px`;
    el.style.top = `${Math.round(y)}px`;
  };
  place();
  const opener = document.activeElement;
  let closed = false;
  const outside = (e) => {
    if (!el.contains(e.target) && !(anchor instanceof Element && anchor.contains(e.target))) handle.close();
  };
  const keys = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      handle.close({ restoreFocus: true });
    }
  };
  const blur = () => handle.close();
  const scroll = (e) => {
    if (!keepOnScroll && !el.contains(e.target)) handle.close();
  };
  const handle = {
    el,
    place,
    get closed() {
      return closed;
    },
    close({ restoreFocus = false } = {}) {
      if (closed) return;
      closed = true;
      if (current === handle) current = null;
      document.removeEventListener('pointerdown', outside, true);
      el.removeEventListener('keydown', keys);
      window.removeEventListener('blur', blur);
      document.removeEventListener('scroll', scroll, true);
      el.classList.add('closing');
      setTimeout(() => el.remove(), 120);
      if (restoreFocus && opener?.isConnected) opener.focus?.({ preventScroll: true });
      onClose?.();
    },
  };
  el.addEventListener('keydown', keys);
  setTimeout(() => {
    if (closed) return;
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('blur', blur);
    document.addEventListener('scroll', scroll, true);
  });
  if (focus) (el.querySelector('[autofocus], input, button:not([disabled])') || el).focus({ preventScroll: true });
  current = handle;
  return handle;
}

/** Arrow-key navigation between buttons of a grid / row (roving focus). */
export function arrowNav(container, selector = 'button', { columns = 0 } = {}) {
  container.addEventListener('keydown', (e) => {
    const items = [...container.querySelectorAll(selector)].filter((b) => !b.disabled && b.offsetParent !== null);
    const i = items.indexOf(document.activeElement);
    if (i < 0) return;
    let j = i;
    if (e.key === 'ArrowRight') j = i + 1;
    else if (e.key === 'ArrowLeft') j = i - 1;
    else if (e.key === 'ArrowDown') j = columns ? i + columns : i + 1;
    else if (e.key === 'ArrowUp') j = columns ? i - columns : i - 1;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = items.length - 1;
    else return;
    e.preventDefault();
    e.stopPropagation();
    j = Math.max(0, Math.min(items.length - 1, j));
    items[j].focus();
  });
}
