// Settings > Personalization > Focus mode (docs/PERSONALIZATION.md §10.3, runtime: core/features/focus.js).
// Key: focusMode { active, hideNotifications, dimDesktop, dimLevel, simplifyTaskbar, duration }. `active` is the
// session's state (quick settings tile, Super+Shift+F, this page); the rest is what Focus mode does.
import { liveSlider } from './personalization-designer.js';
import { setupShellPages, boundCombo, boundToggle } from './personalization-shell-kit.js';
import { PAGES } from '../lib/index.js';
import { comboKeys } from '../../../core/shortcuts.js';

const DURATIONS = [0, 15, 25, 30, 45, 60, 90, 120];

async function focus(pc) {
  setupShellPages(pc);
  const { h, t, kit, settings, shell } = pc;
  const active = () => !!settings.get('focusMode.active');
  const durLabel = (m) => (m ? t('pzs.minutes', { count: m }) : t('pzs.untilOff'));

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
    sub.textContent = on ? (left ? t('pzs.focusLeft', { count: left }) : t('pzs.focusUntilOff')) : t('pzs.focusIdle', { duration: durLabel(Number(settings.get('focusMode.duration')) || 0) });
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

  return h(
    'div',
    { class: 'pzs-page' },
    hero,
    kit.group(
      t('pzs.focusDoes'),
      kit.row({ icon: 'alert_snooze', title: t('pzs.hideNotifications'), desc: t('pzs.hideNotificationsDesc'), section: 'hideNotifications', control: boundToggle(pc, 'focusMode.hideNotifications', true, t('pzs.hideNotifications')) }),
      kit.row({ icon: 'dark_theme', title: t('pzs.dimDesktop'), desc: t('pzs.dimDesktopDesc'), section: 'dimDesktop', control: boundToggle(pc, 'focusMode.dimDesktop', true, t('pzs.dimDesktop')) }),
      dimRow,
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
      kit.row({ icon: 'keyboard', title: t('pzs.focusShortcut'), desc: t('pzs.focusShortcutDesc', { combo: comboKeys(shell.hotkeys?.combos?.().focusMode, pc.lang).join('+') || t('pzs.none') }), onClick: () => pc.go('shortcuts') }),
    ),
    kit.related([
      { icon: 'alert', title: pc.pageTitle('notifications'), desc: pc.L(PAGES.notifications.desc), onClick: () => pc.go('notifications') },
      { icon: 'panel_bottom', title: pc.pageTitle('taskbar'), desc: pc.L(PAGES.taskbar.desc), onClick: () => pc.go('taskbar') },
    ]),
  );
}

export default { focus };
