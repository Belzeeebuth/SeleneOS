// Network tools: VPN / WireGuard connections (NetworkManager), ping and DNS lookup.
// Backend: main/ipc/nettools.js (mock data in dev/tests). Test hooks: the window body element gets __nettools.
const TABS = ['vpn', 'ping', 'dns'];
const DNS_TYPES = ['A', 'AAAA', 'MX', 'TXT', 'NS', 'CNAME'];

export default {
  async launch(ctx) {
    const { win, h, icon, ui, t, api, shell, storage } = ctx;
    const offs = [];
    let tab = 'vpn';
    try {
      const saved = await storage?.get?.('tab', 'vpn');
      if (TABS.includes(saved)) tab = saved;
    } catch {}
    const errMsg = (e) => String(e?.message || e || '').slice(0, 300);

    // ------------------------------------------------------------ tabs
    const tabBtns = {};
    const panels = {};
    const tabList = h('div', { class: 'tabs nt-tabs', role: 'tablist', 'aria-label': t('tabs.label') });
    for (const id of TABS) {
      tabBtns[id] = h(
        'button',
        {
          class: 'tab',
          role: 'tab',
          id: `nt-tab-${id}`,
          'aria-controls': `nt-panel-${id}`,
          dataset: { tab: id },
          onclick: () => select(id, true),
          onkeydown: (e) => {
            const i = TABS.indexOf(id);
            let next = null;
            if (e.key === 'ArrowRight') next = TABS[(i + 1) % TABS.length];
            else if (e.key === 'ArrowLeft') next = TABS[(i + TABS.length - 1) % TABS.length];
            else if (e.key === 'Home') next = TABS[0];
            else if (e.key === 'End') next = TABS[TABS.length - 1];
            if (next) {
              e.preventDefault();
              select(next, true);
            }
          },
        },
        t(`tabs.${id}`),
      );
      tabList.append(tabBtns[id]);
      panels[id] = h('section', { class: 'nt-panel', role: 'tabpanel', id: `nt-panel-${id}`, 'aria-labelledby': `nt-tab-${id}`, dataset: { panel: id } });
    }
    function select(id, focus) {
      tab = id;
      for (const k of TABS) {
        const on = k === id;
        tabBtns[k].classList.toggle('selected', on);
        tabBtns[k].setAttribute('aria-selected', on ? 'true' : 'false');
        tabBtns[k].tabIndex = on ? 0 : -1;
        panels[k].hidden = !on;
      }
      if (focus) tabBtns[id].focus();
      Promise.resolve()
        .then(() => storage?.set?.('tab', id))
        .catch(() => {});
      if (id === 'vpn') loadVpn();
    }

    // ------------------------------------------------------------ VPN
    const vpnList = h('div', { class: 'nt-vpn-list', role: 'list', 'aria-label': t('vpn.title') });
    const vpnInfo = h('div', { class: 'nt-vpn-info' });
    const importBtn = h('button', { class: 'btn', dataset: { act: 'import' }, onclick: () => pickImport() }, icon('arrow_import'), h('span', null, t('vpn.import')));
    const refreshBtn = h('button', { class: 'btn subtle icon-btn', dataset: { act: 'refresh' }, 'aria-label': t('vpn.refresh'), 'data-tip': t('vpn.refresh'), onclick: () => loadVpn() }, icon('arrow_clockwise'));
    panels.vpn.append(
      h('div', { class: 'nt-toolbar' }, h('h2', { class: 'nt-h2' }, t('vpn.title')), h('div', { class: 'grow' }), importBtn, refreshBtn),
      vpnInfo,
      vpnList,
      h('div', { class: 'caption text-2 nt-later' }, icon('info'), h('span', null, t('vpn.later'))),
    );
    const busy = new Set();
    let vpnItems = [];
    let vpnSeq = 0;
    function infobar(kind, text) {
      vpnInfo.replaceChildren(h('div', { class: `infobar ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, icon(kind === 'error' ? 'error_circle' : kind === 'success' ? 'checkmark_circle' : 'info'), h('span', null, text)));
    }
    async function loadVpn() {
      const seq = ++vpnSeq;
      let res;
      try {
        res = await api.invoke('nettools:vpnList');
      } catch (e) {
        if (seq === vpnSeq && !win.closed) {
          infobar('error', t('vpn.failed', { msg: errMsg(e) }));
          renderVpn();
        }
        return;
      }
      if (seq !== vpnSeq || win.closed) return;
      if (!res.available) infobar('warning', t('vpn.unavailable'));
      importBtn.disabled = !res.available;
      vpnItems = Array.isArray(res.items) ? res.items : [];
      renderVpn();
    }
    function renderVpn() {
      if (!vpnItems.length) {
        vpnList.replaceChildren(h('div', { class: 'empty nt-empty' }, icon('shield_lock'), h('div', { class: 'nt-empty-title' }, t('vpn.empty')), h('div', { class: 'caption text-2' }, t('vpn.emptyHint'))));
        return;
      }
      const focusedUuid = document.activeElement?.closest?.('.nt-vpn')?.dataset.uuid;
      const focusedAct = document.activeElement?.dataset?.act;
      vpnList.replaceChildren(...vpnItems.map(vpnRow));
      if (focusedUuid && focusedAct) vpnList.querySelector(`.nt-vpn[data-uuid="${CSS.escape(focusedUuid)}"] [data-act="${CSS.escape(focusedAct)}"]`)?.focus();
    }
    function vpnRow(c) {
      const working = busy.has(c.uuid);
      const status = working ? t('vpn.working') : c.active ? (c.device ? t('vpn.connectedOn', { device: c.device }) : t('vpn.connected')) : t('vpn.disconnected');
      return h(
        'div',
        { class: ['card-row', 'nt-vpn', c.active && 'active'], role: 'listitem', dataset: { uuid: c.uuid } },
        h('span', { class: 'nt-vpn-icon', 'aria-hidden': 'true' }, icon(c.type === 'wireguard' ? 'shield_lock' : 'lock_closed')),
        h(
          'div',
          { class: 'grow nt-vpn-text' },
          h('div', { class: 'nt-vpn-name' }, c.name),
          h('div', { class: 'caption text-2' }, h('span', { class: 'nt-badge' }, t(c.type === 'wireguard' ? 'vpn.typeWireguard' : 'vpn.typeVpn')), ' · ', h('span', { class: ['nt-status', c.active && 'on'] }, status)),
        ),
        h('button', { class: ['btn', !c.active && 'primary'], dataset: { act: 'toggle' }, disabled: working, onclick: () => toggleVpn(c) }, t(c.active ? 'vpn.disconnect' : 'vpn.connect')),
        h('button', { class: 'btn subtle icon-btn', dataset: { act: 'delete' }, disabled: working, 'aria-label': t('vpn.delete', { name: c.name }), 'data-tip': t('vpn.delete', { name: c.name }), onclick: () => deleteVpn(c) }, icon('delete')),
      );
    }
    async function toggleVpn(c) {
      if (busy.has(c.uuid)) return;
      busy.add(c.uuid);
      renderVpn();
      try {
        await api.invoke(c.active ? 'nettools:vpnDown' : 'nettools:vpnUp', c.uuid);
        vpnInfo.replaceChildren();
      } catch (e) {
        if (!win.closed) infobar('error', t('vpn.failed', { msg: errMsg(e) }));
      } finally {
        busy.delete(c.uuid);
      }
      if (!win.closed) await loadVpn();
    }
    async function deleteVpn(c) {
      const ok = await ui.confirm(t('vpn.deleteBody', { name: c.name }), { title: t('vpn.deleteTitle'), okLabel: t('vpn.deleteOk'), danger: true, parent: win });
      if (!ok || win.closed) return;
      try {
        await api.invoke('nettools:vpnDelete', c.uuid);
        vpnInfo.replaceChildren();
      } catch (e) {
        infobar('error', t('vpn.failed', { msg: errMsg(e) }));
      }
      await loadVpn();
      (vpnList.querySelector('[data-act="toggle"]') || importBtn).focus();
    }
    async function importPath(p) {
      if (!p) return;
      try {
        const { name } = await api.invoke('nettools:vpnImport', p);
        if (win.closed) return;
        infobar('success', t('vpn.imported', { name }));
      } catch (e) {
        if (!win.closed) infobar('error', t('vpn.failed', { msg: errMsg(e) }));
      }
      if (!win.closed) await loadVpn();
    }
    async function pickImport() {
      const res = await ui.filePicker({ mode: 'open', title: t('vpn.importTitle'), filters: [{ name: t('vpn.wgFiles'), ext: ['conf'] }], parent: win });
      const p = Array.isArray(res) ? res[0] : res;
      if (p && !win.closed) await importPath(p);
    }

    // ------------------------------------------------------------ Ping
    const pingInput = h('input', { class: 'input grow', id: 'nt-ping-host', placeholder: t('ping.placeholder'), spellcheck: false, autocomplete: 'off', maxLength: 253 });
    const pingStart = h('button', { class: 'btn primary', type: 'submit', dataset: { act: 'ping' } }, icon('play'), h('span', null, t('ping.start')));
    const pingCancel = h('button', { class: 'btn', type: 'button', dataset: { act: 'cancel' }, disabled: true, onclick: () => cancelPing() }, icon('stop'), h('span', null, t('ping.cancel')));
    const pingStatus = h('div', { class: 'nt-status-line', role: 'status', 'aria-live': 'polite' });
    const pingOut = h('pre', { class: 'nt-out selectable', role: 'log', 'aria-label': t('ping.output'), tabIndex: 0 });
    panels.ping.append(
      h(
        'form',
        { class: 'nt-form', onsubmit: (e) => (e.preventDefault(), startPing()) },
        h('label', { class: 'nt-label', for: 'nt-ping-host' }, t('ping.host')),
        h('div', { class: 'nt-row' }, pingInput, pingStart, pingCancel),
      ),
      pingStatus,
      pingOut,
    );
    let pingId = null;
    let pingHost = '';
    let pendingLines = [];
    offs.push(
      api.on('nettools:ping', (ev) => {
        if (!ev || win.closed) return;
        if (pingId == null) {
          pendingLines.push(ev); // event raced ahead of the invoke reply
          return;
        }
        handlePing(ev);
      }),
    );
    function handlePing(ev) {
      if (ev.id !== pingId) return;
      if (typeof ev.line === 'string') {
        pingOut.append(ev.line + '\n');
        pingOut.scrollTop = pingOut.scrollHeight;
      }
      if (ev.done) {
        pingId = null;
        pingStart.disabled = false;
        pingCancel.disabled = true;
        pingStatus.className = `nt-status-line ${ev.cancelled ? '' : ev.code === 0 ? 'ok' : 'bad'}`;
        pingStatus.textContent = ev.cancelled ? t('ping.cancelled') : ev.code === 0 ? t('ping.ok', { host: pingHost }) : t('ping.fail', { host: pingHost });
        if (document.activeElement === pingCancel || !win.body.contains(document.activeElement)) pingInput.focus();
      }
    }
    async function startPing() {
      if (pingId != null || pingStart.disabled) return;
      const host = pingInput.value.trim();
      if (!validHost(host)) {
        pingStatus.className = 'nt-status-line bad';
        pingStatus.textContent = t('ping.invalid');
        pingInput.setAttribute('aria-invalid', 'true');
        pingInput.focus();
        return;
      }
      pingInput.removeAttribute('aria-invalid');
      pingHost = host;
      pingOut.textContent = '';
      pingStatus.className = 'nt-status-line';
      pingStatus.textContent = t('ping.running', { host });
      pingStart.disabled = true;
      pendingLines = [];
      try {
        const { id } = await api.invoke('nettools:ping', host);
        if (win.closed) return api.invoke('nettools:pingCancel', id).catch(() => {});
        pingId = id;
        pingCancel.disabled = false;
        const early = pendingLines;
        pendingLines = [];
        early.forEach(handlePing);
      } catch (e) {
        pingStart.disabled = false;
        pingStatus.className = 'nt-status-line bad';
        pingStatus.textContent = e?.code === 'EINVAL' ? t('ping.invalid') : errMsg(e);
      }
    }
    function cancelPing() {
      if (pingId != null) api.invoke('nettools:pingCancel', pingId).catch(() => {});
    }

    // ------------------------------------------------------------ DNS
    const dnsInput = h('input', { class: 'input grow', id: 'nt-dns-host', placeholder: t('dns.placeholder'), spellcheck: false, autocomplete: 'off', maxLength: 253 });
    const dnsType = h('select', { class: 'select', id: 'nt-dns-type', 'aria-label': t('dns.type') }, DNS_TYPES.map((x) => h('option', { value: x }, x)));
    const dnsBtn = h('button', { class: 'btn primary', type: 'submit', dataset: { act: 'lookup' } }, icon('search'), h('span', null, t('dns.lookup')));
    const dnsStatus = h('div', { class: 'nt-status-line', role: 'status', 'aria-live': 'polite' });
    const dnsList = h('ul', { class: 'nt-records', 'aria-label': t('dns.results') });
    panels.dns.append(
      h(
        'form',
        { class: 'nt-form', onsubmit: (e) => (e.preventDefault(), lookup()) },
        h('label', { class: 'nt-label', for: 'nt-dns-host' }, t('dns.host')),
        h('div', { class: 'nt-row' }, dnsInput, dnsType, dnsBtn),
      ),
      dnsStatus,
      dnsList,
    );
    let dnsSeq = 0;
    async function lookup() {
      const host = dnsInput.value.trim();
      const type = dnsType.value;
      const seq = ++dnsSeq;
      dnsList.replaceChildren();
      if (hostKindLocal(host) !== 'hostname') {
        dnsStatus.className = 'nt-status-line bad';
        dnsStatus.textContent = t('dns.invalid');
        dnsInput.setAttribute('aria-invalid', 'true');
        dnsInput.focus();
        return;
      }
      dnsInput.removeAttribute('aria-invalid');
      dnsStatus.className = 'nt-status-line';
      dnsStatus.textContent = '…';
      dnsBtn.disabled = true;
      try {
        const res = await api.invoke('nettools:dns', host, type);
        if (seq !== dnsSeq || win.closed) return;
        const recs = Array.isArray(res.records) ? res.records : [];
        dnsStatus.textContent = recs.length ? t('dns.count', { count: recs.length, type }) : t('dns.none', { type, host });
        dnsList.replaceChildren(
          ...recs.map((r) =>
            h(
              'li',
              { class: 'nt-record' },
              h('span', { class: 'nt-rtype' }, type),
              h('span', { class: 'nt-rvalue selectable' }, String(r ?? '')),
              h('button', { class: 'btn subtle icon-btn', 'aria-label': `${t('dns.copy')} ${String(r ?? '')}`, 'data-tip': t('dns.copy'), onclick: (e) => copy(String(r ?? ''), e.currentTarget) }, icon('copy')),
            ),
          ),
        );
      } catch (e) {
        if (seq !== dnsSeq || win.closed) return;
        dnsStatus.className = 'nt-status-line bad';
        dnsStatus.textContent =
          e?.code === 'ENOTFOUND' ? t('dns.notFound', { host }) : e?.code === 'ENODATA' ? t('dns.none', { type, host }) : e?.code === 'ETIMEOUT' ? t('dns.timeout') : e?.code === 'EINVAL' ? t('dns.invalid') : errMsg(e);
      } finally {
        if (seq === dnsSeq) dnsBtn.disabled = false;
      }
    }
    async function copy(text, btn) {
      try {
        await api.invoke('clipboard:writeText', text);
        btn.setAttribute('data-tip', t('dns.copied'));
      } catch {}
    }

    // ------------------------------------------------------------ host validation (mirror of the backend)
    function hostKindLocal(s) {
      if (typeof s !== 'string' || !s || s.length > 253) return null;
      if (/^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(s)) return 'ipv4';
      if (s.includes(':')) return /^[0-9a-fA-F:.]+$/.test(s) && /^(?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F.]{0,15}$/.test(s) ? 'ipv6' : null;
      if (/^[\d.]+$/.test(s)) return null;
      return s.split('.').every((l) => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(l)) ? 'hostname' : null;
    }
    const validHost = (s) => hostKindLocal(s) !== null;

    // ------------------------------------------------------------ layout
    const root = h('div', { class: 'nt-root' }, tabList, h('div', { class: 'nt-panels' }, TABS.map((id) => panels[id])));
    win.body.append(root);
    win.body.__nettools = { select, loadVpn, importPath, get tab() { return tab; }, get pingId() { return pingId; } };
    win.onBeforeClose(async () => {
      cancelPing();
      for (const off of offs) {
        try {
          off?.();
        } catch {}
      }
      return true;
    });
    select(tab, false);
    void shell;
    return {
      onRelaunch(args) {
        if (args?.tab && TABS.includes(args.tab)) select(args.tab, true);
        win.focus();
      },
    };
  },
};
