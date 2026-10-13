// Unit tests of the print dialog's pure helpers (renderer/core/print-ranges.js) and the main-side range check
// (main/ipc/print.js normalizeRanges).   node test/print.unit.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { parseRanges, defaultPaper, normalizePrinters, sidesFor } from '../renderer/core/print-ranges.js';

const require = createRequire(import.meta.url);
let passed = 0;
const t = (name, fn) => {
  try {
    fn();
    passed++;
  } catch (err) {
    console.error(`✗ ${name}\n${err.stack || err}`);
    process.exitCode = 1;
  }
};

t('ranges: list and single pages', () => {
  assert.deepEqual(parseRanges('1-3, 5', 12), { ok: true, ranges: [[1, 3], [5, 5]], text: '1-3,5', count: 4, first: 1 });
  assert.equal(parseRanges(' 2 ', 3).text, '2');
  assert.equal(parseRanges('4;6', 9).text, '4,6');
  assert.equal(parseRanges('1 – 2', 3).text, '1-2'); // en dash typed by a French keyboard
});
t('ranges: open end needs the page count', () => {
  assert.equal(parseRanges('3-', 7).text, '3-7');
  assert.equal(parseRanges('3-', 0).ok, false);
});
t('ranges: errors', () => {
  assert.equal(parseRanges('', 4).error, 'empty');
  assert.equal(parseRanges('   ', 4).error, 'empty');
  assert.equal(parseRanges('a-b', 4).error, 'syntax');
  assert.equal(parseRanges('1--2', 4).error, 'syntax');
  assert.equal(parseRanges('$(rm -rf /)', 4).error, 'syntax');
  assert.equal(parseRanges('4-2', 9).error, 'order');
  assert.equal(parseRanges('0', 9).error, 'zero');
  assert.deepEqual(parseRanges('2-9', 4), { ok: false, error: 'past', page: 9 });
  assert.equal(parseRanges('2-9', 0).ok, true); // page count unknown: accepted
});
t('paper per language', () => {
  assert.equal(defaultPaper('fr'), 'A4');
  assert.equal(defaultPaper('en'), 'Letter');
  assert.equal(defaultPaper('de'), 'A4');
});
t('printers list shapes', () => {
  assert.deepEqual(normalizePrinters(null), []);
  assert.deepEqual(normalizePrinters({ printers: [{ name: 'HP', info: 'HP LaserJet', isDefault: true }] }), [
    { name: 'HP', label: 'HP LaserJet', isDefault: true, state: 'idle', location: '' },
  ]);
  assert.deepEqual(
    normalizePrinters(['Office', { id: 'Canon', description: 'Canon', default: false, state: 'stopped', location: 'Salon' }, {}, null]).map((p) => [p.name, p.label, p.state, p.location]),
    [
      ['Office', 'Office', 'idle', ''],
      ['Canon', 'Canon', 'stopped', 'Salon'],
    ],
  );
});
t('sides', () => {
  assert.equal(sidesFor(false, false), 'one-sided');
  assert.equal(sidesFor(true, false), 'two-sided-long-edge');
  assert.equal(sidesFor(true, true), 'two-sided-short-edge');
});
t('main: normalizeRanges', () => {
  const { normalizeRanges } = require('../main/ipc/print.js');
  assert.equal(normalizeRanges(''), '');
  assert.equal(normalizeRanges('1-3, 5'), '1-3,5');
  assert.equal(normalizeRanges('2 - 4'), '2-4');
  for (const bad of ['0', '3-1', '1,,x', '-2', '1-2-3', '1; rm', 'a'.repeat(300), 5]) assert.throws(() => normalizeRanges(bad), undefined, String(bad));
});

console.log(`print.unit: ${passed} passed${process.exitCode ? ', FAILURES above' : ''}`);
