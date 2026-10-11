// Aurora Chess tests.
//   1. Rules + AI (node): perft (start position depth 1-4, Kiwipete depth 1-3, + 3 classic positions),
//      FEN validation / round trip, SAN out (disambiguation, castling, promotion, check, mate) and in,
//      PGN export / import, game end detection, AI legality + time per level, mate finding, book.
//   2. UI (Playwright + the real Electron shell): click and drag moves, computer replies (Web Worker,
//      "Thinking…"), castling, en passant, promotion picker, checkmate / stalemate / insufficient
//      material / repetition result dialogs, undo, hint, flip, move list navigation, keyboard play,
//      draw offers (declined / accepted), resignation, clocks + timeout, new game dialog, FEN/PGN import
//      and analysis mode, themes, persistence (resume after relaunch), EN/FR, light/dark, min size and
//      maximized layouts, and no renderer errors.
// Usage (from aurora-os/shell):
//   xvfb-run -a -s "-screen 0 1920x1080x24" node test/chess.test.mjs          # everything
//   node test/chess.test.mjs --unit                                           # rules + AI only
//   xvfb-run … node test/chess.test.mjs --ui --sessions=4,5                   # some UI sessions only
// Screenshots: test/out/chess-*.png, published to docs/screenshots/chess-*.png.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Chess, Position, START_FEN, validateFen, moveToSan, sanToMove } from '../renderer/apps/chess/engine.mjs';
import { Engine, LEVELS, LEVEL_IDS, bookLines, bookMoves, evaluate, positionFrom } from '../renderer/apps/chess/ai.mjs';
import { pieceSvg, PIECE_CODES } from '../renderer/apps/chess/pieces.mjs';

const args = process.argv.slice(2);
const UNIT_ONLY = args.includes('--unit');
const UI_ONLY = args.includes('--ui');
// --sessions=4,5 runs only those UI sessions (1 English, 2 persistence, 3 French, 4 robustness, 5 screens)
const SESSIONS = (args.find((a) => a.startsWith('--sessions=')) || '').slice(11).split(',').filter(Boolean);
const want = (n) => !SESSIONS.length || SESSIONS.includes(String(n));

let passed = 0;
let failed = 0;
async function test(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    passed++;
    console.log(`  ok    ${name} (${Date.now() - t0} ms)`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}\n${String(err?.stack || err).replace(/^/gm, '        ')}`);
  }
}

const KIWIPETE = 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1';
const MIDGAME_BLACK = 'r1bq1rk1/pp2bppp/2n1pn2/3p4/2PP4/2N1PN2/PP3PPP/R2QKB1R b KQ - 0 8';

// ---------------------------------------------------------------- 1. rules + AI
async function unitTests() {
  console.log('Rules and AI (node)');

  await test('perft: start position depth 1-4 = 20, 400, 8902, 197281', () => {
    const p = Position.fromFen(START_FEN);
    assert.deepEqual([1, 2, 3, 4].map((d) => p.perft(d)), [20, 400, 8902, 197281]);
    assert.equal(p.fen(), START_FEN, 'make/unmake restores the position');
  });

  await test('perft: Kiwipete depth 1-3 = 48, 2039, 97862', () => {
    const p = Position.fromFen(KIWIPETE);
    assert.deepEqual([1, 2, 3].map((d) => p.perft(d)), [48, 2039, 97862]);
    assert.equal(p.fen(), KIWIPETE);
  });

  await test('perft: classic positions 3, 4 and 5 (en passant, promotions, castling edge cases)', () => {
    assert.equal(Position.fromFen('8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1').perft(5), 674624);
    assert.equal(Position.fromFen('r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1').perft(4), 422333);
    assert.equal(Position.fromFen('rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8').perft(3), 62379);
  });

  await test('FEN: round trip, defaults and validation errors', () => {
    for (const f of [START_FEN, KIWIPETE, MIDGAME_BLACK, '8/8/8/4k3/8/8/8/4K2Q w - - 12 40']) assert.equal(new Chess(f).fen(), f);
    assert.equal(new Chess('4k3/8/8/8/8/8/8/4K3 w - -').fen(), '4k3/8/8/8/8/8/8/4K3 w - - 0 1', '4-field FEN gets clocks');
    const bad = {
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP w KQkq - 0 1': 'rows',
      'rnbqkbnr/pppppppp/9/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1': 'pieces',
      'rnbqkbnr/pppppppp/71/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1': 'rows',
      'rnbqqbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1': 'kings',
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR x KQkq - 0 1': 'turn',
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq e4 0 1': 'enpassant',
      'pnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1': 'pawns',
      'rnbqkbnr/ppppxppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1': 'pieces',
      '4k3/8/8/8/8/8/8/R3K3 b - - 0 1 extra': 'fields',
      '4k3/4R3/8/8/8/8/8/4K3 w - - 0 1': 'check',
    };
    for (const [fen, code] of Object.entries(bad)) assert.equal(validateFen(fen), code, fen);
    assert.throws(() => new Chess('nonsense'));
    // castling rights are dropped when king/rook are not on their squares
    assert.equal(new Chess('4k3/8/8/8/8/8/8/4K2R w KQkq - 0 1').fen(), '4k3/8/8/8/8/8/8/4K2R w K - 0 1');
    // en passant square kept only when a capture is possible
    assert.equal(new Chess('rnbqkbnr/pppp1ppp/8/8/4p3/8/PPPPPPPP/RNBQKBNR w KQkq e6 0 1').fen().split(' ')[3], '-');
  });

  await test('SAN: pieces, captures, disambiguation, castling, promotion, check and mate', () => {
    const g = new Chess();
    for (const m of ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Bxc6', 'dxc6', 'O-O', 'f6']) assert.ok(g.move(m), m);
    assert.deepEqual(g.history(), ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Bxc6', 'dxc6', 'O-O', 'f6']);
    // file and rank disambiguation
    const d = new Chess('4k3/8/8/8/8/8/8/R4RK1 w - - 0 1');
    assert.ok(d.moves().includes('Rad1') && d.moves().includes('Rfd1') && d.moves().includes('Rae1+'), 'file disambiguation');
    assert.ok(d.moves().includes('Ra2') && !d.moves().includes('Raa2'), 'no needless disambiguation');
    const r = new Chess('4k3/8/8/R7/8/8/8/R3K3 w - - 0 1');
    assert.ok(r.moves().includes('R5a3') && r.moves().includes('R1a3'), 'rank disambiguation');
    const q = new Chess('7k/8/8/8/2Q1Q3/8/2Q5/4K3 w - - 0 1');
    assert.ok(q.moves().includes('Qc4d3'), 'full square when file and rank are shared');
    assert.ok(q.moves().includes('Qed3'), 'file');
    assert.ok(q.moves().includes('Q2d3'), 'rank');
    // promotion + check, queenside castling, mate
    const p = new Chess('r3k3/1P6/8/8/8/8/8/4K3 w q - 0 1');
    assert.ok(p.moves().includes('bxa8=Q+'));
    assert.ok(p.moves().includes('b8=N'));
    const c = new Chess('r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1');
    assert.ok(c.moves().includes('O-O-O') && c.moves().includes('O-O'));
    const m = new Chess('6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1');
    assert.ok(m.moves().includes('Rd8#'));
    // en passant SAN
    const ep = new Chess('rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3');
    const v = ep.move('exf6');
    assert.ok(v && v.flags.includes('e') && v.captured === 'p');
    assert.equal(ep.get('f5'), null);
  });

  await test('SAN input: lenient parsing (UCI, 0-0, missing =, over-disambiguation)', () => {
    const g = new Chess();
    assert.ok(g.move('e2e4'));
    assert.ok(g.move('e7-e5'));
    assert.ok(g.move('Ngf3'), 'over-disambiguated');
    assert.ok(g.move({ from: 'b8', to: 'c6' }));
    assert.equal(g.move('Ke3'), null, 'illegal');
    assert.equal(g.move('Qh5h6'), null);
    const c = new Chess('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
    assert.ok(c.move('0-0'));
    const p = new Chess('4k3/1P6/8/8/8/8/8/4K3 w - - 0 1');
    assert.equal(p.move('b8Q').san, 'b8=Q+');
    const pos = Position.fromFen(START_FEN);
    assert.equal(moveToSan(pos, sanToMove(pos, 'Nf3')), 'Nf3');
  });

  await test('game end: checkmate, stalemate, insufficient material, fifty moves, threefold repetition', () => {
    const fool = new Chess();
    for (const m of ['f3', 'e5', 'g4', 'Qh4#']) fool.move(m);
    assert.deepEqual(fool.status(), { result: '0-1', winner: 'b', reason: 'checkmate' });
    assert.ok(fool.isCheckmate() && fool.isGameOver());
    const stale = new Chess('7k/8/4Q1K1/8/8/8/8/8 w - - 0 1');
    stale.move('Qf7');
    assert.equal(stale.status().reason, 'stalemate');
    for (const f of ['8/8/8/4k3/8/8/8/4K3 w - - 0 1', '8/8/8/4k3/8/8/8/4KB2 w - - 0 1', '8/8/8/4k3/8/8/8/4KN2 w - - 0 1', '2b5/8/8/4k3/8/8/8/4KB2 w - - 0 1'])
      assert.equal(new Chess(f).status()?.reason, 'insufficient', f);
    for (const f of ['8/2b5/8/4k3/8/8/8/4KB2 w - - 0 1', '8/8/8/4k3/8/8/8/3NKN2 w - - 0 1', '8/8/8/4k3/8/8/4P3/4K3 w - - 0 1'])
      assert.equal(new Chess(f).status(), null, `${f} is not a dead draw`);
    const fifty = new Chess('8/8/8/4k3/8/8/8/R3K3 w - - 99 80');
    fifty.move('Ra2');
    assert.equal(fifty.status().reason, 'fifty');
    const rep = new Chess();
    for (const m of ['Nf3', 'Nf6', 'Ng1', 'Ng8', 'Nf3', 'Nf6', 'Ng1']) {
      rep.move(m);
      assert.equal(rep.status(), null);
    }
    rep.move('Ng8');
    assert.equal(rep.status().reason, 'repetition');
    rep.undo();
    assert.equal(rep.status(), null, 'undo clears the repetition');
  });

  await test('PGN: export with headers, wrapping and FEN; import with comments, variations and NAGs', () => {
    const g = new Chess();
    for (const m of ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6', 'Ng5', 'd5', 'exd5', 'Nxd5', 'Nxf7', 'Kxf7', 'Qf3+', 'Ke6']) g.move(m);
    const pgn = g.pgn({ headers: { White: 'Alice', Black: 'Bob', Date: '2026.10.10' } });
    assert.match(pgn, /\[White "Alice"\]/);
    assert.match(pgn, /\[Result "\*"\]/);
    assert.match(pgn, /1\. e4 e5 2\. Nf3 Nc6 3\. Bc4 Nf6 4\. Ng5 d5 5\. exd5 Nxd5 6\. Nxf7 Kxf7 7\. Qf3\+ Ke6 \*/);
    const back = new Chess().loadPgn(pgn);
    assert.deepEqual(back.history(), g.history());
    assert.equal(back.headers.White, 'Alice');
    const messy = '[Event "x"]\n[SetUp "1"]\n[FEN "4k3/8/8/8/8/8/4P3/4K3 b - - 0 30"]\n\n30... Kd7 {a comment} 31. e4 $1 (31. e3 Kd6) Ke6 ; line comment\n32. e5 1/2-1/2';
    const m = new Chess().loadPgn(messy);
    assert.deepEqual(m.history(), ['Kd7', 'e4', 'Ke6', 'e5']);
    assert.match(m.pgn(), /\[FEN "4k3\/8\/8\/8\/8\/8\/4P3\/4K3 b - - 0 30"\]/);
    assert.match(m.pgn(), /30\.\.\. Kd7 31\. e4 Ke6 32\. e5/);
    assert.throws(() => new Chess().loadPgn('1. e4 e5 2. Ke3'), /Illegal move: Ke3/);
    const long = new Chess();
    for (let i = 0; i < 12; i++) for (const mm of ['Nf3', 'Nf6', 'Ng1', 'Ng8'].slice(0, 2)) long.move(mm) || long.move(mm === 'Nf3' ? 'Ng1' : 'Ng8');
    for (const line of long.pgn().split('\n')) assert.ok(line.length <= 80, `line too long: ${line}`);
  });

  await test('PGN import: first game of a multi-game file, coded errors, move-number and annotation forms', () => {
    const multi = '[Event "A"]\n[Result "1-0"]\n\n1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0\n\n[Event "B"]\n[Result "0-1"]\n\n1. f3 e5 2. g4 Qh4# 0-1\n';
    const m = new Chess().loadPgn(multi);
    assert.deepEqual(m.history(), ['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'Nf6', 'Qxf7#']);
    assert.equal(m.headers.Event, 'A', 'tags of the first game only');
    assert.deepEqual(new Chess().loadPgn('1. e4 ... e5 2.Nf3 2...Nc6 3. Bb5 a6!? 4. Ba4 +- Nf6 5. O-O $14 Be7 *').history(), ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O', 'Be7']);
    assert.deepEqual(new Chess().loadPgn('[SetUp "1"]\n[FEN "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"]\n1… e5 2. Nf3 *').history(), ['e5', 'Nf3']);
    assert.deepEqual(new Chess().loadPgn('1. e4 Nf6 2. e5 d5 3. exd6e.p. *').history(), ['e4', 'Nf6', 'e5', 'd5', 'exd6']);
    assert.deepEqual(new Chess().loadPgn('1. e4 (1. d4 d5 (1... Nf6 2. c4) 2. c4) e5 {a (comment)} 2. Nf3 *').history(), ['e4', 'e5', 'Nf3']);
    const err = (txt) => {
      try {
        new Chess().loadPgn(txt);
      } catch (e) {
        return e;
      }
      return null;
    };
    const bad = err('[SetUp "1"]\n[FEN "8/8/8 w - - 0 1"]\n\n1. e4 *');
    assert.equal(bad.code, 'fen');
    assert.equal(bad.fenError, 'rows');
    const ill = err('1. e4 e5 2. Ke3');
    assert.equal(ill.code, 'move');
    assert.equal(ill.move, 'Ke3');
    assert.equal(ill.ply, 2);
    assert.equal(err('hello world').ply, 0);
  });

  await test('pieces: 12 original SVGs (gradients, outlines, no external references)', () => {
    assert.equal(PIECE_CODES.length, 12);
    const all = new Set();
    for (const c of PIECE_CODES) {
      const s = pieceSvg(c);
      assert.match(s, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 100 100">/);
      assert.match(s, /linearGradient/);
      assert.doesNotMatch(s, /href=|url\((?!#)/, 'self-contained');
      all.add(s);
    }
    assert.equal(all.size, 12, 'every piece is distinct');
  });

  await test('AI: evaluation is symmetric and sane', () => {
    const start = evaluate(Position.fromFen(START_FEN));
    assert.equal(start, evaluate(Position.fromFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1')), 'side-to-move symmetric');
    assert.ok(Math.abs(start) < 40);
    assert.ok(evaluate(Position.fromFen('4k3/8/8/8/8/8/8/3QK3 w - - 0 1')) > 800, 'queen up');
    assert.ok(evaluate(Position.fromFen('4k3/8/8/8/8/8/8/3QK3 b - - 0 1')) < -800, 'queen down');
  });

  await test('AI: opening book lines are legal', () => {
    for (const line of bookLines()) {
      const g = new Chess();
      for (const u of line) assert.ok(g.move(u), `${line.join(' ')} -> ${u}`);
    }
    assert.ok(bookMoves([]).length >= 3);
  });

  await test('AI: finds mate in 1 and mate in 2 at every level from medium up', () => {
    const e = new Engine();
    for (const lvl of ['medium', 'hard', 'expert']) {
      assert.equal(e.think(Position.fromFen('6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1'), { level: lvl }).move, 'd1d8', lvl);
      const r = e.think(Position.fromFen('r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4'), { level: lvl });
      assert.equal(r.move, 'h5f7', `scholar's mate (${lvl})`);
      assert.equal(r.mate, 1);
    }
    // mate in 2: 1. Kc7 Ka7 2. Ra1# (1. Kb6? is stalemate)
    const r2 = e.think(Position.fromFen('k7/8/2K5/8/8/8/8/1R6 w - - 0 1'), { level: 'hard' });
    assert.equal(r2.mate, 2, JSON.stringify(r2));
    assert.notEqual(r2.move, 'c6b6', 'avoids stalemate');
  });

  await test('AI: every level answers with a legal move within its time budget', () => {
    const e = new Engine();
    const report = [];
    for (const fen of [START_FEN, MIDGAME_BLACK, KIWIPETE]) {
      for (const lvl of LEVEL_IDS) {
        const pos = Position.fromFen(fen);
        const t0 = performance.now();
        const r = e.think(pos, { level: lvl, history: fen === START_FEN ? [] : undefined, startFen: fen });
        const dt = performance.now() - t0;
        const g = new Chess(fen);
        assert.ok(g.move(r.move), `${lvl} played an illegal move ${r.move} in ${fen}`);
        const budget = { beginner: 1500, easy: 1500, medium: 1200, hard: 2000, expert: 4000 }[lvl];
        assert.ok(dt < budget, `${lvl} took ${Math.round(dt)} ms (> ${budget})`);
        assert.equal(pos.fen(), fen, 'search leaves the position unchanged');
        if (fen === KIWIPETE) report.push(`${lvl} ${r.move} d${r.depth} ${Math.round(dt)} ms`);
      }
    }
    console.log(`        (Kiwipete: ${report.join(' · ')})`);
  });

  await test('AI: low levels are random, high levels deterministic; hard beats beginner', () => {
    const e = new Engine();
    const seen = new Set();
    for (let i = 0; i < 12; i++) seen.add(e.think(Position.fromFen(MIDGAME_BLACK), { level: 'beginner' }).move);
    assert.ok(seen.size >= 3, `beginner should vary its moves (${[...seen]})`);
    // a short match: hard (white) vs beginner (black) must not lose
    const g = new Chess();
    const ew = new Engine();
    const eb = new Engine();
    while (!g.status() && g.length < 120) {
      const eng = g.turn() === 'w' ? ew : eb;
      const r = eng.think(g.pos.clone(), { level: g.turn() === 'w' ? 'hard' : 'beginner', history: g.history({ verbose: true }).map((v) => v.uci), timeMs: g.turn() === 'w' ? 250 : undefined });
      assert.ok(g.move(r.move));
    }
    const st = g.status();
    const mat = g.material();
    assert.ok((st && st.winner === 'w') || (!st && mat.w - mat.b >= 5), `hard should beat beginner: ${JSON.stringify(st)} ${JSON.stringify(mat)}`);
  });

  await test('AI: worker helpers rebuild positions with their history (repetition aware)', () => {
    const pos = positionFrom(START_FEN, ['g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1']);
    assert.equal(pos.repetitions(), 2);
    assert.throws(() => positionFrom(START_FEN, ['e2e5']));
    assert.equal(LEVELS.hard.time <= 2000, true, 'hard thinks at most ~2 s');
  });
}

// ---------------------------------------------------------------- 2. UI
async function uiTests() {
  const { launchShell, OUT } = await import('./lib.mjs');
  const SHOTS = path.join(path.dirname(OUT), '..', '..', 'docs', 'screenshots');
  fs.mkdirSync(SHOTS, { recursive: true });
  const publish = (file, name) => fs.copyFileSync(file, path.join(SHOTS, `${name}.png`));

  // Screenshot of the Chess window plus a margin of desktop (full screen when maximized).
  const winShot = async (s, name, { pub = true } = {}) => {
    const file = path.join(OUT, `${name}.png`);
    const clip = await s.page.evaluate(() => {
      const el = document.querySelector('.win.app-chess');
      const r = el.getBoundingClientRect();
      const m = 20;
      const x = Math.max(0, r.left - m);
      const y = Math.max(0, r.top - m);
      return { x, y, width: Math.min(window.innerWidth, r.right + m) - x, height: Math.min(window.innerHeight, r.bottom + m) - y };
    });
    await s.page.screenshot({ path: file, clip });
    if (pub) publish(file, name);
    return file;
  };

  const chessErrors = (s) =>
    s.logs.filter((l) => (l.startsWith('[pageerror]') || l.startsWith('[error]')) && !/Failed to load resource/.test(l)).concat(s.logs.filter((l) => /chess/i.test(l) && /error|warn/i.test(l)));

  const helpers = (s) => {
    const { page } = s;
    const T = (fn, ...a) =>
      page.evaluate(
        ([f, a2]) => {
          const w = window.__aurora.wm.byApp('chess')[0];
          return window.__aurora.registry.instance(w.id).hooks.test[f](...a2);
        },
        [fn, a],
      );
    const win = (fn, ...a) =>
      page.evaluate(
        ([f, a2]) => {
          const w = window.__aurora.wm.byApp('chess')[0];
          return w[f](...a2);
        },
        [fn, a],
      );
    const state = () => T('state');
    const waitFor = async (pred, timeout = 10000, what = 'condition') => {
      const t0 = Date.now();
      for (;;) {
        const st = await state();
        if (pred(st)) return st;
        if (Date.now() - t0 > timeout) throw new Error(`timeout waiting for ${what}: ${JSON.stringify({ history: st.history, thinking: st.thinking, result: st.result })}`);
        await page.waitForTimeout(60);
      }
    };
    const sqPos = (sq) =>
      page.evaluate((sq2) => {
        const b = document.querySelector('.app-chess .cb-board').getBoundingClientRect();
        const w = window.__aurora.wm.byApp('chess')[0];
        const flipped = window.__aurora.registry.instance(w.id).hooks.test.state().flipped;
        const f = sq2.charCodeAt(0) - 97;
        const r = Number(sq2[1]) - 1;
        const x = flipped ? 7 - f : f;
        const y = flipped ? r : 7 - r;
        const size = b.width / 8;
        return { x: b.left + (x + 0.5) * size, y: b.top + (y + 0.5) * size };
      }, sq);
    const click = async (sq) => {
      const p = await sqPos(sq);
      await page.mouse.click(p.x, p.y);
      await page.waitForTimeout(60);
    };
    const drag = async (a, b) => {
      const p = await sqPos(a);
      const q = await sqPos(b);
      await page.mouse.move(p.x, p.y);
      await page.mouse.down();
      await page.mouse.move(p.x + (q.x - p.x) * 0.3, p.y + (q.y - p.y) * 0.3, { steps: 4 });
      await page.mouse.move(q.x, q.y, { steps: 6 });
      await page.mouse.up();
      await page.waitForTimeout(60);
    };
    const pieces = () =>
      page.$$eval('.app-chess .cb-piece:not(.leaving)', (els) => Object.fromEntries(els.map((e) => [e.dataset.square, e.dataset.piece])));
    const dots = () => page.$$eval('.app-chess .cb-dot', (els) => els.length);
    const dotSquares = () =>
      page.evaluate(() => {
        const w = window.__aurora.wm.byApp('chess')[0];
        const flipped = window.__aurora.registry.instance(w.id).hooks.test.state().flipped;
        const b = document.querySelector('.app-chess .cb-board').getBoundingClientRect();
        return [...document.querySelectorAll('.app-chess .cb-dot')].map((d) => {
          const r = d.getBoundingClientRect();
          const x = Math.round((r.left - b.left) / r.width);
          const y = Math.round((r.top - b.top) / r.height);
          const f = flipped ? 7 - x : x;
          const rank = flipped ? y + 1 : 8 - y;
          return 'abcdefgh'[f] + rank;
        });
      });
    const closeDialogs = async () => {
      for (let i = 0; i < 4; i++) {
        if (!(await page.$('.app-chess .dialog-layer'))) return;
        await page.keyboard.press('Escape');
        await page.waitForTimeout(250);
      }
    };
    const focusApp = () => page.evaluate(() => document.querySelector('.app-chess .cx').focus());
    return { T, win, state, waitFor, click, drag, pieces, dots, dotSquares, closeDialogs, focusApp, page };
  };

  // ------------------------------------------------------------ session 1: English, light
  if (want(1)) {
  console.log('UI — English, light');
    const s = await launchShell({ open: ['chess'], lang: 'en', theme: 'light' });
    const H = helpers(s);
    const { page, T, state, waitFor, click, drag, pieces, dots, dotSquares, closeDialogs, focusApp } = H;
    try {
      await page.waitForSelector('.app-chess .cb-board');
      await page.waitForTimeout(500);

      await test('opening position: 32 pieces, coordinates, toolbar and panel', async () => {
        const p = await pieces();
        assert.equal(Object.keys(p).length, 32);
        assert.equal(p.e1, 'wK');
        assert.equal(p.d8, 'bQ');
        assert.equal(await page.$$eval('.app-chess .cb-coord', (els) => els.filter((e) => e.textContent).length), 16);
        const labels = await page.$$eval('.app-chess .cx-toolbar .cx-btn-label', (els) => els.map((e) => e.textContent));
        assert.deepEqual(labels, ['New game', 'Undo', 'Hint', 'Flip board', 'Offer draw', 'Resign']);
        const st = await state();
        assert.equal(st.mode, 'ai');
        assert.equal(st.human, 'w');
        assert.ok(st.boardSize >= 480 && st.boardSize % 8 === 0, `board size ${st.boardSize}`);
        assert.match(await page.textContent('.app-chess .cx-status-text'), /Your move/);
        assert.equal(await page.$eval('.app-chess .win-title', (e) => e.textContent).catch(() => 'Chess'), 'Chess');
        await winShot(s, 'chess-opening-wood');
      });

      await test('click to move: legal destination dots, then the computer replies (Web Worker)', async () => {
        await click('e2');
        assert.equal(await dots(), 2);
        assert.deepEqual((await dotSquares()).sort(), ['e3', 'e4']);
        await click('e4');
        const st1 = await state();
        assert.deepEqual(st1.history.slice(0, 1), ['e4']);
        if (st1.length === 1) {
          assert.equal(st1.thinking, true, 'the computer is thinking');
          assert.equal(await page.isVisible('.app-chess .cx-player.thinking .cx-thinking'), true, 'Thinking… indicator');
        }
        const st = await waitFor((x) => x.length === 2 && !x.thinking, 8000, 'computer reply');
        const g = new Chess();
        g.move('e4');
        assert.ok(g.move(st.history[1]), `legal reply ${st.history[1]}`);
        assert.equal(st.engineFailed, false, 'the Web Worker engine is used');
        const p = await pieces();
        assert.equal(p.e4, 'wP');
        assert.equal(p.e2, undefined);
        assert.equal(await page.$$eval('.app-chess .cb-hl-sq.last', (els) => els.length), 2, 'last move highlight');
      });

      await test('drag and drop: legal drop plays, illegal drop snaps back', async () => {
        await drag('a2', 'a5');
        await page.waitForTimeout(250);
        let st = await state();
        assert.equal(st.length, 2, 'illegal drag does nothing');
        assert.equal((await pieces()).a2, 'wP', 'piece snapped back');
        await drag('g1', 'f3');
        st = await waitFor((x) => x.length === 4 && !x.thinking, 8000, 'reply after Nf3');
        assert.equal(st.history[2], 'Nf3');
        assert.equal((await pieces()).f3, 'wN');
      });

      await test('move list: SAN with figurines, click / arrows / Home / End navigation', async () => {
        await drag('f1', 'c4');
        await waitFor((x) => x.length === 6 && !x.thinking, 8000, 'reply after Bc4');
        assert.equal(await page.$$eval('.app-chess .cx-mv[data-ply]', (els) => els.length), 6);
        assert.ok((await page.$$eval('.app-chess .cx-fig', (els) => els.length)) >= 2, 'piece moves use figurines');
        await focusApp();
        await page.keyboard.press('ArrowLeft');
        let st = await state();
        assert.equal(st.view, 5);
        assert.equal(await page.isVisible('.app-chess .cx-back'), true, '"Back to the game" button while reviewing');
        await page.keyboard.press('Home');
        st = await state();
        assert.equal(st.view, 0);
        assert.equal(Object.keys(await pieces()).length, 32);
        await page.click('.app-chess .cx-mv[data-ply="3"]');
        st = await state();
        assert.equal(st.view, 3);
        assert.equal((await pieces()).f3, 'wN');
        await page.keyboard.press('ArrowRight');
        assert.equal((await state()).view, 4);
        await page.click('.app-chess .cx-nav [data-nav="last"]');
        assert.equal((await state()).view, 6);
        await page.waitForTimeout(300);
      });

      await test('hint: engine suggestion drawn as an arrow, cleared after moving', async () => {
        await page.click('.app-chess [data-cmd="hint"]');
        const st = await waitFor((x) => !!x.hint, 6000, 'hint');
        assert.ok(st.hint.from && st.hint.to);
        assert.equal(await page.$$eval('.app-chess .cb-arrow', (els) => els.length), 1);
        assert.match(await page.textContent('.app-chess .cx-status-text'), /Hint: try/);
        await click('d2');
        await page.waitForTimeout(150);
        await winShot(s, 'chess-midgame');
        await click('d2');
      });

      await test('undo (Ctrl+Z) takes back your move and the computer reply', async () => {
        await focusApp();
        await page.keyboard.press('Control+z');
        let st = await state();
        assert.equal(st.length, 4);
        assert.equal(st.turn, 'w');
        assert.equal(await page.$$eval('.app-chess .cb-arrow', (els) => els.length), 0, 'hint cleared');
        await page.click('.app-chess [data-cmd="undo"]');
        st = await state();
        assert.equal(st.length, 2);
        assert.equal((await pieces()).f3, undefined);
      });

      await test('flip board (F): white now at the top', async () => {
        await focusApp();
        await page.keyboard.press('f');
        await page.waitForTimeout(350);
        assert.equal((await state()).flipped, true);
        const top = await page.$eval('.app-chess .cb-piece[data-square="e1"]', (e) => {
          const b = document.querySelector('.app-chess .cb-board').getBoundingClientRect();
          return e.getBoundingClientRect().top - b.top < b.height / 2;
        });
        assert.equal(top, true);
        const firstRank = await page.$eval('.app-chess .cb-sq .cb-rank', (e) => e.textContent);
        assert.equal(firstRank, '1', 'coordinates follow the flip');
        await page.keyboard.press('f');
        await page.waitForTimeout(300);
      });

      await test('keyboard play: focus the board, arrows + Enter move a piece', async () => {
        await page.focus('.app-chess .cb-board');
        // the cursor starts on e2; d2-d4: left, Enter, up, up, Enter
        await page.keyboard.press('ArrowLeft');
        await page.keyboard.press('Enter');
        assert.equal(await dots(), 2);
        await page.keyboard.press('ArrowUp');
        await page.keyboard.press('ArrowUp');
        await page.keyboard.press('Enter');
        const st = await waitFor((x) => x.length === 4 && !x.thinking, 8000, 'reply after d4');
        assert.equal(st.history[2], 'd4');
      });

      await test('draw offer: the computer declines in an equal position', async () => {
        await page.click('.app-chess [data-cmd="draw"]');
        await page.waitForSelector('.app-chess .cx-toast.show', { timeout: 5000 });
        await page.waitForFunction(() => /declined/.test(document.querySelector('.app-chess .cx-toast')?.textContent || ''), null, { timeout: 6000 });
        assert.equal((await state()).result, null);
      });

      await test('castling (two players): O-O by click, O-O-O by drag; never through check', async () => {
        await T('setup', 'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1', { mode: 'two', time: 'none' });
        await page.waitForTimeout(200);
        await click('e1');
        assert.deepEqual((await dotSquares()).sort(), ['c1', 'd1', 'f1', 'g1']);
        await click('g1');
        await page.waitForTimeout(300);
        let p = await pieces();
        assert.equal(p.g1, 'wK');
        assert.equal(p.f1, 'wR');
        assert.equal(p.h1, undefined);
        await drag('e8', 'c8');
        await page.waitForTimeout(300);
        p = await pieces();
        assert.equal(p.c8, 'bK');
        assert.equal(p.d8, 'bR');
        assert.deepEqual((await state()).history, ['O-O', 'O-O-O']);
        await T('setup', 'r3k2r/8/8/8/8/8/5r2/R3K2R w KQkq - 0 1', { mode: 'two' });
        await click('e1');
        const ds = await dotSquares();
        assert.ok(!ds.includes('g1'), 'f1 is attacked: no O-O');
        assert.ok(ds.includes('c1'), 'O-O-O still possible');
        await click('e1');
      });

      await test('en passant capture removes the passed pawn', async () => {
        await T('setup', 'rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3', { mode: 'two' });
        await click('e5');
        assert.ok((await dotSquares()).includes('f6'));
        assert.equal(await page.$$eval('.app-chess .cb-dot.capture', (els) => els.length), 1, 'capture ring on f6 (en passant)');
        await click('f6');
        await page.waitForTimeout(350);
        const p = await pieces();
        assert.equal(p.f6, 'wP');
        assert.equal(p.f5, undefined);
        assert.deepEqual((await state()).history, ['exf6']);
      });

      await test('promotion: picker (cancel with Esc, choose a knight by click, a queen by key)', async () => {
        await T('setup', '1r2k2r/P4ppp/2n1bn2/8/3P4/2N2N2/5PPP/R1B1KB1R w KQk - 0 1', { mode: 'two' });
        await click('a7');
        assert.deepEqual((await dotSquares()).sort(), ['a8', 'b8']);
        await click('b8');
        await page.waitForSelector('.app-chess .cb-promo .cb-promo-btn', { timeout: 3000 });
        assert.equal(await page.$$eval('.app-chess .cb-promo-btn', (els) => els.length), 4);
        await page.waitForTimeout(350);
        await winShot(s, 'chess-promotion');
        await page.keyboard.press('Escape');
        await page.waitForTimeout(350);
        assert.equal(await page.$('.app-chess .cb-promo'), null);
        assert.equal((await state()).length, 0, 'cancelled');
        assert.equal((await pieces()).a7, 'wP');
        await drag('a7', 'b8');
        await page.waitForSelector('.app-chess .cb-promo .cb-promo-btn');
        await page.click('.app-chess .cb-promo-btn[data-piece="n"]');
        await page.waitForTimeout(350);
        let st = await state();
        assert.deepEqual(st.history, ['axb8=N']);
        assert.equal((await pieces()).b8, 'wN');
        await T('setup', '4k3/1P6/8/8/8/8/8/4K3 w - - 0 1', { mode: 'two' });
        await click('b7');
        await click('b8');
        await page.waitForSelector('.app-chess .cb-promo');
        await page.keyboard.press('q');
        await page.waitForTimeout(300);
        st = await state();
        assert.deepEqual(st.history, ['b8=Q+']);
        assert.equal((await pieces()).b8, 'wQ');
        assert.equal(await page.$$eval('.app-chess .cb-hl-sq.check', (els) => els.length), 1, 'red glow on the king in check');
      });

      await test('checkmate vs computer: result dialog, PGN copy, stats', async () => {
        const before = (await state()).stats.ai.medium.w;
        await T('setup', 'r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4', { mode: 'ai', side: 'w', level: 'medium' });
        await click('h5');
        await click('f7');
        await page.waitForSelector('.app-chess .cx-result', { timeout: 5000 });
        await page.waitForTimeout(600);
        assert.match(await page.textContent('.app-chess .cx-res-title'), /You won/);
        assert.match(await page.textContent('.app-chess .cx-res-reason'), /checkmate/);
        const st = await state();
        assert.equal(st.result.reason, 'checkmate');
        assert.equal(st.stats.ai.medium.w, before + 1);
        await winShot(s, 'chess-checkmate');
        await page.click('.app-chess .cx-res-copy');
        await page.waitForTimeout(200);
        const clip = await page.evaluate(() => window.aurora.invoke('clipboard:readText'));
        assert.match(clip, /Qxf7#/);
        assert.match(clip, /\[Result "1-0"\]/);
        assert.match(clip, /\[FEN "/);
        await page.click('.app-chess .dialog-footer .btn:last-child'); // Review
        await page.waitForTimeout(300);
        await click('a2');
        assert.equal(await dots(), 0, 'board is read-only once the game is over');
        assert.match(await page.textContent('.app-chess .cx-status-text'), /You won/);
      });

      await test('stalemate, insufficient material and threefold repetition end the game as draws', async () => {
        await T('setup', '7k/8/4Q1K1/8/8/8/8/8 w - - 0 1', { mode: 'two' });
        await click('e6');
        await click('f7');
        await page.waitForSelector('.app-chess .cx-result');
        assert.match(await page.textContent('.app-chess .cx-res-reason'), /Stalemate/);
        assert.match(await page.textContent('.app-chess .cx-res-title'), /Draw/);
        await closeDialogs();
        await T('setup', '8/8/8/4k3/8/8/3r4/4K3 w - - 0 1', { mode: 'two' });
        await click('e1');
        await click('d2');
        await page.waitForSelector('.app-chess .cx-result');
        assert.match(await page.textContent('.app-chess .cx-res-reason'), /Insufficient material/);
        await closeDialogs();
        await T('setup', START_FEN, { mode: 'two' });
        for (const [a, b] of [['g1', 'f3'], ['g8', 'f6'], ['f3', 'g1'], ['f6', 'g8'], ['g1', 'f3'], ['g8', 'f6'], ['f3', 'g1'], ['f6', 'g8']]) {
          await click(a);
          await click(b);
          await page.waitForTimeout(80);
        }
        await page.waitForSelector('.app-chess .cx-result', { timeout: 4000 });
        assert.match(await page.textContent('.app-chess .cx-res-reason'), /Threefold repetition/);
        assert.equal((await state()).result.reason, 'repetition');
        await closeDialogs();
      });

      await test('draw offer accepted when the computer is losing', async () => {
        await T('setup', 'k7/8/8/8/8/8/8/KQQ5 b - - 0 1', { mode: 'ai', side: 'w', level: 'hard' });
        await waitFor((x) => x.length === 1 && !x.thinking, 8000, 'computer move');
        await page.click('.app-chess [data-cmd="draw"]');
        await page.waitForSelector('.app-chess .cx-result', { timeout: 6000 });
        assert.match(await page.textContent('.app-chess .cx-res-reason'), /agreement/);
        assert.equal((await state()).result.reason, 'agreement');
        await closeDialogs();
      });

      await test('resign: confirmation, then a loss', async () => {
        await T('setup', START_FEN, { mode: 'ai', side: 'w', level: 'easy' });
        await page.click('.app-chess [data-cmd="resign"]');
        await page.waitForSelector('.app-chess .dialog');
        await page.click('.app-chess .dialog-footer .btn.primary');
        await page.waitForSelector('.app-chess .cx-result', { timeout: 4000 });
        assert.match(await page.textContent('.app-chess .cx-res-title'), /You lost/);
        assert.match(await page.textContent('.app-chess .cx-res-reason'), /You resigned/);
        assert.equal((await state()).stats.ai.easy.l, 1);
        await closeDialogs();
      });

      await test('clocks: 5+0 runs for the side to move; flag on timeout', async () => {
        await T('setup', START_FEN, { mode: 'ai', side: 'w', level: 'beginner', time: '5+0' });
        assert.equal(await page.isVisible('.app-chess .cx-clock'), true);
        assert.match(await page.textContent('.app-chess .cx-player:last-child .cx-clock-time'), /5:00/);
        await click('e2');
        await click('e4');
        await waitFor((x) => x.length === 2 && !x.thinking, 8000, 'reply');
        let st = await state();
        assert.equal(st.clock.running, 'w');
        assert.ok(st.clock.b < 300000, 'black clock ran while the computer thought');
        await page.waitForTimeout(400);
        assert.ok((await state()).clock.w < st.clock.w, 'white clock runs');
        await winShot(s, 'chess-clocks', { pub: false });
        await T('setClock', 'w', 1200);
        await page.waitForSelector('.app-chess .cx-result', { timeout: 5000 });
        st = await state();
        assert.equal(st.result.reason, 'timeout');
        assert.equal(st.result.winner, 'b');
        assert.match(await page.textContent('.app-chess .cx-res-reason'), /ran out of time/);
        await closeDialogs();
      });

      await test('computer answers with a legal move within its time at every level', async () => {
        const times = [];
        for (const level of LEVEL_IDS) {
          await T('setup', MIDGAME_BLACK, { mode: 'ai', side: 'w', level, time: 'none' });
          const t0 = Date.now();
          const st = await waitFor((x) => x.length === 1 && !x.thinking, 12000, `${level} move`);
          const dt = Date.now() - t0;
          times.push(`${level}: ${st.history[0]} in ${dt} ms`);
          const limit = { beginner: 3000, easy: 3000, medium: 3000, hard: 3000, expert: 5500 }[level];
          assert.ok(dt < limit, `${level}: ${dt} ms`);
          assert.ok(new Chess(MIDGAME_BLACK).move(st.history[0]), `${level} legal: ${st.history[0]}`);
        }
        console.log(`        (${times.join(' · ')}; includes the UI's minimum "thinking" delay)`);
      });

      await test('new game dialog (N): mode cards, side, level, time; start two-player game', async () => {
        await T('setup', START_FEN, { mode: 'ai', side: 'w', level: 'medium' });
        await focusApp();
        await page.keyboard.press('n');
        await page.waitForSelector('.app-chess .cx-newgame');
        await page.waitForTimeout(300);
        assert.equal(await page.$$eval('.app-chess .cx-mode-card', (els) => els.length), 3);
        assert.equal(await page.$$eval('.app-chess .cx-level', (els) => els.length), 5);
        await page.click('.app-chess .cx-level[data-level="hard"]');
        assert.match(await page.textContent('.app-chess .cx-level-desc'), /1.5 seconds/);
        await page.click('.app-chess .cx-time[data-time="10+0"]');
        await winShot(s, 'chess-newgame');
        await page.click('.app-chess .cx-mode-card[data-mode="two"]');
        assert.equal(await page.isVisible('.app-chess .cx-levels'), false, 'difficulty hidden for two players');
        await page.click('.app-chess .dialog-footer .btn.primary');
        await page.waitForTimeout(300);
        const st = await state();
        assert.equal(st.mode, 'two');
        assert.ok(st.clock && st.clock.w === 600000, '10 minute clock');
        assert.match(await page.textContent('.app-chess .cx-status-text'), /White to move/);
      });

      await test('themes: all five board themes through the More menu', async () => {
        await T('setup', START_FEN, { mode: 'ai', side: 'w', level: 'medium', time: 'none' });
        const ids = { green: 'Green', blue: 'Blue', aurora: 'Selene (accent color)', dark: 'Dark', wood: 'Classic wood' };
        for (const [id, label] of Object.entries(ids)) {
          await page.click('.app-chess [data-cmd="more"]');
          await page.waitForSelector('.menu');
          await page.hover('.menu .menu-item:has-text("Board theme")');
          await page.waitForSelector(`.menu .menu-item:has-text("${label}")`);
          await page.click(`.menu .menu-item:has-text("${label}")`);
          await page.waitForTimeout(150);
          assert.equal(await page.$eval('.app-chess .cb-board', (e) => e.dataset.theme), id);
          if (id !== 'wood') await winShot(s, `chess-theme-${id}`);
        }
        assert.equal((await state()).theme, 'wood');
      });

      await test('import FEN/PGN into the analysis board with live evaluation', async () => {
        await page.click('.app-chess [data-cmd="more"]');
        await page.click('.menu .menu-item:has-text("Paste FEN or PGN")');
        await page.waitForSelector('.app-chess .cx-import-text');
        await page.fill('.app-chess .cx-import-text', 'not a fen / at all');
        await page.click('.app-chess .dialog-footer .btn.primary');
        await page.waitForTimeout(200);
        assert.ok((await page.textContent('.app-chess .cx-import-err')).length > 5, 'error shown, dialog kept');
        await page.fill('.app-chess .cx-import-text', '[White "Morphy"]\n[Black "Duke Karl / Count Isouard"]\n1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5 6. Bc4 Nf6 7. Qb3 Qe7 8. Nc3 c6 9. Bg5 b5');
        await page.click('.app-chess .dialog-footer .btn.primary');
        await page.waitForTimeout(300);
        const st = await waitFor((x) => x.analysis && x.analysis.depth > 0, 8000, 'analysis');
        assert.equal(st.mode, 'analysis');
        assert.equal(st.length, 18);
        assert.equal(await page.isVisible('.app-chess .cx-eval'), true);
        assert.match(await page.textContent('.app-chess .cx-analysis'), /depth/);
        assert.match(await page.textContent('.app-chess .cx-eval-text'), /^(\d+(\.\d)?|M\d+)$/, 'score shown on the evaluation bar');
        await page.waitForTimeout(300);
        await winShot(s, 'chess-analysis');
        // free play from an earlier position replaces the rest of the line
        await page.click('.app-chess .cx-mv[data-ply="17"]');
        await click('h7');
        await click('h6');
        const st2 = await state();
        assert.equal(st2.length, 18);
        assert.equal(st2.history[17], 'h6');
        assert.equal(st2.view, 18);
      });

      await test('no renderer errors', () => {
        assert.deepEqual(chessErrors(s), []);
      });
    } finally {
      await s.close();
    }
  }

  // ------------------------------------------------------------ session 2: persistence
  if (want(2)) {
  console.log('UI — persistence');
    const home = fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'aurora-chess-'));
    try {
      let s = await launchShell({ open: ['chess'], lang: 'en', theme: 'light', home });
      let H = helpers(s);
      await s.page.waitForSelector('.app-chess .cb-board');
      await test('an unfinished game and the settings survive a relaunch', async () => {
        await H.T('setTheme', 'blue');
        await H.click('d2');
        await H.click('d4');
        await H.waitFor((x) => x.length === 2 && !x.thinking, 8000, 'reply');
        await H.focusApp();
        await H.page.keyboard.press('f');
        const before = await H.state();
        await H.page.click('.app-chess [data-cmd="more"]');
        await H.page.click('.menu .menu-item:has-text("Show coordinates")');
        await H.win('close');
        await s.page.waitForTimeout(800);
        await s.close();
        s = await launchShell({ open: ['chess'], home, keepHome: true });
        H = helpers(s);
        await s.page.waitForSelector('.app-chess .cb-board');
        await s.page.waitForTimeout(400);
        const after = await H.state();
        assert.deepEqual(after.history, before.history);
        assert.equal(after.flipped, true);
        assert.equal(after.theme, 'blue');
        assert.equal(await s.page.$eval('.app-chess .cb-board', (e) => e.classList.contains('no-coords')), true);
        assert.equal((await H.pieces()).d4, 'wP');
      });
      await test('no renderer errors (persistence)', () => assert.deepEqual(chessErrors(s), []));
      await s.close();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }

  // ------------------------------------------------------------ session 3: French, dark, sizes
  if (want(3)) {
  console.log('UI — French, dark, window sizes');
    const s = await launchShell({ open: ['chess'], lang: 'fr', theme: 'dark' });
    const H = helpers(s);
    const { page, T, win, state, waitFor, click } = H;
    try {
      await page.waitForSelector('.app-chess .cb-board');
      await page.waitForTimeout(500);
      const overflowing = () =>
        page.evaluate(() => {
          const bad = [];
          for (const sel of ['.cx-toolbar', '.cx-tb-group', '.cx-player', '.cx-info', '.cx-nav', '.cx-mode-card', '.cx-level', '.cx-side', '.cx-time', '.dialog-footer .btn', '.cx-res-title', '.cx-res-reason']) {
            for (const el of document.querySelectorAll(`.app-chess ${sel}`)) {
              if (el.offsetParent === null) continue;
              if (el.scrollWidth > el.clientWidth + 1) bad.push(`${sel}: ${el.textContent.trim().slice(0, 40)} (${el.scrollWidth} > ${el.clientWidth})`);
            }
          }
          return bad;
        });

      await test('French labels and a dark board UI without overflow', async () => {
        const labels = await page.$$eval('.app-chess .cx-toolbar .cx-btn-label', (els) => els.map((e) => e.textContent));
        assert.deepEqual(labels, ['Nouvelle partie', 'Annuler', 'Indice', 'Retourner', 'Proposer nulle', 'Abandonner']);
        assert.match(await page.textContent('.app-chess .cx-status-text'), /À vous de jouer/);
        assert.equal(await page.$eval('.app-chess .win-title', (e) => e.textContent).catch(() => 'Échecs'), 'Échecs');
        await click('e2');
        await click('e4');
        await waitFor((x) => x.length === 2 && !x.thinking, 8000, 'reply');
        await click('g1');
        await click('f3');
        await waitFor((x) => x.length === 4 && !x.thinking, 8000, 'reply');
        await page.waitForTimeout(300);
        assert.deepEqual(await overflowing(), []);
        await winShot(s, 'chess-dark-fr');
      });

      await test('French dialogs: new game, promotion and result fit', async () => {
        await H.focusApp();
        await page.keyboard.press('n');
        await page.waitForSelector('.app-chess .cx-newgame');
        await page.waitForTimeout(300);
        assert.match(await page.textContent('.app-chess .dialog-title'), /Nouvelle partie/);
        assert.deepEqual(await overflowing(), []);
        await winShot(s, 'chess-newgame-dark-fr');
        await page.keyboard.press('Escape');
        await page.waitForTimeout(250);
        await T('setup', '6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1', { mode: 'two' });
        await click('d1');
        await click('d8');
        await page.waitForSelector('.app-chess .cx-result');
        await page.waitForTimeout(500);
        assert.match(await page.textContent('.app-chess .cx-res-title'), /Les Blancs gagnent/);
        assert.match(await page.textContent('.app-chess .cx-res-reason'), /échec et mat/);
        assert.deepEqual(await overflowing(), []);
        await winShot(s, 'chess-result-dark-fr', { pub: false });
        await H.closeDialogs();
      });

      await test('minimum window size: board and panel still fit', async () => {
        await T('setup', START_FEN, { mode: 'ai', side: 'b', level: 'medium', time: '10+0' });
        await waitFor((x) => x.length === 1 && !x.thinking, 8000, 'computer opens');
        await win('setSize', 720, 560);
        await page.waitForTimeout(500);
        const fit = await page.evaluate(() => {
          const w = document.querySelector('.win.app-chess').getBoundingClientRect();
          const parts = ['.cb-board', '.cx-panel', '.cx-toolbar'].map((sel) => document.querySelector(`.app-chess ${sel}`).getBoundingClientRect());
          return parts.every((r) => r.left >= w.left - 1 && r.right <= w.right + 1 && r.top >= w.top - 1 && r.bottom <= w.bottom + 1);
        });
        assert.equal(fit, true);
        const st = await state();
        assert.ok(st.boardSize >= 320, `board ${st.boardSize}`);
        assert.equal(st.flipped, true, 'playing Black: board flipped');
        assert.deepEqual(await overflowing(), []);
        await winShot(s, 'chess-minsize-dark-fr');
      });

      await test('maximized: the board grows', async () => {
        await win('maximize');
        await page.waitForTimeout(600);
        const st = await state();
        assert.ok(st.boardSize >= 700, `board ${st.boardSize}`);
        await winShot(s, 'chess-maximized-dark-fr');
        await win('restore');
        await page.waitForTimeout(400);
      });

      await test('French notation in texts, French promotion keys, French number format', async () => {
        // the hint is the mate Qd8#: in French the queen is "D"
        await T('setup', '6k1/5ppp/8/8/8/8/5PPP/3Q2K1 w - - 0 1', { mode: 'two', time: 'none' });
        await page.click('.app-chess [data-cmd="hint"]');
        await waitFor((x) => !!x.hint, 6000, 'hint');
        assert.match(await page.textContent('.app-chess .cx-status-text'), /Indice : essayez Dd8#/);
        // a win against the computer, then the statistics show a French percentage
        await T('setup', '6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1', { mode: 'ai', side: 'w', level: 'medium' });
        await click('d1');
        await click('d8');
        await page.waitForSelector('.app-chess .cx-result');
        await H.closeDialogs();
        await page.click('.app-chess [data-cmd="more"]');
        await page.click('.menu .menu-item:has-text("Statistiques")');
        await page.waitForSelector('.app-chess .cx-stats');
        const rate = await page.$eval('.app-chess .cx-stats tbody tr:nth-child(3) td:last-child', (e) => e.textContent);
        assert.match(rate, /^100[\s  ]%$/, `French percent: "${rate}"`);
        await H.closeDialogs();
        await page.click('.app-chess [data-cmd="more"]');
        await page.click('.menu .menu-item:has-text("Raccourcis")');
        await page.waitForSelector('.app-chess .cx-keys');
        const keys = await page.$$eval('.app-chess .cx-key-row kbd', (els) => els.map((e) => e.textContent));
        assert.ok(keys.includes('D T F C'), `promotion keys in French: ${keys.join(' | ')}`);
        await H.closeDialogs();
      });

      await test('French error messages for unreadable files (no raw system text, no path)', async () => {
        const missing = path.join(s.home, 'Documents', 'absente.pgn');
        await page.evaluate((p) => window.__aurora.shell.openFile(p), missing);
        await page.waitForSelector('.app-chess .dialog');
        const txt = await page.textContent('.app-chess .dialog');
        assert.match(txt, /Impossible d'ouvrir « absente\.pgn »\. Le fichier n'existe pas/);
        assert.doesNotMatch(txt, /ENOENT|no such file|\/Documents\//);
        await H.closeDialogs();
      });

      await test('no renderer errors (French, dark)', () => assert.deepEqual(chessErrors(s), []));
    } finally {
      await s.close();
    }
  }

  // ------------------------------------------------------------ session 4: robustness + regressions
  if (want(4)) {
  console.log('UI — robustness, security, races, accessibility, leaks');
    const home = fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'aurora-chess-qa-'));
    const appDir = path.join(home, '.config', 'aurora', 'apps', 'chess');
    fs.mkdirSync(appDir, { recursive: true });
    // corrupted / hostile stored data
    fs.writeFileSync(path.join(appDir, 'prefs.json'), JSON.stringify({ theme: '<b>x</b>', coords: 'yes', legal: null, sound: 5, autoQueen: [], autoFlip: {}, setup: { mode: 'hack', side: 7, level: '__proto__', time: 'constructor' } }));
    fs.writeFileSync(path.join(appDir, 'stats.json'), JSON.stringify({ ai: { medium: { w: 'NaN', l: -5, d: 2.7 } }, two: 'x' }));
    fs.writeFileSync(path.join(appDir, 'game.json'), JSON.stringify({ v: 1, setup: {}, startFen: 'garbage', moves: 'e2e4', headers: 'abc' }));
    const s = await launchShell({ open: [], lang: 'en', theme: 'light', home, keepHome: true });
    const H = helpers(s);
    const { page, T, state, waitFor, click, pieces, dots, closeDialogs } = H;
    const docs = path.join(home, 'Documents');
    try {
      // count workers / audio contexts / timers created by the app (for the leak test below)
      await page.evaluate(() => {
        const W = window.Worker;
        window.__workers = { created: 0, terminated: 0 };
        window.Worker = class extends W {
          constructor(...a) {
            super(...a);
            window.__workers.created++;
          }
          terminate() {
            window.__workers.terminated++;
            return super.terminate();
          }
        };
        const AC = window.AudioContext;
        window.__ac = { created: 0, closed: 0 };
        window.AudioContext = class extends AC {
          constructor(...a) {
            super(...a);
            window.__ac.created++;
          }
          close() {
            window.__ac.closed++;
            return super.close();
          }
        };
        const si = window.setInterval;
        const ci = window.clearInterval;
        window.__iv = new Set();
        window.setInterval = (fn, ms, ...r) => {
          const id = si(fn, ms, ...r);
          if (/apps\/chess/.test(new Error().stack)) window.__iv.add(id);
          return id;
        };
        window.clearInterval = (id) => {
          window.__iv.delete(id);
          return ci(id);
        };
      });
      const wmHandlers = () => page.evaluate(() => [...window.__aurora.wm._h.values()].reduce((n, set) => n + set.size, 0));
      const baseHandlers = await wmHandlers();
      await page.evaluate(() => window.__aurora.registry.launch('chess'));
      await page.waitForSelector('.app-chess .cb-board');
      await page.waitForTimeout(500);

      await test('corrupted saved data is sanitized (types, prototype keys, negative counts)', async () => {
        const st = await state();
        assert.equal(st.mode, 'ai');
        assert.equal(st.level, 'medium');
        assert.equal(st.clock, null, '"constructor" is not a time control');
        assert.equal(st.theme, 'wood');
        assert.deepEqual(
          { coords: st.prefs.coords, legal: st.prefs.legal, sound: st.prefs.sound, autoQueen: st.prefs.autoQueen, autoFlip: st.prefs.autoFlip },
          { coords: true, legal: true, sound: true, autoQueen: false, autoFlip: false },
        );
        assert.deepEqual(st.stats.ai.medium, { w: 0, l: 0, d: 2 });
        assert.equal(st.length, 0, 'the broken saved game is not resumed');
        assert.match(await T('pgn'), /^\[Event "Casual game"\]/, 'string "headers" are ignored');
        await click('e2');
        assert.equal(await dots(), 2, 'legal move dots are on');
        await click('e2');
      });

      await test('hostile file names and PGN tags are shown as text, never as HTML', async () => {
        const name = '<img src=x onerror=window.__pwned=1>.pgn';
        fs.writeFileSync(path.join(docs, name), '[Event "<script>window.__pwned=2</script>"]\n[White "<img src=x onerror=window.__pwned=3>"]\n\n1. e4 e5 2. Nf3 *');
        await page.evaluate((p) => window.__aurora.shell.openFile(p), path.join(docs, name));
        await waitFor((x) => x.mode === 'analysis' && x.length === 3, 6000, 'file opened');
        await page.waitForTimeout(300);
        assert.equal(await page.$eval('.win.app-chess .win-title', (e) => e.textContent), `${name} - Chess`);
        assert.match(await page.textContent('.app-chess .cx-mode'), /<img src=x onerror=window.__pwned=1>\.pgn/, 'file name in the status card');
        assert.equal(await page.evaluate(() => window.__pwned || 0), 0);
        assert.equal(await page.$$eval('.app-chess img:not(.win-icon), .app-chess script', (els) => els.length), 0);
        assert.match(await T('pgn'), /\[White "<img src=x onerror=window.__pwned=3>"\]/);
      });

      await test('unreadable files: clear messages without raw system errors or paths', async () => {
        const cases = [
          ['missing.pgn', null, /does not exist/],
          ['huge.pgn', Buffer.alloc(9 * 1024 * 1024, 32), /too large/],
          ['badfen.pgn', '[SetUp "1"]\n[FEN "8/8/8 w - - 0 1"]\n\n1. e4 *', /\[FEN\] tag of this PGN is not valid: each of the 8 ranks/],
          ['notes.pgn', 'hello world, this is not chess', /neither a FEN position nor a PGN game/],
          ['illegal.pgn', '1. e4 e5 2. Ke3 *', /illegal move: Ke3/],
        ];
        for (const [file, content, re] of cases) {
          if (content !== null) fs.writeFileSync(path.join(docs, file), content);
          await page.evaluate((p) => window.__aurora.shell.openFile(p), path.join(docs, file));
          await page.waitForSelector('.app-chess .dialog', { timeout: 5000 });
          const txt = await page.textContent('.app-chess .dialog');
          assert.match(txt, re, `${file}: ${txt}`);
          assert.match(txt, new RegExp(`“${file.replace('.', '\\.')}” could not be opened`));
          assert.doesNotMatch(txt, /ENOENT|ETOOBIG|bytes\)|Invalid FEN|\/tmp\//, `${file}: raw error text`);
          await closeDialogs();
        }
        assert.equal((await state()).length, 3, 'the open game is kept');
      });

      await test('a multi-game PGN opens its first game; a finished game reads as finished', async () => {
        fs.writeFileSync(path.join(docs, 'two-games.pgn'), '[Event "A"]\n\n1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0\n\n[Event "B"]\n\n1. f3 e5 2. g4 Qh4# 0-1\n');
        await page.evaluate((p) => window.__aurora.shell.openFile(p), path.join(docs, 'two-games.pgn'));
        const st = await waitFor((x) => x.length === 7, 6000, 'first game');
        assert.equal(st.history[6], 'Qxf7#');
        assert.match(await page.textContent('.app-chess .cx-status-text'), /White wins · by checkmate/);
        await page.waitForTimeout(400);
        assert.match(await page.textContent('.app-chess .cx-analysis'), /Game over/);
      });

      await test('analysis: Hint while the analysis is running answers without stopping it', async () => {
        await T('setup', START_FEN, { mode: 'analysis' });
        await page.click('.app-chess [data-cmd="hint"]');
        const st = await waitFor((x) => !!x.hint && x.analysis && x.analysis.depth > 0, 8000, 'hint and analysis');
        assert.ok(st.hint.from && st.hint.to);
        assert.match(await page.textContent('.app-chess .cx-analysis'), /depth \d+/);
        // a hint belongs to its position: navigating drops it
        await click('e2');
        await click('e4');
        await page.click('.app-chess [data-cmd="hint"]');
        await waitFor((x) => !!x.hint && x.length === 1, 8000, 'hint after e4');
        await H.focusApp();
        await page.keyboard.press('Home');
        await page.waitForTimeout(150);
        assert.equal((await state()).hint, null);
        assert.equal(await page.$$eval('.app-chess .cb-arrow', (e) => e.length), 0);
      });

      await test('analysis: after the line ends in mate, earlier positions still take hints and moves', async () => {
        await T('setup', '6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1', { mode: 'analysis' });
        await click('g1');
        await click('f1');
        await click('g8');
        await click('f8');
        await click('f1');
        await click('g1');
        await waitFor((x) => x.length === 3, 3000, 'three moves');
        await click('f8');
        await click('g8');
        await click('d1');
        await click('d8');
        await page.waitForSelector('.app-chess .cx-result', { timeout: 4000 });
        await closeDialogs();
        assert.equal(await page.$eval('.app-chess [data-cmd="hint"]', (b) => b.disabled), true, 'no hint in the mated position');
        await H.focusApp();
        await page.keyboard.press('ArrowLeft');
        await page.waitForTimeout(200);
        assert.equal(await page.$eval('.app-chess [data-cmd="hint"]', (b) => b.disabled), false, 'hint available one move earlier');
        assert.match(await page.textContent('.app-chess .cx-status-text'), /Reviewing 2… Kg8/);
      });

      await test('two players: a hint still searching is dropped when a move is played', async () => {
        await T('setup', START_FEN, { mode: 'two', time: 'none' });
        await page.click('.app-chess [data-cmd="hint"]');
        await click('e2');
        await click('e4');
        await page.waitForTimeout(1300);
        const st = await state();
        assert.deepEqual(st.history, ['e4']);
        assert.equal(st.hint, null);
        assert.match(await page.textContent('.app-chess .cx-status-text'), /Black to move/);
      });

      await test('a set-up position that is already over is shown as finished', async () => {
        await T('setup', '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1', { mode: 'two', time: 'none' });
        await page.waitForTimeout(700);
        assert.equal((await state()).result?.reason, 'stalemate');
        assert.equal(await page.$('.app-chess .cx-result'), null, 'no result dialog for a game that never started');
        assert.match(await page.textContent('.app-chess .cx-status-text'), /Draw · Stalemate/);
      });

      await test('fifty-move rule ends the game as a draw (result dialog, ½-½ in the move list)', async () => {
        await T('setup', '8/8/8/4k3/8/8/8/R3K3 w - - 99 80', { mode: 'two', time: 'none' });
        await click('a1');
        await click('a2');
        await page.waitForSelector('.app-chess .cx-result', { timeout: 4000 });
        assert.match(await page.textContent('.app-chess .cx-res-reason'), /Fifty-move rule/);
        assert.equal((await state()).result.reason, 'fifty');
        assert.equal(await page.textContent('.app-chess .cx-mresult'), '½-½');
        await closeDialogs();
      });

      await test('resigning with the promotion picker open closes the picker', async () => {
        await T('setup', '4k3/1P6/8/8/8/8/8/4K3 w - - 0 1', { mode: 'two', time: 'none' });
        await click('b7');
        await click('b8');
        await page.waitForSelector('.app-chess .cb-promo');
        await page.click('.app-chess [data-cmd="resign"]');
        await page.waitForSelector('.app-chess .dialog');
        await page.click('.app-chess .dialog-footer .btn.primary');
        await page.waitForSelector('.app-chess .cx-result');
        await page.waitForTimeout(300);
        assert.equal(await page.$('.app-chess .cb-promo:not(.closing)'), null);
        assert.equal((await pieces()).b7, 'wP', 'the pawn went back');
        await closeDialogs();
      });

      await test('Enter activates the focused dialog button (Copy PGN, Review, Cancel), not the default one', async () => {
        await T('setup', '6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1', { mode: 'two', time: 'none' });
        await click('d1');
        await click('d8');
        await page.waitForSelector('.app-chess .cx-result');
        await page.waitForTimeout(400);
        await page.focus('.app-chess .cx-res-copy');
        await page.keyboard.press('Enter');
        await page.waitForTimeout(300);
        assert.ok(await page.$('.app-chess .cx-result'), 'Copy PGN keeps the dialog open');
        assert.match(await page.evaluate(() => window.aurora.invoke('clipboard:readText')), /Rd8#/);
        await page.focus('.app-chess .dialog-footer .btn:last-child'); // Review
        await page.keyboard.press('Enter');
        await page.waitForTimeout(400);
        let st = await state();
        assert.equal(await page.$('.app-chess .cx-result'), null);
        assert.deepEqual(st.history, ['Rd8#'], 'Review did not start a new game');
        assert.equal(st.result?.reason, 'checkmate');
        // Cancel in the resign confirmation
        await T('setup', START_FEN, { mode: 'ai', side: 'w', level: 'easy', time: 'none' });
        await page.click('.app-chess [data-cmd="resign"]');
        await page.waitForSelector('.app-chess .dialog');
        await page.waitForTimeout(100);
        await page.focus('.app-chess .dialog-footer .btn:last-child');
        await page.keyboard.press('Enter');
        await page.waitForTimeout(400);
        st = await state();
        assert.equal(st.result, null, 'Enter on Cancel does not resign');
        assert.equal(await page.$('.app-chess .dialog'), null);
      });

      await test('a result reached while another dialog is open is shown when that dialog closes', async () => {
        await T('setup', START_FEN, { mode: 'two', time: '5+0' });
        await click('e2');
        await click('e4');
        await page.click('.app-chess [data-cmd="more"]');
        await page.click('.menu .menu-item:has-text("Keyboard shortcuts")');
        await page.waitForSelector('.app-chess .cx-keys');
        await T('setClock', 'b', 30);
        await waitFor((x) => !!x.result, 3000, 'flag');
        await page.waitForTimeout(800);
        assert.equal(await page.$('.app-chess .cx-result'), null, 'not stacked over the open dialog');
        await page.keyboard.press('Escape');
        await page.waitForSelector('.app-chess .cx-result', { timeout: 3000 });
        assert.match(await page.textContent('.app-chess .cx-res-reason'), /Black ran out of time/);
        await closeDialogs();
      });

      await test('timeout rule: a lone knight can still mate against pawns; a bare king cannot', async () => {
        await T('setup', '7k/7p/8/8/8/8/8/K5N1 w - - 0 1', { mode: 'two', time: '5+0' });
        await click('a1');
        await click('a2');
        await T('setClock', 'b', 30);
        let st = await waitFor((x) => !!x.result, 3000, 'flag');
        assert.deepEqual([st.result.reason, st.result.winner], ['timeout', 'w']);
        await closeDialogs();
        await T('setup', '7k/8/8/8/8/8/8/K5Q1 b - - 0 1', { mode: 'two', time: '5+0' });
        await click('h8');
        await click('h7');
        await T('setClock', 'w', 30);
        st = await waitFor((x) => !!x.result, 3000, 'flag');
        assert.deepEqual([st.result.reason, st.result.winner], ['timeoutDraw', null]);
        await page.waitForSelector('.app-chess .cx-result');
        await closeDialogs();
      });

      await test('keyboard play is announced square by square for screen readers', async () => {
        await T('setup', START_FEN, { mode: 'two', time: 'none' });
        await page.focus('.app-chess .cb-board');
        const sr = () => page.textContent('.app-chess .cx-sr');
        await page.keyboard.press('ArrowUp');
        assert.equal(await sr(), 'e3, empty');
        await page.keyboard.press('ArrowDown');
        assert.equal(await sr(), 'e2, White pawn');
        await page.keyboard.press('Enter');
        assert.equal(await sr(), 'e2, White pawn, selected, 2 legal moves');
        await page.keyboard.press('ArrowUp');
        assert.equal(await sr(), 'e3, empty, legal move');
        await page.keyboard.press('ArrowUp');
        await page.keyboard.press('Enter');
        await page.waitForTimeout(200);
        assert.equal(await sr(), 'White played e4');
      });

      await test('switching language with the promotion picker open cancels it; keys still work', async () => {
        await T('setup', '4k3/1P6/8/8/8/8/8/4K3 w - - 0 1', { mode: 'two', time: 'none' });
        await click('b7');
        await click('b8');
        await page.waitForSelector('.app-chess .cb-promo');
        await page.evaluate(() => window.__aurora.settings.set('lang', 'fr'));
        await page.waitForTimeout(700);
        assert.equal(await page.$('.app-chess .cb-promo:not(.closing)'), null);
        assert.equal((await pieces()).b7, 'wP');
        await click('b7');
        await click('b8');
        await page.waitForSelector('.app-chess .cb-promo');
        await page.waitForTimeout(100);
        await page.keyboard.press('d'); // Dame
        await page.waitForTimeout(300);
        assert.deepEqual((await state()).history, ['b8=Q+']);
        await page.evaluate(() => window.__aurora.settings.set('lang', 'en'));
        await page.waitForTimeout(500);
      });

      await test('no leaks: 15 open/close cycles (also mid-search, mid-drag, with clocks)', async () => {
        // (a single-instance app relaunched during its close animation gets the dying window back:
        // wait until it is gone)
        const closed = () => page.waitForFunction(() => window.__aurora.wm.byApp('chess').length === 0, null, { timeout: 5000 });
        await page.evaluate(() => window.__aurora.wm.byApp('chess')[0].close());
        await closed();
        for (let i = 0; i < 15; i++) {
          await page.evaluate(() => window.__aurora.registry.launch('chess'));
          await page.waitForFunction(() => {
            const w = window.__aurora.wm.byApp('chess')[0];
            return !!(w && window.__aurora.registry.instance(w.id)?.hooks?.test);
          });
          await page.waitForTimeout(150);
          if (i % 3 === 0) {
            await T('setup', START_FEN, { mode: 'ai', side: 'w', level: 'expert', time: '5+0' });
            await click('e2');
            await click('e4');
          } else if (i % 3 === 1) {
            const p = await page.evaluate(() => {
              const b = document.querySelector('.app-chess .cb-board').getBoundingClientRect();
              return { x: b.left + b.width * 0.81, y: b.bottom - b.height * 0.06 };
            });
            await page.mouse.move(p.x, p.y);
            await page.mouse.down();
            await page.mouse.move(p.x + 30, p.y - 60, { steps: 3 });
          }
          await page.evaluate(() => window.__aurora.wm.byApp('chess')[0].close());
          await closed();
          if (i % 3 === 1) await page.mouse.up();
        }
        await page.waitForTimeout(1200);
        const c = await page.evaluate(() => ({ workers: window.__workers, ac: window.__ac, intervals: window.__iv.size, wins: window.__aurora.wm.byApp('chess').length }));
        assert.equal(c.wins, 0);
        assert.equal(c.workers.created, c.workers.terminated, `workers ${JSON.stringify(c.workers)}`);
        assert.equal(c.ac.created, c.ac.closed, `audio contexts ${JSON.stringify(c.ac)}`);
        assert.equal(c.intervals, 0, 'clock intervals cleared');
        assert.equal(await wmHandlers(), baseHandlers, 'window manager listeners');
      });

      await test('no renderer errors (robustness)', () =>
        assert.deepEqual(
          chessErrors(s).filter((l) => !/could not resume the saved game/.test(l)),
          [],
        ));
    } finally {
      await s.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  }

  // ------------------------------------------------------------ session 5: common screen sizes
  if (want(5)) console.log('UI — 1280x720 and 1920x1080 screens');
  for (const size of want(5) ? ['1280x720', '1920x1080'] : []) {
    const s = await launchShell({ open: ['chess'], lang: 'fr', theme: size === '1280x720' ? 'light' : 'dark', size });
    const H = helpers(s);
    try {
      await s.page.waitForSelector('.app-chess .cb-board');
      await s.page.waitForTimeout(500);
      await test(`${size}: default, maximized and minimum windows fit (French, clocks, analysis)`, async () => {
        const fit = () =>
          s.page.evaluate(() => {
            const w = document.querySelector('.win.app-chess').getBoundingClientRect();
            const out = [];
            for (const sel of ['.cb-board', '.cx-panel', '.cx-toolbar', '.cx-moves-card', '.cx-player:last-child', '.cx-eval']) {
              const el = document.querySelector(`.app-chess ${sel}`);
              if (!el || el.offsetParent === null) continue;
              const r = el.getBoundingClientRect();
              if (r.left < w.left - 1 || r.right > w.right + 1 || r.top < w.top - 1 || r.bottom > w.bottom + 1) out.push(sel);
            }
            if (w.bottom > innerHeight || w.right > innerWidth) out.push('window off screen');
            for (const el of document.querySelectorAll('.app-chess .cx-toolbar *, .app-chess .cx-panel *')) {
              if (el.offsetParent === null || el.children.length || el.matches('.ellipsis')) continue;
              if (el.scrollWidth > el.clientWidth + 1) out.push(`overflow: ${el.className} "${el.textContent.trim().slice(0, 30)}"`);
            }
            return out;
          });
        await H.T('setup', 'r1bq1rk1/pp2bppp/2n1pn2/3p4/2PP4/2N1PN2/PP3PPP/R2QKB1R w KQ - 0 8', { mode: 'ai', side: 'w', level: 'medium', time: '15+10' });
        await s.page.waitForTimeout(300);
        assert.deepEqual(await fit(), [], 'default size');
        await H.win('maximize');
        await s.page.waitForTimeout(700);
        assert.deepEqual(await fit(), [], 'maximized');
        const big = (await H.state()).boardSize;
        assert.ok(big >= (size === '1280x720' ? 540 : 900), `maximized board ${big}`);
        await winShot(s, `chess-maximized-${size}`, { pub: size === '1920x1080' });
        await H.win('restore');
        await s.page.waitForTimeout(400);
        await H.win('setSize', 400, 300);
        await s.page.waitForTimeout(500);
        assert.deepEqual(await fit(), [], 'minimum size');
        await H.T('setup', START_FEN, { mode: 'analysis' });
        await s.page.waitForTimeout(600);
        assert.deepEqual(await fit(), [], 'minimum size, analysis board');
      });
      await test(`${size}: no renderer errors`, () => assert.deepEqual(chessErrors(s), []));
    } finally {
      await s.close();
    }
  }
}

// ---------------------------------------------------------------- run
if (!UI_ONLY) await unitTests();
if (!UNIT_ONLY) await uiTests();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
