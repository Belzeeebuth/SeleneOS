// Aide — « Accessibilité ». Facts checked against apps/settings/pages/accessibility.js, personalization-designer.js
// (text size, visual effects), personalization-packs.js (pointer size), core/theme.js (Contraste élevé),
// core/features/quick.js (Accessibilité tile), core/greeter/greeter.js (sign-in screen menu), main/ipc/screenreader.js.
// The magnifier and the on-screen keyboard are built by other parts of Selene: their articles show only when found.
export default [
  {
    id: 'accessibility-vision',
    topic: 'accessibility',
    title: { en: 'See the screen better', fr: 'Mieux voir l’écran' },
    summary: { en: 'Bigger text, high contrast, a larger pointer, fewer animations.', fr: 'Texte plus grand, contraste élevé, pointeur plus gros, moins d’animations.' },
    keywords: { en: ['vision', 'bigger text', 'text size', 'zoom', 'scale', 'contrast', 'high contrast', 'pointer size', 'cursor', 'animations', 'motion', 'transparency'], fr: ['vision', 'texte plus grand', 'taille du texte', 'zoom', 'échelle', 'contraste', 'contraste élevé', 'taille du pointeur', 'curseur', 'animations', 'mouvement', 'transparence'] },
    related: ['screen-reader', 'magnifier', 'osk', 'personalize-more', 'theme'],
    actions: { a11y: { app: 'settings', args: { page: 'accessibility' } }, text: { app: 'settings', args: { page: 'textSize' } }, style: { app: 'settings', args: { page: 'visualStyle' } }, cursors: { app: 'settings', args: { page: 'cursors' } } },
    body: {
      en: [
        '**Settings** › **Accessibility** gathers these settings. {{sc:accessibility}} opens it directly.',
        {
          list: [
            '**Text size** makes the text bigger (up to 150 %); **Scale everything** enlarges the whole desktop (up to 200 %).',
            '**Visual effects**: **Reduce motion** turns off animations and animated wallpapers; **Transparency effects** makes surfaces solid.',
            '**High contrast** is a visual style with solid colours and thick borders: **Personalization** › **Visual style**.',
            'A larger pointer: **Personalization** › **Cursors** › **Size**.',
          ],
        },
        'The **Accessibility** tile of Quick settings turns the animation and transparency effects and the screen reader on or off.',
        { tip: 'On the sign-in screen, the **Accessibility** menu offers **Larger text** and turns off the animations.' },
        { actions: ['a11y', 'text', 'style', 'cursors'] },
      ],
      fr: [
        '**Paramètres** › **Accessibilité** rassemble ces réglages. {{sc:accessibility}} l’ouvre directement.',
        {
          list: [
            '**Taille du texte** agrandit le texte (jusqu’à 150 %) ; **Tout mettre à l’échelle** agrandit tout le bureau (jusqu’à 200 %).',
            '**Effets visuels** : **Réduire les animations** désactive les animations et les fonds d’écran animés ; **Effets de transparence** rend les surfaces opaques.',
            '**Contraste élevé** est un style visuel aux couleurs franches et aux bordures épaisses : **Personnalisation** › **Style visuel**.',
            'Un pointeur plus gros : **Personnalisation** › **Curseurs** › **Taille**.',
          ],
        },
        'La vignette **Accessibilité** des Réglages rapides active ou désactive les effets d’animation, les effets de transparence et le lecteur d’écran.',
        { tip: 'Sur l’écran de connexion, le menu **Accessibilité** propose **Texte plus grand** et la désactivation des animations.' },
        { actions: ['a11y', 'text', 'style', 'cursors'] },
      ],
    },
  },
  {
    id: 'screen-reader',
    topic: 'accessibility',
    title: { en: 'The screen reader', fr: 'Le lecteur d’écran' },
    summary: { en: 'Have the screen read aloud with Orca.', fr: 'Faire lire l’écran à voix haute avec Orca.' },
    keywords: { en: ['screen reader', 'orca', 'speech', 'voice', 'read aloud', 'blind', 'narrator'], fr: ['lecteur d’écran', 'orca', 'synthèse vocale', 'voix', 'lire à voix haute', 'aveugle', 'narrateur'] },
    related: ['accessibility-vision'],
    actions: { settings: { app: 'settings', args: { page: 'screenReader' } } },
    body: {
      en: [
        'The screen reader (Orca) reads aloud what is on the screen. Press {{sc:screenReader}} to turn it on or off.',
        'In **Settings** › **Accessibility** › **Screen reader**, set the **Speech rate** and the **Voice**, and **Listen** to try them.',
        { tip: 'Orca’s own commands use the {{Insert}} key.' },
        { note: 'The screen reader works in your session, not on the sign-in screen.' },
        { action: 'settings' },
      ],
      fr: [
        'Le lecteur d’écran (Orca) lit à voix haute ce qui est à l’écran. Appuyez sur {{sc:screenReader}} pour l’activer ou le désactiver.',
        'Dans **Paramètres** › **Accessibilité** › **Lecteur d’écran**, réglez la **Vitesse de la voix** et la **Voix**, et cliquez sur **Écouter** pour les essayer.',
        { tip: 'Les commandes propres à Orca utilisent la touche {{Insert}}.' },
        { note: 'Le lecteur d’écran fonctionne dans votre session, pas sur l’écran de connexion.' },
        { action: 'settings' },
      ],
    },
  },
  {
    id: 'magnifier',
    topic: 'accessibility',
    title: { en: 'Magnifier', fr: 'La Loupe' },
    summary: { en: 'Enlarge part of the screen.', fr: 'Agrandir une partie de l’écran.' },
    keywords: { en: ['magnifier', 'zoom', 'enlarge', 'magnify'], fr: ['loupe', 'zoom', 'agrandir', 'grossir'] },
    related: ['accessibility-vision'],
    requires: [{ find: true }],
    find: { apps: ['magnifier', 'loupe'], names: [/\bloupe\b/i, /magnifier/i] },
    body: {
      en: ['The Magnifier enlarges part of the screen, to read small text and see details more easily.', { howto: true }],
      fr: ['La Loupe agrandit une partie de l’écran, pour lire plus facilement les petits textes et voir les détails.', { howto: true }],
    },
  },
  {
    id: 'osk',
    topic: 'accessibility',
    title: { en: 'On-screen keyboard', fr: 'Le Clavier visuel' },
    summary: { en: 'Type without a physical keyboard.', fr: 'Taper sans clavier physique.' },
    keywords: { en: ['on-screen keyboard', 'virtual keyboard', 'touch', 'type'], fr: ['clavier visuel', 'clavier virtuel', 'clavier à l’écran', 'tactile', 'taper'] },
    related: ['accessibility-vision'],
    requires: [{ find: true }],
    find: { apps: ['osk', 'onscreen-keyboard'], names: [/clavier visuel/i, /on-screen keyboard/i] },
    body: {
      en: ['The on-screen keyboard shows a keyboard on the screen: you type by clicking or touching its keys.', { howto: true }],
      fr: ['Le Clavier visuel affiche un clavier à l’écran : vous tapez en cliquant ou en touchant ses touches.', { howto: true }],
    },
  },
];
