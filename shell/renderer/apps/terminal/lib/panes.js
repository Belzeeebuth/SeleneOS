// A tab's content: a tree of panes. Leaves hold a Session, splits hold two children side by side
// ('row', a vertical divider) or stacked ('col', a horizontal divider), with a draggable divider.
//   const tree = new PaneTree(app, viewEl);  tree.setRoot(session)
//   tree.split(session, 'row' | 'col', newSession)   tree.remove(session) -> remaining leaf | null
//   tree.neighbor(session, 'left'|'right'|'up'|'down')   tree.resize(session, dir, step)   tree.sessions()
const MIN_PANE = 48;

export class PaneTree {
  constructor(app, view) {
    this.app = app;
    this.h = app.ctx.h;
    this.view = view;
    this.root = null;
  }

  leaf(session) {
    const el = this.h('div', { class: 'tm-pane' });
    const node = { kind: 'leaf', session, el, parent: null };
    session.pane = el;
    el.appendChild(session.el);
    el.addEventListener('pointerdown', () => this.app.paneClicked(session), true);
    return node;
  }

  setRoot(session) {
    this.root = this.leaf(session);
    this.view.appendChild(this.root.el);
    return this.root;
  }

  find(session, node = this.root) {
    if (!node) return null;
    if (node.kind === 'leaf') return node.session === session ? node : null;
    return this.find(session, node.a) || this.find(session, node.b);
  }

  leaves(node = this.root, out = []) {
    if (!node) return out;
    if (node.kind === 'leaf') out.push(node);
    else {
      this.leaves(node.a, out);
      this.leaves(node.b, out);
    }
    return out;
  }

  sessions() {
    return this.leaves().map((l) => l.session);
  }

  get count() {
    return this.leaves().length;
  }

  replace(oldNode, newNode) {
    const p = oldNode.parent;
    newNode.parent = p;
    if (!p) {
      this.root = newNode;
    } else if (p.a === oldNode) p.a = newNode;
    else p.b = newNode;
  }

  applyRatio(split) {
    split.a.el.style.flex = `${split.ratio} 1 0`;
    split.b.el.style.flex = `${1 - split.ratio} 1 0`;
  }

  split(session, dir, newSession) {
    const target = this.find(session);
    if (!target) return null;
    const leaf = this.leaf(newSession);
    const el = this.h('div', { class: ['tm-split', dir] });
    const divider = this.h('div', { class: 'tm-divider', role: 'separator', 'aria-orientation': dir === 'row' ? 'vertical' : 'horizontal' });
    const split = { kind: 'split', dir, ratio: 0.5, a: target, b: leaf, el, divider, parent: null };
    target.el.replaceWith(el);
    this.replace(target, split);
    target.parent = split;
    leaf.parent = split;
    el.append(target.el, divider, leaf.el);
    this.applyRatio(split);
    divider.addEventListener('pointerdown', (e) => this.dragDivider(e, split));
    divider.addEventListener('dblclick', () => {
      split.ratio = 0.5;
      this.applyRatio(split);
    });
    if (document.documentElement.dataset.animations !== 'off') {
      const from = dir === 'row' ? 'translateX(16px)' : 'translateY(16px)';
      leaf.el.animate([{ opacity: 0, transform: from }, { opacity: 1, transform: 'none' }], { duration: 220, easing: 'cubic-bezier(0.1, 0.9, 0.2, 1)' });
    }
    return leaf;
  }

  // Removes a session's pane; returns the leaf that should get the focus (null when the tree is empty).
  remove(session) {
    const node = this.find(session);
    if (!node) return null;
    const p = node.parent;
    node.el.remove();
    if (!p) {
      this.root = null;
      return null;
    }
    const sibling = p.a === node ? p.b : p.a;
    p.el.replaceWith(sibling.el);
    sibling.el.style.flex = '';
    this.replace(p, sibling);
    if (sibling.parent) this.applyRatio(sibling.parent);
    let n = sibling;
    while (n.kind === 'split') n = n.a;
    return n;
  }

  dragDivider(e, split) {
    if (e.button !== 0) return;
    e.preventDefault();
    const div = split.divider;
    div.setPointerCapture(e.pointerId);
    div.classList.add('dragging');
    const r = split.el.getBoundingClientRect();
    const size = split.dir === 'row' ? r.width : r.height;
    const move = (ev) => {
      const pos = split.dir === 'row' ? ev.clientX - r.left : ev.clientY - r.top;
      const min = Math.min(0.45, MIN_PANE / Math.max(1, size));
      split.ratio = Math.max(min, Math.min(1 - min, pos / size));
      this.applyRatio(split);
    };
    const up = () => {
      div.classList.remove('dragging');
      div.removeEventListener('pointermove', move);
      div.removeEventListener('pointerup', up);
      div.removeEventListener('pointercancel', up);
    };
    div.addEventListener('pointermove', move);
    div.addEventListener('pointerup', up);
    div.addEventListener('pointercancel', up);
  }

  // Closest pane in a direction from the given one (by geometry, like Windows Terminal).
  neighbor(session, dir) {
    const from = this.find(session);
    if (!from) return null;
    const a = from.el.getBoundingClientRect();
    let best = null;
    let bestScore = Infinity;
    for (const leaf of this.leaves()) {
      if (leaf === from) continue;
      const b = leaf.el.getBoundingClientRect();
      let gap;
      let overlap;
      if (dir === 'left' || dir === 'right') {
        gap = dir === 'left' ? a.left - b.right : b.left - a.right;
        overlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      } else {
        gap = dir === 'up' ? a.top - b.bottom : b.top - a.bottom;
        overlap = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      }
      if (gap < -2 || overlap <= 0) continue;
      const score = gap * 1000 - overlap;
      if (score < bestScore) {
        bestScore = score;
        best = leaf;
      }
    }
    return best?.session || null;
  }

  // Alt+Shift+Arrow: move the nearest divider that lies in that direction.
  resize(session, dir, step = 0.05) {
    let node = this.find(session);
    const want = dir === 'left' || dir === 'right' ? 'row' : 'col';
    while (node?.parent) {
      const p = node.parent;
      if (p.dir === want) {
        const grow = dir === 'right' || dir === 'down' ? step : -step;
        const r = p.el.getBoundingClientRect();
        const size = want === 'row' ? r.width : r.height;
        const min = Math.min(0.45, MIN_PANE / Math.max(1, size));
        p.ratio = Math.max(min, Math.min(1 - min, p.ratio + grow));
        this.applyRatio(p);
        return true;
      }
      node = p;
    }
    return false;
  }

  // Direction a new pane should take for an automatic split: across the longer side.
  autoDir(session) {
    const node = this.find(session);
    if (!node) return 'row';
    const r = node.el.getBoundingClientRect();
    return r.width >= r.height ? 'row' : 'col';
  }
}
