// App history: CPU time used per program since the session started (or since the history was
// deleted). Running processes report their own lifetime CPU time; programs that exited while
// Task Manager was watching keep their last known total.
import { VTable } from '../table.js';
import { matcher, compare, processIcon } from '../util.js';

export class HistoryPage {
  constructor(app) {
    this.app = app;
    this.id = 'history';
    this.icon = 'history';
    this.needs = { procs: true, shell: true };
    this.query = '';
    this.live = new Map(); // proc key -> { name, cpuTime }
    this.archived = new Map(); // name -> cpu seconds of exited processes
    this.baseline = new Map(); // proc key -> cpu seconds at the last "Delete usage history"
    this.since = null;
    this.sort = app.prefs.sort.history || { id: 'cpuTime', dir: -1 };
    this.table = new VTable({
      header: 'one-line',
      rowHeight: 30,
      label: app.t('nav.history'),
      flat: true,
      widths: app.prefs.widths.history,
      onSort: (id) => this.onSort(id),
      onSelect: () => app.renderCommands(),
      onContext: (row, e) => this.context(row, e),
      onResize: (w) => {
        app.prefs.widths = { ...app.prefs.widths, history: w };
        app.savePrefs();
      },
    });
    this.table.setSort(this.sort.id, this.sort.dir);
    this.applyColumns();
    app.store.on('tick', () => this.track());
  }

  title() {
    return this.app.t('nav.history');
  }
  mount(el) {
    const { h } = this.app.ctx;
    this.sinceEl = h('div', { class: 'tm-pagenote caption text-2' });
    el.append(this.sinceEl, this.table.el);
  }
  focus() {
    this.table.focus();
  }
  relabel() {
    this.table.el.setAttribute('aria-label', this.title());
    this.applyColumns();
    this.render();
  }
  applyColumns() {
    const { t, fmt } = this.app;
    this.table.setColumns([
      { id: 'name', name: true, flex: true, max: 560, width: 280, min: 140, label: () => t('col.name'), cell: (r) => ({ text: r.data.name, icon: r.data.icon }) },
      { id: 'cpuTime', width: 110, min: 70, align: 'end', label: () => t('col.cpuTime'), cell: (r) => fmt.duration(r.data.cpuTime) },
      { id: 'instances', width: 110, min: 60, align: 'end', label: () => t('col.instances'), cell: (r) => (r.data.instances ? fmt.int(r.data.instances) : t('hist.notRunning')) },
      { id: 'mem', width: 110, min: 70, align: 'end', label: () => t('col.mem'), cell: (r) => (r.data.instances ? fmt.mb(r.data.mem) : '') },
    ]);
  }

  nameOf(p) {
    const sh = this.app.store.shellInfo;
    if (sh && (p.pid === sh.mainPid || sh.processes.some((x) => x.pid === p.pid))) return this.app.t('shell.name');
    return p.name;
  }
  include(p) {
    return !p.kernel && (this.app.prefs.historyAll || p.uid === this.app.ctx.env.uid);
  }
  track() {
    const P = this.app.store.procs;
    if (!P || this.app.store.procsAt === this._trackedAt) return;
    this._trackedAt = this.app.store.procsAt;
    if (this.since == null) {
      const sh = this.app.store.shellInfo;
      const main = sh && P.find((p) => p.pid === sh.mainPid);
      this.since = main?.startTime || Date.now();
    }
    const now = new Map();
    for (const p of P) {
      if (!this.include(p)) continue;
      now.set(`${p.pid}:${p.startTime}`, { name: this.nameOf(p), cpuTime: p.cpuTime, start: p.startTime });
    }
    for (const [k, v] of this.live) {
      if (!now.has(k)) this.archived.set(v.name, (this.archived.get(v.name) || 0) + Math.max(0, v.cpuTime - (this.baseline.get(k) || 0)));
      if (!now.has(k)) this.baseline.delete(k);
    }
    this.live = now;
  }

  update() {
    this.render();
  }
  onSearch(q) {
    this.query = q || '';
    this.render();
  }
  onPref(key) {
    if (key === 'historyAll') {
      this.live.clear();
      this._trackedAt = null;
      this.track();
      this.render();
    }
  }

  render() {
    const { t, fmt } = this.app;
    const P = this.app.store.procs;
    if (this.since) {
      const txt = t('hist.since', { date: fmt.date(this.since) });
      if (this.sinceEl.textContent !== txt) this.sinceEl.textContent = txt;
    }
    if (!P) {
      this.table.setRows([], { emptyText: t('empty.loading') });
      return;
    }
    const agg = new Map();
    const get = (name, sample) => {
      let a = agg.get(name);
      if (!a) {
        a = { name, cpuTime: 0, instances: 0, mem: 0, icon: name === t('shell.name') ? { src: 'app://shell/assets/aurora-logo.svg' } : processIcon(sample, { system: sample && sample.uid !== this.app.ctx.env.uid }) };
        agg.set(name, a);
      }
      return a;
    };
    for (const p of P) {
      if (!this.include(p)) continue;
      const k = `${p.pid}:${p.startTime}`;
      const a = get(this.nameOf(p), p);
      const base = this.baseline.get(k) ?? (p.startTime < (this.since || 0) && this.resetAt ? p.cpuTime : 0);
      a.cpuTime += Math.max(0, p.cpuTime - base);
      a.instances++;
      a.mem += p.priv;
    }
    for (const [name, sec] of this.archived) get(name, null).cpuTime += sec;
    const m = matcher(this.query);
    const rows = [];
    for (const a of agg.values()) {
      if (m && !m([a.name])) continue;
      if (a.cpuTime < 0.5 && !a.instances) continue;
      rows.push({ key: `h:${a.name}`, kind: 'item', depth: 0, data: a });
    }
    const { id, dir } = this.sort;
    rows.sort((x, y) => dir * compare(x.data[id], y.data[id]) || compare(x.data.name, y.data.name));
    this.table.setRows(rows, { emptyText: m ? t('empty.search', { q: this.query.trim() }) : t('empty.loading') });
  }

  onSort(id) {
    const dir = this.sort.id === id ? -this.sort.dir : id === 'name' ? 1 : -1;
    this.sort = { id, dir };
    this.table.setSort(id, dir);
    this.app.prefs.sort = { ...this.app.prefs.sort, history: this.sort };
    this.app.savePrefs();
    this.render();
  }

  async deleteHistory() {
    const { t } = this.app;
    const ok = await this.app.ctx.ui.confirm(t('hist.deleteBody'), { title: t('hist.deleteTitle'), okLabel: t('cmd.deleteHistory'), parent: this.app.win });
    if (!ok) return;
    this.archived.clear();
    this.baseline = new Map([...this.live].map(([k, v]) => [k, v.cpuTime]));
    this.since = Date.now();
    this.resetAt = this.since;
    this.render();
  }

  context(r, at) {
    const { t } = this.app;
    const name = r.data.name;
    const procs = (this.app.store.procs || []).filter((p) => this.include(p) && this.nameOf(p) === name);
    this.app.menu(at, [
      { label: t('menu.goToDetails'), disabled: !procs.length, action: () => this.app.go('details', { select: procs[0].pid }) },
      { label: t('menu.searchOnline'), action: () => this.app.actions.searchOnline(name) },
    ]);
  }

  commands() {
    const { t } = this.app;
    return [
      { id: 'run', icon: 'window_new', label: t('cmd.run'), action: () => this.app.actions.runNewTask() },
      { id: 'delete', icon: 'delete', label: t('cmd.deleteHistory'), action: () => this.deleteHistory() },
    ];
  }

  destroy() {
    this.table.destroy();
  }
}
