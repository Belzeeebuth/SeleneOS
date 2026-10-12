// Settings app — page registry and search index (pure data: no DOM, importable from Node tests).
//
// PAGES: every page id the app understands. Other parts of the shell deep-link with
//   shell.launch('settings', { page, section })
// (the ids used by core/start.js, features/quick.js, security.js, winx.js, hotkeys.js, desktop.js and
// taskbar.js all exist here). `parent` builds the breadcrumb; `module` is the file in pages/ that renders it.
// INDEX: what the "Find a setting" box (and Start search, through manifest.json "searchIndex") finds.

// Navigation pane: System (the summary page) on top, then the categories grouped under small headings.
// The account ('accounts') is the user row at the bottom of the pane. NAV is the flat keyboard order (top to bottom).
export const NAV_GROUPS = [
  { id: 'home', title: null, items: ['system'] },
  { id: 'appearance', title: { en: 'Appearance', fr: 'Apparence' }, items: ['personalization', 'display'] },
  { id: 'connections', title: { en: 'Connections', fr: 'Connexions' }, items: ['network', 'bluetooth', 'sound'] },
  { id: 'system', title: { en: 'System', fr: 'Système' }, items: ['apps', 'timeLanguage', 'accessibility', 'privacy', 'update', 'about'] },
];
export const NAV_ACCOUNT = 'accounts';
export const NAV = [...NAV_GROUPS.flatMap((g) => g.items), NAV_ACCOUNT];

export const PAGES = {
  // System
  system: { module: 'system', icon: 'home', title: { en: 'Home', fr: 'Accueil' } },
  display: { module: 'system', icon: 'desktop', title: { en: 'Display', fr: 'Écran' }, desc: { en: 'Resolution, scale, brightness, night light', fr: 'Résolution, échelle, luminosité, éclairage nocturne' } },
  sound: { module: 'system', icon: 'speaker_2', title: { en: 'Sound', fr: 'Son' }, desc: { en: 'Volume levels, output, input, sound devices', fr: 'Niveaux de volume, sortie, entrée, périphériques audio' } },
  notifications: { module: 'system', parent: 'system', icon: 'alert', title: { en: 'Notifications', fr: 'Notifications' }, desc: { en: 'Alerts from apps and system, do not disturb', fr: 'Alertes des applications et du système, ne pas déranger' } },
  power: { module: 'system', parent: 'system', icon: 'power', title: { en: 'Power', fr: 'Alimentation' }, desc: { en: 'Screen lock, battery, sleep and shutdown', fr: 'Verrouillage de l’écran, batterie, veille et arrêt' } },
  storage: { module: 'system', parent: 'system', icon: 'hard_drive', title: { en: 'Storage', fr: 'Stockage' }, desc: { en: 'Storage space, drives, recycle bin', fr: 'Espace de stockage, lecteurs, corbeille' } },
  multitasking: { module: 'system', parent: 'system', icon: 'window_multiple', title: { en: 'Window management', fr: 'Fenêtres' }, desc: { en: 'Layouts, desktops, switching between windows', fr: 'Dispositions, bureaux, passage d’une fenêtre à l’autre' } },
  clipboard: { module: 'system', parent: 'system', icon: 'clipboard_paste', title: { en: 'Clipboard', fr: 'Presse-papiers' }, desc: { en: 'Cut and copy history', fr: 'Historique du couper et copier' } },
  gpuDrivers: { module: 'drivers', parent: 'system', icon: 'developer_board', title: { en: 'Graphics drivers', fr: 'Pilotes graphiques' }, desc: { en: 'Graphics cards, NVIDIA drivers', fr: 'Cartes graphiques, pilotes NVIDIA' } },
  about: { module: 'system', icon: 'info', title: { en: 'About', fr: 'À propos' }, desc: { en: 'Device name, device and Selene OS specifications', fr: 'Nom de l’appareil, caractéristiques de l’appareil et de Selene OS' } },
  // Devices
  bluetooth: { module: 'devices', icon: 'bluetooth', title: { en: 'Devices', fr: 'Appareils' } },
  mouse: { module: 'devices', parent: 'bluetooth', icon: 'cursor', title: { en: 'Mouse', fr: 'Souris' }, desc: { en: 'Buttons, mouse pointer speed', fr: 'Boutons, vitesse du pointeur de la souris' } },
  typing: { module: 'devices', parent: 'bluetooth', icon: 'keyboard', title: { en: 'Typing', fr: 'Saisie' }, desc: { en: 'Keyboard layout, typing test', fr: 'Disposition du clavier, test de saisie' } },
  printers: { module: 'devices', parent: 'bluetooth', icon: 'print', title: { en: 'Printers & scanners', fr: 'Imprimantes et scanners' }, desc: { en: 'Preferences, troubleshoot', fr: 'Préférences, résolution des problèmes' } },
  // Network
  network: { module: 'network', icon: 'globe', title: { en: 'Network', fr: 'Réseau' } },
  wifi: { module: 'network', parent: 'network', icon: 'wifi_1', title: { en: 'Wi-Fi', fr: 'Wi-Fi' }, desc: { en: 'Connect, manage known networks', fr: 'Se connecter, gérer les réseaux connus' } },
  ethernet: { module: 'network', parent: 'network', icon: 'plug_connected', title: { en: 'Ethernet', fr: 'Ethernet' }, desc: { en: 'Authentication, IP and DNS settings', fr: 'Authentification, paramètres IP et DNS' } },
  advancedNetwork: { module: 'network', parent: 'network', icon: 'data_usage', title: { en: 'Advanced network settings', fr: 'Paramètres réseau avancés' }, desc: { en: 'View all network adapters, data usage', fr: 'Afficher toutes les cartes réseau, utilisation des données' } },
  // Personalization
  personalization: { module: 'personalization', icon: 'paint_brush', title: { en: 'Personalization', fr: 'Personnalisation' } },
  // Background + Lock screen: area B1 (pages/personalization-wallpaper.js)
  background: { module: 'personalization-wallpaper', parent: 'personalization', icon: 'image', title: { en: 'Background', fr: 'Arrière-plan' }, desc: { en: 'Picture, color, slideshow, animated or dynamic wallpaper', fr: 'Image, couleur, diaporama, fond d’écran animé ou dynamique' } },
  colors: { module: 'personalization', parent: 'personalization', icon: 'color', title: { en: 'Colors', fr: 'Couleurs' }, desc: { en: 'Accent color, transparency effects, color theme', fr: 'Couleur d’accentuation, effets de transparence, thème de couleur' } },
  themes: { module: 'personalization', parent: 'personalization', icon: 'paint_brush_sparkle', title: { en: 'Themes', fr: 'Thèmes' }, desc: { en: 'Install, create, manage, desktop icons', fr: 'Choisir, gérer, icônes du bureau' } },
  lockscreen: { module: 'personalization-wallpaper', parent: 'personalization', icon: 'lock_closed', title: { en: 'Lock screen', fr: 'Écran de verrouillage' }, desc: { en: 'Lock screen image, picture of the day, animation, screen timeout', fr: 'Image de l’écran de verrouillage, image du jour, animation, délai d’expiration' } },
  start: { module: 'personalization-taskbar', parent: 'personalization', icon: 'apps', title: { en: 'Launcher', fr: 'Lanceur' }, desc: { en: 'Layout, pinned apps, folders, recent files, background', fr: 'Disposition, applications épinglées, dossiers, fichiers récents, arrière-plan' } },
  taskbar: { module: 'personalization-taskbar', parent: 'personalization', icon: 'panel_bottom', title: { en: 'Taskbar', fr: 'Barre' }, desc: { en: 'Size, position, icons, meters, transparency, auto-hide', fr: 'Taille, position, icônes, indicateurs, transparence, masquage automatique' } },
  // Personalization (docs/PERSONALIZATION.md) — area A: pages/personalization-designer.js
  themeDesigner: { module: 'personalization-designer', parent: 'personalization', icon: 'window_brush', title: { en: 'Theme designer', fr: 'Concepteur de thème' }, desc: { en: 'Style, colors, transparency, blur, corners and fonts with a live preview', fr: 'Style, couleurs, transparence, flou, coins et polices avec un aperçu en direct' } },
  visualStyle: { module: 'personalization-designer', parent: 'personalization', icon: 'style_guide', title: { en: 'Visual style', fr: 'Style visuel' }, desc: { en: 'Nocturne, Éclipse, Clair de lune, high contrast', fr: 'Nocturne, Éclipse, Clair de lune, contraste élevé' } },
  profiles: { module: 'personalization-designer', parent: 'personalization', icon: 'collections', title: { en: 'Profiles', fr: 'Profils' }, desc: { en: 'Save your whole look and switch with one click', fr: 'Enregistrez toute votre apparence et changez en un clic' } },
  appThemes: { module: 'personalization-designer', parent: 'personalization', icon: 'window_apps', title: { en: 'App themes', fr: 'Thèmes des applications' }, desc: { en: 'Light, dark or custom accent for each app', fr: 'Clair, sombre ou couleur d’accentuation pour chaque application' } },
  // Personalization areas B1 (wallpaper), B2 (focus: personalization-focus.js) and B3 (packs + input)
  wallpaperEffects: { module: 'personalization-wallpaper', parent: 'personalization', icon: 'image_sparkle', title: { en: 'Animated & dynamic wallpapers', fr: 'Fonds d’écran animés et dynamiques' }, desc: { en: 'Moving scenes, time of day and weather', fr: 'Scènes animées, heure du jour et météo' } },
  focus: { module: 'personalization-focus', parent: 'personalization', icon: 'target', title: { en: 'Focus', fr: 'Concentration' }, desc: { en: 'Hide notifications, dim the desktop, simplify the taskbar', fr: 'Masquer les notifications, assombrir le bureau, simplifier la barre' } },
  cursors: { module: 'personalization-packs', parent: 'personalization', icon: 'cursor', title: { en: 'Cursors', fr: 'Curseurs' }, desc: { en: 'Mouse pointer packs', fr: 'Packs de pointeurs de souris' } },
  iconPacks: { module: 'personalization-packs', parent: 'personalization', icon: 'icons', title: { en: 'Icon packs', fr: 'Packs d’icônes' }, desc: { en: 'App and file icons', fr: 'Icônes des applications et des fichiers' } },
  soundPacks: { module: 'personalization-packs', parent: 'personalization', icon: 'music_note_2', title: { en: 'Sound packs', fr: 'Packs de sons' }, desc: { en: 'Notification, startup and shutdown sounds', fr: 'Sons des notifications, du démarrage et de l’arrêt' } },
  shortcuts: { module: 'personalization-input', parent: 'personalization', icon: 'keyboard', title: { en: 'Keyboard shortcuts', fr: 'Raccourcis clavier' }, desc: { en: 'Change or turn off shell shortcuts', fr: 'Modifier ou désactiver les raccourcis du bureau' } },
  snapPresets: { module: 'personalization-input', parent: 'personalization', icon: 'layout_column_two_split_right', title: { en: 'Layouts', fr: 'Dispositions' }, desc: { en: 'Your own window layout presets', fr: 'Vos propres dispositions de fenêtres' } },
  // Apps
  apps: { module: 'apps', icon: 'apps_list', title: { en: 'Apps', fr: 'Applications' } },
  installedApps: { module: 'apps', parent: 'apps', icon: 'apps_list_detail', title: { en: 'Installed apps', fr: 'Applications installées' }, desc: { en: 'Open, find and manage apps', fr: 'Ouvrir, rechercher et gérer les applications' } },
  defaultApps: { module: 'apps', parent: 'apps', icon: 'apps_settings', title: { en: 'Default apps', fr: 'Applications par défaut' }, desc: { en: 'Defaults for file types', fr: 'Valeurs par défaut des types de fichiers' } },
  // Accounts
  accounts: { module: 'accounts', icon: 'person', title: { en: 'Accounts', fr: 'Comptes' } },
  yourInfo: { module: 'accounts', parent: 'accounts', icon: 'person_circle', title: { en: 'Your info', fr: 'Vos informations' }, desc: { en: 'Profile photo, name, account type', fr: 'Photo de profil, nom, type de compte' } },
  signIn: { module: 'accounts', parent: 'accounts', icon: 'key', title: { en: 'Sign-in options', fr: 'Options de connexion' }, desc: { en: 'Password, automatic sign-in', fr: 'Mot de passe, connexion automatique' } },
  users: { module: 'accounts', parent: 'accounts', icon: 'people', title: { en: 'Other users', fr: 'Autres utilisateurs' }, desc: { en: 'Device access, add or remove accounts', fr: 'Accès à l’appareil, ajouter ou supprimer des comptes' } },
  // Time & language
  timeLanguage: { module: 'time', icon: 'local_language', title: { en: 'Language & time', fr: 'Langue et heure' } },
  time: { module: 'time', parent: 'timeLanguage', icon: 'clock', title: { en: 'Date & time', fr: 'Date et heure' }, desc: { en: 'Time zones, automatic clock settings, calendar display', fr: 'Fuseaux horaires, réglage automatique de l’horloge, affichage' } },
  language: { module: 'time', parent: 'timeLanguage', icon: 'local_language', title: { en: 'Language & region', fr: 'Langue et région' }, desc: { en: 'Display language, regional format', fr: 'Langue d’affichage, format régional' } },
  keyboard: { module: 'time', parent: 'timeLanguage', icon: 'keyboard', title: { en: 'Keyboard', fr: 'Clavier' }, desc: { en: 'Keyboard layout for this session and for new sessions', fr: 'Disposition du clavier pour cette session et les nouvelles sessions' } },
  // Accessibility
  accessibility: { module: 'accessibility', icon: 'accessibility', title: { en: 'Accessibility', fr: 'Accessibilité' } },
  textSize: { module: 'accessibility', parent: 'accessibility', icon: 'text_font_size', title: { en: 'Text size', fr: 'Taille du texte' }, desc: { en: 'Text size throughout Selene and your apps', fr: 'Taille du texte dans Selene et vos applications' } },
  visualEffects: { module: 'accessibility', parent: 'accessibility', icon: 'eye', title: { en: 'Visual effects', fr: 'Effets visuels' }, desc: { en: 'Transparency, animations', fr: 'Transparence, animations' } },
  // Privacy
  privacy: { module: 'privacy', icon: 'shield', title: { en: 'Privacy', fr: 'Confidentialité' } },
  // Update
  update: { module: 'update', icon: 'arrow_sync', title: { en: 'Updates', fr: 'Mises à jour' } },
  updateHistory: { module: 'update', parent: 'update', icon: 'history', title: { en: 'Update history', fr: 'Historique des mises à jour' }, desc: { en: 'Installed updates', fr: 'Mises à jour installées' } },
  // Search results (pseudo page)
  search: { module: null, icon: 'search', title: { en: 'Search results', fr: 'Résultats de la recherche' } },
};

// Old / alternative names (ms-settings style, other apps) -> page ids.
export const ALIASES = {
  home: 'system',
  'display-advanced': 'display',
  nightlight: 'display',
  'night-light': 'display',
  'sound-devices': 'sound',
  powersleep: 'power',
  battery: 'power',
  storagesense: 'storage',
  about: 'about',
  bluetooth: 'bluetooth',
  devices: 'bluetooth',
  mousetouchpad: 'mouse',
  printer: 'printers',
  'network-status': 'network',
  'network-wifi': 'wifi',
  'network-ethernet': 'ethernet',
  'network-advancedsettings': 'advancedNetwork',
  datausage: 'advancedNetwork',
  airplane: 'network',
  'network-airplanemode': 'network',
  'personalization-background': 'background',
  'personalization-colors': 'colors',
  'personalization-start': 'start',
  'personalization-taskbar': 'taskbar',
  themedesigner: 'themeDesigner',
  'theme-designer': 'themeDesigner',
  designer: 'themeDesigner',
  visualstyle: 'visualStyle',
  styles: 'visualStyle',
  'personalization-profiles': 'profiles',
  appthemes: 'appThemes',
  'app-themes': 'appThemes',
  wallpapereffects: 'wallpaperEffects',
  'animated-wallpaper': 'wallpaperEffects',
  'dynamic-wallpaper': 'wallpaperEffects',
  focusmode: 'focus',
  'focus-mode': 'focus',
  cursorpacks: 'cursors',
  iconpacks: 'iconPacks',
  soundpacks: 'soundPacks',
  sounds: 'soundPacks',
  keyboardshortcuts: 'shortcuts',
  'keyboard-shortcuts': 'shortcuts',
  snappresets: 'snapPresets',
  'snap-layouts': 'snapPresets',
  'apps-list': 'installedApps',
  appsfeatures: 'installedApps',
  installed: 'installedApps',
  defaultapps: 'defaultApps',
  yourinfo: 'yourInfo',
  signinoptions: 'signIn',
  otherusers: 'users',
  family: 'users',
  dateandtime: 'time',
  datetime: 'time',
  regionlanguage: 'language',
  region: 'language',
  timelanguage: 'timeLanguage',
  'time-language': 'timeLanguage',
  easeofaccess: 'accessibility',
  'easeofaccess-display': 'textSize',
  'easeofaccess-visualeffects': 'visualEffects',
  textsize: 'textSize',
  visualeffects: 'visualEffects',
  'privacy-security': 'privacy',
  security: 'privacy',
  windowsupdate: 'update',
  'windowsupdate-history': 'updateHistory',
  updatehistory: 'updateHistory',
  'keyboard-layout': 'keyboard',
  drivers: 'gpuDrivers',
  'graphics-drivers': 'gpuDrivers',
  graphicsdrivers: 'gpuDrivers',
  'additional-drivers': 'gpuDrivers',
  gpu: 'gpuDrivers',
  nvidia: 'gpuDrivers',
};

// (page, section) pairs that live on another page.
const SECTION_REDIRECTS = {
  'accessibility/animations': ['visualEffects', 'animations'],
  'accessibility/transparency': ['visualEffects', 'transparency'],
  'accounts/password': ['signIn', 'password'],
  'accounts/picture': ['yourInfo', 'picture'],
  'accounts/autologin': ['signIn', 'autologin'],
  'personalization/mode': ['colors', 'mode'],
  'personalization/style': ['visualStyle', null],
  'personalization/designer': ['themeDesigner', null],
  'accessibility/reducedMotion': ['visualEffects', 'reducedMotion'],
  'accessibility/textScale': ['textSize', 'textScale'],
  'system/display': ['display', null],
  'network/wifi': ['wifi', null],
};

/** Normalise a deep link: returns { page, section } with a page id that exists. */
export function resolvePage(page, section) {
  let p = page == null || page === '' ? 'system' : String(page);
  if (!PAGES[p]) {
    const k = p.toLowerCase().replace(/^ms-settings:/, '');
    p = ALIASES[k] || Object.keys(PAGES).find((id) => id.toLowerCase() === k) || 'system';
  }
  const r = section ? SECTION_REDIRECTS[`${p}/${section}`] : null;
  if (r) return { page: r[0], section: r[1] };
  if (p === 'search') return { page: 'system', section: null };
  return { page: p, section: section || null };
}

/** Breadcrumb chain of a page: ['system', 'display'] */
export function crumbs(page) {
  const out = [];
  let p = page;
  while (p && PAGES[p] && out.length < 4) {
    out.unshift(p);
    p = PAGES[p].parent;
  }
  return out;
}

/** Top-level category of a page (for the nav selection). */
export function categoryOf(page) {
  return crumbs(page)[0] || 'system';
}

// [page, section, icon, en, fr, keywords en, keywords fr]
const ENTRIES = [
  ['display', null, 'desktop', 'Display', 'Écran', 'screen monitor', 'moniteur'],
  ['display', 'resolution', 'desktop', 'Display resolution', 'Résolution de l’écran', 'screen size pixels mode', 'taille pixels mode'],
  ['display', 'refresh', 'desktop', 'Refresh rate', 'Fréquence d’actualisation', 'hz frequency', 'hz fréquence'],
  ['display', 'scale', 'zoom_in', 'Scale', 'Échelle', 'dpi zoom size bigger', 'ppp zoom taille agrandir'],
  ['display', 'brightness', 'brightness_high', 'Brightness', 'Luminosité', 'backlight dim', 'rétroéclairage'],
  ['display', 'nightLight', 'weather_moon', 'Night light', 'Éclairage nocturne', 'blue light warm color', 'lumière bleue couleur chaude'],
  ['sound', null, 'speaker_2', 'Sound', 'Son', 'audio', 'audio'],
  ['sound', 'output', 'speaker_2', 'Choose where to play sound', 'Choisir où lire le son', 'output speakers headphones device', 'sortie haut-parleurs casque périphérique'],
  ['sound', 'volume', 'speaker_2', 'Volume', 'Volume', 'loud mute', 'fort muet couper'],
  ['sound', 'input', 'mic', 'Microphone', 'Microphone', 'input recording', 'entrée enregistrement'],
  ['sound', 'systemSounds', 'music_note_2', 'System sounds', 'Sons système', 'beep chime startup', 'bip démarrage'],
  ['notifications', null, 'alert', 'Notifications', 'Notifications', 'alerts toasts banners', 'alertes bannières'],
  ['notifications', 'dnd', 'alert_snooze', 'Do not disturb', 'Ne pas déranger', 'focus quiet dnd silence', 'concentration silence'],
  ['power', null, 'power', 'Power', 'Alimentation', 'energy', 'énergie'],
  ['power', 'lock', 'lock_closed', 'Lock screen after', 'Verrouiller l’écran après', 'timeout idle inactivity screen off', 'délai inactivité veille'],
  ['power', 'battery', 'battery_6', 'Battery', 'Batterie', 'charge laptop', 'charge portable'],
  ['power', 'buttons', 'power', 'Shut down or restart', 'Arrêter ou redémarrer', 'shutdown reboot sleep suspend', 'arrêt redémarrage veille'],
  ['storage', null, 'hard_drive', 'Storage', 'Stockage', 'disk space drive free', 'disque espace lecteur libre'],
  ['storage', 'recycle', 'delete', 'Empty recycle bin', 'Vider la corbeille', 'trash cleanup', 'nettoyage'],
  ['multitasking', null, 'window_multiple', 'Window management', 'Fenêtres', 'multitasking snap windows layouts', 'multitâche ancrer fenêtres dispositions'],
  ['multitasking', 'snap', 'layout_column_two', 'Window layouts', 'Disposer les fenêtres', 'snap layouts assist', 'dispositions ancrage ancrer'],
  ['multitasking', 'shake', 'window_multiple', 'Title bar window shake', 'Secouer la barre de titre', 'aero shake minimize', 'secouer réduire'],
  ['clipboard', null, 'clipboard_paste', 'Clipboard history', 'Historique du Presse-papiers', 'copy paste win+v', 'copier coller'],
  ['about', null, 'info', 'About', 'À propos', 'specifications version build system information', 'caractéristiques version build informations système'],
  ['about', 'rename', 'rename', 'Device name', 'Nom de l’appareil', 'rename hostname computer name pc', 'renommer nom de l’ordinateur hôte pc'],
  ['about', 'specs', 'desktop_tower', 'Device information', 'Informations sur l’appareil', 'processor cpu ram memory specifications copy', 'processeur mémoire caractéristiques copier'],
  ['bluetooth', null, 'bluetooth', 'Devices', 'Appareils', 'bluetooth pair', 'bluetooth jumeler'],
  ['mouse', null, 'cursor', 'Mouse', 'Souris', 'pointer speed buttons touchpad', 'pointeur vitesse boutons pavé tactile'],
  ['mouse', 'primary', 'cursor_click', 'Primary mouse button', 'Bouton principal de la souris', 'left handed swap', 'gaucher inverser'],
  ['typing', null, 'keyboard', 'Typing', 'Saisie', 'keyboard', 'clavier'],
  ['printers', null, 'print', 'Printers & scanners', 'Imprimantes et scanners', 'print scan', 'imprimer numériser'],
  ['network', null, 'globe', 'Network', 'Réseau', 'internet connection status', 'internet connexion état'],
  ['network', 'airplane', 'airplane', 'Airplane mode', 'Mode avion', 'flight offline radios', 'vol hors ligne'],
  ['wifi', null, 'wifi_1', 'Wi-Fi', 'Wi-Fi', 'wifi wireless wlan hotspot networks', 'wifi sans fil réseaux'],
  ['wifi', 'known', 'wifi_1', 'Manage known networks', 'Gérer les réseaux connus', 'wifi forget saved', 'wifi oublier enregistrés'],
  ['wifi', 'hidden', 'wifi_lock', 'Hidden network', 'Réseau masqué', 'ssid not broadcast', 'ssid non diffusé'],
  ['ethernet', null, 'plug_connected', 'Ethernet', 'Ethernet', 'wired cable lan ip address mac dns', 'filaire câble adresse ip mac dns'],
  ['advancedNetwork', null, 'data_usage', 'Data usage', 'Utilisation des données', 'bandwidth traffic adapters', 'bande passante trafic cartes'],
  ['personalization', null, 'paint_brush', 'Personalization', 'Personnalisation', 'customize appearance', 'personnaliser apparence'],
  ['personalization', 'finish', 'paint_brush_sparkle', 'Theme', 'Thème', 'finish look halo prisme sobre glass colourful colorful icons', 'finition apparence halo prisme sobre verre icônes colorées'],
  ['personalization', 'finish', 'paint_brush_sparkle', 'Halo', 'Halo', 'theme tinted glass colourful colorful icons luminous wallpaper', 'thème verre teinté icônes colorées fond lumineux'],
  ['personalization', 'finish', 'paint_brush_sparkle', 'Prisme', 'Prisme', 'theme prism frosted glass glossy icons aurora wallpaper', 'thème prisme verre givré icônes brillantes aurore fond'],
  ['personalization', 'finish', 'paint_brush_sparkle', 'Sobre', 'Sobre', 'theme plain flat muted icons night', 'thème uni sobre icônes discrètes nuit'],
  ['personalization', 'customizeTheme', 'window_brush', 'Customize the theme', 'Personnaliser le thème', 'style ambiance accent wallpaper transparency blur icons', 'style ambiance accent fond transparence flou icônes'],
  ['personalization', 'tintFromWallpaper', 'image_sparkle', 'Tint windows with the wallpaper', 'Teinter les fenêtres selon le fond d’écran', 'mica glass colour color wallpaper tint', 'mica verre couleur teinte fond d’écran'],
  ['personalization', 'iconPack', 'icons', 'Icon set of the theme', 'Jeu d’icônes du thème', 'automatic icons halo prisme selene pack', 'automatique icônes halo prisme selene pack'],
  ['background', null, 'image', 'Background', 'Arrière-plan', 'wallpaper desktop picture', 'fond d’écran image bureau'],
  ['background', 'fit', 'image', 'Choose a fit for your desktop image', 'Choisir un ajustement pour l’image', 'fill fit stretch center tile', 'remplir ajuster étirer centrer mosaïque'],
  ['colors', null, 'color', 'Colors', 'Couleurs', 'accent', 'accentuation'],
  ['colors', 'mode', 'dark_theme', 'Choose your mode', 'Choisir votre mode', 'dark light theme night', 'sombre clair thème'],
  ['colors', 'mode', 'dark_theme', 'Dark mode', 'Mode sombre', 'dark night theme black', 'sombre nuit thème noir'],
  ['colors', 'mode', 'weather_sunny', 'Light mode', 'Mode clair', 'light day theme white', 'clair jour thème blanc'],
  ['colors', 'transparency', 'blur', 'Transparency effects', 'Effets de transparence', 'acrylic mica blur', 'acrylique flou'],
  ['colors', 'accent', 'color', 'Accent color', 'Couleur d’accentuation', 'highlight', 'surbrillance'],
  ['themes', null, 'paint_brush_sparkle', 'Themes', 'Thèmes', 'theme preset', 'thème'],
  ['themes', 'desktopIcons', 'desktop', 'Desktop icon settings', 'Paramètres des icônes du bureau', 'show icons size', 'afficher icônes taille'],
  ['lockscreen', null, 'lock_closed', 'Lock screen', 'Écran de verrouillage', 'lock picture', 'image verrouillage'],
  ['start', null, 'apps', 'Launcher', 'Lanceur', 'start menu recommended recent', 'menu démarrer recommandé récent'],
  ['taskbar', null, 'panel_bottom', 'Taskbar', 'Barre', 'taskbar', 'barre'],
  ['taskbar', 'align', 'panel_bottom', 'Taskbar alignment', 'Alignement de la barre', 'left center', 'gauche centre'],
  ['taskbar', 'autohide', 'panel_bottom', 'Automatically hide the taskbar', 'Masquer automatiquement la barre', 'auto hide', 'masquer'],
  ['taskbar', 'items', 'search', 'Taskbar items', 'Éléments de la barre', 'search overview dashboard widgets', 'recherche vue d’ensemble tableau de bord widgets'],
  ['themeDesigner', null, 'window_brush', 'Theme designer', 'Concepteur de thème', 'customize look appearance preview create theme', 'personnaliser apparence aperçu créer thème'],
  ['themeDesigner', 'blur', 'blur', 'Blur intensity', 'Intensité du flou', 'frosted glass acrylic', 'verre dépoli acrylique'],
  ['themeDesigner', 'transparencyLevel', 'transparency_square', 'Window transparency', 'Transparence des fenêtres', 'translucent opacity see through mica', 'translucide opacité mica'],
  ['themeDesigner', 'corners', 'shapes', 'Rounded corners', 'Coins arrondis', 'radius square round shape', 'rayon carré arrondi forme'],
  ['themeDesigner', 'font', 'text_font', 'Font', 'Police', 'typeface font family serif monospace pixel', 'police caractères empattements chasse fixe pixel'],
  ['themeDesigner', 'taskbarColor', 'panel_bottom', 'Taskbar color', 'Couleur de la barre', 'accent taskbar colour', 'accentuation barre couleur'],
  ['themeDesigner', 'taskbarOpacity', 'transparency_square', 'Taskbar transparency', 'Transparence de la barre', 'taskbar opacity translucent', 'barre opacité translucide'],
  ['themeDesigner', 'accentFromWallpaper', 'image_sparkle', 'Accent color from wallpaper', 'Couleur d’accentuation d’après le fond d’écran', 'automatic accent picture', 'accentuation automatique image'],
  ['visualStyle', null, 'style_guide', 'Visual style', 'Style visuel', 'style look skin nocturne eclipse clair de lune high contrast', 'style apparence nocturne éclipse clair de lune contraste élevé'],
  ['visualStyle', null, 'style_guide', 'High contrast', 'Contraste élevé', 'contrast accessibility black yellow', 'contraste accessibilité noir jaune'],
  ['visualStyle', null, 'style_guide', 'Nocturne style', 'Style Nocturne', 'islands floating bar cold silver', 'îlots barre flottante froid argent'],
  ['visualStyle', null, 'style_guide', 'Éclipse and Clair de lune styles', 'Styles Éclipse et Clair de lune', 'eclipse clair de lune full width pills amber violet', 'éclipse clair de lune pleine largeur pilules ambre violet'],
  ['profiles', null, 'collections', 'Profiles', 'Profils', 'theme profile save switch export import', 'profil thème enregistrer changer exporter importer'],
  ['appThemes', null, 'window_apps', 'App themes', 'Thèmes des applications', 'per app dark mode light accent', 'par application mode sombre clair accentuation'],
  ['colors', 'mode', 'clock', 'Automatic dark mode', 'Mode sombre automatique', 'auto schedule night time of day', 'auto programmation nuit heure'],
  ['wallpaperEffects', null, 'image_sparkle', 'Animated & dynamic wallpapers', 'Fonds d’écran animés et dynamiques', 'live animated moving dynamic time weather', 'animé dynamique heure météo'],
  ['wallpaperEffects', 'animated', 'image_sparkle', 'Animated wallpaper', 'Fond d’écran animé', 'live moving aurora bloom fluid gradient bokeh particles stars night sky waves effect', 'animé aurore boréale floraison dégradé fluide bokeh particules étoiles ciel nuit vagues effet'],
  ['wallpaperEffects', 'fps', 'fps_30', 'Wallpaper frame rate', 'Fréquence d’images du fond d’écran', 'fps frames per second speed performance battery', 'images par seconde vitesse performance batterie'],
  ['wallpaperEffects', 'dynamic', 'weather_sunny_low', 'Dynamic wallpaper (time of day)', 'Fond d’écran dynamique (heure du jour)', 'sunrise sunset dawn dusk night day', 'lever coucher soleil aube crépuscule nuit jour'],
  ['wallpaperEffects', 'weather', 'weather_rain', 'Weather wallpaper', 'Fond d’écran météo', 'rain snow clouds fog storm forecast', 'pluie neige nuages brouillard orage prévisions'],
  ['wallpaperEffects', 'location', 'location', 'Wallpaper location', 'Lieu du fond d’écran', 'city sun times latitude longitude', 'ville heures soleil latitude longitude'],
  ['wallpaperEffects', 'follow', 'dark_theme', 'Dark mode follows the sun', 'Mode sombre selon le soleil', 'sunset automatic theme', 'coucher automatique thème'],
  ['background', 'slideshow', 'image_multiple', 'Wallpaper slideshow', 'Diaporama de fonds d’écran', 'rotate pictures folder album interval', 'faire défiler images dossier album intervalle'],
  ['lockscreen', 'mode', 'image_sparkle', 'Lock screen picture of the day', 'Image du jour de l’écran de verrouillage', 'spotlight daily rotate animated', 'quotidien rotation animé'],
  ['focus', null, 'target', 'Focus', 'Concentration', 'focus mode distraction dim notifications concentrate', 'mode distraction assombrir notifications'],
  ['focus', 'duration', 'timer', 'Focus session length', 'Durée de la session de concentration', 'timer minutes pomodoro', 'minuteur minutes pomodoro'],
  ['focus', 'dimDesktop', 'dark_theme', 'Dim the desktop during focus', 'Assombrir le bureau pendant la concentration', 'darken wallpaper', 'assombrir fond'],
  ['cursors', null, 'cursor', 'Cursors', 'Curseurs', 'mouse pointer pack theme large yellow', 'pointeur souris pack thème grand jaune'],
  ['iconPacks', null, 'icons', 'Icon packs', 'Packs d’icônes', 'icons theme pack tiles graphite outline', 'icônes thème pack tuiles graphite contour'],
  ['soundPacks', null, 'music_note_2', 'Sound packs', 'Packs de sons', 'notification startup shutdown sounds scheme', 'notification démarrage arrêt sons'],
  ['soundPacks', 'ev-notification', 'alert', 'Notification sound', 'Son des notifications', 'toast alert chime', 'alerte carillon'],
  ['soundPacks', 'ev-startup', 'power', 'Startup sound', 'Son de démarrage', 'boot logon login', 'ouverture session'],
  ['soundPacks', 'ev-shutdown', 'arrow_exit', 'Shutdown sound', 'Son d’arrêt', 'power off logout sign out', 'éteindre déconnexion'],
  ['shortcuts', null, 'keyboard', 'Keyboard shortcuts', 'Raccourcis clavier', 'hotkeys keys bindings', 'touches raccourcis'],
  ['snapPresets', null, 'layout_column_two_split_right', 'Layout presets', 'Dispositions personnalisées', 'snap layouts windows presets', 'ancrage fenêtres'],
  ['cursors', 'cursorSize', 'cursor', 'Pointer size', 'Taille du pointeur', 'cursor mouse bigger large accessibility', 'curseur souris plus grand accessibilité'],
  ['soundPacks', 'soundVolume', 'speaker_1', 'Volume of system sounds', 'Volume des sons système', 'sound level quiet loud', 'niveau son fort faible'],
  ['soundPacks', 'startupSound', 'power', 'Play the startup sound', 'Jouer le son de démarrage', 'boot sign in chime', 'ouverture session carillon'],
  ['shortcuts', 'scApps', 'apps', 'Keyboard shortcuts to open apps', 'Raccourcis clavier pour ouvrir des applications', 'launch app hotkey', 'lancer application touche'],
  ['snapPresets', 'snapBar', 'layout_column_two_split_right', 'Layouts when dragging a window', 'Dispositions en faisant glisser une fenêtre', 'drag top screen snap bar assist', 'glisser haut écran ancrage assistance'],
  ['taskbar', 'position', 'panel_bottom', 'Taskbar position', 'Position de la barre', 'top left right bottom edge vertical', 'haut gauche droite bas bord vertical'],
  ['taskbar', 'size', 'resize', 'Taskbar size', 'Taille de la barre', 'small large icons', 'petite grande icônes'],
  ['taskbar', 'combine', 'stack', 'Combine taskbar buttons', 'Combiner les boutons de la barre', 'group labels windows', 'grouper étiquettes fenêtres'],
  ['taskbar', 'labels', 'text_case_title', 'Show app names on the taskbar', 'Afficher le nom des applications', 'labels titles', 'étiquettes titres'],
  ['taskbar', 'widgets', 'data_usage', 'Taskbar meters', 'Indicateurs de la barre', 'widgets weather cpu memory network meter', 'widgets météo processeur mémoire réseau'],
  ['taskbar', 'pinned', 'pin', 'Pinned apps on the taskbar', 'Applications épinglées dans la barre', 'pin unpin reorder icons', 'épingler désépingler ordre icônes'],
  ['start', 'layout', 'layout_row_two', 'Launcher layout', 'Disposition du Lanceur', 'more pins recommendations list', 'plus d’épingles recommandations liste'],
  ['start', 'background', 'paint_brush', 'Launcher background', 'Arrière-plan du Lanceur', 'acrylic solid accent wallpaper', 'acrylique uni accentuation fond'],
  ['start', 'folders', 'folder', 'Folders next to the power button', 'Dossiers à côté du bouton d’alimentation', 'documents downloads settings', 'documents téléchargements paramètres'],
  ['start', 'groups', 'folder', 'App folders in the Launcher', 'Dossiers d’applications dans le Lanceur', 'group pinned apps', 'grouper applications épinglées'],
  ['textSize', 'textScale', 'text_font_size', 'Text size', 'Taille du texte', 'font bigger smaller', 'police plus grand plus petit'],
  ['visualEffects', 'reducedMotion', 'accessibility', 'Reduce motion', 'Réduire les animations', 'motion animations vestibular', 'mouvement animations'],
  ['apps', null, 'apps_list', 'Apps', 'Applications', 'programs', 'programmes'],
  ['installedApps', null, 'apps_list_detail', 'Installed apps', 'Applications installées', 'programs list open', 'programmes liste ouvrir'],
  ['defaultApps', null, 'apps_settings', 'Default apps', 'Applications par défaut', 'open with file association type extension', 'ouvrir avec association type extension'],
  ['accounts', null, 'person', 'Accounts', 'Comptes', 'user profile', 'utilisateur profil'],
  ['yourInfo', 'picture', 'person_circle', 'Account picture', 'Photo du compte', 'avatar photo profile', 'avatar photo profil'],
  ['yourInfo', 'name', 'person_edit', 'Change your name', 'Modifier votre nom', 'full name display name', 'nom complet'],
  ['signIn', 'password', 'password', 'Change your password', 'Modifier votre mot de passe', 'password sign in', 'mot de passe connexion'],
  ['signIn', 'autologin', 'person_key', 'Automatic sign-in', 'Connexion automatique', 'auto login autologin', 'ouverture de session automatique'],
  ['users', null, 'people', 'Other users', 'Autres utilisateurs', 'add user account family remove', 'ajouter utilisateur compte famille supprimer'],
  ['timeLanguage', null, 'local_language', 'Language & time', 'Langue et heure', 'clock', 'horloge'],
  ['time', null, 'clock', 'Date & time', 'Date et heure', 'clock date', 'horloge date'],
  ['time', 'timezone', 'globe_clock', 'Time zone', 'Fuseau horaire', 'timezone utc region', 'utc région'],
  ['time', 'ntp', 'arrow_sync', 'Set time automatically', 'Régler l’heure automatiquement', 'ntp sync internet time', 'ntp synchronisation'],
  ['time', 'clock24h', 'clock', '24-hour clock', 'Horloge 24 heures', 'am pm format', 'format'],
  ['time', 'seconds', 'clock', 'Show seconds in the taskbar clock', 'Afficher les secondes dans l’horloge', 'seconds', 'secondes'],
  ['language', null, 'local_language', 'Language & region', 'Langue et région', 'language region', 'langue région'],
  ['language', 'display', 'local_language', 'Display language', 'Langue d’affichage', 'english french français anglais', 'anglais français english french'],
  ['language', 'system', 'globe', 'System locale', 'Paramètres régionaux du système', 'locale format region', 'format région'],
  ['keyboard', null, 'keyboard', 'Keyboard layout', 'Disposition du clavier', 'azerty qwerty qwertz input', 'azerty qwerty qwertz saisie'],
  ['accessibility', null, 'accessibility', 'Accessibility', 'Accessibilité', 'ease of access vision', 'options d’ergonomie vision'],
  ['textSize', null, 'text_font_size', 'Text size', 'Taille du texte', 'bigger font zoom', 'police plus grande zoom'],
  ['visualEffects', 'animations', 'sparkle', 'Animation effects', 'Effets d’animation', 'motion reduce', 'mouvement réduire'],
  ['visualEffects', 'transparency', 'blur', 'Transparency effects', 'Effets de transparence', 'acrylic mica', 'acrylique'],
  ['privacy', null, 'shield', 'Privacy', 'Confidentialité', 'security permissions', 'sécurité autorisations'],
  ['privacy', 'firewall', 'shield_globe', 'Firewall & network protection', 'Pare-feu et protection du réseau', 'ufw firewall', 'ufw pare-feu'],
  ['privacy', 'device', 'shield_checkmark', 'Device security', 'Sécurité de l’appareil', 'apparmor secure boot tpm', 'apparmor démarrage sécurisé tpm'],
  ['update', null, 'arrow_sync', 'Updates', 'Mises à jour', 'update upgrade patches apt check', 'mise à jour correctifs apt rechercher'],
  ['updateHistory', null, 'history', 'Update history', 'Historique des mises à jour', 'installed updates log', 'mises à jour installées journal'],
  ['gpuDrivers', null, 'developer_board', 'Graphics drivers', 'Pilotes graphiques', 'driver drivers nvidia graphics card gpu geforce rtx gtx video', 'pilote pilotes nvidia carte graphique gpu geforce rtx gtx vidéo'],
  ['gpuDrivers', 'nvidia', 'developer_board', 'NVIDIA driver', 'Pilote NVIDIA', 'geforce rtx gtx proprietary open install driver', 'geforce rtx gtx propriétaire open installer pilote'],
  ['gpuDrivers', 'cards', 'developer_board', 'Graphics card', 'Carte graphique', 'gpu video card amd radeon intel driver', 'gpu carte vidéo amd radeon intel pilote'],
  ['gpuDrivers', 'free', 'arrow_undo', 'Free graphics driver (Nouveau)', 'Pilote graphique libre (Nouveau)', 'nouveau open source remove nvidia driver', 'nouveau libre retirer nvidia pilote'],
];

export const INDEX = ENTRIES.map(([page, section, icon, en, fr, kwEn, kwFr]) => ({ page, section, icon, name: { en, fr }, keywords: { en: kwEn.split(' '), fr: kwFr.split(' ') } }));

// Lower case, no accents, apostrophes as spaces, hyphens/dots dropped: "Wi-Fi" matches "wifi",
// "Sign-in" matches "sign in" and "signin", "l’heure" matches "heure".
const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’'`]/g, ' ')
    .replace(/[-‐‑_.]/g, '')
    .replace(/\s+/g, ' ');

/** Search the index: best matches first. lang = 'en' | 'fr' */
export function searchIndex(query, lang = 'en', limit = 12) {
  const q = norm(query).trim();
  if (!q) return [];
  const words = q.split(/\s+/);
  const scored = [];
  for (const e of INDEX) {
    const name = norm(e.name[lang] || e.name.en);
    const other = norm(lang === 'fr' ? e.name.en : e.name.fr);
    const kw = norm([...(e.keywords[lang] || []), ...(e.keywords.en || [])].join(' '));
    const title = norm(PAGES[e.page]?.title?.[lang]);
    let score = 0;
    if (name === q) score += 100;
    if (name.startsWith(q)) score += 60;
    else if (name.split(/\s+/).some((w) => w.startsWith(q))) score += 40;
    else if (name.includes(q)) score += 25;
    let all = true;
    for (const w of words) {
      if (name.includes(w)) score += 10;
      else if (kw.split(/\s+/).some((k) => k.startsWith(w))) score += 6;
      else if (other.includes(w) || title.includes(w)) score += 3;
      else all = false;
    }
    if (!all) continue;
    if (!e.section) score += 2;
    scored.push({ e, score });
  }
  scored.sort((a, b) => b.score - a.score || a.e.name[lang].localeCompare(b.e.name[lang]));
  const seen = new Set();
  const out = [];
  for (const { e } of scored) {
    const k = `${e.page}/${e.section || ''}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
    if (out.length >= limit) break;
  }
  return out;
}
