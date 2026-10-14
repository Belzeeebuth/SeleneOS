// Paramètres > Accessibilité > Loupe: settings.magnifier (core/features/magnifier.js, docs/PERSONALIZATION.md « Loupe »).
// The switch turns the magnifier on / off (like Super+= / Super+Escape and its toolbar); every other row applies live.
import { comboKeys } from '../../../core/shortcuts.js';

const S = {
  toggleDesc: { en: 'Enlarges what is on the screen, up to 1,600%', fr: 'Agrandit ce qui est à l’écran, jusqu’à 1\u202f600\u202f%' },
  zoomGroup: { en: 'Zoom', fr: 'Zoom' },
  level: { en: 'Zoom level', fr: 'Niveau de zoom' },
  levelDesc: { en: 'Used the next time the magnifier starts, and right away when it is on', fr: 'Utilisé au prochain démarrage de la loupe, et tout de suite si elle est active' },
  zoomIn: { en: 'Zoom in', fr: 'Zoom avant' },
  zoomOut: { en: 'Zoom out', fr: 'Zoom arrière' },
  step: { en: 'Zoom increment', fr: 'Incrément du zoom' },
  stepDesc: { en: 'How much each zoom in or zoom out changes the level', fr: 'De combien chaque zoom avant ou arrière change le niveau' },
  shortcutTitle: { en: 'Keyboard shortcuts', fr: 'Raccourcis clavier' },
  shortcutDesc: { en: 'Start or zoom in: {in}; zoom out: {out}; turn off: {stop}; settings: {settings}. Ctrl + Alt + mouse wheel zooms while the magnifier is on.', fr: 'Démarrer ou zoom avant : {in} ; zoom arrière : {out} ; désactiver : {stop} ; paramètres : {settings}. Ctrl + Alt + molette de la souris zoome quand la loupe est active.' },
  off: { en: 'none', fr: 'aucun' },
  followGroup: { en: 'The view follows', fr: 'La vue suit' },
  followPointer: { en: 'The mouse pointer', fr: 'Le pointeur de la souris' },
  followPointerDesc: { en: 'The part of the screen under the pointer stays where it is: what you point at is what you click', fr: 'La partie de l’écran sous le pointeur reste à sa place : ce que vous pointez est ce que vous cliquez' },
  followFocus: { en: 'The keyboard focus', fr: 'Le focus du clavier' },
  followFocusDesc: { en: 'When Tab or the arrow keys move to another button or field', fr: 'Quand Tab ou les flèches passent à un autre bouton ou champ' },
  followCaret: { en: 'The text cursor', fr: 'Le curseur de texte' },
  followCaretDesc: { en: 'While you type', fr: 'Pendant la saisie' },
  lookGroup: { en: 'Appearance', fr: 'Apparence' },
  smoothing: { en: 'Smooth the edges of images', fr: 'Lisser les bords des images' },
  smoothingDesc: { en: 'Off: enlarged pictures show their pixels (text and icons always stay sharp)', fr: 'Désactivé : les images agrandies montrent leurs pixels (le texte et les icônes restent toujours nets)' },
  invert: { en: 'Invert colours', fr: 'Inverser les couleurs' },
  invertDesc: { en: 'While the magnifier is on', fr: 'Pendant que la loupe est active' },
  toolbar: { en: 'Show the magnifier toolbar', fr: 'Afficher la barre d’outils de la loupe' },
  toolbarDesc: { en: 'Zoom out, level, zoom in, settings and close, at the top of the screen', fr: 'Zoom arrière, niveau, zoom avant, paramètres et fermeture, en haut de l’écran' },
  startGroup: { en: 'Start', fr: 'Démarrage' },
  startAtLogin: { en: 'Start the magnifier when you sign in', fr: 'Démarrer la loupe à l’ouverture de session' },
  tipsGroup: { en: 'Good to know', fr: 'Bon à savoir' },
  tipLinux: { en: 'Linux applications (X11 windows) are enlarged through a live copy; they take the mouse when the view follows the pointer, and their menus open at normal size', fr: 'Les applications Linux (fenêtres X11) sont agrandies grâce à une copie en direct ; elles reçoivent la souris quand la vue suit le pointeur, et leurs menus s’ouvrent à taille normale' },
  tipLock: { en: 'The lock screen stays magnified; only the zoom shortcuts work there', fr: 'L’écran de verrouillage reste agrandi ; seuls les raccourcis de zoom y fonctionnent' },
};
const MIN = 100;
const MAX = 1600;

export async function magnifier(pc) {
  const { h, kit, L, icon } = pc;
  pc.ui.loadCss('app://shell/apps/settings/pages/personalization-shell.css');
  pc.ui.loadCss('app://shell/apps/settings/pages/accessibility-magnifier.css');
  const lang = pc.lang;
  const conf = () => pc.settings.get('magnifier') || {};
  const pct = (v) => {
    try {
      return new Intl.NumberFormat(lang === 'fr' ? 'fr-FR' : 'en-US', { style: 'percent', maximumFractionDigits: 0 }).format(v / 100);
    } catch {
      return `${v} %`;
    }
  };
  const curStep = () => ([25, 50, 100].includes(Number(conf().step)) ? Number(conf().step) : 100);
  const curZoom = () => {
    const live = pc.shell?.magnifier;
    const v = live?.active ? live.zoom : Number(conf().zoom ?? 200);
    return Number.isFinite(v) ? Math.max(MIN, Math.min(MAX, Math.round(v))) : 200;
  };

  const main = kit.settingToggleRow({ icon: 'magnifying-glass', title: pc.pageTitle('magnifier'), desc: L(S.toggleDesc), key: 'magnifier.enabled', section: 'toggle' });

  const combos = pc.shell?.hotkeys?.combos?.() || {};
  const keys = (id, def) => {
    const c = id in combos ? combos[id] : def;
    return c ? comboKeys(c, lang).join(' + ') : L(S.off);
  };
  const shortcutDesc = L(S.shortcutDesc)
    .replace('{in}', keys('magnifierZoomIn', 'Super+='))
    .replace('{out}', keys('magnifierZoomOut', 'Super+-'))
    .replace('{stop}', keys('magnifierStop', 'Super+Escape'))
    .replace('{settings}', keys('magnifierSettings', 'Super+Ctrl+M'));
  const shortcut = kit.row({ icon: 'keyboard', title: L(S.shortcutTitle), desc: shortcutDesc, onClick: () => pc.go('shortcuts'), chevron: true, section: 'shortcut' });

  // zoom level: − value + (by the increment), like the toolbar
  const value = h('span', { class: 'st-mag-value', 'aria-live': 'polite' });
  const setZoom = async (v) => {
    const next = Math.max(MIN, Math.min(MAX, v));
    // on: the magnifier zooms at once and saves the level itself; off: only the saved level changes
    if (pc.shell?.magnifier?.active) pc.shell.magnifier.setZoom(next);
    else await pc.settings.set('magnifier.zoom', next);
    paintZoom();
  };
  const minus = h('button', { class: 'btn subtle icon-btn st-mag-minus', type: 'button', 'aria-label': L(S.zoomOut), onclick: () => setZoom(curZoom() - curStep()) }, icon('minus', { size: 16 }));
  const plus = h('button', { class: 'btn subtle icon-btn st-mag-plus', type: 'button', 'aria-label': L(S.zoomIn), onclick: () => setZoom(curZoom() + curStep()) }, icon('plus', { size: 16 }));
  const paintZoom = () => {
    const z = curZoom();
    value.textContent = pct(z);
    minus.disabled = z <= MIN;
    plus.disabled = z >= MAX;
  };
  paintZoom();
  const zoomCtl = h('div', { class: 'st-mag-zoom', role: 'group', 'aria-label': L(S.level) }, minus, value, plus);
  const levelRow = kit.row({ icon: 'magnifying-glass-plus', title: L(S.level), desc: L(S.levelDesc), control: zoomCtl, section: 'zoom' });

  const stepBox = kit.combo({ options: [25, 50, 100].map((v) => ({ value: v, label: pct(v) })), value: curStep(), width: 120, label: L(S.step), onChange: (v) => pc.settings.set('magnifier.step', Number(v)) });
  const stepRow = kit.row({ icon: 'arrows-out-cardinal', title: L(S.step), desc: L(S.stepDesc), control: stepBox, section: 'step' });

  const toggle = (k, ic, def, section = k) => kit.settingToggleRow({ icon: ic, title: L(S[k]), desc: S[`${k}Desc`] ? L(S[`${k}Desc`]) : undefined, key: `magnifier.${k}`, def, section });
  const off = pc.settings.on('magnifier', () => {
    paintZoom();
    stepBox.setValue?.(curStep());
  });
  const offLive = pc.shell?.on?.('magnifier:change', paintZoom);
  pc.onDispose(off);
  if (typeof offLive === 'function') pc.onDispose(offLive);

  return h(
    'div',
    { class: 'st-magnifier' },
    kit.group(null, main, shortcut),
    kit.group(L(S.zoomGroup), levelRow, stepRow),
    kit.group(L(S.followGroup), toggle('followPointer', 'cursor', true), toggle('followFocus', 'keyboard', true), toggle('followCaret', 'textbox', true)),
    kit.group(L(S.lookGroup), toggle('smoothing', 'image', true), toggle('invert', 'circle-half', false), toggle('toolbar', 'app-window', true)),
    kit.group(L(S.startGroup), toggle('startAtLogin', 'user-circle', false)),
    kit.group(L(S.tipsGroup), kit.row({ icon: 'app-window', title: L(S.tipLinux) }), kit.row({ icon: 'lock_closed', title: L(S.tipLock) })),
  );
}
