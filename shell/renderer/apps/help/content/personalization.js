// Aide — « Personnalisation ». Facts checked against apps/settings/pages/personalization*.js, core/theme.js,
// core/finishes.js, core/profiles.js, core/packs.js, core/features/quick.js, docs/PERSONALIZATION.md.
export default [
  {
    id: 'theme',
    topic: 'personalization',
    title: { en: 'Theme, style and colours', fr: 'Thème, style et couleurs' },
    summary: { en: 'Pick Halo, Prism or Plain, then a style, an ambiance and an accent colour.', fr: 'Choisir Halo, Prisme ou Sobre, puis un style, une ambiance et une couleur d’accent.' },
    keywords: { en: ['appearance', 'look', 'halo', 'prism', 'plain', 'nocturne', 'eclipse', 'clair de lune', 'accent', 'ambiance', 'colour', 'color'], fr: ['apparence', 'halo', 'prisme', 'sobre', 'nocturne', 'éclipse', 'clair de lune', 'accent', 'ambiance', 'couleur'] },
    related: ['dark-mode', 'wallpaper', 'profiles', 'personalize-more'],
    actions: { settings: { app: 'settings', args: { page: 'personalization' } }, style: { app: 'settings', args: { page: 'visualStyle' } } },
    body: {
      en: [
        'Open **Settings** › **Personalization**. At the top, the **Theme** sets the material of the whole desktop:',
        {
          list: [
            '**Halo**: glass tinted by the wallpaper, colourful icons, luminous wallpapers;',
            '**Prism**: frosted glass with a fine grain, glossy icons, aurora veils;',
            '**Plain**: matte opaque surfaces and muted icons.',
          ],
        },
        'Below, **Customize the theme** changes each part: the **Style** (Nocturne, Eclipse, Clair de lune or High contrast), the **Ambiance** (cold, neutral or warm), the **Accent colour**, the **Wallpaper**, the window transparency, the blur and the icon set.',
        { tip: '**Quick settings** › **Appearance** changes the theme, the style, the ambiance and the accent in one click.' },
        { actions: ['settings', 'style'] },
      ],
      fr: [
        'Ouvrez **Paramètres** › **Personnalisation**. En haut, le **Thème** définit la matière de tout le bureau :',
        {
          list: [
            '**Halo** : verre teinté par le fond d’écran, icônes colorées, fonds lumineux ;',
            '**Prisme** : verre dépoli au grain fin, icônes brillantes, voiles d’aurore ;',
            '**Sobre** : surfaces mates et opaques, icônes discrètes.',
          ],
        },
        'Plus bas, **Personnaliser le thème** règle chaque élément : le **Style** (Nocturne, Éclipse, Clair de lune ou Contraste élevé), l’**Ambiance** (froide, neutre ou chaude), la **Couleur d’accent**, le **Fond d’écran**, la transparence des fenêtres, le flou et le jeu d’icônes.',
        { tip: '**Réglages rapides** › **Apparence** change le thème, le style, l’ambiance et l’accent en un clic.' },
        { actions: ['settings', 'style'] },
      ],
    },
  },
  {
    id: 'dark-mode',
    topic: 'personalization',
    title: { en: 'Light or dark mode', fr: 'Mode clair ou sombre' },
    summary: { en: 'Switch between light and dark, by hand or at set times.', fr: 'Passer du clair au sombre, à la main ou à heures fixes.' },
    keywords: { en: ['dark', 'light', 'night', 'automatic', 'schedule', 'night light'], fr: ['sombre', 'clair', 'nuit', 'automatique', 'horaire', 'éclairage nocturne'] },
    related: ['theme', 'quick-settings'],
    actions: { settings: { app: 'settings', args: { page: 'colors', section: 'mode' } } },
    body: {
      en: [
        'The fastest way: the **Dark mode** tile of Quick settings ({{sc:quickSettings}}).',
        'In **Settings** › **Personalization** › **Colors**, **Choose your mode** offers **Light**, **Dark** and **Auto**. With Auto, Selene switches at the times you choose (7:00 and 19:00 at first).',
        'The **Night light** tile of Quick settings gives the screen warmer colours, easier on the eyes at night.',
        { action: 'settings' },
      ],
      fr: [
        'Le plus rapide : la vignette **Mode sombre** des Réglages rapides ({{sc:quickSettings}}).',
        'Dans **Paramètres** › **Personnalisation** › **Couleurs**, **Choisir votre mode** propose **Clair**, **Sombre** et **Auto**. En mode Auto, Selene change aux heures que vous choisissez (7 h et 19 h au départ).',
        'La vignette **Éclairage nocturne** des Réglages rapides donne à l’écran des couleurs plus chaudes, plus douces pour les yeux la nuit.',
        { action: 'settings' },
      ],
    },
  },
  {
    id: 'wallpaper',
    topic: 'personalization',
    title: { en: 'Wallpaper and lock screen', fr: 'Fond d’écran et écran de verrouillage' },
    summary: { en: 'Your own photo, a slideshow, an animated or a dynamic wallpaper.', fr: 'Votre photo, un diaporama, un fond animé ou dynamique.' },
    keywords: { en: ['background', 'change wallpaper', 'picture', 'photo', 'slideshow', 'animated', 'dynamic', 'lock screen'], fr: ['arrière-plan', 'changer le fond d’écran', 'image', 'photo', 'diaporama', 'animé', 'dynamique', 'écran de verrouillage'] },
    related: ['theme', 'desktop-icons'],
    actions: { bg: { app: 'settings', args: { page: 'background' } }, lock: { app: 'settings', args: { page: 'lockscreen' } } },
    body: {
      en: [
        'Right-click the desktop and choose **Personalize**, then **Background**. **Personalize your background** offers:',
        {
          list: [
            '**Picture**: a Selene picture, or your own with **Browse photos**;',
            '**Solid color**;',
            '**Slideshow**: the pictures of a folder, changed at the interval you choose;',
            '**Animated**: a moving scene (aurora, night sky, waves…);',
            '**Dynamic (time of day)**: a picture that follows dawn, day, dusk and night, and even the weather if you wish.',
          ],
        },
        'In Files, right-click a picture and choose **Set as background**.',
        { tip: 'The lock screen has its own picture: **Personalization** › **Lock screen**.' },
        { actions: ['bg', 'lock'] },
      ],
      fr: [
        'Faites un clic droit sur le bureau, choisissez **Personnaliser**, puis **Arrière-plan**. **Personnaliser votre arrière-plan** propose :',
        {
          list: [
            '**Image** : une image de Selene, ou la vôtre avec **Parcourir les photos** ;',
            '**Couleur unie** ;',
            '**Diaporama** : les images d’un dossier, qui changent à l’intervalle choisi ;',
            '**Animé** : une scène en mouvement (aurore boréale, ciel étoilé, vagues…) ;',
            '**Dynamique (heure du jour)** : une image qui suit l’aube, le jour, le crépuscule et la nuit, et même la météo si vous le souhaitez.',
          ],
        },
        'Dans Fichiers, faites un clic droit sur une image et choisissez **Choisir comme arrière-plan**.',
        { tip: 'L’écran de verrouillage a sa propre image : **Personnalisation** › **Écran de verrouillage**.' },
        { actions: ['bg', 'lock'] },
      ],
    },
  },
  {
    id: 'personalize-bar',
    topic: 'personalization',
    title: { en: 'Customize the bar and the Launcher', fr: 'Personnaliser la barre et le Lanceur' },
    summary: { en: 'Position, size and hiding of the bar; layout and background of the Launcher.', fr: 'Position, taille et masquage de la barre ; disposition et arrière-plan du Lanceur.' },
    keywords: { en: ['taskbar', 'position', 'size', 'auto hide', 'labels', 'meters', 'launcher layout'], fr: ['barre', 'position', 'taille', 'masquer', 'noms', 'indicateurs', 'disposition du lanceur'] },
    related: ['bar', 'launcher'],
    actions: { bar: { app: 'settings', args: { page: 'taskbar' } }, start: { app: 'settings', args: { page: 'start' } } },
    body: {
      en: [
        { h: 'The bar' },
        {
          list: [
            '**Taskbar position on screen**: bottom, top, left or right; **Taskbar size**: small, medium or large.',
            '**Automatically hide the taskbar**, after the delay you choose.',
            '**Show app names**, the buttons for Search, Overview and Dashboard, and **Taskbar indicators** (weather, processor, memory, network speed).',
          ],
        },
        { h: 'The Launcher' },
        {
          list: [
            '**Layout**: more pins, more recent items, or the list of all apps.',
            '**Background style**: glass, solid, accent colour or wallpaper.',
            '**Folders** next to the power button, such as Documents or Downloads.',
          ],
        },
        { actions: ['bar', 'start'] },
      ],
      fr: [
        { h: 'La barre' },
        {
          list: [
            '**Position de la barre** : en bas, en haut, à gauche ou à droite ; **Taille de la barre** : petite, moyenne ou grande.',
            '**Masquer automatiquement la barre**, après le délai de votre choix.',
            '**Afficher le nom des applications**, les boutons Rechercher, Vue d’ensemble et Tableau de bord, et les **Indicateurs de la barre** (météo, processeur, mémoire, débit réseau).',
          ],
        },
        { h: 'Le Lanceur' },
        {
          list: [
            '**Disposition** : plus d’épingles, plus d’éléments récents, ou la liste de toutes les applications.',
            '**Style d’arrière-plan** : verre, uni, couleur d’accentuation ou fond d’écran.',
            '**Dossiers** à côté du bouton Marche/Arrêt, comme Documents ou Téléchargements.',
          ],
        },
        { actions: ['bar', 'start'] },
      ],
    },
  },
  {
    id: 'profiles',
    topic: 'personalization',
    title: { en: 'Profiles: save your look', fr: 'Profils : enregistrer votre apparence' },
    summary: { en: 'Keep a complete look and switch back to it in one click.', fr: 'Garder une apparence complète et y revenir en un clic.' },
    keywords: { en: ['profile', 'save', 'export', 'import', 'theme preset'], fr: ['profil', 'enregistrer', 'exporter', 'importer', 'apparence'] },
    related: ['theme'],
    actions: { settings: { app: 'settings', args: { page: 'profiles' } } },
    body: {
      en: [
        'In **Settings** › **Personalization** › **Profiles**, **Save current look** keeps your theme, colours, wallpaper, shortcuts, sounds and more under a name.',
        { list: ['**Apply** puts a profile back at once. Built-in profiles are ready to try.', 'The **…** menu of a profile lets you rename, update, duplicate, **Export** or delete it; **Import** reads an exported profile.'] },
        { action: 'settings' },
      ],
      fr: [
        'Dans **Paramètres** › **Personnalisation** › **Profils**, **Enregistrer l’apparence actuelle** garde sous un nom votre thème, vos couleurs, votre fond d’écran, vos raccourcis, vos sons et plus.',
        { list: ['**Appliquer** remet un profil en place aussitôt. Des profils intégrés sont prêts à essayer.', 'Le menu **…** d’un profil permet de le renommer, de le mettre à jour, de le dupliquer, de l’**Exporter** ou de le supprimer ; **Importer** lit un profil exporté.'] },
        { action: 'settings' },
      ],
    },
  },
  {
    id: 'personalize-more',
    topic: 'personalization',
    title: { en: 'Fonts, cursors, icons and sounds', fr: 'Police, curseurs, icônes et sons' },
    summary: { en: 'Text size and font, rounded corners, cursor, icon and sound packs.', fr: 'Taille et police du texte, coins arrondis, packs de curseurs, d’icônes et de sons.' },
    keywords: { en: ['font', 'text size', 'scale', 'corners', 'cursor', 'pointer', 'icon pack', 'sound pack', 'startup sound'], fr: ['police', 'taille du texte', 'échelle', 'coins', 'curseur', 'pointeur', 'pack d’icônes', 'pack de sons', 'son de démarrage'] },
    related: ['theme', 'accessibility-vision'],
    actions: { designer: { app: 'settings', args: { page: 'themeDesigner' } }, cursors: { app: 'settings', args: { page: 'cursors' } }, icons: { app: 'settings', args: { page: 'iconPacks' } }, sounds: { app: 'settings', args: { page: 'soundPacks' } } },
    body: {
      en: [
        {
          list: [
            '**Theme designer**: the **Font**, the **Text size**, **Scale everything** and **Rounded corners**.',
            '**Cursors**: a cursor pack and the pointer size.',
            '**Icon packs**: other app icons.',
            '**Sound packs**: the sounds of notifications, startup and shutdown, with your own sound files if you like.',
          ],
        },
        { actions: ['designer', 'cursors', 'icons', 'sounds'] },
      ],
      fr: [
        {
          list: [
            '**Concepteur de thème** : la **Police**, la **Taille du texte**, **Tout mettre à l’échelle** et les **Coins arrondis**.',
            '**Curseurs** : un pack de curseurs et la taille du pointeur.',
            '**Packs d’icônes** : d’autres icônes d’applications.',
            '**Packs de sons** : les sons des notifications, du démarrage et de l’arrêt, avec vos propres fichiers sonores si vous le souhaitez.',
          ],
        },
        { actions: ['designer', 'cursors', 'icons', 'sounds'] },
      ],
    },
  },
  {
    id: 'fonts-app',
    topic: 'personalization',
    title: { en: 'Fonts', fr: 'Polices' },
    summary: { en: 'See the fonts installed on this computer.', fr: 'Voir les polices installées sur cet ordinateur.' },
    keywords: { en: ['fonts', 'typeface', 'install font'], fr: ['polices', 'caractères', 'installer une police'] },
    related: ['personalize-more'],
    requires: [{ app: 'fonts' }],
    actions: { open: { app: 'fonts' } },
    body: {
      en: ['This app shows the fonts of this computer. Find it in the Launcher, or open it here.', { action: 'open' }],
      fr: ['Cette application présente les polices de cet ordinateur. Vous la trouverez dans le Lanceur, ou ouvrez-la ici.', { action: 'open' }],
    },
  },
];
