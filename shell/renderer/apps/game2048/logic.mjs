// 2048 game logic — pure ES module, no DOM. Importable from Node for unit tests.
//
//   slideLine([2, 2, 2, 2])  -> { line: [4, 4, 0, 0], gained: 8 }      (towards index 0)
//   const g = newGame(4, rng)                       // two random tiles
//   const r = move(g, 'left', rng)                  // -> { moved, gained, moves, merges, spawned }
//   canMove(g), hasWon(g), maxTile(g), toGrid(g)
// Tiles are { id, value, r, c }. Every tile merges at most once per move, and the tiles closest
// to the edge the board is pushed towards merge first (leftmost on a left move, topmost on up…).

export const WIN_VALUE = 2048;
export const SIZES = [4, 5, 6];

export function seededRng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pure line slide towards index 0 (0 = empty). */
export function slideLine(values) {
  const tiles = values.filter((v) => v);
  const out = [];
  let gained = 0;
  for (let i = 0; i < tiles.length; i++) {
    if (i + 1 < tiles.length && tiles[i] === tiles[i + 1]) {
      out.push(tiles[i] * 2);
      gained += tiles[i] * 2;
      i++;
    } else out.push(tiles[i]);
  }
  while (out.length < values.length) out.push(0);
  return { line: out, gained };
}

export function emptyGame(size = 4) {
  return { size, tiles: [], score: 0, nextId: 1, won: false, keepPlaying: false, over: false, moves: 0 };
}

export function cloneGame(g) {
  return { ...g, tiles: g.tiles.map((t) => ({ ...t })) };
}

export function toGrid(g) {
  const grid = Array.from({ length: g.size }, () => Array(g.size).fill(0));
  for (const t of g.tiles) grid[t.r][t.c] = t.value;
  return grid;
}

/** Builds a game from a grid of values (tests, restoring saved games). */
export function fromGrid(grid, extra = {}) {
  const g = emptyGame(grid.length);
  grid.forEach((row, r) =>
    row.forEach((v, c) => {
      if (v) g.tiles.push({ id: g.nextId++, value: v, r, c });
    }),
  );
  return Object.assign(g, extra);
}

export function emptyCells(g) {
  const used = new Set(g.tiles.map((t) => t.r * g.size + t.c));
  const out = [];
  for (let i = 0; i < g.size * g.size; i++) if (!used.has(i)) out.push({ r: Math.floor(i / g.size), c: i % g.size });
  return out;
}

/** Adds a 2 (90%) or 4 (10%) on a random empty cell. Returns the tile or null. */
export function spawnTile(g, rng = Math.random) {
  const cells = emptyCells(g);
  if (!cells.length) return null;
  const cell = cells[Math.floor(rng() * cells.length)];
  const tile = { id: g.nextId++, value: rng() < 0.9 ? 2 : 4, r: cell.r, c: cell.c };
  g.tiles.push(tile);
  return tile;
}

export function newGame(size = 4, rng = Math.random) {
  const g = emptyGame(size);
  spawnTile(g, rng);
  spawnTile(g, rng);
  return g;
}

// For a direction, returns the list of lines; each line lists [r, c] cells ordered from the
// edge the tiles move towards.
function linesFor(size, dir) {
  const lines = [];
  for (let k = 0; k < size; k++) {
    const line = [];
    for (let j = 0; j < size; j++) {
      if (dir === 'left') line.push([k, j]);
      else if (dir === 'right') line.push([k, size - 1 - j]);
      else if (dir === 'up') line.push([j, k]);
      else line.push([size - 1 - j, k]);
    }
    lines.push(line);
  }
  return lines;
}

/**
 * Applies a move in place. Returns:
 *   moved    false when nothing changed (no tile spawns then)
 *   gained   points earned by merges
 *   moves    [{ id, from: {r,c}, to: {r,c} }] for every tile that changes cell (incl. merged sources)
 *   merges   [{ id, value, r, c, from: [idA, idB] }] the new merged tiles
 *   spawned  the new random tile (or null)
 */
export function move(g, dir, rng = Math.random, { spawn = true } = {}) {
  const res = { moved: false, gained: 0, moves: [], merges: [], spawned: null };
  if (!['left', 'right', 'up', 'down'].includes(dir)) return res;
  const at = new Map(g.tiles.map((t) => [t.r * g.size + t.c, t]));
  const next = [];
  for (const line of linesFor(g.size, dir)) {
    const tiles = line.map(([r, c]) => at.get(r * g.size + c)).filter(Boolean);
    let pos = 0;
    for (let i = 0; i < tiles.length; i++) {
      const a = tiles[i];
      const b = tiles[i + 1];
      const [tr, tc] = line[pos];
      if (b && a.value === b.value) {
        const merged = { id: g.nextId++, value: a.value * 2, r: tr, c: tc };
        for (const src of [a, b]) res.moves.push({ id: src.id, from: { r: src.r, c: src.c }, to: { r: tr, c: tc } });
        res.merges.push({ ...merged, from: [a.id, b.id] });
        res.gained += merged.value;
        next.push(merged);
        i++;
      } else {
        if (a.r !== tr || a.c !== tc) res.moves.push({ id: a.id, from: { r: a.r, c: a.c }, to: { r: tr, c: tc } });
        next.push({ ...a, r: tr, c: tc });
      }
      pos++;
    }
  }
  res.moved = res.moves.length > 0;
  if (!res.moved) return res;
  g.tiles = next;
  g.score += res.gained;
  g.moves = (g.moves || 0) + 1;
  if (!g.won && g.tiles.some((t) => t.value >= WIN_VALUE)) g.won = true;
  if (spawn) res.spawned = spawnTile(g, rng);
  g.over = !canMove(g);
  return res;
}

export function canMove(g) {
  if (g.tiles.length < g.size * g.size) return true;
  const grid = toGrid(g);
  for (let r = 0; r < g.size; r++)
    for (let c = 0; c < g.size; c++) {
      const v = grid[r][c];
      if ((c + 1 < g.size && grid[r][c + 1] === v) || (r + 1 < g.size && grid[r + 1][c] === v)) return true;
    }
  return false;
}

export function maxTile(g) {
  return g.tiles.reduce((m, t) => Math.max(m, t.value), 0);
}

// ---------------------------------------------------------------- statistics (pure helpers)
export function emptyStats() {
  return { played: 0, won: 0, currentStreak: 0, longestStreak: 0, bestScore: 0, bestTile: 0, totalScore: 0 };
}

/** Records a finished or abandoned game (per board size). */
export function recordGame(stats, { won, score, tile }) {
  const s = { ...emptyStats(), ...(stats || {}) };
  s.played++;
  s.totalScore += score || 0;
  if (won) {
    s.won++;
    s.currentStreak++;
    s.longestStreak = Math.max(s.longestStreak, s.currentStreak);
  } else s.currentStreak = 0;
  s.bestScore = Math.max(s.bestScore, score || 0);
  s.bestTile = Math.max(s.bestTile, tile || 0);
  return s;
}
