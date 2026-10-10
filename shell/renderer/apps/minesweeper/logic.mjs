// Minesweeper game logic — pure ES module, no DOM. Importable from Node for unit tests:
//   import { Minesweeper, DIFFICULTIES } from '.../apps/minesweeper/logic.mjs';
//
//   const g = new Minesweeper({ cols: 9, rows: 9, mines: 10, rng: Math.random });
//   g.reveal(index)   -> { revealed: [{ i, d }], exploded: index|null, won: bool }   (d = flood-fill depth)
//   g.chord(index)    -> same shape (reveals the neighbours of a satisfied number)
//   g.toggleMark(index, allowQuestion) -> new mark ('flag' | 'question' | 'none') or null
//   g.status          -> 'ready' (no click yet) | 'playing' | 'won' | 'lost'
// Cells are addressed by index = y * cols + x.

export const DIFFICULTIES = {
  beginner: { cols: 9, rows: 9, mines: 10 },
  intermediate: { cols: 16, rows: 16, mines: 40 },
  expert: { cols: 30, rows: 16, mines: 99 },
};

export const CUSTOM_LIMITS = { minCols: 5, maxCols: 40, minRows: 5, maxRows: 24, minMines: 1 };

/** Highest mine count allowed on a board (the first click must open at least a 3x3 area). */
export function maxMines(cols, rows) {
  return Math.max(CUSTOM_LIMITS.minMines, cols * rows - 9);
}

/** Validates a custom board. Returns null when valid, or { field, min, max } describing the problem. */
export function validateCustom({ cols, rows, mines }) {
  const L = CUSTOM_LIMITS;
  const isInt = (v) => Number.isInteger(v);
  if (!isInt(cols) || cols < L.minCols || cols > L.maxCols) return { field: 'cols', min: L.minCols, max: L.maxCols };
  if (!isInt(rows) || rows < L.minRows || rows > L.maxRows) return { field: 'rows', min: L.minRows, max: L.maxRows };
  const mm = maxMines(cols, rows);
  if (!isInt(mines) || mines < L.minMines || mines > mm) return { field: 'mines', min: L.minMines, max: mm };
  return null;
}

/** Small deterministic PRNG (mulberry32) for reproducible tests. */
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

export class Minesweeper {
  constructor({ cols = 9, rows = 9, mines = 10, rng = Math.random } = {}) {
    this.cols = cols;
    this.rows = rows;
    this.total = cols * rows;
    this.mineCount = Math.min(mines, this.total - 1);
    this.rng = rng;
    this.status = 'ready';
    this.exploded = null;
    this.revealedCount = 0;
    this.flagCount = 0;
    this.minesPlaced = false;
    this.cells = Array.from({ length: this.total }, () => ({ mine: false, adj: 0, state: 'hidden' }));
  }

  xy(i) {
    return { x: i % this.cols, y: Math.floor(i / this.cols) };
  }
  index(x, y) {
    return y * this.cols + x;
  }
  inside(x, y) {
    return x >= 0 && y >= 0 && x < this.cols && y < this.rows;
  }
  neighbors(i) {
    const { x, y } = this.xy(i);
    const out = [];
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (this.inside(nx, ny)) out.push(this.index(nx, ny));
      }
    return out;
  }

  get minesLeft() {
    return this.mineCount - this.flagCount;
  }
  get over() {
    return this.status === 'won' || this.status === 'lost';
  }

  /** Places the mines avoiding `safe` and, when the board allows it, all of its neighbours too,
   *  so the first click always opens an area. Can be given an explicit list for tests. */
  placeMines(safe, explicit = null) {
    const forbidden = new Set([safe]);
    if (this.total - this.mineCount >= 9) for (const n of this.neighbors(safe)) forbidden.add(n);
    // Not enough room for a 3x3 opening: keep only the clicked cell safe.
    if (this.total - forbidden.size < this.mineCount) forbidden.clear(), forbidden.add(safe);
    let mines;
    if (explicit) mines = explicit.filter((i) => !forbidden.has(i));
    else {
      const pool = [];
      for (let i = 0; i < this.total; i++) if (!forbidden.has(i)) pool.push(i);
      // Partial Fisher–Yates shuffle.
      for (let k = 0; k < this.mineCount; k++) {
        const j = k + Math.floor(this.rng() * (pool.length - k));
        [pool[k], pool[j]] = [pool[j], pool[k]];
      }
      mines = pool.slice(0, this.mineCount);
    }
    this.mineCount = mines.length;
    for (const i of mines) this.cells[i].mine = true;
    for (let i = 0; i < this.total; i++) this.cells[i].adj = this.neighbors(i).reduce((n, j) => n + (this.cells[j].mine ? 1 : 0), 0);
    this.minesPlaced = true;
  }

  /** Reveal one cell. On an already revealed number this acts as a chord. */
  reveal(i) {
    const none = { revealed: [], exploded: null, won: false };
    if (this.over || i < 0 || i >= this.total) return none;
    const c = this.cells[i];
    if (c.state === 'revealed') return this.chord(i);
    if (c.state === 'flag') return none;
    if (!this.minesPlaced) this.placeMines(i);
    if (this.status === 'ready') this.status = 'playing';
    return this._open([i]);
  }

  /** Chording: on a revealed number whose flagged neighbours match it, reveal the other neighbours. */
  chord(i) {
    const none = { revealed: [], exploded: null, won: false };
    if (this.over || this.status !== 'playing') return none;
    const c = this.cells[i];
    if (c.state !== 'revealed' || c.adj === 0) return none;
    const ns = this.neighbors(i);
    const flags = ns.filter((j) => this.cells[j].state === 'flag').length;
    if (flags !== c.adj) return none;
    const targets = ns.filter((j) => this.cells[j].state === 'hidden' || this.cells[j].state === 'question');
    if (!targets.length) return none;
    return this._open(targets);
  }

  /** Neighbours that a chord on i would reveal (used to show the "pressed" preview). */
  chordTargets(i) {
    const c = this.cells[i];
    if (!c || c.state !== 'revealed') return [];
    return this.neighbors(i).filter((j) => this.cells[j].state === 'hidden' || this.cells[j].state === 'question');
  }

  // Breadth-first flood fill from the given start cells. Returns cells in reveal order with depth.
  _open(starts) {
    const revealed = [];
    let exploded = null;
    const queue = [];
    const seen = new Set();
    for (const s of starts) {
      queue.push([s, 0]);
      seen.add(s);
    }
    while (queue.length) {
      const [i, d] = queue.shift();
      const c = this.cells[i];
      if (c.state === 'revealed' || c.state === 'flag') continue;
      if (c.state === 'question') c.state = 'hidden';
      c.state = 'revealed';
      this.revealedCount++;
      revealed.push({ i, d });
      if (c.mine) {
        if (exploded == null) exploded = i;
        continue;
      }
      if (c.adj === 0) {
        for (const n of this.neighbors(i)) {
          if (seen.has(n)) continue;
          const nc = this.cells[n];
          if (nc.state === 'hidden' || nc.state === 'question') {
            seen.add(n);
            queue.push([n, d + 1]);
          }
        }
      }
    }
    if (exploded != null) {
      this.status = 'lost';
      this.exploded = exploded;
      return { revealed, exploded, won: false };
    }
    const won = this.revealedCount === this.total - this.mineCount;
    if (won) {
      this.status = 'won';
      // Like the classic game, every remaining mine gets flagged automatically.
      for (const c of this.cells) {
        if (c.mine && c.state !== 'flag') {
          c.state = 'flag';
          this.flagCount++;
        }
      }
    }
    return { revealed, exploded: null, won };
  }

  /** Cycles hidden -> flag -> question (if allowed) -> hidden. Returns the new mark or null. */
  toggleMark(i, allowQuestion = true) {
    if (this.over || i < 0 || i >= this.total) return null;
    const c = this.cells[i];
    if (c.state === 'revealed') return null;
    if (c.state === 'hidden') {
      c.state = 'flag';
      this.flagCount++;
      return 'flag';
    }
    if (c.state === 'flag') {
      this.flagCount--;
      c.state = allowQuestion ? 'question' : 'hidden';
      return allowQuestion ? 'question' : 'none';
    }
    c.state = 'hidden';
    return 'none';
  }

  /** After a loss: indices of mines to show (not flagged) and flags that were wrong. */
  lossReport() {
    const mines = [];
    const wrongFlags = [];
    this.cells.forEach((c, i) => {
      if (c.mine && c.state !== 'flag' && i !== this.exploded) mines.push(i);
      if (!c.mine && c.state === 'flag') wrongFlags.push(i);
    });
    return { mines, wrongFlags };
  }
}

// ---------------------------------------------------------------- statistics (pure helpers)
export function emptyStats() {
  return { played: 0, won: 0, currentStreak: 0, longestStreak: 0, bestTimes: [], totalMs: 0 };
}

/** Returns a new stats object for one difficulty after a finished (or abandoned) game. */
export function recordGame(stats, { won, ms = 0, date = Date.now() }) {
  const s = { ...emptyStats(), ...(stats || {}) };
  s.bestTimes = [...(s.bestTimes || [])];
  s.played++;
  s.totalMs += Math.max(0, ms);
  let rank = -1;
  if (won) {
    s.won++;
    s.currentStreak++;
    s.longestStreak = Math.max(s.longestStreak, s.currentStreak);
    s.bestTimes.push({ ms, date });
    s.bestTimes.sort((a, b) => a.ms - b.ms);
    s.bestTimes = s.bestTimes.slice(0, 5);
    rank = s.bestTimes.findIndex((b) => b.ms === ms && b.date === date);
  } else s.currentStreak = 0;
  return { stats: s, rank };
}

export function winRate(s) {
  return s && s.played ? Math.round((s.won / s.played) * 100) : 0;
}
