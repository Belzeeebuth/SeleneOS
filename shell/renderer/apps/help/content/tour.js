// Aide — « Bien démarrer »: the tour (7 steps). `focus` picks what the schematic illustration highlights
// (main.js illustration(): bar, windows, quick, files, apps, personalize, help).
export default [
  {
    id: 'bar',
    focus: 'bar',
    icon: 'moon-stars',
    title: { en: 'The bar and the Launcher', fr: 'La barre et le Lanceur' },
    body: {
      en: [
        'The bar at the bottom of the screen gathers your apps. The crescent button on its left opens the **Launcher**: all your apps, your recent files and the power button.',
        'Quickest of all: press {{sc:start}} and type the name of an app, then {{Enter}}.',
      ],
      fr: [
        'La barre, en bas de l’écran, rassemble vos applications. Le bouton en forme de croissant, à sa gauche, ouvre le **Lanceur** : toutes vos applications, vos fichiers récents et le bouton Marche/Arrêt.',
        'Le plus rapide : appuyez sur {{sc:start}}, tapez le nom d’une application, puis {{Enter}}.',
      ],
    },
  },
  {
    id: 'windows',
    focus: 'windows',
    icon: 'app-window',
    title: { en: 'Open and arrange windows', fr: 'Ouvrir et disposer les fenêtres' },
    body: {
      en: [
        'Drag a window against the left or right edge of the screen to put it side by side with another one. Rest the pointer on the **Maximize** button to choose a **Layout**.',
        '{{Alt+Tab}} switches between windows, and {{sc:taskView}} opens the **Overview**, with your virtual desktops.',
      ],
      fr: [
        'Faites glisser une fenêtre contre le bord gauche ou droit de l’écran pour la placer à côté d’une autre. Laissez le pointeur sur le bouton **Agrandir** pour choisir une **Disposition**.',
        '{{Alt+Tab}} passe d’une fenêtre à l’autre, et {{sc:taskView}} ouvre la **Vue d’ensemble**, avec vos bureaux virtuels.',
      ],
    },
  },
  {
    id: 'quick',
    focus: 'quick',
    icon: 'sliders-horizontal',
    title: { en: 'Quick settings and notifications', fr: 'Réglages rapides et notifications' },
    body: {
      en: [
        'The network and volume icons on the right of the bar open **Quick settings** ({{sc:quickSettings}}): Wi-Fi, Bluetooth, volume, dark mode, Do not disturb…',
        'The bell next to the clock keeps your **notifications** ({{sc:notifications}}).',
      ],
      fr: [
        'Les icônes du réseau et du volume, à droite de la barre, ouvrent les **Réglages rapides** ({{sc:quickSettings}}) : Wi-Fi, Bluetooth, volume, mode sombre, Ne pas déranger…',
        'La cloche à côté de l’horloge garde vos **notifications** ({{sc:notifications}}).',
      ],
    },
  },
  {
    id: 'files',
    focus: 'files',
    icon: 'folder-simple',
    title: { en: 'Your files', fr: 'Vos fichiers' },
    actions: { files: { app: 'files' } },
    body: {
      en: [
        '**Files** ({{sc:files}}) keeps your documents, pictures and downloads. A USB stick shows in the side pane under **Devices**; eject it before you unplug it.',
        { action: 'files' },
      ],
      fr: [
        '**Fichiers** ({{sc:files}}) range vos documents, vos images et vos téléchargements. Une clé USB apparaît dans le volet latéral, sous **Appareils** ; éjectez-la avant de la débrancher.',
        { action: 'files' },
      ],
    },
  },
  {
    id: 'apps',
    focus: 'apps',
    icon: 'storefront',
    title: { en: 'Install apps', fr: 'Installer des applications' },
    actions: { store: { app: 'store' } },
    body: {
      en: [
        '**Software** offers thousands of apps: browsers, games, office suites… Apps from Flathub install for you, without a password.',
        { action: 'store' },
      ],
      fr: [
        'La **Logithèque** propose des milliers d’applications : navigateurs, jeux, bureautique… Celles de Flathub s’installent pour vous, sans mot de passe.',
        { action: 'store' },
      ],
    },
  },
  {
    id: 'personalize',
    focus: 'personalize',
    icon: 'palette',
    title: { en: 'Make it yours', fr: 'Personnaliser Selene' },
    actions: { settings: { app: 'settings', args: { page: 'personalization' } } },
    body: {
      en: [
        'In **Settings** › **Personalization**, choose a theme, a wallpaper, colours and your keyboard shortcuts. **Quick settings** also change the look in one click.',
        { action: 'settings' },
      ],
      fr: [
        'Dans **Paramètres** › **Personnalisation**, choisissez un thème, un fond d’écran, des couleurs et vos raccourcis clavier. Les **Réglages rapides** changent aussi l’apparence en un clic.',
        { action: 'settings' },
      ],
    },
  },
  {
    id: 'help',
    focus: 'help',
    icon: 'question',
    title: { en: 'Get help', fr: 'Trouver de l’aide' },
    actions: { shortcuts: { article: 'shortcuts', label: { en: 'See the keyboard shortcuts', fr: 'Voir les raccourcis clavier' } } },
    body: {
      en: [
        'This app, **Help**, answers your questions, even offline. Find it in the Launcher; in its window, press {{F1}} to search.',
        { action: 'shortcuts' },
      ],
      fr: [
        'Cette application, **Aide**, répond à vos questions, même hors ligne. Retrouvez-la dans le Lanceur ; dans sa fenêtre, appuyez sur {{F1}} pour chercher.',
        { action: 'shortcuts' },
      ],
    },
  },
];
