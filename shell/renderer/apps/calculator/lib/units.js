// Unit converter data. Factors are exact decimal strings (or fractions) relative to each category's
// base unit, so conversions run on exact rationals (1 mi = 1609.344 m exactly, 1 in = 2.54 cm …).
import { Num, PI } from './num.js';

// [id, factor, symbol, en, fr]
const L = (id, f, sym, en, fr) => ({ id, f, sym, name: { en, fr } });

export const CATEGORIES = [
  {
    id: 'volume',
    icon: 'cube',
    defaults: ['l', 'galus'],
    units: [
      L('ml', '1', 'mL', 'Milliliters', 'Millilitres'),
      L('cc', '1', 'cm³', 'Cubic centimeters', 'Centimètres cubes'),
      L('l', '1000', 'L', 'Liters', 'Litres'),
      L('m3', '1000000', 'm³', 'Cubic meters', 'Mètres cubes'),
      L('tspus', '4.92892159375', 'tsp', 'Teaspoons (US)', 'Cuillères à café (US)'),
      L('tbspus', '14.78676478125', 'tbsp', 'Tablespoons (US)', 'Cuillères à soupe (US)'),
      L('flozus', '29.5735295625', 'fl oz', 'Fluid ounces (US)', 'Onces liquides (US)'),
      L('cupus', '236.5882365', 'cup', 'Cups (US)', 'Tasses (US)'),
      L('ptus', '473.176473', 'pt', 'Pints (US)', 'Pintes (US)'),
      L('qtus', '946.352946', 'qt', 'Quarts (US)', 'Quarts (US)'),
      L('galus', '3785.411784', 'gal', 'Gallons (US)', 'Gallons (US)'),
      L('in3', '16.387064', 'in³', 'Cubic inches', 'Pouces cubes'),
      L('ft3', '28316.846592', 'ft³', 'Cubic feet', 'Pieds cubes'),
      L('yd3', '764554.857984', 'yd³', 'Cubic yards', 'Yards cubes'),
      L('tspuk', '17.7581640625/3', 'tsp', 'Teaspoons (UK)', 'Cuillères à café (UK)'),
      L('tbspuk', '17.7581640625', 'tbsp', 'Tablespoons (UK)', 'Cuillères à soupe (UK)'),
      L('flozuk', '28.4130625', 'fl oz', 'Fluid ounces (UK)', 'Onces liquides (UK)'),
      L('ptuk', '568.26125', 'pt', 'Pints (UK)', 'Pintes (UK)'),
      L('qtuk', '1136.5225', 'qt', 'Quarts (UK)', 'Quarts (UK)'),
      L('galuk', '4546.09', 'gal', 'Gallons (UK)', 'Gallons (UK)'),
    ],
  },
  {
    id: 'length',
    icon: 'ruler',
    defaults: ['cm', 'in'],
    units: [
      L('nm', '0.000000001', 'nm', 'Nanometers', 'Nanomètres'),
      L('um', '0.000001', 'µm', 'Microns', 'Microns'),
      L('mm', '0.001', 'mm', 'Millimeters', 'Millimètres'),
      L('cm', '0.01', 'cm', 'Centimeters', 'Centimètres'),
      L('m', '1', 'm', 'Meters', 'Mètres'),
      L('km', '1000', 'km', 'Kilometers', 'Kilomètres'),
      L('in', '0.0254', 'in', 'Inches', 'Pouces'),
      L('ft', '0.3048', 'ft', 'Feet', 'Pieds'),
      L('yd', '0.9144', 'yd', 'Yards', 'Yards'),
      L('mi', '1609.344', 'mi', 'Miles', 'Miles'),
      L('nmi', '1852', 'nmi', 'Nautical miles', 'Milles marins'),
    ],
  },
  {
    id: 'weight',
    icon: 'scales',
    defaults: ['kg', 'lb'],
    units: [
      L('ct', '0.0002', 'ct', 'Carats', 'Carats'),
      L('mg', '0.000001', 'mg', 'Milligrams', 'Milligrammes'),
      L('cg', '0.00001', 'cg', 'Centigrams', 'Centigrammes'),
      L('dg', '0.0001', 'dg', 'Decigrams', 'Décigrammes'),
      L('g', '0.001', 'g', 'Grams', 'Grammes'),
      L('dag', '0.01', 'dag', 'Dekagrams', 'Décagrammes'),
      L('hg', '0.1', 'hg', 'Hectograms', 'Hectogrammes'),
      L('kg', '1', 'kg', 'Kilograms', 'Kilogrammes'),
      L('t', '1000', 't', 'Metric tonnes', 'Tonnes métriques'),
      L('oz', '0.028349523125', 'oz', 'Ounces', 'Onces'),
      L('lb', '0.45359237', 'lb', 'Pounds', 'Livres'),
      L('st', '6.35029318', 'st', 'Stone', 'Stones'),
      L('tonus', '907.18474', 'ton', 'Short tons (US)', 'Tonnes courtes (US)'),
      L('tonuk', '1016.0469088', 'ton', 'Long tons (UK)', 'Tonnes longues (UK)'),
    ],
  },
  {
    id: 'temperature',
    icon: 'temperature',
    defaults: ['c', 'f'],
    signed: true,
    units: [
      // temperature uses affine conversions (see convert())
      L('c', null, '°C', 'Celsius', 'Celsius'),
      L('f', null, '°F', 'Fahrenheit', 'Fahrenheit'),
      L('k', null, 'K', 'Kelvin', 'Kelvin'),
    ],
  },
  {
    id: 'energy',
    icon: 'flash',
    defaults: ['kj', 'kcal'],
    units: [
      L('ev', '0.0000000000000000001602176634', 'eV', 'Electron volts', 'Électronvolts'),
      L('j', '1', 'J', 'Joules', 'Joules'),
      L('kj', '1000', 'kJ', 'Kilojoules', 'Kilojoules'),
      L('cal', '4.184', 'cal', 'Thermal calories', 'Calories thermiques'),
      L('kcal', '4184', 'kcal', 'Food calories', 'Calories alimentaires'),
      L('ftlb', '1.3558179483314004', 'ft·lb', 'Foot-pounds', 'Pieds-livres'),
      L('btu', '1055.05585262', 'BTU', 'British thermal units', 'Unités thermiques britanniques'),
      L('kwh', '3600000', 'kWh', 'Kilowatt-hours', 'Kilowattheures'),
    ],
  },
  {
    id: 'area',
    icon: 'resize',
    defaults: ['m2', 'ft2'],
    units: [
      L('mm2', '0.000001', 'mm²', 'Square millimeters', 'Millimètres carrés'),
      L('cm2', '0.0001', 'cm²', 'Square centimeters', 'Centimètres carrés'),
      L('m2', '1', 'm²', 'Square meters', 'Mètres carrés'),
      L('ha', '10000', 'ha', 'Hectares', 'Hectares'),
      L('km2', '1000000', 'km²', 'Square kilometers', 'Kilomètres carrés'),
      L('in2', '0.00064516', 'in²', 'Square inches', 'Pouces carrés'),
      L('ft2', '0.09290304', 'ft²', 'Square feet', 'Pieds carrés'),
      L('yd2', '0.83612736', 'yd²', 'Square yards', 'Yards carrés'),
      L('ac', '4046.8564224', 'ac', 'Acres', 'Acres'),
      L('mi2', '2589988.110336', 'mi²', 'Square miles', 'Miles carrés'),
    ],
  },
  {
    id: 'speed',
    icon: 'top_speed',
    defaults: ['kmh', 'mph'],
    units: [
      L('cms', '0.01', 'cm/s', 'Centimeters per second', 'Centimètres par seconde'),
      L('ms', '1', 'm/s', 'Meters per second', 'Mètres par seconde'),
      L('kmh', '5/18', 'km/h', 'Kilometers per hour', 'Kilomètres par heure'),
      L('fts', '0.3048', 'ft/s', 'Feet per second', 'Pieds par seconde'),
      L('mph', '0.44704', 'mph', 'Miles per hour', 'Miles par heure'),
      L('kn', '463/900', 'kn', 'Knots', 'Nœuds'),
      L('mach', '340.3', 'Mach', 'Mach', 'Mach'),
    ],
  },
  {
    id: 'time',
    icon: 'clock',
    defaults: ['h', 'min'],
    units: [
      L('us', '0.000001', 'µs', 'Microseconds', 'Microsecondes'),
      L('msec', '0.001', 'ms', 'Milliseconds', 'Millisecondes'),
      L('s', '1', 's', 'Seconds', 'Secondes'),
      L('min', '60', 'min', 'Minutes', 'Minutes'),
      L('h', '3600', 'h', 'Hours', 'Heures'),
      L('d', '86400', 'd', 'Days', 'Jours'),
      L('wk', '604800', 'wk', 'Weeks', 'Semaines'),
      L('yr', '31536000', 'yr', 'Years', 'Années'),
    ],
  },
  {
    id: 'power',
    icon: 'plug_connected',
    defaults: ['kw', 'hp'],
    units: [
      L('w', '1', 'W', 'Watts', 'Watts'),
      L('kw', '1000', 'kW', 'Kilowatts', 'Kilowatts'),
      L('hp', '745.69987158227022', 'hp', 'Horsepower (US)', 'Chevaux-vapeur (US)'),
      L('ftlbmin', '0.0225969658055233', 'ft·lb/min', 'Foot-pounds/minute', 'Pieds-livres/minute'),
      L('btumin', '17.58426421', 'BTU/min', 'BTUs/minute', 'BTU/minute'),
    ],
  },
  {
    id: 'data',
    icon: 'storage',
    defaults: ['gb', 'mb'],
    units: [
      L('bit', '1', 'b', 'Bits', 'Bits'),
      L('nibble', '4', 'nibble', 'Nibble', 'Quartets'),
      L('byte', '8', 'B', 'Bytes', 'Octets'),
      L('kbit', '1000', 'Kb', 'Kilobits', 'Kilobits'),
      L('kibit', '1024', 'Kib', 'Kibibits', 'Kibibits'),
      L('kb', '8000', 'KB', 'Kilobytes', 'Kilooctets'),
      L('kib', '8192', 'KiB', 'Kibibytes', 'Kibioctets'),
      L('mbit', '1000000', 'Mb', 'Megabits', 'Mégabits'),
      L('mibit', '1048576', 'Mib', 'Mebibits', 'Mébibits'),
      L('mb', '8000000', 'MB', 'Megabytes', 'Mégaoctets'),
      L('mib', '8388608', 'MiB', 'Mebibytes', 'Mébioctets'),
      L('gbit', '1000000000', 'Gb', 'Gigabits', 'Gigabits'),
      L('gibit', '1073741824', 'Gib', 'Gibibits', 'Gibibits'),
      L('gb', '8000000000', 'GB', 'Gigabytes', 'Gigaoctets'),
      L('gib', '8589934592', 'GiB', 'Gibibytes', 'Gibioctets'),
      L('tbit', '1000000000000', 'Tb', 'Terabits', 'Térabits'),
      L('tibit', '1099511627776', 'Tib', 'Tebibits', 'Tébibits'),
      L('tb', '8000000000000', 'TB', 'Terabytes', 'Téraoctets'),
      L('tib', '8796093022208', 'TiB', 'Tebibytes', 'Tébioctets'),
      L('pbit', '1000000000000000', 'Pb', 'Petabits', 'Pétabits'),
      L('pibit', '1125899906842624', 'Pib', 'Pebibits', 'Pébibits'),
      L('pb', '8000000000000000', 'PB', 'Petabytes', 'Pétaoctets'),
      L('pib', '9007199254740992', 'PiB', 'Pebibytes', 'Pébioctets'),
    ],
  },
  {
    id: 'pressure',
    icon: 'gauge',
    defaults: ['atm', 'bar'],
    units: [
      L('atm', '101325', 'atm', 'Atmospheres', 'Atmosphères'),
      L('bar', '100000', 'bar', 'Bars', 'Bars'),
      L('kpa', '1000', 'kPa', 'Kilopascals', 'Kilopascals'),
      L('mmhg', '133.322387415', 'mmHg', 'Millimeters of mercury', 'Millimètres de mercure'),
      L('pa', '1', 'Pa', 'Pascals', 'Pascals'),
      L('psi', '6894.757293168361', 'psi', 'Pounds per square inch', 'Livres par pouce carré'),
    ],
  },
  {
    id: 'angle',
    icon: 'triangle',
    defaults: ['deg', 'rad'],
    signed: true,
    units: [
      L('deg', '1', '°', 'Degrees', 'Degrés'),
      L('rad', 'PI', 'rad', 'Radians', 'Radians'),
      L('grad', '0.9', 'grad', 'Gradians', 'Grades'),
    ],
  },
];

const factorCache = new Map();
function factor(u) {
  let f = factorCache.get(u);
  if (!f) {
    f = u.f === 'PI' ? Num.of(180).div(PI) : Num.parse(u.f);
    factorCache.set(u, f);
  }
  return f;
}

export function category(id) {
  return CATEGORIES.find((c) => c.id === id) || CATEGORIES[1];
}

export function unit(cat, id) {
  return cat.units.find((u) => u.id === id) || cat.units[0];
}

const F_SCALE = Num.frac(5, 9);
const C_K = Num.parse('273.15');

function toCelsius(id, v) {
  if (id === 'f') return v.sub(32).mul(F_SCALE);
  if (id === 'k') return v.sub(C_K);
  return v;
}
function fromCelsius(id, c) {
  if (id === 'f') return c.div(F_SCALE).add(32);
  if (id === 'k') return c.add(C_K);
  return c;
}

/** Convert a Num value between two unit ids of a category. */
export function convert(catId, fromId, toId, value) {
  const cat = category(catId);
  const from = unit(cat, fromId);
  const to = unit(cat, toId);
  if (from === to) return value;
  if (cat.id === 'temperature') return fromCelsius(to.id, toCelsius(from.id, value));
  return value.mul(factor(from)).div(factor(to));
}
