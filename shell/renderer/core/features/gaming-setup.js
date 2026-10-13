// First-login gaming apps: the installer's « Jeux » step (aurora-install --gaming) leaves
// ~/.config/aurora/first-login/gaming.json; main/ipc/firstlogin.js installs the apps from Flathub (per user, through
// the Logithèque's own Flathub path) and this feature shows it:
//   one progress notification « Installation des applications de jeu » / « Steam (2/4)… » with a bar,
//     « Masquer » (toast only, it stays in the notification center) and « Annuler » (stops after the current app);
//   offline: the same notification says it waits for the connection (retries with backoff, at once on 'online');
//   at the end one notification: ready (click: Logithèque › Installées), or failures / cancelled with
//     « Réessayer » and « Ouvrir la Logithèque ».
// Nothing happens when there is no request (every session but the first one).

const STRINGS = {
  en: {
    gamingSetup: {
      title: 'Installing gaming apps',
      progress: '{app} ({index}/{total})…',
      cancelling: '{app} ({index}/{total})… Stopping after this app.',
      waiting: 'Waiting for an Internet connection. It will start again on its own as soon as you are back online.',
      hide: 'Hide',
      cancel: 'Cancel',
      doneTitle: 'Your gaming apps are ready',
      done_one: '{apps} is now in the Launcher.',
      done_other: '{apps} are now in the Launcher.',
      failedTitle_one: '{apps} could not be installed',
      failedTitle_other: 'Some gaming apps could not be installed',
      failedOthers: 'The other apps are ready.',
      cancelledTitle: 'Gaming apps installation stopped',
      cancelled_one: '{apps} is still to be installed. You can pick up where you left off whenever you like.',
      cancelled_other: '{apps} are still to be installed. You can pick up where you left off whenever you like.',
      retry: 'Try again',
      openStore: 'Open Software',
    },
  },
  fr: {
    gamingSetup: {
      title: 'Installation des applications de jeu',
      progress: '{app} ({index}/{total})…',
      cancelling: '{app} ({index}/{total})… L’installation s’arrêtera après cette application.',
      waiting: 'En attente d’une connexion Internet. L’installation reprendra toute seule dès que vous serez de nouveau en ligne.',
      hide: 'Masquer',
      cancel: 'Annuler',
      doneTitle: 'Vos applications de jeu sont prêtes',
      done_one: '{apps} vous attend dans le Lanceur.',
      done_other: '{apps} vous attendent dans le Lanceur.',
      failedTitle_one: 'L’installation de {apps} n’a pas abouti',
      failedTitle_other: 'Certaines applications de jeu n’ont pas pu être installées',
      failedOthers: 'Les autres applications sont prêtes.',
      cancelledTitle: 'Installation des applications de jeu arrêtée',
      cancelled_one: 'Il reste {apps} à installer. Vous pourrez les ajouter quand vous voudrez depuis la Logithèque.',
      cancelled_other: 'Il reste {apps} à installer. Vous pourrez les ajouter quand vous voudrez depuis la Logithèque.',
      retry: 'Réessayer',
      openStore: 'Ouvrir la Logithèque',
    },
  },
};

const ACTIVE = new Set(['running', 'cancelling', 'waiting']);
const FINAL = new Set(['done', 'failed', 'cancelled']);
const THROTTLE = 250;

export async function mount(ctx) {
  const { api, i18n, t, notify, notifications, shell } = ctx;
  if (ctx.env?.mode && ctx.env.mode !== 'shell') return;
  i18n.extend(STRINGS);

  let nid = null; // the progress notification
  let userDismissed = false; // closed from the notification center: not shown again until the run ends
  let prev = null; // last state rendered
  let last = null;
  let timer = null;
  let lastAt = 0;

  const list = (names) => {
    try {
      return new Intl.ListFormat(i18n.locale, { style: 'long', type: 'conjunction' }).format(names);
    } catch {
      return names.join(', ');
    }
  };
  const invoke = (ch) => api.invoke(ch).catch((err) => console.warn(`[gaming-setup] ${ch} failed`, err));
  const openStore = (apps) => shell.launch('store', apps.length === 1 ? { id: apps[0].id } : undefined);

  function progressView(s) {
    const cur = s.apps.find((a) => a.id === s.current) || s.apps[Math.max(0, s.index - 1)] || s.apps[0];
    const vars = { app: cur?.name || '', index: s.index || 1, total: s.total };
    if (s.state === 'waiting') return { title: t('gamingSetup.title'), body: t('gamingSetup.waiting'), progress: null };
    const body = t(s.state === 'cancelling' ? 'gamingSetup.cancelling' : 'gamingSetup.progress', vars);
    return { title: t('gamingSetup.title'), body, progress: s.percent };
  }
  function progressActions(s) {
    const hide = { label: t('gamingSetup.hide'), keep: true, toastOnly: true, onClick: () => {} };
    if (s.state === 'cancelling') return [hide];
    return [hide, { label: t('gamingSetup.cancel'), keep: true, onClick: () => invoke('firstlogin:gaming:cancel') }];
  }

  function showProgress(s) {
    const alive = nid != null && notifications.list().some((n) => n.id === nid);
    if (nid != null && !alive) userDismissed = true;
    if (userDismissed) return;
    const view = progressView(s);
    if (!alive) {
      nid = notify({ appId: 'store', ...view, timeout: 0, silent: true, actions: progressActions(s) });
    } else {
      notifications.update(nid, { ...view, actions: progressActions(s) });
    }
  }

  function showFinal(s) {
    if (nid != null) notifications.dismiss(nid);
    nid = null;
    userDismissed = false;
    const installed = s.apps.filter((a) => a.status === 'installed');
    const failed = s.apps.filter((a) => a.status === 'failed');
    const rest = s.apps.filter((a) => a.status !== 'installed');
    const actions = (apps) => [
      { label: t('gamingSetup.retry'), onClick: () => invoke('firstlogin:gaming:retry') },
      { label: t('gamingSetup.openStore'), onClick: () => openStore(apps) },
    ];
    if (s.state === 'done') {
      notify({
        appId: 'store',
        title: t('gamingSetup.doneTitle'),
        body: t('gamingSetup.done', { count: installed.length, apps: list(installed.map((a) => a.name)) }),
        onClick: () => shell.launch('store', { view: 'installed' }),
      });
    } else if (s.state === 'failed') {
      const sentence = (x) => (x && !/[.!?…]$/.test(x) ? `${x}.` : x || '');
      const colon = i18n.lang === 'fr' ? '\u00a0: ' : ': ';
      const why = failed.length === 1 ? sentence(failed[0].error) : failed.map((a) => sentence(`${a.name}${colon}${a.error || a.code}`)).join(' ');
      notify({
        appId: 'store',
        title: t('gamingSetup.failedTitle', { count: failed.length, apps: list(failed.map((a) => a.name)) }),
        body: [why, installed.length ? t('gamingSetup.failedOthers') : ''].filter(Boolean).join(' '),
        timeout: 12000,
        actions: actions(failed),
      });
    } else if (s.state === 'cancelled') {
      notify({
        appId: 'store',
        title: t('gamingSetup.cancelledTitle'),
        body: t('gamingSetup.cancelled', { count: rest.length, apps: list(rest.map((a) => a.name)) }),
        actions: actions(rest),
      });
    }
  }

  function render(s) {
    if (!s || !Array.isArray(s.apps)) return;
    const was = prev;
    prev = s.state;
    if (ACTIVE.has(s.state)) showProgress(s);
    else if (FINAL.has(s.state) && ACTIVE.has(was)) showFinal(s);
  }
  // Progress events come fast (one per percent): at most one render every THROTTLE ms, state changes at once.
  function onState(s) {
    const urgent = !last || last.state !== s?.state || last.current !== s?.current;
    last = s;
    clearTimeout(timer);
    const wait = THROTTLE - (Date.now() - lastAt);
    if (urgent || wait <= 0) {
      lastAt = Date.now();
      render(s);
    } else {
      timer = setTimeout(() => {
        lastAt = Date.now();
        render(last);
      }, wait);
    }
  }

  api.on('firstlogin:gaming', onState);
  window.addEventListener('online', () => invoke('firstlogin:gaming:online'));
  i18n.on('change', () => last && ACTIVE.has(last.state) && render(last));

  const st = await api.invoke('firstlogin:gaming:status').catch(() => null);
  if (!st) return;
  if (ACTIVE.has(st.state)) onState(st); // the shell was reloaded while the main process kept going
  else if (st.autoStart) setTimeout(() => invoke('firstlogin:gaming:start'), Math.max(0, Number(st.startDelay) || 0));
}
