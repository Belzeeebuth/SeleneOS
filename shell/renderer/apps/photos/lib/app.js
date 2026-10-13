// Photos app controller: modes (gallery / viewer / editor / slideshow), shared commands (menus,
// delete, copy, set as wallpaper, open with, rename, save as, albums, folders), keyboard routing,
// drag & drop, unsaved-changes guard and the test hook (win.el.__photos).
import { sharedLibrary } from './library.js';
import { sharedThumbs } from './thumbs.js';
import { Gallery } from './gallery.js';
import { Viewer } from './viewer.js';
import { Editor } from './editor.js';
import { Slideshow } from './slideshow.js';
import * as P from './pipeline.js';
import { isImage, extOf, baseName, dirName, stem, sortByName, reduceMotion, loadPixels, ENCODABLE, DND_MIME, EASE } from './util.js';
import { trustedDragPaths } from '../../../core/desktop.js';

const ROTATABLE = ['.jpg', '.jpeg', '.png', '.webp', '.bmp'];

export class PhotosApp {
  constructor(ctx) {
    this.ctx = ctx;
    this.win = ctx.win;
    this.h = ctx.h;
    this.t = ctx.t;
    this.icon = ctx.icon;
    this.ui = this._focusSafeUi(ctx.ui);
    this.api = ctx.api;
    this.shell = ctx.shell;
    this.mode = null;
    this.gallery = null;
    this.viewer = null;
    this.editor = null;
    this.slideshow = null;
    this.viewerFrom = 'gallery';
    this._ownDrag = false;
  }

  /** The shell's dialogs and menus don't give the keyboard focus back when they close: this wrapper does,
   *  so shortcuts keep working without clicking the window again. */
  _focusSafeUi(ui) {
    const wrapped = Object.create(ui);
    for (const m of ['dialog', 'alert', 'confirm', 'prompt', 'filePicker', 'menu']) {
      wrapped[m] = async (...args) => {
        const prev = document.activeElement;
        try {
          return await ui[m](...args);
        } finally {
          setTimeout(() => this._restoreFocus(prev), 0);
        }
      };
    }
    return wrapped;
  }

  _restoreFocus(prev) {
    const a = document.activeElement;
    // Focus left in a dialog that is closing (it is removed after its animation) counts as lost.
    const lost = !a || a === document.body || !a.isConnected || !!a.closest('.dialog-layer.closing, .menu.closing');
    if (!lost) return; // something (a new dialog…) owns the focus
    if (this.win._closing || !this.win.el.isConnected) return;
    if (prev?.isConnected && this.win.el.contains(prev) && prev.offsetParent) prev.focus({ preventScroll: true });
    else this.focusMain();
  }

  /** Keyboard focus to the main surface of the current mode. */
  focusMain() {
    const t =
      this.mode === 'viewer' ? this.viewer?.stage : this.mode === 'editor' ? this.editor?.tabBtns[this.editor.tool] : this.mode === 'slideshow' ? this.slideshow?.el : this.gallery?.grid.scroll;
    t?.focus({ preventScroll: true });
  }

  get locale() {
    return this.ctx.i18n?.locale || 'en-US';
  }

  async init() {
    const { h, win } = this;
    this.lib = sharedLibrary(this.api, this.ctx.storage);
    this.thumbs = sharedThumbs(this.api);
    this.root = h('div', { class: 'ph-app' });
    this.toastHost = h('div', { class: 'ph-toasts', 'aria-hidden': 'true' });
    this.live = h('div', { class: 'ph-live', 'aria-live': 'polite', role: 'status' });
    this.dropHint = h('div', { class: 'ph-drop', hidden: true }, h('div', { class: 'ph-drop-card' }, this.icon('image_add', { size: 32 }), h('div', { class: 'body-strong' }, this.t('dropHint'))));
    win.body.append(this.root, this.toastHost, this.live, this.dropHint);
    this.loading = h('div', { class: 'ph-boot' }, h('div', { class: 'spinner' }));
    this.root.appendChild(this.loading);
    await Promise.all([this.lib.load(), this.thumbs.init()]);
    this.lib.retain();
    this.root.dataset.bg = this.lib.prefs.viewerBackground === 'theme' ? 'theme' : 'dark';
    this._offLib = this.lib.on((ev) => this._onLib(ev));
    this.ctx.onClose(() => this.destroy());
    win.el.__photos = this;
    this._bindKeys();
    this._bindDnD();
    win.onBeforeClose(async () => {
      if (this.mode === 'editor' && this.editor?.dirty) {
        this.win.focus();
        // A second click on the close button while the prompt is open reuses the same prompt.
        return this.editor.confirmLeave();
      }
      return true;
    });
    win.on('fullscreen', (on) => {
      if (!on && this.mode === 'slideshow') this.stopSlideshow();
      if (!on && this.viewer?.fs) {
        this.viewer.fs = false;
        this.viewer.el.classList.remove('fs');
      }
    });
    this.ctx.onLangChange?.(() => this._langChanged());
    this.loading.remove();
    const file = typeof this.ctx.args?.file === 'string' ? this.ctx.args.file : null;
    // (openFile never waits for its "can't open" alert: launching must not block on a dialog)
    if (file) await this.openFile(file);
    else this.showGallery();
    return { onRelaunch: (args) => args?.file && this.openFile(args.file) };
  }

  destroy() {
    this._offLib?.();
    this.lib.release();
    this.gallery?.destroy();
    this.viewer?.destroy();
    this.editor?.destroy();
    this.slideshow?.stop();
  }

  _langChanged() {
    // Rebuild the UI in the new language, keeping the current mode / item. Edits in progress are never
    // thrown away: the rebuild waits until the editor is closed.
    if (this.mode === 'editor') {
      this._langPending = true;
      return;
    }
    this._langPending = false;
    if (this.mode === 'slideshow') this.stopSlideshow();
    const mode = this.mode;
    const v = this.viewer;
    const list = v?.list;
    const idx = v?.index;
    const from = this.viewerFrom;
    const route = this.gallery?.route;
    const query = this.gallery?.searchInput.value;
    this.gallery?.searchBox.remove();
    for (const part of [this.gallery, this.viewer, this.editor]) {
      part?.el.remove();
      part?.destroy?.();
    }
    this.slideshow?.el.remove();
    this.gallery = this.viewer = this.editor = this.slideshow = null;
    this.mode = null;
    if (mode === 'viewer' && list?.length) {
      if (from === 'gallery' || route) {
        // Keep a gallery underneath so "Back" still works.
        this._ensure('gallery');
        if (route) this.gallery.route = route;
        if (query) this.gallery.searchInput.value = query;
      }
      this.openViewer(list, idx, { from });
    } else {
      this.showGallery();
      if (route) {
        if (query) this.gallery.searchInput.value = query;
        this.gallery.navigate(route, { push: false });
      }
    }
  }

  _onLib(ev) {
    if (ev === 'prefs') {
      this.root.dataset.bg = this.lib.prefs.viewerBackground === 'theme' ? 'theme' : 'dark';
      this.viewer?.applyPrefs();
    }
    if (ev === 'favorites' && this.mode === 'viewer') this.viewer?._updateChrome();
  }

  setTitle(s) {
    this.win.setTitle(s || this.t('appName'));
  }

  // ================================================================== modes
  _ensure(part) {
    if (part === 'gallery' && !this.gallery) {
      this.gallery = new Gallery(this);
      this.gallery.applyNavState();
      this.root.appendChild(this.gallery.el);
      // the search sits in the gallery header, next to the commands; the title bar keeps only the title
      this.gallery.head.insertBefore(this.gallery.searchBox, this.gallery.cmds);
    }
    if (part === 'viewer' && !this.viewer) {
      this.viewer = new Viewer(this);
      this.root.appendChild(this.viewer.el);
    }
    if (part === 'editor' && !this.editor) {
      this.editor = new Editor(this);
      this.root.appendChild(this.editor.el);
    }
    if (part === 'slideshow' && !this.slideshow) {
      this.slideshow = new Slideshow(this);
      this.root.appendChild(this.slideshow.el);
    }
    return this[part];
  }

  _setMode(mode) {
    const prev = this.mode;
    this.mode = mode;
    this.root.dataset.mode = mode;
    for (const k of ['gallery', 'viewer', 'editor', 'slideshow']) if (this[k]) this[k].el.hidden = k !== mode;
    if (this.gallery) this.gallery.searchBox.hidden = mode !== 'gallery';
    this.win.el.classList.toggle('ph-immersive', mode === 'viewer' || mode === 'slideshow');
    // The previous mode's focused control may just have been hidden: keep the keyboard in the window.
    const a = document.activeElement;
    if (this.win.isFocused?.() !== false && (!a || a === document.body || (this.win.el.contains(a) && !a.offsetParent))) this.focusMain();
    const el = this[mode]?.el;
    if (el && prev && prev !== mode && !reduceMotion() && mode !== 'slideshow') {
      el.animate([{ opacity: 0, transform: mode === 'gallery' ? 'scale(1.01)' : 'scale(0.99)' }, { opacity: 1, transform: 'none' }], { duration: 220, easing: EASE });
    }
  }

  showGallery() {
    const g = this._ensure('gallery');
    this._setMode('gallery');
    this.setTitle(this.t('appName'));
    g.render({ keepScroll: true });
    this.lib.ensureScanned();
    setTimeout(() => {
      if (this.mode === 'gallery' && !this.win.el.contains(document.activeElement)) g.grid.scroll.focus({ preventScroll: true });
    }, 50);
  }

  openViewer(list, index, { from = 'gallery' } = {}) {
    const v = this._ensure('viewer');
    this.viewerFrom = from;
    this._setMode('viewer');
    v.open(list, index, { from });
    setTimeout(() => v.stage.focus({ preventScroll: true }), 30);
  }

  closeViewer() {
    const v = this.viewer;
    if (v?.fs) v.toggleFullscreen(false);
    const cur = v?.item;
    if (this.viewerFrom !== 'gallery') {
      this.viewerFrom = 'gallery';
      this.showGallery();
      return;
    }
    this.showGallery();
    if (cur) {
      this.gallery.grid.scrollToPath(cur.path);
      this.gallery.grid.kb = true;
      this.gallery.grid._setFocus(this.gallery.grid.focusIdx, false);
    }
    if (v) v.loadToken++;
  }

  viewerEmpty() {
    if (this.viewerFrom === 'gallery') this.closeViewer();
    else {
      this.viewerFrom = 'gallery';
      this.showGallery();
    }
  }

  /** Open one image file with its folder siblings in the filmstrip. */
  async openFile(path) {
    let res = null;
    try {
      res = await this.api.invoke('photos:folder', dirName(path));
    } catch {}
    let items = sortByName((res?.items || []).map((it) => this.lib.get(it.path) || it));
    let idx = items.findIndex((it) => it.path === path);
    if (idx < 0) {
      const [one] = isImage(path) ? await this.api.invoke('photos:items', [path]).catch(() => []) : [];
      if (!one) {
        if (!this.mode) this.showGallery();
        this.ui.alert(this.t('cantOpenBody', { name: baseName(path) }), { title: this.t('cantOpenTitle'), parent: this.win });
        return;
      }
      items = [one];
      idx = 0;
    }
    if (this.mode === 'editor' && !(await this.editor.confirmLeave())) return;
    if (this.mode === 'slideshow') this.stopSlideshow();
    this.openViewer(items, idx, { from: 'file' });
  }

  async openEditor(item) {
    if (!item) return;
    const e = this._ensure('editor');
    this._setMode('editor');
    this.setTitle(this.t('editingTitle', { name: item.name }));
    try {
      await e.open(item);
      setTimeout(() => e.tabBtns[e.tool]?.focus({ preventScroll: true }), 30);
    } catch (err) {
      this._setMode('viewer');
      this.setTitle(item.name);
      this.error(this.t('cantEdit', { name: item.name }), err);
    }
  }

  async closeEditor({ force = false } = {}) {
    if (!this.editor) return;
    if (!force && !(await this.editor.confirmLeave())) return;
    this.editor.close();
    this._setMode('viewer');
    if (this.viewer?.item) this.setTitle(this.viewer.item.name);
    if (this._langPending) this._langChanged();
    setTimeout(() => this.viewer?.stage.focus({ preventScroll: true }), 30);
  }

  async editorSaved(item, dest, mode) {
    const name = baseName(dest);
    this.editor.close();
    if (this._langPending) setTimeout(() => this._langChanged(), 0);
    this.viewer.cache.clear();
    if (mode === 'overwrite') {
      await this.refreshItem(item);
      this._setMode('viewer');
      await this.viewer.show(this.viewer.index, 0);
      this.toast(this.t('savedAs', { name }));
      return;
    }
    const [n] = await this.api.invoke('photos:items', [dest]).catch(() => []);
    this._setMode('viewer');
    if (n) {
      this.lib.applyItem(n);
      const it = this.lib.get(dest) || n;
      // The copy appears next to the original (same folder) and becomes the current photo.
      const list = this.viewer.list.filter((x) => x.path !== dest);
      const at = Math.max(0, list.indexOf(item)) + 1;
      list.splice(at, 0, it);
      this.viewer.setList(list, at);
    } else await this.viewer.show(this.viewer.index, 0);
    this.toast(this.t('savedAs', { name }));
  }

  startSlideshow(list, index = 0) {
    if (!list?.length) return;
    const s = this._ensure('slideshow');
    // Starting again while a slideshow runs restarts it; it must not forget where to return to.
    if (this.mode !== 'slideshow') this._slideReturn = this.mode;
    this._setMode('slideshow');
    this.win.setFullscreen(true);
    s.start(list, index);
  }

  stopSlideshow() {
    if (this.mode !== 'slideshow') return;
    const s = this.slideshow;
    const cur = s.current;
    s.stop();
    this.win.setFullscreen(false);
    const back = this._slideReturn === 'viewer' || !this.gallery ? 'viewer' : 'gallery';
    if (back === 'viewer' && this.viewer) {
      this._setMode('viewer');
      const i = this.viewer.list.indexOf(cur);
      if (i >= 0) this.viewer.show(i, 0);
      setTimeout(() => this.viewer.stage.focus({ preventScroll: true }), 30);
    } else if (!this.gallery) this.showGallery();
    else {
      this._setMode('gallery');
      if (cur) this.gallery.grid.scrollToPath(cur.path);
      this.gallery.grid.scroll.focus({ preventScroll: true });
    }
  }

  /** The slideshow could not show any picture of its list. */
  slideshowFailed() {
    this.stopSlideshow();
    this.ui.alert(this.t('slideshowNone'), { title: this.t('errorTitle'), parent: this.win });
  }

  // ================================================================== feedback
  toast(msg) {
    const el = this.h('div', { class: 'ph-toast' }, msg);
    this.toastHost.appendChild(el);
    this.announce(msg);
    while (this.toastHost.children.length > 2) this.toastHost.firstChild.remove();
    if (!reduceMotion()) el.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 200, easing: EASE });
    setTimeout(() => {
      if (!el.isConnected) return;
      if (reduceMotion()) return el.remove();
      el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, fill: 'forwards' }).finished.finally(() => el.remove());
    }, 3200);
  }
  announce(msg) {
    this.live.textContent = '';
    setTimeout(() => (this.live.textContent = msg), 30);
  }
  error(msg, err) {
    console.warn('[photos]', msg, err?.code || err?.message || err);
    const detail = this.errorText(err);
    return this.ui.alert(`${msg}${detail ? `\n\n${detail}` : ''}`, { title: this.t('errorTitle'), parent: this.win });
  }

  /** A short, translated explanation of a failure (system error codes → plain words). */
  errorText(err) {
    if (!err) return '';
    const code = err.code || '';
    const msg = String(err.message || err);
    const has = (c) => code === c || new RegExp(`\\b${c}\\b`).test(msg);
    if (has('ENOENT') || has('ENOTDIR') || /\bHTTP 404\b/.test(msg)) return this.t('err.notFound');
    if (has('EACCES') || has('EPERM')) return this.t('err.denied');
    if (has('ENOSPC') || has('EDQUOT')) return this.t('err.noSpace');
    if (has('EROFS')) return this.t('err.readOnly');
    if (has('EEXIST')) return this.t('err.exists');
    if (has('EISDIR')) return this.t('err.isDir');
    if (msg === 'decode' || msg === 'encode' || msg === 'empty' || (code === 'EINVAL' && /JPEG|image/i.test(msg))) return this.t('err.invalid');
    return msg;
  }

  /** Items whose file still exists (fresh metadata); the others are reported once. */
  async existing(items) {
    const got = await this.api.invoke('photos:items', items.map((x) => x.path)).catch(() => items.map(() => null));
    const ok = items.filter((_, i) => got[i]);
    const gone = items.filter((_, i) => !got[i]);
    if (gone.length) {
      // (a rescan drops them from the gallery; favorites / albums are kept in case the files come back)
      if (gone.some((x) => this.lib.get(x.path))) this.lib.scan();
      this.ui.alert(this.t('missingFile', { name: gone[0].name }), { title: this.t('errorTitle'), parent: this.win });
    }
    return ok;
  }

  // ================================================================== commands
  async refreshItem(item) {
    const [n] = await this.api.invoke('photos:items', [item.path]).catch(() => []);
    if (!n) return null;
    this.thumbs.forget(item);
    const libItem = this.lib.get(item.path);
    Object.assign(item, n);
    if (libItem && libItem !== item) Object.assign(libItem, n);
    this.lib.applyItem(item);
    return item;
  }

  async rotateFile(item, steps = 1) {
    const ext = extOf(item.path);
    if (!ROTATABLE.includes(ext)) throw new Error(this.t('rotateUnavailable'));
    let done = false;
    if (ext === '.jpg' || ext === '.jpeg') {
      const res = await this.api.invoke('photos:rotate', item.path, steps);
      done = !!res?.done;
    }
    if (!done) {
      const img = await loadPixels(`${this.api.mediaUrl(item.path)}?v=${Date.now()}`);
      const edit = { ...P.defaultEdit(), rot: ((steps % 4) + 4) % 4 };
      const canvas = P.render(img, img.naturalWidth, img.naturalHeight, edit, { scale: 1 });
      const blob = await P.encode(canvas, ext, 0.95);
      await this.api.invoke('photos:write', item.path, new Uint8Array(await blob.arrayBuffer()));
    }
    await this.refreshItem(item);
    return item;
  }

  async deleteItems(items) {
    // Files already being deleted (double click, key repeat) are skipped instead of failing twice.
    const busy = (this._deleting ||= new Set());
    items = items.filter((x) => x && !busy.has(x.path));
    if (!items.length) return false;
    for (const x of items) busy.add(x.path);
    try {
      return await this._deleteItems(items);
    } finally {
      for (const x of items) busy.delete(x.path);
    }
  }

  async _deleteItems(items) {
    const { t, h } = this;
    if (this.lib.prefs.confirmDelete) {
      const dont = this.ui.toggle ? h('label', { class: 'checkbox ph-dont-ask' }, h('input', { type: 'checkbox' }), h('span', null, t('dontAskAgain'))) : null;
      const body = h('div', { class: 'ph-del-body' }, h('div', null, items.length === 1 ? t('deleteOne', { name: items[0].name }) : t('deleteMany', { count: items.length })), h('div', { class: 'caption text-2' }, t('deleteHint')), dont);
      const v = await this.ui.dialog({
        title: items.length === 1 ? t('deleteTitleOne') : t('deleteTitleMany', { count: items.length }),
        body,
        parent: this.win,
        className: 'ph-del-dialog',
        buttons: [
          { label: t('delete'), value: 'delete', primary: true },
          { label: t('common.cancel'), value: null },
        ],
      });
      if (v !== 'delete') return false;
      if (dont?.querySelector('input').checked) this.lib.setPref('confirmDelete', false);
    }
    const paths = items.map((x) => x.path);
    try {
      await this.api.invoke('fs:trash', paths);
    } catch (err) {
      this.error(t('deleteFailed'), err);
      return false;
    }
    for (const it of items) this.thumbs.forget(it);
    this.lib.removed(paths);
    this.viewer?.removed(paths);
    this.gallery?.grid.clearSelection();
    this.toast(items.length === 1 ? t('deletedOne') : t('deletedMany', { count: items.length }));
    return true;
  }

  async copyItems(items) {
    items = items.filter(Boolean);
    if (!items.length) return;
    items = await this.existing(items);
    if (!items.length) return;
    this.shell.clipboard.setFiles(items.map((x) => x.path), 'copy');
    // A single photo also goes to the system clipboard as a picture (paste into other apps).
    if (items.length === 1 && extOf(items[0].path) !== '.svg') {
      try {
        const img = await loadPixels(`${this.api.mediaUrl(items[0].path)}?v=${items[0].mtime}`);
        const c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext('2d').drawImage(img, 0, 0);
        const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
        if (blob) await this.api.invoke('clipboard:writeImage', new Uint8Array(await blob.arrayBuffer()));
      } catch {}
    }
    this.toast(items.length === 1 ? this.t('copiedOne') : this.t('copiedMany', { count: items.length }));
  }

  showInFolder(item) {
    if (item) this.shell.launch('files', { select: item.path });
  }

  async setAs(kind, item) {
    const key = kind === 'lock' ? 'lockWallpaper' : 'wallpaper';
    try {
      // Never point the background at a file that is gone (it would show a blank desktop).
      const [n] = await this.api.invoke('photos:items', [item.path]).catch(() => [null]);
      if (!n) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      await this.shell.settings.set(key, item.path);
      this.toast(kind === 'lock' ? this.t('setLockDone') : this.t('setDesktopDone'));
    } catch (err) {
      this.error(this.t('setFailed'), err);
    }
  }

  openWithItems(item) {
    const ext = extOf(item.path);
    const reg = this.shell.registry;
    const apps = reg
      .list()
      .filter((m) => m.id !== 'photos' && ((m.fileTypes || []).includes(ext) || (m.defaultFor || []).includes(ext)));
    return [
      { label: this.t('photosNewWindow'), action: () => this.shell.launch('photos', { file: item.path }) },
      ...apps.map((m) => ({ label: reg.name(m.id), action: () => this.shell.openFile(item.path, { appId: m.id }) })),
    ];
  }

  async saveAs(item) {
    if (!item) return;
    const { t } = this;
    const ext0 = extOf(item.path);
    // "All supported pictures" first: the extension typed in the name picks the format.
    const all = [ext0, ...['.jpg', '.jpeg', '.png', '.webp', '.bmp'].filter((e) => e !== ext0)];
    const filters = [{ name: t('fmt.all'), ext: all }, { name: t('fmt.same', { ext: ext0.slice(1).toUpperCase() }), ext: [ext0] }];
    for (const [n, e] of [['fmt.jpeg', ['.jpg', '.jpeg']], ['fmt.png', ['.png']], ['fmt.webp', ['.webp']], ['fmt.bmp', ['.bmp']]]) if (!e.includes(ext0)) filters.push({ name: t(n), ext: e });
    const dest = await this.ui.filePicker({ mode: 'save', title: t('saveAs'), path: dirName(item.path), name: item.name, filters, parent: this.win });
    if (!dest) return;
    const ext = extOf(dest);
    try {
      if (ext === ext0 || (['.jpg', '.jpeg'].includes(ext) && ['.jpg', '.jpeg'].includes(ext0))) await this.api.invoke('photos:copyFile', item.path, dest);
      else {
        const img = await loadPixels(`${this.api.mediaUrl(item.path)}?v=${item.mtime}`);
        const canvas = P.render(img, img.naturalWidth || 1024, img.naturalHeight || 1024, P.defaultEdit(), { scale: 1 });
        const blob = await P.encode(canvas, ENCODABLE[ext] || ext === '.bmp' ? ext : '.png', (this.lib.prefs.jpegQuality || 92) / 100);
        await this.api.invoke('photos:write', dest, new Uint8Array(await blob.arrayBuffer()));
      }
      this.toast(t('savedAs', { name: baseName(dest) }));
      const [n] = await this.api.invoke('photos:items', [dest]).catch(() => []);
      if (n) this.lib.applyItem(n);
    } catch (err) {
      this.error(t('saveFailed', { name: baseName(dest) }), err);
    }
  }

  async renameItem(item) {
    if (!item) return;
    const { t } = this;
    const name = await this.ui.prompt({
      title: t('rename'),
      label: t('newName'),
      value: item.name,
      parent: this.win,
      validate: (v) => {
        const s = v.trim();
        if (!s || s === '.' || s === '..' || s.includes('/')) return t('invalidName');
        if (s !== item.name && extOf(s) !== extOf(item.name) && !isImage(s)) return t('keepExtension');
        return null;
      },
    });
    if (!name || name.trim() === item.name) return;
    try {
      const res = await this.api.invoke('fs:rename', item.path, name.trim());
      const old = item.path;
      const [n] = await this.api.invoke('photos:items', [res.path]).catch(() => []);
      this.thumbs.forget(item);
      this.lib.renamed(old, n || { ...item, path: res.path, name: res.name });
      if (n) Object.assign(item, n);
      if (this.viewer?.item === item) this.viewer._updateChrome();
      if (this.viewer?.infoOpen) this.viewer._renderInfo();
    } catch (err) {
      this.error(t('renameFailed'), err);
    }
  }

  async addFolder() {
    const dir = await this.ui.filePicker({ mode: 'folder', title: this.t('addFolder'), parent: this.win, path: this.lib.xdg?.home });
    if (!dir) return;
    const inside = this.lib.roots().find((r) => dir === r || dir.startsWith(`${r}/`));
    if (inside) {
      this.toast(this.t('folderAlready', { name: baseName(dir) }));
      return;
    }
    this.lib.addFolder(dir);
    this.toast(this.t('folderAdded', { name: baseName(dir) }));
  }

  async removeFolder(dir) {
    const ok = await this.ui.confirm(this.t('removeFolderBody', { name: baseName(dir) }), { title: this.t('removeFolderTitle'), okLabel: this.t('removeFolder'), parent: this.win });
    if (ok) this.lib.removeFolder(dir);
  }

  async newAlbum(paths = []) {
    const name = await this.ui.prompt({ title: this.t('newAlbum'), label: this.t('albumName'), value: this.t('newAlbumName'), parent: this.win, validate: (v) => (v.trim() ? null : this.t('nameRequired')) });
    if (!name) return null;
    const a = this.lib.createAlbum(name, paths);
    if (paths.length) this.toast(this.t('addedToAlbum', { count: paths.length, album: a.name }));
    if (this.mode === 'gallery') {
      this.gallery.grid.setSelectMode(false);
      if (paths.length) this.gallery.navigate({ page: 'album', id: a.id });
      else {
        this.gallery.navigate({ page: 'album', id: a.id });
      }
    }
    return a;
  }

  async renameAlbum(a) {
    const name = await this.ui.prompt({ title: this.t('renameAlbum'), label: this.t('albumName'), value: a.name, parent: this.win, validate: (v) => (v.trim() ? null : this.t('nameRequired')) });
    if (name) this.lib.renameAlbum(a.id, name);
  }

  async deleteAlbum(a) {
    const ok = await this.ui.confirm(this.t('deleteAlbumBody', { name: a.name }), { title: this.t('deleteAlbum'), okLabel: this.t('delete'), parent: this.win });
    if (!ok) return;
    this.lib.deleteAlbum(a.id);
    if (this.gallery?.route.page === 'album' && this.gallery.route.id === a.id) this.gallery.navigate({ page: 'albums' }, { push: false });
  }

  goToAlbum(id) {
    this.closeViewer();
    this.gallery.navigate({ page: 'album', id });
  }

  albumMenu(e, paths) {
    const { t } = this;
    const items = this.lib.albums.slice(0, 30).map((a) => ({
      label: a.name,
      icon: 'album',
      action: () => {
        const n = this.lib.addToAlbum(a.id, paths);
        this.toast(n ? t('addedToAlbum', { count: n, album: a.name }) : t('alreadyInAlbum', { album: a.name }));
        this.gallery?.grid.setSelectMode(false);
        this.gallery?._renderSelbar();
      },
    }));
    return this.ui.menu(e, [...items, items.length ? '-' : null, { label: t('newAlbumEllipsis'), icon: 'add', action: () => this.newAlbum(paths) }].filter(Boolean));
  }

  albumSubmenu(paths) {
    const { t } = this;
    return [
      ...this.lib.albums.slice(0, 30).map((a) => ({
        label: a.name,
        action: () => {
          const n = this.lib.addToAlbum(a.id, paths);
          this.toast(n ? t('addedToAlbum', { count: n, album: a.name }) : t('alreadyInAlbum', { album: a.name }));
        },
      })),
      this.lib.albums.length ? '-' : null,
      { label: t('newAlbumEllipsis'), action: () => this.newAlbum(paths) },
    ].filter(Boolean);
  }

  // Print a photo fitted to the page (centred, never cropped; landscape paper for a wide photo): core/print.js.
  async printItem(item) {
    if (!item || this._printing) return null;
    this._printing = true;
    try {
      const { printDialog, printDocument, escapeHtml } = await import('../../../core/print.js');
      // The print page is a local file: it reads the photo straight from its file:// URL.
      const src = `file://${item.path.split('/').map(encodeURIComponent).join('/')}`;
      let w = Number(item.width) || 0;
      let hgt = Number(item.height) || 0;
      if (!w || !hgt) {
        const img = new Image();
        img.src = `${this.api.mediaUrl(item.path)}?v=${Math.round(item.mtime || 0)}-${item.size || 0}`;
        await img.decode().catch(() => {});
        w = img.naturalWidth;
        hgt = img.naturalHeight;
      }
      const PAGE = { A4: [8.27, 11.69], Letter: [8.5, 11], Legal: [8.5, 14], A5: [5.83, 8.27], A3: [11.69, 16.54] };
      const margin = 0.4;
      const name = item.path.split('/').pop();
      return await printDialog({
        title: name,
        parent: this.win,
        appId: 'photos',
        shell: this.ctx?.shell,
        render: 'webcontents',
        landscape: w > 0 && hgt > 0 && w > hgt * 1.05,
        margin,
        html: ({ pageSize, landscape }) => {
          // The printable box of one sheet, in inches (a hair smaller so the photo never spills onto a 2nd page).
          let [pw, ph] = PAGE[pageSize] || PAGE.A4;
          if (landscape) [pw, ph] = [ph, pw];
          const bw = (pw - 2 * margin - 0.05).toFixed(2);
          const bh = (ph - 2 * margin - 0.05).toFixed(2);
          const css =
            `.ph-page{width:${bw}in;height:${bh}in;display:flex;align-items:center;justify-content:center;overflow:hidden;break-inside:avoid}` +
            '.ph-page img{max-width:100%;max-height:100%;object-fit:contain;image-orientation:from-image}';
          return printDocument({ title: name, css, body: `<div class="ph-page"><img src="${escapeHtml(src)}" alt=""></div>` });
        },
      });
    } finally {
      this._printing = false;
    }
  }

  itemMenu(e, item, items, { album = null, viewer = false } = {}) {
    const { t } = this;
    const single = items.length === 1;
    const paths = items.map((x) => x.path);
    const allFav = paths.every((p) => this.lib.isFavorite(p));
    const canRotate = ROTATABLE.includes(extOf(item.path));
    const grid = this.gallery?.grid;
    const menu = [
      !viewer && single ? { label: t('open'), icon: 'open', shortcut: t('key.enter'), action: () => grid && this.openViewer(grid.flat, grid.pos.get(item.path) ?? 0, { from: 'gallery' }) } : null,
      single ? { label: t('openWith'), icon: 'apps_list', submenu: this.openWithItems(item) } : null,
      !viewer && single ? '-' : null,
      { label: allFav ? t('unfavorite') : t('favorite'), icon: 'heart', shortcut: 'Ctrl+D', action: () => this.lib.toggleFavorite(paths) },
      { label: t('addToAlbum'), icon: 'album_add', submenu: this.albumSubmenu(paths) },
      album ? { label: t('removeFromAlbum'), icon: 'image_off', action: () => this.lib.removeFromAlbum(album, paths) } : null,
      album && single ? { label: t('setCover'), icon: 'image', action: () => this.lib.setCover(album, item.path) } : null,
      '-',
      single ? { label: t('edit'), icon: 'image_edit', shortcut: 'Ctrl+E', action: () => (viewer ? this.openEditor(item) : this._openThen(item, () => this.openEditor(this.viewer.item))) } : null,
      single && canRotate ? { label: t('rotate'), icon: 'arrow_rotate_clockwise', shortcut: 'Ctrl+R', action: () => (viewer ? this.viewer.rotate(1) : this.rotateFile(item, 1).catch((err) => this.error(t('rotateFailed'), err))) } : null,
      single
        ? {
            label: t('setAs'),
            icon: 'desktop',
            submenu: [
              { label: t('setDesktop'), action: () => this.setAs('desktop', item) },
              { label: t('setLock'), action: () => this.setAs('lock', item) },
            ],
          }
        : null,
      { label: t('copy'), icon: 'copy', shortcut: 'Ctrl+C', action: () => this.copyItems(items) },
      viewer ? { label: t('saveAs'), icon: 'save', shortcut: `Ctrl+${t('key.shift')}+S`, action: () => this.saveAs(item) } : null,
      single ? { label: t('print'), icon: 'printer', shortcut: 'Ctrl+P', action: () => this.printItem(item) } : null,
      single ? { label: t('rename'), icon: 'rename', shortcut: 'F2', action: () => this.renameItem(item) } : null,
      { label: t('openFileLocation'), icon: 'folder_open', action: () => this.showInFolder(item) },
      viewer ? '-' : null,
      viewer ? { label: t('slideshow'), icon: 'slide_play', shortcut: 'F5', action: () => this.startSlideshow(this.viewer.list, this.viewer.index) } : null,
      viewer ? { label: t('fileInfo'), icon: 'info', shortcut: 'I', action: () => this.viewer.toggleInfo() } : null,
      !viewer ? { label: t('selectMode'), icon: 'multiselect_ltr', action: () => grid && (grid.selectPaths([...new Set([...grid.selected, ...paths])]), grid.setSelectMode(true), this.gallery._renderSelbar()) } : null,
      '-',
      { label: t('delete'), icon: 'delete', shortcut: t('key.del'), action: () => this.deleteItems(items) },
    ];
    // Collapse separators.
    const clean = [];
    for (const m of menu) {
      if (!m) continue;
      if (m === '-' && (!clean.length || clean[clean.length - 1] === '-')) continue;
      clean.push(m);
    }
    if (clean[clean.length - 1] === '-') clean.pop();
    return this.ui.menu(e, clean);
  }

  _openThen(item, fn) {
    const grid = this.gallery?.grid;
    if (!grid) return;
    this.openViewer(grid.flat, grid.pos.get(item.path) ?? 0, { from: 'gallery' });
    setTimeout(fn, 0);
  }

  // ================================================================== keyboard
  _bindKeys() {
    this.win.el.addEventListener('keydown', (e) => {
      if (e.defaultPrevented) return;
      const tgt = e.target;
      if (tgt.closest?.('.dialog-layer, .menu')) return;
      // A dialog of this window is open but its focus hasn't landed yet: keys are for the dialog, not the page.
      const layer = this.win.el.querySelector(':scope > .dialog-layer:not(.closing)');
      if (layer) {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'Escape') layer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        (layer.querySelector('input, textarea, select, [autofocus]') || layer.querySelector('.btn.primary') || layer.querySelector('button'))?.focus();
        return;
      }
      const typing = tgt.matches?.('input:not([type="range"]):not([type="checkbox"]), textarea, select, [contenteditable="true"]');
      let handled = false;
      if (this.mode === 'slideshow') handled = this.slideshow.onKey(e);
      else if (this.mode === 'editor') {
        if (typing && e.key !== 'Escape') return;
        handled = this.editor.onKey(e);
      } else if (this.mode === 'viewer') {
        if (typing) return;
        if (tgt.closest?.('.ph-info') && !['Escape'].includes(e.key) && !e.ctrlKey) return;
        if ((e.key === 'Enter' || e.key === ' ') && tgt.closest?.('button, a, .ph-film-item')) return;
        // The zoom slider keeps its own arrow / Home / End / Page keys (they must not browse photos).
        if (tgt.matches?.('input[type="range"]') && /^(Arrow|Home$|End$|Page)/.test(e.key) && !e.ctrlKey) return;
        handled = this.viewer.onKey(e);
      } else if (this.mode === 'gallery') handled = this._galleryKey(e, typing);
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    });
  }

  _galleryKey(e, typing) {
    const ctrl = e.ctrlKey || e.metaKey;
    const g = this.gallery;
    if (ctrl && (e.key === 'f' || e.key === 'F')) {
      g.searchInput.focus();
      g.searchInput.select();
      return true;
    }
    if (typing) return false;
    const grid = g.grid;
    const inGrid = grid.el.isConnected && grid.scroll.contains(e.target);
    if (e.key === 'F5' && grid.flat.length) {
      this.startSlideshow(grid.flat, Math.max(0, grid.focusIdx));
      return true;
    }
    if (!inGrid) {
      if (e.key === 'Escape' && (g.route.page === 'album' || g.route.page === 'search')) {
        g.back();
        return true;
      }
      return false;
    }
    const focused = grid.focusIdx >= 0 ? grid.flat[grid.focusIdx] : null;
    const sel = grid.selected.size ? grid.selectedItems() : focused ? [focused] : [];
    if (ctrl && (e.key === 'd' || e.key === 'D') && sel.length) {
      this.lib.toggleFavorite(sel.map((x) => x.path));
      return true;
    }
    if (ctrl && (e.key === 'c' || e.key === 'C') && sel.length) {
      this.copyItems(sel);
      return true;
    }
    if (ctrl && (e.key === 'e' || e.key === 'E') && focused) {
      this._openThen(focused, () => this.openEditor(this.viewer.item));
      return true;
    }
    if (e.key === 'F2' && focused) {
      this.renameItem(focused);
      return true;
    }
    if (e.key === 'Escape' && (g.route.page === 'album' || g.route.page === 'search') && !grid.isSelecting()) {
      g.back();
      return true;
    }
    return false;
  }

  // ================================================================== drag & drop
  _bindDnD() {
    const el = this.win.el;
    el.addEventListener('dragstart', () => (this._ownDrag = true));
    el.addEventListener('dragend', () => (this._ownDrag = false));
    const accepts = (e) => {
      if (this._ownDrag || this.mode === 'editor' || this.mode === 'slideshow') return false;
      const types = [...(e.dataTransfer?.types || [])];
      return types.includes('Files') || types.includes(DND_MIME);
    };
    let depth = 0;
    el.addEventListener('dragenter', (e) => {
      if (!accepts(e)) return;
      depth++;
      this.dropHint.hidden = false;
    });
    el.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (!depth) this.dropHint.hidden = true;
    });
    el.addEventListener('dragover', (e) => {
      if (!accepts(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    el.addEventListener('drop', async (e) => {
      depth = 0;
      this.dropHint.hidden = true;
      if (!accepts(e)) return;
      e.preventDefault();
      let paths = trustedDragPaths(e.dataTransfer);
      if (!paths.length) paths = [...(e.dataTransfer.files || [])].map((f) => this.api.pathForFile(f)).filter(Boolean);
      await this.openDropped(paths);
    });
  }

  async openDropped(paths) {
    const images = paths.filter(isImage);
    if (!images.length) {
      // A dropped folder is added to the library.
      for (const p of paths) {
        const st = await this.api.invoke('fs:stat', p).catch(() => null);
        if (st?.dir) {
          if (!this.lib.roots().some((r) => p === r || p.startsWith(`${r}/`))) {
            this.lib.addFolder(p);
            this.toast(this.t('folderAdded', { name: baseName(p) }));
          } else this.toast(this.t('folderAlready', { name: baseName(p) }));
          if (this.mode !== 'gallery') this.showGallery();
          return;
        }
      }
      if (paths.length) this.toast(this.t('notImages'));
      return;
    }
    if (images.length === 1) return this.openFile(images[0]);
    const items = await this.lib.resolve(images);
    if (items.length) this.openViewer(items, 0, { from: 'drop' });
  }
}

export { stem };
