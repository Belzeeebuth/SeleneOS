// Is anybody looking at the desktop? It is "quiet" while the screen is turned off by the power settings
// (features/power.js: 'screen-off') or locked ('locked'). Background refreshes skip their work then: the tray's
// safety re-sync, the taskbar meters, Alt+Tab thumbnails, the animated wallpaper.
//   quiet.on            -> true while any reason holds
//   quiet.set(reason, on)   quiet.onChange(fn(on))  -> unsubscribe
const reasons = new Set();
const listeners = new Set();
export const quiet = {
  get on() {
    return reasons.size > 0;
  },
  has: (reason) => reasons.has(reason),
  set(reason, on) {
    const was = reasons.size > 0;
    if (on) reasons.add(reason);
    else reasons.delete(reason);
    if (was === reasons.size > 0) return;
    for (const fn of listeners) {
      try {
        fn(reasons.size > 0);
      } catch {}
    }
  },
  onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
