// Ports tab: « Check a port » (TCP connect test from the main process, nettools:portCheck) and « Open ports on this
// computer » (listening sockets from ss, nettools:listening).
import { hostKind, errMsg, numberFormat } from './util.js';

// Common services menu: label, ports.
const COMMON = [
  ['SSH', '22'],
  ['HTTP', '80'],
  ['HTTPS', '443'],
  ['RDP', '3389'],
  ['VNC', '5900'],
  ['SMB', '445'],
  ['FTP', '21'],
  ['SMTP', '25, 587'],
  ['IMAPS', '993'],
  ['DNS', '53'],
  ['OpenVPN (TCP)', '1194'],
  ['Minecraft', '25565'],
];
const STATUS_ICON = { open: 'checkmark_circle', closed: 'dismiss_circle', filtered: 'timer', unreachable: 'warning', error: 'warning', cancelled: 'dismiss_circle' };

export function buildPorts(ctx, panel) {
  const { win, h, icon, t, api, ui } = ctx;
  const fmt = numberFormat(ctx);

  // ------------------------------------------------------------ check a port
  const hostIn = h('input', { class: 'input grow', id: 'nt-port-host', placeholder: t('ports.hostPlaceholder'), spellcheck: false, autocomplete: 'off', maxLength: 253 });
  const portsIn = h('input', { class: 'input nt-ports-in', id: 'nt-port-list', placeholder: t('ports.portsPlaceholder'), spellcheck: false, autocomplete: 'off', maxLength: 200, value: '22, 80, 443' });
  const servicesBtn = h(
    'button',
    { class: 'btn', type: 'button', dataset: { act: 'services' }, 'aria-haspopup': 'menu', onclick: (e) => servicesMenu(e) },
    icon('list'),
    h('span', null, t('ports.common')),
  );
  const timeoutSel = h(
    'select',
    { class: 'select', id: 'nt-port-timeout', 'aria-label': t('ports.timeout') },
    [1000, 3000, 5000].map((ms) => h('option', { value: ms, selected: ms === 3000 }, t('ports.seconds', { n: ms / 1000 }))),
  );
  const checkBtn = h('button', { class: 'btn primary', type: 'submit', dataset: { act: 'port-check' } }, icon('plugs'), h('span', null, t('ports.check')));
  const status = h('div', { class: 'nt-status-line', role: 'status', 'aria-live': 'polite' });
  const results = h('ul', { class: 'nt-port-results', 'aria-label': t('ports.results') });

  // ------------------------------------------------------------ listening sockets
  const refreshBtn = h('button', { class: 'btn subtle icon-btn', type: 'button', dataset: { act: 'listen-refresh' }, 'aria-label': t('ports.refresh'), 'data-tip': t('ports.refresh'), onclick: () => loadListening() }, icon('arrow_clockwise'));
  const listenStatus = h('div', { class: 'nt-status-line', role: 'status', 'aria-live': 'polite' });
  const listenList = h('ul', { class: 'nt-listen', 'aria-label': t('ports.localTitle') });
  const hiddenNote = h('div', { class: 'caption text-2 nt-note', hidden: true }, icon('info'), h('span', null, t('ports.hiddenNote')));

  panel.append(
    h(
      'section',
      { class: 'nt-section', 'aria-labelledby': 'nt-port-title' },
      h('h2', { class: 'nt-h3', id: 'nt-port-title' }, t('ports.checkTitle')),
      h(
        'form',
        { class: 'nt-form', onsubmit: (e) => (e.preventDefault(), check()) },
        h(
          'div',
          { class: 'nt-grid2' },
          h('div', { class: 'nt-field' }, h('label', { class: 'nt-label', for: 'nt-port-host' }, t('ports.host')), hostIn),
          h('div', { class: 'nt-field' }, h('label', { class: 'nt-label', for: 'nt-port-list' }, t('ports.ports')), h('div', { class: 'nt-row nt-nowrap' }, portsIn, servicesBtn)),
        ),
        h('div', { class: 'nt-row nt-options' }, h('label', { class: 'nt-inline', for: 'nt-port-timeout' }, t('ports.timeout')), timeoutSel, h('div', { class: 'grow' }), checkBtn),
      ),
      status,
      results,
    ),
    h(
      'section',
      { class: 'nt-section', 'aria-labelledby': 'nt-listen-title' },
      h('div', { class: 'nt-toolbar' }, h('h2', { class: 'nt-h3', id: 'nt-listen-title' }, t('ports.localTitle')), h('div', { class: 'grow' }), refreshBtn),
      listenStatus,
      listenList,
      hiddenNote,
    ),
  );

  function servicesMenu(e) {
    const r = servicesBtn.getBoundingClientRect();
    ui.menu({ x: r.left, y: r.bottom + 4 }, [
      ...COMMON.map(([label, p]) => ({ label: `${label} — ${p}`, action: () => setPorts(p) })),
      '-',
      { label: t('ports.allCommon'), action: () => setPorts('21, 22, 25, 53, 80, 443, 445, 587, 993, 1194, 3389, 5900') },
    ]);
    void e;
  }
  function setPorts(p) {
    portsIn.value = p;
    portsIn.removeAttribute('aria-invalid');
    portsIn.focus();
  }

  /** "22, 80 8000-8010" -> [ports] or null (same rules as the backend: at most 64 ports). */
  function parsePorts(input) {
    const out = [];
    const parts = String(input || '').split(/[\s,;]+/).filter(Boolean);
    if (!parts.length) return null;
    for (const p of parts) {
      const m = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(p);
      if (!m) return null;
      const a = Number(m[1]);
      const b = m[2] ? Number(m[2]) : a;
      if (a < 1 || b > 65535 || b < a || b - a > 64) return null;
      for (let x = a; x <= b; x++) if (!out.includes(x)) out.push(x);
      if (out.length > 64) return null;
    }
    return out;
  }

  let seq = 0;
  async function check() {
    const host = hostIn.value.trim();
    const list = parsePorts(portsIn.value);
    const my = ++seq;
    results.replaceChildren();
    hostIn.removeAttribute('aria-invalid');
    portsIn.removeAttribute('aria-invalid');
    if (!hostKind(host)) return invalid(hostIn, t('ports.invalidHost'));
    if (!list) return invalid(portsIn, t('ports.invalidPorts'));
    status.className = 'nt-status-line';
    status.textContent = t('ports.checking', { host, count: list.length });
    checkBtn.disabled = true;
    try {
      const res = await api.invoke('nettools:portCheck', host, list, { timeout: Number(timeoutSel.value) });
      if (my !== seq || win.closed) return;
      const open = res.results.filter((r) => r.status === 'open').length;
      status.className = 'nt-status-line';
      status.textContent = res.ip && res.ip !== host ? t('ports.summaryResolved', { host, ip: res.ip, count: open, total: res.results.length }) : t('ports.summary', { host, count: open, total: res.results.length });
      results.replaceChildren(
        ...res.results.map((r) =>
          h(
            'li',
            { class: ['nt-port', `st-${r.status}`], dataset: { port: r.port, status: r.status } },
            h('span', { class: 'nt-port-n' }, String(r.port)),
            h('span', { class: 'nt-port-svc caption text-2' }, r.service || ''),
            h('span', { class: 'nt-pill' }, icon(STATUS_ICON[r.status] || 'warning'), h('span', null, t(`ports.st.${r.status}`))),
            h('span', { class: 'nt-port-ms caption text-2' }, r.status === 'open' && r.ms != null ? `${fmt(r.ms, r.ms < 10 ? 2 : 1)} ms` : r.status === 'filtered' ? t('ports.noAnswer') : r.code && r.status !== 'closed' ? r.code : ''),
          ),
        ),
      );
    } catch (e) {
      if (my !== seq || win.closed) return;
      status.className = 'nt-status-line bad';
      status.textContent = e?.code === 'ENOTFOUND' ? t('ports.notFound', { host }) : e?.code === 'EINVAL' ? t('ports.invalidPorts') : t('ports.failed', { msg: errMsg(e) });
    } finally {
      if (my === seq) checkBtn.disabled = false;
    }
  }
  function invalid(el, msg) {
    status.className = 'nt-status-line bad';
    status.textContent = msg;
    el.setAttribute('aria-invalid', 'true');
    el.focus();
  }

  let listenSeq = 0;
  let loaded = false;
  async function loadListening() {
    const my = ++listenSeq;
    loaded = true;
    listenStatus.className = 'nt-status-line';
    listenStatus.textContent = t('ports.loading');
    refreshBtn.disabled = true;
    try {
      const res = await api.invoke('nettools:listening');
      if (my !== listenSeq || win.closed) return;
      const items = Array.isArray(res.items) ? res.items : [];
      listenStatus.textContent = items.length ? t('ports.localCount', { count: items.length }) : t('ports.localNone');
      hiddenNote.hidden = !res.hidden;
      listenList.replaceChildren(
        ...items.map((it) => {
          const proc = it.processes?.length ? it.processes.map((p) => `${p.name} (${p.pid})`).join(', ') : t('ports.hidden');
          const v6 = String(it.addr || '').includes(':') && it.scope !== 'address';
          const scope = `${it.scope === 'local' ? t('ports.scopeLocal') : it.scope === 'all' ? t('ports.scopeAll') : t('ports.scopeAddress', { addr: it.addr })}${v6 ? ' · IPv6' : ''}`;
          return h(
            'li',
            { class: ['nt-listen-row', `scope-${it.scope}`], dataset: { port: it.port, proto: it.proto } },
            h('span', { class: 'nt-proto' }, it.proto.toUpperCase()),
            h('span', { class: 'nt-port-n' }, String(it.port)),
            h('span', { class: 'nt-port-svc caption text-2' }, it.service || ''),
            h('span', { class: 'nt-scope', title: it.addr ? `${it.addr}${it.iface ? `%${it.iface}` : ''}` : '*' }, icon(it.scope === 'all' ? 'globe' : it.scope === 'local' ? 'desktop' : 'network'), h('span', null, scope)),
            h('span', { class: ['nt-proc', !it.processes?.length && 'text-2'] }, proc),
          );
        }),
      );
    } catch (e) {
      if (my !== listenSeq || win.closed) return;
      listenList.replaceChildren();
      listenStatus.className = 'nt-status-line bad';
      listenStatus.textContent = e?.code === 'ENOENT' ? t('ports.noSs') : t('ports.failed', { msg: errMsg(e) });
    } finally {
      if (my === listenSeq) refreshBtn.disabled = false;
    }
  }

  return {
    shown() {
      if (!loaded) loadListening();
    },
    loadListening,
  };
}
