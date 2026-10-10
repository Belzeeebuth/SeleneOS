// Snapshot undo / redo for the Notes editor. The browser's native contenteditable history breaks as
// soon as a script touches the DOM (Markdown shortcuts, checklists, pictures...), so the editor keeps its
// own: a snapshot (innerHTML + selection path) per step. Typing is grouped by word / pause.
import { saveSelection, restoreSelection } from './dom.js';

const MAX = 300;

export class History {
  constructor(root, { onRestore } = {}) {
    this.root = root;
    this.onRestore = onRestore;
    this.stack = [];
    this.index = -1;
    this.timer = null;
  }

  reset() {
    clearTimeout(this.timer);
    this.stack = [{ html: this.root.innerHTML, sel: saveSelection(this.root) }];
    this.index = 0;
  }

  /** Snapshot the current state if it differs from the current step (otherwise refresh its selection). */
  record() {
    clearTimeout(this.timer);
    this.timer = null;
    const html = this.root.innerHTML;
    const sel = saveSelection(this.root);
    const cur = this.stack[this.index];
    if (cur && cur.html === html) {
      if (sel) cur.sel = sel;
      return false;
    }
    this.stack.splice(this.index + 1);
    this.stack.push({ html, sel });
    if (this.stack.length > MAX) this.stack.shift();
    this.index = this.stack.length - 1;
    return true;
  }

  /** Typing: snapshot after a short pause. */
  typed(boundary = false) {
    clearTimeout(this.timer);
    if (boundary) this.record();
    else this.timer = setTimeout(() => this.record(), 700);
  }

  get canUndo() {
    return this.index > 0 || (this.stack[this.index] && this.stack[this.index].html !== this.root.innerHTML);
  }
  get canRedo() {
    return this.index < this.stack.length - 1;
  }

  undo() {
    this.record(); // pending typing becomes its own step
    if (this.index <= 0) return false;
    this.index--;
    this.apply(this.stack[this.index]);
    return true;
  }

  redo() {
    if (this.timer) this.record();
    if (this.index >= this.stack.length - 1) return false;
    this.index++;
    this.apply(this.stack[this.index]);
    return true;
  }

  apply(state) {
    this.root.innerHTML = state.html;
    restoreSelection(this.root, state.sel);
    this.onRestore?.(state);
  }
}
