// « Découvrez Selene »: once per user, a little while after the first sign-in, one notification offers the
// « Bien démarrer » tour of the Aide app (apps/help). Click or « Commencer la visite » -> shell.launch('help', { tour: true }).
// Shown once: the mark is the Aide app's own storage (~/.config/aurora/apps/help/welcome.json), written before the
// notification shows (a crash restart never repeats it). Never in the live session, never in safe mode (it waits for
// a normal session), and never in dev / test shells unless AURORA_HELP_WELCOME=1 (main/ipc/help.js help:welcome,
// which also gives the delay: AURORA_HELP_WELCOME_DELAY_MS, 8 s by default). Nothing happens without the Aide app.

const STRINGS = {
  en: {
    helpWelcome: {
      title: 'Discover Selene',
      body: 'Take the « Get started » tour: the bar, windows, apps and help, in a few steps.',
      start: 'Start the tour',
    },
  },
  fr: {
    helpWelcome: {
      title: 'Découvrez Selene',
      body: 'Suivez la visite « Bien démarrer » : la barre, les fenêtres, les applications et l’aide, en quelques étapes.',
      start: 'Commencer la visite',
    },
  },
};

export async function mount(ctx) {
  const { api, env, i18n, t, notify, shell, registry } = ctx;
  if (env?.mode && env.mode !== 'shell') return;
  if (env?.live) return;
  if (!registry?.get?.('help')) return;
  const cfg = await api.invoke('help:welcome').catch(() => null);
  if (!cfg?.enabled) return;
  const seen = async () => !!(await api.invoke('storage:get', 'help', 'welcome', null).catch(() => null))?.shown;
  if (await seen()) return;
  i18n.extend(STRINGS);

  let done = false;
  async function show() {
    if (done) return null;
    if (shell.safeMode || (await seen())) return null;
    done = true;
    await api.invoke('storage:set', 'help', 'welcome', { shown: true, at: new Date().toISOString() }).catch(() => {});
    const open = () => shell.launch('help', { tour: true });
    return notify({ appId: 'help', title: t('helpWelcome.title'), body: t('helpWelcome.body'), onClick: open, actions: [{ label: t('helpWelcome.start'), onClick: open }] });
  }
  const delay = Math.max(0, Number(cfg.delay) || 0);
  const later = () => setTimeout(show, delay);
  if (document.body.classList.contains('ready')) later();
  else shell.on('ready', later);
  ctx.helpWelcome = { show }; // tests / debugging
}
