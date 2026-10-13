// Screen reader — « Lecteur d'écran » (Orca, main/ipc/screenreader.js) for the session.
//   settings.screenReader = { enabled: bool, rate: 0–100 (50 = normal), voice: '' (automatic) | speech-dispatcher voice }
// The switch in Paramètres > Accessibilité > Lecteur d'écran and Super+Alt+S (core/shortcuts.js 'screenReader')
// both just flip settings.screenReader.enabled; this module follows the setting: it starts Orca at sign-in when it
// was on, starts / stops it, and restarts it when the speech rate, the voice or the UI language change.
// Orca itself says « Lecteur d'écran activé / désactivé »; a short toast shows it too when toggled by the shortcut.
//   shell.emit('screenreader:toggle')   ctx.screenReader = { toggle(), status(), enabled() }
let ctx;
let running = false;
let applied = ''; // key of the settings Orca runs with
let timer = 0;
let busy = Promise.resolve();
let toastId = null;

const STRINGS = {
  en: { screenreader: { title: 'Screen reader', taskbar: 'Taskbar', on: 'Screen reader on', off: 'Screen reader off', onBody: 'Press Super + Alt + S to turn it off.', failed: 'The screen reader stopped', failedBody: 'Orca quit unexpectedly. You can turn it back on in Accessibility settings.', missing: 'The screen reader isn’t installed' } },
  fr: { screenreader: { title: 'Lecteur d’écran', taskbar: 'Barre des tâches', on: 'Lecteur d’écran activé', off: 'Lecteur d’écran désactivé', onBody: 'Appuyez sur Super + Alt + S pour le désactiver.', failed: 'Le lecteur d’écran s’est arrêté', failedBody: 'Orca s’est fermé de façon inattendue. Vous pouvez le réactiver dans les paramètres d’accessibilité.', missing: 'Le lecteur d’écran n’est pas installé' } },
};

const conf = () => {
  const s = ctx.settings.get('screenReader') || {};
  const rate = Number.isFinite(Number(s.rate)) ? Math.max(0, Math.min(100, Math.round(Number(s.rate)))) : 50;
  return { enabled: s.enabled === true, rate, voice: typeof s.voice === 'string' ? s.voice : '', lang: ctx.i18n.lang || ctx.env.lang || 'en' };
};
const keyOf = (c) => JSON.stringify([c.rate, c.voice, c.lang]);

// keep: stays in the notification centre (problems); the on/off confirmations leave no trace once shown
function toast(title, body, ic = 'chat-centered-text', keep = false) {
  try {
    if (toastId != null) ctx.notifications.clear?.(toastId);
    const id = ctx.notify({ title, body, icon: ic, appId: 'settings', timeout: 3500, silent: true });
    toastId = keep ? null : id;
    if (!keep) setTimeout(() => toastId === id && (ctx.notifications.clear?.(id), (toastId = null)), 4200);
  } catch {}
}

// Serialized: a quick on/off/on never leaves two Orcas or a stale state.
function sync() {
  busy = busy.then(async () => {
    const c = conf();
    try {
      if (c.enabled && (!running || keyOf(c) !== applied)) {
        const st = await ctx.api.invoke('screenreader:start', { lang: c.lang, rate: c.rate, voice: c.voice });
        running = !!st?.running;
        applied = keyOf(c);
      } else if (!c.enabled && running) {
        await ctx.api.invoke('screenreader:stop');
        running = false;
        applied = '';
      }
    } catch (err) {
      console.warn('[screenreader]', err?.message || err);
      if (c.enabled) {
        if (err?.code === 'ENOENT') toast(ctx.t('screenreader.missing'), '', 'warning', true);
        await ctx.settings.set('screenReader.enabled', false).catch(() => {});
      }
    }
  });
  return busy;
}
const later = (ms = 400) => {
  clearTimeout(timer);
  timer = setTimeout(sync, ms);
};

async function toggle({ source } = {}) {
  const on = !conf().enabled;
  await ctx.settings.set('screenReader.enabled', on);
  if (source === 'hotkey') toast(ctx.t(on ? 'screenreader.on' : 'screenreader.off'), on ? ctx.t('screenreader.onBody') : '');
  clearTimeout(timer);
  return sync();
}

// The taskbar is a role=toolbar <nav> without a name: give it one for screen readers (the desktop, Lanceur, Réglages
// rapides and windows already have theirs).
function labelLandmarks() {
  document.getElementById('taskbar')?.setAttribute('aria-label', ctx.t('screenreader.taskbar'));
}

export function mount(c) {
  ctx = c;
  ctx.i18n.extend?.(STRINGS);
  labelLandmarks();
  ctx.settings.on('lang', () => setTimeout(labelLandmarks, 0));
  ctx.shell.on('screenreader:toggle', (p) => toggle(p || {}));
  // the switch and the speech settings: on/off at once, rate / voice after the slider settles
  let prevEnabled = conf().enabled;
  ctx.settings.on('screenReader', () => {
    const c2 = conf();
    if (c2.enabled !== prevEnabled) {
      prevEnabled = c2.enabled;
      clearTimeout(timer);
      sync();
    } else if (c2.enabled) later(700);
  });
  ctx.settings.on('lang', () => conf().enabled && later(300));
  ctx.api.on('screenreader:changed', (st) => {
    if (st?.running) return;
    const was = running;
    running = false;
    applied = '';
    // Orca died on its own while it should run: say so and turn the switch off
    if (was && st?.crashed && conf().enabled) {
      toast(ctx.t('screenreader.failed'), ctx.t('screenreader.failedBody'), 'warning', true);
      ctx.settings.set('screenReader.enabled', false).catch(() => {});
    }
  });
  ctx.screenReader = { toggle, status: () => ctx.api.invoke('screenreader:status'), enabled: () => conf().enabled, sync };
  // restore the session's reader (it was on when the user signed out)
  if (conf().enabled) sync();
}
