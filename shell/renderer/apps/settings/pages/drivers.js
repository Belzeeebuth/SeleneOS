// Settings > System > Graphics drivers (Pilotes graphiques): the graphics cards, the driver in use, the NVIDIA drivers
// Ubuntu offers for this machine (ubuntu-drivers), install / switch / go back to the free driver (Nouveau) with live
// progress, then restart. Backend: main/ipc/drivers.js (drivers:detect / drivers:install / drivers:remove) and the
// aurora-admin actions drivers-install / drivers-remove, run through shell.runAdmin (UAC prompt).
// The drivers are downloaded from the Ubuntu archive (Internet needed); the prebuilt kernel modules are signed by
// Canonical, so Secure Boot keeps working.
import { parseAptStatus } from '../lib/parse.js';

const CSS = 'app://shell/apps/settings/pages/drivers.css';

// Survives page changes while the Settings window is open (an install keeps running in the background).
const state = { phase: null, target: null, progress: 0, step: '', error: null, later: false };
const listeners = new Set();
const emit = () => listeners.forEach((fn) => fn());

const verOf = (pkg) => /-(\d{3})/.exec(pkg || '')?.[1] || '';
const kindOf = (pkg) => ({ '-open': 'open', '-server': 'server', '-server-open': 'server-open' })[/^nvidia-driver-\d{3}(-open|-server|-server-open)?$/.exec(pkg || '')?.[1]] || 'proprietary';
const KIND_LABEL = { proprietary: 'drv.kindProprietary', open: 'drv.kindOpen', server: 'drv.kindServer', 'server-open': 'drv.kindServerOpen' };

/** 'nvidia-driver-580-open' -> 'NVIDIA 580 Open' (the name used in sentences) */
function label(pc, pkg) {
  const k = kindOf(pkg);
  return k === 'proprietary' ? `NVIDIA ${verOf(pkg)}` : `NVIDIA ${verOf(pkg)} ${pc.t(KIND_LABEL[k])}`;
}

/** The helper's (English) reasons, said simply. */
function friendly(pc, err) {
  const m = String(err?.message || err || '');
  if (/package lists|Internet|network/i.test(m)) return pc.t('drv.errNetwork');
  if (/not offered/i.test(m)) return pc.t('drv.errNotOffered');
  if (/live session/i.test(m)) return pc.t('drv.live');
  if (/would also remove/i.test(m)) return pc.t('drv.errOthers', { list: m.replace(/^.*would also remove:\s*/, '') });
  if (/ubuntu-drivers is not installed/i.test(m)) return pc.t('drv.noTool');
  if (/could not (install|remove)|was not installed|initramfs/i.test(m)) return pc.t(/remove|initramfs/i.test(m) ? 'drv.errRemove' : 'drv.errInstall');
  return pc.t('drv.errGeneric', { msg: m });
}

async function runAction(pc, kind, pkg, reload) {
  if (state.phase) return;
  const { t } = pc;
  let plan;
  state.error = null;
  try {
    plan = kind === 'install' ? await pc.api.invoke('drivers:install', pkg) : await pc.api.invoke('drivers:remove');
  } catch (err) {
    state.error = { title: t(kind === 'install' ? 'drv.errorTitle' : 'drv.errorRemoveTitle'), message: friendly(pc, err) };
    return emit();
  }
  state.phase = kind === 'install' ? 'installing' : 'removing';
  state.target = pkg || null;
  state.progress = 0;
  state.step = t('drv.preparing');
  state.later = false;
  emit();
  const off = pc.api.on('admin:progress', ({ action, line }) => {
    if (action !== plan.action) return;
    const step = /^step:(\w+)$/.exec(line)?.[1];
    if (step) {
      const at = { refresh: [3, 'drv.stepRefresh'], check: [6, 'drv.stepCheck'], install: [8, 'drv.preparing'], remove: [5, 'drv.stepRemove'], initramfs: [92, 'drv.stepInitramfs'] }[step];
      if (at) {
        state.progress = Math.max(state.progress, at[0]);
        state.step = t(at[1]);
      }
      return emit();
    }
    const s = parseAptStatus(line);
    if (!s || s.phase === 'error') return;
    // download 8-40 %, unpack / configure 40-90 % (removal: 5-90 %)
    const pct = plan.action === 'drivers-remove' ? 5 + (s.step || 0) * 0.85 : s.phase === 'download' ? 8 + (s.step || 0) * 0.32 : 40 + (s.step || 0) * 0.5;
    state.progress = Math.max(state.progress, Math.min(95, pct));
    state.step = s.phase === 'download' ? t('drv.stepDownload', { pct: Math.round(s.step || 0) }) : t(plan.action === 'drivers-remove' ? 'drv.stepRemove' : 'drv.stepInstall', { pkg: s.pkg || '' });
    emit();
  });
  try {
    await pc.runAdmin(plan.action, plan.args, kind === 'install' ? 'drv.reasonInstall' : 'drv.reasonRemove', { name: pkg ? label(pc, pkg) : '' });
    state.progress = 100;
    pc.shell.notify({ title: t(kind === 'install' ? 'drv.notifInstalled' : 'drv.notifRemoved'), body: t('drv.notifBody'), appId: 'settings' });
  } catch (err) {
    if (err.code === 'ENOTADMIN') state.error = { title: t(kind === 'install' ? 'drv.errorTitle' : 'drv.errorRemoveTitle'), message: t('settings.notAdminError') };
    else if (err.code !== 'ECANCELED') state.error = { title: t(kind === 'install' ? 'drv.errorTitle' : 'drv.errorRemoveTitle'), message: friendly(pc, err) };
  } finally {
    off();
    state.phase = null;
    state.target = null;
  }
  await reload();
}

// "Search for drivers": an NVIDIA card but no driver list yet (package lists never downloaded): apt-get update.
async function search(pc, reload) {
  if (state.phase) return;
  state.phase = 'searching';
  state.error = null;
  emit();
  try {
    await pc.runAdmin('apt-check', [], 'drv.reasonSearch');
  } catch (err) {
    if (err.code === 'ENOTADMIN') state.error = { title: pc.t('drv.errorSearchTitle'), message: pc.t('settings.notAdminError') };
    else if (err.code !== 'ECANCELED') state.error = { title: pc.t('drv.errorSearchTitle'), message: friendly(pc, err) };
  } finally {
    state.phase = null;
  }
  await reload();
}

function inUseLabel(pc, data, gpu) {
  const { t } = pc;
  if (gpu.vendor === 'nvidia') {
    if (data.current.module === 'nvidia') return data.current.version ? `NVIDIA ${data.current.version}${data.current.open ? ` ${t('drv.kindOpen')}` : ''}` : 'NVIDIA';
    if (data.current.module === 'nouveau') return t('drv.drvNouveau');
    return t('drv.drvBasic');
  }
  if (gpu.vendor === 'amd') return t('drv.drvAmd');
  if (gpu.vendor === 'intel') return t('drv.drvIntel');
  return t('drv.drvBuiltin');
}

async function gpuDrivers(pc) {
  const { h, t, kit, icon, ui } = pc;
  ui.loadCss(CSS);
  const root = h('div', { class: 'st-drv' });
  if (!state.phase) state.error = null; // a reason shown earlier is not repeated on the next visit
  let data = null;
  let adm = null;
  const load = async () => {
    [data, adm] = await Promise.all([pc.tryInvoke('drivers:detect'), pc.adminStatus()]);
  };
  const reload = async () => {
    await load();
    emit();
  };
  await load();

  const pill = (text, cls) => h('span', { class: ['st-pill', cls] }, text);

  function hero() {
    const nv = data.gpus.some((g) => g.vendor === 'nvidia');
    let title;
    let sub;
    let badge = null;
    const actions = [];
    const busy = state.phase === 'installing' || state.phase === 'removing';
    if (busy) {
      title = state.phase === 'installing' ? t('drv.installingTitle', { name: label(pc, state.target) }) : t('drv.removingTitle');
      sub = t('drv.keepOn');
    } else if (data.rebootPending) {
      title = t('drv.rebootTitle');
      sub = data.installed ? t('drv.rebootInstalled', { name: label(pc, data.installed) }) : t('drv.rebootRemoved');
      badge = 'pending';
      if (!state.later) {
        actions.push(kit.button(t('drv.restartNow'), () => pc.shell.reboot().catch(pc.toastError), { primary: true, icon: 'arrow_clockwise', className: 'st-drv-restart' }));
        actions.push(
          kit.button(t('drv.later'), () => {
            state.later = true;
            emit();
          }),
        );
      }
    } else if (!nv) {
      title = data.gpus.length ? t('drv.okTitle') : t('drv.noGpuTitle');
      sub = data.gpus.length ? t('drv.okDesc') : t('drv.noGpuDesc');
      badge = 'ok';
    } else if (data.current.module === 'nvidia') {
      title = t('drv.inUseTitle', { name: data.installed ? label(pc, data.installed) : 'NVIDIA' });
      sub = t('drv.inUseDesc');
      badge = 'ok';
    } else {
      title = t('drv.availTitle');
      sub = t('drv.availDesc');
      if (data.recommended) actions.push(kit.button(t('drv.installRecommended'), () => runAction(pc, 'install', data.recommended, reload), { primary: true, icon: 'arrow_download', disabled: !canChange(), className: 'st-drv-install-rec' }));
    }
    const art = h(
      'div',
      { class: ['st-drv-icon', busy && 'busy'], 'aria-hidden': 'true' },
      icon('developer_board', { size: 26 }),
      badge ? h('span', { class: ['st-drv-badge', badge] }, icon(badge === 'ok' ? 'checkmark_circle' : 'arrow_clockwise', { size: 18, filled: true })) : null,
    );
    const pct = Math.round(state.progress || 0);
    const progress = busy
      ? h(
          'div',
          { class: 'st-drv-progress' },
          h('div', { class: 'st-drv-progress-line' }, h('span', { class: 'caption text-2 ellipsis' }, state.step), h('span', { class: 'caption' }, pc.lang === 'fr' ? `${pct} %` : `${pct}%`)),
          h('div', { class: 'progress', role: 'progressbar', 'aria-label': title, 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct) }, h('div', { class: 'bar', style: { width: `${pct}%` } })),
        )
      : null;
    return h(
      'section',
      { class: 'st-drv-hero', 'aria-live': 'polite' },
      art,
      h('div', { class: 'st-hero-text' }, h('div', { class: 'st-hero-title' }, title), h('div', { class: 'st-hero-sub' }, sub)),
      progress,
      actions.length ? h('div', { class: 'st-hero-actions' }, actions) : null,
    );
  }

  const canChange = () => !!data.online && !!adm?.isAdmin && !data.live && !state.phase;

  function cardsGroup() {
    if (!data.gpus.length) return null;
    const vendorName = { nvidia: 'NVIDIA', amd: 'AMD', intel: 'Intel' };
    return kit.group(
      data.gpus.length > 1 ? t('drv.cardsTitleMany') : t('drv.cardsTitle'),
      ...data.gpus.map((g, i) =>
        kit.row({
          icon: g.vendor === 'nvidia' ? 'developer_board' : 'desktop',
          title: g.name,
          desc: `${vendorName[g.vendor] || t('drv.otherVendor')} · ${t('drv.driverInUse', { driver: inUseLabel(pc, data, g) })}`,
          section: i === 0 ? 'cards' : null,
          className: 'st-drv-card',
        }),
      ),
    );
  }

  function driverRow(d) {
    const { pkg } = d;
    const kind = kindOf(pkg);
    const isInstalled = pkg === data.installed;
    let control;
    if (isInstalled) control = data.rebootPending ? pill(t('drv.nextStart'), 'st-drv-pill-wait') : pill(t('drv.inUse'), 'st-drv-pill-ok');
    else if (state.phase === 'installing' && state.target === pkg) control = h('span', { class: 'spinner small', 'aria-label': t('drv.installingTitle', { name: label(pc, pkg) }) });
    else
      control = kit.button(data.installed ? t('drv.useThis') : t('drv.install'), () => runAction(pc, 'install', pkg, reload), {
        primary: d.recommended && !data.installed,
        disabled: !canChange(),
        className: 'st-drv-action',
      });
    const pills = [d.recommended ? pill(t('drv.recommended'), 'accent') : null, ...(kind === 'server-open' ? [pill(t('drv.kindServer')), pill(t('drv.kindOpen'))] : [pill(t(KIND_LABEL[kind]))])];
    const el = kit.row({
      title: h('span', { class: 'st-drv-title' }, h('span', null, `NVIDIA ${verOf(pkg)}`), ...pills),
      desc: h('span', null, t(kind === 'open' ? 'drv.descOpen' : kind === 'proprietary' ? 'drv.descProprietary' : 'drv.descServer'), h('span', { class: 'st-drv-pkg mono' }, pkg)),
      control,
      className: isInstalled ? 'st-drv-row current' : 'st-drv-row',
    });
    el.dataset.pkg = pkg;
    return el;
  }

  function freeRow() {
    let control;
    if (data.installed) {
      control = state.phase === 'removing' ? h('span', { class: 'spinner small' }) : kit.button(t('drv.backToFree'), () => confirmRemove(), { disabled: !adm?.isAdmin || data.live || !!state.phase, className: 'st-drv-free', icon: 'arrow_undo' });
    } else if (data.current.module === 'nvidia') control = pill(t('drv.nextStart'), 'st-drv-pill-wait');
    else control = pill(t('drv.inUse'), 'st-drv-pill-ok');
    return kit.row({ icon: 'shield_checkmark', title: h('span', { class: 'st-drv-title' }, h('span', null, t('drv.freeTitle')), pill(t('drv.kindFree'))), desc: t('drv.freeDesc'), control, section: 'free', className: 'st-drv-row' });
  }

  async function confirmRemove() {
    const ok = await ui.confirm(t('drv.backToFreeConfirm'), { title: t('drv.backToFree'), okLabel: t('drv.backToFreeOk'), parent: pc.win });
    if (ok) runAction(pc, 'remove', null, reload);
  }

  function nvidiaGroups() {
    if (!data.gpus.some((g) => g.vendor === 'nvidia')) return [];
    const desktop = data.available.filter((d) => d.kind === 'proprietary' || d.kind === 'open');
    const server = data.available.filter((d) => d.kind === 'server' || d.kind === 'server-open');
    // recommended first, then newest first (proprietary before open for the same version)
    desktop.sort((a, b) => b.recommended - a.recommended || verOf(b.pkg) - verOf(a.pkg) || (a.kind === 'open') - (b.kind === 'open'));
    const out = [];
    if (!data.available.length) {
      const noTool = data.tools && !data.tools.ubuntuDrivers;
      out.push(
        kit.group(
          t('drv.listTitle'),
          kit.row({
            icon: noTool ? 'warning' : 'search',
            title: noTool ? t('drv.noTool') : t('drv.noListTitle'),
            desc: noTool ? null : data.online ? t('drv.noList') : t('drv.noListOffline'),
            section: 'nvidia',
            control: noTool ? null : state.phase === 'searching' ? h('span', { class: 'spinner small' }) : kit.button(t('drv.search'), () => search(pc, reload), { disabled: !canChange(), className: 'st-drv-search', icon: 'search' }),
          }),
          freeRow(),
        ),
      );
      return out;
    }
    const rows = desktop.map(driverRow);
    if (rows[0]) rows[0].dataset.section = 'nvidia';
    out.push(kit.group(t('drv.listTitle'), ...rows, freeRow()));
    if (server.length) {
      out.push(
        kit.group(
          null,
          kit.expander({
            icon: 'server',
            title: t('drv.serverTitle'),
            desc: t('drv.serverDesc'),
            open: server.some((d) => d.pkg === data.installed),
            body: () => h('div', { class: 'st-drv-server' }, server.map(driverRow)),
          }),
        ),
      );
    }
    return out;
  }

  function infobars() {
    const out = [];
    const nv = data.gpus.some((g) => g.vendor === 'nvidia');
    if (state.error) out.push(kit.infobar({ kind: 'error', title: state.error.title, message: state.error.message, className: 'st-drv-error' }));
    if (data.rebootPending && state.later && !state.phase) out.push(kit.infobar({ kind: 'info', message: t('drv.laterInfo') }));
    if (!nv) return out;
    if (!data.online) out.push(kit.infobar({ kind: 'warning', title: t('drv.offlineTitle'), message: t('drv.offline'), className: 'st-drv-offline' }));
    if (data.live) out.push(kit.infobar({ kind: 'info', message: t('drv.live') }));
    else if (adm && !adm.isAdmin) out.push(kit.infobar({ kind: 'info', message: t('drv.adminOnly') }));
    const igpu = data.gpus.find((g) => g.vendor !== 'nvidia');
    if (igpu) out.push(kit.infobar({ kind: 'info', message: t('drv.optimus', { igpu: igpu.name }), className: 'st-drv-optimus' }));
    if (data.secureBoot) out.push(kit.infobar({ kind: 'success', message: t('drv.secureBoot'), className: 'st-drv-sb' }));
    return out;
  }

  const paint = () => {
    if (!data) {
      ui.clear(root);
      root.append(kit.infobar({ kind: 'warning', title: t('drv.unavailableTitle'), message: t('drv.unavailable') }));
      return;
    }
    const keep = root.querySelector('.st-exp-body:not([hidden])') != null;
    ui.clear(root);
    root.append(
      hero(),
      ...infobars(),
      cardsGroup() || '',
      ...nvidiaGroups(),
      kit.related([
        { icon: 'desktop', title: pc.pageTitle('display'), desc: t('drv.relatedDisplay'), onClick: () => pc.go('display') },
        { icon: 'arrow_sync', title: pc.pageTitle('update'), desc: t('drv.relatedUpdate'), onClick: () => pc.go('update') },
      ]),
    );
    if (keep) root.querySelector('.st-drv-server')?.closest('.st-expander')?.toggle?.(true);
  };
  paint();
  listeners.add(paint);
  pc.onDispose(() => listeners.delete(paint));
  // The network coming back (or going away) enables / disables the buttons without leaving the page.
  pc.on('net:changed', async (st) => {
    const now = !st || st.connectivity !== 'none';
    if (data && now !== data.online) await reload();
  });
  return root;
}

export default { gpuDrivers };
