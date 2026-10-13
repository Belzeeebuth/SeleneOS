// Robustness notices (track "robust"; backend main/ipc/robust.js + main/lib/robust.js):
//   - safe mode banner « Selene a démarré en mode sans échec » with « Réinitialiser l'apparence » and
//     « Redémarrer normalement » (safe mode = 3 renderer crashes within 2 minutes, or 2 shell crashes in a row
//     in aurora-xsession -> AURORA_SAFE_MODE=1; the user's look is ignored by main/ipc/settings.js meanwhile);
//   - once per session: settings restored from the last good copy, settings not saved (disk full), low disk space.
//   window.__aurora.robust = { status, banner }
import { icon } from '../ui.js';
const STRINGS = {
  en: {
    robust: {
      safeTitle: 'Selene started in safe mode',
      safeBody: 'Selene had trouble starting, so your custom look and startup apps are paused for now. Your files and settings are safe.',
      resetLook: 'Reset the look',
      lookReset: 'Look reset',
      restartNormal: 'Restart normally',
      restoredTitle: 'Your settings were restored',
      restoredBackup: 'The settings file was damaged. Selene used the last good copy from your previous sign-in.',
      restoredDefaults: 'The settings file was damaged and no good copy was found. Selene uses the default settings.',
      saveTitle: 'Settings not saved',
      saveBody: 'Your disk is full, so your latest changes could not be saved. Free some space and try again.',
      diskTitle: 'Low disk space',
      diskBody: 'Only {free} left on your home drive. Free some space to keep Selene running smoothly.',
      openStorage: 'Open Storage',
      hide: 'Hide',
    },
  },
  fr: {
    robust: {
      safeTitle: 'Selene a démarré en mode sans échec',
      safeBody: 'Selene a eu du mal à démarrer : votre apparence personnalisée et vos applications au démarrage sont mises en pause. Vos fichiers et vos réglages sont intacts.',
      resetLook: 'Réinitialiser l’apparence',
      lookReset: 'Apparence réinitialisée',
      restartNormal: 'Redémarrer normalement',
      restoredTitle: 'Vos réglages ont été restaurés',
      restoredBackup: 'Le fichier de réglages était abîmé. Selene a repris la dernière copie valide, celle de votre précédente connexion.',
      restoredDefaults: 'Le fichier de réglages était abîmé et aucune copie valide n’a été trouvée. Selene utilise les réglages par défaut.',
      saveTitle: 'Réglages non enregistrés',
      saveBody: 'Votre disque est plein : vos derniers changements n’ont pas pu être enregistrés. Libérez de l’espace puis réessayez.',
      diskTitle: 'Espace disque faible',
      diskBody: 'Il ne reste que {free} sur votre disque personnel. Libérez de l’espace pour que Selene reste fluide.',
      openStorage: 'Ouvrir Stockage',
      hide: 'Masquer',
    },
  },
};

function fmtSize(bytes, lang) {
  const gb = bytes / 1024 ** 3;
  const v = gb >= 1 ? `${gb.toFixed(1)} ${lang === 'fr' ? 'Go' : 'GB'}` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} ${lang === 'fr' ? 'Mo' : 'MB'}`;
  return lang === 'fr' ? v.replace('.', ',') : v;
}

export async function mount(ctx) {
  const { api, i18n, t, h, ui, notify, shell, settings } = ctx;
  i18n.extend(STRINGS);
  ui.loadCss('app://shell/core/features/robust.css');
  let status = await api.invoke('robust:status').catch(() => null);
  if (!status) return;
  const self = { status, banner: null };
  ctx.robust = self;
  if (ctx.shell) ctx.shell.safeMode = !!status.safeMode;

  if (status.safeMode) {
    const resetBtn = h('button', { class: 'btn', type: 'button' }, t('robust.resetLook'));
    const restartBtn = h('button', { class: 'btn accent', type: 'button' }, t('robust.restartNormal'));
    resetBtn.addEventListener('click', async () => {
      resetBtn.disabled = true;
      try {
        await api.invoke('settings:setMany', {}, { reset: status.lookKeys || [] });
        resetBtn.textContent = t('robust.lookReset');
      } catch (err) {
        console.error('[robust] reset look failed', err);
        resetBtn.disabled = false;
      }
    });
    restartBtn.addEventListener('click', () => {
      restartBtn.disabled = true;
      api.invoke('robust:leaveSafeMode').catch((err) => {
        console.error('[robust] leave safe mode failed', err);
        restartBtn.disabled = false;
      });
    });
    const hideBtn = h('button', { class: 'btn subtle icon-btn safe-banner-hide', type: 'button', 'aria-label': t('robust.hide'), title: t('robust.hide') }, icon('dismiss', { size: 16 }));
    const banner = h(
      'div',
      { class: 'safe-banner', role: 'status', 'aria-live': 'polite' },
      h('div', { class: 'safe-banner-icon', 'aria-hidden': 'true' }, icon('info', { size: 20 })),
      h('div', { class: 'safe-banner-text' }, h('div', { class: 'safe-banner-title' }, t('robust.safeTitle')), h('div', { class: 'safe-banner-body' }, t('robust.safeBody'))),
      h('div', { class: 'safe-banner-actions' }, resetBtn, restartBtn, hideBtn),
    );
    hideBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      banner.remove(); // until the shell starts again (still in safe mode)
    });
    // It steps aside so it never covers work: a small « mode sans échec » pill once a window opens or after 25 s;
    // a click on the pill opens the card again.
    let compactTimer = null;
    const compact = (on) => {
      clearTimeout(compactTimer);
      banner.classList.toggle('compact', on);
      if (!on) compactTimer = setTimeout(() => compact(true), 25000);
    };
    banner.addEventListener('click', () => banner.classList.contains('compact') && compact(false));
    ctx.wm?.on?.('open', () => compact(true));
    compact(false);
    document.body.append(banner);
    self.banner = banner;
  }

  const lang = () => settings.get('lang') || ctx.env.lang;
  const show = async (st) => {
    status = st || status;
    self.status = status;
    if (status.settingsRecovered && !status.acked.settings) {
      status.acked.settings = 1;
      await api.invoke('robust:ack', 'settings').catch(() => {});
      notify({ appId: 'settings', title: t('robust.restoredTitle'), body: t(status.settingsRecovered === 'backup' ? 'robust.restoredBackup' : 'robust.restoredDefaults'), timeout: 12000 });
    }
    if (status.saveFailed && !status.acked.save) {
      status.acked.save = 1;
      await api.invoke('robust:ack', 'save').catch(() => {});
      notify({ appId: 'settings', title: t('robust.saveTitle'), body: t('robust.saveBody'), timeout: 12000, actions: [{ label: t('robust.openStorage'), onClick: () => shell.launch('settings', { page: 'storage' }) }] });
    }
    if (status.lowDisk && !status.acked.disk) {
      status.acked.disk = 1;
      await api.invoke('robust:ack', 'disk').catch(() => {});
      notify({ appId: 'settings', title: t('robust.diskTitle'), body: t('robust.diskBody', { free: fmtSize(status.lowDisk.avail, lang()) }), timeout: 12000, actions: [{ label: t('robust.openStorage'), onClick: () => shell.launch('settings', { page: 'storage' }) }] });
    }
  };
  api.on('robust:changed', (st) => show(st));
  // After the desktop is up (notifications mounted, the lock screen decided).
  setTimeout(() => show(), 1500);
}
