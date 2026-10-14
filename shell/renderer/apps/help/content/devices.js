// Aide — « Bluetooth » and « Imprimantes ». Facts checked against apps/settings/pages/bluetooth.js,
// core/features/bluetooth.js, apps/settings/pages/printers.js, core/print.js and the apps that call it.
export const bluetooth = [
  {
    id: 'bluetooth-pair',
    topic: 'bluetooth',
    title: { en: 'Pair a Bluetooth device', fr: 'Associer un appareil Bluetooth' },
    summary: { en: 'Headphones, mouse, keyboard, phone or gamepad: pair it once, then it connects.', fr: 'Casque, souris, clavier, téléphone ou manette : associez-le une fois, il se connecte ensuite.' },
    keywords: { en: ['bluetooth', 'pair', 'headphones', 'headset', 'earbuds', 'speaker', 'mouse', 'keyboard', 'phone', 'gamepad', 'controller'], fr: ['bluetooth', 'associer', 'jumeler', 'casque', 'écouteurs', 'enceinte', 'souris', 'clavier', 'téléphone', 'manette'] },
    related: ['bluetooth-manage', 'quick-settings'],
    actions: { settings: { app: 'settings', args: { page: 'bluetooth' } } },
    body: {
      en: [
        {
          steps: [
            'Open **Settings** › **Bluetooth & devices** and turn **Bluetooth** on.',
            'Turn the device on and put it in pairing mode (see its manual).',
            'Click **Search for devices**, then **Pair** next to your device.',
            'If a code appears, check that it is the same on both sides, or type the code asked for.',
          ],
        },
        'Once paired, the device is listed under **My devices**.',
        { tip: 'Phones see the computer only while this Settings page is open.' },
        { action: 'settings' },
      ],
      fr: [
        {
          steps: [
            'Ouvrez **Paramètres** › **Bluetooth et appareils** et activez le **Bluetooth**.',
            'Allumez l’appareil et mettez-le en mode d’association (voyez sa notice).',
            'Cliquez sur **Rechercher des appareils**, puis sur **Associer** à côté de votre appareil.',
            'Si un code s’affiche, vérifiez qu’il est identique des deux côtés, ou tapez le code demandé.',
          ],
        },
        'Une fois associé, l’appareil figure dans **Mes appareils**.',
        { tip: 'Les téléphones ne voient l’ordinateur que tant que cette page des Paramètres est ouverte.' },
        { action: 'settings' },
      ],
    },
  },
  {
    id: 'bluetooth-manage',
    topic: 'bluetooth',
    title: { en: 'Connect, disconnect or forget a device', fr: 'Connecter, déconnecter ou oublier un appareil' },
    summary: { en: 'Manage paired devices and choose your Bluetooth headphones for sound.', fr: 'Gérer les appareils associés et choisir votre casque Bluetooth pour le son.' },
    keywords: { en: ['bluetooth', 'disconnect', 'remove', 'forget', 'battery', 'sound output', 'headphones'], fr: ['bluetooth', 'déconnecter', 'supprimer', 'oublier', 'batterie', 'sortie audio', 'casque'] },
    related: ['bluetooth-pair'],
    actions: { settings: { app: 'settings', args: { page: 'bluetooth' } }, sound: { app: 'settings', args: { page: 'sound' } } },
    body: {
      en: [
        {
          list: [
            'Under **My devices**, **Connect** and **Disconnect** each device; its battery level shows when the device reports it.',
            'The trash button (**Forget**) removes a device; you will need to pair it again to use it.',
            'Connected headphones and speakers can be chosen in **Settings** › **Sound**, or from the volume arrow in Quick settings.',
            'The **Bluetooth** tile of Quick settings turns Bluetooth on and off.',
          ],
        },
        { actions: ['settings', 'sound'] },
      ],
      fr: [
        {
          list: [
            'Dans **Mes appareils**, **Connecter** et **Déconnecter** chaque appareil ; son niveau de batterie s’affiche quand l’appareil l’indique.',
            'Le bouton corbeille (**Oublier**) retire un appareil ; il faudra l’associer de nouveau pour l’utiliser.',
            'Les casques et enceintes connectés se choisissent dans **Paramètres** › **Son**, ou avec la flèche du volume dans les Réglages rapides.',
            'La vignette **Bluetooth** des Réglages rapides active et désactive le Bluetooth.',
          ],
        },
        { actions: ['settings', 'sound'] },
      ],
    },
  },
];

export const printers = [
  {
    id: 'printer-add',
    topic: 'printers',
    title: { en: 'Add a printer', fr: 'Ajouter une imprimante' },
    summary: { en: 'Network and USB printers that work without a driver are added in a few clicks.', fr: 'Les imprimantes réseau et USB qui fonctionnent sans pilote s’ajoutent en quelques clics.' },
    keywords: { en: ['printer', 'add', 'wifi printer', 'usb printer', 'driver', 'airprint', 'ipp'], fr: ['imprimante', 'ajouter', 'imprimante wifi', 'imprimante usb', 'pilote', 'airprint', 'ipp'] },
    related: ['print', 'printer-manage'],
    actions: { settings: { app: 'settings', args: { page: 'printers' } } },
    body: {
      en: [
        {
          steps: [
            'Turn the printer on and connect it to the same network as the computer, or plug in its USB cable.',
            'Open **Settings** › **Bluetooth & devices** › **Printers & scanners** and click **Add a printer**.',
            'Click **Add** next to your printer, then enter the administrator password.',
          ],
        },
        'Selene uses printers that print without a driver (IPP Everywhere, AirPrint, Mopria), as most recent printers do. A printer marked **Driver needed** cannot be added.',
        { action: 'settings' },
      ],
      fr: [
        {
          steps: [
            'Allumez l’imprimante et connectez-la au même réseau que l’ordinateur, ou branchez son câble USB.',
            'Ouvrez **Paramètres** › **Bluetooth et appareils** › **Imprimantes et scanners** et cliquez sur **Ajouter une imprimante**.',
            'Cliquez sur **Ajouter** à côté de votre imprimante, puis entrez le mot de passe administrateur.',
          ],
        },
        'Selene utilise les imprimantes qui impriment sans pilote (IPP Everywhere, AirPrint, Mopria), comme la plupart des modèles récents. Une imprimante marquée **Pilote nécessaire** ne peut pas être ajoutée.',
        { action: 'settings' },
      ],
    },
  },
  {
    id: 'print',
    topic: 'printers',
    title: { en: 'Print a document', fr: 'Imprimer un document' },
    summary: { en: 'Print from the apps, or save as PDF.', fr: 'Imprimer depuis les applications, ou enregistrer en PDF.' },
    keywords: { en: ['print', 'pdf', 'copies', 'both sides', 'paper', 'landscape'], fr: ['imprimer', 'pdf', 'copies', 'recto verso', 'papier', 'paysage'] },
    related: ['printer-add', 'printer-manage'],
    body: {
      en: [
        'Press {{Ctrl+P}} in **Text Editor**, **PDF Reader**, **Photos** or **Browser** ({{Ctrl+Shift+P}} in **Notes**).',
        'Choose the **Printer**, the number of **Copies**, the **Pages**, the **Orientation**, **Print on both sides** and the **Paper size**; the first page shows as a preview.',
        { tip: 'Choose **Save as PDF** as the printer to make a PDF file instead.' },
      ],
      fr: [
        'Appuyez sur {{Ctrl+P}} dans l’**Éditeur de texte**, le **Lecteur PDF**, **Photos** ou le **Navigateur** ({{Ctrl+Shift+P}} dans **Notes**).',
        'Choisissez l’**Imprimante**, le nombre de **Copies**, les **Pages**, l’**Orientation**, le **Recto verso** et le **Format du papier** ; la première page s’affiche en aperçu.',
        { tip: 'Choisissez **Enregistrer en PDF** comme imprimante pour obtenir un fichier PDF.' },
      ],
    },
  },
  {
    id: 'printer-manage',
    topic: 'printers',
    title: { en: 'Ink, test page and print queue', fr: 'Encre, page de test et file d’attente' },
    summary: { en: 'Check the ink, print a test page, cancel a print, choose the default printer.', fr: 'Voir l’encre, imprimer une page de test, annuler une impression, choisir l’imprimante par défaut.' },
    keywords: { en: ['ink', 'toner', 'test page', 'queue', 'cancel', 'default printer', 'pause'], fr: ['encre', 'toner', 'page de test', 'file d’attente', 'annuler', 'imprimante par défaut', 'pause'] },
    related: ['printer-add', 'print'],
    actions: { settings: { app: 'settings', args: { page: 'printers' } } },
    body: {
      en: [
        'In **Printers & scanners**, each printer under **Your printers** offers **Ink levels**, **Print a test page**, **Set as default**, **Pause**, **Rename** and **Remove**.',
        'The **Print queue** lists the documents waiting; **Cancel** stops one.',
        { action: 'settings' },
      ],
      fr: [
        'Dans **Imprimantes et scanners**, chaque imprimante de **Vos imprimantes** propose **Niveaux d’encre**, **Imprimer une page de test**, **Définir par défaut**, **Mettre en pause**, **Renommer** et **Supprimer**.',
        'La **File d’attente** liste les documents en attente ; **Annuler** en arrête un.',
        { action: 'settings' },
      ],
    },
  },
  {
    id: 'scan',
    topic: 'printers',
    title: { en: 'Scan a document', fr: 'Numériser un document' },
    summary: { en: 'Turn paper into a picture or a PDF with your scanner.', fr: 'Transformer un papier en image ou en PDF avec votre scanner.' },
    keywords: { en: ['scan', 'scanner', 'scanning', 'digitize'], fr: ['numériser', 'scanner', 'numérisation', 'scan'] },
    related: ['printer-add'],
    requires: [{ app: 'scan' }],
    actions: { open: { app: 'scan' } },
    body: {
      en: ['This app scans documents and photos with a scanner connected to the computer. Find it in the Launcher, or open it here.', { action: 'open' }],
      fr: ['Cette application numérise documents et photos avec un scanner relié à l’ordinateur. Vous la trouverez dans le Lanceur, ou ouvrez-la ici.', { action: 'open' }],
    },
  },
];
