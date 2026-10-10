// Mail settings (a dialog with a navigation list): accounts (edit server settings, remove, add),
// signature per account, reading (remote pictures, trusted senders, dark mode rendering) and
// notifications.
import { store } from './store.js';
import { AccountSetup } from './setup.js';
import { avatarColor, initials, debounce } from './util.js';

export async function openSettings(ctx, app, section = 'accounts', editId = null) {
  const { h, icon, ui, api } = ctx;
  const t = (k, v) => ctx.t(k, v);
  const sections = [
    ['accounts', 'person_accounts', t('settings.accounts')],
    ['signature', 'signature', t('settings.signature')],
    ['reading', 'mail_read', t('settings.reading')],
    ['notifications', 'alert', t('settings.notifications')],
  ];
  let current = section;
  const content = h('div', { class: 'ml-set-content' });
  const navItems = sections.map(([id, ic, label]) =>
    h('button', { class: ['nav-item', 'ml-set-nav', id === current && 'selected'], name: `section-${id}`, dataset: { id }, onclick: () => go(id) }, icon(ic), h('span', null, label)),
  );
  let closeDialog = null;
  const body = h(
    'div',
    { class: 'ml-settings' },
    h('div', { class: 'ml-set-side' }, h('div', { class: 'subtitle ml-set-title' }, t('settings.title')), h('div', { class: 'nav' }, navItems)),
    h('div', { class: 'ml-set-main' }, h('button', { class: 'btn subtle icon-btn ml-set-close', name: 'close-settings', 'aria-label': t('common.close'), 'data-tip': t('common.close'), onclick: () => closeDialog?.(true) }, icon('dismiss')), content),
  );

  function go(id) {
    current = id;
    for (const b of navItems) b.classList.toggle('selected', b.dataset.id === id);
    ui.clear(content);
    const page = { accounts: accountsPage, signature: signaturePage, reading: readingPage, notifications: notificationsPage }[id]();
    page.classList.add('ml-set-page');
    content.appendChild(page);
  }

  const header = (title, sub) => h('div', { class: 'ml-set-head' }, h('div', { class: 'subtitle' }, title), sub ? h('div', { class: 'text-2 caption' }, sub) : null);

  // ------------------------------------------------------------ accounts
  function accountsPage() {
    const page = h('div', null, header(t('settings.accounts'), t('settings.accountsSub')));
    if (!store.storage.secure) {
      page.appendChild(h('div', { class: 'infobar warning ml-storage-warning' }, icon('warning', { filled: true }), h('div', { class: 'grow caption' }, t('settings.insecureStorage'))));
    }
    for (const a of store.accounts) {
      const p = store.preset(a.provider);
      const row = h(
        'div',
        { class: 'card-row ml-acct-row', dataset: { id: a.id } },
        h('span', { class: 'ml-avatar lg', style: { background: avatarColor(a.email) } }, initials(a.name, a.email)),
        h(
          'div',
          { class: 'grow' },
          h('div', { class: 'body-strong ellipsis' }, a.name || a.email),
          h('div', { class: 'caption text-2 ellipsis' }, `${a.email} · ${p.id === 'other' ? a.imap.host : p.name}`),
          a.insecureTransport ? h('div', { class: 'caption ml-warn-text' }, icon('warning', { size: 12 }), t('settings.insecureTransport')) : null,
        ),
        h('button', { class: 'btn', name: 'edit-account', onclick: () => editAccount(a) }, t('settings.edit')),
        h('button', { class: 'btn subtle icon-btn', name: 'remove-account', 'aria-label': t('settings.remove'), 'data-tip': t('settings.remove'), onclick: () => removeAccount(a) }, icon('delete')),
      );
      page.appendChild(row);
    }
    page.appendChild(h('button', { class: 'btn ml-add-account', name: 'add-account', onclick: () => addAccount() }, icon('person_add'), t('nav.addAccount')));
    return page;
  }

  function editAccount(a) {
    ui.clear(content);
    const setup = new AccountSetup(ctx, {
      mode: 'edit',
      account: a,
      onDone: async () => {
        await store.loadAccounts();
        go('accounts');
        app?.refresh?.();
      },
      onCancel: () => go('accounts'),
    });
    const page = h('div', { class: 'ml-set-page ml-set-edit' }, setup.el);
    content.appendChild(page);
  }

  function addAccount() {
    ui.clear(content);
    const setup = new AccountSetup(ctx, {
      mode: 'add',
      onDone: async (acc) => {
        await store.loadAccounts();
        closeDialog?.(true);
        if (acc?.id) app?.switchAccount?.(acc.id);
      },
      onCancel: () => go('accounts'),
    });
    content.appendChild(h('div', { class: 'ml-set-page ml-set-edit' }, setup.el));
  }

  async function removeAccount(a) {
    const ok = await ui.confirm(t('settings.removeConfirm', { email: a.email }), { title: t('settings.removeTitle'), okLabel: t('settings.remove'), danger: true, parent: ctx.win });
    if (!ok) return;
    try {
      await api.invoke('mail:removeAccount', a.id);
      await store.loadAccounts();
      if (!store.accounts.length) {
        closeDialog?.(true);
        return;
      }
      go('accounts');
    } catch (e) {
      ui.alert(e.message, { parent: ctx.win });
    }
  }

  // ------------------------------------------------------------ signature
  function signaturePage() {
    const page = h('div', null, header(t('settings.signature'), t('settings.signatureSub')));
    if (!store.accounts.length) return page;
    let acc = store.account(app?.account?.id) || store.accounts[0];
    const sel = ui.select({ options: store.accounts.map((a) => ({ value: a.id, label: a.email })), value: acc.id, onchange: (v) => load(store.account(v)) });
    sel.name = 'signature-account';
    const area = h('textarea', { class: 'textarea ml-sig-text', name: 'signature', rows: 5, spellcheck: true });
    const status = h('span', { class: 'caption text-2 ml-sig-status' });
    const toggle = ui.toggle({ label: t('settings.useSignature'), onchange: (v) => save({ signatureEnabled: v }) });
    toggle.input.name = 'signature-enabled';
    const save = debounce(async (patch) => {
      try {
        await api.invoke('mail:updateAccount', acc.id, patch);
        await store.loadAccounts();
        acc = store.account(acc.id);
        status.textContent = t('settings.saved');
      } catch (e) {
        status.textContent = e.message;
      }
    }, 400);
    area.addEventListener('input', () => {
      status.textContent = '';
      save({ signature: area.value });
    });
    function load(a) {
      acc = a;
      area.value = a.signature ?? t('compose.defaultSignature');
      toggle.input.checked = a.signatureEnabled !== false;
      area.disabled = a.signatureEnabled === false;
      status.textContent = '';
    }
    toggle.input.addEventListener('change', () => (area.disabled = !toggle.input.checked));
    load(acc);
    page.append(
      store.accounts.length > 1 ? h('div', { class: 'field' }, h('label', null, t('settings.account')), sel) : null,
      h('div', { class: 'card ml-set-card' }, toggle, h('div', { class: 'field', style: { marginTop: '8px' } }, area, h('div', { class: 'row' }, h('span', { class: 'field-hint grow' }, t('settings.signatureHint')), status))),
    );
    return page;
  }

  // ------------------------------------------------------------ reading
  function readingPage() {
    const page = h('div', null, header(t('settings.reading')));
    const radio = (value, label, hint) => {
      const input = h('input', { type: 'radio', name: 'remote-images', value, checked: (store.prefs.remoteImages || 'ask') === value });
      input.addEventListener('change', () => input.checked && store.setPref('remoteImages', value));
      return h('label', { class: 'radio ml-radio' }, input, h('span', null, h('div', null, label), hint ? h('div', { class: 'caption text-2' }, hint) : null));
    };
    const trusted = h('div', { class: 'ml-trusted' });
    const renderTrusted = () => {
      ui.clear(trusted);
      const list = store.prefs.trustedSenders || [];
      if (!list.length) trusted.appendChild(h('div', { class: 'caption text-2' }, t('settings.noTrusted')));
      for (const a of list) {
        trusted.appendChild(
          h(
            'div',
            { class: 'ml-trusted-row' },
            icon('shield_checkmark', { size: 16 }),
            h('span', { class: 'grow ellipsis' }, a),
            h('button', { class: 'btn subtle small', onclick: () => (store.trustSender(a, false), renderTrusted()) }, t('settings.remove')),
          ),
        );
      }
    };
    renderTrusted();
    const adapt = ui.toggle({ checked: !!store.prefs.darkAdapt, label: t('settings.darkAdapt'), onchange: (v) => store.setPref('darkAdapt', v) });
    adapt.input.name = 'dark-adapt';
    page.append(
      h('div', { class: 'card ml-set-card' }, h('div', { class: 'body-strong' }, t('settings.remoteImages')), h('div', { class: 'caption text-2 ml-set-desc' }, t('settings.remoteImagesHint')), radio('ask', t('settings.remoteAsk'), t('settings.remoteAskHint')), radio('always', t('settings.remoteAlways'))),
      h('div', { class: 'card ml-set-card' }, h('div', { class: 'body-strong' }, t('settings.trustedSenders')), trusted),
      h('div', { class: 'card ml-set-card' }, adapt, h('div', { class: 'caption text-2' }, t('settings.darkAdaptHint'))),
    );
    return page;
  }

  // ------------------------------------------------------------ notifications
  function notificationsPage() {
    const page = h('div', null, header(t('settings.notifications')));
    const tg = ui.toggle({
      checked: store.prefs.notifications !== false,
      label: t('settings.showNotifications'),
      onchange: (v) => {
        store.setPref('notifications', v);
        api.invoke('mail:watch', true).catch(() => {});
      },
    });
    tg.input.name = 'notifications';
    page.append(h('div', { class: 'card ml-set-card' }, tg, h('div', { class: 'caption text-2' }, t('settings.notificationsHint'))));
    return page;
  }

  go(current);
  if (editId) {
    const a = store.account(editId);
    if (a) editAccount(a);
  }
  await ui.dialog({
    body,
    parent: ctx.win,
    className: 'ml-settings-dialog',
    buttons: [],
    onOpen: (dlg, close) => {
      closeDialog = close;
    },
  });
  app?.renderNav?.();
}
