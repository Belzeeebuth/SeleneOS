// Settings > Privacy & security: security overview (firewall, account, device, screen lock) and privacy.
async function privacy(pc) {
  const { h, t, kit, icon, settings } = pc;
  const root = h('div');
  const [adm, u] = await Promise.all([pc.adminStatus(), pc.tryInvoke('users:current')]);
  let sec = await pc.tryInvoke('admin:securityStatus');

  const card = ({ ic, title, status, ok, onClick, section }) =>
    h(
      onClick ? 'button' : 'div',
      { class: 'st-sec-card', type: onClick ? 'button' : null, onclick: onClick || null, dataset: section ? { section } : null },
      h('span', { class: 'st-sec-icon' }, icon(ic, { size: 32 }), h('span', { class: ['st-sec-state', ok ? 'ok' : 'warn'] }, icon(ok ? 'checkmark_circle' : 'warning', { size: 16, filled: true }))),
      h('div', { class: 'body-strong' }, title),
      h('div', { class: 'caption text-2' }, status),
    );

  function paint() {
    pc.ui.clear(root);
    const lock = Number(settings.get('lockTimeout')) || 0;
    const fwOn = !!sec?.firewall?.enabled;
    const aaOn = !!sec?.apparmor?.enabled;
    const lockLabel = lock ? (lock >= 60 ? t('power.h', { count: lock / 60 }) : t('power.m', { count: lock })) : null;
    const cards = h(
      'div',
      { class: 'st-sec-grid' },
      card({ ic: 'shield_globe', title: t('priv.firewall'), status: !sec?.firewall?.available ? t('priv.fwMissing') : fwOn ? t('priv.fwOn') : t('priv.fwOff'), ok: fwOn, onClick: () => root.querySelector('[data-section="firewall"]')?.scrollIntoView({ behavior: 'smooth', block: 'center' }) }),
      card({ ic: 'person_lock', title: t('priv.account'), status: adm?.live ? t('priv.accountLive') : t('priv.accountOk'), ok: !adm?.live, onClick: () => pc.go('signIn', 'password') }),
      card({ ic: 'shield_checkmark', title: t('priv.device'), status: aaOn ? t('priv.deviceOk') : t('priv.deviceOff'), ok: aaOn, onClick: () => root.querySelector('[data-section="device"]')?.toggle?.(true) }),
      card({ ic: 'lock_closed', title: t('priv.screenLock'), status: lock ? t('priv.lockAfter', { time: lockLabel }) : t('priv.lockNever'), ok: !!lock, onClick: () => pc.go('power', 'lock') }),
    );
    const fwToggle = kit.toggle({
      value: fwOn,
      label: t('priv.firewall'),
      disabled: !sec?.firewall?.available || !adm?.isAdmin,
      onChange: async (v) => {
        await pc.runAdmin('firewall', [v ? 'enable' : 'disable'], v ? 'priv.reasonFwOn' : 'priv.reasonFwOff');
        sec = (await pc.tryInvoke('admin:securityStatus')) || sec;
        paint();
      },
    });
    const yes = (b) => (b == null ? t('priv.unknown') : b ? t('common.on') : t('common.off'));
    const deviceRows = [
      [t('priv.apparmor'), sec?.apparmor?.available ? yes(aaOn) : t('priv.notAvailable')],
      [t('priv.firmware'), sec?.uefi == null ? t('priv.unknown') : sec.uefi ? 'UEFI' : t('priv.legacy')],
      [t('priv.secureBoot'), sec?.uefi ? yes(sec.secureBoot) : t('priv.notAvailable')],
      [t('priv.tpm'), sec?.tpm ? t('priv.present') : t('priv.notDetected')],
    ];
    root.append(
      h('div', null, h('div', { class: 'body-large', style: { marginBottom: '4px' } }, t('priv.overview')), h('div', { class: 'text-2', style: { marginBottom: '12px' } }, t('priv.overviewDesc')), cards),
      kit.group(
        t('priv.security'),
        kit.row({
          icon: 'shield_globe',
          title: t('priv.firewall'),
          desc: !sec?.firewall?.available ? t('priv.fwMissing') : t('priv.fwDesc'),
          section: 'firewall',
          control: fwToggle,
        }),
        kit.expander({
          icon: 'shield_checkmark',
          title: t('priv.device'),
          desc: t('priv.deviceDesc'),
          section: 'device',
          body: () => h('div', { class: 'st-kv st-sub-pad' }, deviceRows.flatMap(([k, v]) => [h('div', { class: 'k' }, k), h('div', { class: 'v' }, v)])),
        }),
        kit.row({ icon: 'person_lock', title: t('priv.account'), desc: t('priv.accountDesc'), onClick: () => pc.go('signIn', 'password') }),
      ),
      kit.group(
        t('priv.privacy'),
        kit.settingToggleRow({ icon: 'history', title: t('priv.activity'), desc: t('priv.activityDesc'), key: 'startShowRecent', def: true }),
        kit.row({ icon: 'clipboard_paste', title: t('priv.clipboard'), desc: t('priv.clipboardDesc'), onClick: () => pc.go('clipboard') }),
        kit.row({ icon: 'data_usage', title: t('priv.diagnostics'), desc: t('priv.diagnosticsDesc'), control: h('span', { class: 'st-pill' }, t('priv.noTelemetry')) }),
        kit.row({ icon: 'folder_person', title: t('priv.files'), desc: t('priv.filesDesc') }),
      ),
      adm?.simulated ? kit.infobar({ kind: 'info', message: t('settings.simulated') }) : null,
    );
  }
  paint();
  pc.onDispose(settings.on('lockTimeout', paint));
  return root;
}

export default { privacy };
