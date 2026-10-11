// Aurora Chess — rules engine. Pure ES module, no dependencies (runs in the shell, in the
// AI Web Worker and in node for the perft tests).
//
// Low level:  Position  — 0x88 board, integer moves, make/unmake, Zobrist hashing, pseudo-legal
//                         move generation, attack detection, perft. Used by the search (ai.mjs).
// High level: Chess     — game with history: legal moves as objects, SAN in/out, FEN in/out,
//                         PGN in/out, game-end detection (mate, stalemate, threefold repetition,
//                         fifty-move rule, insufficient material).
//
// Squares are 0x88 indexes: index = row * 16 + file, row 0 = rank 8 (a8 = 0, h1 = 119).
// Pieces are small ints: type | color << 3  (white 1..6, black 9..14), 0 = empty.
// Moves are ints: from | to << 7 | promotionType << 14 | flags << 17.

export const WHITE = 0;
export const BLACK = 1;
export const PAWN = 1;
export const KNIGHT = 2;
export const BISHOP = 3;
export const ROOK = 4;
export const QUEEN = 5;
export const KING = 6;

export const F_CAPTURE = 1;
export const F_EP = 2;
export const F_CASTLE = 4;
export const F_DOUBLE = 8;
export const F_PROMO = 16;

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const CASTLE_WK = 1;
const CASTLE_WQ = 2;
const CASTLE_BK = 4;
const CASTLE_BQ = 8;

const PIECE_CHARS = ' pnbrqk';
const KNIGHT_OFFSETS = [-33, -31, -18, -14, 14, 18, 31, 33];
const BISHOP_OFFSETS = [-17, -15, 15, 17];
const ROOK_OFFSETS = [-16, -1, 1, 16];
const KING_OFFSETS = [-17, -16, -15, -1, 1, 15, 16, 17];

export const SQUARES = [];
for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) SQUARES.push(r * 16 + f);

export const colorOf = (p) => p >> 3;
export const typeOf = (p) => p & 7;
export const makePiece = (type, color) => type | (color << 3);
export const fileOf = (sq) => sq & 7;
export const rowOf = (sq) => sq >> 4;

export function sqName(sq) {
  return 'abcdefgh'[sq & 7] + (8 - (sq >> 4));
}
export function sqIndex(name) {
  if (typeof name !== 'string' || !/^[a-h][1-8]$/.test(name)) return -1;
  return (8 - Number(name[1])) * 16 + (name.charCodeAt(0) - 97);
}
export const moveFrom = (m) => m & 127;
export const moveTo = (m) => (m >> 7) & 127;
export const movePromo = (m) => (m >> 14) & 7;
export const moveFlags = (m) => m >> 17;
const encode = (from, to, promo, flags) => from | (to << 7) | (promo << 14) | (flags << 17);

// Castling rights kept when a piece moves from / to a square (rook or king squares lose them).
const CASTLE_MASK = new Int8Array(128).fill(15);
CASTLE_MASK[sqIndex('e1')] = 15 & ~(CASTLE_WK | CASTLE_WQ);
CASTLE_MASK[sqIndex('h1')] = 15 & ~CASTLE_WK;
CASTLE_MASK[sqIndex('a1')] = 15 & ~CASTLE_WQ;
CASTLE_MASK[sqIndex('e8')] = 15 & ~(CASTLE_BK | CASTLE_BQ);
CASTLE_MASK[sqIndex('h8')] = 15 & ~CASTLE_BK;
CASTLE_MASK[sqIndex('a8')] = 15 & ~CASTLE_BQ;

// ---------------------------------------------------------------- Zobrist keys (deterministic)
let seed = 0x2545f491;
function rnd32() {
  // xorshift32
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return seed | 0;
}
const Z_PIECE_LO = new Int32Array(16 * 128);
const Z_PIECE_HI = new Int32Array(16 * 128);
for (let i = 0; i < 16 * 128; i++) {
  Z_PIECE_LO[i] = rnd32();
  Z_PIECE_HI[i] = rnd32();
}
const Z_CASTLE_LO = new Int32Array(16);
const Z_CASTLE_HI = new Int32Array(16);
for (let i = 0; i < 16; i++) {
  Z_CASTLE_LO[i] = rnd32();
  Z_CASTLE_HI[i] = rnd32();
}
const Z_EP_LO = new Int32Array(8);
const Z_EP_HI = new Int32Array(8);
for (let i = 0; i < 8; i++) {
  Z_EP_LO[i] = rnd32();
  Z_EP_HI[i] = rnd32();
}
const Z_SIDE_LO = rnd32();
const Z_SIDE_HI = rnd32();

// ---------------------------------------------------------------- FEN validation
export function validateFen(fen) {
  if (typeof fen !== 'string') return 'empty';
  const parts = fen.trim().split(/\s+/);
  if (parts.length < 4 || parts.length > 6) return 'fields';
  const rows = parts[0].split('/');
  if (rows.length !== 8) return 'rows';
  const kings = { K: 0, k: 0 };
  for (let r = 0; r < 8; r++) {
    let n = 0;
    let prevDigit = false;
    for (const ch of rows[r]) {
      if (/[1-8]/.test(ch)) {
        if (prevDigit) return 'rows';
        n += Number(ch);
        prevDigit = true;
      } else if (/[pnbrqkPNBRQK]/.test(ch)) {
        n += 1;
        prevDigit = false;
        if (ch === 'K' || ch === 'k') kings[ch]++;
        if ((ch === 'p' || ch === 'P') && (r === 0 || r === 7)) return 'pawns';
      } else return 'pieces';
    }
    if (n !== 8) return 'rows';
  }
  if (kings.K !== 1 || kings.k !== 1) return 'kings';
  if (!/^[wb]$/.test(parts[1])) return 'turn';
  if (!/^(-|K?Q?k?q?)$/.test(parts[2]) || parts[2] === '') return 'castling';
  if (!/^(-|[a-h][36])$/.test(parts[3])) return 'enpassant';
  if (parts[3] !== '-' && ((parts[1] === 'w' && parts[3][1] !== '6') || (parts[1] === 'b' && parts[3][1] !== '3'))) return 'enpassant';
  if (parts[4] !== undefined && !/^\d+$/.test(parts[4])) return 'halfmove';
  if (parts[5] !== undefined && (!/^\d+$/.test(parts[5]) || Number(parts[5]) < 1)) return 'fullmove';
  // The side that just moved must not be in check.
  const p = new Position();
  p._setFenUnchecked(fen);
  if (p.isAttacked(p.kings[p.turn ^ 1], p.turn)) return 'check';
  return null;
}

// ---------------------------------------------------------------- Position
export class Position {
  constructor() {
    this.board = new Int8Array(128);
    this.turn = WHITE;
    this.castling = 0;
    this.ep = -1;
    this.halfmove = 0;
    this.fullmove = 1;
    this.kings = [0, 0];
    this.hashLo = 0;
    this.hashHi = 0;
    // undo stack
    this._mv = [];
    this._cap = [];
    this._castle = [];
    this._ep = [];
    this._half = [];
    this._hlo = [];
    this._hhi = [];
    // hashes of every position since the FEN was loaded (for repetition detection)
    this.histLo = [];
    this.histHi = [];
  }

  static fromFen(fen = START_FEN) {
    const p = new Position();
    p.setFen(fen);
    return p;
  }

  clone() {
    const p = new Position();
    p.board.set(this.board);
    p.turn = this.turn;
    p.castling = this.castling;
    p.ep = this.ep;
    p.halfmove = this.halfmove;
    p.fullmove = this.fullmove;
    p.kings = [...this.kings];
    p.hashLo = this.hashLo;
    p.hashHi = this.hashHi;
    p.histLo = [...this.histLo];
    p.histHi = [...this.histHi];
    return p;
  }

  setFen(fen) {
    const err = validateFen(fen);
    if (err) throw new Error(`Invalid FEN (${err})`);
    this._setFenUnchecked(fen);
  }

  _setFenUnchecked(fen) {
    const parts = fen.trim().split(/\s+/);
    this.board.fill(0);
    let sq = 0;
    for (const ch of parts[0]) {
      if (ch === '/') sq += 8;
      else if (/[1-8]/.test(ch)) sq += Number(ch);
      else {
        const color = ch === ch.toUpperCase() ? WHITE : BLACK;
        const type = PIECE_CHARS.indexOf(ch.toLowerCase());
        this.board[sq] = makePiece(type, color);
        if (type === KING) this.kings[color] = sq;
        sq++;
      }
    }
    this.turn = parts[1] === 'b' ? BLACK : WHITE;
    // Castling rights are kept only when king and rook really stand on their original squares.
    let c = 0;
    const cr = parts[2] || '-';
    const at = (n) => this.board[sqIndex(n)];
    if (cr.includes('K') && at('e1') === makePiece(KING, WHITE) && at('h1') === makePiece(ROOK, WHITE)) c |= CASTLE_WK;
    if (cr.includes('Q') && at('e1') === makePiece(KING, WHITE) && at('a1') === makePiece(ROOK, WHITE)) c |= CASTLE_WQ;
    if (cr.includes('k') && at('e8') === makePiece(KING, BLACK) && at('h8') === makePiece(ROOK, BLACK)) c |= CASTLE_BK;
    if (cr.includes('q') && at('e8') === makePiece(KING, BLACK) && at('a8') === makePiece(ROOK, BLACK)) c |= CASTLE_BQ;
    this.castling = c;
    this.ep = parts[3] && parts[3] !== '-' ? sqIndex(parts[3]) : -1;
    if (this.ep >= 0) {
      // Keep the en-passant square only when it is consistent and a capture is possible.
      const dir = this.turn === WHITE ? 16 : -16; // from the ep square towards the pawn that double-pushed
      const pawnSq = this.ep + dir;
      const ok = this.board[pawnSq] === makePiece(PAWN, this.turn ^ 1) && !this.board[this.ep] && !this.board[this.ep - dir] && this._epCapturable(pawnSq, this.turn);
      if (!ok) this.ep = -1;
    }
    this.halfmove = parts[4] !== undefined ? Number(parts[4]) : 0;
    this.fullmove = parts[5] !== undefined ? Math.max(1, Number(parts[5])) : 1;
    this._mv.length = this._cap.length = this._castle.length = this._ep.length = this._half.length = this._hlo.length = this._hhi.length = 0;
    this._computeHash();
    this.histLo = [this.hashLo];
    this.histHi = [this.hashHi];
  }

  _epCapturable(pawnSq, byColor) {
    const enemyPawn = makePiece(PAWN, byColor);
    const l = pawnSq - 1;
    const r = pawnSq + 1;
    return (!(l & 0x88) && this.board[l] === enemyPawn) || (!(r & 0x88) && this.board[r] === enemyPawn);
  }

  _computeHash() {
    let lo = 0;
    let hi = 0;
    for (const sq of SQUARES) {
      const p = this.board[sq];
      if (p) {
        lo ^= Z_PIECE_LO[p * 128 + sq];
        hi ^= Z_PIECE_HI[p * 128 + sq];
      }
    }
    lo ^= Z_CASTLE_LO[this.castling];
    hi ^= Z_CASTLE_HI[this.castling];
    if (this.ep >= 0) {
      lo ^= Z_EP_LO[this.ep & 7];
      hi ^= Z_EP_HI[this.ep & 7];
    }
    if (this.turn === BLACK) {
      lo ^= Z_SIDE_LO;
      hi ^= Z_SIDE_HI;
    }
    this.hashLo = lo;
    this.hashHi = hi;
  }

  fen() {
    let s = '';
    for (let r = 0; r < 8; r++) {
      let empty = 0;
      for (let f = 0; f < 8; f++) {
        const p = this.board[r * 16 + f];
        if (!p) {
          empty++;
          continue;
        }
        if (empty) {
          s += empty;
          empty = 0;
        }
        const ch = PIECE_CHARS[typeOf(p)];
        s += colorOf(p) === WHITE ? ch.toUpperCase() : ch;
      }
      if (empty) s += empty;
      if (r < 7) s += '/';
    }
    let c = '';
    if (this.castling & CASTLE_WK) c += 'K';
    if (this.castling & CASTLE_WQ) c += 'Q';
    if (this.castling & CASTLE_BK) c += 'k';
    if (this.castling & CASTLE_BQ) c += 'q';
    return `${s} ${this.turn === WHITE ? 'w' : 'b'} ${c || '-'} ${this.ep >= 0 ? sqName(this.ep) : '-'} ${this.halfmove} ${this.fullmove}`;
  }

  // ------------------------------------------------------------ attacks
  isAttacked(sq, by) {
    const b = this.board;
    // pawns
    if (by === WHITE) {
      const a = sq + 15;
      const c = sq + 17;
      if (!(a & 0x88) && b[a] === 1) return true;
      if (!(c & 0x88) && b[c] === 1) return true;
    } else {
      const a = sq - 15;
      const c = sq - 17;
      if (!(a & 0x88) && b[a] === 9) return true;
      if (!(c & 0x88) && b[c] === 9) return true;
    }
    const knight = makePiece(KNIGHT, by);
    for (let i = 0; i < 8; i++) {
      const t = sq + KNIGHT_OFFSETS[i];
      if (!(t & 0x88) && b[t] === knight) return true;
    }
    const king = makePiece(KING, by);
    for (let i = 0; i < 8; i++) {
      const t = sq + KING_OFFSETS[i];
      if (!(t & 0x88) && b[t] === king) return true;
    }
    const bishop = makePiece(BISHOP, by);
    const rook = makePiece(ROOK, by);
    const queen = makePiece(QUEEN, by);
    for (let i = 0; i < 4; i++) {
      const d = BISHOP_OFFSETS[i];
      let t = sq + d;
      while (!(t & 0x88)) {
        const p = b[t];
        if (p) {
          if (p === bishop || p === queen) return true;
          break;
        }
        t += d;
      }
    }
    for (let i = 0; i < 4; i++) {
      const d = ROOK_OFFSETS[i];
      let t = sq + d;
      while (!(t & 0x88)) {
        const p = b[t];
        if (p) {
          if (p === rook || p === queen) return true;
          break;
        }
        t += d;
      }
    }
    return false;
  }

  inCheck(color = this.turn) {
    return this.isAttacked(this.kings[color], color ^ 1);
  }

  // ------------------------------------------------------------ move generation (pseudo-legal)
  // Fills `list` (an array) and returns it. capturesOnly: captures, en passant and promotions.
  generate(list = [], capturesOnly = false) {
    const b = this.board;
    const us = this.turn;
    const them = us ^ 1;
    const pawnDir = us === WHITE ? -16 : 16;
    const startRow = us === WHITE ? 6 : 1;
    const promoRow = us === WHITE ? 0 : 7;
    for (let i = 0; i < 64; i++) {
      const from = SQUARES[i];
      const p = b[from];
      if (!p || p >> 3 !== us) continue;
      const type = p & 7;
      if (type === PAWN) {
        const to = from + pawnDir;
        if (!b[to]) {
          if (to >> 4 === promoRow) {
            list.push(encode(from, to, QUEEN, F_PROMO));
            if (!capturesOnly) {
              list.push(encode(from, to, KNIGHT, F_PROMO));
              list.push(encode(from, to, ROOK, F_PROMO));
              list.push(encode(from, to, BISHOP, F_PROMO));
            }
          } else if (!capturesOnly) {
            list.push(encode(from, to, 0, 0));
            if (from >> 4 === startRow && !b[to + pawnDir]) list.push(encode(from, to + pawnDir, 0, F_DOUBLE));
          }
        }
        for (let k = -1; k <= 1; k += 2) {
          const t = to + k;
          if (t & 0x88) continue;
          const q = b[t];
          if (q && q >> 3 === them) {
            if (t >> 4 === promoRow) {
              list.push(encode(from, t, QUEEN, F_PROMO | F_CAPTURE));
              list.push(encode(from, t, KNIGHT, F_PROMO | F_CAPTURE));
              list.push(encode(from, t, ROOK, F_PROMO | F_CAPTURE));
              list.push(encode(from, t, BISHOP, F_PROMO | F_CAPTURE));
            } else list.push(encode(from, t, 0, F_CAPTURE));
          } else if (t === this.ep) list.push(encode(from, t, 0, F_CAPTURE | F_EP));
        }
      } else if (type === KNIGHT || type === KING) {
        const offs = type === KNIGHT ? KNIGHT_OFFSETS : KING_OFFSETS;
        for (let k = 0; k < 8; k++) {
          const t = from + offs[k];
          if (t & 0x88) continue;
          const q = b[t];
          if (!q) {
            if (!capturesOnly) list.push(encode(from, t, 0, 0));
          } else if (q >> 3 === them) list.push(encode(from, t, 0, F_CAPTURE));
        }
        if (type === KING && !capturesOnly && this.castling) this._genCastles(list, from, us, them);
      } else {
        const offs = type === BISHOP ? BISHOP_OFFSETS : type === ROOK ? ROOK_OFFSETS : KING_OFFSETS;
        const n = offs.length;
        for (let k = 0; k < n; k++) {
          const d = offs[k];
          let t = from + d;
          while (!(t & 0x88)) {
            const q = b[t];
            if (!q) {
              if (!capturesOnly) list.push(encode(from, t, 0, 0));
            } else {
              if (q >> 3 === them) list.push(encode(from, t, 0, F_CAPTURE));
              break;
            }
            t += d;
          }
        }
      }
    }
    return list;
  }

  _genCastles(list, from, us, them) {
    const b = this.board;
    if (us === WHITE) {
      if (from !== 116) return; // e1
      if (this.castling & CASTLE_WK && !b[117] && !b[118] && !this.isAttacked(116, them) && !this.isAttacked(117, them)) list.push(encode(116, 118, 0, F_CASTLE));
      if (this.castling & CASTLE_WQ && !b[115] && !b[114] && !b[113] && !this.isAttacked(116, them) && !this.isAttacked(115, them)) list.push(encode(116, 114, 0, F_CASTLE));
    } else {
      if (from !== 4) return; // e8
      if (this.castling & CASTLE_BK && !b[5] && !b[6] && !this.isAttacked(4, them) && !this.isAttacked(5, them)) list.push(encode(4, 6, 0, F_CASTLE));
      if (this.castling & CASTLE_BQ && !b[3] && !b[2] && !b[1] && !this.isAttacked(4, them) && !this.isAttacked(3, them)) list.push(encode(4, 2, 0, F_CASTLE));
    }
  }

  // ------------------------------------------------------------ make / unmake
  // Plays a pseudo-legal move. Returns false (and leaves the position unchanged) if it is illegal.
  make(m) {
    const b = this.board;
    const from = m & 127;
    const to = (m >> 7) & 127;
    const promo = (m >> 14) & 7;
    const flags = m >> 17;
    const us = this.turn;
    const them = us ^ 1;
    const piece = b[from];
    let capSq = to;
    if (flags & F_EP) capSq = to + (us === WHITE ? 16 : -16);
    const captured = b[capSq];

    this._mv.push(m);
    this._cap.push(captured);
    this._castle.push(this.castling);
    this._ep.push(this.ep);
    this._half.push(this.halfmove);
    this._hlo.push(this.hashLo);
    this._hhi.push(this.hashHi);

    let lo = this.hashLo;
    let hi = this.hashHi;
    // remove the moving piece
    lo ^= Z_PIECE_LO[piece * 128 + from];
    hi ^= Z_PIECE_HI[piece * 128 + from];
    if (captured) {
      lo ^= Z_PIECE_LO[captured * 128 + capSq];
      hi ^= Z_PIECE_HI[captured * 128 + capSq];
      b[capSq] = 0;
    }
    const placed = promo ? makePiece(promo, us) : piece;
    b[to] = placed;
    b[from] = 0;
    lo ^= Z_PIECE_LO[placed * 128 + to];
    hi ^= Z_PIECE_HI[placed * 128 + to];
    if (flags & F_CASTLE) {
      const rook = makePiece(ROOK, us);
      let rf;
      let rt;
      if ((to & 7) === 6) {
        rf = to + 1;
        rt = to - 1;
      } else {
        rf = to - 2;
        rt = to + 1;
      }
      b[rt] = rook;
      b[rf] = 0;
      lo ^= Z_PIECE_LO[rook * 128 + rf] ^ Z_PIECE_LO[rook * 128 + rt];
      hi ^= Z_PIECE_HI[rook * 128 + rf] ^ Z_PIECE_HI[rook * 128 + rt];
    }
    if ((piece & 7) === KING) this.kings[us] = to;

    const nc = this.castling & CASTLE_MASK[from] & CASTLE_MASK[to];
    if (nc !== this.castling) {
      lo ^= Z_CASTLE_LO[this.castling] ^ Z_CASTLE_LO[nc];
      hi ^= Z_CASTLE_HI[this.castling] ^ Z_CASTLE_HI[nc];
      this.castling = nc;
    }
    if (this.ep >= 0) {
      lo ^= Z_EP_LO[this.ep & 7];
      hi ^= Z_EP_HI[this.ep & 7];
    }
    this.ep = -1;
    if (flags & F_DOUBLE && this._epCapturable(to, them)) {
      this.ep = (from + to) >> 1;
      lo ^= Z_EP_LO[this.ep & 7];
      hi ^= Z_EP_HI[this.ep & 7];
    }
    this.halfmove = (piece & 7) === PAWN || captured ? 0 : this.halfmove + 1;
    if (us === BLACK) this.fullmove++;
    this.turn = them;
    lo ^= Z_SIDE_LO;
    hi ^= Z_SIDE_HI;
    this.hashLo = lo;
    this.hashHi = hi;
    this.histLo.push(lo);
    this.histHi.push(hi);

    if (this.isAttacked(this.kings[us], them)) {
      this.unmake();
      return false;
    }
    return true;
  }

  unmake() {
    const m = this._mv.pop();
    const captured = this._cap.pop();
    this.castling = this._castle.pop();
    this.ep = this._ep.pop();
    this.halfmove = this._half.pop();
    this.hashLo = this._hlo.pop();
    this.hashHi = this._hhi.pop();
    this.histLo.pop();
    this.histHi.pop();
    const b = this.board;
    const from = m & 127;
    const to = (m >> 7) & 127;
    const flags = m >> 17;
    this.turn ^= 1;
    const us = this.turn;
    if (us === BLACK) this.fullmove--;
    const placed = b[to];
    b[from] = flags & F_PROMO ? makePiece(PAWN, us) : placed;
    b[to] = 0;
    if (flags & F_EP) b[to + (us === WHITE ? 16 : -16)] = captured;
    else b[to] = captured;
    if (flags & F_CASTLE) {
      const rook = makePiece(ROOK, us);
      if ((to & 7) === 6) {
        b[to + 1] = rook;
        b[to - 1] = 0;
      } else {
        b[to - 2] = rook;
        b[to + 1] = 0;
      }
    }
    if ((b[from] & 7) === KING) this.kings[us] = from;
    return m;
  }

  // "Pass" for null-move pruning in the search.
  makeNull() {
    this._mv.push(0);
    this._cap.push(0);
    this._castle.push(this.castling);
    this._ep.push(this.ep);
    this._half.push(this.halfmove);
    this._hlo.push(this.hashLo);
    this._hhi.push(this.hashHi);
    if (this.ep >= 0) {
      this.hashLo ^= Z_EP_LO[this.ep & 7];
      this.hashHi ^= Z_EP_HI[this.ep & 7];
    }
    this.ep = -1;
    this.halfmove++;
    this.turn ^= 1;
    this.hashLo ^= Z_SIDE_LO;
    this.hashHi ^= Z_SIDE_HI;
    this.histLo.push(this.hashLo);
    this.histHi.push(this.hashHi);
  }

  unmakeNull() {
    this._mv.pop();
    this._cap.pop();
    this.castling = this._castle.pop();
    this.ep = this._ep.pop();
    this.halfmove = this._half.pop();
    this.hashLo = this._hlo.pop();
    this.hashHi = this._hhi.pop();
    this.histLo.pop();
    this.histHi.pop();
    this.turn ^= 1;
  }

  get ply() {
    return this._mv.length;
  }

  lastCaptured() {
    return this._cap[this._cap.length - 1] || 0;
  }

  // ------------------------------------------------------------ helpers
  legalMoves() {
    const out = [];
    for (const m of this.generate([], false)) {
      if (this.make(m)) {
        this.unmake();
        out.push(m);
      }
    }
    return out;
  }

  hasLegalMove() {
    for (const m of this.generate([], false)) {
      if (this.make(m)) {
        this.unmake();
        return true;
      }
    }
    return false;
  }

  // How many times the current position occurred (only positions since the last irreversible move
  // with the same side to move can repeat).
  repetitions() {
    const n = this.histLo.length - 1;
    const lo = this.hashLo;
    const hi = this.hashHi;
    let count = 1;
    const stop = Math.max(0, n - this.halfmove);
    for (let i = n - 2; i >= stop; i -= 2) if (this.histLo[i] === lo && this.histHi[i] === hi) count++;
    return count;
  }

  insufficientMaterial() {
    let minors = 0;
    let bishopsLight = 0;
    let bishopsDark = 0;
    let knights = 0;
    for (const sq of SQUARES) {
      const p = this.board[sq];
      if (!p) continue;
      const t = p & 7;
      if (t === KING) continue;
      if (t === PAWN || t === ROOK || t === QUEEN) return false;
      minors++;
      if (t === KNIGHT) knights++;
      else if (((sq >> 4) + (sq & 7)) % 2 === 0) bishopsLight++;
      else bishopsDark++;
    }
    if (minors <= 1) return true;
    // Only bishops, all on the same colour of square: no mate is possible.
    return knights === 0 && (bishopsLight === 0 || bishopsDark === 0);
  }

  // Parses a move in UCI form ("e2e4", "e7e8q") into this position's legal move int, or 0.
  parseUci(u) {
    if (typeof u !== 'string' || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(u)) return 0;
    const from = sqIndex(u.slice(0, 2));
    const to = sqIndex(u.slice(2, 4));
    const promo = u[4] ? PIECE_CHARS.indexOf(u[4]) : 0;
    for (const m of this.legalMoves()) {
      if ((m & 127) !== from || ((m >> 7) & 127) !== to) continue;
      const mp = (m >> 14) & 7;
      if (mp && mp !== (promo || QUEEN)) continue;
      return m;
    }
    return 0;
  }

  perft(depth) {
    if (depth === 0) return 1;
    const list = this.generate([], false);
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      if (!this.make(list[i])) continue;
      n += depth === 1 ? 1 : this.perft(depth - 1);
      this.unmake();
    }
    return n;
  }
}

export function moveToUci(m) {
  const p = movePromo(m);
  return sqName(moveFrom(m)) + sqName(moveTo(m)) + (p ? PIECE_CHARS[p] : '');
}

// ---------------------------------------------------------------- SAN
const SAN_LETTER = ' PNBRQK';

// SAN of a legal move `m` in position `pos` (the position is left unchanged).
export function moveToSan(pos, m, legal = pos.legalMoves()) {
  const from = moveFrom(m);
  const to = moveTo(m);
  const flags = moveFlags(m);
  const piece = pos.board[from];
  const type = typeOf(piece);
  let san;
  if (flags & F_CASTLE) san = fileOf(to) === 6 ? 'O-O' : 'O-O-O';
  else if (type === PAWN) {
    san = flags & F_CAPTURE ? `${'abcdefgh'[fileOf(from)]}x${sqName(to)}` : sqName(to);
    if (flags & F_PROMO) san += `=${SAN_LETTER[movePromo(m)]}`;
  } else {
    let dis = '';
    const others = legal.filter((o) => o !== m && moveTo(o) === to && moveFrom(o) !== from && pos.board[moveFrom(o)] === piece);
    if (others.length) {
      const sameFile = others.some((o) => fileOf(moveFrom(o)) === fileOf(from));
      const sameRow = others.some((o) => rowOf(moveFrom(o)) === rowOf(from));
      if (!sameFile) dis = 'abcdefgh'[fileOf(from)];
      else if (!sameRow) dis = String(8 - rowOf(from));
      else dis = sqName(from);
    }
    san = SAN_LETTER[type] + dis + (flags & F_CAPTURE ? 'x' : '') + sqName(to);
  }
  if (pos.make(m)) {
    if (pos.inCheck()) san += pos.hasLegalMove() ? '+' : '#';
    pos.unmake();
  }
  return san;
}

// Parses SAN (lenient: "Nf3", "Ngf3", "exd5", "e8=Q", "e8Q", "O-O", "0-0", "Nf3+", "e2e4") into a legal
// move int of `pos`, or 0.
export function sanToMove(pos, input, legal = pos.legalMoves()) {
  if (typeof input !== 'string') return 0;
  let s = input.trim().replace(/[+#!?]+$/g, '').replace(/^\d+\.+\s*/, '');
  if (!s) return 0;
  s = s.replace(/0/g, 'O');
  if (s === 'O-O' || s === 'O-O-O') {
    const file = s === 'O-O' ? 6 : 2;
    return legal.find((m) => moveFlags(m) & F_CASTLE && fileOf(moveTo(m)) === file) || 0;
  }
  // exact SAN first
  for (const m of legal) if (moveToSan(pos, m, legal).replace(/[+#]$/, '') === s) return m;
  // UCI
  const u = /^([a-h][1-8])-?([a-h][1-8])=?([qrbnQRBN])?$/.exec(s);
  if (u) {
    const from = sqIndex(u[1]);
    const to = sqIndex(u[2]);
    const promo = u[3] ? PIECE_CHARS.indexOf(u[3].toLowerCase()) : 0;
    const found = legal.filter((m) => moveFrom(m) === from && moveTo(m) === to && (!(moveFlags(m) & F_PROMO) || movePromo(m) === (promo || QUEEN)));
    if (found.length === 1) return found[0];
  }
  const r = /^([NBRQK])?([a-h])?([1-8])?x?-?([a-h][1-8])=?([NBRQnbrq])?$/.exec(s);
  if (!r) return 0;
  const type = r[1] ? SAN_LETTER.indexOf(r[1]) : PAWN;
  const to = sqIndex(r[4]);
  const promo = r[5] ? SAN_LETTER.indexOf(r[5].toUpperCase()) : 0;
  const found = legal.filter((m) => {
    const from = moveFrom(m);
    if (moveTo(m) !== to || typeOf(pos.board[from]) !== type) return false;
    if (r[2] && fileOf(from) !== r[2].charCodeAt(0) - 97) return false;
    if (r[3] && rowOf(from) !== 8 - Number(r[3])) return false;
    if (moveFlags(m) & F_PROMO) return movePromo(m) === promo;
    return !promo;
  });
  return found.length === 1 ? found[0] : 0;
}

// ---------------------------------------------------------------- Chess (game with history)
const FLAG_LETTERS = (flags, captured) => {
  let s = '';
  if (flags & F_DOUBLE) s += 'b';
  if (flags & F_EP) s += 'e';
  else if (flags & F_CAPTURE || captured) s += 'c';
  if (flags & F_PROMO) s += 'p';
  if (flags & F_CASTLE) s += 'k';
  return s || 'n';
};

export class Chess {
  constructor(fen = START_FEN) {
    this.pos = new Position();
    this.load(fen);
  }

  load(fen = START_FEN) {
    const p = new Position();
    p.setFen(fen); // throws on invalid FEN
    this.pos = p;
    this.startFen = p.fen();
    this._history = [];
    this.headers = {};
    return this;
  }

  reset() {
    return this.load(START_FEN);
  }

  fen() {
    return this.pos.fen();
  }

  turn() {
    return this.pos.turn === WHITE ? 'w' : 'b';
  }

  get(square) {
    const sq = sqIndex(square);
    if (sq < 0) return null;
    const p = this.pos.board[sq];
    return p ? { type: PIECE_CHARS[typeOf(p)], color: colorOf(p) === WHITE ? 'w' : 'b' } : null;
  }

  // 8x8 array, row 0 = rank 8: [{type:'p', color:'w', square:'e2'} | null]
  board() {
    const out = [];
    for (let r = 0; r < 8; r++) {
      const row = [];
      for (let f = 0; f < 8; f++) {
        const sq = r * 16 + f;
        const p = this.pos.board[sq];
        row.push(p ? { type: PIECE_CHARS[typeOf(p)], color: colorOf(p) === WHITE ? 'w' : 'b', square: sqName(sq) } : null);
      }
      out.push(row);
    }
    return out;
  }

  _verbose(m, san, captured) {
    const from = moveFrom(m);
    const to = moveTo(m);
    const piece = this.pos.board[from];
    const flags = moveFlags(m);
    const cap = captured !== undefined ? captured : flags & F_EP ? makePiece(PAWN, this.pos.turn ^ 1) : this.pos.board[to];
    const o = {
      color: colorOf(piece) === WHITE ? 'w' : 'b',
      from: sqName(from),
      to: sqName(to),
      piece: PIECE_CHARS[typeOf(piece)],
      flags: FLAG_LETTERS(flags, cap),
      san,
      uci: moveToUci(m),
      move: m,
    };
    if (cap) o.captured = PIECE_CHARS[typeOf(cap)];
    if (flags & F_PROMO) o.promotion = PIECE_CHARS[movePromo(m)];
    if (flags & F_CASTLE) o.castle = fileOf(to) === 6 ? 'k' : 'q';
    return o;
  }

  // moves() -> SAN strings ; moves({ verbose: true, square: 'e2' }) -> move objects
  moves({ square, verbose = false } = {}) {
    const legal = this.pos.legalMoves();
    const sq = square ? sqIndex(square) : -1;
    const list = sq >= 0 ? legal.filter((m) => moveFrom(m) === sq) : square ? [] : legal;
    return list.map((m) => {
      const san = moveToSan(this.pos, m, legal);
      return verbose ? this._verbose(m, san) : san;
    });
  }

  // move('e4') | move('Nf3') | move({ from: 'e7', to: 'e8', promotion: 'q' }) | move('e2e4')
  // Returns the verbose move, or null when illegal.
  move(input) {
    const legal = this.pos.legalMoves();
    let m = 0;
    if (typeof input === 'string') m = sanToMove(this.pos, input, legal);
    else if (typeof input === 'number') m = legal.includes(input) ? input : 0;
    else if (input && typeof input === 'object') {
      const from = sqIndex(input.from);
      const to = sqIndex(input.to);
      const promo = input.promotion ? PIECE_CHARS.indexOf(String(input.promotion).toLowerCase()) : 0;
      m =
        legal.find((x) => moveFrom(x) === from && moveTo(x) === to && (!(moveFlags(x) & F_PROMO) || movePromo(x) === (promo > 1 && promo < 6 ? promo : QUEEN))) ||
        0;
    }
    if (!m) return null;
    const san = moveToSan(this.pos, m, legal);
    const v = this._verbose(m, san);
    v.before = this.pos.fen();
    this.pos.make(m);
    v.after = this.pos.fen();
    this._history.push(v);
    return v;
  }

  undo() {
    const v = this._history.pop();
    if (!v) return null;
    this.pos.unmake();
    return v;
  }

  history({ verbose = false } = {}) {
    return verbose ? this._history.slice() : this._history.map((v) => v.san);
  }

  get length() {
    return this._history.length;
  }

  inCheck() {
    return this.pos.inCheck();
  }
  isCheckmate() {
    return this.pos.inCheck() && !this.pos.hasLegalMove();
  }
  isStalemate() {
    return !this.pos.inCheck() && !this.pos.hasLegalMove();
  }
  isInsufficientMaterial() {
    return this.pos.insufficientMaterial();
  }
  isThreefoldRepetition() {
    return this.pos.repetitions() >= 3;
  }
  isFiftyMoves() {
    return this.pos.halfmove >= 100;
  }
  isDraw() {
    return this.isStalemate() || this.isInsufficientMaterial() || this.isThreefoldRepetition() || this.isFiftyMoves();
  }
  isGameOver() {
    return !!this.status();
  }

  // null while the game goes on, else { result: '1-0'|'0-1'|'1/2-1/2', winner: 'w'|'b'|null, reason }
  // reason: checkmate | stalemate | insufficient | repetition | fifty
  status() {
    const p = this.pos;
    const hasMove = p.hasLegalMove();
    if (!hasMove) {
      if (p.inCheck()) {
        const winner = p.turn === WHITE ? 'b' : 'w';
        return { result: winner === 'w' ? '1-0' : '0-1', winner, reason: 'checkmate' };
      }
      return { result: '1/2-1/2', winner: null, reason: 'stalemate' };
    }
    if (p.insufficientMaterial()) return { result: '1/2-1/2', winner: null, reason: 'insufficient' };
    if (p.repetitions() >= 3) return { result: '1/2-1/2', winner: null, reason: 'repetition' };
    if (p.halfmove >= 100) return { result: '1/2-1/2', winner: null, reason: 'fifty' };
    return null;
  }

  // Square of the king in check (for the red glow), or null.
  checkSquare() {
    return this.pos.inCheck() ? sqName(this.pos.kings[this.pos.turn]) : null;
  }

  // Material on the board: { w: points, b: points } (P1 N3 B3 R5 Q9).
  material() {
    const val = [0, 1, 3, 3, 5, 9, 0];
    const out = { w: 0, b: 0 };
    for (const sq of SQUARES) {
      const p = this.pos.board[sq];
      if (p) out[colorOf(p) === WHITE ? 'w' : 'b'] += val[typeOf(p)];
    }
    return out;
  }

  // ------------------------------------------------------------ PGN
  pgn({ headers = {}, result, maxWidth = 80 } = {}) {
    const res = result || headers.Result || this.status()?.result || '*';
    const h = {
      Event: 'Casual game',
      Site: 'Selene OS',
      Date: formatPgnDate(new Date()),
      Round: '-',
      White: '?',
      Black: '?',
      ...this.headers,
      ...headers,
      Result: res,
    };
    if (this.startFen !== START_FEN) {
      h.SetUp = '1';
      h.FEN = this.startFen;
    }
    const lines = Object.entries(h).map(([k, v]) => `[${k} "${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`);
    const tokens = [];
    const start = new Position();
    start.setFen(this.startFen);
    let num = start.fullmove;
    let black = start.turn === BLACK;
    this._history.forEach((v, i) => {
      if (!black) tokens.push(`${num}.`);
      else if (i === 0) tokens.push(`${num}...`);
      tokens.push(v.san);
      if (black) num++;
      black = !black;
    });
    tokens.push(res);
    const out = [];
    let line = '';
    for (const tok of tokens) {
      if (line && line.length + 1 + tok.length > maxWidth) {
        out.push(line);
        line = tok;
      } else line = line ? `${line} ${tok}` : tok;
    }
    if (line) out.push(line);
    return `${lines.join('\n')}\n\n${out.join('\n')}\n`;
  }

  // Loads a PGN (headers, comments, variations, NAGs and annotations are tolerated). Only the first
  // game of a multi-game file is read. Throws an Error with err.code = 'fen' (err.fenError holds the
  // validateFen code) for a bad [FEN] tag, or err.code = 'move' (err.move, err.ply) for an illegal move.
  loadPgn(text) {
    const src = String(text || '');
    const headers = {};
    const sans = [];
    // tags | {comments} | ;line comments | ( ) | $NAG | anything else up to a separator
    const re = /\[\s*(\w+)\s+"((?:[^"\\]|\\.)*)"\s*\]|\{[^}]*\}?|;[^\n]*|[()]|\$\d+|[^\s(){}[\];]+/g;
    let depth = 0;
    let mm;
    while ((mm = re.exec(src))) {
      const tok = mm[0];
      if (mm[1] !== undefined) {
        if (sans.length) break; // the next game's tags
        headers[mm[1]] = mm[2].replace(/\\(["\\])/g, '$1');
        continue;
      }
      if (tok[0] === '{' || tok[0] === ';' || tok[0] === '$') continue;
      if (tok === '(') depth++;
      else if (tok === ')') depth = Math.max(0, depth - 1);
      else if (!depth) {
        if (/^(1-0|0-1|1\/2-1\/2|½-½|\*)$/.test(tok)) {
          if (sans.length) break; // end of the first game
          continue;
        }
        // "12." "12..." "12…" "1.e4" -> move text only ; drop annotations like "!?", "+-", "e.p."
        const mv = tok.replace(/^\d+\s*(\.|…)+/, '').replace(/e\.p\.?$/, '');
        if (!mv || /^\d+$/.test(mv) || /^[.…]+$/.test(mv) || /^[!?+\-=∞±∓⩲⩱]+$/.test(mv)) continue;
        sans.push(mv);
      }
    }
    const fen = headers.FEN && headers.SetUp !== '0' ? headers.FEN : START_FEN;
    const fenError = validateFen(fen);
    if (fenError) {
      const err = new Error(`Invalid FEN (${fenError})`);
      err.code = 'fen';
      err.fenError = fenError;
      throw err;
    }
    const game = new Chess(fen);
    for (const tok of sans) {
      if (!game.move(tok)) {
        const err = new Error(`Illegal move: ${tok}`);
        err.code = 'move';
        err.move = tok;
        err.ply = game.length;
        throw err;
      }
    }
    this.pos = game.pos;
    this.startFen = game.startFen;
    this._history = game._history;
    this.headers = headers;
    return this;
  }

  perft(depth) {
    return this.pos.perft(depth);
  }
}

export function formatPgnDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`;
}
