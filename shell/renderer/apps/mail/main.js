// Aurora Mail — a Windows 11 "Mail / Outlook"-style e-mail client (IMAP + SMTP).
// Backend: main/ipc/mail.js. Launch arguments:
//   { to, cc, bcc, subject, body } or { mailto: 'mailto:…' }  -> new message (other apps, mailto: links)
//   { open: { accountId, folder, uid } }                       -> open a message (notifications)
//   { compose: <composer snapshot>, newWindow: true }          -> composer in its own window (pop-out)
//   { file: '/path/message.eml' }                              -> read an .eml file
import { store } from './lib/store.js';
import { MailApp } from './lib/app.js';
import { Composer } from './lib/compose.js';
import { Reader } from './lib/reader.js';
import { MessageWindow } from './lib/msgwin.js';
import { trapFocus } from './lib/base.js';
import { parseAddresses, parseMailto } from './lib/util.js';
import { errorText } from './lib/setup.js';

const apps = new Set();
let subscribed = false;
let shared = null; // { t, shell, api } of the first window, for notifications after it closed

function subscribe(ctx) {
  if (subscribed) return;
  subscribed = true;
  shared = { t: ctx.t, shell: ctx.shell, api: ctx.api };
  ctx.api.on('mail:new', (ev) => {
    for (const a of apps) a.onNewMail?.(ev);
    if (store.prefs.notifications === false) return;
    const acc = store.account(ev.accountId);
    const many = ev.count > 1;
    shared.shell.notify({
      appId: 'mail',
      title: many ? shared.t('notify.many', { count: ev.count }) : ev.from || shared.t('reader.unknownSender'),
      body: many ? `${ev.from}: ${ev.subject || shared.t('list.noSubject')}` : ev.subject || shared.t('list.noSubject'),
      onClick: () => shared.shell.launch('mail', { open: { accountId: ev.accountId, folder: ev.folder || 'INBOX', uid: ev.uid } }),
      // Quick actions on a single new message, like Outlook's toasts.
      actions:
        acc && !many && ev.uid
          ? [
              { label: shared.t('act.markRead'), onClick: () => shared.api.invoke('mail:setFlags', ev.accountId, ev.folder || 'INBOX', [ev.uid], { seen: true }).catch(() => {}) },
              { label: shared.t('act.delete'), onClick: () => shared.api.invoke('mail:delete', ev.accountId, ev.folder || 'INBOX', [ev.uid]).catch(() => {}) },
            ]
          : [],
    });
  });
  // mailto: links clicked inside a message body (routed by the shell's main process).
  ctx.api.on('shell:open-mailto', ({ url } = {}) => {
    if (url && /^mailto:/i.test(url)) shared.shell.launch('mail', { mailto: url });
  });
}

// Secondary windows (composer, message, .eml viewer) are Mail windows too: the shell hands them
// "launch Mail" requests (Start menu, taskbar, notifications, mailto: from other apps) when they
// come first in the window list. Forward those to the main window, opening it when needed.
function forwardRelaunch(ctx, next = {}) {
  const main = [...apps].find((a) => a.ctx.win.el.isConnected);
  if (next.file && !next.compose) {
    ctx.shell.launch('mail', { ...next, newWindow: true });
    return;
  }
  if (main) {
    main.ctx.win.focus();
    main.handleArgs(next);
    return;
  }
  ctx.shell.launch('mail', { ...next, newWindow: true, main: true });
}

// A composer in its own window (pop-out, or "new message" from another app with newWindow).
function composeWindow(ctx, snap) {
  const { win, h } = ctx;
  win.setSize?.(820, 680);
  win.center?.();
  const root = h('div', { class: 'ml-root ml-compose-window' });
  win.body.appendChild(root);
  const title = (s) => win.setTitle(`${s || ctx.t('compose.newMessage')} - ${ctx.t('appName')}`);
  const composer = new Composer(ctx, {
    ...snap,
    standalone: true,
    onTitle: title,
    onClose: (reason) => {
      if (reason === 'sent') ctx.shell.notify({ appId: 'mail', title: ctx.t('snack.sent'), body: composer.subject.value || ctx.t('list.noSubject'), timeout: 3000, silent: true });
      win.close(true);
    },
  });
  root.appendChild(composer.el);
  trapFocus(win);
  title(composer.subject.value);
  win.onBeforeClose(async () => composer.close());
  ctx.onLangChange(() => {
    composer.relocalize();
    title(composer.subject.value);
  });
  composer.focus();
  return { composer, onRelaunch: (next) => forwardRelaunch(ctx, next) };
}

// Read-only viewer for .eml files.
async function emlWindow(ctx, file) {
  const { win, h, api, ui } = ctx;
  const root = h('div', { class: 'ml-root ml-eml-window' });
  win.body.appendChild(root);
  const viewer = {
    folderSpecial: () => null,
    backToList() {},
    reply() {},
    deleteSelected() {},
    archiveSelected() {},
    moveMenu() {},
    setSelectedFlags() {},
    moveToSpecial() {},
    async openAttachment(msg, a) {
      try {
        ctx.shell.openFile(await api.invoke('mail:attachment', '@file', file, 0, a.id, { reuse: true }));
      } catch (e) {
        ui.alert(errorText(ctx.t, e).text, { parent: win });
      }
    },
    async saveAttachment(msg, a, { ask } = {}) {
      try {
        let dest = null;
        if (ask) dest = await ui.filePicker({ mode: 'save', name: a.filename, path: ctx.shell.xdg?.downloads, parent: win });
        if (ask && !dest) return;
        const p = await api.invoke('mail:attachment', '@file', file, 0, a.id, dest ? { dest } : {});
        ctx.shell.notify({ appId: 'mail', title: ctx.t('snack.saved', { name: p.split('/').pop() }), body: p, timeout: 4000, silent: true });
      } catch (e) {
        ui.alert(errorText(ctx.t, e).text, { parent: win });
      }
    },
    async saveAllAttachments(msg, list) {
      for (const a of list) await this.saveAttachment(msg, a);
    },
  };
  const reader = new Reader(ctx, viewer);
  root.appendChild(h('div', { class: 'ml-readpane solo' }, reader.el));
  trapFocus(win);
  reader.showLoading({ subject: file.split('/').pop() });
  try {
    const msg = await api.invoke('mail:parseFile', file);
    reader.showMessage(msg);
    win.setTitle(`${msg.subject || file.split('/').pop()} - ${ctx.t('appName')}`);
  } catch (e) {
    reader.showError(e);
  }
  ctx.onLangChange(() => reader.relocalize());
  ctx.onClose(() => reader.destroy());
}

export default {
  async launch(ctx) {
    await store.init(ctx);
    subscribe(ctx);
    const args = ctx.args || {};
    if (args.compose) return composeWindow(ctx, args.compose);
    if (args.read) {
      const w = new MessageWindow(ctx, args.read);
      await w.init();
      return { onRelaunch: (next) => forwardRelaunch(ctx, next) };
    }
    if (args.newWindow && !args.main && (args.to || args.cc || args.subject || args.body || args.mailto)) {
      const pre = args.mailto ? parseMailto(args.mailto) || {} : args;
      return composeWindow(ctx, { accountId: store.prefs.lastAccount, mode: 'new', to: parseAddresses(pre.to), cc: parseAddresses(pre.cc), bcc: parseAddresses(pre.bcc), subject: pre.subject || '', body: pre.body || '' });
    }
    if (args.file) {
      await emlWindow(ctx, args.file);
      return { onRelaunch: (next) => forwardRelaunch(ctx, next) };
    }
    const app = new MailApp(ctx);
    apps.add(app);
    ctx.onClose(() => apps.delete(app));
    await app.init();
    await app.handleArgs(args);
    return {
      app,
      onRelaunch(next = {}) {
        if (next.file) {
          ctx.shell.launch('mail', { ...next, newWindow: true });
          return;
        }
        app.handleArgs(next);
      },
    };
  },
};
