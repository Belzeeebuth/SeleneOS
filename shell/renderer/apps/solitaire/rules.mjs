// Klondike solitaire rules — pure logic, no DOM. Imported by main.js (renderer) and by
// test/solitaire.test.mjs (node). Everything here is deterministic.
//
// Cards are integers 0..51:  suit = floor(c / 13)  (0 spades, 1 hearts, 2 diamonds, 3 clubs),
// rank = c % 13 + 1 (1 = Ace … 13 = King). Hearts and diamonds are red.
//
// Pile ids: 'stock', 'waste', 'f0'..'f3' (foundations), 't0'..'t6' (tableau).
// Every pile is an array ordered bottom -> top (the last element is the top card).
// Tableau face-down cards always form the bottom of a column, so a column only needs a
// count of hidden cards (state.hidden[i]); stock cards are face-down, waste/foundation face-up.
//
// Scoring (Windows rules):
//   standard: waste->tableau +5, waste/tableau->foundation +10, turn over tableau card +5,
//             foundation->tableau -15, recycle waste: -100 (draw 1) / -20 after the 3rd pass (draw 3),
//             timed games lose 2 points every 10 s and earn 700000 / seconds on a win (>= 30 s).
//             The score never goes below 0.
//   vegas:    every game costs $52, each card on a foundation pays $5 (-5 if taken back).
//             Draw 1 allows a single pass through the stock, draw 3 three passes.
//             With "cumulative" the bank carries over between games.
//   none:     no score.

export const SUITS = ['spades', 'hearts', 'diamonds', 'clubs'];
export const SUIT_LETTERS = ['S', 'H', 'D', 'C'];
export const RANK_LABELS = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
export const FOUNDATIONS = ['f0', 'f1', 'f2', 'f3'];
export const TABLEAU = ['t0', 't1', 't2', 't3', 't4', 't5', 't6'];
export const PILES = ['stock', 'waste', ...FOUNDATIONS, ...TABLEAU];
export const MAX_GAME = 1000000;
export const SCORINGS = ['standard', 'vegas', 'none'];

export const suitOf = (c) => Math.floor(c / 13);
export const rankOf = (c) => (c % 13) + 1;
export const isRed = (c) => suitOf(c) === 1 || suitOf(c) === 2;
export const cardOf = (suit, rank) => suit * 13 + rank - 1;
/** 'AS', '10H', 'QD', 'KC' */
export const codeOf = (c) => RANK_LABELS[rankOf(c)] + SUIT_LETTERS[suitOf(c)];
export function parseCode(code) {
  const m = /^(A|[2-9]|10|J|Q|K)([SHDC])$/i.exec(String(code).trim());
  if (!m) throw new Error(`bad card code ${code}`);
  return cardOf(SUIT_LETTERS.indexOf(m[2].toUpperCase()), RANK_LABELS.indexOf(m[1].toUpperCase()));
}

export const isFoundation = (id) => /^f[0-3]$/.test(id);
export const isTableau = (id) => /^t[0-6]$/.test(id);
const tIndex = (id) => Number(id.slice(1));

// ---------------------------------------------------------------- deterministic shuffle
/** mulberry32: tiny, fast, well-distributed 32-bit PRNG. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The 52-card deck for game #seed (Fisher–Yates driven by mulberry32). */
export function shuffledDeck(seed) {
  // Mix the game number so neighbouring numbers give unrelated deals.
  const rand = mulberry32(Math.imul((seed >>> 0) ^ 0x9e3779b9, 0x85ebca6b) ^ 0x5bd1e995);
  const deck = Array.from({ length: 52 }, (_, i) => i);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

export function randomGameNumber(rand = Math.random) {
  return 1 + Math.floor(rand() * MAX_GAME);
}

// ---------------------------------------------------------------- state
function normalizeOpts(o = {}) {
  return {
    draw: Number(o.draw) === 3 ? 3 : 1,
    scoring: SCORINGS.includes(o.scoring) ? o.scoring : 'standard',
    timed: o.timed !== false,
    bank: Number.isFinite(o.bank) ? o.bank : 0, // vegas starting bank (cumulative mode)
  };
}

/** A fresh deal for game number `seed`. */
export function dealState(seed, opts = {}) {
  const o = normalizeOpts(opts);
  const n = Math.max(1, Math.min(MAX_GAME, Math.floor(Number(seed)) || 1));
  const deck = shuffledDeck(n);
  const t = [[], [], [], [], [], [], []];
  let p = 0;
  // Deal across, row by row, like a real dealer: one card to every column still growing.
  for (let row = 0; row < 7; row++) for (let col = row; col < 7; col++) t[col].push(deck[p++]);
  const stock = deck.slice(p).reverse(); // last element = top of the stock
  return {
    v: 1,
    seed: n,
    draw: o.draw,
    scoring: o.scoring,
    timed: o.timed,
    bank: o.bank,
    stock,
    waste: [],
    fan: 0, // how many waste cards are fanned (draw 3)
    f: [[], [], [], []],
    t,
    hidden: [0, 1, 2, 3, 4, 5, 6],
    score: o.scoring === 'vegas' ? o.bank - 52 : 0,
    moves: 0,
    recycles: 0,
    elapsed: 0,
    won: false,
    bonus: 0,
  };
}

function cloneState(s) {
  return {
    ...s,
    stock: s.stock.slice(),
    waste: s.waste.slice(),
    f: s.f.map((x) => x.slice()),
    t: s.t.map((x) => x.slice()),
    hidden: s.hidden.slice(),
  };
}

/** Throws if `s` is not a coherent Klondike state (used when loading saved games / test states). */
export function validateState(s) {
  if (!s || typeof s !== 'object') throw new Error('state missing');
  const all = [...(s.stock || []), ...(s.waste || []), ...(s.f || []).flat(), ...(s.t || []).flat()];
  if (all.length !== 52 || new Set(all).size !== 52 || all.some((c) => !Number.isInteger(c) || c < 0 || c > 51)) {
    throw new Error('state must contain each of the 52 cards exactly once');
  }
  if (!Array.isArray(s.f) || s.f.length !== 4 || !Array.isArray(s.t) || s.t.length !== 7) throw new Error('bad pile layout');
  if (!Array.isArray(s.hidden) || s.hidden.length !== 7) throw new Error('bad hidden counts');
  s.hidden.forEach((hc, i) => {
    if (!Number.isInteger(hc) || hc < 0 || hc > s.t[i].length) throw new Error(`bad hidden count in column ${i}`);
  });
  for (const pile of s.f) {
    pile.forEach((c, i) => {
      if (rankOf(c) !== i + 1 || suitOf(c) !== suitOf(pile[0])) throw new Error('foundation out of order');
    });
  }
  return true;
}

const finite = (v, def) => (typeof v === 'number' && Number.isFinite(v) ? v : def);
const count = (v) => Math.max(0, Math.floor(finite(v, 0)));
const cardList = (v) => (Array.isArray(v) ? v.slice() : []);

/**
 * A clean copy of a state read from storage: options and counters are coerced to valid values,
 * piles are copied, a column's top card is always face up. Throws when the cards themselves are
 * not a coherent Klondike layout (see validateState).
 */
export function normalizeState(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('state missing');
  const seed = Math.floor(finite(raw.seed, 1));
  const s = {
    v: 1,
    seed: seed >= 1 && seed <= MAX_GAME ? seed : 1,
    draw: raw.draw === 3 ? 3 : 1,
    scoring: SCORINGS.includes(raw.scoring) ? raw.scoring : 'standard',
    timed: raw.timed !== false,
    bank: Math.round(finite(raw.bank, 0)),
    stock: cardList(raw.stock),
    waste: cardList(raw.waste),
    fan: 0,
    f: Array.isArray(raw.f) ? raw.f.map(cardList) : [],
    t: Array.isArray(raw.t) ? raw.t.map(cardList) : [],
    hidden: Array.isArray(raw.hidden) ? raw.hidden.slice() : [],
    score: 0,
    moves: count(raw.moves),
    recycles: count(raw.recycles),
    elapsed: Math.max(0, finite(raw.elapsed, 0)),
    won: false,
    bonus: count(raw.bonus),
  };
  if (!Array.isArray(raw.hidden) && s.t.length === 7) s.hidden = s.t.map((col) => Math.max(0, col.length - 1));
  validateState(s);
  // Klondike never leaves a column with its top card face down.
  s.hidden = s.hidden.map((n, i) => Math.min(n, Math.max(0, s.t[i].length - 1)));
  const maxFan = Math.min(s.waste.length, s.draw === 3 ? 3 : 1);
  s.fan = Math.min(maxFan, count(raw.fan ?? maxFan));
  if (s.waste.length && !s.fan) s.fan = 1;
  const defScore = s.scoring === 'vegas' ? s.bank - 52 : 0;
  s.score = Math.round(finite(raw.score, defScore));
  if (s.scoring === 'standard') s.score = Math.max(0, s.score);
  if (s.scoring === 'none') s.score = 0;
  s.won = s.f.reduce((n, p) => n + p.length, 0) === 52;
  if (!s.won) s.bonus = 0;
  return s;
}

// ---------------------------------------------------------------- game
export class Klondike {
  constructor(state, history = []) {
    validateState(state);
    this.s = state;
    this.history = history; // snapshots for unlimited undo (elapsed time is not restored)
  }

  static deal(seed, opts) {
    return new Klondike(dealState(seed, opts));
  }

  /**
   * Accepts a saved game ({state, history}) or a bare state. The data comes from disk, so every field is
   * checked: missing or malformed values get safe defaults and incoherent card layouts are refused.
   */
  static fromJSON(json) {
    const raw = json?.state ? json.state : json;
    const game = new Klondike(normalizeState(raw));
    if (Array.isArray(json?.history)) {
      for (const h of json.history) {
        try {
          game.history.push(normalizeState(h));
        } catch {
          // ignore a corrupt history entry rather than refusing the whole game
        }
      }
    }
    return game;
  }

  toJSON({ maxHistory = 400 } = {}) {
    return { state: cloneState(this.s), history: this.history.slice(-maxHistory).map(cloneState) };
  }

  // ------------------------------------------------------------ basic queries
  get draw() {
    return this.s.draw;
  }
  get started() {
    return this.s.moves > 0 || this.history.length > 0;
  }
  pile(id) {
    const s = this.s;
    if (id === 'stock') return s.stock;
    if (id === 'waste') return s.waste;
    if (isFoundation(id)) return s.f[tIndex(id)];
    if (isTableau(id)) return s.t[tIndex(id)];
    throw new Error(`unknown pile ${id}`);
  }
  top(id) {
    const p = this.pile(id);
    return p.length ? p[p.length - 1] : null;
  }
  isFaceUp(id, index) {
    if (id === 'stock') return false;
    if (isTableau(id)) return index >= this.s.hidden[tIndex(id)];
    return true;
  }
  /** Where is card c? -> { pile, index } */
  locate(c) {
    for (const id of PILES) {
      const i = this.pile(id).indexOf(c);
      if (i >= 0) return { pile: id, index: i };
    }
    return null;
  }
  foundationCount() {
    return this.s.f.reduce((n, p) => n + p.length, 0);
  }
  isWon() {
    return this.foundationCount() === 52;
  }
  /** Score shown to the player (time penalty applied, win bonus included). */
  get score() {
    const s = this.s;
    if (s.scoring === 'none') return 0;
    if (s.scoring === 'vegas') return s.score;
    const pen = s.timed ? 2 * Math.floor(s.elapsed / 10000) : 0;
    return Math.max(0, s.score - pen) + (s.bonus || 0);
  }

  // ------------------------------------------------------------ move legality
  /** Can the cards from `index` to the top of pile `id` be picked up together? */
  canPick(id, index) {
    const p = this.pile(id);
    if (index < 0 || index >= p.length || this.s.won) return false;
    if (id === 'stock') return false;
    if (id === 'waste' || isFoundation(id)) return index === p.length - 1;
    if (index < this.s.hidden[tIndex(id)]) return false;
    for (let i = index; i < p.length - 1; i++) {
      const a = p[i];
      const b = p[i + 1];
      if (rankOf(b) !== rankOf(a) - 1 || isRed(a) === isRed(b)) return false;
    }
    return true;
  }

  /** Would the run starting with card `lead` (of `count` cards) fit on pile `to`? */
  accepts(to, lead, count = 1) {
    const dest = this.pile(to);
    const top = dest.length ? dest[dest.length - 1] : null;
    if (isFoundation(to)) {
      if (count !== 1) return false;
      if (top == null) return rankOf(lead) === 1;
      return suitOf(top) === suitOf(lead) && rankOf(lead) === rankOf(top) + 1;
    }
    if (isTableau(to)) {
      if (top == null) return rankOf(lead) === 13;
      if (dest.length <= this.s.hidden[tIndex(to)]) return false;
      return rankOf(lead) === rankOf(top) - 1 && isRed(lead) !== isRed(top);
    }
    return false;
  }

  canMove(from, index, to) {
    if (from === to || !this.canPick(from, index)) return false;
    if (to === 'stock' || to === 'waste') return false;
    if (isFoundation(from) && isFoundation(to)) return false;
    const p = this.pile(from);
    return this.accepts(to, p[index], p.length - index);
  }

  legalTargets(from, index) {
    return [...FOUNDATIONS, ...TABLEAU].filter((to) => this.canMove(from, index, to));
  }

  /** Best destination for a click / double-click: foundation first, then a building column, then an empty one. */
  bestTarget(from, index) {
    const targets = this.legalTargets(from, index);
    if (!targets.length) return null;
    const p = this.pile(from);
    const single = index === p.length - 1;
    if (single) {
      const f = targets.find(isFoundation);
      if (f) return f;
    }
    const tabs = targets.filter(isTableau);
    // A King already at the bottom of a column gains nothing by moving to another empty column.
    const pointlessKing = isTableau(from) && index === 0;
    const building = tabs.filter((t) => this.pile(t).length > 0);
    if (building.length) return nearest(building, from);
    const empty = tabs.filter((t) => this.pile(t).length === 0);
    if (empty.length && !pointlessKing) return nearest(empty, from);
    return targets.find(isFoundation) || null;
  }

  // ------------------------------------------------------------ stock
  recyclesAllowed() {
    if (this.s.scoring !== 'vegas') return Infinity;
    return this.s.draw === 3 ? 2 : 0;
  }
  canRecycle() {
    return this.s.stock.length === 0 && this.s.waste.length > 0 && this.s.recycles < this.recyclesAllowed();
  }
  canDraw() {
    return !this.s.won && (this.s.stock.length > 0 || this.canRecycle());
  }

  // ------------------------------------------------------------ mutations
  _push() {
    this.history.push(cloneState(this.s));
  }

  _addScore(delta) {
    const s = this.s;
    if (s.scoring === 'none' || !delta) return;
    s.score += delta;
    if (s.scoring === 'standard') s.score = Math.max(0, s.score);
  }

  /** Turn over cards from the stock (or recycle the waste). Returns an event or null. */
  drawCards() {
    const s = this.s;
    if (!this.canDraw()) return null;
    this._push();
    s.moves++;
    if (s.stock.length === 0) {
      // Recycle: flip the whole waste back over.
      const before = s.recycles;
      s.stock = s.waste.reverse();
      s.waste = [];
      s.fan = 0;
      s.recycles++;
      if (s.scoring === 'standard') {
        if (s.draw === 1) this._addScore(-100);
        else if (before >= 2) this._addScore(-20);
      }
      return { type: 'recycle', cards: s.stock.slice() };
    }
    const n = Math.min(s.draw, s.stock.length);
    const cards = [];
    for (let i = 0; i < n; i++) {
      const c = s.stock.pop();
      s.waste.push(c);
      cards.push(c);
    }
    s.fan = s.draw === 3 ? n : 1;
    return { type: 'draw', cards };
  }

  /** Move the run starting at `index` of pile `from` to pile `to`. Returns an event or null if illegal. */
  move(from, index, to) {
    if (this.s.won || !this.canMove(from, index, to)) return null;
    const s = this.s;
    this._push();
    const src = this.pile(from);
    const cards = src.splice(index);
    this.pile(to).push(...cards);
    s.moves++;
    const vegas = s.scoring === 'vegas';
    let delta = 0;
    if (isFoundation(to) && !isFoundation(from)) delta += vegas ? 5 : 10;
    if (from === 'waste' && isTableau(to) && !vegas) delta += 5;
    if (isFoundation(from) && isTableau(to)) delta += vegas ? -5 : -15;
    this._addScore(delta);
    if (from === 'waste') s.fan = Math.max(s.waste.length ? 1 : 0, s.fan - 1);
    let flipped = null;
    if (isTableau(from)) {
      const i = tIndex(from);
      if (src.length > 0 && s.hidden[i] >= src.length) {
        s.hidden[i] = src.length - 1;
        flipped = src[src.length - 1];
        if (!vegas) this._addScore(5);
      }
    }
    const ev = { type: 'move', from, to, index, cards, flipped };
    if (this.isWon()) {
      s.won = true;
      if (s.scoring === 'standard' && s.timed) {
        const sec = s.elapsed / 1000;
        s.bonus = sec >= 30 ? Math.round(700000 / sec) : 0;
      }
      ev.won = true;
    }
    return ev;
  }

  undo() {
    if (!this.history.length) return false;
    const elapsed = this.s.elapsed;
    this.s = this.history.pop();
    this.s.elapsed = elapsed;
    return true;
  }
  canUndo() {
    return this.history.length > 0 && !this.s.won;
  }

  /** Advance the game clock (only runs once the first move is made and until the game is won). */
  tick(ms) {
    if (this.s.won || !this.started) return;
    this.s.elapsed += Math.max(0, ms);
  }

  /** Restart the same deal with the same options (counts as a new attempt). */
  restarted() {
    const s = this.s;
    return Klondike.deal(s.seed, { draw: s.draw, scoring: s.scoring, timed: s.timed, bank: s.bank });
  }

  // ------------------------------------------------------------ automation & hints
  /**
   * Every card has been seen (stock exhausted, no face-down tableau card) and the rest can be played
   * straight to the foundations — recycling the waste if the scoring mode allows it.
   */
  canAutoComplete() {
    if (this.s.won || this.s.stock.length) return false;
    if (this.s.hidden.some((n) => n > 0)) return false;
    const sim = new Klondike(cloneState(this.s));
    for (let guard = 0; guard < 2000; guard++) {
      if (sim.isWon()) return true;
      const step = sim.autoStep();
      if (!step) return false;
      sim.applyStep(step);
    }
    return false;
  }

  /** The next auto-complete step: { from, index, to } or { draw: true }, or null when stuck. */
  autoStep() {
    if (this.s.won) return null;
    let best = null;
    for (const from of ['waste', ...TABLEAU]) {
      const p = this.pile(from);
      if (!p.length) continue;
      const c = p[p.length - 1];
      if (from !== 'waste' && p.length <= this.s.hidden[tIndex(from)]) continue;
      for (const to of FOUNDATIONS) {
        if (this.accepts(to, c, 1) && (!best || rankOf(c) < rankOf(best.card))) best = { from, index: p.length - 1, to, card: c };
      }
    }
    if (best) {
      // Prefer the foundation already holding that suit, else the first empty one.
      return { from: best.from, index: best.index, to: this.foundationFor(best.card) || best.to };
    }
    if (!this.canDraw()) return null;
    // Drawing only helps if a full cycle can still surface a playable card.
    const reach = this.reachableWasteCards();
    if (!reach.some((c) => FOUNDATIONS.some((f) => this.accepts(f, c, 1)))) return null;
    return { draw: true };
  }

  applyStep(step) {
    if (step.draw) return this.drawCards();
    return this.move(step.from, step.index, step.to);
  }

  foundationFor(c) {
    const same = FOUNDATIONS.find((f) => {
      const p = this.pile(f);
      return p.length && suitOf(p[0]) === suitOf(c);
    });
    if (same) return this.accepts(same, c, 1) ? same : null;
    if (rankOf(c) !== 1) return null;
    return FOUNDATIONS.find((f) => this.pile(f).length === 0) || null;
  }

  /** Every card that can appear on top of the waste by drawing (without other moves), current top included. */
  reachableWasteCards() {
    const s = this.s;
    const seen = new Set();
    if (s.waste.length) seen.add(s.waste[s.waste.length - 1]);
    let stock = s.stock.slice();
    let waste = s.waste.slice();
    let recycles = s.recycles;
    const allowed = this.recyclesAllowed();
    const total = stock.length + waste.length;
    // Draw 3 can take a few cycles to show every reachable card; a bounded loop is plenty.
    const maxDraws = (Math.ceil(total / Math.max(1, s.draw)) + 1) * 4;
    for (let i = 0; i < maxDraws; i++) {
      if (!stock.length) {
        if (!waste.length || recycles >= allowed) break;
        stock = waste.reverse();
        waste = [];
        recycles++;
        continue;
      }
      const n = Math.min(s.draw, stock.length);
      for (let k = 0; k < n; k++) waste.push(stock.pop());
      seen.add(waste[waste.length - 1]);
    }
    return [...seen];
  }

  /**
   * Useful moves, best first: [{ from, index, to, kind, rank }]. Drawing from the stock is
   * suggested ({ from: 'stock', draw: true }) when a card worth playing can still come up.
   */
  hints() {
    const out = [];
    const s = this.s;
    const seen = new Set();
    const add = (from, index, to, kind, rank) => {
      // One suggestion per (card, kind of destination): no "Ace to foundation 1/2/3/4" or "King to each empty column".
      const dest = this.pile(to).length === 0 ? 'empty' : to;
      const key = `${from}:${index}:${isFoundation(to) ? 'f' : dest}`;
      if (seen.has(key)) return;
      if (isFoundation(to) && to !== this.foundationFor(this.pile(from)[index])) return;
      seen.add(key);
      out.push({ from, index, to, kind, rank });
    };
    const kingWaiting = () =>
      (s.waste.length && rankOf(s.waste[s.waste.length - 1]) === 13) ||
      TABLEAU.some((t, i) => {
        const p = s.t[i];
        const first = s.hidden[i];
        return p.length > first && first > 0 && rankOf(p[first]) === 13;
      });
    const fitsOn = (under, c) => rankOf(c) === rankOf(under) - 1 && isRed(c) !== isRed(under);
    const wasteTop = s.waste.length ? s.waste[s.waste.length - 1] : null;
    // Heads of the runs sitting on face-down cards: giving them a place turns a card over.
    const revealHeads = TABLEAU.map((t, i) => (s.hidden[i] > 0 && s.t[i].length > s.hidden[i] ? s.t[i][s.hidden[i]] : null)).filter((c) => c != null);
    // A card that the waste top or a revealing run is waiting for is better left on the tableau for now.
    const wanted = (c) => (wasteTop != null && fitsOn(c, wasteTop)) || revealHeads.some((hc) => fitsOn(c, hc));
    // Waste and foundation tops.
    if (s.waste.length) {
      const idx = s.waste.length - 1;
      for (const to of this.legalTargets('waste', idx)) {
        add('waste', idx, to, isFoundation(to) ? 'waste-foundation' : 'waste-tableau', isFoundation(to) ? 80 : 60);
      }
    }
    // Tableau runs.
    TABLEAU.forEach((from, i) => {
      const p = s.t[i];
      if (!p.length) return;
      const first = s.hidden[i];
      for (let idx = first; idx < p.length; idx++) {
        if (!this.canPick(from, idx)) continue;
        const reveals = idx === first && first > 0;
        const empties = idx === 0;
        for (const to of this.legalTargets(from, idx)) {
          if (isFoundation(to)) {
            add(from, idx, to, 'foundation', reveals ? 100 : wanted(p[idx]) ? 10 : 70);
            continue;
          }
          const destEmpty = this.pile(to).length === 0;
          if (reveals) add(from, idx, to, 'reveal', destEmpty ? 85 : 90);
          else if (empties && !destEmpty) {
            if (kingWaiting()) add(from, idx, to, 'empty-column', 30);
          } else if (idx > first) {
            // Splitting a run only helps if the card it uncovers can go somewhere.
            const under = p[idx - 1];
            if (FOUNDATIONS.some((f) => this.accepts(f, under, 1))) add(from, idx, to, 'unblock', 40);
          }
        }
      }
    });
    out.sort((a, b) => b.rank - a.rank);
    if (this.canDraw()) {
      const playable = this.reachableWasteCards().some((c) => c !== s.waste[s.waste.length - 1] && this._placeable(c));
      if (playable) out.push({ from: 'stock', index: s.stock.length - 1, to: 'waste', draw: true, kind: 'draw', rank: 5 });
    }
    if (!out.length) {
      // Last resort: take a card back down from a foundation when that gives a stuck card a place —
      // one the stock can still bring up, or the head of a run that would turn a card over.
      const reach = this.reachableWasteCards();
      FOUNDATIONS.forEach((from, fi) => {
        const p = s.f[fi];
        if (!p.length) return;
        const fc = p[p.length - 1];
        if (!reach.some((c) => fitsOn(fc, c)) && !revealHeads.some((hc) => fitsOn(fc, hc))) return;
        const to = TABLEAU.find((t) => this.canMove(from, p.length - 1, t));
        if (to) add(from, p.length - 1, to, 'foundation-down', 3);
      });
    }
    return out;
  }

  _placeable(c) {
    return [...FOUNDATIONS, ...TABLEAU].some((to) => this.accepts(to, c, 1));
  }

  /** False when no useful move is left (the "no more moves" situation). */
  hasMoves() {
    if (this.s.won) return false;
    if (this.hints().length) return true;
    return false;
  }
}

function nearest(list, from) {
  if (!isTableau(from)) return list[0];
  const i = tIndex(from);
  return list.slice().sort((a, b) => Math.abs(tIndex(a) - i) - Math.abs(tIndex(b) - i) || tIndex(a) - tIndex(b))[0];
}

// ---------------------------------------------------------------- statistics
export function emptyStats() {
  return { played: 0, won: 0, bestTime: 0, bestScore: 0, streak: 0, longestWin: 0, longestLoss: 0, totalTime: 0 };
}

/** A clean stats record for one draw mode (the stored copy may be missing fields or hand-edited). */
export function sanitizeStats(raw) {
  const st = emptyStats();
  if (!raw || typeof raw !== 'object') return st;
  for (const k of Object.keys(st)) {
    const v = raw[k];
    if (typeof v === 'number' && Number.isFinite(v)) st[k] = k === 'streak' ? Math.round(v) : Math.max(0, Math.round(v));
  }
  st.won = Math.min(st.won, st.played);
  return st;
}

/**
 * Record a finished game (won or lost) in a stats object; returns a new object.
 * The best score only follows standard scoring: Vegas dollars are not comparable with points.
 */
export function recordResult(stats, { won, time = 0, score = 0, scoring = 'standard' }) {
  const st = sanitizeStats(stats);
  st.played++;
  st.totalTime += Math.round(time);
  if (won) {
    st.won++;
    if (!st.bestTime || time < st.bestTime) st.bestTime = Math.round(time);
    if (scoring === 'standard' && score > st.bestScore) st.bestScore = score;
    st.streak = st.streak > 0 ? st.streak + 1 : 1;
    st.longestWin = Math.max(st.longestWin, st.streak);
  } else {
    st.streak = st.streak < 0 ? st.streak - 1 : -1;
    st.longestLoss = Math.max(st.longestLoss, -st.streak);
  }
  return st;
}

/**
 * Build a state from a readable description (used by tests and the test hook), e.g.
 *   stateFrom({ t: [['KS', 'QH'], ...], hidden: [1, ...], waste: ['3D'], f: [['AS']], stock: [...], draw: 3 })
 * Cards not mentioned go to the stock, or — with `fill: 'waste'` / `fill: 't6'` — under the waste or
 * face-down at the bottom of that column (handy when the stock must stay exactly as given).
 */
export function stateFrom(desc = {}) {
  const used = new Set();
  const conv = (arr) =>
    (arr || []).map((x) => {
      const c = typeof x === 'number' ? x : parseCode(x);
      used.add(c);
      return c;
    });
  const t = (desc.t || [[], [], [], [], [], [], []]).map(conv);
  while (t.length < 7) t.push([]);
  const f = (desc.f || [[], [], [], []]).map(conv);
  while (f.length < 4) f.push([]);
  let waste = conv(desc.waste);
  let stock = desc.stock ? conv(desc.stock) : null;
  const hidden = desc.hidden ? desc.hidden.slice() : t.map(() => 0);
  const rest = Array.from({ length: 52 }, (_, i) => i).filter((c) => !used.has(c));
  if (!stock && (!desc.fill || desc.fill === 'stock')) stock = rest;
  else if (rest.length) {
    if (desc.fill === 'waste') waste = [...rest, ...waste];
    else if (isTableau(desc.fill || '')) {
      const i = tIndex(desc.fill);
      t[i] = [...rest, ...t[i]];
      hidden[i] += rest.length;
    } else if (desc.fill === 'stock') stock = [...rest, ...stock];
  }
  if (!stock) stock = [];
  const s = dealState(desc.seed || 1, desc);
  Object.assign(s, {
    stock,
    waste,
    f,
    t,
    hidden,
    fan: desc.fan ?? Math.min(waste.length, s.draw === 3 ? 3 : 1),
    score: desc.score ?? s.score,
    moves: desc.moves ?? 0,
    recycles: desc.recycles ?? 0,
    elapsed: desc.elapsed ?? 0,
    won: false,
    bonus: 0,
  });
  validateState(s);
  return s;
}
