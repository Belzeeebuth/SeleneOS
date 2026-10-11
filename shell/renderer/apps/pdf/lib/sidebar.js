// Sidebar panels of one document: page thumbnails, outline (bookmarks) and attachments.
// The window owns the sidebar frame (pivot + resize handle) and shows the active document's panels.

import { saveErrorText } from './shared.js';

const reduceMotion = () => document.documentElement.dataset.animations === 'off';

// ====================================================================== thumbnails
export class ThumbsPanel {
  constructor(doc) {
    this.doc = doc;
    const { h } = doc;
    this.items = [];
    this.rendered = new Map(); // page -> canvas
    this.queue = [];
    this.busy = false;
    this.rotation = doc.viewer?.pagesRotation || 0;
    this.width = 120;
    this.ratio = 1.414;
    this.current = doc.pageNum || 1;
    this.el = h('div', { class: 'pdf-thumbs', role: 'listbox', tabindex: '0', 'aria-label': doc.t('sidebar.thumbs') });
    this.el.addEventListener('keydown', (e) => this.onKey(e));
    this.io = null;
    this.ready = this.init();
  }

  async init() {
    const { doc } = this;
    try {
      const p1 = await doc.pdf.getPage(1);
      const vp = p1.getViewport({ scale: 1, rotation: p1.rotate });
      this.base = vp.height / vp.width;
      this.ratio = this.ratioFor(this.rotation);
    } catch {}
    if (doc.destroyed) return;
    const { h } = doc;
    const frag = document.createDocumentFragment();
    for (let i = 1; i <= doc.pages; i++) {
      const frame = h('div', { class: 'pdf-thumb-frame' });
      const item = h(
        'div',
        {
          class: 'pdf-thumb',
          role: 'option',
          'aria-selected': 'false',
          'aria-label': doc.t('sidebar.pageN', { n: i }),
          dataset: { page: String(i) },
          onclick: () => {
            doc.goToPage(i);
            this.setCurrent(i, { scroll: false });
            doc.w.onSidebarPick?.();
          },
        },
        frame,
        h('span', { class: 'pdf-thumb-num' }, String(i)),
      );
      item._frame = frame;
      this.items.push(item);
      frag.appendChild(item);
    }
    this.el.appendChild(frag);
    this.layout();
    this.setCurrent(this.current, { scroll: false });
  }

  /** Connect lazy rendering to the scrolling element that hosts the panel. */
  attach(scrollRoot) {
    this.io?.disconnect();
    this.io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const n = Number(e.target.dataset.page);
          if (e.isIntersecting) this.request(n);
          else this.unrequest(n);
        }
      },
      { root: scrollRoot, rootMargin: '300px 0px' },
    );
    this.ready.then(() => {
      for (const it of this.items) this.io?.observe(it);
      requestAnimationFrame(() => this.reveal());
    });
  }
  detach() {
    this.io?.disconnect();
    this.io = null;
    this.queue = [];
  }

  setWidth(w) {
    const next = Math.max(64, Math.min(220, Math.round(w)));
    if (next === this.width) return;
    this.width = next;
    this.layout();
    clearTimeout(this._resizeTimer);
    this._resizeTimer = setTimeout(() => this.rerender(), 250);
  }

  layout() {
    this.el.style.setProperty('--thumb-w', `${this.width}px`);
    for (const it of this.items) {
      const c = this.rendered.get(Number(it.dataset.page));
      const ratio = c?._ratio || this.ratio;
      it._frame.style.height = `${Math.round(this.width * ratio)}px`;
    }
  }

  setCurrent(n, { scroll = true } = {}) {
    this.current = n;
    for (const it of this.el.querySelectorAll('.pdf-thumb.selected')) {
      it.classList.remove('selected');
      it.setAttribute('aria-selected', 'false');
    }
    const it = this.items[n - 1];
    if (!it) return;
    it.classList.add('selected');
    it.setAttribute('aria-selected', 'true');
    if (scroll) this.reveal();
  }
  reveal() {
    const it = this.items[this.current - 1];
    if (it && this.el.isConnected && this.el.offsetParent) it.scrollIntoView({ block: 'nearest', behavior: reduceMotion() ? 'auto' : 'smooth' });
  }

  ratioFor(rotation) {
    const b = this.base || 1.414;
    return rotation % 180 === 90 ? 1 / b : b;
  }
  setRotation(r) {
    const quarter = (r - this.rotation) % 180 !== 0;
    this.rotation = r;
    // Swap the placeholders' proportions at once, then render again.
    this.ratio = this.ratioFor(r);
    for (const c of this.rendered.values()) if (quarter && c._ratio) c._ratio = 1 / c._ratio;
    this.layout();
    this.rerender();
  }

  rerender() {
    for (const c of this.rendered.values()) c._stale = true;
    if (!this.io) return;
    // Re-request what is visible.
    const root = this.io.root;
    if (!root) return;
    const rr = root.getBoundingClientRect();
    for (const it of this.items) {
      const r = it.getBoundingClientRect();
      if (r.bottom > rr.top - 300 && r.top < rr.bottom + 300) this.request(Number(it.dataset.page));
    }
  }

  request(n) {
    const c = this.rendered.get(n);
    if (c && !c._stale) return;
    if (!this.queue.includes(n)) this.queue.push(n);
    this.pump();
  }
  unrequest(n) {
    const i = this.queue.indexOf(n);
    if (i >= 0) this.queue.splice(i, 1);
  }

  async pump() {
    if (this.busy || this.doc.destroyed) return;
    const n = this.queue.shift();
    if (!n) return;
    this.busy = true;
    try {
      await this.renderPage(n);
    } catch (err) {
      if (!this.doc.destroyed) console.warn('[pdf] thumbnail', n, err?.message || err);
    }
    this.busy = false;
    if (this.queue.length) setTimeout(() => this.pump(), 0);
  }

  async renderPage(n) {
    const { doc } = this;
    const page = await doc.pdf.getPage(n);
    if (doc.destroyed) return;
    const rotation = (page.rotate + this.rotation) % 360;
    const vp1 = page.getViewport({ scale: 1, rotation });
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const scale = (this.width * dpr) / vp1.width;
    const vp = page.getViewport({ scale, rotation });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(vp.width));
    canvas.height = Math.max(1, Math.round(vp.height));
    canvas._ratio = vp.height / vp.width;
    const c2d = canvas.getContext('2d', { alpha: false });
    c2d.fillStyle = '#ffffff';
    c2d.fillRect(0, 0, canvas.width, canvas.height);
    this.task = page.render({ canvasContext: c2d, canvas, viewport: vp });
    await this.task.promise;
    this.task = null;
    if (doc.destroyed) return;
    const it = this.items[n - 1];
    const old = this.rendered.get(n);
    if (old && old !== canvas) {
      old.remove();
      old.width = old.height = 0;
    }
    this.rendered.set(n, canvas);
    it._frame.replaceChildren(canvas);
    it._frame.classList.add('loaded');
    it._frame.style.height = `${Math.round(this.width * canvas._ratio)}px`;
  }

  onKey(e) {
    const n = this.current;
    let next = null;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = n + 1;
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = n - 1;
    else if (e.key === 'Home') next = 1;
    else if (e.key === 'End') next = this.items.length;
    else if (e.key === 'PageDown') next = n + 5;
    else if (e.key === 'PageUp') next = n - 5;
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      this.doc.goToPage(n);
      this.doc.focus();
      return;
    }
    if (next == null) return;
    e.preventDefault();
    e.stopPropagation();
    next = Math.max(1, Math.min(this.items.length, next));
    this.setCurrent(next);
    this.doc.goToPage(next);
  }

  destroy() {
    this.detach();
    clearTimeout(this._resizeTimer);
    try {
      this.task?.cancel();
    } catch {}
    for (const c of this.rendered.values()) c.width = c.height = 0;
    this.rendered.clear();
    this.el.remove();
  }
}

// ====================================================================== outline
export class OutlinePanel {
  constructor(doc) {
    this.doc = doc;
    const { h } = doc;
    this.rows = []; // visible order is computed from the DOM
    this.flat = []; // every item in document order: { item, row, li, depth, pageNumber }
    this.el = h('div', { class: 'pdf-outline', role: 'tree', 'aria-label': doc.t('sidebar.outline') });
    this.el.addEventListener('keydown', (e) => this.onKey(e));
    this.ready = this.build();
  }

  async build() {
    const { doc } = this;
    const { h, t } = doc;
    const { icon } = doc.ctx;
    let outline = null;
    try {
      outline = await doc.pdf.getOutline();
    } catch {}
    if (doc.destroyed) return;
    if (!outline?.length) {
      this.empty = true;
      this.el.appendChild(h('div', { class: 'pdf-side-empty' }, icon('text_bullet_list_tree', { size: 32 }), h('div', { class: 'text-2' }, t('sidebar.noOutline'))));
      return;
    }
    const total = countItems(outline);
    const mk = (items, depth) => {
      const ul = h('ul', { role: depth ? 'group' : null, class: 'pdf-ol-list' });
      for (const it of items) {
        const kids = it.items?.length ? it.items : null;
        const expanded = !!kids && (total <= 24 || it.count > 0 || depth === 0 && items.length <= 3);
        const chev = h('span', { class: 'pdf-ol-chev', 'aria-hidden': 'true' }, kids ? icon('chevron_right', { size: 12 }) : null);
        const label = h('span', { class: 'pdf-ol-label' }, (it.title || '').trim() || t('sidebar.untitled'));
        if (it.bold) label.style.fontWeight = '600';
        if (it.italic) label.style.fontStyle = 'italic';
        const row = h('div', { class: 'pdf-ol-row', style: { '--depth': String(depth) }, 'data-tip': it.title || '' }, chev, label);
        const li = h('li', { role: 'treeitem', tabindex: '-1', 'aria-expanded': kids ? String(expanded) : null, class: ['pdf-ol-item', kids && 'has-kids'] }, row);
        const entry = { item: it, row, li, depth, pageNumber: null };
        li._entry = entry;
        this.flat.push(entry);
        row.addEventListener('click', (e) => {
          if (kids && e.target.closest('.pdf-ol-chev')) {
            this.toggle(li);
            return;
          }
          this.focusItem(li);
          this.activate(entry);
        });
        row.addEventListener('dblclick', () => kids && this.toggle(li));
        if (kids) li.appendChild(mk(kids, depth + 1));
        ul.appendChild(li);
      }
      return ul;
    };
    this.el.appendChild(mk(outline, 0));
    const first = this.el.querySelector('li[role="treeitem"]');
    if (first) first.tabIndex = 0;
    this.resolvePages();
  }

  async resolvePages() {
    const { doc } = this;
    for (const e of this.flat) {
      if (doc.destroyed) return;
      try {
        let dest = e.item.dest;
        if (typeof dest === 'string') dest = await doc.pdf.getDestination(dest);
        if (!Array.isArray(dest)) continue;
        const ref = dest[0];
        e.pageNumber = (ref && typeof ref === 'object' ? await doc.pdf.getPageIndex(ref) : Number(ref)) + 1;
      } catch {}
    }
    this.setCurrentPage(doc.pageNum);
  }

  setCurrentPage(n) {
    let best = null;
    for (const e of this.flat) if (e.pageNumber != null && e.pageNumber <= n && (!best || e.pageNumber >= best.pageNumber)) best = e;
    for (const r of this.el.querySelectorAll('.pdf-ol-row.current')) r.classList.remove('current');
    if (!best) return;
    // Mark the item, or its nearest visible ancestor when collapsed.
    let li = best.li;
    let p = li.parentElement?.closest('li[role="treeitem"]');
    while (p) {
      if (p.getAttribute('aria-expanded') === 'false') li = p;
      p = p.parentElement?.closest('li[role="treeitem"]');
    }
    li._entry.row.classList.add('current');
  }

  activate(entry) {
    const { doc } = this;
    const it = entry.item;
    doc.w.onSidebarPick?.();
    if (it.dest) doc.linkService.goToDestination(it.dest);
    else if (it.url) doc.w.openExternal(it.url);
    else if (it.action) doc.linkService.executeNamedAction(it.action);
    else if (entry.pageNumber) doc.goToPage(entry.pageNumber);
  }

  toggle(li, force) {
    const open = force ?? li.getAttribute('aria-expanded') !== 'true';
    li.setAttribute('aria-expanded', String(open));
    const group = li.querySelector(':scope > ul');
    if (open && group && !reduceMotion()) group.animate([{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'none' }], { duration: 167, easing: 'cubic-bezier(0.1, 0.9, 0.2, 1)' });
    this.setCurrentPage(this.doc.pageNum);
  }

  visibleItems() {
    return [...this.el.querySelectorAll('li[role="treeitem"]')].filter((li) => {
      let p = li.parentElement?.closest('li[role="treeitem"]');
      while (p) {
        if (p.getAttribute('aria-expanded') === 'false') return false;
        p = p.parentElement?.closest('li[role="treeitem"]');
      }
      return true;
    });
  }
  focusItem(li) {
    for (const x of this.el.querySelectorAll('li[tabindex="0"]')) x.tabIndex = -1;
    li.tabIndex = 0;
    li.focus({ preventScroll: true });
    li._entry.row.scrollIntoView({ block: 'nearest' });
  }

  onKey(e) {
    const li = e.target.closest?.('li[role="treeitem"]');
    if (!li) return;
    const items = this.visibleItems();
    const i = items.indexOf(li);
    const hasKids = li.classList.contains('has-kids');
    const open = li.getAttribute('aria-expanded') === 'true';
    let handled = true;
    if (e.key === 'ArrowDown') items[i + 1] && this.focusItem(items[i + 1]);
    else if (e.key === 'ArrowUp') items[i - 1] && this.focusItem(items[i - 1]);
    else if (e.key === 'Home') this.focusItem(items[0]);
    else if (e.key === 'End') this.focusItem(items.at(-1));
    else if (e.key === 'ArrowRight') {
      if (hasKids && !open) this.toggle(li, true);
      else if (hasKids) this.focusItem(li.querySelector('li[role="treeitem"]'));
    } else if (e.key === 'ArrowLeft') {
      if (hasKids && open) this.toggle(li, false);
      else {
        const parent = li.parentElement?.closest('li[role="treeitem"]');
        if (parent) this.focusItem(parent);
      }
    } else if (e.key === 'Enter' || e.key === ' ') this.activate(li._entry);
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  destroy() {
    this.el.remove();
  }
}

/** A file name from a PDF (untrusted): no folders, no ".." tricks, no control characters, not too long. */
export function safeName(raw) {
  let name = String(raw || '')
    .split(/[\\/]/)
    .pop()
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  if (!name || name === '.' || name === '..') name = 'attachment';
  if (name.length > 120) {
    const ext = /\.[^.]{1,10}$/.exec(name)?.[0] || '';
    name = name.slice(0, 120 - ext.length) + ext;
  }
  return name;
}

function countItems(list) {
  let n = 0;
  for (const it of list || []) n += 1 + countItems(it.items);
  return n;
}

// ====================================================================== attachments
export class AttachmentsPanel {
  constructor(doc) {
    this.doc = doc;
    const { h, t } = doc;
    const { icon, ui } = doc.ctx;
    this.el = h('div', { class: 'pdf-attachments', role: 'list', 'aria-label': t('sidebar.attachments') });
    const list = doc.attachments || [];
    if (!list.length) {
      this.el.appendChild(h('div', { class: 'pdf-side-empty' }, icon('attach', { size: 32 }), h('div', { class: 'text-2' }, t('sidebar.noAttachments'))));
      return;
    }
    for (const a of list) {
      const name = safeName(a.filename);
      const ext = (/\.[^.]+$/.exec(name)?.[0] || '').toLowerCase();
      const row = h(
        'div',
        {
          class: 'pdf-att',
          role: 'listitem',
          tabindex: '0',
          'data-tip': a.description || name,
          ondblclick: () => this.open(a, name),
          onkeydown: (e) => {
            if (e.key === 'Enter') this.open(a, name);
            else if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
              e.preventDefault();
              this.menu(row, a, name);
            }
          },
          oncontextmenu: (e) => {
            e.preventDefault();
            this.menu(e, a, name);
          },
        },
        icon(ui.fileIcon({ ext }), { size: 20 }),
        h('div', { class: 'pdf-att-text' }, h('div', { class: 'ellipsis' }, name), (a._sizeEl = h('div', { class: 'caption text-2' }, a.content ? ui.formatSize(a.content.length) : a.description || ''))),
        h(
          'button',
          {
            class: 'btn subtle icon-btn pdf-att-more',
            'aria-label': t('more'),
            'data-tip': t('more'),
            onclick: (e) => {
              e.stopPropagation();
              this.menu(e, a, name);
            },
          },
          icon('more_horizontal'),
        ),
      );
      this.el.appendChild(row);
    }
    // Sizes need the bytes: read small lists in the background.
    if (list.length <= 20) {
      (async () => {
        for (const a of list) {
          if (doc.destroyed) return;
          try {
            const bytes = await doc.attachmentBytes(a);
            if (a._sizeEl) a._sizeEl.textContent = ui.formatSize(bytes.length);
          } catch {}
        }
      })();
    }
  }

  menu(at, a, name) {
    const { t } = this.doc;
    this.doc.ctx.ui.menu(at, [
      { label: t('att.open'), icon: 'open', action: () => this.open(a, name) },
      { label: t('att.saveAs'), icon: 'save', action: () => this.saveAs(a, name) },
    ]);
  }

  async saveAs(a, name) {
    const { doc } = this;
    const { ui, api } = doc.ctx;
    const xdg = await api.invoke('fs:xdg').catch(() => ({}));
    const path = await ui.filePicker({ mode: 'save', name, path: xdg.downloads || xdg.home, parent: doc.w.win });
    if (!path) return;
    try {
      await api.invoke('fs:writeBytes', path, await doc.attachmentBytes(a));
    } catch (err) {
      console.warn('[pdf] attachment save', err?.code, err?.message);
      doc.w.alert(doc.t('att.saveFailed', { name }), saveErrorText(doc.t, err));
    }
  }

  async open(a, name) {
    const { doc } = this;
    const { api, shell } = doc.ctx;
    try {
      const home = await api.invoke('fs:home');
      const dir = `${home}/.cache/aurora/pdf-attachments/${Date.now().toString(36)}`;
      const path = `${dir}/${name}`;
      await api.invoke('fs:writeBytes', path, await doc.attachmentBytes(a));
      await shell.openFile(path);
    } catch (err) {
      console.warn('[pdf] attachment open', err?.code, err?.message);
      doc.w.alert(doc.t('att.openFailed', { name }), err?.code === 'EEMPTY' ? doc.t('att.empty') : saveErrorText(doc.t, err));
    }
  }

  destroy() {
    this.el.remove();
  }
}
