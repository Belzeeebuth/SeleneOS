// Backup: incremental rsync snapshots of home folders to a destination folder (main/ipc/backup.js).
// Pages: Back up (status, progress, folders, destination), Snapshots (list, browse, restore, delete, keep last N),
// Settings (keep N, reminder through shell.reminders, excluded patterns).
// Test / automation hook: the window element exposes this object as `el.__backup`.
// Launch arguments: { reminder } (notification click) or { page: 'home' | 'snapshots' | 'settings' }.

const REMINDER_ID = 'backup-reminder';
const KEEP_OPTIONS = [0, 3, 5, 10, 20, 50];

class BackupApp {
  constructor(ctx) {
    this.ctx = ctx;
    const { win, h, t, api, shell, ui, icon } = ctx;
    Object.assign(this, { win, h, t, api, shell, ui, icon });
    this.page = 'home';
    this.cfg = null;
    this.home = '';
    this.excludes = [];
    this.rsync = true;
    this.snapshots = [];
    this.missing = new Set();
    this.run = null; // { opId, phase, percent, bytes, speed }
    this.message = null; // { kind: 'success'|'error'|'warning', text }
    this.browse = null; // { id, date, rel, entries, selected: Set }
    this.closed = false;
  }

  async init() {
    const { win, h } = this;
    win.el.__backup = this;
    this.root = h('div', { class: 'bk' });
    this.nav = h('nav', { class: 'bk-nav nav', 'aria-label': this.t('nav.label') });
    this.main = h('main', { class: 'bk-main', tabindex: '-1' });
    this.root.append(this.nav, this.main);
    win.body.appendChild(this.root);
    this.offProgress = this.api.on('backup:progress', (p) => this.onProgress(p));
    win.on?.('close', () => {
      this.closed = true;
      clearInterval(this.attachTimer);
      if (typeof this.offProgress === 'function') this.offProgress();
    });
    this.root.addEventListener('keydown', (e) => this.onKey(e));
    await this.load();
    this.render();
  }

  onRelaunch(args) {
    if (args?.page) this.go(args.page);
    else if (args?.reminder) this.go('home');
    this.win.focus?.();
  }

  // ------------------------------------------------------------------ data
  async load() {
    try {
      const c = await this.api.invoke('backup:config');
      this.cfg = c.config;
      this.home = c.home;
      this.excludes = c.excludes || [];
      this.rsync = c.rsync !== false;
      if (c.running && !this.run) this.attach(c.running);
    } catch (e) {
      this.cfg = this.cfg || { sources: [], dest: null, keep: 0, reminder: 'off', lastRun: null };
      this.setMessage('error', this.errText(e));
    }
    await this.checkSources();
    await this.loadSnapshots();
  }
  async checkSources() {
    this.missing = new Set();
    const res = await this.api.invoke('backup:validate', { sources: this.cfg.sources, dest: null }).catch(() => null);
    for (const e of res?.errors || []) this.missing.add(e.path);
  }
  async loadSnapshots() {
    const res = await this.api.invoke('backup:list').catch(() => null);
    this.snapshots = res?.snapshots || [];
  }
  async saveConfig(patch) {
    try {
      this.cfg = await this.api.invoke('backup:setConfig', patch);
      return true;
    } catch (e) {
      this.setMessage('error', this.errText(e));
      this.render();
      return false;
    }
  }

  // ------------------------------------------------------------------ helpers
  errText(e) {
    const code = e?.code || '';
    const msg = String(e?.message || e || '');
    const p = msg.includes(': ') ? msg.slice(msg.indexOf(': ') + 2) : '';
    const key = `err.${code}`;
    const s = this.t(key, { path: p });
    return s && s !== key ? s : this.t('err.generic', { msg });
  }
  setMessage(kind, text) {
    this.message = text ? { kind, text } : null;
  }
  fmtSize(n) {
    const fr = this.lang() === 'fr';
    const units = fr ? ['o', 'Ko', 'Mo', 'Go', 'To'] : ['B', 'KB', 'MB', 'GB', 'TB'];
    let v = Number(n) || 0;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    const num = new Intl.NumberFormat(this.locale(), { maximumFractionDigits: i ? 1 : 0 }).format(v);
    return `${num}${fr ? ' ' : ' '}${units[i]}`;
  }
  lang() {
    return this.ctx.i18n?.lang || document.documentElement.lang || 'en';
  }
  locale() {
    return this.lang() === 'fr' ? 'fr-FR' : 'en-US';
  }
  fmtDate(ms) {
    return new Intl.DateTimeFormat(this.locale(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms));
  }
  shortPath(p) {
    if (!p) return '';
    if (this.home && (p === this.home || p.startsWith(`${this.home}/`))) return `~${p.slice(this.home.length)}`;
    return p;
  }
  baseName(p) {
    return String(p).split('/').filter(Boolean).pop() || p;
  }
  btn(label, onclick, { primary, subtle, iconName, cls = '', disabled, tip, aria } = {}) {
    const { h, icon } = this;
    return h(
      'button',
      {
        class: `btn${primary ? ' primary' : ''}${subtle ? ' subtle' : ''} ${cls}`.trim(),
        onclick,
        disabled: !!disabled,
        'data-tip': tip,
        'aria-label': aria || tip,
        type: 'button',
      },
      iconName ? icon(iconName, { size: 16 }) : null,
      label ? h('span', null, label) : null,
    );
  }

  go(page) {
    if (!['home', 'snapshots', 'settings'].includes(page)) return;
    this.page = page;
    if (page !== 'snapshots') this.browse = null;
    this.render();
    if (page === 'snapshots') this.loadSnapshots().then(() => this.render());
  }

  // ------------------------------------------------------------------ render
  render() {
    if (this.closed) return;
    const { h, t, icon } = this;
    const items = [
      ['home', 'arrow_sync_circle'],
      ['snapshots', 'history'],
      ['settings', 'settings'],
    ];
    this.nav.replaceChildren(
      ...items.map(([id, ic]) =>
        h(
          'button',
          {
            class: `nav-item${this.page === id ? ' selected' : ''}`,
            type: 'button',
            dataset: { page: id },
            'aria-current': this.page === id ? 'page' : null,
            onclick: () => this.go(id),
          },
          icon(ic, { size: 18 }),
          h('span', null, t(`nav.${id}`)),
        ),
      ),
    );
    const view = this.page === 'snapshots' ? (this.browse ? this.renderBrowse() : this.renderSnapshots()) : this.page === 'settings' ? this.renderSettings() : this.renderHome();
    const msg = this.message
      ? h(
          'div',
          { class: `infobar bk-msg ${this.message.kind}`, role: this.message.kind === 'error' ? 'alert' : 'status' },
          icon(this.message.kind === 'success' ? 'checkmark_circle' : this.message.kind === 'error' ? 'error_circle' : 'warning', { size: 16, filled: true }),
          h('div', { class: 'grow' }, this.message.text),
          this.btn('', () => {
            this.setMessage(null);
            this.render();
          }, { subtle: true, iconName: 'dismiss', cls: 'bk-msg-close', tip: t('common.close') }),
        )
      : null;
    this.main.replaceChildren(...[msg, view].filter(Boolean));
  }

  renderHome() {
    const { h, t, icon, cfg } = this;
    const last = cfg.lastRun || this.snapshots[0]?.date;
    const running = !!this.run;
    let statusLine = cfg.dest ? t('home.to', { path: this.shortPath(cfg.dest) }) : t('home.noDest');
    let progress = null;
    if (running) {
      const r = this.run;
      const pct = Math.round((r.percent || 0) * 100);
      statusLine = r.phase === 'scan' ? t('home.scanning') : r.phase === 'finish' || r.phase === 'done' ? t('home.finishing') : t('home.progress', { percent: pct, bytes: this.fmtSize(r.bytes), speed: r.speed || '' });
      progress = h('div', { class: 'progress bk-progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct) }, h('div', { class: 'bar', style: { width: `${r.phase === 'scan' ? 2 : pct}%` } }));
    }
    const status = h(
      'section',
      { class: 'card bk-status' },
      h('div', { class: 'bk-status-icon' }, icon(running ? 'arrow_sync' : last ? 'checkmark_circle' : 'arrow_sync_circle', { size: 32 })),
      h(
        'div',
        { class: 'grow' },
        h('div', { class: 'subtitle bk-last' }, last ? t('home.last', { date: this.fmtDate(last) }) : t('home.never')),
        h('div', { class: 'caption bk-line' }, statusLine),
        progress,
      ),
      running
        ? this.btn(t('home.cancel'), () => this.cancel(), { cls: 'bk-cancel' })
        : this.btn(t('home.now'), () => this.start(), { primary: true, cls: 'bk-start', iconName: 'arrow_sync', disabled: !cfg.dest || !this.rsync || !cfg.sources.length }),
    );
    const rsyncBar = this.rsync ? null : h('div', { class: 'infobar warning' }, icon('warning', { size: 16, filled: true }), h('div', null, t('home.noRsync')));

    const rows = cfg.sources.map((s) =>
      h(
        'div',
        { class: 'card-row bk-src', dataset: { path: s } },
        icon('folder', { size: 20, filled: true }),
        h('div', { class: 'grow' }, h('div', { class: 'body-strong bk-ellipsis' }, this.baseName(s)), h('div', { class: 'caption bk-ellipsis' }, this.missing.has(s) ? `${this.shortPath(s)} · ${t('home.missing')}` : this.shortPath(s))),
        this.btn('', () => this.removeSource(s), { subtle: true, iconName: 'dismiss', cls: 'bk-remove', tip: t('home.remove', { name: this.baseName(s) }), disabled: running }),
      ),
    );
    const folders = h(
      'section',
      { class: 'bk-section' },
      h('h2', { class: 'body-strong bk-h2' }, t('home.folders')),
      h('div', { class: 'caption bk-hint' }, t('home.foldersHint')),
      ...(rows.length ? rows : [h('div', { class: 'card-row bk-empty-row caption' }, t('home.noFolders'))]),
      h('div', { class: 'bk-actions' }, this.btn(t('home.add'), () => this.addSource(), { iconName: 'folder_add', cls: 'bk-add', disabled: running }), this.btn(t('home.defaults'), () => this.resetSources(), { subtle: true, cls: 'bk-defaults', disabled: running })),
    );
    const dest = h(
      'section',
      { class: 'bk-section' },
      h('h2', { class: 'body-strong bk-h2' }, t('home.dest')),
      h(
        'div',
        { class: 'card-row bk-dest' },
        icon('hard_drive', { size: 20 }) || icon('folder', { size: 20 }),
        h('div', { class: 'grow' }, h('div', { class: 'body-strong bk-ellipsis bk-dest-path' }, cfg.dest ? this.shortPath(cfg.dest) : t('home.noDestShort')), h('div', { class: 'caption' }, t('home.destHint'))),
        this.btn(cfg.dest ? t('home.change') : t('home.choose'), () => this.pickDest(), { cls: 'bk-pick', disabled: running }),
      ),
    );
    return h('div', { class: 'bk-page bk-home' }, h('h1', { class: 'title' }, t('home.title')), rsyncBar, status, folders, dest);
  }

  renderSnapshots() {
    const { h, t, icon, cfg } = this;
    const head = h(
      'div',
      { class: 'bk-head' },
      h('h1', { class: 'title' }, t('snap.title')),
      h(
        'div',
        { class: 'bk-actions' },
        cfg.keep > 0 && this.snapshots.length > cfg.keep ? this.btn(t('snap.cleanup', { count: cfg.keep }), () => this.cleanup(), { cls: 'bk-cleanup', iconName: 'delete' }) : null,
        this.btn('', () => this.loadSnapshots().then(() => this.render()), { subtle: true, iconName: 'arrow_clockwise', cls: 'bk-refresh', tip: t('snap.refresh') }),
      ),
    );
    if (!cfg.dest || !this.snapshots.length) {
      return h('div', { class: 'bk-page' }, head, h('div', { class: 'empty bk-empty' }, icon('history', { size: 40 }), h('div', { class: 'subtitle' }, t('snap.empty')), h('div', { class: 'caption' }, cfg.dest ? t('snap.emptyHint') : t('snap.noDest'))));
    }
    const rows = this.snapshots.map((s) =>
      h(
        'div',
        { class: 'card-row bk-snap', dataset: { id: s.id } },
        icon('archive', { size: 20 }),
        h('div', { class: 'grow' }, h('div', { class: 'body-strong bk-ellipsis' }, this.fmtDate(s.date)), h('div', { class: 'caption bk-ellipsis' }, t('snap.info', { files: new Intl.NumberFormat(this.locale()).format(s.files), size: this.fmtSize(s.bytes), newSize: this.fmtSize(s.newBytes) }))),
        this.btn(t('snap.browse'), () => this.openSnapshot(s), { cls: 'bk-browse', iconName: 'folder_open' }),
        this.btn('', () => this.deleteSnapshot(s), { subtle: true, iconName: 'delete', cls: 'bk-delete', tip: t('snap.delete'), disabled: !!this.run }),
      ),
    );
    return h('div', { class: 'bk-page' }, head, h('div', { class: 'bk-list' }, ...rows));
  }

  renderBrowse() {
    const { h, t, icon } = this;
    const b = this.browse;
    const parts = b.rel ? b.rel.split('/') : [];
    const crumbs = [
      h('button', { class: 'bk-crumb', type: 'button', onclick: () => this.openDir('') }, this.fmtDate(b.date)),
      ...parts.map((p, i) => [h('span', { class: 'bk-sep', 'aria-hidden': 'true' }, '›'), h('button', { class: 'bk-crumb', type: 'button', onclick: () => this.openDir(parts.slice(0, i + 1).join('/')) }, p)]).flat(),
    ];
    const sel = [...b.selected];
    const bar = h(
      'div',
      { class: 'bk-toolbar' },
      this.btn('', () => this.closeBrowse(), { subtle: true, iconName: 'arrow_left', cls: 'bk-back', tip: t('snap.back') }),
      this.btn('', () => this.openDir(parts.slice(0, -1).join('/')), { subtle: true, iconName: 'arrow_up', cls: 'bk-up', tip: t('snap.up'), disabled: !parts.length }),
      h('nav', { class: 'bk-crumbs', 'aria-label': t('snap.title') }, ...crumbs),
      h('div', { class: 'grow' }),
      this.btn(t('snap.restore'), () => this.restore('original'), { primary: true, iconName: 'arrow_undo', cls: 'bk-restore', disabled: !sel.length }),
      this.btn(t('snap.restoreTo'), () => this.restore('folder'), { cls: 'bk-restore-to', disabled: !sel.length }),
    );
    const rows = b.entries.map((e) =>
      h(
        'div',
        {
          class: `list-item bk-entry${b.selected.has(e.rel) ? ' selected' : ''}`,
          tabindex: '0',
          role: 'option',
          'aria-selected': b.selected.has(e.rel) ? 'true' : 'false',
          dataset: { rel: e.rel },
          onclick: (ev) => this.select(e, ev),
          ondblclick: () => e.dir && this.openDir(e.rel),
          onkeydown: (ev) => this.entryKey(e, ev),
        },
        icon(e.dir ? 'folder' : 'document', { size: 18, filled: e.dir }),
        h('span', { class: 'grow bk-ellipsis bk-entry-name' }, e.name),
        h('span', { class: 'caption bk-col' }, e.dir ? '' : this.fmtSize(e.size)),
        h('span', { class: 'caption bk-col bk-col-date' }, this.fmtDate(e.mtime)),
      ),
    );
    return h(
      'div',
      { class: 'bk-page bk-browse' },
      bar,
      rows.length ? h('div', { class: 'list bk-entries', role: 'listbox', 'aria-multiselectable': 'true', 'aria-label': b.rel || this.fmtDate(b.date) }, ...rows) : h('div', { class: 'empty bk-empty' }, icon('folder', { size: 40 }), h('div', { class: 'caption' }, t('snap.emptyFolder'))),
    );
  }

  renderSettings() {
    const { h, t, ui, cfg } = this;
    const keep = ui.select({
      options: KEEP_OPTIONS.map((n) => ({ value: n, label: n ? String(n) : t('settings.keepAll') })),
      value: cfg.keep,
      onchange: (v) => this.saveConfig({ keep: Number(v) }).then(() => this.render()),
    });
    keep.classList.add('bk-keep');
    keep.setAttribute('aria-label', t('settings.keep'));
    const rem = ui.segmented({
      options: ['off', 'daily', 'weekly'].map((v) => ({ value: v, label: t(`settings.${v}`) })),
      value: cfg.reminder,
      onchange: (v) => this.setReminder(v),
    });
    rem.classList.add('bk-reminder');
    rem.setAttribute('aria-label', t('settings.reminder'));
    const row = (title, hint, control, cls) => h('div', { class: `card-row ${cls}` }, h('div', { class: 'grow' }, h('div', { class: 'body-strong' }, title), h('div', { class: 'caption' }, hint)), control);
    return h(
      'div',
      { class: 'bk-page bk-settings' },
      h('h1', { class: 'title' }, t('settings.title')),
      row(t('settings.keep'), t('settings.keepHint'), keep, 'bk-row-keep'),
      row(t('settings.reminder'), t('settings.reminderHint'), rem, 'bk-row-reminder'),
      row(t('settings.excluded'), t('settings.excludedHint'), h('div', { class: 'bk-excl' }, ...this.excludes.map((x) => h('code', null, x))), 'bk-row-excl'),
      h('div', { class: 'caption bk-hint' }, t('settings.file', { path: '~/.config/aurora/backup.json' })),
    );
  }

  // ------------------------------------------------------------------ actions
  async start() {
    if (this.run) return;
    const opId = `bk-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    this.run = { opId, phase: 'scan', percent: 0, bytes: 0, speed: '' };
    this.setMessage(null);
    this.render();
    try {
      const res = await this.api.invoke('backup:start', { opId });
      this.setMessage('success', this.t('home.done', { files: new Intl.NumberFormat(this.locale()).format(res.files), size: this.fmtSize(res.newBytes) }));
      this.lastResult = res;
    } catch (e) {
      if (e?.code === 'ECANCELED') this.setMessage('warning', this.t('home.canceled'));
      else this.setMessage('error', this.errText(e));
    }
    if (!this.closed) await this.load();
    this.run = null;
    this.render();
  }
  // A backup started from a window that was closed since: show its progress here and follow it until it ends.
  attach(opId) {
    this.run = { opId, phase: 'scan', percent: 0, bytes: 0, speed: '', attached: true };
    clearInterval(this.attachTimer);
    this.attachTimer = setInterval(async () => {
      if (this.closed) return clearInterval(this.attachTimer);
      const c = await this.api.invoke('backup:config').catch(() => null);
      if (!c || c.running === opId) return;
      clearInterval(this.attachTimer);
      this.run = null;
      await this.load();
      if (!this.closed) this.render();
    }, 1500);
  }
  async cancel() {
    if (!this.run) return;
    await this.api.invoke('backup:cancel', this.run.opId).catch(() => {});
  }
  onProgress(p) {
    if (!this.run || p?.opId !== this.run.opId) return;
    Object.assign(this.run, p);
    if (this.page === 'home') {
      const bar = this.main.querySelector('.bk-progress .bar');
      const line = this.main.querySelector('.bk-line');
      if (bar && line && p.phase === 'copy') {
        const pct = Math.round((p.percent || 0) * 100);
        bar.style.width = `${pct}%`;
        bar.parentElement.setAttribute('aria-valuenow', String(pct));
        line.textContent = this.t('home.progress', { percent: pct, bytes: this.fmtSize(p.bytes), speed: p.speed || '' });
      } else this.render();
    }
  }
  async addSource() {
    const p = await this.ui.filePicker({ mode: 'folder', title: this.t('home.pickSource'), path: this.home, parent: this.win });
    if (!p || this.closed) return;
    await this.addSourcePath(p);
  }
  async addSourcePath(p) {
    if (this.cfg.sources.includes(p)) return true;
    const ok = await this.saveConfig({ sources: [...this.cfg.sources, p] });
    if (ok) {
      this.setMessage(null);
      await this.checkSources();
      this.render();
    }
    return ok;
  }
  async removeSource(p) {
    // folders already in the list may be missing ("Not found"): the backend keeps them, only new ones must exist
    const ok = await this.saveConfig({ sources: this.cfg.sources.filter((s) => s !== p) });
    if (ok) {
      await this.checkSources();
      this.render();
    }
  }
  async resetSources() {
    const c = await this.api.invoke('backup:config').catch(() => null);
    const ok = await this.saveConfig({ sources: (c?.defaults || []).filter(Boolean) }).catch(() => false);
    if (!ok) {
      // some default folders may not exist: keep the ones that do
      const res = await this.api.invoke('backup:validate', { sources: c?.defaults || [], dest: null }).catch(() => null);
      const bad = new Set((res?.errors || []).map((e) => e.path));
      this.setMessage(null);
      await this.saveConfig({ sources: (c?.defaults || []).filter((s) => !bad.has(s)) });
    }
    await this.checkSources();
    this.render();
  }
  async pickDest() {
    const p = await this.ui.filePicker({ mode: 'folder', title: this.t('home.pickDest'), path: this.cfg.dest || '/media', parent: this.win });
    if (!p || this.closed) return;
    await this.setDest(p);
  }
  async setDest(p) {
    const ok = await this.saveConfig({ dest: p });
    if (ok) {
      this.setMessage(null);
      await this.loadSnapshots();
      this.render();
    }
    return ok;
  }
  async setReminder(v) {
    const ok = await this.saveConfig({ reminder: v });
    if (!ok) return;
    const rem = this.shell?.reminders;
    try {
      if (v === 'off') rem?.remove(REMINDER_ID, 'backup');
      else {
        const at = new Date();
        at.setHours(19, 0, 0, 0);
        if (at.getTime() <= Date.now()) at.setDate(at.getDate() + 1);
        if (v === 'weekly') while (at.getDay() !== 0) at.setDate(at.getDate() + 1);
        rem?.set({ id: REMINDER_ID, appId: 'backup', at: at.getTime(), title: this.t('reminder.title'), body: this.t('reminder.body'), repeat: v, kind: 'reminder', data: { page: 'home' } });
      }
    } catch (e) {
      this.setMessage('error', this.errText(e));
    }
    this.render();
  }
  async cleanup() {
    const n = this.cfg.keep;
    if (!(n > 0)) return;
    const ok = await this.ui.confirm(this.t('snap.cleanupAsk', { count: n }), { title: this.t('snap.cleanup', { count: n }), okLabel: this.t('snap.delete'), danger: true, parent: this.win });
    if (!ok) return;
    await this.api.invoke('backup:prune', n).catch((e) => this.setMessage('error', this.errText(e)));
    await this.loadSnapshots();
    this.render();
  }
  async deleteSnapshot(s) {
    const ok = await this.ui.confirm(this.t('snap.deleteAsk', { date: this.fmtDate(s.date) }), { title: this.t('snap.deleteTitle'), okLabel: this.t('snap.delete'), danger: true, parent: this.win });
    if (!ok) return;
    await this.api.invoke('backup:delete', [s.id]).catch((e) => this.setMessage('error', this.errText(e)));
    await this.loadSnapshots();
    this.render();
    this.main.querySelector('.bk-snap .bk-browse, .bk-refresh')?.focus();
  }
  async openSnapshot(s) {
    this.browse = { id: s.id, date: s.date, rel: '', entries: [], selected: new Set() };
    await this.openDir('');
  }
  async openDir(rel) {
    if (!this.browse) return;
    try {
      const entries = await this.api.invoke('backup:browse', this.browse.id, rel);
      Object.assign(this.browse, { rel, entries, selected: new Set() });
    } catch (e) {
      this.setMessage('error', this.errText(e));
    }
    this.render();
    (this.main.querySelector('.bk-entry') || this.main.querySelector('.bk-back'))?.focus();
  }
  closeBrowse() {
    this.browse = null;
    this.render();
    this.main.querySelector('.bk-browse')?.focus();
  }
  select(e, ev) {
    const sel = this.browse.selected;
    if (ev?.ctrlKey || ev?.metaKey) sel.has(e.rel) ? sel.delete(e.rel) : sel.add(e.rel);
    else {
      sel.clear();
      sel.add(e.rel);
    }
    this.render();
    this.main.querySelector(`.bk-entry[data-rel="${CSS.escape(e.rel)}"]`)?.focus();
  }
  entryKey(e, ev) {
    const list = [...this.main.querySelectorAll('.bk-entry')];
    const i = list.indexOf(ev.currentTarget);
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      list[Math.max(0, Math.min(list.length - 1, i + (ev.key === 'ArrowDown' ? 1 : -1)))]?.focus();
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      if (e.dir) this.openDir(e.rel);
      else this.select(e, ev);
    } else if (ev.key === ' ') {
      ev.preventDefault();
      this.select(e, { ctrlKey: true });
    }
  }
  onKey(e) {
    if (e.key === 'Backspace' && this.browse && !e.target.closest('input, textarea, select')) {
      e.preventDefault();
      const parts = this.browse.rel ? this.browse.rel.split('/') : [];
      if (parts.length) this.openDir(parts.slice(0, -1).join('/'));
      else this.closeBrowse();
    }
  }
  async restore(to) {
    const b = this.browse;
    const rels = [...(b?.selected || [])];
    if (!rels.length) return;
    let folder = null;
    if (to === 'folder') {
      folder = await this.ui.filePicker({ mode: 'folder', title: this.t('snap.restoreToPick'), path: this.home, parent: this.win });
      if (!folder || this.closed) return;
    }
    await this.restoreItems(rels, { to, folder });
  }
  async restoreItems(rels, { to = 'original', folder = null, overwrite = false } = {}) {
    const b = this.browse;
    try {
      let res = await this.api.invoke('backup:restore', b.id, rels, { to, folder, overwrite });
      if (res.conflicts.length && !overwrite) {
        const ok = await this.ui.confirm(this.t('snap.restoreAsk', { count: res.conflicts.length }), { title: this.t('snap.restoreTitle'), okLabel: this.t('snap.replace'), parent: this.win });
        if (!ok) return { restored: 0, conflicts: res.conflicts };
        res = await this.api.invoke('backup:restore', b.id, rels, { to, folder, overwrite: true });
      }
      this.setMessage('success', this.t('snap.restored', { count: res.restored }));
      this.render();
      return res;
    } catch (e) {
      this.setMessage('error', this.errText(e));
      this.render();
      return null;
    }
  }
}

export default {
  async launch(ctx) {
    const app = new BackupApp(ctx);
    await app.init();
    if (ctx.args?.page) app.go(ctx.args.page);
    return { onRelaunch: (args) => app.onRelaunch(args) };
  },
};
