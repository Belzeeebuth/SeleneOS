// Words and icons for the conditions of main/ipc/weather.js ('weather:current'), shared by the shell surfaces that show
// the weather (widgets board; the taskbar and Settings keep their own copies of the strings for now).
// Pure data + helpers, no DOM.
//   weatherDescribe(conditions, lang)  -> 'Partly cloudy' / 'Partiellement nuageux' (from conditions.describe)
//   weatherIconName(conditions)        -> Fluent icon name (renderer/assets/icons/fluent.json), day / night aware
//   formatTemperature(conditions, fmt) -> '12 °C' ('' when unknown); fmt = i18n.formatNumber (optional)
export const WEATHER_TEXT = {
  en: {
    clear: 'Clear sky',
    mainlyClear: 'Mostly clear',
    partlyCloudy: 'Partly cloudy',
    overcast: 'Overcast',
    fog: 'Fog',
    drizzle: 'Drizzle',
    freezingDrizzle: 'Freezing drizzle',
    rain: 'Rain',
    freezingRain: 'Freezing rain',
    snow: 'Snow',
    snowGrains: 'Snow grains',
    showers: 'Rain showers',
    snowShowers: 'Snow showers',
    thunderstorm: 'Thunderstorm',
    hail: 'Thunderstorm with hail',
  },
  fr: {
    clear: 'Ciel dégagé',
    mainlyClear: 'Plutôt dégagé',
    partlyCloudy: 'Partiellement nuageux',
    overcast: 'Couvert',
    fog: 'Brouillard',
    drizzle: 'Bruine',
    freezingDrizzle: 'Bruine verglaçante',
    rain: 'Pluie',
    freezingRain: 'Pluie verglaçante',
    snow: 'Neige',
    snowGrains: 'Neige en grains',
    showers: 'Averses',
    snowShowers: 'Averses de neige',
    thunderstorm: 'Orage',
    hail: 'Orage avec grêle',
  },
};

export function weatherDescribe(w, lang = 'en') {
  const dict = WEATHER_TEXT[lang === 'fr' ? 'fr' : 'en'];
  return dict[w?.describe] || dict[w?.kind] || dict.clear;
}

export function weatherIconName(w) {
  const night = w?.isDay === false;
  switch (w?.describe) {
    case 'clear':
    case 'mainlyClear':
      return night ? 'weather_moon' : 'weather_sunny';
    case 'partlyCloudy':
      return night ? 'weather_partly_cloudy_night' : 'weather_partly_cloudy_day';
    case 'overcast':
      return 'weather_cloudy';
    case 'fog':
      return 'weather_fog';
    case 'drizzle':
    case 'freezingDrizzle':
      return 'weather_drizzle';
    case 'showers':
      return night ? 'weather_rain_showers_night' : 'weather_rain_showers_day';
    case 'snowShowers':
      return night ? 'weather_snow_shower_night' : 'weather_snow_shower_day';
    case 'snow':
    case 'snowGrains':
      return 'weather_snow';
    case 'hail':
      return night ? 'weather_hail_night' : 'weather_hail_day';
    case 'thunderstorm':
      return 'weather_thunderstorm';
    case 'rain':
    case 'freezingRain':
      return 'weather_rain';
    default:
      return { clouds: 'weather_cloudy', fog: 'weather_fog', rain: 'weather_rain', snow: 'weather_snow', storm: 'weather_thunderstorm' }[w?.kind] || (night ? 'weather_moon' : 'weather_sunny');
  }
}

export function formatTemperature(w, fmt) {
  const v = Number(w?.temperature);
  if (w?.temperature == null || !Number.isFinite(v)) return '';
  const n = Math.round(v);
  return `${fmt ? fmt(n === 0 ? 0 : n) : String(n === 0 ? 0 : n)} ${w.unit || '°C'}`;
}
