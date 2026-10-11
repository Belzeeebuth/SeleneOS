// Focus mode (docs/PERSONALIZATION.md §10.3). Settings key:
//   focusMode { active, hideNotifications, dimDesktop, dimLevel (0–100), hideIcons, simplifyTaskbar,
//               duration (minutes, 0 = until off), endsAt (ms, 0 = until off), prevDnd (Do not disturb before) }
// While active (all live, each part optional):
//   hideNotifications  -> Do not disturb is turned on (notifications.dnd = true) and its previous value is put back
//                         when the session ends; also <html data-focus-quiet="on"> (core/notify.js: no banner, no sound,
//                         kept in the notification center; the bell shows the "snoozed" glyph). Alarms (urgent) still ring.
//   dimDesktop         -> <html data-focus-dim="on"> + --focus-dim: a black veil over the wallpaper and desktop icons
//                         (windows stay bright), faded in/out
//   hideIcons          -> <html data-focus-noicons="on">: the desktop icons fade away
//   simplifyTaskbar    -> <html data-focus-simple="on">: no search / task view / widgets / mini widgets, running apps only
//   duration           -> ends by itself; the tray chip shows the time left (taskbar.setStatusItem('focus')) and a
//                         notification says when it is over. endsAt is stored, so a session survives a restart of the shell
//                         (one that ended while the shell was not running is closed at start-up, everything restored).
// `active`, `endsAt` and `prevDnd` are runtime state: never saved in profiles (PROFILE_EXCLUDE).
// Shell events: 'focus:start' ({ minutes }?), 'focus:stop', 'focus:toggle'; emits 'focus:changed' { active, endsAt }.
// window.__aurora.focus = shell.focus = { start(minutes?), stop(), toggle(), get state() } ; hotkey Super+Shift+F
// (customizable: core/shortcuts.js action 'focusMode'). A banner shows when a session starts. Styles: focus.css.
import { api } from '../api.js';
import { icon } from '../ui.js';

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
      started: 'Focus session started',
      bannerUntil: 'Until {time}',
      bannerUntilOff: 'Until you turn it off',
      bannerQuiet: 'notifications silenced',
      add: 'Add {min} minutes',
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
      started: 'Session de concentration démarrée',
      bannerUntil: 'Jusqu’à {time}',
      bannerUntilOff: 'Jusqu’à ce que vous la terminiez',
      bannerQuiet: 'notifications en sourdine',
      add: 'Ajouter {min} minutes',
    },
  },
};

const DEFAULTS = { active: false, hideNotifications: true, dimDesktop: true, dimLevel: 40, hideIcons: false, simplifyTaskbar: true, duration: 0, endsAt: 0, prevDnd: null };
const MAX_MIN = 1440;

export function mount(ctx) {
  const { settings, shell, taskbar, i18n, t, ui, h } = ctx;
  i18n.extend(STRINGS);
  ui.loadCss('app://shell/core/features/focus.css');
  const root = document.documentElement;
  const cfg = () => ({ ...DEFAULTS, ...(settings.get('focusMode') || {}) });
  const reduce = () => root.dataset.animations === 'off' || root.dataset.reducedMotion === 'on';
  let endTimer = 0;
  let tick = 0;
  let pending = false; // a start/stop write is on its way (its own settings change must not be handled twice)
  let banner = null;

  // The veil over the desktop (wallpaper + icons); windows live above #desktop and stay bright.
  const dim = document.createElement('div');
  dim.className = 'focus-dim';
  dim.setAttribute('aria-hidden', 'true');
  document.getElementById('desktop')?.appendChild(dim);

  const endsAt = () => Number(cfg().endsAt) || 0;
  const minutesLeft = () => Math.max(1, Math.ceil((endsAt() - Date.now()) / 60000));
  // like the taskbar clock: "1:48 AM" in English, "01:48" with a 24-hour clock
  const until = () => {
    const h24 = settings.get('clock24h');
    let two = !!h24;
    if (h24 == null) {
      try {
        two = ['h23', 'h24'].includes(new Intl.DateTimeFormat(i18n.locale, { hour: 'numeric' }).resolvedOptions().hourCycle);
      } catch {}
    }
    return i18n.formatTime(new Date(endsAt()), { hour: two ? '2-digit' : 'numeric', minute: '2-digit', ...(h24 != null ? { hour12: !h24 } : {}) });
  };

  function paintPill() {
    const c = cfg();
    if (!c.active) {
      taskbar.setStatusItem?.('focus', null);
      return;
    }
    const timed = endsAt() > 0;
    // (a vertical bar is 52–72 px wide: "Focus" / "Concentration" does not fit, the icon and the tooltip say it)
    const vertical = ['left', 'right'].includes(root.dataset.tbPos);
    taskbar.setStatusItem?.('focus', {
      icon: 'target',
      text: timed ? t('focus.left', { min: minutesLeft() }) : vertical ? '' : t('focus.on'),
      tip: timed ? t('focus.tipLeft', { min: minutesLeft() }) : t('focus.tipUntilOff'),
      onClick: (e) =>
        ui.menu(
          e.currentTarget,
          [
            { label: t('focus.end'), icon: 'dismiss', action: () => stop() },
            timed ? { label: t('focus.add', { min: 10 }), icon: 'add', action: () => extend(10) } : null,
            { label: t('focus.settings'), icon: 'settings', action: () => shell.launch('settings', { page: 'focus' }) },
          ].filter(Boolean),
          { above: (root.dataset.tbPos || 'bottom') === 'bottom' },
        ),
    });
  }

  function apply() {
    const c = cfg();
    const on = !!c.active;
    const set = (name, v) => (v ? (root.dataset[name] = 'on') : delete root.dataset[name]);
    set('focus', on);
    // (Do not disturb turned off by hand during a session — Quick settings — lets notifications through again)
    set('focusQuiet', on && c.hideNotifications !== false && (c.prevDnd === null || !!settings.get('notifications.dnd')));
    set('focusDim', on && c.dimDesktop !== false);
    set('focusNoicons', on && c.hideIcons === true);
    set('focusSimple', on && c.simplifyTaskbar !== false);
    root.style.setProperty('--focus-dim', String(Math.max(0, Math.min(90, Number(c.dimLevel) || 0)) / 100));
    clearTimeout(endTimer);
    clearInterval(tick);
    if (on && endsAt()) {
      // (long sessions: re-armed every ≤ 6 h, setTimeout cannot wait longer than ~24.8 days anyway)
      endTimer = setTimeout(() => (endsAt() <= Date.now() + 500 ? finish() : apply()), Math.max(0, Math.min(6 * 3600e3, endsAt() - Date.now())));
      // (timers stand still while the machine sleeps: the wall clock is checked on every tick too)
      tick = setInterval(() => (endsAt() && endsAt() <= Date.now() ? finish() : paintPill()), 30000);
    }
    if (!on) hideBanner();
    paintPill();
    shell.emit('focus:changed', { active: on, endsAt: on ? endsAt() || null : null });
  }

  /** The settings that start a session: Do not disturb is saved and turned on when notifications are hidden. */
  function startPatch(minutes) {
    const c = cfg();
    const m = minutes != null && Number.isFinite(Number(minutes)) ? Number(minutes) : Number(c.duration) || 0;
    const patch = { 'focusMode.active': true, 'focusMode.endsAt': m > 0 ? Date.now() + Math.min(MAX_MIN, m) * 60000 : 0 };
    if (c.hideNotifications !== false && !(c.active && c.prevDnd !== null)) {
      patch['focusMode.prevDnd'] = !!settings.get('notifications.dnd');
      patch['notifications.dnd'] = true;
    }
    return patch;
  }
  function stopPatch() {
    const c = cfg();
    const patch = { 'focusMode.active': false, 'focusMode.endsAt': 0, 'focusMode.prevDnd': null };
    if (c.prevDnd !== null && c.prevDnd !== undefined) patch['notifications.dnd'] = !!c.prevDnd;
    return patch;
  }
  async function write(patch) {
    pending = true;
    try {
      await api.invoke('settings:setMany', patch);
    } finally {
      pending = false;
    }
    apply();
  }
  async function start(minutes) {
    const was = cfg().active;
    await write(startPatch(minutes));
    if (!was || minutes != null) showBanner();
  }
  function stop() {
    if (!cfg().active && cfg().prevDnd === null) return Promise.resolve();
    return write(stopPatch());
  }
  function extend(min) {
    if (!cfg().active || !endsAt()) return Promise.resolve();
    return write({ 'focusMode.endsAt': endsAt() + min * 60000 });
  }
  let finishing = false;
  async function finish() {
    if (finishing || !cfg().active) return; // (the end timer and the tick can both see the end time pass)
    finishing = true;
    try {
      await stop();
    } finally {
      finishing = false;
    }
    shell.notify?.({ title: t('focus.ended'), body: t('focus.endedBody'), icon: 'target', appId: 'system' });
  }

  // A short banner when a session starts: what Focus mode does and until when.
  function hideBanner() {
    if (!banner) return;
    const b = banner;
    banner = null;
    clearTimeout(b._timer);
    if (reduce()) b.remove();
    else {
      b.classList.add('leaving');
      setTimeout(() => b.remove(), 220);
    }
  }
  function showBanner() {
    hideBanner();
    const c = cfg();
    if (!c.active || document.querySelector('#start.open, #search-panel.open, #widgets-board.open')) return;
    const parts = [endsAt() ? t('focus.bannerUntil', { time: until() }) : t('focus.bannerUntilOff')];
    if (c.hideNotifications !== false) parts.push(t('focus.bannerQuiet'));
    banner = h(
      'div',
      { class: 'focus-banner', role: 'status', onclick: () => hideBanner() },
      h('span', { class: 'focus-banner-icon' }, icon('target', { size: 20 })),
      h('div', { class: 'focus-banner-text' }, h('div', { class: 'focus-banner-title' }, t('focus.started')), h('div', { class: 'focus-banner-sub' }, parts.join(' · '))),
    );
    (document.getElementById('overlays') || document.body).appendChild(banner);
    banner._timer = setTimeout(hideBanner, 3600);
  }

  let last = cfg();
  settings.on('focusMode', () => {
    const c = cfg();
    const prev = last;
    last = c;
    if (pending) return; // our own write: applied when it resolves
    // Turned on from elsewhere (a Settings switch, settings:set…): the configured length and Do not disturb apply.
    if (c.active && !prev.active && !c.endsAt && c.prevDnd === null) return void write(startPatch()).then(showBanner);
    if (!c.active && prev.active && c.prevDnd !== null) return void write(stopPatch());
    // "Hide notifications" changed during a session: Do not disturb follows it.
    if (c.active && prev.active && c.hideNotifications !== prev.hideNotifications) {
      if (c.hideNotifications === false && c.prevDnd !== null) return void write({ 'notifications.dnd': !!c.prevDnd, 'focusMode.prevDnd': null });
      if (c.hideNotifications !== false && c.prevDnd === null) return void write({ 'focusMode.prevDnd': !!settings.get('notifications.dnd'), 'notifications.dnd': true });
    }
    apply();
  });
  i18n.on('change', paintPill);
  shell.on('taskbar:layout', () => cfg().active && paintPill());
  settings.on('notifications', () => cfg().active && apply());
  shell.on('focus:start', (arg) => start(typeof arg === 'number' ? arg : arg?.minutes));
  shell.on('focus:stop', () => stop());
  shell.on('focus:toggle', () => (cfg().active ? stop() : start()));
  shell.on('lock', hideBanner);
  // Start, Search and the Widgets board reach the top of the screen: the banner gives way instead of covering them.
  shell.on('flyouts:close', (a) => ['start', 'search', 'widgets'].includes(a?.except) && hideBanner());

  // A session survives a restart of the shell; one whose time ran out meanwhile is closed (everything restored).
  const c0 = cfg();
  if (c0.active && endsAt() && endsAt() <= Date.now()) finish();
  else if (!c0.active && c0.prevDnd !== null) write(stopPatch()); // interrupted while ending: restore Do not disturb
  else apply();

  ctx.focus = shell.focus = {
    start,
    stop,
    extend,
    toggle: () => (cfg().active ? stop() : start()),
    get state() {
      const c = cfg();
      return {
        active: !!c.active,
        endsAt: c.active ? endsAt() || null : null,
        quiet: root.dataset.focusQuiet === 'on',
        dim: root.dataset.focusDim === 'on',
        noIcons: root.dataset.focusNoicons === 'on',
        simple: root.dataset.focusSimple === 'on',
      };
    },
  };
}
