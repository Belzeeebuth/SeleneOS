// Drive health alerts (Disques › Santé du disque): main/ipc/disks.js disks:healthCheck reads every drive's SMART status
// from udisks' cached data (nothing is woken up) and broadcasts disks:health-alert once per drive whose status became
// « Attention » or « Défaillance imminente » (remembered in ~/.config/aurora/apps/disks/health-notified.json). This
// feature shows those notifications and runs the check 3 minutes after sign-in, then once a day (disks:healthSchedule;
// dev shells only when AURORA_DISK_HEALTH_DELAY_MS is set). The Disks app also runs the check when it opens.
const STRINGS = {
  en: {
    diskHealth: {
      warningTitle: '{name} shows signs of wear',
      failingTitle: '{name} may fail soon',
      warningBody: 'Back up your files and keep an eye on this drive. Open Disks for the details.',
      failingBody: 'Back up your files now. Open Disks for the details.',
      open: 'See the drive health',
    },
  },
  fr: {
    diskHealth: {
      warningTitle: '{name} montre des signes de faiblesse',
      failingTitle: '{name} risque de tomber en panne',
      warningBody: 'Sauvegardez vos fichiers et surveillez ce disque. Ouvrez Disques pour voir les détails.',
      failingBody: 'Sauvegardez vos fichiers dès maintenant. Ouvrez Disques pour voir les détails.',
      open: 'Voir la santé du disque',
    },
  },
};

export async function mount(ctx) {
  const { api, env, i18n, t, notify, shell } = ctx;
  if (env?.mode && env.mode !== 'shell') return;
  i18n.extend(STRINGS);
  api.on('disks:health-alert', (payload) => {
    for (const a of payload?.alerts || []) {
      const open = () => shell.launch('disks', { device: a.device, view: 'health' });
      const failing = a.status === 'failing';
      notify({
        appId: 'disks',
        title: t(failing ? 'diskHealth.failingTitle' : 'diskHealth.warningTitle', { name: a.name }),
        body: t(failing ? 'diskHealth.failingBody' : 'diskHealth.warningBody'),
        onClick: open,
        actions: [{ label: t('diskHealth.open'), onClick: open }],
      });
    }
  });
  const sched = await api.invoke('disks:healthSchedule').catch(() => null);
  if (!sched?.enabled) return;
  const run = () => api.invoke('disks:healthCheck').catch((err) => console.warn('[disk-health] check failed', err));
  setTimeout(() => {
    run();
    setInterval(run, Math.max(60000, Number(sched.interval) || 86400000));
  }, Math.max(0, Number(sched.firstDelay) || 0));
}
