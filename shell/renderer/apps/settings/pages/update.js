// Settings > Aurora Update: check (apt-get update + simulation), install (apt-get upgrade with live
// progress from APT's status fd), update history (/var/log/apt/history.log).
import { parseAptSimulation, parseAptStatus, parseAptHistory } from '../lib/parse.js';

// Survives page changes while the Settings window is open (an install keeps running in the background).
const state = { phase: null, packages: null, progress: null, step: '', error: null, reboot: false, lastCheck: null, loaded: false };
const listeners = new Set();
const emit = () => listeners.forEach((fn) => fn());

async function loadSaved(pc) {
  if (state.loaded) return;
  state.loaded = true;
  const saved = await pc.storage.get('update-state', null).catch(() => null);
  if (saved) {
    state.lastCheck = saved.lastCheck || null;
    state.packages = Array.isArray(saved.packages) ? saved.packages : null;
    state.reboot = !!saved.reboot;
  }
}
const persist = (pc) => pc.storage.set('update-state', { lastCheck: state.lastCheck, packages: state.packages, reboot: state.reboot }).catch(() => {});

async function online(pc) {
  const st = await pc.tryInvoke('net:status');
  return !st || st.connectivity !== 'none';
}

async function check(pc) {
  if (state.phase === 'checking' || state.phase === 'installing') return;
  state.phase = 'checking';
  state.error = null;
  emit();
  try {
    const out = await pc.runAdmin('apt-check', [], 'update.reasonCheck');
    state.packages = parseAptSimulation(out);
    state.lastCheck = Date.now();
    state.phase = null;
    persist(pc);
  } catch (err) {
    state.phase = null;
    if (err.code !== 'ECANCELED') state.error = err.message;
  }
  emit();
}

async function install(pc) {
  if (state.phase) return;
  state.phase = 'installing';
  state.progress = 0;
  state.step = pc.t('update.preparing');
  state.error = null;
  emit();
  const off = pc.api.on('admin:progress', ({ action, line }) => {
    if (action !== 'apt-upgrade') return;
    if (line === 'reboot-required') state.reboot = true;
    const s = parseAptStatus(line);
    if (!s) return;
    if (s.phase === 'error') {
      state.step = s.message;
      return emit();
    }
    state.progress = Math.max(state.progress || 0, s.percent);
    state.step = s.phase === 'download' ? pc.t('update.downloading', { pct: Math.round(s.step) }) : pc.t('update.installingPkg', { pkg: s.pkg || '' });
    emit();
  });
  try {
    const out = await pc.runAdmin('apt-upgrade', [], 'update.reasonInstall');
    if (/^reboot-required$/m.test(out || '')) state.reboot = true;
    state.progress = 100;
    state.packages = [];
    state.lastCheck = Date.now();
    state.phase = 'done';
    persist(pc);
    pc.shell.notify({ title: pc.t('update.installedTitle'), body: state.reboot ? pc.t('update.installedReboot') : pc.t('update.installedBody'), appId: 'settings' });
  } catch (err) {
    state.phase = null;
    if (err.code !== 'ECANCELED') state.error = err.message;
  } finally {
    off();
  }
  emit();
}

function when(pc, ms) {
  if (!ms) return pc.t('update.never');
  const d = new Date(ms);
  const today = new Date();
  const time = pc.i18n.formatTime(d, { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return pc.t('update.todayAt', { time });
  return `${pc.i18n.formatDate(d, { dateStyle: 'medium' })} ${time}`;
}

async function update(pc) {
  const { h, t, kit, icon } = pc;
  await loadSaved(pc);
  const [adm, info, onlineNow] = await Promise.all([pc.adminStatus(), pc.tryInvoke('sys:info'), online(pc)]);
  let isOnline = onlineNow;
  const root = h('div');
  const paint = () => {
    pc.ui.clear(root);
    const pk = state.packages;
    const n = pk?.length || 0;
    let title;
    let sub;
    let badge = null;
    if (state.phase === 'checking') {
      title = t('update.checking');
      sub = t('update.checkingDesc');
    } else if (state.phase === 'installing') {
      title = t('update.installing');
      sub = t('update.keepOn');
    } else if (state.phase === 'done') {
      title = state.reboot ? t('update.restartRequired') : t('update.upToDate');
      sub = state.reboot ? t('update.restartDesc') : t('update.lastChecked', { when: when(pc, state.lastCheck) });
      badge = 'ok';
    } else if (pk && n) {
      title = t('update.available', { count: n });
      sub = t('update.lastChecked', { when: when(pc, state.lastCheck) });
      badge = 'pending';
    } else if (pk) {
      title = t('update.upToDate');
      sub = t('update.lastChecked', { when: when(pc, state.lastCheck) });
      badge = 'ok';
    } else {
      title = t('update.unknown');
      sub = t('update.unknownDesc');
    }
    const busy = state.phase === 'checking' || state.phase === 'installing';
    const art = h(
      'div',
      { class: ['st-upd-icon', busy && 'spinning'], 'aria-hidden': 'true' },
      icon('arrow_sync', { size: 60 }),
      badge ? h('span', { class: ['st-upd-badge', badge] }, icon(badge === 'ok' ? 'checkmark_circle' : 'arrow_circle_down', { size: 24, filled: true })) : null,
    );
    const actions = [];
    if (state.reboot && !busy) actions.push(kit.button(t('update.restartNow'), () => pc.shell.reboot().catch(pc.toastError), { primary: true, icon: 'arrow_clockwise' }));
    else if (n && !busy && state.phase !== 'done') actions.push(kit.button(t('update.installNow'), () => install(pc), { primary: true, disabled: !isOnline || !adm?.isAdmin }));
    if (!busy) actions.push(kit.button(t('update.check'), () => check(pc), { primary: !n && !state.reboot, disabled: !isOnline || !adm?.isAdmin }));
    const progress =
      state.phase === 'installing'
        ? h(
            'div',
            { class: 'st-upd-progress' },
            h('div', { class: 'row', style: { justifyContent: 'space-between' } }, h('span', { class: 'caption text-2 ellipsis' }, state.step), h('span', { class: 'caption' }, pc.lang === 'fr' ? `${Math.round(state.progress || 0)} %` : `${Math.round(state.progress || 0)}%`)),
            h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(state.progress || 0)) }, h('div', { class: 'bar', style: { width: `${state.progress || 0}%` } })),
          )
        : state.phase === 'checking'
          ? h('div', { class: 'st-upd-progress' }, h('div', { class: 'progress indeterminate', role: 'progressbar', 'aria-label': t('update.checking') }, h('div', { class: 'bar' })))
          : null;
    const blocks = [
      h('div', { class: 'st-upd-hero' }, art, h('div', { class: 'st-hero-text' }, h('div', { class: 'st-hero-title' }, title), h('div', { class: 'st-hero-sub' }, sub)), progress, h('div', { class: 'st-hero-actions' }, actions)),
    ];
    if (!isOnline) blocks.push(kit.infobar({ kind: 'warning', title: t('update.offlineTitle'), message: t('update.offline') }));
    if (!adm?.isAdmin) blocks.push(kit.infobar({ kind: 'info', message: t('update.adminOnly') }));
    if (adm?.live) blocks.push(kit.infobar({ kind: 'info', message: t('update.live') }));
    if (state.error) blocks.push(kit.infobar({ kind: 'error', title: t('update.errorTitle'), message: state.error }));
    if (n) {
      blocks.push(
        kit.group(
          null,
          kit.expander({
            icon: 'arrow_download',
            title: t('update.listTitle', { count: n }),
            desc: pk.some((p) => p.security) ? t('update.includesSecurity', { count: pk.filter((p) => p.security).length }) : t('update.listDesc'),
            open: n <= 8,
            body: () =>
              h(
                'div',
                { class: 'st-pkg-list' },
                pk.map((p) =>
                  h(
                    'div',
                    { class: 'st-pkg' },
                    h('div', { class: 'row', style: { gap: '8px' } }, h('span', null, p.name), p.security ? h('span', { class: 'st-pill accent' }, t('update.security')) : null),
                    h('span', { class: 'caption text-2 mono' }, p.to),
                    h('span', { class: 'caption text-2' }, p.from ? t('update.fromTo', { from: p.from }) : t('update.newPackage')),
                  ),
                ),
              ),
          }),
        ),
      );
    }
    blocks.push(
      kit.group(
        t('update.more'),
        kit.row({ icon: 'history', title: pc.pageTitle('updateHistory'), desc: t('update.historyDesc'), onClick: () => pc.go('updateHistory') }),
        kit.expander({
          icon: 'info',
          title: t('update.advanced'),
          desc: t('update.advancedDesc'),
          body: () =>
            h(
              'div',
              { class: 'st-kv st-sub-pad' },
              [
                [t('about.edition'), info?.osName || 'Aurora OS'],
                [t('about.version'), info?.version || pc.env.version || '—'],
                [t('about.build'), info?.buildId || 'dev'],
                [t('about.base'), info?.distro || '—'],
                [t('about.kernel'), info?.kernel || '—'],
                [t('update.source'), t('update.sourceValue')],
              ].flatMap(([k, v]) => [h('div', { class: 'k' }, k), h('div', { class: 'v' }, v)]),
            ),
        }),
      ),
    );
    root.append(...blocks);
  };
  paint();
  listeners.add(paint);
  pc.onDispose(() => listeners.delete(paint));
  // The network coming back (or going away) enables / disables the buttons without leaving the page.
  pc.on('net:changed', (st) => {
    const now = !st || st.connectivity !== 'none';
    if (now !== isOnline) {
      isOnline = now;
      paint();
    }
  });
  return root;
}

async function updateHistory(pc) {
  const { h, t, kit, icon } = pc;
  let text = null;
  for (const f of ['/var/log/apt/history.log']) {
    text = await pc.api.invoke('fs:readText', f).catch(() => null);
    if (text != null) break;
  }
  const entries = parseAptHistory(text || '').filter((e) => e.upgrade.length || e.install.length || e.remove.length);
  if (!entries.length) return h('div', { class: 'st-empty' }, icon('history', { size: 40 }), h('div', { class: 'body-large' }, t('update.noHistory')), h('div', null, t('update.noHistoryDesc')));
  const fmt = (ms) => (ms ? `${pc.i18n.formatDate(ms, { dateStyle: 'medium' })} ${pc.i18n.formatTime(ms, { hour: 'numeric', minute: '2-digit' })}` : '—');
  return h(
    'div',
    null,
    kit.group(
      t('update.historyTitle'),
      ...entries.slice(0, 60).map((e) => {
        const parts = [];
        if (e.upgrade.length) parts.push(t('update.nUpdated', { count: e.upgrade.length }));
        if (e.install.length) parts.push(t('update.nInstalled', { count: e.install.length }));
        if (e.remove.length) parts.push(t('update.nRemoved', { count: e.remove.length }));
        return kit.expander({
          icon: e.error ? 'error_circle' : 'checkmark_circle',
          title: parts.join(' · '),
          desc: `${fmt(e.start)}${e.requestedBy ? ` · ${e.requestedBy}` : ''}${e.error ? ` · ${t('update.failed')}` : ''}`,
          body: () =>
            h(
              'div',
              { class: 'st-pkg-list' },
              [...e.upgrade.map((p) => [p, 'up']), ...e.install.map((p) => [p, 'in']), ...e.remove.map((p) => [p, 'rm'])].map(([p, k]) =>
                h(
                  'div',
                  { class: 'st-pkg' },
                  h('span', null, p.name),
                  h('span', { class: 'caption text-2 mono' }, p.to || ''),
                  h('span', { class: 'caption text-2' }, k === 'up' ? (p.from ? t('update.fromTo', { from: p.from }) : '') : k === 'in' ? t('update.installedPkg') : t('update.removedPkg')),
                ),
              ),
            ),
        });
      }),
    ),
  );
}

export default { update, updateHistory };
