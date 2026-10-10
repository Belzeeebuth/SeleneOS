// Motion helpers (transform / opacity only; everything is skipped when animations are off).
export const EASE = 'cubic-bezier(0.1, 0.9, 0.2, 1)';
export const EASE_IN = 'cubic-bezier(0.7, 0, 1, 0.5)';
export const reduceMotion = () => document.documentElement.dataset.animations === 'off';

/** FLIP: remember where `els` are, run `mutate`, then slide them from their old to their new place. */
export function flip(els, mutate, { duration = 250 } = {}) {
  const first = new Map();
  if (!reduceMotion()) for (const e of els) if (e.isConnected) first.set(e, e.getBoundingClientRect());
  mutate();
  for (const [e, r] of first) {
    if (!e.isConnected) continue;
    const n = e.getBoundingClientRect();
    const dx = r.left - n.left;
    const dy = r.top - n.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
    e.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration, easing: EASE });
  }
}

/** Keyed FLIP for re-rendered lists: snapshot rects by data-id before, animate the new nodes after. */
export function snapshot(container, sel = '[data-id]') {
  const map = new Map();
  if (reduceMotion() || !container) return map;
  const box = container.getBoundingClientRect();
  for (const el of container.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (r.bottom < box.top - 200 || r.top > box.bottom + 200) continue; // off-screen rows: no animation
    map.set(el.dataset.id, r);
  }
  return map;
}

export function playFlip(container, before, { sel = '[data-id]', enter = true, duration = 280 } = {}) {
  if (reduceMotion() || !container) return;
  const box = container.getBoundingClientRect();
  for (const el of container.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (r.bottom < box.top || r.top > box.bottom) continue;
    const old = before.get(el.dataset.id);
    if (old) {
      const dy = old.top - r.top;
      if (Math.abs(dy) >= 1) el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration, easing: EASE });
    } else if (enter && before.size) {
      el.animate([{ opacity: 0, transform: 'translateY(-6px) scale(0.98)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: EASE });
    }
  }
}

export function fadeIn(el, { y = 12, duration = 250 } = {}) {
  if (reduceMotion() || !el) return;
  el.animate([{ opacity: 0, transform: `translateY(${y}px)` }, { opacity: 1, transform: 'none' }], { duration, easing: EASE });
}
