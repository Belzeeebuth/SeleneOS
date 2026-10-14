// Aide — « Comptes et sécurité ». Facts checked against apps/settings/pages/accounts.js, pages/system.js (Power),
// pages/privacy.js, core/features/lock.js, core/greeter/strings.js, core/services.js (admin prompt), apps/passwords.
export default [
  {
    id: 'password',
    topic: 'accounts',
    title: { en: 'Change your password', fr: 'Modifier votre mot de passe' },
    summary: { en: 'Choose a new password, or get help when you forgot it.', fr: 'Choisir un nouveau mot de passe, ou se faire aider en cas d’oubli.' },
    keywords: { en: ['password', 'sign in', 'login', 'forgot', 'reset'], fr: ['mot de passe', 'connexion', 'oublié', 'réinitialiser'] },
    related: ['lock', 'users'],
    actions: { settings: { app: 'settings', args: { page: 'signIn', section: 'password' } } },
    body: {
      en: [
        {
          steps: [
            'Open **Settings** › **Accounts** › **Sign-in options**.',
            'Next to **Password**, click **Change**.',
            'Type your current password, then the new one twice.',
          ],
        },
        'You can also press {{Ctrl+Alt+Delete}} and choose **Change a password**.',
        { h: 'Forgot your password?' },
        'Ask an administrator of this computer: in **Settings** › **Accounts** › **Other users**, they can choose **Reset password** for your account.',
        { action: 'settings' },
      ],
      fr: [
        {
          steps: [
            'Ouvrez **Paramètres** › **Comptes** › **Options de connexion**.',
            'À côté de **Mot de passe**, cliquez sur **Modifier**.',
            'Tapez votre mot de passe actuel, puis deux fois le nouveau.',
          ],
        },
        'Vous pouvez aussi appuyer sur {{Ctrl+Alt+Delete}} et choisir **Modifier un mot de passe**.',
        { h: 'Mot de passe oublié ?' },
        'Demandez à un administrateur de cet ordinateur : dans **Paramètres** › **Comptes** › **Autres utilisateurs**, il peut choisir **Réinitialiser le mot de passe** pour votre compte.',
        { action: 'settings' },
      ],
    },
  },
  {
    id: 'lock',
    topic: 'accounts',
    title: { en: 'Lock the screen', fr: 'Verrouiller l’écran' },
    summary: { en: 'Lock when you step away, by hand or automatically.', fr: 'Verrouiller quand vous vous absentez, à la main ou automatiquement.' },
    keywords: { en: ['lock', 'lock screen', 'away', 'idle', 'inactivity', 'sign out'], fr: ['verrouiller', 'écran de verrouillage', 'absence', 'inactivité', 'déconnecter'] },
    related: ['password', 'wallpaper'],
    actions: { lock: { app: 'settings', args: { page: 'power', section: 'lock' } } },
    body: {
      en: [
        'Press {{sc:lock}}, or choose **Lock** from the power button of the Launcher. Your apps stay open; your password is asked to come back.',
        { h: 'Lock automatically' },
        {
          list: [
            'In **Settings** › **Power**, **Lock the screen after** locks after a time without activity (**Never** at first).',
            '**Lock when the screen turns off** is on at first: when the screen goes dark after a while, your password is asked when you come back.',
          ],
        },
        'To close your session instead, choose **Sign out** in the account menu of the Launcher.',
        { action: 'lock' },
      ],
      fr: [
        'Appuyez sur {{sc:lock}}, ou choisissez **Verrouiller** depuis le bouton Marche/Arrêt du Lanceur. Vos applications restent ouvertes ; votre mot de passe est demandé pour revenir.',
        { h: 'Verrouiller automatiquement' },
        {
          list: [
            'Dans **Paramètres** › **Alimentation**, **Verrouiller l’écran après** verrouille après un temps sans activité (**Jamais** au départ).',
            '**Verrouiller quand l’écran s’éteint** est activé au départ : quand l’écran s’éteint après un moment, votre mot de passe est demandé à votre retour.',
          ],
        },
        'Pour fermer votre session, choisissez plutôt **Se déconnecter** dans le menu du compte, dans le Lanceur.',
        { action: 'lock' },
      ],
    },
  },
  {
    id: 'users',
    topic: 'accounts',
    title: { en: 'Accounts and other users', fr: 'Comptes et autres utilisateurs' },
    summary: { en: 'Your picture and name, accounts for other people, administrators.', fr: 'Votre photo et votre nom, des comptes pour d’autres personnes, les administrateurs.' },
    keywords: { en: ['account', 'user', 'add user', 'administrator', 'standard', 'picture', 'avatar', 'name', 'automatic sign in'], fr: ['compte', 'utilisateur', 'ajouter un utilisateur', 'administrateur', 'standard', 'photo', 'avatar', 'nom', 'connexion automatique'] },
    related: ['password', 'admin-prompt'],
    actions: { info: { app: 'settings', args: { page: 'yourInfo' } }, users: { app: 'settings', args: { page: 'users' } } },
    body: {
      en: [
        '**Settings** › **Accounts** › **Your info** changes your picture (**Browse files**) and your full name.',
        { h: 'Add an account for someone else' },
        {
          steps: [
            'Open **Accounts** › **Other users** and click **Add account** (administrators only).',
            'Fill in the full name, the user name and the password.',
            'Tick **Make this account an administrator** only for people you trust with the whole computer.',
          ],
        },
        'Each account has its own files and settings. To remove one, open it and click **Remove**: you can delete its files or keep them.',
        { actions: ['info', 'users'] },
      ],
      fr: [
        '**Paramètres** › **Comptes** › **Vos informations** change votre photo (**Parcourir les fichiers**) et votre nom complet.',
        { h: 'Ajouter un compte pour quelqu’un d’autre' },
        {
          steps: [
            'Ouvrez **Comptes** › **Autres utilisateurs** et cliquez sur **Ajouter un compte** (administrateurs seulement).',
            'Remplissez le nom complet, le nom d’utilisateur et le mot de passe.',
            'Cochez **Faire de ce compte un administrateur** seulement pour une personne à qui vous confiez tout l’ordinateur.',
          ],
        },
        'Chaque compte a ses propres fichiers et réglages. Pour en supprimer un, ouvrez-le et cliquez sur **Supprimer** : vous pouvez effacer ses fichiers ou les conserver.',
        { actions: ['info', 'users'] },
      ],
    },
  },
  {
    id: 'admin-prompt',
    topic: 'accounts',
    title: { en: 'Administrator permission', fr: 'L’autorisation d’administrateur' },
    summary: { en: 'Why Selene sometimes asks for your password.', fr: 'Pourquoi Selene demande parfois votre mot de passe.' },
    keywords: { en: ['admin', 'administrator', 'sudo', 'permission', 'allow', 'password prompt'], fr: ['admin', 'administrateur', 'sudo', 'autorisation', 'autoriser', 'demande de mot de passe'] },
    related: ['users', 'system-updates'],
    body: {
      en: [
        'Changes to the whole computer (installing updates or apps for everyone, adding a printer, formatting a stick…) show **Allow this app to make changes to the system?** with the name of the app that asks.',
        'Type your password and choose **Yes**. Only administrator accounts can allow these changes; with a standard account, ask an administrator.',
      ],
      fr: [
        'Les changements qui touchent tout l’ordinateur (installer des mises à jour ou des applications pour tous, ajouter une imprimante, formater une clé…) affichent **Autoriser cette application à modifier le système ?** avec le nom de l’application qui le demande.',
        'Tapez votre mot de passe et choisissez **Oui**. Seuls les comptes administrateur peuvent autoriser ces changements ; avec un compte standard, demandez à un administrateur.',
      ],
    },
  },
  {
    id: 'security',
    topic: 'accounts',
    title: { en: 'Firewall and device security', fr: 'Pare-feu et sécurité de l’appareil' },
    summary: { en: 'The firewall is on; check Secure Boot, AppArmor and the TPM.', fr: 'Le pare-feu est activé ; vérifiez le démarrage sécurisé, AppArmor et le TPM.' },
    keywords: { en: ['firewall', 'ufw', 'security', 'secure boot', 'apparmor', 'tpm', 'protection'], fr: ['pare-feu', 'ufw', 'sécurité', 'démarrage sécurisé', 'apparmor', 'tpm', 'protection'] },
    related: ['privacy', 'admin-prompt'],
    actions: { settings: { app: 'settings', args: { page: 'privacy' } } },
    body: {
      en: [
        '**Settings** › **Privacy** opens on **Selene Security**:',
        {
          list: [
            '**Firewall & network protection**: blocks the incoming connections you did not allow. It is on from the start.',
            '**Device security**: the state of AppArmor, the firmware, Secure Boot and the security processor (TPM).',
            'The page also shows **Account protection** and **Screen lock**.',
          ],
        },
        { action: 'settings' },
      ],
      fr: [
        '**Paramètres** › **Confidentialité** s’ouvre sur **Sécurité Selene** :',
        {
          list: [
            '**Pare-feu et protection du réseau** : bloque les connexions entrantes que vous n’avez pas autorisées. Il est activé dès le départ.',
            '**Sécurité de l’appareil** : l’état d’AppArmor, du micrologiciel, du démarrage sécurisé et du processeur de sécurité (TPM).',
            'La page présente aussi **Protection du compte** et **Verrouillage de l’écran**.',
          ],
        },
        { action: 'settings' },
      ],
    },
  },
  {
    id: 'passwords-app',
    topic: 'accounts',
    title: { en: 'Keep your passwords safe', fr: 'Garder vos mots de passe en sécurité' },
    summary: { en: 'The Passwords app: an encrypted vault and a generator.', fr: 'L’application Mots de passe : un coffre chiffré et un générateur.' },
    keywords: { en: ['passwords', 'vault', 'master password', 'generator', 'csv', 'logins'], fr: ['mots de passe', 'coffre', 'mot de passe principal', 'générateur', 'csv', 'identifiants'] },
    related: ['password'],
    actions: { open: { app: 'passwords' } },
    body: {
      en: [
        '**Passwords** keeps your logins in an encrypted vault, opened with one **Master password** (8 characters or more).',
        {
          list: [
            'The **Password generator** makes strong passwords or passphrases.',
            'The vault locks by itself after a few minutes, and when the screen locks. Copied passwords are cleared from the clipboard after 30 seconds.',
            '**Import from CSV…** reads a list exported from a browser or another password manager.',
          ],
        },
        { note: 'Nobody can recover a forgotten master password, not even an administrator. Keep it somewhere safe.' },
        { action: 'open' },
      ],
      fr: [
        '**Mots de passe** garde vos identifiants dans un coffre chiffré, ouvert avec un seul **Mot de passe principal** (8 caractères ou plus).',
        {
          list: [
            'Le **Générateur de mots de passe** crée des mots de passe ou des phrases de passe solides.',
            'Le coffre se verrouille tout seul après quelques minutes, et quand l’écran se verrouille. Les mots de passe copiés sont effacés du presse-papiers après 30 secondes.',
            '**Importer depuis un CSV…** lit une liste exportée d’un navigateur ou d’un autre gestionnaire de mots de passe.',
          ],
        },
        { note: 'Personne ne peut retrouver un mot de passe principal oublié, pas même un administrateur. Conservez-le en lieu sûr.' },
        { action: 'open' },
      ],
    },
  },
];
