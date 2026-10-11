// Remote Desktop: VNC (RFB 3.8) viewer. RDP is planned for a later version.
// The TCP bytes go through main/ipc/remote.js (the renderer has no network access); the protocol is lib/rfb.js.
// Test hooks: the window body element gets __remote.
import { RfbClient } from './lib/rfb.js';
import { keysymFor } from './lib/keysym.js';

const HANDSHAKE_MS = 15000;

export default {
  async launch(ctx) {
    const { win, h, icon, ui, t, api, storage } = ctx;
    const offs = [];
    const winKey = `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    let scaleMode = 'fit';
    try {
      const s = await storage?.get?.('scale', 'fit');
      if (s === 'fit' || s === 'actual') scaleMode = s;
    } catch {}

    // ------------------------------------------------------------ home view: form + saved connections
    const info = h('div', { class: 'rd-info', 'aria-live': 'polite' });
    const field = (id, label, input, hint) =>
      h('div', { class: 'field' }, h('label', { for: `rd-${id}-${winKey}` }, label), input, hint ? h('div', { class: 'field-hint', id: `rd-${id}-hint-${winKey}` }, hint) : '');
    const hostIn = h('input', { class: 'input', id: `rd-host-${winKey}`, name: 'host', autocomplete: 'off', spellcheck: 'false', placeholder: t('form.hostPlaceholder') });
    const portIn = h('input', { class: 'input', id: `rd-port-${winKey}`, name: 'port', inputmode: 'numeric', value: '5900' });
    const nameIn = h('input', { class: 'input', id: `rd-name-${winKey}`, name: 'name', autocomplete: 'off', placeholder: t('form.namePlaceholder') });
    const passIn = h('input', { class: 'input', id: `rd-pass-${winKey}`, name: 'password', type: 'password', autocomplete: 'off' });
    const rememberIn = h('input', { type: 'checkbox', name: 'remember' });
    const formTitle = h('h2', { class: 'rd-h2' }, t('form.new'));
    const cancelEditBtn = h('button', { type: 'button', class: 'btn subtle', hidden: true, dataset: { act: 'cancel-edit' }, onclick: () => editEntry(null) }, t('form.cancelEdit'));
    const connectBtn = h('button', { type: 'submit', class: 'btn primary', dataset: { act: 'connect' } }, icon('plug_connected'), h('span', null, t('form.connect')));
    const saveBtn = h('button', { type: 'button', class: 'btn', dataset: { act: 'save' }, onclick: () => saveForm() }, icon('star_add'), h('span', null, t('form.save')));
    const form = h(
      'form',
      { class: 'card rd-form', novalidate: true, onsubmit: (e) => (e.preventDefault(), connectFromForm()) },
      h('div', { class: 'rd-form-head' }, formTitle, h('div', { class: 'grow' }), cancelEditBtn),
      h('div', { class: 'field' }, h('span', { class: 'rd-label' }, t('form.protocol')), h('div', { class: 'rd-proto' }, h('span', { class: 'badge rd-proto-badge' }, 'VNC'), h('span', { class: 'caption text-2' }, t('form.rdpLater')))),
      h('div', { class: 'rd-row' }, field('host', t('form.host'), hostIn), h('div', { class: 'rd-port' }, field('port', t('form.port'), portIn))),
      field('name', t('form.name'), nameIn),
      field('pass', t('form.password'), passIn, t('form.passwordHint')),
      h('label', { class: 'checkbox rd-remember' }, rememberIn, h('span', null, t('form.remember'))),
      h('div', { class: 'rd-actions' }, connectBtn, saveBtn),
    );
    const savedList = h('div', { class: 'rd-saved-list', role: 'list', 'aria-label': t('saved.title') });
    const savedCard = h('section', { class: 'card rd-saved' }, h('h2', { class: 'rd-h2' }, t('saved.title')), savedList);
    const home = h(
      'div',
      { class: 'rd-home' },
      h('div', { class: 'rd-hero' }, h('img', { class: 'rd-hero-icon', src: new URL('./icon.svg', import.meta.url).href, alt: '' }), h('div', null, h('h1', { class: 'rd-h1' }, t('app.title')), h('p', { class: 'caption text-2' }, t('app.subtitle')))),
      info,
      h('div', { class: 'rd-grid' }, form, savedCard),
    );

    // ------------------------------------------------------------ session view
    const canvas = h('canvas', { class: 'rd-canvas', tabindex: '0', width: 1, height: 1, 'aria-label': t('session.screen'), 'aria-roledescription': t('session.screenRole') });
    const g = canvas.getContext('2d', { alpha: false });
    const overlayText = h('div', { class: 'rd-overlay-text' });
    const overlay = h('div', { class: 'rd-overlay', role: 'status' }, h('div', { class: 'spinner' }), overlayText);
    const viewport = h('div', { class: 'rd-viewport' }, canvas, overlay);
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
    function setInfo(kind, text) {
      info.replaceChildren(
        text
          ? h('div', { class: `infobar ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, icon(kind === 'error' ? 'error_circle' : kind === 'success' ? 'checkmark_circle' : 'info'), h('span', { class: 'rd-info-text' }, text))
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
    function readForm() {
      let host = hostIn.value.trim();
      if (/^\[.*\]$/.test(host)) host = host.slice(1, -1);
      const portStr = portIn.value.trim() || '5900';
      const port = /^\d{1,5}$/.test(portStr) ? Number(portStr) : 0;
      hostIn.removeAttribute('aria-invalid');
      portIn.removeAttribute('aria-invalid');
      if (!hostKind(host)) {
        hostIn.setAttribute('aria-invalid', 'true');
        setInfo('error', host ? t('err.invalidHost') : t('err.noHost'));
        hostIn.focus();
        return null;
      }
      if (!(port >= 1 && port <= 65535)) {
        portIn.setAttribute('aria-invalid', 'true');
        setInfo('error', t('err.invalidPort'));
        portIn.focus();
        return null;
      }
      return { host, port, name: nameIn.value.trim(), password: passIn.value, remember: rememberIn.checked };
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
    function renderSaved() {
      if (!saved.length) {
        savedList.replaceChildren(h('div', { class: 'empty rd-empty' }, icon('desktop'), h('div', null, t('saved.empty'))));
        return;
      }
      savedList.replaceChildren(
        ...saved.map((c) =>
          h(
            'div',
            { class: 'rd-item', role: 'listitem', dataset: { id: c.id } },
            h('div', { class: 'rd-item-icon' }, icon('desktop')),
            h('div', { class: 'rd-item-text' }, h('div', { class: 'rd-item-name ellipsis' }, c.name), h('div', { class: 'rd-item-addr caption text-2 ellipsis' }, `VNC · ${c.host}:${c.port}`, c.remember ? ` · ${t('saved.remembered')}` : '')),
            h('button', { class: 'btn primary rd-item-connect', dataset: { act: 'connect-saved' }, 'aria-label': t('saved.connectTo', { name: c.name }), onclick: () => connectSaved(c) }, t('form.connect')),
            h('button', { class: 'btn subtle icon-btn', dataset: { act: 'edit' }, 'aria-label': t('saved.edit', { name: c.name }), 'data-tip': t('saved.editTip'), onclick: () => editEntry(c) }, icon('edit')),
            h('button', { class: 'btn subtle icon-btn', dataset: { act: 'delete' }, 'aria-label': t('saved.delete', { name: c.name }), 'data-tip': t('saved.deleteTip'), onclick: () => removeEntry(c) }, icon('delete')),
          ),
        ),
      );
    }
    function editEntry(c) {
      editingId = c?.id || null;
      formTitle.textContent = c ? t('form.edit') : t('form.new');
      cancelEditBtn.hidden = !c;
      hostIn.value = c?.host || '';
      portIn.value = String(c?.port || 5900);
      nameIn.value = c?.name || '';
      passIn.value = '';
      rememberIn.checked = !!c?.remember;
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
    async function connectSaved(c) {
      let password = '';
      if (c.remember) {
        try {
          password = await api.invoke('remote:secret', c.id);
        } catch {}
      }
      connect({ host: c.host, port: c.port, name: c.name, password, entry: c });
    }
    function connectFromForm() {
      const f = readForm();
      if (f) connect({ ...f, entry: editingId ? saved.find((s) => s.id === editingId) : null });
    }

    // ------------------------------------------------------------ connection
    let connId = null;
    let client = null;
    let target = null;
    let seq = 0;
    let handshakeTimer = 0;
    let state = 'idle'; // idle | connecting | connected
    const pressed = new Map();

    function showSession(on) {
      home.hidden = on;
      session.hidden = !on;
    }
    async function connect(tg) {
      await disconnect(false);
      const my = ++seq;
      target = tg;
      state = 'connecting';
      const label = tg.name || tg.host;
      sessTitle.textContent = label;
      sessStatus.textContent = `VNC · ${tg.host}:${tg.port}`;
      overlayText.textContent = t('session.connecting', { host: tg.host });
      overlay.hidden = false;
      canvas.hidden = true;
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
        onResize: (w, hh) => {
          canvas.width = w;
          canvas.height = hh;
          sessStatus.textContent = `VNC · ${tg.host}:${tg.port} · ${w} × ${hh}`;
          layout();
        },
        onError: (e) => fail(e),
      });
      api.send('remote:resume', id);
      clearTimeout(handshakeTimer);
      handshakeTimer = setTimeout(() => {
        if (connId === id && state !== 'connected') fail({ code: 'ETIMEDOUT' });
      }, HANDSHAKE_MS);
    }
    function fail(e) {
      const tg = target;
      void disconnect(false);
      showSession(false);
      setInfo('error', errorText(e, tg));
      if (e?.code === 'ENEEDPASS' || e?.code === 'EAUTH') {
        if (tg) {
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
    function releaseKeys() {
      if (client) for (const ks of pressed.values()) client.key(ks, false);
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
      pressed.set(e.code || e.key, ks);
      client.key(ks, true);
    });
    canvas.addEventListener('keyup', (e) => {
      if (!client) return;
      const id = e.code || e.key;
      const ks = pressed.has(id) ? pressed.get(id) : keysymFor(e);
      pressed.delete(id);
      if (ks == null) return;
      e.preventDefault();
      e.stopPropagation();
      client.key(ks, false);
    });
    canvas.addEventListener('blur', () => releaseKeys());
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
    showSession(false);
    await loadSaved();
    if (!win.closed) hostIn.focus();
    return {
      onRelaunch() {
        win.focus();
      },
    };
  },
};
