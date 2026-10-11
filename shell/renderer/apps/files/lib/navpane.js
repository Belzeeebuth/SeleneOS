// Navigation pane (sidebar): Home, then three labelled sections — Favorites (pinned folders),
// Places (home folder, Computer as an expandable tree, Trash) and Devices (drives) — and a
// system-disk usage meter at the bottom. Keyboard navigable tree, drop targets with spring-loaded expansion.
import { shared, isPinned, pin, unpin, movePin } from './shared.js';
import * as T from './types.js';
import * as ops from './ops.js';
import { TRASH_TARGET } from './dnd.js';

let treeSeq = 0;
// Reordering pinned folders by dragging them in the navigation pane (Windows 11 does the same). The
// drag only carries this private type: dropping a pin somewhere else never moves the real folder.
const PIN_MIME = 'application/x-aurora-pin';

export class NavPane {
  constructor(ex) {
    this.ex = ex;
    const { h, t } = ex;
    this.uid = `fxt${++treeSeq}`;
    this.tree = h('div', { class: 'fx-tree', role: 'tree', tabindex: '0', 'aria-label': t('nav.label') });
    this.disk = h('div', { class: 'fx-disk', hidden: true });
    this.el = h('nav', { class: 'fx-nav' }, this.tree, this.disk);
    this.expanded = new Set();
    this.children = new Map(); // node id -> [node]
    this.loading = new Set();
    this.rows = [];
    this.focusId = null;
    this.selectedId = null;
    this.lastClickedId = null;
    this.trashFull = false;
    this.kbd = false;
    this.bind();
    this.updateTrash();
  }

  // ---------------------------------------------------------------- model
  roots() {
    const t = this.ex.t;
    const nodes = [
      { id: 'home', label: t('places.home'), icon: T.iconPath('home'), loc: { type: 'home' }, level: 1 },
    ];
    if (shared.pinned.length) nodes.push({ section: t('nav.favorites') });
    shared.pinned.forEach((p, i) => {
      nodes.push(this.folderNode(`pin${i}`, p, 1, { pinned: true, label: this.knownLabel(p) }));
    });
    nodes.push({ section: t('nav.places') });
    nodes.push(this.folderNode('loc', shared.home, 1, { label: t('places.personal'), icon: T.iconPath('folder-home') }));
    nodes.push({ id: 'thispc', label: t('places.thisPc'), icon: T.THIS_PC_ICON, loc: { type: 'thispc' }, level: 1, expandable: true });
    nodes.push({ id: 'trash', label: t('places.trash'), icon: this.trashFull ? T.iconPath('trash-full') : T.TRASH_ICON, loc: { type: 'trash' }, level: 1, trash: true });
    // Devices: the drives other than the system disk (the meter at the bottom covers that one).
    const devices = shared.drives.filter((d) => d.mountpoint !== '/' && d.kind !== 'system');
    if (devices.length) nodes.push({ section: t('nav.devices') });
    for (const d of devices) {
      nodes.push({
        id: `dev|${d.id}`,
        prefix: 'dev',
        label: T.driveName(d, t),
        icon: T.driveIcon(d),
        loc: d.mountpoint ? { type: 'dir', path: d.mountpoint } : null,
        path: d.mountpoint || null,
        drive: d,
        level: 1,
        expandable: !!d.mountpoint,
      });
    }
    return nodes;
  }

  knownLabel(p) {
    const k = T.knownFolder(p);
    if (k && k !== 'home') return this.ex.t(`places.${k}`);
    return T.basename(p);
  }

  folderNode(prefix, p, level, extra = {}) {
    return {
      id: `${prefix}|${p}`,
      prefix,
      label: extra.label || T.basename(p),
      icon: T.iconFor({ dir: true, path: p }),
      loc: { type: 'dir', path: p },
      path: p,
      level,
      expandable: true,
      ...extra,
    };
  }

  thisPcChildren() {
    const t = this.ex.t;
    const x = shared.xdg;
    const list = [this.folderNode('pc', shared.home, 2, { label: T.basename(shared.home) })];
    for (const k of ['desktop', 'documents', 'downloads', 'music', 'pictures', 'videos']) list.push(this.folderNode('pc', x[k], 2, { label: t(`places.${k}`) }));
    for (const d of shared.drives) {
      list.push({
        id: `drive|${d.id}`,
        prefix: 'pc',
        label: T.driveName(d, t),
        icon: T.driveIcon(d),
        loc: d.mountpoint ? { type: 'dir', path: d.mountpoint } : null,
        path: d.mountpoint || null,
        drive: d,
        level: 2,
        expandable: !!d.mountpoint,
      });
    }
    return list;
  }

  async loadChildren(node) {
    if (node.id === 'thispc') {
      this.children.set(node.id, this.thisPcChildren());
      return;
    }
    if (!node.path) return;
    this.loading.add(node.id);
    try {
      const list = await this.ex.api.invoke('fs:list', node.path, { hidden: shared.prefs.hidden });
      const prefix = node.prefix || 'x';
      this.children.set(node.id, list.filter((e) => e.dir).map((e) => this.folderNode(prefix, e.path, node.level + 1)));
    } catch {
      this.children.set(node.id, []);
    } finally {
      this.loading.delete(node.id);
    }
  }

  async toggle(node, open = !this.expanded.has(node.id)) {
    if (!node?.expandable) return;
    if (open) {
      this.expanded.add(node.id);
      this.render();
      await this.loadChildren(node);
    } else this.expanded.delete(node.id);
    this.render();
  }

  // Re-read children of expanded nodes showing `path` (after creating/deleting folders).
  async refreshPath(path) {
    const hits = this.rows.filter((r) => r.node.path === path && this.expanded.has(r.node.id));
    if (!hits.length) return;
    for (const r of hits) await this.loadChildren(r.node);
    this.render();
  }

  async refreshAll() {
    for (const id of [...this.expanded]) {
      const row = this.rows.find((r) => r.node.id === id);
      if (row) await this.loadChildren(row.node);
    }
    this.render();
  }

  async updateTrash() {
    try {
      const list = await this.ex.api.invoke('fs:trashList');
      const full = list.length > 0;
      if (full !== this.trashFull) {
        this.trashFull = full;
        this.render();
      }
    } catch {}
  }

  // ---------------------------------------------------------------- render
  render() {
    const { h, icon } = this.ex;
    const scroll = this.tree.scrollTop;
    this.rows = [];
    const frag = document.createDocumentFragment();
    let n = 0;
    const walk = (nodes) => {
      for (const node of nodes) {
        if (node.section) {
          frag.append(h('div', { class: 'fx-tsec', role: 'presentation' }, node.section));
          continue;
        }
        const open = this.expanded.has(node.id);
        const kids = this.children.get(node.id);
        const leaf = kids && kids.length === 0 && !this.loading.has(node.id);
        const id = `${this.uid}-${n++}`;
        const el = h('div', {
          class: ['fx-tnode', node.id === this.selectedId && 'selected', this.kbd && node.id === this.focusId && 'focused', node.drive && !node.drive.mounted && 'dim'],
          id,
          role: 'treeitem',
          'aria-level': String(node.level),
          'aria-selected': String(node.id === this.selectedId),
          'aria-expanded': node.expandable && !leaf ? String(open) : null,
          dataset: { id: node.id },
          style: { '--lvl': String(node.level - 1) },
          title: node.path || '',
          draggable: node.pinned ? 'true' : 'false',
        },
        h('span', { class: ['fx-tchev', (!node.expandable || leaf) && 'none', open && 'open'] }, icon('chevron_right', { size: 12 })),
        h('img', { class: 'fx-tic', src: node.icon, alt: '', draggable: false }),
        h('span', { class: 'fx-tlabel ellipsis' }, node.label),
        node.pinned ? h('span', { class: 'fx-tpin', 'aria-hidden': 'true' }, icon('pin', { size: 12 })) : null);
        this.rows.push({ node, el, id });
        frag.append(el);
        if (open && kids) walk(kids);
        else if (open && this.loading.has(node.id)) frag.append(h('div', { class: 'fx-tloading', style: { '--lvl': String(node.level) } }, h('span', { class: 'spinner small' })));
      }
    };
    walk(this.roots());
    this.tree.replaceChildren(frag);
    this.tree.scrollTop = scroll;
    this.renderDisk();
    const f = this.rows.find((r) => r.node.id === this.focusId);
    if (f) this.tree.setAttribute('aria-activedescendant', f.id);
  }

  // Usage of the disk that holds the home folder: a thin meter and "x free of y".
  renderDisk() {
    const { h, t } = this.ex;
    const drives = shared.drives.filter((d) => d.mounted !== false && d.mountpoint && d.size);
    const d = drives.filter((x) => shared.home === x.mountpoint || T.isInside(shared.home, x.mountpoint) || x.mountpoint === '/')
      .sort((a, b) => b.mountpoint.length - a.mountpoint.length)[0];
    if (!d || d.free == null) {
      this.disk.hidden = true;
      return;
    }
    const used = Math.max(0, d.size - d.free);
    const pct = Math.round((used / d.size) * 100);
    const label = t('nav.disk');
    this.disk.hidden = false;
    this.disk.replaceChildren(
      h('div', { class: 'fx-disk-head' }, h('span', { class: 'fx-disk-name' }, label), h('span', { class: 'fx-disk-pct' }, `${pct} %`)),
      h('div', { class: ['fx-disk-bar', pct > 90 && 'full'], role: 'meter', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct), 'aria-valuetext': t('nav.diskUsed', { pct }) },
        h('div', { class: 'fill', style: { width: `${Math.max(1, pct)}%` } })),
      h('div', { class: 'fx-disk-free' }, t('nav.diskFree', { free: T.humanSize(d.free, t), size: T.humanSize(d.size, t) })));
  }

  // Highlight the node of the current location.
  sync(loc) {
    const key = this.ex.locKey(loc.type === 'search' ? loc.root : loc);
    const match = (r) => r.node.loc && this.ex.locKey(r.node.loc) === key;
    let row = this.rows.find((r) => r.node.id === this.lastClickedId && match(r));
    if (!row) row = this.rows.find(match);
    this.selectedId = row ? row.node.id : null;
    if (row) this.focusId = row.node.id;
    for (const r of this.rows) {
      const on = r.node.id === this.selectedId;
      r.el.classList.toggle('selected', on);
      r.el.setAttribute('aria-selected', String(on));
      r.el.classList.toggle('focused', !!(this.kbd && r.node.id === this.focusId));
    }
  }

  // ---------------------------------------------------------------- events
  rowOf(target) {
    const el = target.closest?.('.fx-tnode');
    return el ? this.rows.find((r) => r.el === el) : null;
  }

  bind() {
    const tr = this.tree;
    tr.addEventListener('pointerdown', (e) => {
      const row = this.rowOf(e.target);
      this.kbd = false;
      if (!row) return;
      if (e.button === 0 && e.target.closest('.fx-tchev')) {
        e.preventDefault();
        this.focusId = row.node.id;
        this.toggle(row.node);
      }
    });
    tr.addEventListener('click', (e) => {
      const row = this.rowOf(e.target);
      if (!row || e.target.closest('.fx-tchev')) return;
      this.activate(row.node);
    });
    tr.addEventListener('dblclick', (e) => {
      const row = this.rowOf(e.target);
      if (row && !e.target.closest('.fx-tchev') && row.node.expandable) this.toggle(row.node);
    });
    tr.addEventListener('auxclick', (e) => {
      const row = this.rowOf(e.target);
      if (e.button === 1 && row?.node.loc) {
        e.preventDefault();
        this.ex.newTab(row.node.loc, { activate: false });
      }
    });
    tr.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const row = this.rowOf(e.target);
      if (row) this.menu(e, row.node);
    });
    tr.addEventListener('keydown', (e) => this.onKey(e));
    this.bindPinDrag();
    this.ex.dnd.dropTarget(tr, (e) => {
      const row = this.rowOf(e.target);
      if (!row) return null;
      this.springLoad(row.node);
      if (row.node.trash) return TRASH_TARGET;
      if (row.node.drive && !row.node.drive.mounted) return null;
      return row.node.path || null;
    }, { mark: (e) => this.rowOf(e.target)?.el || null });
    tr.addEventListener('dragleave', (e) => {
      if (!tr.contains(e.relatedTarget)) {
        clearTimeout(this.springTimer);
        this.springId = null;
      }
    });
  }

  bindPinDrag() {
    const tr = this.tree;
    tr.addEventListener('dragstart', (e) => {
      const row = this.rowOf(e.target);
      if (!row?.node.pinned || !row.node.path) {
        e.preventDefault();
        return;
      }
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData(PIN_MIME, row.node.path);
      this.pinDrag = row.node.path;
    });
    tr.addEventListener('dragend', () => {
      this.pinDrag = null;
      this.markPin(null);
    });
    // Capture phase: a pin being reordered never reaches the folder drop targets of the tree.
    const where = (e) => {
      const row = this.rowOf(e.target);
      if (!row?.node.pinned) return null;
      const r = row.el.getBoundingClientRect();
      return { row, after: e.clientY > r.top + r.height / 2 };
    };
    tr.addEventListener('dragenter', (e) => {
      if (!this.pinDrag) return;
      e.preventDefault();
      e.stopPropagation();
    }, true);
    tr.addEventListener('dragover', (e) => {
      if (!this.pinDrag) return;
      e.preventDefault();
      e.stopPropagation();
      const w = where(e);
      e.dataTransfer.dropEffect = w ? 'move' : 'none';
      this.markPin(w?.row.el || null, w?.after);
    }, true);
    tr.addEventListener('drop', (e) => {
      if (!this.pinDrag) return;
      e.preventDefault();
      e.stopPropagation();
      const from = this.pinDrag;
      this.pinDrag = null;
      this.markPin(null);
      const w = where(e);
      if (!w || w.row.node.path === from) return;
      const rest = shared.pinned.filter((p) => p !== from);
      const at = rest.indexOf(w.row.node.path);
      if (at >= 0) movePin(from, at + (w.after ? 1 : 0));
    }, true);
  }

  markPin(el, after = false) {
    if (this.pinMarked && this.pinMarked !== el) this.pinMarked.classList.remove('pin-before', 'pin-after');
    this.pinMarked = el;
    if (!el) return;
    el.classList.toggle('pin-before', !after);
    el.classList.toggle('pin-after', !!after);
  }

  springLoad(node) {
    if (this.springId === node.id) return;
    this.springId = node.id;
    clearTimeout(this.springTimer);
    if (!node.expandable || this.expanded.has(node.id)) return;
    this.springTimer = setTimeout(() => {
      if (this.springId === node.id) this.toggle(node, true);
    }, 800);
  }

  activate(node) {
    this.lastClickedId = node.id;
    this.focusId = node.id;
    if (node.drive && !node.drive.mounted) {
      this.ex.openDrive(node.drive);
      return;
    }
    if (node.loc) this.ex.navigate(node.loc);
  }

  onKey(e) {
    const rows = this.rows;
    if (!rows.length) return;
    let i = rows.findIndex((r) => r.node.id === this.focusId);
    if (i < 0) i = Math.max(0, rows.findIndex((r) => r.node.id === this.selectedId));
    const row = rows[i];
    const k = e.key;
    const move = (j) => {
      j = Math.max(0, Math.min(rows.length - 1, j));
      this.kbd = true;
      this.focusId = rows[j].node.id;
      rows.forEach((r) => r.el.classList.toggle('focused', r === rows[j]));
      this.tree.setAttribute('aria-activedescendant', rows[j].id);
      rows[j].el.scrollIntoView({ block: 'nearest' });
    };
    if (k === 'ArrowDown') move(i + 1);
    else if (k === 'ArrowUp') move(i - 1);
    else if (k === 'Home') move(0);
    else if (k === 'End') move(rows.length - 1);
    else if (k === 'ArrowRight') {
      if (row.node.expandable && !this.expanded.has(row.node.id)) this.toggle(row.node, true).then(() => move(rows.indexOf(rows.find((r) => r.node.id === row.node.id))));
      else if (this.expanded.has(row.node.id)) move(i + 1);
    } else if (k === 'ArrowLeft') {
      if (this.expanded.has(row.node.id)) this.toggle(row.node, false).then(() => {
        const j = this.rows.findIndex((r) => r.node.id === row.node.id);
        move(j);
      });
      else {
        for (let j = i - 1; j >= 0; j--) {
          if (rows[j].node.level < row.node.level) {
            move(j);
            break;
          }
        }
      }
    } else if (k === 'Enter' || k === ' ') this.activate(row.node);
    else if (k === 'ContextMenu' || (k === 'F10' && e.shiftKey)) {
      const r = row.el.getBoundingClientRect();
      this.menu({ x: r.left + 30, y: r.bottom - 6 }, row.node);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  }

  menu(at, node) {
    const ex = this.ex;
    const t = ex.t;
    const items = [];
    if (node.loc) {
      items.push({ label: t('menu.openNewTab'), icon: 'tab_add', action: () => ex.newTab(node.loc) });
      items.push({ label: t('menu.openNewWindow'), icon: 'window_new', action: () => ex.ctx.shell.launch('files', { path: node.loc.type === 'dir' ? node.loc.path : node.loc.type }) });
    }
    if (node.expandable) items.push({ label: this.expanded.has(node.id) ? t('menu.collapse') : t('menu.expand'), icon: this.expanded.has(node.id) ? 'chevron_up' : 'chevron_down', action: () => this.toggle(node) });
    if (node.path && !node.drive) {
      items.push('-');
      items.push(isPinned(node.path)
        ? { label: t('menu.unpin'), icon: 'pin_off', action: () => unpin(node.path) }
        : { label: t('menu.pin'), icon: 'pin', action: () => pin(node.path) });
      items.push({ label: t('menu.copyPath'), icon: 'copy_select', action: () => ops.copyAsPath(ex, [node.path]) });
      if (ex.hasApp('terminal')) items.push({ label: t('menu.openTerminal'), icon: 'window_console', action: () => ex.openTerminal(node.path) });
      items.push('-');
      items.push({ label: t('menu.properties'), icon: 'info', action: async () => {
        const st = await ex.api.invoke('fs:stat', node.path);
        if (st) ex.properties({ entries: [st] });
      } });
    }
    if (node.drive) {
      items.push('-');
      ex.driveMenuItems(node.drive).forEach((x) => items.push(x));
    }
    if (node.trash) {
      items.push('-');
      items.push({ label: t('trash.empty'), icon: 'delete', disabled: !this.trashFull, action: () => ops.emptyTrash(ex) });
    }
    if (node.id === 'thispc') {
      items.push('-');
      items.push({ label: t('menu.properties'), icon: 'info', action: () => ex.systemProperties() });
    }
    ex.menu(at, items);
  }
}
