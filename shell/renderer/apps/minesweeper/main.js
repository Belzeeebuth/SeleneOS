// Minesweeper — classic Windows game with a Fluent look.
// Game rules live in logic.mjs (pure, unit-tested); this file is the UI.
import { Minesweeper, DIFFICULTIES, CUSTOM_LIMITS, LEVELS, maxMines, validateCustom, emptyStats, recordGame, winRate, sanitizePrefs, sanitizeAllStats } from './logic.mjs';
import { createKit, reduceMotion } from './gamekit.js';

const MIN_CELL = 18;
const MAX_CELL = 60;
const PREF_CELL = { beginner: 40, intermediate: 32, expert: 28, custom: 32 };
const FRAME_PAD = 8;
const STAGE_PAD = 12;
const LONG_PRESS_MS = 420;
const DIFF_ORDER = LEVELS;

let uid = 0;

// ---------------------------------------------------------------- artwork (inline SVG)
const MINE_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><g stroke="currentColor" stroke-width="2.1" stroke-linecap="round"><path d="M12 2.6v18.8M2.6 12h18.8M5.4 5.4l13.2 13.2M18.6 5.4 5.4 18.6"/></g><circle cx="12" cy="12" r="6.6" fill="currentColor"/><circle cx="9.7" cy="9.7" r="1.9" fill="var(--ms-glint)"/></svg>';
const FLAG_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 3.6v16.2" stroke="var(--ms-pole)" stroke-width="2" stroke-linecap="round"/><path d="M8.4 3.9h9.3c.9 0 1.4 1 .8 1.7l-2.3 3 2.3 3c.6.7.1 1.7-.8 1.7H8.4z" fill="var(--ms-flag)"/><path d="M8.4 3.9h9.3c.9 0 1.4 1 .8 1.7l-.9 1.2H8.4z" fill="#fff" opacity=".22"/><path d="M4.4 20.4h7.2" stroke="var(--ms-pole)" stroke-width="2.2" stroke-linecap="round"/></svg>';
const CROSS_SVG = '<svg class="ms-cross" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5l14 14M19 5 5 19" stroke="var(--ms-cross)" stroke-width="2.6" stroke-linecap="round"/></svg>';

// Fluent-emoji style faces for the reset button.
function faceSvg(kind) {
  const id = `msf${++uid}`;
  const ink = '#5b3a12';
  const parts = {
    smile: `<ellipse cx="11.6" cy="13.2" rx="1.7" ry="2.3" fill="${ink}"/><ellipse cx="20.4" cy="13.2" rx="1.7" ry="2.3" fill="${ink}"/><path d="M10.4 19.2c1.5 2.3 3.4 3.4 5.6 3.4s4.1-1.1 5.6-3.4" fill="none" stroke="${ink}" stroke-width="1.9" stroke-linecap="round"/>`,
    surprised: `<ellipse cx="11.4" cy="12.6" rx="2" ry="2.8" fill="${ink}"/><ellipse cx="20.6" cy="12.6" rx="2" ry="2.8" fill="${ink}"/><circle cx="12" cy="11.6" r=".7" fill="#fff"/><circle cx="21.2" cy="11.6" r=".7" fill="#fff"/><ellipse cx="16" cy="21.4" rx="2.6" ry="3.1" fill="${ink}"/>`,
    cool: `<path d="M5.6 11.2h20.8v1.4c0 3-2.3 5.2-5.2 5.2h-.9c-2.1 0-3.8-1.5-4.2-3.5h-.2c-.4 2-2.1 3.5-4.2 3.5h-.9c-2.9 0-5.2-2.2-5.2-5.2z" fill="#1f2633"/><path d="M8 12.6l2.2 2.6M20.6 12.6l2.2 2.6" stroke="#fff" stroke-opacity=".55" stroke-width="1.2" stroke-linecap="round"/><path d="M10.2 20.6c1.6 1.9 3.5 2.8 5.8 2.8s4.2-.9 5.8-2.8" fill="none" stroke="${ink}" stroke-width="1.9" stroke-linecap="round"/>`,
    dizzy: `<path d="M9.6 11.2l4 4M13.6 11.2l-4 4M18.4 11.2l4 4M22.4 11.2l-4 4" stroke="${ink}" stroke-width="1.8" stroke-linecap="round"/><path d="M11.4 22.4c1-1 2-1 3 0s2 1 3 0 2-1 3 0" fill="none" stroke="${ink}" stroke-width="1.8" stroke-linecap="round"/>`,
  };
  return `<svg viewBox="0 0 32 32" aria-hidden="true"><defs><radialGradient id="${id}" cx="0.38" cy="0.32" r="0.78"><stop offset="0" stop-color="#ffe88a"/><stop offset="0.55" stop-color="#ffcb3d"/><stop offset="1" stop-color="#f29f1c"/></radialGradient><radialGradient id="${id}s" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#ff8c6b" stop-opacity=".55"/><stop offset="1" stop-color="#ff8c6b" stop-opacity="0"/></radialGradient></defs><circle cx="16" cy="16" r="14" fill="url(#${id})"/><ellipse cx="16" cy="9" rx="8" ry="4.2" fill="#fff" opacity=".28"/>${kind === 'smile' || kind === 'cool' ? `<circle cx="8.6" cy="19.2" r="3" fill="url(#${id}s)"/><circle cx="23.4" cy="19.2" r="3" fill="url(#${id}s)"/>` : ''}${parts[kind] || parts.smile}</svg>`;
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export default {
  async launch(ctx) {
    const { win, h, icon, ui, t } = ctx;
    const kit = createKit(ctx);

    // Saved data may be from an older version, hand-edited or damaged: always sanitized.
    const prefs = sanitizePrefs(await kit.load('settings', {}));
    let stats = sanitizeAllStats(await kit.load('stats', {}));
    kit.sound.enabled = prefs.sound !== false;

    let game = null;
    let spec = null;
    let cellEls = [];
    let cursor = 0;
    let kbd = false;
    let pressed = new Set();
    let timerStart = 0;
    let timerId = 0;
    let finalMs = 0;
    let cellSize = 0;
    let fittedFor = '';
    let firstFit = true;
    let minimizedAt = 0;
    let overlayTimer = 0;
    let card = null; // re-renders the visible end-of-game card (language switch)
    const mouse = { left: false, right: false, middle: false, chord: false, suppress: false, hover: null };

    // ---------------------------------------------------------------- DOM
    const root = h('div', { class: 'ms-root' });
    const newBtn = kit.button({ icon: 'add', label: t('gk.newGame'), tip: `${t('gk.newGame')} (F2)`, onClick: () => requestNewGame(), id: 'new', collapsible: true });
    const diffBtn = kit.button({ icon: 'grid', label: '', chevron: true, onClick: (e) => openDifficultyMenu(e.currentTarget), id: 'difficulty' });
    const statsBtn = kit.iconButton({ icon: 'data_bar_vertical', tip: t('gk.statistics'), onClick: () => showStats(), id: 'stats' });
    const helpBtn = kit.iconButton({ icon: 'question_circle', tip: `${t('gk.howToPlay')} (F1)`, onClick: () => showHelp(), id: 'help' });
    const bar = kit.toolbar([newBtn, diffBtn], [statsBtn, helpBtn]);

    const mineIcon = h('span', { class: 'gk-chip-icon ms-chip-mine', html: MINE_SVG });
    const minesChip = kit.chip({ iconNode: mineIcon, value: '0', id: 'mines', tip: t('minesLeft') });
    const timeChip = kit.chip({ icon: 'timer', value: '0', id: 'time', tip: t('time'), role: 'timer' });
    const face = h('button', { class: 'ms-face', 'data-id': 'face', 'aria-label': t('faceTip'), 'data-tip': t('faceTip'), 'data-tip-pos': 'below', onclick: () => requestNewGame() });
    const status = h('div', { class: 'ms-status' }, minesChip, face, timeChip);

    const board = h('div', { class: 'ms-board', tabindex: '0', role: 'grid', autofocus: true, 'aria-label': t('boardLabel') });
    const frame = h('div', { class: 'ms-frame' }, board);
    const stage = h('div', { class: 'ms-stage' }, frame);
    const overlay = kit.overlay(stage);
    root.append(bar, status, stage);
    win.body.appendChild(root);

    // ---------------------------------------------------------------- helpers
    const diffLabel = (d) => t(`diff.${d}`);
    function currentSpec() {
      return prefs.difficulty === 'custom' ? { ...prefs.custom } : { ...DIFFICULTIES[prefs.difficulty] };
    }
    function savePrefs() {
      kit.save('settings', prefs);
    }
    function elapsedMs() {
      if (!game) return 0;
      if (game.status === 'playing') return (minimizedAt || performance.now()) - timerStart;
      return finalMs;
    }
    function setFace(kind) {
      if (face.dataset.kind === kind) return;
      face.dataset.kind = kind;
      face.innerHTML = faceSvg(kind);
    }
    function updateCounters() {
      minesChip.setValue(String(game.minesLeft));
      const s = Math.min(999, Math.floor(elapsedMs() / 1000));
      timeChip.setValue(String(s));
    }
    function startTimer() {
      timerStart = performance.now();
      clearInterval(timerId);
      timerId = setInterval(updateCounters, 250);
      updateCounters();
    }
    function stopTimer() {
      finalMs = performance.now() - timerStart;
      clearInterval(timerId);
      timerId = 0;
      updateCounters();
    }

    // ---------------------------------------------------------------- game lifecycle
    function newGame() {
      minimizedAt = 0;
      clearTimeout(overlayTimer);
      overlay.hide();
      clearInterval(timerId);
      timerId = 0;
      finalMs = 0;
      spec = currentSpec();
      game = new Minesweeper(spec);
      pressed = new Set();
      cursor = Math.min(cursor, game.total - 1);
      if (cursor >= game.total || !fittedFor) cursor = game.index(Math.floor(spec.cols / 2), Math.floor(spec.rows / 2));
      buildBoard();
      setFace('smile');
      updateCounters();
      diffBtn.querySelector('.gk-btn-label').textContent = diffLabel(prefs.difficulty);
      const key = `${spec.cols}x${spec.rows}`;
      if (fittedFor !== key) {
        fittedFor = key;
        requestAnimationFrame(() => fitWindow());
      } else layout();
    }

    async function requestNewGame(apply) {
      if (game?.status === 'playing') {
        const v = await ui.dialog({
          title: t('quit.title'),
          body: t('quit.text'),
          parent: win,
          buttons: [
            { label: t('quit.ok'), value: 'quit', primary: true },
            { label: t('quit.keep'), value: null },
          ],
        });
        if (v !== 'quit') return false;
        if (game?.status === 'playing') recordResult(false, elapsedMs());
      }
      apply?.();
      newGame();
      board.focus({ preventScroll: true });
      return true;
    }

    function recordResult(won, ms) {
      const key = prefs.difficulty;
      const { stats: s, rank } = recordGame(stats[key], { won, ms: Math.round(ms) });
      stats = { ...stats, [key]: s };
      kit.save('stats', stats);
      return { s, rank };
    }

    // ---------------------------------------------------------------- board rendering
    function buildBoard() {
      board.textContent = '';
      board.style.setProperty('--cols', spec.cols);
      board.style.setProperty('--rows', spec.rows);
      board.setAttribute('aria-rowcount', spec.rows);
      board.setAttribute('aria-colcount', spec.cols);
      const frag = document.createDocumentFragment();
      cellEls = new Array(game.total);
      let row = null;
      for (let i = 0; i < game.total; i++) {
        // ARIA grid rows; display: contents keeps every cell a direct item of the CSS grid.
        if (i % spec.cols === 0) {
          row = document.createElement('div');
          row.className = 'ms-row';
          row.setAttribute('role', 'row');
          frag.appendChild(row);
        }
        const el = document.createElement('div');
        el.className = 'ms-cell closed';
        el.dataset.i = i;
        el.id = `${win.id}-c${i}`;
        el.setAttribute('role', 'gridcell');
        cellEls[i] = el;
        row.appendChild(el);
      }
      board.appendChild(frag);
      frame.classList.remove('shake', 'won', 'lost');
      paintCursor();
    }

    function paint(i, { anim = false, delay = 0, wrong = false } = {}) {
      const el = cellEls[i];
      const c = game.cells[i];
      const cls = ['ms-cell'];
      let html = '';
      if (c.state === 'revealed' || (game.status === 'lost' && c.mine && c.state !== 'flag')) {
        cls.push('open');
        if (c.mine) {
          cls.push('mine');
          if (i === game.exploded) cls.push('exploded');
          html = MINE_SVG;
        } else if (c.adj) {
          cls.push(`n${c.adj}`);
          html = `<span>${c.adj}</span>`;
        }
      } else {
        cls.push('closed');
        if (c.state === 'flag') {
          cls.push('flag');
          html = FLAG_SVG;
          if (wrong || (game.status === 'lost' && !c.mine)) {
            cls.push('wrong');
            html += CROSS_SVG;
          }
        } else if (c.state === 'question') {
          cls.push('question');
          html = '<span>?</span>';
        }
      }
      if (pressed.has(i)) cls.push('pressed');
      if (anim && !reduceMotion()) cls.push('anim');
      if (i === cursor && kbd) cls.push('cursor');
      const className = cls.join(' ');
      if (el.className !== className || anim) el.className = className;
      if (el._html !== html) {
        el.innerHTML = html;
        el._html = html;
      }
      if (anim) el.style.setProperty('--d', `${delay}ms`);
      else el.style.removeProperty('--d');
    }

    function cellLabel(i) {
      const c = game.cells[i];
      const { x, y } = game.xy(i);
      let state;
      if (c.state === 'flag') state = t('cell.flag');
      else if (c.state === 'question') state = t('cell.question');
      else if (c.state !== 'revealed') state = t('cell.hidden');
      else if (c.mine) state = t('cell.mine');
      else if (c.adj) state = t('cell.number', { count: c.adj });
      else state = t('cell.empty');
      return t('cell.label', { row: y + 1, col: x + 1, state });
    }

    function paintCursor() {
      board.setAttribute('aria-activedescendant', cellEls[cursor]?.id || '');
      for (const el of board.querySelectorAll('.ms-cell.cursor')) if (Number(el.dataset.i) !== cursor || !kbd) el.classList.remove('cursor');
      if (cellEls[cursor]) {
        if (kbd) cellEls[cursor].classList.add('cursor');
        cellEls[cursor].setAttribute('aria-label', cellLabel(cursor));
      }
    }

    function setPressed(next) {
      const prev = pressed;
      pressed = next;
      for (const i of prev) if (!next.has(i)) paint(i);
      for (const i of next) if (!prev.has(i)) paint(i);
    }

    function previewFor(i, chord) {
      const s = new Set();
      if (i == null || game.over) return s;
      const c = game.cells[i];
      if (c.state === 'hidden' || c.state === 'question') s.add(i);
      if (chord || c.state === 'revealed') {
        for (const j of game.neighbors(i)) {
          const st = game.cells[j].state;
          if (st === 'hidden' || st === 'question') s.add(j);
        }
      }
      return s;
    }

    // ---------------------------------------------------------------- actions
    function act(kind, i) {
      if (i == null || !game || game.over) return;
      if (kind === 'mark') {
        const m = game.toggleMark(i, prefs.questionMarks);
        if (m) {
          paint(i, { anim: m === 'flag' });
          if (m === 'flag') kit.sound.play('flag');
          updateCounters();
          if (i === cursor) paintCursor();
        }
        return;
      }
      const wasReady = game.status === 'ready';
      const res = kind === 'chord' ? game.chord(i) : game.reveal(i);
      if (!res.revealed.length) return;
      if (wasReady && game.status !== 'ready') startTimer();
      const maxDepth = res.revealed.reduce((m, r) => Math.max(m, r.d), 0);
      const stepMs = maxDepth ? Math.min(26, 420 / maxDepth) : 0;
      for (const r of res.revealed) paint(r.i, { anim: true, delay: Math.round(r.d * stepMs) });
      paintCursor();
      if (res.exploded != null) return lose(res.exploded);
      kit.sound.play(res.revealed.length > 1 ? 'pop' : 'click');
      if (res.won) return winGame();
      updateCounters();
    }

    function lose(exploded) {
      stopTimer();
      setFace('dizzy');
      kit.sound.play('boom');
      const { mines, wrongFlags } = game.lossReport();
      const ex = game.xy(exploded);
      paint(exploded, { anim: true });
      let maxDelay = 0;
      for (const i of mines) {
        const p = game.xy(i);
        const d = Math.min(900, Math.round(Math.hypot(p.x - ex.x, p.y - ex.y) * 45));
        maxDelay = Math.max(maxDelay, d);
        paint(i, { anim: true, delay: 120 + d });
      }
      for (const i of wrongFlags) paint(i, { wrong: true });
      frame.classList.add('lost');
      if (!reduceMotion()) {
        frame.classList.remove('shake');
        void frame.offsetWidth;
        frame.classList.add('shake');
      }
      recordResult(false, finalMs);
      updateCounters();
      clearTimeout(overlayTimer);
      card = () =>
        overlay.show({
          kind: 'lost',
          icon: 'emoji_sad',
          tone: 'danger',
          title: t('lost.title'),
          text: t('lost.text'),
          actions: endActions(),
        });
      overlayTimer = setTimeout(card, reduceMotion() ? 200 : 700 + Math.min(maxDelay, 600));
    }
    function endActions() {
      return [
        { label: t('gk.playAgain'), primary: true, id: 'again', onClick: () => requestNewGame() },
        { label: t('viewBoard'), id: 'dismiss', onClick: () => (overlay.hide(), board.focus({ preventScroll: true })) },
      ];
    }

    function winGame() {
      stopTimer();
      setFace('cool');
      kit.sound.play('win');
      game.cells.forEach((c, i) => {
        if (c.mine) paint(i, { anim: true, delay: 80 + Math.round(Math.random() * 380) });
      });
      frame.classList.add('won');
      const { s, rank } = recordResult(true, finalMs);
      updateCounters();
      kit.confetti(stage);
      clearTimeout(overlayTimer);
      card = () =>
        overlay.show({
          kind: 'won',
          art: h('span', { html: faceSvg('cool') }),
          tone: 'success',
          title: t('won.title'),
          badge: rank === 0 && s.won > 0 ? t('gk.newRecord') : null,
          text: [t('won.text', { time: kit.fmtTime(finalMs) }), s.bestTimes[0] ? t('won.best', { time: kit.fmtTime(s.bestTimes[0].ms) }) : ''].filter(Boolean).join('\n'),
          actions: endActions(),
        });
      overlayTimer = setTimeout(card, reduceMotion() ? 200 : 900);
    }

    // ---------------------------------------------------------------- mouse & touch
    const cellAt = (e) => {
      const el = e.target.closest?.('.ms-cell');
      return el && board.contains(el) ? Number(el.dataset.i) : null;
    };
    const cellAtPoint = (x, y) => {
      const el = document.elementFromPoint(x, y)?.closest?.('.ms-cell');
      return el && board.contains(el) ? Number(el.dataset.i) : null;
    };
    function refreshPreview() {
      if (mouse.suppress) return setPressed(new Set());
      if (mouse.chord) setPressed(previewFor(mouse.hover, true));
      else if (mouse.left) setPressed(previewFor(mouse.hover, false));
      else setPressed(new Set());
      setFace(game.over ? face.dataset.kind : mouse.left || mouse.middle ? 'surprised' : 'smile');
    }
    board.addEventListener('mousedown', (e) => {
      if (overlay.visible) return;
      board.focus({ preventScroll: true });
      if (kbd) {
        kbd = false;
        paintCursor();
      }
      const i = cellAt(e);
      mouse.hover = i;
      if (i != null) cursor = i;
      if (!game || game.over) return;
      if (e.button === 2) {
        if (mouse.left) mouse.chord = true;
        else act('mark', i);
        mouse.right = true;
      } else if (e.button === 1) {
        e.preventDefault();
        mouse.middle = true;
        mouse.chord = true;
      } else if (e.button === 0) {
        if (e.shiftKey || e.ctrlKey) {
          act('mark', i);
          return;
        }
        mouse.left = true;
        if (mouse.right) mouse.chord = true;
      }
      refreshPreview();
    });
    const onMouseMove = (e) => {
      if (!mouse.left && !mouse.middle && !mouse.chord) return;
      const i = cellAtPoint(e.clientX, e.clientY);
      if (i !== mouse.hover) {
        mouse.hover = i;
        refreshPreview();
      }
    };
    const onMouseUp = (e) => {
      if (!mouse.left && !mouse.right && !mouse.middle) return;
      const i = cellAtPoint(e.clientX, e.clientY);
      mouse.hover = i;
      const wasChord = mouse.chord;
      if (e.button === 0) mouse.left = false;
      else if (e.button === 1) mouse.middle = false;
      else if (e.button === 2) mouse.right = false;
      else return;
      if (!mouse.suppress && game && !game.over && i != null) {
        if (wasChord) {
          act('chord', i);
          mouse.suppress = true;
        } else if (e.button === 0) act('reveal', i);
      }
      if (!mouse.left && !mouse.right && !mouse.middle) {
        mouse.chord = false;
        mouse.suppress = false;
      }
      refreshPreview();
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    ctx.onClose(() => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    });
    board.addEventListener('contextmenu', (e) => e.preventDefault());
    board.addEventListener('auxclick', (e) => e.preventDefault());

    // Touch / pen: tap reveals, long-press flags.
    let touch = null;
    board.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' || !game || game.over || overlay.visible) return;
      const i = cellAt(e);
      if (i == null) return;
      touch = { i, x: e.clientX, y: e.clientY, long: false, timer: 0 };
      setPressed(previewFor(i, false));
      setFace('surprised');
      touch.timer = setTimeout(() => {
        if (!touch) return;
        touch.long = true;
        setPressed(new Set());
        act('mark', touch.i);
        navigator.vibrate?.(20);
      }, LONG_PRESS_MS);
    });
    const endTouch = (e, cancel) => {
      if (!touch || e.pointerType === 'mouse') return;
      clearTimeout(touch.timer);
      const tt = touch;
      touch = null;
      setPressed(new Set());
      if (!game.over) setFace('smile');
      if (!cancel && !tt.long && Math.hypot(e.clientX - tt.x, e.clientY - tt.y) < 12) act('reveal', tt.i);
    };
    board.addEventListener('pointerup', (e) => endTouch(e, false));
    board.addEventListener('pointercancel', (e) => endTouch(e, true));
    board.addEventListener('pointermove', (e) => {
      if (touch && Math.hypot(e.clientX - touch.x, e.clientY - touch.y) > 12) endTouch(e, true);
    });

    // ---------------------------------------------------------------- keyboard
    kit.bindKeys((e) => {
      const k = e.key;
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      if (k === 'F2' || k === 'n' || k === 'N') {
        e.preventDefault();
        requestNewGame();
        return;
      }
      if (k === 'F1') {
        e.preventDefault();
        showHelp();
        return;
      }
      if (overlay.visible) {
        if (k === 'Escape') {
          e.preventDefault();
          overlay.hide();
          board.focus({ preventScroll: true });
        }
        return;
      }
      if (!game) return;
      const { x, y } = game.xy(cursor);
      const moves = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      if (moves[k]) {
        e.preventDefault();
        const [dx, dy] = moves[k];
        moveCursor(clamp(x + dx, 0, spec.cols - 1), clamp(y + dy, 0, spec.rows - 1));
      } else if (k === 'Home' || k === 'End') {
        e.preventDefault();
        moveCursor(k === 'Home' ? 0 : spec.cols - 1, y);
      } else if (k === ' ' || k === 'Enter') {
        e.preventDefault();
        showCursor();
        act(game.cells[cursor].state === 'revealed' ? 'chord' : 'reveal', cursor);
      } else if (k === 'f' || k === 'F') {
        e.preventDefault();
        showCursor();
        act('mark', cursor);
      }
    });
    function showCursor() {
      if (!kbd) {
        kbd = true;
        paintCursor();
      }
    }
    function moveCursor(x, y) {
      const prev = cursor;
      cursor = game.index(x, y);
      kbd = true;
      if (prev !== cursor) paint(prev);
      paint(cursor);
      paintCursor();
      cellEls[cursor]?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    }
    board.addEventListener('blur', () => {
      if (kbd) cellEls[cursor]?.classList.remove('cursor');
    });
    board.addEventListener('focus', () => {
      if (kbd) cellEls[cursor]?.classList.add('cursor');
    });

    // ---------------------------------------------------------------- sizing
    let normalChrome = null; // title bar + borders, measured while the window is in its normal state
    let refitOnRestore = false; // the board changed while maximized/snapped: refit when restored
    const isDocked = () => !!(win.isMaximized?.() || win.isSnapped?.() || win.fullscreen || (win.state && win.state !== 'normal'));
    function measureChrome() {
      const c = { w: win.el.offsetWidth - win.body.clientWidth, h: win.el.offsetHeight - win.body.clientHeight };
      if (!isDocked()) return (normalChrome = c);
      // Maximized/snapped windows lose their 1px border: reuse the normal measure (or allow for the border).
      return normalChrome || { w: c.w + 2, h: c.h + 2 };
    }
    function boardPixels(cell) {
      const gap = gapFor(cell);
      return { w: spec.cols * cell + (spec.cols - 1) * gap, h: spec.rows * cell + (spec.rows - 1) * gap };
    }
    function gapFor(cell) {
      return Math.max(2, Math.round(cell * 0.075));
    }
    function minContentWidth() {
      const toolbarW = bar.fullWidth();
      const statusW = minesChip.offsetWidth + face.offsetWidth + timeChip.offsetWidth + 24 + 24;
      return Math.max(toolbarW, statusW);
    }
    // resize: false only enforces the (new) minimum size, keeping a size the user chose.
    function fitWindow({ resize = true } = {}) {
      if (!spec || !win.el.isConnected || !win.el.offsetWidth) return; // nothing measurable yet
      const chrome = measureChrome();
      const headH = bar.offsetHeight + status.offsetHeight;
      const extraW = chrome.w + 2 * STAGE_PAD + 2 * FRAME_PAD + 2;
      const extraH = chrome.h + headH + 2 * STAGE_PAD + 2 * FRAME_PAD + 2;
      const minW = minContentWidth() + chrome.w;
      const sizeFor = (cell) => {
        const b = boardPixels(cell);
        return { w: Math.max(minW, b.w + extraW), h: b.h + extraH };
      };
      const wa = ctx.shell?.wm?.workarea?.() || { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight - 48 };
      let cell = PREF_CELL[prefs.difficulty] || 32;
      while (cell > MIN_CELL && (sizeFor(cell).w > wa.width - 24 || sizeFor(cell).h > wa.height - 24)) cell--;
      const min = sizeFor(MIN_CELL);
      if (win.opts) {
        win.opts.minWidth = Math.min(min.w, wa.width);
        win.opts.minHeight = Math.min(min.h, wa.height);
      }
      if (isDocked()) {
        refitOnRestore = refitOnRestore || resize;
        return layout();
      }
      refitOnRestore = false;
      const want = resize ? sizeFor(cell) : { w: Math.max(win.w, win.opts?.minWidth || 0), h: Math.max(win.h, win.opts?.minHeight || 0) };
      const width = Math.min(want.w, wa.width);
      const height = Math.min(want.h, wa.height);
      if (!resize && width === win.w && height === win.h) return layout();
      // Grow/shrink around the current centre, but stay inside the work area.
      let x = win.x + Math.round((win.w - width) / 2);
      let y = win.y;
      x = clamp(x, wa.x, wa.x + wa.width - width);
      y = clamp(y, wa.y, wa.y + wa.height - height);
      // No FLIP animation on the very first fit: the window is still playing its opening animation.
      // (and none while the user drags the window off a maximized/snapped position).
      const animate = !firstFit && !reduceMotion() && !document.body.classList.contains('wm-dragging');
      if (typeof win.setRect === 'function') win.setRect({ x, y, width, height }, animate);
      else win.setSize(width, height);
      firstFit = false;
      layout();
    }
    function layout() {
      if (!spec) return;
      // clientWidth/Height ignore transforms (the window may be mid FLIP animation).
      const availW = stage.clientWidth - 2 * STAGE_PAD - 2 * FRAME_PAD - 2;
      const availH = stage.clientHeight - 2 * STAGE_PAD - 2 * FRAME_PAD - 2;
      if (availW <= 0 || availH <= 0) return;
      // Largest cell whose board (cells + rounded gaps) fits; the estimate only seeds the search.
      const fits = (c) => boardPixels(c).w <= availW && boardPixels(c).h <= availH;
      let cell = clamp(Math.floor(Math.min(availW / (spec.cols + (spec.cols - 1) * 0.075), availH / (spec.rows + (spec.rows - 1) * 0.075))), MIN_CELL, MAX_CELL);
      while (cell < MAX_CELL && fits(cell + 1)) cell++;
      while (cell > MIN_CELL && !fits(cell)) cell--;
      if (cell === cellSize && board.style.getPropertyValue('--cell')) return;
      cellSize = cell;
      board.style.setProperty('--cell', `${cell}px`);
      board.style.setProperty('--gap', `${gapFor(cell)}px`);
      board.style.setProperty('--fs', `${Math.round(cell * 0.56)}px`);
    }
    let layoutRaf = 0;
    win.on('resize', () => {
      cancelAnimationFrame(layoutRaf);
      layoutRaf = requestAnimationFrame(layout);
    });
    win.on('maximize', () => requestAnimationFrame(layout));
    win.on('restore', () =>
      requestAnimationFrame(() => {
        // Level changed while maximized/snapped: the restored size belongs to the old board.
        if (refitOnRestore && !isDocked() && !win.minimized) fitWindow();
        else layout();
      }),
    );
    // Like Windows 7 Minesweeper, the clock stops while the window is minimised.
    win.on('minimize', () => {
      if (game?.status !== 'playing' || !timerId) return;
      minimizedAt = performance.now();
      clearInterval(timerId);
      timerId = 0;
    });
    win.on('restore', () => {
      if (!minimizedAt) return;
      if (game?.status === 'playing') {
        timerStart += performance.now() - minimizedAt;
        timerId = setInterval(updateCounters, 250);
      }
      minimizedAt = 0;
    });

    // ---------------------------------------------------------------- menus & dialogs
    async function openDifficultyMenu(anchor) {
      const items = DIFF_ORDER.map((d) => {
        const s = d === 'custom' ? prefs.custom : DIFFICULTIES[d];
        return {
          label: d === 'custom' ? t('diff.customEllipsis') : diffLabel(d),
          shortcut: t('diffDesc', { cols: s.cols, rows: s.rows, mines: s.mines }),
          checked: prefs.difficulty === d,
          action: () => (d === 'custom' ? customDialog() : changeDifficulty(d)),
        };
      });
      items.push('-');
      items.push({ label: t('questionMarks'), checked: !!prefs.questionMarks, action: () => toggleQuestionMarks() });
      items.push({ label: t('gk.sound'), checked: kit.sound.enabled, action: () => ((kit.sound.enabled = !kit.sound.enabled), (prefs.sound = kit.sound.enabled), savePrefs()) });
      await ui.menu(anchor, items);
    }
    function toggleQuestionMarks() {
      prefs.questionMarks = !prefs.questionMarks;
      savePrefs();
      if (!prefs.questionMarks && game) {
        game.cells.forEach((c, i) => {
          if (c.state === 'question') {
            c.state = 'hidden';
            paint(i);
          }
        });
      }
    }
    async function changeDifficulty(d, custom) {
      if (d === prefs.difficulty && !custom && game?.status !== 'playing') return newGame();
      await requestNewGame(() => {
        prefs.difficulty = d;
        if (custom) prefs.custom = custom;
        savePrefs();
      });
    }
    async function customDialog() {
      const L = CUSTOM_LIMITS;
      const field = (key, label, value, min, max) => {
        const input = h('input', { class: 'input', type: 'number', inputmode: 'numeric', min, max, step: 1, value: String(value), 'data-field': key });
        const hint = h('div', { class: 'field-hint' }, t('custom.range', { min, max }));
        return { input, hint, el: h('label', { class: 'field ms-field' }, h('span', null, label), input, hint) };
      };
      const c = prefs.custom;
      const fc = field('cols', t('custom.cols'), c.cols, L.minCols, L.maxCols);
      const fr = field('rows', t('custom.rows'), c.rows, L.minRows, L.maxRows);
      const fm = field('mines', t('custom.mines'), c.mines, L.minMines, maxMines(c.cols, c.rows));
      const err = h('div', { class: 'ms-field-error', role: 'alert' });
      const density = h('div', { class: 'caption text-2 ms-density' });
      const read = () => ({ cols: Number(fc.input.value), rows: Number(fr.input.value), mines: Number(fm.input.value) });
      const refresh = () => {
        const v = read();
        const mm = Number.isInteger(v.cols) && Number.isInteger(v.rows) ? maxMines(clamp(v.cols, L.minCols, L.maxCols), clamp(v.rows, L.minRows, L.maxRows)) : maxMines(L.maxCols, L.maxRows);
        fm.input.max = mm;
        fm.hint.textContent = t('custom.range', { min: L.minMines, max: mm });
        const ok = !validateCustom(v);
        density.textContent = ok ? t('custom.density', { pct: Math.round((v.mines / (v.cols * v.rows)) * 100) }) : '';
        for (const f of [fc, fr, fm]) f.input.classList.remove('invalid');
        err.textContent = '';
      };
      for (const f of [fc, fr, fm]) f.input.addEventListener('input', refresh);
      refresh();
      const body = h('div', { class: 'ms-custom' }, h('div', { class: 'ms-custom-grid' }, fc.el, fr.el, fm.el), density, err);
      let result = null;
      const v = await ui.dialog({
        title: t('custom.title'),
        body,
        parent: win,
        className: 'ms-custom-dialog',
        buttons: [
          { label: t('custom.start'), value: 'ok', primary: true },
          { label: t('common.cancel'), value: null },
        ],
        onOpen: (dlg) => {
          dlg._validate = (val) => {
            if (val !== 'ok') return true;
            const vals = read();
            const bad = validateCustom(vals);
            if (bad) {
              const f = { cols: fc, rows: fr, mines: fm }[bad.field];
              f.input.classList.add('invalid');
              err.textContent = t(`custom.err.${bad.field}`, { min: bad.min, max: bad.max });
              f.input.focus();
              f.input.select?.();
              return false;
            }
            result = vals;
            return true;
          };
          setTimeout(() => {
            fc.input.focus();
            fc.input.select();
          }, 40);
        },
      });
      if (v === 'ok' && result) await changeDifficulty('custom', result);
    }

    async function showStats() {
      await kit.statsDialog({
        title: t('gk.statistics'),
        categories: DIFF_ORDER.map((d) => ({ value: d, label: diffLabel(d) })),
        value: prefs.difficulty,
        render: (d) => {
          const s = { ...emptyStats(), ...(stats[d] || {}) };
          const best = s.bestTimes[0];
          const grid = h(
            'div',
            { class: 'gk-stat-grid' },
            kit.statTile(t('gk.played'), kit.fmtNum(s.played), { id: 'played' }),
            kit.statTile(t('gk.won'), kit.fmtNum(s.won), { id: 'won' }),
            kit.statTile(t('gk.winRate'), `${winRate(s)} %`, { accent: true, id: 'rate' }),
            kit.statTile(t('stats.bestTime'), best ? kit.fmtTime(best.ms) : '—', { accent: true, id: 'best' }),
            kit.statTile(t('gk.currentStreak'), kit.fmtNum(s.currentStreak), { id: 'streak' }),
            kit.statTile(t('gk.longestStreak'), kit.fmtNum(s.longestStreak), { id: 'longest' }),
          );
          const list = s.bestTimes.length
            ? h(
                'div',
                { class: 'gk-rank-list' },
                s.bestTimes.map((b, n) =>
                  h(
                    'div',
                    { class: 'gk-rank' },
                    h('span', { class: 'gk-rank-pos' }, `${n + 1}`),
                    h('span', null, kit.fmtTime(b.ms)),
                    h('span', { class: 'gk-rank-date' }, ctx.i18n?.formatDate ? ctx.i18n.formatDate(b.date, { dateStyle: 'medium' }) : new Date(b.date).toLocaleDateString()),
                  ),
                ),
              )
            : h('div', { class: 'gk-empty-note' }, t('stats.noTimes'));
          return h('div', { class: 'gk-stats-body' }, grid, h('div', null, h('div', { class: 'gk-subhead' }, t('stats.bestTimes')), list));
        },
        onReset: async () => {
          stats = {};
          kit.save('stats', stats);
          await kit.flush();
        },
      });
      board.focus({ preventScroll: true });
    }

    async function showHelp() {
      await kit.helpDialog({
        title: t('gk.howToPlay'),
        intro: t('help.intro'),
        sections: [
          { title: t('help.basics'), icon: 'lightbulb', items: [t('help.b1'), t('help.b2'), t('help.b3')] },
          { title: t('help.mouse'), icon: 'cursor_click', items: [t('help.m1'), t('help.m2'), t('help.m3'), t('help.m4')] },
          { title: t('help.levels'), icon: 'grid', items: [t('help.l1'), t('help.l2')] },
        ],
        keys: [
          [`← ↑ → ↓`, t('keys.move')],
          [`${t('keys.home')} / ${t('keys.end')}`, t('keys.rowEdge')],
          [`${t('keys.space')} / ${t('keys.enter')}`, t('keys.reveal')],
          ['F', t('keys.flag')],
          ['N / F2', t('gk.newGame')],
          ['F1', t('gk.howToPlay')],
        ],
      });
      board.focus({ preventScroll: true });
    }

    // ---------------------------------------------------------------- language & lifecycle
    ctx.onLangChange(() => {
      newBtn.querySelector('.gk-btn-label').textContent = t('gk.newGame');
      newBtn.dataset.tip = `${t('gk.newGame')} (F2)`;
      newBtn.setAttribute('aria-label', t('gk.newGame'));
      diffBtn.querySelector('.gk-btn-label').textContent = diffLabel(prefs.difficulty);
      statsBtn.dataset.tip = t('gk.statistics');
      statsBtn.setAttribute('aria-label', t('gk.statistics'));
      helpBtn.dataset.tip = `${t('gk.howToPlay')} (F1)`;
      helpBtn.setAttribute('aria-label', t('gk.howToPlay'));
      minesChip.setTip(t('minesLeft'));
      timeChip.setTip(t('time'));
      face.dataset.tip = t('faceTip');
      face.setAttribute('aria-label', t('faceTip'));
      board.setAttribute('aria-label', t('boardLabel'));
      paintCursor();
      bar.refit();
      if (overlay.visible && card) card();
      // Labels changed width: update the minimum size (grow if needed) but keep the user's size.
      requestAnimationFrame(() => fitWindow({ resize: false }));
    });
    ctx.onClose(() => {
      clearInterval(timerId);
      clearTimeout(overlayTimer);
    });

    newGame();
    setTimeout(() => board.focus({ preventScroll: true }), 0);

    // Test / automation hook (read-only snapshot + a few deterministic helpers).
    win.el.__minesweeper = {
      get game() {
        return game;
      },
      get prefs() {
        return prefs;
      },
      get stats() {
        return stats;
      },
      get cellSize() {
        return cellSize;
      },
      get elapsed() {
        return elapsedMs();
      },
      newGame: () => newGame(),
      // Places mines explicitly (before the first click) for reproducible UI tests.
      plant(mines, safe) {
        game.placeMines(safe, mines);
      },
    };
    return {};
  },
};
