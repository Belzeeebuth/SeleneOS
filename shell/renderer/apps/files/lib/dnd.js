// Drag & drop of files between File Explorer windows, tabs, the navigation pane, breadcrumbs and
// (through the shared MIME type) the desktop.
//
// Payload: dataTransfer 'application/x-aurora-paths' = JSON array of absolute paths, plus
// 'text/uri-list' (file:// URIs) and 'text/plain' (one path per line) for other consumers.
// Default effect follows Windows: same drive -> move, other drive -> copy; Ctrl forces copy,
// Shift forces move. Dropping on the Recycle Bin moves to the trash.
import { shared, DND_MIME, mountOf } from './shared.js';
import * as T from './types.js';
import * as ops from './ops.js';

export const TRASH_TARGET = '\u0000trash';

// Security (same rule as core/desktop.js): the internal paths format and file:// URI lists are only
// trusted when the drag started in the shell's own document (Files, the desktop, other apps). A drag
// coming out of web content (<webview> tab, sandboxed mail iframe) never fires 'dragstart' here, so a
// page can't forge a payload that makes Explorer move, copy or trash arbitrary files.
let shellDrag = false;
document.addEventListener('dragstart', () => (shellDrag = true), true);
document.addEventListener('dragend', () => (shellDrag = false), true);
window.addEventListener('pointerdown', () => (shellDrag = false), true);

export class DnD {
  constructor(ex) {
    this.ex = ex;
    this.badge = ex.h('div', { class: 'fx-dnd-badge', hidden: true });
    ex.win.el.appendChild(this.badge);
    this.hoverTimer = null;
  }

  // ---------------------------------------------------------------- source
  start(e, entries) {
    const paths = entries.map((x) => x.path);
    const dt = e.dataTransfer;
    dt.effectAllowed = 'copyMove';
    dt.setData(DND_MIME, JSON.stringify(paths));
    dt.setData('text/uri-list', paths.map((p) => `file://${p.split('/').map(encodeURIComponent).join('/')}`).join('\r\n'));
    dt.setData('text/plain', paths.join('\n'));
    shared.drag = { paths, winId: this.ex.win.id };
    // Drag image: the first item's icon with a count badge, like Windows.
    const { h } = this.ex;
    const first = entries[0];
    const ghost = h('div', { class: 'app-files fx-drag-ghost' },
      h('img', { src: T.isImage(first) && T.isRegular(first) ? this.ex.api.mediaUrl(first.path) : T.iconFor(first), alt: '' }),
      paths.length > 1 ? h('span', { class: 'fx-drag-count' }, String(paths.length)) : null);
    document.body.appendChild(ghost);
    try {
      dt.setDragImage(ghost, 32, 32);
    } catch {}
    setTimeout(() => ghost.remove(), 0);
  }

  end() {
    shared.drag = null;
    this.hideBadge();
  }

  // ---------------------------------------------------------------- targets
  accepts(e) {
    const types = [...(e.dataTransfer?.types || [])];
    if (types.includes('Files')) return true;
    return shellDrag && (types.includes(DND_MIME) || types.includes('text/uri-list'));
  }

  effectFor(e, dest) {
    const drag = shared.drag;
    const types = [...(e.dataTransfer?.types || [])];
    // Internal drags (this or another Files window) and shell drags (desktop icons) can go to the bin.
    if (dest === TRASH_TARGET) return drag || (shellDrag && types.includes(DND_MIME)) ? 'move' : 'none';
    if (!dest) return 'none';
    if (drag) {
      if (drag.paths.some((p) => p === dest || T.isInside(dest, p))) return 'none';
    }
    if (e.ctrlKey) return 'copy';
    if (e.shiftKey) return 'move';
    if (drag) {
      if (drag.paths.every((p) => T.dirname(p) === dest)) return 'none';
      const same = drag.paths.every((p) => mountOf(p) === mountOf(dest));
      return same ? 'move' : 'copy';
    }
    // From the desktop (same session, same drive): move; external files: copy.
    return shellDrag && types.includes(DND_MIME) ? 'move' : 'copy';
  }

  // el: element; getDest(): folder path | TRASH_TARGET | null ; opts.onHover: spring-loading callback
  dropTarget(el, getDest, opts = {}) {
    let depth = 0;
    let marked = null;
    const mark = (m) => {
      if (marked === m) return;
      marked?.classList.remove('fx-drop');
      marked = m;
      m?.classList.add('fx-drop');
    };
    el.addEventListener('dragenter', (e) => {
      if (!this.accepts(e)) return;
      depth++;
      if (depth === 1 && opts.onHover) {
        clearTimeout(this.hoverTimer);
        this.hoverTimer = setTimeout(() => opts.onHover(), opts.hoverDelay ?? 700);
      }
    });
    el.addEventListener('dragover', (e) => {
      if (!this.accepts(e)) return;
      const dest = getDest(e);
      if (dest == null) {
        mark(null);
        return; // let a parent target handle it
      }
      e.preventDefault();
      e.stopPropagation();
      const eff = this.effectFor(e, dest);
      e.dataTransfer.dropEffect = eff;
      mark(eff !== 'none' ? (opts.mark ? opts.mark(e) : el) : null);
      this.showBadge(e, eff, dest);
    });
    el.addEventListener('dragleave', (e) => {
      depth = Math.max(0, depth - 1);
      if (depth === 0 || !el.contains(e.relatedTarget)) {
        depth = 0;
        mark(null);
        clearTimeout(this.hoverTimer);
      }
    });
    el.addEventListener('drop', async (e) => {
      depth = 0;
      mark(null);
      clearTimeout(this.hoverTimer);
      if (!this.accepts(e)) return;
      const dest = getDest(e);
      if (dest == null) return;
      e.preventDefault();
      e.stopPropagation();
      const eff = this.effectFor(e, dest);
      this.hideBadge();
      const paths = this.readPaths(e);
      shared.drag = null;
      if (eff === 'none' || !paths.length) return;
      if (dest === TRASH_TARGET) {
        await ops.trash(this.ex, paths);
        return;
      }
      await ops.transfer(this.ex, paths, dest, { move: eff === 'move', select: true });
    });
  }

  readPaths(e) {
    const dt = e.dataTransfer;
    const valid = (p) => typeof p === 'string' && p.startsWith('/') && !p.includes('\0');
    if (shellDrag) {
      try {
        const raw = dt.getData(DND_MIME);
        if (raw) {
          const list = JSON.parse(raw);
          if (Array.isArray(list)) return [...new Set(list.filter(valid))];
        }
      } catch {}
    }
    // Real files dragged in from outside the shell (Electron gives their paths).
    const files = [...(dt.files || [])].map((f) => this.ex.api.pathForFile(f)).filter(valid);
    if (files.length) return files;
    if (!shellDrag) return [];
    const uris = [];
    for (const l of (dt.getData('text/uri-list') || '').split(/\r?\n/)) {
      if (!l.startsWith('file://')) continue;
      try {
        const p = decodeURIComponent(l.slice(7).replace(/^localhost(?=\/)/, ''));
        if (valid(p)) uris.push(p);
      } catch {
        // malformed %-escape: skip that line
      }
    }
    return uris;
  }

  showBadge(e, eff, dest) {
    const r = this.ex.win.el.getBoundingClientRect();
    const t = this.ex.t;
    if (eff === 'none') {
      this.hideBadge();
      return;
    }
    const name = dest === TRASH_TARGET ? t('places.trash') : this.ex.locName({ type: 'dir', path: dest });
    const label = t(dest === TRASH_TARGET ? 'dnd.trash' : eff === 'copy' ? 'dnd.copy' : 'dnd.move', { name });
    if (this.badge.textContent !== label) {
      this.badge.replaceChildren(this.ex.icon(eff === 'copy' ? 'add' : 'arrow_right', { size: 12 }), this.ex.h('span', null, label));
    }
    this.badge.hidden = false;
    this.badge.style.transform = `translate(${Math.round(e.clientX - r.left + 14)}px, ${Math.round(e.clientY - r.top + 18)}px)`;
  }

  hideBadge() {
    this.badge.hidden = true;
  }
}
