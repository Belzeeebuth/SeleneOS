// Aide — « Installer Selene ». Facts checked against apps/installer (main.js, i18n.json; liveOnly),
// rootfs/usr/lib/aurora/helpers/aurora-install and aurora-disk-probe (dual boot « Installer à côté »).
export default [
  {
    id: 'install',
    topic: 'install',
    title: { en: 'Install Selene on the computer', fr: 'Installer Selene sur l’ordinateur' },
    summary: { en: 'From the live session, a few steps put Selene on the disk.', fr: 'Depuis la session live, quelques étapes installent Selene sur le disque.' },
    keywords: { en: ['install', 'installer', 'live', 'usb', 'disk', 'erase', 'setup'], fr: ['installer', 'installation', 'live', 'usb', 'disque', 'effacer'] },
    related: ['dual-boot', 'backup'],
    actions: { open: { app: 'installer' } },
    body: {
      en: [
        'When you start the computer from the Selene USB stick or DVD, you are in the live session: try Selene, then double-click **Install Selene OS** on the desktop.',
        'The installer asks, in order: the **Language**, the **Keyboard**, the **Disk**, your **Account**, the **Time zone**, the **Graphics driver** (only with an NVIDIA card) and the **Games** apps, then shows a **Summary** before anything changes.',
        {
          list: [
            '**Erase the whole disk** puts Selene alone on the disk (12 GB at least).',
            '**Install next to …** keeps the system already there: see [[dual-boot]].',
            'The account you create is an administrator account.',
            'The gaming apps you tick are installed from Flathub at your first sign-in.',
          ],
        },
        { note: 'Back up your files before installing: changing a disk is never without risk.' },
        { action: 'open' },
      ],
      fr: [
        'Quand vous démarrez l’ordinateur sur la clé USB ou le DVD de Selene, vous êtes dans la session live : essayez Selene, puis double-cliquez sur **Installer Selene OS** sur le bureau.',
        'L’installateur demande, dans l’ordre : la **Langue**, le **Clavier**, le **Disque**, votre **Compte**, le **Fuseau horaire**, le **Pilote graphique** (seulement avec une carte NVIDIA) et les applications de **Jeux**, puis affiche un **Récapitulatif** avant de modifier quoi que ce soit.',
        {
          list: [
            '**Effacer tout le disque** installe Selene seul sur le disque (12 Go au minimum).',
            '**Installer à côté …** garde le système déjà présent : voyez [[dual-boot]].',
            'Le compte que vous créez est un compte administrateur.',
            'Les applications de jeu cochées s’installent depuis Flathub à votre première connexion.',
          ],
        },
        { note: 'Sauvegardez vos fichiers avant d’installer : modifier un disque n’est jamais sans risque.' },
        { action: 'open' },
      ],
    },
  },
  {
    id: 'dual-boot',
    topic: 'install',
    title: { en: 'Install next to Windows or Linux', fr: 'Installer à côté de Windows ou de Linux' },
    summary: { en: 'Keep your other system and choose at start-up.', fr: 'Garder votre autre système et choisir au démarrage.' },
    keywords: { en: ['dual boot', 'next to', 'alongside', 'windows', 'linux', 'shrink', 'partition', 'grub', 'boot menu', 'bitlocker'], fr: ['double démarrage', 'à côté', 'windows', 'linux', 'réduire', 'partition', 'grub', 'menu de démarrage', 'bitlocker'] },
    related: ['install'],
    actions: { open: { app: 'installer' } },
    body: {
      en: [
        'At the **Disk** step, **Install next to …** keeps the system already on the disk. Selene needs at least 20 GB; 40 GB or more is recommended.',
        { h: 'Where the space comes from' },
        {
          list: [
            '**Use the free space** already left on the disk;',
            'or shrink the Windows (NTFS) or Linux (ext4) partition: the **Space** step lets you choose the size with a slider;',
            'or reuse the space left by an attempt that did not finish.',
          ],
        },
        'The **Summary** lists every change, and you tick **I have backed up my important files** before installing.',
        { h: 'When it is not possible' },
        'The installer explains why and what to do. Installing next to another system needs a computer started in UEFI mode and a GPT disk. Selene does not shrink a partition encrypted with BitLocker, a Windows left in Fast Startup or hibernation, or LUKS, LVM, btrfs and XFS partitions: free the space yourself from the other system, then choose **Use the free space**.',
        { h: 'At start-up' },
        'A menu lets you choose Selene or your other system; without a choice, Selene starts after 5 seconds. If Windows starts directly, open your computer’s boot menu (often {{F12}}, {{F11}} or {{Escape}}) and choose **Selene**.',
        { action: 'open' },
      ],
      fr: [
        'À l’étape **Disque**, **Installer à côté …** garde le système déjà présent sur le disque. Selene a besoin d’au moins 20 Go ; 40 Go ou plus sont recommandés.',
        { h: 'D’où vient la place' },
        {
          list: [
            '**Utiliser l’espace libre** déjà disponible sur le disque ;',
            'ou réduire la partition Windows (NTFS) ou Linux (ext4) : l’étape **Espace** permet de choisir la taille avec un curseur ;',
            'ou reprendre l’espace laissé par un essai qui n’a pas abouti.',
          ],
        },
        'Le **Récapitulatif** liste chaque changement, et vous cochez **J’ai sauvegardé mes fichiers importants** avant d’installer.',
        { h: 'Quand ce n’est pas possible' },
        'L’installateur explique pourquoi et quoi faire. Installer à côté d’un autre système demande un ordinateur démarré en mode UEFI et un disque GPT. Selene ne réduit pas une partition chiffrée avec BitLocker, un Windows laissé en démarrage rapide ou en veille prolongée, ni les partitions LUKS, LVM, btrfs et XFS : libérez la place vous-même depuis l’autre système, puis choisissez **Utiliser l’espace libre**.',
        { h: 'Au démarrage' },
        'Un menu permet de choisir Selene ou votre autre système ; sans choix, Selene démarre au bout de 5 secondes. Si Windows démarre directement, ouvrez le menu de démarrage de l’ordinateur (souvent {{F12}}, {{F11}} ou {{Escape}}) et choisissez **Selene**.',
        { action: 'open' },
      ],
    },
  },
];
