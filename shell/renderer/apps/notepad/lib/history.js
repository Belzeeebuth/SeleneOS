// Per-document undo / redo history.
//
// The shell is a single document shared by every app, so the browser's native textarea undo stack
// would mix edits from other apps' text fields. Notepad keeps its own history instead: every change
// is recorded as { pos, removed, inserted, selBefore, selAfter } and undone with setRangeText.
//
// Typing is grouped like Windows: a run of characters typed in one place is one step, broken at
// word boundaries, line breaks, caret moves and pauses. Programmatic edits (replace all, paste,
// time/date) are always their own step.

const MAX_STEPS = 2000;
const MAX_CHARS = 48 * 1024 * 1024; // total text kept in the history
const GROUP_MS = 1500;

let seq = 0;

export class History {
  constructor() {
    this.steps = [];
    this.index = 0; // number of applied steps
    this.chars = 0;
  }

  get canUndo() {
    return this.index > 0;
  }
  get canRedo() {
    return this.index < this.steps.length;
  }
  /** Identifies the current text version (0 = the text the history started from). */
  marker() {
    return this.index ? this.steps[this.index - 1].id : 0;
  }

  clear() {
    this.steps = [];
    this.index = 0;
    this.chars = 0;
  }

  /**
   * Record a change. kind: 'type' (single typed run), 'del-back', 'del-fwd' or 'edit'.
   * savedMarker: the marker at the last save — a saved step is never extended so the
   * document correctly turns dirty again.
   */
  push(change, kind = 'edit', savedMarker = null) {
    if (!change || (change.removed === '' && change.inserted === '')) return null;
    if (this.index < this.steps.length) {
      for (const s of this.steps.splice(this.index)) this.chars -= s.removed.length + s.inserted.length;
    }
    const now = Date.now();
    const last = this.steps[this.index - 1];
    if (last && last.id !== savedMarker && now - last.time < GROUP_MS && this._merge(last, change, kind)) {
      last.time = now;
      return last;
    }
    const step = { id: ++seq, kind, time: now, ...change };
    this.steps.push(step);
    this.index = this.steps.length;
    this.chars += step.removed.length + step.inserted.length;
    while (this.steps.length > 1 && (this.steps.length > MAX_STEPS || this.chars > MAX_CHARS)) {
      const s = this.steps.shift();
      this.chars -= s.removed.length + s.inserted.length;
      this.index--;
    }
    return step;
  }

  _merge(last, c, kind) {
    if (kind !== last.kind) return false;
    if (kind === 'type') {
      // Continue a typed run at its end, unless a new word starts after whitespace.
      if (c.removed !== '') return false;
      if (c.pos !== last.pos + last.inserted.length) return false;
      if (c.inserted.includes('\n')) return false;
      const prev = last.inserted.slice(-1);
      if (/\s/.test(prev) && !/\s/.test(c.inserted)) return false;
      last.inserted += c.inserted;
      this.chars += c.inserted.length;
      last.selAfter = c.selAfter;
      return true;
    }
    if (kind === 'del-back') {
      if (c.inserted !== '' || last.inserted !== '') return false;
      if (c.pos + c.removed.length !== last.pos) return false;
      if (c.removed.includes('\n') || last.removed.includes('\n')) return false;
      last.removed = c.removed + last.removed;
      last.pos = c.pos;
      this.chars += c.removed.length;
      last.selAfter = c.selAfter;
      return true;
    }
    if (kind === 'del-fwd') {
      if (c.inserted !== '' || last.inserted !== '') return false;
      if (c.pos !== last.pos) return false;
      if (c.removed.includes('\n') || last.removed.includes('\n')) return false;
      last.removed += c.removed;
      this.chars += c.removed.length;
      last.selAfter = c.selAfter;
      return true;
    }
    return false;
  }

  /** Step to revert (caller applies it), or null. */
  undo() {
    if (!this.canUndo) return null;
    const s = this.steps[--this.index];
    s.time = 0; // never merge into a step that was undone and redone
    return s;
  }
  redo() {
    if (!this.canRedo) return null;
    const s = this.steps[this.index++];
    s.time = 0;
    return s;
  }
}
