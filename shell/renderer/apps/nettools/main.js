// Network tools: VPN connections (NetworkManager: WireGuard .conf and OpenVPN .ovpn import, connect with user name /
// password, delete), ping, traceroute, DNS lookup, port checks + listening ports, speed test.
// Backend: main/ipc/nettools.js (mock data in dev/tests). Tabs other than VPN / ping / DNS live in lib/.
// Test hooks: the window body element gets __nettools.
import { buildTrace } from './lib/trace.js';
import { buildPorts } from './lib/ports.js';
import { buildSpeed } from './lib/speed.js';

const TABS = ['vpn', 'ping', 'trace', 'dns', 'ports', 'speed'];
const DNS_TYPES = ['A', 'AAAA', 'MX', 'TXT', 'NS', 'CNAME'];
const VPN_EXT = /\.(conf|ovpn)$/i;
const DND_MIME = 'application/x-aurora-paths';
const OVPN_PROBLEMS = ['binary', 'unclosed', 'noRemote', 'notClient', 'noCa'];

export default {
  async launch(ctx) {
    const { win, h, icon, ui, t, api, shell, storage } = ctx;
    const offs = [];
    const sub = Object.assign(Object.create(ctx), { __offs: offs }); // ctx for lib/ tabs (live getters kept)
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
      tabBtns[id].scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); // narrow window: the tab row scrolls
      Promise.resolve()
        .then(() => storage?.set?.('tab', id))
        .catch(() => {});
      if (id === 'vpn') loadVpn();
      if (id === 'ports') portsTab?.shown();
    }

    // ------------------------------------------------------------ VPN
    const vpnList = h('div', { class: 'nt-vpn-list', role: 'list', 'aria-label': t('vpn.title') });
    const vpnInfo = h('div', { class: 'nt-vpn-info' });
    const importBtn = h('button', { class: 'btn', dataset: { act: 'import' }, onclick: () => pickImport() }, icon('arrow_import'), h('span', null, t('vpn.import')));
    const dropHint = h('div', { class: 'nt-drop', hidden: true, 'aria-hidden': 'true' }, icon('arrow_import'), h('span', null, t('vpn.dropHint')));
    const refreshBtn = h('button', { class: 'btn subtle icon-btn', dataset: { act: 'refresh' }, 'aria-label': t('vpn.refresh'), 'data-tip': t('vpn.refresh'), onclick: () => loadVpn() }, icon('arrow_clockwise'));
    panels.vpn.append(
      h('div', { class: 'nt-toolbar' }, h('h2', { class: 'nt-h2' }, t('vpn.title')), h('div', { class: 'grow' }), importBtn, refreshBtn),
      vpnInfo,
      vpnList,
      h('div', { class: 'caption text-2 nt-later' }, icon('info'), h('span', null, t('vpn.hint'))),
      dropHint,
    );
    const busy = new Set();
    let vpnItems = [];
    let vpnSeq = 0;
    function infobar(kind, text) {
      vpnInfo.replaceChildren(h('div', { class: `infobar ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, icon(kind === 'error' ? 'error_circle' : kind === 'success' ? 'checkmark_circle' : 'info'), h('span', null, text)));
    }
    /** Backend error -> sentence for the infobar (OpenVPN codes first). */
    function vpnError(e) {
      switch (e?.code) {
        case 'ENOPLUGIN':
          return t('vpn.err.plugin');
        case 'EBADFILE': {
          const p = (/\((\w+)\)\s*$/.exec(errMsg(e)) || [])[1];
          return OVPN_PROBLEMS.includes(p) ? t('vpn.err.badProfile', { why: t(`vpn.problem.${p}`) }) : t('vpn.err.badFile', { msg: errMsg(e) });
        }
        case 'EMISSING':
          return t('vpn.err.missing', { files: errMsg(e) });
        case 'EBADREF':
          return t('vpn.err.badRef', { msg: errMsg(e) });
        case 'EAUTH':
          return t('vpn.err.auth');
        case 'ENEEDAUTH':
          return t('vpn.err.needAuth');
        case 'ETIMEDOUT':
          return t('vpn.err.timeout');
        default:
          return t('vpn.failed', { msg: errMsg(e) });
      }
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
      else if (vpnInfo.querySelector('.infobar.warning')) vpnInfo.replaceChildren();
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
          h('div', { class: 'caption text-2' }, h('span', { class: 'nt-badge' }, t(c.type === 'wireguard' ? 'vpn.typeWireguard' : c.service === 'openvpn' ? 'vpn.typeOpenvpn' : 'vpn.typeVpn')), ' · ', h('span', { class: ['nt-status', c.active && 'on'] }, status)),
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
        if (c.active) await api.invoke('nettools:vpnDown', c.uuid);
        else await connectVpn(c);
        vpnInfo.replaceChildren();
      } catch (e) {
        if (!win.closed && e?.code !== 'ECANCELED') infobar('error', vpnError(e));
      } finally {
        busy.delete(c.uuid);
      }
      if (!win.closed) await loadVpn();
    }
    // VPN plugins (OpenVPN…): ask for the user name / password (or the private key's password) when NetworkManager
    // has none, then again after « login failed ». Secrets go to the backend, which never puts them on a command line.
    async function connectVpn(c) {
      let info = null;
      if (c.type === 'vpn') info = await api.invoke('nettools:vpnInfo', c.uuid).catch(() => null);
      let creds = null;
      let problem = '';
      if (info && (info.needsPassword || info.keyPass === 'ask')) {
        creds = await askCredentials(c, info, '');
        if (!creds) throw Object.assign(new Error('cancelled'), { code: 'ECANCELED' });
      }
      for (;;) {
        try {
          await api.invoke('nettools:vpnUp', c.uuid, creds || undefined);
          return;
        } catch (e) {
          if (c.type !== 'vpn' || win.closed || (e?.code !== 'ENEEDAUTH' && e?.code !== 'EAUTH')) throw e;
          problem = e.code === 'EAUTH' ? t('vpn.err.auth') : '';
          if (!info) info = await api.invoke('nettools:vpnInfo', c.uuid).catch(() => ({ auth: 'password', keyPass: 'none' }));
          // Which secret is missing: the private key's password when the key is protected, else the user's password.
          const needKey = info.keyPass === 'ask' || info.keyPass === 'saved';
          const needPass = info.auth === 'password' || info.auth === 'password-tls' || !needKey;
          creds = await askCredentials(c, { ...info, needsPassword: needPass, keyPass: needKey ? 'ask' : 'none' }, problem, creds);
          if (!creds) throw Object.assign(new Error('cancelled'), { code: 'ECANCELED' });
        }
      }
    }
    function askCredentials(c, info, problem, prev) {
      const wantPass = !!info.needsPassword;
      const wantKey = info.keyPass === 'ask';
      const user = h('input', { class: 'input', id: 'nt-cred-user', autocomplete: 'off', spellcheck: false, maxLength: 256, value: prev?.username || info.username || '' });
      const pass = h('input', { class: 'input', id: 'nt-cred-pass', type: 'password', autocomplete: 'off', maxLength: 1024 });
      const key = h('input', { class: 'input', id: 'nt-cred-key', type: 'password', autocomplete: 'off', maxLength: 1024 });
      const remember = h('input', { type: 'checkbox', id: 'nt-cred-remember', checked: prev ? !!prev.remember : true });
      const err = h('div', { class: 'field-hint nt-cred-error', role: 'alert' }, problem || '');
      const body = h(
        'div',
        { class: 'nt-cred' },
        h('p', { class: 'nt-cred-intro' }, t(wantPass ? 'vpn.cred.intro' : 'vpn.cred.introKey', { name: c.name })),
        wantPass ? h('div', { class: 'field' }, h('label', { for: 'nt-cred-user' }, t('vpn.cred.user')), user) : null,
        wantPass ? h('div', { class: 'field' }, h('label', { for: 'nt-cred-pass' }, t('vpn.cred.pass')), pass) : null,
        wantKey ? h('div', { class: 'field' }, h('label', { for: 'nt-cred-key' }, t('vpn.cred.key')), key) : null,
        h('label', { class: 'checkbox', for: 'nt-cred-remember' }, remember, h('span', null, t('vpn.cred.remember'))),
        err,
      );
      return ui
        .dialog({
          title: t('vpn.cred.title'),
          body,
          parent: win,
          className: 'nt-cred-dialog',
          buttons: [
            { label: t('vpn.connect'), value: 'ok', primary: true },
            { label: t('common.cancel'), value: null },
          ],
          onOpen: (dlg) => {
            dlg._validate = () => {
              const bad = (el, msg) => (err.textContent = msg, el.setAttribute('aria-invalid', 'true'), el.focus(), false);
              if (wantPass && !user.value.trim()) return bad(user, t('vpn.cred.needUser'));
              if (wantPass && !pass.value) return bad(pass, t('vpn.cred.needPass'));
              if (wantKey && !key.value) return bad(key, t('vpn.cred.needKey'));
              if ([user.value, pass.value, key.value].some((v) => /[\u0000-\u001f\u007f]/.test(v))) return bad(pass, t('vpn.cred.badChars'));
              return true;
            };
            setTimeout(() => (wantPass ? (user.value ? pass : user) : key).focus(), 40);
          },
        })
        .then((v) => {
          if (v !== 'ok') return null;
          const out = { remember: remember.checked };
          if (wantPass) {
            out.username = user.value.trim();
            out.password = pass.value;
          }
          if (wantKey) out.keyPassword = key.value;
          return out;
        });
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
        const res = await api.invoke('nettools:vpnImport', p);
        if (win.closed) return;
        infobar('success', res.type === 'openvpn' && (res.needsAuth || res.needsKeyPass) ? t('vpn.importedAuth', { name: res.name }) : t('vpn.imported', { name: res.name }));
      } catch (e) {
        const msg = e?.code === 'EINVAL' ? t('vpn.failed', { msg: t('vpn.badFile') }) : e?.code === 'ENOENT' ? t('vpn.failed', { msg: t('vpn.fileMissing') }) : vpnError(e);
        if (!win.closed) infobar('error', msg);
      }
      if (!win.closed) await loadVpn();
    }
    async function pickImport() {
      const xdg = await api.invoke('fs:xdg').catch(() => null);
      const res = await ui.filePicker({
        mode: 'open',
        title: t('vpn.importTitle'),
        filters: [
          { name: t('vpn.vpnFiles'), ext: ['.conf', '.ovpn'] },
          { name: t('vpn.wgFiles'), ext: ['.conf'] },
          { name: t('vpn.ovpnFiles'), ext: ['.ovpn'] },
        ],
        path: xdg?.downloads,
        parent: win,
      });
      const p = Array.isArray(res) ? res[0] : res;
      if (p && !win.closed) await importPath(p);
    }
    // A .ovpn / .conf opened from Fichiers (manifest fileTypes) or dropped on the window.
    async function openFile(p, ask) {
      if (typeof p !== 'string' || !p.startsWith('/')) return;
      select('vpn', false);
      if (!VPN_EXT.test(p)) return infobar('error', t('vpn.failed', { msg: t('vpn.badFile') }));
      if (ask) {
        const name = p.split('/').pop();
        const ok = await ui.confirm(t('vpn.openBody', { name }), { title: t('vpn.openTitle'), okLabel: t('vpn.openOk'), parent: win });
        if (!ok || win.closed) return;
      }
      await importPath(p);
    }
    const dropPaths = (dt) => {
      let paths = [];
      try {
        const v = JSON.parse(dt.getData(DND_MIME) || '[]');
        if (Array.isArray(v)) paths = v.filter((x) => typeof x === 'string' && x.startsWith('/') && !x.includes('\0'));
      } catch {}
      if (!paths.length) paths = [...(dt.files || [])].map((f) => api.pathForFile?.(f)).filter(Boolean);
      return paths;
    };
    const dragAccepts = (e) => {
      const types = [...(e.dataTransfer?.types || [])];
      return types.includes(DND_MIME) || types.includes('Files');
    };
    let dragDepth = 0;
    panels.vpn.addEventListener('dragenter', (e) => {
      if (!dragAccepts(e)) return;
      dragDepth++;
      dropHint.hidden = false;
    });
    panels.vpn.addEventListener('dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) dropHint.hidden = true;
    });
    panels.vpn.addEventListener('dragover', (e) => {
      if (!dragAccepts(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    panels.vpn.addEventListener('drop', (e) => {
      dragDepth = 0;
      dropHint.hidden = true;
      if (!dragAccepts(e)) return;
      e.preventDefault();
      e.stopPropagation();
      const paths = dropPaths(e.dataTransfer);
      const file = paths.find((x) => VPN_EXT.test(x));
      if (file) importPath(file);
      else infobar('error', t('vpn.failed', { msg: t('vpn.badFile') }));
    });

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

    // ------------------------------------------------------------ traceroute, ports, speed test (lib/)
    const traceTab = buildTrace(sub, panels.trace);
    const portsTab = buildPorts(sub, panels.ports);
    const speedTab = buildSpeed(sub, panels.speed);

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
    win.body.__nettools = { select, loadVpn, importPath, openFile, get tab() { return tab; }, get pingId() { return pingId; }, trace: traceTab, ports: portsTab, speed: speedTab };
    win.onBeforeClose(async () => {
      cancelPing();
      traceTab.cancel();
      speedTab.cancel();
      for (const off of offs) {
        try {
          off?.();
        } catch {}
      }
      return true;
    });
    select(tab, false);
    if (typeof ctx.args?.file === 'string') openFile(ctx.args.file, true);
    else if (ctx.args?.tab && TABS.includes(ctx.args.tab)) select(ctx.args.tab, false);
    void shell;
    return {
      onRelaunch(args) {
        if (typeof args?.file === 'string') openFile(args.file, true);
        else if (args?.tab && TABS.includes(args.tab)) select(args.tab, true);
        win.focus();
      },
    };
  },
};
