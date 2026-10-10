// Media Player play queue: pure logic (no DOM), unit-tested from Node (test/media.test.mjs).
//
//   const q = new PlayQueue({ rng });
//   q.set(['/a.mp3', '/b.mp3'], 0)        replace the queue, current = index 0
//   q.add(paths)  q.playNext(paths)        append / insert after the current item
//   q.removeAt(i) q.move(from, to) q.clear()
//   q.next({ auto }) q.prev() q.jump(i)    -> new index or -1 (auto = track ended by itself)
//   q.setShuffle(bool) q.setRepeat('off'|'all'|'one') q.cycleRepeat()
//   q.on(fn) -> unsubscribe ; fn(reason) after every change
//   q.toJSON() / PlayQueue.from(json, opts)
//
// Items are { uid, path } — the same file may be queued several times (distinct uids).
// Shuffle keeps the current item first and shuffles the rest (like Windows Media Player);
// turning it off restores the original order. Repeat 'one' only affects automatic advance.
let seq = 0;
export const newUid = () => `q${Date.now().toString(36)}${(++seq).toString(36)}`;

export const REPEAT_MODES = ['off', 'all', 'one'];

export class PlayQueue {
  constructor({ rng = Math.random } = {}) {
    this.items = [];
    this.index = -1;
    this.shuffle = false;
    this.repeat = 'off';
    this.order = null; // uids in unshuffled order while shuffle is on
    this.rng = rng;
    this._subs = new Set();
  }

  // ---------------------------------------------------------------- events
  on(fn) {
    this._subs.add(fn);
    return () => this._subs.delete(fn);
  }
  _emit(reason) {
    for (const fn of [...this._subs]) {
      try {
        fn(reason);
      } catch (err) {
        console.error('[media] queue listener failed', err);
      }
    }
  }

  // ---------------------------------------------------------------- accessors
  get length() {
    return this.items.length;
  }
  get current() {
    return this.items[this.index] || null;
  }
  indexOfUid(uid) {
    return this.items.findIndex((i) => i.uid === uid);
  }
  _mk(list) {
    return (list || [])
      .map((x) => (typeof x === 'string' ? { path: x } : x))
      .filter((x) => x && typeof x.path === 'string' && x.path)
      .map((x) => ({ uid: newUid(), path: x.path }));
  }
  _shuffleList(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
  _shuffleAroundCurrent() {
    const cur = this.current;
    const rest = this._shuffleList(this.items.filter((i) => i !== cur));
    this.items = cur ? [cur, ...rest] : rest;
    this.index = cur ? 0 : this.items.length ? 0 : -1;
  }

  // ---------------------------------------------------------------- editing
  /** Replace the queue. `start` is the index (in `list`) to make current. */
  set(list, start = 0) {
    this.items = this._mk(list);
    this.index = this.items.length ? Math.min(Math.max(0, start | 0), this.items.length - 1) : -1;
    this.order = null;
    if (this.shuffle && this.items.length) {
      this.order = this.items.map((i) => i.uid);
      this._shuffleAroundCurrent();
    }
    this._emit('set');
    return this.current;
  }
  add(list) {
    const items = this._mk(list);
    if (!items.length) return [];
    if (this.shuffle) {
      // New items join the shuffled upcoming part at random positions.
      for (const it of items) {
        const lo = this.index + 1;
        const at = lo + Math.floor(this.rng() * (this.items.length - lo + 1));
        this.items.splice(at, 0, it);
      }
      this.order?.push(...items.map((i) => i.uid));
    } else this.items.push(...items);
    this._emit('add');
    return items;
  }
  playNext(list) {
    const items = this._mk(list);
    if (!items.length) return [];
    const at = this.index + 1;
    this.items.splice(at, 0, ...items);
    if (this.order) {
      const cur = this.current;
      const oi = cur ? this.order.indexOf(cur.uid) : -1;
      this.order.splice(oi + 1, 0, ...items.map((i) => i.uid));
    }
    this._emit('add');
    return items;
  }
  /** Remove the item at i. Returns { removed, wasCurrent }. */
  removeAt(i) {
    if (i < 0 || i >= this.items.length) return { removed: null, wasCurrent: false };
    const [removed] = this.items.splice(i, 1);
    const wasCurrent = i === this.index;
    if (i < this.index) this.index--;
    else if (wasCurrent && this.index >= this.items.length) this.index = this.items.length - 1;
    if (!this.items.length) this.index = -1;
    if (this.order) this.order = this.order.filter((u) => u !== removed.uid);
    this._emit('remove');
    return { removed, wasCurrent };
  }
  remove(uid) {
    return this.removeAt(this.indexOfUid(uid));
  }
  /** Remove every queued copy of these paths (e.g. files that were deleted). */
  removePaths(paths) {
    const set = new Set(paths);
    let wasCurrent = false;
    for (let i = this.items.length - 1; i >= 0; i--) {
      if (set.has(this.items[i].path)) wasCurrent = this.removeAt(i).wasCurrent || wasCurrent;
    }
    return wasCurrent;
  }
  move(from, to) {
    const n = this.items.length;
    if (from < 0 || from >= n) return false;
    to = Math.max(0, Math.min(n - 1, to));
    if (from === to) return false;
    const [it] = this.items.splice(from, 1);
    this.items.splice(to, 0, it);
    if (from === this.index) this.index = to;
    else if (from < this.index && to >= this.index) this.index--;
    else if (from > this.index && to <= this.index) this.index++;
    this._emit('move');
    return true;
  }
  clear() {
    this.items = [];
    this.index = -1;
    this.order = null;
    this._emit('clear');
  }

  // ---------------------------------------------------------------- navigation
  peekNext({ auto = false } = {}) {
    if (!this.items.length) return -1;
    if (auto && this.repeat === 'one' && this.index >= 0) return this.index;
    if (this.index + 1 < this.items.length) return this.index + 1;
    if (this.repeat !== 'off') return 0;
    return -1;
  }
  peekPrev() {
    if (!this.items.length) return -1;
    if (this.index > 0) return this.index - 1;
    if (this.repeat !== 'off') return this.items.length - 1;
    return 0;
  }
  next(opts) {
    const i = this.peekNext(opts);
    if (i >= 0) {
      this.index = i;
      this._emit('index');
    }
    return i;
  }
  prev() {
    const i = this.peekPrev();
    if (i >= 0) {
      this.index = i;
      this._emit('index');
    }
    return i;
  }
  jump(i) {
    if (i < 0 || i >= this.items.length) return -1;
    this.index = i;
    this._emit('index');
    return i;
  }

  // ---------------------------------------------------------------- modes
  setShuffle(on) {
    on = !!on;
    if (on === this.shuffle) return;
    this.shuffle = on;
    if (on) {
      this.order = this.items.map((i) => i.uid);
      this._shuffleAroundCurrent();
    } else if (this.order) {
      const cur = this.current;
      const byUid = new Map(this.items.map((i) => [i.uid, i]));
      const restored = this.order.map((u) => byUid.get(u)).filter(Boolean);
      for (const it of this.items) if (!this.order.includes(it.uid)) restored.push(it);
      this.items = restored;
      this.index = cur ? this.items.indexOf(cur) : this.items.length ? 0 : -1;
      this.order = null;
    }
    this._emit('shuffle');
  }
  setRepeat(mode) {
    if (!REPEAT_MODES.includes(mode) || mode === this.repeat) return;
    this.repeat = mode;
    this._emit('repeat');
  }
  cycleRepeat() {
    this.setRepeat(REPEAT_MODES[(REPEAT_MODES.indexOf(this.repeat) + 1) % REPEAT_MODES.length]);
    return this.repeat;
  }

  // ---------------------------------------------------------------- persistence
  toJSON() {
    return {
      items: this.items.map(({ uid, path }) => ({ uid, path })),
      index: this.index,
      shuffle: this.shuffle,
      repeat: this.repeat,
      order: this.order ? [...this.order] : null,
    };
  }
  static from(json, opts) {
    const q = new PlayQueue(opts);
    if (!json || typeof json !== 'object') return q;
    const items = Array.isArray(json.items) ? json.items.filter((i) => i && typeof i.path === 'string') : [];
    q.items = items.map((i) => ({ uid: typeof i.uid === 'string' ? i.uid : newUid(), path: i.path }));
    // Duplicate uids (hand-edited state) would break remove/move: re-key them.
    const seen = new Set();
    for (const it of q.items) {
      if (seen.has(it.uid)) it.uid = newUid();
      seen.add(it.uid);
    }
    q.index = Number.isInteger(json.index) && json.index >= 0 && json.index < q.items.length ? json.index : q.items.length ? 0 : -1;
    q.shuffle = !!json.shuffle;
    q.repeat = REPEAT_MODES.includes(json.repeat) ? json.repeat : 'off';
    q.order = q.shuffle && Array.isArray(json.order) ? json.order.filter((u) => seen.has(u)) : q.shuffle ? q.items.map((i) => i.uid) : null;
    return q;
  }
}
