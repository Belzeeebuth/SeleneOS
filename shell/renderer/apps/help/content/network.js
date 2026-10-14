// Aide — « Internet et réseau ». Facts checked against apps/settings/pages/network.js, core/features/quick.js,
// apps/nettools (VPN = WireGuard .conf import through NetworkManager), main/ipc/net.js.
export default [
  {
    id: 'wifi',
    topic: 'network',
    title: { en: 'Connect to Wi-Fi', fr: 'Se connecter au Wi-Fi' },
    summary: { en: 'Join a network, a hidden network, or forget a saved one.', fr: 'Rejoindre un réseau, un réseau masqué, ou oublier un réseau enregistré.' },
    keywords: { en: ['wifi', 'wireless', 'internet', 'network', 'password', 'key', 'hidden', 'forget', 'ssid'], fr: ['wifi', 'sans fil', 'internet', 'réseau', 'mot de passe', 'clé', 'masqué', 'oublier', 'ssid'] },
    related: ['airplane', 'network-more', 'quick-settings'],
    actions: { wifi: { app: 'settings', args: { page: 'wifi' } } },
    body: {
      en: [
        {
          steps: [
            'Open **Quick settings** ({{sc:quickSettings}}) and click the arrow of the **Wi-Fi** tile.',
            'Choose your network and click **Connect**.',
            'Type the network’s key (often written on the box) and confirm.',
          ],
        },
        'In **Settings** › **Network** › **Wi-Fi** you will also find:',
        {
          list: [
            '**Connect automatically**, to join the network every time it is in range;',
            '**Manage known networks**, to **Forget** a network you no longer use;',
            '**Hidden network**, to join a network that does not show its name (you need its exact name and key).',
          ],
        },
        { action: 'wifi' },
      ],
      fr: [
        {
          steps: [
            'Ouvrez les **Réglages rapides** ({{sc:quickSettings}}) et cliquez sur la flèche de la vignette **Wi-Fi**.',
            'Choisissez votre réseau et cliquez sur **Se connecter**.',
            'Tapez la clé du réseau (souvent écrite sur la box) et validez.',
          ],
        },
        'Dans **Paramètres** › **Réseau** › **Wi-Fi**, vous trouverez aussi :',
        {
          list: [
            '**Se connecter automatiquement**, pour rejoindre le réseau chaque fois qu’il est à portée ;',
            '**Gérer les réseaux connus**, pour **Oublier** un réseau que vous n’utilisez plus ;',
            '**Réseau masqué**, pour rejoindre un réseau qui ne diffuse pas son nom (il faut son nom exact et sa clé).',
          ],
        },
        { action: 'wifi' },
      ],
    },
  },
  {
    id: 'airplane',
    topic: 'network',
    title: { en: 'Airplane mode', fr: 'Le mode avion' },
    summary: { en: 'Turn off all wireless connections at once.', fr: 'Couper toutes les connexions sans fil d’un coup.' },
    keywords: { en: ['airplane', 'flight', 'offline', 'radio', 'wireless'], fr: ['avion', 'vol', 'hors ligne', 'radio', 'sans fil'] },
    related: ['wifi', 'bluetooth-pair'],
    actions: { network: { app: 'settings', args: { page: 'network' } } },
    body: {
      en: ['**Airplane mode** stops all wireless communication, Wi-Fi and Bluetooth included. Turn it on or off with its tile in Quick settings, or in **Settings** › **Network**. When you turn it off, Wi-Fi comes back as it was.', { action: 'network' }],
      fr: ['Le **Mode avion** arrête toutes les communications sans fil, Wi-Fi et Bluetooth compris. Activez-le ou désactivez-le avec sa vignette dans les Réglages rapides, ou dans **Paramètres** › **Réseau**. Quand vous le désactivez, le Wi-Fi revient comme avant.', { action: 'network' }],
    },
  },
  {
    id: 'vpn',
    topic: 'network',
    title: { en: 'Use a VPN', fr: 'Utiliser un VPN' },
    summary: { en: 'Import a WireGuard connection and turn it on when you need it.', fr: 'Importer une connexion WireGuard et l’activer quand vous en avez besoin.' },
    keywords: { en: ['vpn', 'wireguard', 'conf', 'tunnel', 'private network'], fr: ['vpn', 'wireguard', 'conf', 'tunnel', 'réseau privé'] },
    related: ['network-more'],
    actions: { vpn: { app: 'nettools', args: { tab: 'vpn' } } },
    body: {
      en: [
        'VPN connections are in the **Network tools** app, **VPN** tab.',
        {
          steps: [
            'Get the WireGuard configuration file (.conf) from your VPN provider.',
            'Click **Import WireGuard file** and choose it. The connection takes the file’s name.',
            'Click **Connect** to use it, and **Disconnect** to stop.',
          ],
        },
        'VPN connections already set up on this computer are listed there too.',
        { note: 'OpenVPN connections are not supported yet.' },
        { action: 'vpn' },
      ],
      fr: [
        'Les connexions VPN se trouvent dans l’application **Outils réseau**, onglet **VPN**.',
        {
          steps: [
            'Procurez-vous le fichier de configuration WireGuard (.conf) auprès de votre fournisseur de VPN.',
            'Cliquez sur **Importer un fichier WireGuard** et choisissez-le. La connexion prend le nom du fichier.',
            'Cliquez sur **Se connecter** pour l’utiliser, et sur **Se déconnecter** pour l’arrêter.',
          ],
        },
        'Les connexions VPN déjà configurées sur cet ordinateur y sont aussi listées.',
        { note: 'Les connexions OpenVPN ne sont pas encore prises en charge.' },
        { action: 'vpn' },
      ],
    },
  },
  {
    id: 'network-more',
    topic: 'network',
    title: { en: 'Cable, data usage and network tests', fr: 'Câble, données utilisées et tests du réseau' },
    summary: { en: 'Wired connection details, data used since start-up, ping and DNS lookup.', fr: 'Détails de la connexion filaire, données utilisées depuis le démarrage, ping et recherche DNS.' },
    keywords: { en: ['ethernet', 'cable', 'wired', 'ip address', 'data usage', 'ping', 'dns', 'adapter'], fr: ['ethernet', 'câble', 'filaire', 'adresse ip', 'données', 'ping', 'dns', 'carte réseau'] },
    related: ['wifi', 'vpn'],
    actions: { ethernet: { app: 'settings', args: { page: 'ethernet' } }, adv: { app: 'settings', args: { page: 'advancedNetwork' } }, tools: { app: 'nettools', args: { tab: 'ping' } } },
    body: {
      en: [
        {
          list: [
            'With a network cable plugged in, **Settings** › **Network** › **Ethernet** shows the connection’s details (IP address, DNS…).',
            '**Advanced network settings** lists the network adapters and the **Data usage** since the computer started.',
            'The **Network tools** app checks whether a site answers (**Ping**) and looks up a name (**DNS lookup**).',
          ],
        },
        { actions: ['ethernet', 'adv', 'tools'] },
      ],
      fr: [
        {
          list: [
            'Quand un câble réseau est branché, **Paramètres** › **Réseau** › **Ethernet** montre les détails de la connexion (adresse IP, DNS…).',
            '**Paramètres réseau avancés** présente les cartes réseau et l’**Utilisation des données** depuis le démarrage de l’ordinateur.',
            'L’application **Outils réseau** vérifie si un site répond (**Ping**) et recherche un nom (**Recherche DNS**).',
          ],
        },
        { actions: ['ethernet', 'adv', 'tools'] },
      ],
    },
  },
];
