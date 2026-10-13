// Background check for system updates: 5 minutes after sign-in, then once a day, main/ipc/updates.js reads the
// pending updates as the user (`apt-get -s upgrade` over the package lists apt-daily refreshes; no root, nothing
// installs). When there are some: one notification « N mises à jour disponibles » (click or « Voir les mises à
// jour »: Paramètres > Mises à jour), and the count badge on that page in Paramètres (event updates:changed).
// Skipped in the live session (nothing would be kept). Security updates install themselves on installed systems
// (unattended-upgrades): this only tells the user about the rest.
// Timing: updates:schedule (main) -> { firstDelay, interval } (AURORA_UPDATE_CHECK_DELAY_MS / _INTERVAL_MS in tests).

const STRINGS = {
  en: {
    updateCheck: {
      title_one: '{count} update available',
      title_other: '{count} updates available',
      body: 'Fixes and improvements are ready for your computer.',
      bodySecurity_one: 'Fixes and improvements are ready for your computer, including {count} security update.',
      bodySecurity_other: 'Fixes and improvements are ready for your computer, including {count} security updates.',
      open: 'View updates',
    },
  },
  fr: {
    updateCheck: {
      title_one: '{count} mise à jour disponible',
      title_other: '{count} mises à jour disponibles',
      body: 'Des correctifs et des améliorations sont prêts pour votre ordinateur.',
      bodySecurity_one: 'Des correctifs et des améliorations sont prêts pour votre ordinateur, dont {count} mise à jour de sécurité.',
      bodySecurity_other: 'Des correctifs et des améliorations sont prêts pour votre ordinateur, dont {count} mises à jour de sécurité.',
      open: 'Voir les mises à jour',
    },
  },
};

export async function mount(ctx) {
  const { api, env, i18n, t, notify, notifications, shell } = ctx;
  if (env?.mode && env.mode !== 'shell') return;
  if (env?.live) return;
  i18n.extend(STRINGS);
  const sched = await api.invoke('updates:schedule').catch(() => null);
  if (!sched || sched.live || sched.enabled === false) return;

  let nid = null;
  const open = () => shell.launch('settings', { page: 'update' });

  async function runCheck() {
    const r = await api.invoke('updates:pending').catch((err) => {
      console.warn('[update-check] updates:pending failed', err);
      return null;
    });
    if (!r || r.live || r.error || !r.count) return r;
    const view = {
      appId: 'settings',
      title: t('updateCheck.title', { count: r.count }),
      body: r.security ? t('updateCheck.bodySecurity', { count: r.security }) : t('updateCheck.body'),
      onClick: open,
      actions: [{ label: t('updateCheck.open'), onClick: open }],
    };
    // One notification at a time: the daily check replaces yesterday's if it is still there.
    if (nid != null && notifications.list().some((n) => n.id === nid)) notifications.dismiss(nid);
    nid = notify(view);
    return r;
  }

  const firstDelay = Math.max(0, Number(sched.firstDelay) || 0);
  const interval = Math.max(60 * 1000, Number(sched.interval) || 24 * 3600 * 1000);
  setTimeout(() => {
    runCheck();
    setInterval(runCheck, interval);
  }, firstDelay);
  ctx.updateCheck = { run: runCheck }; // tests / debugging
}
