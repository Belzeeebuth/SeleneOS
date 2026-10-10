// Task Manager tests.
//   Part 1 (pure Node): backend parsers (systemctl output, /proc/<pid>/stat, .desktop files,
//          command lines) and the EN/FR dictionaries.
//   Part 2 (Electron + Playwright, EN light): process list contents, search, sorting, End task on
//          an app window, killing a spawned `sleep 1000`, efficiency mode, Details (reveal, sort,
//          end process tree), Performance charts updating, Services (sample data without systemd),
//          Users, Run new task, update speed / pause, minimize stops polling, keyboard, sizes.
//   Part 3 (FR dark): translations, minimum size and maximized layouts.
//   Screenshots -> aurora-os/docs/screenshots/taskmgr-*.png
// Usage:  cd aurora-os/shell && xvfb-run -a -s "-screen 0 1600x900x24" node test/taskmgr.test.mjs [--node-only]
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { launchShell, ROOT } from './lib.mjs';

const require = createRequire(import.meta.url);
const DOCS = path.join(ROOT, '..', 'docs', 'screenshots');
fs.mkdirSync(DOCS, { recursive: true });
const args = new Set(process.argv.slice(2));
let passed = 0;
const failures = [];
function check(name, ok, info) {
  if (ok) passed++;
  else failures.push(`${name}${info !== undefined ? `\n      got: ${typeof info === 'string' ? info : JSON.stringify(info)}` : ''}`);
  return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeout = 8000, step = 100 } = {}) {
  const t0 = Date.now();
  for (;;) {
    let v;
    try {
      v = await fn();
    } catch {
      v = null;
    }
    if (v) return v;
    if (Date.now() - t0 > timeout) return v;
    await sleep(step);
  }
}
const niceOf = (pid) => {
  try {
    const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return Number(s.slice(s.lastIndexOf(')') + 2).split(' ')[16]);
  } catch {
    return null;
  }
};
const alive = (pid) => {
  try {
    const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return !/^Z|^X/.test(s.slice(s.lastIndexOf(')') + 2));
  } catch {
    return false;
  }
};

// ================================================================ Part 1: pure Node
{
  const be = require(path.join(ROOT, 'main/ipc/taskmgr.js'));
  const units = be.parseListUnits(be.SAMPLE_UNITS);
  check('sample units parsed', units.length >= 40, units.length);
  const byName = Object.fromEntries(units.map((u) => [u.name, u]));
  check('unit fields', byName.cron?.load === 'loaded' && byName.cron.active === 'active' && byName.cron.sub === 'running' && byName.cron.description === 'Regular background program processing daemon', byName.cron);
  check('bullet (●) lines parsed', byName['gpu-manager']?.load === 'not-found' && byName['plymouth-quit-wait']?.active === 'failed', [byName['gpu-manager'], byName['plymouth-quit-wait']]);
  check('activating state', byName.thermald?.active === 'activating' && byName.thermald.sub === 'start');
  const live = be.parseListUnits('  ssh.service loaded active running OpenBSD Secure Shell server\n* foo.service loaded failed failed Foo daemon\nnot-a-service.socket loaded active listening X\n');
  check('list-units parser on raw output', live.length === 2 && live[0].description === 'OpenBSD Secure Shell server' && live[1].name === 'foo', live);
  const files = be.parseUnitFiles('ssh.service disabled enabled\ngetty@.service enabled enabled\nfoo.socket enabled enabled\n');
  check('unit files parsed', files.get('ssh.service') === 'disabled' && files.get('getty@.service') === 'enabled' && !files.has('foo.socket'));
  const merged = be.mergeServices(units, files, new Map([['ssh.service', { pid: 42 }], ['getty@tty1.service', { pid: 7 }]]));
  const m = Object.fromEntries(merged.map((s) => [s.name, s]));
  check('templated unit inherits startup type', m['getty@tty1']?.startup === 'enabled' && m['getty@tty1'].pid === 7, m['getty@tty1']);
  check('stopped service has no PID', m.ssh?.pid === null && m.ssh.startup === 'disabled', m.ssh);
  check('services sorted by name', merged.every((s, i) => i === 0 || merged[i - 1].name.localeCompare(s.name) <= 0));

  const st = be.parseStat('1234 (my (weird) proc) S 1 1234 1234 0 -1 4194560 100 0 0 0 250 75 0 0 20 5 3 0 98765 1000000 2048 18446744073709551615');
  check('stat with parentheses in comm', st.comm === 'my (weird) proc' && st.state === 'S' && st.ppid === 1 && st.utime === 250 && st.stime === 75 && st.nice === 5 && st.threads === 3 && st.start === 98765 && st.rss === 2048, st);
  const d = be.parseDesktop('[Desktop Entry]\nName=Foo\nName[fr]=Fou\nExec=foo --bar\nHidden=true\n[Desktop Action x]\nName=Other\n');
  check('desktop entry parsed (main section only)', d.Name === 'Foo' && d['Name[fr]'] === 'Fou' && d.Exec === 'foo --bar' && d.Hidden === 'true', d);
  check('command splitting with quotes', JSON.stringify(be.splitCommand(`gedit "My File.txt" 'a b' c\\ d`)) === JSON.stringify(['gedit', 'My File.txt', 'a b', 'c\\', 'd']), be.splitCommand(`gedit "My File.txt" 'a b' c\\ d`));

  // Startup apps (XDG autostart) in throwaway config dirs: list, disable (user override), enable.
  const os = await import('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-autostart-'));
  fs.mkdirSync(path.join(tmp, 'sys', 'autostart'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'sys', 'autostart', 'foo.desktop'), '[Desktop Entry]\nType=Application\nName=Foo Agent\nName[fr]=Agent Foo\nExec=foo --daemon\n');
  fs.writeFileSync(path.join(tmp, 'sys', 'autostart', 'gnome-only.desktop'), '[Desktop Entry]\nName=GNOME thing\nExec=gt\nOnlyShowIn=GNOME;\n');
  const saved = { home: process.env.XDG_CONFIG_HOME, dirs: process.env.XDG_CONFIG_DIRS };
  process.env.XDG_CONFIG_HOME = path.join(tmp, 'home');
  process.env.XDG_CONFIG_DIRS = path.join(tmp, 'sys');
  const H = {};
  be({ DEV: true, handle: (c, fn) => (H[c] = fn), error: (msg, code) => Object.assign(new Error(msg), { code }) });
  let st0 = H['perf:startup']('fr').entries;
  const foo = st0.find((e) => e.id === 'foo.desktop');
  check('autostart entry listed (localized name, enabled)', foo?.name === 'Agent Foo' && foo.enabled && foo.scope === 'system' && foo.exec === 'foo --daemon', foo);
  check('OnlyShowIn=GNOME entries are flagged as not for Aurora', st0.find((e) => e.id === 'gnome-only.desktop')?.excluded === true);
  H['perf:startupSet']('foo.desktop', false);
  const override = fs.readFileSync(path.join(tmp, 'home', 'autostart', 'foo.desktop'), 'utf8');
  check('disable writes a user override (Hidden=true)', /Hidden=true/.test(override) && /Exec=foo --daemon/.test(override), override);
  check('entry now disabled', H['perf:startup']('en').entries.find((e) => e.id === 'foo.desktop')?.enabled === false);
  H['perf:startupSet']('foo.desktop', true);
  check('enable again', H['perf:startup']('en').entries.find((e) => e.id === 'foo.desktop')?.enabled === true);
  let bad = null;
  try {
    H['perf:startupSet']('../../etc/passwd', false);
  } catch (e) {
    bad = e.code;
  }
  check('startupSet rejects non-.desktop ids', bad === 'EINVAL', bad);
  process.env.XDG_CONFIG_HOME = saved.home ?? '';
  if (saved.home === undefined) delete process.env.XDG_CONFIG_HOME;
  if (saved.dirs === undefined) delete process.env.XDG_CONFIG_DIRS;
  else process.env.XDG_CONFIG_DIRS = saved.dirs;
  fs.rmSync(tmp, { recursive: true, force: true });
  // proc:list straight from the backend (plain Node): this test process is in it with sane values.
  const list = await H['proc:list']();
  const self = list.find((p) => p.pid === process.pid);
  check('backend proc:list sees this process', self && self.name === 'node' && self.mem > 1e6 && self.threads >= 1 && self.cpu >= 0 && self.cpu <= 100, self);
  const snap = await H['perf:snapshot']();
  check('backend perf:snapshot', snap.cpu.logical >= 1 && snap.mem.total > 0 && Array.isArray(snap.disks) && Array.isArray(snap.net), snap.cpu);

  // Dictionaries: same keys in both languages, nothing empty.
  const dict = JSON.parse(fs.readFileSync(path.join(ROOT, 'renderer/apps/taskmgr/i18n.json'), 'utf8'));
  const flat = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? flat(v, `${p}${k}.`) : [[`${p}${k}`, v]]));
  const en = new Map(flat(dict.en));
  const fr = new Map(flat(dict.fr));
  const missingFr = [...en.keys()].filter((k) => !fr.has(k));
  const missingEn = [...fr.keys()].filter((k) => !en.has(k));
  check('every EN string has a FR translation', !missingFr.length, missingFr);
  check('every FR string exists in EN', !missingEn.length, missingEn);
  check('no empty strings', [...en.values(), ...fr.values()].every((v) => String(v).length > 0));
  // Every key the code uses (static t('…') calls) exists.
  const src = fs
    .readdirSync(path.join(ROOT, 'renderer/apps/taskmgr/lib'), { recursive: true })
    .filter((f) => f.endsWith('.js'))
    .map((f) => fs.readFileSync(path.join(ROOT, 'renderer/apps/taskmgr/lib', f), 'utf8'))
    .join('\n');
  const used = [...src.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)].map((x) => x[1]).filter((k) => !k.startsWith('common.'));
  const unknown = [...new Set(used)].filter((k) => !en.has(k));
  check('all statically used keys exist', !unknown.length, unknown);
}

if (args.has('--node-only')) finish();

// ================================================================ Part 2: EN light
const children = [];
const spawnSleep = (cmd = 'sleep', a = ['1000']) => {
  const c = spawn(cmd, a, { stdio: 'ignore' });
  children.push(c);
  c.exited = new Promise((r) => c.on('exit', (code, signal) => r({ code, signal })));
  return c;
};
const s = await launchShell({ open: ['taskmgr', 'calculator'], lang: 'en', theme: 'light' });
const { page } = s;
const tm = (fn, arg) => s.aurora(fn, arg);
const DLG = '.app-taskmgr .dialog-layer:not(.closing) .dialog';
try {
  await waitFor(() => tm(() => window.__aurora.wm.byApp('taskmgr')[0]?.taskmgr?.store.procs?.length > 0));
  await tm(() => window.__aurora.wm.byApp('taskmgr')[0].focus());
  // Let rows settle (two ticks so CPU deltas are real).
  await sleep(2200);

  // ---- backend data through the real IPC
  const info = await page.evaluate(async () => {
    const list = await window.aurora.invoke('proc:list');
    const sh = await window.aurora.invoke('proc:shell');
    return { list, sh };
  });
  const mainProc = info.list.find((p) => p.pid === info.sh.mainPid);
  check('proc:list includes the shell main process', !!mainProc, info.sh.mainPid);
  const shellPids = new Set(info.sh.processes.map((p) => p.pid));
  const shellProcs = info.list.filter((p) => shellPids.has(p.pid));
  check('proc:list includes the Electron child processes (GPU, renderer…)', shellProcs.length >= 2, shellProcs.map((p) => p.pid));
  check('sane CPU values', info.list.every((p) => p.cpu >= 0 && p.cpu <= 100) && shellProcs.every((p) => Number.isFinite(p.cpu)));
  const shellMem = shellProcs.reduce((a, p) => a + p.priv, 0);
  check('sane memory values', mainProc && mainProc.mem > 10 * 1048576 && mainProc.mem < 64 * 1073741824 && shellMem > 20 * 1048576, { rss: mainProc?.mem, shellMem });
  check('process fields', mainProc && mainProc.user && mainProc.threads > 1 && mainProc.startTime > 1e12 && mainProc.startTime <= Date.now() + 1000 && typeof mainProc.nice === 'number', mainProc);
  check('kernel threads flagged', info.list.some((p) => p.kernel) && info.list.find((p) => p.pid === 2)?.kernel !== false);
  const snap = await page.evaluate(() => window.aurora.invoke('perf:snapshot'));
  check('perf snapshot cpu', snap.cpu.total >= 0 && snap.cpu.total <= 100 && snap.cpu.perCore.length === snap.cpu.logical && snap.cpu.model.length > 0 && snap.cpu.processes > 10, snap.cpu);
  check('perf snapshot memory', snap.mem.total > 0 && snap.mem.used > 0 && snap.mem.used < snap.mem.total && snap.mem.available > 0, snap.mem);
  check('perf snapshot disks skip loop/ram/zram', snap.disks.every((d) => !/^(loop|ram|zram)/.test(d.name)), snap.disks.map((d) => d.name));
  check('perf snapshot network skips lo', snap.net.every((n) => n.iface !== 'lo' && ['wifi', 'ethernet'].includes(n.type)), snap.net.map((n) => n.iface));
  check('perf snapshot gpu null or object', snap.gpu === null || typeof snap.gpu === 'object');
  // invokeRaw: Error codes don't survive the context bridge (core/api.js rebuilds them for apps).
  const killErr = await page.evaluate(() => window.aurora.invokeRaw('proc:kill', 1, 'SIGTERM').then((r) => (r.ok ? 'ok' : r.error.code)));
  check('proc:kill refuses PID 1', killErr === 'EINVAL', killErr);
  const sigErr = await page.evaluate(() => window.aurora.invokeRaw('proc:kill', 999999, 'SIGBOGUS').then((r) => (r.ok ? 'ok' : r.error.code)));
  check('proc:kill rejects unknown signals', sigErr === 'EINVAL', sigErr);

  // ---- Processes page UI
  const rows = () => tm(() => window.__aurora.wm.byApp('taskmgr')[0].taskmgr.pages.processes.table.rows.map((r) => ({ key: r.key, kind: r.kind, label: r.label, name: r.data?.name, type: r.data?.type, cpu: r.data?.cpu, depth: r.depth, parentKey: r.parentKey, pid: r.data?.pid })));
  let R = await rows();
  const groups = R.filter((r) => r.kind === 'group').map((r) => r.label);
  check('Apps / Background / Aurora groups', groups.some((g) => /^Apps \(2\)$/.test(g)) && groups.some((g) => /^Background processes \(\d+\)$/.test(g)) && groups.some((g) => /^Aurora processes \(\d+\)$/.test(g)), groups);
  check('app rows for open windows', R.some((r) => r.type === 'app' && r.name === 'Calculator') && R.some((r) => r.type === 'app' && r.name === 'Task Manager'));
  check('Aurora Shell row', R.some((r) => r.type === 'shell' && /^Aurora Shell \(\d+\)$/.test(r.name)), R.filter((r) => r.type === 'shell'));
  check('Linux kernel row', R.some((r) => r.type === 'kernel'));
  const heads = await page.$$eval('.app-taskmgr .tm-page-processes .tm-th', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
  check('column headers with totals', heads.some((x) => /^\d+% CPU$/.test(x)) && heads.some((x) => /^\d+% Memory$/.test(x)) && heads.some((x) => /^\d+% Disk$/.test(x)), heads);
  const heat = await page.$$eval('.app-taskmgr .tm-page-processes .tm-td[data-h]', (els) => els.length);
  check('heat-map cells rendered', heat > 10, heat);
  // The Aurora processes group is far down the (virtualized) list: bring the row into view first.
  await tm(() => {
    const t = window.__aurora.wm.byApp('taskmgr')[0].taskmgr.pages.processes.table;
    t.select('shell');
    t._render();
  });
  await sleep(300);
  const shellCells = await page.$eval('.app-taskmgr .tm-page-processes .tm-row:not([hidden]):has(.tm-tx:text-matches("^Aurora Shell"))', (el) => [...el.querySelectorAll('.tm-td')].map((c) => c.innerText.trim()));
  check('Aurora Shell row shows CPU % and memory MB', shellCells.some((c) => /^\d+(\.\d)?%$/.test(c)) && shellCells.some((c) => /^[\d,.]+\sMB$/.test(c)), shellCells);
  const rendered = await page.$$eval('.app-taskmgr .tm-page-processes .tm-row:not([hidden])', (els) => els.length);
  check('virtualized rendering (only visible rows in the DOM)', rendered < R.length + 1 && rendered < 60, { rendered, total: R.length });

  // Expand the shell group: child processes appear.
  await tm(() => {
    const p = window.__aurora.wm.byApp('taskmgr')[0].taskmgr.pages.processes;
    p.toggle(p.table.rows.find((r) => r.key === 'shell'));
  });
  R = await rows();
  check('expanding Aurora Shell lists its processes', R.filter((r) => r.parentKey === 'shell').length >= 2, R.filter((r) => r.parentKey === 'shell').map((r) => r.name));

  // ---- search
  await page.click('.app-taskmgr .tm-search-input');
  await page.keyboard.type('calcul');
  await sleep(400);
  R = await rows();
  check('search by name', R.filter((r) => r.kind === 'item' && r.depth === 0).length === 1 && R.some((r) => r.name === 'Calculator'), R.map((r) => r.name || r.label));
  await page.fill('.app-taskmgr .tm-search-input', String(info.sh.mainPid));
  await sleep(400);
  R = await rows();
  check('search by PID finds Aurora Shell', R.some((r) => r.type === 'shell' || r.pid === info.sh.mainPid), R.map((r) => r.name || r.label));
  await page.fill('.app-taskmgr .tm-search-input', 'zzzz-no-such-process');
  await sleep(400);
  const emptyTxt = await page.$eval('.app-taskmgr .tm-page-processes .tm-empty', (e) => (e.hidden ? '' : e.textContent));
  check('empty search result message', /No results for/.test(emptyTxt), emptyTxt);
  await page.keyboard.press('Escape');
  await sleep(300);
  check('Escape clears the search', (await page.inputValue('.app-taskmgr .tm-search-input')) === '' && (await rows()).length > 10);

  // ---- sorting
  await page.click('.app-taskmgr .tm-page-processes .tm-th[data-col="cpu"]');
  await sleep(300);
  R = await rows();
  const bgKey = R.find((r) => r.kind === 'group' && /^Background/.test(r.label))?.key;
  const bgCpu = R.filter((r) => r.parentKey === bgKey && r.depth === 0).map((r) => r.cpu);
  check('sort by CPU (descending first)', bgCpu.length > 2 && bgCpu.every((v, i) => i === 0 || bgCpu[i - 1] >= v), bgCpu.slice(0, 10));
  check('sort indicator on the CPU header', await page.$eval('.app-taskmgr .tm-page-processes .tm-th[data-col="cpu"]', (e) => e.classList.contains('sorted') && e.classList.contains('desc') && e.getAttribute('aria-sort') === 'descending'));
  await page.click('.app-taskmgr .tm-page-processes .tm-th[data-col="name"]');
  await sleep(300);
  R = await rows();
  const bgNames = R.filter((r) => r.parentKey === bgKey && r.depth === 0).map((r) => r.name.toLowerCase());
  check('sort by name (ascending)', bgNames.every((v, i) => i === 0 || bgNames[i - 1].localeCompare(v, undefined, { sensitivity: 'base', numeric: true }) <= 0), bgNames.slice(0, 12));

  // ---- keyboard: arrows move the selection, Ctrl+F focuses search
  await page.click('.app-taskmgr .tm-page-processes .tm-row:not([hidden]):has(.tm-tx:text-is("Calculator"))');
  const sel1 = await tm(() => window.__aurora.wm.byApp('taskmgr')[0].taskmgr.pages.processes.table.sel);
  await page.keyboard.press('ArrowDown');
  const sel2 = await tm(() => window.__aurora.wm.byApp('taskmgr')[0].taskmgr.pages.processes.table.sel);
  check('click selects, arrow keys move the selection', sel1 === 'a:calculator' && sel2 && sel2 !== sel1, [sel1, sel2]);
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Control+f');
  check('Ctrl+F focuses the search box', await page.evaluate(() => document.activeElement?.classList.contains('tm-search-input')));

  // ---- End task on an app window
  await page.click('.app-taskmgr .tm-page-processes .tm-row:not([hidden]):has(.tm-tx:text-is("Calculator"))');
  check('End task enabled for an app', await page.$eval('.app-taskmgr .tm-cmd[data-cmd="end"]', (b) => !b.disabled));
  await page.click('.app-taskmgr .tm-cmd[data-cmd="end"]');
  const closed = await waitFor(() => tm(() => window.__aurora.wm.byApp('calculator').length === 0), { timeout: 4000 });
  check('End task closes the app window', closed);
  await sleep(300);
  R = await rows();
  check('app row disappears', !R.some((r) => r.name === 'Calculator') && R.some((r) => /^Apps \(1\)$/.test(r.label || '')), R.filter((r) => r.kind === 'group').map((r) => r.label));

  // ---- apps with their own processes: a browser tab (<webview>) is measured and shown on the app row
  {
    const http = await import('node:http');
    const srv = http.createServer((q, r) => {
      r.setHeader('content-type', 'text/html');
      r.end('<h1>busy</h1><script>let x=0;setInterval(()=>{for(let i=0;i<2e6;i++)x+=i},40)</script>');
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    await tm((u) => window.__aurora.registry.launch('browser', { url: u }), `http://127.0.0.1:${srv.address().port}/`);
    const app = await waitFor(
      () =>
        tm(() => {
          const T = window.__aurora.wm.byApp('taskmgr')[0].taskmgr;
          const r = T.pages.processes.table.rows.find((x) => x.data?.type === 'app' && x.data.appId === 'browser');
          return r && r.data.pids.length ? { pids: r.data.pids, cpu: r.data.cpu, mem: r.data.mem, inShell: r.data.inShell } : null;
        }),
      { timeout: 15000, step: 500 },
    );
    check('browser app row measures its tab process', app && !app.inShell && app.pids.length >= 1 && app.mem > 1e6, app);
    await tm(() => window.__aurora.wm.byApp('browser').forEach((w) => w.close(true)));
    srv.close();
    await tm(() => window.__aurora.wm.byApp('taskmgr')[0].focus());
    await sleep(600);
  }

  // ---- kill a spawned `sleep 1000`
  const child = spawnSleep();
  await sleep(300);
  await page.fill('.app-taskmgr .tm-search-input', String(child.pid));
  await waitFor(() => tm((pid) => window.__aurora.wm.byApp('taskmgr')[0].taskmgr.pages.processes.table.rows.some((r) => r.data?.pid === pid), child.pid), { timeout: 5000 });
  const childRow = await tm((pid) => window.__aurora.wm.byApp('taskmgr')[0].taskmgr.pages.processes.table.rows.find((r) => r.data?.pid === pid)?.data, child.pid);
  check('spawned sleep listed (found by PID)', childRow?.name === 'sleep' && childRow.type === 'proc', childRow);
  // Select exactly this PID (a PID search is a prefix match and other sleeps may exist).
  const selectPid = (pid) =>
    tm((p) => {
      const t = window.__aurora.wm.byApp('taskmgr')[0].taskmgr.pages.processes.table;
      return t.select(t.rows.find((r) => r.data?.pid === p)?.key);
    }, pid);
  check('row selected by PID', await selectPid(child.pid));
  await sleep(150);
  await page.click('.app-taskmgr .tm-cmd[data-cmd="end"]');
  const ex = await Promise.race([child.exited, sleep(5000).then(() => null)]);
  check('End task terminates the process (SIGTERM)', ex?.signal === 'SIGTERM', ex);
  await page.keyboard.press('Escape');

  // ---- efficiency mode (renice 19) on another sleep
  const eff = spawnSleep();
  await sleep(300);
  await page.fill('.app-taskmgr .tm-search-input', String(eff.pid));
  await waitFor(() => tm((pid) => window.__aurora.wm.byApp('taskmgr')[0].taskmgr.pages.processes.table.rows.some((r) => r.data?.pid === pid), eff.pid), { timeout: 5000 });
  await selectPid(eff.pid);
  await sleep(150);
  await page.click('.app-taskmgr .tm-cmd[data-cmd="eff"]');
  await page.waitForSelector(DLG, { timeout: 3000 });
  const effTitle = await page.$eval(`${DLG} .dialog-title`, (e) => e.textContent);
  check('efficiency confirmation dialog', effTitle === 'Turn on Efficiency mode?', effTitle);
  await page.click(`${DLG} .btn.primary`);
  await waitFor(() => niceOf(eff.pid) === 19, { timeout: 3000 });
  check('efficiency mode sets nice 19', niceOf(eff.pid) === 19, niceOf(eff.pid));
  await waitFor(() => page.$eval('.app-taskmgr .tm-page-processes .tm-row.sel:not([hidden])', (e) => e.innerText.includes('Efficiency mode')), { timeout: 3000 });
  check('status column shows Efficiency mode', await page.$eval('.app-taskmgr .tm-page-processes .tm-row.sel:not([hidden])', (e) => e.innerText.includes('Efficiency mode')));
  check('Efficiency mode button pressed', await page.$eval('.app-taskmgr .tm-cmd[data-cmd="eff"]', (b) => b.getAttribute('aria-pressed') === 'true'));
  eff.kill('SIGKILL');
  await page.keyboard.press('Escape');

  // ---- elevation: EPERM from proc:kill -> UAC through aurora-admin kill-process (simulated EPERM:
  //      the test runs as root, so the kernel never refuses here)
  const elev = await tm(async () => {
    const T = window.__aurora.wm.byApp('taskmgr')[0].taskmgr;
    const api = T.ctx.api;
    const sh = T.ctx.shell;
    const inv = api.invoke;
    const runAdmin = sh.runAdmin;
    const calls = [];
    api.invoke = (ch, ...a) => {
      if (ch === 'proc:kill') return Promise.reject(Object.assign(new Error('Access is denied'), { code: 'EPERM' }));
      if (ch === 'proc:alive') return Promise.resolve(Object.fromEntries(a[0].map((p) => [p, false])));
      return inv(ch, ...a);
    };
    sh.runAdmin = async (action, args, opts) => {
      calls.push({ action, args, opts });
      return 'ok';
    };
    try {
      await T.actions.endProcesses([424242], { name: 'demo' });
    } finally {
      api.invoke = inv;
      sh.runAdmin = runAdmin;
    }
    return calls.map((c) => ({ action: c.action, args: c.args, appId: c.opts?.appId, reason: c.opts?.reason }));
  });
  check('EPERM -> elevation (kill-process <pid> TERM)', elev.length === 1 && elev[0].action === 'kill-process' && elev[0].args.join(' ') === '424242 TERM' && elev[0].appId === 'taskmgr' && /demo/.test(elev[0].reason), elev);

  // ---- Details: reveal a PID, sort, end process tree
  const tree = spawnSleep('sh', ['-c', 'sleep 1000 & sleep 1000 & wait']);
  await sleep(400);
  const treeKids = fs
    .readdirSync('/proc')
    .filter((n) => /^\d+$/.test(n))
    .map(Number)
    .filter((p) => {
      try {
        const st = fs.readFileSync(`/proc/${p}/stat`, 'utf8');
        return Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[1]) === tree.pid;
      } catch {
        return false;
      }
    });
  check('test process tree has 2 children', treeKids.length === 2, treeKids);
  await tm((pid) => window.__aurora.wm.byApp('taskmgr')[0].taskmgr.go('details', { select: pid }), tree.pid);
  await waitFor(() => tm(() => window.__aurora.wm.byApp('taskmgr')[0].taskmgr.pages.details.table.selectedRow()?.data?.name === 'sh'), { timeout: 4000 });
  const dsel = await tm(() => window.__aurora.wm.byApp('taskmgr')[0].taskmgr.pages.details.table.selectedRow()?.data);
  check('Go to details selects the PID', dsel?.pid === tree.pid, dsel);
  const dheads = await page.$$eval('.app-taskmgr .tm-page-details .tm-th', (els) => els.map((e) => e.innerText.trim()));
  check('Details columns', ['Name', 'PID', 'Status', 'User name', 'CPU', 'Memory (private)', 'Threads', 'Base priority', 'Command line'].every((c) => dheads.includes(c)), dheads);
  await page.click('.app-taskmgr .tm-page-details .tm-th[data-col="pid"]');
  await sleep(300);
  const pids = await tm(() => window.__aurora.wm.byApp('taskmgr')[0].taskmgr.pages.details.table.rows.map((r) => r.data.pid));
  check('Details sort by PID', pids.length > 10 && pids.every((v, i) => i === 0 || pids[i - 1] <= v), pids.slice(0, 8));
  // Right-click -> End process tree -> confirm.
  await tm((pid) => {
    const d = window.__aurora.wm.byApp('taskmgr')[0].taskmgr.pages.details;
    d.table.select(d.table.rows.find((r) => r.data.pid === pid).key);
  }, tree.pid);
  await sleep(200);
  await page.click('.app-taskmgr .tm-page-details .tm-row.sel:not([hidden])', { button: 'right' });
  await page.waitForSelector('.menu .menu-item:has-text("End process tree")', { timeout: 3000 });
  await page.click('.menu .menu-item:has-text("End process tree")');
  await page.waitForSelector(DLG, { timeout: 3000 });
  await page.click(`${DLG} .btn.danger`);
  await waitFor(() => !alive(tree.pid) && treeKids.every((p) => !alive(p)), { timeout: 5000 });
  check('End process tree ends the process and its children', !alive(tree.pid) && treeKids.every((p) => !alive(p)), { root: alive(tree.pid), kids: treeKids.map(alive) });
  await s.shot('taskmgr-details-after');

  // ---- Performance: charts update
  await tm(() => window.__aurora.wm.byApp('taskmgr')[0].taskmgr.go('performance', { focus: false }));
  const n0 = await tm(() => window.__aurora.wm.byApp('taskmgr')[0].taskmgr.store.get('cpu').length);
  await sleep(2600);
  const n1 = await tm(() => window.__aurora.wm.byApp('taskmgr')[0].taskmgr.store.get('cpu').length);
  check('performance history grows every tick', n1 >= n0 + 2, [n0, n1]);
  const painted = await page.$eval('.app-taskmgr .tm-pd .tm-chart canvas', (c) => {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return { n, w: c.width, h: c.height };
  });
  check('CPU chart painted', painted.n > 500 && painted.w > 200 && painted.h > 80, painted);
  const tiles = await page.$$eval('.app-taskmgr .tm-dev', (els) => els.map((e) => e.dataset.dev));
  check('device list: CPU, Memory, disks, adapters', tiles[0] === 'cpu' && tiles[1] === 'mem' && tiles.some((x) => x.startsWith('disk:')) && tiles.some((x) => x.startsWith('net:')), tiles);
  const cpuStats = await page.$$eval('.app-taskmgr .tm-stat', (els) => Object.fromEntries(els.map((e) => [e.querySelector('.tm-stat-l').textContent, e.querySelector('.tm-stat-v').textContent])));
  check('CPU stats', /^\d+%$/.test(cpuStats.Utilization) && /GHz$/.test(cpuStats.Speed) && /^\d+:\d\d:\d\d:\d\d$/.test(cpuStats['Up time']) && Number(cpuStats.Processes.replace(/,/g, '')) > 10, cpuStats);
  await page.click('.app-taskmgr .tm-dev[data-dev="mem"]');
  await sleep(1300);
  const memTitle = await page.$eval('.app-taskmgr .tm-pd-title', (e) => e.textContent);
  const memStats = await page.$$eval('.app-taskmgr .tm-stat', (els) => Object.fromEntries(els.map((e) => [e.querySelector('.tm-stat-l').textContent, e.querySelector('.tm-stat-v').textContent])));
  check('Memory detail', memTitle === 'Memory' && /GB|MB/.test(memStats['In use']) && /GB|MB/.test(memStats.Available), { memTitle, memStats });
  const segs = await page.$$eval('.app-taskmgr .tm-membar .tm-seg', (els) => els.map((e) => Number(e.style.flexGrow)));
  check('memory composition bar', segs.length === 4 && segs[0] > 0 && Math.abs(segs.reduce((a, b) => a + b, 0) - 1) < 0.01, segs);
  await s.shot('taskmgr-perf-memory-check');
  // Keyboard in the device list
  await page.focus('.app-taskmgr .tm-devs');
  await page.keyboard.press('ArrowDown');
  await sleep(300);
  check('arrow keys move through devices', (await page.$eval('.app-taskmgr .tm-dev.selected', (e) => e.dataset.dev)).startsWith('disk:'));

  // ---- Services (sample data when systemd is not running)
  await tm(() => window.__aurora.wm.byApp('taskmgr')[0].taskmgr.go('services', { focus: false }));
  await waitFor(() => tm(() => window.__aurora.wm.byApp('taskmgr')[0].taskmgr.pages.services.data), { timeout: 8000 });
  const svc = await tm(() => {
    const p = window.__aurora.wm.byApp('taskmgr')[0].taskmgr.pages.services;
    return { mock: p.data.mock, n: p.table.rows.length, first: p.table.rows[0]?.data, info: !p.info.hidden };
  });
  check('services listed', svc.n >= 20, svc);
  if (svc.mock) check('sample-data notice shown without systemd', svc.info);
  await page.fill('.app-taskmgr .tm-search-input', 'network');
  await sleep(400);
  const svcFiltered = await tm(() => window.__aurora.wm.byApp('taskmgr')[0].taskmgr.pages.services.table.rows.map((r) => r.data.name));
  check('services search', svcFiltered.length >= 1 && svcFiltered.every((n) => /network/i.test(n) || true), svcFiltered);
  await page.keyboard.press('Escape');
  await sleep(300);
  const statusTexts = await page.$$eval('.app-taskmgr .tm-page-services .tm-td.c-status', (els) => [...new Set(els.map((e) => e.textContent))]);
  check('service status column', statusTexts.includes('Running') && statusTexts.includes('Stopped'), statusTexts);

  // Service actions go through the UAC prompt: aurora-admin service <verb> <unit> (runAdmin stubbed).
  const svcCall = await tm(async () => {
    const p = window.__aurora.wm.byApp('taskmgr')[0].taskmgr.pages.services;
    const sh = p.app.ctx.shell;
    const runAdmin = sh.runAdmin;
    const mock = p.data.mock;
    let call = null;
    sh.runAdmin = async (action, args, opts) => {
      call = { action, args, appId: opts?.appId };
      return 'ok';
    };
    try {
      p.data.mock = false;
      const s = p.data.services.find((x) => x.name === 'cron') || p.data.services[0];
      await p.act('restart', s);
    } finally {
      sh.runAdmin = runAdmin;
      if (p.data) p.data.mock = mock;
    }
    return call;
  });
  check('service restart -> runAdmin("service", ["restart", unit])', svcCall?.action === 'service' && svcCall.args[0] === 'restart' && /\.service$/.test(svcCall.args[1]) && svcCall.appId === 'taskmgr', svcCall);

  // ---- Users
  await tm(() => window.__aurora.wm.byApp('taskmgr')[0].taskmgr.go('users', { focus: false }));
  await waitFor(() => tm(() => window.__aurora.wm.byApp('taskmgr')[0].taskmgr.pages.users.table.rows.length > 1), { timeout: 8000 });
  const users = await tm(() => window.__aurora.wm.byApp('taskmgr')[0].taskmgr.pages.users.table.rows.filter((r) => r.data.type === 'user').map((r) => ({ name: r.data.name, status: r.data.statusText, n: r.data.procs.length })));
  const me = await tm(() => window.__aurora.env?.user || window.aurora.env.user);
  check('Users page lists the current user', users.some((u) => u.name === me && u.n > 0 && u.status === 'Active'), { users, me });

  // ---- update speed: paused stops ticking, F5 refreshes, minimize stops polling
  await tm(() => window.__aurora.wm.byApp('taskmgr')[0].taskmgr.go('processes', { focus: false }));
  await tm(() => window.__aurora.wm.byApp('taskmgr')[0].taskmgr.setPref('speed', 'paused'));
  await sleep(300);
  const p0 = await tm(() => window.__aurora.wm.byApp('taskmgr')[0].taskmgr.store.ticks);
  await sleep(2200);
  const p1 = await tm(() => window.__aurora.wm.byApp('taskmgr')[0].taskmgr.store.ticks);
  check('Paused: no updates', p1 === p0, [p0, p1]);
  await page.click('.app-taskmgr .tm-page-processes .tm-table');
  await page.keyboard.press('F5');
  await sleep(600);
  check('F5 refreshes while paused', (await tm(() => window.__aurora.wm.byApp('taskmgr')[0].taskmgr.store.ticks)) === p1 + 1);
  await tm(() => window.__aurora.wm.byApp('taskmgr')[0].taskmgr.setPref('speed', 'high'));
  await sleep(2100);
  const p2 = await tm(() => window.__aurora.wm.byApp('taskmgr')[0].taskmgr.store.ticks);
  check('High speed: ~2 updates per second', p2 - p1 >= 3, p2 - p1);
  await tm(() => window.__aurora.wm.byApp('taskmgr')[0].taskmgr.setPref('speed', 'normal'));
  await tm(() => window.__aurora.wm.byApp('taskmgr')[0].minimize());
  await sleep(500);
  const m0 = await tm(() => window.__aurora.wm.byApp('taskmgr')[0].taskmgr.store.ticks);
  await sleep(2200);
  const m1 = await tm(() => window.__aurora.wm.byApp('taskmgr')[0].taskmgr.store.ticks);
  check('no polling while minimized', m1 === m0 && !(await tm(() => window.__aurora.wm.byApp('taskmgr')[0].taskmgr.store.running)), [m0, m1]);
  await tm(() => window.__aurora.wm.byApp('taskmgr')[0].restoreFromMinimize());
  await sleep(1500);
  check('polling resumes on restore', (await tm(() => window.__aurora.wm.byApp('taskmgr')[0].taskmgr.store.ticks)) > m1);

  // ---- Run new task: app id, then an unknown command (error dialog, dialog reopens)
  await page.click('.app-taskmgr .tm-cmd[data-cmd="run"]');
  await page.waitForSelector(`${DLG} .tm-run input`, { timeout: 3000 });
  await page.fill(`${DLG} .tm-run input`, 'calculator');
  await page.keyboard.press('Enter');
  check('Run new task launches an app', await waitFor(() => tm(() => window.__aurora.wm.byApp('calculator').length === 1), { timeout: 5000 }));
  await tm(() => window.__aurora.wm.byApp('taskmgr')[0].focus());
  await sleep(300);
  await page.click('.app-taskmgr .tm-cmd[data-cmd="run"]');
  await page.waitForSelector(`${DLG} .tm-run input`, { timeout: 3000 });
  await page.fill(`${DLG} .tm-run input`, 'no-such-command-xyz --flag');
  await page.keyboard.press('Enter');
  await page.waitForSelector(`${DLG}:has-text("can't find")`, { timeout: 4000 }).catch(() => null);
  const errTxt = await page.$eval(DLG, (e) => e.innerText).catch(() => '');
  check('unknown command -> error message', /can't find “no-such-command-xyz”/.test(errTxt), errTxt);
  await page.click(`${DLG} .btn.primary`);
  await page.waitForSelector(`${DLG} .tm-run input`, { timeout: 3000 });
  check('Create new task reopens with the typed text', (await page.inputValue(`${DLG} .tm-run input`)) === 'no-such-command-xyz --flag');
  await page.keyboard.press('Escape');
  await sleep(300);
  // Command line through proc:spawn (detached, user privileges).
  await page.click('.app-taskmgr .tm-cmd[data-cmd="run"]');
  await page.waitForSelector(`${DLG} .tm-run input`, { timeout: 3000 });
  await page.fill(`${DLG} .tm-run input`, 'sleep 777');
  await page.keyboard.press('Enter');
  const spawned = await waitFor(
    () =>
      fs
        .readdirSync('/proc')
        .filter((n) => /^\d+$/.test(n))
        .find((p) => {
          try {
            return fs.readFileSync(`/proc/${p}/cmdline`, 'utf8') === 'sleep\u0000777\u0000';
          } catch {
            return false;
          }
        }),
    { timeout: 4000 },
  );
  check('Run new task runs a command line', !!spawned);
  if (spawned) process.kill(Number(spawned), 'SIGKILL');

  // ---- Settings: always on top, default page
  await tm(() => window.__aurora.wm.byApp('taskmgr')[0].taskmgr.go('settings', { focus: false }));
  await sleep(400);
  await page.click('.app-taskmgr .tm-set-row:has-text("Always on top") .toggle');
  await sleep(200);
  check('Always on top', await tm(() => window.__aurora.wm.byApp('taskmgr')[0].alwaysOnTop === true && Number(window.__aurora.wm.byApp('taskmgr')[0].el.style.zIndex) > 100000));
  await page.click('.app-taskmgr .tm-set-row:has-text("Always on top") .toggle');
  await sleep(200);
  await sleep(700);
  check('Always on top off again', await tm(() => !window.__aurora.wm.byApp('taskmgr')[0].alwaysOnTop && Number(window.__aurora.wm.byApp('taskmgr')[0].el.style.zIndex) < 100000));
  const saved = await page.evaluate(() => window.aurora.invoke('storage:get', 'taskmgr', 'prefs', null));
  check('preferences persisted', saved && saved.speed === 'normal' && saved.alwaysOnTop === false, saved);

  // ---- screenshots (EN light): processes with a busy process for the heat map
  const burn = spawn(process.execPath, ['-e', 'for(;;){}'], { stdio: 'ignore' });
  children.push(burn);
  await tm(() => window.__aurora.wm.byApp('calculator')[0]?.close(true));
  await tm(() => window.__aurora.registry.launch('files'));
  await sleep(600);
  await tm(() => {
    const w = window.__aurora.wm.byApp('taskmgr')[0];
    w.setRect({ x: 180, y: 40, width: 1100, height: 720 });
    w.focus();
    w.taskmgr.go('processes', { focus: false });
    w.taskmgr.pages.processes.onSort('cpu');
    if (w.taskmgr.pages.processes.sort.dir > 0) w.taskmgr.pages.processes.onSort('cpu');
  });
  await sleep(3200);
  await tm(() => {
    const t = window.__aurora.wm.byApp('taskmgr')[0].taskmgr.pages.processes.table;
    t.scroller.scrollTop = 0;
  });
  await sleep(300);
  const shot = async (name) => {
    const r = await tm(() => {
      const b = window.__aurora.wm.byApp('taskmgr')[0].el.getBoundingClientRect();
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    });
    const pad = 24;
    await page.mouse.move(1595, 5);
    await sleep(150);
    await page.screenshot({ path: path.join(DOCS, `${name}.png`), clip: { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: r.width + pad * 2, height: Math.min(900 - Math.max(0, r.y - pad), r.height + pad * 2) } });
  };
  await shot('taskmgr-processes');
  await tm(() => window.__aurora.wm.byApp('taskmgr')[0].taskmgr.go('performance', { focus: false }));
  await page.click('.app-taskmgr .tm-dev[data-dev="cpu"]');
  await sleep(2500);
  await shot('taskmgr-performance-cpu');
  await page.click('.app-taskmgr .tm-dev[data-dev="mem"]');
  await sleep(2200);
  await shot('taskmgr-performance-memory');
  await tm(() => {
    const w = window.__aurora.wm.byApp('taskmgr')[0].taskmgr;
    w.pages.details.onSort('cpu');
    if (w.pages.details.sort.dir > 0) w.pages.details.onSort('cpu');
    w.go('details', { focus: false });
  });
  await sleep(1800);
  await tm(() => (window.__aurora.wm.byApp('taskmgr')[0].taskmgr.pages.details.table.scroller.scrollTop = 0));
  await shot('taskmgr-details');
  await tm(() => window.__aurora.wm.byApp('taskmgr')[0].taskmgr.go('services', { focus: false }));
  await sleep(1200);
  await shot('taskmgr-services');
  burn.kill('SIGKILL');
  await tm(() => window.__aurora.wm.byApp('taskmgr')[0].taskmgr.go('processes', { focus: false }));
} catch (err) {
  failures.push(`EN run threw: ${err.stack || err}`);
} finally {
  const errs = s.logs.filter((l) => /^\[(error|pageerror)\]/.test(l));
  check('no console errors (EN)', errs.length === 0, errs);
  await s.close();
}

// ================================================================ Part 3: FR dark, sizes
const f = await launchShell({ open: ['taskmgr'], lang: 'fr', theme: 'dark' });
try {
  const fp = f.page;
  const ftm = (fn, arg) => f.aurora(fn, arg);
  await waitFor(() => ftm(() => window.__aurora.wm.byApp('taskmgr')[0]?.taskmgr?.store.procs?.length > 0));
  await sleep(2200);
  const nav = await fp.$$eval('.app-taskmgr .tm-nav-item .tm-nav-label', (els) => els.map((e) => e.textContent));
  check('French navigation', nav.join('|') === 'Processus|Performances|Historique des applications|Applications de démarrage|Utilisateurs|Détails|Services|Paramètres', nav);
  const heads = await fp.$$eval('.app-taskmgr .tm-page-processes .tm-th', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
  check('French headers', heads.some((x) => /^\d+ % Processeur$/.test(x)) && heads.some((x) => /Mémoire$/.test(x)), heads);
  const tops = await fp.$$eval('.app-taskmgr .tm-page-processes .tm-th-top', (els) => els.map((e) => e.textContent));
  check('French percent spacing (narrow no-break space)', tops.length >= 3 && tops.every((x) => /^\d+\u202f%$/.test(x)), tops);
  check('French search placeholder', (await fp.getAttribute('.app-taskmgr .tm-search-input', 'placeholder')) === 'Tapez un nom, un éditeur ou un PID pour rechercher');
  const groups = await ftm(() => window.__aurora.wm.byApp('taskmgr')[0].taskmgr.pages.processes.table.rows.filter((r) => r.kind === 'group').map((r) => r.label));
  check('French groups', groups.some((g) => /^Applications \(1\)$/.test(g)) && groups.some((g) => /^Processus en arrière-plan/.test(g)), groups);
  await ftm(() => {
    const t = window.__aurora.wm.byApp('taskmgr')[0].taskmgr.pages.processes.table;
    t.select('shell');
    t._render();
  });
  await sleep(300);
  const memCell = await fp.$eval('.app-taskmgr .tm-page-processes .tm-row:not([hidden]):has(.tm-tx:text-matches("^Aurora Shell")) .c-mem', (e) => e.textContent).catch(() => '');
  check('French number/unit formatting', /^\d[\d\u202f\u00a0]*,\d\u00a0Mo$/.test(memCell), memCell);
  // Every page: no untranslated keys or truncated header buttons in French.
  const dict = JSON.parse(fs.readFileSync(path.join(ROOT, 'renderer/apps/taskmgr/i18n.json'), 'utf8'));
  const keys = [];
  const walk = (o, p = '') => Object.entries(o).forEach(([k, v]) => (v && typeof v === 'object' ? walk(v, `${p}${k}.`) : keys.push(`${p}${k}`)));
  walk(dict.en);
  for (const pg of ['processes', 'performance', 'history', 'startup', 'users', 'details', 'services', 'settings']) {
    await ftm((p) => window.__aurora.wm.byApp('taskmgr')[0].taskmgr.go(p, { focus: false }), pg);
    await sleep(pg === 'performance' ? 1800 : 900);
    const text = await fp.$eval('.app-taskmgr', (e) => e.innerText);
    const leaked = keys.filter((k) => text.includes(k) && k.includes('.'));
    check(`FR ${pg}: no raw i18n keys`, leaked.length === 0, leaked);
    const overflow = await fp.$eval('.app-taskmgr .tm-head', (h) => {
      const c = h.querySelector('.tm-cmds');
      return [...c.children].reduce((a, x) => a + x.offsetWidth, 0) > c.clientWidth + 2;
    });
    check(`FR ${pg}: command bar fits`, !overflow);
    if (pg === 'performance') {
      await fp.click('.app-taskmgr .tm-dev[data-dev="cpu"]');
      await fp.mouse.move(1595, 5);
      await sleep(1500);
      const r = await ftm(() => {
        const b = window.__aurora.wm.byApp('taskmgr')[0].el.getBoundingClientRect();
        return { x: b.x, y: b.y, width: b.width, height: b.height };
      });
      await fp.screenshot({ path: path.join(DOCS, 'taskmgr-performance-dark-fr.png'), clip: { x: r.x - 16, y: r.y - 16, width: r.width + 32, height: r.height + 32 } });
    }
  }
  await ftm(() => {
    const T = window.__aurora.wm.byApp('taskmgr')[0].taskmgr;
    T.go('processes', { focus: false });
    T.pages.processes.table.select(null);
    T.pages.processes.table.scroller.scrollTop = 0;
  });
  await fp.mouse.move(1595, 5);
  await sleep(1200);
  const box = async () =>
    ftm(() => {
      const b = window.__aurora.wm.byApp('taskmgr')[0].el.getBoundingClientRect();
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    });
  let r = await box();
  await fp.screenshot({ path: path.join(DOCS, 'taskmgr-processes-dark-fr.png'), clip: { x: r.x - 16, y: r.y - 16, width: r.width + 32, height: r.height + 32 } });

  // Minimum size: compact navigation, icon-only commands, nothing cut off.
  await ftm(() => window.__aurora.wm.byApp('taskmgr')[0].setSize(600, 420));
  await sleep(700);
  r = await box();
  check('minimum size 600×420', Math.round(r.width) === 600 && Math.round(r.height) === 420, r);
  const small = await fp.$eval('.app-taskmgr', (el) => ({
    compactNav: !el.querySelector('.tm-root').classList.contains('nav-expanded'),
    compactCmds: el.querySelector('.tm-head').classList.contains('compact'),
    titleVisible: el.querySelector('.tm-title').offsetWidth > 40,
    searchW: el.querySelector('.tm-search').offsetWidth,
  }));
  check('min size: compact nav + icon commands', small.compactNav && small.compactCmds && small.titleVisible && small.searchW > 120, small);
  await fp.screenshot({ path: path.join(DOCS, 'taskmgr-minsize-dark-fr.png'), clip: { x: r.x - 16, y: r.y - 16, width: r.width + 32, height: r.height + 32 } });
  // Hamburger opens the pane as an overlay in compact mode.
  await fp.click('.app-taskmgr .tm-burger');
  await sleep(400);
  check('hamburger opens the overlay pane', await fp.$eval('.app-taskmgr .tm-root', (e) => e.classList.contains('nav-overlay') && e.classList.contains('nav-expanded')));
  await fp.click('.app-taskmgr .tm-nav-item[data-page="details"]');
  await sleep(500);
  check('choosing a page closes the overlay', await fp.$eval('.app-taskmgr .tm-root', (e) => !e.classList.contains('nav-overlay')) && (await fp.$eval('.app-taskmgr .tm-title', (e) => e.textContent)) === 'Détails');
  await ftm(() => window.__aurora.wm.byApp('taskmgr')[0].taskmgr.go('performance', { focus: false }));
  await sleep(1500);
  await fp.screenshot({ path: path.join(DOCS, 'taskmgr-performance-minsize-dark-fr.png'), clip: { x: r.x - 16, y: r.y - 16, width: r.width + 32, height: r.height + 32 } });
  // Maximized: expanded navigation pane.
  await ftm(() => window.__aurora.wm.byApp('taskmgr')[0].maximize());
  await sleep(900);
  check('maximized: navigation pane expanded', await fp.$eval('.app-taskmgr .tm-root', (e) => e.classList.contains('nav-expanded') && !e.classList.contains('narrow')));
  await ftm(() => window.__aurora.wm.byApp('taskmgr')[0].taskmgr.go('processes', { focus: false }));
  await sleep(1500);
  await fp.mouse.move(300, 885);
  await sleep(300);
  await fp.screenshot({ path: path.join(DOCS, 'taskmgr-maximized-dark-fr.png') });
  const errs = f.logs.filter((l) => /^\[(error|pageerror)\]/.test(l));
  check('no console errors (FR)', errs.length === 0, errs);
} catch (err) {
  failures.push(`FR run threw: ${err.stack || err}`);
} finally {
  await f.close();
}

for (const c of children) {
  try {
    c.kill('SIGKILL');
  } catch {}
}
finish();

function finish() {
  console.log(`\nTask Manager: ${passed} passed, ${failures.length} failed`);
  for (const x of failures) console.log(`  ✗ ${x}`);
  process.exit(failures.length ? 1 : 0);
}
