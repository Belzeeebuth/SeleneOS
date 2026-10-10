// Aurora Browser — the favorites bar under the toolbar (Ctrl+Shift+B): favorites and folders
// (folders open Fluent menus, nested folders as submenus), "Other favorites" on the right,
// an overflow chevron, drag & drop reordering and context menus.
import { h, icon, clear } from './dom.js';
import { shared } from './shared.js';
import { showMenu } from './menu.js';
import * as panels from './panels.js';
import { displayUrl } from './util.js';

export function barMode(prefs) {
  if (prefs.showBar === true || prefs.showBar === 'always') return 'always';
  if (prefs.showBar === 'newtab') return 'newtab';
  return 'never';
}

export class FavBar {
  constructor(bw) {
    this.bw = bw;
    this.items = h('div', { class: 'bw-fav-items' });
    this.other = h('div', { class: 'bw-fav-other' });
    this.el = h('div', { class: 'bw-favbar', role: 'toolbar' }, this.items, this.other);
    this.el.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.bw-fav')) return;
      e.preventDefault();
      this.barMenu(e);
    });
    this.items.addEventListener('dragover', (e) => this.onDragOver(e));
    this.items.addEventListener('dragleave', (e) => {
      if (!this.items.contains(e.relatedTarget)) this.clearDrop();
    });
    this.items.addEventListener('drop', (e) => this.onDrop(e));
    this.render();
  }

  get store() {
    return shared.store;
  }

  updateVisibility() {
    const mode = barMode(this.bw.prefs);
    const onNewTab = this.bw.entry(this.bw.active)?.route === 'newtab';
    const show = mode === 'always' || (mode === 'newtab' && onNewTab);
    const was = !this.el.hidden;
    this.el.hidden = !show;
    this.el.setAttribute('aria-label', this.bw.t('fav.bar'));
    if (show && !was) this.layout();
  }

  favIcon(node) {
    if (node.type === 'folder') return icon('folder', { size: 16, class: 'bw-fav-folder' });
    if (/^aurora:/i.test(node.url)) return h('img', { src: 'app://shell/apps/browser/icon.svg', alt: '', draggable: false });
    const f = this.store.favicon(node.url);
    return f ? h('img', { src: f, alt: '', draggable: false }) : icon('globe', { size: 16 });
  }

  button(node) {
    const t = this.bw.t;
    const label = node.title || (node.type === 'folder' ? t('fav.untitledFolder') : displayUrl(node.url));
    const b = h(
      'button',
      {
        class: ['bw-fav', node.type === 'folder' && 'folder'],
        draggable: 'true',
        dataset: { id: node.id, tip: node.type === 'url' ? `${label} — ${displayUrl(node.url)}` : label, tipPos: 'below' },
      },
      this.favIcon(node),
      h('span', { class: 'bw-fav-label' }, label),
    );
    b.addEventListener('click', (e) => {
      if (node.type === 'folder') this.openFolder(node, b);
      else this.bw.openFromLink(node.url, e);
    });
    b.addEventListener('auxclick', (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      if (node.type === 'url') this.bw.openUrl(node.url, { active: false, opener: this.bw.active });
      else this.openAll(node);
    });
    b.addEventListener('mousedown', (e) => e.button === 1 && e.preventDefault());
    b.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      panels.favoriteItemMenu(this.bw, node, e);
    });
    b.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/x-aurora-fav', node.id);
      if (node.type === 'url') e.dataTransfer.setData('text/uri-list', node.url);
      e.dataTransfer.effectAllowed = 'move';
      this.dragId = node.id;
      b.classList.add('dragging');
    });
    b.addEventListener('dragend', () => {
      b.classList.remove('dragging');
      this.dragId = null;
      this.clearDrop();
    });
    return b;
  }

  render() {
    const t = this.bw.t;
    clear(this.items);
    clear(this.other);
    const bar = this.store.bookmarks.bar;
    this.buttons = bar.children.map((n) => this.button(n));
    for (const b of this.buttons) this.items.appendChild(b);
    if (!bar.children.length) {
      this.items.appendChild(
        h(
          'div',
          { class: 'bw-fav-empty caption' },
          h('span', null, t('fav.barEmpty')),
          h('a', { href: '#', onclick: (e) => (e.preventDefault(), this.bw.openInternal('favorites')) }, t('fav.manage')),
        ),
      );
    }
    this.chevron = h('button', { class: 'bw-fav bw-fav-more', hidden: true, 'aria-label': t('fav.more'), 'data-tip': t('fav.more'), 'data-tip-pos': 'below', onclick: () => this.overflowMenu() }, icon('chevron_double_right', { size: 14 }));
    this.other.appendChild(this.chevron);
    const other = this.store.bookmarks.other;
    if (other.children.length) {
      this.otherBtn = h('button', { class: 'bw-fav folder', dataset: { id: 'other' }, onclick: () => this.openFolder(other, this.otherBtn) }, icon('folder', { size: 16, class: 'bw-fav-folder' }), h('span', { class: 'bw-fav-label' }, t('fav.other')));
      this.otherBtn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.barMenu(e);
      });
      this.other.appendChild(this.otherBtn);
    }
    this.layout();
  }

  refreshIcons() {
    clearTimeout(this._iconTimer);
    this._iconTimer = setTimeout(() => this.render(), 200);
  }

  layout() {
    if (this.el.hidden || !this.el.isConnected || !this.buttons) return;
    for (const b of this.buttons) b.hidden = false;
    this.chevron.hidden = true;
    const avail = this.items.clientWidth;
    if (!avail) return;
    let used = 0;
    this.overflow = [];
    const gap = 2;
    this.buttons.forEach((b, i) => {
      used += b.offsetWidth + gap;
      if (used > avail) {
        b.hidden = true;
        this.overflow.push(this.store.bookmarks.bar.children[i]);
      }
    });
    this.chevron.hidden = !this.overflow.length;
  }

  menuItems(nodes) {
    const t = this.bw.t;
    const out = nodes.map((n) => {
      if (n.type === 'folder') return { label: n.title || t('fav.untitledFolder'), icon: 'folder', submenu: () => this.menuItems(n.children), middle: () => this.openAll(n) };
      const f = /^aurora:/i.test(n.url) ? 'app://shell/apps/browser/icon.svg' : this.store.favicon(n.url);
      return {
        label: n.title || displayUrl(n.url),
        img: f || undefined,
        icon: f ? undefined : 'globe',
        title: displayUrl(n.url),
        action: () => this.bw.openFromLink(n.url),
        middle: () => this.bw.openUrl(n.url, { active: false, opener: this.bw.active }),
      };
    });
    if (!out.length) return [{ empty: t('fav.emptyFolder') }];
    const urls = nodes.filter((n) => n.type === 'url');
    if (urls.length > 1) out.push('-', { label: t('fav.openAll', { count: urls.length }), icon: 'tab_desktop_multiple', action: () => this.openAll({ children: nodes }) });
    return out;
  }

  openFolder(node, anchor) {
    anchor.classList.add('open');
    showMenu(anchor, this.menuItems(node.children), { className: this.bw.private ? 'bw-private' : '', onClose: () => anchor.classList.remove('open') });
  }

  overflowMenu() {
    showMenu(this.chevron, this.menuItems(this.overflow || []), { className: this.bw.private ? 'bw-private' : '', align: 'right' });
  }

  openAll(folder) {
    const urls = folder.children.filter((n) => n.type === 'url').map((n) => n.url);
    urls.forEach((u, i) => this.bw.openUrl(u, { active: i === 0 && false, opener: this.bw.active }));
  }

  barMenu(e) {
    const { t } = this.bw;
    const bw = this.bw;
    const mode = barMode(bw.prefs);
    shared.ui.menu(
      e,
      [
        { label: t('fav.addPage'), icon: 'star_add', action: () => panels.favoriteFlyout(bw), disabled: !bw.tabUrl(bw.active) || bw.tabUrl(bw.active) === 'aurora://newtab' },
        { label: t('fav.addFolder'), icon: 'folder_add', action: () => panels.newFolderDialog(bw, 'bar') },
        '-',
        {
          label: t('fav.showBar'),
          icon: 'star_line_horizontal_3',
          submenu: [
            { label: t('fav.barAlways'), checked: mode === 'always', action: () => shared.store.setPref('showBar', 'always') },
            { label: t('fav.barNever'), checked: mode === 'never', action: () => shared.store.setPref('showBar', 'never') },
            { label: t('fav.barNewTab'), checked: mode === 'newtab', action: () => shared.store.setPref('showBar', 'newtab') },
          ],
        },
        { label: t('fav.manage'), icon: 'settings', shortcut: 'Ctrl+Shift+O', action: () => bw.openInternal('favorites') },
      ],
      { class: bw.menuClass() },
    );
  }

  // ---- drag & drop reordering
  dropTarget(e) {
    const btns = this.buttons.filter((b) => !b.hidden);
    for (let i = 0; i < btns.length; i++) {
      const r = btns[i].getBoundingClientRect();
      const node = this.store.bookmarks.bar.children[this.buttons.indexOf(btns[i])];
      if (e.clientX < r.left + r.width / 2) {
        if (node?.type === 'folder' && e.clientX > r.left + r.width * 0.25) return { into: node, el: btns[i] };
        return { index: this.buttons.indexOf(btns[i]), el: btns[i], side: 'before' };
      }
      if (node?.type === 'folder' && e.clientX < r.right - r.width * 0.25) return { into: node, el: btns[i] };
    }
    const last = btns[btns.length - 1];
    return { index: this.store.bookmarks.bar.children.length, el: last, side: 'after' };
  }

  onDragOver(e) {
    const types = [...(e.dataTransfer?.types || [])];
    if (!types.includes('application/x-aurora-fav') && !types.includes('text/uri-list')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = types.includes('application/x-aurora-fav') ? 'move' : 'copy';
    const tgt = this.dropTarget(e);
    this.clearDrop();
    if (!tgt.el) return;
    if (tgt.into) tgt.el.classList.add('drop-into');
    else tgt.el.classList.add(tgt.side === 'before' ? 'drop-before' : 'drop-after');
  }

  clearDrop() {
    for (const b of this.items.querySelectorAll('.drop-before, .drop-after, .drop-into')) b.classList.remove('drop-before', 'drop-after', 'drop-into');
  }

  onDrop(e) {
    e.preventDefault();
    this.clearDrop();
    const tgt = this.dropTarget(e);
    const id = e.dataTransfer.getData('application/x-aurora-fav');
    if (id) {
      if (tgt.into) this.store.moveNode(id, tgt.into.id, -1);
      else this.store.moveNode(id, 'bar', tgt.index);
      return;
    }
    const url = (e.dataTransfer.getData('text/uri-list') || '').split('\n').find((l) => l && !l.startsWith('#'));
    if (url && /^(https?|aurora):/i.test(url.trim())) {
      const u = url.trim();
      const title = e.dataTransfer.getData('text/plain') && e.dataTransfer.getData('text/plain') !== u ? e.dataTransfer.getData('text/plain') : '';
      this.store.addBookmark({ title: title || u, url: u, parentId: tgt.into ? tgt.into.id : 'bar', index: tgt.into ? -1 : tgt.index });
    }
  }
}
