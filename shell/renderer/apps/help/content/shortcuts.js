// Aide — « Raccourcis clavier ». The list itself is generated live from core/shortcuts.js and settings.shortcuts
// (main.js shortcutTables); the rules come from core/shortcuts.js comboProblem and pages/personalization-input.js.
export default [
  {
    id: 'shortcuts',
    topic: 'shortcuts',
    title: { en: 'Keyboard shortcuts', fr: 'Raccourcis clavier' },
    summary: { en: 'Every shortcut of the desktop, as set on this computer.', fr: 'Tous les raccourcis du bureau, tels qu’ils sont réglés sur cet ordinateur.' },
    keywords: { en: ['keys', 'hotkeys', 'keyboard', 'super', 'combination', 'list'], fr: ['touches', 'clavier', 'super', 'combinaison', 'liste', 'raccourci'] },
    related: ['shortcuts-change', 'windows', 'overview', 'emoji'],
    actions: { settings: { app: 'settings', args: { page: 'shortcuts' } } },
    body: {
      en: [
        'The **Super** key is the one with the logo, between {{Ctrl}} and {{Alt}}. This list always shows the shortcuts in use on this computer: a shortcut you changed is marked **changed**.',
        { shortcuts: 'all' },
        'To change one, see [[shortcuts-change]].',
        { action: 'settings' },
      ],
      fr: [
        'La touche **Super** est celle qui porte un logo, entre {{Ctrl}} et {{Alt}}. Cette liste montre toujours les raccourcis en vigueur sur cet ordinateur : un raccourci que vous avez modifié est marqué **modifié**.',
        { shortcuts: 'all' },
        'Pour en changer un, voyez [[shortcuts-change]].',
        { action: 'settings' },
      ],
    },
  },
  {
    id: 'shortcuts-change',
    topic: 'shortcuts',
    title: { en: 'Change a shortcut', fr: 'Modifier un raccourci' },
    summary: { en: 'Choose other keys, turn a shortcut off, or add one that opens an app.', fr: 'Choisir d’autres touches, désactiver un raccourci ou en ajouter un qui ouvre une application.' },
    keywords: { en: ['rebind', 'customize', 'hotkey', 'turn off', 'app shortcut', 'reset'], fr: ['personnaliser', 'changer', 'désactiver', 'raccourci d’application', 'réinitialiser', 'restaurer'] },
    related: ['shortcuts'],
    actions: { settings: { app: 'settings', args: { page: 'shortcuts' } } },
    body: {
      en: [
        'Shortcuts are in **Settings** › **Personalization** › **Keyboard shortcuts**. Changes apply at once.',
        { h: 'Choose other keys' },
        {
          steps: [
            'Find the action (the search box helps) and click **Change**.',
            'Press the new keys together, then **Save**.',
          ],
        },
        'A shortcut needs {{Super}}, or {{Ctrl}} and {{Alt}} together, with a key; {{F13}} to {{F24}} also work alone. Other combinations belong to the apps (copy, save…).',
        'If the keys are already used, Settings tells you which action has them: saving takes them away from it.',
        { h: 'Turn off, restore, open an app' },
        {
          list: [
            'The **…** menu of a shortcut offers **Turn off** and **Restore the default**.',
            '**Add an app shortcut** creates a shortcut that opens the app you choose.',
            '**Restore all shortcuts** brings back every default.',
          ],
        },
        { note: 'A few keys cannot be changed: {{Alt+Tab}}, {{Ctrl+Alt+Tab}}, {{Ctrl+Alt+Delete}} and {{PrintScreen}}.' },
        { action: 'settings' },
      ],
      fr: [
        'Les raccourcis se trouvent dans **Paramètres** › **Personnalisation** › **Raccourcis clavier**. Les changements s’appliquent tout de suite.',
        { h: 'Choisir d’autres touches' },
        {
          steps: [
            'Trouvez l’action (la zone de recherche aide) et cliquez sur **Modifier**.',
            'Appuyez ensemble sur les nouvelles touches, puis sur **Enregistrer**.',
          ],
        },
        'Un raccourci doit comporter {{Super}}, ou {{Ctrl}} et {{Alt}} ensemble, avec une touche ; {{F13}} à {{F24}} fonctionnent aussi seules. Les autres combinaisons appartiennent aux applications (copier, enregistrer…).',
        'Si les touches sont déjà prises, Paramètres indique l’action qui les utilise : enregistrer les lui retire.',
        { h: 'Désactiver, restaurer, ouvrir une application' },
        {
          list: [
            'Le menu **…** d’un raccourci propose **Désactiver** et **Restaurer la valeur par défaut**.',
            '**Ajouter un raccourci d’application** crée un raccourci qui ouvre l’application de votre choix.',
            '**Restaurer tous les raccourcis** rétablit toutes les valeurs par défaut.',
          ],
        },
        { note: 'Quelques touches ne peuvent pas être changées : {{Alt+Tab}}, {{Ctrl+Alt+Tab}}, {{Ctrl+Alt+Delete}} et {{PrintScreen}}.' },
        { action: 'settings' },
      ],
    },
  },
];
