// Polices: the main window. Sidebar filters (Toutes, Serif, Sans serif, Chasse fixe, Manuscrites, Décoratives, Symboles —
// a category only when some family has it — and Installées par moi), a toolbar (search, sample text, size, preview
// background, grid / list) and the families, each drawn in its own font (lazy: only the cards on screen load a face,
// see pool.js). A card opens the family page (family.js). Drag and drop of font files installs them (install.js).
import { FontPool } from './pool.js';
import { FILTERS, SIZE_MIN, SIZE_MAX, SIZE_DEFAULT, sampleFor, glyphSample, fold, regularStyle, INSTALL_EXT } from './data.js';
import { installFiles, dropTarget } from './install.js';
import { FamilyView } from './family.js';
import { unregister } from './session.js';

/** Open main windows (a preview's « Afficher dans Polices » reuses one). */
export const managers = new Set();

export class Manager {
  constructor(ctx) {
    this.ctx = ctx;
    this.t = ctx.t;
    this.h = ctx.h;
    this.win = ctx.win;
    this.api = ctx.api;
    this.pool = new FontPool(ctx.api);
    this.families = [];
    this.filter = 'all';
    this.query = '';
    this.prefs = { sample: '', size: SIZE_DEFAULT, view: 'grid', theme: 'auto' };
    this.cards = new Map(); // family name -> card element
    this.shown = new Map(); // card -> { file, index }
    this.charmaps = new Map(); // `${file}#${index}` -> Promise<ranges>
    this.family = null; // FamilyView
    this.loaded = false;
    this.els = {};
  }

  // ------------------------------------------------------------------ setup
  async init() {
    const { win, storage, api } = this.ctx;
    win.body.classList.add('fv-root');
    const saved = (await storage.get('prefs', {}).catch(() => ({}))) || {};
    if (typeof saved.sample === 'string') this.prefs.sample = saved.sample.slice(0, 500);
    if (Number.isFinite(saved.size)) this.prefs.size = Math.min(SIZE_MAX, Math.max(SIZE_MIN, Math.round(saved.size)));
    if (saved.view === 'list' || saved.view === 'grid') this.prefs.view = saved.view;
    if (['auto', 'light', 'dark'].includes(saved.theme)) this.prefs.theme = saved.theme;
    this.render();
    managers.add(this);
    this.offChanged = api.on('fonts:changed', (p) => {
      if (!(p?.refreshed && this._refreshing)) this.reload();
    });
    this.ctx.onLangChange(() => this.relabel());
    win.on('close', () => this.dispose());
    await this.reload();
    if (typeof this.ctx.args?.family === 'string') this.openFamily(this.ctx.args.family);
  }

  dispose() {
    managers.delete(this);
    this.io?.disconnect();
    this.family?.dispose();
    this.pool.dispose();
    if (typeof this.offChanged === 'function') this.offChanged();
  }

  savePrefs() {
    clearTimeout(this._saveT);
    this._saveT = setTimeout(() => this.ctx.storage.set('prefs', this.prefs).catch(() => {}), 300);
  }

  /** The sample shown when the user typed nothing: the pangram of the interface language. */
  get sampleText() {
    return this.prefs.sample || this.t('sample');
  }
  get customSample() {
    return !!this.prefs.sample;
  }

  // ------------------------------------------------------------------ DOM
  render() {
    const { h, t } = this;
    const { ui, icon } = this.ctx;
    const nav = h('nav', { class: 'fv-filters', 'aria-label': t('filters') });
    this.els.nav = nav;
    const install = h(
      'button',
      { class: 'btn fv-install', 'data-tip': t('install.forMeHint'), onclick: () => this.pickAndInstall() },
      icon('plus'),
      h('span', null, t('install.button')),
    );
    this.els.install = install;
    const side = h('aside', { class: 'fv-side' }, nav, h('div', { class: 'fv-side-foot' }, install));

    const back = h('button', { class: 'btn subtle fv-back', hidden: true, 'aria-label': t('back'), 'data-tip': t('back'), onclick: () => this.closeFamily() }, icon('arrow-left'));
    const search = h('input', {
      class: 'input fv-search',
      type: 'search',
      placeholder: t('search'),
      'aria-label': t('search'),
      oninput: () => {
        this.query = search.value;
        if (this.family) this.closeFamily({ focus: false });
        this.renderGrid();
      },
      onkeydown: (e) => {
        if (e.key === 'Escape' && search.value) {
          e.stopPropagation();
          search.value = '';
          this.query = '';
          this.renderGrid();
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          this.focusCard(0);
        }
      },
    });
    const sample = h('input', {
      class: 'input fv-sample',
      type: 'text',
      maxlength: 500,
      value: this.prefs.sample,
      placeholder: this.t('sample'),
      'aria-label': t('sampleLabel'),
      'data-prose': '',
      oninput: () => {
        this.prefs.sample = sample.value;
        this.els.sampleReset.hidden = !sample.value;
        this.savePrefs();
        this.updateSamples();
      },
    });
    const sampleReset = h(
      'button',
      {
        class: 'btn subtle fv-sample-reset',
        hidden: !this.prefs.sample,
        'aria-label': t('sampleReset'),
        'data-tip': t('sampleReset'),
        onclick: () => {
          sample.value = '';
          this.prefs.sample = '';
          sampleReset.hidden = true;
          this.savePrefs();
          this.updateSamples();
          sample.focus();
        },
      },
      icon('x'),
    );
    const sizeVal = h('span', { class: 'fv-size-val', 'aria-hidden': 'true' }, t('sizeValue', { size: this.prefs.size }));
    const slider = ui.slider({
      min: SIZE_MIN,
      max: SIZE_MAX,
      step: 1,
      value: this.prefs.size,
      oninput: (v) => this.setSize(v),
    });
    slider.classList.add('fv-size-slider');
    slider.setAttribute('aria-label', t('size'));
    const theme = this.themeControl();
    const view = ui.segmented({
      options: [
        { value: 'grid', icon: 'squares-four', tip: t('viewGrid') },
        { value: 'list', icon: 'list', tip: t('viewList') },
      ],
      value: this.prefs.view,
      onchange: (v) => {
        this.prefs.view = v;
        this.savePrefs();
        this.applyView();
      },
    });
    view.classList.add('fv-view');
    this.labelSegmented(view, [t('viewGrid'), t('viewList')]);
    const toolbar = h(
      'div',
      { class: 'toolbar fv-toolbar' },
      back,
      h('div', { class: 'search-box fv-search-box' }, search, icon('magnifying-glass')),
      h('div', { class: 'fv-sample-box' }, sample, sampleReset),
      h('label', { class: 'fv-size', 'data-tip': t('size') }, icon('text_font_size'), slider, sizeVal),
      theme,
      view,
    );
    const count = h('div', { class: 'fv-count', role: 'status' });
    const refresh = h('button', { class: 'btn subtle fv-refresh', 'aria-label': t('refresh'), 'data-tip': t('refresh'), onclick: () => this.refresh() }, icon('arrows-clockwise'));
    const grid = h('div', { class: 'fv-grid', role: 'group', 'aria-label': t('title'), onkeydown: (e) => this.gridKeys(e) });
    const empty = h('div', { class: 'empty fv-empty', hidden: true });
    const scroll = h('div', { class: 'fv-scroll' }, h('div', { class: 'fv-count-bar' }, count, refresh), grid, empty);
    const familyHost = h('div', { class: 'fv-family-host', hidden: true });
    const content = h('div', { class: 'fv-content' }, scroll, familyHost);
    const main = h('main', { class: 'fv-main' }, toolbar, content);
    const drop = h('div', { class: 'fv-drop', hidden: true }, h('div', { class: 'fv-drop-card' }, icon('download-simple'), h('span', null, t('install.dropHint'))));
    const toast = h('div', { class: 'fv-toast', role: 'status', 'aria-live': 'polite', hidden: true });
    const root = h('div', { class: 'fv-app fv-manager' }, side, main, drop, toast);
    Object.assign(this.els, { root, side, back, search, sample, sampleReset, slider, sizeVal, theme, view, toolbar, count, grid, empty, scroll, familyHost, content, drop, toast });
    this.win.body.appendChild(root);
    this.applyTheme();
    this.applyView();
    this.applySize();
    dropTarget(this, root, drop);
    this.io = new IntersectionObserver((entries) => this.onIntersect(entries), { root: scroll, rootMargin: '300px 0px' });
    root.addEventListener('keydown', (e) => this.keys(e));
    this.renderNav();
    this.renderGrid();
  }

  themeControl() {
    const { t } = this;
    const el = this.ctx.ui.segmented({
      options: [
        { value: 'auto', icon: 'circle-half', tip: t('themeAuto') },
        { value: 'light', icon: 'sun', tip: t('themeLight') },
        { value: 'dark', icon: 'moon', tip: t('themeDark') },
      ],
      value: this.prefs.theme,
      onchange: (v) => {
        this.prefs.theme = v;
        this.savePrefs();
        this.applyTheme();
      },
    });
    el.classList.add('fv-theme');
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', t('previewTheme'));
    this.labelSegmented(el, [t('themeAuto'), t('themeLight'), t('themeDark')]);
    return el;
  }

  /** Icon-only segmented buttons get their names (and the selected state) for screen readers. */
  labelSegmented(el, labels) {
    const sync = () =>
      [...el.querySelectorAll('button')].forEach((b, i) => {
        b.setAttribute('aria-label', labels[i] || '');
        b.setAttribute('aria-pressed', b.classList.contains('selected') ? 'true' : 'false');
      });
    sync();
    new MutationObserver(sync).observe(el, { childList: true });
  }

  relabel() {
    // Everything is rebuilt in the new language (state is kept in prefs / this.filter / this.query).
    const famName = this.family?.fam?.name;
    const tab = this.family?.tab;
    this.io?.disconnect();
    for (const [card] of this.shown) this.hideCard(card);
    this.family?.dispose();
    this.family = null;
    this.els.root.remove();
    this.els = {};
    this.render();
    this.els.search.value = this.query;
    this.renderNav();
    this.renderGrid();
    if (famName) this.openFamily(famName, { tab });
  }

  applyTheme() {
    for (const el of [this.els.content]) {
      if (!el) continue;
      if (this.prefs.theme === 'auto') {
        el.removeAttribute('data-theme-scope');
        el.removeAttribute('data-theme');
      } else {
        el.setAttribute('data-theme-scope', '');
        el.setAttribute('data-theme', this.prefs.theme);
      }
    }
  }
  applyView() {
    this.els.grid.classList.toggle('list', this.prefs.view === 'list');
    this.els.root.dataset.view = this.prefs.view;
  }
  applySize() {
    this.els.root.style.setProperty('--fv-size', `${this.prefs.size}px`);
    this.els.sizeVal.textContent = this.t('sizeValue', { size: this.prefs.size });
    this.els.slider.setAttribute('aria-valuetext', this.t('sizeValue', { size: this.prefs.size }));
  }
  setSize(v) {
    this.prefs.size = Math.min(SIZE_MAX, Math.max(SIZE_MIN, Math.round(Number(v) || SIZE_DEFAULT)));
    this.els.slider.setValue?.(this.prefs.size);
    this.applySize();
    this.savePrefs();
    this.family?.update();
  }

  busy(on) {
    this.els.install.disabled = !!on;
    this.els.root.classList.toggle('busy', !!on);
  }

  toast(text, kind = 'info') {
    const el = this.els.toast;
    if (!el) return;
    el.textContent = text;
    el.dataset.kind = kind;
    el.hidden = false;
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => {
      el.hidden = true;
    }, 4200);
  }

  // ------------------------------------------------------------------ data
  /** F5 / the refresh button: fontconfig reads the font folders again (fonts copied by hand, another program). */
  async refresh() {
    this.charmaps.clear();
    this._refreshing = true;
    try {
      await this.reload({ force: true });
    } finally {
      this._refreshing = false;
    }
  }

  async reload({ force = false } = {}) {
    let res = null;
    try {
      res = await this.api.invoke('fonts:list', force ? { force: true } : undefined);
    } catch (err) {
      console.warn('[fonts] list failed', err);
    }
    if (this.win.closed) return;
    this.families = Array.isArray(res?.families) ? res.families : [];
    this.userDir = res?.userDir || '';
    this.loaded = true;
    this.renderNav();
    this.renderGrid();
    if (this.family) {
      const fam = this.families.find((f) => f.name === this.family.fam.name);
      if (fam) this.family.setFamily(fam);
      else this.closeFamily();
    }
  }

  countOf(filter) {
    if (filter === 'all') return this.families.length;
    if (filter === 'user') return this.families.filter((f) => f.user).length;
    return this.families.filter((f) => f.category === filter).length;
  }

  visibleFamilies() {
    const q = fold(this.query);
    return this.families.filter((f) => {
      if (this.filter === 'user' ? !f.user : this.filter !== 'all' && f.category !== this.filter) return false;
      return !q || fold(f.name).includes(q);
    });
  }

  renderNav() {
    const { h, t } = this;
    const { icon } = this.ctx;
    const nav = this.els.nav;
    nav.textContent = '';
    const icons = { all: 'text-aa', serif: 'text-t', sans: 'text-aa', mono: 'code', script: 'pen-nib', decorative: 'sparkle', symbol: 'star', user: 'user' };
    const item = (id) =>
      h(
        'button',
        {
          class: ['nav-item', 'fv-filter', this.filter === id && 'selected'],
          dataset: { filter: id },
          'aria-pressed': this.filter === id ? 'true' : 'false',
          onclick: () => this.setFilter(id),
        },
        icon(icons[id] || 'text-aa'),
        h('span', { class: 'fv-filter-label' }, t(`filter.${id}`)),
        h('span', { class: 'fv-filter-count' }, this.loaded ? String(this.countOf(id)) : ''),
      );
    for (const id of FILTERS) {
      if (id !== 'all' && id !== 'serif' && id !== 'sans' && id !== 'mono' && !this.countOf(id) && this.filter !== id) continue;
      nav.appendChild(item(id));
    }
    nav.appendChild(h('div', { class: 'fv-nav-sep', role: 'separator' }));
    nav.appendChild(item('user'));
  }

  setFilter(id) {
    this.filter = id;
    if (this.family) this.closeFamily({ focus: false });
    this.renderNav();
    this.renderGrid();
  }

  // ------------------------------------------------------------------ grid
  renderGrid() {
    const { h, t } = this;
    const grid = this.els.grid;
    this.io.disconnect();
    for (const card of [...this.shown.keys()]) this.hideCard(card);
    this.cards.clear();
    grid.textContent = '';
    if (!this.loaded) {
      this.els.count.textContent = t('loading');
      this.els.empty.hidden = true;
      return;
    }
    const list = this.visibleFamilies();
    this.els.count.textContent = t('families', { count: list.length });
    const empty = this.els.empty;
    empty.textContent = '';
    empty.hidden = list.length > 0;
    if (!list.length) {
      const [title, hint, ic] = this.query
        ? [t('empty.search', { query: this.query }), t('empty.searchHint'), 'magnifying-glass']
        : this.filter === 'user'
          ? [t('empty.user'), t('empty.userHint'), 'text-aa']
          : [t('empty.none'), t('empty.noneHint'), 'text-aa'];
      empty.append(this.ctx.icon(ic), h('div', { class: 'fv-empty-title' }, title), h('div', { class: 'fv-empty-hint' }, hint));
    }
    const frag = document.createDocumentFragment();
    list.forEach((fam, i) => {
      const card = this.card(fam, i === 0);
      this.cards.set(fam.name, card);
      frag.appendChild(card);
    });
    grid.appendChild(frag);
    for (const card of this.cards.values()) this.io.observe(card);
  }

  card(fam, first) {
    const { h, t } = this;
    const styles = t('styles', { count: fam.styles.length });
    const sample = h('div', { class: 'fv-card-sample', 'aria-hidden': 'true' });
    const card = h(
      'div',
      {
        class: 'fv-card',
        role: 'button',
        tabindex: first ? '0' : '-1',
        'aria-label': `${fam.name}, ${styles}${fam.user ? `, ${t('userBadge')}` : ''}`,
        dataset: { family: fam.name },
        onclick: () => this.openFamily(fam.name),
        onfocus: () => this.rove(card),
      },
      sample,
      h(
        'div',
        { class: 'fv-card-meta' },
        h('span', { class: 'fv-card-name' }, fam.name),
        h('span', { class: 'fv-card-sub' }, styles, fam.user ? h('span', { class: 'fv-badge user' }, t('userBadge')) : null),
      ),
    );
    card._fam = fam;
    card._sample = sample;
    this.fillSample(card);
    return card;
  }

  fillSample(card) {
    const fam = card._fam;
    const text = sampleFor(fam, this.sampleText, this.customSample);
    if (text != null) card._sample.textContent = text;
    else if (card._glyphs) card._sample.textContent = card._glyphs;
    else card._sample.textContent = '';
  }

  updateSamples() {
    for (const card of this.cards.values()) this.fillSample(card);
    this.family?.update();
  }

  onIntersect(entries) {
    for (const e of entries) {
      if (e.isIntersecting) this.showCard(e.target);
      else this.hideCard(e.target);
    }
  }

  async showCard(card) {
    if (this.shown.has(card)) return;
    const st = regularStyle(card._fam);
    if (!st) return;
    this.shown.set(card, st);
    const alias = await this.pool.acquire(st.file, st.index);
    if (this.shown.get(card) !== st) return;
    if (!alias) {
      card.classList.add('failed');
      card._sample.textContent = this.t('unavailable');
      return;
    }
    card._sample.style.fontFamily = `"${alias}"`;
    card._sample.style.fontVariationSettings = st.variation || 'normal';
    if (sampleFor(card._fam, this.sampleText, this.customSample) == null && !card._glyphs) {
      const ranges = await this.charmap(st.file, st.index).catch(() => []);
      card._glyphs = glyphSample(ranges) || '';
      this.fillSample(card);
    }
    card.classList.add('ready');
  }

  hideCard(card) {
    const st = this.shown.get(card);
    if (!st) return;
    this.shown.delete(card);
    card.classList.remove('ready');
    this.pool.release(st.file, st.index);
  }

  charmap(file, index = 0) {
    const k = `${file}#${index & 0xffff}`;
    if (!this.charmaps.has(k)) this.charmaps.set(k, this.api.invoke('fonts:charmap', file, index & 0xffff).catch(() => []));
    return this.charmaps.get(k);
  }

  // roving tabindex over the cards
  rove(card) {
    for (const c of this.els.grid.querySelectorAll('.fv-card[tabindex="0"]')) if (c !== card) c.tabIndex = -1;
    card.tabIndex = 0;
  }
  focusCard(i) {
    const cards = [...this.els.grid.querySelectorAll('.fv-card')];
    const c = cards[Math.max(0, Math.min(cards.length - 1, i))];
    if (c) {
      this.rove(c);
      c.focus();
      c.scrollIntoView({ block: 'nearest' });
    }
  }
  gridKeys(e) {
    const card = e.target.closest?.('.fv-card');
    if (!card) return;
    const cards = [...this.els.grid.querySelectorAll('.fv-card')];
    const i = cards.indexOf(card);
    const cols = Math.max(1, cards.filter((c) => c.offsetTop === cards[0].offsetTop).length);
    let next = null;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      this.openFamily(card._fam.name);
      return;
    }
    if (e.key === 'ArrowRight') next = i + 1;
    else if (e.key === 'ArrowLeft') next = i - 1;
    else if (e.key === 'ArrowDown') next = i + (this.prefs.view === 'list' ? 1 : cols);
    else if (e.key === 'ArrowUp') next = i - (this.prefs.view === 'list' ? 1 : cols);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = cards.length - 1;
    if (next == null) return;
    e.preventDefault();
    if (next < 0 && (e.key === 'ArrowUp' || e.key === 'ArrowLeft')) return this.els.search.focus();
    this.focusCard(next);
  }

  keys(e) {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      this.els.search.focus();
      this.els.search.select();
    } else if (e.key === 'F5' && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      this.refresh();
    } else if (e.key === 'Escape' && this.family && !e.defaultPrevented && !e.target.closest?.('input, select, textarea, .menu')) {
      e.preventDefault();
      this.closeFamily();
    }
  }

  // ------------------------------------------------------------------ family page
  openFamily(name, opts = {}) {
    const fam = this.families.find((f) => f.name === name) || this.families.find((f) => f.name.toLowerCase() === String(name).toLowerCase());
    if (!fam) return false;
    this.family?.dispose();
    this.family = new FamilyView(this, fam, opts);
    const host = this.els.familyHost;
    host.textContent = '';
    host.appendChild(this.family.render());
    host.hidden = false;
    this.els.scroll.hidden = true;
    this.els.back.hidden = false;
    this.els.view.hidden = true;
    this.els.root.classList.add('family-open');
    this.win.setTitle(`${fam.name} – ${this.t('title')}`);
    this.family.focus();
    return true;
  }

  closeFamily({ focus = true } = {}) {
    if (!this.family) return;
    const name = this.family.fam.name;
    this.family.dispose();
    this.family = null;
    this.els.familyHost.hidden = true;
    this.els.familyHost.textContent = '';
    this.els.scroll.hidden = false;
    this.els.back.hidden = true;
    this.els.view.hidden = false;
    this.els.root.classList.remove('family-open');
    this.win.setTitle(this.t('title'));
    if (focus) {
      const card = this.cards.get(name);
      if (card) {
        this.rove(card);
        card.focus({ preventScroll: false });
        card.scrollIntoView({ block: 'nearest' });
      } else this.els.search.focus();
    }
  }

  // ------------------------------------------------------------------ install / uninstall
  async pickAndInstall() {
    const { t } = this;
    const xdg = await this.api.invoke('fs:xdg').catch(() => ({}));
    const picked = await this.ctx.ui.filePicker({
      mode: 'open',
      title: t('install.pickTitle'),
      multiple: true,
      path: xdg.downloads || xdg.home,
      filters: [{ name: t('install.pickFilter'), ext: INSTALL_EXT }],
      parent: this.win,
    });
    if (!picked || this.win.closed) return;
    const paths = Array.isArray(picked) ? picked : [picked];
    const res = await installFiles(this, paths, { confirm: false });
    const first = res?.find((r) => r.status === 'installed' || r.status === 'replaced');
    if (first?.family) {
      await this.reload();
      this.openFamily(first.family);
    }
  }

  async uninstall(fam) {
    const { t, h } = this;
    const files = [...new Set(fam.styles.filter((s) => s.user).map((s) => s.file))];
    if (!files.length) return false;
    const body = h(
      'div',
      { class: 'fv-confirm' },
      h('p', null, t('uninstall.body', { count: files.length })),
      fam.system ? h('p', { class: 'fv-confirm-note' }, t('uninstall.partial')) : null,
    );
    const ok = await this.ctx.ui.confirm(body, { title: t('uninstall.title', { name: fam.name }), okLabel: t('uninstall.ok'), danger: true, parent: this.win });
    if (!ok || this.win.closed) return false;
    let res;
    try {
      res = await this.api.invoke('fonts:uninstall', files);
    } catch (err) {
      res = { removed: [], errors: [{ message: err?.message }] };
    }
    unregister(res.removed);
    if (res.errors?.length) this.toast(t('uninstall.failed', { name: fam.name, reason: res.errors[0].message || '' }), 'error');
    else this.toast(t('uninstall.done', { name: fam.name }), 'success');
    await this.reload();
    return res.removed?.length > 0;
  }
}
