// Aurora Chess — the app: game flow, side panel, dialogs, clocks, persistence.
//   engine.mjs  rules (move generation, SAN/FEN/PGN, game end)       — pure, node-tested (perft)
//   ai.mjs      computer player (alpha-beta search), run in worker.js — pure, node-tested
//   board.mjs   board view (squares, pieces, drag & drop, animation, promotion picker)
//   pieces.mjs  original SVG piece set ; sfx.mjs  WebAudio sound effects
import { Chess, Position, SQUARES, START_FEN, validateFen, colorOf, typeOf, sqName, sqIndex } from './engine.mjs';
import { LEVELS, LEVEL_IDS, Engine, positionFrom } from './ai.mjs';
import { BoardView } from './board.mjs';
import { pieceUrl } from './pieces.mjs';
import { Sfx } from './sfx.mjs';

const MODES = ['ai', 'two', 'analysis'];
const THEMES = ['wood', 'green', 'blue', 'aurora', 'dark'];
const TIME_CONTROLS = { none: null, '5+0': [300, 0], '10+0': [600, 0], '15+10': [900, 10] };
const DEFAULT_SETUP = { mode: 'ai', side: 'w', level: 'medium', time: 'none' };
const DEFAULT_PREFS = { theme: 'wood', coords: true, legal: true, sound: true, autoQueen: false, autoFlip: false, setup: DEFAULT_SETUP };
const PIECE_VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const CAPTURE_ORDER = ['p', 'n', 'b', 'r', 'q'];
const MIN_AI_DELAY = 450;
const MAX_PGN_BYTES = 8 * 1024 * 1024;

const animOn = () => document.documentElement.dataset.animations !== 'off';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const other = (c) => (c === 'w' ? 'b' : 'w');
const emptyStats = () => ({
  ai: Object.fromEntries(LEVEL_IDS.map((l) => [l, { w: 0, l: 0, d: 0 }])),
  two: { games: 0, w: 0, b: 0, d: 0 },
});

export default {
  async launch(ctx) {
    const app = new ChessApp(ctx);
    await app.init();
    return {
      onRelaunch: (args) => app.onRelaunch(args),
      test: app.testApi(),
    };
  },
};

// ---------------------------------------------------------------- engine client (Web Worker)
class EngineClient {
  constructor(url) {
    this.url = url;
    this.worker = null;
    this.pending = null;
    this.seq = 0;
    this.failed = false;
  }

  _ensure() {
    if (this.worker) return;
    const w = new Worker(this.url, { type: 'module', name: 'aurora-chess-engine' });
    w.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === 'ready' || !this.pending || m.id !== this.pending.id) return;
      const p = this.pending;
      this.pending = null;
      if (m.type === 'error') p.reject(new Error(m.message));
      else p.resolve(m);
    };
    w.onerror = (e) => {
      e.preventDefault?.();
      this.failed = true;
      const p = this.pending;
      this.pending = null;
      w.terminate();
      if (this.worker === w) this.worker = null;
      p?.reject(new Error(e.message || 'engine worker failed'));
    };
    this.worker = w;
  }

  // Resolves with the search result; rejects with err.cancelled when superseded / cancelled.
  // kind ('ai' | 'hint' | 'analysis' | 'draw') lets cancel(kind) stop only that search.
  think(params, kind = 'ai') {
    this.cancel();
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      this.pending = { id, resolve, reject, kind };
      try {
        this._ensure();
        this.worker.postMessage({ ...params, id, type: 'think' });
      } catch (err) {
        this.pending = null;
        this.failed = true;
        reject(err);
      }
    });
  }

  get busy() {
    return !!this.pending;
  }

  cancel(kind) {
    if (!this.pending || (kind && this.pending.kind !== kind)) return;
    const p = this.pending;
    this.pending = null;
    // a running search cannot be interrupted: drop the worker, a fresh one starts on demand
    this.worker?.terminate();
    this.worker = null;
    const err = new Error('cancelled');
    err.cancelled = true;
    p.reject(err);
  }

  dispose() {
    this.cancel();
    this.worker?.terminate();
    this.worker = null;
  }
}

// Same search on the UI thread, with a short budget — only used if the worker cannot start.
async function thinkInline(params) {
  await sleep(30);
  const pos = positionFrom(params.startFen, params.moves);
  const engine = new Engine({ ttBits: 16 });
  return engine.think(pos, { ...params, timeMs: Math.min(params.timeMs || LEVELS[params.level]?.time || 500, 600), history: params.moves });
}

// ---------------------------------------------------------------- the app
class ChessApp {
  constructor(ctx) {
    this.ctx = ctx;
    this.t = ctx.t;
    this.h = ctx.h;
    this.prefs = { ...DEFAULT_PREFS };
    this.stats = emptyStats();
    this.game = new Chess();
    this.setup = { ...DEFAULT_SETUP };
    this.human = 'w';
    this.view = 0;
    this.result = null;
    this.flipped = false;
    this.thinking = false;
    this.aiToken = 0;
    this.hint = null;
    this.hintBusy = false;
    this.hintToken = 0;
    this.analysis = null;
    this.analysisToken = 0;
    this.statsRecorded = false;
    this.clock = { on: false };
    this.ticker = null;
    this.toast = null;
    this.headers = {};
    this.fileName = null;
    this.engine = new EngineClient(ctx.appUrl('worker.js'));
    this.sfx = new Sfx(() => this.prefs.sound && ctx.settings.get('sounds') !== false);
    this.board = new BoardView({
      h: ctx.h,
      t: ctx.t,
      onMove: (from, to) => this.onBoardMove(from, to),
      getTargets: (sq) => this.targetsFor(sq),
    });
  }

  // ------------------------------------------------------------ lifecycle
  async init() {
    const { ctx } = this;
    const [prefs, stats, saved] = await Promise.all([
      ctx.storage.get('prefs', null).catch(() => null),
      ctx.storage.get('stats', null).catch(() => null),
      ctx.storage.get('game', null).catch(() => null),
    ]);
    this.prefs = sanitizePrefs(prefs);
    if (stats && typeof stats === 'object') this.stats = mergeStats(stats);
    this.buildUI();
    ctx.onLangChange(() => this.buildUI());
    ctx.onClose(() => this.dispose());
    ctx.win.on('resize', () => this.layout());
    let started = false;
    // the error dialog of an unreadable file must not hold up the launch
    if (ctx.args?.file) started = await this.openPgnFile(ctx.args.file, { wait: false });
    if (!started && saved) started = this.resume(saved);
    if (!started) this.newGame(this.prefs.setup, { silent: true });
    requestAnimationFrame(() => this.layout());
    setTimeout(() => this.root.focus({ preventScroll: true }), 50);
  }

  onRelaunch(args) {
    if (args?.file) this.openPgnFile(args.file);
  }

  dispose() {
    this.disposed = true;
    this.saveNow();
    this.cancelAi();
    this.cancelAnalysis();
    this.board.cancelPromotion();
    this.engine.dispose();
    clearInterval(this.ticker);
    this.ticker = null;
    for (const k of ['_resultTimer', '_anTimer', '_toastTimer', '_flipTimer', '_saveTimer']) clearTimeout(this[k]);
    this.resizeObs?.disconnect();
    this.sfx.dispose();
  }

  // ------------------------------------------------------------ UI construction
  buildUI() {
    const { h, t, ctx } = this;
    const { icon } = ctx;
    const win = ctx.win;
    // rebuilt on a language change: the promotion picker would keep the old language and lose
    // its keyboard focus, so it is cancelled (the pawn slides back); focus stays in the app
    const hadFocus = !!this.root && win.body.contains(document.activeElement);
    this.board.cancelPromotion();
    this.resizeObs?.disconnect();
    ctx.ui.clear(win.body);

    const tb = (name, label, onclick, { tip, cls, id } = {}) =>
      h(
        'button',
        { class: ['btn subtle cx-tb-btn', cls], 'data-tip': tip || label, 'data-tip-pos': 'below', 'aria-label': label, onclick, dataset: { cmd: id || name } },
        icon(name),
        h('span', { class: 'cx-btn-label' }, label),
      );
    this.btnNew = tb('add', t('tb.newGame'), () => this.openNewGameDialog(), { tip: `${t('tb.newGame')} (N)`, id: 'new' });
    this.btnUndo = tb('arrow_undo', t('tb.undo'), () => this.undo(), { tip: `${t('tb.undo')} (Ctrl+Z)`, id: 'undo' });
    this.btnHint = tb('lightbulb', t('tb.hint'), () => this.showHint(), { tip: `${t('tb.hint')} (H)`, id: 'hint' });
    this.btnFlip = tb('arrow_sync', t('tb.flip'), () => this.toggleFlip(), { tip: `${t('tb.flip')} (F)`, id: 'flip' });
    this.btnDraw = tb('handshake', t('tb.draw'), () => this.offerDraw(), { id: 'draw' });
    this.btnResign = tb('flag', t('tb.resign'), () => this.resign(), { id: 'resign' });
    this.btnMore = h(
      'button',
      { class: 'btn subtle icon-btn cx-tb-more', 'data-tip': t('tb.more'), 'data-tip-pos': 'below', 'aria-label': t('tb.more'), 'aria-haspopup': 'menu', onclick: (e) => this.openMoreMenu(e), dataset: { cmd: 'more' } },
      icon('more_horizontal'),
    );
    const toolbar = h(
      'div',
      { class: 'cx-toolbar', role: 'toolbar', 'aria-label': t('tb.label') },
      h('div', { class: 'cx-tb-group' }, this.btnNew, h('div', { class: 'cx-tb-sep' }), this.btnUndo, this.btnHint, this.btnFlip),
      h('div', { class: 'cx-tb-group cx-tb-end' }, this.btnDraw, this.btnResign, this.btnMore),
    );

    // eval bar (analysis mode)
    this.evalFill = h('div', { class: 'cx-eval-fill' });
    this.evalText = h('div', { class: 'cx-eval-text' });
    this.evalBar = h('div', { class: 'cx-eval', role: 'meter', 'aria-label': t('analysis.eval'), 'aria-valuemin': '-10', 'aria-valuemax': '10' }, this.evalFill, this.evalText);

    this.board.el.setAttribute('aria-label', t('board.label'));
    this.board.el.setAttribute('aria-roledescription', t('board.role'));
    this.boardFrame = h('div', { class: 'cx-board-frame' }, this.evalBar, this.board.el);
    this.boardArea = h('div', { class: 'cx-board-area' }, this.boardFrame);

    // side panel
    this.cards = { top: this.playerCard(), bottom: this.playerCard() };
    this.statusIcon = h('span', { class: 'cx-status-icon' });
    this.statusText = h('div', { class: 'cx-status-text', 'aria-live': 'polite' });
    this.modeText = h('div', { class: 'cx-mode caption text-2' });
    this.analysisText = h('div', { class: 'cx-analysis caption' });
    this.backBtn = h('button', { class: 'btn small cx-back', onclick: () => this.goto(this.game.length) }, icon('arrow_next', { size: 12 }), t('nav.backToGame'));
    this.toastEl = h('div', { class: 'cx-toast caption', role: 'status' });
    const infoCard = h(
      'div',
      { class: 'cx-info' },
      h('div', { class: 'cx-status' }, this.statusIcon, this.statusText),
      this.modeText,
      this.analysisText,
      this.backBtn,
      this.toastEl,
    );
    this.movesEl = h('div', { class: 'cx-moves', role: 'list', 'aria-label': t('moves.label'), tabindex: '-1' });
    const nav = (name, label, fn, key, id) => h('button', { class: 'btn subtle icon-btn', 'data-tip': `${label} (${key})`, 'aria-label': label, onclick: fn, dataset: { nav: id } }, icon(name));
    this.navBtns = {
      first: nav('previous', t('nav.first'), () => this.goto(0), t('keys.home'), 'first'),
      prev: nav('chevron_left', t('nav.prev'), () => this.goto(this.view - 1), '←', 'prev'),
      next: nav('chevron_right', t('nav.next'), () => this.goto(this.view + 1), '→', 'next'),
      last: nav('next', t('nav.last'), () => this.goto(this.game.length), t('keys.end'), 'last'),
    };
    const navBar = h(
      'div',
      { class: 'cx-nav' },
      this.navBtns.first,
      this.navBtns.prev,
      this.navBtns.next,
      this.navBtns.last,
      h('div', { class: 'grow' }),
      h('button', { class: 'btn subtle icon-btn', 'data-tip': t('menu.copyPgn'), 'aria-label': t('menu.copyPgn'), onclick: () => this.copyPgn(), dataset: { cmd: 'copy-pgn' } }, icon('copy')),
    );
    const movesCard = h('div', { class: 'cx-moves-card' }, h('div', { class: 'cx-moves-head caption text-2' }, t('moves.title')), this.movesEl, navBar);
    this.panel = h('aside', { class: 'cx-panel', 'aria-label': t('panel.label') }, this.cards.top.el, infoCard, movesCard, this.cards.bottom.el);

    this.main = h('div', { class: 'cx-main' }, this.boardArea, this.panel);
    this.srEl = h('div', { class: 'cx-sr', 'aria-live': 'polite', role: 'status' });
    this.root = h('div', { class: 'cx', tabindex: '-1' }, toolbar, this.main, this.srEl);
    win.body.appendChild(this.root);
    this.setWindowTitle();
    if (!this._keysBound) {
      win.body.addEventListener('keydown', (e) => this.onKey(e));
      this._keysBound = true;
    }
    this.resizeObs = new ResizeObserver(() => this.layout());
    this.resizeObs.observe(this.main);
    this.board.onCursor = (sq) => this.announceSquare(sq);
    this.applyPrefs();
    if (this.game) this.render({ animate: false });
    if (hadFocus) this.root.focus({ preventScroll: true });
  }

  playerCard() {
    const { h, ctx } = this;
    const avatar = h('div', { class: 'cx-avatar' });
    const name = h('div', { class: 'cx-pname ellipsis' });
    const sub = h('div', { class: 'cx-psub caption text-2 ellipsis' });
    const captured = h('div', { class: 'cx-captured' });
    const diff = h('span', { class: 'cx-diff caption' });
    const thinking = h('div', { class: 'cx-thinking caption' }, h('span', { class: 'cx-dots' }, h('i'), h('i'), h('i')), h('span', { class: 'cx-thinking-label' }, this.t('status.thinkingShort')));
    const clock = h('div', { class: 'cx-clock', role: 'timer', 'aria-live': 'off' }, ctx.icon('timer', { size: 14 }), h('span', { class: 'cx-clock-time' }, '0:00'));
    const el = h(
      'div',
      { class: 'cx-player' },
      avatar,
      h('div', { class: 'cx-pinfo' }, h('div', { class: 'cx-pname-row' }, name, sub), h('div', { class: 'cx-pmeta' }, captured, diff, thinking)),
      clock,
    );
    return { el, avatar, name, sub, captured, diff, thinking, clock, clockTime: clock.querySelector('.cx-clock-time') };
  }

  applyPrefs() {
    this.board.setTheme(this.prefs.theme);
    this.board.setCoords(this.prefs.coords);
    this.board.setShowLegal(this.prefs.legal);
  }

  // Board size: the largest multiple of 8 px that fits next to the side panel.
  layout() {
    if (!this.main?.isConnected) return;
    // client sizes ignore transforms (window open / maximize animations scale the window)
    const r = { width: this.main.clientWidth, height: this.main.clientHeight };
    if (!r.width || !r.height) return;
    const cs = getComputedStyle(this.main);
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const gap = parseFloat(cs.columnGap) || 0;
    const evalW = this.setup.mode === 'analysis' ? 28 : 0; // bar + gap
    const availW = r.width - padX - gap - this.panel.offsetWidth - evalW;
    const availH = r.height - padY;
    const size = Math.max(128, Math.floor(Math.min(availW, availH) / 8) * 8);
    if (size !== this.board.size) this.board.setSize(size);
    this.evalBar.style.height = `${size}px`;
    this.panel.style.height = `${Math.min(availH, Math.max(size, 380))}px`;
  }

  // ------------------------------------------------------------ game setup
  newGame(setup = this.setup, { silent = false, startFen = START_FEN } = {}) {
    this.cancelAi();
    this.cancelAnalysis();
    this.board.cancelPromotion();
    this.setup = sanitizeSetup(setup);
    this.prefs.setup = { ...this.setup };
    this.savePrefs();
    this.game = new Chess(startFen);
    this.headers = {};
    this.fileName = null;
    this.setWindowTitle();
    this.human = this.setup.side === 'random' ? (Math.random() < 0.5 ? 'w' : 'b') : this.setup.side;
    if (this.setup.mode !== 'ai') this.human = 'w';
    this.view = 0;
    this.result = null;
    this.hint = null;
    this.analysis = null;
    this.statsRecorded = false;
    this.board.setHint(null);
    this.board.select(null);
    this.board.focusCursorOn(this.setup.mode === 'ai' && this.human === 'b' ? 'e7' : 'e2');
    this.clockReset();
    this.setFlipped(this.setup.mode === 'ai' ? this.human === 'b' : this.game.turn() === 'b' && this.prefs.autoFlip, false);
    // a set-up position that is already over (mate, stalemate, dead draw) is shown as finished
    const st = this.setup.mode === 'analysis' ? null : this.game.status();
    if (st) {
      this.result = st;
      this.statsRecorded = true;
    }
    this.layout();
    this.render({ animate: !silent });
    this.save();
    if (!silent) this.sfx.play('start');
    this.maybeAiMove();
    if (this.setup.mode === 'analysis') this.analyse();
  }

  resume(data) {
    try {
      if (!data || data.v !== 1 || data.result) return false;
      const g = new Chess(data.startFen || START_FEN);
      for (const u of data.moves || []) if (!g.move(u)) throw new Error(`bad move ${u}`);
      if (g.status()) return false;
      this.setup = sanitizeSetup(data.setup);
      this.game = g;
      this.headers = sanitizeHeaders(data.headers);
      this.human = data.human === 'b' ? 'b' : 'w';
      this.view = g.length;
      this.result = null;
      this.statsRecorded = !!data.statsRecorded;
      this.clockReset();
      if (this.clock.on && data.clock) {
        this.clock.w = clampTime(data.clock.w, this.clock.base);
        this.clock.b = clampTime(data.clock.b, this.clock.base);
        if (g.length > 0) this.clockStart(g.turn());
      }
      this.setFlipped(!!data.flipped, false);
      this.layout();
      this.render({ animate: false });
      this.maybeAiMove();
      if (this.setup.mode === 'analysis') this.analyse();
      return true;
    } catch (err) {
      console.warn('[chess] could not resume the saved game:', err.message);
      return false;
    }
  }

  // Load a position or game (FEN or PGN text) into analysis mode. fileName: the .pgn it came from.
  loadText(text, { fileName = null } = {}) {
    const src = String(text || '').trim();
    if (!src) throw new Error(this.t('import.empty'));
    let g;
    if (/^\s*\[/.test(src) || /\d+\.\s*\S/.test(src) || !src.includes('/')) {
      g = new Chess();
      try {
        g.loadPgn(src);
      } catch (err) {
        if (err.code === 'fen') throw new Error(this.t('import.badFenTag', { detail: this.t(`fenError.${err.fenError}`) }));
        // nothing that looks like chess at all (the very first token is not a move)
        if (err.code === 'move' && err.ply === 0 && !/^\s*\[/.test(src) && !/\d+\./.test(src)) throw new Error(this.t('import.notChess'));
        throw new Error(this.t('import.badPgn', { detail: err.code === 'move' ? this.localSan(err.move) : err.message }));
      }
    } else {
      const err = validateFen(src);
      if (err) throw new Error(this.t('import.badFen', { detail: this.t(`fenError.${err}`) }));
      g = new Chess(src);
    }
    this.cancelAi();
    this.cancelAnalysis();
    this.board.cancelPromotion();
    this.fileName = fileName;
    this.setWindowTitle();
    this.setup = { ...this.setup, mode: 'analysis' };
    this.game = g;
    this.headers = sanitizeHeaders(g.headers);
    this.human = 'w';
    this.view = g.length;
    this.result = null;
    this.statsRecorded = true;
    this.hint = null;
    this.board.setHint(null);
    this.clockReset();
    this.setFlipped(false, false);
    this.layout();
    this.render({ animate: true });
    this.save();
    this.analyse();
  }

  // Opens a .pgn file on the analysis board. Errors are shown in a dialog (awaited unless wait: false).
  async openPgnFile(path, { wait = true } = {}) {
    const name = String(path || '').split('/').pop();
    let text;
    try {
      text = await this.ctx.api.invoke('fs:readText', path, { maxBytes: MAX_PGN_BYTES });
    } catch (err) {
      const p = this.errorAlert(this.t('import.openFailed', { name, detail: this.fsErrorText(err) }));
      if (wait) await p;
      return false;
    }
    try {
      this.loadText(text, { fileName: name });
      return true;
    } catch (err) {
      const p = this.errorAlert(this.t('import.openFailed', { name, detail: err.message }));
      if (wait) await p;
      return false;
    }
  }

  // Backend file errors carry a code; never show raw (English, path-revealing) system messages.
  fsErrorText(err) {
    const key = { ENOENT: 'notFound', EACCES: 'denied', EPERM: 'denied', ETOOBIG: 'tooBig', EISDIR: 'isDir', ENOSPC: 'noSpace', EROFS: 'readOnly' }[err?.code];
    return this.t(`fsError.${key || 'generic'}`);
  }

  errorAlert(message) {
    if (this.disposed) return Promise.resolve();
    return this.modal({ title: this.t('error.title'), body: message, buttons: [{ label: this.t('common.ok'), value: true, primary: true }] });
  }

  setWindowTitle() {
    const appName = this.ctx.i18n.name(this.ctx.manifest.name);
    this.ctx.win.setTitle(this.fileName ? `${this.fileName} - ${appName}` : appName);
  }

  // ------------------------------------------------------------ moves
  liveAtView() {
    return this.view === this.game.length;
  }

  gameAtView() {
    if (this.liveAtView()) return this.game;
    const g = new Chess(this.game.startFen);
    const hist = this.game.history({ verbose: true });
    for (let i = 0; i < this.view; i++) g.move(hist[i].move);
    return g;
  }

  canInteract() {
    if (this.board.promoting) return false;
    const analysis = this.setup.mode === 'analysis';
    // a finished game is read-only (on the analysis board, earlier positions can still branch)
    if (this.result && !(analysis && !this.liveAtView())) return false;
    if (!this.liveAtView() && !analysis) return false;
    if (this.setup.mode === 'ai') {
      if (this.thinking) return false;
      if (this.game.turn() !== this.human) return false;
    }
    return true;
  }

  targetsFor(sq) {
    if (!this.canInteract()) return null;
    const g = this.gameAtView();
    const p = g.get(sq);
    if (!p || p.color !== g.turn()) return null;
    const moves = g.moves({ square: sq, verbose: true });
    if (!moves.length) return [];
    return moves.map((m) => ({ to: m.to, promotion: !!m.promotion, capture: !!m.captured }));
  }

  async onBoardMove(from, to) {
    if (!this.canInteract()) return this.render({ animate: true });
    const g = this.gameAtView();
    const cands = g.moves({ square: from, verbose: true }).filter((m) => m.to === to);
    if (!cands.length) {
      this.sfx.play('illegal');
      return this.render({ animate: true });
    }
    let promotion;
    if (cands.some((m) => m.promotion)) {
      if (this.prefs.autoQueen) promotion = 'q';
      else {
        const game = this.game;
        const view = this.view;
        this.board.setInteractive(false);
        promotion = await this.board.askPromotion(to, g.turn());
        this.board.setInteractive(true);
        // cancelled, or the game changed meanwhile (new game, flag fall…)
        if (!promotion || this.game !== game || this.view !== view || !this.canInteract()) return this.render({ animate: true });
      }
    }
    if (!this.liveAtView()) {
      // analysis: playing from an earlier position replaces the rest of the line
      while (this.game.length > this.view) this.game.undo();
      this.result = null;
    }
    if (!this.playMove({ from, to, promotion }, 'human')) this.render({ animate: true });
  }

  playMove(input, by) {
    const g = this.game;
    const v = g.move(input);
    if (!v) return null;
    this.view = g.length;
    this.cancelHint();
    this.hideToast();
    this.clockOnMove(v.color);
    const st = g.status();
    if (!st || st.reason !== 'checkmate') {
      if (g.inCheck()) this.sfx.play('check');
      else if (v.promotion) this.sfx.play('promote');
      else if (v.castle) this.sfx.play('castle');
      else if (v.captured) this.sfx.play('capture');
      else this.sfx.play('move');
    } else this.sfx.play(v.captured ? 'capture' : 'move');
    this.render({ move: v, animate: true });
    this.announce(v);
    if (st) {
      this.endGame(st);
      return v;
    }
    this.save();
    if (this.setup.mode === 'two' && this.prefs.autoFlip) {
      const want = g.turn() === 'b';
      clearTimeout(this._flipTimer);
      this._flipTimer = setTimeout(() => {
        if (this.game === g && !this.result && g.turn() === (want ? 'b' : 'w')) this.setFlipped(want);
      }, animOn() ? 420 : 0);
    }
    if (by !== 'ai') this.maybeAiMove();
    if (this.setup.mode === 'analysis') this.analyse();
    return v;
  }

  // Screen readers hear every move (and check / mate) through a polite live region.
  announce(v) {
    const side = this.t(v.color === 'w' ? 'side.white' : 'side.black');
    let text = this.t('announce.move', { side, san: this.localSan(v.san) });
    if (this.game.inCheck() && !v.san.endsWith('#')) text += ` ${this.t('status.check')}`;
    if (this.srEl) this.srEl.textContent = text;
  }

  goto(k) {
    const n = Math.max(0, Math.min(this.game.length, k));
    if (n === this.view) return;
    const hist = this.game.history({ verbose: true });
    let move = null;
    if (n === this.view + 1) move = moveAnim(hist[n - 1]);
    else if (n === this.view - 1) move = reverseAnim(moveAnim(hist[n]));
    const v = n > this.view ? hist[n - 1] : null;
    this.view = n;
    this.board.select(null);
    this.cancelHint(); // a hint (shown or still searching) belongs to the position it was asked for
    this.render({ move, animate: true });
    if (v) this.sfx.play(v.captured ? 'capture' : 'move');
    if (this.setup.mode === 'analysis') this.analyse();
  }

  // ------------------------------------------------------------ computer player
  async maybeAiMove() {
    if (this.setup.mode !== 'ai' || this.result || this.game.turn() === this.human) return;
    const g = this.game;
    const token = ++this.aiToken;
    this.thinking = true;
    this.render({ animate: false });
    const started = performance.now();
    const level = this.setup.level;
    let timeMs = LEVELS[level].time;
    if (this.clock.on) {
      const left = this.clockLeft(g.turn());
      timeMs = Math.max(120, Math.min(timeMs, left / 30 + this.clock.inc * 0.7));
    }
    const params = { startFen: g.startFen, moves: g.history({ verbose: true }).map((v) => v.uci), level, timeMs };
    let res;
    try {
      res = this.engine.failed ? await thinkInline(params) : await this.engine.think(params);
    } catch (err) {
      if (err?.cancelled || token !== this.aiToken) return;
      console.warn('[chess] engine worker failed, thinking on the UI thread:', err.message);
      try {
        res = await thinkInline(params);
      } catch (err2) {
        if (token !== this.aiToken) return;
        console.warn('[chess] the computer player failed:', err2?.message);
        this.thinking = false;
        this.render({ animate: false });
        this.errorAlert(this.t('error.engine'));
        return;
      }
    }
    const wait = (level === 'beginner' ? 700 : MIN_AI_DELAY) - (performance.now() - started);
    if (wait > 0 && animOn()) await sleep(wait);
    if (token !== this.aiToken || this.game !== g) return;
    this.thinking = false;
    if (!res?.move || !this.playMove(res.move, 'ai')) {
      console.warn('[chess] the computer player returned an illegal move:', res?.move);
      this.render({ animate: false });
      this.errorAlert(this.t('error.engine'));
    }
  }

  cancelAi() {
    this.aiToken++;
    this.hintToken++;
    this.hintBusy = false;
    this.hintWanted = false;
    if (this.thinking) this.thinking = false;
    this.engine.cancel();
  }

  // Drops the hint arrow and any hint search still running (the position changed).
  cancelHint() {
    this.hintToken++;
    this.hintWanted = false;
    if (this.hintBusy) {
      this.hintBusy = false;
      this.engine.cancel('hint');
    }
    if (this.hint) {
      this.hint = null;
      this.board.setHint(null);
    }
  }

  // ------------------------------------------------------------ analysis mode
  analyse() {
    if (this.setup.mode !== 'analysis') return;
    const token = ++this.analysisToken;
    clearTimeout(this._anTimer);
    this.analysis = { pending: true };
    this.renderAnalysis();
    this._anTimer = setTimeout(async () => {
      const g = this.gameAtView();
      if (g.status()) {
        this.analysis = { over: true };
        this.hintDone(null);
        this.renderAnalysis();
        return;
      }
      const params = { startFen: g.startFen, moves: g.history({ verbose: true }).map((v) => v.uci), level: 'expert', timeMs: 1500, analysis: true };
      try {
        const res = this.engine.failed ? await thinkInline(params) : await this.engine.think(params, 'analysis');
        if (token !== this.analysisToken) return;
        const white = g.turn() === 'w' ? 1 : -1;
        const san = pvToSan(g, res.pv);
        this.analysis = { score: res.score * white, mate: res.mate == null ? null : res.mate * white, pv: san, best: res.move, depth: res.depth };
        this.hintDone(res.move);
        this.renderAnalysis();
      } catch (err) {
        if (err?.cancelled || token !== this.analysisToken) return;
        console.warn('[chess] analysis failed:', err?.message);
        this.analysis = { failed: true };
        this.hintDone(null);
        this.renderAnalysis();
      }
    }, 120);
  }

  // Analysis board: a hint asked for while the analysis is still running is answered by it
  // (a separate hint search would cancel the analysis).
  hintDone(uci) {
    if (!this.hintWanted) return;
    this.hintWanted = false;
    this.hintBusy = false;
    if (uci) this.setHint(uci);
    else if (!this.gameAtView().status()) this.showToast(this.t('error.hint'));
    this.renderToolbar();
    this.renderStatus();
  }

  cancelAnalysis() {
    this.analysisToken++;
    clearTimeout(this._anTimer);
    this.analysis = null;
    this.engine.cancel('analysis');
  }

  // ------------------------------------------------------------ commands
  canUndo() {
    if (this.board.promoting) return false;
    // a lost-on-time, resigned or agreed game is final
    if (this.result && ['timeout', 'timeoutDraw', 'resign', 'agreement'].includes(this.result.reason)) return false;
    const n = this.game.length;
    if (!n) return false;
    if (this.setup.mode === 'ai') return this.game.history({ verbose: true }).some((v) => v.color === this.human);
    return true;
  }

  undo() {
    if (!this.canUndo()) return;
    const wasOver = !!this.result;
    this.cancelAi();
    const g = this.game;
    if (this.setup.mode === 'ai') {
      g.undo();
      while (g.length && g.turn() !== this.human) g.undo();
    } else g.undo();
    this.view = g.length;
    this.result = null;
    this.hint = null;
    this.board.setHint(null);
    this.board.select(null);
    this.hideToast();
    if (this.clock.on) {
      this.clockStop();
      if (g.length > 0) this.clockStart(g.turn());
    }
    if (wasOver) this.ensureTicker();
    this.render({ animate: true });
    this.save();
    this.sfx.play('move');
    if (this.setup.mode === 'two' && this.prefs.autoFlip) this.setFlipped(g.turn() === 'b');
    this.maybeAiMove();
    if (this.setup.mode === 'analysis') this.analyse();
  }

  toggleFlip() {
    this.setFlipped(!this.flipped);
    this.save();
  }

  setFlipped(on, animate = true) {
    this.flipped = on;
    if (!animate) this.board.el.classList.add('no-anim');
    this.board.setFlipped(on);
    if (!animate) {
      void this.board.el.offsetWidth;
      this.board.el.classList.remove('no-anim');
    }
    this.renderPlayers();
    this.renderEval();
  }

  // A finished game takes no hint, except earlier positions of the analysis board.
  resultBlocks() {
    return !!this.result && !(this.setup.mode === 'analysis' && !this.liveAtView());
  }

  async showHint() {
    if (this.resultBlocks() || this.hintBusy || this.drawBusy) return;
    if (!this.liveAtView() && this.setup.mode !== 'analysis') return;
    if (this.setup.mode === 'ai' && (this.thinking || this.game.turn() !== this.human)) return;
    const g = this.gameAtView();
    if (g.status()) return;
    if (this.setup.mode === 'analysis') {
      if (this.analysis?.best) return this.setHint(this.analysis.best);
      if (this.analysis?.pending) {
        this.hintWanted = true;
        this.hintBusy = true;
        this.renderToolbar();
        this.renderStatus();
        return;
      }
    }
    const token = ++this.hintToken;
    this.hintBusy = true;
    this.renderToolbar();
    this.renderStatus();
    const params = { startFen: g.startFen, moves: g.history({ verbose: true }).map((v) => v.uci), level: 'hard', timeMs: 900, analysis: true };
    try {
      const res = this.engine.failed ? await thinkInline(params) : await this.engine.think(params, 'hint');
      if (token !== this.hintToken) return;
      this.hintBusy = false;
      if (res.move) this.setHint(res.move);
    } catch (err) {
      if (token !== this.hintToken) return;
      this.hintBusy = false;
      if (!err?.cancelled) this.showToast(this.t('error.hint'));
    }
    this.renderToolbar();
    this.renderStatus();
  }

  setHint(uci) {
    const g = this.gameAtView();
    const m = g.moves({ verbose: true }).find((x) => x.uci === uci);
    if (!m) return;
    this.hint = { from: m.from, to: m.to, san: m.san };
    this.board.setHint({ from: m.from, to: m.to });
    this.sfx.play('notify');
    this.renderStatus();
  }

  async offerDraw() {
    if (this.result || this.setup.mode === 'analysis' || this.drawBusy) return;
    const { t } = this;
    if (this.setup.mode === 'ai') {
      if (this.thinking) return;
      const g = this.game;
      this.drawBusy = true;
      this.renderToolbar();
      this.showToast(t('draw.considering'), { spinner: true, sticky: true });
      let accept = false;
      const plies = g.length;
      const stale = () => this.game !== g || this.result || g.length !== plies;
      try {
        const params = { startFen: g.startFen, moves: g.history({ verbose: true }).map((v) => v.uci), level: 'hard', timeMs: 600, analysis: true };
        const res = this.engine.failed ? await thinkInline(params) : await this.engine.think(params, 'draw');
        if (stale()) return;
        // score is from the side to move's point of view
        const aiScore = g.turn() === this.human ? -res.score : res.score;
        accept = aiScore <= -120 || (Math.abs(aiScore) <= 25 && g.length >= 80) || g.isInsufficientMaterial();
      } catch (err) {
        if (err?.cancelled) return this.hideToast();
      } finally {
        this.drawBusy = false;
        this.renderToolbar();
        if (stale()) this.hideToast();
      }
      await sleep(animOn() ? 350 : 0);
      if (stale()) return this.hideToast();
      if (accept) {
        this.hideToast();
        this.endGame({ winner: null, reason: 'agreement', result: '1/2-1/2' });
      } else {
        this.sfx.play('notify');
        this.showToast(t('draw.declined'));
        this.maybeAiMove();
      }
      return;
    }
    const offerer = this.game.turn();
    const g = this.game;
    const ok = await this.confirmDialog(t('draw.twoPrompt', { offerer: this.sideName(offerer), other: this.sideName(other(offerer)) }), {
      title: t('draw.title'),
      okLabel: t('draw.accept'),
      cancelLabel: t('draw.decline'),
    });
    if (ok && !this.result && this.game === g) this.endGame({ winner: null, reason: 'agreement', result: '1/2-1/2' });
  }

  async resign() {
    if (this.result || this.setup.mode === 'analysis') return;
    const { t } = this;
    const loser = this.setup.mode === 'ai' ? this.human : this.game.turn();
    const g = this.game;
    const ok = await this.confirmDialog(this.setup.mode === 'ai' ? t('resign.confirmAi') : t('resign.confirmTwo', { side: this.sideName(loser) }), {
      title: t('resign.title'),
      okLabel: t('resign.ok'),
    });
    if (!ok || this.result || this.game !== g) return;
    const winner = other(loser);
    this.endGame({ winner, reason: 'resign', loser, result: winner === 'w' ? '1-0' : '0-1' });
  }

  endGame(st) {
    this.cancelAi();
    this.board.cancelPromotion(); // e.g. resigned or flagged with the promotion picker open
    this.result = st;
    this.clockStop();
    this.board.select(null);
    this.hint = null;
    this.board.setHint(null);
    if (!this.statsRecorded) this.recordStats(st);
    this.render({ animate: false });
    this.save();
    const kind = this.outcomeFor(st);
    this.sfx.play(kind === 'win' ? 'win' : kind === 'loss' ? 'lose' : kind === 'draw' ? 'draw' : 'win');
    clearTimeout(this._resultTimer);
    this._resultTimer = setTimeout(() => this.showResultDialog(), animOn() ? 520 : 30);
  }

  // 'win' | 'loss' | 'draw' (vs computer, from the player's side) or 'white' | 'black' | 'draw'
  outcomeFor(st) {
    if (!st.winner) return 'draw';
    if (this.setup.mode === 'ai') return st.winner === this.human ? 'win' : 'loss';
    return st.winner === 'w' ? 'white' : 'black';
  }

  recordStats(st) {
    this.statsRecorded = true;
    if (this.setup.mode === 'ai') {
      const s = this.stats.ai[this.setup.level];
      if (!st.winner) s.d++;
      else if (st.winner === this.human) s.w++;
      else s.l++;
    } else if (this.setup.mode === 'two') {
      const s = this.stats.two;
      s.games++;
      if (!st.winner) s.d++;
      else s[st.winner]++;
    } else return;
    this.ctx.storage.set('stats', this.stats).catch(() => {});
  }

  // ------------------------------------------------------------ clocks
  clockReset() {
    clearInterval(this.ticker);
    this.ticker = null;
    const tc = this.setup.mode === 'analysis' ? null : TIME_CONTROLS[this.setup.time];
    this.clock = tc ? { on: true, base: tc[0] * 1000, inc: tc[1] * 1000, w: tc[0] * 1000, b: tc[0] * 1000, running: null, last: 0 } : { on: false };
  }

  clockLeft(c) {
    const k = this.clock;
    if (!k.on) return Infinity;
    let v = k[c];
    if (k.running === c) v -= performance.now() - k.last;
    return Math.max(0, v);
  }

  clockStart(c) {
    const k = this.clock;
    if (!k.on) return;
    k.running = c;
    k.last = performance.now();
    this.ensureTicker();
  }

  clockStop() {
    const k = this.clock;
    if (!k.on || !k.running) return;
    k[k.running] = this.clockLeft(k.running);
    k.running = null;
  }

  clockOnMove(color) {
    const k = this.clock;
    if (!k.on || this.result) return;
    if (k.running === color) {
      k[color] = this.clockLeft(color);
      k[color] += k.inc;
    }
    this.clockStart(other(color));
  }

  ensureTicker() {
    if (this.ticker || !this.clock.on) return;
    this.ticker = setInterval(() => this.tick(), 100);
  }

  tick() {
    const k = this.clock;
    if (!k.on || !k.running) {
      this.renderClocks();
      return;
    }
    const c = k.running;
    if (this.clockLeft(c) <= 0) {
      k[c] = 0;
      k.running = null;
      this.renderClocks();
      this.flag(c);
      return;
    }
    this.renderClocks();
  }

  flag(c) {
    if (this.result) return;
    this.board.cancelPromotion();
    const opp = other(c);
    const canMate = sideCanMate(this.game.pos, opp);
    this.endGame(canMate ? { winner: opp, reason: 'timeout', loser: c, result: opp === 'w' ? '1-0' : '0-1' } : { winner: null, reason: 'timeoutDraw', loser: c, result: '1/2-1/2' });
  }

  // ------------------------------------------------------------ rendering
  render({ move = null, animate = true } = {}) {
    if (!this.root) return;
    const pos = this.positionAt(this.view);
    const hist = this.game.history({ verbose: true });
    const last = this.view > 0 ? hist[this.view - 1] : null;
    const pieces = new Map();
    for (const sq of SQUARES) {
      const p = pos.board[sq];
      if (p) pieces.set(sqName(sq), (colorOf(p) ? 'b' : 'w') + ' PNBRQK'[typeOf(p)]);
    }
    const check = pos.inCheck() ? sqName(pos.kings[pos.turn]) : null;
    this.board.setPosition({ pieces, lastMove: last ? { from: last.from, to: last.to } : null, check }, { move, animate });
    this.board.setInteractive(this.canInteract());
    this.root.dataset.mode = this.setup.mode;
    this.root.classList.toggle('reviewing', !this.liveAtView());
    this.root.classList.toggle('over', !!this.result);
    this.renderPlayers();
    this.renderStatus();
    this.renderMoves();
    this.renderToolbar();
    this.renderAnalysis();
  }

  positionAt(k) {
    const pos = Position.fromFen(this.game.startFen);
    const hist = this.game.history({ verbose: true });
    for (let i = 0; i < k && i < hist.length; i++) pos.make(hist[i].move);
    return pos;
  }

  sideName(c) {
    return this.t(c === 'w' ? 'side.white' : 'side.black');
  }

  // SAN with the piece letters of the UI language (French: R D T F C) for text shown or spoken;
  // PGN and the move list (figurines) keep the standard notation.
  localSan(san) {
    const s = String(san || '');
    const letter = (c) => this.t(`pieces.key_${c.toLowerCase()}`) || c;
    return s.replace(/^[KQRBN]/, letter).replace(/=([QRBN])/, (_, c) => `=${letter(c)}`);
  }

  // "12. Nf3" / "12… Nc6" for the move at index idx of the history
  moveLabel(idx, hist = this.game.history({ verbose: true }), start = Position.fromFen(this.game.startFen)) {
    const v = hist[idx];
    if (!v) return '';
    const plies = idx + (start.turn === 1 ? 1 : 0);
    const num = start.fullmove + Math.floor(plies / 2);
    return `${num}${v.color === 'w' ? '.' : '…'} ${this.localSan(v.san)}`;
  }

  // Keyboard play: say which square the cursor is on and what stands there.
  announceSquare(sq) {
    if (!this.srEl) return;
    const pos = this.positionAt(this.view);
    const p = pos.board[sqIndex(sq)];
    let text = p ? `${sq}, ${this.t(`pieceName.${colorOf(p) ? 'b' : 'w'}${' pnbrqk'[typeOf(p)]}`)}` : `${sq}, ${this.t('announce.empty')}`;
    const sel = this.board.selected;
    if (sel === sq) text += `, ${this.t('announce.selected', { count: new Set(this.board.targets.map((x) => x.to)).size })}`;
    else if (sel && this.board.targets.some((x) => x.to === sq)) text += `, ${this.t('announce.target')}`;
    this.srEl.textContent = text;
  }

  playerName(c) {
    const { t } = this;
    if (this.setup.mode === 'ai') return c === this.human ? t('player.you') : t('player.computer');
    return this.sideName(c);
  }

  renderPlayers() {
    if (!this.cards) return;
    const { t, ctx } = this;
    const topColor = this.flipped ? 'w' : 'b';
    const hist = this.game.history({ verbose: true }).slice(0, this.view);
    const capturedBy = { w: [], b: [] };
    for (const v of hist) if (v.captured) capturedBy[v.color].push(v.captured);
    const pos = this.positionAt(this.view);
    const mat = { w: 0, b: 0 };
    for (const sq of SQUARES) {
      const p = pos.board[sq];
      if (p) mat[colorOf(p) ? 'b' : 'w'] += PIECE_VALUE[' pnbrqk'[typeOf(p)]];
    }
    const turn = pos.turn ? 'b' : 'w';
    for (const [slot, c] of [
      ['top', topColor],
      ['bottom', other(topColor)],
    ]) {
      const card = this.cards[slot];
      const isAi = this.setup.mode === 'ai' && c !== this.human;
      card.el.dataset.color = c;
      card.el.classList.toggle('active', !this.result && turn === c && this.liveAtView());
      card.el.classList.toggle('is-ai', isAi);
      card.el.classList.toggle('thinking', isAi && this.thinking);
      card.el.classList.toggle('winner', !!this.result && this.result.winner === c);
      const avatarKey = `${isAi}${c}`;
      if (card.avatarKey !== avatarKey) {
        card.avatarKey = avatarKey;
        ctx.ui.clear(card.avatar);
        card.avatar.appendChild(ctx.icon(isAi ? 'bot' : 'person', { size: 20, filled: true }));
        card.avatar.appendChild(this.h('span', { class: 'cx-avatar-badge', dataset: { color: c }, title: this.sideName(c) }));
      }
      card.name.textContent = this.playerName(c);
      card.sub.textContent = this.setup.mode === 'ai' ? (isAi ? t(`level.${this.setup.level}`) : this.sideName(c)) : '';
      card.sub.hidden = !card.sub.textContent;
      // captured pieces (the opponent's pieces this side took), grouped and ordered by value;
      // rebuilt only when they change, and only the newly captured piece pops in
      const list = capturedBy[c].slice().sort((a, b) => CAPTURE_ORDER.indexOf(a) - CAPTURE_ORDER.indexOf(b));
      const capKey = c + list.join('');
      if (card.capKey !== capKey) {
        const before = card.capKey && card.capKey[0] === c ? [...card.capKey.slice(1)] : null;
        card.capKey = capKey;
        ctx.ui.clear(card.captured);
        const seen = {};
        let prev = null;
        for (const p of list) {
          seen[p] = (seen[p] || 0) + 1;
          const isNew = before && seen[p] > before.filter((x) => x === p).length;
          card.captured.appendChild(
            this.h('span', {
              class: ['cx-cap', prev === p && 'same', isNew && 'new'],
              style: { backgroundImage: `url("${pieceUrl(other(c) + p.toUpperCase())}")` },
              title: t(`pieces.${pieceKey(p)}`),
            }),
          );
          prev = p;
        }
      }
      const d = mat[c] - mat[other(c)];
      card.diff.textContent = d > 0 ? `+${d}` : '';
      card.thinking.hidden = !(isAi && this.thinking);
      card.clock.hidden = !this.clock.on;
      card.el.classList.toggle('has-clock', this.clock.on);
      card.color = c;
    }
    this.renderClocks();
  }

  renderClocks() {
    if (!this.cards || !this.clock.on) return;
    for (const slot of ['top', 'bottom']) {
      const card = this.cards[slot];
      const c = card.color;
      if (!c) continue;
      const ms = this.clockLeft(c);
      card.clockTime.textContent = formatClock(ms);
      card.clock.classList.toggle('running', this.clock.running === c && !this.result);
      card.clock.classList.toggle('low', ms < 20000);
      card.clock.classList.toggle('flagged', ms <= 0);
      card.clock.setAttribute('aria-label', this.t('clock.aria', { side: this.sideName(c), time: formatClock(ms) }));
    }
  }

  renderStatus() {
    if (!this.statusText) return;
    const { t, ctx } = this;
    const g = this.game;
    const analysis = this.setup.mode === 'analysis';
    const live = this.liveAtView();
    // the analysis board describes the position on screen, a finished one included (a loaded game
    // that ends in mate has no "result" of its own)
    const over = analysis ? this.gameAtView().status() : this.result;
    const reviewing = () => (this.view === 0 ? t('status.reviewStart') : t('status.reviewing', { move: this.moveLabel(this.view - 1) }));
    let text;
    let icon = null;
    let tone = '';
    if (over) {
      const kind = this.outcomeFor(over);
      text = `${this.resultTitle(over)} · ${this.reasonText(over)}`;
      icon = kind === 'draw' ? 'handshake' : kind === 'loss' ? 'flag' : 'trophy';
      tone = kind === 'loss' ? 'bad' : kind === 'draw' ? '' : 'good';
    } else if (!live && !analysis) {
      text = reviewing();
      icon = 'history';
    } else if (this.thinking) {
      text = t('status.thinking');
      icon = 'spinner';
    } else if (this.hintBusy) {
      text = t('status.hintThinking');
      icon = 'spinner';
    } else if (this.hint) {
      text = t('status.hint', { san: this.localSan(this.hint.san) });
      icon = 'lightbulb';
      tone = 'accent';
    } else if (!live) {
      text = reviewing();
      icon = 'history';
    } else {
      const turn = g.turn();
      if (this.setup.mode === 'ai') text = turn === this.human ? t('status.yourTurn') : t('status.computerTurn');
      else text = t(turn === 'w' ? 'status.whiteToMove' : 'status.blackToMove');
      if (g.inCheck()) {
        text = `${t('status.check')} ${text}`;
        tone = 'bad';
      }
      icon = 'circle';
    }
    this.statusText.textContent = text;
    this.statusText.parentElement.dataset.tone = tone;
    ctx.ui.clear(this.statusIcon);
    if (icon === 'spinner') this.statusIcon.appendChild(this.h('span', { class: 'spinner small' }));
    else if (icon === 'circle') this.statusIcon.appendChild(this.h('span', { class: 'cx-turn-dot', dataset: { color: this.game.turn() } }));
    else if (icon) this.statusIcon.appendChild(ctx.icon(icon, { size: 16, filled: true }));
    const parts = [t(`mode.${this.setup.mode}`)];
    if (this.setup.mode === 'ai') parts.push(t(`level.${this.setup.level}`));
    if (this.clock.on) parts.push(t(`time.${this.setup.time}`));
    if (this.setup.mode === 'analysis' && this.fileName) parts.push(this.fileName);
    this.modeText.textContent = parts.join(' · ');
    this.backBtn.hidden = this.liveAtView() || this.setup.mode === 'analysis';
  }

  resultTitle(r) {
    const { t } = this;
    const kind = this.outcomeFor(r);
    if (kind === 'win') return t('result.youWon');
    if (kind === 'loss') return t('result.youLost');
    if (kind === 'draw') return t('result.draw');
    return t(kind === 'white' ? 'result.whiteWins' : 'result.blackWins');
  }

  reasonText(r) {
    const { t } = this;
    const loser = r.loser ? this.sideName(r.loser) : r.winner ? this.sideName(other(r.winner)) : '';
    if (this.setup.mode === 'ai' && r.loser) {
      if (r.reason === 'resign') return r.loser === this.human ? t('reason.youResigned') : t('reason.resign', { side: loser });
      if (r.reason === 'timeout' || r.reason === 'timeoutDraw') {
        const who = r.loser === this.human ? t('reason.youTimeout') : t('reason.computerTimeout');
        return r.reason === 'timeout' ? who : `${who} · ${t('reason.insufficientShort')}`;
      }
    }
    return t(`reason.${r.reason}`, { side: loser });
  }

  renderMoves() {
    const { h, t } = this;
    const el = this.movesEl;
    if (!el) return;
    const hadFocus = el.contains(document.activeElement);
    this.ctx.ui.clear(el);
    const hist = this.game.history({ verbose: true });
    if (!hist.length) {
      el.appendChild(h('div', { class: 'cx-moves-empty caption text-2' }, t(this.game.turn() === 'b' ? 'moves.emptyBlack' : 'moves.empty')));
      return;
    }
    const start = Position.fromFen(this.game.startFen);
    let num = start.fullmove;
    let i = 0;
    let current = null;
    const mk = (idx) => {
      const v = hist[idx];
      const b = h(
        'button',
        {
          class: ['cx-mv', idx + 1 === this.view && 'current'],
          role: 'listitem',
          'aria-label': this.moveLabel(idx, hist, start),
          'aria-current': idx + 1 === this.view ? 'true' : null,
          dataset: { ply: String(idx + 1) },
          onclick: () => this.goto(idx + 1),
        },
        sanNodes(h, v.san, v.color),
      );
      if (idx + 1 === this.view) current = b;
      return b;
    };
    if (start.turn === 1) {
      el.appendChild(h('div', { class: 'cx-mrow' }, h('span', { class: 'cx-mnum' }, `${num}.`), h('span', { class: 'cx-mv cx-mv-empty' }, '…'), mk(0)));
      i = 1;
      num++;
    }
    for (; i < hist.length; i += 2) {
      el.appendChild(h('div', { class: 'cx-mrow' }, h('span', { class: 'cx-mnum' }, `${num}.`), mk(i), i + 1 < hist.length ? mk(i + 1) : h('span', { class: 'cx-mv cx-mv-empty' })));
      num++;
    }
    if (this.result) el.appendChild(h('div', { class: 'cx-mresult' }, this.result.result.replace(/1\/2/g, '½')));
    // re-rendering removed the focused move button: keep keyboard focus in the list
    if (hadFocus) (current || el).focus({ preventScroll: true });
    if (current) current.scrollIntoView({ block: 'nearest' });
    else if (this.view === this.game.length) el.scrollTop = el.scrollHeight;
    else el.scrollTop = 0;
  }

  renderToolbar() {
    if (!this.btnUndo) return;
    const mode = this.setup.mode;
    const live = this.liveAtView();
    this.btnUndo.disabled = !this.canUndo();
    const hintable =
      !this.resultBlocks() &&
      !this.hintBusy &&
      !this.drawBusy &&
      (live || mode === 'analysis') &&
      !(mode === 'ai' && (this.thinking || this.game.turn() !== this.human)) &&
      !this.gameAtView().status();
    this.btnHint.disabled = !hintable;
    this.btnHint.classList.toggle('busy', this.hintBusy);
    this.btnDraw.hidden = mode === 'analysis';
    this.btnResign.hidden = mode === 'analysis';
    this.btnDraw.disabled = !!this.result || this.drawBusy || (mode === 'ai' && this.thinking) || this.game.length < 1;
    this.btnResign.disabled = !!this.result;
    const n = this.game.length;
    this.navBtns.first.disabled = this.view === 0;
    this.navBtns.prev.disabled = this.view === 0;
    this.navBtns.next.disabled = this.view >= n;
    this.navBtns.last.disabled = this.view >= n;
  }

  renderAnalysis() {
    if (!this.analysisText) return;
    const on = this.setup.mode === 'analysis';
    this.evalBar.hidden = !on;
    this.analysisText.hidden = !on;
    if (!on) return;
    const a = this.analysis;
    const { t } = this;
    if (!a || a.pending) this.analysisText.textContent = t('analysis.thinking');
    else if (a.failed) this.analysisText.textContent = t('analysis.failed');
    else if (a.over) this.analysisText.textContent = t('analysis.over');
    else {
      const score = formatScore(a);
      this.analysisText.textContent = t('analysis.line', { score, depth: a.depth, line: a.pv.slice(0, 6).map((x) => this.localSan(x)).join(' ') });
    }
    this.renderEval();
  }

  renderEval() {
    if (!this.evalBar || this.evalBar.hidden) return;
    const a = this.analysis;
    let frac = 0.5;
    let label = '';
    let short = '';
    if (a && !a.pending && !a.over && !a.failed) {
      if (a.mate != null) frac = a.mate > 0 ? 1 : 0;
      else frac = 1 / (1 + Math.exp(-a.score / 260));
      label = formatScore(a);
      short = a.mate != null ? `M${Math.abs(a.mate)}` : Math.abs(a.score) >= 1000 ? String(Math.round(Math.abs(a.score) / 100)) : (Math.abs(a.score) / 100).toFixed(1);
    } else if (a?.over) {
      const st = this.gameAtView().status();
      frac = !st?.winner ? 0.5 : st.winner === 'w' ? 1 : 0;
      label = st?.result || '';
      short = label.replace(/1\/2/g, '½');
    }
    frac = Math.max(0.03, Math.min(0.97, frac));
    this.evalBar.classList.toggle('flipped', this.flipped);
    this.evalFill.style.transform = `scaleY(${frac})`;
    this.evalText.textContent = short;
    this.evalText.classList.toggle('dark-side', frac < 0.5);
    this.evalBar.setAttribute('aria-valuenow', a?.score != null ? String(Math.round(a.score / 10) / 10) : '0');
    this.evalBar.setAttribute('aria-valuetext', label);
  }

  showToast(text, { spinner = false, sticky = false } = {}) {
    if (!this.toastEl) return;
    clearTimeout(this._toastTimer);
    this.ctx.ui.clear(this.toastEl);
    if (spinner) this.toastEl.appendChild(this.h('span', { class: 'spinner small' }));
    this.toastEl.appendChild(this.h('span', null, text));
    this.toastEl.classList.add('show');
    if (!sticky) this._toastTimer = setTimeout(() => this.hideToast(), 4200);
  }

  hideToast() {
    clearTimeout(this._toastTimer);
    this.toastEl?.classList.remove('show');
  }

  // ------------------------------------------------------------ dialogs
  // Every dialog of the app goes through here:
  //  - Enter on a focused secondary button (Review, Copy PGN, Cancel…) activates that button, as in
  //    Windows; the UI kit alone would answer Enter with the primary button wherever the focus is;
  //  - a result dialog that comes up while another dialog is open is shown once that one closes.
  async modal(opts) {
    this._modals = (this._modals || 0) + 1;
    try {
      return await this.ctx.ui.dialog({
        parent: this.ctx.win,
        className: 'cx-dialog',
        ...opts,
        onOpen: (dlg, done) => {
          dlg.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return;
            const b = e.target.closest?.('button');
            if (b && !b.classList.contains('primary') && b.getAttribute('role') !== 'radio') e.stopPropagation();
          });
          opts.onOpen?.(dlg, done);
        },
      });
    } finally {
      this._modals--;
      setTimeout(() => this.flushResult(), 0);
    }
  }

  async confirmDialog(message, { title, okLabel, cancelLabel } = {}) {
    const v = await this.modal({
      title,
      body: message,
      buttons: [
        { label: okLabel || this.t('common.ok'), value: true, primary: true },
        { label: cancelLabel || this.t('common.cancel'), value: false },
      ],
    });
    return v === true;
  }

  flushResult() {
    if (!this._resultPending || this._modals || this.disposed) return;
    this._resultPending = false;
    if (this.result) this.showResultDialog();
  }

  async openNewGameDialog() {
    const { h, t, ctx } = this;
    const { icon, ui } = ctx;
    if (this._modals || this.disposed) return;
    const s = { ...this.setup };
    let autoFlip = this.prefs.autoFlip;
    const refs = {};
    const modeCard = (id, ic) =>
      h(
        'button',
        {
          class: ['cx-mode-card', s.mode === id && 'selected'],
          role: 'radio',
          'aria-checked': String(s.mode === id),
          dataset: { mode: id },
          onclick: () => {
            s.mode = id;
            sync();
          },
        },
        h('span', { class: 'cx-mode-icon' }, icon(ic, { size: 24 })),
        h('span', { class: 'cx-mode-title' }, t(`mode.${id}`)),
        h('span', { class: 'cx-mode-desc caption text-2' }, t(`modeDesc.${id}`)),
      );
    refs.modes = h('div', { class: 'cx-mode-cards', role: 'radiogroup', 'aria-label': t('newGame.mode') }, modeCard('ai', 'bot'), modeCard('two', 'people'), modeCard('analysis', 'board'));
    const sideBtn = (id) =>
      h(
        'button',
        { class: ['cx-side', s.side === id && 'selected'], role: 'radio', 'aria-checked': String(s.side === id), dataset: { side: id }, onclick: () => ((s.side = id), sync()) },
        id === 'random'
          ? h('span', { class: 'cx-side-img cx-side-random' }, h('span', { style: { backgroundImage: `url("${pieceUrl('wK')}")` } }), h('span', { style: { backgroundImage: `url("${pieceUrl('bK')}")` } }))
          : h('span', { class: 'cx-side-img', style: { backgroundImage: `url("${pieceUrl(`${id}K`)}")` } }),
        h('span', null, t(`sideChoice.${id}`)),
      );
    refs.sides = h('div', { class: 'cx-sides', role: 'radiogroup', 'aria-label': t('newGame.playAs') }, sideBtn('w'), sideBtn('random'), sideBtn('b'));
    refs.levels = h(
      'div',
      { class: 'cx-levels', role: 'radiogroup', 'aria-label': t('newGame.level') },
      LEVEL_IDS.map((l, i) =>
        h(
          'button',
          { class: ['cx-level', s.level === l && 'selected'], role: 'radio', 'aria-checked': String(s.level === l), dataset: { level: l }, onclick: () => ((s.level = l), sync()) },
          h('span', { class: 'cx-level-bars' }, [0, 1, 2, 3, 4].map((k) => h('i', { class: k <= i ? 'on' : '' }))),
          h('span', { class: 'cx-level-name' }, t(`level.${l}`)),
        ),
      ),
    );
    refs.levelDesc = h('div', { class: 'cx-level-desc caption text-2' });
    refs.times = h(
      'div',
      { class: 'cx-times', role: 'radiogroup', 'aria-label': t('newGame.time') },
      Object.keys(TIME_CONTROLS).map((id) =>
        h('button', { class: ['cx-time', s.time === id && 'selected'], role: 'radio', 'aria-checked': String(s.time === id), dataset: { time: id }, onclick: () => ((s.time = id), sync()) }, t(`time.${id}`)),
      ),
    );
    refs.autoFlip = ui.toggle({ checked: autoFlip, label: t('newGame.autoFlip'), onchange: (v) => (autoFlip = v) });
    const section = (label, ...content) => h('div', { class: 'cx-ng-section' }, h('div', { class: 'cx-ng-label' }, label), ...content);
    refs.secSide = section(t('newGame.playAs'), refs.sides);
    refs.secLevel = section(t('newGame.level'), refs.levels, refs.levelDesc);
    refs.secTime = section(t('newGame.time'), refs.times);
    refs.secFlip = h('div', { class: 'cx-ng-section' }, refs.autoFlip);
    const body = h('div', { class: 'cx-newgame' }, section(t('newGame.mode'), refs.modes), refs.secSide, refs.secLevel, refs.secTime, refs.secFlip);
    // radio groups: one tab stop per group (the checked item), arrows move inside
    const mark = (container, attr, value) => {
      for (const b of container.children) {
        const on = b.dataset[attr] === value;
        b.classList.toggle('selected', on);
        b.setAttribute('aria-checked', String(on));
        b.tabIndex = on ? 0 : -1;
      }
    };
    const sync = () => {
      mark(refs.modes, 'mode', s.mode);
      mark(refs.sides, 'side', s.side);
      mark(refs.levels, 'level', s.level);
      mark(refs.times, 'time', s.time);
      refs.levelDesc.textContent = t(`levelDesc.${s.level}`);
      refs.secSide.hidden = s.mode !== 'ai';
      refs.secLevel.hidden = s.mode !== 'ai';
      refs.secTime.hidden = s.mode === 'analysis';
      refs.secFlip.hidden = s.mode !== 'two';
    };
    sync();
    // arrow keys move inside each radio group
    body.addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
      const group = e.target.closest('[role=radiogroup]');
      if (!group) return;
      e.preventDefault();
      e.stopPropagation();
      const items = [...group.children].filter((x) => x.getAttribute('role') === 'radio');
      const i = items.indexOf(e.target);
      const n = items[(i + (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length];
      n.focus();
      n.click();
    });
    const v = await this.modal({
      title: t('newGame.title'),
      body,
      width: 560,
      className: 'cx-dialog cx-newgame-dialog',
      buttons: [
        { label: t('newGame.start'), value: 'start', primary: true },
        { label: t('common.cancel'), value: null },
      ],
      // the dialog would focus the first input (the hidden "rotate" toggle): start on the mode cards
      onOpen: () => setTimeout(() => refs.modes.querySelector('.selected')?.focus(), 50),
    });
    if (this.disposed) return;
    if (v === 'start') {
      this.prefs.autoFlip = autoFlip;
      this.newGame(s);
    }
    this.root?.focus({ preventScroll: true });
  }

  async showResultDialog() {
    if (!this.result || this.disposed) return;
    if (this._modals) {
      this._resultPending = true; // shown when the open dialog closes
      return;
    }
    const { h, t, ctx } = this;
    const r = this.result;
    const kind = this.outcomeFor(r);
    const ic = kind === 'draw' ? 'handshake' : kind === 'loss' ? 'flag' : 'trophy';
    const copyBtn = h('button', { class: 'btn subtle small cx-res-copy', onclick: () => this.copyPgn(copyBtn) }, ctx.icon('copy', { size: 14 }), h('span', null, t('menu.copyPgn')));
    const saveBtn = h('button', { class: 'btn subtle small', onclick: () => this.savePgn() }, ctx.icon('save', { size: 14 }), h('span', null, t('menu.savePgn')));
    let record = null;
    if (this.setup.mode === 'ai') {
      const s = this.stats.ai[this.setup.level];
      record = h('div', { class: 'cx-res-record caption text-2' }, t('result.record', { level: t(`level.${this.setup.level}`), w: s.w, l: s.l, d: s.d }));
    }
    const body = h(
      'div',
      { class: ['cx-result', `is-${kind}`] },
      h('div', { class: 'cx-res-icon' }, ctx.icon(ic, { size: 30, filled: true })),
      h('div', { class: 'cx-res-title' }, this.resultTitle(r)),
      h('div', { class: 'cx-res-reason' }, this.reasonText(r)),
      h('div', { class: 'cx-res-score' }, h('span', { class: 'cx-res-side' }, this.playerName('w')), h('b', null, r.result.replace('1/2', '½').replace('1/2', '½')), h('span', { class: 'cx-res-side' }, this.playerName('b'))),
      record,
      h('div', { class: 'cx-res-actions' }, copyBtn, saveBtn),
    );
    const v = await this.modal({
      body,
      width: 420,
      className: 'cx-dialog cx-result-dialog',
      buttons: [
        { label: t('result.playAgain'), value: 'again', primary: true },
        { label: t('result.newGame'), value: 'new' },
        { label: t('result.review'), value: null },
      ],
    });
    if (this.disposed) return;
    if (v === 'again') this.newGame(this.setup);
    else if (v === 'new') this.openNewGameDialog();
    else this.root?.focus({ preventScroll: true });
  }

  async openImportDialog() {
    const { h, t } = this;
    const area = h('textarea', { class: 'textarea cx-import-text', rows: 7, spellcheck: false, placeholder: t('import.placeholder') });
    const err = h('div', { class: 'field-hint cx-import-err', role: 'alert' });
    const body = h('div', { class: 'cx-import' }, h('div', { class: 'caption text-2' }, t('import.help')), area, err);
    const v = await this.modal({
      title: t('import.title'),
      body,
      width: 520,
      buttons: [
        { label: t('import.load'), value: 'load', primary: true },
        { label: t('common.cancel'), value: null },
      ],
      onOpen: (dlg) => {
        setTimeout(() => area.focus(), 40);
        // a FEN or PGN already on the clipboard is filled in
        this.ctx.api
          .invoke('clipboard:readText')
          .then((clip) => {
            const c = String(clip || '').trim();
            if (!c || area.value || c.length > 200000) return;
            if (!validateFen(c) || /^\s*\[\w+\s+"/.test(c) || /^\s*1\.\s*[a-hNBRQKO]/.test(c)) {
              area.value = c;
              area.select();
            }
          })
          .catch(() => {});
        dlg._validate = () => {
          try {
            this.loadText(area.value);
            return true;
          } catch (e) {
            err.textContent = e.message;
            area.classList.add('invalid');
            return false;
          }
        };
      },
    });
    if (v === 'load') this.showToast(t('import.loaded'));
    this.root?.focus({ preventScroll: true });
  }

  async openStatsDialog() {
    const { h, t, ctx } = this;
    const pct = new Intl.NumberFormat(ctx.i18n.locale || ctx.lang, { style: 'percent', maximumFractionDigits: 0 });
    const rows = LEVEL_IDS.map((l) => {
      const s = this.stats.ai[l];
      const n = s.w + s.l + s.d;
      return h(
        'tr',
        null,
        h('th', { scope: 'row' }, t(`level.${l}`)),
        h('td', null, String(s.w)),
        h('td', null, String(s.l)),
        h('td', null, String(s.d)),
        h('td', null, n ? pct.format(s.w / n) : '—'),
      );
    });
    const two = this.stats.two;
    const table = () =>
      h(
        'table',
        { class: 'cx-stats' },
        h('thead', null, h('tr', null, h('th', null, t('stats.level')), h('th', null, t('stats.won')), h('th', null, t('stats.lost')), h('th', null, t('stats.drawn')), h('th', null, t('stats.rate')))),
        h('tbody', null, rows),
      );
    const body = h(
      'div',
      { class: 'cx-stats-body' },
      h('div', { class: 'cx-ng-label' }, t('stats.vsComputer')),
      table(),
      h('div', { class: 'cx-ng-label' }, t('stats.twoPlayers')),
      h('div', { class: 'caption text-2' }, t('stats.twoSummary', { games: two.games, w: two.w, b: two.b, d: two.d })),
    );
    const v = await this.modal({
      title: t('stats.title'),
      body,
      width: 460,
      buttons: [
        { label: t('common.close'), value: null, primary: true },
        { label: t('stats.reset'), value: 'reset' },
      ],
    });
    if (v === 'reset') {
      const ok = await this.confirmDialog(t('stats.resetConfirm'), { title: t('stats.title'), okLabel: t('stats.reset') });
      if (ok) {
        this.stats = emptyStats();
        await ctx.storage.set('stats', this.stats).catch(() => {});
        this.showToast(t('stats.resetDone'));
      }
    }
    this.root?.focus({ preventScroll: true });
  }

  async openShortcutsDialog() {
    const { h, t } = this;
    const rows = [
      ['←  →', t('keys.prevNext')],
      [`${t('keys.home')} / ↑`, t('nav.first')],
      [`${t('keys.end')} / ↓`, t('nav.last')],
      ['Ctrl+Z', t('tb.undo')],
      ['N', t('tb.newGame')],
      ['F', t('tb.flip')],
      ['H', t('tb.hint')],
      ['Ctrl+C', t('menu.copyPgn')],
      ['Ctrl+Shift+C', t('menu.copyFen')],
      ['Ctrl+O / Ctrl+S', `${t('menu.openPgn')} / ${t('menu.savePgn')}`],
      ['Tab → ' + t('keys.board'), t('keys.boardHelp')],
      [['q', 'r', 'b', 'n'].map((c) => t(`pieces.key_${c}`)).join(' '), t('keys.promo')],
    ];
    const body = h('div', { class: 'cx-keys' }, rows.map(([k, d]) => h('div', { class: 'cx-key-row' }, h('kbd', null, k), h('span', null, d))));
    await this.modal({ title: t('keys.title'), body, width: 480, buttons: [{ label: t('common.close'), value: true, primary: true }] });
    this.root?.focus({ preventScroll: true });
  }

  openMoreMenu(e) {
    const { t, ctx } = this;
    const p = this.prefs;
    const toggle = (key) => () => {
      p[key] = !p[key];
      this.savePrefs();
      this.applyPrefs();
      if (key === 'autoFlip' && this.setup.mode === 'two' && p.autoFlip) this.setFlipped(this.game.turn() === 'b');
    };
    ctx.ui.menu(e.currentTarget || e, [
      {
        label: t('menu.theme'),
        icon: 'color',
        submenu: THEMES.map((id) => ({
          label: t(`theme.${id}`),
          checked: p.theme === id,
          action: () => {
            p.theme = id;
            this.savePrefs();
            this.applyPrefs();
          },
        })),
      },
      { label: t('menu.coords'), checked: p.coords, action: toggle('coords') },
      { label: t('menu.legal'), checked: p.legal, action: toggle('legal') },
      { label: t('menu.autoQueen'), checked: p.autoQueen, action: toggle('autoQueen') },
      { label: t('menu.autoFlip'), checked: p.autoFlip, action: toggle('autoFlip') },
      { label: t('menu.sound'), checked: p.sound, action: toggle('sound') },
      '-',
      { label: t('menu.openPgn'), icon: 'folder_open', shortcut: 'Ctrl+O', action: () => this.openPgnDialog() },
      { label: t('menu.savePgn'), icon: 'save', shortcut: 'Ctrl+S', action: () => this.savePgn() },
      { label: t('menu.import'), icon: 'clipboard_paste', action: () => this.openImportDialog() },
      { label: t('menu.copyPgn'), icon: 'copy', shortcut: 'Ctrl+C', action: () => this.copyPgn() },
      { label: t('menu.copyFen'), icon: 'document_copy', shortcut: 'Ctrl+Shift+C', action: () => this.copyFen() },
      '-',
      { label: t('menu.stats'), icon: 'trophy', action: () => this.openStatsDialog() },
      { label: t('menu.shortcuts'), icon: 'keyboard', action: () => this.openShortcutsDialog() },
    ]);
  }

  // ------------------------------------------------------------ export / import
  pgnText() {
    const { t } = this;
    const name = (c) => {
      if (this.setup.mode === 'ai') return c === this.human ? this.ctx.env.user || t('player.you') : `Aurora Chess (${t(`level.${this.setup.level}`)})`;
      return this.headers[c === 'w' ? 'White' : 'Black'] || this.sideName(c);
    };
    const headers = { ...this.headers, White: name('w'), Black: name('b') };
    if (this.clock.on) headers.TimeControl = TIME_CONTROLS[this.setup.time].join('+');
    if (this.result) {
      headers.Result = this.result.result;
      headers.Termination = { timeout: 'time forfeit', timeoutDraw: 'time forfeit', resign: 'normal', agreement: 'normal' }[this.result.reason] || 'normal';
    }
    return this.game.pgn({ headers, result: this.result?.result || '*' });
  }

  async copyText(text, okMsg, btn) {
    try {
      await this.ctx.api.invoke('clipboard:writeText', text);
      this.showToast(okMsg);
      if (btn) {
        const label = btn.querySelector('span:last-child');
        const old = label?.textContent;
        if (label) label.textContent = this.t('copied');
        btn.classList.add('done');
        setTimeout(() => {
          if (label) label.textContent = old;
          btn.classList.remove('done');
        }, 1600);
      }
    } catch (err) {
      console.warn('[chess] clipboard:', err?.message);
      this.errorAlert(this.t('error.clipboard'));
    }
  }

  copyPgn(btn) {
    return this.copyText(this.pgnText(), this.t('toast.pgnCopied'), btn);
  }

  copyFen() {
    return this.copyText(this.gameAtView().fen(), this.t('toast.fenCopied'));
  }

  // Runs a file picker once at a time (Ctrl+S pressed twice must not stack two pickers).
  async pick(opts) {
    if (this._picking) return null;
    this._picking = true;
    this._modals = (this._modals || 0) + 1;
    try {
      return await this.ctx.ui.filePicker({ parent: this.ctx.win, ...opts });
    } catch (err) {
      console.warn('[chess] file picker:', err?.message);
      this.errorAlert(this.fsErrorText(err));
      return null;
    } finally {
      this._picking = false;
      this._modals--;
      setTimeout(() => this.flushResult(), 0);
    }
  }

  async savePgn() {
    const { ctx, t } = this;
    const d = new Date();
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const path = await this.pick({ mode: 'save', title: t('menu.savePgn'), filters: [{ name: t('file.pgn'), ext: ['.pgn'] }], name: this.fileName || `${t('file.defaultName')} ${stamp}.pgn` });
    if (!path || this.disposed) return;
    try {
      await ctx.api.invoke('fs:writeText', path, this.pgnText());
      this.fileName = path.split('/').pop();
      this.setWindowTitle();
      this.renderStatus();
      this.showToast(t('toast.saved', { name: this.fileName }));
    } catch (err) {
      this.errorAlert(t('error.save', { detail: this.fsErrorText(err) }));
    }
  }

  async openPgnDialog() {
    const { t } = this;
    const path = await this.pick({ mode: 'open', title: t('menu.openPgn'), filters: [{ name: t('file.pgn'), ext: ['.pgn'] }] });
    if (path && !this.disposed) await this.openPgnFile(path);
  }

  // ------------------------------------------------------------ keyboard
  onKey(e) {
    if (e.defaultPrevented) return;
    const tag = e.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (this.ctx.win.el.querySelector('.dialog-layer') || document.querySelector('.menu') || this.board.promoting) return;
    const k = e.key;
    const ctrl = e.ctrlKey || e.metaKey;
    let handled = true;
    if (ctrl && !e.shiftKey && k.toLowerCase() === 'z') this.undo();
    else if (ctrl && e.shiftKey && k.toLowerCase() === 'c') this.copyFen();
    else if (ctrl && !e.shiftKey && k.toLowerCase() === 'c') {
      if (String(window.getSelection?.() || '')) return;
      this.copyPgn();
    } else if (ctrl && k.toLowerCase() === 's') this.savePgn();
    else if (ctrl && k.toLowerCase() === 'o') this.openPgnDialog();
    else if (ctrl || e.altKey) handled = false;
    else if (k === 'ArrowLeft') this.goto(this.view - 1);
    else if (k === 'ArrowRight') this.goto(this.view + 1);
    else if (k === 'ArrowUp' || k === 'Home') this.goto(0);
    else if (k === 'ArrowDown' || k === 'End') this.goto(this.game.length);
    else if (k === 'f' || k === 'F') this.toggleFlip();
    else if (k === 'n' || k === 'N') this.openNewGameDialog();
    else if (k === 'h' || k === 'H') this.showHint();
    else if (k === 'Escape' && this.hint) {
      this.hint = null;
      this.board.setHint(null);
      this.renderStatus();
    } else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  // ------------------------------------------------------------ persistence
  savePrefs() {
    this.ctx.storage.set('prefs', this.prefs).catch(() => {});
  }

  snapshot() {
    const k = this.clock;
    return {
      v: 1,
      setup: this.setup,
      human: this.human,
      startFen: this.game.startFen,
      moves: this.game.history({ verbose: true }).map((v) => v.uci),
      clock: k.on ? { w: Math.round(this.clockLeft('w')), b: Math.round(this.clockLeft('b')) } : null,
      result: this.result,
      flipped: this.flipped,
      statsRecorded: this.statsRecorded,
      headers: this.headers,
      savedAt: Date.now(),
    };
  }

  save() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.saveNow(), 150);
  }

  saveNow() {
    clearTimeout(this._saveTimer);
    this.ctx.storage.set('game', this.snapshot()).catch(() => {});
  }

  // ------------------------------------------------------------ test hooks
  testApi() {
    return {
      state: () => ({
        fen: this.game.fen(),
        viewFen: this.gameAtView().fen(),
        view: this.view,
        length: this.game.length,
        history: this.game.history(),
        mode: this.setup.mode,
        level: this.setup.level,
        human: this.human,
        turn: this.game.turn(),
        thinking: this.thinking,
        result: this.result,
        flipped: this.flipped,
        hint: this.hint,
        clock: this.clock.on ? { w: this.clockLeft('w'), b: this.clockLeft('b'), running: this.clock.running } : null,
        boardSize: this.board.size,
        theme: this.prefs.theme,
        prefs: this.prefs,
        stats: this.stats,
        engineFailed: this.engine.failed,
        analysis: this.analysis,
      }),
      // Start a game from a crafted position: setup = { mode, side, level, time }
      setup: (fen, setup = {}) => {
        this.newGame({ ...this.setup, ...setup }, { silent: true, startFen: fen });
        return this.game.fen();
      },
      setTheme: (id) => {
        this.prefs.theme = id;
        this.applyPrefs();
      },
      pgn: () => this.pgnText(),
      setClock: (c, ms) => {
        this.clock[c] = ms;
        if (this.clock.running === c) this.clock.last = performance.now();
      },
    };
  }
}

// ---------------------------------------------------------------- helpers
// Stored data is untrusted: only own, known keys with the right types survive (a stored
// "constructor" time control or a truthy [] for a boolean must not leak through).
function sanitizeSetup(s) {
  const o = s && typeof s === 'object' ? s : {};
  const pick = (v, allowed, def) => (typeof v === 'string' && allowed.includes(v) ? v : def);
  return {
    mode: pick(o.mode, MODES, DEFAULT_SETUP.mode),
    side: pick(o.side, ['w', 'b', 'random'], DEFAULT_SETUP.side),
    level: pick(o.level, LEVEL_IDS, DEFAULT_SETUP.level),
    time: pick(o.time, Object.keys(TIME_CONTROLS), DEFAULT_SETUP.time),
  };
}

// PGN tags (from a file or the saved game): plain string values under simple names, bounded.
function sanitizeHeaders(hd) {
  const out = {};
  if (!hd || typeof hd !== 'object' || Array.isArray(hd)) return out;
  for (const [k, v] of Object.entries(hd).slice(0, 40)) {
    if (/^[A-Za-z0-9_]{1,40}$/.test(k) && typeof v === 'string' && !['__proto__', 'constructor', 'prototype'].includes(k)) out[k] = v.slice(0, 500);
  }
  return out;
}

function sanitizePrefs(p) {
  const o = p && typeof p === 'object' ? p : {};
  const out = { ...DEFAULT_PREFS, setup: sanitizeSetup(o.setup) };
  if (typeof o.theme === 'string' && THEMES.includes(o.theme)) out.theme = o.theme;
  for (const k of ['coords', 'legal', 'sound', 'autoQueen', 'autoFlip']) if (typeof o[k] === 'boolean') out[k] = o[k];
  return out;
}

function mergeStats(s) {
  const out = emptyStats();
  const count = (v) => {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n > 0 ? Math.min(n, 1e9) : 0;
  };
  for (const l of LEVEL_IDS) for (const k of ['w', 'l', 'd']) out.ai[l][k] = count(s?.ai?.[l]?.[k]);
  for (const k of ['games', 'w', 'b', 'd']) out.two[k] = count(s?.two?.[k]);
  return out;
}

function clampTime(v, base) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(n, base * 4)) : base;
}

function formatClock(ms) {
  if (ms === Infinity) return '';
  if (ms < 10000) return `0:0${(Math.max(0, ms) / 1000).toFixed(1)}`.replace(/^0:0(\d\d)/, '0:$1');
  const s = Math.ceil(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

function formatScore(a) {
  if (a.mate != null) return a.mate > 0 ? `M${a.mate}` : `-M${-a.mate}`;
  const v = a.score / 100;
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}`;
}

function pieceKey(p) {
  return { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' }[p];
}

function figurine(h, code) {
  const url = `url("${pieceUrl(code)}")`;
  return h('span', { class: 'cx-fig', style: { webkitMaskImage: url, maskImage: url }, 'aria-hidden': 'true' });
}

// SAN with figurines: piece letters become small piece glyphs (language independent).
function sanNodes(h, san, color) {
  const out = [];
  let rest = san;
  if (/^[KQRBN]/.test(rest)) {
    out.push(figurine(h, color + rest[0]));
    rest = rest.slice(1);
  }
  const m = /=([QRBN])/.exec(rest);
  if (m) {
    out.push(rest.slice(0, m.index + 1));
    out.push(figurine(h, color + m[1]));
    out.push(rest.slice(m.index + 2));
  } else out.push(rest);
  return out;
}

function moveAnim(v) {
  if (!v) return null;
  const m = { from: v.from, to: v.to };
  if (v.castle) {
    const rank = v.color === 'w' ? '1' : '8';
    m.rookFrom = (v.castle === 'k' ? 'h' : 'a') + rank;
    m.rookTo = (v.castle === 'k' ? 'f' : 'd') + rank;
  }
  return m;
}

function reverseAnim(m) {
  if (!m) return null;
  const r = { from: m.to, to: m.from };
  if (m.rookFrom) {
    r.rookFrom = m.rookTo;
    r.rookTo = m.rookFrom;
  }
  return r;
}

function pvToSan(game, pv) {
  const g = new Chess(game.startFen);
  for (const v of game.history({ verbose: true })) g.move(v.move);
  const out = [];
  for (const u of pv || []) {
    const v = g.move(u);
    if (!v) break;
    out.push(v.san);
  }
  return out;
}

// Could `color` still checkmate by any series of legal moves (FIDE 6.9: a player whose flag falls
// still draws when the opponent cannot mate)? Lone minor pieces can only mate with the help of
// the other side's own men blocking its king.
function sideCanMate(pos, color) {
  const c = color === 'w' ? 0 : 1;
  const mine = { n: 0, bl: 0, bd: 0 };
  const theirs = { pawns: 0, n: 0, bl: 0, bd: 0, rooks: 0, queens: 0 };
  for (const sq of SQUARES) {
    const p = pos.board[sq];
    if (!p) continue;
    const ty = typeOf(p);
    const light = ((sq >> 4) + (sq & 7)) % 2 === 0;
    if (colorOf(p) === c) {
      if (ty === 1 || ty === 4 || ty === 5) return true; // pawn, rook or queen
      if (ty === 2) mine.n++;
      else if (ty === 3) mine[light ? 'bl' : 'bd']++;
    } else if (ty === 1) theirs.pawns++;
    else if (ty === 2) theirs.n++;
    else if (ty === 3) theirs[light ? 'bl' : 'bd']++;
    else if (ty === 4) theirs.rooks++;
    else if (ty === 5) theirs.queens++;
  }
  const bishops = mine.bl + mine.bd;
  if (!mine.n && !bishops) return false; // bare king
  if (mine.n && bishops) return true;
  if (mine.n >= 2) return true;
  const blockers = theirs.pawns + theirs.n + theirs.bl + theirs.bd + theirs.rooks;
  if (mine.n === 1) return blockers > 0;
  // bishops only: one square colour unless the opponent has men that can stand on the other one
  if (mine.bl && mine.bd) return true;
  return theirs.pawns + theirs.n > 0 || (mine.bl ? theirs.bd : theirs.bl) > 0;
}
