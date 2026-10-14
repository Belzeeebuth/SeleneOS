// Disks › « Santé du disque »: overall status, key figures, plain-language indicators, self-tests and the expert
// attribute table for the selected drive. Data: main/ipc/disks.js (disks:health*, disks:selftest*, disks:smartctlImport;
// model in main/ipc/disks-smart.js). The « Attention or worse » notification itself is shown by
// core/features/disk-health.js when disks:healthCheck reports a new alert (here: when the app opens).
// Self-test history (tests started from this app, per drive): app storage 'selftests' { driveKey: [entry…] }.

const STATUS_ICON = { good: 'shield-check', warning: 'shield-warning', failing: 'shield_error', unknown: 'question_circle' };
const KNOWN_ATTRS = new Set([1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12, 13, 170, 171, 172, 173, 174, 177, 179, 180, 181, 182, 183, 184, 187, 188, 189, 190, 191, 192, 193, 194, 195, 196, 197, 198, 199, 200, 202, 231, 232, 233, 235, 241, 242]);
const NVME_KEYS = new Set(['temperature', 'avail_spare', 'spare_thresh', 'percent_used', 'total_data_read', 'total_data_written', 'ctrl_busy_time', 'power_cycles', 'unsafe_shutdowns', 'media_errors', 'num_err_log_entries', 'warning_temp_time', 'critical_temp_time', 'wctemp', 'cctemp']);
const HISTORY_MAX = 8;

export function createHealth({ ctx, state, renderList, renderMain, size, nf, lang, driveName }) {
  const { win, h, icon, t, api, shell } = ctx;
  let pollTimer = null;
  let history = {};
  const historyReady = Promise.resolve(ctx.storage?.get('selftests', {}))
    .then((v) => {
      history = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    })
    .catch(() => {});
  const saveHistory = () => Promise.resolve(ctx.storage?.set('selftests', history)).catch(() => {});

  // ------------------------------------------------------------ data
  /** Every drive's health from udisks' cached data; the backend announces new problems once (disks:health-alert). */
  async function check() {
    try {
      const r = await api.invoke('disks:healthCheck');
      if (win.closed) return;
      for (const x of r?.drives || []) if (!state.healthFresh[x.device]) update(x);
    } catch (e) {
      console.warn('[disks] health check failed', e);
    }
  }
  function update(nh) {
    if (!nh?.device) return;
    const prev = state.health[nh.device];
    state.health[nh.device] = nh;
    reconcile(nh, prev);
  }
  async function load(d, { refresh = true, wake = false } = {}) {
    if (!d) return;
    state.healthLoading = d.path;
    renderMain();
    try {
      const nh = await api.invoke('disks:health', d.path, { refresh, wake });
      if (win.closed) return;
      update(nh);
      state.healthFresh[d.path] = Date.now();
      state.healthError = '';
    } catch (e) {
      if (win.closed) return;
      state.healthError = t('health.readFailed', { msg: e?.message || String(e) });
    }
    state.healthLoading = '';
    renderList();
    renderMain();
    schedulePoll();
  }
  /** The view shows a drive: read it if we have nothing recent (a minute). */
  function ensure(d) {
    if (!d || state.healthLoading === d.path) return;
    const at = state.healthFresh[d.path] || 0;
    if (Date.now() - at > 60000) load(d, { refresh: true });
  }

  // Self-test bookkeeping: an entry is added when the app starts a test and completed when the drive reports a result.
  function reconcile(nh, prev) {
    const list = history[nh.key];
    const pending = Array.isArray(list) && list[0] && list[0].result == null ? list[0] : null;
    if (!pending) return;
    const st = nh.selftest || {};
    if (st.running) {
      if (!pending.seen) {
        pending.seen = true;
        saveHistory();
      }
      return;
    }
    // Right after the start udisks may still show the previous result for a moment: only conclude once the test was
    // seen running, or after a minute.
    if (!(pending.seen || Date.now() - pending.started > 60000) || !st.last) return;
    pending.result = st.last;
    pending.detail = st.lastDetail || null;
    pending.ended = Date.now();
    saveHistory();
    if (prev?.selftest?.running) {
      const d = state.drives.find((x) => x.path === nh.device);
      state.healthNote = { kind: st.last === 'success' ? 'success' : st.last === 'failed' ? 'error' : 'info', text: t('st.done', { name: d ? driveName(d) : nh.device, result: resultText(st.last, st.lastDetail) }), device: nh.device };
      // A failed test can change the drive's status: let the backend announce it (once).
      check();
    }
  }
  function schedulePoll() {
    clearTimeout(pollTimer);
    if (win.closed) return;
    const running = Object.values(state.health).filter((x) => x?.selftest?.running && x.source === 'udisks');
    if (!running.length) return;
    pollTimer = setTimeout(async () => {
      for (const x of running) {
        try {
          const nh = await api.invoke('disks:health', x.device);
          if (win.closed) return;
          update(nh);
        } catch {}
      }
      renderList();
      if (state.view === 'health') renderMain();
      schedulePoll();
    }, state.pollMs);
  }

  async function startTest(d, type) {
    const hl = state.health[d.path];
    state.healthNote = null;
    try {
      const nh = await api.invoke('disks:selftestStart', d.path, type);
      if (win.closed) return;
      await historyReady;
      const list = (history[nh.key || hl?.key] = Array.isArray(history[nh.key || hl?.key]) ? history[nh.key || hl?.key] : []);
      list.unshift({ type, started: Date.now(), result: null, seen: !!nh.selftest?.running });
      list.splice(HISTORY_MAX);
      saveHistory();
      update(nh);
      state.healthNote = { kind: 'info', text: t('st.started', { type: t(`st.${type}`), name: driveName(d) }), device: d.path };
    } catch (e) {
      if (win.closed) return;
      const msg = e?.message || String(e);
      const text = { ENOTAUTH: t('st.denied'), EBUSY: t('st.busy'), ENOTSUP: t('st.unsupported') }[e?.code] || t('st.startFailed', { msg });
      state.healthNote = { kind: 'error', text, device: d.path };
    }
    renderList();
    renderMain();
    schedulePoll();
  }
  async function stopTest(d) {
    state.healthNote = null;
    try {
      const nh = await api.invoke('disks:selftestAbort', d.path);
      if (win.closed) return;
      update(nh);
      state.healthNote = { kind: 'info', text: t('st.stopped', { name: driveName(d) }), device: d.path };
    } catch (e) {
      if (win.closed) return;
      state.healthNote = { kind: 'error', text: e?.code === 'ENOTAUTH' ? t('st.denied') : t('st.startFailed', { msg: e?.message || String(e) }), device: d.path };
    }
    renderList();
    renderMain();
  }
  /** aurora-admin smart-info (administrator prompt): smartctl -j -a for a drive udisks has nothing for. */
  async function readAsAdmin(d) {
    state.healthNote = null;
    state.healthLoading = d.path;
    renderMain();
    try {
      const out = await shell.runAdmin('smart-info', [d.path], { reason: t('health.smartctlReason', { name: driveName(d) }), appId: 'disks' });
      if (win.closed) return;
      const nh = await api.invoke('disks:smartctlImport', d.path, String(out || ''));
      if (win.closed) return;
      update(nh);
      if (nh.status === 'unknown') state.healthNote = { kind: 'warning', text: t('health.smartctlNoData', { name: driveName(d) }), device: d.path };
    } catch (e) {
      if (win.closed) return;
      if (e?.code === 'ENOTFOUND') state.healthNote = { kind: 'warning', text: t('health.smartctlNoData', { name: driveName(d) }), device: d.path };
      else if (e?.code === 'ENOTADMIN') state.healthNote = { kind: 'error', text: t('health.smartctlNotAdmin'), device: d.path };
      else if (e?.code !== 'ECANCELED') state.healthNote = { kind: 'error', text: t('health.smartctlFailed', { msg: e?.message || String(e) }), device: d.path };
    }
    state.healthLoading = '';
    renderList();
    renderMain();
  }

  // ------------------------------------------------------------ formatting
  const pct = (v) => t('m.percent', { value: nf(v, 0) });
  const celsius = (v) => t('m.celsius', { value: nf(v, 0) });
  function ago(ms) {
    if (!ms) return '';
    const s = Math.round((ms - Date.now()) / 1000);
    if (Math.abs(s) < 45) return t('health.justNow');
    const rtf = new Intl.RelativeTimeFormat(lang(), { numeric: 'auto' });
    const a = Math.abs(s);
    if (a < 3600) return rtf.format(Math.round(s / 60), 'minute');
    if (a < 86400) return rtf.format(Math.round(s / 3600), 'hour');
    return rtf.format(Math.round(s / 86400), 'day');
  }
  const dateTime = (ms) => new Intl.DateTimeFormat(lang(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms));
  function resultText(result, detail) {
    if (result === 'failed') return t('st.failedDetail', { detail: t(`std.${detail || 'unknown'}`) });
    return t(`st.result.${result}`);
  }
  function rawText(a) {
    const r = a.raw || {};
    if (r.text != null && r.text !== '') return r.text;
    const v = r.value;
    if (v == null) return t('none');
    switch (r.unit) {
      case 'ms':
        return v >= 3600000 ? t('m.hours', { hours: nf(Math.round(v / 3600000), 0) }) : `${nf(v, 0)} ms`;
      case 'sectors':
        return t('sectors', { count: v }).replace(String(v), nf(v, 0));
      case 'mK':
        return celsius((v - 273150) / 1000);
      case 'percent':
        return pct(v);
      case 'MB':
        return size(v * 1e6);
      default:
        return nf(v, 0);
    }
  }
  const attrName = (a) => (KNOWN_ATTRS.has(a.id) ? t(`attr.${a.id}`) : a.name);
  function problemText(p) {
    const names = (p.ids || []).map((id, i) => (KNOWN_ATTRS.has(id) ? t(`attr.${id}`) : p.names?.[i] || `#${id}`)).join(', ');
    switch (p.code) {
      case 'attrFailing':
      case 'pastThreshold':
        return t(`p.${p.code}`, { names });
      case 'selftestFailed':
        return t('p.selftestFailed', { detail: t(`std.${p.detail || 'unknown'}`) });
      case 'badSectors':
        return t('p.badSectors', { count: nf(p.count, 0), reallocated: nf(p.reallocated, 0), pending: nf(p.pending, 0) });
      case 'readErrors':
      case 'mediaErrors':
      case 'crc':
        return t(`p.${p.code}`, { count: nf(p.count, 0) });
      case 'wear':
        return t('p.wear', { percent: nf(p.percent, 0) });
      case 'spareLow':
        return t('p.spareLow', { spare: nf(p.spare ?? 0, 0), threshold: nf(p.threshold ?? 0, 0) });
      case 'critical':
        return t('p.critical', { warnings: (p.warnings || []).map((w) => t(`cw.${w}`)).join(', ') });
      case 'hot':
        return t('p.hot', { celsius: nf(p.celsius ?? 0, 0) });
      default:
        return t(`p.${p.code}`);
    }
  }
  function hoursSub(hours) {
    if (hours == null || hours < 48) return '';
    const days = Math.floor(hours / 24);
    return days >= 730 ? t('m.years', { years: nf(days / 365, 1) }) : t('m.days', { count: days }).replace(String(days), nf(days, 0));
  }

  // ------------------------------------------------------------ small pieces used by main.js
  /** Status label for the drive details row ('Not available' when the drive gives nothing). */
  function smartRow(d, onOpen) {
    const hl = state.health[d.path];
    if (!hl) return h('span', { class: 'dk-smart text-2' }, t('readingHealth'));
    if (hl.status === 'unknown') return h('span', { class: 'dk-smart text-2' }, t('notAvailable'));
    return h('button', { class: ['dk-smart', 'dk-smart-link', `st-${hl.status}`], onclick: onOpen, title: t('tabs.health') }, icon(STATUS_ICON[hl.status], { size: 16 }), t(`status.${hl.status}`));
  }
  /** Small marker in the drive list for drives that need attention. */
  function listBadge(d) {
    const hl = state.health[d.path];
    if (!hl || (hl.status !== 'warning' && hl.status !== 'failing')) return '';
    const label = t('healthOf', { status: t(`status.${hl.status}`) });
    return h('span', { class: ['dk-drive-health', `st-${hl.status}`], title: label, role: 'img', 'aria-label': label }, icon(STATUS_ICON[hl.status], { size: 16 }));
  }
  function tabBadge(d) {
    const hl = d && state.health[d.path];
    return hl && (hl.status === 'warning' || hl.status === 'failing') ? h('span', { class: ['dk-tab-dot', `st-${hl.status}`], 'aria-hidden': 'true' }) : '';
  }

  // ------------------------------------------------------------ the view
  function view(d) {
    ensure(d);
    const hl = state.health[d.path];
    const loading = state.healthLoading === d.path;
    const out = [];
    if (state.healthNote && state.healthNote.device === d.path) {
      const n = state.healthNote;
      const ic = { success: 'checkmark_circle', error: 'error_circle', warning: 'warning', info: 'info' }[n.kind] || 'info';
      out.push(h('div', { class: ['infobar', 'dk-hnote', n.kind], role: n.kind === 'error' ? 'alert' : 'status' }, icon(ic), h('div', null, n.text)));
    }
    if (state.healthError && !hl) out.push(h('div', { class: 'infobar error dk-herror', role: 'alert' }, icon('error_circle'), h('div', null, state.healthError)));
    if (!hl) {
      out.push(h('div', { class: 'card dk-card dk-hloading', role: 'status' }, h('div', { class: 'progress indeterminate' }, h('div', { class: 'bar' })), h('div', { class: 'caption text-2' }, t('readingHealth'))));
      return out;
    }
    out.push(hero(d, hl, loading));
    if (hl.status === 'unknown') return out;
    const tiles = figures(hl);
    if (tiles.length) out.push(h('div', { class: 'dk-tiles' }, tiles));
    const ind = indicators(hl);
    if (ind) out.push(ind);
    out.push(selftestCard(d, hl));
    const expert = hl.kind === 'nvme' ? nvmeTable(hl) : hl.attributes?.length ? attrTable(hl) : '';
    if (expert) out.push(expert);
    return out;
  }

  function hero(d, hl, loading) {
    const st = hl.status;
    const problems = (hl.problems || []).filter((p) => p.level !== 'info');
    const meta = [];
    if (hl.source === 'udisks') meta.push(t('health.sourceUdisks'));
    if (hl.source === 'smartctl') meta.push(t('health.sourceSmartctl'));
    if (hl.asleep && hl.updated) meta.push(t('health.asleep', { ago: ago(hl.updated) }));
    else if (hl.updated || hl.readAt) meta.push(t('health.updated', { ago: ago(hl.readAt || hl.updated) }));
    const actions = h(
      'div',
      { class: 'dk-hero-actions' },
      st !== 'unknown' || !['usb', 'virtual', 'card', 'optical'].includes(hl.reason)
        ? h('button', { class: 'btn subtle dk-reread', 'data-fid': 'reread', disabled: loading, onclick: () => load(d, { refresh: true }) }, icon('arrow_sync'), t('health.reread'))
        : '',
      hl.reason === 'asleep' || hl.asleep ? h('button', { class: 'btn dk-wake', 'data-fid': 'wake', disabled: loading, onclick: () => load(d, { refresh: true, wake: true }) }, t('health.wake')) : '',
      hl.canSmartctl ? h('button', { class: 'btn dk-smartctl', 'data-fid': 'smartctl', disabled: loading, onclick: () => readAsAdmin(d) }, icon('shield'), t('health.smartctl')) : '',
    );
    const text =
      st === 'unknown'
        ? [
            h('p', { class: 'dk-hero-summary' }, t(`reason.${hl.reason || 'other'}`)),
            hl.canSmartctl ? h('p', { class: 'caption text-2' }, t('health.smartctlHint')) : '',
            hl.detail ? h('p', { class: 'caption text-2 selectable dk-hero-detail' }, hl.detail) : '',
          ]
        : [
            h('p', { class: 'dk-hero-summary' }, t(`health.${st}`)),
            problems.length ? h('ul', { class: 'dk-problems' }, problems.map((p) => h('li', { class: `lv-${p.level}`, 'data-code': p.code }, problemText(p)))) : '',
          ];
    return h(
      'section',
      { class: ['card', 'dk-card', 'dk-hero', `st-${st}`], 'aria-label': t('health.title'), 'data-status': st },
      h('div', { class: 'dk-hero-main' },
        h('span', { class: 'dk-hero-icon' }, icon(STATUS_ICON[st], { size: 36 })),
        h('div', { class: 'dk-hero-text' },
          h('div', { class: 'caption text-2' }, t('health.title')),
          h('div', { class: 'subtitle dk-hero-status' }, t(`status.${st}`)),
          ...text,
          meta.length ? h('div', { class: 'caption text-2 dk-hero-meta' }, meta.join(' · ')) : ''),
        loading ? h('div', { class: 'dk-hero-busy', role: 'status', 'aria-label': t('readingHealth') }, h('div', { class: 'progress indeterminate' }, h('div', { class: 'bar' }))) : ''),
      actions,
    );
  }

  function tile(id, ic, label, value, sub, extra) {
    return h('div', { class: ['card', 'dk-tile'], 'data-tile': id },
      h('div', { class: 'dk-tile-head caption text-2' }, icon(ic, { size: 16 }), h('span', null, label)),
      h('div', { class: 'dk-tile-value selectable' }, value),
      sub ? h('div', { class: 'caption text-2 dk-tile-sub' }, sub) : '',
      extra || '');
  }
  function figures(hl) {
    const s = hl.ssd || {};
    const out = [];
    if (hl.temperature != null) out.push(tile('temperature', 'thermometer-simple', t('m.temperature'), celsius(hl.temperature)));
    if (hl.powerOnHours != null) out.push(tile('powerOn', 'clock', t('m.powerOn'), t('m.hours', { hours: nf(hl.powerOnHours, 0) }), hoursSub(hl.powerOnHours)));
    if (hl.powerCycles != null) out.push(tile('powerCycles', 'power', t('m.powerCycles'), nf(hl.powerCycles, 0)));
    if (s.used != null) {
      const lv = s.used >= 100 ? 'bad' : s.used >= 90 ? 'watch' : 'ok';
      out.push(tile('lifeUsed', 'gauge', t('m.lifeUsed'), pct(s.used), '',
        h('div', { class: ['progress', 'dk-meter', `lv-${lv}`], role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.min(100, s.used)), 'aria-label': t('m.lifeUsed') },
          h('div', { class: 'bar', style: { width: `${Math.min(100, Math.max(0, s.used))}%` } }))));
    }
    if (s.dataWritten != null) out.push(tile('written', 'upload-simple', t('m.written'), size(s.dataWritten)));
    if (s.dataRead != null) out.push(tile('read', 'download-simple', t('m.read'), size(s.dataRead)));
    return out;
  }

  function indRow(id, label, value, level, explanation) {
    return h('div', { class: ['dk-ind', `lv-${level}`], 'data-ind': id },
      h('div', { class: 'dk-ind-head' },
        h('span', { class: 'dk-ind-label' }, label),
        h('span', { class: 'dk-ind-value selectable' }, value),
        h('span', { class: ['dk-chip', `lv-${level}`] }, t(`ind.${level}`))),
      h('div', { class: 'dk-ind-x caption text-2' }, explanation));
  }
  function indicators(hl) {
    const rows = [];
    const s = hl.ssd;
    const failingIds = new Set((hl.attributes || []).filter((a) => a.failingNow).map((a) => a.id));
    if (hl.kind === 'nvme' || (s && hl.kind === 'ata')) {
      if (s?.used != null) rows.push(indRow('lifeUsed', t('ind.lifeUsed'), pct(s.used), s.used >= 100 ? 'bad' : s.used >= 90 ? 'watch' : 'ok', t('ind.x.lifeUsed')));
      if (s?.spare != null) {
        const below = s.spareThreshold != null && s.spare < s.spareThreshold;
        const near = s.spareThreshold != null && s.spare <= s.spareThreshold + 10;
        rows.push(indRow('spare', t('ind.spare'), s.spareThreshold != null ? t('ind.spareValue', { spare: nf(s.spare, 0), threshold: nf(s.spareThreshold, 0) }) : pct(s.spare), below ? 'bad' : near ? 'watch' : 'ok', t('ind.x.spare')));
      }
      if (s?.mediaErrors != null) rows.push(indRow('mediaErrors', t('ind.mediaErrors'), nf(s.mediaErrors, 0), s.mediaErrors > 0 ? 'watch' : 'ok', t('ind.x.mediaErrors')));
      if (s?.unsafeShutdowns != null) rows.push(indRow('unsafe', t('ind.unsafe'), nf(s.unsafeShutdowns, 0), 'ok', t('ind.x.unsafe')));
      if (s?.errorLogEntries != null) rows.push(indRow('errorLog', t('ind.errorLog'), nf(s.errorLogEntries, 0), 'ok', t('ind.x.errorLog')));
      const hot = (s?.warningTempMinutes || 0) + (s?.criticalTempMinutes || 0);
      if (hot > 0) rows.push(indRow('hotTime', t('ind.hotTime'), t('ind.minutes', { minutes: nf(hot, 0) }), 'watch', t('ind.x.hotTime')));
      if (hl.kind === 'nvme') {
        const w = hl.criticalWarnings || [];
        rows.push(indRow('critical', t('ind.critical'), w.length ? w.map((x) => t(`cw.${x}`)).join(', ') : t('ind.none'), w.some((x) => x !== 'spare' && x !== 'temperature') ? 'bad' : w.length ? 'watch' : 'ok', t('ind.x.critical')));
      }
    }
    const sec = hl.sectors;
    if (sec) {
      if (sec.reallocated != null) rows.push(indRow('reallocated', t('ind.reallocated'), nf(sec.reallocated, 0), failingIds.has(5) ? 'bad' : sec.reallocated > 0 ? 'watch' : 'ok', t('ind.x.reallocated')));
      if (sec.pending != null) rows.push(indRow('pending', t('ind.pending'), nf(sec.pending, 0), sec.pending > 0 ? 'bad' : 'ok', t('ind.x.pending')));
      if (sec.uncorrectable != null) rows.push(indRow('uncorrectable', t('ind.uncorrectable'), nf(sec.uncorrectable, 0), sec.uncorrectable > 0 ? 'bad' : 'ok', t('ind.x.uncorrectable')));
      if (sec.reportedUncorrect != null) rows.push(indRow('reportedUncorrect', t('ind.reportedUncorrect'), nf(sec.reportedUncorrect, 0), sec.reportedUncorrect > 0 ? 'watch' : 'ok', t('ind.x.reportedUncorrect')));
      if (sec.crc != null) rows.push(indRow('crc', t('ind.crc'), nf(sec.crc, 0), sec.crc > 0 ? 'watch' : 'ok', t('ind.x.crc')));
    }
    if (!rows.length) return '';
    return h('section', { class: 'card dk-card dk-indicators', 'aria-label': t('ind.title') }, h('div', { class: 'body-strong' }, t('ind.title')), h('div', { class: 'dk-ind-list' }, rows));
  }

  function selftestCard(d, hl) {
    const st = hl.selftest || {};
    const list = Array.isArray(history[hl.key]) ? history[hl.key] : [];
    const parts = [h('div', { class: 'dk-card-head' }, h('div', { class: 'body-strong' }, icon('stethoscope', { size: 16 }), ' ', t('st.title')))];
    const admin = state.isAdmin !== false;
    if (hl.source !== 'udisks') {
      parts.push(h('p', { class: 'caption text-2' }, t('st.notHere')));
    } else if (!st.supported) {
      parts.push(h('p', { class: 'caption text-2 dk-st-unsupported' }, t('st.unsupported')));
    } else if (st.running) {
      const pending = list[0] && list[0].result == null ? list[0] : null;
      const type = pending ? t(`st.${pending.type}`) : t('st.generic');
      const left = st.percentRemaining;
      parts.push(
        h('div', { class: 'dk-st-running', role: 'status' },
          h('div', { class: 'dk-st-line' }, left != null ? t('st.running', { type, percent: nf(left, 0) }) : t('st.runningNoPct', { type })),
          h('div', { class: ['progress', left == null && 'indeterminate'], role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': left != null ? String(100 - left) : undefined, 'aria-label': t('st.title') },
            h('div', { class: 'bar', style: left != null ? { width: `${100 - left}%` } : {} }))),
        h('div', { class: 'dk-actions' }, h('button', { class: 'btn dk-st-stop', 'data-fid': 'st-stop', disabled: !admin, onclick: () => stopTest(d) }, icon('stop'), t('st.stop'))),
      );
    } else {
      parts.push(
        h('p', { class: 'caption text-2' }, t('st.intro')),
        h('div', { class: 'dk-actions dk-st-buttons' },
          h('button', { class: 'btn dk-st-short', 'data-fid': 'st-short', disabled: !admin, onclick: () => startTest(d, 'short') },
            icon('play'), h('span', null, t('st.short')), h('span', { class: 'caption text-2' }, `· ${t('st.shortHint')}`)),
          h('button', { class: 'btn dk-st-extended', 'data-fid': 'st-extended', disabled: !admin, onclick: () => startTest(d, 'extended') },
            icon('play'), h('span', null, t('st.extended')), h('span', { class: 'caption text-2' }, `· ${t('st.extendedHint')}`))),
      );
      if (!admin) parts.push(h('p', { class: 'caption text-2 dk-st-admin' }, t('st.adminOnly')));
    }
    // Last result: this app's record when it has one (with its date), else what the drive says.
    const done = list.find((e) => e.result);
    if (!st.running) {
      let lastText = '';
      if (done) lastText = `${t('st.last', { result: resultText(done.result, done.detail) })} · ${dateTime(done.ended || done.started)}`;
      else if (st.last === 'success' && !st.log?.length) lastText = t('st.last', { result: t('st.noFailure') });
      else if (st.last) lastText = t('st.last', { result: resultText(st.last, st.lastDetail) });
      if (lastText) parts.push(h('div', { class: ['dk-st-last', st.last === 'failed' && !done ? 'lv-bad' : done?.result === 'failed' ? 'lv-bad' : ''] }, lastText));
    }
    const rows = list.filter((e) => e.result).slice(0, 5).map((e) =>
      h('li', { class: e.result === 'failed' ? 'lv-bad' : '' }, h('span', { class: 'dk-st-when' }, dateTime(e.ended || e.started)), h('span', null, t(`st.${e.type}`)), h('span', null, resultText(e.result, e.detail))));
    const logRows = (st.log || []).slice(0, 5).map((e) =>
      h('li', { class: e.result === 'failed' ? 'lv-bad' : '' }, h('span', { class: 'dk-st-when' }, e.hours != null ? t('st.atHours', { hours: nf(e.hours, 0) }) : ''), h('span', null, e.type === 'other' ? t('st.generic') : t(`st.${e.type}`)), h('span', null, resultText(e.result, e.detail))));
    if (rows.length || logRows.length) parts.push(h('div', { class: 'caption text-2' }, t('st.history')), h('ul', { class: 'dk-st-history' }, rows.length ? rows : logRows));
    return h('section', { class: 'card dk-card dk-selftest', 'aria-label': t('st.title') }, parts);
  }

  function details(id, title, body) {
    const el = h('details', { class: ['card', 'dk-card', 'dk-expert'], 'data-expert': id }, h('summary', { class: 'body-strong' }, title), body);
    el.open = !!state.expertOpen;
    el.addEventListener('toggle', () => {
      state.expertOpen = el.open;
    });
    return el;
  }
  function attrTable(hl) {
    const head = h('tr', null, ...['id', 'name', 'value', 'worst', 'threshold', 'raw', 'type'].map((k) => h('th', { scope: 'col', class: `c-${k}` }, t(`attrs.${k}`))));
    const body = hl.attributes.map((a) =>
      h('tr', { class: [a.failingNow && 'failing', a.failedPast && 'past'], 'data-id': String(a.id), title: a.failingNow ? t('attrs.failingNow') : a.failedPast ? t('attrs.failedPast') : null },
        h('td', { class: 'c-id' }, String(a.id)),
        h('td', { class: 'c-name' }, h('div', null, attrName(a)), h('div', { class: 'caption text-2 dk-mono' }, a.name)),
        h('td', { class: 'c-value' }, a.value >= 0 ? String(a.value) : t('none')),
        h('td', { class: 'c-worst' }, a.worst >= 0 ? String(a.worst) : t('none')),
        h('td', { class: 'c-threshold' }, a.threshold >= 0 ? String(a.threshold) : t('none')),
        h('td', { class: 'c-raw' }, rawText(a)),
        h('td', { class: 'c-type' }, a.prefail ? t('attrs.prefail') : t('attrs.oldage'))));
    return details('ata', t('attrs.title'), h('div', null,
      h('p', { class: 'caption text-2' }, t('attrs.hint')),
      h('div', { class: 'dk-table-wrap', tabindex: '0', role: 'region', 'aria-label': t('attrs.title') },
        h('table', { class: 'dk-table selectable' }, h('thead', null, head), h('tbody', null, body)))));
  }
  function nvmeValue(r) {
    switch (r.unit) {
      case 'celsius':
        return celsius(r.value);
      case 'percent':
        return pct(r.value);
      case 'bytes':
        return size(r.value);
      case 'minutes':
        return t('ind.minutes', { minutes: nf(r.value, 0) });
      default:
        return nf(r.value, 0);
    }
  }
  function nvmeTable(hl) {
    if (!hl.nvmeLog?.length) return '';
    const label = (k) => (NVME_KEYS.has(k) ? t(`nvme.${k}`) : /^temp_sensor_\d$/.test(k) ? t('nvme.tempSensor', { n: k.slice(-1) }) : k);
    const body = hl.nvmeLog.map((r) =>
      h('tr', { 'data-key': r.key }, h('td', { class: 'c-name' }, label(r.key)), h('td', { class: 'c-field caption text-2 dk-mono' }, r.key), h('td', { class: 'c-raw' }, nvmeValue(r))));
    return details('nvme', t('attrs.nvmeTitle'), h('div', { class: 'dk-table-wrap', tabindex: '0', role: 'region', 'aria-label': t('attrs.nvmeTitle') },
      h('table', { class: 'dk-table selectable' },
        h('thead', null, h('tr', null, h('th', { scope: 'col' }, t('attrs.name')), h('th', { scope: 'col' }, t('attrs.field')), h('th', { scope: 'col' }, t('attrs.value')))),
        h('tbody', null, body))));
  }

  return {
    check, load, ensure, view, smartRow, listBadge, tabBadge, schedulePoll,
    dispose() {
      clearTimeout(pollTimer);
    },
  };
}
