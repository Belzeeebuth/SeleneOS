// Services page: systemd services (name, PID, description, status, startup type) with
// Start / Stop / Restart through the administrator prompt (aurora-admin "service" action).
import { VTable } from '../table.js';
import { matcher, compare } from '../util.js';

const REFRESH_MS = 5000;

export class ServicesPage {
  constructor(app) {
    this.app = app;
    this.id = 'services';
    this.icon = 'puzzle_piece';
    this.needs = { procs: false, shell: false };
    this.query = '';
    this.data = null;
    this.error = null;
    this.busy = new Set();
    this.sort = app.prefs.sort.services || { id: 'name', dir: 1 };
    this.pendingSelect = null;
    this.table = new VTable({
      header: 'one-line',
      rowHeight: 28,
      label: app.t('nav.services'),
      widths: app.prefs.widths.services,
      className: 'services',
      flat: true,
      onSort: (id) => this.onSort(id),
      onSelect: () => app.renderCommands(),
      onActivate: (row) => this.context(row, null),
      onContext: (row, e) => this.context(row, e),
      onResize: (w) => {
        app.prefs.widths = { ...app.prefs.widths, services: w };
        app.savePrefs();
      },
    });
    this.table.setSort(this.sort.id, this.sort.dir);
    this.applyColumns();
  }

  title() {
    return this.app.t('nav.services');
  }
  mount(el) {
    const { h, icon } = this.app.ctx;
    this.info = h('div', { class: 'infobar warning tm-info', hidden: true }, icon('warning', { filled: true }), h('div', { class: 'caption' }, this.app.t('svc.mock')));
    this.errorEl = h('div', { class: 'tm-empty-state', hidden: true });
    el.append(this.info, this.errorEl, this.table.el);
  }
  focus() {
    this.table.focus();
  }
  relabel() {
    this.table.el.setAttribute('aria-label', this.title());
    this.info.querySelector('.caption').textContent = this.app.t('svc.mock');
    this.applyColumns();
    this.render();
  }

  applyColumns() {
    const { t } = this.app;
    this.table.setColumns([
      { id: 'name', name: true, width: 220, min: 120, label: () => t('col.name'), cell: (r) => ({ text: r.data.name, icon: { name: 'puzzle_piece', tone: r.data.active === 'active' ? 'svc-on' : 'svc-off' } }) },
      { id: 'pid', width: 72, min: 48, align: 'end', label: () => t('col.pid'), cell: (r) => (r.data.pid ? String(r.data.pid) : '') },
      { id: 'description', flex: true, width: 300, min: 120, label: () => t('col.description'), cell: (r) => ({ text: r.data.description, tip: r.data.description }) },
      { id: 'status', width: 130, min: 70, label: () => t('col.status'), cell: (r) => ({ text: this.statusText(r.data), cls: `st-${this.statusKey(r.data)}` }) },
      { id: 'startup', width: 110, min: 60, label: () => t('col.startup'), cell: (r) => this.startupText(r.data) },
    ]);
  }

  statusKey(s) {
    if (this.busy.has(s.unit)) return 'busy';
    if (s.active === 'failed' || s.sub === 'failed') return 'failed';
    if (s.active === 'activating') return 'starting';
    if (s.active === 'deactivating') return 'stopping';
    if (s.active === 'active') return s.sub === 'exited' ? 'exited' : 'running';
    return 'stopped';
  }
  statusText(s) {
    return this.app.t(`svc.status.${this.statusKey(s)}`);
  }
  startupText(s) {
    const k = { enabled: 'auto', 'enabled-runtime': 'auto', static: 'static', disabled: 'manual', masked: 'disabled', indirect: 'manual', generated: 'auto', alias: 'auto' }[s.startup];
    return k ? this.app.t(`svc.startup.${k}`) : s.startup || '';
  }
  isRunning(s) {
    return s && (s.active === 'active' || s.active === 'activating' || s.active === 'reloading');
  }

  show() {
    this.load();
    clearInterval(this.timer);
    this.timer = setInterval(() => {
      if (this.app.store.running && this.app.prefs.speed !== 'paused') this.load();
    }, REFRESH_MS);
  }
  hide() {
    clearInterval(this.timer);
    this.timer = null;
  }
  refresh() {
    this.load();
  }
  async load() {
    if (this._loading) return;
    this._loading = true;
    try {
      this.data = await this.app.ctx.api.invoke('perf:services');
      this.error = null;
    } catch (err) {
      this.error = err;
    } finally {
      this._loading = false;
    }
    this.render();
    this.app.renderCommands();
  }
  onSearch(q) {
    this.query = q || '';
    this.render();
  }
  reveal(unit) {
    this.pendingSelect = unit;
    if (this.query) this.app.setQuery('');
    this.render();
  }

  render() {
    const { t } = this.app;
    this.info.hidden = !this.data?.mock;
    this.errorEl.hidden = !this.error;
    this.table.el.hidden = !!this.error;
    if (this.error) {
      const { h, icon } = this.app.ctx;
      this.errorEl.textContent = '';
      this.errorEl.append(icon('puzzle_piece', { size: 40 }), h('div', { class: 'body-strong' }, t('svc.unavailable')), h('div', { class: 'caption text-2' }, this.error.message));
      return;
    }
    if (!this.data) {
      this.table.setRows([], { emptyText: t('empty.loading') });
      return;
    }
    const m = matcher(this.query);
    const rows = [];
    for (const s of this.data.services) {
      if (m && !m([s.name, s.unit, s.description, s.pid])) continue;
      rows.push({ key: `s:${s.unit}`, kind: 'item', depth: 0, data: s });
    }
    const { id, dir } = this.sort;
    const val = (s) => (id === 'status' ? this.statusText(s) : id === 'startup' ? this.startupText(s) : id === 'pid' ? s.pid || 0 : s[id]);
    rows.sort((a, b) => dir * compare(val(a.data), val(b.data)) || compare(a.data.name, b.data.name));
    this.table.setRows(rows, { emptyText: m ? t('empty.search', { q: this.query.trim() }) : t('svc.none') });
    if (this.pendingSelect) {
      const r = rows.find((x) => x.data.unit === this.pendingSelect);
      if (r) {
        this.table.select(r.key);
        this.pendingSelect = null;
        setTimeout(() => this.table.focus(), 0);
      }
    }
  }

  onSort(id) {
    const dir = this.sort.id === id ? -this.sort.dir : 1;
    this.sort = { id, dir };
    this.table.setSort(id, dir);
    this.app.prefs.sort = { ...this.app.prefs.sort, services: this.sort };
    this.app.savePrefs();
    this.render();
  }

  async act(verb, s) {
    if (!s || this.data?.mock) return;
    const { t } = this.app;
    this.busy.add(s.unit);
    this.render();
    try {
      await this.app.ctx.shell.runAdmin('service', [verb, s.unit], { reason: t(`svc.reason.${verb}`, { name: s.name }), appId: 'taskmgr' });
    } catch (err) {
      if (err?.code !== 'ECANCELED') await this.app.actions.alertErr(t('svc.failed', { name: s.name, msg: err?.message || String(err) }));
    } finally {
      this.busy.delete(s.unit);
    }
    await this.load();
  }

  context(r, at) {
    const { t } = this.app;
    const s = r.data;
    const run = this.isRunning(s);
    const mock = !!this.data?.mock;
    const busy = this.busy.has(s.unit);
    const items = [
      { label: t('cmd.start'), icon: 'play', disabled: mock || busy || run, action: () => this.act('start', s) },
      { label: t('cmd.stop'), icon: 'stop', disabled: mock || busy || !run, action: () => this.act('stop', s) },
      { label: t('cmd.restart'), icon: 'arrow_clockwise', disabled: mock || busy || !run, action: () => this.act('restart', s) },
      '-',
      { label: t('menu.searchOnline'), action: () => this.app.actions.searchOnline(s.name) },
      { label: t('menu.goToDetails'), disabled: !s.pid, action: () => this.app.go('details', { select: s.pid }) },
      { label: t('cmd.copy'), icon: 'copy', action: () => this.app.ctx.api.invoke('clipboard:writeText', `${s.unit}\t${s.description}\t${this.statusText(s)}`).catch(() => {}) },
    ];
    if (!at) {
      const el = this.table.live.get(r.key);
      const rect = el?.getBoundingClientRect();
      at = rect ? { x: rect.left + 48, y: rect.top + rect.height / 2 } : null;
    }
    this.app.menu(at, items);
  }

  commands() {
    const { t } = this.app;
    const r = this.table.selectedRow();
    const s = r?.data;
    const mock = !!this.data?.mock;
    const busy = s && this.busy.has(s.unit);
    const run = this.isRunning(s);
    return [
      { id: 'run', icon: 'window_new', label: t('cmd.run'), action: () => this.app.actions.runNewTask() },
      { id: 'start', icon: 'play', label: t('cmd.start'), disabled: !s || mock || busy || run, action: () => this.act('start', this.table.selectedRow()?.data) },
      { id: 'stop', icon: 'stop', label: t('cmd.stop'), disabled: !s || mock || busy || !run, action: () => this.act('stop', this.table.selectedRow()?.data) },
      { id: 'restart', icon: 'arrow_clockwise', label: t('cmd.restart'), disabled: !s || mock || busy || !run, action: () => this.act('restart', this.table.selectedRow()?.data) },
    ];
  }

  destroy() {
    clearInterval(this.timer);
    this.table.destroy();
  }
}
