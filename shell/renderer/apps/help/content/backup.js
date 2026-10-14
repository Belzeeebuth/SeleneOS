// Aide — « Sauvegarde ». Facts checked against apps/backup (main.js, i18n.json) and main/ipc/backup.js
// (rsync snapshots in <destination>/SeleneBackup/, unchanged files hard-linked; no automatic run, a reminder only).
export default [
  {
    id: 'backup',
    topic: 'backup',
    title: { en: 'Back up your folders', fr: 'Sauvegarder vos dossiers' },
    summary: { en: 'Copy your documents and pictures to a USB disk with Backup.', fr: 'Copier vos documents et vos images sur un disque USB avec Sauvegarde.' },
    keywords: { en: ['backup', 'back up', 'copy', 'usb disk', 'external drive', 'snapshot', 'save'], fr: ['sauvegarde', 'sauvegarder', 'copie', 'disque usb', 'disque externe', 'instantané'] },
    related: ['backup-restore', 'usb'],
    actions: { open: { app: 'backup' }, settings: { app: 'backup', args: { page: 'settings' } } },
    body: {
      en: [
        {
          steps: [
            'Plug in a USB disk (or any other drive).',
            'Open **Backup**. Under **Destination**, click **Choose…** and pick a folder on that drive.',
            'Check the **Folders to back up**: Documents, Pictures, Music, Videos and Desktop at first; **Add a folder** adds another one from your home folder.',
            'Click **Back up now**.',
          ],
        },
        'Each backup is a complete copy you can browse, but files that did not change take no extra space.',
        { tip: 'Backup does not start on its own: under **Settings**, the **Reminder** can remind you every day or every week.' },
        { actions: ['open', 'settings'] },
      ],
      fr: [
        {
          steps: [
            'Branchez un disque USB (ou un autre disque).',
            'Ouvrez **Sauvegarde**. Sous **Destination**, cliquez sur **Choisir…** et choisissez un dossier sur ce disque.',
            'Vérifiez les **Dossiers à sauvegarder** : Documents, Images, Musique, Vidéos et Bureau au départ ; **Ajouter un dossier** en ajoute un autre de votre dossier personnel.',
            'Cliquez sur **Sauvegarder maintenant**.',
          ],
        },
        'Chaque sauvegarde est une copie complète que vous pouvez parcourir, mais les fichiers qui n’ont pas changé ne prennent pas de place en plus.',
        { tip: 'Sauvegarde ne se lance pas toute seule : dans **Paramètres**, le **Rappel** peut vous le rappeler chaque jour ou chaque semaine.' },
        { actions: ['open', 'settings'] },
      ],
    },
  },
  {
    id: 'backup-restore',
    topic: 'backup',
    title: { en: 'Restore files from a backup', fr: 'Restaurer des fichiers depuis une sauvegarde' },
    summary: { en: 'Get back a file as it was on the day of a backup.', fr: 'Retrouver un fichier tel qu’il était le jour d’une sauvegarde.' },
    keywords: { en: ['restore', 'recover', 'snapshot', 'old version', 'lost file'], fr: ['restaurer', 'récupérer', 'instantané', 'ancienne version', 'fichier perdu'] },
    related: ['backup', 'trash'],
    actions: { snapshots: { app: 'backup', args: { page: 'snapshots' } } },
    body: {
      en: [
        {
          steps: [
            'Plug in the backup drive and open **Backup** › **Snapshots**.',
            'Click **Browse** next to the backup of the day you want.',
            'Select the files, then **Restore** (to their original place) or **Restore to…** (to a folder you choose).',
          ],
        },
        'If a file already exists, Backup asks before replacing it.',
        { tip: 'Look in the [[trash]] first: a file deleted recently may still be there.' },
        { action: 'snapshots' },
      ],
      fr: [
        {
          steps: [
            'Branchez le disque de sauvegarde et ouvrez **Sauvegarde** › **Instantanés**.',
            'Cliquez sur **Parcourir** à côté de la sauvegarde du jour voulu.',
            'Sélectionnez les fichiers, puis **Restaurer** (à leur place d’origine) ou **Restaurer vers…** (dans le dossier de votre choix).',
          ],
        },
        'Si un fichier existe déjà, Sauvegarde demande avant de le remplacer.',
        { tip: 'Regardez d’abord dans [[trash|la Corbeille]] : un fichier supprimé récemment s’y trouve peut-être encore.' },
        { action: 'snapshots' },
      ],
    },
  },
];
