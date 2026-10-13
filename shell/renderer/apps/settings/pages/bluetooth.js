// Settings > Bluetooth et appareils — the Bluetooth part (backend: main/ipc/bluetooth.js).
// The adapter switch, « Mes appareils » (paired: connect / disconnect / oublier), « Appareils à proximité »
// (« Rechercher des appareils », pair). Pairing questions (code to compare, PIN) are asked by the shell's
// pairing dialog (core/features/bluetooth.js), so they also show up when Paramètres is closed.
// While this page is open, phones can find the computer (bluetooth:visible, like GNOME / Windows).
export const KIND_ICONS = {
  headphones: 'headphones',
  headset: 'headphones',
  speaker: 'speaker-high',
  mouse: 'cursor',
  keyboard: 'keyboard',
  gamepad: 'game-controller',
  phone: 'device-mobile',
  computer: 'laptop',
  tablet: 'device-tablet',
  printer: 'printer',
  camera: 'camera',
  display: 'desktop',
  input: 'keyboard',
  other: 'bluetooth',
};

export function batteryIcon(n) {
  return n >= 90 ? 'battery-full' : n >= 60 ? 'battery-high' : n >= 30 ? 'battery-medium' : 'battery-low';
}

// subRows: the other device pages (souris, saisie, imprimantes) shown under the Bluetooth part.
export async function bluetoothPage(pc, subRows = []) {
  const { h, t, kit, icon, api } = pc;
  pc.ui.loadCss('app://shell/apps/settings/pages/bluetooth.css');
  const root = h('div', { class: 'st-bt' });
  let st = (await pc.tryInvoke('bluetooth:status')) || { available: false, reason: 'nohelper', devices: [] };
  const busy = new Set(); // addresses with an action running
  let searchedOnce = false;

  // BlueZ's own (English) text only goes to the log: the person gets a sentence in their language.
  const errText = (e, name) => {
    const code = e?.code;
    if (code === 'EREJECTED' || code === 'ECANCELED') return t('bt.errRejected', { name });
    if (code === 'EAUTH') return t('bt.errAuth', { name });
    if (code === 'ETIMEDOUT') return t('bt.errTimeout', { name });
    if (code === 'EHARDBLOCK') return t('bt.hardBlocked');
    if (code === 'ECONNECT') return t('bt.errConnect', { name });
    if (code === 'ENOTREADY') return t('bt.errNotReady');
    if (code === 'EINPROGRESS') return t('bt.errInProgress');
    if (code === 'ERFKILL') return t('bt.errRfkill');
    if (code === 'ENOADAPTER') return t('dev.btNone');
    if (code === 'ENOSERVICE' || code === 'ENOTSUP' || code === 'EHELPER') return t('bt.service');
    console.warn('[bluetooth]', code || '', e?.message || String(e));
    return name ? t('bt.errGenericNamed', { name }) : t('bt.errGenericPlain');
  };
  const act = async (address, name, fn) => {
    busy.add(address);
    render();
    try {
      await fn();
    } catch (e) {
      pc.toast?.(errText(e, name), 'error') ?? pc.toastError(e);
    } finally {
      busy.delete(address);
      render();
    }
  };

  function deviceDesc(d) {
    const parts = [];
    if (d.paired) parts.push(d.connected ? t('bt.connected') : t('bt.notConnected'));
    else parts.push(t(`bt.kind.${d.kind}`));
    // paired devices show their battery in the badge on the right (pairedRow), once
    if (d.battery != null && !d.paired) parts.push(t('bt.battery', { n: d.battery }));
    return parts.join(' · ');
  }
  function deviceIcon(d) {
    return h('span', { class: ['st-bt-ico', d.connected && 'on'] }, icon(KIND_ICONS[d.kind] || 'bluetooth', { size: 20 }));
  }
  function pairedRow(d) {
    const working = busy.has(d.address);
    const btn = d.connected
      ? kit.button(t('bt.disconnect'), () => act(d.address, d.name, () => api.invoke('bluetooth:disconnect', d.address)))
      : kit.button(t('bt.connect'), () => act(d.address, d.name, () => api.invoke('bluetooth:connect', d.address)), { primary: false });
    const forget = h(
      'button',
      {
        class: 'btn subtle st-bt-forget',
        'aria-label': t('bt.forgetNamed', { name: d.name }),
        'data-tip': t('bt.forget'),
        onclick: async () => {
          const ok = await pc.ui.confirm(t('bt.forgetConfirm', { name: d.name }), { title: t('bt.forgetTitle'), okLabel: t('bt.forget'), danger: true, parent: pc.win });
          if (ok) act(d.address, d.name, () => api.invoke('bluetooth:forget', d.address));
        },
      },
      icon('trash', { size: 16 }),
    );
    if (working) btn.disabled = true;
    const badge = d.battery != null ? h('span', { class: 'st-bt-batt caption', role: 'img', 'aria-label': t('bt.battery', { n: d.battery }), title: t('bt.battery', { n: d.battery }) }, icon(batteryIcon(d.battery), { size: 16 }), `${d.battery} %`) : null;
    return kit.row({ icon: deviceIcon(d), title: d.name, desc: deviceDesc(d), badge, control: h('div', { class: 'st-bt-actions' }, working ? h('span', { class: 'spinner small', role: 'status', 'aria-label': t('bt.working') }) : null, btn, forget), className: 'st-bt-dev', section: `dev-${d.address}` });
  }
  function nearbyRow(d) {
    const working = busy.has(d.address);
    const btn = kit.button(working ? t('bt.pairing') : t('bt.pair'), () =>
      act(d.address, d.name, async () => {
        await api.invoke('bluetooth:pair', d.address);
        pc.toast?.(t('bt.pairedOk', { name: d.name }), 'success');
      }),
    );
    if (working) btn.disabled = true;
    return kit.row({ icon: deviceIcon(d), title: d.name, desc: deviceDesc(d), control: btn, className: 'st-bt-dev', section: `dev-${d.address}` });
  }

  function adapterRow() {
    const desc = !st.available
      ? st.reason === 'noadapter'
        ? t('dev.btNone')
        : t('bt.service')
      : st.blocked === 'hard'
        ? t('bt.hardBlocked')
        : st.powered
          ? st.discoverable
            ? t('bt.visibleDesc', { name: st.name || 'selene' })
            : t('bt.onPlain')
          : t('bt.offDesc');
    return kit.row({
      icon: st.available && st.powered ? 'bluetooth' : 'bluetooth_disabled',
      title: t('dev.bluetooth'),
      desc,
      section: 'bluetooth',
      control: st.available
        ? kit.toggle({
            value: !!st.powered,
            label: t('dev.bluetooth'),
            onChange: async (v) => {
              try {
                await api.invoke('bluetooth:setPowered', v);
              } catch (e) {
                pc.toast?.(errText(e, ''), 'error') ?? pc.toastError(e);
              }
              await reload();
            },
          })
        : h('span', { class: 'st-pill' }, t('dev.btUnavailable')),
    });
  }

  function render() {
    const paired = st.devices.filter((d) => d.paired);
    const nearby = st.devices.filter((d) => !d.paired);
    const on = st.available && st.powered;
    const searchBtn = kit.button(
      st.discovering ? t('bt.stop') : t('bt.search'),
      async () => {
        searchedOnce = true;
        try {
          await api.invoke('bluetooth:scan', !st.discovering);
        } catch (e) {
          pc.toast?.(errText(e, ''), 'error') ?? pc.toastError(e);
        }
        await reload();
      },
      { primary: !st.discovering, icon: st.discovering ? null : 'magnifying-glass' },
    );
    searchBtn.classList.add('st-bt-search');
    const nearbyHead = h(
      'div',
      { class: 'st-bt-head' },
      h('h3', { class: 'st-group-title' }, t('bt.nearby')),
      st.discovering ? h('span', { class: 'st-bt-searching caption', role: 'status' }, h('span', { class: 'spinner small' }), t('bt.searching')) : null,
      searchBtn,
    );
    root.replaceChildren(
      kit.group(null, adapterRow()),
      on
        ? h(
            'div',
            null,
            kit.group(t('bt.mine'), ...(paired.length ? paired.map(pairedRow) : [kit.row({ icon: 'bluetooth', title: t('bt.noDevices'), desc: t('bt.noDevicesDesc') })])),
            h(
              'section',
              { class: 'st-group st-bt-nearby' },
              nearbyHead,
              h(
                'div',
                { class: 'st-group-rows' },
                nearby.length
                  ? nearby.map(nearbyRow)
                  : kit.row({ icon: 'magnifying-glass', title: st.discovering ? t('bt.searchingLong') : searchedOnce ? t('bt.nearbyNone') : t('bt.nearbyIdle'), desc: t('bt.pairHint') }),
              ),
            ),
            paired.some((d) => ['headphones', 'headset', 'speaker'].includes(d.kind)) ? h('p', { class: 'st-bt-note caption' }, t('bt.audioHint')) : null,
          )
        : st.available
          ? kit.infobar({ kind: 'info', title: t('bt.offTitle'), message: st.blocked === 'hard' ? t('bt.hardInfo') : t('bt.offInfo') })
          : null,
      subRows.length ? kit.group(t('dev.devices'), ...subRows) : null,
    );
  }

  async function reload() {
    st = (await pc.tryInvoke('bluetooth:status')) || st;
    render();
  }
  pc.on('bluetooth:changed', (s) => {
    if (!s) return;
    st = s;
    render();
  });
  pc.onDispose(() => {
    if (st.discovering) api.invoke('bluetooth:scan', false).catch(() => {});
    api.invoke('bluetooth:visible', false).catch(() => {});
  });
  // phones can find this computer while the page is open (turned off again by onDispose)
  if (st.available) api.invoke('bluetooth:visible', true).catch(() => {});
  render();
  return root;
}
