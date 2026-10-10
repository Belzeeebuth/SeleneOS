// Actions shared by the pages: ending processes (with elevation and "not responding" follow-up),
// efficiency mode / priority, Properties, Open file location, Search online, Run new task.
import { registry } from '../../../core/registry.js';
import { priorityOf, PRIORITIES, CRITICAL, processIcon } from './util.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createActions(app) {
  const { ctx } = app;
  const { api, ui, shell, h, icon, win } = ctx;
  const t = (k, v) => ctx.t(k, v);

  async function alertErr(message, title) {
    await ui.alert(message, { title: title || t('err.title'), parent: win });
  }

  // Run a privileged helper action through the UAC prompt. false when cancelled or failed.
  async function elevate(action, args, reason) {
    try {
      await shell.runAdmin(action, args.map(String), { reason, appId: 'taskmgr' });
      return true;
    } catch (err) {
      if (err?.code === 'ECANCELED') return false;
      await alertErr(t('err.admin', { msg: err?.message || String(err) }));
      return false;
    }
  }

  // aurora-admin takes signal names without the SIG prefix (TERM, KILL, STOP, CONT…).
  const helperSig = (sig) => String(sig).replace(/^SIG/, '');

  // Does the admin helper offer "renice"? Probed without a password: unknown actions are rejected
  // by the argument validation before any authentication or prompt.
  let reniceSupport = null;
  async function canElevateRenice() {
    if (reniceSupport != null) return reniceSupport;
    try {
      await api.invoke('admin:run', '', 'renice', []);
      reniceSupport = true;
    } catch (err) {
      reniceSupport = !(err?.code === 'ENOHANDLER' || /not allowed/i.test(err?.message || ''));
    }
    return reniceSupport;
  }
  canElevateRenice();
  const isRoot = () => ctx.env.uid === 0;

  async function alive(pids) {
    try {
      const m = await api.invoke('proc:alive', pids);
      return pids.filter((p) => m[p]);
    } catch {
      return [];
    }
  }

  async function signal(pids, sig, name) {
    const denied = [];
    let firstErr = null;
    for (const pid of pids) {
      try {
        await api.invoke('proc:kill', pid, sig);
      } catch (err) {
        if (err.code === 'EPERM') denied.push(pid);
        else if (err.code !== 'ESRCH') firstErr = firstErr || err;
      }
    }
    for (const pid of denied) {
      const ok = await elevate('kill-process', [pid, helperSig(sig)], t('uac.end', { name, pid }));
      if (!ok) break;
    }
    if (firstErr) await alertErr(t('err.end', { name, msg: firstErr.message }));
  }

  // End processes gracefully (SIGTERM); if they are still there after a moment, offer to end them now.
  async function endProcesses(pids, { name, critical = false, confirm = false } = {}) {
    pids = [...new Set(pids)].filter((p) => p > 1);
    if (!pids.length) return;
    if (critical) {
      const ok = await ui.confirm(t('confirm.criticalBody', { name }), { title: t('confirm.criticalTitle', { name }), okLabel: t('confirm.endProcess'), danger: true, parent: win });
      if (!ok) return;
    } else if (confirm) {
      const ok = await ui.confirm(t('confirm.endBody'), { title: t('confirm.endTitle', { name }), okLabel: t('confirm.endProcess'), parent: win });
      if (!ok) return;
    }
    await signal(pids, 'SIGTERM', name);
    app.store.refresh();
    let left = pids;
    for (let i = 0; i < 10 && left.length; i++) {
      await sleep(300);
      left = await alive(left);
    }
    if (left.length) {
      const v = await ui.dialog({
        title: t('notResponding.title', { name }),
        body: t('notResponding.body'),
        parent: win,
        buttons: [
          { label: t('notResponding.endNow'), value: 'kill', primary: true },
          { label: t('notResponding.wait'), value: null },
        ],
      });
      if (v === 'kill') await signal(left, 'SIGKILL', name);
    }
    app.store.refresh();
  }

  async function endTree(pid, name) {
    const ok = await ui.confirm(t('confirm.treeBody'), { title: t('confirm.treeTitle', { name }), okLabel: t('confirm.endTree'), danger: true, parent: win });
    if (!ok) return;
    try {
      const res = await api.invoke('proc:killTree', pid, 'SIGTERM');
      for (const f of res.failed || []) {
        if (f.code === 'EPERM') {
          if (!(await elevate('kill-process', [f.pid, 'TERM'], t('uac.end', { name, pid: f.pid })))) break;
        }
      }
    } catch (err) {
      if (err.code === 'EPERM') await elevate('kill-process', [pid, 'TERM'], t('uac.end', { name, pid }));
      else if (err.code !== 'ESRCH') await alertErr(t('err.end', { name, msg: err.message }));
    }
    app.store.refresh();
  }

  async function setNice(pids, nice, name) {
    for (const pid of pids) {
      try {
        await api.invoke('proc:setPriority', pid, nice);
      } catch (err) {
        if (err.code === 'ESRCH') continue;
        if (err.code === 'EACCES' || err.code === 'EPERM') {
          if (await canElevateRenice()) {
            if (!(await elevate('renice', [nice, pid], t('uac.priority', { name, pid })))) return false;
            continue;
          }
          await alertErr(t(nice >= 19 ? 'err.priorityOther' : 'err.priorityAdmin', { name }));
          return false;
        }
        await alertErr(t('err.priority', { name, msg: err.message }));
        return false;
      }
    }
    app.store.refresh();
    return true;
  }

  async function setEfficiency(pids, on, name) {
    if (on && app.prefs.effConfirm) {
      const dont = h('input', { type: 'checkbox' });
      const v = await ui.dialog({
        title: t('eff.title'),
        body: h('div', { class: 'tm-dlg' }, h('p', { class: 'tm-dlg-text' }, t('eff.body')), h('label', { class: 'checkbox' }, dont, h('span', null, t('eff.dontAsk')))),
        parent: win,
        buttons: [
          { label: t('eff.turnOn'), value: 'on', primary: true },
          { label: t('common.cancel'), value: null },
        ],
      });
      if (v !== 'on') return false;
      if (dont.checked) app.setPref('effConfirm', false);
    }
    return setNice(pids, on ? 19 : 0, name);
  }

  async function suspend(pids, on, name) {
    await signal(pids, on ? 'SIGSTOP' : 'SIGCONT', name);
    app.store.refresh();
  }

  async function openLocation(pid) {
    try {
      const info = await api.invoke('proc:info', pid);
      if (!info.exe) throw new Error(t('err.noLocation'));
      const dir = info.exe.replace(/\/[^/]*$/, '') || '/';
      await shell.launch('files', { path: dir, select: info.exe });
    } catch (err) {
      await alertErr(err.code === 'ESRCH' ? t('err.gone') : err.message || t('err.noLocation'));
    }
  }

  function searchOnline(name) {
    shell.openUrl(`https://duckduckgo.com/?q=${encodeURIComponent(`${name} ${t('search.onlineSuffix')}`)}`);
  }

  function bigIcon(desc) {
    if (desc?.src) return h('img', { src: desc.src, width: 32, height: 32, alt: '' });
    const el = icon(desc?.name || 'app_generic', { size: 32, filled: desc?.filled });
    el.classList.add(`tone-${desc?.tone || 'neutral'}`);
    return el;
  }

  function kv(rows) {
    return h(
      'dl',
      { class: 'tm-kv selectable' },
      rows.filter((r) => r && r[1] != null && r[1] !== '').map(([k, v]) => [h('dt', null, k), h('dd', null, v)]),
    );
  }

  async function processProperties(pid, label, iconDesc) {
    let info;
    try {
      info = await api.invoke('proc:info', pid);
    } catch (err) {
      return alertErr(err.code === 'ESRCH' ? t('err.gone') : err.message);
    }
    const f = app.fmt;
    const st = { R: 'running', S: 'running', D: 'running', I: 'running', T: 'suspended', t: 'suspended', Z: 'zombie', X: 'zombie' }[info.state] || 'running';
    const body = h(
      'div',
      { class: 'tm-props' },
      h('div', { class: 'tm-props-head' }, bigIcon(iconDesc || processIcon(info)), h('div', null, h('div', { class: 'body-strong selectable' }, label || info.name), h('div', { class: 'caption text-2' }, info.kernel ? t('props.kernelThread') : t('props.process')))),
      kv([
        [t('props.location'), info.exe || t('props.na')],
        [t('props.cmdline'), info.cmdline || `[${info.comm}]`],
        [t('col.pid'), String(info.pid)],
        [t('props.parent'), info.ppid ? `${info.parentName} (${info.ppid})` : t('props.none')],
        [t('col.user'), info.user],
        [t('col.status'), t(`status.${st}`)],
        [t('props.started'), f.date(info.startTime)],
        [t('col.cpuTime'), f.duration(info.cpuTime)],
        [t('col.threads'), f.int(info.threads)],
        [t('col.priority'), `${t(`prio.${priorityOf(info.nice)}`)} (nice ${info.nice})`],
        [t('props.memory'), f.size(info.mem)],
        [t('props.peak'), info.peak != null ? f.size(info.peak) : null],
        [t('props.files'), info.fds != null ? f.int(info.fds) : t('props.denied')],
        [t('props.service'), info.unit || null],
        [t('props.cwd'), info.cwd || null],
      ]),
    );
    const v = await ui.dialog({
      title: t('props.title', { name: label || info.name }),
      body,
      parent: win,
      width: 520,
      buttons: [
        { label: t('common.ok'), value: true, primary: true },
        info.exe ? { label: t('menu.openLocation'), value: 'open' } : null,
      ].filter(Boolean),
    });
    if (v === 'open') openLocation(pid);
  }

  async function appProperties(appId, wins, procs) {
    const m = registry.get(appId);
    const f = app.fmt;
    const name = m ? registry.name(appId) : wins[0]?.title || appId;
    const desc = m?.description ? ctx.i18n.name(m.description) : '';
    const sh = app.store.shellInfo;
    const body = h(
      'div',
      { class: 'tm-props' },
      h('div', { class: 'tm-props-head' }, h('img', { src: m ? registry.iconUrl(appId) : wins[0]?.iconUrl, width: 32, height: 32, alt: '' }), h('div', null, h('div', { class: 'body-strong' }, name), h('div', { class: 'caption text-2' }, t('props.auroraApp')))),
      kv([
        [t('props.description'), desc || null],
        [t('props.appId'), appId],
        [t('props.windows'), wins.map((w) => w.title || name).join('\n')],
        [t('props.openedAt'), wins.length ? f.date(Math.min(...wins.map((w) => w.createdAt || Date.now()))) : null],
        [t('props.host'), procs.length ? t('props.ownProcesses', { pids: procs.map((p) => p.pid).join(', ') }) : t('props.inShell', { pid: sh?.mainPid ?? '?' })],
      ]),
    );
    await ui.dialog({ title: t('props.title', { name }), body, parent: win, width: 520 });
  }

  // ------------------------------------------------------------------ Run new task
  const ALIASES = { calc: 'calculator', explorer: 'files', 'explorer.exe': 'files', taskmgr: 'taskmgr', 'taskmgr.exe': 'taskmgr', mspaint: 'paint', notepad: 'notepad', cmd: 'terminal', control: 'settings', winver: 'winver', msedge: 'browser' };

  async function execute(cmd) {
    const s = cmd.trim();
    const lower = s.toLowerCase();
    const apps = registry.list({ includeHidden: true });
    const byId = apps.find((m) => m.id === lower) || apps.find((m) => m.id === ALIASES[lower]);
    const byName = byId || apps.find((m) => registry.name(m.id).toLowerCase() === lower);
    if (byName) {
      await shell.launch(byName.id);
      return;
    }
    if (/^(https?:\/\/|www\.)\S+$/i.test(s)) {
      shell.openUrl(/^www\./i.test(s) ? `https://${s}` : s);
      return;
    }
    if (/^(~|\/)/.test(s) && !/\s/.test(s)) {
      const p = s.startsWith('~') ? ctx.env.home + s.slice(1) : s;
      if (await api.invoke('fs:exists', p)) {
        await shell.openFile(p);
        return;
      }
    }
    await api.invoke('proc:spawn', s);
    app.store.refresh();
  }

  async function runNewTask(initial = '') {
    let history = [];
    try {
      history = (await ctx.storage.get('run-history', [])) || [];
    } catch {}
    const listId = `tm-run-list-${Date.now()}`;
    const input = h('input', { class: 'input grow', value: initial || history[0] || '', list: listId, spellcheck: false, 'aria-label': t('run.open') });
    const datalist = h(
      'datalist',
      { id: listId },
      history.map((x) => h('option', { value: x })),
      registry.list().map((m) => h('option', { value: m.id, label: registry.name(m.id) })),
    );
    const browse = h('button', { class: 'btn', type: 'button' }, t('run.browse'));
    browse.addEventListener('click', async () => {
      const p = await ui.filePicker({ mode: 'open', parent: win, title: t('run.browseTitle') });
      if (p) {
        input.value = /\s/.test(p) ? `"${p}"` : p;
        input.focus();
      }
    });
    const body = h(
      'div',
      { class: 'tm-run' },
      h('div', { class: 'tm-run-intro' }, h('img', { src: ctx.appUrl('icon.svg'), width: 32, height: 32, alt: '' }), h('p', { class: 'tm-dlg-text' }, t('run.intro'))),
      h('label', { class: 'tm-run-row' }, h('span', { class: 'tm-run-lab' }, t('run.open')), input, browse),
      datalist,
    );
    const v = await ui.dialog({
      title: t('run.title'),
      body,
      parent: win,
      width: 480,
      buttons: [
        { label: t('common.ok'), value: 'ok', primary: true },
        { label: t('common.cancel'), value: null },
      ],
      onOpen: (dlg) => {
        dlg._validate = (val) => (val === 'ok' ? !!input.value.trim() : true);
        setTimeout(() => input.select(), 40);
      },
    });
    if (v !== 'ok') return;
    const cmd = input.value.trim();
    try {
      await execute(cmd);
      const next = [cmd, ...history.filter((x) => x !== cmd)].slice(0, 20);
      ctx.storage.set('run-history', next).catch(() => {});
    } catch (err) {
      await alertErr(err.code === 'ENOENT' ? t('run.notFound', { cmd: cmd.split(/\s+/)[0] }) : err.message, t('run.title'));
      return runNewTask(cmd);
    }
  }

  // Without root (or a "renice" helper action) the kernel only lets you lower your own processes' priority.
  function priorityMenu(pid, nice, name, uid) {
    const cur = priorityOf(nice);
    const free = isRoot() || reniceSupport === true;
    const own = uid == null || uid === ctx.env.uid;
    return PRIORITIES.map((p) => ({ label: t(`prio.${p.id}`), checked: cur === p.id, disabled: !free && (!own || p.nice < nice), action: () => setNice([pid], p.nice, name) }));
  }

  const isCritical = (name, pid) => CRITICAL.has(name) || pid === app.store.shellInfo?.mainPid;

  return { endProcesses, endTree, setNice, setEfficiency, suspend, openLocation, searchOnline, processProperties, appProperties, runNewTask, priorityMenu, elevate, isCritical, alertErr };
}
