// A message in its own window (double-click in the list, or "Open in new window"): the reading
// pane with all its actions. Changes are announced on the store so the main window refreshes.
import { store } from './store.js';
import { Reader } from './reader.js';
import { MailWindowBase } from './base.js';

export class MessageWindow extends MailWindowBase {
  constructor(ctx, ref) {
    super(ctx);
    this.ref = ref; // { accountId, folder, uid, special }
    this.special = ref.special || {};
  }

  async init() {
    const { h, win } = this.ctx;
    win.setSize?.(920, 720);
    win.center?.();
    this.reader = new Reader(this.ctx, this);
    this.snack = h('div', { class: 'ml-snack-host', 'aria-live': 'polite' });
    this.root = h('div', { class: 'ml-root ml-msg-window' }, h('div', { class: 'ml-readpane solo' }, this.reader.el), this.snack);
    win.body.appendChild(this.root);
    win.el.__mailMsg = this;
    const keys = (e) => {
      if (this.ctx.shell.wm.focused?.() !== win || e.defaultPrevented) return;
      if (e.target.closest?.('.dialog-layer:not(.closing)') || e.target.closest?.('input, textarea, [contenteditable="true"]')) return;
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const run = (fn) => {
        e.preventDefault();
        fn();
      };
      if (e.ctrlKey && e.shiftKey && k === 'r') run(() => this.reply('replyAll'));
      else if (e.ctrlKey && !e.shiftKey && k === 'r') run(() => this.reply('reply'));
      else if (e.ctrlKey && k === 'f') run(() => this.reply('forward'));
      else if (e.ctrlKey && k === 'q') run(() => this.setSelectedFlags({ seen: true }));
      else if (e.ctrlKey && k === 'u') run(() => this.setSelectedFlags({ seen: false }));
      else if (k === 'Insert' || (e.ctrlKey && e.shiftKey && k === 'g')) run(() => this.setSelectedFlags({ flagged: !this.reader.msg?.flagged }));
      else if (k === 'Delete') run(() => this.deleteSelected());
      else if (k === 'Escape') run(() => win.close());
    };
    document.addEventListener('keydown', keys);
    this.ctx.onClose(() => {
      document.removeEventListener('keydown', keys);
      this.reader.destroy();
    });
    await this.load();
  }

  async load() {
    const { api, win } = this.ctx;
    const r = this.ref;
    this.reader.showLoading({ subject: '' });
    try {
      const msg = await api.invoke('mail:message', r.accountId, r.folder, r.uid);
      this.reader.showMessage(msg);
      win.setTitle(`${msg.subject || this.t('list.noSubject')} - ${this.t('appName')}`);
      this.changed();
    } catch (e) {
      this.reader.showError(e, () => this.load());
    }
  }

  changed() {
    store.emit('changed', { accountId: this.ref.accountId, folder: this.ref.folder });
  }

  folderSpecial() {
    for (const [k, v] of Object.entries(this.special)) if (v === this.ref.folder) return k;
    return String(this.ref.folder).toUpperCase() === 'INBOX' ? 'inbox' : null;
  }

  backToList() {}
  clearSelection() {}

  async reply(mode) {
    const msg = this.reader.msg;
    if (!msg) return;
    const attachments = mode === 'forward' ? await this.forwardAttachments(msg) : [];
    this.ctx.shell.launch('mail', { newWindow: true, compose: { accountId: msg.accountId, mode, original: msg, attachments } });
  }

  async act(op) {
    try {
      await op();
      this.changed();
      this.ctx.win.close(true);
    } catch (e) {
      this.alertError(e);
    }
  }

  async deleteSelected() {
    const { api, ui } = this.ctx;
    const r = this.ref;
    if ((!this.special.trash || this.special.trash === r.folder) && !(await ui.confirm(this.t('act.deleteForeverConfirm', { count: 1 }), { title: this.t('act.deleteForever'), okLabel: this.t('act.delete'), danger: true, parent: this.ctx.win }))) return;
    await this.act(() => api.invoke('mail:delete', r.accountId, r.folder, [r.uid]));
  }

  archiveSelected() {
    const r = this.ref;
    return this.act(() => this.ctx.api.invoke('mail:archive', r.accountId, r.folder, [r.uid]));
  }

  moveToSpecial(kind) {
    const dest = this.special[kind];
    if (!dest) return this.alertError(Object.assign(new Error(this.t('act.noFolder')), { code: 'EINVAL' }));
    const r = this.ref;
    return this.act(() => this.ctx.api.invoke('mail:move', r.accountId, r.folder, [r.uid], dest));
  }

  async moveMenu(e) {
    const { api, ui } = this.ctx;
    const r = this.ref;
    let data;
    try {
      data = await api.invoke('mail:folders', r.accountId);
    } catch (err) {
      return this.alertError(err);
    }
    const items = [];
    const walk = (arr, depth) => {
      for (const n of arr) {
        const label = n.special && this.t(`folder.${n.special}`) !== `folder.${n.special}` ? this.t(`folder.${n.special}`) : n.name;
        if (!n.noselect) items.push({ label: `${' '.repeat(depth)}${label}`, icon: 'folder', disabled: n.path === r.folder, action: () => this.act(() => api.invoke('mail:move', r.accountId, r.folder, [r.uid], n.path)) });
        walk(n.children, depth + 1);
      }
    };
    walk(data.tree, 0);
    await ui.menu(e, [{ header: this.t('act.moveTo') }, ...items]);
  }

  async setSelectedFlags(patch) {
    const r = this.ref;
    try {
      await this.ctx.api.invoke('mail:setFlags', r.accountId, r.folder, [r.uid], patch);
      this.reader.updateFlags(patch);
      this.changed();
    } catch (e) {
      this.alertError(e);
    }
  }
}
