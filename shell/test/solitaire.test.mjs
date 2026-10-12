// Solitaire tests.
//   1. Pure rules (node): deals, legal moves, draw 3, recycling, scoring, undo, hints, auto-complete, stats.
//   2. UI (Playwright + the real Electron shell): drag & drop (legal / illegal + snap back), click and
//      double-click to the foundations, undo, stock, keyboard play, click-to-select mode, hint,
//      auto-complete + win cascade + win dialog, statistics, layouts (min size, 1280x720, 1920x1080),
//      dark + French, and no renderer errors.
// Usage (from aurora-os/shell):
//   xvfb-run -a -s "-screen 0 1920x1080x24" node test/solitaire.test.mjs           # everything
//   node test/solitaire.test.mjs --unit                                              # rules only
// Screenshots: test/out/solitaire-*.png, copied to docs/screenshots/.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  Klondike,
  dealState,
  stateFrom,
  shuffledDeck,
  parseCode,
  codeOf,
  rankOf,
  suitOf,
  recordResult,
  emptyStats,
  validateState,
  normalizeState,
  sanitizeStats,
} from '../renderer/apps/solitaire/rules.mjs';
import { faceSvg, backSvg, BACKS } from '../renderer/apps/solitaire/cards.mjs';

const args = process.argv.slice(2);
const UNIT_ONLY = args.includes('--unit');
const UI_ONLY = args.includes('--ui');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}\n${String(err?.stack || err).replace(/^/gm, '        ')}`);
  }
}
const C = (codes) => codes.map(parseCode);

// A nearly finished game: everything is on the foundations except five face-up cards.
const NEAR_WIN = {
  f: [
    ['AS', '2S', '3S', '4S', '5S', '6S', '7S', '8S', '9S', '10S', 'JS'],
    ['AH', '2H', '3H', '4H', '5H', '6H', '7H', '8H', '9H', '10H', 'JH', 'QH'],
    ['AD', '2D', '3D', '4D', '5D', '6D', '7D', '8D', '9D', '10D', 'JD', 'QD', 'KD'],
    ['AC', '2C', '3C', '4C', '5C', '6C', '7C', '8C', '9C', '10C', 'JC'],
  ],
  t: [['KH', 'QS'], ['KC'], ['KS'], [], [], [], []],
  waste: ['QC'],
  stock: [],
};

const ALL = Array.from({ length: 52 }, (_, c) => codeOf(c));
// Seven face-up cards that cannot go anywhere, Aces buried, empty stock, 7♥ on the waste.
function deadEndDesc(scoring) {
  const tops = ['5D', '5H', '9S', '9C', 'QD', 'QH', '3S'];
  const aces = ['AS', 'AH', 'AD', 'AC'];
  const used = new Set([...tops, ...aces, '7H']);
  const rest = ALL.filter((c) => !used.has(c));
  return { scoring, t: tops.map((top, i) => (i < 4 ? [aces[i], top] : [top])), hidden: [1, 1, 1, 1, 0, 0, 0], stock: [], waste: [...rest, '7H'] };
}
const deadEnd = (scoring) => new Klondike(stateFrom(deadEndDesc(scoring)));

// Stuck unless 5♣ comes back down from its foundation onto 6♥, where the waste's 4♦ can then go.
function foundationDownDesc() {
  const t = [['6H'], ['AS', '9D'], ['AH', '9H'], ['AD', 'QD'], ['5S', 'QH'], ['6C', '3S'], ['7S', '8D']];
  const f = [[], [], [], ['AC', '2C', '3C', '4C', '5C']];
  const used = new Set([...t.flat(), ...f.flat(), '4D']);
  return { scoring: 'vegas', t, hidden: [0, 1, 1, 1, 1, 1, 1], f, stock: [], waste: [...ALL.filter((c) => !used.has(c)), '4D'] };
}

// ---------------------------------------------------------------- 1. rules
async function unitTests() {
  console.log('Rules (node)');

  await test('cards: codes round-trip, suits and colours', () => {
    for (let c = 0; c < 52; c++) assert.equal(parseCode(codeOf(c)), c);
    assert.equal(codeOf(parseCode('10H')), '10H');
    assert.equal(rankOf(parseCode('QD')), 12);
    assert.equal(suitOf(parseCode('KC')), 3);
    assert.throws(() => parseCode('1X'));
  });

  await test('deal: seeded deals are deterministic and complete', () => {
    const a = dealState(123456);
    const b = dealState(123456);
    const c = dealState(123457);
    assert.deepEqual(a, b);
    assert.notDeepEqual(a.t, c.t);
    assert.deepEqual(shuffledDeck(99), shuffledDeck(99));
    validateState(a);
    assert.deepEqual(a.t.map((col) => col.length), [1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(a.hidden, [0, 1, 2, 3, 4, 5, 6]);
    assert.equal(a.stock.length, 24);
    assert.equal(a.waste.length, 0);
    const all = [...a.stock, ...a.t.flat()];
    assert.equal(new Set(all).size, 52);
    // Game numbers are clamped to the valid range.
    assert.equal(dealState(0).seed, 1);
    assert.equal(dealState(5e9).seed, 1000000);
  });

  await test('deal: different game numbers give well-mixed decks', () => {
    // First card of the deck should not be stuck on a few values over many seeds.
    const firsts = new Set();
    for (let s = 1; s <= 400; s++) firsts.add(shuffledDeck(s)[0]);
    assert.ok(firsts.size > 40, `only ${firsts.size} distinct first cards`);
  });

  await test('tableau: build down in alternating colours, Kings on empty columns', () => {
    const g = new Klondike(stateFrom({ t: [['8S'], ['7H'], ['7C'], [], ['KH'], ['QH'], ['QC', '9D']], hidden: [0, 0, 0, 0, 0, 0, 1] }));
    assert.equal(g.canMove('t1', 0, 't0'), true, 'red 7 on black 8');
    assert.equal(g.canMove('t2', 0, 't0'), false, 'black 7 on black 8');
    assert.equal(g.canMove('t4', 0, 't3'), true, 'King to empty column');
    assert.equal(g.canMove('t5', 0, 't3'), false, 'Queen to empty column');
    assert.equal(g.canMove('t0', 0, 't1'), false, 'up the sequence');
    assert.equal(g.canPick('t6', 0), false, 'face-down card cannot be picked');
    assert.equal(g.canMove('t1', 0, 't6'), false, 'never onto a face-down card... (9D is up but 7H is not 8)');
    assert.equal(g.canMove('t1', 0, 'stock'), false);
    assert.equal(g.canMove('t1', 0, 'waste'), false);
  });

  await test('tableau: whole runs move together; broken runs cannot be picked', () => {
    const g = new Klondike(stateFrom({ t: [['KS', 'QH', 'JC'], [], ['QS', 'JS'], ['2D', '9H'], [], [], []], hidden: [0, 0, 0, 1, 0, 0, 0] }));
    assert.equal(g.canPick('t0', 0), true);
    assert.equal(g.canPick('t0', 1), true);
    assert.equal(g.canPick('t2', 0), false, 'Q♠ J♠ is not alternating');
    assert.equal(g.canMove('t0', 0, 't1'), true, 'King-led run to an empty column');
    assert.equal(g.canMove('t0', 1, 't1'), false, 'Queen-led run to an empty column');
    const ev = g.move('t0', 0, 't1');
    assert.ok(ev);
    assert.deepEqual(g.s.t[1], C(['KS', 'QH', 'JC']));
    assert.deepEqual(g.s.t[0], []);
    assert.equal(g.bestTarget('t1', 0), null, 'a King already heading a column has nowhere useful to go');
  });

  await test('foundations: Ace first, then same suit upwards, one card at a time', () => {
    const g = new Klondike(stateFrom({ t: [['AH'], ['2H'], ['2S'], ['3H', '2C'], [], [], []], waste: ['AS'] }));
    assert.equal(g.canMove('t1', 0, 'f0'), false, '2 on empty foundation');
    assert.ok(g.move('t0', 0, 'f0'));
    assert.equal(g.canMove('t2', 0, 'f0'), false, 'wrong suit');
    assert.ok(g.move('t1', 0, 'f0'));
    assert.equal(g.canMove('t3', 0, 'f0'), false, 'runs never go to a foundation');
    assert.equal(g.bestTarget('waste', 0), 'f1', 'Ace goes to the first empty foundation');
    assert.equal(g.canMove('f0', 1, 'f1'), false, 'foundation to foundation');
  });

  await test('waste: only the top card plays; foundation cards can come back to the tableau', () => {
    const g = new Klondike(stateFrom({ t: [['9C'], ['4S'], [], [], [], [], []], waste: ['5H', '8D'], f: [['AH', '2H', '3H'], [], [], []], score: 100 }));
    assert.equal(g.canPick('waste', 0), false);
    assert.equal(g.canPick('waste', 1), true);
    assert.ok(g.move('waste', 1, 't0'));
    assert.equal(g.s.score, 105, 'waste to tableau +5');
    assert.ok(g.move('f0', 2, 't1'), '3♥ back onto 4♠');
    assert.equal(g.s.score, 90, 'foundation to tableau -15');
  });

  await test('scoring: standard values and the 0 floor', () => {
    const g = new Klondike(stateFrom({ t: [['2D', '9H'], ['10S'], ['AC'], [], [], [], []], hidden: [1, 0, 0, 0, 0, 0, 0], waste: ['AD'] }));
    let ev = g.move('t0', 1, 't1');
    assert.equal(ev.flipped, parseCode('2D'), 'revealed card reported');
    assert.equal(g.s.hidden[0], 0);
    assert.equal(g.s.score, 5, 'turn over +5');
    ev = g.move('t2', 0, 'f0');
    assert.equal(g.s.score, 15, 'tableau to foundation +10');
    ev = g.move('waste', 0, 'f1');
    assert.equal(g.s.score, 25, 'waste to foundation +10');
    ev = g.move('t0', 0, 'f1');
    assert.equal(g.s.score, 35);
    // floor
    const h = new Klondike(stateFrom({ t: [['3S'], [], [], [], [], [], []], f: [['AH', '2H'], [], [], []], score: 5 }));
    h.move('f0', 1, 't0');
    assert.equal(h.s.score, 0, 'never below zero');
  });

  await test('scoring: timed games lose 2 points per 10 s and earn a time bonus', () => {
    const g = new Klondike(stateFrom({ ...NEAR_WIN, score: 100 }));
    g.s.elapsed = 35000;
    assert.equal(g.score, 94);
    const untimed = new Klondike(stateFrom({ ...NEAR_WIN, score: 100, timed: false }));
    untimed.s.elapsed = 35000;
    assert.equal(untimed.score, 100);
    g.s.elapsed = 100000; // 100 s
    while (!g.isWon()) g.applyStep(g.autoStep());
    assert.equal(g.s.won, true);
    assert.equal(g.s.bonus, 7000, '700000 / 100 s');
    const fast = new Klondike(stateFrom(NEAR_WIN));
    fast.s.elapsed = 20000;
    while (!fast.isWon()) fast.applyStep(fast.autoStep());
    assert.equal(fast.s.bonus, 0, 'no bonus under 30 seconds');
  });

  await test('draw 1: one card per click; recycle costs 100 points and keeps the order', () => {
    const stock = C(['2S', '3S', '4S']); // top = 4S
    const g = new Klondike(stateFrom({ stock, t: [['KD'], [], [], [], [], [], []], score: 150, fill: 't6' }));
    g.drawCards();
    assert.deepEqual(g.s.waste, C(['4S']));
    g.drawCards();
    g.drawCards();
    assert.deepEqual(g.s.waste, C(['4S', '3S', '2S']));
    assert.equal(g.canDraw(), true, 'unlimited passes in standard scoring');
    const ev = g.drawCards();
    assert.equal(ev.type, 'recycle');
    assert.deepEqual(g.s.stock, stock, 'stock order restored');
    assert.equal(g.s.score, 50, 'recycle -100');
    g.drawCards();
    g.drawCards();
    g.drawCards();
    g.drawCards();
    assert.equal(g.s.score, 0, 'floored at 0');
  });

  await test('draw 3: three cards per click, fanned; fewer when the stock runs low', () => {
    const stock = C(['2S', '3S', '4S', '5S', '6S']); // top = 6S
    const g = new Klondike(stateFrom({ draw: 3, stock, t: [['KD'], [], [], [], [], [], []], fill: 't6' }));
    const ev = g.drawCards();
    assert.deepEqual(ev.cards, C(['6S', '5S', '4S']));
    assert.deepEqual(g.s.waste, C(['6S', '5S', '4S']));
    assert.equal(g.top('waste'), parseCode('4S'), 'third card ends on top');
    assert.equal(g.s.fan, 3);
    g.drawCards();
    assert.deepEqual(g.s.waste, C(['6S', '5S', '4S', '3S', '2S']));
    assert.equal(g.s.fan, 2);
    // Recycling in draw 3: free for the first three passes, then -20.
    g.s.score = 100;
    g.drawCards(); // recycle #1 (pass 2)
    assert.deepEqual(g.s.stock, stock);
    assert.equal(g.s.score, 100);
    g.drawCards();
    g.drawCards();
    g.drawCards(); // recycle #2 (pass 3)
    assert.equal(g.s.score, 100);
    g.drawCards();
    g.drawCards();
    g.drawCards(); // recycle #3 (pass 4)
    assert.equal(g.s.score, 80);
  });

  await test('draw 3: playing the top waste card un-fans one card', () => {
    const g = new Klondike(stateFrom({ draw: 3, stock: C(['2S', '3S', '9H']), t: [['10C'], [], [], [], [], [], []], fill: 't6' }));
    g.drawCards();
    assert.equal(g.top('waste'), parseCode('2S'));
    g.s.waste = C(['3S', '2S', '9H']); // make 9H the top (fan 3)
    assert.ok(g.move('waste', 2, 't0'));
    assert.equal(g.s.fan, 2);
  });

  await test('vegas: $52 per game, $5 per foundation card, limited passes, cumulative bank', () => {
    const g = Klondike.deal(7, { scoring: 'vegas' });
    assert.equal(g.score, -52);
    assert.equal(Klondike.deal(7, { scoring: 'vegas', bank: 100 }).score, 48);
    const v = new Klondike(stateFrom({ scoring: 'vegas', score: -52, t: [['AH'], ['2D'], [], [], [], [], []], stock: C(['5S']), fill: 't6' }));
    v.move('t0', 0, 'f0');
    assert.equal(v.score, -47);
    v.drawCards();
    assert.equal(v.canDraw(), false, 'draw 1 Vegas: a single pass');
    const v3 = new Klondike(stateFrom({ scoring: 'vegas', draw: 3, t: [['KD'], [], [], [], [], [], []], stock: C(['5S']), fill: 't6' }));
    v3.drawCards();
    assert.ok(v3.drawCards(), 'recycle 1');
    v3.drawCards();
    assert.ok(v3.drawCards(), 'recycle 2');
    v3.drawCards();
    assert.equal(v3.canDraw(), false, 'draw 3 Vegas: three passes');
    assert.equal(v3.drawCards(), null);
  });

  await test('undo: unlimited, restores every pile and the score (not the clock)', () => {
    const g = Klondike.deal(2024);
    const initial = JSON.stringify({ ...g.s, elapsed: 0 });
    let n = 0;
    for (; n < 40; n++) {
      const hnt = g.hints()[0];
      if (!hnt) break;
      if (hnt.draw) g.drawCards();
      else g.move(hnt.from, hnt.index, hnt.to);
      g.tick(1000);
    }
    assert.ok(n > 5, 'played a few moves');
    const elapsed = g.s.elapsed;
    while (g.undo());
    assert.equal(JSON.stringify({ ...g.s, elapsed: 0 }), initial);
    assert.equal(g.s.elapsed, elapsed, 'time keeps running');
    assert.equal(g.canUndo(), false);
  });

  await test('auto-complete: detected only when every card is face up and solvable', () => {
    const g = new Klondike(stateFrom(NEAR_WIN));
    assert.equal(g.canAutoComplete(), true);
    const hidden = new Klondike(stateFrom({ ...NEAR_WIN, hidden: [1, 0, 0, 0, 0, 0, 0] }));
    assert.equal(hidden.canAutoComplete(), false);
    assert.equal(Klondike.deal(5).canAutoComplete(), false);
    let steps = 0;
    while (!g.isWon()) {
      const st = g.autoStep();
      assert.ok(st, 'a step is always available');
      assert.ok(g.applyStep(st));
      steps++;
    }
    assert.equal(steps, 5);
    assert.equal(g.s.won, true);
    assert.equal(g.canUndo(), false, 'no undo after winning');
    assert.equal(g.move('f0', 12, 't0'), null, 'no moves after winning');
  });

  await test('auto-complete: waits for the stock to run out, recycles the waste when allowed', () => {
    const withStock = JSON.parse(JSON.stringify(NEAR_WIN));
    withStock.waste = [];
    withStock.stock = ['QC'];
    assert.equal(new Klondike(stateFrom(withStock)).canAutoComplete(), false, 'stock not exhausted yet');
    // Q♣ buried under K♣ in the waste: needs one recycle.
    const buried = JSON.parse(JSON.stringify(NEAR_WIN));
    buried.t[1] = [];
    buried.waste = ['QC', 'KC'];
    const g = new Klondike(stateFrom(buried));
    assert.equal(g.canAutoComplete(), true);
    while (!g.isWon()) g.applyStep(g.autoStep());
    assert.equal(g.s.won, true);
    assert.equal(g.s.recycles, 1);
    assert.equal(new Klondike(stateFrom({ ...buried, scoring: 'vegas' })).canAutoComplete(), false, 'no recycle left in Vegas draw 1');
  });

  await test('hints: legal, prioritised, de-duplicated; detects dead ends', () => {
    for (const seed of [1, 2, 3, 99, 4242]) {
      const g = Klondike.deal(seed);
      for (const hnt of g.hints()) {
        if (hnt.draw) assert.ok(g.canDraw());
        else assert.ok(g.canMove(hnt.from, hnt.index, hnt.to), `seed ${seed}: ${JSON.stringify(hnt)}`);
      }
    }
    const g = new Klondike(stateFrom({ t: [['3H', '9C'], ['10D'], ['AS'], [], [], [], []], hidden: [1, 0, 0, 0, 0, 0, 0] }));
    const hs = g.hints();
    assert.equal(hs[0].kind, 'reveal', 'turning a card over comes first');
    assert.equal(hs.filter((x) => x.to.startsWith('f')).length, 1, 'one suggestion for the Ace');
  });

  await test('hints: no-more-moves detection (and drawing counts as a move while the waste can recycle)', () => {
    const dead = deadEnd('vegas');
    assert.equal(dead.hints().length, 0, JSON.stringify(dead.hints()));
    assert.equal(dead.hasMoves(), false);
    assert.equal(dead.canDraw(), false);
    const alive = deadEnd('standard');
    assert.equal(alive.hasMoves(), true, 'J♠ / J♣ will come up again after recycling');
    assert.ok(alive.hints().some((x) => x.draw));
  });

  await test('hints: a card can come back down from a foundation to free a stuck one', () => {
    const g = new Klondike(stateFrom(foundationDownDesc()));
    const hs = g.hints();
    assert.equal(hs.length, 1, JSON.stringify(hs));
    assert.deepEqual([hs[0].from, hs[0].to, hs[0].kind], ['f3', 't0', 'foundation-down']);
    assert.equal(g.hasMoves(), true, 'not a dead end');
    assert.ok(g.move(hs[0].from, hs[0].index, hs[0].to));
    // Now the waste card that was waiting goes first, not 5♣ straight back home.
    const next = g.hints();
    assert.deepEqual([next[0].from, next[0].to], ['waste', 't0'], JSON.stringify(next));
    // Without anything waiting for it, a foundation card stays put (the dead end is still a dead end).
    assert.equal(deadEnd('vegas').hasMoves(), false);
  });

  await test('save / load: tampered data is cleaned up, broken layouts refused', () => {
    const g = Klondike.deal(4242);
    const raw = JSON.parse(JSON.stringify(g.toJSON()));
    Object.assign(raw.state, { seed: 'abc', draw: 7, scoring: '<img src=x onerror=alert(1)>', timed: 'yes', score: 'NaN', moves: -3, recycles: 'z', elapsed: 'later', fan: 'q', bonus: 1e9 });
    raw.state.hidden[6] = 7; // top card face down: never a Klondike position
    raw.history = [1, 'x', null, { stock: [] }, JSON.parse(JSON.stringify(g.s))];
    const back = Klondike.fromJSON(raw);
    const s = back.s;
    assert.deepEqual([s.seed, s.draw, s.scoring, s.timed, s.score, s.moves, s.recycles, s.elapsed, s.fan, s.bonus, s.won], [1, 1, 'standard', true, 0, 0, 0, 0, 0, 0, false]);
    assert.equal(s.hidden[6], 6, 'the top card of a column is face up');
    assert.equal(back.history.length, 1, 'only the valid history entry is kept');
    assert.throws(() => normalizeState({ ...g.s, t: g.s.t.map((c, i) => (i ? c : [...c, 999])) }), /52 cards/);
    assert.throws(() => normalizeState('nope'), /missing/);
    // Vegas keeps a negative score; won is derived from the foundations, not trusted.
    const v = normalizeState({ ...Klondike.deal(9, { scoring: 'vegas' }).s, won: true, score: -40 });
    assert.equal(v.won, false);
    assert.equal(v.score, -40);
  });

  await test('statistics: stored records are sanitised; Vegas dollars never become the best score', () => {
    const st = sanitizeStats({ played: 'lots', won: 9, bestTime: -5, streak: -2.4, longestWin: Infinity, extra: 1 });
    assert.deepEqual(st, { ...emptyStats(), won: 0, streak: -2 });
    assert.deepEqual(sanitizeStats(null), emptyStats());
    let s2 = recordResult(emptyStats(), { won: true, time: 90000, score: 208, scoring: 'vegas' });
    assert.equal(s2.bestScore, 0, 'Vegas win: no best score');
    assert.equal(s2.won, 1);
    s2 = recordResult(s2, { won: true, time: 90000, score: 650, scoring: 'standard' });
    assert.equal(s2.bestScore, 650);
  });

  await test('save / load: JSON round trip keeps the undo history', () => {
    const g = Klondike.deal(31337, { draw: 3 });
    g.drawCards();
    const hnt = g.hints().find((x) => !x.draw);
    if (hnt) g.move(hnt.from, hnt.index, hnt.to);
    const json = JSON.parse(JSON.stringify(g.toJSON()));
    const back = Klondike.fromJSON(json);
    assert.deepEqual(back.s, g.s);
    assert.equal(back.history.length, g.history.length);
    back.undo();
    g.undo();
    assert.deepEqual(back.s, g.s);
    assert.throws(() => Klondike.fromJSON({ state: { ...g.s, stock: [] } }), /52 cards/);
  });

  await test('statistics: wins, losses, streaks and bests', () => {
    let st = emptyStats();
    st = recordResult(st, { won: true, time: 300000, score: 500 });
    st = recordResult(st, { won: true, time: 200000, score: 400 });
    st = recordResult(st, { won: false, time: 50000, score: 10 });
    st = recordResult(st, { won: false, time: 50000, score: 10 });
    st = recordResult(st, { won: false, time: 50000, score: 10 });
    st = recordResult(st, { won: true, time: 250000, score: 900 });
    assert.equal(st.played, 6);
    assert.equal(st.won, 3);
    assert.equal(st.bestTime, 200000);
    assert.equal(st.bestScore, 900);
    assert.equal(st.longestWin, 2);
    assert.equal(st.longestLoss, 3);
    assert.equal(st.streak, 1);
  });

  await test('i18n: every string exists in English and French', () => {
    const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'renderer');
    const dict = JSON.parse(fs.readFileSync(path.join(root, 'apps/solitaire/i18n.json'), 'utf8'));
    const core = { en: JSON.parse(fs.readFileSync(path.join(root, 'core/i18n/en.json'), 'utf8')), fr: JSON.parse(fs.readFileSync(path.join(root, 'core/i18n/fr.json'), 'utf8')) };
    assert.deepEqual(Object.keys(dict.fr).sort(), Object.keys(dict.en).sort(), 'same keys in en and fr');
    for (const [k, v] of Object.entries(dict.fr)) assert.ok(typeof v === 'string' && v.trim(), `fr.${k} empty`);
    const src = fs.readFileSync(path.join(root, 'apps/solitaire/main.js'), 'utf8');
    const used = new Set([...src.matchAll(/\bt\(\s*'([^']+)'/g)].map((m) => m[1]));
    for (let r = 1; r <= 13; r++) used.add(`rank${r}`);
    for (let su = 0; su < 4; su++) used.add(`suit${su}`);
    for (const k of ['standard', 'vegas', 'none']) used.add(`scoring.${k}`);
    for (const k of ['confirmNew', 'confirmRestart']) used.add(`${k}.title`).add(`${k}.ok`);
    for (const b of BACKS) used.add(`back.${b}`);
    for (const b of ['felt', 'blue', 'aurora']) used.add(`tableBg.${b}`);
    // keys passed through helpers (tbBtn / stat / keys table)
    for (const m of src.matchAll(/\[\s*(?:'[^']*'|`[^`]*`|t\('[^']*'\)),\s*'([a-zA-Z.]+)'\s*\]/g)) used.add(m[1]);
    assert.ok(used.has('help.kAuto') && used.has('help.kCancel') && used.has('restart'), 'help-table keys are checked');
    // Key names shown to the user are localized too (Maj / Entrée / Échap in French).
    assert.equal(dict.fr['key.shift'], 'Maj');
    assert.equal(dict.fr['key.esc'], 'Échap');
    assert.ok(!/\[\s*'(Shift|Ctrl|Esc|Enter)[^']*',\s*'[a-zA-Z.]+'\s*\]/.test(src), 'no hard-coded English key names in the help table');
    for (const m of src.matchAll(/stat\('([a-z]+)'\)/g)) used.add(m[1]);
    const get = (d, k) => (k in d ? d[k] : k.split('.').reduce((o, x) => (o == null ? undefined : o[x]), d));
    for (const lang of ['en', 'fr']) {
      for (const k of used) {
        const ok = [dict[lang], core[lang]].some((d) => typeof get(d, k) === 'string' || typeof get(d, `${k}_other`) === 'string');
        assert.ok(ok, `${lang}: missing "${k}"`);
      }
    }
  });

  await test('icons: every icon the app uses exists', () => {
    const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'renderer');
    const src = fs.readFileSync(path.join(root, 'apps/solitaire/main.js'), 'utf8');
    // Phosphor names, or old Fluent names through the aliases (same rule as core/icons.js resolveIcon)
    const known = ((j) => (n) => { n = String(n).replace(/_filled$/, ''); const a = j.aliases[n]; if (a) return !!j.glyphs[a.split(':')[0]]; if (j.glyphs[n]) return true; const m = /^(.+)-(fill|bold|regular)$/.exec(n); return !!(m && j.glyphs[m[1]]); })(JSON.parse(fs.readFileSync(path.join(root, 'assets/icons/phosphor.json'), 'utf8')));
    const names = new Set([...src.matchAll(/icon\('([a-z0-9_]+)'/g), ...src.matchAll(/icon: '([a-z0-9_]+)'/g), ...src.matchAll(/tbBtn\('([a-z0-9_]+)'/g)].map((m) => m[1]));
    assert.ok(names.size >= 10);
    for (const n of names) assert.ok(known(n), `unknown icon ${n}`);
  });

  await test('artwork: 52 distinct faces and every back render as SVG', () => {
    const faces = new Set();
    for (let c = 0; c < 52; c++) {
      const svg = faceSvg(c);
      assert.match(svg, /^<svg [^>]*viewBox="0 0 250 350"/);
      assert.ok(svg.endsWith('</svg>'));
      assert.equal((svg.match(/<g/g) || []).length, (svg.match(/<\/g>/g) || []).length, `balanced <g> in ${codeOf(c)}`);
      faces.add(svg);
    }
    assert.equal(faces.size, 52);
    for (const b of BACKS) assert.match(backSvg(b, '#e3008c'), /<\/svg>$/);
    assert.notEqual(backSvg('aurora', '#e3008c'), backSvg('aurora', '#0078d4'), 'Selene back follows the accent colour');
  });
}

// ---------------------------------------------------------------- 2. UI
async function uiTests() {
  const { launchShell, OUT } = await import('./lib.mjs');
  const SHOTS = path.join(path.dirname(OUT), '..', '..', 'docs', 'screenshots');
  fs.mkdirSync(SHOTS, { recursive: true });
  const publish = (file, name) => fs.copyFileSync(file, path.join(SHOTS, `${name}.png`));
  // Screenshot of the Solitaire window plus a margin of desktop (full screen when maximized).
  const winShot = async (sh, name) => {
    const file = path.join(OUT, `${name}.png`);
    const clip = await sh.page.evaluate(() => {
      const el = document.querySelector('.app-solitaire');
      const r = el.getBoundingClientRect();
      const m = 24;
      const x = Math.max(0, r.left - m);
      const y = Math.max(0, r.top - m);
      return { x, y, width: Math.min(window.innerWidth, r.right + m) - x, height: Math.min(window.innerHeight, r.bottom + m) - y };
    });
    await sh.page.screenshot({ path: file, clip });
    return file;
  };

  const solErrors = (s) =>
    s.logs.filter((l) => (l.startsWith('[pageerror]') || l.startsWith('[error]')) && !/Failed to load resource/.test(l)).concat(s.logs.filter((l) => /solitaire/i.test(l) && /error|warn/i.test(l)));

  // Helpers bound to a launched shell.
  const helpers = (s) => {
    const T = (fn, ...a) =>
      s.page.evaluate(
        ([f, a2]) => {
          const w = window.__aurora.wm.byApp('solitaire')[0];
          return window.__aurora.registry.instance(w.id).hooks.test[f](...a2);
        },
        [fn, a],
      );
    const win = (fn, ...a) =>
      s.page.evaluate(
        ([f, a2]) => {
          const w = window.__aurora.wm.byApp('solitaire')[0];
          return w[f](...a2);
        },
        [fn, a],
      );
    const idle = async () => {
      for (let i = 0; i < 100; i++) {
        if (!(await T('busy'))) return;
        await s.page.waitForTimeout(50);
      }
      throw new Error('solitaire stayed busy');
    };
    const center = async (code) => {
      const r = await T('cardRect', code);
      return { x: r.x + r.width / 2, y: r.y + Math.min(20, r.height / 4) };
    };
    const drag = async (from, to, steps = 12) => {
      await s.page.mouse.move(from.x, from.y);
      await s.page.mouse.down();
      await s.page.mouse.move(from.x + 6, from.y + 6, { steps: 2 });
      await s.page.mouse.move(to.x, to.y, { steps });
      await s.page.mouse.up();
    };
    const where = async (code) => {
      const st = await T('state');
      const c = (() => {
        const m = /^(A|[2-9]|10|J|Q|K)([SHDC])$/.exec(code);
        return 'SHDC'.indexOf(m[2]) * 13 + ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'].indexOf(m[1]);
      })();
      if (st.stock.includes(c)) return 'stock';
      if (st.waste.includes(c)) return 'waste';
      for (let i = 0; i < 4; i++) if (st.f[i].includes(c)) return `f${i}`;
      for (let i = 0; i < 7; i++) if (st.t[i].includes(c)) return `t${i}`;
      return null;
    };
    return { T, win, idle, center, drag, where };
  };

  console.log('UI (Electron, en / light, 1600x900)');
  const s = await launchShell({ open: ['solitaire'], lang: 'en', theme: 'light' });
  const { T, win, idle, center, drag, where } = helpers(s);
  try {
    await s.page.waitForSelector('.app-solitaire .sol-card', { timeout: 20000 });
    await idle();
    await s.page.waitForTimeout(400);

    await test('launch: 52 cards dealt into 7 columns, top cards face up, labelled', async () => {
      assert.equal(await s.page.locator('.app-solitaire .sol-card').count(), 52);
      assert.equal(await s.page.locator('.app-solitaire .sol-slot').count(), 13);
      const st = await T('state');
      assert.deepEqual(st.t.map((c) => c.length), [1, 2, 3, 4, 5, 6, 7]);
      assert.equal(st.stock.length, 24);
      const up = await s.page.locator('.app-solitaire .sol-card:not(.down)').count();
      assert.equal(up, 7);
      const label = await s.page.locator('.app-solitaire .sol-card:not(.down)').first().getAttribute('aria-label');
      assert.match(label, /^(Ace|[2-9]|10|Jack|Queen|King) of (spades|hearts|diamonds|clubs)$/);
      assert.equal(await s.page.locator('.app-solitaire .sol-card.down').first().getAttribute('aria-label'), 'Face-down card');
      // Card art decodes.
      const ok = await s.page.evaluate(async () => {
        const el = document.querySelector('.app-solitaire .sol-front');
        const url = getComputedStyle(el).backgroundImage.replace(/^url\("?|"?\)$/g, '');
        const img = new Image();
        img.src = url;
        await img.decode();
        return img.naturalWidth;
      });
      assert.ok(ok > 0);
    });
    await s.page.mouse.move(5, 5);
    publish(await winShot(s, 'solitaire-new-deal'), 'solitaire-new-deal');

    await test('deal: a numbered game reproduces the same layout', async () => {
      await T('deal', 4242);
      const a = await T('state');
      await T('deal', 4242);
      const b = await T('state');
      assert.deepEqual(a.t, b.t);
      assert.equal(await s.page.locator('.app-solitaire .sol-gameno').textContent(), 'Game #4242');
    });

    await test('toolbar: one Tab stop, arrow keys / Home / End move between the buttons', async () => {
      await s.page.locator('.app-solitaire .sol-split-main').focus();
      const focused = () => s.page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
      const stops = () => s.page.locator('.app-solitaire .sol-toolbar button[tabindex="0"]').count();
      assert.equal(await stops(), 1);
      await s.page.keyboard.press('ArrowRight');
      assert.equal(await focused(), 'More game options');
      await s.page.keyboard.press('End');
      assert.equal(await focused(), 'Settings');
      assert.equal(await stops(), 1, 'the Tab stop follows the focus');
      await s.page.keyboard.press('ArrowRight');
      assert.equal(await focused(), 'New game', 'wraps around');
      await s.page.keyboard.press('ArrowLeft');
      assert.equal(await focused(), 'Settings');
      await s.page.keyboard.press('Home');
      assert.equal(await focused(), 'New game');
      // Undo is disabled at the start of a game: arrows skip it.
      await s.page.keyboard.press('ArrowRight');
      await s.page.keyboard.press('ArrowRight');
      assert.equal(await focused(), 'Hint');
      await s.page.locator('.app-solitaire .sol-table').focus();
    });

    // Crafted position for drag & drop tests.
    const POS = {
      t: [['8S'], ['5C', '7H'], ['QD'], [], ['AH'], ['2C'], ['9D']],
      hidden: [0, 1, 0, 0, 0, 0, 0],
      waste: ['3D'],
    };

    await test('drag: a legal drop moves the card, turns the hidden card over and scores', async () => {
      await T('load', POS);
      await s.page.waitForTimeout(100);
      await drag(await center('7H'), await center('8S'));
      await s.page.waitForTimeout(450);
      assert.equal(await where('7H'), 't0');
      const st = await T('state');
      assert.equal(st.hidden[1], 0, '5♣ turned over');
      assert.equal(st.score, 5);
      assert.equal(st.moves, 1);
      const flipped = await s.page.locator('.app-solitaire .sol-card[data-code="5C"]').getAttribute('class');
      assert.ok(!flipped.includes('down'));
    });

    await test('drag: illegal drops snap back (foundation and empty column)', async () => {
      const before = await T('cardRect', 'QD');
      const f0 = await T('pileRect', 'f0');
      await drag(await center('QD'), { x: f0.x + f0.width / 2, y: f0.y + 20 });
      await s.page.waitForTimeout(80);
      const mid = await T('cardRect', 'QD');
      await s.page.waitForTimeout(450);
      assert.equal(await where('QD'), 't2');
      const after = await T('cardRect', 'QD');
      assert.ok(Math.abs(after.x - before.x) < 1 && Math.abs(after.y - before.y) < 1, 'back home');
      assert.ok(Math.abs(mid.x - before.x) > 2 || Math.abs(mid.y - before.y) > 2, 'it animates back rather than jumping');
      const t3 = await T('pileRect', 't3');
      await drag(await center('QD'), { x: t3.x + t3.width / 2, y: t3.y + 30 });
      await s.page.waitForTimeout(450);
      assert.equal(await where('QD'), 't2');
      assert.equal((await T('state')).moves, 1, 'no move counted');
    });

    await test('click: double-clicking an Ace sends it to a foundation (single move)', async () => {
      const p = await center('AH');
      await s.page.mouse.dblclick(p.x, p.y);
      await s.page.waitForTimeout(450);
      assert.match(await where('AH'), /^f\d$/);
      const st = await T('state');
      assert.equal(st.moves, 2, 'the second click is not a second move');
      assert.equal(st.score, 15);
    });

    await test('click: waste card plays to its best column (prefers foundation when possible)', async () => {
      // 3♦ has no place; clicking it should shake and not move.
      const p = await center('3D');
      await s.page.mouse.click(p.x, p.y);
      await s.page.waitForTimeout(300);
      assert.equal(await where('3D'), 'waste');
      assert.equal((await T('state')).moves, 2);
    });

    await test('undo: Ctrl+Z steps back through the moves', async () => {
      await s.page.keyboard.press('Control+z');
      await s.page.waitForTimeout(350);
      assert.equal(await where('AH'), 't4');
      assert.equal((await T('state')).score, 5);
      await s.page.click('.app-solitaire .sol-tb-btn[aria-label="Undo"]');
      await s.page.waitForTimeout(350);
      assert.equal(await where('7H'), 't1');
      const st = await T('state');
      assert.equal(st.hidden[1], 1, '5♣ is face down again');
      assert.equal(st.moves, 0);
      assert.equal(await s.page.locator('.app-solitaire .sol-tb-btn[aria-label="Undo"]').isDisabled(), true);
    });

    await test('stock: clicking draws, clicking the empty stock recycles', async () => {
      const rest = ALL.filter((c) => !['KD', '2S', '3S'].includes(c));
      await T('load', { t: [['KD'], [], [], [], [], [], []], stock: ['2S', '3S'], waste: rest });
      const stockSlot = await T('pileRect', 'stock');
      const click = () => s.page.mouse.click(stockSlot.x + 20, stockSlot.y + 20);
      await click();
      await s.page.waitForTimeout(350);
      let st = await T('state');
      assert.equal(st.waste.length, 50);
      assert.equal(codeOf(st.waste[st.waste.length - 1]), '3S', 'top of the stock turned over');
      assert.equal(await s.page.locator('.app-solitaire .sol-card[data-code="3S"]').evaluate((e) => e.classList.contains('down')), false);
      await click();
      await s.page.waitForTimeout(350);
      st = await T('state');
      assert.equal(st.stock.length, 0);
      assert.equal(await s.page.locator('.app-solitaire .sol-slot-stock.can-recycle').count(), 1, 'recycle glyph shown');
      await click();
      await s.page.waitForTimeout(450);
      st = await T('state');
      assert.equal(st.stock.length, 51);
      assert.equal(st.waste.length, 0);
      assert.equal(st.recycles, 1);
      assert.equal(st.moves, 3);
    });

    await test('stock: rapid clicks each draw a card (none lost to the card still gliding away)', async () => {
      await T('deal', 2718, { draw: 1, scoring: 'standard' });
      const stockSlot = await T('pileRect', 'stock');
      for (let i = 0; i < 5; i++) await s.page.mouse.click(stockSlot.x + 30, stockSlot.y + 30);
      await s.page.waitForTimeout(450);
      const st = await T('state');
      assert.equal(st.waste.length, 5, 'five clicks, five cards');
      assert.equal(st.moves, 5);
      assert.equal(await s.page.locator('.app-solitaire .sol-card:not(.down)').count(), 7 + 5);
    });

    await test('keyboard: pick up with Enter, drop with a column number', async () => {
      await T('load', POS);
      await s.page.locator('.app-solitaire .sol-table').focus();
      await s.page.keyboard.press('2'); // cursor to column 2 (7♥)
      await s.page.keyboard.press('Enter'); // pick up
      assert.deepEqual(await T('held'), { pile: 't1', index: 1 });
      assert.equal(await s.page.locator('.app-solitaire .sol-card.held').count(), 1);
      await s.page.keyboard.press('ArrowLeft'); // to column 1
      await s.page.keyboard.press('Space'); // drop
      await s.page.waitForTimeout(350);
      assert.equal(await where('7H'), 't0');
      assert.equal(await T('held'), null);
      assert.ok(await s.page.locator('.app-solitaire .sol-cursor.show').count(), 'cursor visible in keyboard mode');
      // Arrow navigation reaches the top row and Shift+Enter auto-moves.
      await s.page.keyboard.press('5');
      await s.page.keyboard.press('Shift+Enter');
      await s.page.waitForTimeout(350);
      assert.match(await where('AH'), /^f\d$/);
      // Illegal drop keeps the selection.
      await s.page.keyboard.press('3');
      await s.page.keyboard.press('Enter');
      await s.page.keyboard.press('1');
      assert.ok(await T('held'), 'still holding Q♦ after an illegal drop');
      await s.page.keyboard.press('Escape');
      assert.equal(await T('held'), null);
      await s.page.keyboard.press('ArrowUp');
      assert.equal((await T('cursor')).pile, 'waste', 'up from column 3 (nothing above it) lands on the waste');
      await s.page.keyboard.press('ArrowRight');
      assert.equal((await T('cursor')).pile, 'f0');
      await s.page.keyboard.press('ArrowDown');
      assert.equal((await T('cursor')).pile, 't3');
    });
    publish(await winShot(s, 'solitaire-keyboard'), 'solitaire-keyboard');

    await test('click-to-select mode: click a card, then its destination', async () => {
      await T('setPrefs', { clickMove: false });
      await T('load', POS);
      const a = await center('7H');
      await s.page.mouse.click(a.x, a.y);
      assert.deepEqual(await T('held'), { pile: 't1', index: 1 });
      await s.page.waitForTimeout(500); // not a double-click
      const b = await center('8S');
      // Double-clicking the destination drops the card there, and the second click must not then send
      // the new 8♠-7♥ run on to the 9♦.
      await s.page.mouse.dblclick(b.x, b.y);
      await s.page.waitForTimeout(350);
      assert.equal(await where('7H'), 't0');
      assert.equal(await where('8S'), 't0', 'the run stays where it was built');
      assert.equal((await T('state')).moves, 1);
      await s.page.keyboard.press('Escape');
      // double-click still auto-moves
      const c = await center('AH');
      await s.page.mouse.dblclick(c.x, c.y);
      await s.page.waitForTimeout(350);
      assert.match(await where('AH'), /^f\d$/);
      await T('setPrefs', { clickMove: true });
    });

    await test('drag: whole runs, waste cards and foundation cards', async () => {
      await T('load', { t: [['9S', '8H', '7C'], ['10H'], ['4H'], [], [], [], []], waste: ['6D'], f: [['AS', '2S', '3S']], score: 50 });
      await drag(await center('9S'), await center('10H'));
      await s.page.waitForTimeout(400);
      let st = await T('state');
      assert.deepEqual(st.t[1].map(codeOf), ['10H', '9S', '8H', '7C'], 'the whole run moved');
      assert.equal(st.t[0].length, 0);
      await drag(await center('6D'), await center('7C'));
      await s.page.waitForTimeout(400);
      st = await T('state');
      assert.equal(codeOf(st.t[1][4]), '6D');
      assert.equal(st.score, 55, 'waste to tableau +5');
      await drag(await center('3S'), await center('4H'));
      await s.page.waitForTimeout(400);
      st = await T('state');
      assert.deepEqual(st.t[2].map(codeOf), ['4H', '3S']);
      assert.equal(st.score, 40, 'foundation to tableau -15');
      // A run never goes to a foundation.
      const f1 = await T('pileRect', 'f1');
      await drag(await center('8H'), { x: f1.x + f1.width / 2, y: f1.y + 20 });
      await s.page.waitForTimeout(400);
      assert.equal(await where('8H'), 't1');
    });

    await test('right-click sends every playable card to the foundations', async () => {
      await T('load', { t: [['AH'], ['3H'], ['AS'], [], [], [], []], waste: ['2H'] });
      await s.page.mouse.click(700, 600, { button: 'right' });
      await s.page.waitForTimeout(900);
      for (const c of ['AH', '2H', '3H', 'AS']) assert.match(await where(c), /^f\d$/, c);
      assert.equal((await T('state')).moves, 4);
    });

    await test('Esc during a drag puts the cards back', async () => {
      await T('load', POS);
      const a = await center('7H');
      await s.page.mouse.move(a.x, a.y);
      await s.page.mouse.down();
      await s.page.mouse.move(a.x + 40, a.y + 40, { steps: 4 });
      await s.page.keyboard.press('Escape');
      const b = await center('8S');
      await s.page.mouse.move(b.x, b.y, { steps: 4 });
      await s.page.mouse.up();
      await s.page.waitForTimeout(400);
      assert.equal(await where('7H'), 't1');
      assert.equal(await s.page.locator('.app-solitaire .sol-card.dragging').count(), 0);
    });

    await test('hint: H highlights a legal move', async () => {
      await T('load', POS);
      await s.page.locator('.app-solitaire .sol-table').focus();
      await s.page.keyboard.press('h');
      await s.page.waitForTimeout(500);
      assert.ok((await s.page.locator('.app-solitaire .sol-card.hint').count()) >= 1);
      assert.ok((await s.page.locator('.app-solitaire .hint-dst').count()) >= 1);
    });

    await test('no more moves: a banner offers Undo / New game', async () => {
      const desc = deadEndDesc('vegas');
      await T('load', desc);
      await s.page.waitForTimeout(350);
      assert.equal(await s.page.locator('.app-solitaire .sol-banner:not([hidden])').count(), 1);
      publish(await winShot(s, 'solitaire-no-moves'), 'solitaire-no-moves');
      await s.page.click('.app-solitaire .sol-banner .btn.primary'); // New game (game not started: no confirmation)
      await s.page.waitForTimeout(300);
      await idle();
      assert.equal(await s.page.locator('.app-solitaire .sol-banner:not([hidden])').count(), 0);
      assert.equal((await T('state')).stock.length, 24);
    });

    await test('mid-game screenshot (seed 7, 30 hinted moves)', async () => {
      await T('deal', 7, { draw: 3 });
      const n = await T('autoplay', 30);
      assert.ok(n > 10, `played ${n}`);
      await T('setElapsed', 134000);
      await s.page.waitForTimeout(300);
    });
    await s.page.mouse.move(5, 5);
    publish(await winShot(s, 'solitaire-mid-game'), 'solitaire-mid-game');

    await test('language switch at runtime relabels the toolbar and the cards', async () => {
      await s.page.evaluate(() => window.__aurora.settings.set('lang', 'fr'));
      await s.page.waitForTimeout(400);
      assert.equal(await s.page.locator('.app-solitaire .sol-split-main').getAttribute('aria-label'), 'Nouvelle partie');
      assert.match(await s.page.locator('.app-solitaire .sol-gameno').textContent(), /^Partie n° 7$/);
      assert.match(await s.page.locator('.app-solitaire .sol-card:not(.down)').first().getAttribute('aria-label'), / de (pique|cœur|carreau|trèfle)$/);
      assert.equal(await s.page.locator('.app-solitaire .sol-stat-moves .sol-stat-label').textContent(), 'Coups');
      await s.page.evaluate(() => window.__aurora.settings.set('lang', 'en'));
      await s.page.waitForTimeout(400);
      assert.equal(await s.page.locator('.app-solitaire .sol-stat-moves .sol-stat-label').textContent(), 'Moves');
    });

    await test('accent colour change repaints the Selene card back', async () => {
      const back = () => s.page.locator('.app-solitaire .sol-table').evaluate((e) => e.style.getPropertyValue('--sol-back'));
      const before = await back();
      await s.page.evaluate(() => window.__aurora.settings.set('accent', '#e3008c'));
      await s.page.waitForTimeout(400);
      const after = await back();
      assert.notEqual(before, after);
      assert.ok(decodeURIComponent(after).includes('#e3008c'));
      await s.page.evaluate(() => window.__aurora.settings.set('accent', '#0078d4'));
      await s.page.waitForTimeout(300);
    });

    await test('auto-complete: button appears, cards fly home, win cascade and dialog', async () => {
      await T('deal', 1, { draw: 1 });
      await T('load', NEAR_WIN);
      await T('setElapsed', 95000);
      await s.page.waitForTimeout(200);
      assert.equal(await T('canAutoComplete'), true);
      assert.equal(await T('autoVisible'), true);
      await s.page.click('.app-solitaire .sol-auto');
      for (let i = 0; i < 60 && !(await T('cascading')); i++) await s.page.waitForTimeout(100);
      assert.equal((await T('state')).won, true);
      assert.equal(await T('cascading'), true, 'cascade running');
      await s.page.waitForTimeout(2600);
      publish(await winShot(s, 'solitaire-win-cascade'), 'solitaire-win-cascade');
      await s.page.mouse.click(800, 500); // skip
      await s.page.waitForSelector('.app-solitaire .dialog-title:has-text("You won")', { timeout: 5000 });
      await s.page.waitForTimeout(400);
      publish(await winShot(s, 'solitaire-win-dialog'), 'solitaire-win-dialog');
      const stats = await T('stats');
      assert.equal(stats.draw1.won, 1);
      assert.equal(stats.draw1.played, 1);
      assert.ok(stats.draw1.bestScore > 0);
      await s.page.click('.app-solitaire .dialog-footer .btn.primary');
      await s.page.waitForTimeout(300);
      await idle();
      const st = await T('state');
      assert.equal(st.won, false);
      assert.equal(st.moves, 0);
    });

    await test('new game mid-game asks first and records a loss', async () => {
      await T('load', POS);
      const a = await center('AH');
      await s.page.mouse.click(a.x, a.y); // one move
      await s.page.waitForTimeout(300);
      await s.page.keyboard.press('F2');
      await s.page.waitForSelector('.app-solitaire .dialog-title:has-text("Start a new game?")');
      await s.page.click('.app-solitaire .dialog-footer .btn:not(.primary)'); // cancel
      await s.page.waitForTimeout(250);
      assert.equal((await T('state')).moves, 1);
      await s.page.keyboard.press('F2');
      await s.page.waitForSelector('.app-solitaire .dialog-title:has-text("Start a new game?")');
      await s.page.click('.app-solitaire .dialog-footer .btn.primary');
      await s.page.waitForTimeout(300);
      await idle();
      assert.equal((await T('state')).moves, 0);
      const st = await T('stats');
      assert.equal(st.draw1.played, 2);
      assert.equal(st.draw1.streak, -1);
    });

    await test('statistics dialog lists the numbers', async () => {
      await s.page.click('.app-solitaire .sol-tb-btn[aria-label="Statistics"]');
      await s.page.waitForSelector('.app-solitaire .sol-stats-grid');
      await s.page.waitForTimeout(400);
      const txt = await s.page.locator('.app-solitaire .sol-stats-grid').innerText();
      assert.match(txt, /Games played\s+2/);
      assert.match(txt, /Win rate\s+50%/);
      publish(await winShot(s, 'solitaire-statistics'), 'solitaire-statistics');
      await s.page.keyboard.press('Escape');
      await s.page.waitForTimeout(250);
    });

    await test('play a numbered game: the dialog validates the number', async () => {
      await T('deal', 1);
      await s.page.click('.app-solitaire .sol-split-more');
      await s.page.click('.menu .menu-item:has-text("Play game number")');
      await s.page.waitForSelector('.app-solitaire .dialog input');
      await s.page.fill('.app-solitaire .dialog input', 'abc');
      await s.page.keyboard.press('Enter');
      await s.page.waitForTimeout(150);
      assert.match(await s.page.locator('.app-solitaire .dialog .field-hint').textContent(), /whole number/);
      await s.page.fill('.app-solitaire .dialog input', '777');
      await s.page.keyboard.press('Enter');
      await s.page.waitForTimeout(400);
      await idle();
      assert.equal((await T('state')).seed, 777);
      assert.equal(await s.page.locator('.app-solitaire .sol-gameno').textContent(), 'Game #777');
    });

    await test('restart this deal (Shift+F2) deals the same cards again', async () => {
      const first = await T('state');
      await T('autoplay', 3);
      await s.page.locator('.app-solitaire .sol-table').focus();
      await s.page.keyboard.press('Shift+F2');
      await s.page.waitForSelector('.app-solitaire .dialog-title:has-text("Restart this deal?")');
      await s.page.click('.app-solitaire .dialog-footer .btn.primary');
      await s.page.waitForTimeout(400);
      await idle();
      const st = await T('state');
      assert.equal(st.seed, 777);
      assert.equal(st.moves, 0);
      assert.deepEqual(st.t, first.t);
      assert.equal((await T('stats')).draw1.played, 3, 'the abandoned attempt counts as a loss');
    });

    await test('settings dialog: switch to Draw 3 + Vegas and the ocean back', async () => {
      await s.page.click('.app-solitaire .sol-toolbar button[aria-label="Settings"]');
      await s.page.waitForSelector('.app-solitaire .sol-settings');
      await s.page.click('.app-solitaire .sol-settings .segmented button:has-text("Draw 3")');
      await s.page.selectOption('.app-solitaire .sol-settings select', 'vegas');
      await s.page.click('.app-solitaire .sol-pick[data-value="ocean"]');
      await s.page.waitForTimeout(300);
      publish(await winShot(s, 'solitaire-settings'), 'solitaire-settings');
      await s.page.click('.app-solitaire .dialog-footer .btn.primary');
      await s.page.waitForTimeout(400);
      await idle();
      const p = await T('prefs');
      assert.equal(p.draw, 3);
      assert.equal(p.scoring, 'vegas');
      assert.equal(p.back, 'ocean');
      const st = await T('state');
      assert.equal(st.draw, 3, 'unstarted game re-dealt with the new options');
      assert.equal(st.score, -52);
    });

    await test('settings: Cancel reverts the live preview of the card back and table', async () => {
      const look = () => s.page.locator('.app-solitaire .sol-table').evaluate((e) => [e.dataset.bg, e.style.getPropertyValue('--sol-back').length]);
      const before = await look();
      await s.page.click('.app-solitaire .sol-toolbar button[aria-label="Settings"]');
      await s.page.waitForSelector('.app-solitaire .sol-settings');
      await s.page.click('.app-solitaire .sol-pick[data-value="midnight"]');
      await s.page.click('.app-solitaire .sol-pick[data-value="felt"] .sol-pick-table');
      assert.equal((await look())[0], 'felt', 'previewed live');
      await s.page.click('.app-solitaire .dialog-footer .btn:not(.primary)');
      await s.page.waitForTimeout(300);
      assert.deepEqual(await look(), before);
      assert.equal((await T('prefs')).back, 'ocean');
    });

    await test('statistics: Reset clears the selected mode after confirmation', async () => {
      await s.page.click('.app-solitaire .sol-tb-btn[aria-label="Statistics"]');
      await s.page.waitForSelector('.app-solitaire .sol-stats-grid');
      await s.page.click('.app-solitaire .sol-stats-body .segmented button:has-text("Draw 1")');
      assert.match(await s.page.locator('.app-solitaire .sol-stats-grid').innerText(), /Games played\s+3/);
      await s.page.click('.app-solitaire .dialog-footer .btn:has-text("Reset statistics")');
      await s.page.waitForSelector('.app-solitaire .dialog-title:has-text("Reset statistics")');
      await s.page.waitForTimeout(250);
      await s.page.click('.app-solitaire .dialog-layer:last-of-type .dialog-footer .btn.primary');
      await s.page.waitForTimeout(400);
      assert.equal((await T('stats')).draw1.played, 0);
      await s.page.waitForSelector('.app-solitaire .sol-stats-grid');
      assert.match(await s.page.locator('.app-solitaire .sol-stats-grid').innerText(), /Games played\s+0/);
      await s.page.keyboard.press('Escape');
      await s.page.waitForTimeout(300);
    });

    await test('animations off: instant deal and the win dialog right away', async () => {
      await s.page.evaluate(() => window.__aurora.settings.set('animations', false));
      await s.page.waitForTimeout(200);
      await T('deal', 5, { animate: true, draw: 1, scoring: 'standard' });
      assert.equal(await T('busy'), false, 'no deal animation');
      await T('load', NEAR_WIN);
      await s.page.locator('.app-solitaire .sol-table').focus();
      await s.page.keyboard.press('a');
      await s.page.waitForSelector('.app-solitaire .dialog-title:has-text("You won")', { timeout: 3000 });
      assert.equal(await T('cascading'), false);
      await s.page.click('.app-solitaire .dialog-footer .btn:not(.primary)'); // Close
      await s.page.waitForTimeout(300);
      assert.equal((await T('state')).won, true);
      await s.page.evaluate(() => window.__aurora.settings.set('animations', true));
    });

    await test('resume: closing and reopening restores the game and its undo history', async () => {
      await T('deal', 31337, { draw: 1, scoring: 'standard' });
      const played = await T('autoplay', 6);
      const before = await T('state');
      await win('close');
      // the window's close animation and the save can take longer on a loaded machine: poll instead of a fixed wait
      for (let i = 0; i < 40 && (await s.page.locator('.app-solitaire').count()); i++) await s.page.waitForTimeout(100);
      assert.equal(await s.page.locator('.app-solitaire').count(), 0);
      await s.page.evaluate(() => window.__aurora.registry.launch('solitaire'));
      await s.page.waitForSelector('.app-solitaire .sol-card');
      await s.page.waitForTimeout(400);
      const after = await T('state');
      assert.equal(after.seed, 31337);
      assert.deepEqual(after.t, before.t);
      assert.equal(after.moves, before.moves);
      assert.equal(await T('history'), played);
      assert.equal(await T('busy'), false, 'a resumed game is not re-dealt');
    });

    // One card left: K♠ goes home and wins.
    const LAST_CARD = {
      f: [
        ['AS', '2S', '3S', '4S', '5S', '6S', '7S', '8S', '9S', '10S', 'JS', 'QS'],
        ['AH', '2H', '3H', '4H', '5H', '6H', '7H', '8H', '9H', '10H', 'JH', 'QH', 'KH'],
        ['AD', '2D', '3D', '4D', '5D', '6D', '7D', '8D', '9D', '10D', 'JD', 'QD', 'KD'],
        ['AC', '2C', '3C', '4C', '5C', '6C', '7C', '8C', '9C', '10C', 'JC', 'QC', 'KC'],
      ],
      t: [['KS'], [], [], [], [], [], []],
      stock: [],
      moves: 40,
    };
    const wins = async () => (await T('stats')).draw1.won;

    await test('win: the win counts even when F2 follows the winning move at once', async () => {
      const before = await wins();
      await T('load', LAST_CARD);
      await s.page.waitForTimeout(150);
      const k = await center('KS');
      await s.page.mouse.click(k.x, k.y);
      await s.page.keyboard.press('F2');
      await s.page.waitForTimeout(900);
      await idle();
      assert.equal(await wins(), before + 1);
      const st = await T('state');
      assert.equal(st.moves, 0, 'a new game was dealt');
      assert.equal(await T('cascading'), false, 'no cascade for the abandoned celebration');
      assert.equal(await s.page.locator('.app-solitaire .dialog').count(), 0, 'no stray win dialog');
    });

    await test('win: the win counts even when the window closes right after the winning move', async () => {
      const before = await wins();
      await T('load', LAST_CARD);
      await s.page.waitForTimeout(150);
      const k = await center('KS');
      await s.page.mouse.click(k.x, k.y);
      await win('close');
      for (let i = 0; i < 40 && (await s.page.locator('.app-solitaire').count()); i++) await s.page.waitForTimeout(100);
      await s.page.evaluate(() => window.__aurora.registry.launch('solitaire'));
      await s.page.waitForSelector('.app-solitaire .sol-card');
      await s.page.waitForTimeout(500);
      await idle();
      assert.equal(await wins(), before + 1, 'saved to disk');
      const st = await T('state');
      assert.equal(st.won, false, 'the won game is not resumed');
      assert.equal(st.moves, 0);
    });

    await test('auto-complete waits while a dialog is open, then finishes and celebrates', async () => {
      await T('load', NEAR_WIN);
      await s.page.waitForTimeout(200);
      await s.page.click('.app-solitaire .sol-auto');
      await s.page.click('.app-solitaire .sol-toolbar button[aria-label="How to play"]');
      await s.page.waitForSelector('.app-solitaire .sol-help');
      await s.page.waitForTimeout(1200);
      const mid = await T('state');
      assert.equal(mid.won, false, 'paused under the dialog');
      assert.ok(mid.f.flat().length < 50, `only the first card flew (${mid.f.flat().length} home)`);
      await s.page.keyboard.press('Escape');
      for (let i = 0; i < 40 && !(await T('state')).won; i++) await s.page.waitForTimeout(100);
      assert.equal((await T('state')).won, true);
      for (let i = 0; i < 30 && !(await T('cascading')); i++) await s.page.waitForTimeout(100);
      await T('stopCascade');
      await s.page.waitForSelector('.app-solitaire .dialog-title:has-text("You won")', { timeout: 5000 });
      await s.page.click('.app-solitaire .dialog-footer .btn.primary');
      await s.page.waitForTimeout(300);
      await idle();
    });

    await test('layout: minimum size keeps every pile and the toolbar inside the window', async () => {
      await win('setSize', 600, 480);
      await s.page.waitForTimeout(400);
      const r = await s.page.evaluate(() => {
        const root = document.querySelector('.app-solitaire');
        const table = root.querySelector('.sol-table').getBoundingClientRect();
        const tb = root.querySelector('.sol-toolbar');
        const cards = [...root.querySelectorAll('.sol-card')].map((c) => c.getBoundingClientRect());
        return {
          overflow: tb.scrollWidth - tb.clientWidth,
          right: Math.max(...cards.map((c) => c.right)) - table.right,
          left: table.left - Math.min(...cards.map((c) => c.left)),
          bottom: Math.max(...cards.map((c) => c.bottom)) - table.bottom,
        };
      });
      assert.ok(r.overflow <= 0, `toolbar overflows by ${r.overflow}px`);
      assert.ok(r.right <= 0 && r.left <= 0 && r.bottom <= 0, JSON.stringify(r));
    });
    await s.page.mouse.move(5, 5);
    publish(await winShot(s, 'solitaire-small'), 'solitaire-small');

    await test('layout: at the minimum size every dialog stays inside the window', async () => {
      const inside = () =>
        s.page.evaluate(() => {
          const w = document.querySelector('.app-solitaire').getBoundingClientRect();
          const d = document.querySelector('.app-solitaire .dialog:not(.closing)').getBoundingClientRect();
          const body = document.querySelector('.app-solitaire .dialog .dialog-body');
          return { ok: d.left >= w.left && d.right <= w.right && d.top >= w.top && d.bottom <= w.bottom, d: [d.left, d.right, d.top, d.bottom], w: [w.left, w.right, w.top, w.bottom], hscroll: body.scrollWidth - body.clientWidth, vscroll: body.scrollHeight - body.clientHeight };
        });
      const dialogs = [
        ['Settings', '.sol-settings'],
        ['Statistics', '.sol-stats-grid'],
        ['How to play', '.sol-help'],
      ];
      for (const [label, sel] of dialogs) {
        await s.page.click(`.app-solitaire .sol-toolbar button[aria-label="${label}"]`);
        await s.page.waitForSelector(`.app-solitaire ${sel}`);
        await s.page.waitForTimeout(350);
        const r = await inside();
        assert.ok(r.ok, `${label} dialog leaves the window: ${JSON.stringify(r)}`);
        assert.ok(r.hscroll <= 0, `${label} dialog scrolls sideways`);
        if (label === 'Statistics') assert.ok(r.vscroll <= 0, `statistics need no scrolling (${r.vscroll}px)`);
        if (label === 'Settings') publish(await winShot(s, 'solitaire-settings-small'), 'solitaire-settings-small');
        await s.page.keyboard.press('Escape');
        await s.page.waitForTimeout(300);
      }
    });

    await test('no renderer errors, no missing solitaire resources', async () => {
      const errs = solErrors(s);
      assert.equal(errs.length, 0, errs.join('\n'));
      const bad = await s.page.evaluate(() =>
        performance.getEntriesByType('resource').filter((e) => e.name.includes('/apps/solitaire/') && e.responseStatus >= 400).map((e) => e.name),
      );
      assert.deepEqual(bad, []);
    });
  } finally {
    await s.close();
  }

  // Dark + French, maximized at 1920x1080.
  console.log('UI (Electron, fr / dark, 1920x1080 maximized)');
  const d = await launchShell({ open: ['solitaire'], lang: 'fr', theme: 'dark', size: '1920x1080' });
  const H2 = helpers(d);
  try {
    await d.page.waitForSelector('.app-solitaire .sol-card', { timeout: 20000 });
    await H2.win('maximize');
    await d.page.waitForTimeout(500);
    await H2.idle();
    await test('fr: labels, card names and toolbar are translated', async () => {
      await H2.T('deal', 7, { draw: 1 });
      await H2.T('autoplay', 24);
      await H2.T('setElapsed', 212000);
      await d.page.waitForTimeout(300);
      assert.equal(await d.page.locator('.app-solitaire .sol-split-main').getAttribute('aria-label'), 'Nouvelle partie');
      const labels = await d.page.locator('.app-solitaire .sol-card:not(.down)').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
      assert.ok(labels.every((l) => /^(As|[2-9]|10|Valet|Dame|Roi) de (pique|cœur|carreau|trèfle)$/.test(l)), labels.join(', '));
      assert.match(await d.page.locator('.app-solitaire .sol-gameno').textContent(), /^Partie n° 7$/);
      const L = await H2.T('layout');
      assert.ok(L.cw >= 130, `cards scale up when maximized (cw=${L.cw})`);
    });
    await d.page.mouse.move(5, 5);
    publish(await d.shot('solitaire-dark-fr-1920'), 'solitaire-dark-fr-1920');
    await test('fr: help dialog, with French key names', async () => {
      await d.page.click('.app-solitaire .sol-toolbar button[aria-label="Comment jouer"]');
      await d.page.waitForSelector('.app-solitaire .sol-help');
      await d.page.waitForTimeout(450); // let the dialog finish fading in before the screenshot
      const keys = await d.page.locator('.app-solitaire .sol-keys kbd').allTextContents();
      for (const k of ['Maj+F2', 'Ctrl+Z', 'Maj+Entrée', 'Échap', 'Entrée / Espace']) assert.ok(keys.includes(k), `${k} in ${keys.join(', ')}`);
      assert.ok(!keys.some((k) => /Shift|Esc$|Enter/.test(k)), keys.join(', '));
      publish(await d.shot('solitaire-help-fr'), 'solitaire-help-fr');
      await d.page.keyboard.press('Escape');
      await d.page.waitForTimeout(300);
      await d.page.click('.app-solitaire .sol-split-more');
      await d.page.waitForSelector('.menu .menu-item');
      assert.ok((await d.page.locator('.menu').innerText()).includes('Maj+F2'), 'restart shortcut in the menu');
      await d.page.keyboard.press('Escape');
    });
    await test('fr/dark: win cascade and dialog', async () => {
      await H2.T('load', NEAR_WIN);
      await H2.T('setElapsed', 140000);
      await d.page.waitForTimeout(200);
      await d.page.click('.app-solitaire .sol-auto');
      for (let i = 0; i < 60 && !(await H2.T('cascading')); i++) await d.page.waitForTimeout(100);
      await d.page.waitForTimeout(3500);
      publish(await d.shot('solitaire-win-cascade-dark'), 'solitaire-win-cascade-dark');
      await d.page.keyboard.press('Space');
      await d.page.waitForSelector('.app-solitaire .dialog-title:has-text("Vous avez gagné")', { timeout: 5000 });
      await d.page.waitForTimeout(400);
      publish(await d.shot('solitaire-win-dialog-dark-fr'), 'solitaire-win-dialog-dark-fr');
      await d.page.click('.app-solitaire .dialog-footer .btn:not(.primary)');
      await d.page.waitForTimeout(300);
    });

    await test('fr/dark: no renderer errors', async () => {
      const errs = solErrors(d);
      assert.equal(errs.length, 0, errs.join('\n'));
    });
  } finally {
    await d.close();
  }

  // 1280x720 maximized, aurora table.
  console.log('UI (Electron, en / light, 1280x720 maximized)');
  const m = await launchShell({ open: ['solitaire'], lang: 'en', theme: 'light', size: '1280x720' });
  const H3 = helpers(m);
  try {
    await m.page.waitForSelector('.app-solitaire .sol-card', { timeout: 20000 });
    await H3.win('maximize');
    await m.page.waitForTimeout(500);
    await H3.idle();
    await test('1280x720: the longest possible column fits, every rank index stays readable', async () => {
      await H3.T('setPrefs', { table: 'aurora', back: 'midnight' });
      const normal = (await H3.T('layout')).cw;
      // 6 face-down cards + a full King-to-Ace run in the last column.
      await H3.T('load', {
        t: [[], [], [], [], [], [], ['2S', '3S', '4S', '5S', '6S', '7S', 'KH', 'QC', 'JD', '10S', '9H', '8C', '7D', '6C', '5H', '4C', '3H', '2C', 'AH']],
        hidden: [0, 0, 0, 0, 0, 0, 6],
      });
      await m.page.waitForTimeout(500);
      const L = await H3.T('layout');
      assert.ok(L.cw < normal, `cards shrink for a very long column (${normal} -> ${L.cw})`);
      const r = await m.page.evaluate(() => {
        const root = document.querySelector('.app-solitaire');
        const footer = root.querySelector('.sol-footer').getBoundingClientRect();
        const run = ['KH', 'QC', 'JD', '10S', '9H', '8C', '7D', '6C', '5H', '4C', '3H', '2C', 'AH'].map((c) => root.querySelector(`.sol-card[data-code="${c}"]`).getBoundingClientRect());
        return { bottom: run[run.length - 1].bottom, footerTop: footer.top, gaps: run.slice(1).map((b, i) => b.top - run[i].top), ch: run[0].height };
      });
      assert.ok(r.bottom <= r.footerTop, `column runs into the footer: ${JSON.stringify(r)}`);
      // The rank index ends at 58/350 of the card height: each face-up card must show at least that much.
      assert.ok(Math.min(...r.gaps) >= r.ch * 0.166, `face-up cards overlap their rank index: ${JSON.stringify(r.gaps)} (card ${r.ch}px)`);
      // Back to an ordinary deal: full-size cards again.
      await H3.T('deal', 3, { draw: 1 });
      await m.page.waitForTimeout(400);
      assert.equal((await H3.T('layout')).cw, normal);
      await H3.T('load', {
        t: [[], [], [], [], [], [], ['2S', '3S', '4S', '5S', '6S', '7S', 'KH', 'QC', 'JD', '10S', '9H', '8C', '7D', '6C', '5H', '4C', '3H', '2C', 'AH']],
        hidden: [0, 0, 0, 0, 0, 0, 6],
      });
      await m.page.waitForTimeout(400);
    });
    await m.page.mouse.move(5, 5);
    publish(await m.shot('solitaire-1280-aurora'), 'solitaire-1280-aurora');
    await test('1280x720: no renderer errors', async () => {
      const errs = solErrors(m);
      assert.equal(errs.length, 0, errs.join('\n'));
    });
  } finally {
    await m.close();
  }

  // Saved data edited by hand / corrupted on disk, then 15 open/close cycles.
  console.log('UI (Electron, tampered saved data + open/close cycles)');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-home-'));
  const store = path.join(home, '.config', 'aurora', 'apps', 'solitaire');
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(path.join(store, 'prefs.json'), JSON.stringify({ draw: 'x', scoring: '<img src=x onerror=alert(1)>', bank: 'abc', back: 5, table: { a: 1 }, timed: 'yes', clickMove: 0, sound: 'no' }));
  fs.writeFileSync(path.join(store, 'stats.json'), JSON.stringify({ draw1: { played: 'lots', won: 4, bestTime: -5, streak: 'x' }, draw3: 7, draw7: { played: 1 } }));
  const tampered = Klondike.deal(77).toJSON();
  Object.assign(tampered.state, { seed: 'abc', draw: 7, scoring: 'evil', timed: 'x', score: 'NaN', moves: -3, recycles: 'z', elapsed: 'later', fan: 'q' });
  tampered.history = [1, 'x', null];
  fs.writeFileSync(path.join(store, 'game.json'), JSON.stringify(tampered));
  const c = await launchShell({ open: ['solitaire'], lang: 'en', theme: 'light', home });
  const H4 = helpers(c);
  try {
    await c.page.waitForSelector('.app-solitaire .sol-card', { timeout: 20000 });
    await c.page.waitForTimeout(600);
    await test('tampered saved data: the app opens with sane values, nothing injected', async () => {
      const ui = await c.page.evaluate(() => ({
        toolbar: document.querySelector('.app-solitaire .sol-stats').innerText.replace(/\s+/g, ' '),
        footer: document.querySelector('.app-solitaire .sol-footer').innerText.replace(/\s+/g, ' '),
        imgs: document.querySelectorAll('.app-solitaire .sol-toolbar img, .app-solitaire .sol-footer img').length,
      }));
      assert.equal(ui.toolbar, 'Score 0 Time 0:00 Moves 0');
      assert.equal(ui.footer, 'Game #1 Draw 1 · Standard scoring');
      assert.equal(ui.imgs, 0);
      assert.deepEqual(await H4.T('prefs'), { draw: 1, scoring: 'standard', timed: true, cumulative: false, bank: 0, back: 'aurora', table: 'aurora', clickMove: true, sound: true });
      const st = await H4.T('state');
      assert.deepEqual(st.t, Klondike.deal(77).s.t, 'the cards of the saved game are kept');
      assert.equal(await H4.T('history'), 0, 'corrupt undo steps dropped');
      const stats = await H4.T('stats');
      assert.deepEqual(Object.keys(stats).sort(), ['draw1', 'draw3']);
      assert.equal(stats.draw1.played, 0);
      assert.equal(stats.draw1.won, 0, 'never more wins than games');
      await c.page.click('.app-solitaire .sol-tb-btn[aria-label="Statistics"]');
      await c.page.waitForSelector('.app-solitaire .sol-stats-grid');
      assert.ok(!/NaN|undefined/.test(await c.page.locator('.app-solitaire .sol-stats-grid').innerText()));
      await c.page.keyboard.press('Escape');
      await c.page.waitForTimeout(300);
    });

    await test('open / close 15 times: no leaked listeners, timers or windows', async () => {
      await H4.win('close');
      await c.page.waitForTimeout(500);
      await c.page.evaluate(() => {
        const a = window.__aurora;
        const probe = (window.__solProbe = { subs: 0, intervals: new Set(), audio: 0, audioClosed: 0 });
        const on = a.settings.on.bind(a.settings);
        a.settings.on = (k, fn) => {
          probe.subs++;
          const off = on(k, fn);
          return () => {
            probe.subs--;
            return off();
          };
        };
        const si = window.setInterval.bind(window);
        const ci = window.clearInterval.bind(window);
        window.setInterval = (...x) => {
          const id = si(...x);
          probe.intervals.add(id);
          return id;
        };
        window.clearInterval = (id) => {
          probe.intervals.delete(id);
          return ci(id);
        };
        const AC = window.AudioContext;
        window.AudioContext = class extends AC {
          constructor(...x) {
            super(...x);
            probe.audio++;
          }
          close() {
            probe.audioClosed++;
            return super.close();
          }
        };
      });
      const dom0 = await c.page.evaluate(() => document.querySelectorAll('*').length);
      // (Relaunching while the previous window is still in its close animation would just focus that
      // dying window — a shell-level race — so each cycle waits for the window to be gone.)
      const gone = () => c.page.waitForFunction(() => !window.__aurora.wm.byApp('solitaire').length, null, { timeout: 5000 });
      await gone();
      for (let i = 0; i < 15; i++) {
        await c.page.evaluate(() => window.__aurora.registry.launch('solitaire'));
        await c.page.waitForFunction(() => {
          const w = window.__aurora.wm.byApp('solitaire')[0];
          return !!(w && window.__aurora.registry.instance(w.id)?.hooks?.test);
        });
        await c.page.waitForTimeout(150);
        const st = await H4.T('pileRect', 'stock');
        await c.page.mouse.click(st.x + 20, st.y + 20); // makes a sound -> AudioContext
        await H4.win('close');
        await gone();
      }
      const r = await c.page.evaluate(() => ({ ...window.__solProbe, intervals: window.__solProbe.intervals.size, wins: window.__aurora.wm.byApp('solitaire').length, dom: document.querySelectorAll('*').length, css: document.querySelectorAll('link[href*="apps/solitaire"]').length }));
      assert.equal(r.wins, 0);
      assert.equal(r.subs, 0, 'settings subscriptions released');
      assert.equal(r.intervals, 0, 'clock intervals cleared');
      assert.equal(r.audio, r.audioClosed, 'every AudioContext closed');
      assert.equal(r.css, 1, 'stylesheet injected once');
      assert.ok(r.dom - dom0 < 20, `DOM grew by ${r.dom - dom0} nodes`);
    });

    await test('tampered data / cycles: no renderer errors', async () => {
      const errs = solErrors(c);
      assert.equal(errs.length, 0, errs.join('\n'));
    });
  } finally {
    await c.close();
    fs.rmSync(home, { recursive: true, force: true });
  }

  // Saving fails (the storage folder is a file): one clear, translated error, the game goes on.
  console.log('UI (Electron, fr, storage not writable)');
  const home2 = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-home-'));
  fs.mkdirSync(path.join(home2, '.config', 'aurora', 'apps'), { recursive: true });
  fs.writeFileSync(path.join(home2, '.config', 'aurora', 'apps', 'solitaire'), 'not a folder');
  const f = await launchShell({ open: ['solitaire'], lang: 'fr', theme: 'dark', home: home2 });
  const H5 = helpers(f);
  try {
    await f.page.waitForSelector('.app-solitaire .sol-card', { timeout: 20000 });
    await test('save failure: a single translated error, then the game keeps working', async () => {
      await f.page.waitForSelector('.app-solitaire .dialog', { timeout: 5000 });
      await f.page.waitForTimeout(400);
      const txt = await f.page.locator('.app-solitaire .dialog').innerText();
      assert.match(txt, /Impossible d'enregistrer la partie/);
      await f.page.click('.app-solitaire .dialog-footer .btn.primary');
      await f.page.waitForTimeout(300);
      await H5.idle();
      const st = await H5.T('pileRect', 'stock');
      await f.page.mouse.click(st.x + 20, st.y + 20);
      await f.page.waitForTimeout(1200); // past the save debounce
      assert.equal((await H5.T('state')).moves, 1);
      assert.equal(await f.page.locator('.app-solitaire .dialog').count(), 0, 'not shown again');
    });
  } finally {
    await f.close();
    fs.rmSync(home2, { recursive: true, force: true });
  }
}

if (!UI_ONLY) await unitTests();
if (!UNIT_ONLY) await uiTests();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
