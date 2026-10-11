// Customizable keyboard shortcuts (docs/PERSONALIZATION.md §12.1): the catalog of shell actions a user can rebind.
//   settings.shortcuts = { [actionId]: 'Super+K' | null }   (missing = the default combo, null = turned off)
// features/hotkeys.js builds the live combo -> action map from it; main/lib/hotkeys.js is told which extra
// (non-Super) combos to capture (hotkeys:setCustom). Combos use the main/lib/hotkeys.js syntax: modifiers in the
// order Super, Ctrl, Alt, Shift, then the key ("Super+Shift+S", "Ctrl+Alt+T").
//   import { SHORTCUTS, SHORTCUT_GROUPS, validCombo, comboLabel, effectiveShortcuts } from './shortcuts.js';

export const SHORTCUT_GROUPS = [
  { id: 'shell', name: { en: 'Desktop and Start', fr: 'Bureau et Démarrer' } },
  { id: 'windows', name: { en: 'Windows', fr: 'Fenêtres' } },
  { id: 'desktops', name: { en: 'Virtual desktops', fr: 'Bureaux virtuels' } },
  { id: 'apps', name: { en: 'Apps', fr: 'Applications' } },
];

// [id, group, default combo (null = none), English, French]
const LIST = [
  ['start', 'shell', 'Super', 'Open or close Start', 'Ouvrir ou fermer Démarrer'],
  ['search', 'shell', 'Super+S', 'Search', 'Rechercher'],
  ['quickSettings', 'shell', 'Super+A', 'Quick settings', 'Paramètres rapides'],
  ['notifications', 'shell', 'Super+N', 'Notifications and calendar', 'Notifications et calendrier'],
  ['widgets', 'shell', 'Super+W', 'Widgets', 'Widgets'],
  ['showDesktop', 'shell', 'Super+D', 'Show or hide the desktop', 'Afficher ou masquer le bureau'],
  ['lock', 'shell', 'Super+L', 'Lock the screen', 'Verrouiller l’écran'],
  ['run', 'shell', 'Super+R', 'Run', 'Exécuter'],
  ['powerMenu', 'shell', 'Super+X', 'Quick link menu', 'Menu des liens rapides'],
  ['clipboard', 'shell', 'Super+V', 'Clipboard history', 'Historique du Presse-papiers'],
  ['focusMode', 'shell', 'Super+Shift+F', 'Focus mode on or off', 'Activer ou désactiver le mode concentration'],
  ['screenshot', 'shell', 'Super+Shift+S', 'Screen snip', 'Capture d’écran'],
  ['taskView', 'windows', 'Super+Tab', 'Task view', 'Vue des tâches'],
  ['snapLayouts', 'windows', 'Super+Z', 'Snap layouts', 'Dispositions d’ancrage'],
  ['snapLeft', 'windows', 'Super+ArrowLeft', 'Snap to the left', 'Ancrer à gauche'],
  ['snapRight', 'windows', 'Super+ArrowRight', 'Snap to the right', 'Ancrer à droite'],
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
  ['files', 'apps', 'Super+E', 'File Explorer', 'Explorateur de fichiers'],
  ['settings', 'apps', 'Super+I', 'Settings', 'Paramètres'],
  ['terminal', 'apps', 'Ctrl+Alt+T', 'Terminal', 'Terminal'],
  ['taskManager', 'apps', 'Ctrl+Shift+Escape', 'Task Manager', 'Gestionnaire des tâches'],
  ['browser', 'apps', null, 'Aurora Browser', 'Navigateur Aurora'],
  ['notepad', 'apps', null, 'Notepad', 'Bloc-notes'],
  ['calculator', 'apps', null, 'Calculator', 'Calculatrice'],
  ['accessibility', 'apps', 'Super+U', 'Accessibility settings', 'Paramètres d’accessibilité'],
  ['display', 'apps', 'Super+P', 'Display settings', 'Paramètres d’affichage'],
];
export const SHORTCUTS = LIST.map(([id, group, combo, en, fr]) => ({ id, group, combo, name: { en, fr } }));
export const SHORTCUT_IDS = new Set(SHORTCUTS.map((s) => s.id));

// Combos that stay as they are (they are part of how the keyboard works): never rebound, never taken.
export const FIXED_COMBOS = new Set([
  'Alt+Tab', 'Alt+Shift+Tab', 'Ctrl+Alt+Tab', 'Ctrl+Alt+Delete', 'PrintScreen',
  'AudioVolumeUp', 'AudioVolumeDown', 'AudioVolumeMute', 'BrightnessUp', 'BrightnessDown',
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `Super+${n}`),
]);

const MODS = ['Super', 'Ctrl', 'Alt', 'Shift'];
// keys as main/lib/hotkeys.js names them (single characters upper-cased; '.' and ',' are Period / Comma)
const KEY = /^([A-Z0-9]|[-=;/[\]]|F([1-9]|1[0-9]|2[0-4])|Arrow(Left|Right|Up|Down)|Home|End|PageUp|PageDown|Insert|Delete|Space|Tab|Escape|Enter|Backspace|Period|Comma|Pause)$/;

/**
 * Is this a combo a shortcut may use? Modifiers in canonical order, then one key; at least Super, Ctrl or Alt
 * (Shift alone would steal typing), except F13–F24; "Super" alone is allowed (Start). Returns '' when OK, else a reason
 * code: 'format' | 'modifier' | 'fixed'.
 */
export function comboProblem(combo) {
  const c = String(combo || '');
  if (c === 'Super') return '';
  const parts = c.split('+');
  const key = parts.pop();
  if (!parts.every((p, i) => MODS.includes(p) && parts.indexOf(p) === i) || !KEY.test(key || '')) return 'format';
  if (parts.join('+') !== MODS.filter((m) => parts.includes(m)).join('+')) return 'format';
  if (!parts.some((p) => p !== 'Shift') && !/^F(1[3-9]|2[0-4])$/.test(key)) return 'modifier';
  if (FIXED_COMBOS.has(c)) return 'fixed';
  return '';
}
export const validCombo = (c) => comboProblem(c) === '';

/** The combo of every action: { [id]: combo | null } with the user's overrides applied. */
export function effectiveShortcuts(overrides = {}) {
  const out = {};
  const o = overrides && typeof overrides === 'object' ? overrides : {};
  for (const s of SHORTCUTS) {
    const has = Object.prototype.hasOwnProperty.call(o, s.id);
    const v = has ? o[s.id] : s.combo;
    out[s.id] = v === null || v === undefined || !validCombo(v) ? (has ? null : s.combo) : v;
  }
  return out;
}

const KEY_LABELS = {
  en: { Super: 'Win', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Escape: 'Esc', Delete: 'Del', Space: 'Space', Period: '.', Comma: ',', PrintScreen: 'PrtScn' },
  fr: { Super: 'Win', Ctrl: 'Ctrl', Shift: 'Maj', Alt: 'Alt', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Escape: 'Échap', Delete: 'Suppr', Space: 'Espace', Period: '.', Comma: ',', PrintScreen: 'Impr. écran', Home: 'Origine', End: 'Fin', Tab: 'Tab', Enter: 'Entrée' },
};
/** Key caps of a combo for display: ['Win', 'Maj', 'S'] */
export function comboKeys(combo, lang = 'en') {
  if (!combo) return [];
  const map = KEY_LABELS[lang] || KEY_LABELS.en;
  return String(combo)
    .split('+')
    .map((k) => map[k] || k);
}
