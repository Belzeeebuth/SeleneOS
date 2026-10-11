// The Lanceur (Selene's app launcher): search box, Pinned grid (pages of 18), All apps (A–Z with
// a letter jump grid), Recommended (recent files), user menu and power menu.
//
// Also home of the shell search engine shared with features/search.js:
//   search.query(text, { files = true }) -> { apps, settings, files }   (files searched under $HOME)
//   search.settingsIndex()  -> static index of Settings pages (deep links: shell.launch('settings', { page }))
//   new SearchView({ variant: 'start' | 'panel', onDone })  -> results list + preview pane UI
//   recent.files() -> recently opened / modified files (Start "Recommended")
import { h, icon, ui, clear } from './ui.js';
import { registry } from './registry.js';
import { settings } from './settings.js';
import { i18n, t } from './i18n.js';
import { shell } from './services.js';
import { wm } from './wm.js';
import { api, env } from './api.js';
import { createFlyout } from './taskbar.js';

// ---------------------------------------------------------------- strings
const STRINGS = {
  en: {
    start: {
      searchPlaceholder: 'Search for an app, a file or a setting',
      more: 'More',
      moreRecommended: 'Recent files',
      pageN: 'Page {n}',
      moveToFront: 'Move to front',
      appSettings: 'App settings',
      noRecentOff: 'Recently opened files are hidden. Turn them back on in Settings.',
      user: 'User',
      gotoLetter: 'Go to apps starting with {letter}',
      openFileLocation: 'Open file location',
      copyPath: 'Copy as path',
      pinnedFull: 'Pinned',
      emptyPinned: 'Pin apps here from All apps.',
      addToFolder: 'Add to folder',
      newFolder: 'New folder…',
      newFolderTitle: 'New folder',
      folderName: 'Folder name',
      defaultFolderName: 'Folder',
      renameFolder: 'Rename folder',
      deleteFolder: 'Remove folder',
      removeFromFolder: 'Move out of the folder',
      folderApps_one: '{count} app',
      folderApps_other: '{count} apps',
      closeFolder: 'Close folder',
      newFolderWith: 'New folder with',
      dragOutHint: 'Drag an app out of the folder to remove it',
      recentlyAdded: 'Recently added',
      mostUsed: 'Most used',
      newApp: 'New',
      folder_documents: 'Documents',
      folder_downloads: 'Downloads',
      folder_music: 'Music',
      folder_pictures: 'Pictures',
      folder_videos: 'Videos',
      folder_files: 'Files',
      folder_settings: 'Settings',
      folder_home: 'Personal folder',
      folder_network: 'Network',
    },
    search: {
      all: 'All',
      apps: 'Apps',
      documents: 'Documents',
      settings: 'Settings',
      web: 'Web',
      bestMatch: 'Best match',
      app: 'App',
      setting: 'System settings',
      file: 'File',
      folder: 'Folder',
      webResult: 'See web results',
      searchWebFor: 'Search the web for “{q}”',
      openInBrowser: 'Open results in browser',
      topApps: 'Top apps',
      recent: 'Recent',
      quickSearches: 'Quick searches',
      noResults: 'No results for “{q}”',
      noResultsHint: 'Try different keywords or search the web.',
      searching: 'Searching files…',
      clearRecent: 'Clear',
      location: 'Location',
      modified: 'Last modified',
      open: 'Open',
      runApp: 'Open',
      pinStart: 'Pin to Launcher',
      unpinStart: 'Unpin from Launcher',
      pinTaskbar: 'Pin to taskbar',
      unpinTaskbar: 'Unpin from taskbar',
      typeToSearch: 'Type to search apps, settings and files',
    },
    settingsIndex: {
      system: 'System',
      display: 'Display',
      nightLight: 'Night light',
      sound: 'Sound',
      notifications: 'Notifications',
      power: 'Power & battery',
      storage: 'Storage',
      network: 'Network & internet',
      wifi: 'Wi-Fi',
      ethernet: 'Ethernet',
      airplane: 'Airplane mode',
      personalization: 'Personalization',
      background: 'Background',
      colors: 'Colors',
      darkMode: 'Dark mode',
      themes: 'Themes',
      lockscreen: 'Lock screen',
      startMenu: 'Launcher',
      taskbar: 'Taskbar',
      apps: 'Installed apps',
      defaultApps: 'Default apps',
      accounts: 'Your info',
      users: 'Other users',
      time: 'Date & time',
      language: 'Language & region',
      keyboard: 'Keyboard',
      accessibility: 'Accessibility',
      animations: 'Animation effects',
      privacy: 'Privacy & security',
      update: 'Software update',
      about: 'About',
      mouse: 'Mouse',
      printers: 'Printers',
    },
  },
  fr: {
    start: {
      searchPlaceholder: 'Rechercher une application, un fichier ou un réglage',
      more: 'Plus',
      moreRecommended: 'Fichiers récents',
      pageN: 'Page {n}',
      moveToFront: 'Placer en premier',
      appSettings: 'Paramètres de l’application',
      noRecentOff: 'Les fichiers ouverts récemment sont masqués. Réactivez-les dans Paramètres.',
      user: 'Utilisateur',
      gotoLetter: 'Aller aux applications commençant par {letter}',
      openFileLocation: 'Ouvrir l’emplacement du fichier',
      copyPath: 'Copier en tant que chemin d’accès',
      pinnedFull: 'Épinglées',
      emptyPinned: 'Épinglez des applications ici depuis Toutes les applications.',
      addToFolder: 'Ajouter au dossier',
      newFolder: 'Nouveau dossier…',
      newFolderTitle: 'Nouveau dossier',
      folderName: 'Nom du dossier',
      defaultFolderName: 'Dossier',
      renameFolder: 'Renommer le dossier',
      deleteFolder: 'Supprimer le dossier',
      removeFromFolder: 'Sortir du dossier',
      folderApps_one: '{count} application',
      folderApps_other: '{count} applications',
      closeFolder: 'Fermer le dossier',
      newFolderWith: 'Nouveau dossier avec',
      dragOutHint: 'Faites glisser une application hors du dossier pour l’en retirer',
      recentlyAdded: 'Ajoutée récemment',
      mostUsed: 'Les plus utilisées',
      newApp: 'Nouveau',
      folder_documents: 'Documents',
      folder_downloads: 'Téléchargements',
      folder_music: 'Musique',
      folder_pictures: 'Images',
      folder_videos: 'Vidéos',
      folder_files: 'Fichiers',
      folder_settings: 'Paramètres',
      folder_home: 'Dossier personnel',
      folder_network: 'Réseau',
    },
    search: {
      all: 'Tout',
      apps: 'Applications',
      documents: 'Documents',
      settings: 'Paramètres',
      web: 'Web',
      bestMatch: 'Meilleur résultat',
      app: 'Application',
      setting: 'Paramètres système',
      file: 'Fichier',
      folder: 'Dossier',
      webResult: 'Voir les résultats web',
      searchWebFor: 'Rechercher « {q} » sur le web',
      openInBrowser: 'Ouvrir les résultats dans le navigateur',
      topApps: 'Applications principales',
      recent: 'Récent',
      quickSearches: 'Recherches rapides',
      noResults: 'Aucun résultat pour « {q} »',
      noResultsHint: 'Essayez d’autres mots-clés ou effectuez une recherche sur le web.',
      searching: 'Recherche de fichiers…',
      clearRecent: 'Effacer',
      location: 'Emplacement',
      modified: 'Dernière modification',
      open: 'Ouvrir',
      runApp: 'Ouvrir',
      pinStart: 'Épingler au Lanceur',
      unpinStart: 'Détacher du Lanceur',
      pinTaskbar: 'Épingler à la barre des tâches',
      unpinTaskbar: 'Détacher de la barre des tâches',
      typeToSearch: 'Tapez pour rechercher des applications, des paramètres et des fichiers',
    },
    settingsIndex: {
      system: 'Système',
      display: 'Écran',
      nightLight: 'Éclairage nocturne',
      sound: 'Son',
      notifications: 'Notifications',
      power: 'Alimentation et batterie',
      storage: 'Stockage',
      network: 'Réseau et Internet',
      wifi: 'Wi-Fi',
      ethernet: 'Ethernet',
      airplane: 'Mode Avion',
      personalization: 'Personnalisation',
      background: 'Arrière-plan',
      colors: 'Couleurs',
      darkMode: 'Mode sombre',
      themes: 'Thèmes',
      lockscreen: 'Écran de verrouillage',
      startMenu: 'Lanceur',
      taskbar: 'Barre des tâches',
      apps: 'Applications installées',
      defaultApps: 'Applications par défaut',
      accounts: 'Vos informations',
      users: 'Autres utilisateurs',
      time: 'Date et heure',
      language: 'Langue et région',
      keyboard: 'Clavier',
      accessibility: 'Accessibilité',
      animations: 'Effets d’animation',
      privacy: 'Confidentialité et sécurité',
      update: 'Mise à jour logicielle',
      about: 'Informations système',
      mouse: 'Souris',
      printers: 'Imprimantes',
    },
  },
};

const reduceMotion = () => document.documentElement.dataset.animations === 'off';
const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');

// ---------------------------------------------------------------- settings index
// Deep links into the Settings app: shell.launch('settings', { page, section }).
// If the Settings app manifest provides "searchIndex": [{ page, section?, icon, name:{en,fr}, keywords:{en:[],fr:[]} }]
// that index is used instead of this built-in one.
const SETTINGS_INDEX = [
  { key: 'system', page: 'system', icon: 'desktop', kw: { en: 'computer pc', fr: 'ordinateur' } },
  { key: 'display', page: 'display', icon: 'desktop', kw: { en: 'screen monitor resolution scale brightness refresh rate', fr: 'écran moniteur résolution échelle luminosité fréquence' } },
  { key: 'nightLight', page: 'display', section: 'nightLight', icon: 'weather_moon', kw: { en: 'blue light warm color', fr: 'lumière bleue chaud couleur' } },
  { key: 'sound', page: 'sound', icon: 'speaker_2', kw: { en: 'volume audio speakers output microphone input', fr: 'volume audio haut-parleurs sortie microphone entrée' } },
  { key: 'notifications', page: 'notifications', icon: 'alert', kw: { en: 'do not disturb dnd focus alerts', fr: 'ne pas déranger alertes' } },
  { key: 'power', page: 'power', icon: 'battery_6', kw: { en: 'sleep battery shutdown screen off energy', fr: 'veille batterie arrêt énergie' } },
  { key: 'storage', page: 'storage', icon: 'hard_drive', kw: { en: 'disk space drive cleanup', fr: 'disque espace lecteur nettoyage' } },
  { key: 'network', page: 'network', icon: 'globe', kw: { en: 'internet connection proxy vpn', fr: 'internet connexion proxy vpn' } },
  { key: 'wifi', page: 'wifi', icon: 'wifi_1', kw: { en: 'wireless wlan hotspot', fr: 'sans fil wlan' } },
  { key: 'ethernet', page: 'ethernet', icon: 'plug_connected', kw: { en: 'wired cable lan', fr: 'filaire câble' } },
  { key: 'airplane', page: 'network', section: 'airplane', icon: 'airplane', kw: { en: 'flight offline', fr: 'avion vol hors ligne' } },
  { key: 'personalization', page: 'personalization', icon: 'paint_brush', kw: { en: 'customize look appearance', fr: 'personnaliser apparence' } },
  { key: 'background', page: 'background', icon: 'image', kw: { en: 'wallpaper desktop picture', fr: 'fond d’écran image bureau' } },
  { key: 'colors', page: 'colors', icon: 'color', kw: { en: 'accent color transparency theme', fr: 'couleur d’accentuation transparence thème' } },
  { key: 'darkMode', page: 'colors', section: 'mode', icon: 'dark_theme', kw: { en: 'dark light theme mode night', fr: 'sombre clair thème mode' } },
  { key: 'themes', page: 'themes', icon: 'paint_brush', kw: { en: 'theme', fr: 'thème' } },
  { key: 'lockscreen', page: 'lockscreen', icon: 'lock_closed', kw: { en: 'lock screen timeout', fr: 'verrouillage délai' } },
  { key: 'startMenu', page: 'start', icon: 'apps', kw: { en: 'start menu recommended recent', fr: 'menu démarrer recommandé récent' } },
  { key: 'taskbar', page: 'taskbar', icon: 'panel_left_text', kw: { en: 'taskbar alignment auto hide widgets search', fr: 'barre alignement masquer automatiquement widgets recherche' } },
  { key: 'apps', page: 'apps', icon: 'apps_list', kw: { en: 'programs uninstall install software', fr: 'programmes désinstaller installer logiciels' } },
  { key: 'defaultApps', page: 'defaultApps', icon: 'apps_settings', kw: { en: 'open with file association default browser', fr: 'ouvrir avec association navigateur par défaut' } },
  { key: 'accounts', page: 'accounts', icon: 'person', kw: { en: 'account profile picture password user', fr: 'compte profil photo mot de passe utilisateur' } },
  { key: 'users', page: 'users', icon: 'people', kw: { en: 'family add user', fr: 'famille ajouter utilisateur' } },
  { key: 'time', page: 'time', icon: 'clock', kw: { en: 'date time clock timezone ntp sync', fr: 'date heure horloge fuseau horaire synchronisation' } },
  { key: 'language', page: 'language', icon: 'local_language', kw: { en: 'language region locale format english french', fr: 'langue région format anglais français' } },
  { key: 'keyboard', page: 'keyboard', icon: 'keyboard', kw: { en: 'keyboard layout input azerty qwerty', fr: 'clavier disposition saisie azerty qwerty' } },
  { key: 'mouse', page: 'mouse', icon: 'cursor', kw: { en: 'mouse pointer cursor speed touchpad', fr: 'souris pointeur curseur vitesse pavé tactile' } },
  { key: 'printers', page: 'printers', icon: 'print', kw: { en: 'printer scanner print', fr: 'imprimante scanner impression' } },
  { key: 'accessibility', page: 'accessibility', icon: 'accessibility', kw: { en: 'contrast text size magnifier', fr: 'contraste taille du texte loupe' } },
  { key: 'animations', page: 'accessibility', section: 'animations', icon: 'accessibility', kw: { en: 'animation motion effects reduce', fr: 'animation mouvement effets réduire' } },
  { key: 'privacy', page: 'privacy', icon: 'shield', kw: { en: 'security permissions firewall', fr: 'sécurité autorisations pare-feu' } },
  { key: 'update', page: 'update', icon: 'arrow_sync', kw: { en: 'updates upgrade patches', fr: 'mises à jour correctifs' } },
  { key: 'about', page: 'about', icon: 'info', kw: { en: 'about version device name hostname rename pc specifications', fr: 'à propos version nom de l’appareil renommer caractéristiques' } },
];

function settingsIndex() {
  const custom = registry.get('settings')?.searchIndex;
  if (Array.isArray(custom) && custom.length) {
    return custom.map((e) => ({ page: e.page, section: e.section, icon: e.icon || 'settings', name: i18n.name(e.name), kw: [...(e.keywords?.[i18n.lang] || []), ...(e.keywords?.en || [])].join(' ') }));
  }
  return SETTINGS_INDEX.map((e) => ({ page: e.page, section: e.section, icon: e.icon, name: t(`settingsIndex.${e.key}`), kw: `${e.kw[i18n.lang] || ''} ${e.kw.en}` }));
}

// ---------------------------------------------------------------- usage + recents
// usage = { apps: { [appId]: launches }, seen: { [appId]: first seen (ms, 0 = before tracking) }, files, searches }
const usage = { apps: {}, seen: null, files: [], searches: [] };
const NEW_APP_DAYS = 7;
let usageLoaded = false;
let saveTimer = null;
async function loadUsage() {
  if (usageLoaded) return;
  usageLoaded = true;
  try {
    const stored = (await api.invoke('storage:get', 'shell', 'start-usage', null)) || {};
    if (stored && typeof stored === 'object') {
      if (stored.apps && typeof stored.apps === 'object') usage.apps = { ...stored.apps };
      if (stored.seen && typeof stored.seen === 'object') usage.seen = { ...stored.seen };
      if (Array.isArray(stored.files)) usage.files = stored.files.filter((f) => f && typeof f.path === 'string').slice(0, 30);
      if (Array.isArray(stored.searches)) usage.searches = stored.searches.filter((q) => typeof q === 'string').slice(0, 8);
    }
  } catch {}
  trackApps();
}
// Apps seen for the first time since the tracking started are "recently added" for a week (Start > Recommended).
function trackApps() {
  const first = !usage.seen;
  usage.seen = usage.seen || {};
  let changed = first;
  for (const m of registry.list()) {
    if (usage.seen[m.id] == null) {
      usage.seen[m.id] = first ? 0 : Date.now();
      changed = true;
    }
  }
  if (changed) saveUsage();
}
function saveUsage() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => api.invoke('storage:set', 'shell', 'start-usage', usage).catch(() => {}), 400);
}
export const recent = {
  addFile(path) {
    if (!path || typeof path !== 'string') return;
    usage.files = [{ path, time: Date.now() }, ...usage.files.filter((f) => f.path !== path)].slice(0, 30);
    saveUsage();
  },
  addSearch(q) {
    q = String(q || '').trim();
    if (!q) return;
    usage.searches = [q, ...usage.searches.filter((s) => s.toLowerCase() !== q.toLowerCase())].slice(0, 8);
    saveUsage();
  },
  clearSearches() {
    usage.searches = [];
    saveUsage();
  },
  /** Forget the recently opened files (Settings > Start > Clear). */
  async clearFiles() {
    await loadUsage();
    usage.files = [];
    saveUsage();
  },
  searches: () => [...usage.searches],
  /** Apps added in the last week, newest first (Start > Recommended, "New" in All apps). */
  addedApps() {
    const since = Date.now() - NEW_APP_DAYS * 86400000;
    return Object.entries(usage.seen || {})
      .filter(([id, at]) => at > since && registry.get(id) && !registry.get(id).hidden)
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => id);
  },
  /** Mark an app as just installed (the installer / a package manager front-end calls this). */
  markAdded(id, at = Date.now()) {
    if (!registry.get(id)) return;
    usage.seen = usage.seen || {};
    usage.seen[id] = at;
    saveUsage();
  },
  /** Apps launched at least twice, most launched first. */
  mostUsed(n = 6) {
    return Object.entries(usage.apps)
      .filter(([id, c]) => c >= 2 && registry.get(id) && !registry.get(id).hidden)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([id]) => id);
  },
  topApps(n = 6) {
    const pinned = settings.get('startPinned') || [];
    const ids = Object.entries(usage.apps)
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => id)
      .filter((id) => registry.get(id) && !registry.get(id).hidden);
    for (const id of [...pinned, ...registry.list().map((m) => m.id)]) if (!ids.includes(id) && registry.get(id)) ids.push(id);
    return ids.slice(0, n);
  },
  // Recently opened files (via shell.openFile) merged with recently modified files in the user folders.
  async files(n = 6) {
    await loadUsage();
    const out = [];
    const seen = new Set();
    const opened = await Promise.all(usage.files.slice(0, 12).map((f) => api.invoke('fs:stat', f.path).then((st) => (st && !st.dir ? { ...st, time: f.time } : null)).catch(() => null)));
    for (const e of opened) if (e && !seen.has(e.path)) (seen.add(e.path), out.push(e));
    try {
      const xdg = shell.xdg || (await api.invoke('fs:xdg'));
      const lists = await Promise.all([xdg.documents, xdg.desktop, xdg.pictures, xdg.downloads, xdg.music, xdg.videos].filter(Boolean).map((d) => api.invoke('fs:list', d).catch(() => [])));
      for (const e of lists.flat().filter((e) => !e.dir).sort((a, b) => b.mtime - a.mtime)) {
        if (seen.has(e.path)) continue;
        seen.add(e.path);
        out.push({ ...e, time: e.mtime });
      }
    } catch {}
    return out.sort((a, b) => b.time - a.time).slice(0, n);
  },
};

// ---------------------------------------------------------------- search engine
// Match quality of query `q` (already normalised) against `text`: whole-word and prefix matches
// rank highest; punctuation/spaces are ignored ("wifi" finds "Wi-Fi"); every query word must match.
function score(text, q) {
  const s = norm(text);
  if (!s || !q) return 0;
  const squash = (x) => x.replace(/[\s\-_.&'’]+/g, '');
  if (s === q || squash(s) === squash(q)) return 120;
  if (s.startsWith(q) || squash(s).startsWith(squash(q))) return 100;
  const words = s.split(/[\s\-_.&'’/]+/).filter(Boolean);
  const qw = q.split(/\s+/).filter(Boolean);
  if (qw.length > 1) {
    const all = qw.every((w) => words.some((x) => x.startsWith(w)) || s.includes(w));
    return all ? 70 : 0;
  }
  if (words.some((w) => w.startsWith(q))) return 80;
  if (s.includes(q) || squash(s).includes(squash(q))) return 55;
  return 0;
}
export const search = {
  settingsIndex,
  apps(q) {
    q = norm(q).trim();
    if (!q) return [];
    return registry
      .list()
      .map((m) => {
        const name = i18n.name(m.name);
        const kw = [...(m.keywords?.[i18n.lang] || []), ...(m.keywords?.en || []), i18n.name(m.description)].join(' ');
        const sc = Math.max(score(name, q), score(kw, q) * 0.6, score(m.id, q) * 0.5) + Math.min(10, usage.apps[m.id] || 0);
        return { m, name, sc };
      })
      .filter((x) => x.sc > 0)
      .sort((a, b) => b.sc - a.sc || a.name.localeCompare(b.name, i18n.locale))
      .map((x) => ({ kind: 'app', id: x.m.id, title: x.name, score: x.sc }));
  },
  settings(q) {
    q = norm(q).trim();
    if (!q) return [];
    return settingsIndex()
      .map((e) => ({ e, sc: Math.max(score(e.name, q), score(e.kw, q) * 0.7) }))
      .filter((x) => x.sc > 0)
      .sort((a, b) => b.sc - a.sc)
      .slice(0, 8)
      .map(({ e, sc }) => ({ kind: 'setting', id: `${e.page}#${e.section || ''}`, title: e.name, icon: e.icon, page: e.page, section: e.section, score: sc * 0.95 }));
  },
  async files(q, { limit = 30 } = {}) {
    q = String(q || '').trim();
    if (q.length < 2) return [];
    try {
      const home = shell.xdg?.home || env.home;
      const res = await api.invoke('fs:search', home, q, { limit, timeoutMs: 2500 });
      const nq = norm(q);
      return (res || [])
        .map((e) => ({ kind: 'file', id: e.path, title: e.name, entry: e, score: score(e.name, nq) * 0.85 + (e.dir ? 0 : 2) }))
        .sort((a, b) => b.score - a.score || (b.entry.mtime || 0) - (a.entry.mtime || 0));
    } catch {
      return [];
    }
  },
  async query(text, { files = true } = {}) {
    await loadUsage();
    return { apps: search.apps(text), settings: search.settings(text), files: files ? await search.files(text) : [] };
  },
  webUrl(q) {
    const custom = settings.get('searchEngine');
    // Only an http(s) prefix is accepted for the (user-configurable) search engine.
    const base = typeof custom === 'string' && /^https?:\/\/[^\s]+$/i.test(custom) ? custom : 'https://duckduckgo.com/?q=';
    return `${base}${encodeURIComponent(q)}`;
  },
};

// ---------------------------------------------------------------- pin helpers
// (an app inside a Start folder counts as pinned: unpinning it also takes it out of the folder)
const isPinnedStart = (id) => (settings.get('startPinned') || []).includes(id) || groupedApps().has(id);
const isPinnedTaskbar = (id) => (settings.get('pinned') || []).includes(id);
function togglePinStart(id) {
  const pinned = isPinnedStart(id);
  const list = (settings.get('startPinned') || []).filter((x) => x !== id);
  if (!pinned) list.push(id);
  else if (groupedApps().has(id)) return commitFolders(groups().map((g) => ({ ...g, apps: g.apps.filter((a) => a !== id) })), list);
  return settings.set('startPinned', list);
}
function togglePinTaskbar(id) {
  const list = (settings.get('pinned') || []).filter((x) => x !== id);
  if (!isPinnedTaskbar(id)) list.push(id);
  return settings.set('pinned', list);
}
function parentDir(p) {
  return p.replace(/\/[^/]+\/?$/, '') || '/';
}
function fileKind(e) {
  return e.dir ? t('search.folder') : (e.ext || '').replace('.', '').toUpperCase() || t('search.file');
}
// Colour family of a file type (Windows-like coloured document icons).
export function fileTint(e) {
  if (!e) return 'txt';
  if (e.dir) return 'dir';
  const x = (e.ext || '').toLowerCase();
  if (['.doc', '.docx', '.odt', '.rtf'].includes(x)) return 'doc';
  if (['.xls', '.xlsx', '.ods', '.csv'].includes(x)) return 'xls';
  if (['.ppt', '.pptx', '.odp'].includes(x)) return 'ppt';
  if (x === '.pdf') return 'pdf';
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.avif', '.ico'].includes(x)) return 'img';
  if (['.mp3', '.wav', '.ogg', '.oga', '.flac', '.m4a', '.aac', '.opus'].includes(x)) return 'audio';
  if (['.mp4', '.webm', '.mkv', '.mov', '.avi', '.ogv', '.m4v'].includes(x)) return 'video';
  if (['.zip', '.tar', '.gz', '.xz', '.bz2', '.7z', '.rar', '.zst', '.deb', '.iso'].includes(x)) return 'zip';
  if (['.js', '.ts', '.py', '.c', '.h', '.cpp', '.rs', '.go', '.java', '.sh', '.json', '.html', '.css', '.xml', '.yml', '.yaml', '.toml'].includes(x)) return 'code';
  return 'txt';
}
function prettyPath(p) {
  const home = shell.xdg?.home || env.home;
  return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

// ---------------------------------------------------------------- SearchView (shared UI)
// Results list on the left, preview pane on the right (Windows 11 search experience).
export class SearchView {
  constructor({ variant = 'panel', onDone } = {}) {
    this.variant = variant;
    this.onDone = onDone || (() => {});
    this.q = '';
    this.cat = 'all';
    this.items = [];
    this.sel = 0;
    this.seq = 0;
    this.fileTimer = null;
    this.res = { apps: [], settings: [], files: [] };
    this.filesPending = false;
    this.list = h('div', { class: 'sv-list', role: 'listbox' });
    this.preview = h('div', { class: 'sv-preview' });
    this.tabs = h('div', { class: 'sv-tabs', role: 'tablist' });
    this.el = h('div', { class: ['sv', `sv-${variant}`] }, variant === 'panel' ? this.tabs : null, h('div', { class: 'sv-main' }, this.list, this.preview));
    this.renderTabs();
  }
  renderTabs() {
    clear(this.tabs);
    for (const c of ['all', 'apps', 'documents', 'settings', 'web']) {
      this.tabs.appendChild(
        h(
          'button',
          {
            class: ['sv-tab', this.cat === c && 'selected'],
            role: 'tab',
            'aria-selected': String(this.cat === c),
            onclick: () => {
              this.setCategory(c);
              this.onCategory?.();
            },
          },
          t(`search.${c}`),
        ),
      );
    }
  }
  setCategory(c) {
    if (this.cat === c) return;
    this.cat = c;
    this.renderTabs();
    this.sel = 0;
    if (c === 'web' && this.q) {
      this.render();
      return;
    }
    this.render();
  }
  setQuery(q) {
    this.q = String(q || '');
    const text = this.q.trim();
    const my = ++this.seq;
    clearTimeout(this.fileTimer);
    this.sel = 0;
    this.touched = false;
    if (!text) {
      this.res = { apps: [], settings: [], files: [] };
      this.filesPending = false;
      this.render();
      return;
    }
    this.res = { apps: search.apps(text), settings: search.settings(text), files: this.res.files.filter((f) => norm(f.title).includes(norm(text))) };
    this.filesPending = text.length >= 2;
    this.render();
    if (!this.filesPending) return;
    // Debounced file search; stale responses are ignored.
    this.fileTimer = setTimeout(async () => {
      const files = await search.files(text);
      if (my !== this.seq) return;
      const selected = this.items[this.sel];
      this.res.files = files;
      this.filesPending = false;
      this.render(selected);
    }, 260);
  }
  buildItems() {
    const text = this.q.trim();
    const { apps, settings: sets, files } = this.res;
    const web = { kind: 'web', id: `web:${text}`, title: text };
    const sections = [];
    if (this.cat === 'apps') sections.push(['apps', apps]);
    else if (this.cat === 'documents') sections.push(['documents', files]);
    else if (this.cat === 'settings') sections.push(['settings', sets]);
    else if (this.cat === 'web') sections.push(['web', [web]]);
    else {
      const all = [...apps, ...sets, ...files].sort((a, b) => b.score - a.score);
      const best = all[0];
      if (best) sections.push(['bestMatch', [best]]);
      const rest = (arr, n) => arr.filter((x) => x !== best).slice(0, n);
      if (rest(apps, 6).length) sections.push(['apps', rest(apps, 6)]);
      if (rest(sets, 4).length) sections.push(['settings', rest(sets, 4)]);
      if (rest(files, 6).length) sections.push(['documents', rest(files, 6)]);
      sections.push(['web', [web]]);
    }
    return sections;
  }
  iconFor(item, size) {
    if (item.kind === 'app') return h('img', { class: 'sv-ico', src: registry.iconUrl(item.id), alt: '', width: size, height: size, draggable: false });
    if (item.kind === 'setting') return h('span', { class: 'sv-ico sv-ico-set' }, icon(item.icon || 'settings', { size: Math.round(size * 0.62) }));
    if (item.kind === 'file') {
      const e = item.entry;
      if (!e.dir && ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'].includes((e.ext || '').toLowerCase()) && size > 32) {
        return h('img', { class: 'sv-ico sv-thumb', src: api.mediaUrl(e.path), alt: '', draggable: false, style: { width: `${size}px`, height: `${size}px` } });
      }
      return h('span', { class: ['sv-ico sv-ico-file', `ft-${fileTint(e)}`] }, icon(ui.fileIcon(e), { size: Math.round(size * 0.8), filled: e.dir }));
    }
    return h('span', { class: 'sv-ico sv-ico-web' }, icon('globe_search', { size: Math.round(size * 0.66) }));
  }
  subtitle(item) {
    if (item.kind === 'app') return t('search.app');
    if (item.kind === 'setting') return t('search.setting');
    if (item.kind === 'file') return item.entry.dir ? t('search.folder') : `${fileKind(item.entry)} · ${prettyPath(parentDir(item.entry.path))}`;
    return t('search.webResult');
  }
  render(keep) {
    clear(this.list);
    const text = this.q.trim();
    if (!text) {
      this.items = [];
      this.renderHome();
      return;
    }
    const sections = this.buildItems();
    this.items = sections.flatMap(([, arr]) => arr);
    // Late results (file search) keep the user's selection only if they moved it themselves.
    if (keep && this.touched) {
      const i = this.items.findIndex((x) => x.id === keep.id && x.kind === keep.kind);
      if (i >= 0) this.sel = i;
    } else if (keep) this.sel = 0;
    this.sel = Math.max(0, Math.min(this.sel, this.items.length - 1));
    let idx = 0;
    const realResults = this.items.some((x) => x.kind !== 'web');
    for (const [name, arr] of sections) {
      if (!arr.length) continue;
      this.list.appendChild(h('div', { class: 'sv-head' }, t(`search.${name}`)));
      for (const item of arr) {
        const i = idx++;
        const big = name === 'bestMatch';
        const row = h(
          'div',
          {
            class: ['sv-row', big && 'big', i === this.sel && 'selected'],
            role: 'option',
            'aria-selected': String(i === this.sel),
            dataset: { i: String(i) },
            onclick: (e) => {
              // The chevron shows the details pane; the row itself opens the result.
              if (e.target.closest('.sv-chev')) {
                this.touched = true;
                this.select(i, false);
                return;
              }
              this.select(i, false);
              this.activate(item);
            },
            oncontextmenu: (e) => this.contextMenu(e, item),
          },
          this.iconFor(item, big ? 32 : 24),
          h(
            'div',
            { class: 'sv-row-text' },
            h('div', { class: 'sv-title ellipsis' }, item.kind === 'web' ? t('search.searchWebFor', { q: item.title }) : item.title),
            big || item.kind === 'file' ? h('div', { class: 'sv-sub caption ellipsis' }, this.subtitle(item)) : null,
          ),
          !big && item.kind !== 'file' && item.kind !== 'web' ? h('span', { class: 'sv-kind caption' }, this.subtitle(item)) : null,
          h('span', { class: 'sv-chev' }, icon('chevron_right', { size: 12 })),
        );
        this.list.appendChild(row);
      }
      if (name === 'documents' && this.filesPending) this.list.appendChild(h('div', { class: 'sv-pending caption' }, h('span', { class: 'spinner small' }), t('search.searching')));
    }
    if (this.filesPending && !sections.some(([n]) => n === 'documents') && (this.cat === 'all' || this.cat === 'documents')) {
      this.list.appendChild(h('div', { class: 'sv-pending caption' }, h('span', { class: 'spinner small' }), t('search.searching')));
    }
    if (!realResults && !this.filesPending && this.cat !== 'web') {
      this.list.prepend(h('div', { class: 'sv-empty' }, h('div', { class: 'body-strong' }, t('search.noResults', { q: text })), h('div', { class: 'caption text-2' }, t('search.noResultsHint'))));
    }
    this.renderPreview();
  }
  renderHome() {
    clear(this.preview);
    this.el.classList.add('home');
    const top = recent.topApps(this.variant === 'panel' ? 6 : 6);
    const home = h('div', { class: 'sv-home' });
    home.appendChild(h('div', { class: 'sv-head' }, t('search.topApps')));
    home.appendChild(
      h(
        'div',
        { class: 'sv-topapps' },
        top.map((id) =>
          h(
            'button',
            { class: 'sv-topapp', onclick: () => this.launchApp(id), oncontextmenu: (e) => this.contextMenu(e, { kind: 'app', id }) },
            h('img', { src: registry.iconUrl(id), alt: '', draggable: false }),
            h('span', null, registry.name(id)),
          ),
        ),
      ),
    );
    const searches = recent.searches();
    if (searches.length) {
      home.appendChild(
        h(
          'div',
          { class: 'sv-head row' },
          h('span', { class: 'grow' }, t('search.recent')),
          h(
            'button',
            {
              class: 'btn subtle small',
              onclick: () => {
                recent.clearSearches();
                this.render();
              },
            },
            t('search.clearRecent'),
          ),
        ),
      );
      for (const s of searches.slice(0, 6)) {
        home.appendChild(
          h(
            'div',
            { class: 'sv-row', onclick: () => this.onPickRecent?.(s) },
            h('span', { class: 'sv-ico sv-ico-hist' }, icon('history', { size: 16 })),
            h('div', { class: 'sv-row-text' }, h('div', { class: 'sv-title ellipsis' }, s)),
          ),
        );
      }
    }
    this.list.appendChild(home);
    // Right side: quick searches into Settings
    const quick = ['display', 'sound', 'wifi', 'background', 'time', 'about'].map((page) => settingsIndex().find((e) => e.page === page)).filter(Boolean);
    this.preview.appendChild(
      h(
        'div',
        { class: 'sv-quick' },
        h('div', { class: 'sv-head' }, t('search.quickSearches')),
        quick.map((e) =>
          h(
            'button',
            { class: 'sv-quick-item', onclick: () => this.activate({ kind: 'setting', page: e.page, section: e.section, title: e.name }) },
            h('span', { class: 'sv-ico sv-ico-set' }, icon(e.icon, { size: 16 })),
            h('span', { class: 'ellipsis' }, e.name),
          ),
        ),
      ),
    );
  }
  renderPreview() {
    this.el.classList.remove('home');
    clear(this.preview);
    const item = this.items[this.sel];
    if (!item) return;
    const actions = this.actionsFor(item);
    let meta = null;
    if (item.kind === 'file') {
      meta = h(
        'div',
        { class: 'sv-meta caption' },
        h('div', { class: 'text-2' }, t('search.location')),
        h('div', { class: 'selectable sv-path' }, prettyPath(parentDir(item.entry.path))),
        item.entry.mtime ? h('div', { class: 'text-2', style: { marginTop: '8px' } }, t('search.modified')) : null,
        item.entry.mtime ? h('div', null, i18n.formatDate(item.entry.mtime, { dateStyle: 'medium', timeStyle: 'short' })) : null,
      );
    }
    this.preview.appendChild(
      h(
        'div',
        { class: 'sv-pv', key: item.id },
        h('div', { class: 'sv-pv-top' }, this.iconFor(item, 64), h('div', { class: 'sv-pv-title' }, item.kind === 'web' ? item.title : item.title), h('div', { class: 'caption text-2' }, this.subtitle(item))),
        h('div', { class: 'sv-pv-sep' }),
        h(
          'div',
          { class: 'sv-actions' },
          actions.map((a) => h('button', { class: 'sv-action', onclick: () => a.run() }, icon(a.icon, { size: 16 }), h('span', null, a.label))),
        ),
        meta,
      ),
    );
  }
  actionsFor(item) {
    const done = () => this.onDone();
    if (item.kind === 'app') {
      return [
        { icon: 'open', label: t('search.runApp'), run: () => this.activate(item) },
        { icon: isPinnedStart(item.id) ? 'pin_off' : 'pin', label: isPinnedStart(item.id) ? t('search.unpinStart') : t('search.pinStart'), run: () => togglePinStart(item.id).then(() => this.renderPreview()) },
        { icon: isPinnedTaskbar(item.id) ? 'pin_off' : 'pin', label: isPinnedTaskbar(item.id) ? t('search.unpinTaskbar') : t('search.pinTaskbar'), run: () => togglePinTaskbar(item.id).then(() => this.renderPreview()) },
      ];
    }
    if (item.kind === 'file') {
      return [
        { icon: 'open', label: t('search.open'), run: () => this.activate(item) },
        {
          icon: 'folder_open',
          label: t('start.openFileLocation'),
          run: () => {
            recent.addSearch(this.q);
            done();
            shell.launch('files', { path: parentDir(item.entry.path), select: item.entry.path });
          },
        },
        { icon: 'copy', label: t('start.copyPath'), run: () => api.invoke('clipboard:writeText', item.entry.path).catch(() => {}) },
      ];
    }
    if (item.kind === 'setting') return [{ icon: 'open', label: t('search.open'), run: () => this.activate(item) }];
    return [{ icon: 'open', label: t('search.openInBrowser'), run: () => this.activate(item) }];
  }
  contextMenu(e, item) {
    const acts = this.actionsFor(item);
    ui.menu(
      e,
      acts.map((a) => ({ label: a.label, icon: a.icon, action: a.run })),
    );
  }
  select(i, scroll = true) {
    if (!this.items.length) return;
    this.sel = (i + this.items.length) % this.items.length;
    for (const row of this.list.querySelectorAll('.sv-row[data-i]')) {
      const on = Number(row.dataset.i) === this.sel;
      row.classList.toggle('selected', on);
      row.setAttribute('aria-selected', String(on));
      if (on && scroll) row.scrollIntoView({ block: 'nearest' });
    }
    this.renderPreview();
  }
  move(delta) {
    this.touched = true;
    this.select(this.sel + delta);
  }
  launchApp(id) {
    this.onDone();
    registry.launch(id);
  }
  activate(item = this.items[this.sel]) {
    if (!item) return false;
    if (this.q.trim()) recent.addSearch(this.q);
    this.onDone();
    if (item.kind === 'app') registry.launch(item.id);
    else if (item.kind === 'setting') shell.launch('settings', { page: item.page, section: item.section });
    else if (item.kind === 'file') shell.openFile(item.entry.path);
    else if (item.kind === 'web') shell.openUrl(search.webUrl(item.title));
    return true;
  }
}

// ---------------------------------------------------------------- Start menu
let root;
let fly;
let input;
let bodyEl;
let view = 'pinned'; // pinned | all | recommended | search
let page = 0;
let searchView;
let userInfo = null;
let recentFiles = [];

const COLS = 6;
// Start layouts (settings start.layout): rows of pins per page and recommended items shown.
const START_LAYOUTS = { default: { rows: 3, recs: 6 }, morePins: { rows: 4, recs: 2 }, moreRecommended: { rows: 2, recs: 8 }, list: { rows: 1, recs: 0 } };
const startCfg = () => settings.get('start') || {};
function layoutName() {
  const l = startCfg().layout;
  return START_LAYOUTS[l] ? l : 'default';
}
// Recommended = recently added apps (start.showRecentApps), most used apps (start.showMostUsed) and recently opened
// files (startShowRecent). The section exists when files are on or when there is an app to recommend.
const showFiles = () => settings.get('startShowRecent') !== false;
const showRecs = () => layoutName() !== 'list' && (showFiles() || recApps().length > 0);
function rows() {
  const L = layoutName();
  if (L === 'list') return 1;
  return showRecs() ? START_LAYOUTS[L].rows : 6;
}
const recCount = () => START_LAYOUTS[layoutName()].recs;
/** Apps shown in Recommended: [{ id, kind: 'new' | 'used' }] (at most half of the slots). */
function recApps() {
  const out = [];
  const max = Math.max(1, Math.floor(recCount() / 2));
  if (startCfg().showRecentApps !== false) for (const id of recent.addedApps()) if (out.length < max) out.push({ id, kind: 'new' });
  if (startCfg().showMostUsed === true) for (const id of recent.mostUsed()) if (out.length < max && !out.some((x) => x.id === id)) out.push({ id, kind: 'used' });
  return out;
}

// ---------------------------------------------------------------- app folders in Pinned (settings start.groups)
// A folder is { id: 'g-…', name, apps: [appId] } in start.groups; its place in the grid is its id inside startPinned
// (folders that are not placed yet — older settings, a profile — come first). Apps inside a folder stay in startPinned
// (hidden from the grid), so removing or dissolving a folder never loses a pin. A folder needs two apps: with one left,
// it dissolves and that app takes its place.
const GROUP_ID = /^g-[a-z0-9]{3,24}$/;
const cleanName = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
function groups() {
  const list = Array.isArray(startCfg().groups) ? startCfg().groups : [];
  const seen = new Set();
  return list
    .filter((g) => g && typeof g.id === 'string' && GROUP_ID.test(g.id) && Array.isArray(g.apps) && !seen.has(g.id) && seen.add(g.id))
    .map((g) => ({ id: g.id, name: cleanName(g.name), apps: [...new Set(g.apps.filter((id) => typeof id === 'string' && registry.get(id)))] }));
}
const groupedApps = () => new Set(groups().filter((g) => g.apps.length).flatMap((g) => g.apps));
const groupOf = (appId) => groups().find((g) => g.apps.includes(appId)) || null;
const newGroupId = () => `g-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const pinsList = () => [...new Set((settings.get('startPinned') || []).filter((x) => typeof x === 'string'))];
/** Save folders + pins in one go; folders with fewer than two apps dissolve into the slot they had. */
function commitFolders(list, pins = pinsList()) {
  pins = [...pins];
  const keep = [];
  for (const g of list) {
    const apps = [...new Set(g.apps.filter((id) => registry.get(id)))];
    if (apps.length >= 2) {
      keep.push({ id: g.id, name: cleanName(g.name) || t('start.defaultFolderName'), apps });
      continue;
    }
    const at = pins.indexOf(g.id);
    if (apps[0]) {
      pins = pins.filter((x) => x !== apps[0]);
      if (at >= 0) pins.splice(pins.indexOf(g.id), 0, apps[0]);
      else pins.push(apps[0]);
    }
    pins = pins.filter((x) => x !== g.id);
  }
  // an app lives in one folder at a time
  const owner = new Map();
  for (const g of keep) g.apps = g.apps.filter((a) => (owner.has(a) ? false : owner.set(a, g.id)));
  const ids = new Set(keep.filter((g) => g.apps.length >= 2).map((g) => g.id));
  pins = pins.filter((x) => !GROUP_ID.test(x) || ids.has(x));
  return api.invoke('settings:setMany', { startPinned: pins, 'start.groups': keep.filter((g) => ids.has(g.id)) });
}
/** Drop app `appId` on app `targetId`: a new folder takes the target's place (Windows 11 22H2). */
function createFolder(targetId, appId) {
  if (!targetId || !appId || targetId === appId) return null;
  const id = newGroupId();
  const list = groups().map((g) => ({ ...g, apps: g.apps.filter((a) => a !== appId && a !== targetId) }));
  list.unshift({ id, name: t('start.defaultFolderName'), apps: [targetId, appId] });
  let pins = pinsList();
  for (const a of [targetId, appId]) if (!pins.includes(a)) pins.push(a);
  pins.splice(pins.indexOf(targetId), 0, id);
  return commitFolders(list, pins).then(() => id);
}
function addToGroup(gid, appId) {
  const list = groups().map((g) => ({ ...g, apps: g.id === gid ? [...g.apps.filter((a) => a !== appId), appId] : g.apps.filter((a) => a !== appId) }));
  const pins = pinsList();
  if (!pins.includes(appId)) pins.push(appId);
  return commitFolders(list, pins);
}
/** Take an app out of its folder: it lands right after the folder in Pinned (or where `at` says). */
function removeFromGroup(gid, appId) {
  const list = groups().map((g) => (g.id === gid ? { ...g, apps: g.apps.filter((a) => a !== appId) } : g));
  let pins = pinsList().filter((x) => x !== appId);
  const slot = pins.indexOf(gid);
  pins.splice(slot >= 0 ? slot + 1 : pins.length, 0, appId);
  return commitFolders(list, pins);
}
function renameGroup(gid, name) {
  const n = cleanName(name);
  if (!n) return Promise.resolve();
  return commitFolders(groups().map((g) => (g.id === gid ? { ...g, name: n } : g)));
}
/** Remove a folder: its apps go back to Pinned, where the folder was. */
function deleteGroup(gid) {
  const g = groups().find((x) => x.id === gid);
  if (!g) return Promise.resolve();
  let pins = pinsList().filter((x) => !g.apps.includes(x));
  const at = pins.indexOf(gid);
  pins.splice(at >= 0 ? at : 0, at >= 0 ? 1 : 0, ...g.apps);
  return commitFolders(groups().filter((x) => x.id !== gid), pins);
}
/** Make a folder of `apps` (two or more) at the place of the first one; `name` defaults to "Folder". */
async function newGroup(apps, name) {
  apps = [...new Set(apps.filter((id) => registry.get(id)))];
  if (apps.length < 2) return null;
  const id = newGroupId();
  const list = groups().map((g) => ({ ...g, apps: g.apps.filter((a) => !apps.includes(a)) }));
  list.unshift({ id, name: cleanName(name) || t('start.defaultFolderName'), apps });
  const pins = pinsList();
  for (const a of apps) if (!pins.includes(a)) pins.push(a);
  pins.splice(pins.indexOf(apps[0]), 0, id);
  await commitFolders(list, pins);
  return id;
}
// Folders next to the power button (settings start.folders)
export const START_FOLDERS = { documents: 'document', downloads: 'arrow_download', music: 'music_note_2', pictures: 'image', videos: 'video', files: 'folder', settings: 'settings', home: 'person', network: 'globe' };

function launch(id, args) {
  fly.close('launch');
  registry.launch(id, args);
}

function tileMenu(e, id) {
  const items = pinnedItems().map(itemKey);
  const idx = items.indexOf(id);
  const others = groups().filter((g) => g.apps.length >= 2);
  ui.menu(e, [
    { label: t('start.open'), icon: 'open', action: () => launch(id) },
    idx > 0 ? { label: t('start.moveToFront'), icon: 'arrow_up', action: () => writeOrder([id, ...items.filter((x) => x !== id)]) } : null,
    { label: t('start.unpinStart'), icon: 'pin_off', action: () => togglePinStart(id) },
    { label: isPinnedTaskbar(id) ? t('taskbar.unpin') : t('taskbar.pin'), icon: isPinnedTaskbar(id) ? 'pin_off' : 'pin', action: () => togglePinTaskbar(id) },
    '-',
    {
      label: t('start.addToFolder'),
      icon: 'folder_add',
      submenu: [
        ...others.map((g) => ({ label: g.name || t('start.defaultFolderName'), icon: 'folder', action: () => addToGroup(g.id, id) })),
        others.length ? '-' : null,
        {
          // keyboard path to a new folder (drag-and-drop is the mouse one): this app + another pinned app
          label: t('start.newFolderWith'),
          icon: 'add',
          disabled: !items.some((k) => k !== id && !GROUP_ID.test(k)),
          submenu: items
            .filter((k) => k !== id && !GROUP_ID.test(k))
            .slice(0, 24)
            .map((other) => ({ label: registry.name(other), action: () => newGroup([id, other]).then((gid) => gid && fly.isOpen && openFolder(gid, { rename: true })) })),
        },
      ].filter(Boolean),
    },
  ].filter(Boolean));
}

function groupMenu(e, g) {
  ui.menu(e, [
    { label: t('start.open'), icon: 'folder_open', action: () => openFolder(g.id) },
    { label: t('start.renameFolder'), icon: 'rename', action: () => openFolder(g.id, { rename: true }) },
    { label: t('start.deleteFolder'), icon: 'delete', action: () => deleteGroup(g.id) },
  ]);
}

// ---------------------------------------------------------------- open folder: a popup over the Pinned grid
// It grows out of the folder tile; its name is an editable field (Enter / leaving it renames, Esc restores); its apps
// can be dragged to reorder them or OUT of the popup to take them out of the folder. Esc, Back or a click outside
// closes it.
let folderEl = null;
function closeFolder({ focusTile = true, instant = false } = {}) {
  if (!folderEl) return false;
  const el = folderEl;
  const gid = el.dataset.group;
  folderEl = null;
  bodyEl?.classList.remove('has-folder');
  for (const v of [...(bodyEl?.querySelectorAll(':scope > .start-view') || []), root?.querySelector('.start-top'), root?.querySelector('.start-footer')]) if (v) v.inert = false;
  const panel = el.querySelector('.start-folder');
  const done = () => el.remove();
  if (!instant && !reduceMotion() && panel && el.isConnected) {
    el.classList.add('leaving');
    panel.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.94)' }], { duration: 120, easing: 'cubic-bezier(0.7,0,1,0.5)', fill: 'forwards' }).finished.then(done, done);
  } else done();
  if (focusTile) bodyEl?.querySelector(`.start-view:not(.leaving) .start-group[data-group="${gid}"]`)?.focus?.({ preventScroll: true });
  return true;
}
function folderTile(id, i) {
  return h(
    'button',
    { class: 'start-tile', role: 'listitem', draggable: 'true', style: { '--i': String(i) }, dataset: { app: id }, onclick: () => launch(id) },
    h('img', { src: registry.iconUrl(id), alt: '', draggable: false }),
    h('span', { class: 'start-tile-label' }, registry.name(id)),
  );
}
function openFolder(gid, { rename = false, animate = true } = {}) {
  const had = folderEl?.dataset.group === gid;
  if (folderEl) {
    folderEl.remove();
    folderEl = null;
  }
  const g = groups().find((x) => x.id === gid);
  if (!g || g.apps.length < 2 || !root || !bodyEl) {
    bodyEl?.classList.remove('has-folder');
    return;
  }
  const cols = Math.max(3, Math.min(4, g.apps.length));
  const grid = h('div', { class: 'start-grid start-folder-grid', role: 'list', style: { gridTemplateColumns: `repeat(${cols}, 1fr)` } }, g.apps.map((id, i) => folderTile(id, i)));
  for (const tile of grid.children) {
    const id = tile.dataset.app;
    tile.addEventListener('contextmenu', (e) =>
      ui.menu(e, [
        { label: t('start.open'), icon: 'open', action: () => launch(id) },
        { label: t('start.removeFromFolder'), icon: 'arrow_exit', action: () => removeFromGroup(g.id, id) },
        { label: isPinnedTaskbar(id) ? t('taskbar.unpin') : t('taskbar.pin'), icon: isPinnedTaskbar(id) ? 'pin_off' : 'pin', action: () => togglePinTaskbar(id) },
      ]),
    );
  }
  rove(grid, '.start-tile');
  const name = h('input', {
    class: 'start-folder-name',
    type: 'text',
    value: g.name || t('start.defaultFolderName'),
    maxLength: 60,
    spellcheck: false,
    'aria-label': t('start.folderName'),
    onkeydown: (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        name.blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        name.value = g.name || t('start.defaultFolderName');
        name.blur();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        grid.querySelector('.start-tile')?.focus();
      }
    },
    onchange: () => renameGroup(g.id, name.value),
  });
  const panel = h(
    'div',
    { class: 'start-folder', role: 'dialog', 'aria-label': g.name || t('start.defaultFolderName'), dataset: { group: g.id } },
    h('div', { class: 'start-folder-head' }, icon('folder', { size: 16 }), name, h('button', { class: 'btn subtle small start-folder-close', 'aria-label': t('start.closeFolder'), 'data-tip': t('start.closeFolder'), onclick: () => closeFolder() }, icon('dismiss', { size: 12 }))),
    grid,
    h('div', { class: 'start-folder-hint caption text-2' }, t('start.dragOutHint')),
  );
  folderEl = h('div', {
    class: 'start-folder-layer',
    dataset: { group: g.id },
    onpointerdown: (e) => {
      if (e.target === folderEl) closeFolder(); // a click outside the popup closes it
    },
  }, panel);
  bodyEl.appendChild(folderEl);
  bodyEl.classList.add('has-folder');
  // keyboard stays in the popup (Tab cycles inside it; Esc, Back or a click outside closes it)
  for (const v of [...bodyEl.querySelectorAll(':scope > .start-view'), root.querySelector('.start-top'), root.querySelector('.start-footer')]) if (v) v.inert = true;
  enableFolderDrag(folderEl, panel, grid, g.id);
  // Grow out of the folder tile.
  const tile = bodyEl.querySelector(`.start-view:not(.leaving) .start-group[data-group="${g.id}"]`);
  if (animate && !had && !reduceMotion()) {
    const pr = panel.getBoundingClientRect();
    const tr = tile?.getBoundingClientRect();
    const from = tr ? `translate(${Math.round(tr.left + tr.width / 2 - (pr.left + pr.width / 2))}px, ${Math.round(tr.top + tr.height / 2 - (pr.top + pr.height / 2))}px) scale(${Math.max(0.15, Math.min(0.5, tr.width / pr.width)).toFixed(3)})` : 'scale(.9)';
    panel.animate([{ opacity: 0, transform: from }, { opacity: 1, transform: 'none' }], { duration: 260, easing: 'cubic-bezier(0.1,0.9,0.2,1)' });
    folderEl.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: 'linear' });
  }
  setTimeout(() => {
    if (!panel.isConnected) return;
    if (rename) {
      name.focus({ preventScroll: true });
      name.select();
    } else grid.querySelector('.start-tile')?.focus({ preventScroll: true });
  }, 30);
}
// Drag inside the popup to reorder; drop outside it to take the app out of the folder.
function enableFolderDrag(layer, panel, grid, gid) {
  let dragged = null;
  let out = false;
  layer.addEventListener('dragstart', (e) => {
    const tile = e.target.closest?.('.start-tile[data-app]');
    if (!tile) return;
    dragged = tile;
    e.dataTransfer.effectAllowed = 'copyMove';
    e.dataTransfer.setData(APP_MIME, tile.dataset.app);
    e.dataTransfer.setData('text/plain', registry.name(tile.dataset.app));
    try {
      e.dataTransfer.setDragImage(tile.querySelector('img'), 16, 16);
    } catch {}
    setTimeout(() => (tile.classList.add('dragging'), layer.classList.add('dragging')), 0);
  });
  layer.addEventListener('dragover', (e) => {
    if (!dragged) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    out = !panel.contains(e.target);
    layer.classList.toggle('drop-out', out);
    if (out) return;
    const over = e.target.closest?.('.start-tile');
    if (!over || over === dragged || over.parentElement !== grid) return;
    const tiles = [...grid.children];
    grid.insertBefore(dragged, tiles.indexOf(over) > tiles.indexOf(dragged) ? over.nextSibling : over);
  });
  layer.addEventListener('dragleave', (e) => {
    if (!layer.contains(e.relatedTarget)) layer.classList.remove('drop-out');
  });
  const finish = () => {
    if (!dragged) return;
    const app = dragged.dataset.app;
    dragged.classList.remove('dragging');
    dragged = null;
    layer.classList.remove('drop-out', 'dragging');
    if (out) {
      out = false;
      removeFromGroup(gid, app);
      return;
    }
    const order = [...grid.querySelectorAll('.start-tile[data-app]')].map((x) => x.dataset.app);
    const g = groups().find((x) => x.id === gid);
    if (g && order.join() !== g.apps.join()) commitFolders(groups().map((x) => (x.id === gid ? { ...x, apps: order } : x)));
  };
  layer.addEventListener('drop', (e) => {
    if (dragged) e.preventDefault();
    finish();
  });
  layer.addEventListener('dragend', finish);
}
function groupTile(g, i) {
  return h(
    'button',
    {
      class: 'start-tile start-group',
      role: 'listitem',
      draggable: 'true',
      style: { '--i': String(i) },
      dataset: { group: g.id },
      'aria-label': `${g.name || t('start.defaultFolderName')} (${t('start.folderApps', { count: g.apps.length })})`,
      onclick: () => openFolder(g.id),
      oncontextmenu: (e) => groupMenu(e, g),
      onkeydown: (e) => {
        if (e.key === 'F2') {
          e.preventDefault();
          openFolder(g.id, { rename: true });
        }
      },
    },
    h('span', { class: 'start-group-icons' }, g.apps.slice(0, 4).map((id) => h('img', { src: registry.iconUrl(id), alt: '', draggable: false }))),
    h('span', { class: 'start-tile-label' }, g.name || t('start.defaultFolderName')),
  );
}

function allAppMenu(e, id) {
  ui.menu(e, [
    { label: t('start.open'), icon: 'open', action: () => launch(id) },
    { label: isPinnedStart(id) ? t('start.unpinStart') : t('start.pinStart'), icon: isPinnedStart(id) ? 'pin_off' : 'pin', action: () => togglePinStart(id) },
    { label: isPinnedTaskbar(id) ? t('taskbar.unpin') : t('taskbar.pin'), icon: isPinnedTaskbar(id) ? 'pin_off' : 'pin', action: () => togglePinTaskbar(id) },
  ]);
}

// Roving tab stop (Windows 11 Start): Tab enters a group (pinned grid, recommended list, All apps
// list) once, on the item focused last; the arrow keys move inside the group.
function rove(container, selector) {
  const items = [...container.querySelectorAll(selector)];
  items.forEach((el, i) => (el.tabIndex = i === 0 ? 0 : -1));
  if (container._rove) return;
  container._rove = true;
  container.addEventListener('focusin', (e) => {
    const it = e.target.closest?.(selector);
    if (!it || !container.contains(it)) return;
    for (const el of container.querySelectorAll(selector)) el.tabIndex = el === it ? 0 : -1;
  });
}

/** Pinned grid items in order: [{ app } | { group }] (folders keep their place; unplaced folders come first). */
function pinnedItems() {
  const gs = groups().filter((g) => g.apps.length >= 2);
  const byId = new Map(gs.map((g) => [g.id, g]));
  const inGroups = new Set(gs.flatMap((g) => g.apps));
  const out = [];
  const placed = new Set();
  for (const id of pinsList()) {
    if (byId.has(id)) {
      placed.add(id);
      out.push({ group: byId.get(id) });
    } else if (registry.get(id) && !inGroups.has(id)) out.push({ app: id });
  }
  return [...gs.filter((g) => !placed.has(g.id)).map((group) => ({ group })), ...out];
}
const itemKey = (x) => (x.group ? x.group.id : x.app);
/** New order of the visible Pinned items; hidden entries of startPinned (apps inside folders) keep their slots. */
function writeOrder(order) {
  const all = pinsList();
  const vis = new Set(order);
  const missing = order.filter((k) => !all.includes(k));
  const slots = [...missing.map(() => null), ...all.map((k) => (vis.has(k) ? null : k))];
  const queue = [...order];
  const next = slots.map((k) => (k === null ? queue.shift() : k)).filter((k) => k != null);
  if (next.join() === all.join()) return Promise.resolve();
  return settings.set('startPinned', next);
}

function renderPinnedGrid(gridWrap, dots, animate) {
  const items = pinnedItems();
  const per = rows() * COLS;
  const pages = Math.max(1, Math.ceil(items.length / per));
  page = Math.max(0, Math.min(page, pages - 1));
  clear(gridWrap);
  const grid = h('div', { class: ['start-grid', animate && 'stagger'], role: 'list', style: { gridTemplateRows: `repeat(${rows()}, 92px)` } });
  items.slice(page * per, page * per + per).forEach((x, i) => {
    if (x.group) {
      grid.appendChild(groupTile(x.group, i));
      return;
    }
    const id = x.app;
    grid.appendChild(
      h(
        'button',
        {
          class: 'start-tile',
          role: 'listitem',
          draggable: 'true',
          style: { '--i': String(i) },
          dataset: { app: id },
          onclick: () => launch(id),
          oncontextmenu: (e) => tileMenu(e, id),
        },
        h('img', { src: registry.iconUrl(id), alt: '', draggable: false }),
        h('span', { class: 'start-tile-label' }, registry.name(id)),
      ),
    );
  });
  if (!items.length) grid.appendChild(h('div', { class: 'start-empty caption text-2' }, t('start.emptyPinned')));
  rove(grid, '.start-tile');
  enableReorder(grid, page * per);
  gridWrap.appendChild(grid);
  clear(dots);
  dots.hidden = pages < 2;
  for (let p = 0; p < pages; p++) {
    dots.appendChild(h('button', { class: ['start-dot', p === page && 'on'], 'aria-label': t('start.pageN', { n: p + 1 }), onclick: () => gotoPage(p, gridWrap, dots) }));
  }
}

// Drag a pinned tile: over the edge of another tile it makes room (reorder); held over the middle of another app for
// a moment it makes a folder of the two (Windows 11 22H2); over a folder it goes inside. Dropped on the taskbar, it is
// pinned there.
const APP_MIME = 'application/x-aurora-app';
// The pointer must REST (move less than DWELL_SLOP px) for these times: sweeping across tiles never reorders them or
// makes a folder, so the tile under the pointer stays the one the user aims at.
const MERGE_DWELL = 450; // ms resting over the middle of an app before it turns into "make a folder"
const REORDER_DWELL = 160; // ms resting over the edge of a tile before the tiles make room
const DWELL_SLOP = 6;
function enableReorder(grid, offset) {
  let dragged = null;
  let pend = null; // { tile, zone: 'before' | 'after' | 'merge' | 'into', timer, done }
  const clearPending = () => {
    if (pend) clearTimeout(pend.timer);
    pend = null;
    for (const x of grid.querySelectorAll('.drop-into, .drop-merge')) x.classList.remove('drop-into', 'drop-merge');
  };
  // Put the dragged tile before / after `tile`, gliding the others out of the way.
  const moveBeside = (tile, zone) => {
    if (!dragged || tile === dragged || tile.parentElement !== grid) return;
    const ref = zone === 'before' ? tile : tile.nextSibling;
    if (ref === dragged || dragged.nextSibling === ref) return;
    const tiles = [...grid.querySelectorAll('.start-tile')];
    const before = reduceMotion() ? null : new Map(tiles.map((x) => [x, x.getBoundingClientRect()]));
    grid.insertBefore(dragged, ref);
    if (!before) return;
    for (const [x, rr] of before) {
      if (x === dragged) continue;
      const n = x.getBoundingClientRect();
      const dx = rr.left - n.left;
      const dy = rr.top - n.top;
      if (dx || dy) x.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 220, easing: 'cubic-bezier(0.1,0.9,0.2,1)' });
    }
  };
  const setPending = (tile, zone, x, y) => {
    if (pend && pend.tile === tile && pend.zone === zone) {
      // still moving: the dwell starts again from here
      if (!pend.done && zone !== 'into' && Math.hypot(x - pend.x, y - pend.y) > DWELL_SLOP) {
        clearTimeout(pend.timer);
        pend.x = x;
        pend.y = y;
        pend.timer = setTimeout(pend.fire, zone === 'merge' ? MERGE_DWELL : REORDER_DWELL);
      }
      return;
    }
    clearPending();
    pend = { tile, zone, done: false, x, y };
    if (zone === 'into') {
      tile.classList.add('drop-into'); // dropping an app on a folder puts it inside
      pend.done = true;
    } else if (zone === 'merge') {
      pend.fire = () => {
        if (dragged && pend?.tile === tile) {
          tile.classList.add('drop-merge');
          pend.done = true;
        }
      };
      pend.timer = setTimeout(pend.fire, MERGE_DWELL);
    } else {
      pend.fire = () => {
        if (dragged && pend?.tile === tile) {
          moveBeside(tile, zone);
          pend.done = true;
        }
      };
      pend.timer = setTimeout(pend.fire, REORDER_DWELL);
    }
  };
  grid.addEventListener('dragstart', (e) => {
    const tile = e.target.closest?.('.start-tile[data-app], .start-tile[data-group]');
    if (!tile || tile.parentElement !== grid) return;
    dragged = tile;
    e.dataTransfer.effectAllowed = 'copyMove';
    if (tile.dataset.app) {
      e.dataTransfer.setData(APP_MIME, tile.dataset.app);
      e.dataTransfer.setData('text/plain', registry.name(tile.dataset.app));
    } else e.dataTransfer.setData('text/plain', tile.querySelector('.start-tile-label')?.textContent || '');
    try {
      e.dataTransfer.setDragImage(tile.querySelector('img'), 16, 16);
    } catch {}
    setTimeout(() => tile.classList.add('dragging'), 0);
  });
  // (dragenter too: a pointer that stops right after entering a tile may get no dragover before the drop)
  const onOver = (e) => {
    if (!dragged) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const over = e.target.closest?.('.start-tile');
    if (!over || over === dragged || over.parentElement !== grid) return;
    const r = over.getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width;
    const fy = (e.clientY - r.top) / r.height;
    const middle = fx > 0.22 && fx < 0.78 && fy > 0.08 && fy < 0.92;
    // a folder never goes into another folder; an app held over the middle of a tile joins it
    if (middle && dragged.dataset.app) setPending(over, over.classList.contains('start-group') ? 'into' : 'merge', e.clientX, e.clientY);
    else setPending(over, fx < 0.5 ? 'before' : 'after', e.clientX, e.clientY);
  };
  grid.addEventListener('dragenter', onOver);
  grid.addEventListener('dragover', onOver);
  grid.addEventListener('dragleave', (e) => {
    // leaving the tile the pointer was resting on (or the grid) cancels what was about to happen there
    if (!grid.contains(e.relatedTarget) || (pend && pend.tile.contains(e.target) && !pend.tile.contains(e.relatedTarget))) clearPending();
  });
  const finish = (dropped) => {
    if (!dragged) return;
    const tile = dragged;
    const p = pend;
    dragged = null;
    tile.classList.remove('dragging');
    const app = tile.dataset.app;
    const into = p?.zone === 'into' ? p.tile : null;
    const merge = p?.zone === 'merge' && p.done ? p.tile : null;
    clearPending();
    if (dropped && into && app) return addToGroup(into.dataset.group, app);
    if (dropped && merge && app && merge.dataset.app) return createFolder(merge.dataset.app, app);
    if (dropped && p && !p.done && p.tile.parentElement === grid) {
      // dropped before the tiles made room: an edge goes beside that tile, the middle takes its place
      if (p.zone === 'merge') {
        const tiles = [...grid.querySelectorAll('.start-tile')];
        dragged = tile;
        moveBeside(p.tile, tiles.indexOf(p.tile) > tiles.indexOf(tile) ? 'after' : 'before');
        dragged = null;
      } else {
        dragged = tile;
        moveBeside(p.tile, p.zone);
        dragged = null;
      }
    }
    const pageKeys = [...grid.querySelectorAll('.start-tile')].map((x) => x.dataset.app || x.dataset.group).filter(Boolean);
    const all = pinnedItems().map(itemKey);
    const next = [...all.slice(0, offset), ...pageKeys, ...all.slice(offset + pageKeys.length)];
    if (next.join() !== all.join()) writeOrder(next);
  };
  grid.addEventListener('drop', (e) => {
    if (dragged) e.preventDefault();
    finish(true);
  });
  grid.addEventListener('dragend', () => finish(false));
}

function gotoPage(p, gridWrap, dots) {
  const pages = Math.max(1, Math.ceil(pinnedItems().length / (rows() * COLS)));
  p = Math.max(0, Math.min(pages - 1, p));
  if (p === page) return;
  const dir = p > page ? 1 : -1;
  page = p;
  const old = gridWrap.firstElementChild;
  renderPinnedGrid(gridWrap, dots, false);
  if (!reduceMotion() && old) {
    gridWrap.firstElementChild.animate([{ transform: `translateY(${dir * 40}px)`, opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 260, easing: 'cubic-bezier(0.1,0.9,0.2,1)' });
  }
}

function recItem(e) {
  const isImg = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'].includes((e.ext || '').toLowerCase());
  return h(
    'button',
    {
      class: 'start-rec',
      onclick: () => {
        fly.close('launch');
        recent.addFile(e.path);
        shell.openFile(e.path);
      },
      oncontextmenu: (ev) =>
        ui.menu(ev, [
          { label: t('start.open'), icon: 'open', action: () => (fly.close('launch'), shell.openFile(e.path)) },
          { label: t('start.openFileLocation'), icon: 'folder_open', action: () => (fly.close('launch'), shell.launch('files', { path: parentDir(e.path), select: e.path })) },
          { label: t('start.copyPath'), icon: 'copy', action: () => api.invoke('clipboard:writeText', e.path).catch(() => {}) },
        ]),
    },
    isImg ? h('img', { class: 'start-rec-thumb', src: api.mediaUrl(e.path), alt: '', draggable: false, loading: 'lazy' }) : h('span', { class: `start-rec-icon ft-${fileTint(e)}` }, icon(ui.fileIcon(e), { size: 28 })),
    h('div', { class: 'start-rec-text' }, h('div', { class: 'ellipsis' }, e.name), h('div', { class: 'caption text-2 ellipsis' }, i18n.relativeTime(e.time || e.mtime))),
  );
}

// A recommended app (recently added / most used).
function recAppItem({ id, kind }) {
  return h(
    'button',
    { class: ['start-rec start-rec-app', `start-rec-${kind}`], dataset: { app: id }, onclick: () => launch(id), oncontextmenu: (ev) => allAppMenu(ev, id) },
    h('img', { class: 'start-rec-appicon', src: registry.iconUrl(id), alt: '', draggable: false }),
    h('div', { class: 'start-rec-text' }, h('div', { class: 'ellipsis' }, registry.name(id)), h('div', { class: 'caption text-2 ellipsis' }, t(kind === 'new' ? 'start.recentlyAdded' : 'start.mostUsed'))),
  );
}
const filesShown = () => (showFiles() ? recentFiles : []);

function sectionHead(title, btnLabel, onClick, chevron = 'chevron_right', before = false) {
  return h(
    'div',
    { class: 'start-section-head' },
    h('span', { class: 'start-section-title' }, title),
    btnLabel
      ? h('button', { class: 'btn small start-head-btn', onclick: onClick }, before ? icon(chevron, { size: 12 }) : null, h('span', null, btnLabel), before ? null : icon(chevron, { size: 12 }))
      : null,
  );
}

function viewPinned(animate) {
  const gridWrap = h('div', { class: 'start-grid-wrap' });
  const dots = h('div', { class: 'start-dots', hidden: true });
  const pinnedArea = h(
    'div',
    {
      class: 'start-pinned',
      onwheel: (e) => {
        const pages = Math.ceil(pinnedItems().length / (rows() * COLS));
        if (pages < 2 || Math.abs(e.deltaY) < 4) return;
        e.preventDefault();
        if (pinnedArea._wheelLock) return;
        pinnedArea._wheelLock = true;
        setTimeout(() => (pinnedArea._wheelLock = false), 320);
        gotoPage(page + (e.deltaY > 0 ? 1 : -1), gridWrap, dots);
      },
    },
    gridWrap,
    dots,
  );
  renderPinnedGrid(gridWrap, dots, animate);
  const L = layoutName();
  if (L === 'list') {
    // "List" layout: one row of pins, then every app A–Z (Windows 10 style).
    return h('div', { class: 'start-view start-view-pinned start-view-list', dataset: { layout: L } }, sectionHead(t('start.pinned')), pinnedArea, sectionHead(t('start.allApps')), allAppsList());
  }
  const v = h('div', { class: 'start-view start-view-pinned', dataset: { layout: L } }, sectionHead(t('start.pinned'), t('start.allApps'), () => setView('all')), pinnedArea);
  if (showRecs()) {
    const n = recCount();
    const recBox = h('div', { class: 'start-recs', style: { gridTemplateRows: `repeat(${Math.ceil(n / 2)}, 56px)` } });
    let head = sectionHead(t('start.recommended'), null);
    v.append(head, recBox);
    // (re)filled when the recent files arrive; "More" only when there are more than the layout shows
    v._fillRecent = () => {
      clear(recBox);
      const apps = recApps();
      const files = filesShown();
      if (!apps.length && !files.length) recBox.appendChild(h('div', { class: 'start-rec-empty caption text-2' }, t('start.noRecent')));
      for (const a of apps) recBox.appendChild(recAppItem(a));
      for (const e of files.slice(0, Math.max(0, n - apps.length))) recBox.appendChild(recItem(e));
      rove(recBox, '.start-rec');
      const fresh = sectionHead(t('start.recommended'), apps.length + files.length > n ? t('start.more') : null, () => setView('recommended'));
      head.replaceWith(fresh);
      head = fresh;
    };
    v._fillRecent();
  }
  return v;
}

function viewAll() {
  return h(
    'div',
    { class: 'start-view start-view-all' },
    sectionHead(t('start.allApps'), t('start.back'), () => setView('pinned'), 'chevron_left', true),
    allAppsList(),
  );
}

// The A–Z list of every app with its letter-jump grid (All apps view, and the "List" layout).
function allAppsList() {
  const list = h('div', { class: 'start-all', role: 'list' });
  const added = new Set(startCfg().showRecentApps !== false ? recent.addedApps() : []);
  const groups = new Map();
  for (const m of registry.list()) {
    const name = i18n.name(m.name);
    let L = norm(name).charAt(0).toUpperCase();
    if (!/[A-Z]/.test(L)) L = '#';
    if (!groups.has(L)) groups.set(L, []);
    groups.get(L).push(m);
  }
  const letters = [...groups.keys()].sort((a, b) => (a === '#' ? -1 : b === '#' ? 1 : a.localeCompare(b)));
  const jump = h('div', { class: 'start-jump', hidden: true });
  const showJump = () => {
    clear(jump);
    for (const L of ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ']) {
      const has = groups.has(L);
      jump.appendChild(
        h(
          'button',
          {
            class: 'start-jump-l',
            disabled: !has,
            'aria-label': t('start.gotoLetter', { letter: L }),
            onclick: () => {
              jump.hidden = true;
              list.querySelector(`[data-letter="${L}"]`)?.scrollIntoView({ block: 'start' });
              list.querySelector(`[data-letter="${L}"] + .start-row`)?.focus({ preventScroll: true });
            },
          },
          L,
        ),
      );
    }
    jump.hidden = false;
    jump.querySelector('button:not([disabled])')?.focus();
  };
  for (const L of letters) {
    list.appendChild(h('button', { class: 'start-letter', dataset: { letter: L }, onclick: showJump }, L));
    for (const m of groups.get(L)) {
      list.appendChild(
        h(
          'button',
          { class: 'start-row', role: 'listitem', dataset: { app: m.id }, onclick: () => launch(m.id), oncontextmenu: (e) => allAppMenu(e, m.id) },
          h('img', { src: registry.iconUrl(m.id), alt: '', draggable: false }),
          h('span', { class: 'ellipsis' }, i18n.name(m.name)),
          added.has(m.id) ? h('span', { class: 'start-new-pill' }, t('start.newApp')) : null,
        ),
      );
    }
  }
  rove(list, '.start-letter, .start-row');
  jump.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      jump.hidden = true;
    }
  });
  return h('div', { class: 'start-all-wrap' }, h('div', { class: 'start-all-scroll' }, list), jump);
}

function viewRecommended() {
  const box = h('div', { class: 'start-recs start-recs-all' });
  const apps = recApps();
  for (const a of apps) box.appendChild(recAppItem(a));
  for (const e of filesShown()) box.appendChild(recItem(e));
  if (!apps.length && !filesShown().length) box.appendChild(h('div', { class: 'start-rec-empty caption text-2' }, t('start.noRecent')));
  rove(box, '.start-rec');
  return h('div', { class: 'start-view start-view-rec' }, sectionHead(t('start.moreRecommended'), t('start.back'), () => setView('pinned'), 'chevron_left', true), h('div', { class: 'start-scroll' }, box));
}

function viewSearch() {
  if (!searchView) {
    searchView = new SearchView({ variant: 'start', onDone: () => fly.close('launch') });
    searchView.onPickRecent = (q) => {
      input.value = q;
      onInput();
    };
  }
  return h('div', { class: 'start-view start-view-search' }, searchView.el);
}

function setView(next, { animate = true } = {}) {
  closeFolder();
  const prev = view;
  view = next;
  const old = bodyEl.firstElementChild;
  // Keyboard focus inside the outgoing view (e.g. Enter on "All apps") moves into the new view.
  const moveFocus = !!old && old.contains(document.activeElement) && next !== 'search';
  let el;
  if (next === 'all') el = viewAll();
  else if (next === 'recommended') el = viewRecommended();
  else if (next === 'search') el = viewSearch();
  else el = viewPinned(animate && prev === 'pinned');
  if (old && animate && !reduceMotion() && prev !== next && fly?.isOpen) {
    // Horizontal slide between Pinned and All apps (Windows 11 style); fade for search.
    const fwd = next !== 'pinned';
    const dx = next === 'search' || prev === 'search' ? 0 : 60;
    old.classList.add('leaving');
    old.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `translateX(${fwd ? -dx : dx}px)` }], { duration: 120, easing: 'cubic-bezier(0.7,0,1,0.5)', fill: 'forwards' }).finished.then(
      () => old.remove(),
      () => old.remove(),
    );
    bodyEl.appendChild(el);
    el.animate([{ opacity: 0, transform: `translateX(${fwd ? dx : -dx}px)` }, { opacity: 1, transform: 'none' }], { duration: 260, delay: 60, easing: 'cubic-bezier(0.1,0.9,0.2,1)', fill: 'backwards' });
  } else {
    clear(bodyEl);
    bodyEl.appendChild(el);
  }
  if (next === 'all') setTimeout(() => el.querySelector('.start-row')?.scrollIntoView?.({ block: 'nearest' }), 0);
  if (moveFocus) {
    const target = next === 'pinned' ? el.querySelector('.start-head-btn') : el.querySelector('.start-all [tabindex="0"], .start-recs [tabindex="0"]') || el.querySelector('.start-head-btn');
    target?.focus({ preventScroll: true });
  }
}

function onInput() {
  const q = input.value;
  if (q.trim()) {
    if (view !== 'search') setView('search');
    searchView.setQuery(q);
  } else if (view === 'search') {
    searchView.setQuery('');
    setView('pinned');
  }
}

function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

async function loadUser() {
  let info = null;
  try {
    info = await api.invoke('users:current');
  } catch {}
  if (!info) {
    try {
      const si = await api.invoke('sys:info');
      info = { name: si.user, fullName: si.fullName };
    } catch {}
  }
  info = info || { name: env.user };
  const home = shell.xdg?.home || env.home;
  let picture = info.picture || info.avatar || null;
  if (!picture && home) {
    for (const f of [`${home}/.face`, `${home}/.face.icon`, `${home}/.config/aurora/avatar.png`]) {
      if (await api.invoke('fs:exists', f).catch(() => false)) {
        picture = f;
        break;
      }
    }
  }
  userInfo = { ...info, picture, pictureVersion: Date.now() };
  if (root) renderFooter();
}

function renderFooter() {
  const foot = root.querySelector('.start-footer');
  if (!foot) return;
  const name = userInfo?.fullName || userInfo?.name || env.user;
  const avatar = userInfo?.picture
    ? h('img', {
        class: 'avatar start-avatar',
        src: userInfo.picture.startsWith('/') ? `${api.mediaUrl(userInfo.picture)}?v=${userInfo.pictureVersion || 0}` : userInfo.picture,
        alt: '',
        // A broken picture falls back to the initials.
        onerror: (e) => e.target.replaceWith(h('span', { class: 'avatar start-avatar' }, initials(name))),
      })
    : h('span', { class: 'avatar start-avatar' }, initials(name));
  clear(foot);
  foot.append(
    h(
      'button',
      {
        class: 'start-user',
        'aria-label': name,
        onclick: (e) =>
          ui.menu(
            e.currentTarget,
            [
              { label: t('start.accountSettings'), icon: 'person_circle', action: () => launch('settings', { page: 'accounts' }) },
              { label: t('power.lock'), icon: 'lock_closed', action: () => (fly.close('launch'), shell.lock()) },
              { label: t('power.signOut'), icon: 'sign_out', action: () => (fly.close('launch'), shell.logout()) },
            ],
            { above: true },
          ),
      },
      avatar,
      h('span', { class: 'ellipsis' }, name),
    ),
    h('div', { class: 'start-folders', role: 'toolbar' }, folderButtons()),
    h(
      'button',
      {
        class: 'start-power',
        'data-tip': t('power.power'),
        'aria-label': t('power.power'),
        onclick: (e) =>
          ui.menu(
            e.currentTarget,
            [
              { label: t('power.lock'), icon: 'lock_closed', action: () => (fly.close('launch'), shell.lock()) },
              { label: t('power.sleep'), icon: 'weather_moon', action: () => (fly.close('launch'), shell.suspend()) },
              { label: t('power.shutdown'), icon: 'power', action: () => (fly.close('launch'), shell.shutdown()) },
              { label: t('power.restart'), icon: 'arrow_clockwise', action: () => (fly.close('launch'), shell.reboot()) },
            ],
            { above: true },
          ),
      },
      icon('power', { size: 18 }),
    ),
  );
}

// Folder shortcuts next to the power button (Settings > Personalization > Start > Folders).
function openStartFolder(id) {
  fly.close('launch');
  const x = shell.xdg || {};
  if (id === 'settings') return shell.launch('settings');
  if (id === 'network') return shell.launch('settings', { page: 'network' });
  if (id === 'files') return shell.launch('files');
  const path = id === 'home' ? x.home || env.home : x[id];
  return path ? shell.launch('files', { path }) : shell.launch('files');
}
function folderButtons() {
  const list = (Array.isArray(startCfg().folders) ? startCfg().folders : []).filter((id, i, a) => START_FOLDERS[id] && a.indexOf(id) === i);
  return list.map((id) =>
    h(
      'button',
      { class: 'start-power start-folder-btn', dataset: { folder: id, tip: t(`start.folder_${id}`) }, 'aria-label': t(`start.folder_${id}`), onclick: () => openStartFolder(id) },
      icon(START_FOLDERS[id], { size: 18 }),
    ),
  );
}
function applyBackground() {
  const bg = startCfg().background;
  if (['solid', 'accent', 'wallpaper', 'glass'].includes(bg)) root.dataset.bg = bg;
  else delete root.dataset.bg;
  root.dataset.layout = layoutName();
}

function render() {
  clear(root);
  closeFolder();
  input = h('input', {
    class: 'start-search',
    type: 'text',
    placeholder: t('start.searchPlaceholder'),
    'aria-label': t('start.searchPlaceholder'),
    spellcheck: false,
    oninput: onInput,
  });
  input.addEventListener('keydown', (e) => {
    if (view === 'search') {
      if (e.key === 'ArrowDown') (e.preventDefault(), searchView.move(1));
      else if (e.key === 'ArrowUp') (e.preventDefault(), searchView.move(-1));
      else if (e.key === 'Enter') (e.preventDefault(), searchView.activate());
    } else if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
      const first = bodyEl.querySelector('.start-tile, .start-row');
      if (first) {
        e.preventDefault();
        first.focus();
      }
    } else if (e.key === 'Enter') {
      const first = bodyEl.querySelector('.start-tile');
      if (first) first.click();
    }
  });
  bodyEl = h('div', { class: 'start-body' });
  root.append(h('div', { class: 'start-top' }, h('div', { class: 'start-search-box' }, icon('search', { size: 16 }), input)), bodyEl, h('div', { class: 'start-footer' }));
  renderFooter();
  setView('pinned', { animate: false });
}

// Arrow-key navigation across tiles / rows / recommendations.
function onKey(e) {
  if (e.target === input || e.defaultPrevented) {
    return;
  }
  const t0 = e.target;
  if (t0.closest?.('.start-jump') || t0.matches?.('input, textarea, [contenteditable="true"]')) return;
  // inside an open folder: arrows move between its apps (Up from the first row goes to its name)
  const fgrid = folderEl && t0.closest?.('.start-folder-grid');
  if (fgrid) {
    const tiles = [...fgrid.querySelectorAll('.start-tile')];
    const i = tiles.indexOf(t0);
    const cols = getComputedStyle(fgrid).gridTemplateColumns.split(' ').length || 4;
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols }[e.key];
    if (step == null || i < 0) {
      if (e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        // typing searches: leave the folder for the search box
        closeFolder({ focusTile: false, instant: true });
        input.focus();
      }
      return;
    }
    e.preventDefault();
    const j = i + step;
    if (j < 0 && e.key === 'ArrowUp') folderEl.querySelector('.start-folder-name')?.focus();
    else tiles[Math.max(0, Math.min(tiles.length - 1, j))]?.focus();
    return;
  }
  // Typing anywhere in Start goes to the search box (Space still activates the focused button).
  if (e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.altKey && !e.metaKey && !t0.closest?.('.menu')) {
    input.focus();
    return;
  }
  const V = '.start-view:not(.leaving)';
  const items = [...bodyEl.querySelectorAll(`${V} .start-tile, ${V} .start-letter, ${V} .start-row, ${V} .start-rec, ${V} .start-head-btn`)];
  const i = items.indexOf(t0);
  if (i < 0) return;
  let next = -1;
  const isTile = t0.classList.contains('start-tile');
  const isRec = t0.classList.contains('start-rec');
  if (e.key === 'ArrowRight') next = i + 1;
  else if (e.key === 'ArrowLeft') next = i - 1;
  else if (e.key === 'ArrowDown') next = isTile ? (items[i + COLS]?.classList.contains('start-tile') ? i + COLS : items.findIndex((x, k) => k > i && !x.classList.contains('start-tile'))) : i + (isRec ? 2 : 1);
  else if (e.key === 'ArrowUp') {
    if (isTile && items[i - COLS]?.classList.contains('start-tile')) next = i - COLS;
    else if (isRec && items[i - 2]?.classList.contains('start-rec')) next = i - 2;
    else next = i - 1;
    if (next < 0) {
      e.preventDefault();
      input.focus();
      return;
    }
  } else return;
  e.preventDefault();
  if (next >= 0 && next < items.length) items[next].focus();
}

export const start = {
  mount(el) {
    root = el;
    i18n.extend(STRINGS);
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', t('taskbar.start'));
    fly = createFlyout({
      id: 'start',
      el: root,
      button: '.tb-start',
      focus: () => input,
      onOpen: () => {
        if (usageLoaded) trackApps();
        input.value = '';
        page = 0;
        if (searchView) searchView.setQuery('');
        setView('pinned', { animate: false });
        root.classList.remove('stagger');
        void root.offsetWidth;
        root.classList.add('stagger');
        recent.files(24).then((files) => {
          recentFiles = files;
          bodyEl.querySelector('.start-view-pinned')?._fillRecent?.();
        });
      },
      onClose: () => {
        ui.closeMenus?.();
        closeFolder();
      },
      onEscape: () => closeFolder(),
      onKey,
    });
    shell.on('start:toggle', () => fly.toggle());
    shell.on('start:open', () => fly.open());
    shell.on('start:close', () => fly.close('event'));
    render();
    loadUsage();
    loadUser();
    // Account picture / name changed in Settings.
    api.on('users:changed', () => loadUser());
    i18n.on('change', () => render());
    // Start personalization (pins, layout, app folders, recommended, background, folders): applied live, in one
    // re-render per change (settings:setMany changes startPinned and start.groups together); an open folder stays open.
    applyBackground();
    let queued = false;
    let sig = '';
    const signature = () => JSON.stringify([settings.get('startPinned'), settings.get('start'), settings.get('startShowRecent')]);
    sig = signature();
    const refresh = () => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        const now = signature();
        if (now === sig) return; // a settings:setMany of other keys (focus mode, a theme…) also reaches here
        sig = now;
        applyBackground();
        renderFooter();
        const open = folderEl?.dataset.group;
        const a = document.activeElement;
        const renaming = !!folderEl?.contains(a) && a.classList.contains('start-folder-name');
        // keep the keyboard on "the same" tile across the re-render
        const key = root.contains(a) ? a.closest?.('[data-app], [data-group]') : null;
        const keySel = key ? (key.dataset.app ? `[data-app="${CSS.escape(key.dataset.app)}"]` : `[data-group="${CSS.escape(key.dataset.group)}"]`) : null;
        const inFolder = !!key && !!folderEl?.contains(key);
        if (open) closeFolder({ focusTile: false, instant: true });
        if (view === 'pinned') setView('pinned', { animate: false });
        if (open && fly.isOpen) openFolder(open, { animate: false, rename: renaming });
        if (!fly.isOpen || renaming) return;
        const scope = inFolder && folderEl ? folderEl : bodyEl.querySelector('.start-view:not(.leaving)');
        const target = (keySel && scope?.querySelector(`.start-tile${keySel}, .start-row${keySel}, .start-rec${keySel}`)) || (open && !folderEl ? bodyEl.querySelector('.start-view:not(.leaving) .start-tile') : null);
        if (target && (key || open)) target.focus({ preventScroll: true });
      });
    };
    for (const key of ['startPinned', 'startShowRecent', 'start']) settings.on(key, refresh);
    // Usage statistics for "Top apps" and recently opened files for "Recommended".
    wm.on('open', (w) => {
      if (!w?.appId || !registry.get(w.appId)) return;
      usage.apps[w.appId] = (usage.apps[w.appId] || 0) + 1;
      saveUsage();
    });
    const openFile = shell.openFile.bind(shell);
    shell.openFile = (path, opts) => {
      recent.addFile(path);
      return openFile(path, opts);
    };
  },
  /** App folders in Pinned (Settings > Start uses these so folders keep their place and never lose a pin). */
  folders: {
    list: () => groups().filter((g) => g.apps.length >= 2),
    create: (name, apps) => newGroup(apps, name),
    update: (id, { name, apps } = {}) => commitFolders(groups().map((g) => (g.id === id ? { ...g, name: name ?? g.name, apps: apps ?? g.apps } : g))),
    rename: (id, name) => renameGroup(id, name),
    remove: (id) => deleteGroup(id),
    add: (id, appId) => addToGroup(id, appId),
    take: (id, appId) => removeFromGroup(id, appId),
    open: (id, opts) => (fly.isOpen ? openFolder(id, opts) : (fly.open(), setTimeout(() => openFolder(id, opts), 60))),
    close: () => closeFolder(),
  },
  open: () => fly.open(),
  close: () => fly.close('api'),
  toggle: () => fly.toggle(),
  get isOpen() {
    return !!fly?.isOpen;
  },
};
