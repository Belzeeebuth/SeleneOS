// Settings > Personalization > Focus mode (docs/PERSONALIZATION.md §10.3, runtime: core/features/focus.js).
// Key: focusMode { active, hideNotifications, dimDesktop, dimLevel, hideIcons, simplifyTaskbar, duration, endsAt, prevDnd }.
// `active` / `endsAt` / `prevDnd` are the session's state (quick settings tile, Super+Shift+F, this page); the rest is what
// Focus mode does. The Clock app's focus sessions (storage clock/focus.json) are shown read-only, failure-proof.
import { liveSlider } from './personalization-designer.js';
import { setupShellPages, boundCombo, boundToggle } from './personalization-shell-kit.js';
import { PAGES } from '../lib/index.js';
import { comboKeys } from '../../../core/shortcuts.js';

const DURATIONS = [0, 15, 25, 30, 45, 50, 60, 90, 120];

/** Today's focus minutes and the running session of the Clock app (null when the app has no data). */
async function clockFocus(pc) {
  try {
    const f = await pc.api.invoke('storage:get', 'clock', 'focus', null);
    if (!f || typeof f !== 'object') return null;
    const d = new Date();
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const today = Number(f.history?.[key]) || 0;
    const st = f.status && typeof f.status === 'object' ? f.status : {};
    const endsAt = Number(st.endsAt) || 0;
    return { today: Math.max(0, Math.round(today)), running: !!st.active && st.state === 'running' && endsAt > Date.now(), paused: !!st.active && st.state === 'paused', left: endsAt ? Math.max(1, Math.ceil((endsAt - Date.now()) / 60000)) : 0 };
  } catch {
    return null;
  }
}

async function focus(pc) {
  setupShellPages(pc);
  const { h, t, kit, settings, shell } = pc;
  const active = () => !!settings.get('focusMode.active');
  const durLabel = (m) => (m ? t('pzs.minutes', { count: m }) : t('pzs.untilOff'));
  // "1:48 AM" / "01:48" (two-digit hours with a 24-hour clock, like the taskbar)
  const endTime = (ms) => {
    const locale = pc.lang === 'fr' ? 'fr-FR' : 'en-US';
    const h24 = settings.get('clock24h');
    const two = h24 != null ? !!h24 : ['h23', 'h24'].includes(new Intl.DateTimeFormat(locale, { hour: 'numeric' }).resolvedOptions().hourCycle);
    return new Intl.DateTimeFormat(locale, { hour: two ? '2-digit' : 'numeric', minute: '2-digit', ...(h24 != null ? { hour12: !h24 } : {}) }).format(new Date(ms));
  };

  // hero: state + start / stop
  const state = h('div', { class: 'body-strong pzs-focus-state' });
  const sub = h('div', { class: 'caption text-2 pzs-focus-sub' });
  const btn = kit.button('', () => (active() ? shell.emit('focus:stop') : shell.emit('focus:start')), { primary: true, className: 'pzs-focus-btn' });
  const ring = h('div', { class: 'pzs-focus-ring', 'aria-hidden': 'true' }, pc.icon('target', { size: 32 }));
  const paint = () => {
    const on = active();
    const st = shell.focus?.state || {};
    ring.classList.toggle('on', on);
    state.textContent = on ? t('pzs.focusOn') : t('pzs.focusOff');
    const left = on && st.endsAt ? Math.max(1, Math.ceil((st.endsAt - Date.now()) / 60000)) : 0;
    const ends = left ? ` · ${t('pzs.b2FocusEnds', { time: endTime(st.endsAt) })}` : '';
    sub.textContent = on ? (left ? `${t('pzs.focusLeft', { count: left })}${ends}` : t('pzs.focusUntilOff')) : t('pzs.focusIdle', { duration: durLabel(Number(settings.get('focusMode.duration')) || 0) });
    btn.replaceChildren(pc.icon(on ? 'stop' : 'play', { size: 16 }), h('span', null, on ? t('pzs.focusStop') : t('pzs.focusStart')));
    btn.dataset.active = String(on);
  };
  paint();
  pc.onDispose(settings.on('focusMode', paint));
  pc.onDispose(shell.on?.('focus:changed', paint));
  pc.every(20000, paint);
  const hero = h('div', { class: 'st-pers-hero pzs-hero pzs-focus-hero' }, ring, h('div', { class: 'pzs-hero-side' }, state, sub, h('div', { class: 'pzs-row-actions' }, btn)));

  const dim = liveSlider(pc, { key: 'focusMode.dimLevel', min: 0, max: 90, step: 5, def: 40, label: t('pzs.dimLevel') });
  const dimRow = kit.row({ icon: 'brightness_low', title: t('pzs.dimLevel'), desc: t('pzs.dimLevelDesc'), section: 'dimLevel', control: dim });
  const paintDim = () => dimRow.classList.toggle('pzs-dim', settings.get('focusMode.dimDesktop') === false);
  paintDim();
  pc.onDispose(settings.on('focusMode', paintDim));

  // Clock app focus sessions (optional integration: nothing breaks when the app or its data is missing)
  const clockDesc = h('span', null, t('pzs.b2ClockNone'));
  const clockRow = pc.shell.registry?.get?.('clock')
    ? kit.row({ icon: 'timer', title: t('pzs.b2ClockTitle'), desc: clockDesc, section: 'clock', control: kit.button(t('pzs.b2ClockOpen'), () => shell.launch('clock', { page: 'focus' }), { icon: 'open' }) })
    : null;
  const paintClock = async () => {
    if (!clockRow) return;
    const c = await clockFocus(pc);
    const lines = [];
    if (c?.running) lines.push(t('pzs.b2ClockRunning', { count: c.left }));
    else if (c?.paused) lines.push(t('pzs.b2ClockPaused'));
    if (c?.today) lines.push(t('pzs.b2ClockToday', { count: c.today }));
    clockDesc.textContent = lines.length ? lines.join(' · ') : t('pzs.b2ClockNone');
  };
  paintClock();
  pc.every(30000, paintClock);

  return h(
    'div',
    { class: 'pzs-page' },
    hero,
    kit.group(
      t('pzs.focusDoes'),
      kit.row({ icon: 'alert_snooze', title: t('pzs.hideNotifications'), desc: t('pzs.hideNotificationsDesc'), section: 'hideNotifications', control: boundToggle(pc, 'focusMode.hideNotifications', true, t('pzs.hideNotifications')) }),
      kit.row({ icon: 'dark_theme', title: t('pzs.dimDesktop'), desc: t('pzs.dimDesktopDesc'), section: 'dimDesktop', control: boundToggle(pc, 'focusMode.dimDesktop', true, t('pzs.dimDesktop')) }),
      dimRow,
      kit.row({ icon: 'eye_off', title: t('pzs.b2HideIcons'), desc: t('pzs.b2HideIconsDesc'), section: 'hideIcons', control: boundToggle(pc, 'focusMode.hideIcons', false, t('pzs.b2HideIcons')) }),
      kit.row({ icon: 'panel_bottom', title: t('pzs.simplifyTaskbar'), desc: t('pzs.simplifyTaskbarDesc'), section: 'simplifyTaskbar', control: boundToggle(pc, 'focusMode.simplifyTaskbar', true, t('pzs.simplifyTaskbar')) }),
    ),
    kit.group(
      t('pzs.session'),
      kit.row({
        icon: 'timer',
        title: t('pzs.duration'),
        desc: t('pzs.durationDesc'),
        section: 'duration',
        control: boundCombo(pc, { key: 'focusMode.duration', def: 0, label: t('pzs.duration'), options: DURATIONS.map((m) => ({ value: m, label: durLabel(m) })), onChange: (v) => settings.set('focusMode.duration', Number(v)) }),
      }),
      clockRow,
      kit.row({ icon: 'keyboard', title: t('pzs.focusShortcut'), desc: t('pzs.focusShortcutDesc', { combo: comboKeys(shell.hotkeys?.combos?.().focusMode, pc.lang).join('+') || t('pzs.none') }), onClick: () => pc.go('shortcuts') }),
    ),
    kit.related([
      { icon: 'alert', title: pc.pageTitle('notifications'), desc: pc.L(PAGES.notifications.desc), onClick: () => pc.go('notifications') },
      { icon: 'panel_bottom', title: pc.pageTitle('taskbar'), desc: pc.L(PAGES.taskbar.desc), onClick: () => pc.go('taskbar') },
    ]),
  );
}

export default { focus };
