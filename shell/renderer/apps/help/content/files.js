// Aide — « Fichiers et clés USB ». Facts checked against apps/files (lib/navpane.js, lib/explorer.js, i18n.json),
// apps/disks, apps/archive, main/ipc/fs.js, iso/packages.d/files.list (ntfs-3g, exfatprogs).
export default [
  {
    id: 'files-basics',
    topic: 'files',
    title: { en: 'Files: the essentials', fr: 'Fichiers : l’essentiel' },
    summary: { en: 'Find your folders, use tabs, search, and see a file’s properties.', fr: 'Retrouver vos dossiers, utiliser les onglets, chercher, voir les propriétés d’un fichier.' },
    keywords: { en: ['explorer', 'folders', 'documents', 'downloads', 'tabs', 'search', 'properties', 'copy', 'move', 'rename'], fr: ['explorateur', 'dossiers', 'documents', 'téléchargements', 'onglets', 'recherche', 'propriétés', 'copier', 'déplacer', 'renommer'] },
    related: ['usb', 'trash', 'archives'],
    actions: { open: { app: 'files' } },
    body: {
      en: [
        'Open **Files** from the bar, or press {{sc:files}}.',
        {
          list: [
            'The side pane lists **Home**, your **Favorites** (Desktop, Downloads, Documents, Pictures, Music, Videos), **Computer**, the **Trash** and your **Devices**.',
            'Right-click a folder and choose **Add to sidebar** to keep it at hand.',
            '{{Ctrl+T}} opens a new tab, {{Ctrl+W}} closes it.',
            '{{Ctrl+F}} searches the names of the files in the current folder and its subfolders.',
            '{{F2}} renames, {{Alt+Enter}} shows the **Properties**, {{Ctrl+Shift+N}} makes a new folder.',
          ],
        },
        'Copy, cut and paste work as usual ({{Ctrl+C}}, {{Ctrl+X}}, {{Ctrl+V}}); a long copy shows its progress and can be cancelled.',
        { action: 'open' },
      ],
      fr: [
        'Ouvrez **Fichiers** depuis la barre, ou appuyez sur {{sc:files}}.',
        {
          list: [
            'Le volet latéral présente **Accueil**, vos **Favoris** (Bureau, Téléchargements, Documents, Images, Musique, Vidéos), **Ordinateur**, la **Corbeille** et vos **Appareils**.',
            'Faites un clic droit sur un dossier et choisissez **Ajouter à la barre latérale** pour le garder sous la main.',
            '{{Ctrl+T}} ouvre un nouvel onglet, {{Ctrl+W}} le ferme.',
            '{{Ctrl+F}} cherche dans le nom des fichiers du dossier en cours et de ses sous-dossiers.',
            '{{F2}} renomme, {{Alt+Enter}} affiche les **Propriétés**, {{Ctrl+Shift+N}} crée un dossier.',
          ],
        },
        'Copier, couper et coller fonctionnent comme d’habitude ({{Ctrl+C}}, {{Ctrl+X}}, {{Ctrl+V}}) ; une longue copie affiche sa progression et peut être annulée.',
        { action: 'open' },
      ],
    },
  },
  {
    id: 'usb',
    topic: 'files',
    title: { en: 'USB sticks and external drives', fr: 'Clés USB et disques externes' },
    summary: { en: 'Open a USB stick, remove it safely, format it.', fr: 'Ouvrir une clé USB, la retirer en toute sécurité, la formater.' },
    keywords: { en: ['usb', 'stick', 'flash drive', 'external disk', 'sd card', 'eject', 'mount', 'format', 'ntfs', 'exfat', 'fat32', 'device'], fr: ['usb', 'clé', 'disque externe', 'carte sd', 'éjecter', 'monter', 'formater', 'ntfs', 'exfat', 'fat32', 'périphérique', 'appareil'] },
    related: ['files-basics', 'backup'],
    actions: { files: { app: 'files', args: { path: 'thispc' } }, disks: { app: 'disks' } },
    body: {
      en: [
        'Plug in the stick, then open **Files**: it appears under **Devices** (and in **Computer**). Click it to open it.',
        'Sticks and disks formatted for Windows (NTFS, exFAT, FAT32) can be read and written.',
        { h: 'Remove it safely' },
        {
          steps: [
            'Close the files you opened from it.',
            'In Files, right-click the stick and choose **Eject**.',
            'Wait for the message saying it can be safely removed, then unplug it.',
          ],
        },
        { h: 'Format a stick' },
        'In **Disks**, select the stick and choose **Format…**: FAT32 works everywhere (files up to 4 GB), exFAT suits large files on Windows and macOS, ext4 is for Linux only. To avoid mistakes, you type the drive’s name to confirm, and the administrator password is asked.',
        { note: 'Formatting erases everything on the stick. Disks only formats removable drives, never the system disk.' },
        { actions: ['files', 'disks'] },
      ],
      fr: [
        'Branchez la clé, puis ouvrez **Fichiers** : elle apparaît sous **Appareils** (et dans **Ordinateur**). Cliquez dessus pour l’ouvrir.',
        'Les clés et disques formatés pour Windows (NTFS, exFAT, FAT32) peuvent être lus et modifiés.',
        { h: 'La retirer en toute sécurité' },
        {
          steps: [
            'Fermez les fichiers ouverts depuis la clé.',
            'Dans Fichiers, faites un clic droit sur la clé et choisissez **Éjecter**.',
            'Attendez le message indiquant qu’elle peut être retirée en toute sécurité, puis débranchez-la.',
          ],
        },
        { h: 'Formater une clé' },
        'Dans **Disques**, sélectionnez la clé et choisissez **Formater…** : FAT32 fonctionne partout (fichiers jusqu’à 4 Go), exFAT convient aux gros fichiers sous Windows et macOS, ext4 est réservé à Linux. Pour éviter les erreurs, vous tapez le nom du disque pour confirmer, et le mot de passe administrateur est demandé.',
        { note: 'Le formatage efface tout le contenu de la clé. Disques ne formate que les supports amovibles, jamais le disque du système.' },
        { actions: ['files', 'disks'] },
      ],
    },
  },
  {
    id: 'trash',
    topic: 'files',
    title: { en: 'The Trash: delete and restore', fr: 'La Corbeille : supprimer et restaurer' },
    summary: { en: 'Get a deleted file back, or delete for good.', fr: 'Récupérer un fichier supprimé, ou supprimer définitivement.' },
    keywords: { en: ['recycle bin', 'trash', 'delete', 'restore', 'undo', 'empty', 'recover'], fr: ['corbeille', 'supprimer', 'restaurer', 'annuler', 'vider', 'récupérer'] },
    related: ['files-basics', 'backup-restore'],
    actions: { trash: { app: 'files', args: { path: 'trash' } }, storage: { app: 'settings', args: { page: 'storage' } } },
    body: {
      en: [
        '{{Delete}} sends the selected files to the **Trash**; the message that appears lets you undo it. {{Shift+Delete}} deletes them for good, without the Trash.',
        {
          list: [
            'Open the **Trash** in the side pane of Files, select files and click **Restore the selected items**: they go back to their folder.',
            '**Empty Trash** frees the space for good. **Settings** › **Storage** can empty it too.',
          ],
        },
        { actions: ['trash', 'storage'] },
      ],
      fr: [
        '{{Delete}} envoie les fichiers sélectionnés dans la **Corbeille** ; le message qui s’affiche permet d’annuler. {{Shift+Delete}} les supprime définitivement, sans passer par la Corbeille.',
        {
          list: [
            'Ouvrez la **Corbeille** dans le volet de Fichiers, sélectionnez des fichiers et cliquez sur **Restaurer les éléments sélectionnés** : ils retournent dans leur dossier.',
            '**Vider la Corbeille** libère la place définitivement. **Paramètres** › **Stockage** peut aussi la vider.',
          ],
        },
        { actions: ['trash', 'storage'] },
      ],
    },
  },
  {
    id: 'archives',
    topic: 'files',
    title: { en: 'Zip and unzip', fr: 'Compresser et décompresser' },
    summary: { en: 'Make a ZIP file, extract an archive.', fr: 'Créer un fichier ZIP, extraire une archive.' },
    keywords: { en: ['zip', 'compress', 'extract', 'archive', 'rar', '7z', 'tar'], fr: ['zip', 'compresser', 'extraire', 'archive', 'rar', '7z', 'tar', 'décompresser'] },
    related: ['files-basics'],
    actions: { archive: { app: 'archive' } },
    body: {
      en: [
        { list: ['In Files, right-click files and choose **Compress to ZIP file**.', 'Right-click a ZIP file and choose **Extract all** to unpack it.', 'Double-clicking an archive opens it in **Archives**, which also reads 7z, RAR and TAR files and can create archives.'] },
        { action: 'archive' },
      ],
      fr: [
        { list: ['Dans Fichiers, faites un clic droit sur des fichiers et choisissez **Compresser en fichier ZIP**.', 'Un clic droit sur un fichier ZIP, puis **Extraire tout**, le décompresse.', 'Un double-clic sur une archive l’ouvre dans **Archives**, qui lit aussi les fichiers 7z, RAR et TAR et peut créer des archives.'] },
        { action: 'archive' },
      ],
    },
  },
];
