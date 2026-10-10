// Users page: signed-in users (logind sessions, or process owners) with their total CPU,
// memory and disk use; expand a user to see their processes grouped by program.
import { VTable } from '../table.js';
import { heat, matcher, compare, processIcon } from '../util.js';

const USERS_MS = 10000;
const DISK_SCALE = 50 * 1048576;

export class UsersPage {
  constructor(app) {
    this.app = app;
    this.id = 'users';
    this.icon = 'people';
    this.needs = { procs: true, shell: true };
    this.query = '';
    this.users = null;
    this.expanded = new Map();
    this.sort = app.prefs.sort.users || { id: 'name', dir: 1 };
    this.table = new VTable({
      header: 'two-line',
      rowHeight: 30,
      label: app.t('nav.users'),
      widths: app.prefs.widths.users,
      onSort: (id) => this.onSort(id),
      onSelect: () => app.renderCommands(),
      onToggle: (row) => this.toggle(row),
      onActivate: (row) => row.data.type === 'proc' && this.app.go('details', { select: row.data.pid }),
      onContext: (row, e) => this.context(row, e),
      onDelete: (row) => this.endTask(row),
      onResize: (w) => {
        app.prefs.widths = { ...app.prefs.widths, users: w };
        app.savePrefs();
      },
    });
    this.table.setSort(this.sort.id, this.sort.dir);
    this.applyColumns();
  }

  title() {
    return this.app.t('nav.users');
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

  applyColumns() {
    const { t, fmt, store } = this.app;
    const perf = () => store.perf;
    const total = () => perf()?.mem.total || 1;
    this.table.setColumns([
      { id: 'name', name: true, flex: true, max: 560, width: 260, min: 140, label: () => t('col.userCol'), cell: (r) => ({ text: r.data.label, icon: r.data.icon }) },
      { id: 'status', width: 120, min: 60, label: () => t('col.status'), cell: (r) => r.data.statusText || '' },
      { id: 'cpu', width: 88, min: 60, align: 'end', heat: true, label: () => t('col.cpu'), top: () => (perf() ? fmt.pct(perf().cpu.total) : ''), hot: () => (perf()?.cpu.total || 0) >= 85, cell: (r) => ({ text: fmt.cpu(r.data.cpu), heat: heat(r.data.cpu / 100) }) },
      {
        id: 'mem',
        width: 104,
        min: 70,
        align: 'end',
        heat: true,
        label: () => t('col.mem'),
        top: () => (perf() ? fmt.pct((perf().mem.used / total()) * 100) : ''),
        hot: () => (perf() ? perf().mem.used / total() >= 0.85 : false),
        cell: (r) => ({ text: fmt.mb(r.data.mem), heat: heat((r.data.mem / total()) * 4) }),
      },
      { id: 'disk', width: 92, min: 60, align: 'end', heat: true, label: () => t('col.disk'), top: () => (perf() ? fmt.pct(Math.max(0, ...perf().disks.map((d) => d.busyPct))) : ''), cell: (r) => ({ text: fmt.mbps(r.data.disk), heat: heat(r.data.disk / DISK_SCALE) }) },
    ]);
  }

  show() {
    this.loadUsers();
    clearInterval(this.timer);
    this.timer = setInterval(() => this.app.store.running && this.loadUsers(), USERS_MS);
  }
  hide() {
    clearInterval(this.timer);
  }
  refresh() {
    this.loadUsers();
  }
  async loadUsers() {
    try {
      this.users = await this.app.ctx.api.invoke('perf:users');
    } catch {
      // No session information: at least the signed-in user (otherwise the page would say "Loading…" forever).
      const env = this.app.ctx.env;
      if (!this.users?.length) this.users = [{ uid: env.uid, user: env.user, fullName: env.user, status: 'active', sessions: [] }];
    }
    if (this.app.closed) return;
    this.render();
  }
  update() {
    this.render();
    this.table.refreshHeader();
  }
  onSearch(q) {
    this.query = q || '';
    this.render();
  }
  onPref(key) {
    if (key === 'showFullName') this.render();
  }

  render() {
    const { t } = this.app;
    const P = this.app.store.procs;
    if (!P || !this.users) {
      this.table.setRows([], { emptyText: t('empty.loading') });
      return;
    }
    const me = this.app.ctx.env.uid;
    const shell = this.app.store.shellInfo;
    const m = matcher(this.query);
    const sum = (list, k) => list.reduce((a, p) => a + (p[k] || 0), 0);
    const users = [];
    for (const u of this.users) {
      const procs = P.filter((p) => p.uid === u.uid && !p.kernel);
      const byName = new Map();
      for (const p of procs) {
        const name = shell && (p.pid === shell.mainPid || shell.processes.some((x) => x.pid === p.pid)) ? t('shell.name') : p.name;
        if (!byName.has(name)) byName.set(name, []);
        byName.get(name).push(p);
      }
      const groups = [];
      for (const [name, list] of byName) {
        const icon = name === t('shell.name') ? { src: 'app://shell/assets/aurora-logo.svg' } : processIcon(list[0], { system: u.uid !== me });
        const leaf = (p) => ({ key: `up:${p.pid}:${p.startTime}`, data: { type: 'proc', pid: p.pid, label: name === p.name ? p.name : `${name} (${p.pid})`, icon, cpu: p.cpu, mem: p.priv, disk: p.disk, procs: [p], user: u } });
        if (list.length === 1) groups.push(leaf(list[0]));
        else groups.push({ key: `ug:${u.uid}:${name}`, data: { type: 'group', label: `${name} (${list.length})`, name, icon, cpu: sum(list, 'cpu'), mem: sum(list, 'priv'), disk: sum(list, 'disk'), procs: list, user: u }, children: list.map(leaf) });
      }
      const label = this.app.prefs.showFullName && u.fullName && u.fullName !== u.user ? `${u.fullName} (${u.user})` : u.user;
      const nSessions = u.sessions.length;
      const statusText = u.status ? t(`user.status.${u.status}`) + (nSessions > 1 ? ` (${nSessions})` : '') : '';
      users.push({ key: `u:${u.uid}`, data: { type: 'user', u, label: `${label} (${procs.length})`, name: u.user, icon: { name: 'person', tone: u.uid === me ? 'accent' : 'neutral', filled: true }, statusText, cpu: sum(procs, 'cpu'), mem: sum(procs, 'priv'), disk: sum(procs, 'disk'), procs }, children: groups });
    }
    const { id, dir } = this.sort;
    const val = (d) => (id === 'name' ? d.name || d.label : id === 'status' ? d.statusText || '' : d[id] || 0);
    const sorted = (list) => [...list].sort((a, b) => dir * compare(val(a.data), val(b.data)) || compare(a.data.label, b.data.label));
    const rows = [];
    const push = (e, depth, parentKey, force) => {
      const kids = e.children?.length ? e.children : null;
      const exp = !!kids && (force || this.expanded.get(e.key) || (e.data.type === 'user' && !this.expanded.has(e.key) && e.data.u.uid === me));
      rows.push({ key: e.key, kind: 'item', depth, parentKey, expandable: !!kids, expanded: !!exp, data: e.data });
      if (exp) for (const c of sorted(kids)) push(c, depth + 1, e.key, force);
    };
    for (const u of sorted(users)) {
      if (m) {
        const hit = m([u.data.name, u.data.label]);
        const kids = hit ? u.children : u.children.filter((g) => m([g.data.label, g.data.name, ...(g.data.procs || []).map((p) => p.pid)]));
        if (!kids.length && !hit) continue;
        push({ ...u, children: kids }, 0, null, !hit);
      } else push(u, 0, null, false);
    }
    this.table.setRows(rows, { emptyText: m ? t('empty.search', { q: this.query.trim() }) : t('empty.loading') });
  }

  onSort(id) {
    const dir = this.sort.id === id ? -this.sort.dir : ['cpu', 'mem', 'disk'].includes(id) ? -1 : 1;
    this.sort = { id, dir };
    this.table.setSort(id, dir);
    this.app.prefs.sort = { ...this.app.prefs.sort, users: this.sort };
    this.app.savePrefs();
    this.render();
  }
  toggle(row) {
    this.expanded.set(row.key, !row.expanded);
    this.render();
  }

  isMe(u) {
    return u && u.uid === this.app.ctx.env.uid;
  }
  canEnd(r) {
    return !!r && (r.data.type === 'proc' || r.data.type === 'group') && r.data.procs.every((p) => p.pid !== this.app.store.shellInfo?.mainPid);
  }
  endTask(r) {
    if (!this.canEnd(r)) return;
    const d = r.data;
    this.app.actions.endProcesses(
      d.procs.map((p) => p.pid),
      { name: d.name || d.label, critical: d.procs.some((p) => this.app.actions.isCritical(p.name, p.pid)) },
    );
  }
  async signOut() {
    const { t } = this.app;
    const ok = await this.app.ctx.ui.confirm(t('user.signOutBody'), { title: t('user.signOutTitle'), okLabel: t('cmd.signOut'), parent: this.app.win });
    if (ok) this.app.ctx.shell.logout();
  }
  manageAccounts() {
    this.app.ctx.shell.launch('settings', { page: 'accounts' });
  }
  hasSettings() {
    return !!this.app.ctx.shell.registry?.get?.('settings');
  }

  context(r, at) {
    const { t } = this.app;
    const d = r.data;
    const items = [];
    if (r.expandable) items.push({ label: r.expanded ? t('menu.collapse') : t('menu.expand'), action: () => this.toggle(r) });
    if (d.type === 'user') {
      items.push({ label: t('cmd.signOut'), icon: 'sign_out', disabled: !this.isMe(d.u), action: () => this.signOut() });
      items.push({ label: t('cmd.manageAccounts'), icon: 'person_accounts', disabled: !this.hasSettings(), action: () => this.manageAccounts() });
    } else {
      items.push({ label: t('cmd.endTask'), icon: 'prohibited', disabled: !this.canEnd(r), action: () => this.endTask(r) });
      items.push({ label: t('menu.goToDetails'), action: () => this.app.go('details', { select: d.procs[0].pid }) });
      items.push({ label: t('menu.properties'), action: () => this.app.actions.processProperties(d.procs[0].pid, d.name || d.label) });
    }
    this.app.menu(at, items);
  }

  commands() {
    const { t } = this.app;
    const r = this.table.selectedRow();
    const u = r?.data?.u || r?.data?.user;
    return [
      { id: 'run', icon: 'window_new', label: t('cmd.run'), action: () => this.app.actions.runNewTask() },
      r && r.data.type !== 'user'
        ? { id: 'end', icon: 'prohibited', label: t('cmd.endTask'), disabled: !this.canEnd(r), action: () => this.endTask(this.table.selectedRow()) }
        : { id: 'signout', icon: 'sign_out', label: t('cmd.signOut'), disabled: !this.isMe(u), action: () => this.signOut() },
      { id: 'accounts', icon: 'person_accounts', label: t('cmd.manageAccounts'), disabled: !this.hasSettings(), action: () => this.manageAccounts() },
    ];
  }

  destroy() {
    clearInterval(this.timer);
    this.table.destroy();
  }
}
