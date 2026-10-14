// Aide — « Le bureau et les fenêtres ». Facts checked against core/taskbar.js, core/start.js, core/wm.js,
// core/desktop.js, core/features/{quick,calendar,taskview,snaplayouts,alttab,focus,search,run,winx,widgets,hotkeys}.js.
export default [
  {
    id: 'launcher',
    topic: 'desktop',
    title: { en: 'The Launcher', fr: 'Le Lanceur' },
    summary: { en: 'Open apps, find files and settings, lock or turn off the computer.', fr: 'Ouvrir les applications, trouver fichiers et réglages, verrouiller ou éteindre l’ordinateur.' },
    keywords: { en: ['start', 'menu', 'apps', 'pin', 'power', 'shut down', 'restart', 'sleep', 'sign out', 'folder'], fr: ['démarrer', 'menu', 'applications', 'épingler', 'éteindre', 'arrêter', 'redémarrer', 'veille', 'déconnecter', 'dossier'] },
    related: ['bar', 'search', 'personalize-bar'],
    actions: { settings: { app: 'settings', args: { page: 'start' } } },
    body: {
      en: [
        'The Launcher is where every app lives. Open it with the crescent button on the left of the bar, or press {{sc:start}}. Press it again to close it.',
        'Start typing as soon as it opens: the search box finds apps, files and settings.',
        { h: 'What you find in it' },
        {
          list: [
            '**Pinned**: your favourite apps. **All apps** shows every app from A to Z.',
            '**Recent**: recently added apps and the files you opened lately.',
            'At the bottom, your name opens a menu with **Change account settings**, **Lock** and **Sign out**.',
            'The power button offers **Lock**, **Sleep**, **Shut down** and **Restart**.',
          ],
        },
        { h: 'Pin and arrange apps' },
        {
          steps: [
            'Click **All apps**, then right-click an app.',
            'Choose **Pin to Launcher** (or **Pin to the bar**).',
            'To make a folder, drag an app and hold it over another one for a moment.',
          ],
        },
        { tip: 'Right-click a pinned app for **Move to front**, **Unpin from Launcher** or **Add to folder**.' },
        { action: 'settings' },
      ],
      fr: [
        'Le Lanceur rassemble toutes les applications. Ouvrez-le avec le bouton en forme de croissant, à gauche de la barre, ou appuyez sur {{sc:start}}. Appuyez de nouveau pour le fermer.',
        'Tapez dès qu’il s’ouvre : la zone de recherche trouve les applications, les fichiers et les réglages.',
        { h: 'Ce qu’il contient' },
        {
          list: [
            '**Épinglées** : vos applications favorites. **Toutes les applications** les affiche toutes, de A à Z.',
            '**Récents** : les applications ajoutées récemment et les derniers fichiers ouverts.',
            'En bas, votre nom ouvre un menu avec **Modifier les paramètres du compte**, **Verrouiller** et **Se déconnecter**.',
            'Le bouton Marche/Arrêt propose **Verrouiller**, **Mettre en veille**, **Arrêter** et **Redémarrer**.',
          ],
        },
        { h: 'Épingler et ranger les applications' },
        {
          steps: [
            'Cliquez sur **Toutes les applications**, puis faites un clic droit sur une application.',
            'Choisissez **Épingler au Lanceur** (ou **Épingler à la barre**).',
            'Pour créer un dossier, faites glisser une application et maintenez-la un instant au-dessus d’une autre.',
          ],
        },
        { tip: 'Un clic droit sur une application épinglée propose **Placer en premier**, **Détacher du Lanceur** ou **Ajouter au dossier**.' },
        { action: 'settings' },
      ],
    },
  },
  {
    id: 'bar',
    topic: 'desktop',
    title: { en: 'The bar', fr: 'La barre' },
    summary: { en: 'Your apps in the middle, the Launcher on the left, status and clock on the right.', fr: 'Vos applications au centre, le Lanceur à gauche, l’état et l’horloge à droite.' },
    keywords: { en: ['taskbar', 'pin', 'clock', 'calendar', 'today', 'show desktop', 'tray'], fr: ['barre des tâches', 'épingler', 'horloge', 'calendrier', 'aujourd’hui', 'afficher le bureau', 'icônes'] },
    related: ['launcher', 'quick-settings', 'notifications', 'personalize-bar'],
    actions: { settings: { app: 'settings', args: { page: 'taskbar' } } },
    body: {
      en: [
        'The bar stays at the bottom of the screen. From left to right:',
        {
          list: [
            'the Launcher button, **Search** and **Overview**;',
            'in the middle, your pinned apps and the open ones;',
            'on the right, the network, volume and battery icons (they open **Quick settings**), then the clock.',
          ],
        },
        { h: 'Useful gestures' },
        {
          list: [
            'Click an app to open it, show it, or minimize it when it is already in front.',
            'Middle-click an app to open a new window of it.',
            'Right-click an app to **Pin to the bar**, **Unpin from the bar** or **Close window**.',
            'Click the clock for **Today** (calendar and agenda), and the bell next to it for your notifications.',
            'The thin strip at the far right end shows the desktop; click it again to bring the windows back.',
          ],
        },
        'Right-click an empty part of the bar for **Bar settings**: position, size, hiding the bar, app names and more.',
        { action: 'settings' },
      ],
      fr: [
        'La barre reste en bas de l’écran. De gauche à droite :',
        {
          list: [
            'le bouton du Lanceur, **Rechercher** et **Vue d’ensemble** ;',
            'au centre, vos applications épinglées et celles qui sont ouvertes ;',
            'à droite, les icônes du réseau, du volume et de la batterie (elles ouvrent les **Réglages rapides**), puis l’horloge.',
          ],
        },
        { h: 'Gestes utiles' },
        {
          list: [
            'Cliquez sur une application pour l’ouvrir, l’afficher, ou la réduire si elle est déjà au premier plan.',
            'Un clic du milieu ouvre une nouvelle fenêtre de l’application.',
            'Un clic droit sur une application propose **Épingler à la barre**, **Détacher de la barre** ou **Fermer la fenêtre**.',
            'Cliquez sur l’horloge pour **Aujourd’hui** (calendrier et agenda), et sur la cloche à côté pour vos notifications.',
            'La fine bande tout à droite affiche le bureau ; cliquez de nouveau pour retrouver les fenêtres.',
          ],
        },
        'Un clic droit sur une partie vide de la barre ouvre **Paramètres de la barre** : position, taille, masquage, nom des applications et plus.',
        { action: 'settings' },
      ],
    },
  },
  {
    id: 'windows',
    topic: 'desktop',
    title: { en: 'Open, move and arrange windows', fr: 'Ouvrir, déplacer et disposer les fenêtres' },
    summary: { en: 'Maximize, snap to the edges, switch with Alt+Tab, show the desktop.', fr: 'Agrandir, ancrer sur les bords, passer de l’une à l’autre avec Alt+Tab, afficher le bureau.' },
    keywords: { en: ['window', 'maximize', 'minimize', 'snap', 'alt tab', 'switch', 'close', 'side by side'], fr: ['fenêtre', 'agrandir', 'réduire', 'ancrer', 'alt tab', 'basculer', 'fermer', 'côte à côte'] },
    related: ['layouts', 'overview', 'shortcuts'],
    actions: { settings: { app: 'settings', args: { page: 'multitasking' } } },
    body: {
      en: [
        'Every app opens in its own window. The three buttons at the top right **Minimize**, **Maximize** and **Close** it. Double-click the title bar to maximize it or bring it back to its size.',
        { h: 'Put two windows side by side' },
        {
          list: [
            'Drag a window by its title bar to the left or right edge of the screen: it takes half of it.',
            'Drag it into a corner to give it a quarter, or to the top edge to maximize it.',
            'With the keyboard: {{sc:snapLeft}}, {{sc:snapRight}}, {{sc:maximize}} and {{sc:minimize}}.',
          ],
        },
        'More arrangements are in [[layouts]].',
        { h: 'Switch between windows' },
        {
          list: [
            'Hold {{Alt}} and press {{Tab}} to go through the open windows; release {{Alt}} to switch.',
            '{{sc:showDesktop}} shows the desktop, {{sc:minimizeAll}} minimizes every window.',
            '{{sc:windowMenu}} opens the window menu (move, size, close) and {{sc:closeWindow}} closes the window.',
          ],
        },
        { action: 'settings' },
      ],
      fr: [
        'Chaque application s’ouvre dans sa fenêtre. Les trois boutons en haut à droite servent à **Réduire**, **Agrandir** et **Fermer**. Double-cliquez sur la barre de titre pour agrandir la fenêtre ou lui rendre sa taille.',
        { h: 'Mettre deux fenêtres côte à côte' },
        {
          list: [
            'Faites glisser une fenêtre par sa barre de titre jusqu’au bord gauche ou droit de l’écran : elle en occupe la moitié.',
            'Dans un coin, elle en occupe un quart ; contre le bord du haut, elle s’agrandit.',
            'Au clavier : {{sc:snapLeft}}, {{sc:snapRight}}, {{sc:maximize}} et {{sc:minimize}}.',
          ],
        },
        'D’autres agencements sont présentés dans [[layouts]].',
        { h: 'Passer d’une fenêtre à l’autre' },
        {
          list: [
            'Maintenez {{Alt}} et appuyez sur {{Tab}} pour parcourir les fenêtres ouvertes ; relâchez {{Alt}} pour basculer.',
            '{{sc:showDesktop}} affiche le bureau, {{sc:minimizeAll}} réduit toutes les fenêtres.',
            '{{sc:windowMenu}} ouvre le menu de la fenêtre (déplacer, taille, fermer) et {{sc:closeWindow}} la ferme.',
          ],
        },
        { action: 'settings' },
      ],
    },
  },
  {
    id: 'layouts',
    topic: 'desktop',
    title: { en: 'Layouts', fr: 'Les Dispositions' },
    summary: { en: 'Place a window in a ready-made grid: halves, thirds, quarters, your own layouts.', fr: 'Placer une fenêtre dans une grille toute prête : moitiés, tiers, quarts, vos propres dispositions.' },
    keywords: { en: ['snap layouts', 'snap', 'grid', 'thirds', 'zones', 'tile'], fr: ['dispositions', 'ancrage', 'grille', 'tiers', 'zones', 'mosaïque'] },
    related: ['windows', 'overview'],
    actions: { settings: { app: 'settings', args: { page: 'snapPresets' } } },
    body: {
      en: [
        'Layouts place a window in one zone of a grid, and then suggest the other open windows for the remaining zones.',
        { h: 'Three ways to show them' },
        {
          list: [
            'Rest the pointer on the **Maximize** button of a window for a moment.',
            'Press {{sc:snapLayouts}}, then move with the arrow keys and press {{Enter}}.',
            'Drag a window towards the middle of the top edge of the screen.',
          ],
        },
        'Click a zone: the window goes there. Then pick, for each empty zone, which window should fill it.',
        { tip: 'In Settings, **Layouts** lets you make your own layouts (columns, rows, grid…) and choose which ones are offered.' },
        { action: 'settings' },
      ],
      fr: [
        'Les Dispositions placent une fenêtre dans une zone d’une grille, puis proposent les autres fenêtres ouvertes pour les zones restantes.',
        { h: 'Trois façons de les afficher' },
        {
          list: [
            'Laissez le pointeur un instant sur le bouton **Agrandir** d’une fenêtre.',
            'Appuyez sur {{sc:snapLayouts}}, déplacez-vous avec les flèches, puis appuyez sur {{Enter}}.',
            'Faites glisser une fenêtre vers le milieu du bord supérieur de l’écran.',
          ],
        },
        'Cliquez sur une zone : la fenêtre s’y place. Choisissez ensuite, pour chaque zone vide, la fenêtre qui doit la remplir.',
        { tip: 'Dans Paramètres, **Dispositions** permet de créer vos propres dispositions (colonnes, lignes, grille…) et de choisir celles qui sont proposées.' },
        { action: 'settings' },
      ],
    },
  },
  {
    id: 'overview',
    topic: 'desktop',
    title: { en: 'Overview and virtual desktops', fr: 'Vue d’ensemble et bureaux virtuels' },
    summary: { en: 'See all your windows at once and spread them over several desktops.', fr: 'Voir toutes vos fenêtres d’un coup et les répartir sur plusieurs bureaux.' },
    keywords: { en: ['task view', 'desktops', 'workspaces', 'virtual desktop', 'move window'], fr: ['bureaux', 'espaces de travail', 'bureau virtuel', 'déplacer une fenêtre', 'vue des tâches'] },
    related: ['windows', 'layouts'],
    body: {
      en: [
        '**Overview** shows every window of the current desktop side by side. Open it with the **Overview** button of the bar or press {{sc:taskView}}. Click a window to go to it.',
        { h: 'Virtual desktops' },
        'Virtual desktops keep separate sets of windows, for example one for work and one for leisure.',
        {
          list: [
            'In Overview, click **New desktop**, or press {{sc:newDesktop}}.',
            'Go to the previous or next desktop with {{sc:prevDesktop}} and {{sc:nextDesktop}}.',
            'To move a window, drag it onto another desktop in Overview, or right-click it and choose **Move to**.',
            'Click a desktop’s name to rename it. Closing a desktop ({{sc:closeDesktop}}) moves its windows to the desktop next to it.',
          ],
        },
      ],
      fr: [
        'La **Vue d’ensemble** montre côte à côte toutes les fenêtres du bureau en cours. Ouvrez-la avec le bouton **Vue d’ensemble** de la barre ou appuyez sur {{sc:taskView}}. Cliquez sur une fenêtre pour y aller.',
        { h: 'Bureaux virtuels' },
        'Les bureaux virtuels séparent vos fenêtres en plusieurs ensembles, par exemple un pour le travail et un pour les loisirs.',
        {
          list: [
            'Dans la Vue d’ensemble, cliquez sur **Nouveau bureau**, ou appuyez sur {{sc:newDesktop}}.',
            'Passez au bureau précédent ou suivant avec {{sc:prevDesktop}} et {{sc:nextDesktop}}.',
            'Pour déplacer une fenêtre, faites-la glisser sur un autre bureau dans la Vue d’ensemble, ou faites un clic droit dessus et choisissez **Déplacer vers**.',
            'Cliquez sur le nom d’un bureau pour le renommer. Fermer un bureau ({{sc:closeDesktop}}) déplace ses fenêtres sur le bureau voisin.',
          ],
        },
      ],
    },
  },
  {
    id: 'quick-settings',
    topic: 'desktop',
    title: { en: 'Quick settings', fr: 'Les Réglages rapides' },
    summary: { en: 'Wi-Fi, Bluetooth, volume, brightness, dark mode and more, one click away.', fr: 'Wi-Fi, Bluetooth, volume, luminosité, mode sombre et plus, à portée de clic.' },
    keywords: { en: ['volume', 'brightness', 'wifi', 'bluetooth', 'dark mode', 'night light', 'airplane', 'do not disturb'], fr: ['volume', 'luminosité', 'wifi', 'bluetooth', 'mode sombre', 'éclairage nocturne', 'avion', 'ne pas déranger'] },
    related: ['notifications', 'wifi', 'theme', 'bluetooth-pair'],
    body: {
      en: [
        'Click the network, volume and battery icons on the right of the bar, or press {{sc:quickSettings}}.',
        {
          list: [
            'Tiles turn things on and off: **Wi-Fi**, **Airplane mode**, **Bluetooth**, **Focus**, **Dark mode**, **Night light**, **Do not disturb**, **Accessibility**. Wi-Fi and Bluetooth only show when the computer has them.',
            'The small arrow of a tile opens more choices, for example the list of Wi-Fi networks.',
            'Sliders set the **Volume** and, on laptops, the **Brightness**.',
            '**Appearance** changes the theme, the style, the ambiance and the accent colour.',
          ],
        },
        'The gear button opens **Settings**.',
      ],
      fr: [
        'Cliquez sur les icônes du réseau, du volume et de la batterie, à droite de la barre, ou appuyez sur {{sc:quickSettings}}.',
        {
          list: [
            'Les vignettes activent ou désactivent : **Wi-Fi**, **Mode avion**, **Bluetooth**, **Concentration**, **Mode sombre**, **Éclairage nocturne**, **Ne pas déranger**, **Accessibilité**. Wi-Fi et Bluetooth n’apparaissent que si l’ordinateur en est équipé.',
            'La petite flèche d’une vignette ouvre plus de choix, par exemple la liste des réseaux Wi-Fi.',
            'Les curseurs règlent le **Volume** et, sur un portable, la **Luminosité**.',
            '**Apparence** change le thème, le style, l’ambiance et la couleur d’accent.',
          ],
        },
        'La roue dentée ouvre les **Paramètres**.',
      ],
    },
  },
  {
    id: 'notifications',
    topic: 'desktop',
    title: { en: 'Notifications and Do not disturb', fr: 'Notifications et Ne pas déranger' },
    summary: { en: 'Read missed messages, clear them, and silence the banners.', fr: 'Retrouver les messages manqués, les effacer et faire taire les bannières.' },
    keywords: { en: ['alerts', 'toast', 'banner', 'silence', 'mute', 'bell', 'dnd'], fr: ['alertes', 'bannière', 'silence', 'muet', 'cloche', 'messages'] },
    related: ['focus', 'quick-settings'],
    actions: { settings: { app: 'settings', args: { page: 'notifications' } } },
    body: {
      en: [
        'Messages from apps appear for a few seconds in the corner of the screen and are kept in the notification list.',
        {
          list: [
            'Open the list with the bell next to the clock, or press {{sc:notifications}}.',
            'Click a notification to open what it is about. **Clear all** empties the list; **Clear** empties one app’s notifications.',
            'Turn on **Do not disturb** in the list or in Quick settings: notifications still arrive in the list, without a banner or sound. Alarms and timers still ring.',
          ],
        },
        'In Settings, **Notifications** turns them off completely or turns off their sound.',
        { action: 'settings' },
      ],
      fr: [
        'Les messages des applications s’affichent quelques secondes dans le coin de l’écran et restent dans la liste des notifications.',
        {
          list: [
            'Ouvrez la liste avec la cloche à côté de l’horloge, ou appuyez sur {{sc:notifications}}.',
            'Cliquez sur une notification pour ouvrir ce qu’elle concerne. **Tout effacer** vide la liste ; **Effacer** vide les notifications d’une application.',
            'Activez **Ne pas déranger** dans la liste ou dans les Réglages rapides : les notifications arrivent toujours dans la liste, sans bannière ni son. Les alarmes et les minuteurs sonnent quand même.',
          ],
        },
        'Dans Paramètres, **Notifications** permet de les désactiver complètement ou de couper leur son.',
        { action: 'settings' },
      ],
    },
  },
  {
    id: 'focus',
    topic: 'desktop',
    title: { en: 'Focus', fr: 'La Concentration' },
    summary: { en: 'Hide notifications, dim the desktop and simplify the bar for a while.', fr: 'Masquer les notifications, assombrir le bureau et simplifier la barre, le temps d’une session.' },
    keywords: { en: ['concentrate', 'session', 'distraction', 'pomodoro', 'timer'], fr: ['concentration', 'session', 'distraction', 'pomodoro', 'minuteur'] },
    related: ['notifications', 'quick-settings'],
    actions: { settings: { app: 'settings', args: { page: 'focus' } } },
    body: {
      en: [
        'A Focus session hides notifications (Do not disturb), dims the desktop and keeps only the open apps on the bar.',
        {
          list: [
            'Start or end it with the **Focus** tile of Quick settings, the switch in the notification list, or {{sc:focusMode}}.',
            'While it runs, a **Focus** chip sits on the bar; click it to end the session or **Add 10 minutes**.',
            'In Settings, choose its length (until you turn it off, or 15 to 120 minutes) and what it changes.',
          ],
        },
        { action: 'settings' },
      ],
      fr: [
        'Une session de Concentration masque les notifications (Ne pas déranger), assombrit le bureau et ne garde dans la barre que les applications ouvertes.',
        {
          list: [
            'Démarrez-la ou arrêtez-la avec la vignette **Concentration** des Réglages rapides, l’interrupteur de la liste des notifications, ou {{sc:focusMode}}.',
            'Pendant la session, une pastille **Concentration** apparaît dans la barre ; cliquez dessus pour terminer la session ou **Ajouter 10 minutes**.',
            'Dans Paramètres, choisissez sa durée (jusqu’à ce que vous la désactiviez, ou de 15 à 120 minutes) et ce qu’elle modifie.',
          ],
        },
        { action: 'settings' },
      ],
    },
  },
  {
    id: 'search',
    topic: 'desktop',
    title: { en: 'Search, Run and the quick menu', fr: 'Rechercher, Exécuter et le Menu rapide' },
    summary: { en: 'Find an app, a file or a setting by typing a few letters.', fr: 'Trouver une application, un fichier ou un réglage en tapant quelques lettres.' },
    keywords: { en: ['find', 'look for', 'run', 'command', 'quick menu'], fr: ['trouver', 'chercher', 'exécuter', 'commande', 'menu rapide'] },
    related: ['launcher', 'files-basics'],
    body: {
      en: [
        'Press {{sc:search}}, or click **Search** on the bar, and type. Results are grouped: **Apps**, **Files** (in your home folder), **Settings** and **Web**.',
        { list: ['Choose a result with the arrow keys and press {{Enter}} to open it.', 'Right-click a result for more: pin an app, open a file’s location, copy its path.'] },
        { h: 'Run' },
        '{{sc:run}} opens **Run**: type the name of an app, a folder path or a web address, then **OK**.',
        { h: 'Quick menu' },
        'Right-click the Launcher button, or press {{sc:powerMenu}}, for a short menu: **Settings**, **System Monitor**, **Disks**, **Network**, lock, sign out, shut down or restart.',
      ],
      fr: [
        'Appuyez sur {{sc:search}}, ou cliquez sur **Rechercher** dans la barre, puis tapez. Les résultats sont groupés : **Applications**, **Fichiers** (de votre dossier personnel), **Réglages** et **Web**.',
        { list: ['Choisissez un résultat avec les flèches et appuyez sur {{Enter}} pour l’ouvrir.', 'Un clic droit sur un résultat propose d’autres actions : épingler une application, ouvrir l’emplacement d’un fichier, copier son chemin.'] },
        { h: 'Exécuter' },
        '{{sc:run}} ouvre **Exécuter** : tapez le nom d’une application, le chemin d’un dossier ou une adresse web, puis **OK**.',
        { h: 'Menu rapide' },
        'Un clic droit sur le bouton du Lanceur, ou {{sc:powerMenu}}, ouvre un petit menu : **Paramètres**, **Moniteur système**, **Disques**, **Réseau**, verrouiller, se déconnecter, éteindre ou redémarrer.',
      ],
    },
  },
  {
    id: 'screenshots',
    topic: 'desktop',
    title: { en: 'Screenshots and screen recordings', fr: 'Captures et enregistrements d’écran' },
    summary: { en: 'Capture an area of the screen, or record a video of it.', fr: 'Capturer une zone de l’écran, ou en faire une vidéo.' },
    keywords: { en: ['print screen', 'capture', 'snip', 'record', 'video'], fr: ['impr écran', 'capture', 'copie d’écran', 'enregistrer', 'vidéo'] },
    related: ['clipboard'],
    actions: { snip: { app: 'snipping' }, rec: { app: 'screenrec' } },
    body: {
      en: [
        'Press {{sc:screenshot}} or {{PrintScreen}}, then draw the area to capture. **Screenshot** lets you mark it up, save it or copy it.',
        '{{sc:screenRecord}} starts a screen recording; the same keys stop it. **Screen Recorder** saves the video in Videos.',
        { actions: ['snip', 'rec'] },
      ],
      fr: [
        'Appuyez sur {{sc:screenshot}} ou {{PrintScreen}}, puis tracez la zone à capturer. **Capture d’écran** permet de l’annoter, de l’enregistrer ou de la copier.',
        '{{sc:screenRecord}} lance un enregistrement de l’écran ; les mêmes touches l’arrêtent. L’**Enregistreur d’écran** range la vidéo dans Vidéos.',
        { actions: ['snip', 'rec'] },
      ],
    },
  },
  {
    id: 'clipboard',
    topic: 'desktop',
    title: { en: 'Clipboard history', fr: 'Historique du Presse-papiers' },
    summary: { en: 'Paste something you copied earlier, not only the last thing.', fr: 'Coller un texte copié plus tôt, pas seulement le dernier.' },
    keywords: { en: ['copy', 'paste', 'clipboard'], fr: ['copier', 'coller', 'presse papiers'] },
    related: ['screenshots'],
    actions: { settings: { app: 'settings', args: { page: 'clipboard' } } },
    body: {
      en: [
        'Press {{sc:clipboard}} to see the texts you copied. The history is off at first: click **Turn on** in the panel the first time.',
        { list: ['Click an item to paste it.', 'Its menu lets you **Pin** it (it stays) or **Delete** it. **Clear all** empties the history.'] },
        { note: 'The history keeps text only.' },
        { action: 'settings' },
      ],
      fr: [
        'Appuyez sur {{sc:clipboard}} pour voir les textes que vous avez copiés. L’historique est désactivé au départ : cliquez sur **Activer** dans le panneau la première fois.',
        { list: ['Cliquez sur un élément pour le coller.', 'Son menu permet de l’**Épingler** (il reste) ou de le **Supprimer**. **Tout effacer** vide l’historique.'] },
        { note: 'L’historique ne garde que du texte.' },
        { action: 'settings' },
      ],
    },
  },
  {
    id: 'dashboard',
    topic: 'desktop',
    title: { en: 'Dashboard', fr: 'Le Tableau de bord' },
    summary: { en: 'Weather, agenda, photos, system and quick notes in one panel.', fr: 'Météo, agenda, photos, système et notes rapides dans un panneau.' },
    keywords: { en: ['widgets', 'weather', 'agenda', 'notes'], fr: ['widgets', 'météo', 'agenda', 'notes'] },
    related: ['bar'],
    body: {
      en: [
        'Press {{sc:widgets}} to open the **Dashboard**: the weather, your agenda, photos from your Pictures folder, the processor and memory use, and quick notes.',
        'You can also show a **Dashboard** button on the bar in the bar settings.',
      ],
      fr: [
        'Appuyez sur {{sc:widgets}} pour ouvrir le **Tableau de bord** : la météo, votre agenda, des photos de votre dossier Images, l’utilisation du processeur et de la mémoire, et des notes rapides.',
        'Vous pouvez aussi afficher un bouton **Tableau de bord** dans la barre, depuis les paramètres de la barre.',
      ],
    },
  },
  {
    id: 'desktop-icons',
    topic: 'desktop',
    title: { en: 'The desktop', fr: 'Le bureau' },
    summary: { en: 'Icons, new folders and the right-click menu of the desktop.', fr: 'Les icônes, les nouveaux dossiers et le menu du clic droit sur le bureau.' },
    keywords: { en: ['wallpaper', 'icons', 'new folder', 'right click', 'trash', 'computer'], fr: ['fond d’écran', 'icônes', 'nouveau dossier', 'clic droit', 'corbeille', 'ordinateur'] },
    related: ['wallpaper', 'files-basics'],
    body: {
      en: [
        'The desktop shows **Computer**, the **Trash** and what you put in your Desktop folder.',
        'Right-click an empty spot for:',
        {
          list: [
            '**View**: icon size, auto arrange, or hide the icons;',
            '**Sort by**, **Refresh**, **Paste**;',
            '**New**: a folder or a text document;',
            '**Display settings**, **Personalize** (to change the wallpaper) and **Open in Terminal**.',
          ],
        },
      ],
      fr: [
        'Le bureau affiche **Ordinateur**, la **Corbeille** et ce que vous rangez dans votre dossier Bureau.',
        'Un clic droit sur un espace vide propose :',
        {
          list: [
            '**Affichage** : taille des icônes, organisation automatique, ou masquer les icônes ;',
            '**Trier par**, **Actualiser**, **Coller** ;',
            '**Nouveau** : un dossier ou un document texte ;',
            '**Paramètres d’affichage**, **Personnaliser** (pour changer le fond d’écran) et **Ouvrir dans le Terminal**.',
          ],
        },
      ],
    },
  },
  {
    id: 'emoji',
    topic: 'desktop',
    title: { en: 'Emoji and symbols', fr: 'Émojis et symboles' },
    summary: { en: 'Insert an emoji or a symbol into the text you are typing.', fr: 'Insérer un émoji ou un symbole dans le texte que vous tapez.' },
    keywords: { en: ['emoji', 'smiley', 'symbols', 'special characters'], fr: ['émoji', 'emoji', 'émoticône', 'smiley', 'symboles', 'caractères spéciaux'] },
    related: ['shortcuts'],
    // Built by another part of Selene: shown only when this computer has it (an app, a catalog shortcut, a Settings entry).
    requires: [{ find: true }],
    find: { apps: ['emoji'], names: [/emoji/i, /émoji/i], combos: ['Super+Period'] },
    body: {
      en: ['The emoji and symbols panel lets you pick an emoji or a symbol and insert it where you are typing.', { howto: true }],
      fr: ['Le panneau des émojis et symboles permet de choisir un émoji ou un symbole et de l’insérer là où vous tapez.', { howto: true }],
    },
  },
];
