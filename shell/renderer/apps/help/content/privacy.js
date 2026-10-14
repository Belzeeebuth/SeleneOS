// Aide — « Confidentialité ». Facts checked against apps/settings/pages/privacy.js (no data collected), main/ipc/weather.js
// (Open-Meteo, only once a place is set), main/ipc/maps.js (OpenStreetMap), main/ipc/updates.js and apt-daily,
// main/lib/sources/flathub.js, main/ipc/firmware.js (LVFS), browser/lib/store.js + core/start.js (DuckDuckGo).
export default [
  {
    id: 'privacy',
    topic: 'privacy',
    title: { en: 'What Selene sends over the Internet', fr: 'Ce que Selene envoie sur Internet' },
    summary: { en: 'No usage data is collected. Here is what goes online, and why.', fr: 'Aucune donnée d’utilisation n’est collectée. Voici ce qui passe par Internet, et pourquoi.' },
    keywords: { en: ['privacy', 'telemetry', 'tracking', 'data', 'internet', 'online', 'diagnostics'], fr: ['confidentialité', 'télémétrie', 'pistage', 'données', 'internet', 'en ligne', 'diagnostics', 'vie privée'] },
    related: ['activity', 'security', 'diagnostic'],
    actions: { settings: { app: 'settings', args: { page: 'privacy' } } },
    body: {
      en: [
        'Selene does not collect or send any usage or diagnostic data. **Settings** › **Privacy** says so under **Diagnostics & feedback**.',
        'Some features need the Internet, only for what you ask:',
        {
          list: [
            '**Updates**: the lists of updates come from the Ubuntu archive; Software uses Flathub; firmware information comes from the LVFS service.',
            '**Weather** asks Open-Meteo for the forecast of the places you add, and **Maps** loads the OpenStreetMap maps.',
            'Web searches from the Launcher and the **Browser** go to DuckDuckGo at first.',
          ],
        },
        { action: 'settings' },
      ],
      fr: [
        'Selene ne collecte et n’envoie aucune donnée d’utilisation ni de diagnostic. **Paramètres** › **Confidentialité** l’indique sous **Diagnostics et commentaires**.',
        'Certaines fonctions ont besoin d’Internet, seulement pour ce que vous demandez :',
        {
          list: [
            '**Mises à jour** : la liste des mises à jour vient de l’archive Ubuntu ; la Logithèque utilise Flathub ; les informations sur les microprogrammes viennent du service LVFS.',
            '**Météo** demande à Open-Meteo les prévisions des lieux que vous ajoutez, et **Cartes** charge les cartes d’OpenStreetMap.',
            'Les recherches web du Lanceur et du **Navigateur** passent par DuckDuckGo au départ.',
          ],
        },
        { action: 'settings' },
      ],
    },
  },
  {
    id: 'activity',
    topic: 'privacy',
    title: { en: 'Recent files and history', fr: 'Fichiers récents et historique' },
    summary: { en: 'Choose whether the Launcher and Files remember what you opened.', fr: 'Choisir si le Lanceur et Fichiers se souviennent de ce que vous ouvrez.' },
    keywords: { en: ['history', 'recent files', 'activity', 'clear', 'clipboard'], fr: ['historique', 'fichiers récents', 'activité', 'effacer', 'presse-papiers'] },
    related: ['privacy', 'clipboard'],
    actions: { settings: { app: 'settings', args: { page: 'privacy' } }, start: { app: 'settings', args: { page: 'start' } } },
    body: {
      en: [
        {
          list: [
            '**Settings** › **Privacy** › **Activity history** turns off the list of recently opened files in the Launcher and in Files.',
            '**Settings** › **Personalization** › **Launcher** can clear the list of recently opened files.',
            'The [[clipboard]] is off unless you turn it on.',
          ],
        },
        { actions: ['settings', 'start'] },
      ],
      fr: [
        {
          list: [
            '**Paramètres** › **Confidentialité** › **Historique des activités** désactive la liste des fichiers récemment ouverts dans le Lanceur et dans Fichiers.',
            '**Paramètres** › **Personnalisation** › **Lanceur** peut effacer la liste des fichiers récemment ouverts.',
            'L’[[clipboard|historique du Presse-papiers]] reste désactivé tant que vous ne l’activez pas.',
          ],
        },
        { actions: ['settings', 'start'] },
      ],
    },
  },
];
