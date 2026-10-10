// Aurora Chess — computer player. Pure ES module (runs in the Web Worker and in node tests).
//
//   const engine = new Engine();
//   const res = engine.think(position, { level: 'medium', history: ['e2e4', 'e7e5'] });
//   -> { move: 'g1f3', score, mate, depth, nodes, pv: ['g1f3', …], book, time }
//
// Search: negamax alpha-beta with iterative deepening, principal variation search, transposition
// table, null-move pruning, late-move reductions, check extensions and a quiescence search.
// Move ordering: TT move, MVV-LVA captures, promotions, two killer moves per ply, history heuristic.
// Evaluation: tapered (middlegame/endgame) material + piece-square tables, pawn structure,
// mobility, bishop pair, rooks on open files, king shelter and a "mop-up" term to finish endgames.
import { Position, SQUARES, WHITE, BLACK, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING, F_CAPTURE, F_PROMO, moveToUci, START_FEN } from './engine.mjs';

export const LEVEL_IDS = ['beginner', 'easy', 'medium', 'hard', 'expert'];

// depth: maximum nominal depth ; time: thinking budget (ms) ; rootNoise: random centipawns added to
// every root move (exact root scores, low levels) ; evalNoise: deterministic per-position noise ;
// book: use the opening book.
export const LEVELS = {
  beginner: { depth: 1, time: 350, rootNoise: 240, evalNoise: 0, book: false },
  easy: { depth: 2, time: 600, rootNoise: 90, evalNoise: 0, book: true },
  medium: { depth: 4, time: 800, rootNoise: 0, evalNoise: 30, book: true },
  hard: { depth: 64, time: 1500, rootNoise: 0, evalNoise: 0, book: true },
  expert: { depth: 64, time: 3500, rootNoise: 0, evalNoise: 0, book: true },
};

export const MATE = 30000;
const MATE_BOUND = MATE - 1000;
const INF = 32000;
const MAX_PLY = 96;

// ---------------------------------------------------------------- evaluation tables
// Middlegame / endgame piece values (index = piece type).
const MG_VAL = [0, 85, 330, 350, 480, 1000, 0];
const EG_VAL = [0, 105, 290, 310, 530, 950, 0];
const PHASE_W = [0, 0, 1, 1, 2, 4, 0];
const ORDER_VAL = [0, 100, 320, 330, 500, 900, 2000];

// Piece-square tables from White's point of view, a8..h8 first (row 0 = rank 8).
// prettier-ignore
const PST_MG = [
  null,
  [ // pawn
     0,  0,  0,  0,  0,  0,  0,  0,
    55, 60, 60, 60, 60, 60, 60, 55,
    14, 16, 26, 34, 34, 26, 16, 14,
     5,  6, 12, 27, 27, 12,  6,  5,
     0,  0,  6, 22, 22,  4,  0,  0,
     5, -3, -6,  4,  4, -8, -3,  5,
     5, 10, 10,-22,-22, 12, 10,  5,
     0,  0,  0,  0,  0,  0,  0,  0],
  [ // knight
    -50,-40,-30,-30,-30,-30,-40,-50,
    -40,-20,  0,  4,  4,  0,-20,-40,
    -30,  4, 12, 16, 16, 12,  4,-30,
    -30,  6, 16, 22, 22, 16,  6,-30,
    -30,  0, 15, 20, 20, 15,  0,-30,
    -30,  5, 12, 14, 14, 12,  5,-30,
    -40,-20,  0,  5,  5,  0,-20,-40,
    -50,-34,-30,-30,-30,-30,-34,-50],
  [ // bishop
    -20,-10,-10,-10,-10,-10,-10,-20,
    -10,  0,  0,  0,  0,  0,  0,-10,
    -10,  0,  5, 10, 10,  5,  0,-10,
    -10,  5,  5, 10, 10,  5,  5,-10,
    -10,  0, 10, 12, 12, 10,  0,-10,
    -10, 10, 10, 10, 10, 10, 10,-10,
    -10, 12,  0,  2,  2,  0, 12,-10,
    -20,-10,-12,-10,-10,-12,-10,-20],
  [ // rook
      0,  0,  0,  0,  0,  0,  0,  0,
      8, 12, 12, 12, 12, 12, 12,  8,
     -5,  0,  0,  0,  0,  0,  0, -5,
     -5,  0,  0,  0,  0,  0,  0, -5,
     -5,  0,  0,  0,  0,  0,  0, -5,
     -5,  0,  0,  0,  0,  0,  0, -5,
     -5,  0,  0,  0,  0,  0,  0, -5,
     -2, -2,  2,  8,  8,  6, -2, -2],
  [ // queen
    -20,-10,-10, -5, -5,-10,-10,-20,
    -10,  0,  0,  0,  0,  0,  0,-10,
    -10,  0,  5,  5,  5,  5,  0,-10,
     -5,  0,  5,  5,  5,  5,  0, -5,
      0,  0,  5,  5,  5,  5,  0, -5,
    -10,  5,  5,  5,  5,  5,  0,-10,
    -10,  0,  5,  0,  0,  0,  0,-10,
    -20,-10,-10, -2, -5,-10,-10,-20],
  [ // king
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -20,-30,-30,-40,-40,-30,-30,-20,
    -10,-20,-20,-24,-24,-20,-20,-10,
     16, 14, -6,-12,-12, -6, 14, 16,
     18, 32, 12, -4,  0,  8, 34, 20],
];
// prettier-ignore
const PST_EG = [
  null,
  [ // pawn: advancing matters more in the endgame
     0,  0,  0,  0,  0,  0,  0,  0,
    95, 95, 90, 85, 85, 90, 95, 95,
    55, 55, 50, 45, 45, 50, 55, 55,
    30, 30, 26, 22, 22, 26, 30, 30,
    14, 14, 12, 10, 10, 12, 14, 14,
     5,  5,  4,  2,  2,  4,  5,  5,
     0,  0,  0,  0,  0,  0,  0,  0,
     0,  0,  0,  0,  0,  0,  0,  0],
  [ // knight
    -50,-40,-30,-30,-30,-30,-40,-50,
    -40,-20,  0,  0,  0,  0,-20,-40,
    -30,  0, 10, 15, 15, 10,  0,-30,
    -30,  5, 15, 20, 20, 15,  5,-30,
    -30,  0, 15, 20, 20, 15,  0,-30,
    -30,  5, 10, 15, 15, 10,  5,-30,
    -40,-20,  0,  5,  5,  0,-20,-40,
    -50,-40,-30,-30,-30,-30,-40,-50],
  [ // bishop
    -14, -8, -8, -6, -6, -8, -8,-14,
     -8,  0,  0,  0,  0,  0,  0, -8,
     -8,  0,  6,  8,  8,  6,  0, -8,
     -6,  2,  8, 10, 10,  8,  2, -6,
     -6,  2,  8, 10, 10,  8,  2, -6,
     -8,  0,  6,  8,  8,  6,  0, -8,
     -8,  0,  0,  0,  0,  0,  0, -8,
    -14, -8, -8, -6, -6, -8, -8,-14],
  [ // rook
      6,  6,  6,  6,  6,  6,  6,  6,
     10, 12, 12, 12, 12, 12, 12, 10,
      0,  0,  0,  0,  0,  0,  0,  0,
      0,  0,  0,  0,  0,  0,  0,  0,
      0,  0,  0,  0,  0,  0,  0,  0,
      0,  0,  0,  0,  0,  0,  0,  0,
      0,  0,  0,  0,  0,  0,  0,  0,
      0,  0,  0,  0,  0,  0,  0,  0],
  [ // queen
    -16,-10, -8, -6, -6, -8,-10,-16,
    -10,  0,  4,  6,  6,  4,  0,-10,
     -8,  4, 10, 12, 12, 10,  4, -8,
     -6,  6, 12, 16, 16, 12,  6, -6,
     -6,  6, 12, 16, 16, 12,  6, -6,
     -8,  4, 10, 12, 12, 10,  4, -8,
    -10,  0,  4,  6,  6,  4,  0,-10,
    -16,-10, -8, -6, -6, -8,-10,-16],
  [ // king: centralise
    -50,-40,-30,-20,-20,-30,-40,-50,
    -30,-20,-10,  0,  0,-10,-20,-30,
    -30,-10, 20, 30, 30, 20,-10,-30,
    -30,-10, 30, 40, 40, 30,-10,-30,
    -30,-10, 30, 40, 40, 30,-10,-30,
    -30,-10, 20, 30, 30, 20,-10,-30,
    -30,-30,  0,  0,  0,  0,-30,-30,
    -50,-30,-30,-30,-30,-30,-30,-50],
];

// Precomputed per piece code (0..15) and 0x88 square: material + PST, for MG and EG.
const MG = new Int16Array(16 * 128);
const EG = new Int16Array(16 * 128);
for (let type = 1; type <= 6; type++) {
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const sq = r * 16 + f;
      const wi = r * 8 + f; // white reads the table as is
      const bi = (7 - r) * 8 + f; // black mirrors vertically
      MG[type * 128 + sq] = MG_VAL[type] + PST_MG[type][wi];
      EG[type * 128 + sq] = EG_VAL[type] + PST_EG[type][wi];
      MG[(type | 8) * 128 + sq] = MG_VAL[type] + PST_MG[type][bi];
      EG[(type | 8) * 128 + sq] = EG_VAL[type] + PST_EG[type][bi];
    }
  }
}
const PASSED_MG = [0, 60, 40, 24, 14, 8, 4, 0]; // by row from the pawn's own side (index = rows to go)
const PASSED_EG = [0, 150, 100, 60, 34, 18, 10, 0];
const KNIGHT_OFFS = [-33, -31, -18, -14, 14, 18, 31, 33];
const BISHOP_OFFS = [-17, -15, 15, 17];
const ROOK_OFFS = [-16, -1, 1, 16];
const CENTER_DIST = (sq) => {
  const r = sq >> 4;
  const f = sq & 7;
  return Math.max(3 - r, r - 4) + Math.max(3 - f, f - 4);
};

// Static evaluation in centipawns from the side to move's point of view.
export function evaluate(pos) {
  const b = pos.board;
  let mg = 0;
  let eg = 0;
  let phase = 0;
  const pawnsOnFile = [new Int8Array(8), new Int8Array(8)];
  const wMaxRow = new Int8Array(8).fill(-1); // most backward white pawn row per file (largest row)
  const bMinRow = new Int8Array(8).fill(8); // most backward black pawn row per file (smallest row)
  const wMinRow = new Int8Array(8).fill(8); // most advanced white pawn per file
  const bMaxRow = new Int8Array(8).fill(-1); // most advanced black pawn per file
  let bishops0 = 0;
  let bishops1 = 0;
  let nonPawn0 = 0;
  let nonPawn1 = 0;
  for (let i = 0; i < 64; i++) {
    const sq = SQUARES[i];
    const p = b[sq];
    if (!p) continue;
    const t = p & 7;
    const c = p >> 3;
    const s = c === WHITE ? 1 : -1;
    mg += s * MG[p * 128 + sq];
    eg += s * EG[p * 128 + sq];
    phase += PHASE_W[t];
    if (t === PAWN) {
      const f = sq & 7;
      const r = sq >> 4;
      pawnsOnFile[c][f]++;
      if (c === WHITE) {
        if (r > wMaxRow[f]) wMaxRow[f] = r;
        if (r < wMinRow[f]) wMinRow[f] = r;
      } else {
        if (r < bMinRow[f]) bMinRow[f] = r;
        if (r > bMaxRow[f]) bMaxRow[f] = r;
      }
    } else if (t !== KING) {
      if (c === WHITE) nonPawn0 += ORDER_VAL[t];
      else nonPawn1 += ORDER_VAL[t];
      if (t === BISHOP) {
        if (c === WHITE) bishops0++;
        else bishops1++;
      }
    }
  }

  // Pieces: mobility, rooks on open files.
  for (let i = 0; i < 64; i++) {
    const sq = SQUARES[i];
    const p = b[sq];
    if (!p) continue;
    const t = p & 7;
    if (t === PAWN || t === KING) continue;
    const c = p >> 3;
    const s = c === WHITE ? 1 : -1;
    let mob = 0;
    if (t === KNIGHT) {
      for (let k = 0; k < 8; k++) {
        const to = sq + KNIGHT_OFFS[k];
        if (to & 0x88) continue;
        const q = b[to];
        if (!q || q >> 3 !== c) mob++;
      }
      mg += s * (mob - 4) * 4;
      eg += s * (mob - 4) * 4;
    } else {
      const offs = t === BISHOP ? BISHOP_OFFS : t === ROOK ? ROOK_OFFS : null;
      const dirs = offs || [-17, -16, -15, -1, 1, 15, 16, 17];
      for (let k = 0; k < dirs.length; k++) {
        const d = dirs[k];
        let to = sq + d;
        while (!(to & 0x88)) {
          const q = b[to];
          if (!q) mob++;
          else {
            if (q >> 3 !== c) mob++;
            break;
          }
          to += d;
        }
      }
      if (t === BISHOP) {
        mg += s * (mob - 6) * 4;
        eg += s * (mob - 6) * 5;
      } else if (t === ROOK) {
        mg += s * (mob - 7) * 2;
        eg += s * (mob - 7) * 4;
        const f = sq & 7;
        const own = pawnsOnFile[c][f];
        const opp = pawnsOnFile[c ^ 1][f];
        if (!own) {
          mg += s * (opp ? 10 : 22);
          eg += s * (opp ? 6 : 12);
        }
      } else {
        mg += s * (mob - 13) * 1;
        eg += s * (mob - 13) * 2;
      }
    }
  }

  // Pawn structure.
  for (let f = 0; f < 8; f++) {
    for (let c = 0; c < 2; c++) {
      const n = pawnsOnFile[c][f];
      if (!n) continue;
      const s = c === WHITE ? 1 : -1;
      if (n > 1) {
        mg -= s * 10 * (n - 1);
        eg -= s * 22 * (n - 1);
      }
      const left = f > 0 ? pawnsOnFile[c][f - 1] : 0;
      const right = f < 7 ? pawnsOnFile[c][f + 1] : 0;
      if (!left && !right) {
        mg -= s * 12 * n;
        eg -= s * 14 * n;
      }
    }
    // Passed pawns (the most advanced pawn of each file).
    if (wMinRow[f] < 8) {
      const r = wMinRow[f];
      let passed = true;
      for (let g = Math.max(0, f - 1); g <= Math.min(7, f + 1); g++) if (bMinRow[g] < r) passed = false;
      if (passed) {
        mg += PASSED_MG[r];
        eg += PASSED_EG[r];
      }
    }
    if (bMaxRow[f] >= 0) {
      const r = bMaxRow[f];
      let passed = true;
      for (let g = Math.max(0, f - 1); g <= Math.min(7, f + 1); g++) if (wMaxRow[g] > r) passed = false;
      if (passed) {
        mg -= PASSED_MG[7 - r];
        eg -= PASSED_EG[7 - r];
      }
    }
  }

  if (bishops0 >= 2) {
    mg += 28;
    eg += 48;
  }
  if (bishops1 >= 2) {
    mg -= 28;
    eg -= 48;
  }

  // King shelter (middlegame): own pawns right in front of a castled king.
  for (let c = 0; c < 2; c++) {
    const k = pos.kings[c];
    const kf = k & 7;
    const kr = k >> 4;
    const homeRow = c === WHITE ? 7 : 0;
    if (kr !== homeRow || (kf > 2 && kf < 5)) continue;
    const dir = c === WHITE ? -16 : 16;
    const pawn = c === WHITE ? 1 : 9;
    let shelter = 0;
    for (let df = -1; df <= 1; df++) {
      const f = kf + df;
      if (f < 0 || f > 7) continue;
      const s1 = k + df + dir;
      const s2 = s1 + dir;
      if (b[s1] === pawn) shelter += 12;
      else if (!(s2 & 0x88) && b[s2] === pawn) shelter += 6;
      else shelter -= 8;
    }
    mg += c === WHITE ? shelter : -shelter;
  }

  if (phase > 24) phase = 24;
  let score = Math.round((mg * phase + eg * (24 - phase)) / 24);

  // Mop-up: with a decisive material edge and few pieces left, drive the lone king to the edge
  // and bring our king closer — lets the engine actually finish K+Q / K+R endings.
  const diff = nonPawn0 - nonPawn1;
  if (phase <= 8 && Math.abs(diff) >= 400) {
    const strong = diff > 0 ? WHITE : BLACK;
    const weakK = pos.kings[strong ^ 1];
    const strongK = pos.kings[strong];
    const kd = Math.max(Math.abs((weakK >> 4) - (strongK >> 4)), Math.abs((weakK & 7) - (strongK & 7)));
    const bonus = CENTER_DIST(weakK) * 12 + (7 - kd) * 6;
    score += strong === WHITE ? bonus : -bonus;
  }

  // Drawish material: no pawns and a minor-piece edge only.
  if (!pawnsOnFile[0].some(Boolean) && !pawnsOnFile[1].some(Boolean)) {
    const leader = score > 0 ? nonPawn0 : nonPawn1;
    if (leader < 400) score = Math.round(score / 8);
  }

  score = pos.turn === WHITE ? score : -score;
  return score + 10; // tempo
}

// ---------------------------------------------------------------- opening book
// A few main lines (UCI). The engine picks a random continuation while the game follows a line.
const BOOK_LINES = [
  'e2e4 e7e5 g1f3 b8c6 f1b5 a7a6 b5a4 g8f6 e1g1 f8e7 f1e1 b7b5 a4b3 d7d6',
  'e2e4 e7e5 g1f3 b8c6 f1b5 g8f6 e1g1 f6e4 d2d4 e4d6',
  'e2e4 e7e5 g1f3 b8c6 f1c4 f8c5 c2c3 g8f6 d2d3 d7d6',
  'e2e4 e7e5 g1f3 b8c6 f1c4 g8f6 d2d3 f8e7 e1g1 e8g8',
  'e2e4 e7e5 g1f3 b8c6 d2d4 e5d4 f3d4 g8f6 d4c6 b7c6',
  'e2e4 e7e5 g1f3 g8f6 f3e5 d7d6 e5f3 f6e4 d2d4 d6d5',
  'e2e4 e7e5 g1f3 b8c6 b1c3 g8f6 f1b5 f8b4 e1g1 e8g8',
  'e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4 g8f6 b1c3 a7a6',
  'e2e4 c7c5 g1f3 b8c6 d2d4 c5d4 f3d4 g8f6 b1c3 e7e5',
  'e2e4 c7c5 g1f3 e7e6 d2d4 c5d4 f3d4 b8c6 b1c3 d8c7',
  'e2e4 c7c5 c2c3 g8f6 e4e5 f6d5 d2d4 c5d4 g1f3 b8c6',
  'e2e4 e7e6 d2d4 d7d5 b1c3 g8f6 c1g5 f8e7 e4e5 f6d7',
  'e2e4 e7e6 d2d4 d7d5 e4e5 c7c5 c2c3 b8c6 g1f3 d8b6',
  'e2e4 c7c6 d2d4 d7d5 b1c3 d5e4 c3e4 c8f5 e4g3 f5g6',
  'e2e4 c7c6 d2d4 d7d5 e4e5 c8f5 g1f3 e7e6 f1e2 c6c5',
  'e2e4 d7d5 e4d5 d8d5 b1c3 d5a5 d2d4 g8f6 g1f3 c8f5',
  'e2e4 d7d6 d2d4 g8f6 b1c3 g7g6 g1f3 f8g7 f1e2 e8g8',
  'd2d4 d7d5 c2c4 e7e6 b1c3 g8f6 c1g5 f8e7 e2e3 e8g8',
  'd2d4 d7d5 c2c4 c7c6 g1f3 g8f6 b1c3 d5c4 a2a4 c8f5',
  'd2d4 d7d5 c2c4 d5c4 g1f3 g8f6 e2e3 e7e6 f1c4 c7c5',
  'd2d4 g8f6 c2c4 g7g6 b1c3 f8g7 e2e4 d7d6 g1f3 e8g8',
  'd2d4 g8f6 c2c4 e7e6 b1c3 f8b4 e2e3 e8g8 f1d3 d7d5',
  'd2d4 g8f6 c2c4 e7e6 g1f3 b7b6 g2g3 c8b7 f1g2 f8e7',
  'd2d4 g8f6 c2c4 g7g6 b1c3 d7d5 c4d5 f6d5 e2e4 d5c3',
  'd2d4 d7d5 g1f3 g8f6 c1f4 e7e6 e2e3 c7c5 c2c3 b8c6',
  'd2d4 g8f6 g1f3 e7e6 c1f4 c7c5 e2e3 b8c6 c2c3 d7d5',
  'c2c4 e7e5 b1c3 g8f6 g1f3 b8c6 g2g3 d7d5 c4d5 f6d5',
  'c2c4 g8f6 b1c3 e7e6 e2e4 d7d5 e4e5 d5d4',
  'c2c4 c7c5 g1f3 g8f6 b1c3 b8c6 g2g3 g7g6 f1g2 f8g7',
  'g1f3 d7d5 g2g3 g8f6 f1g2 e7e6 e1g1 f8e7 d2d3 e8g8',
  'g1f3 g8f6 c2c4 g7g6 b1c3 f8g7 e2e4 d7d6 d2d4 e8g8',
];
const BOOK = new Map();
for (const line of BOOK_LINES) {
  const mv = line.split(' ');
  for (let i = 0; i < mv.length; i++) {
    const key = mv.slice(0, i).join(' ');
    if (!BOOK.has(key)) BOOK.set(key, []);
    BOOK.get(key).push(mv[i]);
  }
}
export function bookMoves(history) {
  return BOOK.get((history || []).join(' ')) || [];
}
export function bookLines() {
  return BOOK_LINES.map((l) => l.split(' '));
}

// ---------------------------------------------------------------- search
export class Engine {
  constructor({ ttBits = 19 } = {}) {
    this.ttSize = 1 << ttBits;
    this.ttMask = this.ttSize - 1;
    this.ttKey = new Int32Array(this.ttSize);
    this.ttMove = new Int32Array(this.ttSize);
    this.ttScore = new Int16Array(this.ttSize);
    this.ttDepth = new Int8Array(this.ttSize);
    this.ttFlag = new Uint8Array(this.ttSize); // 0 empty, 1 exact, 2 lower bound, 3 upper bound
    this.killers = new Int32Array(MAX_PLY * 2);
    this.history = new Int32Array(16 * 128);
    this.nodes = 0;
    this.stop = false;
    this.deadline = Infinity;
    this.evalNoise = 0;
    this.noiseSeed = 0;
    this._lastNoise = 0;
    this.random = Math.random;
  }

  clearTT() {
    this.ttFlag.fill(0);
  }

  _eval(pos) {
    let s = evaluate(pos);
    if (this.evalNoise) {
      let x = (pos.hashLo ^ this.noiseSeed) | 0;
      x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
      x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
      x ^= x >>> 16;
      s += ((x >>> 0) % (2 * this.evalNoise + 1)) - this.evalNoise;
    }
    return s;
  }

  _timeUp() {
    if ((this.nodes & 1023) === 0 && now() > this.deadline) this.stop = true;
    return this.stop;
  }

  // Repetition (twofold inside the search counts as a draw) or fifty-move rule.
  _isDraw(pos) {
    if (pos.halfmove >= 100) return true;
    const n = pos.histLo.length - 1;
    const lo = pos.hashLo;
    const hi = pos.hashHi;
    const stop = Math.max(0, n - pos.halfmove);
    for (let i = n - 2; i >= stop; i -= 2) if (pos.histLo[i] === lo && pos.histHi[i] === hi) return true;
    return false;
  }

  _scoreMoves(pos, list, ply, ttMove) {
    const scores = new Array(list.length);
    const b = pos.board;
    const k1 = this.killers[ply * 2];
    const k2 = this.killers[ply * 2 + 1];
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (m === ttMove) {
        scores[i] = 1e8;
        continue;
      }
      const flags = m >> 17;
      const from = m & 127;
      const to = (m >> 7) & 127;
      let s = 0;
      if (flags & F_CAPTURE) {
        const victim = flags & 2 ? PAWN : b[to] & 7;
        s = 1e6 + ORDER_VAL[victim] * 16 - (b[from] & 7);
      }
      if (flags & F_PROMO) s += ((m >> 14) & 7) === QUEEN ? 2e6 : -1e5;
      if (!s) {
        if (m === k1) s = 9e5;
        else if (m === k2) s = 8e5;
        else s = this.history[b[from] * 128 + to];
      }
      scores[i] = s;
    }
    return scores;
  }

  _pick(list, scores, i) {
    let best = i;
    for (let j = i + 1; j < list.length; j++) if (scores[j] > scores[best]) best = j;
    if (best !== i) {
      const m = list[i];
      list[i] = list[best];
      list[best] = m;
      const s = scores[i];
      scores[i] = scores[best];
      scores[best] = s;
    }
    return list[i];
  }

  _ttProbe(pos) {
    const i = pos.hashLo & this.ttMask;
    if (this.ttFlag[i] && this.ttKey[i] === pos.hashHi) return i;
    return -1;
  }

  _ttStore(pos, depth, flag, score, move, ply) {
    const i = pos.hashLo & this.ttMask;
    if (this.ttFlag[i] && this.ttKey[i] === pos.hashHi && this.ttDepth[i] > depth && flag !== 1) return;
    if (score > MATE_BOUND) score += ply;
    else if (score < -MATE_BOUND) score -= ply;
    this.ttKey[i] = pos.hashHi;
    this.ttMove[i] = move;
    this.ttScore[i] = score;
    this.ttDepth[i] = depth;
    this.ttFlag[i] = flag;
  }

  _hasNonPawn(pos, color) {
    for (let i = 0; i < 64; i++) {
      const p = pos.board[SQUARES[i]];
      if (p && p >> 3 === color) {
        const t = p & 7;
        if (t !== PAWN && t !== KING) return true;
      }
    }
    return false;
  }

  quiesce(pos, alpha, beta, ply) {
    this.nodes++;
    if (this._timeUp()) return 0;
    const inCheck = pos.inCheck();
    if (ply >= MAX_PLY - 1) return this._eval(pos);
    let best = -INF;
    if (!inCheck) {
      const stand = this._eval(pos);
      if (stand >= beta) return stand;
      if (stand > alpha) alpha = stand;
      best = stand;
    }
    const list = pos.generate([], !inCheck);
    const scores = this._scoreMoves(pos, list, ply, 0);
    let legal = 0;
    for (let i = 0; i < list.length; i++) {
      const m = this._pick(list, scores, i);
      if (!inCheck && !(m >> 17 & F_PROMO)) {
        // delta pruning: even winning this piece cannot raise alpha
        const to = (m >> 7) & 127;
        const victim = (m >> 17) & 2 ? PAWN : pos.board[to] & 7;
        if (best + ORDER_VAL[victim] + 200 < alpha) continue;
      }
      if (!pos.make(m)) continue;
      legal++;
      const score = -this.quiesce(pos, -beta, -alpha, ply + 1);
      pos.unmake();
      if (this.stop) return 0;
      if (score > best) {
        best = score;
        if (score > alpha) {
          alpha = score;
          if (score >= beta) return score;
        }
      }
    }
    if (inCheck && !legal) return -MATE + ply;
    return best;
  }

  negamax(pos, depth, alpha, beta, ply, allowNull) {
    if (ply > 0 && this._isDraw(pos)) return 0;
    const inCheck = pos.inCheck();
    if (inCheck && ply < MAX_PLY / 2) depth++;
    if (depth <= 0) return this.quiesce(pos, alpha, beta, ply);
    this.nodes++;
    if (this._timeUp()) return 0;
    if (ply >= MAX_PLY - 1) return this._eval(pos);

    // mate distance pruning
    alpha = Math.max(alpha, -MATE + ply);
    beta = Math.min(beta, MATE - ply - 1);
    if (alpha >= beta) return alpha;

    const pvNode = beta - alpha > 1;
    let ttMove = 0;
    const ti = this._ttProbe(pos);
    if (ti >= 0) {
      ttMove = this.ttMove[ti];
      if (!pvNode && this.ttDepth[ti] >= depth) {
        let s = this.ttScore[ti];
        if (s > MATE_BOUND) s -= ply;
        else if (s < -MATE_BOUND) s += ply;
        const f = this.ttFlag[ti];
        if (f === 1 || (f === 2 && s >= beta) || (f === 3 && s <= alpha)) return s;
      }
    }

    // null-move pruning
    if (allowNull && !pvNode && !inCheck && depth >= 3 && this._hasNonPawn(pos, pos.turn) && this._eval(pos) >= beta) {
      pos.makeNull();
      const r = depth >= 6 ? 3 : 2;
      const s = -this.negamax(pos, depth - 1 - r, -beta, -beta + 1, ply + 1, false);
      pos.unmakeNull();
      if (this.stop) return 0;
      if (s >= beta && s < MATE_BOUND) return beta;
    }

    const list = pos.generate([], false);
    const scores = this._scoreMoves(pos, list, ply, ttMove);
    let legal = 0;
    let best = -INF;
    let bestMove = 0;
    const alphaOrig = alpha;
    for (let i = 0; i < list.length; i++) {
      const m = this._pick(list, scores, i);
      if (!pos.make(m)) continue;
      legal++;
      const quiet = !((m >> 17) & (F_CAPTURE | F_PROMO));
      let score;
      if (legal === 1) score = -this.negamax(pos, depth - 1, -beta, -alpha, ply + 1, true);
      else {
        let reduce = 0;
        if (depth >= 3 && legal > 3 && quiet && !inCheck && scores[i] < 8e5 && !pos.inCheck()) reduce = legal > 10 && depth >= 5 ? 2 : 1;
        score = -this.negamax(pos, depth - 1 - reduce, -alpha - 1, -alpha, ply + 1, true);
        if (score > alpha && reduce) score = -this.negamax(pos, depth - 1, -alpha - 1, -alpha, ply + 1, true);
        if (score > alpha && score < beta) score = -this.negamax(pos, depth - 1, -beta, -alpha, ply + 1, true);
      }
      pos.unmake();
      if (this.stop) return 0;
      if (score > best) {
        best = score;
        bestMove = m;
        if (score > alpha) {
          alpha = score;
          if (score >= beta) {
            if (quiet) {
              if (this.killers[ply * 2] !== m) {
                this.killers[ply * 2 + 1] = this.killers[ply * 2];
                this.killers[ply * 2] = m;
              }
              const hi = pos.board[m & 127] * 128 + ((m >> 7) & 127);
              this.history[hi] = Math.min(700000, this.history[hi] + depth * depth);
            }
            break;
          }
        }
      }
    }
    if (!legal) return inCheck ? -MATE + ply : 0;
    const flag = best >= beta ? 2 : best > alphaOrig ? 1 : 3;
    this._ttStore(pos, depth, flag, best, bestMove, ply);
    return best;
  }

  _pv(pos, first, maxLen = 12) {
    const pv = [];
    let m = first;
    let made = 0;
    const seen = new Set();
    while (m && pv.length < maxLen) {
      const legal = pos.legalMoves();
      if (!legal.includes(m)) break;
      pv.push(moveToUci(m));
      pos.make(m);
      made++;
      const key = `${pos.hashLo},${pos.hashHi}`;
      if (seen.has(key)) break;
      seen.add(key);
      const ti = this._ttProbe(pos);
      m = ti >= 0 ? this.ttMove[ti] : 0;
    }
    while (made--) pos.unmake();
    return pv;
  }

  // Root move scores (exact, full window) — used by the low levels to add randomness.
  _rootScores(pos, depth, legal) {
    const out = [];
    for (const m of legal) {
      pos.make(m);
      const s = -this.negamax(pos, depth - 1, -INF, INF, 1, true);
      pos.unmake();
      out.push({ m, s });
    }
    return out;
  }

  // Main entry point. opts: { level, timeMs, depth, history (UCI list from the start position,
  // for the book), startFen, analysis }
  think(pos, opts = {}) {
    const t0 = now();
    const L = { ...(LEVELS[opts.level] || LEVELS.medium) };
    if (opts.timeMs) L.time = opts.timeMs;
    if (opts.depth) L.depth = opts.depth;
    if (opts.analysis) {
      L.rootNoise = 0;
      L.evalNoise = 0;
      L.book = false;
    }
    this.nodes = 0;
    this.stop = false;
    this.killers.fill(0);
    for (let i = 0; i < this.history.length; i++) this.history[i] >>= 2;
    if (L.evalNoise !== this._lastNoise) this.clearTT();
    this._lastNoise = L.evalNoise;
    this.evalNoise = L.evalNoise;
    this.noiseSeed = (this.random() * 0x7fffffff) | 0;

    const legal = pos.legalMoves();
    if (!legal.length) return { move: null, score: pos.inCheck() ? -MATE : 0, mate: pos.inCheck() ? 0 : null, depth: 0, nodes: 0, pv: [], book: false, time: 0 };

    // Opening book
    if (L.book && (!opts.startFen || opts.startFen === START_FEN) && opts.history) {
      const cands = bookMoves(opts.history).filter((u) => legal.some((m) => moveToUci(m) === u));
      if (cands.length) {
        const u = cands[Math.floor(this.random() * cands.length)];
        return { move: u, score: 0, mate: null, depth: 0, nodes: 0, pv: [u], book: true, time: Math.round(now() - t0) };
      }
    }
    if (legal.length === 1) {
      const s = this._eval(pos);
      return { move: moveToUci(legal[0]), score: s, mate: null, depth: 1, nodes: 1, pv: [moveToUci(legal[0])], book: false, time: Math.round(now() - t0), forced: true };
    }

    this.deadline = t0 + L.time;

    // Low levels: exact score for every root move + random noise, then pick the best.
    if (L.rootNoise) {
      this.deadline = t0 + Math.max(L.time * 4, 3000); // shallow and cheap: let it complete
      const res = this._rootScores(pos, L.depth, legal);
      this.stop = false;
      let best = null;
      for (const r of res) {
        const noisy = r.s + (this.random() * 2 - 1) * L.rootNoise;
        if (!best || noisy > best.v) best = { ...r, v: noisy };
      }
      return { move: moveToUci(best.m), score: best.s, mate: mateIn(best.s), depth: L.depth, nodes: this.nodes, pv: [moveToUci(best.m)], book: false, time: Math.round(now() - t0) };
    }

    // Iterative deepening.
    let bestMove = legal[0];
    let bestScore = -INF;
    let completedDepth = 0;
    const order = legal.map((m) => ({ m, s: 0 }));
    // initial ordering: captures / promotions first
    const sc = this._scoreMoves(pos, legal, 0, 0);
    order.forEach((o, i) => (o.s = sc[i]));
    order.sort((a, b) => b.s - a.s);
    for (let depth = 1; depth <= L.depth; depth++) {
      let alpha = -INF;
      const beta = INF;
      let iterBest = 0;
      let iterScore = -INF;
      for (let i = 0; i < order.length; i++) {
        const m = order[i].m;
        pos.make(m);
        let s;
        if (i === 0) s = -this.negamax(pos, depth - 1, -beta, -alpha, 1, true);
        else {
          s = -this.negamax(pos, depth - 1, -alpha - 1, -alpha, 1, true);
          if (s > alpha && !this.stop) s = -this.negamax(pos, depth - 1, -beta, -alpha, 1, true);
        }
        pos.unmake();
        if (this.stop) break;
        order[i].s = s;
        if (s > iterScore) {
          iterScore = s;
          iterBest = m;
          if (s > alpha) alpha = s;
        }
      }
      if (this.stop) {
        // A partially searched iteration still improves the choice when its first (PV) move was
        // searched and something beat it.
        if (iterBest) {
          bestMove = iterBest;
          bestScore = iterScore;
        }
        break;
      }
      bestMove = iterBest;
      bestScore = iterScore;
      completedDepth = depth;
      this._ttStore(pos, depth, 1, bestScore, bestMove, 0);
      // best move first, the rest by score
      order.sort((a, b) => (a.m === bestMove ? -1 : b.m === bestMove ? 1 : b.s - a.s));
      if (Math.abs(bestScore) > MATE_BOUND && depth >= 2) break; // forced mate found
      if (now() - t0 > L.time * 0.5) break; // the next iteration would not finish
    }
    return {
      move: moveToUci(bestMove),
      score: bestScore,
      mate: mateIn(bestScore),
      depth: completedDepth,
      nodes: this.nodes,
      pv: this._pv(pos, bestMove),
      book: false,
      time: Math.round(now() - t0),
    };
  }
}

// Mate distance in moves (positive: side to move mates), or null.
export function mateIn(score) {
  if (score > MATE_BOUND) return Math.ceil((MATE - score) / 2);
  if (score < -MATE_BOUND) return -Math.ceil((MATE + score) / 2);
  return null;
}

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

// Build a Position from a start FEN and a list of UCI moves (keeps the repetition history).
export function positionFrom(startFen = START_FEN, moves = []) {
  const pos = Position.fromFen(startFen);
  for (const u of moves) {
    const m = pos.parseUci(u);
    if (!m) throw new Error(`Illegal move in history: ${u}`);
    pos.make(m);
  }
  return pos;
}
