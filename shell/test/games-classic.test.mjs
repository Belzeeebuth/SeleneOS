// Classic games: Minesweeper, Snake, 2048.
//   1. Unit tests of the pure game logic (imported straight from the app folders).
//   2. UI tests that drive the real shell with Playwright (mouse, keyboard, menus, dialogs,
//      light/dark, English/French, min-size and maximized windows) + documentation screenshots.
// Usage:  cd aurora-os/shell && xvfb-run -a -s "-screen 0 1600x900x24" node test/games-classic.test.mjs [--unit] [--only=minesweeper,snake,game2048]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const APPS = path.join(here, '..', 'renderer', 'apps');
const SHOTS = path.join(here, '..', '..', 'docs', 'screenshots');
const imp = (rel) => import(pathToFileURL(path.join(APPS, rel)).href);

const argv = process.argv.slice(2);
const UNIT_ONLY = argv.includes('--unit');
const ONLY = (argv.find((a) => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean);
const want = (id) => !ONLY.length || ONLY.includes(id);

const results = [];
async function test(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name} (${Date.now() - t0} ms)`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`  ✗ ${name}\n    ${String(err?.stack || err).split('\n').slice(0, 6).join('\n    ')}`);
  }
}

// =====================================================================================
// 1. Unit tests
// =====================================================================================
const MS = await imp('minesweeper/logic.mjs');
const SN = await imp('snake/logic.mjs');
const T48 = await imp('game2048/logic.mjs');

console.log('Minesweeper logic');
await test('difficulties match the classic boards', () => {
  assert.deepEqual(MS.DIFFICULTIES.beginner, { cols: 9, rows: 9, mines: 10 });
  assert.deepEqual(MS.DIFFICULTIES.intermediate, { cols: 16, rows: 16, mines: 40 });
  assert.deepEqual(MS.DIFFICULTIES.expert, { cols: 30, rows: 16, mines: 99 });
});
await test('first click is always safe and opens an area (500 random games)', () => {
  for (let seed = 1; seed <= 500; seed++) {
    const d = Object.values(MS.DIFFICULTIES)[seed % 3];
    const g = new MS.Minesweeper({ ...d, rng: MS.seededRng(seed) });
    const click = (seed * 7919) % g.total;
    const r = g.reveal(click);
    assert.equal(r.exploded, null, `seed ${seed}`);
    assert.notEqual(g.status, 'lost');
    assert.equal(g.cells[click].mine, false);
    assert.equal(g.cells[click].adj, 0, 'clicked cell is a zero, so it opens an area');
    for (const n of g.neighbors(click)) assert.equal(g.cells[n].mine, false);
    assert.equal(g.cells.filter((c) => c.mine).length, d.mines);
    assert.ok(r.revealed.length >= g.neighbors(click).length + 1);
  }
});
await test('dense board keeps the mine count and only the clicked cell safe', () => {
  const g = new MS.Minesweeper({ cols: 5, rows: 5, mines: 20, rng: MS.seededRng(3) });
  g.reveal(12);
  assert.equal(g.cells.filter((c) => c.mine).length, 20);
  assert.equal(g.cells[12].mine, false);
  assert.equal(g.status, 'playing');
});
await test('flood fill reveals the zero region and its numbered border, in BFS depth order', () => {
  // 6x5 board, mines in the right column: cols 0..3 open up, col 4 shows numbers.
  const g = new MS.Minesweeper({ cols: 6, rows: 5, mines: 5 });
  g.placeMines(0, [5, 11, 17, 23, 29]);
  const r = g.reveal(0);
  const opened = new Set(r.revealed.map((x) => x.i));
  for (let y = 0; y < 5; y++)
    for (let x = 0; x < 5; x++) assert.ok(opened.has(g.index(x, y)), `(${x},${y}) revealed`);
  for (let y = 0; y < 5; y++) assert.ok(!opened.has(g.index(5, y)), 'mines stay hidden');
  assert.equal(g.cells[g.index(4, 2)].adj, 3);
  for (let k = 1; k < r.revealed.length; k++) assert.ok(r.revealed[k].d >= r.revealed[k - 1].d, 'depth is non-decreasing');
  assert.equal(r.won, true, 'every safe cell revealed -> win');
  assert.equal(g.status, 'won');
  assert.equal(g.flagCount, 5, 'mines are auto-flagged on win');
});
await test('flood fill stops at flags; flagged cells cannot be revealed', () => {
  const g = new MS.Minesweeper({ cols: 6, rows: 5, mines: 1 });
  g.placeMines(0, [29]);
  g.toggleMark(g.index(2, 2));
  const r = g.reveal(0);
  assert.ok(!r.revealed.some((x) => x.i === g.index(2, 2)));
  assert.equal(g.cells[g.index(2, 2)].state, 'flag');
  assert.equal(g.reveal(g.index(2, 2)).revealed.length, 0);
});
await test('right-click cycle: flag -> question -> none (and without question marks)', () => {
  const g = new MS.Minesweeper({ cols: 9, rows: 9, mines: 10 });
  assert.equal(g.toggleMark(4, true), 'flag');
  assert.equal(g.minesLeft, 9);
  assert.equal(g.toggleMark(4, true), 'question');
  assert.equal(g.minesLeft, 10);
  assert.equal(g.toggleMark(4, true), 'none');
  assert.equal(g.toggleMark(4, false), 'flag');
  assert.equal(g.toggleMark(4, false), 'none');
});
await test('chording reveals neighbours when flags match, explodes on a wrong flag', () => {
  // Mines at (0,0) and (0,2) on a 4x4 board; clicking (3,3) opens everything but column 0.
  const mk = () => {
    const g = new MS.Minesweeper({ cols: 4, rows: 4, mines: 2 });
    g.placeMines(15, [g.index(0, 0), g.index(0, 2)]);
    return g;
  };
  let g = mk();
  g.reveal(g.index(3, 3));
  const num = g.index(1, 1); // touches both mines
  assert.equal(g.cells[num].state, 'revealed');
  assert.equal(g.cells[num].adj, 2);
  assert.equal(g.chord(num).revealed.length, 0, 'not enough flags -> nothing');
  g.toggleMark(g.index(0, 0));
  g.toggleMark(g.index(0, 2));
  const r = g.chord(num);
  assert.deepEqual(r.revealed.map((x) => x.i), [g.index(0, 1)]);
  assert.equal(r.exploded, null);
  assert.equal(g.status, 'playing');
  assert.equal(g.reveal(g.index(0, 3)).won, true, 'last safe cell wins');
  // Wrong flag: flag (0,1) instead of (0,2) -> chord hits the mine.
  g = mk();
  g.reveal(g.index(3, 3));
  g.toggleMark(g.index(0, 0));
  g.toggleMark(g.index(0, 1));
  const bad = g.chord(num);
  assert.equal(bad.exploded, g.index(0, 2));
  assert.equal(g.status, 'lost');
  assert.deepEqual(g.lossReport().wrongFlags, [g.index(0, 1)]);
});
await test('custom board validation', () => {
  assert.equal(MS.validateCustom({ cols: 20, rows: 12, mines: 45 }), null);
  assert.equal(MS.validateCustom({ cols: 4, rows: 12, mines: 10 }).field, 'cols');
  assert.equal(MS.validateCustom({ cols: 10, rows: 99, mines: 10 }).field, 'rows');
  assert.equal(MS.validateCustom({ cols: 10, rows: 10, mines: 92 }).field, 'mines');
  assert.equal(MS.validateCustom({ cols: 10, rows: 10, mines: 91 }), null);
  assert.equal(MS.validateCustom({ cols: 10.5, rows: 10, mines: 5 }).field, 'cols');
});
await test('statistics: streaks and best times', () => {
  let s = MS.emptyStats();
  ({ stats: s } = MS.recordGame(s, { won: true, ms: 50000, date: 1 }));
  ({ stats: s } = MS.recordGame(s, { won: true, ms: 30000, date: 2 }));
  const { stats: s3, rank } = MS.recordGame(s, { won: true, ms: 20000, date: 3 });
  assert.equal(rank, 0);
  assert.deepEqual(s3.bestTimes.map((b) => b.ms), [20000, 30000, 50000]);
  assert.equal(s3.currentStreak, 3);
  const { stats: s4 } = MS.recordGame(s3, { won: false, ms: 1000 });
  assert.equal(s4.currentStreak, 0);
  assert.equal(s4.longestStreak, 3);
  assert.equal(MS.winRate(s4), 75);
});

console.log('Snake logic');
const snakeAt = (g, cells, dir) => {
  g.snake = cells.map(([x, y]) => ({ x, y }));
  g.dir = dir;
  g.queue = [];
  g.food = { x: g.cols - 1, y: g.rows - 1 };
};
await test('new game: snake of 4 heading right, food on a free cell', () => {
  const g = SN.createGame({ cols: 22, rows: 16, rng: SN.seededRng(1) });
  assert.equal(g.snake.length, 4);
  assert.equal(g.dir, 'right');
  assert.ok(!g.snake.some((s) => s.x === g.food.x && s.y === g.food.y));
});
await test('movement: head advances, tail follows, length constant', () => {
  const g = SN.createGame({ cols: 10, rows: 10 });
  snakeAt(g, [[5, 5], [4, 5], [3, 5]], 'right');
  const ev = SN.step(g);
  assert.ok(ev.moved);
  assert.deepEqual(g.snake, [{ x: 6, y: 5 }, { x: 5, y: 5 }, { x: 4, y: 5 }]);
  assert.deepEqual(g.prevTail, { x: 3, y: 5 });
});
await test('no 180° reversal, even through the input buffer', () => {
  const g = SN.createGame({ cols: 10, rows: 10 });
  snakeAt(g, [[5, 5], [4, 5], [3, 5]], 'right');
  assert.equal(SN.queueTurn(g, 'left'), false);
  assert.equal(SN.queueTurn(g, 'right'), false, 'same direction ignored');
  assert.equal(SN.queueTurn(g, 'up'), true);
  assert.equal(SN.queueTurn(g, 'down'), false, 'reverse of the last buffered turn');
  assert.equal(SN.queueTurn(g, 'left'), true);
  assert.equal(SN.queueTurn(g, 'down'), true);
  assert.equal(SN.queueTurn(g, 'right'), false, 'buffer is capped at 3');
});
await test('quick turns are buffered: up+left within one tick never self-collide', () => {
  const g = SN.createGame({ cols: 10, rows: 10 });
  snakeAt(g, [[5, 5], [4, 5], [3, 5], [2, 5]], 'right');
  SN.queueTurn(g, 'up');
  SN.queueTurn(g, 'left');
  let ev = SN.step(g);
  assert.deepEqual(g.snake[0], { x: 5, y: 4 });
  ev = SN.step(g);
  assert.equal(ev.died, false);
  assert.deepEqual(g.snake[0], { x: 4, y: 4 });
  assert.equal(g.dir, 'left');
});
await test('walls kill, wrap-around wraps', () => {
  const g = SN.createGame({ cols: 8, rows: 6 });
  snakeAt(g, [[7, 2], [6, 2], [5, 2]], 'right');
  const ev = SN.step(g);
  assert.equal(ev.died, true);
  assert.equal(ev.reason, 'wall');
  const w = SN.createGame({ cols: 8, rows: 6, wrap: true });
  snakeAt(w, [[7, 2], [6, 2], [5, 2]], 'right');
  assert.equal(SN.step(w).died, false);
  assert.deepEqual(w.snake[0], { x: 0, y: 2 });
  snakeAt(w, [[3, 0], [3, 1], [3, 2]], 'up');
  SN.step(w);
  assert.deepEqual(w.snake[0], { x: 3, y: 5 });
});
await test('self collision, but moving into the vacating tail is allowed', () => {
  const g = SN.createGame({ cols: 10, rows: 10 });
  // A 2x2 loop: head (4,4) moving down into (4,5) which is the tail -> allowed.
  snakeAt(g, [[4, 4], [5, 4], [5, 5], [4, 5]], 'down');
  assert.equal(SN.step(g).died, false);
  snakeAt(g, [[4, 4], [5, 4], [5, 5], [4, 5], [3, 5]], 'down');
  const ev = SN.step(g);
  assert.equal(ev.died, true);
  assert.equal(ev.reason, 'self');
});
await test('eating scores by speed and grows by one', () => {
  const g = SN.createGame({ cols: 10, rows: 10, speed: 'fast', rng: SN.seededRng(9) });
  snakeAt(g, [[5, 5], [4, 5], [3, 5]], 'right');
  g.food = { x: 6, y: 5 };
  const ev = SN.step(g);
  assert.equal(ev.ate, true);
  assert.equal(g.score, SN.SPEEDS.fast.points);
  assert.equal(g.snake.length, 3);
  SN.step(g);
  assert.equal(g.snake.length, 4, 'grows on the following step');
  assert.ok(g.food && !g.snake.some((s) => s.x === g.food.x && s.y === g.food.y));
});
await test('obstacles: board stays connected, start lane clear, obstacles kill', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const g = SN.createGame({ cols: 22, rows: 16, obstacles: true, rng: SN.seededRng(seed), wrap: seed % 2 === 0 });
    assert.ok(g.obstacles.length > 0);
    assert.ok(SN.freeCellsConnected(g, g.obstacleSet));
    const hy = g.snake[0].y;
    assert.ok(!g.obstacles.some((o) => Math.abs(o.y - hy) <= 1), 'start lane clear');
    assert.ok(!g.obstacles.some((o) => o.x === g.food.x && o.y === g.food.y));
  }
  const g = SN.createGame({ cols: 10, rows: 10 });
  snakeAt(g, [[5, 5], [4, 5], [3, 5]], 'right');
  g.obstacleSet = new Set(['6,5']);
  assert.equal(SN.step(g).reason, 'obstacle');
});
await test('filling the board wins', () => {
  const g = SN.createGame({ cols: 3, rows: 1 });
  snakeAt(g, [[1, 0], [0, 0]], 'right');
  g.grow = 1; // still digesting the previous apple
  g.food = { x: 2, y: 0 };
  const ev = SN.step(g);
  assert.equal(ev.won, true);
  assert.equal(g.won, true);
});
await test('speed levels and gradual speed-up', () => {
  assert.ok(SN.stepInterval('slow') > SN.stepInterval('normal'));
  assert.ok(SN.stepInterval('normal') > SN.stepInterval('fast'));
  assert.ok(SN.stepInterval('fast') > SN.stepInterval('insane'));
  assert.equal(SN.stepInterval('normal', 10, false), SN.stepInterval('normal'));
  assert.ok(SN.stepInterval('normal', 10, true) < SN.stepInterval('normal'));
  assert.equal(SN.stepInterval('normal', 1000, true), SN.SPEEDS.normal.ms * 0.55);
  assert.equal(SN.modeKey({ wrap: true, obstacles: true }), 'wrap-obstacles');
});
await test('snake statistics: best score per mode', () => {
  let { stats, record } = SN.recordGame(SN.emptyStats(), { score: 50, eaten: 5, length: 9, ms: 1000, mode: 'walls' });
  assert.equal(record, true);
  ({ stats, record } = SN.recordGame(stats, { score: 30, eaten: 3, length: 7, ms: 1000, mode: 'walls' }));
  assert.equal(record, false);
  ({ stats } = SN.recordGame(stats, { score: 40, eaten: 4, length: 8, ms: 1000, mode: 'wrap' }));
  assert.deepEqual(stats.best, { walls: 50, wrap: 40 });
  assert.equal(stats.played, 3);
  assert.equal(stats.longest, 9);
});

console.log('2048 logic');
await test('slideLine edge cases', () => {
  const cases = [
    [[2, 2, 2, 2], [4, 4, 0, 0], 8],
    [[4, 4, 8, 0], [8, 8, 0, 0], 8],
    [[2, 0, 2, 4], [4, 4, 0, 0], 4],
    [[2, 2, 4, 8], [4, 4, 8, 0], 4],
    [[0, 0, 0, 2], [2, 0, 0, 0], 0],
    [[2, 4, 8, 16], [2, 4, 8, 16], 0],
    [[4, 0, 0, 4], [8, 0, 0, 0], 8],
    [[8, 8, 8, 0], [16, 8, 0, 0], 16],
    [[2, 2, 0, 0, 2, 2], [4, 4, 0, 0, 0, 0], 8],
  ];
  for (const [inp, out, gained] of cases) assert.deepEqual(T48.slideLine(inp), { line: out, gained }, JSON.stringify(inp));
});
await test('move in all four directions (closest-to-edge merges first)', () => {
  const g0 = [
    [2, 2, 2, 0],
    [0, 4, 0, 4],
    [2, 0, 0, 2],
    [8, 8, 8, 8],
  ];
  const run = (dir) => {
    const g = T48.fromGrid(g0);
    const r = T48.move(g, dir, Math.random, { spawn: false });
    return { grid: T48.toGrid(g), r, g };
  };
  assert.deepEqual(run('left').grid, [
    [4, 2, 0, 0],
    [8, 0, 0, 0],
    [4, 0, 0, 0],
    [16, 16, 0, 0],
  ]);
  assert.deepEqual(run('right').grid, [
    [0, 0, 2, 4],
    [0, 0, 0, 8],
    [0, 0, 0, 4],
    [0, 0, 16, 16],
  ]);
  assert.deepEqual(run('up').grid, [
    [4, 2, 2, 4],
    [8, 4, 8, 2],
    [0, 8, 0, 8],
    [0, 0, 0, 0],
  ]);
  assert.deepEqual(run('down').grid, [
    [0, 0, 0, 0],
    [0, 2, 0, 4],
    [4, 4, 2, 2],
    [8, 8, 8, 8],
  ]);
  const { r, g } = run('left');
  assert.equal(r.gained, 4 + 8 + 4 + 16 + 16);
  assert.equal(g.score, r.gained);
  assert.equal(r.merges.length, 5);
  for (const m of r.merges) assert.equal(m.from.length, 2);
  const ids = r.merges.flatMap((m) => m.from);
  assert.equal(new Set(ids).size, ids.length, 'each tile merges at most once');
});
await test('a move that changes nothing does not spawn a tile', () => {
  const g = T48.fromGrid([
    [2, 4, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);
  const r = T48.move(g, 'left');
  assert.equal(r.moved, false);
  assert.equal(g.tiles.length, 2);
  const r2 = T48.move(g, 'right', T48.seededRng(4));
  assert.equal(r2.moved, true);
  assert.equal(g.tiles.length, 3);
  assert.ok([2, 4].includes(r2.spawned.value));
  assert.equal(T48.toGrid(g)[r2.spawned.r][r2.spawned.c], r2.spawned.value);
});
await test('spawned values are ~90% twos', () => {
  const rng = T48.seededRng(7);
  let twos = 0;
  for (let i = 0; i < 2000; i++) {
    const g = T48.emptyGame(4);
    twos += T48.spawnTile(g, rng).value === 2 ? 1 : 0;
  }
  assert.ok(twos > 1700 && twos < 1900, `twos=${twos}`);
});
await test('win at 2048 and game-over detection', () => {
  const g = T48.fromGrid([
    [1024, 1024, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);
  T48.move(g, 'left', Math.random, { spawn: false });
  assert.equal(g.won, true);
  assert.equal(T48.maxTile(g), 2048);
  const full = T48.fromGrid([
    [2, 4, 2, 4],
    [4, 2, 4, 2],
    [2, 4, 2, 4],
    [4, 2, 4, 2],
  ]);
  assert.equal(T48.canMove(full), false);
  full.tiles[0].value = 4; // now (0,0)=4 next to (1,0)=4
  assert.equal(T48.canMove(full), true);
});
await test('2048 statistics: wins, streaks, best score and tile', () => {
  let s = T48.recordGame(null, { won: true, score: 20000, tile: 2048 });
  s = T48.recordGame(s, { won: true, score: 15000, tile: 2048 });
  s = T48.recordGame(s, { won: false, score: 3000, tile: 256 });
  assert.equal(s.played, 3);
  assert.equal(s.won, 2);
  assert.equal(s.longestStreak, 2);
  assert.equal(s.currentStreak, 0);
  assert.equal(s.bestScore, 20000);
  assert.equal(s.bestTile, 2048);
});

console.log('Saved data (damaged / hand-edited files)');
await test('Minesweeper: any saved JSON yields valid preferences and statistics', () => {
  const def = MS.sanitizePrefs(null);
  assert.deepEqual(def, { difficulty: 'beginner', custom: { cols: 20, rows: 12, mines: 45 }, questionMarks: true, sound: true });
  for (const bad of [undefined, 'x', 42, [], { custom: null, difficulty: 5 }, { custom: { cols: 99, rows: 5, mines: 1 } }, { questionMarks: 'yes' }]) assert.deepEqual(MS.sanitizePrefs(bad), def, JSON.stringify(bad));
  assert.deepEqual(MS.sanitizePrefs({ difficulty: 'custom', custom: { cols: 40, rows: 24, mines: 951 }, questionMarks: false, sound: false }), {
    difficulty: 'custom',
    custom: { cols: 40, rows: 24, mines: 951 },
    questionMarks: false,
    sound: false,
  });
  assert.equal(MS.validateCustom(null).field, 'cols', 'validateCustom never throws');
  const st = MS.sanitizeAllStats({
    beginner: { played: 'abc', won: null, bestTimes: 'x' },
    custom: { played: 3, won: 9, currentStreak: 7, longestStreak: -1, bestTimes: [{ ms: 'x', date: 'y' }, null, { ms: 900, date: 1e20 }, { ms: 2000, date: 1 }, { ms: 1000, date: 2 }] },
    hacker: { played: 1 },
  });
  assert.deepEqual(Object.keys(st).sort(), ['beginner', 'custom']);
  assert.deepEqual(st.beginner, MS.emptyStats());
  assert.equal(st.custom.won, 3, 'won <= played');
  assert.equal(st.custom.currentStreak, 3);
  assert.equal(st.custom.longestStreak, 3);
  assert.deepEqual(st.custom.bestTimes, [{ ms: 1000, date: 2 }, { ms: 2000, date: 1 }], 'invalid times and dates dropped, sorted');
  assert.deepEqual(MS.sanitizeAllStats('"hello"'), {});
});
await test('Snake: any saved JSON yields valid preferences and statistics', () => {
  const def = SN.sanitizePrefs([]);
  assert.deepEqual(def, { speed: 'normal', speedUp: true, wrap: false, obstacles: false, size: 'medium', sound: true });
  assert.equal(SN.sanitizePrefs({ speed: 'constructor' }).speed, 'normal', 'inherited keys are not speeds');
  assert.equal(SN.sanitizePrefs({ size: 'toString' }).size, 'medium');
  assert.deepEqual(SN.sanitizePrefs({ speed: 'insane', size: 'large', wrap: true, obstacles: true, speedUp: false, sound: false }), { speed: 'insane', speedUp: false, wrap: true, obstacles: true, size: 'large', sound: false });
  const st = SN.sanitizeStats({ best: { walls: 'big', wrap: 50, bogus: 9 }, played: 2, longest: {}, totalScore: -4, foodEaten: 3.7 });
  assert.deepEqual(st, { played: 2, foodEaten: 3, totalMs: 0, totalScore: 0, longest: 0, best: { wrap: 50 } });
  assert.deepEqual(SN.sanitizeStats(42), SN.emptyStats());
  assert.ok(Number.isFinite(SN.stepInterval(SN.sanitizePrefs({ speed: '__proto__' }).speed)));
});
await test('2048: any saved JSON yields valid preferences, statistics and game', () => {
  assert.deepEqual(T48.sanitizePrefs(true), { size: 4, undo: true, sound: true });
  assert.deepEqual(T48.sanitizePrefs({ size: '5', undo: false }), { size: 5, undo: false, sound: true });
  assert.equal(T48.sanitizePrefs({ size: 7 }).size, 4);
  const st = T48.sanitizeAllStats({ 4: { bestScore: 'lots', played: -3, bestTile: 3 }, 5: null, 6: { played: 2, won: 5, bestTile: 4096, totalScore: 1e400 }, x: {} });
  assert.deepEqual(Object.keys(st), ['4', '6']);
  assert.deepEqual(st[4], T48.emptyStats());
  assert.equal(st[6].won, 2);
  assert.equal(st[6].bestTile, 4096);
  assert.equal(st[6].totalScore, 0, 'Infinity is not a score');
  assert.deepEqual(T48.sanitizeAllStats([1, 2, 3]), {});
  // reviveGame: valid data, impossible tiles, overlapping tiles, Infinity, wrong-size undo state
  const g = T48.reviveGame({ size: 4, tiles: [{ r: 0, c: 0, value: 2 }, { r: 1, c: 1, value: 2048 }], score: 1e400, moves: 3 });
  assert.equal(g.tiles.length, 2);
  assert.equal(g.score, 0);
  assert.equal(g.won, true, 'a 2048 tile means the game is won');
  assert.equal(T48.reviveGame({ size: 4, tiles: [{ r: 0, c: 0, value: 3 }] }), null);
  assert.equal(T48.reviveGame({ size: 4, tiles: [{ r: 0, c: 0, value: 2 }, { r: 0, c: 0, value: 4 }] }), null);
  assert.equal(T48.reviveGame({ size: 4, tiles: [{ r: 4, c: 0, value: 2 }] }), null);
  assert.equal(T48.reviveGame({ size: 5, tiles: [{ r: 0, c: 0, value: 2 }] }, { size: 4 }), null, 'undo state of another size');
  assert.equal(T48.reviveGame('[]'), null);
});

console.log('App packaging');
await test('manifests, i18n (EN+FR complete), icons and shared kit copies', () => {
  const kitJs = fs.readFileSync(path.join(APPS, 'minesweeper', 'gamekit.js'), 'utf8');
  const kitCss = fs.readFileSync(path.join(APPS, 'minesweeper', 'gamekit.css'), 'utf8');
  for (const id of ['minesweeper', 'snake', 'game2048']) {
    const dir = path.join(APPS, id);
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    assert.equal(m.id, id);
    assert.equal(m.category, 'games');
    assert.ok(m.name.en && m.name.fr);
    assert.ok(m.window.minWidth >= 360 && m.window.minHeight >= 400, 'sensible minimum size');
    for (const f of [m.entry, m.icon, ...m.styles]) assert.ok(fs.existsSync(path.join(dir, f)), `${id}/${f}`);
    const i18n = JSON.parse(fs.readFileSync(path.join(dir, 'i18n.json'), 'utf8'));
    assert.deepEqual(Object.keys(i18n.en).sort(), Object.keys(i18n.fr).sort(), `${id}: EN/FR keys differ`);
    for (const [k, v] of Object.entries(i18n.fr)) assert.ok(v.trim(), `${id}: empty FR string ${k}`);
    const used = new Set();
    for (const f of ['main.js', 'gamekit.js']) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      for (const mm of src.matchAll(/\bt\(\s*'([\w.]+)'/g)) used.add(mm[1]);
    }
    for (const k of used) if (!k.startsWith('common.')) assert.ok(k in i18n.en || `${k}_other` in i18n.en, `${id}: missing string ${k}`);
    const svg = fs.readFileSync(path.join(dir, 'icon.svg'), 'utf8');
    assert.match(svg, /viewBox="0 0 48 48"/);
    assert.doesNotMatch(svg, /<text/);
    assert.equal(fs.readFileSync(path.join(dir, 'gamekit.js'), 'utf8'), kitJs, `${id}/gamekit.js drifted`);
    assert.equal(fs.readFileSync(path.join(dir, 'gamekit.css'), 'utf8').replaceAll(`.app-${id}`, '.app-minesweeper'), kitCss, `${id}/gamekit.css drifted`);
    for (const line of fs.readFileSync(path.join(dir, 'style.css'), 'utf8').split('\n')) {
      if (/^[^\s@/*}][^{]*\{\s*$/.test(line) || /^[.:#a-z][^{]*\{.*\}\s*$/i.test(line)) assert.ok(line.includes(`.app-${id}`), `${id}/style.css unscoped rule: ${line}`);
    }
  }
});

if (UNIT_ONLY) finish();

// =====================================================================================
// 2. UI tests (Playwright + Electron)
// =====================================================================================
const { launchShell } = await import('./lib.mjs');
fs.mkdirSync(SHOTS, { recursive: true });

function watchErrors(s) {
  const errs = [];
  const mine = /apps\/(minesweeper|snake|game2048)\//;
  s.page.on('console', (m) => {
    if (m.type() !== 'error' && m.type() !== 'warning') return;
    const url = m.location()?.url || '';
    if (mine.test(url) || /minesweeper|snake|game2048|gamekit/i.test(m.text())) errs.push(`[${m.type()}] ${m.text()} @ ${url}`);
  });
  s.page.on('pageerror', (e) => {
    if (mine.test(e.stack || '') || /minesweeper|snake|game2048|gamekit/i.test(e.message)) errs.push(`[pageerror] ${e.stack || e.message}`);
  });
  s.page.on('response', (r) => {
    if (r.status() >= 400 && mine.test(r.url())) errs.push(`[http ${r.status()}] ${r.url()}`);
  });
  return errs;
}

async function winShot(s, id, name) {
  const r = await s.page.evaluate((app) => {
    const w = window.__aurora.wm.byApp(app)[0];
    const b = w.el.getBoundingClientRect();
    return { x: b.left, y: b.top, width: b.width, height: b.height };
  }, id);
  const pad = 28;
  const clip = { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: Math.min(1600, r.width + 2 * pad), height: Math.min(900 - Math.max(0, r.y - pad), r.height + 2 * pad) };
  const file = path.join(SHOTS, `${name}.png`);
  await s.page.screenshot({ path: file, clip });
  return file;
}

const winOf = (id) => `[data-app="${id}"]`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Synthetic touch pointer event at a page position (xvfb has no touchscreen).
function touchAt(page, type, x, y, id = 11) {
  return page.evaluate(
    ([t, px, py, pid]) => {
      const el = document.elementFromPoint(px, py);
      el?.dispatchEvent(new PointerEvent(t, { pointerType: 'touch', pointerId: pid, isPrimary: true, clientX: px, clientY: py, bubbles: true, cancelable: true, button: t === 'pointermove' ? -1 : 0, buttons: t === 'pointerup' ? 0 : 1 }));
    },
    [type, x, y, id],
  );
}

// WCAG contrast ratio of two CSS colours (#rrggbb or rgb()/rgba() without transparency).
function contrast(a, b) {
  const rgb = (c) => {
    c = c.trim();
    if (c.startsWith('#')) return [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
    return c.match(/[\d.]+/g).slice(0, 3).map(Number);
  };
  const lum = (c) => {
    const [r, g, bl] = rgb(c).map((v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

// Every solid 2048 tile must keep large-text contrast (>= 3:1) in the current theme.
async function assertTileContrast(page) {
  const vars = await page.evaluate(() => {
    const cs = getComputedStyle(document.querySelector('[data-app="game2048"]'));
    return [2, 4, 8, 16, 32, 64, 128, 256, 512, 1024].map((v) => [v, cs.getPropertyValue(`--t${v}-bg`).trim(), cs.getPropertyValue(`--t${v}-fg`).trim()]);
  });
  for (const [v, bg, fg] of vars) assert.ok(contrast(bg, fg) >= 3, `tile ${v}: ${fg} on ${bg} = ${contrast(bg, fg).toFixed(2)}`);
}

async function waitFor(page, fn, arg, timeout = 4000) {
  await page.waitForFunction(fn, arg, { timeout, polling: 50 });
}

// Asserts that nothing in the window's chrome overflows horizontally.
async function assertNoOverflow(page, id) {
  const bad = await page.evaluate((app) => {
    const w = window.__aurora.wm.byApp(app)[0];
    const out = [];
    for (const el of w.el.querySelectorAll('.gk-toolbar, .gk-toolbar-group, .ms-status, .sn-status, .t-status, .gk-btn, .gk-chip')) {
      if (el.offsetParent === null) continue;
      if (el.scrollWidth > el.clientWidth + 1) out.push(`${el.className} ${el.scrollWidth}>${el.clientWidth}`);
    }
    const bodyR = w.body.getBoundingClientRect();
    for (const el of w.el.querySelectorAll('.gk-toolbar .btn, .gk-chip, .ms-face')) {
      const r = el.getBoundingClientRect();
      if (r.width && (r.right > bodyR.right + 1 || r.left < bodyR.left - 1)) out.push(`${el.className} outside the window`);
    }
    return out;
  }, id);
  assert.deepEqual(bad, [], `overflow in ${id}`);
}

// ------------------------------------------------------------------ Minesweeper
if (want('minesweeper')) {
  console.log('Minesweeper UI (en, light)');
  const s = await launchShell({ open: ['minesweeper'], lang: 'en', theme: 'light' });
  const errs = watchErrors(s);
  const { page } = s;
  const W = winOf('minesweeper');
  const ms = (fn, arg) => page.evaluate(([f, a]) => new Function('h', 'a', `return (${f})(h, a)`)(document.querySelector('[data-app="minesweeper"]').__minesweeper, a), [fn.toString(), arg]);
  const cell = (i) => page.locator(`${W} .ms-cell[data-i="${i}"]`);
  try {
    await page.waitForSelector(`${W} .ms-cell`);
    await sleep(500);

    await test('opens a 9x9 beginner board sized to fit the window', async () => {
      assert.equal(await page.locator(`${W} .ms-cell`).count(), 81);
      assert.equal(await page.locator(`${W} [data-id="mines"] .gk-chip-value`).textContent(), '10');
      assert.equal(await page.locator(`${W} [data-id="time"] .gk-chip-value`).textContent(), '0');
      const fit = await page.evaluate(() => {
        const w = window.__aurora.wm.byApp('minesweeper')[0];
        const st = w.el.querySelector('.ms-stage');
        const fr = w.el.querySelector('.ms-frame').getBoundingClientRect();
        const wr = w.el.getBoundingClientRect();
        return { scroll: st.scrollWidth > st.clientWidth || st.scrollHeight > st.clientHeight, inside: fr.right <= wr.right && fr.bottom <= wr.bottom, title: w.title };
      });
      assert.equal(fit.title, 'Minesweeper');
      assert.equal(fit.scroll, false, 'no scrollbars');
      assert.equal(fit.inside, true);
      assert.equal(await ms((h) => h.cellSize), 40);
      await assertNoOverflow(page, 'minesweeper');
    });

    await test('first click opens an area and starts the timer', async () => {
      await cell(40).click();
      await sleep(400);
      const st = await ms((h) => ({ status: h.game.status, revealed: h.game.revealedCount }));
      assert.equal(st.status, 'playing');
      assert.ok(st.revealed > 1, `revealed ${st.revealed}`);
      assert.ok((await page.locator(`${W} .ms-cell.open`).count()) >= st.revealed);
      await sleep(1100);
      assert.ok(Number(await page.locator(`${W} [data-id="time"] .gk-chip-value`).textContent()) >= 1, 'timer runs');
      // The clock stops while the window is minimised.
      await page.evaluate(() => window.__aurora.wm.byApp('minesweeper')[0].minimize());
      const t0 = await page.evaluate(() => document.querySelector('[data-app="minesweeper"]').__minesweeper.elapsed);
      await sleep(1200);
      const t1 = await page.evaluate(() => document.querySelector('[data-app="minesweeper"]').__minesweeper.elapsed);
      assert.ok(Math.abs(t1 - t0) < 50, `paused while minimised (${t0} -> ${t1})`);
      await page.evaluate(() => window.__aurora.wm.byApp('minesweeper')[0].restoreFromMinimize());
      await sleep(600);
      const t2 = await page.evaluate(() => document.querySelector('[data-app="minesweeper"]').__minesweeper.elapsed);
      assert.ok(t2 > t1 + 300 && t2 < t1 + 1100, `resumes after restore (${t1} -> ${t2})`);
    });

    await test('right-click cycles flag -> question -> none and updates the mine counter', async () => {
      const i = await ms((h) => h.game.cells.findIndex((c) => c.state === 'hidden'));
      await cell(i).click({ button: 'right' });
      assert.match(await cell(i).getAttribute('class'), /\bflag\b/);
      assert.equal(await page.locator(`${W} [data-id="mines"] .gk-chip-value`).textContent(), '9');
      await cell(i).click({ button: 'right' });
      assert.match(await cell(i).getAttribute('class'), /\bquestion\b/);
      assert.equal(await page.locator(`${W} [data-id="mines"] .gk-chip-value`).textContent(), '10');
      await cell(i).click({ button: 'right' });
      assert.doesNotMatch(await cell(i).getAttribute('class'), /\b(flag|question)\b/);
      await cell(i).click({ modifiers: ['Shift'] });
      assert.match(await cell(i).getAttribute('class'), /\bflag\b/, 'Shift+click flags');
      await cell(i).click({ button: 'right' });
      await cell(i).click({ button: 'right' });
    });

    await test('touch: long-press flags, a tap uncovers', async () => {
      const i = await ms((h) => h.game.cells.findIndex((c) => c.state === 'hidden'));
      let b = await cell(i).boundingBox();
      await touchAt(page, 'pointerdown', b.x + b.width / 2, b.y + b.height / 2);
      await sleep(600);
      await touchAt(page, 'pointerup', b.x + b.width / 2, b.y + b.height / 2);
      await sleep(100);
      assert.match(await cell(i).getAttribute('class'), /\bflag\b/, 'long-press placed a flag');
      await cell(i).click({ button: 'right' });
      await cell(i).click({ button: 'right' });
      // A quick tap on a safe covered cell uncovers it.
      const safe = await ms((h) => h.game.cells.findIndex((c) => c.state === 'hidden' && !c.mine));
      b = await cell(safe).boundingBox();
      await touchAt(page, 'pointerdown', b.x + b.width / 2, b.y + b.height / 2);
      await sleep(60);
      await touchAt(page, 'pointerup', b.x + b.width / 2, b.y + b.height / 2);
      await sleep(150);
      assert.equal(await ms((h, a) => h.game.cells[a].state, safe), 'revealed');
      assert.equal(await ms((h) => h.game.status), 'playing');
    });

    await test('abandoning a game asks for confirmation', async () => {
      await page.keyboard.press('n');
      await page.waitForSelector(`${W} .dialog`);
      assert.match(await page.locator(`${W} .dialog`).textContent(), /Abandon this game\?/);
      await page.locator(`${W} .dialog button`, { hasText: 'Keep playing' }).click();
      await sleep(250);
      assert.equal(await ms((h) => h.game.status), 'playing');
      await page.keyboard.press('F2');
      await page.waitForSelector(`${W} .dialog`);
      await page.locator(`${W} .dialog button`, { hasText: 'New game' }).click();
      await sleep(300);
      assert.equal(await ms((h) => h.game.status), 'ready');
      assert.equal(await ms((h) => h.stats.beginner.played), 1, 'abandoned game counted as a loss');
    });

    await test('keyboard: arrows move the cursor, Space reveals, F flags, Space on a number chords', async () => {
      // Mines: the bottom row + (8,6). Opening (0,0) uncovers everything except (8,7), which is
      // then cleared by chording the 4 at (7,7) once its four mines are flagged.
      await ms((h) => {
        h.newGame();
        const g = h.game;
        h.plant([...Array.from({ length: 9 }, (_, x) => g.index(x, 8)), g.index(8, 6)], g.index(0, 0));
      });
      await page.locator(`${W} .ms-board`).focus();
      const press = async (key, n = 1) => {
        for (let k = 0; k < n; k++) await page.keyboard.press(key);
      };
      await press('ArrowUp', 8);
      await press('ArrowLeft', 8);
      assert.match(await cell(0).getAttribute('class'), /\bcursor\b/);
      await press('Space');
      await sleep(400);
      let st = await ms((h) => ({ status: h.game.status, hidden: h.game.cells.map((c, i) => (!c.mine && c.state !== 'revealed' ? i : -1)).filter((i) => i >= 0) }));
      assert.equal(st.status, 'playing');
      assert.deepEqual(st.hidden, [7 * 9 + 8], 'only (8,7) left');
      const at = (x, y) => y * 9 + x;
      await press('ArrowRight', 8);
      await press('ArrowDown', 6);
      await press('f');
      assert.match(await cell(at(8, 6)).getAttribute('class'), /\bflag\b/, 'F flags the cursor cell');
      await press('ArrowLeft', 2);
      await press('ArrowDown', 2);
      await press('f');
      await press('ArrowRight');
      await press('f');
      await press('ArrowRight');
      await press('f');
      assert.equal(await page.locator(`${W} [data-id="mines"] .gk-chip-value`).textContent(), '6');
      await press('ArrowLeft');
      await press('ArrowUp');
      assert.equal(await ms((h) => h.game.cells[7 * 9 + 7].adj), 4);
      await press('Enter');
      await sleep(300);
      st = await ms((h) => h.game.status);
      assert.equal(st, 'won', 'chord revealed the last safe cell');
    });

    await test('win: celebration, cool face, best time recorded', async () => {
      await waitFor(page, () => document.querySelector('[data-app="minesweeper"]').__minesweeper.game.status === 'won');
      assert.ok(await page.locator(`${W} .gk-confetti`).count(), 'confetti canvas shown');
      await page.waitForSelector(`${W} .gk-overlay:not([hidden]) .gk-overlay-card`, { timeout: 4000 });
      assert.match(await page.locator(`${W} .gk-overlay-title`).textContent(), /You won!/);
      assert.equal(await page.locator(`${W} .ms-face`).getAttribute('data-kind'), 'cool');
      assert.equal(await ms((h) => h.stats.beginner.won), 1);
      assert.equal(await ms((h) => h.stats.beginner.bestTimes.length), 1);
      assert.equal(await page.locator(`${W} .gk-badge`).count(), 1, 'new record badge');
      await winShot(s, 'minesweeper', 'minesweeper-won-light-en');
      await page.locator(`${W} [data-id="again"]`).click();
      await sleep(300);
      assert.equal(await ms((h) => h.game.status), 'ready');
    });

    await test('loss: mines revealed, exploded cell highlighted, wrong flags crossed', async () => {
      await ms((h) => {
        const g = h.game;
        h.plant([g.index(0, 0), g.index(8, 0), g.index(0, 8), g.index(8, 8), g.index(4, 0), g.index(0, 4), g.index(8, 4), g.index(4, 8), g.index(2, 2), g.index(6, 6)], g.index(4, 4));
      });
      await cell(40).click();
      await sleep(300);
      const wrong = await ms((h) => h.game.cells.findIndex((c, i) => !c.mine && c.state === 'hidden'));
      await cell(wrong).click({ button: 'right' });
      await cell(0).click();
      await page.waitForSelector(`${W} .ms-cell.exploded`);
      await sleep(1200);
      assert.equal(await ms((h) => h.game.status), 'lost');
      assert.equal(await page.locator(`${W} .ms-cell.mine`).count(), 10);
      assert.match(await cell(wrong).getAttribute('class'), /\bwrong\b/);
      assert.equal(await page.locator(`${W} .ms-face`).getAttribute('data-kind'), 'dizzy');
      await page.waitForSelector(`${W} .gk-overlay:not([hidden])`);
      await sleep(450);
      await winShot(s, 'minesweeper', 'minesweeper-lost-light-en');
      await page.locator(`${W} [data-id="dismiss"]`).click();
      await sleep(250);
      assert.equal(await page.locator(`${W} .gk-overlay:not([hidden])`).count(), 0);
      assert.equal(await ms((h) => h.stats.beginner.played), 3);
    });

    await test('difficulty menu switches to Expert and the window grows to fit', async () => {
      const before = await page.evaluate(() => window.__aurora.wm.byApp('minesweeper')[0].w);
      await page.locator(`${W} [data-id="difficulty"]`).click();
      await page.locator('.menu .menu-item', { hasText: 'Expert' }).click();
      await sleep(600);
      assert.equal(await page.locator(`${W} .ms-cell`).count(), 480);
      const after = await page.evaluate(() => window.__aurora.wm.byApp('minesweeper')[0].w);
      assert.ok(after > before + 300, `window grew ${before} -> ${after}`);
      const scroll = await page.evaluate(() => {
        const st = document.querySelector('[data-app="minesweeper"] .ms-stage');
        return st.scrollWidth > st.clientWidth || st.scrollHeight > st.clientHeight;
      });
      assert.equal(scroll, false);
      assert.equal(await page.locator(`${W} [data-id="difficulty"] .gk-btn-label`).textContent(), 'Expert');
      await page.locator(`${W} .ms-cell[data-i="${16 * 30 / 2 + 15}"]`).click();
      await sleep(700);
      await winShot(s, 'minesweeper', 'minesweeper-expert-light-en');
      await ms((h) => h.newGame());
    });

    await test('custom board dialog validates input', async () => {
      await page.locator(`${W} [data-id="difficulty"]`).click();
      await page.locator('.menu .menu-item', { hasText: 'Custom' }).click();
      await page.waitForSelector(`${W} .ms-custom`);
      await page.fill(`${W} input[data-field="cols"]`, '100');
      await page.locator(`${W} .dialog button`, { hasText: 'Start' }).click();
      assert.match(await page.locator(`${W} .ms-field-error`).textContent(), /between 5 and 40/);
      assert.equal(await page.locator(`${W} .ms-custom`).count(), 1, 'dialog stays open');
      await page.fill(`${W} input[data-field="cols"]`, '12');
      await page.fill(`${W} input[data-field="rows"]`, '10');
      await page.fill(`${W} input[data-field="mines"]`, '500');
      await page.keyboard.press('Enter');
      assert.match(await page.locator(`${W} .ms-field-error`).textContent(), /mines/);
      await page.fill(`${W} input[data-field="mines"]`, '20');
      await page.keyboard.press('Enter');
      await sleep(600);
      assert.equal(await page.locator(`${W} .ms-cell`).count(), 120);
      assert.deepEqual(await ms((h) => h.prefs.custom), { cols: 12, rows: 10, mines: 20 });
      assert.equal(await page.locator(`${W} [data-id="mines"] .gk-chip-value`).textContent(), '20');
    });

    await test('question marks can be turned off', async () => {
      await page.locator(`${W} [data-id="difficulty"]`).click();
      await page.locator('.menu .menu-item', { hasText: 'Question marks' }).click();
      assert.equal(await ms((h) => h.prefs.questionMarks), false);
      await cell(5).click({ button: 'right' });
      await cell(5).click({ button: 'right' });
      assert.doesNotMatch(await cell(5).getAttribute('class'), /\b(flag|question)\b/);
    });

    await test('statistics dialog shows records and can be reset', async () => {
      await page.locator(`${W} [data-id="stats"]`).click();
      await page.waitForSelector(`${W} .gk-stats`);
      await page.locator(`${W} .gk-stats-picker`).selectOption('beginner').catch(() => {});
      await sleep(150);
      assert.equal(await page.locator(`${W} .gk-stat[data-id="played"] .gk-stat-value`).textContent(), '3');
      assert.equal(await page.locator(`${W} .gk-stat[data-id="won"] .gk-stat-value`).textContent(), '1');
      assert.equal(await page.locator(`${W} .gk-stat[data-id="rate"] .gk-stat-value`).textContent(), '33 %');
      assert.equal(await page.locator(`${W} .gk-rank`).count(), 1);
      await sleep(300);
      await winShot(s, 'minesweeper', 'minesweeper-stats-light-en');
      // A double-click on Reset must open a single confirmation.
      await page.locator(`${W} .dialog button`, { hasText: 'Reset' }).dblclick();
      await sleep(250);
      assert.equal(await page.locator(`${W} .dialog`).count(), 2, 'statistics + one confirmation');
      await page.locator(`${W} .dialog button`, { hasText: 'Reset' }).last().click();
      await sleep(400);
      assert.equal(await page.locator(`${W} .gk-stat[data-id="played"] .gk-stat-value`).textContent(), '0');
      await page.locator(`${W} .dialog button`, { hasText: 'Close' }).click();
      await sleep(250);
      assert.equal(await page.locator(`${W} .dialog`).count(), 0);
    });

    await test('help dialog (F1) explains the game', async () => {
      await page.keyboard.press('F1');
      await page.waitForSelector(`${W} .gk-help`);
      await sleep(120);
      assert.ok((await page.locator(`${W} .gk-help-section`).count()) >= 3);
      assert.ok((await page.locator(`${W} .gk-key-row`).count()) >= 4);
      await page.keyboard.press('Escape');
      await sleep(250);
      assert.equal(await page.locator(`${W} .gk-help`).count(), 0);
    });

    await test('maximized window scales the cells up; min size keeps the chrome intact', async () => {
      await page.locator(`${W} [data-id="difficulty"]`).click();
      await page.locator('.menu .menu-item', { hasText: 'Intermediate' }).click();
      await sleep(500);
      const normal = await ms((h) => h.cellSize);
      await page.evaluate(() => window.__aurora.wm.byApp('minesweeper')[0].maximize());
      await sleep(500);
      const big = await ms((h) => h.cellSize);
      assert.ok(big > normal, `cells ${normal} -> ${big}`);
      await ms((h) => h.game.reveal(h.game.index(8, 8)));
      await ms((h) => h.newGame());
      await page.evaluate(() => window.__aurora.wm.byApp('minesweeper')[0].restore());
      await sleep(500);
      await page.evaluate(() => window.__aurora.wm.byApp('minesweeper')[0].setSize(10, 10));
      await sleep(300);
      const r = await page.evaluate(() => {
        const w = window.__aurora.wm.byApp('minesweeper')[0];
        return { w: w.w, h: w.h, min: w.opts.minWidth };
      });
      assert.ok(r.w === r.min && r.w >= 340 && r.h >= 400, `clamped to the board's minimum ${JSON.stringify(r)}`);
      await assertNoOverflow(page, 'minesweeper');
      assert.ok((await ms((h) => h.cellSize)) >= 18);
    });

    await test('a level changed while maximized refits the window on restore (no scrollbars, even at min size)', async () => {
      const wmw = (f, ...a) => page.evaluate(([fn, args]) => window.__aurora.wm.byApp('minesweeper')[0][fn](...args), [f, a]);
      const scrollbars = () =>
        page.evaluate(() => {
          const st = document.querySelector('[data-app="minesweeper"] .ms-stage');
          return st.scrollWidth > st.clientWidth || st.scrollHeight > st.clientHeight;
        });
      await wmw('maximize');
      await sleep(500);
      await page.locator(`${W} [data-id="difficulty"]`).click();
      await page.locator('.menu .menu-item', { hasText: 'Expert' }).click();
      await sleep(500);
      assert.equal(await page.locator(`${W} .ms-cell`).count(), 480);
      assert.equal(await page.evaluate(() => window.__aurora.wm.byApp('minesweeper')[0].state), 'maximized', 'stays maximized');
      await wmw('restore');
      await sleep(800);
      const w = await page.evaluate(() => window.__aurora.wm.byApp('minesweeper')[0].w);
      assert.ok(w > 800, `restored window fits the expert board (${w}px wide)`);
      assert.equal(await scrollbars(), false, 'no scrollbars after restore');
      assert.equal(await ms((h) => h.cellSize), 28, 'preferred expert cell size');
      await wmw('setSize', 10, 10);
      await sleep(400);
      assert.equal(await scrollbars(), false, 'the minimum size still holds the whole board');
      assert.equal(await ms((h) => h.cellSize), 18);
    });

    await test('mid-game screenshot (light, English)', async () => {
      await page.locator(`${W} [data-id="difficulty"]`).click();
      await page.locator('.menu .menu-item', { hasText: 'Beginner' }).click();
      await sleep(600);
      await ms((h) => {
        const g = h.game;
        h.plant([g.index(0, 0), g.index(3, 1), g.index(7, 1), g.index(1, 4), g.index(2, 6), g.index(6, 5), g.index(8, 7), g.index(5, 8), g.index(0, 8), g.index(7, 3)], g.index(4, 4));
      });
      await cell(40).click();
      await sleep(500);
      for (const i of [3 * 1 + 9, 7 + 9]) await cell(i).click({ button: 'right' });
      await page.locator(`${W} .ms-board`).focus();
      await page.keyboard.press('ArrowLeft');
      await sleep(500);
      await winShot(s, 'minesweeper', 'minesweeper-light-en');
    });

    await test('no console errors from Minesweeper', async () => {
      assert.deepEqual(errs, []);
    });
  } finally {
    await s.close();
  }
}

// ------------------------------------------------------------------ Snake
if (want('snake')) {
  console.log('Snake UI (en, light)');
  const s = await launchShell({ open: ['snake'], lang: 'en', theme: 'light' });
  const errs = watchErrors(s);
  const { page } = s;
  const W = winOf('snake');
  const sn = (fn, arg) => page.evaluate(([f, a]) => new Function('h', 'a', `return (${f})(h, a)`)(document.querySelector('[data-app="snake"]').__snake, a), [fn.toString(), arg]);
  try {
    await page.waitForSelector(`${W} canvas`);
    await sleep(600);

    await test('opens ready to play with a crisp DPR-scaled canvas', async () => {
      assert.equal(await sn((h) => h.state), 'ready');
      assert.equal(await page.locator(`${W} .gk-overlay[data-kind="ready"]:not([hidden])`).count(), 1);
      const c = await page.evaluate(() => {
        const cv = document.querySelector('[data-app="snake"] canvas');
        return { w: cv.width, cssW: cv.getBoundingClientRect().width, dpr: devicePixelRatio };
      });
      assert.ok(Math.abs(c.w - c.cssW * c.dpr) <= 1, JSON.stringify(c));
      assert.equal(await sn((h) => h.game.snake.length), 4);
      await assertNoOverflow(page, 'snake');
    });

    await test('arrow key starts the game and the snake moves', async () => {
      // Wrap-around keeps these timing-based tests safe from the walls.
      await page.locator(`${W} [data-id="options"]`).click();
      await page.locator('.menu .menu-item', { hasText: 'Wrap-around' }).click();
      await sleep(200);
      assert.equal(await sn((h) => h.game.wrap), true);
      await page.locator(`${W} .sn-board`).focus();
      const x0 = await sn((h) => h.game.snake[0].x);
      await page.keyboard.press('ArrowDown');
      await sleep(80);
      assert.equal(await sn((h) => h.state), 'running');
      await sleep(500);
      const g = await sn((h) => ({ steps: h.game.steps, dir: h.game.dir, head: h.game.snake[0] }));
      assert.ok(g.steps >= 3, `steps ${g.steps}`);
      assert.equal(g.dir, 'down');
      assert.equal(g.head.x, x0);
    });

    await test('movement is interpolated between grid steps (fixed timestep + rAF)', async () => {
      const samples = [];
      for (let k = 0; k < 14; k++) {
        samples.push(await sn((h) => h.alpha));
        await sleep(9);
      }
      const mid = new Set(samples.filter((a) => a > 0.05 && a < 0.95).map((a) => a.toFixed(2)));
      assert.ok(mid.size >= 3, `intermediate positions: ${[...mid].join(', ')}`);
    });

    await test('Space pauses with an overlay and resumes; P and Esc pause too', async () => {
      await page.keyboard.press('Space');
      assert.equal(await sn((h) => h.state), 'paused');
      await page.waitForSelector(`${W} .gk-overlay[data-kind="paused"]:not([hidden])`);
      const steps = await sn((h) => h.game.steps);
      await sleep(300);
      assert.equal(await sn((h) => h.game.steps), steps, 'frozen while paused');
      await page.keyboard.press('Space');
      assert.equal(await sn((h) => h.state), 'running');
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('p');
      assert.equal(await sn((h) => h.state), 'paused');
      await page.keyboard.press('p');
      await page.keyboard.press('Escape');
      assert.equal(await sn((h) => h.state), 'paused');
      await page.keyboard.press('Escape');
      assert.equal(await sn((h) => h.state), 'running');
    });

    await test('WASD steers and 180° reversal is ignored', async () => {
      const d0 = await sn((h) => h.game.dir);
      await page.keyboard.press('w');
      await sleep(250);
      assert.equal(await sn((h) => h.game.dir), 'up', `from ${d0}`);
      await page.keyboard.press('s');
      await sleep(250);
      assert.equal(await sn((h) => h.game.dir), 'up', 'down is a reversal');
      assert.equal(await sn((h) => h.state), 'running');
      await page.keyboard.press('a');
      await sleep(200);
      assert.equal(await sn((h) => h.game.dir), 'left');
    });

    await test('pauses automatically when the window loses focus or is minimized', async () => {
      await page.evaluate(() => window.__aurora.registry.launch('winver'));
      await sleep(500);
      assert.equal(await sn((h) => h.state), 'paused');
      assert.match(await page.locator(`${W} .gk-overlay-text`).textContent(), /lost focus/);
      await page.evaluate(() => window.__aurora.wm.byApp('winver')[0].close(true));
      await page.evaluate(() => window.__aurora.wm.byApp('snake')[0].focus());
      await sleep(300);
      await page.locator(`${W} [data-id="resume"]`).click();
      assert.equal(await sn((h) => h.state), 'running');
      await page.evaluate(() => window.__aurora.wm.byApp('snake')[0].minimize());
      await sleep(200);
      assert.equal(await sn((h) => h.state), 'paused');
      await page.evaluate(() => window.__aurora.wm.byApp('snake')[0].restoreFromMinimize());
      await sleep(400);
    });

    await test('pauses when the Start menu takes the keyboard (window stays active in the WM)', async () => {
      await page.locator(`${W} .sn-board`).focus();
      await page.keyboard.press('Space');
      assert.equal(await sn((h) => h.state), 'running');
      await page.locator('.tb-start').click();
      await sleep(500);
      assert.equal(await page.evaluate(() => window.__aurora.wm.focused()?.appId), 'snake', 'the WM still sees Snake as active');
      assert.equal(await sn((h) => h.state), 'paused');
      const steps = await sn((h) => h.game.steps);
      await page.keyboard.press('ArrowDown');
      await sleep(250);
      assert.equal(await sn((h) => h.game.steps), steps, 'keys typed in the Start menu do not steer the snake');
      await page.keyboard.press('Escape');
      await sleep(400);
      await page.evaluate(() => window.__aurora.wm.byApp('snake')[0].focus());
      await sleep(200);
      assert.equal(await sn((h) => h.state), 'paused');
    });

    await test('display scale change re-renders the canvas at the new pixel ratio', async () => {
      await page.evaluate(() => window.__aurora.api.invoke('shell:zoom', 1.25));
      await sleep(900);
      const c = await page.evaluate(() => {
        const cv = document.querySelector('[data-app="snake"] canvas');
        return { w: cv.width, cssW: cv.getBoundingClientRect().width, dpr: devicePixelRatio };
      });
      await page.evaluate(() => window.__aurora.api.invoke('shell:zoom', 1));
      await sleep(900);
      assert.ok(Math.abs(c.dpr - 1.25) < 0.01, `zoomed dpr ${c.dpr}`);
      assert.ok(Math.abs(c.w - c.cssW * c.dpr) <= 2, `canvas ${c.w}px for ${c.cssW} css px at ${c.dpr}`);
      const back = await page.evaluate(() => {
        const cv = document.querySelector('[data-app="snake"] canvas');
        return { w: cv.width, cssW: cv.getBoundingClientRect().width, dpr: devicePixelRatio };
      });
      assert.ok(Math.abs(back.w - back.cssW * back.dpr) <= 1, JSON.stringify(back));
    });

    await test('eating food scores, then hitting the wall ends the game with a record', async () => {
      assert.equal(await sn((h) => h.state), 'paused', 'still paused after being restored');
      await page.locator(`${W} [data-id="options"]`).click();
      await page.locator('.menu .menu-item', { hasText: 'Walls' }).click();
      await sleep(300);
      assert.equal(await sn((h) => h.state), 'ready', 'changing the board starts a new game');
      assert.equal(await sn((h) => h.game.wrap), false);
      const playedBefore = await sn((h) => h.stats.played);
      assert.equal(playedBefore, 1, 'the abandoned run (it had moved) counts as played');
      await sn((h) => {
        const g = h.game;
        g.food = { x: g.snake[0].x + 1, y: g.snake[0].y, born: 0 };
      });
      await page.keyboard.press('ArrowRight');
      await waitFor(page, () => document.querySelector('[data-app="snake"]').__snake.game.score > 0);
      assert.equal(await page.locator(`${W} [data-id="score"] .gk-chip-value`).textContent(), '10');
      await waitFor(page, () => document.querySelector('[data-app="snake"]').__snake.state === 'over', null, 6000);
      await page.waitForSelector(`${W} .gk-overlay[data-kind="over"]:not([hidden])`);
      assert.match(await page.locator(`${W} .gk-overlay-text`).textContent(), /wall/);
      assert.equal(await page.locator(`${W} .gk-badge`).count(), 1, 'new record badge');
      const st = await sn((h) => h.stats);
      assert.equal(st.played, playedBefore + 1);
      assert.equal(st.best.walls, 10);
      assert.equal(st.best.wrap, undefined, 'the wrap-around run scored nothing');
      assert.equal(await page.locator(`${W} [data-id="best"] .gk-chip-value`).textContent(), '10');
      await sleep(900);
      await winShot(s, 'snake', 'snake-gameover-light-en');
      await page.keyboard.press('Enter');
      await sleep(200);
      assert.equal(await sn((h) => h.state), 'ready');
    });

    await test('options: wrap-around mode wraps instead of dying; obstacles and speed apply', async () => {
      await page.locator(`${W} [data-id="options"]`).click();
      await page.locator('.menu .menu-item', { hasText: 'Wrap-around' }).click();
      await sleep(200);
      assert.equal(await sn((h) => h.prefs.wrap), true);
      await page.locator(`${W} [data-id="options"]`).click();
      await page.locator('.menu .menu-item', { hasText: 'Insane' }).click();
      assert.equal(await sn((h) => h.prefs.speed), 'insane');
      await page.locator(`${W} .sn-board`).focus();
      await sn((h) => {
        h.game.food = { x: 0, y: 0, born: 0 };
      });
      await page.keyboard.press('ArrowRight');
      const cols = await sn((h) => h.game.cols);
      await sleep(52 * (cols + 4));
      const g = await sn((h) => ({ state: h.state, steps: h.game.steps }));
      assert.equal(g.state, 'running', 'still alive after crossing the edge');
      assert.ok(g.steps > cols - 8);
      await page.keyboard.press('Space');
      await page.locator(`${W} [data-id="options"]`).click();
      await page.locator('.menu .menu-item', { hasText: 'Obstacles' }).click();
      await sleep(200);
      assert.ok((await sn((h) => h.game.obstacles.length)) > 0);
      assert.match(await page.locator(`${W} [data-id="mode"]`).textContent(), /Insane · Wrap-around · Obstacles/);
      await page.locator(`${W} [data-id="options"]`).click();
      await page.locator('.menu .menu-item', { hasText: 'Slow' }).click();
      await page.locator(`${W} .sn-board`).focus();
      await page.keyboard.press('ArrowRight');
      await sleep(700);
      await winShot(s, 'snake', 'snake-obstacles-light-en');
      await page.keyboard.press('Space');
      // Back to classic for the screenshots.
      await page.locator(`${W} [data-id="options"]`).click();
      await page.locator('.menu .menu-item', { hasText: 'Obstacles' }).click();
      await page.locator(`${W} [data-id="options"]`).click();
      await page.locator('.menu .menu-item', { hasText: 'Walls' }).click();
      await page.locator(`${W} [data-id="options"]`).click();
      await page.locator('.menu .menu-item', { hasText: 'Normal' }).click();
      assert.equal(await sn((h) => h.prefs.wrap), false);
      assert.equal(await sn((h) => h.prefs.speed), 'normal');
    });

    await test('statistics and help dialogs', async () => {
      await page.locator(`${W} [data-id="stats"]`).click();
      await page.waitForSelector(`${W} .gk-stats`);
      assert.ok((await page.locator(`${W} .gk-stat`).count()) >= 6);
      assert.equal(await page.locator(`${W} .gk-rank[data-mode="walls"] .sn-rank-score`).textContent(), '10');
      await page.locator(`${W} .dialog button`, { hasText: 'Close' }).click();
      await sleep(200);
      await page.locator(`${W} [data-id="help"]`).click();
      await page.waitForSelector(`${W} .gk-help`);
      assert.ok((await page.locator(`${W} .gk-key-row`).count()) >= 4);
      await page.locator(`${W} .dialog button`, { hasText: 'Got it' }).click();
      await sleep(200);
    });

    await test('maximized and min-size windows keep the board square-celled and the chrome intact', async () => {
      await page.evaluate(() => window.__aurora.wm.byApp('snake')[0].maximize());
      await sleep(500);
      const big = await sn((h) => h.cell);
      await page.evaluate(() => window.__aurora.wm.byApp('snake')[0].restore());
      await sleep(400);
      await page.evaluate(() => window.__aurora.wm.byApp('snake')[0].setSize(10, 10));
      await sleep(300);
      const small = await sn((h) => h.cell);
      assert.ok(big > small, `${big} > ${small}`);
      await assertNoOverflow(page, 'snake');
      const fits = await page.evaluate(() => {
        const w = window.__aurora.wm.byApp('snake')[0];
        const b = w.el.querySelector('.sn-board').getBoundingClientRect();
        const r = w.el.getBoundingClientRect();
        return b.right <= r.right && b.bottom <= r.bottom && b.left >= r.left;
      });
      assert.ok(fits);
      await page.evaluate(() => window.__aurora.wm.byApp('snake')[0].setSize(720, 660));
      await sleep(300);
    });

    await test('mid-game screenshot (light, English)', async () => {
      await page.keyboard.press('n');
      await sleep(200);
      // Grow the snake by feeding it a few apples on its path.
      await page.locator(`${W} .sn-board`).focus();
      await page.keyboard.press('ArrowRight');
      for (const d of ['ArrowUp', 'ArrowRight', 'ArrowDown']) {
        for (let k = 0; k < 2; k++) {
          await sn((h) => {
            const g = h.game;
            const dv = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[g.dir];
            g.food = { x: g.snake[0].x + dv[0], y: g.snake[0].y + dv[1], born: 0 };
          });
          await sleep(140);
        }
        await page.keyboard.press(d);
        await sleep(330);
      }
      await page.keyboard.press('ArrowRight');
      await sleep(250);
      assert.equal(await sn((h) => h.state), 'running');
      assert.ok((await sn((h) => h.game.score)) >= 20);
      await winShot(s, 'snake', 'snake-light-en');
      await page.keyboard.press('Space');
    });

    await test('no console errors from Snake', async () => {
      assert.deepEqual(errs, []);
    });
  } finally {
    await s.close();
  }
}

// ------------------------------------------------------------------ 2048
if (want('game2048')) {
  console.log('2048 UI (en, light)');
  const home = fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'aurora-2048-'));
  let s = await launchShell({ open: ['game2048'], lang: 'en', theme: 'light', home });
  let errs = watchErrors(s);
  let page = s.page;
  const W = winOf('game2048');
  const tg = (fn, arg) => page.evaluate(([f, a]) => new Function('h', 'a', `return (${f})(h, a)`)(document.querySelector('[data-app="game2048"]').__game2048, a), [fn.toString(), arg]);
  const grid = () =>
    tg((h) => {
      const g = h.game;
      const out = Array.from({ length: g.size }, () => Array(g.size).fill(0));
      for (const t of g.tiles) out[t.r][t.c] = t.value;
      return out;
    });
  const domTiles = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('[data-app="game2048"] .t-tile')].map((el) => ({ v: Number(el.dataset.value), r: Number(el.dataset.r), c: Number(el.dataset.c) })),
    );
  try {
    await page.waitForSelector(`${W} .t-tile`);
    await sleep(500);

    await test('opens with two tiles on a 4x4 board', async () => {
      assert.equal(await page.locator(`${W} .t-slot`).count(), 16);
      assert.equal(await page.locator(`${W} .t-tile`).count(), 2);
      assert.equal(await page.locator(`${W} [data-id="score"] .gk-chip-value`).textContent(), '0');
      assert.equal(await page.locator(`${W} [data-id="undo"]`).isDisabled(), true);
      await assertNoOverflow(page, 'game2048');
    });

    await test('[2,2,2,2] -> [4,4,_,_] with slide + merge animations', async () => {
      await tg((h) => h.load([[2, 2, 2, 2], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], { moves: 1 }));
      await page.locator(`${W} .t-board`).focus();
      // Key press and style read in the same task: the merged tiles must stay hidden while the
      // sources are still sliding (they pop once the slide lands).
      const during = await page.evaluate(() => {
        const b = document.querySelector('[data-app="game2048"] .t-board');
        b.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', code: 'ArrowLeft', bubbles: true, cancelable: true }));
        return [...document.querySelectorAll('[data-app="game2048"] .t-tile.merged > span')].map((s) => getComputedStyle(s).opacity);
      });
      assert.deepEqual(during, ['0', '0'], 'merged tiles hidden during the slide');
      assert.equal(await page.locator(`${W} .t-tile.merged`).count(), 2, 'merged tiles pop');
      assert.equal(await page.locator(`${W} .t-tile.new`).count(), 1, 'a new tile appears');
      const g = await grid();
      assert.deepEqual(g[0].slice(0, 2), [4, 4]);
      assert.equal(g.flat().filter(Boolean).length, 3);
      assert.equal(await page.locator(`${W} [data-id="score"] .gk-chip-value`).textContent(), '8');
      assert.equal(await page.locator(`${W} .t-float`).count(), 1, '+N float');
      await sleep(400);
      const dom = await domTiles();
      assert.equal(dom.length, 3, 'merged source tiles removed after the animation');
      assert.ok(dom.some((d) => d.v === 4 && d.r === 0 && d.c === 0));
    });

    await test('[4,4,8,_] -> [8,8,_,_] and undo restores the board and score', async () => {
      await tg((h) => h.load([[4, 4, 8, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 2]], { moves: 3, score: 100 }));
      await page.keyboard.press('a');
      await sleep(300);
      const g = await grid();
      assert.deepEqual(g[0].slice(0, 2), [8, 8]);
      assert.equal(await tg((h) => h.game.score), 108);
      assert.equal(await page.locator(`${W} [data-id="undo"]`).isDisabled(), false);
      await page.keyboard.press('Control+z');
      await sleep(250);
      assert.deepEqual((await grid())[0], [4, 4, 8, 0]);
      assert.equal(await tg((h) => h.game.score), 100);
      assert.equal(await page.locator(`${W} [data-id="undo"]`).isDisabled(), true, 'only one undo');
    });

    await test('mouse swipe on the board moves the tiles', async () => {
      await tg((h) => h.load([[2, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], { moves: 3 }));
      const b = await page.locator(`${W} .t-board`).boundingBox();
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      await page.mouse.down();
      await page.mouse.move(b.x + b.width / 2 + 120, b.y + b.height / 2 + 10, { steps: 6 });
      await page.mouse.up();
      await sleep(250);
      assert.equal((await grid())[0][3], 2);
      // Touch swipe down (synthetic touch pointer events).
      await tg((h) => h.load([[0, 0, 0, 2], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], { moves: 4 }));
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 3;
      await touchAt(page, 'pointerdown', cx, cy, 21);
      for (let k = 1; k <= 5; k++) await touchAt(page, 'pointermove', cx + 3, cy + k * 25, 21);
      await touchAt(page, 'pointerup', cx + 3, cy + 125, 21);
      await sleep(250);
      assert.equal((await grid())[3][3], 2, 'touch swipe moved the tile down');
    });

    await test('tile colours keep readable contrast (light palette)', async () => {
      await assertTileContrast(page);
      const gold = await page.evaluate(() => {
        const chip = document.querySelector('[data-app="game2048"] [data-id="best"]');
        chip.classList.add('record');
        const c = getComputedStyle(chip.querySelector('.gk-chip-value')).color;
        chip.classList.remove('record');
        return c;
      });
      assert.ok(contrast(gold, '#fbfbfb') >= 4.5, `record gold ${gold}`);
    });

    await test('reaching 2048 offers to keep going', async () => {
      await tg((h) => h.load([[1024, 1024, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 2, 0]], { moves: 5, score: 20000 }));
      await page.keyboard.press('ArrowLeft');
      await page.waitForSelector(`${W} .gk-overlay[data-kind="won"]:not([hidden])`);
      assert.match(await page.locator(`${W} .gk-overlay-title`).textContent(), /2048/);
      await sleep(450);
      await winShot(s, 'game2048', 'game2048-won-light-en');
      await page.locator(`${W} [data-id="keep"]`).click();
      await sleep(250);
      assert.equal(await tg((h) => h.game.keepPlaying), true);
      await page.keyboard.press('ArrowRight');
      await sleep(200);
      assert.equal(await page.locator(`${W} .gk-overlay:not([hidden])`).count(), 0, 'no second win prompt');
    });

    await test('game over is detected and recorded', async () => {
      await tg((h) => h.load([[2, 4, 2, 4], [4, 2, 4, 2], [2, 4, 2, 4], [4, 2, 4, 2]], { moves: 30, score: 300 }));
      await page.waitForSelector(`${W} .gk-overlay[data-kind="over"]:not([hidden])`);
      assert.match(await page.locator(`${W} .gk-overlay-title`).textContent(), /No more moves/);
      const st = await tg((h) => h.stats[4]);
      assert.equal(st.played, 1, 'the abandoned-by-load game is not counted; only this one');
      await page.locator(`${W} [data-id="again"]`).click();
      await sleep(300);
      assert.equal(await page.locator(`${W} .t-tile`).count(), 2);
    });

    await test('board size option switches to 5x5 (with confirmation mid-game)', async () => {
      await page.locator(`${W} .t-board`).focus();
      for (const k of ['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown']) await page.keyboard.press(k);
      await sleep(200);
      await page.locator(`${W} [data-id="options"]`).click();
      await page.locator('.menu .menu-item', { hasText: '5 × 5' }).click();
      await page.waitForSelector(`${W} .dialog`);
      await page.locator(`${W} .dialog button`, { hasText: 'New game' }).click();
      await sleep(400);
      assert.equal(await page.locator(`${W} .t-slot`).count(), 25);
      assert.equal(await tg((h) => h.game.size), 5);
      assert.match(await page.locator(`${W} [data-id="options"]`).textContent(), /5 × 5/);
      await page.locator(`${W} [data-id="options"]`).click();
      await page.locator('.menu .menu-item', { hasText: '4 × 4' }).click();
      await sleep(400);
      assert.equal(await tg((h) => h.game.size), 4);
    });

    await test('statistics (per size) and help dialogs', async () => {
      await page.locator(`${W} [data-id="stats"]`).click();
      await page.waitForSelector(`${W} .gk-stats .segmented`);
      const best = await tg((h) => h.stats[4].bestScore);
      assert.ok(best >= 22048, `best ${best} includes the 2048 merge`);
      assert.equal(await page.locator(`${W} .gk-stat[data-id="best"] .gk-stat-value`).textContent(), best.toLocaleString('en-US'));
      assert.equal(await page.locator(`${W} .gk-stat[data-id="tile"] .gk-stat-value`).textContent(), '2,048');
      assert.equal(await page.locator(`${W} .gk-stat[data-id="played"] .gk-stat-value`).textContent(), '2', 'game over + the game abandoned for 5x5');
      await page.locator(`${W} .gk-stats .segmented button`, { hasText: '5 × 5' }).click();
      await sleep(150);
      assert.equal(await page.locator(`${W} .gk-stat[data-id="played"] .gk-stat-value`).textContent(), '0', 'the untouched 5x5 game is not counted');
      await page.locator(`${W} .dialog button`, { hasText: 'Close' }).click();
      await sleep(200);
      await page.keyboard.press('F1');
      await page.waitForSelector(`${W} .gk-help`);
      await page.keyboard.press('Escape');
      await sleep(200);
    });

    await test('maximized and min-size windows keep a square board inside the window', async () => {
      await page.evaluate(() => window.__aurora.wm.byApp('game2048')[0].maximize());
      await sleep(500);
      const big = (await page.locator(`${W} .t-board`).boundingBox()).width;
      await page.evaluate(() => window.__aurora.wm.byApp('game2048')[0].restore());
      await sleep(400);
      await page.evaluate(() => window.__aurora.wm.byApp('game2048')[0].setSize(10, 10));
      await sleep(300);
      const bb = await page.locator(`${W} .t-board`).boundingBox();
      assert.ok(big > bb.width + 100, `${big} vs ${bb.width}`);
      assert.ok(Math.abs(bb.width - bb.height) < 1);
      await assertNoOverflow(page, 'game2048');
      await page.evaluate(() => window.__aurora.wm.byApp('game2048')[0].setSize(520, 680));
      await sleep(300);
    });

    await test('mid-game screenshot (light, English)', async () => {
      await tg((h) => h.load([[2, 4, 8, 16], [32, 64, 128, 256], [512, 1024, 0, 4], [0, 2, 0, 8]], { moves: 400, score: 9532, won: false }));
      await page.keyboard.press('ArrowDown');
      await sleep(600);
      await winShot(s, 'game2048', 'game2048-light-en');
    });

    await test('the game in progress is restored after closing and reopening', async () => {
      const before = await grid();
      const score = await tg((h) => h.game.score);
      await page.evaluate(() => window.__aurora.wm.byApp('game2048')[0].close());
      await sleep(800);
      await page.evaluate(() => window.__aurora.registry.launch('game2048'));
      await page.waitForSelector(`${W} .t-tile`);
      await sleep(500);
      assert.deepEqual(await grid(), before);
      assert.equal(await tg((h) => h.game.score), score);
    });

    await test('a damaged saved game is ignored (fresh game, no errors)', async () => {
      await page.evaluate(() => window.__aurora.wm.byApp('game2048')[0].close());
      await sleep(600);
      await page.evaluate(() => window.__aurora.api.invoke('storage:set', 'game2048', 'game', { size: 4, tiles: [{ r: 9, c: 0, value: 3 }, null], score: 'x' }));
      await page.evaluate(() => window.__aurora.registry.launch('game2048'));
      await page.waitForSelector(`${W} .t-tile`);
      await sleep(500);
      assert.equal(await page.locator(`${W} .t-tile`).count(), 2);
      assert.equal(await tg((h) => h.game.score), 0);
    });

    await test('no console errors from 2048', async () => {
      assert.deepEqual(errs, []);
    });
  } finally {
    await s.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ French + dark, all three apps
if (!ONLY.length || ONLY.includes('fr')) {
  console.log('All games (fr, dark) + live language/theme switch');
  const s = await launchShell({ open: ['minesweeper'], lang: 'fr', theme: 'dark' });
  const errs = watchErrors(s);
  const { page } = s;
  try {
    await page.waitForSelector('[data-app="minesweeper"] .ms-cell');
    await sleep(500);

    await test('Minesweeper in French (dark)', async () => {
      const W = winOf('minesweeper');
      assert.equal(await page.locator(`${W} [data-id="difficulty"] .gk-btn-label`).textContent(), 'Débutant');
      assert.equal(await page.locator(`${W} [data-id="new"] .gk-btn-label`).textContent(), 'Nouvelle partie');
      assert.equal(await page.evaluate(() => window.__aurora.wm.byApp('minesweeper')[0].title), 'Démineur');
      await page.evaluate(() => {
        const h = document.querySelector('[data-app="minesweeper"]').__minesweeper;
        const g = h.game;
        h.plant([g.index(1, 0), g.index(5, 1), g.index(8, 2), g.index(0, 4), g.index(3, 6), g.index(7, 5), g.index(8, 8), g.index(4, 8), g.index(1, 8), g.index(6, 7)], g.index(4, 3));
      });
      await page.locator(`${W} .ms-cell[data-i="31"]`).click();
      await sleep(500);
      await page.locator(`${W} .ms-cell[data-i="${1}"]`).click({ button: 'right' });
      await sleep(400);
      await assertNoOverflow(page, 'minesweeper');
      await winShot(s, 'minesweeper', 'minesweeper-dark-fr');
      await page.locator(`${W} [data-id="difficulty"]`).click();
      await sleep(300);
      assert.ok(await page.locator('.menu .menu-item', { hasText: 'Intermédiaire' }).count());
      await winShot(s, 'minesweeper', 'minesweeper-menu-dark-fr');
      await page.keyboard.press('Escape');
      await page.locator(`${W} [data-id="stats"]`).click();
      await page.waitForSelector(`${W} .gk-stats`);
      assert.match(await page.locator(`${W} .gk-stats`).textContent(), /Parties jouées/);
      await sleep(400);
      await winShot(s, 'minesweeper', 'minesweeper-stats-dark-fr');
      await page.locator(`${W} .dialog button`, { hasText: 'Fermer' }).click();
      await sleep(200);
      await page.keyboard.press('F1');
      await page.waitForSelector(`${W} .gk-help`);
      assert.match(await page.locator(`${W} .gk-help`).textContent(), /Raccourcis clavier/);
      await sleep(400);
      await winShot(s, 'minesweeper', 'minesweeper-help-dark-fr');
      await page.keyboard.press('Escape');
      await sleep(200);
    });

    await test('Snake in French (dark)', async () => {
      await page.evaluate(() => window.__aurora.wm.byApp('minesweeper')[0].minimize());
      await page.evaluate(() => window.__aurora.registry.launch('snake'));
      const W = winOf('snake');
      await page.waitForSelector(`${W} canvas`);
      await sleep(600);
      assert.equal(await page.locator(`${W} [data-id="score"] .gk-chip-label`).textContent(), 'Score');
      assert.equal(await page.locator(`${W} [data-id="best"] .gk-chip-label`).textContent(), 'Record');
      assert.match(await page.locator(`${W} .gk-overlay-title`).textContent(), /Prêt/);
      await assertNoOverflow(page, 'snake');
      await winShot(s, 'snake', 'snake-ready-dark-fr');
      await page.locator(`${W} .sn-board`).focus();
      await page.keyboard.press('ArrowUp');
      for (let k = 0; k < 5; k++) {
        await page.evaluate(() => {
          const g = document.querySelector('[data-app="snake"]').__snake.game;
          const dv = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[g.dir];
          g.food = { x: g.snake[0].x + dv[0], y: g.snake[0].y + dv[1], born: 0 };
        });
        await sleep(130);
        if (k === 2) await page.keyboard.press('ArrowRight');
      }
      await sleep(300);
      await winShot(s, 'snake', 'snake-dark-fr');
      await page.keyboard.press('Space');
      await sleep(250);
      assert.match(await page.locator(`${W} .gk-overlay-title`).textContent(), /Pause/);
      await sleep(300);
      await winShot(s, 'snake', 'snake-paused-dark-fr');
      await page.locator(`${W} [data-id="options"]`).click();
      await sleep(300);
      assert.ok(await page.locator('.menu .menu-item', { hasText: 'Bords ouverts' }).count());
      await winShot(s, 'snake', 'snake-options-dark-fr');
      await page.keyboard.press('Escape');
      await sleep(200);
    });

    await test('2048 in French (dark)', async () => {
      await page.evaluate(() => window.__aurora.wm.byApp('snake')[0].minimize());
      await page.evaluate(() => window.__aurora.registry.launch('game2048'));
      const W = winOf('game2048');
      await page.waitForSelector(`${W} .t-tile`);
      await sleep(500);
      assert.equal(await page.locator(`${W} [data-id="undo"] .gk-btn-label`).textContent(), 'Annuler');
      assert.match(await page.locator(`${W} .t-hint`).textContent(), /tuile 2048/);
      await assertTileContrast(page);
      await page.evaluate(() =>
        document.querySelector('[data-app="game2048"]').__game2048.load([[0, 2, 0, 4], [16, 8, 2, 0], [128, 64, 32, 4], [4096, 2048, 1024, 256]], { moves: 900, score: 41260, won: true, keepPlaying: true }),
      );
      await page.locator(`${W} .t-board`).focus();
      await page.keyboard.press('ArrowLeft');
      await sleep(700);
      assert.equal(await page.locator(`${W} .gk-overlay:not([hidden])`).count(), 0, 'mid-game: no overlay in the screenshot');
      await assertNoOverflow(page, 'game2048');
      await winShot(s, 'game2048', 'game2048-dark-fr');
      await page.evaluate(() => window.__aurora.wm.byApp('game2048')[0].setSize(10, 10));
      await sleep(400);
      await assertNoOverflow(page, 'game2048');
      await winShot(s, 'game2048', 'game2048-minsize-dark-fr');
    });

    await test('live switch to English + light updates every game', async () => {
      // A size the user chose for Minesweeper survives the language switch.
      await page.evaluate(() => window.__aurora.wm.byApp('minesweeper')[0].setSize(640, 720));
      await page.evaluate(() => window.__aurora.settings.set('lang', 'en'));
      await page.evaluate(() => window.__aurora.settings.set('theme', 'light'));
      await sleep(900);
      assert.deepEqual(await page.evaluate(() => [window.__aurora.wm.byApp('minesweeper')[0].w, window.__aurora.wm.byApp('minesweeper')[0].h]), [640, 720]);
      assert.equal(await page.locator('[data-app="game2048"] [data-id="undo"] .gk-btn-label').textContent(), 'Undo');
      assert.equal(await page.locator('[data-app="snake"] [data-id="best"] .gk-chip-label').textContent(), 'Best');
      assert.equal(await page.locator('[data-app="minesweeper"] [data-id="difficulty"] .gk-btn-label').textContent(), 'Beginner');
      assert.equal(await page.locator('[data-app="snake"] .gk-overlay-title').textContent(), 'Paused', 'visible overlay re-translated');
      assert.equal(await page.evaluate(() => document.querySelector('[data-app="snake"]').__snake.state), 'paused');
      const bg = await page.evaluate(() => getComputedStyle(document.querySelector('[data-app="game2048"] .t-board')).backgroundColor);
      assert.equal(bg, 'rgb(207, 217, 230)', 'light board palette applied');
      await page.evaluate(() => window.__aurora.wm.byApp('game2048')[0].maximize());
      await sleep(600);
      await winShot(s, 'game2048', 'game2048-maximized-light-en');
    });

    await test('animations off: games still work without motion', async () => {
      await page.evaluate(() => window.__aurora.settings.set('animations', false));
      await sleep(400);
      const W = winOf('game2048');
      await page.evaluate(() => document.querySelector('[data-app="game2048"]').__game2048.load([[2, 2, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], { moves: 1 }));
      await page.locator(`${W} .t-board`).focus();
      await page.keyboard.press('ArrowLeft');
      assert.equal(await page.locator(`${W} .t-tile.merged`).count(), 0, 'no pop class when animations are off');
      assert.equal(await page.locator(`${W} .t-tile`).count(), 2);
    });

    await test('no console errors in French/dark session', async () => {
      assert.deepEqual(errs, []);
    });
  } finally {
    await s.close();
  }
}

// ------------------------------------------------------------------ Damaged saved data + storage that cannot be written
if (!ONLY.length || ONLY.includes('robust')) {
  console.log('Damaged saved data and storage failures');
  const os = await import('node:os');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-games-robust-'));
  const store = path.join(home, '.config', 'aurora', 'apps');
  const put = (app, name, raw) => {
    fs.mkdirSync(path.join(store, app), { recursive: true });
    fs.writeFileSync(path.join(store, app, `${name}.json`), typeof raw === 'string' ? raw : JSON.stringify(raw));
  };
  // Valid JSON of the wrong shape (crashed Minesweeper at launch before), plus impossible values.
  put('minesweeper', 'settings', { custom: null, difficulty: 5, questionMarks: 'yes' });
  put('minesweeper', 'stats', { beginner: { played: 'abc', bestTimes: [{ ms: 'x', date: 'y' }, null, { ms: 5000, date: 1e20 }] }, expert: { played: 4, won: 9 } });
  put('game2048', 'settings', { size: '9', undo: 'x' });
  put('game2048', 'stats', { 4: { bestScore: 'lots', played: -3, bestTile: 3 } });
  put('game2048', 'game', { size: 4, tiles: [{ r: 0, c: 0, value: 2 }, { r: 2, c: 1, value: 8 }], score: 1e400, moves: 2, undo: { size: 5, tiles: [{ r: 4, c: 4, value: 2 }] } });
  // Snake cannot write: its storage folder is a plain file.
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(path.join(store, 'snake'), 'not a folder');
  const s = await launchShell({ open: ['minesweeper', 'game2048', 'snake'], lang: 'en', theme: 'dark', home });
  const errs = watchErrors(s);
  const { page } = s;
  try {
    await page.waitForSelector('[data-app="snake"] canvas');
    await sleep(1200);

    await test('every game starts with sane defaults despite damaged saved data', async () => {
      const crashed = await page.evaluate(() => ['minesweeper', 'snake', 'game2048'].filter((id) => window.__aurora.wm.byApp(id)[0]?.el.querySelector('.win-body > .empty')));
      assert.deepEqual(crashed, []);
      assert.equal(await page.evaluate(() => document.querySelector('[data-app="minesweeper"]').__minesweeper.game.total), 81, 'falls back to Beginner');
      assert.equal(await page.locator('[data-app="minesweeper"] [data-id="mines"] .gk-chip-value').textContent(), '10');
      const g = await page.evaluate(() => {
        const h = document.querySelector('[data-app="game2048"]').__game2048;
        return { size: h.game.size, tiles: h.game.tiles.length, score: h.game.score, canUndo: h.canUndo };
      });
      assert.deepEqual(g, { size: 4, tiles: 2, score: 0, canUndo: false }, 'saved game restored, Infinity score and a 5x5 undo state dropped');
    });

    await test('statistics dialogs show clean numbers (no NaN, no negatives)', async () => {
      for (const id of ['minesweeper', 'snake', 'game2048']) {
        const W = winOf(id);
        await page.evaluate((app) => window.__aurora.wm.byApp(app)[0].focus(), id);
        await sleep(150);
        await page.locator(`${W} [data-id="stats"]`).click();
        await page.waitForSelector(`${W} .gk-stats`, { timeout: 3000 });
        if (id === 'minesweeper') await page.locator(`${W} .gk-stats-picker`).selectOption('expert');
        await sleep(150);
        const txt = await page.locator(`${W} .gk-stats`).textContent();
        assert.doesNotMatch(txt, /NaN|Infinity|-\d|Invalid/, `${id}: ${txt}`);
        if (id === 'minesweeper') assert.equal(await page.locator(`${W} .gk-stat[data-id="won"] .gk-stat-value`).textContent(), '4', 'won <= played');
        await page.locator(`${W} .dialog button`, { hasText: 'Close' }).click();
        await sleep(250);
      }
    });

    await test('a storage write failure is reported once, and the game keeps going', async () => {
      const W = winOf('snake');
      await page.evaluate(() => window.__aurora.wm.byApp('snake')[0].focus());
      await page.locator(`${W} .sn-board`).focus();
      await page.keyboard.press('ArrowUp');
      await sleep(300);
      await page.keyboard.press('n'); // records the run -> save fails
      await sleep(700);
      await page.keyboard.press('ArrowUp');
      await sleep(300);
      await page.keyboard.press('n');
      await sleep(700);
      const notes = await page.evaluate(() => window.__aurora.notifications.list().filter((n) => n.appId === 'snake').map((n) => n.body));
      assert.equal(notes.length, 1, `one notice: ${JSON.stringify(notes)}`);
      assert.match(notes[0], /couldn't be saved/);
      assert.equal(await page.evaluate(() => document.querySelector('[data-app="snake"]').__snake.stats.played), 2, 'stats still tracked in memory');
      assert.equal(await page.evaluate(() => document.querySelector('[data-app="snake"]').__snake.state), 'ready');
    });

    await test('no console errors with damaged data', async () => {
      assert.deepEqual(errs, []);
    });
  } finally {
    await s.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

finish();

function finish() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? `, ${failed.length} FAILED:` : ''}`);
  for (const f of failed) console.log(`  - ${f.name}`);
  process.exit(failed.length ? 1 : 0);
}
