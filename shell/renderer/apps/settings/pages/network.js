// Settings > Network & internet: status, Wi-Fi, Ethernet, airplane mode, advanced (adapters + data usage).
import { PAGES } from '../lib/index.js';

// Wi-Fi strength glyph (same drawing as the quick settings flyout): 3 arcs + dot, dimmed above the level.
export function wifiGlyph(pc, signal, secured, size = 20) {
  const level = signal >= 75 ? 4 : signal >= 50 ? 3 : signal >= 25 ? 2 : 1;
  const k = Math.SQRT1_2;
  const arc = (r) => `M${(10 - r * k).toFixed(2)} ${(16.5 - r * k).toFixed(2)}A${r} ${r} 0 0 1 ${(10 + r * k).toFixed(2)} ${(16.5 - r * k).toFixed(2)}`;
  const arcs = [4.6, 8.2, 11.8].map((r, i) => `<path d="${arc(r)}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" opacity="${i < level - 1 ? 1 : 0.3}"/>`).join('');
  const lock = secured ? '<rect x="13.6" y="13.2" width="5.6" height="4.8" rx="1" fill="currentColor"/><path d="M14.7 13.4v-1.2a1.7 1.7 0 0 1 3.4 0v1.2" fill="none" stroke="currentColor" stroke-width="1.1"/>' : '';
  return pc.h('span', { class: 'icon', style: { width: `${size}px`, height: `${size}px` }, html: `<svg viewBox="0 0 20 20" aria-hidden="true">${arcs}<circle cx="10" cy="16.4" r="1.35" fill="currentColor"/>${lock}</svg>` });
}

const isSecured = (n) => !!n.security && n.security !== '--' && n.security !== 'none';

function statusText(pc, st) {
  const { t } = pc;
  if (!st) return t('net.unknown');
  if (st.airplane && st.connectivity === 'none') return t('net.airplaneOn');
  if (st.connectivity === 'full') return t('net.connectedInternet');
  if (st.connectivity === 'limited') return t('net.limited');
  return t('net.notConnected');
}

function primaryTitle(pc, st) {
  const p = st?.primary;
  if (!p || !p.type) return pc.t('net.notConnectedTitle');
  if (p.type === 'wifi') return p.name || pc.t('net.wifi');
  if (p.type === 'ethernet') return pc.t('net.ethernet');
  return p.name || p.type;
}

function heroArt(pc, st) {
  const { h, icon } = pc;
  const p = st?.primary;
  const main = !p?.type ? icon('globe_prohibited', { size: 52 }) : p.type === 'wifi' ? wifiGlyph(pc, p.strength ?? 100, false, 56) : icon('plug_connected', { size: 52 });
  return h('div', { class: 'st-net-art', 'aria-hidden': 'true' }, main, p?.type && st.connectivity === 'full' ? h('span', { class: 'st-net-globe' }, icon('globe', { size: 22 })) : null);
}

// ------------------------------------------------------------------ Network & internet (home)
async function network(pc) {
  const { h, t, kit, api } = pc;
  const root = h('div');
  let st = await pc.tryInvoke('net:status');
  let ip = null;
  const loadIp = async () => {
    if (!st?.primary?.device) return (ip = null);
    const d = await pc.tryInvoke('net:details', st.primary.device);
    ip = d?.ipv4?.[0]?.split('/')[0] || null;
  };
  await loadIp();

  function paint() {
    pc.ui.clear(root);
    if (!st) {
      root.append(kit.infobar({ kind: 'warning', title: t('net.unavailable'), message: t('net.unavailableDesc') }));
      return;
    }
    const p = st.primary || {};
    const hero = h(
      'div',
      { class: 'st-net-hero' },
      heroArt(pc, st),
      h(
        'div',
        { class: 'st-hero-text' },
        h('div', { class: 'st-hero-title' }, primaryTitle(pc, st)),
        h('div', { class: 'st-hero-sub' }, statusText(pc, st)),
        ip ? h('div', { class: 'caption text-2' }, t('net.ipAddress', { ip })) : null,
      ),
      h(
        'div',
        { class: 'st-net-props' },
        p.type
          ? h('button', { class: 'btn subtle', type: 'button', onclick: () => pc.go(p.type === 'wifi' ? 'wifi' : 'ethernet', p.type === 'wifi' ? 'props' : null) }, pc.icon('info', { size: 16 }), h('span', null, t('net.properties')))
          : null,
        h('button', { class: 'btn subtle', type: 'button', onclick: () => pc.go('advancedNetwork') }, pc.icon('data_usage', { size: 16 }), h('span', null, t('net.dataUsage'))),
      ),
    );
    const rows = [];
    const wifiDev = (st.devices || []).find((d) => d.type === 'wifi');
    if (wifiDev || st.wifiHardware) {
      rows.push(
        kit.row({
          icon: 'wifi_1',
          title: PAGES.wifi.title[pc.lang],
          desc: st.wifiEnabled && wifiDev?.connection ? t('net.connectedTo', { name: wifiDev.connection }) : L(pc, PAGES.wifi.desc),
          control: kit.toggle({ value: !!st.wifiEnabled, label: t('net.wifi'), onChange: (v) => api.invoke('net:setWifi', v) }),
          onClick: () => pc.go('wifi'),
        }),
      );
    }
    if ((st.devices || []).some((d) => d.type === 'ethernet')) {
      const eth = st.devices.find((d) => d.type === 'ethernet' && /^connected/.test(d.state)) || st.devices.find((d) => d.type === 'ethernet');
      rows.push(kit.row({ icon: 'plug_connected', title: t('net.ethernet'), desc: /^connected/.test(eth.state) ? t('net.ethConnected') : t('net.ethUnplugged'), onClick: () => pc.go('ethernet') }));
    }
    // Without NetworkManager (read-only status) there is no radio to switch off.
    if (st.managed !== false) rows.push(
      kit.row({
        icon: 'airplane',
        title: t('net.airplane'),
        desc: t('net.airplaneDesc'),
        section: 'airplane',
        control: kit.toggle({ value: !!st.airplane, label: t('net.airplane'), onChange: (v) => api.invoke('net:setAirplane', v) }),
      }),
    );
    rows.push(
      kit.row({ icon: PAGES.advancedNetwork.icon, title: L(pc, PAGES.advancedNetwork.title), desc: L(pc, PAGES.advancedNetwork.desc), onClick: () => pc.go('advancedNetwork') }),
    );
    root.append(hero, kit.group(null, ...rows));
  }
  paint();
  pc.on('net:changed', async (next) => {
    st = next || st;
    await loadIp();
    paint();
  });
  return root;
}

const L = (pc, obj) => pc.L(obj);

// ------------------------------------------------------------------ Wi-Fi
async function wifi(pc) {
  const { h, t, kit, api, ui, icon } = pc;
  let st = await pc.tryInvoke('net:status');
  const root = h('div');
  let list = null;
  let scanning = false;
  let expanded = null; // ssid with its action panel open
  let busy = null; // ssid being connected
  let errFor = null; // { ssid, code, msg }
  let needKey = null; // ssid that asks for a key
  const autoFor = new Map(); // ssid -> "Connect automatically" (checked unless the user unchecked it)

  const scan = async (rescan = true) => {
    scanning = true;
    paintList();
    try {
      list = (await api.invoke('net:wifiList', rescan)) || [];
    } catch (err) {
      list = list || [];
      if (err.code !== 'ENOHANDLER') pc.toastError(err);
    }
    scanning = false;
    paintList();
  };

  const listBox = h('div', { class: 'st-wifi-list' });
  const scanBar = h('div', { class: 'st-scanbar' });

  async function connect(n, password) {
    busy = n.ssid;
    errFor = null;
    paintList();
    try {
      await api.invoke('net:wifiConnect', n.ssid, password || undefined, { autoconnect: autoFor.get(n.ssid) !== false });
      busy = null;
      needKey = null;
      expanded = null;
      st = (await pc.tryInvoke('net:status')) || st;
      await scan(false);
    } catch (err) {
      busy = null;
      const code = err.code === 'EAUTH' || /secrets|password|psk/i.test(err.message) ? 'EAUTH' : err.code;
      if (code === 'EAUTH') needKey = n.ssid;
      errFor = { ssid: n.ssid, code, msg: err.message };
      paintList();
    }
  }

  function netRow(n) {
    const secured = isSecured(n);
    const open = expanded === n.ssid;
    const status = busy === n.ssid ? t('net.connecting') : n.active ? (secured ? t('net.connectedSecured') : t('net.connected')) : secured ? t('net.secured') : t('net.open');
    const wrap = h('div', { class: ['st-expander', open && 'open'] });
    const head = kit.row({
      icon: wifiGlyph(pc, n.signal, secured, 22),
      title: n.ssid,
      desc: h('span', null, status, n.saved && !n.active ? h('span', { class: 'text-3' }, ` · ${t('net.saved')}`) : null),
      onClick: () => {
        expanded = open ? null : n.ssid;
        if (!open && errFor?.ssid === n.ssid) errFor = null;
        paintList();
      },
      chevron: false,
      ariaLabel: `${n.ssid}, ${status}, ${t('net.signal', { n: n.signal })}`,
      className: 'st-exp-head',
      control: n.active ? h('span', { class: 'st-pill accent' }, t('net.connectedShort')) : null,
    });
    wrap.appendChild(head);
    if (!open) return wrap;
    const body = h('div', { class: 'st-exp-body' });
    const form = h('div', { class: 'st-wifi-form' });
    if (n.active) {
      form.append(
        h(
          'div',
          { class: 'row' },
          kit.button(t('net.disconnect'), async (e) => {
            await kit.busy(e.currentTarget, async () => {
              await api.invoke('net:wifiDisconnect').catch(pc.toastError);
              expanded = null;
              await scan(false);
            });
          }),
          kit.button(t('net.properties'), () => pc.go('wifi', 'props')),
          kit.button(t('net.forget'), () => forget(n)),
        ),
      );
    } else if (busy === n.ssid) {
      form.append(h('div', { class: 'progress indeterminate', role: 'progressbar', 'aria-label': t('net.connecting') }, h('div', { class: 'bar' })));
    } else if (needKey === n.ssid) {
      form.append(keyForm(n));
    } else {
      const auto = h('input', { type: 'checkbox', checked: autoFor.get(n.ssid) !== false, onchange: (e) => autoFor.set(n.ssid, e.target.checked) });
      form.append(
        h('label', { class: 'checkbox' }, auto, h('span', null, t('net.connectAuto'))),
        errFor?.ssid === n.ssid ? kit.infobar({ kind: 'error', message: errFor.code === 'ENOTFOUND' ? t('net.notInRange') : t('net.cantConnect', { msg: errFor.msg }) }) : null,
        h(
          'div',
          { class: 'row' },
          kit.button(
            t('net.connect'),
            () => {
              if (secured && !n.saved) {
                needKey = n.ssid;
                paintList();
              } else connect(n);
            },
            { primary: true },
          ),
          n.saved ? kit.button(t('net.forget'), () => forget(n)) : null,
        ),
      );
    }
    body.appendChild(form);
    wrap.appendChild(body);
    return wrap;
  }

  function keyForm(n) {
    const pw = h('input', { class: 'input grow', type: 'password', placeholder: t('net.enterKey'), 'aria-label': t('net.enterKey'), autocomplete: 'off' });
    const show = h(
      'button',
      { class: 'btn subtle icon-btn', type: 'button', 'aria-label': t('net.showKey'), 'data-tip': t('net.showKey'), onclick: () => (pw.type = pw.type === 'password' ? 'text' : 'password') },
      icon('eye', { size: 16 }),
    );
    const go = () => {
      if (!pw.value) return pw.focus();
      connect(n, pw.value);
    };
    pw.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        go();
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        needKey = null;
        errFor = null;
        paintList();
      }
    });
    setTimeout(() => pw.isConnected && pw.focus(), 40);
    return h(
      'div',
      { class: 'col', style: { gap: '10px' } },
      h('div', { class: 'caption text-2' }, t('net.keyPrompt')),
      h('div', { class: 'row' }, pw, show),
      errFor?.ssid === n.ssid ? kit.infobar({ kind: 'error', message: errFor.code === 'EAUTH' ? t('net.wrongKey') : t('net.cantConnect', { msg: errFor.msg }) }) : null,
      h(
        'div',
        { class: 'row' },
        kit.button(t('common.next'), go, { primary: true }),
        kit.button(t('common.cancel'), () => {
          needKey = null;
          errFor = null;
          expanded = null;
          paintList();
        }),
      ),
    );
  }

  async function forget(n) {
    const ok = await ui.confirm(t('net.forgetConfirm', { name: n.ssid }), { title: t('net.forget'), okLabel: t('net.forget'), parent: pc.win });
    if (!ok) return;
    try {
      await api.invoke('net:wifiForget', n.ssid);
      expanded = null;
      await scan(false);
      knownExp?.rebuild();
    } catch (err) {
      pc.toastError(err);
    }
  }

  // "Wi-Fi" row description: follows the radio and the connection (net:changed, the toggle).
  const headDesc = h('span');
  function paintHead() {
    const conn = (st?.devices || []).find((d) => d.type === 'wifi' && d.connection);
    headDesc.textContent = !st?.wifiEnabled ? t('net.wifiDesc') : conn ? t('net.connectedTo', { name: conn.connection }) : t('net.notConnectedTitle');
  }

  function paintList() {
    paintHead();
    scanBar.classList.toggle('on', scanning);
    ui.clear(listBox);
    if (!st?.wifiEnabled) {
      listBox.append(h('div', { class: 'st-sub text-2' }, st?.airplane ? t('net.wifiOffAirplane') : t('net.wifiOff')));
      return;
    }
    if (!list) {
      listBox.append(kit.spinnerRow(t('net.scanning')));
      return;
    }
    if (!list.length) {
      listBox.append(h('div', { class: 'st-sub text-2' }, scanning ? t('net.scanning') : t('net.noNetworks')));
      return;
    }
    listBox.append(h('div', { class: 'st-group-rows' }, list.map(netRow)));
  }

  async function hiddenDialog() {
    const name = h('input', { class: 'input', placeholder: t('net.ssid'), 'aria-label': t('net.ssid'), maxLength: 32 });
    const pw = h('input', { class: 'input', type: 'password', placeholder: t('net.keyOptional'), 'aria-label': t('net.keyOptional') });
    const err = h('div', { class: 'field-hint error' });
    const body = h('div', { class: 'st-form' }, h('div', { class: 'field' }, h('label', null, t('net.ssid')), name), h('div', { class: 'field' }, h('label', null, t('net.securityKey')), pw), err);
    const v = await ui.dialog({
      title: t('net.hiddenTitle'),
      body,
      parent: pc.win,
      buttons: [
        { label: t('net.connect'), value: 'ok', primary: true },
        { label: t('common.cancel'), value: null },
      ],
      onOpen: (dlg) => {
        dlg._validate = () => {
          if (!name.value.trim()) {
            err.textContent = t('net.ssidRequired');
            return false;
          }
          return true;
        };
      },
    });
    if (v !== 'ok') return;
    try {
      await api.invoke('net:wifiConnect', name.value.trim(), pw.value || undefined, { hidden: true });
      pc.toast(t('net.connectedTo', { name: name.value.trim() }));
      await scan(false);
    } catch (e) {
      pc.toastError(e.code === 'EAUTH' ? new Error(t('net.wrongKey')) : e);
    }
  }

  let knownExp = null;
  function paint() {
    ui.clear(root);
    if (!st || !((st.devices || []).some((d) => d.type === 'wifi') || st.wifiHardware)) {
      root.append(kit.infobar({ kind: 'info', title: t('net.noWifiTitle'), message: t('net.noWifi') }));
      return;
    }
    const wifiToggle = kit.toggle({
      value: !!st.wifiEnabled,
      label: t('net.wifi'),
      onChange: async (v) => {
        await api.invoke('net:setWifi', v);
        st = { ...st, wifiEnabled: v };
        list = v ? null : [];
        paintList();
        if (v) scan(true);
      },
    });
    const refresh = h('button', { class: 'btn subtle icon-btn', type: 'button', 'aria-label': t('common.refresh'), 'data-tip': t('common.refresh'), onclick: () => scan(true) }, icon('arrow_clockwise', { size: 16 }));
    const avail = h('div', { class: 'st-expander open' }, kit.row({ icon: 'wifi_settings', title: t('net.available'), className: 'st-exp-head', control: refresh }), h('div', { class: 'st-exp-body' }, scanBar, h('div', { style: { padding: '8px' } }, listBox)));
    knownExp = kit.expander({
      icon: 'list',
      title: t('net.known'),
      desc: t('net.knownDesc'),
      section: 'known',
      body: async () => {
        const known = (await pc.tryInvoke('net:known')) || [];
        if (!known.length) return h('div', { class: 'st-sub text-2' }, t('net.noKnown'));
        return h(
          'div',
          null,
          known.map((k) =>
            kit.subRow({
              icon: 'wifi_1',
              title: k.ssid,
              control: kit.button(t('net.forget'), () => forget({ ssid: k.ssid })),
            }),
          ),
        );
      },
    });
    const props = kit.expander({
      icon: 'info',
      title: t('net.hwProps'),
      desc: t('net.hwPropsDesc'),
      section: 'props',
      open: pc.section === 'props',
      body: async () => {
        const dev = (st.devices || []).find((d) => d.type === 'wifi');
        const d = dev ? await pc.tryInvoke('net:details', dev.device) : null;
        return detailsKv(pc, d, true);
      },
    });
    root.append(
      kit.group(
        null,
        kit.row({
          icon: 'wifi_1',
          title: t('net.wifi'),
          desc: headDesc,
          control: wifiToggle,
        }),
        avail,
      ),
      kit.group(
        t('net.more'),
        knownExp,
        kit.row({ icon: 'wifi_lock', title: t('net.hidden'), desc: t('net.hiddenDesc'), section: 'hidden', control: kit.button(t('net.addNetwork'), () => hiddenDialog()) }),
        props,
      ),
    );
    paintList();
  }
  paint();
  if (st?.wifiEnabled) scan(true);
  pc.on('net:changed', (next) => {
    if (!next) return;
    const wasOn = st?.wifiEnabled;
    st = next;
    if (wasOn !== next.wifiEnabled) {
      list = next.wifiEnabled ? null : [];
      paint();
      if (next.wifiEnabled) scan(true);
    } else if (!busy) scan(false);
  });
  pc.every(30000, () => st?.wifiEnabled && !busy && !needKey && scan(false));
  return root;
}

// Key/value list of an adapter's details (+ Copy).
function detailsKv(pc, d, wifiInfo = false) {
  const { h, t, kit, api, icon } = pc;
  if (!d) return h('div', { class: 'st-sub text-2' }, t('net.noDetails'));
  const rows = [];
  const add = (k, v) => v != null && v !== '' && (!Array.isArray(v) || v.length) && rows.push([k, Array.isArray(v) ? v.join(', ') : String(v)]);
  if (wifiInfo) {
    add(t('net.ssid'), d.ssid);
    add(t('net.protocol'), d.freq ? (d.freq >= 5900 ? 'Wi-Fi 6E' : d.freq >= 4900 ? '5 GHz' : '2.4 GHz') : null);
    add(t('net.securityType'), d.security || (d.ssid ? t('net.open') : null));
    add(t('net.channel'), d.chan);
    add(t('net.linkSpeed'), d.rate);
  } else {
    add(t('net.connectionName'), d.connection);
    add(t('net.linkSpeed'), d.speed ? `${d.speed >= 1000 ? `${d.speed / 1000} Gbps` : `${d.speed} Mbps`}` : null);
  }
  add(t('net.ipv4'), d.ipv4);
  add(t('net.gateway4'), d.gateway4);
  add(t('net.dns4'), d.dns4);
  add(t('net.ipv6'), d.ipv6);
  add(t('net.gateway6'), d.gateway6);
  add(t('net.dns6'), d.dns6);
  add(t('net.dnsSuffix'), d.domains);
  add(t('net.mac'), d.mac);
  add(t('net.mtu'), d.mtu);
  add(t('net.device'), d.device);
  const copy = kit.button(t('about.copy'), async (e) => {
    const b = e.currentTarget;
    await api.invoke('clipboard:writeText', rows.map(([k, v]) => `${k}:\t${v}`).join('\n')).catch(pc.toastError);
    b.replaceChildren(icon('checkmark', { size: 16 }), t('about.copied'));
  });
  return h('div', { class: 'st-sub-pad col' }, h('div', { class: 'st-kv' }, rows.flatMap(([k, v]) => [h('div', { class: 'k' }, k), h('div', { class: 'v' }, v)])), h('div', null, copy));
}

// ------------------------------------------------------------------ Ethernet
async function ethernet(pc) {
  const { h, t, kit } = pc;
  const st = await pc.tryInvoke('net:status');
  const eths = (st?.devices || []).filter((d) => d.type === 'ethernet');
  if (!eths.length) return h('div', null, kit.infobar({ kind: 'info', title: t('net.noEthTitle'), message: t('net.noEth') }));
  const blocks = [];
  for (const e of eths) {
    const d = await pc.tryInvoke('net:details', e.device);
    const connected = /^connected/.test(e.state);
    blocks.push(
      kit.group(
        eths.length > 1 ? e.device : null,
        kit.row({
          icon: 'plug_connected',
          title: connected ? e.connection || t('net.ethernet') : t('net.ethernet'),
          desc: connected ? statusText(pc, st) : t('net.ethUnplugged'),
          control: h('span', { class: ['st-pill', connected && 'accent'] }, connected ? t('net.connectedShort') : t('net.disconnected')),
        }),
        kit.expander({ icon: 'info', title: t('net.props'), desc: t('net.propsDesc'), open: true, body: () => detailsKv(pc, d) }),
      ),
    );
  }
  return h('div', null, blocks);
}

// ------------------------------------------------------------------ Advanced network settings
async function advancedNetwork(pc) {
  const { h, t, kit, icon } = pc;
  const root = h('div');
  async function paint() {
    const [st, usage] = await Promise.all([pc.tryInvoke('net:status'), pc.tryInvoke('net:usage')]);
    pc.ui.clear(root);
    const devs = st?.devices || [];
    const adapters = devs.map((d) =>
      kit.row({
        icon: d.type === 'wifi' ? 'wifi_1' : d.type === 'ethernet' ? 'plug_connected' : d.type === 'wwan' ? 'cellular_data_1' : 'globe',
        title: d.type === 'wifi' ? `${t('net.wifi')} (${d.device})` : d.type === 'ethernet' ? `${t('net.ethernet')} (${d.device})` : d.device,
        desc: /^connected/.test(d.state) ? (d.connection ? t('net.connectedTo', { name: d.connection }) : t('net.connectedShort')) : d.state === 'unavailable' ? t('net.unavailableState') : t('net.disconnected'),
        onClick: d.type === 'wifi' ? () => pc.go('wifi', 'props') : d.type === 'ethernet' ? () => pc.go('ethernet') : null,
      }),
    );
    const blocks = [];
    if (adapters.length) blocks.push(kit.group(t('net.adapters'), ...adapters));
    if (usage?.length) {
      const total = usage.reduce((a, u) => a + u.rx + u.tx, 0) || 1;
      const max = Math.max(...usage.map((u) => u.rx + u.tx), 1);
      blocks.push(
        h(
          'section',
          { class: 'st-group' },
          h('h3', { class: 'st-group-title' }, t('net.dataUsage')),
          h(
            'div',
            { class: 'st-group-rows' },
            kit.row({ icon: 'data_usage', title: t('net.totalSinceBoot'), desc: t('net.totalDesc'), control: h('span', { class: 'body-strong' }, pc.fmtSize(total)) }),
            ...usage.map((u) =>
              kit.row({
                icon: u.type === 'wifi' ? 'wifi_1' : 'plug_connected',
                title: `${u.type === 'wifi' ? t('net.wifi') : t('net.ethernet')} (${u.iface})`,
                desc: h(
                  'div',
                  { class: 'st-storage-cat', style: { marginTop: '6px' } },
                  h('div', { class: 'st-bar st-bar-light' }, h('i', { style: { width: `${(((u.rx + u.tx) / max) * 100).toFixed(1)}%` } })),
                  h('span', null, t('net.rxTx', { rx: pc.fmtSize(u.rx), tx: pc.fmtSize(u.tx) })),
                ),
                control: h('span', { class: 'st-row-value' }, pc.fmtSize(u.rx + u.tx)),
              }),
            ),
          ),
        ),
      );
    }
    if (!blocks.length) blocks.push(kit.infobar({ kind: 'info', message: t('net.unavailableDesc') }));
    blocks.push(h('div', null, kit.button(t('common.refresh'), () => paint(), { icon: 'arrow_clockwise' })));
    root.append(...blocks);
  }
  await paint();
  return root;
}

export default { network, wifi, ethernet, advancedNetwork };
