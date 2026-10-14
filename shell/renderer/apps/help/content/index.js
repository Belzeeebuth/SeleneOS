// Aide — content index: topics (home tiles, in this order), every article, the « Bien démarrer » tour.
// One module per topic (content/<topic>.js), each article in English and French (see lib.js for the format).
// Rule: describe only what exists. Check the feature in the code before writing; articles about apps or features
// built elsewhere carry `requires` and stay hidden on a computer that does not have them.
import desktop from './desktop.js';
import shortcuts from './shortcuts.js';
import personalization from './personalization.js';
import files from './files.js';
import network from './network.js';
import { bluetooth, printers } from './devices.js';
import apps from './apps.js';
import updates from './updates.js';
import accounts from './accounts.js';
import backup from './backup.js';
import accessibility from './accessibility.js';
import install from './install.js';
import troubleshooting from './troubleshooting.js';
import privacy from './privacy.js';
import tour from './tour.js';

export const TOPICS = [
  { id: 'desktop', icon: 'app-window', title: { en: 'The desktop and windows', fr: 'Le bureau et les fenêtres' }, desc: { en: 'Launcher, bar, layouts, virtual desktops, Overview', fr: 'Lanceur, barre, dispositions, bureaux virtuels, Vue d’ensemble' } },
  { id: 'shortcuts', icon: 'keyboard', title: { en: 'Keyboard shortcuts', fr: 'Raccourcis clavier' }, desc: { en: 'Every shortcut, and how to change them', fr: 'Tous les raccourcis, et comment les modifier' } },
  { id: 'personalization', icon: 'palette', title: { en: 'Personalization', fr: 'Personnalisation' }, desc: { en: 'Theme, colours, wallpaper, bar and Launcher', fr: 'Thème, couleurs, fond d’écran, barre et Lanceur' } },
  { id: 'files', icon: 'folder-simple', title: { en: 'Files and USB sticks', fr: 'Fichiers et clés USB' }, desc: { en: 'Folders, USB sticks, Trash, archives', fr: 'Dossiers, clés USB, Corbeille, archives' } },
  { id: 'network', icon: 'wifi-high', title: { en: 'Internet and network', fr: 'Internet et réseau' }, desc: { en: 'Wi-Fi, airplane mode, VPN', fr: 'Wi-Fi, mode avion, VPN' } },
  { id: 'bluetooth', icon: 'bluetooth', title: { en: 'Bluetooth', fr: 'Bluetooth' }, desc: { en: 'Headphones, mice, keyboards, phones', fr: 'Casques, souris, claviers, téléphones' } },
  { id: 'printers', icon: 'printer', title: { en: 'Printers', fr: 'Imprimantes' }, desc: { en: 'Add a printer, print, ink and queue', fr: 'Ajouter une imprimante, imprimer, encre et file d’attente' } },
  { id: 'apps', icon: 'storefront', title: { en: 'Apps', fr: 'Applications' }, desc: { en: 'Software, Flathub, Linux apps, default apps', fr: 'Logithèque, Flathub, applications Linux, applications par défaut' } },
  { id: 'updates', icon: 'arrows-clockwise', title: { en: 'Updates', fr: 'Mises à jour' }, desc: { en: 'System, Selene, apps and firmware', fr: 'Système, Selene, applications et microprogrammes' } },
  { id: 'accounts', icon: 'lock-key', title: { en: 'Accounts and security', fr: 'Comptes et sécurité' }, desc: { en: 'Password, locking, users, firewall, Passwords app', fr: 'Mot de passe, verrouillage, utilisateurs, pare-feu, Mots de passe' } },
  { id: 'backup', icon: 'clock-counter-clockwise', title: { en: 'Backup', fr: 'Sauvegarde' }, desc: { en: 'Back up your folders and restore them', fr: 'Sauvegarder vos dossiers et les restaurer' } },
  { id: 'accessibility', icon: 'person-arms-spread', title: { en: 'Accessibility', fr: 'Accessibilité' }, desc: { en: 'Text size, contrast, screen reader', fr: 'Taille du texte, contraste, lecteur d’écran' } },
  { id: 'install', icon: 'hard-drives', title: { en: 'Install Selene', fr: 'Installer Selene' }, desc: { en: 'Installation and dual boot next to another system', fr: 'Installation et double démarrage à côté d’un autre système' } },
  { id: 'troubleshooting', icon: 'wrench', title: { en: 'Troubleshooting', fr: 'Dépannage' }, desc: { en: 'Safe mode, diagnostic report, a session that does not start', fr: 'Mode sans échec, rapport de diagnostic, session qui ne démarre pas' } },
  { id: 'privacy', icon: 'shield-check', title: { en: 'Privacy', fr: 'Confidentialité' }, desc: { en: 'What goes online, your history', fr: 'Ce qui passe par Internet, votre historique' } },
];

export const ARTICLES = [
  ...desktop,
  ...shortcuts,
  ...personalization,
  ...files,
  ...network,
  ...bluetooth,
  ...printers,
  ...apps,
  ...updates,
  ...accounts,
  ...backup,
  ...accessibility,
  ...install,
  ...troubleshooting,
  ...privacy,
];

export const TOUR = tour;
