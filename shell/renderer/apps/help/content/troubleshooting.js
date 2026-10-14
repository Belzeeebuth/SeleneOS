// Aide — « Dépannage ». Facts checked against main/lib/robust.js, core/features/robust.js, main/ipc/robust.js
// (diagnostic report), rootfs/usr/lib/aurora/aurora-xsession (safe mode after two shell crashes),
// rootfs/etc/greetd/config.toml (tty1 text console, desktop on VT 7), iso/build.sh (« Mode graphique sûr »), apps/taskmgr.
export default [
  {
    id: 'app-frozen',
    topic: 'troubleshooting',
    title: { en: 'An app or the desktop stops responding', fr: 'Une application ou le bureau ne répond plus' },
    summary: { en: 'Stop a stuck app with System Monitor; the desktop restarts by itself.', fr: 'Arrêter une application bloquée avec le Moniteur système ; le bureau redémarre tout seul.' },
    keywords: { en: ['frozen', 'not responding', 'stuck', 'hang', 'crash', 'kill', 'task manager', 'system monitor'], fr: ['figé', 'ne répond pas', 'bloqué', 'planté', 'plantage', 'tuer', 'gestionnaire des tâches', 'moniteur système'] },
    related: ['safe-mode', 'diagnostic'],
    actions: { taskmgr: { app: 'taskmgr' } },
    body: {
      en: [
        { h: 'An app installed from Software' },
        {
          steps: [
            'Press {{sc:taskManager}} to open **System Monitor**.',
            'On the **Processes** page, select the app.',
            'Click **Stop process**. Unsaved work in that app is lost.',
          ],
        },
        { h: 'The whole desktop' },
        'If the desktop itself stops responding, Selene restarts it by itself after a few seconds. If the screen was locked, it stays locked.',
        { action: 'taskmgr' },
      ],
      fr: [
        { h: 'Une application installée depuis la Logithèque' },
        {
          steps: [
            'Appuyez sur {{sc:taskManager}} pour ouvrir le **Moniteur système**.',
            'Sur la page **Processus**, sélectionnez l’application.',
            'Cliquez sur **Arrêter le processus**. Le travail non enregistré dans cette application est perdu.',
          ],
        },
        { h: 'Tout le bureau' },
        'Si le bureau lui-même ne répond plus, Selene le redémarre tout seul au bout de quelques secondes. Si l’écran était verrouillé, il le reste.',
        { action: 'taskmgr' },
      ],
    },
  },
  {
    id: 'safe-mode',
    topic: 'troubleshooting',
    title: { en: 'Safe mode', fr: 'Le mode sans échec' },
    summary: { en: 'Why Selene started with a plain look, and how to go back to normal.', fr: 'Pourquoi Selene a démarré avec une apparence simple, et comment revenir à la normale.' },
    keywords: { en: ['safe mode', 'crash', 'plain look', 'reset', 'restart normally', 'startup apps'], fr: ['mode sans échec', 'plantage', 'apparence simple', 'réinitialiser', 'redémarrer normalement', 'applications au démarrage'] },
    related: ['session-start', 'app-frozen', 'diagnostic'],
    body: {
      en: [
        'When the desktop crashes several times in a row, Selene starts in safe mode and shows **Selene started in safe mode**. Your custom look and the apps that start with your session are paused; your files and settings are kept.',
        {
          list: [
            '**Restart normally** starts the desktop again with your own look.',
            'If the problem comes back, **Reset the look** puts the appearance back to Selene’s defaults.',
          ],
        },
        { tip: 'A [[diagnostic]] helps to understand what happened.' },
      ],
      fr: [
        'Quand le bureau plante plusieurs fois de suite, Selene démarre en mode sans échec et affiche **Selene a démarré en mode sans échec**. Votre apparence personnalisée et les applications qui démarrent avec votre session sont mises en pause ; vos fichiers et vos réglages sont conservés.',
        {
          list: [
            '**Redémarrer normalement** relance le bureau avec votre apparence.',
            'Si le problème revient, **Réinitialiser l’apparence** rétablit l’apparence par défaut de Selene.',
          ],
        },
        { tip: 'Un [[diagnostic]] aide à comprendre ce qui s’est passé.' },
      ],
    },
  },
  {
    id: 'session-start',
    topic: 'troubleshooting',
    title: { en: 'The session does not start', fr: 'La session ne démarre pas' },
    summary: { en: 'What Selene does by itself, and what you can try.', fr: 'Ce que Selene fait de lui-même, et ce que vous pouvez essayer.' },
    keywords: { en: ['black screen', 'cannot sign in', 'login loop', 'session', 'console', 'graphics', 'nomodeset'], fr: ['écran noir', 'connexion impossible', 'boucle de connexion', 'session', 'console', 'graphique', 'nomodeset'] },
    related: ['safe-mode', 'diagnostic'],
    body: {
      en: [
        'If the desktop fails right after you sign in, Selene tries again by itself, first with simpler graphics, then in [[safe-mode]]. If it still fails, you are taken back to the sign-in screen.',
        {
          list: [
            'Check that the keyboard layout is the right one when you type your password.',
            'Try signing in with another account, if there is one.',
            'From the Selene USB stick, the start menu offers **Safe graphics / Mode graphique sûr** for screens or graphics cards that cause trouble.',
            'For experienced users: {{Ctrl+Alt+F1}} opens a text console where you can sign in; {{Ctrl+Alt+F7}} brings back the graphical screen.',
          ],
        },
      ],
      fr: [
        'Si le bureau échoue juste après la connexion, Selene réessaie de lui-même, d’abord avec un affichage plus simple, puis en [[safe-mode|mode sans échec]]. Si cela échoue encore, vous revenez à l’écran de connexion.',
        {
          list: [
            'Vérifiez que la disposition du clavier est la bonne quand vous tapez votre mot de passe.',
            'Essayez de vous connecter avec un autre compte, s’il y en a un.',
            'Depuis la clé USB de Selene, le menu de démarrage propose **Safe graphics / Mode graphique sûr** pour les écrans ou cartes graphiques qui posent problème.',
            'Pour les utilisateurs avertis : {{Ctrl+Alt+F1}} ouvre une console texte où vous pouvez vous connecter ; {{Ctrl+Alt+F7}} ramène l’affichage graphique.',
          ],
        },
      ],
    },
  },
  {
    id: 'diagnostic',
    topic: 'troubleshooting',
    title: { en: 'Create a diagnostic report', fr: 'Créer un rapport de diagnostic' },
    summary: { en: 'One file to give to whoever helps you; nothing is sent.', fr: 'Un fichier à remettre à la personne qui vous aide ; rien n’est envoyé.' },
    keywords: { en: ['diagnostic', 'report', 'bug', 'logs', 'journal', 'support'], fr: ['diagnostic', 'rapport', 'bogue', 'journaux', 'journal', 'assistance'] },
    related: ['safe-mode', 'privacy'],
    actions: { about: { app: 'settings', args: { page: 'about', section: 'diagnostic' } } },
    body: {
      en: [
        {
          steps: [
            'Open **Settings** › **About**.',
            'Under **Diagnostics**, click **Create report**.',
            '**Show in Files** shows the file, named selene-diagnostic-… in your home folder.',
          ],
        },
        'The report holds the versions of Selene and the system, the messages of the current start-up, your settings (without passwords) and the list of devices. It is never sent: you choose whom to give it to.',
        { action: 'about' },
      ],
      fr: [
        {
          steps: [
            'Ouvrez **Paramètres** › **À propos**.',
            'Sous **Diagnostic**, cliquez sur **Créer le rapport**.',
            '**Afficher dans Fichiers** montre le fichier, nommé selene-diagnostic-… dans votre dossier personnel.',
          ],
        },
        'Le rapport contient les versions de Selene et du système, les messages du démarrage en cours, vos réglages (sans les mots de passe) et la liste des appareils. Il n’est jamais envoyé : vous choisissez à qui le remettre.',
        { action: 'about' },
      ],
    },
  },
  {
    id: 'low-disk',
    topic: 'troubleshooting',
    title: { en: 'Low disk space', fr: 'Espace disque faible' },
    summary: { en: 'What to do when the disk is almost full.', fr: 'Que faire quand le disque est presque plein.' },
    keywords: { en: ['disk full', 'storage', 'space', 'free space', 'clean up'], fr: ['disque plein', 'stockage', 'espace', 'place', 'nettoyer'] },
    related: ['trash', 'uninstall'],
    actions: { storage: { app: 'settings', args: { page: 'storage' } } },
    body: {
      en: [
        'When little space is left, Selene shows **Low disk space**; **Open Storage** shows what uses the disk.',
        { list: ['Empty the [[trash]].', 'Move big files (videos, downloads) to an external drive.', 'Remove the apps you no longer use: [[uninstall]].'] },
        { action: 'storage' },
      ],
      fr: [
        'Quand il reste peu de place, Selene affiche **Espace disque faible** ; **Ouvrir Stockage** montre ce qui occupe le disque.',
        { list: ['Videz [[trash|la Corbeille]].', 'Déplacez les gros fichiers (vidéos, téléchargements) sur un disque externe.', 'Retirez les applications que vous n’utilisez plus : [[uninstall]].'] },
        { action: 'storage' },
      ],
    },
  },
  {
    id: 'logs-app',
    topic: 'troubleshooting',
    title: { en: 'System logs', fr: 'Journaux système' },
    summary: { en: 'Read the messages the system writes in its journal.', fr: 'Lire les messages que le système écrit dans son journal.' },
    keywords: { en: ['logs', 'journal', 'journalctl', 'errors', 'messages'], fr: ['journaux', 'journal', 'journalctl', 'erreurs', 'messages'] },
    related: ['diagnostic'],
    requires: [{ app: 'logs' }],
    actions: { open: { app: 'logs' } },
    body: {
      en: ['This app shows the messages of the system journal, useful to understand an error. Find it in the Launcher, or open it here.', { action: 'open' }],
      fr: ['Cette application affiche les messages du journal du système, utiles pour comprendre une erreur. Vous la trouverez dans le Lanceur, ou ouvrez-la ici.', { action: 'open' }],
    },
  },
];
