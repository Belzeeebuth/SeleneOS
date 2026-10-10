// Pointer tracking for click / drag gestures in the calendar views.
//   track(downEvent, { threshold, onStart(e), onMove(e), onEnd(e), onCancel(), onClick(e) })
// A gesture is a click until the pointer moves `threshold` px; Esc or window blur cancels a drag.
// While dragging, <body> gets .ac-dragging (cursor + no text selection).
let active = null;

export function track(down, { threshold = 4, onStart, onMove, onEnd, onCancel, onClick, cursor = 'grabbing' } = {}) {
  if (down.button !== 0 || active) return;
  const x0 = down.clientX;
  const y0 = down.clientY;
  let dragging = false;
  const cleanup = () => {
    window.removeEventListener('pointermove', move, true);
    window.removeEventListener('pointerup', up, true);
    window.removeEventListener('pointercancel', cancel, true);
    window.removeEventListener('blur', cancel);
    document.removeEventListener('keydown', key, true);
    document.body.classList.remove('ac-dragging');
    document.body.style.removeProperty('--ac-drag-cursor');
    active = null;
  };
  const move = (e) => {
    if (!dragging) {
      if (Math.hypot(e.clientX - x0, e.clientY - y0) < threshold) return;
      dragging = true;
      document.body.classList.add('ac-dragging');
      document.body.style.setProperty('--ac-drag-cursor', cursor);
      onStart?.(e);
    }
    e.preventDefault();
    onMove?.(e);
  };
  const up = (e) => {
    const was = dragging;
    cleanup();
    if (was) onEnd?.(e);
    else onClick?.(e);
  };
  const cancel = () => {
    const was = dragging;
    cleanup();
    if (was) onCancel?.();
  };
  const key = (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    cancel();
  };
  window.addEventListener('pointermove', move, true);
  window.addEventListener('pointerup', up, true);
  window.addEventListener('pointercancel', cancel, true);
  window.addEventListener('blur', cancel);
  document.addEventListener('keydown', key, true);
  active = { cancel };
}

export function cancelDrag() {
  active?.cancel();
}

// Scroll a container while the pointer is held near its top / bottom edge.
export function autoScroller(scrollEl, onScroll) {
  let raf = 0;
  let speed = 0;
  const loop = () => {
    if (!speed) {
      raf = 0;
      return;
    }
    const before = scrollEl.scrollTop;
    scrollEl.scrollTop += speed;
    if (scrollEl.scrollTop !== before) onScroll?.();
    raf = requestAnimationFrame(loop);
  };
  return {
    update(clientY) {
      const r = scrollEl.getBoundingClientRect();
      const zone = 36;
      if (clientY < r.top + zone) speed = -Math.ceil((r.top + zone - clientY) / 3);
      else if (clientY > r.bottom - zone) speed = Math.ceil((clientY - (r.bottom - zone)) / 3);
      else speed = 0;
      speed = Math.max(-24, Math.min(24, speed));
      if (speed && !raf) raf = requestAnimationFrame(loop);
    },
    stop() {
      speed = 0;
      cancelAnimationFrame(raf);
      raf = 0;
    },
  };
}
