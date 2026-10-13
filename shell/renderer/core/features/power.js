// Power management of the session (inputpower track).
//   * Screen off after inactivity (settings.power.screenOffBattery / screenOffAc, minutes, 0 = never): DPMS through
//     main/ipc/inputpower.js power:screenOff; any input turns the screen back on (X does it). The session locks at the
//     same time (lockOnScreenOff) when the account has a password (installed system; the live session has none).
//   * Sleep after inactivity (sleepBattery / sleepAc, 0 = never; never on mains by default so VMs stay awake).
//   * Battery: a notification at 10 % and 5 %; at 3 % while discharging, a 60 s countdown notification, then sleep
//     (plugging in cancels it).
// Playing audio / video counts as activity (like features/lock.js). settings.power is not in the shell defaults: in dev
// mode (tests) nothing happens unless a test sets it, so long test runs never blank or sleep.
//   ctx.power = { config(), state, countdownSec, tick() }   (tests)
export const POWER_DEFAULTS = { screenOffBattery: 5, screenOffAc: 10, sleepBattery: 15, sleepAc: 0, lockOnScreenOff: true };

const STRINGS = {
  en: {
    pwr: {
      lowTitle: 'Battery low',
      lowBody: '{percent}% left. Plug in your computer soon.',
      criticalTitle: 'Battery almost empty',
      criticalBody: '{percent}% left. Plug in your computer now.',
      countdownTitle: 'Going to sleep to protect your work',
      countdownBody: 'Battery at {percent}%. Sleep in {sec} s. Plug in your computer to cancel.',
      sleepNow: 'Sleep now',
      pluggedTitle: 'Charging',
      pluggedBody: 'The computer is plugged in: it stays awake.',
      mode: 'Power mode',
      tile: 'Power mode',
      profile: { 'power-saver': 'Power saver', balanced: 'Balanced', performance: 'Performance' },
    },
  },
  fr: {
    pwr: {
      lowTitle: 'Batterie faible',
      lowBody: 'Il reste {percent} %. Branchez votre ordinateur bientôt.',
      criticalTitle: 'Batterie presque vide',
      criticalBody: 'Il reste {percent} %. Branchez votre ordinateur maintenant.',
      countdownTitle: 'Mise en veille pour protéger votre travail',
      countdownBody: 'Batterie à {percent} %. Mise en veille dans {sec} s. Branchez votre ordinateur pour annuler.',
      sleepNow: 'Mettre en veille maintenant',
      pluggedTitle: 'En charge',
      pluggedBody: 'L’ordinateur est branché : il reste allumé.',
      mode: 'Mode d’alimentation',
      tile: 'Énergie',
      profile: { 'power-saver': 'Économie d’énergie', balanced: 'Équilibré', performance: 'Performances' },
    },
  },
};

const ACTIVITY_EVENTS = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart'];

export function mount(ctx) {
  const { api, settings, shell, notify, notifications, env } = ctx;
  ctx.i18n.extend(STRINGS);
  const t = (k, v) => ctx.t(k, v);
  const state = { battery: null, screenOff: false, slept: false, warned: { 10: false, 5: false }, countdown: null, criticalDone: false, needsPassword: false, screenOffCount: 0, sleepCount: 0 };
  const config = () => {
    const s = settings.get('power');
    if (!s && env?.dev) return null;
    return { ...POWER_DEFAULTS, ...(s || {}) };
  };
  const onBattery = () => !!state.battery && !state.battery.ac && !state.battery.charging;

  // ---------------------------------------------------------------- inactivity
  let lastActivity = Date.now();
  const bump = () => {
    lastActivity = Date.now();
    state.screenOff = false;
    state.slept = false;
  };
  for (const ev of ACTIVITY_EVENTS) window.addEventListener(ev, bump, { capture: true, passive: true });
  api.on('shell:hotkey', bump);
  const mediaPlaying = () => [...document.querySelectorAll('video, audio')].some((m) => !m.paused && !m.ended && !m.muted);
  let lastTick = Date.now();
  async function tick() {
    const cfg = config();
    const now = Date.now();
    // Back from sleep (the loop stood still): the delays start again.
    if (now - lastTick > 60000) bump();
    lastTick = now;
    if (!cfg) return;
    if (mediaPlaying()) bump();
    let system = Infinity;
    try {
      system = Number(await api.invoke('auth:idle'));
    } catch {}
    // The shell page's own activity wins when it is more recent; X input anywhere else counts through auth:idle.
    const idle = Math.min((now - lastActivity) / 1000, Number.isFinite(system) ? system : Infinity);
    const bat = onBattery();
    const offMin = Number(bat ? cfg.screenOffBattery : cfg.screenOffAc) || 0;
    const sleepMin = Number(bat ? cfg.sleepBattery : cfg.sleepAc) || 0;
    // Input since (screen back on / awake again): re-arm.
    if (offMin <= 0 || idle < offMin * 60) state.screenOff = false;
    if (sleepMin <= 0 || idle < sleepMin * 60) state.slept = false;
    if (offMin > 0 && idle >= offMin * 60 && !state.screenOff) {
      state.screenOff = true;
      state.screenOffCount++;
      if (cfg.lockOnScreenOff && state.needsPassword && !ctx.lockScreen?.locked) shell.lock();
      api.invoke('power:screenOff').catch(() => {});
    }
    if (sleepMin > 0 && idle >= sleepMin * 60 && !state.slept) {
      state.slept = true;
      state.sleepCount++;
      shell.suspend?.().catch?.(() => {});
    }
  }
  setInterval(() => tick().catch(() => {}), 5000);

  api
    .invoke('auth:status')
    .then((st) => (state.needsPassword = !!st?.needsPassword))
    .catch(() => {});

  // ---------------------------------------------------------------- battery
  function stopCountdown(plugged) {
    const c = state.countdown;
    if (!c) return;
    clearInterval(c.timer);
    clearInterval(c.poll);
    state.countdown = null;
    if (plugged) notifications.update(c.id, { title: t('pwr.pluggedTitle'), body: t('pwr.pluggedBody'), progress: null, actions: [] });
    else notifications.dismiss(c.id);
  }
  function sleepNow() {
    stopCountdown(false);
    state.slept = true;
    state.sleepCount++;
    shell.suspend?.().catch?.(() => {});
  }
  function startCountdown() {
    if (state.countdown || state.criticalDone) return;
    const total = Math.max(1, Number(ctxPower.countdownSec) || 60);
    let left = total;
    const body = () => t('pwr.countdownBody', { percent: state.battery?.percent ?? 3, sec: left });
    const id = notify({ title: t('pwr.countdownTitle'), body: body(), icon: 'battery-empty', appId: 'settings', timeout: 0, urgent: true, progress: 100, actions: [{ label: t('pwr.sleepNow'), onClick: sleepNow }] });
    const c = { id, timer: 0, poll: 0 };
    state.countdown = c;
    c.timer = setInterval(() => {
      left--;
      if (left <= 0) {
        state.criticalDone = true;
        sleepNow();
        return;
      }
      notifications.update(id, { body: body(), progress: Math.round((left / total) * 100) });
    }, 1000);
    // Plugging in must cancel quickly: read the battery every 2 s while counting down.
    c.poll = setInterval(() => {
      api
        .invoke('power:battery')
        .then(onBattery_)
        .catch(() => {});
    }, 2000);
  }
  function onBattery_(b) {
    state.battery = b || null;
    if (!b) return;
    if (b.charging || b.ac) {
      state.warned = { 10: false, 5: false };
      state.criticalDone = false;
      stopCountdown(true);
      return;
    }
    const p = Number(b.percent);
    if (p > 12) state.warned = { 10: false, 5: false };
    if (p <= 3) startCountdown();
    else if (p <= 5 && !state.warned[5]) {
      state.warned[5] = state.warned[10] = true;
      notify({ title: t('pwr.criticalTitle'), body: t('pwr.criticalBody', { percent: p }), icon: 'battery-empty', appId: 'settings', urgent: true, timeout: 15000 });
    } else if (p <= 10 && !state.warned[10]) {
      state.warned[10] = true;
      notify({ title: t('pwr.lowTitle'), body: t('pwr.lowBody', { percent: p }), icon: 'battery-low', appId: 'settings', timeout: 10000 });
    }
  }
  api.on('power:changed', onBattery_);
  api
    .invoke('power:battery')
    .then(onBattery_)
    .catch(() => {});

  const ctxPower = {
    config,
    state,
    countdownSec: 60,
    tick,
    defaults: POWER_DEFAULTS,
  };
  ctx.power = ctxPower;
}
