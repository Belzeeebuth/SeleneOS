// Address bar (breadcrumbs with per-segment folder dropdowns, editable path with autocomplete)
// and the search box of a File Explorer window.
import { shared } from './shared.js';
import * as T from './types.js';

export class AddressBar {
  constructor(ex) {
    this.ex = ex;
    const { h, icon } = ex;
    this.locIcon = h('img', { class: 'fx-addr-ic', alt: '', draggable: false });
    this.crumbs = h('div', { class: 'fx-crumbs' });
    this.input = h('input', {
      class: 'fx-addr-input',
      spellcheck: false,
      autocomplete: 'off',
      'aria-label': ex.t('address.label'),
      onkeydown: (e) => this.onInputKey(e),
      oninput: () => this.suggest(),
      onblur: () => setTimeout(() => {
        if (this.editing && !this.el.contains(document.activeElement)) this.endEdit();
      }, 120),
    });
    this.historyBtn = h('button', {
      class: 'fx-addr-hist',
      tabindex: '-1',
      'aria-label': ex.t('address.recent'),
      'data-tip': ex.t('address.recent'),
      onclick: (e) => this.historyMenu(e),
    }, icon('chevron_down', { size: 12 }));
    this.sugBox = h('div', { class: 'fx-suggest', role: 'listbox', hidden: true });
    this.el = h('div', {
      class: 'fx-address',
      role: 'navigation',
      tabindex: '0',
      onfocus: (e) => {
        // Reaching the address bar with Tab (or clicking its empty area) switches to editing.
        if (e.target === this.el && !this.editing) this.beginEdit();
      },
      'aria-label': ex.t('address.label'),
      onclick: (e) => {
        if (this.editing) return;
        if (e.target === this.el || e.target === this.crumbs || e.target === this.locIcon) this.beginEdit();
      },
    }, this.locIcon, this.crumbs, this.input, this.historyBtn, this.sugBox);
    this.segments = [];
    this.editing = false;
    this.sugIndex = -1;
    this.sugItems = [];
    new ResizeObserver(() => !this.editing && this.fit()).observe(this.el);
  }

  // Breadcrumb segments for a location: [{label, loc}]
  segmentsFor(loc) {
    const t = this.ex.t;
    const x = shared.xdg;
    const pc = { label: t('places.thisPc'), loc: { type: 'thispc' } };
    if (loc.type === 'home') return [{ label: t('places.home'), loc }];
    if (loc.type === 'gallery') return [{ label: t('places.gallery'), loc }];
    if (loc.type === 'thispc') return [pc];
    if (loc.type === 'trash') return [{ label: t('places.trash'), loc }];
    if (loc.type === 'search') {
      return [...this.segmentsFor(loc.root), { label: t('search.resultsIn', { name: this.ex.locName(loc.root) }), loc }];
    }
    const p = loc.path;
    // Inside the home folder the path starts at "Home folder" (with a house glyph); known folders
    // keep their translated names.
    let base = null;
    if (p === shared.home || T.isInside(p, shared.home)) {
      const segs = [{ label: t('places.personal'), loc: { type: 'dir', path: shared.home }, home: true }];
      let cur = shared.home;
      for (const part of p.slice(shared.home.length + 1).split('/').filter(Boolean)) {
        cur = T.joinPath(cur, part);
        const k = Object.keys(x).find((key) => ['desktop', 'documents', 'downloads', 'pictures', 'music', 'videos'].includes(key) && x[key] === cur);
        segs.push({ label: k ? t(`places.${k}`) : part, loc: { type: 'dir', path: cur } });
      }
      return segs;
    }
    if (!base) {
      const mp = shared.drives.filter((d) => d.mountpoint && d.mountpoint !== '/' && (p === d.mountpoint || T.isInside(p, d.mountpoint))).sort((a, b) => b.mountpoint.length - a.mountpoint.length)[0];
      if (mp) base = { path: mp.mountpoint, label: T.driveName(mp, t) };
    }
    if (!base) base = { path: '/', label: T.driveName({ mountpoint: '/' }, t) };
    const segs = [pc, { label: base.label, loc: { type: 'dir', path: base.path } }];
    if (p !== base.path) {
      const rest = p.slice(base.path === '/' ? 1 : base.path.length + 1).split('/').filter(Boolean);
      let cur = base.path;
      for (const part of rest) {
        cur = T.joinPath(cur, part);
        segs.push({ label: part, loc: { type: 'dir', path: cur } });
      }
    }
    return segs;
  }

  set(loc) {
    const { h, icon } = this.ex;
    this.loc = loc;
    this.segments = this.segmentsFor(loc);
    this.locIcon.src = this.ex.locIcon(loc);
    this.crumbs.replaceChildren();
    this.overflowBtn = h('button', {
      class: 'fx-crumb-more',
      hidden: true,
      tabindex: '-1',
      'aria-label': this.ex.t('address.more'),
      onclick: (e) => this.overflowMenu(e),
    }, icon('chevron_double_left', { size: 12 }));
    this.crumbs.appendChild(this.overflowBtn);
    this.crumbs.appendChild(this.chevron(null));
    this.segments.forEach((s, i) => {
      const seg = h('button', {
        class: ['fx-crumb', i === this.segments.length - 1 && 'last'],
        tabindex: '-1',
        dataset: { i: String(i) },
        onclick: (e) => {
          e.stopPropagation();
          this.ex.navigate(s.loc);
        },
      }, s.home ? icon('home', { size: 14, class: 'fx-crumb-home' }) : null, s.label);
      if (s.loc.type === 'dir') this.ex.dnd.dropTarget(seg, () => s.loc.path);
      this.crumbs.appendChild(seg);
      if (s.loc.type !== 'search') this.crumbs.appendChild(this.chevron(s, i));
    });
    this.fit();
  }

  chevron(seg, i) {
    const { h, icon } = this.ex;
    const btn = h('button', {
      class: 'fx-crumb-chev',
      tabindex: '-1',
      'aria-label': this.ex.t('address.subfolders'),
      dataset: { i: seg ? String(i) : 'root' },
      onclick: (e) => {
        e.stopPropagation();
        this.dropdown(btn, seg);
      },
    }, icon('chevron_right', { size: 12 }));
    return btn;
  }

  // Collapse leading segments into "«" when the bar is too narrow.
  fit() {
    if (!this.crumbs.isConnected || !this.overflowBtn) return;
    const kids = [...this.crumbs.children].filter((k) => k !== this.overflowBtn);
    kids.forEach((k) => (k.hidden = false));
    this.overflowBtn.hidden = true;
    this.hiddenSegs = [];
    const segEls = kids.filter((k) => k.classList.contains('fx-crumb'));
    let n = 0;
    while (this.crumbs.scrollWidth > this.crumbs.clientWidth + 1 && n < segEls.length - 1) {
      const seg = segEls[n];
      seg.hidden = true;
      // hide the chevron that precedes the segment (root chevron for the first one)
      const prev = seg.previousElementSibling;
      if (prev && prev !== this.overflowBtn) prev.hidden = true;
      this.hiddenSegs.push(this.segments[n]);
      this.overflowBtn.hidden = false;
      n++;
    }
  }

  async dropdown(btn, seg) {
    const { t } = this.ex;
    let items = [];
    const current = new Set(this.segments.map((s) => this.ex.locKey(s.loc)));
    const mk = (label, loc, iconName = 'folder') => ({
      label,
      icon: iconName,
      iconFilled: true,
      checked: undefined,
      action: () => this.ex.navigate(loc),
      _bold: current.has(this.ex.locKey(loc)),
    });
    if (!seg) {
      const x = shared.xdg;
      items = [
        mk(t('places.home'), { type: 'home' }, 'home'),
        mk(t('places.gallery'), { type: 'gallery' }, 'image_multiple'),
        '-',
        mk(t('places.desktop'), { type: 'dir', path: x.desktop }),
        mk(t('places.documents'), { type: 'dir', path: x.documents }),
        mk(t('places.downloads'), { type: 'dir', path: x.downloads }),
        mk(t('places.music'), { type: 'dir', path: x.music }),
        mk(t('places.pictures'), { type: 'dir', path: x.pictures }),
        mk(t('places.videos'), { type: 'dir', path: x.videos }),
        '-',
        mk(t('places.thisPc'), { type: 'thispc' }, 'desktop'),
        mk(t('places.trash'), { type: 'trash' }, 'delete'),
      ];
    } else if (seg.loc.type === 'thispc') {
      items = [
        mk(T.basename(shared.home), { type: 'dir', path: shared.home }),
        ...['desktop', 'documents', 'downloads', 'music', 'pictures', 'videos'].map((k) => mk(t(`places.${k}`), { type: 'dir', path: shared.xdg[k] })),
        '-',
        ...shared.drives.filter((d) => d.mountpoint).map((d) => mk(T.driveName(d, t), { type: 'dir', path: d.mountpoint }, 'hard_drive')),
      ];
    } else if (seg.loc.type === 'dir') {
      try {
        const list = await this.ex.api.invoke('fs:list', seg.loc.path, { hidden: shared.prefs.hidden });
        items = list.filter((e) => e.dir).map((e) => mk(e.name, { type: 'dir', path: e.path }));
      } catch (err) {
        items = [{ label: err.message, disabled: true }];
      }
      if (!items.length) items = [{ label: t('address.noSubfolders'), disabled: true }];
    } else return;
    btn.classList.add('open');
    const m = this.ex.menu(btn, items.map((it) => (it === '-' ? it : { ...it, bold: it._bold })), { class: 'app-files fx-scroll-menu' });
    await m;
    btn.classList.remove('open');
  }

  overflowMenu(e) {
    const items = this.hiddenSegs.map((s) => ({ label: s.label, icon: 'folder', iconFilled: true, action: () => this.ex.navigate(s.loc) })).reverse();
    this.ex.menu(this.overflowBtn, items, { class: 'app-files fx-scroll-menu' });
  }

  historyMenu() {
    const tab = this.ex.tab;
    if (!tab) return;
    const seen = new Set();
    const items = [];
    for (let i = tab.history.length - 1; i >= 0; i--) {
      const loc = tab.history[i].loc;
      const k = this.ex.locKey(loc);
      if (seen.has(k)) continue;
      seen.add(k);
      items.push({ label: this.ex.locName(loc), icon: i === tab.index ? 'checkmark' : 'history', action: () => this.ex.navigate(loc) });
    }
    this.ex.menu(this.historyBtn, items.slice(0, 15), { class: 'app-files fx-scroll-menu' });
  }

  displayText(loc) {
    if (loc.type === 'dir') return loc.path;
    if (loc.type === 'search') return this.displayText(loc.root);
    return this.ex.locName(loc);
  }

  beginEdit(text) {
    if (this.editing) {
      this.input.focus();
      this.input.select();
      return;
    }
    this.editing = true;
    this.el.classList.add('editing');
    this.el.tabIndex = -1; // while editing, the input is the Tab stop (Shift+Tab goes to Refresh)
    this.input.value = text ?? this.displayText(this.loc || { type: 'home' });
    this.input.focus();
    this.input.select();
  }

  endEdit() {
    const hadFocus = this.el.contains(document.activeElement);
    this.editing = false;
    this.el.tabIndex = 0;
    this.el.classList.remove('editing', 'error');
    this.hideSuggest();
    this.fit();
    if (hadFocus) this.ex.view.focus();
  }

  async commit(value) {
    const ex = this.ex;
    const t = ex.t;
    let v = String(value || '').trim();
    if (!v) return this.endEdit();
    if (/^https?:\/\//i.test(v)) {
      this.endEdit();
      ex.ctx.shell.openUrl(v);
      return;
    }
    const names = {
      [t('places.home').toLowerCase()]: { type: 'home' },
      home: { type: 'home' },
      [t('places.thisPc').toLowerCase()]: { type: 'thispc' },
      'this pc': { type: 'thispc' },
      [t('places.trash').toLowerCase()]: { type: 'trash' },
      'recycle bin': { type: 'trash' },
      'trash:': { type: 'trash' },
      'trash:///': { type: 'trash' },
      [t('places.gallery').toLowerCase()]: { type: 'gallery' },
      gallery: { type: 'gallery' },
    };
    const special = names[v.toLowerCase()];
    if (special) {
      this.endEdit();
      ex.navigate(special);
      return;
    }
    if (v.startsWith('file://')) {
      try {
        v = decodeURIComponent(v.slice(7).replace(/^localhost(?=\/)/, ''));
      } catch {
        v = v.slice(7); // malformed %-escape: take it literally (then "can't find" if it doesn't exist)
      }
    }
    if (v === '~' || v.startsWith('~/')) v = shared.home + v.slice(1);
    if (!v.startsWith('/')) {
      const base = this.loc?.type === 'dir' ? this.loc.path : shared.home;
      v = T.joinPath(base, v);
    }
    v = normalize(v);
    const st = await ex.api.invoke('fs:stat', v).catch(() => null);
    if (!st) {
      this.el.classList.add('error');
      await ex.ui.alert(t('errors.notFound', { path: value }), { title: t('appName'), parent: ex.win });
      this.el.classList.remove('error');
      this.input.focus();
      this.input.select();
      return;
    }
    this.endEdit();
    if (st.dir) ex.navigate({ type: 'dir', path: v });
    else ex.openEntries([st]);
  }

  onInputKey(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      const pick = this.sugIndex >= 0 ? this.sugItems[this.sugIndex] : null;
      this.commit(pick ? pick.path : this.input.value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (!this.sugBox.hidden) return this.hideSuggest();
      this.endEdit();
      this.ex.view.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (this.sugBox.hidden || !this.sugItems.length) return;
      e.preventDefault();
      const n = this.sugItems.length;
      if (e.key === 'ArrowDown') this.sugIndex = this.sugIndex + 1 >= n ? -1 : this.sugIndex + 1;
      else this.sugIndex = this.sugIndex - 1 < -1 ? n - 1 : this.sugIndex - 1;
      this.paintSuggest();
    } else if (e.key === 'Tab' && !e.shiftKey && !this.sugBox.hidden && this.sugItems.length) {
      e.preventDefault();
      const pick = this.sugItems[Math.max(0, this.sugIndex)];
      this.input.value = pick.dir ? `${pick.path}/` : pick.path;
      this.suggest();
    }
  }

  async suggest() {
    const v = this.input.value;
    const seq = (this.sugSeq = (this.sugSeq || 0) + 1);
    let full = v.startsWith('~') ? shared.home + v.slice(1) : v;
    if (!full.startsWith('/')) return this.hideSuggest();
    const slash = full.lastIndexOf('/');
    const dir = full.slice(0, slash) || '/';
    const prefix = full.slice(slash + 1).toLowerCase();
    let list = [];
    try {
      list = await this.ex.api.invoke('fs:list', dir, { hidden: prefix.startsWith('.') || shared.prefs.hidden });
    } catch {
      list = [];
    }
    if (seq !== this.sugSeq || !this.editing) return;
    this.sugItems = list.filter((e) => e.name.toLowerCase().startsWith(prefix)).sort((a, b) => (a.dir === b.dir ? 0 : a.dir ? -1 : 1)).slice(0, 12);
    if (!this.sugItems.length || (this.sugItems.length === 1 && this.sugItems[0].path === normalize(full))) return this.hideSuggest();
    this.sugIndex = -1;
    this.paintSuggest();
    this.sugBox.hidden = false;
  }

  paintSuggest() {
    const { h } = this.ex;
    this.sugBox.replaceChildren(
      ...this.sugItems.map((e, i) =>
        h('div', {
          class: ['fx-sug', i === this.sugIndex && 'active'],
          role: 'option',
          'aria-selected': String(i === this.sugIndex),
          onpointerdown: (ev) => {
            ev.preventDefault();
            this.commit(e.path);
          },
        }, h('img', { src: T.iconFor(e), alt: '' }), h('span', { class: 'ellipsis' }, e.path)),
      ),
    );
  }

  hideSuggest() {
    this.sugBox.hidden = true;
    this.sugItems = [];
    this.sugIndex = -1;
  }

  setBusy(on) {
    this.el.classList.toggle('busy', !!on);
  }
}

function normalize(p) {
  const out = [];
  for (const part of p.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return `/${out.join('/')}`;
}

export class SearchBox {
  constructor(ex) {
    this.ex = ex;
    const { h, icon, t } = ex;
    this.input = h('input', {
      class: 'fx-search-input',
      type: 'text',
      spellcheck: false,
      autocomplete: 'off',
      'aria-label': t('search.label'),
      oninput: () => this.onInput(),
      onkeydown: (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          clearTimeout(this.timer);
          this.run();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          this.clear(true);
          this.ex.view.focus();
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          this.ex.view.focus();
        }
      },
    });
    this.btn = h('button', {
      class: 'fx-search-btn',
      tabindex: '-1',
      'aria-label': t('search.label'),
      onclick: () => {
        if (this.input.value) this.clear(true);
        else this.input.focus();
      },
    }, icon('search', { size: 14 }));
    this.el = h('div', { class: 'fx-search', role: 'search' }, this.input, this.btn);
  }

  setPlaceholder(name) {
    this.input.placeholder = this.ex.t('search.placeholder', { name });
  }

  sync(loc) {
    // Leaving search results (navigation elsewhere) empties the box.
    if (loc.type === 'search') {
      if (this.input.value !== loc.query) this.input.value = loc.query;
    } else if (document.activeElement !== this.input) {
      this.input.value = '';
      clearTimeout(this.timer); // a pending debounced search belongs to the place we just left
    }
    this.el.classList.toggle('has-text', !!this.input.value);
    this.btn.replaceChildren(this.ex.icon(this.input.value ? 'dismiss' : 'search', { size: this.input.value ? 12 : 14 }));
    this.btn.setAttribute('aria-label', this.ex.t(this.input.value ? 'search.clear' : 'search.label'));
  }

  onInput() {
    this.el.classList.toggle('has-text', !!this.input.value);
    this.btn.replaceChildren(this.ex.icon(this.input.value ? 'dismiss' : 'search', { size: this.input.value ? 12 : 14 }));
    clearTimeout(this.timer);
    const tab = this.ex.tab;
    // Debounced: only if the user is still on the same tab (Ctrl+Tab while typing must not start the
    // search in the other tab).
    this.timer = setTimeout(() => this.ex.tab === tab && this.run(), 600);
  }

  run() {
    const q = this.input.value.trim();
    if (!this.ex.tab) return;
    const loc = this.ex.tab.loc;
    if (!q) {
      if (loc.type === 'search') this.ex.navigate(loc.root, { replace: true });
      return;
    }
    const root = loc.type === 'search' ? loc.root : loc;
    if (loc.type === 'search' && loc.query === q) return;
    this.ex.navigate({ type: 'search', root, query: q }, { replace: loc.type === 'search' });
  }

  clear(goBack) {
    clearTimeout(this.timer);
    this.input.value = '';
    this.onInput();
    clearTimeout(this.timer);
    const loc = this.ex.tab.loc;
    if (goBack && loc.type === 'search') this.ex.cancelSearch();
  }

  focus() {
    this.input.focus();
    this.input.select();
  }
}
