// Settings > Accounts: Your info, Sign-in options, Other users.
import { PAGES } from '../lib/index.js';

const RE_USER = /^[a-z_][a-z0-9_-]{0,31}$/;
const RE_FULL_BAD = /[\x00-\x1f\x7f:,=\\]/;
const RESERVED = new Set('root daemon bin sys sync games man lp mail news uucp proxy www-data backup list irc gnats nobody admin sudo adm users'.split(' '));

/** "Hélène Dupont" -> "helene" (first word, ASCII, lowercase) */
export function suggestUsername(full) {
  const first = String(full || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .split(/\s+/)[0]
    .replace(/[^a-z0-9_-]/g, '');
  const v = /^[a-z_]/.test(first) ? first : first ? `u${first}` : '';
  return v.slice(0, 32);
}

async function me(pc) {
  return (await pc.tryInvoke('users:current')) || { name: pc.env.user, fullName: pc.env.user };
}

function accountType(pc, u) {
  return u?.admin ? pc.t('acc.admin') : pc.t('acc.standard');
}

function avatar(pc, u, size) {
  const el = pc.h('div', { class: 'st-avatar', 'aria-hidden': 'true' });
  pc.paintAvatar(el, u, size);
  return el;
}

// Dialog that stays open while an async submit runs and shows its errors inline.
function formDialog(pc, { title, body, okLabel, submit, focus }) {
  const { h, t, ui } = pc;
  const err = h('div', { class: 'field-hint error', role: 'alert' });
  const wrap = h('div', { class: 'st-form' }, body, err);
  return ui.dialog({
    title,
    body: wrap,
    parent: pc.win,
    buttons: [
      { label: okLabel, value: 'ok', primary: true },
      { label: t('common.cancel'), value: null },
    ],
    onOpen: (dlg, done) => {
      let running = false;
      const okBtn = dlg.querySelector('.dialog-footer .btn.primary');
      dlg._validate = (v) => {
        if (v !== 'ok') return true;
        if (running) return false;
        running = true;
        err.textContent = '';
        okBtn.disabled = true;
        Promise.resolve()
          .then(() => submit({ setError: (m) => (err.textContent = m) }))
          .then((res) => {
            running = false;
            okBtn.disabled = false;
            if (res !== false) {
              dlg._validate = null;
              done('ok');
            }
          })
          .catch((e) => {
            running = false;
            okBtn.disabled = false;
            if (e?.code === 'ECANCELED') return;
            err.textContent = e?.message || String(e);
          });
        return false;
      };
      wrap.addEventListener('input', () => (err.textContent = ''));
      // never steal the focus from a field the user already went to
      if (focus) setTimeout(() => !wrap.contains(document.activeElement) && focus.focus(), 60);
    },
  });
}

function field(pc, label, input, hint) {
  return pc.h('div', { class: 'field' }, pc.h('label', null, label), input, hint ? pc.h('div', { class: 'field-hint' }, hint) : null);
}

// ------------------------------------------------------------------ Accounts home
async function accounts(pc) {
  const { h, t, kit, L } = pc;
  const u = await me(pc);
  return h(
    'div',
    null,
    h(
      'div',
      { class: 'st-account-hero' },
      avatar(pc, u, 96),
      h('div', { class: 'st-hero-text' }, h('div', { class: 'st-hero-title' }, u.fullName || u.name), h('div', { class: 'st-hero-sub' }, t('settings.localAccount')), h('div', { class: 'st-hero-sub' }, accountType(pc, u))),
    ),
    kit.group(t('acc.settings'), ...['yourInfo', 'signIn', 'users'].map((id) => kit.row({ icon: PAGES[id].icon, title: L(PAGES[id].title), desc: L(PAGES[id].desc), onClick: () => pc.go(id) }))),
  );
}

// ------------------------------------------------------------------ Your info
async function cropToPng(pc, path) {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = pc.api.mediaUrl(path);
  await img.decode();
  const s = 448;
  const c = document.createElement('canvas');
  c.width = s;
  c.height = s;
  const g = c.getContext('2d');
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  g.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, s, s);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  if (!blob) throw new Error(pc.t('acc.pictureError'));
  return new Uint8Array(await blob.arrayBuffer());
}

async function yourInfo(pc) {
  const { h, t, kit, api, ui } = pc;
  const u = await me(pc);
  const adm = await pc.adminStatus();
  const choose = async () => {
    const p = await ui.filePicker({ mode: 'open', title: t('acc.choosePicture'), path: pc.shell.xdg?.pictures, filters: [{ name: t('pers.images'), ext: ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif'] }], parent: pc.win });
    if (!p) return;
    try {
      await api.invoke('users:setPicture', await cropToPng(pc, p));
      pc.refresh();
    } catch (err) {
      pc.toastError(err);
    }
  };
  const editName = async () => {
    const input = h('input', { class: 'input', value: u.fullName || '', maxLength: 128, 'aria-label': t('acc.fullName') });
    const v = await formDialog(pc, {
      title: t('acc.editName'),
      okLabel: t('common.save'),
      body: field(pc, t('acc.fullName'), input),
      focus: input,
      submit: async () => {
        const name = input.value.trim();
        if (!name || RE_FULL_BAD.test(name)) throw new Error(t('acc.fullNameInvalid'));
        await pc.runAdmin('user-set-fullname', [u.name, name], 'acc.reasonName');
      },
    });
    if (v === 'ok') pc.refresh();
  };
  return h(
    'div',
    null,
    h('div', { class: 'st-account-hero', dataset: { section: 'picture' } }, avatar(pc, u, 120), h('div', { class: 'st-hero-text' }, h('div', { class: 'st-hero-title' }, u.fullName || u.name), h('div', { class: 'st-hero-sub' }, u.name), h('div', { class: 'st-hero-sub' }, `${t('settings.localAccount')} · ${accountType(pc, u)}`))),
    kit.group(
      t('acc.adjustPhoto'),
      kit.row({ icon: 'image', title: t('acc.chooseFile'), desc: t('acc.chooseFileDesc'), control: kit.button(t('acc.browse'), choose) }),
      u.picture
        ? kit.row({
            icon: 'delete',
            title: t('acc.removePicture'),
            control: kit.button(t('common.remove'), async () => {
              await api.invoke('users:removePicture').catch(pc.toastError);
              pc.refresh();
            }),
          })
        : null,
    ),
    kit.group(
      t('acc.accountSettings'),
      kit.row({ icon: 'person_edit', title: t('acc.fullName'), desc: u.fullName || u.name, section: 'name', control: kit.button(t('common.edit'), editName, { icon: adm?.isAdmin ? null : 'shield_keyhole' }) }),
      kit.row({ icon: 'person', title: t('acc.username'), desc: t('acc.usernameDesc'), control: h('span', { class: 'st-row-value mono' }, u.name) }),
      kit.row({ icon: 'shield_person', title: t('acc.type'), desc: t('acc.typeDesc'), control: h('span', { class: 'st-pill' }, accountType(pc, u)) }),
    ),
    kit.related([{ icon: 'key', title: pc.pageTitle('signIn'), desc: pc.L(PAGES.signIn.desc), onClick: () => pc.go('signIn') }]),
  );
}

// ------------------------------------------------------------------ Sign-in options
async function passwordDialog(pc, { own, user }) {
  const { h, t } = pc;
  const cur = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', 'aria-label': t('acc.currentPassword') });
  const pw = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', 'aria-label': t('acc.newPassword') });
  const pw2 = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', 'aria-label': t('acc.confirmPassword') });
  const body = h('div', null, own ? field(pc, t('acc.currentPassword'), cur) : h('div', { class: 'text-2', style: { marginBottom: '12px' } }, t('acc.resetFor', { name: user.fullName || user.name })), field(pc, t('acc.newPassword'), pw), field(pc, t('acc.confirmPassword'), pw2));
  return formDialog(pc, {
    title: own ? t('acc.changePassword') : t('acc.resetPassword'),
    okLabel: own ? t('acc.change') : t('acc.reset'),
    body,
    focus: own ? cur : pw,
    submit: async () => {
      if (!pw.value) throw new Error(t('acc.pwEmpty'));
      if (pw.value !== pw2.value) throw new Error(t('acc.pwMismatch'));
      if (own) {
        try {
          await pc.api.invoke('users:changePassword', cur.value, pw.value);
        } catch (err) {
          if (err.code === 'EAUTH') throw new Error(t('acc.pwWrong'));
          if (err.code === 'EWEAK') throw new Error(t('acc.pwWeak', { msg: err.message }));
          throw err;
        }
      } else await pc.runAdmin('set-password', [user.name, pw.value], 'acc.reasonPassword', { name: user.name });
    },
  });
}

async function signIn(pc) {
  const { h, t, kit } = pc;
  const [u, adm, sec] = await Promise.all([me(pc), pc.adminStatus(), pc.tryInvoke('admin:securityStatus')]);
  const rows = [
    kit.expander({
      icon: 'password',
      title: t('acc.password'),
      desc: t('acc.passwordDesc'),
      section: 'password',
      open: pc.section === 'password',
      body: () =>
        kit.subRow({
          title: t('acc.passwordChangeTitle'),
          desc: t('acc.passwordChangeDesc'),
          control: kit.button(t('acc.change'), async () => {
            if ((await passwordDialog(pc, { own: true, user: u })) === 'ok') pc.toast(t('acc.pwChanged'));
          }),
        }),
    }),
  ];
  const extra = [];
  if (sec && !adm?.live) {
    const on = sec.autologin === u.name;
    extra.push(
      kit.row({
        icon: 'person_key',
        title: t('acc.autologin'),
        desc: sec.autologin && !on ? t('acc.autologinOther', { name: sec.autologin }) : t('acc.autologinDesc'),
        section: 'autologin',
        control: kit.toggle({
          value: on,
          label: t('acc.autologin'),
          disabled: !adm?.isAdmin,
          onChange: async (v) => {
            await pc.runAdmin('set-autologin', [v ? u.name : 'none'], v ? 'acc.reasonAutologinOn' : 'acc.reasonAutologinOff');
          },
        }),
      }),
    );
  }
  extra.push(kit.row({ icon: 'lock_closed', title: t('acc.lockAfter'), desc: t('acc.lockAfterDesc'), onClick: () => pc.go('power', 'lock') }));
  return h('div', null, kit.group(t('acc.waysToSignIn'), ...rows), kit.group(t('acc.additional'), ...extra), adm?.live ? kit.infobar({ kind: 'info', message: t('settings.liveOnly') }) : null);
}

// ------------------------------------------------------------------ Other users
async function addUserDialog(pc, existing) {
  const { h, t } = pc;
  const full = h('input', { class: 'input', maxLength: 128, 'aria-label': t('acc.fullName') });
  const name = h('input', { class: 'input mono', maxLength: 32, autocapitalize: 'off', spellcheck: false, 'aria-label': t('acc.username') });
  const pw = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', 'aria-label': t('acc.password') });
  const pw2 = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', 'aria-label': t('acc.confirmPassword') });
  const admin = h('input', { type: 'checkbox' });
  let nameTouched = false;
  full.addEventListener('input', () => !nameTouched && (name.value = suggestUsername(full.value)));
  name.addEventListener('input', () => (nameTouched = true));
  const body = h(
    'div',
    null,
    h('div', { class: 'text-2', style: { marginBottom: '14px' } }, t('acc.addIntro')),
    field(pc, t('acc.fullName'), full),
    field(pc, t('acc.username'), name, t('acc.usernameHint')),
    field(pc, t('acc.password'), pw),
    field(pc, t('acc.confirmPassword'), pw2),
    h('label', { class: 'checkbox' }, admin, h('span', null, t('acc.makeAdmin'))),
  );
  return formDialog(pc, {
    title: t('acc.addTitle'),
    okLabel: t('acc.create'),
    body,
    focus: full,
    submit: async () => {
      const fn = full.value.trim();
      const un = name.value.trim();
      if (!fn || RE_FULL_BAD.test(fn)) throw new Error(t('acc.fullNameInvalid'));
      if (!RE_USER.test(un)) throw new Error(t('acc.usernameInvalid'));
      if (RESERVED.has(un) || existing.some((u) => u.name === un)) throw new Error(t('acc.usernameTaken', { name: un }));
      if (!pw.value) throw new Error(t('acc.pwEmpty'));
      if (pw.value !== pw2.value) throw new Error(t('acc.pwMismatch'));
      await pc.runAdmin('user-add', [un, fn, admin.checked ? '1' : '0', pw.value], 'acc.reasonAdd', { name: un });
    },
  });
}

async function users(pc) {
  const { h, t, kit, ui } = pc;
  const [list, adm] = await Promise.all([pc.tryInvoke('users:list'), pc.adminStatus()]);
  const all = list || [];
  const others = all.filter((u) => !u.current);
  const canManage = !!adm?.isAdmin;
  const blocks = [];
  if (!canManage) blocks.push(kit.infobar({ kind: 'warning', title: t('acc.notAdminTitle'), message: t('acc.notAdmin') }));
  if (adm?.live) blocks.push(kit.infobar({ kind: 'info', message: t('settings.liveOnly') }));
  blocks.push(
    kit.group(
      t('acc.otherUsers'),
      kit.row({
        icon: 'person_add',
        title: t('acc.addOther'),
        desc: t('acc.addOtherDesc'),
        control: kit.button(t('acc.addAccount'), async () => {
          if ((await addUserDialog(pc, all)) === 'ok') {
            pc.toast(t('acc.added'));
            pc.refresh();
          }
        }, { primary: true, disabled: !canManage }),
      }),
      ...(others.length ? others.map((u) => userExpander(pc, u, canManage)) : [h('div', { class: 'st-row' }, h('span', { class: 'text-2' }, t('acc.noOthers')))]),
    ),
  );
  pc.on('users:changed', () => pc.refresh());
  return h('div', null, blocks);
}

function userExpander(pc, u, canManage) {
  const { h, t, kit, ui } = pc;
  const changeType = async () => {
    const combo = kit.combo({
      options: [
        { value: '0', label: t('acc.standard') },
        { value: '1', label: t('acc.admin') },
      ],
      value: u.admin ? '1' : '0',
      label: t('acc.type'),
      width: 220,
    });
    const v = await formDialog(pc, {
      title: t('acc.changeType'),
      okLabel: t('common.ok'),
      body: h('div', null, h('div', { class: 'text-2', style: { marginBottom: '12px' } }, u.fullName || u.name), field(pc, t('acc.type'), combo)),
      submit: async () => {
        const want = combo.getValue();
        if (want === (u.admin ? '1' : '0')) return;
        await pc.runAdmin('user-set-admin', [u.name, want], 'acc.reasonType', { name: u.name });
      },
    });
    if (v === 'ok') pc.refresh();
  };
  const remove = async () => {
    const v = await ui.dialog({
      title: t('acc.removeTitle', { name: u.fullName || u.name }),
      body: t('acc.removeBody'),
      parent: pc.win,
      buttons: [
        { label: t('acc.deleteAll'), value: 'all', danger: true },
        { label: t('acc.keepFiles'), value: 'keep' },
        { label: t('common.cancel'), value: null },
      ],
    });
    if (!v) return;
    try {
      await pc.runAdmin('user-delete', [u.name, v === 'keep' ? '1' : '0'], 'acc.reasonRemove', { name: u.name });
      pc.toast(t('acc.removed', { name: u.fullName || u.name }));
      pc.refresh();
    } catch (err) {
      pc.toastError(err);
    }
  };
  const av = h('span', { class: 'st-user-row-avatar' }, avatar(pc, u, 32));
  return kit.expander({
    icon: av,
    title: u.fullName || u.name,
    desc: `${u.name} · ${accountType(pc, u)}`,
    body: () =>
      h(
        'div',
        null,
        kit.subRow({ title: t('acc.accountOptions'), control: kit.button(t('acc.changeType'), changeType, { disabled: !canManage }) }),
        kit.subRow({
          title: t('acc.passwordOf'),
          control: kit.button(
            t('acc.resetPassword'),
            async () => {
              if ((await passwordDialog(pc, { own: false, user: u })) === 'ok') pc.toast(t('acc.pwReset', { name: u.name }));
            },
            { disabled: !canManage },
          ),
        }),
        kit.subRow({ title: t('acc.accountData'), desc: t('acc.accountDataDesc'), control: kit.button(t('common.remove'), remove, { disabled: !canManage }) }),
      ),
  });
}

export default { accounts, yourInfo, signIn, users };
