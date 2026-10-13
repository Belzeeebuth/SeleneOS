// Settings > Devices > Printers & scanners (Imprimantes et scanners): the printers (state, ink, default), adding a
// printer found on the network or on USB in one click (driverless IPP Everywhere), test page, pause / resume, rename,
// remove, and the print queue (cancel). Backend: main/ipc/printers.js (printers:list / discover / testPage / cancel)
// and the aurora-admin printer-* actions through shell.runAdmin (« Autorisation administrateur »).
const CSS = 'app://shell/apps/settings/pages/printers.css';

// Survives page changes while the Settings window is open.
const state = { found: null, searching: false, adding: null, open: new Set(), error: null };

const REASON_KEYS = ['media-empty', 'media-jam', 'media-needed', 'toner-low', 'toner-empty', 'marker-supply-low', 'marker-supply-empty', 'cover-open', 'door-open', 'offline', 'connecting-to-device', 'other', 'cups-missing-filter', 'input-tray-missing', 'output-area-full', 'spool-area-full', 'timed-out', 'stopped', 'shutdown'];
const STATE_ICON = { idle: 'check-circle', printing: 'paper-plane-tilt', paused: 'pause', error: 'warning-circle', offline: 'wifi-slash' };

function reasonText(pc, r) {
  return REASON_KEYS.includes(r) ? pc.t(`prn.r.${r}`) : null;
}

/** "Prête" / "En pause" / "Erreur : Bourrage papier" … */
function stateText(pc, p) {
  const { t } = pc;
  const reasons = p.reasons.map((r) => reasonText(pc, r)).filter(Boolean);
  const base = t(`prn.s.${p.state}`) || p.state;
  if (p.state === 'idle' || p.state === 'printing') return base;
  return reasons.length ? `${base} : ${reasons.join(', ')}` : base;
}

/** The helper's (English) reasons, said simply. */
function friendly(pc, err) {
  const m = String(err?.message || err || '');
  if (err?.code === 'ENOTADMIN') return pc.t('settings.notAdminError');
  if (/did not answer|IPP Everywhere|Unable to connect|timed out/i.test(m)) return pc.t('prn.errAdd');
  if (/already exists/i.test(m)) return pc.t('prn.errExists');
  if (/CUPS is not installed/i.test(m)) return pc.t('prn.noCupsDesc');
  if (/not accepting/i.test(m)) return pc.t('prn.errNotAccepting');
  return pc.t('prn.errGeneric', { msg: m.replace(/^aurora-admin:\s*/, '') });
}

async function adminRun(pc, action, args, reasonKey, vars) {
  try {
    await pc.runAdmin(action, args, reasonKey, vars);
    return true;
  } catch (err) {
    if (err.code !== 'ECANCELED') state.error = friendly(pc, err);
    return false;
  }
}

// Common cartridge names as printers report them (English), said in the interface language.
const INK_NAMES = { black: 'black', 'black ink': 'black', 'photo black': 'photoBlack', 'matte black': 'matteBlack', cyan: 'cyan', magenta: 'magenta', yellow: 'yellow', 'tri-color': 'triColor', 'color': 'triColor', 'black toner': 'blackToner', 'waste ink': 'waste' };
function inkName(pc, name) {
  const k = INK_NAMES[String(name || '').trim().toLowerCase()];
  return k ? pc.t(`prn.ink.${k}`) : name;
}

function inkBars(pc, p) {
  const { h, t } = pc;
  if (!p.markers?.length) return h('div', { class: 'st-prn-ink-none text-2' }, t('prn.inkUnknown'));
  return h(
    'div',
    { class: 'st-prn-inks', role: 'list', 'aria-label': t('prn.inkLevels') },
    p.markers.map((m) => {
      const pct = m.level == null ? null : m.level === -3 ? null : m.level;
      const label = pct == null ? (m.level === -3 ? t('prn.inkSome') : t('prn.inkNA')) : `${pct} %`;
      return h(
        'div',
        { class: 'st-prn-ink', role: 'listitem', title: `${m.name} — ${label}` },
        h('div', { class: 'st-prn-ink-bar', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': pct == null ? null : String(pct), 'aria-label': m.name }, h('span', { class: 'st-prn-ink-fill', style: { height: `${pct == null ? 50 : Math.max(3, pct)}%`, background: m.color || 'var(--accent)' } })),
        h('div', { class: 'st-prn-ink-name caption ellipsis' }, inkName(pc, m.name)),
        h('div', { class: ['st-prn-ink-pct caption', pct != null && pct <= 20 && 'low'] }, label),
      );
    }),
  );
}

async function printers(pc) {
  const { h, t, kit, ui, api, icon } = pc;
  ui.loadCss(CSS);
  const root = h('div', { class: 'st-prn' });
  let data = null;
  let lastJson = '';

  async function load() {
    data = await pc.tryInvoke('printers:list');
  }

  async function discover() {
    state.searching = true;
    state.found = null;
    render();
    const res = await pc.tryInvoke('printers:discover');
    state.searching = false;
    state.found = res?.printers || [];
    render();
  }

  async function add(d) {
    if (state.adding) return;
    state.adding = d.key;
    state.error = null;
    render();
    const ok = await adminRun(pc, 'printer-add', [d.queue, d.uri, d.label], 'prn.reasonAdd', { name: d.label });
    state.adding = null;
    if (ok) {
      state.found = (state.found || []).filter((x) => x.key !== d.key);
      state.open.add(d.queue);
      pc.shell.notify({ title: t('prn.added', { name: d.label }), body: t('prn.addedBody'), appId: 'settings', icon: 'print' });
    }
    await refresh(true);
  }

  async function act(p, action, args, reasonKey) {
    state.error = null;
    await adminRun(pc, action, args, reasonKey, { name: p.label });
    await refresh(true);
  }

  async function rename(p) {
    const v = await ui.prompt({
      title: t('prn.renameTitle'),
      label: t('prn.renameLabel'),
      value: p.label,
      okLabel: t('prn.rename'),
      parent: pc.win,
      validate: (s) => (/^[^\x00-\x1f\x7f"\\\s](?:[^\x00-\x1f\x7f"\\]{0,125}[^\x00-\x1f\x7f"\\\s])?$/.test(s.trim()) ? null : t('prn.renameInvalid')),
    });
    if (v == null || v.trim() === p.label) return;
    await act(p, 'printer-rename', [p.name, v.trim()], 'prn.reasonRename');
  }

  async function remove(p) {
    const ok = await ui.confirm(t('prn.removeConfirm', { name: p.label }), { title: t('prn.removeTitle'), okLabel: t('prn.remove'), danger: true, parent: pc.win });
    if (!ok) return;
    state.open.delete(p.name);
    await act(p, 'printer-remove', [p.name], 'prn.reasonRemove');
  }

  async function testPage(p, btn) {
    await kit.busy(btn, async () => {
      try {
        await api.invoke('printers:testPage', p.name);
        pc.toast(t('prn.testSent', { name: p.label }));
      } catch (err) {
        state.error = friendly(pc, err);
        render();
      }
    });
    await refresh(true);
  }

  async function cancelJob(j, btn) {
    await kit.busy(btn, async () => {
      try {
        await api.invoke('printers:cancel', j.id);
      } catch (err) {
        if (err.code === 'EPERM') await adminRun(pc, 'printer-job-cancel', [j.id], 'prn.reasonCancel', { name: j.title || j.id });
        else state.error = friendly(pc, err);
      }
    });
    await refresh(true);
  }

  // ---------------------------------------------------------------- sections
  function printerRow(p) {
    const label = h('span', { class: 'st-prn-name' }, p.label, p.isDefault ? h('span', { class: 'st-pill st-prn-default' }, t('prn.default')) : null);
    const where = [p.location, p.connection ? t(`prn.conn.${p.connection}`) : null].filter(Boolean).join(' · ');
    // A warning on a printer that still prints (ink low…) follows the state, in the warning colour.
    const warn = p.state === 'idle' || p.state === 'printing' ? p.reasons.map((r) => reasonText(pc, r)).filter(Boolean).join(', ') : '';
    const desc = h('span', { class: 'st-prn-desc' }, h('span', { class: ['st-prn-state', `is-${p.state}`] }, icon(STATE_ICON[p.state] || 'printer', { size: 14 }), stateText(pc, p)), warn ? h('span', { class: 'st-prn-warn' }, ` · ${warn}`) : null, where ? h('span', { class: 'text-2' }, ` · ${where}`) : null, p.jobs ? h('span', { class: 'text-2' }, ` · ${t(p.jobs > 1 ? 'prn.jobsN' : 'prn.jobs1', { n: p.jobs })}`) : null);
    const exp = kit.expander({
      icon: 'printer',
      title: label,
      desc,
      section: `printer-${p.name}`,
      open: state.open.has(p.name),
      className: 'st-prn-printer',
      body: () => {
        const testBtn = kit.button(t('prn.testPage'), () => testPage(p, testBtn), { icon: 'file-text', className: 'st-prn-test' });
        return h(
          'div',
          { class: 'st-prn-body' },
          p.message && p.state !== 'idle' ? h('div', { class: 'st-prn-msg text-2' }, p.message) : null,
          h('div', { class: 'st-prn-sub' }, h('div', { class: 'st-prn-sub-title body-strong' }, t('prn.inkLevels')), inkBars(pc, p)),
          h(
            'div',
            { class: 'st-prn-actions' },
            testBtn,
            p.isDefault ? null : kit.button(t('prn.setDefault'), () => act(p, 'printer-default', [p.name], 'prn.reasonDefault'), { icon: 'star', className: 'st-prn-setdefault' }),
            p.state === 'paused' ? kit.button(t('prn.resume'), () => act(p, 'printer-enable', [p.name, '1'], 'prn.reasonResume'), { icon: 'play', className: 'st-prn-resume' }) : kit.button(t('prn.pause'), () => act(p, 'printer-enable', [p.name, '0'], 'prn.reasonPause'), { icon: 'pause', className: 'st-prn-pause' }),
            kit.button(t('prn.rename'), () => rename(p), { icon: 'pencil-simple', className: 'st-prn-rename' }),
            kit.button(t('prn.remove'), () => remove(p), { icon: 'trash', danger: true, className: 'st-prn-remove' }),
          ),
          h('div', { class: 'st-prn-tech caption text-2' }, `${t('prn.queueName')} : ${p.name}${p.uri ? ` · ${p.uri.replace(/\?.*$/, '')}` : ''}`),
        );
      },
    });
    exp.querySelector('.st-exp-head')?.addEventListener('click', () =>
      setTimeout(() => {
        if (exp.querySelector('.st-exp-body')?.hidden) state.open.delete(p.name);
        else state.open.add(p.name);
      }),
    );
    exp.dataset.printer = p.name;
    return exp;
  }

  function addSection() {
    const searchBtn = kit.button(state.found ? t('prn.searchAgain') : t('prn.add'), () => discover(), { primary: !state.found, icon: state.found ? 'arrows-clockwise' : 'plus', className: 'st-prn-search', disabled: state.searching });
    const head = kit.row({ icon: 'magnifying-glass', title: t('prn.add'), desc: t('prn.addDesc'), control: searchBtn, section: 'add' });
    if (state.searching) return kit.group(null, head, kit.spinnerRow(t('prn.searching')));
    if (!state.found) return kit.group(null, head);
    const rows = state.found.map((d) => {
      const busy = state.adding === d.key;
      const where = [d.location, t(`prn.conn.${d.connection}`), d.host ? d.host.replace(/\.local\.?$/, '') : null].filter(Boolean).join(' · ');
      const ctl = d.driverless
        ? kit.button(busy ? t('prn.adding') : t('prn.addBtn'), () => add(d), { primary: true, icon: busy ? null : 'plus', disabled: !!state.adding, className: 'st-prn-addbtn' })
        : h('span', { class: 'st-pill' }, t('prn.needsDriverPill'));
      const row = kit.row({ icon: d.connection === 'usb' ? 'usb' : 'wifi-high', title: d.label, desc: d.driverless ? where : t('prn.needsDriver'), control: busy ? h('span', { class: 'st-prn-adding' }, h('span', { class: 'spinner small' }), ctl) : ctl, className: 'st-prn-found' });
      row.dataset.key = d.key;
      return row;
    });
    return kit.group(
      null,
      head,
      ...(rows.length ? rows : [h('div', { class: 'st-prn-none-found text-2' }, t('prn.noneFound'))]),
    );
  }

  function queueSection() {
    const jobs = data.jobs || [];
    const byName = Object.fromEntries((data.printers || []).map((p) => [p.name, p.label]));
    if (!jobs.length) return kit.group(t('prn.queue'), kit.row({ icon: 'tray', title: t('prn.queueEmpty'), className: 'st-prn-queue-empty' }));
    return kit.group(
      t('prn.queue'),
      ...jobs.map((j) => {
        const btn = kit.button(t('prn.cancel'), () => cancelJob(j, btn), { icon: 'x', className: 'st-prn-cancel' });
        const row = kit.row({
          icon: 'file-text',
          title: j.title || j.id,
          desc: [j.rank === 'active' ? t('prn.jobActive') : null, byName[j.printer] || j.printer, j.mine ? t('prn.you') : j.user, pc.fmtSize(j.size)].filter(Boolean).join(' · '),
          control: btn,
          className: 'st-prn-job',
        });
        row.dataset.job = j.id;
        return row;
      }),
    );
  }

  function render() {
    const nodes = [];
    if (state.error) {
      nodes.push(kit.infobar({ kind: 'error', title: t('prn.errTitle'), message: state.error, className: 'st-prn-error', action: h('button', { class: 'btn subtle icon-btn small', 'aria-label': t('common.close'), onclick: () => ((state.error = null), render()) }, icon('x', { size: 12 })) }));
    }
    if (!data || !data.available) {
      nodes.push(h('div', { class: 'st-empty st-prn-nocups' }, icon('printer', { size: 40 }), h('div', { class: 'body-large' }, t('prn.noCups')), h('div', null, t('prn.noCupsDesc'))));
      root.replaceChildren(...nodes);
      return;
    }
    if (!data.running) nodes.push(kit.infobar({ kind: 'warning', title: t('prn.cupsDownTitle'), message: t('prn.cupsDown') }));
    nodes.push(addSection());
    if (data.printers.length) nodes.push(kit.group(t('prn.yourPrinters'), ...data.printers.map(printerRow)));
    else nodes.push(h('div', { class: 'st-empty st-prn-empty' }, icon('printer', { size: 40 }), h('div', { class: 'body-large' }, t('prn.none')), h('div', null, t('prn.noneDesc'))));
    nodes.push(queueSection());
    nodes.push(kit.group(t('prn.scanners'), kit.row({ icon: 'scan', title: t('prn.scanners'), desc: t('prn.scannersDesc') })));
    root.replaceChildren(...nodes);
  }

  async function refresh(force) {
    await load();
    const json = JSON.stringify(data);
    if (!force && json === lastJson) return;
    lastJson = json;
    // Keep a menu / dialog / focused control in place: skip a timed refresh while something inside is focused.
    if (!force && root.contains(document.activeElement) && document.activeElement !== document.body) return;
    render();
  }

  await load();
  lastJson = JSON.stringify(data);
  render();
  pc.every(5000, () => refresh(false));
  return root;
}

export default { printers };
