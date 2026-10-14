// Paramètres > Accessibilité > Clavier visuel: settings.osk (core/features/osk.js, docs/PERSONALIZATION.md).
// The switch shows / hides the keyboard (like Super+Ctrl+O and the bar button); the other rows change it live.
import { comboKeys } from '../../../core/shortcuts.js';
import { LAYOUTS, LAYOUT_IDS, layoutFor } from '../../../core/features/osk/layouts.js';

const S = {
  toggleDesc: { en: 'A keyboard on the screen, to type with the mouse, a touch screen or another pointing device', fr: 'Un clavier à l’écran, pour taper avec la souris, un écran tactile ou un autre dispositif de pointage' },
  shortcutTitle: { en: 'Keyboard shortcut', fr: 'Raccourci clavier' },
  shortcutDesc: { en: 'Shows or hides the on-screen keyboard', fr: 'Affiche ou masque le clavier visuel' },
  lookGroup: { en: 'Layout and size', fr: 'Disposition et taille' },
  layout: { en: 'Keyboard layout', fr: 'Disposition des touches' },
  layoutDesc: { en: 'The keys shown; the characters typed are always the ones on the keys', fr: 'Les touches affichées ; les caractères tapés sont toujours ceux des touches' },
  followSystem: { en: 'Same as the keyboard', fr: 'Comme le clavier' },
  size: { en: 'Size', fr: 'Taille' },
  sizeDesc: { en: 'Width of the keyboard (a floating keyboard can also be resized by its corner)', fr: 'Largeur du clavier (un clavier flottant se redimensionne aussi par son coin)' },
  small: { en: 'Small', fr: 'Petite' },
  medium: { en: 'Medium', fr: 'Moyenne' },
  large: { en: 'Large', fr: 'Grande' },
  position: { en: 'Position', fr: 'Position' },
  positionDesc: { en: 'Docked at the bottom of the screen, or floating where you move it', fr: 'Ancré en bas de l’écran, ou flottant là où vous le déplacez' },
  docked: { en: 'Docked at the bottom', fr: 'Ancré en bas' },
  floating: { en: 'Floating', fr: 'Flottant' },
  typingGroup: { en: 'Typing', fr: 'Saisie' },
  sound: { en: 'Key sound', fr: 'Son des touches' },
  soundDesc: { en: 'A short click for each key (never in a password field)', fr: 'Un petit clic à chaque touche (jamais dans un champ de mot de passe)' },
  autoShow: { en: 'Show automatically when a text field is selected', fr: 'Afficher automatiquement quand un champ de texte est sélectionné' },
  autoShowDesc: { en: 'For touch screens: the keyboard appears in a text field and goes away when you leave it', fr: 'Pour les écrans tactiles : le clavier apparaît dans un champ de texte et disparaît quand vous le quittez' },
  trayButton: { en: 'Show the on-screen keyboard button in the taskbar', fr: 'Afficher le bouton du clavier visuel dans la barre' },
  trayButtonDesc: { en: 'Next to the clock, to open or close it in one click', fr: 'À côté de l’horloge, pour l’ouvrir ou le fermer d’un clic' },
  tipsGroup: { en: 'Good to know', fr: 'Bon à savoir' },
  tipSticky: { en: 'Shift, Ctrl, Alt and Alt Gr stay pressed for the next key; tap them twice to lock them', fr: 'Maj, Ctrl, Alt et Alt Gr restent enfoncées pour la touche suivante ; touchez-les deux fois pour les verrouiller' },
  tipDead: { en: 'Accents such as ^ and ¨ are dead keys: tap the accent, then the letter (ê, ë)', fr: 'Les accents comme ^ et ¨ sont des touches mortes : touchez l’accent, puis la lettre (ê, ë)' },
  tipSuper: { en: 'Tap Super twice to open the Launcher', fr: 'Touchez Super deux fois pour ouvrir le Lanceur' },
  tipLock: { en: 'It also works on the lock screen and the sign-in screen (Accessibility button)', fr: 'Il fonctionne aussi sur l’écran de verrouillage et l’écran de connexion (bouton Accessibilité)' },
};

export async function onScreenKeyboard(pc) {
  const { h, kit, L } = pc;
  pc.ui.loadCss('app://shell/apps/settings/pages/personalization-shell.css');
  const conf = () => pc.settings.get('osk') || {};
  const lang = pc.lang;

  const main = kit.settingToggleRow({ icon: 'keyboard', title: pc.pageTitle('onScreenKeyboard'), desc: L(S.toggleDesc), key: 'osk.enabled', section: 'toggle' });
  const combo = pc.shell?.hotkeys?.combos?.().onScreenKeyboard ?? 'Super+Ctrl+O';
  const keys = comboKeys(combo, lang);
  const keyCaps = combo ? h('span', { class: 'pzs-keys', 'aria-label': keys.join(' + ') }, keys.map((k) => h('kbd', null, k))) : h('span', { class: 'pzs-keys off caption text-2' }, pc.t('common.off'));
  const shortcut = kit.row({ icon: 'keyboard', title: L(S.shortcutTitle), desc: L(S.shortcutDesc), control: keyCaps, onClick: () => pc.go('shortcuts'), section: 'shortcut' });

  // layout: the one of the keyboard (settings.keyboardLayout, else the session's) or a chosen one
  const st = await pc.api.invoke('locale:status').catch(() => null);
  const sysId = layoutFor(pc.settings.get('keyboardLayout') || st?.keyboard || 'us');
  const layoutOptions = [{ value: 'auto', label: `${L(S.followSystem)} (${L(LAYOUTS[sysId].name)})` }, ...LAYOUT_IDS.map((id) => ({ value: id, label: L(LAYOUTS[id].name) }))];
  const curLayout = () => (LAYOUTS[conf().layout] ? conf().layout : 'auto');
  const layoutBox = kit.combo({ options: layoutOptions, value: curLayout(), width: 260, label: L(S.layout), onChange: (v) => pc.settings.set('osk.layout', v) });
  const layoutRow = kit.row({ icon: 'globe', title: L(S.layout), desc: L(S.layoutDesc), control: layoutBox, section: 'layout' });

  const curSize = () => (['small', 'medium', 'large'].includes(conf().size) ? conf().size : 'medium');
  const sizeBox = kit.combo({ options: ['small', 'medium', 'large'].map((v) => ({ value: v, label: L(S[v]) })), value: curSize(), width: 160, label: L(S.size), onChange: (v) => pc.settings.set('osk.size', v) });
  const sizeRow = kit.row({ icon: 'resize', title: L(S.size), desc: L(S.sizeDesc), control: sizeBox, section: 'size' });

  const curMode = () => (conf().mode === 'floating' ? 'floating' : 'docked');
  const modeBox = kit.combo({ options: ['docked', 'floating'].map((v) => ({ value: v, label: L(S[v]) })), value: curMode(), width: 180, label: L(S.position), onChange: (v) => pc.settings.set('osk.mode', v) });
  const modeRow = kit.row({ icon: 'arrows-out-cardinal', title: L(S.position), desc: L(S.positionDesc), control: modeBox, section: 'position' });

  const sound = kit.settingToggleRow({ icon: 'speaker-high', title: L(S.sound), desc: L(S.soundDesc), key: 'osk.sound', section: 'sound' });
  const auto = kit.settingToggleRow({ icon: 'textbox', title: L(S.autoShow), desc: L(S.autoShowDesc), key: 'osk.autoShow', section: 'autoShow' });
  const tray = kit.settingToggleRow({ icon: 'panel_bottom', title: L(S.trayButton), desc: L(S.trayButtonDesc), key: 'osk.trayButton', section: 'trayButton' });

  const off = pc.settings.on('osk', () => {
    layoutBox.setValue?.(curLayout());
    sizeBox.setValue?.(curSize());
    modeBox.setValue?.(curMode());
  });
  pc.onDispose(off);
  return h(
    'div',
    { class: 'st-osk' },
    kit.group(null, main, shortcut),
    kit.group(L(S.lookGroup), layoutRow, sizeRow, modeRow),
    kit.group(L(S.typingGroup), sound, auto, tray),
    kit.group(L(S.tipsGroup), kit.row({ icon: 'arrow-fat-up', title: L(S.tipSticky) }), kit.row({ icon: 'text-aa', title: L(S.tipDead) }), kit.row({ icon: 'apps', title: L(S.tipSuper) }), kit.row({ icon: 'lock_closed', title: L(S.tipLock) })),
  );
}
