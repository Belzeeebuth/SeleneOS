// Settings app — page registry and search index (pure data: no DOM, importable from Node tests).
//
// PAGES: every page id the app understands. Other parts of the shell deep-link with
//   shell.launch('settings', { page, section })
// (the ids used by core/start.js, features/quick.js, security.js, winx.js, hotkeys.js, desktop.js and
// taskbar.js all exist here). `parent` builds the breadcrumb; `module` is the file in pages/ that renders it.
// INDEX: what the "Find a setting" box (and Start search, through manifest.json "searchIndex") finds.

export const NAV = ['system', 'bluetooth', 'network', 'personalization', 'apps', 'accounts', 'timeLanguage', 'accessibility', 'privacy', 'update'];

export const PAGES = {
  // System
  system: { module: 'system', icon: 'desktop', title: { en: 'System', fr: 'Système' } },
  display: { module: 'system', parent: 'system', icon: 'desktop', title: { en: 'Display', fr: 'Écran' }, desc: { en: 'Resolution, scale, brightness, night light', fr: 'Résolution, échelle, luminosité, éclairage nocturne' } },
  sound: { module: 'system', parent: 'system', icon: 'speaker_2', title: { en: 'Sound', fr: 'Son' }, desc: { en: 'Volume levels, output, input, sound devices', fr: 'Niveaux de volume, sortie, entrée, périphériques audio' } },
  notifications: { module: 'system', parent: 'system', icon: 'alert', title: { en: 'Notifications', fr: 'Notifications' }, desc: { en: 'Alerts from apps and system, do not disturb', fr: 'Alertes des applications et du système, ne pas déranger' } },
  power: { module: 'system', parent: 'system', icon: 'power', title: { en: 'Power', fr: 'Alimentation' }, desc: { en: 'Screen lock, battery, sleep and shutdown', fr: 'Verrouillage de l’écran, batterie, veille et arrêt' } },
  storage: { module: 'system', parent: 'system', icon: 'hard_drive', title: { en: 'Storage', fr: 'Stockage' }, desc: { en: 'Storage space, drives, recycle bin', fr: 'Espace de stockage, lecteurs, corbeille' } },
  multitasking: { module: 'system', parent: 'system', icon: 'window_multiple', title: { en: 'Multitasking', fr: 'Multitâche' }, desc: { en: 'Snap windows, desktops, task switching', fr: 'Ancrer les fenêtres, bureaux, basculement entre les tâches' } },
  clipboard: { module: 'system', parent: 'system', icon: 'clipboard_paste', title: { en: 'Clipboard', fr: 'Presse-papiers' }, desc: { en: 'Cut and copy history', fr: 'Historique du couper et copier' } },
  about: { module: 'system', parent: 'system', icon: 'info', title: { en: 'About', fr: 'Informations système' }, desc: { en: 'Device specifications, rename PC, Aurora OS specifications', fr: 'Caractéristiques de l’appareil, renommer le PC, caractéristiques d’Aurora OS' } },
  // Bluetooth & devices
  bluetooth: { module: 'devices', icon: 'bluetooth', title: { en: 'Bluetooth & devices', fr: 'Bluetooth et appareils' } },
  mouse: { module: 'devices', parent: 'bluetooth', icon: 'cursor', title: { en: 'Mouse', fr: 'Souris' }, desc: { en: 'Buttons, mouse pointer speed', fr: 'Boutons, vitesse du pointeur de la souris' } },
  typing: { module: 'devices', parent: 'bluetooth', icon: 'keyboard', title: { en: 'Typing', fr: 'Saisie' }, desc: { en: 'Keyboard layout, typing test', fr: 'Disposition du clavier, test de saisie' } },
  printers: { module: 'devices', parent: 'bluetooth', icon: 'print', title: { en: 'Printers & scanners', fr: 'Imprimantes et scanners' }, desc: { en: 'Preferences, troubleshoot', fr: 'Préférences, résolution des problèmes' } },
  // Network & internet
  network: { module: 'network', icon: 'globe', title: { en: 'Network & internet', fr: 'Réseau et Internet' } },
  wifi: { module: 'network', parent: 'network', icon: 'wifi_1', title: { en: 'Wi-Fi', fr: 'Wi-Fi' }, desc: { en: 'Connect, manage known networks', fr: 'Se connecter, gérer les réseaux connus' } },
  ethernet: { module: 'network', parent: 'network', icon: 'plug_connected', title: { en: 'Ethernet', fr: 'Ethernet' }, desc: { en: 'Authentication, IP and DNS settings', fr: 'Authentification, paramètres IP et DNS' } },
  advancedNetwork: { module: 'network', parent: 'network', icon: 'data_usage', title: { en: 'Advanced network settings', fr: 'Paramètres réseau avancés' }, desc: { en: 'View all network adapters, data usage', fr: 'Afficher toutes les cartes réseau, utilisation des données' } },
  // Personalization
  personalization: { module: 'personalization', icon: 'paint_brush', title: { en: 'Personalization', fr: 'Personnalisation' } },
  background: { module: 'personalization', parent: 'personalization', icon: 'image', title: { en: 'Background', fr: 'Arrière-plan' }, desc: { en: 'Background image, color, slideshow', fr: 'Image d’arrière-plan, couleur' } },
  colors: { module: 'personalization', parent: 'personalization', icon: 'color', title: { en: 'Colors', fr: 'Couleurs' }, desc: { en: 'Accent color, transparency effects, color theme', fr: 'Couleur d’accentuation, effets de transparence, thème de couleur' } },
  themes: { module: 'personalization', parent: 'personalization', icon: 'paint_brush_sparkle', title: { en: 'Themes', fr: 'Thèmes' }, desc: { en: 'Install, create, manage, desktop icons', fr: 'Choisir, gérer, icônes du bureau' } },
  lockscreen: { module: 'personalization', parent: 'personalization', icon: 'lock_closed', title: { en: 'Lock screen', fr: 'Écran de verrouillage' }, desc: { en: 'Lock screen image, screen timeout', fr: 'Image de l’écran de verrouillage, délai d’expiration' } },
  start: { module: 'personalization', parent: 'personalization', icon: 'apps', title: { en: 'Start', fr: 'Démarrer' }, desc: { en: 'Recent apps and items, folders', fr: 'Applications et éléments récents, dossiers' } },
  taskbar: { module: 'personalization', parent: 'personalization', icon: 'panel_bottom', title: { en: 'Taskbar', fr: 'Barre des tâches' }, desc: { en: 'Taskbar behaviors, items, alignment', fr: 'Comportements, éléments et alignement de la barre des tâches' } },
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
  timeLanguage: { module: 'time', icon: 'local_language', title: { en: 'Time & language', fr: 'Heure et langue' } },
  time: { module: 'time', parent: 'timeLanguage', icon: 'clock', title: { en: 'Date & time', fr: 'Date et heure' }, desc: { en: 'Time zones, automatic clock settings, calendar display', fr: 'Fuseaux horaires, réglage automatique de l’horloge, affichage' } },
  language: { module: 'time', parent: 'timeLanguage', icon: 'local_language', title: { en: 'Language & region', fr: 'Langue et région' }, desc: { en: 'Display language, regional format', fr: 'Langue d’affichage, format régional' } },
  keyboard: { module: 'time', parent: 'timeLanguage', icon: 'keyboard', title: { en: 'Keyboard', fr: 'Clavier' }, desc: { en: 'Keyboard layout for this session and for new sessions', fr: 'Disposition du clavier pour cette session et les nouvelles sessions' } },
  // Accessibility
  accessibility: { module: 'accessibility', icon: 'accessibility', title: { en: 'Accessibility', fr: 'Accessibilité' } },
  textSize: { module: 'accessibility', parent: 'accessibility', icon: 'text_font_size', title: { en: 'Text size', fr: 'Taille du texte' }, desc: { en: 'Text size throughout Aurora and your apps', fr: 'Taille du texte dans Aurora et vos applications' } },
  visualEffects: { module: 'accessibility', parent: 'accessibility', icon: 'eye', title: { en: 'Visual effects', fr: 'Effets visuels' }, desc: { en: 'Transparency, animations', fr: 'Transparence, animations' } },
  // Privacy & security
  privacy: { module: 'privacy', icon: 'shield', title: { en: 'Privacy & security', fr: 'Confidentialité et sécurité' } },
  // Update
  update: { module: 'update', icon: 'arrow_sync', title: { en: 'Aurora Update', fr: 'Aurora Update' } },
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
};

// (page, section) pairs that live on another page.
const SECTION_REDIRECTS = {
  'accessibility/animations': ['visualEffects', 'animations'],
  'accessibility/transparency': ['visualEffects', 'transparency'],
  'accounts/password': ['signIn', 'password'],
  'accounts/picture': ['yourInfo', 'picture'],
  'accounts/autologin': ['signIn', 'autologin'],
  'personalization/mode': ['colors', 'mode'],
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
  ['multitasking', null, 'window_multiple', 'Multitasking', 'Multitâche', 'snap windows layouts', 'ancrer fenêtres dispositions'],
  ['multitasking', 'snap', 'layout_column_two', 'Snap windows', 'Ancrer les fenêtres', 'snap layouts assist', 'dispositions ancrage'],
  ['multitasking', 'shake', 'window_multiple', 'Title bar window shake', 'Secouer la barre de titre', 'aero shake minimize', 'secouer réduire'],
  ['clipboard', null, 'clipboard_paste', 'Clipboard history', 'Historique du Presse-papiers', 'copy paste win+v', 'copier coller'],
  ['about', null, 'info', 'About', 'Informations système', 'specifications version build', 'caractéristiques version build'],
  ['about', 'rename', 'rename', 'Rename this PC', 'Renommer ce PC', 'hostname device name computer name', 'nom de l’appareil nom de l’ordinateur hôte'],
  ['about', 'specs', 'desktop_tower', 'Device specifications', 'Caractéristiques de l’appareil', 'processor cpu ram memory', 'processeur mémoire'],
  ['bluetooth', null, 'bluetooth', 'Bluetooth & devices', 'Bluetooth et appareils', 'devices pair', 'appareils jumeler'],
  ['mouse', null, 'cursor', 'Mouse', 'Souris', 'pointer speed buttons touchpad', 'pointeur vitesse boutons pavé tactile'],
  ['mouse', 'primary', 'cursor_click', 'Primary mouse button', 'Bouton principal de la souris', 'left handed swap', 'gaucher inverser'],
  ['typing', null, 'keyboard', 'Typing', 'Saisie', 'keyboard', 'clavier'],
  ['printers', null, 'print', 'Printers & scanners', 'Imprimantes et scanners', 'print scan', 'imprimer numériser'],
  ['network', null, 'globe', 'Network & internet', 'Réseau et Internet', 'connection status', 'connexion état'],
  ['network', 'airplane', 'airplane', 'Airplane mode', 'Mode avion', 'flight offline radios', 'vol hors ligne'],
  ['wifi', null, 'wifi_1', 'Wi-Fi', 'Wi-Fi', 'wireless wlan hotspot networks', 'sans fil réseaux'],
  ['wifi', 'known', 'wifi_1', 'Manage known networks', 'Gérer les réseaux connus', 'forget saved', 'oublier enregistrés'],
  ['wifi', 'hidden', 'wifi_lock', 'Hidden network', 'Réseau masqué', 'ssid not broadcast', 'ssid non diffusé'],
  ['ethernet', null, 'plug_connected', 'Ethernet', 'Ethernet', 'wired cable lan ip address mac dns', 'filaire câble adresse ip mac dns'],
  ['advancedNetwork', null, 'data_usage', 'Data usage', 'Utilisation des données', 'bandwidth traffic adapters', 'bande passante trafic cartes'],
  ['personalization', null, 'paint_brush', 'Personalization', 'Personnalisation', 'customize appearance', 'personnaliser apparence'],
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
  ['start', null, 'apps', 'Start', 'Démarrer', 'start menu recommended recent', 'menu démarrer recommandé récent'],
  ['taskbar', null, 'panel_bottom', 'Taskbar', 'Barre des tâches', 'taskbar', 'barre'],
  ['taskbar', 'align', 'panel_bottom', 'Taskbar alignment', 'Alignement de la barre des tâches', 'left center', 'gauche centre'],
  ['taskbar', 'autohide', 'panel_bottom', 'Automatically hide the taskbar', 'Masquer automatiquement la barre des tâches', 'auto hide', 'masquer'],
  ['taskbar', 'items', 'search', 'Taskbar items', 'Éléments de la barre des tâches', 'search task view widgets', 'recherche vue des tâches widgets'],
  ['apps', null, 'apps_list', 'Apps', 'Applications', 'programs', 'programmes'],
  ['installedApps', null, 'apps_list_detail', 'Installed apps', 'Applications installées', 'programs list open', 'programmes liste ouvrir'],
  ['defaultApps', null, 'apps_settings', 'Default apps', 'Applications par défaut', 'open with file association type extension', 'ouvrir avec association type extension'],
  ['accounts', null, 'person', 'Accounts', 'Comptes', 'user profile', 'utilisateur profil'],
  ['yourInfo', 'picture', 'person_circle', 'Account picture', 'Photo du compte', 'avatar photo profile', 'avatar photo profil'],
  ['yourInfo', 'name', 'person_edit', 'Change your name', 'Modifier votre nom', 'full name display name', 'nom complet'],
  ['signIn', 'password', 'password', 'Change your password', 'Modifier votre mot de passe', 'password sign in', 'mot de passe connexion'],
  ['signIn', 'autologin', 'person_key', 'Automatic sign-in', 'Connexion automatique', 'auto login autologin', 'ouverture de session automatique'],
  ['users', null, 'people', 'Other users', 'Autres utilisateurs', 'add user account family remove', 'ajouter utilisateur compte famille supprimer'],
  ['timeLanguage', null, 'local_language', 'Time & language', 'Heure et langue', 'clock', 'horloge'],
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
  ['privacy', null, 'shield', 'Privacy & security', 'Confidentialité et sécurité', 'security permissions', 'sécurité autorisations'],
  ['privacy', 'firewall', 'shield_globe', 'Firewall & network protection', 'Pare-feu et protection du réseau', 'ufw firewall', 'ufw pare-feu'],
  ['privacy', 'device', 'shield_checkmark', 'Device security', 'Sécurité de l’appareil', 'apparmor secure boot tpm', 'apparmor démarrage sécurisé tpm'],
  ['update', null, 'arrow_sync', 'Aurora Update', 'Aurora Update', 'updates upgrade patches apt check', 'mises à jour correctifs apt rechercher'],
  ['updateHistory', null, 'history', 'Update history', 'Historique des mises à jour', 'installed updates log', 'mises à jour installées journal'],
];

export const INDEX = ENTRIES.map(([page, section, icon, en, fr, kwEn, kwFr]) => ({ page, section, icon, name: { en, fr }, keywords: { en: kwEn.split(' '), fr: kwFr.split(' ') } }));

const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’']/g, ' ');

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
