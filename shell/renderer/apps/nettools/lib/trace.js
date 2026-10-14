// Traceroute tab: tracepath (or traceroute) streamed hop by hop by the backend (nettools:trace, +nettools:trace).
import { hostKind, errMsg, numberFormat, copyText, eventStream } from './util.js';

export function buildTrace(ctx, panel) {
  const { win, h, icon, t, api } = ctx;
  const fmt = numberFormat(ctx);
  const input = h('input', { class: 'input grow', id: 'nt-trace-host', placeholder: t('trace.placeholder'), spellcheck: false, autocomplete: 'off', maxLength: 253 });
  const family = h(
    'select',
    { class: 'select', id: 'nt-trace-family', 'aria-label': t('trace.family') },
    h('option', { value: 'auto' }, t('trace.familyAuto')),
    h('option', { value: '4' }, 'IPv4'),
    h('option', { value: '6' }, 'IPv6'),
  );
  const maxHops = h('input', { class: 'input nt-num', id: 'nt-trace-max', type: 'number', min: 1, max: 64, value: 30, 'aria-label': t('trace.maxHops') });
  const startBtn = h('button', { class: 'btn primary', type: 'submit', dataset: { act: 'trace' } }, icon('play'), h('span', null, t('trace.start')));
  const cancelBtn = h('button', { class: 'btn', type: 'button', dataset: { act: 'trace-cancel' }, disabled: true, onclick: () => cancel() }, icon('stop'), h('span', null, t('trace.cancel')));
  const copyBtn = h('button', { class: 'btn subtle', type: 'button', dataset: { act: 'trace-copy' }, disabled: true, 'data-tip': t('trace.copy'), onclick: (e) => copyText(ctx, asText(), e.currentTarget, t('trace.copied')) }, icon('copy'), h('span', null, t('trace.copy')));
  const status = h('div', { class: 'nt-status-line', role: 'status', 'aria-live': 'polite' });
  const list = h('ol', { class: 'nt-hops', 'aria-label': t('trace.hops') });
  panel.append(
    h(
      'form',
      { class: 'nt-form', onsubmit: (e) => (e.preventDefault(), start()) },
      h('label', { class: 'nt-label', for: 'nt-trace-host' }, t('trace.host')),
      h('div', { class: 'nt-row' }, input, startBtn, cancelBtn),
      h(
        'div',
        { class: 'nt-row nt-options' },
        h('label', { class: 'nt-inline', for: 'nt-trace-family' }, t('trace.family')),
        family,
        h('label', { class: 'nt-inline', for: 'nt-trace-max' }, t('trace.maxHops')),
        maxHops,
        h('div', { class: 'grow' }),
        copyBtn,
      ),
    ),
    status,
    list,
  );

  let hops = new Map(); // n -> hop
  let host = '';
  let tool = '';
  let running = false;
  const stream = eventStream(onEvent);
  ctx.__offs.push(api.on('nettools:trace', (ev) => !win.closed && stream.handle(ev)));

  function hopLabel(hop) {
    if (!hop.ip) return t('trace.noReply');
    return hop.host ? `${hop.host} (${hop.ip})` : hop.ip;
  }
  function render() {
    const all = [...hops.values()].sort((a, b) => a.n - b.n);
    const maxMs = Math.max(1, ...all.flatMap((x) => x.ms || []));
    list.replaceChildren(
      ...all.map((hop) => {
        const ms = hop.ms?.length ? Math.min(...hop.ms) : null;
        const times = [...(hop.ms || []).map((x) => `${fmt(x, x < 10 ? 2 : 1)} ms`), ...Array.from({ length: hop.timeouts || 0 }, () => '*')];
        return h(
          'li',
          { class: ['nt-hop', !hop.ip && 'timeout', hop.reached && 'reached'], dataset: { n: hop.n } },
          h('span', { class: 'nt-hop-dot', 'aria-hidden': 'true' }, hop.reached ? icon('flag') : null),
          h('span', { class: 'nt-hop-n' }, String(hop.n)),
          h(
            'div',
            { class: 'nt-hop-main' },
            h('div', { class: 'nt-hop-name' }, hop.ip ? hop.host || hop.ip : t('trace.noReply')),
            hop.ip && hop.host ? h('div', { class: 'nt-hop-ip caption text-2 selectable' }, hop.ip) : null,
          ),
          h('div', { class: 'nt-hop-bar', 'aria-hidden': 'true' }, ms != null ? h('span', { style: { width: `${Math.max(2, Math.round((ms / maxMs) * 100))}%` } }) : null),
          h('span', { class: 'nt-hop-ms' }, times.join('  ') || '*'),
        );
      }),
    );
    copyBtn.disabled = !all.length;
  }
  function asText() {
    const all = [...hops.values()].sort((a, b) => a.n - b.n);
    return [t('trace.copyHeader', { host }), ...all.map((hop) => `${String(hop.n).padStart(2)}  ${hop.ip ? hopLabel(hop) : '*'}  ${[...(hop.ms || []).map((x) => `${x} ms`), ...Array.from({ length: hop.timeouts || 0 }, () => '*')].join('  ')}`)].join('\n') + '\n';
  }
  function onEvent(ev) {
    if (ev.hop && Number.isInteger(ev.hop.n)) {
      const prev = hops.get(ev.hop.n);
      // tracepath may print a hop twice (pmtu change): keep the line with an address.
      if (!prev || ev.hop.ip || !prev.ip) hops.set(ev.hop.n, ev.hop);
      render();
      list.lastElementChild?.scrollIntoView?.({ block: 'nearest' });
    }
    if (ev.done) {
      running = false;
      stream.clear();
      startBtn.disabled = false;
      cancelBtn.disabled = true;
      const count = hops.size;
      if (ev.cancelled) {
        status.className = 'nt-status-line';
        status.textContent = t('trace.cancelled');
      } else if (ev.reached) {
        status.className = 'nt-status-line ok';
        status.textContent = t('trace.reached', { host, count });
      } else if (ev.error && !count) {
        status.className = 'nt-status-line bad';
        status.textContent = /not known|resolve|unknown host/i.test(ev.error) ? t('trace.unknownHost', { host }) : t('trace.failed', { msg: ev.error });
      } else {
        status.className = 'nt-status-line bad';
        status.textContent = t('trace.notReached', { host, count });
      }
      if (document.activeElement === cancelBtn || !win.body.contains(document.activeElement)) input.focus();
    }
  }
  async function start() {
    if (running) return;
    const target = input.value.trim();
    const kind = hostKind(target);
    const fam = family.value;
    const max = Math.round(Number(maxHops.value));
    let bad = !kind ? t('trace.invalid') : null;
    if (!bad && ((fam === '4' && kind === 'ipv6') || (fam === '6' && kind === 'ipv4'))) bad = t('trace.familyMismatch');
    if (!bad && !(max >= 1 && max <= 64)) bad = t('trace.badMax');
    if (bad) {
      status.className = 'nt-status-line bad';
      status.textContent = bad;
      (bad === t('trace.badMax') ? maxHops : input).setAttribute('aria-invalid', 'true');
      (bad === t('trace.badMax') ? maxHops : input).focus();
      return;
    }
    input.removeAttribute('aria-invalid');
    maxHops.removeAttribute('aria-invalid');
    host = target;
    hops = new Map();
    render();
    running = true;
    startBtn.disabled = true;
    status.className = 'nt-status-line';
    status.textContent = t('trace.running', { host, max });
    stream.start();
    try {
      const res = await api.invoke('nettools:trace', target, { maxHops: max, family: fam });
      if (win.closed) return api.invoke('nettools:traceCancel', res.id).catch(() => {});
      tool = res.tool || '';
      cancelBtn.disabled = false;
      stream.attach(res.id);
    } catch (e) {
      stream.abort();
      running = false;
      startBtn.disabled = false;
      status.className = 'nt-status-line bad';
      status.textContent = e?.code === 'EINVAL' ? t('trace.invalid') : e?.code === 'ENOENT' ? t('trace.noTool') : t('trace.failed', { msg: errMsg(e) });
    }
  }
  function cancel() {
    if (stream.id != null) api.invoke('nettools:traceCancel', stream.id).catch(() => {});
  }
  return {
    cancel,
    get running() {
      return running;
    },
    get tool() {
      return tool;
    },
  };
}
