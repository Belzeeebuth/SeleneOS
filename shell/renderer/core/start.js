// Start menu (Windows 11 22H2 layout): search box, Pinned grid (pages of 18), All apps (A–Z with
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
      searchPlaceholder: 'Search for apps, settings, and documents',
      more: 'More',
      moreRecommended: 'Recommended',
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
      pinStart: 'Pin to Start',
      unpinStart: 'Unpin from Start',
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
      startMenu: 'Start',
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
      searchPlaceholder: 'Rechercher des applications, des paramètres et des documents',
      more: 'Plus',
      moreRecommended: 'Recommandé',
      pageN: 'Page {n}',
      moveToFront: 'Placer en premier',
      appSettings: 'Paramètres de l’application',
      noRecentOff: 'Les fichiers ouverts récemment sont masqués. Réactivez-les dans Paramètres.',
      user: 'Utilisateur',
      gotoLetter: 'Aller aux applications commençant par {letter}',
      openFileLocation: 'Ouvrir l’emplacement du fichier',
      copyPath: 'Copier en tant que chemin d’accès',
      pinnedFull: 'Épinglé',
      emptyPinned: 'Épinglez des applications ici depuis Toutes les applications.',
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
      pinStart: 'Épingler à l’écran de démarrage',
      unpinStart: 'Désépingler de l’écran de démarrage',
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
      startMenu: 'Démarrer',
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
const usage = { apps: {}, files: [], searches: [] };
let usageLoaded = false;
let saveTimer = null;
async function loadUsage() {
  if (usageLoaded) return;
  usageLoaded = true;
  try {
    Object.assign(usage, (await api.invoke('storage:get', 'shell', 'start-usage', null)) || {});
  } catch {}
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
  searches: () => [...usage.searches],
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
    const base = settings.get('searchEngine') || 'https://duckduckgo.com/?q=';
    return `${base}${encodeURIComponent(q)}`;
  },
};

// ---------------------------------------------------------------- pin helpers
const isPinnedStart = (id) => (settings.get('startPinned') || []).includes(id);
const isPinnedTaskbar = (id) => (settings.get('pinned') || []).includes(id);
function togglePinStart(id) {
  const list = (settings.get('startPinned') || []).filter((x) => x !== id);
  if (!isPinnedStart(id)) list.push(id);
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
            onclick: () => this.setCategory(c),
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
            h('span', { class: 'ellipsis' }, registry.name(id)),
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
            shell.launch('files', { path: parentDir(item.entry.path), select: item.entry.name });
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
function rows() {
  return settings.get('startShowRecent') === false ? 6 : 3;
}

function launch(id, args) {
  fly.close('launch');
  registry.launch(id, args);
}

function tileMenu(e, id) {
  const pinned = settings.get('startPinned') || [];
  const idx = pinned.indexOf(id);
  ui.menu(e, [
    { label: t('start.open'), icon: 'open', action: () => launch(id) },
    idx > 0
      ? {
          label: t('start.moveToFront'),
          icon: 'arrow_up',
          action: () => settings.set('startPinned', [id, ...pinned.filter((x) => x !== id)]),
        }
      : null,
    { label: t('start.unpinStart'), icon: 'pin_off', action: () => togglePinStart(id) },
    { label: isPinnedTaskbar(id) ? t('taskbar.unpin') : t('taskbar.pin'), icon: isPinnedTaskbar(id) ? 'pin_off' : 'pin', action: () => togglePinTaskbar(id) },
  ].filter(Boolean));
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

function pinnedIds() {
  return (settings.get('startPinned') || []).filter((id) => registry.get(id));
}

function renderPinnedGrid(gridWrap, dots, animate) {
  const ids = pinnedIds();
  const per = rows() * COLS;
  const pages = Math.max(1, Math.ceil(ids.length / per));
  page = Math.max(0, Math.min(page, pages - 1));
  clear(gridWrap);
  const grid = h('div', { class: ['start-grid', animate && 'stagger'], role: 'list', style: { gridTemplateRows: `repeat(${rows()}, 84px)` } });
  ids.slice(page * per, page * per + per).forEach((id, i) => {
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
  if (!ids.length) grid.appendChild(h('div', { class: 'start-empty caption text-2' }, t('start.emptyPinned')));
  rove(grid, '.start-tile');
  enableReorder(grid, page * per);
  gridWrap.appendChild(grid);
  clear(dots);
  dots.hidden = pages < 2;
  for (let p = 0; p < pages; p++) {
    dots.appendChild(h('button', { class: ['start-dot', p === page && 'on'], 'aria-label': t('start.pageN', { n: p + 1 }), onclick: () => gotoPage(p, gridWrap, dots) }));
  }
}

// Drag a pinned tile to reorder it (the others glide out of the way); drop it on the taskbar to pin it there.
const APP_MIME = 'application/x-aurora-app';
function enableReorder(grid, offset) {
  let dragged = null;
  grid.addEventListener('dragstart', (e) => {
    const tile = e.target.closest?.('.start-tile');
    if (!tile) return;
    dragged = tile;
    e.dataTransfer.effectAllowed = 'copyMove';
    e.dataTransfer.setData(APP_MIME, tile.dataset.app);
    e.dataTransfer.setData('text/plain', registry.name(tile.dataset.app));
    try {
      e.dataTransfer.setDragImage(tile.querySelector('img'), 16, 16);
    } catch {}
    setTimeout(() => tile.classList.add('dragging'), 0);
  });
  grid.addEventListener('dragover', (e) => {
    if (!dragged) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const over = e.target.closest?.('.start-tile');
    if (!over || over === dragged) return;
    const tiles = [...grid.querySelectorAll('.start-tile')];
    const before = new Map(tiles.map((x) => [x, x.getBoundingClientRect()]));
    const after = tiles.indexOf(over) > tiles.indexOf(dragged);
    grid.insertBefore(dragged, after ? over.nextSibling : over);
    if (reduceMotion()) return;
    for (const [x, r] of before) {
      if (x === dragged) continue;
      const n = x.getBoundingClientRect();
      const dx = r.left - n.left;
      const dy = r.top - n.top;
      if (dx || dy) x.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 220, easing: 'cubic-bezier(0.1,0.9,0.2,1)' });
    }
  });
  const finish = () => {
    if (!dragged) return;
    dragged.classList.remove('dragging');
    dragged = null;
    const pageIds = [...grid.querySelectorAll('.start-tile')].map((x) => x.dataset.app);
    const all = pinnedIds();
    const next = [...all.slice(0, offset), ...pageIds, ...all.slice(offset + pageIds.length)];
    if (next.join() !== all.join()) settings.set('startPinned', [...next, ...(settings.get('startPinned') || []).filter((id) => !next.includes(id))]);
  };
  grid.addEventListener('drop', (e) => {
    if (dragged) e.preventDefault();
    finish();
  });
  grid.addEventListener('dragend', finish);
}

function gotoPage(p, gridWrap, dots) {
  const pages = Math.max(1, Math.ceil(pinnedIds().length / (rows() * COLS)));
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
          { label: t('start.openFileLocation'), icon: 'folder_open', action: () => (fly.close('launch'), shell.launch('files', { path: parentDir(e.path), select: e.name })) },
          { label: t('start.copyPath'), icon: 'copy', action: () => api.invoke('clipboard:writeText', e.path).catch(() => {}) },
        ]),
    },
    isImg ? h('img', { class: 'start-rec-thumb', src: api.mediaUrl(e.path), alt: '', draggable: false, loading: 'lazy' }) : h('span', { class: `start-rec-icon ft-${fileTint(e)}` }, icon(ui.fileIcon(e), { size: 28 })),
    h('div', { class: 'start-rec-text' }, h('div', { class: 'ellipsis' }, e.name), h('div', { class: 'caption text-2 ellipsis' }, i18n.relativeTime(e.time || e.mtime))),
  );
}

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
        const pages = Math.ceil(pinnedIds().length / (rows() * COLS));
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
  const v = h('div', { class: 'start-view start-view-pinned' }, sectionHead(t('start.pinned'), t('start.allApps'), () => setView('all')), pinnedArea);
  if (settings.get('startShowRecent') !== false) {
    const recBox = h('div', { class: 'start-recs' });
    const fill = () => {
      clear(recBox);
      if (!recentFiles.length) recBox.appendChild(h('div', { class: 'start-rec-empty caption text-2' }, t('start.noRecent')));
      for (const e of recentFiles.slice(0, 6)) recBox.appendChild(recItem(e));
      rove(recBox, '.start-rec');
    };
    fill();
    v._fillRecent = fill;
    v.append(sectionHead(t('start.recommended'), recentFiles.length > 6 ? t('start.more') : null, () => setView('recommended')), recBox);
  }
  return v;
}

function viewAll() {
  const list = h('div', { class: 'start-all', role: 'list' });
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
  return h(
    'div',
    { class: 'start-view start-view-all' },
    sectionHead(t('start.allApps'), t('start.back'), () => setView('pinned'), 'chevron_left', true),
    h('div', { class: 'start-all-wrap' }, h('div', { class: 'start-all-scroll' }, list), jump),
  );
}

function viewRecommended() {
  const box = h('div', { class: 'start-recs start-recs-all' });
  for (const e of recentFiles) box.appendChild(recItem(e));
  if (!recentFiles.length) box.appendChild(h('div', { class: 'start-rec-empty caption text-2' }, t('start.noRecent')));
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
  const prev = view;
  view = next;
  const old = bodyEl.firstElementChild;
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
  userInfo = { ...info, picture };
  if (root) renderFooter();
}

function renderFooter() {
  const foot = root.querySelector('.start-footer');
  if (!foot) return;
  const name = userInfo?.fullName || userInfo?.name || env.user;
  const avatar = userInfo?.picture
    ? h('img', { class: 'avatar start-avatar', src: userInfo.picture.startsWith('/') ? api.mediaUrl(userInfo.picture) : userInfo.picture, alt: '' })
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

function render() {
  clear(root);
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
  if (t0.closest?.('.start-jump')) return;
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
      },
      onKey,
    });
    shell.on('start:toggle', () => fly.toggle());
    shell.on('start:open', () => fly.open());
    shell.on('start:close', () => fly.close('event'));
    render();
    loadUsage();
    loadUser();
    i18n.on('change', () => render());
    settings.on('startPinned', () => view === 'pinned' && fly.isOpen && setView('pinned', { animate: false }));
    settings.on('startShowRecent', () => view === 'pinned' && setView('pinned', { animate: false }));
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
  open: () => fly.open(),
  close: () => fly.close('api'),
  toggle: () => fly.toggle(),
  get isOpen() {
    return !!fly?.isOpen;
  },
};
