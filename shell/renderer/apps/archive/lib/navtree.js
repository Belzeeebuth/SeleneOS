// Navigation pane: the archive's folder tree (like Explorer's navigation pane). Children are rendered
// when a folder is expanded; arrows / Home / End / Enter / Space work like a Windows tree view.
import { ancestors } from './util.js';

export class NavTree {
  constructor(w) {
    this.w = w;
    const { h } = w;
    this.expanded = new Set(['']);
    this.root = null;
    this.current = null;
    this.focusPath = '';
    this.el = h('div', { class: 'arc-tree', role: 'tree', tabindex: '0', 'aria-label': w.t('nav.label') });
    this.el.addEventListener('keydown', (e) => this.onKey(e));
    this.el.addEventListener('focus', () => this.paintFocus());
  }

  setRoot(root, name) {
    this.root = root;
    this.rootName = name;
    this.expanded = new Set(['']);
    this.render();
  }

  select(node) {
    this.current = node;
    for (const a of ancestors(node)) if (a !== node) this.expanded.add(a.path);
    this.focusPath = node.path;
    this.render();
    const el = this.el.querySelector(`[data-path="${CSS.escape(node.path)}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }

  visible() {
    const out = [];
    const walk = (n, depth) => {
      out.push({ n, depth });
      if (this.expanded.has(n.path)) for (const c of this.sorted(n)) walk(c, depth + 1);
    };
    if (this.root) walk(this.root, 0);
    return out;
  }
  sorted(n) {
    const coll = new Intl.Collator(this.w.i18n.locale, { numeric: true, sensitivity: 'base' });
    return [...n.children.values()].filter((c) => c.dir).sort((a, b) => coll.compare(a.name, b.name));
  }

  render() {
    const { h, icon } = this.w;
    this.el.replaceChildren();
    let idx = 0;
    for (const { n, depth } of this.visible()) {
      const hasKids = [...n.children.values()].some((c) => c.dir);
      const open = this.expanded.has(n.path);
      const chev = h(
        'span',
        {
          class: ['arc-tchev', open && 'open', !hasKids && 'none'],
          onclick: (e) => {
            e.stopPropagation();
            if (hasKids) this.toggle(n);
          },
        },
        hasKids ? icon('chevron_right', { size: 12 }) : null,
      );
      const img = n === this.root ? 'app://shell/apps/archive/icons/file-archive.svg' : 'app://shell/apps/archive/icons/folder.svg';
      const row = h(
        'div',
        {
          class: ['arc-tnode', n === this.current && 'selected', n.path === this.focusPath && 'focused'],
          id: `${this.w.uid}-t${idx++}`,
          role: 'treeitem',
          'aria-level': String(depth + 1),
          'aria-expanded': hasKids ? String(open) : null,
          'aria-selected': String(n === this.current),
          dataset: { path: n.path },
          style: { paddingLeft: `${6 + depth * 16}px` },
          onclick: () => {
            this.focusPath = n.path;
            this.w.navigate(n);
          },
          ondblclick: () => hasKids && this.toggle(n),
        },
        chev,
        h('img', { class: 'arc-tic', src: img, alt: '', draggable: false }),
        h('span', { class: 'arc-tlabel ellipsis' }, n === this.root ? this.rootName : n.name),
      );
      this.el.appendChild(row);
    }
    this.paintFocus();
  }
  toggle(n) {
    if (this.expanded.has(n.path) && n !== this.root) this.expanded.delete(n.path);
    else this.expanded.add(n.path);
    this.render();
  }
  paintFocus() {
    let active = null;
    for (const el of this.el.querySelectorAll('.arc-tnode')) {
      const on = el.dataset.path === this.focusPath;
      el.classList.toggle('focused', on);
      if (on) active = el.id;
    }
    // screen readers follow the focused row (the tree itself keeps the keyboard focus)
    if (active) this.el.setAttribute('aria-activedescendant', active);
    else this.el.removeAttribute('aria-activedescendant');
  }

  onKey(e) {
    const vis = this.visible();
    let i = vis.findIndex((v) => v.n.path === this.focusPath);
    if (i < 0) i = 0;
    const cur = vis[i]?.n;
    if (!cur) return;
    const go = (j) => {
      j = Math.max(0, Math.min(vis.length - 1, j));
      this.focusPath = vis[j].n.path;
      this.paintFocus();
      this.el.querySelector(`[data-path="${CSS.escape(this.focusPath)}"]`)?.scrollIntoView({ block: 'nearest' });
    };
    const hasKids = [...cur.children.values()].some((c) => c.dir);
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        go(i + 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        go(i - 1);
        break;
      case 'Home':
        e.preventDefault();
        go(0);
        break;
      case 'End':
        e.preventDefault();
        go(vis.length - 1);
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (hasKids && !this.expanded.has(cur.path)) {
          this.expanded.add(cur.path);
          this.render();
        } else if (hasKids) go(i + 1);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (this.expanded.has(cur.path) && cur !== this.root && hasKids) {
          this.expanded.delete(cur.path);
          this.render();
        } else if (cur.parent) {
          this.focusPath = cur.parent.path;
          this.paintFocus();
        }
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        this.w.navigate(cur);
        break;
      default:
        break;
    }
  }
}
