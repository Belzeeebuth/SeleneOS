// Remote Desktop: VNC viewer (RFB 3.8, lib/rfb.js) and RDP launcher (FreeRDP 3 through main/ipc/remote.js).
// VNC: the TCP bytes go through main/ipc/remote.js (the renderer has no network access); the screen is drawn here.
// RDP: FreeRDP (xfreerdp3) runs as an X11 client; its window becomes a Selene window (core/features/xwin.js) whose
// taskbar entry is 'x11:selene-remote' (registered below with this app's name and icon). This window lists the open
// RDP sessions, shows progress and errors, and asks about unknown certificates (see main/lib/freerdp.js).
// Test hooks: the window body element gets __remote.
import { RfbClient } from './lib/rfb.js';
import { keysymFor } from './lib/keysym.js';

const HANDSHAKE_MS = 15000;
const PORTS = { vnc: 5900, rdp: 3389 };
const RDP_APP = 'x11:selene-remote'; // core/features/xwin.js: `x11:` + WM_CLASS class (main/lib/freerdp.js WM_CLASS)
const SIZES = ['1024x768', '1280x720', '1280x800', '1366x768', '1600x900', '1920x1080', '2560x1440'];
const hasCtl = (s) => /[\u0000-\u001f\u007f]/.test(s);

export default {
  async launch(ctx) {
    const { win, h, icon, ui, t, api, storage, shell } = ctx;
    const offs = [];
    const winKey = `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    let scaleMode = 'fit';
    try {
      const s = await storage?.get?.('scale', 'fit');
      if (s === 'fit' || s === 'actual') scaleMode = s;
    } catch {}
    // The RDP session windows: this app's name and icon in the taskbar, Alt+Tab and Task view.
    try {
      shell?.registry?.addTransient?.({ id: RDP_APP, name: { en: 'Remote Desktop', fr: 'Bureau à distance' }, icon: ctx.appUrl('icon.svg'), kind: 'x11' });
    } catch {}

    // ------------------------------------------------------------ home view: form + saved connections
    const info = h('div', { class: 'rd-info', 'aria-live': 'polite' });
    const uid = (id) => `rd-${id}-${winKey}`;
    const field = (id, label, input, hint, extraClass) =>
      h('div', { class: ['field', extraClass] }, h('label', { for: uid(id) }, label), input, hint ? h('div', { class: 'field-hint', id: uid(`${id}-hint`) }, hint) : '');
    const hostIn = h('input', { class: 'input', id: uid('host'), name: 'host', autocomplete: 'off', spellcheck: 'false', placeholder: t('form.hostPlaceholder') });
    const portIn = h('input', { class: 'input', id: uid('port'), name: 'port', inputmode: 'numeric', value: '5900' });
    const nameIn = h('input', { class: 'input', id: uid('name'), name: 'name', autocomplete: 'off', placeholder: t('form.namePlaceholder') });
    const userIn = h('input', { class: 'input', id: uid('user'), name: 'user', autocomplete: 'off', spellcheck: 'false', placeholder: t('form.userPlaceholder') });
    const domainIn = h('input', { class: 'input', id: uid('domain'), name: 'domain', autocomplete: 'off', spellcheck: 'false', placeholder: t('form.domainPlaceholder') });
    const passIn = h('input', { class: 'input', id: uid('pass'), name: 'password', type: 'password', autocomplete: 'off', 'aria-describedby': uid('pass-hint') });
    const rememberIn = h('input', { type: 'checkbox', name: 'remember' });
    const vncClipIn = h('input', { type: 'checkbox', name: 'vnc-clipboard', checked: true });
    const formTitle = h('h2', { class: 'rd-h2' }, t('form.new'));
    const cancelEditBtn = h('button', { type: 'button', class: 'btn subtle', hidden: true, dataset: { act: 'cancel-edit' }, onclick: () => editEntry(null) }, t('form.cancelEdit'));
    const connectBtn = h('button', { type: 'submit', class: 'btn primary', dataset: { act: 'connect' } }, icon('plug_connected'), h('span', null, t('form.connect')));
    const saveBtn = h('button', { type: 'button', class: 'btn', dataset: { act: 'save' }, onclick: () => saveForm() }, icon('star_add'), h('span', null, t('form.save')));

    // protocol switch (radio group)
    let protocol = 'vnc';
    const protoBtns = {};
    const protoGroup = h('div', { class: 'rd-proto', role: 'radiogroup', 'aria-labelledby': uid('proto-label') });
    for (const [p, label] of [
      ['vnc', t('form.protoVnc')],
      ['rdp', t('form.protoRdp')],
    ]) {
      protoBtns[p] = h(
        'button',
        {
          type: 'button',
          class: 'btn subtle rd-proto-btn',
          role: 'radio',
          dataset: { proto: p },
          onclick: () => setProtocol(p, true),
          onkeydown: (e) => {
            if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
              e.preventDefault();
              const other = p === 'vnc' ? 'rdp' : 'vnc';
              setProtocol(other, true);
              protoBtns[other].focus();
            }
          },
        },
        label,
      );
      protoGroup.append(protoBtns[p]);
    }

    // RDP options
    const displaySel = h(
      'select',
      { class: 'select', id: uid('display'), name: 'display', onchange: () => syncOptions() },
      ['fit', 'fullscreen', 'fixed'].map((v) => h('option', { value: v }, t(`opt.${v}`))),
    );
    const sizeSel = h(
      'select',
      { class: 'select', id: uid('size'), name: 'size' },
      SIZES.map((v) => h('option', { value: v }, v.replace('x', ' × '))),
    );
    sizeSel.value = '1920x1080';
    const multimonIn = h('input', { type: 'checkbox', name: 'multimon' });
    const rdpClipIn = h('input', { type: 'checkbox', name: 'rdp-clipboard', checked: true });
    const audioIn = h('input', { type: 'checkbox', name: 'audio', checked: true });
    let drivePath = null;
    const driveText = h('div', { class: 'rd-drive-path ellipsis', id: uid('drive') });
    const driveChooseBtn = h('button', { type: 'button', class: 'btn', dataset: { act: 'drive-choose' }, onclick: () => chooseDrive() }, icon('folder_open'), h('span', null, t('opt.driveChoose')));
    const driveRemoveBtn = h('button', { type: 'button', class: 'btn subtle', dataset: { act: 'drive-remove' }, onclick: () => setDrive(null) }, t('opt.driveRemove'));
    const sizeField = field('size', t('opt.size'), sizeSel, null, 'rd-size-field');
    const multimonRow = h('label', { class: 'checkbox' }, multimonIn, h('span', null, t('opt.multimon')));
    const rdpOptions = h(
      'details',
      { class: 'rd-options' },
      h('summary', { class: 'rd-options-summary' }, icon('settings'), h('span', null, t('form.options'))),
      h(
        'div',
        { class: 'rd-options-body' },
        h('div', { class: 'rd-row' }, field('display', t('opt.display'), displaySel), sizeField),
        multimonRow,
        h('label', { class: 'checkbox' }, rdpClipIn, h('span', null, t('opt.clipboard'))),
        h('label', { class: 'checkbox' }, audioIn, h('span', null, t('opt.audio'))),
        h('div', { class: 'field rd-drive' }, h('span', { class: 'rd-label', id: uid('drive-label') }, t('opt.drive')), h('div', { class: 'rd-drive-row', role: 'group', 'aria-labelledby': uid('drive-label') }, driveText, driveChooseBtn, driveRemoveBtn), h('div', { class: 'field-hint' }, t('opt.driveHint'))),
      ),
    );
    const rdpMissing = h('div', { class: 'rd-rdp-missing', hidden: true });
    const userRow = h('div', { class: 'rd-row rd-rdp-only' }, field('user', t('form.user'), userIn), field('domain', t('form.domain'), domainIn));
    const passHint = h('div', { class: 'field-hint', id: uid('pass-hint') }, t('form.passwordHint'));
    const vncClipRow = h('label', { class: 'checkbox rd-vnc-only rd-clip' }, vncClipIn, h('span', null, t('form.clipboard')));
    const form = h(
      'form',
      { class: 'card rd-form', novalidate: true, onsubmit: (e) => (e.preventDefault(), connectFromForm()) },
      h('div', { class: 'rd-form-head' }, formTitle, h('div', { class: 'grow' }), cancelEditBtn),
      h('div', { class: 'field' }, h('span', { class: 'rd-label', id: uid('proto-label') }, t('form.protocol')), protoGroup),
      rdpMissing,
      h('div', { class: 'rd-row' }, field('host', t('form.host'), hostIn), h('div', { class: 'rd-port' }, field('port', t('form.port'), portIn))),
      field('name', t('form.name'), nameIn),
      userRow,
      h('div', { class: 'field' }, h('label', { for: uid('pass') }, t('form.password')), passIn, passHint),
      h('label', { class: 'checkbox rd-remember' }, rememberIn, h('span', null, t('form.remember'))),
      vncClipRow,
      h('div', { class: 'rd-rdp-only' }, rdpOptions),
      h('div', { class: 'rd-actions' }, connectBtn, saveBtn),
    );
    const savedList = h('div', { class: 'rd-saved-list', role: 'list', 'aria-label': t('saved.title') });
    const savedCard = h('section', { class: 'card rd-saved' }, h('h2', { class: 'rd-h2' }, t('saved.title')), savedList);
    const sessList = h('div', { class: 'rd-rdp-list', role: 'list', 'aria-label': t('rdp.sessions') });
    const sessCard = h('section', { class: 'card rd-rdp-sessions', hidden: true }, h('h2', { class: 'rd-h2' }, t('rdp.sessions')), sessList);
    const home = h(
      'div',
      { class: 'rd-home' },
      h('div', { class: 'rd-hero' }, h('img', { class: 'rd-hero-icon', src: new URL('./icon.svg', import.meta.url).href, alt: '' }), h('div', null, h('h1', { class: 'rd-h1' }, t('app.title')), h('p', { class: 'caption text-2' }, t('app.subtitle')))),
      info,
      sessCard,
      h('div', { class: 'rd-grid' }, form, savedCard),
    );

    // ------------------------------------------------------------ VNC session view
    const canvas = h('canvas', { class: 'rd-canvas', tabindex: '0', width: 1, height: 1, 'aria-label': t('session.screen'), 'aria-roledescription': t('session.screenRole') });
    const g = canvas.getContext('2d', { alpha: false });
    const overlayText = h('div', { class: 'rd-overlay-text' });
    const overlay = h('div', { class: 'rd-overlay', role: 'status' }, h('div', { class: 'spinner' }), overlayText);
    // The remote screen sits on a dark well in both modes (dark theme scope: --desk / --text come from the dark palette).
    const viewport = h('div', { class: 'rd-viewport', 'data-theme-scope': '', 'data-theme': 'dark' }, canvas, overlay);
    const sessTitle = h('div', { class: 'rd-sess-title ellipsis' });
    const sessStatus = h('div', { class: 'rd-sess-status caption text-2 ellipsis' });
    const scaleBtns = {};
    const scaleGroup = h('div', { class: 'rd-seg', role: 'group', 'aria-label': t('session.scale') });
    for (const [mode, label, ic] of [
      ['fit', t('session.fit'), 'zoom_fit'],
      ['actual', t('session.actual'), 'resize_large'],
    ]) {
      scaleBtns[mode] = h('button', { class: 'btn subtle', dataset: { scale: mode }, 'data-tip': label, onclick: () => setScale(mode) }, icon(ic), h('span', null, label));
      scaleGroup.append(scaleBtns[mode]);
    }
    const cadBtn = h('button', { class: 'btn subtle', dataset: { act: 'cad' }, 'data-tip': t('session.cadTip'), onclick: () => sendCad() }, icon('keyboard'), h('span', null, t('session.cad')));
    const fsBtn = h('button', { class: 'btn subtle icon-btn', dataset: { act: 'fullscreen' }, 'aria-label': t('session.fullscreen'), 'data-tip': t('session.fullscreenTip'), onclick: () => toggleFullscreen() }, icon('full_screen_maximize'));
    const discBtn = h('button', { class: 'btn subtle', dataset: { act: 'disconnect' }, onclick: () => disconnect(true) }, icon('plug_disconnected'), h('span', null, t('session.disconnect')));
    const bar = h('div', { class: 'rd-bar', role: 'toolbar', 'aria-label': t('session.toolbar') }, h('div', { class: 'rd-sess-id' }, sessTitle, sessStatus), h('div', { class: 'grow' }), scaleGroup, cadBtn, fsBtn, discBtn);
    const session = h('div', { class: 'rd-session', hidden: true }, bar, viewport, h('div', { class: 'rd-hint caption text-2' }, t('session.keyHint')));

    const root = h('div', { class: 'rd-root' }, home, session);
    win.body.append(root);

    // ------------------------------------------------------------ helpers
    const errMsg = (e) => String(e?.message || e || '').slice(0, 300);
    function setInfo(kind, text, detail) {
      info.replaceChildren(
        text
          ? h(
              'div',
              { class: `infobar ${kind}`, role: kind === 'error' ? 'alert' : 'status' },
              icon(kind === 'error' ? 'error_circle' : kind === 'success' ? 'checkmark_circle' : kind === 'warning' ? 'warning' : 'info'),
              h('div', { class: 'rd-info-body' }, h('span', { class: 'rd-info-text' }, text), detail ? h('details', { class: 'rd-detail' }, h('summary', null, t('err.details')), h('pre', { class: 'rd-detail-log selectable' }, detail)) : ''),
            )
          : '',
      );
    }
    function hostKind(s) {
      if (typeof s !== 'string' || !s || s.length > 253) return null;
      if (/^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(s)) return 'ipv4';
      if (s.includes(':')) return /^[0-9a-fA-F:.]+$/.test(s) && /^(?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F.]{0,15}$/.test(s) ? 'ipv6' : null;
      if (/^[\d.]+$/.test(s)) return null;
      return s.split('.').every((l) => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(l)) ? 'hostname' : null;
    }
    function invalid(input, message) {
      input.setAttribute('aria-invalid', 'true');
      setInfo('error', message);
      input.focus();
      return null;
    }
    function rdpOptionsValue() {
      return { display: displaySel.value, size: sizeSel.value, multimon: multimonIn.checked && displaySel.value === 'fullscreen', clipboard: rdpClipIn.checked, audio: audioIn.checked, drive: drivePath };
    }
    function readForm() {
      let host = hostIn.value.trim();
      if (/^\[.*\]$/.test(host)) host = host.slice(1, -1);
      const portStr = portIn.value.trim() || String(PORTS[protocol]);
      const port = /^\d{1,5}$/.test(portStr) ? Number(portStr) : 0;
      for (const el of [hostIn, portIn, userIn, domainIn, passIn]) el.removeAttribute('aria-invalid');
      if (!hostKind(host)) return invalid(hostIn, host ? t('err.invalidHost') : t('err.noHost'));
      if (!(port >= 1 && port <= 65535)) return invalid(portIn, t('err.invalidPort'));
      const f = { protocol, host, port, name: nameIn.value.trim(), password: passIn.value, remember: rememberIn.checked };
      if (protocol === 'rdp') {
        f.user = userIn.value.trim();
        f.domain = domainIn.value.trim();
        if (hasCtl(f.user) || f.user.length > 256) return invalid(userIn, t('err.badText'));
        if (hasCtl(f.domain) || f.domain.length > 256) return invalid(domainIn, t('err.badText'));
        if (hasCtl(f.password)) return invalid(passIn, t('err.badPassword'));
        f.options = rdpOptionsValue();
      } else f.clipboard = vncClipIn.checked;
      return f;
    }
    function errorText(e, target) {
      const v = { host: target?.host ?? '', port: target?.port ?? '' };
      switch (e?.code) {
        case 'ECONNREFUSED':
          return t('err.refused', v);
        case 'ETIMEDOUT':
          return t('err.timeout', v);
        case 'ENOTFOUND':
        case 'EAI_AGAIN':
          return t('err.notFound', v);
        case 'EHOSTUNREACH':
        case 'ENETUNREACH':
          return t('err.unreachable', v);
        case 'EOFFLINE':
          return t('err.offline');
        case 'EINVAL':
          return t('err.invalidHost');
        case 'ELIMIT':
          return t('err.limit');
        case 'EAUTH':
          return t('err.auth');
        case 'ENEEDPASS':
          return t('err.needPass');
        case 'ENOSEC':
          return t('err.noSec', { types: e.message || '?' });
        case 'EREFUSED':
          return t('err.serverRefused', { reason: e.message || '?' });
        case 'EPROTO':
          return t('err.proto', { detail: e.message || '?' });
        case 'ECLOSED':
        case 'ECONNRESET':
        case 'EPIPE':
          return t('err.closed');
        default:
          return t('err.generic', { message: errMsg(e) });
      }
    }

    // ------------------------------------------------------------ protocol + RDP options in the form
    let rdpAvailable = null; // null: unknown yet
    function setProtocol(p, user) {
      const prev = protocol;
      protocol = p === 'rdp' ? 'rdp' : 'vnc';
      for (const [k, b] of Object.entries(protoBtns)) {
        b.classList.toggle('selected', k === protocol);
        b.setAttribute('aria-checked', k === protocol ? 'true' : 'false');
        b.tabIndex = k === protocol ? 0 : -1;
      }
      form.classList.toggle('is-rdp', protocol === 'rdp');
      // the default port follows the protocol unless the person typed another one
      if (user && prev !== protocol && (portIn.value.trim() === '' || portIn.value.trim() === String(PORTS[prev]))) portIn.value = String(PORTS[protocol]);
      passHint.textContent = protocol === 'rdp' ? t('form.rdpPasswordHint') : t('form.passwordHint');
      syncOptions();
      syncRdpMissing();
    }
    function syncOptions() {
      const fixed = displaySel.value === 'fixed';
      sizeField.hidden = !fixed;
      const full = displaySel.value === 'fullscreen';
      multimonIn.disabled = !full;
      if (!full) multimonIn.checked = false;
      multimonRow.classList.toggle('disabled', !full);
    }
    function setDrive(p) {
      drivePath = typeof p === 'string' && p ? p : null;
      driveText.textContent = drivePath || t('opt.driveNone');
      driveText.classList.toggle('text-2', !drivePath);
      driveText.title = drivePath || '';
      driveRemoveBtn.hidden = !drivePath;
    }
    async function chooseDrive() {
      let p = null;
      try {
        p = await ui.filePicker({ mode: 'folder', title: t('opt.drivePick'), path: drivePath || shell?.xdg?.home, parent: win });
      } catch {}
      if (Array.isArray(p)) p = p[0];
      if (!p || win.closed) return;
      if (/,/.test(p)) {
        setInfo('error', t('err.driveComma'));
        return;
      }
      setDrive(p);
      driveChooseBtn.focus();
    }
    function syncRdpMissing() {
      const missing = protocol === 'rdp' && rdpAvailable === false;
      rdpMissing.hidden = !missing;
      rdpMissing.replaceChildren(missing ? h('div', { class: 'infobar warning' }, icon('warning'), h('span', null, t('rdp.missing'))) : '');
      connectBtn.disabled = missing;
    }
    async function checkRdp() {
      try {
        rdpAvailable = !!(await api.invoke('remote:rdp-status'))?.available;
      } catch {
        rdpAvailable = false;
      }
      if (!win.closed) syncRdpMissing();
    }

    // ------------------------------------------------------------ saved connections
    let saved = [];
    let editingId = null;
    async function loadSaved() {
      try {
        saved = await api.invoke('remote:list');
      } catch {
        saved = [];
      }
      if (win.closed) return;
      renderSaved();
    }
    const addrOf = (c) => (c.protocol === 'rdp' ? `RDP · ${c.user ? `${c.domain ? `${c.domain}\\` : ''}${c.user} @ ` : ''}${c.host}:${c.port}` : `VNC · ${c.host}:${c.port}`);
    function renderSaved() {
      if (!saved.length) {
        savedList.replaceChildren(h('div', { class: 'empty rd-empty' }, icon('desktop'), h('div', null, t('saved.empty'))));
        return;
      }
      savedList.replaceChildren(
        ...saved.map((c) =>
          h(
            'div',
            { class: 'rd-item', role: 'listitem', dataset: { id: c.id, proto: c.protocol || 'vnc' } },
            h('div', { class: 'rd-item-icon' }, icon(c.protocol === 'rdp' ? 'desktop_tower' : 'desktop')),
            h('div', { class: 'rd-item-text' }, h('div', { class: 'rd-item-name ellipsis' }, c.name), h('div', { class: 'rd-item-addr caption text-2 ellipsis', title: addrOf(c) }, addrOf(c), c.remember ? ` · ${t('saved.remembered')}` : '')),
            h('button', { class: 'btn primary rd-item-connect', dataset: { act: 'connect-saved' }, 'aria-label': t('saved.connectTo', { name: c.name }), onclick: () => connectSaved(c) }, t('form.connect')),
            h('button', { class: 'btn subtle icon-btn', dataset: { act: 'edit' }, 'aria-label': t('saved.edit', { name: c.name }), 'data-tip': t('saved.editTip'), onclick: () => editEntry(c) }, icon('edit')),
            h('button', { class: 'btn subtle icon-btn', dataset: { act: 'delete' }, 'aria-label': t('saved.delete', { name: c.name }), 'data-tip': t('saved.deleteTip'), onclick: () => removeEntry(c) }, icon('delete')),
          ),
        ),
      );
    }
    function fillForm(c) {
      setProtocol(c?.protocol || 'vnc', false);
      hostIn.value = c?.host || '';
      portIn.value = String(c?.port || PORTS[protocol]);
      nameIn.value = c?.name || '';
      passIn.value = '';
      rememberIn.checked = !!c?.remember;
      vncClipIn.checked = c?.clipboard !== false;
      userIn.value = c?.user || '';
      domainIn.value = c?.domain || '';
      const o = c?.options || {};
      displaySel.value = ['fit', 'fullscreen', 'fixed'].includes(o.display) ? o.display : 'fit';
      sizeSel.value = SIZES.includes(o.size) ? o.size : '1920x1080';
      multimonIn.checked = !!o.multimon;
      rdpClipIn.checked = o.clipboard !== false;
      audioIn.checked = o.audio !== false;
      setDrive(o.drive || null);
      syncOptions();
    }
    function editEntry(c) {
      editingId = c?.id || null;
      formTitle.textContent = c ? t('form.edit') : t('form.new');
      cancelEditBtn.hidden = !c;
      fillForm(c);
      setInfo('', '');
      (c ? passIn : hostIn).focus();
    }
    async function saveForm() {
      const f = readForm();
      if (!f) return;
      try {
        const entry = await api.invoke('remote:save', { id: editingId, ...f });
        editingId = entry.id;
        formTitle.textContent = t('form.edit');
        cancelEditBtn.hidden = false;
        setInfo('success', t('saved.saved', { name: entry.name }));
        await loadSaved();
      } catch (e) {
        setInfo('error', errorText(e, f));
      }
    }
    async function removeEntry(c) {
      const ok = await ui.confirm(t('saved.deleteConfirm', { name: c.name }), { title: t('saved.deleteTitle'), okLabel: t('saved.deleteOk'), danger: true, parent: win });
      if (!ok || win.closed) return;
      try {
        await api.invoke('remote:remove', c.id);
      } catch {}
      if (editingId === c.id) editEntry(null);
      await loadSaved();
      savedList.querySelector('button')?.focus();
    }
    function showInForm(c) {
      editingId = c.id;
      formTitle.textContent = t('form.edit');
      cancelEditBtn.hidden = false;
      fillForm(c);
    }
    async function connectSaved(c) {
      if (c.protocol === 'rdp') {
        if (!c.remember) {
          // no password stored: ask for it in the form (it is never kept unless the person ticks "Remember")
          showInForm(c);
          setInfo('info', t('saved.typePassword', { name: c.name }));
          passIn.focus();
          return;
        }
        connectRdp({ host: c.host, port: c.port, name: c.name, user: c.user, domain: c.domain, options: c.options, entry: c });
        return;
      }
      let password = '';
      if (c.remember) {
        try {
          password = await api.invoke('remote:secret', c.id);
        } catch {}
      }
      connect({ host: c.host, port: c.port, name: c.name, password, clipboard: c.clipboard !== false, entry: c });
    }
    function connectFromForm() {
      const f = readForm();
      if (!f) return;
      const entry = editingId ? saved.find((s) => s.id === editingId) : null;
      if (f.protocol === 'rdp') {
        if (!f.user) return invalid(userIn, t('err.needUser'));
        if (!f.password && !(entry?.remember && entry.host === f.host)) return invalid(passIn, t('err.needRdpPass'));
        connectRdp({ ...f, entry });
      } else connect({ ...f, entry });
    }

    // ------------------------------------------------------------ RDP sessions (FreeRDP)
    const rdpSessions = new Map(); // id -> { id, title, host, port, state: 'connecting'|'open', win, tg }
    function screenForRdp() {
      const wa = shell?.wm?.workarea?.() || { width: window.innerWidth, height: window.innerHeight };
      const dpr = window.devicePixelRatio || 1;
      return { width: Math.round(wa.width * dpr), height: Math.round((wa.height - 34) * dpr) };
    }
    async function connectRdp(tg) {
      setInfo('', '');
      const label = tg.name || tg.host;
      let res;
      try {
        res = await api.invoke('remote:rdp-start', {
          entryId: tg.entry?.id || null,
          host: tg.host,
          port: tg.port,
          user: tg.user || '',
          domain: tg.domain || '',
          password: tg.password || '',
          name: label,
          options: tg.options,
          screen: screenForRdp(),
        });
      } catch (e) {
        if (win.closed) return;
        const code = e?.code;
        if (code === 'ENOFREERDP') {
          rdpAvailable = false;
          syncRdpMissing();
          setInfo('error', t('err.noFreerdp'));
        } else if (code === 'EDRIVE') setInfo('error', t('err.drive'));
        else if (code === 'EINVAL') setInfo('error', t('err.rdpInvalid'));
        else setInfo('error', errorText(e, tg));
        return;
      }
      if (win.closed) return;
      const s = { id: res.id, title: res.title || label, host: tg.host, port: tg.port, state: 'connecting', win: null, tg };
      rdpSessions.set(s.id, s);
      claimWindows();
      renderSessions();
      setInfo('info', t('rdp.started', { host: tg.host }));
    }
    // The FreeRDP window: a frame of the RDP_APP taskbar entry whose title is the session title (core/features/xwin.js).
    function claimWindows() {
      const wm = shell?.wm;
      if (!wm) return;
      const taken = new Set([...rdpSessions.values()].map((s) => s.win).filter(Boolean));
      for (const s of rdpSessions.values()) {
        if (s.win && !s.win.closed) continue;
        const w = wm.list().find((x) => x.appId === RDP_APP && !taken.has(x) && !x.closed && (x.title === s.title || x.opts?.title === s.title));
        if (w) {
          s.win = w;
          s.state = 'open';
          taken.add(w);
          if (info.textContent === t('rdp.started', { host: s.host })) setInfo('', '');
        }
      }
    }
    if (shell?.wm?.on) {
      const onOpen = () => {
        if (!rdpSessions.size) return;
        // xwin.js sets the frame's X id right after creating it
        setTimeout(() => {
          if (win.closed) return;
          claimWindows();
          renderSessions();
        }, 0);
      };
      const offOpen = shell.wm.on('open', onOpen);
      offs.push(typeof offOpen === 'function' ? offOpen : () => shell.wm.off?.('open', onOpen));
    }
    function renderSessions() {
      sessCard.hidden = !rdpSessions.size;
      sessList.replaceChildren(
        ...[...rdpSessions.values()].map((s) =>
          h(
            'div',
            { class: 'rd-item rd-rdp-item', role: 'listitem', dataset: { id: s.id, state: s.state } },
            h('div', { class: 'rd-item-icon' }, s.state === 'open' ? icon('desktop_tower') : h('div', { class: 'spinner rd-spin', 'aria-hidden': 'true' })),
            h('div', { class: 'rd-item-text' }, h('div', { class: 'rd-item-name ellipsis' }, s.title), h('div', { class: 'rd-item-addr caption text-2 ellipsis' }, `RDP · ${s.host}:${s.port} · `, s.state === 'open' ? t('rdp.open') : t('rdp.connecting'))),
            h('button', { class: 'btn', dataset: { act: 'rdp-show' }, hidden: s.state !== 'open', 'aria-label': t('rdp.showName', { name: s.title }), onclick: () => showRdp(s) }, icon('window_new'), h('span', null, t('rdp.show'))),
            h('button', { class: 'btn subtle', dataset: { act: 'rdp-stop' }, 'aria-label': t('rdp.stopName', { name: s.title }), onclick: () => stopRdp(s) }, icon('plug_disconnected'), h('span', null, t('rdp.stop'))),
          ),
        ),
      );
    }
    function showRdp(s) {
      const w = s.win;
      if (!w || w.closed) return;
      if (w.minimized) w.restoreFromMinimize?.();
      w.focus();
    }
    async function stopRdp(s) {
      s.stopping = true;
      try {
        await api.invoke('remote:rdp-stop', s.id);
      } catch {}
    }
    const rdpError = (code, v, wasOpen) => {
      switch (code) {
        case 'EAUTH':
          return t('err.rdpAuth', v);
        case 'ENEEDCRED':
          return t('err.rdpNeedCred', v);
        case 'EPWEXPIRED':
          return t('err.rdpPwExpired', v);
        case 'ELOCKED':
          return t('err.rdpLocked', v);
        case 'EDENIED':
          return t('err.rdpDenied', v);
        case 'ENOTFOUND':
          return t('err.notFound', v);
        case 'EUNREACHABLE':
          return wasOpen ? t('err.rdpLost', v) : t('err.rdpUnreachable', v);
        case 'ETLS':
          return t('err.rdpTls', v);
        case 'ENEGO':
          return t('err.rdpNego', v);
        case 'EBOOTING':
          return t('err.rdpBooting', v);
        case 'ELICENSE':
          return t('err.rdpLicense', v);
        case 'EARGS':
          return t('err.rdpArgs', v);
        default:
          return t('err.rdpFail', v);
      }
    };
    async function certDialog(msg, s) {
      const changed = msg.code === 'ECERTCHANGED';
      const fmt = (hex) => (hex || '').toUpperCase().match(/../g)?.join(':') || '?';
      const fpBlock = (label, hex, cls) => h('div', { class: ['rd-fp', cls] }, h('div', { class: 'caption text-2' }, label), h('code', { class: 'rd-fp-code selectable' }, fmt(hex)));
      const body = h(
        'div',
        { class: ['rd-cert', changed && 'changed'] },
        h('div', { class: 'rd-cert-head' }, icon(changed ? 'shield-warning' : 'shield_keyhole'), h('p', null, t(changed ? 'cert.changedBody' : 'cert.newBody', { host: s.host }))),
        changed && msg.previous ? fpBlock(t('cert.previous'), msg.previous, 'old') : '',
        fpBlock(t(changed ? 'cert.newFingerprint' : 'cert.fingerprint'), msg.fingerprint, 'new'),
      );
      const v = await ui.dialog({
        title: t(changed ? 'cert.changedTitle' : 'cert.newTitle', { host: s.host }),
        body,
        parent: win,
        className: 'app-remote rd-cert-dialog',
        width: 520,
        buttons: changed
          ? [
              { label: t('common.cancel'), value: false, primary: true },
              { label: t('cert.trustNew'), value: true, danger: true },
            ]
          : [
              { label: t('cert.trust'), value: true, primary: true },
              { label: t('common.cancel'), value: false },
            ],
      });
      return v === true;
    }
    offs.push(
      api.on('remote:rdp', async (msg) => {
        const s = msg && rdpSessions.get(msg.id);
        if (!s || msg.state !== 'ended') return;
        rdpSessions.delete(s.id);
        renderSessions();
        if (win.closed) return;
        const v = { host: s.host, port: s.port };
        const wasOpen = s.state === 'open';
        if (s.foreign) {
          // started by another Remote Desktop window (or before this one opened): that window handles questions
          setInfo(msg.ended || s.stopping ? 'info' : 'error', msg.ended || s.stopping ? t('rdp.ended', v) : rdpError(msg.code, v, wasOpen));
          return;
        }
        if ((msg.code === 'ECERTNEW' || msg.code === 'ECERTCHANGED') && msg.fingerprint) {
          setInfo('', '');
          win.focus(); // a question for the person who is waiting for this connection
          const ok = await certDialog(msg, s);
          if (win.closed) return;
          if (!ok) {
            setInfo('info', t('cert.refused', v));
            return;
          }
          try {
            await api.invoke('remote:rdp-trust', s.host, s.port, msg.fingerprint);
          } catch (e) {
            setInfo('error', errorText(e, s));
            return;
          }
          connectRdp(s.tg);
          return;
        }
        if (msg.ended || s.stopping) {
          const key = msg.code === 'ELOGOFF' ? 'rdp.logoff' : msg.code === 'EIDLE' ? 'rdp.idle' : msg.code === 'EREPLACED' ? 'rdp.replaced' : 'rdp.ended';
          setInfo('info', t(key, v));
          return;
        }
        setInfo('error', rdpError(msg.code, v, wasOpen), msg.detail || '');
        if (!wasOpen) win.focus();
        if (['EAUTH', 'ENEEDCRED', 'EPWEXPIRED'].includes(msg.code)) {
          // back to the form with this connection, password emptied
          const tg = s.tg;
          showInForm(tg.entry ? { ...tg.entry, user: tg.user, domain: tg.domain, options: tg.options } : { protocol: 'rdp', host: tg.host, port: tg.port, name: tg.name, user: tg.user, domain: tg.domain, options: tg.options });
          if (!tg.entry) {
            editingId = null;
            formTitle.textContent = t('form.new');
            cancelEditBtn.hidden = true;
          }
          (msg.code === 'ENEEDCRED' && !userIn.value ? userIn : passIn).focus();
        }
      }),
    );
    async function loadRdpSessions() {
      // sessions started before this window was opened (they outlive it): shown, and stoppable
      let list = [];
      try {
        list = await api.invoke('remote:rdp-list');
      } catch {}
      if (win.closed) return;
      for (const r of list || []) if (!rdpSessions.has(r.id)) rdpSessions.set(r.id, { id: r.id, title: r.title, host: r.host, port: r.port, state: 'connecting', win: null, foreign: true, tg: { host: r.host, port: r.port, name: r.title, protocol: 'rdp' } });
      claimWindows();
      renderSessions();
    }

    // ------------------------------------------------------------ VNC connection
    let connId = null;
    let client = null;
    let target = null;
    let seq = 0;
    let handshakeTimer = 0;
    let state = 'idle'; // idle | connecting | connected
    const pressed = new Map();
    // clipboard sharing (VNC): text last exchanged, so a copy is never sent back where it came from
    let clipShare = true;
    let lastClip = null;
    let keyChain = null;

    function showSession(on) {
      home.hidden = on;
      session.hidden = !on;
    }
    async function connect(tg) {
      await disconnect(false);
      const my = ++seq;
      target = tg;
      state = 'connecting';
      clipShare = tg.clipboard !== false;
      lastClip = null;
      const label = tg.name || tg.host;
      sessTitle.textContent = label;
      sessStatus.textContent = `VNC · ${tg.host}:${tg.port}`;
      overlayText.textContent = t('session.connecting', { host: tg.host });
      overlay.hidden = false;
      canvas.hidden = true;
      canvas.style.cursor = '';
      setInfo('', '');
      showSession(true);
      win.setTitle?.(`${label} - ${t('app.title')}`);
      let res;
      try {
        res = await api.invoke('remote:connect', tg.host, tg.port, { key: winKey });
      } catch (e) {
        if (my === seq && !win.closed) fail(e);
        return;
      }
      if (my !== seq || win.closed) {
        api.invoke('remote:close', res.id).catch(() => {});
        return;
      }
      connId = res.id;
      overlayText.textContent = t('session.handshake');
      const id = connId;
      client = new RfbClient({
        password: tg.password,
        write: (bytes) => {
          if (connId === id) api.send('remote:write', id, bytes);
        },
        onState: (s) => {
          if (s === 'auth') overlayText.textContent = t('session.auth');
        },
        onInit: ({ width, height, name }) => {
          clearTimeout(handshakeTimer);
          state = 'connected';
          canvas.width = width;
          canvas.height = height;
          g.fillStyle = '#000';
          g.fillRect(0, 0, width, height);
          canvas.hidden = false;
          overlay.hidden = true;
          sessStatus.textContent = `VNC · ${tg.host}:${tg.port}${name ? ` · ${name}` : ''} · ${width} × ${height}`;
          layout();
          canvas.focus();
        },
        onRaw: (x, y, w, hh, px) => g.putImageData(new ImageData(new Uint8ClampedArray(px.buffer, px.byteOffset, px.length), w, hh), x, y),
        onCopy: (sx, sy, x, y, w, hh) => g.drawImage(canvas, sx, sy, w, hh, x, y, w, hh),
        onJpeg: async (x, y, w, hh, jpeg) => {
          const bmp = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }));
          if (connId === id) g.drawImage(bmp, x, y, w, hh);
          bmp.close?.();
        },
        onCursor: (c) => setCursor(c),
        onResize: (w, hh) => {
          canvas.width = w;
          canvas.height = hh;
          sessStatus.textContent = `VNC · ${tg.host}:${tg.port} · ${w} × ${hh}`;
          layout();
        },
        onCutText: (text) => {
          if (!clipShare || connId !== id || typeof text !== 'string') return;
          lastClip = text;
          api.invoke('clipboard:writeText', text).catch(() => {});
        },
        onError: (e) => fail(e),
      });
      api.send('remote:resume', id);
      clearTimeout(handshakeTimer);
      handshakeTimer = setTimeout(() => {
        if (connId === id && state !== 'connected') fail({ code: 'ETIMEDOUT' });
      }, HANDSHAKE_MS);
    }
    function setCursor({ hotX, hotY, w, h: hh, rgba }) {
      if (!w || !hh) {
        canvas.style.cursor = 'none';
        return;
      }
      const c = document.createElement('canvas');
      c.width = w;
      c.height = hh;
      c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.length), w, hh), 0, 0);
      canvas.style.cursor = `url(${c.toDataURL('image/png')}) ${Math.min(hotX, w - 1)} ${Math.min(hotY, hh - 1)}, default`;
    }
    /** Offer the Selene clipboard's text to the VNC server when it changed since the last exchange. */
    async function syncClipboard() {
      if (!clipShare || !client || state !== 'connected') return;
      let text = null;
      try {
        text = await api.invoke('clipboard:readText');
      } catch {}
      if (typeof text !== 'string' || !text || text === lastClip || !client) return;
      lastClip = text;
      client.clipboard(text);
    }
    function fail(e) {
      const tg = target;
      void disconnect(false);
      showSession(false);
      setInfo('error', errorText(e, tg));
      if (e?.code === 'ENEEDPASS' || e?.code === 'EAUTH') {
        if (tg) {
          setProtocol('vnc', false);
          hostIn.value = tg.host;
          portIn.value = String(tg.port);
          if (tg.entry) {
            editingId = tg.entry.id;
            nameIn.value = tg.entry.name;
            formTitle.textContent = t('form.edit');
            cancelEditBtn.hidden = false;
          }
        }
        passIn.value = '';
        passIn.focus();
      } else connectBtn.focus();
    }
    async function disconnect(user) {
      clearTimeout(handshakeTimer);
      releaseKeys();
      const id = connId;
      const was = state;
      connId = null;
      client = null;
      keyChain = null;
      state = 'idle';
      if (win.fullscreen) win.setFullscreen(false);
      win.setTitle?.(t('app.title'));
      if (id) await api.invoke('remote:close', id).catch(() => {});
      if (user) {
        seq++;
        showSession(false);
        setInfo('info', was === 'connected' ? t('session.disconnected', { host: target?.host ?? '' }) : '');
        connectBtn.focus();
      }
    }
    offs.push(
      api.on('remote:data', (msg) => {
        if (msg && msg.id === connId && client) client.receive(msg.data instanceof Uint8Array ? msg.data : new Uint8Array(msg.data || []));
      }),
      api.on('remote:closed', (msg) => {
        if (!msg || msg.id !== connId) return;
        connId = null;
        fail(msg.error?.code && msg.error.code !== 'ECONNRESET' ? msg.error : { code: state === 'connected' ? 'ECLOSED' : msg.error?.code || 'ECLOSED' });
      }),
    );

    // ------------------------------------------------------------ scaling, fullscreen
    function layout() {
      const W = canvas.width;
      const H = canvas.height;
      viewport.classList.toggle('actual', scaleMode === 'actual');
      if (scaleMode === 'actual') {
        canvas.style.width = `${W}px`;
        canvas.style.height = `${H}px`;
      } else {
        const aw = Math.max(1, viewport.clientWidth);
        const ah = Math.max(1, viewport.clientHeight);
        const s = Math.min(aw / W, ah / H);
        canvas.style.width = `${Math.max(1, Math.floor(W * s))}px`;
        canvas.style.height = `${Math.max(1, Math.floor(H * s))}px`;
      }
      for (const [m, b] of Object.entries(scaleBtns)) {
        b.classList.toggle('selected', m === scaleMode);
        b.setAttribute('aria-pressed', m === scaleMode ? 'true' : 'false');
      }
    }
    function setScale(mode) {
      scaleMode = mode === 'actual' ? 'actual' : 'fit';
      layout();
      Promise.resolve()
        .then(() => storage?.set?.('scale', scaleMode))
        .catch(() => {});
    }
    function toggleFullscreen() {
      win.setFullscreen(!win.fullscreen);
    }
    function syncFullscreen() {
      const on = !!win.fullscreen;
      root.classList.toggle('fullscreen', on);
      fsBtn.replaceChildren(icon(on ? 'full_screen_minimize' : 'full_screen_maximize'));
      fsBtn.setAttribute('aria-label', on ? t('session.exitFullscreen') : t('session.fullscreen'));
      fsBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
      requestAnimationFrame(layout);
    }
    offs.push(win.on?.('fullscreen', syncFullscreen), win.on?.('resize', () => requestAnimationFrame(layout)));
    const ro = new ResizeObserver(() => layout());
    ro.observe(viewport);
    offs.push(() => ro.disconnect());
    layout();

    // ------------------------------------------------------------ input
    function sendCad() {
      client?.ctrlAltDel();
      canvas.focus();
    }
    // Keys wait for a clipboard sync that must reach the server first (paste: the text, then the keys).
    function sendKey(ks, down) {
      if (!keyChain) return client?.key(ks, down);
      const c = client;
      const chain = keyChain.then(() => {
        if (client === c) c?.key(ks, down);
      });
      keyChain = chain;
      chain.then(() => {
        if (keyChain === chain) keyChain = null;
      });
    }
    function releaseKeys() {
      if (client) for (const ks of pressed.values()) sendKey(ks, false);
      pressed.clear();
    }
    const fbPoint = (e) => {
      const r = canvas.getBoundingClientRect();
      return [((e.clientX - r.left) * canvas.width) / Math.max(1, r.width), ((e.clientY - r.top) * canvas.height) / Math.max(1, r.height)];
    };
    // DOM buttons bitfield (1 left, 2 right, 4 middle) -> RFB (1 left, 2 middle, 4 right)
    const maskOf = (b) => (b & 1) | ((b & 4) >> 1) | ((b & 2) << 1);
    let lastMask = 0;
    const onPointer = (e) => {
      if (!client || state !== 'connected') return;
      if (e.type === 'pointerdown') {
        canvas.focus();
        canvas.setPointerCapture?.(e.pointerId);
      }
      e.preventDefault();
      lastMask = maskOf(e.buttons);
      const [x, y] = fbPoint(e);
      client.pointer(x, y, lastMask);
    };
    canvas.addEventListener('pointerdown', onPointer);
    canvas.addEventListener('pointermove', onPointer);
    canvas.addEventListener('pointerup', onPointer);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener(
      'wheel',
      (e) => {
        if (!client || state !== 'connected') return;
        e.preventDefault();
        const [x, y] = fbPoint(e);
        const bit = e.deltaY < 0 ? 8 : e.deltaY > 0 ? 16 : e.deltaX < 0 ? 32 : 64;
        client.pointer(x, y, lastMask | bit);
        client.pointer(x, y, lastMask);
      },
      { passive: false },
    );
    const isPaste = (e) => ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'v' || e.key === 'V' || e.code === 'KeyV')) || (e.shiftKey && e.key === 'Insert');
    canvas.addEventListener('keydown', (e) => {
      if (!client || state !== 'connected') return;
      if (e.ctrlKey && e.altKey && e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        releaseKeys();
        toggleFullscreen();
        return;
      }
      if (e.ctrlKey && e.altKey && e.key === 'Home') {
        e.preventDefault();
        e.stopPropagation();
        releaseKeys();
        (scaleBtns[scaleMode] || discBtn).focus();
        return;
      }
      const ks = keysymFor(e);
      if (ks == null) return;
      e.preventDefault();
      e.stopPropagation();
      if (isPaste(e) && !e.repeat && clipShare) {
        const sync = syncClipboard().catch(() => {});
        keyChain = keyChain ? keyChain.then(() => sync) : sync;
      }
      pressed.set(e.code || e.key, ks);
      sendKey(ks, true);
    });
    canvas.addEventListener('keyup', (e) => {
      if (!client) return;
      const id = e.code || e.key;
      const ks = pressed.has(id) ? pressed.get(id) : keysymFor(e);
      pressed.delete(id);
      if (ks == null) return;
      e.preventDefault();
      e.stopPropagation();
      sendKey(ks, false);
    });
    canvas.addEventListener('blur', () => releaseKeys());
    // Text copied in Selene while the remote screen was not focused: offered when it gets the focus back.
    canvas.addEventListener('focus', () => void syncClipboard());
    session.addEventListener('keydown', (e) => {
      if (e.target !== canvas && e.key === 'Escape' && win.fullscreen) {
        e.preventDefault();
        win.setFullscreen(false);
      }
    });

    // ------------------------------------------------------------ lifecycle
    win.body.__remote = {
      get state() {
        return state;
      },
      get connId() {
        return connId;
      },
      get client() {
        return client;
      },
      get scale() {
        return scaleMode;
      },
      get protocol() {
        return protocol;
      },
      get rdpSessions() {
        return [...rdpSessions.values()].map((s) => ({ id: s.id, title: s.title, host: s.host, state: s.state, win: s.win?.id ?? null }));
      },
      setScale,
      loadSaved,
    };
    win.onBeforeClose(async () => {
      seq++;
      await disconnect(false);
      for (const off of offs) {
        try {
          off?.();
        } catch {}
      }
      return true;
    });
    setProtocol('vnc', false);
    setDrive(null);
    syncOptions();
    showSession(false);
    await Promise.all([loadSaved(), checkRdp(), loadRdpSessions()]);
    if (!win.closed) hostIn.focus();
    return {
      onRelaunch() {
        win.focus();
      },
    };
  },
};
