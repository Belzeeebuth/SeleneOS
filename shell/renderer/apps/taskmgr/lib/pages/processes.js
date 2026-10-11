// Processes page: "Apps", "Background processes" and "Aurora processes" groups with the
// Windows heat map, column totals, sorting, search, expandable process trees and End task.
//
// Where things come from:
//   Apps        the shell's windows (wm) grouped by app; apps with their own processes (browser
//               tabs = <webview> renderers) show those processes' CPU / memory.
//   Background  the user's processes, process trees of the same executable collapsed into one row.
//   Aurora      Aurora Shell (its Electron processes), the Linux kernel threads and processes of
//               other (system) accounts.
import { wm } from '../../../../core/wm.js';
import { registry } from '../../../../core/registry.js';
import { VTable } from '../table.js';
import { heat, matcher, compare, processIcon } from '../util.js';

const COLS = ['name', 'status', 'pid', 'procname', 'user', 'cpu', 'mem', 'disk', 'cmdline'];
const DEFAULT_VISIBLE = ['name', 'status', 'cpu', 'mem', 'disk'];
const DISK_SCALE = 50 * 1048576; // 50 MB/s = hottest disk cell

export class ProcessesPage {
  constructor(app) {
    this.app = app;
    this.id = 'processes';
    this.icon = 'grid';
    this.needs = { procs: true, shell: true };
    this.expanded = new Map();
    this.query = '';
    this.sort = app.prefs.sort.processes || { id: 'name', dir: 1 };
    this.entries = [];
    this.table = new VTable({
      header: 'two-line',
      rowHeight: 30,
      label: app.t('nav.processes'),
      widths: app.prefs.widths.processes,
      onSort: (id) => this.onSort(id),
      onSelect: () => app.renderCommands(),
      onToggle: (row) => this.toggle(row),
      onActivate: (row) => this.activate(row),
      onContext: (row, e) => this.context(row, e),
      onHeaderContext: (e) => this.columnMenu(e),
      onDelete: (row) => this.endTask(row),
      onResize: (w) => {
        app.prefs.widths = { ...app.prefs.widths, processes: w };
        app.savePrefs();
      },
    });
    this.table.setSort(this.sort.id, this.sort.dir);
    this.applyColumns();
  }

  title() {
    return this.app.t('nav.processes');
  }
  mount(el) {
    el.append(this.table.el);
  }
  focus() {
    this.table.focus();
  }
  relabel() {
    this.table.el.setAttribute('aria-label', this.title());
    this.applyColumns();
    this.render();
  }

  // ------------------------------------------------------------------ columns
  visibleCols() {
    const v = this.app.prefs.columns.processes;
    return Array.isArray(v) && v.includes('name') ? COLS.filter((c) => v.includes(c)) : DEFAULT_VISIBLE;
  }
  colDefs() {
    const { t, fmt, store } = { t: this.app.t, fmt: this.app.fmt, store: this.app.store };
    const perf = () => store.perf;
    const memTotal = () => perf()?.mem.total || 1;
    const blank = (r) => r.data.inShell || r.data.type === 'window';
    // Apps that run inside the shell's renderer have no process of their own to measure.
    const na = (r) => (r.data.inShell ? { text: '—', heat: null, cls: 'na', tip: t('tip.inShell') } : { text: '', heat: null });
    return {
      name: { id: 'name', name: true, flex: true, max: 560, width: 220, min: 140, label: () => t('col.name'), cell: (r) => ({ text: r.data.name, icon: r.data.icon }) },
      status: { id: 'status', width: 116, min: 60, label: () => t('col.status'), fit: () => [t('status.efficiency'), t('status.suspended')], fitIcon: true, cell: (r) => r.data.status || '' },
      pid: { id: 'pid', width: 80, min: 50, align: 'end', label: () => t('col.pid'), cell: (r) => (r.data.pid ? String(r.data.pid) : '') },
      procname: { id: 'procname', width: 140, min: 70, label: () => t('col.procname'), cell: (r) => r.data.procname || '' },
      user: { id: 'user', width: 110, min: 60, label: () => t('col.user'), cell: (r) => r.data.user || '' },
      cpu: {
        id: 'cpu',
        width: 88,
        min: 60,
        align: 'end',
        heat: true,
        label: () => t('col.cpu'),
        top: () => (perf() ? fmt.pct(perf().cpu.total) : ''),
        hot: () => (perf()?.cpu.total || 0) >= 85,
        cell: (r) => (blank(r) ? na(r) : { text: fmt.cpu(r.data.cpu), heat: heat((r.data.cpu || 0) / 100) }),
      },
      mem: {
        id: 'mem',
        width: 98,
        min: 70,
        align: 'end',
        heat: true,
        label: () => t('col.mem'),
        top: () => (perf() ? fmt.pct((perf().mem.used / memTotal()) * 100) : ''),
        hot: () => (perf() ? perf().mem.used / memTotal() >= 0.85 : false),
        cell: (r) => {
          if (blank(r)) return na(r);
          const share = (r.data.mem || 0) / memTotal();
          return { text: this.app.prefs.memPercent ? fmt.pct(share * 100, 1) : fmt.mb(r.data.mem), heat: heat(share * 4) };
        },
      },
      disk: {
        id: 'disk',
        width: 88,
        min: 60,
        align: 'end',
        heat: true,
        label: () => t('col.disk'),
        top: () => (perf() ? fmt.pct(Math.max(0, ...perf().disks.map((d) => d.busyPct))) : ''),
        hot: () => Math.max(0, ...(perf()?.disks.map((d) => d.busyPct) || [0])) >= 85,
        cell: (r) => (blank(r) ? na(r) : { text: fmt.mbps(r.data.disk), heat: heat((r.data.disk || 0) / DISK_SCALE) }),
      },
      cmdline: { id: 'cmdline', width: 360, min: 100, label: () => t('col.cmdline'), cell: (r) => ({ text: r.data.cmdline || '', tip: r.data.cmdline || '' }) },
    };
  }
  applyColumns() {
    const defs = this.colDefs();
    this.table.setColumns(this.visibleCols().map((id) => defs[id]));
  }
  columnMenu(e) {
    const { t } = this.app;
    const vis = new Set(this.visibleCols());
    const toggle = (id) => {
      if (vis.has(id)) vis.delete(id);
      else vis.add(id);
      this.app.prefs.columns = { ...this.app.prefs.columns, processes: COLS.filter((c) => vis.has(c)) };
      this.app.savePrefs();
      this.applyColumns();
      this.render();
    };
    this.app.menu(e, [
      { header: t('menu.columns') },
      ...COLS.filter((c) => c !== 'name').map((id) => ({ label: t(`col.${id}`), checked: vis.has(id), action: () => toggle(id) })),
      '-',
      { label: t('menu.resetColumns'), action: () => this.resetColumns() },
    ]);
  }
  resetColumns() {
    const p = this.app.prefs;
    p.columns = { ...p.columns, processes: null };
    p.widths = { ...p.widths, processes: {} };
    this.table.widths = {};
    this.app.savePrefs();
    this.applyColumns();
    this.render();
  }

  // ------------------------------------------------------------------ data
  update() {
    this.build();
    this.render();
    this.table.refreshHeader();
  }
  onWindows() {
    clearTimeout(this._wt);
    this._wt = setTimeout(() => {
      if (!this.app.store.procs) return;
      this.build();
      this.render();
    }, 30);
  }
  onSearch(q) {
    this.query = q || '';
    this.render();
  }
  onPref(key) {
    if (key === 'groupByType' || key === 'memPercent') this.render();
  }

  statusOf(procs) {
    const { t } = this.app;
    if (!procs.length) return '';
    if (procs.every((p) => p.state === 'T' || p.state === 't')) return { text: t('status.suspended'), icon: { name: 'pause', tone: 'muted', filled: true } };
    if (procs.every((p) => p.nice >= 19)) return { text: t('status.efficiency'), icon: { name: 'arrow-down', tone: 'eff', filled: true } };
    return '';
  }

  build() {
    const { store, t } = this.app;
    const env = this.app.ctx.env;
    const P = store.procs || [];
    const perf = store.perf;
    const S = store.shellInfo || { mainPid: 0, processes: [], webContents: [] };
    const myUid = env.uid ?? -1;
    const shellTypes = new Map(S.processes.map((p) => [p.pid, p]));
    const wcPid = new Map(S.webContents.map((w) => [w.id, w.pid]));
    const hostPid = S.webContents.find((w) => w.type === 'window')?.pid || 0;
    this.hostPid = hostPid;
    this.mainPid = S.mainPid;
    const byPid = new Map(P.map((p) => [p.pid, p]));
    this.byPid = byPid;

    // ---- apps (shell windows)
    const apps = new Map();
    for (const w of wm.list()) {
      if (w._closing) continue;
      let a = apps.get(w.appId);
      if (!a) apps.set(w.appId, (a = { appId: w.appId, wins: [], pids: new Set() }));
      a.wins.push(w);
    }
    for (const wv of document.querySelectorAll('.win webview')) {
      const w = wm.get(wv.closest('.win')?.dataset.id);
      if (!w) continue;
      let id;
      try {
        id = wv.getWebContentsId();
      } catch {
        continue;
      }
      const pid = wcPid.get(id);
      if (pid && pid !== hostPid && pid !== S.mainPid) apps.get(w.appId)?.pids.add(pid);
    }
    const appOf = new Map();
    for (const a of apps.values()) for (const pid of a.pids) appOf.set(pid, a.appId);

    // ---- partition processes
    const shellProcs = [];
    const kernel = [];
    const bg = [];
    const sys = [];
    for (const p of P) {
      if (p.kernel) kernel.push(p);
      else if (appOf.has(p.pid)) continue;
      else if (shellTypes.has(p.pid) || p.pid === S.mainPid) shellProcs.push(p);
      else if (p.uid === myUid) bg.push(p);
      else sys.push(p);
    }

    const sum = (procs, k) => procs.reduce((a, p) => a + (p[k] || 0), 0);
    const procData = (p, extra = {}) => ({
      type: 'proc',
      proc: p,
      procs: [p],
      name: p.name,
      icon: processIcon(p, extra),
      pid: p.pid,
      pids: [p.pid],
      procname: p.name,
      user: p.user,
      cmdline: p.cmdline,
      cpu: p.cpu,
      mem: p.priv,
      disk: p.disk,
      status: this.statusOf([p]),
      system: !!extra.system,
      ...extra.data,
    });
    const procEntry = (p, extra) => ({ key: `p:${p.pid}:${p.startTime}`, data: procData(p, extra), children: null });

    // Same-executable process trees collapse into one row (e.g. "electron (5)").
    const trees = (list, system) => {
      const set = new Map(list.map((p) => [p.pid, p]));
      const groups = new Map();
      for (const p of list) {
        let r = p;
        for (let i = 0; i < 64; i++) {
          const par = set.get(r.ppid);
          if (!par || par.name !== r.name) break;
          r = par;
        }
        if (!groups.has(r.pid)) groups.set(r.pid, { root: r, procs: [] });
        groups.get(r.pid).procs.push(p);
      }
      const out = [];
      for (const { root, procs } of groups.values()) {
        if (procs.length === 1) {
          out.push(procEntry(root, { system }));
          continue;
        }
        out.push({
          key: `g:${root.pid}:${root.startTime}`,
          data: {
            type: 'pgroup',
            proc: root,
            procs,
            name: `${root.name} (${procs.length})`,
            baseName: root.name,
            icon: processIcon(root, { system }),
            pid: root.pid,
            pids: procs.map((p) => p.pid),
            procname: root.name,
            user: root.user,
            cmdline: root.cmdline,
            cpu: sum(procs, 'cpu'),
            mem: sum(procs, 'priv'),
            disk: sum(procs, 'disk'),
            status: this.statusOf(procs),
            system,
          },
          children: procs.map((p) => procEntry(p, { system })),
        });
      }
      return out;
    };

    const appEntries = [];
    for (const a of apps.values()) {
      const m = registry.get(a.appId);
      const base = m ? registry.name(a.appId) : a.wins[0].title || a.appId;
      const procs = [...a.pids].map((pid) => byPid.get(pid)).filter(Boolean);
      const src = m ? registry.iconUrl(a.appId) : a.wins[0].iconUrl || 'app://shell/assets/app-default.svg';
      const kids = [
        ...a.wins.map((w) => ({ key: `w:${w.id}`, data: { type: 'window', win: w, appId: a.appId, name: w.title || base, icon: { src: w.iconUrl || src }, status: '' }, children: null })),
        ...procs.map((p) => procEntry(p, { data: { name: t('proc.tab', { name: p.name }) } })),
      ];
      appEntries.push({
        key: `a:${a.appId}`,
        data: {
          type: 'app',
          appId: a.appId,
          wins: a.wins,
          procs,
          name: a.wins.length > 1 ? `${base} (${a.wins.length})` : base,
          baseName: base,
          icon: { src },
          pids: procs.map((p) => p.pid),
          inShell: procs.length === 0,
          cpu: sum(procs, 'cpu'),
          mem: sum(procs, 'priv'),
          disk: sum(procs, 'disk'),
          status: this.statusOf(procs),
          pid: procs[0]?.pid || null,
          user: env.user,
        },
        children: kids,
      });
    }

    const sysEntries = [];
    if (shellProcs.length) {
      const typeName = (p) => {
        const s = shellTypes.get(p.pid);
        if (p.pid === S.mainPid || s?.type === 'Browser') return t('shell.main');
        if (p.pid === hostPid) return t('shell.desktop');
        if (!s) return p.name;
        if (s.type === 'GPU') return t('shell.gpu');
        if (s.type === 'Utility') return `${t('shell.utility')}: ${s.name || s.service || p.name}`;
        if (s.type === 'Zygote') return t('shell.zygote');
        if (s.type === 'Tab') return t('shell.renderer');
        return `${s.type}`;
      };
      const main = byPid.get(S.mainPid) || shellProcs[0];
      sysEntries.push({
        key: 'shell',
        data: {
          type: 'shell',
          proc: main,
          procs: shellProcs,
          name: `${t('shell.name')} (${shellProcs.length})`,
          baseName: t('shell.name'),
          icon: { src: 'app://shell/assets/aurora-logo.svg' },
          pid: S.mainPid,
          pids: shellProcs.map((p) => p.pid),
          procname: main?.name,
          user: main?.user,
          cmdline: main?.cmdline,
          cpu: sum(shellProcs, 'cpu'),
          mem: sum(shellProcs, 'priv'),
          disk: sum(shellProcs, 'disk'),
          status: '',
        },
        children: shellProcs.map((p) => procEntry(p, { data: { name: typeName(p), shell: true } })),
      });
    }
    if (kernel.length) {
      const kmem = perf ? perf.mem.slab + perf.mem.kernelStack + perf.mem.pageTables : 0;
      sysEntries.push({
        key: 'kernel',
        data: { type: 'kernel', procs: kernel, name: `${t('kernel.name')} (${kernel.length})`, baseName: t('kernel.name'), icon: { name: 'developer_board', tone: 'kernel' }, pids: [], user: 'root', procname: 'kthreadd', cpu: sum(kernel, 'cpu'), mem: kmem, disk: 0, status: '' },
        children: kernel.map((p) => procEntry(p, { data: { kernel: true } })),
      });
    }
    sysEntries.push(...trees(sys, true));

    this.sections = [
      { key: 'sec:apps', label: (n) => t('grp.apps', { count: n }), entries: appEntries },
      { key: 'sec:bg', label: (n) => t('grp.background', { count: n }), entries: trees(bg, false) },
      { key: 'sec:sys', label: (n) => t('grp.system', { count: n }), entries: sysEntries },
    ];
  }

  // ------------------------------------------------------------------ flatten / sort / filter
  sortValue(d, id) {
    switch (id) {
      case 'name':
        return d.baseName || d.name;
      case 'status':
        return typeof d.status === 'object' ? d.status.text : d.status || '';
      case 'pid':
        return d.pid || 0;
      case 'cpu':
        return d.inShell ? -1 : d.cpu || 0;
      case 'mem':
        return d.inShell ? -1 : d.mem || 0;
      case 'disk':
        return d.inShell ? -1 : d.disk || 0;
      default:
        return d[id] ?? '';
    }
  }
  sorted(entries) {
    const { id, dir } = this.sort;
    return [...entries].sort((a, b) => dir * compare(this.sortValue(a.data, id), this.sortValue(b.data, id)) || compare(a.data.name, b.data.name));
  }
  isExpanded(key, def) {
    return this.expanded.has(key) ? this.expanded.get(key) : def;
  }
  filterEntries(entries, m) {
    if (!m) return entries;
    const out = [];
    for (const e of entries) {
      const d = e.data;
      const self = m([d.name, d.procname, d.pid, d.user, ...(d.type === 'app' ? d.wins.map((w) => w.title) : []), d.type === 'window' ? d.win.title : null]);
      if (self) {
        out.push(e);
        continue;
      }
      if (e.children) {
        const kids = this.filterEntries(e.children, m);
        if (kids.length) out.push({ ...e, children: kids, forced: true });
      }
    }
    return out;
  }
  render() {
    if (!this.sections) return;
    const m = matcher(this.query);
    const rows = [];
    const push = (e, depth, parentKey) => {
      const kids = e.children && e.children.length ? e.children : null;
      const exp = !!kids && (e.forced || this.isExpanded(e.key, false));
      rows.push({ key: e.key, kind: 'item', depth, parentKey, expandable: !!kids, expanded: exp, data: e.data, dim: e.data.type === 'window' });
      if (exp) for (const c of e.data.type === 'app' ? e.children : this.sorted(kids)) push(c, depth + 1, e.key);
    };
    let total = 0;
    if (this.app.prefs.groupByType) {
      for (const s of this.sections) {
        const entries = this.filterEntries(s.entries, m);
        if (!entries.length) continue;
        total += entries.length;
        const exp = !!m || this.isExpanded(s.key, true);
        rows.push({ key: s.key, kind: 'group', depth: 0, expandable: true, expanded: exp, label: s.label(entries.length), data: { type: 'section' } });
        if (exp) for (const e of this.sorted(entries)) push(e, 0, s.key);
      }
    } else {
      const all = this.filterEntries(
        this.sections.flatMap((s) => s.entries),
        m,
      );
      total = all.length;
      for (const e of this.sorted(all)) push(e, 0, null);
    }
    this.table.setRows(rows, { emptyText: m ? this.app.t('empty.search', { q: this.query.trim() }) : this.app.t('empty.loading') });
    this.count = total;
  }

  onSort(id) {
    const numeric = ['cpu', 'mem', 'disk', 'pid'].includes(id);
    const dir = this.sort.id === id ? -this.sort.dir : numeric ? -1 : 1;
    this.sort = { id, dir };
    this.table.setSort(id, dir);
    this.app.prefs.sort = { ...this.app.prefs.sort, processes: this.sort };
    this.app.savePrefs();
    this.render();
  }
  toggle(row) {
    const def = row.kind === 'group';
    this.expanded.set(row.key, !this.isExpanded(row.key, def));
    this.render();
  }
  setAll(open) {
    for (const s of this.sections || []) {
      this.expanded.set(s.key, true);
      for (const e of s.entries) if (e.children?.length) this.expanded.set(e.key, open);
    }
    this.render();
  }
  reveal(pidOrKey) {
    const row = this.table.rows.find((r) => r.key === pidOrKey || r.data?.pid === pidOrKey);
    if (row) this.table.select(row.key);
  }

  // ------------------------------------------------------------------ actions
  selected() {
    const r = this.table.selectedRow();
    return r && r.kind !== 'group' ? r : null;
  }
  canEnd(r) {
    if (!r) return false;
    const d = r.data;
    if (d.type === 'kernel' || d.kernel) return false;
    return ['app', 'window', 'proc', 'pgroup', 'shell'].includes(d.type);
  }
  effState(r) {
    if (!r) return { enabled: false, on: false };
    const d = r.data;
    if (d.type === 'kernel' || d.kernel || d.type === 'shell' || d.shell || d.system || d.type === 'window') return { enabled: false, on: false };
    const procs = d.procs || [];
    if (!procs.length) return { enabled: false, on: false };
    return { enabled: true, on: procs.every((p) => p.nice >= 19) };
  }
  async endTask(r) {
    if (!this.canEnd(r)) return;
    const d = r.data;
    const A = this.app.actions;
    if (d.type === 'window') return this.closeWindows([d.win], d.name);
    if (d.type === 'app') return this.closeWindows(d.wins, d.baseName || d.name);
    const name = d.baseName || d.name;
    const critical = d.type === 'shell' || d.shell || d.pids.some((pid) => A.isCritical(this.byPid?.get(pid)?.name, pid));
    // Children first so a parent's own shutdown logic does not race them.
    const pids = d.type === 'proc' ? d.pids : [...d.pids].sort((a, b) => b - a);
    await A.endProcesses(pids, { name, critical });
  }
  // End task on an app: ask its windows to close (the app may ask to save its work). A window that
  // neither closes nor shows a dialog within a few seconds is treated as not responding.
  async closeWindows(wins, name) {
    const { t } = this.app;
    const { ui } = this.app.ctx;
    this.closing ||= new WeakSet();
    await Promise.all(
      wins.map(async (w) => {
        // A second End task while the app is still deciding (e.g. its "Save changes?" prompt is
        // open) must not ask again.
        if (this.closing.has(w) || w._closing) return;
        this.closing.add(w);
        const closed = Promise.resolve()
          .then(() => w.close())
          .catch(() => false);
        closed.then(() => this.closing.delete(w));
        const res = await Promise.race([closed, new Promise((r) => setTimeout(() => r('timeout'), 4000))]);
        if (res !== 'timeout' || w._closing || !wm.get(w.id) || w.el.querySelector('.dialog-layer') || this.app.closed) return;
        this.closing.delete(w);
        const v = await ui.dialog({
          title: t('notResponding.title', { name: w.title || name }),
          body: t('notResponding.body'),
          parent: this.app.win,
          buttons: [
            { label: t('notResponding.endNow'), value: 'kill', primary: true },
            { label: t('notResponding.wait'), value: null },
          ],
        });
        if (v === 'kill' && wm.get(w.id)) await w.close(true);
      }),
    );
  }
  async toggleEfficiency(r) {
    const st = this.effState(r);
    if (!st.enabled) return;
    await this.app.actions.setEfficiency(r.data.procs.map((p) => p.pid), !st.on, r.data.baseName || r.data.name);
  }
  activate(r) {
    const d = r.data;
    if (d.type === 'window') this.app.switchTo(d.win);
    else if (d.type === 'app') this.app.switchTo(d.wins[0]);
    else if (d.type === 'proc') this.goToDetails(r);
  }
  detailsPid(d) {
    if (d.type === 'window' || (d.type === 'app' && !d.procs.length)) return this.hostPid || this.mainPid;
    if (d.type === 'kernel') return 2;
    return d.pid || d.pids?.[0] || null;
  }
  goToDetails(r) {
    const pid = this.detailsPid(r.data);
    if (pid) this.app.go('details', { select: pid });
  }
  properties(r) {
    const d = r.data;
    const A = this.app.actions;
    if (d.type === 'app') return A.appProperties(d.appId, d.wins, d.procs);
    if (d.type === 'window') return A.appProperties(d.appId, [d.win], []);
    const pid = d.type === 'kernel' ? 2 : d.pid;
    if (pid) A.processProperties(pid, d.baseName || d.name, d.icon);
  }

  context(r, at) {
    const { t } = this.app;
    const A = this.app.actions;
    if (r.kind === 'group') {
      return this.app.menu(at, [
        { label: r.expanded ? t('menu.collapse') : t('menu.expand'), action: () => this.toggle(r) },
        '-',
        { label: t('view.expandAll'), action: () => this.setAll(true) },
        { label: t('view.collapseAll'), action: () => this.setAll(false) },
      ]);
    }
    const d = r.data;
    const eff = this.effState(r);
    const isWin = d.type === 'app' || d.type === 'window';
    const w = d.type === 'window' ? d.win : d.wins?.[0];
    const name = d.baseName || d.name;
    const items = [];
    if (r.expandable) items.push({ label: r.expanded ? t('menu.collapse') : t('menu.expand'), action: () => this.toggle(r) });
    if (isWin && w) {
      items.push({ label: t('menu.switchTo'), action: () => this.app.switchTo(w) });
      items.push({ label: t('menu.minimize'), disabled: !w.opts.minimizable, action: () => w.minimize() });
      items.push({ label: w.isMaximized() ? t('menu.restore') : t('menu.maximize'), disabled: !w.opts.maximizable || !w.opts.resizable, action: () => (w.isMaximized() ? w.restore() : w.maximize()) });
    }
    if (items.length) items.push('-');
    items.push({ label: t('cmd.endTask'), icon: 'prohibited', disabled: !this.canEnd(r), action: () => this.endTask(r) });
    items.push({
      label: t('menu.resourceValues'),
      submenu: [
        {
          label: t('col.mem'),
          submenu: [
            { label: t('menu.values'), checked: !this.app.prefs.memPercent, action: () => this.app.setPref('memPercent', false) },
            { label: t('menu.percents'), checked: !!this.app.prefs.memPercent, action: () => this.app.setPref('memPercent', true) },
          ],
        },
      ],
    });
    items.push('-');
    items.push({ label: t('cmd.efficiency'), icon: 'arrow-down', checked: eff.on, disabled: !eff.enabled, action: () => this.toggleEfficiency(r) });
    items.push('-');
    items.push({ label: t('menu.goToDetails'), disabled: !this.detailsPid(d), action: () => this.goToDetails(r) });
    const pid = d.type === 'proc' || d.type === 'pgroup' || d.type === 'shell' ? d.pid : null;
    items.push({ label: t('menu.openLocation'), disabled: !pid || d.kernel, action: () => A.openLocation(pid) });
    items.push({ label: t('menu.searchOnline'), action: () => A.searchOnline(d.type === 'window' ? registry.name(d.appId) : name) });
    items.push({ label: t('menu.properties'), action: () => this.properties(r) });
    this.app.menu(at, items);
  }

  commands() {
    const { t } = this.app;
    const r = this.selected();
    const eff = this.effState(r);
    return [
      { id: 'run', icon: 'window_new', label: t('cmd.run'), action: () => this.app.actions.runNewTask() },
      { id: 'end', icon: 'prohibited', label: t('cmd.endTask'), disabled: !this.canEnd(r), action: () => this.endTask(this.selected()) },
      { id: 'eff', icon: 'arrow-down', label: t('cmd.efficiency'), disabled: !eff.enabled, pressed: eff.on, action: () => this.toggleEfficiency(this.selected()) },
      {
        id: 'view',
        icon: 'eye',
        label: t('cmd.view'),
        menu: () => [
          { label: t('view.speed'), submenu: this.app.speedMenu() },
          { label: t('view.refresh'), shortcut: 'F5', action: () => this.app.store.refresh() },
          '-',
          { label: t('view.groupByType'), checked: !!this.app.prefs.groupByType, action: () => this.app.setPref('groupByType', !this.app.prefs.groupByType) },
          { label: t('view.expandAll'), action: () => this.setAll(true) },
          { label: t('view.collapseAll'), action: () => this.setAll(false) },
          '-',
          { label: t('menu.columns'), action: () => this.columnMenu(this.table.head) },
        ],
      },
    ];
  }

  destroy() {
    this.table.destroy();
  }
}
