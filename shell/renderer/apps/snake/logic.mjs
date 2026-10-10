// Snake game logic — pure ES module, no DOM. Importable from Node for unit tests.
//
//   const g = createGame({ cols: 22, rows: 16, wrap: false, obstacles: false, rng });
//   queueTurn(g, 'up')          // buffered input (max 3 pending turns, no 180° reversal)
//   const ev = step(g)          // advance one grid step -> { moved, ate, died, reason, won }
//   stepInterval('normal', foodEaten, speedUp) -> milliseconds per step
// Positions are { x, y } grid cells; g.snake[0] is the head.

export const DIRS = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};
const OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left' };

export const SPEEDS = {
  slow: { ms: 165, points: 5 },
  normal: { ms: 115, points: 10 },
  fast: { ms: 80, points: 15 },
  insane: { ms: 52, points: 25 },
};
export const SIZES = {
  small: { cols: 16, rows: 12 },
  medium: { cols: 22, rows: 16 },
  large: { cols: 30, rows: 20 },
};
export const MAX_QUEUE = 3;

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

/** Milliseconds per step. With speedUp, each food eaten makes the game ~2.5% faster (down to 55%). */
export function stepInterval(speed = 'normal', eaten = 0, speedUp = false) {
  const base = (SPEEDS[speed] || SPEEDS.normal).ms;
  if (!speedUp) return base;
  return Math.max(base * 0.55, base * Math.pow(0.975, eaten));
}

export function modeKey({ wrap, obstacles }) {
  return `${wrap ? 'wrap' : 'walls'}${obstacles ? '-obstacles' : ''}`;
}

const key = (x, y) => `${x},${y}`;

export function createGame({ cols = 22, rows = 16, wrap = false, obstacles = false, speed = 'normal', speedUp = false, rng = Math.random, length = 4 } = {}) {
  const y = Math.floor(rows / 2);
  const x0 = Math.max(length, Math.floor(cols / 4) + length - 1);
  const snake = [];
  for (let i = 0; i < length; i++) snake.push({ x: x0 - i, y });
  const g = {
    cols,
    rows,
    wrap,
    speed,
    speedUp,
    rng,
    snake,
    prevTail: { ...snake[snake.length - 1] },
    dir: 'right',
    queue: [],
    obstacles: [],
    obstacleSet: new Set(),
    food: null,
    grow: 0,
    score: 0,
    eaten: 0,
    steps: 0,
    alive: true,
    won: false,
  };
  if (obstacles) placeObstacles(g);
  g.food = placeFood(g);
  return g;
}

export function isOccupied(g, x, y, { ignoreTail = false } = {}) {
  if (g.obstacleSet.has(key(x, y))) return true;
  const n = g.snake.length - (ignoreTail ? 1 : 0);
  for (let i = 0; i < n; i++) if (g.snake[i].x === x && g.snake[i].y === y) return true;
  return false;
}

/** Picks a random free cell for the food, or null when the board is full. */
export function placeFood(g) {
  const used = new Set(g.obstacleSet);
  for (const s of g.snake) used.add(key(s.x, s.y));
  const free = g.cols * g.rows - used.size;
  if (free <= 0) return null;
  let k = Math.floor(g.rng() * free);
  for (let y = 0; y < g.rows; y++)
    for (let x = 0; x < g.cols; x++) {
      if (used.has(key(x, y))) continue;
      if (k-- === 0) return { x, y, born: g.steps };
    }
  return null;
}

/** Buffers a turn. Ignored when it repeats or reverses the last buffered direction. */
export function queueTurn(g, dir) {
  if (!DIRS[dir] || !g.alive) return false;
  const last = g.queue.length ? g.queue[g.queue.length - 1] : g.dir;
  if (dir === last || dir === OPPOSITE[last]) return false;
  if (g.queue.length >= MAX_QUEUE) return false;
  g.queue.push(dir);
  return true;
}

/** Advances the snake by one cell. */
export function step(g) {
  const ev = { moved: false, ate: false, died: false, reason: null, won: false };
  if (!g.alive || g.won) return ev;
  if (g.queue.length) g.dir = g.queue.shift();
  const d = DIRS[g.dir];
  const head = g.snake[0];
  let nx = head.x + d.x;
  let ny = head.y + d.y;
  if (g.wrap) {
    nx = (nx + g.cols) % g.cols;
    ny = (ny + g.rows) % g.rows;
  } else if (nx < 0 || ny < 0 || nx >= g.cols || ny >= g.rows) {
    g.alive = false;
    ev.died = true;
    ev.reason = 'wall';
    return ev;
  }
  if (g.obstacleSet.has(key(nx, ny))) {
    g.alive = false;
    ev.died = true;
    ev.reason = 'obstacle';
    return ev;
  }
  // The tail cell becomes free this step unless the snake is growing.
  const bodyLen = g.snake.length - (g.grow === 0 ? 1 : 0);
  let hitSelf = false;
  for (let i = 0; i < bodyLen && !hitSelf; i++) hitSelf = g.snake[i].x === nx && g.snake[i].y === ny;
  if (hitSelf) {
    g.alive = false;
    ev.died = true;
    ev.reason = 'self';
    return ev;
  }
  g.prevTail = { ...g.snake[g.snake.length - 1] };
  g.snake.unshift({ x: nx, y: ny });
  if (g.grow > 0) g.grow--;
  else g.snake.pop();
  g.steps++;
  ev.moved = true;
  if (g.food && g.food.x === nx && g.food.y === ny) {
    ev.ate = true;
    g.eaten++;
    g.score += (SPEEDS[g.speed] || SPEEDS.normal).points;
    g.grow += 1;
    g.food = placeFood(g);
    // No free cell left for food: the snake fills the board.
    if (!g.food) {
      g.won = true;
      ev.won = true;
    }
  }
  return ev;
}

// ---------------------------------------------------------------- obstacles
function neighbors4(g, x, y) {
  const out = [];
  for (const d of Object.values(DIRS)) {
    let nx = x + d.x;
    let ny = y + d.y;
    if (g.wrap) {
      nx = (nx + g.cols) % g.cols;
      ny = (ny + g.rows) % g.rows;
    } else if (nx < 0 || ny < 0 || nx >= g.cols || ny >= g.rows) continue;
    out.push([nx, ny]);
  }
  return out;
}

/** True when every free cell can be reached from every other free cell. */
export function freeCellsConnected(g, blocked) {
  let start = null;
  let free = 0;
  for (let y = 0; y < g.rows; y++)
    for (let x = 0; x < g.cols; x++)
      if (!blocked.has(key(x, y))) {
        free++;
        if (!start) start = [x, y];
      }
  if (!start) return false;
  const seen = new Set([key(...start)]);
  const q = [start];
  while (q.length) {
    const [x, y] = q.pop();
    for (const [nx, ny] of neighbors4(g, x, y)) {
      const k = key(nx, ny);
      if (blocked.has(k) || seen.has(k)) continue;
      seen.add(k);
      q.push([nx, ny]);
    }
  }
  return seen.size === free;
}

/** Scatters short wall segments, keeping the snake's lane clear and the board fully connected. */
export function placeObstacles(g) {
  const target = Math.round((g.cols * g.rows) / 28);
  const head = g.snake[0];
  const reserved = new Set();
  // Keep the starting row (and the rows next to it) clear ahead of the snake.
  for (let x = 0; x < g.cols; x++) for (let dy = -1; dy <= 1; dy++) reserved.add(key(x, head.y + dy));
  for (const s of g.snake) reserved.add(key(s.x, s.y));
  for (let attempt = 0; attempt < 40; attempt++) {
    const blocked = new Set();
    let guard = 0;
    while (blocked.size < target && guard++ < 400) {
      const horiz = g.rng() < 0.5;
      const len = 2 + Math.floor(g.rng() * 3);
      const x = Math.floor(g.rng() * g.cols);
      const y = Math.floor(g.rng() * g.rows);
      const cells = [];
      for (let i = 0; i < len; i++) cells.push(horiz ? [x + i, y] : [x, y + i]);
      if (cells.some(([cx, cy]) => cx >= g.cols || cy >= g.rows || reserved.has(key(cx, cy)))) continue;
      // Keep a one-cell margin along the outer walls so corners never become dead ends.
      if (!g.wrap && cells.some(([cx, cy]) => cx === 0 || cy === 0 || cx === g.cols - 1 || cy === g.rows - 1)) continue;
      for (const [cx, cy] of cells) blocked.add(key(cx, cy));
    }
    if (freeCellsConnected(g, blocked)) {
      g.obstacleSet = blocked;
      g.obstacles = [...blocked].map((k) => {
        const [x, y] = k.split(',').map(Number);
        return { x, y };
      });
      return g.obstacles;
    }
  }
  g.obstacleSet = new Set();
  g.obstacles = [];
  return g.obstacles;
}

// ---------------------------------------------------------------- statistics (pure helpers)
export function emptyStats() {
  return { played: 0, foodEaten: 0, totalMs: 0, totalScore: 0, longest: 0, best: {} };
}

export function recordGame(stats, { score, eaten, length, ms, mode }) {
  const s = { ...emptyStats(), ...(stats || {}) };
  s.best = { ...(s.best || {}) };
  s.played++;
  s.foodEaten += eaten || 0;
  s.totalMs += Math.max(0, ms || 0);
  s.totalScore += score || 0;
  s.longest = Math.max(s.longest, length || 0);
  const prev = s.best[mode] || 0;
  const record = score > prev;
  if (record) s.best[mode] = score;
  return { stats: s, record };
}
