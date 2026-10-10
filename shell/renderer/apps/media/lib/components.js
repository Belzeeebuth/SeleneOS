// Media Player UI building blocks: artwork, song lists (selection, keyboard, drag-reorder),
// tiles and grids, page headers and empty states.
import { artColors, formatTime } from './util.js';

export const ROW_MIME = 'application/x-aurora-media';

/** Artwork: cached image (art/thumbnail) or a generated gradient with a glyph. */
export function artEl(app, { src, key, kind = 'audio', glyph, round = false, wide = false, cls } = {}) {
  const { h, icon } = app;
  const [c1, c2] = artColors(key || src || 'aurora');
  const el = h('div', { class: ['mp-art', round && 'round', wide && 'wide', cls] });
  el.style.setProperty('--a1', c1);
  el.style.setProperty('--a2', c2);
  const gen = () => {
    el.classList.add('gen');
    el.appendChild(icon(glyph || (kind === 'video' ? 'video' : 'music_note_2'), { filled: true, class: 'mp-art-glyph' }));
  };
  if (src) {
    const img = h('img', { src: app.api.mediaUrl(src), alt: '', draggable: false, decoding: 'async', loading: 'lazy' });
    img.addEventListener('error', () => {
      img.remove();
      if (!el.classList.contains('gen')) gen();
    });
    el.appendChild(img);
  } else gen();
  return el;
}

export function entryArt(app, e, opts = {}) {
  if (!e) return artEl(app, { key: 'none', ...opts });
  return artEl(app, { src: e.kind === 'video' ? e.thumb : e.art, key: e.album || e.path, kind: e.kind, ...opts });
}

/** Equalizer glyph shown on the playing row. */
export function eqGlyph(h, paused) {
  return h('span', { class: ['mp-eq', paused && 'paused'], 'aria-hidden': 'true' }, h('i'), h('i'), h('i'));
}

export function pageHeader(app, title, { actions = [], sub, back } = {}) {
  const { h } = app;
  return h(
    'div',
    { class: 'mp-head' },
    h('div', { class: 'mp-head-text' }, h('h1', { class: 'mp-title ellipsis' }, title), sub ? h('div', { class: 'mp-sub text-2' }, sub) : null),
    actions.length ? h('div', { class: 'mp-head-actions' }, actions) : null,
  );
}

export function btn(app, { label, icon: ic, primary, subtle, onClick, tip, disabled, cls, iconOnly } = {}) {
  const { h, icon } = app;
  return h(
    'button',
    {
      class: ['btn', primary && 'primary', subtle && 'subtle', iconOnly && 'icon-btn', cls],
      'data-tip': tip || (iconOnly ? label : null),
      'aria-label': iconOnly ? label : null,
      disabled: !!disabled,
      onclick: (e) => onClick?.(e),
    },
    ic ? icon(ic) : null,
    iconOnly ? null : h('span', { class: 'ellipsis' }, label),
  );
}

export function emptyState(app, { glyph = 'music_note_2', title, body, actions = [], extra } = {}) {
  const { h, icon } = app;
  return h(
    'div',
    { class: 'mp-empty' },
    h('div', { class: 'mp-empty-art' }, icon(glyph, { filled: false })),
    h('div', { class: 'mp-empty-title' }, title),
    body ? h('div', { class: 'mp-empty-body text-2' }, body) : null,
    extra || null,
    actions.length ? h('div', { class: 'mp-empty-actions' }, actions) : null,
  );
}

export function sectionHead(app, title, { onSeeAll } = {}) {
  const { h, t } = app;
  return h(
    'div',
    { class: 'mp-section-head' },
    h('h2', { class: 'mp-section-title' }, title),
    onSeeAll ? h('button', { class: 'btn subtle small mp-see-all', onclick: onSeeAll }, t('home.seeAll'), app.icon('chevron_right', { size: 12 })) : null,
  );
}

// ------------------------------------------------------------------ tiles
export function tile(app, { art, title, subtitle, onOpen, onPlay, onMenu, wide, round, badge, path, cls } = {}) {
  const { h, icon, t } = app;
  const el = h(
    'div',
    { class: ['mp-tile', wide && 'wide', round && 'round', cls], tabindex: '0', role: 'listitem', 'aria-label': [title, subtitle].filter(Boolean).join(', '), dataset: path ? { path } : {} },
    h('div', { class: 'mp-tile-art' }, art, badge ? h('span', { class: 'mp-badge' }, badge) : null),
    h('div', { class: 'mp-tile-title ellipsis' }, title),
    subtitle ? h('div', { class: 'mp-tile-sub caption text-2 ellipsis' }, subtitle) : null,
  );
  if (onPlay) {
    const play = h(
      'button',
      {
        class: 'mp-tile-play',
        tabindex: '-1',
        'aria-label': t('menu.play'),
        'data-tip': t('menu.play'),
        onclick: (e) => {
          e.stopPropagation();
          onPlay(e);
        },
      },
      icon('play', { filled: true }),
    );
    el.querySelector('.mp-tile-art').appendChild(play);
  }
  if (onMenu) {
    const more = h(
      'button',
      {
        class: 'mp-tile-more',
        tabindex: '-1',
        'aria-label': t('transport.more'),
        'data-tip': t('transport.more'),
        onclick: (e) => {
          e.stopPropagation();
          onMenu(e);
        },
      },
      icon('more_horizontal'),
    );
    el.querySelector('.mp-tile-art').appendChild(more);
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      onMenu(e);
    });
  }
  el.addEventListener('click', () => onOpen?.());
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      onOpen?.();
    } else if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
      e.preventDefault();
      e.stopPropagation();
      onMenu?.(el);
    }
  });
  return el;
}

/** Grid with arrow-key navigation between tiles. */
export function grid(app, tiles, { wide = false, cls } = {}) {
  const el = app.h('div', { class: ['mp-grid', wide && 'wide', cls], role: 'list' }, tiles);
  el.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key) || e.altKey || e.ctrlKey) return;
    const items = [...el.querySelectorAll(':scope > .mp-tile')];
    const i = items.indexOf(document.activeElement);
    if (i < 0) return;
    const cols = Math.max(1, Math.round(el.clientWidth / (items[0].getBoundingClientRect().width || 1)));
    let j = i;
    if (e.key === 'ArrowLeft') j = i - 1;
    else if (e.key === 'ArrowRight') j = i + 1;
    else if (e.key === 'ArrowUp') j = i - cols;
    else if (e.key === 'ArrowDown') j = i + cols;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = items.length - 1;
    e.preventDefault();
    e.stopPropagation();
    items[Math.max(0, Math.min(items.length - 1, j))]?.focus();
  });
  return el;
}

// ------------------------------------------------------------------ song list
// items: library entries (or { path } for missing files). opts:
//   context: 'library' | 'album' | 'artist' | 'queue' | 'playlist' | 'search'
//   onPlay(index), onRemove(indexes), onMove(from, to), playlistId, trackNumbers, currentIndex()
//
// Windowed rendering: rows have a fixed height, so only the rows in (or near) the visible part of
// the page scroller exist in the DOM. A library of thousands of songs opens instantly and arrow
// keys stay O(visible rows). The keyboard-focused row is always kept rendered.
const ROW_H = 52; // keep in sync with .mp-row height in style.css
const ROW_GAP = 2;
const STRIDE = ROW_H + ROW_GAP;
const OVERSCAN = 8;

export class SongList {
  constructor(app, items, opts = {}) {
    this.app = app;
    this.items = items;
    this.opts = opts;
    this.sel = new Set();
    this.anchor = 0;
    this.focusIdx = 0;
    this.rendered = new Map(); // index -> row element
    this.listId = `l${Math.random().toString(36).slice(2, 8)}`;
    const { h } = app;
    this.el = h('div', { class: ['mp-songs', `ctx-${opts.context || 'library'}`], role: 'listbox', 'aria-multiselectable': 'true', 'aria-label': opts.label || '' });
    this.el.addEventListener('keydown', (e) => this._key(e));
    this.el.addEventListener('dragover', (e) => this._dragOver(e));
    this.el.addEventListener('dragleave', (e) => {
      if (!this.el.contains(e.relatedTarget)) this._clearDrop();
    });
    this.el.addEventListener('drop', (e) => this._drop(e));
    this._onScroll = () => {
      if (this._rafId) return;
      this._rafId = requestAnimationFrame(() => {
        this._rafId = 0;
        this.paint();
      });
    };
    this.render();
  }

  get length() {
    return this.items.length;
  }
  render() {
    for (const el of this.rendered.values()) el.remove();
    this.rendered.clear();
    this.el.style.height = this.items.length ? `${this.items.length * STRIDE - ROW_GAP}px` : '0px';
    this.paint();
  }

  /** Stop following the page scroller (the page was re-rendered or closed). */
  dispose() {
    this._scroller?.removeEventListener('scroll', this._onScroll);
    this._scroller = null;
    cancelAnimationFrame(this._rafId);
    this._rafId = 0;
  }

  _range() {
    const n = this.items.length;
    const sc = this.app.scroller;
    if (!this.el.isConnected || !sc?.clientHeight) return [0, Math.min(n, 40) - 1];
    const top = this.el.getBoundingClientRect().top - sc.getBoundingClientRect().top;
    const from = -top;
    const first = Math.max(0, Math.floor(from / STRIDE) - OVERSCAN);
    const last = Math.min(n - 1, Math.ceil((from + sc.clientHeight) / STRIDE) + OVERSCAN);
    return [first, last];
  }

  /** Create the rows that came into view, drop the ones far away (never the focused one). */
  paint() {
    if (this.el.isConnected && this._scroller !== this.app.scroller) {
      this._scroller?.removeEventListener('scroll', this._onScroll);
      this._scroller = this.app.scroller;
      this._scroller.addEventListener('scroll', this._onScroll, { passive: true });
    }
    const [first, last] = this._range();
    this._cur = this._currentIndex();
    const focused = document.activeElement;
    for (const [i, el] of this.rendered) {
      if (i >= first && i <= last) continue;
      if (el === focused || el.contains(focused) || el.classList.contains('drag-src')) continue;
      el.remove();
      this.rendered.delete(i);
    }
    for (let i = first; i <= last; i++) if (!this.rendered.has(i)) this._insert(i, this._row(this.items[i], i));
  }

  /** Put row i in the DOM in index order (keeps Tab / screen reader order and :focus intact). */
  _insert(i, el) {
    let next = null;
    let nextIdx = Infinity;
    for (const [k, r] of this.rendered) {
      if (k > i && k < nextIdx) {
        nextIdx = k;
        next = r;
      }
    }
    this.rendered.set(i, el);
    this.el.insertBefore(el, next);
  }

  /** Scroll the page so that row i is visible, and make sure it exists. */
  _reveal(i) {
    const sc = this.app.scroller;
    if (sc && this.el.isConnected) {
      const listTop = this.el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
      const top = listTop + i * STRIDE;
      const pad = 8;
      if (top < sc.scrollTop + pad) sc.scrollTop = Math.max(0, top - pad);
      else if (top + ROW_H > sc.scrollTop + sc.clientHeight - pad) sc.scrollTop = top + ROW_H - sc.clientHeight + pad;
    }
    this.paint();
    if (!this.rendered.has(i) && this.items[i]) this._insert(i, this._row(this.items[i], i));
    return this.rendered.get(i);
  }

  /** Re-render the rows showing these paths (metadata arrived). */
  update(paths) {
    const set = new Set(paths);
    this.items.forEach((e, i) => {
      if (!set.has(e.path)) return;
      const fresh = this.app.lib.get(e.path);
      if (fresh) this.items[i] = fresh;
      const old = this.rendered.get(i);
      if (!old) return;
      const row = this._row(this.items[i], i);
      const hadFocus = old === document.activeElement;
      old.replaceWith(row);
      this.rendered.set(i, row);
      if (hadFocus) row.focus({ preventScroll: true });
    });
  }

  /** Refresh the "now playing" highlight. */
  markPlaying() {
    const cur = (this._cur = this._currentIndex());
    const paused = this.app.player.paused;
    for (const [i, row] of this.rendered) {
      const on = i === cur;
      row.classList.toggle('playing', on);
      const lead = row.querySelector('.c-lead');
      lead.querySelector('.mp-eq')?.remove();
      if (on) lead.appendChild(eqGlyph(this.app.h, paused));
    }
  }

  _currentIndex() {
    if (this.opts.currentIndex) return this.opts.currentIndex();
    const p = this.app.currentPath();
    return p ? this.items.findIndex((e) => e.path === p) : -1;
  }

  _row(e, i) {
    const { app } = this;
    const { h, icon, t } = app;
    const ctx = this.opts.context || 'library';
    const isVideo = e.kind === 'video';
    const lead = h('div', { class: 'c-lead' });
    if (this.opts.trackNumbers) lead.appendChild(h('span', { class: 'mp-trackno text-2' }, e.track ? String(e.track) : '–'));
    else lead.appendChild(entryArt(app, e, { cls: isVideo ? 'thumb' : '' }));
    lead.appendChild(
      h(
        'button',
        {
          class: 'mp-row-play',
          tabindex: '-1',
          'aria-label': t('menu.play'),
          onclick: (ev) => {
            ev.stopPropagation();
            this.opts.onPlay?.(i);
          },
        },
        icon('play', { filled: true }),
      ),
    );
    const link = (text, onClick) =>
      onClick && text
        ? h(
            'span',
            {
              class: 'mp-link',
              onclick: (ev) => {
                ev.stopPropagation();
                onClick();
              },
            },
            text,
          )
        : text;
    const artist = app.artistOf(e);
    const album = isVideo ? '' : app.albumOf(e);
    const selected = this.sel.has(i);
    const row = h(
      'div',
      {
        class: ['mp-row', i % 2 === 0 && 'alt', selected && 'selected', e.bad && 'bad', isVideo && 'video'],
        role: 'option',
        tabindex: i === this.focusIdx ? '0' : '-1',
        draggable: 'true',
        dataset: { i: String(i), path: e.path },
        style: { top: `${i * STRIDE}px` },
        'aria-label': `${app.titleOf(e)}, ${artist}`,
        'aria-selected': selected ? 'true' : 'false',
        'aria-posinset': String(i + 1),
        'aria-setsize': String(this.items.length),
      },
      lead,
      h(
        'div',
        { class: 'c-title' },
        h('div', { class: 'ellipsis mp-row-title' }, app.titleOf(e)),
        h('div', { class: 'ellipsis caption text-2 mp-row-sub' }, [artist, album].filter(Boolean).join(' · ')),
      ),
      h('div', { class: 'c-artist ellipsis text-2' }, link(artist, !isVideo && app.artistKeyOf(e) != null ? () => app.go({ name: 'artist', arg: app.artistKeyOf(e) }) : null)),
      h('div', { class: 'c-album ellipsis text-2' }, link(album, !isVideo && ctx !== 'album' ? () => app.go({ name: 'album', arg: app.albumKeyOf(e) }) : null)),
      h('div', { class: 'c-genre ellipsis text-2' }, e.genre || ''),
      h('div', { class: 'c-year text-2' }, e.year ? String(e.year) : ''),
      h('div', { class: 'c-dur text-2' }, e.duration ? formatTime(e.duration) : ''),
      h(
        'div',
        { class: 'c-more' },
        h(
          'button',
          {
            class: 'btn subtle icon-btn mp-row-more',
            tabindex: '-1',
            'aria-label': t('transport.more'),
            'data-tip': t('transport.more'),
            onclick: (ev) => {
              ev.stopPropagation();
              if (!this.sel.has(i)) this._select(i, {});
              this._menu(ev);
            },
          },
          icon('more_horizontal'),
        ),
      ),
    );
    row.addEventListener('click', (ev) => this._select(i, ev));
    row.addEventListener('dblclick', () => this.opts.onPlay?.(i));
    row.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      if (!this.sel.has(i)) this._select(i, {});
      this._menu(ev);
    });
    row.addEventListener('dragstart', (ev) => this._dragStart(ev, i));
    row.addEventListener('dragend', () => {
      row.classList.remove('drag-src');
      this._clearDrop();
      this._dragFrom = null;
      this.app.dragPaths = null;
      this.app.endDrag?.();
    });
    if (i === (this._cur ?? this._currentIndex())) {
      row.classList.add('playing');
      lead.appendChild(eqGlyph(h, app.player.paused));
    }
    return row;
  }

  selected() {
    return [...this.sel].sort((a, b) => a - b);
  }
  /** Select and focus row i (keyboard focus restored after a re-render). */
  focusRow(i) {
    if (!this.items.length) return;
    i = Math.max(0, Math.min(this.items.length - 1, i));
    this._select(i, {}, true);
  }
  _select(i, ev, scroll = false) {
    if (ev.shiftKey) {
      const [a, b] = [Math.min(this.anchor, i), Math.max(this.anchor, i)];
      if (!ev.ctrlKey) this.sel.clear();
      for (let k = a; k <= b; k++) this.sel.add(k);
    } else if (ev.ctrlKey) {
      if (this.sel.has(i)) this.sel.delete(i);
      else this.sel.add(i);
      this.anchor = i;
    } else {
      this.sel = new Set([i]);
      this.anchor = i;
    }
    this._focus(i, scroll);
    this._syncSel();
  }
  _focus(i, scroll = true) {
    const n = this.items.length;
    if (!n) return;
    i = Math.max(0, Math.min(n - 1, i));
    this.rendered.get(this.focusIdx)?.setAttribute('tabindex', '-1');
    this.focusIdx = i;
    const row = scroll ? this._reveal(i) : this.rendered.get(i) || this._reveal(i);
    if (!row) return;
    row.setAttribute('tabindex', '0');
    row.focus({ preventScroll: true });
    // Rows scrolled far away can go now that the focus has moved on.
    if (scroll) this.paint();
  }
  _syncSel() {
    for (const [i, r] of this.rendered) {
      const on = this.sel.has(i);
      r.classList.toggle('selected', on);
      r.setAttribute('aria-selected', on ? 'true' : 'false');
    }
  }
  _menu(ev) {
    const idx = this.selected();
    const entries = idx.map((i) => this.items[i]);
    this.app.itemMenu(ev, entries, { context: this.opts.context, indexes: idx, playlistId: this.opts.playlistId, list: this });
  }
  _key(e) {
    if (e.target.closest('input, select, textarea')) return;
    const n = this.items.length;
    if (!n) return;
    const i = this.focusIdx;
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && e.altKey) {
      if (!this.opts.onMove) return;
      handled();
      const j = i + (e.key === 'ArrowUp' ? -1 : 1);
      if (j < 0 || j >= n) return;
      this.opts.onMove(i, j);
      this.sel = new Set([j]);
      this.anchor = j;
      this.focusIdx = j;
      return;
    }
    const nav = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: n - 1, PageDown: i + 10, PageUp: i - 10 }[e.key];
    if (nav !== undefined) {
      handled();
      const j = Math.max(0, Math.min(n - 1, nav));
      if (e.shiftKey) this._select(j, { shiftKey: true }, true);
      else if (e.ctrlKey) this._focus(j);
      else this._select(j, {}, true);
      return;
    }
    if (e.key === 'Enter') {
      handled();
      this.opts.onPlay?.(i);
    } else if (e.key === 'Delete' && this.opts.onRemove) {
      handled();
      const sel = this.selected();
      this.opts.onRemove(sel.length ? sel : [i]);
    } else if ((e.key === 'a' || e.key === 'A') && e.ctrlKey) {
      handled();
      this.sel = new Set(this.items.map((_, k) => k));
      this._syncSel();
    } else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      handled();
      if (!this.sel.has(i)) this._select(i, {}, true);
      this._menu(this.rendered.get(i) || this.el);
    }
  }

  // ---------------------------------------------------------------- drag & drop
  _dragStart(ev, i) {
    if (!this.sel.has(i)) this._select(i, {});
    ev.currentTarget?.classList?.add('drag-src');
    const idx = this.selected();
    const paths = idx.map((k) => this.items[k].path);
    ev.dataTransfer.effectAllowed = this.opts.onMove ? 'copyMove' : 'copy';
    ev.dataTransfer.setData(ROW_MIME, JSON.stringify({ paths, list: this.listId, from: idx.length === 1 ? i : -1 }));
    ev.dataTransfer.setData('text/plain', paths.join('\n'));
    this.app.dragPaths = paths;
    this._dragFrom = idx.length === 1 ? i : -1;
  }
  _rowAt(e) {
    const row = e.target.closest?.('.mp-row');
    if (!row || !this.el.contains(row)) return null;
    const r = row.getBoundingClientRect();
    return { row, i: Number(row.dataset.i), after: e.clientY > r.top + r.height / 2 };
  }
  _dragOver(e) {
    if (!this.opts.onMove || this._dragFrom == null || this._dragFrom < 0 || !e.dataTransfer.types.includes(ROW_MIME)) return;
    const hit = this._rowAt(e);
    if (!hit) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    this._clearDrop();
    hit.row.classList.add(hit.after ? 'drop-after' : 'drop-before');
  }
  _drop(e) {
    if (!this.opts.onMove || this._dragFrom == null || this._dragFrom < 0 || !e.dataTransfer.types.includes(ROW_MIME)) return;
    const hit = this._rowAt(e);
    this._clearDrop();
    if (!hit) return;
    e.preventDefault();
    e.stopPropagation();
    const from = this._dragFrom;
    let to = hit.i + (hit.after ? 1 : 0);
    if (from < to) to--;
    this._dragFrom = null;
    if (to !== from) this.opts.onMove(from, to);
  }
  _clearDrop() {
    this.el.querySelectorAll('.drop-before, .drop-after').forEach((r) => r.classList.remove('drop-before', 'drop-after'));
  }
}
