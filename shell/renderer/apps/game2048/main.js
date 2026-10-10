// 2048 — slide tiles, merge equal numbers, reach 2048.
// Game rules live in logic.mjs (pure, unit-tested); this file renders the board and animates it.
import { newGame as createGame, move, cloneGame, fromGrid, maxTile, canMove, SIZES, WIN_VALUE, emptyStats, recordGame } from './logic.mjs';
import { createKit, reduceMotion } from './gamekit.js';

const MOVE_MS = 120;
const KEY_DIRS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
const CODE_DIRS = { KeyW: 'up', KeyS: 'down', KeyA: 'left', KeyD: 'right' };

export default {
  async launch(ctx) {
    const { win, h, ui, t } = ctx;
    const kit = createKit(ctx);
    const prefs = Object.assign({ size: 4, undo: true, sound: true }, await kit.load('settings', {}));
    if (!SIZES.includes(prefs.size)) prefs.size = 4;
    let stats = (await kit.load('stats', {})) || {};
    kit.sound.enabled = prefs.sound !== false;

    let game = null;
    let undoState = null;
    let tileEls = new Map();
    let bestAtStart = 0; // record to beat in the current game (gold "Best" chip once beaten)
    let pending = null; // { timer, remove: [els] }
    let tile = 100;
    let gap = 12;
    let swipe = null;

    // ---------------------------------------------------------------- DOM
    const newBtn = kit.button({ icon: 'add', label: t('gk.newGame'), tip: `${t('gk.newGame')} (F2)`, onClick: () => requestNewGame(), id: 'new', collapsible: true });
    const undoBtn = kit.button({ icon: 'arrow_undo', label: t('undo'), tip: `${t('undo')} (Ctrl+Z)`, onClick: () => undo(), id: 'undo', collapsible: true });
    const sizeBtn = kit.button({ icon: 'grid', label: '', chevron: true, onClick: (e) => openOptions(e.currentTarget), id: 'options' });
    const statsBtn = kit.iconButton({ icon: 'data_bar_vertical', tip: t('gk.statistics'), onClick: () => showStats(), id: 'stats' });
    const helpBtn = kit.iconButton({ icon: 'question_circle', tip: `${t('gk.howToPlay')} (F1)`, onClick: () => showHelp(), id: 'help' });
    const bar = kit.toolbar([newBtn, undoBtn, sizeBtn], [statsBtn, helpBtn]);

    const scoreChip = kit.chip({ label: t('score'), value: '0', id: 'score', cls: 't-score' });
    const bestChip = kit.chip({ label: t('best'), value: '0', id: 'best', cls: 't-best' });
    const hint = h('div', { class: 't-hint caption' }, t('hint'));
    const status = h('div', { class: 't-status' }, scoreChip, bestChip, hint);

    const slots = h('div', { class: 't-slots' });
    const tilesLayer = h('div', { class: 't-tiles' });
    const board = h('div', { class: 't-board', tabindex: '0', autofocus: true, role: 'grid', 'aria-label': t('boardLabel') }, slots, tilesLayer);
    const live = h('div', { class: 't-live', 'aria-live': 'polite' });
    const stage = h('div', { class: 't-stage' }, board, live);
    const overlay = kit.overlay(board);
    const root = h('div', { class: 't-root' }, bar, status, stage);
    win.body.appendChild(root);

    // ---------------------------------------------------------------- helpers
    const bestFor = (size) => stats[size]?.bestScore || 0;
    function savePrefs() {
      kit.save('settings', prefs);
    }
    function saveGame() {
      kit.save('game', { ...cloneGame(game), undo: undoState ? cloneGame(undoState) : null });
    }
    function updateChrome() {
      scoreChip.setValue(kit.fmtNum(game.score));
      bestChip.setValue(kit.fmtNum(Math.max(bestFor(game.size), game.score)));
      bestChip.classList.toggle('record', game.score > 0 && game.score > bestAtStart);
      undoBtn.hidden = !prefs.undo;
      undoBtn.disabled = !undoState;
      sizeBtn.querySelector('.gk-btn-label').textContent = `${game.size} × ${game.size}`;
      sizeBtn.dataset.tip = t('gk.options');
    }
    function pos(r, c) {
      return `translate(${gap + c * (tile + gap)}px, ${gap + r * (tile + gap)}px)`;
    }
    function fontFor(v) {
      const d = String(v).length;
      return Math.round(tile * (d <= 2 ? 0.46 : d === 3 ? 0.38 : d === 4 ? 0.3 : 0.24));
    }
    function makeTile(tl, cls) {
      const el = h('div', { class: ['t-tile', `v${tl.value > 2048 ? 'super' : tl.value}`, cls], 'data-value': tl.value, role: 'gridcell' }, h('span', null, String(tl.value)));
      el.style.transform = pos(tl.r, tl.c);
      el.style.fontSize = `${fontFor(tl.value)}px`;
      el.dataset.r = tl.r;
      el.dataset.c = tl.c;
      tileEls.set(tl.id, el);
      tilesLayer.appendChild(el);
      return el;
    }
    function renderAll() {
      flushPending();
      tilesLayer.textContent = '';
      tileEls = new Map();
      for (const tl of game.tiles) makeTile(tl);
    }
    function renderSlots() {
      slots.textContent = '';
      for (let r = 0; r < game.size; r++)
        for (let c = 0; c < game.size; c++) {
          const s = h('div', { class: 't-slot' });
          s.style.transform = pos(r, c);
          slots.appendChild(s);
        }
    }
    function flushPending() {
      if (!pending) return;
      clearTimeout(pending.timer);
      for (const el of pending.remove) el.remove();
      pending = null;
    }

    // ---------------------------------------------------------------- layout
    function layout() {
      if (!game) return;
      const avail = Math.min(stage.clientWidth - 24, stage.clientHeight - 24);
      if (avail <= 0) return;
      const size = Math.max(220, Math.min(760, avail));
      const n = game.size;
      gap = Math.max(6, Math.round(size * (n === 4 ? 0.03 : n === 5 ? 0.025 : 0.022)));
      tile = Math.floor((size - gap * (n + 1)) / n);
      const total = tile * n + gap * (n + 1);
      board.style.width = `${total}px`;
      board.style.height = `${total}px`;
      board.style.setProperty('--tile', `${tile}px`);
      board.style.setProperty('--gap', `${gap}px`);
      board.style.setProperty('--radius', `${Math.max(4, Math.round(tile * 0.09))}px`);
      renderSlots();
      renderAll();
    }

    // ---------------------------------------------------------------- game flow
    let statsBeforeRecord = null;
    function recordIfPlayed() {
      if (!game || game.recorded || (game.moves || 0) === 0) return;
      game.recorded = true;
      statsBeforeRecord = stats;
      const s = recordGame(stats[game.size], { won: game.won, score: game.score, tile: maxTile(game) });
      stats = { ...stats, [game.size]: s };
      kit.save('stats', stats);
    }
    function startNew(size = prefs.size) {
      recordIfPlayed();
      overlay.hide();
      game = createGame(size);
      bestAtStart = bestFor(size);
      undoState = null;
      layout();
      // New game: tiles appear with the "new" animation.
      for (const el of tileEls.values()) el.classList.add('new');
      updateChrome();
      saveGame();
      board.focus({ preventScroll: true });
    }
    async function requestNewGame(size) {
      if (game && !game.over && (game.moves || 0) > 0 && !game.recorded) {
        const v = await ui.dialog({
          title: t('quit.title'),
          body: t('quit.text'),
          parent: win,
          buttons: [
            { label: t('gk.newGame'), value: 'new', primary: true },
            { label: t('quit.keep'), value: null },
          ],
        });
        if (v !== 'new') return board.focus({ preventScroll: true });
      }
      startNew(size || prefs.size);
    }

    function doMove(dir) {
      if (!game || game.over || overlay.visible) return;
      flushPending();
      const before = cloneGame(game);
      const wasWon = game.won;
      const res = move(game, dir);
      if (!res.moved) {
        nudge(dir);
        return;
      }
      if (prefs.undo) undoState = before;
      const anim = !reduceMotion();
      const remove = [];
      for (const m of res.moves) {
        const el = tileEls.get(m.id);
        if (!el) continue;
        el.style.transform = pos(m.to.r, m.to.c);
        el.dataset.r = m.to.r;
        el.dataset.c = m.to.c;
      }
      for (const mg of res.merges) {
        for (const id of mg.from) {
          const el = tileEls.get(id);
          if (el) {
            remove.push(el);
            tileEls.delete(id);
          }
        }
        makeTile(mg, anim ? 'merged' : null);
      }
      if (res.spawned) makeTile(res.spawned, anim ? 'new' : null);
      if (anim) pending = { remove, timer: setTimeout(flushPending, MOVE_MS + 20) };
      else for (const el of remove) el.remove();

      if (res.gained) {
        floatScore(res.gained);
        const top = res.merges.reduce((m, x) => Math.max(m, x.value), 0);
        kit.sound.play('merge', Math.log2(top || 2));
      } else kit.sound.play('move');
      const cur = { ...emptyStats(), ...(stats[game.size] || {}) };
      const top = maxTile(game);
      if (game.score > cur.bestScore || top > cur.bestTile) {
        // Keep records live, even if the app is closed mid-game.
        stats = { ...stats, [game.size]: { ...cur, bestScore: Math.max(cur.bestScore, game.score), bestTile: Math.max(cur.bestTile, top) } };
        kit.save('stats', stats);
      }
      updateChrome();
      live.textContent = res.gained ? t('live.merged', { points: res.gained, score: game.score }) : '';
      saveGame();
      if (!wasWon && game.won && !game.keepPlaying) setTimeout(showWin, anim ? MOVE_MS + 260 : 0);
      else if (game.over) setTimeout(showOver, anim ? MOVE_MS + 300 : 0);
    }

    function nudge(dir) {
      if (reduceMotion()) return;
      const d = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }[dir];
      tilesLayer.animate(
        [{ transform: 'none' }, { transform: `translate(${d[0] * 6}px, ${d[1] * 6}px)` }, { transform: 'none' }],
        { duration: 180, easing: 'cubic-bezier(0.33, 0, 0.67, 1)' },
      );
    }

    function floatScore(points) {
      scoreChip.bump();
      if (reduceMotion()) return;
      const f = h('span', { class: 't-float' }, `+${kit.fmtNum(points)}`);
      scoreChip.appendChild(f);
      setTimeout(() => f.remove(), 800);
    }

    function showWin() {
      if (!game.won || game.keepPlaying || game.over) return;
      kit.sound.play('win');
      kit.confetti(board);
      overlay.show({
        kind: 'won',
        icon: 'trophy',
        tone: 'success',
        title: t('won.title'),
        text: t('won.text', { score: kit.fmtNum(game.score) }),
        actions: [
          { label: t('won.keepGoing'), primary: true, id: 'keep', onClick: () => keepGoing() },
          { label: t('gk.newGame'), id: 'new', onClick: () => startNew() },
        ],
      });
    }
    function keepGoing() {
      game.keepPlaying = true;
      saveGame();
      overlay.hide();
      board.focus({ preventScroll: true });
    }
    function showOver() {
      if (!game.over) return;
      recordIfPlayed();
      kit.sound.play('die');
      saveGame();
      const isRecord = game.score > 0 && game.score >= bestFor(game.size);
      overlay.show({
        kind: 'over',
        icon: 'emoji_sad',
        tone: 'danger',
        title: t('over.title'),
        badge: isRecord ? t('gk.newRecord') : null,
        text: t('over.text', { score: kit.fmtNum(game.score), tile: kit.fmtNum(maxTile(game)) }),
        actions: [
          { label: t('over.again'), primary: true, id: 'again', onClick: () => startNew() },
          prefs.undo && undoState ? { label: t('undo'), id: 'undo', onClick: () => undo() } : null,
        ].filter(Boolean),
      });
    }

    function undo() {
      if (!prefs.undo || !undoState) return;
      flushPending();
      // A finished game that gets undone is no longer finished.
      const wasRecorded = game.recorded && game.over;
      game = undoState;
      undoState = null;
      if (wasRecorded && statsBeforeRecord) {
        // The finished game was already counted: take it back (records are kept).
        const prev = { ...emptyStats(), ...(statsBeforeRecord[game.size] || {}) };
        const cur = stats[game.size] || {};
        stats = { ...statsBeforeRecord, [game.size]: { ...prev, bestScore: Math.max(prev.bestScore, cur.bestScore || 0), bestTile: Math.max(prev.bestTile, cur.bestTile || 0) } };
        statsBeforeRecord = null;
        kit.save('stats', stats);
      }
      game.recorded = false;
      game.over = !canMove(game);
      overlay.hide();
      renderAll();
      if (!reduceMotion()) for (const el of tileEls.values()) el.animate([{ opacity: 0.6, transform: `${el.style.transform} scale(0.94)` }, { opacity: 1, transform: el.style.transform }], { duration: 160, easing: 'cubic-bezier(0.1, 0.9, 0.2, 1)' });
      updateChrome();
      saveGame();
      board.focus({ preventScroll: true });
    }

    // ---------------------------------------------------------------- input
    kit.bindKeys((e) => {
      const k = e.key;
      if ((e.ctrlKey || e.metaKey) && !e.altKey && (k === 'z' || k === 'Z')) {
        e.preventDefault();
        return undo();
      }
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      if (k === 'F2' || k === 'n' || k === 'N') {
        e.preventDefault();
        return requestNewGame();
      }
      if (k === 'F1') {
        e.preventDefault();
        return showHelp();
      }
      if (k === 'u' || k === 'U' || k === 'Backspace') {
        e.preventDefault();
        return undo();
      }
      if (overlay.visible) {
        if (k === 'Escape' && overlay.kind === 'won') {
          e.preventDefault();
          keepGoing();
        }
        return;
      }
      const dir = KEY_DIRS[k] || CODE_DIRS[e.code];
      if (dir) {
        e.preventDefault();
        doMove(dir);
      }
    });

    board.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.gk-overlay')) return;
      board.focus({ preventScroll: true });
      swipe = { x: e.clientX, y: e.clientY, id: e.pointerId };
      board.setPointerCapture?.(e.pointerId);
    });
    board.addEventListener('pointerup', (e) => {
      if (!swipe || swipe.id !== e.pointerId) return;
      const dx = e.clientX - swipe.x;
      const dy = e.clientY - swipe.y;
      swipe = null;
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 28) return;
      doMove(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up');
    });
    board.addEventListener('pointercancel', () => (swipe = null));

    // ---------------------------------------------------------------- options, stats, help
    async function openOptions(anchor) {
      await ui.menu(anchor, [
        { header: t('opt.size') },
        ...SIZES.map((n) => ({
          label: `${n} × ${n}`,
          shortcut: n === 4 ? t('opt.classic') : null,
          checked: game.size === n,
          action: () => {
            if (n === game.size) return;
            prefs.size = n;
            savePrefs();
            requestNewGame(n);
          },
        })),
        '-',
        {
          label: t('opt.undo'),
          checked: !!prefs.undo,
          action: () => {
            prefs.undo = !prefs.undo;
            if (!prefs.undo) undoState = null;
            savePrefs();
            updateChrome();
            saveGame();
          },
        },
        { label: t('gk.sound'), checked: kit.sound.enabled, action: () => ((kit.sound.enabled = !kit.sound.enabled), (prefs.sound = kit.sound.enabled), savePrefs()) },
      ]);
      board.focus({ preventScroll: true });
    }

    async function showStats() {
      await kit.statsDialog({
        title: t('gk.statistics'),
        categories: SIZES.map((n) => ({ value: n, label: `${n} × ${n}` })),
        value: game.size,
        render: (n) => {
          const s = { ...emptyStats(), ...(stats[n] || {}) };
          const rate = s.played ? Math.round((s.won / s.played) * 100) : 0;
          return h(
            'div',
            { class: 'gk-stat-grid' },
            kit.statTile(t('gk.played'), kit.fmtNum(s.played), { id: 'played' }),
            kit.statTile(t('gk.won'), kit.fmtNum(s.won), { id: 'won' }),
            kit.statTile(t('gk.winRate'), `${rate} %`, { accent: true, id: 'rate' }),
            kit.statTile(t('stats.bestScore'), kit.fmtNum(s.bestScore), { accent: true, id: 'best' }),
            kit.statTile(t('stats.bestTile'), s.bestTile ? kit.fmtNum(s.bestTile) : '—', { id: 'tile' }),
            kit.statTile(t('stats.average'), kit.fmtNum(s.played ? Math.round(s.totalScore / s.played) : 0), { id: 'avg' }),
            kit.statTile(t('gk.currentStreak'), kit.fmtNum(s.currentStreak), { id: 'streak' }),
            kit.statTile(t('gk.longestStreak'), kit.fmtNum(s.longestStreak), { id: 'longest' }),
          );
        },
        onReset: async () => {
          stats = {};
          kit.save('stats', stats);
          await kit.flush();
          bestAtStart = 0;
          updateChrome();
        },
      });
      board.focus({ preventScroll: true });
    }

    async function showHelp() {
      await kit.helpDialog({
        title: t('gk.howToPlay'),
        intro: t('help.intro'),
        sections: [
          { title: t('help.rules'), icon: 'lightbulb', items: [t('help.r1'), t('help.r2'), t('help.r3'), t('help.r4')] },
          { title: t('help.tips'), icon: 'sparkle', items: [t('help.t1'), t('help.t2')] },
        ],
        keys: [
          [`← ↑ → ↓ / W A S D`, t('keys.slide')],
          ['Ctrl+Z / U', t('undo')],
          ['N / F2', t('gk.newGame')],
          ['F1', t('gk.howToPlay')],
        ],
      });
      board.focus({ preventScroll: true });
    }

    // ---------------------------------------------------------------- lifecycle
    let layoutRaf = 0;
    win.on('resize', () => {
      cancelAnimationFrame(layoutRaf);
      layoutRaf = requestAnimationFrame(layout);
    });
    ctx.onLangChange(() => {
      newBtn.querySelector('.gk-btn-label').textContent = t('gk.newGame');
      newBtn.dataset.tip = `${t('gk.newGame')} (F2)`;
      undoBtn.querySelector('.gk-btn-label').textContent = t('undo');
      undoBtn.dataset.tip = `${t('undo')} (Ctrl+Z)`;
      newBtn.setAttribute('aria-label', t('gk.newGame'));
      undoBtn.setAttribute('aria-label', t('undo'));
      bar.refit();
      statsBtn.dataset.tip = t('gk.statistics');
      statsBtn.setAttribute('aria-label', t('gk.statistics'));
      helpBtn.dataset.tip = `${t('gk.howToPlay')} (F1)`;
      helpBtn.setAttribute('aria-label', t('gk.howToPlay'));
      scoreChip.setLabel(t('score'));
      bestChip.setLabel(t('best'));
      hint.textContent = t('hint');
      board.setAttribute('aria-label', t('boardLabel'));
      updateChrome();
      if (overlay.kind === 'won') showWin();
      else if (overlay.kind === 'over') showOver();
    });
    win.onBeforeClose(async () => {
      await kit.flush();
      return true;
    });
    ctx.onClose(() => flushPending());

    // Restore the saved game (2048 keeps your game between sessions, like the original).
    // Saved data is validated and rebuilt through fromGrid(), so a damaged file just starts a new game.
    const revive = (data) => {
      if (!data || !SIZES.includes(data.size) || !Array.isArray(data.tiles) || !data.tiles.length) return null;
      const n = data.size;
      const grid = Array.from({ length: n }, () => Array(n).fill(0));
      for (const tl of data.tiles) {
        const ok = Number.isInteger(tl?.r) && Number.isInteger(tl?.c) && tl.r >= 0 && tl.c >= 0 && tl.r < n && tl.c < n && Number.isInteger(tl.value) && tl.value >= 2 && (tl.value & (tl.value - 1)) === 0;
        if (!ok || grid[tl.r][tl.c]) return null;
        grid[tl.r][tl.c] = tl.value;
      }
      const num = (v) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
      const g = fromGrid(grid, { score: num(data.score), moves: num(data.moves), won: !!data.won, keepPlaying: !!data.keepPlaying, recorded: !!data.recorded });
      g.over = !canMove(g);
      return g;
    };
    const saved = await kit.load('game', null);
    const restored = revive(saved);
    if (restored && !restored.over) {
      game = restored;
      undoState = prefs.undo ? revive(saved.undo) : null;
      // If the saved game is the one holding the record, keep showing it as a record.
      bestAtStart = bestFor(game.size) === game.score ? 0 : bestFor(game.size);
      requestAnimationFrame(() => {
        layout();
        updateChrome();
        if (game.won && !game.keepPlaying) showWin();
      });
    } else requestAnimationFrame(() => startNew(prefs.size));
    if (game) updateChrome();

    // Test / automation hook.
    win.el.__game2048 = {
      get game() {
        return game;
      },
      get stats() {
        return stats;
      },
      get prefs() {
        return prefs;
      },
      get canUndo() {
        return !!undoState;
      },
      // Replaces the board with a given grid (tests).
      load(grid, extra = {}) {
        flushPending();
        overlay.hide();
        game = fromGrid(grid, { ...extra });
        bestAtStart = bestFor(game.size);
        game.over = !canMove(game);
        undoState = null;
        layout();
        updateChrome();
        saveGame();
        if (game.over) showOver();
      },
    };
    return {};
  },
};
