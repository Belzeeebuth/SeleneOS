// Livres — one window: the library (home) or the reader, drag and drop, the folder scan (Documents and
// Téléchargements, shallow), book metadata and cover thumbnails for the library, removing / trashing books.
import { store } from './store.js';
import { Library } from './library.js';
import { Reader } from './reader.js';
import { trustedDragPaths } from '../../../core/desktop.js';

const DND_MIME = 'application/x-aurora-paths';
const isEpub = (p) => typeof p === 'string' && /\.epub$/i.test(p);
const baseName = (p) => p.split('/').pop().replace(/\.epub$/i, '');

/** A small JPEG thumbnail (data: URL) of a cover picture { data, mime }, or null. */
export async function makeThumb(cover) {
  if (!cover?.data || !/^image\//.test(cover.mime || '')) return null;
  const url = URL.createObjectURL(new Blob([cover.data], { type: cover.mime }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const w0 = img.naturalWidth || 240;
    const h0 = img.naturalHeight || 360;
    const scale = Math.min(1, 360 / h0, 260 / w0);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w0 * scale));
    c.height = Math.max(1, Math.round(h0 * scale));
    const g = c.getContext('2d');
    g.fillStyle = 'white';
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.82);
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export class BooksApp {
  constructor(ctx) {
    this.ctx = ctx;
    this.win = ctx.win;
    this.t = ctx.t;
    this.reader = null;
    this.closed = false;
    this.store = store; // tests
  }

  get appName() {
    return this.ctx.i18n.name(this.ctx.manifest.name);
  }
  fmt(n) {
    return this.ctx.i18n.formatNumber(n);
  }
  pct(f) {
    return this.ctx.i18n.formatNumber(Math.min(1, Math.max(0, f || 0)), { style: 'percent', maximumFractionDigits: 0 });
  }
  key(combo) {
    return this.ctx.lang === 'fr' ? combo.replace('Shift', 'Maj') : combo;
  }

  async init() {
    const { h } = this.ctx;
    await store.init(this.ctx);
    this.win.el.classList.add('books-window');
    this.win.setMinSize?.(480, 420);
    this.library = new Library(this);
    this.toastEl = h('div', { class: 'books-toast', role: 'status', 'aria-live': 'polite', hidden: true });
    this.dropEl = h('div', { class: 'books-drop', hidden: true }, h('div', { class: 'books-drop-card' }, this.ctx.icon('books', { size: 28 }), h('span', null, this.t('drop.hint'))));
    this.root = h('div', { class: 'books-root' }, this.library.el, this.dropEl, this.toastEl);
    this.win.body.appendChild(this.root);
    this.win.el.__books = this; // test / debugging hook
    this.wireDrop();
    this.root.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'o' || e.key === 'O')) {
        e.preventDefault();
        this.pickBooks();
      }
    });
    this.win.onBeforeClose(async () => {
      this.reader?.savePosition(true);
      await store.flush();
      return true;
    });
    this.ctx.onLangChange?.(() => this.relabel());
    this.ctx.onClose(() => {
      this.closed = true;
      this.reader?.close();
      this.library.destroy();
      store.flush();
    });
    const file = this.ctx.args?.file;
    if (typeof file === 'string' && file) this.openBook(file);
    else this.showLibrary();
    this.scan();
    return {
      app: this,
      onRelaunch: (args = {}) => {
        this.win.focus();
        if (typeof args.file === 'string' && args.file) this.openBook(args.file);
      },
    };
  }

  // ---------------------------------------------------------------- views
  showLibrary() {
    if (this.reader) {
      this.reader.close();
      this.reader = null;
    }
    if (this.win.fullscreen) this.win.setFullscreen(false);
    this.win.setTitle(this.appName);
    this.library.show();
    setTimeout(() => !this.closed && this.library.shown && this.library.focus(), 0);
  }

  /** The language changed: rebuild the views with the new strings (the open book stays at its page). */
  relabel() {
    if (this.closed) return;
    const old = this.library;
    this.library = new Library(this);
    old.el.replaceWith(this.library.el);
    old.destroy();
    this.dropEl.querySelector('span').textContent = this.t('drop.hint');
    const r = this.reader;
    if (r?.book && !r.closed) this.openBook(r.book.path, { at: r.position() });
    else this.showLibrary();
  }

  async openBook(path, { at } = {}) {
    if (typeof path !== 'string' || !path.startsWith('/')) return false;
    const prev = store.get(path);
    store.put(path, { source: prev?.source || 'user', title: prev?.title || baseName(path), opened: Date.now(), error: null });
    if (prev?.source !== 'found') store.hidden.delete(path);
    if (this.reader) this.reader.close();
    this.library.hide();
    const reader = new Reader(this);
    this.reader = reader;
    this.root.insertBefore(reader.el, this.dropEl);
    const ok = await reader.open(path, { at });
    if (!ok || reader !== this.reader) return false;
    const b = reader.book;
    store.put(path, { title: b.title, authors: b.authors, authorSort: b.authorSort, language: b.language, series: b.series, seriesIndex: b.seriesIndex, size: b.size, mtime: b.mtime, meta: true, error: null });
    if (!store.cover(path) && b.cover) {
      const cover = await this.ctx.api.invoke('books:resource', path, b.cover).catch(() => null);
      const th = await makeThumb(cover);
      if (th) store.setCover(path, th);
    }
    return true;
  }

  bookFailed(path, code) {
    if (store.get(path)) store.put(path, { error: code, meta: true });
  }

  // ---------------------------------------------------------------- adding books
  async addBooks(paths) {
    let added = 0;
    for (const p of paths.filter(isEpub)) {
      const st = await this.ctx.api.invoke('fs:stat', p).catch(() => null);
      if (!st || st.dir) continue;
      const prev = store.get(p);
      store.put(p, { source: 'user', title: prev?.title || baseName(p), size: st.size, mtime: st.mtime, meta: prev?.meta && prev.size === st.size && prev.mtime === st.mtime });
      store.hidden.delete(p);
      added++;
    }
    if (added) this.toast(this.t('toast.added', { count: added, n: this.fmt(added) }));
    await this.enrich();
    return added;
  }

  async pickBooks() {
    const xdg = await this.ctx.api.invoke('fs:xdg').catch(() => null);
    const res = await this.ctx.ui.filePicker({ mode: 'open', multiple: true, title: this.t('picker.title'), filters: [{ name: this.t('picker.epub'), ext: ['.epub'] }], path: xdg?.documents, parent: this.win });
    if (!res || this.closed) return;
    const paths = Array.isArray(res) ? res : [res];
    const n = await this.addBooks(paths);
    if (!n && paths.length) this.toast(this.t('drop.none'));
    if (!this.reader) this.library.render();
  }

  wireDrop() {
    const el = this.root;
    const accepts = (e) => {
      const types = [...(e.dataTransfer?.types || [])];
      return types.includes(DND_MIME) || types.includes('Files');
    };
    let depth = 0;
    el.addEventListener('dragenter', (e) => {
      if (!accepts(e)) return;
      depth++;
      this.dropEl.hidden = false;
    });
    el.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (!depth) this.dropEl.hidden = true;
    });
    el.addEventListener('dragover', (e) => {
      if (!accepts(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    el.addEventListener('drop', (e) => {
      depth = 0;
      this.dropEl.hidden = true;
      if (!accepts(e)) return;
      e.preventDefault();
      let paths = trustedDragPaths(e.dataTransfer);
      if (!paths.length) paths = [...(e.dataTransfer.files || [])].map((f) => this.ctx.api.pathForFile?.(f)).filter(Boolean);
      this.dropped(paths);
    });
  }

  async dropped(paths) {
    const books = paths.filter(isEpub);
    if (!books.length) {
      this.toast(this.t('drop.none'));
      return;
    }
    if (this.reader && books.length === 1) return this.openBook(books[0]);
    await this.addBooks(books);
    if (this.reader) this.toast(this.t('toast.added', { count: books.length, n: this.fmt(books.length) }));
  }

  // ---------------------------------------------------------------- folder scan and metadata
  scan() {
    if (this.scanning) return this.scanning;
    this.scanning = (async () => {
      const xdg = await this.ctx.api.invoke('fs:xdg').catch(() => null);
      const dirs = [xdg?.documents, xdg?.downloads].filter((d) => typeof d === 'string' && d);
      const found = await this.ctx.api.invoke('books:scan', dirs, { depth: 1 }).catch(() => []);
      if (this.closed) return;
      const seen = new Set();
      for (const f of found) {
        seen.add(f.path);
        if (store.isHidden(f.path)) continue;
        const e = store.get(f.path);
        if (!e) store.put(f.path, { source: 'found', title: baseName(f.path), size: f.size, mtime: f.mtime, added: f.mtime, meta: false });
        else if (e.size !== f.size || e.mtime !== f.mtime) store.put(f.path, { size: f.size, mtime: f.mtime, meta: false });
      }
      // found books that left those folders and were never opened
      for (const e of store.list()) if (e.source === 'found' && !e.opened && !seen.has(e.path) && dirs.some((d) => e.path.startsWith(`${d}/`))) store.remove(e.path, { hide: false });
      await this.enrich();
    })().finally(() => (this.scanning = null));
    return this.scanning;
  }

  async enrich() {
    if (this.enriching) return this.enriching;
    this.enriching = (async () => {
      for (;;) {
        const e = store.list().find((x) => !x.meta);
        if (!e || this.closed) return;
        try {
          const m = await this.ctx.api.invoke('books:meta', e.path);
          if (!store.get(e.path)) continue;
          store.put(e.path, { title: m.title, authors: m.authors, authorSort: m.authorSort, language: m.language, series: m.series, seriesIndex: m.seriesIndex, size: m.size, mtime: m.mtime, meta: true, error: null });
          if (m.cover && !store.cover(e.path)) {
            const th = await makeThumb(m.cover);
            if (th) store.setCover(e.path, th);
          }
        } catch (err) {
          if (store.get(e.path)) store.put(e.path, { meta: true, error: err?.code || 'EFAIL' });
        }
      }
    })().finally(() => (this.enriching = null));
    return this.enriching;
  }

  // ---------------------------------------------------------------- removing
  removeFromLibrary(path) {
    const e = store.get(path);
    if (!e) return;
    store.remove(path, { hide: true });
    this.toast(this.t('toast.removed', { title: e.title || baseName(path) }));
  }

  async trashBook(path) {
    const e = store.get(path);
    const title = e?.title || baseName(path);
    const ok = await this.ctx.ui.confirm(this.t('trash.body', { title, name: path.split('/').pop() }), { title: this.t('trash.title'), okLabel: this.t('trash.ok'), danger: true, parent: this.win });
    if (!ok || this.closed) return false;
    try {
      await this.ctx.api.invoke('fs:trash', [path]);
    } catch (err) {
      await this.ctx.ui.alert(this.t('trash.failed', { message: err?.message || '' }), { title: this.t('trash.title'), parent: this.win });
      return false;
    }
    store.forget(path);
    if (this.reader?.book?.path === path) this.showLibrary();
    this.toast(this.t('toast.trashed', { title }));
    return true;
  }

  // ---------------------------------------------------------------- dialogs, toast
  showInfo(book) {
    const { h, t } = this;
    const { i18n, ui } = this.ctx;
    const rows = [
      [t('info.titleLabel'), book.title],
      [t('info.authors'), book.authors.join(', ')],
      [t('info.series'), book.series ? (book.seriesIndex != null ? `${book.series} (${i18n.formatNumber(book.seriesIndex)})` : book.series) : ''],
      [t('info.publisher'), book.publisher],
      [t('info.date'), book.date],
      [t('info.language'), book.language],
      [t('info.format'), `EPUB ${book.version}`],
      [t('info.size'), i18n.formatSize(book.size)],
      [t('info.file'), book.path],
    ].filter(([, v]) => v);
    const body = h(
      'div',
      { class: 'books-info' },
      h('dl', { class: 'books-info-list' }, rows.map(([k, v]) => [h('dt', { class: 'caption text-2' }, k), h('dd', { class: 'selectable' }, v)])),
      book.description ? h('p', { class: 'books-info-desc selectable text-2' }, book.description) : null,
    );
    return ui.dialog({ title: t('info.title'), body, parent: this.win, width: 520 });
  }

  toast(text) {
    clearTimeout(this.toastTimer);
    this.toastEl.textContent = text;
    this.toastEl.hidden = false;
    this.toastTimer = setTimeout(() => (this.toastEl.hidden = true), 2600);
  }

  get h() {
    return this.ctx.h;
  }
}
