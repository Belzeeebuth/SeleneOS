// Aide — « Mises à jour ». Facts checked against apps/settings/pages/update.js, lib/selene-updates.js,
// core/features/update-check.js, main/ipc/updates.js, rootfs/etc/apt/apt.conf.d/21aurora-auto-upgrades,
// apps/store (« Mises à jour », Flathub only), main/ipc/firmware.js, docs/UPDATES.md.
export default [
  {
    id: 'system-updates',
    topic: 'updates',
    title: { en: 'Update the system', fr: 'Mettre à jour le système' },
    summary: { en: 'Check for updates and install them from Settings.', fr: 'Rechercher les mises à jour et les installer depuis les Paramètres.' },
    keywords: { en: ['update', 'upgrade', 'security', 'patch', 'apt', 'install updates'], fr: ['mise à jour', 'mettre à jour', 'sécurité', 'correctif', 'apt', 'installer les mises à jour'] },
    related: ['selene-updates', 'app-updates', 'firmware'],
    actions: { settings: { app: 'settings', args: { page: 'update' } } },
    body: {
      en: [
        {
          steps: [
            'Open **Settings** › **Updates**.',
            'Click **Check for updates**.',
            'If updates are available, click **Install all** and keep the computer on until it is done.',
          ],
        },
        'Both steps ask for an administrator’s permission: only an administrator can update the system. If a restart is needed, **Restart now** appears.',
        { h: 'Automatically' },
        {
          list: [
            'A few minutes after you sign in, then every day, Selene looks for updates and shows a notification when there are some: **View updates** opens this page.',
            'On an installed system, security updates install by themselves every day.',
          ],
        },
        { note: 'In the live session, updates are lost when the computer restarts.' },
        { action: 'settings' },
      ],
      fr: [
        {
          steps: [
            'Ouvrez **Paramètres** › **Mises à jour**.',
            'Cliquez sur **Rechercher des mises à jour**.',
            'S’il y en a, cliquez sur **Tout installer** et laissez l’ordinateur allumé jusqu’à la fin.',
          ],
        },
        'Les deux étapes demandent l’autorisation d’un administrateur : seul un administrateur peut mettre à jour le système. Si un redémarrage est nécessaire, **Redémarrer maintenant** apparaît.',
        { h: 'Automatiquement' },
        {
          list: [
            'Quelques minutes après votre connexion, puis chaque jour, Selene recherche les mises à jour et affiche une notification quand il y en a : **Voir les mises à jour** ouvre cette page.',
            'Sur un système installé, les mises à jour de sécurité s’installent toutes seules chaque jour.',
          ],
        },
        { note: 'Dans la session live, les mises à jour sont perdues au redémarrage.' },
        { action: 'settings' },
      ],
    },
  },
  {
    id: 'selene-updates',
    topic: 'updates',
    title: { en: 'New versions of Selene', fr: 'Nouvelles versions de Selene' },
    summary: { en: 'The desktop and its apps update like the rest of the system.', fr: 'Le bureau et ses applications se mettent à jour comme le reste du système.' },
    keywords: { en: ['selene', 'version', 'new version', 'restart session', 'desktop update'], fr: ['selene', 'version', 'nouvelle version', 'redémarrer la session', 'mise à jour du bureau'] },
    related: ['system-updates'],
    actions: { settings: { app: 'settings', args: { page: 'update' } }, about: { app: 'winver' } },
    body: {
      en: [
        'A new version of Selene shows as one **Selene** entry (with its version number) in **Settings** › **Updates**, and installs with **Install all**.',
        'Afterwards, **Selene has been updated** asks you to **Restart the session**: save your work first, your open apps will close.',
        { tip: '**About Selene** shows the version you are using.' },
        { actions: ['settings', 'about'] },
      ],
      fr: [
        'Une nouvelle version de Selene apparaît comme une seule entrée **Selene** (avec son numéro de version) dans **Paramètres** › **Mises à jour**, et s’installe avec **Tout installer**.',
        'Ensuite, **Selene a été mise à jour** vous propose de **Redémarrer la session** : enregistrez d’abord votre travail, vos applications ouvertes seront fermées.',
        { tip: '**À propos de Selene** indique la version que vous utilisez.' },
        { actions: ['settings', 'about'] },
      ],
    },
  },
  {
    id: 'app-updates',
    topic: 'updates',
    title: { en: 'Update your apps', fr: 'Mettre à jour vos applications' },
    summary: { en: 'Apps from Flathub update from Software.', fr: 'Les applications de Flathub se mettent à jour depuis la Logithèque.' },
    keywords: { en: ['app updates', 'flathub', 'update all', 'software'], fr: ['mises à jour des applications', 'flathub', 'tout mettre à jour', 'logithèque'] },
    related: ['system-updates', 'store'],
    actions: { updates: { app: 'store', args: { view: 'updates' } } },
    body: {
      en: [
        'Open **Software** › **Updates**: **Update all**, or **Update** for one app. Software checks every day, and nothing is installed without you.',
        'This page lists the apps installed from Flathub. Apps from the Selene picks and the Ubuntu archive are updated with the system, in **Settings** › **Updates**.',
        { action: 'updates' },
      ],
      fr: [
        'Ouvrez **Logithèque** › **Mises à jour** : **Tout mettre à jour**, ou **Mettre à jour** pour une seule application. La Logithèque vérifie chaque jour, et rien ne s’installe sans vous.',
        'Cette page liste les applications installées depuis Flathub. Celles de la Sélection Selene et de l’Archive Ubuntu se mettent à jour avec le système, dans **Paramètres** › **Mises à jour**.',
        { action: 'updates' },
      ],
    },
  },
  {
    id: 'firmware',
    topic: 'updates',
    title: { en: 'Firmware updates', fr: 'Mises à jour des microprogrammes' },
    summary: { en: 'Update the firmware of supported devices (UEFI, SSD, dock…).', fr: 'Mettre à jour le microprogramme des appareils pris en charge (UEFI, SSD, station d’accueil…).' },
    keywords: { en: ['firmware', 'bios', 'uefi', 'fwupd', 'ssd'], fr: ['microprogramme', 'micrologiciel', 'firmware', 'bios', 'uefi', 'fwupd', 'ssd'] },
    related: ['system-updates'],
    actions: { settings: { app: 'settings', args: { page: 'update' } } },
    body: {
      en: [
        'When a device of the computer can be updated this way, **Settings** › **Updates** shows a **Firmware** section: **Check**, then **Update** next to the device.',
        { note: 'Keep a laptop plugged in during a firmware update. Some updates finish at the next restart.' },
        { action: 'settings' },
      ],
      fr: [
        'Quand un appareil de l’ordinateur peut être mis à jour ainsi, **Paramètres** › **Mises à jour** affiche une section **Microprogrammes** : **Rechercher**, puis **Mettre à jour** à côté de l’appareil.',
        { note: 'Gardez un ordinateur portable branché pendant une mise à jour de microprogramme. Certaines se terminent au redémarrage suivant.' },
        { action: 'settings' },
      ],
    },
  },
];
