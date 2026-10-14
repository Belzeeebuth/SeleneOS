// « Journaux système » window: a toolbar of views (presets) and actions, a row of filters, the virtualised list
// of entries (newest first, older pages loaded while scrolling), and the details pane. Backend: main/ipc/journal.js.
//   views     errors (this boot, Erreur or worse) · previous boot · kernel · my apps (user journal) · everything
//   filters   boot, level, journal (whole / kernel / my apps), period, service or app (suggestions), search
//   actions   Suivre (live view), Actualiser, Exporter (text / JSON file), Copier, Détails
// The filters and the details pane setting are remembered (ctx.storage 'state' / 'prefs').
import { LogList } from './list.js';
import { DetailPane } from './detail.js';
import { SourceBox } from './source.js';
import {
  PRESETS,
  PRESET_ORDER,
  PERIODS,
  SCOPES,
  PRIO_ICONS,
  prioTone,
  sanitizeState,
  presetOf,
  toQuery,
  canFollow,
  entryLine,
  firstLine,
  validUnit,
  validIdent,
} from './format.js';

const PAGE = 1000; // entries per request
const MAX_ROWS = 20000; // the live view drops the oldest beyond this
const COPY_MAX = 5000;

function debounce(fn, ms) {
  let tm = null;
  const d = (...a) => {
    clearTimeout(tm);
    tm = setTimeout(() => fn(...a), ms);
  };
  d.cancel = () => clearTimeout(tm);
  return d;
}

export class LogsApp {
  constructor(ctx) {
    this.ctx = ctx;
    this.t = ctx.t;
    this.state = sanitizeState(null);
    this.prefs = { detail: true };
    this.boots = [];
    this.more = false;
    this.limited = false;
    this.grepFallback = false;
    this.error = null;
    this.loading = false;
    this.loadingMore = false;
    this.following = false;
    this.followId = null;
    this.followSeq = 0;
    this.loadSeq = 0;
    this.context = null;
    this.newAbove = 0;
    this.closed = false;
    this.offs = [];
  }

  // ------------------------------------------------------------------ setup
  async init() {
    const { ctx } = this;
    try {
      this.state = sanitizeState(await ctx.storage.get('state', null));
      const p = await ctx.storage.get('prefs', null);
      if (p && typeof p.detail === 'boolean') this.prefs.detail = p.detail;
    } catch {}
    this.applyArgs(ctx.args || {});
    this.saveState = debounce(() => ctx.storage.set('state', this.state).catch(() => {}), 300);
    this.build();
    this.offs.push(ctx.api.on('journal:entries', (ev) => this.onEntries(ev)));
    this.offs.push(ctx.api.on('journal:followEnd', (ev) => this.onFollowEnd(ev)));
    ctx.onLangChange(() => this.relabel());
    ctx.win.on('close', () => this.destroy());
    this.loadBoots();
    await this.load();
    this.list.focus();
  }

  /** Launch / relaunch arguments: { unit } or { identifier } (the System Monitor's « Voir le journal »: this boot,
   *  every level), { preset }, { boot }, { priority }, { search }. -> true when they changed the filters. */
  applyArgs(args) {
    if (!args || typeof args !== 'object') return false;
    let s = null;
    if (typeof args.preset === 'string' && PRESETS[args.preset]) s = { ...PRESETS[args.preset] };
    const src = validUnit(args.unit) ? { kind: 'unit', value: args.unit } : validIdent(args.identifier) ? { kind: 'ident', value: args.identifier } : null;
    if (src) s = { ...(s || { ...PRESETS.errors, priority: 7 }), source: src };
    for (const k of ['boot', 'priority', 'search']) if (args[k] != null) s = { ...(s || this.state), [k]: args[k] };
    if (!s) return false;
    this.state = sanitizeState(s);
    return true;
  }

  build() {
    const { h, icon, t, win } = this.ctx;
    // ---- views + actions
    this.presetBtns = new Map();
    const presets = h('div', { class: 'lg-presets', role: 'group', 'aria-label': t('preset.label') });
    for (const id of PRESET_ORDER) {
      const b = h('button', { class: 'lg-preset', type: 'button', dataset: { preset: id, tip: t(`presetTip.${id}`) }, 'aria-pressed': 'false', onclick: () => this.applyPreset(id) }, t(`preset.${id}`));
      this.presetBtns.set(id, b);
      presets.append(b);
    }
    this.followBtn = h('button', { class: 'btn subtle lg-follow', type: 'button', 'aria-pressed': 'false', onclick: () => this.toggleFollow() }, h('span', { class: 'lg-live-dot', 'aria-hidden': 'true' }), h('span', { class: 'lg-btn-label' }, t('action.follow')));
    this.refreshBtn = h('button', { class: 'btn subtle icon-btn', type: 'button', dataset: { act: 'refresh', tip: t('action.refresh') }, 'aria-label': t('action.refresh'), onclick: () => this.load({ keep: true }) }, icon('arrow-clockwise'));
    this.exportBtn = h('button', { class: 'btn subtle lg-export', type: 'button', 'aria-haspopup': 'menu', onclick: () => this.exportMenu() }, icon('export'), h('span', { class: 'lg-btn-label' }, t('action.export')), icon('caret-down', { size: 12 }));
    this.copyBtn = h('button', { class: 'btn subtle icon-btn', type: 'button', dataset: { act: 'copy', tip: t('action.copy') }, 'aria-label': t('action.copy'), onclick: () => this.copyEntry(this.detail.current() || this.list.selected()) }, icon('copy'));
    this.detailBtn = h('button', { class: 'btn subtle icon-btn', type: 'button', dataset: { act: 'details', tip: t('action.details') }, 'aria-label': t('action.details'), 'aria-pressed': String(this.prefs.detail), onclick: () => this.toggleDetail() }, icon('sidebar-simple'));
    this.bar = h(
      'div',
      { class: 'lg-bar', role: 'toolbar', 'aria-label': t('toolbar') },
      presets,
      h('div', { class: 'lg-bar-spacer' }),
      h('div', { class: 'lg-actions' }, this.followBtn, this.refreshBtn, this.exportBtn, this.copyBtn, this.detailBtn),
    );
    // Arrow keys move between the view buttons (one group, buttons stay tab stops).
    presets.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const btns = [...this.presetBtns.values()];
      const i = btns.indexOf(document.activeElement);
      if (i < 0) return;
      e.preventDefault();
      btns[(i + (e.key === 'ArrowRight' ? 1 : btns.length - 1)) % btns.length].focus();
    });

    // ---- filters
    this.bootSel = h('select', { class: 'select lg-boot', 'aria-label': t('filter.boot'), dataset: { tip: t('filter.boot') }, onchange: () => this.setState({ boot: this.bootSel.value }) });
    this.levelSel = h('select', { class: 'select lg-level', 'aria-label': t('filter.level'), dataset: { tip: t('filter.level') }, onchange: () => this.setState({ priority: Number(this.levelSel.value) }) });
    this.scopeSel = h('select', { class: 'select lg-scope', 'aria-label': t('filter.scope'), dataset: { tip: t('filter.scope') }, onchange: () => this.setState({ scope: this.scopeSel.value }) });
    this.periodSel = h('select', { class: 'select lg-period', 'aria-label': t('filter.period'), dataset: { tip: t('filter.period') }, onchange: () => this.onPeriod() });
    this.source = new SourceBox(this, { onChange: (src) => this.setState({ source: src }), getSources: () => this.sources() });
    this.search = h('input', { class: 'input lg-search-input', type: 'search', spellcheck: false, 'aria-label': t('filter.search'), placeholder: t('filter.searchPh'), maxlength: '200' });
    this.searchClear = h('button', { class: 'lg-field-clear', type: 'button', tabindex: '-1', 'aria-label': t('filter.clearSearch'), dataset: { tip: t('filter.clearSearch') }, onclick: () => this.setSearch('', true) }, icon('x', { size: 12 }));
    this.searchBox = h('div', { class: 'lg-search' }, icon('magnifying-glass', { size: 14, class: 'lg-field-ic' }), this.search, this.searchClear);
    const onSearch = debounce(() => this.setState({ search: this.search.value }), 400);
    this.search.addEventListener('input', () => {
      this.searchBox.classList.toggle('has-text', !!this.search.value);
      onSearch();
    });
    this.search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        onSearch.cancel();
        this.setState({ search: this.search.value });
      } else if (e.key === 'Escape' && this.search.value) {
        e.preventDefault();
        e.stopPropagation();
        onSearch.cancel();
        this.setSearch('', true);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.list.focus();
      }
    });
    this.filters = h('div', { class: 'lg-filters', role: 'group', 'aria-label': t('filter.label') }, this.bootSel, this.levelSel, this.scopeSel, this.periodSel, this.source.el, this.searchBox);

    // ---- information bars
    this.limitedBar = h('div', { class: 'infobar warning lg-info lg-limited', role: 'status', hidden: true }, icon('lock-simple', { filled: true }), h('div', { class: 'caption lg-info-text' }, t('limited')));
    this.contextBar = h('div', { class: 'infobar lg-info lg-context', hidden: true }, icon('rows'), h('div', { class: 'caption lg-info-text lg-context-text' }), h('button', { class: 'btn small lg-context-back', type: 'button', onclick: () => this.exitContext() }, icon('arrow-left', { size: 14 }), h('span', null, t('context.back'))));

    // ---- list + details
    this.list = new LogList({
      h,
      icon,
      label: t('list'),
      rowHeight: 28,
      columns: this.columns(),
      cell: (e, id) => this.cell(e, id),
      rowClass: (e) => `p-${prioTone(e.prio)}`,
      onSelect: (e) => this.onSelect(e),
      onActivate: (e) => this.onActivate(e),
      onContext: (e, at) => this.rowMenu(e, at),
      onCopy: (e) => this.copyEntry(e),
      onNearEnd: () => this.loadMore(),
    });
    this.emptyEl = h('div', { class: 'lg-empty empty', hidden: true, role: 'status' });
    this.newPill = h('button', { class: 'btn small lg-newpill', type: 'button', hidden: true, onclick: () => this.toTop() }, icon('arrow-up', { size: 14 }), h('span'));
    this.listWrap = h('div', { class: 'lg-listwrap' }, this.list.el, this.emptyEl, this.newPill);
    this.list.scroller.addEventListener('scroll', () => {
      if (this.newAbove && this.list.scroller.scrollTop < 4) {
        this.newAbove = 0;
        this.renderStatus();
      }
    });
    this.detail = new DetailPane(this);
    this.main = h('div', { class: ['lg-main', 'no-sel', !this.prefs.detail && 'no-detail'] }, this.listWrap, this.detail.el);

    // ---- status line
    this.countEl = h('span', { class: 'lg-count' });
    this.flashEl = h('span', { class: 'lg-flash', role: 'status', 'aria-live': 'polite' });
    this.moreBtn = h('button', { class: 'btn small subtle lg-more', type: 'button', hidden: true, onclick: () => this.loadMore(true) }, icon('arrow-down', { size: 14 }), h('span', null, t('status.more')));
    this.status = h('div', { class: 'lg-status caption' }, this.countEl, this.flashEl, h('div', { class: 'lg-bar-spacer' }), this.moreBtn);

    this.root = h('div', { class: 'lg-root' }, this.bar, this.filters, this.limitedBar, this.contextBar, this.main, this.status);
    win.body.appendChild(this.root);
    this.root.addEventListener('keydown', (e) => this.keys(e));
    this.syncControls();
  }

  columns() {
    const { t } = this.ctx;
    return [
      { id: 'time', width: 110, label: () => t('col.time'), fit: () => [this.fmtTime(new Date(2026, 11, 28, 23, 59, 59).getTime()), this.fmtTime(new Date(2026, 8, 30, 22, 58, 58).getTime())] },
      { id: 'level', width: 96, iconPad: 22, label: () => t('col.level'), fit: () => [0, 1, 2, 3, 4, 5, 6, 7].map((p) => t(`prio.${p}`)) },
      { id: 'source', width: 150, max: 190, label: () => t('col.source'), fit: () => ['systemd-journald'] },
      { id: 'message', flex: true, min: 180, label: () => t('col.message') },
    ];
  }

  fmtTime(ms) {
    const lang = this.ctx.i18n.locale;
    if (this._fmtLang !== lang) {
      this._fmtLang = lang;
      this._fmt = new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }
    return this._fmt.format(ms);
  }

  prioName(p) {
    return this.t(p == null ? 'prio.none' : `prio.${p}`);
  }

  cell(e, id) {
    if (id === 'time') return { text: this.fmtTime(e.ts) };
    if (id === 'level') return { text: this.prioName(e.prio), icon: e.prio == null ? 'circle' : PRIO_ICONS[e.prio], iconFilled: e.prio != null && e.prio <= 5, cls: `tone-${prioTone(e.prio)}` };
    if (id === 'source') return { text: e.source || '' };
    if (e.missing) return { text: this.t('detail.missingShort'), cls: 'missing' };
    const msg = e.msg || '';
    // The column never shows more than a few hundred characters: no need to lay out a 4 KiB line.
    return { text: firstLine(msg).slice(0, 400), cls: msg.includes('\n') ? 'more' : '' };
  }

  // ------------------------------------------------------------------ controls
  syncControls() {
    const { h, t } = this.ctx;
    const s = this.state;
    // views
    const pid = presetOf(s);
    for (const [id, b] of this.presetBtns) b.setAttribute('aria-pressed', String(id === pid));
    // boot
    const sel = this.bootSel;
    sel.textContent = '';
    const b0 = this.boots.find((b) => b.index === 0);
    const b1 = this.boots.find((b) => b.index === -1);
    sel.append(
      h('option', { value: 'current' }, b0?.first ? `${t('boot.current')} (${t('boot.since', { time: this.fmtWhen(b0.first) })})` : t('boot.current')),
      h('option', { value: 'previous' }, b1 ? `${t('boot.previous')} (${this.fmtRange(b1.first, b1.last)})` : t('boot.previous')),
      h('option', { value: 'all' }, t('boot.all')),
    );
    const older = this.boots.filter((b) => b.index <= -2);
    if (older.length) sel.append(h('optgroup', { label: t('boot.older') }, older.map((b) => h('option', { value: b.id }, this.fmtRange(b.first, b.last)))));
    if (!['current', 'previous', 'all'].includes(s.boot) && !older.some((b) => b.id === s.boot)) {
      const known = this.boots.find((b) => b.id === s.boot);
      sel.append(h('option', { value: s.boot }, known?.index === 0 ? t('boot.current') : known?.index === -1 ? t('boot.previous') : t('boot.other', { id: s.boot.slice(0, 8) })));
    }
    sel.value = s.boot;
    // level
    this.levelSel.textContent = '';
    for (let p = 7; p >= 0; p--) this.levelSel.append(h('option', { value: String(p) }, t(`level.${p}`)));
    this.levelSel.value = String(s.priority);
    // journal
    this.scopeSel.textContent = '';
    for (const id of SCOPES) this.scopeSel.append(h('option', { value: id }, t(`scope.${id}`)));
    this.scopeSel.value = s.scope;
    // period
    this.periodSel.textContent = '';
    for (const id of PERIODS) {
      let label = t(`period.${id}`);
      if (id === 'custom' && s.period === 'custom') label = this.periodLabel();
      this.periodSel.append(h('option', { value: id }, label));
    }
    // Choosing the selected option again fires no change: a separate entry edits the custom period.
    if (s.period === 'custom') this.periodSel.append(h('option', { value: 'edit' }, t('period.edit')));
    this.periodSel.value = s.period;
    // source, search (not while the person is typing in them)
    this.source.show(s.source);
    if (this.search.value !== s.search && document.activeElement !== this.search) this.search.value = s.search;
    this.searchBox.classList.toggle('has-text', !!this.search.value);
    // follow is for the running boot
    const can = canFollow(s, this.boots.find((b) => b.index === 0)?.id);
    this.followBtn.disabled = !can || !!this.context;
    this.followBtn.dataset.tip = can ? t('action.followTip') : t('action.followOff');
    this.followBtn.setAttribute('aria-pressed', String(this.following));
    this.followBtn.classList.toggle('on', this.following);
    this.detailBtn.setAttribute('aria-pressed', String(this.prefs.detail));
    this.copyBtn.disabled = !this.list?.selected();
  }

  fmtWhen(ms) {
    const d = new Date(ms);
    const today = new Date();
    if (d.toDateString() === today.toDateString()) return this.ctx.i18n.formatTime(ms);
    return this.ctx.i18n.formatDate(ms, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
  /** « Oct 13, 6:10 – 10:47 PM » / « 13 oct., 18:10 – 22:47 » (the day once when it does not change). */
  fmtRange(a, b) {
    if (!a) return '';
    const f = new Intl.DateTimeFormat(this.ctx.i18n.locale, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    if (!b || b <= a) return f.format(a);
    try {
      return f.formatRange(a, b);
    } catch {
      return `${f.format(a)} – ${f.format(b)}`;
    }
  }
  periodLabel() {
    const { t, i18n } = this.ctx;
    const f = (iso) => i18n.formatDate(Date.parse(iso), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const { since, until } = this.state;
    if (since && until) return t('period.range', { from: f(since), to: f(until) });
    if (since) return t('period.fromOnly', { from: f(since) });
    if (until) return t('period.toOnly', { to: f(until) });
    return t('period.custom');
  }

  setState(patch, { reload = true } = {}) {
    if (this.context) this.exitContext({ restore: false });
    this.state = sanitizeState({ ...this.state, ...patch });
    this.saveState();
    this.syncControls();
    if (reload) this.load();
  }
  applyPreset(id) {
    if (!PRESETS[id]) return;
    this.setState({ ...PRESETS[id] });
  }
  setSearch(text, reload) {
    this.search.value = text;
    this.searchBox.classList.toggle('has-text', !!text);
    if (reload) this.setState({ search: text });
  }
  clearFilters() {
    this.setState({ priority: 7, period: 'all', since: null, until: null, scope: 'all', source: null, search: '' });
  }

  async onPeriod() {
    const v = this.periodSel.value;
    if (v !== 'custom' && v !== 'edit') return this.setState({ period: v, since: null, until: null });
    const r = await this.askPeriod();
    if (!r) {
      this.periodSel.value = this.state.period; // cancelled
      return;
    }
    this.setState({ period: 'custom', since: r.since, until: r.until });
  }

  /** Dialog with two date-time fields. -> { since, until } (ISO) | null */
  async askPeriod() {
    const { h, t, ui, win } = this.ctx;
    const local = (ms) => {
      const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000);
      return d.toISOString().slice(0, 16);
    };
    const now = Date.now();
    const since0 = this.state.since ? Date.parse(this.state.since) : now - 3600e3;
    const until0 = this.state.until ? Date.parse(this.state.until) : null;
    const from = h('input', { class: 'input lg-from', type: 'datetime-local', value: local(since0), 'aria-label': t('period.from') });
    const to = h('input', { class: 'input lg-to', type: 'datetime-local', value: until0 ? local(until0) : '', 'aria-label': t('period.to') });
    const errEl = h('div', { class: 'field-hint lg-period-err', role: 'alert' });
    const body = h(
      'div',
      { class: 'lg-period-form' },
      h('label', { class: 'field' }, h('span', null, t('period.from')), from),
      h('label', { class: 'field' }, h('span', null, t('period.to')), to, h('span', { class: 'field-hint' }, t('period.toHint'))),
      errEl,
    );
    let out = null;
    const v = await ui.dialog({
      title: t('period.title'),
      body,
      parent: win,
      className: 'lg-period-dialog',
      buttons: [
        { label: t('period.apply'), value: 'ok', primary: true },
        { label: t('common.cancel'), value: null },
      ],
      onOpen: (dlg) => {
        dlg._validate = () => {
          const a = from.value ? new Date(from.value).getTime() : NaN;
          const b = to.value ? new Date(to.value).getTime() : null;
          if (!Number.isFinite(a) || (b != null && (!Number.isFinite(b) || b <= a))) {
            errEl.textContent = t('period.invalid');
            return false;
          }
          out = { since: new Date(a).toISOString(), until: b != null ? new Date(b).toISOString() : null };
          return true;
        };
      },
    });
    return v === 'ok' ? out : null;
  }

  toggleDetail() {
    this.prefs.detail = !this.prefs.detail;
    this.main.classList.toggle('no-detail', !this.prefs.detail);
    this.detailBtn.setAttribute('aria-pressed', String(this.prefs.detail));
    this.ctx.storage.set('prefs', this.prefs).catch(() => {});
    if (this.prefs.detail) this.detail.show(this.list.selected());
  }

  keys(e) {
    if (e.defaultPrevented) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault();
      this.search.focus();
      this.search.select();
    } else if (e.key === 'F5' || (mod && (e.key === 'r' || e.key === 'R'))) {
      e.preventDefault();
      this.load({ keep: true });
    } else if (e.key === 'Escape' && this.context && !e.target.closest?.('input, select, .menu, .dialog')) {
      e.preventDefault();
      e.stopPropagation();
      this.exitContext();
    }
  }

  // ------------------------------------------------------------------ data
  async loadBoots() {
    try {
      const r = await this.ctx.api.invoke('journal:boots');
      if (this.closed) return;
      this.boots = r.boots || [];
      if (r.limited) this.limited = true;
    } catch {
      this.boots = [];
    }
    this.syncControls();
    this.renderInfo();
  }

  async sources() {
    const user = this.state.scope === 'user';
    this._sources ||= new Map();
    if (!this._sources.has(user)) this._sources.set(user, this.ctx.api.invoke('journal:sources', { user }).catch(() => ({ units: [], identifiers: [] })));
    return this._sources.get(user);
  }

  /** Reads the first page for the current filters. keep: keep the selection if that entry is still there. */
  async load({ keep = false } = {}) {
    const n = ++this.loadSeq;
    const wasFollowing = this.following;
    this.stopFollow();
    const keepSel = keep ? this.list.sel : null;
    this.loading = true;
    this.loadingMore = false; // an older page still on its way belongs to the previous search
    this.newAbove = 0;
    this.renderStatus();
    const q = { ...toQuery(this.state), limit: PAGE };
    let r = null;
    try {
      r = await this.ctx.api.invoke('journal:query', { ...q, tag: 'list' });
    } catch (err) {
      if (n !== this.loadSeq || this.closed || err?.code === 'ECANCELED') return;
      this.error = err;
    }
    if (n !== this.loadSeq || this.closed) return;
    this.loading = false;
    this.query = q;
    if (r) {
      this.error = null;
      this.more = !!r.more;
      this.limited = !!r.limited;
      this.grepFallback = !!r.grepFallback;
      this.list.setEntries(r.entries || []);
      if (keepSel && this.list.select(keepSel, { scroll: true, silent: true })) this.onSelect(this.list.selected());
      else this.onSelect(null);
    } else {
      this.more = false;
      this.list.setEntries([]);
      this.onSelect(null);
    }
    this.renderEmpty();
    this.renderStatus();
    this.renderInfo();
    if (wasFollowing && canFollow(this.state, this.currentBootId())) this.startFollow();
    else if (wasFollowing) {
      this.following = false;
      this.syncControls();
    }
  }

  currentBootId() {
    return this.boots.find((b) => b.index === 0)?.id || null;
  }

  /** The next (older) page; from the list's scrolling or the « Charger » button. */
  async loadMore(fromButton = false) {
    if (!this.more || this.loadingMore || this.loading || this.context || !this.query) return;
    const last = this.list.entries[this.list.entries.length - 1];
    if (!last) return;
    const n = this.loadSeq;
    this.loadingMore = true;
    this.renderStatus();
    try {
      const r = await this.ctx.api.invoke('journal:query', { ...this.query, before: last.cursor, tag: 'more' });
      if (n !== this.loadSeq || this.closed || this.context) return;
      this.list.append(r.entries || []);
      this.more = !!r.more;
      if (fromButton) this.list.focus();
    } catch (err) {
      if (err?.code !== 'ECANCELED' && n === this.loadSeq) this.flash(this.errText(err));
    } finally {
      if (n === this.loadSeq) {
        this.loadingMore = false;
        this.renderStatus();
      }
    }
  }

  errText(err) {
    const k = `err.${err?.code}`;
    const v = this.t(k);
    return v !== k ? v : err?.message || String(err);
  }

  // ------------------------------------------------------------------ rendering
  renderStatus() {
    const { t, i18n } = this.ctx;
    const n = this.list.entries.length;
    const parts = [];
    if (this.loading) parts.push(t('status.loading'));
    else if (this.context) parts.push(t('count', { count: n, n: i18n.formatNumber(n) }));
    else if (!this.error) {
      parts.push(t('count', { count: n, n: i18n.formatNumber(n) }));
      if (this.more) parts.push(t('status.olderAvailable'));
      if (this.followId) parts.push(t('status.live'));
    }
    this.countEl.textContent = parts.join(' · ');
    this.countEl.title = this.grepFallback && this.state.search ? t('status.slowSearch') : '';
    const showMore = !this.loading && !this.context && this.more;
    this.moreBtn.hidden = !showMore;
    this.moreBtn.disabled = this.loadingMore;
    this.moreBtn.querySelector('span:last-child').textContent = this.loadingMore ? t('status.loadingMore') : t('status.more');
    this.root.classList.toggle('loading', this.loading);
    this.newPill.hidden = !this.newAbove;
    if (this.newAbove) this.newPill.querySelector('span:last-child').textContent = t('status.newer', { count: this.newAbove, n: i18n.formatNumber(this.newAbove) });
    this.copyBtn.disabled = !this.list.selected();
  }

  renderInfo() {
    this.limitedBar.hidden = !this.limited || this.state.scope === 'user';
  }

  renderEmpty() {
    const { h, icon, t } = this.ctx;
    const el = this.emptyEl;
    el.textContent = '';
    const empty = !this.loading && !this.list.entries.length;
    el.hidden = !empty;
    this.list.el.classList.toggle('is-empty', empty);
    if (!empty) return;
    const err = this.error;
    let ic = 'magnifying-glass';
    let title = t('empty.filters');
    let hint = null;
    let action = null;
    if (err?.code === 'ENOBOOT') {
      ic = 'clock-counter-clockwise';
      title = this.state.boot === 'previous' ? t('empty.noPrevious') : t('empty.noBoot');
      hint = this.state.boot === 'previous' ? t('empty.noPreviousHint') : null;
    } else if (err?.code === 'ENOENT') {
      ic = 'warning';
      title = t('empty.missing');
    } else if (err?.code === 'ETIMEDOUT') {
      ic = 'clock';
      title = t('empty.timeout');
    } else if (err) {
      ic = 'warning';
      title = t('empty.failed');
      hint = err.message;
    } else if (presetOf(this.state) === 'errors') {
      ic = 'check-circle';
      title = t('empty.errors');
      hint = t('empty.errorsHint');
    } else {
      action = h('button', { class: 'btn', type: 'button', onclick: () => this.clearFilters() }, t('filter.clearAll'));
    }
    el.append(...[icon(ic, { size: 40 }), h('div', { class: 'body-strong lg-empty-title' }, title), hint && h('div', { class: 'caption text-2 lg-empty-hint' }, hint), action].filter(Boolean));
  }

  flash(text) {
    clearTimeout(this._flashT);
    this.flashEl.textContent = text;
    this._flashT = setTimeout(() => (this.flashEl.textContent = ''), 4000);
  }

  relabel() {
    const { t } = this.ctx;
    this.ctx.win.setTitle(this.ctx.i18n.name(this.ctx.manifest.name));
    this.bar.setAttribute('aria-label', t('toolbar'));
    this.bar.querySelector('.lg-presets').setAttribute('aria-label', t('preset.label'));
    for (const [id, b] of this.presetBtns) {
      b.textContent = t(`preset.${id}`);
      b.dataset.tip = t(`presetTip.${id}`);
    }
    this.followBtn.querySelector('.lg-btn-label').textContent = t('action.follow');
    this.exportBtn.querySelector('.lg-btn-label').textContent = t('action.export');
    for (const [b, k] of [
      [this.refreshBtn, 'action.refresh'],
      [this.copyBtn, 'action.copy'],
      [this.detailBtn, 'action.details'],
    ]) {
      b.dataset.tip = t(k);
      b.setAttribute('aria-label', t(k));
    }
    for (const [el, k] of [
      [this.bootSel, 'filter.boot'],
      [this.levelSel, 'filter.level'],
      [this.scopeSel, 'filter.scope'],
      [this.periodSel, 'filter.period'],
      [this.search, 'filter.search'],
    ]) {
      el.setAttribute('aria-label', t(k));
      if (el.tagName === 'SELECT') el.dataset.tip = t(k);
    }
    this.search.placeholder = t('filter.searchPh');
    this.searchClear.setAttribute('aria-label', t('filter.clearSearch'));
    this.searchClear.dataset.tip = t('filter.clearSearch');
    this.filters.setAttribute('aria-label', t('filter.label'));
    this.source.relabel();
    this.limitedBar.querySelector('.lg-info-text').textContent = t('limited');
    this.contextBar.querySelector('.lg-context-back span').textContent = t('context.back');
    if (this.context) this.contextBar.querySelector('.lg-context-text').textContent = t('context.banner', { time: this.ctx.i18n.formatDate(this.context.anchor.ts, { dateStyle: 'medium', timeStyle: 'medium' }) });
    this.list.o.label = t('list');
    this.list.cols = this.columns();
    this.list.relabel();
    this.syncControls();
    this.renderStatus();
    this.renderEmpty();
    this.detail.render();
  }

  // ------------------------------------------------------------------ selection, details
  onSelect(e) {
    if (this.prefs.detail || !e) this.detail.show(e);
    this.copyBtn.disabled = !e;
    this.main.classList.toggle('no-sel', !e);
  }
  onActivate(e) {
    if (!this.prefs.detail) this.toggleDetail();
    this.detail.show(e);
    this.detail.el.querySelector('.lg-detail-msg')?.focus();
  }

  rowMenu(e, at) {
    const { t, ui } = this.ctx;
    ui.menu(at || this.list.el, [
      { label: t('menu.copy'), icon: 'copy', action: () => this.copyEntry(e) },
      { label: t('menu.copyMessage'), action: () => this.copyText(e.msg || '', t('status.copied')) },
      { label: t('menu.copyAll'), action: () => this.copyAll() },
      '-',
      { label: t('menu.context'), icon: 'rows', disabled: !!this.context, action: () => this.showContext(e) },
      { label: t('menu.only'), icon: 'funnel-simple', disabled: !this.sourceOf(e), action: () => this.filterSource(e) },
      { label: t('menu.details'), icon: 'sidebar-simple', action: () => this.onActivate(e) },
    ]);
  }

  /** The filter that keeps only this entry's source: its unit, else its program. */
  sourceOf(e) {
    if (!e) return null;
    if (e.transport === 'kernel') return { kind: 'ident', value: 'kernel' };
    const user = this.state.scope === 'user';
    if (e.unit && validUnit(e.unit) && !/^(user@\d+\.service|init\.scope|session-\d+\.scope)$/.test(e.unit) && (user || !e.unit.startsWith('app-'))) return { kind: 'unit', value: e.unit };
    if (e.source && validIdent(e.source)) return { kind: 'ident', value: e.source };
    return null;
  }
  filterSource(e) {
    const src = this.sourceOf(e);
    if (!src) return;
    this.setState({ source: src, search: '' });
  }

  // ------------------------------------------------------------------ copy, export
  async copyText(text, done) {
    try {
      await this.ctx.api.invoke('clipboard:writeText', text);
      this.flash(done);
    } catch (err) {
      this.flash(this.errText(err));
    }
  }
  copyEntry(e) {
    if (!e) return;
    this.copyText(entryLine(e), this.t('status.copied'));
  }
  copyAll() {
    const list = this.list.entries.slice(0, COPY_MAX);
    const n = list.length;
    // Oldest first, like a log file.
    this.copyText(list.slice().reverse().map(entryLine).join('\n'), this.t('status.copiedAll', { count: n, n: this.ctx.i18n.formatNumber(n) }));
  }

  exportMenu() {
    const { t, ui } = this.ctx;
    ui.menu(this.exportBtn, [
      { label: t('action.exportText'), icon: 'file-text', action: () => this.exportAs('text') },
      { label: t('action.exportJson'), icon: 'brackets-curly', action: () => this.exportAs('json') },
      '-',
      { label: t('action.copyAll'), icon: 'copy', disabled: !this.list.entries.length, action: () => this.copyAll() },
    ]);
  }

  async exportAs(format) {
    const { t, ui, api, win, i18n } = this.ctx;
    const ext = format === 'json' ? '.json' : '.txt';
    const d = new Date();
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
    let dir = null;
    try {
      dir = (await api.invoke('fs:xdg')).documents;
    } catch {}
    const file = await ui.filePicker({ mode: 'save', title: t('export.title'), name: `journal-${stamp}${ext}`, path: dir || undefined, filters: [{ name: t(`export.${format}`), ext: [ext] }], parent: win });
    if (!file || this.closed) return;
    const q = { ...(this.query || toQuery(this.state)) };
    delete q.limit;
    this.flash(t('export.busy'));
    try {
      const r = await api.invoke('journal:export', q, { path: file, format });
      const name = file.split('/').pop();
      let msg = t('export.done', { count: r.count, n: i18n.formatNumber(r.count), name });
      if (r.capped) msg += ` ${t('export.capped', { n: i18n.formatNumber(r.count) })}`;
      this.flash(msg);
      this.lastExport = r;
    } catch (err) {
      this.flash('');
      await ui.alert(t('export.failed', { msg: this.errText(err) }), { title: t('export.title'), parent: win });
    }
  }

  // ------------------------------------------------------------------ context
  async showContext(e) {
    if (!e) return;
    const { t, i18n, api } = this.ctx;
    let r;
    try {
      r = await api.invoke('journal:context', e.cursor, { before: 40, after: 40 });
    } catch (err) {
      this.flash(t('context.failed', { msg: this.errText(err) }));
      return;
    }
    if (this.closed) return;
    if (!this.context) {
      this.saved = { entries: this.list.entries, sel: this.list.sel, scroll: this.list.scroller.scrollTop, more: this.more, following: this.following };
      this.stopFollow();
    }
    this.context = { anchor: e };
    this.contextBar.querySelector('.lg-context-text').textContent = t('context.banner', { time: i18n.formatDate(e.ts, { dateStyle: 'medium', timeStyle: 'medium' }) });
    this.contextBar.hidden = false;
    this.list.setEntries(r.entries || []);
    this.list.setAnchor(e.cursor);
    this.list.select(e.cursor, { scroll: false, silent: true });
    this.list.scrollTo(this.list.index.get(e.cursor) || 0, true);
    this.onSelect(this.list.selected());
    this.detail.render(); // its « Show context » button is off meanwhile
    this.root.classList.add('in-context');
    this.syncControls();
    this.renderEmpty();
    this.renderStatus();
    this.list.focus();
  }

  exitContext({ restore = true } = {}) {
    if (!this.context) return;
    const saved = this.saved;
    this.context = null;
    this.saved = null;
    this.contextBar.hidden = true;
    this.root.classList.remove('in-context');
    this.list.setAnchor(null);
    if (restore && saved) {
      this.more = saved.more;
      this.list.setEntries(saved.entries, { keep: true });
      this.list.scroller.scrollTop = saved.scroll;
      if (saved.sel) this.list.select(saved.sel, { scroll: false, silent: true });
      this.onSelect(this.list.selected());
      this.detail.render();
      this.renderEmpty();
      this.renderStatus();
      if (saved.following) {
        this.following = true;
        this.startFollow();
      }
      this.syncControls();
      this.list.focus();
    } else if (saved?.following) this.following = true;
  }

  // ------------------------------------------------------------------ live view
  toggleFollow() {
    if (this.following) {
      this.following = false;
      this.stopFollow();
    } else {
      if (!canFollow(this.state, this.currentBootId())) return;
      this.following = true;
      this.startFollow();
    }
    this.syncControls();
    this.renderStatus();
  }

  async startFollow() {
    this.stopFollow();
    const n = ++this.followSeq;
    const q = toQuery(this.state);
    const newest = this.list.entries[0]?.cursor;
    if (newest) q.after = newest;
    try {
      const { id } = await this.ctx.api.invoke('journal:follow', q);
      if (n !== this.followSeq || !this.following || this.closed) {
        this.ctx.api.invoke('journal:unfollow', id).catch(() => {});
        return;
      }
      this.followId = id;
    } catch (err) {
      if (n !== this.followSeq) return;
      this.following = false;
      this.flash(this.t('follow.failed', { msg: this.errText(err) }));
    }
    this.syncControls();
    this.renderStatus();
  }

  stopFollow() {
    this.followSeq++;
    if (this.followId != null) this.ctx.api.invoke('journal:unfollow', this.followId).catch(() => {});
    this.followId = null;
  }

  onEntries(ev) {
    if (!ev || ev.id !== this.followId || this.context || this.closed) return;
    const newest = (ev.entries || []).slice().reverse();
    const atTop = this.list.scroller.scrollTop < 4;
    const added = this.list.prepend(newest);
    if (this.list.trim(MAX_ROWS)) this.more = true;
    if (added && !atTop) this.newAbove += added;
    if (added) {
      this.renderEmpty();
      this.renderStatus();
    }
  }

  onFollowEnd(ev) {
    if (!ev || ev.id !== this.followId) return;
    this.followId = null;
    if (this.following && ev.error) {
      this.following = false;
      this.flash(this.t('follow.ended', { msg: ev.error }));
    }
    this.syncControls();
    this.renderStatus();
  }

  toTop() {
    this.list.scroller.scrollTop = 0;
    this.newAbove = 0;
    this.renderStatus();
    this.list.focus();
  }

  // ------------------------------------------------------------------ lifecycle
  onRelaunch(args) {
    if (this.applyArgs(args || {})) {
      if (this.context) this.exitContext({ restore: false });
      this.saveState();
      this.syncControls();
      this.load();
    }
  }

  destroy() {
    if (this.closed) return;
    this.closed = true;
    this.following = false;
    this.stopFollow();
    for (const off of this.offs) off?.();
    this.list?.destroy();
    clearTimeout(this._flashT);
  }
}
