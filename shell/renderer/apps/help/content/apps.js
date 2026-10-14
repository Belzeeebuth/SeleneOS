// Aide — « Applications ». Facts checked against apps/store (main.js, i18n.json), docs/STORE-SOURCES.md,
// docs/XWINDOWS.md, core/features/office.js, apps/settings/pages/apps.js, apps/files (« Ouvrir avec »).
export default [
  {
    id: 'store',
    topic: 'apps',
    title: { en: 'Install apps with Software', fr: 'Installer des applications avec la Logithèque' },
    summary: { en: 'Find an app, install it, open it from the Launcher.', fr: 'Trouver une application, l’installer, l’ouvrir depuis le Lanceur.' },
    keywords: { en: ['install', 'software', 'store', 'app store', 'download', 'program', 'flathub', 'firefox', 'steam', 'libreoffice'], fr: ['installer', 'logithèque', 'boutique', 'télécharger', 'programme', 'logiciel', 'flathub', 'firefox', 'steam', 'libreoffice'] },
    related: ['app-sources', 'uninstall', 'app-updates', 'linux-apps'],
    actions: { open: { app: 'store' } },
    body: {
      en: [
        {
          steps: [
            'Open **Software** from the Launcher.',
            'Search for an app or browse the **Categories**, then open its page.',
            'Click **Install from …** (the source is named on the button).',
            'When it is done, click **Open**: the app is also in the Launcher and the search.',
          ],
        },
        'Apps from Flathub install for you only, without a password. Apps from the Selene picks and the Ubuntu archive install for everyone and ask for the administrator password.',
        { note: 'In the live session (before installing Selene), installed apps are lost when the computer restarts.' },
        { action: 'open' },
      ],
      fr: [
        {
          steps: [
            'Ouvrez la **Logithèque** depuis le Lanceur.',
            'Cherchez une application ou parcourez les **Catégories**, puis ouvrez sa page.',
            'Cliquez sur **Installer depuis …** (la source est indiquée sur le bouton).',
            'Quand c’est terminé, cliquez sur **Ouvrir** : l’application est aussi dans le Lanceur et dans la recherche.',
          ],
        },
        'Les applications de Flathub s’installent pour vous seul, sans mot de passe. Celles de la Sélection Selene et de l’Archive Ubuntu s’installent pour tous et demandent le mot de passe administrateur.',
        { note: 'Dans la session live (avant d’installer Selene), les applications installées sont perdues au redémarrage.' },
        { action: 'open' },
      ],
    },
  },
  {
    id: 'app-sources',
    topic: 'apps',
    title: { en: 'Where apps come from', fr: 'D’où viennent les applications' },
    summary: { en: 'Selene picks, the Ubuntu archive and Flathub.', fr: 'La Sélection Selene, l’Archive Ubuntu et Flathub.' },
    keywords: { en: ['sources', 'flathub', 'flatpak', 'ubuntu', 'apt', 'repository'], fr: ['sources', 'flathub', 'flatpak', 'ubuntu', 'apt', 'dépôt'] },
    related: ['store', 'app-updates'],
    actions: { sources: { app: 'store', args: { view: 'sources' } } },
    body: {
      en: [
        'Software gathers three sources:',
        {
          list: [
            '**Selene picks**: tools and services chosen for Selene, installed for everyone;',
            '**Ubuntu archive**: the desktop apps of Ubuntu 24.04, installed for everyone;',
            '**Flathub**: a large catalogue (browsers, games, creative apps…), installed for your account only.',
          ],
        },
        'The **Sources** page explains each one; Flathub can be hidden there with **Show apps from this source**.',
        { action: 'sources' },
      ],
      fr: [
        'La Logithèque réunit trois sources :',
        {
          list: [
            '**Sélection Selene** : des outils et services choisis pour Selene, installés pour tous ;',
            '**Archive Ubuntu** : les applications de bureau d’Ubuntu 24.04, installées pour tous ;',
            '**Flathub** : un grand catalogue (navigateurs, jeux, création…), installé pour votre compte seulement.',
          ],
        },
        'La page **Sources** les présente ; Flathub peut y être masqué avec **Afficher les applications de cette source**.',
        { action: 'sources' },
      ],
    },
  },
  {
    id: 'uninstall',
    topic: 'apps',
    title: { en: 'Uninstall an app', fr: 'Désinstaller une application' },
    summary: { en: 'Remove an app you installed from Software.', fr: 'Retirer une application installée depuis la Logithèque.' },
    keywords: { en: ['uninstall', 'remove', 'delete app'], fr: ['désinstaller', 'supprimer', 'retirer une application'] },
    related: ['store'],
    actions: { installed: { app: 'store', args: { view: 'installed' } } },
    body: {
      en: [
        'Open **Software** › **Installed**, then click the remove button of the app, or open its page and click **Remove**.',
        { note: 'Apps marked **Included with Selene OS** are part of the system and cannot be removed.' },
        { action: 'installed' },
      ],
      fr: [
        'Ouvrez **Logithèque** › **Installés**, puis cliquez sur le bouton de suppression de l’application, ou ouvrez sa page et cliquez sur **Désinstaller**.',
        { note: 'Les applications marquées **Inclus avec Selene OS** font partie du système et ne peuvent pas être retirées.' },
        { action: 'installed' },
      ],
    },
  },
  {
    id: 'linux-apps',
    topic: 'apps',
    title: { en: 'Linux apps and office documents', fr: 'Applications Linux et documents bureautiques' },
    summary: { en: 'Apps such as LibreOffice or GIMP open in Selene windows.', fr: 'Des applications comme LibreOffice ou GIMP s’ouvrent dans des fenêtres Selene.' },
    keywords: { en: ['linux', 'libreoffice', 'gimp', 'vlc', 'word', 'excel', 'docx', 'office'], fr: ['linux', 'libreoffice', 'gimp', 'vlc', 'word', 'excel', 'docx', 'bureautique'] },
    related: ['store', 'default-apps'],
    actions: { store: { app: 'store' } },
    body: {
      en: [
        'Regular Linux applications installed from Software open in Selene windows: they get a bar button, {{Alt+Tab}} and window snapping, and they show up in the Launcher and the search.',
        'When you open a Word, Excel or PowerPoint document and no app can open it, Selene offers to install **LibreOffice** and then opens your document.',
        { action: 'store' },
      ],
      fr: [
        'Les applications Linux classiques installées depuis la Logithèque s’ouvrent dans des fenêtres Selene : elles ont leur bouton dans la barre, {{Alt+Tab}} et l’ancrage des fenêtres, et elles apparaissent dans le Lanceur et la recherche.',
        'Quand vous ouvrez un document Word, Excel ou PowerPoint et qu’aucune application ne sait l’ouvrir, Selene propose d’installer **LibreOffice**, puis ouvre votre document.',
        { action: 'store' },
      ],
    },
  },
  {
    id: 'default-apps',
    topic: 'apps',
    title: { en: 'Choose which app opens a file', fr: 'Choisir l’application qui ouvre un fichier' },
    summary: { en: 'Open with another app once, or change the default app for a file type.', fr: 'Ouvrir une fois avec une autre application, ou changer l’application par défaut d’un type de fichier.' },
    keywords: { en: ['open with', 'default app', 'file type', 'extension', 'association'], fr: ['ouvrir avec', 'application par défaut', 'type de fichier', 'extension', 'association'] },
    related: ['linux-apps', 'files-basics'],
    actions: { settings: { app: 'settings', args: { page: 'defaultApps' } } },
    body: {
      en: [
        { list: ['Once: in Files, right-click the file and choose **Open with**.', 'Always: **Settings** › **Apps** › **Default apps**, then pick the app for the file type. **Reset all default apps** goes back to Selene’s choices.'] },
        { action: 'settings' },
      ],
      fr: [
        { list: ['Une fois : dans Fichiers, faites un clic droit sur le fichier et choisissez **Ouvrir avec**.', 'Toujours : **Paramètres** › **Applications** › **Applications par défaut**, puis choisissez l’application pour le type de fichier. **Réinitialiser toutes les applications par défaut** revient aux choix de Selene.'] },
        { action: 'settings' },
      ],
    },
  },
  {
    id: 'books',
    topic: 'apps',
    title: { en: 'Read e-books', fr: 'Lire des livres numériques' },
    summary: { en: 'Read EPUB books on the computer.', fr: 'Lire des livres EPUB sur l’ordinateur.' },
    keywords: { en: ['books', 'ebook', 'epub', 'reading'], fr: ['livres', 'livre numérique', 'epub', 'lecture', 'liseuse'] },
    related: ['store'],
    requires: [{ app: 'books' }],
    actions: { open: { app: 'books' } },
    body: {
      en: ['This app reads e-books in the EPUB format. Find it in the Launcher, or open it here.', { action: 'open' }],
      fr: ['Cette application lit les livres numériques au format EPUB. Vous la trouverez dans le Lanceur, ou ouvrez-la ici.', { action: 'open' }],
    },
  },
  {
    id: 'feeds',
    topic: 'apps',
    title: { en: 'Podcasts and news', fr: 'Podcasts et actualités' },
    summary: { en: 'Follow podcasts and news feeds.', fr: 'Suivre des podcasts et des fils d’actualité.' },
    keywords: { en: ['podcast', 'news', 'rss', 'feed', 'atom'], fr: ['podcast', 'actualités', 'actus', 'rss', 'flux', 'fil'] },
    related: ['store'],
    requires: [{ app: 'feeds' }],
    actions: { open: { app: 'feeds' } },
    body: {
      en: ['This app follows podcasts and news feeds. Find it in the Launcher, or open it here.', { action: 'open' }],
      fr: ['Cette application suit des podcasts et des fils d’actualité. Vous la trouverez dans le Lanceur, ou ouvrez-la ici.', { action: 'open' }],
    },
  },
];
