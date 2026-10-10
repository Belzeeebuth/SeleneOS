// Shared by the main window and the single-message windows: localized strings, in-app
// snackbar, error dialogs, attachments (open / save / save all), .eml export and message source.
import { errorText } from './setup.js';

// Tab / Shift+Tab cycle inside the window (inside its open dialog, if any) like a Windows app,
// instead of walking out to the taskbar and the desktop. The end sentinel also catches Tab pressed
// inside the message body: keys typed in that sandboxed frame never reach this document.
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), iframe, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';
export function trapFocus(win) {
  const scope = () => [...win.el.querySelectorAll('.dialog-layer:not(.closing)')].pop() || win.el;
  const items = () =>
    [...scope().querySelectorAll(FOCUSABLE)].filter((el) => el.tabIndex >= 0 && !el.classList.contains('ml-tab-sentinel') && !el.closest('[hidden], [inert]') && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
  const sentinel = document.createElement('span');
  sentinel.className = 'ml-tab-sentinel';
  sentinel.tabIndex = 0;
  sentinel.setAttribute('aria-hidden', 'true');
  sentinel.addEventListener('focus', () => items()[0]?.focus());
  win.body.appendChild(sentinel);
  win.el.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || e.ctrlKey || e.altKey || e.metaKey || e.defaultPrevented) return;
    const list = items();
    if (!list.length) return;
    const inScope = scope().contains(e.target);
    if (e.shiftKey && (e.target === list[0] || !inScope)) {
      e.preventDefault();
      list[list.length - 1].focus();
    } else if (!e.shiftKey && (e.target === list[list.length - 1] || !inScope)) {
      e.preventDefault();
      list[0].focus();
    }
  });
}

export class MailWindowBase {
  constructor(ctx) {
    this.ctx = ctx;
    this.snack = null;
  }

  t(k, v) {
    return this.ctx.t(k, v);
  }

  snackbar(text, ...actions) {
    const { h, icon } = this.ctx;
    if (!this.snack) return;
    const el = h(
      'div',
      { class: 'ml-snack', role: 'status' },
      icon('checkmark_circle', { filled: true, class: 'ml-snack-ic' }),
      h('span', { class: 'grow' }, text),
      ...actions.filter(Boolean).map((a) =>
        h(
          'button',
          {
            class: 'btn subtle small',
            onclick: () => {
              a.action();
              close();
            },
          },
          a.label,
        ),
      ),
      h('button', { class: 'btn subtle icon-btn small', 'aria-label': this.t('common.close'), onclick: () => close() }, icon('dismiss', { size: 12 })),
    );
    const close = () => {
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 200);
    };
    this.snack.replaceChildren(el); // one message at a time, like Outlook
    setTimeout(close, actions.length ? 8000 : 4500);
  }

  async alertError(e) {
    const info = errorText(this.ctx.t, e, this.account?.imap?.host);
    await this.ctx.ui.alert([info.text, info.detail].filter(Boolean).join('\n\n'), { title: info.title || this.t('err.title'), parent: this.ctx.win });
  }

  // ------------------------------------------------------------ attachments
  async openAttachment(msg, a) {
    const { api, shell } = this.ctx;
    try {
      // Saved to Downloads first; opening it again reuses that copy instead of making "name (1).ext".
      const path = await api.invoke('mail:attachment', msg.accountId, msg.folder, msg.uid, a.id, { reuse: true });
      await shell.openFile(path);
    } catch (e) {
      this.alertError(e);
    }
  }

  async saveAttachment(msg, a, { ask = false } = {}) {
    const { api, ui, shell } = this.ctx;
    const t = (k, v) => this.t(k, v);
    try {
      let dest = null;
      if (ask) {
        dest = await ui.filePicker({ mode: 'save', name: a.filename, path: shell.xdg?.downloads, parent: this.ctx.win });
        if (!dest) return;
      }
      const path = await api.invoke('mail:attachment', msg.accountId, msg.folder, msg.uid, a.id, dest ? { dest } : {});
      this.snackbar(t('snack.saved', { name: path.split('/').pop() }), { label: t('snack.openFile'), action: () => shell.openFile(path) }, { label: t('snack.showFolder'), action: () => shell.launch('files', { path: path.replace(/\/[^/]+$/, '') || '/' }) });
      return path;
    } catch (e) {
      this.alertError(e);
      return null;
    }
  }

  async saveAllAttachments(msg, list) {
    const { api, ui, shell } = this.ctx;
    const t = (k, v) => this.t(k, v);
    const dir = await ui.filePicker({ mode: 'folder', path: shell.xdg?.downloads, parent: this.ctx.win });
    if (!dir) return;
    try {
      for (const a of list) await api.invoke('mail:attachment', msg.accountId, msg.folder, msg.uid, a.id, { dir });
      this.snackbar(t('snack.savedAll', { count: list.length }), { label: t('snack.showFolder'), action: () => shell.launch('files', { path: dir }) });
    } catch (e) {
      this.alertError(e);
    }
  }

  async saveAsEml(msg) {
    const { api, ui, shell } = this.ctx;
    const name = `${(msg.subject || this.t('list.noSubject')).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 80)}.eml`;
    const dest = await ui.filePicker({ mode: 'save', name, path: shell.xdg?.documents, filters: [{ name: this.t('reader.emlFile'), ext: ['.eml'] }], parent: this.ctx.win });
    if (!dest) return;
    try {
      await api.invoke('mail:saveSource', msg.accountId, msg.folder, msg.uid, dest);
      this.snackbar(this.t('snack.saved', { name: dest.split('/').pop() }));
    } catch (e) {
      this.alertError(e);
    }
  }

  // Copy the attachments of a message to a private folder so a forward can include them.
  async forwardAttachments(msg) {
    const atts = (msg.attachments || []).filter((a) => !a.inline);
    if (!atts.length) return [];
    const out = [];
    try {
      const dir = await this.ctx.api.invoke('mail:tempDir');
      for (const a of atts) {
        const path = await this.ctx.api.invoke('mail:attachment', msg.accountId, msg.folder, msg.uid, a.id, { dir });
        out.push({ path, filename: a.filename, size: a.size });
      }
    } catch (e) {
      this.alertError(e);
      return [];
    }
    return out;
  }

  async viewSource(msg) {
    const { api, ui, h } = this.ctx;
    try {
      const src = await api.invoke('mail:source', msg.accountId, msg.folder, msg.uid);
      const ta = h('textarea', { class: 'ml-source', readonly: true, spellcheck: false });
      ta.value = src;
      await ui.dialog({ title: this.t('reader.viewSource'), body: ta, parent: this.ctx.win, className: 'ml-source-dialog', width: 760, buttons: [{ label: this.t('common.close'), value: true, primary: true }] });
    } catch (e) {
      this.alertError(e);
    }
  }

}
