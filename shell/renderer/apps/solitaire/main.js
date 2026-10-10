// Aurora Solitaire — Klondike with original card artwork.
// Game rules live in rules.mjs (pure, unit-tested from node); card art in cards.mjs.
// This module is the UI: layout, drag & drop, animations, keyboard play, dialogs, persistence.
import {
  Klondike,
  PILES,
  FOUNDATIONS,
  TABLEAU,
  SCORINGS,
  MAX_GAME,
  isTableau,
  isFoundation,
  suitOf,
  rankOf,
  parseCode,
  codeOf,
  randomGameNumber,
  emptyStats,
  recordResult,
  sanitizeStats,
  stateFrom,
} from './rules.mjs';
import { faceSvg, backSvg, svgUrl, BACKS, CARD_W, CARD_H } from './cards.mjs';

const DEFAULTS = { draw: 1, scoring: 'standard', timed: true, cumulative: false, bank: 0, back: 'aurora', table: 'felt', clickMove: true, sound: true };
const TABLES = ['felt', 'blue', 'aurora'];
const RATIO = CARD_H / CARD_W;
const MOVE_MS = 260;
const DEAL_STAGGER = 34;
const TOP_ROW = ['stock', 'waste', null, 'f0', 'f1', 'f2', 'f3'];
// Tightest tableau fan, in card heights: face-down edges, and face-up cards still showing the whole rank index.
const FD_MIN = 0.05;
const FU_MIN = 0.17;
// Vertical room planned for a column below its first card (in card heights) before the cards shrink.
const FAN_ROOM = 1.7;

/** Preferences read from storage, with anything unknown or malformed replaced by the default. */
function sanitizePrefs(p) {
  const o = { ...DEFAULTS };
  if (!p || typeof p !== 'object') return o;
  if (p.draw === 1 || p.draw === 3) o.draw = p.draw;
  if (SCORINGS.includes(p.scoring)) o.scoring = p.scoring;
  for (const k of ['timed', 'cumulative', 'clickMove', 'sound']) if (typeof p[k] === 'boolean') o[k] = p[k];
  if (typeof p.bank === 'number' && Number.isFinite(p.bank)) o.bank = Math.round(p.bank);
  if (BACKS.includes(p.back)) o.back = p.back;
  if (TABLES.includes(p.table)) o.table = p.table;
  return o;
}

function sanitizeAllStats(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return { draw1: sanitizeStats(src.draw1), draw3: sanitizeStats(src.draw3) };
}

const faceUrls = [];
const faceUrl = (c) => (faceUrls[c] ||= svgUrl(faceSvg(c)));
const animOn = () => document.documentElement.dataset.animations !== 'off';
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const tIdx = (id) => Number(id.slice(1));
const colOf = (pile) => (isTableau(pile) ? tIdx(pile) : pile === 'stock' ? 0 : pile === 'waste' ? 1 : 3 + tIdx(pile));

export default {
  async launch(ctx) {
    const app = new SolitaireApp(ctx);
    await app.init();
    return {
      onRelaunch: () => app.focusTable(),
      test: app.testApi(),
    };
  },
};

// ---------------------------------------------------------------- sound effects (WebAudio, no assets)
class Sfx {
  constructor(app) {
    this.app = app;
    this.ac = null;
    this.noise = null;
  }
  enabled() {
    return this.app.prefs.sound && this.app.ctx.settings.get('sounds') !== false;
  }
  _ctx() {
    if (!this.ac) {
      this.ac = new AudioContext();
      const len = Math.round(this.ac.sampleRate * 0.4);
      const buf = this.ac.createBuffer(1, len, this.ac.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.noise = buf;
    }
    if (this.ac.state === 'suspended') this.ac.resume().catch(() => {});
    return this.ac;
  }
  _burst(t0, { freq = 2000, q = 1, dur = 0.05, gain = 0.12, type = 'bandpass' }) {
    const ac = this.ac;
    const src = ac.createBufferSource();
    src.buffer = this.noise;
    const f = ac.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f).connect(g).connect(ac.destination);
    src.start(t0, Math.random() * 0.3);
    src.stop(t0 + dur + 0.02);
  }
  _tone(t0, freq, dur, gain, type = 'sine') {
    const ac = this.ac;
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(ac.destination);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }
  play(kind, delay = 0) {
    if (!this.enabled()) return;
    try {
      const ac = this._ctx();
      const t = ac.currentTime + 0.005 + delay / 1000;
      if (kind === 'place') {
        this._burst(t, { freq: 1500, q: 0.9, dur: 0.055, gain: 0.14 });
        this._burst(t, { freq: 380, q: 0.7, dur: 0.05, gain: 0.08, type: 'lowpass' });
      } else if (kind === 'flip') this._burst(t, { freq: 3000, q: 0.6, dur: 0.04, gain: 0.09, type: 'highpass' });
      else if (kind === 'shuffle') for (let i = 0; i < 12; i++) this._burst(t + i * 0.04, { freq: 2000 + Math.random() * 1200, q: 0.6, dur: 0.035, gain: 0.06 });
      else if (kind === 'error') this._tone(t, 185, 0.14, 0.07, 'triangle');
      else if (kind === 'hint') {
        this._tone(t, 880, 0.12, 0.04);
        this._tone(t + 0.07, 1174.7, 0.18, 0.035);
      } else if (kind === 'win') [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((f, i) => this._tone(t + i * 0.09, f, 0.6, 0.05));
    } catch {
      // audio is a nicety; never let it break the game
    }
  }
  dispose() {
    this.ac?.close().catch(() => {});
  }
}

// ---------------------------------------------------------------- the app
class SolitaireApp {
  constructor(ctx) {
    this.ctx = ctx;
    this.t = ctx.t;
    this.prefs = { ...DEFAULTS };
    this.stats = {};
    this.game = null;
    this.cards = [];
    this.slots = {};
    this.pos = [];
    this.L = null;
    this.busy = false;
    this.kb = false;
    this.cursor = { pile: 'stock', index: -1 };
    this.held = null;
    this.drag = null;
    this.press = null;
    this.lastTap = null;
    this.hintIdx = 0;
    this.binds = [];
    this.timers = new Set();
    this.modal = 0;
    this.disposed = false;
    this.cascading = false;
    this.autoToken = 0;
    this.sfx = new Sfx(this);
    this.saveTimer = null;
    this.saveErrorShown = false;
  }

  // ------------------------------------------------------------ lifecycle
  async init() {
    const { ctx } = this;
    this.build();
    let saved = null;
    try {
      const [prefs, stats, game] = await Promise.all([ctx.storage.get('prefs', null), ctx.storage.get('stats', null), ctx.storage.get('game', null)]);
      this.prefs = sanitizePrefs(prefs);
      this.stats = sanitizeAllStats(stats);
      if (game) {
        try {
          const g = Klondike.fromJSON(game);
          if (!g.s.won) saved = g;
        } catch (err) {
          console.warn('[solitaire] ignoring an unreadable saved game', err);
        }
      }
    } catch (err) {
      console.warn('[solitaire] could not read saved data', err);
    }
    this.applyLook();
    this.layout();
    if (saved) this.setGame(saved, { deal: false });
    else this.startGame(randomGameNumber());

    let last = performance.now();
    this.clock = setInterval(() => {
      const now = performance.now();
      const dt = now - last;
      last = now;
      if (this.paused() || !this.game) return;
      const before = Math.floor(this.game.s.elapsed / 1000);
      this.game.tick(dt);
      if (Math.floor(this.game.s.elapsed / 1000) !== before) this.updateStatus();
    }, 250);

    this.ro = new ResizeObserver(() => this.onResize());
    this.ro.observe(this.table);
    const offs = [
      ctx.settings.on('accent', () => this.applyLook()),
      ctx.settings.on('theme', () => this.applyLook()),
    ];
    ctx.onLangChange(() => this.relabel());
    ctx.win.on('focus', () => {
      if (!this.root.contains(document.activeElement) && !ctx.win.el.querySelector('.dialog-layer')) this.focusTable();
    });
    ctx.onClose(() => {
      this.disposed = true;
      clearInterval(this.clock);
      for (const id of this.timers) clearTimeout(id);
      cancelAnimationFrame(this.raf);
      this.ro.disconnect();
      offs.forEach((off) => off?.());
      this.flushSave();
      this.sfx.dispose();
    });
    setTimeout(() => this.focusTable(), 50);
    // Piles glide when the cards are rescaled, but not into their first position.
    requestAnimationFrame(() => requestAnimationFrame(() => this.table.classList.add('ready')));
  }

  later(fn, ms) {
    const id = setTimeout(() => {
      this.timers.delete(id);
      if (!this.disposed) fn();
    }, ms);
    this.timers.add(id);
    return id;
  }

  paused() {
    const w = this.ctx.win;
    // Also paused while the window sits on another virtual desktop, where nobody can be playing.
    const away = typeof w.isOnCurrentDesktop === 'function' && !w.isOnCurrentDesktop();
    return this.disposed || w.minimized || away || document.hidden || this.modal > 0 || this.cascading;
  }

  focusTable() {
    if (this.disposed || document.activeElement === this.table) return;
    this._progFocus = true;
    this.table.focus({ preventScroll: true });
    this._progFocus = false;
  }

  // ------------------------------------------------------------ i18n helpers
  bind(el, fn, attr = 'textContent') {
    const apply = () => {
      if (attr === 'textContent') el.textContent = fn();
      else el.setAttribute(attr, fn());
    };
    this.binds.push(apply);
    apply();
    return el;
  }

  relabel() {
    for (const fn of this.binds) fn();
    for (let c = 0; c < 52; c++) this.cards[c]._label = null;
    this.render({ animate: false });
    this.updateStatus();
    this.updateToolbar();
  }

  cardName(c) {
    const { t } = this;
    return t('cardName', { rank: t(`rank${rankOf(c)}`), suit: t(`suit${suitOf(c)}`) });
  }

  pileName(id) {
    const { t } = this;
    if (id === 'stock') return t('pile.stock');
    if (id === 'waste') return t('pile.waste');
    if (isFoundation(id)) return t('pile.foundation', { n: tIdx(id) + 1 });
    return t('pile.column', { n: tIdx(id) + 1 });
  }

  fmtTime(ms) {
    const sec = Math.floor(ms / 1000);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  }

  fmtScore(game = this.game) {
    const { i18n } = this.ctx;
    if (game.s.scoring === 'none') return '—';
    if (game.s.scoring === 'vegas') return i18n.formatNumber(game.score, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
    return i18n.formatNumber(game.score);
  }

  // ------------------------------------------------------------ DOM
  build() {
    const { h, icon, win } = this.ctx;
    const { t } = this;
    const tbBtn = (iconName, labelFn, tipFn, onclick, cls = 'subtle') => {
      const label = h('span', { class: 'sol-btn-label' });
      const b = h('button', { class: ['btn', cls, 'sol-tb-btn'], type: 'button', onclick }, icon(iconName), label);
      this.bind(label, labelFn);
      this.bind(b, tipFn, 'data-tip');
      this.bind(b, labelFn, 'aria-label');
      return b;
    };

    // Toolbar --------------------------------------------------------------
    const newLabel = h('span', { class: 'sol-btn-label' });
    this.btnNew = h('button', { class: 'btn sol-split-main', type: 'button', onclick: () => this.requestNewGame() }, icon('add'), newLabel);
    this.bind(newLabel, () => t('newGame'));
    this.bind(this.btnNew, () => `${t('newGame')} (F2)`, 'data-tip');
    this.bind(this.btnNew, () => t('newGame'), 'aria-label');
    this.btnGameMenu = h('button', { class: 'btn sol-split-more', type: 'button', 'aria-haspopup': 'menu', onclick: (e) => this.gameMenu(e) }, icon('chevron_down', { size: 12 }));
    this.bind(this.btnGameMenu, () => t('gameMenu'), 'aria-label');
    this.bind(this.btnGameMenu, () => t('gameMenu'), 'data-tip');
    this.btnUndo = tbBtn('arrow_undo', () => t('undo'), () => `${t('undo')} (${t('key.ctrl')}+Z)`, () => this.undo());
    this.btnHint = tbBtn('lightbulb', () => t('hint'), () => `${t('hint')} (H)`, () => this.hint());

    const stat = (key) => {
      const label = h('span', { class: 'sol-stat-label' });
      const value = h('span', { class: 'sol-stat-value' });
      this.bind(label, () => t(key));
      // Not a live region: the clock ticks every second. Moves are announced through this.live instead.
      return { el: h('div', { class: ['sol-stat', `sol-stat-${key}`] }, label, value), value };
    };
    this.stScore = stat('score');
    this.stTime = stat('time');
    this.stMoves = stat('moves');

    this.btnStats = tbBtn('trophy', () => t('statistics'), () => t('statistics'), () => this.showStats());
    this.btnHelp = h('button', { class: 'btn subtle icon-btn', type: 'button', onclick: () => this.showHelp() }, icon('question_circle'));
    this.bind(this.btnHelp, () => t('howTo'), 'data-tip');
    this.bind(this.btnHelp, () => t('howTo'), 'aria-label');
    this.btnSettings = h('button', { class: 'btn subtle icon-btn', type: 'button', onclick: () => this.showSettings() }, icon('settings'));
    this.bind(this.btnSettings, () => t('settings'), 'data-tip');
    this.bind(this.btnSettings, () => t('settings'), 'aria-label');

    this.toolbar = h(
      'div',
      { class: 'sol-toolbar', role: 'toolbar' },
      h('div', { class: 'sol-tb-group' }, h('div', { class: 'sol-split' }, this.btnNew, this.btnGameMenu), this.btnUndo, this.btnHint),
      h('div', { class: 'sol-stats' }, this.stScore.el, this.stTime.el, this.stMoves.el),
      h('div', { class: 'sol-tb-group sol-tb-end' }, this.btnStats, this.btnHelp, this.btnSettings),
    );
    this.bind(this.toolbar, () => t('toolbar'), 'aria-label');
    this.setupToolbarKeys();

    // Table ----------------------------------------------------------------
    this.table = h('div', { class: 'sol-table', tabindex: '0', role: 'application' });
    this.bind(this.table, () => t('table.label'), 'aria-label');
    this.help = h('div', { class: 'sol-sr', id: `${win.id}-sol-help` });
    this.bind(this.help, () => t('table.desc'));
    this.table.setAttribute('aria-describedby', this.help.id);

    for (const id of PILES) {
      const slot = h('div', { class: ['sol-slot', `sol-slot-${id === 'stock' ? 'stock' : id === 'waste' ? 'waste' : isFoundation(id) ? 'foundation' : 'tableau'}`], dataset: { pile: id } });
      if (isFoundation(id)) slot.appendChild(h('span', { class: 'sol-slot-letter', 'aria-hidden': 'true' }, 'A'));
      if (isTableau(id)) slot.appendChild(h('span', { class: 'sol-slot-letter', 'aria-hidden': 'true' }, 'K'));
      if (id === 'stock') {
        this.stockGlyph = h('span', { class: 'sol-slot-glyph', 'aria-hidden': 'true' });
        slot.appendChild(this.stockGlyph);
      }
      this.slots[id] = slot;
      this.table.appendChild(slot);
    }
    for (let c = 0; c < 52; c++) {
      const inner = h(
        'div',
        { class: 'sol-card-inner' },
        h('div', { class: 'sol-face sol-front', style: { backgroundImage: `url("${faceUrl(c)}")` } }),
        h('div', { class: 'sol-face sol-back' }),
      );
      const el = h('div', { class: 'sol-card down', dataset: { id: String(c), code: codeOf(c) }, role: 'img' }, inner);
      el._inner = inner;
      el._down = true;
      this.cards[c] = el;
      this.table.appendChild(el);
    }
    this.cursorEl = h('div', { class: 'sol-cursor', 'aria-hidden': 'true' });
    this.table.appendChild(this.cursorEl);

    this.gameNoBtn = h('button', { class: 'sol-gameno', type: 'button', onclick: () => this.promptGameNumber() });
    this.bind(this.gameNoBtn, () => t('playNumber'), 'data-tip');
    this.modeEl = h('span', { class: 'sol-mode' });
    this.footer = h('div', { class: 'sol-footer' }, this.gameNoBtn, this.modeEl);
    this.table.appendChild(this.footer);

    const autoLabel = h('span');
    this.autoBtn = h('button', { class: 'btn primary sol-auto', type: 'button', hidden: true, onclick: () => this.autoComplete() }, icon('flash', { filled: true }), autoLabel);
    this.bind(autoLabel, () => t('autoComplete'));
    this.bind(this.autoBtn, () => `${t('autoComplete')} (A)`, 'data-tip');
    this.table.appendChild(this.autoBtn);

    const bannerText = h('span', { class: 'grow' });
    this.bind(bannerText, () => t('noMoves'));
    const bUndo = (this.bannerUndo = h('button', { class: 'btn', type: 'button', onclick: () => this.undo() }));
    this.bind(bUndo, () => t('undo'));
    const bNew = h('button', { class: 'btn primary', type: 'button', onclick: () => this.requestNewGame() });
    this.bind(bNew, () => t('newGame'));
    const bClose = h('button', { class: 'btn subtle icon-btn', type: 'button', onclick: () => this.hideBanner(true) }, icon('dismiss'));
    this.bind(bClose, () => this.t('common.close'), 'aria-label');
    this.banner = h('div', { class: 'sol-banner', role: 'alert', hidden: true }, icon('info', { filled: true }), bannerText, bUndo, bNew, bClose);
    this.table.appendChild(this.banner);

    this.canvas = h('canvas', { class: 'sol-cascade', 'aria-hidden': 'true' });
    this.skipHint = h('div', { class: 'sol-skip', hidden: true });
    this.bind(this.skipHint, () => t('win.skip'));
    this.table.append(this.canvas, this.skipHint);

    this.live = h('div', { class: 'sol-sr', 'aria-live': 'polite', 'aria-atomic': 'true' });
    this.root = h('div', { class: 'sol' }, this.toolbar, this.table, this.help, this.live);
    win.body.appendChild(this.root);

    this.table.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.table.addEventListener('pointermove', (e) => this.onPointerMove(e));
    this.table.addEventListener('pointerup', (e) => this.onPointerUp(e));
    this.table.addEventListener('pointercancel', (e) => this.onPointerUp(e, true));
    this.table.addEventListener('lostpointercapture', (e) => this.onPointerUp(e, true));
    // Right-click plays every available card to the foundations (as in classic Windows Solitaire).
    this.table.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!e.target.closest('button, .sol-banner')) this.sendHome();
    });
    this.table.addEventListener('focus', () => {
      // Show the selection cursor only when the table was reached with the keyboard.
      if (!this._progFocus && this.table.matches(':focus-visible')) this.setKb(true);
    });
    this.table.addEventListener('blur', () => this.positionCursor());
    this.root.addEventListener('keydown', (e) => this.onKey(e));
  }

  /** ARIA toolbar: one Tab stop, arrow keys / Home / End move between the buttons. */
  setupToolbarKeys() {
    const all = () => [...this.toolbar.querySelectorAll('button')];
    const usable = () => all().filter((b) => !b.disabled && b.getClientRects().length);
    this.setToolbarStop = (btn) => {
      for (const b of all()) b.tabIndex = b === btn ? 0 : -1;
    };
    this.toolbar.addEventListener('focusin', (e) => {
      const b = e.target.closest('button');
      if (b) this.setToolbarStop(b);
    });
    this.toolbar.addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key) || e.altKey || e.ctrlKey) return;
      const list = usable();
      const i = list.indexOf(document.activeElement);
      if (i < 0 || !list.length) return;
      e.preventDefault();
      const j = e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + list.length) % list.length;
      list[j].focus();
    });
    this.setToolbarStop(this.btnNew);
  }

  applyLook(p = this.prefs) {
    const accent = this.ctx.settings.get('accent') || '#0078d4';
    const back = BACKS.includes(p.back) ? p.back : 'aurora';
    const key = `${back}|${accent}`;
    if (this._backKey !== key) {
      this._backKey = key;
      this.table.style.setProperty('--sol-back', `url("${svgUrl(backSvg(back, accent))}")`);
    }
    this.table.dataset.bg = TABLES.includes(p.table) ? p.table : 'felt';
  }

  // ------------------------------------------------------------ layout
  layout() {
    const W = this.table.clientWidth;
    const H = this.table.clientHeight;
    if (!W || !H) return false;
    const padX = clamp(W * 0.03, 10, 40);
    const padTop = clamp(H * 0.035, 10, 28);
    const padBottom = clamp(H * 0.055, 28, 44);
    const byW = (W - 2 * padX) / (7 + 6 * 0.16);
    const room = H - padTop - padBottom;
    const byH = room / (RATIO * (2.2 + FAN_ROOM));
    // A very long column would have to squeeze its fan until the rank indices overlap: shrink the
    // cards instead (top row + gap + first card + tightest readable fan must fit).
    const span = this.longestSpan();
    const fit = span > FAN_ROOM ? span : 0;
    const byCol = fit ? Math.min((room - 2) / (2.2 + fit), (room - 12) / (2 + fit)) / RATIO : Infinity;
    const cw = Math.max(34, Math.floor(Math.min(byW, byH, byCol)));
    const ch = Math.round(cw * RATIO);
    const gap = Math.max(4, Math.min((W - 2 * padX - 7 * cw) / 6, cw * 0.42));
    const field = 7 * cw + 6 * gap;
    const x0 = Math.round((W - field) / 2);
    const col = Array.from({ length: 7 }, (_, i) => Math.round(x0 + i * (cw + gap)));
    const top = Math.round(padTop);
    const tab = Math.round(top + ch + Math.max(10, ch * 0.2));
    this.L = {
      W,
      H,
      cw,
      ch,
      col,
      top,
      tab,
      bottom: H - padBottom,
      fd: ch * 0.1,
      fu: ch * 0.26,
      wasteDx: Math.round(cw * 0.24),
      depth: Math.max(1, Math.round(cw * 0.016)),
      fit,
    };
    const st = this.table.style;
    st.setProperty('--cw', `${cw}px`);
    st.setProperty('--ch', `${ch}px`);
    st.setProperty('--field-x', `${x0}px`);
    st.setProperty('--field-w', `${field}px`);
    for (const id of PILES) {
      const x = col[colOf(id)];
      const y = isTableau(id) ? tab : top;
      this.slots[id].style.transform = `translate(${x}px, ${y}px)`;
    }
    return true;
  }

  /** Height of the tallest tableau column below its first card at the tightest fan, in card heights. */
  longestSpan() {
    const s = this.game?.s;
    if (!s) return 0;
    let max = 0;
    s.t.forEach((col, i) => {
      if (col.length < 2) return;
      const nd = Math.min(s.hidden[i], col.length - 1);
      max = Math.max(max, nd * FD_MIN + (col.length - 1 - nd) * FU_MIN);
    });
    return max;
  }

  onResize() {
    if (!this.game) return;
    const prev = this.L;
    if (!this.layout()) return;
    if (prev && prev.W === this.L.W && prev.H === this.L.H) return;
    this.table.classList.add('sol-instant');
    if (this.cascading) this.stopCascade();
    this.render({ animate: false });
    if (this.drag) this.cancelDrag();
    cancelAnimationFrame(this._resizeRaf);
    this._resizeRaf = requestAnimationFrame(() => requestAnimationFrame(() => this.table.classList.remove('sol-instant')));
  }

  /** Fan offsets for a tableau column, squeezed so the column always fits the window. */
  fan(ti) {
    const L = this.L;
    const s = this.game.s;
    const n = s.t[ti].length;
    let fd = L.fd;
    let fu = L.fu;
    if (n <= 1) return { fd, fu };
    const avail = Math.max(0, L.bottom - L.tab - L.ch);
    const nd = Math.min(s.hidden[ti], n - 1);
    const nu = n - 1 - nd;
    if (nd * fd + nu * fu > avail) {
      if (nd) fd = Math.max(L.ch * FD_MIN, Math.min(fd, (avail - nu * fu) / nd));
      if (nu && nd * fd + nu * fu > avail) fu = Math.max(L.ch * FU_MIN, (avail - nd * fd) / nu);
    }
    return { fd, fu };
  }

  positions() {
    const L = this.L;
    const s = this.game.s;
    const pos = new Array(52);
    s.stock.forEach((c, i, a) => {
      const k = Math.min(2, Math.floor((a.length - 1 - i) / 8)) * L.depth;
      pos[c] = { x: L.col[0] + k, y: L.top + k, z: 10 + i, up: false, pile: 'stock', index: i };
    });
    const fan = s.draw === 3 ? clamp(Math.min(s.fan || 1, s.waste.length), 1, 3) : 1;
    s.waste.forEach((c, i, a) => {
      const k = Math.max(0, i - (a.length - fan));
      pos[c] = { x: L.col[1] + k * L.wasteDx, y: L.top, z: 100 + i, up: true, pile: 'waste', index: i };
    });
    s.f.forEach((p, fi) =>
      p.forEach((c, i) => {
        pos[c] = { x: L.col[3 + fi], y: L.top, z: 200 + i, up: true, pile: `f${fi}`, index: i };
      }),
    );
    s.t.forEach((p, ti) => {
      const { fd, fu } = this.fan(ti);
      let y = L.tab;
      p.forEach((c, i) => {
        pos[c] = { x: L.col[ti], y: Math.round(y), z: 300 + i, up: i >= s.hidden[ti], pile: `t${ti}`, index: i };
        y += i < s.hidden[ti] ? fd : fu;
      });
    });
    return pos;
  }

  // ------------------------------------------------------------ rendering
  render({ animate = true, delays = null, dealZ = null } = {}) {
    if (!this.L || !this.game) return;
    // Columns grew past (or shrank back within) the room planned for them: rescale the cards.
    const span = this.longestSpan();
    if ((span > FAN_ROOM ? span : 0) !== this.L.fit) this.layout();
    const pos = this.positions();
    this.pos = pos;
    const anim = animate && animOn();
    const held = this.heldSet();
    for (let c = 0; c < 52; c++) {
      const el = this.cards[c];
      const p = pos[c];
      if (this.drag?.set.has(c)) continue;
      const d = delays?.get(c) || 0;
      if (delays) {
        el.style.transitionDelay = d ? `${d}ms` : '';
        el._inner.style.transitionDelay = d ? `${d + 140}ms` : '';
      }
      const tr = `translate3d(${p.x}px, ${p.y}px, 0)`;
      const moved = el._tr !== tr;
      if (moved) {
        el.style.transform = tr;
        el._tr = tr;
      }
      const down = !p.up;
      if (el._down !== down) {
        el.classList.toggle('down', down);
        el._down = down;
      }
      const label = down ? this.t('faceDown') : this.cardName(c);
      if (el._label !== label) {
        el.setAttribute('aria-label', label);
        el._label = label;
      }
      el.classList.toggle('held', held.has(c));
      el._z = p.z;
      if (moved && anim) {
        el.style.zIndex = String(dealZ?.get(c) ?? 5000 + p.z);
        clearTimeout(el._zt);
        el._zt = setTimeout(() => {
          el._zt = null;
          el.style.zIndex = String(el._z);
        }, MOVE_MS + d + 60);
      } else if (!el._zt) el.style.zIndex = String(p.z);
    }
    // Cards hidden right under an identically placed card drop their shadow, so tall piles
    // (stock, waste, foundations) don't build up a dark rim.
    const g = this.game;
    for (const id of ['stock', 'waste', ...FOUNDATIONS]) {
      const p = g.pile(id);
      for (let i = 0; i < p.length; i++) {
        const a = pos[p[i]];
        const b = i < p.length - 1 ? pos[p[i + 1]] : null;
        this.cards[p[i]].classList.toggle('buried', !!b && a.x === b.x && a.y === b.y);
      }
    }
    for (const p of g.s.t) for (const c of p) this.cards[c].classList.remove('buried');
    this.renderStock();
    this.positionCursor();
  }

  renderStock() {
    const g = this.game;
    const { icon } = this.ctx;
    const state = g.s.stock.length ? 'cards' : g.canRecycle() ? 'recycle' : g.s.waste.length ? 'done' : 'empty';
    if (this._stockState === state) return;
    this._stockState = state;
    this.stockGlyph.replaceChildren(state === 'recycle' ? icon('arrow_counterclockwise') : state === 'done' ? icon('prohibited') : '');
    this.slots.stock.classList.toggle('can-recycle', state === 'recycle');
  }

  heldSet() {
    const set = new Set();
    if (!this.held) return set;
    const p = this.game.pile(this.held.pile);
    for (let i = this.held.index; i < p.length; i++) set.add(p[i]);
    return set;
  }

  updateStatus() {
    const g = this.game;
    if (!g) return;
    const { t } = this;
    this.stScore.value.textContent = this.fmtScore();
    this.stScore.el.hidden = g.s.scoring === 'none';
    this.stTime.value.textContent = this.fmtTime(g.s.elapsed);
    this.stMoves.value.textContent = this.ctx.i18n.formatNumber(g.s.moves);
    this.gameNoBtn.textContent = t('gameNo', { n: g.s.seed });
    const parts = [t(g.s.draw === 3 ? 'draw3' : 'draw1'), t(`scoring.${g.s.scoring}`)];
    if (g.s.scoring === 'vegas' && Number.isFinite(g.recyclesAllowed())) {
      parts.push(t('passOf', { n: Math.min(g.s.recycles + 1, g.recyclesAllowed() + 1), total: g.recyclesAllowed() + 1 }));
    }
    this.modeEl.textContent = parts.join(' · ');
  }

  updateToolbar() {
    const g = this.game;
    if (!g) return;
    this.btnUndo.disabled = !g.canUndo() || this.busy;
    this.bannerUndo.disabled = !g.canUndo();
    this.btnHint.disabled = g.s.won;
    // The toolbar's single Tab stop must never sit on a disabled button.
    if (this.toolbar.querySelector('button[tabindex="0"]:disabled')) this.setToolbarStop(this.btnNew);
    const auto = !this.busy && g.canAutoComplete();
    if (auto !== !this.autoBtn.hidden) {
      this.autoBtn.hidden = !auto;
      if (auto && animOn()) this.autoBtn.animate([{ opacity: 0, transform: 'translate(-50%, 12px)' }, { opacity: 1, transform: 'translate(-50%, 0)' }], { duration: 300, easing: 'cubic-bezier(0.1, 0.9, 0.2, 1)' });
    }
    this.autoAvailable = auto;
  }

  // ------------------------------------------------------------ game management
  gameOptions() {
    const p = this.prefs;
    return { draw: p.draw, scoring: p.scoring, timed: p.timed, bank: p.scoring === 'vegas' && p.cumulative ? p.bank || 0 : 0 };
  }

  startGame(seed, { animate = true, options } = {}) {
    const opts = { ...this.gameOptions(), ...(options || {}) };
    this.setGame(Klondike.deal(seed, opts), { deal: animate });
  }

  setGame(game, { deal = false } = {}) {
    this.cancelAnimations();
    this.game = game;
    this.held = null;
    this.hintIdx = 0;
    this.lastTap = null;
    this.clearHint();
    this.hideBanner();
    this.cursor = { pile: 'stock', index: -1 };
    for (const el of this.cards) el.style.visibility = '';
    // The card size depends on the longest column, so size the table for this game before showing it.
    this.table.classList.add('sol-instant');
    this.layout();
    if (deal && animOn() && this.L) this.dealAnimation();
    else {
      // A loaded / resumed game appears in place: no cards gliding across the table.
      this.render({ animate: false });
      void this.table.offsetWidth;
      this.table.classList.remove('sol-instant');
    }
    this.updateStatus();
    this.updateToolbar();
    this.scheduleSave();
    this.checkStuck();
  }

  dealAnimation() {
    const s = this.game.s;
    const L = this.L;
    this.table.classList.add('sol-instant');
    for (const el of this.cards) {
      const tr = `translate3d(${L.col[0]}px, ${L.top}px, 0)`;
      el.style.transform = tr;
      el._tr = tr;
      el.classList.add('down');
      el._down = true;
      el.classList.remove('held', 'hint', 'hint-dst');
    }
    void this.table.offsetWidth; // commit the stacked start position before animating
    this.table.classList.remove('sol-instant');
    const order = [];
    for (let row = 0; row < 7; row++) for (let col = row; col < 7; col++) order.push(s.t[col][row]);
    const delays = new Map(order.map((c, i) => [c, i * DEAL_STAGGER]));
    const dealZ = new Map(order.map((c, i) => [c, 6000 - i]));
    this.busy = true;
    this.sfx.play('shuffle');
    this.render({ delays, dealZ });
    const token = ++this.autoToken;
    this.later(() => {
      if (token !== this.autoToken) return;
      for (const el of this.cards) {
        el.style.transitionDelay = '';
        el._inner.style.transitionDelay = '';
      }
      this.busy = false;
      this.updateToolbar();
    }, order.length * DEAL_STAGGER + MOVE_MS + 220);
  }

  cancelAnimations() {
    this.autoToken++;
    if (this.cascading) this.stopCascade();
    cancelAnimationFrame(this.raf);
    this.canvas.classList.remove('show', 'fade');
    this.skipHint.hidden = true;
    this.busy = false;
    for (const el of this.cards) {
      el.style.transitionDelay = '';
      el._inner.style.transitionDelay = '';
    }
    if (this.drag) this.cancelDrag();
  }

  async requestNewGame({ seed, restart = false } = {}) {
    if (this.modal || this.disposed) return;
    const g = this.game;
    if (g && g.started && !g.s.won) {
      // Stop an auto-complete / send-home run: it must not keep playing under the question.
      if (this.busy) {
        this.autoToken++;
        this.busy = false;
        this.updateToolbar();
      }
      const ok = await this.confirm(restart ? 'confirmRestart' : 'confirmNew');
      if (!ok) return;
      this.recordLoss();
    }
    if (restart && g) {
      const s = g.s;
      this.startGame(s.seed, { options: { draw: s.draw, scoring: s.scoring, timed: s.timed } });
    } else this.startGame(seed ?? randomGameNumber());
    this.focusTable();
  }

  recordLoss() {
    const g = this.game;
    if (!g || !g.started || g.s.won) return;
    const key = `draw${g.s.draw}`;
    this.stats[key] = recordResult(this.stats[key], { won: false, time: g.s.elapsed, score: g.score, scoring: g.s.scoring });
    if (g.s.scoring === 'vegas' && this.prefs.cumulative) this.prefs.bank = g.score;
    this.persist('stats', this.stats);
    this.persist('prefs', this.prefs);
  }

  async confirm(prefix) {
    const { t } = this;
    const v = await this.dialog({
      title: t(`${prefix}.title`),
      body: t('confirmLoss'),
      buttons: [
        { label: t(`${prefix}.ok`), value: true, primary: true },
        { label: t('common.cancel'), value: false },
      ],
    });
    return v === true;
  }

  async dialog(opts) {
    this.modal++;
    try {
      return await this.ctx.ui.dialog({ ...opts, parent: this.ctx.win });
    } finally {
      this.modal--;
      setTimeout(() => {
        if (!this.modal && !this.ctx.win.el.querySelector('.dialog-layer:not(.closing)')) this.focusTable();
      }, 200);
    }
  }

  gameMenu(e) {
    const { t } = this;
    this.ctx.ui.menu(e.currentTarget, [
      { label: t('newGame'), icon: 'add', shortcut: 'F2', action: () => this.requestNewGame() },
      { label: t('restart'), icon: 'arrow_counterclockwise', shortcut: `${t('key.shift')}+F2`, action: () => this.requestNewGame({ restart: true }) },
      { label: t('playNumber'), icon: 'number_symbol', action: () => this.promptGameNumber() },
      '-',
      { label: t('statistics'), icon: 'trophy', action: () => this.showStats() },
      { label: t('settings'), icon: 'settings', action: () => this.showSettings() },
      { label: t('howTo'), icon: 'question_circle', action: () => this.showHelp() },
    ]);
  }

  async promptGameNumber() {
    if (this.modal) return;
    const { t, ctx } = this;
    this.modal++;
    let v;
    try {
      v = await ctx.ui.prompt({
        title: t('play.title'),
        label: t('play.label'),
        value: String(this.game.s.seed),
        okLabel: t('play.ok'),
        parent: ctx.win,
        validate: (x) => (/^\s*\d+\s*$/.test(x) && Number(x) >= 1 && Number(x) <= MAX_GAME ? null : t('play.invalid')),
      });
    } finally {
      this.modal--;
    }
    if (v == null) return this.focusTable();
    this.requestNewGame({ seed: Number(v.trim()) });
  }

  // ------------------------------------------------------------ actions
  afterAction(ev, { quiet = false } = {}) {
    if (!ev) return;
    this.hintIdx = 0;
    this.clearHint();
    this.hideBanner();
    this.render();
    this.updateStatus();
    this.updateToolbar();
    this.scheduleSave();
    const { t } = this;
    if (ev.type === 'draw') {
      this.sfx.play('flip');
      if (!quiet) this.say(t('a.drew', { cards: ev.cards.map((c) => this.cardName(c)).join(', ') }));
    } else if (ev.type === 'recycle') {
      this.sfx.play('shuffle');
      if (!quiet) this.say(t('a.recycled'));
    } else if (ev.type === 'move') {
      this.sfx.play('place', 90);
      if (ev.flipped != null) this.sfx.play('flip', 200);
      if (!quiet) {
        let msg = t('a.moved', { card: this.cardName(ev.cards[0]), pile: this.pileName(ev.to) });
        if (ev.flipped != null) msg += ` ${t('a.flipped', { card: this.cardName(ev.flipped) })}`;
        this.say(msg);
      }
    } else if (ev.type === 'undo') {
      this.sfx.play('place');
      if (!quiet) this.say(t('a.undone'));
    }
    if (ev.won) {
      // Book the win right away (a new game or closing the window may follow at once); only the
      // celebration waits for the last card to land.
      const info = this.recordWin();
      if (info) this.later(() => this.celebrate(info), MOVE_MS + 80);
    } else if (!quiet) this.checkStuck();
  }

  drawAction() {
    if (this.busy || this.modal) return;
    this.release();
    const ev = this.game.drawCards();
    if (!ev) {
      this.sfx.play('error');
      this.shake([this.slots.stock]);
      return;
    }
    this.afterAction(ev);
  }

  doMove(from, index, to) {
    const ev = this.game.move(from, index, to);
    if (!ev) return false;
    this.held = null;
    this.afterAction(ev);
    return true;
  }

  autoMove(pile, index) {
    const g = this.game;
    const p = g.pile(pile);
    const cards = p.slice(index);
    if (isFoundation(pile) || !g.canPick(pile, index)) {
      this.sfx.play('error');
      this.shake(cards.map((c) => this.cards[c]));
      return false;
    }
    const to = g.bestTarget(pile, index);
    if (!to || !this.doMove(pile, index, to)) {
      this.sfx.play('error');
      this.shake(cards.map((c) => this.cards[c]));
      this.say(this.t('a.noMove'));
      return false;
    }
    return true;
  }

  undo() {
    if (this.busy || this.modal || !this.game.canUndo()) return;
    this.release();
    if (this.game.undo()) this.afterAction({ type: 'undo' });
  }

  hold(pile, index) {
    this.held = { pile, index };
    this.render();
    const c = this.game.pile(pile)[index];
    this.say(this.t('a.picked', { card: this.cardName(c) }));
  }

  release() {
    if (!this.held) return;
    this.held = null;
    for (const el of this.cards) el.classList.remove('held');
  }

  dropHeld(to) {
    const { pile, index } = this.held;
    if (this.doMove(pile, index, to)) return true;
    this.sfx.play('error');
    this.say(this.t('a.illegal'));
    this.shake([...this.heldSet()].map((c) => this.cards[c]));
    return false;
  }

  shake(els) {
    if (!animOn()) return;
    for (const el of els) {
      const target = el._inner || el;
      target.animate(
        [{ translate: '0 0' }, { translate: '-5px 0' }, { translate: '5px 0' }, { translate: '-3px 0' }, { translate: '2px 0' }, { translate: '0 0' }],
        { duration: 320, easing: 'ease-out' },
      );
    }
  }

  // ------------------------------------------------------------ hints / stuck detection
  hint() {
    if (this.busy || this.modal || this.game.s.won) return;
    this.release();
    const hints = this.game.hints();
    if (!hints.length) {
      this.sfx.play('error');
      this.showBanner();
      this.say(this.t('noMoves'));
      return;
    }
    const hnt = hints[this.hintIdx % hints.length];
    this.hintIdx++;
    this.clearHint();
    const g = this.game;
    const src = [];
    const dst = [];
    if (hnt.draw) {
      src.push(g.s.stock.length ? this.cards[g.s.stock[g.s.stock.length - 1]] : this.slots.stock);
      this.say(this.t('a.hintDraw'));
    } else {
      const p = g.pile(hnt.from);
      for (let i = hnt.index; i < p.length; i++) src.push(this.cards[p[i]]);
      const top = g.top(hnt.to);
      dst.push(top != null ? this.cards[top] : this.slots[hnt.to]);
      this.say(this.t('a.hintMove', { card: this.cardName(p[hnt.index]), pile: this.pileName(hnt.to) }));
    }
    this.sfx.play('hint');
    for (const el of src) el.classList.add('hint');
    // The destination lights up a beat later, like Windows.
    this.hintEls = [...src, ...dst];
    this._hintT = this.later(() => dst.forEach((el) => el.classList.add('hint-dst')), animOn() ? 380 : 0);
    this._hintT2 = this.later(() => this.clearHint(), 2200);
  }

  clearHint() {
    clearTimeout(this._hintT);
    clearTimeout(this._hintT2);
    for (const el of this.hintEls || []) el.classList.remove('hint', 'hint-dst');
    this.hintEls = null;
  }

  checkStuck() {
    const g = this.game;
    if (!g || g.s.won || this.bannerDismissed === g) return;
    if (!g.hasMoves()) this.showBanner();
  }

  showBanner() {
    if (!this.banner.hidden) return;
    this.banner.hidden = false;
    if (animOn()) this.banner.animate([{ opacity: 0, transform: 'translate(-50%, 16px)' }, { opacity: 1, transform: 'translate(-50%, 0)' }], { duration: 280, easing: 'cubic-bezier(0.1, 0.9, 0.2, 1)' });
  }

  hideBanner(dismissed = false) {
    if (dismissed) this.bannerDismissed = this.game;
    this.banner.hidden = true;
  }

  // ------------------------------------------------------------ auto-complete & win
  async autoComplete() {
    if (this.busy || this.modal || !this.game.canAutoComplete()) return;
    this.release();
    this.clearHint();
    // The button hides itself; keep keyboard focus inside the game (Esc / any key skips the cascade).
    this.focusTable();
    this.busy = true;
    this.updateToolbar();
    const token = ++this.autoToken;
    const step = animOn() ? 110 : 0;
    try {
      while (!this.game.isWon()) {
        const s = this.game.autoStep();
        if (!s) break;
        const ev = this.game.applyStep(s);
        if (!ev) break;
        this.afterAction(ev, { quiet: true });
        if (step) await new Promise((r) => this.later(r, s.draw ? step * 2 : step));
        await this.whileModal();
        if (token !== this.autoToken || this.disposed) return;
      }
    } finally {
      if (token === this.autoToken) {
        this.busy = false;
        this.updateToolbar();
      }
    }
  }

  /** Resolves once no dialog of this app is open (automatic play waits instead of running underneath). */
  async whileModal() {
    while (this.modal && !this.disposed) await new Promise((r) => this.later(r, 120));
  }

  /** Move every card that can go to a foundation right now, one after another. */
  async sendHome() {
    if (this.busy || this.modal || this.cascading || this.game.s.won) return;
    this.release();
    this.clearHint();
    const token = ++this.autoToken;
    let moved = 0;
    this.busy = true;
    try {
      for (;;) {
        const g = this.game;
        let mv = null;
        for (const from of ['waste', ...TABLEAU]) {
          const p = g.pile(from);
          if (!p.length) continue;
          const c = p[p.length - 1];
          if (from !== 'waste' && p.length - 1 < g.s.hidden[tIdx(from)]) continue;
          const to = g.foundationFor(c);
          if (to) {
            mv = { from, index: p.length - 1, to };
            break;
          }
        }
        if (!mv) break;
        const ev = g.move(mv.from, mv.index, mv.to);
        if (!ev) break;
        moved++;
        this.afterAction(ev, { quiet: true });
        if (ev.won) break;
        if (animOn()) await new Promise((r) => this.later(r, 110));
        await this.whileModal();
        if (token !== this.autoToken || this.disposed) return;
      }
    } finally {
      if (token === this.autoToken) {
        this.busy = false;
        this.updateToolbar();
      }
    }
    if (!moved) this.sfx.play('error');
    else {
      this.say(this.t('a.sentHome', { count: moved }));
      if (!this.game.s.won) this.checkStuck();
    }
  }

  /** Record the won game in the statistics (once) and return what the win dialog shows. */
  recordWin() {
    const g = this.game;
    if (!g?.s.won || this._wonGame === g) return null;
    this._wonGame = g;
    this.release();
    this.clearHint();
    this.hideBanner();
    const s = g.s;
    const key = `draw${s.draw}`;
    const prev = sanitizeStats(this.stats[key]);
    const score = s.scoring === 'none' ? 0 : g.score;
    const info = {
      game: g,
      key,
      seed: s.seed,
      time: s.elapsed,
      moves: s.moves,
      score,
      bonus: s.bonus || 0,
      scoring: s.scoring,
      bestTime: !prev.bestTime || s.elapsed < prev.bestTime,
      bestScore: s.scoring === 'standard' && score > prev.bestScore,
    };
    this.stats[key] = recordResult(prev, { won: true, time: s.elapsed, score, scoring: s.scoring });
    if (s.scoring === 'vegas' && this.prefs.cumulative) this.prefs.bank = score;
    clearTimeout(this.saveTimer);
    this.persist('stats', this.stats);
    this.persist('prefs', this.prefs);
    this.persist('game', null);
    this.updateStatus();
    this.updateToolbar();
    this.sfx.play('win');
    this.say(this.t('win.title'));
    return info;
  }

  /** Bouncing-card cascade, then the "You won!" dialog. */
  async celebrate(info) {
    const g = info.game;
    // Never start the show under another dialog (statistics, settings…) opened meanwhile.
    await this.whileModal();
    if (this.disposed || this.game !== g) return;
    await this.cascade();
    if (this.disposed || this.game !== g) return;
    const v = await this.showWin(info, this.stats[info.key]);
    if (this.game !== g) return;
    if (v === 'new') this.startGame(randomGameNumber());
    else {
      this.canvas.classList.add('fade');
      for (const el of this.cards) el.style.visibility = '';
    }
    this.focusTable();
  }

  /** Windows-style bouncing card cascade drawn on a canvas that keeps every frame (trails). */
  async cascade() {
    if (!animOn() || !this.L) return;
    const L = this.L;
    const s = this.game.s;
    const dpr = window.devicePixelRatio || 1;
    let sprites;
    try {
      sprites = await this.sprites(L.cw, L.ch, dpr);
    } catch (err) {
      console.warn('[solitaire] win animation unavailable', err);
      return;
    }
    if (this.disposed || !s.won) return;
    const cv = this.canvas;
    cv.width = Math.round(L.W * dpr);
    cv.height = Math.round(L.H * dpr);
    cv.style.width = `${L.W}px`;
    cv.style.height = `${L.H}px`;
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, L.W, L.H);
    cv.classList.remove('fade');
    cv.classList.add('show');
    this.skipHint.hidden = false;
    const queue = [];
    for (let r = 12; r >= 0; r--) for (let f = 0; f < 4; f++) if (s.f[f][r] != null) queue.push({ c: s.f[f][r], f });
    const k = L.cw / 71;
    const floor = L.H;
    const active = [];
    this.cascading = true;
    return new Promise((resolve) => {
      let last = performance.now();
      let nextLaunch = 0;
      const finish = () => {
        if (!this.cascading) return;
        this.cascading = false;
        cancelAnimationFrame(this.raf);
        this.skipHint.hidden = true;
        this.stopCascade = () => {};
        resolve();
      };
      this.stopCascade = finish;
      const frame = (now) => {
        if (!this.cascading) return;
        const dt = Math.min(3, (now - last) / (1000 / 60));
        last = now;
        if (queue.length && now >= nextLaunch && active.length < 5) {
          const q = queue.shift();
          this.cards[q.c].style.visibility = 'hidden';
          const dir = Math.random() < 0.5 ? -1 : 1;
          active.push({ c: q.c, x: L.col[3 + q.f], y: L.top, vx: dir * (2.2 + Math.random() * 4) * k, vy: -(1 + Math.random() * 7) * k });
          nextLaunch = now + 150;
        }
        for (let i = active.length - 1; i >= 0; i--) {
          const p = active[i];
          p.vy += 0.42 * k * dt;
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          if (p.y + L.ch > floor) {
            p.y = floor - L.ch;
            p.vy = -p.vy * 0.76;
          }
          g.drawImage(sprites[p.c], p.x, p.y, L.cw, L.ch);
          if (p.x + L.cw < 0 || p.x > L.W) active.splice(i, 1);
        }
        if (!queue.length && !active.length) return finish();
        this.raf = requestAnimationFrame(frame);
      };
      this.raf = requestAnimationFrame(frame);
    });
  }

  stopCascade() {}

  async sprites(cw, ch, dpr) {
    const key = `${cw}x${ch}@${dpr}`;
    if (this._sprites?.key === key) return this._sprites.list;
    const list = await Promise.all(
      Array.from({ length: 52 }, async (_, c) => {
        const img = new Image();
        img.src = faceUrl(c);
        await img.decode();
        const cv = document.createElement('canvas');
        cv.width = Math.round(cw * dpr);
        cv.height = Math.round(ch * dpr);
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        return cv;
      }),
    );
    this._sprites = { key, list };
    return list;
  }

  showWin(info, st) {
    const { h, icon, i18n } = this.ctx;
    const { t } = this;
    const row = (label, value, badge) =>
      h('div', { class: 'sol-win-row' }, h('span', { class: 'text-2' }, label), h('span', { class: 'sol-win-val' }, badge ? h('span', { class: 'sol-badge' }, badge) : null, value));
    const scoreText = info.scoring === 'vegas' ? i18n.formatNumber(info.score, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }) : i18n.formatNumber(info.score);
    const rate = st.played ? i18n.formatNumber(st.won / st.played, { style: 'percent', maximumFractionDigits: 0 }) : '—';
    const body = h(
      'div',
      { class: 'sol-win' },
      h('div', { class: 'sol-win-hero' }, h('div', { class: 'sol-win-icon' }, icon('trophy', { size: 30, filled: true })), h('div', { class: 'text-2' }, t('win.subtitle', { n: info.seed }))),
      h(
        'div',
        { class: 'sol-win-rows' },
        info.scoring !== 'none' ? row(t('score'), scoreText, info.bestScore ? t('win.newBestScore') : null) : null,
        info.bonus ? row(t('win.bonus'), i18n.formatNumber(info.bonus)) : null,
        row(t('time'), this.fmtTime(info.time), info.bestTime ? t('win.newBestTime') : null),
        row(t('moves'), i18n.formatNumber(info.moves)),
      ),
      h('div', { class: 'caption text-2' }, t('win.summary', { count: st.won, won: i18n.formatNumber(st.won), played: i18n.formatNumber(st.played), pct: rate })),
    );
    return this.dialog({
      title: t('win.title'),
      body,
      className: 'sol-dialog sol-win-dialog',
      buttons: [
        { label: t('newGame'), value: 'new', primary: true },
        { label: t('common.close'), value: 'close' },
      ],
    });
  }

  // ------------------------------------------------------------ pointer input
  pointInTable(e) {
    const r = this.table.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  onPointerDown(e) {
    if (this.cascading) {
      e.preventDefault();
      this.stopCascade();
      return;
    }
    if (e.button !== 0 || this.drag || this.press) return;
    if (e.target.closest('button, .sol-banner')) return;
    e.preventDefault();
    this.focusTable();
    this.setKb(false);
    if (this.busy || this.modal || !this.game) return;
    this.clearHint();
    const pt = this.pointInTable(e);
    // Hit-test the cards where they belong, not where they are drawn: a card still gliding away
    // (say, just drawn from the stock) must not swallow a quick second click on its old pile.
    const hit = this.hitTest(pt);
    if (hit?.card != null) {
      const c = hit.card;
      const loc = this.game.locate(c);
      if (!loc) return;
      this.press = { c, loc, x0: pt.x, y0: pt.y, id: e.pointerId, pickable: this.game.canPick(loc.pile, loc.index) };
    } else if (hit?.slot) {
      this.press = { slot: hit.slot, x0: pt.x, y0: pt.y, id: e.pointerId };
    } else {
      this.release();
      this.render();
      return;
    }
    try {
      this.table.setPointerCapture(e.pointerId);
    } catch {
      // pointer already gone
    }
  }

  /** The topmost card (by its resting place) or the empty pile slot under a table point. */
  hitTest(pt) {
    const L = this.L;
    if (!L || !this.pos.length) return null;
    let best = null;
    for (let c = 0; c < 52; c++) {
      const p = this.pos[c];
      if (!p || pt.x < p.x || pt.x >= p.x + L.cw || pt.y < p.y || pt.y >= p.y + L.ch) continue;
      if (best == null || p.z > this.pos[best].z) best = c;
    }
    if (best != null) return { card: best };
    for (const id of PILES) {
      const x = L.col[colOf(id)];
      const y = isTableau(id) ? L.tab : L.top;
      if (pt.x >= x && pt.x < x + L.cw && pt.y >= y && pt.y < y + L.ch) return { slot: id };
    }
    return null;
  }

  onPointerMove(e) {
    const pr = this.press;
    if (!pr || e.pointerId !== pr.id) return;
    const pt = this.pointInTable(e);
    if (!this.drag) {
      if (!pr.pickable || Math.hypot(pt.x - pr.x0, pt.y - pr.y0) < 5) return;
      this.startDrag(pr);
    }
    const d = this.drag;
    d.dx = pt.x - pr.x0;
    d.dy = pt.y - pr.y0;
    d.px = pt.x;
    d.py = pt.y;
    for (const it of d.items) it.el.style.transform = `translate3d(${it.x + d.dx}px, ${it.y + d.dy}px, 0)`;
    this.markDropTarget();
  }

  startDrag(pr) {
    const { pile, index } = pr.loc;
    this.release();
    const p = this.game.pile(pile);
    const items = p.slice(index).map((c, i) => {
      const el = this.cards[c];
      clearTimeout(el._zt);
      el._zt = null;
      el.classList.add('dragging');
      el.style.zIndex = String(20000 + i);
      // Start from the card's resting place (where it was grabbed), even if it was still gliding there.
      return { c, el, x: this.pos[c].x, y: this.pos[c].y };
    });
    this.drag = { pile, index, items, set: new Set(items.map((i) => i.c)), dx: 0, dy: 0 };
    this.table.classList.add('is-dragging');
  }

  /** Best legal destination for the dragged run, by overlap with each pile (plus the pointer position). */
  dropTarget() {
    const d = this.drag;
    if (!d) return null;
    const L = this.L;
    const lead = { x: d.items[0].x + d.dx, y: d.items[0].y + d.dy, w: L.cw, h: L.ch };
    let best = null;
    let bestScore = 0;
    for (const to of this.game.legalTargets(d.pile, d.index)) {
      const r = this.pileRect(to);
      const ox = Math.min(lead.x + lead.w, r.x + r.w) - Math.max(lead.x, r.x);
      const oy = Math.min(lead.y + lead.h, r.y + r.h) - Math.max(lead.y, r.y);
      let score = ox > 0 && oy > 0 ? ox * oy : 0;
      if (d.px >= r.x && d.px <= r.x + r.w && d.py >= r.y && d.py <= r.y + r.h) score += L.cw * L.ch;
      if (score > bestScore) {
        bestScore = score;
        best = to;
      }
    }
    return best;
  }

  markDropTarget() {
    const to = this.dropTarget();
    if (to === this._dropMark) return;
    this.clearDropMark();
    this._dropMark = to;
    if (!to) return;
    const top = this.game.top(to);
    const el = top != null && !this.drag.set.has(top) ? this.cards[top] : this.slots[to];
    el.classList.add('drop-ok');
    this._dropEl = el;
  }

  clearDropMark() {
    this._dropEl?.classList.remove('drop-ok');
    this._dropEl = null;
    this._dropMark = null;
  }

  pileRect(id) {
    const L = this.L;
    const x = L.col[colOf(id)];
    if (isTableau(id)) {
      const p = this.game.pile(id);
      if (!p.length) return { x, y: L.tab, w: L.cw, h: L.ch };
      const top = this.pos[p[p.length - 1]];
      return { x, y: L.tab, w: L.cw, h: top.y + L.ch - L.tab };
    }
    return { x, y: L.top, w: L.cw, h: L.ch };
  }

  finishDrag(drop) {
    const d = this.drag;
    const to = drop ? this.dropTarget() : null;
    this.clearDropMark();
    this.drag = null;
    this.table.classList.remove('is-dragging');
    for (const it of d.items) it.el.classList.remove('dragging');
    for (const it of d.items) {
      // Force a fresh transition from wherever the card was dropped.
      it.el._tr = null;
      it.el.style.zIndex = String(20000);
    }
    if (to && this.doMove(d.pile, d.index, to)) return true;
    // Illegal drop: glide back home.
    this.render();
    return false;
  }

  cancelDrag() {
    if (!this.drag) return;
    this.finishDrag(false);
  }

  onPointerUp(e, cancelled = false) {
    const pr = this.press;
    if (!pr || e.pointerId !== pr.id) return;
    this.press = null;
    try {
      this.table.releasePointerCapture(e.pointerId);
    } catch {
      // already released
    }
    if (this.drag) {
      this.finishDrag(!cancelled);
      return;
    }
    if (!cancelled) this.tap(pr);
  }

  tap(pr) {
    const g = this.game;
    if (pr.slot) {
      if (pr.slot === 'stock') return this.drawAction();
      if (this.held) {
        if (this.held.pile !== pr.slot) this.dropHeld(pr.slot);
        else this.release();
      }
      return;
    }
    const loc = g.locate(pr.c);
    if (!loc) return;
    if (loc.pile === 'stock') return this.drawAction();
    const now = performance.now();
    const dbl = this.lastTap && this.lastTap.c === pr.c && now - this.lastTap.time < 420;
    this.lastTap = { c: pr.c, time: now };
    if (this.prefs.clickMove) {
      if (this.held) {
        if (this.held.pile === loc.pile) this.release();
        else this.dropHeld(loc.pile);
        return;
      }
      if (dbl) return; // the first click already moved it
      this.autoMove(loc.pile, loc.index);
      this.lastTap.time = performance.now();
      return;
    }
    // Click-to-select mode: click a card, then its destination. Double-click sends it home.
    if (dbl) {
      const heldBefore = this.held;
      this.release();
      if (heldBefore && heldBefore.pile === loc.pile) this.autoMove(heldBefore.pile, heldBefore.index);
      else this.autoMove(loc.pile, loc.index);
      this.lastTap = null;
      return;
    }
    if (this.held) {
      if (this.held.pile === loc.pile) {
        // Clicking the selection again clears it; clicking another card of the same run re-selects from there.
        const prev = this.held.index;
        this.release();
        if (loc.index !== prev && g.canPick(loc.pile, loc.index)) this.hold(loc.pile, loc.index);
        return;
      }
      if (g.canMove(this.held.pile, this.held.index, loc.pile)) {
        this.dropHeld(loc.pile);
        // A double-click on the destination must not also send the run it just built elsewhere.
        this.lastTap = null;
        return;
      }
      this.release();
    }
    if (g.canPick(loc.pile, loc.index) && !isFoundation(loc.pile)) this.hold(loc.pile, loc.index);
    else if (isFoundation(loc.pile) && g.canPick(loc.pile, loc.index)) this.hold(loc.pile, loc.index);
    else {
      this.sfx.play('error');
      this.shake([this.cards[pr.c]]);
    }
  }

  // ------------------------------------------------------------ keyboard
  setKb(on) {
    if (this.kb === on) return;
    this.kb = on;
    this.table.classList.toggle('kb', on);
    this.positionCursor();
  }

  cursorIndex() {
    const { pile, index } = this.cursor;
    const p = this.game.pile(pile);
    if (!p.length) return -1;
    if (isTableau(pile)) {
      const first = this.game.s.hidden[tIdx(pile)];
      return index < 0 ? p.length - 1 : clamp(index, Math.min(first, p.length - 1), p.length - 1);
    }
    return p.length - 1;
  }

  positionCursor() {
    const el = this.cursorEl;
    const show = this.kb && document.activeElement === this.table && this.game && this.L;
    el.classList.toggle('show', !!show);
    if (!show) return;
    const L = this.L;
    const { pile } = this.cursor;
    const p = this.game.pile(pile);
    const idx = this.cursorIndex();
    let x;
    let y;
    let hgt = L.ch;
    if (idx < 0) {
      x = L.col[colOf(pile)];
      y = isTableau(pile) ? L.tab : L.top;
    } else {
      const ps = this.pos[p[idx]];
      x = ps.x;
      y = ps.y;
      if (isTableau(pile)) hgt = this.pos[p[p.length - 1]].y + L.ch - y;
    }
    el.style.transform = `translate(${x - 4}px, ${y - 4}px)`;
    el.style.width = `${L.cw + 8}px`;
    el.style.height = `${hgt + 8}px`;
    el.classList.toggle('holding', !!this.held);
  }

  announceCursor() {
    const { pile } = this.cursor;
    const p = this.game.pile(pile);
    const idx = this.cursorIndex();
    let what;
    if (idx < 0) what = this.t('pile.empty');
    else if (pile === 'stock') what = this.t('pile.cards', { count: p.length });
    else what = this.cardName(p[idx]);
    this.say(this.t('a.focus', { pile: this.pileName(pile), card: what }));
  }

  moveCursor(dir) {
    if (!this.kb) {
      this.setKb(true);
      this.announceCursor();
      return;
    }
    const s = this.game.s;
    let { pile, index } = this.cursor;
    if (dir === 'left' || dir === 'right') {
      const step = dir === 'left' ? -1 : 1;
      if (isTableau(pile)) pile = `t${(tIdx(pile) + step + 7) % 7}`;
      else {
        const row = ['stock', 'waste', 'f0', 'f1', 'f2', 'f3'];
        pile = row[(row.indexOf(pile) + step + row.length) % row.length];
      }
      index = -1;
    } else if (dir === 'down') {
      if (!isTableau(pile)) {
        pile = `t${colOf(pile)}`;
        index = -1;
      } else if (!this.held) {
        const cur = this.cursorIndex();
        if (cur >= 0 && cur < s.t[tIdx(pile)].length - 1) index = cur + 1;
        else index = -1;
      }
    } else if (dir === 'up') {
      if (isTableau(pile)) {
        const ti = tIdx(pile);
        const cur = this.cursorIndex();
        if (!this.held && cur > s.hidden[ti] && cur > 0) index = cur - 1;
        else {
          pile = TOP_ROW[ti] || 'waste';
          index = -1;
        }
      }
    }
    this.cursor = { pile, index };
    this.positionCursor();
    this.announceCursor();
  }

  tabCursor(back) {
    if (!this.kb) {
      this.setKb(true);
      this.announceCursor();
      return true;
    }
    const j = PILES.indexOf(this.cursor.pile) + (back ? -1 : 1);
    if (j < 0 || j >= PILES.length) return false;
    this.cursor = { pile: PILES[j], index: -1 };
    this.positionCursor();
    this.announceCursor();
    return true;
  }

  activateCursor(shift) {
    if (this.busy) return;
    if (!this.kb) {
      // The first key press only reveals where the cursor is.
      this.setKb(true);
      this.announceCursor();
      return;
    }
    const { pile } = this.cursor;
    const g = this.game;
    const idx = this.cursorIndex();
    if (shift) {
      this.release();
      if (pile === 'stock') return this.drawAction();
      if (idx >= 0) this.autoMove(pile, idx);
      return;
    }
    if (this.held) {
      if (this.held.pile === pile) {
        this.release();
        this.positionCursor();
        this.say(this.t('a.released'));
        return;
      }
      if (this.dropHeld(pile)) this.cursor = { pile, index: -1 };
      this.positionCursor();
      return;
    }
    if (pile === 'stock') return this.drawAction();
    if (idx < 0 || !g.canPick(pile, idx)) {
      this.sfx.play('error');
      this.say(this.t('a.cantPick'));
      if (idx >= 0) this.shake([this.cards[g.pile(pile)[idx]]]);
      return;
    }
    this.hold(pile, idx);
  }

  onKey(e) {
    if (this.disposed || e.defaultPrevented) return;
    if (e.target.closest?.('input, textarea, select, .dialog-layer, .menu')) return;
    if (this.cascading) {
      if (!['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) {
        e.preventDefault();
        this.stopCascade();
      }
      return;
    }
    const key = e.key;
    const ctrl = e.ctrlKey || e.metaKey;
    if (this.drag) {
      // Esc drops the dragged cards back where they came from; other keys wait for the drop.
      e.preventDefault();
      if (key === 'Escape') {
        this.press = null;
        this.cancelDrag();
      }
      return;
    }
    if (ctrl && !e.altKey && !e.shiftKey && key.toLowerCase() === 'z') {
      e.preventDefault();
      this.undo();
      return;
    }
    if (key === 'F2' && !ctrl && !e.altKey) {
      e.preventDefault();
      if (e.shiftKey) this.requestNewGame({ restart: true });
      else this.requestNewGame();
      return;
    }
    if (ctrl || e.altKey || this.modal) return;
    const onTable = e.target === this.table;
    const lower = key.length === 1 ? key.toLowerCase() : key;
    if (lower === 'h') {
      e.preventDefault();
      this.hint();
      return;
    }
    if (lower === 'a') {
      e.preventDefault();
      if (this.autoAvailable) this.autoComplete();
      return;
    }
    if (lower === 'd') {
      e.preventDefault();
      this.drawAction();
      return;
    }
    if (!onTable) return;
    switch (key) {
      case 'ArrowLeft':
        this.moveCursor('left');
        break;
      case 'ArrowRight':
        this.moveCursor('right');
        break;
      case 'ArrowUp':
        this.moveCursor('up');
        break;
      case 'ArrowDown':
        this.moveCursor('down');
        break;
      case 'Tab':
        if (!this.tabCursor(e.shiftKey)) return;
        break;
      case 'Enter':
      case ' ':
        this.activateCursor(e.shiftKey);
        break;
      case 'Escape':
        if (!this.held) return;
        this.release();
        this.positionCursor();
        this.say(this.t('a.released'));
        break;
      default:
        if (/^[1-7]$/.test(key)) {
          const to = `t${Number(key) - 1}`;
          this.setKb(true);
          if (this.held) {
            if (this.dropHeld(to)) this.cursor = { pile: to, index: -1 };
          } else this.cursor = { pile: to, index: -1 };
          this.positionCursor();
          if (!this.held) this.announceCursor();
          break;
        }
        return;
    }
    e.preventDefault();
  }

  say(text) {
    this.live.textContent = '';
    clearTimeout(this._sayT);
    this._sayT = setTimeout(() => {
      this.live.textContent = text;
    }, 30);
  }

  // ------------------------------------------------------------ persistence
  persist(name, value) {
    this.ctx.storage.set(name, value).catch((err) => this.saveFailed(err));
  }

  saveFailed(err) {
    console.warn('[solitaire] save failed', err);
    if (this.saveErrorShown || this.disposed) return;
    this.saveErrorShown = true;
    const detail = err?.message || String(err);
    this.dialog({ title: this.t('error.title'), body: `${this.t('error.save')}\n\n${detail}`, buttons: [{ label: this.t('common.ok'), value: true, primary: true }] });
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flushSave(), 700);
  }

  flushSave() {
    clearTimeout(this.saveTimer);
    const g = this.game;
    if (!g) return;
    this.persist('game', g.s.won ? null : g.toJSON());
  }

  // ------------------------------------------------------------ dialogs
  async showStats(initialMode) {
    if (this.modal) return;
    const { h, ui, i18n } = this.ctx;
    const { t } = this;
    let mode = initialMode || `draw${this.game.s.draw}`;
    const grid = h('div', { class: 'sol-stats-grid' });
    const fill = () => {
      const st = sanitizeStats(this.stats[mode]);
      const pct = st.played ? i18n.formatNumber(st.won / st.played, { style: 'percent', maximumFractionDigits: 0 }) : '—';
      const streak = st.streak > 0 ? t('stats.wins', { count: st.streak }) : st.streak < 0 ? t('stats.losses', { count: -st.streak }) : '—';
      const items = [
        ['stats.played', i18n.formatNumber(st.played)],
        ['stats.won', i18n.formatNumber(st.won)],
        ['stats.rate', pct],
        ['stats.bestTime', st.bestTime ? this.fmtTime(st.bestTime) : '—'],
        ['stats.bestScore', st.bestScore ? i18n.formatNumber(st.bestScore) : '—'],
        ['stats.streak', streak],
        ['stats.longestWin', t('stats.wins', { count: st.longestWin })],
        ['stats.longestLoss', t('stats.losses', { count: st.longestLoss })],
      ];
      grid.replaceChildren(...items.map(([k, v]) => h('div', { class: 'sol-stat-card' }, h('div', { class: 'caption text-2' }, t(k)), h('div', { class: 'sol-stat-big' }, v))));
    };
    fill();
    const seg = ui.segmented({
      options: [
        { value: 'draw1', label: t('settings.draw1') },
        { value: 'draw3', label: t('settings.draw3') },
      ],
      value: mode,
      onchange: (v) => {
        mode = v;
        fill();
      },
    });
    const body = h('div', { class: 'sol-stats-body' }, seg, grid);
    const v = await this.dialog({
      title: t('stats.title'),
      body,
      // Tighter tiles when the window is short, so the eight figures fit without scrolling.
      className: ['sol-dialog', 'sol-stats-dialog', this.ctx.win.body.clientHeight < 600 && 'compact'].filter(Boolean).join(' '),
      width: 520,
      buttons: [
        { label: t('common.close'), value: 'close', primary: true },
        { label: t('stats.reset'), value: 'reset' },
      ],
    });
    if (v !== 'reset') return;
    const label = t(mode === 'draw3' ? 'settings.draw3' : 'settings.draw1');
    const ok = await this.dialog({
      title: t('stats.reset'),
      body: t('stats.resetConfirm', { mode: label }),
      buttons: [
        { label: t('stats.resetOk'), value: true, primary: true },
        { label: t('common.cancel'), value: false },
      ],
    });
    if (ok === true) {
      this.stats[mode] = emptyStats();
      this.persist('stats', this.stats);
    }
    this.showStats(mode);
  }

  async showSettings() {
    if (this.modal) return;
    const { h, ui } = this.ctx;
    const { t } = this;
    const before = { ...this.prefs };
    const draft = { ...this.prefs };
    const rowEl = (label, hint, control) =>
      h('div', { class: 'sol-set-row' }, h('div', { class: 'sol-set-text' }, h('div', null, label), hint ? h('div', { class: 'caption text-2' }, hint) : null), control);
    const drawSeg = ui.segmented({
      options: [
        { value: 1, label: t('settings.draw1') },
        { value: 3, label: t('settings.draw3') },
      ],
      value: draft.draw,
      onchange: (v) => (draft.draw = Number(v)),
    });
    const scoringSel = ui.select({ options: SCORINGS.map((s) => ({ value: s, label: t(`scoring.${s}`) })), value: draft.scoring, onchange: (v) => ((draft.scoring = v), sync()) });
    scoringSel.setAttribute('aria-label', t('settings.scoring'));
    const timed = ui.toggle({ checked: draft.timed, onchange: (v) => (draft.timed = v) });
    const cumulative = ui.toggle({ checked: draft.cumulative, onchange: (v) => (draft.cumulative = v) });
    const clickMove = ui.toggle({ checked: draft.clickMove, onchange: (v) => (draft.clickMove = v) });
    const sound = ui.toggle({ checked: draft.sound, onchange: (v) => (draft.sound = v) });
    timed.input.setAttribute('aria-label', t('settings.timed'));
    cumulative.input.setAttribute('aria-label', t('settings.cumulative'));
    clickMove.input.setAttribute('aria-label', t('settings.clickMove'));
    sound.input.setAttribute('aria-label', t('settings.sound'));
    const timedRow = rowEl(t('settings.timed'), t('settings.timedHint'), timed);
    const cumRow = rowEl(t('settings.cumulative'), t('settings.cumulativeHint'), cumulative);
    const sync = () => {
      timed.input.disabled = draft.scoring !== 'standard';
      timedRow.classList.toggle('disabled', draft.scoring !== 'standard');
      cumulative.input.disabled = draft.scoring !== 'vegas';
      cumRow.classList.toggle('disabled', draft.scoring !== 'vegas');
    };
    sync();
    const accent = this.ctx.settings.get('accent') || '#0078d4';
    const picker = (items, current, render, onpick, labelKey) => {
      const wrap = h('div', { class: 'sol-picker', role: 'radiogroup' });
      wrap.setAttribute('aria-label', t(labelKey));
      const btns = items.map((id) => {
        const b = h(
          'button',
          {
            class: ['sol-pick', id === current && 'selected'],
            type: 'button',
            role: 'radio',
            'aria-checked': String(id === current),
            dataset: { value: id },
            onclick: () => {
              btns.forEach((x) => {
                x.classList.toggle('selected', x === b);
                x.setAttribute('aria-checked', String(x === b));
              });
              onpick(id);
            },
            onkeydown: (e) => {
              const i = btns.indexOf(b);
              const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
              if (!step) return;
              e.preventDefault();
              const nb = btns[(i + step + btns.length) % btns.length];
              nb.focus();
              nb.click();
            },
          },
          render(id),
          h('span', { class: 'caption' }, t(`${labelKey === 'settings.back' ? 'back' : 'tableBg'}.${id}`)),
        );
        return b;
      });
      wrap.append(...btns);
      return wrap;
    };
    const backs = picker(BACKS, draft.back, (id) => h('img', { class: 'sol-pick-back', src: svgUrl(backSvg(id, accent)), alt: '' }), (id) => {
      draft.back = id;
      this.applyLook(draft);
    }, 'settings.back');
    const tables = picker(TABLES, draft.table, (id) => h('span', { class: 'sol-pick-table', dataset: { bg: id } }), (id) => {
      draft.table = id;
      this.applyLook(draft);
    }, 'settings.table');
    const body = h(
      'div',
      { class: 'sol-settings' },
      h(
        'div',
        { class: 'sol-set-col' },
        h('div', { class: 'sol-set-section' }, t('settings.game')),
        h('div', { class: 'caption text-2 sol-set-note' }, t('settings.gameHint')),
        rowEl(t('settings.draw'), null, drawSeg),
        rowEl(t('settings.scoring'), null, scoringSel),
        timedRow,
        cumRow,
        h('div', { class: 'sol-set-section' }, t('settings.play')),
        rowEl(t('settings.clickMove'), t('settings.clickMoveHint'), clickMove),
        rowEl(t('settings.sound'), null, sound),
      ),
      h(
        'div',
        { class: 'sol-set-col' },
        h('div', { class: 'sol-set-section' }, t('settings.look')),
        h('div', { class: 'sol-set-label' }, t('settings.back')),
        backs,
        h('div', { class: 'sol-set-label' }, t('settings.table')),
        tables,
      ),
    );
    const v = await this.dialog({
      title: t('settings.title'),
      body,
      className: 'sol-dialog sol-settings-dialog',
      buttons: [
        { label: t('common.ok'), value: 'ok', primary: true },
        { label: t('common.cancel'), value: null },
      ],
    });
    if (v !== 'ok') {
      this.applyLook(this.prefs);
      return;
    }
    if (!(draft.scoring === 'vegas' && draft.cumulative)) draft.bank = 0;
    this.prefs = draft;
    this.applyLook();
    this.persist('prefs', this.prefs);
    const gameChanged = ['draw', 'scoring', 'timed', 'cumulative'].some((k) => draft[k] !== before[k]);
    if (!gameChanged) return;
    const g = this.game;
    if (!g.started) {
      this.startGame(g.s.seed);
      return;
    }
    if (g.s.won) return;
    const now = await this.dialog({
      title: t('settings.applyTitle'),
      body: t('settings.applyBody'),
      buttons: [
        { label: t('newGame'), value: true, primary: true },
        { label: t('settings.applyLater'), value: false },
      ],
    });
    if (now === true) {
      this.recordLoss();
      this.startGame(randomGameNumber());
    }
  }

  async showHelp() {
    if (this.modal) return;
    const { h } = this.ctx;
    const { t } = this;
    const keys = [
      ['F2', 'newGame'],
      [`${t('key.shift')}+F2`, 'restart'],
      [`${t('key.ctrl')}+Z`, 'undo'],
      ['H', 'hint'],
      ['A', 'autoComplete'],
      ['D', 'help.kDraw'],
      [t('help.arrows'), 'help.kMove'],
      [t('help.enter'), 'help.kPick'],
      [`${t('key.shift')}+${t('key.enter')}`, 'help.kAuto'],
      ['1 – 7', 'help.kColumn'],
      [t('key.esc'), 'help.kCancel'],
    ];
    const body = h(
      'div',
      { class: 'sol-help' },
      h('p', null, t('help.goal')),
      h('p', null, t('help.tableau')),
      h('p', null, t('help.stock')),
      h('p', null, t('help.scoring')),
      h('div', { class: 'sol-set-section' }, t('help.keys')),
      h('div', { class: 'sol-keys' }, keys.map(([k, v]) => [h('kbd', null, k), h('span', null, t(v))])),
    );
    await this.dialog({ title: t('howTo'), body, className: 'sol-dialog sol-help-dialog', width: 560, buttons: [{ label: t('common.close'), value: true, primary: true }] });
  }

  // ------------------------------------------------------------ test hooks (used by test/solitaire.test.mjs)
  testApi() {
    const self = this;
    const rel = (r) => ({ x: r.x, y: r.y, width: r.width, height: r.height, left: r.left, top: r.top, right: r.right, bottom: r.bottom });
    return {
      state: () => JSON.parse(JSON.stringify(self.game.s)),
      history: () => self.game.history.length,
      load(desc) {
        self.setGame(new Klondike(stateFrom(desc)), { deal: false });
        return true;
      },
      deal(seed, options = {}) {
        self.startGame(seed, { animate: !!options.animate, options });
        return self.game.s.seed;
      },
      cardRect: (code) => rel(self.cards[parseCode(code)].getBoundingClientRect()),
      pileRect(id) {
        const r = self.pileRect(id);
        const tr = self.table.getBoundingClientRect();
        return { x: tr.left + r.x, y: tr.top + r.y, width: r.w, height: r.h };
      },
      layout: () => ({ ...self.L }),
      busy: () => self.busy,
      cascading: () => self.cascading,
      canAutoComplete: () => self.game.canAutoComplete(),
      autoVisible: () => !self.autoBtn.hidden,
      prefs: () => ({ ...self.prefs }),
      setPrefs(p) {
        self.prefs = { ...self.prefs, ...p };
        self.applyLook();
        return { ...self.prefs };
      },
      stats: () => JSON.parse(JSON.stringify(self.stats)),
      held: () => (self.held ? { ...self.held } : null),
      cursor: () => ({ ...self.cursor, index: self.cursorIndex() }),
      setElapsed(ms) {
        self.game.s.elapsed = ms;
        self.updateStatus();
      },
      stopCascade: () => self.stopCascade(),
      /** Play up to n hinted moves instantly (used to reach a mid-game position for screenshots). */
      autoplay(n) {
        let done = 0;
        for (; done < n && !self.game.s.won; done++) {
          const hnt = self.game.hints()[0];
          if (!hnt) break;
          if (hnt.draw) self.game.drawCards();
          else self.game.move(hnt.from, hnt.index, hnt.to);
        }
        self.render({ animate: false });
        self.updateStatus();
        self.updateToolbar();
        return done;
      },
    };
  }
}
