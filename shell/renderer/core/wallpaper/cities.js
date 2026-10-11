// Offline list of cities for the dynamic wallpaper location (works without network; the online Open-Meteo
// geocoding search, weather:search, finds every other place).
//   searchCities(query, lang) -> [{ name, country, lat, lon }]   (accent- and case-insensitive prefix/substring match)
//   samePlace(a, b)            -> true when two results name the same town (same name, within ~25 km): merges the
//                                 built-in list with the online results without showing a city twice
//   CITIES                     [[name en, name fr, country en, country fr, lat, lon], …]
export const CITIES = [
  ['Paris', 'Paris', 'France', 'France', 48.8566, 2.3522],
  ['Lyon', 'Lyon', 'France', 'France', 45.764, 4.8357],
  ['Marseille', 'Marseille', 'France', 'France', 43.2965, 5.3698],
  ['Toulouse', 'Toulouse', 'France', 'France', 43.6047, 1.4442],
  ['Bordeaux', 'Bordeaux', 'France', 'France', 44.8378, -0.5792],
  ['Lille', 'Lille', 'France', 'France', 50.6292, 3.0573],
  ['Nantes', 'Nantes', 'France', 'France', 47.2184, -1.5536],
  ['Strasbourg', 'Strasbourg', 'France', 'France', 48.5734, 7.7521],
  ['Nice', 'Nice', 'France', 'France', 43.7102, 7.262],
  ['Rennes', 'Rennes', 'France', 'France', 48.1173, -1.6778],
  ['Montpellier', 'Montpellier', 'France', 'France', 43.6108, 3.8767],
  ['Brussels', 'Bruxelles', 'Belgium', 'Belgique', 50.8503, 4.3517],
  ['Geneva', 'Genève', 'Switzerland', 'Suisse', 46.2044, 6.1432],
  ['Zurich', 'Zurich', 'Switzerland', 'Suisse', 47.3769, 8.5417],
  ['Luxembourg', 'Luxembourg', 'Luxembourg', 'Luxembourg', 49.6116, 6.1319],
  ['Montreal', 'Montréal', 'Canada', 'Canada', 45.5017, -73.5673],
  ['Quebec City', 'Québec', 'Canada', 'Canada', 46.8139, -71.208],
  ['Toronto', 'Toronto', 'Canada', 'Canada', 43.6532, -79.3832],
  ['Vancouver', 'Vancouver', 'Canada', 'Canada', 49.2827, -123.1207],
  ['London', 'Londres', 'United Kingdom', 'Royaume-Uni', 51.5074, -0.1278],
  ['Edinburgh', 'Édimbourg', 'United Kingdom', 'Royaume-Uni', 55.9533, -3.1883],
  ['Dublin', 'Dublin', 'Ireland', 'Irlande', 53.3498, -6.2603],
  ['Amsterdam', 'Amsterdam', 'Netherlands', 'Pays-Bas', 52.3676, 4.9041],
  ['Berlin', 'Berlin', 'Germany', 'Allemagne', 52.52, 13.405],
  ['Munich', 'Munich', 'Germany', 'Allemagne', 48.1351, 11.582],
  ['Vienna', 'Vienne', 'Austria', 'Autriche', 48.2082, 16.3738],
  ['Prague', 'Prague', 'Czechia', 'Tchéquie', 50.0755, 14.4378],
  ['Warsaw', 'Varsovie', 'Poland', 'Pologne', 52.2297, 21.0122],
  ['Copenhagen', 'Copenhague', 'Denmark', 'Danemark', 55.6761, 12.5683],
  ['Stockholm', 'Stockholm', 'Sweden', 'Suède', 59.3293, 18.0686],
  ['Oslo', 'Oslo', 'Norway', 'Norvège', 59.9139, 10.7522],
  ['Tromsø', 'Tromsø', 'Norway', 'Norvège', 69.6492, 18.9553],
  ['Helsinki', 'Helsinki', 'Finland', 'Finlande', 60.1699, 24.9384],
  ['Reykjavik', 'Reykjavik', 'Iceland', 'Islande', 64.1466, -21.9426],
  ['Madrid', 'Madrid', 'Spain', 'Espagne', 40.4168, -3.7038],
  ['Barcelona', 'Barcelone', 'Spain', 'Espagne', 41.3874, 2.1686],
  ['Lisbon', 'Lisbonne', 'Portugal', 'Portugal', 38.7223, -9.1393],
  ['Rome', 'Rome', 'Italy', 'Italie', 41.9028, 12.4964],
  ['Milan', 'Milan', 'Italy', 'Italie', 45.4642, 9.19],
  ['Athens', 'Athènes', 'Greece', 'Grèce', 37.9838, 23.7275],
  ['Istanbul', 'Istanbul', 'Turkey', 'Turquie', 41.0082, 28.9784],
  ['Moscow', 'Moscou', 'Russia', 'Russie', 55.7558, 37.6173],
  ['Kyiv', 'Kyiv', 'Ukraine', 'Ukraine', 50.4501, 30.5234],
  ['Cairo', 'Le Caire', 'Egypt', 'Égypte', 30.0444, 31.2357],
  ['Casablanca', 'Casablanca', 'Morocco', 'Maroc', 33.5731, -7.5898],
  ['Algiers', 'Alger', 'Algeria', 'Algérie', 36.7538, 3.0588],
  ['Tunis', 'Tunis', 'Tunisia', 'Tunisie', 36.8065, 10.1815],
  ['Dakar', 'Dakar', 'Senegal', 'Sénégal', 14.7167, -17.4677],
  ['Abidjan', 'Abidjan', 'Côte d’Ivoire', 'Côte d’Ivoire', 5.36, -4.0083],
  ['Kinshasa', 'Kinshasa', 'DR Congo', 'RD Congo', -4.4419, 15.2663],
  ['Lagos', 'Lagos', 'Nigeria', 'Nigeria', 6.5244, 3.3792],
  ['Nairobi', 'Nairobi', 'Kenya', 'Kenya', -1.2921, 36.8219],
  ['Johannesburg', 'Johannesburg', 'South Africa', 'Afrique du Sud', -26.2041, 28.0473],
  ['Cape Town', 'Le Cap', 'South Africa', 'Afrique du Sud', -33.9249, 18.4241],
  ['Dubai', 'Dubaï', 'United Arab Emirates', 'Émirats arabes unis', 25.2048, 55.2708],
  ['Mumbai', 'Bombay', 'India', 'Inde', 19.076, 72.8777],
  ['Delhi', 'Delhi', 'India', 'Inde', 28.7041, 77.1025],
  ['Bangkok', 'Bangkok', 'Thailand', 'Thaïlande', 13.7563, 100.5018],
  ['Singapore', 'Singapour', 'Singapore', 'Singapour', 1.3521, 103.8198],
  ['Hong Kong', 'Hong Kong', 'China', 'Chine', 22.3193, 114.1694],
  ['Beijing', 'Pékin', 'China', 'Chine', 39.9042, 116.4074],
  ['Shanghai', 'Shanghai', 'China', 'Chine', 31.2304, 121.4737],
  ['Seoul', 'Séoul', 'South Korea', 'Corée du Sud', 37.5665, 126.978],
  ['Tokyo', 'Tokyo', 'Japan', 'Japon', 35.6762, 139.6503],
  ['Sydney', 'Sydney', 'Australia', 'Australie', -33.8688, 151.2093],
  ['Melbourne', 'Melbourne', 'Australia', 'Australie', -37.8136, 144.9631],
  ['Auckland', 'Auckland', 'New Zealand', 'Nouvelle-Zélande', -36.8485, 174.7633],
  ['Nouméa', 'Nouméa', 'New Caledonia', 'Nouvelle-Calédonie', -22.2758, 166.458],
  ['Papeete', 'Papeete', 'French Polynesia', 'Polynésie française', -17.5516, -149.5585],
  ['Honolulu', 'Honolulu', 'United States', 'États-Unis', 21.3069, -157.8583],
  ['Los Angeles', 'Los Angeles', 'United States', 'États-Unis', 34.0522, -118.2437],
  ['San Francisco', 'San Francisco', 'United States', 'États-Unis', 37.7749, -122.4194],
  ['Seattle', 'Seattle', 'United States', 'États-Unis', 47.6062, -122.3321],
  ['Denver', 'Denver', 'United States', 'États-Unis', 39.7392, -104.9903],
  ['Chicago', 'Chicago', 'United States', 'États-Unis', 41.8781, -87.6298],
  ['New York', 'New York', 'United States', 'États-Unis', 40.7128, -74.006],
  ['Miami', 'Miami', 'United States', 'États-Unis', 25.7617, -80.1918],
  ['Mexico City', 'Mexico', 'Mexico', 'Mexique', 19.4326, -99.1332],
  ['Bogotá', 'Bogota', 'Colombia', 'Colombie', 4.711, -74.0721],
  ['Lima', 'Lima', 'Peru', 'Pérou', -12.0464, -77.0428],
  ['Santiago', 'Santiago', 'Chile', 'Chili', -33.4489, -70.6693],
  ['Buenos Aires', 'Buenos Aires', 'Argentina', 'Argentine', -34.6037, -58.3816],
  ['São Paulo', 'São Paulo', 'Brazil', 'Brésil', -23.5505, -46.6333],
  ['Rio de Janeiro', 'Rio de Janeiro', 'Brazil', 'Brésil', -22.9068, -43.1729],
  ['Fort-de-France', 'Fort-de-France', 'Martinique', 'Martinique', 14.6161, -61.0588],
  ['Pointe-à-Pitre', 'Pointe-à-Pitre', 'Guadeloupe', 'Guadeloupe', 16.2411, -61.5331],
  ['Saint-Denis', 'Saint-Denis', 'Réunion', 'La Réunion', -20.8789, 55.4481],
  ['Cayenne', 'Cayenne', 'French Guiana', 'Guyane', 4.9224, -52.3135],
];

const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’'`-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Offline city search: prefix matches first, then substring matches (name or country). */
export function searchCities(query, lang = 'en', limit = 8) {
  const q = norm(query);
  if (q.length < 2) return [];
  const fr = lang === 'fr';
  const scored = [];
  for (const c of CITIES) {
    const names = [norm(c[0]), norm(c[1])];
    const country = norm(fr ? c[3] : c[2]);
    let score = 0;
    if (names.some((n) => n === q)) score = 4;
    else if (names.some((n) => n.startsWith(q))) score = 3;
    else if (names.some((n) => n.includes(q))) score = 2;
    else if (country.startsWith(q)) score = 1;
    if (score) scored.push({ score, c });
  }
  scored.sort((a, b) => b.score - a.score || a.c[0].localeCompare(b.c[0]));
  return scored.slice(0, limit).map(({ c }) => ({ name: fr ? c[1] : c[0], country: fr ? c[3] : c[2], lat: c[4], lon: c[5] }));
}

/** Same town in two result lists (online geocoding vs the built-in list): same name and close coordinates. */
export function samePlace(a, b) {
  if (!a || !b || norm(a.name) !== norm(b.name)) return false;
  return Math.abs(Number(a.lat) - Number(b.lat)) < 0.25 && Math.abs(Number(a.lon) - Number(b.lon)) < 0.25;
}
