// Snake — canvas game with smooth interpolated movement (fixed-timestep logic + requestAnimationFrame).
// Game rules live in logic.mjs (pure, unit-tested); this file renders and handles input.
import { createGame, queueTurn, step, stepInterval, modeKey, SIZES, MODES, emptyStats, recordGame, sanitizePrefs, sanitizeStats } from './logic.mjs';
import { createKit, reduceMotion } from './gamekit.js';

const SPEED_ORDER = ['slow', 'normal', 'fast', 'insane'];
const SIZE_ORDER = ['small', 'medium', 'large'];
// Arrow keys by key, letters by physical position (WASD on QWERTY = ZQSD on AZERTY).
const KEY_DIRS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
const CODE_DIRS = { KeyW: 'up', KeyS: 'down', KeyA: 'left', KeyD: 'right' };

const lerp = (a, b, t) => a + (b - a) * t;
const easeOutBack = (x) => 1 + 2.2 * Math.pow(x - 1, 3) + 1.2 * Math.pow(x - 1, 2);

export default {
  async launch(ctx) {
    const { win, h, ui, t } = ctx;
    const kit = createKit(ctx);
    // Saved data may be from an older version, hand-edited or damaged: always sanitized.
    const prefs = sanitizePrefs(await kit.load('settings', {}));
    let stats = sanitizeStats(await kit.load('stats', {}));
    kit.sound.enabled = prefs.sound !== false;

    let game = null;
    let state = 'ready'; // ready | running | paused | over
    let pauseReason = null;
    let acc = 0;
    let last = 0;
    let raf = 0;
    let alpha = 1;
    let playStart = 0;
    let playedMs = 0;
    let foodBorn = 0;
    let deathAt = 0;
    let particles = [];
    let cell = 24;
    let boardW = 0;
    let boardH = 0;
    let colors = {};
    let swipe = null;
    let lastOver = { reason: 'wall', record: false };

    // ---------------------------------------------------------------- DOM
    const newBtn = kit.button({ icon: 'add', label: t('gk.newGame'), tip: `${t('gk.newGame')} (F2)`, onClick: () => newGame(), id: 'new', collapsible: true });
    const optBtn = kit.button({ icon: 'options', label: t('gk.options'), chevron: true, onClick: (e) => openOptions(e.currentTarget), id: 'options', collapsible: true });
    const statsBtn = kit.iconButton({ icon: 'data_bar_vertical', tip: t('gk.statistics'), onClick: () => showStats(), id: 'stats' });
    const helpBtn = kit.iconButton({ icon: 'question_circle', tip: `${t('gk.howToPlay')} (F1)`, onClick: () => showHelp(), id: 'help' });
    const bar = kit.toolbar([newBtn, optBtn], [statsBtn, helpBtn]);

    const scoreChip = kit.chip({ label: t('score'), value: '0', id: 'score' });
    const bestChip = kit.chip({ label: t('best'), value: '0', id: 'best', cls: 'sn-best' });
    const modeEl = h('div', { class: 'sn-mode caption', 'data-id': 'mode' });
    const pauseBtn = kit.iconButton({ icon: 'pause', tip: t('pauseTip'), onClick: () => togglePause(), id: 'pause' });
    const status = h('div', { class: 'sn-status' }, scoreChip, bestChip, h('div', { class: 'gk-spacer' }), modeEl, pauseBtn);

    const canvas = h('canvas', { class: 'sn-canvas', 'aria-hidden': 'true' });
    const boardWrap = h('div', { class: 'sn-board', tabindex: '0', autofocus: true, role: 'application', 'aria-label': t('boardLabel') }, canvas);
    const stage = h('div', { class: 'sn-stage' }, boardWrap);
    const overlay = kit.overlay(boardWrap);
    const root = h('div', { class: 'sn-root' }, bar, status, stage);
    win.body.appendChild(root);
    const g2 = canvas.getContext('2d');

    // ---------------------------------------------------------------- helpers
    const mode = () => modeKey(prefs);
    const best = () => stats.best?.[mode()] || 0;
    function savePrefs() {
      kit.save('settings', prefs);
    }
    function readColors() {
      const cs = getComputedStyle(root);
      const v = (n) => cs.getPropertyValue(n).trim();
      colors = {
        bgA: v('--sn-bg-a'),
        bgB: v('--sn-bg-b'),
        border: v('--sn-border'),
        head: v('--sn-head'),
        headHi: v('--sn-head-hi'),
        bodyA: v('--sn-body-a'),
        bodyB: v('--sn-body-b'),
        belly: v('--sn-belly'),
        eye: v('--sn-eye'),
        pupil: v('--sn-pupil'),
        food: v('--sn-food'),
        foodHi: v('--sn-food-hi'),
        leaf: v('--sn-leaf'),
        rockA: v('--sn-rock-a'),
        rockB: v('--sn-rock-b'),
        dead: v('--sn-dead'),
      };
    }
    function updateChips(bump = false) {
      scoreChip.setValue(kit.fmtNum(game.score));
      bestChip.setValue(kit.fmtNum(Math.max(best(), game.score)));
      if (bump) scoreChip.bump();
      bestChip.classList.toggle('record', game.score > 0 && game.score > best());
    }
    function updateMode() {
      const parts = [t(`speed.${prefs.speed}`), prefs.wrap ? t('mode.wrap') : t('mode.walls')];
      if (prefs.obstacles) parts.push(t('mode.obstacles'));
      modeEl.textContent = parts.join(' · ');
    }
    function updatePauseBtn() {
      const paused = state !== 'running';
      pauseBtn.innerHTML = '';
      pauseBtn.appendChild(ctx.icon(paused ? 'play' : 'pause'));
      const tip = paused ? (state === 'over' ? t('gk.playAgain') : state === 'ready' ? t('startTip') : t('resumeTip')) : t('pauseTip');
      pauseBtn.dataset.tip = tip;
      pauseBtn.setAttribute('aria-label', tip);
    }

    // ---------------------------------------------------------------- game flow
    function recordIfPlayed() {
      if (!game || game.steps === 0 || game.recorded) return null;
      game.recorded = true;
      if (state === 'running') playedMs += performance.now() - playStart;
      const res = recordGame(stats, { score: game.score, eaten: game.eaten, length: game.snake.length, ms: playedMs, mode: game.mode || mode() });
      stats = res.stats;
      kit.save('stats', stats);
      return res;
    }
    function newGame() {
      recordIfPlayed();
      const sz = SIZES[prefs.size];
      game = createGame({ cols: sz.cols, rows: sz.rows, wrap: prefs.wrap, obstacles: prefs.obstacles, speed: prefs.speed, speedUp: prefs.speedUp });
      // The mode this run is played in: a run abandoned by switching mode is recorded under its own mode.
      game.mode = mode();
      state = 'ready';
      acc = 0;
      alpha = 1;
      playedMs = 0;
      particles = [];
      foodBorn = performance.now();
      deathAt = 0;
      updateChips();
      updateMode();
      updatePauseBtn();
      layout();
      showReady();
      wake();
      boardWrap.focus({ preventScroll: true });
    }
    function showReady() {
      overlay.show({
        kind: 'ready',
        icon: 'games',
        title: t('ready.title'),
        text: t('ready.text'),
        actions: [{ label: t('ready.play'), primary: true, id: 'play', onClick: () => start() }],
      });
    }
    function start(dir) {
      if (state === 'over') return newGame();
      if (state !== 'ready' && state !== 'paused') return;
      overlay.hide();
      if (dir) queueTurn(game, dir);
      state = 'running';
      pauseReason = null;
      playStart = performance.now();
      last = performance.now();
      updatePauseBtn();
      wake();
      boardWrap.focus({ preventScroll: true });
    }
    function pause(reason = 'user') {
      if (state !== 'running') return;
      state = 'paused';
      pauseReason = reason;
      playedMs += performance.now() - playStart;
      updatePauseBtn();
      showPaused();
      draw(performance.now());
    }
    function showPaused() {
      overlay.show({
        kind: 'paused',
        icon: 'pause',
        title: t('paused.title'),
        text: pauseReason === 'auto' ? t('paused.auto') : t('paused.text'),
        actions: [
          { label: t('paused.resume'), primary: true, id: 'resume', onClick: () => start() },
          { label: t('gk.newGame'), id: 'restart', onClick: () => newGame() },
        ],
      });
    }
    function togglePause() {
      if (state === 'running') pause();
      else if (state === 'over') newGame();
      else start();
    }
    function gameOver(reason) {
      state = 'over';
      deathAt = performance.now();
      const rec = recordIfPlayed();
      const record = rec?.record && game.score > 0;
      kit.sound.play(game.won ? 'win' : 'die');
      updateChips();
      bestChip.classList.remove('record');
      updatePauseBtn();
      if (game.won) kit.confetti(boardWrap);
      lastOver = { reason, record };
      setTimeout(() => state === 'over' && showOver(), reduceMotion() ? 50 : 650);
    }
    function showOver() {
      const { reason, record } = lastOver;
      overlay.show({
        kind: 'over',
        icon: game.won ? 'trophy' : 'emoji_sad',
        tone: game.won ? 'success' : 'danger',
        title: game.won ? t('over.wonTitle') : t('over.title'),
        badge: record ? t('gk.newRecord') : null,
        text: [t('over.score', { score: kit.fmtNum(game.score) }), t(`over.reason.${game.won ? 'won' : reason}`)].join('\n'),
        actions: [{ label: t('gk.playAgain'), primary: true, id: 'again', onClick: () => newGame() }],
      });
    }
    function doStep(now) {
      const ev = step(game);
      if (ev.died || ev.won) {
        if (ev.won) updateChips(true);
        gameOver(ev.reason);
        return;
      }
      if (ev.ate) {
        kit.sound.play('eat');
        updateChips(true);
        burst(game.snake[0], now);
        foodBorn = now;
      }
    }

    // ---------------------------------------------------------------- loop
    function wake() {
      if (raf) return;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }
    function frame(now) {
      raf = 0;
      const dt = Math.min(250, Math.max(0, now - last));
      last = now;
      if (state === 'running') {
        acc += dt;
        let interval = stepInterval(prefs.speed, game.eaten, prefs.speedUp);
        let guard = 0;
        while (acc >= interval && state === 'running' && guard++ < 8) {
          acc -= interval;
          doStep(now);
          interval = stepInterval(prefs.speed, game.eaten, prefs.speedUp);
        }
        alpha = state === 'running' ? Math.min(1, acc / interval) : 1;
      } else alpha = state === 'paused' ? alpha : 1;
      draw(now);
      const busy = state === 'running' || particles.length || (!reduceMotion() && (now - foodBorn < 400 || (deathAt && now - deathAt < 700)));
      if (busy && !win.minimized) raf = requestAnimationFrame(frame);
    }

    function burst(p, now) {
      if (reduceMotion()) return;
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2 + Math.random() * 0.4;
        const sp = 2.2 + Math.random() * 2.4;
        particles.push({ x: p.x + 0.5, y: p.y + 0.5, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, born: now, life: 380 + Math.random() * 200, r: 0.08 + Math.random() * 0.08, hue: i % 3 });
      }
    }

    // ---------------------------------------------------------------- drawing
    function layout() {
      if (!game) return;
      const availW = stage.clientWidth - 24;
      const availH = stage.clientHeight - 24;
      if (availW <= 0 || availH <= 0) return;
      cell = Math.max(8, Math.floor(Math.min(availW / game.cols, availH / game.rows)));
      boardW = cell * game.cols;
      boardH = cell * game.rows;
      const dpr = window.devicePixelRatio || 1;
      boardWrap.style.width = `${boardW}px`;
      boardWrap.style.height = `${boardH}px`;
      canvas.style.width = `${boardW}px`;
      canvas.style.height = `${boardH}px`;
      canvas.width = Math.round(boardW * dpr);
      canvas.height = Math.round(boardH * dpr);
      g2.setTransform(dpr, 0, 0, dpr, 0, 0);
      readColors();
      draw(performance.now());
    }

    function roundRect(x, y, w, hh, r) {
      g2.beginPath();
      g2.roundRect(x, y, w, hh, r);
    }

    function drawBoard() {
      const r = Math.min(12, cell * 0.5);
      g2.save();
      roundRect(0, 0, boardW, boardH, r);
      g2.clip();
      g2.fillStyle = colors.bgA;
      g2.fillRect(0, 0, boardW, boardH);
      g2.fillStyle = colors.bgB;
      for (let y = 0; y < game.rows; y++) for (let x = (y % 2); x < game.cols; x += 2) g2.fillRect(x * cell, y * cell, cell, cell);
      g2.restore();
    }

    function drawObstacles() {
      for (const o of game.obstacles) {
        const x = o.x * cell;
        const y = o.y * cell;
        const pad = Math.max(1, cell * 0.06);
        const grad = g2.createLinearGradient(x, y, x, y + cell);
        grad.addColorStop(0, colors.rockA);
        grad.addColorStop(1, colors.rockB);
        g2.fillStyle = grad;
        roundRect(x + pad, y + pad, cell - 2 * pad, cell - 2 * pad, cell * 0.22);
        g2.fill();
        g2.fillStyle = 'rgba(255,255,255,0.18)';
        roundRect(x + pad * 2, y + pad * 1.6, cell - 4 * pad, cell * 0.18, cell * 0.1);
        g2.fill();
      }
    }

    function drawFood(now) {
      const f = game.food;
      if (!f) return;
      const born = reduceMotion() ? 1 : Math.min(1, (now - foodBorn) / 360);
      const pop = born < 1 ? easeOutBack(born) : 1;
      const breathe = state === 'running' && !reduceMotion() ? 1 + Math.sin(now / 260) * 0.04 : 1;
      const cx = (f.x + 0.5) * cell;
      const cy = (f.y + 0.54) * cell;
      const rad = cell * 0.36 * pop * breathe;
      if (rad <= 0) return;
      g2.save();
      g2.shadowColor = 'rgba(0,0,0,0.22)';
      g2.shadowBlur = cell * 0.18;
      g2.shadowOffsetY = cell * 0.06;
      const grad = g2.createRadialGradient(cx - rad * 0.35, cy - rad * 0.4, rad * 0.1, cx, cy, rad);
      grad.addColorStop(0, colors.foodHi);
      grad.addColorStop(1, colors.food);
      g2.fillStyle = grad;
      g2.beginPath();
      g2.arc(cx, cy, rad, 0, Math.PI * 2);
      g2.fill();
      g2.restore();
      // stem + leaf
      g2.strokeStyle = '#6b4a2b';
      g2.lineWidth = Math.max(1, cell * 0.06);
      g2.lineCap = 'round';
      g2.beginPath();
      g2.moveTo(cx, cy - rad * 0.8);
      g2.lineTo(cx + rad * 0.12, cy - rad * 1.2);
      g2.stroke();
      g2.fillStyle = colors.leaf;
      g2.beginPath();
      g2.ellipse(cx + rad * 0.45, cy - rad * 1.1, rad * 0.42, rad * 0.2, -0.5, 0, Math.PI * 2);
      g2.fill();
      g2.fillStyle = 'rgba(255,255,255,0.55)';
      g2.beginPath();
      g2.ellipse(cx - rad * 0.4, cy - rad * 0.35, rad * 0.22, rad * 0.14, -0.7, 0, Math.PI * 2);
      g2.fill();
    }

    // Body path at fraction a of the current step, in "unwrapped" grid coordinates.
    function snakePath(a) {
      const s = game.snake;
      const n = s.length;
      const pts = [];
      if (n === 1) return [{ x: s[0].x, y: s[0].y }];
      const unwrap = (p, ref) => {
        let { x, y } = p;
        if (game.wrap) {
          if (x - ref.x > game.cols / 2) x -= game.cols;
          else if (ref.x - x > game.cols / 2) x += game.cols;
          if (y - ref.y > game.rows / 2) y -= game.rows;
          else if (ref.y - y > game.rows / 2) y += game.rows;
        }
        return { x, y };
      };
      const neck = s[1];
      const head = unwrap(s[0], neck);
      pts.push({ x: lerp(neck.x, head.x, a), y: lerp(neck.y, head.y, a) });
      let prev = neck;
      pts.push({ ...neck });
      for (let i = 2; i < n; i++) {
        const p = unwrap(s[i], prev);
        pts.push(p);
        prev = p;
      }
      const tail = prev;
      const pt = unwrap(game.prevTail || s[n - 1], tail);
      const tailEnd = { x: lerp(pt.x, tail.x, a), y: lerp(pt.y, tail.y, a) };
      if (tailEnd.x !== tail.x || tailEnd.y !== tail.y || n === 2) pts.push(tailEnd);
      else pts.push({ ...tail });
      return pts;
    }

    function drawSnake(now, a) {
      const pts = snakePath(a);
      const dead = state === 'over' && !game.won;
      const offsets = [[0, 0]];
      if (game.wrap) {
        const xs = pts.map((p) => p.x);
        const ys = pts.map((p) => p.y);
        const ox = Math.min(...xs) < 0 ? [game.cols] : Math.max(...xs) > game.cols - 1 ? [-game.cols] : [];
        const oy = Math.min(...ys) < 0 ? [game.rows] : Math.max(...ys) > game.rows - 1 ? [-game.rows] : [];
        for (const dx of ox) offsets.push([dx, 0]);
        for (const dy of oy) offsets.push([0, dy]);
        for (const dx of ox) for (const dy of oy) offsets.push([dx, dy]);
      }
      let shake = 0;
      if (dead && !reduceMotion()) {
        const t2 = (now - deathAt) / 500;
        if (t2 < 1) shake = Math.sin(t2 * 40) * (1 - t2) * cell * 0.08;
      }
      g2.save();
      roundRect(0, 0, boardW, boardH, Math.min(12, cell * 0.5));
      g2.clip();
      for (const [ox, oy] of offsets) drawSnakeAt(pts, ox, oy, dead, shake);
      g2.restore();
    }

    function drawSnakeAt(pts, ox, oy, dead, shake) {
      const P = (p) => ({ x: (p.x + ox + 0.5) * cell + shake, y: (p.y + oy + 0.5) * cell });
      const n = pts.length;
      const width = cell * 0.7;
      g2.lineCap = 'round';
      g2.lineJoin = 'round';
      // soft shadow under the body
      g2.save();
      g2.strokeStyle = 'rgba(0,0,0,0.16)';
      g2.lineWidth = width;
      g2.beginPath();
      for (let i = 0; i < n; i++) {
        const p = P(pts[i]);
        if (i === 0) g2.moveTo(p.x, p.y + cell * 0.08);
        else g2.lineTo(p.x, p.y + cell * 0.08);
      }
      g2.stroke();
      g2.restore();
      // body: tail -> head, colour fades from bodyB (tail) to bodyA (neck)
      for (let i = n - 1; i >= 1; i--) {
        const a2 = P(pts[i]);
        const b2 = P(pts[i - 1]);
        const k = n > 2 ? (i - 1) / (n - 2) : 0;
        g2.strokeStyle = dead ? colors.dead : mix(colors.bodyA, colors.bodyB, k);
        g2.lineWidth = width * (1 - k * 0.28);
        g2.beginPath();
        g2.moveTo(a2.x, a2.y);
        g2.lineTo(b2.x, b2.y);
        g2.stroke();
      }
      // belly highlight
      g2.strokeStyle = colors.belly;
      g2.lineWidth = Math.max(1, width * 0.18);
      g2.beginPath();
      for (let i = 0; i < n; i++) {
        const p = P(pts[i]);
        if (i === 0) g2.moveTo(p.x - cell * 0.08, p.y - cell * 0.1);
        else g2.lineTo(p.x - cell * 0.08, p.y - cell * 0.1);
      }
      g2.stroke();
      // head
      const hp = P(pts[0]);
      const np = n > 1 ? P(pts[1]) : { x: hp.x - 1, y: hp.y };
      let ang = Math.atan2(hp.y - np.y, hp.x - np.x);
      if (!Number.isFinite(ang) || (hp.x === np.x && hp.y === np.y)) ang = Math.atan2(DIRV[game.dir].y, DIRV[game.dir].x);
      const hr = cell * 0.46;
      const grad = g2.createRadialGradient(hp.x - hr * 0.35, hp.y - hr * 0.4, hr * 0.1, hp.x, hp.y, hr);
      grad.addColorStop(0, dead ? colors.dead : colors.headHi);
      grad.addColorStop(1, dead ? colors.dead : colors.head);
      g2.fillStyle = grad;
      g2.beginPath();
      g2.ellipse(hp.x, hp.y, hr * 1.05, hr * 0.95, ang, 0, Math.PI * 2);
      g2.fill();
      // eyes
      const fx = Math.cos(ang);
      const fy = Math.sin(ang);
      const sx = -fy;
      const sy = fx;
      for (const side of [-1, 1]) {
        const ex = hp.x + fx * hr * 0.28 + sx * side * hr * 0.42;
        const ey = hp.y + fy * hr * 0.28 + sy * side * hr * 0.42;
        const er = hr * 0.27;
        if (dead) {
          g2.strokeStyle = colors.pupil;
          g2.lineWidth = Math.max(1.2, cell * 0.06);
          g2.beginPath();
          g2.moveTo(ex - er * 0.7, ey - er * 0.7);
          g2.lineTo(ex + er * 0.7, ey + er * 0.7);
          g2.moveTo(ex + er * 0.7, ey - er * 0.7);
          g2.lineTo(ex - er * 0.7, ey + er * 0.7);
          g2.stroke();
        } else {
          g2.fillStyle = colors.eye;
          g2.beginPath();
          g2.arc(ex, ey, er, 0, Math.PI * 2);
          g2.fill();
          g2.fillStyle = colors.pupil;
          g2.beginPath();
          g2.arc(ex + fx * er * 0.35, ey + fy * er * 0.35, er * 0.55, 0, Math.PI * 2);
          g2.fill();
        }
      }
    }

    function drawParticles(now) {
      const cols = [colors.food, colors.foodHi, colors.leaf];
      particles = particles.filter((p) => now - p.born < p.life);
      for (const p of particles) {
        const k = (now - p.born) / p.life;
        const x = (p.x + p.vx * k * 0.6) * cell;
        const y = (p.y + p.vy * k * 0.6) * cell;
        g2.globalAlpha = 1 - k;
        g2.fillStyle = cols[p.hue];
        g2.beginPath();
        g2.arc(x, y, Math.max(0.5, p.r * cell * (1 - k * 0.5)), 0, Math.PI * 2);
        g2.fill();
      }
      g2.globalAlpha = 1;
    }

    function draw(now) {
      if (!game || !boardW) return;
      g2.clearRect(0, 0, boardW, boardH);
      drawBoard();
      drawObstacles();
      drawFood(now);
      drawSnake(now, state === 'running' ? alpha : state === 'paused' ? alpha : 1);
      if (particles.length) drawParticles(now);
    }

    // ---------------------------------------------------------------- input
    kit.bindKeys((e) => {
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      const k = e.key;
      if (k === 'F2' || k === 'n' || k === 'N') {
        e.preventDefault();
        return newGame();
      }
      if (k === 'F1') {
        e.preventDefault();
        return showHelp();
      }
      const dir = KEY_DIRS[k] || CODE_DIRS[e.code];
      if (dir) {
        e.preventDefault();
        if (state === 'running') queueTurn(game, dir);
        else if (state === 'ready' || state === 'paused') start(dir);
        return;
      }
      if (k === ' ' || k === 'Spacebar') {
        e.preventDefault();
        togglePause();
      } else if (k === 'p' || k === 'P' || k === 'Escape') {
        e.preventDefault();
        if (state === 'running') pause();
        else if (state === 'paused') start();
      } else if (k === 'Enter') {
        e.preventDefault();
        if (state === 'over') newGame();
        else if (state !== 'running') start();
      }
    });

    // Swipe / tap on the board (touch, pen or mouse drag).
    boardWrap.addEventListener('pointerdown', (e) => {
      if (overlay.visible && e.target.closest('.gk-overlay-card')) return;
      boardWrap.focus({ preventScroll: true });
      swipe = { x: e.clientX, y: e.clientY, used: false };
    });
    boardWrap.addEventListener('pointermove', (e) => {
      if (!swipe || swipe.used) return;
      const dx = e.clientX - swipe.x;
      const dy = e.clientY - swipe.y;
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return;
      const dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
      swipe.used = true;
      if (state === 'running') queueTurn(game, dir);
      else if (state === 'ready' || state === 'paused') start(dir);
      swipe.x = e.clientX;
      swipe.y = e.clientY;
      swipe.used = false;
    });
    const endSwipe = () => (swipe = null);
    boardWrap.addEventListener('pointerup', endSwipe);
    boardWrap.addEventListener('pointercancel', endSwipe);

    // Pause automatically when the window loses focus or is minimised.
    win.on('blur', () => pause('auto'));
    win.on('minimize', () => pause('auto'));
    const onVis = () => document.hidden && pause('auto');
    document.addEventListener('visibilitychange', onVis);
    // The Start menu, search and other shell flyouts take the keyboard without deactivating the
    // window in the window manager: pause as soon as focus lands outside this window.
    const onFocusIn = (e) => {
      const tgt = e.target;
      if (state === 'running' && tgt instanceof Element && tgt !== document.body && !win.el.contains(tgt)) pause('auto');
    };
    document.addEventListener('focusin', onFocusIn);
    // Display scale changes (shell zoom) change devicePixelRatio: redraw the canvas at the new resolution.
    let dprQuery = null;
    const onDprChange = () => {
      layout();
      watchDpr();
    };
    function watchDpr() {
      dprQuery?.removeEventListener('change', onDprChange);
      dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      dprQuery.addEventListener('change', onDprChange);
    }
    watchDpr();

    // ---------------------------------------------------------------- options, stats, help
    async function openOptions(anchor) {
      if (state === 'running') pause();
      const apply = (fn, restart = true) => () => {
        fn();
        savePrefs();
        if (restart) newGame();
        else {
          game.speed = prefs.speed;
          game.speedUp = prefs.speedUp;
          updateMode();
        }
      };
      await ui.menu(anchor, [
        { header: t('opt.speed') },
        ...SPEED_ORDER.map((sp) => ({ label: t(`speed.${sp}`), checked: prefs.speed === sp, action: apply(() => (prefs.speed = sp), false) })),
        { label: t('opt.speedUp'), checked: !!prefs.speedUp, action: apply(() => (prefs.speedUp = !prefs.speedUp), false) },
        '-',
        { header: t('opt.board') },
        { label: t('mode.walls'), checked: !prefs.wrap, action: apply(() => (prefs.wrap = false)) },
        { label: t('mode.wrap'), checked: !!prefs.wrap, action: apply(() => (prefs.wrap = true)) },
        { label: t('mode.obstacles'), checked: !!prefs.obstacles, action: apply(() => (prefs.obstacles = !prefs.obstacles)) },
        {
          label: t('opt.size'),
          submenu: SIZE_ORDER.map((sz) => ({ label: t(`size.${sz}`), shortcut: `${SIZES[sz].cols} × ${SIZES[sz].rows}`, checked: prefs.size === sz, action: apply(() => (prefs.size = sz)) })),
        },
        '-',
        { label: t('gk.sound'), checked: kit.sound.enabled, action: () => ((kit.sound.enabled = !kit.sound.enabled), (prefs.sound = kit.sound.enabled), savePrefs()) },
      ]);
      boardWrap.focus({ preventScroll: true });
    }

    function modeLabel(m) {
      const [b, o] = m.split('-');
      return o ? t('mode.withObstacles', { mode: t(`mode.${b}`) }) : t(`mode.${b}`);
    }

    async function showStats() {
      if (state === 'running') pause();
      await kit.statsDialog({
        title: t('gk.statistics'),
        render: () => {
          const s = { ...emptyStats(), ...stats };
          const top = Math.max(0, ...Object.values(s.best || {}));
          const avg = s.played ? Math.round(s.totalScore / s.played) : 0;
          return h(
            'div',
            { class: 'gk-stats-body' },
            h(
              'div',
              { class: 'gk-stat-grid' },
              kit.statTile(t('gk.played'), kit.fmtNum(s.played), { id: 'played' }),
              kit.statTile(t('stats.bestScore'), kit.fmtNum(top), { accent: true, id: 'best' }),
              kit.statTile(t('stats.average'), kit.fmtNum(avg), { id: 'avg' }),
              kit.statTile(t('stats.longest'), kit.fmtNum(s.longest), { id: 'longest' }),
              kit.statTile(t('stats.food'), kit.fmtNum(s.foodEaten), { id: 'food' }),
              kit.statTile(t('stats.time'), kit.fmtTime(s.totalMs, 0), { id: 'time' }),
            ),
            h(
              'div',
              null,
              h('div', { class: 'gk-subhead' }, t('stats.byMode')),
              h(
                'div',
                { class: 'gk-rank-list' },
                MODES.map((m, i) =>
                  h('div', { class: 'gk-rank', 'data-mode': m }, h('span', { class: 'gk-rank-pos' }, String(i + 1)), h('span', null, modeLabel(m)), h('span', { class: 'sn-rank-score' }, s.best?.[m] ? kit.fmtNum(s.best[m]) : '—')),
                ),
              ),
            ),
          );
        },
        onReset: async () => {
          stats = emptyStats();
          kit.save('stats', stats);
          await kit.flush();
          updateChips();
        },
      });
      boardWrap.focus({ preventScroll: true });
    }

    // Letter keys named as printed on the active layout (resolved ahead of time: no await before the dialog).
    let wasd = ctx.lang === 'fr' ? 'Z Q S D' : 'W A S D';
    const refreshWasd = () => kit.wasdLabel().then((v) => (wasd = v));
    refreshWasd();
    ctx.onLangChange(refreshWasd);

    async function showHelp() {
      if (state === 'running') pause();
      await kit.helpDialog({
        title: t('gk.howToPlay'),
        intro: t('help.intro'),
        sections: [
          { title: t('help.rules'), icon: 'lightbulb', items: [t('help.r1'), t('help.r2'), t('help.r3')] },
          { title: t('help.modes'), icon: 'options', items: [t('help.o1'), t('help.o2'), t('help.o3')] },
        ],
        keys: [
          [`← ↑ → ↓ / ${wasd}`, t('keys.steer')],
          [`${t('keys.space')} / P / Esc`, t('keys.pause')],
          [t('keys.enter'), t('keys.start')],
          ['N / F2', t('gk.newGame')],
          ['F1', t('gk.howToPlay')],
        ],
      });
      boardWrap.focus({ preventScroll: true });
    }

    // ---------------------------------------------------------------- lifecycle
    let layoutRaf = 0;
    win.on('resize', () => {
      cancelAnimationFrame(layoutRaf);
      layoutRaf = requestAnimationFrame(layout);
    });
    const themeObs = new MutationObserver(() => {
      readColors();
      draw(performance.now());
    });
    themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] });
    ctx.onLangChange(() => {
      newBtn.querySelector('.gk-btn-label').textContent = t('gk.newGame');
      newBtn.dataset.tip = `${t('gk.newGame')} (F2)`;
      newBtn.setAttribute('aria-label', t('gk.newGame'));
      optBtn.querySelector('.gk-btn-label').textContent = t('gk.options');
      optBtn.setAttribute('aria-label', t('gk.options'));
      bar.refit();
      statsBtn.dataset.tip = t('gk.statistics');
      statsBtn.setAttribute('aria-label', t('gk.statistics'));
      helpBtn.dataset.tip = `${t('gk.howToPlay')} (F1)`;
      helpBtn.setAttribute('aria-label', t('gk.howToPlay'));
      scoreChip.setLabel(t('score'));
      bestChip.setLabel(t('best'));
      boardWrap.setAttribute('aria-label', t('boardLabel'));
      updateMode();
      updatePauseBtn();
      updateChips();
      if (state === 'ready') showReady();
      else if (state === 'paused') showPaused();
      else if (state === 'over' && overlay.visible) showOver();
    });
    win.onBeforeClose(async () => {
      recordIfPlayed();
      await kit.flush();
      return true;
    });
    ctx.onClose(() => {
      cancelAnimationFrame(raf);
      themeObs.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      document.removeEventListener('focusin', onFocusIn);
      dprQuery?.removeEventListener('change', onDprChange);
    });

    requestAnimationFrame(() => {
      readColors();
      newGame();
    });

    // Test / automation hook.
    win.el.__snake = {
      get game() {
        return game;
      },
      get state() {
        return state;
      },
      get prefs() {
        return prefs;
      },
      get stats() {
        return stats;
      },
      get cell() {
        return cell;
      },
      get alpha() {
        return alpha;
      },
      step: () => doStep(performance.now()),
      pause: () => pause(),
    };
    return {};
  },
};

const DIRV = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };

// Mixes two CSS hex colours (#rrggbb) — used for the body gradient along its length.
const mixCache = new Map();
function mix(a, b, k) {
  const q = Math.round(k * 20) / 20;
  const key = `${a}|${b}|${q}`;
  let v = mixCache.get(key);
  if (v) return v;
  const pa = hex(a);
  const pb = hex(b);
  if (!pa || !pb) return a;
  v = `rgb(${Math.round(lerp(pa[0], pb[0], q))}, ${Math.round(lerp(pa[1], pb[1], q))}, ${Math.round(lerp(pa[2], pb[2], q))})`;
  if (mixCache.size > 500) mixCache.clear();
  mixCache.set(key, v);
  return v;
}
function hex(c) {
  const m = /^#([0-9a-f]{6})$/i.exec(c || '');
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
