// Pointer-driven drag & drop used for task rows, steps and lists in the nav:
//   beginDrag(pointerdownEvent, { el, host, scroller, makeGhost, onStart, onMove(x, y), onDrop(x, y) -> DOMRect?, onCancel })
// The drag starts after a 6 px move; a floating ghost (pointer-events: none) follows the pointer inside `host`
// (a positioned element of the app, so it keeps the app's theme); the scroller auto-scrolls near its edges;
// Escape cancels; the click that follows a drag is swallowed. onDrop may return a rect for the ghost to land on.
import { EASE, flip, reduceMotion } from './anim.js';

let active = null;
export const isDragging = () => !!active;

export function beginDrag(e, opts) {
  if (e.button !== 0 || active) return;
  const { el, host } = opts;
  const pid = e.pointerId;
  const sx = e.clientX;
  const sy = e.clientY;
  let started = false;
  let ghost = null;
  let offX = 0;
  let offY = 0;
  let last = { x: sx, y: sy };
  let raf = 0;

  const place = () => {
    if (!ghost) return;
    const hr = host.getBoundingClientRect();
    ghost.style.transform = `translate(${last.x - hr.left - offX}px, ${last.y - hr.top - offY}px) rotate(${opts.tilt ?? 0}deg)`;
  };
  const loop = () => {
    raf = requestAnimationFrame(loop);
    const sc = opts.scroller;
    if (!sc) return;
    const r = sc.getBoundingClientRect();
    let dv = 0;
    if (last.y < r.top + 36 && last.y > r.top - 60) dv = -Math.ceil((r.top + 36 - last.y) / 4);
    else if (last.y > r.bottom - 36 && last.y < r.bottom + 60) dv = Math.ceil((last.y - (r.bottom - 36)) / 4);
    if (dv && last.x >= r.left && last.x <= r.right) {
      const before = sc.scrollTop;
      sc.scrollTop += dv;
      if (sc.scrollTop !== before) opts.onMove?.(last.x, last.y);
    }
  };
  const start = () => {
    started = true;
    active = opts;
    const r = el.getBoundingClientRect();
    const hr = host.getBoundingClientRect();
    offX = Math.min(sx - r.left, r.width);
    offY = sy - r.top;
    ghost = opts.makeGhost ? opts.makeGhost(el) : el.cloneNode(true);
    ghost.classList.add('td-ghost');
    ghost.removeAttribute('id');
    Object.assign(ghost.style, { position: 'absolute', left: '0', top: '0', width: `${Math.min(r.width, hr.width)}px`, pointerEvents: 'none', zIndex: '60', margin: '0' });
    host.appendChild(ghost);
    host.classList.add('td-drag-active');
    place();
    if (!reduceMotion()) ghost.animate([{ opacity: 0.6, scale: '1' }, { opacity: 1, scale: '1.02' }], { duration: 150, easing: EASE, fill: 'forwards' });
    opts.onStart?.();
    raf = requestAnimationFrame(loop);
  };
  const move = (ev) => {
    if (ev.pointerId !== pid) return;
    last = { x: ev.clientX, y: ev.clientY };
    if (!started) {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < (opts.threshold ?? 6)) return;
      start();
    }
    ev.preventDefault();
    place();
    opts.onMove?.(ev.clientX, ev.clientY);
  };
  const finish = (dropped, ev) => {
    window.removeEventListener('pointermove', move, true);
    window.removeEventListener('pointerup', up, true);
    window.removeEventListener('pointercancel', cancel, true);
    window.removeEventListener('keydown', key, true);
    cancelAnimationFrame(raf);
    if (!started) return;
    swallowClick();
    host.classList.remove('td-drag-active');
    active = null;
    let land = null;
    try {
      land = dropped ? opts.onDrop?.(ev.clientX, ev.clientY) : (opts.onCancel?.(), null);
    } catch (err) {
      console.error('[todo] drop failed', err);
    }
    const g = ghost;
    ghost = null;
    if (!g) return;
    if (land && !reduceMotion()) {
      const hr = host.getBoundingClientRect();
      const to = `translate(${land.left - hr.left}px, ${land.top - hr.top}px)`;
      g.getAnimations().forEach((a) => a.cancel());
      g.animate([{ transform: g.style.transform, scale: '1.02' }, { transform: to, scale: '1' }], { duration: 160, easing: EASE }).finished.then(() => g.remove(), () => g.remove());
    } else if (!reduceMotion()) {
      g.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120 }).finished.then(() => g.remove(), () => g.remove());
    } else g.remove();
  };
  const up = (ev) => ev.pointerId === pid && finish(true, ev);
  const cancel = (ev) => ev.pointerId === pid && finish(false, ev);
  const key = (ev) => {
    if (ev.key !== 'Escape' || !started) return;
    ev.preventDefault();
    ev.stopPropagation();
    finish(false, ev);
  };
  window.addEventListener('pointermove', move, true);
  window.addEventListener('pointerup', up, true);
  window.addEventListener('pointercancel', cancel, true);
  window.addEventListener('keydown', key, true);
}

function swallowClick() {
  const stop = (e) => {
    e.stopPropagation();
    e.preventDefault();
  };
  window.addEventListener('click', stop, true);
  setTimeout(() => window.removeEventListener('click', stop, true), 0);
}

/** Move `el` inside `container` to the slot under clientY (siblings slide with FLIP). -> true if it moved */
export function liveReorder(container, el, y, sel) {
  const items = [...container.querySelectorAll(`:scope > ${sel}`)];
  const others = items.filter((x) => x !== el);
  let before = null;
  for (const it of others) {
    const r = it.getBoundingClientRect();
    if (y < r.top + r.height / 2) {
      before = it;
      break;
    }
  }
  const curNext = items[items.indexOf(el) + 1] || null;
  if (before === curNext) return false;
  if (!before && items[items.length - 1] === el) return false;
  flip(others, () => container.insertBefore(el, before), { duration: 200 });
  return true;
}
