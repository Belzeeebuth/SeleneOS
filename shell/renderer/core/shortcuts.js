// Customizable keyboard shortcuts (docs/PERSONALIZATION.md §12.1): the catalog of shell actions a user can rebind.
//   settings.shortcuts = { [actionId]: 'Super+K' | null }   (missing = the default combo, null = turned off)
//   actionId: a catalog id (SHORTCUTS) or 'app:<appId>' — "open this app", added by the user (no default)
// features/hotkeys.js builds the live combo -> action map from it; main/lib/hotkeys.js is told which extra
// (non-Super) combos to capture (hotkeys:setCustom). Combos use the main/lib/hotkeys.js syntax: modifiers in the
// order Super, Ctrl, Alt, Shift, then the key ("Super+Shift+S", "Ctrl+Alt+T").
//   import { SHORTCUTS, SHORTCUT_GROUPS, comboProblem, validCombo, comboKeys, effectiveShortcuts,
//            isAppAction, appActionId, appOfAction, conflictOf } from './shortcuts.js';
//
// A combo the user may choose must not steal ordinary typing or app shortcuts (Ctrl+C, Alt+F, Shift+A…): it needs
// Win, or Ctrl+Alt together, or is one of F13–F24 (alone or with modifiers). The default combos of the catalog
// (Alt+Space, Alt+F4, Ctrl+Shift+Esc) stay allowed. Ctrl+Alt+F1…F12 and Ctrl+Alt+Backspace belong to the X server.

export const SHORTCUT_GROUPS = [
  { id: 'shell', name: { en: 'Desktop and Launcher', fr: 'Bureau et Lanceur' } },
  { id: 'windows', name: { en: 'Windows', fr: 'Fenêtres' } },
  { id: 'desktops', name: { en: 'Virtual desktops', fr: 'Bureaux virtuels' } },
  { id: 'taskbar', name: { en: 'Taskbar apps', fr: 'Applications de la barre' } },
  { id: 'apps', name: { en: 'Apps', fr: 'Applications' } },
];

// [id, group, default combo (null = none), English, French]
const LIST = [
  ['start', 'shell', 'Super', 'Open or close the Launcher', 'Ouvrir ou fermer le Lanceur'],
  ['search', 'shell', 'Super+S', 'Search', 'Rechercher'],
  ['quickSettings', 'shell', 'Super+A', 'Quick settings', 'Réglages rapides'],
  ['notifications', 'shell', 'Super+N', 'Notifications', 'Notifications'],
  ['widgets', 'shell', 'Super+W', 'Dashboard', 'Tableau de bord'],
  ['showDesktop', 'shell', 'Super+D', 'Show or hide the desktop', 'Afficher ou masquer le bureau'],
  ['lock', 'shell', 'Super+L', 'Lock the screen', 'Verrouiller l’écran'],
  ['run', 'shell', 'Super+R', 'Run', 'Exécuter'],
  ['powerMenu', 'shell', 'Super+X', 'Quick menu', 'Menu rapide'],
  ['clipboard', 'shell', 'Super+V', 'Clipboard history', 'Historique du Presse-papiers'],
  ['focusMode', 'shell', 'Super+Shift+F', 'Turn Focus on or off', 'Activer ou désactiver Concentration'],
  ['screenshot', 'shell', 'Super+Shift+S', 'Screenshot', 'Capture d’écran'],
  ['taskView', 'windows', 'Super+Tab', 'Overview', 'Vue d’ensemble'],
  ['snapLayouts', 'windows', 'Super+Z', 'Layouts', 'Dispositions'],
  ['snapLeft', 'windows', 'Super+ArrowLeft', 'Place on the left', 'Placer à gauche'],
  ['snapRight', 'windows', 'Super+ArrowRight', 'Place on the right', 'Placer à droite'],
  ['maximize', 'windows', 'Super+ArrowUp', 'Maximize', 'Agrandir'],
  ['minimize', 'windows', 'Super+ArrowDown', 'Restore or minimize', 'Restaurer ou réduire'],
  ['maximizeVertically', 'windows', 'Super+Shift+ArrowUp', 'Maximize vertically', 'Agrandir verticalement'],
  ['minimizeAll', 'windows', 'Super+M', 'Minimize all windows', 'Réduire toutes les fenêtres'],
  ['restoreAll', 'windows', 'Super+Shift+M', 'Restore minimized windows', 'Restaurer les fenêtres réduites'],
  ['minimizeOthers', 'windows', 'Super+Home', 'Minimize the other windows', 'Réduire les autres fenêtres'],
  ['windowMenu', 'windows', 'Alt+Space', 'Window menu', 'Menu de la fenêtre'],
  ['closeWindow', 'windows', 'Alt+F4', 'Close the window', 'Fermer la fenêtre'],
  ['newDesktop', 'desktops', 'Super+Ctrl+D', 'New desktop', 'Nouveau bureau'],
  ['closeDesktop', 'desktops', 'Super+Ctrl+F4', 'Close the desktop', 'Fermer le bureau'],
  ['prevDesktop', 'desktops', 'Super+Ctrl+ArrowLeft', 'Previous desktop', 'Bureau précédent'],
  ['nextDesktop', 'desktops', 'Super+Ctrl+ArrowRight', 'Next desktop', 'Bureau suivant'],
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`taskbarApp${n}`, 'taskbar', `Super+${n}`, `Open or switch to taskbar app ${n}`, `Ouvrir ou afficher l’application ${n} de la barre`]),
  ['files', 'apps', 'Super+E', 'Files', 'Fichiers'],
  ['settings', 'apps', 'Super+I', 'Settings', 'Paramètres'],
  ['terminal', 'apps', 'Ctrl+Alt+T', 'Terminal', 'Terminal'],
  ['taskManager', 'apps', 'Ctrl+Shift+Escape', 'System Monitor', 'Moniteur système'],
  ['browser', 'apps', null, 'Browser', 'Navigateur'],
  ['notepad', 'apps', null, 'Text Editor', 'Éditeur de texte'],
  ['calculator', 'apps', null, 'Calculator', 'Calculatrice'],
  ['accessibility', 'apps', 'Super+U', 'Accessibility settings', 'Paramètres d’accessibilité'],
  ['display', 'apps', 'Super+P', 'Display settings', 'Paramètres d’affichage'],
];
export const SHORTCUTS = LIST.map(([id, group, combo, en, fr]) => ({ id, group, combo, name: { en, fr } }));
export const SHORTCUT_IDS = new Set(SHORTCUTS.map((s) => s.id));
const DEFAULT_COMBOS = new Set(SHORTCUTS.map((s) => s.combo).filter(Boolean));

// "Open this app" shortcuts added by the user: 'app:<appId>'.
const APP_PREFIX = 'app:';
const APP_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
export const isAppAction = (id) => typeof id === 'string' && id.startsWith(APP_PREFIX) && APP_ID.test(id.slice(APP_PREFIX.length));
export const appActionId = (appId) => `${APP_PREFIX}${appId}`;
export const appOfAction = (id) => (isAppAction(id) ? id.slice(APP_PREFIX.length) : null);
export const MAX_APP_SHORTCUTS = 40;

// Combos that stay as they are (they are part of how the keyboard works): never rebound, never taken.
export const FIXED_COMBOS = new Set([
  'Alt+Tab', 'Alt+Shift+Tab', 'Ctrl+Alt+Tab', 'Ctrl+Alt+Delete', 'PrintScreen',
  'AudioVolumeUp', 'AudioVolumeDown', 'AudioVolumeMute', 'BrightnessUp', 'BrightnessDown',
]);
// Combos the X server takes before any app sees them (virtual terminals, "zap").
export const RESERVED_COMBOS = new Set(['Ctrl+Alt+Backspace', ...Array.from({ length: 12 }, (_, i) => `Ctrl+Alt+F${i + 1}`)]);

const MODS = ['Super', 'Ctrl', 'Alt', 'Shift'];
// keys as main/lib/hotkeys.js names them (single characters upper-cased; '.' and ',' are Period / Comma)
const KEY = /^([A-Z0-9]|[-=;/[\]]|F([1-9]|1[0-9]|2[0-4])|Arrow(Left|Right|Up|Down)|Home|End|PageUp|PageDown|Insert|Delete|Space|Tab|Escape|Enter|Backspace|Period|Comma|Pause)$/;

/**
 * Is this a combo a shortcut may use? Modifiers in canonical order, then one key; Win, or Ctrl+Alt together, or one
 * of F13–F24 (so typing and the apps' own Ctrl / Alt / Shift shortcuts are never stolen); the catalog's default
 * combos are allowed; "Super" alone is allowed (Start). Returns '' when OK, else a reason code:
 * 'format' | 'modifier' | 'fixed' | 'reserved'.
 */
export function comboProblem(combo) {
  const c = String(combo || '');
  if (c === 'Super') return '';
  if (c.length > 48) return 'format';
  const parts = c.split('+');
  const key = parts.pop();
  if (!parts.every((p, i) => MODS.includes(p) && parts.indexOf(p) === i) || !KEY.test(key || '')) return 'format';
  if (parts.join('+') !== MODS.filter((m) => parts.includes(m)).join('+')) return 'format';
  if (FIXED_COMBOS.has(c)) return 'fixed';
  if (RESERVED_COMBOS.has(c)) return 'reserved';
  if (DEFAULT_COMBOS.has(c)) return '';
  const strong = parts.includes('Super') || (parts.includes('Ctrl') && parts.includes('Alt')) || /^F(1[3-9]|2[0-4])$/.test(key);
  return strong ? '' : 'modifier';
}
export const validCombo = (c) => comboProblem(c) === '';

/**
 * The combo of every action: { [id]: combo | null } with the user's overrides applied — every catalog action, plus
 * the user's 'app:<id>' shortcuts. A stored combo that is no longer valid (older rules) falls back to the default.
 */
export function effectiveShortcuts(overrides = {}) {
  const out = {};
  const o = overrides && typeof overrides === 'object' ? overrides : {};
  for (const s of SHORTCUTS) {
    const has = Object.prototype.hasOwnProperty.call(o, s.id);
    const v = has ? o[s.id] : s.combo;
    if (v === null) out[s.id] = null;
    else out[s.id] = typeof v === 'string' && validCombo(v) ? v : s.combo;
  }
  let n = 0;
  for (const [id, v] of Object.entries(o)) {
    if (!isAppAction(id) || typeof v !== 'string' || !validCombo(v) || n >= MAX_APP_SHORTCUTS) continue;
    out[id] = v;
    n++;
  }
  return out;
}

/** The other action already using `combo` in `combos` (effectiveShortcuts), or null. */
export function conflictOf(combos, combo, exceptId) {
  if (!combo) return null;
  for (const [id, c] of Object.entries(combos || {})) if (id !== exceptId && c === combo) return id;
  return null;
}

const KEY_LABELS = {
  en: { Super: 'Super', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Escape: 'Esc', Delete: 'Del', Space: 'Space', Period: '.', Comma: ',', PrintScreen: 'PrtScn', Backspace: 'Backspace', PageUp: 'PgUp', PageDown: 'PgDn' },
  fr: { Super: 'Super', Ctrl: 'Ctrl', Shift: 'Maj', Alt: 'Alt', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Escape: 'Échap', Delete: 'Suppr', Space: 'Espace', Period: '.', Comma: ',', PrintScreen: 'Impr. écran', Home: 'Origine', End: 'Fin', Tab: 'Tab', Enter: 'Entrée', Backspace: 'Retour arrière', Insert: 'Inser', PageUp: 'Pg préc.', PageDown: 'Pg suiv.' },
};
/** Key caps of a combo for display: ['Super', 'Maj', 'S'] */
export function comboKeys(combo, lang = 'en') {
  if (!combo) return [];
  const map = KEY_LABELS[lang] || KEY_LABELS.en;
  return String(combo)
    .split('+')
    .map((k) => map[k] || k);
}
