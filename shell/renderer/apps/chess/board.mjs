// Aurora Chess — board view. A DOM chessboard with:
//   squares + coordinates, last-move / selection / check / hint highlights, legal-move dots and
//   capture rings, click-to-move and drag & drop, animated piece movement (pieces keep their DOM
//   identity and slide with a CSS transform transition), a hint arrow, the promotion picker and
//   keyboard play (focus the board, arrows move the cursor, Enter/Space picks up / drops).
//
//   const board = new BoardView({ h, t, onMove, getTargets });
//   board.setPosition({ pieces: Map<square, 'wK'>, lastMove: {from,to}, check: 'e1' }, { move, animate })
//   getTargets(square) -> null (not movable) | [{ to, promotion: bool, capture: bool }]
//   onMove(from, to) is called for a legal target; the app updates the game and calls setPosition.
import { pieceUrl } from './pieces.mjs';

const FILES = 'abcdefgh';
const sqXY = (sq) => [FILES.indexOf(sq[0]), Number(sq[1]) - 1];
const xyName = (f, r) => FILES[f] + (r + 1);
const animOn = () => document.documentElement.dataset.animations !== 'off';

export class BoardView {
  constructor({ h, t, onMove, getTargets }) {
    this.h = h;
    this.t = t;
    this.onMove = onMove;
    this.getTargets = getTargets;
    this.flipped = false;
    this.interactive = true;
    this.showLegal = true;
    this.coords = true;
    this.pieces = []; // { el, code, sq }
    this.state = { pieces: new Map(), lastMove: null, check: null };
    this.selected = null;
    this.targets = [];
    this.drag = null;
    this.hint = null;
    this.cursor = 'e2';
    this.size = 480;
    this._promo = null;
    this._build();
  }

  _build() {
    const { h } = this;
    this.squaresEl = h('div', { class: 'cb-squares', 'aria-hidden': 'true' });
    this.squareEls = [];
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const el = h('div', { class: ['cb-sq', (x + y) % 2 ? 'dark' : 'light'] });
        el.rankLabel = h('span', { class: 'cb-coord cb-rank' });
        el.fileLabel = h('span', { class: 'cb-coord cb-file' });
        if (x === 0) el.appendChild(el.rankLabel);
        if (y === 7) el.appendChild(el.fileLabel);
        this.squareEls.push(el);
        this.squaresEl.appendChild(el);
      }
    }
    this.hlEl = h('div', { class: 'cb-layer cb-hl', 'aria-hidden': 'true' });
    this.dotsEl = h('div', { class: 'cb-layer cb-dots', 'aria-hidden': 'true' });
    this.piecesEl = h('div', { class: 'cb-layer cb-pieces', 'aria-hidden': 'true' });
    this.arrowEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.arrowEl.setAttribute('class', 'cb-arrows');
    this.arrowEl.setAttribute('viewBox', '0 0 800 800');
    this.arrowEl.setAttribute('aria-hidden', 'true');
    this.cursorEl = h('div', { class: 'cb-cursor', 'aria-hidden': 'true' });
    this.el = h(
      'div',
      {
        class: 'cb-board',
        tabindex: '0',
        role: 'application',
        'aria-roledescription': this.t('board.role'),
        'aria-label': this.t('board.label'),
      },
      this.squaresEl,
      this.hlEl,
      this.dotsEl,
      this.piecesEl,
      this.arrowEl,
      this.cursorEl,
    );
    this.el.addEventListener('pointerdown', (e) => this._pointerDown(e));
    this.el.addEventListener('pointermove', (e) => this._hover(e));
    this.el.addEventListener('pointerleave', () => {
      this._hoverSq = null;
      this.el.classList.remove('can-grab');
    });
    this.el.addEventListener('contextmenu', (e) => {
      // right click cancels a selection / drag (like most chess UIs)
      if (this.selected || this.drag) {
        e.preventDefault();
        e.stopPropagation();
        this._cancelDrag();
        this.select(null);
      }
    });
    this.el.addEventListener('keydown', (e) => this._key(e));
    this.el.addEventListener('focus', () => this._showCursor());
    this.el.addEventListener('blur', () => this.el.classList.remove('kb'));
    this._labelCoords();
  }

  // ------------------------------------------------------------ geometry
  _xy(sq) {
    const [f, r] = sqXY(sq);
    return this.flipped ? [7 - f, r] : [f, 7 - r];
  }
  _place(el, sq) {
    const [x, y] = this._xy(sq);
    el.style.transform = `translate(${x * 100}%, ${y * 100}%)`;
  }
  _squareAt(clientX, clientY) {
    const r = this.el.getBoundingClientRect();
    const x = Math.floor(((clientX - r.left) / r.width) * 8);
    const y = Math.floor(((clientY - r.top) / r.height) * 8);
    if (x < 0 || x > 7 || y < 0 || y > 7) return null;
    return this.flipped ? xyName(7 - x, y) : xyName(x, 7 - y);
  }

  setSize(px) {
    this.size = px;
    this.el.style.width = `${px}px`;
    this.el.style.height = `${px}px`;
    this.el.style.setProperty('--sq', `${px / 8}px`);
  }

  setTheme(name) {
    this.el.dataset.theme = name;
  }

  setCoords(on) {
    this.coords = on;
    this.el.classList.toggle('no-coords', !on);
  }

  setShowLegal(on) {
    this.showLegal = on;
    this._renderDots();
  }

  setInteractive(on) {
    this.interactive = on;
    this.el.classList.toggle('readonly', !on);
    if (!on) {
      this._cancelDrag();
      this.select(null);
    }
  }

  setFlipped(on) {
    if (this.flipped === on) return;
    this.flipped = on;
    this._labelCoords();
    for (const p of this.pieces) this._place(p.el, p.sq);
    this._renderHighlights();
    this._renderDots();
    this._renderArrow();
    this._positionCursor();
  }

  _labelCoords() {
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const el = this.squareEls[y * 8 + x];
        const f = this.flipped ? 7 - x : x;
        const r = this.flipped ? y : 7 - y;
        if (x === 0) el.rankLabel.textContent = String(r + 1);
        if (y === 7) el.fileLabel.textContent = FILES[f];
      }
    }
  }

  // ------------------------------------------------------------ position + animation
  // pos: { pieces: Map(sq -> code), lastMove: {from, to} | null, check: sq | null }
  // opts.move: { from, to, rookFrom, rookTo } — the move that led here (keeps piece identity)
  setPosition(pos, { move = null, animate = true } = {}) {
    this.state = pos;
    const anim = animate && animOn();
    const want = new Map(pos.pieces);
    const old = this.pieces;
    const next = [];
    const used = new Set();
    const assign = (p, sq, code) => {
      used.add(p);
      want.delete(sq);
      const moved = p.sq !== sq;
      const changed = p.code !== code;
      p.sq = sq;
      if (changed) {
        p.code = code;
        p.el.style.backgroundImage = `url("${pieceUrl(code)}")`;
        p.el.dataset.piece = code;
      }
      p.el.dataset.square = sq;
      if (moved || p.el.classList.contains('dragging')) this._movePieceEl(p.el, sq, anim && moved);
      next.push(p);
    };
    // 1. the move itself (and the castling rook) keeps its identity; a piece that was just dropped
    //    by drag & drop already sits on its destination square
    if (move) {
      const pairs = [[move.from, move.to]];
      if (move.rookFrom) pairs.push([move.rookFrom, move.rookTo]);
      pairs.forEach(([from, to], i) => {
        const dropped = i === 0 && this._dropped && old.includes(this._dropped) && !used.has(this._dropped) ? this._dropped : null;
        const p = dropped || old.find((q) => q.sq === from && !used.has(q));
        if (p && want.has(to)) assign(p, to, want.get(to));
      });
    }
    // 2. unchanged squares
    for (const p of old) {
      if (used.has(p)) continue;
      if (want.get(p.sq) === p.code) assign(p, p.sq, p.code);
    }
    // 3. nearest piece of the same kind slides over (history jumps, undo, flips…)
    for (const [sq, code] of [...want]) {
      let best = null;
      let bestD = Infinity;
      const [x, y] = sqXY(sq);
      for (const p of old) {
        if (used.has(p) || p.code !== code) continue;
        const [px, py] = sqXY(p.sq);
        const d = Math.abs(px - x) + Math.abs(py - y);
        if (d < bestD) {
          bestD = d;
          best = p;
        }
      }
      if (best) assign(best, sq, code);
    }
    // 4. leftovers: captured pieces fade out, new pieces fade in
    for (const p of old) {
      if (used.has(p)) continue;
      if (anim) {
        p.el.classList.add('leaving');
        setTimeout(() => p.el.remove(), 220);
      } else p.el.remove();
    }
    for (const [sq, code] of want) {
      const el = this.h('div', { class: ['cb-piece', anim && 'entering'], dataset: { piece: code, square: sq } });
      el.style.backgroundImage = `url("${pieceUrl(code)}")`;
      this._place(el, sq);
      this.piecesEl.appendChild(el);
      if (anim) requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove('entering')));
      next.push({ el, code, sq });
    }
    this.pieces = next;
    this._dropped = null;
    this._hoverSq = null; // recompute the grab cursor on the next pointer move
    if (this.selected && !this._pieceAt(this.selected)) this.select(null);
    else if (this.selected) this.select(this.selected);
    this._renderHighlights();
  }

  _movePieceEl(el, sq, animate) {
    el.classList.remove('dragging');
    el.style.removeProperty('--drag-x');
    el.style.removeProperty('--drag-y');
    if (!animate) {
      el.classList.add('no-anim');
      this._place(el, sq);
      void el.offsetWidth;
      el.classList.remove('no-anim');
    } else {
      el.classList.add('moving');
      this._place(el, sq);
      clearTimeout(el._mv);
      el._mv = setTimeout(() => el.classList.remove('moving'), 260);
    }
  }

  _pieceAt(sq) {
    return this.pieces.find((p) => p.sq === sq) || null;
  }

  // ------------------------------------------------------------ highlights
  _hl(sq, cls) {
    const el = this.h('div', { class: ['cb-hl-sq', cls] });
    this._place(el, sq);
    this.hlEl.appendChild(el);
    return el;
  }

  _renderHighlights() {
    this.hlEl.textContent = '';
    const { lastMove, check } = this.state;
    if (lastMove) {
      this._hl(lastMove.from, 'last');
      this._hl(lastMove.to, 'last');
    }
    if (this.hint) this._hl(this.hint.to, 'hint');
    if (this.selected) this._hl(this.selected, 'selected');
    if (check) this._hl(check, 'check');
    if (this.drag?.over && this.drag.over !== this.drag.from) this._hl(this.drag.over, 'hover');
  }

  _renderDots() {
    this.dotsEl.textContent = '';
    if (!this.selected || !this.showLegal) return;
    const seen = new Set();
    for (const tg of this.targets) {
      if (seen.has(tg.to)) continue;
      seen.add(tg.to);
      const el = this.h('div', { class: ['cb-dot', tg.capture && 'capture'] });
      this._place(el, tg.to);
      this.dotsEl.appendChild(el);
    }
  }

  setHint(hint) {
    this.hint = hint;
    this._renderHighlights();
    this._renderArrow();
  }

  _renderArrow() {
    this.arrowEl.textContent = '';
    const a = this.hint;
    if (!a) return;
    const ns = 'http://www.w3.org/2000/svg';
    const c = (sq) => {
      const [x, y] = this._xy(sq);
      return [x * 100 + 50, y * 100 + 50];
    };
    const [x1, y1] = c(a.from);
    const [x2, y2] = c(a.to);
    const pts = [[x1, y1]];
    const dx = Math.abs(x2 - x1);
    const dy = Math.abs(y2 - y1);
    // knight jumps get an L-shaped arrow
    if ((dx === 100 && dy === 200) || (dx === 200 && dy === 100)) pts.push(dx > dy ? [x2, y1] : [x1, y2]);
    pts.push([x2, y2]);
    // shorten the end so the head sits inside the target square
    const [px, py] = pts[pts.length - 2];
    const len = Math.hypot(x2 - px, y2 - py);
    const ux = (x2 - px) / len;
    const uy = (y2 - py) / len;
    const head = 34;
    const end = [x2 - ux * 18, y2 - uy * 18];
    const shaftEnd = [end[0] - ux * head * 0.9, end[1] - uy * head * 0.9];
    const start = pts[0];
    const sx = pts[1][0] - start[0];
    const sy = pts[1][1] - start[1];
    const sl = Math.hypot(sx, sy);
    const s0 = [start[0] + (sx / sl) * 22, start[1] + (sy / sl) * 22];
    const linePts = [s0, ...pts.slice(1, -1), shaftEnd];
    const path = document.createElementNS(ns, 'polyline');
    path.setAttribute('points', linePts.map((p) => p.join(',')).join(' '));
    path.setAttribute('class', 'cb-arrow-line');
    const nx = -uy;
    const ny = ux;
    const tip = end;
    const b1 = [tip[0] - ux * head + nx * head * 0.62, tip[1] - uy * head + ny * head * 0.62];
    const b2 = [tip[0] - ux * head - nx * head * 0.62, tip[1] - uy * head - ny * head * 0.62];
    const headEl = document.createElementNS(ns, 'polygon');
    headEl.setAttribute('points', [tip, b1, b2].map((p) => p.join(',')).join(' '));
    headEl.setAttribute('class', 'cb-arrow-head');
    const g = document.createElementNS(ns, 'g');
    g.setAttribute('class', 'cb-arrow');
    g.append(path, headEl);
    this.arrowEl.appendChild(g);
  }

  // ------------------------------------------------------------ selection
  select(sq) {
    if (!sq) {
      this.selected = null;
      this.targets = [];
    } else {
      const targets = this.getTargets(sq);
      if (!targets) {
        this.selected = null;
        this.targets = [];
      } else {
        this.selected = sq;
        this.targets = targets;
      }
    }
    this._renderHighlights();
    this._renderDots();
  }

  _target(sq) {
    return this.targets.find((tg) => tg.to === sq) || null;
  }

  _tryMove(from, to) {
    if (!this._target(to)) return false;
    this.selected = null;
    this.targets = [];
    this._renderDots();
    this.onMove(from, to);
    return true;
  }

  // ------------------------------------------------------------ pointer
  _hover(e) {
    if (this.drag || this._promo) return;
    const sq = this._squareAt(e.clientX, e.clientY);
    if (sq === this._hoverSq) return;
    this._hoverSq = sq;
    let grab = false;
    if (sq && this.interactive) {
      if (this.selected && this._target(sq)) grab = true;
      else if (this._pieceAt(sq)) {
        const tg = this.getTargets(sq);
        grab = !!(tg && tg.length);
      }
    }
    this.el.classList.toggle('can-grab', grab);
  }

  _pointerDown(e) {
    if (e.button !== 0 || this._promo) return;
    e.preventDefault(); // keep focus where it is (arrow keys keep browsing the move list)
    const sq = this._squareAt(e.clientX, e.clientY);
    if (!sq || !this.interactive) return;
    this.el.classList.remove('kb');
    const p = this._pieceAt(sq);
    // a click on a legal destination of the selected piece
    if (this.selected && sq !== this.selected && this._target(sq)) {
      this._tryMove(this.selected, sq);
      return;
    }
    const wasSelected = this.selected === sq;
    const targets = p ? this.getTargets(sq) : null;
    if (!targets) {
      this.select(null);
      return;
    }
    this.select(sq);
    const rect = this.el.getBoundingClientRect();
    this.drag = { from: sq, piece: p, startX: e.clientX, startY: e.clientY, rect, active: false, wasSelected, over: sq, pointerId: e.pointerId };
    const move = (ev) => this._pointerMove(ev);
    const up = (ev) => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      this._pointerUp(ev);
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    this._dragCleanup = () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
    };
  }

  _pointerMove(e) {
    const d = this.drag;
    if (!d) return;
    if (!d.active) {
      if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 4) return;
      d.active = true;
      d.piece.el.classList.add('dragging');
      this.el.classList.add('dragging-piece');
    }
    const sqSize = d.rect.width / 8;
    const x = e.clientX - d.rect.left - sqSize / 2;
    const y = e.clientY - d.rect.top - sqSize / 2;
    d.piece.el.style.setProperty('--drag-x', `${x}px`);
    d.piece.el.style.setProperty('--drag-y', `${y}px`);
    const over = this._squareAt(e.clientX, e.clientY);
    if (over !== d.over) {
      d.over = over;
      this._renderHighlights();
    }
  }

  _pointerUp(e) {
    const d = this.drag;
    this.drag = null;
    this.el.classList.remove('dragging-piece');
    if (!d) return;
    const sq = this._squareAt(e.clientX, e.clientY);
    if (d.active) {
      if (sq && sq !== d.from && this._target(sq)) {
        this._dropped = d.piece;
        // put the piece on its destination now (the app re-renders right after, or after the
        // promotion picker; a cancelled promotion slides it back)
        d.piece.el.classList.remove('dragging');
        d.piece.el.style.removeProperty('--drag-x');
        d.piece.el.style.removeProperty('--drag-y');
        d.piece.el.classList.add('no-anim');
        this._place(d.piece.el, sq);
        void d.piece.el.offsetWidth;
        d.piece.el.classList.remove('no-anim');
        d.piece.sq = sq;
        this._tryMove(d.from, sq);
        return;
      }
      // glide back to where it came from
      this._movePieceEl(d.piece.el, d.from, animOn());
      if (sq !== d.from) this.select(null);
      else this._renderHighlights();
      return;
    }
    // plain click on the already selected piece toggles it off
    if (d.wasSelected && sq === d.from) this.select(null);
  }

  _cancelDrag() {
    const d = this.drag;
    if (!d) return;
    this._dragCleanup?.();
    this.drag = null;
    this.el.classList.remove('dragging-piece');
    if (d.active) this._movePieceEl(d.piece.el, d.from, animOn());
    this._renderHighlights();
  }

  // ------------------------------------------------------------ keyboard
  _showCursor() {
    if (!this.el.matches(':focus-visible')) return;
    this.el.classList.add('kb');
    this._positionCursor();
  }

  _positionCursor() {
    this._place(this.cursorEl, this.cursor);
  }

  _key(e) {
    if (this._promo) return;
    const k = e.key;
    const dirs = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
    if (dirs[k] && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      this.el.classList.add('kb');
      let [dx, dy] = dirs[k];
      if (this.flipped) {
        dx = -dx;
        dy = -dy;
      }
      const [f, r] = sqXY(this.cursor);
      this.cursor = xyName(Math.max(0, Math.min(7, f + dx)), Math.max(0, Math.min(7, r + dy)));
      this._positionCursor();
      this.onCursor?.(this.cursor);
      return;
    }
    if ((k === 'Enter' || k === ' ') && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      this.el.classList.add('kb');
      if (!this.interactive) return;
      const sq = this.cursor;
      // a move is announced by the app; only a (de)selection describes the square again
      if (this.selected && sq !== this.selected && this._target(sq)) return void this._tryMove(this.selected, sq);
      if (this.selected === sq) this.select(null);
      else this.select(this._pieceAt(sq) ? sq : null);
      this.onCursor?.(this.cursor);
      return;
    }
    if (k === 'Escape' && this.selected) {
      e.preventDefault();
      e.stopPropagation();
      this.select(null);
    }
  }

  focusCursorOn(sq) {
    if (sq) this.cursor = sq;
    this._positionCursor();
  }

  // ------------------------------------------------------------ promotion picker
  // Resolves 'q' | 'r' | 'b' | 'n', or null when cancelled.
  askPromotion(square, color) {
    const { h, t } = this;
    this._cancelDrag();
    return new Promise((resolve) => {
      const [x, y] = this._xy(square);
      const down = y === 0; // the picker grows towards the centre of the board
      const choices = ['q', 'n', 'r', 'b'];
      const names = { q: t('pieces.queen'), r: t('pieces.rook'), b: t('pieces.bishop'), n: t('pieces.knight') };
      const btns = choices.map((c, i) =>
        h(
          'button',
          {
            class: 'cb-promo-btn',
            role: 'menuitem',
            dataset: { piece: c },
            'aria-label': names[c],
            title: `${names[c]} (${t(`pieces.key_${c}`)})`,
            onclick: (e) => {
              e.stopPropagation();
              done(c);
            },
          },
          h('span', { class: 'cb-promo-img', style: { backgroundImage: `url("${pieceUrl(color + c.toUpperCase())}")` } }),
        ),
      );
      const col = h(
        'div',
        {
          class: ['cb-promo-col', down ? 'down' : 'up'],
          role: 'menu',
          'aria-label': t('promotion.title'),
          style: { left: `${x * 12.5}%`, top: down ? '0' : 'auto', bottom: down ? 'auto' : '0' },
        },
        down ? btns : [...btns].reverse(),
      );
      const layer = h(
        'div',
        {
          class: 'cb-promo',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': t('promotion.title'),
          onpointerdown: (e) => {
            e.stopPropagation();
            if (e.target === layer) done(null);
          },
        },
        col,
      );
      const keyFor = {};
      for (const c of choices) keyFor[t(`pieces.key_${c}`).toLowerCase()] = c;
      Object.assign(keyFor, { q: 'q', r: 'r', b: 'b', n: 'n' });
      const onKey = (e) => {
        const k = e.key.toLowerCase();
        e.stopPropagation();
        if (e.key === 'Escape') {
          e.preventDefault();
          done(null);
        } else if (keyFor[k] && !e.ctrlKey && !e.altKey) {
          e.preventDefault();
          done(keyFor[k]);
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Tab') {
          e.preventDefault();
          const order = down ? btns : [...btns].reverse();
          const i = order.indexOf(document.activeElement);
          const delta = e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey) ? -1 : 1;
          order[(i + delta + order.length) % order.length].focus();
        }
      };
      layer.addEventListener('keydown', onKey);
      const prevFocus = document.activeElement;
      const done = (v) => {
        if (!this._promo) return;
        this._promo = null;
        layer.classList.add('closing');
        setTimeout(() => layer.remove(), animOn() ? 150 : 0);
        if (prevFocus && prevFocus.isConnected) prevFocus.focus?.({ preventScroll: true });
        resolve(v);
      };
      this._promo = { done };
      this.el.appendChild(layer);
      setTimeout(() => btns[0].focus({ preventScroll: true }), 20);
    });
  }

  cancelPromotion() {
    this._promo?.done(null);
  }

  get promoting() {
    return !!this._promo;
  }
}
