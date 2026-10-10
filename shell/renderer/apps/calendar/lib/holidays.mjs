// Public holidays, generated algorithmically for any year. Pure module (shell + Node).
//   easter(year) -> { y, m, d }  (Gregorian computus, Meeus/Jones/Butcher)
//   holidays('FR' | 'US', year) -> [{ id, date: 'YYYY-MM-DD', name: { en, fr }, kind: 'public'|'observance'|'observed' }]
//   holidaysInRange(country, fromKey, toKey)   (inclusive date keys)
import { dayNum, fromDayNum, dateKey, nthWeekday, weekdayOf } from './dates.mjs';

export const COUNTRIES = ['FR', 'US'];

export function easter(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); // 3 = March, 4 = April
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { y: year, m: month - 1, d: day };
}

const fixed = (y, m, d) => dayNum(y, m, d);

function fr(year) {
  const e = easter(year);
  const ed = dayNum(e.y, e.m, e.d);
  return [
    ['newYear', fixed(year, 0, 1), { en: 'New Year’s Day', fr: 'Jour de l’an' }],
    ['easter', ed, { en: 'Easter Sunday', fr: 'Pâques' }],
    ['easterMonday', ed + 1, { en: 'Easter Monday', fr: 'Lundi de Pâques' }],
    ['labourDay', fixed(year, 4, 1), { en: 'Labour Day', fr: 'Fête du Travail' }],
    ['victoryDay', fixed(year, 4, 8), { en: 'Victory in Europe Day', fr: 'Victoire 1945' }],
    ['ascension', ed + 39, { en: 'Ascension Day', fr: 'Ascension' }],
    ['pentecost', ed + 49, { en: 'Whit Sunday', fr: 'Pentecôte' }],
    ['whitMonday', ed + 50, { en: 'Whit Monday', fr: 'Lundi de Pentecôte' }],
    ['bastilleDay', fixed(year, 6, 14), { en: 'Bastille Day', fr: 'Fête nationale' }],
    ['assumption', fixed(year, 7, 15), { en: 'Assumption Day', fr: 'Assomption' }],
    ['allSaints', fixed(year, 10, 1), { en: 'All Saints’ Day', fr: 'Toussaint' }],
    ['armistice', fixed(year, 10, 11), { en: 'Armistice Day', fr: 'Armistice 1918' }],
    ['christmas', fixed(year, 11, 25), { en: 'Christmas Day', fr: 'Noël' }],
  ].map(([id, n, name]) => ({ id, n, name, kind: id === 'easter' || id === 'pentecost' ? 'observance' : 'public' }));
}

// US federal holidays falling on a weekend are observed on the Friday before / Monday after.
function observedDay(n) {
  const wd = weekdayOf(n);
  if (wd === 6) return n - 1;
  if (wd === 0) return n + 1;
  return null;
}

function us(year) {
  const nth = (m, wd, k) => dayNum(year, m, nthWeekday(year, m, wd, k));
  const e = easter(year);
  const list = [
    ['newYear', fixed(year, 0, 1), { en: 'New Year’s Day', fr: 'Jour de l’an' }, 'public'],
    ['mlkDay', nth(0, 1, 3), { en: 'Martin Luther King Jr. Day', fr: 'Journée de Martin Luther King' }, 'public'],
    ['valentines', fixed(year, 1, 14), { en: 'Valentine’s Day', fr: 'Saint-Valentin' }, 'observance'],
    ['presidentsDay', nth(1, 1, 3), { en: 'Presidents’ Day', fr: 'Jour des présidents' }, 'public'],
    ['easter', dayNum(e.y, e.m, e.d), { en: 'Easter Sunday', fr: 'Pâques' }, 'observance'],
    ['mothersDay', nth(4, 0, 2), { en: 'Mother’s Day', fr: 'Fête des mères' }, 'observance'],
    ['memorialDay', nth(4, 1, -1), { en: 'Memorial Day', fr: 'Memorial Day (jour du Souvenir)' }, 'public'],
    ['fathersDay', nth(5, 0, 3), { en: 'Father’s Day', fr: 'Fête des pères' }, 'observance'],
    ['juneteenth', fixed(year, 5, 19), { en: 'Juneteenth', fr: 'Juneteenth (fin de l’esclavage)' }, 'public'],
    ['independenceDay', fixed(year, 6, 4), { en: 'Independence Day', fr: 'Jour de l’Indépendance' }, 'public'],
    ['laborDay', nth(8, 1, 1), { en: 'Labor Day', fr: 'Fête du Travail' }, 'public'],
    ['columbusDay', nth(9, 1, 2), { en: 'Columbus Day', fr: 'Jour de Christophe Colomb' }, 'public'],
    ['halloween', fixed(year, 9, 31), { en: 'Halloween', fr: 'Halloween' }, 'observance'],
    ['veteransDay', fixed(year, 10, 11), { en: 'Veterans Day', fr: 'Jour des anciens combattants' }, 'public'],
    ['thanksgiving', nth(10, 4, 4), { en: 'Thanksgiving Day', fr: 'Thanksgiving (Action de grâce)' }, 'public'],
    ['christmasEve', fixed(year, 11, 24), { en: 'Christmas Eve', fr: 'Réveillon de Noël' }, 'observance'],
    ['christmas', fixed(year, 11, 25), { en: 'Christmas Day', fr: 'Noël' }, 'public'],
    ['newYearsEve', fixed(year, 11, 31), { en: 'New Year’s Eve', fr: 'Saint-Sylvestre' }, 'observance'],
  ].map(([id, n, name, kind]) => ({ id, n, name, kind }));
  const out = [...list];
  for (const id of ['newYear', 'juneteenth', 'independenceDay', 'veteransDay', 'christmas']) {
    const h = list.find((x) => x.id === id);
    const o = observedDay(h.n);
    // New Year's Day on a Saturday is observed on Dec 31 of the previous year (handled below).
    if (o != null && !(id === 'newYear' && o < h.n)) out.push({ id: `${id}Observed`, n: o, name: { en: `${h.name.en} (observed)`, fr: `${h.name.fr} (jour férié reporté)` }, kind: 'observed' });
  }
  const nextNewYear = fixed(year + 1, 0, 1);
  if (weekdayOf(nextNewYear) === 6) {
    out.push({ id: 'newYearObserved', n: nextNewYear - 1, name: { en: 'New Year’s Day (observed)', fr: 'Jour de l’an (jour férié reporté)' }, kind: 'observed' });
  }
  return out;
}

const cache = new Map();

export function holidays(country, year) {
  const k = `${country}:${year}`;
  if (cache.has(k)) return cache.get(k);
  const raw = country === 'FR' ? fr(year) : country === 'US' ? us(year) : [];
  const list = raw
    .map((h) => ({ id: h.id, date: dateKey(fromDayNum(h.n)), name: h.name, kind: h.kind }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  cache.set(k, list);
  if (cache.size > 64) cache.delete(cache.keys().next().value);
  return list;
}

export function holidaysInRange(country, fromKey, toKey) {
  const y0 = Number(fromKey.slice(0, 4));
  const y1 = Number(toKey.slice(0, 4));
  const out = [];
  for (let y = y0; y <= y1; y++) for (const h of holidays(country, y)) if (h.date >= fromKey && h.date <= toKey) out.push(h);
  return out;
}
