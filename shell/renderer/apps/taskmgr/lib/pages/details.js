// Details page: every process in one sortable table (name, PID, status, user, CPU, memory,
// threads, priority, command line…), End task / End process tree, priority, suspend/resume.
import { VTable } from '../table.js';
import { matcher, compare, processIcon, priorityOf, errText } from '../util.js';

const COLS = ['name', 'pid', 'status', 'user', 'cpu', 'mem', 'rss', 'disk', 'threads', 'priority', 'cpuTime', 'started', 'ppid', 'cmdline'];
const DEFAULT_VISIBLE = ['name', 'pid', 'status', 'user', 'cpu', 'mem', 'threads', 'priority', 'cmdline'];
const NUMERIC = new Set(['pid', 'cpu', 'mem', 'rss', 'disk', 'threads', 'cpuTime', 'started', 'ppid']);

export class DetailsPage {
  constructor(app) {
    this.app = app;
    this.id = 'details';
    this.icon = 'text_bullet_list_ltr';
    this.needs = { procs: true, shell: true };
    this.query = '';
    this.sort = app.prefs.sort.details || { id: 'name', dir: 1 };
    this.pendingSelect = null;
    this.table = new VTable({
      header: 'one-line',
      rowHeight: 28,
      label: app.t('nav.details'),
      widths: app.prefs.widths.details,
      className: 'details',
      flat: true,
      onSort: (id) => this.onSort(id),
      onSelect: () => app.renderCommands(),
      onActivate: (row) => this.properties(row),
      onContext: (row, e) => this.context(row, e),
      onHeaderContext: (e) => this.columnMenu(e),
      onDelete: (row) => this.endTask(row),
      onResize: (w) => {
        app.prefs.widths = { ...app.prefs.widths, details: w };
        app.savePrefs();
      },
    });
    this.table.setSort(this.sort.id, this.sort.dir);
    this.applyColumns();
  }

  title() {
    return this.app.t('nav.details');
  }
  mount(el) {
    el.appendChild(this.table.el);
  }
  focus() {
    this.table.focus();
  }
  relabel() {
    this.table.el.setAttribute('aria-label', this.title());
    this.applyColumns();
    this.render();
  }

  visibleCols() {
    const v = this.app.prefs.columns.details;
    return Array.isArray(v) && v.includes('name') ? COLS.filter((c) => v.includes(c)) : DEFAULT_VISIBLE;
  }
  colDefs() {
    const { t, fmt } = this.app;
    const st = (p) => this.statusText(p);
    return {
      name: { id: 'name', name: true, width: 200, min: 120, label: () => t('col.name'), cell: (r) => ({ text: r.data.label, icon: r.data.icon }) },
      pid: { id: 'pid', width: 72, min: 48, align: 'end', label: () => t('col.pid'), cell: (r) => String(r.data.pid) },
      status: { id: 'status', width: 100, min: 60, label: () => t('col.status'), fit: () => [t('status.running'), t('status.suspended'), t('status.zombie')], cell: (r) => st(r.data) },
      user: { id: 'user', width: 100, min: 60, label: () => t('col.user'), cell: (r) => r.data.user },
      cpu: { id: 'cpu', width: 64, min: 48, align: 'end', label: () => t('col.cpu'), cell: (r) => fmt.num(Math.round(r.data.cpu || 0)).padStart(2, '0') },
      mem: { id: 'mem', width: 132, min: 70, align: 'end', label: () => t('col.memPrivate'), cell: (r) => fmt.kb(r.data.priv) },
      rss: { id: 'rss', width: 112, min: 70, align: 'end', label: () => t('col.rss'), cell: (r) => fmt.kb(r.data.mem) },
      disk: { id: 'disk', width: 90, min: 60, align: 'end', label: () => t('col.disk'), cell: (r) => fmt.rate(r.data.disk) },
      threads: { id: 'threads', width: 72, min: 48, align: 'end', label: () => t('col.threads'), cell: (r) => fmt.int(r.data.threads) },
      priority: { id: 'priority', width: 116, min: 60, label: () => t('col.priority'), fit: () => ['realtime', 'high', 'aboveNormal', 'normal', 'belowNormal', 'low'].map((p) => t(`prio.${p}`)), cell: (r) => t(`prio.${priorityOf(r.data.nice)}`) },
      cpuTime: { id: 'cpuTime', width: 90, min: 60, align: 'end', label: () => t('col.cpuTime'), cell: (r) => fmt.duration(r.data.cpuTime) },
      started: { id: 'started', width: 150, min: 80, label: () => t('col.started'), cell: (r) => fmt.date(r.data.startTime) },
      ppid: { id: 'ppid', width: 80, min: 48, align: 'end', label: () => t('col.ppid'), cell: (r) => String(r.data.ppid) },
      cmdline: { id: 'cmdline', flex: true, width: 320, min: 100, label: () => t('col.cmdline'), cell: (r) => ({ text: r.data.cmdline || (r.data.kernel ? `[${r.data.comm}]` : ''), tip: r.data.cmdline || '' }) },
    };
  }
  applyColumns() {
    const defs = this.colDefs();
    const cols = this.visibleCols().map((id) => defs[id]);
    if (!cols.some((c) => c.flex)) cols[cols.length - 1] = { ...cols[cols.length - 1], flex: true };
    this.table.setColumns(cols);
  }
  columnMenu(e) {
    const { t } = this.app;
    const vis = new Set(this.visibleCols());
    const toggle = (id) => {
      if (vis.has(id)) vis.delete(id);
      else vis.add(id);
      this.app.prefs.columns = { ...this.app.prefs.columns, details: COLS.filter((c) => vis.has(c)) };
      this.app.savePrefs();
      this.applyColumns();
      this.render();
    };
    this.app.menu(e, [
      { header: t('menu.columns') },
      ...COLS.filter((c) => c !== 'name').map((id) => ({ label: t(id === 'mem' ? 'col.memPrivate' : `col.${id}`), checked: vis.has(id), action: () => toggle(id) })),
      '-',
      {
        label: t('menu.resetColumns'),
        action: () => {
          const p = this.app.prefs;
          p.columns = { ...p.columns, details: null };
          p.widths = { ...p.widths, details: {} };
          this.table.widths = {};
          this.app.savePrefs();
          this.applyColumns();
          this.render();
        },
      },
    ]);
  }

  statusText(p) {
    const { t } = this.app;
    if (p.state === 'T' || p.state === 't') return t('status.suspended');
    if (p.state === 'Z' || p.state === 'X') return t('status.zombie');
    return t('status.running');
  }

  update() {
    this.render();
  }
  onSearch(q) {
    this.query = q || '';
    this.render();
  }
  onPref(key) {
    if (key === 'kernelThreads') this.render();
  }
  reveal(pid) {
    this.pendingSelect = pid;
    if (this.query && !matcher(this.query)?.([pid])) this.app.setQuery('');
    this.render();
  }

  label(p, shell) {
    if (shell && p.pid === shell.mainPid) return this.app.t('shell.name');
    return p.name;
  }

  render() {
    const P = this.app.store.procs;
    if (!P) {
      this.table.setRows([], { emptyText: this.app.t('empty.loading') });
      return;
    }
    const shell = this.app.store.shellInfo;
    const m = matcher(this.query);
    const showK = !!this.app.prefs.kernelThreads || (this.pendingSelect != null && P.find((p) => p.pid === this.pendingSelect)?.kernel);
    const rows = [];
    for (const p of P) {
      if (p.kernel && !showK) continue;
      const label = this.label(p, shell);
      if (m && !m([label, p.name, p.pid, p.user, p.cmdline])) continue;
      rows.push({ key: `d:${p.pid}:${p.startTime}`, kind: 'item', depth: 0, data: { ...p, label, icon: shell && p.pid === shell.mainPid ? { src: 'app://shell/assets/aurora-logo.svg' } : processIcon(p, { system: p.uid !== this.app.ctx.env.uid }) } });
    }
    const { id, dir } = this.sort;
    const val = (d) => (id === 'name' ? d.label : id === 'mem' ? d.priv : id === 'rss' ? d.mem : id === 'status' ? this.statusText(d) : id === 'priority' ? d.nice : id === 'started' ? d.startTime : d[id]);
    rows.sort((a, b) => dir * compare(val(a.data), val(b.data)) || a.data.pid - b.data.pid);
    this.table.setRows(rows, { emptyText: m ? this.app.t('empty.search', { q: this.query.trim() }) : this.app.t('empty.loading') });
    if (this.pendingSelect != null) {
      const r = rows.find((x) => x.data.pid === this.pendingSelect);
      if (r) {
        this.table.select(r.key);
        this.pendingSelect = null;
        setTimeout(() => this.table.focus(), 0);
      }
    }
  }

  onSort(id) {
    const dir = this.sort.id === id ? -this.sort.dir : NUMERIC.has(id) && id !== 'pid' ? -1 : 1;
    this.sort = { id, dir };
    this.table.setSort(id, dir);
    this.app.prefs.sort = { ...this.app.prefs.sort, details: this.sort };
    this.app.savePrefs();
    this.render();
  }

  selected() {
    return this.table.selectedRow();
  }
  canEnd(r) {
    return !!r && !r.data.kernel && r.data.pid > 1;
  }
  canEff(r) {
    return !!r && !r.data.kernel && r.data.uid === this.app.ctx.env.uid && r.data.pid !== this.app.store.shellInfo?.mainPid;
  }
  endTask(r) {
    if (!this.canEnd(r)) return;
    const d = r.data;
    this.app.actions.endProcesses([d.pid], { name: d.label, critical: this.app.actions.isCritical(d.name, d.pid) });
  }
  endTree(r) {
    if (!this.canEnd(r)) return;
    const shell = this.app.store.shellInfo;
    // Ending the tree of the shell (or of one of its ancestors) ends the desktop: warn like Windows does.
    const hostsShell = !!shell && (r.data.pid === shell.mainPid || this.isAncestorOf(r.data.pid, shell.mainPid));
    this.app.actions.endTree(r.data.pid, r.data.label, { critical: hostsShell || this.app.actions.isCritical(r.data.name, r.data.pid) });
  }
  isAncestorOf(pid, child) {
    const byPid = new Map((this.app.store.procs || []).map((p) => [p.pid, p]));
    for (let p = byPid.get(child), i = 0; p && i < 64; p = byPid.get(p.ppid), i++) if (p.ppid === pid) return true;
    return false;
  }
  toggleEff(r) {
    if (!this.canEff(r)) return;
    this.app.actions.setEfficiency([r.data.pid], r.data.nice < 19, r.data.label);
  }
  properties(r) {
    if (r) this.app.actions.processProperties(r.data.pid, r.data.label, r.data.icon);
  }
  async goToService(r) {
    try {
      const info = await this.app.ctx.api.invoke('proc:info', r.data.pid);
      if (info.unit?.endsWith('.service')) this.app.go('services', { select: info.unit });
      else await this.app.ctx.ui.alert(this.app.t('err.noService', { name: r.data.label }), { title: this.app.t('err.title'), parent: this.app.win });
    } catch (err) {
      this.app.actions.alertErr(errText(this.app.t, err));
    }
  }

  moreItems(r) {
    const { t } = this.app;
    const A = this.app.actions;
    const d = r?.data;
    const suspended = d && (d.state === 'T' || d.state === 't');
    return [
      { label: t('cmd.endTree'), disabled: !this.canEnd(r), action: () => this.endTree(r) },
      { label: t('menu.setPriority'), disabled: !this.canEnd(r), submenu: d ? A.priorityMenu(d.pid, d.nice, d.label, d.uid) : [] },
      { label: suspended ? t('menu.resume') : t('menu.suspend'), disabled: !this.canEnd(r) || d.pid === this.app.store.shellInfo?.mainPid, action: () => A.suspend([d.pid], !suspended, d.label) },
      '-',
      { label: t('view.kernelThreads'), checked: !!this.app.prefs.kernelThreads, action: () => this.app.setPref('kernelThreads', !this.app.prefs.kernelThreads) },
      { label: t('view.speed'), submenu: this.app.speedMenu() },
      { label: t('menu.columns'), action: () => this.columnMenu(this.table.head) },
    ];
  }

  context(r, at) {
    const { t } = this.app;
    const A = this.app.actions;
    const d = r.data;
    const suspended = d.state === 'T' || d.state === 't';
    this.app.menu(at, [
      { label: t('cmd.endTask'), icon: 'prohibited', disabled: !this.canEnd(r), action: () => this.endTask(r) },
      { label: t('cmd.endTree'), disabled: !this.canEnd(r), action: () => this.endTree(r) },
      '-',
      { label: t('cmd.efficiency'), icon: 'arrow-down', checked: d.nice >= 19, disabled: !this.canEff(r), action: () => this.toggleEff(r) },
      { label: t('menu.setPriority'), disabled: !this.canEnd(r), submenu: A.priorityMenu(d.pid, d.nice, d.label, d.uid) },
      { label: suspended ? t('menu.resume') : t('menu.suspend'), disabled: !this.canEnd(r) || d.pid === this.app.store.shellInfo?.mainPid, action: () => A.suspend([d.pid], !suspended, d.label) },
      '-',
      { label: t('menu.openLocation'), disabled: d.kernel, action: () => A.openLocation(d.pid) },
      { label: t('menu.searchOnline'), action: () => A.searchOnline(d.name) },
      { label: t('menu.properties'), action: () => this.properties(r) },
      { label: t('menu.goToService'), disabled: d.kernel, action: () => this.goToService(r) },
      '-',
      { label: t('cmd.copy'), icon: 'copy', action: () => this.app.ctx.api.invoke('clipboard:writeText', [d.label, d.pid, this.statusText(d), d.user, d.cmdline].join('\t')).catch(() => {}) },
    ]);
  }

  commands() {
    const { t } = this.app;
    const r = this.selected();
    return [
      { id: 'run', icon: 'window_new', label: t('cmd.run'), action: () => this.app.actions.runNewTask() },
      { id: 'end', icon: 'prohibited', label: t('cmd.endTask'), disabled: !this.canEnd(r), action: () => this.endTask(this.selected()) },
      { id: 'eff', icon: 'arrow-down', label: t('cmd.efficiency'), disabled: !this.canEff(r), pressed: !!r && r.data.nice >= 19, action: () => this.toggleEff(this.selected()) },
      { id: 'props', icon: 'info', label: t('cmd.properties'), disabled: !r, action: () => this.properties(this.selected()) },
      { id: 'more', icon: 'more_horizontal', label: t('cmd.more'), menu: () => this.moreItems(this.selected()) },
    ];
  }

  destroy() {
    this.table.destroy();
  }
}
