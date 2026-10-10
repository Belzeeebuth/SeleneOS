// Startup apps: XDG autostart entries (/etc/xdg/autostart + ~/.config/autostart) that apply to
// the Aurora session, with Enable / Disable (a per-user override file, no admin rights needed).
import { VTable } from '../table.js';
import { matcher, compare } from '../util.js';

export class StartupPage {
  constructor(app) {
    this.app = app;
    this.id = 'startup';
    this.icon = 'top_speed';
    this.needs = { procs: false, shell: false };
    this.query = '';
    this.data = null;
    this.sort = app.prefs.sort.startup || { id: 'name', dir: 1 };
    this.table = new VTable({
      header: 'one-line',
      rowHeight: 30,
      label: app.t('nav.startup'),
      flat: true,
      widths: app.prefs.widths.startup,
      onSort: (id) => this.onSort(id),
      onSelect: () => app.renderCommands(),
      onActivate: (row) => this.properties(row),
      onContext: (row, e) => this.context(row, e),
      onResize: (w) => {
        app.prefs.widths = { ...app.prefs.widths, startup: w };
        app.savePrefs();
      },
    });
    this.table.setSort(this.sort.id, this.sort.dir);
    this.applyColumns();
  }

  title() {
    return this.app.t('nav.startup');
  }
  mount(el) {
    const { h, icon } = this.app.ctx;
    this.noteEl = h('div', { class: 'tm-pagenote caption text-2' });
    this.emptyEl = h('div', { class: 'tm-empty-state', hidden: true }, icon('top_speed', { size: 40 }), h('div', { class: 'body-strong' }), h('div', { class: 'caption text-2' }));
    el.append(this.noteEl, this.emptyEl, this.table.el);
  }
  focus() {
    this.table.focus();
  }
  relabel() {
    this.table.el.setAttribute('aria-label', this.title());
    this.applyColumns();
    this.load();
  }
  applyColumns() {
    const { t } = this.app;
    this.table.setColumns([
      { id: 'name', name: true, width: 220, min: 120, label: () => t('col.name'), cell: (r) => ({ text: r.data.name, icon: { name: 'app_generic', tone: r.data.enabled ? 'user' : 'muted' } }) },
      { id: 'command', flex: true, width: 260, min: 100, label: () => t('col.command'), cell: (r) => ({ text: r.data.exec, tip: r.data.exec }) },
      { id: 'status', width: 110, min: 60, label: () => t('col.status'), cell: (r) => (r.data.enabled ? t('startup.enabled') : t('startup.disabled')) },
      { id: 'scope', width: 120, min: 60, label: () => t('col.scope'), cell: (r) => t(`startup.scope.${r.data.scope}`) },
      { id: 'impact', width: 120, min: 60, label: () => t('col.impact'), cell: () => t('startup.notMeasured') },
    ]);
  }

  show() {
    this.load();
  }
  refresh() {
    this.load();
  }
  async load() {
    try {
      this.data = await this.app.ctx.api.invoke('perf:startup', this.app.ctx.lang);
      this.error = null;
    } catch (err) {
      this.error = err;
    }
    this.render();
    this.app.renderCommands();
  }
  onSearch(q) {
    this.query = q || '';
    this.render();
  }

  render() {
    const { t, fmt } = this.app;
    if (this.data?.bootTime) this.noteEl.textContent = t('startup.boot', { date: fmt.date(this.data.bootTime) });
    const entries = (this.data?.entries || []).filter((e) => !e.excluded);
    const empty = !this.error && this.data && !entries.length;
    this.emptyEl.hidden = !(empty || this.error);
    this.table.el.hidden = !!(empty || this.error);
    if (empty || this.error) {
      const [, title, sub] = this.emptyEl.children;
      title.textContent = this.error ? t('startup.error') : t('startup.none');
      sub.textContent = this.error ? this.error.message : t('startup.noneHint');
      return;
    }
    const m = matcher(this.query);
    const rows = [];
    for (const e of entries) {
      if (m && !m([e.name, e.exec, e.comment])) continue;
      rows.push({ key: `st:${e.id}`, kind: 'item', depth: 0, data: e });
    }
    const { id, dir } = this.sort;
    const val = (e) => (id === 'command' ? e.exec : id === 'status' ? (e.enabled ? 0 : 1) : e[id]);
    rows.sort((a, b) => dir * compare(val(a.data), val(b.data)) || compare(a.data.name, b.data.name));
    this.table.setRows(rows, { emptyText: m ? t('empty.search', { q: this.query.trim() }) : t('empty.loading') });
  }

  onSort(id) {
    const dir = this.sort.id === id ? -this.sort.dir : 1;
    this.sort = { id, dir };
    this.table.setSort(id, dir);
    this.app.prefs.sort = { ...this.app.prefs.sort, startup: this.sort };
    this.app.savePrefs();
    this.render();
  }

  async set(r, enabled) {
    if (!r) return;
    try {
      await this.app.ctx.api.invoke('perf:startupSet', r.data.id, enabled);
    } catch (err) {
      await this.app.actions.alertErr(this.app.t('startup.failed', { name: r.data.name, msg: err.message }));
    }
    await this.load();
  }
  properties(r) {
    if (!r) return;
    const { t } = this.app;
    const { h, ui } = this.app.ctx;
    const e = r.data;
    const kv = h(
      'dl',
      { class: 'tm-kv selectable' },
      [
        [t('col.name'), e.name],
        [t('props.description'), e.comment],
        [t('col.command'), e.exec],
        [t('col.status'), e.enabled ? t('startup.enabled') : t('startup.disabled')],
        [t('col.scope'), t(`startup.scope.${e.scope}`)],
        [t('startup.file'), e.id],
        [t('startup.desktops'), e.desktopOnly],
      ]
        .filter(([, v]) => v)
        .map(([k, v]) => [h('dt', null, k), h('dd', null, v)]),
    );
    ui.dialog({ title: t('props.title', { name: e.name }), body: h('div', { class: 'tm-props' }, kv), parent: this.app.win, width: 500 });
  }

  context(r, at) {
    const { t } = this.app;
    this.app.menu(at, [
      r.data.enabled ? { label: t('cmd.disable'), icon: 'prohibited', action: () => this.set(r, false) } : { label: t('cmd.enable'), icon: 'checkmark_circle', action: () => this.set(r, true) },
      '-',
      { label: t('menu.searchOnline'), action: () => this.app.actions.searchOnline(r.data.name) },
      { label: t('menu.properties'), action: () => this.properties(r) },
    ]);
  }

  commands() {
    const { t } = this.app;
    const r = this.table.selectedRow();
    return [
      { id: 'run', icon: 'window_new', label: t('cmd.run'), action: () => this.app.actions.runNewTask() },
      { id: 'enable', icon: 'checkmark_circle', label: t('cmd.enable'), disabled: !r || r.data.enabled, action: () => this.set(this.table.selectedRow(), true) },
      { id: 'disable', icon: 'prohibited', label: t('cmd.disable'), disabled: !r || !r.data.enabled, action: () => this.set(this.table.selectedRow(), false) },
      { id: 'props', icon: 'info', label: t('cmd.properties'), disabled: !r, action: () => this.properties(this.table.selectedRow()) },
    ];
  }

  destroy() {
    this.table.destroy();
  }
}
