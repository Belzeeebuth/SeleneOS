// Focus mode (docs/PERSONALIZATION.md §10.3). Settings key:
//   focusMode { active, hideNotifications, dimDesktop, dimLevel (0–100), simplifyTaskbar, duration (minutes, 0 = until off) }
// While active (all live, each part optional):
//   hideNotifications  -> <html data-focus-quiet="on">: toasts and sounds suppressed (core/notify.js), kept in the
//                         notification center; the bell shows the "snoozed" glyph. Alarms (urgent) still ring.
//   dimDesktop         -> <html data-focus-dim="on"> + --focus-dim: a black veil over the wallpaper and desktop icons
//                         (windows stay bright) — core/shell-personalize.css
//   simplifyTaskbar    -> <html data-focus-simple="on">: no search / task view / widgets / mini widgets, running apps only
//   duration           -> ends by itself; the tray shows the time left (taskbar.setStatusItem('focus'))
// `active` is runtime state: it is never saved in profiles, and a new session starts with Focus mode off.
// Shell events: 'focus:start' ({ minutes }?), 'focus:stop', 'focus:toggle'; emits 'focus:changed' { active, endsAt }.
// window.__aurora.focus = shell.focus = { start(minutes?), stop(), toggle(), get state() } ; hotkey Super+Shift+F
// (customizable: core/shortcuts.js action 'focusMode').
import { api } from '../api.js';

const STRINGS = {
  en: {
    focus: {
      on: 'Focus',
      left: '{min} min',
      tipUntilOff: 'Focus mode is on\nSelect to turn it off',
      tipLeft: 'Focus mode: {min} min left\nSelect to end the session',
      ended: 'Focus session complete',
      endedBody: 'Nice work! Notifications are back.',
      end: 'End focus session',
      settings: 'Focus settings',
    },
  },
  fr: {
    focus: {
      on: 'Concentration',
      left: '{min} min',
      tipUntilOff: 'Le mode concentration est activé\nSélectionnez pour le désactiver',
      tipLeft: 'Mode concentration : {min} min restantes\nSélectionnez pour terminer la session',
      ended: 'Session de concentration terminée',
      endedBody: 'Beau travail ! Les notifications sont de retour.',
      end: 'Terminer la session de concentration',
      settings: 'Paramètres de concentration',
    },
  },
};

const DEFAULTS = { active: false, hideNotifications: true, dimDesktop: true, dimLevel: 40, simplifyTaskbar: true, duration: 0 };

export function mount(ctx) {
  const { settings, shell, taskbar, i18n, t, ui } = ctx;
  i18n.extend(STRINGS);
  const root = document.documentElement;
  const cfg = () => ({ ...DEFAULTS, ...(settings.get('focusMode') || {}) });
  let endsAt = 0;
  let endTimer = 0;
  let tick = 0;
  let explicit = false; // start(minutes) chose the length itself (0 = until turned off)

  // The veil over the desktop (wallpaper + icons); windows live above #desktop and stay bright.
  const dim = document.createElement('div');
  dim.className = 'focus-dim';
  dim.setAttribute('aria-hidden', 'true');
  document.getElementById('desktop')?.appendChild(dim);

  const minutesLeft = () => Math.max(1, Math.ceil((endsAt - Date.now()) / 60000));
  function paintPill() {
    const c = cfg();
    if (!c.active) {
      taskbar.setStatusItem?.('focus', null);
      return;
    }
    taskbar.setStatusItem?.('focus', {
      icon: 'target',
      text: endsAt ? t('focus.left', { min: minutesLeft() }) : t('focus.on'),
      tip: endsAt ? t('focus.tipLeft', { min: minutesLeft() }) : t('focus.tipUntilOff'),
      onClick: (e) =>
        ui.menu(e.currentTarget, [
          { label: t('focus.end'), icon: 'dismiss', action: () => stop() },
          { label: t('focus.settings'), icon: 'settings', action: () => shell.launch('settings', { page: 'focus' }) },
        ], { above: (root.dataset.tbPos || 'bottom') === 'bottom' }),
    });
  }

  function apply() {
    const c = cfg();
    const on = !!c.active;
    const set = (name, v) => (v ? (root.dataset[name] = 'on') : delete root.dataset[name]);
    set('focus', on);
    set('focusQuiet', on && c.hideNotifications !== false);
    set('focusDim', on && c.dimDesktop !== false);
    set('focusSimple', on && c.simplifyTaskbar !== false);
    root.style.setProperty('--focus-dim', String(Math.max(0, Math.min(90, Number(c.dimLevel) || 0)) / 100));
    // timer: (re)armed when the session starts or its duration changes
    clearTimeout(endTimer);
    clearInterval(tick);
    if (on && endsAt) {
      endTimer = setTimeout(() => finish(), Math.max(0, endsAt - Date.now()));
      tick = setInterval(paintPill, 30000);
    }
    if (!on) endsAt = 0;
    paintPill();
    shell.emit('focus:changed', { active: on, endsAt: endsAt || null });
  }

  function start(minutes) {
    const c = cfg();
    const m = minutes != null && Number.isFinite(Number(minutes)) ? Number(minutes) : Number(c.duration) || 0;
    endsAt = m > 0 ? Date.now() + Math.min(1440, m) * 60000 : 0;
    explicit = true;
    if (c.active) return apply(); // already on: just restart the timer
    return settings.set('focusMode.active', true);
  }
  function stop() {
    endsAt = 0;
    return settings.set('focusMode.active', false);
  }
  async function finish() {
    await stop();
    shell.notify?.({ title: t('focus.ended'), body: t('focus.endedBody'), icon: 'target', appId: 'system' });
  }

  settings.on('focusMode', () => {
    const c = cfg();
    // turned on from elsewhere (a Settings switch, settings:set…): the configured duration applies
    if (c.active && !root.dataset.focus && !explicit) endsAt = Number(c.duration) > 0 ? Date.now() + Math.min(1440, Number(c.duration)) * 60000 : 0;
    explicit = false;
    apply();
  });
  i18n.on('change', paintPill);
  shell.on('focus:start', (arg) => start(typeof arg === 'number' ? arg : arg?.minutes));
  shell.on('focus:stop', () => stop());
  shell.on('focus:toggle', () => (cfg().active ? stop() : start()));

  // A new session starts with Focus mode off (it is runtime state).
  if (cfg().active) api.invoke('settings:set', 'focusMode.active', false).catch(() => {});
  else apply();

  ctx.focus = shell.focus = {
    start,
    stop,
    toggle: () => (cfg().active ? stop() : start()),
    get state() {
      const c = cfg();
      return { active: !!c.active, endsAt: endsAt || null, quiet: root.dataset.focusQuiet === 'on', dim: root.dataset.focusDim === 'on', simple: root.dataset.focusSimple === 'on' };
    },
  };
}
