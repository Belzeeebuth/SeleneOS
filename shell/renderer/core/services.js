// Shell services exposed to apps as ctx.shell (and importable by core modules).
//   shell.launch(appId, args)        shell.openFile(path, {appId})     shell.openUrl(url)
//   shell.notify({title, body, icon, appId, actions})
//   shell.runAdmin(action, args, {reason, appId}) -> stdout ; shows a UAC prompt, throws code 'ECANCELED' if dismissed
//   shell.lock()  shell.logout()  shell.shutdown()  shell.reboot()  shell.suspend()
//   shell.clipboard.setFiles(paths, 'copy'|'cut')  shell.clipboard.getFiles() -> {paths, mode}|null
//   shell.xdg -> {home, desktop, documents, downloads, pictures, music, videos, trash}
//   shell.settings (see settings.js) ; shell.theme ; shell.sounds ; shell.wm ; shell.registry
//   shell.on('lock'|'unlock'|'files-clipboard', fn)
import { api, env, Emitter } from './api.js';
import { registry } from './registry.js';
import { notify } from './notify.js';
import { settings } from './settings.js';
import { theme } from './theme.js';
import { sounds } from './sounds.js';
import { wm } from './wm.js';
import { h, icon, ui } from './ui.js';
import { i18n, t } from './i18n.js';

const emitter = new Emitter();
let filesClipboard = null;

export const shell = {
  env,
  wm,
  registry,
  settings,
  theme,
  sounds,
  xdg: null,
  on: (ev, fn) => emitter.on(ev, fn),
  emit: (ev, ...a) => emitter.emit(ev, ...a),

  launch: (id, args) => registry.launch(id, args),
  async openFile(path, opts = {}) {
    const st = await api.invoke('fs:stat', path);
    if (st?.dir) return registry.launch('files', { path });
    const win = await registry.openFile(path, opts);
    if (!win) {
      notify({ title: t('shell.noHandlerTitle'), body: t('shell.noHandlerBody', { name: path.split('/').pop() }), icon: 'warning' });
    }
    return win;
  },
  openUrl(url) {
    return registry.launch('browser', { url });
  },
  notify(opts) {
    return notify(opts);
  },

  clipboard: {
    setFiles(paths, mode = 'copy') {
      filesClipboard = { paths: [...paths], mode };
      api.invoke('clipboard:writeText', paths.join('\n')).catch(() => {});
      emitter.emit('files-clipboard', filesClipboard);
    },
    getFiles() {
      return filesClipboard;
    },
    clearFiles() {
      filesClipboard = null;
      emitter.emit('files-clipboard', null);
    },
  },

  // User Account Control style elevation. Admin users in the live session (passwordless sudo)
  // just confirm; otherwise the user's password is requested and verified by sudo.
  async runAdmin(action, args = [], { reason, appId, appName } = {}) {
    let needsPassword = true;
    try {
      needsPassword = await api.invoke('admin:needsPassword');
    } catch {}
    let error = '';
    for (let attempt = 0; attempt < 5; attempt++) {
      const pw = await uacPrompt({ reason, appId, appName, needsPassword, error });
      if (pw === null) {
        const e = new Error(t('uac.canceled'));
        e.code = 'ECANCELED';
        throw e;
      }
      try {
        const res = await api.invoke('admin:run', pw, action, args);
        return res?.stdout ?? res;
      } catch (err) {
        if (err.code === 'EAUTH') {
          error = t('uac.wrongPassword');
          needsPassword = true;
          continue;
        }
        throw err;
      }
    }
    const e = new Error(t('uac.wrongPassword'));
    e.code = 'EAUTH';
    throw e;
  },

  lock() {
    emitter.emit('lock');
  },
  async logout() {
    emitter.emit('logout');
    await api.invoke('session:logout');
  },
  shutdown: () => api.invoke('power:shutdown'),
  reboot: () => api.invoke('power:reboot'),
  suspend: () => api.invoke('power:suspend'),
};

function uacPrompt({ reason, appId, appName, needsPassword, error }) {
  const name = appName || (appId ? registry.name(appId) : t('uac.thisApp'));
  const pw = h('input', { class: 'input', type: 'password', placeholder: t('uac.password'), style: { width: '100%' } });
  const body = h(
    'div',
    { class: 'uac' },
    h(
      'div',
      { class: 'uac-head' },
      icon('shield_keyhole', { size: 28, filled: true }),
      h('div', { class: 'uac-q' }, t('uac.question')),
    ),
    h(
      'div',
      { class: 'uac-app' },
      appId ? h('img', { src: registry.iconUrl(appId), width: 32, height: 32, alt: '' }) : icon('app_generic', { size: 32 }),
      h('div', null, h('div', { class: 'body-strong' }, name), h('div', { class: 'caption text-2' }, t('uac.publisher'))),
    ),
    reason ? h('div', { class: 'caption text-2', style: { margin: '8px 0' } }, reason) : null,
    needsPassword ? h('div', { class: 'field', style: { marginTop: '12px' } }, h('label', null, t('uac.enterPassword', { user: env.user })), pw) : null,
    error ? h('div', { class: 'caption', style: { color: 'var(--danger)' } }, error) : null,
  );
  return ui
    .dialog({
      body,
      className: 'uac-dialog',
      buttons: [
        { label: t('common.yes'), value: 'yes', primary: true },
        { label: t('common.no'), value: null },
      ],
      onOpen: () => needsPassword && setTimeout(() => pw.focus(), 60),
    })
    .then((v) => (v === 'yes' ? pw.value : null));
}

i18n.on('change', () => {});
