// Cloud: a light Nextcloud / WebDAV client. Account setup, a file list with a breadcrumb, upload / download with
// progress, new folder and delete. Backend: main/ipc/cloud.js (an in-memory mock server in dev / tests).
// Tests drive it through the window element: document.querySelector('.win.app-cloud').__cloud
const ERR_CODES = new Set(['EURL', 'EINSECURE', 'EAUTH', 'ENET', 'EUSER', 'EPASS', 'ENAME', 'EEXIST', 'ENOENT']);

class CloudApp {
  constructor(ctx) {
    this.ctx = ctx;
    this.win = ctx.win;
    this.accounts = [];
    this.accountId = null;
    this.path = '/';
    this.entries = [];
    this.selected = null;
    this.loading = false;
    this.error = '';
    this.mode = 'browser'; // 'setup' | 'browser'
    this.transfers = [];
    this.seq = 0;
    this.listToken = 0;
    this.root = ctx.h('div', { class: 'cloud' });
    this.win.body.appendChild(this.root);
    this.win.el.__cloud = this;
  }

  t(k, v) {
    return this.ctx.t(k, v);
  }

  errText(e) {
    const code = e?.code;
    return ERR_CODES.has(code) ? this.t(`err_${code}`) : this.t('err_other', { msg: String(e?.message || e || '').replace(/^Error:\s*/, '') });
  }

  async init() {
    const offProgress = this.ctx.api.on('cloud:progress', (p) => this.onProgress(p));
    this.win.on('close', () => typeof offProgress === 'function' && offProgress());
    this.ctx.onLangChange?.(() => this.render());
    this.root.addEventListener('keydown', (e) => this.onKey(e));
    this.accounts = await this.ctx.api.invoke('cloud:accounts').catch(() => []);
    const last = await Promise.resolve(this.ctx.storage.get('state', {})).catch(() => ({}));
    this.accountId = this.accounts.find((a) => a.id === last?.accountId)?.id || this.accounts[0]?.id || null;
    this.mode = this.accountId ? 'browser' : 'setup';
    this.render();
    if (this.accountId) await this.open('/');
  }

  get account() {
    return this.accounts.find((a) => a.id === this.accountId) || null;
  }

  saveState() {
    try {
      this.ctx.storage.set('state', { accountId: this.accountId });
    } catch {}
  }

  // ---------------------------------------------------------------- rendering
  render() {
    const { h } = this.ctx;
    const focusInList = this.root.querySelector('.cl-list')?.contains(document.activeElement);
    this.root.replaceChildren(this.mode === 'setup' ? this.renderSetup() : this.renderBrowser(), this.renderTransfers() || '');
    if (focusInList) this.root.querySelector('.cl-list')?.focus({ preventScroll: true });
    this.win.setTitle(this.mode === 'browser' && this.account ? `${this.t('title')} - ${this.account.label}` : this.t('title'));
    void h;
  }

  renderSetup() {
    const { h, ui, icon } = this.ctx;
    const st = (this.setup ||= { kind: 'nextcloud', server: '', user: '', password: '', busy: false, error: '' });
    const field = (key, label, attrs = {}, hint = '') =>
      h(
        'div',
        { class: 'field' },
        h('label', { for: `cl-${key}` }, label),
        h('input', {
          id: `cl-${key}`,
          class: 'input',
          name: key,
          value: st[key],
          autocomplete: 'off',
          spellcheck: false,
          oninput: (e) => (st[key] = e.target.value),
          ...attrs,
        }),
        hint ? h('div', { class: 'field-hint caption text-2' }, hint) : '',
      );
    const form = h(
      'form',
      {
        class: 'cl-form',
        onsubmit: (e) => {
          e.preventDefault();
          this.connect();
        },
      },
      h('div', { class: 'field' }, h('label', null, this.t('service')),
        ui.segmented({
          options: [
            { value: 'nextcloud', label: this.t('nextcloud') },
            { value: 'webdav', label: this.t('webdav') },
          ],
          value: st.kind,
          onchange: (v) => {
            st.kind = v;
            this.render();
          },
        })),
      h('div', { class: 'infobar cl-more', role: 'note' }, icon('cloud_add', { size: 16 }), h('span', null, this.t('moreServices'))),
      field('server', this.t('server'), { type: 'url', placeholder: 'https://', autofocus: true }, st.kind === 'webdav' ? this.t('serverHintWebdav') : this.t('serverHintNextcloud')),
      field('user', this.t('user'), { type: 'text' }),
      field('password', this.t('password'), { type: 'password' }, this.t('passwordHint')),
      h('div', { class: 'cl-error', role: 'alert' }, st.error || ''),
      h(
        'div',
        { class: 'cl-actions' },
        this.accounts.length
          ? h('button', { type: 'button', class: 'btn', onclick: () => this.cancelSetup() }, this.t('cancel'))
          : '',
        h('button', { type: 'submit', class: 'btn primary cl-connect', disabled: st.busy }, st.busy ? this.t('connecting') : this.t('connect')),
      ),
    );
    return h(
      'div',
      { class: 'cl-setup' },
      h(
        'div',
        { class: 'card cl-setup-card' },
        h('img', { class: 'cl-logo', src: this.ctx.appUrl('icon.svg'), alt: '' }),
        h('h1', { class: 'title' }, this.t('setupTitle')),
        h('p', { class: 'text-2' }, this.t('setupIntro')),
        form,
      ),
    );
  }

  renderBrowser() {
    const { h, icon, i18n } = this.ctx;
    const sel = this.selectedEntry();
    const btn = (cls, ic, label, onclick, disabled = false, showLabel = true) =>
      h('button', { class: `btn subtle ${cls}`, 'aria-label': label, 'data-tip': showLabel ? null : label, disabled, onclick }, icon(ic, { size: 16 }), showLabel ? h('span', { class: 'cl-lbl' }, label) : '');
    const bar = h(
      'div',
      { class: 'toolbar cl-bar', role: 'toolbar' },
      h('button', { class: 'btn subtle cl-account', 'aria-haspopup': 'menu', onclick: (e) => this.accountMenu(e) },
        icon('person_circle', { size: 16 }), h('span', { class: 'cl-account-name' }, this.account?.label || ''), icon('chevron_down', { size: 12 })),
      h('div', { class: 'cl-sep' }),
      btn('cl-up', 'arrow_up', this.t('up'), () => this.up(), this.path === '/', false),
      btn('cl-upload', 'arrow_upload', this.t('upload'), () => this.pickUpload()),
      btn('cl-mkdir', 'folder_add', this.t('newFolder'), () => this.newFolder()),
      btn('cl-download', 'arrow_download', this.t('download'), () => this.download(sel), !sel || sel.dir),
      btn('cl-delete', 'delete', this.t('delete'), () => this.remove(sel), !sel),
      h('div', { style: { flex: '1' } }),
      btn('cl-refresh', 'arrow_sync', this.t('refresh'), () => this.open(this.path), false, false),
    );
    const parts = this.path.split('/').filter(Boolean);
    const crumbs = h('nav', { class: 'cl-crumbs', 'aria-label': this.t('title') });
    crumbs.append(h('button', { class: 'cl-crumb', 'data-path': '/', 'aria-current': parts.length ? null : 'page', onclick: () => this.open('/') }, icon('cloud', { size: 16 }), h('span', null, this.t('home'))));
    parts.forEach((p, i) => {
      const target = `/${parts.slice(0, i + 1).join('/')}`;
      crumbs.append(icon('chevron_right', { size: 12 }), h('button', { class: 'cl-crumb', 'data-path': target, 'aria-current': i === parts.length - 1 ? 'page' : null, onclick: () => this.open(target) }, p));
    });
    const list = h('div', {
      class: 'cl-list',
      role: 'listbox',
      tabindex: 0,
      'aria-label': this.path === '/' ? this.t('home') : parts[parts.length - 1],
      'aria-busy': this.loading ? 'true' : 'false',
    });
    if (this.loading && !this.entries.length) list.append(h('div', { class: 'empty cl-empty' }, this.t('loading')));
    else if (!this.entries.length && !this.error)
      list.append(h('div', { class: 'empty cl-empty' }, icon('folder_open', { size: 40 }), h('div', null, this.t('empty')), h('div', { class: 'caption text-2' }, this.t('emptyHint'))));
    for (const e of this.entries) {
      const isSel = e.path === this.selected;
      list.append(
        h(
          'div',
          {
            class: `cl-row${isSel ? ' selected' : ''}`,
            role: 'option',
            id: `cl-r-${encodeURIComponent(e.path).replace(/[^\w-]/g, '_')}`,
            'aria-selected': isSel ? 'true' : 'false',
            dataset: { path: e.path, dir: e.dir ? '1' : '0' },
            onclick: () => this.select(e.path),
            ondblclick: () => this.activate(e),
            oncontextmenu: (ev) => this.rowMenu(ev, e),
          },
          h('span', { class: 'cl-name' }, icon(e.dir ? 'folder' : this.ctx.ui.fileIcon({ name: e.name, dir: false, isDir: false }) || 'document', { size: 20, filled: e.dir }), h('span', { class: 'cl-text' }, e.name)),
          h('span', { class: 'cl-mtime text-2' }, e.mtime ? `${i18n.formatDate(e.mtime)} ${i18n.formatTime(e.mtime)}` : ''),
          h('span', { class: 'cl-size text-2' }, e.dir ? '' : i18n.formatSize(e.size)),
        ),
      );
    }
    const activeRow = list.querySelector('.cl-row.selected');
    if (activeRow) list.setAttribute('aria-activedescendant', activeRow.id);
    const head = h('div', { class: 'cl-head caption text-2', 'aria-hidden': 'true' }, h('span', null, this.t('name')), h('span', null, this.t('modified')), h('span', null, this.t('size')));
    const status = h('div', { class: 'cl-status caption' },
      h('span', { class: 'text-2' }, this.t(this.entries.length === 1 ? 'items_one' : 'items_other', { count: this.entries.length })),
      this.error ? h('span', { class: 'cl-error', role: 'alert' }, this.error) : '');
    return h('div', { class: 'cl-browser' }, bar, crumbs, h('div', { class: 'cl-table' }, head, list), status);
  }

  renderTransfers() {
    if (!this.transfers.length) return null;
    const { h, icon } = this.ctx;
    const rows = this.transfers.map((tr) => {
      const pct = tr.total ? Math.min(100, Math.round((tr.done / tr.total) * 100)) : tr.status === 'done' ? 100 : 0;
      const text =
        tr.status === 'done' ? (tr.kind === 'download' ? this.t('savedTo', { path: tr.file || '' }) : this.t('done'))
          : tr.status === 'error' ? this.t('failed', { msg: tr.msg || '' })
            : `${this.t(tr.kind === 'download' ? 'downloading' : 'uploading')} · ${pct} %`;
      return h(
        'div',
        { class: `cl-tr ${tr.status}`, dataset: { id: String(tr.id), status: tr.status } },
        icon(tr.kind === 'download' ? 'arrow_download' : 'arrow_upload', { size: 16 }),
        h('div', { class: 'cl-tr-main' },
          h('div', { class: 'cl-tr-name' }, tr.name),
          h('div', { class: 'cl-bar-track', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct), 'aria-label': tr.name },
            h('div', { class: 'cl-bar-fill', style: { transform: `scaleX(${pct / 100})` } })),
          h('div', { class: 'cl-tr-status caption text-2' }, text)),
        tr.status === 'done' && tr.kind === 'download'
          ? h('button', { class: 'btn subtle cl-open', 'aria-label': this.t('openFolder'), 'data-tip': this.t('openFolder'), onclick: () => this.ctx.shell.launch('files', { path: tr.dir }) }, icon('folder_open', { size: 16 }))
          : '',
      );
    });
    return h(
      'section',
      { class: 'cl-transfers', 'aria-label': this.t('transfers') },
      h('div', { class: 'cl-tr-head' }, h('span', { class: 'subtitle' }, this.t('transfers')),
        h('button', { class: 'btn subtle cl-clear', onclick: () => this.clearDone() }, this.t('clearDone'))),
      h('div', { class: 'cl-tr-list' }, rows),
    );
  }

  // ---------------------------------------------------------------- setup
  async connect() {
    const st = this.setup;
    if (!st || st.busy) return;
    st.busy = true;
    st.error = '';
    this.render();
    try {
      const acc = await this.ctx.api.invoke('cloud:addAccount', { kind: st.kind, server: st.server, user: st.user, password: st.password });
      if (this.win.closed) return;
      this.accounts.push(acc);
      this.accountId = acc.id;
      this.setup = null;
      this.mode = 'browser';
      this.saveState();
      this.render();
      await this.open('/');
      this.root.querySelector('.cl-list')?.focus();
    } catch (e) {
      st.busy = false;
      st.error = this.errText(e);
      this.render();
      const bad = { EURL: 'server', EINSECURE: 'server', ENET: 'server', EUSER: 'user', EPASS: 'password', EAUTH: 'password' }[e?.code];
      this.root.querySelector(`#cl-${bad || 'server'}`)?.focus();
    }
  }

  cancelSetup() {
    this.setup = null;
    this.mode = 'browser';
    this.render();
    if (this.accountId) this.open(this.path);
  }

  addAccount() {
    this.setup = null;
    this.mode = 'setup';
    this.render();
    this.root.querySelector('#cl-server')?.focus();
  }

  async accountMenu(e) {
    const items = this.accounts.map((a) => ({ label: a.label, checked: a.id === this.accountId, action: () => this.switchAccount(a.id) }));
    await this.ctx.ui.menu(e, [
      ...items,
      '-',
      { label: this.t('addAccount'), icon: 'person_add', action: () => this.addAccount() },
      { label: this.t('removeAccount'), icon: 'delete', danger: true, action: () => this.removeAccount() },
    ]);
  }

  async switchAccount(id) {
    this.accountId = id;
    this.saveState();
    await this.open('/');
  }

  async removeAccount() {
    const acc = this.account;
    if (!acc) return;
    const ok = await this.ctx.ui.confirm(this.t('removeConfirm', { name: acc.label }), { title: this.t('removeAccount'), okLabel: this.t('delete'), danger: true, parent: this.win });
    if (!ok) return;
    await this.ctx.api.invoke('cloud:removeAccount', acc.id);
    this.accounts = this.accounts.filter((a) => a.id !== acc.id);
    this.accountId = this.accounts[0]?.id || null;
    this.entries = [];
    this.saveState();
    if (this.accountId) await this.open('/');
    else {
      this.mode = 'setup';
      this.render();
    }
  }

  // ---------------------------------------------------------------- browsing
  async open(p) {
    if (!this.accountId) return;
    const token = ++this.listToken;
    const changed = p !== this.path;
    this.loading = true;
    this.error = '';
    if (changed) {
      this.entries = [];
      this.selected = null;
    }
    this.path = p;
    this.render();
    try {
      const res = await this.ctx.api.invoke('cloud:list', this.accountId, p);
      if (token !== this.listToken || this.win.closed) return;
      this.path = res.path;
      this.entries = res.entries || [];
      if (!this.entries.some((e) => e.path === this.selected)) this.selected = null;
    } catch (e) {
      if (token !== this.listToken || this.win.closed) return;
      this.error = this.errText(e);
    }
    this.loading = false;
    this.render();
  }

  up() {
    if (this.path === '/') return;
    const prev = this.path;
    const parent = this.path.split('/').slice(0, -1).join('/') || '/';
    this.open(parent).then(() => {
      if (this.entries.some((e) => e.path === prev)) this.select(prev);
    });
  }

  selectedEntry() {
    return this.entries.find((e) => e.path === this.selected) || null;
  }

  select(p) {
    this.selected = p;
    this.render();
    const row = [...this.root.querySelectorAll('.cl-row')].find((r) => r.dataset.path === p);
    row?.scrollIntoView({ block: 'nearest' });
    if (!this.root.querySelector('.cl-list')?.contains(document.activeElement)) this.root.querySelector('.cl-list')?.focus({ preventScroll: true });
  }

  activate(e) {
    if (!e) return;
    if (e.dir) this.open(e.path).then(() => this.root.querySelector('.cl-list')?.focus());
    else this.download(e);
  }

  async rowMenu(ev, e) {
    ev.preventDefault();
    this.select(e.path);
    await this.ctx.ui.menu(ev, [
      e.dir ? null : { label: this.t('download'), icon: 'arrow_download', action: () => this.download(e) },
      { label: this.t('delete'), icon: 'delete', danger: true, action: () => this.remove(e) },
    ].filter(Boolean));
  }

  onKey(e) {
    if (this.mode !== 'browser' || e.target.closest?.('.dialog-layer, input, textarea')) return;
    const inList = e.target.closest?.('.cl-list');
    if (e.key === 'F5' || (e.ctrlKey && e.key.toLowerCase() === 'r')) {
      e.preventDefault();
      this.open(this.path);
      return;
    }
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      this.newFolder();
      return;
    }
    if ((e.altKey && e.key === 'ArrowUp') || (inList && e.key === 'Backspace')) {
      e.preventDefault();
      this.up();
      return;
    }
    if (!inList) return;
    const i = this.entries.findIndex((x) => x.path === this.selected);
    const move = (n) => {
      if (!this.entries.length) return;
      const j = Math.max(0, Math.min(this.entries.length - 1, n));
      this.select(this.entries[j].path);
    };
    if (e.key === 'ArrowDown') move(i < 0 ? 0 : i + 1);
    else if (e.key === 'ArrowUp') move(i < 0 ? 0 : i - 1);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(this.entries.length - 1);
    else if (e.key === 'Enter') this.activate(this.selectedEntry());
    else if (e.key === 'Delete') this.remove(this.selectedEntry());
    else return;
    e.preventDefault();
  }

  // ---------------------------------------------------------------- actions
  async newFolder() {
    const name = await this.ctx.ui.prompt({
      title: this.t('newFolderTitle'),
      label: this.t('folderName'),
      value: this.t('newFolder'),
      parent: this.win,
      validate: (v) => (!v.trim() ? this.t('nameRequired') : /[/\\]/.test(v) ? this.t('nameInvalid') : this.entries.some((e) => e.name === v.trim()) ? this.t('err_EEXIST') : ''),
    });
    if (name == null || this.win.closed) return;
    try {
      const p = await this.ctx.api.invoke('cloud:mkdir', this.accountId, this.path, name.trim());
      await this.open(this.path);
      this.select(p);
    } catch (e) {
      this.error = this.errText(e);
      this.render();
    }
  }

  async remove(e) {
    if (!e) return;
    const ok = await this.ctx.ui.confirm(this.t(e.dir ? 'deleteFolderConfirm' : 'deleteConfirm', { name: e.name }), {
      title: this.t('deleteTitle'),
      okLabel: this.t('delete'),
      danger: true,
      parent: this.win,
    });
    if (!ok || this.win.closed) return;
    const idx = this.entries.indexOf(e);
    try {
      await this.ctx.api.invoke('cloud:delete', this.accountId, e.path);
      await this.open(this.path);
      const next = this.entries[Math.min(idx, this.entries.length - 1)];
      if (next) this.select(next.path);
    } catch (err) {
      this.error = this.errText(err);
      this.render();
    }
  }

  async pickUpload() {
    const xdg = this.ctx.shell.xdg;
    const files = await this.ctx.ui.filePicker({ mode: 'open', multiple: true, title: this.t('upload'), path: xdg?.documents || xdg?.home, parent: this.win });
    if (!files || this.win.closed) return;
    await this.uploadPaths(Array.isArray(files) ? files : [files]);
  }

  newTransfer(kind, name) {
    const tr = { id: ++this.seq, opId: `cloud-${Date.now()}-${this.seq}`, kind, name, done: 0, total: 0, status: 'run', msg: '', file: '', dir: '' };
    this.transfers.unshift(tr);
    if (this.transfers.length > 30) this.transfers.length = 30;
    this.render();
    return tr;
  }

  onProgress(p) {
    const tr = this.transfers.find((x) => x.opId === p?.opId);
    if (!tr || tr.status !== 'run') return;
    tr.done = p.done || 0;
    tr.total = p.total || 0;
    const row = this.root.querySelector(`.cl-tr[data-id="${tr.id}"]`);
    if (row) {
      const pct = tr.total ? Math.min(100, Math.round((tr.done / tr.total) * 100)) : 0;
      row.querySelector('.cl-bar-fill').style.transform = `scaleX(${pct / 100})`;
      row.querySelector('.cl-bar-track').setAttribute('aria-valuenow', String(pct));
      row.querySelector('.cl-tr-status').textContent = `${this.t(tr.kind === 'download' ? 'downloading' : 'uploading')} · ${pct} %`;
    }
    this.updateWinProgress();
  }

  updateWinProgress() {
    const run = this.transfers.filter((x) => x.status === 'run');
    if (!run.length) return this.win.setProgress?.(null);
    const total = run.reduce((s, x) => s + (x.total || 0), 0);
    const done = run.reduce((s, x) => s + (x.done || 0), 0);
    this.win.setProgress?.(total ? done / total : 0);
  }

  finish(tr, status, extra = {}) {
    Object.assign(tr, { status }, extra);
    if (status === 'done' && tr.total) tr.done = tr.total;
    this.updateWinProgress();
    if (!this.win.closed) this.render();
  }

  clearDone() {
    this.transfers = this.transfers.filter((x) => x.status === 'run');
    this.render();
    this.root.querySelector('.cl-list')?.focus();
  }

  async uploadPaths(paths) {
    const dir = this.path;
    const account = this.accountId;
    for (const file of paths) {
      const name = String(file).split('/').pop();
      const tr = this.newTransfer('upload', name);
      try {
        try {
          await this.ctx.api.invoke('cloud:upload', account, file, dir, { opId: tr.opId });
        } catch (e) {
          if (e?.code !== 'EEXIST') throw e;
          const ok = await this.ctx.ui.confirm(this.t('uploadConflictBody', { name }), { title: this.t('uploadConflictTitle'), okLabel: this.t('replace'), parent: this.win });
          if (!ok) {
            this.finish(tr, 'error', { msg: this.t('canceled') });
            continue;
          }
          await this.ctx.api.invoke('cloud:upload', account, file, dir, { opId: tr.opId, overwrite: true });
        }
        this.finish(tr, 'done');
      } catch (e) {
        this.finish(tr, 'error', { msg: this.errText(e) });
      }
    }
    if (!this.win.closed && this.accountId === account && this.path === dir) await this.open(dir);
  }

  async download(e) {
    if (!e || e.dir) return;
    const tr = this.newTransfer('download', e.name);
    try {
      let res;
      try {
        res = await this.ctx.api.invoke('cloud:download', this.accountId, e.path, { opId: tr.opId });
      } catch (err) {
        if (err?.code !== 'EEXIST') throw err;
        const choice = await this.ctx.ui.dialog({
          title: this.t('conflictTitle'),
          body: this.t('conflictBody', { name: e.name }),
          parent: this.win,
          buttons: [
            { label: this.t('keepBoth'), value: 'keep', primary: true },
            { label: this.t('replace'), value: 'replace' },
            { label: this.t('cancel'), value: null },
          ],
        });
        if (!choice) return this.finish(tr, 'error', { msg: this.t('canceled') });
        res = await this.ctx.api.invoke('cloud:download', this.accountId, e.path, { opId: tr.opId, keepBoth: choice === 'keep', overwrite: choice === 'replace' });
      }
      const file = res.file;
      this.finish(tr, 'done', { file, dir: file.split('/').slice(0, -1).join('/') });
    } catch (err) {
      this.finish(tr, 'error', { msg: this.errText(err) });
    }
  }
}

export default {
  async launch(ctx) {
    const app = new CloudApp(ctx);
    await app.init();
    return {
      onRelaunch() {
        app.win.focus();
      },
    };
  },
};
