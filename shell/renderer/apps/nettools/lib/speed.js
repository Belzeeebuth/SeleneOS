// Speed test tab: latency, jitter, download and upload measured by the backend (nettools:speed, +nettools:speed)
// against Cloudflare's speed endpoints. A gauge while it runs, a result card, and the last results (ctx.storage).
import { errMsg, numberFormat, eventStream } from './util.js';

const HISTORY_MAX = 10;
const GAUGE_MAX = 1000; // Mbit/s at the end of the (logarithmic) gauge

/** Mbit/s -> 0..1 on a log scale (1 Mbit/s, 10, 100 and 1 Gbit/s are evenly spaced). */
export function gaugeFraction(v) {
  const x = Math.max(0, Number(v) || 0);
  return Math.min(1, Math.log10(1 + x) / Math.log10(1 + GAUGE_MAX));
}

export function buildSpeed(ctx, panel) {
  const { win, h, icon, t, api, ui, storage } = ctx;
  const fmt = numberFormat(ctx);
  const SVG = 'http://www.w3.org/2000/svg';
  const svg = (tag, attrs) => {
    const el = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
    return el;
  };

  // ------------------------------------------------------------ gauge (semicircle, pathLength 100)
  const ARC = 'M 20 110 A 90 90 0 0 1 200 110';
  const track = svg('path', { d: ARC, class: 'nt-gauge-track', pathLength: '100' });
  const value = svg('path', { d: ARC, class: 'nt-gauge-value', pathLength: '100', 'stroke-dasharray': '0 100' });
  const gaugeSvg = svg('svg', { viewBox: '0 0 220 120', class: 'nt-gauge-svg', 'aria-hidden': 'true' });
  gaugeSvg.append(track, value);
  const gaugeNum = h('div', { class: 'nt-gauge-num' }, '0');
  const gaugeUnit = h('div', { class: 'nt-gauge-unit caption text-2' }, t('speed.unit'));
  const gaugePhase = h('div', { class: 'nt-gauge-phase' }, t('speed.ready'));
  const gauge = h(
    'div',
    { class: 'nt-gauge', role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': GAUGE_MAX, 'aria-valuenow': 0, 'aria-label': t('speed.gauge') },
    gaugeSvg,
    h('div', { class: 'nt-gauge-center' }, gaugeNum, gaugeUnit),
    h('div', { class: 'nt-gauge-scale caption text-2', 'aria-hidden': 'true' }, h('span', null, '0'), h('span', null, fmt(GAUGE_MAX, 0))),
  );
  const progress = h('div', { class: 'progress nt-speed-progress', 'aria-hidden': 'true' }, h('div', { class: 'bar' }));
  const startBtn = h('button', { class: 'btn primary nt-speed-start', type: 'button', dataset: { act: 'speed' }, onclick: () => start() }, icon('gauge'), h('span', null, t('speed.start')));
  const cancelBtn = h('button', { class: 'btn', type: 'button', dataset: { act: 'speed-cancel' }, hidden: true, onclick: () => cancel() }, icon('stop'), h('span', null, t('speed.cancel')));
  const status = h('div', { class: 'nt-status-line', role: 'status', 'aria-live': 'polite' });

  const stat = (key, ico) => {
    const v = h('span', { class: 'nt-stat-value' }, '–');
    const u = h('span', { class: 'nt-stat-unit caption text-2' }, t(key === 'ping' || key === 'jitter' ? 'speed.ms' : 'speed.unit'));
    const el = h('div', { class: 'nt-stat', dataset: { stat: key } }, h('div', { class: 'nt-stat-label caption text-2' }, icon(ico), h('span', null, t(`speed.${key}`))), h('div', null, v, ' ', u));
    return { el, v };
  };
  const stats = { download: stat('download', 'arrow_download'), upload: stat('upload', 'arrow_upload'), ping: stat('ping', 'timer'), jitter: stat('jitter', 'pulse') };
  const serverLine = h('div', { class: 'caption text-2 nt-server' });
  const card = h('div', { class: 'nt-speed-card', 'aria-label': t('speed.result') }, h('div', { class: 'nt-stats' }, Object.values(stats).map((s) => s.el)), serverLine);

  const historyList = h('ul', { class: 'nt-history', 'aria-label': t('speed.history') });
  const clearBtn = h('button', { class: 'btn subtle', type: 'button', dataset: { act: 'speed-clear' }, onclick: () => clearHistory() }, icon('delete'), h('span', null, t('speed.clear')));
  const historySection = h(
    'section',
    { class: 'nt-section', 'aria-labelledby': 'nt-history-title', hidden: true },
    h('div', { class: 'nt-toolbar' }, h('h2', { class: 'nt-h3', id: 'nt-history-title' }, t('speed.history')), h('div', { class: 'grow' }), clearBtn),
    historyList,
  );

  panel.append(
    h('div', { class: 'infobar nt-speed-note', role: 'note' }, icon('info'), h('span', null, t('speed.dataNote'))),
    h('div', { class: 'nt-speed-top' }, gauge, h('div', { class: 'nt-speed-side' }, gaugePhase, progress, h('div', { class: 'nt-row' }, startBtn, cancelBtn), status)),
    card,
    historySection,
  );

  let running = false;
  let history = [];
  const stream = eventStream(onEvent);
  ctx.__offs.push(api.on('nettools:speed', (ev) => !win.closed && stream.handle(ev)));

  function setGauge(mbps) {
    const f = gaugeFraction(mbps);
    value.setAttribute('stroke-dasharray', `${(f * 100).toFixed(2)} 100`);
    gaugeNum.textContent = mbps == null ? '0' : fmt(mbps, mbps < 100 ? 1 : 0);
    gauge.setAttribute('aria-valuenow', String(Math.round(Number(mbps) || 0)));
  }
  function setProgress(p) {
    progress.firstChild.style.width = `${Math.round(Math.max(0, Math.min(1, p || 0)) * 100)}%`;
  }
  function showResult(r) {
    stats.download.v.textContent = fmt(r?.download, 1);
    stats.upload.v.textContent = fmt(r?.upload, 1);
    stats.ping.v.textContent = fmt(r?.ping, 1);
    stats.jitter.v.textContent = fmt(r?.jitter, 1);
    const s = r?.server || {};
    const where = [s.city, s.country].filter(Boolean).join(', ');
    serverLine.textContent = r ? (s.colo ? t('speed.serverColo', { where: where || s.host, colo: s.colo }) : t('speed.server', { host: s.host || '' })) : '';
  }

  // Overall progress: latency 0-10 %, download 10-55 %, upload 55-100 %.
  const SPAN = { latency: [0, 0.1], download: [0.1, 0.55], upload: [0.55, 1] };
  function onEvent(ev) {
    if (ev.phase) {
      const [a, b] = SPAN[ev.phase] || [0, 1];
      setProgress(a + (b - a) * (ev.progress || 0));
      gaugePhase.textContent = t(`speed.phase.${ev.phase}`);
      gaugePhase.dataset.phase = ev.phase;
      if (ev.phase === 'latency') {
        if (ev.ping != null) stats.ping.v.textContent = fmt(ev.ping, 1);
        if (ev.jitter != null) stats.jitter.v.textContent = fmt(ev.jitter, 1);
      } else if (ev.mbps != null) {
        setGauge(ev.mbps);
        stats[ev.phase].v.textContent = fmt(ev.mbps, 1);
      }
    }
    if (ev.done) finish(ev);
  }
  function finish(ev) {
    running = false;
    stream.clear();
    startBtn.hidden = false;
    cancelBtn.hidden = true;
    gaugePhase.dataset.phase = '';
    if (ev.result) {
      setProgress(1);
      setGauge(ev.result.download);
      showResult(ev.result);
      gaugePhase.textContent = t('speed.done');
      status.className = 'nt-status-line ok';
      status.textContent = t('speed.doneStatus', { down: fmt(ev.result.download, 1), up: fmt(ev.result.upload, 1) });
      addHistory(ev.result);
    } else {
      setProgress(0);
      setGauge(0);
      gaugePhase.textContent = t('speed.ready');
      status.className = ev.cancelled ? 'nt-status-line' : 'nt-status-line bad';
      status.textContent = ev.cancelled ? t('speed.cancelled') : ev.code === 'ENOTFOUND' || ev.code === 'ENET' ? t('speed.unreachable') : t('speed.failed', { msg: ev.error || ev.code || '' });
      showResult(last());
    }
    if (document.activeElement === cancelBtn || !win.body.contains(document.activeElement)) startBtn.focus();
  }
  async function start() {
    if (running) return;
    running = true;
    startBtn.hidden = true;
    cancelBtn.hidden = false;
    cancelBtn.focus();
    setGauge(0);
    setProgress(0);
    showResult(null);
    gaugePhase.textContent = t('speed.phase.latency');
    status.className = 'nt-status-line';
    status.textContent = t('speed.running');
    stream.start();
    try {
      const res = await api.invoke('nettools:speed');
      if (win.closed) return api.invoke('nettools:speedCancel', res.id).catch(() => {});
      status.textContent = t('speed.runningHost', { host: res.host });
      stream.attach(res.id);
    } catch (e) {
      stream.abort();
      finish({ done: true, cancelled: false, code: e?.code, error: e?.code === 'EBUSY' ? t('speed.busy') : errMsg(e) });
    }
  }
  function cancel() {
    if (stream.id != null) api.invoke('nettools:speedCancel', stream.id).catch(() => {});
  }

  // ------------------------------------------------------------ history (ctx.storage 'speedHistory')
  const last = () => history[0] || null;
  function renderHistory() {
    historySection.hidden = !history.length;
    const df = new Intl.DateTimeFormat(ctx.i18n?.locale || 'en-US', { dateStyle: 'medium', timeStyle: 'short' });
    historyList.replaceChildren(
      ...history.map((r) =>
        h(
          'li',
          { class: 'nt-history-row', 'aria-label': t('speed.historyRow', { date: df.format(new Date(r.at)), down: fmt(r.download, 1), up: fmt(r.upload, 1), ping: fmt(r.ping, 0) }) },
          h('span', { class: 'nt-history-date' }, df.format(new Date(r.at))),
          h('span', { class: 'nt-history-v', title: t('speed.download') }, icon('arrow_download'), ` ${fmt(r.download, 1)}`),
          h('span', { class: 'nt-history-v', title: t('speed.upload') }, icon('arrow_upload'), ` ${fmt(r.upload, 1)}`),
          h('span', { class: 'nt-history-v caption text-2' }, t('speed.pingShort', { ms: fmt(r.ping, 0) })),
          h('span', { class: 'nt-history-v caption text-2' }, r.server?.colo || r.server?.host || ''),
        ),
      ),
    );
  }
  function save() {
    Promise.resolve()
      .then(() => storage?.set?.('speedHistory', history))
      .catch(() => {});
  }
  function addHistory(r) {
    const entry = { at: r.at || Date.now(), download: r.download, upload: r.upload, ping: r.ping, jitter: r.jitter, server: { colo: r.server?.colo || '', city: r.server?.city || '', country: r.server?.country || '', host: r.server?.host || '' } };
    history = [entry, ...history].slice(0, HISTORY_MAX);
    renderHistory();
    save();
  }
  async function clearHistory() {
    const ok = await ui.confirm(t('speed.clearBody'), { title: t('speed.clearTitle'), okLabel: t('speed.clear'), danger: true, parent: win });
    if (!ok || win.closed) return;
    history = [];
    renderHistory();
    save();
    startBtn.focus();
  }
  (async () => {
    try {
      const saved = await storage?.get?.('speedHistory', []);
      if (Array.isArray(saved)) history = saved.filter((r) => r && typeof r === 'object' && Number.isFinite(r.at)).slice(0, HISTORY_MAX);
    } catch {}
    if (win.closed) return;
    renderHistory();
    if (!running) showResult(last());
  })();

  return {
    cancel,
    get running() {
      return running;
    },
  };
}
