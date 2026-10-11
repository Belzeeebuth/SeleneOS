// Clock — bundled city list (data/cities.json: ~430 cities with IANA zones, English + French names)
// and search. Country names come from Intl.DisplayNames so they follow the UI language.
let data = null;
let loading = null;
const regionNames = new Map();

export async function loadCities(appUrl) {
  if (data) return data;
  if (!loading) {
    loading = fetch(appUrl('data/cities.json'))
      .then((r) => {
        if (!r.ok) throw new Error(`cities.json: HTTP ${r.status}`);
        return r.json();
      })
      .then((j) => {
        data = (j.cities || []).map(([id, en, fr, cc, lat, lon, tz, region, regionFr]) => ({ id, en, fr: fr || en, cc, lat, lon, tz, region: region || null, regionFr: regionFr || region || null }));
        return data;
      })
      .catch((err) => {
        loading = null;
        throw err;
      });
  }
  return loading;
}

export function cityById(id) {
  return data?.find((c) => c.id === id) || null;
}

export function allCities() {
  return data || [];
}

function countryName(cc, lang) {
  const key = `${lang}:${cc}`;
  if (regionNames.has(key)) return regionNames.get(key);
  let name = cc;
  try {
    name = new Intl.DisplayNames([lang === 'fr' ? 'fr-FR' : 'en-US'], { type: 'region' }).of(cc) || cc;
  } catch {}
  regionNames.set(key, name);
  return name;
}

export function cityName(c, lang) {
  return lang === 'fr' ? c.fr : c.en;
}

/** "Seattle, Washington, United States" / "Paris, France" */
export function cityPlace(c, lang) {
  const parts = [];
  const region = lang === 'fr' ? c.regionFr : c.region;
  if (region && region !== cityName(c, lang)) parts.push(region);
  parts.push(countryName(c.cc, lang));
  return parts.join(', ');
}

export function cityCountry(c, lang) {
  return countryName(c.cc, lang);
}

export const fold = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’'`.-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Ranked search over names (both languages), country, region and the zone id. */
export function searchCities(query, lang, limit = 40) {
  const q = fold(query);
  if (!q || !data) return [];
  const scored = [];
  for (const c of data) {
    const own = fold(cityName(c, lang));
    const other = fold(lang === 'fr' ? c.en : c.fr);
    const country = fold(countryName(c.cc, lang));
    const region = fold(lang === 'fr' ? c.regionFr : c.region);
    const zone = fold(c.tz.replace(/_/g, ' ').split('/').pop());
    let s = 0;
    if (own === q) s = 100;
    else if (own.startsWith(q)) s = 80;
    else if (other.startsWith(q)) s = 70;
    else if (own.split(' ').some((w) => w.startsWith(q))) s = 60;
    else if (country.startsWith(q) || country.split(' ').some((w) => w.startsWith(q))) s = 40;
    else if (region && region.startsWith(q)) s = 35;
    else if (zone.startsWith(q)) s = 30;
    else if (own.includes(q) || other.includes(q)) s = 20;
    if (s) scored.push([s, c]);
  }
  scored.sort((a, b) => b[0] - a[0] || cityName(a[1], lang).localeCompare(cityName(b[1], lang), lang));
  return scored.slice(0, limit).map((x) => x[1]);
}

/** Best city for the system time zone (Europe/Paris -> Paris), or a synthetic one. */
export function localCity(tz) {
  const list = data || [];
  const tail = fold(tz.split('/').pop().replace(/_/g, ' '));
  const same = list.filter((c) => c.tz === tz);
  const exact = same.find((c) => fold(c.en) === tail) || same.find((c) => fold(c.en).startsWith(tail)) || same.find((c) => fold(c.fr) === tail) || same[0];
  if (exact) return exact;
  const name = tz.split('/').pop().replace(/_/g, ' ');
  return { id: `tz:${tz}`, en: name, fr: name, cc: '', lat: null, lon: null, tz, region: null, regionFr: null, synthetic: true };
}
